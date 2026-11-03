// modules/users/auth_session.js
// Manejo del ciclo de vida de sesiones, autenticación, login, logout y sincronización de identidad.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.AuthSession = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    let pendingSetupUser = null;

    function getPendingSetupUser() {
        return pendingSetupUser;
    }

    function setPendingSetupUser(u) {
        pendingSetupUser = u;
    }

    function checkAuth(options = {}) {
        const deps = Object.assign({
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            applyRolePermissions: () => (typeof applyRolePermissions === 'function' ? applyRolePermissions() : null),
            doc: typeof document !== 'undefined' ? document : null
        }, options);

        const doc = deps.doc;
        if (!doc) return;

        const mainApp = doc.getElementById('main-app');
        const loginScreen = doc.getElementById('login-screen');
        const setupScreen = doc.getElementById('setup-screen');
        const user = typeof deps.getCurrentUser === 'function' ? deps.getCurrentUser() : (deps.getCurrentUser || null);

        if (!user) {
            if (mainApp && mainApp.style) mainApp.style.display = 'none';
            if (loginScreen && loginScreen.style) loginScreen.style.display = 'flex';
            if (setupScreen && setupScreen.style) setupScreen.style.display = 'none';
        } else {
            if (mainApp && mainApp.style) mainApp.style.display = 'flex';
            if (loginScreen && loginScreen.style) loginScreen.style.display = 'none';
            if (setupScreen && setupScreen.style) setupScreen.style.display = 'none';

            const nameEl = doc.getElementById('ui-user-name');
            const roleEl = doc.getElementById('ui-user-role');
            if (nameEl) nameEl.textContent = user.nombre || user.email || user.id || '';

            let rName = 'Vendedor';
            if (user.role === 'manager') rName = 'Gerente';
            else if (user.role === 'gestor') rName = 'Gestor de Ventas';
            else if (typeof UsersPermissions !== 'undefined' && typeof UsersPermissions.getRoleDisplayName === 'function') {
                rName = UsersPermissions.getRoleDisplayName(user.role);
            }
            if (roleEl) roleEl.textContent = rName;

            if (typeof deps.applyRolePermissions === 'function') {
                deps.applyRolePermissions();
            }
        }
    }

    async function processLogin(options = {}, event = null) {
        let deps = options;
        let e = event;
        if (options && typeof options.preventDefault === 'function') {
            e = options;
            deps = {};
        }

        if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }

        const resolvedDeps = Object.assign({
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            processFirebaseLogin: (u, p) => (typeof processFirebaseLogin === 'function' ? processFirebaseLogin(u, p) : null),
            processDirectFirebaseAuthLogin: (em, p) => (typeof processDirectFirebaseAuthLogin === 'function' ? processDirectFirebaseAuthLogin(em, p) : null),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg)),
            doc: typeof document !== 'undefined' ? document : null
        }, deps);

        const doc = resolvedDeps.doc;
        if (!doc) return;

        const emailEl = doc.getElementById('login-email');
        const passEl = doc.getElementById('login-password');
        const email = emailEl ? emailEl.value.trim() : '';
        const pass = passEl ? passEl.value : '';

        const userList = typeof resolvedDeps.getUsers === 'function' ? resolvedDeps.getUsers() : (resolvedDeps.getUsers || []);
        const CrmAuth = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
        const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);

        const user = CrmAuth && typeof CrmAuth.findLoginUser === 'function'
            ? CrmAuth.findLoginUser(userList, email)
            : userList.find(u => u.email === email && u.activo);

        if (!user) {
            // Fallback de login directo con Firebase Auth si la colección aún no se ha cargado
            if (fb && typeof fb.auth === 'function' && pass) {
                return resolvedDeps.processDirectFirebaseAuthLogin(email, pass);
            }
            return resolvedDeps.notify("Usuario no encontrado o inactivo.");
        }

        // SEC-03: Todo login autenticado requiere Firebase Authentication
        if (user.authUid) {
            return resolvedDeps.processFirebaseLogin(user, pass);
        }

        if (fb && typeof fb.auth === 'function' && pass) {
            return resolvedDeps.processDirectFirebaseAuthLogin(email, pass);
        }

        return resolvedDeps.notify("Esta cuenta histórica requiere vinculación a Firebase Authentication por un administrador antes de ingresar.");
    }

    async function processDirectFirebaseAuthLogin(options = {}, emailArg = '', passArg = '') {
        let deps = options;
        let email = emailArg;
        let pass = passArg;
        if (typeof options === 'string') {
            email = options;
            pass = emailArg;
            deps = {};
        }

        const resolvedDeps = Object.assign({
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDb: () => (typeof db !== 'undefined' ? db : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            setCurrentUser: (u) => { if (typeof currentUser !== 'undefined') currentUser = u; },
            attachDataListeners: (r, c) => (typeof attachDataListeners === 'function' ? attachDataListeners(r, c) : null),
            checkAuth: () => (typeof checkAuth === 'function' ? checkAuth() : null),
            reRenderApp: () => (typeof reRenderApp === 'function' ? reRenderApp() : null),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg)),
            storage: typeof localStorage !== 'undefined' ? localStorage : null
        }, deps);

        const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);
        if (!fb || typeof fb.auth !== 'function') return;

        const CrmAuth = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
        const dbSuffix = typeof resolvedDeps.getDbSuffix === 'function' ? resolvedDeps.getDbSuffix() : (resolvedDeps.getDbSuffix || '_prod');
        const firestore = typeof resolvedDeps.getDb === 'function' ? resolvedDeps.getDb() : (resolvedDeps.getDb || null);

        try {
            const cred = await fb.auth().signInWithEmailAndPassword(email, pass);
            if (!cred || !cred.user) return resolvedDeps.notify("Error al iniciar sesión.");

            const tok = await cred.user.getIdTokenResult();
            const cid = tok && tok.claims && tok.claims.cid;
            const role = tok && tok.claims && tok.claims.role;
            const managerClaim = tok && tok.claims && tok.claims.manager === true;

            const validCrmRoles = ['manager', 'gestor', 'vendedor'];
            if (!cid || !role || !validCrmRoles.includes(role)) {
                await fb.auth().signOut();
                return resolvedDeps.notify("La cuenta de acceso no tiene un perfil comercial asignado.");
            }

            if (role === 'manager' && !managerClaim) {
                await fb.auth().signOut();
                return resolvedDeps.notify("La cuenta no cuenta con permisos administrativos verificados.");
            }

            let profile = { id: cid, authUid: cred.user.uid, email, role, activo: true, nombre: cred.user.displayName || email };

            if (!firestore || typeof firestore.collection !== 'function') {
                await fb.auth().signOut();
                return resolvedDeps.notify("Base de datos no disponible para verificar perfil comercial.");
            }

            try {
                const DB_SUFFIX = dbSuffix;
                const snap = await firestore.collection(`users${DB_SUFFIX}`).doc(cid).get();
                if (!snap || !snap.exists) {
                    await fb.auth().signOut();
                    return resolvedDeps.notify("No existe un perfil comercial registrado para este identificador.");
                }
                const sdata = (typeof snap.data === 'function' ? snap.data() : snap.data) || {};
                if (sdata.id && sdata.id !== cid) {
                    await fb.auth().signOut();
                    return resolvedDeps.notify("Inconsistencia de perfil: el identificador no coincide.");
                }
                if (sdata.activo === false) {
                    await fb.auth().signOut();
                    return resolvedDeps.notify("Esta cuenta se encuentra inactiva. Contacta a un administrador.");
                }
                if (sdata.authUid && sdata.authUid !== cred.user.uid) {
                    await fb.auth().signOut();
                    return resolvedDeps.notify("Inconsistencia de identidad: el UID de autenticación no coincide con el perfil.");
                }
                if (sdata.role && sdata.role !== role) {
                    await fb.auth().signOut();
                    return resolvedDeps.notify("Inconsistencia en el rol del usuario asignado.");
                }
                const hasLegacyPwd = sdata.password !== undefined && sdata.password !== null && sdata.password !== "";
                delete sdata.password;
                profile = Object.assign(profile, sdata);
                delete profile.password;
                if (hasLegacyPwd && CrmAuth && typeof CrmAuth.purgeHistoricalPassword === 'function') {
                    CrmAuth.purgeHistoricalPassword(fb, { id: cid, dbSuffix }).catch(() => {});
                }
            } catch (err) {
                console.error('[CRM] Error al verificar perfil comercial en Firestore:', err);
                await fb.auth().signOut();
                return resolvedDeps.notify("Error al verificar perfil comercial en la base de datos.");
            }

            resolvedDeps.setCurrentUser(profile);
            if (resolvedDeps.storage) {
                resolvedDeps.storage.setItem('ductsal_current_user', JSON.stringify(profile));
            }
            if (typeof resolvedDeps.attachDataListeners === 'function') {
                resolvedDeps.attachDataListeners(profile.role, profile.id);
            }
            try {
                if (typeof resolvedDeps.checkAuth === 'function') resolvedDeps.checkAuth();
            } catch (uiErr) {
                console.error('[CRM] Error no fatal en checkAuth tras login:', uiErr);
            }
            try {
                if (typeof resolvedDeps.reRenderApp === 'function') resolvedDeps.reRenderApp();
            } catch (renderErr) {
                console.error('[CRM] Error no fatal en reRenderApp tras login:', renderErr);
            }
        } catch (e) {
            const reason = (CrmAuth && typeof CrmAuth.normalizeCode === 'function') ? CrmAuth.normalizeCode(e) : (e && e.code);
            const msg = (CrmAuth && typeof CrmAuth.loginErrorMessage === 'function')
                ? CrmAuth.loginErrorMessage(reason)
                : "Correo o contraseña incorrectos.";
            resolvedDeps.notify(msg);
        }
    }

    async function processFirebaseLogin(options = {}, userArg = null, passArg = '') {
        let deps = options;
        let user = userArg;
        let pass = passArg;
        if (options && options.id) {
            user = options;
            pass = userArg;
            deps = {};
        }

        const resolvedDeps = Object.assign({
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            setCurrentUser: (u) => { if (typeof currentUser !== 'undefined') currentUser = u; },
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            attachDataListeners: (r, c) => (typeof attachDataListeners === 'function' ? attachDataListeners(r, c) : null),
            checkAuth: () => (typeof checkAuth === 'function' ? checkAuth() : null),
            reRenderApp: () => (typeof reRenderApp === 'function' ? reRenderApp() : null),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg)),
            storage: typeof localStorage !== 'undefined' ? localStorage : null
        }, deps);

        const CrmAuth = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
        if (!CrmAuth) return resolvedDeps.notify("No se pudo cargar el módulo de autenticación. Recarga la página.");
        if (!pass) return resolvedDeps.notify("Ingresa tu contraseña.");

        const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);
        const res = await CrmAuth.loginWithFirebase(fb, user, pass);
        if (!res.ok) return resolvedDeps.notify(CrmAuth.loginErrorMessage(res.reason));

        resolvedDeps.setCurrentUser(user);
        if (resolvedDeps.storage) {
            resolvedDeps.storage.setItem('ductsal_current_user', JSON.stringify(user));
        }
        if (typeof resolvedDeps.attachDataListeners === 'function') {
            resolvedDeps.attachDataListeners(user.role, user.id);
        }
        if (typeof resolvedDeps.checkAuth === 'function') resolvedDeps.checkAuth();
        if (typeof resolvedDeps.reRenderApp === 'function') resolvedDeps.reRenderApp();

        // Purga de contraseña heredada en Firestore tras inicio de sesión confirmado
        const dbSuffix = typeof resolvedDeps.getDbSuffix === 'function' ? resolvedDeps.getDbSuffix() : (resolvedDeps.getDbSuffix || '_prod');
        if (user.password !== undefined && user.password !== null && user.password !== "" && typeof CrmAuth.purgeHistoricalPassword === 'function') {
            CrmAuth.purgeHistoricalPassword(fb, { id: user.id, dbSuffix })
                .then(() => {
                    delete user.password;
                    const cur = typeof resolvedDeps.getCurrentUser === 'function' ? resolvedDeps.getCurrentUser() : (resolvedDeps.getCurrentUser || null);
                    if (cur) delete cur.password;
                    if (resolvedDeps.storage) {
                        resolvedDeps.storage.setItem('ductsal_current_user', JSON.stringify(cur || user));
                    }
                })
                .catch(err => {
                    console.warn('[CRM] No se pudo purgar contraseña histórica tras login verificado:', err && err.message);
                });
        }
    }

    function processLogout(options = {}) {
        const deps = Object.assign({
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            detachSnapshotListeners: () => (typeof detachSnapshotListeners === 'function' ? detachSnapshotListeners() : null),
            clearCollections: () => {
                if (typeof clients !== 'undefined') clients = [];
                if (typeof prospects !== 'undefined') prospects = [];
                if (typeof users !== 'undefined') users = [];
            },
            setCurrentUser: (u) => { if (typeof currentUser !== 'undefined') currentUser = u; },
            setInitialRoleViewRouted: (v) => { if (typeof initialRoleViewRouted !== 'undefined') initialRoleViewRouted = v; },
            incrementAuthSessionGeneration: () => { if (typeof authSessionGeneration !== 'undefined') authSessionGeneration++; },
            checkAuth: () => (typeof checkAuth === 'function' ? checkAuth() : null),
            storage: typeof localStorage !== 'undefined' ? localStorage : null
        }, options);

        if (typeof deps.incrementAuthSessionGeneration === 'function') {
            deps.incrementAuthSessionGeneration();
        }
        if (typeof deps.detachSnapshotListeners === 'function') {
            deps.detachSnapshotListeners();
        }
        if (typeof deps.clearCollections === 'function') {
            deps.clearCollections();
        }

        const CrmAuth = typeof deps.getCrmAuth === 'function' ? deps.getCrmAuth() : (deps.getCrmAuth || null);
        const fb = typeof deps.getFirebase === 'function' ? deps.getFirebase() : (deps.getFirebase || null);
        if (CrmAuth && typeof CrmAuth.signOut === 'function') {
            CrmAuth.signOut(fb);
        }

        deps.setCurrentUser(null);
        deps.setInitialRoleViewRouted(false);
        if (deps.storage) {
            deps.storage.removeItem('ductsal_current_user');
        }
        if (typeof deps.checkAuth === 'function') {
            deps.checkAuth();
        }
    }

    return {
        getPendingSetupUser,
        setPendingSetupUser,
        checkAuth,
        processLogin,
        processDirectFirebaseAuthLogin,
        processFirebaseLogin,
        processLogout
    };
});
