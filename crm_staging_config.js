// crm_staging_config.js
// Dedicated configuration and isolation guard for DUCTSAL ERP Staging ('ductsal-erp-staging').
//
// STRICT ISOLATION PRINCIPLES:
// 1. Completely decoupled from production ('ductsal-erp').
// 2. Fail-safe: if active, prohibits any connection or token pointing to production.
// 3. Renders a visible staging banner in the UI to prevent operator confusion.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmStaging = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const STAGING_PROJECT = 'ductsal-erp-staging';

    // Staging configuration template (decommissioned post-UAT).
    const stagingConfig = {
        apiKey: "",
        authDomain: "",
        projectId: STAGING_PROJECT,
        storageBucket: "",
        messagingSenderId: "",
        appId: ""
    };

    function isStagingRequested(loc) {
        if (!loc) return false;
        const host = loc.hostname || '';
        const search = loc.search || '';
        // Explicit staging domains or query parameter ?env=staging
        return host.includes('staging') || search.includes('env=staging');
    }

    function getStagingFirebaseConfig() {
        return Object.assign({}, stagingConfig);
    }

    function assertStagingIsolation(firebaseInstance) {
        if (!firebaseInstance || !firebaseInstance.app) return;
        const app = firebaseInstance.app();
        const pid = (app.options && app.options.projectId) || '';
        if (pid === 'ductsal-erp') {
            const msg = 'CRITICAL MISCONFIGURATION: Staging environment attempted to initialize production project (ductsal-erp)! Connection aborted.';
            console.error(msg);
            if (typeof alert === 'function') alert(msg);
            throw new Error(msg);
        }
    }

    function showStagingBanner(doc) {
        if (!doc || !doc.body) return;
        if (doc.getElementById('staging-banner')) return;
        const el = doc.createElement('div');
        el.id = 'staging-banner';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#8e24aa;color:#fff;' +
            'font:bold 12px sans-serif;text-align:center;padding:4px;box-shadow:0 2px 4px rgba(0,0,0,0.3);';
        el.textContent = '🧪 ENTORNO DE STAGING / PRUEBAS — PROYECTO: ' + STAGING_PROJECT + ' — DATOS SINTÉTICOS';
        doc.body.appendChild(el);
    }

    return {
        STAGING_PROJECT,
        isStagingRequested,
        getStagingFirebaseConfig,
        assertStagingIsolation,
        showStagingBanner
    };
});
