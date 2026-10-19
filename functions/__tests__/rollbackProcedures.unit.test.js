// functions/__tests__/rollbackProcedures.unit.test.js
// Unit tests for SEC-03 rollback procedures, safety guardrails, and contingency recovery.

const {
  evaluateAuthAccountForRollback,
  safeUnlinkFirestoreProfile,
  executeSafeRollback
} = require('../rollbackUtil');

describe('SEC-03 Rollback Safety Guardrails & Recovery Order', () => {

  describe('1. Distinguishing Pre-existing Accounts vs Migration-Created Accounts', () => {
    test('explicitly pre-existing account is NEVER permitted to be deleted', () => {
      const mockAuthUser = {
        uid: 'uid_preexisting_manager',
        email: 'bvaliente@grupogama.com',
        metadata: {
          creationTime: '2026-01-01T00:00:00Z',
          lastSignInTime: null
        },
        customClaims: { role: 'manager', manager: true, cid: '1776895495203' }
      };

      const evalRes = evaluateAuthAccountForRollback(mockAuthUser, {
        isPreexisting: true,
        confirmDelete: 'YES'
      });

      expect(evalRes.canDelete).toBe(false);
      expect(evalRes.isPreexisting).toBe(true);
      expect(evalRes.stopCondition).toBe('PREEXISTING_ACCOUNT');
      expect(evalRes.action).toBe('NEUTRALIZE_CLAIMS_ONLY');
      expect(evalRes.reason).toMatch(/preexistente a la migración/);
    });

    test('account created prior to migration start timestamp is detected as pre-existing', () => {
      const migrationStartTime = new Date('2026-10-18T05:00:00Z');
      const mockAuthUser = {
        uid: 'uid_old_account',
        email: 'dgonzalez@ductsal.com',
        metadata: {
          creationTime: '2026-10-17T20:00:00Z', // 9 hours before migration
          lastSignInTime: null
        }
      };

      const evalRes = evaluateAuthAccountForRollback(mockAuthUser, {
        migrationStartTime,
        confirmDelete: 'YES'
      });

      expect(evalRes.canDelete).toBe(false);
      expect(evalRes.stopCondition).toBe('PREEXISTING_ACCOUNT_BY_TIMESTAMP');
      expect(evalRes.action).toBe('NEUTRALIZE_CLAIMS_ONLY');
    });

    test('account created during migration without activity is eligible for deletion if authorized', () => {
      const migrationStartTime = new Date('2026-10-18T05:00:00Z');
      const mockAuthUser = {
        uid: 'uid_newly_created',
        email: 'aayala@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:05:00Z', // 5 minutes into migration
          lastSignInTime: null
        }
      };

      const evalRes = evaluateAuthAccountForRollback(mockAuthUser, {
        migrationStartTime,
        confirmDelete: 'YES'
      });

      expect(evalRes.canDelete).toBe(true);
      expect(evalRes.action).toBe('DELETE_PERMITTED');
      expect(evalRes.stopCondition).toBeNull();
    });
  });

  describe('2. Preventing Deletion of Accounts with External Activity (lastSignInTime)', () => {
    test('account with lastSignInTime triggers STOP condition USER_ACTIVITY_DETECTED and prohibits deletion', () => {
      const mockAuthUser = {
        uid: 'uid_active_user',
        email: 'rflores@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:01:00Z',
          lastSignInTime: '2026-10-18T05:10:00Z' // User actually signed in!
        }
      };

      const evalRes = evaluateAuthAccountForRollback(mockAuthUser, {
        isPreexisting: false,
        confirmDelete: 'YES'
      });

      expect(evalRes.canDelete).toBe(false);
      expect(evalRes.hasActivity).toBe(true);
      expect(evalRes.stopCondition).toBe('USER_ACTIVITY_DETECTED');
      expect(evalRes.action).toBe('DISABLE_ONLY');
      expect(evalRes.reason).toMatch(/ALERTA DE SEGURIDAD.*inicios de sesión/);
    });
  });

  describe('3. Human Authorization Guardrail (CONFIRM_DELETE_AUTH_ACCOUNT)', () => {
    test('aborts deletion if human confirmation is not explicitly "YES"', () => {
      const mockAuthUser = {
        uid: 'uid_unconfirmed',
        email: 'test@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:00:00Z',
          lastSignInTime: null
        }
      };

      // Case A: Missing option
      const resMissing = evaluateAuthAccountForRollback(mockAuthUser);
      expect(resMissing.canDelete).toBe(false);
      expect(resMissing.stopCondition).toBe('MISSING_HUMAN_AUTHORIZATION');

      // Case B: Explicit NO
      const resNo = evaluateAuthAccountForRollback(mockAuthUser, { confirmDelete: 'NO' });
      expect(resNo.canDelete).toBe(false);
      expect(resNo.stopCondition).toBe('MISSING_HUMAN_AUTHORIZATION');

      // Case C: Explicit YES enables deletion
      const resYes = evaluateAuthAccountForRollback(mockAuthUser, { confirmDelete: 'YES' });
      expect(resYes.canDelete).toBe(true);
    });
  });

  describe('3b. Proof of Ownership and Provenance Verification (Beyond creationTime/lastSignInTime)', () => {
    test('rejects deletion if Auth customClaims.cid does not match target CID (foreign/unrelated account)', () => {
      const mockAuthUser = {
        uid: 'uid_foreign',
        email: 'other@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:01:00Z',
          lastSignInTime: null
        },
        customClaims: { cid: '9999999999999' } // Different CID!
      };

      const res = evaluateAuthAccountForRollback(mockAuthUser, {
        cid: '1776904514932',
        confirmDelete: 'YES'
      });

      expect(res.canDelete).toBe(false);
      expect(res.stopCondition).toBe('MISMATCHED_CID_CLAIM');
      expect(res.reason).toMatch(/FALLO DE ATRIBUCIÓN/);
    });

    test('rejects deletion if Firestore profile is not linked to this Auth UID (broken bidirectional link)', () => {
      const mockAuthUser = {
        uid: 'uid_candidate',
        email: 'aayala@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:01:00Z',
          lastSignInTime: null
        },
        customClaims: { cid: '1776904514932' }
      };

      const mockFirestoreProfile = {
        id: '1776904514932',
        authUid: 'uid_different_real_user' // Firestore points elsewhere!
      };

      const res = evaluateAuthAccountForRollback(mockAuthUser, {
        cid: '1776904514932',
        firestoreProfile: mockFirestoreProfile,
        confirmDelete: 'YES'
      });

      expect(res.canDelete).toBe(false);
      expect(res.stopCondition).toBe('MISMATCHED_FIRESTORE_LINK');
      expect(res.reason).toMatch(/vinculado a otro authUid/);
    });

    test('rejects deletion if audit/userOps provenance is strictly required but absent', () => {
      const mockAuthUser = {
        uid: 'uid_candidate',
        email: 'aayala@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:01:00Z',
          lastSignInTime: null
        },
        customClaims: { cid: '1776904514932' }
      };

      const res = evaluateAuthAccountForRollback(mockAuthUser, {
        cid: '1776904514932',
        confirmDelete: 'YES',
        requireAuditProvenance: true,
        hasAuditProvenance: false
      });

      expect(res.canDelete).toBe(false);
      expect(res.stopCondition).toBe('MISSING_AUDIT_PROVENANCE');
      expect(res.reason).toMatch(/No se localizó un registro formal de operación/);
    });

    test('permits deletion only when all 5 factors align (created in migration, no sign-ins, CID matches, Firestore linked, authorized)', () => {
      const mockAuthUser = {
        uid: 'uid_migrated_commercial',
        email: 'aayala@ductsal.com',
        metadata: {
          creationTime: '2026-10-18T05:01:00Z',
          lastSignInTime: null
        },
        customClaims: { cid: '1776904514932' }
      };

      const mockFirestoreProfile = {
        id: '1776904514932',
        authUid: 'uid_migrated_commercial'
      };

      const res = evaluateAuthAccountForRollback(mockAuthUser, {
        cid: '1776904514932',
        firestoreProfile: mockFirestoreProfile,
        confirmDelete: 'YES',
        requireAuditProvenance: true,
        hasAuditProvenance: true
      });

      expect(res.canDelete).toBe(true);
      expect(res.stopCondition).toBeNull();
      expect(res.action).toBe('DELETE_PERMITTED');
    });
  });

  describe('4. Firestore Selective Unlinking & Preservation of Subsequent Changes', () => {
    let mockFirestoreData;
    let mockDb;

    beforeEach(() => {
      mockFirestoreData = {
        id: '1776904514932',
        nombre: 'Adalberto Ayala',
        email: 'aayala@ductsal.com',
        role: 'gestor',
        activo: true,
        password: 'historicalPassword123',
        authUid: 'uid_target_123',
        authProvider: 'firebase',
        departamento: 'Ventas Especiales',
        subsequentEditTimestamp: '2026-10-18T05:30:00Z',
        customMetadata: { branch: 'SV-Central', tags: ['vip'] }
      };

      mockDb = {
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            get: jest.fn()
          })
        }),
        runTransaction: jest.fn(async (cb) => {
          const tx = {
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({ ...mockFirestoreData })
            }),
            update: jest.fn((ref, updates) => {
              for (const [k, v] of Object.entries(updates)) {
                if (v && (v.constructor?.name === 'DeleteTransform' || v.constructor?.name === 'FieldValue' || v.isDelete)) {
                  delete mockFirestoreData[k];
                } else {
                  mockFirestoreData[k] = v;
                }
              }
            })
          };
          return await cb(tx);
        })
      };
    });

    test('preserves 100% of business fields and subsequent legitimate changes when unlinking', async () => {
      const result = await safeUnlinkFirestoreProfile(mockDb, {
        cid: '1776904514932',
        uid: 'uid_target_123'
      });

      expect(result.unlinked).toBe(true);

      // authUid and authProvider were removed
      expect(mockFirestoreData.authUid).toBeUndefined();
      expect(mockFirestoreData.authProvider).toBeUndefined();

      // ALL other business fields and subsequent changes remain 100% intact
      expect(mockFirestoreData.id).toBe('1776904514932');
      expect(mockFirestoreData.nombre).toBe('Adalberto Ayala');
      expect(mockFirestoreData.email).toBe('aayala@ductsal.com');
      expect(mockFirestoreData.role).toBe('gestor');
      expect(mockFirestoreData.activo).toBe(true);
      expect(mockFirestoreData.password).toBe('historicalPassword123');
      expect(mockFirestoreData.departamento).toBe('Ventas Especiales');
      expect(mockFirestoreData.subsequentEditTimestamp).toBe('2026-10-18T05:30:00Z');
      expect(mockFirestoreData.customMetadata).toEqual({ branch: 'SV-Central', tags: ['vip'] });
    });

    test('aborts transaction and throws if authUid was concurrently modified to another account', async () => {
      mockFirestoreData.authUid = 'uid_concurrent_other_999';

      await expect(safeUnlinkFirestoreProfile(mockDb, {
        cid: '1776904514932',
        uid: 'uid_target_123' // Mismatched expected UID
      })).rejects.toThrow(/Conflicto de concurrencia.*difiere del UID/);

      // Confirms nothing was deleted
      expect(mockFirestoreData.authUid).toBe('uid_concurrent_other_999');
    });

    test('aborts transaction and throws if target profile does not exist in Firestore', async () => {
      mockDb.runTransaction = jest.fn(async (cb) => {
        const tx = {
          get: jest.fn().mockResolvedValue({
            exists: false,
            data: () => null
          })
        };
        return await cb(tx);
      });

      await expect(safeUnlinkFirestoreProfile(mockDb, {
        cid: '9999999999999',
        uid: 'uid_target_123'
      })).rejects.toThrow(/Perfil 9999999999999 no existe en Firestore/);
    });
  });

  describe('5. Strict Order of Operations & End-to-End Safe Rollback', () => {
    let callSequence;
    let mockAdmin;
    let mockAuthUser;
    let mockProfile;

    beforeEach(() => {
      callSequence = [];

      mockAuthUser = {
        uid: 'uid_test_mgr',
        email: 'bvaliente@grupogama.com',
        metadata: {
          creationTime: '2026-10-18T05:00:00Z',
          lastSignInTime: null
        },
        customClaims: { role: 'manager', manager: true }
      };

      mockProfile = {
        id: '1776895495203',
        email: 'bvaliente@grupogama.com',
        authUid: 'uid_test_mgr',
        authProvider: 'firebase'
      };

      const authInstance = {
        getUser: jest.fn(async (uid) => {
          callSequence.push(`auth.getUser(${uid})`);
          return mockAuthUser;
        }),
        setCustomUserClaims: jest.fn(async (uid, claims) => {
          callSequence.push(`auth.setCustomUserClaims(${uid}, ${JSON.stringify(claims)})`);
        }),
        revokeRefreshTokens: jest.fn(async (uid) => {
          callSequence.push(`auth.revokeRefreshTokens(${uid})`);
        }),
        deleteUser: jest.fn(async (uid) => {
          callSequence.push(`auth.deleteUser(${uid})`);
        }),
        updateUser: jest.fn(async (uid, payload) => {
          callSequence.push(`auth.updateUser(${uid}, ${JSON.stringify(payload)})`);
        })
      };

      const firestoreInstance = {
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({ ...mockProfile })
            })
          }))
        })),
        runTransaction: jest.fn(async (cb) => {
          callSequence.push('firestore.runTransaction');
          const tx = {
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({ ...mockProfile })
            }),
            update: jest.fn((ref, updates) => {
              callSequence.push(`firestore.tx.update(${Object.keys(updates).join(',')})`);
            })
          };
          return await cb(tx);
        })
      };

      mockAdmin = {
        auth: () => authInstance,
        firestore: () => firestoreInstance
      };
    });

    test('end-to-end rollback on newly created account with confirmation enforces correct order: Neutralize Claims -> Unlink Firestore -> Delete Auth', async () => {
      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        isPreexisting: false,
        confirmDelete: 'YES'
      });

      expect(res.status).toBe('COMPLETED_USER_DELETED');
      expect(res.claimsNeutralized).toBe(true);
      expect(res.tokensRevoked).toBe(true);
      expect(res.firestoreUnlinked).toBe(true);
      expect(res.authDeleted).toBe(true);

      // Verify exact architectural order:
      // 1. Inspect Auth user
      expect(callSequence[0]).toBe('auth.getUser(uid_test_mgr)');
      // 2. Neutralize claims & revoke tokens FIRST
      expect(callSequence[1]).toBe('auth.setCustomUserClaims(uid_test_mgr, {})');
      expect(callSequence[2]).toBe('auth.revokeRefreshTokens(uid_test_mgr)');
      // 3. Unlink in Firestore SECOND
      expect(callSequence[3]).toBe('firestore.runTransaction');
      expect(callSequence[4]).toBe('firestore.tx.update(authUid,authProvider)');
      // 4. Delete Auth user LAST
      expect(callSequence[5]).toBe('auth.deleteUser(uid_test_mgr)');
    });

    test('end-to-end rollback on pre-existing account: restores prior claims, unlinks Firestore, NEVER deletes Auth', async () => {
      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        isPreexisting: true,
        priorClaims: { previousRole: 'viewer' },
        confirmDelete: 'YES'
      });

      expect(res.status).toBe('STOPPED_PRESERVED');
      expect(res.authDeleted).toBe(false);
      expect(res.stopCondition).toBe('PREEXISTING_ACCOUNT');

      // Prior claims restored
      expect(callSequence).toContain('auth.setCustomUserClaims(uid_test_mgr, {"previousRole":"viewer"})');
      // Auth deleteUser was NEVER called
      expect(callSequence).not.toContain('auth.deleteUser(uid_test_mgr)');
    });

    test('end-to-end rollback on account with sign-in activity: disables account instead of deleting', async () => {
      mockAuthUser.metadata.lastSignInTime = '2026-10-18T05:15:00Z'; // Has activity!

      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        isPreexisting: false,
        confirmDelete: 'YES',
        forceDisableIfActive: true
      });

      expect(res.status).toBe('COMPLETED_USER_DISABLED');
      expect(res.authDeleted).toBe(false);
      expect(res.authDisabled).toBe(true);
      expect(res.stopCondition).toBe('USER_ACTIVITY_DETECTED');

      // Account was disabled, NOT deleted
      expect(callSequence).toContain('auth.updateUser(uid_test_mgr, {"disabled":true})');
      expect(callSequence).not.toContain('auth.deleteUser(uid_test_mgr)');
    });

    test('reattempt of rollback after profile was already unlinked refuses deletion without audit provenance', async () => {
      // Simulate profile already unlinked from previous partial rollback attempt
      delete mockProfile.authUid;
      delete mockProfile.authProvider;

      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        isPreexisting: false,
        confirmDelete: 'YES',
        hasAuditProvenance: false // No immutable audit record provided
      });

      expect(res.authDeleted).toBe(false);
      expect(res.stopCondition).toBe('MISSING_PROVENANCE_FOR_UNLINKED_PROFILE');
      expect(res.status).toBe('STOPPED_PRESERVED');
      expect(callSequence).not.toContain('auth.deleteUser(uid_test_mgr)');
    });

    test('reattempt of rollback after profile was already unlinked succeeds in deleting Auth user when opId audit record confirms ownership', async () => {
      // Profile already unlinked
      delete mockProfile.authUid;
      delete mockProfile.authProvider;

      // Mock userOps collection containing immutable audit record for opId
      const mockOpRecord = {
        profileId: '1776895495203',
        result: { uid: 'uid_test_mgr' },
        action: 'linkHistoricalUser'
      };

      const origCollection = mockAdmin.firestore().collection;
      mockAdmin.firestore().collection = jest.fn((colName) => {
        if (colName === 'userOps') {
          return {
            doc: jest.fn((id) => ({
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: () => ({ ...mockOpRecord })
              })
            }))
          };
        }
        return origCollection(colName);
      });

      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        opId: 'op_link_commercial_123',
        isPreexisting: false,
        confirmDelete: 'YES'
      });

      expect(res.authDeleted).toBe(true);
      expect(res.status).toBe('COMPLETED_USER_DELETED');
      expect(callSequence).toContain('auth.deleteUser(uid_test_mgr)');
    });

    test('reattempt on pre-existing account against already-unlinked profile still preserves Auth user', async () => {
      // Profile already unlinked
      delete mockProfile.authUid;
      delete mockProfile.authProvider;

      const res = await executeSafeRollback(mockAdmin, {
        cid: '1776895495203',
        uid: 'uid_test_mgr',
        isPreexisting: true,
        confirmDelete: 'YES'
      });

      expect(res.authDeleted).toBe(false);
      expect(res.stopCondition).toBe('PREEXISTING_ACCOUNT');
      expect(callSequence).not.toContain('auth.deleteUser(uid_test_mgr)');
    });
  });
});
