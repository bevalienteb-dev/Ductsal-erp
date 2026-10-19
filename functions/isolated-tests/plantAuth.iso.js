// functions/isolated-tests/plantAuth.iso.js
// TABLET (plant) AUTHENTICATION on the ISOLATED emulators: Auth 9399, Firestore 8190, Functions 5101 (Storage is not used by tablets).
// Nothing here touches production: every host is a hard-coded emulator constant (see iso.js).
//
// WHAT IS EXECUTED FOR REAL (HTTP against the emulators):
//  * the `plantLogin` callable, with real attempts counted in Firestore;
//  * the exchange of the returned custom token for a real Auth ID token (accounts:signInWithCustomToken);
//  * Firestore security rules (rules/plant-tablet.firestore.rules) evaluated for those real ID tokens, for real Auth accounts with
//    commercial claims, and for an account without claims;
//  * the commercial callables called with a plant token.
// WHAT IS REPLAYED: the operator's Firestore operations are REST requests that have the shape of the real writes in
// operador.js / js/op-qa.js / js/op-despacho.js (same collection, same field names, source lines noted). No browser runs here.
// Rules under test: isolated-tests/rules/plant-tablet.firestore.rules (NOT the shared firestore.rules, which is unchanged).
// Optional: PLANT_MATRIX_OUT=/path/file.json writes the measured permission matrix.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { PROJECT, DOCS, REPO, call: http, toFields, fsApi, clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, seedUsers } = require('./iso');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const adminAuth = getAuth();
const adminDb = getFirestore();

const AUTH = 'http://127.0.0.1:9399';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;
const TABLET_RULES = path.join(__dirname, 'rules', 'plant-tablet.firestore.rules');
const SHARED_RULES = path.join(REPO, 'firestore.rules');

// ---------- REST helpers ----------
const val = v => (v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : { integerValue: String(v) });
const FILTER_OPS = { '==': 'EQUAL', in: 'IN', 'array-contains': 'ARRAY_CONTAINS' };
const filterOf = ([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: FILTER_OPS[op], value: op === 'in' ? { arrayValue: { values: v.map(val) } } : val(v) } });
function qry(col, filters, tok) {
  const fl = (filters || []).map(filterOf);
  const where = fl.length === 0 ? {} : { where: fl.length === 1 ? fl[0] : { compositeFilter: { op: 'AND', filters: fl } } };
  return http('POST', `${DOCS}:runQuery`, tok, { structuredQuery: { from: [{ collectionId: col }], ...where } });
}
const upd = (col, id, data, tok) => http('PATCH', `${DOCS}/${col}/${id}?${Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')}&currentDocument.exists=true`, tok, { fields: toFields(data) });
const NAME = (col, id) => `projects/${PROJECT}/databases/(default)/documents/${col}/${id}`;
// a batch (one atomic commit) like `db.batch()` in operador.js: [{ col, id, data, increment? }]
const batch = (writes, tok) => http('POST', `${DOCS}:commit`, tok, {
  writes: writes.map(w => ({
    update: { name: NAME(w.col, w.id), fields: toFields(w.data || {}) },
    updateMask: { fieldPaths: Object.keys(w.data || {}) },
    currentDocument: { exists: true },
    ...(w.increment ? { updateTransforms: Object.entries(w.increment).map(([f, n]) => ({ fieldPath: f, increment: { integerValue: String(n) } })) } : {})
  }))
});
const ok = r => r.status === 200;
const AUTHPOST = async (url, body, tok) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, text, json };
};
const fn = (name, data, tok) => AUTHPOST(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, tok);
const login = (identifier, password) => fn('plantLogin', { identifier, password });
const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const NOW = () => new Date().toISOString();

// ---------- fixture ----------
// Distinct, unusual PIN / password values so a log scan (done outside this file) can prove they never reach the emulator logs.
const OP = (n, extra) => ({ id: `410000000000${n}`, nombre: `Operario ${n}`, activo: true, pin: `739${n}`, password: `48291${n}`, ...extra });
const USERS = {
  op1: OP(1, { role: 'operario', stations: ['CNC (Lamina)', 'Soldadura'] }),
  op2: OP(2, { role: 'operario', stations: ['Pintura'] }),
  arm: OP(3, { role: 'encargado_armado', stations: ['Cierres/Armado/Doblado'] }),
  jef: OP(4, { role: 'jefe_produccion' }),
  qa1: OP(5, { role: 'control_calidad', also_does_dispatch: false }),
  qa2: OP(6, { role: 'control_calidad', also_does_dispatch: true }),
  des: OP(7, { role: 'despacho' }),
  ina: OP(8, { role: 'operario', activo: false, stations: ['Pintura'] })
};
const CRED = Object.fromEntries(Object.entries(USERS).map(([k, u]) => [k, [u.pin, u.password]]));
const TABLET = ['op1', 'op2', 'arm', 'jef', 'qa1', 'qa2', 'des'];
const PERSONAS = ['anon', 'nocl', 'vend', 'mgr', ...TABLET];
const TOK = {};     // persona -> Firebase Auth ID token (real, from the Auth emulator)
const CID = {};     // persona -> cid
let realUsers;      // commercial real accounts

async function reset() {
  await clearIsolatedFirestore();
  await seedUsers();
  for (const u of Object.values(USERS)) await fsApi.seed('users_prod', u.id, u);
  if (realUsers) {
    if (realUsers.mgr) await adminDb.collection('users_prod').doc(realUsers.mgr.cid).set({ id: realUsers.mgr.cid, nombre: 'gerente', email: realUsers.mgr.email, role: 'manager', activo: true, authUid: realUsers.mgr.uid });
    if (realUsers.vend) await adminDb.collection('users_prod').doc(realUsers.vend.cid).set({ id: realUsers.vend.cid, nombre: 'vendedor', email: realUsers.vend.email, role: 'vendedor', activo: true, authUid: realUsers.vend.uid });
  }
}
async function seedFab() {
  const S = (col, id, d) => fsApi.seed(col, id, d);
  await S('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 });
  await S('fabricacion_prod', 'F2', { id: 'F2', codigo: 'OT-2', proyecto: 'Proyecto Dos', etapa: 'Quality Control', qa_status: 'pendiente', stage_timestamps: {} });
  await S('fabricacion_prod', 'F3', { id: 'F3', codigo: 'OT-3', proyecto: 'Proyecto Tres', etapa: 'Despacho', bom: [{ items: [{ tag: 'T1' }] }], stage_timestamps: {} });
  await S('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: [], pauses: [] });
  await S('fabricacion_tasks_prod', 'TB', { id: 'TB', fabricacion_id: 'F1', station: 'Soldadura', status: 'bloqueada', item_tag: 'T1', depends_on: ['TA'] });
  await S('fabricacion_tasks_prod', 'TC', { id: 'TC', fabricacion_id: 'F1', station: 'Pintura', status: 'bloqueada', item_tag: 'T1', depends_on: ['TB'] });
  await S('fabricacion_tasks_prod', 'TP', { id: 'TP', fabricacion_id: 'F1', station: 'Pintura', status: 'pendiente', item_tag: 'T2', depends_on: [] });
  await S('fabricacion_tasks_prod', 'TQ', { id: 'TQ', fabricacion_id: 'F2', station: 'Quality Control', status: 'pendiente', item_tag: 'T1', depends_on: [] });
  await S('fabricacion_tasks_prod', 'TD', { id: 'TD', fabricacion_id: 'F3', station: 'Despacho', status: 'pendiente', item_tag: 'T1', depends_on: [] });
  await S('fabricacion_tasks_prod', 'TF', { id: 'TF', fabricacion_id: 'F2', station: 'Soldadura', status: 'finalizada', item_tag: 'T1', depends_on: [], operator_id: 'x', operator_name: 'x', started_at: NOW(), finished_at: NOW() });
  await S('bobinas_soldadura_prod', 'B1', { codigo: 'B-1', tipo: 'MIG', espesor: '1.2', peso_inicial: 15, unidad: 'kg', status: 'activa', piezas_soldadas: 3, creada_at: NOW() });
  await S('config', 'maquinas', { lista: ['Laser1', 'Fibra1'] });
  await S('config', 'estado_equipos', { Laser1: { status: 'operativa' } });
  await S('alertas_maquinas', 'AL1', { tipo: 'averia', equipo: 'Laser1', leida: false });
  await S('system_prod', 'settings', { usbs: [], visitantes: [], encargados: [] });
  await S('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'Cliente Uno', nit: '06141234567890', createdBy: '1000000000001', visibleTo: ['1000000000001'] });
  await S('prospects_prod', 'P1', { id: 'P1', createdBy: '1000000000001', vendedorId: '1000000000001', clientId: 'C1', estado: 'activo', etapa: 'prospecto', codigo: '202601001', datos: {}, logs: [] });
  await S('proyectos_fabricacion_prod', 'PF1', { id: 'PF1', prospecto_id: 'P1', proyecto: 'Proyecto Uno' });
}
async function realAccount(tag, cid, role) {
  const email = `${tag}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@ductsal-plant.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
  const up = await AUTHPOST(idt('accounts:signUp'), { email, password, returnSecureToken: true });
  if (!up.json || !up.json.localId) {
    throw new Error(`signUp failed for ${tag}: ${up.text}`);
  }
  const uid = up.json.localId;
  if (role) {
    await adminAuth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
    await adminDb.collection('users_prod').doc(cid).set({ id: cid, nombre: tag, email, role, activo: true, authUid: uid });
  }
  const sIn = await AUTHPOST(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid, cid, email, token: sIn.json.idToken };
}
async function resetAttempts() {
  const snap = await adminDb.collection('plantLoginAttempts_prod').get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}
// real login + token exchange, exactly what a tablet would do
async function tabletToken(persona) {
  const r = await login(...CRED[persona]);
  if (!r.json || !r.json.result) throw new Error(`login failed for ${persona}: ${r.text}`);
  const ex = await AUTHPOST(idt('accounts:signInWithCustomToken'), { token: r.json.result.token, returnSecureToken: true });
  if (!ex.json || !ex.json.idToken) throw new Error(`token exchange failed for ${persona}: ${ex.text}`);
  return ex.json.idToken;
}

beforeAll(async () => {
  await assertIsolatedUp();
  const a = await fetch(AUTH + '/').catch(() => null);
  if (!a) throw new Error('Auth emulator 9399 not answering');
  const f = await fetch(FUNCTIONS.replace(`/${PROJECT}/us-central1`, '') + '/').catch(() => null);
  if (!f) throw new Error('Functions emulator 5101 not answering');
  await loadFirestoreRules(TABLET_RULES);
  await reset();
  await seedFab();
  realUsers = {
    mgr: await realAccount('gerente', '4200000000001', 'manager'),
    vend: await realAccount('vendedor', '4200000000002', 'vendedor'),
    nocl: await realAccount('sinclaims', '4200000000003', null)
  };
  TOK.anon = null; TOK.nocl = realUsers.nocl.token; TOK.vend = realUsers.vend.token; TOK.mgr = realUsers.mgr.token;
  for (const p of TABLET) { TOK[p] = await tabletToken(p); CID[p] = USERS[p].id; }
  CID.mgr = realUsers.mgr.cid; CID.vend = realUsers.vend.cid; CID.nocl = 'x'; CID.anon = 'x';
}, 120000);
afterAll(async () => { await loadFirestoreRules(SHARED_RULES); }); // leave the emulator with the shared candidate rules

// ===========================================================================================================
describe('A. plantLogin (server-side PIN + numeric password) over HTTP', () => {
  beforeEach(resetAttempts);

  test('valid login: custom token + profile without PIN / password; the token exchanges for a real Auth ID token with plant claims only', async () => {
    const r = await login(...CRED.op1);
    expect(r.status).toBe(200);
    const { token, profile } = r.json.result;
    expect(profile).toEqual({ id: USERS.op1.id, nombre: 'Operario 1', role: 'operario', stations: ['CNC (Lamina)', 'Soldadura'], also_does_dispatch: false });
    expect(r.text).not.toContain(USERS.op1.pin); expect(r.text).not.toContain(USERS.op1.password); expect(r.text).not.toMatch(/"password"|"pin"/);
    const ex = await AUTHPOST(idt('accounts:signInWithCustomToken'), { token, returnSecureToken: true });
    expect(ex.status).toBe(200);
    const c = claimsOf(ex.json.idToken);
    expect(c).toMatchObject({ plant: true, role: 'operario', cid: USERS.op1.id, user_id: `plant_${USERS.op1.id}` });
    expect(c.manager).toBeUndefined();
    expect(c.email).toBeUndefined();
    expect(c.firebase.sign_in_provider).toBe('custom');
  });
  test('no e-mail account is created for the operator: the Auth user has no e-mail, no password and no linked provider; the CRM profile is untouched', async () => {
    const u = await adminAuth.getUser(`plant_${USERS.op1.id}`);
    expect(u.email).toBeUndefined(); expect(u.passwordHash).toBeUndefined(); expect(u.providerData).toEqual([]);
    const prof = (await adminDb.collection('users_prod').doc(USERS.op1.id).get()).data();
    expect(prof).toEqual(USERS.op1); // no authUid, no hash, no migration
  });
  test('every tablet role can sign in, by PIN and by the name / e-mail operador.js accepts today', async () => {
    for (const p of TABLET) expect((await login(...CRED[p])).json.result.profile.role).toBe(USERS[p].role);
    expect((await login('Operario 2', USERS.op2.password)).json.result.profile.id).toBe(USERS.op2.id);
  });
  test('invalid credentials: wrong password, unknown PIN, right password with another PIN -> the same PERMISSION_DENIED, no token, no secret echoed', async () => {
    const rs = [await login(USERS.op1.pin, '000111'), await login('0000', USERS.op1.password), await login(USERS.op2.pin, USERS.op1.password)];
    rs.forEach(r => { expect(r.json.error.status).toBe('PERMISSION_DENIED'); expect(r.json.result).toBeUndefined(); });
    expect(new Set(rs.map(r => r.json.error.message)).size).toBe(1);
    rs.forEach(r => { expect(r.text).not.toContain(USERS.op1.password); expect(r.text).not.toContain(USERS.op1.pin); });
  });
  test('malformed input (non-numeric password, empty PIN) -> INVALID_ARGUMENT before any lookup', async () => {
    for (const [i, p] of [[USERS.op1.pin, 'abc123'], ['', USERS.op1.password], [USERS.op1.pin, '']]) expect((await login(i, p)).json.error.status).toBe('INVALID_ARGUMENT');
  });
  test('an INACTIVE operator with the right PIN and password gets no token', async () => {
    const r = await login(...CRED.ina);
    expect(r.json.error.status).toBe('PERMISSION_DENIED'); expect(r.json.error.message).toMatch(/inactivo/i);
    expect(r.json.result).toBeUndefined();
  });
  test('commercial users cannot use the tablet login even if their profile has a PIN and a password', async () => {
    await fsApi.seed('users_prod', 'COMM1', { id: 'COMM1', nombre: 'Vendedor Con Pin', role: 'vendedor', activo: true, pin: '8123', password: '812345', authUid: 'x' });
    await fsApi.seed('users_prod', 'COMM2', { id: 'COMM2', nombre: 'Gerente Con Pin', role: 'manager', activo: true, pin: '8124', password: '812346', authUid: 'y' });
    expect((await login('8123', '812345')).json.error.status).toBe('PERMISSION_DENIED');
    expect((await login('8124', '812346')).json.error.status).toBe('PERMISSION_DENIED');
  });
  test('attempt limit: 5 wrong attempts answered normally, the 6th is RESOURCE_EXHAUSTED, and the CORRECT password is refused while locked; another operator is not affected', async () => {
    for (let n = 0; n < 5; n++) expect((await login(USERS.op2.pin, '000111')).json.error.status).toBe('PERMISSION_DENIED');
    expect((await login(USERS.op2.pin, '000111')).json.error.status).toBe('RESOURCE_EXHAUSTED');
    const locked = await login(...CRED.op2);
    expect(locked.json.error.status).toBe('RESOURCE_EXHAUSTED'); expect(locked.json.error.message).toMatch(/minuto/);
    expect((await login(...CRED.op1)).json.result.profile.id).toBe(USERS.op1.id);
  });
  test('the lock is also applied to identifiers that do not exist (no enumeration)', async () => {
    for (let n = 0; n < 5; n++) await login('0000', '111111');
    expect((await login('0000', '111111')).json.error.status).toBe('RESOURCE_EXHAUSTED');
  });
  test('a successful login clears the counter: 4 failures + success + 4 failures never locks', async () => {
    for (let n = 0; n < 4; n++) await login(USERS.op1.pin, '000111');
    expect((await login(...CRED.op1)).json.result).toBeDefined();
    for (let n = 0; n < 4; n++) expect((await login(USERS.op1.pin, '000111')).json.error.status).toBe('PERMISSION_DENIED');
  });
  test('parallel guesses cannot beat the limit (real Firestore transactions): 15 simultaneous wrong attempts -> exactly 5 evaluated', async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, () => login(USERS.arm.pin, '000111')));
    expect(rs.filter(r => r.json.error.status === 'PERMISSION_DENIED')).toHaveLength(5);
    expect(rs.filter(r => r.json.error.status === 'RESOURCE_EXHAUSTED')).toHaveLength(10);
  });
  test('the attempt records contain no PIN, password or typed identifier (hashed keys only)', async () => {
    await login(USERS.des.pin, '000111');
    const dump = JSON.stringify((await adminDb.collection('plantLoginAttempts_prod').get()).docs.map(d => ({ id: d.id, ...d.data() })));
    expect(dump).not.toContain(USERS.des.pin); expect(dump).not.toContain('000111'); expect(dump).toMatch(/"id":"id_[0-9a-f]{64}"/);
  });
  test('a client cannot read or write the attempt records or the profiles (rules default-deny)', async () => {
    expect(ok(await qry('plantLoginAttempts_prod', [], TOK.op1))).toBe(false);
    expect(ok(await qry('plantLoginAttempts_prod', [], TOK.mgr))).toBe(false);
    expect(ok(await fsApi.set('plantLoginAttempts_prod', 'x', { count: 0 }, TOK.op1))).toBe(false);
  });
});

// ===========================================================================================================
// B. permission matrix (rules): collection x operation x persona
const RESULTS = [];
const only = (...who) => who;
const ALL_TABLET = TABLET;
const TAB_AND_MGR = ['mgr', ...ALL_TABLET];
const OPS = [
  // ---- reads (operador.js listeners and queries) ----
  { id: 'get fabricacion_tasks/TA', col: 'fabricacion_tasks', kind: 'get', src: 'operador.js:2381', allow: TAB_AND_MGR, run: t => fsApi.get('fabricacion_tasks_prod', 'TA', t) },
  { id: 'list fabricacion_tasks (unfiltered onSnapshot)', col: 'fabricacion_tasks', kind: 'list', src: 'operador.js:4036 (jefe dashboard)', allow: TAB_AND_MGR, run: t => qry('fabricacion_tasks_prod', [], t) },
  { id: 'list fabricacion_tasks where fabricacion_id ==', col: 'fabricacion_tasks', kind: 'list', src: 'operador.js:1895,2009,2570 (all stations of an order)', allow: TAB_AND_MGR, run: t => qry('fabricacion_tasks_prod', [['fabricacion_id', '==', 'F1']], t) },
  { id: 'list fabricacion_tasks where station == own', col: 'fabricacion_tasks', kind: 'list', src: 'operador.js:1646-2888 (station queues)', allow: TAB_AND_MGR, run: t => qry('fabricacion_tasks_prod', [['station', '==', 'Pintura']], t) },
  { id: 'list fabricacion_tasks depends_on array-contains + status == bloqueada', col: 'fabricacion_tasks', kind: 'list', src: 'operador.js:2064 (unblockDependents)', allow: TAB_AND_MGR, run: t => qry('fabricacion_tasks_prod', [['depends_on', 'array-contains', 'TA'], ['status', '==', 'bloqueada']], t) },
  { id: 'list fabricacion (unfiltered)', col: 'fabricacion', kind: 'list', src: 'operador.js:4025', allow: TAB_AND_MGR, run: t => qry('fabricacion_prod', [], t) },
  { id: 'list fabricacion where etapa in [Fabricación, Quality Control]', col: 'fabricacion', kind: 'list', src: 'operador.js:468 (QA queue)', allow: TAB_AND_MGR, run: t => qry('fabricacion_prod', [['etapa', 'in', ['Fabricación', 'Quality Control']]], t) },
  { id: 'get fabricacion/F1', col: 'fabricacion', kind: 'get', src: 'operador.js:1766,1821,2911', allow: TAB_AND_MGR, run: t => fsApi.get('fabricacion_prod', 'F1', t) },
  { id: 'list bobinas_soldadura where status == activa', col: 'bobinas_soldadura', kind: 'list', src: 'operador.js:3640', allow: TAB_AND_MGR, run: t => qry('bobinas_soldadura_prod', [['status', '==', 'activa']], t) },
  { id: 'get config/maquinas', col: 'config', kind: 'get', src: 'operador.js:1150,4047', allow: TAB_AND_MGR, run: t => fsApi.get('config', 'maquinas', t) },
  { id: 'get config/estado_equipos', col: 'config', kind: 'get', src: 'operador.js:4055', allow: TAB_AND_MGR, run: t => fsApi.get('config', 'estado_equipos', t) },
  { id: 'list alertas_maquinas where leida == false', col: 'alertas_maquinas', kind: 'list', src: 'operador.js:4074,4225', allow: TAB_AND_MGR, run: t => qry('alertas_maquinas', [['leida', '==', false]], t) },
  { id: 'get system/settings', col: 'system', kind: 'get', src: 'operador.js:~200', allow: ['vend', 'mgr', ...ALL_TABLET], run: t => fsApi.get('system_prod', 'settings', t) },
  // ---- commercial / identity data: never for a tablet ----
  { id: 'get users/<own profile> (holds the plain PIN and password today)', col: 'users', kind: 'get', src: '-', allow: ['mgr', 'vend'], run: (t, w) => fsApi.get('users_prod', CID[w] || USERS.op1.id, t) },
  { id: 'get users/OP1', col: 'users', kind: 'get', src: '-', allow: ['mgr'], run: t => fsApi.get('users_prod', USERS.op1.id, t) },
  { id: 'list users where role in [plant roles] (the login query of today)', col: 'users', kind: 'list', src: 'operador.js:262', allow: ['mgr'], run: t => qry('users_prod', [['role', 'in', ['operario', 'encargado_armado', 'jefe_produccion', 'control_calidad', 'despacho']]], t) },
  { id: 'get userDirectory/OP1', col: 'userDirectory', kind: 'get', src: '-', allow: ['vend', 'mgr'], prepare: () => fsApi.seed('userDirectory_prod', 'OP1', { id: 'OP1', nombre: 'x' }), run: t => fsApi.get('userDirectory_prod', 'OP1', t) },
  { id: 'get clients/C1', col: 'clients', kind: 'get', src: '-', allow: ['mgr'], run: t => fsApi.get('clients_prod', 'C1', t) },
  { id: 'list clients', col: 'clients', kind: 'list', src: '-', allow: ['mgr'], run: t => qry('clients_prod', [], t) },
  { id: 'get prospects/P1', col: 'prospects', kind: 'get', src: '-', allow: ['mgr'], run: t => fsApi.get('prospects_prod', 'P1', t) },
  { id: 'list prospects', col: 'prospects', kind: 'list', src: '-', allow: ['mgr'], run: t => qry('prospects_prod', [], t) },
  { id: 'list audit_logs', col: 'audit_logs', kind: 'list', src: '-', allow: ['mgr'], run: t => qry('audit_logs_prod', [], t) },
  { id: 'create audit_logs', col: 'audit_logs', kind: 'create', src: '-', allow: ['vend', 'mgr'], run: (t, w) => fsApi.create('audit_logs_prod', `AL-${w}-${Date.now()}`, { usuario: w, accion: 'x' }, t) },
  { id: 'get proyectos_fabricacion/PF1', col: 'proyectos_fabricacion', kind: 'get', src: '-', allow: ['mgr'], run: t => fsApi.get('proyectos_fabricacion_prod', 'PF1', t) },
  { id: 'write system/settings', col: 'system', kind: 'update', src: '-', allow: ['mgr'], run: t => upd('system_prod', 'settings', { encargados: ['x'] }, t) },
  { id: 'write prospects/P1 (commercial field)', col: 'prospects', kind: 'update', src: '-', allow: ['mgr'], run: t => upd('prospects_prod', 'P1', { proyecto: 'hack' }, t) },
  { id: 'write clients/C1', col: 'clients', kind: 'update', src: '-', allow: ['mgr'], run: t => upd('clients_prod', 'C1', { telefono: '1' }, t) },
  { id: 'write users/OP1 (change a role / password)', col: 'users', kind: 'update', src: '-', allow: [], run: t => upd('users_prod', USERS.op1.id, { role: 'manager' }, t) },
  // ---- fabricacion_tasks writes ----
  { id: 'advance a task of CNC (Lamina) (status, started_at, operator_*, headcount, pauses)', col: 'fabricacion_tasks', kind: 'update', src: 'operador.js:972', allow: ['mgr', 'op1', 'jef'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: [], pauses: [] }), run: (t, w) => upd('fabricacion_tasks_prod', 'TA', { status: 'en_proceso', started_at: NOW(), operator_id: CID[w], operator_name: w, headcount: 2, pauses: [] }, t) },
  { id: 'advance a task of Pintura', col: 'fabricacion_tasks', kind: 'update', src: 'operador.js:5619', allow: ['mgr', 'op2', 'jef'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TP', { id: 'TP', fabricacion_id: 'F1', station: 'Pintura', status: 'pendiente', item_tag: 'T2', depends_on: [] }), run: (t, w) => upd('fabricacion_tasks_prod', 'TP', { status: 'finalizada', finished_at: NOW(), duracion_minutos: 5, tipo_pieza_principal: 'x' }, t) },
  { id: 'advance a task of Quality Control', col: 'fabricacion_tasks', kind: 'update', src: 'op-qa.js', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TQ', { id: 'TQ', fabricacion_id: 'F2', station: 'Quality Control', status: 'pendiente', item_tag: 'T1', depends_on: [] }), run: (t, w) => upd('fabricacion_tasks_prod', 'TQ', { status: 'en_proceso', started_at: NOW(), operator_id: CID[w] }, t) },
  { id: 'advance a task of Despacho', col: 'fabricacion_tasks', kind: 'update', src: 'operador.js (generic station flow)', allow: ['mgr', 'qa2', 'des'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TD', { id: 'TD', fabricacion_id: 'F3', station: 'Despacho', status: 'pendiente', item_tag: 'T1', depends_on: [] }), run: (t, w) => upd('fabricacion_tasks_prod', 'TD', { status: 'en_proceso', started_at: NOW(), operator_id: CID[w] }, t) },
  { id: 'welding report fields on a Soldadura task (argon, psi, spool_*)', col: 'fabricacion_tasks', kind: 'update', src: 'operador.js:3853', allow: ['mgr', 'op1', 'jef'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TS', { id: 'TS', fabricacion_id: 'F1', station: 'Soldadura', status: 'en_proceso', item_tag: 'T1', depends_on: [] }), run: t => upd('fabricacion_tasks_prod', 'TS', { status: 'finalizada', finished_at: NOW(), argon_consumido: 2, psi_inicio: 100, psi_fin: 90, spool_id: 'B1', spool_codigo: 'B-1', spool_tipo: 'MIG', spool_espesor: '1.2', piezas_soldadas: 4, cambio_cilindro: false }, t) },
  { id: 'TAMPER: change the station of a task', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: [], pauses: [] }), run: t => upd('fabricacion_tasks_prod', 'TA', { station: 'Pintura' }, t) },
  { id: 'TAMPER: move a task to another order (fabricacion_id)', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: [], pauses: [] }), run: t => upd('fabricacion_tasks_prod', 'TA', { fabricacion_id: 'F2' }, t) },
  { id: 'TAMPER: write operator_id of somebody else', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: [], pauses: [] }), run: t => upd('fabricacion_tasks_prod', 'TA', { status: 'en_proceso', operator_id: 'someone-else' }, t) },
  { id: 'TAMPER: clear depends_on of a pending task', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', item_tag: 'T1', depends_on: ['PREV'], pauses: [] }), run: t => upd('fabricacion_tasks_prod', 'TA', { depends_on: [] }, t) },
  { id: 'unblock dependents: bloqueada -> pendiente, depends_on = [] (another station\'s task)', col: 'fabricacion_tasks', kind: 'update', src: 'operador.js:2090-2095', allow: TAB_AND_MGR, prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TB', { id: 'TB', fabricacion_id: 'F1', station: 'Pintura', status: 'bloqueada', item_tag: 'T1', depends_on: ['TA'] }), run: t => upd('fabricacion_tasks_prod', 'TB', { status: 'pendiente', depends_on: [] }, t) },
  { id: 'TAMPER: unblock + extra field (operator_name) on another station\'s task', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TB', { id: 'TB', fabricacion_id: 'F1', station: 'Pintura', status: 'bloqueada', item_tag: 'T1', depends_on: ['TA'] }), run: t => upd('fabricacion_tasks_prod', 'TB', { status: 'pendiente', depends_on: [], operator_name: 'x' }, t) },
  { id: 'TAMPER: finish a task of Pintura that is NOT blocked, from another station', col: 'fabricacion_tasks', kind: 'update', src: '-', allow: ['mgr', 'op2', 'jef'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TP', { id: 'TP', fabricacion_id: 'F1', station: 'Pintura', status: 'pendiente', item_tag: 'T2', depends_on: [] }), run: t => upd('fabricacion_tasks_prod', 'TP', { status: 'finalizada' }, t) },
  { id: 'QA rework: send a finished task back to its station (pendiente + nulls + qa_defect_*)', col: 'fabricacion_tasks', kind: 'update', src: 'op-qa.js:872', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TF', { id: 'TF', fabricacion_id: 'F2', station: 'Soldadura', status: 'finalizada', item_tag: 'T1', depends_on: [], operator_id: 'x', operator_name: 'x', started_at: NOW(), finished_at: NOW() }), run: t => upd('fabricacion_tasks_prod', 'TF', { status: 'pendiente', finished_at: null, started_at: null, operator_id: null, operator_name: null, devuelta_de_qa: true, qa_defect_reported: true, qa_defect_comment: 'rayado', qa_defect_at: NOW() }, t) },
  { id: 'create a task', col: 'fabricacion_tasks', kind: 'create', src: 'js/fabricacion.js:2412 (office, not tablets)', allow: ['mgr'], run: (t, w) => fsApi.create('fabricacion_tasks_prod', `TN-${w}-${Date.now()}`, { id: 'x', station: 'Pintura', status: 'pendiente' }, t) },
  { id: 'delete a task', col: 'fabricacion_tasks', kind: 'delete', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TDEL', { id: 'TDEL', station: 'Pintura', status: 'pendiente' }), run: t => fsApi.del('fabricacion_tasks_prod', 'TDEL', t) },
  // ---- fabricacion (parent order) writes ----
  { id: 'order -> Quality Control when its tasks finish (etapa, stage_timestamps)', col: 'fabricacion', kind: 'update', src: 'operador.js:2046,2595,2828,3185,3522,3914,5657', allow: ['mgr', 'op1', 'op2', 'arm', 'jef'], prepare: () => fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 }), run: t => upd('fabricacion_prod', 'F1', { etapa: 'Quality Control', stage_timestamps: { 'Quality Control': NOW() } }, t) },
  { id: 'order laminas_manuales counter', col: 'fabricacion', kind: 'update', src: 'operador.js:1997', allow: ['mgr', 'op1', 'op2', 'arm', 'jef'], prepare: () => fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 }), run: t => upd('fabricacion_prod', 'F1', { laminas_manuales: 3 }, t) },
  { id: 'TAMPER: order etapa -> Entregado by a production tablet', col: 'fabricacion', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 }), run: t => upd('fabricacion_prod', 'F1', { etapa: 'Entregado' }, t) },
  { id: 'TAMPER: change the project name / code of an order', col: 'fabricacion', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 }), run: t => upd('fabricacion_prod', 'F1', { proyecto: 'otro', codigo: 'OT-9' }, t) },
  { id: 'QA starts a review (qa_status, qa_started_at, qa_pauses)', col: 'fabricacion', kind: 'update', src: 'op-qa.js:96,784', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_prod', 'F2', { id: 'F2', codigo: 'OT-2', proyecto: 'Proyecto Dos', etapa: 'Quality Control', qa_status: 'pendiente', stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F2', { qa_status: 'en_proceso', qa_started_at: NOW(), qa_pauses: [] }, t) },
  { id: 'QA sends the order to Despacho (etapa, qa_status, stage_timestamps)', col: 'fabricacion', kind: 'update', src: 'op-qa.js:373 (advanceOrderToDispatch)', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_prod', 'F2', { id: 'F2', codigo: 'OT-2', proyecto: 'Proyecto Dos', etapa: 'Quality Control', qa_status: 'en_proceso', stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F2', { etapa: 'Despacho', qa_status: 'completada', stage_timestamps: { Despacho: NOW() } }, t) },
  { id: 'QA returns the order to Dibujo (etapa, errores_dibujo)', col: 'fabricacion', kind: 'update', src: 'op-qa.js:886-900', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_prod', 'F2', { id: 'F2', codigo: 'OT-2', proyecto: 'Proyecto Dos', etapa: 'Quality Control', qa_status: 'en_proceso', stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F2', { etapa: 'Dibujo', qa_status: 'completada', errores_dibujo: 1, stage_timestamps: { Dibujo_Regreso_1: NOW() } }, t) },
  { id: 'TAMPER: QA moves an order that is NOT in Quality Control', col: 'fabricacion', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', codigo: 'OT-1', proyecto: 'Proyecto Uno', etapa: 'Fabricación', stage_timestamps: {}, laminas_manuales: 0 }), run: t => upd('fabricacion_prod', 'F1', { etapa: 'Despacho' }, t) },
  { id: 'Despacho registers the delivery (bom, dispatch_registry, etapa = Entregado)', col: 'fabricacion', kind: 'update', src: 'op-despacho.js:311', allow: ['mgr', 'qa2', 'des'], prepare: () => fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', codigo: 'OT-3', proyecto: 'Proyecto Tres', etapa: 'Despacho', bom: [{ items: [{ tag: 'T1' }] }], stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F3', { bom: [{ items: [{ tag: 'T1', entregado: true }] }], dispatch_registry: { recibido_nombre: 'Cliente', fecha: '2026-03-15' }, etapa: 'Entregado', stage_timestamps: { Entregado: NOW() } }, t) },
  { id: 'Despacho saves accessories progress (bom only)', col: 'fabricacion', kind: 'update', src: 'op-despacho.js:339', allow: ['mgr', 'qa2', 'des'], prepare: () => fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', codigo: 'OT-3', proyecto: 'Proyecto Tres', etapa: 'Despacho', bom: [], stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F3', { bom: [{ items: [{ tag: 'T1' }] }] }, t) },
  { id: 'TAMPER: Despacho sends an order back to Fabricación', col: 'fabricacion', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', codigo: 'OT-3', proyecto: 'Proyecto Tres', etapa: 'Despacho', bom: [{ items: [{ tag: 'T1' }] }], stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F3', { etapa: 'Fabricación' }, t) },
  { id: 'TAMPER: Despacho writes QA fields (qa_status)', col: 'fabricacion', kind: 'update', src: '-', allow: ['mgr', 'qa1', 'qa2'], prepare: () => fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', codigo: 'OT-3', proyecto: 'Proyecto Tres', etapa: 'Despacho', bom: [{ items: [{ tag: 'T1' }] }], stage_timestamps: {} }), run: t => upd('fabricacion_prod', 'F3', { qa_status: 'completada' }, t) },
  { id: 'create an order', col: 'fabricacion', kind: 'create', src: '-', allow: ['mgr'], run: (t, w) => fsApi.create('fabricacion_prod', `FN-${w}-${Date.now()}`, { id: 'x', etapa: 'Fabricación' }, t) },
  { id: 'delete an order', col: 'fabricacion', kind: 'delete', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('fabricacion_prod', 'FDEL', { id: 'FDEL', etapa: 'Fabricación' }), run: t => fsApi.del('fabricacion_prod', 'FDEL', t) },
  // ---- welding spools ----
  { id: 'create a spool (status activa, only the spool keys)', col: 'bobinas_soldadura', kind: 'create', src: 'operador.js:3822', allow: ['mgr', 'op1', 'jef'], run: (t, w) => fsApi.create('bobinas_soldadura_prod', `B-${w}-${Date.now()}`, { codigo: 'B-2', tipo: 'MIG', espesor: '1.2', peso_inicial: 15, unidad: 'kg', status: 'activa', piezas_soldadas: 0, creada_at: NOW() }, t) },
  { id: 'TAMPER: create a spool with an extra key / not activa', col: 'bobinas_soldadura', kind: 'create', src: '-', allow: ['mgr'], run: (t, w) => fsApi.create('bobinas_soldadura_prod', `BX-${w}-${Date.now()}`, { codigo: 'B-3', status: 'terminada', extra: 'x' }, t) },
  { id: 'spool piezas_soldadas increment', col: 'bobinas_soldadura', kind: 'update', src: 'operador.js:3835', allow: ['mgr', 'op1', 'jef'], prepare: () => fsApi.seed('bobinas_soldadura_prod', 'B1', { codigo: 'B-1', tipo: 'MIG', espesor: '1.2', peso_inicial: 15, unidad: 'kg', status: 'activa', piezas_soldadas: 3, creada_at: NOW() }), run: t => upd('bobinas_soldadura_prod', 'B1', { piezas_soldadas: 5 }, t) },
  { id: 'spool finished (activa -> terminada)', col: 'bobinas_soldadura', kind: 'update', src: 'operador.js:3842', allow: ['mgr', 'op1', 'jef'], prepare: () => fsApi.seed('bobinas_soldadura_prod', 'B1', { codigo: 'B-1', tipo: 'MIG', espesor: '1.2', peso_inicial: 15, unidad: 'kg', status: 'activa', piezas_soldadas: 3, creada_at: NOW() }), run: t => upd('bobinas_soldadura_prod', 'B1', { status: 'terminada', terminada_at: NOW(), finished_task_id: 'TA', finished_order_code: 'OT-1' }, t) },
  { id: 'TAMPER: change the initial weight of a spool', col: 'bobinas_soldadura', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('bobinas_soldadura_prod', 'B1', { codigo: 'B-1', tipo: 'MIG', espesor: '1.2', peso_inicial: 15, unidad: 'kg', status: 'activa', piezas_soldadas: 3, creada_at: NOW() }), run: t => upd('bobinas_soldadura_prod', 'B1', { peso_inicial: 999 }, t) },
  { id: 'delete a spool', col: 'bobinas_soldadura', kind: 'delete', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('bobinas_soldadura_prod', 'BDEL', { codigo: 'B-9', status: 'activa' }), run: t => fsApi.del('bobinas_soldadura_prod', 'BDEL', t) },
  // ---- machine status and alerts (un-suffixed, shared collections) ----
  { id: 'report machine status (config/estado_equipos merge)', col: 'config', kind: 'update', src: 'operador.js:4217,4218', allow: TAB_AND_MGR, run: (t, w) => upd('config', 'estado_equipos', { Laser1: { status: 'dañada', reportada_por: w } }, t) },
  { id: 'write config/maquinas', col: 'config', kind: 'update', src: 'js/ui.js:808 (office)', allow: ['mgr'], run: t => upd('config', 'maquinas', { lista: ['x'] }, t) },
  { id: 'operator reports a failure (alertas_maquinas add)', col: 'alertas_maquinas', kind: 'create', src: 'operador.js:1183,5733', allow: TAB_AND_MGR, run: (t, w) => fsApi.create('alertas_maquinas', `AL-${w}-${Date.now()}`, { tipo: 'averia', estacion: 'Soldadura', equipo: 'Laser1', operador: w, codigo_orden: 'OT-1', proyecto: 'P', created_at: NOW(), leida: false }, t) },
  { id: 'TAMPER: alert created already read / with extra keys', col: 'alertas_maquinas', kind: 'create', src: '-', allow: ['mgr'], run: (t, w) => fsApi.create('alertas_maquinas', `ALX-${w}-${Date.now()}`, { tipo: 'x', leida: true, extra: 1 }, t) },
  { id: 'mark an alert as read (leida = true)', col: 'alertas_maquinas', kind: 'update', src: 'operador.js:4231,5750', allow: TAB_AND_MGR, prepare: () => fsApi.seed('alertas_maquinas', 'AL1', { tipo: 'averia', equipo: 'Laser1', leida: false }), run: t => upd('alertas_maquinas', 'AL1', { leida: true }, t) },
  { id: 'TAMPER: edit another field of an alert', col: 'alertas_maquinas', kind: 'update', src: '-', allow: ['mgr'], prepare: () => fsApi.seed('alertas_maquinas', 'AL1', { tipo: 'averia', equipo: 'Laser1', leida: false }), run: t => upd('alertas_maquinas', 'AL1', { equipo: 'otro' }, t) },
  { id: 'delete an alert', col: 'alertas_maquinas', kind: 'delete', src: '-', allow: [], run: t => fsApi.del('alertas_maquinas', 'AL1', t) }
];

describe('B. permission matrix: every operation x every persona (rules/plant-tablet.firestore.rules)', () => {
  beforeAll(async () => { await loadFirestoreRules(TABLET_RULES); await reset(); await seedFab(); });
  for (const op of OPS) {
    test(`${op.col} · ${op.id}`, async () => {
      const got = {};
      for (const persona of PERSONAS) {
        if (op.prepare) await op.prepare();
        const r = await op.run(TOK[persona], persona);
        got[persona] = r.status === 200;
        RESULTS.push({ op: op.id, module: op.src.startsWith('js/ui') || op.src.startsWith('js/fab') ? 'FAB' : 'TAB', src: op.src, col: op.col, kind: op.kind, persona, allowed: got[persona] });
      }
      const expected = Object.fromEntries(PERSONAS.map(p => [p, op.allow.includes(p)]));
      expect(got).toEqual(expected);
    });
  }
  afterAll(() => {
    if (process.env.PLANT_MATRIX_OUT) fs.writeFileSync(process.env.PLANT_MATRIX_OUT, JSON.stringify(RESULTS, null, 1));
  });
});

// ===========================================================================================================
describe('C. operator workflow end to end with REAL tablet sessions (batches, increments, real order of events)', () => {
  beforeAll(async () => { await loadFirestoreRules(TABLET_RULES); await reset(); await seedFab(); });
  test('station CNC (Lamina) -> Soldadura -> Pintura -> Quality Control -> Despacho -> Entregado, each step by the right role', async () => {
    const t1 = TOK.op1; const t2 = TOK.op2; const c1 = CID.op1;
    // CNC operator starts TA (batch.update like operador.js:972)
    expect(ok(await batch([{ col: 'fabricacion_tasks_prod', id: 'TA', data: { status: 'en_proceso', started_at: NOW(), operator_id: c1, operator_name: 'Operario 1', headcount: 1 } }], t1))).toBe(true);
    // ... finishes it and releases Soldadura (own task + unblockDependents of ANOTHER station's task) in ONE atomic batch
    expect(ok(await batch([
      { col: 'fabricacion_tasks_prod', id: 'TA', data: { status: 'finalizada', finished_at: NOW(), duracion_minutos: 4, tipo_pieza_principal: 'Lámina', cut_report: { piezas: 3 } } },
      { col: 'fabricacion_tasks_prod', id: 'TB', data: { status: 'pendiente', depends_on: [] } }
    ], t1))).toBe(true);
    // Soldadura: new spool + task finished with welding data + spool counter, in one batch (operador.js:3822-3853)
    expect(ok(await batch([
      { col: 'fabricacion_tasks_prod', id: 'TB', data: { status: 'finalizada', finished_at: NOW(), argon_consumido: 1, psi_inicio: 100, psi_fin: 95, spool_id: 'B1', spool_codigo: 'B-1', spool_tipo: 'MIG', spool_espesor: '1.2', piezas_soldadas: 4, cambio_cilindro: false } },
      { col: 'bobinas_soldadura_prod', id: 'B1', data: {}, increment: { piezas_soldadas: 4 } },
      { col: 'fabricacion_tasks_prod', id: 'TC', data: { status: 'pendiente', depends_on: [] } }
    ], t1))).toBe(true);
    expect((await fsApi.get('bobinas_soldadura_prod', 'B1', t1)).body).toContain('"integerValue": "7"');
    // Pintura operator takes TC and finishes; the parent order moves to Quality Control
    expect(ok(await batch([{ col: 'fabricacion_tasks_prod', id: 'TC', data: { status: 'finalizada', finished_at: NOW(), operator_id: CID.op2 } }], t2))).toBe(true);
    expect(ok(await upd('fabricacion_prod', 'F1', { etapa: 'Quality Control', stage_timestamps: { 'Quality Control': NOW() } }, t2))).toBe(true);
    // QA (also dispatch) reviews and sends to Despacho, then delivers
    expect(ok(await upd('fabricacion_prod', 'F1', { qa_status: 'en_proceso', qa_started_at: NOW(), qa_pauses: [] }, TOK.qa2))).toBe(true);
    expect(ok(await upd('fabricacion_prod', 'F1', { etapa: 'Despacho', qa_status: 'completada', stage_timestamps: { Despacho: NOW() } }, TOK.qa2))).toBe(true);
    expect(ok(await upd('fabricacion_prod', 'F1', { bom: [{ items: [] }], dispatch_registry: { recibido_nombre: 'Cliente' }, etapa: 'Entregado', stage_timestamps: { Entregado: NOW() } }, TOK.des))).toBe(true);
    const f = JSON.parse((await fsApi.get('fabricacion_prod', 'F1', TOK.des)).body);
    expect(f.fields.etapa.stringValue).toBe('Entregado');
  });
  test('a whole batch is refused when ONE of its writes is not allowed (atomic): the allowed half is not applied either', async () => {
    await fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', depends_on: [] });
    const r = await batch([
      { col: 'fabricacion_tasks_prod', id: 'TA', data: { status: 'en_proceso', operator_id: CID.op2 } },   // op2 does not own CNC (Lamina)
      { col: 'fabricacion_tasks_prod', id: 'TP', data: { status: 'en_proceso' } }
    ], TOK.op2);
    expect(ok(r)).toBe(false);
    expect(JSON.parse((await fsApi.get('fabricacion_tasks_prod', 'TA', TOK.mgr)).body).fields.status.stringValue).toBe('pendiente');
  });
  test('a QA failure sends a piece back and the station can take it again (rework round trip)', async () => {
    await seedFab();
    expect(ok(await upd('fabricacion_tasks_prod', 'TF', { status: 'pendiente', finished_at: null, started_at: null, operator_id: null, operator_name: null, devuelta_de_qa: true, qa_defect_reported: true, qa_defect_comment: 'x', qa_defect_at: NOW() }, TOK.qa1))).toBe(true);
    expect(ok(await upd('fabricacion_tasks_prod', 'TF', { status: 'en_proceso', started_at: NOW(), operator_id: CID.op1, operator_name: 'Operario 1' }, TOK.op1))).toBe(true);
    expect(ok(await upd('fabricacion_prod', 'F2', { etapa: 'Fabricación', qa_status: 'completada', errores_fabricacion: 1, stage_timestamps: { Fabricación_Regreso_1: NOW() } }, TOK.qa1))).toBe(true);
  });
  test('two tablets writing the same task at the same time are both accepted by the rules (no transaction in operador.js: last write wins) - rules cannot fix that', async () => {
    await seedFab();
    const rs = await Promise.all([1, 2, 3].map(n => upd('fabricacion_tasks_prod', 'TA', { headcount: n }, TOK.op1)));
    expect(rs.every(ok)).toBe(true);
  });
});

// ===========================================================================================================
describe('D. effects of changes in the profile apply to a still-valid token at once (rules read the CURRENT profile)', () => {
  beforeEach(async () => { await loadFirestoreRules(TABLET_RULES); await reset(); await seedFab(); });
  const advance = (t, c) => upd('fabricacion_tasks_prod', 'TP', { status: 'en_proceso', operator_id: c }, t);

  test('deactivating the operator: the same token that worked a moment ago is refused for reads AND writes', async () => {
    expect(ok(await advance(TOK.op2, CID.op2))).toBe(true);
    expect(ok(await qry('fabricacion_tasks_prod', [], TOK.op2))).toBe(true);
    await adminDb.collection('users_prod').doc(USERS.op2.id).update({ activo: false });
    expect(ok(await advance(TOK.op2, CID.op2))).toBe(false);
    expect(ok(await qry('fabricacion_tasks_prod', [], TOK.op2))).toBe(false);
    expect(ok(await fsApi.get('config', 'maquinas', TOK.op2))).toBe(false);
    expect((await login(...CRED.op2)).json.error.message).toMatch(/inactivo/i);
  });
  test('removing a station from the profile: writes on that station stop at once, the other station keeps working', async () => {
    await fsApi.seed('fabricacion_tasks_prod', 'TA', { id: 'TA', fabricacion_id: 'F1', station: 'CNC (Lamina)', status: 'pendiente', depends_on: [] });
    await fsApi.seed('fabricacion_tasks_prod', 'TS', { id: 'TS', fabricacion_id: 'F1', station: 'Soldadura', status: 'pendiente', depends_on: [] });
    expect(ok(await upd('fabricacion_tasks_prod', 'TA', { status: 'en_proceso' }, TOK.op1))).toBe(true);
    await adminDb.collection('users_prod').doc(USERS.op1.id).update({ stations: ['Soldadura'] });
    expect(ok(await upd('fabricacion_tasks_prod', 'TA', { status: 'finalizada' }, TOK.op1))).toBe(false);
    expect(ok(await upd('fabricacion_tasks_prod', 'TS', { status: 'en_proceso' }, TOK.op1))).toBe(true);
  });
  test('adding a station takes effect without a new login', async () => {
    expect(ok(await advance(TOK.op1, CID.op1))).toBe(false);          // op1 is not a Pintura operator
    await adminDb.collection('users_prod').doc(USERS.op1.id).update({ stations: ['CNC (Lamina)', 'Soldadura', 'Pintura'] });
    expect(ok(await advance(TOK.op1, CID.op1))).toBe(true);
  });
  test('changing the role in the profile invalidates the token (claim role != profile role)', async () => {
    await adminDb.collection('users_prod').doc(USERS.op1.id).update({ role: 'vendedor' });
    expect(ok(await qry('fabricacion_tasks_prod', [], TOK.op1))).toBe(false);
    expect(ok(await fsApi.get('system_prod', 'settings', TOK.op1))).toBe(false);
  });
  test('deleting the profile invalidates the token', async () => {
    await adminDb.collection('users_prod').doc(USERS.op2.id).delete();
    expect(ok(await qry('fabricacion_tasks_prod', [], TOK.op2))).toBe(false);
  });
  test('QA turning the dispatch permission off / on in the profile applies at once', async () => {
    await fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', etapa: 'Despacho', bom: [], stage_timestamps: {} });
    const deliver = () => upd('fabricacion_prod', 'F3', { etapa: 'Entregado', dispatch_registry: { r: 1 } }, TOK.qa2);
    expect(ok(await deliver())).toBe(true);
    await fsApi.seed('fabricacion_prod', 'F3', { id: 'F3', etapa: 'Despacho', bom: [], stage_timestamps: {} });
    await adminDb.collection('users_prod').doc(USERS.qa2.id).update({ also_does_dispatch: false });
    expect(ok(await deliver())).toBe(false);
  });
});

// ===========================================================================================================
describe('E. separation from the CRM', () => {
  beforeAll(async () => { await loadFirestoreRules(TABLET_RULES); await reset(); await seedFab(); });
  beforeEach(resetAttempts);

  test('a plant session is refused by every commercial callable (real Auth ID token minted through plantLogin)', async () => {
    const calls = [
      ['createProspectAdmin', { prospect: { clientId: 'C1', proyecto: 'x', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: 'op-plant-12345678' }],
      ['searchClientsCatalog', { q: 'Cliente' }],
      ['createClientAdmin', { client: { tipo: 'natural', nombres: 'A', apellidos: 'B', dui: '123456789' }, opId: 'op-plant-87654321' }],
      ['addProspectLogAdmin', { prospectId: 'P1', text: 'x', opId: 'op-plant-11111111' }],
      ['advanceProspectStageAdmin', { prospectId: 'P1', nextStage: 'levantamiento', data: {} }],
      ['saveInvoiceAdmin', { prospectId: 'P1', numero: 'F1', monto: 1, opId: 'op-plant-22222222' }],
      ['deleteProspectAdmin', { prospectId: 'P1', motivo: 'x' }],
      ['resolveNoContractAuthorizationAdmin', { prospectId: 'P1', requestId: 'r', decision: 'approve' }],
      ['updateSettingsAdmin', { action: 'addItem', list: 'visitantes', value: 'x' }],
      ['updateUserAdmin', { id: USERS.op1.id, nombre: 'x', opId: 'op-plant-33333333' }],
      ['toggleUserStatusAdmin', { id: USERS.op1.id, activo: false, opId: 'op-plant-44444444' }],
      ['createUserAdmin', { email: 'z@z.invalid', nombre: 'Z', role: 'manager', opId: 'op-plant-55555555' }]
    ];
    for (const persona of ['op1', 'jef', 'qa1', 'des']) {
      for (const [name, data] of calls) {
        const r = await fn(name, data, TOK[persona]);
        expect(['PERMISSION_DENIED', 'FAILED_PRECONDITION']).toContain(r.json.error.status);
      }
    }
  });
  test('control: the same callables DO work for a real commercial manager (so the refusals above are about the session, not the call)', async () => {
    await adminDb.collection('clients_prod').doc('C1').set({ id: 'C1', tipo: 'juridica', empresa: 'Cliente Uno', nit: '06141234567890', createdBy: realUsers.mgr.cid });
    const r = await fn('searchClientsCatalog', { q: 'Cliente' }, realUsers.mgr.token);
    expect(r.json.error).toBeUndefined();
  });
  test('the plant token carries no commercial claim and its uid is never a CRM profile authUid', async () => {
    for (const p of TABLET) {
      const c = claimsOf(TOK[p]);
      expect(c.plant).toBe(true); expect(c.manager).toBeUndefined();
      const clash = await adminDb.collection('users_prod').where('authUid', '==', c.user_id).get();
      expect(clash.size).toBe(0);
    }
  });
  test('commercial data stays out of reach of every tablet role (rules): clients, prospects, users, userDirectory, audit_logs, proyectos_fabricacion, system writes', async () => {
    for (const p of TABLET) {
      for (const [col, id] of [['clients_prod', 'C1'], ['prospects_prod', 'P1'], ['users_prod', CID[p]], ['proyectos_fabricacion_prod', 'PF1']]) expect(ok(await fsApi.get(col, id, TOK[p]))).toBe(false);
      for (const col of ['clients_prod', 'prospects_prod', 'users_prod', 'audit_logs_prod', 'proyectos_fabricacion_prod']) expect(ok(await qry(col, [], TOK[p]))).toBe(false);
      expect(ok(await upd('system_prod', 'settings', { encargados: ['x'] }, TOK[p]))).toBe(false);
      expect(ok(await upd('prospects_prod', 'P1', { estado: 'ganado' }, TOK[p]))).toBe(false);
    }
  });
  test('an account created through open sign-up (no claims) gets nothing, not even the tablet reads', async () => {
    for (const col of ['fabricacion_tasks_prod', 'fabricacion_prod', 'system_prod', 'bobinas_soldadura_prod']) expect(ok(await qry(col, [], TOK.nocl))).toBe(false);
    expect(ok(await fsApi.get('config', 'maquinas', TOK.nocl))).toBe(false);
  });
  test('a FORGED token (plant claims but another uid, or a wrong role) is not a tablet session', async () => {
    const { token } = require('./iso');
    const forged = [
      token('someone-else', { plant: true, role: 'operario', cid: USERS.op1.id }),               // uid != plant_<cid>
      token(`plant_${USERS.op1.id}`, { plant: true, role: 'jefe_produccion', cid: USERS.op1.id }), // claim role != profile role
      token(`plant_${USERS.op1.id}`, { role: 'operario', cid: USERS.op1.id }),                    // no plant claim
      token(`plant_${USERS.op1.id}`, { plant: true, role: 'manager', cid: USERS.op1.id })          // role outside the tablet roles
    ];
    for (const t of forged) expect(ok(await qry('fabricacion_tasks_prod', [], t))).toBe(false);
  });
  test('the commercial session of a vendedor still works exactly as before under these rules (control): own opportunities by filter, none of the plant writes', async () => {
    await adminDb.collection('prospects_prod').doc('PV').set({ id: 'PV', createdBy: realUsers.vend.cid, vendedorId: realUsers.vend.cid, clientId: 'C1', estado: 'activo', datos: {} });
    expect(ok(await qry('prospects_prod', [['createdBy', '==', realUsers.vend.cid]], realUsers.vend.token))).toBe(true);
    expect(ok(await qry('prospects_prod', [], realUsers.vend.token))).toBe(false);
    expect(ok(await upd('fabricacion_tasks_prod', 'TA', { status: 'x' }, realUsers.vend.token))).toBe(false);
  });
  test('the shared file firestore.rules is NOT the file under test here and was not modified (still denies a tablet session everything)', async () => {
    await loadFirestoreRules(SHARED_RULES);
    for (const p of TABLET) expect(ok(await qry('fabricacion_tasks_prod', [], TOK[p]))).toBe(false);
    await loadFirestoreRules(TABLET_RULES);
  });
});
