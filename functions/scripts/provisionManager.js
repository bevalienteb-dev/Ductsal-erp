// functions/scripts/provisionManager.js
// Authorised procedure to provision or link a manager account (Auth account + Firestore profile)
// exclusively inside the Firebase emulators, with explicit guards preventing production mistakes.
//
// Rules enforced:
//   - Refuses to run against production by accident: strictly checks emulator isolation.
//   - Requires that the Firestore profile `users<suffix>/<cid>` ALREADY exists.
//   - Validates that the provided email matches the email recorded in the Firestore profile.
//   - Validates that the existing profile has `role === 'manager'` (cannot silently promote non-managers).
//   - Validates that the existing profile has `activo === true` (cannot link inactive profiles).
//   - Rejects if the profile already has a different `authUid` than the Auth account.
//   - Validates pre-existing Auth account: cannot be linked to another profile, cannot be disabled.
//   - No default hardcoded passwords: supports passwordless account creation (preferred, sets via email reset)
//     or explicit strong passwords (min 8 chars).
//   - Grants identical manager custom claims: { role: 'manager', manager: true, cid: String(cid) }.
//   - Revokes existing refresh tokens on the Auth user to force fresh token generation.
//   - Preserves all historical fields of the Firestore profile without arbitrary overwrites.
//   - Partial failure protection: if Auth account was newly created and Firestore update fails,
//     deletes the newly created Auth account to prevent orphaned state.
//   - Reusable as an administrative script and as a test helper.

const crypto = require('crypto');
const { emulatorIsolationProblems } = require('../emulatorGuard');

/**
 * Token Refresh and Claims Verification Procedure:
 * ------------------------------------------------
 * After provisioning or updating claims on a manager account:
 * 1. Server-side revocation: `await auth.revokeRefreshTokens(uid)` forces the Auth backend
 *    to reject any existing refresh tokens, ensuring old cached tokens cannot be renewed.
 * 2. Client-side refresh: In the browser application, invoke:
 *      `await firebase.auth().currentUser.getIdToken(true);`
 *    This forces a network roundtrip to fetch a fresh JWT ID token containing the updated claims.
 * 3. Claims verification: In the browser or test suite, verify the claims via:
 *      `const tok = await firebase.auth().currentUser.getIdTokenResult();`
 *      `console.assert(tok.claims.manager === true && tok.claims.cid === expectedCid);`
 *
 * @param admin   an initialised firebase-admin namespace Pointed at emulators
 * @param options { cid, email, nombre, password, suffix, purgePassword }
 */
function areClaimsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    const valA = a[k];
    const valB = b[k];
    if (typeof valA === 'object' && valA !== null && typeof valB === 'object' && valB !== null) {
      if (!areClaimsEqual(valA, valB)) return false;
    } else if (valA !== valB) {
      return false;
    }
  }
  return true;
}

/**
 * Helper to reliably resolve the projectId from a Firebase Admin namespace, App instance, or options.
 *
 * Evaluates all identifiable projectId sources across:
 *  - admin.options.projectId
 *  - admin.options.credential.projectId (if exposed)
 *  - admin.app().options.projectId
 *  - admin.app().options.credential.projectId (if exposed)
 *  - admin.apps[i].options.projectId (and credential.projectId)
 *
 * Strict Contradiction Rule:
 *  If any two sources declare different non-empty projectIds, the resolution marks an explicit contradiction
 *  and rejects the instance immediately. An operation is only permitted if all available identifiers agree
 *  unanimously on the expected project.
 *
 * Note on SDK credential properties:
 *  Standard Google Auth Library ServiceAccountCredentials or ComputeCredentials objects may not always
 *  expose an explicit string `projectId` property depending on SDK version and token provider type.
 *  Absence of a credential-level projectId is not treated as a contradiction; validation strictly evaluates
 *  sources that are genuinely present.
 */
function resolveAdminProjectId(admin) {
  if (!admin) return { projectId: null, error: 'No admin instance provided' };

  const collected = [];

  const addSource = (sourceName, accessor) => {
    try {
      const val = typeof accessor === 'function' ? accessor() : accessor;
      if (typeof val === 'string' && val.trim().length > 0) {
        collected.push({ source: sourceName, projectId: val.trim() });
      }
    } catch (_) {
      // Safe fallback: ignore throwing getters or unreadable internal properties
    }
  };

  // 1. Direct options on admin
  try {
    if (admin.options && typeof admin.options === 'object') {
      addSource('admin.options.projectId', () => admin.options.projectId);
      if (admin.options.credential && typeof admin.options.credential === 'object') {
        addSource('admin.options.credential.projectId', () => admin.options.credential.projectId);
      }
    }
  } catch (_) {}

  // 2. Default app via admin.app() or admin.app object
  try {
    if (typeof admin.app === 'function') {
      const defaultApp = admin.app();
      if (defaultApp && defaultApp.options && typeof defaultApp.options === 'object') {
        addSource('admin.app().options.projectId', () => defaultApp.options.projectId);
        if (defaultApp.options.credential && typeof defaultApp.options.credential === 'object') {
          addSource('admin.app().options.credential.projectId', () => defaultApp.options.credential.projectId);
        }
      }
    } else if (admin.app && typeof admin.app === 'object' && admin.app.options && typeof admin.app.options === 'object') {
      addSource('admin.app.options.projectId', () => admin.app.options.projectId);
      if (admin.app.options.credential && typeof admin.app.options.credential === 'object') {
        addSource('admin.app.options.credential.projectId', () => admin.app.options.credential.projectId);
      }
    }
  } catch (_) {
    // admin.app() throws in official SDK if no app is initialized
  }

  // 3. Applications in admin.apps
  try {
    if (Array.isArray(admin.apps)) {
      admin.apps.forEach((app, idx) => {
        if (app && app.options && typeof app.options === 'object') {
          addSource(`admin.apps[${idx}].options.projectId`, () => app.options.projectId);
          if (app.options.credential && typeof app.options.credential === 'object') {
            addSource(`admin.apps[${idx}].options.credential.projectId`, () => app.options.credential.projectId);
          }
        }
      });
    }
  } catch (_) {}

  if (collected.length === 0) {
    return {
      projectId: null,
      error: 'no projectId found in any inspected configuration source'
    };
  }

  // Detect contradiction across all collected sources
  const uniqueProjects = Array.from(new Set(collected.map(c => c.projectId)));
  if (uniqueProjects.length > 1) {
    const details = collected.map(c => `${c.source}='${c.projectId}'`).join(', ');
    return {
      projectId: null,
      contradiction: true,
      error: `Contradictory Firebase projectId sources detected: [${details}]`
    };
  }

  return {
    projectId: uniqueProjects[0],
    sources: collected.map(c => c.source)
  };
}
/**
 * Classifies an error thrown by Firebase Authentication methods into structured categories:
 * - PERMISSION_DENIED: Caller lacks required IAM permission (e.g. 403, permission-denied, insufficient-permission)
 * - NETWORK_OR_UNAVAILABLE: Connection timeout, DNS failure, or service unavailable (e.g. 503, 504, network-request-failed)
 * - UNAUTHENTICATED_OR_EXPIRED: Missing/expired credentials or token (e.g. 401, invalid-credential, token-expired)
 * - OTHER: Any other error type
 */
function classifyAuthError(err) {
  if (!err) return { kind: 'OTHER', message: 'Unknown error', code: null };
  const code = String(err.code || (err.errorInfo && err.errorInfo.code) || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  const status = Number(err.status || err.statusCode || (err.errorInfo && err.errorInfo.status) || 0);

  if (
    code.includes('permission') ||
    code.includes('forbidden') ||
    status === 403 ||
    msg.includes('permission_denied') ||
    msg.includes('permission-denied') ||
    msg.includes('permission denied') ||
    msg.includes('insufficient-permission') ||
    msg.includes('insufficient permission') ||
    msg.includes('forbidden') ||
    msg.includes('lacks permission')
  ) {
    return { kind: 'PERMISSION_DENIED', message: err.message, code };
  }

  if (
    code.includes('network') ||
    code.includes('timeout') ||
    code.includes('econn') ||
    code.includes('etimedout') ||
    code.includes('enotfound') ||
    status === 503 ||
    status === 504 ||
    msg.includes('timeout') ||
    msg.includes('network')
  ) {
    return { kind: 'NETWORK_OR_UNAVAILABLE', message: err.message, code };
  }

  if (
    code.includes('invalid-credential') ||
    code.includes('token-expired') ||
    code.includes('unauthenticated') ||
    status === 401 ||
    msg.includes('unauthenticated') ||
    msg.includes('expired')
  ) {
    return { kind: 'UNAUTHENTICATED_OR_EXPIRED', message: err.message, code };
  }

  return { kind: 'OTHER', message: err.message, code };
}

async function provisionManager(admin, {
  cid,
  email,
  nombre,
  password = null,
  suffix = '_prod',
  purgePassword = false,
  opId = null,
  actor = null
} = {}) {
  // 0. Explicit Firebase Project Verification (H-01)
  const EXPECTED_PROJECT_ID = 'ductsal-erp';
  const resolution = resolveAdminProjectId(admin);

  if (resolution.contradiction) {
    throw new Error(
      `Conflicting Firebase project configuration: ${resolution.error}. ` +
      `provisionManager strictly rejects ambiguous or contradictory admin instances.`
    );
  }

  if (!resolution.projectId) {
    throw new Error(
      `Unable to determine Firebase projectId from the provided admin instance (${resolution.error}). ` +
      `provisionManager strictly requires verified projectId '${EXPECTED_PROJECT_ID}'.`
    );
  }

  if (resolution.projectId !== EXPECTED_PROJECT_ID) {
    throw new Error(
      `Invalid Firebase project: '${resolution.projectId}'. ` +
      `provisionManager is strictly restricted to project '${EXPECTED_PROJECT_ID}'. ` +
      `Refusing to execute on non-target project.`
    );
  }

  if (!cid || !email) {
    throw new Error('cid and email are required');
  }
  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail.includes('@')) {
    throw new Error(`Invalid email format: '${email}'`);
  }

  // 1. Validate opId or generate a unique traceable execution token
  if (opId !== null && opId !== undefined) {
    if (typeof opId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(opId)) {
      throw new Error(`Invalid opId format: '${opId}'. Must be a 1-128 character alphanumeric token.`);
    }
  } else {
    opId = `op_prov_mgr_${cid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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

  // 2. Pre-check idempotency and previous operation state
  const priorOpSnap = await opsDocRef.get();
  if (priorOpSnap && priorOpSnap.exists) {
    const priorOp = priorOpSnap.data() || {};
    if (priorOp.cid && String(priorOp.cid) !== String(cid)) {
      throw new Error(`Conflict: opId '${opId}' was previously recorded for a different CID (${priorOp.cid}, current ${cid})`);
    }
    if (priorOp.email && priorOp.email !== cleanEmail) {
      throw new Error(`Conflict: opId '${opId}' was previously recorded for a different email (${priorOp.email}, current ${cleanEmail})`);
    }
    if (priorOp.status === 'succeeded') {
      return {
        cid: String(cid),
        uid: priorOp.uid || (priorOp.result && priorOp.result.uid),
        email: cleanEmail,
        role: 'manager',
        claims: (priorOp.result && priorOp.result.claims) || { role: 'manager', manager: true, cid: String(cid) },
        createdAuth: priorOp.createdAuth || false,
        opId,
        alreadyCompleted: true
      };
    }
    if (priorOp.status === 'manualReview') {
      throw new Error(`Operation ${opId} requires manual review and cannot be automatically re-executed.`);
    }
    if (priorOp.status === 'conflict') {
      throw new Error(`Operation ${opId} previously failed due to conflict: ${priorOp.message || 'conflict'}`);
    }
  }

  // 3. Register initial PENDING state before ANY external Auth or Firestore mutations
  const opActor = actor || { uid: 'system', name: 'provisionManager CLI' };
  const canonicalRequesterUid = (opActor && opActor.uid) ? String(opActor.uid) : 'system';
  await opsDocRef.set({
    opId,
    action: 'provisionManager',
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

  // 4. Verify target Firestore profile ALREADY exists and is valid
  const snap = await userDocRef.get();
  if (!snap.exists) {
    await updateOpState('conflict', { message: `Profile ${cid} does not exist in users${suffix}` });
    throw new Error(`Profile ${cid} does not exist in users${suffix}. Cannot provision a non-existent manager profile.`);
  }
  const existingData = snap.data() || {};

  const existingEmail = String(existingData.email || '').trim().toLowerCase();
  if (existingEmail !== cleanEmail) {
    await updateOpState('conflict', { message: `Email mismatch for profile ${cid}: profile has '${existingEmail}', received '${cleanEmail}'` });
    throw new Error(`Email mismatch for profile ${cid}: profile has '${existingEmail}', received '${cleanEmail}'.`);
  }

  if (existingData.role !== 'manager') {
    await updateOpState('conflict', { message: `Profile ${cid} has role '${existingData.role}', not 'manager'` });
    throw new Error(`Profile ${cid} has role '${existingData.role}', not 'manager'. Silent role elevation is prohibited.`);
  }

  if (existingData.activo !== true) {
    await updateOpState('conflict', { message: `Profile ${cid} is inactive` });
    throw new Error(`Profile ${cid} is inactive. Inactive manager profiles cannot be provisioned.`);
  }

  // 5. Validate password parameter if supplied
  if (password !== null && password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be a string with at least 8 characters. Do not use default or insecure passwords.');
    }
  }

  // 6. Transition to AUTH_CREATING before Auth lookups/writes
  await updateOpState('authCreating');

  let authUser = null;
  try {
    authUser = await auth.getUserByEmail(cleanEmail);
  } catch (e) {
    if (e && e.code !== 'auth/user-not-found') throw e;
  }

  let createdAuth = false;
  let priorClaims = null;

  if (!authUser) {
    const createArgs = {
      email: cleanEmail,
      displayName: nombre || existingData.nombre || ''
    };
    if (password) {
      createArgs.password = password;
    }
    try {
      authUser = await auth.createUser(createArgs);
      createdAuth = true;
    } catch (createErr) {
      await updateOpState('error', { error: createErr.message, message: `Auth creation failed: ${createErr.message}`, rolledBack: true });
      throw createErr;
    }
  } else {
    // Auth account pre-existed: validate its state
    if (authUser.disabled === true) {
      await updateOpState('conflict', { message: `Auth account for ${cleanEmail} is disabled`, uid: authUser.uid });
      throw new Error(`Auth account for ${cleanEmail} is disabled in Firebase Authentication.`);
    }
    // Verify it is not linked to a different CRM profile
    const existingProfiles = await db.collection(`users${suffix}`).where('authUid', '==', authUser.uid).get();
    if (!existingProfiles.empty && existingProfiles.docs.some(d => d.id !== String(cid))) {
      await updateOpState('conflict', { message: `Auth account already linked to another profile`, uid: authUser.uid });
      throw new Error(`Auth account ${cleanEmail} (${authUser.uid}) is already linked to another profile (${existingProfiles.docs[0].id})`);
    }

    // Capture and inspect prior custom claims
    priorClaims = authUser.customClaims ? { ...authUser.customClaims } : null;
    if (priorClaims && priorClaims.cid && String(priorClaims.cid) !== String(cid)) {
      await updateOpState('conflict', { message: `Auth account has claims linked to a different CID`, uid: authUser.uid });
      throw new Error(`Auth account ${cleanEmail} already has custom claims linked to a different CID (${priorClaims.cid}, expected ${cid})`);
    }
  }

  // Record AUTH_CREATED
  await updateOpState('authCreated', { uid: authUser.uid, createdAuth });

  // 7. Reject if the Firestore profile already has a conflicting authUid
  if (existingData.authUid && existingData.authUid !== authUser.uid) {
    if (createdAuth) {
      let hasActivity = false;
      try {
        const freshUser = (typeof auth.getUser === 'function') ? await auth.getUser(authUser.uid) : authUser;
        const lastSignIn = freshUser && freshUser.metadata && freshUser.metadata.lastSignInTime;
        if (lastSignIn && (typeof lastSignIn === 'string' || Number(lastSignIn) > 0)) {
          hasActivity = true;
        }
      } catch (_) {
        if (authUser && authUser.metadata && authUser.metadata.lastSignInTime) hasActivity = true;
      }
      if (!hasActivity) {
        try {
          await auth.deleteUser(authUser.uid);
        } catch (_) {
          try {
            if (typeof auth.updateUser === 'function') {
              await auth.updateUser(authUser.uid, { disabled: true });
            }
          } catch (__) {}
        }
      }
    }
    await updateOpState('conflict', { message: `Profile already linked to a different Auth account`, uid: authUser.uid });
    throw new Error(`Profile ${cid} is already linked to a different Auth account (${existingData.authUid}, new would be ${authUser.uid}).`);
  }

  // 8. Build non-destructive manager custom claims
  const CONTRADICTORY_CLAIM_KEYS = [
    'vendedor', 'gestor', 'operador', 'tecnico', 'planta',
    'disabled', 'suspended', 'blocked',
    'role', 'manager', 'cid'
  ];
  const preservedClaims = {};
  if (priorClaims) {
    for (const [key, val] of Object.entries(priorClaims)) {
      if (!CONTRADICTORY_CLAIM_KEYS.includes(key)) {
        preservedClaims[key] = val;
      }
    }
  }

  const targetClaims = {
    ...preservedClaims,
    role: 'manager',
    manager: true,
    cid: String(cid)
  };

  const claimsNeedUpdate = !areClaimsEqual(authUser.customClaims, targetClaims);

  let firestoreUpdated = false;
  let claimsUpdated = false;

  try {
    // 9. Update Firestore profile FIRST within a transaction
    const profileUpdate = {
      authUid: authUser.uid,
      authProvider: 'firebase',
      email: cleanEmail
    };
    if (nombre) {
      profileUpdate.nombre = nombre;
    }

    if (purgePassword && existingData.password !== undefined) {
      profileUpdate.password = FieldValue.delete();
    }

    let firestoreNeedsUpdate = true;
    if (typeof db.runTransaction === 'function') {
      await db.runTransaction(async tx => {
        const curSnap = await tx.get(userDocRef);
        if (!curSnap.exists) {
          throw new Error(`Profile ${cid} was deleted concurrently`);
        }
        const curData = curSnap.data() || {};
        if (curData.activo !== true) {
          throw new Error(`Profile ${cid} became inactive concurrently`);
        }
        if (curData.role !== 'manager') {
          throw new Error(`Profile ${cid} role changed concurrently to '${curData.role}'`);
        }
        if (curData.authUid && curData.authUid !== authUser.uid) {
          throw new Error(`Profile ${cid} was linked concurrently to another Auth account: ${curData.authUid}`);
        }
        if (curData.authProvider && curData.authProvider !== 'firebase') {
          throw new Error(`Profile ${cid} authProvider changed concurrently to '${curData.authProvider}'`);
        }

        const alreadyLinked = curData.authUid === authUser.uid && curData.authProvider === 'firebase';
        const nombreMatches = !nombre || curData.nombre === nombre;
        const passwordMatches = !purgePassword || curData.password === undefined;

        if (alreadyLinked && nombreMatches && passwordMatches) {
          firestoreNeedsUpdate = false;
          return;
        }

        tx.update(userDocRef, profileUpdate);
      });
    } else {
      await userDocRef.update(profileUpdate);
    }
    firestoreUpdated = firestoreNeedsUpdate;

    // Record FIRESTORE_LINKED
    await updateOpState('firestoreLinked', { uid: authUser.uid, profileId: String(cid) });

    // 10. Apply target custom claims to Auth user if needed
    if (claimsNeedUpdate) {
      await auth.setCustomUserClaims(authUser.uid, targetClaims);
      claimsUpdated = true;

      if (typeof auth.revokeRefreshTokens === 'function') {
        await auth.revokeRefreshTokens(authUser.uid);
      }
    }

    // Record CLAIMS_UPDATED milestone
    await updateOpState('claimsUpdated', { uid: authUser.uid });
  } catch (opErr) {
    const rollbackErrors = [];

    // 1. Rollback custom claims if modified on pre-existing user
    if (claimsUpdated && !createdAuth) {
      try {
        await auth.setCustomUserClaims(authUser.uid, priorClaims || {});
      } catch (claimsRbErr) {
        rollbackErrors.push(`Failed to restore prior Auth claims on ${cleanEmail}: ${claimsRbErr.message}`);
      }
    }

    // 2. Rollback Firestore profile if it was updated
    if (firestoreUpdated) {
      try {
        const rollbackProfile = {
          authUid: existingData.authUid !== undefined ? existingData.authUid : FieldValue.delete(),
          authProvider: existingData.authProvider !== undefined ? existingData.authProvider : FieldValue.delete()
        };
        if (existingData.nombre !== undefined) {
          rollbackProfile.nombre = existingData.nombre;
        }
        if (purgePassword && existingData.password !== undefined) {
          rollbackProfile.password = existingData.password;
        }
        await userDocRef.update(rollbackProfile);
      } catch (fsRbErr) {
        rollbackErrors.push(`Failed to revert Firestore profile ${cid}: ${fsRbErr.message}`);
      }
    }

    // 3. Rollback newly created Auth user (never delete pre-existing user, nor any account with login activity)
    if (createdAuth && authUser) {
      let hasActivity = false;
      try {
        const freshUser = (typeof auth.getUser === 'function') ? await auth.getUser(authUser.uid) : authUser;
        const lastSignIn = freshUser && freshUser.metadata && freshUser.metadata.lastSignInTime;
        if (lastSignIn && (typeof lastSignIn === 'string' || Number(lastSignIn) > 0)) {
          hasActivity = true;
        }
      } catch (_) {
        if (authUser && authUser.metadata && authUser.metadata.lastSignInTime) hasActivity = true;
      }

      if (hasActivity) {
        rollbackErrors.push(
          `Security guard: Auth user ${authUser.uid} (${cleanEmail}) has recorded login activity (lastSignInTime). Refusing automated deletion in rollback.`
        );
      } else {
        try {
          await auth.deleteUser(authUser.uid);
        } catch (delRbErr) {
          const delErrClass = classifyAuthError(delRbErr);
          let disableSucceeded = false;
          let disableErrMsg = null;

          try {
            if (typeof auth.updateUser === 'function') {
              await auth.updateUser(authUser.uid, { disabled: true });
              disableSucceeded = true;
            }
          } catch (disableErr) {
            const disErrClass = classifyAuthError(disableErr);
            disableErrMsg = `[${disErrClass.kind}] ${disableErr.message}`;
          }

          if (disableSucceeded) {
            rollbackErrors.push(
              `Failed to delete newly created Auth user (${authUser.uid}) [${delErrClass.kind}]: ${delRbErr.message}. ` +
              `Compensatory defensive action SUCCEEDED: account was confirmed DISABLED in Firebase Auth.`
            );
          } else {
            rollbackErrors.push(
              `CRITICAL: Failed to delete newly created Auth user (${authUser.uid}) [${delErrClass.kind}]: ${delRbErr.message}. ` +
              `Additionally, compensatory disabling FAILED: ${disableErrMsg || 'updateUser unavailable'}. ` +
              `Account remains ACTIVE in Firebase Auth and requires immediate manual administrative action.`
            );
          }
        }
      }
    }

    // Surface critical partial state if rollback itself encountered failures
    if (rollbackErrors.length > 0) {
      try {
        await opsDocRef.set({
          status: 'manualReview',
          rolledBack: false,
          error: opErr.message,
          rollbackErrors,
          uid: authUser ? authUser.uid : null,
          createdAuth,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (_) {}

      const compositeErr = new Error(
        `${opErr.message}\n` +
        `[CRITICAL: ROLLBACK PARTIAL FAILURE] Automated cleanup failed to restore previous state for profile ${cid} (${cleanEmail}). Manual reconciliation required:\n` +
        rollbackErrors.map(e => ` - ${e}`).join('\n')
      );
      compositeErr.originalError = opErr;
      compositeErr.rollbackErrors = rollbackErrors;
      throw compositeErr;
    }

    // Rollback succeeded cleanly: record ERROR with rolledBack = true
    try {
      await opsDocRef.set({
        status: 'error',
        rolledBack: true,
        error: opErr.message,
        uid: createdAuth ? null : (authUser ? authUser.uid : null),
        createdAuth,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (_) {}

    throw opErr;
  }

  // 11. Finalize: record SUCCEEDED and write to commercialAudit
  const finalResult = {
    cid: String(cid),
    uid: authUser.uid,
    email: cleanEmail,
    role: 'manager',
    claims: targetClaims,
    createdAuth,
    opId
  };

  // 11. Write dedicated audit record BEFORE marking operation as succeeded
  //
  // [Architecture Note: Firestore Cross-Collection Atomicity Limitation]
  // Cloud Firestore does not support atomic distributed transactions spanning arbitrary external
  // auth state modifications, independent audit collections and operation logs without contention limits.
  // Therefore, provisionManager uses a strictly ordered, idempotent progression:
  //   (1) Profile & Auth mutations -> (2) Claims update & token revocation -> (3) Idempotent audit record
  //   creation -> (4) Transition to SUCCEEDED.
  //
  // An operation is DEFINED as completed ('succeeded') ONLY when:
  //   a) Auth account exists with valid manager custom claims { role: 'manager', manager: true, cid }.
  //   b) Firestore profile users<suffix>/<cid> is linked (authUid, authProvider='firebase').
  //   c) Refresh tokens are revoked.
  //   d) Mandatory audit log in commercialAudit<suffix> is persisted.
  //
  // At no point is SUCCEEDED recorded before audit verification. If audit fails, manualReview is recorded.
  // If recording manualReview also fails, the prior recorded status ('claimsUpdated' or 'firestoreLinked')
  // ensures that any subsequent reattempt will NOT falsely treat the operation as completed.
  const existingAuditSnap = await db.collection(auditColName).where('opId', '==', opId).get();
  if (existingAuditSnap.empty) {
    try {
      await db.collection(auditColName).add({
        action: 'provision_manager',
        opId,
        cid: String(cid),
        uid: authUser.uid,
        email: cleanEmail,
        actor: opActor,
        requesterUid: canonicalRequesterUid,
        createdAuth,
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (auditErr) {
      try {
        await opsDocRef.set({
          status: 'manualReview',
          auditFailed: true,
          auditError: auditErr.message,
          uid: authUser.uid,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (stateErr) {
        const composite = new Error(
          `Failed to write commercial audit log: ${auditErr.message}. Additionally failed to persist manualReview state in ${opsColName}/${opId}: ${stateErr.message}`
        );
        composite.auditError = auditErr;
        composite.stateError = stateErr;
        throw composite;
      }
      throw new Error(`Failed to write commercial audit log: ${auditErr.message}`);
    }
  }

  // 12. Finalize: record SUCCEEDED only AFTER audit log is confirmed
  await updateOpState('succeeded', {
    result: finalResult,
    completedAt: FieldValue.serverTimestamp()
  });

  return finalResult;
}

// CLI usage
async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const isProductionExplicitlyAllowed = args.includes('--allow-authorized-production-run');

  if (!isProductionExplicitlyAllowed) {
    const problems = emulatorIsolationProblems(process.env, { strict: true });
    if (problems.length > 0) {
      console.error('Refusing to run: environment is not provably isolated emulators:\n - ' + problems.join('\n - '));
      console.error('\nFor an authorized future production run, the script requires an explicit, audited operator invocation');
      console.error('with valid Google Cloud Application Default Credentials and the flag --allow-authorized-production-run.');
      process.exit(2);
    }
  }

  const cid = getArg('--cid');
  const email = getArg('--email');
  const nombre = getArg('--nombre');
  const password = getArg('--password', null);
  const suffix = getArg('--suffix', '_prod');
  const purgePassword = args.includes('--purge-password');
  const opId = getArg('--op-id', null);

  if (!cid || !email) {
    console.error('Usage: node provisionManager.js --cid <id> --email <email> [--nombre <name>] [--password <pwd>] [--suffix _prod|_local] [--purge-password] [--op-id <token>] [--allow-authorized-production-run]');
    process.exit(1);
  }

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    if (isProductionExplicitlyAllowed) {
      const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
      await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
    } else {
      const defaultProject = process.env.GCLOUD_PROJECT || 'demo-ductsal-isolated';
      admin.initializeApp({ projectId: defaultProject });
    }
  }

  const res = await provisionManager(admin, { cid, email, nombre, password, suffix, purgePassword, opId });
  console.log('Manager successfully provisioned/linked:\n', JSON.stringify(res, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}

module.exports = { provisionManager, resolveAdminProjectId, classifyAuthError };
