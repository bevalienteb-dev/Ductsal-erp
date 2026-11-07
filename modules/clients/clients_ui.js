// ============================================================================
// DUCTSAL ERP — CLIENTS MODULE: UI & PRESENTATION (Fase 6.2)
// Archivo: modules/clients/clients_ui.js
// Responsabilidad:
// 1. Directorio principal de clientes, buscador interactivo y tabla (renderClientsTable).
// 2. Ordenamiento multicriterio de columnas y actualización de glifos visuales (toggleCliSort).
// 3. Vista de pantalla completa de registro/edición de clientes naturales y jurídicos (openClientDetailView).
// 4. Alternancia dinámica de campos fiscales y personería (toggleClientFields).
// 5. Validación fiscal de formulario y resaltado visual de errores (saveClient, setClientFieldError).
// 6. Selector de clientes en creación de oportunidades (renderClientSelect, selectClientInSelector).
// 7. Helpers canónicos de presentación e integración: getClientName, getProspectClient, renderClientContactCard.
// 8. Coordinador de inicialización del módulo de clientes (initClientsModule).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.ClientsUI = api;
        // Compatibilidad global con window
        if (typeof window !== 'undefined') {
            window.ClientsUI = api;
            window.renderClientsTable = api.renderClientsTable;
            window.toggleCliSort = api.toggleCliSort;
            window.updateCliSortIcons = api.updateCliSortIcons;
            window.toggleClientFields = api.toggleClientFields;
            window.setClientFieldError = api.setClientFieldError;
            window.openClientDetailView = api.openClientDetailView;
            window.closeClientDetailView = api.closeClientDetailView;
            window.saveClient = api.saveClient;
            window.renderClientSelect = api.renderClientSelect;
            window.selectClientInSelector = api.selectClientInSelector;
            window.getClientName = api.getClientName;
            window.getProspectClient = api.getProspectClient;
            window.renderClientContactCard = api.renderClientContactCard;
            window.initClientsModule = api.initClientsModule;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined') return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        setClients: (c) => {
            if (typeof clients !== 'undefined') clients = c;
            if (typeof window !== 'undefined') window.clients = c;
        },
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
        },
        getVisibleClients: () => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.getVisibleClients === 'function') {
                return ClientsController.getVisibleClients();
            }
            if (typeof window !== 'undefined' && typeof window.getVisibleClients === 'function') {
                return window.getVisibleClients();
            }
            if (typeof getVisibleClients === 'function') return getVisibleClients();
            return _deps.getClients();
        },
        persistClientViaServer: async (c, editId) => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.persistClientViaServer === 'function') {
                return ClientsController.persistClientViaServer(c, editId);
            }
            if (typeof window !== 'undefined' && typeof window.persistClientViaServer === 'function') {
                return window.persistClientViaServer(c, editId);
            }
            if (typeof persistClientViaServer === 'function') return persistClientViaServer(c, editId);
            throw new Error('persistClientViaServer no disponible en el entorno');
        },
        deleteClient: (id) => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.deleteClient === 'function') {
                return ClientsController.deleteClient(id);
            }
            if (typeof window !== 'undefined' && typeof window.deleteClient === 'function') {
                return window.deleteClient(id);
            }
            if (typeof deleteClient === 'function') return deleteClient(id);
        },
        catalogueSearchActive: () => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.catalogueSearchActive === 'function') {
                return ClientsController.catalogueSearchActive();
            }
            if (typeof window !== 'undefined' && typeof window.catalogueSearchActive === 'function') {
                return window.catalogueSearchActive();
            }
            return false;
        },
        getSelectorClientsLocal: () => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.getSelectorClientsLocal === 'function') {
                return ClientsController.getSelectorClientsLocal();
            }
            if (typeof window !== 'undefined' && typeof window.getSelectorClientsLocal === 'function') {
                return window.getSelectorClientsLocal();
            }
            return _deps.getClients();
        },
        renderClientExpedienteSection: (c) => {
            if (typeof ClientDocuments !== 'undefined' && typeof ClientDocuments.renderClientExpedienteSection === 'function') {
                return ClientDocuments.renderClientExpedienteSection(c);
            }
            if (typeof window !== 'undefined' && typeof window.renderClientExpedienteSection === 'function') {
                return window.renderClientExpedienteSection(c);
            }
            if (typeof renderClientExpedienteSection === 'function') return renderClientExpedienteSection(c);
        },
        closeModal: (id) => {
            if (typeof closeModal === 'function') return closeModal(id);
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(id);
        },
        showLoading: (msg) => {
            if (typeof showLoading === 'function') return showLoading(msg);
            if (typeof window !== 'undefined' && typeof window.showLoading === 'function') return window.showLoading(msg);
        },
        hideLoading: () => {
            if (typeof hideLoading === 'function') return hideLoading();
            if (typeof window !== 'undefined' && typeof window.hideLoading === 'function') return window.hideLoading();
        },
        alert: (msg) => {
            return renderInlineClientNotice(msg);
        },
        escapeHtmlDoc: (str) => {
            if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
            return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        },
        normalizeWhatsAppNumber: (rawPhone) => {
            if (typeof normalizeWhatsAppNumber === 'function') return normalizeWhatsAppNumber(rawPhone);
            if (typeof window !== 'undefined' && typeof window.normalizeWhatsAppNumber === 'function') return window.normalizeWhatsAppNumber(rawPhone);
            if (!rawPhone || typeof rawPhone !== 'string') return null;
            const digits = rawPhone.replace(/\D/g, '');
            if (!digits) return null;
            if (digits.length === 8) return '503' + digits;
            if (digits.length === 11 && digits.startsWith('503')) return digits;
            return digits;
        },
        openRecordFollowUpModal: (id) => {
            if (typeof openRecordFollowUpModal === 'function') return openRecordFollowUpModal(id);
            if (typeof window !== 'undefined' && typeof window.openRecordFollowUpModal === 'function') return window.openRecordFollowUpModal(id);
        }
    };

    function renderInlineClientNotice(msg) {
        const text = String(msg || '');
        const isSuccess = /exitosamente|✅|guardad|registrad|confirmad|actualizad/i.test(text) && !/error|no se|denegado|inválid|falta|requiere|obligatorio/i.test(text);
        if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
            window.CrmUI.notify(isSuccess ? 'success' : 'error', text);
        }
        if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            const activeView = document.querySelector('.view-section.active') || document.getElementById('client-detail-view');
            if (activeView && typeof document.createElement === 'function') {
                let banner = document.getElementById('b3-inline-view-notice');
                if (!banner) {
                    banner = document.createElement('div');
                    banner.id = 'b3-inline-view-notice';
                    if (activeView.firstChild && typeof activeView.insertBefore === 'function') {
                        activeView.insertBefore(banner, activeView.firstChild);
                    } else if (typeof activeView.appendChild === 'function') {
                        activeView.appendChild(banner);
                    }
                } else if (banner.parentElement !== activeView && activeView.firstChild && typeof activeView.insertBefore === 'function') {
                    activeView.insertBefore(banner, activeView.firstChild);
                }
                banner.style.cssText = isSuccess
                    ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem;'
                    : 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fca5a5; font-size:0.84rem;';
                banner.textContent = text;
            }
        }
    }

    /**
     * Inicializa o actualiza dependencias de la UI de clientes.
     */
    function initClientsUI(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const k of Object.keys(customDeps)) {
                if (typeof customDeps[k] === 'function') {
                    _deps[k] = customDeps[k];
                } else {
                    _deps[k] = () => customDeps[k];
                }
            }
        }
        return ClientsUI;
    }

    /**
     * Coordinador maestro que inicializa todo el módulo de clientes de forma unificada.
     */
    function initClientsModule(allDeps) {
        if (typeof ClientsController !== 'undefined' && typeof ClientsController.init === 'function') {
            ClientsController.init(allDeps);
        }
        if (typeof ClientDocuments !== 'undefined' && typeof ClientDocuments.init === 'function') {
            ClientDocuments.init(allDeps);
        }
        initClientsUI(allDeps);
        return {
            controller: typeof ClientsController !== 'undefined' ? ClientsController : null,
            documents: typeof ClientDocuments !== 'undefined' ? ClientDocuments : null,
            ui: ClientsUI
        };
    }

    // -------------------------------------------------------------------------
    // 2. Estado de Ordenamiento
    // -------------------------------------------------------------------------
    let cliSortCol = '';
    let cliSortDir = 'asc';

    function getCliSortCol() { return cliSortCol; }
    function getCliSortDir() { return cliSortDir; }
    function setCliSort(col, dir = 'asc') {
        cliSortCol = col;
        cliSortDir = dir;
    }

    function toggleCliSort(column) {
        if (cliSortCol === column) {
            cliSortDir = cliSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            cliSortCol = column;
            cliSortDir = 'asc';
        }
        renderClientsTable();
        updateCliSortIcons();
    }

    function updateCliSortIcons() {
        if (typeof document === 'undefined') return;
        const columns = ['tipo', 'nombre', 'contacto', 'telefono', 'correo'];
        columns.forEach(col => {
            const el = document.getElementById(`sort-cli-${col}`);
            if (!el) return;
            if (cliSortCol === col) {
                el.innerHTML = cliSortDir === 'asc' ? '▲' : '▼';
                el.style.color = 'var(--brand-gold)';
            } else {
                el.innerHTML = '↕';
                el.style.color = 'var(--text-muted)';
            }
        });
    }

    // -------------------------------------------------------------------------
    // 3. Renderizado del Directorio / Tabla de Clientes
    // -------------------------------------------------------------------------
    function renderClientsTable() {
        if (typeof document === 'undefined') return;
        const tbody = document.getElementById('clients-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const esc = _deps.escapeHtmlDoc;
        let filtered = _deps.getVisibleClients();

        const countBadge = document.getElementById('clients-count-badge');
        if (countBadge) {
            countBadge.textContent = `${filtered.length} cliente${filtered.length === 1 ? '' : 's'}`;
        }

        // Apply Search Filter
        const searchInput = document.getElementById('cli-search');
        const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
        if (searchVal) {
            filtered = filtered.filter(c => {
                const isNatural = c.tipo === 'natural';
                const mainName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.empresa || '-');
                const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.contacto || '-');

                return (c.tipo || '').toLowerCase().includes(searchVal) ||
                    mainName.toLowerCase().includes(searchVal) ||
                    contactName.toLowerCase().includes(searchVal) ||
                    (c.telefono || '').toLowerCase().includes(searchVal) ||
                    (c.correo || '').toLowerCase().includes(searchVal);
            });
        }

        // Apply Sorting
        if (cliSortCol) {
            filtered.sort((a, b) => {
                let valA = '';
                let valB = '';

                const isNaturalA = a.tipo === 'natural';
                const isNaturalB = b.tipo === 'natural';

                if (cliSortCol === 'tipo') {
                    valA = a.tipo || '';
                    valB = b.tipo || '';
                } else if (cliSortCol === 'nombre') {
                    valA = isNaturalA ? `${a.nombres || ''} ${a.apellidos || ''}` : (a.empresa || '-');
                    valB = isNaturalB ? `${b.nombres || ''} ${b.apellidos || ''}` : (b.empresa || '-');
                } else if (cliSortCol === 'contacto') {
                    valA = isNaturalA ? `${a.nombres || ''} ${a.apellidos || ''}` : (a.contacto || '-');
                    valB = isNaturalB ? `${b.nombres || ''} ${b.apellidos || ''}` : (b.contacto || '-');
                } else if (cliSortCol === 'telefono') {
                    valA = a.telefono || '';
                    valB = b.telefono || '';
                } else if (cliSortCol === 'correo') {
                    valA = a.correo || '';
                    valB = b.correo || '';
                }

                return cliSortDir === 'asc'
                    ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                    : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
            });
        } else {
            filtered = [...filtered].reverse();
        }

        if (filtered.length === 0) {
            if (countBadge) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6">
                            <div class="table-empty-box">
                                <div style="font-size:2rem; margin-bottom:0.4rem;">👥</div>
                                <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">No se encontraron clientes</div>
                                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">
                                    ${searchVal ? 'Prueba con otro término de búsqueda.' : 'Registra un nuevo cliente para comenzar.'}
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            } else {
                tbody.innerHTML = '';
            }
            return;
        }

        const currentUser = _deps.getCurrentUser();
        filtered.forEach(c => {
            const isNatural = c.tipo === 'natural';
            const typeBadge = isNatural
                ? '<span class="badge" style="background:rgba(255,255,255,0.06); color:#cbd5e1; border:1px solid rgba(255,255,255,0.12); font-weight:500;">Natural</span>'
                : '<span class="badge" style="background:rgba(217, 119, 6, 0.15); color:var(--brand-gold); border:1px solid rgba(217, 119, 6, 0.35); font-weight:600;">Jurídica</span>';

            const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.contacto || '-');
            const mainName = (isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.empresa || '-')) || '-';
            const isExport = c.es_exportacion === true || c.es_exportacion === 'true';
            const exportBadge = isExport ? ' <span class="badge" style="background:rgba(33, 150, 243, 0.15); color:#60a5fa; border:1px solid rgba(33, 150, 243, 0.35); font-size:0.68rem; margin-left:4px; vertical-align:middle;">✈️ Exp</span>' : '';

            const phoneStr = c.telefono ? `<span style="font-family:monospace; font-size:0.85rem; color:var(--text-secondary);">${esc(c.telefono)}</span>` : '<span style="color:var(--text-muted);">-</span>';
            const emailStr = c.correo ? `<a href="mailto:${esc(c.correo)}" class="cell-ellipsis" style="display:inline-block; max-width:210px; color:var(--text-secondary); text-decoration:none;" title="${esc(c.correo)}">${esc(c.correo)}</a>` : '<span style="color:var(--text-muted);">-</span>';

            let actionsHtml = `<div class="table-btn-group">
                <button type="button" class="btn-table-action" onclick="ContactsUI.openAccountContactsModal('${c.id}')" title="Ver y gestionar personas vinculadas a esta cuenta (Hub & Spoke)" style="background:rgba(56,189,248,0.15); color:#38bdf8; border-color:rgba(56,189,248,0.3);">
                    👥 Contactos
                </button>
                <button type="button" class="btn-table-action btn-table-edit" onclick="openClientDetailView('${c.id}')" title="Editar datos y ver expediente de ${esc(mainName)}">
                    ✏️ Editar
                </button>`;
            if (currentUser && currentUser.role === 'manager') {
                actionsHtml += `<button type="button" class="btn-table-action btn-table-delete" onclick="deleteClient('${c.id}')" title="Eliminar cliente">
                    🗑️
                </button>`;
            }
            actionsHtml += `</div>`;

            tbody.innerHTML += `
                <tr class="client-table-row">
                    <td class="col-cli-type" style="white-space:nowrap;">${typeBadge}</td>
                    <td class="col-cli-name">
                        <div class="cell-ellipsis cli-name-wrap" style="font-weight:600; color:white; max-width:240px;" title="${esc(mainName)}">
                            ${esc(mainName)}${exportBadge}
                        </div>
                    </td>
                    <td class="col-cli-contact">
                        <div class="cell-ellipsis cli-contact-wrap" style="max-width:200px; color:var(--text-primary);" title="${esc(contactName)}">
                            <span class="cli-contact-icon" style="display:none; margin-right:4px;">👤</span>${esc(contactName)}
                        </div>
                    </td>
                    <td class="col-cli-phone" style="white-space:nowrap;">${phoneStr}</td>
                    <td class="col-cli-email">${emailStr}</td>
                    <td class="col-cli-action" style="text-align:right; white-space:nowrap;">${actionsHtml}</td>
                </tr>
            `;
        });
    }

    // -------------------------------------------------------------------------
    // 4. Formulario de Cliente y Validaciones Fiscales
    // -------------------------------------------------------------------------
    function toggleClientFields() {
        if (typeof document === 'undefined') return;
        const tipoEl = document.getElementById('client-tipo');
        if (!tipoEl) return;
        const type = tipoEl.value;
        const natFields = document.getElementById('fields-natural');
        const jurFields = document.getElementById('fields-juridica');
        if (type === 'natural') {
            if (natFields) natFields.style.display = 'block';
            if (jurFields) jurFields.style.display = 'none';
        } else if (type === 'juridica') {
            if (natFields) natFields.style.display = 'none';
            if (jurFields) jurFields.style.display = 'block';
        } else {
            if (natFields) natFields.style.display = 'none';
            if (jurFields) jurFields.style.display = 'none';
        }
        if (typeof window !== 'undefined' && window.ClientDocuments && typeof window.ClientDocuments.syncClientLegalDocsChecklist === 'function') {
            window.ClientDocuments.syncClientLegalDocsChecklist();
        }
    }

    function setClientFieldError(elementId, hasError) {
        if (typeof document === 'undefined') return;
        const el = document.getElementById(elementId);
        if (!el) return;
        if (el.classList && typeof el.classList.toggle === 'function') {
            el.classList.toggle('input-error', !!hasError);
        }
    }

    let _clientViewOrigin = { view: 'clients-view', prospectId: null, fromNewProspect: false };

    function _navigateView(viewId) {
        if (typeof showView === 'function') {
            showView(viewId);
        } else if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
            AppRouter.showView(viewId);
        }
    }

    function openClientDetailView(clientId = null, options = {}) {
        if (typeof document === 'undefined') return;

        // Determinar origen de navegación para retorno limpio desde la vista de pantalla completa
        const newProspectEl = document.getElementById('newProspectModal');
        const detailViewEl = document.getElementById('detail-view');
        if (options && options.originView) {
            _clientViewOrigin = {
                view: options.originView,
                prospectId: options.prospectId || null,
                fromNewProspect: false
            };
        } else if (newProspectEl && newProspectEl.style && newProspectEl.style.display === 'block') {
            _clientViewOrigin = { view: 'list-view', prospectId: null, fromNewProspect: true };
        } else if (detailViewEl && detailViewEl.classList && typeof detailViewEl.classList.contains === 'function' && detailViewEl.classList.contains('active')) {
            const currentId = (typeof window !== 'undefined' && window.currentDetailId) ? window.currentDetailId : null;
            _clientViewOrigin = { view: 'detail-view', prospectId: currentId, fromNewProspect: false };
        } else {
            _clientViewOrigin = { view: 'clients-view', prospectId: null, fromNewProspect: false };
        }

        const form = document.getElementById('clientForm');
        if (form && typeof form.reset === 'function') form.reset();
        if (typeof window !== 'undefined' && typeof window.resetAllClientFormStagedFiles === 'function') {
            window.resetAllClientFormStagedFiles();
        }
        const idInput = document.getElementById('client-id-edit');
        if (idInput) idInput.value = '';

        if (typeof document.querySelectorAll === 'function') {
            const errs = document.querySelectorAll('#clientForm .input-error');
            if (errs && errs.forEach) errs.forEach(el => el.classList.remove('input-error'));
        }

        const contextTitleEl = document.getElementById('client-view-context-title');
        const contextSubEl = document.getElementById('client-view-context-subtitle');
        const originBadgeBox = document.getElementById('client-view-origin-badge-box');
        const originBadge = document.getElementById('client-view-origin-badge');
        const headerContactsBtn = document.getElementById('btn-client-header-contacts');
        const headerB3HistoryBtn = document.getElementById('btn-client-header-b3-history');

        if (_clientViewOrigin.view === 'detail-view' && _clientViewOrigin.prospectId) {
            if (originBadgeBox) originBadgeBox.style.display = 'block';
            if (originBadge) originBadge.textContent = 'Resolución desde Cierre de Oportunidad';
        } else {
            if (originBadgeBox) originBadgeBox.style.display = 'none';
        }

        const clientsList = _deps.getClients();
        if (clientId) {
            const titleEl = document.getElementById('client-modal-title');
            if (titleEl) titleEl.textContent = 'Editar Cliente';
            const c = clientsList.find(x => x.id === clientId);
            if (c) {
                if (typeof window !== 'undefined') {
                    window._activeClientBaseDocs = (c.documentos && typeof c.documentos === 'object') ? JSON.parse(JSON.stringify(c.documentos)) : null;
                }
                if (idInput) idInput.value = c.id;
                const tipoEl = document.getElementById('client-tipo');
                if (tipoEl) tipoEl.value = c.tipo;
                toggleClientFields();

                const displayName = c.tipo === 'natural'
                    ? `${c.nombres || ''} ${c.apellidos || ''}`.trim()
                    : (c.empresa || 'Cuenta Comercial');
                if (contextTitleEl) contextTitleEl.textContent = `${displayName}`;
                if (contextSubEl) {
                    contextSubEl.textContent = c.tipo === 'juridica'
                        ? `Persona Jurídica · NIT: ${c.nit || 'Pendiente'} · NRC: ${c.nrc || 'Pendiente'} · Vista de pantalla completa`
                        : `Persona Natural · DUI: ${c.dui || 'Pendiente'} · NIT: ${c.nit || 'Pendiente'} · Vista de pantalla completa`;
                }

                const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
                setVal('cli-telefono', c.telefono);
                setVal('cli-correo', c.correo);
                setVal('cli-correo-fact', c.correo_fact);

                const expEl = document.getElementById('cli-es-exportacion');
                if (expEl) expEl.checked = c.es_exportacion === true || c.es_exportacion === 'true';

                if (c.tipo === 'natural') {
                    setVal('nat-nombres', c.nombres);
                    setVal('nat-apellidos', c.apellidos);
                    setVal('nat-dui', c.dui);
                    setVal('nat-nit', c.nit);
                    setVal('nat-profesion', c.profesion);
                    setVal('nat-domicilio', c.domicilio);
                } else {
                    setVal('jur-empresa', c.empresa);
                    setVal('jur-contacto', c.contacto);
                    setVal('jur-nit', c.nit);
                    setVal('jur-nrc', c.nrc);
                    setVal('jur-rep-legal', c.rep_legal);
                    setVal('jur-profesion-rep', c.profesion_rep);
                    setVal('jur-domicilio-rep', c.domicilio_rep);
                    setVal('jur-dui-rep', c.dui_rep);
                    setVal('jur-nit-rep', c.nit_rep);
                    const gcEl = document.getElementById('jur-gran-contribuyente');
                    if (gcEl) gcEl.checked = c.is_gran_contribuyente === true;
                }
                _deps.renderClientExpedienteSection(c);
                const btnContacts = document.getElementById('btn-client-modal-contacts');
                if (btnContacts) btnContacts.style.display = 'inline-block';
                if (headerContactsBtn) headerContactsBtn.style.display = 'inline-block';
                if (headerB3HistoryBtn) headerB3HistoryBtn.style.display = c.tipo === 'juridica' ? 'inline-block' : 'none';
            }
        } else {
            if (typeof window !== 'undefined') window._activeClientBaseDocs = null;
            const titleEl = document.getElementById('client-modal-title');
            if (titleEl) titleEl.textContent = 'Registrar Cliente';
            if (contextTitleEl) contextTitleEl.textContent = 'Registrar Nuevo Cliente';
            if (contextSubEl) contextSubEl.textContent = 'Alta de cuenta comercial, régimen fiscal y expediente digital en vista de pantalla completa';
            const tipoEl = document.getElementById('client-tipo');
            if (tipoEl) tipoEl.value = '';
            const gcEl = document.getElementById('jur-gran-contribuyente');
            if (gcEl) gcEl.checked = false;
            const expEl = document.getElementById('cli-es-exportacion');
            if (expEl) expEl.checked = false;
            toggleClientFields();
            _deps.renderClientExpedienteSection(null);
            const btnContacts = document.getElementById('btn-client-modal-contacts');
            if (btnContacts) btnContacts.style.display = 'none';
            if (headerContactsBtn) headerContactsBtn.style.display = 'none';
            if (headerB3HistoryBtn) headerB3HistoryBtn.style.display = 'none';
        }

        const contentEl = document.getElementById('clientDetailContent');
        if (contentEl && contentEl.style) contentEl.style.display = 'block';
        _navigateView('client-detail-view');
    }

    function closeClientDetailView() {
        if (typeof _deps.cancelPendingClientReservation === 'function') {
            _deps.cancelPendingClientReservation();
        }
        if (typeof document !== 'undefined') {
            const contentEl = document.getElementById('clientDetailContent');
            if (contentEl && contentEl.style) contentEl.style.display = 'none';
        }
        if (_clientViewOrigin && _clientViewOrigin.fromNewProspect) {
            _navigateView('list-view');
        } else if (_clientViewOrigin && _clientViewOrigin.view === 'detail-view' && _clientViewOrigin.prospectId) {
            _navigateView('detail-view');
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') {
                window.openDetail(_clientViewOrigin.prospectId);
            }
        } else {
            _navigateView((_clientViewOrigin && _clientViewOrigin.view) || 'clients-view');
            renderClientsTable();
        }
    }

    async function saveClient(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        try {
            const editId = (typeof document !== 'undefined' && document.getElementById('client-id-edit')) ? document.getElementById('client-id-edit').value : '';
            const type = (typeof document !== 'undefined' && document.getElementById('client-tipo')) ? document.getElementById('client-tipo').value : '';
            if (!type) {
                setClientFieldError('client-tipo', true);
                return _deps.alert("Debes seleccionar el Tipo de Persona obligatoriamente.");
            }
            setClientFieldError('client-tipo', false);

            const tel = (typeof document !== 'undefined' && document.getElementById('cli-telefono')) ? document.getElementById('cli-telefono').value.trim() : '';
            const email = (typeof document !== 'undefined' && document.getElementById('cli-correo')) ? document.getElementById('cli-correo').value.trim() : '';
            if (!tel && !email) {
                setClientFieldError('cli-telefono', true);
                setClientFieldError('cli-correo', true);
                return _deps.alert("Debe ingresar obligatoriamente un teléfono o correo.");
            }
            setClientFieldError('cli-telefono', false);
            setClientFieldError('cli-correo', false);

            let c = {};
            const clientsList = _deps.getClients();
            if (editId) {
                const existing = clientsList.find(x => x.id === editId);
                if (existing) c = JSON.parse(JSON.stringify(existing));
            }
            if (!c.documentos) c.documentos = {};

            if (type === 'natural') {
                c.nombres = document.getElementById('nat-nombres').value.trim();
                c.apellidos = document.getElementById('nat-apellidos').value.trim();
                if (!c.nombres || !c.apellidos) {
                    if (!c.nombres) setClientFieldError('nat-nombres', true);
                    if (!c.apellidos) setClientFieldError('nat-apellidos', true);
                    return _deps.alert("Nombres y Apellidos obligatorios.");
                }
                setClientFieldError('nat-nombres', false);
                setClientFieldError('nat-apellidos', false);
                c.dui = document.getElementById('nat-dui').value;
                c.nit = document.getElementById('nat-nit').value;
                c.profesion = document.getElementById('nat-profesion').value;
                c.domicilio = document.getElementById('nat-domicilio').value;
            } else {
                c.empresa = document.getElementById('jur-empresa').value.trim();
                if (!c.empresa) {
                    setClientFieldError('jur-empresa', true);
                    return _deps.alert("Nombre de la Empresa obligatorio.");
                }
                setClientFieldError('jur-empresa', false);
                c.contacto = document.getElementById('jur-contacto').value.trim();
                if (!c.contacto) {
                    setClientFieldError('jur-contacto', true);
                    return _deps.alert("Nombre del Contacto Principal obligatorio.");
                }
                setClientFieldError('jur-contacto', false);
                c.nit = document.getElementById('jur-nit').value;
                c.nrc = document.getElementById('jur-nrc').value;
                c.rep_legal = document.getElementById('jur-rep-legal').value.trim();
                c.profesion_rep = document.getElementById('jur-profesion-rep').value;
                c.domicilio_rep = document.getElementById('jur-domicilio-rep').value;
                c.dui_rep = document.getElementById('jur-dui-rep').value;
                c.nit_rep = document.getElementById('jur-nit-rep').value;
                c.is_gran_contribuyente = document.getElementById('jur-gran-contribuyente').checked;
            }
            c.tipo = type;
            c.telefono = tel;
            c.correo = email;
            c.correo_fact = document.getElementById('cli-correo-fact') ? document.getElementById('cli-correo-fact').value : '';
            c.es_exportacion = document.getElementById('cli-es-exportacion') ? document.getElementById('cli-es-exportacion').checked : false;

            // The server decides (duplicates by NIT / DUI, ownership, id). A blocked / cancelled save returns null.
            const saved = await _deps.persistClientViaServer(c, editId);
            if (!saved) return;
            c = saved;
            const updatedList = [..._deps.getClients()];
            const at = updatedList.findIndex(x => x.id === c.id);
            if (at > -1) updatedList[at] = c; else updatedList.push(c);
            _deps.setClients(updatedList);

            _deps.closeModal('clientDetailContent');
            if (typeof document !== 'undefined' && document.getElementById('newProspectModal') && document.getElementById('newProspectModal').style.display === 'block') {
                _navigateView('list-view');
                selectClientInSelector(c.id, getClientName(c.id));
            } else if (_clientViewOrigin && _clientViewOrigin.view === 'detail-view' && _clientViewOrigin.prospectId) {
                _navigateView('detail-view');
                if (typeof window !== 'undefined' && typeof window.openDetail === 'function') {
                    window.openDetail(_clientViewOrigin.prospectId);
                }
            } else {
                _navigateView('clients-view');
                renderClientsTable();
            }
        } catch (err) {
            _deps.alert("Error al guardar cliente: " + err.message);
        } finally {
            _deps.hideLoading();
        }
    }

    // -------------------------------------------------------------------------
    // 5. Selector de Clientes en Creación de Oportunidades
    // -------------------------------------------------------------------------
    function renderClientSelect() {
        if (typeof document === 'undefined') return;
        const select = document.getElementById('new-cliente-select');
        if (!select) return;
        select.innerHTML = '<option value="">-- Selecciona Cliente --</option>';
        const search = document.getElementById('new-cliente-search');
        const hint = document.getElementById('new-cliente-search-hint');
        const active = _deps.catalogueSearchActive();
        if (search) { search.style.display = active ? 'block' : 'none'; search.value = ''; }
        if (hint) { hint.style.display = active ? 'block' : 'none'; hint.textContent = active ? 'Busca por nombre, NIT o DUI (mín. 2 letras o 4 dígitos). Verás todos los clientes del catálogo.' : ''; }
        if (active) return;
        _deps.getSelectorClientsLocal().forEach(c => {
            if (typeof Option === 'function') {
                select.add(new Option(c.tipo === 'natural' ? `${c.nombres} ${c.apellidos}` : c.empresa, c.id));
            }
        });
    }

    function selectClientInSelector(id, label) {
        if (typeof document === 'undefined') return;
        const select = document.getElementById('new-cliente-select');
        if (!select) return;
        if (![...select.options].some(o => o.value === id)) {
            if (typeof Option === 'function') {
                select.add(new Option(label || id, id));
            }
        }
        select.value = id;
    }

    // -------------------------------------------------------------------------
    // 6. Helpers Canónicos de Presentación de Clientes
    // -------------------------------------------------------------------------
    function getClientName(clientId) {
        const clientList = _deps.getClients();
        const client = clientList.find(c => c && c.id === clientId) || { nombres: 'Desconocido', empresa: 'Desconocido' };
        return client.tipo === 'natural'
            ? `${client.nombres || ''} ${client.apellidos || ''}`.trim()
            : (client.empresa || client.nombreComercial || client.razonSocial || 'Desconocido');
    }

    function getProspectClient(prospectOrId) {
        if (!prospectOrId) return null;
        const clientId = (typeof prospectOrId === 'object' && prospectOrId !== null)
            ? (prospectOrId.clientId || prospectOrId.id)
            : prospectOrId;
        if (!clientId) return null;
        const clientList = _deps.getClients();
        return clientList.find(c => c && c.id === clientId) || null;
    }

    function renderClientContactCard(p) {
        if (typeof document === 'undefined') return;
        const cardEl = document.getElementById('detail-client-contact-card');
        if (!cardEl) return;
        if (!p) {
            cardEl.style.display = 'none';
            cardEl.innerHTML = '';
            return;
        }

        const client = getProspectClient(p.clientId);
        const clientName = getClientName(p.clientId);

        let contactPerson = '';
        let phone = '';
        let email = '';
        let isJuridica = false;
        let isGranContribuyente = false;
        let isExport = false;

        if (client) {
            isJuridica = (client.tipo === 'juridica' || client.tipo === 'juridico');
            if (isJuridica) {
                contactPerson = (client.contacto || client.rep_legal || '').trim();
            } else {
                contactPerson = [client.nombres, client.apellidos].filter(Boolean).join(' ').trim();
            }
            phone = (client.telefono || '').trim();
            email = (client.correo || '').trim();
            isGranContribuyente = client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true';
            isExport = client.es_exportacion === true || client.es_exportacion === 'true';
        }

        const waNumber = _deps.normalizeWhatsAppNumber(phone);
        const cleanPhoneDigits = phone ? phone.replace(/[^\d+]/g, '') : '';

        const typeBadge = isJuridica
            ? `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 0.72rem;">🏢 Empresa</span>`
            : `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 0.72rem;">👤 Persona Natural</span>`;

        const granContribBadge = isGranContribuyente
            ? `<span class="badge" style="background: rgba(212, 175, 55, 0.15); color: var(--brand-gold); border: 1px solid rgba(212, 175, 55, 0.4); font-size: 0.72rem;">🏛️ Gran Contribuyente (1% IVA)</span>`
            : '';
        const exportBadge = isExport
            ? `<span class="badge" style="background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.4); font-size: 0.72rem;">✈️ Exportación (0% IVA)</span>`
            : '';

        let contactPersonHtml = '';
        if (contactPerson) {
            contactPersonHtml = `<span class="client-contact-person" title="Contacto comercial">👤 Contacto: <strong>${_deps.escapeHtmlDoc(contactPerson)}</strong></span>`;
        } else {
            contactPersonHtml = `<span class="client-contact-person" style="color:var(--text-muted); font-weight:normal;" title="Sin contacto específico">👤 Sin contacto asignado</span>`;
        }

        const telHtml = (phone && cleanPhoneDigits)
            ? `<a href="tel:${cleanPhoneDigits}" class="contact-channel-pill contact-channel-tel" title="Llamar a ${_deps.escapeHtmlDoc(phone)}">📞 <span>${_deps.escapeHtmlDoc(phone)}</span></a>`
            : `<span class="contact-channel-pill contact-channel-empty">📞 Sin teléfono</span>`;

        const waHtml = waNumber
            ? `<a href="https://wa.me/${waNumber}" target="_blank" rel="noopener noreferrer" class="contact-channel-pill contact-channel-wa" title="Abrir chat de WhatsApp">💬 <span>WhatsApp</span></a>`
            : `<span class="contact-channel-pill contact-channel-empty">💬 Sin WhatsApp</span>`;

        const emailHtml = email
            ? `<a href="mailto:${encodeURIComponent(email)}" class="contact-channel-pill contact-channel-email" title="Enviar correo a ${_deps.escapeHtmlDoc(email)}">✉️ <span>${_deps.escapeHtmlDoc(email)}</span></a>`
            : `<span class="contact-channel-pill contact-channel-empty">✉️ Sin correo</span>`;

        const quickFollowUpBtn = (p.estado === 'activo')
            ? `<button type="button" class="btn-primary btn-quick-followup" onclick="openRecordFollowUpModal('${p.id}')" title="Registrar contacto de seguimiento">📞 Registrar Gestión</button>`
            : '';

        cardEl.innerHTML = `
            <div class="client-contact-main">
                <div class="client-contact-name-row">
                    <span class="client-contact-company">${_deps.escapeHtmlDoc(clientName)}</span>
                    ${typeBadge}
                    ${granContribBadge}
                    ${exportBadge}
                </div>
                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-top:3px;">
                    ${contactPersonHtml}
                </div>
                <div class="client-contact-channels">
                    ${telHtml}
                    ${waHtml}
                    ${emailHtml}
                </div>
            </div>
            <div class="client-contact-actions">
                ${quickFollowUpBtn}
            </div>
        `;
        cardEl.style.display = 'flex';
    }

    const ClientsUI = {
        init: initClientsUI,
        initClientsUI,
        initClientsModule,
        getCliSortCol,
        getCliSortDir,
        setCliSort,
        toggleCliSort,
        updateCliSortIcons,
        renderClientsTable,
        toggleClientFields,
        setClientFieldError,
        openClientDetailView,
        closeClientDetailView,
        saveClient,
        renderClientSelect,
        selectClientInSelector,
        getClientName,
        getProspectClient,
        renderClientContactCard,
        _deps
    };

    return ClientsUI;
});
