// functions/__tests__/executeSec03Backfill.unit.test.js
// Unit tests for the idempotent, batch-controlled, auditable and reversible backfill executor (SEC-03 F2.5).

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const {
  buildBackfillPlan,
  executeBackfill,
  rollbackBackfill,
  chunkArray,
  arraysEqual,
  BATCH_SIZE
} = require('../scripts/executeSec03Backfill');
const { KNOWN_USERS } = require('../scripts/simulateSec03Backfill');

describe('SEC-03 F2.5: Execute & Rollback Backfill Unit Tests', () => {
  let db;

  beforeEach(() => {
    db = createFakeFirestore();
  });

  describe('Utility & Batch Chunking', () => {
    test('chunkArray splits items strictly by given size', () => {
      const items = Array.from({ length: 125 }, (_, i) => ({ id: `doc_${i}` }));
      const chunks = chunkArray(items, 50);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(50);
      expect(chunks[1]).toHaveLength(50);
      expect(chunks[2]).toHaveLength(25);
    });

    test('arraysEqual handles arrays correctly regardless of order', () => {
      expect(arraysEqual(['a', 'b'], ['b', 'a'])).toBe(true);
      expect(arraysEqual(['a'], ['a', 'b'])).toBe(false);
      expect(arraysEqual([], [])).toBe(true);
      expect(arraysEqual(null, ['a'])).toBe(false);
    });
  });

  describe('buildBackfillPlan & Categorization', () => {
    test('generates complete plan for prospects, clients, and userDirectory', async () => {
      // Seed users
      db.seed('users_prod/1776895495203', { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true, password: 'secretPassword1' });
      db.seed('users_prod/1776904514932', { id: '1776904514932', nombre: 'Alejandra Ayala', role: 'gestor', activo: true, password: 'secretPassword2' });
      db.seed('users_prod/1784221928346', { id: '1784221928346', nombre: 'Gustavo Velásquez', role: 'vendedor', activo: false, password: 'secretPassword3' });

      // Seed client without createdBy
      db.seed('clients_prod/C_ALE', { id: 'C_ALE', empresa: 'Cliente Alejandra', createdBy: null });
      // Seed AR Multiservicios without createdBy
      db.seed('clients_prod/C_AR', { id: 'C_AR', empresa: 'AR Multiservicios', createdBy: null });

      // Seed prospects
      db.seed('prospects_prod/P_ALE_1', { id: 'P_ALE_1', clientId: 'C_ALE', vendedor: 'Alejandra Ayala', etapa: 'cierre', estado: 'ganado' });
      db.seed('prospects_prod/P_ALE_2', { id: 'P_ALE_2', clientId: 'C_ALE', createdBy: '1776904514932' }); // missing vendedorId
      db.seed('prospects_prod/P_AR', { id: 'P_AR', clientId: 'C_AR', createdBy: '1784221928346', vendedorId: '1784221928346', etapa: 'prospecto', estado: 'activo' });

      const plan = await buildBackfillPlan(db);

      expect(plan.counts.users).toBe(3);
      expect(plan.counts.clients).toBe(2);
      expect(plan.counts.prospects).toBe(3);

      // Prospects
      expect(plan.prospects.proposedUpdates).toHaveLength(2);
      expect(plan.prospects.proposedUpdates.find(p => p.id === 'P_ALE_1').proposedPatch).toEqual({
        createdBy: '1776904514932',
        vendedorId: '1776904514932'
      });
      expect(plan.prospects.proposedUpdates.find(p => p.id === 'P_ALE_2').proposedPatch).toEqual({
        vendedorId: '1776904514932'
      });

      // Clients
      expect(plan.clients.missingCreatedByResolved).toHaveLength(2);
      const cAle = plan.clients.missingCreatedByResolved.find(c => c.id === 'C_ALE');
      expect(cAle.proposedCreatedBy).toBe('1776904514932');
      expect(cAle.proposedPatch).toEqual({
        createdBy: '1776904514932',
        visibleTo: ['1776904514932'],
        closingVendors: ['1776904514932']
      });

      // AR Multiservicios preservation
      const cAr = plan.clients.missingCreatedByResolved.find(c => c.id === 'C_AR');
      expect(cAr.proposedCreatedBy).toBe('1784221928346'); // Gustavo
      expect(cAr.proposedPatch).toEqual({
        createdBy: '1784221928346',
        visibleTo: ['1784221928346'],
        closingVendors: [] // not in cierre
      });

      // User Directory projection (passwords strictly omitted)
      expect(plan.userDirectory.toCreate).toHaveLength(3);
      for (const u of plan.userDirectory.toCreate) {
        expect(u.projection.password).toBeUndefined();
        expect(u.projection.email).toBeUndefined();
      }
    });
  });

  describe('executeBackfill: Dry-Run Mode Safeguard', () => {
    test('dry-run mode does not perform any writes in Firestore', async () => {
      db.seed('users_prod/1776895495203', { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true });
      db.seed('clients_prod/C1', { id: 'C1', empresa: 'Test C1', createdBy: null });
      db.seed('prospects_prod/P1', { id: 'P1', clientId: 'C1', vendedor: 'Alejandra Ayala' });

      const plan = await buildBackfillPlan(db);
      const commitsBefore = db.state.commits;

      const summary = await executeBackfill(db, plan, { dryRun: true });

      expect(summary.mode).toBe('DRY_RUN');
      expect(summary.totalPlannedMutations).toBeGreaterThan(0);
      expect(db.state.commits).toBe(commitsBefore); // 0 writes!
      // Document in DB is still unmutated
      expect(db.data('clients_prod/C1').createdBy).toBeNull();
    });
  });

  describe('executeBackfill: Live Apply & Idempotence', () => {
    test('live apply executes mutations in batches and logs exact before/after states', async () => {
      db.seed('users_prod/1776895495203', { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true });
      db.seed('clients_prod/C1', { id: 'C1', empresa: 'Test C1', createdBy: null });
      db.seed('prospects_prod/P1', { id: 'P1', clientId: 'C1', vendedor: 'Alejandra Ayala', etapa: 'cierre', estado: 'ganado' });

      const plan = await buildBackfillPlan(db);
      const res = await executeBackfill(db, plan, { dryRun: false, opId: 'test_op_apply_1' });

      expect(res.status).toBe('SUCCEEDED');
      expect(res.appliedCount).toBe(3); // 1 prospect + 1 client + 1 userDir

      // Verify Firestore state
      const updatedClient = db.data('clients_prod/C1');
      expect(updatedClient.createdBy).toBe('1776904514932');
      expect(updatedClient.visibleTo).toEqual(['1776904514932']);
      expect(updatedClient.closingVendors).toEqual(['1776904514932']);

      const updatedProspect = db.data('prospects_prod/P1');
      expect(updatedProspect.createdBy).toBe('1776904514932');
      expect(updatedProspect.vendedorId).toBe('1776904514932');

      const userDirDoc = db.data('userDirectory_prod/1776895495203');
      expect(userDirDoc).toEqual({
        id: '1776895495203',
        nombre: 'Benjamin Valiente',
        role: 'manager',
        activo: true
      });

      // Verify audit document exists in Firestore
      const auditDoc = db.data('sec03MigrationAudit_prod/test_op_apply_1');
      expect(auditDoc).toBeDefined();
      expect(auditDoc.totalApplied).toBe(3);
      expect(auditDoc.mutations).toHaveLength(3);

      // Verify Idempotence: running executeBackfill again results in 0 mutations
      const plan2 = await buildBackfillPlan(db);
      const res2 = await executeBackfill(db, plan2, { dryRun: false, opId: 'test_op_apply_2' });
      expect(res2.totalPlannedMutations).toBe(0);
      expect(res2.appliedCount).toBe(0);
    });
  });

  describe('rollbackBackfill: Surgical & Non-Destructive', () => {
    test('reverts clean documents to their original before states', async () => {
      db.seed('users_prod/1776895495203', { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true });
      db.seed('clients_prod/C1', { id: 'C1', empresa: 'Test C1', createdBy: null });
      db.seed('prospects_prod/P1', { id: 'P1', clientId: 'C1', vendedor: 'Alejandra Ayala' });

      const plan = await buildBackfillPlan(db);
      const applyRes = await executeBackfill(db, plan, { dryRun: false, opId: 'test_op_rb_1' });
      const auditRecord = db.data('sec03MigrationAudit_prod/test_op_rb_1');

      // Now execute rollback
      const rbRes = await rollbackBackfill(db, auditRecord, { dryRun: false });
      expect(rbRes.status).toBe('SUCCEEDED');
      expect(rbRes.collisionsDetectedCount).toBe(0);

      // Client should have createdBy restored to null
      const rolledBackClient = db.data('clients_prod/C1');
      expect(rolledBackClient.createdBy).toBeNull();
      expect(rolledBackClient.visibleTo).toBeNull();

      // userDirectory_prod created doc should be deleted
      const userDirDoc = db.data('userDirectory_prod/1776895495203');
      expect(userDirDoc).toBeUndefined();
    });

    test('preserves user modifications and skips overwriting fields changed after migration', async () => {
      db.seed('users_prod/1776895495203', { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true });
      db.seed('clients_prod/C1', { id: 'C1', empresa: 'Test C1', createdBy: null });
      db.seed('prospects_prod/P1', { id: 'P1', clientId: 'C1', vendedor: 'Alejandra Ayala' });

      const plan = await buildBackfillPlan(db);
      await executeBackfill(db, plan, { dryRun: false, opId: 'test_op_conflict' });
      const auditRecord = db.data('sec03MigrationAudit_prod/test_op_conflict');

      // Simulate concurrent user action AFTER backfill:
      // Manager reassigns P1 to Roberto Flores ('1788471603604')
      db.seed('prospects_prod/P1', {
        ...db.data('prospects_prod/P1'),
        vendedorId: '1788471603604', // modified by human!
        etapa: 'negociacion'
      });

      // Execute rollback
      const rbRes = await rollbackBackfill(db, auditRecord, { dryRun: false });

      // Collision detected for vendedorId!
      expect(rbRes.collisionsDetectedCount).toBeGreaterThan(0);
      const collision = rbRes.collisions.find(c => c.field === 'vendedorId');
      expect(collision).toBeDefined();
      expect(collision.action).toBe('SKIP_FIELD');

      // The human modification must remain intact!
      const currentP1 = db.data('prospects_prod/P1');
      expect(currentP1.vendedorId).toBe('1788471603604');
      expect(currentP1.etapa).toBe('negociacion');
    });
  });

  describe('AR Multiservicios & Ambiguous Clients Safeguards', () => {
    test('AR Multiservicios is assigned to Gustavo Velásquez without silent reassignment', async () => {
      db.seed('users_prod/1784221928346', { id: '1784221928346', nombre: 'Gustavo Velásquez', role: 'vendedor', activo: false });
      db.seed('clients_prod/C1784933224052', { id: 'C1784933224052', empresa: 'AR Multiservicios', createdBy: null });
      db.seed('prospects_prod/1784933235289', {
        id: '1784933235289',
        clientId: 'C1784933224052',
        createdBy: '1784221928346',
        vendedorId: '1784221928346',
        etapa: 'prospecto',
        estado: 'activo'
      });

      const plan = await buildBackfillPlan(db);
      const arPlan = plan.clients.missingCreatedByResolved.find(c => c.id === 'C1784933224052');
      expect(arPlan).toBeDefined();
      expect(arPlan.proposedCreatedBy).toBe('1784221928346');
      expect(arPlan.proposedPatch.createdBy).toBe('1784221928346');
      expect(arPlan.proposedPatch.visibleTo).toEqual(['1784221928346']);
      // Must not be closingVendors
      expect(arPlan.proposedPatch.closingVendors).toEqual([]);

      // Execute backfill
      await executeBackfill(db, plan, { dryRun: false, opId: 'test_ar_apply' });

      const arClient = db.data('clients_prod/C1784933224052');
      expect(arClient.createdBy).toBe('1784221928346');
      expect(arClient.visibleTo).toEqual(['1784221928346']);
      // Gustavo is NOT overwritten with Alejandra or Roberto
      expect(arClient.createdBy).not.toBe('1776904514932');
      expect(arClient.createdBy).not.toBe('1788471603604');
    });

    test('client with conflicting sellers is not resolved automatically and flagged for manual review', async () => {
      db.seed('clients_prod/C_CONFLICT', { id: 'C_CONFLICT', empresa: 'Conflicto SA', createdBy: null });
      db.seed('prospects_prod/P_A', { id: 'P_A', clientId: 'C_CONFLICT', createdBy: '1776904514932' });
      db.seed('prospects_prod/P_B', { id: 'P_B', clientId: 'C_CONFLICT', createdBy: '1788471603604' });

      const plan = await buildBackfillPlan(db);
      expect(plan.clients.missingCreatedByResolved.find(c => c.id === 'C_CONFLICT')).toBeUndefined();
      const amb = plan.clients.ambiguousManualReview.find(c => c.id === 'C_CONFLICT');
      expect(amb).toBeDefined();
      expect(amb.category).toBe('CLIENT_CONFLICTING_PROSPECT_OWNERS');
    });
  });
});
