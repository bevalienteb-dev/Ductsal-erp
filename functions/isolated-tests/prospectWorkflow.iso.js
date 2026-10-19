// functions/isolated-tests/prospectWorkflow.iso.js
// EMULATOR layer: the SAME behavioural suite as functions/__tests__/prospectWorkflow.unit.test.js, but against the REAL
// isolated Firestore emulator through the Admin SDK (real transactions, real contention, real create/update semantics).
// Authorization here is the service's own; the Admin SDK ignores Firestore rules, so RULES are not covered by this file.
// Isolation: hard-coded 127.0.0.1:8190 + demo project (same constants as the other *.iso.js files).

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { defineWorkflowSuite } = require('../test-helpers/workflowSuite');
const { clearIsolatedFirestore, assertIsolatedUp } = require('./iso');

if (!getApps().length) initializeApp({ projectId: 'demo-ductsal-isolated' });
const db = getFirestore();
const CLOCK = new Date('2026-03-15T12:00:00.000Z');

beforeAll(async () => { await assertIsolatedUp(); });
const dataOf = snap => snap.docs.map(d => d.data());

defineWorkflowSuite({
  label: 'emulator (real isolated Firestore)',
  makeEnv() {
    const live = { ok: true, calls: [] };
    const commercial = createCommercialService({ db, FieldValue, suffix: '_prod', now: () => CLOCK, verifyManager: async uid => { live.calls.push(uid); return live.ok; } });
    const wf = createProspectWorkflowService({ db, FieldValue, kit: commercial.kit });
    return {
      wf, live, now: CLOCK,
      seed: (path, data) => db.doc(path).set(data),
      read: async path => { const s = await db.doc(path).get(); return s.exists ? s.data() : undefined; },
      list: async c => dataOf(await db.collection(c).get()),
      clear: async () => { await clearIsolatedFirestore(); live.ok = true; live.calls = []; }
    };
  }
});
