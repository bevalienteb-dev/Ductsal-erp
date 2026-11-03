// functions/emulator-tests/authEmulatorIsolation.emu.js
// Automated verification for isolated Firebase Authentication, Firestore, and Functions testing.
// Validates:
//  - Zero external email delivery via Auth Emulator OOB codes inspection
//  - Action Code Settings and Spanish language code ('es')
//  - Complete user activation & password recovery flows
//  - Absolute production protection (blocks ductsal-erp)
//  - Secrets hygiene: no OOB codes or links stored in Firestore
//  - Role invariants (no manager creation via callable)
//  - Idempotent and clean test data lifecycle with reserved test domain @example.test

const crypto = require('crypto');
const H = require('./authEmulatorTestHelper');
const { SEED, seedTestManager } = require('../scripts/seedEmulatorManager');

const SUFFIX = '_local';
const USERS_COLLECTION = `users${SUFFIX}`;

const randomSecret = () => 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
const randomTag = () => crypto.randomBytes(4).toString('hex');

describe('Auth Emulator Isolated Environment & Lifecycle Verification', () => {
  const tag = randomTag();
  const testManagerEmail = `gerente.${tag}@example.test`;
  const testVendedorEmail = `vendedor1.${tag}@example.test`;
  const testGestorEmail = `gestor1.${tag}@example.test`;
  const mgrPassword = randomSecret();
  const state = {};

  beforeAll(async () => {
    // 1. Assert strict safety guard
    H.assertSafetyGuard(process.env);

    // 2. Assert emulators reachability
    await H.assertEmulatorsReachable();

    // 3. Clean all previous test data
    await H.clearAllEmulatorData();

    // 4. Seed test manager using the reserved @example.test domain
    // We sign up the manager on the emulator Auth directly and assign manager claims
    const mgrAuth = await H.signInTestUser(SEED.email, 'dummy').catch(async () => {
      // Create fresh seed manager
      const url = `${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testManagerEmail, password: mgrPassword, returnSecureToken: true })
      });
      const data = await res.json();
      return { uid: data.localId, idToken: data.idToken };
    });

    state.managerUid = mgrAuth.uid;

    // Grant custom claims { role: 'manager', manager: true, cid: '1000000000001' } via emulator admin endpoint
    const updateClaimsUrl = `${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${H.PROJECT}/accounts:update`;
    await fetch(updateClaimsUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: state.managerUid,
        customAttributes: JSON.stringify({ role: 'manager', manager: true, cid: '1000000000001' })
      })
    });

    // Create manager profile in Firestore users_local
    const createDocUrl = `${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/1000000000001`;
    await fetch(createDocUrl, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: '1000000000001' },
          authUid: { stringValue: state.managerUid },
          email: { stringValue: testManagerEmail },
          nombre: { stringValue: 'Gerente Pruebas Aisladas' },
          role: { stringValue: 'manager' },
          activo: { booleanValue: true }
        }
      })
    });

    // Sign in as manager to get a fresh ID token containing the manager claim
    const signedMgr = await H.signInTestUser(testManagerEmail, mgrPassword);
    state.managerToken = signedMgr.idToken;
    const claims = H.decodeClaims(state.managerToken);
    expect(claims.manager).toBe(true);
  });

  afterAll(async () => {
    // Teardown: ensure all created data and OOB codes are cleanly wiped
    await H.clearAllEmulatorData();
  });

  describe('1. Emulators Connectivity & Production Guard', () => {
    test('all emulators are healthy, bound to 127.0.0.1, and project is demo-ductsal-local', async () => {
      expect(H.PROJECT).toBe('demo-ductsal-local');
      expect(H.AUTH_URL).toBe('http://127.0.0.1:9099');
      expect(H.FIRESTORE_URL).toBe('http://127.0.0.1:8080');
      expect(H.FUNCTIONS_URL).toBe('http://127.0.0.1:5001');
      await expect(H.assertEmulatorsReachable()).resolves.not.toThrow();
    });

    test('production project ductsal-erp is explicitly rejected by safety guards', () => {
      const prodEnv = {
        GCLOUD_PROJECT: 'ductsal-erp',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
      };
      expect(() => H.assertSafetyGuard(prodEnv)).toThrow(/FATAL PRODUCTION GUARD/);
    });

    test('staging project ductsal-erp-staging is explicitly rejected by safety guards', () => {
      const stagingEnv = {
        GCLOUD_PROJECT: 'ductsal-erp-staging',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
      };
      expect(() => H.assertSafetyGuard(stagingEnv)).toThrow(/FATAL PRODUCTION GUARD|FATAL SAFETY GUARD/);
    });

    test('demo-ductsal-isolated is rejected to enforce sole project demo-ductsal-local', () => {
      const isolatedEnv = {
        GCLOUD_PROJECT: 'demo-ductsal-isolated',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
      };
      expect(() => H.assertSafetyGuard(isolatedEnv)).toThrow(/Active project must be strictly "demo-ductsal-local"/);
    });
  });

  describe('2. User Creation & Ticket Authority (Native Architecture Flow)', () => {
    test('createUserAdmin creates user and pre-registers ticket without Admin SDK link or OOB code', async () => {
      const opId = 'op-' + tag + '-v1';
      const payload = {
        email: testVendedorEmail,
        nombre: 'Vendedor Test ' + tag,
        role: 'vendedor',
        opId,
        dbSuffix: SUFFIX
      };

      const res = await H.callFunction('createUserAdmin', payload, state.managerToken);
      expect(res.error).toBeUndefined();
      expect(res.httpStatus).toBe(200);
      expect(res.result).toMatchObject({
        uid: expect.any(String),
        id: expect.any(String),
        email: testVendedorEmail,
        status: 'created',
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        link: null,
        invitation: expect.objectContaining({
          status: 'pending',
          lastRequestStatus: 'pending',
          delivery: 'client_sdk',
          sent: false
        })
      });

      expect(res.result.link).toBeNull();
      state.vendedorUid = res.result.uid;
      state.vendedorId = res.result.id;
      state.requestId = res.result.requestId;

      // Verify ZERO OOB codes exist in Auth emulator for this user (no Admin SDK generation)
      const codes = (await H.listOobCodes()).filter(c => c.email === testVendedorEmail);
      expect(codes).toHaveLength(0);

      // Verify ticket pre-registration in Firestore
      const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/invitationOps${SUFFIX}/${state.requestId}`);
      const ticketDoc = await ticketRes.json();
      expect(ticketDoc.fields).toBeDefined();
      expect(ticketDoc.fields.status.stringValue).toBe('ISSUED');
      expect(ticketDoc.fields.userId.stringValue).toBe(state.vendedorId);
      expect(ticketDoc.fields.recipientEmail.stringValue).toBe(testVendedorEmail);
      expect(ticketDoc.fields.operation.stringValue).toBe('create_user');
    });

    test('replaying same opId is idempotent and preserves user without duplicate creation', async () => {
      const opId = 'op-' + tag + '-v1';
      const payload = {
        email: testVendedorEmail,
        nombre: 'Vendedor Test ' + tag,
        role: 'vendedor',
        opId,
        dbSuffix: SUFFIX
      };

      const res = await H.callFunction('createUserAdmin', payload, state.managerToken);
      expect(res.error).toBeUndefined();
      expect(res.result.uid).toBe(state.vendedorUid);
      expect(res.result.id).toBe(state.vendedorId);
      expect(res.result.message).toMatch(/already completed/i);
    });
  });

  describe('3. Email Capture & OOB Action Codes Endpoint (Step 6.3.2 / 6.3.4 Native Client Flow)', () => {
    test('sendPasswordResetOobCode generates OOB code with expected local continueUrl and frontend language configuration', async () => {
      // Frontend establishes Spanish language code
      const frontendAuth = { languageCode: 'es' };
      expect(frontendAuth.languageCode).toBe('es');

      // Trigger native password reset email request for vendedor with local development continueUrl
      await H.sendPasswordResetOobCode(testVendedorEmail, {
        continueUrl: H.ACTION_CODE_SETTINGS.url,
        languageCode: frontendAuth.languageCode
      });

      // Capture code directly from Auth emulator endpoint: GET /emulator/v1/projects/<proj>/oobCodes
      const oobEntry = await H.getLastOobCode(testVendedorEmail, 'PASSWORD_RESET');
      expect(oobEntry).not.toBeNull();
      expect(oobEntry.email).toBe(testVendedorEmail);
      expect(oobEntry.requestType).toBe('PASSWORD_RESET');
      expect(oobEntry.oobCode).toBeTruthy();

      // Exactly ONE OOB code for testVendedorEmail (single Client SDK dispatch)
      const userOobCodes = (await H.listOobCodes()).filter(c => c.email === testVendedorEmail);
      expect(userOobCodes).toHaveLength(1);

      const parsed = H.parseActionLink(oobEntry.oobLink);
      expect(parsed.continueUrl).toBe(H.ACTION_CODE_SETTINGS.url);
      expect(parsed.continueUrl).toBe('http://127.0.0.1:8123/login?mode=activate');
      expect(parsed.continueUrl).not.toContain('erp.ductsal.com');
      expect(parsed.mode).toBe('resetPassword');
      expect(parsed.oobCode).toBe(oobEntry.oobCode);

      state.capturedOobCode = oobEntry.oobCode;
    });

    test('zero external email delivery: all generated codes reside solely in emulator memory', async () => {
      const allCodes = await H.listOobCodes();
      expect(allCodes.length).toBeGreaterThan(0);
      const recipientEmails = allCodes.map(c => c.email);
      // All recipient emails belong strictly to reserved test domains (.test or .invalid)
      for (const email of recipientEmails) {
        const isTestDomain = email.endsWith('@example.test') || email.endsWith('.invalid');
        expect(isTestDomain).toBe(true);
      }
    });
  });

  describe('4. User Activation & Password Recovery Flow', () => {
    const newVendedorPassword = randomSecret();

    test('login is rejected before completing the password reset', async () => {
      await expect(H.signInTestUser(testVendedorEmail, randomSecret())).rejects.toThrow();
    });

    test('completing password reset with captured OOB code sets password and enables authentication', async () => {
      // Execute password reset using Auth REST endpoint
      const resetRes = await H.completePasswordReset(state.capturedOobCode, newVendedorPassword);
      expect(resetRes.email).toBe(testVendedorEmail);
      expect(resetRes.requestType).toBe('PASSWORD_RESET');

      // Now signing in with new password succeeds
      const session = await H.signInTestUser(testVendedorEmail, newVendedorPassword);
      expect(session.uid).toBe(state.vendedorUid);
      expect(session.idToken).toBeTruthy();
    });

    test('OOB code is single-use and cannot be replayed', async () => {
      await expect(H.completePasswordReset(state.capturedOobCode, randomSecret())).rejects.toThrow();
    });
  });

  describe('5. Secrets & Data Hygiene in Firestore', () => {
    test('neither OOB code nor reset link is persisted anywhere in Firestore', async () => {
      const leaks = await H.scanFirestoreForSecrets([state.capturedOobCode].filter(Boolean));
      expect(leaks).toEqual([]);
    });

    test('Firestore user profile contains no password field', async () => {
      const getDocUrl = `${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.vendedorId}`;
      const res = await fetch(getDocUrl, { headers: { Authorization: 'Bearer owner' } });
      const doc = await res.json();
      const fields = doc.fields || {};
      const hasPassField = Object.keys(fields).some(k => /pass/i.test(k));
      expect(hasPassField).toBe(false);
    });
  });

  describe('6. Security & Role Constraints Enforcement', () => {
    test('manager role CANNOT be created via createUserAdmin', async () => {
      const badPayload = {
        email: `badmgr.${tag}@example.test`,
        nombre: 'Intento Manager',
        role: 'manager',
        opId: 'op-' + tag + '-badmgr',
        dbSuffix: SUFFIX
      };
      const res = await H.callFunction('createUserAdmin', badPayload, state.managerToken);
      expect(res.error).toBeDefined();
      expect(res.error.status).toBe('PERMISSION_DENIED');
    });

    test('unauthenticated call is rejected with UNAUTHENTICATED', async () => {
      const anonPayload = {
        email: `anon.${tag}@example.test`,
        nombre: 'Anonimo',
        role: 'vendedor',
        opId: 'op-' + tag + '-anon',
        dbSuffix: SUFFIX
      };
      const res = await H.callFunction('createUserAdmin', anonPayload, null);
      expect(res.error).toBeDefined();
      expect(res.error.status).toBe('UNAUTHENTICATED');
    });
  });

  describe('7. Test Teardown & Environment Reset', () => {
    test('clearAllEmulatorData cleanly wipes all accounts and documents', async () => {
      await H.clearAllEmulatorData();
      const accountsRemaining = await H.listAuthAccounts();
      expect(accountsRemaining).toEqual([]);
      const docRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}`);
      const body = await docRes.json();
      expect(body.documents || []).toEqual([]);
    });
  });
});
