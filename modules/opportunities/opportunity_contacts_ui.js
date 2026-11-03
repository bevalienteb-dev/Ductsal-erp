// ============================================================================
// DUCTSAL ERP — OPPORTUNITIES MODULE: CONTACTS & ROLES UI (Fase 2 Bloque 2 - B2)
// Archivo: modules/opportunities/opportunity_contacts_ui.js
// Responsabilidad:
// 1. Visualización de participantes comerciales de una oportunidad.
// 2. Asignación de participantes desde los contactos activos de la cuenta (B1).
// 3. Selección y snapshot del rol comercial de decisión y compra.
// 4. Designación y sustitución atómica del contacto comercial principal (SSOT).
// 5. Retiro / inactivación de participantes y sincronización de principal.
// 6. Cambio de cuenta en etapa 'prospecto' sin cotización activa.
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
            window.openAddOpportunityContactModal = api.openAddOpportunityContactModal;
            window.closeAddOpportunityContactModal = api.closeAddOpportunityContactModal;
            window.submitAddOpportunityContact = api.submitAddOpportunityContact;
            window.openEditOpportunityContactRoleModal = api.openEditOpportunityContactRoleModal;
            window.closeEditOpportunityContactRoleModal = api.closeEditOpportunityContactRoleModal;
            window.submitEditOpportunityContactRole = api.submitEditOpportunityContactRole;
            window.setOpportunityPrimaryContact = api.setOpportunityPrimaryContact;
            window.removeOpportunityParticipant = api.removeOpportunityParticipant;
            window.openChangeOpportunityAccountModal = api.openChangeOpportunityAccountModal;
            window.closeChangeOpportunityAccountModal = api.closeChangeOpportunityAccountModal;
            window.submitChangeOpportunityAccount = api.submitChangeOpportunityAccount;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // Internal state cache for participants
    const participantsCache = new Map(); // oppId -> { contacts: [], primaryId: null }
    let rolesCache = null;
    let activeOpp = null;

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
        } else if (typeof alert === 'function' && type === 'error') {
            alert(msg);
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
            !(p.precio_cotizado && Number(p.precio_cotizado) > 0) &&
            !p.activeQuoteId
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
            ? `<button type="button" class="btn-primary" style="padding: 4px 10px; font-size: 0.78rem;" onclick="openAddOpportunityContactModal('${p.id}', '${p.clientId}')">+ Agregar Participante</button>`
            : '';

        const changeAccBtn = canChangeAccount
            ? `<button type="button" class="btn-secondary" style="padding: 4px 10px; font-size: 0.78rem;" onclick="openChangeOpportunityAccountModal('${p.id}')" title="Cambiar cuenta antes de emitir cotizaciones">🔄 Cambiar Cuenta</button>`
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
                        ? `<button type="button" class="btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; color: var(--brand-gold);" onclick="setOpportunityPrimaryContact('${p.id}', '${part.id}')" title="Designar como contacto principal de esta oportunidad">⭐ Hacer Principal</button>`
                        : '';
                    const editRoleBtn = `<button type="button" class="btn-secondary" style="padding: 2px 7px; font-size: 0.72rem;" onclick="openEditOpportunityContactRoleModal('${p.id}', '${part.id}')" title="Modificar rol o notas">✏️ Rol / Notas</button>`;
                    const removeBtn = `<button type="button" class="btn-danger" style="padding: 2px 7px; font-size: 0.72rem;" onclick="removeOpportunityParticipant('${p.id}', '${part.id}')" title="Retirar participante de la oportunidad">✕ Retirar</button>`;

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
    // 2. Modals: Add Participant from Account Contacts
    // -------------------------------------------------------------------------

    async function openAddOpportunityContactModal(opportunityId, accountId) {
        const modal = document.getElementById('modal-add-opportunity-contact');
        if (!modal) return;

        document.getElementById('add-opp-contact-opp-id').value = opportunityId;
        document.getElementById('add-opp-contact-acc-id').value = accountId;
        document.getElementById('add-opp-contact-notes').value = '';
        document.getElementById('add-opp-contact-is-primary').checked = false;

        const selectContact = document.getElementById('add-opp-contact-select');
        const selectRole = document.getElementById('add-opp-contact-role-select');
        selectContact.innerHTML = '<option value="">Cargando contactos de la cuenta...</option>';
        selectRole.innerHTML = '<option value="">Cargando roles comerciales...</option>';

        modal.style.display = 'block';

        const fb = _deps.getFirebase();
        const contactsSdk = _deps.getCrmContacts();
        const suffix = _deps.getDbSuffix();

        // Load roles and account contacts in parallel
        try {
            const [roles, contactsRes] = await Promise.all([
                loadRoles(),
                contactsSdk ? contactsSdk.listAccountContacts(fb, { accountId, includeInactive: false, dbSuffix: suffix }) : { contacts: [] }
            ]);

            // Exclude already active participants in this opportunity
            const cached = participantsCache.get(opportunityId);
            const activeContactIds = new Set((cached && cached.contacts) ? cached.contacts.map(c => c.accountContactId) : []);

            const accountContacts = (contactsRes && Array.isArray(contactsRes.contacts)) ? contactsRes.contacts : [];
            const availableContacts = accountContacts.filter(ac => !activeContactIds.has(ac.id));

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

            if (roles.length === 0) {
                selectRole.innerHTML = '<option value="">(No hay roles disponibles)</option>';
            } else {
                selectRole.innerHTML = '<option value="">-- Selecciona el rol de compra/decisión --</option>' +
                    roles.map(r => `<option value="${_deps.esc(r.id)}">${_deps.esc(r.name)}</option>`).join('');
            }
        } catch (e) {
            console.error('Error al inicializar modal de participante:', e);
            selectContact.innerHTML = '<option value="">Error al cargar contactos</option>';
            selectRole.innerHTML = '<option value="">Error al cargar roles</option>';
        }
    }

    function closeAddOpportunityContactModal() {
        const modal = document.getElementById('modal-add-opportunity-contact');
        if (modal) modal.style.display = 'none';
    }

    async function submitAddOpportunityContact(event) {
        if (event) event.preventDefault();
        const oppId = document.getElementById('add-opp-contact-opp-id').value;
        const acId = document.getElementById('add-opp-contact-select').value;
        const roleId = document.getElementById('add-opp-contact-role-select').value;
        const notes = document.getElementById('add-opp-contact-notes').value.trim();
        const isPrimary = document.getElementById('add-opp-contact-is-primary').checked;

        if (!acId) return notify('error', 'Debes seleccionar un contacto de la cuenta.');
        if (!roleId) return notify('error', 'Debes seleccionar un rol comercial.');

        const btn = document.getElementById('btn-submit-add-opp-contact');
        if (btn) { btn.disabled = true; btn.textContent = 'Asignando...'; }

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

            notify('success', 'Participante asignado correctamente a la oportunidad.');
            closeAddOpportunityContactModal();

            // Refresh prospect if primary was assigned
            if (activeOpp && activeOpp.id === oppId && isPrimary) {
                activeOpp.primaryOpportunityContactId = `OC_${oppId}_${acId}`;
            }
            if (activeOpp && activeOpp.id === oppId) {
                renderOpportunityParticipants(activeOpp);
            }
        } catch (e) {
            console.error('Error al asignar participante:', e);
            notify('error', e.message || 'Error al asignar el participante.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Asignar a Oportunidad'; }
        }
    }

    // -------------------------------------------------------------------------
    // 3. Edit Role / Notes Modal
    // -------------------------------------------------------------------------

    async function openEditOpportunityContactRoleModal(opportunityId, participantId) {
        const modal = document.getElementById('modal-edit-opportunity-contact');
        if (!modal) return;

        const cached = participantsCache.get(opportunityId);
        const part = (cached && cached.contacts) ? cached.contacts.find(c => c.id === participantId) : null;
        if (!part) return notify('error', 'No se encontró el participante seleccionado.');

        document.getElementById('edit-opp-contact-id').value = participantId;
        document.getElementById('edit-opp-contact-opp-id').value = opportunityId;
        document.getElementById('edit-opp-contact-name').textContent = part.contactSnapshot ? part.contactSnapshot.nombre : 'Participante';
        document.getElementById('edit-opp-contact-notes').value = part.notes || '';

        const selectRole = document.getElementById('edit-opp-contact-role-select');
        selectRole.innerHTML = '<option value="">Cargando roles...</option>';
        modal.style.display = 'block';

        const roles = await loadRoles();
        selectRole.innerHTML = roles.map(r =>
            `<option value="${_deps.esc(r.id)}" ${r.id === part.roleId ? 'selected' : ''}>${_deps.esc(r.name)}</option>`
        ).join('');
    }

    function closeEditOpportunityContactRoleModal() {
        const modal = document.getElementById('modal-edit-opportunity-contact');
        if (modal) modal.style.display = 'none';
    }

    async function submitEditOpportunityContactRole(event) {
        if (event) event.preventDefault();
        const partId = document.getElementById('edit-opp-contact-id').value;
        const oppId = document.getElementById('edit-opp-contact-opp-id').value;
        const roleId = document.getElementById('edit-opp-contact-role-select').value;
        const notes = document.getElementById('edit-opp-contact-notes').value.trim();

        if (!roleId) return notify('error', 'Debes seleccionar un rol comercial.');

        const btn = document.getElementById('btn-submit-edit-opp-contact');
        if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.updateOpportunityContactRole(fb, {
                opportunityContactId: partId,
                roleId: roleId,
                notes: notes,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Rol y notas del participante actualizados.');
            closeEditOpportunityContactRoleModal();

            if (activeOpp && activeOpp.id === oppId) {
                renderOpportunityParticipants(activeOpp);
            }
        } catch (e) {
            console.error('Error al actualizar participante:', e);
            notify('error', e.message || 'Error al actualizar el participante.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Guardar Cambios'; }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Primary Contact Designator & Removal
    // -------------------------------------------------------------------------

    async function setOpportunityPrimaryContact(opportunityId, participantId) {
        if (!confirm('¿Deseas designar a esta persona como el Contacto Comercial Principal de la oportunidad?')) {
            return;
        }

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.setOpportunityPrimaryContact(fb, {
                opportunityId: opportunityId,
                opportunityContactId: participantId,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Contacto comercial principal actualizado correctamente.');
            if (activeOpp && activeOpp.id === opportunityId) {
                activeOpp.primaryOpportunityContactId = participantId;
                renderOpportunityParticipants(activeOpp);
            }
        } catch (e) {
            console.error('Error al designar contacto principal:', e);
            notify('error', e.message || 'Error al designar contacto principal.');
        }
    }

    async function removeOpportunityParticipant(opportunityId, participantId) {
        const reason = prompt('Indica el motivo del retiro de este participante de la oportunidad:');
        if (reason === null) return; // cancelled

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.removeOpportunityContact(fb, {
                opportunityContactId: participantId,
                motivo: reason,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Participante retirado de la oportunidad.');
            if (activeOpp && activeOpp.id === opportunityId) {
                if (activeOpp.primaryOpportunityContactId === participantId) {
                    activeOpp.primaryOpportunityContactId = null;
                    activeOpp.primaryContactSnapshot = null;
                }
                renderOpportunityParticipants(activeOpp);
            }
        } catch (e) {
            console.error('Error al retirar participante:', e);
            notify('error', e.message || 'Error al retirar participante.');
        }
    }

    // -------------------------------------------------------------------------
    // 5. Change Opportunity Account Modal
    // -------------------------------------------------------------------------

    function openChangeOpportunityAccountModal(opportunityId) {
        const modal = document.getElementById('modal-change-opportunity-account');
        if (!modal) return;

        document.getElementById('change-opp-acc-opp-id').value = opportunityId;
        document.getElementById('change-opp-acc-motivo').value = '';

        const selectClient = document.getElementById('change-opp-acc-client-select');
        const clients = _deps.getClients();
        const currentClientId = activeOpp ? activeOpp.clientId : '';

        const otherClients = clients.filter(c => c.id !== currentClientId);
        selectClient.innerHTML = '<option value="">-- Selecciona la nueva cuenta --</option>' +
            otherClients.map(c => {
                const name = c.empresa || [c.nombres, c.apellidos].filter(Boolean).join(' ') || c.id;
                return `<option value="${_deps.esc(c.id)}">${_deps.esc(name)}</option>`;
            }).join('');

        modal.style.display = 'block';
    }

    function closeChangeOpportunityAccountModal() {
        const modal = document.getElementById('modal-change-opportunity-account');
        if (modal) modal.style.display = 'none';
    }

    async function submitChangeOpportunityAccount(event) {
        if (event) event.preventDefault();
        const oppId = document.getElementById('change-opp-acc-opp-id').value;
        const newAccId = document.getElementById('change-opp-acc-client-select').value;
        const reason = document.getElementById('change-opp-acc-motivo').value.trim();

        if (!newAccId) return notify('error', 'Debes seleccionar la nueva cuenta.');
        if (!reason) return notify('error', 'Debes especificar el motivo del cambio de cuenta.');

        const btn = document.getElementById('btn-submit-change-opp-acc');
        if (btn) { btn.disabled = true; btn.textContent = 'Transfiriendo...'; }

        try {
            const fb = _deps.getFirebase();
            const sdk = _deps.getCrmOpportunityContacts();
            await sdk.changeOpportunityAccount(fb, {
                opportunityId: oppId,
                newAccountId: newAccId,
                motivo: reason,
                dbSuffix: _deps.getDbSuffix()
            });

            notify('success', 'Cuenta comercial actualizada. Los participantes anteriores se han marcado como históricos.');
            closeChangeOpportunityAccountModal();

            if (activeOpp && activeOpp.id === oppId) {
                activeOpp.clientId = newAccId;
                activeOpp.primaryOpportunityContactId = null;
                activeOpp.primaryContactSnapshot = null;

                // Update detail header
                const detailClientEl = document.getElementById('detail-cliente');
                if (detailClientEl) detailClientEl.textContent = _deps.getClientName(newAccId);

                renderOpportunityParticipants(activeOpp);
            }
        } catch (e) {
            console.error('Error al cambiar la cuenta de la oportunidad:', e);
            notify('error', e.message || 'Error al cambiar la cuenta.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Confirmar Cambio de Cuenta'; }
        }
    }

    return {
        renderOpportunityParticipants,
        openAddOpportunityContactModal,
        closeAddOpportunityContactModal,
        submitAddOpportunityContact,
        openEditOpportunityContactRoleModal,
        closeEditOpportunityContactRoleModal,
        submitEditOpportunityContactRole,
        setOpportunityPrimaryContact,
        removeOpportunityParticipant,
        openChangeOpportunityAccountModal,
        closeChangeOpportunityAccountModal,
        submitChangeOpportunityAccount
    };
});
