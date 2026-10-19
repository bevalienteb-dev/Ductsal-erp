// functions/__tests__/emulatorStatics.regression.test.js
// Regression (found by the real-emulator run): inside the Firebase CLI's Functions emulator
// `admin.firestore` is a bound function without its static members, so `admin.firestore.FieldValue`
// was undefined and createUserAdmin failed with INTERNAL. The function must then fall back to the
// modular `firebase-admin/firestore` entry point. Fakes only; nothing reaches Firebase.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => {
  const admin = require('../test-helpers/fakeFirebase').buildAdminFake();
  // Reproduce what the emulator's proxy does to the namespace function.
  delete admin.firestore.FieldValue;
  delete admin.firestore.Timestamp;
  return admin;
}, { virtual: true });
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'MODULAR_SERVER_TS' },
  Timestamp: { fromDate: d => ({ toDate: () => d }) }
}), { virtual: true });

const admin = require('firebase-admin');
const { createUserAdmin } = require('../index');
const state = admin.__state;
const ctx = { auth: { uid: 'managerUid' } };

beforeEach(() => {
  state.docs = {
    'users_prod/mgr1': { id: 'mgr1', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Manager' }
  };
  state.authUsers = {};
  state.createUserCalls = 0;
  state.createUserArgs = [];
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

describe('admin.firestore without static members (Functions emulator)', () => {
  test('the namespace really lacks the statics in this test', () => {
    expect(admin.firestore.FieldValue).toBeUndefined();
    expect(admin.firestore.Timestamp).toBeUndefined();
  });

  test('createUserAdmin still creates exactly one account and one profile, using the modular statics', async () => {
    const r = await createUserAdmin({ email: 'Emu.Static@Ductsal-Test.invalid', nombre: 'Estático', role: 'vendedor', opId: 'op_statics_1' }, ctx);
    expect(r).toEqual({ uid: expect.any(String), id: expect.any(String) });
    expect(state.createUserCalls).toBe(1);
    const profile = state.docs[`users_prod/${r.id}`];
    expect(profile).toMatchObject({ authUid: r.uid, role: 'vendedor', email: 'emu.static@ductsal-test.invalid' });
    expect(Object.keys(profile).some(k => /pass/i.test(k))).toBe(false);
    expect(state.docs['userOps/op_statics_1'].timestamp).toBe('MODULAR_SERVER_TS');
  });

  test('replaying the same opId stays idempotent on this code path', async () => {
    const payload = { email: 'again@ductsal-test.invalid', nombre: 'Otra Vez', role: 'vendedor', opId: 'op_statics_2' };
    const first = await createUserAdmin(payload, ctx);
    const replay = await createUserAdmin(payload, ctx);
    expect(replay).toMatchObject({ uid: first.uid, id: first.id });
    expect(state.createUserCalls).toBe(1);
  });
});
