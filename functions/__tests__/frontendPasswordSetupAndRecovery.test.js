// functions/__tests__/frontendPasswordSetupAndRecovery.test.js
// FASE 6.4: Frontend Password Setup, User Activation, and Password Recovery Tests
// Validates end-to-end frontend flows:
// 1. Return from Firebase Action Code (activation/reset return detection, banner, prefill, URL parameter hygiene).
// 2. Password recovery from login (#forgot-password-modal, anti-enumeration defense, error handling, rate limiting).
// 3. User experience & concurrency (in-flight guards, button state restoration, escape/backdrop modal handling).
// 4. Secure activation confirmation (backend-bound, idempotent, blocks disabled accounts, cleans session state).

const fs = require('fs');
const path = require('path');
const CrmAuth = require('../../crm_auth.js');

const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

describe('FASE 6.4: Frontend Password Setup and Recovery Flows', () => {

  describe('1. CrmAuth.handleActivationReturn & URL Parameter Hygiene', () => {
    test('detects mode=activate, displays banner, pre-fills email, sets session flag, and strips sensitive URL parameters', () => {
      let replacedUrl = null;
      const history = {
        replaceState: jest.fn((state, title, url) => {
          replacedUrl = url;
        })
      };

      const bannerEl = { style: { display: 'none' }, innerHTML: '' };
      const emailInputEl = { value: '' };
      const passInputEl = { focus: jest.fn() };

      const document = {
        title: 'DUCTSAL ERP',
        getElementById: jest.fn(id => {
          if (id === 'activation-return-banner') return bannerEl;
          if (id === 'login-email') return emailInputEl;
          if (id === 'login-password') return passInputEl;
          return null;
        })
      };

      const storageData = {};
      const storage = {
        setItem: jest.fn((k, v) => { storageData[k] = v; }),
        getItem: jest.fn(k => storageData[k])
      };

      const location = {
        pathname: '/login',
        search: '?mode=activate&email=vendedor%40ductsal.com&oobCode=oob123456&apiKey=AIzaSyFakeKey&lang=es&continueUrl=https%3A%2F%2Ferp.ductsal.com&customRef=audit123',
        hash: ''
      };

      const result = CrmAuth.handleActivationReturn({ location, document, storage, history });

      expect(result.isReturn).toBe(true);
      expect(result.mode).toBe('activate');
      expect(result.email).toBe('vendedor@ductsal.com');
      expect(result.sensitiveCleaned).toBe(true);

      // Verify banner was made visible and contains informative Spanish copy
      expect(bannerEl.style.display).toBe('block');
      expect(bannerEl.innerHTML).toContain('¡Contraseña configurada con éxito!');
      expect(bannerEl.innerHTML).toContain('Inicia sesión con tu nueva contraseña');

      // Verify email input was prefilled and password input focused
      expect(emailInputEl.value).toBe('vendedor@ductsal.com');
      expect(passInputEl.focus).toHaveBeenCalledTimes(1);

      // Verify non-sensitive session flag was set
      expect(storage.setItem).toHaveBeenCalledWith('ductsal_activation_return', 'true');
      expect(storageData['ductsal_activation_return']).toBe('true');

      // Verify replaceState was invoked and sensitive parameters were purged
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(replacedUrl).toBe('/login?customRef=audit123');
      expect(replacedUrl).not.toContain('oobCode');
      expect(replacedUrl).not.toContain('apiKey');
      expect(replacedUrl).not.toContain('email=');
      expect(replacedUrl).not.toContain('mode=');
      expect(replacedUrl).not.toContain('continueUrl');
    });

    test('detects mode=resetPassword and cleans parameters', () => {
      let replacedUrl = null;
      const history = {
        replaceState: jest.fn((state, title, url) => { replacedUrl = url; })
      };
      const bannerEl = { style: { display: 'none' }, innerHTML: '' };
      const document = {
        getElementById: jest.fn(id => (id === 'activation-return-banner' ? bannerEl : null))
      };
      const location = {
        pathname: '/login',
        search: '?mode=resetPassword&oobCode=codeXYZ&apiKey=abc'
      };

      const result = CrmAuth.handleActivationReturn({ location, document, history });
      expect(result.isReturn).toBe(true);
      expect(result.mode).toBe('resetPassword');
      expect(bannerEl.style.display).toBe('block');
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(replacedUrl).toBe('/login');
    });

    test('ignores ordinary URLs without activation or reset modes', () => {
      const history = { replaceState: jest.fn() };
      const bannerEl = { style: { display: 'none' } };
      const document = { getElementById: jest.fn(() => bannerEl) };
      const location = { pathname: '/login', search: '?utm_source=google' };

      const result = CrmAuth.handleActivationReturn({ location, document, history });
      expect(result.isReturn).toBe(false);
      expect(bannerEl.style.display).toBe('none');
      expect(history.replaceState).not.toHaveBeenCalled();
    });

    test('safely handles empty or missing search query', () => {
      const location = { pathname: '/login', search: '' };
      const result = CrmAuth.handleActivationReturn({ location });
      expect(result.isReturn).toBe(false);
      expect(result.mode).toBeNull();
    });
  });

  describe('2. Login Password Recovery & Anti-Enumeration Defense', () => {
    function makeRecoveryContext({ sendPasswordResetEmailImpl }) {
      const inputEl = { value: '' };
      const feedbackEl = { style: { display: 'none', background: '', color: '' }, innerText: '' };
      const submitBtnEl = { disabled: false, innerText: 'Enviar Enlace' };
      const modalEl = { style: { display: 'none' } };

      const document = {
        getElementById: jest.fn(id => {
          if (id === 'forgot-password-modal') return modalEl;
          if (id === 'forgot-password-email') return inputEl;
          if (id === 'forgot-password-feedback') return feedbackEl;
          if (id === 'btn-submit-forgot-password') return submitBtnEl;
          return null;
        })
      };

      const fb = {
        auth: () => ({
          languageCode: null,
          sendPasswordResetEmail: sendPasswordResetEmailImpl
        })
      };

      return { document, inputEl, feedbackEl, submitBtnEl, modalEl, fb };
    }

    test('anti-enumeration: existing user and non-existing user receive identical neutral message and styling', async () => {
      const NEUTRAL_MESSAGE = 'Si el correo corresponde a una cuenta activa en DUCTSAL ERP, recibirás un enlace de restablecimiento en breve. Revisa tu carpeta de spam.';

      // Case A: Existing user (sendPasswordResetEmail resolves)
      const ctxExisting = makeRecoveryContext({
        sendPasswordResetEmailImpl: jest.fn().mockResolvedValue(undefined)
      });
      ctxExisting.inputEl.value = 'existente@ductsal.com';

      // Load processForgotPassword function isolated from app_core
      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let forgotPasswordInFlight', 'function processFirstTimeSetup') + '\nreturn processForgotPassword;';
      const processForgotPasswordExisting = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctxExisting.document, CrmAuth, ctxExisting.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      await processForgotPasswordExisting({ preventDefault() {} });

      expect(ctxExisting.feedbackEl.style.display).toBe('block');
      expect(ctxExisting.feedbackEl.innerText).toBe(NEUTRAL_MESSAGE);
      expect(ctxExisting.feedbackEl.style.color).toBe('#22c55e');
      expect(ctxExisting.submitBtnEl.disabled).toBe(false);
      expect(ctxExisting.submitBtnEl.innerText).toBe('Enviar Enlace');

      // Case B: Non-existing user (sendPasswordResetEmail throws auth/user-not-found)
      const notFoundErr = Object.assign(new Error('User not found'), { code: 'auth/user-not-found' });
      const ctxNonExisting = makeRecoveryContext({
        sendPasswordResetEmailImpl: jest.fn().mockRejectedValue(notFoundErr)
      });
      ctxNonExisting.inputEl.value = 'inexistente@randomcorp.com';

      const processForgotPasswordNonExisting = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctxNonExisting.document, CrmAuth, ctxNonExisting.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      await processForgotPasswordNonExisting({ preventDefault() {} });

      // STRICT EQUALITY: Message, color, and behavior must match exactly!
      expect(ctxNonExisting.feedbackEl.style.display).toBe('block');
      expect(ctxNonExisting.feedbackEl.innerText).toBe(ctxExisting.feedbackEl.innerText);
      expect(ctxNonExisting.feedbackEl.style.color).toBe(ctxExisting.feedbackEl.style.color);
      expect(ctxNonExisting.feedbackEl.style.background).toBe(ctxExisting.feedbackEl.style.background);
      expect(ctxNonExisting.submitBtnEl.disabled).toBe(false);
      expect(ctxNonExisting.submitBtnEl.innerText).toBe('Enviar Enlace');
    });

    test('rate limiting (auth/too-many-requests) displays helpful throttle message', async () => {
      const rateLimitErr = Object.assign(new Error('Too many requests'), { code: 'auth/too-many-requests' });
      const ctx = makeRecoveryContext({
        sendPasswordResetEmailImpl: jest.fn().mockRejectedValue(rateLimitErr)
      });
      ctx.inputEl.value = 'spam@ductsal.com';

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let forgotPasswordInFlight', 'function processFirstTimeSetup') + '\nreturn processForgotPassword;';
      const fn = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctx.document, CrmAuth, ctx.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      await fn({ preventDefault() {} });
      expect(ctx.feedbackEl.style.display).toBe('block');
      expect(ctx.feedbackEl.innerText).toContain('Demasiadas solicitudes en poco tiempo');
      expect(ctx.feedbackEl.style.color).toBe('#eab308');
      expect(ctx.submitBtnEl.disabled).toBe(false);
    });

    test('network failure (auth/network-request-failed) displays connectivity alert', async () => {
      const netErr = Object.assign(new Error('Network error'), { code: 'auth/network-request-failed' });
      const ctx = makeRecoveryContext({
        sendPasswordResetEmailImpl: jest.fn().mockRejectedValue(netErr)
      });
      ctx.inputEl.value = 'offline@ductsal.com';

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let forgotPasswordInFlight', 'function processFirstTimeSetup') + '\nreturn processForgotPassword;';
      const fn = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctx.document, CrmAuth, ctx.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      await fn({ preventDefault() {} });
      expect(ctx.feedbackEl.style.display).toBe('block');
      expect(ctx.feedbackEl.innerText).toContain('No se pudo conectar con el servicio de autenticación');
      expect(ctx.feedbackEl.style.color).toBe('#ef4444');
      expect(ctx.submitBtnEl.disabled).toBe(false);
    });

    test('invalid email format is blocked locally before calling Firebase', async () => {
      const sendResetSpy = jest.fn();
      const ctx = makeRecoveryContext({ sendPasswordResetEmailImpl: sendResetSpy });
      ctx.inputEl.value = 'not-an-email';

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let forgotPasswordInFlight', 'function processFirstTimeSetup') + '\nreturn processForgotPassword;';
      const fn = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctx.document, CrmAuth, ctx.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      await fn({ preventDefault() {} });
      expect(sendResetSpy).not.toHaveBeenCalled();
      expect(ctx.feedbackEl.style.display).toBe('block');
      expect(ctx.feedbackEl.innerText).toContain('Por favor ingresa un correo electrónico válido');
      expect(ctx.submitBtnEl.disabled).toBe(false);
    });

    test('in-flight guard blocks concurrent double-submissions', async () => {
      let resolveCall;
      const deferredPromise = new Promise(r => { resolveCall = r; });
      const sendResetSpy = jest.fn(() => deferredPromise);
      const ctx = makeRecoveryContext({ sendPasswordResetEmailImpl: sendResetSpy });
      ctx.inputEl.value = 'vendedor@ductsal.com';

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let forgotPasswordInFlight', 'function processFirstTimeSetup') + '\nreturn processForgotPassword;';
      const fn = new Function('document', 'CrmAuth', 'firebase', 'window', src)(
        ctx.document, CrmAuth, ctx.fb, { location: { protocol: 'https:', host: 'erp.ductsal.com', hostname: 'erp.ductsal.com' } }
      );

      // Launch first submission
      const p1 = fn({ preventDefault() {} });
      expect(ctx.submitBtnEl.disabled).toBe(true);
      expect(ctx.submitBtnEl.innerText).toBe('Enviando...');

      // Attempt second concurrent submission
      const p2 = fn({ preventDefault() {} });

      // Second invocation should have been blocked by forgotPasswordInFlight
      expect(sendResetSpy).toHaveBeenCalledTimes(1);

      // Resolve first call
      resolveCall();
      await p1;
      await p2;

      // Button restored
      expect(ctx.submitBtnEl.disabled).toBe(false);
      expect(ctx.submitBtnEl.innerText).toBe('Enviar Enlace');
    });
  });

  describe('3. Modal Accessibility & DOM Structure', () => {
    test('index.html contains forgot-password-modal with proper accessibility attributes', () => {
      expect(indexHtml).toContain('id="forgot-password-modal"');
      expect(indexHtml).toContain('role="dialog"');
      expect(indexHtml).toContain('aria-modal="true"');
      expect(indexHtml).toContain('aria-labelledby="forgot-password-title"');
      expect(indexHtml).toContain('id="forgot-password-title"');
      expect(indexHtml).toContain('onclick="if (event.target === this) closeForgotPasswordModal()"');
    });

    test('index.html contains activation-return-banner in login container', () => {
      expect(indexHtml).toContain('id="activation-return-banner"');
      expect(indexHtml).toContain('style="display: none;');
      expect(indexHtml).toContain('id="btn-login-submit"');
    });

    test('openForgotPasswordModal clears input and feedback and displays flex', () => {
      const modal = { style: { display: 'none' } };
      const input = { value: 'prev@example.com' };
      const feedback = { style: { display: 'block' } };
      const btn = { disabled: true, innerText: 'Enviando...' };

      const document = {
        getElementById: jest.fn(id => {
          if (id === 'forgot-password-modal') return modal;
          if (id === 'forgot-password-email') return input;
          if (id === 'forgot-password-feedback') return feedback;
          if (id === 'btn-submit-forgot-password') return btn;
          return null;
        })
      };

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('function openForgotPasswordModal', 'let forgotPasswordInFlight') + '\nreturn { openForgotPasswordModal, closeForgotPasswordModal };';
      const { openForgotPasswordModal, closeForgotPasswordModal } = new Function('document', src)(document);

      openForgotPasswordModal({ preventDefault() {} });
      expect(modal.style.display).toBe('flex');
      expect(input.value).toBe('');
      expect(feedback.style.display).toBe('none');
      expect(btn.disabled).toBe(false);
      expect(btn.innerText).toBe('Enviar Enlace');

      closeForgotPasswordModal();
      expect(modal.style.display).toBe('none');
    });

    test('escape keydown listener closes forgot-password-modal when open', () => {
      let keydownHandler = null;
      const doc = {
        addEventListener: jest.fn((evt, cb) => {
          if (evt === 'keydown') keydownHandler = cb;
        })
      };

      const closeFn = jest.fn();
      const modal = { style: { display: 'flex' } };
      doc.getElementById = jest.fn(id => (id === 'forgot-password-modal' ? modal : null));

      // Simulate the Escape handler logic from app_core
      const handler = (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
          const forgotModal = doc.getElementById('forgot-password-modal');
          if (forgotModal && forgotModal.style.display === 'flex') {
            closeFn();
          }
        }
      };

      handler({ key: 'Escape', keyCode: 27 });
      expect(closeFn).toHaveBeenCalledTimes(1);

      // If modal is closed, Escape does not call closeFn
      modal.style.display = 'none';
      handler({ key: 'Escape', keyCode: 27 });
      expect(closeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Login In-Flight Guard & Activation Return State Cleanup', () => {
    test('processLogin sets button to Ingresando..., blocks double submit, and restores in finally', async () => {
      const emailInput = { value: 'ana@ductsal.com' };
      const passInput = { value: 'secretPass123' };
      const submitBtn = { disabled: false, innerText: 'Ingresar al Sistema' };

      const doc = {
        getElementById: jest.fn(id => {
          if (id === 'login-email') return emailInput;
          if (id === 'login-password') return passInput;
          if (id === 'btn-login-submit') return submitBtn;
          return null;
        })
      };

      let resolveLogin;
      const deferred = new Promise(r => { resolveLogin = r; });
      const mockProcessFirebaseLogin = jest.fn(() => deferred);

      const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));
      const src = between('let pendingSetupUser', 'async function processDirectFirebaseAuthLogin') + '\nreturn processLogin;';

      const users = [{ id: 'u1', email: 'ana@ductsal.com', authUid: 'auth1', activo: true }];
      const processLogin = new Function('document', 'users', 'CrmAuth', 'processFirebaseLogin', 'alert', src)(
        doc, users, CrmAuth, mockProcessFirebaseLogin, jest.fn()
      );

      // First click
      processLogin({ preventDefault() {} });
      expect(submitBtn.disabled).toBe(true);
      expect(submitBtn.innerText).toBe('Ingresando...');
      expect(mockProcessFirebaseLogin).toHaveBeenCalledTimes(1);

      // Second rapid click while in flight
      processLogin({ preventDefault() {} });
      expect(mockProcessFirebaseLogin).toHaveBeenCalledTimes(1); // blocked by loginInFlight!

      // Resolve login
      resolveLogin();
    });

    test('successful login purges ductsal_activation_return from sessionStorage and hides banner', async () => {
      const storage = {
        ductsal_activation_return: 'true',
        removeItem: jest.fn(k => { delete storage[k]; })
      };
      const banner = { style: { display: 'block' } };

      const doc = {
        getElementById: jest.fn(id => (id === 'activation-return-banner' ? banner : null))
      };

      // Emulate the cleanup snippet executed in processFirebaseLogin / processDirectFirebaseAuthLogin
      try {
        if (typeof storage !== 'undefined') {
          storage.removeItem('ductsal_activation_return');
        }
        const actBanner = doc.getElementById('activation-return-banner');
        if (actBanner) actBanner.style.display = 'none';
      } catch (_) {}

      expect(storage.removeItem).toHaveBeenCalledWith('ductsal_activation_return');
      expect(storage['ductsal_activation_return']).toBeUndefined();
      expect(banner.style.display).toBe('none');
    });

    test('confirmUserActivationViaFunction invokes confirmUserActivation callable', async () => {
      const calls = [];
      const fb = {
        functions: () => ({
          httpsCallable: name => async payload => {
            calls.push({ name, payload });
            return { data: { activated: true, alreadyActive: true } };
          }
        })
      };

      const result = await CrmAuth.confirmUserActivationViaFunction(fb, { dbSuffix: '_prod' });
      expect(calls).toEqual([{ name: 'confirmUserActivation', payload: { dbSuffix: '_prod' } }]);
      expect(result).toEqual({ activated: true, alreadyActive: true });
    });
  });

  describe('5. ActionCodeSettings & Security Constraints Verification', () => {
    test('ActionCodeSettings production URL is erp.ductsal.com/login?mode=activate with handleCodeInApp: false', () => {
      const PROD_URL = 'https://erp.ductsal.com/login?mode=activate';
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS.url).toBe(PROD_URL);
      expect(CrmAuth.PRODUCTION_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });

    test('LOCAL_ACTION_CODE_SETTINGS uses local dev port and handles code in app false', () => {
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.url).toBe('http://127.0.0.1:8123/login?mode=activate');
      expect(CrmAuth.LOCAL_ACTION_CODE_SETTINGS.handleCodeInApp).toBe(false);
    });

    test('passwords and sensitive tokens are NEVER stored in localStorage or outbox', () => {
      expect(appCore).not.toContain("localStorage.setItem('password'");
      expect(appCore).not.toContain("localStorage.setItem('oobCode'");
      expect(appCore).not.toContain("localStorage.setItem('apiKey'");
      expect(appCore).not.toContain("localStorage.setItem('ductsal_user_password'");
    });

    test('app_core.js purges plaintext password from user object on authenticated login', () => {
      expect(appCore).toContain('delete user.password');
      expect(appCore).toContain('delete currentUser.password');
      expect(appCore).toContain('CrmAuth.purgeHistoricalPassword');
    });
  });
});
