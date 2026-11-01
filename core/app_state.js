// ============================================================================
// DUCTSAL ERP — CENTRAL APPLICATION STATE (Fase 6.7 - Etapa B)
// Archivo: core/app_state.js
// Responsabilidades:
// 1. Fuente única de verdad para todo el estado compartido de la aplicación.
// 2. Organización modular en dominios: session, collections, selection,
//    navigation, filters y lifecycle.
// 3. Puente de sincronización reactivo y bidireccional con variables globales (window).
// 4. Sistema desacoplado de eventos y observadores (subscribe / notify).
// 5. Compatibilidad UMD estricta (Node.js / CommonJS y Navegador clásico).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.AppState = api;
        if (typeof window !== 'undefined') {
            window.AppState = api;
            // Sincronizar automáticamente con window al cargar en navegador
            api.syncWithScope(window);
        }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado Interno Estructurado por Dominios
    // -------------------------------------------------------------------------

    // A. Dominio de Sesión y Autenticación
    const _session = {
        currentUser: null,
        pendingSetupUser: null,
        generation: 0
    };

    // B. Dominio de Colecciones Principales (Firestore)
    const _collections = {
        clients: [],
        prospects: [],
        users: [],
        settings: { visitantes: [], encargados: [], gmaps_api_key: '', factory_address: '' }
    };

    // C. Dominio de Selección Activa
    const _selection = {
        currentProspectId: null
    };

    // D. Dominio de Navegación
    const _navigation = {
        currentView: 'list-view',
        lastViewedSection: 'list-view',
        currentListMode: 'agenda' // 'agenda' | 'pipeline'
    };

    // E. Dominio de Filtros y Ordenamiento
    const _filters = {
        opportunities: {
            sortCol: '',
            sortDir: 'asc',
            status: 'activas',
            clasif: 'todas',
            stage: 'todas'
        },
        agenda: {
            filter: 'todas'
        }
    };

    // F. Dominio de Ciclo de Vida y Listeners
    const _lifecycle = {
        loadedCollections: 0,
        initialLoadCompleted: false,
        initialRoleViewRouted: false,
        activeUnsubscribers: [],
        currentSubscribedUser: null,
        crmLoadError: null
    };

    // -------------------------------------------------------------------------
    // 2. Bus de Suscriptores / Observadores
    // -------------------------------------------------------------------------
    const _listeners = new Map();

    function subscribe(topic, callback) {
        if (typeof callback !== 'function') return () => {};
        if (!_listeners.has(topic)) {
            _listeners.set(topic, new Set());
        }
        _listeners.get(topic).add(callback);
        return () => {
            const set = _listeners.get(topic);
            if (set) set.delete(callback);
        };
    }

    function notify(topic, payload) {
        const set = _listeners.get(topic);
        if (set) {
            set.forEach(cb => {
                try {
                    cb(payload);
                } catch (e) {
                    console.error(`[AppState] Error en listener de '${topic}':`, e);
                }
            });
        }
    }

    // Inicializar currentUser desde localStorage si está disponible
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem('ductsal_current_user');
            if (raw) _session.currentUser = JSON.parse(raw);
        }
    } catch (_) {}

    // -------------------------------------------------------------------------
    // 3. API por Dominio
    // -------------------------------------------------------------------------

    // === Dominio: Session ===
    const session = {
        getCurrentUser() {
            return _session.currentUser;
        },
        setCurrentUser(user, options = {}) {
            _session.currentUser = user || null;
            if (options.persist !== false && typeof localStorage !== 'undefined') {
                try {
                    if (user) localStorage.setItem('ductsal_current_user', JSON.stringify(user));
                    else localStorage.removeItem('ductsal_current_user');
                } catch (_) {}
            }
            notify('session:user', _session.currentUser);
            notify('session:change', { type: 'user', value: _session.currentUser });
            return _session.currentUser;
        },
        getPendingSetupUser() {
            return _session.pendingSetupUser;
        },
        setPendingSetupUser(u) {
            _session.pendingSetupUser = u || null;
            notify('session:change', { type: 'pendingSetupUser', value: _session.pendingSetupUser });
        },
        getGeneration() {
            return _session.generation;
        },
        setGeneration(g) {
            _session.generation = Number(g) || 0;
            return _session.generation;
        },
        nextGeneration() {
            _session.generation += 1;
            notify('session:generation', _session.generation);
            return _session.generation;
        },
        resetSession() {
            _session.currentUser = null;
            _session.pendingSetupUser = null;
            this.nextGeneration();
            if (typeof localStorage !== 'undefined') {
                try {
                    localStorage.removeItem('ductsal_current_user');
                } catch (_) {}
            }
            notify('session:reset', null);
            notify('session:change', { type: 'reset' });
        }
    };

    // === Dominio: Collections ===
    const collections = {
        getClients() {
            return _collections.clients;
        },
        setClients(list) {
            _collections.clients = Array.isArray(list) ? list : [];
            notify('collections:clients', _collections.clients);
            notify('collections:change', { collection: 'clients', data: _collections.clients });
            return _collections.clients;
        },
        getProspects() {
            return _collections.prospects;
        },
        setProspects(list) {
            _collections.prospects = Array.isArray(list) ? list : [];
            notify('collections:prospects', _collections.prospects);
            notify('collections:change', { collection: 'prospects', data: _collections.prospects });
            return _collections.prospects;
        },
        getUsers() {
            return _collections.users;
        },
        setUsers(list) {
            _collections.users = Array.isArray(list) ? list : [];
            notify('collections:users', _collections.users);
            notify('collections:change', { collection: 'users', data: _collections.users });
            return _collections.users;
        },
        getSettings() {
            return _collections.settings;
        },
        setSettings(s) {
            _collections.settings = (s && typeof s === 'object') ? s : { visitantes: [], encargados: [], gmaps_api_key: '', factory_address: '' };
            notify('collections:settings', _collections.settings);
            notify('collections:change', { collection: 'settings', data: _collections.settings });
            return _collections.settings;
        },
        resetCollections() {
            _collections.clients = [];
            _collections.prospects = [];
            _collections.users = [];
            _collections.settings = { visitantes: [], encargados: [], gmaps_api_key: '', factory_address: '' };
            notify('collections:reset', null);
            notify('collections:change', { collection: 'all', reset: true });
        }
    };

    // === Dominio: Selection ===
    const selection = {
        getCurrentProspectId() {
            return _selection.currentProspectId;
        },
        setCurrentProspectId(id) {
            _selection.currentProspectId = id ? String(id) : null;
            notify('selection:prospect', _selection.currentProspectId);
            notify('selection:change', { type: 'currentProspectId', value: _selection.currentProspectId });
            return _selection.currentProspectId;
        },
        clearSelection() {
            return this.setCurrentProspectId(null);
        }
    };

    // === Dominio: Navigation ===
    const navigation = {
        getCurrentView() {
            return _navigation.currentView;
        },
        setCurrentView(viewId) {
            const prev = _navigation.currentView;
            _navigation.currentView = viewId;
            notify('navigation:view', { current: viewId, previous: prev });
            notify('navigation:change', { type: 'currentView', value: viewId });
            return _navigation.currentView;
        },
        getLastViewedSection() {
            return _navigation.lastViewedSection;
        },
        setLastViewedSection(sectionId) {
            _navigation.lastViewedSection = sectionId;
            notify('navigation:change', { type: 'lastViewedSection', value: sectionId });
            return _navigation.lastViewedSection;
        },
        getCurrentListMode() {
            return _navigation.currentListMode;
        },
        setCurrentListMode(mode) {
            _navigation.currentListMode = (mode === 'pipeline') ? 'pipeline' : 'agenda';
            notify('navigation:listMode', _navigation.currentListMode);
            notify('navigation:change', { type: 'currentListMode', value: _navigation.currentListMode });
            return _navigation.currentListMode;
        },
        resetNavigation() {
            _navigation.currentView = 'list-view';
            _navigation.lastViewedSection = 'list-view';
            _navigation.currentListMode = 'agenda';
            notify('navigation:reset', null);
        }
    };

    // === Dominio: Filters ===
    const filters = {
        getOppFilters() {
            return Object.assign({}, _filters.opportunities);
        },
        setOppFilters(partial) {
            if (partial && typeof partial === 'object') {
                Object.assign(_filters.opportunities, partial);
                notify('filters:opportunities', _filters.opportunities);
                notify('filters:change', { domain: 'opportunities', value: _filters.opportunities });
            }
            return _filters.opportunities;
        },
        getAgendaFilter() {
            return _filters.agenda.filter;
        },
        setAgendaFilter(f) {
            _filters.agenda.filter = f || 'todas';
            notify('filters:agenda', _filters.agenda.filter);
            notify('filters:change', { domain: 'agenda', value: _filters.agenda.filter });
            return _filters.agenda.filter;
        }
    };

    // === Dominio: Lifecycle ===
    const lifecycle = {
        getLoadedCollections() {
            return _lifecycle.loadedCollections;
        },
        setLoadedCollections(n) {
            _lifecycle.loadedCollections = Number(n) || 0;
            return _lifecycle.loadedCollections;
        },
        incrementLoadedCollections() {
            _lifecycle.loadedCollections += 1;
            notify('lifecycle:loadedCollections', _lifecycle.loadedCollections);
            if (_lifecycle.loadedCollections >= 4 && !_lifecycle.initialLoadCompleted) {
                this.setInitialLoadCompleted(true);
            }
            return _lifecycle.loadedCollections;
        },
        resetLoadedCollections() {
            _lifecycle.loadedCollections = 0;
            return 0;
        },
        isInitialLoadCompleted() {
            return _lifecycle.initialLoadCompleted;
        },
        setInitialLoadCompleted(val) {
            _lifecycle.initialLoadCompleted = Boolean(val);
            notify('lifecycle:initialLoadCompleted', _lifecycle.initialLoadCompleted);
            notify('lifecycle:change', { type: 'initialLoadCompleted', value: _lifecycle.initialLoadCompleted });
            return _lifecycle.initialLoadCompleted;
        },
        isInitialRoleViewRouted() {
            return _lifecycle.initialRoleViewRouted;
        },
        setInitialRoleViewRouted(val) {
            _lifecycle.initialRoleViewRouted = Boolean(val);
            notify('lifecycle:initialRoleViewRouted', _lifecycle.initialRoleViewRouted);
            notify('lifecycle:change', { type: 'initialRoleViewRouted', value: _lifecycle.initialRoleViewRouted });
            return _lifecycle.initialRoleViewRouted;
        },
        getActiveUnsubscribers() {
            return _lifecycle.activeUnsubscribers;
        },
        addUnsubscriber(fn) {
            if (typeof fn === 'function') {
                _lifecycle.activeUnsubscribers.push(fn);
            }
        },
        clearUnsubscribers() {
            const list = _lifecycle.activeUnsubscribers.slice();
            _lifecycle.activeUnsubscribers = [];
            list.forEach(unsub => {
                try {
                    if (typeof unsub === 'function') unsub();
                } catch (e) {
                    console.warn('[AppState] Error al desuscribir listener:', e);
                }
            });
            return list.length;
        },
        getCurrentSubscribedUser() {
            return _lifecycle.currentSubscribedUser;
        },
        setCurrentSubscribedUser(u) {
            _lifecycle.currentSubscribedUser = u || null;
            notify('lifecycle:subscribedUser', _lifecycle.currentSubscribedUser);
            return _lifecycle.currentSubscribedUser;
        },
        getCrmLoadError() {
            return _lifecycle.crmLoadError;
        },
        setCrmLoadError(err) {
            _lifecycle.crmLoadError = err || null;
            notify('lifecycle:loadError', _lifecycle.crmLoadError);
            notify('lifecycle:change', { type: 'crmLoadError', value: _lifecycle.crmLoadError });
            return _lifecycle.crmLoadError;
        },
        resetLifecycle() {
            this.clearUnsubscribers();
            _lifecycle.loadedCollections = 0;
            _lifecycle.initialLoadCompleted = false;
            _lifecycle.initialRoleViewRouted = false;
            _lifecycle.currentSubscribedUser = null;
            _lifecycle.crmLoadError = null;
            notify('lifecycle:reset', null);
        }
    };

    // -------------------------------------------------------------------------
    // 4. Puente de Sincronización Bidireccional con el Ámbito Global (window)
    // -------------------------------------------------------------------------
    function syncWithScope(scope) {
        if (!scope || typeof scope !== 'object') return;

        const propDefs = {
            currentUser: {
                get: () => session.getCurrentUser(),
                set: (v) => session.setCurrentUser(v)
            },
            clients: {
                get: () => collections.getClients(),
                set: (v) => collections.setClients(v)
            },
            prospects: {
                get: () => collections.getProspects(),
                set: (v) => collections.setProspects(v)
            },
            users: {
                get: () => collections.getUsers(),
                set: (v) => collections.setUsers(v)
            },
            settings: {
                get: () => collections.getSettings(),
                set: (v) => collections.setSettings(v)
            },
            currentProspectId: {
                get: () => selection.getCurrentProspectId(),
                set: (v) => selection.setCurrentProspectId(v)
            },
            currentListMode: {
                get: () => navigation.getCurrentListMode(),
                set: (v) => navigation.setCurrentListMode(v)
            },
            lastViewedSection: {
                get: () => navigation.getLastViewedSection(),
                set: (v) => navigation.setLastViewedSection(v)
            },
            initialLoadCompleted: {
                get: () => lifecycle.isInitialLoadCompleted(),
                set: (v) => lifecycle.setInitialLoadCompleted(v)
            },
            initialRoleViewRouted: {
                get: () => lifecycle.isInitialRoleViewRouted(),
                set: (v) => lifecycle.setInitialRoleViewRouted(v)
            },
            loadedCollections: {
                get: () => lifecycle.getLoadedCollections(),
                set: (v) => lifecycle.setLoadedCollections(v)
            },
            authSessionGeneration: {
                get: () => session.getGeneration(),
                set: (v) => session.setGeneration(v)
            },
            currentSubscribedUser: {
                get: () => lifecycle.getCurrentSubscribedUser(),
                set: (v) => lifecycle.setCurrentSubscribedUser(v)
            },
            crmLoadError: {
                get: () => lifecycle.getCrmLoadError(),
                set: (v) => lifecycle.setCrmLoadError(v)
            }
        };

        for (const [prop, desc] of Object.entries(propDefs)) {
            try {
                Object.defineProperty(scope, prop, {
                    get: desc.get,
                    set: desc.set,
                    configurable: true,
                    enumerable: true
                });
            } catch (e) {
                // Si la propiedad no es redefinible en este entorno, asignar valor inicial
                scope[prop] = desc.get();
            }
        }
    }

    // Reset general completo del ERP (utilizado en logout)
    function resetAll() {
        session.resetSession();
        collections.resetCollections();
        selection.clearSelection();
        navigation.resetNavigation();
        lifecycle.resetLifecycle();
        notify('app:reset', null);
    }

    return {
        session,
        collections,
        selection,
        navigation,
        filters,
        lifecycle,
        subscribe,
        notify,
        syncWithScope,
        resetAll
    };
});
