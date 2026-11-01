// modules/users/users_permissions.js
// Matriz canónica de roles, permisos, resolución de accesos y enrutamiento inicial por rol.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.UsersPermissions = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const CRM_ROLES = ['manager', 'gestor', 'vendedor'];
    const PLANT_ROLES = [
        'jefe_produccion', 'recepcion', 'dibujante', 'operario',
        'encargado_armado', 'control_calidad', 'despacho'
    ];

    const ROLE_LABELS = {
        'manager': 'Gerente',
        'gestor': 'Gestor de Ventas',
        'vendedor': 'Vendedor',
        'jefe_produccion': 'Jefe de Producción',
        'recepcion': 'Recepción de Requerimientos',
        'dibujante': 'Dibujante',
        'operario': 'Operario de Fabricación',
        'encargado_armado': 'Encargado de Armado',
        'control_calidad': 'Control de Calidad',
        'despacho': 'Despacho'
    };

    function getRoleDisplayName(role) {
        return ROLE_LABELS[role] || role || '';
    }

    function isCrmRole(role) {
        return CRM_ROLES.includes(role);
    }

    function isPlantRole(role) {
        return PLANT_ROLES.includes(role);
    }

    function canAccessView(user, viewId) {
        if (!user || !user.role) return false;
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
            case 'list-view':
            case 'clients-view':
            case 'detail-view':
                return true;
            default:
                return true;
        }
    }

    function canManageUsers(user) {
        return !!(user && user.role === 'manager');
    }

    function canExecuteManagerActions(user) {
        return !!(user && user.role === 'manager');
    }

    function applyRolePermissions(options = {}) {
        const deps = Object.assign({
            getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
            setCurrentListMode: (m) => { if (typeof currentListMode !== 'undefined') currentListMode = m; },
            getCurrentListMode: () => (typeof currentListMode !== 'undefined' ? currentListMode : 'agenda'),
            getInitialRoleViewRouted: () => (typeof initialRoleViewRouted !== 'undefined' ? initialRoleViewRouted : false),
            setInitialRoleViewRouted: (v) => { if (typeof initialRoleViewRouted !== 'undefined') initialRoleViewRouted = v; },
            showView: (v) => (typeof showView === 'function' ? showView(v) : null),
            switchListMode: (m) => (typeof switchListMode === 'function' ? switchListMode(m) : null),
            renderDailyAgenda: () => (typeof renderDailyAgenda === 'function' ? renderDailyAgenda() : null),
            renderList: () => (typeof renderList === 'function' ? renderList() : null),
            renderClientsTable: () => (typeof renderClientsTable === 'function' ? renderClientsTable() : null),
            renderUsersTable: () => (typeof renderUsersTable === 'function' ? renderUsersTable() : null),
            fetchAdminUsers: () => (typeof fetchAdminUsers === 'function' ? fetchAdminUsers() : null),
            doc: typeof document !== 'undefined' ? document : null
        }, options);

        const user = deps.getCurrentUser();
        if (!user) return;
        const role = user.role;
        const doc = deps.doc;
        if (!doc) return;

        const navDashboard = doc.getElementById('nav-dashboard');
        const navProjects = doc.getElementById('nav-projects');
        const headerAction = doc.getElementById('client-action-header');
        const navSettings = doc.getElementById('nav-settings');
        const navUsers = doc.getElementById('nav-users');
        const navList = doc.getElementById('nav-list');
        const navClients = doc.getElementById('nav-clients');

        // Ocultar todos inicialmente
        [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => {
            if (n && n.style) n.style.display = 'none';
        });
        if (headerAction && headerAction.style) headerAction.style.display = 'none';

        // Preservar vista activa actual si existe
        const activeView = doc.querySelector ? doc.querySelector('.view-section.active') : null;
        const currentActiveId = activeView ? activeView.id : null;
        const navProjectsText = doc.getElementById('nav-projects-text');

        if (role === 'manager') {
            deps.setCurrentListMode('pipeline');
            [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => {
                if (n && n.style) n.style.display = 'flex';
            });
            if (navProjectsText) navProjectsText.textContent = 'Proyectos y Cobros';
            else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Proyectos y Cobros';
        } else if (role === 'gestor') {
            deps.setCurrentListMode('agenda');
            [navProjects, navList, navClients].forEach(n => {
                if (n && n.style) n.style.display = 'flex';
            });
            if (navProjectsText) navProjectsText.textContent = 'Proyectos y Cobros';
            else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Proyectos y Cobros';
            if (headerAction && headerAction.style) headerAction.style.display = 'table-cell';
        } else if (role === 'vendedor') {
            deps.setCurrentListMode('agenda');
            [navProjects, navList, navClients].forEach(n => {
                if (n && n.style) n.style.display = 'flex';
            });
            if (navProjectsText) navProjectsText.textContent = 'Mis Proyectos y Cobros Asignados';
            else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Mis Proyectos y Cobros Asignados';
            if (headerAction && headerAction.style) headerAction.style.display = 'table-cell';
        } else {
            deps.setCurrentListMode('agenda');
            [navList, navClients].forEach(n => {
                if (n && n.style) n.style.display = 'flex';
            });
            if (headerAction && headerAction.style) headerAction.style.display = 'table-cell';
        }

        // Enrutamiento inicial de vista según rol
        if (!deps.getInitialRoleViewRouted()) {
            deps.setInitialRoleViewRouted(true);
            if (role === 'manager') {
                deps.showView('dashboard-view');
            } else if (role === 'gestor' || role === 'vendedor') {
                deps.setCurrentListMode('agenda');
                deps.showView('list-view');
                if (typeof deps.switchListMode === 'function') deps.switchListMode('agenda');
            } else {
                deps.setCurrentListMode('agenda');
                deps.showView('list-view');
                if (typeof deps.switchListMode === 'function') deps.switchListMode('agenda');
            }
        } else {
            // Sesión ya navegada: preservar la vista activa siempre que tenga permisos
            if (!currentActiveId) {
                if (role === 'manager') {
                    deps.showView('dashboard-view');
                } else {
                    deps.setCurrentListMode('agenda');
                    deps.showView('list-view');
                    if (typeof deps.switchListMode === 'function') deps.switchListMode('agenda');
                }
            } else if (currentActiveId === 'dashboard-view' && role !== 'manager') {
                deps.setCurrentListMode('agenda');
                deps.showView('list-view');
                if (typeof deps.switchListMode === 'function') deps.switchListMode('agenda');
            } else if (currentActiveId === 'users-view' && role !== 'manager') {
                deps.setCurrentListMode('agenda');
                deps.showView('list-view');
                if (typeof deps.switchListMode === 'function') deps.switchListMode('agenda');
            }
        }

        if (deps.getCurrentListMode() === 'agenda') {
            if (typeof deps.renderDailyAgenda === 'function') deps.renderDailyAgenda();
            else if (typeof deps.renderList === 'function') deps.renderList();
        } else {
            if (typeof deps.renderList === 'function') deps.renderList();
        }

        if (typeof deps.renderClientsTable === 'function') deps.renderClientsTable();

        if (role === 'manager') {
            if (typeof deps.renderUsersTable === 'function') deps.renderUsersTable();
            if (typeof deps.fetchAdminUsers === 'function') deps.fetchAdminUsers();
        }
    }

    return {
        CRM_ROLES,
        PLANT_ROLES,
        ROLE_LABELS,
        getRoleDisplayName,
        isCrmRole,
        isPlantRole,
        canAccessView,
        canManageUsers,
        canExecuteManagerActions,
        applyRolePermissions
    };
});
