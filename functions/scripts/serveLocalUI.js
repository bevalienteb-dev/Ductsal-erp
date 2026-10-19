// functions/scripts/serveLocalUI.js
// Read-only static server for opening the CRM against the emulators. It exists to make the isolation
// enforceable by the BROWSER, independently of the application code:
//  - binds 127.0.0.1 only;
//  - serves only the repository root (no directory listing, no path traversal, GET/HEAD only);
//  - sends a Content-Security-Policy whose `connect-src` allows ONLY 'self' and loopback, so the
//    browser blocks every XHR/fetch/WebSocket to any other host (e.g. *.googleapis.com), even if the
//    page tried to reach the real Firebase project. Scripts/styles/fonts from CDNs remain allowed
//    (they are static assets, not data connections).
// Usage: node functions/scripts/serveLocalUI.js [port]   (default 8123)

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || 8123);
const CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "frame-src 'none'"
].join('; ');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.resolve(ROOT, '.' + rel);
  const ext = path.extname(file);
  // Only the repository root, only known static types, never the functions/ folder or dotfiles.
  const inRoot = file.startsWith(ROOT + path.sep);
  const blocked = file.startsWith(path.join(ROOT, 'functions') + path.sep) || file.split(path.sep).some(p => p.startsWith('.'));
  if (!inRoot || blocked || !TYPES[ext] || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Serving ${ROOT} on http://127.0.0.1:${PORT}/ (CSP connect-src limited to loopback)`));
