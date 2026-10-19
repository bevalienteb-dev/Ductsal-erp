// functions/scripts/provisionCommercialUser.js
// Authorised procedure to provision or link commercial accounts (gestor, vendedor)
// against Firebase Authentication and Firestore users_prod, following the proven
// pattern of provisionManager.js and linkHistoricalUserAdmin.
//
// Rules enforced:
//   - Strictly enforces target project 'ductsal-erp' via resolveAdminProjectId.
//   - Requires that the Firestore profile `users<suffix>/<cid>` ALREADY exists and is activo === true.
//   - Strictly restricts to commercial roles: 'gestor' or 'vendedor' (rejects 'manager').
//   - Assigns custom claims { role: <role>, cid: String(cid) }, guaranteeing NO manager privileges.
//   - Idempotent and traceable via `userOps/{opId}`.
//   - Records formal audit entries in `commercialAudit<suffix>`.
//   - Rollback protection: deletes newly created Auth user if subsequent Firestore update fails.
//   - Never leaks or handles plaintext passwords.
//   - Validates that the password reset mechanism is operational for each account.

const crypto = require('crypto');
const { resolveAdminProjectId, classifyAuthError } = require('./provisionManager');
const { initializeImpersonatedAdminApp, sanitizeErrorMessage } = require('./googleAuthAdminAdapter');

const EXPECTED_PROJECT_ID = 'ductsal-erp';
const ALLOWED_COMMERCIAL_ROLES = ['gestor', 'vendedor'];

async function provisionCommercialUser(admin, {
  cid,
  email,
  nombre,
  suffix = '_prod',
  opId = null,
  actor = null
} = {}) {
  // 0. Project verification
  const resolution = resolveAdminProjectId(admin);
  if (resolution.contradiction || resolution.projectId !== EXPECTED_PROJECT_ID) {
    throw new Error(`Project verification failed: ${JSON.stringify(resolution)}. Expected '${EXPECTED_PROJECT_ID}'.`);
  }

  if (!cid || !email) {
    throw new Error('cid and email are required');
  }
  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail.includes('@')) {
    throw new Error(`Invalid email format: '${email}'`);
  }

  // 1. Traceable opId
  if (opId !== null && opId !== undefined) {
    if (typeof opId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(opId)) {
      throw new Error(`Invalid opId format: '${opId}'. Must be 1-128 chars alphanumeric/dashes.`);
    }
  } else {
    opId = `op_prov_comm_${cid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  const auth = typeof admin.auth === 'function' ? admin.auth() : admin.auth;
  const db = typeof admin.firestore === 'function' ? admin.firestore() : admin.firestore;
  const FieldValue = (admin.firestore && admin.firestore.FieldValue)
    ? admin.firestore.FieldValue
    : require('firebase-admin/firestore').FieldValue;

  const opsColName = suffix === '_prod' ? 'userOps' : `userOps${suffix}`;
  const opsDocRef = db.collection(opsColName).doc(opId);
  const auditColName = `commercialAudit${suffix}`;
  const userDocRef = db.collection(`users${suffix}`).doc(String(cid));

  // 2. Pre-check idempotency
  const priorOpSnap = await opsDocRef.get();
  if (priorOpSnap && priorOpSnap.exists) {
    const priorOp = priorOpSnap.data() || {};
    if (priorOp.cid && String(priorOp.cid) !== String(cid)) {
      throw new Error(`Conflict: opId '${opId}' was recorded for CID ${priorOp.cid}, current ${cid}`);
    }
    if (priorOp.email && priorOp.email !== cleanEmail) {
      throw new Error(`Conflict: opId '${opId}' was recorded for email ${priorOp.email}, current ${cleanEmail}`);
    }
    if (priorOp.status === 'succeeded') {
      return {
        cid: String(cid),
        uid: priorOp.uid || (priorOp.result && priorOp.result.uid),
        email: cleanEmail,
        role: priorOp.role || (priorOp.result && priorOp.result.role),
        claims: (priorOp.result && priorOp.result.claims) || {},
        createdAuth: priorOp.createdAuth || false,
        opId,
        alreadyCompleted: true
      };
    }
    if (priorOp.status === 'manualReview') {
      throw new Error(`Operation ${opId} requires manual review and cannot be re-executed.`);
    }
    if (priorOp.status === 'conflict') {
      throw new Error(`Operation ${opId} previously failed due to conflict: ${priorOp.message || 'conflict'}`);
    }
  }

  // 3. Register initial PENDING state
  const opActor = actor || { uid: 'system', name: 'provisionCommercialUser CLI' };
  const canonicalRequesterUid = (opActor && opActor.uid) ? String(opActor.uid) : 'system';
  await opsDocRef.set({
    opId,
    action: 'provisionCommercialUser',
    status: 'pending',
    cid: String(cid),
    profileId: String(cid),
    email: cleanEmail,
    actor: opActor,
    requesterUid: canonicalRequesterUid,
    startedAt: FieldValue.serverTimestamp(),
    timestamp: FieldValue.serverTimestamp()
  }, { merge: true });

  const updateOpState = async (status, extra = {}) => {
    try {
      await opsDocRef.set({
        status,
        ...extra,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (stateErr) {
      throw new Error(`Failed to update operation state to '${status}' in ${opsColName}/${opId}: ${stateErr.message}`);
    }
  };

  // 4. Verify Firestore profile
  const snap = await userDocRef.get();
  if (!snap.exists) {
    await updateOpState('conflict', { message: `Profile ${cid} does not exist in users${suffix}` });
    throw new Error(`Profile ${cid} does not exist in users${suffix}.`);
  }
  const existingData = snap.data() || {};

  const existingEmail = String(existingData.email || '').trim().toLowerCase();
  if (existingEmail !== cleanEmail) {
    await updateOpState('conflict', { message: `Email mismatch: profile has '${existingEmail}', received '${cleanEmail}'` });
    throw new Error(`Email mismatch for profile ${cid}: profile has '${existingEmail}', received '${cleanEmail}'.`);
  }

  if (!ALLOWED_COMMERCIAL_ROLES.includes(existingData.role)) {
    await updateOpState('conflict', { message: `Profile ${cid} has non-commercial role '${existingData.role}'` });
    throw new Error(`Profile ${cid} has role '${existingData.role}'. Allowed commercial roles: ${ALLOWED_COMMERCIAL_ROLES.join(', ')}.`);
  }

  if (existingData.activo !== true) {
    await updateOpState('conflict', { message: `Profile ${cid} is inactive` });
    throw new Error(`Profile ${cid} is inactive. Cannot provision inactive profile.`);
  }

  const targetRole = existingData.role;
  const targetClaims = { role: targetRole, cid: String(cid) };

  // 5. Check Auth User
  let authUser = null;
  let createdAuth = false;

  await updateOpState('authCreating');

  try {
    authUser = await auth.getUserByEmail(cleanEmail);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      await updateOpState('error', { error: `Failed to check pre-existing Auth account: ${err.message}` });
      throw err;
    }
  }

  if (authUser) {
    // Account already exists in Auth
    if (existingData.authUid && existingData.authUid !== authUser.uid) {
      await updateOpState('conflict', { message: `Profile ${cid} already linked to different UID ${existingData.authUid} (Auth user has ${authUser.uid})` });
      throw new Error(`Conflict: Profile ${cid} already linked to different UID ${existingData.authUid}.`);
    }

    const otherUsersSnap = await db.collection(`users${suffix}`).where('authUid', '==', authUser.uid).get();
    if (!otherUsersSnap.empty && otherUsersSnap.docs.some(d => d.id !== String(cid))) {
      await updateOpState('conflict', { message: `Auth account ${authUser.uid} already linked to another profile` });
      throw new Error(`Conflict: Auth account ${authUser.uid} already linked to another profile.`);
    }

    if (authUser.disabled) {
      await updateOpState('conflict', { message: `Auth account ${authUser.uid} is disabled` });
      throw new Error(`Auth account for '${cleanEmail}' is disabled.`);
    }
  } else {
    // Create new passwordless Auth account
    try {
      authUser = await auth.createUser({
        email: cleanEmail,
        displayName: nombre || existingData.nombre || ''
      });
      createdAuth = true;
    } catch (createErr) {
      await updateOpState('error', { error: `Failed to create Auth account: ${createErr.message}` });
      throw createErr;
    }
  }

  await updateOpState('authCreated', { uid: authUser.uid, createdAuth });

  // 6. Set custom claims and revoke tokens
  try {
    await auth.setCustomUserClaims(authUser.uid, targetClaims);
    await auth.revokeRefreshTokens(authUser.uid);
  } catch (claimErr) {
    if (createdAuth) {
      try { await auth.deleteUser(authUser.uid); } catch (_) {}
    }
    await updateOpState('error', { error: `Failed to assign claims: ${claimErr.message}` });
    throw claimErr;
  }

  // 7. Update Firestore profile in transaction
  try {
    await db.runTransaction(async tx => {
      const curSnap = await tx.get(userDocRef);
      if (!curSnap.exists) {
        throw new Error(`Profile ${cid} disappeared concurrently.`);
      }
      const curData = curSnap.data() || {};
      if (curData.activo !== true) {
        throw new Error(`Profile ${cid} became inactive concurrently.`);
      }
      if (curData.authUid && curData.authUid !== authUser.uid) {
        throw new Error(`Profile ${cid} concurrently linked to different UID (${curData.authUid}).`);
      }

      tx.update(userDocRef, {
        authUid: authUser.uid,
        authProvider: 'firebase'
      });
    });
  } catch (txErr) {
    if (createdAuth) {
      try { await auth.deleteUser(authUser.uid); } catch (_) {}
    }
    await updateOpState('error', { error: `Firestore transaction failed: ${txErr.message}` });
    throw txErr;
  }

  await updateOpState('firestoreLinked', { uid: authUser.uid });

  // 8. Verify password reset mechanism (without logging token/link)
  let resetLinkReady = false;
  try {
    const link = await auth.generatePasswordResetLink(cleanEmail);
    if (link && link.startsWith('https://')) {
      resetLinkReady = true;
    }
  } catch (linkErr) {
    console.warn(`[Password Reset Check] generatePasswordResetLink warning for ${cleanEmail}: ${linkErr.message}`);
  }

  // 9. Write commercialAudit record
  try {
    await db.collection(auditColName).add({
      action: 'provision_commercial_user',
      opId,
      cid: String(cid),
      uid: authUser.uid,
      email: cleanEmail,
      role: targetRole,
      actor: opActor,
      requesterUid: canonicalRequesterUid,
      createdAuth,
      resetLinkReady,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (auditErr) {
    await updateOpState('manualReview', {
      auditFailed: true,
      auditError: auditErr.message,
      uid: authUser.uid
    });
    throw new Error(`Failed to write commercial audit log: ${auditErr.message}`);
  }

  // 10. Mark succeeded
  const finalResult = {
    cid: String(cid),
    uid: authUser.uid,
    email: cleanEmail,
    role: targetRole,
    claims: targetClaims,
    createdAuth,
    resetLinkReady,
    opId
  };

  await updateOpState('succeeded', {
    result: finalResult,
    completedAt: FieldValue.serverTimestamp()
  });

  return finalResult;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const isProductionExplicitlyAllowed = args.includes('--allow-authorized-production-run');
  if (!isProductionExplicitlyAllowed) {
    console.error('Refusing to run: requires explicit flag --allow-authorized-production-run.');
    process.exit(2);
  }

  const cid = getArg('--cid');
  const email = getArg('--email');
  const nombre = getArg('--nombre');
  const suffix = getArg('--suffix', '_prod');
  const opId = getArg('--op-id', null);

  if (!cid || !email) {
    console.error('Usage: node provisionCommercialUser.js --cid <id> --email <email> [--nombre <name>] [--suffix _prod] [--op-id <token>] --allow-authorized-production-run');
    process.exit(1);
  }

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    await initializeImpersonatedAdminApp(admin, { projectId: EXPECTED_PROJECT_ID });
  }

  const res = await provisionCommercialUser(admin, { cid, email, nombre, suffix, opId });
  console.log('Commercial user successfully provisioned/linked:\n', JSON.stringify(res, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}

module.exports = { provisionCommercialUser };
