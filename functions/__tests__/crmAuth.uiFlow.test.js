// functions/__tests__/crmAuth.uiFlow.test.js
// Iteration 7: behaviour of the real app_core.js functions (saveUser, toggleUserStatus,
// processLogin) executed in a sandbox with stubbed globals, plus crm_auth.js helpers.
// Nothing here touches Firebase: every Firebase object is an in-memory fake.

const fs = require('fs');
const path = require('path');
const CrmAuth = require('../../crm_auth.js');

const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

// ---------- fakes ----------
const fnError = (code, message = '') => Object.assign(new Error(message), { code: `functions/${code}` });
function makeFb({ claims, callableImpl = () => ({ data: {} }) } = {}) {
  const calls = { callable: [], reset: [], signOut: 0 };
  const authObj = {
    currentUser: claims === undefined ? null : { uid: 'mgr', getIdTokenResult: async () => ({ claims }) },
    onAuthStateChanged: cb => { setTimeout(() => cb(authObj.currentUser), 0); return () => {}; },
    async sendPasswordResetEmail(email) { calls.reset.push(email); },
    async signOut() { calls.signOut += 1; }
  };
  const fb = {
    auth: () => authObj,
    functions: () => ({ httpsCallable: name => async payload => { calls.callable.push({ name, payload }); return callableImpl(name, payload); } })
  };
  return { fb, calls };
}

function makeSaveUser({ fb, users = [], form }) {
  const alerts = [];
  const spies = { saveUserToDB: jest.fn(), closeModal: jest.fn(), renderUsersTable: jest.fn() };
  const els = {
    'user-id-edit': { value: form.id || '' },
    'usr-nombre': { value: form.nombre },
    'usr-email': { value: form.email },
    'usr-rol': { value: form.role }
  };
  const document = { getElementById: id => els[id] };
  const src = between('let userSaveInFlight', 'function renderUsersTable') + '\nreturn saveUser;';
  const saveUser = new Function('document', 'users', 'CrmAuth', 'firebase', 'DB_SUFFIX', 'alert', 'saveUserToDB', 'closeModal', 'renderUsersTable', src)(
    document, users, CrmAuth, fb, '_local', m => alerts.push(m), spies.saveUserToDB, spies.closeModal, spies.renderUsersTable
  );
  return { saveUser, alerts, spies };
}

const submit = { preventDefault() {} };

describe('saveUser has no insecure fallback', () => {
  const form = { nombre: 'Nuevo', email: 'Nuevo@X.com', role: 'vendedor' };

  test('without a verified manager session nothing is written and the user is told why', async () => {
    const { fb, calls } = makeFb(); // no Firebase session
    const { saveUser, alerts, spies } = makeSaveUser({ fb, form });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(spies.closeModal).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/No se creó el usuario/);
  });

  test.each(['unavailable', 'permission-denied', 'unauthenticated', 'invalid-argument', 'internal', 'failed-precondition'])(
    'function error %s never falls back to the legacy Firestore creation', async code => {
      const { fb } = makeFb({ claims: { manager: true }, callableImpl: () => { throw fnError(code, 'x'); } });
      const { saveUser, alerts, spies } = makeSaveUser({ fb, form });
      await saveUser(submit);
      expect(spies.saveUserToDB).not.toHaveBeenCalled();
      expect(spies.closeModal).not.toHaveBeenCalled();
      expect(alerts).toHaveLength(1);
    });

  test('a missing CrmAuth module also blocks creation', async () => {
    const alerts = [];
    const spies = { saveUserToDB: jest.fn() };
    const els = { 'user-id-edit': { value: '' }, 'usr-nombre': { value: 'N' }, 'usr-email': { value: 'n@x.com' }, 'usr-rol': { value: 'vendedor' } };
    const src = between('let userSaveInFlight', 'function renderUsersTable') + '\nreturn saveUser;';
    const saveUser = new Function('document', 'users', 'CrmAuth', 'firebase', 'DB_SUFFIX', 'alert', 'saveUserToDB', 'closeModal', 'renderUsersTable', src)(
      { getElementById: id => els[id] }, [], undefined, {}, '_local', m => alerts.push(m), spies.saveUserToDB, jest.fn(), jest.fn());
    await saveUser(submit);
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(alerts[0]).toMatch(/No se creó el usuario/);
  });

  test('success: the function is called with the CRM environment, no profile is written from the browser', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true }, callableImpl: () => ({ data: { uid: 'a', id: '1' } }) });
    const { saveUser, spies } = makeSaveUser({ fb, form });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(1);
    expect(calls.callable[0].payload).toMatchObject({ email: 'nuevo@x.com', nombre: 'Nuevo', role: 'vendedor', dbSuffix: '_local' });
    expect(JSON.stringify(calls.callable[0].payload)).not.toMatch(/password/i);
    expect(calls.reset).toEqual(['nuevo@x.com']); // Firebase's own password-setup email
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(spies.closeModal).toHaveBeenCalledWith('userModal');
  });

  test('a duplicate email differing only in case is refused before any call', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true } });
    const users = [{ id: '1', email: 'nuevo@x.com', activo: true }];
    const { saveUser, alerts } = makeSaveUser({ fb, users, form });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(alerts[0]).toMatch(/ya está en uso/);
  });

  test('a double submit cannot send two requests while one is in flight', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const { fb, calls } = makeFb({ claims: { manager: true }, callableImpl: async () => { await gate; return { data: {} }; } });
    const { saveUser } = makeSaveUser({ fb, form });
    const first = saveUser(submit);
    await new Promise(r => setTimeout(r, 20)); // let the first reach the callable
    await saveUser(submit); // returns immediately: guard is on
    expect(calls.callable).toHaveLength(1);
    release();
    await first;
  });

  test('source: the legacy creation (empty password record + saveUserToDB(nu)) is gone from saveUser', () => {
    const src = between('async function saveUser', 'function renderUsersTable');
    expect(src).not.toMatch(/password\s*:\s*['"`]/);
    expect(src).not.toContain('saveUserToDB(nu)');
  });
});

describe('retries do not duplicate accounts', () => {
  beforeEach(() => CrmAuth._pendingOps.clear());

  test('retry after an uncertain failure reuses the opId, even when typed with different casing', async () => {
    let n = 0;
    const { fb, calls } = makeFb({ claims: { manager: true }, callableImpl: () => { n += 1; if (n === 1) throw fnError('deadline-exceeded'); return { data: { uid: 'a', id: '1' } }; } });
    const notify = jest.fn();
    const p = { nombre: 'Ana', role: 'gestor', dbSuffix: '_local' };
    expect(await CrmAuth.adminCreateUser(fb, { ...p, email: 'Ana@X.com' }, notify)).toBe('failed');
    expect(await CrmAuth.adminCreateUser(fb, { ...p, email: ' ana@x.com ' }, notify)).toBe('created');
    expect(calls.callable[1].payload.opId).toBe(calls.callable[0].payload.opId);
    expect(calls.callable[1].payload.email).toBe('ana@x.com');
  });

  test('manual-review and retryable failed-precondition are told apart', () => {
    expect(CrmAuth.createErrorMessage(fnError('failed-precondition', 'Manual review required for operation x'))).toMatch(/revisión manual/);
    expect(CrmAuth.createErrorMessage(fnError('failed-precondition', 'Operation was interrupted before any Auth account was created; use a new opId'))).toMatch(/Vuelve a intentarlo/);
  });
});

describe('status change of Auth-linked users goes through the function', () => {
  const makeToggle = ({ fb, users, currentUser = { id: 'me' } }) => {
    const alerts = [];
    const spies = { saveUserToDB: jest.fn(), renderUsersTable: jest.fn() };
    const src = between('async function toggleUserStatus', 'const formatCurrency') + '\nreturn toggleUserStatus;';
    const toggle = new Function('users', 'currentUser', 'CrmAuth', 'firebase', 'DB_SUFFIX', 'alert', 'saveUserToDB', 'renderUsersTable', src)(
      users, currentUser, CrmAuth, fb, '_local', m => alerts.push(m), spies.saveUserToDB, spies.renderUsersTable);
    return { toggle, alerts, spies };
  };

  beforeEach(() => CrmAuth._pendingOps.clear());

  test('linked user: explicit desired state is sent and the local state changes only after the server confirms', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true }, callableImpl: () => ({ data: { id: '5', activo: false } }) });
    const users = [{ id: '5', authUid: 'u5', activo: true }];
    const { toggle, spies } = makeToggle({ fb, users });
    await toggle('5');
    expect(calls.callable[0]).toMatchObject({ name: 'toggleUserStatusAdmin', payload: { id: '5', activo: false, dbSuffix: '_local' } });
    expect(users[0].activo).toBe(false);
    expect(spies.saveUserToDB).not.toHaveBeenCalled(); // the server updated the profile
  });

  test('linked user: failure or missing manager session leaves the profile untouched', async () => {
    const users = [{ id: '5', authUid: 'u5', activo: true }];
    const noSession = makeToggle({ fb: makeFb().fb, users });
    await noSession.toggle('5');
    expect(users[0].activo).toBe(true);
    expect(noSession.alerts[0]).toMatch(/No se cambió el estado/);

    const failing = makeToggle({ fb: makeFb({ claims: { manager: true }, callableImpl: () => { throw fnError('permission-denied'); } }).fb, users });
    await failing.toggle('5');
    expect(users[0].activo).toBe(true);
    expect(failing.spies.saveUserToDB).not.toHaveBeenCalled();
  });

  test('historical user (no authUid): legacy behaviour is unchanged', async () => {
    const { fb, calls } = makeFb();
    const users = [{ id: '7', password: 'legacy', activo: true }];
    const { toggle, spies } = makeToggle({ fb, users });
    await toggle('7');
    expect(calls.callable).toHaveLength(0);
    expect(users[0].activo).toBe(false);
    expect(spies.saveUserToDB).toHaveBeenCalledWith(users[0]);
  });

  test('nobody can deactivate themselves', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true } });
    const users = [{ id: 'me', authUid: 'u', activo: true }];
    const { toggle, alerts } = makeToggle({ fb, users });
    await toggle('me');
    expect(calls.callable).toHaveLength(0);
    expect(alerts[0]).toMatch(/No puedes desactivarte/);
  });
});

describe('login: new accounts use Firebase Auth, historical users keep the legacy flow', () => {
  function makeLogin(users) {
    const log = { alerts: [], firebaseLogin: [], checkAuth: 0, setup: false };
    const els = { 'login-email': { value: '' }, 'login-password': { value: '' }, 'login-screen': { style: {} }, 'setup-screen': { style: {} } };
    const store = {};
    const sandbox = new Function('users', 'CrmAuth', 'document', 'alert', 'processFirebaseLogin', 'localStorage', 'checkAuth', 'reRenderApp',
      'let currentUser = null;\n' + between('let pendingSetupUser', 'async function processFirebaseLogin') + '\nreturn processLogin;');
    const processLogin = sandbox(
      users, CrmAuth, { getElementById: id => els[id] }, m => log.alerts.push(m),
      (u, p) => log.firebaseLogin.push({ id: u.id, pass: p }),
      { setItem: (k, v) => { store[k] = v; } }, () => { log.checkAuth += 1; }, () => {});
    return { processLogin, els, log, store };
  }
  const evt = { preventDefault() {} };

  test('a user with authUid is sent to Firebase Authentication (also with other email casing)', () => {
    const users = [{ id: '1', email: 'ana@x.com', authUid: 'u1', activo: true }];
    const { processLogin, els, log } = makeLogin(users);
    els['login-email'].value = 'Ana@X.com';
    els['login-password'].value = 'secret';
    processLogin(evt);
    expect(log.firebaseLogin).toEqual([{ id: '1', pass: 'secret' }]);
    expect(log.alerts).toHaveLength(0);
  });

  test('SEC-03: an unlinked historical user cannot log in and is alerted that linking is required', () => {
    const users = [{ id: '2', email: 'old@x.com', password: 'legacy-pw', activo: true }];
    const { processLogin, els, log, store } = makeLogin(users);
    els['login-email'].value = 'old@x.com';
    els['login-password'].value = 'legacy-pw';
    processLogin(evt);
    expect(log.firebaseLogin).toHaveLength(0);
    expect(log.checkAuth).toBe(0);
    expect(store.ductsal_current_user).toBeUndefined();
    expect(log.alerts[0]).toMatch(/vinculación a Firebase Authentication/);
  });

  test('a historical user with a different email casing does NOT match (legacy exact-match rule preserved)', () => {
    const users = [{ id: '2', email: 'old@x.com', password: 'legacy-pw', activo: true }];
    const { processLogin, els, log } = makeLogin(users);
    els['login-email'].value = 'OLD@x.com';
    els['login-password'].value = 'legacy-pw';
    processLogin(evt);
    expect(log.alerts[0]).toMatch(/no encontrado o inactivo/);
    expect(log.checkAuth).toBe(0);
  });

  test('an inactive Auth-linked profile cannot log in', () => {
    const users = [{ id: '1', email: 'ana@x.com', authUid: 'u1', activo: false }];
    const { processLogin, els, log } = makeLogin(users);
    els['login-email'].value = 'ana@x.com';
    els['login-password'].value = 'secret';
    processLogin(evt);
    expect(log.firebaseLogin).toHaveLength(0);
    expect(log.alerts[0]).toMatch(/inactivo/);
  });

  test('findLoginUser: exact match wins; case-insensitive only for Auth-linked, active profiles', () => {
    const users = [
      { id: '1', email: 'Mixed@x.com', activo: true },
      { id: '2', email: 'mixed@x.com', authUid: 'u2', activo: true }
    ];
    expect(CrmAuth.findLoginUser(users, 'Mixed@x.com').id).toBe('1');
    expect(CrmAuth.findLoginUser(users, 'mixed@x.com').id).toBe('2');
    expect(CrmAuth.findLoginUser(users, 'MIXED@x.com').id).toBe('2');
    expect(CrmAuth.findLoginUser([{ id: '3', email: 'a@x.com', authUid: 'u', activo: false }], 'A@x.com')).toBeNull();
  });

  test('Auth errors for disabled accounts and logout use Firebase Auth', async () => {
    const authObj = { signInWithEmailAndPassword: async () => { throw Object.assign(new Error('x'), { code: 'auth/user-disabled' }); }, signOut: jest.fn(async () => {}) };
    const fb = { auth: () => authObj };
    const res = await CrmAuth.loginWithFirebase(fb, { email: 'a@x.com', authUid: 'u' }, 'pw');
    expect(CrmAuth.loginErrorMessage(res.reason)).toMatch(/deshabilitada/);
    await CrmAuth.signOut(fb);
    expect(authObj.signOut).toHaveBeenCalledTimes(1);
    const logout = between('function processLogout', 'function applyRolePermissions');
    expect(logout).toContain('CrmAuth.signOut(firebase)');
  });
});

describe('editing name / role of Auth-linked users goes through updateUserAdmin', () => {
  const linkedUser = () => ({ id: '5', authUid: 'u5', email: 'a@x.com', nombre: 'Ana', role: 'vendedor', activo: true });
  const form = (over = {}) => ({ id: '5', nombre: 'Ana', email: 'a@x.com', role: 'vendedor', ...over });

  test('role change: ONLY the changed fields + id + environment are sent; local state follows the server answer', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true }, callableImpl: () => ({ data: { status: 'updated', role: 'gestor', sessionsRevoked: true } }) });
    const users = [linkedUser()];
    const { saveUser, spies, alerts } = makeSaveUser({ fb, users, form: form({ role: 'gestor' }) });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(1);
    expect(calls.callable[0].name).toBe('updateUserAdmin');
    expect(calls.callable[0].payload).toEqual(expect.objectContaining({ id: '5', role: 'gestor', dbSuffix: '_local' }));
    expect(Object.keys(calls.callable[0].payload)).not.toContain('nombre');
    expect(JSON.stringify(calls.callable[0].payload)).not.toMatch(/password|authUid|activo|manager/);
    expect(users[0].role).toBe('gestor');
    expect(spies.saveUserToDB).not.toHaveBeenCalled(); // the browser never writes the profile
    expect(spies.closeModal).toHaveBeenCalledWith('userModal');
    expect(alerts).toHaveLength(0);
  });

  test('a rejection leaves the local user untouched, keeps the modal open and explains', async () => {
    const { fb } = makeFb({ claims: { manager: true }, callableImpl: () => { throw fnError('permission-denied', 'You cannot change your own role'); } });
    const users = [linkedUser()];
    const { saveUser, spies, alerts } = makeSaveUser({ fb, users, form: form({ role: 'gestor' }) });
    await saveUser(submit);
    expect(users[0].role).toBe('vendedor');
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(spies.closeModal).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
  });

  test('without a verified manager session nothing is sent and nothing changes', async () => {
    const { fb, calls } = makeFb();
    const users = [linkedUser()];
    const { saveUser, spies, alerts } = makeSaveUser({ fb, users, form: form({ nombre: 'Otra' }) });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(users[0].nombre).toBe('Ana');
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(alerts[0]).toMatch(/sesión de gerente verificada/);
  });

  test('promoting to manager (or any non-vendedor/gestor role) is refused locally and not sent', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true } });
    const users = [linkedUser()];
    for (const role of ['manager', 'operario', 'jefe_produccion']) {
      const { saveUser, alerts } = makeSaveUser({ fb, users, form: form({ role }) });
      await saveUser(submit);
      expect(alerts[0]).toMatch(/Solo se puede asignar el rol de vendedor o gestor/);
    }
    expect(calls.callable).toHaveLength(0);
    expect(users[0].role).toBe('vendedor');
  });

  test('nothing changed: no call; email of a linked user cannot be edited', async () => {
    const { fb, calls } = makeFb({ claims: { manager: true } });
    const users = [linkedUser()];
    const same = makeSaveUser({ fb, users, form: form() });
    await same.saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(same.spies.closeModal).toHaveBeenCalled();
    const mail = makeSaveUser({ fb, users, form: form({ email: 'otro@x.com' }) });
    await mail.saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(mail.alerts[0]).toMatch(/correo/);
  });

  test('a historical user (no authUid) keeps the legacy local edit', async () => {
    const { fb, calls } = makeFb();
    const users = [{ id: '7', email: 'old@x.com', nombre: 'Viejo', role: 'vendedor', password: 'legacy', activo: true }];
    const { saveUser, spies } = makeSaveUser({ fb, users, form: { id: '7', nombre: 'Viejo 2', email: 'old@x.com', role: 'gestor' } });
    await saveUser(submit);
    expect(calls.callable).toHaveLength(0);
    expect(spies.saveUserToDB).toHaveBeenCalledWith(expect.objectContaining({ id: '7', nombre: 'Viejo 2', role: 'gestor' }));
  });

  test('updateErrorMessage words the new server errors (busy lock, abort, manual review)', () => {
    expect(CrmAuth.updateErrorMessage(fnError('already-exists', 'busy'))).toMatch(/otro cambio de rol en curso/);
    expect(CrmAuth.updateErrorMessage(fnError('aborted'))).toMatch(/No se aplicó nada/);
    expect(CrmAuth.updateErrorMessage(fnError('failed-precondition', 'Manual review required for operation x'))).toMatch(/revisión manual/);
    expect(CrmAuth.updateErrorMessage(fnError('unavailable'))).toMatch(/No se pudo confirmar/);
  });
});
