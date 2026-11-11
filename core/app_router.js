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
            // Exponer showView, saveListScrollPosition, restoreListScrollPosition, scrollDetailViewToTop en window para compatibilidad
            window.showView = function (viewId, options) { return api.showView(viewId, options); };
            window.saveListScrollPosition = function (opts) { return api.saveListScrollPosition(opts); };
            window.restoreListScrollPosition = function (opts) { return api.restoreListScrollPosition(opts); };
            window.scrollDetailViewToTop = function (viewId, opts) { return api.scrollDetailViewToTop(viewId, opts); };
        }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado Interno del Router
    // -------------------------------------------------------------------------
    let _lastListScrollY = 0;
    let _lastMainContentScrollTop = 0;
    let _navigationContext = null;
    let _popstateBoundWin = null;
    let _isHandlingPopstate = false;
    let _pendingRestoreTimeoutId = null;
    let _pendingDetailResetTimeoutId = null;

    function _getAppState() {
        if (typeof _deps !== 'undefined' && typeof _deps.getAppState === 'function') {
            const st = _deps.getAppState();
            if (st) return st;
        }
        if (typeof AppState !== 'undefined' && AppState) return AppState;
        if (typeof window !== 'undefined' && window.AppState) return window.AppState;
        return null;
    }

    function _normalizeViewId(v) {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object' && typeof v.current === 'string') return v.current;
        return '';
    }

    function _isSubViewId(viewId) {
        const v = _normalizeViewId(viewId);
        if (!v) return false;
        return (
            v === 'detail-view' ||
            v === 'client-detail-view' ||
            v.startsWith('b3-') ||
            v.includes('opportunity-contact') ||
            v.includes('opportunity-account') ||
            v === 'account-contacts-view' ||
            v === 'create-person-view' ||
            v === 'edit-person-view' ||
            v === 'link-contact-account-view' ||
            v === 'edit-account-contact-view' ||
            v === 'deactivate-account-contact-view' ||
            v === 'reactivate-account-contact-view' ||
            v === 'contact-periods-view'
        );
    }

    // -------------------------------------------------------------------------
    // 2. Inyección de Dependencias con Fallbacks Seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getCurrentUser: () => {
            const st = _getAppState();
            if (st && st.session) return st.session.getCurrentUser();
            if (typeof currentUser !== 'undefined') return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getCurrentView: () => {
            const st = _getAppState();
            if (st && st.navigation) return _normalizeViewId(st.navigation.getCurrentView());
            return 'list-view';
        },
        setCurrentView: (v) => {
            const st = _getAppState();
            if (st && st.navigation) return st.navigation.setCurrentView(_normalizeViewId(v));
        },
        getLastViewedSection: () => {
            const st = _getAppState();
            if (st && st.navigation) {
                const s = _normalizeViewId(st.navigation.getLastViewedSection());
                if (s && !_isSubViewId(s)) return s;
            }
            if (typeof lastViewedSection !== 'undefined') {
                const s = _normalizeViewId(lastViewedSection);
                if (s && !_isSubViewId(s)) return s;
            }
            if (typeof window !== 'undefined' && window.lastViewedSection) {
                const s = _normalizeViewId(window.lastViewedSection);
                if (s && !_isSubViewId(s)) return s;
            }
            return 'list-view';
        },
        setLastViewedSection: (v) => {
            const safeV = _normalizeViewId(v);
            if (!safeV || _isSubViewId(safeV)) return;
            const st = _getAppState();
            if (st && st.navigation) st.navigation.setLastViewedSection(safeV);
            if (typeof lastViewedSection !== 'undefined') lastViewedSection = safeV;
            if (typeof window !== 'undefined') window.lastViewedSection = safeV;
        },
        getCurrentListMode: () => {
            const st = _getAppState();
            if (st && st.navigation) return st.navigation.getCurrentListMode();
            if (typeof currentListMode !== 'undefined') return currentListMode;
            if (typeof window !== 'undefined' && window.currentListMode) return window.currentListMode;
            return 'agenda';
        },
        setCurrentListMode: (m) => {
            const st = _getAppState();
            if (st && st.navigation) st.navigation.setCurrentListMode(m);
            if (typeof currentListMode !== 'undefined') currentListMode = m;
            if (typeof window !== 'undefined') window.currentListMode = m;
        },
        isInitialRoleViewRouted: () => {
            const st = _getAppState();
            if (st && st.lifecycle) return st.lifecycle.isInitialRoleViewRouted();
            if (typeof initialRoleViewRouted !== 'undefined') return initialRoleViewRouted;
            if (typeof window !== 'undefined' && window.initialRoleViewRouted) return window.initialRoleViewRouted;
            return false;
        },
        setInitialRoleViewRouted: (val) => {
            const st = _getAppState();
            if (st && st.lifecycle) st.lifecycle.setInitialRoleViewRouted(val);
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
        if (typeof _deps.getDocument === 'function') return _deps.getDocument();
        if (typeof _deps.doc === 'function') return _deps.doc();
        if (_deps.doc) return _deps.doc;
        return typeof document !== 'undefined' ? document : null;
    }

    function getWin() {
        if (typeof _deps.getWindow === 'function') return _deps.getWindow();
        if (typeof _deps.win === 'function') return _deps.win();
        if (_deps.win) return _deps.win;
        return typeof window !== 'undefined' ? window : null;
    }

    function getUser() {
        return typeof _deps.getCurrentUser === 'function' ? _deps.getCurrentUser() : _deps.getCurrentUser;
    }

    const api = {
        init,
        initAppRouter: init,
        showView,
        routeInitialView,
        syncMobileHeader,
        saveListScrollPosition,
        restoreListScrollPosition,
        scrollDetailViewToTop,
        canUserAccessView,
        resetRouterState,
        getCurrentView: () => _normalizeViewId(_deps.getCurrentView()) || 'list-view',
        getLastViewedSection: () => _normalizeViewId(_deps.getLastViewedSection()) || 'list-view',
        getLastListScrollY: () => _lastListScrollY,
        getLastMainContentScrollTop: () => _lastMainContentScrollTop,
        getNavigationContext: () => _navigationContext ? { ..._navigationContext } : null
    };

    function _bindPopstateListener() {
        const win = getWin();
        if (!win || typeof win.addEventListener !== 'function' || _popstateBoundWin === win) return;
        _popstateBoundWin = win;
        win.addEventListener('popstate', (event) => {
            if (_isHandlingPopstate) return;
            const currentView = _normalizeViewId(_deps.getCurrentView());
            const state = (event && event.state && typeof event.state === 'object') ? event.state : null;
            _isHandlingPopstate = true;
            try {
                if (currentView === 'detail-view') {
                    if (typeof _deps.goBackFromDetail === 'function') {
                        _deps.goBackFromDetail({ fromPopstate: true });
                    } else if (typeof win.goBackFromDetail === 'function') {
                        win.goBackFromDetail({ fromPopstate: true });
                    } else {
                        const target = (state && state.originView) || (_navigationContext && _navigationContext.originView) || _deps.getLastViewedSection() || 'list-view';
                        showView(target, { fromPopstate: true, preserveListMode: true });
                        restoreListScrollPosition({ fromPopstate: true, targetSection: target });
                    }
                } else if (currentView === 'client-detail-view') {
                    if (typeof _deps.closeClientDetailView === 'function') {
                        _deps.closeClientDetailView({ fromPopstate: true });
                    } else if (typeof win.closeClientDetailView === 'function') {
                        win.closeClientDetailView({ fromPopstate: true });
                    } else if (win.ClientsUI && typeof win.ClientsUI.closeClientDetailView === 'function') {
                        win.ClientsUI.closeClientDetailView({ fromPopstate: true });
                    } else {
                        const target = (state && state.originView) || (_navigationContext && _navigationContext.originView) || 'clients-view';
                        showView(target, { fromPopstate: true, preserveListMode: true });
                        restoreListScrollPosition({ fromPopstate: true, targetSection: target });
                    }
                } else if (state && state.ductsalView && state.ductsalView !== currentView) {
                    showView(state.ductsalView, { fromPopstate: true, preserveListMode: true });
                }
            } finally {
                _isHandlingPopstate = false;
            }
        });
    }

    function init(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const key of Object.keys(customDeps)) {
                _deps[key] = customDeps[key];
            }
        }
        _bindPopstateListener();
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
        viewId = _normalizeViewId(viewId);
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
    function showView(rawViewId, options = {}) {
        const viewId = _normalizeViewId(rawViewId) || 'list-view';
        const user = options.user || getUser();
        const doc = getDoc();
        const win = getWin();

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
        const previousCurrentView = _normalizeViewId(_deps.getCurrentView());
        const previousSection = _normalizeViewId(_deps.getLastViewedSection()) || 'list-view';
        const isSubView = _isSubViewId(viewId);
        const returningFromSubView = _isSubViewId(previousCurrentView) || options.preserveListMode === true;

        if (!isSubView) {
            _deps.setLastViewedSection(viewId);
        }
        if (typeof _deps.setCurrentView === 'function') {
            _deps.setCurrentView(viewId);
        }

        // Sincronizar History API del navegador al entrar en vista de detalle
        if (win && win.history && typeof win.history.pushState === 'function' && !options.fromPopstate) {
            if ((viewId === 'detail-view' || viewId === 'client-detail-view') && previousCurrentView !== viewId) {
                try {
                    win.history.pushState({
                        ductsalView: viewId,
                        originView: (_navigationContext && _navigationContext.originView) || previousSection || 'list-view',
                        recordId: (_navigationContext && _navigationContext.recordId) || null
                    }, '');
                } catch (_) { /* ignore history errors in restricted environments */ }
            }
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
            if (returningFromSubView && _navigationContext && _navigationContext.listMode) {
                _deps.setCurrentListMode(_navigationContext.listMode);
            } else if (isManager && !returningFromSubView && previousSection !== 'list-view' && previousSection !== 'detail-view') {
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
    // 7. Gestión de Scroll y Contexto Completo para Retorno desde Detalle
    // -------------------------------------------------------------------------
    function _getActiveDomViewId(doc) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return '';
        const sections = doc.querySelectorAll('.view-section');
        if (!sections || typeof sections.forEach !== 'function') return '';
        let found = '';
        sections.forEach(el => {
            if (!found && el && el.id && el.classList && typeof el.classList.contains === 'function' && el.classList.contains('active')) {
                if (!_isSubViewId(el.id)) found = el.id;
            }
        });
        return found;
    }

    function _clearPendingScrollTimers() {
        if (_pendingRestoreTimeoutId !== null) {
            clearTimeout(_pendingRestoreTimeoutId);
            _pendingRestoreTimeoutId = null;
        }
        if (_pendingDetailResetTimeoutId !== null) {
            clearTimeout(_pendingDetailResetTimeoutId);
            _pendingDetailResetTimeoutId = null;
        }
    }

    function saveListScrollPosition(opts = {}) {
        const win = getWin();
        const doc = getDoc();
        if (win) {
            _lastListScrollY = win.scrollY || win.pageYOffset || (doc && doc.scrollingElement && doc.scrollingElement.scrollTop) || (doc && doc.documentElement && doc.documentElement.scrollTop) || (doc && doc.body && doc.body.scrollTop) || 0;
        } else {
            _lastListScrollY = 0;
        }

        const mainEl = (doc && typeof doc.querySelector === 'function')
            ? (doc.querySelector('.main-content') || (typeof doc.getElementById === 'function' ? doc.getElementById('main-content-container') : null))
            : null;
        _lastMainContentScrollTop = (mainEl && typeof mainEl.scrollTop === 'number') ? mainEl.scrollTop : 0;

        const activeDomView = _getActiveDomViewId(doc);
        const currentView = _normalizeViewId(_deps.getCurrentView());
        const lastSection = _normalizeViewId(_deps.getLastViewedSection()) || 'list-view';
        const originView = (opts && opts.originView && !_isSubViewId(opts.originView))
            ? opts.originView
            : (activeDomView || (!_isSubViewId(currentView) && currentView ? currentView : lastSection));

        const getInputVal = (id) => {
            if (!doc || typeof doc.getElementById !== 'function') return undefined;
            const el = doc.getElementById(id);
            return (el && typeof el.value === 'string') ? el.value : undefined;
        };

        _navigationContext = {
            originView: originView || 'list-view',
            listMode: _deps.getCurrentListMode() || 'pipeline',
            scrollY: _lastListScrollY,
            mainContentScrollTop: _lastMainContentScrollTop,
            recordId: (opts && opts.recordId) || null,
            recordType: (opts && opts.recordType) || null,
            page: (opts && opts.page !== undefined) ? opts.page : 1,
            filters: {
                oppSearch: getInputVal('opp-search'),
                oppDateStart: getInputVal('opp-date-start'),
                oppDateEnd: getInputVal('opp-date-end'),
                cliSearch: getInputVal('cli-search'),
                projSearch: getInputVal('proj-search'),
                ...(opts && opts.filters ? opts.filters : {})
            },
            sort: (opts && opts.sort) ? { ...opts.sort } : null,
            savedAt: Date.now()
        };

        if (originView && !_isSubViewId(originView)) {
            _deps.setLastViewedSection(originView);
        }

        return _lastListScrollY;
    }

    function _applyDetailScrollTop(targetViewId) {
        const win = getWin();
        const doc = getDoc();
        const currentView = _normalizeViewId(_deps.getCurrentView());
        if (targetViewId && currentView && currentView !== targetViewId && !_isSubViewId(currentView)) {
            return;
        }
        if (win && typeof win.scrollTo === 'function') {
            try {
                win.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            } catch (_) {
                win.scrollTo(0, 0);
            }
        }
        if (doc) {
            if (doc.scrollingElement) {
                doc.scrollingElement.scrollTop = 0;
                if (typeof doc.scrollingElement.scrollLeft === 'number') doc.scrollingElement.scrollLeft = 0;
            }
            if (doc.documentElement) {
                doc.documentElement.scrollTop = 0;
                if (typeof doc.documentElement.scrollLeft === 'number') doc.documentElement.scrollLeft = 0;
            }
            if (doc.body) {
                doc.body.scrollTop = 0;
                if (typeof doc.body.scrollLeft === 'number') doc.body.scrollLeft = 0;
            }
            if (typeof doc.querySelector === 'function') {
                const mainEl = doc.querySelector('.main-content');
                if (mainEl) {
                    mainEl.scrollTop = 0;
                    if (typeof mainEl.scrollLeft === 'number') mainEl.scrollLeft = 0;
                }
                const appEl = doc.querySelector('.app-container');
                if (appEl && typeof appEl.scrollTop === 'number') {
                    appEl.scrollTop = 0;
                }
            }
            if (typeof doc.getElementById === 'function') {
                const viewEl = targetViewId ? doc.getElementById(targetViewId) : null;
                if (viewEl && typeof viewEl.scrollTop === 'number') {
                    viewEl.scrollTop = 0;
                }
                if (!targetViewId || targetViewId === 'detail-view') {
                    const detailEl = doc.getElementById('detail-view');
                    if (detailEl && typeof detailEl.scrollTop === 'number') detailEl.scrollTop = 0;
                    const logsEl = doc.getElementById('logs-container');
                    if (logsEl && typeof logsEl.scrollTop === 'number') logsEl.scrollTop = 0;
                }
                if (!targetViewId || targetViewId === 'client-detail-view') {
                    const cliViewEl = doc.getElementById('client-detail-view');
                    if (cliViewEl && typeof cliViewEl.scrollTop === 'number') cliViewEl.scrollTop = 0;
                    const cliContentEl = doc.getElementById('clientDetailContent') || doc.getElementById('client-detail-content');
                    if (cliContentEl && typeof cliContentEl.scrollTop === 'number') cliContentEl.scrollTop = 0;
                    const cliFormEl = doc.getElementById('clientForm');
                    if (cliFormEl && typeof cliFormEl.scrollTop === 'number') cliFormEl.scrollTop = 0;
                }
            }
        }
    }

    /**
     * Reinicia hacia el borde superior (scrollTop = 0) todos los contenedores de scroll
     * del expediente activo (detail-view o client-detail-view) tras su activación y renderizado,
     * SIN modificar ni sobrescribir _lastListScrollY, _lastMainContentScrollTop ni _navigationContext.
     */
    function scrollDetailViewToTop(rawViewId) {
        const viewId = _normalizeViewId(rawViewId) || _normalizeViewId(_deps.getCurrentView()) || 'detail-view';
        if (_pendingRestoreTimeoutId !== null) {
            clearTimeout(_pendingRestoreTimeoutId);
            _pendingRestoreTimeoutId = null;
        }
        if (_pendingDetailResetTimeoutId !== null) {
            clearTimeout(_pendingDetailResetTimeoutId);
            _pendingDetailResetTimeoutId = null;
        }
        _applyDetailScrollTop(viewId);
        const win = getWin();
        const scheduleReset = () => {
            const cur = _normalizeViewId(_deps.getCurrentView());
            if (cur === viewId) {
                _applyDetailScrollTop(viewId);
            }
        };
        if (win && typeof win.requestAnimationFrame === 'function') {
            win.requestAnimationFrame(scheduleReset);
        }
        _pendingDetailResetTimeoutId = setTimeout(() => {
            _pendingDetailResetTimeoutId = null;
            scheduleReset();
        }, 0);
    }

    function _applyScrollAndRowVisibility(targetY, targetMainTop, recordId, recordType) {
        const win = getWin();
        const doc = getDoc();
        if (win && typeof win.scrollTo === 'function') {
            try {
                win.scrollTo({ top: targetY, behavior: 'instant' });
            } catch (_) {
                win.scrollTo(0, targetY);
            }
        }
        if (doc) {
            if (doc.scrollingElement && typeof targetY === 'number') {
                doc.scrollingElement.scrollTop = targetY;
            }
            if (doc.documentElement && typeof targetY === 'number') {
                doc.documentElement.scrollTop = targetY;
            }
        }
        if (doc && typeof doc.querySelector === 'function') {
            const mainEl = doc.querySelector('.main-content');
            if (mainEl && typeof targetMainTop === 'number') {
                mainEl.scrollTop = targetMainTop;
            }
            if (recordId) {
                const attrName = recordType === 'client' ? 'data-client-id' : 'data-prospect-id';
                const safeId = String(recordId).replace(/"/g, '\\"');
                const row = doc.querySelector(`tr[${attrName}="${safeId}"]`) ||
                            doc.querySelector(`[data-record-id="${safeId}"]`);
                if (row) {
                    if (row.classList && typeof row.classList.add === 'function') {
                        row.classList.add('row-context-restored');
                    }
                    if (typeof row.getBoundingClientRect === 'function' && win && typeof win.innerHeight === 'number' && win.innerHeight > 0) {
                        const rect = row.getBoundingClientRect();
                        const isVisible = rect.top >= 0 && rect.bottom <= win.innerHeight;
                        if (!isVisible && typeof row.scrollIntoView === 'function') {
                            try {
                                row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                            } catch (_) {
                                row.scrollIntoView(false);
                            }
                        }
                    }
                }
            }
        }
    }

    function restoreListScrollPosition(opts = {}) {
        const win = getWin();
        const ctx = _navigationContext || {};
        const targetY = (opts && typeof opts.scrollY === 'number') ? opts.scrollY : (typeof ctx.scrollY === 'number' ? ctx.scrollY : _lastListScrollY);
        const targetMainTop = (opts && typeof opts.mainContentScrollTop === 'number') ? opts.mainContentScrollTop : (typeof ctx.mainContentScrollTop === 'number' ? ctx.mainContentScrollTop : _lastMainContentScrollTop);
        const recordId = (opts && opts.recordId) || ctx.recordId || null;
        const recordType = (opts && opts.recordType) || ctx.recordType || null;

        _clearPendingScrollTimers();

        if (win && typeof win.scrollTo === 'function') {
            _applyScrollAndRowVisibility(targetY, targetMainTop, recordId, recordType);
            const scheduleRestore = () => {
                const cur = _normalizeViewId(_deps.getCurrentView());
                if (cur && _isSubViewId(cur)) return;
                _applyScrollAndRowVisibility(targetY, targetMainTop, recordId, recordType);
            };
            if (typeof win.requestAnimationFrame === 'function') {
                win.requestAnimationFrame(scheduleRestore);
            }
            _pendingRestoreTimeoutId = setTimeout(() => {
                _pendingRestoreTimeoutId = null;
                scheduleRestore();
            }, 15);
        }
        return _lastListScrollY;
    }

    // -------------------------------------------------------------------------
    // 8. Reseteo del Router (para Logout o cambio de sesión)
    // -------------------------------------------------------------------------
    function resetRouterState() {
        _clearPendingScrollTimers();
        _lastListScrollY = 0;
        _lastMainContentScrollTop = 0;
        _navigationContext = null;
        _deps.setInitialRoleViewRouted(false);
        _deps.setLastViewedSection('list-view');
        _deps.setCurrentView('list-view');
    }

    return api;
});
