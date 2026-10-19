// functions/emulatorGuard.js
// Protection against accidentally reaching production while testing locally.
//
// How the real SDKs consume the emulator configuration (verified in node_modules):
//  - @google-cloud/firestore (build/src/index.js, Firestore settings): if FIRESTORE_EMULATOR_HOST is set it
//    OVERRIDES any host passed in code and disables TLS. It is read when the Firestore client is
//    constructed (the first `admin.firestore()`), so it must be set BEFORE `require('./index')`.
//  - firebase-admin Auth (auth/auth-api-request.js, emulatorHost()): FIREBASE_AUTH_EMULATOR_HOST is
//    read on every request. If it is missing the SDK talks to the real Auth service.
//  - FUNCTIONS_EMULATOR is set by the Firebase CLI; firebase-functions does not enforce anything with
//    it. Nothing in the SDKs checks that BOTH emulators are present, which is why this guard exists:
//    running only the Functions emulator would let the functions use real Auth and Firestore.
//
// This file only ever RESTRICTS behaviour; it grants nothing.

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

function isLoopbackHost(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value === '::1') return true; // bare IPv6 loopback (no port)
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
  return LOOPBACK_HOSTS.includes(host);
}

/**
 * Problems that make the current environment unsafe to run against.
 *  - hosts: both emulator hosts must be set and be loopback addresses.
 *  - strict (used by the seeding script): the project id must be a `demo-` project (the Firebase CLI
 *    refuses to connect demo projects to real services) and no service-account credentials may be
 *    configured.
 */
function emulatorIsolationProblems(env = process.env, { strict = false } = {}) {
  const problems = [];
  if (!isLoopbackHost(env.FIRESTORE_EMULATOR_HOST)) {
    problems.push('FIRESTORE_EMULATOR_HOST is not set to a loopback address');
  }
  if (!isLoopbackHost(env.FIREBASE_AUTH_EMULATOR_HOST)) {
    problems.push('FIREBASE_AUTH_EMULATOR_HOST is not set to a loopback address');
  }
  if (strict) {
    const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || '';
    if (!/^demo-[a-z0-9-]+$/.test(projectId)) {
      problems.push('GCLOUD_PROJECT must be a demo- project (e.g. demo-ductsal-local)');
    }
    if (env.GOOGLE_APPLICATION_CREDENTIALS) {
      problems.push('GOOGLE_APPLICATION_CREDENTIALS must not be set');
    }
  }
  return problems;
}

module.exports = { isLoopbackHost, emulatorIsolationProblems, LOOPBACK_HOSTS };
