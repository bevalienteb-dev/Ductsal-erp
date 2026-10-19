// functions/__tests__/clientsCallables.unit.test.js
// Entry points of the client catalogue (createClientAdmin / updateClientAdmin / searchClientsCatalog) with in-memory
// fakes: authentication, caller resolution from the CRM profile, error mapping and the emulator isolation guard.
// The data logic (duplicates, concurrency, search) is covered against a real Firestore emulator in isolated-tests/.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createClientAdmin, updateClientAdmin, searchClientsCatalog,
  reserveClientCreationAdmin, finalizeClientCreationAdmin, cancelClientReservationAdmin
} = require('../index');
const state = admin.__state;

const V1 = '1792037387205';
const ctx = (uid, token = {}) => ({ auth: { uid, token } });
const validClient = { tipo: 'juridica', empresa: 'Empresa Ficticia', contacto: 'Ana', telefono: '7000-0000' };
const calls = [
  ['createClientAdmin', createClientAdmin, { client: validClient, opId: 'op-unit-12345678' }],
  ['reserveClientCreationAdmin', reserveClientCreationAdmin, { client: validClient }],
  ['finalizeClientCreationAdmin', finalizeClientCreationAdmin, { reservationId: 'RES-1', client: validClient, opId: 'op-unit-fin-1234' }],
  ['cancelClientReservationAdmin', cancelClientReservationAdmin, { reservationId: 'RES-1' }],
  ['updateClientAdmin', updateClientAdmin, { id: 'C1', client: validClient }],
  ['searchClientsCatalog', searchClientsCatalog, { q: 'delta' }]
];

beforeEach(() => {
  state.docs = {}; state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR; delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

describe.each(calls)('%s: server-side authorization', (_n, fn, data) => {
  test('no session -> unauthenticated', async () => {
    await expect(fn(data, null)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(fn(data, {})).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  test('Auth account without a CRM profile -> permission-denied', async () => {
    await expect(fn(data, ctx('uid-1', { cid: 'NOPE' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('inactive profile -> permission-denied', async () => {
    state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-1', role: 'vendedor', activo: false };
    await expect(fn(data, ctx('uid-1', { cid: V1 }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('historical profile (no authUid) cannot be reached with a forged cid claim', async () => {
    state.docs['users_prod/LEGACY1'] = { id: 'LEGACY1', role: 'vendedor', activo: true, password: 'legacy-placeholder' };
    await expect(fn(data, ctx('uid-x', { cid: 'LEGACY1' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('plant role (operario) has no access to the catalogue', async () => {
    state.docs['users_prod/OP1'] = { id: 'OP1', authUid: 'uid-op', role: 'operario', activo: true };
    await expect(fn(data, ctx('uid-op', { cid: 'OP1' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('a role sent by the browser is ignored: the role is the profile one', async () => {
    state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-1', role: 'operario', activo: true };
    await expect(fn({ ...data, role: 'manager' }, ctx('uid-1', { cid: V1, role: 'manager' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('unknown dbSuffix is refused', async () => {
    state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-1', role: 'vendedor', activo: true };
    await expect(fn({ ...data, dbSuffix: '_evil' }, ctx('uid-1', { cid: V1 }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('under the Functions emulator it refuses to run without both emulators (could reach production)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    await expect(fn(data, ctx('uid-1', { cid: V1 }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('error mapping', () => {
  beforeEach(() => { state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-1', role: 'vendedor', activo: true }; });
  test('invalid client data -> invalid-argument with the validation message', async () => {
    await expect(createClientAdmin({ client: { tipo: 'natural', nombres: 'A' }, opId: 'op-unit-12345678' }, ctx('uid-1', { cid: V1 })))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('an unexpected failure is reported as internal WITHOUT leaking its message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    state.hooks.beforeGet = (p) => { if (p.startsWith('users_prod/')) throw new Error('secret db detail'); };
    const err = await createClientAdmin({ client: validClient, opId: 'op-unit-12345678' }, ctx('uid-1', { cid: V1 })).catch(e => e);
    expect(err.code).toBe('internal');
    expect(String(err.message)).not.toMatch(/secret/);
    spy.mockRestore();
  });
});
