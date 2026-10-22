// functions/__tests__/inventoryUsersProd.unit.test.js
// Unit tests for the SEC-01 / SEC-03 read-only preflight inventory script.
// Uses fake in-memory Firestore and Auth; never touches real resources.

const { auditUsersProd, parseArgs } = require('../scripts/inventoryUsersProd');

function createFakeDoc(id, data) {
  return {
    id,
    data: () => ({ ...data })
  };
}

function createFakeFirestore(docsArray) {
  return {
    collection: (name) => {
      return {
        get: async () => ({
          size: docsArray.length,
          docs: docsArray.map(d => createFakeDoc(d.id, d.data))
        })
      };
    }
  };
}

describe('inventoryUsersProd Unit Tests', () => {

  describe('parseArgs', () => {
    test('parses flags correctly', () => {
      const args = parseArgs(['--project', 'ductsal-erp', '--allow-authorized-production-run', '--json', '--check-auth']);
      expect(args.project).toBe('ductsal-erp');
      expect(args.allowProduction).toBe(true);
      expect(args.outputJson).toBe(true);
      expect(args.checkAuth).toBe(true);
    });

    test('defaults to safe values', () => {
      const args = parseArgs([]);
      expect(args.project).toBeNull();
      expect(args.allowProduction).toBe(false);
      expect(args.outputJson).toBe(false);
      expect(args.checkAuth).toBe(false);
    });
  });

  describe('auditUsersProd categorization & counting', () => {
    test('accurately categorizes commercial, plant, and unknown records without exposing passwords', async () => {
      const mockDocs = [
        // 1. Benjamin (Active Commercial Manager)
        {
          id: '1776895495203',
          data: {
            id: '1776895495203',
            nombre: 'Benjamin Valiente',
            email: 'bvaliente@grupogama.com',
            role: 'manager',
            activo: true,
            authUid: 'uid-benjamin',
            password: 'secret_plain_text_123'
          }
        },
        // 2. Denys (Active Commercial Manager)
        {
          id: '1776904494660',
          data: {
            id: '1776904494660',
            nombre: 'Denys González',
            email: 'dgonzalez@ductsal.com',
            role: 'manager',
            activo: true,
            authUid: 'uid-denys'
            // password already purged
          }
        },
        // 3. Alejandra (Active Commercial Gestor)
        {
          id: '1776904514932',
          data: {
            id: '1776904514932',
            nombre: 'Alejandra Ayala',
            email: 'aayala@ductsal.com',
            role: 'gestor',
            activo: true,
            authUid: 'uid-alejandra',
            password: 'plain_gestor_pass'
          }
        },
        // 4. Roberto (Active Commercial Vendedor)
        {
          id: '1788471603604',
          data: {
            id: '1788471603604',
            nombre: 'Roberto Flores',
            email: 'rflores@ductsal.com',
            role: 'vendedor',
            activo: true,
            authUid: 'uid-roberto',
            password: 'plain_vendedor_pass'
          }
        },
        // 5. Gustavo Velásquez (Inactive Commercial Vendedor)
        {
          id: '1784221928346',
          data: {
            id: '1784221928346',
            nombre: 'Gustavo Velásquez',
            email: 'gvelasquez@ductsal.com',
            role: 'vendedor',
            activo: false,
            password: 'plain_inactive_pass'
          }
        },
        // 6. Plant Operator (Fabrication)
        {
          id: '1800000000001',
          data: {
            id: '1800000000001',
            nombre: 'Operario Taller',
            email: 'operario1@ductsal.com',
            role: 'operario',
            activo: true,
            pin: '1234',
            password: '5678'
          }
        },
        // 7. Unknown / Legacy record
        {
          id: '9999999999999',
          data: {
            id: '9999999999999',
            nombre: 'Test Legacy User',
            email: 'legacy@example.com',
            role: 'custom_unknown_role',
            activo: true
          }
        }
      ];

      const fakeAdmin = {
        firestore: () => createFakeFirestore(mockDocs)
      };

      const result = await auditUsersProd(fakeAdmin, { checkAuth: false });

      expect(result.totalDocuments).toBe(7);
      expect(result.totalWithPassword).toBe(5); // Benjamin, Alejandra, Roberto, Gustavo, Operario
      expect(result.totalWithoutPassword).toBe(2); // Denys, Legacy
      expect(result.totalWithAuthUid).toBe(4); // Benjamin, Denys, Alejandra, Roberto

      // Categories
      expect(result.categories.activeCommercial.count).toBe(4);
      expect(result.categories.activeCommercial.withPassword).toBe(3);
      expect(result.categories.activeCommercial.withAuthUid).toBe(4);

      expect(result.categories.inactiveCommercial.count).toBe(1);
      expect(result.categories.inactiveCommercial.withPassword).toBe(1);
      expect(result.categories.inactiveCommercial.withAuthUid).toBe(0);

      expect(result.categories.plantFabrication.count).toBe(1);
      expect(result.categories.plantFabrication.withPassword).toBe(1);
      expect(result.categories.plantFabrication.withPin).toBe(1);

      expect(result.categories.unknownRecords.count).toBe(1);
      expect(result.categories.unknownRecords.withPassword).toBe(0);

      // Verify that no passwords leaked into items
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret_plain_text_123');
      expect(serialized).not.toContain('plain_gestor_pass');
      expect(serialized).not.toContain('plain_vendedor_pass');
      expect(serialized).not.toContain('plain_inactive_pass');
      expect(serialized).not.toContain('5678');
    });

    test('flags schema anomalies without revealing sensitive data', async () => {
      const mockDocs = [
        {
          id: '12345',
          data: {
            // Missing email
            role: 'vendedor',
            activo: 'not_a_boolean', // Invalid activo
            password: 'secret_leak_attempt'
          }
        },
        {
          id: '12346',
          data: {
            id: 'mismatch_id', // ID mismatch
            email: 'bad_email_format', // Invalid email
            activo: true
            // Missing role
          }
        }
      ];

      const fakeAdmin = {
        firestore: () => createFakeFirestore(mockDocs)
      };

      const result = await auditUsersProd(fakeAdmin);

      expect(result.schemaAnomalies.length).toBeGreaterThanOrEqual(4);
      const anomaliesStr = JSON.stringify(result.schemaAnomalies);
      expect(anomaliesStr).toContain('MISSING_OR_INVALID_EMAIL');
      expect(anomaliesStr).toContain('MISSING_ROLE');
      expect(anomaliesStr).toContain('NON_BOOLEAN_ACTIVO');
      expect(anomaliesStr).toContain('FIELD_ID_MISMATCH');
      expect(anomaliesStr).not.toContain('secret_leak_attempt');
    });

    test('verifies Firebase Auth users when checkAuth is enabled', async () => {
      const mockDocs = [
        {
          id: '1776895495203',
          data: {
            id: '1776895495203',
            email: 'bvaliente@grupogama.com',
            role: 'manager',
            activo: true,
            authUid: 'uid-benjamin'
          }
        },
        {
          id: '1776904494660',
          data: {
            id: '1776904494660',
            email: 'dgonzalez@ductsal.com',
            role: 'manager',
            activo: true,
            authUid: 'uid-denys'
          }
        },
        {
          id: '1776904514932',
          data: {
            id: '1776904514932',
            email: 'aayala@ductsal.com',
            role: 'gestor',
            activo: true,
            authUid: 'uid-alejandra'
          }
        },
        {
          id: '1788471603604',
          data: {
            id: '1788471603604',
            email: 'rflores@ductsal.com',
            role: 'vendedor',
            activo: true,
            authUid: 'uid-roberto'
          }
        }
      ];

      const fakeAuthUsers = {
        'uid-benjamin': {
          uid: 'uid-benjamin',
          email: 'bvaliente@grupogama.com',
          disabled: false,
          customClaims: { role: 'manager', manager: true, cid: '1776895495203' },
          metadata: { lastSignInTime: '2026-10-21T12:00:00Z' }
        },
        'uid-denys': {
          uid: 'uid-denys',
          email: 'dgonzalez@ductsal.com',
          disabled: false,
          customClaims: { role: 'manager', manager: true, cid: '1776904494660' },
          metadata: { lastSignInTime: '2026-10-21T12:05:00Z' }
        },
        'uid-alejandra': {
          uid: 'uid-alejandra',
          email: 'aayala@ductsal.com',
          disabled: false,
          customClaims: { role: 'gestor', cid: '1776904514932' },
          metadata: { lastSignInTime: '2026-10-21T12:10:00Z' }
        },
        'uid-roberto': {
          uid: 'uid-roberto',
          email: 'rflores@ductsal.com',
          disabled: false,
          customClaims: { role: 'vendedor', cid: '1788471603604' },
          metadata: { lastSignInTime: '2026-10-21T12:15:00Z' }
        }
      };

      const fakeAdmin = {
        firestore: () => createFakeFirestore(mockDocs),
        auth: () => ({
          getUser: async (uid) => {
            if (fakeAuthUsers[uid]) return fakeAuthUsers[uid];
            const err = new Error('User not found');
            err.code = 'auth/user-not-found';
            throw err;
          },
          getUserByEmail: async (email) => {
            const found = Object.values(fakeAuthUsers).find(u => u.email === email);
            if (found) return found;
            const err = new Error('User not found');
            err.code = 'auth/user-not-found';
            throw err;
          }
        })
      };

      const result = await auditUsersProd(fakeAdmin, { checkAuth: true });

      expect(result.authVerification.performed).toBe(true);
      expect(result.authVerification.activeCommercialResults).toHaveLength(4);

      for (const r of result.authVerification.activeCommercialResults) {
        expect(r.authExists).toBe(true);
        expect(r.uidMatches).toBe(true);
        expect(r.claimsMatch).toBe(true);
        expect(r.disabled).toBe(false);
        expect(r.lastSignInTimePresent).toBe(true);
      }
    });
  });
});
