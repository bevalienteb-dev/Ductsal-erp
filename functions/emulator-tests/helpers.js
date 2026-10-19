// functions/emulator-tests/helpers.js
// Helpers for the tests that run against the REAL Firebase emulators (no mocks).
//
// Isolation: every URL below is a hard-coded constant pointing at 127.0.0.1 and the project is the
// demo project. No host or project comes from the environment, so these helpers cannot reach a real
// Firebase project. They never print passwords or tokens.
//
// Node 20 global `fetch` is used (no extra dependency).

const crypto = require('crypto');

const PROJECT = 'demo-ductsal-local';
const AUTH = 'http://127.0.0.1:9099';
const FIRESTORE = 'http://127.0.0.1:8080';
const FUNCTIONS = 'http://127.0.0.1:5001';
const REGION = 'us-central1';
const FAKE_KEY = 'fake-api-key'; // the Auth emulator ignores the key
const OWNER = { Authorization: 'Bearer owner' }; // admin bypass understood ONLY by the emulators
const SEED = { uid: 'seed-test-manager', email: 'gerente.prueba@ductsal-test.invalid', profileId: '1000000000001' };

const randomSecret = () => 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
const randomTag = () => crypto.randomBytes(4).toString('hex');

async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  return { status: res.status, json, text };
}

// ---------- environment checks ----------
async function assertEmulatorsUp() {
  const problems = [];
  const cfg = await http('GET', `${AUTH}/emulator/v1/projects/${PROJECT}/config`).catch(() => null);
  if (!cfg || cfg.status !== 200) problems.push('Auth emulator (127.0.0.1:9099) not answering for ' + PROJECT);
  const fs = await http('POST', `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents:listCollectionIds`,
    { headers: OWNER, body: {} }).catch(() => null);
  if (!fs || fs.status !== 200) problems.push('Firestore emulator (127.0.0.1:8080) not answering for ' + PROJECT);
  const fn = await fetch(`${FUNCTIONS}/`).catch(() => null);
  if (!fn) problems.push('Functions emulator (127.0.0.1:5001) not answering');
  if (problems.length) throw new Error('Emulators are required for this test: ' + problems.join('; '));
}

// ---------- Auth emulator (REST) ----------
const idt = (path) => `${AUTH}/identitytoolkit.googleapis.com/v1/${path}`;

async function signUp(email, password) {
  const r = await http('POST', idt(`accounts:signUp?key=${FAKE_KEY}`), { body: { email, password, returnSecureToken: true } });
  if (r.status !== 200) throw new Error('signUp failed: ' + (r.json && r.json.error && r.json.error.message));
  return { uid: r.json.localId, idToken: r.json.idToken };
}

async function signIn(email, password) {
  const r = await http('POST', idt(`accounts:signInWithPassword?key=${FAKE_KEY}`), { body: { email, password, returnSecureToken: true } });
  if (r.status !== 200) {
    const err = new Error((r.json && r.json.error && r.json.error.message) || 'sign-in failed');
    err.code = 'auth/' + String(err.message).toLowerCase().replace(/_/g, '-').split(' ')[0];
    throw err;
  }
  return { uid: r.json.localId, idToken: r.json.idToken };
}

// Emulator-only: sets the password of an EXISTING emulator account through the admin endpoint.
async function adminSetPassword(localId, password) {
  const r = await http('POST', idt(`projects/${PROJECT}/accounts:update`), { headers: OWNER, body: { localId, password } });
  if (r.status !== 200) throw new Error('admin password update failed: ' + (r.json && r.json.error && r.json.error.message));
}

async function listAuthUsers() {
  const r = await http('POST', idt(`projects/${PROJECT}/accounts:query`), { headers: OWNER, body: { returnUserInfo: true } });
  if (r.status !== 200) throw new Error('accounts:query failed');
  return (r.json.userInfo || []).map(u => ({
    uid: u.localId, email: u.email, disabled: !!u.disabled,
    claims: u.customAttributes ? JSON.parse(u.customAttributes) : {}
  }));
}

async function sendOobCode(email) {
  const r = await http('POST', idt(`accounts:sendOobCode?key=${FAKE_KEY}`), { body: { requestType: 'PASSWORD_RESET', email } });
  if (r.status !== 200) throw new Error('sendOobCode failed: ' + (r.json && r.json.error && r.json.error.message));
}

// The emulator delivers NO email: the codes it generates are exposed through this REST endpoint.
async function listOobCodes() {
  const r = await http('GET', `${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`);
  if (r.status !== 200) throw new Error('oobCodes failed');
  return r.json.oobCodes || [];
}

async function completePasswordReset(oobCode, newPassword) {
  const r = await http('POST', idt(`accounts:resetPassword?key=${FAKE_KEY}`), { body: { oobCode, newPassword } });
  if (r.status !== 200) throw new Error('resetPassword failed: ' + (r.json && r.json.error && r.json.error.message));
}

function decodeClaims(idToken) {
  const payload = String(idToken).split('.')[1];
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

// ---------- Functions emulator: callable protocol ----------
// POST <host>/<project>/<region>/<name>  Authorization: Bearer <idToken>  body {data}
// -> 200 {result} | 4xx/5xx {error:{status,message}}
async function callFunction(name, data, idToken) {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
  const r = await http('POST', `${FUNCTIONS}/${PROJECT}/${REGION}/${name}`, { headers, body: { data } });
  return { httpStatus: r.status, result: r.json && r.json.result, error: r.json && r.json.error };
}

// ---------- Firestore emulator (REST, admin bypass) ----------
const docsUrl = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;

function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return undefined;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

async function listCollectionIds() {
  const r = await http('POST', `${docsUrl}:listCollectionIds`, { headers: OWNER, body: {} });
  return (r.json && r.json.collectionIds) || [];
}

async function listDocs(collection) {
  const out = [];
  let pageToken = '';
  do {
    const r = await http('GET', `${docsUrl}/${collection}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, { headers: OWNER });
    for (const d of (r.json && r.json.documents) || []) out.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields || {}) });
    pageToken = (r.json && r.json.nextPageToken) || '';
  } while (pageToken);
  return out;
}

async function getDoc(collection, id) {
  const r = await http('GET', `${docsUrl}/${collection}/${id}`, { headers: OWNER });
  if (r.status === 404) return null;
  return { id, data: decodeFields(r.json.fields || {}) };
}

// Every field name (recursively) in every document of every collection.
async function findFieldAnywhere(fieldRegex) {
  const hits = [];
  const walk = (obj, where) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (fieldRegex.test(k)) hits.push(`${where}.${k}`);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${where}.${k}`);
    }
  };
  for (const col of await listCollectionIds()) {
    for (const d of await listDocs(col)) walk(d.data, `${col}/${d.id}`);
  }
  return hits;
}

// ---------- minimal stand-in for the Firebase JS namespace used by crm_auth.js ----------
// The Firebase JS SDK is not installed (dependencies cannot change), so the REAL crm_auth.js is driven
// through this REST shim. It talks to the same emulators; it is NOT the browser SDK.
function makeRestFirebase() {
  let session = null; // { uid, idToken }
  const snapshot = () => (session ? {
    uid: session.uid,
    getIdTokenResult: async () => ({ claims: decodeClaims(session.idToken) })
  } : null);
  const authObj = {
    get currentUser() { return snapshot(); },
    onAuthStateChanged(cb) { setTimeout(() => cb(snapshot()), 0); return () => {}; },
    async signInWithEmailAndPassword(email, password) {
      session = await signIn(email, password);
      return { user: snapshot() };
    },
    async sendPasswordResetEmail(email) { await sendOobCode(email); },
    async signOut() { session = null; }
  };
  const fnCode = (status) => String(status || 'unknown').toLowerCase().replace(/_/g, '-');
  const fb = {
    auth: () => authObj,
    functions: () => ({
      httpsCallable: (name) => async (data) => {
        const r = await callFunction(name, data, session && session.idToken);
        if (r.error) throw Object.assign(new Error(r.error.message || ''), { code: 'functions/' + fnCode(r.error.status) });
        return { data: r.result };
      }
    })
  };
  return { fb, setSession: (s) => { session = s; }, hasSession: () => !!session };
}

module.exports = {
  PROJECT, AUTH, FIRESTORE, FUNCTIONS, SEED,
  randomSecret, randomTag, assertEmulatorsUp,
  signUp, signIn, adminSetPassword, listAuthUsers, sendOobCode, listOobCodes, completePasswordReset, decodeClaims,
  callFunction, listCollectionIds, listDocs, getDoc, findFieldAnywhere, makeRestFirebase
};
