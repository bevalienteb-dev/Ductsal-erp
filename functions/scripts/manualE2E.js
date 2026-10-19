#!/usr/bin/env node
// functions/scripts/manualE2E.js
// Helper for the MANUAL browser test of the CRM against the emulators (see MANUAL_E2E.md).
// Emulator only: every URL is a hard-coded 127.0.0.1 constant (see emulator-tests/helpers.js), the project is
// demo-ductsal-local, and secrets are NEVER printed: they are copied to the macOS clipboard (pbcopy).
//
//   node functions/scripts/manualE2E.js check                  emulators, project and seeded manager
//   node functions/scripts/manualE2E.js server [port]          local UI server: loopback-only + CSP (needs it running)
//   node functions/scripts/manualE2E.js manager-password       new random emulator password for the manager -> clipboard
//   node functions/scripts/manualE2E.js verify <email>         Auth + Firestore state of a created user
//   node functions/scripts/manualE2E.js absent <email>         confirms that NO account/profile exists for that email
//   node functions/scripts/manualE2E.js set-password <email>   completes the pending reset code of that user
//                                                              (what the emulator does instead of sending email)
//                                                              with a random password -> clipboard

const os = require('os');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');
const H = require('../emulator-tests/helpers');

const USERS = 'users_local';
const EXPECTED_CSP_CONNECT = "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";

const out = (m) => console.log(m);
const ok = (m) => out('  [OK]   ' + m);
const bad = (m) => { out('  [FAIL] ' + m); process.exitCode = 1; };
const clip = (text) => execFileSync('pbcopy', { input: text });
const needEmail = () => {
  const e = String(process.argv[3] || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.invalid$/.test(e)) { console.error('Provide a test email ending in .invalid'); process.exit(2); }
  return e;
};

async function check() {
  out('Emulators / project');
  try { await H.assertEmulatorsUp(); ok('Auth 9099, Firestore 8080 and Functions 5001 answer on 127.0.0.1 for ' + H.PROJECT); } catch (e) { bad(e.message); }
  const mgr = (await H.listAuthUsers()).find(u => u.uid === H.SEED.uid);
  if (mgr && mgr.email === H.SEED.email && mgr.claims.manager === true) ok('manager exists in Auth (uid ' + H.SEED.uid + ', claim manager=true)'); else bad('seeded manager missing in Auth');
  const p = await H.getDoc(USERS, H.SEED.profileId);
  if (p && p.data.authUid === H.SEED.uid && p.data.role === 'manager' && p.data.activo === true && !Object.keys(p.data).some(k => /pass/i.test(k))) ok('manager profile exists in users_local/' + H.SEED.profileId + ' (linked by authUid, active, no password field)');
  else bad('manager profile missing or inconsistent in users_local');
}

function get(host, port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method: 'GET', headers, timeout: 3000 }, (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 2500 });
  s.on('connect', () => { s.destroy(); resolve('CONNECTED'); });
  s.on('error', (e) => resolve(e.code || e.message));
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
});

async function server() {
  const port = Number(process.argv[3] || 8123);
  out('Local UI server on port ' + port);
  const root = await get('127.0.0.1', port, '/?emulators=demo-ductsal-local');
  if (root.error) return bad('server not answering on 127.0.0.1:' + port + ' (' + root.error + ')');
  ok('answers on 127.0.0.1 (status ' + root.status + ')');
  const csp = String(root.headers['content-security-policy'] || '');
  if (csp.includes(EXPECTED_CSP_CONNECT)) ok('CSP ' + EXPECTED_CSP_CONNECT); else bad('unexpected CSP: ' + csp);
  if (/connect-src[^;]*(googleapis|firebaseio|\*\.|https:)/.test(csp)) bad('connect-src allows an external host'); else ok('connect-src lists no external host');
  // Not reachable through any non-loopback interface of this machine.
  const nonLoop = [].concat(...Object.values(os.networkInterfaces())).filter(i => i && i.family === 'IPv4' && !i.internal);
  if (nonLoop.length === 0) out('  [INFO] no non-loopback IPv4 interface on this machine');
  for (const i of nonLoop) {
    const r = await tcp(i.address, port);
    if (r === 'CONNECTED') bad('port ' + port + ' accepts connections on ' + i.address); else ok('port ' + port + ' refused on LAN address ' + i.address + ' (' + r + ')');
  }
  for (const [label, path, expected] of [['functions/ source', '/functions/index.js', 404], ['dotfile', '/.gitignore', 404], ['path traversal', '/%2e%2e/%2e%2e/etc/passwd', 404], ['app file', '/crm_env.js', 200]]) {
    const r = await get('127.0.0.1', port, path);
    if (r.status === expected) ok(label + ' -> ' + r.status); else bad(label + ' -> ' + (r.status || r.error) + ' (expected ' + expected + ')');
  }
  const post = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', () => resolve('error')); q.end(); });
  if (post === 405) ok('POST -> 405 (read-only)'); else bad('POST -> ' + post);
}

async function managerPassword() {
  await H.assertEmulatorsUp();
  const pw = H.randomSecret();
  await H.adminSetPassword(H.SEED.uid, pw);
  await H.signIn(H.SEED.email, pw); // proves it works; discards the token
  clip(pw);
  out('Manager password reset on the EMULATOR account ' + H.SEED.email + ' and copied to the clipboard (not printed).');
  out('Paste it into the login form, then copy something else to clear the clipboard.');
}

async function verify() {
  const email = needEmail();
  out('State for ' + email);
  const accounts = (await H.listAuthUsers()).filter(u => String(u.email || '').toLowerCase() === email);
  if (accounts.length === 1) ok('Auth: exactly 1 account (uid ' + accounts[0].uid + ')'); else bad('Auth: ' + accounts.length + ' accounts');
  const profiles = (await H.listDocs(USERS)).filter(d => String(d.data.email || '').toLowerCase() === email);
  if (profiles.length === 1) ok('Firestore: exactly 1 profile in ' + USERS + ' (id ' + profiles[0].id + ')'); else bad('Firestore: ' + profiles.length + ' profiles');
  if (accounts.length === 1 && profiles.length === 1) {
    const p = profiles[0].data;
    p.authUid === accounts[0].uid ? ok('profile.authUid == Auth uid') : bad('profile.authUid does not match the Auth uid');
    p.id !== p.authUid ? ok('commercial id differs from the Auth uid') : bad('commercial id equals the Auth uid');
    out('  [INFO] role=' + p.role + ' activo=' + p.activo + ' nombre=' + JSON.stringify(p.nombre));
    accounts[0].claims.manager !== true ? ok('Auth account has no manager claim') : bad('Auth account has the manager claim');
  }
  const hits = await H.findFieldAnywhere(/pass/i);
  hits.length === 0 ? ok('no password-like field in ANY Firestore document') : bad('password-like fields: ' + hits.join(', '));
  const cols = await H.listCollectionIds();
  out('  [INFO] Firestore collections: ' + cols.join(', '));
  cols.some(c => /_prod$|^userOps$/.test(c)) ? bad('a production-named collection exists in the emulator') : ok('no *_prod / userOps collection in the emulator');
}

async function absent() {
  const email = needEmail();
  out('Nothing should exist for ' + email);
  const accounts = (await H.listAuthUsers()).filter(u => String(u.email || '').toLowerCase() === email);
  accounts.length === 0 ? ok('Auth: 0 accounts') : bad('Auth: ' + accounts.length + ' account(s) exist');
  const profiles = (await H.listDocs(USERS)).filter(d => String(d.data.email || '').toLowerCase() === email);
  profiles.length === 0 ? ok('Firestore: 0 profiles') : bad('Firestore: ' + profiles.length + ' profile(s) exist');
}

async function setPassword() {
  const email = needEmail();
  const codes = (await H.listOobCodes()).filter(c => String(c.email).toLowerCase() === email && c.requestType === 'PASSWORD_RESET');
  if (codes.length === 0) { bad('No pending reset code for ' + email + '. Use "Reset Pass" for that user in the CRM first.'); return; }
  const link = codes[codes.length - 1].oobLink;
  if (!link.startsWith('http://127.0.0.1:9099/')) { bad('Unexpected action link host; refusing'); return; }
  out('Pending reset codes for this user: ' + codes.length + ' (the emulator sent NO email; it only records the code).');
  const pw = H.randomSecret();
  await H.completePasswordReset(codes[codes.length - 1].oobCode, pw);
  clip(pw);
  out('Password set through the emulator (accounts:resetPassword) and copied to the clipboard (not printed).');
}

const cmds = { check, server, 'manager-password': managerPassword, verify, absent, 'set-password': setPassword };
const cmd = cmds[process.argv[2]];
if (!cmd) { console.error('Usage: manualE2E.js ' + Object.keys(cmds).join(' | ')); process.exit(2); }
cmd().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
