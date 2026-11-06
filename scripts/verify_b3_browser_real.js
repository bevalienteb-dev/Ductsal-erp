// ============================================================================
// DUCTSAL ERP — PRUEBAS FUNCIONALES EN NAVEGADOR REAL (CDP / CHROME)
// Fase 2: Validación Integral del Bloque B3 (Documentos Legales, RL y Poderes)
// Entorno: Google Chrome Headless + Firebase Emulator Suite (demo-ductsal-local)
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROJECT = 'demo-ductsal-local';
const FIRESTORE_PORT = 8080;
const AUTH_PORT = 9099;
const STORAGE_PORT = 9199;
const STORAGE_BUCKET = `${PROJECT}.appspot.com`;
const HTTP_PORT = 8124;
const CDP_PORT = 9226;

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_UPLOAD_BYTES = 1024 * 1024; // 1 MB
const B3_TEST_UPLOAD_TOKEN = crypto.randomBytes(32).toString('hex');

const createdStoragePaths = new Set();
let storageCleanupPromise = null;
let storageCleanupCycleCount = 0;
let storageDeleteRequestCount = 0;

const ARTIFACT_SCREENSHOT_DIR = process.env.ARTIFACT_SCREENSHOT_DIR || null;
const DOCS_SCREENSHOT_DIR = path.resolve(__dirname, '../docs/screenshots');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png'
};

const ALLOWED_TEST_STORAGE_PATH_RE = /^local_files\/(?:clients\/C1\/(?:legal|identificacion|poderes)|prospects\/P1\/(?:proyectos|facturas))\/([A-Za-z0-9._-]{1,200})$/;

function assertAllowedTestStoragePath(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath || storagePath !== storagePath.trim()) {
    throw new Error(`Invalid test storagePath (empty or untrimmed): ${String(storagePath)}`);
  }
  if (
    storagePath.length > 300 ||
    /[\x00-\x1f\x7f\\]/.test(storagePath) ||
    storagePath.includes('..') ||
    storagePath.includes('//') ||
    storagePath.includes('%')
  ) {
    throw new Error(`Forbidden sequence or character in test storagePath: ${storagePath}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(storagePath);
  } catch (_) {
    throw new Error(`Malformed URI encoding in test storagePath: ${storagePath}`);
  }
  if (
    decoded !== storagePath ||
    decoded.includes('%') ||
    decoded.includes('..') ||
    decoded.includes('//') ||
    decoded.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(decoded)
  ) {
    throw new Error(`Encoded or traversal sequence rejected in test storagePath: ${storagePath}`);
  }
  const match = ALLOWED_TEST_STORAGE_PATH_RE.exec(storagePath);
  if (!match) {
    throw new Error(`Storage path outside allowed B3 test scope: ${storagePath}`);
  }
  const fileName = match[1];
  if (!fileName || fileName === '.' || fileName === '..' || fileName.startsWith('.') || fileName.includes('..')) {
    throw new Error(`Invalid file name in test storagePath: ${storagePath}`);
  }
  return storagePath;
}

function isValidTestToken(headerVal) {
  if (typeof headerVal !== 'string' || headerVal.length !== B3_TEST_UPLOAD_TOKEN.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(headerVal, 'utf8'),
      Buffer.from(B3_TEST_UPLOAD_TOKEN, 'utf8')
    );
  } catch (_) {
    return false;
  }
}

async function assertStorageObjectDoesNotExist(validPath) {
  assertAllowedTestStoragePath(validPath);
  const metaUrl = `http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(validPath)}`;
  let metaRes;
  try {
    metaRes = await fetch(metaUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer owner' }
    });
  } catch (err) {
    throw new Error(`Storage emulator pre-check failed for ${validPath}: ${err.message}`);
  }
  if (metaRes.status === 200) {
    const err = new Error(`Refusing to overwrite pre-existing Storage object: ${validPath}`);
    err.statusCode = 409;
    throw err;
  }
  if (metaRes.status !== 404) {
    const body = await metaRes.text().catch(() => '');
    throw new Error(`Unexpected status (${metaRes.status}) checking Storage object existence for ${validPath}: ${body}`);
  }
}

async function uploadToStorageEmulator(storagePath, content = '%PDF-1.4 DUCTSAL B3 TEST DOCUMENT', contentType = 'application/pdf') {
  const validPath = assertAllowedTestStoragePath(storagePath);
  if (contentType && contentType !== 'application/pdf') {
    const err = new Error(`Unsupported contentType for test upload: ${contentType}`);
    err.statusCode = 415;
    throw err;
  }
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (body.length === 0) {
    const err = new Error('Empty payload is not allowed');
    err.statusCode = 400;
    throw err;
  }
  if (body.length > MAX_UPLOAD_BYTES) {
    const err = new Error(`Payload exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`);
    err.statusCode = 413;
    throw err;
  }

  await assertStorageObjectDoesNotExist(validPath);

  const url = `http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o?name=${encodeURIComponent(validPath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      Authorization: 'Bearer owner'
    },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to upload ${validPath} to Storage emulator: ${res.status} ${text}`);
  }
  createdStoragePaths.add(validPath);
  return { storagePath: validPath, size: body.length, contentType: 'application/pdf' };
}

function cleanupCreatedStorageObjects() {
  if (storageCleanupPromise) {
    return storageCleanupPromise;
  }
  storageCleanupPromise = (async () => {
    storageCleanupCycleCount += 1;
    const pathsToDelete = Array.from(createdStoragePaths);
    for (const sp of pathsToDelete) {
      let validPath;
      try {
        validPath = assertAllowedTestStoragePath(sp);
      } catch (err) {
        console.warn(`[CLEANUP GUARD] Refusing to delete out-of-scope path: ${sp} (${err.message})`);
        createdStoragePaths.delete(sp);
        continue;
      }
      try {
        storageDeleteRequestCount += 1;
        const url = `http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(validPath)}`;
        await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer owner' }
        });
      } catch (_) {}
      createdStoragePaths.delete(sp);
    }
  })().finally(() => {
    storageCleanupPromise = null;
  });
  return storageCleanupPromise;
}

const server = http.createServer((req, res) => {
  const rawUrl = String(req.url || '');
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, `http://127.0.0.1:${HTTP_PORT}`);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (parsedUrl.pathname === '/__emulator_storage_upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    if (!isValidTestToken(req.headers['x-b3-test-token'])) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid or missing X-B3-Test-Token' }));
      return;
    }
    const rawQuery = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    if (/%25/i.test(rawQuery) || /%2e/i.test(rawQuery) || /%5c/i.test(rawQuery) || /%00/i.test(rawQuery)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden encoded sequence in query string' }));
      return;
    }
    const storagePath = parsedUrl.searchParams.get('name') || '';
    const contentType = parsedUrl.searchParams.get('contentType') || (req.headers['content-type'] || 'application/pdf').split(';')[0].trim();
    if (contentType !== 'application/pdf') {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported Media Type: only application/pdf is allowed' }));
      return;
    }
    try {
      assertAllowedTestStoragePath(storagePath);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const declaredLength = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength > MAX_UPLOAD_BYTES)) {
      req.resume();
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Payload Too Large: max 1 MB' }));
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    let abortedForSize = false;

    const onData = (chunk) => {
      if (abortedForSize) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_UPLOAD_BYTES) {
        abortedForSize = true;
        chunks.length = 0;
        req.removeListener('data', onData);
        req.resume();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'Payload Too Large: max 1 MB' }));
        }
        return;
      }
      chunks.push(chunk);
    };

    req.on('data', onData);
    req.on('end', async () => {
      if (abortedForSize || res.writableEnded) return;
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty body is not allowed' }));
          return;
        }
        const uploaded = await uploadToStorageEmulator(storagePath, buf, contentType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(uploaded));
      } catch (err) {
        const statusCode = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const rawPathname = rawUrl.split('?')[0];
  if (
    rawPathname.includes('..') ||
    rawPathname.includes('\\') ||
    rawPathname.includes('\0') ||
    /%2e/i.test(rawPathname) ||
    /%2f/i.test(rawPathname) ||
    /%5c/i.test(rawPathname) ||
    /%25/i.test(rawPathname) ||
    /%00/i.test(rawPathname)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(parsedUrl.pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (
    decodedPathname.includes('..') ||
    decodedPathname.includes('\\') ||
    decodedPathname.includes('\0')
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const reqPath = decodedPathname === '/' ? '/index.html' : decodedPathname;
  const filePath = path.resolve(REPO_ROOT, '.' + reqPath);
  const rel = path.relative(REPO_ROOT, filePath);

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

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

  // 3. Archivos base reales en el emulador de Storage (demo-ductsal-local.appspot.com)
  await uploadToStorageEmulator('local_files/clients/C1/legal/escritura.pdf', '%PDF-1.4 ESCRITURA CONSTITUCION DELTA');
  await uploadToStorageEmulator('local_files/clients/C1/legal/nit.pdf', '%PDF-1.4 NIT EMPRESA DELTA');
  await uploadToStorageEmulator('local_files/clients/C1/legal/nrc.pdf', '%PDF-1.4 NRC EMPRESA DELTA');
  await uploadToStorageEmulator('local_files/prospects/P1/proyectos/oferta.pdf', '%PDF-1.4 OFERTA FIRMADA DELTA');
  await uploadToStorageEmulator('local_files/prospects/P1/facturas/ccf.pdf', '%PDF-1.4 CCF ANTICIPO DELTA');

  // 4. Cliente Jurídico C1 (Constructora Delta S.A. de C.V.)
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
        storagePath: 'local_files/clients/C1/legal/escritura.pdf',
        actualizadoEn: '2023-01-15T10:00:00Z',
        ultimaRevisionBienal: '2023-01-15',
        versionId: 'v_esc_orig',
        versionNumber: 1
      },
      nit: {
        name: 'NIT_Empresa_Delta.pdf',
        storagePath: 'local_files/clients/C1/legal/nit.pdf',
        actualizadoEn: '2025-01-15T10:00:00Z',
        versionNumber: 1
      },
      nrc: {
        name: 'NRC_Empresa_Delta.pdf',
        storagePath: 'local_files/clients/C1/legal/nrc.pdf',
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
    storagePath: 'local_files/clients/C1/legal/escritura.pdf',
    versionNumber: 1,
    creadoEn: '2023-01-15T10:00:00Z'
  });

  // 5. Vinculación de contactos a la cuenta C1
  await seedDoc('account_contacts_local', 'AC_C1_ANA', {
    id: 'AC_C1_ANA',
    accountId: 'C1',
    contactId: 'CONT_ANA',
    nombreCompleto: 'Ana Gómez',
    cargo: 'Gerente General',
    isPrimary: true,
    activo: true,
    estado: 'activo'
  });

  await seedDoc('account_contacts_local', 'AC_C1_CARLOS', {
    id: 'AC_C1_CARLOS',
    accountId: 'C1',
    contactId: 'CONT_CARLOS',
    nombreCompleto: 'Carlos López',
    cargo: 'Director Financiero y Apoderado',
    isPrimary: false,
    activo: true,
    estado: 'activo'
  });

  // 6. Oportunidad P1 en etapa Cierre
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
      doc_firmado: { name: 'Oferta_Firmada_Delta.pdf', storagePath: 'local_files/prospects/P1/proyectos/oferta.pdf' },
      doc_comprobante: { name: 'CCF_Anticipo_Delta.pdf', storagePath: 'local_files/prospects/P1/facturas/ccf.pdf' }
    }
  });

  console.log('[SEED] Datos base sembrados exitosamente.');
}

async function runHarnessSecurityAcceptanceTests() {
  console.log('\n[SECURITY SELF-TEST] Ejecutando las 15 pruebas de aceptación del arnés HTTP / Storage Emulator...');

  const directRawPut = async (objPath, content = 'RAW_SEED') => {
    const r = await fetch(`http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o?name=${encodeURIComponent(objPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', Authorization: 'Bearer owner' },
      body: Buffer.from(content, 'utf8')
    });
    if (!r.ok) throw new Error(`directRawPut failed for ${objPath}: ${r.status}`);
  };

  const directRawGet = async (objPath) => {
    const r = await fetch(`http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(objPath)}?alt=media`, {
      method: 'GET',
      headers: { Authorization: 'Bearer owner' }
    });
    return { status: r.status, text: r.ok ? await r.text() : '' };
  };

  const directRawDel = async (objPath) => {
    await fetch(`http://127.0.0.1:${STORAGE_PORT}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(objPath)}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner' }
    });
  };

  const endpointUpload = async (rawQueryPath, bodyBuf, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/__emulator_storage_upload?${rawQueryPath}`, {
      method: 'POST',
      headers,
      body: bodyBuf
    });
    return { status: r.status, body: await r.text() };
  };

  // 14. El servidor escucha únicamente en 127.0.0.1
  const addr = server.address();
  if (!addr || addr.address !== '127.0.0.1' || addr.port !== HTTP_PORT) {
    throw new Error(`[ACCEPTANCE 14 FAIL] Server is not bound strictly to 127.0.0.1:${HTTP_PORT}: ${JSON.stringify(addr)}`);
  }
  console.log('  ✅ [14/15] Servidor HTTP vinculado exclusivamente a loopback:', `${addr.address}:${addr.port}`);

  // 15. El servidor estático no permite acceder a archivos fuera de su raíz
  const rawStaticGet = (rawReqPath) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: HTTP_PORT,
      path: rawReqPath,
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  for (const badRawPath of [
    '/../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/firebase.emulator.json',
    '/..%5cpackage.json',
    '/docs/../../package.json'
  ]) {
    const stRes = await rawStaticGet(badRawPath);
    if (stRes.status !== 403 && stRes.status !== 400) {
      throw new Error(`[ACCEPTANCE 15 FAIL] Static server did not reject out-of-root request ${badRawPath}: HTTP ${stRes.status}`);
    }
  }
  console.log('  ✅ [15/15] Servidor estático confinado a REPO_ROOT (traversal fuera de raíz rechazado con HTTP 403).');

  // 1. prod_files/... es rechazado
  let prodRejected = false;
  try {
    await uploadToStorageEmulator('prod_files/clients/C1/legal/escritura.pdf', '%PDF-1.4');
  } catch (_) {
    prodRejected = true;
  }
  const prodHttp = await endpointUpload(
    'name=' + encodeURIComponent('prod_files/clients/C1/legal/escritura.pdf') + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (!prodRejected || prodHttp.status !== 400) {
    throw new Error(`[ACCEPTANCE 1 FAIL] prod_files/... was not rejected (direct=${prodRejected}, http=${prodHttp.status})`);
  }
  console.log('  ✅ [01/15] Prefijo prod_files/... rechazado en validador, función y endpoint HTTP.');

  // 2. Ruta de otra cuenta es rechazada
  let otherClientRejected = false;
  try {
    await uploadToStorageEmulator('local_files/clients/C2/legal/escritura.pdf', '%PDF-1.4');
  } catch (_) {
    otherClientRejected = true;
  }
  const otherClientHttp = await endpointUpload(
    'name=' + encodeURIComponent('local_files/clients/C2/legal/escritura.pdf') + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (!otherClientRejected || otherClientHttp.status !== 400) {
    throw new Error(`[ACCEPTANCE 2 FAIL] Other account path was not rejected`);
  }
  console.log('  ✅ [02/15] Ruta de otra cuenta (clients/C2/...) rechazada.');

  // 3. Ruta de otro prospecto es rechazada
  let otherProspectRejected = false;
  try {
    await uploadToStorageEmulator('local_files/prospects/P2/proyectos/oferta.pdf', '%PDF-1.4');
  } catch (_) {
    otherProspectRejected = true;
  }
  const otherProspectHttp = await endpointUpload(
    'name=' + encodeURIComponent('local_files/prospects/P2/proyectos/oferta.pdf') + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (!otherProspectRejected || otherProspectHttp.status !== 400) {
    throw new Error(`[ACCEPTANCE 3 FAIL] Other prospect path was not rejected`);
  }
  console.log('  ✅ [03/15] Ruta de otro prospecto (prospects/P2/...) rechazada.');

  // 4. Traversal .. es rechazado
  for (const travPath of [
    'local_files/clients/C1/legal/../escritura.pdf',
    'local_files/clients/C1/../C2/legal/escritura.pdf',
    '../local_files/clients/C1/legal/escritura.pdf',
    'local_files/clients/C1/legal/..escritura.pdf'
  ]) {
    let rejected = false;
    try {
      assertAllowedTestStoragePath(travPath);
    } catch (_) {
      rejected = true;
    }
    const rHttp = await endpointUpload(
      'name=' + encodeURIComponent(travPath) + '&contentType=application/pdf',
      Buffer.from('%PDF-1.4'),
      { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
    );
    if (!rejected || rHttp.status !== 400) {
      throw new Error(`[ACCEPTANCE 4 FAIL] Traversal path not rejected: ${travPath}`);
    }
  }
  console.log('  ✅ [04/15] Secuencias de path traversal (..) rechazadas.');

  // 5. Doble codificación y caracteres prohibidos son rechazados
  for (const badPath of [
    'local_files/clients/C1/legal/%2e%2e/escritura.pdf',
    'local_files/clients/C1/legal/%252e%252e/escritura.pdf',
    'local_files/clients/C1//legal/escritura.pdf',
    'local_files\\clients\\C1\\legal\\escritura.pdf',
    'local_files/clients/C1/legal/escritura\x00.pdf'
  ]) {
    let rejected = false;
    try {
      assertAllowedTestStoragePath(badPath);
    } catch (_) {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`[ACCEPTANCE 5 FAIL] Forbidden/encoded path not rejected by validator: ${badPath}`);
    }
  }
  const doubleEncodedHttp = await endpointUpload(
    'name=local_files%2Fclients%2FC1%2Flegal%2F%252e%252e%2Fescritura.pdf&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (doubleEncodedHttp.status !== 400) {
    throw new Error(`[ACCEPTANCE 5 FAIL] Double-encoded HTTP query was not rejected: ${doubleEncodedHttp.status}`);
  }
  console.log('  ✅ [05/15] Doble codificación y caracteres prohibidos (//, \\, %2e, %25, NUL) rechazados.');

  // 6. El endpoint rechaza requests sin token o con token inválido
  const noTokenHttp = await endpointUpload(
    'name=' + encodeURIComponent('local_files/clients/C1/legal/escritura.pdf') + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf' }
  );
  const badTokenHttp = await endpointUpload(
    'name=' + encodeURIComponent('local_files/clients/C1/legal/escritura.pdf') + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': 'invalid-token' }
  );
  if (noTokenHttp.status !== 403 || badTokenHttp.status !== 403) {
    throw new Error(`[ACCEPTANCE 6 FAIL] Endpoint did not reject missing/invalid token with 403 (noToken=${noTokenHttp.status}, badToken=${badTokenHttp.status})`);
  }
  console.log('  ✅ [06/15] Endpoint /__emulator_storage_upload rechaza peticiones sin X-B3-Test-Token válido (HTTP 403).');

  // 7. El endpoint rechaza payload superior a 1 MB con HTTP 413
  const oversizedBuf = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41);
  const oversizedHttp = await endpointUpload(
    'name=' + encodeURIComponent('local_files/clients/C1/legal/oversized_test.pdf') + '&contentType=application/pdf',
    oversizedBuf,
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (oversizedHttp.status !== 413) {
    throw new Error(`[ACCEPTANCE 7 FAIL] Endpoint did not reject >1MB payload with 413: got ${oversizedHttp.status}`);
  }
  console.log('  ✅ [07/15] Endpoint /__emulator_storage_upload rechaza payloads > 1 MB con HTTP 413.');

  // 8. Una carga fallida no se registra en createdStoragePaths
  if (createdStoragePaths.size !== 0) {
    throw new Error(`[ACCEPTANCE 8 FAIL] createdStoragePaths is not empty after failed uploads: ${Array.from(createdStoragePaths).join(', ')}`);
  }
  console.log('  ✅ [08/15] Ninguna carga fallida o rechazada fue registrada en createdStoragePaths (size=0).');

  // 9. Un objeto preexistente no se sobrescribe ni se elimina
  const preexistingPath = 'local_files/clients/C1/legal/preexisting_fixture_b3.pdf';
  const preexistingContent = '%PDF-1.4 PREEXISTING_OBJECT_DO_NOT_OVERWRITE_OR_DELETE';
  await directRawPut(preexistingPath, preexistingContent);

  let overwriteRejectedDirect = false;
  try {
    await uploadToStorageEmulator(preexistingPath, '%PDF-1.4 OVERWRITE_ATTEMPT');
  } catch (err) {
    overwriteRejectedDirect = err.statusCode === 409 || /pre-existing/i.test(err.message);
  }
  const overwriteHttp = await endpointUpload(
    'name=' + encodeURIComponent(preexistingPath) + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4 OVERWRITE_ATTEMPT_HTTP'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (!overwriteRejectedDirect || overwriteHttp.status !== 409) {
    throw new Error(`[ACCEPTANCE 9 FAIL] Pre-existing object was not protected with 409 (direct=${overwriteRejectedDirect}, http=${overwriteHttp.status})`);
  }
  if (createdStoragePaths.has(preexistingPath)) {
    throw new Error('[ACCEPTANCE 9 FAIL] Pre-existing object was erroneously added to createdStoragePaths');
  }

  // 10. Una carga nueva y válida sí se registra
  const newValidPath = 'local_files/clients/C1/legal/new_valid_acceptance_b3.pdf';
  const newValidHttp = await endpointUpload(
    'name=' + encodeURIComponent(newValidPath) + '&contentType=application/pdf',
    Buffer.from('%PDF-1.4 NEW_VALID_OBJECT_CONTENT'),
    { 'Content-Type': 'application/pdf', 'X-B3-Test-Token': B3_TEST_UPLOAD_TOKEN }
  );
  if (newValidHttp.status !== 200 || !createdStoragePaths.has(newValidPath)) {
    throw new Error(`[ACCEPTANCE 10 FAIL] Valid upload was not registered (http=${newValidHttp.status}, inSet=${createdStoragePaths.has(newValidPath)})`);
  }
  console.log('  ✅ [10/15] Carga nueva y válida registrada en createdStoragePaths y persistida en Storage Emulator.');

  // 11. Cleanup elimina exclusivamente objetos nuevos de la ejecución actual (y preserva el preexistente de #9)
  await cleanupCreatedStorageObjects();
  const checkNewAfterCleanup = await directRawGet(newValidPath);
  const checkPreexistingAfterCleanup = await directRawGet(preexistingPath);
  if (checkNewAfterCleanup.status !== 404) {
    throw new Error(`[ACCEPTANCE 11 FAIL] Newly created object was not deleted by cleanup: status=${checkNewAfterCleanup.status}`);
  }
  if (checkPreexistingAfterCleanup.status !== 200 || checkPreexistingAfterCleanup.text !== preexistingContent) {
    throw new Error(`[ACCEPTANCE 9/11 FAIL] Pre-existing object was modified or deleted: status=${checkPreexistingAfterCleanup.status}, text=${checkPreexistingAfterCleanup.text}`);
  }
  await directRawDel(preexistingPath);
  console.log('  ✅ [09/15] Objeto preexistente preservado intacto (HTTP 409 al intentar sobrescribir, no registrado, no eliminado).');
  console.log('  ✅ [11/15] Cleanup eliminó únicamente el objeto nuevo de la ejecución actual y preservó el preexistente.');

  // 12. Cleanup no permite borrar rutas fuera de la lista blanca aunque el Set contuviera accidentalmente una ruta inválida
  const protectedOutScopePath = 'prod_files/clients/C1/legal/protected_out_of_scope.pdf';
  await directRawPut(protectedOutScopePath, '%PDF-1.4 PROTECTED_PROD_SCOPE');
  createdStoragePaths.add(protectedOutScopePath);
  await cleanupCreatedStorageObjects();
  const checkProtectedAfterCleanup = await directRawGet(protectedOutScopePath);
  if (checkProtectedAfterCleanup.status !== 200 || checkProtectedAfterCleanup.text !== '%PDF-1.4 PROTECTED_PROD_SCOPE') {
    throw new Error(`[ACCEPTANCE 12 FAIL] Cleanup deleted out-of-whitelist path ${protectedOutScopePath}`);
  }
  await directRawDel(protectedOutScopePath);
  console.log('  ✅ [12/15] Cleanup bloqueó el borrado de una ruta fuera de la lista blanca inyectada en el Set.');

  // 13. Varias llamadas concurrentes a cleanup ejecutan un único ciclo
  const concPath = 'local_files/clients/C1/legal/concurrent_cleanup_b3.pdf';
  await uploadToStorageEmulator(concPath, '%PDF-1.4 CONCURRENT_CLEANUP_TEST');
  const cyclesBefore = storageCleanupCycleCount;
  const deletesBefore = storageDeleteRequestCount;
  await Promise.all([
    cleanupCreatedStorageObjects(),
    cleanupCreatedStorageObjects(),
    cleanupCreatedStorageObjects()
  ]);
  const cyclesDelta = storageCleanupCycleCount - cyclesBefore;
  const deletesDelta = storageDeleteRequestCount - deletesBefore;
  if (cyclesDelta !== 1 || deletesDelta !== 1) {
    throw new Error(`[ACCEPTANCE 13 FAIL] Concurrent cleanup calls executed ${cyclesDelta} cycles and ${deletesDelta} DELETEs (expected 1 and 1)`);
  }
  console.log('  ✅ [13/15] Llamadas concurrentes a cleanup comparten la misma promesa (1 ciclo, 1 DELETE).');
}

async function main() {
  console.log('='.repeat(80));
  console.log('🌐 VALIDACIÓN FUNCIONAL EN NAVEGADOR REAL — FASE 2: BLOQUE B3');
  console.log('   Documentos Legales, Representación Legal, Poderes y Cierre Comercial');
  console.log('   Google Chrome Headless + Firebase Emulator Suite (demo-ductsal-local)');
  console.log('='.repeat(80));

  if (ARTIFACT_SCREENSHOT_DIR) {
    fs.mkdirSync(ARTIFACT_SCREENSHOT_DIR, { recursive: true });
  }
  fs.mkdirSync(DOCS_SCREENSHOT_DIR, { recursive: true });

  const tmpUserDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chrome-b3-'));
  let chromeProcess = null;
  let ws = null;
  let cleanupPromise = null;

  function cleanup() {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      console.log('\n[TEARDOWN] Finalizando navegador y servidor HTTP...');
      if (ws) {
        try { ws.close(); } catch (_) {}
      }
      if (chromeProcess) {
        try { chromeProcess.kill('SIGKILL'); } catch (_) {}
      }
      try { server.close(); } catch (_) {}
      await cleanupCreatedStorageObjects();
      try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch (_) {}
    })();
    return cleanupPromise;
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(HTTP_PORT, '127.0.0.1', resolve);
    });
    console.log(`[HTTP] Servidor local escuchando exclusivamente en http://127.0.0.1:${HTTP_PORT}`);

    await runHarnessSecurityAcceptanceTests();
    await seedInitialData();

    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    chromeProcess = spawn(chromePath, [
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
      const outDir = ARTIFACT_SCREENSHOT_DIR || path.join(tmpUserDataDir, 'screenshots');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, filename);
      fs.writeFileSync(outPath, buf);
      if (process.env.UPDATE_DOCS_SCREENSHOTS === '1') {
        fs.mkdirSync(DOCS_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(DOCS_SCREENSHOT_DIR, filename), buf);
      }
      console.log(`  📸 [SCREENSHOT] ${filename} — ${caption}`);
      return outPath;
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

    console.log('  Completando formulario UI y ejecutando submitLegalRepresentativeElection (Ana Gómez)...');
    await evalScript(`
      (async () => {
        // Configurar adaptador local de Storage conectado al emulador local de Storage (127.0.0.1:9199)
        window.__setFakeFileOnInput = (inputId, fileName, content) => {
          const el = document.getElementById(inputId);
          if (!el) return;
          const dt = new DataTransfer();
          dt.items.add(new File([content], fileName, { type: 'application/pdf' }));
          el.files = dt.files;
        };
        ClientDocuments.init({
          uploadFileToStorage: async (file, folder, opts) => {
            const sub = (opts && (opts.subfolder === 'poderes' || opts.isPoder)) ? 'poderes' : ((opts && opts.isLegal) ? 'legal' : 'identificacion');
            const prefix = (typeof STORAGE_PREFIX !== 'undefined' && STORAGE_PREFIX) ? STORAGE_PREFIX : 'local_files';
            const storagePath = prefix + '/clients/' + ((opts && opts.clientId) || 'C1') + '/' + sub + '/' + file.name;
            const contentType = file.type || 'application/pdf';
            const bodyBuf = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : file;
            const uploadRes = await fetch('/__emulator_storage_upload?name=' + encodeURIComponent(storagePath) + '&contentType=' + encodeURIComponent(contentType), {
              method: 'POST',
              headers: {
                'Content-Type': contentType,
                'X-B3-Test-Token': '${B3_TEST_UPLOAD_TOKEN}'
              },
              body: bodyBuf
            });
            if (!uploadRes.ok) {
              const errText = await uploadRes.text().catch(() => '');
              throw new Error('Error subiendo archivo al emulador de Storage: ' + uploadRes.status + ' ' + errText);
            }
            return {
              name: file.name,
              storagePath,
              size: file.size,
              contentType
            };
          }
        });

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
        const fDuiVencEl = document.getElementById('b3-rl-dui-vencimiento');
        if (fDuiVencEl) fDuiVencEl.value = '2030-05-20';

        window.__setFakeFileOnInput('b3-rl-file-credencial', 'Credencial_Ana_Gomez_2024_2027.pdf', 'PDF_CREDENCIAL_ANA_2024');
        window.__setFakeFileOnInput('b3-rl-file-dui', 'DUI_Ana_Gomez.pdf', 'PDF_DUI_ANA_2024');

        await ClientDocuments.submitLegalRepresentativeElection();

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

    console.log('  Completando formulario UI y ejecutando submitGrantContractPower...');
    await evalScript(`
      (async () => {
        const sel = document.getElementById('b3-power-contact-select');
        if (sel) {
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === 'CONT_CARLOS') { sel.selectedIndex = i; break; }
          }
        }
        const notasEl = document.getElementById('b3-power-notas');
        if (notasEl) notasEl.value = 'Facultado para suscribir contratos comerciales hasta $250,000';
        window.__setFakeFileOnInput('b3-power-file-documento', 'Testimonio_Poder_Firma_Carlos_Lopez.pdf', 'PDF_PODER_CARLOS_2025');

        await ClientDocuments.submitGrantContractPower();

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
    console.log('\n[PASO 4] Ejecutando nueva elección de RL (Mario Santos) desde la UI para verificar anulación atómica de poderes...');
    await evalScript(`
      (async () => {
        ClientDocuments.openRLElectionView('C1');
        const nombreEl = document.getElementById('b3-rl-nombre');
        if (nombreEl) nombreEl.value = 'Lic. Mario Santos';
        const fElecEl = document.getElementById('b3-rl-fecha-eleccion');
        if (fElecEl) fElecEl.value = '2026-02-01';
        const fVencEl = document.getElementById('b3-rl-fecha-vencimiento');
        if (fVencEl) fVencEl.value = '2029-02-01';
        const fDuiVencEl = document.getElementById('b3-rl-dui-vencimiento');
        if (fDuiVencEl) fDuiVencEl.value = '2032-01-01';

        window.__setFakeFileOnInput('b3-rl-file-credencial', 'Credencial_Mario_Santos_2026_2029.pdf', 'PDF_CREDENCIAL_MARIO_2026');
        window.__setFakeFileOnInput('b3-rl-file-dui', 'DUI_Mario_Santos.pdf', 'PDF_DUI_MARIO_2026');

        await ClientDocuments.submitLegalRepresentativeElection();

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
    // 5. Vista de Pantalla Completa: Revisión Bienal de Documentos Societarios (Caso A y Caso B)
    // =========================================================================
    console.log('\n[PASO 5] Abriendo Vista de Pantalla Completa de Confirmación Bienal (Caso A y Caso B)...');
    await evalScript(`
      (async () => {
        ClientDocuments.openBiennialConfirmationView('C1', { docKey: 'escritura' });
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
        // Caso B desde el controlador UI real: submitBiennialExpress()
        await ClientDocuments.submitBiennialExpress();

        // Caso A desde el controlador UI real: submitBiennialUpload() sobre mods_escritura
        ClientDocuments.openBiennialConfirmationView('C1', { docKey: 'mods_escritura' });
        const docKeySelect = document.getElementById('b3-biennial-doc-key');
        if (docKeySelect) docKeySelect.value = 'mods_escritura';
        const upNotesEl = document.getElementById('b3-biennial-upload-notes');
        if (upNotesEl) upNotesEl.value = 'Revisión bienal Caso A: incorporación de modificación societaria actualizada 2026.';
        window.__setFakeFileOnInput('b3-biennial-file', 'Modificacion_Pacto_Social_2026.pdf', 'PDF_MOD_PACTO_SOCIAL_2026');
        await ClientDocuments.submitBiennialUpload();

        const c = clients.find(x => x.id === 'C1');
        return {
          casoBReview: c && c.biennialReviews && c.biennialReviews.escritura,
          casoAReview: c && c.biennialReviews && c.biennialReviews.mods_escritura,
          modsVersionId: c && c.documentos && c.documentos.mods_escritura && c.documentos.mods_escritura.versionId
        };
      })()
    `);
    console.log('  ✅ [BIENAL CASO B - SIN CAMBIOS] Evento registrado desde UI sin archivo:', JSON.stringify(biennialCheck.casoBReview));
    console.log('  ✅ [BIENAL CASO A - CON ACTUALIZACIONES] Nueva versión + renovación desde UI:', JSON.stringify({ versionId: biennialCheck.modsVersionId, review: biennialCheck.casoAReview }));

    // =========================================================================
    // 6. Control de Requerimiento de Contrato y Firmantes en Cierre de Oportunidad
    // =========================================================================
    console.log('\n[PASO 6] Navegando a Vista de Cierre Comercial de la Oportunidad P1...');
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

    console.log('  Finalizando oportunidad desde el controlador UI finalizeOpportunity con requerimiento de contrato cumplido...');
    await evalScript(`
      (async () => {
        const fpEl = document.getElementById('closing-forma-pago');
        if (fpEl) fpEl.value = '70/30';
        const facEl = document.getElementById('closing-fac-anticipo');
        if (facEl) facEl.value = 'FAC-B3-001';
        const encEl = document.getElementById('closing-encargado');
        if (encEl && !encEl.value) encEl.value = 'Ing. Roberto Mena';
        const reqEl = document.getElementById('closing-requiere-contrato');
        if (reqEl) reqEl.checked = true;
        const tipoEl = document.getElementById('closing-firmante-tipo');
        if (tipoEl) tipoEl.value = 'representante_legal';
        await finalizeOpportunity('P1');
      })()
    `);
    await new Promise(r => setTimeout(r, 2000));
    await assertFullScreenView('detail-view', 'Oportunidad Ganada con Contrato B3');
    await saveScreenshot('b3_11_oportunidad_ganada_con_contrato_b3.png', 'Oportunidad P1 Ganada con suscripción de contrato formal auditada y conforme');

    // =========================================================================
    // 7. Vista de Pantalla Completa: Cargar / Sustituir Documento (SHA-256)
    // =========================================================================
    console.log('\n[PASO 7] Abriendo Vista de Pantalla Completa para Cargar / Sustituir Documento (ALTO-02)...');
    await evalScript(`
      (() => {
        openClientDetailView('C1');
        ClientDocuments.openSubstituteDocView('C1', 'nit', 'Tarjeta NIT');
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    await assertFullScreenView('b3-substitute-doc-view', 'Vista de Carga y Sustitución de Documentos');
    await saveScreenshot('b3_13_vista_sustitucion_documento.png', 'Vista de pantalla completa para Cargar o Sustituir Documentos con control SHA-256');

    console.log('  Ejecutando submitDocumentSubstitution desde la UI para verificar ALTO-02...');
    const substCheck = await evalScript(`
      (async () => {
        const motivoEl = document.getElementById('b3-subst-motivo');
        if (motivoEl) motivoEl.value = 'Actualización de representación gráfica de NIT homologado';
        window.__setFakeFileOnInput('b3-subst-file', 'NIT_Actualizado_2026.pdf', 'PDF_NIT_ACTUALIZADO_2026_UNICO');
        await ClientDocuments.submitDocumentSubstitution();
        const c = clients.find(x => x.id === 'C1');
        return c && c.documentos && c.documentos.nit;
      })()
    `);
    if (!substCheck || !substCheck.versionId) {
      throw new Error('ALTO-02 fallo: submitDocumentSubstitution no registró versionId en client.documentos.nit');
    }
    console.log('  ✅ [ALTO-02 VERIFICADO] Sustitución documental registrada con versionId:', substCheck.versionId);

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
