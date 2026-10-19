// functions/__tests__/historicalLinking.unit.test.js
// Unit tests for historical user linking and plaintext password purging.
// Uses in-memory fakes; never touches a real project or emulators.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const { linkHistoricalUserAdmin, purgeHistoricalPasswordAdmin } = require('../index');
const { provisionManager } = require('../scripts/provisionManager');
const state = admin.__state;

const mgrCtx = { auth: { uid: 'managerUid', token: { manager: true, role: 'manager', cid: '1000000000001' } } };
const vendCtx = { auth: { uid: 'vendUid', token: { role: 'vendedor', cid: '1792037387205' } } };

let n = 0;
const opId = () => `op_hist_${++n}`;

beforeEach(() => {
  state.docs = {};
  state.authUsers = {};
  state.createUserCalls = 0;
  state.createUserArgs = [];
  state.requesters = {
    managerUid: { email: 'benjamin@ductsal-test.invalid', customClaims: { manager: true, role: 'manager', cid: '1000000000001' } },
    denysUid: { email: 'denys@ductsal-test.invalid', customClaims: { manager: true, role: 'manager', cid: '1000000000002' } },
    vendUid: { email: 'vendedor@ductsal-test.invalid', customClaims: { role: 'vendedor', cid: '1792037387205' } }
  };
  state.updateUserCalls = [];
  state.revokedUids = [];
  state.deletedUids = [];
  state.claimsCalls = [];
  state.hooks = {};
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

  // Active manager profiles in users_prod (initially unlinked before provisionManager runs)
  state.docs['users_prod/1000000000001'] = {
    id: '1000000000001',
    nombre: 'Benjamin Valiente',
    email: 'benjamin@ductsal-test.invalid',
    role: 'manager',
    activo: true,
    historicalField: 'preserved-1'
  };
  state.docs['users_prod/1000000000002'] = {
    id: '1000000000002',
    nombre: 'Denys Gonzalez',
    email: 'denys@ductsal-test.invalid',
    role: 'manager',
    activo: true,
    historicalField: 'preserved-2'
  };
});

describe('Manager Authorized Provisioning (provisionManager)', () => {
  test('provisions Benjamin and Denys with identical manager role and claims', async () => {
    const benRes = await provisionManager(admin, {
      cid: '1000000000001',
      email: 'benjamin@ductsal-test.invalid',
      nombre: 'Benjamin Valiente',
      suffix: '_prod'
    });
    const denRes = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    // Identical roles and claims
    expect(benRes.role).toBe('manager');
    expect(denRes.role).toBe('manager');
    expect(benRes.claims).toEqual({ role: 'manager', manager: true, cid: '1000000000001' });
    expect(denRes.claims).toEqual({ role: 'manager', manager: true, cid: '1000000000002' });

    // Verify in Firestore
    const pBen = state.docs['users_prod/1000000000001'];
    const pDen = state.docs['users_prod/1000000000002'];
    expect(pBen).toMatchObject({ id: '1000000000001', role: 'manager', activo: true, historicalField: 'preserved-1' });
    expect(pDen).toMatchObject({ id: '1000000000002', role: 'manager', activo: true, historicalField: 'preserved-2' });
  });

  test('aborts if Auth account is already linked to a different profile', async () => {
    state.authUsers['shared@ductsal-test.invalid'] = { uid: 'sharedUid', email: 'shared@ductsal-test.invalid' };
    state.docs['users_prod/otherCid'] = { id: 'otherCid', authUid: 'sharedUid', email: 'shared@ductsal-test.invalid', role: 'vendedor', activo: true };
    state.docs['users_prod/1000000000002'] = { id: '1000000000002', email: 'shared@ductsal-test.invalid', role: 'manager', activo: true };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'shared@ductsal-test.invalid',
      nombre: 'Denys',
      suffix: '_prod'
    })).rejects.toThrow(/already linked to another profile/);
  });

  test('rejects if target Firestore profile does not exist', async () => {
    await expect(provisionManager(admin, {
      cid: 'nonExistentCid',
      email: 'ghost@ductsal-test.invalid',
      nombre: 'Ghost Manager',
      suffix: '_prod'
    })).rejects.toThrow(/does not exist in users_prod/);
  });

  test('rejects if provided email does not match email registered in profile', async () => {
    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'wrong.email@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/Email mismatch/);
  });

  test('rejects if profile historical role is not manager (silent elevation prevention)', async () => {
    state.docs['users_prod/sellerAsMgr'] = {
      id: 'sellerAsMgr',
      nombre: 'Seller Trying Manager',
      email: 'seller@ductsal-test.invalid',
      role: 'vendedor',
      activo: true
    };

    await expect(provisionManager(admin, {
      cid: 'sellerAsMgr',
      email: 'seller@ductsal-test.invalid',
      nombre: 'Seller Trying Manager',
      suffix: '_prod'
    })).rejects.toThrow(/Silent role elevation is prohibited/);
  });

  test('rejects if target profile is inactive', async () => {
    state.docs['users_prod/inactiveMgr'] = {
      id: 'inactiveMgr',
      nombre: 'Inactive Manager',
      email: 'inactive@ductsal-test.invalid',
      role: 'manager',
      activo: false
    };

    await expect(provisionManager(admin, {
      cid: 'inactiveMgr',
      email: 'inactive@ductsal-test.invalid',
      nombre: 'Inactive Manager',
      suffix: '_prod'
    })).rejects.toThrow(/Inactive manager profiles cannot be provisioned/);
  });

  test('rejects if Firestore profile already has a conflicting authUid', async () => {
    state.docs['users_prod/1000000000002'].authUid = 'existingAuthUid999';

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/already linked to a different Auth account/);
  });

  test('rejects if pre-existing Auth account is disabled', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'disabledDenysUid',
      email: 'denys@ductsal-test.invalid',
      disabled: true
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/is disabled in Firebase Authentication/);
  });

  test('rejects insecure password (< 8 characters)', async () => {
    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      password: 'short',
      suffix: '_prod'
    })).rejects.toThrow(/Password must be a string with at least 8 characters/);
  });

  test('provisions with explicit valid password when supplied', async () => {
    const res = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      password: 'StrongPassword2026!',
      suffix: '_prod'
    });

    expect(res.uid).toBeDefined();
    expect(state.createUserArgs).toContainEqual(expect.objectContaining({
      email: 'denys@ductsal-test.invalid',
      password: 'StrongPassword2026!'
    }));
  });

  test('revokes refresh tokens upon assigning manager claims', async () => {
    await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    expect(state.revokedUids.length).toBeGreaterThan(0);
  });

  test('cleans up newly created Auth account if Firestore update throws', async () => {
    state.hooks.beforeUpdate = path => {
      if (path === 'users_prod/1000000000002') throw new Error('Firestore crash');
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/Firestore crash/);

    // Auth user created during this op was cleaned up
    expect(state.deletedUids.length).toBeGreaterThan(0);
    delete state.hooks.beforeUpdate;
  });

  test('re-running provisionManager for already linked manager is idempotent', async () => {
    // First run
    const first = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    // Second run with same parameters
    const second = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    expect(second.uid).toBe(first.uid);
    expect(second.claims).toEqual(first.claims);
    expect(second.createdAuth).toBe(false);
  });

  test('pre-existing Auth user: does not alter prior claims and does not revoke tokens if Firestore update throws', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'preexistingDenysUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: { department: 'operations', legacyKey: 123 }
    };

    state.hooks.beforeUpdate = path => {
      if (path === 'users_prod/1000000000002') throw new Error('Firestore disk error');
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/Firestore disk error/);

    // Verify Auth user was NOT deleted
    expect(state.deletedUids).not.toContain('preexistingDenysUid');

    // Verify tokens were NOT revoked (active sessions preserved)
    expect(state.revokedUids).not.toContain('preexistingDenysUid');

    // Verify prior custom claims were NOT altered
    const userInAuth = state.authUsers['denys@ductsal-test.invalid'];
    expect(userInAuth.customClaims).toEqual({ department: 'operations', legacyKey: 123 });

    // Verify Firestore doc remains unlinked
    expect(state.docs['users_prod/1000000000002'].authUid).toBeUndefined();

    delete state.hooks.beforeUpdate;
  });

  test('pre-existing Auth user: preserves legitimate additional claims alongside manager claims on success', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'preexistingDenysUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: { department: 'operations', accessScore: 99 }
    };

    const res = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    expect(res.claims).toEqual({
      department: 'operations',
      accessScore: 99,
      role: 'manager',
      manager: true,
      cid: '1000000000002'
    });

    const userInAuth = state.authUsers['denys@ductsal-test.invalid'];
    expect(userInAuth.customClaims).toEqual(res.claims);
    expect(state.revokedUids).toContain('preexistingDenysUid');
  });

  test('rejects if pre-existing Auth account already has custom claims for a different CID', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'preexistingDenysUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: { cid: 'OTHER_CID_999' }
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/already has custom claims linked to a different CID/);

    expect(state.docs['users_prod/1000000000002'].authUid).toBeUndefined();
  });

  test('rolls back Firestore update if setCustomUserClaims throws error', async () => {
    state.hooks.beforeSetClaims = () => {
      throw new Error('Auth claims service down');
    };

    await expect(provisionManager(admin, {
      cid: '1000000000001',
      email: 'benjamin@ductsal-test.invalid',
      nombre: 'Benjamin Valiente',
      suffix: '_prod'
    })).rejects.toThrow(/Auth claims service down/);

    // Firestore update was rolled back (authUid removed)
    const doc = state.docs['users_prod/1000000000001'];
    expect(doc.authUid).toBeUndefined();

    // Created Auth account was deleted
    expect(state.deletedUids.length).toBeGreaterThan(0);

    delete state.hooks.beforeSetClaims;
  });

  test('failure in revokeRefreshTokens triggers rollback without pretending tokens can be unrevoked', async () => {
    state.hooks.beforeRevokeTokens = () => {
      throw new Error('Revocation network timeout');
    };

    await expect(provisionManager(admin, {
      cid: '1000000000001',
      email: 'benjamin@ductsal-test.invalid',
      nombre: 'Benjamin Valiente',
      suffix: '_prod'
    })).rejects.toThrow(/Revocation network timeout/);

    // Verify Firestore was rolled back
    expect(state.docs['users_prod/1000000000001'].authUid).toBeUndefined();

    // Verify newly created user was deleted
    expect(state.deletedUids.length).toBeGreaterThan(0);

    delete state.hooks.beforeRevokeTokens;
  });

  test('rollback failure: surfaces critical partial state without concealing the original error', async () => {
    // 1. Force claims assignment failure to trigger rollback
    state.hooks.beforeSetClaims = () => {
      throw new Error('Auth claims 503 Service Unavailable');
    };

    // 2. Force Firestore rollback update to also fail
    let updateCount = 0;
    state.hooks.beforeUpdate = () => {
      updateCount++;
      if (updateCount === 2) {
        throw new Error('Firestore disk error during rollback');
      }
    };

    let caughtError = null;
    try {
      await provisionManager(admin, {
        cid: '1000000000001',
        email: 'benjamin@ductsal-test.invalid',
        nombre: 'Benjamin Valiente',
        suffix: '_prod'
      });
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).not.toBeNull();
    // Must contain original error
    expect(caughtError.message).toMatch(/Auth claims 503 Service Unavailable/);
    // Must contain critical rollback partial failure
    expect(caughtError.message).toMatch(/CRITICAL: ROLLBACK PARTIAL FAILURE/);
    expect(caughtError.message).toMatch(/Failed to revert Firestore profile/);
    expect(caughtError.originalError).toBeDefined();
    expect(caughtError.rollbackErrors.length).toBeGreaterThan(0);

    delete state.hooks.beforeSetClaims;
    delete state.hooks.beforeUpdate;
  });

  test('concurrency: rejects and prevents overwrite if profile is concurrently linked or deactivated', async () => {
    // Simulate concurrent modification right as transaction starts
    state.hooks.beforeTransaction = () => {
      state.docs['users_prod/1000000000002'].authUid = 'concurrentOtherUid';
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/linked concurrently to another Auth account: concurrentOtherUid/);

    // Verify concurrent authUid was NOT overwritten
    expect(state.docs['users_prod/1000000000002'].authUid).toBe('concurrentOtherUid');

    delete state.hooks.beforeTransaction;
  });

  test('concurrency: rejects if profile is concurrently deactivated', async () => {
    state.hooks.beforeTransaction = () => {
      state.docs['users_prod/1000000000002'].activo = false;
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/became inactive concurrently/);

    delete state.hooks.beforeTransaction;
  });

  test('contradictory claims: purges conflicting role and status flags while preserving legitimate attributes', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'denysContradictoryUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: {
        department: 'operations',
        vendedor: true,
        gestor: true,
        operador: true,
        role: 'vendedor',
        disabled: true,
        tenantId: 'ductsal-group'
      }
    };

    const res = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    // Legitimate attributes preserved
    expect(res.claims.department).toBe('operations');
    expect(res.claims.tenantId).toBe('ductsal-group');

    // Authoritative manager claims set
    expect(res.claims.role).toBe('manager');
    expect(res.claims.manager).toBe(true);
    expect(res.claims.cid).toBe('1000000000002');

    // Contradictory flags removed
    expect(res.claims.vendedor).toBeUndefined();
    expect(res.claims.gestor).toBeUndefined();
    expect(res.claims.operador).toBeUndefined();
    expect(res.claims.disabled).toBeUndefined();
  });

  test('idempotency: does not invalidate active sessions on repeat run when claims have not changed', async () => {
    // First run establishes manager
    await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    // Clear recorded revocations
    state.revokedUids = [];

    // Second run with identical parameters
    const second = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    expect(second.createdAuth).toBe(false);
    // Sessions were NOT invalidated unnecessarily
    expect(state.revokedUids).toHaveLength(0);
    // Historical fields preserved
    expect(state.docs['users_prod/1000000000002'].historicalField).toBe('preserved-2');
  });

  test('idempotency: areClaimsEqual accurately detects equality of nested claims and arrays without revoking sessions', async () => {
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'denysNestedUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: {
        role: 'manager',
        manager: true,
        cid: '1000000000002',
        metadata: { branch: 'sv', zones: ['central', 'occidente'] }
      }
    };
    state.docs['users_prod/1000000000002'].authUid = 'denysNestedUid';

    // Clear recorded revocations
    state.revokedUids = [];

    const res = await provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    });

    expect(res.claims.metadata).toEqual({ branch: 'sv', zones: ['central', 'occidente'] });
    // Nested claims matched deeply: token revocation was NOT triggered
    expect(state.revokedUids).toHaveLength(0);
  });

  test('pre-existing accounts: rollback never deletes pre-existing Auth account or pre-existing link', async () => {
    // Pre-existing Auth account and pre-existing Firestore link
    state.authUsers['denys@ductsal-test.invalid'] = {
      uid: 'preexistingDenysUid',
      email: 'denys@ductsal-test.invalid',
      customClaims: { oldExtra: 'keep' }
    };
    state.docs['users_prod/1000000000002'].authUid = 'preexistingDenysUid';

    // Force error during token revocation
    state.hooks.beforeRevokeTokens = () => {
      throw new Error('Revoke network down');
    };

    await expect(provisionManager(admin, {
      cid: '1000000000002',
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      suffix: '_prod'
    })).rejects.toThrow(/Revoke network down/);

    // Pre-existing Auth account was NOT deleted
    expect(state.deletedUids).not.toContain('preexistingDenysUid');

    // Pre-existing authUid link was NOT deleted (preserved)
    expect(state.docs['users_prod/1000000000002'].authUid).toBe('preexistingDenysUid');

    delete state.hooks.beforeRevokeTokens;
  });
});

describe('Historical User Linking (linkHistoricalUserAdmin)', () => {
  beforeEach(() => {
    // Seed active historical seller
    state.docs['users_prod/1792037387205'] = {
      id: '1792037387205',
      nombre: 'Vendedor Activo',
      email: 'vendedor.activo@ductsal-test.invalid',
      password: 'legacy-plaintext-password',
      role: 'vendedor',
      activo: true
    };
    // Seed inactive historical seller
    state.docs['users_prod/1792000000000'] = {
      id: '1792000000000',
      nombre: 'Vendedor Inactivo',
      email: 'vendedor.inactivo@ductsal-test.invalid',
      password: 'legacy-plaintext-inactivo',
      role: 'vendedor',
      activo: false
    };
    // Seed gestor
    state.docs['users_prod/1000000000003'] = {
      id: '1000000000003',
      nombre: 'Gestor Comercial',
      email: 'gestor@ductsal-test.invalid',
      password: 'legacy-plaintext-gestor',
      role: 'gestor',
      activo: true
    };
    // Ensure manager account has linked profile as expected after Phase 1 provisioning
    state.docs['users_prod/1000000000001'].authUid = 'managerUid';
    state.docs['users_prod/1000000000001'].authProvider = 'firebase';
  });

  test('non-manager caller is refused with permission-denied', async () => {
    await expect(linkHistoricalUserAdmin({ id: '1792037387205', opId: opId() }, vendCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('refuses to link an inactive profile (preserving inactive seller status)', async () => {
    await expect(linkHistoricalUserAdmin({ id: '1792000000000', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(0);
    expect(state.docs['users_prod/1792000000000'].authUid).toBeUndefined();
  });

  test('refuses to link manager profiles through this callable (enforcing authorized procedure)', async () => {
    state.docs['users_prod/mgrLegacy'] = {
      id: 'mgrLegacy',
      nombre: 'Gerente Viejo',
      email: 'gm@ductsal-test.invalid',
      role: 'manager',
      activo: true
    };
    await expect(linkHistoricalUserAdmin({ id: 'mgrLegacy', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('refuses if Auth account is already linked to another profile', async () => {
    // Auth account exists and is already linked to a different doc
    state.authUsers['vendedor.activo@ductsal-test.invalid'] = { uid: 'otherUid', email: 'vendedor.activo@ductsal-test.invalid' };
    state.docs['users_prod/anotherUser'] = { id: 'anotherUser', authUid: 'otherUid', email: 'vendedor.activo@ductsal-test.invalid', activo: true };

    await expect(linkHistoricalUserAdmin({ id: '1792037387205', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'already-exists' });
  });

  test('refuses if profile does not exist (not-found)', async () => {
    await expect(linkHistoricalUserAdmin({ id: '9999999999999', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  test('refuses if profile has invalid or unsupported role (invalid-argument)', async () => {
    state.docs['users_prod/unsupportedRole'] = {
      id: 'unsupportedRole',
      nombre: 'Operario',
      email: 'operario@ductsal-test.invalid',
      role: 'operario',
      activo: true
    };
    await expect(linkHistoricalUserAdmin({ id: 'unsupportedRole', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('refuses if profile has invalid email (failed-precondition)', async () => {
    state.docs['users_prod/badEmail'] = {
      id: 'badEmail',
      nombre: 'Vendedor Mal Email',
      email: 'not-an-email',
      role: 'vendedor',
      activo: true
    };
    await expect(linkHistoricalUserAdmin({ id: 'badEmail', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('successfully links an active historical seller, assigns { role, cid } and preserves plaintext password', async () => {
    const r = await linkHistoricalUserAdmin({ id: '1792037387205', opId: opId() }, mgrCtx);
    expect(r.status).toBe('linked');
    expect(r.id).toBe('1792037387205');
    expect(r.role).toBe('vendedor');
    expect(r.uid).toBeDefined();

    // Claims set: { role: 'vendedor', cid: '1792037387205' }
    expect(state.claimsCalls).toContainEqual({
      uid: r.uid,
      claims: { role: 'vendedor', cid: '1792037387205' }
    });

    // Firestore profile updated with authUid and authProvider
    const prof = state.docs['users_prod/1792037387205'];
    expect(prof.authUid).toBe(r.uid);
    expect(prof.authProvider).toBe('firebase');

    // Requirement 6: password is NOT deleted by linkHistoricalUserAdmin
    expect(prof.password).toBe('legacy-plaintext-password');

    // Audit entry recorded
    const audits = Object.values(state.docs).filter(d => d.action === 'linkHistoricalUser' && d.targetType === 'user');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'linkHistoricalUser',
      targetId: '1792037387205',
      actorRole: 'manager'
    });
  });

  test('successfully links an active gestor with { role: gestor, cid }', async () => {
    const r = await linkHistoricalUserAdmin({ id: '1000000000003', opId: opId() }, mgrCtx);
    expect(r.status).toBe('linked');
    expect(r.role).toBe('gestor');
    expect(state.claimsCalls).toContainEqual({
      uid: r.uid,
      claims: { role: 'gestor', cid: '1000000000003' }
    });
    expect(state.docs['users_prod/1000000000003'].authUid).toBe(r.uid);
  });

  test('reusing same opId is idempotent and returns previous result without duplicating', async () => {
    const op = opId();
    const first = await linkHistoricalUserAdmin({ id: '1792037387205', opId: op }, mgrCtx);
    const second = await linkHistoricalUserAdmin({ id: '1792037387205', opId: op }, mgrCtx);
    expect(second).toEqual(first);
    expect(state.createUserCalls).toBe(1);
  });

  test('rolls back newly created Auth user if Firestore transaction fails', async () => {
    state.hooks.beforeUpdate = (path) => {
      if (path === 'users_prod/1792037387205') throw new Error('Simulated Firestore outage');
    };
    await expect(linkHistoricalUserAdmin({ id: '1792037387205', opId: opId() }, mgrCtx))
      .rejects.toMatchObject({ code: 'internal' });

    // The newly created Auth account must be deleted
    expect(state.deletedUids.length).toBe(1);
    expect(state.docs['users_prod/1792037387205'].authUid).toBeUndefined();
  });
});

describe('Plaintext Password Purge (purgeHistoricalPasswordAdmin)', () => {
  beforeEach(() => {
    state.docs['users_prod/1792037387205'] = {
      id: '1792037387205',
      authUid: 'vendUid',
      nombre: 'Vendedor',
      email: 'vendedor@ductsal-test.invalid',
      password: 'legacy-pwd-to-purge',
      role: 'vendedor',
      activo: true
    };
    // Ensure manager account has linked profile as expected after Phase 1 provisioning
    state.docs['users_prod/1000000000001'].authUid = 'managerUid';
    state.docs['users_prod/1000000000001'].authProvider = 'firebase';
  });

  test('unauthenticated caller is rejected', async () => {
    await expect(purgeHistoricalPasswordAdmin({ id: '1792037387205' }, {}))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('non-manager attempting to purge someone else’s password is rejected', async () => {
    const otherUserCtx = { auth: { uid: 'strangerUid', token: { role: 'vendedor', cid: '999' } } };
    await expect(purgeHistoricalPasswordAdmin({ id: '1792037387205' }, otherUserCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('manager cannot purge password if user has never logged in', async () => {
    // Override requester for target to have no lastSignInTime
    state.requesters.vendUid = {
      email: 'vendedor@ductsal-test.invalid',
      metadata: { lastSignInTime: null }
    };
    await expect(purgeHistoricalPasswordAdmin({ id: '1792037387205' }, mgrCtx))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.docs['users_prod/1792037387205'].password).toBe('legacy-pwd-to-purge');
  });

  test('linked user themselves purges password upon verified active session', async () => {
    const r = await purgeHistoricalPasswordAdmin({ id: '1792037387205' }, vendCtx);
    expect(r.status).toBe('purged');
    expect(state.docs['users_prod/1792037387205'].password).toBeUndefined();

    // Audit entry recorded
    const audits = Object.values(state.docs).filter(d => d.action === 'purgeHistoricalPassword');
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe('1792037387205');
  });

  test('already purged profile returns already-purged safely', async () => {
    delete state.docs['users_prod/1792037387205'].password;
    const r = await purgeHistoricalPasswordAdmin({ id: '1792037387205' }, vendCtx);
    expect(r.status).toBe('already-purged');
  });

  test('refuses to purge password of a non-existent profile (not-found)', async () => {
    await expect(purgeHistoricalPasswordAdmin({ id: '9999999999999' }, mgrCtx))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  test('refuses to purge password of an unlinked profile (failed-precondition)', async () => {
    state.docs['users_prod/unlinkedProfile'] = {
      id: 'unlinkedProfile',
      nombre: 'Unlinked',
      email: 'unlinked@ductsal-test.invalid',
      password: 'some-pwd',
      activo: true
    };
    await expect(purgeHistoricalPasswordAdmin({ id: 'unlinkedProfile' }, mgrCtx))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('refuses to purge password if linked Auth account is disabled (permission-denied)', async () => {
    state.requesters.vendUid = {
      email: 'vendedor@ductsal-test.invalid',
      disabled: true,
      metadata: { lastSignInTime: '2026-10-16T12:00:00Z' }
    };
    await expect(purgeHistoricalPasswordAdmin({ id: '1792037387205' }, vendCtx))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });
});
