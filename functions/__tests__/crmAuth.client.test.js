// functions/__tests__/crmAuth.client.test.js
// Tests for the client-side Firebase Authentication integration (crm_auth.js) and a static check
// that app_core.js / index.html wire it in without disturbing the legacy login.

const fs = require('fs');
const path = require('path');
const CrmAuth = require('../../crm_auth.js');

// ---------- Fake Firebase namespace ----------
function makeFb({ currentUser = null, signInResult, signInError, callableImpl, claims } = {}) {
  const calls = { signIn: [], signOut: 0, reset: [], callable: [] };
  const authObj = {
    currentUser,
    onAuthStateChanged: cb => { setTimeout(() => cb(authObj.currentUser), 0); return () => {}; },
    async signInWithEmailAndPassword(email, password) {
      calls.signIn.push({ email, password });
      if (signInError) throw signInError;
      return signInResult;
    },
    async signOut() { calls.signOut += 1; },
    async sendPasswordResetEmail(email) { calls.reset.push(email); }
  };
  if (claims !== undefined && !currentUser) {
    authObj.currentUser = { uid: 'mgr', getIdTokenResult: async () => ({ claims }) };
  }
  const fb = {
    auth: () => authObj,
    functions: () => ({
      httpsCallable: name => async payload => {
        calls.callable.push({ name, payload });
        return callableImpl(payload);
      }
    })
  };
  return { fb, calls, authObj };
}

const managerFb = (callableImpl) => makeFb({ claims: { manager: true }, callableImpl });
const fnError = (code, message = '') => Object.assign(new Error(message), { code: `functions/${code}` });

beforeEach(() => CrmAuth._pendingOps.clear());

describe('login with Firebase Authentication (users with authUid)', () => {
  const user = { id: '1690000000000', authUid: 'uid-1', email: 'u@x.com' };

  test('succeeds only when the signed-in account is the one linked to the profile', async () => {
    const { fb, calls } = makeFb({ signInResult: { user: { uid: 'uid-1' } } });
    await expect(CrmAuth.loginWithFirebase(fb, user, 'pw')).resolves.toEqual({ ok: true });
    expect(calls.signIn).toEqual([{ email: 'u@x.com', password: 'pw' }]); // password goes to Firebase Auth only
  });

  test('a different Auth uid is rejected and the Firebase session is closed', async () => {
    const { fb, calls } = makeFb({ signInResult: { user: { uid: 'someone-else' } } });
    await expect(CrmAuth.loginWithFirebase(fb, user, 'pw')).resolves.toEqual({ ok: false, reason: 'uid-mismatch' });
    expect(calls.signOut).toBe(1);
  });

  test('Auth errors are reported with a generic message (no account enumeration)', async () => {
    const { fb } = makeFb({ signInError: Object.assign(new Error('x'), { code: 'auth/wrong-password' }) });
    const res = await CrmAuth.loginWithFirebase(fb, user, 'bad');
    expect(res.ok).toBe(false);
    expect(CrmAuth.loginErrorMessage(res.reason)).toBe('Correo o contraseña incorrectos.');
    const { fb: fb2 } = makeFb({ signInError: Object.assign(new Error('x'), { code: 'auth/user-not-found' }) });
    const res2 = await CrmAuth.loginWithFirebase(fb2, user, 'bad');
    expect(CrmAuth.loginErrorMessage(res2.reason)).toBe(CrmAuth.loginErrorMessage(res.reason));
  });

  test('missing Firebase Auth SDK fails closed', async () => {
    await expect(CrmAuth.loginWithFirebase({}, user, 'pw')).resolves.toEqual({ ok: false, reason: 'sdk-unavailable' });
  });

  test('password setup/reset uses Firebase\'s own email flow', async () => {
    const { fb, calls } = makeFb();
    await CrmAuth.sendPasswordSetupEmail(fb, 'u@x.com');
    expect(calls.reset).toEqual(['u@x.com']);
  });
});

describe('manager session detection (a UX hint; the server decides)', () => {
  test('true only for a verified `manager === true` claim', async () => {
    expect(await CrmAuth.hasManagerSession(makeFb({ claims: { manager: true } }).fb)).toBe(true);
    expect(await CrmAuth.hasManagerSession(makeFb({ claims: { role: 'manager' } }).fb)).toBe(false);
    expect(await CrmAuth.hasManagerSession(makeFb({ claims: { manager: 'yes' } }).fb)).toBe(false);
    expect(await CrmAuth.hasManagerSession(makeFb({ claims: {} }).fb)).toBe(false);
  });

  test('false without a Firebase session or SDK', async () => {
    expect(await CrmAuth.hasManagerSession(makeFb().fb)).toBe(false);
    expect(await CrmAuth.hasManagerSession({})).toBe(false);
  });
});

describe('createUserViaFunction', () => {
  const params = { email: 'n@x.com', nombre: 'N', role: 'vendedor', dbSuffix: '_local' };

  test('sends the CRM payload with an opId and never a password', async () => {
    const { fb, calls } = managerFb(() => ({ data: { uid: 'a', id: '1' } }));
    const data = await CrmAuth.createUserViaFunction(fb, params);
    expect(data).toEqual({ uid: 'a', id: '1' });
    expect(calls.callable[0].name).toBe('createUserAdmin');
    expect(calls.callable[0].payload).toMatchObject({ ...params, opId: expect.any(String) });
    expect(JSON.stringify(calls.callable[0].payload)).not.toMatch(/password/i);
  });

  test.each(['manager', 'seller', 'sales', 'jefe_produccion'])('role %s is never sent to the function', async role => {
    const { fb, calls } = managerFb(() => ({ data: {} }));
    await expect(CrmAuth.createUserViaFunction(fb, { ...params, role })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(calls.callable).toHaveLength(0);
  });

  test('the same opId is reused after an uncertain failure so a retry cannot duplicate the account', async () => {
    let attempt = 0;
    const { fb, calls } = managerFb(() => { attempt += 1; if (attempt === 1) throw fnError('unavailable'); return { data: { uid: 'a', id: '1' } }; });
    await expect(CrmAuth.createUserViaFunction(fb, params)).rejects.toMatchObject({ code: 'functions/unavailable' });
    await CrmAuth.createUserViaFunction(fb, params);
    expect(calls.callable[1].payload.opId).toBe(calls.callable[0].payload.opId);
  });

  test('a new opId is used after a definitive failure or a success', async () => {
    let attempt = 0;
    const { fb, calls } = managerFb(() => { attempt += 1; if (attempt === 1) throw fnError('permission-denied'); return { data: {} }; });
    await expect(CrmAuth.createUserViaFunction(fb, params)).rejects.toBeDefined();
    await CrmAuth.createUserViaFunction(fb, params);
    await CrmAuth.createUserViaFunction(fb, params);
    const ids = calls.callable.map(c => c.payload.opId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('adminCreateUser', () => {
  const params = { nombre: 'N', email: 'n@x.com', role: 'vendedor', dbSuffix: '_prod' };

  test("'unavailable' without a verified manager session: explicit message, function never called", async () => {
    const { fb, calls } = makeFb({ callableImpl: () => ({ data: {} }) });
    const notify = jest.fn();
    expect(await CrmAuth.adminCreateUser(fb, params, notify)).toBe('unavailable');
    expect(calls.callable).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/No se creó el usuario/);
    expect(notify.mock.calls[0][0]).toMatch(/sesión de Firebase de gerente/);
  });

  test("'unavailable' for roles the function may not create (e.g. manager): explicit message", async () => {
    const { fb, calls } = managerFb(() => ({ data: {} }));
    const notify = jest.fn();
    expect(await CrmAuth.adminCreateUser(fb, { ...params, role: 'manager' }, notify)).toBe('unavailable');
    expect(calls.callable).toHaveLength(0);
    expect(notify.mock.calls[0][0]).toMatch(/solo se pueden crear los roles vendedor y gestor/);
  });

  test("'created' sends the password setup email", async () => {
    const { fb, calls } = managerFb(() => ({ data: { uid: 'a', id: '1' } }));
    const notify = jest.fn();
    expect(await CrmAuth.adminCreateUser(fb, params, notify)).toBe('created');
    expect(calls.reset).toEqual(['n@x.com']);
    expect(notify.mock.calls[0][0]).toMatch(/Usuario creado/);
  });

  test("'failed' reports the error and sends no email", async () => {
    const { fb, authObj } = managerFb(() => { throw fnError('failed-precondition', 'Manual review required for operation x'); });
    const sent = [];
    authObj.sendPasswordResetEmail = async e => sent.push(e);
    const notify = jest.fn();
    expect(await CrmAuth.adminCreateUser(fb, params, notify)).toBe('failed');
    expect(notify.mock.calls[0][0]).toMatch(/revisión manual/);
    expect(sent).toHaveLength(0);
  });
});

describe('wiring in app_core.js and index.html (static checks)', () => {
  const root = path.join(__dirname, '..', '..');
  const appCore = fs.readFileSync(path.join(root, 'app_core.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  test('SEC-03: legacy password comparison in browser is decommissioned', () => {
    const divert = appCore.indexOf('if (user.authUid) return processFirebaseLogin(user, pass);');
    expect(divert).toBeGreaterThan(-1);
    expect(appCore).not.toContain('user.password !== pass');
  });

  test('Firebase-linked users never get a password written to Firestore by the reset action', () => {
    const fn = appCore.slice(appCore.indexOf('function resetUserPassword'), appCore.indexOf('function toggleUserStatus'));
    expect(fn).toContain('target.authUid');
    expect(fn).toContain('sendPasswordSetupEmail');
    expect(fn).not.toContain('.password');
    expect(fn).not.toContain('saveUserToDB');
  });

  test('new-user creation passes the CRM environment suffix to the function path', () => {
    expect(appCore).toContain('CrmAuth.adminCreateUser(firebase, { nombre, email, role, dbSuffix: DB_SUFFIX }, alert)');
  });

  test('SEC-03: attachDataListeners never listens to users_prod; all roles subscribe to userDirectory_prod', () => {
    expect(appCore).not.toMatch(/collection\(\s*(`users\$\{DB_SUFFIX\}`|'users_prod'|"users_prod")\s*\)\.onSnapshot/);
    const attachFn = appCore.slice(appCore.indexOf('function attachDataListeners'), appCore.indexOf('function applyRolePermissions'));
    expect(attachFn).toContain('db.collection(`userDirectory${DB_SUFFIX}`).onSnapshot');
    expect(attachFn).not.toContain('db.collection(`users${DB_SUFFIX}`).onSnapshot');
  });

  test('SEC-03: manager administrative users view uses listUsersAdmin callable rather than Firestore listener', () => {
    expect(appCore).toContain('CrmAuth.listUsersViaFunction(firebase, { dbSuffix: DB_SUFFIX })');
    expect(appCore).toContain('function fetchAdminUsers');
  });

  test('scripts are loaded in dependency order', () => {
    const iAuth = indexHtml.indexOf('firebase-auth-compat.js');
    const iFn = indexHtml.indexOf('firebase-functions-compat.js');
    const iCrm = indexHtml.indexOf('crm_auth.js');
    const iCore = indexHtml.indexOf('app_core.js');
    expect(iAuth).toBeGreaterThan(-1);
    expect(iFn).toBeGreaterThan(-1);
    expect(iCrm).toBeGreaterThan(Math.max(iAuth, iFn));
    expect(iCore).toBeGreaterThan(iCrm);
  });
});

describe('CrmAuth.listUsersViaFunction (SEC-03 admin user listing)', () => {
  test('invokes listUsersAdmin callable and returns safe user projections without password', async () => {
    const mockUsers = [
      { id: '1', nombre: 'Admin', email: 'admin@x.com', role: 'manager', activo: true, authUid: 'uid1' },
      { id: '2', nombre: 'Vendedor', email: 'vend@x.com', role: 'vendedor', activo: true, authUid: null }
    ];
    const { fb, calls } = managerFb(() => ({ data: { users: mockUsers } }));
    const result = await CrmAuth.listUsersViaFunction(fb, { dbSuffix: '_local' });
    expect(calls.callable).toEqual([{ name: 'listUsersAdmin', payload: { dbSuffix: '_local' } }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: '1', nombre: 'Admin', email: 'admin@x.com', role: 'manager', activo: true, authUid: 'uid1' });
    expect(result.every(u => u.password === undefined)).toBe(true);
  });

  test('fails closed if functions SDK is unavailable', async () => {
    await expect(CrmAuth.listUsersViaFunction({}, { dbSuffix: '_local' })).rejects.toThrow('functions-unavailable');
  });
});

describe('SEC-03: attachDataListeners runtime verification', () => {
  const root = path.join(__dirname, '..', '..');
  const appCore = fs.readFileSync(path.join(root, 'app_core.js'), 'utf8');

  test('manager listener receives userDirectory docs which omit password completely', () => {
    const listenerBlock = appCore.slice(appCore.indexOf('// 2. User directory listener'), appCore.indexOf('// 3. Clients listener'));
    const subscribedCollections = [];
    let snapshotCallback = null;
    let localUsers = [];
    const mockDb = {
      collection: (name) => {
        subscribedCollections.push(name);
        return {
          onSnapshot: (cb) => {
            snapshotCallback = cb;
            return () => {};
          }
        };
      }
    };
    const activeUnsubscribers = [];
    const checkInitialLoad = () => {};
    const currentUser = { id: 'mgr1', role: 'manager' };

    const runListener = new Function('role', 'userId', 'db', 'DB_SUFFIX', 'users', 'activeUnsubscribers', 'checkInitialLoad', 'currentUser', `
      ${listenerBlock}
      return { getUsers: () => users, getUnsubs: () => activeUnsubscribers };
    `);

    const env = runListener('manager', 'mgr1', mockDb, '_prod', localUsers, activeUnsubscribers, checkInitialLoad, currentUser);

    expect(subscribedCollections).toContain('userDirectory_prod');
    expect(subscribedCollections).not.toContain('users_prod');

    const mockSnap = {
      docs: [
        { data: () => ({ id: 'u1', nombre: 'Carlos', role: 'vendedor', activo: true }) },
        { data: () => ({ id: 'u2', nombre: 'Ana', role: 'gestor', activo: true }) }
      ]
    };
    snapshotCallback(mockSnap);

    const receivedUsers = env.getUsers();
    expect(receivedUsers).toHaveLength(2);
    receivedUsers.forEach(u => {
      expect(u.password).toBeUndefined();
    });
  });
});
