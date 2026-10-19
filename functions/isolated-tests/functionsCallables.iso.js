// functions/isolated-tests/functionsCallables.iso.js
// END TO END on the isolated emulators (Auth 9399, Firestore 8190, Functions 5101): real Auth accounts with real custom
// claims, the REAL deployed-shape callables (createClientAdmin / updateClientAdmin / searchClientsCatalog), the
// syncClientVisibility trigger and the REAL Firestore rules, all in one flow.
// The callables run with dbSuffix '_prod' so they act on the collections the rules protect (users_prod, clients_prod ...);
// this is the isolated emulator: nothing here can reach a Firebase project.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { fsApi, clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, PROJECT } = require('./iso');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();

const AUTH = 'http://127.0.0.1:9399';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;

const CID = { A: '1792037387205', B: '1792038830686', GES: '1000000000002', INACT: '1792000000000', LEGACY: '1700000000001' };
const sessions = {};

async function post(url, body, token) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const call = (name, data, token) => post(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, token);

async function makeAccount(tag, cid, role, { activo = true, linked = true, claims = true } = {}) {
  const email = `${tag}@ductsal-test.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!'; // random, test-only, never printed
  const up = await post(idt('accounts:signUp'), { email, password, returnSecureToken: true });
  const uid = up.json.localId;
  if (claims) await auth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
  const profile = { id: cid, nombre: tag, email, role, activo };
  if (linked) profile.authUid = uid;
  await db.collection('users_prod').doc(cid).set(profile);
  const inn = await post(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid, token: inn.json.idToken, cid };
}

const empresa = (o = {}) => ({ tipo: 'juridica', empresa: 'Industrias Delta S.A. de C.V.', contacto: 'Ana Perez', telefono: '7000-0001', ...o });
let seq = 0;
const opId = () => `op-e2e-${Date.now()}-${++seq}`;
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 300)); } };

let clientId;

beforeAll(async () => {
  await assertIsolatedUp();
  const fnUp = await fetch(`http://127.0.0.1:5101/`).catch(() => null);
  if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering: start the isolated emulators with functions');
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await clearIsolatedFirestore();
  await loadFirestoreRules();
  sessions.A = await makeAccount('vendedor.a', CID.A, 'vendedor');
  sessions.B = await makeAccount('vendedor.b', CID.B, 'vendedor');
  sessions.GES = await makeAccount('gestor.g', CID.GES, 'gestor');
  sessions.INACT = await makeAccount('vendedor.inactivo', CID.INACT, 'vendedor', { activo: false });
  sessions.NOCLAIMS = await makeAccount('sin.claims', '1790000000009', 'vendedor', { claims: false });
  // historical profile: no authUid; an Auth account that carries a claim pointing at it must still be refused
  sessions.LEGACY = await makeAccount('historico', CID.LEGACY, 'vendedor', { linked: false });
}, 60000);

describe('end to end: callables + trigger + rules', () => {
  test('a request without a session is rejected', async () => {
    for (const n of ['createClientAdmin', 'updateClientAdmin', 'searchClientsCatalog']) {
      const r = await call(n, { client: empresa(), opId: opId(), id: 'C1', q: 'delta' }, null);
      expect(r.json.error.status).toBe('UNAUTHENTICATED');
    }
  });

  test('vendedor A creates a client; createdBy comes from the server profile, not from the payload', async () => {
    const r = await call('createClientAdmin', { client: { ...empresa({ nit: '0614-123456-123-4' }), createdBy: CID.B, id: 'HACK', visibleTo: [CID.B] }, opId: opId() }, sessions.A.token);
    expect(r.json.error).toBeUndefined();
    expect(r.json.result.status).toBe('created');
    clientId = r.json.result.client.id;
    const doc = (await db.collection('clients_prod').doc(clientId).get()).data();
    expect(doc.createdBy).toBe(CID.A);
    expect(doc.id).toBe(clientId);
    expect(doc.visibleTo).toBeUndefined();
  });

  test('vendedor B cannot create the same NIT in another format (server-side, atomic index)', async () => {
    const r = await call('createClientAdmin', { client: empresa({ empresa: 'Otro Nombre Muy Distinto', nit: '06141234561234' }), opId: opId() }, sessions.B.token);
    expect(r.json.result.status).toBe('duplicate');
    expect(r.json.result.matches[0].clientId).toBe(clientId);
    expect((await db.collection('clients_prod').get()).size).toBe(1);
  });

  test('two vendedores race for the same new DUI with real tokens: exactly one client exists afterwards', async () => {
    const natural = (n) => ({ tipo: 'natural', nombres: 'Persona' + n, apellidos: 'Carrera' + n, telefono: '7000-000' + n, dui: n % 2 ? '01234567-8' : '012345678' });
    const rs = await Promise.all([1, 2, 3, 4].map(n => call('createClientAdmin', { client: natural(n), opId: opId() }, n % 2 ? sessions.A.token : sessions.B.token)));
    expect(rs.filter(r => r.json.result && r.json.result.status === 'created')).toHaveLength(1);
    expect(rs.filter(r => r.json.result && r.json.result.status === 'duplicate')).toHaveLength(3);
    const all = await db.collection('clients_prod').where('tipo', '==', 'natural').get();
    expect(all.size).toBe(1);
  });

  test('B finds A\'s client through the catalogue and receives no private data', async () => {
    const r = await call('searchClientsCatalog', { q: 'industrias delta' }, sessions.B.token);
    expect(r.json.result.results.map(x => x.id)).toEqual([clientId]);
    expect(r.json.result.results[0].inPortfolio).toBe(false);
    expect(JSON.stringify(r.json.result)).not.toMatch(/7000-0001|06141234561234|1792037387205/);
  });

  test('B still cannot read or edit that client directly, nor list the collection', async () => {
    expect((await fsApi.get('clients_prod', clientId, sessions.B.token)).status).toBe(403);
    expect((await fsApi.query('clients_prod', null, sessions.B.token)).status).toBe(403);
    expect((await fsApi.query('clients_prod', ['createdBy', 'EQUAL', CID.A], sessions.B.token)).status).toBe(403);
    expect((await fsApi.set('clients_prod', clientId, { id: clientId, empresa: 'x', createdBy: CID.B }, sessions.B.token)).status).toBe(403);
  });

  test('B cannot create a client directly in Firestore (the callable is the only way)', async () => {
    const r = await fsApi.create('clients_prod', 'CDIRECT', { id: 'CDIRECT', empresa: 'Directo', createdBy: CID.B }, sessions.B.token);
    expect(r.status).toBe(403);
  });

  test('B creates its own opportunity on A\'s client (catalogue selection) and the client keeps its owner', async () => {
    const r = await fsApi.create('prospects_prod', 'PE2E1', { id: 'PE2E1', createdBy: CID.B, vendedorId: CID.B, clientId, estado: 'activo', datos: {} }, sessions.B.token);
    expect(r.status).toBe(200);
    expect((await db.collection('clients_prod').doc(clientId).get()).data().createdBy).toBe(CID.A);
  });

  test('the trigger links the client to B\'s portfolio; afterwards B can read it, and only through filtered queries', async () => {
    const visible = await waitFor(async () => { const d = (await db.collection('clients_prod').doc(clientId).get()).data(); return d.visibleTo && d.visibleTo.includes(CID.B) ? d.visibleTo : null; });
    expect(visible).toEqual([CID.B]);
    expect((await fsApi.get('clients_prod', clientId, sessions.B.token)).status).toBe(200);
    const q = await fsApi.query('clients_prod', ['visibleTo', 'ARRAY_CONTAINS', CID.B], sessions.B.token);
    expect(q.status).toBe(200);
    expect(JSON.parse(q.body).filter(x => x.document).length).toBe(1);
    expect((await fsApi.query('clients_prod', null, sessions.B.token)).status).toBe(403);
    expect((await db.collection('clients_prod').doc(clientId).get()).data().createdBy).toBe(CID.A);
  });

  test('after the link B may edit non-identity data through the server, but cannot change the NIT of a client to one that exists', async () => {
    const other = await call('createClientAdmin', { client: empresa({ empresa: 'Cliente Aparte Sin Relacion', nit: '06149999999999' }), opId: opId() }, sessions.A.token);
    const r = await call('updateClientAdmin', { id: other.json.result.client.id, client: empresa({ empresa: 'Cliente Aparte Sin Relacion', nit: '0614-123456-123-4' }) }, sessions.A.token);
    expect(r.json.result.status).toBe('duplicate');
    const denied = await call('updateClientAdmin', { id: other.json.result.client.id, client: empresa({ empresa: 'Cliente Aparte Sin Relacion' }) }, sessions.B.token);
    expect(denied.json.error.status).toBe('PERMISSION_DENIED');
  });

  test('retry of the same creation returns the same client without duplicating it', async () => {
    const id = opId();
    const a = await call('createClientAdmin', { client: empresa({ empresa: 'Reintento SA', contacto: 'Z', nit: '06145555555555' }), opId: id }, sessions.A.token);
    const b = await call('createClientAdmin', { client: empresa({ empresa: 'Reintento SA', contacto: 'Z', nit: '06145555555555' }), opId: id }, sessions.A.token);
    expect(a.json.result.status).toBe('created');
    expect(b.json.result).toMatchObject({ status: 'created', replay: true });
    expect(b.json.result.client.id).toBe(a.json.result.client.id);
  });

  test('gestor keeps the whole catalogue (everything is in its portfolio)', async () => {
    const r = await call('searchClientsCatalog', { q: 'industrias delta' }, sessions.GES.token);
    expect(r.json.result.results[0].inPortfolio).toBe(true);
    expect((await fsApi.query('clients_prod', null, sessions.GES.token)).status).toBe(200);
  });

  test('inactive and historical profiles are refused by the server; a linked profile without cid claim is served only by the callables', async () => {
    for (const s of [sessions.INACT, sessions.LEGACY]) {
      const r = await call('searchClientsCatalog', { q: 'industrias delta' }, s.token);
      expect(r.json.error.status).toBe('PERMISSION_DENIED');
    }
    // Linked, ACTIVE profile but no `cid` claim (what createUserAdmin produces today: claims are { role } only):
    // the callables resolve it through authUid and serve it, while the Firestore rules (which need the cid claim) give it nothing.
    const noClaims = await call('searchClientsCatalog', { q: 'industrias delta' }, sessions.NOCLAIMS.token);
    expect(noClaims.json.result.results.map(x => x.id)).toEqual([clientId]);
    expect((await fsApi.get('clients_prod', clientId, sessions.NOCLAIMS.token)).status).toBe(403);
    expect((await fsApi.get('clients_prod', clientId, sessions.INACT.token)).status).toBe(403);
  });

  test('a vendedor cannot call the manager-only user administration', async () => {
    const r = await call('createUserAdmin', { email: 'x@ductsal-test.invalid', nombre: 'X', role: 'gestor', opId: opId() }, sessions.A.token);
    expect(r.json.error.status).toBe('PERMISSION_DENIED');
  });
});
