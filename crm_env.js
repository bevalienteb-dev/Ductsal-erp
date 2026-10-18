// crm_env.js
// Explicit, verifiable "emulator mode" for local testing. It changes NOTHING unless the page is opened
// from localhost / 127.0.0.1 with the exact query parameter  ?emulators=demo-ductsal-local
//  - Detecting localhost is NOT enough to activate it (the CRM already treats localhost as `_local`,
//    but that still talks to the real Firebase project).
//  - In emulator mode the real project configuration is never used: Firebase is initialised with the
//    demo project id and a dummy API key, and Auth, Firestore, Functions and Storage are pointed at
//    127.0.0.1. Even a mistake in the wiring therefore cannot reach the production project.
//  - If the parameter is present but not exactly valid, the page is blocked instead of silently
//    falling back to production.
//  - If an emulator is missing the page is blocked (fail safe).
// No credentials or secrets live here: the key below is a placeholder understood only by the emulators.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmEnv = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const EMULATOR_PROJECT = 'demo-ductsal-local';
    const PARAM = 'emulators';
    const LOOPBACK_PAGE_HOSTS = ['localhost', '127.0.0.1'];
    const ENDPOINTS = {
        auth: { host: '127.0.0.1', port: 9099 },
        firestore: { host: '127.0.0.1', port: 8080 },
        functions: { host: '127.0.0.1', port: 5001 },
        storage: { host: '127.0.0.1', port: 9199 } // not started by firebase.emulator.json: calls simply fail locally
    };

    function paramValue(loc) {
        const params = new URLSearchParams((loc && loc.search) || '');
        return params.has(PARAM) ? params.get(PARAM) : null;
    }

    // True only for: page on localhost/127.0.0.1 AND ?emulators=demo-ductsal-local
    function isEmulatorRequested(loc) {
        if (!loc || !LOOPBACK_PAGE_HOSTS.includes(loc.hostname)) return false;
        return paramValue(loc) === EMULATOR_PROJECT;
    }

    // The parameter is present but this is not a valid activation (wrong value, or not on loopback).
    // The caller must block the page rather than continue against production.
    function emulatorParamInvalid(loc) {
        const value = paramValue(loc);
        return value !== null && !isEmulatorRequested(loc);
    }

    function emulatorFirebaseConfig() {
        return {
            apiKey: 'demo-emulator-key',
            projectId: EMULATOR_PROJECT,
            appId: '1:000000000000:web:demo',
            storageBucket: EMULATOR_PROJECT + '.appspot.com'
        };
    }

    // Must run right after initializeApp and BEFORE any other use of the services.
    function connectEmulators(fb, db) {
        const o = fb.app().options || {};
        if (o.projectId !== EMULATOR_PROJECT) {
            throw new Error('Emulator mode refused: Firebase was initialised with project "' + o.projectId + '"');
        }
        db.useEmulator(ENDPOINTS.firestore.host, ENDPOINTS.firestore.port);
        fb.auth().useEmulator('http://' + ENDPOINTS.auth.host + ':' + ENDPOINTS.auth.port, { disableWarnings: true });
        fb.functions().useEmulator(ENDPOINTS.functions.host, ENDPOINTS.functions.port);
        fb.storage().useEmulator(ENDPOINTS.storage.host, ENDPOINTS.storage.port);
        return Object.assign({ project: EMULATOR_PROJECT }, JSON.parse(JSON.stringify(ENDPOINTS)));
    }

    // Resolves with the list of required emulators that did not answer (empty = all reachable).
    // `no-cors` fetch resolves for any HTTP answer and rejects only when nothing is listening.
    async function probeEmulators(fetchFn) {
        const doFetch = fetchFn || (typeof fetch === 'function' ? fetch : null);
        if (!doFetch) return ['auth', 'firestore', 'functions'];
        const missing = [];
        for (const name of ['auth', 'firestore', 'functions']) {
            const e = ENDPOINTS[name];
            try {
                await doFetch('http://' + e.host + ':' + e.port + '/', { mode: 'no-cors', cache: 'no-store' });
            } catch (err) {
                missing.push(name);
            }
        }
        return missing;
    }

    function blockPage(doc, message) {
        const body = doc && doc.body;
        if (!body) return;
        body.innerHTML = '<div id="emulator-block" style="font-family:sans-serif;max-width:640px;margin:10vh auto;padding:24px;' +
            'border:2px solid #b71c1c;border-radius:8px;color:#b71c1c;background:#fff">' +
            '<h2 style="margin-top:0">Modo emuladores bloqueado</h2><p></p></div>';
        body.querySelector('#emulator-block p').textContent = message;
    }

    function showBanner(doc, endpoints) {
        if (!doc || !doc.body) return;
        const el = doc.createElement('div');
        el.id = 'emulator-banner';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#e65100;color:#fff;' +
            'font:600 12px sans-serif;text-align:center;padding:3px';
        el.textContent = 'MODO EMULADORES \u2014 proyecto ' + endpoints.project + ' \u2014 auth ' + endpoints.auth.host + ':' + endpoints.auth.port +
            ' \u00b7 firestore :' + endpoints.firestore.port + ' \u00b7 functions :' + endpoints.functions.port;
        doc.body.appendChild(el);
    }

    return {
        EMULATOR_PROJECT,
        ENDPOINTS,
        isEmulatorRequested,
        emulatorParamInvalid,
        emulatorFirebaseConfig,
        connectEmulators,
        probeEmulators,
        blockPage,
        showBanner
    };
});
