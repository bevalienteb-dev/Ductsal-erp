// functions/__tests__/actionCodeSettingsIsolation.unit.test.js
// Automated verification of ActionCodeSettings isolation between local and production environments (Step 6.3.4.2).
// Ensures:
//  1. Local environment exclusively uses local server URL (http://127.0.0.1:8123/login?mode=activate).
//  2. Production configuration (https://erp.ductsal.com/login?mode=activate) remains strictly intact for deployment.
//  3. handleCodeInApp is strictly false across all environments.
//  4. Zero reliance on production URLs during local user creation, invitation resend, or password recovery.
//  5. Automated fatal assertion: FAILS if any continueUrl generated in the local environment points to production.

const invitationService = require('../invitationService');
const CrmAuth = require('../../crm_auth');

describe('Step 6.3.4.2 — ActionCodeSettings & Strict Environment Isolation', () => {
  const PROD_URL = 'https://erp.ductsal.com/login?mode=activate';
  const LOCAL_URL = 'http://127.0.0.1:8123/login?mode=activate';

  describe('1. invitationService.js (Backend Service Isolation)', () => {
    test('PRODUCTION_ACTION_CODE_SETTINGS is intact, immutable, and points to production domain', () => {
      expect(invitationService.PRODUCTION_ACTION_CODE_SETTINGS).toBeDefined();
      expect(invitationService.PRODUCTION_ACTION_CODE_SETTINGS.url).toBe(PROD_URL);
      expect(invitationService.PRODUCTION_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(Object.isFrozen(invitationService.PRODUCTION_ACTION_CODE_SETTINGS)).toBe(true);
    });

    test('LOCAL_ACTION_CODE_SETTINGS points strictly to 127.0.0.1:8123, never to production', () => {
      expect(invitationService.LOCAL_ACTION_CODE_SETTINGS).toBeDefined();
      expect(invitationService.LOCAL_ACTION_CODE_SETTINGS.url).toBe(LOCAL_URL);
      expect(invitationService.LOCAL_ACTION_CODE_SETTINGS.url).not.toContain('erp.ductsal.com');
      expect(invitationService.LOCAL_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(Object.isFrozen(invitationService.LOCAL_ACTION_CODE_SETTINGS)).toBe(true);
    });

    test('getActionCodeSettings() in test/emulator environment resolves to LOCAL_ACTION_CODE_SETTINGS', () => {
      const activeSettings = invitationService.getActionCodeSettings();
      expect(activeSettings.url).toBe(LOCAL_URL);
      expect(activeSettings.url).not.toContain('erp.ductsal.com');
      expect(activeSettings.handleCodeInApp).toBe(false);
    });

    test('getActionCodeSettings() resolves to PRODUCTION_ACTION_CODE_SETTINGS when running in pure production', () => {
      const simulatedProdEnv = {
        NODE_ENV: 'production',
        GCLOUD_PROJECT: 'ductsal-erp',
        GOOGLE_CLOUD_PROJECT: 'ductsal-erp'
      };
      const prodSettings = invitationService.getActionCodeSettings(simulatedProdEnv);
      expect(prodSettings.url).toBe(PROD_URL);
      expect(prodSettings.handleCodeInApp).toBe(false);
    });

    test('ACTION_CODE_SETTINGS export dynamically resolves to local URL during testing', () => {
      expect(invitationService.ACTION_CODE_SETTINGS.url).toBe(LOCAL_URL);
      expect(invitationService.ACTION_CODE_SETTINGS.url).not.toContain('erp.ductsal.com');
      expect(invitationService.ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });

    test('generateInvitationLink uses getActionCodeSettings() by default', async () => {
      let passedSettings = null;
      const fakeAuth = {
        generatePasswordResetLink: jest.fn(async (email, settings) => {
          passedSettings = settings;
          return `http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=fake123&continueUrl=${encodeURIComponent(settings.url)}`;
        })
      };

      const link = await invitationService.generateInvitationLink(fakeAuth, 'empleado@example.test');
      expect(passedSettings).not.toBeNull();
      expect(passedSettings.url).toBe(LOCAL_URL);
      expect(passedSettings.url).not.toContain('erp.ductsal.com');
      expect(passedSettings.handleCodeInApp).toBe(false);
      expect(link).toContain(encodeURIComponent(LOCAL_URL));
      expect(link).not.toContain('erp.ductsal.com');
    });
  });

  describe('2. crm_auth.js (Frontend Client Module Isolation)', () => {
    test('CrmAuth exports PRODUCTION_ACTION_CODE_SETTINGS and LOCAL_ACTION_CODE_SETTINGS', () => {
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS).toBeDefined();
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS.url).toBe(PROD_URL);
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);

      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS).toBeDefined();
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.url).toBe(LOCAL_URL);
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.url).not.toContain('erp.ductsal.com');
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });

    test('CrmAuth.getActionCodeSettings() in Node test environment resolves to local URL', () => {
      const settings = CrmAuth.getActionCodeSettings();
      expect(settings.url).toBe(LOCAL_URL);
      expect(settings.url).not.toContain('erp.ductsal.com');
      expect(settings.handleCodeInApp).toBe(false);
    });

    test('CrmAuth.sendPasswordSetupEmail passes local settings to auth.sendPasswordResetEmail', async () => {
      let sentSettings = null;
      const fakeFb = {
        auth: () => ({
          languageCode: 'en',
          sendPasswordResetEmail: jest.fn(async (email, settings) => {
            sentSettings = settings;
            return true;
          })
        })
      };

      await CrmAuth.sendPasswordSetupEmail(fakeFb, 'test@example.test');
      expect(sentSettings).not.toBeNull();
      expect(sentSettings.url).toBe(LOCAL_URL);
      expect(sentSettings.url).not.toContain('erp.ductsal.com');
      expect(sentSettings.handleCodeInApp).toBe(false);
    });

    test('browser environment simulation: on loopback with port, returns dynamic local origin', () => {
      const origWindow = globalThis.window;
      try {
        globalThis.window = {
          location: {
            protocol: 'http:',
            hostname: '127.0.0.1',
            host: '127.0.0.1:8123'
          }
        };

        const settings = CrmAuth.getActionCodeSettings();
        expect(settings.url).toBe('http://127.0.0.1:8123/login?mode=activate');
        expect(settings.url).not.toContain('erp.ductsal.com');
        expect(settings.handleCodeInApp).toBe(false);
      } finally {
        globalThis.window = origWindow;
      }
    });

    test('browser environment simulation: on production domain erp.ductsal.com, returns production URL', () => {
      const origWindow = globalThis.window;
      const origProcess = globalThis.process;
      try {
        globalThis.window = {
          location: {
            protocol: 'https:',
            hostname: 'erp.ductsal.com',
            host: 'erp.ductsal.com'
          }
        };
        // Temporarily hide process to test pure browser branch
        globalThis.process = undefined;

        const settings = CrmAuth.getActionCodeSettings();
        expect(settings.url).toBe(PROD_URL);
        expect(settings.handleCodeInApp).toBe(false);
      } finally {
        globalThis.window = origWindow;
        globalThis.process = origProcess;
      }
    });
  });

  describe('3. Automated Fatal Safety Assertion against Production URLs in Local Environment', () => {
    test('FATAL GUARD: fails if any continueUrl in the local environment targets erp.ductsal.com', () => {
      const checkUrlForLeak = (url, contextName) => {
        if (typeof url === 'string' && (url.includes('erp.ductsal.com') || url.includes('crm.ductsal.com'))) {
          throw new Error(`[FATAL LEAK DETECTED] Production URL leaked in local context "${contextName}": ${url}`);
        }
      };

      // 1. Backend local settings
      const backendSettings = invitationService.getActionCodeSettings();
      expect(() => checkUrlForLeak(backendSettings.url, 'invitationService.getActionCodeSettings')).not.toThrow();

      // 2. Backend ACTION_CODE_SETTINGS export
      expect(() => checkUrlForLeak(invitationService.ACTION_CODE_SETTINGS.url, 'invitationService.ACTION_CODE_SETTINGS')).not.toThrow();

      // 3. Frontend local settings
      const frontendSettings = CrmAuth.getActionCodeSettings();
      expect(() => checkUrlForLeak(frontendSettings.url, 'CrmAuth.getActionCodeSettings')).not.toThrow();

      // 4. Frontend ACTION_CODE_SETTINGS export
      expect(() => checkUrlForLeak(CrmAuth.ACTION_CODE_SETTINGS.url, 'CrmAuth.ACTION_CODE_SETTINGS')).not.toThrow();

      // 5. Verify the guard itself actually throws when given a production URL
      expect(() => checkUrlForLeak(PROD_URL, 'test-verification')).toThrow(/FATAL LEAK DETECTED/);
    });

    test('handleCodeInApp is strictly false across all local and production configurations', () => {
      expect(invitationService.PRODUCTION_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(invitationService.LOCAL_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(invitationService.ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
      expect(CrmAuth.ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });
  });
});
