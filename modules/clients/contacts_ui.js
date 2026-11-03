// ============================================================================
// DUCTSAL ERP — CLIENTS MODULE: CONTACTS & PERIODS UI (Fase 2 Bloque 1 - B1)
// Archivo: modules/clients/contacts_ui.js
// Responsabilidad:
// 1. Gestión de personas y relaciones cuenta-persona (Hub & Spoke).
// 2. Modales para listar, vincular, editar, dar de baja y reactivar contactos.
// 3. Consulta y visualización del historial de cargos y períodos (periods_prod).
// 4. Búsqueda y creación de identidad de personas (contacts_prod).
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
            window.openAccountContactsModal = api.openAccountContactsModal;
            window.closeAccountContactsModal = api.closeAccountContactsModal;
            window.openLinkContactModal = api.openLinkContactModal;
            window.closeLinkContactModal = api.closeLinkContactModal;
            window.setLinkContactMode = api.setLinkContactMode;
            window.onPersonSearchInput = api.onPersonSearchInput;
            window.selectPersonForLinking = api.selectPersonForLinking;
            window.submitLinkContact = api.submitLinkContact;
            window.openEditAccountContactModal = api.openEditAccountContactModal;
            window.closeEditAccountContactModal = api.closeEditAccountContactModal;
            window.submitEditAccountContact = api.submitEditAccountContact;
            window.openDeactivateContactModal = api.openDeactivateContactModal;
            window.closeDeactivateContactModal = api.closeDeactivateContactModal;
            window.submitDeactivateContact = api.submitDeactivateContact;
            window.openReactivateContactModal = api.openReactivateContactModal;
            window.closeReactivateContactModal = api.closeReactivateContactModal;
            window.submitReactivateContact = api.submitReactivateContact;
            window.openContactPeriodsModal = api.openContactPeriodsModal;
            window.closeContactPeriodsModal = api.closeContactPeriodsModal;
            window.toggleInactiveContactsFilter = api.toggleInactiveContactsFilter;
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
            if (type === 'error' && typeof alert === 'function') alert(msg);
        }
    }

    function getAccountDisplayName(account) {
        if (!account) return 'Cuenta Desconocida';
        if (account.tipo === 'natural') {
            return `${account.nombres || ''} ${account.apellidos || ''}`.trim() || account.id;
        }
        return account.empresa || account.contacto || account.id;
    }

    // =========================================================================
    // 1. MODAL PRINCIPAL: CONTACTOS DE LA CUENTA
    // =========================================================================

    async function openAccountContactsModal(accountId) {
        if (!accountId) return;
        activeAccountId = accountId;
        const allClients = _deps.getClients();
        activeAccountData = allClients.find(c => c.id === accountId) || { id: accountId };

        const modal = document.getElementById('accountContactsModal');
        if (!modal) return;

        const titleEl = document.getElementById('acc-contacts-account-name');
        if (titleEl) titleEl.textContent = getAccountDisplayName(activeAccountData);

        const idBadge = document.getElementById('acc-contacts-account-id');
        if (idBadge) idBadge.textContent = activeAccountId;

        modal.style.display = 'block';
        await loadAndRenderAccountContacts();
    }

    function closeAccountContactsModal() {
        const modal = document.getElementById('accountContactsModal');
        if (modal) modal.style.display = 'none';
        activeAccountId = null;
        activeAccountData = null;
        currentContactsList = [];
    }

    async function loadAndRenderAccountContacts() {
        const container = document.getElementById('acc-contacts-list-container');
        if (!container) return;

        container.innerHTML = `
            <div style="text-align: center; padding: 2.5rem; color: var(--text-secondary);">
                <div class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid rgba(255,204,77,0.2); border-top-color:var(--brand-gold); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                <p style="margin-top: 0.8rem; font-size: 0.9rem;">Cargando personas y relaciones vinculadas...</p>
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
                    <button class="btn-secondary mt-2" onclick="ContactsUI.openAccountContactsModal('${activeAccountId}')">Reintentar</button>
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
                <div class="table-empty-box">
                    <div class="icon" style="font-size:2.2rem; opacity:0.6;">👥</div>
                    <h3 style="font-size:1rem; color:var(--text-primary); margin-bottom:0.3rem;">No hay personas vinculadas</h3>
                    <p style="font-size:0.85rem; color:var(--text-muted);">Esta cuenta aún no tiene personas registradas bajo el modelo Hub & Spoke.</p>
                    <button class="btn-primary mt-2" onclick="ContactsUI.openLinkContactModal('${activeAccountId}')" style="font-size:0.85rem; padding:0.5rem 1rem;">
                        + Vincular Primera Persona
                    </button>
                </div>
            `;
            return;
        }

        let html = `
            <div class="table-container glass-panel" style="padding:0; overflow:hidden;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr>
                            <th style="width: 25%;">Persona</th>
                            <th style="width: 20%;">Cargo Actual</th>
                            <th style="width: 22%;">Contacto Corporativo</th>
                            <th style="width: 13%; text-align:center;">Estado</th>
                            <th style="width: 20%; text-align:right;">Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        filtered.forEach(ac => {
            const p = ac.person || ac.persona || {};
            const fullName = `${p.nombres || ''} ${p.apellidos || ''}`.trim() || 'Persona sin nombre';
            const isActive = ac.activo === true;

            const statusBadge = isActive
                ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:var(--success); border:1px solid rgba(16,185,129,0.3); font-weight:600; font-size:0.75rem;">🟢 Activo</span>`
                : `<span class="badge" style="background:rgba(107,114,128,0.2); color:var(--text-muted); border:1px solid rgba(107,114,128,0.3); font-size:0.75rem;">⚫ Inactivo</span>`;

            const periodsBadge = `<span class="badge" style="background:rgba(255,204,77,0.1); color:var(--brand-gold); border:1px solid rgba(255,204,77,0.25); font-size:0.7rem; margin-left:6px;">${ac.total_periodos || 1} ${_deps.esc((ac.total_periodos || 1) === 1 ? 'período' : 'períodos')}</span>`;

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

            // Personal identity subtitle
            const personalMeta = [];
            if (p.telefono && ac.telefono_corporativo) personalMeta.push(`Tel. pers: ${_deps.esc(p.telefono)}`);
            if (p.correo && ac.correo_corporativo) personalMeta.push(`Correo pers: ${_deps.esc(p.correo)}`);
            const personalSub = personalMeta.length ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">${personalMeta.join(' | ')}</div>` : '';

            // Botones de acción según estado
            let actionButtons = `
                <button type="button" class="btn-table-action" onclick="ContactsUI.openContactPeriodsModal('${ac.id}', '${_deps.esc(fullName)}')" title="Ver historial de cargos y períodos" style="background:rgba(56,189,248,0.15); color:#38bdf8; border-color:rgba(56,189,248,0.3);">
                    🕒 Historial
                </button>
            `;

            if (isActive) {
                actionButtons += `
                    <button type="button" class="btn-table-action btn-table-edit" onclick="ContactsUI.openEditAccountContactModal('${ac.id}')" title="Modificar cargo o datos corporativos">
                        ✏️ Cargo
                    </button>
                    <button type="button" class="btn-table-action btn-table-delete" onclick="ContactsUI.openDeactivateContactModal('${ac.id}', '${_deps.esc(fullName)}')" title="Dar de baja y cerrar período">
                        ⛔ Baja
                    </button>
                `;
            } else {
                actionButtons += `
                    <button type="button" class="btn-table-action" onclick="ContactsUI.openReactivateContactModal('${ac.id}', '${_deps.esc(fullName)}')" title="Reactivar persona en esta cuenta con un nuevo período" style="background:rgba(16,185,129,0.15); color:var(--success); border-color:rgba(16,185,129,0.3);">
                        🔄 Reactivar
                    </button>
                `;
            }

            html += `
                <tr style="border-bottom:1px solid var(--panel-border); ${!isActive ? 'opacity:0.68;' : ''}">
                    <td>
                        <div style="font-weight:600; color:white; font-size:0.9rem;">${_deps.esc(fullName)}</div>
                        ${personalSub}
                    </td>
                    <td>
                        <div style="font-weight:500; color:var(--brand-gold); font-size:0.88rem;">${_deps.esc(ac.cargo || '-')}</div>
                        <div style="margin-top:2px;">${periodsBadge}</div>
                    </td>
                    <td>${contactCell}</td>
                    <td style="text-align:center;">${statusBadge}</td>
                    <td style="text-align:right; white-space:nowrap;">
                        <div class="table-btn-group" style="justify-content:flex-end;">
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
    // 2. VINCULAR CONTACTO (NUEVA PERSONA O PERSONA EXISTENTE)
    // =========================================================================

    function openLinkContactModal(accountId) {
        if (!accountId && !activeAccountId) return;
        if (accountId) activeAccountId = accountId;

        const modal = document.getElementById('linkContactModal');
        if (!modal) return;

        const accountNameEl = document.getElementById('link-contact-target-account');
        if (accountNameEl && activeAccountData) {
            accountNameEl.textContent = getAccountDisplayName(activeAccountData);
        }

        // Reset forms
        const newPersonForm = document.getElementById('form-create-and-link-person');
        if (newPersonForm && typeof newPersonForm.reset === 'function') newPersonForm.reset();

        const linkExistingForm = document.getElementById('form-link-existing-person');
        if (linkExistingForm && typeof linkExistingForm.reset === 'function') linkExistingForm.reset();

        selectedPersonForLinking = null;
        updateSelectedPersonBox();

        setLinkContactMode('create');
        modal.style.display = 'block';
    }

    function closeLinkContactModal() {
        const modal = document.getElementById('linkContactModal');
        if (modal) modal.style.display = 'none';
        selectedPersonForLinking = null;
    }

    function setLinkContactMode(mode) {
        const tabCreate = document.getElementById('tab-link-create-mode');
        const tabSelect = document.getElementById('tab-link-select-mode');
        const sectionCreate = document.getElementById('section-link-create-person');
        const sectionSelect = document.getElementById('section-link-select-person');

        if (mode === 'create') {
            if (tabCreate) { tabCreate.classList.add('active'); tabCreate.style.borderColor = 'var(--brand-gold)'; tabCreate.style.color = 'var(--brand-gold)'; }
            if (tabSelect) { tabSelect.classList.remove('active'); tabSelect.style.borderColor = 'transparent'; tabSelect.style.color = 'var(--text-secondary)'; }
            if (sectionCreate) sectionCreate.style.display = 'block';
            if (sectionSelect) sectionSelect.style.display = 'none';
        } else {
            if (tabCreate) { tabCreate.classList.remove('active'); tabCreate.style.borderColor = 'transparent'; tabCreate.style.color = 'var(--text-secondary)'; }
            if (tabSelect) { tabSelect.classList.add('active'); tabSelect.style.borderColor = 'var(--brand-gold)'; tabSelect.style.color = 'var(--brand-gold)'; }
            if (sectionCreate) sectionCreate.style.display = 'none';
            if (sectionSelect) sectionSelect.style.display = 'block';
        }
    }

    // Buscador interactivo de personas para vincular existente
    function onPersonSearchInput(query) {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        const q = String(query || '').trim();
        const resultsBox = document.getElementById('person-search-results');
        if (!resultsBox) return;

        if (q.length < 2) {
            resultsBox.innerHTML = `<p style="padding:0.75rem; color:var(--text-muted); font-size:0.82rem; margin:0;">Escribe al menos 2 caracteres para buscar personas...</p>`;
            return;
        }

        resultsBox.innerHTML = `<p style="padding:0.75rem; color:var(--text-secondary); font-size:0.82rem; margin:0;">Buscando...</p>`;

        searchDebounceTimer = setTimeout(async () => {
            const crmContacts = _deps.getCrmContacts();
            const fb = _deps.getFirebase();
            if (!crmContacts || !fb) return;

            try {
                const res = await crmContacts.searchContacts(fb, {
                    q,
                    limit: 10,
                    dbSuffix: _deps.getDbSuffix()
                });

                const contacts = (res && (res.contacts || res.results)) || [];
                if (contacts.length === 0) {
                    resultsBox.innerHTML = `
                        <div style="padding:0.75rem; text-align:center; color:var(--text-muted); font-size:0.82rem;">
                            No se encontraron personas con "${_deps.esc(q)}". Puedes crear una nueva en la otra pestaña.
                        </div>
                    `;
                    return;
                }

                let html = `<div style="max-height: 200px; overflow-y: auto; display:flex; flex-direction:column; gap:4px; padding:4px;">`;
                contacts.forEach(c => {
                    const name = `${c.nombres || ''} ${c.apellidos || ''}`.trim();
                    const details = [c.correo, c.telefono].filter(Boolean).join(' • ');
                    html += `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0.75rem; background:rgba(255,255,255,0.03); border:1px solid var(--panel-border); border-radius:6px;">
                            <div>
                                <div style="font-weight:600; color:white; font-size:0.85rem;">${_deps.esc(name)}</div>
                                <div style="font-size:0.75rem; color:var(--text-muted);">${_deps.esc(details || 'Sin datos de contacto personal')}</div>
                            </div>
                            <button type="button" class="btn-secondary" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick='ContactsUI.selectPersonForLinking(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
                                Seleccionar
                            </button>
                        </div>
                    `;
                });
                html += `</div>`;
                resultsBox.innerHTML = html;
            } catch (err) {
                console.error('[ContactsUI] Search error:', err);
                resultsBox.innerHTML = `<div style="padding:0.75rem; color:var(--danger); font-size:0.82rem;">Error al buscar personas.</div>`;
            }
        }, 300);
    }

    function selectPersonForLinking(person) {
        selectedPersonForLinking = person;
        updateSelectedPersonBox();
    }

    function updateSelectedPersonBox() {
        const box = document.getElementById('selected-person-preview');
        const fields = document.getElementById('link-existing-relation-fields');
        if (!box) return;

        if (!selectedPersonForLinking) {
            box.innerHTML = `<div style="padding:0.6rem 0.8rem; background:rgba(0,0,0,0.15); border-radius:6px; border:1px dashed var(--panel-border); color:var(--text-muted); font-size:0.82rem; text-align:center;">Ninguna persona seleccionada aún.</div>`;
            if (fields) fields.style.display = 'none';
        } else {
            const name = `${selectedPersonForLinking.nombres || ''} ${selectedPersonForLinking.apellidos || ''}`.trim();
            const details = [selectedPersonForLinking.correo, selectedPersonForLinking.telefono].filter(Boolean).join(' • ');
            box.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.85rem; background:rgba(255,204,77,0.08); border-radius:6px; border:1px solid rgba(255,204,77,0.3);">
                    <div>
                        <span style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--brand-gold); font-weight:700;">Persona Seleccionada</span>
                        <div style="font-weight:600; color:white; font-size:0.9rem;">${_deps.esc(name)}</div>
                        <div style="font-size:0.75rem; color:var(--text-secondary);">${_deps.esc(details || 'Sin datos de contacto')}</div>
                    </div>
                    <button type="button" class="btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="ContactsUI.selectPersonForLinking(null)">Cambiar</button>
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

        const modeEl = document.getElementById('tab-link-create-mode');
        const isCreateMode = modeEl && modeEl.classList.contains('active');

        try {
            if (isCreateMode) {
                // Modo 1: Crear Persona + Vincular a Cuenta
                const nombres = (document.getElementById('link-new-nombres') || {}).value || '';
                const apellidos = (document.getElementById('link-new-apellidos') || {}).value || '';
                const telefono = (document.getElementById('link-new-telefono') || {}).value || '';
                const correo = (document.getElementById('link-new-correo') || {}).value || '';

                const cargo = (document.getElementById('link-new-cargo') || {}).value || '';
                const telefono_corp = (document.getElementById('link-new-tel-corp') || {}).value || '';
                const extension = (document.getElementById('link-new-ext') || {}).value || '';
                const correo_corp = (document.getElementById('link-new-correo-corp') || {}).value || '';

                if (!nombres.trim() || !apellidos.trim()) {
                    notify('warning', 'Nombres y Apellidos de la persona son obligatorios.');
                    return;
                }
                if (!cargo.trim()) {
                    notify('warning', 'El cargo en la cuenta es obligatorio.');
                    return;
                }

                // Paso 1: Crear la identidad de la persona
                notify('info', 'Registrando identidad de la persona...');
                const contactRes = await crmContacts.createContact(fb, {
                    contact: {
                        nombres: nombres.trim(),
                        apellidos: apellidos.trim(),
                        telefono: telefono.trim(),
                        correo: correo.trim()
                    },
                    dbSuffix: _deps.getDbSuffix()
                });

                const personId = contactRes && contactRes.contact ? contactRes.contact.id : null;
                if (!personId) throw new Error('No se pudo obtener el identificador de la persona creada.');

                // Paso 2: Vincular a la cuenta
                notify('info', 'Vinculando persona a la cuenta...');
                await crmContacts.linkContactToAccount(fb, {
                    accountId: activeAccountId,
                    contactId: personId,
                    cargo: cargo.trim(),
                    telefono_corporativo: telefono_corp.trim(),
                    extension: extension.trim(),
                    correo_corporativo: correo_corp.trim(),
                    dbSuffix: _deps.getDbSuffix()
                });

                notify('success', 'Persona registrada y vinculada a la cuenta exitosamente.');
            } else {
                // Modo 2: Vincular Persona Existente
                if (!selectedPersonForLinking || !selectedPersonForLinking.id) {
                    notify('warning', 'Debes seleccionar una persona existente de la lista.');
                    return;
                }

                const cargo = (document.getElementById('link-exist-cargo') || {}).value || '';
                const telefono_corp = (document.getElementById('link-exist-tel-corp') || {}).value || '';
                const extension = (document.getElementById('link-exist-ext') || {}).value || '';
                const correo_corp = (document.getElementById('link-exist-correo-corp') || {}).value || '';

                if (!cargo.trim()) {
                    notify('warning', 'El cargo en la cuenta es obligatorio.');
                    return;
                }

                notify('info', 'Vinculando persona a la cuenta...');
                await crmContacts.linkContactToAccount(fb, {
                    accountId: activeAccountId,
                    contactId: selectedPersonForLinking.id,
                    cargo: cargo.trim(),
                    telefono_corporativo: telefono_corp.trim(),
                    extension: extension.trim(),
                    correo_corporativo: correo_corp.trim(),
                    dbSuffix: _deps.getDbSuffix()
                });

                notify('success', 'Persona vinculada a la cuenta exitosamente.');
            }

            closeLinkContactModal();
            await loadAndRenderAccountContacts();
        } catch (err) {
            console.error('[ContactsUI] Error linking contact:', err);
            notify('error', err.message || 'Error al vincular el contacto.');
        }
    }

    // =========================================================================
    // 3. EDITAR DATOS CORPORATIVOS DE LA RELACIÓN
    // =========================================================================

    function openEditAccountContactModal(accountContactId) {
        const item = currentContactsList.find(c => c.id === accountContactId);
        if (!item) return;

        targetAccountContactForAction = item;
        const modal = document.getElementById('editAccountContactModal');
        if (!modal) return;

        const p = item.person || {};
        const nameEl = document.getElementById('edit-acc-contact-person-name');
        if (nameEl) nameEl.textContent = `${p.nombres || ''} ${p.apellidos || ''}`.trim();

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        setVal('edit-acc-cargo', item.cargo);
        setVal('edit-acc-tel-corp', item.telefono_corporativo);
        setVal('edit-acc-ext', item.extension);
        setVal('edit-acc-correo-corp', item.correo_corporativo);

        modal.style.display = 'block';
    }

    function closeEditAccountContactModal() {
        const modal = document.getElementById('editAccountContactModal');
        if (modal) modal.style.display = 'none';
        targetAccountContactForAction = null;
    }

    async function submitEditAccountContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        const cargo = (document.getElementById('edit-acc-cargo') || {}).value || '';
        const telefono_corp = (document.getElementById('edit-acc-tel-corp') || {}).value || '';
        const extension = (document.getElementById('edit-acc-ext') || {}).value || '';
        const correo_corp = (document.getElementById('edit-acc-correo-corp') || {}).value || '';

        if (!cargo.trim()) {
            notify('warning', 'El cargo es obligatorio.');
            return;
        }

        try {
            notify('info', 'Actualizando cargo y datos corporativos...');
            await crmContacts.updateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                cargo: cargo.trim(),
                telefono_corporativo: telefono_corp.trim(),
                extension: extension.trim(),
                correo_corporativo: correo_corp.trim(),
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Relación con la cuenta actualizada exitosamente.');
            closeEditAccountContactModal();
            await loadAndRenderAccountContacts();
        } catch (err) {
            console.error('[ContactsUI] Error updating account contact:', err);
            notify('error', err.message || 'Error al actualizar la relación.');
        }
    }

    // =========================================================================
    // 4. BAJA DE CONTACTO (CIERRE DE PERÍODO VIGENTE)
    // =========================================================================

    function openDeactivateContactModal(accountContactId, personName) {
        targetAccountContactForAction = { id: accountContactId, personName };
        const modal = document.getElementById('deactivateContactModal');
        if (!modal) return;

        const nameEl = document.getElementById('deact-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const motiveInput = document.getElementById('deact-contact-motive');
        if (motiveInput) motiveInput.value = '';

        modal.style.display = 'block';
    }

    function closeDeactivateContactModal() {
        const modal = document.getElementById('deactivateContactModal');
        if (modal) modal.style.display = 'none';
        targetAccountContactForAction = null;
    }

    async function submitDeactivateContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const motive = ((document.getElementById('deact-contact-motive') || {}).value || '').trim();
        if (!motive) {
            notify('warning', 'Debes ingresar el motivo de salida para cerrar el período.');
            return;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        try {
            notify('info', 'Registrando baja y cerrando período...');
            await crmContacts.deactivateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                motivo_salida: motive,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Contacto dado de baja y período cerrado correctamente.');
            closeDeactivateContactModal();
            await loadAndRenderAccountContacts();
        } catch (err) {
            console.error('[ContactsUI] Error deactivating contact:', err);
            notify('error', err.message || 'Error al registrar la baja.');
        }
    }

    // =========================================================================
    // 5. REACTIVACIÓN DE CONTACTO (NUEVO PERÍODO HISTÓRICO)
    // =========================================================================

    function openReactivateContactModal(accountContactId, personName) {
        const item = currentContactsList.find(c => c.id === accountContactId) || { id: accountContactId };
        targetAccountContactForAction = { id: accountContactId, personName, item };

        const modal = document.getElementById('reactivateContactModal');
        if (!modal) return;

        const nameEl = document.getElementById('react-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        setVal('react-contact-cargo', item.cargo || '');
        setVal('react-contact-motive', '');
        setVal('react-contact-tel-corp', item.telefono_corporativo || '');
        setVal('react-contact-ext', item.extension || '');
        setVal('react-contact-correo-corp', item.correo_corporativo || '');

        modal.style.display = 'block';
    }

    function closeReactivateContactModal() {
        const modal = document.getElementById('reactivateContactModal');
        if (modal) modal.style.display = 'none';
        targetAccountContactForAction = null;
    }

    async function submitReactivateContact(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!targetAccountContactForAction) return;

        const cargo = ((document.getElementById('react-contact-cargo') || {}).value || '').trim();
        const motive = ((document.getElementById('react-contact-motive') || {}).value || '').trim();
        const telefono_corp = ((document.getElementById('react-contact-tel-corp') || {}).value || '').trim();
        const extension = ((document.getElementById('react-contact-ext') || {}).value || '').trim();
        const correo_corp = ((document.getElementById('react-contact-correo-corp') || {}).value || '').trim();

        if (!cargo) {
            notify('warning', 'El cargo para el nuevo período es obligatorio.');
            return;
        }
        if (!motive) {
            notify('warning', 'El motivo de reingreso es obligatorio.');
            return;
        }

        const crmContacts = _deps.getCrmContacts();
        const fb = _deps.getFirebase();
        if (!crmContacts || !fb) return;

        try {
            notify('info', 'Reactivando relación y abriendo nuevo período...');
            await crmContacts.reactivateAccountContact(fb, {
                accountContactId: targetAccountContactForAction.id,
                cargo,
                motivo_reingreso: motive,
                telefono_corporativo: telefono_corp,
                extension,
                correo_corporativo: correo_corp,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Contacto reactivado con nuevo período abierto exitosamente.');
            closeReactivateContactModal();
            await loadAndRenderAccountContacts();
        } catch (err) {
            console.error('[ContactsUI] Error reactivating contact:', err);
            notify('error', err.message || 'Error al reactivar el contacto.');
        }
    }

    // =========================================================================
    // 6. HISTORIAL DE CARGOS Y PERÍODOS (periods_prod)
    // =========================================================================

    async function openContactPeriodsModal(accountContactId, personName) {
        const modal = document.getElementById('contactPeriodsModal');
        if (!modal) return;

        const nameEl = document.getElementById('periods-contact-person-name');
        if (nameEl) nameEl.textContent = personName;

        const accountEl = document.getElementById('periods-contact-account-name');
        if (accountEl && activeAccountData) {
            accountEl.textContent = getAccountDisplayName(activeAccountData);
        }

        const container = document.getElementById('periods-list-container');
        if (container) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
                    <div class="spinner" style="display:inline-block; width:26px; height:26px; border:3px solid rgba(56,189,248,0.2); border-top-color:#38bdf8; border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                    <p style="margin-top: 0.6rem; font-size: 0.85rem;">Cargando historial de períodos...</p>
                </div>
            `;
        }

        modal.style.display = 'block';

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
                    <div class="table-empty-box">
                        <div class="icon">🕒</div>
                        <h3>Sin períodos registrados</h3>
                        <p>No se encontraron registros de períodos para esta relación.</p>
                    </div>
                `;
                return;
            }

            let html = `<div class="timeline-container" style="display:flex; flex-direction:column; gap:12px; max-height:480px; overflow-y:auto; padding:4px;">`;
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
                    motivesHtml += `<div style="font-size:0.8rem; color:#38bdf8; margin-top:4px;"><strong>Motivo de reingreso:</strong> ${_deps.esc(p.motivo_reingreso)}</div>`;
                }
                if (p.motivo_salida) {
                    motivesHtml += `<div style="font-size:0.8rem; color:var(--danger); margin-top:4px;"><strong>Motivo de salida:</strong> ${_deps.esc(p.motivo_salida)}</div>`;
                }

                html += `
                    <div class="glass-panel" style="padding:1rem; border-left: 4px solid ${isOpen ? 'var(--success)' : 'var(--text-muted)'}; background:rgba(255,255,255,0.03);">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span style="font-weight:700; color:var(--brand-gold); font-size:0.85rem;">Período #${periodNum}</span>
                                <span style="color:var(--text-secondary); font-size:0.82rem;">(${startStr} — ${endStr})</span>
                            </div>
                            <div>${statusBadge}</div>
                        </div>
                        <div style="font-weight:600; color:white; font-size:0.95rem; margin-bottom:0.25rem;">
                            Cargo: <span style="color:var(--brand-gold);">${_deps.esc(p.cargo || '-')}</span>
                        </div>
                        ${motivesHtml}
                        <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px; display:flex; justify-content:space-between;">
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

    function closeContactPeriodsModal() {
        const modal = document.getElementById('contactPeriodsModal');
        if (modal) modal.style.display = 'none';
    }

    // Retorno de API pública
    return {
        openAccountContactsModal,
        closeAccountContactsModal,
        openLinkContactModal,
        closeLinkContactModal,
        setLinkContactMode,
        onPersonSearchInput,
        selectPersonForLinking,
        submitLinkContact,
        openEditAccountContactModal,
        closeEditAccountContactModal,
        submitEditAccountContact,
        openDeactivateContactModal,
        closeDeactivateContactModal,
        submitDeactivateContact,
        openReactivateContactModal,
        closeReactivateContactModal,
        submitReactivateContact,
        openContactPeriodsModal,
        closeContactPeriodsModal,
        toggleInactiveContactsFilter
    };
});
