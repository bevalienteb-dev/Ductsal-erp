// functions/__tests__/prospectWorkflow.unit.test.js
// UNIT layer: opportunity workflow (functions/prospectWorkflowService.js) against the in-memory Firestore
// (test-helpers/fakeFirestore.js). Proves the service logic. It does NOT prove Firestore rules nor real-backend behaviour
// (the emulator layer, isolated-tests/prospectWorkflow.iso.js, has been written but could not be executed here:
// no Java runtime - see ISOLATED_TESTS.md).

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService, POLICY } = require('../prospectWorkflowService');
const { defineWorkflowSuite } = require('../test-helpers/workflowSuite');

const CLOCK = new Date('2026-03-15T12:00:00.000Z');

defineWorkflowSuite({
  label: 'unit (in-memory Firestore)',
  makeEnv() {
    const fdb = createFakeFirestore({ clock: () => CLOCK });
    const live = { ok: true, calls: [] };
    const commercial = createCommercialService({
      db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod', now: () => CLOCK,
      verifyManager: async uid => { live.calls.push(uid); return live.ok; }
    });
    const wf = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: commercial.kit });
    return {
      wf, live, now: CLOCK,
      seed: (path, data) => fdb.seed(path, data),
      read: async path => fdb.data(path),
      list: async c => fdb.list(c),
      clear: async () => { fdb.clear(); live.ok = true; live.calls = []; }
    };
  }
});

describe('policy and construction', () => {
  test('every operation has an explicit policy entry; deleteProspect and reactivateProspect need the live manager check', () => {
    expect(Object.keys(POLICY).sort()).toEqual([
      'advanceStage', 'deleteChangeOrder', 'deleteInvoice', 'deletePayment', 'deleteProspect',
      'editBasePrice', 'markLost', 'reactivateProspect', 'registerProposal', 'saveChangeOrder',
      'saveInvoice', 'savePayment'
    ]);
    expect(POLICY.deleteProspect).toEqual(['manager-live']);
    expect(POLICY.reactivateProspect).toEqual(['manager-live']);
    expect(POLICY.editBasePrice).toEqual(['manager', 'gestor']);
    const postclosingOps = ['saveChangeOrder', 'deleteChangeOrder', 'saveInvoice', 'deleteInvoice', 'savePayment', 'deletePayment'];
    for (const op of postclosingOps) {
      expect(POLICY[op]).toEqual(['manager', 'gestor']);
    }
    for (const [k, v] of Object.entries(POLICY)) {
      if (k !== 'deleteProspect' && k !== 'reactivateProspect' && k !== 'editBasePrice' && !postclosingOps.includes(k)) {
        expect(v).toEqual(['manager', 'gestor', 'vendedor']);
      }
    }
  });
  test('refuses to be built without the commercial kit', () => {
    const fdb = createFakeFirestore();
    expect(() => createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue })).toThrow(/kit/);
  });
});
