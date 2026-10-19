// functions/__tests__/commercialService.unit.test.js
// UNIT layer: the commercial operations (functions/commercialService.js) against an in-memory Firestore
// (test-helpers/fakeFirestore.js) that models transactions, optimistic concurrency and create/update semantics.
// It proves the logic of the service: authorization matrix, validation, protected fields, idempotency, concurrency,
// failure handling. It does NOT prove Firestore security rules nor real-backend behaviour: those belong to the
// rules / emulator layers (isolated-tests/, see functions/ISOLATED_TESTS.md and COMMERCIAL_OPERATIONS.md).

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { defineCommercialSuite } = require('../test-helpers/commercialSuite');

const CLOCK = new Date('2026-03-15T12:00:00.000Z'); // 06:00 in El Salvador: March 2026

defineCommercialSuite({
  label: 'unit (in-memory Firestore)',
  supportsFailureInjection: true,
  makeEnv() {
    const fdb = createFakeFirestore({ clock: () => CLOCK });
    let seq = 0;
    const live = { ok: true, calls: [] };
    const service = createCommercialService({
      db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod', now: () => CLOCK,
      newProspectId: () => String(1800000000000 + (++seq)),
      verifyManager: async uid => { live.calls.push(uid); return live.ok; }
    });
    return {
      service, live, now: CLOCK,
      seed: (path, data) => fdb.seed(path, data),
      read: async path => fdb.data(path),
      list: async c => fdb.list(c),
      clear: async () => { fdb.clear(); seq = 0; live.ok = true; live.calls = []; },
      failNextCommit: (message = 'injected commit failure') => { fdb.state.hooks.beforeCommit = () => { delete fdb.state.hooks.beforeCommit; throw new Error(message); }; },
      stats: () => ({ retries: fdb.state.retries })
    };
  },
  makeServiceWithFixedProspectId() {
    const fdb = createFakeFirestore({ clock: () => CLOCK });
    const service = createCommercialService({
      db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod', now: () => CLOCK,
      newProspectId: () => '1800000000000', verifyManager: async () => true
    });
    return { service, seed: (p, d) => fdb.seed(p, d), list: async c => fdb.list(c) };
  }
});

describe('construction guards', () => {
  const fdb = createFakeFirestore();
  test('refuses an unknown suffix and a missing manager verifier', () => {
    expect(() => createCommercialService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_x', verifyManager: async () => true })).toThrow(/suffix/);
    expect(() => createCommercialService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' })).toThrow(/verifyManager/);
  });
});
