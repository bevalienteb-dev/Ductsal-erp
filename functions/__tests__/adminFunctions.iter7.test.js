// functions/__tests__/adminFunctions.iter7.test.js
// Iteration 7: email normalization, requester profile checks, profile-write uncertainty and the
// environment-consistent toggleUserStatusAdmin / resendInvitationAdmin / reconcileUserOp.
// All Firebase objects are in-memory fakes; nothing reaches a real project.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { createUserAdmin, toggleUserStatusAdmin, resendInvitationAdmin, reconcileUserOp, listUsersAdmin } = require('../index');
const state = admin.__state;

const ctx = { auth: { uid: 'managerUid' } };
let n = 0;
const opId = () => `op_it7_${++n}`;
const create = (email, extra = {}) => ({ email, nombre: 'Test User', role: 'vendedor', opId: opId(), ...extra });
const keys = prefix => Object.keys(state.docs).filter(k => k.startsWith(prefix));

beforeEach(() => {
  state.docs = {};
  state.allowVirtualManager = true;
  state.unlinkedManager = false;
  state.authUsers = {};
  state.createUserCalls = 0;
  state.createUserArgs = [];
  state.requesters = {};
  state.updateUserCalls = [];
  state.revokedUids = [];
  state.deletedUids = [];
  state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

describe('email normalization', () => {
  test('the profile and the Auth account use the trimmed lower-case email', async () => {
    const r = await createUserAdmin(create('  Ana.Lopez@Empresa.COM '), ctx);
    expect(state.createUserArgs).toEqual([{ email: 'ana.lopez@empresa.com' }]);
    expect(state.docs[`users_prod/${r.id}`].email).toBe('ana.lopez@empresa.com');
  });

  test('an existing profile whose email differs only in case is a conflict (no Auth call)', async () => {
    state.docs['users_prod/1690000000000'] = { id: '1690000000000', email: 'Ana@X.com', password: 'legacy', activo: true };
    await expect(createUserAdmin(create('ana@x.com'), ctx)).rejects.toMatchObject({ code: 'already-exists' });
    expect(state.createUserCalls).toBe(0);
  });

  test('replaying the same opId with a differently-cased email is the same operation (no second account)', async () => {
    const op = opId();
    const first = await createUserAdmin({ ...create('Ana@X.com'), opId: op }, ctx);
    const replay = await createUserAdmin({ ...create('ana@x.com'), opId: op }, ctx);
    expect(replay).toMatchObject({ uid: first.uid, id: first.id });
    expect(state.createUserCalls).toBe(1);
    expect(keys('users_prod/')).toHaveLength(1);
  });

  test('an opId that is not a plain token is rejected before anything is written', async () => {
    for (const bad of ['a/b', '../x', '', 'x'.repeat(200), 12345, { a: 1 }]) {
      await expect(createUserAdmin({ ...create('t@x.com'), opId: bad }, ctx)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(Object.keys(state.docs)).toHaveLength(0);
    expect(state.createUserCalls).toBe(0);
  });
});

describe('requester profile state', () => {
  test('a manager whose linked CRM profile is inactive is denied (no Auth call, nothing written)', async () => {
    state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', role: 'manager', activo: false };
    await expect(createUserAdmin(create('t@x.com'), ctx)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
    expect(keys('userOps')).toHaveLength(0);
  });

  test('an active linked profile is allowed; unlinked manager profile is denied', async () => {
    state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', role: 'manager', activo: true };
    await expect(createUserAdmin(create('a@x.com'), ctx)).resolves.toHaveProperty('uid');
    state.docs = {};
    state.unlinkedManager = true;
    state.allowVirtualManager = false;
    await expect(createUserAdmin(create('b@x.com'), ctx)).rejects.toMatchObject({ code: 'permission-denied' });
    state.unlinkedManager = false;
    state.allowVirtualManager = true;
  });

  test('the profile check reads the environment collection only', async () => {
    state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', activo: false }; // production profile
    await expect(createUserAdmin(create('t@x.com', { dbSuffix: '_local' }), ctx)).resolves.toHaveProperty('uid');
  });
});

describe('profile write with an uncertain outcome', () => {
  test('write applied but the response was lost: the profile is adopted, the Auth account is kept', async () => {
    let fired = false;
    state.hooks.afterCreate = path => { if (path.startsWith('users_prod/') && !fired) { fired = true; throw new Error('DEADLINE_EXCEEDED'); } };
    const r = await createUserAdmin(create('lost@x.com'), ctx);
    expect(state.deletedUids).toEqual([]);
    expect(state.docs[`users_prod/${r.id}`]).toMatchObject({ authUid: r.uid, email: 'lost@x.com' });
    expect(keys('users_prod/')).toHaveLength(1);
  });

  test('write failed and the read-back also fails: Auth account is NOT deleted, manual review, no createUser retry', async () => {
    const op = opId();
    state.hooks.beforeCreate = path => { if (path.startsWith('users_prod/')) throw new Error('UNAVAILABLE'); };
    state.hooks.beforeGet = path => { if (path.startsWith('users_prod/')) throw new Error('UNAVAILABLE'); };
    await expect(createUserAdmin({ ...create('unk@x.com'), opId: op }, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.deletedUids).toEqual([]);
    expect(state.authUsers['unk@x.com']).toBeDefined();
    expect(state.docs[`userOps/${op}`]).toMatchObject({ status: 'manualReview', uid: 'authuid_1' });

    state.hooks = {};
    await expect(createUserAdmin({ ...create('unk@x.com'), opId: op }, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(1);
  });

  test('write definitely failed (read-back proves nothing landed): the account created by this very request is rolled back', async () => {
    const op = opId();
    state.hooks.beforeCreate = path => { if (path.startsWith('users_prod/')) throw new Error('PERMISSION_DENIED'); };
    await expect(createUserAdmin({ ...create('rb@x.com'), opId: op }, ctx)).rejects.toMatchObject({ code: 'internal' });
    expect(state.deletedUids).toEqual(['authuid_1']);
    expect(state.docs[`userOps/${op}`]).toMatchObject({ status: 'error', rolledBack: true });
    // a retry with the same opId is read, never re-executed
    state.hooks = {};
    await expect(createUserAdmin({ ...create('rb@x.com'), opId: op }, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(1);
  });

  test('a pre-existing Auth account for the email is never adopted', async () => {
    state.authUsers['pre@x.com'] = { uid: 'preexisting', email: 'pre@x.com' };
    await expect(createUserAdmin(create('Pre@X.com'), ctx)).rejects.toMatchObject({ code: 'already-exists' });
    expect(state.createUserCalls).toBe(0);
    expect(state.deletedUids).toEqual([]);
    expect(keys('users_prod/')).toHaveLength(0);
  });
});

// ---------------- toggleUserStatusAdmin ----------------
describe('toggleUserStatusAdmin', () => {
  const linked = (extra = {}) => {
    state.docs['users_prod/5000'] = { id: '5000', authUid: 'targetUid', email: 't@x.com', role: 'vendedor', activo: true, ...extra };
    state.requesters.targetUid = { customClaims: { role: 'vendedor' }, disabled: false };
  };
  const toggle = (extra = {}, c = ctx) => toggleUserStatusAdmin({ id: '5000', activo: false, opId: opId(), ...extra }, c);

  test.each([
    ['no session', {}, 'unauthenticated'],
    ['role-only manager', { auth: { uid: 'roleOnlyManagerUid' } }, 'permission-denied'],
    ['regular user', { auth: { uid: 'regularUid' } }, 'permission-denied'],
    ['disabled manager', { auth: { uid: 'disabledManagerUid' } }, 'permission-denied']
  ])('%s is rejected and nothing changes', async (_n, c, code) => {
    linked();
    await expect(toggle({}, c)).rejects.toMatchObject({ code });
    expect(state.updateUserCalls).toHaveLength(0);
    expect(state.docs['users_prod/5000'].activo).toBe(true);
  });

  test('an inactive manager profile is rejected', async () => {
    linked();
    state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', activo: false };
    await expect(toggle()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.updateUserCalls).toHaveLength(0);
  });

  test('deactivation resolves the commercial id to the authUid, disables Auth, updates the profile, revokes sessions', async () => {
    linked();
    const r = await toggle();
    expect(r).toEqual({ id: '5000', activo: false });
    expect(state.updateUserCalls).toEqual([{ uid: 'targetUid', attrs: { disabled: true } }]); // Auth UID, not the commercial id
    expect(state.revokedUids).toEqual(['targetUid']);
    expect(state.docs['users_prod/5000'].activo).toBe(false);
    expect(state.docs['users_prod/5000'].id).toBe('5000'); // commercial id untouched
  });

  test('reactivation enables the Auth account and does not revoke tokens', async () => {
    linked({ activo: false });
    state.requesters.targetUid.disabled = true;
    await toggle({ activo: true });
    expect(state.updateUserCalls).toEqual([{ uid: 'targetUid', attrs: { disabled: false } }]);
    expect(state.revokedUids).toEqual([]);
    expect(state.docs['users_prod/5000'].activo).toBe(true);
  });

  test('environment isolation: _local reads/writes only *_local collections', async () => {
    linked();
    state.docs['users_local/5000'] = { id: '5000', authUid: 'targetUid', activo: true };
    const op = opId();
    await toggle({ dbSuffix: '_local', opId: op });
    expect(state.docs['users_local/5000'].activo).toBe(false);
    expect(state.docs['users_prod/5000'].activo).toBe(true); // production profile untouched
    expect(state.docs[`userOps_local/${op}`]).toMatchObject({ status: 'succeeded' });
    expect(keys('userOps/')).toHaveLength(0);
  });

  test('emulator without dbSuffix defaults to _local; an invalid suffix is rejected', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    state.docs['users_local/5000'] = { id: '5000', authUid: 'targetUid', activo: true };
    state.requesters.targetUid = { customClaims: {} };
    await toggle();
    expect(state.docs['users_local/5000'].activo).toBe(false);
    delete process.env.FUNCTIONS_EMULATOR;
    await expect(toggle({ dbSuffix: '_staging' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a historical profile (no authUid) is refused: no Auth call', async () => {
    state.docs['users_prod/5000'] = { id: '5000', email: 'old@x.com', password: 'legacy', activo: true };
    await expect(toggle()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.updateUserCalls).toHaveLength(0);
    expect(state.docs['users_prod/5000'].activo).toBe(true);
    expect(state.docs['users_prod/5000'].password).toBe('legacy');
  });

  test('a manager cannot change their own status, nor another manager account', async () => {
    state.docs['users_prod/5000'] = { id: '5000', authUid: 'managerUid', role: 'manager', activo: true };
    await expect(toggle()).rejects.toMatchObject({ code: 'failed-precondition' });
    state.docs['users_prod/5001'] = { id: '5001', authUid: 'otherManagerUid', role: 'manager', activo: true };
    await expect(toggle({ id: '5001' })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.updateUserCalls).toHaveLength(0);
  });

  test('missing profile → not-found; invalid arguments are rejected', async () => {
    await expect(toggle({ id: '404' })).rejects.toMatchObject({ code: 'not-found' });
    for (const bad of [{ activo: 'false' }, { activo: undefined }, { id: 'a/b' }, { opId: '' }]) {
      linked();
      await expect(toggle(bad)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
  });

  test('idempotent: replaying a completed operation does nothing; reusing the key with another payload fails', async () => {
    linked();
    state.docs['users_prod/mgr2'] = { id: 'mgr2', authUid: 'otherManagerUid', role: 'manager', activo: true };
    const op = opId();
    await toggle({ opId: op });
    state.updateUserCalls = [];
    expect(await toggle({ opId: op })).toMatchObject({ activo: false, message: 'operation already completed' });
    expect(state.updateUserCalls).toHaveLength(0);
    await expect(toggle({ opId: op, activo: true })).rejects.toMatchObject({ code: 'already-exists' });
    await expect(toggle({ opId: op }, { auth: { uid: 'otherManagerUid' } })).rejects.toMatchObject({ code: 'already-exists' });
  });

  test('profile update failure rolls the Auth flag back to the state that was read', async () => {
    linked();
    state.hooks.beforeUpdate = path => { if (path === 'users_prod/5000') throw new Error('UNAVAILABLE'); };
    const op = opId();
    await expect(toggle({ opId: op })).rejects.toMatchObject({ code: 'internal' });
    expect(state.updateUserCalls.map(c => c.attrs)).toEqual([{ disabled: true }, { disabled: false }]);
    expect(state.docs[`userOps/${op}`].status).toBe('error');
    expect(state.docs['users_prod/5000'].activo).toBe(true);
  });

  test('profile update AND Auth rollback fail → manual review, never silent', async () => {
    linked();
    state.hooks.beforeUpdate = path => { if (path === 'users_prod/5000') throw new Error('UNAVAILABLE'); };
    let calls = 0;
    // admin.auth() returns a fresh object on every call: patch the factory so the 2nd updateUser
    // (the rollback) fails.
    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return { ...a, updateUser: async (uid, attrs) => { calls += 1; if (calls === 2) throw new Error('rollback failed'); return a.updateUser(uid, attrs); } };
    };
    try {
      const op = opId();
      await expect(toggle({ opId: op })).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(state.docs[`userOps/${op}`].status).toBe('manualReview');
      await expect(toggle({ opId: op })).rejects.toMatchObject({ code: 'failed-precondition' }); // blocked, not re-run
    } finally {
      admin.auth = authFactory;
    }
  });
});

// ---------------- resendInvitationAdmin ----------------
describe('resendInvitationAdmin', () => {
  const resend = (extra = {}, c = ctx) => resendInvitationAdmin({ id: '5000', ...extra }, c);
  beforeEach(() => {
    state.docs['users_prod/5000'] = { id: '5000', authUid: 'targetUid', email: 't@x.com', activo: true };
  });

  test('only verified managers', async () => {
    await expect(resend({}, {})).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(resend({}, { auth: { uid: 'roleOnlyManagerUid' } })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('does not pretend to send: tells the client to use Firebase sendPasswordResetEmail, and returns no link', async () => {
    const r = await resend();
    expect(r).toMatchObject({ sent: false, delivery: 'client', email: 't@x.com' });
    expect(JSON.stringify(r)).not.toMatch(/https?:\/\//);
  });

  test('historical, inactive and unknown profiles are refused; environment-scoped', async () => {
    state.docs['users_prod/6000'] = { id: '6000', email: 'old@x.com', password: 'legacy', activo: true };
    state.docs['users_prod/7000'] = { id: '7000', authUid: 'u7', activo: false };
    await expect(resend({ id: '6000' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(resend({ id: '7000' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(resend({ id: '404' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(resend({ dbSuffix: '_local' })).rejects.toMatchObject({ code: 'not-found' }); // exists only in prod
  });
});

// ---------------- reconcileUserOp ----------------
describe('reconcileUserOp', () => {
  test('only verified managers; reads the ops collection of the requested environment', async () => {
    state.docs['userOps/opA'] = { status: 'manualReview', where: 'prod' };
    state.docs['userOps_local/opA'] = { status: 'succeeded', where: 'local' };
    await expect(reconcileUserOp({ opId: 'opA' }, { auth: { uid: 'roleOnlyManagerUid' } })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await reconcileUserOp({ opId: 'opA', dbSuffix: '_local' }, ctx)).where).toBe('local');
    expect((await reconcileUserOp({ opId: 'opA', dbSuffix: '_prod' }, ctx)).where).toBe('prod');
    await expect(reconcileUserOp({ opId: 'missing', dbSuffix: '_local' }, ctx)).rejects.toMatchObject({ code: 'not-found' });
    await expect(reconcileUserOp({ opId: 'a/b' }, ctx)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('createUserAdmin in _local never writes to the production collections (users, userOps, userOpsLocks)', async () => {
    await createUserAdmin(create('iso@x.com', { dbSuffix: '_local' }), ctx);
    expect(keys('users_prod/')).toHaveLength(0);
    expect(keys('userOps/')).toHaveLength(0);
    expect(keys('userOpsLocks/')).toHaveLength(0);
    expect(keys('users_local/')).toHaveLength(1);
    expect(keys('userOps_local/')).toHaveLength(1);
  });

  describe('reconcileUserOp unlinked manager authorization (SEC-03)', () => {
    const unlinkedMgrUid = 'unlinkedManagerUid';
    const unlinkedCtx = { auth: { uid: unlinkedMgrUid } };

    beforeEach(() => {
      state.allowVirtualManager = false;
      state.unlinkedManager = true;
      // unlinkedManagerUid has manager claim in Auth but NO linked profile in Firestore
      state.requesters[unlinkedMgrUid] = { customClaims: { manager: true }, disabled: false };
      // Ensure no profile exists for unlinkedManagerUid in users_prod
      delete state.docs[`users_prod/${unlinkedMgrUid}`];
    });

    test('unlinked manager CAN reconcile own operation recorded with canonical requesterUid', async () => {
      state.docs['userOps/op_own_req'] = {
        status: 'manualReview',
        action: 'provisionManager',
        requesterUid: unlinkedMgrUid,
        cid: '1776895495203'
      };
      const res = await reconcileUserOp({ opId: 'op_own_req', dbSuffix: '_prod' }, unlinkedCtx);
      expect(res).toMatchObject({ status: 'manualReview', requesterUid: unlinkedMgrUid });
    });

    test('unlinked manager CAN reconcile historical operation with only actor.uid', async () => {
      state.docs['userOps/op_hist_actor'] = {
        status: 'pending',
        action: 'provisionManager',
        actor: { uid: unlinkedMgrUid, name: 'Historical Manager' },
        cid: '1776895495203'
      };
      const res = await reconcileUserOp({ opId: 'op_hist_actor', dbSuffix: '_prod' }, unlinkedCtx);
      expect(res).toMatchObject({ status: 'pending' });
    });

    test('unlinked manager CAN reconcile operation targeting their account via uid or result.uid', async () => {
      state.docs['userOps/op_target_uid'] = {
        status: 'authCreated',
        uid: unlinkedMgrUid,
        requesterUid: 'system_admin'
      };
      const res1 = await reconcileUserOp({ opId: 'op_target_uid', dbSuffix: '_prod' }, unlinkedCtx);
      expect(res1).toMatchObject({ uid: unlinkedMgrUid });

      state.docs['userOps/op_target_res'] = {
        status: 'succeeded',
        result: { uid: unlinkedMgrUid },
        requesterUid: 'system_admin'
      };
      const res2 = await reconcileUserOp({ opId: 'op_target_res', dbSuffix: '_prod' }, unlinkedCtx);
      expect(res2).toMatchObject({ result: { uid: unlinkedMgrUid } });
    });

    test('unlinked manager is REJECTED when trying to reconcile an operation of another user', async () => {
      state.docs['userOps/op_alien'] = {
        status: 'manualReview',
        requesterUid: 'other_operator_uid',
        uid: 'target_other_uid'
      };
      await expect(reconcileUserOp({ opId: 'op_alien', dbSuffix: '_prod' }, unlinkedCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('unlinked manager is REJECTED when ownership metadata is contradictory (requesterUid !== actor.uid)', async () => {
      state.docs['userOps/op_contradictory'] = {
        status: 'manualReview',
        requesterUid: unlinkedMgrUid,
        actor: { uid: 'different_actor_uid' }
      };
      await expect(reconcileUserOp({ opId: 'op_contradictory', dbSuffix: '_prod' }, unlinkedCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('unlinked manager is REJECTED when operation lacks all ownership and target fields', async () => {
      state.docs['userOps/op_anonymous'] = {
        status: 'error',
        message: 'No owner metadata'
      };
      await expect(reconcileUserOp({ opId: 'op_anonymous', dbSuffix: '_prod' }, unlinkedCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('manager with inactive linked profile is REJECTED from reconcileUserOp', async () => {
      const inactiveMgrUid = 'inactiveMgrUid';
      state.requesters[inactiveMgrUid] = { customClaims: { manager: true }, disabled: false };
      state.docs['users_prod/inactive_mgr_doc'] = {
        id: 'inactive_mgr_doc',
        authUid: inactiveMgrUid,
        role: 'manager',
        activo: false
      };
      state.docs['userOps/op_any'] = { status: 'succeeded', requesterUid: inactiveMgrUid };

      await expect(reconcileUserOp({ opId: 'op_any', dbSuffix: '_prod' }, { auth: { uid: inactiveMgrUid } }))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });
  });
});

describe('listUsersAdmin (SEC-03)', () => {
  test('rejects non-manager callers', async () => {
    await expect(listUsersAdmin({}, { auth: { uid: 'regularUid' } })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('rejects manager caller if their profile is inactive', async () => {
    state.docs['users_prod/mgr1'] = { id: 'mgr1', authUid: 'managerUid', activo: false, role: 'manager' };
    await expect(listUsersAdmin({}, ctx)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('manager gets projected user details and strictly omits password', async () => {
    state.docs['users_prod/101'] = { id: '101', nombre: 'Histórico', email: 'hist@x.com', role: 'vendedor', activo: true, password: 'plaintext_password_123' };
    state.docs['users_prod/102'] = { id: '102', nombre: 'Moderno', email: 'mod@x.com', role: 'manager', activo: true, authUid: 'managerUid' };

    const res = await listUsersAdmin({ dbSuffix: '_prod' }, ctx);
    expect(res).toBeDefined();
    expect(res.users).toHaveLength(2);

    const hist = res.users.find(u => u.id === '101');
    expect(hist).toEqual({
      id: '101',
      nombre: 'Histórico',
      email: 'hist@x.com',
      role: 'vendedor',
      activo: true,
      authUid: null
    });
    // Explicit assertion that password is not present
    expect(hist.password).toBeUndefined();

    const mod = res.users.find(u => u.id === '102');
    expect(mod).toEqual({
      id: '102',
      nombre: 'Moderno',
      email: 'mod@x.com',
      role: 'manager',
      activo: true,
      authUid: 'managerUid'
    });
    expect(mod.password).toBeUndefined();
  });

  test('respects dbSuffix environment isolation', async () => {
    state.docs['users_prod/p1'] = { id: 'p1', nombre: 'Prod User', email: 'p@x.com', role: 'manager', activo: true, authUid: 'managerUid' };
    state.docs['users_local/l1'] = { id: 'l1', nombre: 'Local User', email: 'l@x.com', role: 'manager', activo: true, authUid: 'managerUid' };

    const prodRes = await listUsersAdmin({ dbSuffix: '_prod' }, ctx);
    expect(prodRes.users.map(u => u.id)).toEqual(['p1']);

    const localRes = await listUsersAdmin({ dbSuffix: '_local' }, ctx);
    expect(localRes.users.map(u => u.id)).toEqual(['l1']);
  });
});

describe('SEC-05: getSecureDownloadUrlAdmin dedicated service account binding', () => {
  test('getSecureDownloadUrlAdmin uses dedicated crm-downloads-sa and other functions do not', () => {
    const { getSecureDownloadUrlAdmin, createUserAdmin } = require('../index');
    expect(getSecureDownloadUrlAdmin.__runWithOptions).toEqual({
      serviceAccount: 'crm-downloads-sa@ductsal-erp.iam.gserviceaccount.com'
    });
    expect(getSecureDownloadUrlAdmin.__endpoint).toEqual({
      serviceAccountEmail: 'crm-downloads-sa@ductsal-erp.iam.gserviceaccount.com'
    });
    expect(createUserAdmin.__runWithOptions).toEqual({});
    expect(createUserAdmin.__endpoint).toEqual({
      serviceAccountEmail: undefined
    });
  });
});
