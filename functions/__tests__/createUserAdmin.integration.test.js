// functions/__tests__/createUserAdmin.integration.test.js
// CRM-compatibility tests for createUserAdmin: server-side authorization, real CRM roles,
// profile schema / historical ids and environment (users_local vs users_prod) isolation.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { createUserAdmin } = require('../index');
const state = admin.__state;

const ctx = { auth: { uid: 'managerUid' } };
let opCounter = 0;
const payloadFor = (email, extra = {}) => ({
  email, nombre: 'Test User', role: 'vendedor', opId: `op_int_${++opCounter}`, ...extra
});
const keysStarting = prefix => Object.keys(state.docs).filter(k => k.startsWith(prefix));

beforeEach(() => {
  state.docs = {};
  state.allowVirtualManager = true;
  state.unlinkedManager = false;
  state.authUsers = {};
  state.createUserCalls = 0;
  state.createUserArgs = [];
  state.requesters = {};
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  jest.restoreAllMocks();
});

describe('authorization is verified server-side from Firebase Auth', () => {
  test('no Auth session → unauthenticated', async () => {
    await expect(createUserAdmin(payloadFor('a@x.com'), {})).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(state.createUserCalls).toBe(0);
  });

  test('a CRM-style manager without the verified `manager` claim is denied', async () => {
    await expect(createUserAdmin(payloadFor('a@x.com'), { auth: { uid: 'roleOnlyManagerUid' } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });

  test('the claim must be exactly `true` (truthy values are not enough)', async () => {
    state.requesters.managerUid = { customClaims: { manager: 'yes' } };
    await expect(createUserAdmin(payloadFor('a@x.com'), ctx)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });

  test('a disabled manager account is denied', async () => {
    await expect(createUserAdmin(payloadFor('a@x.com'), { auth: { uid: 'disabledManagerUid' } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });

  test('client-supplied token data or payload fields cannot grant manager access', async () => {
    const forged = { auth: { uid: 'regularUid', token: { manager: true } } };
    await expect(createUserAdmin(payloadFor('a@x.com', { manager: true, claims: { manager: true } }), forged))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });

  test('a verified manager can create a user', async () => {
    const result = await createUserAdmin(payloadFor('ok@x.com'), ctx);
    expect(result).toHaveProperty('uid');
    expect(result).toHaveProperty('id');
  });
});

describe('roles: only real CRM roles without privilege', () => {
  test.each(['vendedor', 'gestor'])('%s is created with the same role in the profile', async role => {
    const result = await createUserAdmin(payloadFor(`${role}@x.com`, { role }), ctx);
    expect(state.docs[`users_prod/${result.id}`]).toMatchObject({ role });
  });

  test.each(['manager', 'seller', 'sales', 'jefe_produccion', 'admin'])('%s is rejected', async role => {
    await expect(createUserAdmin(payloadFor('r@x.com', { role }), ctx)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
    expect(Object.keys(state.docs)).toHaveLength(0); // no operation or profile written
  });

  test('the only claim granted is the informational role; never `manager` or any privileged claim', async () => {
    await createUserAdmin(payloadFor('claims@x.com', { role: 'gestor' }), ctx);
    expect(state.authUsers['claims@x.com'].claims).toEqual({ role: 'gestor' });
  });
});

describe('credentials never reach Firestore or the function', () => {
  test('createUser receives only the email; a password in the payload is ignored and stored nowhere', async () => {
    const result = await createUserAdmin(payloadFor('nopass@x.com', { password: 'S3cret-plain' }), ctx);
    expect(state.createUserArgs).toEqual([{ email: 'nopass@x.com' }]);
    expect(JSON.stringify(state.docs)).not.toContain('S3cret-plain');
    const profile = state.docs[`users_prod/${result.id}`];
    expect(profile).not.toHaveProperty('password');
    expect(profile).not.toHaveProperty('passwordHash');
  });
});

describe('profile schema and historical ids', () => {
  test('profile is keyed by a CRM-format id; the Auth UID is kept separately', async () => {
    const result = await createUserAdmin(payloadFor('ids@x.com'), ctx);
    const profile = state.docs[`users_prod/${result.id}`];
    expect(result.id).toMatch(/^\d{13}$/);              // Date.now().toString(), as saveUser() in the CRM
    expect(profile.id).toBe(result.id);                  // document key === id field
    expect(profile.authUid).toBe(result.uid);
    expect(profile.authUid).not.toBe(profile.id);        // UID never used as commercial id
    expect(profile).toMatchObject({ authProvider: 'firebase', nombre: 'Test User', email: 'ids@x.com', activo: true });
    expect(profile).not.toHaveProperty('uid');
    expect(state.docs[`users_prod/${result.uid}`]).toBeUndefined(); // nothing keyed by Auth UID
  });

  test('an id collision never overwrites an existing profile; the next id is used', async () => {
    // Freeze at the current real time (a past constant would make the 5-minute lock look expired).
    const t = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t);
    const legacy = { id: String(t), nombre: 'Legacy', email: 'legacy@x.com', password: 'old', role: 'vendedor', activo: true };
    state.docs[`users_prod/${t}`] = { ...legacy };

    const result = await createUserAdmin(payloadFor('new@x.com'), ctx);
    expect(result.id).toBe(String(t + 1));
    expect(state.docs[`users_prod/${t}`]).toEqual(legacy);
  });

  test('historical users, prospects and clients (and their relation fields) are untouched', async () => {
    const seed = {
      'users_prod/1690000000000': { id: '1690000000000', nombre: 'Old Manager', email: 'om@x.com', password: 'pw', role: 'manager', activo: true },
      'users_prod/1690000000001': { id: '1690000000001', nombre: 'Old Seller', email: 'os@x.com', password: '', role: 'vendedor', activo: true },
      'prospects_prod/1695000000000': { id: '1695000000000', codigo: '202401001', createdBy: '1690000000001', vendedorId: '1690000000001' },
      'clients_prod/C1695000000000': { id: 'C1695000000000', createdBy: '1690000000001' }
    };
    Object.entries(seed).forEach(([k, v]) => { state.docs[k] = JSON.parse(JSON.stringify(v)); });

    await createUserAdmin(payloadFor('fresh@x.com'), ctx);

    Object.entries(seed).forEach(([k, v]) => expect(state.docs[k]).toEqual(v));
    expect(keysStarting('users_prod/')).toHaveLength(3);
    expect(keysStarting('prospects_prod/')).toHaveLength(1);
    expect(keysStarting('clients_prod/')).toHaveLength(1);
  });

  test('an email that already belongs to a historical profile (any casing) is a conflict; nothing is created', async () => {
    const legacy = { id: '1690000000000', nombre: 'Old', email: 'Dup@X.com', password: 'pw', role: 'gestor', activo: true };
    state.docs['users_prod/1690000000000'] = { ...legacy };
    const data = payloadFor('dup@x.com');

    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({ code: 'already-exists' });
    expect(state.createUserCalls).toBe(0);
    expect(state.docs[`userOps/${data.opId}`].status).toBe('conflict');
    expect(state.docs['users_prod/1690000000000']).toEqual(legacy);
  });

  test('an existing Auth account for the email is still a conflict (never adopted)', async () => {
    state.authUsers['taken@x.com'] = { uid: 'foreign', email: 'taken@x.com' };
    await expect(createUserAdmin(payloadFor('taken@x.com'), ctx)).rejects.toMatchObject({ code: 'already-exists' });
    expect(state.createUserCalls).toBe(0);
    expect(keysStarting('users_prod/')).toHaveLength(0);
  });
});

describe('environment isolation (users_local vs users_prod)', () => {
  test('dbSuffix "_local" writes only to local collections', async () => {
    const data = payloadFor('local@x.com', { dbSuffix: '_local' });
    const result = await createUserAdmin(data, ctx);

    expect(state.docs[`users_local/${result.id}`]).toMatchObject({ authUid: result.uid });
    expect(state.docs[`userOps_local/${data.opId}`]).toMatchObject({ status: 'succeeded' });
    expect(keysStarting('users_prod/')).toHaveLength(0);
    expect(keysStarting('userOps/')).toHaveLength(0);
    expect(keysStarting('userOpsLocks/')).toHaveLength(0);
    expect(keysStarting('userOpsLocks_local/')).toHaveLength(0); // lock released
  });

  test('dbSuffix "_prod" (or none, outside the emulator) writes to the production-named collections', async () => {
    const a = payloadFor('p1@x.com', { dbSuffix: '_prod' });
    const b = payloadFor('p2@x.com');
    const ra = await createUserAdmin(a, ctx);
    const rb = await createUserAdmin(b, ctx);
    expect(state.docs[`users_prod/${ra.id}`]).toBeDefined();
    expect(state.docs[`users_prod/${rb.id}`]).toBeDefined();
    expect(state.docs[`userOps/${a.opId}`]).toBeDefined();
    expect(keysStarting('users_local/')).toHaveLength(0);
  });

  test('inside the Functions emulator the default environment is local', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    const result = await createUserAdmin(payloadFor('emu@x.com'), ctx);
    expect(state.docs[`users_local/${result.id}`]).toBeDefined();
    expect(keysStarting('users_prod/')).toHaveLength(0);
  });

  test.each(['_staging', 'users_prod', '', 'prod'])('invalid dbSuffix %p is rejected before anything is written', async dbSuffix => {
    await expect(createUserAdmin(payloadFor('bad@x.com', { dbSuffix }), ctx)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(state.createUserCalls).toBe(0);
    expect(Object.keys(state.docs)).toHaveLength(0);
  });

  test('duplicate detection is per environment: an email in users_prod does not block users_local', async () => {
    state.docs['users_prod/1690000000000'] = { id: '1690000000000', email: 'same@x.com', password: 'pw', role: 'vendedor', activo: true };
    const result = await createUserAdmin(payloadFor('same@x.com', { dbSuffix: '_local' }), ctx);
    expect(state.docs[`users_local/${result.id}`]).toBeDefined();
    expect(state.docs['users_prod/1690000000000']).toMatchObject({ password: 'pw' });
  });
});
