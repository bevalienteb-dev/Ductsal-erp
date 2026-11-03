// functions/index.js
// Cloud Functions implementing secure user management for Ductsal CRM.
// This file is added for local development / testing only. No deployment is performed.

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const crypto = require('crypto');
const { emulatorIsolationProblems } = require('./emulatorGuard');
const {
  INVITATION_STATUS,
  buildInitialInvitation
} = require('./invitationService');

/**
 * FieldValue / Timestamp. Found with the real emulators: the Firebase CLI's Functions emulator replaces
 * `admin.firestore` with a bound function that drops its static members, so `admin.firestore.FieldValue`
 * is undefined there and every call failed with INTERNAL. Wherever `admin.firestore.*` exists (the real
 * runtime, unit-test fakes) it is still used; otherwise the modular entry point is used, which exports
 * the very same classes.
 */
function firestoreStatics() {
  const ns = admin.firestore;
  if (ns && ns.FieldValue && ns.Timestamp) return ns;
  return require('firebase-admin/firestore');
}

/**
 * Robust Timestamp creator compatible with both real Firestore SDK and unit-test fakes.
 */
function createTimestamp(ms) {
  const statics = firestoreStatics();
  if (statics && statics.Timestamp) {
    if (typeof statics.Timestamp.fromMillis === 'function') {
      return statics.Timestamp.fromMillis(ms);
    }
    if (typeof statics.Timestamp.fromDate === 'function') {
      return statics.Timestamp.fromDate(new Date(ms));
    }
  }
  return new Date(ms);
}

/**
 * Helper to log operation steps in a dedicated collection.
 * Each operation uses a client‑provided opId to guarantee idempotency.
 * `names` comes from collectionNamesFor(): the ops collection is environment-scoped so local
 * runs never write to the production `userOps` collection.
 */
async function logOperation(names, opId, updates) {
  const opRef = db.collection(names.ops).doc(opId);
  await opRef.set({
    ...updates,
    updatedAt: firestoreStatics().FieldValue.serverTimestamp()
  }, { merge: true });
  return opRef;
}
/**
 * Build a user-profile id in the SAME format the CRM uses for users:
 * `Date.now().toString()` (13-digit epoch milliseconds, see `saveUser` in app_core.js).
 * `attempt` is added to the timestamp so a collision can be retried deterministically.
 * The CRM keys the document by this id and stores it in the `id` field, and it is the value
 * referenced by `createdBy` / `vendedorId` in prospects and clients. It is NOT the Auth UID.
 */
function buildCrmUserId(attempt = 0) {
  return String(Date.now() + attempt);
}

/**
 * Environment suffix handling. The CRM resolves collections as `<name><DB_SUFFIX>` where the
 * suffix is `_local` (file:, localhost, 127.0.0.1) or `_prod`. The client sends its suffix;
 * only these two values are accepted. When absent: emulator → `_local`, deployed → `_prod`.
 * Operation / lock collections keep their historical names for `_prod` and get the suffix
 * otherwise, so local tests never write to production collections.
 */
const ALLOWED_DB_SUFFIXES = ['_local', '_prod'];
function resolveDbSuffix(requested) {
  if (requested === undefined || requested === null) {
    return process.env.FUNCTIONS_EMULATOR === 'true' ? '_local' : '_prod';
  }
  if (!ALLOWED_DB_SUFFIXES.includes(requested)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid dbSuffix');
  }
  return requested;
}
function collectionNamesFor(dbSuffix) {
  return {
    users: `users${dbSuffix}`,
    ops: dbSuffix === '_prod' ? 'userOps' : `userOps${dbSuffix}`,
    locks: dbSuffix === '_prod' ? 'userOpsLocks' : `userOpsLocks${dbSuffix}`,
    // Same server-only trail as the commercial operations (commercialService.namesFor).
    audit: `commercialAudit${dbSuffix}`,
    invitationOps: dbSuffix === '_prod' ? 'invitationOps' : `invitationOps${dbSuffix}`
  };
}

/**
 * Emails are compared and stored lower-cased and trimmed (Firebase Auth lower-cases them too),
 * so `Ana@X.com` and `ana@x.com` can never become two accounts.
 */
function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Server-side authorization shared by every admin function. The caller must have a verified
 * Firebase Auth session whose account carries the custom claim `manager === true` and is not
 * disabled. Nothing in this file ever grants that claim.
 */
async function assertManager(context, deniedMessage) {
  // Running under the Functions emulator without BOTH the Auth and Firestore emulators would make
  // the Admin SDK talk to the real project. Refuse before any Auth/Firestore access.
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    const problems = emulatorIsolationProblems(process.env);
    if (problems.length > 0) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Emulator isolation check failed (${problems.join('; ')}). Refusing to run: it could reach production.`
      );
    }
  }
  if (!context || !context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  let requester;
  try {
    requester = await admin.auth().getUser(context.auth.uid);
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') {
      throw new functions.https.HttpsError('permission-denied', deniedMessage);
    }
    throw new functions.https.HttpsError('internal', 'Could not verify the requester');
  }
  const claims = requester.customClaims || {};
  if (claims.manager !== true || requester.disabled === true) {
    throw new functions.https.HttpsError('permission-denied', deniedMessage);
  }
  return requester;
}

/**
 * A manager executing administrative functions must possess an active, linked CRM profile (SEC-03).
 * Rejecting unlinked manager accounts eliminates the privilege retention window following a partial rollback.
 *
 * Ordinary administrative operations require linked.length === 1 with activo === true and role === 'manager'.
 * Narrow exception: `allowUnlinked: true` is permitted ONLY for reconciliation queries (reconcileUserOp)
 * where an unlinked operator is restricted to operations they requested or target their account.
 */
async function assertRequesterProfileActive(names, uid, options = {}) {
  const allowUnlinked = options && options.allowUnlinked === true;
  let snap;
  try {
    snap = await db.collection(names.users).get();
  } catch (e) {
    throw new functions.https.HttpsError('internal', 'Error checking the requester profile');
  }
  const linked = snap.docs.filter(d => (d.data() || {}).authUid === uid);

  if (linked.length === 0) {
    if (allowUnlinked) {
      return null;
    }
    throw new functions.https.HttpsError('permission-denied', 'Se requiere un perfil administrativo vinculado y activo');
  }

  if (linked.length > 1) {
    throw new functions.https.HttpsError('permission-denied', 'Inconsistencia de perfil: múltiples perfiles vinculados a la misma cuenta Auth');
  }

  const profileData = linked[0].data() || {};
  if (profileData.activo !== true) {
    throw new functions.https.HttpsError('permission-denied', 'The requester profile is inactive');
  }

  if (profileData.role !== 'manager') {
    throw new functions.https.HttpsError('permission-denied', 'The requester profile does not have administrative privileges');
  }

  return { id: linked[0].id, nombre: profileData.nombre || '', role: profileData.role };
}

/**
 * Audit record of a user-administration change (server-only collection `commercialAudit<suffix>`, same shape as the
 * commercial audit). `detail` carries before / after of the changed fields: never credentials.
 */
function userAuditEntry(actor, action, targetId, detail) {
  return {
    action, targetType: 'user', targetId, detail: detail || {},
    actorUid: actor.uid, actorCid: actor.cid || null, actorName: actor.name || '', actorRole: 'manager',
    at: firestoreStatics().FieldValue.serverTimestamp(), atIso: new Date().toISOString()
  };
}
const sortedKeys = o => Object.keys(o || {}).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {});

/**
 * Lifecycle states of a createUserAdmin operation in `userOps`.
 *  - (no document)  → new operation
 *  - PENDING        → reserved, no Auth call issued yet
 *  - AUTH_CREATING  → intent recorded BEFORE createUser; outcome unknown until AUTH_CREATED
 *  - AUTH_CREATED   → Auth account created and its UID persisted (in progress)
 *  - SUCCEEDED      → completed
 *  - CONFLICT       → proven: email already belongs to another account; nothing created
 *  - ERROR          → proven: no Auth account kept by this op (never created or rolled back)
 *  - MANUAL_REVIEW  → uncertain result; an operator must reconcile. Never auto-retried.
 * Only a missing document authorises createUser. Every other state (including any
 * unknown value) is read, never re-executed.
 */
const OP_STATUS = {
  PENDING: 'pending',
  AUTH_CREATING: 'authCreating',
  AUTH_CREATED: 'authCreated',
  SUCCEEDED: 'succeeded',
  CONFLICT: 'conflict',
  ERROR: 'error',
  MANUAL_REVIEW: 'manualReview'
};



/**
 * Idempotent user creation.
 * Expected data: { email, nombre, role, opId, dbSuffix? }
 * Authorization is verified server-side: the caller must have a Firebase Auth session whose
 * account carries the custom claim `manager === true` and is not disabled. No claim is ever
 * granted by this function other than the informational `{ role }`.
 * The profile follows the CRM user schema: document key === `id` (CRM historical format),
 * Auth UID kept separately in `authUid`, and no password field of any kind.
 */
exports.createUserAdmin = functions.https.onCall(async (data, context) => {
  // ---------- Authorization ----------
  await assertManager(context, 'Only managers can create users');
  data = data || {};

  const { role, opId } = data;
  const nombre = typeof data.nombre === 'string' ? data.nombre.trim() : data.nombre;
  const email = normalizeEmail(data.email);
  if (!email || !nombre || !role || !opId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');
  }
  // opId becomes a Firestore document id: reject anything that is not a plain token.
  if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(opId)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid opId');
  }

  // ---------- Payload validation ----------
  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!emailRe.test(email)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid email format');
  }
  // Only roles the CRM recognises and that carry no administrative privilege. `manager` is
  // deliberately excluded; `seller` / `sales` are not CRM roles and are not accepted.
  const allowedRoles = ['vendedor', 'gestor'];
  if (!allowedRoles.includes(role)) {
    throw new functions.https.HttpsError('permission-denied', 'Creation of privileged roles is not allowed');
  }
  const dbSuffix = resolveDbSuffix(data.dbSuffix);
  const names = collectionNamesFor(dbSuffix);
  await assertRequesterProfileActive(names, context.auth.uid);

  // ---------- Idempotency ----------
  const payloadFingerprint = crypto.createHash('sha256').update(JSON.stringify({ email, nombre, role })).digest('hex');
  const opRef = db.collection(names.ops).doc(opId);
  // Legacy idempotency block removed; atomic reservation handles concurrency
  // Attempt atomic reservation of the operation document.
  // ---------- Acquire lock atomically ----------
  const lockRef = db.collection(names.locks).doc(opId);
  const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lockToken = crypto.randomBytes(16).toString('hex');
  const lockData = {
    ownerUid: context.auth.uid,
    token: lockToken,
    acquiredAt: firestoreStatics().FieldValue.serverTimestamp(),
    expiresAt: firestoreStatics().Timestamp.fromDate(new Date(Date.now() + LOCK_TTL_MS))
  };
  try {
    await lockRef.create(lockData);
  } catch (e) {
    // Lock exists – examine if it is expired and try to replace atomically.
    const existingSnap = await lockRef.get();
    const existing = existingSnap.data();
    const now = new Date();
    const isExpired = existing && existing.expiresAt && existing.expiresAt.toDate() <= now;
    if (isExpired) {
      try {
        await db.runTransaction(async t => {
          const snap = await t.get(lockRef);
          const data = snap.data();
          const expired = !snap.exists || (data && data.expiresAt && data.expiresAt.toDate() <= now);
          if (!expired) {
            throw new Error('Lock still owned');
          }
          t.set(lockRef, lockData);
        });
      } catch (txErr) {
        throw new functions.https.HttpsError('already-exists', 'Operation already in progress (lock replacement failed)');
      }
    } else {
      throw new functions.https.HttpsError('already-exists', 'Operation already in progress');
    }
  }

  // Helper to update operation only while lock is held
  const updateOp = async (updates) => {
    await db.runTransaction(async t => {
      const lockSnap = await t.get(lockRef);
      if (!lockSnap.exists || lockSnap.data().token !== lockToken || lockSnap.data().expiresAt.toDate() <= new Date()) {
        throw new Error('Lock lost or expired');
      }
      t.set(opRef, { ...updates, updatedAt: firestoreStatics().FieldValue.serverTimestamp() }, { merge: true });
    });
  };
  // Best-effort write of a terminal state in which this operation is PROVEN not to hold
  // an Auth account (error / conflict). If the write fails the op keeps its previous
  // state, which can only block retries (never authorise a new createUser).
  const recordFailure = async (status, message, extra = {}) => {
    try {
      await updateOp({ status, message, ...extra });
    } catch (_) { /* previous state keeps blocking retries */ }
  };
  // Best-effort write of OP_STATUS.MANUAL_REVIEW. Deliberately NOT lock-gated: the usual
  // reason to land here is a lost/expired lock or a failed write. If this write also
  // fails, the AUTH_CREATING marker written before createUser still blocks retries.
  const markManualReview = async (message, extra = {}) => {
    try {
      await opRef.set({
        status: OP_STATUS.MANUAL_REVIEW,
        message,
        ...extra,
        updatedAt: firestoreStatics().FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (_) { /* AUTH_CREATING / AUTH_CREATED marker keeps blocking retries */ }
  };
  const releaseLock = async () => {
    try {
      const lockSnap = await lockRef.get();
      if (lockSnap.exists && lockSnap.data().token === lockToken) {
        await lockRef.delete();
      }
    } catch (_) { /* lock expires on its own via TTL */ }
  };
  const manualReviewError = (detail) => new functions.https.HttpsError(
    'failed-precondition',
    `Manual review required for operation ${opId}: ${detail}. No new Auth account will be created automatically.`
  );

  try {
    let opCreated = false;
    try {
      await opRef.create({
        status: OP_STATUS.PENDING,
        requesterUid: context.auth.uid,
        fingerprint: payloadFingerprint,
        timestamp: firestoreStatics().FieldValue.serverTimestamp()
      });
      opCreated = true;
    } catch (e) {
      // Distinguish Firestore errors: if the document already exists, treat as conflict; otherwise surface as internal.
      const alreadyExists = e.code === 6 || (e.message && e.message.includes('already exists'));
      if (!alreadyExists) {
        throw new functions.https.HttpsError('internal', e.message || 'Firestore reservation failed');
      }
      // Document already exists – retrieve existing data for conflict checks.
      const existingSnap = await opRef.get();
      const existingData = existingSnap.data();
      if (!existingData) {
        // Unexpected missing data after existence error.
        throw new functions.https.HttpsError('internal', 'Failed to read existing operation data');
      }
      if (existingData.requesterUid !== context.auth.uid) {
        throw new functions.https.HttpsError('already-exists', 'Operation key used by another user');
      }
      if (existingData.fingerprint !== payloadFingerprint) {
        throw new functions.https.HttpsError('already-exists', 'Operation key reused with different payload');
      }
      // An existing operation is NEVER re-executed. We only hold the lock here because the
      // previous holder finished, died, or timed out, so its result must be read from the
      // persisted state, never assumed.
      switch (existingData.status) {
        case OP_STATUS.SUCCEEDED:
          return {
            uid: existingData.uid,
            id: existingData.profileId,
            email,
            status: 'created',
            requestId: existingData.requestId || null,
            link: null, // Security invariant: never expose or retrieve stored sensitive link on replay
            invitation: {
              status: (existingData.invitation && existingData.invitation.status) || 'pending',
              lastRequestStatus: (existingData.invitation && existingData.invitation.lastRequestStatus) || 'pending',
              delivery: (existingData.invitation && existingData.invitation.delivery) || 'prepared',
              sent: false,
              linkGenerated: !!(existingData.invitation && existingData.invitation.linkGenerated),
              recipientEmail: email
            },
            message: 'operation already completed'
          };
        case OP_STATUS.CONFLICT:
          throw new functions.https.HttpsError('already-exists', existingData.message || 'Conflict detected');
        case OP_STATUS.ERROR:
          throw new functions.https.HttpsError('failed-precondition', 'Operation failed previously before any Auth account was kept; use a new opId');
        case OP_STATUS.PENDING:
          // AUTH_CREATING is written before createUser, so no Auth call was made.
          throw new functions.https.HttpsError('failed-precondition', 'Operation was interrupted before any Auth account was created; use a new opId');
        case OP_STATUS.MANUAL_REVIEW:
          throw manualReviewError(existingData.message || 'previous attempt flagged for review');
        default:
          // AUTH_CREATING, AUTH_CREATED or any unknown status: result of createUser / UID
          // persistence is uncertain. Escalate; never fall through to createUser.
          await markManualReview('Previous attempt ended with an uncertain result', {
            previousStatus: existingData.status || null
          });
          throw manualReviewError('previous attempt ended with an uncertain result');
      }
    }
    // Continue only if this request created the operation document.
    if (!opCreated) {
      // The function will have already returned or thrown above.
      return; // safety guard (should not reach here).
    }

    // ---------- Conflict detection ----------
    let existingAuthUser;
    try {
      existingAuthUser = await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        await recordFailure(OP_STATUS.ERROR, e.message);
        throw new functions.https.HttpsError('internal', 'Error checking Auth accounts');
      }
    }

    // This request has just created the op document, so no createUser has ever been issued
    // for it: an existing account cannot be proven to belong to this operation. Never adopt it.
    if (existingAuthUser) {
      await recordFailure(OP_STATUS.CONFLICT, 'Auth account already exists for this email');
      throw new functions.https.HttpsError('already-exists', 'An authentication account already exists for the supplied email');
    }

    // Historical CRM users have a profile but (as far as can be proven) no Auth account, and the
    // CRM login resolves users by email. A second profile with the same email would make that
    // lookup ambiguous, so any existing profile with this email (case-insensitive) is a conflict.
    let emailTaken;
    try {
      const emailKey = email.toLowerCase();
      const usersSnap = await db.collection(names.users).get();
      emailTaken = usersSnap.docs.some(d => String((d.data() || {}).email || '').trim().toLowerCase() === emailKey);
    } catch (e) {
      await recordFailure(OP_STATUS.ERROR, e.message);
      throw new functions.https.HttpsError('internal', 'Error checking existing user profiles');
    }
    if (emailTaken) {
      await recordFailure(OP_STATUS.CONFLICT, 'A user profile already exists for this email');
      throw new functions.https.HttpsError('already-exists', 'A user profile already exists for the supplied email');
    }

    // ---------- Create Auth account ----------
    // Record the intent BEFORE calling Auth. From this point on, any retry that finds
    // AUTH_CREATING (or later) knows the outcome is uncertain and must not call createUser.
    try {
      await updateOp({ status: OP_STATUS.AUTH_CREATING });
    } catch (e) {
      await recordFailure(OP_STATUS.ERROR, e.message);
      throw new functions.https.HttpsError('internal', 'Failed to record operation intent');
    }

    let newAuthUser;
    try {
      newAuthUser = await admin.auth().createUser({ email });
    } catch (e) {
      // Only errors that prove no account was created are treated as definitive.
      if (e.code === 'auth/email-already-exists') {
        await recordFailure(OP_STATUS.CONFLICT, 'Auth account already exists for this email');
        throw new functions.https.HttpsError('already-exists', 'An authentication account already exists for the supplied email');
      }
      if (e.code === 'auth/invalid-email') {
        await recordFailure(OP_STATUS.ERROR, e.message);
        throw new functions.https.HttpsError('invalid-argument', 'Invalid email format');
      }
      await markManualReview('Auth createUser outcome unknown', { createError: e.message });
      throw manualReviewError('Auth createUser outcome unknown');
    }

    // Persist the UID. If this fails the account exists but is not linked in Firestore:
    // we do not delete it nor retry creation; a human must reconcile it.
    try {
      await updateOp({ uid: newAuthUser.uid, status: OP_STATUS.AUTH_CREATED });
    } catch (e) {
      await markManualReview('Auth account created but its UID could not be persisted', {
        uid: newAuthUser.uid,
        persistError: e.message
      });
      throw manualReviewError('Auth account created but its UID could not be persisted');
    }

    // ---------- Write Firestore profile ----------
    // CRM schema: key === id (historical format); Auth UID stored separately as `authUid`;
    // no `password` field (the credential lives only in Firebase Authentication). `create()`
    // never overwrites an existing profile; on an id collision the next id is tried.
    let profileId;
    let profileOutcomeUncertain = false;
    try {
      const MAX_ID_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && !profileId; attempt++) {
        const candidate = buildCrmUserId(attempt);
        const profileRef = db.collection(names.users).doc(candidate);
        try {
          await profileRef.create({
            id: candidate,
            authUid: newAuthUser.uid,
            authProvider: 'firebase',
            nombre,
            email,
            role,
            activo: true,
            invitation: buildInitialInvitation(email)
          });
          profileId = candidate;
        } catch (createErr) {
          // The write failed from our point of view, but it may have been applied. Read it
          // back: only a profile that carries THIS request's authUid proves it is ours.
          let landed = false;
          try {
            const snap = await profileRef.get();
            landed = !!snap.exists && (snap.data() || {}).authUid === newAuthUser.uid;
          } catch (_) {
            profileOutcomeUncertain = true;
            throw createErr;
          }
          if (landed) {
            profileId = candidate;
            continue;
          }
          const exists = createErr.code === 6 || (createErr.message && createErr.message.includes('already exists'));
          if (!exists) throw createErr;
        }
      }
      if (!profileId) throw new Error('Could not allocate a unique profile id');
    } catch (e) {
      if (profileOutcomeUncertain) {
        // Cannot prove whether a profile for this account exists: deleting the account could
        // orphan it, keeping it could leave it unlinked. A human decides.
        await markManualReview('Profile write outcome unknown; Auth account kept', { uid: newAuthUser.uid, profileError: e.message });
        throw manualReviewError('Profile write outcome unknown; the Auth account was kept');
      }
      // Rollback: this account was created by this very request (UID persisted above).
      try {
        await admin.auth().deleteUser(newAuthUser.uid);
      } catch (delErr) {
        await markManualReview('Failed to write profile and rollback failed', { uid: newAuthUser.uid, rollbackError: delErr.message });
        throw manualReviewError(`Profile write failed and could not delete Auth user: ${delErr.message}`);
      }
      await recordFailure(OP_STATUS.ERROR, 'Failed to write Firestore profile', { rolledBack: true });
      throw new functions.https.HttpsError('internal', 'Failed to persist user profile');
    }

    // ---------- Set custom claims ----------
    try {
      await admin.auth().setCustomUserClaims(newAuthUser.uid, { role, cid: profileId });
    } catch (e) {
      // Rollback: this account was created by this very request (UID persisted above).
      let profileDeleteFailed = false;
      try {
        await db.collection(names.users).doc(profileId).delete();
      } catch (profDelErr) {
        profileDeleteFailed = true;
      }
      try {
        await admin.auth().deleteUser(newAuthUser.uid);
      } catch (delErr) {
        await markManualReview('Failed to set custom claims and rollback failed', {
          uid: newAuthUser.uid,
          profileId,
          rollbackError: delErr.message,
          profileDeleteFailed
        });
        throw manualReviewError(`Failed to assign role and could not delete user: ${delErr.message}`);
      }
      if (profileDeleteFailed) {
        await markManualReview('Failed to set custom claims: Auth user deleted but profile delete failed', {
          uid: newAuthUser.uid,
          profileId
        });
        throw manualReviewError('Failed to assign role and profile cleanup failed');
      }
      await recordFailure(OP_STATUS.ERROR, 'Failed to set custom claims', { rolledBack: true });
      throw new functions.https.HttpsError('internal', 'Failed to assign role');
    }

    // ---------- Backend Ticket Authority: Pre-register Invitation Ticket (Write-Ahead) ----------
    const requestId = crypto.randomUUID();
    const ticketTtlMs = 24 * 60 * 60 * 1000;
    const expiresAt = createTimestamp(Date.now() + ticketTtlMs);
    try {
      const invCol = db.collection(names.invitationOps);
      if (invCol && typeof invCol.doc === 'function') {
        const ticketDoc = invCol.doc(requestId);
        if (ticketDoc && typeof ticketDoc.set === 'function') {
          await ticketDoc.set({
            status: 'ISSUED',
            userId: profileId,
            recipientEmail: email,
            requestedBy: context.auth.uid,
            operation: 'create_user',
            createdAt: firestoreStatics().FieldValue.serverTimestamp(),
            expiresAt
          });
        }
      }
    } catch (_) { /* Best effort logging */ }

    // ---------- Native Architecture: No Admin SDK Link Generation ----------
    // In accordance with Step 6.3.2 and Step 6.3.4.4, link generation via Admin SDK
    // is completely removed in both production and emulator environments.
    // The client SDK executes the single dispatch (sendPasswordResetEmail).

    // ---------- Finalize operation ----------
    try {
      // Mark operation as succeeded.
      // Invariant: NEVER persist raw invitation link or sensitive action code in Firestore userOps.
      await updateOp({
        status: OP_STATUS.SUCCEEDED,
        uid: newAuthUser.uid,
        profileId,
        requestId,
        message: 'User created',
        invitation: {
          status: INVITATION_STATUS.PENDING,
          lastRequestStatus: 'pending',
          delivery: 'client_sdk',
          sent: false,
          linkGenerated: false,
          error: null
        }
      });
    } catch (e) {
      await markManualReview('Failed to finalize operation', { uid: newAuthUser.uid, profileId, finalizeError: e.message });
      throw manualReviewError('Auth account and profile exist but the operation could not be finalized');
    }

    return {
      uid: newAuthUser.uid,
      id: profileId,
      email,
      status: 'created',
      requestId,
      link: null,
      invitation: {
        status: INVITATION_STATUS.PENDING,
        lastRequestStatus: 'pending',
        lastRequestAt: null,
        lastAcceptedAt: null,
        delivery: 'client_sdk',
        sent: false,
        preparedCount: 0,
        sentCount: 0,
        recipientEmail: email,
        error: null
      },
      message: 'User created'
    };
  } finally {
    // Release lock if we still own it (never throws).
    await releaseLock();
  }
});

/**
 * Plain-token check for values that become Firestore document ids (opId, commercial user id).
 */
function isToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Toggle user active status (explicit desired state, so retries are idempotent).
 * Expected data: { id, activo, opId, dbSuffix? }
 *  - `id` is the CRM commercial id (document key in `users<suffix>`), NOT the Auth UID.
 *  - Only profiles linked to Firebase Auth (`authUid`) are handled: historical users have no
 *    Auth account to disable and keep being managed directly by the CRM.
 *  - A manager cannot change their own status, and manager accounts are never touched here.
 */
exports.toggleUserStatusAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can toggle status');
  data = data || {};
  const { id, opId, activo } = data;
  if (!isToken(id) || !isToken(opId) || typeof activo !== 'boolean') {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid id, opId or activo');
  }
  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const requester = await assertRequesterProfileActive(names, context.auth.uid);
  const requesterActor = { uid: context.auth.uid, cid: requester && requester.id, name: requester && requester.nombre };

  const opRef = db.collection(names.ops).doc(opId);
  const opSnap = await opRef.get();
  if (opSnap.exists) {
    const prev = opSnap.data() || {};
    if (prev.requesterUid !== context.auth.uid || prev.action !== 'toggleStatus' || prev.profileId !== id || prev.activo !== activo) {
      throw new functions.https.HttpsError('already-exists', 'Operation key reused with different payload');
    }
    if (prev.status === OP_STATUS.SUCCEEDED) {
      return { id, activo, message: 'operation already completed' };
    }
    if (prev.status === OP_STATUS.MANUAL_REVIEW) {
      throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}`);
    }
  }
  await logOperation(names, opId, {
    status: OP_STATUS.PENDING, action: 'toggleStatus', requesterUid: context.auth.uid, profileId: id, activo
  });

  // Read current profile (commercial id -> authUid).
  const userDocRef = db.collection(names.users).doc(id);
  const userSnap = await userDocRef.get();
  if (!userSnap.exists) {
    await logOperation(names, opId, { status: OP_STATUS.CONFLICT, message: 'User profile not found' });
    throw new functions.https.HttpsError('not-found', 'User profile does not exist');
  }
  const profile = userSnap.data() || {};
  if (!profile.authUid) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Profile is not linked to an Auth account' });
    throw new functions.https.HttpsError('failed-precondition', 'This profile has no linked Auth account (historical user); its status is managed in the CRM directly');
  }
  if (profile.authUid === context.auth.uid) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Self status change refused' });
    throw new functions.https.HttpsError('failed-precondition', 'You cannot change your own status');
  }

  let target;
  try {
    target = await admin.auth().getUser(profile.authUid);
  } catch (e) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Linked Auth account could not be read' });
    throw new functions.https.HttpsError(e && e.code === 'auth/user-not-found' ? 'not-found' : 'internal', 'Linked Auth account could not be read');
  }
  if ((target.customClaims || {}).manager === true) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Manager accounts are not managed here' });
    throw new functions.https.HttpsError('permission-denied', 'Manager accounts cannot be changed with this function');
  }

  // Update Auth disabled flag.
  try {
    await admin.auth().updateUser(profile.authUid, { disabled: !activo });
  } catch (e) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Failed to update Auth disabled flag' });
    throw new functions.https.HttpsError('internal', 'Auth update failed');
  }
  if (!activo) {
    // Best effort: also invalidate refresh tokens so existing sessions stop renewing.
    try { await admin.auth().revokeRefreshTokens(profile.authUid); } catch (_) { /* disabled flag already applied */ }
  }

  // Update Firestore profile + audit record (before / after, no credentials) in ONE transaction: the profile never
  // changes without its audit entry.
  try {
    await db.runTransaction(async tx => {
      tx.update(userDocRef, { activo });
      tx.create(db.collection(names.audit).doc(), userAuditEntry(requesterActor, 'toggleUserStatus', id, {
        opId,
        before: { activo: profile.activo === true, authDisabled: target.disabled === true },
        after: { activo, authDisabled: !activo }
      }));
    });
  } catch (e) {
    // Roll back the Auth change to the state we read.
    try {
      await admin.auth().updateUser(profile.authUid, { disabled: target.disabled === true });
    } catch (rbErr) {
      await logOperation(names, opId, { status: OP_STATUS.MANUAL_REVIEW, message: 'Profile update failed and Auth rollback failed', uid: profile.authUid });
      throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}: Auth and profile are out of sync`);
    }
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Failed to update Firestore profile' });
    throw new functions.https.HttpsError('internal', 'Firestore update failed');
  }

  await logOperation(names, opId, { status: OP_STATUS.SUCCEEDED, message: 'Status set' });
  return { id, activo };
});

// ---------------------------------------------------------------------------------------------------------------------
// Edit name / change role of a user linked to Firebase Auth (activation is toggleUserStatusAdmin: one entry point each).
// Expected data: { id, nombre?, role?, opId, dbSuffix? } (at least one of nombre / role; ANY other field is rejected so a
// client that believes it changed something else never gets a false success).
//  - `id` is the CRM commercial id (document key), NOT the Auth uid. Historical profiles (no `authUid`) are refused.
//  - Manager-only, verified live (claim + enabled account + active profile) BEFORE and, for role changes, AGAIN after
//    the role-change lock is taken.
//  - Roles that can be assigned: vendedor | gestor (same as createUserAdmin). Nothing in the code ever grants `manager`;
//    the plant roles are not CRM roles. A manager target CAN be demoted (that removes the `manager` claim).
//  - Nobody changes their own role (no self-privilege). Because the caller is a verified live manager and cannot be the
//    target, demoting another manager always leaves at least one manager. The role-change lock serialises two managers
//    demoting each other at the same time: the second one fails the re-verification and is denied.
//  - Coherence: Auth claims first (the reduction of privilege takes effect first), then the Firestore profile + audit
//    record in one transaction; if that fails the previous claims are restored. If the restore also fails the operation
//    is MANUAL_REVIEW and the caller gets an error: success is never reported for a half-applied change.
//  - Claims written: the existing ones minus `manager`, plus { role, cid } (cid = commercial id, as resolveCaller expects).
//  - Audit: `commercialAudit<suffix>` (before / after of nombre, role, claims summary; never credentials).
// ---------------------------------------------------------------------------------------------------------------------
const USER_ADMIN_ROLES = ['vendedor', 'gestor'];
const USER_UPDATE_FIELDS = ['id', 'nombre', 'role', 'email', 'opId', 'dbSuffix'];
const ROLE_LOCK_KEY = 'role.change.global'; // contains '.', so it can never collide with an opId (plain token)

async function acquireRoleLock(names, ownerUid) {
  const statics = firestoreStatics();
  const ref = db.collection(names.locks).doc(ROLE_LOCK_KEY);
  const token = crypto.randomBytes(16).toString('hex');
  const fresh = () => ({
    ownerUid, token,
    acquiredAt: statics.FieldValue.serverTimestamp(),
    expiresAt: statics.Timestamp.fromDate(new Date(Date.now() + 2 * 60 * 1000))
  });
  const busy = () => new functions.https.HttpsError('already-exists', 'Another role change is in progress; retry shortly');
  try {
    await ref.create(fresh());
  } catch (e) {
    const exists = e && (e.code === 6 || /already.?exists/i.test(e.message || ''));
    if (!exists) throw new functions.https.HttpsError('internal', 'Could not take the role-change lock');
    const cur = (await ref.get()).data();
    const expired = cur && cur.expiresAt && cur.expiresAt.toDate() <= new Date();
    if (!expired) throw busy();
    try {
      await db.runTransaction(async t => {
        const s = await t.get(ref);
        const d = s.data();
        if (s.exists && !(d && d.expiresAt && d.expiresAt.toDate() <= new Date())) throw new Error('Lock still owned');
        t.set(ref, fresh());
      });
    } catch (_) { throw busy(); }
  }
  return async () => {
    try {
      const s = await ref.get();
      if (s.exists && s.data().token === token) await ref.delete();
    } catch (_) { /* expires on its own */ }
  };
}

exports.updateUserAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can update users');
  data = data || {};
  if (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !USER_UPDATE_FIELDS.includes(k))) {
    throw new functions.https.HttpsError('invalid-argument', 'Only id, nombre, role, email and opId can be sent (use toggleUserStatusAdmin for activation)');
  }
  const { id, opId } = data;
  if (!isToken(id) || !isToken(opId)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid id or opId');
  }
  const hasName = data.nombre !== undefined;
  const hasRole = data.role !== undefined;
  const hasEmail = data.email !== undefined;
  if (!hasName && !hasRole && !hasEmail) throw new functions.https.HttpsError('invalid-argument', 'Nothing to change: send nombre, role and/or email');
  let nombre = null;
  if (hasName) {
    nombre = typeof data.nombre === 'string' ? data.nombre.trim() : '';
    if (!nombre || nombre.length > 120 || /[\u0000-\u001f\u007f]/.test(nombre)) {
      throw new functions.https.HttpsError('invalid-argument', 'nombre must be 1-120 printable characters');
    }
  }
  if (hasRole && !USER_ADMIN_ROLES.includes(data.role)) {
    throw new functions.https.HttpsError('permission-denied', 'Only the roles vendedor and gestor can be assigned');
  }
  const role = hasRole ? data.role : null;

  let email = null;
  if (hasEmail) {
    email = normalizeEmail(data.email);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid email format');
    }
  }

  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const requesterUid = context.auth.uid;
  const requester = await assertRequesterProfileActive(names, requesterUid);
  const actor = { uid: requesterUid, cid: requester && requester.id, name: requester && requester.nombre };

  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ id, nombre, role, email })).digest('hex');
  const opRef = db.collection(names.ops).doc(opId);
  const opSnap = await opRef.get();
  if (opSnap.exists) {
    const prev = opSnap.data() || {};
    if (prev.requesterUid !== requesterUid || prev.action !== 'updateUser' || prev.fingerprint !== fingerprint) {
      throw new functions.https.HttpsError('already-exists', 'Operation key reused with different payload');
    }
    if (prev.status === OP_STATUS.SUCCEEDED) return { ...(prev.result || { id }), message: 'operation already completed' };
    if (prev.status === OP_STATUS.MANUAL_REVIEW) {
      throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}`);
    }
  }
  await logOperation(names, opId, { status: OP_STATUS.PENDING, action: 'updateUser', requesterUid, profileId: id, fingerprint });

  const refuse = async (status, message, code, publicMessage) => {
    await logOperation(names, opId, { status, message });
    return new functions.https.HttpsError(code, publicMessage || message);
  };

  let releaseLock = null;
  try {
    if (hasRole) {
      try {
        releaseLock = await acquireRoleLock(names, requesterUid);
        // An operation that just finished may have demoted THIS caller: verify again, inside the lock.
        await assertManager(context, 'Only managers can update users');
        await assertRequesterProfileActive(names, requesterUid);
      } catch (e) {
        await logOperation(names, opId, { status: OP_STATUS.ERROR, message: `Role-change precondition failed: ${e.message}` });
        throw e;
      }
    }

    const userRef = db.collection(names.users).doc(id);
    const snap = await userRef.get();
    if (!snap.exists) throw await refuse(OP_STATUS.CONFLICT, 'User profile not found', 'not-found', 'User profile does not exist');
    const profile = snap.data() || {};
    if (!profile.authUid) {
      throw await refuse(OP_STATUS.ERROR, 'Profile is not linked to an Auth account', 'failed-precondition',
        'This profile has no linked Auth account (historical user); it is managed in the CRM directly');
    }
    if (hasRole && profile.authUid === requesterUid) {
      throw await refuse(OP_STATUS.ERROR, 'Self role change refused', 'permission-denied', 'You cannot change your own role');
    }
    if (hasEmail && profile.authUid === requesterUid) {
      throw await refuse(OP_STATUS.ERROR, 'Self email change refused', 'permission-denied', 'You cannot change your own email via user administration');
    }

    const currentEmail = (profile.email || '').trim().toLowerCase();
    const emailChanges = hasEmail && email !== currentEmail;

    if (emailChanges) {
      // Uniqueness in Firebase Auth
      let existingAuth = null;
      try {
        existingAuth = await admin.auth().getUserByEmail(email);
      } catch (e) {
        if (e && e.code !== 'auth/user-not-found') {
          throw await refuse(OP_STATUS.ERROR, e.message, 'internal', 'Error checking Auth accounts');
        }
      }
      if (existingAuth && existingAuth.uid !== profile.authUid) {
        throw await refuse(OP_STATUS.CONFLICT, 'Auth account already exists for this email', 'already-exists', 'An authentication account already exists for the supplied email');
      }

      // Uniqueness in Firestore profile collection
      const usersSnap = await db.collection(names.users).get();
      const emailTaken = usersSnap.docs.some(d => d.id !== id && String((d.data() || {}).email || '').trim().toLowerCase() === email);
      if (emailTaken) {
        throw await refuse(OP_STATUS.CONFLICT, 'A user profile already exists for this email', 'already-exists', 'A user profile already exists for the supplied email');
      }
    }

    let target;
    try {
      target = await admin.auth().getUser(profile.authUid);
    } catch (e) {
      throw await refuse(OP_STATUS.ERROR, 'Linked Auth account could not be read', e && e.code === 'auth/user-not-found' ? 'not-found' : 'internal', 'Linked Auth account could not be read');
    }
    const currentClaims = target.customClaims || {};
    const before = {
      nombre: profile.nombre === undefined ? null : profile.nombre,
      role: profile.role === undefined ? null : profile.role,
      activo: profile.activo === true,
      claims: { role: currentClaims.role === undefined ? null : currentClaims.role, cid: currentClaims.cid === undefined ? null : currentClaims.cid, manager: currentClaims.manager === true }
    };
    if (emailChanges) {
      before.email = profile.email === undefined ? null : profile.email;
    }
    let nextClaims = null;
    if (hasRole) {
      nextClaims = { ...currentClaims };
      delete nextClaims.manager; // never granted here, and removed when a manager is demoted
      nextClaims.role = role;
      nextClaims.cid = id;
    }
    const nameChanges = hasName && nombre !== (profile.nombre === undefined ? '' : profile.nombre);
    const claimsChange = hasRole && JSON.stringify(sortedKeys(nextClaims)) !== JSON.stringify(sortedKeys(currentClaims));
    const roleChanges = hasRole && (profile.role !== role || claimsChange);
    if (!nameChanges && !roleChanges && !emailChanges) {
      const result = { status: 'unchanged', id, nombre: before.nombre, role: before.role, ...(emailChanges ? { email: before.email } : {}) };
      await logOperation(names, opId, { status: OP_STATUS.SUCCEEDED, message: 'Nothing to change', result });
      return result;
    }

    const after = {
      nombre: nameChanges ? nombre : before.nombre,
      role: roleChanges ? role : before.role,
      activo: before.activo,
      claims: roleChanges ? { role, cid: id, manager: false } : before.claims
    };
    if (emailChanges) {
      after.email = email;
    }
    const fields = [nameChanges ? 'nombre' : null, roleChanges ? 'role' : null, emailChanges ? 'email' : null].filter(Boolean);

    // Step 1: Auth claims (role changes)
    const restoreClaims = async () => {
      try { await admin.auth().setCustomUserClaims(profile.authUid, currentClaims); return true; } catch (_) { return false; }
    };
    if (claimsChange) {
      try {
        await admin.auth().setCustomUserClaims(profile.authUid, nextClaims);
      } catch (e) {
        if (!(await restoreClaims())) {
          await logOperation(names, opId, { status: OP_STATUS.MANUAL_REVIEW, message: 'Setting claims failed and restore failed', uid: profile.authUid, before, after });
          throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}: Auth claims may be out of sync`);
        }
        await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Failed to set custom claims' });
        throw new functions.https.HttpsError('internal', 'Failed to update the Auth claims');
      }
    }

    // Step 1b: Auth email (email changes)
    const restoreEmail = async () => {
      try { await admin.auth().updateUser(profile.authUid, { email: profile.email }); return true; } catch (_) { return false; }
    };
    if (emailChanges) {
      try {
        await admin.auth().updateUser(profile.authUid, { email });
      } catch (e) {
        if (claimsChange) await restoreClaims();
        await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Failed to update Auth email' });
        throw new functions.https.HttpsError('internal', `Failed to update email in authentication: ${e.message}`);
      }
    }

    // Step 2: profile + audit in one transaction, only if the profile is still the one we validated.
    try {
      await db.runTransaction(async tx => {
        const cur = await tx.get(userRef);
        const c = cur.exists ? (cur.data() || {}) : null;
        if (!c || c.authUid !== profile.authUid || c.role !== profile.role ||
            (c.nombre === undefined ? '' : c.nombre) !== (profile.nombre === undefined ? '' : profile.nombre) ||
            (c.email === undefined ? '' : c.email.toLowerCase()) !== (profile.email === undefined ? '' : profile.email.toLowerCase())) {
          const conflict = new Error('Profile changed while updating');
          conflict.userConflict = true;
          throw conflict;
        }
        tx.update(userRef, {
          ...(nameChanges ? { nombre } : {}),
          ...(roleChanges ? { role } : {}),
          ...(emailChanges ? { email, 'invitation.recipientEmail': email } : {})
        });
        tx.create(db.collection(names.audit).doc(), userAuditEntry(actor, 'updateUser', id, { opId, fields, before, after }));
      });
    } catch (e) {
      if (emailChanges && !(await restoreEmail())) {
        await logOperation(names, opId, { status: OP_STATUS.MANUAL_REVIEW, message: 'Profile update failed and email restore failed', uid: profile.authUid, before, after });
        throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}: Auth email and profile are out of sync`);
      }
      if (claimsChange && !(await restoreClaims())) {
        await logOperation(names, opId, { status: OP_STATUS.MANUAL_REVIEW, message: 'Profile update failed and claims restore failed', uid: profile.authUid, before, after });
        throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}: Auth claims and profile are out of sync`);
      }
      await logOperation(names, opId, { status: OP_STATUS.ERROR, message: e.userConflict ? 'Profile changed concurrently' : 'Failed to update Firestore profile' });
      throw e.userConflict
        ? new functions.https.HttpsError('aborted', 'The profile changed while it was being updated; nothing was applied, retry')
        : new functions.https.HttpsError('internal', 'Firestore update failed');
    }

    // Step 3 (best effort): end the target's existing sessions so the new claims apply at once.
    let sessionsRevoked = false;
    if (roleChanges || emailChanges) {
      try { await admin.auth().revokeRefreshTokens(profile.authUid); sessionsRevoked = true; } catch (_) { /* claims + profile already applied */ }
    }
    const result = { status: 'updated', id, nombre: after.nombre, role: after.role, email: after.email, fields, sessionsRevoked };
    await logOperation(names, opId, { status: OP_STATUS.SUCCEEDED, message: 'User updated', result, before, after });
    return result;
  } finally {
    if (releaseLock) await releaseLock();
  }
});

/**
 * Re-send activation / password setup invitation for a linked user.
 * Expected data: { id, opId?, dbSuffix? }
 * Generates a fresh password setup link via Firebase Admin Auth and dispatches the
 * invitation through the decoupled invitation dispatcher.
 */
exports.resendInvitationAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can resend invitations');
  data = data || {};
  if (data.id && data.userId && data.id !== data.userId) {
    throw new functions.https.HttpsError('invalid-argument', 'Ambiguous id and userId provided');
  }
  const id = data.id || data.userId;
  if (!isToken(id)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid id');
  }
  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const requester = await assertRequesterProfileActive(names, context.auth.uid);

  const userRef = db.collection(names.users).doc(id);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'User profile does not exist');
  }
  const profile = userSnap.data() || {};
  if (!profile.authUid) {
    throw new functions.https.HttpsError('failed-precondition', 'This profile has no linked Auth account (historical user)');
  }
  if (!profile.activo) {
    throw new functions.https.HttpsError('failed-precondition', 'The profile is inactive');
  }

  // Verify Auth account exists and is not disabled
  let authUser;
  try {
    authUser = await admin.auth().getUser(profile.authUid);
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') {
      throw new functions.https.HttpsError('not-found', 'Linked authentication account does not exist');
    }
    throw new functions.https.HttpsError('internal', `Error reading Auth account: ${e ? e.message : 'unknown'}`);
  }
  if (authUser.disabled) {
    throw new functions.https.HttpsError('failed-precondition', 'The authentication account is disabled');
  }

  // Handle email changed in Auth: synchronize with profile
  const targetEmail = (authUser.email || profile.email || '').trim().toLowerCase();
  if (targetEmail && profile.email && targetEmail !== profile.email.toLowerCase()) {
    await userRef.update({
      email: targetEmail,
      'invitation.recipientEmail': targetEmail
    });
    profile.email = targetEmail;
  }

  // Pre-register re-send ticket in invitationOps (Backend Ticket Authority)
  const requestId = crypto.randomUUID();
  const ticketTtlMs = 24 * 60 * 60 * 1000;
  const expiresAt = createTimestamp(Date.now() + ticketTtlMs);
  try {
    const invCol = db.collection(names.invitationOps);
    if (invCol && typeof invCol.doc === 'function') {
      const ticketDoc = invCol.doc(requestId);
      if (ticketDoc && typeof ticketDoc.set === 'function') {
        await ticketDoc.set({
          status: 'ISSUED',
          userId: id,
          recipientEmail: profile.email,
          requestedBy: context.auth.uid,
          operation: 'resend_invitation',
          createdAt: firestoreStatics().FieldValue.serverTimestamp(),
          expiresAt
        });
      }
    }
  } catch (_) { /* Best effort logging */ }

  // Update invitation state in profile.
  // Invariant: NEVER revert an already 'activated' user to 'pending' or 'prepared'.
  const currentStatus = (profile.invitation && profile.invitation.status) || INVITATION_STATUS.PENDING;
  const newStatus = currentStatus === INVITATION_STATUS.ACTIVATED
    ? INVITATION_STATUS.ACTIVATED
    : currentStatus;

  const profileUpdate = {
    'invitation.status': newStatus,
    'invitation.recipientEmail': profile.email,
    'invitation.lastError': null
  };

  await userRef.update(profileUpdate);

  // Record audit entry: never log raw link or action code
  const actor = { uid: context.auth.uid, cid: requester && requester.id, name: requester && requester.nombre };
  try {
    await db.collection(names.audit).doc().create(
      userAuditEntry(actor, 'resendInvitation', id, {
        email: profile.email,
        requestId,
        delivery: 'client_sdk',
        sent: false,
        linkGenerated: false
      })
    );
  } catch (_) { /* Audit write is best-effort */ }

  return {
    authorized: true,
    id: profile.id,
    email: profile.email,
    currentStatus: newStatus,
    requestId,
    link: null,
    sent: false,
    delivery: 'client_sdk',
    status: newStatus,
    invitation: {
      status: newStatus,
      lastRequestStatus: (profile.invitation && profile.invitation.lastRequestStatus) || 'pending',
      delivery: 'client_sdk',
      sent: false,
      preparedCount: (profile.invitation && profile.invitation.preparedCount) || 0,
      sentCount: (profile.invitation && profile.invitation.sentCount) || 0,
      recipientEmail: profile.email
    },
    message: 'Ticket de reenvío emitido para despacho nativo.'
  };
});

const ALLOWED_ERROR_CODES = Object.freeze([
  'TOO_MANY_REQUESTS',
  'NETWORK_ERROR',
  'UNAUTHORIZED_DOMAIN',
  'INVALID_RECIPIENT',
  'CLIENT_TIMEOUT',
  'NETWORK_DISCONNECTED_IN_FLIGHT',
  'UNKNOWN_CLIENT_ERROR'
]);

/**
 * Record the outcome of a client-side Firebase Auth email request (Step 6.3.2 / 6.3.4).
 * Expected data: { requestId, userId, outcome, errorCode?, dbSuffix? }
 * Zero-Trust validation:
 *  - Must be authenticated as active manager.
 *  - Ticket invitationOps/<requestId> must exist with status 'ISSUED'.
 *  - Idempotent: repeated calls on 'RECORDED' ticket return duplicate: true without mutations.
 *  - Validates ticket corresponds to userId and is within 24h TTL.
 *  - Sanitizes errorCode against whitelist.
 *  - Atomically updates ticket, user profile, and commercialAudit.
 */
exports.recordInvitationOutcomeAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can record invitation outcomes');
  data = data || {};
  const { requestId, userId, outcome, errorCode } = data;

  if (!isToken(requestId) || !isToken(userId)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid requestId or userId');
  }

  if (!['accepted', 'failed', 'unknown'].includes(outcome)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid outcome: must be accepted, failed, or unknown');
  }

  const allowedErrorSet = new Set(ALLOWED_ERROR_CODES);
  let sanitizedErrorCode = null;
  if (errorCode !== undefined && errorCode !== null && errorCode !== '') {
    if (typeof errorCode !== 'string' || !allowedErrorSet.has(errorCode)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid or unwhitelisted errorCode');
    }
    sanitizedErrorCode = errorCode;
  }

  if (outcome !== 'accepted' && !sanitizedErrorCode) {
    sanitizedErrorCode = outcome === 'unknown' ? 'CLIENT_TIMEOUT' : 'UNKNOWN_CLIENT_ERROR';
  }

  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  await assertRequesterProfileActive(names, context.auth.uid);

  return db.runTransaction(async (transaction) => {
    // 1. Validation of prior issuance by backend
    const opRef = db.collection(names.invitationOps).doc(requestId);
    const opSnap = await transaction.get(opRef);

    if (!opSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Identificador de solicitud no registrado o inexistente.');
    }

    const opData = opSnap.data() || {};

    // 2. Strict ticket ownership check (Zero-Trust SEC: context.auth.uid === ticket.requestedBy)
    // Non-repudiable: only the exact manager who issued the ticket is authorized to report its outcome.
    if (!opData.requestedBy || opData.requestedBy !== context.auth.uid) {
      throw new functions.https.HttpsError('permission-denied', 'No tienes autorización para registrar el resultado de este ticket (propiedad exclusiva del emisor).');
    }

    // 3. Idempotency control: Has ticket already been closed?
    if (opData.status === 'RECORDED') {
      return {
        recorded: true,
        duplicate: true,
        reconciled: false,
        requestId,
        userId: opData.userId,
        sentCount: opData.sentCountAtTime || 0,
        lastRequestStatus: opData.outcome
      };
    }

    // 3. User match check
    if (opData.userId !== userId) {
      throw new functions.https.HttpsError('permission-denied', 'El ticket no corresponde al usuario indicado.');
    }

    // 4. Expiration check (TTL 24h)
    if (opData.expiresAt) {
      const expiresMs = typeof opData.expiresAt.toMillis === 'function'
        ? opData.expiresAt.toMillis()
        : new Date(opData.expiresAt).getTime();
      if (expiresMs < Date.now()) {
        throw new functions.https.HttpsError('failed-precondition', 'El ticket de solicitud ha caducado (TTL superado).');
      }
    }

    // 5. Read user profile
    const userRef = db.collection(names.users).doc(userId);
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Perfil de usuario no encontrado.');
    }
    const user = userSnap.data() || {};

    const currentSentCount = (user.invitation && user.invitation.sentCount) || 0;
    const currentStatus = (user.invitation && user.invitation.lastRequestStatus) || 'pending';

    // 6. Application of rules depending on outcome
    const updates = {
      'invitation.lastRequestAt': firestoreStatics().FieldValue.serverTimestamp(),
      'invitation.updatedAt': firestoreStatics().FieldValue.serverTimestamp()
    };

    let newSentCount = currentSentCount;
    let resolvedRequestStatus = currentStatus;

    if (outcome === 'accepted') {
      newSentCount = currentSentCount + 1;
      updates['invitation.lastRequestStatus'] = 'accepted';
      updates['invitation.sentCount'] = firestoreStatics().FieldValue.increment(1);
      updates['invitation.lastAcceptedAt'] = firestoreStatics().FieldValue.serverTimestamp();
      updates['invitation.lastError'] = null;
      resolvedRequestStatus = 'accepted';
    } else if (outcome === 'failed') {
      updates['invitation.lastRequestStatus'] = 'failed';
      updates['invitation.lastError'] = sanitizedErrorCode;
      resolvedRequestStatus = 'failed';
    } else if (outcome === 'unknown') {
      // CRITICAL UNKNOWN RULE:
      // Does NOT increment sentCount.
      // Does NOT overwrite a previously confirmed 'accepted' status.
      if (currentStatus !== 'accepted') {
        updates['invitation.lastRequestStatus'] = 'unknown';
        resolvedRequestStatus = 'unknown';
      }
      updates['invitation.lastError'] = sanitizedErrorCode || 'CLIENT_TIMEOUT';
    }

    // 7. Close ticket (status = 'RECORDED')
    transaction.update(opRef, {
      status: 'RECORDED',
      outcome,
      errorCode: sanitizedErrorCode || null,
      closedBy: context.auth.uid,
      closedAt: firestoreStatics().FieldValue.serverTimestamp(),
      sentCountAtTime: newSentCount
    });

    // 8. Atomic update on user profile (invitation.status is untouched!)
    transaction.update(userRef, updates);

    // 9. Commercial audit entry
    const auditRef = db.collection(names.audit).doc();
    transaction.set(auditRef, {
      action: 'recordInvitationOutcome',
      targetType: 'user',
      targetId: userId,
      targetEmail: opData.recipientEmail,
      operation: opData.operation,
      outcome,
      errorCode: sanitizedErrorCode || null,
      requestId,
      actorUid: context.auth.uid,
      actorRole: 'manager',
      at: firestoreStatics().FieldValue.serverTimestamp(),
      atIso: new Date().toISOString()
    });

    return {
      recorded: true,
      duplicate: false,
      reconciled: outcome === 'unknown',
      requestId,
      userId,
      sentCount: newSentCount,
      lastRequestStatus: resolvedRequestStatus
    };
  });
});

/**
 * Confirm and seal user activation in Firestore (Step 6.3.2 / 6.3.4).
 * Must be called by the authenticated user after first login.
 * Atomic, idempotent, irreversible.
 */
exports.confirmUserActivation = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Debe estar autenticado.');
  }

  const authUid = context.auth.uid;
  const names = collectionNamesFor(resolveDbSuffix(data && data.dbSuffix));

  const userQuery = await db.collection(names.users)
    .where('authUid', '==', authUid)
    .limit(1)
    .get();

  if (userQuery.empty) {
    throw new functions.https.HttpsError('not-found', 'Perfil de usuario no encontrado.');
  }

  const userDoc = userQuery.docs[0];
  const userData = userDoc.data() || {};

  if (userData.activo === false) {
    throw new functions.https.HttpsError('permission-denied', 'Usuario desactivado en la plataforma.');
  }

  // GUARDA CRÍTICA DE IDEMPOTENCIA
  if (userData.invitation && userData.invitation.status === 'activated') {
    return { activated: true, alreadyActive: true };
  }

  // Transición atómica de activación
  const batch = db.batch();

  batch.update(userDoc.ref, {
    'invitation.status': 'activated',
    'invitation.activatedAt': firestoreStatics().FieldValue.serverTimestamp(),
    'invitation.updatedAt': firestoreStatics().FieldValue.serverTimestamp()
  });

  const auditRef = db.collection(names.audit).doc();
  batch.set(auditRef, {
    action: 'userActivated',
    targetType: 'user',
    targetId: userDoc.id,
    authUid: authUid,
    email: userData.email,
    role: userData.role,
    at: firestoreStatics().FieldValue.serverTimestamp(),
    atIso: new Date().toISOString()
  });

  await batch.commit();

  return { activated: true, newlyActivated: true };
});

// Export a helper for external reconciliation (optional).
exports.reconcileUserOp = functions.https.onCall(async (data, context) => {
  // Only managers can invoke.
  await assertManager(context, 'Only managers can reconcile');
  data = data || {};
  const { opId } = data;
  if (!isToken(opId)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid opId');
  }
  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const requester = await assertRequesterProfileActive(names, context.auth.uid, { allowUnlinked: true });
  const opSnap = await db.collection(names.ops).doc(opId).get();
  if (!opSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Operation not found');
  }
  const opData = opSnap.data() || {};
  // If the manager account does not have a linked CRM profile (e.g. during provisioning recovery),
  // strictly restrict access to operations initiated by or targeting their own account.
  if (!requester) {
    const callerUid = context.auth.uid;
    const actorUid = opData.actor && (typeof opData.actor === 'string' ? opData.actor : (opData.actor.uid || null));
    const reqUid = opData.requesterUid || null;

    let isOwner = false;
    // Reject contradictory ownership attribution if both fields are present but do not match
    if (reqUid && actorUid && reqUid !== actorUid) {
      isOwner = false;
    } else {
      const ownerUid = reqUid || actorUid;
      isOwner = Boolean(ownerUid && ownerUid === callerUid);
    }

    const isTarget = Boolean(
      (opData.result && opData.result.uid === callerUid) ||
      (opData.uid && opData.uid === callerUid)
    );

    if (!isOwner && !isTarget) {
      throw new functions.https.HttpsError('permission-denied', 'Unlinked managers can only reconcile operations initiated by or targeting their own account');
    }
  }
  return opData;
});

/**
 * Link an existing historical CRM user (vendedor or gestor) to Firebase Authentication.
 * Expected data: { id, opId, dbSuffix? }
 *  - `id` is the CRM commercial id (document key in `users<suffix>`).
 *  - Only managers can invoke this function (assertManager).
 *  - Manager accounts CANNOT be linked here (must use authorized out-of-band procedure).
 *  - Inactive profiles cannot be linked (failed-precondition).
 *  - Checks if an Auth account with profile.email exists:
 *      * If it exists, checks if its UID is linked to a DIFFERENT CRM profile (already-exists).
 *      * If not linked to any other profile, reuses that UID.
 *      * If it does not exist, creates the Auth account with createUser({ email, displayName }).
 *  - Assigns custom claims { role: profile.role, cid: id }.
 *  - In a Firestore transaction, links profile.authUid = uid, authProvider = 'firebase'.
 *  - If Auth account was newly created in this request and subsequent steps fail, rolls back by deleting the Auth user.
 *  - Historical password is NOT deleted here: requirement 6 mandates deleting only after verified login.
 *  - Logs audit entry in commercialAudit.
 */
exports.linkHistoricalUserAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can link historical users');
  data = data || {};
  const { id, opId } = data;
  if (!isToken(id) || !isToken(opId)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid id or opId');
  }
  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const requester = await assertRequesterProfileActive(names, context.auth.uid);
  const requesterActor = { uid: context.auth.uid, cid: requester && requester.id, name: requester && requester.nombre, role: requester && requester.role };

  const opRef = db.collection(names.ops).doc(opId);
  const opSnap = await opRef.get();
  if (opSnap.exists) {
    const prev = opSnap.data() || {};
    if (prev.requesterUid !== context.auth.uid || prev.action !== 'linkHistoricalUser' || prev.profileId !== id) {
      throw new functions.https.HttpsError('already-exists', 'Operation key reused with different payload');
    }
    if (prev.status === OP_STATUS.SUCCEEDED) {
      return prev.result || { id, message: 'operation already completed' };
    }
    if (prev.status === OP_STATUS.MANUAL_REVIEW) {
      throw new functions.https.HttpsError('failed-precondition', `Manual review required for operation ${opId}`);
    }
  }
  await logOperation(names, opId, {
    status: OP_STATUS.PENDING, action: 'linkHistoricalUser', requesterUid: context.auth.uid, profileId: id
  });

  const userDocRef = db.collection(names.users).doc(id);
  const userSnap = await userDocRef.get();
  if (!userSnap.exists) {
    await logOperation(names, opId, { status: OP_STATUS.CONFLICT, message: 'User profile not found' });
    throw new functions.https.HttpsError('not-found', 'User profile does not exist');
  }
  const profile = userSnap.data() || {};

  if (profile.activo !== true) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Profile is inactive' });
    throw new functions.https.HttpsError('failed-precondition', 'Cannot link an inactive profile; activate it first if intended');
  }

  if (profile.role === 'manager') {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Manager profile cannot be linked here' });
    throw new functions.https.HttpsError('permission-denied', 'Manager accounts must be linked via the authorized administrative procedure');
  }

  if (!['vendedor', 'gestor'].includes(profile.role)) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Invalid profile role' });
    throw new functions.https.HttpsError('invalid-argument', 'Invalid profile role for commercial linking');
  }

  const email = String(profile.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Invalid email in profile' });
    throw new functions.https.HttpsError('failed-precondition', 'Profile does not have a valid email for linking');
  }

  if (profile.authUid) {
    try {
      const existing = await admin.auth().getUser(profile.authUid);
      const res = { status: 'already-linked', id, uid: existing.uid, email: profile.email, role: profile.role };
      await logOperation(names, opId, { status: OP_STATUS.SUCCEEDED, message: 'Profile already linked', result: res });
      return res;
    } catch (e) {
      if (e && e.code !== 'auth/user-not-found') {
        throw new functions.https.HttpsError('internal', 'Error reading linked Auth account');
      }
    }
  }

  let targetAuth = null;
  try {
    targetAuth = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e && e.code !== 'auth/user-not-found') {
      await logOperation(names, opId, { status: OP_STATUS.ERROR, message: e.message });
      throw new functions.https.HttpsError('internal', 'Error checking Auth accounts');
    }
  }

  let authUid = null;
  let createdThisOp = false;

  if (targetAuth) {
    const otherUsersSnap = await db.collection(names.users).where('authUid', '==', targetAuth.uid).get();
    if (!otherUsersSnap.empty && otherUsersSnap.docs.some(d => d.id !== id)) {
      await logOperation(names, opId, { status: OP_STATUS.CONFLICT, message: 'Auth account linked to another profile' });
      throw new functions.https.HttpsError('already-exists', 'The Auth account for this email is already linked to another CRM profile');
    }
    authUid = targetAuth.uid;
  } else {
    try {
      const created = await admin.auth().createUser({ email, displayName: profile.nombre || '' });
      authUid = created.uid;
      createdThisOp = true;
    } catch (e) {
      if (e && e.code === 'auth/email-already-exists') {
        throw new functions.https.HttpsError('already-exists', 'Auth account already exists for this email');
      }
      await logOperation(names, opId, { status: OP_STATUS.ERROR, message: e.message });
      throw new functions.https.HttpsError('internal', 'Failed to create Auth account');
    }
  }

  try {
    await admin.auth().setCustomUserClaims(authUid, { role: profile.role, cid: id });
  } catch (claimsErr) {
    if (createdThisOp) {
      try { await admin.auth().deleteUser(authUid); } catch (_) {}
    }
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Failed to set custom claims' });
    throw new functions.https.HttpsError('internal', 'Failed to assign custom claims');
  }

  try {
    await db.runTransaction(async tx => {
      const cur = await tx.get(userDocRef);
      const c = cur.exists ? (cur.data() || {}) : null;
      if (!c || c.activo !== true) {
        throw new Error('Profile changed or became inactive concurrently');
      }
      if (c.authUid && c.authUid !== authUid) {
        throw new Error('Profile linked concurrently to another account');
      }
      tx.update(userDocRef, {
        authUid,
        authProvider: 'firebase'
      });
      tx.create(db.collection(names.audit).doc(), userAuditEntry(requesterActor, 'linkHistoricalUser', id, {
        opId, uid: authUid, email, role: profile.role, cid: id
      }));
    });
  } catch (txErr) {
    if (createdThisOp) {
      try { await admin.auth().deleteUser(authUid); } catch (_) {}
    }
    await logOperation(names, opId, { status: OP_STATUS.ERROR, message: 'Profile transaction failed: ' + txErr.message });
    throw new functions.https.HttpsError('internal', 'Failed to update Firestore profile: ' + txErr.message);
  }

  const result = { status: 'linked', id, uid: authUid, email, role: profile.role };
  await logOperation(names, opId, { status: OP_STATUS.SUCCEEDED, message: 'User linked', result });
  return result;
});

/**
 * Permanently purge the legacy plaintext password from a linked CRM profile.
 * Requirement 6: "Elimina las contraseñas históricas en texto plano únicamente después de comprobar que la cuenta correcta está vinculada y que el inicio de sesión funciona."
 * Expected data: { id, dbSuffix? }
 *  - May be called by:
 *      (a) the linked user themselves (context.auth.uid === profile.authUid) -> proves active authenticated session!
 *      (b) a live manager -> in this case, authUser.metadata.lastSignInTime must be non-empty (proves prior successful login).
 *  - Deletes profile.password using FieldValue.delete().
 *  - Writes audit record to commercialAudit.
 */
exports.purgeHistoricalPasswordAdmin = functions.https.onCall(async (data, context) => {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    const problems = emulatorIsolationProblems(process.env);
    if (problems.length > 0) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Emulator isolation check failed (${problems.join('; ')}). Refusing to run: it could reach production.`
      );
    }
  }
  if (!context || !context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  data = data || {};
  const { id } = data;
  if (!isToken(id)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid id');
  }
  const names = collectionNamesFor(resolveDbSuffix(data.dbSuffix));
  const userDocRef = db.collection(names.users).doc(id);
  const userSnap = await userDocRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'User profile does not exist');
  }
  const profile = userSnap.data() || {};
  if (!profile.authUid) {
    throw new functions.https.HttpsError('failed-precondition', 'Profile is not linked to Firebase Auth');
  }

  const isSelf = context.auth.uid === profile.authUid;
  let isManager = false;
  let managerProfile = null;
  if (!isSelf) {
    isManager = await liveManagerCheck(context.auth.uid);
    if (!isManager) {
      throw new functions.https.HttpsError('permission-denied', 'Only managers or the linked user themselves can purge the password');
    }
    managerProfile = await assertRequesterProfileActive(names, context.auth.uid);
  }

  let authUser;
  try {
    authUser = await admin.auth().getUser(profile.authUid);
  } catch (e) {
    throw new functions.https.HttpsError('internal', 'Could not read linked Auth account');
  }
  if (authUser.disabled === true) {
    throw new functions.https.HttpsError('permission-denied', 'Auth account is disabled');
  }

  if (isManager && !isSelf) {
    const lastLogin = authUser.metadata && authUser.metadata.lastSignInTime;
    if (!lastLogin) {
      throw new functions.https.HttpsError('failed-precondition', 'Cannot purge password before verified login: user has not signed in yet');
    }
  }

  if (profile.password === undefined || profile.password === null) {
    return { status: 'already-purged', id };
  }

  const statics = firestoreStatics();
  const deleteField = statics.FieldValue.delete();

  await userDocRef.update({ password: deleteField });

  const actor = {
    uid: context.auth.uid,
    cid: (context.auth.token && context.auth.token.cid) || (isSelf ? id : (managerProfile ? managerProfile.id : null)),
    name: isSelf ? (profile.nombre || '') : (managerProfile ? managerProfile.nombre : 'Manager'),
    role: isSelf ? profile.role : 'manager'
  };

  try {
    await db.collection(names.audit).add(userAuditEntry(actor, 'purgeHistoricalPassword', id, {
      uid: profile.authUid,
      email: profile.email
    }));
  } catch (_) { /* non-blocking audit logging */ }

  return { status: 'purged', id };
});

/**
 * Lists users for administrative management (SEC-03).
 * Verifies caller has manager session and an active profile.
 * Projects ONLY safe administrative fields: id, nombre, email, role, activo, authUid.
 * Specifically and strictly NEVER returns or exposes `password`.
 */
exports.listUsersAdmin = functions.https.onCall(async (data, context) => {
  await assertManager(context, 'Only managers can list admin user details');
  data = data || {};
  const dbSuffix = resolveDbSuffix(data.dbSuffix);
  const names = collectionNamesFor(dbSuffix);
  await assertRequesterProfileActive(names, context.auth.uid);

  const snap = await db.collection(names.users).get();
  const projected = snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      id: doc.id,
      nombre: d.nombre || '',
      email: d.email || '',
      role: d.role || 'vendedor',
      activo: d.activo !== false,
      authUid: d.authUid || null
    };
  });

  return { users: projected };
});

// ======================================================================================================
// Client catalogue (duplicate-safe creation / edition, catalogue search, derived portfolio `visibleTo`).
// Logic lives in clientsService.js (injected db, unit/emulator tested); this file only authenticates the
// request, maps errors and exports the entry points. The browser cannot write `clients<suffix>` nor the
// identifier index (firestore.rules): these callables are the ONLY way to create a client.
// ======================================================================================================
const { createClientsService, ServiceError } = require('./clientsService');

const clientServiceCache = {};
function clientsServiceFor(suffix) {
  if (!clientServiceCache[suffix]) {
    clientServiceCache[suffix] = createClientsService({
      db,
      FieldValue: firestoreStatics().FieldValue,
      suffix,
      cacheTtlMs: process.env.FUNCTIONS_EMULATOR === 'true' ? 0 : 30000
    });
  }
  return clientServiceCache[suffix];
}

function toHttpsError(e) {
  if (e instanceof ServiceError || (e && e.name === 'ServiceError' && e.code)) return new functions.https.HttpsError(e.code, e.message);
  if (e && e.constructor && e.constructor.name === 'HttpsError') return e;
  console.error('clients service failure:', e && e.message);
  return new functions.https.HttpsError('internal', 'Internal error');
}

// Same guard as assertManager: under the Functions emulator both Auth and Firestore emulators must be loopback.
function assertEmulatorIsolated() {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return;
  const problems = emulatorIsolationProblems(process.env);
  if (problems.length > 0) {
    throw new functions.https.HttpsError('failed-precondition', `Emulator isolation check failed (${problems.join('; ')}). Refusing to run: it could reach production.`);
  }
}

async function runClientOp(data, context, op) {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const service = clientsServiceFor(resolveDbSuffix(data.dbSuffix));
    const caller = await service.resolveCaller(context);
    return await op(service, caller, data);
  } catch (e) {
    throw toHttpsError(e);
  }
}

/** { client, opId, confirmReview?, dryRun?, dbSuffix? } -> { status: created | duplicate | needs-review | ok, ... } */
exports.createClientAdmin = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.create({ caller, client: d.client, opId: d.opId, confirmReview: d.confirmReview === true, dryRun: d.dryRun === true })));

/** { client, confirmReview?, dbSuffix? } -> { status: reserved | duplicate | needs-review, reservationId, clientId, expiresAt, ... } */
exports.reserveClientCreationAdmin = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.reserveCreation({ caller, client: d.client, confirmReview: d.confirmReview === true })));

/** { reservationId, client, opId, confirmReview?, dbSuffix? } -> { status: created | duplicate | needs-review, client, ... } */
exports.finalizeClientCreationAdmin = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.finalizeCreation({ caller, reservationId: d.reservationId, client: d.client, opId: d.opId, confirmReview: d.confirmReview === true })));

/** { reservationId, dbSuffix? } -> { status: cancelled, reservationId } */
exports.cancelClientReservationAdmin = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.cancelReservation({ caller, reservationId: d.reservationId })));

/** { id, client, confirmReview?, dryRun?, dbSuffix? } -> { status: updated | duplicate | needs-review | ok, ... } */
exports.updateClientAdmin = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.update({ caller, id: d.id, client: d.client, confirmReview: d.confirmReview === true, dryRun: d.dryRun === true })));

/** { q, limit?, dbSuffix? } -> { results: [{ id, nombre, tipo, hint, inPortfolio }], tooShort, truncated } (selector of new opportunities) */
exports.searchClientsCatalog = functions.https.onCall((data, context) => runClientOp(data, context,
  (service, caller, d) => service.search({ caller, q: typeof d.q === 'string' ? d.q.slice(0, 100) : '', limit: d.limit })));

// ======================================================================================================
// Commercial operations (opportunities, activity log, reassignment, no-contract authorisation, settings,
// client deletion). Logic in commercialService.js (injected db, unit tested with an in-memory Firestore and
// reusable against the emulator). The caller is ALWAYS resolved from the session + CRM profile through the
// same resolveCaller used by the client catalogue: nothing about who is acting is read from the request.
// Manager-only operations additionally verify the Auth account LIVE (claim + not disabled).
// ======================================================================================================
const { createCommercialService } = require('./commercialService');

/** Live check used by manager-only operations: the verified `manager` claim on an enabled Auth account. */
async function liveManagerCheck(uid) {
  try {
    const rec = await admin.auth().getUser(uid);
    return (rec.customClaims || {}).manager === true && rec.disabled !== true;
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') return false;
    throw e; // any other failure is NOT a "no": it surfaces as internal, never as an implicit grant
  }
}

const commercialServiceCache = {};
function commercialServiceFor(suffix) {
  if (!commercialServiceCache[suffix]) {
    commercialServiceCache[suffix] = createCommercialService({ db, FieldValue: firestoreStatics().FieldValue, suffix, verifyManager: liveManagerCheck });
  }
  return commercialServiceCache[suffix];
}

async function runCommercialOp(data, context, op) {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const suffix = resolveDbSuffix(data.dbSuffix);
    const caller = await clientsServiceFor(suffix).resolveCaller(context);
    return await op(commercialServiceFor(suffix), caller, data);
  } catch (e) {
    throw toHttpsError(e);
  }
}

/** { prospect: { clientId, proyecto, origen, tipo_proyecto, tipo_producto, vendedorId? }, opId, dbSuffix? } -> { status: 'created', prospect } */
exports.createProspectAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.createProspect({ caller, data: d.prospect, opId: d.opId })));

/** { prospectId, text, opId, dbSuffix? } -> { status: 'added' } */
exports.addProspectLogAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.addLog({ caller, prospectId: d.prospectId, text: d.text, opId: d.opId })));

/** { prospectId, date, text, dbSuffix? } -> { status: 'deleted' | 'absent' } (manual notes only) */
exports.deleteProspectLogAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.deleteLog({ caller, prospectId: d.prospectId, date: d.date, text: d.text })));

/** { prospectId, followUp, opId, dbSuffix? } -> { status: 'recorded', seguimiento } */
exports.recordProspectFollowUpAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.recordFollowUp({ caller, prospectId: d.prospectId, data: d.followUp, opId: d.opId })));

/** { prospectId, tipoCadencia, motivo, opId, dbSuffix? } -> { status: 'updated' | 'unchanged', tipoCadencia, cadencia, seguimiento } */
exports.updateProspectCadenceAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.updateProspectCadence({
    caller,
    prospectId: d.prospectId,
    tipoCadencia: d.tipoCadencia,
    motivo: d.motivo,
    opId: d.opId
  })));

/** { prospectId, clasificacion, motivo, opId, dbSuffix? } -> { status: 'reclassified' | 'unchanged', clasificacion, historial_clasificacion } */
exports.reclassifyProspectAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.reclassifyProspect({
    caller,
    prospectId: d.prospectId,
    clasificacion: d.clasificacion,
    motivo: d.motivo,
    opId: d.opId
  })));

/** { prospectId, decision: 'ordenar_cierre' | 'autorizar_continuar', motivo?, justificacion?, proximaAccion?, ejecutarCierre?, opId, dbSuffix? } -> { status: 'resolved', decision, seguimiento, estado } (manager only) */
exports.resolveProspectEscalationAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.resolveFollowUpEscalation({
    caller,
    prospectId: d.prospectId,
    decision: d.decision,
    motivo: d.motivo,
    justificacion: d.justificacion,
    proximaAccion: d.proximaAccion,
    ejecutarCierre: d.ejecutarCierre,
    opId: d.opId
  })));

/** { prospectId, gestionId, motivo, opId, dbSuffix? } -> { status: 'voided' | 'already_voided', seguimiento, logEntry } (manager only) */
exports.voidProspectFollowUpAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.voidFollowUp({
    caller,
    prospectId: d.prospectId,
    gestionId: d.gestionId,
    motivo: d.motivo,
    opId: d.opId
  })));

/** { prospectId, vendedorId, dbSuffix? } -> { status: 'reassigned' | 'unchanged' } (manager / gestor) */
exports.reassignProspectAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.reassign({ caller, prospectId: d.prospectId, vendedorId: d.vendedorId })));

/** { prospectId, authorized, dbSuffix? } -> { status: 'updated' | 'unchanged' } (manager only) */
exports.setNoContractAuthorizationAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.setNoContractAuthorization({ caller, prospectId: d.prospectId, authorized: d.authorized })));

/** { prospectId, motivo, opId, dbSuffix? } -> { status: 'requested' | 'unchanged', request } (vendedor / gestor with access; never sends authorization fields) */
exports.requestNoContractAuthorizationAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.requestNoContractAuthorization({ caller, prospectId: d.prospectId, motivo: d.motivo, opId: d.opId })));

/** { prospectId, requestId, decision: 'approve' | 'reject', motivoDecision?, dbSuffix? } -> { status: 'approved' | 'rejected' | 'unchanged', request } (manager only, live check) */
exports.resolveNoContractAuthorizationAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.resolveNoContractAuthorization({ caller, prospectId: d.prospectId, requestId: d.requestId, decision: d.decision, motivoDecision: d.motivoDecision })));

/** { action: 'addItem' | 'removeItem' | 'setFactoryAddress', list?, value, dbSuffix? } -> { status, settings } (manager only) */
exports.updateSettingsAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.updateSettings({ caller, action: d.action, list: d.list, value: d.value })));

/** { clientId, dbSuffix? } -> { status: 'deleted' | 'absent' } (manager only; refused while the client has opportunities) */
exports.deleteClientAdmin = functions.https.onCall((data, context) => runCommercialOp(data, context,
  (service, caller, d) => service.deleteClient({ caller, clientId: d.clientId })));

// ======================================================================================================
// Tablet (plant) login: the PIN / numeric password are checked HERE and a Firebase Auth custom token with plant claims is
// returned, so operador.html can use Firestore directly under rules. No e-mail accounts, no profile writes, no commercial rights
// (uid `plant_<cid>` never equals a CRM profile's authUid). Logic and limits: plantAuthService.js, PLANT_AUTH.md.
// ======================================================================================================
const { createPlantAuthService } = require('./plantAuthService');
const plantAuthCache = {};
function plantAuthFor(suffix) {
  if (!plantAuthCache[suffix]) {
    plantAuthCache[suffix] = createPlantAuthService({ db, auth: admin.auth(), FieldValue: firestoreStatics().FieldValue, suffix });
  }
  return plantAuthCache[suffix];
}
/** { identifier: PIN | name | e-mail as typed today, password: digits, dbSuffix? } -> { token, profile: { id, nombre, role, stations, also_does_dispatch } } (never PIN / password) */
exports.plantLogin = functions.https.onCall(async (data, context) => {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const suffix = resolveDbSuffix(data.dbSuffix);
    const ip = context && context.rawRequest && context.rawRequest.ip ? String(context.rawRequest.ip) : '';
    return await plantAuthFor(suffix).login({ identifier: data.identifier, password: data.password, ip });
  } catch (e) {
    throw toHttpsError(e);
  }
});

// ======================================================================================================
// Opportunity workflow (stage, loss, proposal / price, change orders, invoices, payments, deletion).
// Logic in prospectWorkflowService.js; it shares the identity / access / audit kit of the commercial service.
// The browser sends only the user's input: never the document, never who acts, never computed amounts.
// ======================================================================================================
const { createProspectWorkflowService } = require('./prospectWorkflowService');
const workflowServiceCache = {};
function workflowServiceFor(suffix) {
  if (!workflowServiceCache[suffix]) {
    // Download links must come from Firebase Storage. Loopback links (the Storage emulator) are accepted ONLY when this
    // process is the Functions emulator, which assertEmulatorIsolated() has already proven is wired to loopback emulators.
    const fileUrlPrefixes = ['https://firebasestorage.googleapis.com/v0/b/'];
    if (process.env.FUNCTIONS_EMULATOR === 'true') fileUrlPrefixes.push('http://127.0.0.1:', 'http://localhost:');
    workflowServiceCache[suffix] = createProspectWorkflowService({ db, FieldValue: firestoreStatics().FieldValue, kit: commercialServiceFor(suffix).kit, fileUrlPrefixes });
  }
  return workflowServiceCache[suffix];
}
const runWorkflowOp = (data, context, op) => runCommercialOp(data, context,
  (service, caller, d) => op(workflowServiceFor(resolveDbSuffix(d.dbSuffix)), caller, d));

/** { prospectId, nextStage, data, dbSuffix? } -> { status: 'advanced' | 'unchanged', etapa, estado } */
exports.advanceProspectStageAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.advanceStage({ caller, prospectId: d.prospectId, nextStage: d.nextStage, data: d.data })));

/** { prospectId, currentStage, targetStage, motivo, opId, dbSuffix? } -> { status: 'reverted', replay: boolean, prospectId, etapa, previousStage, version } */
exports.revertProspectStageAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.revertStage({ caller, prospectId: d.prospectId, currentStage: d.currentStage, targetStage: d.targetStage, motivo: d.motivo, opId: d.opId })));

/** { prospectId, data, dbSuffix? } -> { status: 'saved', prospectId } */
exports.saveClosingDocumentsAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.saveClosingDocuments({ caller, prospectId: d.prospectId, data: d.data })));

/** { prospectId, data, opId?, dbSuffix? } -> { status: 'finalized' | 'already_finalized', etapa: 'cierre', estado: 'ganado', facturaAnticipo, montoAnticipo } */
exports.finalizeProspectAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.finalizeProspect({ caller, prospectId: d.prospectId, data: d.data, opId: d.opId })));

/** { prospectId, reason, dbSuffix? } -> { status: 'lost' | 'unchanged' } */
exports.markProspectLostAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.markLost({ caller, prospectId: d.prospectId, reason: d.reason })));

/** { prospectId, costo_venta, precio_cotizado, doc_oferta[], doc_costos[], dbSuffix? } -> { status: 'registered' | 'unchanged' } */
exports.registerProposalAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.registerProposal({ caller, prospectId: d.prospectId, costo_venta: d.costo_venta, precio_cotizado: d.precio_cotizado, doc_oferta: d.doc_oferta, doc_costos: d.doc_costos })));

/** { prospectId, precio, costo, motivo, expectedOldPrice?, expectedOldCost?, dbSuffix? } -> { status: 'updated' | 'unchanged' } */
exports.editProspectBasePriceAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.editBasePrice({ caller, prospectId: d.prospectId, precio: d.precio, costo: d.costo, motivo: d.motivo, expectedOldPrice: d.expectedOldPrice, expectedOldCost: d.expectedOldCost })));

/** { prospectId, orderId?, tipo, desc, precio, costo, doc_oferta?, doc_costos?, opId, dbSuffix? } -> { status: 'created' | 'updated' | 'unchanged' } */
exports.saveChangeOrderAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.saveChangeOrder({ caller, prospectId: d.prospectId, orderId: d.orderId, tipo: d.tipo, desc: d.desc, precio: d.precio, costo: d.costo, doc_oferta: d.doc_oferta, doc_costos: d.doc_costos, opId: d.opId })));

/** { prospectId, orderId, dbSuffix? } -> { status: 'deleted' | 'absent' } */
exports.deleteChangeOrderAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.deleteChangeOrder({ caller, prospectId: d.prospectId, orderId: d.orderId })));

/** { prospectId, invoiceId?, numero, monto, doc_factura?, opId, dbSuffix? } -> { status: 'created' | 'updated' | 'unchanged' } */
exports.saveInvoiceAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.saveInvoice({ caller, prospectId: d.prospectId, invoiceId: d.invoiceId, numero: d.numero, monto: d.monto, doc_factura: d.doc_factura, opId: d.opId })));

/** { prospectId, invoiceId, dbSuffix? } -> { status: 'deleted' | 'absent' } */
exports.deleteInvoiceAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.deleteInvoice({ caller, prospectId: d.prospectId, invoiceId: d.invoiceId })));

/** { prospectId, invoiceId, paymentKey?, monto, metodo, ref, doc_comprobante?, opId, dbSuffix? } -> { status: 'created' | 'updated' | 'unchanged' } */
exports.savePaymentAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.savePayment({ caller, prospectId: d.prospectId, invoiceId: d.invoiceId, paymentKey: d.paymentKey, monto: d.monto, metodo: d.metodo, ref: d.ref, doc_comprobante: d.doc_comprobante, opId: d.opId })));

/** { prospectId, invoiceId, paymentKey, dbSuffix? } -> { status: 'deleted' | 'absent' } */
exports.deletePaymentAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.deletePayment({ caller, prospectId: d.prospectId, invoiceId: d.invoiceId, paymentKey: d.paymentKey })));

/** { prospectId, motivo, dbSuffix? } -> { status: 'deleted' | 'unchanged' | 'absent' } (manager only, live check; LOGICAL deletion, the motive is required) */
exports.deleteProspectAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.deleteProspect({ caller, prospectId: d.prospectId, motivo: d.motivo })));

/** { prospectId, motivo, dbSuffix? } -> { status: 'reactivated' | 'unchanged', estado, etapa, motivo_reactivacion } (manager only, live check) */
exports.reactivateLostProspectAdmin = functions.https.onCall((data, context) => runWorkflowOp(data, context,
  (wf, caller, d) => wf.reactivateProspect({ caller, prospectId: d.prospectId, motivo: d.motivo })));

// ======================================================================================================
// SEC-05: Secure Document Download (Universal Downloads & Large File Streaming)
// ======================================================================================================
const { createStorageService } = require('./storageService');
const storageServiceCache = {};
function storageServiceFor(suffix) {
  if (!storageServiceCache[suffix]) {
    const bucket = admin.storage().bucket();
    storageServiceCache[suffix] = createStorageService({ db, bucket, suffix });
  }
  return storageServiceCache[suffix];
}

/** { storagePath, fileName?, prospectId?, clientId?, expiresInSeconds?, dbSuffix? } -> { signedUrl, storagePath, fileName, size, contentType, expiresAt } */
exports.getSecureDownloadUrlAdmin = functions
  .runWith({
    serviceAccount: 'crm-downloads-sa@ductsal-erp.iam.gserviceaccount.com'
  })
  .https.onCall(async (data, context) => {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const suffix = resolveDbSuffix(data.dbSuffix);
    const caller = await clientsServiceFor(suffix).resolveCaller(context);
    const service = storageServiceFor(suffix);
    return await service.getSecureDownloadUrl({
      caller,
      storagePath: data.storagePath,
      fileName: data.fileName,
      prospectId: data.prospectId,
      clientId: data.clientId,
      expiresInSeconds: data.expiresInSeconds || 900,
      disposition: (data.disposition === 'inline' || data.disposition === 'attachment') ? data.disposition : 'attachment'
    });
  } catch (e) {
    throw toHttpsError(e);
  }
});

// ======================================================================================================
// Contacts operations (persons, account-contact relations, periods history - Phase 2 Block 1)
// ======================================================================================================
const { createContactsService } = require('./contactsService');

const contactsServiceCache = {};
function contactsServiceFor(suffix) {
  if (!contactsServiceCache[suffix]) {
    contactsServiceCache[suffix] = createContactsService({
      db,
      FieldValue: firestoreStatics().FieldValue,
      suffix
    });
  }
  return contactsServiceCache[suffix];
}

async function runContactOp(data, context, op) {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const suffix = resolveDbSuffix(data.dbSuffix);
    const service = contactsServiceFor(suffix);
    const caller = await service.resolveCaller(context);
    return await op(service, caller, data);
  } catch (e) {
    throw toHttpsError(e);
  }
}

/** { contact, opId?, dbSuffix? } -> { status: created, contact } */
exports.createContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.createContact({ caller, contact: d.contact, opId: d.opId })));

/** { contactId, contact, dbSuffix? } -> { status: updated, contact } */
exports.updateContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.updateContact({ caller, contactId: d.contactId, contact: d.contact })));

/** { contactId, dbSuffix? } -> { contact } */
exports.getContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.getContact({ caller, contactId: d.contactId })));

/** { q, limit?, dbSuffix? } -> { results: [...] } */
exports.searchContactsAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.searchContacts({ caller, q: d.q, limit: d.limit })));

/** { accountId, contactId, cargo, telefono_corporativo?, extension?, correo_corporativo?, opId?, dbSuffix? } -> { status: linked|reactivated, accountContact, period, persona } */
exports.linkContactToAccountAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.linkContactToAccount({
    caller,
    accountId: d.accountId,
    contactId: d.contactId,
    cargo: d.cargo,
    telefono_corporativo: d.telefono_corporativo,
    extension: d.extension,
    correo_corporativo: d.correo_corporativo
  })));

/** { accountContactId, cargo?, telefono_corporativo?, extension?, correo_corporativo?, dbSuffix? } -> { status: updated, accountContact } */
exports.updateAccountContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.updateAccountContact({
    caller,
    accountContactId: d.accountContactId,
    cargo: d.cargo,
    telefono_corporativo: d.telefono_corporativo,
    extension: d.extension,
    correo_corporativo: d.correo_corporativo
  })));

/** { accountContactId, motivo_salida?, dbSuffix? } -> { status: deactivated|unchanged, accountContact } */
exports.deactivateAccountContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.deactivateAccountContact({
    caller,
    accountContactId: d.accountContactId,
    motivo_salida: d.motivo_salida
  })));

/** { accountContactId, cargo, motivo_reingreso?, telefono_corporativo?, extension?, correo_corporativo?, dbSuffix? } -> { status: reactivated, accountContact, period } */
exports.reactivateAccountContactAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.reactivateAccountContact({
    caller,
    accountContactId: d.accountContactId,
    cargo: d.cargo,
    motivo_reingreso: d.motivo_reingreso,
    telefono_corporativo: d.telefono_corporativo,
    extension: d.extension,
    correo_corporativo: d.correo_corporativo
  })));

/** { accountId, includeInactive?, dbSuffix? } -> { contacts: [...] } */
exports.listAccountContactsAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.listAccountContacts({
    caller,
    accountId: d.accountId,
    includeInactive: d.includeInactive !== false
  })));

/** { accountContactId, dbSuffix? } -> { accountContactId, accountId, contactId, periods: [...] } */
exports.listContactPeriodsAdmin = functions.https.onCall((data, context) => runContactOp(data, context,
  (service, caller, d) => service.listContactPeriods({
    caller,
    accountContactId: d.accountContactId
  })));

// ======================================================================================================
// Opportunity Contacts & Roles operations (Phase 2 Block 2)
// ======================================================================================================
const { createOpportunityContactsService } = require('./opportunityContactsService');

const opportunityContactsServiceCache = {};
function opportunityContactsServiceFor(suffix) {
  if (!opportunityContactsServiceCache[suffix]) {
    opportunityContactsServiceCache[suffix] = createOpportunityContactsService({
      db,
      FieldValue: firestoreStatics().FieldValue,
      suffix,
      verifyManager: liveManagerCheck
    });
  }
  return opportunityContactsServiceCache[suffix];
}

async function runOpportunityContactOp(data, context, op) {
  try {
    assertEmulatorIsolated();
    data = data || {};
    const suffix = resolveDbSuffix(data.dbSuffix);
    const service = opportunityContactsServiceFor(suffix);
    const caller = await service.resolveCaller(context);
    return await op(service, caller, data);
  } catch (e) {
    throw toHttpsError(e);
  }
}

/** { includeInactive?, dbSuffix? } -> { roles: [...] } */
exports.listOpportunityContactRolesAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.listOpportunityContactRoles({ caller, includeInactive: d.includeInactive === true })));

/** { roleId?, name?, activo?, orden?, action?, dbSuffix? } -> { status, role } */
exports.manageOpportunityContactRoleAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.manageOpportunityContactRole({
    caller,
    roleId: d.roleId,
    name: d.name,
    activo: d.activo,
    orden: d.orden,
    action: d.action
  })));

/** { opportunityId, accountContactId, roleId, notes?, isPrimary?, dbSuffix? } -> { status: created, participant } */
exports.addOpportunityContactAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.addOpportunityContact({
    caller,
    opportunityId: d.opportunityId,
    accountContactId: d.accountContactId,
    roleId: d.roleId,
    notes: d.notes,
    isPrimary: d.isPrimary === true
  })));

/** { opportunityContactId, roleId?, notes?, dbSuffix? } -> { status: updated, participant } */
exports.updateOpportunityContactRoleAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.updateOpportunityContactRole({
    caller,
    opportunityContactId: d.opportunityContactId,
    roleId: d.roleId,
    notes: d.notes
  })));

/** { opportunityId, opportunityContactId, expectedVersion?, dbSuffix? } -> { status: updated, primaryOpportunityContactId, version } */
exports.setOpportunityPrimaryContactAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.setOpportunityPrimaryContact({
    caller,
    opportunityId: d.opportunityId,
    opportunityContactId: d.opportunityContactId,
    expectedVersion: d.expectedVersion
  })));

/** { opportunityContactId, motivo?, dbSuffix? } -> { status: deactivated, opportunityContactId, clearedPrimary } */
exports.removeOpportunityContactAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.removeOpportunityContact({
    caller,
    opportunityContactId: d.opportunityContactId,
    motivo: d.motivo
  })));

/** { opportunityId, includeInactive?, dbSuffix? } -> { contacts: [...], primaryOpportunityContactId } */
exports.listOpportunityContactsAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.listOpportunityContacts({
    caller,
    opportunityId: d.opportunityId,
    includeInactive: d.includeInactive === true
  })));

/** { opportunityId, newAccountId, motivo?, dbSuffix? } -> { status: updated, opportunityId, newAccountId, version } */
exports.changeOpportunityAccountAdmin = functions.https.onCall((data, context) => runOpportunityContactOp(data, context,
  (service, caller, d) => service.changeOpportunityAccount({
    caller,
    opportunityId: d.opportunityId,
    newAccountId: d.newAccountId,
    motivo: d.motivo
  })));

// Keeps clients.visibleTo (portfolio of the sellers) in step with the opportunities. Guarded: the unit-test
// fakes of firebase-functions only implement https.onCall.
if (functions.firestore && typeof functions.firestore.document === 'function') {
  for (const suffix of ALLOWED_DB_SUFFIXES) {
    exports[`syncClientVisibility${suffix}`] = functions.firestore.document(`prospects${suffix}/{prospectId}`).onWrite(async (change) => {
      const before = change.before && change.before.exists ? change.before.data() : null;
      const after = change.after && change.after.exists ? change.after.data() : null;
      await clientsServiceFor(suffix).onProspectWrite(before, after);
    });

    // Keeps userDirectory (id, nombre, role, activo) in step with users, enabling safe listings for non-managers.
    exports[`syncUserDirectory${suffix}`] = functions.firestore.document(`users${suffix}/{userId}`).onWrite(async (change) => {
      const dirCol = suffix === '_prod' ? 'userDirectory_prod' : `userDirectory${suffix}`;
      const docRef = db.collection(dirCol).doc(change.after.id || change.before.id);
      if (!change.after.exists) {
        await docRef.delete();
      } else {
        const d = change.after.data() || {};
        await docRef.set({
          id: change.after.id,
          nombre: d.nombre || '',
          role: d.role || 'vendedor',
          activo: d.activo !== false
        });
      }
    });
  }
}
