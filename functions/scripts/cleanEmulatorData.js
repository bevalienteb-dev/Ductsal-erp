#!/usr/bin/env node
// functions/scripts/cleanEmulatorData.js
// Idempotent and safe teardown utility for the Firebase Emulator test environment.
// Strictly restricted to demo-ductsal-local.

const {
  PROJECT,
  AUTH_URL,
  FIRESTORE_URL,
  assertSafetyGuard,
  clearAllEmulatorData,
  assertEmulatorsReachable
} = require('../emulator-tests/authEmulatorTestHelper');

async function main() {
  console.log(`[CLEANUP] Initializing test data purge for project "${PROJECT}"...`);

  // 1. Guard check: ensure environment is strictly local
  const env = {
    ...process.env,
    GCLOUD_PROJECT: process.env.GCLOUD_PROJECT || PROJECT,
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
  };

  try {
    assertSafetyGuard(env);
  } catch (guardErr) {
    console.error(`[ABORT] Safety guard prevented cleanup: ${guardErr.message}`);
    process.exit(1);
  }

  // 2. Reachability check
  try {
    await assertEmulatorsReachable();
  } catch (reachErr) {
    console.error(`[ABORT] Emulators are not running or not reachable: ${reachErr.message}`);
    process.exit(1);
  }

  // 3. Execution of purge
  try {
    await clearAllEmulatorData();
    console.log(`[OK] All Auth accounts, OOB action codes, and Firestore documents cleanly purged on ${PROJECT}.`);
  } catch (err) {
    console.error(`[ERROR] Cleanup failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
