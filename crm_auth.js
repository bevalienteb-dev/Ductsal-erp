// crm_auth.js
// Firebase Authentication integration for users created through the admin Cloud Function
// (createUserAdmin). It is intentionally small and self-contained:
//  - Users WITHOUT `authUid` (all historical users) keep the legacy login in app_core.js untouched.
//  - Users WITH `authUid` authenticate with Firebase Authentication; no password is stored in
//    Firestore for them and none is ever sent to the Cloud Function.
//  - New users set their password through Firebase's own password-reset email flow.
//  - Manager authorization is NOT decided here: this file only chooses which creation path to try.
//    The server verifies the caller's Auth token and its `manager` custom claim.
// Every function receives the Firebase namespace (`fb`) explicitly so it can be unit-tested.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmAuth = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const CrmOutbox = (typeof window !== 'undefined' && window.CrmOutbox) ||
                      (typeof globalThis !== 'undefined' && globalThis.CrmOutbox) ||
                      (typeof require === 'function' ? require('./crm_outbox') : null);

    const PRODUCTION_ACTION_CODE_SETTINGS = Object.freeze({
        url: 'https://erp.ductsal.com/login?mode=activate',
        handleCodeInApp: false
    });

    const LOCAL_DEV_PORT = '8123';
    const LOCAL_ACTION_CODE_SETTINGS = Object.freeze({
        url: 'http://127.0.0.1:' + LOCAL_DEV_PORT + '/login?mode=activate',
        handleCodeInApp: false
    });

    function isLocalEnvironment() {
        if (typeof window !== 'undefined' && window.location) {
            const h = window.location.hostname;
            return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0';
        }
        if (typeof process !== 'undefined' && process.env) {
            return process.env.NODE_ENV === 'test' ||
                   process.env.FUNCTIONS_EMULATOR === 'true' ||
                   process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined;
        }
        return false;
    }

    function getActionCodeSettings() {
        if (isLocalEnvironment()) {
            if (typeof window !== 'undefined' && window.location && window.location.host) {
                return Object.freeze({
                    url: window.location.protocol + '//' + window.location.host + '/login?mode=activate',
                    handleCodeInApp: false
                });
            }
            return LOCAL_ACTION_CODE_SETTINGS;
        }
        return PRODUCTION_ACTION_CODE_SETTINGS;
    }

    const ACTION_CODE_SETTINGS = Object.freeze({
        get url() {
            return getActionCodeSettings().url;
        },
        get handleCodeInApp() {
            return false;
        }
    });

    // Roles the CRM recognises that the Cloud Function is allowed to create. `manager` is excluded
    // on purpose: privileged accounts are never created automatically.
    const CREATABLE_ROLES = ['vendedor', 'gestor'];

    // Transport-level outcomes where the server may or may not have completed the operation.
    // The same opId is kept for the next attempt so a retry can never create a second account.
    const UNCERTAIN_CODES = ['unavailable', 'deadline-exceeded', 'internal', 'unknown', 'cancelled'];

    const pendingOps = new Map(); // payload key -> opId

    function normalizeCode(err) {
        const code = (err && err.code) || '';
        return String(code).replace(/^functions\//, '').replace(/^auth\//, '');
    }

    function newOpId() {
        const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        if (c && typeof c.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            c.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('No secure random source available for opId');
    }

    function waitForAuthUser(auth) {
        if (auth.currentUser) return Promise.resolve(auth.currentUser);
        return new Promise(resolve => {
            const unsubscribe = auth.onAuthStateChanged(u => { unsubscribe(); resolve(u || null); });
        });
    }

    // ---------- Login ----------
    // Verifies the credential with Firebase Authentication and that the Auth account is the one
    // linked to the CRM profile (`authUid`). Never reads or writes a password in Firestore.
    async function loginWithFirebase(fb, user, password) {
        if (!fb || typeof fb.auth !== 'function') return { ok: false, reason: 'sdk-unavailable' };
        try {
            const cred = await fb.auth().signInWithEmailAndPassword(user.email, password);
            if (!cred || !cred.user || cred.user.uid !== user.authUid) {
                await fb.auth().signOut();
                return { ok: false, reason: 'uid-mismatch' };
            }
            if (typeof cred.user.getIdTokenResult === 'function') {
                const tok = await cred.user.getIdTokenResult();
                const claims = (tok && tok.claims) || {};
                if (claims.cid && user.id && claims.cid !== user.id) {
                    await fb.auth().signOut();
                    return { ok: false, reason: 'cid-mismatch' };
                }
                if (claims.role && user.role && claims.role !== user.role) {
                    await fb.auth().signOut();
                    return { ok: false, reason: 'role-mismatch' };
                }
                if (user.role === 'manager' && claims.manager !== true) {
                    await fb.auth().signOut();
                    return { ok: false, reason: 'permission-denied' };
                }
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: normalizeCode(e) || 'error' };
        }
    }

    function loginErrorMessage(reason) {
        switch (reason) {
            case 'sdk-unavailable': return 'No se pudo cargar Firebase Authentication. Recarga la página.';
            case 'uid-mismatch': return 'La cuenta de acceso no corresponde a este usuario. Contacta a un gerente.';
            case 'cid-mismatch': return 'El identificador del perfil no coincide con las credenciales de acceso.';
            case 'role-mismatch': return 'El rol asignado no coincide con las credenciales de acceso.';
            case 'permission-denied': return 'La cuenta no cuenta con permisos administrativos verificados.';
            case 'user-disabled': return 'Esta cuenta está deshabilitada.';
            case 'too-many-requests': return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
            case 'network-request-failed': return 'Error de red. Revisa tu conexión.';
            default: return 'Correo o contraseña incorrectos.';
        }
    }

    function signOut(fb) {
        if (!fb || typeof fb.auth !== 'function') return Promise.resolve();
        return Promise.resolve(fb.auth().signOut()).catch(() => { /* session is cleared locally anyway */ });
    }

    // Login lookup. Exact match first (this is the historical behaviour and is the ONLY rule for
    // historical users). Accounts created through the Cloud Function store the email lower-cased, so
    // for those alone a case-insensitive match is accepted. Inactive profiles never match.
    function findLoginUser(users, rawEmail) {
        const email = String(rawEmail || '').trim();
        const list = users || [];
        const exact = list.find(u => u.email === email && u.activo);
        if (exact) return exact;
        const key = email.toLowerCase();
        return list.find(u => u.authUid && u.activo && String(u.email || '').trim().toLowerCase() === key) || null;
    }

    // ---------- Password setup / reset ----------
    // Firebase sends the email and hosts the password form: the password never touches the CRM.
    function sendPasswordSetupEmail(fb, email, actionCodeSettings) {
        if (!fb || typeof fb.auth !== 'function') return Promise.reject(new Error('Auth SDK unavailable'));
        const auth = fb.auth();
        try {
            auth.languageCode = 'es';
        } catch (_) {}
        const settings = actionCodeSettings || getActionCodeSettings();
        return auth.sendPasswordResetEmail(email, settings);
    }

    // ---------- Admin creation ----------
    // Only a hint for choosing the creation path; the server enforces authorization.
    async function hasManagerSession(fb) {
        if (!fb || typeof fb.auth !== 'function') return false;
        try {
            const user = await waitForAuthUser(fb.auth());
            if (!user) return false;
            const token = await user.getIdTokenResult();
            return !!(token && token.claims && token.claims.manager === true);
        } catch (e) {
            return false;
        }
    }

    // Runs `invoke(opId)` keeping the opId cached per `key` while the outcome is uncertain, so a
    // retry of the same request reaches the same server operation and cannot duplicate anything.
    async function callIdempotent(key, invoke) {
        const opId = pendingOps.get(key) || newOpId();
        pendingOps.set(key, opId);
        try {
            const result = await invoke(opId);
            pendingOps.delete(key);
            return result.data;
        } catch (e) {
            const code = normalizeCode(e);
            const inProgress = code === 'already-exists' && /in progress/i.test(e.message || '');
            if (!UNCERTAIN_CODES.includes(code) && !inProgress) pendingOps.delete(key);
            throw e;
        }
    }

    async function createUserViaFunction(fb, { email, nombre, role, dbSuffix }) {
        if (!CREATABLE_ROLES.includes(role)) {
            const err = new Error('Role not allowed');
            err.code = 'invalid-argument';
            throw err;
        }
        // Same normalization as the server: a retry typed with other casing is the same operation.
        email = String(email || '').trim().toLowerCase();
        nombre = String(nombre || '').trim();
        const key = ['create', email, nombre, role, dbSuffix].join('|');
        return callIdempotent(key, opId => {
            const callable = fb.functions().httpsCallable('createUserAdmin');
            return callable({ email, nombre, role, opId, dbSuffix });
        });
    }

    // Explicit desired state (not a blind toggle), so a retried call is idempotent.
    async function setUserActiveViaFunction(fb, { id, activo, dbSuffix }) {
        const key = ['toggle', id, activo, dbSuffix].join('|');
        return callIdempotent(key, opId => {
            const callable = fb.functions().httpsCallable('toggleUserStatusAdmin');
            return callable({ id, activo, opId, dbSuffix });
        });
    }

    // Name and / or role of a user linked to Firebase Auth (updateUserAdmin). Only the fields that changed are sent; the opId is
    // kept while the outcome is uncertain so a retry reaches the same server operation. `manager` is not an assignable role: the
    // server refuses it, and nothing here tries to.
    async function updateUserViaFunction(fb, { id, nombre, role, dbSuffix }) {
        const payload = { id, dbSuffix };
        if (nombre !== undefined) payload.nombre = String(nombre).trim();
        if (role !== undefined) payload.role = role;
        const key = ['update', id, payload.nombre, payload.role, dbSuffix].join('|');
        return callIdempotent(key, opId => {
            const callable = fb.functions().httpsCallable('updateUserAdmin');
            return callable(Object.assign({ opId }, payload));
        });
    }

    function createErrorMessage(err) {
        const code = normalizeCode(err);
        const detail = err && err.message ? ` (${err.message})` : '';
        switch (code) {
            case 'unauthenticated': return 'Tu sesión de Firebase no es válida. Inicia sesión de nuevo.';
            case 'permission-denied': return 'No tienes permiso para crear este usuario (se requiere una cuenta de gerente verificada, un perfil activo y un rol permitido).';
            case 'already-exists': return `Ya existe una cuenta o perfil con ese correo, o la operación sigue en curso${detail}.`;
            case 'failed-precondition':
                if (/manual review/i.test((err && err.message) || '')) {
                    return `La operación requiere revisión manual. No se creó ninguna cuenta adicional${detail}.`;
                }
                return 'La operación anterior no llegó a completarse y no dejó ninguna cuenta creada. Vuelve a intentarlo.';
            case 'invalid-argument': return `Datos inválidos${detail}.`;
            default: return `No se pudo confirmar la creación (${code || 'error'}). Puedes reintentar: se reutiliza la misma operación para no duplicar la cuenta.`;
        }
    }

    function statusErrorMessage(err) {
        const code = normalizeCode(err);
        const detail = err && err.message ? ` (${err.message})` : '';
        switch (code) {
            case 'unauthenticated': return 'Tu sesión de Firebase no es válida. Inicia sesión de nuevo.';
            case 'permission-denied': return `No se pudo cambiar el estado: se requiere una cuenta de gerente verificada con perfil activo${detail}.`;
            case 'failed-precondition': return `No se pudo cambiar el estado${detail}.`;
            case 'not-found': return 'El usuario o su cuenta de acceso no existe.';
            default: return `No se pudo confirmar el cambio de estado (${code || 'error'}). Puedes reintentar sin riesgo de duplicar la operación.`;
        }
    }

    function updateErrorMessage(err) {
        const code = normalizeCode(err);
        const detail = err && err.message ? ` (${err.message})` : '';
        switch (code) {
            case 'unauthenticated': return 'Tu sesión de Firebase no es válida. Inicia sesión de nuevo.';
            case 'permission-denied': return `No se guardó ningún cambio: se requiere una cuenta de gerente verificada, y no puedes cambiar tu propio rol${detail}.`;
            case 'failed-precondition':
                if (/manual review/i.test((err && err.message) || '')) return `La operación requiere revisión manual: la cuenta y el perfil pueden estar desincronizados${detail}.`;
                return `No se guardó ningún cambio${detail}.`;
            case 'already-exists': return `Hay otro cambio de rol en curso. Espera unos segundos y reintenta${detail}.`;
            case 'aborted': return 'El perfil cambió mientras se guardaba. No se aplicó nada; reintenta.';
            case 'not-found': return 'El usuario o su cuenta de acceso no existe.';
            case 'invalid-argument': return `Datos inválidos${detail}.`;
            default: return `No se pudo confirmar el cambio (${code || 'error'}). Puedes reintentar sin riesgo de duplicar la operación.`;
        }
    }

    const NO_MANAGER_SESSION_MESSAGE =
        'No se creó el usuario: el alta de usuarios nuevos requiere una sesión de Firebase de gerente verificada ' +
        '(cuenta de Firebase Authentication con permiso de gerente, vinculada a tu perfil). ' +
        'Cierra sesión e ingresa con esa cuenta, o pide al propietario del sistema que la configure. ' +
        'Por seguridad no se usa el alta antigua con contraseña.';
    const ROLE_NOT_CREATABLE_MESSAGE =
        'No se creó el usuario: solo se pueden crear los roles vendedor y gestor desde aquí. ' +
        'Las cuentas de gerente las configura manualmente el propietario del sistema.';
    const NO_MANAGER_SESSION_STATUS_MESSAGE =
        'No se cambió el estado: requiere una sesión de Firebase de gerente verificada para este usuario.';
    const NO_MANAGER_SESSION_UPDATE_MESSAGE =
        'No se guardó el cambio: editar el nombre o el rol de un usuario con cuenta de Firebase requiere una sesión de gerente verificada. ' +
        'Cierra sesión e ingresa con esa cuenta.';

    // Returns 'created' | 'failed' | 'unavailable'. Every non-'created' outcome has ALREADY been
    // reported through `notify`, and the caller must stop: there is no fallback creation path.
    //  'unavailable' → the Cloud Function path cannot be used (no verified manager session, role not
    //  creatable by the function, SDK missing). 'failed' → the function was called and rejected/failed.
    async function adminCreateUser(fb, { nombre, email, role, dbSuffix }, notify) {
        if (!CREATABLE_ROLES.includes(role)) {
            notify(ROLE_NOT_CREATABLE_MESSAGE);
            return 'unavailable';
        }
        if (!(await hasManagerSession(fb))) {
            notify(NO_MANAGER_SESSION_MESSAGE);
            return 'unavailable';
        }
        let createRes;
        try {
            createRes = await createUserViaFunction(fb, { email, nombre, role, dbSuffix });
        } catch (e) {
            notify(createErrorMessage(e));
            return 'failed';
        }

        const normalized = String(email || '').trim().toLowerCase();
        const requestId = createRes && createRes.requestId;
        const userId = createRes && createRes.id;
        const currentManagerUid = (fb && fb.auth && fb.auth().currentUser && fb.auth().currentUser.uid) || 'manager';

        // Write-Ahead Local Outbox persistence BEFORE calling network
        if (requestId && userId && CrmOutbox) {
            try {
                CrmOutbox.enqueue({
                    requestId,
                    userId,
                    recipientEmail: normalized,
                    operation: 'create_user',
                    outcome: 'unknown',
                    managerAuthUid: currentManagerUid
                });
            } catch (_) {}
        }

        try {
            await sendPasswordSetupEmail(fb, normalized);
            if (requestId && userId) {
                if (CrmOutbox) CrmOutbox.update(requestId, { outcome: 'accepted' });
                try {
                    await recordInvitationOutcomeViaFunction(fb, { requestId, userId, outcome: 'accepted', dbSuffix });
                    if (CrmOutbox) CrmOutbox.dequeue(requestId);
                } catch (_) { /* Retained in outbox for background reconciliation */ }
            }
            notify('Usuario creado. Se envió un correo a ' + normalized + ' para que establezca su contraseña.');
        } catch (e) {
            const errorCode = CrmOutbox ? CrmOutbox.sanitizeErrorCode(e) : 'UNKNOWN_CLIENT_ERROR';
            if (requestId && userId) {
                if (CrmOutbox) CrmOutbox.update(requestId, { outcome: 'failed', errorCode });
                try {
                    await recordInvitationOutcomeViaFunction(fb, { requestId, userId, outcome: 'failed', errorCode, dbSuffix });
                    if (CrmOutbox) CrmOutbox.dequeue(requestId);
                } catch (_) { /* Retained in outbox */ }
            }
            notify('Usuario creado, pero no se pudo enviar el correo para establecer la contraseña. Usa "Reset Pass" para reenviarlo.');
        }
        return 'created';
    }

    // Returns 'updated' | 'failed' | 'unavailable' (same reporting rules as adminCreateUser).
    async function adminSetUserActive(fb, { id, activo, dbSuffix }, notify) {
        if (!(await hasManagerSession(fb))) {
            notify(NO_MANAGER_SESSION_STATUS_MESSAGE);
            return 'unavailable';
        }
        try {
            await setUserActiveViaFunction(fb, { id, activo, dbSuffix });
        } catch (e) {
            notify(statusErrorMessage(e));
            return 'failed';
        }
        return 'updated';
    }

    // Returns { outcome: 'updated' | 'failed' | 'unavailable', result }. Same reporting rules as adminCreateUser: every non-'updated'
    // outcome has ALREADY been explained through `notify`; the browser never writes the profile itself.
    async function adminUpdateUser(fb, { id, nombre, role, dbSuffix }, notify) {
        if (!(await hasManagerSession(fb))) {
            notify(NO_MANAGER_SESSION_UPDATE_MESSAGE);
            return { outcome: 'unavailable' };
        }
        try {
            const result = await updateUserViaFunction(fb, { id, nombre, role, dbSuffix });
            return { outcome: 'updated', result };
        } catch (e) {
            notify(updateErrorMessage(e));
            return { outcome: 'failed' };
        }
    }

    async function linkHistoricalUserViaFunction(fb, { id, dbSuffix }) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const key = 'linkHistoricalUser:' + id;
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('linkHistoricalUserAdmin');
            return fn({ id, opId, dbSuffix });
        });
    }

    async function purgeHistoricalPassword(fb, { id, dbSuffix }) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const fn = fb.functions().httpsCallable('purgeHistoricalPasswordAdmin');
        const res = await fn({ id, dbSuffix });
        return res.data;
    }

    async function listUsersViaFunction(fb, { dbSuffix } = {}) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const fn = fb.functions().httpsCallable('listUsersAdmin');
        const res = await fn({ dbSuffix });
        return (res && res.data && res.data.users) || [];
    }

    async function resendInvitationViaFunction(fb, { id, dbSuffix }) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const key = 'resendInvitation:' + id;
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('resendInvitationAdmin');
            return fn({ id, opId, dbSuffix });
        });
    }

    async function recordInvitationOutcomeViaFunction(fb, { requestId, userId, outcome, errorCode, dbSuffix }) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const fn = fb.functions().httpsCallable('recordInvitationOutcomeAdmin');
        const res = await fn({ requestId, userId, outcome, errorCode, dbSuffix });
        return res.data;
    }

    async function confirmUserActivationViaFunction(fb, { dbSuffix } = {}) {
        if (!fb || typeof fb.functions !== 'function') throw new Error('functions-unavailable');
        const fn = fb.functions().httpsCallable('confirmUserActivation');
        const res = await fn({ dbSuffix });
        return res.data;
    }

    async function reconcileOutbox(fb, { dbSuffix } = {}) {
        if (!CrmOutbox || !fb || typeof fb.auth !== 'function') return [];
        const currentUid = fb.auth().currentUser && fb.auth().currentUser.uid;
        if (!currentUid) return [];
        const pending = CrmOutbox.listPending(currentUid);
        const results = [];
        for (const item of pending) {
            try {
                const res = await recordInvitationOutcomeViaFunction(fb, {
                    requestId: item.requestId,
                    userId: item.userId,
                    outcome: item.outcome,
                    errorCode: item.errorCode,
                    dbSuffix
                });
                CrmOutbox.dequeue(item.requestId);
                results.push({ requestId: item.requestId, success: true, res });
            } catch (err) {
                results.push({ requestId: item.requestId, success: false, error: err && err.message });
            }
        }
        return results;
    }

    function handleActivationReturn(options = {}) {
        const loc = options.location || (typeof window !== 'undefined' ? window.location : null);
        const doc = options.document || (typeof document !== 'undefined' ? document : null);
        const storage = options.storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
        const history = options.history || (typeof window !== 'undefined' ? window.history : null);

        if (!loc || !loc.search) return { isReturn: false, mode: null, email: null, sensitiveCleaned: false };

        let params;
        try {
            params = new URLSearchParams(loc.search);
        } catch (_) {
            return { isReturn: false, mode: null, email: null, sensitiveCleaned: false };
        }

        const mode = params.get('mode');
        const email = params.get('email');
        const isReturn = (mode === 'activate' || mode === 'resetPassword');

        if (isReturn && doc) {
            const banner = doc.getElementById('activation-return-banner');
            if (banner) {
                banner.style.display = 'block';
                banner.innerHTML = '<strong>¡Contraseña configurada con éxito!</strong><br/>Inicia sesión con tu nueva contraseña para acceder y activar tu cuenta.';
            }
            if (email) {
                const emailInput = doc.getElementById('login-email');
                if (emailInput && !emailInput.value) {
                    emailInput.value = email.trim();
                    const passInput = doc.getElementById('login-password');
                    if (passInput && typeof passInput.focus === 'function') passInput.focus();
                }
            }
            if (storage && typeof storage.setItem === 'function') {
                try {
                    storage.setItem('ductsal_activation_return', 'true');
                } catch (_) {}
            }
        }

        // Clean up sensitive / operational parameters from the address bar to prevent leakage
        // via HTTP Referer, browser history, or shoulder-surfing:
        const sensitiveParams = ['mode', 'oobCode', 'apiKey', 'email', 'lang', 'continueUrl'];
        let hasSensitive = false;
        sensitiveParams.forEach(p => {
            if (params.has(p)) {
                params.delete(p);
                hasSensitive = true;
            }
        });

        if (hasSensitive && history && typeof history.replaceState === 'function') {
            const newSearch = params.toString() ? ('?' + params.toString()) : '';
            const newUrl = (loc.pathname || '/') + newSearch + (loc.hash || '');
            try {
                history.replaceState({}, (doc && doc.title) || '', newUrl);
            } catch (_) {}
        }

        return {
            isReturn,
            mode,
            email: email ? email.trim() : null,
            sensitiveCleaned: hasSensitive
        };
    }

    return {
        CREATABLE_ROLES,
        ACTION_CODE_SETTINGS,
        PRODUCTION_ACTION_CODE_SETTINGS,
        LOCAL_ACTION_CODE_SETTINGS,
        getActionCodeSettings,
        isLocalEnvironment,
        handleActivationReturn,
        loginWithFirebase,
        loginErrorMessage,
        findLoginUser,
        signOut,
        sendPasswordSetupEmail,
        hasManagerSession,
        createUserViaFunction,
        setUserActiveViaFunction,
        updateUserViaFunction,
        linkHistoricalUserViaFunction,
        purgeHistoricalPassword,
        listUsersViaFunction,
        resendInvitationViaFunction,
        recordInvitationOutcomeViaFunction,
        confirmUserActivationViaFunction,
        reconcileOutbox,
        getOutbox: () => CrmOutbox,
        createErrorMessage,
        statusErrorMessage,
        updateErrorMessage,
        adminCreateUser,
        adminSetUserActive,
        adminUpdateUser,
        _pendingOps: pendingOps
    };
});
