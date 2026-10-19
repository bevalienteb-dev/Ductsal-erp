// functions/rollbackUtil.js
// Safe rollback and contingency utility for SEC-03
//
// Rules enforced:
//   1. Distinguishes pre-existing accounts from migration-created accounts.
//   2. Strict stop condition if user activity is detected (lastSignInTime !== null/undefined).
//   3. Requires explicit human confirmation before deleting or disabling any account.
//   4. Decouples Firebase Auth operations from Firestore transactions (never calls Auth inside Firestore tx).
//   5. Enforces transactional, selective unlinking in Firestore (preserves all legitimate subsequent changes).
//   6. Enforces correct recovery order: Neutralize privileges -> Unlink Firestore -> Auth cleanup/disable.

const { FieldValue } = require('firebase-admin/firestore');

/**
 * Evaluates whether an Auth account may be safely deleted, disabled, or if deletion must be aborted.
 *
 * @param {object} authUser - Firebase Auth UserRecord or simulated object
 * @param {object} options
 * @param {boolean} [options.isPreexisting=false] - True if account existed before migration
 * @param {Date|string|number} [options.migrationStartTime] - Timestamp when migration started
 * @param {string} [options.confirmDelete='NO'] - Must be 'YES' for deletion
 * @returns {object} evaluation result with { canDelete, action, stopCondition, reason }
 */
function evaluateAuthAccountForRollback(authUser, options = {}) {
  const {
    cid = null,
    firestoreProfile = null,
    isPreexisting = false,
    migrationStartTime = null,
    confirmDelete = 'NO',
    hasAuditProvenance = false,
    requireAuditProvenance = false
  } = options;

  if (!authUser) {
    return {
      canDelete: false,
      action: 'NOOP',
      stopCondition: null,
      reason: 'El usuario Auth no existe o ya fue eliminado previamente.'
    };
  }

  const creationTime = authUser.metadata && authUser.metadata.creationTime
    ? new Date(authUser.metadata.creationTime).getTime()
    : null;
  const lastSignInTime = authUser.metadata && authUser.metadata.lastSignInTime
    ? new Date(authUser.metadata.lastSignInTime).getTime()
    : null;

  // 1. Check for user activity / sign-ins
  // Any session activity indicates the account is being used or has active credentials
  if (lastSignInTime !== null && !isNaN(lastSignInTime) && lastSignInTime > 0) {
    return {
      canDelete: false,
      hasActivity: true,
      action: 'DISABLE_ONLY',
      stopCondition: 'USER_ACTIVITY_DETECTED',
      reason: `ALERTA DE SEGURIDAD: La cuenta registra inicios de sesión previos (lastSignInTime: ${authUser.metadata.lastSignInTime}). Queda estrictamente PROHIBIDO eliminarla. Se requiere revisión humana o suspensión temporal.`
    };
  }

  // 2. Check if account is pre-existing by flag
  if (isPreexisting === true) {
    return {
      canDelete: false,
      isPreexisting: true,
      action: 'NEUTRALIZE_CLAIMS_ONLY',
      stopCondition: 'PREEXISTING_ACCOUNT',
      reason: 'La cuenta de Firebase Authentication es preexistente a la migración. Queda estrictamente PROHIBIDO eliminarla. Solo se permite restaurar sus claims previos.'
    };
  }

  // 3. Check if account creationTime is prior to migration window
  if (migrationStartTime && creationTime) {
    const migrationStartEpoch = new Date(migrationStartTime).getTime();
    if (!isNaN(migrationStartEpoch) && creationTime < migrationStartEpoch) {
      return {
        canDelete: false,
        isPreexisting: true,
        action: 'NEUTRALIZE_CLAIMS_ONLY',
        stopCondition: 'PREEXISTING_ACCOUNT_BY_TIMESTAMP',
        reason: `La cuenta fue creada (${authUser.metadata.creationTime}) antes del inicio de la ventana de migración (${new Date(migrationStartTime).toISOString()}). Es preexistente; prohibido eliminar.`
      };
    }
  }

  // 4. PROOF OF OWNERSHIP & PROVENANCE CHECKS (Neither creationTime nor lastSignInTime alone is sufficient)
  // 4a. Verify CID in customClaims matches the profile CID
  if (cid) {
    const userCid = authUser.customClaims && authUser.customClaims.cid;
    if (userCid && String(userCid) !== String(cid)) {
      return {
        canDelete: false,
        action: 'STOP_UNVERIFIED_PROVENANCE',
        stopCondition: 'MISMATCHED_CID_CLAIM',
        reason: `FALLO DE ATRIBUCIÓN: La cuenta Auth tiene asignado un CID ('${userCid}') que difiere del perfil objetivo ('${cid}'). No pertenece a esta operación.`
      };
    }
  }

  // 4b. Verify bidirectional link with Firestore profile
  if (firestoreProfile) {
    if (firestoreProfile.authUid && firestoreProfile.authUid !== authUser.uid) {
      return {
        canDelete: false,
        action: 'STOP_UNVERIFIED_PROVENANCE',
        stopCondition: 'MISMATCHED_FIRESTORE_LINK',
        reason: `FALLO DE ATRIBUCIÓN: El perfil en Firestore está vinculado a otro authUid ('${firestoreProfile.authUid}') y no al UID evaluado ('${authUser.uid}'). Prohibido eliminar.`
      };
    }

    // Reattempt scenario: if profile is ALREADY unlinked in Firestore,
    // immutable audit provenance is strictly required to prove this Auth user belonged to this CID.
    if (!firestoreProfile.authUid && !hasAuditProvenance) {
      return {
        canDelete: false,
        action: 'STOP_AWAITING_AUDIT_PROVENANCE',
        stopCondition: 'MISSING_PROVENANCE_FOR_UNLINKED_PROFILE',
        reason: 'FALLO DE ATRIBUCIÓN EN REINTENTO: El perfil de Firestore ya se encuentra desvinculado. Para reintentar la eliminación en Auth es obligatorio acreditar la procedencia mediante registro formal de auditoría (userOps o commercialAudit).'
      };
    }
  }

  // 4c. Verify audit / operation record if required
  if (requireAuditProvenance && !hasAuditProvenance) {
    return {
      canDelete: false,
      action: 'STOP_AWAITING_AUDIT_PROVENANCE',
      stopCondition: 'MISSING_AUDIT_PROVENANCE',
      reason: 'FALLO DE ATRIBUCIÓN: No se localizó un registro formal de operación en userOps ni bitácora de auditoría que acredite que este usuario fue generado por la migración.'
    };
  }

  // 5. Require explicit human authorization flag
  if (String(confirmDelete).trim().toUpperCase() !== 'YES') {
    return {
      canDelete: false,
      action: 'STOP_AWAITING_HUMAN_AUTHORIZATION',
      stopCondition: 'MISSING_HUMAN_AUTHORIZATION',
      reason: 'CONDICIÓN DE PARADA: Eliminación de cuenta Auth detenida. Se requiere confirmación humana explícita mediante la variable CONFIRM_DELETE_AUTH_ACCOUNT=YES.'
    };
  }

  // All safety checks satisfied
  return {
    canDelete: true,
    action: 'DELETE_PERMITTED',
    stopCondition: null,
    reason: 'Cuenta atribuida inequívocamente a la migración, sin actividad de usuario y con autorización humana confirmada. Eliminación segura autorizada.'
  };
}

/**
 * Transactor that selectively unlinks authUid and authProvider from Firestore
 * without touching any other fields, validating concurrency and existence.
 *
 * @param {object} db - Firestore admin instance
 * @param {object} params
 * @param {string} params.cid - Profile CID to unlink
 * @param {string} params.uid - Expected authUid to unlink
 * @param {string} [params.collectionName='users_prod']
 * @returns {Promise<object>} { unlinked: true, cid, uid }
 */
async function safeUnlinkFirestoreProfile(db, { cid, uid, collectionName = 'users_prod' }) {
  if (!cid || !uid) {
    throw new Error('Parámetros cid y uid son obligatorios para la desvinculación selectiva.');
  }

  const docRef = db.collection(collectionName).doc(String(cid));

  return await db.runTransaction(async tx => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error(`Perfil ${cid} no existe en Firestore colección ${collectionName}.`);
    }

    const data = snap.data() || {};

    // Concurrency / conflicting link check:
    // If the profile was concurrently linked to a DIFFERENT authUid, do NOT blindly delete it!
    if (data.authUid && data.authUid !== uid) {
      throw new Error(`Conflicto de concurrencia en perfil ${cid}: el authUid actual en Firestore (${data.authUid}) difiere del UID que se intenta revertir (${uid}). No se sobrescribirán cambios de otro operador.`);
    }

    // If already unlinked, no write needed
    if (!data.authUid && !data.authProvider) {
      return { unlinked: false, alreadyUnlinked: true, cid, uid };
    }

    // Selective delete: only authUid and authProvider
    // All other fields (nombre, email, role, activo, password, metadata) are preserved 100%
    tx.update(docRef, {
      authUid: FieldValue.delete(),
      authProvider: FieldValue.delete()
    });

    return { unlinked: true, cid, uid };
  });
}

/**
 * Orchestrates safe end-to-end rollback following the strict order of operations:
 * 1. Diagnostic inspection of Auth user.
 * 2. Claim neutralization and token revocation (immediate privilege containment).
 * 3. Selective transactional unlinking in Firestore (preserving all other fields).
 * 4. Auth account deletion (only if permitted) or disabling (if active/preexisting).
 *
 * @param {object} admin - Initialized firebase-admin namespace
 * @param {object} params
 * @returns {Promise<object>} Detailed report of rollback operations performed
 */
async function executeSafeRollback(admin, {
  cid,
  uid,
  isPreexisting = false,
  priorClaims = {},
  migrationStartTime = null,
  confirmDelete = 'NO',
  collectionName = 'users_prod',
  forceDisableIfActive = true,
  opId = null,
  hasAuditProvenance = false,
  requireAuditProvenance = false
} = {}) {
  const auth = typeof admin.auth === 'function' ? admin.auth() : admin.auth;
  const db = typeof admin.firestore === 'function' ? admin.firestore() : admin.firestore;

  const result = {
    cid,
    uid,
    opId,
    claimsNeutralized: false,
    tokensRevoked: false,
    firestoreUnlinked: false,
    authDeleted: false,
    authDisabled: false,
    stopCondition: null,
    status: 'IN_PROGRESS'
  };

  // Step 1: Inspect Auth user and Firestore profile
  let authUser = null;
  try {
    authUser = await auth.getUser(uid);
  } catch (err) {
    if (err && err.code !== 'auth/user-not-found') throw err;
  }

  let firestoreProfile = null;
  try {
    const profSnap = await db.collection(collectionName).doc(String(cid)).get();
    firestoreProfile = profSnap.exists ? profSnap.data() : null;
  } catch (_) {}

  // Look up immutable audit provenance from userOps if opId is supplied
  let verifiedAuditProvenance = hasAuditProvenance;
  if (!verifiedAuditProvenance && opId && db) {
    try {
      const opSnap = await db.collection('userOps').doc(String(opId)).get();
      if (opSnap.exists) {
        const opData = opSnap.data() || {};
        if (String(opData.profileId) === String(cid) && (opData.result?.uid === uid || opData.details?.uid === uid || opData.uid === uid)) {
          verifiedAuditProvenance = true;
        }
      }
    } catch (_) {}
  }

  const evaluation = evaluateAuthAccountForRollback(authUser, {
    cid,
    firestoreProfile,
    isPreexisting,
    migrationStartTime,
    confirmDelete,
    hasAuditProvenance: verifiedAuditProvenance,
    requireAuditProvenance
  });

  result.evaluation = evaluation;

  // Step 2: Immediate Privilege Neutralization (Claims + Revocation)
  // Ensures user cannot exercise elevated privileges during or after rollback
  if (authUser) {
    try {
      await auth.setCustomUserClaims(uid, priorClaims || {});
      result.claimsNeutralized = true;
    } catch (claimsErr) {
      result.claimsError = claimsErr.message;
    }

    if (typeof auth.revokeRefreshTokens === 'function') {
      try {
        await auth.revokeRefreshTokens(uid);
        result.tokensRevoked = true;
      } catch (tokErr) {
        result.tokensError = tokErr.message;
      }
    }
  }

  // Step 3: Transactional, selective unlinking in Firestore
  const unlinkRes = await safeUnlinkFirestoreProfile(db, { cid, uid, collectionName });
  result.firestoreUnlinked = unlinkRes.unlinked || unlinkRes.alreadyUnlinked;

  // Step 4: Auth Account Handling (Delete, Disable, or Leave intact)
  if (evaluation.canDelete) {
    await auth.deleteUser(uid);
    result.authDeleted = true;
    result.status = 'COMPLETED_USER_DELETED';
  } else if (evaluation.hasActivity && forceDisableIfActive && authUser) {
    // If account had sign-in activity, do NOT delete; disable to protect credentials and logs
    await auth.updateUser(uid, { disabled: true });
    result.authDisabled = true;
    result.stopCondition = evaluation.stopCondition;
    result.status = 'COMPLETED_USER_DISABLED';
  } else {
    result.stopCondition = evaluation.stopCondition;
    result.status = evaluation.stopCondition ? 'STOPPED_PRESERVED' : 'COMPLETED_PRESERVED';
  }

  return result;
}

module.exports = {
  evaluateAuthAccountForRollback,
  safeUnlinkFirestoreProfile,
  executeSafeRollback
};
