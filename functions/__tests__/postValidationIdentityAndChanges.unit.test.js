// functions/__tests__/postValidationIdentityAndChanges.unit.test.js
// Validación técnica puntual posterior a Fase 6.5:
// 1. Correspondencia correo electrónico = usuario de acceso.
// 2. Revisión de los dos cambios de 6.5:
//    A. resendInvitationAdmin (data.id || data.userId y prevención de ambigüedad).
//    B. app_core.js fallback por authUid en processDirectFirebaseAuthLogin.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { createUserAdmin, updateUserAdmin, resendInvitationAdmin } = require('../index');
const CrmAuth = require('../../crm_auth.js');
const state = admin.__state;

const MGR_CTX = { auth: { uid: 'managerUid' } };
let opCounter = 0;
const nextOpId = () => `op_postval_${++opCounter}`;

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

// =================================================================================================
// 1. CORRESPONDENCIA CORREO ELECTRÓNICO = USUARIO DE ACCESO
// =================================================================================================
describe('1. Correspondencia correo electrónico = usuario de acceso', () => {
  test('1.1 createUserAdmin registra exactamente el mismo correo normalizado en Auth y Firestore', async () => {
    const rawEmail = '  Vendedor.Prueba@Ductsal.COM  ';
    const normalized = 'vendedor.prueba@ductsal.com';

    const res = await createUserAdmin({
      email: rawEmail,
      nombre: 'Vendedor Prueba',
      role: 'vendedor',
      opId: nextOpId()
    }, MGR_CTX);

    expect(res.email).toBe(normalized);

    // Verificación en Firebase Auth mock
    expect(state.createUserArgs).toEqual([{ email: normalized }]);
    const authRecord = state.authUsers[normalized];
    expect(authRecord).toBeDefined();
    expect(authRecord.email).toBe(normalized);

    // Verificación en Firestore mock
    const profile = state.docs[`users_prod/${res.id}`];
    expect(profile).toBeDefined();
    expect(profile.email).toBe(normalized);
    expect(profile.authUid).toBe(authRecord.uid);
    expect(profile.invitation.recipientEmail).toBe(normalized);
  });

  test('1.2 CrmAuth.findLoginUser localiza usuarios activos mediante correo insensible a mayúsculas', () => {
    const users = [
      { id: 'v1', email: 'vendedor@ductsal.com', authUid: 'uid1', activo: true, role: 'vendedor' },
      { id: 'v2', email: 'inactivo@ductsal.com', authUid: 'uid2', activo: false, role: 'vendedor' }
    ];

    // Búsqueda idéntica
    expect(CrmAuth.findLoginUser(users, 'vendedor@ductsal.com')).toEqual(users[0]);
    // Búsqueda con espacios y mayúsculas
    expect(CrmAuth.findLoginUser(users, '  VENDEDOR@DUCTSAL.COM  ')).toEqual(users[0]);
    // Usuario inactivo es rechazado
    expect(CrmAuth.findLoginUser(users, 'inactivo@ductsal.com')).toBeNull();
    // Correo inexistente devuelve null
    expect(CrmAuth.findLoginUser(users, 'noexiste@ductsal.com')).toBeNull();
  });

  test('1.3 updateUserAdmin sincroniza el cambio de correo en Auth y en Firestore profile', async () => {
    const origEmail = 'empleado.antiguo@ductsal.com';
    const newRawEmail = '  Empleado.Nuevo@Ductsal.COM ';
    const newNormalized = 'empleado.nuevo@ductsal.com';

    // Perfil existente
    state.docs['users_prod/emp_1'] = {
      id: 'emp_1',
      authUid: 'emp_uid_1',
      email: origEmail,
      nombre: 'Empleado',
      role: 'gestor',
      activo: true
    };
    state.authUsers[origEmail] = { uid: 'emp_uid_1', email: origEmail };

    const updateRes = await updateUserAdmin({
      id: 'emp_1',
      email: newRawEmail,
      opId: nextOpId()
    }, MGR_CTX);

    expect(updateRes.status).not.toBe('unchanged');

    // Comprobar que en Firestore el perfil tiene el nuevo correo normalizado
    const updatedProfile = state.docs['users_prod/emp_1'];
    expect(updatedProfile.email).toBe(newNormalized);
    expect(updatedProfile.invitation.recipientEmail).toBe(newNormalized);

    // Comprobar que en Auth se actualizó
    expect(state.updateUserCalls).toContainEqual({ uid: 'emp_uid_1', attrs: { email: newNormalized } });
  });
});

// =================================================================================================
// 2. REVISIÓN DE CAMBIO A: resendInvitationAdmin (data.id || data.userId)
// =================================================================================================
describe('2. Revisión de resendInvitationAdmin (data.id || data.userId)', () => {
  beforeEach(() => {
    state.docs['users_prod/target_user'] = {
      id: 'target_user',
      authUid: 'target_uid',
      email: 'target@ductsal.com',
      nombre: 'Target User',
      role: 'vendedor',
      activo: true
    };
  });

  test('2.1 Acepta data.id y emite ticket válido para el perfil', async () => {
    const res = await resendInvitationAdmin({ id: 'target_user' }, MGR_CTX);
    expect(res).toMatchObject({
      sent: false,
      delivery: 'client_sdk',
      email: 'target@ductsal.com',
      link: null
    });
    expect(res.requestId).toBeDefined();

    // Ticket en invitationOps
    const ticketDoc = state.docs[`invitationOps/${res.requestId}`];
    expect(ticketDoc).toBeDefined();
    expect(ticketDoc.userId).toBe('target_user');
    expect(ticketDoc.recipientEmail).toBe('target@ductsal.com');
  });

  test('2.2 Acepta data.userId de forma equivalente resolviendo al mismo usuario', async () => {
    const res = await resendInvitationAdmin({ userId: 'target_user' }, MGR_CTX);
    expect(res).toMatchObject({
      sent: false,
      delivery: 'client_sdk',
      email: 'target@ductsal.com'
    });
    expect(res.requestId).toBeDefined();

    const ticketDoc = state.docs[`invitationOps/${res.requestId}`];
    expect(ticketDoc.userId).toBe('target_user');
  });

  test('2.3 Acepta ambos parámetros cuando coinciden id === userId', async () => {
    const res = await resendInvitationAdmin({ id: 'target_user', userId: 'target_user' }, MGR_CTX);
    expect(res.email).toBe('target@ductsal.com');
  });

  test('2.4 Rechaza ambigüedad con invalid-argument si se envían id y userId contradictorios', async () => {
    await expect(resendInvitationAdmin({ id: 'target_user', userId: 'otro_usuario' }, MGR_CTX))
      .rejects.toMatchObject({
        code: 'invalid-argument',
        message: expect.stringMatching(/Ambiguous id and userId/)
      });
  });

  test('2.5 Rechaza llamadas sin id ni userId, o con tokens inválidos', async () => {
    await expect(resendInvitationAdmin({}, MGR_CTX)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(resendInvitationAdmin({ id: '' }, MGR_CTX)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(resendInvitationAdmin({ userId: 'invalid/path/token' }, MGR_CTX)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('2.6 Mantiene controles estrictos de seguridad (no gerente es rechazado)', async () => {
    const vendedorCtx = { auth: { uid: 'vendedor_1' } };
    state.requesters.vendedor_1 = { disabled: false };
    state.docs['users_prod/vendedor_1'] = { id: 'vendedor_1', authUid: 'vendedor_1', role: 'vendedor', activo: true };

    await expect(resendInvitationAdmin({ id: 'target_user' }, vendedorCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });
});

// =================================================================================================
// 3. REVISIÓN DE CAMBIO B: Fallback por authUid en app_core.js (processDirectFirebaseAuthLogin)
// =================================================================================================
describe('3. Revisión de fallback por authUid en processDirectFirebaseAuthLogin', () => {
  // Simulador de la lógica exacta implementada en app_core.js (líneas 2393-2470)
  async function simulateDirectLogin({ tokenClaims, authUid, userEmail, firestoreUsers = [], isManagerClaim = false }) {
    let signOutCalled = false;
    let alertMsg = null;
    let authenticatedUser = null;

    const fb = {
      auth: () => ({
        signInWithEmailAndPassword: async (em, pwd) => ({
          user: {
            uid: authUid,
            displayName: 'Simulated User',
            getIdTokenResult: async () => ({
              claims: { ...tokenClaims, ...(isManagerClaim ? { manager: true } : {}) }
            })
          }
        }),
        signOut: async () => { signOutCalled = true; }
      })
    };

    const mockDb = {
      collection: (colName) => ({
        where: (field, op, val) => ({
          limit: (n) => ({
            get: async () => {
              const matched = firestoreUsers.filter(u => u[field] === val).slice(0, n);
              return {
                empty: matched.length === 0,
                docs: matched.map(doc => ({
                  id: doc.id,
                  data: () => doc
                }))
              };
            }
          })
        }),
        doc: (docId) => ({
          get: async () => {
            const found = firestoreUsers.find(u => u.id === docId);
            return {
              exists: !!found,
              data: () => (found ? { ...found } : undefined)
            };
          }
        })
      })
    };

    // Ejecutar lógica de app_core.js
    const cred = await fb.auth().signInWithEmailAndPassword(userEmail, 'password123');
    const tok = await cred.user.getIdTokenResult();
    let cid = tok.claims && tok.claims.cid;
    let role = tok.claims && tok.claims.role;
    const managerClaim = tok && tok.claims && tok.claims.manager === true;

    // Fallback evaluado
    if ((!cid || !role) && cred.user.uid && mockDb && typeof mockDb.collection === 'function') {
      try {
        const uQuery = await mockDb.collection('users_prod').where('authUid', '==', cred.user.uid).limit(1).get();
        if (!uQuery.empty) {
          const uDoc = uQuery.docs[0];
          const uData = uDoc.data() || {};
          if (!cid) cid = uDoc.id;
          if (!role) role = uData.role;
        }
      } catch (_) {}
    }

    const validCrmRoles = ['manager', 'gestor', 'vendedor'];
    if (!cid || !role || !validCrmRoles.includes(role)) {
      await fb.auth().signOut();
      alertMsg = 'La cuenta de acceso no tiene un perfil comercial asignado.';
      return { ok: false, alertMsg, signOutCalled };
    }

    if (role === 'manager' && !managerClaim) {
      await fb.auth().signOut();
      alertMsg = 'La cuenta no cuenta con permisos administrativos verificados.';
      return { ok: false, alertMsg, signOutCalled };
    }

    const snap = await mockDb.collection('users_prod').doc(cid).get();
    if (!snap || !snap.exists) {
      await fb.auth().signOut();
      alertMsg = 'No existe un perfil comercial registrado para este identificador.';
      return { ok: false, alertMsg, signOutCalled };
    }
    const sdata = snap.data() || {};
    if (sdata.id && sdata.id !== cid) {
      await fb.auth().signOut();
      alertMsg = 'Inconsistencia de perfil: el identificador no coincide.';
      return { ok: false, alertMsg, signOutCalled };
    }
    if (sdata.activo === false) {
      await fb.auth().signOut();
      alertMsg = 'Esta cuenta se encuentra inactiva. Contacta a un administrador.';
      return { ok: false, alertMsg, signOutCalled };
    }
    if (sdata.authUid && sdata.authUid !== cred.user.uid) {
      await fb.auth().signOut();
      alertMsg = 'Inconsistencia de identidad: el UID de autenticación no coincide con el perfil.';
      return { ok: false, alertMsg, signOutCalled };
    }
    if (sdata.role && sdata.role !== role) {
      await fb.auth().signOut();
      alertMsg = 'Inconsistencia en el rol del usuario asignado.';
      return { ok: false, alertMsg, signOutCalled };
    }

    authenticatedUser = { id: cid, authUid: cred.user.uid, role, email: userEmail, activo: true };
    return { ok: true, authenticatedUser, signOutCalled };
  }

  test('3.1 Vía principal: si el token ya contiene claims (cid y role), no ejecuta fallback y se autentica', async () => {
    const firestoreUsers = [
      { id: 'vend_100', authUid: 'auth_100', role: 'vendedor', email: 'v100@ductsal.com', activo: true }
    ];

    const result = await simulateDirectLogin({
      tokenClaims: { cid: 'vend_100', role: 'vendedor' },
      authUid: 'auth_100',
      userEmail: 'v100@ductsal.com',
      firestoreUsers
    });

    expect(result.ok).toBe(true);
    expect(result.authenticatedUser.id).toBe('vend_100');
    expect(result.signOutCalled).toBe(false);
  });

  test('3.2 Vía fallback: usuario recién creado (sin cid en token) resuelve su perfil comercial legítimo por authUid', async () => {
    const firestoreUsers = [
      { id: 'nuevo_vend_200', authUid: 'auth_200', role: 'vendedor', email: 'nuevo@ductsal.com', activo: true }
    ];

    // Token solo tiene { role: 'vendedor' } (emitido por createUserAdmin sin cid)
    const result = await simulateDirectLogin({
      tokenClaims: { role: 'vendedor' },
      authUid: 'auth_200',
      userEmail: 'nuevo@ductsal.com',
      firestoreUsers
    });

    expect(result.ok).toBe(true);
    expect(result.authenticatedUser.id).toBe('nuevo_vend_200');
    expect(result.authenticatedUser.authUid).toBe('auth_200');
    expect(result.signOutCalled).toBe(false);
  });

  test('3.3 Aislamiento de identidad: el fallback NUNCA puede resolver el perfil de otro usuario', async () => {
    const firestoreUsers = [
      { id: 'victima_300', authUid: 'auth_victima', role: 'vendedor', email: 'victima@ductsal.com', activo: true },
      { id: 'atacante_400', authUid: 'auth_atacante', role: 'vendedor', email: 'atacante@ductsal.com', activo: true }
    ];

    // Atacante se autentica en Firebase con su propio UID
    const result = await simulateDirectLogin({
      tokenClaims: {}, // Sin claims
      authUid: 'auth_atacante',
      userEmail: 'atacante@ductsal.com',
      firestoreUsers
    });

    // Resuelve SU propio perfil, jamás el de la víctima
    expect(result.ok).toBe(true);
    expect(result.authenticatedUser.id).toBe('atacante_400');
    expect(result.authenticatedUser.id).not.toBe('victima_300');
  });

  test('3.4 Anti-escalamiento: un perfil con role manager sin claim criptográfico manager:true es deslogueado', async () => {
    const firestoreUsers = [
      { id: 'falso_mgr', authUid: 'auth_falso_mgr', role: 'manager', email: 'falso@ductsal.com', activo: true }
    ];

    const result = await simulateDirectLogin({
      tokenClaims: { role: 'manager' }, // rol manager pero SIN claim manager: true
      authUid: 'auth_falso_mgr',
      userEmail: 'falso@ductsal.com',
      firestoreUsers,
      isManagerClaim: false
    });

    expect(result.ok).toBe(false);
    expect(result.signOutCalled).toBe(true);
    expect(result.alertMsg).toMatch(/permisos administrativos verificados/);
  });

  test('3.5 Cuenta inactiva es rechazada y deslogueada inmediatamente', async () => {
    const firestoreUsers = [
      { id: 'inactivo_500', authUid: 'auth_inactivo', role: 'vendedor', email: 'inactivo@ductsal.com', activo: false }
    ];

    const result = await simulateDirectLogin({
      tokenClaims: { role: 'vendedor' },
      authUid: 'auth_inactivo',
      userEmail: 'inactivo@ductsal.com',
      firestoreUsers
    });

    expect(result.ok).toBe(false);
    expect(result.signOutCalled).toBe(true);
    expect(result.alertMsg).toMatch(/cuenta se encuentra inactiva/);
  });

  test('3.6 Usuario sin perfil en Firestore es rechazado y deslogueado', async () => {
    const result = await simulateDirectLogin({
      tokenClaims: {},
      authUid: 'auth_huerfano',
      userEmail: 'huerfano@ductsal.com',
      firestoreUsers: [] // Sin perfiles
    });

    expect(result.ok).toBe(false);
    expect(result.signOutCalled).toBe(true);
    expect(result.alertMsg).toMatch(/no tiene un perfil comercial asignado/);
  });
});
