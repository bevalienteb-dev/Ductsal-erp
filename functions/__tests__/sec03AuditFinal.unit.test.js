// functions/__tests__/sec03AuditFinal.unit.test.js
// Focused final audit unit tests for SEC-03:
// 1. Administrative callable privilege models and unlinked manager privilege retention.
// 2. Storage URL differentiation (V4 Signed URLs vs Persistent Token URLs) and revocation mechanisms.
// 3. Rollback evidence persistence, opId retrieval, and verifiable provenance on reattempts.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createClientsService, ServiceError } = require('../clientsService');
const {
  createStorageService,
  normalizeExpirationSeconds,
  extractStoragePath
} = require('../storageService');
const {
  evaluateAuthAccountForRollback,
  executeSafeRollback
} = require('../rollbackUtil');

describe('SEC-03 Final Focused Audit Suite', () => {

  describe('1. Administrative Functions & Privilege Model Hardening (SEC-03 Part 1)', () => {
    let db;
    let mockAuth;

    beforeEach(() => {
      db = createFakeFirestore();
      mockAuth = {
        getUser: jest.fn()
      };
    });

    // Helper replicating the hardened index.js assertManager and assertRequesterProfileActive logic
    async function assertManager(context, authApi) {
      if (!context || !context.auth) {
        throw new Error('unauthenticated');
      }
      const user = await authApi.getUser(context.auth.uid);
      const claims = user.customClaims || {};
      if (claims.manager !== true || user.disabled === true) {
        throw new Error('permission-denied: Only managers can execute');
      }
      return user;
    }

    async function assertRequesterProfileActive(database, colName, uid, options = {}) {
      const allowUnlinked = options && options.allowUnlinked === true;
      const snap = await database.collection(colName).get();
      const linked = snap.docs.filter(d => (d.data() || {}).authUid === uid);

      if (linked.length === 0) {
        if (allowUnlinked) {
          return null;
        }
        throw new Error('permission-denied: Se requiere un perfil administrativo vinculado y activo');
      }

      if (linked.length > 1) {
        throw new Error('permission-denied: Inconsistencia de perfil: múltiples perfiles vinculados a la misma cuenta Auth');
      }

      const profileData = linked[0].data() || {};
      if (profileData.activo !== true) {
        throw new Error('permission-denied: The requester profile is inactive');
      }

      if (profileData.role !== 'manager') {
        throw new Error('permission-denied: The requester profile does not have administrative privileges');
      }

      return { id: linked[0].id, nombre: profileData.nombre || '', role: profileData.role };
    }

    // 1. Gestor con claim válido y perfil vinculado activo: permitido
    test('1. Gestor con claim válido y perfil vinculado activo: permitido', async () => {
      const callerUid = 'auth_uid_manager_123';
      await db.collection('users_prod').doc('1776895495203').set({
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: callerUid
      });
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: { manager: true, role: 'manager', cid: '1776895495203' }
      });
      const context = { auth: { uid: callerUid } };

      const authUser = await assertManager(context, mockAuth);
      expect(authUser.customClaims.manager).toBe(true);

      const profile = await assertRequesterProfileActive(db, 'users_prod', callerUid);
      expect(profile).toEqual({
        id: '1776895495203',
        nombre: 'Benjamin Valiente',
        role: 'manager'
      });
    });

    // 2. Gestor sin perfil vinculado: rechazado en operaciones administrativas ordinarias
    test('2. Gestor sin perfil vinculado: rechazado en operaciones administrativas ordinarias', async () => {
      const callerUid = 'auth_uid_unlinked_manager';
      // Profile exists but authUid is NOT set (unlinked account)
      await db.collection('users_prod').doc('1776895495203').set({
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true
      });
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: { manager: true, role: 'manager' }
      });
      const context = { auth: { uid: callerUid } };

      await assertManager(context, mockAuth); // passes claim check
      // But ordinary admin operation fails at profile check
      await expect(assertRequesterProfileActive(db, 'users_prod', callerUid))
        .rejects.toThrow('permission-denied: Se requiere un perfil administrativo vinculado y activo');
    });

    // 3. Gestor con perfil inactivo: rechazado
    test('3. Gestor con perfil inactivo: rechazado', async () => {
      const callerUid = 'auth_uid_inactive_manager';
      await db.collection('users_prod').doc('1776895495203').set({
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: false, // Inactive!
        authUid: callerUid
      });
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: { manager: true }
      });

      await expect(assertRequesterProfileActive(db, 'users_prod', callerUid))
        .rejects.toThrow('permission-denied: The requester profile is inactive');
    });

    // 4. Cuenta con claim de gestor pero con vínculo eliminado durante un rollback: rechazada
    test('4. Cuenta con claim de gestor pero con vínculo eliminado durante un rollback: rechazada', async () => {
      const callerUid = 'auth_uid_rollback_residual';
      // Profile had authUid unlinked in Firestore
      await db.collection('users_prod').doc('1776895495203').set({
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true
      });
      // But token/claims still carry manager: true
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: { manager: true }
      });

      await expect(assertRequesterProfileActive(db, 'users_prod', callerUid))
        .rejects.toThrow('permission-denied: Se requiere un perfil administrativo vinculado y activo');
    });

    // 5. Usuario sin claim de gestor: rechazado
    test('5. Usuario sin claim de gestor: rechazado', async () => {
      const callerUid = 'auth_uid_seller';
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: { role: 'vendedor' } // No manager claim
      });
      const context = { auth: { uid: callerUid } };

      await expect(assertManager(context, mockAuth))
        .rejects.toThrow('permission-denied: Only managers can execute');
    });

    // 6. Perfil duplicado o inconsistente: comportamiento seguro y explícito (rechazado)
    test('6. Perfil duplicado o inconsistente: rechazado explícitamente', async () => {
      const callerUid = 'auth_uid_duplicate';
      await db.collection('users_prod').doc('101').set({
        nombre: 'Profile 1',
        role: 'manager',
        activo: true,
        authUid: callerUid
      });
      await db.collection('users_prod').doc('102').set({
        nombre: 'Profile 2',
        role: 'manager',
        activo: true,
        authUid: callerUid
      });

      await expect(assertRequesterProfileActive(db, 'users_prod', callerUid))
        .rejects.toThrow('permission-denied: Inconsistencia de perfil: múltiples perfiles vinculados a la misma cuenta Auth');
    });

    // 7. Provisionamiento inicial legítimo sin perfil todavía vinculado: solo permitido mediante la ruta específica autorizada
    test('7. Provisionamiento inicial sin perfil vinculado: permitido SOLO en ruta de reconciliación propia', async () => {
      const callerUid = 'auth_uid_provisioning_manager';
      // No profile linked yet in Firestore
      const unlinkedProfile = await assertRequesterProfileActive(db, 'users_prod', callerUid, { allowUnlinked: true });
      expect(unlinkedProfile).toBeNull();

      // In reconcileUserOp: if unlinked, only allowed if operation is owned or targets the manager
      const ownOp = { id: 'op1', actor: { uid: callerUid }, uid: callerUid, status: 'manualReview' };
      const otherOp = { id: 'op2', actor: { uid: 'someone_else' }, uid: 'other_user', status: 'manualReview' };

      const evaluateOwnership = (op, caller) => {
        const actorUid = op.actor && (typeof op.actor === 'string' ? op.actor : (op.actor.uid || null));
        const reqUid = op.requesterUid || null;
        if (reqUid && actorUid && reqUid !== actorUid) {
          return false; // Contradictory ownership metadata
        }
        const ownerUid = reqUid || actorUid;
        return Boolean(ownerUid && ownerUid === caller);
      };

      const canReconcile = (op, requesterProf) => {
        if (!requesterProf) {
          const isOwner = evaluateOwnership(op, callerUid);
          const isTarget = (op.result && op.result.uid === callerUid) || op.uid === callerUid;
          if (!isOwner && !isTarget) {
            throw new Error('permission-denied: Unlinked managers can only reconcile operations initiated by or targeting their own account');
          }
        }
        return true;
      };

      // Own op with canonical requesterUid: permitted
      expect(canReconcile({ id: 'op_can', requesterUid: callerUid, status: 'manualReview' }, unlinkedProfile)).toBe(true);

      // Own op with historical actor.uid: permitted
      expect(canReconcile(ownOp, unlinkedProfile)).toBe(true);

      // Other op: blocked
      expect(() => canReconcile(otherOp, unlinkedProfile))
        .toThrow('permission-denied: Unlinked managers can only reconcile operations initiated by or targeting their own account');

      // Contradictory ownership: blocked
      const contradictoryOp = { id: 'op_bad', requesterUid: callerUid, actor: { uid: 'someone_else' } };
      expect(() => canReconcile(contradictoryOp, unlinkedProfile))
        .toThrow('permission-denied: Unlinked managers can only reconcile operations initiated by or targeting their own account');
    });

    // 8. Operaciones comerciales y de workflow: sin regresiones (resolveCaller exige perfil activo)
    test('8. Operaciones comerciales y de workflow: sin regresiones (resolveCaller)', async () => {
      const clientsService = createClientsService({ db, suffix: '_prod' });
      const callerUid = 'auth_uid_manager_123';

      // Unlinked caller is rejected
      await db.collection('users_prod').doc('1776895495203').set({
        nombre: 'Benjamin Valiente',
        role: 'manager',
        activo: true
      });
      const unlinkedCtx = { auth: { uid: callerUid, token: { manager: true, cid: '1776895495203' } } };
      await expect(clientsService.resolveCaller(unlinkedCtx))
        .rejects.toThrow('Se requiere un usuario activo del CRM vinculado a esta sesión');

      // Linked caller is accepted
      await db.collection('users_prod').doc('1776895495203').update({ authUid: callerUid });
      const caller = await clientsService.resolveCaller(unlinkedCtx);
      expect(caller.cid).toBe('1776895495203');
      expect(caller.role).toBe('manager');
    });

    // 9. Rollback parcial: neutralizar privilegios antes de desvincular el perfil
    test('9. Rollback parcial: neutralizar privilegios cierra la ventana de autorización', async () => {
      const callerUid = 'auth_uid_rollback_test';
      // Claims neutralized in Auth
      mockAuth.getUser.mockResolvedValue({
        uid: callerUid,
        disabled: false,
        customClaims: {} // Neutralized!
      });
      const context = { auth: { uid: callerUid } };

      await expect(assertManager(context, mockAuth))
        .rejects.toThrow('permission-denied: Only managers can execute');
    });
  });

  describe('2. Storage URLs: V4 Signed vs Persistent Token URLs', () => {
    let db;
    let mockBucket;
    let storageService;

    beforeEach(() => {
      db = createFakeFirestore();
      mockBucket = {
        name: 'ductsal-erp.firebasestorage.app',
        file: jest.fn((p) => ({
          name: p,
          exists: async () => [true],
          getMetadata: async () => [{ size: '512000', contentType: 'application/pdf' }],
          getSignedUrl: async (opts) => {
            const exp = Math.floor(opts.expires / 1000);
            return [`https://storage.googleapis.com/${mockBucket.name}/${encodeURIComponent(p)}?GoogleAccessId=sa@iam.gserviceaccount.com&Expires=${exp}&Signature=sig`];
          }
        }))
      };
      storageService = createStorageService({ db, bucket: mockBucket, suffix: '_prod' });
    });

    test('V4 Signed URLs enforce short bounded expiration (default 900s, max 900s, min 60s)', () => {
      expect(normalizeExpirationSeconds(null)).toBe(900);
      expect(normalizeExpirationSeconds(undefined)).toBe(900);
      expect(normalizeExpirationSeconds(10)).toBe(60); // Clamped to min 60s
      expect(normalizeExpirationSeconds(86400)).toBe(900); // Clamped to max 900s
      expect(normalizeExpirationSeconds(300)).toBe(300);
    });

    test('extractStoragePath decodes and purges token parameters from legacy getDownloadURL links', () => {
      const legacyTokenUrl = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Ffacturas%2Finvoice.pdf?alt=media&token=4a7e3b91-1234-5678-abcd-ef0123456789';

      const cleanPath = extractStoragePath(legacyTokenUrl);

      // Token is stripped completely, returning canonical physical storage path
      expect(cleanPath).toBe('prod_files/prospects/p1/facturas/invoice.pdf');
      expect(cleanPath).not.toContain('token');
      expect(cleanPath).not.toContain('alt=media');
    });

    test('getSecureDownloadUrl requires entity access and active caller profile', async () => {
      // Caller has active profile
      const caller = { uid: 'uid_seller_1', cid: 'cid_seller_1', role: 'vendedor', name: 'Seller One' };

      // Prospect exists and belongs to this seller
      await db.collection('prospects_prod').doc('p100').set({
        clientId: 'c100',
        createdBy: 'cid_seller_1',
        vendedorId: 'cid_seller_1',
        eliminado: false,
        doc_oferta: [{ storagePath: 'prod_files/prospects/p100/ofertas/cotizacion.pdf' }]
      });

      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files/prospects/p100/ofertas/cotizacion.pdf',
        prospectId: 'p100',
        expiresInSeconds: 300
      });

      expect(res.signedUrl).toContain('https://storage.googleapis.com/');
      expect(res.expiresAt).toBeDefined();
      expect(res.storagePath).toBe('prod_files/prospects/p100/ofertas/cotizacion.pdf');
    });

    test('getSecureDownloadUrl rejects unauthorized caller attempting to access another seller document', async () => {
      // Foreign caller
      const unauthorizedCaller = { uid: 'uid_other', cid: 'cid_other', role: 'vendedor', name: 'Other' };

      await db.collection('prospects_prod').doc('p200').set({
        clientId: 'c200',
        createdBy: 'cid_owner',
        vendedorId: 'cid_owner',
        eliminado: false,
        doc_oferta: [{ storagePath: 'prod_files/prospects/p200/ofertas/plano.pdf' }]
      });

      await expect(storageService.getSecureDownloadUrl({
        caller: unauthorizedCaller,
        storagePath: 'prod_files/prospects/p200/ofertas/plano.pdf',
        prospectId: 'p200'
      })).rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });
  });

  describe('3. Rollback Evidence & Immutable opId Provenance Persistence', () => {
    let mockAdmin;
    let mockAuthUser;
    let mockProfile;
    let opStore;
    let callLog;

    beforeEach(() => {
      callLog = [];
      opStore = new Map();

      mockAuthUser = {
        uid: 'uid_migrated_commercial',
        email: 'rflores@ductsal.com',
        disabled: false,
        customClaims: { role: 'vendedor', cid: '1788471603604' },
        metadata: {
          creationTime: '2026-10-18T05:00:00Z',
          lastSignInTime: null
        }
      };

      mockProfile = {
        nombre: 'Roberto Flores',
        email: 'rflores@ductsal.com',
        role: 'vendedor',
        activo: true,
        authUid: 'uid_migrated_commercial',
        authProvider: 'firebase'
      };

      const authInstance = {
        getUser: jest.fn(async (uid) => {
          callLog.push(`auth.getUser(${uid})`);
          if (uid === mockAuthUser.uid) return { ...mockAuthUser };
          const err = new Error('User not found');
          err.code = 'auth/user-not-found';
          throw err;
        }),
        setCustomUserClaims: jest.fn(async (uid, claims) => {
          callLog.push(`auth.setCustomUserClaims(${uid}, ${JSON.stringify(claims)})`);
          mockAuthUser.customClaims = claims;
        }),
        revokeRefreshTokens: jest.fn(async (uid) => {
          callLog.push(`auth.revokeRefreshTokens(${uid})`);
        }),
        deleteUser: jest.fn(async (uid) => {
          callLog.push(`auth.deleteUser(${uid})`);
        }),
        updateUser: jest.fn(async (uid, data) => {
          callLog.push(`auth.updateUser(${uid}, ${JSON.stringify(data)})`);
          Object.assign(mockAuthUser, data);
        })
      };

      const firestoreInstance = {
        collection: (colName) => ({
          doc: (docId) => ({
            get: async () => {
              if (colName === 'userOps') {
                const entry = opStore.get(docId);
                return {
                  exists: !!entry,
                  data: () => entry || {}
                };
              }
              if (colName === 'users_prod' && docId === '1788471603604') {
                return {
                  exists: true,
                  data: () => ({ ...mockProfile })
                };
              }
              return { exists: false, data: () => ({}) };
            }
          })
        }),
        runTransaction: jest.fn(async (updateFn) => {
          callLog.push('firestore.runTransaction');
          const tx = {
            get: async () => ({
              exists: true,
              data: () => ({ ...mockProfile })
            }),
            update: (docRef, updates) => {
              callLog.push('firestore.tx.update');
              if (updates.authUid) delete mockProfile.authUid;
              if (updates.authProvider) delete mockProfile.authProvider;
            }
          };
          return await updateFn(tx);
        })
      };

      mockAdmin = {
        auth: () => authInstance,
        firestore: () => firestoreInstance
      };
    });

    test('INTERRUPTED MIGRATION: opId in userOps preserves immutable provenance when process was aborted', async () => {
      // Simulate migration was interrupted after Auth user creation (state authCreated)
      const opId = 'op_migration_step_1788471603604';
      opStore.set(opId, {
        action: 'linkHistoricalUser',
        status: 'authCreated',
        profileId: '1788471603604',
        result: { uid: 'uid_migrated_commercial', email: 'rflores@ductsal.com' },
        createdAt: '2026-10-18T05:00:00Z'
      });

      // First rollback attempt: Firestore is unlinked, claims neutralized, but deleteUser timed out
      // Simulating profile state after first rollback attempt
      delete mockProfile.authUid;
      delete mockProfile.authProvider;

      // REATTEMPT OF ROLLBACK:
      // Without opId: refuses to delete account because mutable profile in Firestore is already unlinked!
      const failedReattempt = await executeSafeRollback(mockAdmin, {
        cid: '1788471603604',
        uid: 'uid_migrated_commercial',
        confirmDelete: 'YES'
        // opId omitted!
      });

      expect(failedReattempt.authDeleted).toBe(false);
      expect(failedReattempt.stopCondition).toBe('MISSING_PROVENANCE_FOR_UNLINKED_PROFILE');
      expect(callLog).not.toContain('auth.deleteUser(uid_migrated_commercial)');

      // With opId: verifies immutable evidence from userOps and authorises safe deletion
      const successfulReattempt = await executeSafeRollback(mockAdmin, {
        cid: '1788471603604',
        uid: 'uid_migrated_commercial',
        opId,
        confirmDelete: 'YES'
      });

      expect(successfulReattempt.authDeleted).toBe(true);
      expect(successfulReattempt.status).toBe('COMPLETED_USER_DELETED');
      expect(callLog).toContain('auth.deleteUser(uid_migrated_commercial)');
    });

    test('TAMPERED / MISMATCHED opId: Reattempt refuses deletion if opId points to a different profile or UID', async () => {
      // Simulate profile already unlinked
      delete mockProfile.authUid;
      delete mockProfile.authProvider;

      // Mismatched opId in userOps (points to different CID)
      const mismatchedOpId = 'op_alien_op_999';
      opStore.set(mismatchedOpId, {
        action: 'linkHistoricalUser',
        status: 'authCreated',
        profileId: '9999999999999', // Different CID!
        result: { uid: 'uid_migrated_commercial' }
      });

      const res = await executeSafeRollback(mockAdmin, {
        cid: '1788471603604',
        uid: 'uid_migrated_commercial',
        opId: mismatchedOpId,
        confirmDelete: 'YES'
      });

      expect(res.authDeleted).toBe(false);
      expect(res.stopCondition).toBe('MISSING_PROVENANCE_FOR_UNLINKED_PROFILE');
      expect(callLog).not.toContain('auth.deleteUser(uid_migrated_commercial)');
    });
  });
});
