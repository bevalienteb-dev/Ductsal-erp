// ============================================================================
// DUCTSAL ERP — CENTRAL APPLICATION ROUTER (Fase 6.7 - Etapa C)
// Archivo: core/app_router.js
// Responsabilidades:
// 1. Gestión centralizada de navegación entre vistas (showView).
// 2. Control estricto de acceso a vistas según matriz de roles de Fase 6.6.
// 3. Enrutamiento inicial según rol de usuario (routeInitialView).
// 4. Sincronización de enlaces de navegación activos (.nav-links li.active).
// 5. Sincronización de barras de encabezado móviles e interfaz responsive.
// 6. Preservación y restauración de scroll al navegar hacia/desde el detalle.
// 7. Compatibilidad con el estado central (AppState) y la fachada global (window).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.AppRouter = api;
        if (typeof window !== 'undefined') {
            window.AppRouter = api;
            // Exponer showView, saveListScrollPosition, restoreListScrollPosition en window para compatibilidad
            window.showView = function (viewId) { return api.showView(viewId); };
            window.saveListScrollPosition = function () { return api.saveListScrollPosition(); };
            window.restoreListScrollPosition = function () { return api.restoreListScrollPosition(); };
        }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado Interno del Router
    // -------------------------------------------------------------------------
    let _lastListScrollY = 0;

    // -------------------------------------------------------------------------
    // 2. Inyección de Dependencias con Fallbacks Seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getCurrentUser: () => {
            if (typeof AppState !== 'undefined' && AppState.session) return AppState.session.getCurrentUser();
            if (typeof currentUser !== 'undefined') return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getCurrentView: () => {
            if (typeof AppState !== 'undefined' && AppState.navigation) return AppState.navigation.getCurrentView();
            return 'list-view';
        },
        setCurrentView: (v) => {
            if (typeof AppState !== 'undefined' && AppState.navigation) return AppState.navigation.setCurrentView(v);
        },
        getLastViewedSection: () => {
            if (typeof AppState !== 'undefined' && AppState.navigation) return AppState.navigation.getLastViewedSection();
            if (typeof lastViewedSection !== 'undefined') return lastViewedSection;
            if (typeof window !== 'undefined' && window.lastViewedSection) return window.lastViewedSection;
            return 'list-view';
        },
        setLastViewedSection: (v) => {
            if (typeof AppState !== 'undefined' && AppState.navigation) AppState.navigation.setLastViewedSection(v);
            if (typeof lastViewedSection !== 'undefined') lastViewedSection = v;
            if (typeof window !== 'undefined') window.lastViewedSection = v;
        },
        getCurrentListMode: () => {
            if (typeof AppState !== 'undefined' && AppState.navigation) return AppState.navigation.getCurrentListMode();
            if (typeof currentListMode !== 'undefined') return currentListMode;
            if (typeof window !== 'undefined' && window.currentListMode) return window.currentListMode;
            return 'agenda';
        },
        setCurrentListMode: (m) => {
            if (typeof AppState !== 'undefined' && AppState.navigation) AppState.navigation.setCurrentListMode(m);
            if (typeof currentListMode !== 'undefined') currentListMode = m;
            if (typeof window !== 'undefined') window.currentListMode = m;
        },
        isInitialRoleViewRouted: () => {
            if (typeof AppState !== 'undefined' && AppState.lifecycle) return AppState.lifecycle.isInitialRoleViewRouted();
            if (typeof initialRoleViewRouted !== 'undefined') return initialRoleViewRouted;
            if (typeof window !== 'undefined' && window.initialRoleViewRouted) return window.initialRoleViewRouted;
            return false;
        },
        setInitialRoleViewRouted: (val) => {
            if (typeof AppState !== 'undefined' && AppState.lifecycle) AppState.lifecycle.setInitialRoleViewRouted(val);
            if (typeof initialRoleViewRouted !== 'undefined') initialRoleViewRouted = val;
            if (typeof window !== 'undefined') window.initialRoleViewRouted = val;
        },
        getUsersPermissions: () => {
            if (typeof UsersPermissions !== 'undefined') return UsersPermissions;
            if (typeof window !== 'undefined' && window.UsersPermissions) return window.UsersPermissions;
            return null;
        },
        switchListMode: (mode) => {
            if (typeof switchListMode === 'function') return switchListMode(mode);
            if (typeof window !== 'undefined' && typeof window.switchListMode === 'function') return window.switchListMode(mode);
        },
        renderList: () => {
            if (typeof renderList === 'function') return renderList();
            if (typeof window !== 'undefined' && typeof window.renderList === 'function') return window.renderList();
        },
        renderDailyAgenda: () => {
            if (typeof renderDailyAgenda === 'function') return renderDailyAgenda();
            if (typeof window !== 'undefined' && typeof window.renderDailyAgenda === 'function') return window.renderDailyAgenda();
        },
        renderClientsTable: () => {
            if (typeof renderClientsTable === 'function') return renderClientsTable();
            if (typeof window !== 'undefined' && typeof window.renderClientsTable === 'function') return window.renderClientsTable();
        },
        renderDashboard: () => {
            if (typeof renderDashboard === 'function') return renderDashboard();
            if (typeof window !== 'undefined' && typeof window.renderDashboard === 'function') return window.renderDashboard();
        },
        renderProjectsList: () => {
            if (typeof renderProjectsList === 'function') return renderProjectsList();
            if (typeof window !== 'undefined' && typeof window.renderProjectsList === 'function') return window.renderProjectsList();
        },
        renderUsersTable: () => {
            if (typeof renderUsersTable === 'function') return renderUsersTable();
            if (typeof window !== 'undefined' && typeof window.renderUsersTable === 'function') return window.renderUsersTable();
        },
        fetchAdminUsers: () => {
            if (typeof fetchAdminUsers === 'function') return fetchAdminUsers();
            if (typeof window !== 'undefined' && typeof window.fetchAdminUsers === 'function') return window.fetchAdminUsers();
        },
        alert: (msg) => {
            if (typeof alert === 'function') return alert(msg);
            console.warn('[AppRouter Alert]', msg);
        },
        doc: typeof document !== 'undefined' ? document : null,
        win: typeof window !== 'undefined' ? window : null
    };

    function getDoc() {
        return typeof _deps.doc === 'function' ? _deps.doc() : _deps.doc;
    }

    function getWin() {
        return typeof _deps.win === 'function' ? _deps.win() : _deps.win;
    }

    function getUser() {
        return typeof _deps.getCurrentUser === 'function' ? _deps.getCurrentUser() : _deps.getCurrentUser;
    }

    const api = {
        init,
        showView,
        routeInitialView,
        syncMobileHeader,
        saveListScrollPosition,
        restoreListScrollPosition,
        canUserAccessView,
        resetRouterState,
        getCurrentView: () => _deps.getCurrentView(),
        getLastViewedSection: () => _deps.getLastViewedSection(),
        getLastListScrollY: () => _lastListScrollY
    };

    function init(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const key of Object.keys(customDeps)) {
                _deps[key] = customDeps[key];
            }
        }
        return api;
    }

    // -------------------------------------------------------------------------
    // 3. Control de Acceso por Vista (Principio de Mínimo Privilegio)
    // -------------------------------------------------------------------------
    function canUserAccessView(arg1, arg2) {
        let user, viewId;
        if (typeof arg1 === 'string') {
            viewId = arg1;
            user = arg2;
        } else {
            user = arg1;
            viewId = arg2;
        }
        if (!user) user = getUser();
        const perms = _deps.getUsersPermissions();
        if (perms && typeof perms.canAccessView === 'function') {
            return perms.canAccessView(user, viewId);
        }
        if (!user || !user.role) {
            // Vistas públicas mínimas si no hay usuario (o retorno neutro)
            return viewId === 'list-view';
        }
        const role = user.role;
        switch (viewId) {
            case 'dashboard-view':
                return role === 'manager';
            case 'users-view':
                return role === 'manager';
            case 'projects-view':
                return role === 'manager' || role === 'gestor' || role === 'vendedor';
            case 'settings-view':
                return role === 'manager';
            default:
                return true;
        }
    }

    // -------------------------------------------------------------------------
    // 4. Navegación Principal: showView
    // -------------------------------------------------------------------------
    function showView(viewId, options = {}) {
        const user = options.user || getUser();
        const doc = getDoc();

        // 1. Verificación de Seguridad y Autorización
        if (viewId === 'dashboard-view' && (!user || user.role !== 'manager')) {
            _deps.alert('Acceso denegado: este módulo es exclusivo para la Gerencia General.');
            return showView('list-view', { user });
        }

        if (viewId === 'users-view' && (!user || user.role !== 'manager')) {
            _deps.alert('Acceso denegado: este módulo es exclusivo para la Gerencia General.');
            return showView('list-view', { user });
        }

        if (!canUserAccessView(user, viewId)) {
            _deps.alert('Acceso no autorizado a este módulo.');
            if (viewId !== 'list-view') {
                return showView('list-view', { user });
            }
            return null;
        }

        // 2. Registro del Historial de Navegación
        const previousSection = _deps.getLastViewedSection();
        if (viewId !== 'detail-view' && !viewId.includes('opportunity-contact') && !viewId.includes('opportunity-account')) {
            _deps.setLastViewedSection(viewId);
        }
        if (typeof _deps.setCurrentView === 'function') {
            _deps.setCurrentView(viewId);
        }

        // 3. Manipulación del DOM si está disponible
        if (doc) {
            // Desactivar todas las secciones de vista
            const sections = doc.querySelectorAll('.view-section');
            if (sections && typeof sections.forEach === 'function') {
                sections.forEach(el => {
                    if (el && el.classList) el.classList.remove('active');
                });
            }

            // Activar la vista solicitada
            const target = doc.getElementById(viewId);
            if (target && target.classList) {
                target.classList.add('active');
            }

            // Desmarcar todos los enlaces de navegación del menú
            const navLinks = doc.querySelectorAll('.nav-links li');
            if (navLinks && typeof navLinks.forEach === 'function') {
                navLinks.forEach(el => {
                    if (el && el.classList) el.classList.remove('active');
                });
            }

            // Sincronizar encabezado móvil
            syncMobileHeader(viewId);
        }

        // 4. Activación de Enlaces de Menú y Despacho a Controladores
        if (viewId === 'list-view') {
            if (doc) {
                const navList = doc.getElementById('nav-list');
                if (navList && navList.classList) navList.classList.add('active');
            }
            const isManager = user && user.role === 'manager';
            if (isManager && previousSection !== 'list-view' && previousSection !== 'detail-view') {
                _deps.setCurrentListMode('pipeline');
            } else if (!_deps.getCurrentListMode()) {
                _deps.setCurrentListMode(isManager ? 'pipeline' : 'agenda');
            }
            if (typeof _deps.switchListMode === 'function') {
                _deps.switchListMode(_deps.getCurrentListMode());
            } else {
                _deps.renderList();
            }
        } else if (viewId === 'clients-view') {
            if (doc) {
                const navClients = doc.getElementById('nav-clients');
                if (navClients && navClients.classList) navClients.classList.add('active');
            }
            _deps.renderClientsTable();
        } else if (viewId === 'dashboard-view') {
            if (doc) {
                const navDashboard = doc.getElementById('nav-dashboard');
                if (navDashboard && navDashboard.classList) navDashboard.classList.add('active');
            }
            _deps.renderDashboard();
        } else if (viewId === 'projects-view') {
            if (doc) {
                const navProjects = doc.getElementById('nav-projects');
                if (navProjects && navProjects.classList) navProjects.classList.add('active');
            }
            _deps.renderProjectsList();
        } else if (viewId === 'users-view') {
            if (doc) {
                const navUsers = doc.getElementById('nav-users');
                if (navUsers && navUsers.classList) navUsers.classList.add('active');
            }
            _deps.fetchAdminUsers();
            _deps.renderUsersTable();
        } else if (viewId === 'settings-view') {
            if (doc) {
                const navSettings = doc.getElementById('nav-settings');
                if (navSettings && navSettings.classList) navSettings.classList.add('active');
            }
        }

        return viewId;
    }

    // -------------------------------------------------------------------------
    // 5. Enrutamiento Inicial según Rol (routeInitialView)
    // -------------------------------------------------------------------------
    function routeInitialView(user) {
        if (typeof _deps.isInitialRoleViewRouted === 'function' && _deps.isInitialRoleViewRouted()) return;
        const u = user || _deps.getCurrentUser();
        if (!u || !u.role) return;

        _deps.setInitialRoleViewRouted(true);
        const role = u.role;

        if (role === 'manager') {
            _deps.setCurrentListMode('pipeline');
            showView('dashboard-view', { user: u });
        } else if (role === 'gestor' || role === 'vendedor') {
            _deps.setCurrentListMode('agenda');
            showView('list-view', { user: u });
            if (typeof _deps.switchListMode === 'function') _deps.switchListMode('agenda');
        } else {
            _deps.setCurrentListMode('agenda');
            showView('list-view', { user: u });
            if (typeof _deps.switchListMode === 'function') _deps.switchListMode('agenda');
        }
    }

    // -------------------------------------------------------------------------
    // 6. Sincronización de Encabezado Móvil (Responsive Header)
    // -------------------------------------------------------------------------
    function syncMobileHeader(viewId) {
        const doc = getDoc();
        if (!doc) return;
        const mobileHeaderDefault = doc.getElementById('mobile-header-default');
        const mobileHeaderDetail = doc.getElementById('detail-mobile-sticky-bar');
        if (mobileHeaderDefault && mobileHeaderDetail) {
            if (viewId === 'detail-view') {
                mobileHeaderDefault.style.display = 'none';
                mobileHeaderDetail.style.display = 'flex';
            } else {
                mobileHeaderDefault.style.display = 'flex';
                mobileHeaderDetail.style.display = 'none';
            }
        }
    }

    // -------------------------------------------------------------------------
    // 7. Gestión de Scroll para Retorno Suave desde Detalle
    // -------------------------------------------------------------------------
    function saveListScrollPosition() {
        const win = getWin();
        const doc = getDoc();
        if (win) {
            _lastListScrollY = win.scrollY || win.pageYOffset || (doc && doc.documentElement && doc.documentElement.scrollTop) || 0;
        }
        return _lastListScrollY;
    }

    function restoreListScrollPosition() {
        const win = getWin();
        if (win && typeof win.scrollTo === 'function') {
            setTimeout(() => {
                try {
                    win.scrollTo({ top: _lastListScrollY, behavior: 'instant' });
                } catch (_) {
                    win.scrollTo(0, _lastListScrollY);
                }
            }, 10);
        }
        return _lastListScrollY;
    }

    // -------------------------------------------------------------------------
    // 8. Reseteo del Router (para Logout o cambio de sesión)
    // -------------------------------------------------------------------------
    function resetRouterState() {
        _lastListScrollY = 0;
        _deps.setInitialRoleViewRouted(false);
        _deps.setLastViewedSection('list-view');
        _deps.setCurrentView('list-view');
    }

    return api;
});
