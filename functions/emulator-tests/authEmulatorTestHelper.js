// functions/emulator-tests/authEmulatorTestHelper.js
// Specialized test helper for isolated Firebase Authentication, Firestore, and Functions testing.
// Exclusively binds to 127.0.0.1 and demo-ductsal-local. Zero external delivery.

const crypto = require('crypto');
const { isLoopbackHost, emulatorIsolationProblems } = require('../emulatorGuard');

const PROJECT = 'demo-ductsal-local';
const AUTH_HOST = '127.0.0.1';
const AUTH_PORT = 9099;
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;
const FUNCTIONS_HOST = '127.0.0.1';
const FUNCTIONS_PORT = 5001;

const AUTH_URL = `http://${AUTH_HOST}:${AUTH_PORT}`;
const FIRESTORE_URL = `http://${FIRESTORE_HOST}:${FIRESTORE_PORT}`;
const FUNCTIONS_URL = `http://${FUNCTIONS_HOST}:${FUNCTIONS_PORT}`;
const REGION = 'us-central1';

const FAKE_API_KEY = 'fake-api-key';
const OWNER_HEADER = { Authorization: 'Bearer owner' };

const LOCAL_DEV_CONTINUE_URL = 'http://127.0.0.1:8123/login?mode=activate';

const ACTION_CODE_SETTINGS = Object.freeze({
  url: LOCAL_DEV_CONTINUE_URL,
  handleCodeInApp: false
});

const FORBIDDEN_PRODUCTION_PATTERNS = [
  'ductsal-erp',
  'ductsal-erp.firebaseapp.com',
  'ductsal-erp.firebasestorage.app',
  'crm.ductsal.com',
  'erp.ductsal.com'
];

/**
 * Strict production and staging safety guard.
 * Validates project id, loopback hosts, and ensures no production references or credentials exist.
 * The ONLY permitted project for these tests is demo-ductsal-local.
 */
function assertSafetyGuard(env = process.env) {
  const problems = [];
  const rawProject = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || '';
  const cleanProject = String(rawProject).trim().toLowerCase();

  // 1. Explicit production blacklist check
  for (const forbidden of FORBIDDEN_PRODUCTION_PATTERNS) {
    if (cleanProject.includes(forbidden)) {
      throw new Error(`[FATAL PRODUCTION GUARD] Forbidden production reference detected: "${rawProject}". Halting immediately!`);
    }
  }

  // Explicit staging blacklist check
  if (cleanProject.includes('staging')) {
    throw new Error(`[FATAL SAFETY GUARD] Staging reference detected: "${rawProject}". Staging is strictly forbidden in this test environment!`);
  }

  // 2. Strict project whitelist check: demo-ductsal-local ONLY
  if (cleanProject !== PROJECT) {
    problems.push(`Active project must be strictly "${PROJECT}" (received: "${rawProject}")`);
  }

  // 3. Loopback host checks
  const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!isLoopbackHost(authHost)) {
    problems.push(`FIREBASE_AUTH_EMULATOR_HOST is not a loopback host (received: "${authHost}")`);
  }

  const firestoreHost = env.FIRESTORE_EMULATOR_HOST;
  if (!isLoopbackHost(firestoreHost)) {
    problems.push(`FIRESTORE_EMULATOR_HOST is not a loopback host (received: "${firestoreHost}")`);
  }

  // 4. Production credentials check
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    problems.push(`GOOGLE_APPLICATION_CREDENTIALS must not be set during emulator tests`);
  }

  if (problems.length > 0) {
    throw new Error(`[ISOLATION VIOLATION] Environment is not safely isolated:\n - ${problems.join('\n - ')}`);
  }

  return true;
}

/**
 * HTTP helper using Node 20 global fetch.
 */
async function fetchJson(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    // non-JSON response
  }
  return { status: res.status, json, text };
}

/**
 * Checks emulator reachability.
 */
async function assertEmulatorsReachable() {
  const issues = [];
  try {
    const authCfg = await fetchJson('GET', `${AUTH_URL}/emulator/v1/projects/${PROJECT}/config`);
    if (authCfg.status !== 200) issues.push(`Auth emulator (${AUTH_URL}) returned HTTP ${authCfg.status}`);
  } catch (err) {
    issues.push(`Auth emulator unreachable at ${AUTH_URL}: ${err.message}`);
  }

  try {
    const fsCheck = await fetchJson('POST', `${FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents:listCollectionIds`, {
      headers: OWNER_HEADER,
      body: {}
    });
    if (fsCheck.status !== 200) issues.push(`Firestore emulator (${FIRESTORE_URL}) returned HTTP ${fsCheck.status}`);
  } catch (err) {
    issues.push(`Firestore emulator unreachable at ${FIRESTORE_URL}: ${err.message}`);
  }

  try {
    const fnCheck = await fetch(`${FUNCTIONS_URL}/`);
    if (!fnCheck) issues.push(`Functions emulator unreachable at ${FUNCTIONS_URL}`);
  } catch (err) {
    issues.push(`Functions emulator unreachable at ${FUNCTIONS_URL}: ${err.message}`);
  }

  if (issues.length > 0) {
    throw new Error(`[EMULATORS NOT READY] ${issues.join('; ')}`);
  }
}

/**
 * Complete data cleanup across Auth and Firestore.
 */
async function clearAllEmulatorData() {
  // Clear Auth accounts
  await fetchJson('DELETE', `${AUTH_URL}/emulator/v1/projects/${PROJECT}/accounts`);
  // Clear Firestore documents
  await fetchJson('DELETE', `${FIRESTORE_URL}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`);
}

/**
 * Returns all Auth accounts in the emulator.
 */
async function listAuthAccounts() {
  const r = await fetchJson('POST', `${AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
    headers: OWNER_HEADER,
    body: { returnUserInfo: true }
  });
  return (r.json && r.json.userInfo) || [];
}

/**
 * Auth OOB Code Inspection: returns all generated OOB codes from the Auth Emulator.
 */
async function listOobCodes() {
  const r = await fetchJson('GET', `${AUTH_URL}/emulator/v1/projects/${PROJECT}/oobCodes`);
  if (r.status !== 200) throw new Error(`Failed to list OOB codes: ${r.status}`);
  return r.json && r.json.oobCodes ? r.json.oobCodes : [];
}

/**
 * Finds the latest OOB code for a specific email and request type.
 */
async function getLastOobCode(email, requestType = 'PASSWORD_RESET') {
  const codes = await listOobCodes();
  const filtered = codes.filter(c =>
    String(c.email).toLowerCase() === String(email).toLowerCase() &&
    (!requestType || c.requestType === requestType)
  );
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

/**
 * Parses action link parameters from an emulator OOB link.
 */
function parseActionLink(link) {
  if (!link || typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    return {
      host: url.host,
      pathname: url.pathname,
      mode: url.searchParams.get('mode'),
      oobCode: url.searchParams.get('oobCode'),
      apiKey: url.searchParams.get('apiKey'),
      continueUrl: url.searchParams.get('continueUrl'),
      lang: url.searchParams.get('lang')
    };
  } catch (_) {
    return null;
  }
}

/**
 * Completes password reset using Auth REST API.
 */
async function completePasswordReset(oobCode, newPassword) {
  const url = `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${FAKE_API_KEY}`;
  const r = await fetchJson('POST', url, {
    body: { oobCode, newPassword }
  });
  if (r.status !== 200) {
    const msg = (r.json && r.json.error && r.json.error.message) || 'password reset failed';
    const err = new Error(msg);
    err.code = r.json && r.json.error && r.json.error.message;
    throw err;
  }
  return r.json;
}

/**
 * Client-like password reset request via Auth REST API (sendOobCode).
 */
async function sendPasswordResetOobCode(email, { continueUrl = ACTION_CODE_SETTINGS.url, languageCode = 'es' } = {}) {
  const url = `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FAKE_API_KEY}`;
  const r = await fetchJson('POST', url, {
    headers: languageCode ? { 'X-Firebase-Locale': languageCode } : {},
    body: {
      requestType: 'PASSWORD_RESET',
      email,
      continueUrl
    }
  });
  if (r.status !== 200) {
    const msg = (r.json && r.json.error && r.json.error.message) || 'sendOobCode failed';
    throw new Error(msg);
  }
  return r.json;
}

/**
 * Sign in test user via Auth REST API.
 */
async function signInTestUser(email, password) {
  const url = `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FAKE_API_KEY}`;
  const r = await fetchJson('POST', url, {
    body: { email, password, returnSecureToken: true }
  });
  if (r.status !== 200) {
    const msg = (r.json && r.json.error && r.json.error.message) || 'sign-in failed';
    const err = new Error(msg);
    err.code = 'auth/' + String(msg).toLowerCase().replace(/_/g, '-').split(' ')[0];
    throw err;
  }
  return { uid: r.json.localId, idToken: r.json.idToken };
}

/**
 * Direct call to Cloud Function callable protocol over HTTP.
 */
async function callFunction(name, data, idToken) {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
  const url = `${FUNCTIONS_URL}/${PROJECT}/${REGION}/${name}`;
  const r = await fetchJson('POST', url, { headers, body: { data } });
  return { httpStatus: r.status, result: r.json && r.json.result, error: r.json && r.json.error };
}

/**
 * Decodes claims from a JWT idToken.
 */
function decodeClaims(idToken) {
  const payload = String(idToken).split('.')[1];
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/**
 * Checks all Firestore documents to confirm secret codes/links are not persisted.
 */
async function scanFirestoreForSecrets(secretStrings = []) {
  if (!secretStrings.length) return [];
  const found = [];
  const docsUrl = `${FIRESTORE_URL}/v1/projects/${PROJECT}/databases/(default)/documents`;
  
  // List collections
  const colRes = await fetchJson('POST', `${docsUrl}:listCollectionIds`, { headers: OWNER_HEADER, body: {} });
  const collections = (colRes.json && colRes.json.collectionIds) || [];

  for (const col of collections) {
    const listRes = await fetchJson('GET', `${docsUrl}/${col}?pageSize=300`, { headers: OWNER_HEADER });
    const docs = (listRes.json && listRes.json.documents) || [];
    for (const doc of docs) {
      const docStr = JSON.stringify(doc);
      for (const secret of secretStrings) {
        if (secret && secret.length > 5 && docStr.includes(secret)) {
          found.push({ collection: col, docName: doc.name, secretMatched: secret.slice(0, 4) + '...' });
        }
      }
    }
  }
  return found;
}

module.exports = {
  PROJECT,
  AUTH_HOST,
  AUTH_PORT,
  FIRESTORE_HOST,
  FIRESTORE_PORT,
  FUNCTIONS_HOST,
  FUNCTIONS_PORT,
  AUTH_URL,
  FIRESTORE_URL,
  FUNCTIONS_URL,
  ACTION_CODE_SETTINGS,
  FORBIDDEN_PRODUCTION_PATTERNS,
  assertSafetyGuard,
  assertEmulatorsReachable,
  clearAllEmulatorData,
  listAuthAccounts,
  listOobCodes,
  getLastOobCode,
  parseActionLink,
  completePasswordReset,
  sendPasswordResetOobCode,
  signInTestUser,
  callFunction,
  decodeClaims,
  scanFirestoreForSecrets
};
