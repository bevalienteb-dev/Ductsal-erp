// modules/users/users_ui.js
// Renderizado de tabla de usuarios, control de modal de edición/creación e interfaz de usuario.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.UsersUI = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function getRoleLabel(role) {
        if (typeof UsersPermissions !== 'undefined' && typeof UsersPermissions.getRoleDisplayName === 'function') {
            return UsersPermissions.getRoleDisplayName(role);
        }
        const roleMap = {
            'manager': 'Gerente', 'gestor': 'Gestor de Ventas', 'vendedor': 'Vendedor',
            'jefe_produccion': 'Jefe de Producción', 'recepcion': 'Recepción',
            'dibujante': 'Dibujante', 'operario': 'Operario', 'control_calidad': 'Control de Calidad', 'despacho': 'Despacho'
        };
        return roleMap[role] || role || '';
    }

    function renderUsersTable(options = {}) {
        const deps = Object.assign({
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            doc: typeof document !== 'undefined' ? document : null
        }, options);

        const doc = deps.doc;
        if (!doc) return;
        const tbody = doc.getElementById('users-body');
        if (!tbody) return;

        tbody.innerHTML = '';
        const userList = deps.getUsers();

        userList.forEach(u => {
            const rName = getRoleLabel(u.role);
            const stHtml = u.activo ? `<span class="ds-badge ds-badge-success">Activo</span>` : `<span class="ds-badge ds-badge-danger">Inactivo</span>`;
            tbody.innerHTML += `<tr class="user-table-row">
            <td class="col-usr-name" style="font-weight:600; color:var(--ds-text-primary, #0F172A);">${u.nombre || '-'}</td>
            <td class="col-usr-email" style="color:var(--ds-text-secondary, #334155);">${u.email || '-'}</td>
            <td class="col-usr-role"><span class="ds-badge ds-badge-neutral">${rName}</span></td>
            <td class="col-usr-status">${stHtml}</td>
            <td class="col-usr-actions">
                <div class="user-actions-group">
                    <button class="btn-secondary btn-usr-edit" style="padding:4px 8px; font-size:0.74rem;" onclick="openUserModal('${u.id}')">Editar</button>
                    <button class="btn-secondary btn-usr-reset" style="padding:4px 8px; font-size:0.74rem; margin-left:4px;" onclick="resetUserPassword('${u.id}')">Reset Pass</button>
                    <button class="${u.activo ? 'btn-danger' : 'btn-success'} btn-usr-toggle" style="padding:4px 8px; font-size:0.74rem; margin-left:4px;" onclick="toggleUserStatus('${u.id}')">${u.activo ? 'Desactivar' : 'Activar'}</button>
                </div>
            </td>
        </tr>`;
        });
    }

    function openUserModal(options = {}, id = null) {
        let deps = options;
        let userId = id;
        if (typeof options === 'string' || options === null) {
            userId = options;
            deps = {};
        }

        const resolvedDeps = Object.assign({
            getUsers: () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []),
            doc: typeof document !== 'undefined' ? document : null
        }, deps);

        const doc = resolvedDeps.doc;
        if (!doc) return;

        const idInput = doc.getElementById('user-id-edit');
        const nombreInput = doc.getElementById('usr-nombre');
        const emailInput = doc.getElementById('usr-email');
        const rolInput = doc.getElementById('usr-rol');
        const titleEl = doc.getElementById('user-modal-title');
        const modalEl = doc.getElementById('userModal');

        if (userId) {
            const userList = resolvedDeps.getUsers();
            const u = userList.find(x => x.id === userId);
            if (u) {
                if (idInput) idInput.value = u.id || '';
                if (nombreInput) nombreInput.value = u.nombre || '';
                if (emailInput) emailInput.value = u.email || '';
                if (rolInput) rolInput.value = u.role || 'vendedor';
            }
            if (titleEl) titleEl.textContent = 'Editar Usuario';
        } else {
            if (idInput) idInput.value = '';
            if (nombreInput) nombreInput.value = '';
            if (emailInput) emailInput.value = '';
            if (rolInput) rolInput.value = 'vendedor';
            if (titleEl) titleEl.textContent = 'Registrar Usuario';
        }

        if (modalEl) modalEl.style.display = 'block';
    }

    function closeUserModal(options = {}) {
        const deps = Object.assign({
            closeModalFn: (id) => (typeof closeModal === 'function' ? closeModal(id) : null),
            doc: typeof document !== 'undefined' ? document : null
        }, options);

        if (typeof deps.closeModalFn === 'function') {
            deps.closeModalFn('userModal');
        } else if (deps.doc) {
            const modalEl = deps.doc.getElementById('userModal');
            if (modalEl) modalEl.style.display = 'none';
        }
    }

    return {
        getRoleLabel,
        renderUsersTable,
        openUserModal,
        closeUserModal
    };
});
