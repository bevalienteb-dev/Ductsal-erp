// ============================================================================
// DUCTSAL ERP — CLIENTS MODULE: CONTACTS & PERIODS UI (Fase 2 Bloques B1 + B2)
// Archivo: modules/clients/contacts_ui.js
// Responsabilidad:
// 1. Gestión de personas y relaciones cuenta-persona (Hub & Spoke).
// 2. Vistas completas (.view-section) integradas en el enrutador ERP (Cero Modales).
// 3. Consulta y visualización del historial de cargos y períodos (periods_prod).
// 4. Búsqueda y creación/edición de identidad de personas (contacts_prod).
// 5. Preservación estricta de contexto y navegación fluida entre vistas.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.ContactsUI = api;
        if (typeof window !== 'undefined') {
            window.ContactsUI = api;

            // Vistas principales full-screen
            window.openAccountContactsView = api.openAccountContactsView;
            window.closeAccountContactsView = api.closeAccountContactsView;
            window.returnToClientsView = api.returnToClientsView;
            window.cancelContactOperation = api.cancelContactOperation;

            window.openCreatePersonView = api.openCreatePersonView;
            window.submitCreatePerson = api.submitCreatePerson;

            window.openEditPersonView = api.openEditPersonView;
            window.submitEditPerson = api.submitEditPerson;

            window.openLinkContactView = api.openLinkContactView;
            window.closeLinkContactView = api.closeLinkContactView;
            window.setLinkContactMode = api.setLinkContactMode;
            window.onPersonSearchInput = api.onPersonSearchInput;
            window.selectPersonForLinking = api.selectPersonForLinking;
            window.submitLinkContact = api.submitLinkContact;

            window.openEditAccountContactView = api.openEditAccountContactView;
            window.closeEditAccountContactView = api.closeEditAccountContactView;
            window.submitEditAccountContact = api.submitEditAccountContact;

            window.openDeactivateContactView = api.openDeactivateContactView;
            window.closeDeactivateContactView = api.closeDeactivateContactView;
            window.submitDeactivateContact = api.submitDeactivateContact;

            window.openReactivateContactView = api.openReactivateContactView;
            window.closeReactivateContactView = api.closeReactivateContactView;
            window.submitReactivateContact = api.submitReactivateContact;

            window.openContactPeriodsView = api.openContactPeriodsView;
            window.closeContactPeriodsView = api.closeContactPeriodsView;
            window.toggleInactiveContactsFilter = api.toggleInactiveContactsFilter;

            // Alias de retrocompatibilidad
            window.openAccountContactsModal = api.openAccountContactsModal;
            window.closeAccountContactsModal = api.closeAccountContactsModal;
            window.openLinkContactModal = api.openLinkContactModal;
            window.closeLinkContactModal = api.closeLinkContactModal;
            window.openEditAccountContactModal = api.openEditAccountContactModal;
            window.closeEditAccountContactModal = api.closeEditAccountContactModal;
            window.openDeactivateContactModal = api.openDeactivateContactModal;
            window.closeDeactivateContactModal = api.closeDeactivateContactModal;
            window.openReactivateContactModal = api.openReactivateContactModal;
            window.closeReactivateContactModal = api.closeReactivateContactModal;
            window.openContactPeriodsModal = api.openContactPeriodsModal;
            window.closeContactPeriodsModal = api.closeContactPeriodsModal;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // Estado interno del módulo de contactos
    let activeAccountId = null;
    let activeAccountData = null;
    let currentContactsList = [];
    let showInactive = true;
    let selectedPersonForLinking = null;
    let searchDebounceTimer = null;
    let targetAccountContactForAction = null;
    let targetPersonForAction = null;

    // Dependencias inyectadas con fallbacks
    const _deps = {
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : (typeof window !== 'undefined' && window.firebase ? window.firebase : null)),
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getCrmContacts: () => (typeof CrmContacts !== 'undefined' ? CrmContacts : (typeof window !== 'undefined' && window.CrmContacts ? window.CrmContacts : null)),
        getCrmUI: () => (typeof CrmUI !== 'undefined' ? CrmUI : (typeof window !== 'undefined' && window.CrmUI ? window.CrmUI : null)),
        showView: (viewId) => {
            if (typeof window !== 'undefined' && typeof window.showView === 'function') {
                return window.showView(viewId);
            }
            if (typeof showView === 'function') return showView(viewId);
        },
        closeModal: (id) => {
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') {
                return window.closeModal(id);
            }
            if (typeof closeModal === 'function') return closeModal(id);
        },
        formatDate: (val) => {
            if (!val) return '-';
            try {
                const d = typeof val.toDate === 'function' ? val.toDate() : (typeof val.seconds === 'number' ? new Date(val.seconds * 1000) : new Date(val));
                if (isNaN(d.getTime())) return String(val);
                return d.toLocaleDateString('es-SV', { year: 'numeric', month: 'short', day: 'numeric' });
            } catch (e) {
                return String(val);
            }
        },
        formatDateTime: (val) => {
            if (!val) return '-';
            try {
                const d = typeof val.toDate === 'function' ? val.toDate() : (typeof val.seconds === 'number' ? new Date(val.seconds * 1000) : new Date(val));
                if (isNaN(d.getTime())) return String(val);
                return d.toLocaleString('es-SV', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                return String(val);
            }
        },
        esc: (s) => {
            if (s === null || s === undefined) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }
    };

    function notify(type, msg) {
        const ui = _deps.getCrmUI();
        if (ui && typeof ui.notify === 'function') {
            ui.notify(type, msg);
        } else {
            console.log(`[${type.toUpperCase()}] ${msg}`);
        }
    }

    function setStatusBanner(elementId, type, message) {
        const el = document.getElementById(elementId);
        if (!el) return;
        if (!message) {
            el.style.display = 'none';
            el.innerHTML = '';
            el.className = 'alert-feedback-banner';
            return;
        }

        const colors = {
            loading: { bg: 'rgba(56, 189, 248, 0.12)', border: 'rgba(56, 189, 248, 0.4)', text: '#38bdf8', icon: '⏳' },
            success: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.4)', text: 'var(--success)', icon: '✅' },
            error: { bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.4)', text: 'var(--danger)', icon: '⚠️' },
            warning: { bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.4)', text: 'var(--brand-gold)', icon: '⚠️' }
        };

        const theme = colors[type] || colors.loading;
        el.style.display = 'block';
        el.style.background = theme.bg;
        el.style.border = `1px solid ${theme.border}`;
        el.style.color = theme.text;
        el.style.padding = '0.75rem 1rem';
        el.style.borderRadius = '6px';
        el.style.fontSize = '0.85rem';
        el.innerHTML = `<strong>${theme.icon}</strong> ${_deps.esc(message)}`;
    }

    function getAccountDisplayName(account) {
        if (!account) return 'Cuenta Desconocida';
        if (account.tipo === 'natural') {
            return `${account.nombres || ''} ${account.apellidos || ''}`.trim() || account.id;
        }
        return account.empresa || account.contacto || account.id;
    }

    // =========================================================================
    // 0. NAVEGACIÓN Y RETORNO
    // =========================================================================

    function returnToClientsView() {
        activeAccountId = null;
        activeAccountData = null;
        currentContactsList = [];
        _deps.showView('clients-view');
    }

    function cancelContactOperation() {
        if (activeAccountId) {
            openAccountContactsView(activeAccountId);
        } else {
            returnToClientsView();
        }
    }

    // =========================================================================
    // 1. VISTA PRINCIPAL FULL-SCREEN: CONTACTOS DE LA CUENTA
    // =========================================================================

    async function openAccountContactsView(accountId) {
        if (!accountId) return;
        activeAccountId = accountId;
        const allClients = _deps.getClients();
        activeAccountData = allClients.find(c => c.id === accountId) || { id: accountId };

        // Cerrar contenedor de detalle de cliente si estaba activo
        _deps.closeModal('clientDetailContent');

        // Navegar a la vista full-screen
        _deps.showView('account-contacts-view');

        // Actualizar banner de contexto
        const nameEl = document.getElementById('acc-contacts-account-name');
        if (nameEl) nameEl.textContent = getAccountDisplayName(activeAccountData);

        const idBadge = document.getElementById('acc-contacts-account-id');
        if (idBadge) idBadge.textContent = activeAccountId;

        const typeEl = document.getElementById('acc-contacts-account-type');
        if (typeEl) {
            typeEl.textContent = activeAccountData.tipo === 'natural' ? 'Persona Natural' : 'Persona Jurídica (Empresa)';
        }

        const taxEl = document.getElementById('acc-contacts-account-tax-id');
        if (taxEl) {
            const tax = activeAccountData.nit || activeAccountData.nrc || activeAccountData.dui || 'No especificado';
            taxEl.textContent = tax;
        }

        setStatusBanner('acc-contacts-view-status', null);
        await loadAndRenderAccountContacts();
    }

    async function loadAndRenderAccountContacts() {
        const container = document.getElementById('acc-contacts-list-container');
        if (!container) return;

        container.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                <div class="spinner" style="display:inline-block; width:30px; height:30px; border:3px solid rgba(255,204,77,0.2); border-top-color:var(--brand-gold); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                <p style="margin-top: 0.85rem; font-size: 0.9rem;">Cargando personas y relaciones corporativas de la cuenta...</p>
            </div>
        `;

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            container.innerHTML = `<div class="table-empty-box"><p>El servicio de contactos no está disponible en este momento.</p></div>`;
            return;
        }

        try {
            const res = await crmContacts.listAccountContacts(fb, {
                accountId: activeAccountId,
                includeInactive: true,
                dbSuffix: _deps.getDbSuffix()
            });

            currentContactsList = (res && res.contacts) || [];
            renderContactsTable();
        } catch (err) {
            console.error('[ContactsUI] Error loading contacts:', err);
            container.innerHTML = `
                <div class="table-empty-box" style="color: var(--danger);">
                    <div class="icon">⚠️</div>
                    <h3>Error al cargar contactos</h3>
                    <p>${_deps.esc(err.message || 'No se pudieron recuperar los contactos de la cuenta.')}</p>
                    <button class="btn-secondary mt-2" onclick="ContactsUI.openAccountContactsView('${activeAccountId}')">Reintentar</button>
                </div>
            `;
        }
    }

    function toggleInactiveContactsFilter() {
        showInactive = !showInactive;
        const toggleBtn = document.getElementById('btn-toggle-inactive-contacts');
        if (toggleBtn) {
            toggleBtn.classList.toggle('active', showInactive);
            toggleBtn.textContent = showInactive ? '👁️ Mostrando Inactivos' : '👁️ Ocultando Inactivos';
        }
        renderContactsTable();
    }

    function renderContactsTable() {
        const container = document.getElementById('acc-contacts-list-container');
        if (!container) return;

        const countBadge = document.getElementById('acc-contacts-count-badge');
        const activeCount = currentContactsList.filter(c => c.activo === true).length;
        if (countBadge) {
            countBadge.textContent = `${activeCount} activos / ${currentContactsList.length} total`;
        }

        const filtered = showInactive ? currentContactsList : currentContactsList.filter(c => c.activo === true);

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="table-empty-box" style="padding: 3rem 1.5rem; text-align: center; background: rgba(0,0,0,0.15); border: 1px dashed var(--panel-border); border-radius: 8px;">
                    <div class="icon" style="font-size:2.5rem; opacity:0.6; margin-bottom: 0.5rem;">👥</div>
                    <h3 style="font-size:1.1rem; color:white; margin-bottom:0.4rem;">No hay personas vinculadas a esta cuenta</h3>
                    <p style="font-size:0.88rem; color:var(--text-muted); margin-bottom: 1.25rem;">Vincula contactos existentes o crea una nueva persona bajo el modelo Hub &amp; Spoke.</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button class="btn-secondary" onclick="ContactsUI.openCreatePersonView('${activeAccountId}')" style="font-size:0.85rem; padding:0.5rem 1rem;">
                            + Registrar Persona Global
                        </button>
                        <button class="btn-primary" onclick="ContactsUI.openLinkContactView('${activeAccountId}')" style="font-size:0.85rem; padding:0.5rem 1.2rem;">
                            🔗 Vincular Persona a Cuenta
                        </button>
                    </div>
                </div>
            `;
            return;
        }

        let html = `
            <div class="table-container glass-panel" style="padding:0; overflow:hidden; border-radius: 8px;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background: rgba(0,0,0,0.25); border-bottom: 1px solid var(--panel-border);">
                            <th style="width: 25%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase;">Persona</th>
                            <th style="width: 20%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase;">Cargo Actual</th>
                            <th style="width: 22%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase;">Contacto Corporativo</th>
                            <th style="width: 11%; padding: 0.85rem 1rem; text-align: center; font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase;">Estado</th>
                            <th style="width: 22%; padding: 0.85rem 1rem; text-align: right; font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase;">Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        filtered.forEach(ac => {
            const p = ac.person || ac.persona || {};
            const personId = p.id || ac.contactId;
            const fullName = `${p.nombres || ''} ${p.apellidos || ''}`.trim() || 'Persona sin nombre';
            const isActive = ac.activo === true;

            const statusBadge = isActive
                ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:var(--success); border:1px solid rgba(16,185,129,0.3); font-weight:600; font-size:0.75rem;">🟢 Activo</span>`
                : `<span class="badge" style="background:rgba(107,114,128,0.2); color:var(--text-muted); border:1px solid rgba(107,114,128,0.3); font-size:0.75rem;">⚫ Inactivo</span>`;

            const periodsBadge = `<span class="badge" style="background:rgba(255,204,77,0.1); color:var(--brand-gold); border:1px solid rgba(255,204,77,0.25); font-size:0.7rem; margin-left:6px;">${ac.total_periodos || 1} ${(ac.total_periodos || 1) === 1 ? 'período' : 'períodos'}</span>`;

            // Contacto corporativo
            const phoneParts = [];
            if (ac.telefono_corporativo) {
                phoneParts.push(`<span title="Teléfono corporativo">📞 ${_deps.esc(ac.telefono_corporativo)}${ac.extension ? ` (Ext. ${_deps.esc(ac.extension)})` : ''}</span>`);
            }
            if (p.telefono && !ac.telefono_corporativo) {
                phoneParts.push(`<span style="color:var(--text-muted);" title="Teléfono personal">📱 ${_deps.esc(p.telefono)}</span>`);
            }

            const emailParts = [];
            if (ac.correo_corporativo) {
                emailParts.push(`<a href="mailto:${_deps.esc(ac.correo_corporativo)}" style="color:var(--text-secondary); text-decoration:none;" title="Correo corporativo">✉️ ${_deps.esc(ac.correo_corporativo)}</a>`);
            }
            if (p.correo && !ac.correo_corporativo) {
                emailParts.push(`<a href="mailto:${_deps.esc(p.correo)}" style="color:var(--text-muted); text-decoration:none;" title="Correo personal">✉️ ${_deps.esc(p.correo)}</a>`);
            }

            const contactCell = (phoneParts.length || emailParts.length)
                ? `<div style="display:flex; flex-direction:column; gap:2px; font-size:0.8rem;">
                    ${phoneParts.join('')}
                    ${emailParts.join('')}
                   </div>`
                : `<span style="color:var(--text-muted); font-size:0.8rem;">-</span>`;

            // Metadatos de identidad personal
            const personalMeta = [];
            if (p.telefono && ac.telefono_corporativo) personalMeta.push(`Tel. pers: ${_deps.esc(p.telefono)}`);
            if (p.correo && ac.correo_corporativo) personalMeta.push(`Correo pers: ${_deps.esc(p.correo)}`);
            const personalSub = personalMeta.length ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">${personalMeta.join(' | ')}</div>` : '';

            // Botones de acción según estado
            let actionButtons = `
                <button type="button" class="btn-table-action" onclick="ContactsUI.openContactPeriodsView('${ac.id}', '${_deps.esc(fullName)}')" title="Ver historial cronológico de períodos" style="background:rgba(56,189,248,0.15); color:#38bdf8; border-color:rgba(56,189,248,0.3);">
                    🕒 Historial
                </button>
                <button type="button" class="btn-table-action" onclick="ContactsUI.openEditPersonView('${personId}', '${ac.id}')" title="Modificar datos personales de la identidad física" style="background:rgba(255,204,77,0.12); color:var(--brand-gold); border-color:rgba(255,204,77,0.3);">
                    👤 Persona
                </button>
            `;

            if (isActive) {
                actionButtons += `
                    <button type="button" class="btn-table-action btn-table-edit" onclick="ContactsUI.openEditAccountContactView('${ac.id}')" title="Modificar cargo o datos corporativos">
                        ✏️ Cargo
                    </button>
                    <button type="button" class="btn-table-action btn-table-delete" onclick="ContactsUI.openDeactivateContactView('${ac.id}', '${_deps.esc(fullName)}')" title="Dar de baja y cerrar período">
                        ⛔ Baja
                    </button>
                `;
            } else {
                actionButtons += `
                    <button type="button" class="btn-table-action" onclick="ContactsUI.openReactivateContactView('${ac.id}', '${_deps.esc(fullName)}')" title="Reactivar persona en esta cuenta con un nuevo período" style="background:rgba(16,185,129,0.15); color:var(--success); border-color:rgba(16,185,129,0.3);">
                        🔄 Reactivar
                    </button>
                `;
            }

            html += `
                <tr style="border-bottom:1px solid var(--panel-border); ${!isActive ? 'opacity:0.68;' : ''}">
                    <td style="padding: 0.85rem 1rem;">
                        <div style="font-weight:600; color:white; font-size:0.9rem;">${_deps.esc(fullName)}</div>
                        ${personalSub}
                    </td>
                    <td style="padding: 0.85rem 1rem;">
                        <div style="font-weight:500; color:var(--brand-gold); font-size:0.88rem;">${_deps.esc(ac.cargo || '-')}</div>
                        <div style="margin-top:2px;">${periodsBadge}</div>
                    </td>
                    <td style="padding: 0.85rem 1rem;">${contactCell}</td>
                    <td style="padding: 0.85rem 1rem; text-align:center;">${statusBadge}</td>
                    <td style="padding: 0.85rem 1rem; text-align:right; white-space:nowrap;">
                        <div class="table-btn-group" style="justify-content:flex-end; gap: 4px;">
                            ${actionButtons}
                        </div>
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;

        container.innerHTML = html;
    }

    // =========================================================================
    // 2. VISTA FULL-SCREEN: CREAR IDENTIDAD PERSONAL (contacts_prod)
    // =========================================================================

    function openCreatePersonView(accountId) {
        if (accountId) activeAccountId = accountId;
        const allClients = _deps.getClients();
        if (activeAccountId && !activeAccountData) {
            activeAccountData = allClients.find(c => c.id === activeAccountId) || { id: activeAccountId };
        }

        _deps.showView('create-person-view');

        const contextNameEl = document.getElementById('create-person-account-context-name');
        if (contextNameEl) {
            contextNameEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '(Ninguna seleccionada - Registro Global)';
        }

        const linkBox = document.getElementById('create-person-link-box');
        const accountFields = document.getElementById('create-person-account-fields');
        const linkNowCheck = document.getElementById('create-person-link-now');

        if (activeAccountId) {
            if (linkBox) linkBox.style.display = 'block';
            if (linkNowCheck) linkNowCheck.checked = true;
            if (accountFields) accountFields.style.display = 'block';
        } else {
            if (linkBox) linkBox.style.display = 'none';
            if (linkNowCheck) linkNowCheck.checked = false;
            if (accountFields) accountFields.style.display = 'none';
        }

        // Reset form
        const form = document.getElementById('form-create-person');
        if (form && typeof form.reset === 'function') form.reset();

        setStatusBanner('create-person-status', null);
    }

    async function submitCreatePerson(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            notify('error', 'El servicio de contactos no está disponible');
            return;
        }

        const nombres = ((document.getElementById('create-person-nombres') || {}).value || '').trim();
        const apellidos = ((document.getElementById('create-person-apellidos') || {}).value || '').trim();
        const telefono = ((document.getElementById('create-person-telefono') || {}).value || '').trim();
        const correo = ((document.getElementById('create-person-correo') || {}).value || '').trim();

        if (!nombres || !apellidos) {
            setStatusBanner('create-person-status', 'warning', 'Nombres y Apellidos de la persona son campos obligatorios.');
            return;
        }

        const linkNowCheck = document.getElementById('create-person-link-now');
        const willLinkNow = Boolean(linkNowCheck && linkNowCheck.checked && activeAccountId);

        let cargo = '';
        let telCorp = '';
        let ext = '';
        let correoCorp = '';

        if (willLinkNow) {
            cargo = ((document.getElementById('create-person-cargo') || {}).value || '').trim();
            telCorp = ((document.getElementById('create-person-tel-corp') || {}).value || '').trim();
            ext = ((document.getElementById('create-person-ext') || {}).value || '').trim();
            correoCorp = ((document.getElementById('create-person-correo-corp') || {}).value || '').trim();

            if (!cargo) {
                setStatusBanner('create-person-status', 'warning', 'El cargo en la empresa es obligatorio al vincular a la cuenta.');
                return;
            }
        }

        setStatusBanner('create-person-status', 'loading', 'Registrando identidad de la persona...');

        try {
            const res = await crmContacts.createContact(fb, {
                contact: { nombres, apellidos, telefono, correo },
                dbSuffix: _deps.getDbSuffix()
            });

            const personId = res && res.contact ? res.contact.id : null;
            if (!personId) throw new Error('No se pudo obtener el identificador de la persona creada.');

            if (willLinkNow) {
                setStatusBanner('create-person-status', 'loading', 'Vinculando persona a la cuenta seleccionada...');
                await crmContacts.linkContactToAccount(fb, {
                    accountId: activeAccountId,
                    contactId: personId,
                    cargo,
                    telefono_corporativo: telCorp,
                    extension: ext,
                    correo_corporativo: correoCorp,
                    dbSuffix: _deps.getDbSuffix()
                });
            }

            setStatusBanner('create-person-status', 'success', 'Persona registrada exitosamente. Regresando al directorio...');
            notify('success', willLinkNow ? 'Persona creada y vinculada exitosamente.' : 'Persona registrada exitosamente.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error creating person:', err);
            setStatusBanner('create-person-status', 'error', err.message || 'Error al registrar la persona.');
            notify('error', err.message || 'Error al registrar la persona.');
        }
    }

    // =========================================================================
    // 3. VISTA FULL-SCREEN: EDITAR IDENTIDAD PERSONAL (contacts_prod)
    // =========================================================================

    async function openEditPersonView(contactId, accountContactId) {
        if (!contactId) return;
        targetPersonForAction = { contactId, accountContactId };

        _deps.showView('edit-person-view');

        const contactIdEl = document.getElementById('edit-person-contact-id');
        if (contactIdEl) contactIdEl.textContent = contactId;

        const accNameEl = document.getElementById('edit-person-account-name');
        if (accNameEl) accNameEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';

        const idHidden = document.getElementById('edit-person-id-val');
        if (idHidden) idHidden.value = contactId;

        setStatusBanner('edit-person-status', 'loading', 'Cargando datos personales...');

        // Intentar pre-llenar desde currentContactsList
        let person = null;
        if (accountContactId) {
            const rel = currentContactsList.find(c => c.id === accountContactId);
            if (rel && (rel.person || rel.persona)) person = rel.person || rel.persona;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();

        if (!person && crmContacts && fb) {
            try {
                const res = await crmContacts.getContact(fb, { contactId, dbSuffix: _deps.getDbSuffix() });
                person = res && res.contact ? res.contact : null;
            } catch (e) {
                console.warn('[ContactsUI] Could not fetch contact details via server, falling back to local');
            }
        }

        if (person) {
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
            setVal('edit-person-nombres', person.nombres);
            setVal('edit-person-apellidos', person.apellidos);
            setVal('edit-person-telefono', person.telefono);
            setVal('edit-person-correo', person.correo);
            setStatusBanner('edit-person-status', null);
        } else {
            setStatusBanner('edit-person-status', 'warning', 'No se pudieron recuperar los datos completos; ingresa los datos a actualizar.');
        }
    }

    async function submitEditPerson(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const contactId = (document.getElementById('edit-person-id-val') || {}).value || (targetPersonForAction && targetPersonForAction.contactId);
        if (!contactId) return;

        const nombres = ((document.getElementById('edit-person-nombres') || {}).value || '').trim();
        const apellidos = ((document.getElementById('edit-person-apellidos') || {}).value || '').trim();
        const telefono = ((document.getElementById('edit-person-telefono') || {}).value || '').trim();
        const correo = ((document.getElementById('edit-person-correo') || {}).value || '').trim();

        if (!nombres || !apellidos) {
            setStatusBanner('edit-person-status', 'warning', 'Nombres y Apellidos son obligatorios.');
            return;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            notify('error', 'El servicio de contactos no está disponible');
            return;
        }

        setStatusBanner('edit-person-status', 'loading', 'Guardando cambios de la identidad personal...');

        try {
            await crmContacts.updateContact(fb, {
                contactId,
                contact: { nombres, apellidos, telefono, correo },
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('edit-person-status', 'success', 'Identidad personal actualizada correctamente. Regresando...');
            notify('success', 'Datos personales actualizados.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error updating person:', err);
            setStatusBanner('edit-person-status', 'error', err.message || 'Error al actualizar la persona.');
            notify('error', err.message || 'Error al actualizar la persona.');
        }
    }

    // =========================================================================
    // 4. VISTA FULL-SCREEN: VINCULAR PERSONA A CUENTA
    // =========================================================================

    function openLinkContactView(accountId) {
        if (accountId) activeAccountId = accountId;
        const allClients = _deps.getClients();
        if (activeAccountId && !activeAccountData) {
            activeAccountData = allClients.find(c => c.id === activeAccountId) || { id: activeAccountId };
        }

        _deps.showView('link-contact-account-view');

        const targetAccEl = document.getElementById('link-contact-target-account');
        if (targetAccEl) {
            targetAccEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';
        }

        selectedPersonForLinking = null;
        updateSelectedPersonBox();

        const form = document.getElementById('form-link-contact-account');
        if (form && typeof form.reset === 'function') form.reset();

        const searchInput = document.getElementById('input-search-person-fs');
        if (searchInput) searchInput.value = '';

        const resultsBox = document.getElementById('person-search-results-fs');
        if (resultsBox) {
            resultsBox.innerHTML = `<p style="padding: 0.85rem; color: var(--text-muted); font-size: 0.85rem; margin: 0; text-align: center;">Escribe al menos 2 caracteres para buscar personas...</p>`;
        }

        setStatusBanner('link-contact-status', null);
    }

    function onPersonSearchInput(query) {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        const q = String(query || '').trim();
        const resultsBox = document.getElementById('person-search-results-fs') || document.getElementById('person-search-results');
        if (!resultsBox) return;

        if (q.length < 2) {
            resultsBox.innerHTML = `<p style="padding:0.75rem; color:var(--text-muted); font-size:0.82rem; margin:0; text-align: center;">Escribe al menos 2 caracteres para buscar personas...</p>`;
            return;
        }

        resultsBox.innerHTML = `<p style="padding:0.75rem; color:var(--text-secondary); font-size:0.82rem; margin:0; text-align: center;">Buscando personas registradas...</p>`;

        searchDebounceTimer = setTimeout(async () => {
            const crmContacts = _deps.getCrmContacts();
            const fb = _deps.getFirebase();
            if (!crmContacts || !fb) return;

            try {
                const activeContactPersonIds = new Set(
                    currentContactsList
                        .filter(rel => rel.activo === true && rel.eliminado !== true)
                        .map(rel => rel.contactId || (rel.person && rel.person.id) || (rel.persona && rel.persona.id))
                        .filter(Boolean)
                );

                const res = await crmContacts.searchContacts(fb, {
                    q,
                    limit: 10,
                    excludeAccountId: activeAccountId,
                    dbSuffix: _deps.getDbSuffix()
                });

                const rawContacts = (res && (res.contacts || res.results)) || [];
                const contacts = rawContacts.filter(c => !activeContactPersonIds.has(c.id));

                if (contacts.length === 0) {
                    const msg = rawContacts.length > 0
                        ? `Las personas encontradas ya cuentan con una relación laboral activa en esta cuenta.`
                        : `No se encontraron personas con "${_deps.esc(q)}".`;
                    resultsBox.innerHTML = `
                        <div style="padding:1rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
                            ${msg}
                            <button type="button" class="btn-secondary" style="margin-left: 8px; font-size: 0.78rem; padding: 3px 8px;" onclick="ContactsUI.openCreatePersonView()">+ Crear Nueva Persona</button>
                        </div>
                    `;
                    return;
                }

                let html = `<div style="max-height: 240px; overflow-y: auto; display:flex; flex-direction:column; gap:6px; padding:6px;">`;
                contacts.forEach(c => {
                    const name = `${c.nombres || ''} ${c.apellidos || ''}`.trim() || 'Sin nombre';
                    const details = [c.correo, c.telefono].filter(Boolean).join(' • ');
                    html += `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.85rem; background:rgba(255,255,255,0.03); border:1px solid var(--panel-border); border-radius:6px;">
                            <div>
                                <div style="font-weight:600; color:white; font-size:0.88rem;">${_deps.esc(name)}</div>
                                <div style="font-size:0.76rem; color:var(--text-muted);">${_deps.esc(details || 'Sin medios de contacto')}</div>
                            </div>
                            <button type="button" class="btn-primary" style="padding:0.3rem 0.75rem; font-size:0.78rem;" onclick='ContactsUI.selectPersonForLinking(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
                                Seleccionar
                            </button>
                        </div>
                    `;
                });
                html += `</div>`;
                resultsBox.innerHTML = html;
            } catch (err) {
                console.error('[ContactsUI] Search error:', err);
                resultsBox.innerHTML = `<div style="padding:0.75rem; color:var(--danger); font-size:0.82rem; text-align: center;">Error al buscar personas.</div>`;
            }
        }, 300);
    }

    function selectPersonForLinking(person) {
        selectedPersonForLinking = person;
        updateSelectedPersonBox();
    }

    function updateSelectedPersonBox() {
        const box = document.getElementById('selected-person-preview-fs') || document.getElementById('selected-person-preview');
        const fields = document.getElementById('link-existing-relation-fields-fs') || document.getElementById('link-existing-relation-fields');
        if (!box) return;

        if (!selectedPersonForLinking) {
            box.innerHTML = `<div style="padding:0.8rem; background:rgba(0,0,0,0.15); border-radius:6px; border:1px dashed var(--panel-border); color:var(--text-muted); font-size:0.85rem; text-align:center;">Ninguna persona seleccionada aún. Utiliza el buscador superior.</div>`;
            if (fields) fields.style.display = 'none';
        } else {
            const name = `${selectedPersonForLinking.nombres || ''} ${selectedPersonForLinking.apellidos || ''}`.trim() || 'Sin nombre';
            const details = [selectedPersonForLinking.correo, selectedPersonForLinking.telefono].filter(Boolean).join(' • ');
            box.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem 1rem; background:rgba(255,204,77,0.08); border-radius:6px; border:1px solid rgba(255,204,77,0.3);">
                    <div>
                        <span style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--brand-gold); font-weight:700;">Persona Seleccionada</span>
                        <div style="font-weight:600; color:white; font-size:0.95rem;">${_deps.esc(name)}</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary);">${_deps.esc(details || 'Sin datos de contacto personal')}</div>
                    </div>
                    <button type="button" class="btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.78rem;" onclick="ContactsUI.selectPersonForLinking(null)">Cambiar</button>
                </div>
            `;
            if (fields) fields.style.display = 'block';
        }
    }

    async function submitLinkContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            notify('error', 'El servicio de contactos no está disponible');
            return;
        }

        if (!selectedPersonForLinking || !selectedPersonForLinking.id) {
            setStatusBanner('link-contact-status', 'warning', 'Debes buscar y seleccionar una persona registrada para continuar.');
            return;
        }

        const cargo = ((document.getElementById('link-exist-cargo-fs') || document.getElementById('link-exist-cargo') || {}).value || '').trim();
        const telCorp = ((document.getElementById('link-exist-tel-corp-fs') || document.getElementById('link-exist-tel-corp') || {}).value || '').trim();
        const ext = ((document.getElementById('link-exist-ext-fs') || document.getElementById('link-exist-ext') || {}).value || '').trim();
        const correoCorp = ((document.getElementById('link-exist-correo-corp-fs') || document.getElementById('link-exist-correo-corp') || {}).value || '').trim();

        if (!cargo) {
            setStatusBanner('link-contact-status', 'warning', 'El cargo en la empresa es obligatorio.');
            return;
        }

        setStatusBanner('link-contact-status', 'loading', 'Vinculando persona a la cuenta...');

        try {
            await crmContacts.linkContactToAccount(fb, {
                accountId: activeAccountId,
                contactId: selectedPersonForLinking.id,
                cargo,
                telefono_corporativo: telCorp,
                extension: ext,
                correo_corporativo: correoCorp,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('link-contact-status', 'success', 'Persona vinculada a la cuenta exitosamente. Regresando...');
            notify('success', 'Persona vinculada a la cuenta exitosamente.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error linking contact:', err);
            setStatusBanner('link-contact-status', 'error', err.message || 'Error al vincular el contacto.');
            notify('error', err.message || 'Error al vincular el contacto.');
        }
    }

    // =========================================================================
    // 5. VISTA FULL-SCREEN: EDITAR CARGO Y DATOS CORPORATIVOS
    // =========================================================================

    function openEditAccountContactView(accountContactId) {
        const item = currentContactsList.find(c => c.id === accountContactId);
        if (!item) return;

        targetAccountContactForAction = item;
        _deps.showView('edit-account-contact-view');

        const p = item.person || item.persona || {};
        const nameEl = document.getElementById('edit-acc-contact-person-name');
        if (nameEl) nameEl.textContent = `${p.nombres || ''} ${p.apellidos || ''}`.trim() || 'Contacto';

        const accNameEl = document.getElementById('edit-acc-contact-account-name');
        if (accNameEl) accNameEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        setVal('edit-acc-cargo', item.cargo);
        setVal('edit-acc-tel-corp', item.telefono_corporativo);
        setVal('edit-acc-ext', item.extension);
        setVal('edit-acc-correo-corp', item.correo_corporativo);

        setStatusBanner('edit-account-contact-status', null);
    }

    async function submitEditAccountContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        const cargo = ((document.getElementById('edit-acc-cargo') || {}).value || '').trim();
        const telCorp = ((document.getElementById('edit-acc-tel-corp') || {}).value || '').trim();
        const ext = ((document.getElementById('edit-acc-ext') || {}).value || '').trim();
        const correoCorp = ((document.getElementById('edit-acc-correo-corp') || {}).value || '').trim();

        if (!cargo) {
            setStatusBanner('edit-account-contact-status', 'warning', 'El cargo es obligatorio.');
            return;
        }

        setStatusBanner('edit-account-contact-status', 'loading', 'Actualizando cargo y datos corporativos...');

        try {
            await crmContacts.updateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                cargo,
                telefono_corporativo: telCorp,
                extension: ext,
                correo_corporativo: correoCorp,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('edit-account-contact-status', 'success', 'Relación con la cuenta actualizada exitosamente. Regresando...');
            notify('success', 'Relación con la cuenta actualizada exitosamente.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error updating account contact:', err);
            setStatusBanner('edit-account-contact-status', 'error', err.message || 'Error al actualizar la relación.');
            notify('error', err.message || 'Error al actualizar la relación.');
        }
    }

    // =========================================================================
    // 6. VISTA FULL-SCREEN: BAJA DE CONTACTO (CIERRE DE PERÍODO VIGENTE)
    // =========================================================================

    function openDeactivateContactView(accountContactId, personName) {
        targetAccountContactForAction = { id: accountContactId, personName };
        _deps.showView('deactivate-account-contact-view');

        const nameEl = document.getElementById('deact-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const accEl = document.getElementById('deact-contact-account-name');
        if (accEl) accEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';

        const motiveInput = document.getElementById('deact-contact-motive');
        if (motiveInput) motiveInput.value = '';

        setStatusBanner('deact-contact-status', null);
    }

    async function submitDeactivateContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const motive = ((document.getElementById('deact-contact-motive') || {}).value || '').trim();
        if (!motive) {
            setStatusBanner('deact-contact-status', 'warning', 'Debes ingresar el motivo obligatorio de salida para cerrar el período laboral.');
            return;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        setStatusBanner('deact-contact-status', 'loading', 'Registrando baja y cerrando período...');

        try {
            await crmContacts.deactivateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                motivo_salida: motive,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('deact-contact-status', 'success', 'Contacto dado de baja y período cerrado correctamente. Regresando...');
            notify('success', 'Contacto dado de baja y período cerrado correctamente.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error deactivating contact:', err);
            setStatusBanner('deact-contact-status', 'error', err.message || 'Error al registrar la baja.');
            notify('error', err.message || 'Error al registrar la baja.');
        }
    }

    // =========================================================================
    // 7. VISTA FULL-SCREEN: REACTIVACIÓN DE CONTACTO (NUEVO PERÍODO HISTÓRICO)
    // =========================================================================

    function openReactivateContactView(accountContactId, personName) {
        const item = currentContactsList.find(c => c.id === accountContactId) || { id: accountContactId };
        targetAccountContactForAction = { id: accountContactId, personName, item };

        _deps.showView('reactivate-account-contact-view');

        const nameEl = document.getElementById('react-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const accEl = document.getElementById('react-contact-account-name');
        if (accEl) accEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        setVal('react-contact-cargo', item.cargo || '');
        setVal('react-contact-motive', '');
        setVal('react-contact-tel-corp', item.telefono_corporativo || '');
        setVal('react-contact-ext', item.extension || '');
        setVal('react-contact-correo-corp', item.correo_corporativo || '');

        setStatusBanner('react-contact-status', null);
    }

    async function submitReactivateContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const cargo = ((document.getElementById('react-contact-cargo') || {}).value || '').trim();
        const motive = ((document.getElementById('react-contact-motive') || {}).value || '').trim();
        const telCorp = ((document.getElementById('react-contact-tel-corp') || {}).value || '').trim();
        const ext = ((document.getElementById('react-contact-ext') || {}).value || '').trim();
        const correoCorp = ((document.getElementById('react-contact-correo-corp') || {}).value || '').trim();

        if (!cargo) {
            setStatusBanner('react-contact-status', 'warning', 'El nuevo cargo para el período vigente es obligatorio.');
            return;
        }
        if (!motive) {
            setStatusBanner('react-contact-status', 'warning', 'El motivo de reingreso es obligatorio.');
            return;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        setStatusBanner('react-contact-status', 'loading', 'Reactivando relación y abriendo nuevo período...');

        try {
            await crmContacts.reactivateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                cargo,
                motivo_reingreso: motive,
                telefono_corporativo: telCorp,
                extension: ext,
                correo_corporativo: correoCorp,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('react-contact-status', 'success', 'Contacto reactivado con nuevo período abierto exitosamente. Regresando...');
            notify('success', 'Contacto reactivado con nuevo período abierto exitosamente.');

            setTimeout(() => {
                cancelContactOperation();
            }, 400);
        } catch (err) {
            console.error('[ContactsUI] Error reactivating contact:', err);
            setStatusBanner('react-contact-status', 'error', err.message || 'Error al reactivar el contacto.');
            notify('error', err.message || 'Error al reactivar el contacto.');
        }
    }

    // =========================================================================
    // 8. VISTA FULL-SCREEN: HISTORIAL DE CARGOS Y PERÍODOS (periods_prod)
    // =========================================================================

    async function openContactPeriodsView(accountContactId, personName) {
        _deps.showView('contact-periods-view');

        const nameEl = document.getElementById('periods-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const accountEl = document.getElementById('periods-contact-account-name');
        if (accountEl) {
            accountEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '-';
        }

        const container = document.getElementById('periods-list-container');
        if (container) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2.5rem; color: var(--text-secondary);">
                    <div class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid rgba(56,189,248,0.2); border-top-color:#38bdf8; border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                    <p style="margin-top: 0.75rem; font-size: 0.88rem;">Cargando historial cronológico de períodos...</p>
                </div>
            `;
        }

        setStatusBanner('periods-view-status', null);

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb || !container) return;

        try {
            const res = await crmContacts.listContactPeriods(fb, {
                accountContactId,
                dbSuffix: _deps.getDbSuffix()
            });

            const periods = (res && res.periods) || [];
            if (periods.length === 0) {
                container.innerHTML = `
                    <div class="table-empty-box" style="padding: 2.5rem; text-align: center; background: rgba(0,0,0,0.15); border: 1px dashed var(--panel-border); border-radius: 8px;">
                        <div class="icon" style="font-size: 2.2rem; margin-bottom: 0.5rem;">🕒</div>
                        <h3 style="color: white; margin-bottom: 0.3rem;">Sin períodos registrados</h3>
                        <p style="color: var(--text-muted); font-size: 0.85rem;">No se encontraron registros de períodos laborales para esta relación persona-cuenta.</p>
                    </div>
                `;
                return;
            }

            let html = `<div class="timeline-container" style="display:flex; flex-direction:column; gap:14px; max-height:550px; overflow-y:auto; padding:4px;">`;
            periods.forEach((p, idx) => {
                const isOpen = !p.fecha_fin;
                const periodNum = periods.length - idx;
                const statusBadge = isOpen
                    ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:var(--success); border:1px solid rgba(16,185,129,0.3); font-weight:600; font-size:0.75rem;">🟢 Vigente / Abierto</span>`
                    : `<span class="badge" style="background:rgba(107,114,128,0.2); color:var(--text-muted); border:1px solid rgba(107,114,128,0.3); font-size:0.75rem;">⚫ Cerrado</span>`;

                const startStr = _deps.formatDate(p.fecha_inicio);
                const endStr = isOpen ? '<strong style="color:var(--success);">Presente</strong>' : _deps.formatDate(p.fecha_fin);

                let motivesHtml = '';
                if (p.motivo_reingreso) {
                    motivesHtml += `<div style="font-size:0.82rem; color:#38bdf8; margin-top:6px; background: rgba(56,189,248,0.06); padding: 4px 8px; border-radius: 4px;"><strong>Motivo de reingreso:</strong> ${_deps.esc(p.motivo_reingreso)}</div>`;
                }
                if (p.motivo_salida) {
                    motivesHtml += `<div style="font-size:0.82rem; color:var(--danger); margin-top:6px; background: rgba(239,68,68,0.06); padding: 4px 8px; border-radius: 4px;"><strong>Motivo de salida:</strong> ${_deps.esc(p.motivo_salida)}</div>`;
                }

                html += `
                    <div class="glass-panel" style="padding:1.15rem; border-left: 4px solid ${isOpen ? 'var(--success)' : 'var(--text-muted)'}; background:rgba(255,255,255,0.03); border-radius: 8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span style="font-weight:700; color:var(--brand-gold); font-size:0.9rem;">Período #${periodNum}</span>
                                <span style="color:var(--text-secondary); font-size:0.85rem;">(${startStr} — ${endStr})</span>
                            </div>
                            <div>${statusBadge}</div>
                        </div>
                        <div style="font-weight:600; color:white; font-size:1rem; margin-bottom:0.35rem;">
                            Cargo: <span style="color:var(--brand-gold);">${_deps.esc(p.cargo || '-')}</span>
                        </div>
                        ${motivesHtml}
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; display:flex; justify-content:space-between; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px;">
                            <span>Registrado por: ${_deps.esc(p.createdBy || 'Sistema')}</span>
                            <span>Fecha reg: ${_deps.formatDateTime(p.createdAt)}</span>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
            container.innerHTML = html;
        } catch (err) {
            console.error('[ContactsUI] Error loading periods:', err);
            container.innerHTML = `
                <div class="table-empty-box" style="color: var(--danger);">
                    <p>${_deps.esc(err.message || 'Error al recuperar los períodos.')}</p>
                </div>
            `;
        }
    }

    // =========================================================================
    // 9. ALIAS DE RETROCOMPATIBILIDAD (MODALES -> VISTAS FULL-SCREEN)
    // =========================================================================

    function openAccountContactsModal(accountId) {
        return openAccountContactsView(accountId);
    }

    function closeAccountContactsModal() {
        return returnToClientsView();
    }

    function openLinkContactModal(accountId) {
        return openLinkContactView(accountId);
    }

    function closeLinkContactModal() {
        return cancelContactOperation();
    }

    function openEditAccountContactModal(accountContactId) {
        return openEditAccountContactView(accountContactId);
    }

    function closeEditAccountContactModal() {
        return cancelContactOperation();
    }

    function openDeactivateContactModal(accountContactId, personName) {
        return openDeactivateContactView(accountContactId, personName);
    }

    function closeDeactivateContactModal() {
        return cancelContactOperation();
    }

    function openReactivateContactModal(accountContactId, personName) {
        return openReactivateContactView(accountContactId, personName);
    }

    function closeReactivateContactModal() {
        return cancelContactOperation();
    }

    function openContactPeriodsModal(accountContactId, personName) {
        return openContactPeriodsView(accountContactId, personName);
    }

    function closeContactPeriodsModal() {
        return cancelContactOperation();
    }

    // Retorno de API pública
    return {
        // Vistas principales full-screen
        openAccountContactsView,
        closeAccountContactsView: returnToClientsView,
        returnToClientsView,
        cancelContactOperation,

        openCreatePersonView,
        submitCreatePerson,

        openEditPersonView,
        submitEditPerson,

        openLinkContactView,
        closeLinkContactView: cancelContactOperation,
        setLinkContactMode: (mode) => {
            if (mode === 'create') openCreatePersonView(activeAccountId);
            else openLinkContactView(activeAccountId);
        },
        onPersonSearchInput,
        selectPersonForLinking,
        submitLinkContact,

        openEditAccountContactView,
        closeEditAccountContactView: cancelContactOperation,
        submitEditAccountContact,

        openDeactivateContactView,
        closeDeactivateContactView: cancelContactOperation,
        submitDeactivateContact,

        openReactivateContactView,
        closeReactivateContactView: cancelContactOperation,
        submitReactivateContact,

        openContactPeriodsView,
        closeContactPeriodsView: cancelContactOperation,
        toggleInactiveContactsFilter,

        // Alias de retrocompatibilidad
        openAccountContactsModal,
        closeAccountContactsModal,
        openLinkContactModal,
        closeLinkContactModal,
        openEditAccountContactModal,
        closeEditAccountContactModal,
        openDeactivateContactModal,
        closeDeactivateContactModal,
        openReactivateContactModal,
        closeReactivateContactModal,
        openContactPeriodsModal,
        closeContactPeriodsModal
    };
});
