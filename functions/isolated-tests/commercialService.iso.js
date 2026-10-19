// functions/isolated-tests/commercialService.iso.js
// EMULATOR layer: the SAME behavioural suite as functions/__tests__/commercialService.unit.test.js, but running against
// the REAL isolated Firestore emulator through the Admin SDK (real transactions, real contention, real create/update
// semantics). Authorization here is the service's own; the Admin SDK ignores Firestore rules by design, so the RULES
// are NOT covered by this file (see firestore.rules.iso.js).
//
// STATUS: executed against the isolated emulators on 2026-10-16 (Java 21, Firestore on 127.0.0.1:8190); results are recorded in
// ../ISOLATED_TESTS.md. Re-run it after any change to commercialService.js.
//
// Isolation: hard-coded 127.0.0.1:8190 + demo project, same constants as the other *.iso.js files. Nothing comes from
// the environment, so it cannot reach production nor the development emulators (9099 / 8080 / 5001).

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { createCommercialService } = require('../commercialService');
const { defineCommercialSuite } = require('../test-helpers/commercialSuite');
const { clearIsolatedFirestore, assertIsolatedUp } = require('./iso');

if (!getApps().length) initializeApp({ projectId: 'demo-ductsal-isolated' });
const db = getFirestore();

const CLOCK = new Date('2026-03-15T12:00:00.000Z'); // 06:00 in El Salvador: March 2026 (same as the unit run)

beforeAll(async () => { await assertIsolatedUp(); });

const dataOf = snap => snap.docs.map(d => d.data());

defineCommercialSuite({
  label: 'emulator (real isolated Firestore)',
  supportsFailureInjection: false, // a commit cannot be failed on demand against the real emulator
  makeEnv() {
    let seq = 0;
    const live = { ok: true, calls: [] };
    const service = createCommercialService({
      db, FieldValue, suffix: '_prod', now: () => CLOCK,
      newProspectId: () => String(1800000000000 + (++seq)),
      verifyManager: async uid => { live.calls.push(uid); return live.ok; }
    });
    return {
      service, live, now: CLOCK,
      seed: (path, data) => db.doc(path).set(data),
      read: async path => { const s = await db.doc(path).get(); return s.exists ? s.data() : undefined; },
      list: async c => dataOf(await db.collection(c).get()),
      clear: async () => { await clearIsolatedFirestore(); seq = 0; live.ok = true; live.calls = []; }
    };
  },
  makeServiceWithFixedProspectId() {
    const service = createCommercialService({
      db, FieldValue, suffix: '_prod', now: () => CLOCK,
      newProspectId: () => '1800000000000', verifyManager: async () => true
    });
    return { service, seed: (p, d) => db.doc(p).set(d), list: async c => dataOf(await db.collection(c).get()) };
  }
});
