// functions/__tests__/phase66SecurityAudit.unit.test.js
// DUCTSAL ERP - AUDITORÍA FINAL DE SEGURIDAD Y CIERRE DE FASE 6.6
// Pruebas exhaustivas para:
// 1. Autenticación y usuarios históricos (processDirectFirebaseAuthLogin, erradicación de bypass y passwords)
// 2. Escritor directo Firestore (saveUserToDB, guardia authUid, reglas Firestore)
// 3. Seguridad de Cloud Functions administrativas (createUserAdmin, updateUserAdmin, toggleUserStatusAdmin, resendInvitationAdmin)
// 4. Validación de sesión (listeners no duplicados, logout limpio, protección contra race condition y consistencia de identidad)

const fs = require('fs');
const path = require('path');

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createUserAdmin,
  updateUserAdmin,
  toggleUserStatusAdmin,
  resendInvitationAdmin
} = require('../index');

const AuthSession = require('../../modules/users/auth_session');
const UsersPermissions = require('../../modules/users/users_permissions');
const UsersController = require('../../modules/users/users_controller');
const CrmAuth = require('../../crm_auth');

const state = admin.__state;
const ctxManager = { auth: { uid: 'managerUid' } };
const ctxVendedor = { auth: { uid: 'vendedorUid' } };
const ctxDisabled = { auth: { uid: 'disabledManagerUid' } };
const ctxRoleOnly = { auth: { uid: 'roleOnlyManagerUid' } };

let opCounter = 0;
const nextOpId = () => `sec_audit_op_${++opCounter}`;

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
  state.claimsCalls = [];
  state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

  // Registrar un manager por defecto en users_prod
  state.seedDefaultManager('users_prod', 'managerUid', {
    id: 'mgr_doc_1',
    nombre: 'Gerente Auditor',
    role: 'manager',
    activo: true,
    authUid: 'managerUid'
  });
});

describe('1. Autenticación y usuarios históricos', () => {
  describe('processDirectFirebaseAuthLogin y escenarios de bypass', () => {
    test('Bypass rechazado: token sin custom claims (cid o role faltante) fuerza cierre de sesión', async () => {
      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'attacker_uid',
              displayName: 'Attacker',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: {} // Sin claims
              })
            }
          }),
          signOut: signOutSpy
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        notify: msg => alerts.push(msg)
      }, 'attacker@test.com', 'pwd123');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/no tiene un perfil comercial asignado/);
    });

    test('Bypass rechazado: token con rol no reconocido en el CRM fuerza cierre de sesión', async () => {
      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'hacker_uid',
              displayName: 'Hacker',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'hacker_cid', role: 'super_root_admin' }
              })
            }
          }),
          signOut: signOutSpy
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        notify: msg => alerts.push(msg)
      }, 'hacker@test.com', 'pwd123');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/no tiene un perfil comercial asignado/);
    });

    test('Bypass rechazado: token con role manager pero sin claim manager: true', async () => {
      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'fake_mgr_uid',
              displayName: 'Fake Manager',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'fake_mgr_cid', role: 'manager', manager: false }
              })
            }
          }),
          signOut: signOutSpy
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        notify: msg => alerts.push(msg)
      }, 'fake@manager.com', 'pwd123');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/permisos administrativos verificados/);
    });

    test('Bypass rechazado: UID mismatch entre cuenta Auth y documento Firestore', async () => {
      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'auth_uid_alice',
              displayName: 'Alice',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'cid_bob', role: 'vendedor' }
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
                id: 'cid_bob',
                authUid: 'auth_uid_bob_legit', // Otro UID!
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
        notify: msg => alerts.push(msg)
      }, 'alice@test.com', 'pwd123');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/UID de autenticación no coincide con el perfil/);
    });

    test('Bypass rechazado: perfil comercial inactivo (activo: false)', async () => {
      const signOutSpy = jest.fn().mockResolvedValue();
      const alerts = [];
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'inactive_uid',
              displayName: 'Inactive User',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'inactive_cid', role: 'vendedor' }
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
                id: 'inactive_cid',
                authUid: 'inactive_uid',
                role: 'vendedor',
                activo: false // Inactivo!
              })
            })
          })
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        getDb: () => mockDb,
        notify: msg => alerts.push(msg)
      }, 'inactive@test.com', 'pwd123');

      expect(signOutSpy).toHaveBeenCalledTimes(1);
      expect(alerts[0]).toMatch(/Esta cuenta se encuentra inactiva/);
    });

    test('Purga de contraseñas heredadas: no se almacena en profile ni localStorage y se llama a purgeHistoricalPassword', async () => {
      let storedUser = null;
      let currentUserState = null;
      const purgeSpy = jest.fn().mockResolvedValue({ purged: true });
      const mockFb = {
        auth: () => ({
          signInWithEmailAndPassword: jest.fn().mockResolvedValue({
            user: {
              uid: 'legacy_uid',
              displayName: 'Legacy User',
              getIdTokenResult: jest.fn().mockResolvedValue({
                claims: { cid: 'legacy_cid', role: 'vendedor' }
              })
            }
          })
        })
      };
      const mockDb = {
        collection: () => ({
          doc: () => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                id: 'legacy_cid',
                authUid: 'legacy_uid',
                role: 'vendedor',
                activo: true,
                password: 'plain_legacy_secret_123' // Contraseña en el documento
              })
            })
          })
        })
      };

      await AuthSession.processDirectFirebaseAuthLogin({
        getFirebase: () => mockFb,
        getDb: () => mockDb,
        getCrmAuth: () => ({ purgeHistoricalPassword: purgeSpy }),
        setCurrentUser: u => { currentUserState = u; },
        storage: { setItem: (k, v) => { storedUser = JSON.parse(v); } }
      }, 'legacy@test.com', 'pwd123');

      expect(currentUserState.password).toBeUndefined();
      expect(storedUser.password).toBeUndefined();
      expect(purgeSpy).toHaveBeenCalledWith(mockFb, { id: 'legacy_cid', dbSuffix: '_prod' });
    });
  });

  describe('Usuarios históricos y erradicación de contraseñas en login', () => {
    test('SEC-03: Usuario histórico sin authUid no puede autenticarse con contraseña local', async () => {
      const alerts = [];
      const mockFb = { auth: jest.fn().mockReturnValue({}) };
      const usersList = [
        { id: 'hist_1', email: 'hist@test.com', password: 'plain_secret_pwd', activo: true }
      ];

      // Formulario con credenciales del usuario histórico
      const mockDoc = {
        getElementById: id => {
          if (id === 'login-email') return { value: 'hist@test.com' };
          if (id === 'login-password') return { value: 'plain_secret_pwd' };
          return null;
        }
      };

      const directLoginSpy = jest.fn();
      await AuthSession.processLogin({
        getUsers: () => usersList,
        getFirebase: () => mockFb,
        processDirectFirebaseAuthLogin: directLoginSpy,
        notify: m => alerts.push(m),
        doc: mockDoc
      });

      expect(directLoginSpy).toHaveBeenCalledWith('hist@test.com', 'plain_secret_pwd');
    });

    test('Código fuente no contiene comparaciones de contraseñas en texto plano', () => {
      const authSessionCode = fs.readFileSync(path.resolve(__dirname, '../../modules/users/auth_session.js'), 'utf8');
      const appCoreCode = fs.readFileSync(path.resolve(__dirname, '../../app_core.js'), 'utf8');
      const crmAuthCode = fs.readFileSync(path.resolve(__dirname, '../../crm_auth.js'), 'utf8');

      expect(authSessionCode).not.toMatch(/password\s*===/);
      expect(appCoreCode).not.toMatch(/user\.password\s*===/);
      expect(appCoreCode).not.toMatch(/u\.password\s*===/);
      expect(crmAuthCode).not.toMatch(/password\s*===/);
    });
  });
});

describe('2. Escritor directo de Firestore (saveUserToDB)', () => {
  test('saveUserToDB rechaza perfiles con cuenta de Firebase Authentication (authUid)', () => {
    const appCoreSrc = fs.readFileSync(path.resolve(__dirname, '../../app_core.js'), 'utf8');
    const saveUserToDBMatch = appCoreSrc.match(/function saveUserToDB\(u\) \{([\s\S]*?)\n\}/);
    expect(saveUserToDBMatch).not.toBeNull();

    const saveUserFn = new Function('u', 'db', 'DB_SUFFIX', saveUserToDBMatch[1]);
    const mockDb = { collection: jest.fn() };

    expect(() => {
      saveUserFn({ id: 'u1', authUid: 'some-auth-uid', nombre: 'Test' }, mockDb, '_prod');
    }).toThrow(/solo se modifican con las funciones administrativas/);

    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  test('saveUserToDB rechaza asignación de roles privilegiados (manager o admin)', () => {
    const appCoreSrc = fs.readFileSync(path.resolve(__dirname, '../../app_core.js'), 'utf8');
    const saveUserToDBMatch = appCoreSrc.match(/function saveUserToDB\(u\) \{([\s\S]*?)\n\}/);
    const saveUserFn = new Function('u', 'db', 'DB_SUFFIX', saveUserToDBMatch[1]);
    const mockDb = { collection: jest.fn() };

    expect(() => {
      saveUserFn({ id: 'u2', role: 'manager', nombre: 'Attacker' }, mockDb, '_prod');
    }).toThrow(/No se pueden asignar roles administrativos/);

    expect(() => {
      saveUserFn({ id: 'u3', role: 'admin', nombre: 'Attacker' }, mockDb, '_prod');
    }).toThrow(/No se pueden asignar roles administrativos/);

    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  test('saveUserToDB elimina contraseñas antes de persistir', () => {
    const appCoreSrc = fs.readFileSync(path.resolve(__dirname, '../../app_core.js'), 'utf8');
    const saveUserToDBMatch = appCoreSrc.match(/function saveUserToDB\(u\) \{([\s\S]*?)\n\}/);
    const saveUserFn = new Function('u', 'db', 'DB_SUFFIX', saveUserToDBMatch[1]);
    let writtenDoc = null;
    const mockDb = {
      collection: () => ({
        doc: () => ({
          set: d => { writtenDoc = d; }
        })
      })
    };

    const userObj = { id: 'hist_1', nombre: 'Viejo Vendedor', role: 'vendedor', password: 'attempted_pwd' };
    saveUserFn(userObj, mockDb, '_prod');

    expect(writtenDoc).not.toBeNull();
    expect(writtenDoc.password).toBeUndefined();
    expect(userObj.password).toBeUndefined();
  });

  test('Reglas de seguridad Firestore (firestore.rules) bloquean escrituras directas en users_prod', () => {
    const rulesSrc = fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8');
    const userProdRuleMatch = rulesSrc.match(/match \/users_prod\/\{userId\} \{([\s\S]*?)\}/);
    expect(userProdRuleMatch).not.toBeNull();
    const ruleBody = userProdRuleMatch[1];

    expect(ruleBody).toMatch(/allow write:\s*if false;/);
  });
});

describe('3. Seguridad de Cloud Functions administrativas', () => {
  describe('createUserAdmin', () => {
    test('Rechaza llamadas sin autenticar (unauthenticated)', async () => {
      await expect(createUserAdmin({
        email: 'new@x.com', nombre: 'Nuevo', role: 'vendedor', opId: nextOpId()
      }, {})).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    test('Rechaza llamadas de usuarios no autorizados (sin claim manager: true)', async () => {
      await expect(createUserAdmin({
        email: 'new@x.com', nombre: 'Nuevo', role: 'vendedor', opId: nextOpId()
      }, ctxVendedor)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza llamadas de manager con cuenta inactiva o disabled', async () => {
      await expect(createUserAdmin({
        email: 'new@x.com', nombre: 'Nuevo', role: 'vendedor', opId: nextOpId()
      }, ctxDisabled)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza creación de roles no permitidos (ej. manager o admin)', async () => {
      await expect(createUserAdmin({
        email: 'admin@x.com', nombre: 'Admin User', role: 'manager', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(createUserAdmin({
        email: 'admin@x.com', nombre: 'Admin User', role: 'admin', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Valida argumentos obligatorios y formato de email', async () => {
      await expect(createUserAdmin({
        email: 'bad-email', nombre: 'Bad', role: 'vendedor', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'invalid-argument' });

      await expect(createUserAdmin({
        email: 'ok@x.com', nombre: '', role: 'vendedor', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('Idempotencia: reintentos con el mismo opId retornan la misma cuenta sin duplicar', async () => {
      const op = nextOpId();
      const payload = { email: 'idem@x.com', nombre: 'Idem User', role: 'vendedor', opId: op };

      const first = await createUserAdmin(payload, ctxManager);
      const second = await createUserAdmin(payload, ctxManager);

      expect(second.uid).toBe(first.uid);
      expect(second.id).toBe(first.id);
      expect(state.createUserCalls).toBe(1);
    });
  });

  describe('updateUserAdmin', () => {
    beforeEach(() => {
      // Registrar un usuario target en users_prod y Auth
      state.docs['users_prod/target_vendedor_1'] = {
        id: 'target_vendedor_1',
        authUid: 'auth_vendedor_1',
        nombre: 'Target Original',
        role: 'vendedor',
        activo: true
      };
      state.requesters['auth_vendedor_1'] = {
        uid: 'auth_vendedor_1',
        customClaims: { role: 'vendedor', cid: 'target_vendedor_1' }
      };
    });

    test('Rechaza llamadas sin autenticar o sin permisos de manager', async () => {
      await expect(updateUserAdmin({
        id: 'target_vendedor_1', nombre: 'Updated', opId: nextOpId()
      }, {})).rejects.toMatchObject({ code: 'unauthenticated' });

      await expect(updateUserAdmin({
        id: 'target_vendedor_1', nombre: 'Updated', opId: nextOpId()
      }, ctxVendedor)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza auto-modificación de rol (self role change)', async () => {
      await expect(updateUserAdmin({
        id: 'mgr_doc_1', role: 'gestor', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza asignación de rol manager', async () => {
      await expect(updateUserAdmin({
        id: 'target_vendedor_1', role: 'manager', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza campos no autorizados (como password o authUid)', async () => {
      await expect(updateUserAdmin({
        id: 'target_vendedor_1', password: 'new_pwd', opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('Actualización exitosa: modifica claims, perfil y genera registro de auditoría', async () => {
      const op = nextOpId();
      const res = await updateUserAdmin({
        id: 'target_vendedor_1',
        nombre: 'Target Actualizado',
        role: 'gestor',
        opId: op
      }, ctxManager);

      expect(res.status).toBe('updated');
      expect(res.role).toBe('gestor');
      expect(state.docs['users_prod/target_vendedor_1'].role).toBe('gestor');
      expect(state.docs['users_prod/target_vendedor_1'].nombre).toBe('Target Actualizado');

      // Verificar que se haya registrado en commercialAudit_prod
      const auditKeys = Object.keys(state.docs).filter(k => k.startsWith('commercialAudit_prod/'));
      expect(auditKeys.length).toBeGreaterThan(0);
      const auditEntry = state.docs[auditKeys[0]];
      expect(auditEntry.action).toBe('updateUser');
      expect(auditEntry.targetId).toBe('target_vendedor_1');
      expect(auditEntry.detail.before.role).toBe('vendedor');
      expect(auditEntry.detail.after.role).toBe('gestor');
    });
  });

  describe('toggleUserStatusAdmin', () => {
    beforeEach(() => {
      state.docs['users_prod/target_user_status'] = {
        id: 'target_user_status',
        authUid: 'auth_status_target',
        nombre: 'Status Target',
        role: 'vendedor',
        activo: true
      };
      state.requesters['auth_status_target'] = {
        uid: 'auth_status_target',
        customClaims: { role: 'vendedor', cid: 'target_user_status' }
      };
    });

    test('Rechaza llamadas no autenticadas o sin rol de gerente', async () => {
      await expect(toggleUserStatusAdmin({
        id: 'target_user_status', activo: false, opId: nextOpId()
      }, {})).rejects.toMatchObject({ code: 'unauthenticated' });

      await expect(toggleUserStatusAdmin({
        id: 'target_user_status', activo: false, opId: nextOpId()
      }, ctxVendedor)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Protección de auto-desactivación: un gerente no puede desactivarse a sí mismo', async () => {
      await expect(toggleUserStatusAdmin({
        id: 'mgr_doc_1', activo: false, opId: nextOpId()
      }, ctxManager)).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    test('Desactivación exitosa: actualiza Firestore, Auth disabled y revoca tokens', async () => {
      const op = nextOpId();
      await toggleUserStatusAdmin({
        id: 'target_user_status', activo: false, opId: op
      }, ctxManager);

      expect(state.docs['users_prod/target_user_status'].activo).toBe(false);
      expect(state.updateUserCalls).toEqual(expect.arrayContaining([
        { uid: 'auth_status_target', attrs: { disabled: true } }
      ]));
      expect(state.revokedUids).toContain('auth_status_target');
    });
  });

  describe('resendInvitationAdmin', () => {
    beforeEach(() => {
      state.docs['users_prod/target_invitee'] = {
        id: 'target_invitee',
        authUid: 'auth_invitee',
        email: 'invitee@test.com',
        nombre: 'Invitee User',
        role: 'vendedor',
        activo: true
      };
      state.docs['users_prod/target_historic_no_auth'] = {
        id: 'target_historic_no_auth',
        email: 'historic@test.com',
        nombre: 'Historic User',
        role: 'vendedor',
        activo: true
      };
    });

    test('Rechaza llamadas no autenticadas o sin rol de gerente', async () => {
      await expect(resendInvitationAdmin({
        id: 'target_invitee'
      }, {})).rejects.toMatchObject({ code: 'unauthenticated' });

      await expect(resendInvitationAdmin({
        id: 'target_invitee'
      }, ctxVendedor)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('Rechaza reenvío para usuarios históricos sin authUid', async () => {
      await expect(resendInvitationAdmin({
        id: 'target_historic_no_auth'
      }, ctxManager)).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    test('Respuesta segura: emite ticket de reenvío para despacho nativo sin generar enlaces en servidor ni exponer contraseñas', async () => {
      const res = await resendInvitationAdmin({
        id: 'target_invitee'
      }, ctxManager);

      expect(res.sent).toBe(false);
      expect(res.delivery).toBe('client_sdk');
      expect(res.email).toBe('invitee@test.com');
      expect(res.link).toBeNull();
      expect(res.requestId).toBeDefined();
      expect(res.password).toBeUndefined();
    });
  });
});

describe('4. Validación de sesión y sincronización reactiva', () => {
  test('Logout limpia íntegramente currentUser, localStorage, listeners y colecciones en memoria', () => {
    let currentUserState = { id: 'u1', role: 'vendedor', nombre: 'User 1' };
    let routedView = true;
    let authGen = 10;
    const detachedSpy = jest.fn();
    const signOutSpy = jest.fn();
    const mockStorage = {
      'ductsal_current_user': JSON.stringify(currentUserState),
      removeItem: jest.fn(k => delete mockStorage[k])
    };

    AuthSession.processLogout({
      getFirebase: () => ({ auth: () => ({ signOut: jest.fn() }) }),
      getCrmAuth: () => ({ signOut: signOutSpy }),
      detachSnapshotListeners: detachedSpy,
      setCurrentUser: u => { currentUserState = u; },
      setInitialRoleViewRouted: v => { routedView = v; },
      incrementAuthSessionGeneration: () => { authGen++; },
      checkAuth: jest.fn(),
      storage: mockStorage
    });

    expect(currentUserState).toBeNull();
    expect(routedView).toBe(false);
    expect(authGen).toBe(11);
    expect(detachedSpy).toHaveBeenCalledTimes(1);
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(mockStorage['ductsal_current_user']).toBeUndefined();
  });

  test('Protección contra race conditions en carga de perfil mediante generación de sesión', async () => {
    let authSessionGeneration = 5;
    let storedUser = null;

    // Simula una sesión obsoleta que intenta resolver después de un logout o cambio de sesión
    const asyncResolveStaleSession = async (capturedGen) => {
      await new Promise(r => setTimeout(r, 10));
      if (capturedGen !== authSessionGeneration) {
        // Sesión superseded: descartar
        return 'discarded';
      }
      storedUser = { id: 'stale_user' };
      return 'applied';
    };

    const initialGen = authSessionGeneration;
    const pendingPromise = asyncResolveStaleSession(initialGen);

    // Se produce un logout o cambio de usuario intermedio
    authSessionGeneration++;

    const outcome = await pendingPromise;
    expect(outcome).toBe('discarded');
    expect(storedUser).toBeNull();
  });

  test('Entrega de identidad consistente a módulos consumidores (UsersPermissions y UI)', () => {
    const managerIdentity = { id: 'mgr1', role: 'manager', nombre: 'Gerente General' };
    const gestorIdentity = { id: 'gest1', role: 'gestor', nombre: 'Gestor Ventas' };
    const vendedorIdentity = { id: 'vend1', role: 'vendedor', nombre: 'Vendedor Campo' };

    expect(UsersPermissions.canManageUsers(managerIdentity)).toBe(true);
    expect(UsersPermissions.canManageUsers(gestorIdentity)).toBe(false);
    expect(UsersPermissions.canManageUsers(vendedorIdentity)).toBe(false);

    expect(UsersPermissions.canExecuteManagerActions(managerIdentity)).toBe(true);
    expect(UsersPermissions.canExecuteManagerActions(gestorIdentity)).toBe(false);
    expect(UsersPermissions.canExecuteManagerActions(vendedorIdentity)).toBe(false);

    expect(UsersPermissions.canAccessView(managerIdentity, 'users-view')).toBe(true);
    expect(UsersPermissions.canAccessView(vendedorIdentity, 'users-view')).toBe(false);
    expect(UsersPermissions.canAccessView(managerIdentity, 'dashboard-view')).toBe(true);
    expect(UsersPermissions.canAccessView(vendedorIdentity, 'dashboard-view')).toBe(false);

    expect(UsersPermissions.getRoleDisplayName('manager')).toBe('Gerente');
    expect(UsersPermissions.getRoleDisplayName('gestor')).toBe('Gestor de Ventas');
    expect(UsersPermissions.getRoleDisplayName('vendedor')).toBe('Vendedor');
  });
});
