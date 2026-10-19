// functions/__tests__/provisionManagerTraceability.unit.test.js
// Unit tests for SEC-03 Part 2: opId traceability, state transitions, and recovery in provisionManager.js.
// All Firebase services are in-memory fakes; zero interaction with real projects.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { provisionManager } = require('../scripts/provisionManager');
const state = admin.__state;

const CID_BEN = '1000000000001';
const EMAIL_BEN = 'benjamin@ductsal-test.invalid';
const CID_DEN = '1000000000002';
const EMAIL_DEN = 'denys@ductsal-test.invalid';

beforeEach(() => {
  state.docs = {};
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

  // Seed active manager profiles in users_prod (initially unlinked)
  state.docs[`users_prod/${CID_BEN}`] = {
    id: CID_BEN,
    nombre: 'Benjamin Valiente',
    email: EMAIL_BEN,
    role: 'manager',
    activo: true,
    historicalField: 'preserved_ben'
  };
  state.docs[`users_prod/${CID_DEN}`] = {
    id: CID_DEN,
    nombre: 'Denys Gonzalez',
    email: EMAIL_DEN,
    role: 'manager',
    activo: true,
    historicalField: 'preserved_den'
  };
});

describe('SEC-03 Part 2: Traceability & opId Lifecycle in provisionManager', () => {

  // 1. Registro de opId antes de cualquier efecto en Auth o Firestore
  test('1. Registro de opId en estado PENDING antes de cualquier efecto en Auth o Firestore', async () => {
    const opId = 'op_test_pending_before_effects';
    let recordedPendingBeforeAuth = false;

    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return {
        ...a,
        createUser: async (args) => {
          const opRec = state.docs[`userOps/${opId}`];
          if (opRec && (opRec.status === 'pending' || opRec.status === 'authCreating')) {
            recordedPendingBeforeAuth = true;
          }
          return a.createUser(args);
        }
      };
    };

    try {
      const res = await provisionManager(admin, {
        cid: CID_BEN,
        email: EMAIL_BEN,
        opId
      });

      expect(recordedPendingBeforeAuth).toBe(true);
      expect(res.opId).toBe(opId);
      expect(res.uid).toBeDefined();
    } finally {
      admin.auth = authFactory;
    }
  });

  // 2. Flujo completo exitoso y transición de estados
  test('2. Flujo completo exitoso: transiciones registradas y auditoría comercial', async () => {
    const opId = 'op_test_full_lifecycle';

    const res = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      nombre: 'Benjamin Valiente',
      opId
    });

    expect(res).toMatchObject({
      cid: CID_BEN,
      email: EMAIL_BEN,
      role: 'manager',
      createdAuth: true,
      opId
    });

    // Verify final state in userOps
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc).toBeDefined();
    expect(opDoc.status).toBe('succeeded');
    expect(opDoc.action).toBe('provisionManager');
    expect(opDoc.profileId).toBe(CID_BEN);
    expect(opDoc.result.uid).toBe(res.uid);
    expect(opDoc.result.createdAuth).toBe(true);

    // Verify commercialAudit record
    const auditEntries = Object.entries(state.docs).filter(([k]) => k.startsWith('commercialAudit_prod/')).map(([, v]) => v);
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    const audit = auditEntries.find(a => a.opId === opId);
    expect(audit).toBeDefined();
    expect(audit).toMatchObject({
      action: 'provision_manager',
      opId,
      cid: CID_BEN,
      uid: res.uid,
      email: EMAIL_BEN,
      createdAuth: true
    });
  });

  // 3. Fallo de Auth después del registro inicial
  test('3. Fallo de Auth después del registro inicial registra estado ERROR y mantiene rollback', async () => {
    const opId = 'op_test_auth_failure';
    // Inject failure into createUser
    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return {
        ...a,
        createUser: async () => {
          throw new Error('AUTH_SERVICE_UNAVAILABLE');
        }
      };
    };

    try {
      await expect(provisionManager(admin, {
        cid: CID_BEN,
        email: EMAIL_BEN,
        opId
      })).rejects.toThrow('AUTH_SERVICE_UNAVAILABLE');

      const opDoc = state.docs[`userOps/${opId}`];
      expect(opDoc).toBeDefined();
      expect(opDoc.status).toBe('error');
      expect(opDoc.rolledBack).toBe(true);
      expect(opDoc.error).toContain('AUTH_SERVICE_UNAVAILABLE');

      // Firestore profile was never linked
      expect(state.docs[`users_prod/${CID_BEN}`].authUid).toBeUndefined();
    } finally {
      admin.auth = authFactory;
    }
  });

  // 4. Fallo de Firestore después de crear Auth
  test('4. Fallo de Firestore después de crear Auth: elimina cuenta Auth huérfana y registra ERROR', async () => {
    const opId = 'op_test_firestore_failure';
    // Hook Firestore update to throw
    state.hooks.beforeUpdate = path => {
      if (path === `users_prod/${CID_BEN}`) {
        throw new Error('FIRESTORE_WRITE_REJECTED');
      }
    };

    await expect(provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    })).rejects.toThrow('FIRESTORE_WRITE_REJECTED');

    // The newly created Auth account must be deleted in rollback
    expect(state.deletedUids.length).toBe(1);

    // userOps record reflects error and successful rollback
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc).toBeDefined();
    expect(opDoc.status).toBe('error');
    expect(opDoc.rolledBack).toBe(true);
    expect(opDoc.error).toContain('FIRESTORE_WRITE_REJECTED');
    expect(opDoc.uid).toBeNull();
  });

  // 4b. Cuenta con actividad (lastSignInTime) nunca se elimina en rollback
  test('4b. Cuenta recién creada que registra actividad (lastSignInTime) nunca se elimina en rollback y escala a manualReview', async () => {
    const opId = 'op_test_activity_rollback_guard';

    // Hook Firestore update to throw after Auth user is created, but simulate login activity on the new account
    state.hooks.beforeUpdate = path => {
      if (path === `users_prod/${CID_BEN}`) {
        // User signed in concurrently before the error occurred!
        if (state.authUsers[EMAIL_BEN]) {
          state.authUsers[EMAIL_BEN].metadata = {
            creationTime: '2026-10-18T01:00:00Z',
            lastSignInTime: '2026-10-18T01:05:00Z'
          };
        }
        throw new Error('CONCURRENT_FIRESTORE_CRASH');
      }
    };

    await expect(provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    })).rejects.toThrow(/CONCURRENT_FIRESTORE_CRASH/);

    // Rollback MUST NOT delete the account because login activity was detected
    expect(state.deletedUids.length).toBe(0);

    // Operation must be marked for manual review
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc).toBeDefined();
    expect(opDoc.status).toBe('manualReview');
    expect(opDoc.rolledBack).toBe(false);
    expect(opDoc.rollbackErrors[0]).toContain('Security guard');
    expect(opDoc.rollbackErrors[0]).toContain('lastSignInTime');
  });

  // 4c. Si deleteUser falla en rollback (ej. identidad operativa sin permiso delete), inhabilita preventivamente la cuenta y escala a manualReview
  test('4c. Si deleteUser falla en rollback por falta de permisos, inhabilita preventivamente la cuenta huérfana y escala a manualReview', async () => {
    const opId = 'op_test_least_privilege_rollback';

    // Hook Firestore update to throw
    state.hooks.beforeUpdate = path => {
      if (path === `users_prod/${CID_BEN}`) {
        throw new Error('FIRESTORE_WRITE_REJECTED');
      }
    };

    // Simulate deleteUser failing with PERMISSION_DENIED (least-privilege operator lacking firebaseauth.users.delete)
    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return {
        ...a,
        deleteUser: async () => {
          const err = new Error('PERMISSION_DENIED: Caller lacks permission firebaseauth.users.delete');
          err.code = 'permission-denied';
          throw err;
        }
      };
    };

    try {
      await expect(provisionManager(admin, {
        cid: CID_BEN,
        email: EMAIL_BEN,
        opId
      })).rejects.toThrow(/FIRESTORE_WRITE_REJECTED/);

      // Account was not deleted
      expect(state.deletedUids.length).toBe(0);

      // Account was PREVENTIVELY DISABLED via updateUser
      expect(state.updateUserCalls.length).toBeGreaterThanOrEqual(1);
      const disableCall = state.updateUserCalls.find(c => c.attrs && c.attrs.disabled === true);
      expect(disableCall).toBeDefined();

      // Operation is recorded as manualReview
      const opDoc = state.docs[`userOps/${opId}`];
      expect(opDoc).toBeDefined();
      expect(opDoc.status).toBe('manualReview');
      expect(opDoc.rolledBack).toBe(false);
      expect(opDoc.rollbackErrors[0]).toContain('PERMISSION_DENIED');
      expect(opDoc.rollbackErrors[0]).toContain('SUCCEEDED: account was confirmed DISABLED');
    } finally {
      admin.auth = authFactory;
    }
  });

  // 4d. Si deleteUser Y updateUser fallan en rollback, se conservan ambos errores y se alerta que la cuenta sigue activa
  test('4d. Si deleteUser Y updateUser fallan en rollback, se conservan ambos errores y escala a manualReview', async () => {
    const opId = 'op_test_total_rollback_failure';

    state.hooks.beforeUpdate = path => {
      if (path === `users_prod/${CID_BEN}`) {
        throw new Error('FIRESTORE_WRITE_REJECTED');
      }
    };

    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return {
        ...a,
        deleteUser: async () => {
          const err = new Error('PERMISSION_DENIED: Caller lacks permission firebaseauth.users.delete');
          err.code = 'permission-denied';
          throw err;
        },
        updateUser: async () => {
          const err = new Error('NETWORK_TIMEOUT: Could not connect to Auth server');
          err.code = 'auth/network-request-failed';
          throw err;
        }
      };
    };

    try {
      await expect(provisionManager(admin, {
        cid: CID_BEN,
        email: EMAIL_BEN,
        opId
      })).rejects.toThrow(/FIRESTORE_WRITE_REJECTED/);

      // Operation recorded as manualReview
      const opDoc = state.docs[`userOps/${opId}`];
      expect(opDoc).toBeDefined();
      expect(opDoc.status).toBe('manualReview');
      expect(opDoc.rolledBack).toBe(false);

      // Both errors are preserved and classified
      expect(opDoc.rollbackErrors[0]).toContain('PERMISSION_DENIED');
      expect(opDoc.rollbackErrors[0]).toContain('NETWORK_OR_UNAVAILABLE');
      expect(opDoc.rollbackErrors[0]).toContain('CRITICAL');
      expect(opDoc.rollbackErrors[0]).toContain('Account remains ACTIVE');
    } finally {
      admin.auth = authFactory;
    }
  });

  // 4e. Cuenta preexistente: nunca se elimina ni se inhabilita en rollback
  test('4e. Cuenta preexistente: nunca se elimina ni se inhabilita en rollback', async () => {
    const opId = 'op_test_preexisting_never_disabled';
    const preExistingUid = 'preexisting_manager_uid_999';
    state.authUsers[EMAIL_BEN] = {
      uid: preExistingUid,
      email: EMAIL_BEN,
      customClaims: { priorClaim: 'test' }
    };

    // Inject failure during Firestore transaction
    state.hooks.beforeUpdate = path => {
      if (path === `users_prod/${CID_BEN}`) {
        throw new Error('CONCURRENT_TRANSACTION_ABORT');
      }
    };

    await expect(provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    })).rejects.toThrow(/CONCURRENT_TRANSACTION_ABORT/);

    // Pre-existing account MUST NOT be deleted
    expect(state.deletedUids).not.toContain(preExistingUid);

    // Pre-existing account MUST NOT be disabled
    const disabledCall = state.updateUserCalls.find(c => c.uid === preExistingUid && c.attrs && c.attrs.disabled === true);
    expect(disabledCall).toBeUndefined();

    // userOps record reflects createdAuth = false
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc).toBeDefined();
    expect(opDoc.createdAuth).toBe(false);
  });

  // 5. Cuenta Auth preexistente
  test('5. Cuenta Auth preexistente: no se atribuye su creación y NUNCA se elimina en rollback', async () => {
    const opId = 'op_test_preexisting_auth';
    const preExistingUid = 'preexisting_auth_uid_101';
    state.authUsers[EMAIL_BEN] = {
      uid: preExistingUid,
      email: EMAIL_BEN,
      customClaims: {}
    };

    // First: success with pre-existing account
    const res = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    expect(res.uid).toBe(preExistingUid);
    expect(res.createdAuth).toBe(false);
    expect(state.docs[`userOps/${opId}`].createdAuth).toBe(false);

    // Second: now test if claims update fails on pre-existing account, account is NOT deleted
    const opIdFail = 'op_test_preexisting_fail';
    state.docs[`users_prod/${CID_DEN}`].authUid = undefined; // unlinked profile
    state.authUsers[EMAIL_DEN] = {
      uid: 'preexisting_den_uid',
      email: EMAIL_DEN,
      customClaims: { departmental: 'ops' }
    };

    const authFactory = admin.auth;
    admin.auth = () => {
      const a = authFactory();
      return {
        ...a,
        setCustomUserClaims: async () => {
          throw new Error('NETWORK_TIMEOUT_CLAIMS');
        }
      };
    };

    try {
      await expect(provisionManager(admin, {
        cid: CID_DEN,
        email: EMAIL_DEN,
        opId: opIdFail
      })).rejects.toThrow('NETWORK_TIMEOUT_CLAIMS');

      // Pre-existing account must NEVER be deleted
      expect(state.deletedUids).not.toContain('preexisting_den_uid');
      expect(state.docs[`userOps/${opIdFail}`].createdAuth).toBe(false);
    } finally {
      admin.auth = authFactory;
    }
  });

  // 6. Reintento con la misma operación
  test('6. Reintento con la misma operación: idempotente, sin efectos duplicados', async () => {
    const opId = 'op_test_idempotent_replay';

    const first = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    const createCountAfterFirst = state.createUserCalls;

    const second = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    expect(second).toMatchObject({
      cid: CID_BEN,
      uid: first.uid,
      email: EMAIL_BEN,
      alreadyCompleted: true
    });
    // No new account created
    expect(state.createUserCalls).toBe(createCountAfterFirst);
  });

  // 7. Nueva ejecución que genera otro opId
  test('7. Nueva ejecución sin opId genera un nuevo token único y rastreable', async () => {
    const res1 = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN
    });

    const res2 = await provisionManager(admin, {
      cid: CID_DEN,
      email: EMAIL_DEN
    });

    expect(res1.opId).toBeDefined();
    expect(res2.opId).toBeDefined();
    expect(res1.opId).not.toBe(res2.opId);

    expect(state.docs[`userOps/${res1.opId}`]).toBeDefined();
    expect(state.docs[`userOps/${res2.opId}`]).toBeDefined();
  });

  // 8. Conflicto de UID o CID
  test('8. Conflicto de UID o CID es detectado y registrado como CONFLICT sin sobrescrituras', async () => {
    const opId = 'op_test_conflict_params';

    await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    // Replay with different CID
    await expect(provisionManager(admin, {
      cid: CID_DEN,
      email: EMAIL_DEN,
      opId
    })).rejects.toThrow(`Conflict: opId '${opId}' was previously recorded for a different CID`);

    // Conflict where profile is already linked to another Auth UID
    const opIdConf = 'op_test_conflicting_auth_link';
    state.docs[`users_prod/${CID_DEN}`].authUid = 'alien_auth_uid';

    await expect(provisionManager(admin, {
      cid: CID_DEN,
      email: EMAIL_DEN,
      opId: opIdConf
    })).rejects.toThrow('already linked to a different Auth account');

    expect(state.docs[`userOps/${opIdConf}`].status).toBe('conflict');
  });

  // 9. Error al escribir el registro de auditoría
  test('9. Error al escribir el registro de auditoría: marca MANUAL_REVIEW y alerta al operador', async () => {
    const opId = 'op_test_audit_failure';

    // Hook beforeCreate for commercialAudit to simulate write failure
    state.hooks.beforeCreate = path => {
      if (path.startsWith('commercialAudit_prod/')) {
        throw new Error('AUDIT_LOG_UNAVAILABLE');
      }
    };

    await expect(provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    })).rejects.toThrow('Failed to write commercial audit log: AUDIT_LOG_UNAVAILABLE');

    // Must be marked as manualReview so operator is required to reconcile
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc).toBeDefined();
    expect(opDoc.status).toBe('manualReview');
    expect(opDoc.auditFailed).toBe(true);
  });

  // 10. Reconciliación de operaciones parciales sin crear cuentas duplicadas ni borrar cuentas preexistentes
  test('10. Reconciliación de operaciones parciales: recupera estado sin duplicar Auth ni borrar preexistentes', async () => {
    const opId = 'op_test_partial_recovery';

    // Simulate an operation that created Auth user but crashed before linking Firestore
    const existingAuthUid = 'auth_reconcile_partial_uid';
    state.authUsers[EMAIL_BEN] = {
      uid: existingAuthUid,
      email: EMAIL_BEN,
      customClaims: {}
    };

    // Pre-record partial state in userOps
    state.docs[`userOps/${opId}`] = {
      opId,
      action: 'provisionManager',
      status: 'authCreated',
      cid: CID_BEN,
      profileId: CID_BEN,
      email: EMAIL_BEN,
      uid: existingAuthUid,
      createdAuth: true
    };

    // New run with fresh opId targeting the same profile
    const freshOpId = 'op_test_recovery_resume';
    const res = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId: freshOpId
    });

    expect(res.uid).toBe(existingAuthUid);
    expect(res.createdAuth).toBe(false); // correctly identified as pre-existing in Auth
    expect(state.createUserCalls).toBe(0); // no second account created
    expect(state.docs[`users_prod/${CID_BEN}`].authUid).toBe(existingAuthUid);
    expect(state.docs[`userOps/${freshOpId}`].status).toBe('succeeded');
  });

  // 11. Fallo al registrar manualReview cuando falla la auditoría: arroja error compuesto y no marca succeeded
  test('11. Fallo al registrar manualReview cuando falla la auditoría: arroja error compuesto y no marca succeeded', async () => {
    const opId = 'op_test_audit_and_state_failure';

    state.hooks.beforeCreate = path => {
      if (path.startsWith('commercialAudit_prod/')) {
        throw new Error('AUDIT_LOG_UNAVAILABLE');
      }
    };

    // Simulate failure updating userOps when trying to set manualReview
    state.hooks.beforeSet = (path, data) => {
      if (path === `userOps/${opId}` && data && data.status === 'manualReview') {
        throw new Error('USEROPS_STATE_UNAVAILABLE');
      }
    };

    await expect(provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    })).rejects.toThrow(/Failed to write commercial audit log.*Additionally failed to persist manualReview state/);

    delete state.hooks.beforeCreate;
    delete state.hooks.beforeSet;

    // Operation was never marked succeeded
    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc.status).not.toBe('succeeded');
  });

  // 12. Interrupción entre auditoría y succeeded: reintento con mismo opId no duplica auditoría y culmina con éxito
  test('12. Interrupción entre auditoría y succeeded: reintento con mismo opId no duplica auditoría y culmina con éxito', async () => {
    const opId = 'op_test_interruption_between_audit_and_succeeded';

    // Run normal provisioning
    const res1 = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });
    expect(res1.opId).toBe(opId);

    // Count audit records for this opId
    const auditCount1 = Object.values(state.docs).filter(d => d.action === 'provision_manager' && d.opId === opId).length;
    expect(auditCount1).toBe(1);

    // Simulate op was left in claimsUpdated (interruption before marking succeeded)
    state.docs[`userOps/${opId}`].status = 'claimsUpdated';
    delete state.docs[`userOps/${opId}`].result;
    delete state.docs[`userOps/${opId}`].completedAt;

    // Reattempt with the same opId
    const res2 = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    // Successfully transitioned to succeeded
    expect(state.docs[`userOps/${opId}`].status).toBe('succeeded');
    expect(res2.uid).toBe(res1.uid);

    // Audit record was NOT duplicated!
    const auditCount2 = Object.values(state.docs).filter(d => d.action === 'provision_manager' && d.opId === opId).length;
    expect(auditCount2).toBe(1);
  });

  // 13. Idempotencia plena: reintento posterior con mismo opId retorna alreadyCompleted sin nuevos efectos
  test('13. Idempotencia plena: reintento posterior con mismo opId retorna alreadyCompleted sin nuevos efectos', async () => {
    const opId = 'op_test_idempotent_replay';

    const res1 = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });
    expect(res1.alreadyCompleted).toBeUndefined();

    // Replay with identical opId
    const res2 = await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });
    expect(res2.alreadyCompleted).toBe(true);
    expect(res2.uid).toBe(res1.uid);
    expect(res2.claims).toEqual(res1.claims);
  });

  // 14. Registro canónico de requesterUid en estado pending
  test('14. Registro canónico de requesterUid en estado pending antes de mutaciones', async () => {
    const opId = 'op_test_canonical_requester';
    const operatorUid = 'manager_operator_777';

    await provisionManager(admin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId,
      actor: { uid: operatorUid, name: 'Operator 777' }
    });

    const opDoc = state.docs[`userOps/${opId}`];
    expect(opDoc.requesterUid).toBe(operatorUid);
    expect(opDoc.actor.uid).toBe(operatorUid);
  });

  // 15. Validación de proyecto (H-01): Todas las fuentes coinciden en ductsal-erp -> se acepta
  test('15. Validación de proyecto (H-01): Todas las fuentes coinciden en ductsal-erp -> se acepta', async () => {
    const opId = 'op_test_project_all_match';
    const fullyConsistentApp = {
      name: '[DEFAULT]',
      options: {
        projectId: 'ductsal-erp',
        credential: { projectId: 'ductsal-erp' }
      }
    };
    const secondaryApp = {
      name: 'secondaryApp',
      options: {
        projectId: 'ductsal-erp',
        credential: { projectId: 'ductsal-erp' }
      }
    };
    const fullyConsistentAdmin = {
      ...admin,
      options: {
        projectId: 'ductsal-erp',
        credential: { projectId: 'ductsal-erp' }
      },
      app: () => fullyConsistentApp,
      apps: [fullyConsistentApp, secondaryApp]
    };

    const res = await provisionManager(fullyConsistentAdmin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId
    });

    expect(res).toBeDefined();
    expect(res.opId).toBe(opId);
    expect(res.role).toBe('manager');
  });

  // 16. Validación de proyecto (H-01): La aplicación activa apunta a otro proyecto aunque admin.options.projectId indique ductsal-erp -> se rechaza
  test('16. Validación de proyecto (H-01): La aplicación activa apunta a otro proyecto aunque admin.options.projectId indique ductsal-erp -> se rechaza', async () => {
    const rogueApp = {
      name: '[DEFAULT]',
      options: { projectId: 'rogue-active-app-project' }
    };
    const contradictoryAdmin = {
      ...admin,
      options: { projectId: 'ductsal-erp' }, // admin.options indica ductsal-erp
      app: () => rogueApp,                  // la app activa apunta a otro proyecto
      apps: [rogueApp]
    };

    await expect(provisionManager(contradictoryAdmin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId: 'op_test_contradictory_app'
    })).rejects.toThrow(/Conflicting Firebase project configuration: Contradictory Firebase projectId sources detected/);
  });

  // 17. Validación de proyecto (H-01): Las credenciales indican un proyecto distinto del de la aplicación -> se rechaza si es aplicable
  test('17. Validación de proyecto (H-01): Las credenciales indican un proyecto distinto del de la aplicación -> se rechaza si es aplicable', async () => {
    // En el SDK de Firebase Admin, credenciales estructuradas (como ServiceAccountCredentials de llave JSON)
    // pueden exponer un projectId explícito. Si discrepa de la configuración de la aplicación,
    // resolveAdminProjectId detecta la contradicción y rechaza antes de cualquier mutación.
    // Nota: Si el SDK no expone projectId en credential (p. ej. ADC sin metadata local), su ausencia
    // no se considera contradicción.
    const mismatchedCredApp = {
      name: '[DEFAULT]',
      options: {
        projectId: 'ductsal-erp',
        credential: { projectId: 'rogue-credential-project' }
      }
    };
    const credentialContradictionAdmin = {
      ...admin,
      options: mismatchedCredApp.options,
      app: () => mismatchedCredApp,
      apps: [mismatchedCredApp]
    };

    await expect(provisionManager(credentialContradictionAdmin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId: 'op_test_mismatched_credential'
    })).rejects.toThrow(/Conflicting Firebase project configuration: Contradictory Firebase projectId sources detected/);
  });

  // 18. Validación de proyecto (H-01): Un elemento de admin.apps contradice el proyecto -> se rechaza
  test('18. Validación de proyecto (H-01): Un elemento de admin.apps contradice el proyecto -> se rechaza', async () => {
    const validApp = {
      name: '[DEFAULT]',
      options: { projectId: 'ductsal-erp' }
    };
    const foreignSecondaryApp = {
      name: 'foreignSecondary',
      options: { projectId: 'rogue-secondary-app-project' }
    };
    const multiAppContradictionAdmin = {
      ...admin,
      options: { projectId: 'ductsal-erp' },
      app: () => validApp,
      apps: [validApp, foreignSecondaryApp] // elemento secundario contradice ductsal-erp
    };

    await expect(provisionManager(multiAppContradictionAdmin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId: 'op_test_multi_app_contradiction'
    })).rejects.toThrow(/Conflicting Firebase project configuration: Contradictory Firebase projectId sources detected/);
  });

  // 19. Validación de proyecto (H-01): No hay identificadores verificables -> se rechaza
  test('19. Validación de proyecto (H-01): No hay identificadores verificables -> se rechaza', async () => {
    const emptyApp = { name: '[DEFAULT]', options: {} };
    const unverifiableAdmin = {
      ...admin,
      options: {},
      apps: [],
      app: () => emptyApp
    };

    await expect(provisionManager(unverifiableAdmin, {
      cid: CID_BEN,
      email: EMAIL_BEN,
      opId: 'op_test_missing_proj'
    })).rejects.toThrow(/Unable to determine Firebase projectId.*provisionManager strictly requires verified projectId 'ductsal-erp'/);
  });

  // 20. Validación de proyecto (H-01): Ante cualquier rechazo, cero llamadas de lectura y escritura en Auth y Firestore
  test('20. Validación de proyecto (H-01): Ante cualquier rechazo, cero llamadas de lectura y escritura en Auth y Firestore', async () => {
    const rejectionScenarios = [
      {
        name: 'Contradicción en aplicación activa',
        config: {
          options: { projectId: 'ductsal-erp' },
          app: () => ({ options: { projectId: 'other-app-project' } }),
          apps: [{ options: { projectId: 'other-app-project' } }]
        }
      },
      {
        name: 'Contradicción en credencial',
        config: {
          options: { projectId: 'ductsal-erp', credential: { projectId: 'diff-cred-project' } },
          app: () => ({ options: { projectId: 'ductsal-erp', credential: { projectId: 'diff-cred-project' } } }),
          apps: []
        }
      },
      {
        name: 'Contradicción en array apps',
        config: {
          options: { projectId: 'ductsal-erp' },
          app: () => ({ options: { projectId: 'ductsal-erp' } }),
          apps: [{ options: { projectId: 'ductsal-erp' } }, { options: { projectId: 'alien-project' } }]
        }
      },
      {
        name: 'Ausencia de identificadores verificables',
        config: {
          options: {},
          app: () => ({ options: {} }),
          apps: []
        }
      },
      {
        name: 'Proyecto consistente pero no objetivo',
        config: {
          options: { projectId: 'foreign-malicious-project' },
          app: () => ({ options: { projectId: 'foreign-malicious-project' } }),
          apps: [{ options: { projectId: 'foreign-malicious-project' } }]
        }
      }
    ];

    for (const scenario of rejectionScenarios) {
      // Espías explícitos para todas las operaciones de lectura y escritura de Auth
      const authSpies = {
        getUserByEmail: jest.fn(),
        getUser: jest.fn(),
        createUser: jest.fn(),
        setCustomUserClaims: jest.fn(),
        updateUser: jest.fn(),
        deleteUser: jest.fn(),
        revokeRefreshTokens: jest.fn()
      };

      // Espías explícitos para todas las operaciones de lectura y escritura de Firestore
      const firestoreDocSpies = {
        get: jest.fn(),
        set: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn()
      };

      const firestoreSpies = {
        collection: jest.fn(() => ({
          doc: jest.fn(() => firestoreDocSpies)
        })),
        runTransaction: jest.fn()
      };

      const authFactorySpy = jest.fn(() => authSpies);
      const firestoreFactorySpy = jest.fn(() => firestoreSpies);

      const rejectedAdmin = {
        ...scenario.config,
        auth: authFactorySpy,
        firestore: firestoreFactorySpy
      };

      const opId = `op_reject_spies_${Math.random().toString(36).substring(2, 9)}`;
      const initialDocsCount = Object.keys(state.docs).length;

      await expect(provisionManager(rejectedAdmin, {
        cid: CID_BEN,
        email: EMAIL_BEN,
        opId
      })).rejects.toThrow();

      // 1. Demostración de CERO llamadas de lectura a Auth
      expect(authSpies.getUserByEmail).not.toHaveBeenCalled();
      expect(authSpies.getUser).not.toHaveBeenCalled();

      // 2. Demostración de CERO llamadas de escritura a Auth
      expect(authSpies.createUser).not.toHaveBeenCalled();
      expect(authSpies.setCustomUserClaims).not.toHaveBeenCalled();
      expect(authSpies.updateUser).not.toHaveBeenCalled();
      expect(authSpies.deleteUser).not.toHaveBeenCalled();
      expect(authSpies.revokeRefreshTokens).not.toHaveBeenCalled();

      // 3. Demostración de CERO llamadas de lectura a Firestore
      expect(firestoreDocSpies.get).not.toHaveBeenCalled();

      // 4. Demostración de CERO llamadas de escritura a Firestore
      expect(firestoreDocSpies.set).not.toHaveBeenCalled();
      expect(firestoreDocSpies.create).not.toHaveBeenCalled();
      expect(firestoreDocSpies.update).not.toHaveBeenCalled();
      expect(firestoreDocSpies.delete).not.toHaveBeenCalled();
      expect(firestoreSpies.runTransaction).not.toHaveBeenCalled();

      // 5. Demostración de CERO invocaciones a los namespaces de Auth y Firestore
      expect(authFactorySpy).not.toHaveBeenCalled();
      expect(firestoreFactorySpy).not.toHaveBeenCalled();

      // 6. Estado global de fakeFirebase completamente inalterado
      expect(state.docs[`userOps/${opId}`]).toBeUndefined();
      expect(Object.keys(state.docs).length).toBe(initialDocsCount);
      expect(state.createUserCalls).toBe(0);
      expect(state.claimsCalls).toHaveLength(0);
      expect(state.revokedUids).toHaveLength(0);
    }
  });
});

