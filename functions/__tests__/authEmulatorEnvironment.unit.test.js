// functions/__tests__/authEmulatorEnvironment.unit.test.js
// Unit tests for the isolated emulator environment configuration and safety guards.
// Runs purely in memory without requiring live emulators.

const {
  PROJECT,
  AUTH_HOST,
  AUTH_PORT,
  FIRESTORE_HOST,
  FIRESTORE_PORT,
  FUNCTIONS_HOST,
  FUNCTIONS_PORT,
  ACTION_CODE_SETTINGS,
  FORBIDDEN_PRODUCTION_PATTERNS,
  assertSafetyGuard,
  parseActionLink
} = require('../emulator-tests/authEmulatorTestHelper');

describe('Auth Emulator Environment Unit Tests (Safety Guards & Configuration)', () => {
  const validEnv = {
    GCLOUD_PROJECT: 'demo-ductsal-local',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'
  };

  test('valid local emulator environment passes safety guard', () => {
    expect(() => assertSafetyGuard(validEnv)).not.toThrow();
  });

  describe('Production Project Blocking', () => {
    test.each([
      ['ductsal-erp'],
      ['DUCTSAL-ERP'],
      ['ductsal-erp.firebaseapp.com'],
      ['ductsal-erp.firebasestorage.app'],
      ['prod-ductsal-erp-main']
    ])('explicitly blocks production project: %s', (forbiddenProj) => {
      const badEnv = { ...validEnv, GCLOUD_PROJECT: forbiddenProj };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FATAL PRODUCTION GUARD/);
    });

    test('blocks when production is in GOOGLE_CLOUD_PROJECT', () => {
      const badEnv = {
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        GOOGLE_CLOUD_PROJECT: 'ductsal-erp'
      };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FATAL PRODUCTION GUARD/);
    });

    test('explicitly blocks staging project (ductsal-erp-staging)', () => {
      const stagingEnv = { ...validEnv, GCLOUD_PROJECT: 'ductsal-erp-staging' };
      expect(() => assertSafetyGuard(stagingEnv)).toThrow(/FATAL PRODUCTION GUARD|FATAL SAFETY GUARD/);
    });

    test('explicitly blocks generic staging references without production substring', () => {
      const stagingEnv = { ...validEnv, GCLOUD_PROJECT: 'demo-ductsal-staging' };
      expect(() => assertSafetyGuard(stagingEnv)).toThrow(/FATAL SAFETY GUARD.*Staging/);
    });

    test('rejects demo-ductsal-isolated to unify exclusively on demo-ductsal-local', () => {
      const isolatedEnv = { ...validEnv, GCLOUD_PROJECT: 'demo-ductsal-isolated' };
      expect(() => assertSafetyGuard(isolatedEnv)).toThrow(/Active project must be strictly "demo-ductsal-local"/);
    });

    test('rejects arbitrary non-whitelisted project', () => {
      const badEnv = { ...validEnv, GCLOUD_PROJECT: 'some-random-project' };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/Active project must be strictly "demo-ductsal-local"/);
    });

    test('FORBIDDEN_PRODUCTION_PATTERNS includes erp.ductsal.com', () => {
      expect(FORBIDDEN_PRODUCTION_PATTERNS).toContain('erp.ductsal.com');
    });
  });

  describe('Host Isolation Guarding', () => {
    test('rejects missing FIREBASE_AUTH_EMULATOR_HOST', () => {
      const badEnv = { ...validEnv };
      delete badEnv.FIREBASE_AUTH_EMULATOR_HOST;
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FIREBASE_AUTH_EMULATOR_HOST is not a loopback host/);
    });

    test('rejects non-loopback FIREBASE_AUTH_EMULATOR_HOST', () => {
      const badEnv = { ...validEnv, FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443' };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FIREBASE_AUTH_EMULATOR_HOST is not a loopback host/);
    });

    test('rejects missing FIRESTORE_EMULATOR_HOST', () => {
      const badEnv = { ...validEnv };
      delete badEnv.FIRESTORE_EMULATOR_HOST;
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FIRESTORE_EMULATOR_HOST is not a loopback host/);
    });

    test('rejects non-loopback FIRESTORE_EMULATOR_HOST', () => {
      const badEnv = { ...validEnv, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/FIRESTORE_EMULATOR_HOST is not a loopback host/);
    });

    test('rejects presence of GOOGLE_APPLICATION_CREDENTIALS', () => {
      const badEnv = { ...validEnv, GOOGLE_APPLICATION_CREDENTIALS: '/path/to/prod-service-account.json' };
      expect(() => assertSafetyGuard(badEnv)).toThrow(/GOOGLE_APPLICATION_CREDENTIALS must not be set/);
    });
  });

  describe('Action Code Settings & URL Parsing', () => {
    test('ACTION_CODE_SETTINGS in test helper points to local dev URL, never to erp.ductsal.com', () => {
      expect(ACTION_CODE_SETTINGS.url).toBe('http://127.0.0.1:8123/login?mode=activate');
      expect(ACTION_CODE_SETTINGS.url).not.toContain('erp.ductsal.com');
      expect(ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });

    test('parseActionLink correctly extracts parameters from an emulator action link with local continueUrl', () => {
      const sampleLink = 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&lang=es&oobCode=secret_test_code_123&apiKey=fake-api-key&continueUrl=http%3A%2F%2F127.0.0.1%3A8123%2Flogin%3Fmode%3Dactivate';
      const parsed = parseActionLink(sampleLink);
      expect(parsed).toEqual({
        host: '127.0.0.1:9099',
        pathname: '/emulator/action',
        mode: 'resetPassword',
        oobCode: 'secret_test_code_123',
        apiKey: 'fake-api-key',
        continueUrl: 'http://127.0.0.1:8123/login?mode=activate',
        lang: 'es'
      });
      expect(parsed.continueUrl).not.toContain('erp.ductsal.com');
    });

    test('parseActionLink handles invalid or null strings gracefully', () => {
      expect(parseActionLink(null)).toBeNull();
      expect(parseActionLink('')).toBeNull();
      expect(parseActionLink('not-a-valid-url')).toBeNull();
    });
  });

  describe('Constants and Endpoints Validation', () => {
    test('target project is strictly demo-ductsal-local', () => {
      expect(PROJECT).toBe('demo-ductsal-local');
    });

    test('default ports match local architecture', () => {
      expect(AUTH_PORT).toBe(9099);
      expect(FIRESTORE_PORT).toBe(8080);
      expect(FUNCTIONS_PORT).toBe(5001);
      expect(AUTH_HOST).toBe('127.0.0.1');
      expect(FIRESTORE_HOST).toBe('127.0.0.1');
      expect(FUNCTIONS_HOST).toBe('127.0.0.1');
    });
  });
});
