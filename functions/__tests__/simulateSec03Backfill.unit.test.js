// functions/__tests__/simulateSec03Backfill.unit.test.js
// Unit tests for the SEC-03 Phase F2 simulation and dry-run backfill planner.

const {
  planProspectsBackfill,
  planClientsVisibilityBackfill,
  planUserDirectorySync,
  runBackfillSimulation,
  resolveSellerNameToCid,
  KNOWN_USERS
} = require('../scripts/simulateSec03Backfill');

describe('SEC-03 Phase F2: Simulation & Dry-Run Backfill Planner', () => {

  describe('resolveSellerNameToCid', () => {
    test('resolves known seller names case-insensitively', () => {
      expect(resolveSellerNameToCid('Alejandra Ayala')).toBe('1776904514932');
      expect(resolveSellerNameToCid('alejandra ayala')).toBe('1776904514932');
      expect(resolveSellerNameToCid('Roberto Flores')).toBe('1788471603604');
      expect(resolveSellerNameToCid('Gustavo Velásquez')).toBe('1784221928346');
    });

    test('returns null for unknown or invalid names', () => {
      expect(resolveSellerNameToCid('Desconocido Inc')).toBeNull();
      expect(resolveSellerNameToCid('')).toBeNull();
      expect(resolveSellerNameToCid(null)).toBeNull();
    });
  });

  describe('planProspectsBackfill', () => {
    test('identifies up-to-date prospects having both createdBy and vendedorId', () => {
      const prospects = [
        { id: 'P-1', createdBy: '1788471603604', vendedorId: '1788471603604', vendedor: 'Roberto Flores' }
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.upToDate).toHaveLength(1);
      expect(plan.proposedUpdates).toHaveLength(0);
      expect(plan.ambiguousManualReview).toHaveLength(0);
    });

    test('resolves missing createdBy from known vendedor string (Alejandra batch case)', () => {
      const prospects = [
        { id: 'OPP-101', vendedor: 'Alejandra Ayala', etapa: 'cierre', estado: 'ganado' }
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.upToDate).toHaveLength(0);
      expect(plan.proposedUpdates).toHaveLength(1);
      expect(plan.proposedUpdates[0]).toMatchObject({
        id: 'OPP-101',
        category: 'PROSPECT_MISSING_CREATED_BY_RESOLVED',
        proposedPatch: {
          createdBy: '1776904514932',
          vendedorId: '1776904514932'
        }
      });
      expect(plan.ambiguousManualReview).toHaveLength(0);
    });

    test('resolves missing createdBy when vendedorId is already present', () => {
      const prospects = [
        { id: 'OPP-102', vendedorId: '1776904514932', vendedor: 'Alejandra Ayala' }
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.proposedUpdates).toHaveLength(1);
      expect(plan.proposedUpdates[0].proposedPatch).toEqual({
        createdBy: '1776904514932'
      });
    });

    test('flags prospect as ambiguous when createdBy is missing and vendedor cannot be resolved', () => {
      const prospects = [
        { id: 'OPP-999', vendedor: 'Persona Inexistente', etapa: 'cotizacion' }
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.proposedUpdates).toHaveLength(0);
      expect(plan.ambiguousManualReview).toHaveLength(1);
      expect(plan.ambiguousManualReview[0]).toMatchObject({
        id: 'OPP-999',
        category: 'PROSPECT_MISSING_CREATED_BY_UNRESOLVED'
      });
    });

    test('standardizes missing vendedorId from existing createdBy', () => {
      const prospects = [
        { id: 'OPP-58', createdBy: '1776904514932' } // 58 docs in prod have this pattern
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.proposedUpdates).toHaveLength(1);
      expect(plan.proposedUpdates[0]).toMatchObject({
        id: 'OPP-58',
        category: 'PROSPECT_MISSING_VENDEDOR_ID_STANDARDIZED',
        proposedPatch: {
          vendedorId: '1776904514932'
        }
      });
    });

    test('detects conflict when createdBy and vendedor string contradict each other', () => {
      const prospects = [
        { id: 'OPP-CONFLICT', createdBy: '1788471603604', vendedor: 'Alejandra Ayala' }
      ];
      const plan = planProspectsBackfill(prospects);
      expect(plan.ambiguousManualReview).toHaveLength(1);
      expect(plan.ambiguousManualReview[0].category).toBe('PROSPECT_CREATEDBY_VENDEDOR_CONFLICT');
    });
  });

  describe('planClientsVisibilityBackfill', () => {
    test('calculates visibleTo and closingVendors correctly from linked prospects', () => {
      const clients = [
        { id: 'C-1', createdBy: '1788471603604', visibleTo: null, closingVendors: null }
      ];
      const prospects = [
        { id: 'P-1', clientId: 'C-1', createdBy: '1788471603604', vendedorId: '1788471603604', etapa: 'cierre', estado: 'ganado' },
        { id: 'P-2', clientId: 'C-1', createdBy: '1776904514932', vendedorId: '1776904514932', etapa: 'cotizacion', estado: 'activo' },
        { id: 'P-3_DEL', clientId: 'C-1', createdBy: '1784221928346', eliminado: true } // soft-deleted must be ignored
      ];

      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.proposedUpdates).toHaveLength(1);
      expect(plan.proposedUpdates[0].proposedPatch).toEqual({
        visibleTo: ['1776904514932', '1788471603604'],
        closingVendors: ['1788471603604']
      });
      expect(plan.missingCreatedByResolved).toHaveLength(0);
      expect(plan.ambiguousManualReview).toHaveLength(0);
    });

    test('ignores sistema pseudo-vendor in visibility calculations', () => {
      const clients = [{ id: 'C-SIS', createdBy: '1788471603604', visibleTo: [], closingVendors: [] }];
      const prospects = [
        { id: 'P-SIS', clientId: 'C-SIS', createdBy: 'sistema', vendedorId: 'sistema' }
      ];
      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.upToDate).toHaveLength(1); // empty visibleTo matches []
    });

    test('resolves missing createdBy when all linked prospects unanimously belong to one seller', () => {
      const clients = [
        { id: 'CUST-HISTORICAL', empresa: 'Empresa X', createdBy: null }
      ];
      const prospects = [
        { id: 'OPP-1', clientId: 'CUST-HISTORICAL', vendedor: 'Alejandra Ayala', etapa: 'cierre', estado: 'ganado' },
        { id: 'OPP-2', clientId: 'CUST-HISTORICAL', vendedorId: '1776904514932', etapa: 'negociacion', estado: 'activo' }
      ];

      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.missingCreatedByResolved).toHaveLength(1);
      expect(plan.missingCreatedByResolved[0]).toMatchObject({
        id: 'CUST-HISTORICAL',
        proposedCreatedBy: '1776904514932',
        proposedPatch: {
          createdBy: '1776904514932',
          visibleTo: ['1776904514932'],
          closingVendors: ['1776904514932']
        }
      });
    });

    test('flags client with no linked prospects (orphaned) for manual review', () => {
      const clients = [
        { id: 'CUST-ORPHAN', empresa: 'Huérfano', createdBy: null }
      ];
      const prospects = [];

      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.ambiguousManualReview).toHaveLength(1);
      expect(plan.ambiguousManualReview[0].category).toBe('CLIENT_ORPHANED_NO_PROSPECTS');
    });

    test('flags client without createdBy having conflicting prospect creators for manual review', () => {
      const clients = [
        { id: 'CUST-MULTI', empresa: 'Multi', createdBy: null }
      ];
      const prospects = [
        { id: 'OPP-A', clientId: 'CUST-MULTI', createdBy: '1776904514932' },
        { id: 'OPP-B', clientId: 'CUST-MULTI', createdBy: '1788471603604' }
      ];

      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.ambiguousManualReview).toHaveLength(1);
      expect(plan.ambiguousManualReview[0].category).toBe('CLIENT_CONFLICTING_PROSPECT_OWNERS');
    });

    test('identifies up-to-date clients when visibleTo and closingVendors already match exactly', () => {
      const clients = [
        {
          id: 'C-OK',
          createdBy: '1788471603604',
          visibleTo: ['1788471603604'],
          closingVendors: ['1788471603604']
        }
      ];
      const prospects = [
        { id: 'P-OK', clientId: 'C-OK', createdBy: '1788471603604', vendedorId: '1788471603604', etapa: 'cierre', estado: 'ganado' }
      ];

      const plan = planClientsVisibilityBackfill(clients, prospects);
      expect(plan.upToDate).toHaveLength(1);
      expect(plan.proposedUpdates).toHaveLength(0);
    });
  });

  describe('planUserDirectorySync', () => {
    test('projects strictly safe public fields { id, nombre, role, activo }', () => {
      const users = [
        {
          id: '1776895495203',
          nombre: 'Benjamin Valiente',
          role: 'manager',
          activo: true,
          email: 'bvaliente@grupogama.com',
          password: 'plainPassword123',
          authUid: 'UID_123',
          authProvider: 'firebase'
        }
      ];

      const plan = planUserDirectorySync(users, []);
      expect(plan.toCreate).toHaveLength(1);
      expect(plan.toCreate[0].projection).toEqual({
        id: '1776895495203',
        nombre: 'Benjamin Valiente',
        role: 'manager',
        activo: true
      });
      // Zero secrets or private keys
      expect(plan.toCreate[0].projection.password).toBeUndefined();
      expect(plan.toCreate[0].projection.email).toBeUndefined();
      expect(plan.toCreate[0].projection.authUid).toBeUndefined();
    });

    test('identifies up-to-date directory documents', () => {
      const users = [
        { id: '1788471603604', nombre: 'Roberto Flores', role: 'vendedor', activo: true }
      ];
      const currentDir = [
        { id: '1788471603604', nombre: 'Roberto Flores', role: 'vendedor', activo: true }
      ];

      const plan = planUserDirectorySync(users, currentDir);
      expect(plan.upToDate).toHaveLength(1);
      expect(plan.toCreate).toHaveLength(0);
      expect(plan.toUpdate).toHaveLength(0);
    });

    test('identifies stale/orphaned directory documents to delete', () => {
      const users = [];
      const currentDir = [
        { id: 'OLD-DELETED', nombre: 'Usuario Borrado', role: 'vendedor', activo: false }
      ];

      const plan = planUserDirectorySync(users, currentDir);
      expect(plan.toDelete).toHaveLength(1);
      expect(plan.toDelete[0].id).toBe('OLD-DELETED');
    });

    test('strictly fails if sensitive keys ever enter the projected object', () => {
      // Monkey patch or verify internal assertion
      const badUser = { id: 'U1', nombre: 'Test', password: 'secret', role: 'vendedor', activo: true };
      // planUserDirectorySync explicitly strips them, but if someone forces sensitive field:
      expect(() => {
        // Test that the projection will never include password even if bad data is fed
        const res = planUserDirectorySync([badUser]);
        expect(res.toCreate[0].projection.password).toBeUndefined();
      }).not.toThrow();
    });
  });

  describe('runBackfillSimulation safeguards', () => {
    test('throws immediately if readOnly is false', async () => {
      await expect(runBackfillSimulation({ db: {}, projectId: 'ductsal-erp', readOnly: false }))
        .rejects.toThrow('SAFEGUARD: This script is strictly read-only. Mutation mode is disabled.');
    });

    test('throws immediately if projectId is not ductsal-erp', async () => {
      await expect(runBackfillSimulation({ db: {}, projectId: 'wrong-project', readOnly: true }))
        .rejects.toThrow('ABORT: Target project is not "ductsal-erp"');
    });
  });

});
