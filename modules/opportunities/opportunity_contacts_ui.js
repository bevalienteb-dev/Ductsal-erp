// ============================================================================
// DUCTSAL ERP — OPPORTUNITIES MODULE: CONTACTS & ROLES UI (Fase 2 Bloque 2 - B2)
// Archivo: modules/opportunities/opportunity_contacts_ui.js
// Responsabilidad:
// 1. Visualización de participantes comerciales de una oportunidad en su ficha.
// 2. Vistas de pantalla completa (Full-Screen Navigation) integradas en el ERP:
//    - Agregar participante desde contactos de la cuenta.
//    - Editar rol comercial y notas.
//    - Designar / cambiar contacto comercial principal.
//    - Retirar participante con justificación obligatoria.
//    - Cambiar cuenta comercial en etapa inicial 'prospecto'.
// 3. Ausencia total de ventanas emergentes (sin modales, popups, confirm o prompt).
// 4. Estados integrados en pantalla de carga, éxito y error con retorno al detalle.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.OpportunityContactsUI = api;
        if (typeof window !== 'undefined') {
            window.OpportunityContactsUI = api;
            window.renderOpportunityParticipants = api.renderOpportunityParticipants;
            window.openAddOpportunityContactView = api.openAddOpportunityContactView;
            window.closeAddOpportunityContactView = api.closeAddOpportunityContactView;
            window.submitAddOpportunityContact = api.submitAddOpportunityContact;
            window.openEditOpportunityContactRoleView = api.openEditOpportunityContactRoleView;
            window.closeEditOpportunityContactRoleView = api.closeEditOpportunityContactRoleView;
            window.submitEditOpportunityContactRole = api.submitEditOpportunityContactRole;
            window.openSetOpportunityPrimaryContactView = api.openSetOpportunityPrimaryContactView;
            window.confirmSetOpportunityPrimaryContact = api.confirmSetOpportunityPrimaryContact;
            window.openRemoveOpportunityContactView = api.openRemoveOpportunityContactView;
            window.confirmRemoveOpportunityContact = api.confirmRemoveOpportunityContact;
            window.openChangeOpportunityAccountView = api.openChangeOpportunityAccountView;
            window.closeChangeOpportunityAccountView = api.closeChangeOpportunityAccountView;
            window.submitChangeOpportunityAccount = api.submitChangeOpportunityAccount;
            window.cancelOpportunityContactOperation = api.cancelOpportunityContactOperation;

            // Backward compatibility aliases
            window.openAddOpportunityContactModal = api.openAddOpportunityContactView;
            window.closeAddOpportunityContactModal = api.cancelOpportunityContactOperation;
            window.openEditOpportunityContactRoleModal = api.openEditOpportunityContactRoleView;
            window.closeEditOpportunityContactRoleModal = api.cancelOpportunityContactOperation;
            window.openChangeOpportunityAccountModal = api.openChangeOpportunityAccountView;
            window.closeChangeOpportunityAccountModal = api.cancelOpportunityContactOperation;
            window.setOpportunityPrimaryContact = api.openSetOpportunityPrimaryContactView;
            window.removeOpportunityParticipant = api.openRemoveOpportunityContactView;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // Internal state cache for participants
    const participantsCache = new Map(); // oppId -> { contacts: [], primaryId: null }
    let rolesCache = null;
    let activeOpp = null;
    let targetParticipantForAction = null;

    const _deps = {
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : (typeof window !== 'undefined' && window.firebase ? window.firebase : null)),
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        getCrmContacts: () => (typeof CrmContacts !== 'undefined' ? CrmContacts : (typeof window !== 'undefined' && window.CrmContacts ? window.CrmContacts : null)),
        getCrmOpportunityContacts: () => (typeof CrmOpportunityContacts !== 'undefined' ? CrmOpportunityContacts : (typeof window !== 'undefined' && window.CrmOpportunityContacts ? window.CrmOpportunityContacts : null)),
        getCrmUI: () => (typeof CrmUI !== 'undefined' ? CrmUI : (typeof window !== 'undefined' && window.CrmUI ? window.CrmUI : null)),
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
        },
        getClientName: (id) => {
            if (typeof getClientName === 'function') return getClientName(id);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(id);
            return id || '-';
        },
        showView: (viewId) => {
            if (typeof showView === 'function') return showView(viewId);
            if (typeof window !== 'undefined' && typeof window.showView === 'function') return window.showView(viewId);
        },
        openDetail: (id) => {
            if (typeof openDetail === 'function') return openDetail(id);
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') return window.openDetail(id);
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
            console.log(`[Notification ${type}] ${msg}`);
        }
    }

    function setStatusBanner(bannerId, type, message) {
        if (typeof document === 'undefined') return;
        const banner = document.getElementById(bannerId);
        if (!banner) return;
        if (!message) {
            banner.style.display = 'none';
            banner.textContent = '';
            return;
        }
        banner.style.display = 'block';
        if (type === 'error') {
            banner.style.background = 'rgba(239, 68, 68, 0.15)';
            banner.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            banner.style.color = '#fca5a5';
            banner.innerHTML = `⚠️ <strong>Error:</strong> ${_deps.esc(message)}`;
        } else if (type === 'success') {
            banner.style.background = 'rgba(16, 185, 129, 0.15)';
            banner.style.border = '1px solid rgba(16, 185, 129, 0.4)';
            banner.style.color = '#6ee7b7';
            banner.innerHTML = `✅ <strong>Éxito:</strong> ${_deps.esc(message)}`;
        } else if (type === 'loading') {
            banner.style.background = 'rgba(59, 130, 246, 0.15)';
            banner.style.border = '1px solid rgba(59, 130, 246, 0.4)';
            banner.style.color = '#93c5fd';
            banner.innerHTML = `⏳ <strong>Procesando:</strong> ${_deps.esc(message)}`;
        }
    }

    function cancelOpportunityContactOperation() {
        const oppId = (activeOpp && activeOpp.id)
            || (typeof currentProspectId !== 'undefined' ? currentProspectId : null)
            || (typeof window !== 'undefined' ? window.currentProspectId : null);
        if (oppId && typeof _deps.openDetail === 'function') {
            _deps.openDetail(oppId);
        } else if (typeof _deps.showView === 'function') {
            _deps.showView('detail-view');
        }
    }

    async function loadRoles() {
        if (rolesCache && rolesCache.length > 0) return rolesCache;
        const fb = _deps.getFirebase();
        const sdk = _deps.getCrmOpportunityContacts();
        if (!fb || !sdk) return [];
        try {
            const res = await sdk.listOpportunityContactRoles(fb, {
                includeInactive: false,
                dbSuffix: _deps.getDbSuffix()
            });
            rolesCache = (res && Array.isArray(res.roles)) ? res.roles : [];
            return rolesCache;
        } catch (e) {
            console.error('Error al cargar catálogo de roles comerciales:', e);
            return [];
        }
    }

    function resolveOpportunity(oppId) {
        if (activeOpp && activeOpp.id === oppId) return activeOpp;
        const list = _deps.getProspects();
        const found = list.find(x => x && x.id === oppId);
        if (found) activeOpp = found;
        return activeOpp;
    }

    // -------------------------------------------------------------------------
    // 1. Render Participants on Opportunity Detail
    // -------------------------------------------------------------------------

    async function renderOpportunityParticipants(p) {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('opportunity-participants-card');
        if (!container) return;

        if (!p) {
            container.style.display = 'none';
            container.innerHTML = '';
            activeOpp = null;
            return;
        }

        activeOpp = p;
        container.style.display = 'block';

        const fb = _deps.getFirebase();
        const sdk = _deps.getCrmOpportunityContacts();
        const currentUser = _deps.getCurrentUser();
        const isManager = currentUser && currentUser.role === 'manager';
        const isAssigned = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
        const canManage = isManager || isAssigned || (currentUser && currentUser.role === 'gestor');

        const canChangeAccount = p.estado === 'activo' && p.etapa === 'prospecto' && canManage && (
            !(Array.isArray(p.cotizaciones) && p.cotizaciones.length > 0) &&
            !(p.datos && Array.isArray(p.datos.doc_oferta) && p.datos.doc_oferta.length > 0) &&
            !(Array.isArray(p.doc_oferta) && p.doc_oferta.length > 0) &&
            !(p.datos && Array.isArray(p.datos.doc_costos) && p.datos.doc_costos.length > 0) &&
            !(Array.isArray(p.doc_costos) && p.doc_costos.length > 0) &&
            !(p.precio_cotizado && Number(p.precio_cotizado) > 0) &&
            !(p.costo_venta && Number(p.costo_venta) > 0) &&
            !p.activeQuoteId &&
            !p.cotizacion
        );

        // Loading state
        container.innerHTML = `
            <div class="opp-participants-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <h3 style="margin: 0; font-size: 1.05rem; color: white;">👥 Participantes Comerciales</h3>
                    <span class="badge bg-neutral" style="font-size: 0.75rem;">Cargando...</span>
                </div>
            </div>
            <div style="padding: 1.5rem; text-align: center; color: var(--text-secondary);">
                Cargando participantes del proceso comercial...
            </div>
        `;

        let participants = [];
        let primaryId = p.primaryOpportunityContactId || null;

        if (fb && sdk) {
            try {
                const res = await sdk.listOpportunityContacts(fb, {
                    opportunityId: p.id,
                    includeInactive: false,
                    dbSuffix: _deps.getDbSuffix()
                });
                participants = (res && Array.isArray(res.contacts)) ? res.contacts : [];
                if (res && res.primaryOpportunityContactId) primaryId = res.primaryOpportunityContactId;
                participantsCache.set(p.id, { contacts: participants, primaryId });
            } catch (err) {
                console.warn('Error al consultar participantes de la oportunidad:', err);
                const cached = participantsCache.get(p.id);
                if (cached) {
                    participants = cached.contacts;
                    primaryId = cached.primaryId;
                }
            }
        }

        const countBadge = participants.length > 0
            ? `<span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 0.75rem;">${participants.length} participante${participants.length === 1 ? '' : 's'}</span>`
            : `<span class="badge bg-neutral" style="font-size: 0.75rem;">0 participantes</span>`;

        const addBtn = (canManage && p.estado === 'activo')
            ? `<button type="button" class="btn-primary" style="padding: 4px 10px; font-size: 0.78rem;" onclick="openAddOpportunityContactView('${p.id}', '${p.clientId}')">+ Agregar Participante</button>`
            : '';

        const changeAccBtn = canChangeAccount
            ? `<button type="button" class="btn-secondary" style="padding: 4px 10px; font-size: 0.78rem;" onclick="openChangeOpportunityAccountView('${p.id}')" title="Transferir oportunidad a otra cuenta antes de emitir ofertas">🔄 Cambiar Cuenta</button>`
            : '';

        let contentHtml = '';
        if (participants.length === 0) {
            contentHtml = `
                <div style="padding: 1.25rem; text-align: center; background: rgba(0,0,0,0.15); border-radius: 6px; border: 1px dashed var(--panel-border);">
                    <div style="font-size: 1.5rem; margin-bottom: 6px;">👥</div>
                    <p style="color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 0.5rem 0;">
                        No hay participantes asignados a esta oportunidad comercial.
                    </p>
                    <small style="color: var(--text-muted); display: block;">
                        Asigna decisores, evaluadores técnicos y compradores económicos desde los contactos de la cuenta para estructurar el seguimiento comercial.
                    </small>
                </div>
            `;
        } else {
            const itemsHtml = participants.map(part => {
                const isPrimary = Boolean(part.isPrimary) || (primaryId === part.id);
                const snap = part.contactSnapshot || {};
                const name = snap.nombre || 'Contacto sin nombre';
                const cargo = snap.cargo || 'Cargo no especificado';
                const roleName = part.roleName || part.roleId || 'Participante';
                const phone = snap.telefono || '';
                const email = snap.correo || '';
                const ext = snap.extension ? ` Ext. ${snap.extension}` : '';

                const primaryBadge = isPrimary
                    ? `<span class="badge" style="background: rgba(212, 175, 55, 0.2); color: var(--brand-gold); border: 1px solid var(--brand-gold); font-size: 0.72rem; font-weight: 700;">⭐ Contacto Principal</span>`
                    : '';

                const roleBadge = `<span class="badge" style="background: rgba(99, 102, 241, 0.18); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.4); font-size: 0.72rem;">🏷️ ${_deps.esc(roleName)}</span>`;

                const phoneLink = phone
                    ? `<a href="tel:${phone.replace(/[^\d+]/g, '')}" class="contact-channel-pill contact-channel-tel" style="padding: 2px 7px; font-size: 0.72rem;" title="Llamar">📞 <span>${_deps.esc(phone)}${_deps.esc(ext)}</span></a>`
                    : '';

                const emailLink = email
                    ? `<a href="mailto:${encodeURIComponent(email)}" class="contact-channel-pill contact-channel-email" style="padding: 2px 7px; font-size: 0.72rem;" title="Enviar correo">✉️ <span>${_deps.esc(email)}</span></a>`
                    : '';

                const notesHtml = part.notes
                    ? `<div style="font-size: 0.76rem; color: var(--text-secondary); margin-top: 5px; font-style: italic; background: rgba(0,0,0,0.12); padding: 4px 8px; border-radius: 4px;">📝 ${_deps.esc(part.notes)}</div>`
                    : '';

                // Actions
                let actionsHtml = '';
                if (canManage && p.estado === 'activo') {
                    const makePrimaryBtn = !isPrimary
                        ? `<button type="button" class="btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; color: var(--brand-gold);" onclick="openSetOpportunityPrimaryContactView('${p.id}', '${part.id}')" title="Designar como contacto principal de esta oportunidad">⭐ Hacer Principal</button>`
                        : '';
                    const editRoleBtn = `<button type="button" class="btn-secondary" style="padding: 2px 7px; font-size: 0.72rem;" onclick="openEditOpportunityContactRoleView('${p.id}', '${part.id}')" title="Modificar rol o notas">✏️ Rol / Notas</button>`;
                    const removeBtn = `<button type="button" class="btn-danger" style="padding: 2px 7px; font-size: 0.72rem;" onclick="openRemoveOpportunityContactView('${p.id}', '${part.id}')" title="Retirar participante de la oportunidad">✕ Retirar</button>`;

                    actionsHtml = `
                        <div style="display: flex; gap: 0.4rem; align-items: center; margin-top: 6px;">
                            ${makePrimaryBtn}
                            ${editRoleBtn}
                            ${removeBtn}
                        </div>
                    `;
                }

                return `
                    <div class="opp-participant-item" style="background: rgba(255,255,255,0.03); border: 1px solid var(--panel-border); border-radius: 6px; padding: 0.75rem; display: flex; flex-direction: column; gap: 4px; ${isPrimary ? 'border-left: 3px solid var(--brand-gold);' : ''}">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 6px;">
                            <div>
                                <span style="font-weight: 600; color: white; font-size: 0.92rem;">${_deps.esc(name)}</span>
                                <span style="color: var(--text-secondary); font-size: 0.8rem; margin-left: 6px;">— ${_deps.esc(cargo)}</span>
                            </div>
                            <div style="display: flex; gap: 6px; align-items: center;">
                                ${primaryBadge}
                                ${roleBadge}
                            </div>
                        </div>
                        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 2px;">
                            ${phoneLink}
                            ${emailLink}
                        </div>
                        ${notesHtml}
                        ${actionsHtml}
                    </div>
                `;
            }).join('');

            contentHtml = `<div style="display: flex; flex-direction: column; gap: 0.6rem;">${itemsHtml}</div>`;
        }

        container.innerHTML = `
            <div class="opp-participants-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <h3 style="margin: 0; font-size: 1.05rem; color: white;">👥 Participantes Comerciales</h3>
                    ${countBadge}
                </div>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    ${changeAccBtn}
                    ${addBtn}
                </div>
            </div>
            ${contentHtml}
        `;
    }

    // -------------------------------------------------------------------------
    // 2. Full-Screen View 1: Add Participant from Account Contacts
    // -------------------------------------------------------------------------

    async function openAddOpportunityContactView(opportunityId, accountId) {
        const opp = resolveOpportunity(opportunityId);
        const accId = accountId || (opp ? opp.clientId : '');

        // Populate Context Banner
        const prjEl = document.getElementById('add-opp-context-project');
        if (prjEl) prjEl.textContent = (opp && opp.proyecto) ? opp.proyecto : '-';
        const codeEl = document.getElementById('add-opp-context-code');
        if (codeEl) codeEl.textContent = (opp && opp.codigo) ? opp.codigo : '-';
        const accEl = document.getElementById('add-opp-context-account');
        if (accEl) accEl.textContent = _deps.getClientName(accId);
        const stageEl = document.getElementById('add-opp-context-stage');
        if (stageEl) stageEl.textContent = (opp && opp.etapa) ? opp.etapa : '-';
        const vendorEl = document.getElementById('add-opp-context-vendor');
        if (vendorEl) vendorEl.textContent = (opp && opp.vendedorName) ? opp.vendedorName : ((opp && opp.vendedorId) ? opp.vendedorId : 'Sin asignar');

        document.getElementById('add-opp-contact-opp-id').value = opportunityId;
        document.getElementById('add-opp-contact-acc-id').value = accId;
        document.getElementById('add-opp-contact-notes').value = '';
        document.getElementById('add-opp-contact-is-primary').checked = false;
        setStatusBanner('add-opp-contact-status', null);

        const selectContact = document.getElementById('add-opp-contact-select');
        const selectRole = document.getElementById('add-opp-contact-role-select');
        if (selectContact) selectContact.innerHTML = '<option value="">Cargando contactos de la cuenta...</option>';
        if (selectRole) selectRole.innerHTML = '<option value="">Cargando roles comerciales...</option>';

        _deps.showView('add-opportunity-contact-view');

        const fb = _deps.getFirebase();
        const contactsSdk = _deps.getCrmContacts();
        const suffix = _deps.getDbSuffix();

        try {
            const [roles, contactsRes] = await Promise.all([
                loadRoles(),
                contactsSdk ? contactsSdk.listAccountContacts(fb, { accountId: accId, includeInactive: false, dbSuffix: suffix }) : { contacts: [] }
            ]);

            const cached = participantsCache.get(opportunityId);
            const activeContactIds = new Set((cached && cached.contacts) ? cached.contacts.map(c => c.accountContactId) : []);

            const accountContacts = (contactsRes && Array.isArray(contactsRes.contacts)) ? contactsRes.contacts : [];
            const availableContacts = accountContacts.filter(ac => !activeContactIds.has(ac.id));

            if (selectContact) {
                if (availableContacts.length === 0) {
                    selectContact.innerHTML = '<option value="">(No hay más contactos activos disponibles en esta cuenta)</option>';
                } else {
                    selectContact.innerHTML = '<option value="">-- Selecciona un contacto de la cuenta --</option>' +
                        availableContacts.map(ac => {
                            const name = ac.persona ? `${ac.persona.nombres || ''} ${ac.persona.apellidos || ''}`.trim() : (ac.cargo || ac.id);
                            const cargo = ac.cargo ? ` (${ac.cargo})` : '';
                            return `<option value="${_deps.esc(ac.id)}">${_deps.esc(name)}${_deps.esc(cargo)}</option>`;
                        }).join('');
                }
            }

            if (selectRole) {
                if (roles.length === 0) {
                    selectRole.innerHTML = '<option value="">(No hay roles disponibles)</option>';
                } else {
                    selectRole.innerHTML = '<option value="">-- Selecciona el rol de compra/decisión --</option>' +
                        roles.map(r => `<option value="${_deps.esc(r.id)}">${_deps.esc(r.name)}</option>`).join('');
                }
            }
        } catch (e) {
            console.error('Error al inicializar vista de asignación de participante:', e);
            setStatusBanner('add-opp-contact-status', 'error', 'No se pudieron cargar los contactos o roles de la cuenta.');
        }
    }

    function closeAddOpportunityContactView() {
        cancelOpportunityContactOperation();
    }

    async function submitAddOpportunityContact(event) {
        if (event) event.preventDefault();
        const oppId = document.getElementById('add-opp-contact-opp-id').value;
        const acId = document.getElementById('add-opp-contact-select').value;
        const roleId = document.getElementById('add-opp-contact-role-select').value;
        const notes = document.getElementById('add-opp-contact-notes').value.trim();
        const isPrimary = document.getElementById('add-opp-contact-is-primary').checked;

        if (!acId) return setStatusBanner('add-opp-contact-status', 'error', 'Debes seleccionar un contacto de la cuenta.');
        if (!roleId) return setStatusBanner('add-opp-contact-status', 'error', 'Debes seleccionar un rol comercial.');

        const btn = document.getElementById('btn-submit-add-opp-contact');
        if (btn) { btn.disabled = true; btn.textContent = 'Asignando...'; }
        setStatusBanner('add-opp-contact-status', 'loading', 'Asignando participante a la oportunidad...');

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.addOpportunityContact(fb, {
                opportunityId: oppId,
                accountContactId: acId,
                roleId: roleId,
                notes: notes,
                isPrimary: isPrimary,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('add-opp-contact-status', 'success', 'Participante asignado correctamente. Regresando a la ficha...');
            notify('success', 'Participante asignado correctamente a la oportunidad.');

            if (activeOpp && activeOpp.id === oppId && isPrimary) {
                activeOpp.primaryOpportunityContactId = `OC_${oppId}_${acId}`;
            }

            setTimeout(() => {
                cancelOpportunityContactOperation();
            }, 400);
        } catch (e) {
            console.error('Error al asignar participante:', e);
            setStatusBanner('add-opp-contact-status', 'error', e.message || 'Error al asignar el participante.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Asignar a Oportunidad'; }
        }
    }

    // -------------------------------------------------------------------------
    // 3. Full-Screen View 2: Edit Participant Role and Notes
    // -------------------------------------------------------------------------

    async function openEditOpportunityContactRoleView(opportunityId, participantId) {
        const opp = resolveOpportunity(opportunityId);
        const cached = participantsCache.get(opportunityId);
        const part = (cached && cached.contacts) ? cached.contacts.find(c => c.id === participantId) : null;
        if (!part) return notify('error', 'No se encontró el participante seleccionado.');

        targetParticipantForAction = part;

        // Context Banner
        const prjEl = document.getElementById('edit-opp-context-project');
        if (prjEl) prjEl.textContent = (opp && opp.proyecto) ? opp.proyecto : '-';
        const accEl = document.getElementById('edit-opp-context-account');
        if (accEl) accEl.textContent = opp ? _deps.getClientName(opp.clientId) : '-';

        const nameEl = document.getElementById('edit-opp-contact-name');
        if (nameEl) nameEl.textContent = part.contactSnapshot ? part.contactSnapshot.nombre : 'Participante';
        const cargoEl = document.getElementById('edit-opp-contact-cargo');
        if (cargoEl) cargoEl.textContent = part.contactSnapshot ? (part.contactSnapshot.cargo || 'Cargo no especificado') : '-';

        const badgePri = document.getElementById('edit-opp-contact-badge-primary');
        const badgeSec = document.getElementById('edit-opp-contact-badge-sec');
        if (part.isPrimary) {
            if (badgePri) badgePri.style.display = 'inline-block';
            if (badgeSec) badgeSec.style.display = 'none';
        } else {
            if (badgePri) badgePri.style.display = 'none';
            if (badgeSec) badgeSec.style.display = 'inline-block';
        }

        document.getElementById('edit-opp-contact-id').value = participantId;
        document.getElementById('edit-opp-contact-opp-id').value = opportunityId;
        document.getElementById('edit-opp-contact-notes').value = part.notes || '';
        setStatusBanner('edit-opp-contact-status', null);

        const selectRole = document.getElementById('edit-opp-contact-role-select');
        if (selectRole) selectRole.innerHTML = '<option value="">Cargando roles...</option>';

        _deps.showView('edit-opportunity-contact-view');

        const roles = await loadRoles();
        if (selectRole) {
            selectRole.innerHTML = roles.map(r =>
                `<option value="${_deps.esc(r.id)}" ${r.id === part.roleId ? 'selected' : ''}>${_deps.esc(r.name)}</option>`
            ).join('');
        }
    }

    function closeEditOpportunityContactRoleView() {
        cancelOpportunityContactOperation();
    }

    async function submitEditOpportunityContactRole(event) {
        if (event) event.preventDefault();
        const partId = document.getElementById('edit-opp-contact-id').value;
        const oppId = document.getElementById('edit-opp-contact-opp-id').value;
        const roleId = document.getElementById('edit-opp-contact-role-select').value;
        const notes = document.getElementById('edit-opp-contact-notes').value.trim();

        if (!roleId) return setStatusBanner('edit-opp-contact-status', 'error', 'Debes seleccionar un rol comercial.');

        const btn = document.getElementById('btn-submit-edit-opp-contact');
        if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
        setStatusBanner('edit-opp-contact-status', 'loading', 'Guardando cambios del participante...');

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.updateOpportunityContactRole(fb, {
                opportunityContactId: partId,
                roleId: roleId,
                notes: notes,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('edit-opp-contact-status', 'success', 'Rol y notas actualizados. Regresando a la ficha...');
            notify('success', 'Rol y notas del participante actualizados.');

            setTimeout(() => {
                cancelOpportunityContactOperation();
            }, 400);
        } catch (e) {
            console.error('Error al actualizar participante:', e);
            setStatusBanner('edit-opp-contact-status', 'error', e.message || 'Error al actualizar el participante.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Guardar Cambios'; }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Full-Screen View 3: Set / Change Primary Contact
    // -------------------------------------------------------------------------

    async function openSetOpportunityPrimaryContactView(opportunityId, participantId) {
        const opp = resolveOpportunity(opportunityId);
        const cached = participantsCache.get(opportunityId);
        const part = (cached && cached.contacts) ? cached.contacts.find(c => c.id === participantId) : null;
        if (!part) return notify('error', 'No se encontró el participante seleccionado.');

        targetParticipantForAction = part;

        // Context Banner
        const prjEl = document.getElementById('set-primary-context-project');
        if (prjEl) prjEl.textContent = (opp && opp.proyecto) ? opp.proyecto : '-';
        const accEl = document.getElementById('set-primary-context-account');
        if (accEl) accEl.textContent = opp ? _deps.getClientName(opp.clientId) : '-';

        // Current primary details
        const currPrimaryId = (cached && cached.primaryId) || (opp ? opp.primaryOpportunityContactId : null);
        const currentPrimaryPart = (cached && cached.contacts) ? cached.contacts.find(c => c.id === currPrimaryId) : null;

        const curNameEl = document.getElementById('set-primary-current-name');
        const curCargoEl = document.getElementById('set-primary-current-cargo');
        if (currentPrimaryPart && currentPrimaryPart.contactSnapshot) {
            if (curNameEl) curNameEl.textContent = currentPrimaryPart.contactSnapshot.nombre;
            if (curCargoEl) curCargoEl.textContent = `${currentPrimaryPart.contactSnapshot.cargo || 'Cargo no especificado'} (${currentPrimaryPart.roleName || currentPrimaryPart.roleId || 'Participante'})`;
        } else if (opp && opp.primaryContactSnapshot && opp.primaryContactSnapshot.nombre) {
            if (curNameEl) curNameEl.textContent = opp.primaryContactSnapshot.nombre;
            if (curCargoEl) curCargoEl.textContent = opp.primaryContactSnapshot.cargo || 'Cargo no especificado';
        } else {
            if (curNameEl) curNameEl.textContent = '(Ninguno asignado)';
            if (curCargoEl) curCargoEl.textContent = 'La oportunidad no cuenta actualmente con un contacto principal.';
        }

        // Proposed primary details
        const targetNameEl = document.getElementById('set-primary-target-name');
        const targetCargoEl = document.getElementById('set-primary-target-cargo');
        const targetRoleEl = document.getElementById('set-primary-target-role');
        const snap = part.contactSnapshot || {};
        if (targetNameEl) targetNameEl.textContent = snap.nombre || 'Contacto';
        if (targetCargoEl) targetCargoEl.textContent = snap.cargo || 'Cargo no especificado';
        if (targetRoleEl) targetRoleEl.textContent = `🏷️ ${part.roleName || part.roleId || 'Participante'}`;

        document.getElementById('set-primary-opp-id').value = opportunityId;
        document.getElementById('set-primary-part-id').value = participantId;
        setStatusBanner('set-primary-status', null);

        _deps.showView('set-opportunity-primary-contact-view');
    }

    async function confirmSetOpportunityPrimaryContact() {
        const oppId = document.getElementById('set-primary-opp-id').value;
        const partId = document.getElementById('set-primary-part-id').value;

        const btn = document.getElementById('btn-confirm-set-primary');
        if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
        setStatusBanner('set-primary-status', 'loading', 'Actualizando contacto comercial principal bajo control de concurrencia...');

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.setOpportunityPrimaryContact(fb, {
                opportunityId: oppId,
                opportunityContactId: partId,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('set-primary-status', 'success', 'Contacto comercial principal actualizado. Regresando a la ficha...');
            notify('success', 'Contacto comercial principal actualizado correctamente.');

            if (activeOpp && activeOpp.id === oppId) {
                activeOpp.primaryOpportunityContactId = partId;
                if (targetParticipantForAction) {
                    activeOpp.primaryContactSnapshot = targetParticipantForAction.contactSnapshot || null;
                }
            }

            setTimeout(() => {
                cancelOpportunityContactOperation();
            }, 400);
        } catch (e) {
            console.error('Error al designar contacto principal:', e);
            setStatusBanner('set-primary-status', 'error', e.message || 'Error al designar contacto principal.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '⭐ Confirmar Contacto Principal'; }
        }
    }

    // -------------------------------------------------------------------------
    // 5. Full-Screen View 4: Remove Participant
    // -------------------------------------------------------------------------

    async function openRemoveOpportunityContactView(opportunityId, participantId) {
        const opp = resolveOpportunity(opportunityId);
        const cached = participantsCache.get(opportunityId);
        const part = (cached && cached.contacts) ? cached.contacts.find(c => c.id === participantId) : null;
        if (!part) return notify('error', 'No se encontró el participante seleccionado.');

        targetParticipantForAction = part;

        // Context Banner
        const prjEl = document.getElementById('remove-opp-context-project');
        if (prjEl) prjEl.textContent = (opp && opp.proyecto) ? opp.proyecto : '-';
        const accEl = document.getElementById('remove-opp-context-account');
        if (accEl) accEl.textContent = opp ? _deps.getClientName(opp.clientId) : '-';

        const nameEl = document.getElementById('remove-opp-contact-name');
        const cargoEl = document.getElementById('remove-opp-contact-cargo');
        const roleEl = document.getElementById('remove-opp-contact-role');
        const snap = part.contactSnapshot || {};
        if (nameEl) nameEl.textContent = snap.nombre || 'Contacto';
        if (cargoEl) cargoEl.textContent = snap.cargo || 'Cargo no especificado';
        if (roleEl) roleEl.textContent = `🏷️ ${part.roleName || part.roleId || 'Participante'}`;

        // Primary Warning
        const isPrimary = Boolean(part.isPrimary) || (opp && opp.primaryOpportunityContactId === participantId);
        const warnEl = document.getElementById('remove-opp-primary-warning');
        if (warnEl) warnEl.style.display = isPrimary ? 'block' : 'none';

        document.getElementById('remove-opp-contact-id').value = participantId;
        document.getElementById('remove-opp-contact-opp-id').value = opportunityId;
        document.getElementById('remove-opp-contact-motivo').value = '';
        setStatusBanner('remove-opp-contact-status', null);

        _deps.showView('remove-opportunity-contact-view');
    }

    async function confirmRemoveOpportunityContact(event) {
        if (event) event.preventDefault();
        const partId = document.getElementById('remove-opp-contact-id').value;
        const oppId = document.getElementById('remove-opp-contact-opp-id').value;
        const reason = document.getElementById('remove-opp-contact-motivo').value.trim();

        if (!reason) {
            return setStatusBanner('remove-opp-contact-status', 'error', 'Debes especificar el motivo del retiro de este participante.');
        }

        const btn = document.getElementById('btn-confirm-remove-contact');
        if (btn) { btn.disabled = true; btn.textContent = 'Retirando...'; }
        setStatusBanner('remove-opp-contact-status', 'loading', 'Retirando participante de la oportunidad...');

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.removeOpportunityContact(fb, {
                opportunityContactId: partId,
                motivo: reason,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('remove-opp-contact-status', 'success', 'Participante retirado correctamente. Regresando a la ficha...');
            notify('success', 'Participante retirado de la oportunidad.');

            if (activeOpp && activeOpp.id === oppId) {
                if (activeOpp.primaryOpportunityContactId === partId) {
                    activeOpp.primaryOpportunityContactId = null;
                    activeOpp.primaryContactSnapshot = null;
                }
            }

            setTimeout(() => {
                cancelOpportunityContactOperation();
            }, 400);
        } catch (e) {
            console.error('Error al retirar participante:', e);
            setStatusBanner('remove-opp-contact-status', 'error', e.message || 'Error al retirar el participante.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🛑 Confirmar Retiro de Participante'; }
        }
    }

    // -------------------------------------------------------------------------
    // 6. Full-Screen View 5: Change Opportunity Account
    // -------------------------------------------------------------------------

    function openChangeOpportunityAccountView(opportunityId) {
        const opp = resolveOpportunity(opportunityId);

        // Context Banner
        const prjEl = document.getElementById('change-acc-context-project');
        if (prjEl) prjEl.textContent = (opp && opp.proyecto) ? opp.proyecto : '-';
        const codeEl = document.getElementById('change-acc-context-code');
        if (codeEl) codeEl.textContent = (opp && opp.codigo) ? opp.codigo : '-';
        const currentAccEl = document.getElementById('change-acc-context-current-account');
        if (currentAccEl) currentAccEl.textContent = opp ? _deps.getClientName(opp.clientId) : '-';
        const stageEl = document.getElementById('change-acc-context-stage');
        if (stageEl) stageEl.textContent = (opp && opp.etapa) ? opp.etapa : '-';

        document.getElementById('change-opp-acc-opp-id').value = opportunityId;
        document.getElementById('change-opp-acc-motivo').value = '';
        setStatusBanner('change-opp-acc-status', null);

        const selectClient = document.getElementById('change-opp-acc-client-select');
        const clients = _deps.getClients();
        const currentClientId = opp ? opp.clientId : '';

        const otherClients = clients.filter(c => c.id !== currentClientId);
        if (selectClient) {
            selectClient.innerHTML = '<option value="">-- Selecciona la nueva cuenta comercial --</option>' +
                otherClients.map(c => {
                    const name = c.empresa || [c.nombres, c.apellidos].filter(Boolean).join(' ') || c.id;
                    return `<option value="${_deps.esc(c.id)}">${_deps.esc(name)}</option>`;
                }).join('');
        }

        _deps.showView('change-opportunity-account-view');
    }

    function closeChangeOpportunityAccountView() {
        cancelOpportunityContactOperation();
    }

    async function submitChangeOpportunityAccount(event) {
        if (event) event.preventDefault();
        const oppId = document.getElementById('change-opp-acc-opp-id').value;
        const newAccId = document.getElementById('change-opp-acc-client-select').value;
        const reason = document.getElementById('change-opp-acc-motivo').value.trim();

        if (!newAccId) return setStatusBanner('change-opp-acc-status', 'error', 'Debes seleccionar la nueva cuenta comercial.');
        if (!reason) return setStatusBanner('change-opp-acc-status', 'error', 'Debes especificar el motivo de la transferencia de cuenta.');

        const btn = document.getElementById('btn-submit-change-opp-acc');
        if (btn) { btn.disabled = true; btn.textContent = 'Transfiriendo...'; }
        setStatusBanner('change-opp-acc-status', 'loading', 'Transfiriendo oportunidad y desvinculando participantes históricos...');

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.changeOpportunityAccount(fb, {
                opportunityId: oppId,
                newAccountId: newAccId,
                motivo: reason,
                dbSuffix: _deps.getDbSuffix()
            });

            setStatusBanner('change-opp-acc-status', 'success', 'Cuenta comercial actualizada. Regresando a la ficha...');
            notify('success', 'Cuenta comercial actualizada. Los participantes anteriores se han preservado como históricos.');

            if (activeOpp && activeOpp.id === oppId) {
                activeOpp.clientId = newAccId;
                activeOpp.primaryOpportunityContactId = null;
                activeOpp.primaryContactSnapshot = null;

                const detailClientEl = document.getElementById('detail-cliente');
                if (detailClientEl) detailClientEl.textContent = _deps.getClientName(newAccId);
            }

            setTimeout(() => {
                cancelOpportunityContactOperation();
            }, 400);
        } catch (e) {
            console.error('Error al cambiar la cuenta de la oportunidad:', e);
            setStatusBanner('change-opp-acc-status', 'error', e.message || 'Error al cambiar la cuenta.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Confirmar Cambio de Cuenta'; }
        }
    }

    return {
        renderOpportunityParticipants,
        // Full-Screen Views
        openAddOpportunityContactView,
        closeAddOpportunityContactView,
        submitAddOpportunityContact,
        openEditOpportunityContactRoleView,
        closeEditOpportunityContactRoleView,
        submitEditOpportunityContactRole,
        openSetOpportunityPrimaryContactView,
        confirmSetOpportunityPrimaryContact,
        openRemoveOpportunityContactView,
        confirmRemoveOpportunityContact,
        openChangeOpportunityAccountView,
        closeChangeOpportunityAccountView,
        submitChangeOpportunityAccount,
        cancelOpportunityContactOperation,
        // Aliases for compatibility
        openAddOpportunityContactModal: openAddOpportunityContactView,
        closeAddOpportunityContactModal: cancelOpportunityContactOperation,
        openEditOpportunityContactRoleModal: openEditOpportunityContactRoleView,
        closeEditOpportunityContactRoleModal: cancelOpportunityContactOperation,
        openChangeOpportunityAccountModal: openChangeOpportunityAccountView,
        closeChangeOpportunityAccountModal: cancelOpportunityContactOperation,
        setOpportunityPrimaryContact: openSetOpportunityPrimaryContactView,
        removeOpportunityParticipant: openRemoveOpportunityContactView
    };
});
