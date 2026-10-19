// functions/__tests__/seedVisibilityData.unit.test.js
// UNIT tests (fake fetch, in-memory store). The seed script itself is NOT run against any emulator here:
// every request goes to a fake that rejects any URL outside the expected loopback endpoints.

const fs = require('fs');
const path = require('path');
const S = require('../scripts/seedVisibilityData');

const PROJECT = 'demo-ductsal-local';
const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const SCRIPT_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seedVisibilityData.js'), 'utf8');

const encode = (v) => v === null ? { nullValue: null }
  : Array.isArray(v) ? { arrayValue: { values: v.map(encode) } }
  : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) };
const enF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));
const resp = (status, json) => ({ status, text: async () => (json === undefined ? '' : JSON.stringify(json)) });

function makeWorld(overrides = {}) {
  const w = {
    hub: {
      hub: { host: '127.0.0.1', port: 4400 },
      auth: { host: '127.0.0.1', port: 9099, listen: [{ address: '127.0.0.1', port: 9099 }] },
      firestore: { host: '127.0.0.1', port: 8080, listen: [{ address: '127.0.0.1', port: 8080 }] },
      functions: { host: '127.0.0.1', port: 5001 }
    },
    authUsers: [
      { localId: 'seed-test-manager', email: 'gerente.prueba@ductsal-test.invalid', customAttributes: '{"manager":true}' },
      { localId: 'uid-v1', email: 'vendedor.prueba@ductsal-test.invalid', customAttributes: '{"role":"vendedor"}' },
      { localId: 'uid-v2', email: 'vendedor.segundo@ductsal-test.invalid', customAttributes: '{"role":"vendedor"}' }
    ],
    docs: {
      'users_local/1000000000001': { id: '1000000000001', authUid: 'seed-test-manager', email: 'gerente.prueba@ductsal-test.invalid', role: 'manager', activo: true },
      'users_local/1792037387205': { id: '1792037387205', authUid: 'uid-v1', nombre: 'Nanu', email: 'vendedor.prueba@ductsal-test.invalid', role: 'vendedor', activo: true },
      'users_local/1792040000000': { id: '1792040000000', authUid: 'uid-v2', nombre: 'Vendedor Segundo', email: 'vendedor.segundo@ductsal-test.invalid', role: 'vendedor', activo: true }
    },
    calls: [], writes: [], clock: 0,
    ...overrides
  };
  const stamp = (path) => { w.meta = w.meta || {}; w.meta[path] = `2026-10-15T04:00:${String(++w.clock).padStart(2, '0')}.000000Z`; };
  Object.keys(w.docs).forEach(stamp);
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    w.calls.push({ method, url });
    const u = new URL(url);
    if (u.origin === 'http://127.0.0.1:4400' && u.pathname === '/emulators') return resp(200, w.hub);
    if (u.origin === 'http://127.0.0.1:9099') {
      if (u.pathname === `/emulator/v1/projects/${PROJECT}/config`) return resp(200, {});
      if (u.pathname === `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`) return resp(200, { userInfo: w.authUsers });
    }
    if (u.origin === 'http://127.0.0.1:5001' && u.pathname === '/') return resp(404);
    if (url.startsWith(DOCS)) {
      const rest = u.pathname.slice(`/v1/projects/${PROJECT}/databases/(default)/documents`.length);
      if (rest === ':listCollectionIds') return resp(200, { collectionIds: ['users_local'] });
      const parts = rest.split('/').filter(Boolean);
      const col = parts[0];
      const docPath = parts.slice(0, 2).join('/');
      if (method === 'GET' && parts.length === 1) {
        const documents = Object.keys(w.docs).filter((k) => k.startsWith(col + '/')).map((k) => ({ name: `projects/${PROJECT}/databases/(default)/documents/${k}`, fields: enF(w.docs[k]), updateTime: w.meta[k] }));
        return resp(200, documents.length ? { documents } : {});
      }
      if (method === 'GET') return w.docs[docPath] ? resp(200, { name: docPath, fields: enF(w.docs[docPath]), updateTime: w.meta[docPath] }) : resp(404);
      if (method === 'PATCH') {
        w.writes.push({ method, path: docPath });
        if (u.searchParams.get('currentDocument.exists') !== 'false') return resp(400);
        if (w.docs[docPath]) return resp(409);
        const body = JSON.parse(opts.body);
        const dec = (v) => ('stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue)
          : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null);
        w.docs[docPath] = Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, dec(v)]));
        stamp(docPath);
        return resp(200, {});
      }
      if (method === 'DELETE') {
        w.writes.push({ method, path: docPath });
        if (!w.docs[docPath]) return resp(404);
        if (u.searchParams.get('currentDocument.updateTime') !== w.meta[docPath]) return resp(400);
        delete w.docs[docPath];
        return resp(200, {});
      }
    }
    throw new Error(`UNEXPECTED REQUEST ${method} ${url}`);
  };
  return w;
}

const run = (w, argv = [], env = {}) => {
  const logs = [];
  return S.run({ fetchImpl: w.fetch, env, argv, log: (m) => logs.push(m) }).then((r) => ({ r, logs }));
};
const ours = (w) => Object.keys(w.docs).filter((k) => !k.startsWith('users_local/'));

describe('arguments and environment', () => {
  test('unknown arguments are refused', () => {
    expect(() => S.parseArgs(['--force'])).toThrow(S.Refusal);
  });

  test.each([
    [['--project', 'ductsal-erp'], {}],
    [['--project=ductsal-erp'], {}],
    [[], { GCLOUD_PROJECT: 'ductsal-erp' }],
    [[], { GOOGLE_CLOUD_PROJECT: 'ductsal-erp' }],
    [[], { GCP_PROJECT: 'ductsal-erp' }],
    [[], { FIREBASE_CONFIG: JSON.stringify({ projectId: 'ductsal-erp' }) }],
    [[], { FIREBASE_CONFIG: 'not-json' }],
    [[], { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' }],
    [[], { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }],
    [[], { FIREBASE_AUTH_EMULATOR_HOST: '10.0.0.5:9099' }],
    [[], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:9999' }]
  ])('refuses before any request: argv=%j env=%j', async (argv, env) => {
    const w = makeWorld();
    await expect(run(w, argv, env)).rejects.toThrow(S.Refusal);
    expect(w.calls).toHaveLength(0);
  });

  test('accepts the demo project explicitly and loopback emulator hosts', async () => {
    const w = makeWorld();
    const { r } = await run(w, ['--dry-run', '--project', PROJECT], {
      GCLOUD_PROJECT: PROJECT, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099'
    });
    expect(r.wouldCreate).toHaveLength(3);
  });
});

describe('emulator verification', () => {
  test.each([
    ['functions emulator missing', (w) => { delete w.hub.functions; }],
    ['auth on another port', (w) => { w.hub.auth.port = 9999; }],
    ['firestore on another host', (w) => { w.hub.firestore.host = '10.0.0.5'; }],
    ['firestore listening on a LAN address', (w) => { w.hub.firestore.listen = [{ address: '0.0.0.0', port: 8080 }]; }],
    ['seed manager missing in Auth', (w) => { w.authUsers = w.authUsers.filter((a) => a.localId !== 'seed-test-manager'); }],
    ['seed manager profile missing', (w) => { delete w.docs['users_local/1000000000001']; }]
  ])('aborts without writing: %s', async (_name, mutate) => {
    const w = makeWorld();
    mutate(w);
    await expect(run(w)).rejects.toThrow();
    expect(w.writes).toHaveLength(0);
  });

  test('aborts when the hub does not answer', async () => {
    const w = makeWorld();
    const real = w.fetch;
    w.fetch = async (url, o) => (url.includes(':4400') ? resp(500) : real(url, o));
    await expect(run(w)).rejects.toThrow(/hub/);
  });

  test('only loopback endpoints are ever requested', async () => {
    const w = makeWorld();
    await run(w, ['--dry-run']);
    for (const c of w.calls) expect(new URL(c.url).hostname).toBe('127.0.0.1');
  });
});

describe('scenario data', () => {
  const u1 = { id: '111', nombre: 'Uno', role: 'vendedor' };
  const u2 = { id: '222', nombre: 'Dos', role: 'vendedor' };
  const plan = S.buildScenario(u1, u2, '2026-10-15T00:00:00.000Z');
  const byPath = Object.fromEntries(plan.map((p) => [p.path, p.data]));

  test('exactly C1, P1, P2, in the _local collections only', () => {
    expect(Object.keys(byPath).sort()).toEqual(['clients_local/CTEST-VIS-C1', 'prospects_local/TEST-VIS-P1', 'prospects_local/TEST-VIS-P2']);
  });

  test('every document is marked and has an unmistakable id/code', () => {
    for (const [p, d] of Object.entries(byPath)) {
      expect(d.esDatoDePrueba).toBe(true);
      expect(d.escenarioPrueba).toBe('visibilidad-vendedores-v1');
      expect(p.split('/')[1]).toMatch(/TEST-VIS-/);
      expect(d.id).toBe(p.split('/')[1]);
    }
    expect(byPath['prospects_local/TEST-VIS-P1'].proyecto).toMatch(/^\[PRUEBA\]/);
  });

  test('ownership: C1 and P1 belong to seller 1, P2 to seller 2; C1 has no vendedorId (CRM schema)', () => {
    const c1 = byPath['clients_local/CTEST-VIS-C1'];
    const p1 = byPath['prospects_local/TEST-VIS-P1'];
    const p2 = byPath['prospects_local/TEST-VIS-P2'];
    expect(c1.createdBy).toBe('111');
    expect(c1).not.toHaveProperty('vendedorId');
    expect([p1.createdBy, p1.vendedorId]).toEqual(['111', '111']);
    expect([p2.createdBy, p2.vendedorId]).toEqual(['222', '222']);
    expect(p1.clientId).toBe('CTEST-VIS-C1');
    expect(p2.clientId).toBe('CTEST-VIS-C1');
  });

  test('values come from the CRM forms; no passwords; no real e-mail addresses', () => {
    const p1 = byPath['prospects_local/TEST-VIS-P1'];
    expect(['Prospección del vendedor', 'Llamada telefónica', 'WhatsApp', 'Página web', 'Correo', 'Redes Sociales', 'Ya es cliente']).toContain(p1.origen);
    expect(['Fabricación e instalación', 'Fabricación']).toContain(p1.tipo_proyecto);
    expect(['Chute', 'Ducto']).toContain(p1.tipo_producto);
    expect([p1.etapa, p1.estado]).toEqual(['prospecto', 'activo']);
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/pass/i);
    const emails = text.match(/[\w.+-]+@[\w.-]+/g) || [];
    for (const e of emails) expect(e).toMatch(/\.invalid$/);
  });

  test('the seller e-mails are .invalid', () => {
    expect(S.V1_EMAIL).toMatch(/\.invalid$/);
    expect(S.V2_EMAIL).toMatch(/\.invalid$/);
  });
});

describe('load', () => {
  test('dry-run performs no write at all', async () => {
    const w = makeWorld();
    const { r } = await run(w, ['--dry-run']);
    expect(r.wouldCreate).toHaveLength(3);
    expect(w.writes).toHaveLength(0);
    expect(ours(w)).toHaveLength(0);
  });

  test('creates the 3 documents; the second run detects them and writes nothing (idempotent)', async () => {
    const w = makeWorld();
    const first = await run(w);
    expect(first.r.created).toHaveLength(3);
    expect(ours(w).sort()).toEqual(['clients_local/CTEST-VIS-C1', 'prospects_local/TEST-VIS-P1', 'prospects_local/TEST-VIS-P2']);
    const writesAfterFirst = w.writes.length;
    const second = await run(w);
    expect(second.r.created).toHaveLength(0);
    expect(second.r.skipped).toHaveLength(3);
    expect(w.writes).toHaveLength(writesAfterFirst);
  });

  test('written records point at the real profile ids of the two sellers', async () => {
    const w = makeWorld();
    await run(w);
    expect(w.docs['clients_local/CTEST-VIS-C1'].createdBy).toBe('1792037387205');
    expect(w.docs['prospects_local/TEST-VIS-P1'].vendedorId).toBe('1792037387205');
    expect(w.docs['prospects_local/TEST-VIS-P2'].vendedorId).toBe('1792040000000');
  });

  test('writes only inside clients_local and prospects_local; users and Auth are untouched', async () => {
    const w = makeWorld();
    const usersBefore = JSON.stringify(Object.entries(w.docs).filter(([k]) => k.startsWith('users_local/')));
    const authBefore = JSON.stringify(w.authUsers);
    await run(w);
    for (const wr of w.writes) expect(wr.path).toMatch(/^(clients_local|prospects_local)\/(CTEST-VIS-C1|TEST-VIS-P[12])$/);
    expect(JSON.stringify(Object.entries(w.docs).filter(([k]) => k.startsWith('users_local/')))).toBe(usersBefore);
    expect(JSON.stringify(w.authUsers)).toBe(authBefore);
    expect(w.calls.filter((c) => !['GET', 'PATCH', 'DELETE'].includes(c.method) && !c.url.includes('listCollectionIds') && !c.url.includes('accounts:query'))).toEqual([]);
  });

  test('seller 2 missing: refuses, points to the UI procedure, never creates the user', async () => {
    const w = makeWorld();
    delete w.docs['users_local/1792040000000'];
    w.authUsers = w.authUsers.filter((a) => a.localId !== 'uid-v2');
    await expect(run(w)).rejects.toThrow(/Create it from the CRM UI/);
    expect(w.writes).toHaveLength(0);
    expect(w.authUsers.some((a) => a.email === 'vendedor.segundo@ductsal-test.invalid')).toBe(false);
  });

  test.each([
    ['seller 1 inactive', (w) => { w.docs['users_local/1792037387205'].activo = false; }],
    ['seller 2 is a gestor', (w) => { w.docs['users_local/1792040000000'].role = 'gestor'; }],
    ['seller 2 without authUid', (w) => { delete w.docs['users_local/1792040000000'].authUid; }],
    ['seller 2 Auth account disabled', (w) => { w.authUsers.find((a) => a.localId === 'uid-v2').disabled = true; }],
    ['seller 2 profile points to a different Auth uid', (w) => { w.docs['users_local/1792040000000'].authUid = 'other'; }],
    ['duplicate profile for seller 1', (w) => { w.docs['users_local/1792099999999'] = { ...w.docs['users_local/1792037387205'], id: '1792099999999' }; }]
  ])('refuses without writing: %s', async (_n, mutate) => {
    const w = makeWorld();
    mutate(w);
    await expect(run(w)).rejects.toThrow();
    expect(w.writes).toHaveLength(0);
  });

  test('refuses to load next to records that are not test data', async () => {
    const w = makeWorld();
    w.docs['prospects_local/1790000000000'] = { id: '1790000000000', proyecto: 'Algo real' };
    w.meta['prospects_local/1790000000000'] = '2026-10-15T04:10:00.000000Z';
    await expect(run(w)).rejects.toThrow(/not test data/);
    expect(w.writes).toHaveLength(0);
  });

  test.each([
    ['exists without the marker', { id: 'TEST-VIS-P1', proyecto: 'otro' }],
    ['exists with the marker but another owner', { id: 'TEST-VIS-P1', codigo: 'TEST-001', clientId: 'CTEST-VIS-C1', createdBy: 'x', vendedorId: 'x', proyecto: '[PRUEBA] Chute vendedor 1', esDatoDePrueba: true, escenarioPrueba: 'visibilidad-vendedores-v1' }]
  ])('never overwrites a pre-existing id: %s', async (_n, doc) => {
    const w = makeWorld();
    w.docs['prospects_local/TEST-VIS-P1'] = doc;
    w.meta['prospects_local/TEST-VIS-P1'] = '2026-10-15T04:10:00.000000Z';
    if (doc.esDatoDePrueba !== true) {
      // the foreign-data guard fires first, which is also a refusal
    }
    const before = JSON.stringify(w.docs['prospects_local/TEST-VIS-P1']);
    await expect(run(w)).rejects.toThrow();
    expect(w.writes).toHaveLength(0);
    expect(JSON.stringify(w.docs['prospects_local/TEST-VIS-P1'])).toBe(before);
  });
});

describe('cleanup', () => {
  test('deletes exactly the 3 marked documents and nothing else', async () => {
    const w = makeWorld();
    await run(w);
    // Unrelated documents that must survive (unmarked and marked with another scenario).
    w.docs['prospects_local/9999'] = { id: '9999', proyecto: 'ajeno' };
    w.docs['prospects_local/TEST-OTHER'] = { id: 'TEST-OTHER', esDatoDePrueba: true, escenarioPrueba: 'otro' };
    w.meta['prospects_local/9999'] = 'x1';
    w.meta['prospects_local/TEST-OTHER'] = 'x2';
    w.writes.length = 0;
    const usersBefore = Object.keys(w.docs).filter((k) => k.startsWith('users_local/')).length;
    const { r } = await run(w, ['--cleanup']);
    expect(r.deleted.sort()).toEqual(['clients_local/CTEST-VIS-C1', 'prospects_local/TEST-VIS-P1', 'prospects_local/TEST-VIS-P2']);
    expect(w.docs['prospects_local/9999']).toBeDefined();
    expect(w.docs['prospects_local/TEST-OTHER']).toBeDefined();
    expect(Object.keys(w.docs).filter((k) => k.startsWith('users_local/'))).toHaveLength(usersBefore);
    expect(w.writes.every((x) => x.method === 'DELETE')).toBe(true);
  });

  test('--cleanup --dry-run deletes nothing', async () => {
    const w = makeWorld();
    await run(w);
    w.writes.length = 0;
    const { r } = await run(w, ['--cleanup', '--dry-run']);
    expect(r.wouldDelete).toHaveLength(3);
    expect(w.writes).toHaveLength(0);
    expect(ours(w)).toHaveLength(3);
  });

  test('if one of the ids exists without the marker, nothing is deleted at all', async () => {
    const w = makeWorld();
    await run(w);
    delete w.docs['prospects_local/TEST-VIS-P2'].esDatoDePrueba;
    w.writes.length = 0;
    await expect(run(w, ['--cleanup'])).rejects.toThrow(/Deleting nothing/);
    expect(w.writes).toHaveLength(0);
    expect(ours(w)).toHaveLength(3);
  });

  test('cleanup on an empty scenario is a no-op', async () => {
    const w = makeWorld();
    const { r } = await run(w, ['--cleanup']);
    expect(r.deleted).toHaveLength(0);
    expect(w.writes).toHaveLength(0);
  });

  test('cleanup also runs the emulator checks first', async () => {
    const w = makeWorld();
    w.hub.auth.port = 1234;
    await expect(run(w, ['--cleanup'])).rejects.toThrow();
    expect(w.writes).toHaveLength(0);
  });

  test('the delete carries a precondition on updateTime (a changed document is not deleted)', async () => {
    const w = makeWorld();
    await run(w);
    const real = w.fetch;
    w.fetch = async (url, o = {}) => {
      if (o.method === 'DELETE') w.meta['prospects_local/TEST-VIS-P1'] = 'changed-meanwhile';
      return real(url, o);
    };
    await expect(run(w, ['--cleanup'])).rejects.toThrow(/failed/);
  });
});

describe('static properties of the script', () => {
  test('no credentials, firebase-admin, production project, or external host', () => {
    expect(SCRIPT_SRC).not.toMatch(/ductsal-erp/);
    expect(SCRIPT_SRC).not.toMatch(/firebase-admin|serviceAccount|private_key|AIza/);
    const urls = SCRIPT_SRC.match(/https?:\/\/[^\s'"`)]+/g) || [];
    for (const u of urls) expect(u).toMatch(/^http:\/\/127\.0\.0\.1/);
    expect(SCRIPT_SRC).not.toMatch(/https:\/\//);
  });

  test('requiring the module has no side effects (does not run)', () => {
    expect(typeof S.run).toBe('function');
  });
});
