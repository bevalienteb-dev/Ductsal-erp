// functions/__tests__/googleAuthAdminAdapter.unit.test.js
// Unit tests for the Google Auth Firebase Admin Adapter (SEC-03).
// Validates token adaptation, strict project enforcement, error sanitization,
// and compatibility with provisionManager, rollback, and manualReview flows.
// 100% LOCAL MOCKS: Zero calls to Google Cloud APIs or production.

const {
  EXPECTED_PROJECT_ID,
  DEFAULT_TARGET_SA,
  ImpersonatedGoogleAuthCredential,
  createImpersonatedCredential,
  initializeImpersonatedAdminApp,
  sanitizeErrorMessage
} = require('../scripts/googleAuthAdminAdapter');

const { resolveAdminProjectId, provisionManager } = require('../scripts/provisionManager');
const { buildAdminFake } = require('../test-helpers/fakeFirebase');

describe('SEC-03 Google Auth Admin Adapter', () => {

  describe('1. ImpersonatedGoogleAuthCredential & Token Adaptation', () => {
    it('successfully acquires and adapts token from authClient returning object', async () => {
      const mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue({
          token: 'mock-valid-sa-access-token-12345'
        })
      };

      const cred = new ImpersonatedGoogleAuthCredential(mockAuthClient, {
        projectId: EXPECTED_PROJECT_ID
      });

      expect(cred.projectId).toBe(EXPECTED_PROJECT_ID);
      expect(cred.implicit).toBe(true);

      const tokenObj = await cred.getAccessToken();
      expect(tokenObj).toEqual({
        access_token: 'mock-valid-sa-access-token-12345',
        expires_in: 3600
      });
      expect(mockAuthClient.getAccessToken).toHaveBeenCalledTimes(1);
    });

    it('successfully adapts token from authClient returning raw string', async () => {
      const mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue('mock-raw-string-token-xyz')
      };

      const cred = new ImpersonatedGoogleAuthCredential(mockAuthClient);
      const tokenObj = await cred.getAccessToken();

      expect(tokenObj).toEqual({
        access_token: 'mock-raw-string-token-xyz',
        expires_in: 3600
      });
    });

    it('fails closed if authClient returns empty token string', async () => {
      const mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue({ token: '   ' })
      };

      const cred = new ImpersonatedGoogleAuthCredential(mockAuthClient);
      await expect(cred.getAccessToken()).rejects.toThrow(
        /Received empty or invalid access token/
      );
    });

    it('fails closed if authClient throws an error and sanitizes sensitive tokens', async () => {
      const mockAuthClient = {
        getAccessToken: jest.fn().mockRejectedValue(
          new Error('OAuth error: Bearer ya29.secret_auth_token_here failed 403 PERMISSION_DENIED')
        )
      };

      const cred = new ImpersonatedGoogleAuthCredential(mockAuthClient);
      await expect(cred.getAccessToken()).rejects.toThrow(
        /Failed to acquire impersonated access token.*Bearer \[REDACTED_TOKEN\].*403 PERMISSION_DENIED/
      );
    });

    it('sanitizeErrorMessage correctly redacts tokens, secrets and refresh_tokens', () => {
      const sensitiveMsg = 'Error with "access_token": "secret_123" and "refresh_token": "ref_456" and "client_secret": "cs_789"';
      const clean = sanitizeErrorMessage(sensitiveMsg);
      expect(clean).not.toContain('secret_123');
      expect(clean).not.toContain('ref_456');
      expect(clean).not.toContain('cs_789');
      expect(clean).toContain('"access_token": "[REDACTED]"');
    });

    it('rejects initialization if authClient is missing or does not have getAccessToken', () => {
      expect(() => new ImpersonatedGoogleAuthCredential(null)).toThrow(
        /requires an authClient with getAccessToken\(\)/
      );
      expect(() => new ImpersonatedGoogleAuthCredential({})).toThrow(
        /requires an authClient with getAccessToken\(\)/
      );
    });
  });

  describe('2. Strict Project Enforcement', () => {
    it('fails closed if target projectId contradicts ductsal-erp in constructor', () => {
      const mockAuthClient = { getAccessToken: jest.fn() };
      expect(() => new ImpersonatedGoogleAuthCredential(mockAuthClient, {
        projectId: 'malicious-or-staging-project'
      })).toThrow(/Target project must strictly be 'ductsal-erp'/);
    });

    it('fails closed if createImpersonatedCredential is given an invalid projectId', async () => {
      await expect(createImpersonatedCredential({
        projectId: 'unauthorized-project'
      })).rejects.toThrow(/projectId must strictly be 'ductsal-erp'/);
    });

    it('fails closed if initializeImpersonatedAdminApp is given an invalid projectId', async () => {
      const fakeAdmin = { initializeApp: jest.fn() };
      await expect(initializeImpersonatedAdminApp(fakeAdmin, {
        projectId: 'foreign-project'
      })).rejects.toThrow(/projectId must strictly be 'ductsal-erp'/);
    });
  });

  describe('3. Firebase Admin App Initialization with Adapted Credential', () => {
    it('initializes Firebase Admin app and passes project resolution without contradiction', async () => {
      const mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue('mock-sa-token-999')
      };

      const cred = await createImpersonatedCredential({
        projectId: EXPECTED_PROJECT_ID,
        authClient: mockAuthClient
      });

      // Construct a simulated Firebase Admin namespace conforming to SDK structure
      let defaultAppInstance = null;
      const fakeAdmin = {
        options: {
          projectId: EXPECTED_PROJECT_ID,
          credential: cred
        },
        apps: [],
        app() {
          if (!defaultAppInstance) throw new Error('No default app');
          return defaultAppInstance;
        },
        initializeApp(options, name) {
          const appObj = {
            name: name || '[DEFAULT]',
            options: {
              ...options
            },
            delete: jest.fn().mockResolvedValue(undefined)
          };
          defaultAppInstance = appObj;
          fakeAdmin.apps.push(appObj);
          return appObj;
        }
      };

      const app = await initializeImpersonatedAdminApp(fakeAdmin, {
        credential: cred,
        projectId: EXPECTED_PROJECT_ID
      });

      expect(app).toBeDefined();
      expect(fakeAdmin.apps.length).toBe(1);

      // Verify that resolveAdminProjectId detects consensus with zero contradictions
      const res = resolveAdminProjectId(fakeAdmin);
      expect(res.projectId).toBe(EXPECTED_PROJECT_ID);
      expect(res.contradiction).toBeUndefined();
    });

    it('detects contradiction and cleans up app if admin options contradict ductsal-erp', async () => {
      const mockAuthClient = { getAccessToken: jest.fn().mockResolvedValue('token') };
      const cred = await createImpersonatedCredential({
        projectId: EXPECTED_PROJECT_ID,
        authClient: mockAuthClient
      });

      let appDeleted = false;
      const contradictoryAdmin = {
        options: {
          projectId: 'conflicting-project-id', // Contradiction with cred.projectId
          credential: cred
        },
        apps: [],
        initializeApp(options) {
          const appObj = {
            options,
            delete: () => { appDeleted = true; return Promise.resolve(); }
          };
          contradictoryAdmin.apps.push(appObj);
          contradictoryAdmin.app = () => appObj;
          return appObj;
        }
      };

      await expect(initializeImpersonatedAdminApp(contradictoryAdmin, {
        credential: cred,
        projectId: EXPECTED_PROJECT_ID
      })).rejects.toThrow(/Project verification contradiction detected/);

      expect(appDeleted).toBe(true);
    });
  });

  describe('4. Full Lifecycle Compatibility with provisionManager (In-Memory Fake)', () => {
    let adminFake;
    let mockAuthClient;
    let cred;

    beforeEach(async () => {
      adminFake = buildAdminFake();
      mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue({
          token: 'valid-impersonated-token'
        })
      };

      cred = await createImpersonatedCredential({
        projectId: EXPECTED_PROJECT_ID,
        authClient: mockAuthClient
      });

      // Attach credential and project options to adminFake to mimic initialized admin
      adminFake.options = {
        projectId: EXPECTED_PROJECT_ID,
        credential: cred
      };
      adminFake.app = () => ({
        options: {
          projectId: EXPECTED_PROJECT_ID,
          credential: cred
        }
      });
      adminFake.apps = [{
        options: {
          projectId: EXPECTED_PROJECT_ID,
          credential: cred
        }
      }];
    });

    it('successfully provisions manager using adapted credential', async () => {
      // Seed pre-existing unlinked manager in users_prod
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      const res = await provisionManager(adminFake, {
        cid: '1776895495203',
        email: 'bvaliente@grupogama.com',
        nombre: 'Benjamin Valiente'
      });

      expect(res.uid).toBeDefined();
      expect(res.cid).toBe('1776895495203');
      expect(res.createdAuth).toBe(true);
      expect(res.role).toBe('manager');

      // Verify Firestore profile linkage
      const profileSnap = await adminFake.firestore().collection('users_prod').doc('1776895495203').get();
      const profile = profileSnap.data();
      expect(profile.authUid).toBe(res.uid);
      expect(profile.authProvider).toBe('firebase');

      // Verify Auth claims
      const authUser = await adminFake.auth().getUser(res.uid);
      expect(authUser.customClaims).toEqual({
        role: 'manager',
        manager: true,
        cid: '1776895495203'
      });

      // Verify immutable audit log
      const auditSnaps = await adminFake.firestore().collection('commercialAudit_prod').get();
      expect(auditSnaps.docs.length).toBe(1);
      expect(auditSnaps.docs[0].data().action).toBe('provision_manager');
      expect(auditSnaps.docs[0].data().cid).toBe('1776895495203');

      // Verify userOps status
      const opDoc = adminFake.__state.docs[`userOps/${res.opId}`];
      expect(opDoc).toBeDefined();
      expect(opDoc.status).toBe('succeeded');
    });

    it('executes primary rollback (deleteUser) when Firestore transaction fails', async () => {
      const opId = 'op_test_rollback_primary';
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      // Hook failure into beforeUpdate for users_prod to simulate transaction failure
      adminFake.__state.hooks.beforeUpdate = path => {
        if (path.includes('users_prod')) {
          throw new Error('Simulated transaction conflict in Firestore');
        }
      };

      try {
        await expect(provisionManager(adminFake, {
          cid: '1776895495203',
          email: 'bvaliente@grupogama.com',
          nombre: 'Benjamin Valiente',
          opId
        })).rejects.toThrow(/Simulated transaction conflict in Firestore/);

        // Verify primary rollback: created Auth account was deleted
        const authUsers = Object.values(adminFake.__state.authUsers);
        expect(authUsers.length).toBe(0);
        expect(adminFake.__state.deletedUids.length).toBe(1);

        // Verify userOps status is error and rolledBack is true
        const opDoc = adminFake.__state.docs[`userOps/${opId}`];
        expect(opDoc).toBeDefined();
        expect(opDoc.status).toBe('error');
        expect(opDoc.rolledBack).toBe(true);
      } finally {
        adminFake.__state.hooks.beforeUpdate = null;
      }
    });

    it('executes secondary rollback (disable user) and records manualReview when deleteUser fails', async () => {
      const opId = 'op_test_rollback_secondary';
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      // Fail transaction
      adminFake.__state.hooks.beforeUpdate = path => {
        if (path.includes('users_prod')) {
          throw new Error('Simulated transaction failure');
        }
      };

      // Fail deleteUser with permission-denied to trigger secondary fallback
      const originalAuthFactory = adminFake.auth;
      adminFake.auth = () => {
        const a = originalAuthFactory();
        return {
          ...a,
          deleteUser: async () => {
            throw new Error('PERMISSION_DENIED: Missing deleteUser permission');
          }
        };
      };

      try {
        await expect(provisionManager(adminFake, {
          cid: '1776895495203',
          email: 'bvaliente@grupogama.com',
          nombre: 'Benjamin Valiente',
          opId
        })).rejects.toThrow(/PERMISSION_DENIED: Missing deleteUser permission/);

        // Verify secondary compensation was invoked: auth.updateUser(uid, { disabled: true })
        expect(adminFake.__state.updateUserCalls.length).toBe(1);
        expect(adminFake.__state.updateUserCalls[0].attrs).toEqual({ disabled: true });

        // Verify status escalated to manualReview
        const opDoc = adminFake.__state.docs[`userOps/${opId}`];
        expect(opDoc).toBeDefined();
        expect(opDoc.status).toBe('manualReview');
        expect(opDoc.rolledBack).toBe(false);
      } finally {
        adminFake.__state.hooks.beforeUpdate = null;
        adminFake.auth = originalAuthFactory;
      }
    });

    it('records manualReview and does not mark succeeded when commercial audit fails', async () => {
      const opId = 'op_test_audit_failure';
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      // Hook failure into commercialAudit_prod.add
      adminFake.__state.hooks.beforeCreate = (docPath) => {
        if (docPath.includes('commercialAudit')) {
          throw new Error('Simulated audit collection disk write failure');
        }
      };

      try {
        await expect(provisionManager(adminFake, {
          cid: '1776895495203',
          email: 'bvaliente@grupogama.com',
          nombre: 'Benjamin Valiente',
          opId
        })).rejects.toThrow(/Simulated audit collection disk write failure/);

        // Verify status escalated to manualReview and NOT succeeded
        const opDoc = adminFake.__state.docs[`userOps/${opId}`];
        expect(opDoc).toBeDefined();
        expect(opDoc.status).toBe('manualReview');
        expect(opDoc.auditFailed).toBe(true);
      } finally {
        adminFake.__state.hooks.beforeCreate = null;
      }
    });
  });

  describe('5. F1 Operational Readiness & Safety Invariants', () => {
    let adminFake;
    let mockAuthClient;
    let cred;

    beforeEach(async () => {
      adminFake = buildAdminFake();
      mockAuthClient = {
        getAccessToken: jest.fn().mockResolvedValue('mock-token-f1')
      };
      cred = await createImpersonatedCredential({
        projectId: EXPECTED_PROJECT_ID,
        authClient: mockAuthClient
      });
      adminFake.options = { projectId: EXPECTED_PROJECT_ID, credential: cred };
      adminFake.app = () => ({ options: { projectId: EXPECTED_PROJECT_ID, credential: cred } });
      adminFake.apps = [{ options: { projectId: EXPECTED_PROJECT_ID, credential: cred } }];
    });

    it('creates account without initial password and preserves historical plaintext password in Firestore', async () => {
      // Seed manager with historical password
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        password: 'historical_plaintext_password_preserved',
        authUid: null,
        authProvider: null
      });

      const res = await provisionManager(adminFake, {
        cid: '1776895495203',
        email: 'bvaliente@grupogama.com',
        nombre: 'Benjamin Valiente',
        password: null, // Zero shared password in F1
        purgePassword: false // Strictly prohibited from purging in F1
      });

      expect(res.uid).toBeDefined();

      // Verify Auth account was created WITHOUT password argument
      expect(adminFake.__state.createUserArgs.length).toBe(1);
      expect(adminFake.__state.createUserArgs[0].password).toBeUndefined();

      // Verify Firestore profile still has historical plaintext password preserved
      const snap = await adminFake.firestore().collection('users_prod').doc('1776895495203').get();
      expect(snap.data().password).toBe('historical_plaintext_password_preserved');
    });

    it('never deletes newly created Auth user in rollback if user has already signed in (lastSignInTime)', async () => {
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      // Hook beforeUpdate to simulate user signing in concurrently before Firestore update crashes
      adminFake.__state.hooks.beforeUpdate = path => {
        if (path.includes('users_prod')) {
          if (adminFake.__state.authUsers['bvaliente@grupogama.com']) {
            adminFake.__state.authUsers['bvaliente@grupogama.com'].metadata = {
              creationTime: '2026-10-18T01:00:00Z',
              lastSignInTime: '2026-10-18T01:05:00Z'
            };
          }
          throw new Error('Transaction aborted');
        }
      };

      const opId = 'op_test_active_session_guard';
      await expect(provisionManager(adminFake, {
        cid: '1776895495203',
        email: 'bvaliente@grupogama.com',
        nombre: 'Benjamin Valiente',
        opId
      })).rejects.toThrow(/Transaction aborted/);

      // Verify user was NOT deleted
      expect(adminFake.__state.deletedUids.length).toBe(0);

      // Verify status escalated to manualReview
      const opDoc = adminFake.__state.docs[`userOps/${opId}`];
      expect(opDoc).toBeDefined();
      expect(opDoc.status).toBe('manualReview');
      expect(opDoc.rolledBack).toBe(false);
      expect(opDoc.rollbackErrors[0]).toContain('lastSignInTime');

      adminFake.__state.hooks.beforeUpdate = null;
    });

    it('strictly refuses to provision an inactive profile (e.g. Gustavo Velásquez exclusion invariant)', async () => {
      // Case A: Inactive seller (Gustavo Velásquez pattern - rejects silent elevation)
      adminFake.firestore().collection('users_prod').doc('1784221928346').set({
        cid: '1784221928346',
        nombre: 'Gustavo Velásquez',
        email: 'gvelasquez@ductsal.com',
        role: 'vendedor',
        activo: false,
        authUid: null,
        authProvider: null
      });

      await expect(provisionManager(adminFake, {
        cid: '1784221928346',
        email: 'gvelasquez@ductsal.com',
        nombre: 'Gustavo Velásquez'
      })).rejects.toThrow(/Silent role elevation is prohibited/);

      // Case B: Inactive manager profile
      adminFake.firestore().collection('users_prod').doc('9999999999999').set({
        cid: '9999999999999',
        nombre: 'Inactive Manager',
        email: 'inactive_mgr@ductsal.com',
        role: 'manager',
        activo: false,
        authUid: null,
        authProvider: null
      });

      await expect(provisionManager(adminFake, {
        cid: '9999999999999',
        email: 'inactive_mgr@ductsal.com',
        nombre: 'Inactive Manager'
      })).rejects.toThrow(/is inactive/);

      // Verify zero Auth calls were made across both attempts
      expect(adminFake.__state.createUserCalls).toBe(0);
    });

    it('strictly refuses to provision if provided email does not match profile email', async () => {
      adminFake.firestore().collection('users_prod').doc('1776895495203').set({
        cid: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: null,
        authProvider: null
      });

      await expect(provisionManager(adminFake, {
        cid: '1776895495203',
        email: 'attacker@evil.com',
        nombre: 'Benjamin Valiente'
      })).rejects.toThrow(/Email mismatch for profile 1776895495203/);

      expect(adminFake.__state.createUserCalls).toBe(0);
    });
  });
});
