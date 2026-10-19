// functions/isolated-tests/jointValidation.iso.js
// JOINT VALIDATION CRM + fabricacion on the ISOLATED emulators (Auth 9399, Firestore 8190, Storage 9290, Functions 5101).
// Nothing here reads or writes production: every host is a hard-coded emulator constant (see iso.js).
//
// WHAT IS EXECUTED (honestly):
//  * The CRM side that goes through the server (callables) is executed for real over HTTP with real Auth tokens.
//  * Both modules' DIRECT Firestore / Storage operations are REPLAYED as REST requests that have the shape of the real code
//    (collection, document, operation, payload keys) with the source file:line noted on each operation. They are NOT the
//    browser code running in a browser (no browser / DOM here). To make sure a replay is well built, every operation is
//    first run against an "open" baseline (legacy-open.firestore.rules, an ASSUMPTION about today's rules: the real ones were
//    not read) and must succeed there; a refusal under the candidate rules is then a rules finding, not a replay error.
//  * The candidate rules are the repository's firestore.rules / storage.rules, loaded byte for byte and NOT modified.
// Optional: JOINT_MATRIX_OUT=/path/file.json writes the measured permission matrix.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { PROJECT, DOCS, REPO, call: http, token, toFields, fsApi, stApi, clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, ID, T, profile, seedUsers } = require('./iso');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const adminAuth = getAuth();
const adminDb = getFirestore();

const FAB_REPO = path.join(REPO, '..', 'fabricacion-dev');
const AUTH = 'http://127.0.0.1:9399';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;
const OPEN_RULES = path.join(__dirname, 'rules', 'legacy-open.firestore.rules');
const CANDIDATE_RULES = path.join(REPO, 'firestore.rules');

// ---------- personas ----------
const QA = '1800000000006'; const DESP = '1800000000007';
const PERSONAS = {
  anon: { tok: T.anon, cid: 'anon' },                // an operator tablet today: no Firebase Auth session at all
  mgr: { tok: T.mgr, cid: ID.MGR },
  ges: { tok: T.ges, cid: ID.GES },
  v1: { tok: T.v1, cid: ID.V1 },
  jefe: { tok: T.jefe, cid: ID.JEFE },
  oper: { tok: T.oper, cid: ID.OPER },
  qa: { tok: token('uid-qa', { role: 'control_calidad', cid: QA }), cid: QA },
  desp: { tok: token('uid-desp', { role: 'despacho', cid: DESP }), cid: DESP },
  recep: { tok: T.recep, cid: ID.RECEP },
  dibu: { tok: T.dibu, cid: ID.DIBU }
};
const PLANT = ['jefe', 'oper', 'qa', 'desp', 'recep', 'dibu'];
const VALID = ['mgr', 'ges', 'v1', ...PLANT];

// ---------- REST helpers ----------
const val = v => (v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : { integerValue: String(v) });
const OPS = { '==': 'EQUAL', in: 'IN', 'array-contains': 'ARRAY_CONTAINS' };
const filterOf = ([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: OPS[op], value: op === 'in' ? { arrayValue: { values: v.map(val) } } : val(v) } });
function qry(col, filters, tok, extra = {}) {
  const fl = (filters || []).map(filterOf);
  const where = fl.length === 0 ? {} : { where: fl.length === 1 ? fl[0] : { compositeFilter: { op: 'AND', filters: fl } } };
  return http('POST', `${DOCS}:runQuery`, tok, { structuredQuery: { from: [{ collectionId: col }], ...where, ...extra } });
}
const upd = (col, id, data, tok) => http('PATCH', `${DOCS}/${col}/${id}?${Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')}&currentDocument.exists=true`, tok, { fields: toFields(data) });
const ok = r => r.status === 200;
const docs = r => (JSON.parse(r.body) || []).filter(x => x.document).map(x => x.document);

// ---------- fixture ----------
async function seedFixture() {
  await seedUsers();
  for (const [id, uid, role] of [[QA, 'uid-qa', 'control_calidad'], [DESP, 'uid-desp', 'despacho']]) await fsApi.seed('users_prod', id, profile(id, uid, role, true));
  // an operator profile as the tablets use it today: PIN + numeric password stored in the profile document
  await fsApi.seed('users_prod', ID.OPER, { ...profile(ID.OPER, 'uid-oper', 'operario'), pin: '4821', password: '123456', stations: ['Corte'] });
  await fsApi.seed('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'Cliente Uno', nit: '06141234567890', createdBy: ID.V1, visibleTo: [ID.MGR, ID.V1, ID.V2] });
  await fsApi.seed('prospects_prod', 'P1', { id: 'P1', createdBy: ID.V1, vendedorId: ID.V1, clientId: 'C1', estado: 'activo', etapa: 'prospecto', codigo: '202601001', datos: {}, logs: [] });
  await fsApi.seed('system_prod', 'settings', { visitantes: ['a'], encargados: ['b'] });
  await fsApi.seed('audit_logs_prod', 'A1', { usuario: 'x', timestamp: 't' });
  await fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', proyecto: 'p', status: 'pendiente' });
  await fsApi.seed('fabricacion_tasks_prod', 'TK1', { id: 'TK1', fabricacion_id: 'F1', status: 'pendiente' });
  await fsApi.seed('proyectos_fabricacion_prod', 'PF1', { id: 'PF1', prospecto_id: 'P1', proyecto: 'Nave' });
  await fsApi.seed('bobinas_soldadura_prod', 'B1', { id: 'B1', kg: 10 });
  await fsApi.seed('config', 'maquinas', { lista: ['m1'] });
  await fsApi.seed('config', 'estado_equipos', { m1: 'ok' });
  await fsApi.seed('alertas_maquinas', 'AL1', { id: 'AL1', leida: false });
}

// ---------- the catalogue of direct Firestore operations ----------
// module: CRM = sales-reporting-system (app_core.js), FAB = fabricacion-dev index.html app (app.js + js/*), TAB = operator tablets (operador.js).
// allow: personas expected to succeed under the CANDIDATE rules (everyone else must be refused).
const uniq = (() => { let n = 0; return p => `${p}-${Date.now()}-${++n}`; })();
const MGR_ALL = ['mgr'];
const mgrGes = ['mgr', 'ges'];
const readPlant = ['mgr', 'ges', ...PLANT];
const mgrPlant = ['mgr', ...PLANT];
const CATALOG = [
  // ----- reads / listeners -----
  { id: 'list.clients (unfiltered onSnapshot)', module: 'CRM+FAB', src: 'app_core.js:472, fabricacion app.js:329', col: 'clients', kind: 'list', allow: mgrGes, run: (t) => qry('clients_prod', [], t) },
  { id: 'list.prospects (unfiltered onSnapshot)', module: 'CRM+FAB', src: 'app_core.js:475, fabricacion app.js:330', col: 'prospects', kind: 'list', allow: mgrGes, run: (t) => qry('prospects_prod', [], t) },
  { id: 'list.users (unfiltered onSnapshot)', module: 'CRM+FAB', src: 'app_core.js:476, fabricacion app.js:331', col: 'users', kind: 'list', allow: MGR_ALL, run: (t) => qry('users_prod', [], t) },
  { id: 'get.system/settings (onSnapshot)', module: 'CRM+FAB', src: 'app_core.js:478, app.js:336', col: 'system', kind: 'read', allow: VALID, run: (t) => fsApi.get('system_prod', 'settings', t) },
  { id: 'list.audit_logs orderBy timestamp limit 20', module: 'CRM', src: 'app_core.js:2674', col: 'audit_logs', kind: 'list', allow: MGR_ALL, run: (t) => qry('audit_logs_prod', [], t, { orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }], limit: 20 }) },
  { id: 'list.fabricacion (onSnapshot)', module: 'FAB+TAB', src: 'app.js:332, operador.js:4025', col: 'fabricacion', kind: 'list', allow: readPlant, run: (t) => qry('fabricacion_prod', [], t) },
  { id: 'list.fabricacion_tasks (onSnapshot)', module: 'FAB+TAB', src: 'app.js:334, operador.js:4036', col: 'fabricacion_tasks', kind: 'list', allow: readPlant, run: (t) => qry('fabricacion_tasks_prod', [], t) },
  { id: 'list.proyectos_fabricacion (onSnapshot)', module: 'FAB', src: 'app.js:333', col: 'proyectos_fabricacion', kind: 'list', allow: readPlant, run: (t) => qry('proyectos_fabricacion_prod', [], t) },
  { id: 'list.bobinas_soldadura (onSnapshot)', module: 'FAB+TAB', src: 'app.js:369, operador.js:4063', col: 'bobinas_soldadura', kind: 'list', allow: mgrPlant, run: (t) => qry('bobinas_soldadura_prod', [], t) },
  { id: 'get.config/maquinas (onSnapshot)', module: 'FAB+TAB', src: 'app.js:350, operador.js:4047', col: 'config', kind: 'read', allow: readPlant, run: (t) => fsApi.get('config', 'maquinas', t) },
  { id: 'get.config/estado_equipos (onSnapshot)', module: 'TAB', src: 'operador.js:4055', col: 'config', kind: 'read', allow: readPlant, run: (t) => fsApi.get('config', 'estado_equipos', t) },
  { id: 'list.alertas_maquinas (onSnapshot)', module: 'FAB+TAB', src: 'operador.js:4074, ui.js:637', col: 'alertas_maquinas', kind: 'list', allow: mgrPlant, run: (t) => qry('alertas_maquinas', [], t) },
  { id: 'TAB login: users where role in [plant roles] (PIN / password compare in the browser)', module: 'TAB', src: 'operador.js:262', col: 'users', kind: 'list', allow: MGR_ALL, run: (t) => qry('users_prod', [['role', 'in', ['operario', 'encargado_armado', 'jefe_produccion', 'control_calidad', 'despacho']]], t) },
  // ----- direct writes of the commercial collections (legacy path, replaced by callables in the CRM) -----
  { id: 'write.saveClientToDB: set existing client', module: 'FAB', src: 'app.js:397, js/clientes.js', col: 'clients', kind: 'update', allow: ['mgr', 'ges', 'v1'], run: async (t) => { // like saveClientToDB: whole-document set() of the snapshot it read (incl. the server-maintained visibleTo)
    const cur = await http('GET', `${DOCS}/clients_prod/C1`, 'owner');
    return http('PATCH', `${DOCS}/clients_prod/C1`, t, { fields: { ...JSON.parse(cur.body || '{}').fields, telefono: { stringValue: '7000' } } });
  } },
  { id: 'write.saveClientToDB: create a new client', module: 'FAB', src: 'js/clientes.js (new client)', col: 'clients', kind: 'create', allow: [], run: (t, p) => fsApi.create('clients_prod', uniq('CN'), { id: 'x', tipo: 'natural', nombres: 'Nuevo', createdBy: PERSONAS[p].cid }, t) },
  { id: 'write.delete client + audit', module: 'FAB', src: 'js/clientes.js:327', col: 'clients', kind: 'delete', allow: [], prepare: () => fsApi.seed('clients_prod', 'CDEL', { id: 'CDEL', createdBy: ID.V1, visibleTo: [ID.V1] }), run: (t) => fsApi.del('clients_prod', 'CDEL', t) },
  { id: 'write.audit_logs add (forgeable "usuario")', module: 'CRM+FAB', src: 'js/clientes.js:328, oportunidades.js:1026, proyectos.js:816', col: 'audit_logs', kind: 'create', allow: VALID, run: (t) => fsApi.create('audit_logs_prod', uniq('AUD'), { usuario: 'Cualquiera', timestamp: 't', tipo_item: 'Cliente' }, t) },
  { id: 'write.saveProspectToDB: set existing opportunity', module: 'FAB', src: 'app.js:398, js/oportunidades.js:521, js/proyectos.js', col: 'prospects', kind: 'update', allow: [], run: (t) => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: ID.V1, vendedorId: ID.V1, clientId: 'C1', estado: 'activo', etapa: 'prospecto', codigo: '202601001', datos: {}, logs: [], facturas: [] }, t) },
  { id: 'write.saveProspectToDB: create opportunity directly (own code generator, no audit)', module: 'FAB', src: 'js/oportunidades.js:197,521', col: 'prospects', kind: 'create', allow: ['mgr', 'ges', 'v1'], run: (t, p) => { const id = uniq('PN'); return fsApi.set('prospects_prod', id, { id, createdBy: PERSONAS[p].cid, vendedorId: PERSONAS[p].cid, clientId: 'C1', estado: 'activo', etapa: 'prospecto', codigo: '202601999', datos: {}, logs: [] }, t); } },
  { id: 'write.delete opportunity (physical)', module: 'FAB', src: 'js/oportunidades.js:1017', col: 'prospects', kind: 'delete', allow: [], prepare: () => fsApi.seed('prospects_prod', 'PDEL', { id: 'PDEL', createdBy: ID.V1, vendedorId: ID.V1, clientId: 'C1', datos: {} }), run: (t) => fsApi.del('prospects_prod', 'PDEL', t) },
  { id: 'cascade.list proyectos_fabricacion where prospecto_id == P1', module: 'FAB', src: 'js/oportunidades.js:1020', col: 'proyectos_fabricacion', kind: 'list', allow: readPlant, run: (t) => qry('proyectos_fabricacion_prod', [['prospecto_id', '==', 'P1']], t) },
  { id: 'cascade.delete proyectos_fabricacion', module: 'FAB', src: 'js/oportunidades.js:1022', col: 'proyectos_fabricacion', kind: 'delete', allow: ['mgr', 'jefe'], prepare: () => fsApi.seed('proyectos_fabricacion_prod', 'PFDEL', { id: 'PFDEL', prospecto_id: 'P1' }), run: (t) => fsApi.del('proyectos_fabricacion_prod', 'PFDEL', t) },
  { id: 'write.saveUserToDB: set a user profile', module: 'FAB', src: 'app.js:399, js/auth.js', col: 'users', kind: 'update', allow: [], run: (t) => fsApi.set('users_prod', ID.V2, profile(ID.V2, 'uid-v2', 'vendedor', true), t) },
  { id: 'write.saveSettings: set system/settings (whole document)', module: 'FAB', src: 'app.js:403, js/ui.js', col: 'system', kind: 'update', allow: ['mgr', 'jefe'], run: (t) => fsApi.set('system_prod', 'settings', { visitantes: ['a'], encargados: ['b'], colores_pintura: ['rojo'] }, t) },
  // ----- fabricacion -----
  { id: 'write.send to fabricacion: create proyectos_fabricacion', module: 'FAB', src: 'js/fabricacion.js:122,158', col: 'proyectos_fabricacion', kind: 'create', allow: ['mgr', 'ges', 'jefe'], run: (t, p) => fsApi.set('proyectos_fabricacion_prod', uniq('FAB-PROJ'), { id: 'x', origen_tipo: 'oportunidad', prospecto_id: 'P1', creado_por: p }, t) },
  { id: 'write.saveFabricacionToDB: set existing order', module: 'FAB', src: 'app.js:400', col: 'fabricacion', kind: 'update', allow: ['mgr', 'jefe', 'recep', 'dibu'], run: (t) => fsApi.set('fabricacion_prod', 'F1', { id: 'F1', proyecto: 'p', status: 'pendiente', nota: 'x' }, t) },
  { id: 'write.create fabricacion order / split order batch.set', module: 'FAB', src: 'js/fabricacion.js:1191-1196', col: 'fabricacion', kind: 'create', allow: ['mgr', 'jefe', 'recep', 'dibu'], run: (t) => fsApi.set('fabricacion_prod', uniq('FAB'), { id: 'x', status: 'pendiente' }, t) },
  { id: 'write.OPERATOR updates the parent order (status / progress)', module: 'TAB', src: 'operador.js:1997,2046,2595,2828,3185,3522,3914,5657', col: 'fabricacion', kind: 'update', allow: ['mgr', 'jefe', 'recep', 'dibu'], run: (t) => upd('fabricacion_prod', 'F1', { status: 'en_proceso' }, t) },
  { id: 'write.OPERATOR advances a task (batch.update)', module: 'TAB', src: 'operador.js:1951,2359,2558,2791,3145,3485,3575,3966,4422,5620,5712', col: 'fabricacion_tasks', kind: 'update', allow: mgrPlant, run: (t) => upd('fabricacion_tasks_prod', 'TK1', { status: 'en_proceso' }, t) },
  { id: 'write.create fabricacion_tasks (order generation)', module: 'FAB', src: 'app.js:401, js/fabricacion.js:2412', col: 'fabricacion_tasks', kind: 'create', allow: ['mgr', 'jefe'], run: (t) => fsApi.set('fabricacion_tasks_prod', uniq('TK'), { id: 'x', fabricacion_id: 'F1', status: 'pendiente' }, t) },
  { id: 'write.delete fabricacion_tasks', module: 'FAB', src: 'js/fabricacion.js', col: 'fabricacion_tasks', kind: 'delete', allow: ['mgr', 'jefe'], prepare: () => fsApi.seed('fabricacion_tasks_prod', 'TKDEL', { id: 'TKDEL', fabricacion_id: 'F1' }), run: (t) => fsApi.del('fabricacion_tasks_prod', 'TKDEL', t) },
  { id: 'write.OPERATOR welding spool (bobinas) update / create', module: 'TAB', src: 'operador.js:3822-3842', col: 'bobinas_soldadura', kind: 'update', allow: ['mgr', 'jefe', 'oper'], run: (t) => upd('bobinas_soldadura_prod', 'B1', { kg: 9 }, t) },
  { id: 'write.config/maquinas set', module: 'FAB', src: 'js/ui.js:808', col: 'config', kind: 'update', allow: ['mgr', 'jefe'], run: (t) => fsApi.set('config', 'maquinas', { lista: ['m1', 'm2'] }, t) },
  { id: 'write.config/estado_equipos batch.set (machine status from tablets)', module: 'TAB', src: 'operador.js:4217, js/ui.js:637', col: 'config', kind: 'update', allow: mgrPlant, run: (t) => fsApi.set('config', 'estado_equipos', { m1: 'ok', m2: 'falla' }, t) },
  { id: 'write.alertas_maquinas add (operator reports a machine failure)', module: 'TAB', src: 'operador.js:5733', col: 'alertas_maquinas', kind: 'create', allow: mgrPlant, run: (t) => fsApi.create('alertas_maquinas', uniq('AL'), { leida: false, maquina: 'm1' }, t) },
  { id: 'write.alertas_maquinas mark as read', module: 'TAB+FAB', src: 'operador.js:5750,4231, js/ui.js:650', col: 'alertas_maquinas', kind: 'update', allow: ['mgr', 'jefe'], run: (t) => upd('alertas_maquinas', 'AL1', { leida: true }, t) },
  { id: 'write._local collection (forced_db_suffix=_local from a browser pointed at this project)', module: 'CRM+FAB+TAB', src: 'DB_SUFFIX switch (app.js:29, operador.js:181)', col: 'prospects_local', kind: 'create', allow: [], run: (t) => fsApi.set('prospects_local', uniq('L'), { id: 'x', createdBy: 'y' }, t) }
];

const RESULTS = [];
async function runOp(op, persona) {
  if (op.prepare) await op.prepare();
  const r = await op.run(PERSONAS[persona].tok, persona);
  return r;
}

beforeAll(async () => {
  await assertIsolatedUp();
  await clearIsolatedFirestore();
  await loadFirestoreRules(CANDIDATE_RULES);
  await seedFixture();
}, 60000);

afterAll(async () => {
  await loadFirestoreRules(CANDIDATE_RULES); // leave the emulator with the candidate rules
  if (process.env.JOINT_MATRIX_OUT) fs.writeFileSync(process.env.JOINT_MATRIX_OUT, JSON.stringify(RESULTS, null, 1));
});

// ============================================================================================================
describe('A. replay validity: every catalogue operation succeeds under the OPEN baseline (assumed current rules)', () => {
  beforeAll(async () => { await loadFirestoreRules(OPEN_RULES); await seedFixture(); });
  afterAll(async () => { await loadFirestoreRules(CANDIDATE_RULES); await seedFixture(); });
  for (const op of CATALOG) {
    test(`baseline: ${op.id}`, async () => {
      const r = await runOp(op, 'anon');
      expect({ op: op.id, status: r.status, body: ok(r) ? '' : r.body.slice(0, 200) }).toMatchObject({ status: 200 });
    });
  }
  test('today the operator login query returns the plain PIN and password of every plant profile to an unauthenticated tablet', async () => {
    const r = await qry('users_prod', [['role', 'in', ['operario']]], null);
    expect(ok(r)).toBe(true);
    expect(r.body).toContain('"stringValue": "123456"'); // password
    expect(r.body).toContain('"stringValue": "4821"');   // pin
  });
});

// ============================================================================================================
describe('B. permission matrix under the CANDIDATE rules (firestore.rules, unchanged): direct operations of both modules', () => {
  beforeAll(async () => { await loadFirestoreRules(CANDIDATE_RULES); await seedFixture(); });
  for (const op of CATALOG) {
    test(`${op.id}`, async () => {
      const got = {};
      for (const persona of Object.keys(PERSONAS)) {
        const r = await runOp(op, persona);
        got[persona] = ok(r);
        if (!ok(r) && r.status !== 403) throw new Error(`${op.id} / ${persona}: unexpected HTTP ${r.status} ${r.body.slice(0, 200)}`);
        RESULTS.push({ op: op.id, module: op.module, src: op.src, col: op.col, kind: op.kind, persona, allowed: ok(r) });
      }
      const expected = Object.fromEntries(Object.keys(PERSONAS).map(p => [p, op.allow.includes(p)]));
      expect(got).toEqual(expected);
    });
  }
});

// ============================================================================================================
describe('C. Storage: paths really used by both modules vs the paths the candidate storage.rules expect', () => {
  const up = (p, who) => stApi.upload(p, PERSONAS[who].tok);
  beforeAll(async () => { await loadFirestoreRules(CANDIDATE_RULES); await seedFixture(); });
  // Both modules upload with app.js / app_core.js `uploadFileToStorage`: `${STORAGE_PREFIX}/${folder}/${Date.now()}_${name}` (flat).
  const FLAT = [
    ['clientes', 'CRM + fabricacion pages', []],
    ['ordenes_cambio', 'CRM + fabricacion pages', []],
    ['facturas', 'CRM + fabricacion pages', []],
    ['pagos', 'CRM + fabricacion pages', []],
    ['proyectos', 'CRM + fabricacion pages (oferta, costos, levantamiento, contrato)', []],
    ['requerimientos', 'fabricacion (js/fabricacion.js:98)', ['mgr', 'ges', ...PLANT]],
    ['fabricacion_archivos', 'fabricacion (js/fabricacion.js:2305-2316)', ['mgr', 'ges', ...PLANT]]
  ];
  for (const [folder, who, allow] of FLAT) {
    test(`flat path prod_files/${folder}/<ts>_<file> (${who})`, async () => {
      const got = {};
      for (const persona of Object.keys(PERSONAS)) {
        const r = await up(`prod_files/${folder}/${Date.now()}_${persona}.pdf`, persona);
        got[persona] = r.status === 200;
        RESULTS.push({ op: `storage upload prod_files/${folder}/…`, module: who, src: 'uploadFileToStorage', col: 'storage', kind: 'create', persona, allowed: r.status === 200 });
      }
      expect(got).toEqual(Object.fromEntries(Object.keys(PERSONAS).map(p => [p, allow.includes(p)])));
    });
  }
  test('local_files/<folder> (STORAGE_PREFIX of the local environment) is refused for everybody', async () => {
    for (const persona of Object.keys(PERSONAS)) expect((await up(`local_files/proyectos/${Date.now()}.pdf`, persona)).status).toBe(403);
  });
  test('the paths the candidate rules DO allow are not produced by any current code: prospects/{pid}/{folder}/{file} and clients/{cid}/{file}', async () => {
    const got = {};
    for (const persona of ['anon', 'mgr', 'ges', 'v1', 'jefe', 'oper']) {
      got[persona] = [
        (await up(`prod_files/prospects/P1/facturas/${Date.now()}_${persona}.pdf`, persona)).status === 200,
        (await up(`prod_files/clients/${PERSONAS[persona].cid}/${Date.now()}_${persona}.pdf`, persona)).status === 200
      ];
    }
    expect(got).toEqual({ anon: [false, false], mgr: [true, true], ges: [true, true], v1: [true, true], jefe: [false, false], oper: [false, false] });
  });
  test('operators (tablets) never use Storage: operador.html loads no Storage SDK', () => {
    if (!fs.existsSync(path.join(FAB_REPO, 'operador.html'))) return;
    expect(fs.readFileSync(path.join(FAB_REPO, 'operador.html'), 'utf8')).not.toMatch(/firebase-storage/);
    expect(fs.readFileSync(path.join(FAB_REPO, 'operador.js'), 'utf8')).not.toMatch(/storage\(\)|\.ref\(|getDownloadURL/);
  });
});

// ============================================================================================================
// Integrated scenarios with REAL accounts, the Functions emulator and Firestore/Storage emulators.
const S = {};
let seq = 0;
const opId = () => `op-joint-${Date.now()}-${++seq}`;
const AUTHPOST = async (url, body, tok) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const fn = (name, data, tok) => AUTHPOST(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, tok);
const file = n => ({ name: n, url: `http://127.0.0.1:9290/v0/b/${PROJECT}.appspot.com/o/${n}?alt=media` });
const CID = { M: '3000000000001', G: '3000000000002', A: '3000000000003', B: '3000000000004' };
async function realAccount(tag, cid, role) {
  const email = `${tag}@ductsal-joint.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
  const sUp = await AUTHPOST(idt('accounts:signUp'), { email, password, returnSecureToken: true });
  const uid = sUp.json.localId;
  await adminAuth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
  await adminDb.collection('users_prod').doc(cid).set({ id: cid, nombre: tag, email, role, activo: true, authUid: uid });
  const sIn = await AUTHPOST(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid, cid, token: sIn.json.idToken };
}
const CLIENT_CW = { id: 'CW', tipo: 'juridica', empresa: 'Industrias Delta', contacto: 'Ana', nit: '0614-1', nrc: '1-2', telefono: '7000', correo: 'a@b.c', correo_fact: 'f@b.c', documentos: { dui: file('dui.pdf') } };
const prospectDoc = async id => (await adminDb.collection('prospects_prod').doc(id).get()).data();

describe('D. integrated scenario: client + opportunity + no-contract authorization + invoices/payments + fabricacion project + logical deletion', () => {
  beforeAll(async () => {
    const fnUp = await fetch('http://127.0.0.1:5101/').catch(() => null);
    if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering: start the isolated emulators with functions');
    await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
    await clearIsolatedFirestore();
    await loadFirestoreRules(CANDIDATE_RULES);
    await seedFixture();
    S.M = await realAccount('gerente', CID.M, 'manager');
    S.G = await realAccount('gestor', CID.G, 'gestor');
    S.A = await realAccount('vendedor.a', CID.A, 'vendedor');
    S.B = await realAccount('vendedor.b', CID.B, 'vendedor');
    await adminDb.collection('clients_prod').doc('CW').set(CLIENT_CW);
  }, 60000);

  test('the CRM listeners as written (unfiltered) fail for a vendedor; only privileged roles can list the whole collection', async () => {
    for (const col of ['clients_prod', 'prospects_prod', 'users_prod']) {
      expect((await qry(col, [], S.A.token)).status).toBe(403);
    }
    expect((await qry('clients_prod', [], S.M.token)).status).toBe(200);
    expect((await qry('prospects_prod', [], S.G.token)).status).toBe(200);
    expect((await qry('users_prod', [], S.G.token)).status).toBe(403); // a gestor cannot list users either
  });

  let pid;
  test('vendedor A creates the opportunity through the server; queries that CAN replace the listeners are measured', async () => {
    const c = await fn('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'Instalación grande', origen: 'Referido', tipo_proyecto: 'Fabricación e instalación', tipo_producto: 'Ductos' }, opId: opId() }, S.A.token);
    expect(c.json.error).toBeUndefined();
    pid = c.json.result.prospect.id;
    const own = await qry('prospects_prod', [['createdBy', '==', CID.A]], S.A.token);
    expect(own.status).toBe(200);
    expect(docs(own).map(d => d.name.split('/').pop())).toContain(pid);
    expect((await qry('prospects_prod', [['vendedorId', '==', CID.A]], S.A.token)).status).toBe(200);
    // the portfolio query a filtered client listener would need
    expect((await qry('clients_prod', [['createdBy', '==', CID.A]], S.A.token)).status).toBe(200);
    // B cannot read A's opportunity by any filtered query that names A
    const other = await qry('prospects_prod', [['createdBy', '==', CID.A]], S.B.token);
    expect(other.status).toBe(403);
  });

  test('no-contract flow: the big installation cannot close without legal documents; vendedor requests, only the manager resolves; the sale then closes', async () => {
    const step = async (nextStage, data, tok = S.A.token) => { const r = await fn('advanceProspectStageAdmin', { prospectId: pid, nextStage, data }, tok); expect(r.json.error).toBeUndefined(); };
    await step('levantamiento', { visitante: 'Luis', fecha_inicio: '2026-04-01', ubicacion: 'San Salvador', distancia: 12, fecha_visita: '2026-03-20', doc_levantamiento: [file('lev.pdf')] });
    await step('cotizacion', { costo_venta: 12000, precio_cotizado: 20000, probabilidad: 'alta', doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')] });
    await step('negociacion', { costo_venta: 12000, precio_cotizado: 20000, probabilidad: 'alta' });
    const CIE = { forma_pago: '70/30', factura_anticipo: 'FAC-J1', encargado: 'Pedro', doc_firmado: file('firmado.pdf'), doc_comprobante: file('comp.pdf') };
    const refused = await fn('advanceProspectStageAdmin', { prospectId: pid, nextStage: 'cierre', data: CIE }, S.A.token);
    expect(refused.json.error.status).toBe('FAILED_PRECONDITION');
    const req = await fn('requestNoContractAuthorizationAdmin', { prospectId: pid, motivo: 'Cliente institucional', opId: opId() }, S.A.token);
    const rid = req.json.result.request.id;
    expect((await fn('resolveNoContractAuthorizationAdmin', { prospectId: pid, requestId: rid, decision: 'approve' }, S.A.token)).json.error.status).toBe('PERMISSION_DENIED');
    expect((await fn('resolveNoContractAuthorizationAdmin', { prospectId: pid, requestId: rid, decision: 'approve' }, S.G.token)).json.error.status).toBe('PERMISSION_DENIED');
    expect((await fn('resolveNoContractAuthorizationAdmin', { prospectId: pid, requestId: rid, decision: 'approve', motivoDecision: 'ok' }, S.M.token)).json.result.status).toBe('approved');
    expect((await prospectDoc(pid)).datos).toMatchObject({ autorizado_sin_contrato: true, autorizado_por_id: CID.M });
    await step('cierre', CIE);
    expect((await prospectDoc(pid)).estado).toBe('ganado');
  });

  test('invoices and payments through the server, with documents referenced by URL', async () => {
    const p = await prospectDoc(pid);
    const inv = await fn('saveInvoiceAdmin', { prospectId: pid, numero: 'FAC-J2', monto: 1000, doc_factura: file('f2.pdf'), opId: opId() }, S.G.token);
    expect(inv.json.result.status).toBe('created');
    const pay = await fn('savePaymentAdmin', { prospectId: pid, invoiceId: p.facturas[0].id, monto: 500, metodo: 'transferencia', ref: 'R-1', doc_comprobante: file('pg.pdf'), opId: opId() }, S.A.token);
    expect(pay.json.result.status).toBe('created');
    expect((await prospectDoc(pid)).facturas[0].pagos).toHaveLength(1);
  });

  test('"send to fabricacion" is a direct write of proyectos_fabricacion: manager, gestor and jefe can; the vendedor who owns the sale cannot', async () => {
    const mk = () => uniq('FAB-PROJ');
    const body = (id, by) => ({ id, origen_tipo: 'oportunidad', prospecto_id: pid, proyecto: 'Instalación grande', codigo_proyecto: 'x', creado_por: by });
    const idV = mk(); const idG = mk();
    expect(ok(await fsApi.set('proyectos_fabricacion_prod', idV, body(idV, 'A'), S.A.token))).toBe(false);
    expect(ok(await fsApi.set('proyectos_fabricacion_prod', idG, body(idG, 'G'), S.G.token))).toBe(true);
    S.projectId = idG;
  });

  test('plant sessions read the project; plant sessions cannot read the commercial data of the same opportunity', async () => {
    expect(ok(await fsApi.get('proyectos_fabricacion_prod', S.projectId, PERSONAS.jefe.tok))).toBe(true);
    expect(ok(await fsApi.get('proyectos_fabricacion_prod', S.projectId, PERSONAS.oper.tok))).toBe(true);
    expect(ok(await fsApi.get('prospects_prod', pid, PERSONAS.jefe.tok))).toBe(false);
    expect(ok(await fsApi.get('clients_prod', 'CW', PERSONAS.oper.tok))).toBe(false);
    expect(ok(await fsApi.get('users_prod', CID.A, PERSONAS.oper.tok))).toBe(false);
  });

  test('logical deletion by the manager: the opportunity stays marked, the fabricacion project and the files are untouched; the fabricacion listeners still see it', async () => {
    expect((await stApi.seed(`prod_files/prospects/${pid}/facturas/f-evidence.pdf`)).status).toBe(200);
    const del = await fn('deleteProspectAdmin', { prospectId: pid, motivo: 'Duplicada' }, S.M.token);
    expect(del.json.result.status).toBe('deleted');
    const p = await prospectDoc(pid);
    expect(p).toMatchObject({ eliminado: true, eliminado_por_id: CID.M, motivo_eliminacion: 'Duplicada' });
    expect(p.facturas.length).toBeGreaterThan(0);
    expect(ok(await fsApi.get('proyectos_fabricacion_prod', S.projectId, S.M.token))).toBe(true); // project preserved
    expect((await stApi.meta(`prod_files/prospects/${pid}/facturas/f-evidence.pdf`, S.M.token)).status).toBe(200); // file preserved
    // fabricacion's unfiltered `prospects` listener (app.js:330) still receives the deleted opportunity, with the flag
    const seen = docs(await qry('prospects_prod', [], S.M.token)).find(d => d.name.endsWith(`/${pid}`));
    expect(seen).toBeDefined();
    expect(seen.fields.eliminado.booleanValue).toBe(true);
  });

  test('GAP CLOSED (SEC-04/06): fabricacion\'s own physical delete (js/oportunidades.js:1017) is DENIED by the hardened rules', async () => {
    const c = await fn('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'Para borrar fisico', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, S.A.token);
    const id2 = c.json.result.prospect.id;
    const pf = uniq('FAB-PROJ');
    expect(ok(await fsApi.set('proyectos_fabricacion_prod', pf, { id: pf, prospecto_id: id2 }, S.G.token))).toBe(true);
    expect(ok(await fsApi.del('prospects_prod', id2, S.M.token))).toBe(false); // physical deletion denied by rules
    expect((await fsApi.del('prospects_prod', id2, S.M.token)).status).toBe(403);
    expect(await prospectDoc(id2)).toBeDefined(); // prospect remains safe; must use deleteProspectAdmin
    // clean up the test fabrication project
    await fsApi.del('proyectos_fabricacion_prod', pf, S.M.token);
  });
});

// ============================================================================================================
describe('E. code generation and simultaneous operations', () => {
  const FAB_OPP = path.join(FAB_REPO, 'js', 'oportunidades.js');
  const haveFab = fs.existsSync(FAB_OPP);
  const mkProspect = (tok, n) => fn('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: `Concurrente ${n}`, origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, tok);
  const generateFabCode = prospects => {
    const src = fs.readFileSync(FAB_OPP, 'utf8');
    const a = src.indexOf('function generateProspectCode()'); const b = src.indexOf('function renderList()', a);
    return new vm.Script(`(function (prospects) { ${src.slice(a, b)}\n return generateProspectCode; })`).runInThisContext()(prospects);
  };
  let crmCodes;

  test('CRM: 10 simultaneous creations by different users get 10 distinct, consecutive codes (transactional counter)', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => mkProspect([S.A, S.B, S.G, S.M][i % 4].token, i)));
    expect(rs.every(r => r.json.result && r.json.result.status === 'created')).toBe(true);
    crmCodes = rs.map(r => r.json.result.prospect.codigo);
    expect(new Set(crmCodes).size).toBe(10);
    const seqs = crmCodes.map(c => Number(c.slice(6))).sort((x, y) => x - y);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
  });

  (haveFab ? test : test.skip)('KNOWN GAP: two fabricacion clients with the same snapshot compute the SAME code (count-based, in the browser) and, written directly, it duplicates a code the CRM already issued', async () => {
    const snapshot = docs(await qry('prospects_prod', [], S.M.token)).map(d => ({ id: d.name.split('/').pop(), fecha_creacion: (d.fields.fecha_creacion || {}).stringValue }));
    const codeA = generateFabCode(snapshot)(); const codeB = generateFabCode(snapshot)();
    expect(codeA).toBe(codeB); // two tablets / sessions at once
    // fabricacion saves its opportunity directly (allowed to a manager by the candidate rules) with that code, without touching the CRM counter
    const fid = uniq('FABPROS');
    const w = await fsApi.set('prospects_prod', fid, { id: fid, codigo: codeA, createdBy: CID.M, vendedorId: CID.M, clientId: 'CW', estado: 'activo', etapa: 'prospecto', datos: {}, logs: [], fecha_creacion: new Date().toISOString() }, S.M.token);
    expect(ok(w)).toBe(true);
    const next = await mkProspect(S.A.token, 'siguiente');
    const all = docs(await qry('prospects_prod', [], S.M.token)).map(d => (d.fields.codigo || {}).stringValue).filter(Boolean);
    // Measured: the browser counts prospects (it cannot see the CRM counter), so its code lands on a code the CRM
    // ALREADY issued (the count is not the counter: some counter values are unused or belong to other years).
    expect(all.filter(c => c === codeA).length).toBe(2); // DUPLICATE business code, created by the direct write
    expect(Number(next.json.result.prospect.codigo.slice(6))).toBeGreaterThanOrEqual(Number(codeA.slice(6))); // the CRM counter is unaware and just carries on
  });

  test('KNOWN GAP: fabricacion project ids are "FAB-PROJ-" + Date.now() written with set(): a second writer in the same millisecond silently replaces the first', async () => {
    const id = `FAB-PROJ-${Date.now()}`;
    expect(ok(await fsApi.set('proyectos_fabricacion_prod', id, { id, proyecto: 'Primero', creado_por: 'A' }, PERSONAS.jefe.tok))).toBe(true);
    expect(ok(await fsApi.set('proyectos_fabricacion_prod', id, { id, proyecto: 'Segundo', creado_por: 'B' }, PERSONAS.jefe.tok))).toBe(true);
    const d = (await adminDb.collection('proyectos_fabricacion_prod').doc(id).get()).data();
    expect(d.proyecto).toBe('Segundo'); // no create-only precondition: the first project is lost without error
  });

  test('operators: two tablets advancing the same task at once are both accepted (no transaction, last write wins); the code uses get() + update(), never runTransaction', async () => {
    await fsApi.seed('fabricacion_tasks_prod', 'TKC', { id: 'TKC', fabricacion_id: 'F1', status: 'pendiente', piezas: 0 });
    const rs = await Promise.all([1, 2, 3, 4].map(n => upd('fabricacion_tasks_prod', 'TKC', { piezas: n, ultimo_operario: `op${n}` }, PERSONAS.oper.tok)));
    expect(rs.every(ok)).toBe(true);
    const d = (await adminDb.collection('fabricacion_tasks_prod').doc('TKC').get()).data();
    expect([1, 2, 3, 4]).toContain(d.piezas); // one value survives, the other three writes are lost silently
    if (fs.existsSync(path.join(FAB_REPO, 'operador.js'))) {
      for (const f of ['operador.js', 'app.js', ...fs.readdirSync(path.join(FAB_REPO, 'js')).map(x => `js/${x}`)]) {
        expect(fs.readFileSync(path.join(FAB_REPO, f), 'utf8')).not.toMatch(/runTransaction/);
      }
    }
  });
});

// ============================================================================================================
describe('F. isolation between tablets (plant sessions) and the CRM', () => {
  test('a plant session is refused by every commercial callable (real Auth account with a plant role)', async () => {
    const email = `operario@ductsal-joint.invalid`;
    const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
    const up = await AUTHPOST(idt('accounts:signUp'), { email, password, returnSecureToken: true });
    await adminAuth.setCustomUserClaims(up.json.localId, { role: 'operario', cid: ID.OPER });
    await adminDb.collection('users_prod').doc(ID.OPER).set({ id: ID.OPER, nombre: 'Operario', email, role: 'operario', activo: true, authUid: up.json.localId });
    const tok = (await AUTHPOST(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true })).json.idToken;
    for (const [n, d] of [['createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'x', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }], ['searchClientsCatalog', { q: 'Delta' }], ['updateUserAdmin', { id: CID.A, nombre: 'x', opId: opId() }], ['toggleUserStatusAdmin', { id: CID.A, activo: false, opId: opId() }], ['deleteProspectAdmin', { prospectId: 'P1', motivo: 'x' }]]) {
      const r = await fn(n, d, tok);
      expect(['PERMISSION_DENIED', 'FAILED_PRECONDITION']).toContain(r.json.error.status);
    }
  });
  test('commercial sessions cannot write the plant collections (tasks, spools, alerts, machine status)', async () => {
    for (const who of ['v1', 'ges']) {
      expect(ok(await upd('fabricacion_tasks_prod', 'TK1', { status: 'x' }, PERSONAS[who].tok))).toBe(false);
      expect(ok(await upd('bobinas_soldadura_prod', 'B1', { kg: 1 }, PERSONAS[who].tok))).toBe(false);
      expect(ok(await fsApi.create('alertas_maquinas', uniq('AL'), { leida: false }, PERSONAS[who].tok))).toBe(false);
      expect(ok(await fsApi.set('config', 'estado_equipos', { m1: 'x' }, PERSONAS[who].tok))).toBe(false);
    }
  });
  test('un-suffixed shared collections: config / alertas_maquinas are the SAME documents for local and prod browsers (no environment isolation possible)', async () => {
    // fabricacion code writes db.collection('config') and db.collection('alertas_maquinas') without DB_SUFFIX: whatever a test browser
    // writes lands in the production document. Measured here: a manager session writes it with no environment distinction.
    expect(ok(await fsApi.set('config', 'maquinas', { lista: ['x'] }, PERSONAS.mgr.tok))).toBe(true);
    expect((await adminDb.collection('config').doc('maquinas').get()).data().lista).toEqual(['x']);
  });
});
