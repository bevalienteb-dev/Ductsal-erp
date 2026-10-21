// functions/isolated-tests/sec10HorizontalIsolation.iso.js
// SEC-10: Automated Horizontal Document Isolation Verification Suite
// Runs END-TO-END on the isolated Firebase Emulator Suite (Auth 9399, Firestore 8190, Storage 9290, Functions 5101).
// Completely isolated under demo-ductsal-isolated with synthetic accounts and documents.
// Zero connection to production ductsal-erp.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9290';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, PROJECT } = require('./iso');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();

const AUTH = 'http://127.0.0.1:9399';
const ST_HOST = '127.0.0.1:9290';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const BUCKET = `${PROJECT}.appspot.com`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;

const CID = {
  V_A: '1792037387201',
  V_B: '1792038830602',
  GES: '1000000000003',
  INACT: '1792000000004',
  ORPHAN: '1792099999905'
};

const sessions = {};

async function post(url, body, token) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const callDownload = (data, token) => post(`${FUNCTIONS}/getSecureDownloadUrlAdmin`, { data: { dbSuffix: '_prod', ...data } }, token);

async function makeAccount(tag, cid, role, { activo = true, linked = true, claims = true } = {}) {
  const email = `${tag}@ductsal-test.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
  const up = await post(idt('accounts:signUp'), { email, password, returnSecureToken: true });
  const uid = up.json.localId;
  if (claims) await auth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
  const profile = { id: cid, nombre: tag, email, role, activo };
  if (linked) profile.authUid = uid;
  await db.collection('users_prod').doc(cid).set(profile);
  const inn = await post(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid, token: inn.json.idToken, cid, email };
}

async function seedStorageFile(objPath, content = '%PDF-1.4 test document') {
  const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(objPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', Authorization: 'Bearer owner' },
    body: Buffer.from(content)
  });
  if (r.status !== 200) throw new Error(`Failed to seed storage file ${objPath}: HTTP ${r.status}`);
}

const FILES = {
  P_A_DOC: 'prod_files/prospects/P_A_TITULAR/cotizaciones/cotizacion_a.pdf',
  P_REASSIGNED_DOC: 'prod_files/prospects/P_REASSIGNED/cotizaciones/cotizacion_reassigned.pdf',
  P_OPEN_DOC: 'prod_files/prospects/P_OPEN_LEAD/cotizaciones/cotizacion_open.pdf',
  P_POST_DOC: 'prod_files/prospects/P_POST_CLOSED/facturas/factura_postclosing.pdf',
  C_A_DOC: 'prod_files/clients/C_A_EXCLUSIVE/identificacion/dui_titular.pdf',
  FLAT_B_DOC: 'prod_files/proyectos/1780000000_plano_confidencial_b.pdf'
};

beforeAll(async () => {
  await assertIsolatedUp();
  const fnUp = await fetch(`http://127.0.0.1:5101/`).catch(() => null);
  if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering');

  // Reset Auth and Firestore emulator data
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await clearIsolatedFirestore();
  await loadFirestoreRules();

  // Create isolated synthetic accounts
  sessions.V_A = await makeAccount('vendedor.a', CID.V_A, 'vendedor');
  sessions.V_B = await makeAccount('vendedor.b', CID.V_B, 'vendedor');
  sessions.GES = await makeAccount('gestor.g', CID.GES, 'gestor');
  sessions.INACT = await makeAccount('vendedor.inactivo', CID.INACT, 'vendedor', { activo: false });

  // Account without profile in users_prod (orphan)
  const orphanEmail = 'orphan.user@ductsal-test.invalid';
  const orphanPw = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
  const orphanUp = await post(idt('accounts:signUp'), { email: orphanEmail, password: orphanPw, returnSecureToken: true });
  await auth.setCustomUserClaims(orphanUp.json.localId, { role: 'vendedor', cid: CID.ORPHAN });
  const orphanInn = await post(idt('accounts:signInWithPassword'), { email: orphanEmail, password: orphanPw, returnSecureToken: true });
  sessions.ORPHAN = { uid: orphanUp.json.localId, token: orphanInn.json.idToken, cid: CID.ORPHAN };

  // Seed storage files
  for (const path of Object.values(FILES)) {
    await seedStorageFile(path);
  }

  // Seed Firestore test entities
  // 1. Prospect owned and assigned to Vendedor A
  await db.collection('prospects_prod').doc('P_A_TITULAR').set({
    id: 'P_A_TITULAR',
    createdBy: CID.V_A,
    vendedorId: CID.V_A,
    estado: 'activo',
    cotizaciones: [FILES.P_A_DOC]
  });

  // 2. Prospect originally created by Vendedor A, but reassigned to Vendedor B
  await db.collection('prospects_prod').doc('P_REASSIGNED').set({
    id: 'P_REASSIGNED',
    createdBy: CID.V_A,
    vendedorId: CID.V_B,
    estado: 'activo',
    cotizaciones: [FILES.P_REASSIGNED_DOC]
  });

  // 3. Open prospect assigned to Vendedor A (not in postcierre)
  await db.collection('prospects_prod').doc('P_OPEN_LEAD').set({
    id: 'P_OPEN_LEAD',
    createdBy: CID.V_A,
    vendedorId: CID.V_A,
    estado: 'activo',
    postcierre_habilitado: false,
    cotizaciones: [FILES.P_OPEN_DOC]
  });

  // 4. Prospect in postclosing (postcierre_habilitado: true, closing date present)
  await db.collection('prospects_prod').doc('P_POST_CLOSED').set({
    id: 'P_POST_CLOSED',
    createdBy: CID.V_A,
    vendedorId: CID.V_A,
    estado: 'ganado',
    postcierre_habilitado: true,
    fecha_cierre: '2026-10-15',
    facturas: [FILES.P_POST_DOC]
  });

  // 5. Exclusive client owned by Vendedor A
  await db.collection('clients_prod').doc('C_A_EXCLUSIVE').set({
    id: 'C_A_EXCLUSIVE',
    createdBy: CID.V_A,
    empresa: 'Cliente Exclusivo Vendedor A S.A.',
    visibleTo: [],
    identificacion: FILES.C_A_DOC
  });

  // 6. Prospect owned by Vendedor B referencing flat legacy file
  await db.collection('prospects_prod').doc('P_B_LEGACY').set({
    id: 'P_B_LEGACY',
    createdBy: CID.V_B,
    vendedorId: CID.V_B,
    estado: 'activo',
    planos: [FILES.FLAT_B_DOC]
  });
}, 60000);

describe('SEC-10: Evaluación de Cierre mediante Aislamiento Horizontal Automatizado', () => {

  // Escenario 1: Vendedor titular autenticado y autorizado
  test('Escenario 1: Vendedor titular autorizado accede a su documento -> Acceso concedido (HTTP 200 + URL)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, sessions.V_A.token);

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result).toBeDefined();
    expect(res.json.result.signedUrl).toContain('127.0.0.1:9290');
    expect(res.json.result.fileName).toBe('cotizacion_a.pdf');
    expect(res.json.result.storagePath).toBe(FILES.P_A_DOC);
  });

  // Escenario 2: Segundo vendedor autenticado y no autorizado
  test('Escenario 2: Segundo vendedor no autorizado sobre expediente ajeno -> PERMISSION_DENIED (HTTP 403, 0 signedUrl)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, sessions.V_B.token);

    expect(res.status).toBe(403);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error).toBeDefined();
    expect(res.json.error.status).toBe('PERMISSION_DENIED');
    expect(res.json.error.message).toBe('No tienes acceso a los documentos de esta oportunidad');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  // Escenario 3: Creador original tras reasignación
  test('Escenario 3: Creador original tras reasignación a otro vendedor -> PERMISSION_DENIED; nuevo titular autorizado', async () => {
    // Vendedor A creó la oportunidad, pero fue reasignada a Vendedor B. Vendedor A no debe tener acceso operativo.
    const resA = await callDownload({
      storagePath: FILES.P_REASSIGNED_DOC,
      prospectId: 'P_REASSIGNED'
    }, sessions.V_A.token);

    expect(resA.status).toBe(403);
    expect(resA.json.result).toBeUndefined();
    expect(resA.json.error.status).toBe('PERMISSION_DENIED');
    expect(resA.json.error.message).toBe('No tienes acceso a los documentos de esta oportunidad');
    expect(JSON.stringify(resA.json)).not.toContain('signedUrl');

    // El nuevo titular (Vendedor B) sí tiene acceso legítimo
    const resB = await callDownload({
      storagePath: FILES.P_REASSIGNED_DOC,
      prospectId: 'P_REASSIGNED'
    }, sessions.V_B.token);

    expect(resB.status).toBe(200);
    expect(resB.json.result).toBeDefined();
    expect(resB.json.result.signedUrl).toBeDefined();
  });

  // Escenario 4: Gestor solicita oportunidad abierta de otro vendedor
  test('Escenario 4: Gestor solicita oportunidad abierta de vendedor ajeno (no postcierre) -> PERMISSION_DENIED', async () => {
    const res = await callDownload({
      storagePath: FILES.P_OPEN_DOC,
      prospectId: 'P_OPEN_LEAD'
    }, sessions.GES.token);

    expect(res.status).toBe(403);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error.status).toBe('PERMISSION_DENIED');
    expect(res.json.error.message).toBe('No tienes acceso a los documentos de esta oportunidad');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  // Escenario 5: Gestor solicita expediente habilitado para postcierre
  test('Escenario 5: Gestor solicita expediente habilitado para postcierre -> Acceso concedido (HTTP 200 + URL)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_POST_DOC,
      prospectId: 'P_POST_CLOSED'
    }, sessions.GES.token);

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result).toBeDefined();
    expect(res.json.result.signedUrl).toContain('127.0.0.1:9290');
    expect(res.json.result.fileName).toBe('factura_postclosing.pdf');
  });

  // Escenario 6: Usuario anónimo o token inválido
  test('Escenario 6a: Solicitud anónima sin encabezado Authorization -> UNAUTHENTICATED (HTTP 401)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, null);

    expect(res.status).toBe(401);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error.status).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  test('Escenario 6b: Solicitud con token corrupto / inválido -> UNAUTHENTICATED (HTTP 401)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, 'invalid.bearer.token.fake');

    expect(res.status).toBe(401);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error.status).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  // Escenario 7: Perfil inactivo o identidad sin correspondencia válida
  test('Escenario 7a: Perfil inactivo en users_prod (activo: false) -> PERMISSION_DENIED (HTTP 403)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, sessions.INACT.token);

    expect(res.status).toBe(403);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error.status).toBe('PERMISSION_DENIED');
    expect(res.json.error.message).toContain('Se requiere un usuario activo del CRM');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  test('Escenario 7b: Cuenta autenticada sin perfil en users_prod (huérfana) -> PERMISSION_DENIED (HTTP 403)', async () => {
    const res = await callDownload({
      storagePath: FILES.P_A_DOC,
      prospectId: 'P_A_TITULAR'
    }, sessions.ORPHAN.token);

    expect(res.status).toBe(403);
    expect(res.json.result).toBeUndefined();
    expect(res.json.error.status).toBe('PERMISSION_DENIED');
    expect(res.json.error.message).toContain('Se requiere un usuario activo del CRM');
    expect(JSON.stringify(res.json)).not.toContain('signedUrl');
  });

  // Escenario 8: Verificación exhaustiva de ausencia de signedUrl en todas las denegaciones
  test('Escenario 8: En todos los casos denegados, nunca se devuelve signedUrl ni datos del archivo', async () => {
    const deniedCalls = [
      callDownload({ storagePath: FILES.P_A_DOC, prospectId: 'P_A_TITULAR' }, sessions.V_B.token),
      callDownload({ storagePath: FILES.P_REASSIGNED_DOC, prospectId: 'P_REASSIGNED' }, sessions.V_A.token),
      callDownload({ storagePath: FILES.P_OPEN_DOC, prospectId: 'P_OPEN_LEAD' }, sessions.GES.token),
      callDownload({ storagePath: FILES.P_A_DOC, prospectId: 'P_A_TITULAR' }, null),
      callDownload({ storagePath: FILES.P_A_DOC, prospectId: 'P_A_TITULAR' }, 'bad-token'),
      callDownload({ storagePath: FILES.P_A_DOC, prospectId: 'P_A_TITULAR' }, sessions.INACT.token),
      callDownload({ storagePath: FILES.P_A_DOC, prospectId: 'P_A_TITULAR' }, sessions.ORPHAN.token)
    ];

    const results = await Promise.all(deniedCalls);
    for (const res of results) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.json.result).toBeUndefined();
      expect(JSON.stringify(res.json)).not.toContain('signedUrl');
      expect(JSON.stringify(res.json)).not.toContain('127.0.0.1:9290');
    }
  });

  // Escenario 9: Aislamiento horizontal de documentos de Clientes (cartera)
  test('Escenario 9: Vendedor ajeno no puede descargar documentos de un cliente exclusivo; titular y gestor sí', async () => {
    // Vendedor B intenta acceder a documento de cliente de Vendedor A
    const resB = await callDownload({
      storagePath: FILES.C_A_DOC,
      clientId: 'C_A_EXCLUSIVE'
    }, sessions.V_B.token);

    expect(resB.status).toBe(403);
    expect(resB.json.error.status).toBe('PERMISSION_DENIED');
    expect(resB.json.error.message).toContain('No tienes permiso para acceder a los documentos de este cliente');

    // Vendedor A (titular) sí puede
    const resA = await callDownload({
      storagePath: FILES.C_A_DOC,
      clientId: 'C_A_EXCLUSIVE'
    }, sessions.V_A.token);

    expect(resA.status).toBe(200);
    expect(resA.json.result.signedUrl).toBeDefined();

    // Gestor tiene acceso al catálogo general
    const resGes = await callDownload({
      storagePath: FILES.C_A_DOC,
      clientId: 'C_A_EXCLUSIVE'
    }, sessions.GES.token);

    expect(resGes.status).toBe(200);
    expect(resGes.json.result.signedUrl).toBeDefined();
  });

  // Escenario 10: Intento de saltarse la autorización usando una ruta plana legacy con un prospectId propio (H-01)
  test('Escenario 10: Vendedor A no puede descargar archivo confidencial de B usando el prospectId propio si no está referenciado', async () => {
    const resA = await callDownload({
      storagePath: FILES.FLAT_B_DOC,
      prospectId: 'P_A_TITULAR' // P_A es de A, pero no contiene referencia a FLAT_B_DOC
    }, sessions.V_A.token);

    expect(resA.status).toBe(403);
    expect(resA.json.error.status).toBe('PERMISSION_DENIED');
    expect(resA.json.error.message).toContain('El archivo no está vinculado a la oportunidad indicada');
    expect(JSON.stringify(resA.json)).not.toContain('signedUrl');

    // Vendedor B (cuya oportunidad P_B_LEGACY sí contiene la referencia) sí puede
    const resB = await callDownload({
      storagePath: FILES.FLAT_B_DOC,
      prospectId: 'P_B_LEGACY'
    }, sessions.V_B.token);

    expect(resB.status).toBe(200);
    expect(resB.json.result.signedUrl).toBeDefined();
  });

});
