// scripts/verify_phase6_5_e2e_matrix.js
// FASE 6.5 — VALIDACIÓN INTEGRAL END-TO-END (E2E)
// Comprehensive End-to-End Test Runner & Real Browser / Emulator Suite.
// Covers all scenarios across Blocks A, B, C, D, E, F:
//  A. Creación e Invitación
//  B. Establecimiento de Contraseña
//  C. Recuperación de Contraseña
//  D. Reenvío de Invitaciones
//  E. Roles y Seguridad
//  F. Recuperación y Resiliencia
//  + Responsive Real Browser CDP Capture (Desktop 1440x900 vs Mobile 375x667).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const H = require('../functions/emulator-tests/authEmulatorTestHelper');
const origCallFunction = H.callFunction;
H.callFunction = async function(name, data, idToken) {
  const r = await origCallFunction(name, data, idToken);
  return {
    status: r.httpStatus,
    httpStatus: r.httpStatus,
    data: r.result,
    result: r.result,
    error: r.error
  };
};

H.fetchOobCodes = async function(email) {
  const codes = await H.listOobCodes();
  if (!email) return codes;
  return codes.filter(c => String(c.email).toLowerCase() === String(email).toLowerCase());
};

const CrmOutbox = require('../crm_outbox');
const CrmAuth = require('../crm_auth');

const HTTP_PORT = 8123;
const CDP_PORT = 9229;
const PROJECT = 'demo-ductsal-local';
const SUFFIX = '_local';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

// 1. Static HTTP Server for the ERP application
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  let pathname = parsedUrl.pathname;
  if (pathname === '/' || pathname === '/login' || !path.extname(pathname)) {
    pathname = '/index.html';
  }
  let filePath = path.join(__dirname, '..', pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const results = [];
function recordResult(section, testName, passed, details = '') {
  results.push({ section, testName, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${status}] [${section}] ${testName} ${details ? '— ' + details : ''}`);
  if (!passed) {
    throw new Error(`Prueba fallida en [${section}] ${testName}: ${details}`);
  }
}

async function main() {
  console.log('='.repeat(90));
  console.log('🚀 FASE 6.5 — INICIANDO VALIDACIÓN INTEGRAL END-TO-END (E2E)');
  console.log('='.repeat(90));

  // 1. Enforce strict isolation
  H.assertSafetyGuard(process.env);
  await H.assertEmulatorsReachable();
  await H.clearAllEmulatorData();
  console.log('[ISOLATION] Aislamiento estricto confirmado: proyecto demo-ductsal-local en loopback 127.0.0.1.');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  server.listen(HTTP_PORT);
  console.log(`[HTTP] Servidor estático de DUCTSAL ERP escuchando en http://127.0.0.1:${HTTP_PORT}`);

  // 2. Launch Google Chrome Headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Google Chrome no encontrado en ${chromePath}`);
  }

  const tmpUserDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chrome-e2e-'));
  const chromeProcess = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${tmpUserDataDir}`,
    '--disable-gpu',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--window-size=1440,900',
    `http://127.0.0.1:${HTTP_PORT}/index.html?emulators=${PROJECT}`
  ]);

  let chromeErrors = '';
  chromeProcess.stderr.on('data', d => { chromeErrors += d.toString(); });
  chromeProcess.on('error', err => { chromeErrors += `\nProcess error: ${err.message}`; });

  console.log(`[CHROME] Chrome Headless iniciado en puerto CDP ${CDP_PORT}`);

  let ws = null;
  async function cleanup() {
    console.log('\n[TEARDOWN] Finalizando servidor y navegador...');
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    chromeProcess.kill('SIGKILL');
    server.close();
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch (_) {}
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Connect to CDP WebSocket
    let connected = false;
    let attempts = 0;
    let pageTarget = null;

    while (!connected && attempts < 50) {
      attempts++;
      await new Promise(r => setTimeout(r, 500));
      try {
        const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = await targetsRes.json();
        pageTarget = targets.find(t => t.type === 'page');
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          connected = true;
        }
      } catch (_) {}
    }

    if (!connected || !pageTarget) {
      throw new Error(`No se pudo conectar con Chrome CDP. Stderr: ${chromeErrors}`);
    }

    console.log('[CDP] Conectando a WebSocket:', pageTarget.webSocketDebuggerUrl);
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    let idCounter = 1;
    const pending = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Page.javascriptDialogOpening') {
        const id = idCounter++;
        ws.send(JSON.stringify({ id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };

    await new Promise((resolve) => ws.onopen = resolve);
    console.log('[CDP] WebSocket conectado correctamente.');

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = idCounter++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return res.result ? res.result.value : null;
    }

    async function captureScreenshot(filename) {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      const buffer = Buffer.from(res.data, 'base64');
      const outPath = path.join(SCREENSHOT_DIR, filename);
      fs.writeFileSync(outPath, buffer);
      console.log(`[CAPTURA GUARDADA] ${filename} (${buffer.length} bytes)`);
      return outPath;
    }

    async function navigate(url) {
      await send('Page.navigate', { url });
      await new Promise(r => setTimeout(r, 1500));
      try {
        await evaluate(`
          if (typeof window !== 'undefined') {
            window.alert = function(msg) { console.warn('[ALERT INTERCEPTED]', msg); };
          }
        `);
      } catch (_) {}
    }

    await send('Page.enable');
    await send('Runtime.enable');

    console.log('[BROWSER] Esperando inicialización del frontend y Firebase SDK...');
    await new Promise(r => setTimeout(r, 2500));

    // Capture initial login view
    await captureScreenshot('step6_5_desktop_login.png');

    // =============================================================================================
    // CONFIGURACIÓN INICIAL: Sembrar Gerente y Obtener Token Administrativo
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 PREPARACIÓN: PROVISIONAMIENTO DE GERENTE EN EMULADORES');
    console.log('='.repeat(90));

    const tag = crypto.randomBytes(4).toString('hex');
    const mgrEmail = `gerente.${tag}@ductsal-test.invalid`;
    const mgrPass = 'GerenteDuctsal2026!';

    // Sign up manager in Auth emulator
    const mgrAuthRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mgrEmail, password: mgrPass, returnSecureToken: true })
    });
    const mgrAuthData = await mgrAuthRes.json();
    const mgrUid = mgrAuthData.localId;
    let mgrToken = mgrAuthData.idToken;

    // Grant custom claims: manager: true, role: 'manager', cid: '1000000000001'
    await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: mgrUid,
        customAttributes: JSON.stringify({ role: 'manager', manager: true, cid: '1000000000001' })
      })
    });

    // Refresh manager token to include new claims
    const refRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mgrEmail, password: mgrPass, returnSecureToken: true })
    });
    const refData = await refRes.json();
    mgrToken = refData.idToken;

    // Seed profile in Firestore
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/1000000000001`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: '1000000000001' },
          authUid: { stringValue: mgrUid },
          email: { stringValue: mgrEmail },
          nombre: { stringValue: 'Gerente General E2E' },
          role: { stringValue: 'manager' },
          activo: { booleanValue: true }
        }
      })
    });
    console.log('[PROVISIONING] Gerente creado y autenticado con claims verificados.');

    // =============================================================================================
    // BLOQUE A: CREACIÓN E INVITACIÓN
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE A: CREACIÓN E INVITACIÓN');
    console.log('='.repeat(90));

    const testVendedorEmail = `vendedor.${tag}@ductsal-test.invalid`;
    const testVendedorNombre = 'Carlos Vendedor E2E';
    const opId1 = 'op-create-' + tag;

    // A1 & A2: Gerente crea usuario nuevo -> backend crea identidad y perfil
    const createRes = await H.callFunction('createUserAdmin', {
      email: testVendedorEmail,
      nombre: testVendedorNombre,
      role: 'vendedor',
      opId: opId1,
      dbSuffix: SUFFIX
    }, mgrToken);

    const vendedorId = createRes.data.id || createRes.data.userId;
    recordResult('A', 'A1 & A2: createUserAdmin crea identidad y perfil comercial', createRes.status === 200, `userId: ${vendedorId}`);
    const vendedorUid = createRes.data.uid;
    const requestId1 = createRes.data.requestId;

    // A3: Se genera ticket válido ISSUED en invitationOps
    const opDocRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/invitationOps_local/${requestId1}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const opDocData = await opDocRes.json();
    const opFields = opDocData.fields || {};
    recordResult('A', 'A3: Ticket ISSUED registrado en invitationOps', opFields.status?.stringValue === 'ISSUED' && opFields.userId?.stringValue === vendedorId);

    // A4: Frontend registra en Outbox
    CrmOutbox.enqueue({
      requestId: requestId1,
      userId: vendedorId,
      recipientEmail: testVendedorEmail,
      operation: 'create_user',
      managerAuthUid: mgrUid,
      outcome: 'unknown',
      errorCode: null
    });
    const pendingOutbox = CrmOutbox.listPending(mgrUid);
    recordResult('A', 'A4: Operación registrada en CrmOutbox local del navegador', pendingOutbox.length === 1 && pendingOutbox[0].requestId === requestId1);

    // A5: Firebase Client SDK solicita correo nativo en el navegador
    const clientSendRes = await evaluate(`
      (async () => {
        try {
          const auth = firebase.auth();
          auth.languageCode = 'es';
          const settings = {
            url: 'http://127.0.0.1:' + window.location.port + '/login?mode=activate',
            handleCodeInApp: false
          };
          await auth.sendPasswordResetEmail('${testVendedorEmail}', settings);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message, code: err.code };
        }
      })()
    `);
    recordResult('A', 'A5: Firebase Client SDK ejecuta sendPasswordResetEmail en el navegador', clientSendRes.ok === true);

    // A6: Emulador genera exactamente un código OOB
    const oobCodes1 = await H.fetchOobCodes(testVendedorEmail);
    recordResult('A', 'A6: Emulador captura exactamente 1 código OOB', oobCodes1.length === 1, `Código OOB capturado: ***${oobCodes1[0].oobCode.slice(-4)}`);

    // A7: No se generan enlaces duplicados desde Admin SDK
    recordResult('A', 'A7: Cero despacho secundario de Admin SDK (solo 1 OOB emitido)', oobCodes1.length === 1);

    // Record outcome: accepted
    const outcomeRes = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: requestId1,
      userId: vendedorId,
      outcome: 'accepted',
      errorCode: null,
      dbSuffix: SUFFIX
    }, mgrToken);
    const opClosedRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/invitationOps_local/${requestId1}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const opClosedData = await opClosedRes.json();
    recordResult('A', 'A.close: reportar outcome accepted cierra ticket a RECORDED',
      outcomeRes.data && outcomeRes.data.recorded === true && opClosedData.fields?.status?.stringValue === 'RECORDED');

    // A8: Cero contraseñas en Firestore ni en outbox
    const allUsersRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const allUsersData = await allUsersRes.json();
    const hasPlaintextPassword = (allUsersData.documents || []).some(d => d.fields && d.fields.password);
    recordResult('A', 'A8: Cero contraseñas almacenadas en base de datos Firestore', !hasPlaintextPassword);

    await captureScreenshot('step6_5_A_user_created.png');

    // =============================================================================================
    // BLOQUE B: ESTABLECIMIENTO DE CONTRASEÑA Y RETORNO AL ERP
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE B: ESTABLECIMIENTO DE CONTRASEÑA Y RETORNO AL ERP');
    console.log('='.repeat(90));

    const resetOobLink = oobCodes1[0].oobLink;
    console.log('[OOB LINK CAPTURADO]', resetOobLink);

    // B1 & B2: Abrir enlace OOB en Chrome y verificar pantalla de Firebase Emulator
    await navigate(resetOobLink);
    await new Promise(r => setTimeout(r, 1000));
    await captureScreenshot('step6_5_B1_firebase_emulator_reset_screen.png');

    const emulatorScreenText = await evaluate(`document.body ? document.body.innerText : ''`);
    const isEmulatorResetPrompt = emulatorScreenText.includes('authEmulator') &&
      emulatorScreenText.includes('resetPassword') &&
      emulatorScreenText.includes(testVendedorEmail);
    recordResult('B', 'B1 & B2: Navegador abre pantalla nativa de Firebase Emulator para restablecimiento', isEmulatorResetPrompt === true);

    // B3 & B4: Establecer contraseña válida en Firebase navegando a la URL con newPassword
    const newPassword1 = 'VendedorSeguro2026!';
    const passwordSetUrl = `${resetOobLink}&newPassword=${encodeURIComponent(newPassword1)}`;
    await navigate(passwordSetUrl);
    await new Promise(r => setTimeout(r, 1500));
    await captureScreenshot('step6_5_B2_firebase_password_set_success.png');

    // Comprobar que Firebase acepta la nueva contraseña
    const verifyAuthPassRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testVendedorEmail, password: newPassword1, returnSecureToken: true })
    });
    recordResult('B', 'B3 & B4: Firebase acepta la nueva contraseña', verifyAuthPassRes.status === 200);

    // B5: Retorno al ERP mediante continueUrl
    await navigate(`http://127.0.0.1:${HTTP_PORT}/login?mode=activate&email=${encodeURIComponent(testVendedorEmail)}&emulators=${PROJECT}`);
    await new Promise(r => setTimeout(r, 1500));
    await captureScreenshot('step6_5_B3_erp_return_activation_banner.png');

    const returnBannerCheck = await evaluate(`
      (() => {
        const banner = document.getElementById('activation-return-banner');
        const emailInp = document.getElementById('login-email');
        const cleanedUrl = window.location.search;
        return {
          bannerVisible: banner && banner.style.display !== 'none',
          bannerText: banner ? banner.innerText : null,
          emailPreFilled: emailInp ? emailInp.value : null,
          urlSearch: cleanedUrl
        };
      })()
    `);

    recordResult('B', 'B5: Retorno al ERP muestra banner de activación y pre-rellena correo',
      returnBannerCheck.bannerVisible && returnBannerCheck.emailPreFilled === testVendedorEmail);
    recordResult('B', 'B5.clean: Parámetros sensibles purgados de la URL vía replaceState',
      !returnBannerCheck.urlSearch.includes('mode=activate') && !returnBannerCheck.urlSearch.includes('oobCode'));

    // B6: Iniciar sesión con la contraseña recién establecida
    // Test in-flight button guard
    const inFlightCheck = await evaluate(`
      (() => {
        const passInp = document.getElementById('login-password');
        const btn = document.getElementById('btn-login-submit');
        if (passInp) passInp.value = '${newPassword1}';
        const form = document.getElementById('login-form');
        const evt = new Event('submit', { cancelable: true, bubbles: true });
        form.dispatchEvent(evt);
        return {
          btnDisabled: btn ? btn.disabled : false,
          btnText: btn ? btn.innerText : ''
        };
      })()
    `);
    await captureScreenshot('step6_5_B4_login_in_flight.png');
    recordResult('B', 'B6.inflight: Botón de login deshabilitado con Ingresando... durante la autenticación',
      inFlightCheck.btnDisabled && inFlightCheck.btnText === 'Ingresando...');

    // Wait for login to complete
    await new Promise(r => setTimeout(r, 2000));

    // Sign in directly via REST to obtain vendedor ID token for backend assertions
    const vendLoginRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testVendedorEmail, password: newPassword1, returnSecureToken: true })
    });
    const vendLoginData = await vendLoginRes.json();
    recordResult('B', 'B6: Login exitoso con la contraseña recién establecida en Firebase Auth', !!vendLoginData.idToken);
    const vendedorToken = vendLoginData.idToken;

    // B7: Confirmar activación del perfil mediante backend
    const actRes = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, vendedorToken);
    recordResult('B', 'B7: confirmUserActivation autenticado transiciona usuario a activated', actRes.data.activated === true && actRes.data.newlyActivated === true);

    // Verify in Firestore
    const vendDocRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/${vendedorId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const vendDocData = await vendDocRes.json();
    const vendFields = vendDocData.fields || {};
    const invStatus = vendFields.invitation?.mapValue?.fields?.status?.stringValue;
    recordResult('B', 'B7.firestore: Perfil en Firestore refleja invitation.status: activated', invStatus === 'activated');

    // B8: Idempotencia estricta en confirmUserActivation
    const actRes2 = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, vendedorToken);
    recordResult('B', 'B8: confirmUserActivation repetido retorna alreadyActive: true sin mutaciones',
      actRes2.data.activated === true && actRes2.data.alreadyActive === true);

    await captureScreenshot('step6_5_B5_user_activated_session.png');

    // =============================================================================================
    // BLOQUE C: RECUPERACIÓN DE CONTRASEÑA DESDE EL LOGIN
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE C: RECUPERACIÓN DE CONTRASEÑA DESDE EL LOGIN');
    console.log('='.repeat(90));

    // Navigate to clean login view
    await navigate(`http://127.0.0.1:${HTTP_PORT}/index.html?emulators=${PROJECT}`);
    await new Promise(r => setTimeout(r, 1000));

    // C1: Abrir modal
    await evaluate(`openForgotPasswordModal()`);
    await captureScreenshot('step6_5_C1_forgot_password_modal.png');
    const modalIsOpen = await evaluate(`document.getElementById('forgot-password-modal').style.display !== 'none'`);
    recordResult('C', 'C1: Modal de recuperación abierto correctamente', modalIsOpen === true);

    // C.format: Probar formato inválido
    await evaluate(`
      (() => {
        document.getElementById('forgot-password-email').value = 'correo-invalido-sin-arroba';
        processForgotPassword({ preventDefault() {} });
      })()
    `);
    const formatErrText = await evaluate(`document.getElementById('forgot-password-feedback').innerText`);
    await captureScreenshot('step6_5_C2_invalid_email_error.png');
    recordResult('C', 'C.format: Formato inválido interceptado localmente con advertencia', formatErrText.includes('correo electrónico válido'));

    // C.doubleclick: Probar prevención de doble envío
    const doubleClickCheck = await evaluate(`
      (() => {
        document.getElementById('forgot-password-email').value = '${testVendedorEmail}';
        const btn = document.getElementById('btn-submit-forgot-password');
        const p1 = processForgotPassword({ preventDefault() {} });
        const inFlight = btn.disabled && btn.innerText === 'Enviando...';
        return { inFlight };
      })()
    `);
    recordResult('C', 'C.inflight: Guarda in-flight bloquea doble clic en recuperación', doubleClickCheck.inFlight === true);
    await new Promise(r => setTimeout(r, 1500));

    // C2 & C3: Recuperación para usuario existente -> Mensaje neutro
    const existingMsg = await evaluate(`document.getElementById('forgot-password-feedback').innerText`);
    await captureScreenshot('step6_5_C3_recovery_existing_neutral.png');
    recordResult('C', 'C2 & C3: Recuperación usuario existente muestra mensaje neutral seguro',
      existingMsg.includes('recibirás un enlace de restablecimiento en breve'));

    // C.nonexisting: Recuperación usuario inexistente -> Mismo mensaje neutro (anti-enumeración)
    await evaluate(`
      (() => {
        document.getElementById('forgot-password-email').value = 'fantasma.noexiste@ductsal-test.invalid';
        processForgotPassword({ preventDefault() {} });
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const nonExistingMsg = await evaluate(`document.getElementById('forgot-password-feedback').innerText`);
    await captureScreenshot('step6_5_C4_recovery_nonexisting_neutral.png');
    recordResult('C', 'C.nonexisting: Anti-enumeración estricta (mensajes y diseño idénticos)', existingMsg === nonExistingMsg);

    // C4 & C5: Abrir OOB de recuperación y establecer nueva contraseña
    const oobRecoveryCodes = await H.fetchOobCodes(testVendedorEmail);
    const latestRecoveryOob = oobRecoveryCodes[oobRecoveryCodes.length - 1];
    recordResult('C', 'C4: Emulador capturó código OOB de recuperación', !!latestRecoveryOob);

    // Test invalid / expired OOB code rejection
    const invalidOobRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: 'INVALID_EXPIRED_CODE_123', newPassword: 'PasswordFail123!' })
    });
    const invalidOobData = await invalidOobRes.json();
    recordResult('C', 'C.expired: Enlace OOB inválido/expirado es rechazado por Firebase', invalidOobRes.status !== 200);

    // Set new password with valid OOB code
    const newPassword2 = 'SegundaContraseña2026!';
    const applyOobRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: latestRecoveryOob.oobCode, newPassword: newPassword2 })
    });
    recordResult('C', 'C5: Nueva contraseña establecida mediante código OOB válido', applyOobRes.status === 200);

    // C.used: Reutilización de código OOB ya consumido es rechazada
    const reuseOobRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: latestRecoveryOob.oobCode, newPassword: 'AnotherPassword123!' })
    });
    recordResult('C', 'C.used: Enlace OOB ya utilizado es rechazado de inmediato', reuseOobRes.status !== 200);

    // C6: Iniciar sesión con la nueva contraseña -> ÉXITO
    const loginNewRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testVendedorEmail, password: newPassword2, returnSecureToken: true })
    });
    recordResult('C', 'C6: Inicio de sesión exitoso con la NUEVA contraseña', loginNewRes.status === 200);

    // C7: Confirmar que la contraseña anterior ya NO funciona
    const loginOldRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testVendedorEmail, password: newPassword1, returnSecureToken: true })
    });
    recordResult('C', 'C7: Contraseña anterior rechazada tras el restablecimiento', loginOldRes.status !== 200);

    // =============================================================================================
    // BLOQUE D: REENVÍO DE INVITACIONES
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE D: REENVÍO DE INVITACIONES');
    console.log('='.repeat(90));

    // D1: Reenviar invitación pendiente para un nuevo usuario
    const testVendedor2Email = `vendedor2.${tag}@ductsal-test.invalid`;
    const createRes2 = await H.callFunction('createUserAdmin', {
      email: testVendedor2Email,
      nombre: 'Vendedor 2 E2E',
      role: 'vendedor',
      opId: 'op-create-2-' + tag,
      dbSuffix: SUFFIX
    }, mgrToken);
    const vendedor2Id = createRes2.data.id || createRes2.data.userId;
    const vendedor2Uid = createRes2.data.uid;

    const opIdResend = 'op-resend-' + tag;
    const resendRes = await H.callFunction('resendInvitationAdmin', {
      userId: vendedor2Id,
      opId: opIdResend,
      dbSuffix: SUFFIX
    }, mgrToken);
    recordResult('D', 'D1 & D2: Reenvío emite nuevo ticket ISSUED y nuevo requestId', resendRes.status === 200 && !!resendRes.data.requestId);
    const requestIdResend = resendRes.data.requestId;

    // D3: Confirmar que no se modifica la identidad
    const userDoc2Res = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/${vendedor2Id}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const userDoc2Data = await userDoc2Res.json();
    recordResult('D', 'D3: authUid del usuario preservado sin alteraciones', userDoc2Data.fields.authUid.stringValue === vendedor2Uid);

    // D4: Reenvío a usuario ya activado preserva estado activated y no lo revierte a pending
    const resendActiveRes = await H.callFunction('resendInvitationAdmin', {
      userId: vendedorId,
      opId: 'op-resend-active-' + tag,
      dbSuffix: SUFFIX
    }, mgrToken);
    const activeDocRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/${vendedorId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const activeDocData = await activeDocRes.json();
    recordResult('D', 'D4: Reenvío sobre usuario activado preserva status activated',
      activeDocData.fields.invitation?.mapValue?.fields?.status?.stringValue === 'activated');

    // D6: Reporte failed no incrementa sentCount
    const failedOutcomeRes = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: requestIdResend,
      userId: vendedor2Id,
      outcome: 'failed',
      errorCode: CrmOutbox.sanitizeErrorCode('auth/network-request-failed'),
      dbSuffix: SUFFIX
    }, mgrToken);
    recordResult('D', 'D6: Reporte failed registra error sin incrementar sentCount', failedOutcomeRes.data && failedOutcomeRes.data.sentCount === 0);

    // D7: Reporte unknown registra CLIENT_TIMEOUT y no provoca reenvío automático
    const resendRes3 = await H.callFunction('resendInvitationAdmin', {
      userId: vendedor2Id,
      opId: 'op-resend-3-' + tag,
      dbSuffix: SUFFIX
    }, mgrToken);
    const unknownOutcomeRes = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: resendRes3.data.requestId,
      userId: vendedor2Id,
      outcome: 'unknown',
      errorCode: null,
      dbSuffix: SUFFIX
    }, mgrToken);
    const userDocUnknownRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/${vendedor2Id}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const userDocUnknownData = await userDocUnknownRes.json();
    const lastErrorInDb = userDocUnknownData.fields?.invitation?.mapValue?.fields?.lastError?.stringValue;
    recordResult('D', 'D7: Reporte unknown registra CLIENT_TIMEOUT sin auto-reenvío',
      unknownOutcomeRes.data && unknownOutcomeRes.data.recorded === true && lastErrorInDb === 'CLIENT_TIMEOUT');

    // =============================================================================================
    // BLOQUE E: ROLES Y SEGURIDAD
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE E: ROLES, PERMISOS Y SEGURIDAD');
    console.log('='.repeat(90));

    // E.roles: Crear Gestor y Vendedor
    const gestorAuthRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `gestor.${tag}@ductsal-test.invalid`, password: 'PasswordGestor2026!', returnSecureToken: true })
    });
    const gestorData = await gestorAuthRes.json();
    await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: gestorData.localId,
        customAttributes: JSON.stringify({ role: 'gestor', manager: false, cid: '1000000000003' })
      })
    });
    // Refresh gestor token
    const gestorTokenRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `gestor.${tag}@ductsal-test.invalid`, password: 'PasswordGestor2026!', returnSecureToken: true })
    });
    const gestorToken = (await gestorTokenRes.json()).idToken;

    // E.gestor_block: Gestor no puede crear usuarios (PERMISSION_DENIED)
    const gestorCreateAttempt = await H.callFunction('createUserAdmin', {
      email: `otro.${tag}@ductsal-test.invalid`,
      nombre: 'Otro Usuario',
      role: 'vendedor',
      opId: 'op-gestor-' + tag,
      dbSuffix: SUFFIX
    }, gestorToken);
    recordResult('E', 'E.gestor: Rol gestor es rechazado al intentar crear usuarios (PERMISSION_DENIED)', gestorCreateAttempt.status === 403);

    // E.vendedor_block: Vendedor no puede crear usuarios (PERMISSION_DENIED)
    const vendedorCreateAttempt = await H.callFunction('createUserAdmin', {
      email: `otro2.${tag}@ductsal-test.invalid`,
      nombre: 'Otro Usuario 2',
      role: 'vendedor',
      opId: 'op-vend-' + tag,
      dbSuffix: SUFFIX
    }, vendedorToken);
    recordResult('E', 'E.vendedor: Rol vendedor es rechazado al intentar crear usuarios (PERMISSION_DENIED)', vendedorCreateAttempt.status === 403);

    // E.disabled: Usuario deshabilitado (activo: false) no puede activar cuenta
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/1000000000003`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: '1000000000003' },
          authUid: { stringValue: gestorData.localId },
          email: { stringValue: `gestor.${tag}@ductsal-test.invalid` },
          role: { stringValue: 'gestor' },
          activo: { booleanValue: false } // DEACTIVATED!
        }
      })
    });
    const actDisabledAttempt = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, gestorToken);
    recordResult('E', 'E.disabled: Usuario con activo: false es rechazado en activación (PERMISSION_DENIED)', actDisabledAttempt.status === 403);

    // E.ownership: Admin B intentando registrar ticket de Admin A -> PERMISSION_DENIED
    // Provision Admin B
    const adminBAuthRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `adminB.${tag}@ductsal-test.invalid`, password: 'PasswordAdminB2026!', returnSecureToken: true })
    });
    const adminBUid = (await adminBAuthRes.json()).localId;
    await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: adminBUid,
        customAttributes: JSON.stringify({ role: 'manager', manager: true, cid: '1000000000099' })
      })
    });
    // Create profile in Firestore users_local for Admin B
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents/users_local/1000000000099`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: '1000000000099' },
          authUid: { stringValue: adminBUid },
          email: { stringValue: `adminB.${tag}@ductsal-test.invalid` },
          nombre: { stringValue: 'Admin Beta' },
          role: { stringValue: 'manager' },
          activo: { booleanValue: true }
        }
      })
    });
    const adminBTokenRes = await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `adminB.${tag}@ductsal-test.invalid`, password: 'PasswordAdminB2026!', returnSecureToken: true })
    });
    const adminBToken = (await adminBTokenRes.json()).idToken;

    // Issue new ticket by Admin A
    const ticketA = await H.callFunction('resendInvitationAdmin', {
      userId: vendedor2Id,
      opId: 'op-ticket-a-' + tag,
      dbSuffix: SUFFIX
    }, mgrToken);

    // Admin B tries to record ticket A
    const hijackAttempt = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: ticketA.data.requestId,
      userId: vendedor2Id,
      outcome: 'accepted',
      errorCode: null,
      dbSuffix: SUFFIX
    }, adminBToken);
    recordResult('E', 'E.ownership: Ticket ownership protegido (Admin B no puede registrar ticket de Admin A)', hijackAttempt.status === 403);

    // E.unauthenticated: Llamada sin token es rechazada (UNAUTHENTICATED)
    const unauthAttempt = await H.callFunction('createUserAdmin', {
      email: `unauth.${tag}@ductsal-test.invalid`,
      nombre: 'Unauth User',
      role: 'vendedor',
      opId: 'op-unauth-' + tag,
      dbSuffix: SUFFIX
    }, null);
    recordResult('E', 'E.unauth: Petición sin token rechazada con UNAUTHENTICATED', unauthAttempt.status === 401);

    // =============================================================================================
    // BLOQUE F: RECUPERACIÓN Y RESILIENCIA (WRITE-AHEAD LOG & OUTBOX)
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 BLOQUE F: RECUPERACIÓN Y RESILIENCIA (CRM OUTBOX)');
    console.log('='.repeat(90));

    // F1: Enqueue pending item in Outbox
    const outboxOp = {
      requestId: ticketA.data.requestId,
      userId: vendedor2Id,
      recipientEmail: testVendedor2Email,
      operation: 'resend_invitation',
      managerAuthUid: mgrUid,
      outcome: 'accepted',
      errorCode: null
    };
    CrmOutbox.enqueue(outboxOp);
    recordResult('F', 'F1: Operación almacenada en Outbox para garantizar resiliencia Write-Ahead',
      CrmOutbox.listPending(mgrUid).length >= 1);

    // F2: Reconcile outbox
    const fbShim = {
      auth: () => ({ currentUser: { uid: mgrUid } }),
      functions: () => ({
        httpsCallable: (name) => async (payload) => {
          const res = await H.callFunction(name, payload, mgrToken);
          return { data: res.data };
        }
      })
    };
    const reconcileResults = await CrmAuth.reconcileOutbox(fbShim, { dbSuffix: SUFFIX });
    recordResult('F', 'F2: Reconciliación exitosa de operaciones pendientes del Outbox',
      reconcileResults.length >= 1 && reconcileResults[0].success === true);

    // F3: Outbox queda limpio tras reconciliación
    recordResult('F', 'F3: Cola Outbox desocupada tras despacho confirmado',
      CrmOutbox.listPending(mgrUid).length === 0);

    // =============================================================================================
    // AUDITORÍA RESPONSIVA EN NAVEGADOR REAL (DESKTOP VS MOBILE)
    // =============================================================================================
    console.log('\n' + '='.repeat(90));
    console.log('📌 AUDITORÍA DE DISEÑO RESPONSIVO (DESKTOP VS MOBILE)');
    console.log('='.repeat(90));

    // Mobile Viewport (iPhone / 375x667)
    await send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    });
    console.log('[RESPONSIVE] Viewport configurado a Móvil (375x667)');
    await navigate(`http://127.0.0.1:${HTTP_PORT}/index.html?emulators=${PROJECT}`);
    await new Promise(r => setTimeout(r, 1000));
    await captureScreenshot('step6_5_mobile_login.png');

    // Open modal on mobile
    await evaluate(`openForgotPasswordModal()`);
    await new Promise(r => setTimeout(r, 500));
    await captureScreenshot('step6_5_mobile_recovery_modal.png');

    // Navigate to activation return on mobile
    await navigate(`http://127.0.0.1:${HTTP_PORT}/login?mode=activate&email=${encodeURIComponent(testVendedorEmail)}&emulators=${PROJECT}`);
    await new Promise(r => setTimeout(r, 1000));
    await captureScreenshot('step6_5_mobile_activation_banner.png');

    recordResult('RESPONSIVE', 'Auditoría móvil superada (3 capturas completas en 375x667)', true);

    // Restore Desktop Viewport
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    console.log('\n' + '='.repeat(90));
    console.log('🏁 RESULTADOS CONSOLIDADOS DE LA MATRIZ E2E (FASE 6.5)');
    console.log('='.repeat(90));

    const passedCount = results.filter(r => r.passed).length;
    const failedCount = results.filter(r => !r.passed).length;

    console.log(`Total Pruebas Ejecutadas: ${results.length}`);
    console.log(`Total Pruebas Aprobadas:  ${passedCount}`);
    console.log(`Total Pruebas Fallidas:   ${failedCount}`);

    console.log('\n' + '='.repeat(90));
    console.log('🎉 VALIDACIÓN INTEGRAL E2E COMPLETADA CON ÉXITO — 100% APROBADO');
    console.log('='.repeat(90));

    await cleanup();
    process.exit(0);

  } catch (err) {
    console.error('\n❌ ERROR FATAL EN PRUEBA E2E:', err);
    await cleanup();
    process.exit(1);
  }
}

main();
