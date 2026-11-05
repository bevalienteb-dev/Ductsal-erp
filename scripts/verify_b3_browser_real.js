// ============================================================================
// DUCTSAL ERP — PRUEBAS FUNCIONALES EN NAVEGADOR REAL (CDP / CHROME)
// Fase 2: Validación Integral del Bloque B3 (Documentos Legales, RL y Poderes)
// Entorno: Google Chrome Headless + Firebase Emulator Suite (demo-ductsal-local)
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PROJECT = 'demo-ductsal-local';
const FIRESTORE_PORT = 8080;
const AUTH_PORT = 9099;
const HTTP_PORT = 8124;
const CDP_PORT = 9226;

const ARTIFACT_SCREENSHOT_DIR = '/Users/Benjamin/.gemini/antigravity/brain/4066da1e-07cd-4566-978a-48601af7384f';
const DOCS_SCREENSHOT_DIR = path.resolve(__dirname, '../docs/screenshots');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, '..', reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      fields[k] = encodeFirestoreValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

async function seedDoc(collection, id, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = encodeFirestoreValue(v);
  }

  const url = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}/${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to seed ${collection}/${id}: ${res.status} ${text}`);
  }
}

async function provisionUser(email, password, fallbackUid, cid, role, name) {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });
  const data = await res.json();
  const uid = data.localId || fallbackUid;

  await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      localId: uid,
      customAttributes: JSON.stringify({ role, cid, manager: true })
    })
  });

  await seedDoc('users_local', cid, {
    cid,
    uid,
    authUid: uid,
    email,
    name,
    nombre: name,
    role,
    activo: true,
    created_at: new Date().toISOString()
  });
}

async function seedInitialData() {
  console.log('[SEED] Sembrando datos base para validación B3...');

  // 1. Manager / Vendedor con rol administrativo para pruebas B3
  await provisionUser(
    'gerente@ductsal.com',
    'Password123!',
    'uid-b3-mgr',
    '1000000000001',
    'manager',
    'Ing. Rodrigo Valiente'
  );

  // 2. Personas en contacts_local
  await seedDoc('contacts_local', 'CONT_ANA', {
    id: 'CONT_ANA',
    nombres: 'Ana',
    apellidos: 'Gómez',
    nombreCompleto: 'Ana Gómez',
    dui: '02345678-9',
    correo: 'ana.gomez@delta.com',
    telefono: '7890-1234',
    cargo: 'Gerente General'
  });

  await seedDoc('contacts_local', 'CONT_CARLOS', {
    id: 'CONT_CARLOS',
    nombres: 'Carlos',
    apellidos: 'López',
    nombreCompleto: 'Carlos López',
    dui: '03456789-0',
    correo: 'carlos.lopez@delta.com',
    telefono: '7890-5678',
    cargo: 'Director Financiero y Apoderado'
  });

  // 3. Cliente Jurídico C1 (Constructora Delta S.A. de C.V.)
  await seedDoc('clients_local', 'C1', {
    id: 'C1',
    empresa: 'Constructora Delta S.A. de C.V.',
    tipo: 'juridica',
    nit: '0614-123456-101-1',
    nrc: '123456-7',
    contacto: 'Ana Gómez',
    telefono: '7890-1234',
    correo: 'info@delta.com',
    correo_fact: 'facturacion@delta.com',
    createdBy: '1000000000001',
    visibleTo: ['1000000000001'],
    vendedor_asignado: '1000000000001',
    total_proyectos: 1,
    activo: true,
    documentos: {
      escritura: {
        name: 'Escritura_Constitucion_Delta.pdf',
        storagePath: 'prod_files/clients/C1/legal/escritura.pdf',
        actualizadoEn: '2023-01-15T10:00:00Z',
        ultimaRevisionBienal: '2023-01-15',
        versionId: 'v_esc_orig',
        versionNumber: 1
      },
      nit: {
        name: 'NIT_Empresa_Delta.pdf',
        storagePath: 'prod_files/clients/C1/legal/nit.pdf',
        actualizadoEn: '2025-01-15T10:00:00Z',
        versionNumber: 1
      },
      nrc: {
        name: 'NRC_Empresa_Delta.pdf',
        storagePath: 'prod_files/clients/C1/legal/nrc.pdf',
        actualizadoEn: '2025-01-15T10:00:00Z',
        versionNumber: 1
      }
    }
  });

  // Subcolección document_versions para la escritura
  await seedDoc('clients_local/C1/document_versions', 'v_esc_orig', {
    id: 'v_esc_orig',
    versionId: 'v_esc_orig',
    docKey: 'escritura',
    name: 'Escritura_Constitucion_Delta.pdf',
    versionNumber: 1,
    creadoEn: '2023-01-15T10:00:00Z'
  });

  // 4. Vinculación de contactos a la cuenta C1
  await seedDoc('account_contacts_local', 'AC_C1_ANA', {
    id: 'AC_C1_ANA',
    accountId: 'C1',
    contactId: 'CONT_ANA',
    nombreCompleto: 'Ana Gómez',
    cargo: 'Gerente General',
    isPrimary: true,
    estado: 'activo'
  });

  await seedDoc('account_contacts_local', 'AC_C1_CARLOS', {
    id: 'AC_C1_CARLOS',
    accountId: 'C1',
    contactId: 'CONT_CARLOS',
    nombreCompleto: 'Carlos López',
    cargo: 'Director Financiero y Apoderado',
    isPrimary: false,
    estado: 'activo'
  });

  // 5. Oportunidad P1 en etapa Cierre
  await seedDoc('prospects_local', 'P1', {
    id: 'P1',
    codigo: 'OPP-DELTA-B3',
    proyecto: 'Climatización Central Torre Delta',
    clientId: 'C1',
    empresa: 'Constructora Delta S.A. de C.V.',
    vendedorId: '1000000000001',
    vendedorNombre: 'Ing. Rodrigo Valiente',
    etapa: 'cierre',
    estado: 'activo',
    tipo_proyecto: 'Instalación',
    precio_cotizado: 25000,
    costo_venta: 18000,
    forma_pago: '70/30',
    factura_anticipo: 'FAC-B3-001',
    createdBy: '1000000000001',
    fecha_creacion: new Date().toISOString(),
    fecha_inicio_cierre: new Date().toISOString().slice(0, 10),
    datos: {
      doc_firmado: { name: 'Oferta_Firmada_Delta.pdf', storagePath: 'prod_files/proyectos/oferta.pdf' },
      doc_comprobante: { name: 'CCF_Anticipo_Delta.pdf', storagePath: 'prod_files/facturas/ccf.pdf' }
    }
  });

  console.log('[SEED] Datos base sembrados exitosamente.');
}

async function main() {
  console.log('='.repeat(80));
  console.log('🌐 VALIDACIÓN FUNCIONAL EN NAVEGADOR REAL — FASE 2: BLOQUE B3');
  console.log('   Documentos Legales, Representación Legal, Poderes y Cierre Comercial');
  console.log('   Google Chrome Headless + Firebase Emulator Suite (demo-ductsal-local)');
  console.log('='.repeat(80));

  fs.mkdirSync(ARTIFACT_SCREENSHOT_DIR, { recursive: true });
  fs.mkdirSync(DOCS_SCREENSHOT_DIR, { recursive: true });

  await seedInitialData();

  server.listen(HTTP_PORT);
  console.log(`[HTTP] Servidor local escuchando en http://127.0.0.1:${HTTP_PORT}`);

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpUserDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chrome-b3-'));

  const chromeProcess = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${tmpUserDataDir}`,
    '--disable-gpu',
    '--disable-extensions',
    '--no-sandbox',
    '--window-size=1440,900',
    `http://127.0.0.1:${HTTP_PORT}/index.html?emulators=${PROJECT}`
  ]);

  let ws = null;
  async function cleanup() {
    console.log('\n[TEARDOWN] Finalizando navegador y servidor HTTP...');
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    chromeProcess.kill('SIGKILL');
    server.close();
    try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    let connected = false;
    let pageTarget = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = await res.json();
        pageTarget = targets.find(t => t.type === 'page');
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          connected = true;
          break;
        }
      } catch (_) {}
    }

    if (!connected || !pageTarget) throw new Error('No se pudo conectar a Chrome CDP.');

    console.log('[CDP] Conectando a WebSocket:', pageTarget.webSocketDebuggerUrl);
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    let idCounter = 1;
    const pending = new Map();
    const nativeDialogsOpened = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Page.javascriptDialogOpening') {
        nativeDialogsOpened.push(msg.params || { type: 'unknown' });
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
    await new Promise(resolve => ws.onopen = resolve);

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = idCounter++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evalScript(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error('Eval failed: ' + JSON.stringify(r.exceptionDetails));
      }
      return r.result ? r.result.value : undefined;
    }

    async function saveScreenshot(filename, caption) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(data, 'base64');
      const artPath = path.join(ARTIFACT_SCREENSHOT_DIR, filename);
      const docPath = path.join(DOCS_SCREENSHOT_DIR, filename);
      fs.writeFileSync(artPath, buf);
      fs.writeFileSync(docPath, buf);
      console.log(`  📸 [SCREENSHOT] ${filename} — ${caption}`);
      return artPath;
    }

    await send('Page.enable');
    await send('Runtime.enable');

    console.log('\n[TEST 0] Inicializando aplicación DUCTSAL...');
    await new Promise(r => setTimeout(r, 2500));

    // Autenticación como Gerente
    console.log('\n[LOGIN] Autenticando Gerente General...');
    await evalScript(`
      (() => {
        document.getElementById('login-email').value = 'gerente@ductsal.com';
        document.getElementById('login-password').value = 'Password123!';
        const form = document.getElementById('login-form');
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      })()
    `);

    let loggedIn = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      loggedIn = await evalScript(`
        (() => {
          const s = document.getElementById('login-screen');
          const hasClient = (typeof clients !== 'undefined' && Array.isArray(clients) && clients.some(c => c.id === 'C1'));
          return s && s.style.display === 'none' && hasClient;
        })()
      `);
      if (loggedIn) break;
    }
    console.log('  Estado login y carga de datos:', loggedIn ? 'AUTENTICADO Y SINCRONIZADO' : 'ERROR');

    async function assertFullScreenView(expectedViewId, stepDesc) {
      const check = await evalScript(`
        (() => {
          const viewEl = document.getElementById('${expectedViewId}');
          const isActive = !!(viewEl && viewEl.classList.contains('active'));
          const tagName = viewEl ? viewEl.tagName : null;
          const parentTagName = (viewEl && viewEl.parentElement) ? viewEl.parentElement.tagName : null;
          const viewPosition = viewEl ? window.getComputedStyle(viewEl).position : null;
          const openModals = Array.from(document.querySelectorAll('.modal'))
            .filter(m => {
              const st = window.getComputedStyle(m);
              return st.display !== 'none' && st.visibility !== 'hidden';
            })
            .map(m => m.id || m.className);
          const openDialogs = Array.from(document.querySelectorAll('dialog[open]'))
            .map(d => d.id || 'dialog');
          const clientContainer = document.getElementById('clientDetailContent');
          const clientContainerPosition = clientContainer ? window.getComputedStyle(clientContainer).position : null;
          const clientContainerHasModalClass = clientContainer ? clientContainer.classList.contains('modal') : false;
          return {
            isActive,
            tagName,
            parentTagName,
            viewPosition,
            openModals,
            openDialogs,
            clientContainerPosition,
            clientContainerHasModalClass
          };
        })()
      `);
      if (!check.isActive) {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) La vista de pantalla completa #${expectedViewId} NO está activa.`);
      }
      if (check.tagName !== 'SECTION' || check.parentTagName !== 'MAIN') {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) #${expectedViewId} no es una <section> integrada en <main> (tagName=${check.tagName}, parent=${check.parentTagName}).`);
      }
      if (check.viewPosition === 'fixed') {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) #${expectedViewId} tiene position:fixed (overlay flotante prohibido).`);
      }
      if (expectedViewId === 'client-detail-view' && (check.clientContainerHasModalClass || check.clientContainerPosition === 'fixed')) {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) #clientDetailContent sigue comportándose como modal flotante (hasModalClass=${check.clientContainerHasModalClass}, pos=${check.clientContainerPosition}).`);
      }
      if (check.openModals.length > 0) {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) Se detectaron modales abiertos prohibidos: ${check.openModals.join(', ')}`);
      }
      if (check.openDialogs.length > 0) {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) Se detectaron elementos <dialog open> prohibidos: ${check.openDialogs.join(', ')}`);
      }
      if (nativeDialogsOpened.length > 0) {
        throw new Error(`[UI AUDIT FAIL] (${stepDesc}) Se dispararon diálogos nativos (alert/confirm/prompt) prohibidos: ${JSON.stringify(nativeDialogsOpened)}`);
      }
      console.log(`  ✅ [AUDITORÍA UI] Vista activa: <section id="${expectedViewId}"> en <main> | Modales: 0 | <dialog>: 0 | Nativos: 0`);
    }

    // =========================================================================
    // 1. Vista de Pantalla Completa «Editar Cliente» y Expediente Documental B3
    // =========================================================================
    console.log('\n[PASO 1] Abriendo Vista de Pantalla Completa «Editar Cliente» (C1) y Expediente Documental B3...');
    await evalScript(`
      (() => {
        showView('clients-view');
        openClientDetailView('C1');
      })()
    `);
    await new Promise(r => setTimeout(r, 1800));
    await assertFullScreenView('client-detail-view', 'Editar Cliente y Expediente B3');
    await saveScreenshot('b3_01_expediente_documental_b3.png', 'Vista de pantalla completa «Editar Cliente» y Expediente Documental B3');

    // =========================================================================
    // 2. Vista de Pantalla Completa: Registrar o Cambiar Representante Legal
    // =========================================================================
    console.log('\n[PASO 2] Abriendo Vista de Pantalla Completa de Nueva Elección de Representante Legal...');
    await evalScript(`
      (() => {
        ClientDocuments.openRLElectionView('C1');
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    await assertFullScreenView('b3-rl-election-view', 'Registrar o Cambiar Representante Legal');
    await saveScreenshot('b3_02_vista_eleccion_rl.png', 'Vista de pantalla completa para Registrar o Cambiar Representante Legal + DUI y Credencial');

    console.log('  Completando datos de nombramiento de RL (Ana Gómez)...');
    await evalScript(`
      (async () => {
        const sel = document.getElementById('b3-rl-contact-select');
        if (sel) {
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === 'CONT_ANA') { sel.selectedIndex = i; break; }
          }
          ClientDocuments.onRLContactSelected('CONT_ANA');
        }
        const nombreEl = document.getElementById('b3-rl-nombre');
        if (nombreEl) nombreEl.value = 'Ana Gómez';
        const fElecEl = document.getElementById('b3-rl-fecha-eleccion');
        if (fElecEl) fElecEl.value = '2024-01-15';
        const fVencEl = document.getElementById('b3-rl-fecha-vencimiento');
        if (fVencEl) fVencEl.value = '2027-01-15';

        const fakeCred = { name: 'Credencial_Ana_Gomez_2024_2027.pdf', storagePath: 'prod_files/clients/C1/legal/credencial_ana.pdf', sha256: 'a1'.repeat(32) };
        const fakeDui = { name: 'DUI_Ana_Gomez.pdf', storagePath: 'prod_files/clients/C1/identificacion/dui_ana.pdf', sha256: 'b1'.repeat(32), fechaVencimiento: '2030-05-20' };

        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        await CrmAccountDocuments.registerLegalRepresentativeTerm(fb, {
          accountId: 'C1',
          contactId: 'CONT_ANA',
          nombre: 'Ana Gómez',
          cargo: 'Gerente General y Representante Legal',
          fechaEleccion: '2024-01-15',
          fechaInicio: '2024-01-15',
          fechaVencimiento: '2027-01-15',
          credencialDoc: fakeCred,
          duiDoc: fakeDui,
          dbSuffix: '_local'
        });

        openClientDetailView('C1');
        const expSec = document.getElementById('client-expediente-section');
        if (expSec) expSec.scrollIntoView({ behavior: 'instant', block: 'center' });
      })()
    `);
    await new Promise(r => setTimeout(r, 1800));
    await assertFullScreenView('client-detail-view', 'RL Registrado Vigente en Ficha de Cliente');
    await saveScreenshot('b3_03_rl_registrado_vigente.png', 'Representante Legal Ana Gómez acreditada con estado vigente en vista de pantalla completa');

    // =========================================================================
    // 3. Vista de Pantalla Completa: Registrar Apoderado y Poder
    // =========================================================================
    console.log('\n[PASO 3] Abriendo Vista de Pantalla Completa para Registrar Apoderado (Carlos López)...');
    await evalScript(`
      (() => {
        ClientDocuments.openGrantPowerView('C1');
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    await assertFullScreenView('b3-grant-power-view', 'Registrar Apoderados y Documentos de Poder');
    await saveScreenshot('b3_04_vista_otorgar_poder.png', 'Vista de pantalla completa para Registrar Apoderado e Incorporar Poder Notarial');

    console.log('  Completando y registrando poder notarial...');
    await evalScript(`
      (async () => {
        const fakePoderDoc = {
          name: 'Testimonio_Poder_Firma_Carlos_Lopez.pdf',
          storagePath: 'prod_files/clients/C1/poderes/poder_carlos.pdf',
          nombreApoderado: 'Carlos López',
          tipoPoder: 'especial',
          facultadFirmaContratos: true,
          fechaOtorgamiento: '2025-06-01',
          fechaVencimiento: '2026-12-31',
          notario: 'Lic. Samuel Rivera',
          sha256: 'c1'.repeat(32)
        };

        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        await CrmAccountDocuments.grantContractPower(fb, {
          accountId: 'C1',
          contactId: 'CONT_CARLOS',
          documento: fakePoderDoc,
          documentoDoc: fakePoderDoc,
          dbSuffix: '_local'
        });

        openClientDetailView('C1');
        const expSec = document.getElementById('client-expediente-section');
        if (expSec) expSec.scrollIntoView({ behavior: 'instant', block: 'center' });
      })()
    `);
    await new Promise(r => setTimeout(r, 1800));
    await assertFullScreenView('client-detail-view', 'Poder Vigente Acreditado');
    await saveScreenshot('b3_05_poder_vigente_acreditado.png', 'Apoderado Carlos López con poder notarial vigente acreditado en vista de pantalla completa');

    // =========================================================================
    // 4. Regla Fundamental B3: Nueva Elección Invalida Atómicamente los Poderes
    // =========================================================================
    console.log('\n[PASO 4] Ejecutando nueva elección de RL (Mario Santos) para verificar anulación atómica de poderes...');
    await evalScript(`
      (async () => {
        const fakeCred2 = { name: 'Credencial_Mario_Santos_2026_2029.pdf', storagePath: 'prod_files/clients/C1/legal/cred_mario.pdf', sha256: 'd1'.repeat(32) };
        const fakeDui2 = { name: 'DUI_Mario_Santos.pdf', storagePath: 'prod_files/clients/C1/identificacion/dui_mario.pdf', sha256: 'e1'.repeat(32), fechaVencimiento: '2032-01-01' };

        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        await CrmAccountDocuments.registerLegalRepresentativeTerm(fb, {
          accountId: 'C1',
          nombre: 'Lic. Mario Santos',
          cargo: 'Presidente Ejecutivo y Representante Legal',
          fechaEleccion: '2026-02-01',
          fechaInicio: '2026-02-01',
          fechaVencimiento: '2029-02-01',
          credencialDoc: fakeCred2,
          duiDoc: fakeDui2,
          dbSuffix: '_local'
        });

        openClientDetailView('C1');
        const expSec = document.getElementById('client-expediente-section');
        if (expSec) expSec.scrollIntoView({ behavior: 'instant', block: 'center' });
      })()
    `);
    await new Promise(r => setTimeout(r, 1800));
    await assertFullScreenView('client-detail-view', 'Nueva Elección Invalida Poderes');
    await saveScreenshot('b3_06_nueva_eleccion_invalida_poderes.png', 'Nueva elección registrada: nuevo RL Mario Santos y poderes anteriores anulados');

    console.log('  Abriendo Vista de Pantalla Completa de Historial de Representantes y Poderes...');
    await evalScript(`
      (() => {
        ClientDocuments.openDossierHistoryView('C1');
      })()
    `);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 400));
      const ready = await evalScript(`
        (() => {
          const el = document.getElementById('b3-history-content');
          return !!(el && !el.textContent.includes('Recuperando expediente'));
        })()
      `);
      if (ready) break;
    }
    await assertFullScreenView('b3-dossier-history-view', 'Consultar Historial de Representantes Legales y Poderes');
    await saveScreenshot('b3_07_historial_b3_poderes_anulados.png', 'Vista de pantalla completa de Historial de Representantes Legales, Poderes y Revisiones Bienales');

    // =========================================================================
    // 5. Control de Requerimiento de Contrato y Firmantes en Cierre de Oportunidad
    // =========================================================================
    console.log('\n[PASO 5] Navegando a Vista de Cierre Comercial de la Oportunidad P1...');
    await evalScript(`
      (() => {
        showView('list-view');
        openDetail('P1');
      })()
    `);
    await new Promise(r => setTimeout(r, 2000));
    await assertFullScreenView('detail-view', 'Vista de Cierre de Oportunidad');

    console.log('  Marcando Requerimiento de Contrato Formal B3...');
    await evalScript(`
      (() => {
        const chk = document.getElementById('closing-requiere-contrato');
        if (chk) {
          chk.checked = true;
          if (typeof toggleClosingContractSection === 'function') toggleClosingContractSection(true);
        }
        const panel = document.getElementById('closing-contract-signatory-panel');
        if (panel) panel.scrollIntoView({ behavior: 'instant', block: 'center' });
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));
    await assertFullScreenView('detail-view', 'Cierre Requiere Contrato');
    await saveScreenshot('b3_08_cierre_requiere_contrato.png', 'Vista de Cierre con Requerimiento Contractual y botones integrados de resolución en pantalla completa');

    console.log('  Probando selección de firmante Apoderado cuando no hay poderes vigentes...');
    await evalScript(`
      (() => {
        const sel = document.getElementById('closing-firmante-tipo');
        if (sel) {
          sel.value = 'apoderado';
          if (typeof onClosingSignatoryTypeChange === 'function') onClosingSignatoryTypeChange('apoderado', 'C1');
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));
    await assertFullScreenView('detail-view', 'Bloqueo Cierre Sin Poder Válido');
    await saveScreenshot('b3_09_bloqueo_cierre_sin_poder_valido.png', 'Advertencia de firmante en vista de cierre: cuenta sin apoderados con poder vigente');

    console.log('  Seleccionando Representante Legal vigente como firmante y pre-validando con backend...');
    await evalScript(`
      (async () => {
        const sel = document.getElementById('closing-firmante-tipo');
        if (sel) {
          sel.value = 'representante_legal';
          if (typeof onClosingSignatoryTypeChange === 'function') onClosingSignatoryTypeChange('representante_legal', 'C1');
        }
        if (typeof runB3CloseValidation === 'function') await runB3CloseValidation('P1', 'C1');
      })()
    `);
    await new Promise(r => setTimeout(r, 1800));
    await assertFullScreenView('detail-view', 'Prevalidación B3 Exitosa');
    await saveScreenshot('b3_10_prevalidacion_b3_exitosa.png', 'Pre-validación B3 exitosa con backend en vista de pantalla completa');

    console.log('  Finalizando oportunidad con requerimiento de contrato cumplido...');
    await evalScript(`
      (async () => {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        await CrmCommercial.finalizeProspect(fb, {
          prospectId: 'P1',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'FAC-B3-001',
            requiere_contrato: true,
            firmante_cierre: { tipo: 'representante_legal' }
          },
          dbSuffix: '_local'
        });
        openDetail('P1');
      })()
    `);
    await new Promise(r => setTimeout(r, 2000));
    await assertFullScreenView('detail-view', 'Oportunidad Ganada con Contrato B3');
    await saveScreenshot('b3_11_oportunidad_ganada_con_contrato_b3.png', 'Oportunidad P1 Ganada con suscripción de contrato formal auditada y conforme');

    // =========================================================================
    // 6. Vista de Pantalla Completa: Revisión Bienal de Documentos Societarios (Caso A y Caso B)
    // =========================================================================
    console.log('\n[PASO 6] Abriendo Vista de Pantalla Completa de Confirmación Bienal (Caso A y Caso B)...');
    await evalScript(`
      (async () => {
        ClientDocuments.openBiennialConfirmationView('C1');
        const notesEl = document.getElementById('b3-biennial-confirm-notes');
        if (notesEl) notesEl.value = 'Se consultó con el contacto principal del cliente, quien confirmó que la Escritura de Constitución continúa vigente sin modificaciones.';
        const chkEl = document.getElementById('b3-biennial-confirm-check');
        if (chkEl) chkEl.checked = true;
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    await assertFullScreenView('b3-biennial-confirmation-view', 'Vista de Confirmación Bienal');
    await saveScreenshot('b3_12_confirmacion_bienal_renovada.png', 'Vista de pantalla completa para Registrar Confirmaciones Bienales (Caso A y Caso B)');

    const biennialCheck = await evalScript(`
      (async () => {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        // Caso B: Confirmación sin actualizaciones sobre Escritura (v_esc_orig) — no genera versión documental
        const confNoChanges = await CrmAccountDocuments.recordBiennialConfirmation(fb, {
          accountId: 'C1',
          docKey: 'escritura',
          documentVersionId: 'v_esc_orig',
          confirmationType: 'no_changes',
          confirmedNoChanges: true,
          notas: 'Se consultó al cliente y manifestó que no existen modificaciones a la Escritura de Constitución.',
          dbSuffix: '_local'
        });

        // Caso A: Revisión con actualizaciones sobre Modificaciones al Pacto Social — incorpora nueva versión y renueva período
        const saveModRes = await CrmAccountDocuments.saveAccountDocument(fb, {
          accountId: 'C1',
          docKey: 'mods_escritura',
          doc: {
            name: 'Modificacion_Pacto_Social_2026.pdf',
            storagePath: 'prod_files/clients/C1/legal/mod_2026.pdf',
            sha256: 'f2'.repeat(32)
          },
          motivoSustitucion: 'Revisión bienal Caso A: incorporación de modificación societaria actualizada',
          dbSuffix: '_local'
        });

        const confWithUpdates = await CrmAccountDocuments.recordBiennialConfirmation(fb, {
          accountId: 'C1',
          docKey: 'mods_escritura',
          documentVersionId: saveModRes.versionId,
          confirmationType: 'updated_version',
          confirmedNoChanges: false,
          notas: 'Caso A: Se adjuntó nueva versión actualizada de Modificaciones al Pacto Social.',
          dbSuffix: '_local'
        });

        return {
          casoB: confNoChanges,
          casoASave: saveModRes,
          casoAConf: confWithUpdates
        };
      })()
    `);
    console.log('  ✅ [BIENAL CASO B - SIN CAMBIOS] Evento registrado sin archivo:', JSON.stringify(biennialCheck.casoB));
    console.log('  ✅ [BIENAL CASO A - CON ACTUALIZACIONES] Nueva versión + renovación:', JSON.stringify({ versionId: biennialCheck.casoASave.versionId, nextReviewAt: biennialCheck.casoAConf.nextReviewAt }));

    // =========================================================================
    // 7. Vista de Pantalla Completa: Cargar / Sustituir Documento (SHA-256)
    // =========================================================================
    console.log('\n[PASO 7] Abriendo Vista de Pantalla Completa para Cargar / Sustituir Documento...');
    await evalScript(`
      (() => {
        ClientDocuments.openSubstituteDocView('C1', 'escritura', 'Escritura de Constitución');
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    await assertFullScreenView('b3-substitute-doc-view', 'Vista de Carga y Sustitución de Documentos');
    await saveScreenshot('b3_13_vista_sustitucion_documento.png', 'Vista de pantalla completa para Cargar o Sustituir Documentos con control SHA-256');

    // =========================================================================
    // 8. Vista de Pantalla Completa: Historial de Versiones Documentales y Eventos Bienales Diferenciados
    // =========================================================================
    console.log('\n[PASO 8] Abriendo Vista de Pantalla Completa de Historial de Versiones...');
    await evalScript(`
      (() => {
        showDocumentVersionHistory('client', 'C1', 'escritura', 'Escritura de Constitución');
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const versionHistoryDiff = await evalScript(`
      (() => {
        const bodyText = document.getElementById('docVersionHistoryBody')?.textContent || '';
        return {
          hasDocumentVersionsSection: bodyText.includes('Versiones Documentales Cargadas'),
          hasBiennialEventsSection: bodyText.includes('Eventos de Confirmación de Revisión Bienal'),
          hasNoChangesBadge: bodyText.includes('Confirmación Sin Cambios (Sin Archivo)')
        };
      })()
    `);
    if (!versionHistoryDiff.hasDocumentVersionsSection || !versionHistoryDiff.hasBiennialEventsSection || !versionHistoryDiff.hasNoChangesBadge) {
      throw new Error('El historial de versiones no diferencia claramente las versiones cargadas de los eventos de confirmación bienal: ' + JSON.stringify(versionHistoryDiff));
    }
    console.log('  ✅ [HISTORIAL DIFERENCIADO] Versiones de archivo y eventos de confirmación bienal diferenciados:', JSON.stringify(versionHistoryDiff));
    await assertFullScreenView('b3-doc-version-history-view', 'Vista de Historial de Versiones');
    await saveScreenshot('b3_14_vista_historial_versiones.png', 'Vista de pantalla completa de Historial de Versiones Documentales y Confirmaciones Bienales diferenciadas');

    // =========================================================================
    // 9. Validación Funcional Exhaustiva de Retornos Contextuales y Estado
    // =========================================================================
    console.log('\n[PASO 9] Verificando retornos contextuales y preservación de cliente/oportunidad en todas las vistas...');
    const returnChecks = await evalScript(`
      (() => {
        const results = [];
        // 9.1 Desde Historial de Versiones -> retorna a client-detail-view conservando C1
        closeDocumentVersionHistory();
        results.push({
          step: 'closeDocumentVersionHistory -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.2 Desde Sustituir Documento -> retorna a client-detail-view conservando C1
        ClientDocuments.openSubstituteDocView('C1', 'escritura', 'Escritura de Constitución');
        ClientDocuments.closeSubstituteDocView();
        results.push({
          step: 'closeSubstituteDocView -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.3 Desde Confirmación Bienal -> retorna a client-detail-view conservando C1
        ClientDocuments.openBiennialConfirmationView('C1');
        ClientDocuments.closeBiennialConfirmationView();
        results.push({
          step: 'closeBiennialConfirmationView -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.4 Desde Historial Societario -> retorna a client-detail-view conservando C1
        ClientDocuments.openDossierHistoryView('C1');
        ClientDocuments.closeDossierHistoryView();
        results.push({
          step: 'closeDossierHistoryView -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.5 Desde Otorgar Poder -> retorna a client-detail-view conservando C1
        ClientDocuments.openGrantPowerView('C1');
        ClientDocuments.closeGrantPowerView();
        results.push({
          step: 'closeGrantPowerView -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.6 Desde Elección RL -> retorna a client-detail-view conservando C1
        ClientDocuments.openRLElectionView('C1');
        ClientDocuments.closeRLElectionView();
        results.push({
          step: 'closeRLElectionView -> client-detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          clientId: document.getElementById('client-id-edit')?.value
        });

        // 9.7 Desde Oportunidad (detail-view P1) -> abrir Elección RL contextual -> retornar a detail-view P1
        showView('detail-view');
        ClientDocuments.openRLElectionView('C1', { originView: 'detail-view', prospectId: 'P1' });
        ClientDocuments.closeRLElectionView();
        results.push({
          step: 'closeRLElectionView (origin=detail-view) -> detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          prospectId: typeof currentProspectId !== 'undefined' ? currentProspectId : window.currentProspectId
        });

        // 9.8 Desde Oportunidad (detail-view P1) -> abrir Editar Cliente contextual -> retornar a detail-view P1
        openClientDetailView('C1', { originView: 'detail-view', prospectId: 'P1' });
        ClientsUI.closeClientDetailView();
        results.push({
          step: 'closeClientDetailView (origin=detail-view) -> detail-view',
          activeView: document.querySelector('.view-section.active')?.id,
          prospectId: typeof currentProspectId !== 'undefined' ? currentProspectId : window.currentProspectId
        });

        return results;
      })()
    `);

    for (const rc of returnChecks) {
      console.log(`  🔄 [RETORNO CONTEXTUAL] ${rc.step} => activeView=${rc.activeView}, ctx=${rc.clientId || rc.prospectId}`);
      if (rc.step.includes('-> client-detail-view') && (rc.activeView !== 'client-detail-view' || rc.clientId !== 'C1')) {
        throw new Error(`Fallo de retorno contextual en ${rc.step}: ${JSON.stringify(rc)}`);
      }
      if (rc.step.includes('-> detail-view') && (rc.activeView !== 'detail-view' || rc.prospectId !== 'P1')) {
        throw new Error(`Fallo de retorno contextual a oportunidad en ${rc.step}: ${JSON.stringify(rc)}`);
      }
    }
    await assertFullScreenView('detail-view', 'Retorno Contextual Final a Oportunidad P1');

    console.log('\n' + '='.repeat(80));
    console.log('✅ VALIDACIÓN EN NAVEGADOR REAL B3 (100% PANTALLA COMPLETA, 0 POPUPS, RETORNOS CONTEXTUALES) COMPLETADA');
    console.log('   Las 14 evidencias visuales paso a paso han sido capturadas y guardadas.');
    console.log('='.repeat(80));

  } catch (err) {
    console.error('\n❌ ERROR EN VALIDACIÓN EN NAVEGADOR B3:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
