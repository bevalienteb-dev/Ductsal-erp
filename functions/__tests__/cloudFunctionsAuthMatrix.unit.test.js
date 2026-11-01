// functions/__tests__/cloudFunctionsAuthMatrix.unit.test.js
// Validación empírica de la Matriz de Autorización de Cloud Functions
// Comprueba el comportamiento exacto ante:
// - Usuario anónimo (sin context.auth)
// - Vendedor
// - Gestor
// - Manager legítimo
// - Operario de planta
// - Claims falsificados o inconsistentes:
//   * { admin: true } o { role: 'admin' } sin { manager: true }
//   * { manager: true } con perfil Firestore inactivo
//   * { manager: true } con perfil Firestore rol 'vendedor'
//   * { manager: true } sin perfil vinculado en Firestore

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createUserAdmin,
  updateUserAdmin,
  toggleUserStatusAdmin,
  resendInvitationAdmin,
  reconcileUserOp,
  listUsersAdmin,
  deleteClientAdmin,
  resolveProspectEscalationAdmin
} = require('../index');

const state = admin.__state;

describe('Matriz de Autorización de Cloud Functions Administrativas y Sensibles', () => {
  beforeEach(() => {
    state.docs = {};
    state.authUsers = {};
    state.allowVirtualManager = false;
    state.unlinkedManager = false;
    state.requesters = {};
    state.createUserCalls = 0;
    state.createUserArgs = [];
    state.updateUserCalls = [];
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  });

  const setupUser = (uid, { role, activo = true, managerClaim = false, extraClaims = {}, linked = true }) => {
    const cid = `${uid}_profile`;
    const claims = { role, cid, ...(managerClaim ? { manager: true } : {}), ...extraClaims };
    state.requesters[uid] = {
      uid,
      email: `${uid}@ductsal.com.sv`,
      customClaims: claims,
      disabled: !activo
    };
    if (linked) {
      state.docs[`users_prod/${cid}`] = {
        id: cid,
        authUid: uid,
        email: `${uid}@ductsal.com.sv`,
        nombre: `Usuario ${uid}`,
        role,
        activo
      };
    }
    return { auth: { uid, token: claims } };
  };

  // -----------------------------------------------------------------------------------
  // 1. Solicitudes Anónimas
  // -----------------------------------------------------------------------------------
  test('1. Usuario anónimo (sin context.auth) es rechazado con unauthenticated (401)', async () => {
    const anonCtx = null;
    const anonEmptyCtx = { auth: null };

    for (const ctx of [anonCtx, anonEmptyCtx]) {
      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(updateUserAdmin({ id: 'u1', nombre: 'Test', opId: 'op2' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(toggleUserStatusAdmin({ id: 'u1', activo: false, opId: 'op3' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(resendInvitationAdmin({ id: 'u1', opId: 'op4' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(listUsersAdmin({}, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(deleteClientAdmin({ clientId: 'c1' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(resolveProspectEscalationAdmin({ prospectId: 'p1', decision: 'autorizar_continuar', opId: 'op5' }, ctx))
        .rejects.toMatchObject({ code: 'unauthenticated' });
    }
  });

  // -----------------------------------------------------------------------------------
  // 2. Roles Comerciales sin Privilegios Administrativos (Vendedor, Gestor)
  // -----------------------------------------------------------------------------------
  test('2. Vendedor y Gestor son rechazados con permission-denied (403)', async () => {
    const vendedorCtx = setupUser('vnd_pedro', { role: 'vendedor', managerClaim: false });
    const gestorCtx = setupUser('gst_laura', { role: 'gestor', managerClaim: false });

    for (const ctx of [vendedorCtx, gestorCtx]) {
      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(updateUserAdmin({ id: 'u1', nombre: 'Test', opId: 'op2' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(toggleUserStatusAdmin({ id: 'u1', activo: false, opId: 'op3' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(resendInvitationAdmin({ id: 'u1', opId: 'op4' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(listUsersAdmin({}, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(deleteClientAdmin({ clientId: 'c1' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(resolveProspectEscalationAdmin({ prospectId: 'p1', decision: 'autorizar_continuar', opId: 'op5' }, ctx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  // -----------------------------------------------------------------------------------
  // 3. Operario de Planta (sin claims manager ni perfil CRM)
  // -----------------------------------------------------------------------------------
  test('3. Operario de planta es rechazado con permission-denied (403)', async () => {
    const operarioCtx = setupUser('operario_planta_01', { role: 'operario', managerClaim: false, linked: false });

    await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, operarioCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateUserAdmin({ id: 'u1', nombre: 'Test', opId: 'op2' }, operarioCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(deleteClientAdmin({ clientId: 'c1' }, operarioCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(resolveProspectEscalationAdmin({ prospectId: 'p1', decision: 'autorizar_continuar', opId: 'op5' }, operarioCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  // -----------------------------------------------------------------------------------
  // 4. Claims Falsificados o Inconsistentes
  // -----------------------------------------------------------------------------------
  describe('4. Ataques de Suplantación y Claims Falsificados', () => {
    test('4.1 Token con claim falso { admin: true, role: "admin" } sin { manager: true } es rechazado', async () => {
      // Intento de suplantar rol usando nomenclatura de frontend o nombres de claim ajenos al backend
      const fakeAdminCtx = setupUser('attacker_admin', {
        role: 'admin',
        managerClaim: false, // NO posee el claim criptográfico manager: true
        extraClaims: { admin: true, role: 'admin' },
        linked: true
      });

      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, fakeAdminCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
      await expect(updateUserAdmin({ id: 'u1', nombre: 'Test', opId: 'op2' }, fakeAdminCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('4.2 Token con { manager: true } pero perfil en users_prod con role "vendedor" es rechazado', async () => {
      // Caso de inconsistencia: el claim dice manager, pero la base de datos dice vendedor
      const mismatchCtx = setupUser('mismatch_user', {
        role: 'vendedor', // en users_prod tiene rol vendedor
        managerClaim: true,
        linked: true
      });

      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, mismatchCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('4.3 Token con { manager: true } pero perfil en users_prod inactivo (activo: false) es rechazado', async () => {
      // Caso de cuenta desactivada: token no expirado, pero perfil desactivado en Firestore
      const inactiveCtx = setupUser('inactive_mgr', {
        role: 'manager',
        managerClaim: true,
        activo: false,
        linked: true
      });

      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, inactiveCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('4.4 Token con { manager: true } sin perfil vinculado en users_prod es rechazado', async () => {
      // Caso de cuenta huérfana o no vinculada
      const unlinkedCtx = setupUser('unlinked_mgr', {
        role: 'manager',
        managerClaim: true,
        linked: false // Sin documento en users_prod
      });

      await expect(createUserAdmin({ email: 'test@ductsal.com.sv', nombre: 'Test', role: 'vendedor', opId: 'op1' }, unlinkedCtx))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  // -----------------------------------------------------------------------------------
  // 5. Manager Legítimo
  // -----------------------------------------------------------------------------------
  test('5. Manager Legítimo ({ manager: true } + perfil activo role: "manager") es autorizado', async () => {
    const legitMgrCtx = setupUser('legit_mgr', {
      role: 'manager',
      managerClaim: true,
      activo: true,
      linked: true
    });

    const res = await createUserAdmin({
      email: 'nuevo.vendedor@ductsal.com.sv',
      nombre: 'Nuevo Vendedor',
      role: 'vendedor',
      opId: 'op_legit_001'
    }, legitMgrCtx);

    expect(res).toBeDefined();
    expect(res.uid).toBeDefined();
    expect(res.id).toBeDefined();
    expect(state.createUserCalls).toBe(1);
  });
});
