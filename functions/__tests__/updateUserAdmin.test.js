// functions/__tests__/updateUserAdmin.test.js
// updateUserAdmin (edit name / change role) and the audit trail of toggleUserStatusAdmin.
// SIMULATED tests: firebase-admin / firebase-functions are in-memory fakes (test-helpers/fakeFirebase.js). They prove the logic and
// the ordering of the calls, NOT the behaviour of the real Auth/Firestore services (that is covered by isolated-tests/*.iso.js).

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { updateUserAdmin, toggleUserStatusAdmin } = require('../index');
const state = admin.__state;

const MGR = { auth: { uid: 'managerUid' } };
const OTHER_MGR = { auth: { uid: 'otherManagerUid' } };
let n = 0;
const opId = () => `op_upd_${++n}`;
const upd = (extra = {}, c = MGR) => updateUserAdmin({ id: '5000', opId: opId(), ...extra }, c);
const audits = () => Object.entries(state.docs).filter(([k]) => k.startsWith('commercialAudit_prod/')).map(([, v]) => v);
const claimsOf = uid => (state.requesters[uid] || {}).customClaims;

const linked = (extra = {}) => {
  state.docs['users_prod/5000'] = { id: '5000', authUid: 'targetUid', email: 't@x.com', nombre: 'Tomás', role: 'vendedor', activo: true, ...extra };
  state.requesters.targetUid = { customClaims: { role: 'vendedor', cid: '5000' }, disabled: false };
};
const managers = () => {
  state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', nombre: 'Gerente A', role: 'manager', activo: true };
  state.docs['users_prod/901'] = { id: '901', authUid: 'otherManagerUid', nombre: 'Gerente B', role: 'manager', activo: true };
  state.docs['users_local/900'] = { id: '900', authUid: 'managerUid', nombre: 'Gerente A', role: 'manager', activo: true };
  state.docs['users_local/901'] = { id: '901', authUid: 'otherManagerUid', nombre: 'Gerente B', role: 'manager', activo: true };
  state.requesters.managerUid = { customClaims: { manager: true } };
  state.requesters.otherManagerUid = { customClaims: { manager: true } };
};

beforeEach(() => {
  state.docs = {}; state.authUsers = {}; state.requesters = {}; state.updateUserCalls = []; state.revokedUids = [];
  state.deletedUids = []; state.claimsCalls = []; state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR; delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  managers();
});

describe('updateUserAdmin: who may call it', () => {
  test.each([
    ['no session', {}, 'unauthenticated'],
    ['role-only manager (claim role=manager, no manager claim)', { auth: { uid: 'roleOnlyManagerUid' } }, 'permission-denied'],
    ['regular user', { auth: { uid: 'regularUid' } }, 'permission-denied'],
    ['seller', { auth: { uid: 'vendedorUid' } }, 'permission-denied'],
    ['disabled manager', { auth: { uid: 'disabledManagerUid' } }, 'permission-denied']
  ])('%s is rejected and nothing changes', async (_n, c, code) => {
    linked();
    await expect(upd({ role: 'gestor' }, c)).rejects.toMatchObject({ code });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
    expect(audits()).toHaveLength(0);
  });

  test('a manager whose own profile is inactive is rejected', async () => {
    linked();
    state.docs['users_prod/900'] = { id: '900', authUid: 'managerUid', role: 'manager', activo: false };
    await expect(upd({ role: 'gestor' })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.claimsCalls).toHaveLength(0);
  });
});

describe('updateUserAdmin: payload validation (no false success)', () => {
  test.each([
    ['activo', { activo: false }],
    ['authUid', { authUid: 'x' }],
    ['password', { password: '123' }],
    ['email', { email: 'a@b.com' }],
    ['claims', { claims: { manager: true } }],
    ['manager', { manager: true }]
  ])('an unexpected field (%s) is refused before anything is read or written', async (_n, extra) => {
    linked();
    await expect(upd({ nombre: 'Nuevo', ...extra })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(state.docs['users_prod/5000'].nombre).toBe('Tomás');
    expect(state.claimsCalls).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  test('nothing to change, bad ids and bad names are invalid-argument', async () => {
    linked();
    await expect(upd({})).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(upd({ id: 'a/b', nombre: 'X' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(updateUserAdmin({ id: '5000', nombre: 'X' }, MGR)).rejects.toMatchObject({ code: 'invalid-argument' }); // no opId
    for (const bad of ['', '   ', 'x'.repeat(121), 'A\nB', 'A\u0000B', 123, null]) {
      await expect(upd({ nombre: bad })).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(state.docs['users_prod/5000'].nombre).toBe('Tomás');
  });

  test('only vendedor and gestor can be assigned: manager, plant roles and unknown roles are refused', async () => {
    linked();
    for (const bad of ['manager', 'operador', 'admin', 'V2', '', null, 7]) {
      await expect(upd({ role: bad })).rejects.toMatchObject({ code: 'permission-denied' });
    }
    expect(claimsOf('targetUid')).toEqual({ role: 'vendedor', cid: '5000' });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
  });
});

describe('updateUserAdmin: name', () => {
  test('changes the profile name, writes an audit record with before/after, touches no claim and revokes no session', async () => {
    linked();
    const r = await upd({ nombre: '  Tomás Pérez  ' });
    expect(r).toMatchObject({ status: 'updated', id: '5000', nombre: 'Tomás Pérez', fields: ['nombre'], sessionsRevoked: false });
    expect(state.docs['users_prod/5000']).toMatchObject({ nombre: 'Tomás Pérez', role: 'vendedor', activo: true, authUid: 'targetUid', id: '5000' });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.revokedUids).toHaveLength(0);
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'updateUser', targetType: 'user', targetId: '5000', actorUid: 'managerUid', actorRole: 'manager' });
    expect(a[0].detail.before.nombre).toBe('Tomás');
    expect(a[0].detail.after.nombre).toBe('Tomás Pérez');
    expect(a[0].detail.fields).toEqual(['nombre']);
  });

  test('the audit actor carries the manager commercial id and name when the manager has a profile', async () => {
    linked(); managers();
    await upd({ nombre: 'Otro nombre' });
    expect(audits()[0]).toMatchObject({ actorCid: '900', actorName: 'Gerente A' });
  });

  test('a manager may edit their own name (no privilege involved)', async () => {
    managers();
    const r = await updateUserAdmin({ id: '900', nombre: 'Gerente Uno', opId: opId() }, MGR);
    expect(r.status).toBe('updated');
    expect(state.docs['users_prod/900'].nombre).toBe('Gerente Uno');
    expect(state.docs['users_prod/900'].role).toBe('manager');
    expect(state.claimsCalls).toHaveLength(0);
  });

  test('the same name again is "unchanged": no write, no audit', async () => {
    linked();
    const r = await upd({ nombre: 'Tomás' });
    expect(r.status).toBe('unchanged');
    expect(audits()).toHaveLength(0);
  });
});

describe('updateUserAdmin: role', () => {
  test('changes profile role AND claims ({role, cid}), revokes the target sessions, audits before/after without credentials', async () => {
    linked({ password: 'legacy-secret' });
    const r = await upd({ role: 'gestor' });
    expect(r).toMatchObject({ status: 'updated', role: 'gestor', fields: ['role'], sessionsRevoked: true });
    expect(state.docs['users_prod/5000'].role).toBe('gestor');
    expect(claimsOf('targetUid')).toEqual({ role: 'gestor', cid: '5000' });
    expect(state.revokedUids).toEqual(['targetUid']);
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0].detail.before).toMatchObject({ role: 'vendedor', claims: { role: 'vendedor', cid: '5000', manager: false } });
    expect(a[0].detail.after).toMatchObject({ role: 'gestor', claims: { role: 'gestor', cid: '5000', manager: false } });
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/legacy-secret|password|t@x\.com/);
  });

  test('role and name together are one change with one audit record', async () => {
    linked();
    const r = await upd({ role: 'gestor', nombre: 'Tomás G.' });
    expect(r.fields).toEqual(['nombre', 'role']);
    expect(audits()).toHaveLength(1);
    expect(state.docs['users_prod/5000']).toMatchObject({ nombre: 'Tomás G.', role: 'gestor' });
  });

  test('a manager cannot change their own role (no self-privilege, no self-demotion): nothing is touched', async () => {
    managers();
    await expect(updateUserAdmin({ id: '900', role: 'vendedor', opId: opId() }, MGR)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateUserAdmin({ id: '900', role: 'gestor', opId: opId() }, MGR)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.docs['users_prod/900'].role).toBe('manager');
    expect(claimsOf('managerUid')).toEqual({ manager: true });
  });

  test('a historical profile (no authUid) is refused: no Auth call, nothing written', async () => {
    state.docs['users_prod/5000'] = { id: '5000', email: 'old@x.com', password: 'legacy', nombre: 'Viejo', role: 'vendedor', activo: true };
    await expect(upd({ role: 'gestor' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(upd({ nombre: 'Nuevo' })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.docs['users_prod/5000']).toMatchObject({ nombre: 'Viejo', role: 'vendedor', password: 'legacy' });
    expect(audits()).toHaveLength(0);
  });

  test('unknown profile: not-found', async () => {
    await expect(upd({ id: '9999', role: 'gestor' })).rejects.toMatchObject({ code: 'not-found' });
  });

  test('a role that already matches but whose claims lack the cid repairs the claims and counts as an update', async () => {
    linked();
    state.requesters.targetUid.customClaims = { role: 'vendedor' }; // as created by createUserAdmin
    const r = await upd({ role: 'vendedor' });
    expect(r.status).toBe('updated');
    expect(claimsOf('targetUid')).toEqual({ role: 'vendedor', cid: '5000' });
  });

  test('the same role with canonical claims is "unchanged"', async () => {
    linked();
    const r = await upd({ role: 'vendedor' });
    expect(r.status).toBe('unchanged');
    expect(state.claimsCalls).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  test('environment isolation: _local touches only *_local collections', async () => {
    linked();
    state.docs['users_local/5000'] = { id: '5000', authUid: 'targetUid', nombre: 'Local', role: 'vendedor', activo: true };
    const op = opId();
    await updateUserAdmin({ id: '5000', role: 'gestor', opId: op, dbSuffix: '_local' }, MGR);
    expect(state.docs['users_local/5000'].role).toBe('gestor');
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
    expect(state.docs[`userOps_local/${op}`]).toMatchObject({ status: 'succeeded' });
    expect(Object.keys(state.docs).filter(k => k.startsWith('commercialAudit_local/'))).toHaveLength(1);
    expect(audits()).toHaveLength(0);
  });
});

describe('updateUserAdmin: managers (last manager, demotion)', () => {
  test('demoting ANOTHER manager removes the manager claim, keeps the caller a manager', async () => {
    managers();
    const r = await updateUserAdmin({ id: '901', role: 'gestor', opId: opId() }, MGR);
    expect(r.status).toBe('updated');
    expect(claimsOf('otherManagerUid')).toEqual({ role: 'gestor', cid: '901' });
    expect(claimsOf('otherManagerUid').manager).toBeUndefined();
    expect(state.docs['users_prod/901'].role).toBe('gestor');
    expect(claimsOf('managerUid')).toEqual({ manager: true });
    expect(audits()[0].detail.before.claims.manager).toBe(true);
    expect(audits()[0].detail.after.claims.manager).toBe(false);
  });

  test('the demoted manager can no longer demote the remaining one: at least one manager always remains', async () => {
    managers();
    await updateUserAdmin({ id: '901', role: 'gestor', opId: opId() }, MGR);
    await expect(updateUserAdmin({ id: '900', role: 'gestor', opId: opId() }, OTHER_MGR)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(claimsOf('managerUid').manager).toBe(true);
    expect(state.docs['users_prod/900'].role).toBe('manager');
  });

  test('two managers demoting each other at the same time: never both (global role-change lock)', async () => {
    managers();
    const results = await Promise.allSettled([
      updateUserAdmin({ id: '901', role: 'gestor', opId: opId() }, MGR),
      updateUserAdmin({ id: '900', role: 'gestor', opId: opId() }, OTHER_MGR)
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(['already-exists', 'permission-denied']).toContain(failed[0].reason.code);
    const stillManagers = ['managerUid', 'otherManagerUid'].filter(u => claimsOf(u).manager === true);
    expect(stillManagers).toHaveLength(1); // exactly the manager that lost the race
    expect(Object.keys(state.docs).filter(k => k.startsWith('userOpsLocks/'))).toHaveLength(0); // lock released
  });

  test('promotion to manager is not available through this function', async () => {
    linked();
    await expect(upd({ role: 'manager' })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(claimsOf('targetUid').manager).toBeUndefined();
  });

  test('the lock is released even when the operation fails, and a busy lock is reported (already-exists)', async () => {
    linked();
    await expect(upd({ id: '9999', role: 'gestor' })).rejects.toMatchObject({ code: 'not-found' });
    expect(Object.keys(state.docs).filter(k => k.startsWith('userOpsLocks/'))).toHaveLength(0);
    state.docs['userOpsLocks/role.change.global'] = { ownerUid: 'x', token: 't', expiresAt: { toDate: () => new Date(Date.now() + 60000) } };
    await expect(upd({ role: 'gestor' })).rejects.toMatchObject({ code: 'already-exists' });
    expect(state.claimsCalls).toHaveLength(0);
    expect(state.docs['userOpsLocks/role.change.global']).toBeDefined(); // not stolen
    state.docs['userOpsLocks/role.change.global'].expiresAt = { toDate: () => new Date(Date.now() - 1000) }; // expired: reclaimed
    await expect(upd({ role: 'gestor' })).resolves.toMatchObject({ status: 'updated' });
  });
});

describe('updateUserAdmin: partial failures between Auth and Firestore', () => {
  test('claims fail to apply: the previous claims are restored, the profile is unchanged, the caller gets an error and there is no audit', async () => {
    linked();
    let first = true;
    state.hooks.beforeSetClaims = () => { if (first) { first = false; throw new Error('auth unavailable'); } };
    await expect(upd({ role: 'gestor' })).rejects.toMatchObject({ code: 'internal' });
    expect(claimsOf('targetUid')).toEqual({ role: 'vendedor', cid: '5000' });
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
    expect(audits()).toHaveLength(0);
    expect(state.revokedUids).toHaveLength(0);
  });

  test('claims fail AND the restore fails: manual review, error to the caller (never a success), replay is blocked', async () => {
    linked();
    const op = opId();
    state.hooks.beforeSetClaims = () => { throw new Error('auth down'); };
    await expect(upd({ role: 'gestor', opId: op })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.docs[`userOps/${op}`]).toMatchObject({ status: 'manualReview' });
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
    state.hooks = {};
    await expect(upd({ role: 'gestor', opId: op })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.claimsCalls).toHaveLength(2); // the replay called nothing
  });

  test('profile transaction fails after the claims changed: claims rolled back, error, no audit, nothing half-applied', async () => {
    linked();
    const op = opId();
    state.hooks.beforeUpdate = path => { if (path === 'users_prod/5000') throw new Error('UNAVAILABLE'); };
    await expect(upd({ role: 'gestor', opId: op })).rejects.toMatchObject({ code: 'internal' });
    expect(claimsOf('targetUid')).toEqual({ role: 'vendedor', cid: '5000' });
    expect(state.docs['users_prod/5000'].role).toBe('vendedor');
    expect(audits()).toHaveLength(0);
    expect(state.docs[`userOps/${op}`]).toMatchObject({ status: 'error' });
    expect(state.revokedUids).toHaveLength(0);
  });

  test('profile transaction fails AND the claims restore fails: manual review, error', async () => {
    linked();
    const op = opId();
    state.hooks.beforeUpdate = path => { if (path === 'users_prod/5000') throw new Error('UNAVAILABLE'); };
    state.hooks.beforeSetClaims = (_u, _c, count) => { if (count > 1) throw new Error('auth down'); };
    await expect(upd({ role: 'gestor', opId: op })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.docs[`userOps/${op}`]).toMatchObject({ status: 'manualReview' });
    expect(audits()).toHaveLength(0);
  });

  test('the audit record cannot be lost without the profile change: if the audit write fails nothing is applied', async () => {
    linked();
    state.hooks.beforeCreate = path => { if (path.startsWith('commercialAudit_prod/')) throw new Error('UNAVAILABLE'); };
    await expect(upd({ nombre: 'Sin auditoría' })).rejects.toMatchObject({ code: 'internal' });
    expect(state.docs['users_prod/5000'].nombre).toBe('Tomás');
  });

  test('the profile changed between the read and the transaction: aborted, claims restored, nothing applied', async () => {
    linked();
    let reads = 0;
    state.hooks.beforeGet = path => {
      if (path === 'users_prod/5000' && ++reads === 2) state.docs['users_prod/5000'] = { ...state.docs['users_prod/5000'], nombre: 'Cambiado por otro' };
    };
    await expect(upd({ role: 'gestor' })).rejects.toMatchObject({ code: 'aborted' });
    expect(claimsOf('targetUid')).toEqual({ role: 'vendedor', cid: '5000' });
    expect(state.docs['users_prod/5000']).toMatchObject({ nombre: 'Cambiado por otro', role: 'vendedor' });
    expect(audits()).toHaveLength(0);
  });

  test('revoking the target sessions fails after everything was applied: the change stands and sessionsRevoked says false', async () => {
    linked();
    const real = admin.auth;
    const spy = jest.spyOn(admin, 'auth').mockImplementation(() => ({ ...real(), revokeRefreshTokens: async () => { throw new Error('boom'); } }));
    try {
      const r = await upd({ role: 'gestor' });
      expect(r).toMatchObject({ status: 'updated', sessionsRevoked: false });
    } finally { spy.mockRestore(); }
    expect(state.docs['users_prod/5000'].role).toBe('gestor');
    expect(claimsOf('targetUid').role).toBe('gestor');
  });
});

describe('updateUserAdmin: idempotency', () => {
  test('replaying the same operation returns the stored result and changes nothing again', async () => {
    linked();
    const op = opId();
    const first = await upd({ role: 'gestor', opId: op });
    const replay = await upd({ role: 'gestor', opId: op });
    expect(replay).toMatchObject({ status: 'updated', role: 'gestor', message: 'operation already completed' });
    expect(first.status).toBe('updated');
    expect(state.claimsCalls).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(state.revokedUids).toHaveLength(1);
  });

  test('the same opId with a different payload, or from another manager, is refused', async () => {
    linked(); managers();
    const op = opId();
    await upd({ role: 'gestor', opId: op });
    await expect(upd({ role: 'vendedor', opId: op })).rejects.toMatchObject({ code: 'already-exists' });
    await expect(updateUserAdmin({ id: '5000', role: 'gestor', opId: op }, OTHER_MGR)).rejects.toMatchObject({ code: 'already-exists' });
    expect(audits()).toHaveLength(1);
  });

  test('two concurrent identical requests produce exactly one change and one audit record', async () => {
    linked();
    const op = opId();
    const results = await Promise.allSettled([upd({ role: 'gestor', opId: op }), upd({ role: 'gestor', opId: op })]);
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(audits()).toHaveLength(1);
    expect(state.claimsCalls).toHaveLength(1);
    expect(state.docs['users_prod/5000'].role).toBe('gestor');
  });
});

describe('toggleUserStatusAdmin: audit trail and atomicity', () => {
  const toggle = (extra = {}) => toggleUserStatusAdmin({ id: '5000', activo: false, opId: opId(), ...extra }, MGR);

  test('deactivation writes the profile and ONE audit record with before/after (no credentials)', async () => {
    linked({ password: 'legacy-secret' });
    await toggle();
    expect(state.docs['users_prod/5000'].activo).toBe(false);
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'toggleUserStatus', targetId: '5000', actorUid: 'managerUid' });
    expect(a[0].detail.before).toEqual({ activo: true, authDisabled: false });
    expect(a[0].detail.after).toEqual({ activo: false, authDisabled: true });
    expect(JSON.stringify(a)).not.toMatch(/legacy-secret|password/);
  });

  test('if the profile + audit transaction fails, Auth is re-enabled and the caller gets an error (profile still active, no audit)', async () => {
    linked();
    state.hooks.beforeCreate = path => { if (path.startsWith('commercialAudit_prod/')) throw new Error('UNAVAILABLE'); };
    await expect(toggle()).rejects.toMatchObject({ code: 'internal' });
    expect(state.docs['users_prod/5000'].activo).toBe(true);
    expect(state.requesters.targetUid.disabled).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  test('manager accounts and the own account are still refused (deactivating a manager requires demoting it first)', async () => {
    managers();
    await expect(toggleUserStatusAdmin({ id: '900', activo: false, opId: opId() }, MGR)).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(toggleUserStatusAdmin({ id: '901', activo: false, opId: opId() }, MGR)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.updateUserCalls).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});
