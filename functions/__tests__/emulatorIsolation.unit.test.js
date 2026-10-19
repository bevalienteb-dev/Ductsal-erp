// functions/__tests__/emulatorIsolation.unit.test.js
// UNIT tests (in-memory fakes). They prove the isolation guards and the seeding logic, NOT the
// behaviour of the real Firebase emulators, which could not be run in this environment
// (no Java runtime, no firebase-tools). The child-process tests below really execute the seed
// script, but only the paths where it must REFUSE to start; none of them connects to anything.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const path = require('path');
const { spawnSync } = require('child_process');
const admin = require('firebase-admin');
const { isLoopbackHost, emulatorIsolationProblems } = require('../emulatorGuard');
const { createUserAdmin, toggleUserStatusAdmin, resendInvitationAdmin, reconcileUserOp } = require('../index');
const { seedTestManager, SEED } = require('../scripts/seedEmulatorManager');
const state = admin.__state;

const SEED_SCRIPT = path.join(__dirname, '..', 'scripts', 'seedEmulatorManager.js');
const ctx = { auth: { uid: 'managerUid' } };

beforeEach(() => {
  state.docs = {};
  state.authUsers = {};
  state.createUserCalls = 0;
  state.createUserArgs = [];
  state.requesters = {};
  state.updateUserCalls = [];
  state.deletedUids = [];
  state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

describe('emulatorGuard', () => {
  test.each([
    ['127.0.0.1:8080', true], ['localhost:9099', true], ['[::1]:8080', true], ['::1', true],
    ['firestore.googleapis.com:443', false], ['10.0.0.5:8080', false], ['evil-localhost.com:80', false],
    ['localhost.evil.com:80', false], ['', false], [undefined, false], [null, false], [8080, false]
  ])('isLoopbackHost(%p) → %p', (value, expected) => {
    expect(isLoopbackHost(value)).toBe(expected);
  });

  test('both hosts are required', () => {
    expect(emulatorIsolationProblems({})).toHaveLength(2);
    expect(emulatorIsolationProblems({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toHaveLength(1);
    expect(emulatorIsolationProblems({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })).toEqual([]);
  });

  test('strict mode also requires a demo- project and no service-account credentials', () => {
    const hosts = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
    expect(emulatorIsolationProblems({ ...hosts, GCLOUD_PROJECT: 'demo-ductsal-local' }, { strict: true })).toEqual([]);
    expect(emulatorIsolationProblems({ ...hosts, GCLOUD_PROJECT: 'ductsal-erp' }, { strict: true })).toHaveLength(1);
    expect(emulatorIsolationProblems({ ...hosts }, { strict: true })).toHaveLength(1);
    expect(emulatorIsolationProblems({ ...hosts, GOOGLE_CLOUD_PROJECT: 'demo-x', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, { strict: true })).toHaveLength(1);
  });
});

describe('Cloud Functions refuse to run in emulator mode without BOTH emulators', () => {
  const calls = [
    ['createUserAdmin', () => createUserAdmin({ email: 'a@x.com', nombre: 'A', role: 'vendedor', opId: 'op1' }, ctx)],
    ['toggleUserStatusAdmin', () => toggleUserStatusAdmin({ id: '1', activo: false, opId: 'op2' }, ctx)],
    ['resendInvitationAdmin', () => resendInvitationAdmin({ id: '1' }, ctx)],
    ['reconcileUserOp', () => reconcileUserOp({ opId: 'op3' }, ctx)]
  ];

  test.each(calls)('%s: missing emulator hosts → failed-precondition before any Auth/Firestore access', async (_n, call) => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    await expect(call()).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringMatching(/Emulator isolation check failed/) });
    expect(Object.keys(state.docs)).toHaveLength(0);
    expect(state.createUserCalls).toBe(0);
  });

  test.each(calls)('%s: only the Firestore emulator configured → refused', async (_n, call) => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('a non-loopback "emulator" host is refused', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = 'firestore.googleapis.com:443';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    await expect(createUserAdmin({ email: 'a@x.com', nombre: 'A', role: 'vendedor', opId: 'op4' }, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(0);
  });

  test('with both loopback emulators configured the function proceeds (and defaults to _local)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    state.docs['users_local/mgr'] = { id: 'mgr', authUid: 'managerUid', role: 'manager', activo: true };
    const r = await createUserAdmin({ email: 'ok@x.com', nombre: 'A', role: 'vendedor', opId: 'op5' }, ctx);
    expect(state.docs[`users_local/${r.id}`]).toBeDefined();
  });

  test('outside the emulator (FUNCTIONS_EMULATOR unset) behaviour is unchanged: no host requirement', async () => {
    state.docs['users_prod/mgr'] = { id: 'mgr', authUid: 'managerUid', role: 'manager', activo: true };
    const r = await createUserAdmin({ email: 'prodlike@x.com', nombre: 'A', role: 'vendedor', opId: 'op6' }, ctx);
    expect(state.docs[`users_prod/${r.id}`]).toBeDefined();
  });
});

describe('seedTestManager (logic, fake Admin SDK)', () => {
  const historical = {
    'users_local/1690000000001': { id: '1690000000001', nombre: 'Histórico', email: 'old@x.com', password: 'legacy', role: 'vendedor', activo: true },
    'users_prod/1690000000002': { id: '1690000000002', nombre: 'Prod', email: 'prod@x.com', password: 'p', role: 'gestor', activo: true }
  };

  test('creates the Auth account with ONLY { manager: true } and a password-free profile with a separate commercial id', async () => {
    state.docs = JSON.parse(JSON.stringify(historical));
    const r = await seedTestManager(admin, { password: 'test-only-pass' });
    expect(r).toMatchObject({ uid: SEED.authUid, profileId: SEED.profileId, createdAuth: true, createdProfile: true });
    expect(state.authUsers[SEED.email].claims).toEqual({ manager: true });
    const profile = state.docs[`users_local/${SEED.profileId}`];
    expect(profile).toEqual({ id: SEED.profileId, authUid: SEED.authUid, authProvider: 'firebase', nombre: SEED.nombre, email: SEED.email, role: 'manager', activo: true });
    expect(profile.id).not.toBe(profile.authUid);
    expect(JSON.stringify(state.docs)).not.toContain('test-only-pass'); // the password lives in Auth only
    expect(SEED.email.endsWith('.invalid')).toBe(true);
  });

  test('is idempotent and never touches any other document', async () => {
    state.docs = JSON.parse(JSON.stringify(historical));
    await seedTestManager(admin, { password: 'x' });
    const afterFirst = JSON.stringify(state.docs);
    const second = await seedTestManager(admin, { password: 'y' });
    expect(second).toMatchObject({ createdAuth: false, createdProfile: false });
    expect(state.createUserCalls).toBe(1);
    expect(JSON.stringify(state.docs)).toBe(afterFirst);
    for (const [k, v] of Object.entries(historical)) expect(state.docs[k]).toEqual(v); // historical profiles byte-identical
    expect(Object.keys(state.docs).filter(k => k.startsWith('users_prod/'))).toEqual(['users_prod/1690000000002']);
  });

  test('refuses to adopt an Auth account with the same email but another uid', async () => {
    state.authUsers[SEED.email] = { uid: 'someone-else', email: SEED.email };
    await expect(seedTestManager(admin, {})).rejects.toThrow(/another Auth account/);
    expect(state.authUsers[SEED.email].claims).toBeUndefined(); // no claim granted
    expect(Object.keys(state.docs)).toHaveLength(0);
  });

  test('refuses when the profile id is taken by a different profile', async () => {
    state.docs[`users_local/${SEED.profileId}`] = { id: SEED.profileId, authUid: 'other', email: 'x@x.com', activo: true };
    await expect(seedTestManager(admin, {})).rejects.toThrow(/not the seed profile/);
    expect(state.docs[`users_local/${SEED.profileId}`].authUid).toBe('other');
  });

  test('the script source never writes to a production collection or imports credentials', () => {
    const src = require('fs').readFileSync(SEED_SCRIPT, 'utf8');
    expect(src).not.toMatch(/users_prod|serviceAccount|applicationDefault|cert\(/);
    expect(SEED.dbSuffix).toBe('_local');
  });
});

describe('seed script as a real process: refuses to start unless the environment is provably the emulators', () => {
  const PATH = process.env.PATH;
  const run = env => spawnSync(process.execPath, [SEED_SCRIPT], { env: { PATH, ...env }, encoding: 'utf8', timeout: 20000 });

  test.each([
    ['empty environment', {}],
    ['production project id, no emulator hosts', { GCLOUD_PROJECT: 'ductsal-erp' }],
    ['production project id even with emulator hosts', { GCLOUD_PROJECT: 'ductsal-erp', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }],
    ['demo project but only the Auth emulator', { GCLOUD_PROJECT: 'demo-ductsal-local', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }],
    ['demo project, hosts not loopback', { GCLOUD_PROJECT: 'demo-ductsal-local', FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }],
    ['service-account credentials configured', { GCLOUD_PROJECT: 'demo-ductsal-local', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/key.json' }]
  ])('%s → exit code 2 with an explanation, nothing attempted', (_n, env) => {
    const res = run(env);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Refusing to run/);
    expect(res.stdout).toBe('');
  });
});
