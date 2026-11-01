// functions/__tests__/commercialAttributionMigration.unit.test.js
// Unit tests for DUCTSAL ERP Commercial Attribution Migration & Diagnostic.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const {
  auditAndClassifyProspects,
  buildMigrationPlan,
  executeCommercialAttributionMigration,
  rollbackCommercialAttributionMigration,
  chunkArray,
  FORBIDDEN_PATCH_FIELDS
} = require('../scripts/commercialAttributionMigration');

describe('Commercial Attribution Migration & Diagnostic Unit Tests', () => {
  let db;

  const mockUsers = {
    '1776895495203': { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true },
    '1776904494660': { id: '1776904494660', nombre: 'Denys González', role: 'manager', activo: true },
    '1776904514932': { id: '1776904514932', nombre: 'Alejandra Ayala', role: 'gestor', activo: true },
    '1784221928346': { id: '1784221928346', nombre: 'Gustavo Velásquez', role: 'vendedor', activo: false },
    '1788471603604': { id: '1788471603604', nombre: 'Roberto Flores', role: 'vendedor', activo: true }
  };

  beforeEach(() => {
    db = createFakeFirestore();
  });

  describe('Classification Logic', () => {
    test('correctly identifies all 6 required categories', () => {
      const prospects = [
        // 1. Asignación correcta
        {
          id: 'P_CORRECT',
          proyecto: 'Proyecto Correcto',
          createdBy: '1788471603604',
          vendedorId: '1788471603604',
          vendedorName: 'Roberto Flores',
          vendedorRole: 'vendedor'
        },
        // 2. Sin vendedorId, pero con responsable verificable (via createdBy)
        {
          id: 'P_MISSING_VENDEDOR_1',
          proyecto: 'Proyecto Creado Por Alejandra',
          createdBy: '1776904514932'
        },
        // 2. Sin vendedorId, pero con responsable verificable (via vendedor string - VISTA TOWER 2 case)
        {
          id: 'OPP-1777081083975-23',
          proyecto: 'VISTA TOWER 2',
          vendedor: 'Alejandra Ayala'
        },
        // 3. vendedorId que no corresponde a usuario válido
        {
          id: 'P_INVALID_USER',
          proyecto: 'Proyecto Usuario Fantasma',
          vendedorId: '9999999999999'
        },
        // 4. Inconsistencia entre nombre e identificador
        {
          id: 'P_NAME_MISMATCH',
          proyecto: 'Proyecto Inconsistente',
          vendedorId: '1788471603604',
          vendedorName: 'Nombre Equivocado',
          vendedorRole: 'vendedor'
        },
        // 5. Asignación ambigua (createdBy de Roberto pero vendedor de Alejandra)
        {
          id: 'P_AMBIGUOUS',
          proyecto: 'Proyecto Conflicto',
          createdBy: '1788471603604',
          vendedor: 'Alejandra Ayala'
        },
        // 6. Oportunidades sin responsable identificado
        {
          id: 'P_NO_RESPONSIBLE',
          proyecto: 'Proyecto Huérfano'
        }
      ];

      const audit = auditAndClassifyProspects(prospects, mockUsers);

      expect(audit.total).toBe(7);
      expect(audit.counts.correct).toBe(1);
      expect(audit.counts.missingVendedorVerifiable).toBe(2);
      expect(audit.counts.invalidVendedorId).toBe(1);
      expect(audit.counts.nameIdInconsistency).toBe(1);
      expect(audit.counts.ambiguousAssignment).toBe(1);
      expect(audit.counts.noIdentifiedResponsible).toBe(1);

      // Verify VISTA TOWER 2 resolution
      const vt = audit.categories.missingVendedorVerifiable.find(p => p.id === 'OPP-1777081083975-23');
      expect(vt).toBeDefined();
      expect(vt.responsableActual).toBe('Alejandra Ayala');
      expect(vt.responsableId).toBe('1776904514932');
      expect(vt.responsableRole).toBe('gestor');
      expect(vt.after).toEqual({
        vendedorId: '1776904514932',
        vendedorName: 'Alejandra Ayala',
        vendedorRole: 'gestor'
      });
    });

    test('preserves historical creator and distinguishes from responsible seller', () => {
      const prospects = [
        {
          id: 'P_REASSIGNED_HISTORICALLY',
          proyecto: 'Proyecto Reasignado',
          createdBy: '1776904514932', // Alejandra created it
          vendedorId: '1788471603604', // Roberto is current vendor
          vendedorName: 'Roberto Flores',
          vendedorRole: 'vendedor',
          logs: [
            { text: 'Prospecto creado por Alejandra Ayala.', auto: true },
            { text: 'Vendedor reasignado a Roberto Flores.', auto: true }
          ]
        }
      ];

      const audit = auditAndClassifyProspects(prospects, mockUsers);
      expect(audit.counts.correct).toBe(1);
      const doc = audit.categories.correct[0];
      expect(doc.createdBy).toBe('1776904514932');
      expect(doc.vendedorId).toBe('1788471603604');
      expect(doc.historialGestores).toContain('Alejandra Ayala');
      expect(doc.historialGestores).toContain('Roberto Flores');
    });
  });

  describe('Dry-Run Safeguard', () => {
    test('dry-run mode does not perform any writes in Firestore', async () => {
      // Seed users
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      // Seed prospects
      db.seed('prospects_prod/OPP-1777081083975-23', {
        id: 'OPP-1777081083975-23',
        proyecto: 'VISTA TOWER 2',
        vendedor: 'Alejandra Ayala',
        precio_cotizado: 30337.41,
        estado: 'activo',
        etapa: 'negociacion'
      });

      const plan = await buildMigrationPlan(db);
      const commitsBefore = db.state.commits;

      const summary = await executeCommercialAttributionMigration(db, plan, { dryRun: true });

      expect(summary.mode).toBe('DRY_RUN');
      expect(summary.mutationsPlannedCount).toBe(1);
      expect(db.state.commits).toBe(commitsBefore); // 0 writes!

      // Document in DB is untouched
      const rawDoc = db.data('prospects_prod/OPP-1777081083975-23');
      expect(rawDoc.vendedorId).toBeUndefined();
      expect(rawDoc.vendedorName).toBeUndefined();
      expect(rawDoc.precio_cotizado).toBe(30337.41);
    });
  });

  describe('Live Apply & Idempotence', () => {
    test('live apply updates commercial attribution without touching financial or stage data', async () => {
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      db.seed('prospects_prod/OPP-1777081083975-23', {
        id: 'OPP-1777081083975-23',
        proyecto: 'VISTA TOWER 2',
        vendedor: 'Alejandra Ayala',
        precio_cotizado: 30337.41,
        costo_venta: 21786.29,
        estado: 'activo',
        etapa: 'negociacion',
        facturas: []
      });

      const plan = await buildMigrationPlan(db);
      const res = await executeCommercialAttributionMigration(db, plan, {
        dryRun: false,
        opId: 'test_attr_apply_01'
      });

      expect(res.status).toBe('SUCCEEDED');
      expect(res.appliedCount).toBe(1);

      // Verify Firestore state
      const updatedDoc = db.data('prospects_prod/OPP-1777081083975-23');
      expect(updatedDoc.vendedorId).toBe('1776904514932');
      expect(updatedDoc.vendedorName).toBe('Alejandra Ayala');
      expect(updatedDoc.vendedorRole).toBe('gestor');

      // Financial & stage fields are strictly preserved
      expect(updatedDoc.precio_cotizado).toBe(30337.41);
      expect(updatedDoc.costo_venta).toBe(21786.29);
      expect(updatedDoc.estado).toBe('activo');
      expect(updatedDoc.etapa).toBe('negociacion');
      expect(updatedDoc.facturas).toEqual([]);

      // Verify audit document was recorded
      const auditDoc = db.data('commercialAttributionAudit_prod/test_attr_apply_01');
      expect(auditDoc).toBeDefined();
      expect(auditDoc.totalApplied).toBe(1);

      // Verify Idempotence: re-running immediately results in 0 planned mutations
      const plan2 = await buildMigrationPlan(db);
      const res2 = await executeCommercialAttributionMigration(db, plan2, {
        dryRun: false,
        opId: 'test_attr_apply_02'
      });
      expect(res2.mutationsPlannedCount).toBe(0);
      expect(res2.appliedCount).toBe(0);
    });
  });

  describe('Surgical Rollback & Concurrency Detection', () => {
    test('rolls back clean modifications to original before state', async () => {
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      db.seed('prospects_prod/OPP-1777081083975-23', {
        id: 'OPP-1777081083975-23',
        proyecto: 'VISTA TOWER 2',
        vendedor: 'Alejandra Ayala'
      });

      const plan = await buildMigrationPlan(db);
      await executeCommercialAttributionMigration(db, plan, {
        dryRun: false,
        opId: 'test_rb_clean'
      });

      const auditRecord = db.data('commercialAttributionAudit_prod/test_rb_clean');
      const rbRes = await rollbackCommercialAttributionMigration(db, auditRecord, { dryRun: false });

      expect(rbRes.status).toBe('SUCCEEDED');
      expect(rbRes.collisionsDetectedCount).toBe(0);

      const rolledBackDoc = db.data('prospects_prod/OPP-1777081083975-23');
      expect(rolledBackDoc.vendedorId).toBeNull();
      expect(rolledBackDoc.vendedorName).toBeNull();
      expect(rolledBackDoc.vendedorRole).toBeNull();
    });

    test('preserves subsequent human modifications and detects concurrent edits during rollback', async () => {
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      db.seed('prospects_prod/OPP-1777081083975-23', {
        id: 'OPP-1777081083975-23',
        proyecto: 'VISTA TOWER 2',
        vendedor: 'Alejandra Ayala'
      });

      const plan = await buildMigrationPlan(db);
      await executeCommercialAttributionMigration(db, plan, {
        dryRun: false,
        opId: 'test_rb_concurrent'
      });

      // Human manager reassigns to Roberto Flores after migration
      db.seed('prospects_prod/OPP-1777081083975-23', {
        ...db.data('prospects_prod/OPP-1777081083975-23'),
        vendedorId: '1788471603604',
        vendedorName: 'Roberto Flores',
        vendedorRole: 'vendedor'
      });

      const auditRecord = db.data('commercialAttributionAudit_prod/test_rb_concurrent');
      const rbRes = await rollbackCommercialAttributionMigration(db, auditRecord, { dryRun: false });

      expect(rbRes.collisionsDetectedCount).toBeGreaterThan(0);
      const collision = rbRes.collisions.find(c => c.field === 'vendedorId');
      expect(collision).toBeDefined();
      expect(collision.action).toBe('SKIP_FIELD');

      // Human modification remains intact
      const preservedDoc = db.data('prospects_prod/OPP-1777081083975-23');
      expect(preservedDoc.vendedorId).toBe('1788471603604');
      expect(preservedDoc.vendedorName).toBe('Roberto Flores');
    });
  });

  describe('Protection of Other Sellers & Inactive Accounts', () => {
    test('never modifies or leaks Gustavo Velasquez inactive records', async () => {
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      db.seed('prospects_prod/P_GUSTAVO', {
        id: 'P_GUSTAVO',
        proyecto: 'Prospección Gustavo',
        createdBy: '1784221928346',
        vendedorId: '1784221928346',
        vendedorName: 'Gustavo Velásquez',
        vendedorRole: 'vendedor',
        estado: 'activo',
        etapa: 'prospecto'
      });

      const plan = await buildMigrationPlan(db);
      expect(plan.audit.counts.correct).toBe(1);
      expect(plan.audit.proposedMutations.find(m => m.id === 'P_GUSTAVO')).toBeUndefined();

      await executeCommercialAttributionMigration(db, plan, { dryRun: false, opId: 'test_gustavo' });

      const gDoc = db.data('prospects_prod/P_GUSTAVO');
      expect(gDoc.vendedorId).toBe('1784221928346');
      expect(gDoc.vendedorName).toBe('Gustavo Velásquez');
    });
  });

  describe('Origin Breakdown & Financial/Stage Zero-Distortion Verification', () => {
    test('correctly breaks down origin and proves zero delta in financials and stages', async () => {
      for (const [id, u] of Object.entries(mockUsers)) {
        db.seed(`users_prod/${id}`, u);
      }

      // Seed 1 imported doc and 1 CRM-created doc
      db.seed('prospects_prod/OPP-1777081083975-23', {
        id: 'OPP-1777081083975-23',
        proyecto: 'VISTA TOWER 2',
        vendedor: 'Alejandra Ayala',
        precio_cotizado: 30000,
        costo_venta: 20000,
        estado: 'activo',
        etapa: 'negociacion'
      });

      db.seed('prospects_prod/1777072883747', {
        id: '1777072883747',
        proyecto: 'BOMBAS DE VACIO',
        createdBy: '1776904514932',
        precio_cotizado: 15000,
        costo_venta: 10000,
        estado: 'ganado',
        etapa: 'cierre'
      });

      // Seed 1 canonical doc
      db.seed('prospects_prod/P_CANONICAL', {
        id: 'P_CANONICAL',
        proyecto: 'Proyecto Roberto',
        createdBy: '1788471603604',
        vendedorId: '1788471603604',
        vendedorName: 'Roberto Flores',
        vendedorRole: 'vendedor',
        precio_cotizado: 50000,
        costo_venta: 35000,
        estado: 'activo',
        etapa: 'negociacion'
      });

      const plan = await buildMigrationPlan(db);

      // Origin breakdown
      expect(plan.originBreakdown.totalToModify).toBe(2);
      expect(plan.originBreakdown.importedCount).toBe(1);
      expect(plan.originBreakdown.crmCreatedCount).toBe(1);

      // Canonical untouched
      expect(plan.untouchedCanonical.total).toBe(1);
      expect(plan.untouchedCanonical.byVendor['Roberto Flores']).toBe(1);

      // Financials: zero delta
      expect(plan.financialReconciliation.precioCotizado.before).toBe(45000);
      expect(plan.financialReconciliation.precioCotizado.after).toBe(45000);
      expect(plan.financialReconciliation.precioCotizado.delta).toBe(0);
      expect(plan.financialReconciliation.costoVenta.delta).toBe(0);
      expect(plan.financialReconciliation.margenBrutoDolares.delta).toBe(0);

      // Status & Stage: zero delta
      expect(plan.statusReconciliation.activo.delta).toBe(0);
      expect(plan.statusReconciliation.ganado.delta).toBe(0);
      expect(plan.stageReconciliation.negociacion.delta).toBe(0);
      expect(plan.stageReconciliation.cierre.delta).toBe(0);
    });
  });
});
