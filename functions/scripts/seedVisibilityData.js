#!/usr/bin/env node
// functions/scripts/seedVisibilityData.js
// Fictitious data to test per-seller visibility of prospects and clients in the CRM.
// EMULATOR ONLY: project `demo-ductsal-local`, everything on 127.0.0.1.
//
// Scenario `visibilidad-vendedores-v1` (3 documents, nothing else):
//   clients_local/CTEST-VIS-C1     client C1, createdBy = seller 1   (clients have no `vendedorId` in this CRM)
//   prospects_local/TEST-VIS-P1    prospect P1, createdBy = vendedorId = seller 1
//   prospects_local/TEST-VIS-P2    prospect P2, createdBy = vendedorId = seller 2 (points at C1 on purpose)
// Seller 1 = vendedor.prueba@ductsal-test.invalid (already exists). Seller 2 = vendedor.segundo@ductsal-test.invalid,
// which this script NEVER creates: create it from the CRM UI first (see functions/VISIBILITY_TEST.md).
//
// Usage (from the repository root):
//   node functions/scripts/seedVisibilityData.js --dry-run            checks everything, prints what it would create, writes nothing
//   node functions/scripts/seedVisibilityData.js                      creates the 3 documents (create-only, never overwrites)
//   node functions/scripts/seedVisibilityData.js --cleanup --dry-run  prints what it would delete
//   node functions/scripts/seedVisibilityData.js --cleanup            deletes ONLY those 3 documents, if they carry the test marker
// Exit codes: 0 ok, 1 failure/aborted, 2 unsafe environment or bad arguments.
//
// Safety properties (all covered by __tests__/seedVisibilityData.unit.test.js, which uses a fake fetch):
//  - every URL is a constant on 127.0.0.1; no credentials, no Admin SDK, no real e-mail addresses (.invalid);
//  - refuses any project other than demo-ductsal-local (argument or environment), refuses service-account credentials;
//  - checks through the emulator hub that Auth, Firestore and Functions are the local emulators on the expected
//    loopback ports, and that this is the seeded local environment (test manager present in Auth and users_local);
//  - writes only with `currentDocument.exists=false` (a pre-existing document is verified, never overwritten);
//  - refuses to load if clients_local / prospects_local contain any document without `esDatoDePrueba: true`;
//  - never writes to users_local, Auth or any other collection;
//  - cleanup validates all 3 documents first and deletes only those ids, only with the marker, with a precondition
//    on the document's updateTime.

const { PROJECT, AUTH, FIRESTORE, FUNCTIONS, SEED } = require('../emulator-tests/helpers');
const { isLoopbackHost } = require('../emulatorGuard');

const HUB = 'http://127.0.0.1:4400';
const EXPECTED_PORTS = { auth: 9099, firestore: 8080, functions: 5001 };
const SCENARIO = 'visibilidad-vendedores-v1';
const V1_EMAIL = 'vendedor.prueba@ductsal-test.invalid';
const V2_EMAIL = 'vendedor.segundo@ductsal-test.invalid';
const COL = { users: 'users_local', clients: 'clients_local', prospects: 'prospects_local' };
const IDS = { client: 'CTEST-VIS-C1', p1: 'TEST-VIS-P1', p2: 'TEST-VIS-P2' };
const PATHS = {
  client: `${COL.clients}/${IDS.client}`,
  p1: `${COL.prospects}/${IDS.p1}`,
  p2: `${COL.prospects}/${IDS.p2}`
};
const OWNER = { Authorization: 'Bearer owner' }; // administrator bypass understood ONLY by the emulators
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;

class Refusal extends Error {} // unsafe environment / bad arguments (exit 2)

// ---------- arguments and environment ----------
function parseArgs(argv) {
  const args = { dryRun: false, cleanup: false, project: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--cleanup') args.cleanup = true;
    else if (a === '--project') args.project = argv[++i];
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else throw new Refusal(`Unknown argument: ${a}`);
  }
  return args;
}

function environmentProblems(env, args) {
  const problems = [];
  if (args.project !== undefined && args.project !== PROJECT) problems.push(`--project must be ${PROJECT} (got "${args.project}")`);
  for (const k of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT']) {
    if (env[k] && env[k] !== PROJECT) problems.push(`${k} is "${env[k]}", expected ${PROJECT} or unset`);
  }
  if (env.FIREBASE_CONFIG) {
    let id;
    try { id = JSON.parse(env.FIREBASE_CONFIG).projectId; } catch (_) { id = undefined; }
    if (id !== PROJECT) problems.push(`FIREBASE_CONFIG does not name ${PROJECT}`);
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) problems.push('GOOGLE_APPLICATION_CREDENTIALS must not be set');
  const hosts = { FIRESTORE_EMULATOR_HOST: EXPECTED_PORTS.firestore, FIREBASE_AUTH_EMULATOR_HOST: EXPECTED_PORTS.auth };
  for (const [k, port] of Object.entries(hosts)) {
    if (env[k] && !(isLoopbackHost(env[k]) && String(env[k]).endsWith(':' + port))) {
      problems.push(`${k} is "${env[k]}", expected a loopback address on port ${port} or unset`);
    }
  }
  return problems;
}

// ---------- Firestore REST encoding ----------
const enc = (v) => v === null ? { nullValue: null }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? { integerValue: String(v) }
  : { stringValue: String(v) };
const encodeFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
function dec(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return undefined;
}
function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, dec(v)]));
}

// ---------- I/O (fetch is injected so the tests never touch the network) ----------
function makeIO(fetchImpl) {
  async function call(method, url, { headers = {}, body } = {}) {
    const res = await fetchImpl(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    return { status: res.status, json };
  }
  const docUrl = (path) => `${DOCS}/${path}`;
  return {
    hub: () => call('GET', `${HUB}/emulators`),
    authConfig: () => call('GET', `${AUTH}/emulator/v1/projects/${PROJECT}/config`),
    functionsRoot: () => call('GET', `${FUNCTIONS}/`),
    collectionIds: () => call('POST', `${DOCS}:listCollectionIds`, { headers: OWNER, body: {} }),
    async authUsers() {
      const r = await call('POST', `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { headers: OWNER, body: { returnUserInfo: true } });
      if (r.status !== 200) throw new Error(`Auth emulator accounts:query failed (HTTP ${r.status})`);
      return (r.json.userInfo || []).map((u) => ({
        uid: u.localId, email: u.email, disabled: !!u.disabled,
        claims: u.customAttributes ? JSON.parse(u.customAttributes) : {}
      }));
    },
    async listDocs(collection) {
      const out = [];
      let token = '';
      do {
        const r = await call('GET', `${docUrl(collection)}?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, { headers: OWNER });
        if (r.status !== 200) throw new Error(`Firestore list ${collection} failed (HTTP ${r.status})`);
        for (const d of (r.json && r.json.documents) || []) out.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields) });
        token = (r.json && r.json.nextPageToken) || '';
      } while (token);
      return out;
    },
    async getDoc(path) {
      const r = await call('GET', docUrl(path), { headers: OWNER });
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`Firestore get ${path} failed (HTTP ${r.status})`);
      return { data: decodeFields(r.json.fields), updateTime: r.json.updateTime };
    },
    // Create-only: fails with 'exists' rather than overwriting.
    async createDoc(path, data) {
      const r = await call('PATCH', `${docUrl(path)}?currentDocument.exists=false`, { headers: OWNER, body: { fields: encodeFields(data) } });
      if (r.status === 200) return 'created';
      if (r.status === 409 || r.status === 400 || r.status === 412) return 'exists';
      throw new Error(`Firestore create ${path} failed (HTTP ${r.status})`);
    },
    async deleteDoc(path, updateTime) {
      const r = await call('DELETE', `${docUrl(path)}?currentDocument.updateTime=${encodeURIComponent(updateTime)}`, { headers: OWNER });
      if (r.status !== 200) throw new Error(`Firestore delete ${path} failed (HTTP ${r.status})`);
    }
  };
}

// ---------- checks ----------
async function verifyEmulators(io) {
  const hub = await io.hub();
  if (hub.status !== 200 || !hub.json) throw new Error('Emulator hub (127.0.0.1:4400) is not answering: are the emulators running?');
  for (const [name, port] of Object.entries(EXPECTED_PORTS)) {
    const e = hub.json[name];
    if (!e) throw new Error(`The ${name} emulator is not running`);
    if (e.host !== '127.0.0.1' || e.port !== port) throw new Error(`The ${name} emulator is not on 127.0.0.1:${port} (hub says ${e.host}:${e.port})`);
    for (const l of e.listen || []) {
      if (l.address !== '127.0.0.1' && l.address !== '::1') throw new Error(`The ${name} emulator listens on a non-loopback address (${l.address})`);
    }
  }
  if ((await io.authConfig()).status !== 200) throw new Error(`Auth emulator does not answer for project ${PROJECT}`);
  if ((await io.collectionIds()).status !== 200) throw new Error(`Firestore emulator does not answer for project ${PROJECT}`);
  await io.functionsRoot(); // throws if nothing listens on 127.0.0.1:5001 (the function itself is not invoked)
  // This must be the seeded local environment, not some other emulator instance.
  const mgr = (await io.authUsers()).find((u) => u.uid === SEED.uid);
  if (!mgr || mgr.email !== SEED.email || mgr.claims.manager !== true) throw new Error('The seeded test manager is missing in the Auth emulator');
  const p = await io.getDoc(`${COL.users}/${SEED.profileId}`);
  if (!p || p.data.authUid !== SEED.uid) throw new Error('The seeded test manager profile is missing in users_local');
}

async function resolveSeller(io, authUsers, users, email, which) {
  const matches = users.filter((d) => String(d.data.email || '').trim().toLowerCase() === email);
  if (matches.length === 0) {
    throw new Error(`${which} (${email}) does not exist in users_local. Create it from the CRM UI first (functions/VISIBILITY_TEST.md, section 1). This script never creates users.`);
  }
  if (matches.length > 1) throw new Error(`${email} has ${matches.length} profiles in users_local; expected exactly one`);
  const u = matches[0].data;
  if (u.role !== 'vendedor' || u.activo !== true || !u.authUid || !u.id) throw new Error(`${email} must be an active vendedor profile linked by authUid`);
  const acc = authUsers.find((a) => a.uid === u.authUid && String(a.email).toLowerCase() === email);
  if (!acc || acc.disabled || acc.claims.manager === true) throw new Error(`${email}: matching enabled non-manager Auth account not found`);
  return u;
}

async function resolveSellers(io) {
  const authUsers = await io.authUsers();
  const users = await io.listDocs(COL.users);
  const u1 = await resolveSeller(io, authUsers, users, V1_EMAIL, 'Seller 1');
  const u2 = await resolveSeller(io, authUsers, users, V2_EMAIL, 'Seller 2');
  if (u1.id === u2.id || u1.authUid === u2.authUid) throw new Error('Seller 1 and seller 2 must be different users');
  return { u1, u2 };
}

async function assertNoForeignData(io) {
  for (const col of [COL.clients, COL.prospects]) {
    for (const d of await io.listDocs(col)) {
      if (d.data.esDatoDePrueba !== true) {
        throw new Error(`${col}/${d.id} is not test data (no esDatoDePrueba: true). Refusing to load next to unrelated records.`);
      }
    }
  }
}

// ---------- scenario ----------
function buildScenario(u1, u2, nowIso) {
  const base = { esDatoDePrueba: true, escenarioPrueba: SCENARIO };
  const prospect = (id, codigo, u, proyecto) => ({
    id, codigo, clientId: IDS.client,
    createdBy: u.id, createdByName: u.nombre, createdByRole: u.role,
    vendedorId: u.id, vendedorName: u.nombre, vendedorRole: u.role,
    proyecto, origen: 'Prospección del vendedor', tipo_proyecto: 'Fabricación', tipo_producto: 'Chute',
    fecha_creacion: nowIso, etapa: 'prospecto', estado: 'activo',
    stage_timestamps: { prospecto: nowIso }, logs: [], datos: {}, facturas: [],
    ...base
  });
  return [
    {
      path: PATHS.client,
      data: {
        id: IDS.client, tipo: 'natural', nombres: 'Cliente [PRUEBA]', apellidos: 'Ficticio Uno',
        telefono: '00000001', correo: 'cliente1@ductsal-test.invalid', es_exportacion: false, documentos: {},
        createdBy: u1.id, fecha_creacion: nowIso, ...base
      }
    },
    { path: PATHS.p1, data: prospect(IDS.p1, 'TEST-001', u1, '[PRUEBA] Chute vendedor 1') },
    { path: PATHS.p2, data: prospect(IDS.p2, 'TEST-002', u2, '[PRUEBA] Chute vendedor 2') }
  ];
}

// Fields that define "the same record" for idempotency (timestamps are excluded).
const STABLE = ['id', 'clientId', 'createdBy', 'vendedorId', 'codigo', 'proyecto', 'tipo', 'correo'];
function sameRecord(existing, wanted) {
  if (existing.esDatoDePrueba !== true || existing.escenarioPrueba !== SCENARIO) return false;
  return STABLE.every((k) => (wanted[k] === undefined) === (existing[k] === undefined) && existing[k] === wanted[k]);
}

// ---------- operations ----------
async function load(io, args, log) {
  const { u1, u2 } = await resolveSellers(io);
  log(`Seller 1: ${V1_EMAIL} (profile id ${u1.id})`);
  log(`Seller 2: ${V2_EMAIL} (profile id ${u2.id})`);
  await assertNoForeignData(io);
  const plan = buildScenario(u1, u2, new Date().toISOString());
  const result = { created: [], skipped: [], wouldCreate: [] };
  // Pass 1 (read-only): a conflict on any of the three ids aborts BEFORE the first write, so there is no partial load.
  const present = new Set();
  for (const { path, data } of plan) {
    const existing = await io.getDoc(path);
    if (!existing) continue;
    if (!sameRecord(existing.data, data)) throw new Error(`${path} already exists and is not this scenario's record (different marker or owner). Not overwriting.`);
    present.add(path);
  }
  // Pass 2: create-only writes.
  for (const { path, data } of plan) {
    if (present.has(path)) {
      log(`= ${path} already present, skipped`);
      result.skipped.push(path);
    } else if (args.dryRun) {
      log(`+ [dry-run] would create ${path}`);
      result.wouldCreate.push(path);
    } else {
      const r = await io.createDoc(path, data);
      if (r === 'created') { log(`+ created ${path}`); result.created.push(path); }
      else {
        const again = await io.getDoc(path);
        if (!again || !sameRecord(again.data, data)) throw new Error(`${path} appeared meanwhile and is not this scenario's record. Not overwriting.`);
        log(`= ${path} already present, skipped`);
        result.skipped.push(path);
      }
    }
  }
  return result;
}

async function cleanup(io, args, log) {
  const found = [];
  for (const path of Object.values(PATHS)) {
    const d = await io.getDoc(path);
    if (!d) { log(`- ${path} not present`); continue; }
    if (d.data.esDatoDePrueba !== true || d.data.escenarioPrueba !== SCENARIO) {
      throw new Error(`${path} exists but is not marked as this scenario's test data. Deleting nothing.`);
    }
    found.push({ path, updateTime: d.updateTime });
  }
  const result = { deleted: [], wouldDelete: [] };
  for (const { path, updateTime } of found) {
    if (args.dryRun) { log(`- [dry-run] would delete ${path}`); result.wouldDelete.push(path); continue; }
    await io.deleteDoc(path, updateTime);
    log(`- deleted ${path}`);
    result.deleted.push(path);
  }
  return result;
}

async function run({ fetchImpl, env, argv, log }) {
  const args = parseArgs(argv);
  const problems = environmentProblems(env, args);
  if (problems.length) throw new Refusal('Unsafe environment:\n  - ' + problems.join('\n  - '));
  const io = makeIO(fetchImpl);
  log(`Project: ${PROJECT} | mode: ${args.cleanup ? 'CLEANUP' : 'LOAD'}${args.dryRun ? ' (dry-run, no writes)' : ''}`);
  await verifyEmulators(io);
  log('Emulators verified: auth 9099, firestore 8080, functions 5001 on 127.0.0.1, seeded local environment.');
  return args.cleanup ? cleanup(io, args, log) : load(io, args, log);
}

module.exports = {
  PROJECT, SCENARIO, V1_EMAIL, V2_EMAIL, COL, IDS, PATHS, Refusal,
  parseArgs, environmentProblems, makeIO, verifyEmulators, resolveSellers, assertNoForeignData,
  buildScenario, sameRecord, load, cleanup, run
};

if (require.main === module) {
  run({ fetchImpl: fetch, env: process.env, argv: process.argv.slice(2), log: (m) => console.log(m) })
    .then(() => console.log('Done.'))
    .catch((e) => {
      console.error((e instanceof Refusal ? 'Refused: ' : 'Aborted: ') + e.message);
      process.exit(e instanceof Refusal ? 2 : 1);
    });
}
