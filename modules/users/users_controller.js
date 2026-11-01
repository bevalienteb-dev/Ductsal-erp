// modules/users/users_controller.js
// Controlador de administración de usuarios, coordinación de operaciones CRUD e integración backend.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.UsersController = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    let adminUsersLoading = false;
    let userSaveInFlight = false;

    function getAdminUsersLoading() {
        return adminUsersLoading;
    }

    function setAdminUsersLoading(v) {
        adminUsersLoading = !!v;
    }

    function getUserSaveInFlight() {
        return userSaveInFlight;
    }

    function setUserSaveInFlight(v) {
        userSaveInFlight = !!v;
    }

    async function fetchAdminUsers(options = {}) {
        const deps = Object.assign({
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            renderUsersTable: () => (typeof renderUsersTable === 'function' ? renderUsersTable() : null)
        }, options);

        const currentUser = typeof deps.getCurrentUser === 'function' ? deps.getCurrentUser() : (deps.getCurrentUser || null);
        if (!currentUser || currentUser.role !== 'manager') return;
        if (adminUsersLoading) return;

        adminUsersLoading = true;
        try {
            const authModule = typeof deps.getCrmAuth === 'function' ? deps.getCrmAuth() : (deps.getCrmAuth || null);
            const fb = typeof deps.getFirebase === 'function' ? deps.getFirebase() : (deps.getFirebase || null);
            const dbSuffix = typeof deps.getDbSuffix === 'function' ? deps.getDbSuffix() : (deps.getDbSuffix || '_prod');

            if (authModule && typeof authModule.listUsersViaFunction === 'function' && fb) {
                const list = await authModule.listUsersViaFunction(fb, { dbSuffix });
                if (Array.isArray(list)) {
                    const userList = typeof deps.getUsers === 'function' ? deps.getUsers() : (deps.getUsers || []);
                    list.forEach(au => {
                        const idx = userList.findIndex(u => u.id === au.id);
                        if (idx >= 0) {
                            userList[idx] = Object.assign({}, userList[idx], au);
                        } else {
                            userList.push(au);
                        }
                    });
                    if (typeof deps.renderUsersTable === 'function') deps.renderUsersTable();
                }
            }
        } catch (e) {
            console.warn('[CRM] Error al cargar usuarios administrativos:', e && e.message);
        } finally {
            adminUsersLoading = false;
        }
    }

    async function saveUser(options = {}, event = null) {
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
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            getCrmUI: () => (typeof globalThis !== 'undefined' && globalThis.CrmUI ? globalThis.CrmUI : (typeof window !== 'undefined' && window.CrmUI ? window.CrmUI : null)),
            saveUserToDB: (u) => (typeof saveUserToDB === 'function' ? saveUserToDB(u) : null),
            closeModal: (id) => (typeof closeModal === 'function' ? closeModal(id) : null),
            renderUsersTable: () => (typeof renderUsersTable === 'function' ? renderUsersTable() : null),
            fetchAdminUsers: () => (typeof fetchAdminUsers === 'function' ? fetchAdminUsers() : null),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg)),
            doc: typeof document !== 'undefined' ? document : null
        }, deps);

        const doc = resolvedDeps.doc;
        if (!doc) return;

        const idEl = doc.getElementById('user-id-edit');
        const nombreEl = doc.getElementById('usr-nombre');
        const emailEl = doc.getElementById('usr-email');
        const rolEl = doc.getElementById('usr-rol');

        const id = idEl ? idEl.value : '';
        const nombre = nombreEl ? nombreEl.value.trim() : '';
        const email = emailEl ? emailEl.value.trim() : '';
        const role = rolEl ? rolEl.value : 'vendedor';

        const userList = typeof resolvedDeps.getUsers === 'function' ? resolvedDeps.getUsers() : (resolvedDeps.getUsers || []);
        const authModule = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
        const uiModule = typeof resolvedDeps.getCrmUI === 'function' ? resolvedDeps.getCrmUI() : (resolvedDeps.getCrmUI || null);
        const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);
        const dbSuffix = typeof resolvedDeps.getDbSuffix === 'function' ? resolvedDeps.getDbSuffix() : (resolvedDeps.getDbSuffix || '_prod');

        const warn = (msg) => {
            if (uiModule && typeof uiModule.warning === 'function') uiModule.warning(msg);
            else resolvedDeps.notify(msg);
        };
        const error = (msg) => {
            if (uiModule && typeof uiModule.error === 'function') uiModule.error(msg);
            else resolvedDeps.notify(msg);
        };

        if (id) {
            const u = userList.find(x => x.id === id);
            // El correo de un usuario vinculado a Firebase Auth es la identidad de login y no se puede cambiar aquí
            if (u && u.authUid && u.email !== email) {
                warn("El correo de un usuario con cuenta de Firebase Authentication no se puede cambiar desde aquí.");
                return;
            }

            // Perfiles con Auth: nombre y ROL se actualizan exclusivamente a través de updateUserAdmin
            if (u && u.authUid) {
                if (!authModule) {
                    error("No se pudo cargar el módulo de autenticación. No se guardó ningún cambio. Recarga la página.");
                    return;
                }
                if (role !== u.role && Array.isArray(authModule.CREATABLE_ROLES) && !authModule.CREATABLE_ROLES.includes(role)) {
                    warn("Solo se puede asignar el rol de vendedor o gestor desde aquí. Las cuentas de gerente las configura el propietario del sistema. No se guardó ningún cambio.");
                    return;
                }
                const change = { id: u.id, dbSuffix };
                if (nombre !== u.nombre) change.nombre = nombre;
                if (role !== u.role) change.role = role;
                if (change.nombre === undefined && change.role === undefined) {
                    if (typeof resolvedDeps.closeModal === 'function') resolvedDeps.closeModal('userModal');
                    return;
                }
                if (userSaveInFlight) return;
                userSaveInFlight = true;
                try {
                    const { outcome, result } = await authModule.adminUpdateUser(fb, change, resolvedDeps.notify);
                    if (outcome !== 'updated') return;
                    if (result && result.nombre !== undefined) u.nombre = result.nombre;
                    if (result && result.role !== undefined) u.role = result.role;
                    if (result && result.sessionsRevoked === false && change.role !== undefined) {
                        warn("El rol se cambió, pero no se pudieron cerrar las sesiones abiertas del usuario: aplicará cuando renueve su sesión.");
                    }
                } finally {
                    userSaveInFlight = false;
                }
                if (typeof resolvedDeps.closeModal === 'function') resolvedDeps.closeModal('userModal');
                if (typeof resolvedDeps.renderUsersTable === 'function') resolvedDeps.renderUsersTable();
                if (typeof resolvedDeps.fetchAdminUsers === 'function') resolvedDeps.fetchAdminUsers();
                return;
            }

            // Usuarios históricos (sin cuenta Auth): conservan edición legacy
            if (u) {
                u.nombre = nombre;
                u.email = email;
                u.role = role;
                if (typeof resolvedDeps.saveUserToDB === 'function') resolvedDeps.saveUserToDB(u);
            }
        } else {
            // Alta de usuario nuevo
            if (userList.some(x => String(x.email || '').trim().toLowerCase() === email.toLowerCase())) {
                warn("El correo ya está en uso.");
                return;
            }
            if (!authModule) {
                error("No se pudo cargar el módulo de autenticación. No se creó el usuario. Recarga la página.");
                return;
            }
            if (userSaveInFlight) return;
            userSaveInFlight = true;
            try {
                const outcome = await authModule.adminCreateUser(fb, { nombre, email, role, dbSuffix }, resolvedDeps.notify);
                if (outcome !== 'created') return;
            } finally {
                userSaveInFlight = false;
            }
        }

        if (typeof resolvedDeps.closeModal === 'function') resolvedDeps.closeModal('userModal');
        if (typeof resolvedDeps.renderUsersTable === 'function') resolvedDeps.renderUsersTable();
        if (typeof resolvedDeps.fetchAdminUsers === 'function') resolvedDeps.fetchAdminUsers();
    }

    async function toggleUserStatus(options = {}, id = null) {
        let deps = options;
        let userId = id;
        if (typeof options === 'string') {
            userId = options;
            deps = {};
        }

        const resolvedDeps = Object.assign({
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            getCrmUI: () => (typeof globalThis !== 'undefined' && globalThis.CrmUI ? globalThis.CrmUI : (typeof window !== 'undefined' && window.CrmUI ? window.CrmUI : null)),
            saveUserToDB: (u) => (typeof saveUserToDB === 'function' ? saveUserToDB(u) : null),
            renderUsersTable: () => (typeof renderUsersTable === 'function' ? renderUsersTable() : null),
            fetchAdminUsers: () => (typeof fetchAdminUsers === 'function' ? fetchAdminUsers() : null),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg))
        }, deps);

        const userList = typeof resolvedDeps.getUsers === 'function' ? resolvedDeps.getUsers() : (resolvedDeps.getUsers || []);
        const currentUser = typeof resolvedDeps.getCurrentUser === 'function' ? resolvedDeps.getCurrentUser() : (resolvedDeps.getCurrentUser || null);
        const u = userList.find(x => x.id === userId);
        if (!u) return;

        const uiModule = typeof resolvedDeps.getCrmUI === 'function' ? resolvedDeps.getCrmUI() : (resolvedDeps.getCrmUI || null);
        const warn = (msg) => {
            if (uiModule && typeof uiModule.warning === 'function') uiModule.warning(msg);
            else resolvedDeps.notify(msg);
        };
        const error = (msg) => {
            if (uiModule && typeof uiModule.error === 'function') uiModule.error(msg);
            else resolvedDeps.notify(msg);
        };
        const success = (msg) => {
            if (uiModule && typeof uiModule.success === 'function') uiModule.success(msg);
            else resolvedDeps.notify(msg);
        };

        if (currentUser && u.id === currentUser.id) {
            warn("No puedes desactivarte a ti mismo.");
            return;
        }

        // Usuarios vinculados a Auth: cambio exclusivo mediante toggleUserStatusAdmin
        if (u.authUid) {
            const authModule = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
            if (!authModule) {
                error("No se pudo cargar el módulo de autenticación. No se cambió el estado. Recarga la página.");
                return;
            }
            const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);
            const dbSuffix = typeof resolvedDeps.getDbSuffix === 'function' ? resolvedDeps.getDbSuffix() : (resolvedDeps.getDbSuffix || '_prod');
            const outcome = await authModule.adminSetUserActive(fb, { id: u.id, activo: !u.activo, dbSuffix }, resolvedDeps.notify);
            if (outcome === 'updated') {
                u.activo = !u.activo;
                if (typeof resolvedDeps.renderUsersTable === 'function') resolvedDeps.renderUsersTable();
                if (typeof resolvedDeps.fetchAdminUsers === 'function') resolvedDeps.fetchAdminUsers();
                success(u.activo ? 'Usuario activado exitosamente.' : 'Usuario desactivado exitosamente.');
            }
            return;
        }

        // Histórico
        u.activo = !u.activo;
        if (typeof resolvedDeps.saveUserToDB === 'function') resolvedDeps.saveUserToDB(u);
        if (typeof resolvedDeps.renderUsersTable === 'function') resolvedDeps.renderUsersTable();
        success(u.activo ? 'Usuario activado exitosamente.' : 'Usuario desactivado exitosamente.');
    }

    async function resetUserPassword(options = {}, id = null) {
        let deps = options;
        let userId = id;
        if (typeof options === 'string') {
            userId = options;
            deps = {};
        }

        const resolvedDeps = Object.assign({
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
            getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
            getCrmAuth: () => (typeof globalThis !== 'undefined' && globalThis.CrmAuth ? globalThis.CrmAuth : (typeof window !== 'undefined' && window.CrmAuth ? window.CrmAuth : null)),
            getCrmUI: () => (typeof globalThis !== 'undefined' && globalThis.CrmUI ? globalThis.CrmUI : (typeof window !== 'undefined' && window.CrmUI ? window.CrmUI : null)),
            notify: (msg) => (typeof alert === 'function' ? alert(msg) : console.log(msg))
        }, deps);

        const userList = typeof resolvedDeps.getUsers === 'function' ? resolvedDeps.getUsers() : (resolvedDeps.getUsers || []);
        const target = userList.find(x => x.id === userId);
        if (!target) return;

        const uiModule = typeof resolvedDeps.getCrmUI === 'function' ? resolvedDeps.getCrmUI() : (resolvedDeps.getCrmUI || null);
        const error = (msg) => {
            if (uiModule && typeof uiModule.error === 'function') uiModule.error(msg);
            else resolvedDeps.notify(msg);
        };
        const info = (msg) => {
            if (uiModule && typeof uiModule.info === 'function') uiModule.info(msg);
            else resolvedDeps.notify(msg);
        };
        const success = (msg) => {
            if (uiModule && typeof uiModule.success === 'function') uiModule.success(msg);
            else resolvedDeps.notify(msg);
        };

        if (target.authUid) {
            let confirmed = false;
            if (uiModule && typeof uiModule.confirm === 'function') {
                confirmed = await uiModule.confirm({
                    title: "Restablecer Contraseña",
                    message: `¿Enviar a ${target.nombre || target.email} un correo para restablecer su contraseña?`,
                    confirmText: "Enviar correo",
                    cancelText: "Cancelar",
                    type: "info"
                });
            } else if (typeof confirm === 'function') {
                confirmed = confirm("¿Enviar a este usuario un correo para restablecer su contraseña?");
            }
            if (!confirmed) return;

            const authModule = typeof resolvedDeps.getCrmAuth === 'function' ? resolvedDeps.getCrmAuth() : (resolvedDeps.getCrmAuth || null);
            if (!authModule) {
                error("No se pudo cargar el módulo de autenticación. Recarga la página.");
                return;
            }
            try {
                const fb = typeof resolvedDeps.getFirebase === 'function' ? resolvedDeps.getFirebase() : (resolvedDeps.getFirebase || null);
                const dbSuffix = typeof resolvedDeps.getDbSuffix === 'function' ? resolvedDeps.getDbSuffix() : (resolvedDeps.getDbSuffix || '_prod');

                let targetEmail = target.email;
                if (typeof authModule.resendInvitationViaFunction === 'function') {
                    const res = await authModule.resendInvitationViaFunction(fb, { id: target.id, dbSuffix });
                    if (res && res.delivery === 'client') {
                        targetEmail = res.email || target.email;
                    } else if (res && res.sent === true) {
                        success("Invitación enviada por el servidor.");
                        return;
                    }
                }

                await authModule.sendPasswordSetupEmail(fb, targetEmail);
                success("Correo de restablecimiento enviado.");
            } catch (err) {
                const code = authModule && typeof authModule.normalizeCode === 'function' ? authModule.normalizeCode(err) : (err && err.code);
                let msg = "No se pudo enviar el correo de restablecimiento.";
                if (code === 'unauthenticated') msg = "Tu sesión de Firebase no es válida. Inicia sesión de nuevo.";
                else if (code === 'permission-denied') msg = "No tienes permiso para restablecer la contraseña de este usuario.";
                else if (code === 'failed-precondition') msg = (err && err.message) || "La cuenta se encuentra inactiva o no vinculada.";
                else if (code === 'not-found') msg = "El usuario o su cuenta de acceso no existe.";
                else if (code === 'too-many-requests') msg = "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
                else if (err && err.message) msg = err.message;
                error(msg);
            }
            return;
        }

        info("Este usuario no está vinculado a Firebase Authentication. Debe ser vinculado previamente por un administrador.");
    }

    return {
        getAdminUsersLoading,
        setAdminUsersLoading,
        getUserSaveInFlight,
        setUserSaveInFlight,
        fetchAdminUsers,
        saveUser,
        toggleUserStatus,
        resetUserPassword
    };
});
