// functions/emulator-tests/createUserAdmin.e2e.emu.js
// END-TO-END against the REAL emulators (Auth 9099, Firestore 8080, Functions 5001, project
// demo-ductsal-local). No mocks of Firebase. Run with:
//   npx jest -c jest.emulator.config.js --runInBand
// Passwords/tokens are random, used only for emulator accounts, and never printed.
//
// Two layers are exercised:
//  A. the callable protocol over HTTP (what the Firebase SDK sends) against createUserAdmin;
//  B. the REAL crm_auth.js and the REAL saveUser from app_core.js, driven through a REST stand-in for
//     the Firebase namespace (the JS SDK is not installed). This is NOT the browser SDK.

const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const CrmAuth = require('../../crm_auth.js');

const SUFFIX = '_local';
const USERS = 'users_local';
const tag = H.randomTag();
const emailA = `vendedor.${tag}@ductsal-test.invalid`;        // created through the raw callable
const emailB = `vendedor.app.${tag}@ductsal-test.invalid`;    // created through crm_auth.adminCreateUser
const mgrPassword = H.randomSecret();                           // emulator-only reset of the seeded manager
const state = {};

const byEmail = (list, email) => list.filter(u => String(u.email || '').toLowerCase() === email.toLowerCase());
const profilesByEmail = async (email) => (await H.listDocs(USERS)).filter(d => String(d.data.email || '').toLowerCase() === email.toLowerCase());

beforeAll(async () => {
  await H.assertEmulatorsUp();
  // The seeded manager must exist (Auth account with the manager claim + linked profile).
  const mgr = (await H.listAuthUsers()).find(u => u.uid === H.SEED.uid);
  if (!mgr || mgr.claims.manager !== true) throw new Error('Seeded test manager missing: run scripts/seedEmulatorManager.js against the emulators first');
  const profile = await H.getDoc(USERS, H.SEED.profileId);
  if (!profile || profile.data.authUid !== H.SEED.uid) throw new Error('Seeded manager profile missing in users_local');
  // The seed password was random and never shown: set a new one on the EMULATOR account only.
  await H.adminSetPassword(H.SEED.uid, mgrPassword);
  state.manager = await H.signIn(H.SEED.email, mgrPassword);
  state.before = { auth: (await H.listAuthUsers()).length, profiles: (await H.listDocs(USERS)).length };
});

describe('A. createUserAdmin over the callable protocol (real emulators)', () => {
  test('the manager ID token carries the manager claim (no secrets printed)', () => {
    const claims = H.decodeClaims(state.manager.idToken);
    expect(claims.manager).toBe(true);
    expect(claims.user_id || claims.sub).toBe(H.SEED.uid);
  });

  test('creates one vendedor; Auth and Firestore agree', async () => {
    state.opId = 'op-' + tag + '-a';
    state.payload = { email: emailA, nombre: 'Vendedor Ficticio ' + tag, role: 'vendedor', opId: state.opId, dbSuffix: SUFFIX };
    const r = await H.callFunction('createUserAdmin', state.payload, state.manager.idToken);
    expect(r.error).toBeUndefined();
    expect(r.httpStatus).toBe(200);
    expect(r.result).toEqual({ uid: expect.any(String), id: expect.any(String) });
    state.created = r.result;

    // Auth, queried directly: exactly one account with that email, same uid, not a manager.
    const accounts = byEmail(await H.listAuthUsers(), emailA);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].uid).toBe(state.created.uid);
    expect(accounts[0].claims.manager).not.toBe(true);
    expect(accounts[0].disabled).toBe(false);

    // Firestore, queried directly: exactly one profile, linked by authUid, distinct commercial id.
    const profiles = await profilesByEmail(emailA);
    expect(profiles).toHaveLength(1);
    const p = profiles[0].data;
    expect(profiles[0].id).toBe(state.created.id);
    expect(p.id).toBe(state.created.id);
    expect(p.authUid).toBe(state.created.uid);
    expect(p.id).not.toBe(p.authUid);
    expect(p.role).toBe('vendedor');
    expect(p.activo).toBe(true);
    expect(Object.keys(p).some(k => /pass/i.test(k))).toBe(false);
    // The manager profile is untouched.
    expect((await H.getDoc(USERS, H.SEED.profileId)).data.role).toBe('manager');
  });

  test('no password field exists anywhere in Firestore (all collections, all documents)', async () => {
    expect(await H.findFieldAnywhere(/pass/i)).toEqual([]);
  });

  test('replaying the same opId and payload is idempotent', async () => {
    const r = await H.callFunction('createUserAdmin', state.payload, state.manager.idToken);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ uid: state.created.uid, id: state.created.id });
    expect(r.result.message).toMatch(/already completed/i);
    expect(byEmail(await H.listAuthUsers(), emailA)).toHaveLength(1);
    expect(await profilesByEmail(emailA)).toHaveLength(1);
  });

  test('the same opId with a different payload is rejected and creates nothing', async () => {
    const r = await H.callFunction('createUserAdmin', { ...state.payload, email: `otro.${tag}@ductsal-test.invalid` }, state.manager.idToken);
    expect(r.error && r.error.status).toBe('ALREADY_EXISTS');
    expect(byEmail(await H.listAuthUsers(), `otro.${tag}@ductsal-test.invalid`)).toHaveLength(0);
  });

  test('a duplicate email with different casing does not create another account or profile', async () => {
    const r = await H.callFunction('createUserAdmin',
      { ...state.payload, email: emailA.toUpperCase(), opId: 'op-' + tag + '-dup' }, state.manager.idToken);
    // Either refused as a duplicate, or normalised to the same operation result: never a 2nd account.
    expect(byEmail(await H.listAuthUsers(), emailA)).toHaveLength(1);
    expect(await profilesByEmail(emailA)).toHaveLength(1);
    expect(r.error ? r.error.status : 'OK').toBe('ALREADY_EXISTS');
  });

  test('a user WITHOUT the manager claim gets PERMISSION_DENIED and nothing is created', async () => {
    const plainEmail = `sinclaim.${tag}@ductsal-test.invalid`;
    const plain = await H.signUp(plainEmail, H.randomSecret());
    expect(H.decodeClaims(plain.idToken).manager).not.toBe(true);
    const victim = `victima.${tag}@ductsal-test.invalid`;
    const r = await H.callFunction('createUserAdmin',
      { email: victim, nombre: 'No Debe Crearse', role: 'vendedor', opId: 'op-' + tag + '-nm', dbSuffix: SUFFIX }, plain.idToken);
    expect(r.error && r.error.status).toBe('PERMISSION_DENIED');
    expect(byEmail(await H.listAuthUsers(), victim)).toHaveLength(0);
    expect(await profilesByEmail(victim)).toHaveLength(0);
  });

  test('a request without any token gets UNAUTHENTICATED', async () => {
    const r = await H.callFunction('createUserAdmin',
      { email: `anon.${tag}@ductsal-test.invalid`, nombre: 'Anon', role: 'vendedor', opId: 'op-' + tag + '-anon', dbSuffix: SUFFIX }, null);
    expect(r.error && r.error.status).toBe('UNAUTHENTICATED');
    expect(byEmail(await H.listAuthUsers(), `anon.${tag}@ductsal-test.invalid`)).toHaveLength(0);
  });

  test('a manager cannot create another manager through the function', async () => {
    const r = await H.callFunction('createUserAdmin',
      { email: `mgr2.${tag}@ductsal-test.invalid`, nombre: 'Otro Gerente', role: 'manager', opId: 'op-' + tag + '-m2', dbSuffix: SUFFIX }, state.manager.idToken);
    expect(r.error && r.error.status).toBe('PERMISSION_DENIED');
    expect(byEmail(await H.listAuthUsers(), `mgr2.${tag}@ductsal-test.invalid`)).toHaveLength(0);
  });
});

describe('B. password setup, login and logout with the real crm_auth.js (REST stand-in for the SDK)', () => {
  const mk = () => H.makeRestFirebase();

  test('the manager session created through the shim is recognised as manager by crm_auth', async () => {
    state.fbMgr = mk();
    const login = await CrmAuth.loginWithFirebase(state.fbMgr.fb, { email: H.SEED.email, authUid: H.SEED.uid }, mgrPassword);
    expect(login).toEqual({ ok: true });
    expect(await CrmAuth.hasManagerSession(state.fbMgr.fb)).toBe(true);
  });

  test('adminCreateUser creates a vendedor and reports the password-setup step honestly', async () => {
    const messages = [];
    const outcome = await CrmAuth.adminCreateUser(state.fbMgr.fb,
      { nombre: 'Vendedor App ' + tag, email: emailB.toUpperCase(), role: 'vendedor', dbSuffix: SUFFIX }, m => messages.push(m));
    expect(outcome).toBe('created');
    // NOTE: the UI text says an email "was sent". In the emulator NO email leaves the machine: the
    // code was only generated and is read below through the emulator REST API.
    expect(messages.join(' ')).toMatch(/Usuario creado/);

    expect(byEmail(await H.listAuthUsers(), emailB)).toHaveLength(1);
    const profiles = await profilesByEmail(emailB);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].data.email).toBe(emailB); // normalised to lower case
    expect(profiles[0].data.authUid).toBeTruthy();
    expect(profiles[0].data.role).toBe('vendedor');
    expect(Object.keys(profiles[0].data).some(k => /pass/i.test(k))).toBe(false);
    state.profileB = profiles[0].data;
  });

  test('login is impossible before the password is set; the emulator holds the reset code (no email delivered)', async () => {
    const fbV = mk();
    const early = await CrmAuth.loginWithFirebase(fbV.fb, state.profileB, H.randomSecret());
    expect(early.ok).toBe(false);
    const codes = (await H.listOobCodes()).filter(c => c.email === emailB && c.requestType === 'PASSWORD_RESET');
    expect(codes.length).toBeGreaterThan(0);
    state.oobCode = codes[codes.length - 1].oobCode;
  });

  test('completing the password-reset action sets the password; login works and is linked by authUid', async () => {
    const vendedorPassword = H.randomSecret();
    await H.completePasswordReset(state.oobCode, vendedorPassword);

    state.fbV = mk();
    const login = await CrmAuth.loginWithFirebase(state.fbV.fb, state.profileB, vendedorPassword);
    expect(login).toEqual({ ok: true });

    // The CRM's own lookup (what processLogin uses) over the real Firestore documents.
    const users = (await H.listDocs(USERS)).map(d => d.data);
    const found = CrmAuth.findLoginUser(users, emailB.toUpperCase());
    expect(found).toBeTruthy();
    expect(found.id).toBe(state.profileB.id);
    expect(found.authUid).toBe(state.fbV.fb.auth().currentUser.uid);
    expect(found.role).toBe('vendedor');

    // A vendedor is not a manager session and cannot create users.
    expect(await CrmAuth.hasManagerSession(state.fbV.fb)).toBe(false);
    const messages = [];
    expect(await CrmAuth.adminCreateUser(state.fbV.fb,
      { nombre: 'X', email: `x.${tag}@ductsal-test.invalid`, role: 'vendedor', dbSuffix: SUFFIX }, m => messages.push(m))).toBe('unavailable');
    expect(byEmail(await H.listAuthUsers(), `x.${tag}@ductsal-test.invalid`)).toHaveLength(0);

    // The reset code cannot be reused.
    await expect(H.completePasswordReset(state.oobCode, H.randomSecret())).rejects.toThrow();
  });

  test('a wrong password is rejected and leaves no session', async () => {
    const fb = mk();
    expect((await CrmAuth.loginWithFirebase(fb.fb, state.profileB, H.randomSecret())).ok).toBe(false);
    expect(fb.hasSession()).toBe(false);
  });

  test('sign-out clears the session', async () => {
    expect(state.fbV.hasSession()).toBe(true);
    await CrmAuth.signOut(state.fbV.fb);
    expect(state.fbV.hasSession()).toBe(false);
    expect(state.fbV.fb.auth().currentUser).toBeNull();
  });

  test('uid mismatch: a valid Auth login for a different profile is refused and signed out', async () => {
    // The password for the vendedor was set above; reuse a fresh reset to sign in as them with a profile
    // that points to another uid.
    await H.sendOobCode(emailB);
    const code = (await H.listOobCodes()).filter(c => c.email === emailB).pop().oobCode;
    const pw = H.randomSecret();
    await H.completePasswordReset(code, pw);
    const fb = mk();
    const r = await CrmAuth.loginWithFirebase(fb.fb, { email: emailB, authUid: 'someone-else' }, pw);
    expect(r).toEqual({ ok: false, reason: 'uid-mismatch' });
    expect(fb.hasSession()).toBe(false);
  });
});

describe('C. A Cloud Function failure never triggers the legacy creation nor stores passwords', () => {
  const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
  const between = (from, to) => {
    const a = appCore.indexOf(from);
    const b = appCore.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error('markers not found: ' + from);
    return appCore.slice(a, b);
  };
  const makeSaveUser = (fb, form, users) => {
    const alerts = [];
    const spies = { saveUserToDB: jest.fn(), closeModal: jest.fn(), renderUsersTable: jest.fn() };
    const els = { 'user-id-edit': { value: '' }, 'usr-nombre': { value: form.nombre }, 'usr-email': { value: form.email }, 'usr-rol': { value: form.role } };
    const src = between('let userSaveInFlight', 'function renderUsersTable') + '\nreturn saveUser;';
    const saveUser = new Function('document', 'users', 'CrmAuth', 'firebase', 'DB_SUFFIX', 'alert', 'saveUserToDB', 'closeModal', 'renderUsersTable', src)(
      { getElementById: id => els[id] }, users, CrmAuth, fb, SUFFIX, m => alerts.push(m), spies.saveUserToDB, spies.closeModal, spies.renderUsersTable);
    return { saveUser, alerts, spies };
  };
  const submit = { preventDefault() {} };

  test('the REAL function rejects the request (invalid email): saveUser stops, no profile, no password, no legacy write', async () => {
    const before = { auth: (await H.listAuthUsers()).length, profiles: (await H.listDocs(USERS)).length };
    const fb = H.makeRestFirebase();
    await CrmAuth.loginWithFirebase(fb.fb, { email: H.SEED.email, authUid: H.SEED.uid }, mgrPassword);
    const { saveUser, alerts, spies } = makeSaveUser(fb.fb, { nombre: 'Fallo Esperado', email: `no-es-un-correo-${tag}`, role: 'vendedor' }, []);
    await saveUser(submit);
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(spies.closeModal).not.toHaveBeenCalled();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.join(' ')).not.toMatch(/Usuario creado/);
    expect((await H.listAuthUsers()).length).toBe(before.auth);
    expect((await H.listDocs(USERS)).length).toBe(before.profiles);
    expect(await H.findFieldAnywhere(/pass/i)).toEqual([]);
  });

  test('an unreachable Functions endpoint behaves the same way (uncertain failure, nothing written)', async () => {
    const before = { auth: (await H.listAuthUsers()).length, profiles: (await H.listDocs(USERS)).length };
    const fb = H.makeRestFirebase();
    await CrmAuth.loginWithFirebase(fb.fb, { email: H.SEED.email, authUid: H.SEED.uid }, mgrPassword);
    const realFns = fb.fb.functions;
    fb.fb.functions = () => ({ httpsCallable: () => async () => { throw Object.assign(new Error('network down'), { code: 'functions/unavailable' }); } });
    const { saveUser, alerts, spies } = makeSaveUser(fb.fb, { nombre: 'Sin Red', email: `sinred.${tag}@ductsal-test.invalid`, role: 'vendedor' }, []);
    await saveUser(submit);
    fb.fb.functions = realFns;
    expect(spies.saveUserToDB).not.toHaveBeenCalled();
    expect(alerts[0]).toMatch(/No se pudo confirmar la creación/);
    expect((await H.listAuthUsers()).length).toBe(before.auth);
    expect((await H.listDocs(USERS)).length).toBe(before.profiles);
    expect(await H.findFieldAnywhere(/pass/i)).toEqual([]);
  });
});

describe('D. final state', () => {
  test('exactly two new accounts and two new profiles were created by this run (plus the non-manager probe account)', async () => {
    const auth = await H.listAuthUsers();
    const profiles = await H.listDocs(USERS);
    // +A +B +the sign-up used for the non-manager probe
    expect(auth.length).toBe(state.before.auth + 3);
    expect(profiles.length).toBe(state.before.profiles + 2);
    expect(await H.listCollectionIds()).not.toContain('users_prod');
  });
});
