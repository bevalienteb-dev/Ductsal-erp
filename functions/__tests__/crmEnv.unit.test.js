// functions/__tests__/crmEnv.unit.test.js
// UNIT tests (no Firebase, no network): the explicit emulator mode of the CRM client (crm_env.js) and
// how app_core.js / index.html use it. Production behaviour must be unchanged unless the exact
// opt-in ?emulators=demo-ductsal-local is present on a loopback page.

const fs = require('fs');
const path = require('path');
const CrmEnv = require('../../crm_env.js');

const ROOT = path.join(__dirname, '..', '..');
const appCore = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const loc = (hostname, search = '', protocol = 'http:') => ({ hostname, search, protocol });

describe('crm_env: activation matrix', () => {
  test.each([
    ['localhost', '?emulators=demo-ductsal-local'],
    ['127.0.0.1', '?emulators=demo-ductsal-local'],
    ['localhost', '?x=1&emulators=demo-ductsal-local']
  ])('activates on %s %s', (host, search) => {
    expect(CrmEnv.isEmulatorRequested(loc(host, search))).toBe(true);
    expect(CrmEnv.emulatorParamInvalid(loc(host, search))).toBe(false);
  });

  test.each([
    ['localhost', ''],
    ['localhost', '?other=1'],
    ['127.0.0.1', ''],
    ['crm.ductsal.com', ''],
    ['ductsal-erp.web.app', ''],
    ['', '']
  ])('does NOT activate (and is not "invalid") without the param: %s %s', (host, search) => {
    expect(CrmEnv.isEmulatorRequested(loc(host, search))).toBe(false);
    expect(CrmEnv.emulatorParamInvalid(loc(host, search))).toBe(false);
  });

  test.each([
    ['localhost', '?emulators=1'],
    ['localhost', '?emulators='],
    ['localhost', '?emulators=ductsal-erp'],
    ['localhost', '?emulators=Demo-Ductsal-Local'],
    ['localhost', '?emulators=demo-ductsal-local-x'],
    ['crm.ductsal.com', '?emulators=demo-ductsal-local'],
    ['evil.localhost.example.com', '?emulators=demo-ductsal-local'],
    ['', '?emulators=demo-ductsal-local']
  ])('param present but invalid => not activated AND flagged invalid (page must be blocked): %s %s', (host, search) => {
    expect(CrmEnv.isEmulatorRequested(loc(host, search))).toBe(false);
    expect(CrmEnv.emulatorParamInvalid(loc(host, search))).toBe(true);
  });

  test('file: pages (empty hostname) never activate, even with the param', () => {
    const l = loc('', '?emulators=demo-ductsal-local', 'file:');
    expect(CrmEnv.isEmulatorRequested(l)).toBe(false);
    expect(CrmEnv.emulatorParamInvalid(l)).toBe(true);
  });

  test('missing location is safe', () => {
    expect(CrmEnv.isEmulatorRequested(undefined)).toBe(false);
    expect(CrmEnv.emulatorParamInvalid(undefined)).toBe(false);
  });
});

describe('crm_env: configuration', () => {
  test('emulator Firebase config only contains the demo project and a placeholder key', () => {
    const cfg = CrmEnv.emulatorFirebaseConfig();
    expect(cfg.projectId).toBe('demo-ductsal-local');
    expect(JSON.stringify(cfg)).not.toMatch(/ductsal-erp|AIza|948658286825/);
  });

  test('all endpoints are 127.0.0.1', () => {
    for (const e of Object.values(CrmEnv.ENDPOINTS)) expect(e.host).toBe('127.0.0.1');
    expect(CrmEnv.ENDPOINTS.auth.port).toBe(9099);
    expect(CrmEnv.ENDPOINTS.firestore.port).toBe(8080);
    expect(CrmEnv.ENDPOINTS.functions.port).toBe(5001);
  });

  function fakeFb(projectId) {
    const calls = [];
    const fb = {
      app: () => ({ options: { projectId } }),
      auth: () => ({ useEmulator: (...a) => calls.push(['auth', ...a]) }),
      functions: () => ({ useEmulator: (...a) => calls.push(['functions', ...a]) }),
      storage: () => ({ useEmulator: (...a) => calls.push(['storage', ...a]) })
    };
    const db = { useEmulator: (...a) => calls.push(['firestore', ...a]) };
    return { fb, db, calls };
  }

  test('connectEmulators points every service at 127.0.0.1', () => {
    const { fb, db, calls } = fakeFb('demo-ductsal-local');
    const info = CrmEnv.connectEmulators(fb, db);
    expect(info.project).toBe('demo-ductsal-local');
    expect(calls).toEqual(expect.arrayContaining([
      ['firestore', '127.0.0.1', 8080],
      ['auth', 'http://127.0.0.1:9099', { disableWarnings: true }],
      ['functions', '127.0.0.1', 5001]
    ]));
    for (const c of calls) expect(JSON.stringify(c)).not.toMatch(/googleapis|firebaseio|ductsal-erp/);
  });

  test('connectEmulators refuses when Firebase was initialised with another project', () => {
    for (const pid of ['ductsal-erp', undefined, 'demo-other']) {
      const { fb, db, calls } = fakeFb(pid);
      expect(() => CrmEnv.connectEmulators(fb, db)).toThrow(/refused/);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('crm_env: probe (fail safe when an emulator is missing)', () => {
  test('all reachable => nothing missing; probes exactly the three loopback ports', async () => {
    const urls = [];
    const missing = await CrmEnv.probeEmulators(async (u) => { urls.push(u); return {}; });
    expect(missing).toEqual([]);
    expect(urls.sort()).toEqual(['http://127.0.0.1:5001/', 'http://127.0.0.1:8080/', 'http://127.0.0.1:9099/']);
  });

  test.each(['auth', 'firestore', 'functions'])('reports %s when it does not answer', async (name) => {
    const port = CrmEnv.ENDPOINTS[name].port;
    const missing = await CrmEnv.probeEmulators(async (u) => {
      if (u.includes(':' + port + '/')) throw new TypeError('connection refused');
      return {};
    });
    expect(missing).toEqual([name]);
  });

  test('without fetch everything is reported missing', async () => {
    const saved = global.fetch;
    delete global.fetch;
    try {
      expect(await CrmEnv.probeEmulators(null)).toEqual(['auth', 'firestore', 'functions']);
    } finally {
      global.fetch = saved;
    }
  });
});

describe('crm_env: blocking UI helpers', () => {
  test('blockPage replaces the body and writes the message as text (no HTML injection)', () => {
    const p = { textContent: '' };
    const body = { innerHTML: '', querySelector: (sel) => (sel === '#emulator-block p' ? p : null) };
    CrmEnv.blockPage({ body }, '<img src=x onerror=alert(1)>');
    expect(body.innerHTML).toContain('Modo emuladores bloqueado');
    expect(p.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(body.innerHTML).not.toContain('onerror');
  });
});

describe('app_core.js / index.html wiring (static)', () => {
  test('index.html loads crm_env.js before app_core.js and crm_auth.js', () => {
    const env = indexHtml.indexOf('crm_env.js');
    expect(env).toBeGreaterThan(0);
    expect(env).toBeLessThan(indexHtml.indexOf('crm_auth.js'));
    expect(env).toBeLessThan(indexHtml.indexOf('app_core.js'));
  });

  test('production configuration is untouched and still the default', () => {
    expect(appCore).toContain('projectId: "ductsal-erp"');
    expect(appCore).toMatch(/firebase\.initializeApp\(CRM_EMULATOR_MODE \? CrmEnv\.emulatorFirebaseConfig\(\) : firebaseConfig\)/);
    // The mode is derived only from the explicit opt-in, never from plain localhost detection.
    expect(appCore).toMatch(/const CRM_EMULATOR_MODE = \(typeof CrmEnv !== 'undefined'\) && CrmEnv\.isEmulatorRequested\(window\.location\);/);
  });

  test('an invalid emulators param blocks the page BEFORE Firebase is initialised', () => {
    const blockAt = appCore.indexOf('CrmEnv.emulatorParamInvalid(window.location)');
    const initAt = appCore.indexOf('firebase.initializeApp(');
    expect(blockAt).toBeGreaterThan(0);
    expect(blockAt).toBeLessThan(initAt);
    expect(appCore.slice(blockAt, initAt)).toMatch(/blockPage[\s\S]*throw new Error/);
  });

  test('emulators are connected right after Firestore is created and before db.settings / storage', () => {
    const dbAt = appCore.indexOf('const db = firebase.firestore();');
    const connectAt = appCore.indexOf('CrmEnv.connectEmulators(firebase, db)');
    const settingsAt = appCore.indexOf('db.settings(');
    const storageAt = appCore.indexOf('const storage = firebase.storage();');
    expect(dbAt).toBeGreaterThan(0);
    expect(connectAt).toBeGreaterThan(dbAt);
    expect(connectAt).toBeLessThan(settingsAt);
    expect(connectAt).toBeLessThan(storageAt);
  });

  test('the first-manager auto-bootstrap is disabled in every mode (it only warns, nothing is written)', () => {
    const at = appCore.indexOf('function checkInitialLoad()');
    const body = appCore.slice(at, appCore.indexOf('document.addEventListener(', at));
    expect(body).toMatch(/users\.length === 0/);
    expect(body).toMatch(/console\.warn/);
    expect(body).not.toMatch(/saveUserToDB|\.set\(|\.add\(|password:\s*['"]{2}/);
  });

  test('on start-up the emulators are probed and the app does not continue when one is missing', () => {
    const at = appCore.indexOf('CrmEnv.probeEmulators()');
    expect(at).toBeGreaterThan(0);
    const around = appCore.slice(at - 200, at + 900);
    expect(around).toMatch(/CRM_EMULATOR_MODE/);
    expect(around).toMatch(/blockPage/);
    expect(around).toMatch(/return;/);
  });

  test('no real credentials were introduced by emulator mode', () => {
    const env = fs.readFileSync(path.join(ROOT, 'crm_env.js'), 'utf8');
    expect(env).not.toMatch(/AIza|ductsal-erp|BEGIN PRIVATE KEY/);
  });
});

// Executes the REAL start-up block of app_core.js (from its first line up to `const storage = ...`) in a
// sandbox with a recording fake of the Firebase namespace, to check what is initialised and where it is pointed.
describe('app_core.js start-up block, executed (fake Firebase namespace, no network)', () => {
  const start = appCore.indexOf('const firebaseConfig');
  const end = appCore.indexOf('const storage = firebase.storage();') + 'const storage = firebase.storage();'.length;
  const block = appCore.slice(start, end);

  function run(location) {
    const log = { init: null, emulator: [], blocked: null, listeners: [] };
    const svc = (name) => ({ useEmulator: (...a) => log.emulator.push([name, ...a]) });
    const firebase = {
      initializeApp: (cfg) => { log.init = cfg; },
      app: () => ({ options: log.init }),
      firestore: () => Object.assign(svc('firestore'), { settings: () => {} }),
      auth: () => svc('auth'),
      functions: () => svc('functions'),
      storage: () => svc('storage')
    };
    const doc = {
      body: { innerHTML: '', querySelector: () => ({ textContent: '' }) },
      addEventListener: (ev) => log.listeners.push(ev),
      createElement: () => ({ style: {} })
    };
    const CrmEnvLocal = Object.assign({}, CrmEnv, { blockPage: (d, m) => { log.blocked = m; } });
    const fn = new Function('window', 'document', 'firebase', 'CrmEnv', 'console', block + '\nreturn { CRM_EMULATOR_MODE, db };');
    let result = null, error = null;
    try {
      result = fn({ location }, doc, firebase, CrmEnvLocal, { warn() {}, log() {} });
    } catch (e) { error = e; }
    return { log, result, error };
  }

  test('with ?emulators=demo-ductsal-local: demo project only, every service pointed at 127.0.0.1', () => {
    const { log, result, error } = run(loc('127.0.0.1', '?emulators=demo-ductsal-local'));
    expect(error).toBeNull();
    expect(result.CRM_EMULATOR_MODE).toBe(true);
    expect(log.init.projectId).toBe('demo-ductsal-local');
    expect(JSON.stringify(log.init)).not.toMatch(/ductsal-erp|AIza/);
    expect(log.emulator).toEqual(expect.arrayContaining([
      ['firestore', '127.0.0.1', 8080],
      ['auth', 'http://127.0.0.1:9099', { disableWarnings: true }],
      ['functions', '127.0.0.1', 5001]
    ]));
    for (const c of log.emulator) expect(JSON.stringify(c)).toMatch(/127\.0\.0\.1/);
    expect(log.blocked).toBeNull();
  });

  test('without the parameter (even on localhost): production config, NO emulator wiring', () => {
    for (const l of [loc('localhost', ''), loc('127.0.0.1', ''), loc('crm.ductsal.com', '')]) {
      const { log, result, error } = run(l);
      expect(error).toBeNull();
      expect(result.CRM_EMULATOR_MODE).toBe(false);
      expect(log.init.projectId).toBe('ductsal-erp');
      expect(log.emulator).toEqual([]);
    }
  });

  test('an invalid activation blocks the page and never initialises Firebase', () => {
    for (const l of [loc('crm.ductsal.com', '?emulators=demo-ductsal-local'), loc('localhost', '?emulators=ductsal-erp')]) {
      const { log, error } = run(l);
      expect(error).toBeTruthy();
      expect(log.init).toBeNull();
      expect(log.blocked).toMatch(/emulators/);
      expect(log.emulator).toEqual([]);
    }
  });

  test('a project mismatch inside connectEmulators refuses to wire anything', () => {
    const calls = [];
    const fb = { app: () => ({ options: { projectId: 'ductsal-erp' } }), auth: () => ({ useEmulator: () => calls.push('auth') }), functions: () => ({ useEmulator: () => calls.push('fn') }), storage: () => ({ useEmulator: () => calls.push('st') }) };
    expect(() => CrmEnv.connectEmulators(fb, { useEmulator: () => calls.push('fs') })).toThrow(/refused/);
    expect(calls).toEqual([]);
  });
});
