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

            // B6: Directorio Global de Contactos y Contacto 360
            window.openGlobalContactsView = api.openGlobalContactsView;
            window.loadGlobalContactsDirectory = api.loadGlobalContactsDirectory;
            window.onGlobalContactsSearch = api.onGlobalContactsSearch;
            window.renderGlobalContactsTable = api.renderGlobalContactsTable;
            window.openCreatePersonFromGlobal = api.openCreatePersonFromGlobal;
            window.openContact360View = api.openContact360View;
            window.closeContact360View = api.closeContact360View;
            window.openLinkContactFromContact360 = api.openLinkContactFromContact360;

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

    // B6: Estado del Directorio Global de Contactos y Contacto 360
    let globalContactsDirectoryList = [];
    let globalContactsSearchQuery = '';
    let globalContactsSearchTimer = null;
    let activeContact360Id = null;
    let activeContact360Data = null;
    let contact360OriginContext = null; // { viewId: 'contacts-view' | 'client-detail-view', accountId: null }
    let originFromGlobalContacts = false;

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
            loading: { bg: 'var(--ds-info-bg, #EFF6FF)', border: 'var(--ds-info-border, #BFDBFE)', text: 'var(--ds-info, #0284C7)', icon: '⏳' },
            success: { bg: 'var(--ds-success-bg, #ECFDF5)', border: 'var(--ds-success-border, #A7F3D0)', text: 'var(--ds-success, #059669)', icon: '✅' },
            error: { bg: 'var(--ds-danger-bg, #FEF2F2)', border: 'var(--ds-danger-border, #FECACA)', text: 'var(--ds-danger, #DC2626)', icon: '⚠️' },
            warning: { bg: 'var(--ds-warning-bg, #FFFBEB)', border: 'var(--ds-warning-border, #FDE68A)', text: 'var(--ds-warning, #D97706)', icon: '⚠️' }
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
        originFromGlobalContacts = false;
        _deps.showView('clients-view');
    }

    function cancelContactOperation() {
        if (originFromGlobalContacts) {
            originFromGlobalContacts = false;
            if (activeContact360Id) {
                openContact360View(activeContact360Id, contact360OriginContext || {});
            } else {
                openGlobalContactsView();
            }
            return;
        }
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
                <div class="table-empty-box" style="padding: 3rem 1.5rem; text-align: center; background: var(--ds-bg-subtle, #F8FAFC); border: 1px dashed var(--ds-border, #CBD5E1); border-radius: 8px;">
                    <div class="icon" style="font-size:2.5rem; opacity:0.6; margin-bottom: 0.5rem;">👥</div>
                    <h3 style="font-size:1.1rem; color:var(--ds-text-primary, #0F172A); margin-bottom:0.4rem;">No hay personas vinculadas a esta cuenta</h3>
                    <p style="font-size:0.88rem; color:var(--ds-text-muted, #64748B); margin-bottom: 1.25rem;">Vincula contactos existentes o crea una nueva persona bajo el modelo Hub &amp; Spoke.</p>
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
                        <tr style="background: var(--ds-bg-subtle, #F8FAFC); border-bottom: 1px solid var(--ds-border, #CBD5E1);">
                            <th style="width: 24%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--ds-text-secondary, #334155); text-transform: uppercase;">Persona</th>
                            <th style="width: 19%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--ds-text-secondary, #334155); text-transform: uppercase;">Cargo Actual</th>
                            <th style="width: 21%; padding: 0.85rem 1rem; text-align: left; font-size: 0.82rem; color: var(--ds-text-secondary, #334155); text-transform: uppercase;">Contacto Corporativo</th>
                            <th style="width: 11%; padding: 0.85rem 1rem; text-align: center; font-size: 0.82rem; color: var(--ds-text-secondary, #334155); text-transform: uppercase;">Estado</th>
                            <th style="width: 25%; padding: 0.85rem 1rem; text-align: right; font-size: 0.82rem; color: var(--ds-text-secondary, #334155); text-transform: uppercase;">Acciones</th>
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
                ? `<span class="ds-badge ds-badge-success">🟢 Activo</span>`
                : `<span class="ds-badge ds-badge-neutral">⚫ Inactivo</span>`;

            const periodsBadge = `<span class="ds-badge ds-badge-primary" style="font-size:0.7rem; margin-left:6px;">${ac.total_periodos || 1} ${(ac.total_periodos || 1) === 1 ? 'período' : 'períodos'}</span>`;

            // Contacto corporativo
            const phoneParts = [];
            if (ac.telefono_corporativo) {
                phoneParts.push(`<span title="Teléfono corporativo" style="color:var(--ds-text-primary, #0F172A);">📞 ${_deps.esc(ac.telefono_corporativo)}${ac.extension ? ` (Ext. ${_deps.esc(ac.extension)})` : ''}</span>`);
            }
            if (p.telefono && !ac.telefono_corporativo) {
                phoneParts.push(`<span style="color:var(--ds-text-muted, #64748B);" title="Teléfono personal">📱 ${_deps.esc(p.telefono)}</span>`);
            }

            const emailParts = [];
            if (ac.correo_corporativo) {
                emailParts.push(`<a href="mailto:${_deps.esc(ac.correo_corporativo)}" style="color:var(--ds-primary, #0062B8); text-decoration:none;" title="Correo corporativo">✉️ ${_deps.esc(ac.correo_corporativo)}</a>`);
            }
            if (p.correo && !ac.correo_corporativo) {
                emailParts.push(`<a href="mailto:${_deps.esc(p.correo)}" style="color:var(--ds-text-muted, #64748B); text-decoration:none;" title="Correo personal">✉️ ${_deps.esc(p.correo)}</a>`);
            }

            const contactCell = (phoneParts.length || emailParts.length)
                ? `<div style="display:flex; flex-direction:column; gap:2px; font-size:0.8rem;">
                    ${phoneParts.join('')}
                    ${emailParts.join('')}
                   </div>`
                : `<span style="color:var(--ds-text-muted, #64748B); font-size:0.8rem;">-</span>`;

            // Metadatos de identidad personal
            const personalMeta = [];
            if (p.telefono && ac.telefono_corporativo) personalMeta.push(`Tel. pers: ${_deps.esc(p.telefono)}`);
            if (p.correo && ac.correo_corporativo) personalMeta.push(`Correo pers: ${_deps.esc(p.correo)}`);
            const personalSub = personalMeta.length ? `<div style="font-size:0.72rem; color:var(--ds-text-muted, #64748B); margin-top:2px;">${personalMeta.join(' | ')}</div>` : '';

            // Botones de acción según estado
            let actionButtons = `
                <button type="button" class="btn-table-action" onclick="ContactsUI.openContact360View('${personId}', { originView: 'account-contacts-view', accountId: '${activeAccountId}' })" title="Abrir Ficha Contacto 360">
                    👤 360
                </button>
                <button type="button" class="btn-table-action" onclick="ContactsUI.openContactPeriodsView('${ac.id}', '${_deps.esc(fullName)}')" title="Ver historial cronológico de períodos">
                    🕒 Historial
                </button>
                <button type="button" class="btn-table-action" onclick="ContactsUI.openEditPersonView('${personId}', '${ac.id}')" title="Modificar datos personales de la identidad física">
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
                    <button type="button" class="btn-table-action" onclick="ContactsUI.openReactivateContactView('${ac.id}', '${_deps.esc(fullName)}')" title="Reactivar persona en esta cuenta con un nuevo período">
                        🔄 Reactivar
                    </button>
                `;
            }

            html += `
                <tr style="border-bottom:1px solid var(--ds-border, #CBD5E1); ${!isActive ? 'opacity:0.68;' : ''}">
                    <td style="padding: 0.85rem 1rem;">
                        <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-size:0.9rem;">${_deps.esc(fullName)}</div>
                        ${personalSub}
                    </td>
                    <td style="padding: 0.85rem 1rem;">
                        <div style="font-weight:600; color:var(--ds-primary, #0062B8); font-size:0.88rem;">${_deps.esc(ac.cargo || '-')}</div>
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
        if (accountId !== undefined) {
            activeAccountId = accountId || null;
        }
        const allClients = _deps.getClients();
        if (activeAccountId) {
            activeAccountData = allClients.find(c => c.id === activeAccountId) || { id: activeAccountId };
            originFromGlobalContacts = false;
        } else {
            activeAccountData = null;
        }

        _deps.showView('create-person-view');

        // Reset form first so subsequent checkbox states stick
        const form = document.getElementById('form-create-person');
        if (form && typeof form.reset === 'function') form.reset();

        const contextNameEl = document.getElementById('create-person-account-context-name');
        if (contextNameEl) {
            contextNameEl.textContent = activeAccountData ? getAccountDisplayName(activeAccountData) : '(Directorio Global de Contactos — Sin cuenta obligatoria)';
        }

        const linkBox = document.getElementById('create-person-link-box');
        const accountFields = document.getElementById('create-person-account-fields');
        const linkNowCheck = document.getElementById('create-person-link-now');
        const globalAccSelectorWrap = document.getElementById('create-person-global-account-selector-wrap');
        const globalAccSelect = document.getElementById('create-person-global-account-select');

        if (globalAccSelect) {
            let opts = `<option value="">-- Selecciona Cuenta Comercial --</option>`;
            allClients.filter(c => c && !c.eliminado).forEach(c => {
                opts += `<option value="${_deps.esc(c.id)}">${_deps.esc(getAccountDisplayName(c))} (${_deps.esc(c.id)})</option>`;
            });
            globalAccSelect.innerHTML = opts;
        }

        if (activeAccountId) {
            if (linkBox) linkBox.style.display = 'block';
            if (linkNowCheck) linkNowCheck.checked = true;
            if (accountFields) accountFields.style.display = 'block';
            if (globalAccSelectorWrap) globalAccSelectorWrap.style.display = 'none';
        } else {
            if (linkBox) linkBox.style.display = 'block';
            if (linkNowCheck) linkNowCheck.checked = false;
            if (accountFields) accountFields.style.display = 'none';
            if (globalAccSelectorWrap) globalAccSelectorWrap.style.display = 'block';
        }

        setStatusBanner('create-person-status', null);
    }

    function openCreatePersonFromGlobal() {
        originFromGlobalContacts = true;
        activeAccountId = null;
        activeAccountData = null;
        activeContact360Id = null;
        openCreatePersonView(null);
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
        const selectedGlobalAccId = ((document.getElementById('create-person-global-account-select') || {}).value || '').trim();
        const targetAccountId = activeAccountId || selectedGlobalAccId || null;
        const willLinkNow = Boolean(linkNowCheck && linkNowCheck.checked);

        let cargo = '';
        let telCorp = '';
        let ext = '';
        let correoCorp = '';

        if (willLinkNow) {
            if (!targetAccountId) {
                setStatusBanner('create-person-status', 'warning', 'Selecciona la cuenta comercial a la que deseas vincular esta persona.');
                return;
            }
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

            if (willLinkNow && targetAccountId) {
                setStatusBanner('create-person-status', 'loading', 'Vinculando persona a la cuenta seleccionada...');
                await crmContacts.linkContactToAccount(fb, {
                    accountId: targetAccountId,
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
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.85rem; background:var(--ds-bg-surface, #FFFFFF); border:1px solid var(--ds-border, #CBD5E1); border-radius:6px;">
                            <div>
                                <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-size:0.88rem;">${_deps.esc(name)}</div>
                                <div style="font-size:0.76rem; color:var(--ds-text-muted, #64748B);">${_deps.esc(details || 'Sin medios de contacto')}</div>
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
                resultsBox.innerHTML = `<div style="padding:0.75rem; color:var(--ds-danger, #DC2626); font-size:0.82rem; text-align: center;">Error al buscar personas.</div>`;
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
            box.innerHTML = `<div style="padding:0.8rem; background:var(--ds-bg-subtle, #F8FAFC); border-radius:6px; border:1px dashed var(--ds-border, #CBD5E1); color:var(--ds-text-muted, #64748B); font-size:0.85rem; text-align:center;">Ninguna persona seleccionada aún. Utiliza el buscador superior.</div>`;
            if (fields) fields.style.display = 'none';
        } else {
            const name = `${selectedPersonForLinking.nombres || ''} ${selectedPersonForLinking.apellidos || ''}`.trim() || 'Sin nombre';
            const details = [selectedPersonForLinking.correo, selectedPersonForLinking.telefono].filter(Boolean).join(' • ');
            box.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem 1rem; background:var(--ds-primary-subtle, #EBF4FF); border-radius:6px; border:1px solid var(--ds-primary-border, #BFDBFE);">
                    <div>
                        <span style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--ds-primary, #0062B8); font-weight:700;">Persona Seleccionada</span>
                        <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-size:0.95rem;">${_deps.esc(name)}</div>
                        <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155);">${_deps.esc(details || 'Sin datos de contacto personal')}</div>
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
                    <div class="table-empty-box" style="padding: 2.5rem; text-align: center; background: var(--ds-bg-subtle, #F8FAFC); border: 1px dashed var(--ds-border, #CBD5E1); border-radius: 8px;">
                        <div class="icon" style="font-size: 2.2rem; margin-bottom: 0.5rem;">🕒</div>
                        <h3 style="color: var(--ds-text-primary, #0F172A); margin-bottom: 0.3rem;">Sin períodos registrados</h3>
                        <p style="color: var(--ds-text-muted, #64748B); font-size: 0.85rem;">No se encontraron registros de períodos laborales para esta relación persona-cuenta.</p>
                    </div>
                `;
                return;
            }

            let html = `<div class="timeline-container" style="display:flex; flex-direction:column; gap:14px; max-height:550px; overflow-y:auto; padding:4px;">`;
            periods.forEach((p, idx) => {
                const isOpen = !p.fecha_fin;
                const periodNum = periods.length - idx;
                const statusBadge = isOpen
                    ? `<span class="ds-badge ds-badge-success">🟢 Vigente / Abierto</span>`
                    : `<span class="ds-badge ds-badge-neutral">⚫ Cerrado</span>`;

                const startStr = _deps.formatDate(p.fecha_inicio);
                const endStr = isOpen ? '<strong style="color:var(--ds-success, #059669);">Presente</strong>' : _deps.formatDate(p.fecha_fin);

                let motivesHtml = '';
                if (p.motivo_reingreso) {
                    motivesHtml += `<div style="font-size:0.82rem; color:var(--ds-info, #0284C7); margin-top:6px; background: var(--ds-info-bg, #EFF6FF); border:1px solid var(--ds-info-border, #BFDBFE); padding: 4px 8px; border-radius: 4px;"><strong>Motivo de reingreso:</strong> ${_deps.esc(p.motivo_reingreso)}</div>`;
                }
                if (p.motivo_salida) {
                    motivesHtml += `<div style="font-size:0.82rem; color:var(--ds-danger, #DC2626); margin-top:6px; background: var(--ds-danger-bg, #FEF2F2); border:1px solid var(--ds-danger-border, #FECACA); padding: 4px 8px; border-radius: 4px;"><strong>Motivo de salida:</strong> ${_deps.esc(p.motivo_salida)}</div>`;
                }

                html += `
                    <div class="glass-panel" style="padding:1.15rem; border-left: 4px solid ${isOpen ? 'var(--ds-success, #059669)' : 'var(--ds-text-muted, #64748B)'}; background:var(--ds-bg-surface, #FFFFFF); border-radius: 8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span style="font-weight:700; color:var(--ds-primary, #0062B8); font-size:0.9rem;">Período #${periodNum}</span>
                                <span style="color:var(--ds-text-secondary, #334155); font-size:0.85rem;">(${startStr} — ${endStr})</span>
                            </div>
                            <div>${statusBadge}</div>
                        </div>
                        <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-size:1rem; margin-bottom:0.35rem;">
                            Cargo: <span style="color:var(--ds-primary, #0062B8);">${_deps.esc(p.cargo || '-')}</span>
                        </div>
                        ${motivesHtml}
                        <div style="font-size:0.75rem; color:var(--ds-text-muted, #64748B); margin-top:8px; display:flex; justify-content:space-between; border-top: 1px solid var(--ds-border, #CBD5E1); padding-top: 6px;">
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
                <div class="table-empty-box" style="color: var(--ds-danger, #DC2626);">
                    <p>${_deps.esc(err.message || 'Error al recuperar los períodos.')}</p>
                </div>
            `;
        }
    }

    // =========================================================================
    // 8B. B6: MÓDULO GLOBAL INDEPENDIENTE DE CONTACTOS Y CONTACTO 360
    // =========================================================================

    function openGlobalContactsView() {
        originFromGlobalContacts = false;
        activeContact360Id = null;
        _deps.showView('contacts-view');
    }

    async function loadGlobalContactsDirectory(forceRefresh = false) {
        const container = document.getElementById('global-contacts-table-container');
        if (!container) return;

        if (!forceRefresh && Array.isArray(globalContactsDirectoryList) && globalContactsDirectoryList.length > 0) {
            _updateGlobalContactsKpis();
            renderGlobalContactsTable();
            return;
        }

        container.innerHTML = `
            <div style="padding: 2.5rem; text-align: center; color: var(--ds-text-secondary, #334155);">
                <div class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid rgba(0,98,184,0.2); border-top-color:var(--ds-primary, #0062B8); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                <p style="margin-top: 0.75rem; font-size: 0.88rem;">Cargando directorio global de personas y relaciones multiempresa...</p>
            </div>
        `;
        setStatusBanner('global-contacts-status', null);

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            container.innerHTML = `<div style="padding:2rem; text-align:center; color:var(--ds-text-muted, #64748B);">El servicio de contactos no está disponible en este momento.</div>`;
            return;
        }

        try {
            const res = await crmContacts.searchContacts(fb, {
                q: '',
                limit: 200,
                includeRelations: true,
                dbSuffix: _deps.getDbSuffix()
            });
            globalContactsDirectoryList = Array.isArray(res && res.results) ? res.results : (Array.isArray(res && res.contacts) ? res.contacts : []);
            _updateGlobalContactsKpis();
            renderGlobalContactsTable();
        } catch (err) {
            console.error('[ContactsUI] Error loading global contacts directory:', err);
            setStatusBanner('global-contacts-status', 'error', err.message || 'No se pudo cargar el directorio global de contactos.');
            container.innerHTML = `
                <div style="padding:2rem; text-align:center; color:var(--ds-danger, #DC2626);">
                    <p style="margin-bottom:0.75rem;">${_deps.esc(err.message || 'Error al cargar el directorio global de contactos.')}</p>
                    <button type="button" class="btn-secondary" onclick="ContactsUI.loadGlobalContactsDirectory(true)">Reintentar</button>
                </div>
            `;
        }
    }

    function _updateGlobalContactsKpis() {
        const list = Array.isArray(globalContactsDirectoryList) ? globalContactsDirectoryList : [];
        const totalCount = list.length;
        let linkedCount = 0;
        let multiCount = 0;
        let oppsCount = 0;

        list.forEach(item => {
            const activeAccounts = Number(item.activeAccountCount) || (Array.isArray(item.accountRelations) ? item.accountRelations.filter(r => r.activo).length : 0);
            const totalAccounts = Number(item.totalAccountCount) || (Array.isArray(item.accountRelations) ? item.accountRelations.length : 0);
            const opps = Number(item.opportunityCount) || 0;
            if (activeAccounts > 0) linkedCount++;
            if (totalAccounts >= 2) multiCount++;
            if (opps > 0) oppsCount++;
        });

        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val);
        };
        setEl('global-contacts-kpi-total', totalCount);
        setEl('global-contacts-kpi-linked', linkedCount);
        setEl('global-contacts-kpi-multi', multiCount);
        setEl('global-contacts-kpi-opps', oppsCount);
    }

    function onGlobalContactsSearch(val) {
        globalContactsSearchQuery = String(val || '').trim().toLowerCase();
        if (globalContactsSearchTimer) clearTimeout(globalContactsSearchTimer);
        globalContactsSearchTimer = setTimeout(() => {
            renderGlobalContactsTable();
        }, 120);
    }

    function renderGlobalContactsTable() {
        const container = document.getElementById('global-contacts-table-container');
        if (!container) return;

        const filterSelect = document.getElementById('global-contacts-filter-link');
        const filterMode = filterSelect ? filterSelect.value : 'all';
        const q = (globalContactsSearchQuery || '').trim().toLowerCase();
        const allClients = _deps.getClients();
        const clientMap = new Map();
        allClients.forEach(c => { if (c && c.id) clientMap.set(c.id, getAccountDisplayName(c)); });

        const list = (Array.isArray(globalContactsDirectoryList) ? globalContactsDirectoryList : []).filter(item => {
            const rels = Array.isArray(item.accountRelations) ? item.accountRelations : [];
            const activeAccounts = Number(item.activeAccountCount) || rels.filter(r => r.activo).length;
            const totalAccounts = Number(item.totalAccountCount) || rels.length;
            const opps = Number(item.opportunityCount) || 0;

            if (filterMode === 'linked' && activeAccounts === 0) return false;
            if (filterMode === 'multi' && totalAccounts < 2) return false;
            if (filterMode === 'with_opps' && opps === 0) return false;
            if (filterMode === 'unlinked' && activeAccounts > 0) return false;

            if (!q) return true;
            const relSearchStr = rels.map(r => `${r.cargo || ''} ${r.correo_corporativo || ''} ${r.telefono_corporativo || ''} ${clientMap.get(r.accountId) || r.accountId || ''}`).join(' ').toLowerCase();
            const haystack = `${item.nombre_completo || ''} ${item.nombres || ''} ${item.apellidos || ''} ${item.correo || ''} ${item.telefono || ''} ${item.id || ''} ${relSearchStr}`.toLowerCase();
            return haystack.includes(q);
        });

        const countBadge = document.getElementById('global-contacts-count-badge');
        if (countBadge) {
            countBadge.textContent = `${list.length} ${list.length === 1 ? 'persona' : 'personas'}`;
        }

        if (list.length === 0) {
            container.innerHTML = `
                <div style="padding: 2.5rem 1.5rem; text-align: center; background: var(--ds-bg-subtle, #F8FAFC);">
                    <div style="font-size:2.2rem; margin-bottom:0.4rem;">👤</div>
                    <h3 style="font-size:1.05rem; color:var(--ds-text-primary, #0F172A); margin-bottom:0.35rem;">No se encontraron personas con los filtros seleccionados</h3>
                    <p style="font-size:0.85rem; color:var(--ds-text-muted, #64748B); margin-bottom:1rem;">Puedes registrar una nueva persona física global (sin requerir DUI para contactos comerciales ordinarios) y vincularla a una o más cuentas.</p>
                    <button type="button" class="btn-primary" onclick="ContactsUI.openCreatePersonFromGlobal()">+ Nueva Persona Global</button>
                </div>
            `;
            return;
        }

        let rowsHtml = '';
        list.forEach(c => {
            const fullName = c.nombre_completo || `${c.nombres || ''} ${c.apellidos || ''}`.trim() || c.id;
            const rels = Array.isArray(c.accountRelations) ? c.accountRelations : [];
            const activeRels = rels.filter(r => r.activo);
            const inactiveRelsCount = rels.length - activeRels.length;
            const oppCount = Number(c.opportunityCount) || 0;

            let accountsCellHtml = '';
            if (rels.length === 0) {
                accountsCellHtml = `<span class="ds-badge ds-badge-neutral">Sin empresa vinculada</span>`;
            } else {
                const displayRels = activeRels.length > 0 ? activeRels : rels.slice(0, 2);
                accountsCellHtml = displayRels.map(r => {
                    const accName = clientMap.get(r.accountId) || r.accountId;
                    const statusDot = r.activo ? '🟢' : '⚫';
                    return `
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.4rem; padding:0.25rem 0.45rem; background:var(--ds-bg-subtle, #F8FAFC); border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; margin-bottom:3px;">
                            <div style="min-width:0;">
                                <a href="javascript:void(0)" onclick="openClientDetailView('${_deps.esc(r.accountId)}')" style="font-weight:700; color:var(--ds-primary, #0062B8); text-decoration:none; font-size:0.8rem;">${statusDot} ${_deps.esc(accName)}</a>
                                <span style="font-size:0.74rem; color:var(--ds-text-secondary, #334155); display:block;">Cargo: <strong>${_deps.esc(r.cargo || '-')}</strong></span>
                            </div>
                        </div>
                    `;
                }).join('');
                if (inactiveRelsCount > 0 && activeRels.length > 0) {
                    accountsCellHtml += `<div style="font-size:0.72rem; color:var(--ds-text-muted, #64748B);">+ ${inactiveRelsCount} vínculo(s) histórico(s) cerrado(s)</div>`;
                }
            }

            // Canales corporativos y personales (respetando RBAC personalDataRestricted)
            const corpPhones = activeRels.map(r => r.telefono_corporativo ? `${r.telefono_corporativo}${r.extension ? ` Ext.${r.extension}` : ''}` : null).filter(Boolean);
            const corpEmails = activeRels.map(r => r.correo_corporativo).filter(Boolean);
            const channelLines = [];
            if (corpPhones.length > 0) channelLines.push(`<div style="color:var(--ds-text-primary, #0F172A); font-size:0.8rem;">📞 Corp: ${_deps.esc(corpPhones[0])}</div>`);
            if (corpEmails.length > 0) channelLines.push(`<div style="color:var(--ds-primary, #0062B8); font-size:0.8rem;">✉️ Corp: ${_deps.esc(corpEmails[0])}</div>`);
            if (c.telefono) channelLines.push(`<div style="color:var(--ds-text-secondary, #334155); font-size:0.78rem;">📱 Pers: ${_deps.esc(c.telefono)}</div>`);
            if (c.correo) channelLines.push(`<div style="color:var(--ds-text-secondary, #334155); font-size:0.78rem;">✉️ Pers: ${_deps.esc(c.correo)}</div>`);
            if (c.personalDataRestricted && channelLines.length === 0) {
                channelLines.push(`<span class="ds-badge ds-badge-neutral" title="Datos personales protegidos por cartera RBAC">🔒 Solo canales corporativos</span>`);
            }
            const channelsHtml = channelLines.length > 0 ? channelLines.join('') : `<span style="color:var(--ds-text-muted, #64748B); font-size:0.78rem;">Sin canales registrados</span>`;

            const multiBadge = rels.length >= 2
                ? `<span class="ds-badge ds-badge-info" style="margin-top:3px;">🔗 Multiempresa (${rels.length})</span>`
                : '';

            const oppBadge = oppCount > 0
                ? `<span class="ds-badge ds-badge-primary">${oppCount} ${oppCount === 1 ? 'oportunidad' : 'oportunidades'}</span>`
                : `<span class="ds-badge ds-badge-neutral">0 oportunidades</span>`;

            rowsHtml += `
                <tr style="border-bottom:1px solid var(--ds-border, #CBD5E1);">
                    <td style="padding:0.75rem 1rem;">
                        <a href="javascript:void(0)" onclick="ContactsUI.openContact360View('${_deps.esc(c.id)}', { originView: 'contacts-view' })" style="font-weight:700; color:var(--ds-primary, #0062B8); font-size:0.9rem; text-decoration:none;">
                            👤 ${_deps.esc(fullName)}
                        </a>
                        <div style="font-size:0.74rem; color:var(--ds-text-muted, #64748B); margin-top:2px;">ID: <code>${_deps.esc(c.id)}</code> · DUI no requerido (comercial)</div>
                        ${multiBadge}
                    </td>
                    <td style="padding:0.75rem 1rem;">${accountsCellHtml}</td>
                    <td style="padding:0.75rem 1rem;">${channelsHtml}</td>
                    <td style="padding:0.75rem 1rem; text-align:center;">${oppBadge}</td>
                    <td style="padding:0.75rem 1rem; text-align:right; white-space:nowrap;">
                        <div class="table-btn-group" style="justify-content:flex-end; gap:4px;">
                            <button type="button" class="btn-primary" style="padding:0.35rem 0.7rem; font-size:0.78rem;" onclick="ContactsUI.openContact360View('${_deps.esc(c.id)}', { originView: 'contacts-view' })">
                                👤 Contacto 360
                            </button>
                            <button type="button" class="btn-table-action" onclick="ContactsUI.openLinkContactFromContact360('${_deps.esc(c.id)}')" title="Vincular esta persona a una cuenta comercial">
                                🔗 Vincular Empresa
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        container.innerHTML = `
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="background:var(--ds-bg-subtle, #F8FAFC); border-bottom:1px solid var(--ds-border, #CBD5E1);">
                        <th style="width:25%; padding:0.75rem 1rem; text-align:left;">Persona Física</th>
                        <th style="width:30%; padding:0.75rem 1rem; text-align:left;">Cuentas Vinculadas y Cargo</th>
                        <th style="width:20%; padding:0.75rem 1rem; text-align:left;">Canales Corporativos / Personales</th>
                        <th style="width:11%; padding:0.75rem 1rem; text-align:center;">Oportunidades</th>
                        <th style="width:14%; padding:0.75rem 1rem; text-align:right;">Acciones</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        `;
    }

    async function openContact360View(contactId, options = {}) {
        if (!contactId) return;
        activeContact360Id = contactId;
        if (options && (options.originView || options.originAccountId)) {
            contact360OriginContext = {
                originView: options.originView || (options.originAccountId ? 'client-detail-view' : 'contacts-view'),
                accountId: options.accountId || options.originAccountId || activeAccountId || null
            };
        } else if (!contact360OriginContext) {
            contact360OriginContext = { originView: 'contacts-view', accountId: null };
        }

        _deps.showView('contact-360-view');
        setStatusBanner('contact-360-status', null);

        const container = document.getElementById('contact-360-content-container');
        if (!container) return;

        container.innerHTML = `
            <div style="padding: 2.5rem; text-align: center; color: var(--ds-text-secondary, #334155);">
                <div class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid rgba(0,98,184,0.2); border-top-color:var(--ds-primary, #0062B8); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                <p style="margin-top: 0.75rem; font-size: 0.88rem;">Cargando ficha integral Contacto 360...</p>
            </div>
        `;

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) {
            container.innerHTML = `<div style="padding:2rem; text-align:center; color:var(--ds-text-muted, #64748B);">El servicio de contactos no está disponible.</div>`;
            return;
        }

        try {
            const res = await crmContacts.getContact(fb, {
                contactId,
                includeDossier: true,
                dbSuffix: _deps.getDbSuffix()
            });
            const person = res && res.contact ? res.contact : null;
            if (!person) throw new Error('No se encontró la persona solicitada.');
            activeContact360Data = person;
            _renderContact360Hub(person);
        } catch (err) {
            console.error('[ContactsUI] Error loading Contact 360:', err);
            setStatusBanner('contact-360-status', 'error', err.message || 'No se pudo cargar la ficha Contacto 360.');
            container.innerHTML = `
                <div class="ds-panel" style="padding:2rem; text-align:center;">
                    <p style="color:var(--ds-danger, #DC2626); margin-bottom:0.75rem;">${_deps.esc(err.message || 'Error al cargar Contacto 360.')}</p>
                    <button type="button" class="btn-secondary" onclick="ContactsUI.closeContact360View()">← Volver</button>
                </div>
            `;
        }
    }

    function _renderContact360Hub(person) {
        const container = document.getElementById('contact-360-content-container');
        if (!container || !person) return;

        const allClients = _deps.getClients();
        const clientMap = new Map();
        allClients.forEach(c => { if (c && c.id) clientMap.set(c.id, getAccountDisplayName(c)); });

        const allProspects = (typeof prospects !== 'undefined' && Array.isArray(prospects))
            ? prospects
            : (typeof window !== 'undefined' && Array.isArray(window.prospects) ? window.prospects : []);
        const oppMap = new Map();
        allProspects.forEach(p => { if (p && p.id) oppMap.set(p.id, p); });

        const fullName = person.nombre_completo || `${person.nombres || ''} ${person.apellidos || ''}`.trim() || person.id;
        const rels = Array.isArray(person.accountRelations) ? person.accountRelations : [];
        const activeRels = rels.filter(r => r.activo);
        const periods = Array.isArray(person.periods) ? person.periods : [];
        const oppParts = Array.isArray(person.opportunityParticipations) ? person.opportunityParticipations : [];

        const backLabel = (contact360OriginContext && contact360OriginContext.originView === 'client-detail-view')
            ? '← Volver a Cuenta 360'
            : (contact360OriginContext && contact360OriginContext.originView === 'account-contacts-view')
                ? '← Volver a Contactos de la Cuenta'
                : '← Volver al Directorio de Contactos';

        const personalEmailStr = person.correo
            ? `<a href="mailto:${_deps.esc(person.correo)}" style="color:var(--ds-primary, #0062B8); text-decoration:none;">${_deps.esc(person.correo)}</a>`
            : (person.personalDataRestricted ? '<span class="ds-badge ds-badge-neutral">🔒 Protegido por cartera</span>' : 'No registrado');
        const personalPhoneStr = person.telefono
            ? _deps.esc(person.telefono)
            : (person.personalDataRestricted ? '🔒 Protegido por cartera' : 'No registrado');

        // Tabla de Empresas Vinculadas
        let accountsHtml = '';
        if (rels.length === 0) {
            accountsHtml = `<div style="padding:1.25rem; text-align:center; color:var(--ds-text-muted, #64748B); font-size:0.84rem;">Esta persona no tiene relaciones laborales registradas en cuentas autorizadas.</div>`;
        } else {
            accountsHtml = `
                <div class="table-container" style="border:none;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead>
                            <tr>
                                <th>Empresa / Cuenta (Hub)</th>
                                <th>Cargo Laboral</th>
                                <th>Canales Corporativos</th>
                                <th>Estado / Períodos</th>
                                <th style="text-align:right;">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rels.map(r => {
                                const accName = clientMap.get(r.accountId) || r.accountId;
                                const badge = r.activo
                                    ? `<span class="ds-badge ds-badge-success">🟢 Activo</span>`
                                    : `<span class="ds-badge ds-badge-neutral">⚫ Histórico</span>`;
                                const corpInfo = [
                                    r.telefono_corporativo ? `📞 ${_deps.esc(r.telefono_corporativo)}${r.extension ? ` Ext.${_deps.esc(r.extension)}` : ''}` : null,
                                    r.correo_corporativo ? `✉️ ${_deps.esc(r.correo_corporativo)}` : null
                                ].filter(Boolean).join('<br>') || '-';
                                return `
                                    <tr>
                                        <td>
                                            <a href="javascript:void(0)" onclick="openClientDetailView('${_deps.esc(r.accountId)}')" style="font-weight:700; color:var(--ds-primary, #0062B8); text-decoration:none;">🏢 ${_deps.esc(accName)}</a>
                                            <div style="font-size:0.72rem; color:var(--ds-text-muted, #64748B);">ID Cuenta: <code>${_deps.esc(r.accountId)}</code></div>
                                        </td>
                                        <td style="font-weight:600; color:var(--ds-text-primary, #0F172A);">${_deps.esc(r.cargo || '-')}</td>
                                        <td style="font-size:0.8rem; color:var(--ds-text-secondary, #334155);">${corpInfo}</td>
                                        <td>
                                            ${badge}
                                            <span class="ds-badge ds-badge-primary" style="margin-left:4px;">${r.total_periodos || 1} per.</span>
                                        </td>
                                        <td style="text-align:right; white-space:nowrap;">
                                            <button type="button" class="btn-table-action" onclick="openClientDetailView('${_deps.esc(r.accountId)}')">🏢 Cuenta 360</button>
                                            <button type="button" class="btn-table-action" onclick="ContactsUI.openAccountContactsView('${_deps.esc(r.accountId)}')">⚙️ Gestionar Vínculo</button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        // Tabla de Oportunidades donde participa (opportunity_contacts_prod)
        let oppsHtml = '';
        if (oppParts.length === 0) {
            oppsHtml = `<div style="padding:1.25rem; text-align:center; color:var(--ds-text-muted, #64748B); font-size:0.84rem;">No registra participaciones directas en oportunidades comerciales autorizadas.</div>`;
        } else {
            oppsHtml = `
                <div class="table-container" style="border:none;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead>
                            <tr>
                                <th>Oportunidad / Proyecto</th>
                                <th>Cuenta</th>
                                <th>Rol en la Oportunidad</th>
                                <th>Contacto Principal (Opcional)</th>
                                <th style="text-align:right;">Acción</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${oppParts.map(op => {
                                const oppDoc = oppMap.get(op.opportunityId) || {};
                                const oppName = oppDoc.proyecto || oppDoc.empresa || op.opportunityId;
                                const accName = clientMap.get(op.accountId) || oppDoc.empresa || op.accountId || '-';
                                const primaryBadge = op.isPrimary
                                    ? `<span class="ds-badge ds-badge-primary" title="Atributo exclusivo de esta oportunidad">⭐ Principal en Oportunidad</span>`
                                    : `<span class="ds-badge ds-badge-neutral">Participante</span>`;
                                return `
                                    <tr>
                                        <td>
                                            <strong style="color:var(--ds-text-primary, #0F172A);">${_deps.esc(oppName)}</strong>
                                            <div style="font-size:0.72rem; color:var(--ds-text-muted, #64748B);">ID: <code>${_deps.esc(op.opportunityId)}</code></div>
                                        </td>
                                        <td style="font-size:0.82rem; color:var(--ds-text-secondary, #334155);">${_deps.esc(accName)}</td>
                                        <td><span class="ds-badge ds-badge-info">${_deps.esc(op.roleLabel || op.roleCode || 'Participante')}</span></td>
                                        <td>${primaryBadge}</td>
                                        <td style="text-align:right;">
                                            <button type="button" class="btn-table-action" onclick="if(typeof openDetail === 'function') openDetail('${_deps.esc(op.opportunityId)}');">📂 Abrir Oportunidad</button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        // Historial cronológico de períodos (periods_prod)
        let periodsHtml = '';
        if (periods.length === 0) {
            periodsHtml = `<div style="padding:1.25rem; text-align:center; color:var(--ds-text-muted, #64748B); font-size:0.84rem;">Sin períodos históricos registrados.</div>`;
        } else {
            periodsHtml = `
                <div style="display:flex; flex-direction:column; gap:0.5rem; padding:0.85rem 1rem;">
                    ${periods.map(p => {
                        const isOpen = !p.fecha_fin;
                        const accName = clientMap.get(p.accountId) || p.accountId || '-';
                        return `
                            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; padding:0.65rem 0.85rem; background:var(--ds-bg-subtle, #F8FAFC); border:1px solid var(--ds-border, #CBD5E1); border-left:4px solid ${isOpen ? 'var(--ds-success, #059669)' : 'var(--ds-text-muted, #64748B)'}; border-radius:6px; flex-wrap:wrap;">
                                <div>
                                    <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-size:0.86rem;">
                                        ${_deps.esc(p.cargo || 'Cargo no especificado')} · <span style="color:var(--ds-primary, #0062B8);">${_deps.esc(accName)}</span>
                                    </div>
                                    <div style="font-size:0.76rem; color:var(--ds-text-secondary, #334155);">
                                        Inicio: ${_deps.formatDate(p.fecha_inicio)} — Fin: ${isOpen ? '<strong style="color:var(--ds-success, #059669);">Presente (Vigente)</strong>' : _deps.formatDate(p.fecha_fin)}
                                    </div>
                                    ${p.motivo_salida ? `<div style="font-size:0.74rem; color:var(--ds-danger, #DC2626);">Motivo salida: ${_deps.esc(p.motivo_salida)}</div>` : ''}
                                    ${p.motivo_reingreso ? `<div style="font-size:0.74rem; color:var(--ds-info, #0284C7);">Motivo reingreso: ${_deps.esc(p.motivo_reingreso)}</div>` : ''}
                                </div>
                                <div>
                                    ${isOpen ? `<span class="ds-badge ds-badge-success">🟢 Vigente</span>` : `<span class="ds-badge ds-badge-neutral">⚫ Cerrado</span>`}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        container.innerHTML = `
            <div class="ds-record-header">
                <div class="ds-record-header-top">
                    <div>
                        <div class="ds-record-breadcrumb">
                            <a href="javascript:void(0)" onclick="ContactsUI.closeContact360View()">${_deps.esc(backLabel)}</a>
                            <span>/</span>
                            <span>Contacto 360</span>
                            <span>/</span>
                            <code>${_deps.esc(person.id)}</code>
                        </div>
                        <h2 class="ds-record-title">👤 ${_deps.esc(fullName)}</h2>
                        <div class="ds-record-subtitle">
                            <span class="ds-badge ds-badge-primary">Identidad Única Global (contacts_prod)</span>
                            <span class="ds-badge ds-badge-success">${activeRels.length} empresa(s) activa(s)</span>
                            <span class="ds-badge ds-badge-info">${oppParts.length} oportunidad(es)</span>
                            <span>•</span>
                            <span>✉️ Personal: ${personalEmailStr}</span>
                            <span>•</span>
                            <span>📱 Personal: ${personalPhoneStr}</span>
                        </div>
                    </div>
                    <div class="ds-record-actions">
                        <button type="button" class="btn-secondary" onclick="ContactsUI.openEditPersonFromContact360('${_deps.esc(person.id)}')">
                            ✏️ Editar Identidad Personal
                        </button>
                        <button type="button" class="btn-primary" onclick="ContactsUI.openLinkContactFromContact360('${_deps.esc(person.id)}')">
                            🔗 Vincular a Cuenta Comercial
                        </button>
                    </div>
                </div>
            </div>

            <div class="ds-panel mb-3">
                <div class="ds-panel-header">
                    <div>
                        <h3 class="ds-panel-title">🏢 Cuentas Comerciales Vinculadas y Cargos (account_contacts_prod)</h3>
                        <p class="ds-panel-subtitle">Una persona puede estar vinculada simultáneamente o históricamente a múltiples empresas sin duplicar su identidad.</p>
                    </div>
                    <span class="ds-badge ds-badge-neutral">${rels.length} vínculo(s)</span>
                </div>
                ${accountsHtml}
            </div>

            <div class="ds-panel mb-3">
                <div class="ds-panel-header">
                    <div>
                        <h3 class="ds-panel-title">📂 Oportunidades Comerciales donde Participa (opportunity_contacts_prod)</h3>
                        <p class="ds-panel-subtitle">Roles desempeñados por la persona en oportunidades concretas. El atributo «Contacto Principal» es opcional y exclusivo de cada oportunidad.</p>
                    </div>
                    <span class="ds-badge ds-badge-primary">${oppParts.length} participación(es)</span>
                </div>
                ${oppsHtml}
            </div>

            <div class="ds-panel">
                <div class="ds-panel-header">
                    <div>
                        <h3 class="ds-panel-title">🕒 Historial Cronológico de Períodos Laborales (periods_prod)</h3>
                        <p class="ds-panel-subtitle">Trazabilidad de ingresos, cambios de cargo, bajas y reingresos en cuentas autorizadas.</p>
                    </div>
                    <span class="ds-badge ds-badge-neutral">${periods.length} período(s)</span>
                </div>
                ${periodsHtml}
            </div>
        `;
    }

    function closeContact360View() {
        const ctx = contact360OriginContext || { originView: 'contacts-view', accountId: null };
        activeContact360Id = null;
        if (ctx.originView === 'client-detail-view' && ctx.accountId && typeof window !== 'undefined' && typeof window.openClientDetailView === 'function') {
            window.openClientDetailView(ctx.accountId);
            return;
        }
        if (ctx.originView === 'account-contacts-view' && ctx.accountId) {
            openAccountContactsView(ctx.accountId);
            return;
        }
        openGlobalContactsView();
    }

    function openEditPersonFromContact360(contactId) {
        if (!contactId) return;
        originFromGlobalContacts = true;
        openEditPersonView(contactId, null);
    }

    function openLinkContactFromContact360(contactId) {
        if (!contactId) return;
        originFromGlobalContacts = true;
        const person = activeContact360Data && activeContact360Data.id === contactId
            ? activeContact360Data
            : (globalContactsDirectoryList.find(c => c.id === contactId) || { id: contactId });

        const allClients = _deps.getClients().filter(c => c && !c.eliminado);
        if (!activeAccountId && allClients.length > 0) {
            activeAccountId = allClients[0].id;
            activeAccountData = allClients[0];
        }
        openLinkContactView(activeAccountId);
        selectPersonForLinking(person);
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
        openCreatePersonFromGlobal,
        submitCreatePerson,

        openEditPersonView,
        openEditPersonFromContact360,
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

        // B6: Directorio Global de Contactos y Contacto 360
        openGlobalContactsView,
        loadGlobalContactsDirectory,
        onGlobalContactsSearch,
        renderGlobalContactsTable,
        openContact360View,
        closeContact360View,
        openLinkContactFromContact360,

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
