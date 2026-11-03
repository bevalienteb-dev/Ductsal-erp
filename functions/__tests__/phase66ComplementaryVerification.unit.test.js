// functions/__tests__/phase66ComplementaryVerification.unit.test.js
// DUCTSAL ERP - VERIFICACIÓN FINAL COMPLEMENTARIA DE FASE 6.6
// Pruebas especializadas sobre los 3 puntos de la auditoría complementaria:
// 1. Correspondencia estricta entre custom claim cid y perfil Firestore (prevención de tokens con cid ajeno)
// 2. Matriz y compatibilidad completa de roles (roles comerciales vs roles de fábrica con plantLogin)
// 3. Flujo completo de reenvío de invitaciones (resendInvitationAdmin + users_controller + crm_auth + idempotencia)

const fs = require('fs');
const path = require('path');

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  resendInvitationAdmin
} = require('../index');

const AuthSession = require('../../modules/users/auth_session');
const UsersPermissions = require('../../modules/users/users_permissions');
const UsersController = require('../../modules/users/users_controller');
const CrmAuth = require('../../crm_auth');

const state = admin.__state;
const ctxManager = { auth: { uid: 'managerUid' } };
const ctxVendedor = { auth: { uid: 'vendedorUid' } };

function makeFakeDoc() {
  const elements = {};
  const getOrCreate = id => {
    if (!elements[id]) elements[id] = { id, style: { display: '' }, textContent: '', innerHTML: '' };
    return elements[id];
  };
  return {
    getElementById: getOrCreate,
    querySelector: () => null
  };
}

beforeEach(() => {
  state.docs = {};
  state.allowVirtualManager = true;
  state.unlinkedManager = false;
  state.authUsers = {};
  state.requesters = {};
  state.revokedUids = [];
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

  // Registrar gerente en users_prod
  state.seedDefaultManager('users_prod', 'managerUid', {
    id: 'mgr_doc_1',
    nombre: 'Gerente Auditor',
    role: 'manager',
    activo: true,
    authUid: 'managerUid'
  });
});

describe('1. Correspondencia estricta entre custom claim cid y perfil Firestore', () => {
  test('Token con cid ajeno: loginWithFirebase rechaza cuando claim.cid !== user.id (cid-mismatch)', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'uid-target-user',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'cid-different-victim', role: 'vendedor' } // cid difiere de user.id
            })
          }
        }),
        signOut: signOutSpy
      })
    };

    const targetUser = {
      id: 'cid-target-legit',
      email: 'user@test.com',
      authUid: 'uid-target-user',
      role: 'vendedor',
      activo: true
    };

    const res = await CrmAuth.loginWithFirebase(mockFb, targetUser, 'pwd123');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cid-mismatch');
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(CrmAuth.loginErrorMessage(res.reason)).toMatch(/identificador del perfil no coincide/);
  });

  test('Token con rol ajeno: loginWithFirebase rechaza cuando claim.role !== user.role (role-mismatch)', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'uid-target-user',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'cid-target-legit', role: 'manager', manager: true } // claim manager pero perfil es vendedor
            })
          }
        }),
        signOut: signOutSpy
      })
    };

    const targetUser = {
      id: 'cid-target-legit',
      email: 'user@test.com',
      authUid: 'uid-target-user',
      role: 'vendedor',
      activo: true
    };

    const res = await CrmAuth.loginWithFirebase(mockFb, targetUser, 'pwd123');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('role-mismatch');
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(CrmAuth.loginErrorMessage(res.reason)).toMatch(/rol asignado no coincide/);
  });

  test('Token de manager sin claim manager: true: loginWithFirebase rechaza (permission-denied)', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'uid-mgr',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'cid-mgr', role: 'manager', manager: false }
            })
          }
        }),
        signOut: signOutSpy
      })
    };

    const managerUser = {
      id: 'cid-mgr',
      email: 'mgr@test.com',
      authUid: 'uid-mgr',
      role: 'manager',
      activo: true
    };

    const res = await CrmAuth.loginWithFirebase(mockFb, managerUser, 'pwd123');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('permission-denied');
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });

  test('processDirectFirebaseAuthLogin rechaza cuando no existe perfil en Firestore para el cid del token', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const alerts = [];
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'uid-ghost',
            displayName: 'Ghost User',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'cid-ghost-not-in-db', role: 'vendedor' }
            })
          }
        }),
        signOut: signOutSpy
      })
    };
    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: jest.fn().mockResolvedValue({ exists: false }) // No existe en Firestore!
        })
      })
    };

    await AuthSession.processDirectFirebaseAuthLogin({
      getFirebase: () => mockFb,
      getDb: () => mockDb,
      notify: m => alerts.push(m)
    }, 'ghost@test.com', 'pwd123');

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(alerts[0]).toMatch(/No existe un perfil comercial registrado/);
  });

  test('processDirectFirebaseAuthLogin rechaza cuando sdata.id en Firestore no coincide con el claim cid', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const alerts = [];
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'uid-mismatch-id',
            displayName: 'ID Mismatch',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'cid-token-alpha', role: 'vendedor' }
            })
          }
        }),
        signOut: signOutSpy
      })
    };
    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({
              id: 'cid-doc-beta', // Diferente de cid-token-alpha
              authUid: 'uid-mismatch-id',
              role: 'vendedor',
              activo: true
            })
          })
        })
      })
    };

    await AuthSession.processDirectFirebaseAuthLogin({
      getFirebase: () => mockFb,
      getDb: () => mockDb,
      notify: m => alerts.push(m)
    }, 'mismatch@test.com', 'pwd123');

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(alerts[0]).toMatch(/Inconsistencia de perfil: el identificador no coincide/);
  });

  test('processDirectFirebaseAuthLogin rechaza y desloguea si la base de datos no está disponible', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const alerts = [];
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'valid_uid',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'valid_cid', role: 'vendedor' }
            })
          }
        }),
        signOut: signOutSpy
      })
    };

    await AuthSession.processDirectFirebaseAuthLogin({
      getFirebase: () => mockFb,
      getDb: () => null,
      notify: m => alerts.push(m)
    }, 'valid@test.com', 'pwd123');

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(alerts[0]).toMatch(/Base de datos no disponible/);
  });

  test('processDirectFirebaseAuthLogin rechaza y desloguea si la consulta de Firestore lanza un error (cero fallback bypass)', async () => {
    const signOutSpy = jest.fn().mockResolvedValue();
    const alerts = [];
    const mockFb = {
      auth: () => ({
        signInWithEmailAndPassword: jest.fn().mockResolvedValue({
          user: {
            uid: 'valid_uid',
            getIdTokenResult: jest.fn().mockResolvedValue({
              claims: { cid: 'valid_cid', role: 'vendedor' }
            })
          }
        }),
        signOut: signOutSpy
      })
    };
    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: jest.fn().mockRejectedValue(new Error('Permission denied or network failure'))
        })
      })
    };

    await AuthSession.processDirectFirebaseAuthLogin({
      getFirebase: () => mockFb,
      getDb: () => mockDb,
      notify: m => alerts.push(m)
    }, 'valid@test.com', 'pwd123');

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(alerts[0]).toMatch(/Error al verificar perfil comercial/);
  });
});

describe('2. Compatibilidad completa de roles', () => {
  describe('Roles Comerciales del CRM', () => {
    test('manager: rol comercial válido, acceso total, pipeline, vista inicial dashboard-view, administra usuarios', () => {
      expect(UsersPermissions.isCrmRole('manager')).toBe(true);
      expect(UsersPermissions.isPlantRole('manager')).toBe(false);
      expect(UsersPermissions.getRoleDisplayName('manager')).toBe('Gerente');

      const user = { id: 'm1', role: 'manager' };
      expect(UsersPermissions.canManageUsers(user)).toBe(true);
      expect(UsersPermissions.canExecuteManagerActions(user)).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'dashboard-view')).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'users-view')).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'projects-view')).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'settings-view')).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'list-view')).toBe(true);
      expect(UsersPermissions.canAccessView(user, 'clients-view')).toBe(true);

      let routedView = null;
      let listMode = null;
      UsersPermissions.applyRolePermissions({
        getCurrentUser: () => user,
        setCurrentListMode: m => { listMode = m; },
        getCurrentListMode: () => listMode,
        getInitialRoleViewRouted: () => false,
        setInitialRoleViewRouted: () => {},
        showView: v => { routedView = v; },
        doc: makeFakeDoc()
      });
      expect(listMode).toBe('pipeline');
      expect(routedView).toBe('dashboard-view');
    });

    test('rechazo estricto de roles ficticios como admin (solo 3 roles CRM oficiales: manager, gestor, vendedor)', () => {
      expect(UsersPermissions.isCrmRole('admin')).toBe(false);
      expect(UsersPermissions.isCrmRole('manager')).toBe(true);
      expect(UsersPermissions.isCrmRole('gestor')).toBe(true);
      expect(UsersPermissions.isCrmRole('vendedor')).toBe(true);
      expect(UsersPermissions.CRM_ROLES).toEqual(['manager', 'gestor', 'vendedor']);

      const fakeAdmin = { id: 'a1', role: 'admin' };
      expect(UsersPermissions.canManageUsers(fakeAdmin)).toBe(false);
      expect(UsersPermissions.canExecuteManagerActions(fakeAdmin)).toBe(false);
      expect(UsersPermissions.canAccessView(fakeAdmin, 'dashboard-view')).toBe(false);
      expect(UsersPermissions.canAccessView(fakeAdmin, 'users-view')).toBe(false);
    });

    test('gestor: rol comercial válido, proyectos/agenda, no administra usuarios', () => {
      expect(UsersPermissions.isCrmRole('gestor')).toBe(true);
      expect(UsersPermissions.getRoleDisplayName('gestor')).toBe('Gestor de Ventas');

      const user = { id: 'g1', role: 'gestor' };
      expect(UsersPermissions.canManageUsers(user)).toBe(false);
      expect(UsersPermissions.canExecuteManagerActions(user)).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'dashboard-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'users-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'projects-view')).toBe(true);

      let routedView = null;
      let listMode = null;
      UsersPermissions.applyRolePermissions({
        getCurrentUser: () => user,
        setCurrentListMode: m => { listMode = m; },
        getCurrentListMode: () => listMode,
        getInitialRoleViewRouted: () => false,
        setInitialRoleViewRouted: () => {},
        showView: v => { routedView = v; },
        doc: makeFakeDoc()
      });
      expect(listMode).toBe('agenda');
      expect(routedView).toBe('list-view');
    });

    test('vendedor: rol comercial válido, mis proyectos/agenda, no administra usuarios', () => {
      expect(UsersPermissions.isCrmRole('vendedor')).toBe(true);
      expect(UsersPermissions.getRoleDisplayName('vendedor')).toBe('Vendedor');

      const user = { id: 'v1', role: 'vendedor' };
      expect(UsersPermissions.canManageUsers(user)).toBe(false);
      expect(UsersPermissions.canExecuteManagerActions(user)).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'dashboard-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'users-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'projects-view')).toBe(true);

      let routedView = null;
      let listMode = null;
      UsersPermissions.applyRolePermissions({
        getCurrentUser: () => user,
        setCurrentListMode: m => { listMode = m; },
        getCurrentListMode: () => listMode,
        getInitialRoleViewRouted: () => false,
        setInitialRoleViewRouted: () => {},
        showView: v => { routedView = v; },
        doc: makeFakeDoc()
      });
      expect(listMode).toBe('agenda');
      expect(routedView).toBe('list-view');
    });
  });

  describe('Roles de Fábrica (Planta) y Mínimo Privilegio', () => {
    const plantRoles = [
      'jefe_produccion', 'recepcion', 'dibujante', 'operario',
      'encargado_armado', 'control_calidad', 'despacho'
    ];

    test.each(plantRoles)('Rol de fábrica "%s" está catalogado como plantRole y no como crmRole', (r) => {
      expect(UsersPermissions.isPlantRole(r)).toBe(true);
      expect(UsersPermissions.isCrmRole(r)).toBe(false);
      expect(UsersPermissions.getRoleDisplayName(r)).toBeTruthy();

      const user = { id: `plant_${r}`, role: r };
      expect(UsersPermissions.canManageUsers(user)).toBe(false);
      expect(UsersPermissions.canExecuteManagerActions(user)).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'dashboard-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'users-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'settings-view')).toBe(false);
    });

    test('Roles de fábrica como jefe_produccion o recepcion son rechazados al intentar loguearse en el CRM', async () => {
      const testPlantRoles = ['jefe_produccion', 'recepcion', 'operario'];

      for (const r of testPlantRoles) {
        const signOutSpy = jest.fn().mockResolvedValue();
        const alerts = [];
        const mockFb = {
          auth: () => ({
            signInWithEmailAndPassword: jest.fn().mockResolvedValue({
              user: {
                uid: `uid-${r}`,
                displayName: `User ${r}`,
                getIdTokenResult: jest.fn().mockResolvedValue({
                  claims: { cid: `cid-${r}`, role: r }
                })
              }
            }),
            signOut: signOutSpy
          })
        };

        await AuthSession.processDirectFirebaseAuthLogin({
          getFirebase: () => mockFb,
          notify: m => alerts.push(m)
        }, `${r}@ductsal.com`, 'pwd123');

        expect(signOutSpy).toHaveBeenCalledTimes(1);
        expect(alerts[0]).toMatch(/no tiene un perfil comercial asignado/);
      }
    });
  });

  describe('Roles Desconocidos o No Autorizados', () => {
    const invalidRoles = ['superadmin', 'hacker', 'inventor', 'auditor_externo', 'root', ''];

    test.each(invalidRoles)('Rol inválido "%s" es rechazado en todas las guardias', async (r) => {
      expect(UsersPermissions.isCrmRole(r)).toBe(false);
      expect(UsersPermissions.isPlantRole(r)).toBe(false);

      const user = { id: 'x', role: r };
      expect(UsersPermissions.canManageUsers(user)).toBe(false);
      expect(UsersPermissions.canExecuteManagerActions(user)).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'dashboard-view')).toBe(false);
      expect(UsersPermissions.canAccessView(user, 'users-view')).toBe(false);

      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'bad-uid',
              displayName: 'Bad',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'cid-bad', role: r }
              })
            }
          }),
          signOut: signOutSpy
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        notify: m => alerts.push(m)
      }, 'bad@test.com', 'pwd');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/no tiene un perfil comercial asignado/);
    });
  });
});

describe('3. Flujo completo de reenvío de invitaciones (resendInvitationAdmin)', () => {
  beforeEach(() => {
    state.docs['users_prod/user_active_auth'] = {
      id: 'user_active_auth',
      authUid: 'auth_uid_1',
      email: 'active@ductsal.com',
      nombre: 'Active User',
      role: 'vendedor',
      activo: true
    };
    state.docs['users_prod/user_inactive'] = {
      id: 'user_inactive',
      authUid: 'auth_uid_2',
      email: 'inactive@ductsal.com',
      nombre: 'Inactive User',
      role: 'vendedor',
      activo: false
    };
    state.docs['users_prod/user_no_auth'] = {
      id: 'user_no_auth',
      email: 'noauth@ductsal.com',
      nombre: 'No Auth User',
      role: 'vendedor',
      activo: true
    };
  });

  test('resendInvitationAdmin en backend rechaza cuentas inactivas con failed-precondition', async () => {
    await expect(resendInvitationAdmin({
      id: 'user_inactive'
    }, ctxManager)).rejects.toMatchObject({
      code: 'failed-precondition'
    });
  });

  test('resendInvitationAdmin en backend rechaza usuarios históricos sin authUid con failed-precondition', async () => {
    await expect(resendInvitationAdmin({
      id: 'user_no_auth'
    }, ctxManager)).rejects.toMatchObject({
      code: 'failed-precondition'
    });
  });

  test('resendInvitationAdmin en backend rechaza solicitudes de usuarios no autorizados (vendedor) con permission-denied', async () => {
    await expect(resendInvitationAdmin({
      id: 'user_active_auth'
    }, ctxVendedor)).rejects.toMatchObject({
      code: 'permission-denied'
    });
  });

  test('resendInvitationAdmin respuesta autorizada: sent es false y delivery es client_sdk sin enlaces generados por Admin SDK', async () => {
    const res = await resendInvitationAdmin({
      id: 'user_active_auth'
    }, ctxManager);

    expect(res.sent).toBe(false);
    expect(res.delivery).toBe('client_sdk');
    expect(res.email).toBe('active@ductsal.com');
    expect(res.link).toBeNull();
    expect(res.requestId).toBeDefined();
    expect(res.password).toBeUndefined();
  });

  test('users_controller.resetUserPassword ejecuta resendInvitationViaFunction antes de enviar correo', async () => {
    const sendEmailSpy = jest.fn().mockResolvedValue();
    const backendCallSpy = jest.fn().mockResolvedValue({
      sent: false,
      delivery: 'client',
      email: 'active@ductsal.com'
    });
    const successSpy = jest.fn();

    const usersList = [state.docs['users_prod/user_active_auth']];

    await UsersController.resetUserPassword({
      getUsers: () => usersList,
      getFirebase: () => ({}),
      getCrmAuth: () => ({
        resendInvitationViaFunction: backendCallSpy,
        sendPasswordSetupEmail: sendEmailSpy
      }),
      getCrmUI: () => ({
        confirm: jest.fn().mockResolvedValue(true),
        success: successSpy,
        error: jest.fn()
      })
    }, 'user_active_auth');

    expect(backendCallSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy).toHaveBeenCalledWith(expect.anything(), 'active@ductsal.com');
    expect(successSpy).toHaveBeenCalledWith('Correo de restablecimiento enviado.');
  });

  test('users_controller.resetUserPassword NO envía correo si el backend rechaza la operación', async () => {
    const sendEmailSpy = jest.fn().mockResolvedValue();
    const backendCallSpy = jest.fn().mockRejectedValue(
      Object.assign(new Error('La cuenta se encuentra inactiva'), { code: 'failed-precondition' })
    );
    const errorSpy = jest.fn();

    const usersList = [state.docs['users_prod/user_inactive']];

    await UsersController.resetUserPassword({
      getUsers: () => usersList,
      getFirebase: () => ({}),
      getCrmAuth: () => ({
        resendInvitationViaFunction: backendCallSpy,
        sendPasswordSetupEmail: sendEmailSpy,
        normalizeCode: err => err.code
      }),
      getCrmUI: () => ({
        confirm: jest.fn().mockResolvedValue(true),
        success: jest.fn(),
        error: errorSpy
      })
    }, 'user_inactive');

    expect(backendCallSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy).not.toHaveBeenCalled(); // Bloqueado! No se envía ningún correo
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inactiva'));
  });

  test('Idempotencia de cliente: callIdempotent reutiliza opId mientras la llamada está en vuelo', async () => {
    let callCount = 0;
    const pendingOpIds = [];
    const fakeInvoke = async (opId) => {
      callCount++;
      pendingOpIds.push(opId);
      // Simular retraso
      await new Promise(r => setTimeout(r, 20));
      return { data: { sent: false, delivery: 'client' } };
    };

    const mockFb = {
      functions: () => ({
        httpsCallable: () => fakeInvoke
      })
    };

    // Invocar dos veces en paralelo con el mismo ID
    const [p1, p2] = await Promise.all([
      CrmAuth.resendInvitationViaFunction(mockFb, { id: 'user_active_auth' }),
      CrmAuth.resendInvitationViaFunction(mockFb, { id: 'user_active_auth' })
    ]);

    expect(p1.delivery).toBe('client');
    expect(p2.delivery).toBe('client');
    expect(pendingOpIds[0].opId).toBe(pendingOpIds[1].opId); // Mismo opId reutilizado!
  });
});
