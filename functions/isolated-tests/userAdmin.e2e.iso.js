// functions/isolated-tests/userAdmin.e2e.iso.js
// END TO END on the isolated emulators (Auth 9399, Firestore 8190, Functions 5101): user administration of Auth-linked
// profiles (updateUserAdmin, toggleUserStatusAdmin) called over HTTP with REAL Auth tokens and REAL custom claims, running in
// the REAL Functions emulator against the REAL Auth and Firestore emulators. The unit layer proves the logic with fakes; this
// proves: claims written to a real Auth service, real transactions, the global role-change lock under real contention, and that a
// demoted manager's still-valid token stops working at once (the server reads the claims live). Nothing here can reach a project.
// Not covered (needs a real project): behaviour of the production Auth backend, token propagation delays, quotas.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
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
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;
const CID = { M1: '2000000000001', M2: '2000000000002', T: '2000000000003', G: '2000000000004', V: '2000000000005', LEGACY: '2000000000006' };
const S = {};

async function post(url, body, token) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const call = (name, data, token) => post(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, token);

async function makeAccount(tag, cid, role, { linked = true, nombre = tag } = {}) {
  const email = `${tag}@ductsal-test.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!'; // random, test-only, never printed
  let uid = null; let token = null;
  if (linked) {
    const up = await post(idt('accounts:signUp'), { email, password, returnSecureToken: true });
    uid = up.json.localId;
    await auth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
    const inn = await post(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
    token = inn.json.idToken;
  }
  const profile = { id: cid, nombre, email, role, activo: true };
  if (linked) profile.authUid = uid;
  else profile.password = 'legacy-placeholder';
  await db.collection('users_prod').doc(cid).set(profile);
  return { uid, token, cid, email };
}

let seq = 0;
const opId = () => `op-usr-${Date.now()}-${++seq}`;
const profile = async cid => (await db.collection('users_prod').doc(cid).get()).data();
const claims = async s => (await auth.getUser(s.uid)).customClaims || {};
const audits = async (action, targetId) => (await db.collection('commercialAudit_prod').get()).docs.map(d => d.data())
  .filter(a => a.targetType === 'user' && (!action || a.action === action) && (!targetId || a.targetId === targetId));
const upd = (token, data) => call('updateUserAdmin', { opId: opId(), ...data }, token);

beforeAll(async () => {
  await assertIsolatedUp();
  const fnUp = await fetch('http://127.0.0.1:5101/').catch(() => null);
  if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering: start the isolated emulators with functions');
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await clearIsolatedFirestore();
  await loadFirestoreRules();
  S.M1 = await makeAccount('gerente1', CID.M1, 'manager');
  S.M2 = await makeAccount('gerente2', CID.M2, 'manager');
  S.T = await makeAccount('vendedor.t', CID.T, 'vendedor', { nombre: 'Tomas' });
  S.G = await makeAccount('gestor.g', CID.G, 'gestor');
  S.V = await makeAccount('vendedor.v', CID.V, 'vendedor');
  S.LEGACY = await makeAccount('historico', CID.LEGACY, 'vendedor', { linked: false, nombre: 'Historico' });
}, 60000);

describe('end to end: user administration with real Auth claims', () => {
  test('without session, as a seller or a gestor: refused, nothing changes', async () => {
    expect((await upd(null, { id: CID.T, role: 'gestor' })).json.error.status).toBe('UNAUTHENTICATED');
    for (const s of [S.V, S.G, S.T]) {
      expect((await upd(s.token, { id: CID.T, role: 'gestor' })).json.error.status).toBe('PERMISSION_DENIED');
      expect((await call('toggleUserStatusAdmin', { id: CID.T, activo: false, opId: opId() }, s.token)).json.error.status).toBe('PERMISSION_DENIED');
    }
    expect((await profile(CID.T)).role).toBe('vendedor');
    expect(await claims(S.T)).toEqual({ role: 'vendedor', cid: CID.T });
    expect((await auth.getUser(S.T.uid)).disabled).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  test('unexpected fields, invalid roles (manager, plant roles) and bad names are refused', async () => {
    for (const extra of [{ activo: false }, { authUid: 'x' }, { password: '1' }, { claims: { manager: true } }]) {
      expect((await upd(S.M1.token, { id: CID.T, nombre: 'X', ...extra })).json.error.status).toBe('INVALID_ARGUMENT');
    }
    for (const role of ['manager', 'operario', 'jefe_produccion', 'admin']) {
      expect((await upd(S.M1.token, { id: CID.T, role })).json.error.status).toBe('PERMISSION_DENIED');
    }
    for (const nombre of ['', '   ', 'x'.repeat(121), 'A\nB']) {
      expect((await upd(S.M1.token, { id: CID.T, nombre })).json.error.status).toBe('INVALID_ARGUMENT');
    }
    expect(await claims(S.T)).toEqual({ role: 'vendedor', cid: CID.T });
    expect(await profile(CID.T)).toMatchObject({ nombre: 'Tomas', role: 'vendedor' });
  });

  test('name edit: profile updated, Auth claims untouched, audit with before/after', async () => {
    const r = await upd(S.M1.token, { id: CID.T, nombre: '  Tomas Perez ' });
    expect(r.json.result).toMatchObject({ status: 'updated', nombre: 'Tomas Perez', fields: ['nombre'] });
    expect((await profile(CID.T)).nombre).toBe('Tomas Perez');
    expect(await claims(S.T)).toEqual({ role: 'vendedor', cid: CID.T });
    const a = (await audits('updateUser', CID.T))[0];
    expect(a).toMatchObject({ actorUid: S.M1.uid, actorCid: CID.M1, actorRole: 'manager' });
    expect(a.detail.before.nombre).toBe('Tomas');
    expect(a.detail.after.nombre).toBe('Tomas Perez');
    expect(JSON.stringify(a)).not.toMatch(/password|legacy/i);
  });

  test('role change: real claims {role,cid}, profile, sessions revoked, audit; the old token no longer authorizes as before', async () => {
    const before = await auth.getUser(S.T.uid);
    await new Promise(r => setTimeout(r, 1100)); // tokensValidAfterTime has 1 s resolution
    const r = await upd(S.M1.token, { id: CID.T, role: 'gestor' });
    expect(r.json.result).toMatchObject({ status: 'updated', role: 'gestor', sessionsRevoked: true });
    expect(await claims(S.T)).toEqual({ role: 'gestor', cid: CID.T });
    expect((await profile(CID.T)).role).toBe('gestor');
    const after = await auth.getUser(S.T.uid);
    expect(new Date(after.tokensValidAfterTime).getTime()).toBeGreaterThan(new Date(before.tokensValidAfterTime).getTime());
    const a = (await audits('updateUser', CID.T)).find(x => x.detail.fields.includes('role'));
    expect(a.detail.before).toMatchObject({ role: 'vendedor', claims: { role: 'vendedor', manager: false } });
    expect(a.detail.after).toMatchObject({ role: 'gestor', claims: { role: 'gestor', cid: CID.T, manager: false } });
    // the new role is the one the commercial callables see at once (the server resolves the caller from the profile)
    const asNewRole = await call('createProspectAdmin', { prospect: { clientId: 'NOPE', proyecto: 'x', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, S.T.token);
    expect(asNewRole.json.error.status).not.toBe('UNAUTHENTICATED');
  });

  test('no self-privilege: a manager cannot change their own role; promotion to manager does not exist', async () => {
    for (const role of ['vendedor', 'gestor']) expect((await upd(S.M1.token, { id: CID.M1, role })).json.error.status).toBe('PERMISSION_DENIED');
    expect((await upd(S.M1.token, { id: CID.G, role: 'manager' })).json.error.status).toBe('PERMISSION_DENIED');
    expect((await upd(S.M1.token, { id: CID.G, role: 'vendedor' })).json.result.status).toBe('updated');
    expect((await claims(S.G)).manager).toBeUndefined();
    expect(await claims(S.M1)).toMatchObject({ manager: true, role: 'manager' });
  });

  test('a historical profile (no authUid) is refused and left untouched', async () => {
    const r = await upd(S.M1.token, { id: CID.LEGACY, role: 'gestor' });
    expect(r.json.error.status).toBe('FAILED_PRECONDITION');
    expect(await profile(CID.LEGACY)).toMatchObject({ role: 'vendedor', password: 'legacy-placeholder', nombre: 'Historico' });
    expect((await call('toggleUserStatusAdmin', { id: CID.LEGACY, activo: false, opId: opId() }, S.M1.token)).json.error.status).toBe('FAILED_PRECONDITION');
    expect((await profile(CID.LEGACY)).activo).toBe(true);
  });

  test('idempotency: the same opId replays the stored result; a different payload with the same opId is refused; concurrent twins make one change', async () => {
    const op = opId();
    const first = await call('updateUserAdmin', { id: CID.V, role: 'gestor', opId: op }, S.M1.token);
    expect(first.json.result.status).toBe('updated');
    const replay = await call('updateUserAdmin', { id: CID.V, role: 'gestor', opId: op }, S.M1.token);
    expect(replay.json.result).toMatchObject({ status: 'updated', role: 'gestor', message: 'operation already completed' });
    expect((await call('updateUserAdmin', { id: CID.V, role: 'vendedor', opId: op }, S.M1.token)).json.error.status).toBe('ALREADY_EXISTS');
    expect((await call('updateUserAdmin', { id: CID.V, role: 'gestor', opId: op }, S.M2.token)).json.error.status).toBe('ALREADY_EXISTS');
    expect((await audits('updateUser', CID.V)).filter(a => a.detail.fields.includes('role'))).toHaveLength(1);

    const twin = opId();
    const rs = await Promise.all([1, 2, 3].map(() => call('updateUserAdmin', { id: CID.V, nombre: 'Victor', opId: twin }, S.M1.token)));
    expect(rs.some(r => r.json.result && r.json.result.status === 'updated')).toBe(true);
    for (const r of rs) expect(r.json.error === undefined || ['ABORTED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION'].includes(r.json.error.status)).toBe(true);
    expect((await audits('updateUser', CID.V)).filter(a => a.detail.fields.includes('nombre'))).toHaveLength(1);
    expect((await profile(CID.V)).nombre).toBe('Victor');
  });

  test('activation: Auth account + profile + audit together; own account and manager accounts are refused', async () => {
    const off = await call('toggleUserStatusAdmin', { id: CID.G, activo: false, opId: opId() }, S.M1.token);
    expect(off.json.result).toMatchObject({ id: CID.G, activo: false });
    expect((await auth.getUser(S.G.uid)).disabled).toBe(true);
    expect((await profile(CID.G)).activo).toBe(false);
    const a = (await audits('toggleUserStatus', CID.G))[0];
    expect(a.detail.before).toEqual({ activo: true, authDisabled: false });
    expect(a.detail.after).toEqual({ activo: false, authDisabled: true });
    const on = await call('toggleUserStatusAdmin', { id: CID.G, activo: true, opId: opId() }, S.M1.token);
    expect(on.json.result.activo).toBe(true);
    expect((await auth.getUser(S.G.uid)).disabled).toBe(false);
    expect((await profile(CID.G)).activo).toBe(true);
    expect((await call('toggleUserStatusAdmin', { id: CID.M1, activo: false, opId: opId() }, S.M1.token)).json.error.status).toBe('FAILED_PRECONDITION'); // self
    expect((await call('toggleUserStatusAdmin', { id: CID.M2, activo: false, opId: opId() }, S.M1.token)).json.error.status).toBe('PERMISSION_DENIED'); // manager target
    expect((await auth.getUser(S.M2.uid)).disabled).toBe(false);
    // a deactivated account's profile blocks its own admin attempts too
    expect((await profile(CID.M2)).activo).toBe(true);
  });

  test('two managers demoting each other at the same time: one wins, one manager always remains, the loser\'s still-valid token stops working', async () => {
    const rs = await Promise.all([
      upd(S.M1.token, { id: CID.M2, role: 'gestor' }),
      upd(S.M2.token, { id: CID.M1, role: 'gestor' })
    ]);
    const wins = rs.filter(r => r.json.result);
    const fails = rs.filter(r => r.json.error);
    expect(wins).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(['ALREADY_EXISTS', 'PERMISSION_DENIED']).toContain(fails[0].json.error.status);
    const c1 = await claims(S.M1); const c2 = await claims(S.M2);
    const managers = [c1, c2].filter(c => c.manager === true);
    expect(managers).toHaveLength(1);
    // the demoted manager's token is cryptographically still valid, but the server reads the claims live
    const demoted = c1.manager === true ? S.M2 : S.M1;
    const remaining = demoted === S.M1 ? S.M2 : S.M1;
    expect((await upd(demoted.token, { id: CID.T, nombre: 'Intento' })).json.error.status).toBe('PERMISSION_DENIED');
    expect((await call('toggleUserStatusAdmin', { id: CID.V, activo: false, opId: opId() }, demoted.token)).json.error.status).toBe('PERMISSION_DENIED');
    expect((await upd(remaining.token, { id: CID.T, nombre: 'Tomas Perez' })).json.result.status).toBe('unchanged');
    // the remaining (last) manager cannot demote itself
    expect((await upd(remaining.token, { id: remaining === S.M1 ? CID.M1 : CID.M2, role: 'gestor' })).json.error.status).toBe('PERMISSION_DENIED');
    expect((await claims(remaining)).manager).toBe(true);
    // the role-change lock is released
    expect((await db.collection('userOpsLocks').get()).docs).toHaveLength(0);
  });
});
