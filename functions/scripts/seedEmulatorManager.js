// functions/scripts/seedEmulatorManager.js
// Creates ONE test manager, exclusively inside the Firebase emulators (Auth + Firestore):
//   - an Auth account with the custom claim { manager: true } (granted here with the Admin SDK,
//     out of band: there is no callable or public route that grants it), and
//   - a CRM profile in `users_local` linked through `authUid`, with no password field.
//
// It refuses to run unless the environment is provably the emulators (see ../emulatorGuard.js):
// demo- project id, loopback emulator hosts for Auth AND Firestore, no service-account credentials.
// It touches only the two documents/accounts it owns and aborts instead of adopting anything else.
// Idempotent: running it twice leaves the same single account and profile.
//
// Usage (see ../EMULATOR.md):
//   GCLOUD_PROJECT=demo-ductsal-local \
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   node scripts/seedEmulatorManager.js

const crypto = require('crypto');
const { emulatorIsolationProblems } = require('../emulatorGuard');

// Fixed identifiers: the account is recognised by its UID, never adopted by email alone.
// `.invalid` is a reserved TLD that can never belong to a real mailbox.
const SEED = {
  authUid: 'seed-test-manager',
  profileId: '1000000000001', // CRM id format (epoch-ms string); unrelated to the Auth UID
  email: 'gerente.prueba@ductsal-test.invalid',
  nombre: 'Gerente de Prueba (emulador)',
  dbSuffix: '_local'
};

/**
 * @param admin  an initialised firebase-admin namespace (already pointed at the emulators)
 * @param opts   { password } used only when the Auth account is created; it lives in Auth only.
 */
async function seedTestManager(admin, { password } = {}) {
  const auth = admin.auth();
  const profileRef = admin.firestore().collection(`users${SEED.dbSuffix}`).doc(SEED.profileId);
  const result = { uid: SEED.authUid, profileId: SEED.profileId, createdAuth: false, createdProfile: false };

  // ---- Auth account ----
  let existing = null;
  try {
    existing = await auth.getUserByEmail(SEED.email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  if (existing && existing.uid !== SEED.authUid) {
    throw new Error(`Refusing to continue: ${SEED.email} already belongs to another Auth account (${existing.uid}).`);
  }
  if (!existing) {
    await auth.createUser({ uid: SEED.authUid, email: SEED.email, password, displayName: SEED.nombre });
    result.createdAuth = true;
  }
  // Idempotent: always leaves exactly these claims, only on this account.
  await auth.setCustomUserClaims(SEED.authUid, { role: 'manager', manager: true, cid: SEED.profileId });

  // ---- Profile (never overwrites; verifies ownership if it already exists) ----
  try {
    await profileRef.create({
      id: SEED.profileId,
      authUid: SEED.authUid,
      authProvider: 'firebase',
      nombre: SEED.nombre,
      email: SEED.email,
      role: 'manager',
      activo: true
    });
    result.createdProfile = true;
  } catch (e) {
    const exists = e.code === 6 || (e.message && e.message.includes('ALREADY_EXISTS')) || (e.message && e.message.includes('already exists'));
    if (!exists) throw e;
    const snap = await profileRef.get();
    if (!snap.exists || (snap.data() || {}).authUid !== SEED.authUid) {
      throw new Error(`Refusing to continue: users${SEED.dbSuffix}/${SEED.profileId} exists but is not the seed profile.`);
    }
  }
  return result;
}

async function main() {
  const problems = emulatorIsolationProblems(process.env, { strict: true });
  if (problems.length > 0) {
    console.error('Refusing to run: the environment is not provably the emulators.\n - ' + problems.join('\n - '));
    process.exit(2);
  }
  // Required only after the guard passed; env vars are already set so the SDK targets the emulators.
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  // Test-only password: from the environment or random; it is printed once on creation, stored only
  // in the Auth emulator, and never written to Firestore or to any file.
  const password = process.env.SEED_MANAGER_PASSWORD || crypto.randomBytes(12).toString('hex');
  const result = await seedTestManager(admin, { password });
  console.log(JSON.stringify({ ...result, email: SEED.email, ...(result.createdAuth ? { password } : {}) }, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}

module.exports = { seedTestManager, SEED };
