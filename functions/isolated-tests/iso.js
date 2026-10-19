// functions/isolated-tests/iso.js
// Shared helpers for the tests that run against the ISOLATED emulators (see ../ISOLATED_TESTS.md).
//
// Isolation: every host/project is a hard-coded constant (127.0.0.1, ports 8190 / 9290, demo project). Nothing comes
// from the environment, so these helpers cannot reach production nor the development emulators (9099 / 8080 / 5001).
// Tokens are UNSIGNED JWTs (alg:none): only the emulators accept them; a real Firebase service would reject them.
// Plain Node 20 `fetch`, no extra dependency. No secret of any kind is used.

const fs = require('fs');
const path = require('path');

const PROJECT = 'demo-ductsal-isolated';
const FS_HOST = '127.0.0.1:8190';
const ST_HOST = '127.0.0.1:9290';
const DOCS = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const BUCKET = `${PROJECT}.appspot.com`;
const REPO = path.join(__dirname, '..', '..');

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (uid, claims = {}) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
  firebase: { identities: {}, sign_in_provider: 'password' }, ...claims
})}.`;

// ---------- Firestore REST value encoding ----------
function toVal(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  return { mapValue: { fields: toFields(v) } };
}
const toFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toVal(v)]));

async function call(method, url, tok, body, extraHeaders = {}) {
  const r = await fetch(url, {
    method,
    headers: { ...(body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body)
  });
  return { status: r.status, body: await r.text() };
}

const OWNER = 'owner'; // admin bypass understood only by the emulators
const fsApi = {
  seed: (col, id, data) => call('PATCH', `${DOCS}/${col}/${id}`, OWNER, { fields: toFields(data) }),
  get: (col, id, t) => call('GET', `${DOCS}/${col}/${id}`, t),
  set: (col, id, data, t) => call('PATCH', `${DOCS}/${col}/${id}`, t, { fields: toFields(data) }), // replace, like set()
  create: (col, id, data, t) => call('POST', `${DOCS}/${col}?documentId=${id}`, t, { fields: toFields(data) }),
  del: (col, id, t) => call('DELETE', `${DOCS}/${col}/${id}`, t),
  query: (col, filter, t, extra = {}) => call('POST', `${DOCS}:runQuery`, t, {
    structuredQuery: {
      from: [{ collectionId: col }],
      ...(filter ? { where: { fieldFilter: { field: { fieldPath: filter[0] }, op: filter[1], value: { stringValue: filter[2] } } } } : {}),
      ...extra
    }
  })
};

// Wipes ONLY the isolated emulator (hard-coded port); the development emulator is a different port and project.
async function clearIsolatedFirestore() {
  const r = await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  if (r.status !== 200) throw new Error('could not clear the isolated Firestore emulator: HTTP ' + r.status);
}

// Resets ONLY the isolated Storage emulator (hard-coded port 9290).
async function clearIsolatedStorage() {
  const r = await fetch(`http://${ST_HOST}/internal/reset`, { method: 'POST' });
  if (r.status !== 200) throw new Error('could not reset the isolated Storage emulator: HTTP ' + r.status);
}

// RULES_UNDER_TEST (optional) points the DEFAULT rules at another file, e.g. the tablet candidate in rules/, to re-run an existing rules suite against it.
async function loadFirestoreRules(file = process.env.RULES_UNDER_TEST || path.join(REPO, 'firestore.rules')) {
  const r = await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: fs.readFileSync(file, 'utf8') }] } })
  });
  if (r.status !== 200) throw new Error('Firestore rules did not compile: ' + await r.text());
}

async function assertIsolatedUp() {
  const problems = [];
  const a = await fetch(`http://${FS_HOST}/`).catch(() => null);
  if (!a) problems.push(`Firestore emulator ${FS_HOST} not answering`);
  const b = await fetch(`http://${ST_HOST}/`).catch(() => null);
  if (!b) problems.push(`Storage emulator ${ST_HOST} not answering`);
  if (problems.length) throw new Error('Start the isolated emulators first (see ISOLATED_TESTS.md): ' + problems.join('; '));
}

// ---------- Storage REST (emulator) ----------
const enc = p => encodeURIComponent(p);
const stAuth = t => (t ? { Authorization: `Firebase ${t}` } : {});
const stApi = {
  async upload(objPath, t, { content = 'x', contentType = 'application/pdf', size } = {}) {
    const data = size ? Buffer.alloc(size, 1) : Buffer.from(content);
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o?name=${enc(objPath)}`, { method: 'POST', headers: { 'Content-Type': contentType, ...stAuth(t) }, body: data });
    return { status: r.status, body: await r.text() };
  },
  async seed(objPath, content = 'seed', contentType = 'application/pdf') {
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o?name=${enc(objPath)}`, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: 'Bearer owner' }, body: Buffer.from(content) });
    return { status: r.status, body: await r.text() };
  },
  async download(objPath, t) {
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(objPath)}?alt=media`, { headers: stAuth(t) });
    return { status: r.status, body: await r.text() };
  },
  async meta(objPath, t) {
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(objPath)}`, { headers: stAuth(t) });
    return { status: r.status, body: await r.text() };
  },
  async del(objPath, t) {
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(objPath)}`, { method: 'DELETE', headers: stAuth(t) });
    return { status: r.status, body: await r.text() };
  },
  async list(prefix, t) {
    const r = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o?prefix=${enc(prefix)}`, { headers: stAuth(t) });
    return { status: r.status, body: await r.text() };
  }
};

// ---------- identities (historic commercial ids differ from Auth uids on purpose) ----------
const ID = {
  MGR: '1000000000001', GES: '1000000000002', V1: '1792037387205', V2: '1792038830686', V3: '1792099999999', V4: '1792000000000',
  JEFE: '1800000000001', OPER: '1800000000002', RECEP: '1800000000003', DIBU: '1800000000004', INACT_OPER: '1800000000005'
};
const T = {
  anon: null,
  noClaims: token('uid-selfsignup'),
  mgr: token('uid-mgr', { role: 'manager', manager: true, cid: ID.MGR }),
  mgrNoFlag: token('uid-mgr', { role: 'manager', cid: ID.MGR }),
  ges: token('uid-ges', { role: 'gestor', cid: ID.GES }),
  v1: token('uid-v1', { role: 'vendedor', cid: ID.V1 }),
  v2: token('uid-v2', { role: 'vendedor', cid: ID.V2 }),
  v3: token('uid-v3', { role: 'vendedor', cid: ID.V3 }),
  v4inactive: token('uid-v4', { role: 'vendedor', cid: ID.V4 }),
  v2StaleRole: token('uid-v2', { role: 'gestor', cid: ID.V2 }),
  v2WrongUid: token('uid-intruder', { role: 'vendedor', cid: ID.V2 }),
  v2SpoofManager: token('uid-v2', { role: 'vendedor', manager: true, cid: ID.V2 }),
  jefe: token('uid-jefe', { role: 'jefe_produccion', cid: ID.JEFE }),
  oper: token('uid-oper', { role: 'operario', cid: ID.OPER }),
  recep: token('uid-recep', { role: 'recepcion', cid: ID.RECEP }),
  dibu: token('uid-dibu', { role: 'dibujante', cid: ID.DIBU }),
  operInactive: token('uid-oper2', { role: 'operario', cid: ID.INACT_OPER }),
  operSpoofPlant: token('uid-v1', { role: 'operario', cid: ID.V1 }) // vendedor profile claiming a plant role
};

const profile = (id, uid, role, activo = true) => ({ id, authUid: uid, role, activo, nombre: 'N' + id, email: id + '@x.invalid' });

async function seedUsers() {
  const rows = [
    [ID.MGR, 'uid-mgr', 'manager', true], [ID.GES, 'uid-ges', 'gestor', true],
    [ID.V1, 'uid-v1', 'vendedor', true], [ID.V2, 'uid-v2', 'vendedor', true], [ID.V3, 'uid-v3', 'vendedor', true], [ID.V4, 'uid-v4', 'vendedor', false],
    [ID.JEFE, 'uid-jefe', 'jefe_produccion', true], [ID.OPER, 'uid-oper', 'operario', true],
    [ID.RECEP, 'uid-recep', 'recepcion', true], [ID.DIBU, 'uid-dibu', 'dibujante', true], [ID.INACT_OPER, 'uid-oper2', 'operario', false]
  ];
  for (const [id, uid, role, act] of rows) await fsApi.seed('users_prod', id, profile(id, uid, role, act));
  // historical profile: no authUid, legacy password field (must never be readable by anyone but the Admin SDK)
  await fsApi.seed('users_prod', 'LEGACY1', { id: 'LEGACY1', nombre: 'Historico', email: 'h@x.invalid', password: 'legacy-placeholder', role: 'vendedor', activo: true });
}

module.exports = { PROJECT, FS_HOST, ST_HOST, DOCS, BUCKET, REPO, token, toFields, call, fsApi, stApi, clearIsolatedFirestore, clearIsolatedStorage, loadFirestoreRules, assertIsolatedUp, ID, T, profile, seedUsers };
