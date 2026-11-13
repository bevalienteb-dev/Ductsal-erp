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
            window.renderClientDuplicateFeedback = api.renderClientDuplicateFeedback;
            window.dismissDuplicateFeedback = api.dismissDuplicateFeedback;
            window.useExistingAccount = api.useExistingAccount;
            window.confirmSimilarityAndSave = api.confirmSimilarityAndSave;
            window.openAccountMergeFromTable = api.openAccountMergeFromTable;
            window.openAccountMergePanel = api.openAccountMergePanel;
            window.closeAccountMergePanel = api.closeAccountMergePanel;
            window.filterMergeDestinationSelect = api.filterMergeDestinationSelect;
            window.onMergeDestinationChange = api.onMergeDestinationChange;
            window.loadAccountMergePreview = api.loadAccountMergePreview;
            window.confirmAndExecuteAccountMerge = api.confirmAndExecuteAccountMerge;
            window.navigateToCanonicalAccount = api.navigateToCanonicalAccount;
            window.renderAccount360Hub = api.renderAccount360Hub;
            window.setAccount360Tab = api.setAccount360Tab;
            window.openNewOpportunityFromAccount = api.openNewOpportunityFromAccount;
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
        persistClientViaServer: async (c, editId, options) => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.persistClientViaServer === 'function') {
                return ClientsController.persistClientViaServer(c, editId, options);
            }
            if (typeof window !== 'undefined' && typeof window.persistClientViaServer === 'function') {
                return window.persistClientViaServer(c, editId, options);
            }
            if (typeof persistClientViaServer === 'function') return persistClientViaServer(c, editId, options);
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
        previewAccountMerge: async (sourceId, destinationId) => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.previewAccountMerge === 'function') {
                return ClientsController.previewAccountMerge(sourceId, destinationId);
            }
            if (typeof window !== 'undefined' && typeof window.previewAccountMerge === 'function') {
                return window.previewAccountMerge(sourceId, destinationId);
            }
            if (typeof previewAccountMerge === 'function') return previewAccountMerge(sourceId, destinationId);
            throw new Error('previewAccountMerge no disponible en el entorno');
        },
        executeAccountMerge: async (payload) => {
            if (typeof ClientsController !== 'undefined' && typeof ClientsController.executeAccountMerge === 'function') {
                return ClientsController.executeAccountMerge(payload);
            }
            if (typeof window !== 'undefined' && typeof window.executeAccountMerge === 'function') {
                return window.executeAccountMerge(payload);
            }
            if (typeof executeAccountMerge === 'function') return executeAccountMerge(payload);
            throw new Error('executeAccountMerge no disponible en el entorno');
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
        saveListScrollPosition: (opts) => {
            if (typeof saveListScrollPosition === 'function') return saveListScrollPosition(opts);
            if (typeof window !== 'undefined' && typeof window.saveListScrollPosition === 'function') return window.saveListScrollPosition(opts);
            if (typeof AppRouter !== 'undefined' && typeof AppRouter.saveListScrollPosition === 'function') return AppRouter.saveListScrollPosition(opts);
            return 0;
        },
        restoreListScrollPosition: (opts) => {
            if (typeof restoreListScrollPosition === 'function') return restoreListScrollPosition(opts);
            if (typeof window !== 'undefined' && typeof window.restoreListScrollPosition === 'function') return window.restoreListScrollPosition(opts);
            if (typeof AppRouter !== 'undefined' && typeof AppRouter.restoreListScrollPosition === 'function') return AppRouter.restoreListScrollPosition(opts);
            return 0;
        },
        scrollDetailViewToTop: (viewId, opts) => {
            const targetId = viewId || 'client-detail-view';
            if (typeof AppRouter !== 'undefined' && typeof AppRouter.scrollDetailViewToTop === 'function') return AppRouter.scrollDetailViewToTop(targetId, opts);
            if (typeof scrollDetailViewToTop === 'function') return scrollDetailViewToTop(targetId, opts);
            if (typeof window !== 'undefined' && typeof window.scrollDetailViewToTop === 'function') return window.scrollDetailViewToTop(targetId, opts);
            const win = typeof window !== 'undefined' ? window : null;
            const doc = typeof document !== 'undefined' ? document : null;
            if (win && typeof win.scrollTo === 'function') {
                try { win.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch (_) { win.scrollTo(0, 0); }
            }
            if (doc) {
                if (doc.scrollingElement) doc.scrollingElement.scrollTop = 0;
                if (doc.documentElement) doc.documentElement.scrollTop = 0;
                if (doc.body) doc.body.scrollTop = 0;
                const mainEl = typeof doc.querySelector === 'function' ? doc.querySelector('.main-content') : null;
                if (mainEl) mainEl.scrollTop = 0;
                const cliViewEl = typeof doc.getElementById === 'function' ? doc.getElementById(targetId) : null;
                if (cliViewEl) cliViewEl.scrollTop = 0;
                const cliContentEl = typeof doc.getElementById === 'function' ? (doc.getElementById('clientDetailContent') || doc.getElementById('client-detail-content')) : null;
                if (cliContentEl) cliContentEl.scrollTop = 0;
            }
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
                    ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:#ECFDF5; border:1px solid #6EE7B7; color:#047857; font-weight:600; font-size:0.84rem;'
                    : 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:#FEF2F2; border:1px solid #FCA5A5; color:#B91C1C; font-weight:600; font-size:0.84rem;';
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
                el.style.color = 'var(--ds-primary, #0062B8)';
            } else {
                el.innerHTML = '↕';
                el.style.color = 'var(--ds-text-muted, #64748B)';
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
            countBadge.textContent = `${filtered.length} cuenta${filtered.length === 1 ? '' : 's'}`;
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
                                <div style="font-size:2rem; margin-bottom:0.4rem;">🏢</div>
                                <div style="font-size:0.95rem; font-weight:600; color:var(--ds-text-primary, #0F172A);">No se encontraron cuentas comerciales</div>
                                <div style="font-size:0.8rem; color:var(--ds-text-muted, #64748B); margin-top:0.2rem;">
                                    ${searchVal ? 'Prueba con otro término de búsqueda.' : 'Registra una nueva cuenta para comenzar.'}
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
                ? '<span class="badge ds-badge ds-badge-neutral" style="font-weight:600;">👤 Natural</span>'
                : '<span class="badge ds-badge ds-badge-primary" style="font-weight:600;">🏢 Jurídica</span>';

            const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.contacto || '-');
            const mainName = (isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.empresa || '-')) || '-';
            const isExport = c.es_exportacion === true || c.es_exportacion === 'true';
            const exportBadge = isExport ? ' <span class="badge ds-badge ds-badge-info" style="font-size:0.68rem; margin-left:4px; vertical-align:middle;">✈️ Exp</span>' : '';
            const isAbsorbed = Boolean(c && typeof c.fusionada_en === 'string' && c.fusionada_en.trim());
            const absorbedBadge = isAbsorbed ? ' <span class="badge ds-badge ds-badge-warning" style="font-size:0.68rem; margin-left:4px; vertical-align:middle;">🔗 Absorbida</span>' : '';

            const phoneStr = c.telefono ? `<span style="font-family:monospace; font-size:0.84rem; color:var(--ds-text-secondary, #334155); font-weight:600;">${esc(c.telefono)}</span>` : '<span style="color:var(--ds-text-muted, #64748B);">-</span>';
            const emailStr = c.correo ? `<a href="mailto:${esc(c.correo)}" class="cell-ellipsis" style="display:inline-block; max-width:210px; color:var(--ds-primary, #0062B8); text-decoration:none; font-weight:500;" title="${esc(c.correo)}">${esc(c.correo)}</a>` : '<span style="color:var(--ds-text-muted, #64748B);">-</span>';

            let actionsHtml = `<div class="table-btn-group">
                <button type="button" class="btn-table-action btn-table-edit" onclick="openClientDetailView('${c.id}')" title="Abrir Cuenta 360 de ${esc(mainName)}">
                    🏢 Cuenta 360
                </button>
                <button type="button" class="btn-table-action" onclick="ContactsUI.openAccountContactsModal('${c.id}')" title="Ver y gestionar contactos vinculados a esta cuenta">
                    👥 Contactos
                </button>`;
            if (currentUser && currentUser.role === 'manager') {
                if (!isAbsorbed) {
                    actionsHtml += `<button type="button" class="btn-table-action btn-table-merge" onclick="openAccountMergeFromTable('${c.id}')" title="Fusionar administrativamente esta cuenta duplicada">
                        🔀 Fusionar
                    </button>`;
                }
                actionsHtml += `<button type="button" class="btn-table-action btn-table-delete" onclick="deleteClient('${c.id}')" title="Eliminar cliente">
                    🗑️
                </button>`;
            }
            actionsHtml += `</div>`;

            tbody.innerHTML += `
                <tr class="client-table-row" data-client-id="${esc(c.id)}">
                    <td class="col-cli-type" style="white-space:nowrap;">${typeBadge}</td>
                    <td class="col-cli-name">
                        <div class="cell-ellipsis cli-name-wrap" style="font-weight:700; color:var(--ds-text-primary, #0F172A); max-width:250px;" title="${esc(mainName)}">
                            <a href="javascript:void(0)" class="ds-account-link" onclick="openClientDetailView('${c.id}')" style="color:var(--ds-primary, #0062B8); text-decoration:none; font-weight:700;">${esc(mainName)}</a>${exportBadge}${absorbedBadge}
                        </div>
                    </td>
                    <td class="col-cli-contact">
                        <div class="cell-ellipsis cli-contact-wrap" style="max-width:210px; color:var(--ds-text-primary, #0F172A);" title="${esc(contactName)}">
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

    let _clientViewOrigin = { view: 'clients-view', prospectId: null, clientId: null, fromNewProspect: false, searchVal: '', sortCol: '', sortDir: 'asc' };

    function _navigateView(viewId, navOptions) {
        if (typeof _deps.showView === 'function') {
            _deps.showView(viewId, navOptions);
        } else if (typeof showView === 'function') {
            showView(viewId, navOptions);
        } else if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
            AppRouter.showView(viewId, navOptions);
        }
    }

    function openClientDetailView(clientId = null, options = {}) {
        if (typeof document === 'undefined') return;

        // Determinar origen de navegación y preservar contexto de tabla (filtros, búsqueda, orden, scroll, fila)
        const newProspectEl = document.getElementById('newProspectModal');
        const detailViewEl = document.getElementById('detail-view');
        const clientDetailViewEl = document.getElementById('client-detail-view');
        const isAlreadyInClientDetail = Boolean(
            clientDetailViewEl &&
            clientDetailViewEl.classList &&
            typeof clientDetailViewEl.classList.contains === 'function' &&
            clientDetailViewEl.classList.contains('active')
        );
        const searchInput = document.getElementById('cli-search');
        const currentSearchVal = (searchInput && typeof searchInput.value === 'string') ? searchInput.value : '';

        let originView = 'clients-view';
        let originProspectId = null;
        let fromNewProspect = false;

        if (options && options.originView) {
            originView = options.originView;
            originProspectId = options.prospectId || null;
        } else if (isAlreadyInClientDetail && _clientViewOrigin && _clientViewOrigin.view) {
            originView = _clientViewOrigin.view;
            originProspectId = _clientViewOrigin.prospectId || null;
            fromNewProspect = Boolean(_clientViewOrigin.fromNewProspect);
        } else if (newProspectEl && newProspectEl.style && newProspectEl.style.display === 'block') {
            originView = 'list-view';
            fromNewProspect = true;
        } else if (detailViewEl && detailViewEl.classList && typeof detailViewEl.classList.contains === 'function' && detailViewEl.classList.contains('active')) {
            originView = 'detail-view';
            originProspectId = (typeof window !== 'undefined' && window.currentDetailId) ? window.currentDetailId : null;
        } else {
            originView = 'clients-view';
        }

        _clientViewOrigin = {
            view: originView,
            prospectId: originProspectId,
            clientId: clientId || (_clientViewOrigin && _clientViewOrigin.clientId) || null,
            fromNewProspect,
            searchVal: isAlreadyInClientDetail && _clientViewOrigin && typeof _clientViewOrigin.searchVal === 'string'
                ? _clientViewOrigin.searchVal
                : currentSearchVal,
            sortCol: isAlreadyInClientDetail && _clientViewOrigin && typeof _clientViewOrigin.sortCol === 'string'
                ? _clientViewOrigin.sortCol
                : cliSortCol,
            sortDir: isAlreadyInClientDetail && _clientViewOrigin && typeof _clientViewOrigin.sortDir === 'string'
                ? _clientViewOrigin.sortDir
                : cliSortDir,
            page: 1
        };

        if (!isAlreadyInClientDetail && originView !== 'detail-view' && typeof _deps.saveListScrollPosition === 'function') {
            _deps.saveListScrollPosition({
                originView,
                recordId: clientId || null,
                recordType: 'client',
                page: 1,
                filters: { cliSearch: currentSearchVal },
                sort: { col: cliSortCol, dir: cliSortDir }
            });
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
        if (typeof clearClientDuplicateFeedback === 'function') {
            clearClientDuplicateFeedback();
        }
        if (typeof closeAccountMergePanel === 'function') {
            closeAccountMergePanel();
        }
        const absorbedBannerEl = document.getElementById('client-absorbed-status-banner');
        if (absorbedBannerEl) {
            if (absorbedBannerEl.style) absorbedBannerEl.style.display = 'none';
            absorbedBannerEl.innerHTML = '';
        }

        const contextTitleEl = document.getElementById('client-view-context-title');
        const contextSubEl = document.getElementById('client-view-context-subtitle');
        const originBadgeBox = document.getElementById('client-view-origin-badge-box');
        const originBadge = document.getElementById('client-view-origin-badge');
        const headerContactsBtn = document.getElementById('btn-client-header-contacts');
        const headerB3HistoryBtn = document.getElementById('btn-client-header-b3-history');
        const headerMergeBtn = document.getElementById('btn-client-header-merge');
        const modalMergeBtn = document.getElementById('btn-client-modal-merge');
        const submitClientBtn = document.getElementById('btn-submit-client');
        const currentUser = _deps.getCurrentUser();
        const isManager = Boolean(currentUser && currentUser.role === 'manager');

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
                const isAbsorbed = Boolean(typeof c.fusionada_en === 'string' && c.fusionada_en.trim());
                let canonicalTarget = c;
                if (isAbsorbed) {
                    const visited = new Set([c.id]);
                    let depth = 0;
                    while (canonicalTarget && typeof canonicalTarget.fusionada_en === 'string' && canonicalTarget.fusionada_en.trim() && depth < 5) {
                        const nextId = canonicalTarget.fusionada_en.trim();
                        if (visited.has(nextId)) break;
                        visited.add(nextId);
                        const nextAcc = clientsList.find(x => x && x.id === nextId);
                        if (!nextAcc) {
                            canonicalTarget = { id: nextId, empresa: nextId };
                            break;
                        }
                        canonicalTarget = nextAcc;
                        depth += 1;
                    }
                    if (currentUser && currentUser.role === 'vendedor') {
                        const visibleIds = new Set((_deps.getVisibleClients() || []).map(x => x && x.id));
                        if (!visibleIds.has(c.id) && (!canonicalTarget || !visibleIds.has(canonicalTarget.id))) {
                            _deps.alert('Acceso denegado: el registro histórico de una cuenta absorbida se rige por los permisos de su cuenta canónica.');
                            return;
                        }
                    }
                }

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

                if (isAbsorbed) {
                    if (headerMergeBtn && headerMergeBtn.style) headerMergeBtn.style.display = 'none';
                    if (modalMergeBtn && modalMergeBtn.style) modalMergeBtn.style.display = 'none';
                    if (submitClientBtn && submitClientBtn.style) submitClientBtn.style.display = 'none';
                    if (titleEl) titleEl.textContent = 'Registro Histórico de Cuenta Absorbida';
                    if (absorbedBannerEl) {
                        const canonicalId = (canonicalTarget && canonicalTarget.id) ? canonicalTarget.id : c.fusionada_en;
                        const canonicalName = (canonicalTarget && canonicalTarget.id) ? getClientName(canonicalTarget.id) : canonicalId;
                        const safeCanId = _escB42(canonicalId);
                        const safeCanName = _escB42(canonicalName);
                        const mergedAtStr = c.fusionada_at ? ` · Fecha: ${_escB42(c.fusionada_at)}` : '';
                        const motivoStr = c.fusionada_motivo ? `<div style="margin-top:4px; font-size:0.8rem; color:#cbd5e1;">Motivo administrativo: ${_escB42(c.fusionada_motivo)}</div>` : '';
                        if (absorbedBannerEl.style) absorbedBannerEl.style.display = 'block';
                        absorbedBannerEl.innerHTML = `
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                                <div>
                                    <div style="font-weight:700; font-size:0.95rem; color:#93c5fd; display:flex; align-items:center; gap:8px;">
                                        <span>🔗</span> Cuenta histórica absorbida mediante fusión administrativa
                                    </div>
                                    <div style="margin-top:4px; font-size:0.84rem; color:#e2e8f0;">
                                        Esta cuenta fue fusionada en la cuenta canónica activa <strong>${safeCanName}</strong> (<code style="color:#fde68a;">${safeCanId}</code>)${mergedAtStr}. Su historial comercial, contactos, oportunidades y documentos se conservan íntegramente.
                                    </div>
                                    ${motivoStr}
                                </div>
                                <div>
                                    <button type="button" class="btn-primary" id="btn-b43-goto-canonical" style="padding:7px 14px; font-size:0.83rem; font-weight:600; background:#2563eb; border-color:#3b82f6;" onclick="if(typeof ClientsUI!=='undefined'&&ClientsUI.navigateToCanonicalAccount){ClientsUI.navigateToCanonicalAccount('${safeCanId}')}">
                                        ➡️ Ir a Cuenta Canónica (${safeCanName})
                                    </button>
                                </div>
                            </div>
                        `;
                    }
                } else {
                    if (submitClientBtn && submitClientBtn.style) submitClientBtn.style.display = 'inline-block';
                    if (headerMergeBtn && headerMergeBtn.style) headerMergeBtn.style.display = isManager ? 'inline-block' : 'none';
                    if (modalMergeBtn && modalMergeBtn.style) modalMergeBtn.style.display = isManager ? 'inline-block' : 'none';
                }

                const initialTab = (options && options.initialTab) ? options.initialTab : 'resumen';
                renderAccount360Hub(c, initialTab);
            }
        } else {
            _restoreExpedienteToForm();
            const hubEl = document.getElementById('account-360-hub-container');
            if (hubEl && hubEl.style) hubEl.style.display = 'none';
            const ctxCardEl = document.getElementById('client-detail-context-card');
            if (ctxCardEl && ctxCardEl.style) ctxCardEl.style.display = 'block';
            if (typeof window !== 'undefined') window._activeClientBaseDocs = null;
            const titleEl = document.getElementById('client-modal-title');
            if (titleEl) titleEl.textContent = 'Registrar Cliente';
            if (contextTitleEl) contextTitleEl.textContent = 'Registrar Nueva Cuenta Comercial';
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
            if (headerMergeBtn && headerMergeBtn.style) headerMergeBtn.style.display = 'none';
            if (modalMergeBtn && modalMergeBtn.style) modalMergeBtn.style.display = 'none';
            if (submitClientBtn && submitClientBtn.style) submitClientBtn.style.display = 'inline-block';
        }

        const hubCheckEl = document.getElementById('account-360-hub-container');
        const contentEl = document.getElementById('clientDetailContent');
        if (contentEl && contentEl.style) {
            if (clientId && hubCheckEl && _activeAccount360State.activeTab && _activeAccount360State.activeTab !== 'ficha') {
                contentEl.style.display = 'none';
            } else {
                contentEl.style.display = 'block';
            }
        }
        _navigateView('client-detail-view');

        if (!(options && options.preserveDetailScroll) && typeof _deps.scrollDetailViewToTop === 'function') {
            _deps.scrollDetailViewToTop('client-detail-view');
        }
    }

    function closeClientDetailView(options = {}) {
        _restoreExpedienteToForm();
        if (typeof _deps.cancelPendingClientReservation === 'function') {
            _deps.cancelPendingClientReservation();
        }
        if (typeof clearClientDuplicateFeedback === 'function') {
            clearClientDuplicateFeedback();
        }
        if (typeof document !== 'undefined') {
            const contentEl = document.getElementById('clientDetailContent');
            if (contentEl && contentEl.style) contentEl.style.display = 'none';
            const hubEl = document.getElementById('account-360-hub-container');
            if (hubEl && hubEl.style) hubEl.style.display = 'none';
        }
        const navOpts = {
            fromPopstate: Boolean(options && options.fromPopstate),
            preserveListMode: true
        };
        if (_clientViewOrigin && _clientViewOrigin.fromNewProspect) {
            _navigateView('list-view', navOpts);
            if (typeof _deps.restoreListScrollPosition === 'function') {
                _deps.restoreListScrollPosition({ targetSection: 'list-view', fromPopstate: navOpts.fromPopstate });
            }
        } else if (_clientViewOrigin && _clientViewOrigin.view === 'detail-view' && _clientViewOrigin.prospectId) {
            _navigateView('detail-view', navOpts);
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') {
                window.openDetail(_clientViewOrigin.prospectId, { skipSaveContext: true });
            }
        } else {
            const targetView = (_clientViewOrigin && typeof _clientViewOrigin.view === 'string' && _clientViewOrigin.view && _clientViewOrigin.view !== 'client-detail-view')
                ? _clientViewOrigin.view
                : 'clients-view';
            if (_clientViewOrigin && typeof document !== 'undefined') {
                const searchInput = document.getElementById('cli-search');
                if (searchInput && _clientViewOrigin.searchVal !== undefined && searchInput.value !== _clientViewOrigin.searchVal) {
                    searchInput.value = _clientViewOrigin.searchVal;
                }
                if (_clientViewOrigin.sortCol !== undefined) {
                    cliSortCol = _clientViewOrigin.sortCol;
                    cliSortDir = _clientViewOrigin.sortDir || 'asc';
                    updateCliSortIcons();
                }
            }
            _navigateView(targetView, navOpts);
            renderClientsTable();
            if (typeof _deps.restoreListScrollPosition === 'function') {
                _deps.restoreListScrollPosition({
                    recordId: (_clientViewOrigin && _clientViewOrigin.clientId) || null,
                    recordType: 'client',
                    targetSection: targetView,
                    fromPopstate: navOpts.fromPopstate
                });
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4.1. Cuenta 360 — Commercial First Hub & Spoke (Fase B6)
    // -------------------------------------------------------------------------
    let _activeAccount360State = {
        clientId: null,
        activeTab: 'resumen',
        contactsCache: {}
    };

    function _restoreExpedienteToForm() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const expEl = document.getElementById('client-expediente-section');
        const formEl = document.getElementById('clientForm');
        if (!expEl || !formEl) return;
        if (expEl.parentElement !== formEl) {
            const submitBtn = document.getElementById('btn-submit-client');
            const actionRow = submitBtn ? submitBtn.parentElement : null;
            if (actionRow && actionRow.parentElement === formEl && typeof formEl.insertBefore === 'function') {
                formEl.insertBefore(expEl, actionRow);
            } else if (typeof formEl.appendChild === 'function') {
                formEl.appendChild(expEl);
            }
        }
    }

    function _formatUsdB6(amount) {
        const num = Number(amount) || 0;
        return 'US$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function _computeAccount360MetricsSafe(clientId) {
        const prospectsList = _deps.getProspects() || [];
        if (typeof CrmBiEngine !== 'undefined' && typeof CrmBiEngine.computeAccount360Metrics === 'function') {
            return CrmBiEngine.computeAccount360Metrics(clientId, prospectsList);
        }
        if (typeof window !== 'undefined' && window.CrmBiEngine && typeof window.CrmBiEngine.computeAccount360Metrics === 'function') {
            return window.CrmBiEngine.computeAccount360Metrics(clientId, prospectsList);
        }
        const acctOpps = prospectsList.filter(p => p && !p.deleted && p.clientId === clientId);
        return {
            accountId: clientId,
            totalOpportunitiesCount: acctOpps.length,
            activeCount: acctOpps.filter(p => p.estado === 'activo').length,
            wonCount: acctOpps.filter(p => p.estado === 'ganado').length,
            lostCount: acctOpps.filter(p => p.estado === 'perdido').length,
            facturacionTotal: 0,
            totalCobrado: 0,
            saldoPorCobrar: 0,
            overdueAmount: 0,
            pipelineActivo: 0,
            winRate: 0,
            ticketPromedio: 0,
            margenRealPct: 0,
            cicloPromedioDias: 0,
            propuestasPresentadasCount: 0,
            proposalCountsByState: { preliminar: 0, oferta_preparada: 0, propuesta_entregada: 0, decidida: 0 },
            opportunitiesNeedingAttention: [],
            opportunities: acctOpps
        };
    }

    function _renderProposalLifecycleBadgeB6(lifecycle) {
        if (!lifecycle || !lifecycle.state) {
            return '<span class="ds-badge ds-badge-neutral">Sin clasificar</span>';
        }
        if (lifecycle.state === 'propuesta_entregada') {
            const evHint = lifecycle.deliveryEvidenceType === 'explicit' ? 'Fecha registrada' : 'Avance de etapa';
            const vBadge = lifecycle.offersCount > 0 ? ` · v${lifecycle.offersCount}` : '';
            return `<span class="ds-badge ds-badge-primary" title="Propuesta entregada (${evHint})">📤 Propuesta entregada${vBadge}</span>`;
        }
        if (lifecycle.state === 'oferta_preparada') {
            const vBadge = lifecycle.offersCount > 0 ? ` · v${lifecycle.offersCount}` : '';
            return `<span class="ds-badge ds-badge-warning" title="Oferta preparada pendiente de entrega formal">📝 Oferta preparada${vBadge}</span>`;
        }
        if (lifecycle.state === 'decidida') {
            const evText = lifecycle.countsAsPresented ? 'Propuesta presentada' : 'Sin oferta';
            return `<span class="ds-badge ds-badge-neutral" title="Oportunidad decidida (${evText})">🏁 Decidida</span>`;
        }
        return '<span class="ds-badge ds-badge-neutral" title="Etapa inicial sin oferta económica">🌱 Preliminar</span>';
    }

    function _renderStageBadgeB6(p) {
        const estado = String(p && p.estado || 'activo').toLowerCase();
        const etapa = String(p && p.etapa || 'prospecto').toLowerCase();
        if (estado === 'ganado') return '<span class="ds-badge ds-badge-success">🏆 Ganado</span>';
        if (estado === 'perdido') return '<span class="ds-badge ds-badge-danger">❌ Perdido</span>';
        const map = {
            prospecto: '<span class="ds-badge ds-badge-neutral">1. Prospecto</span>',
            levantamiento: '<span class="ds-badge ds-badge-info">2. Levantamiento</span>',
            cotizacion: '<span class="ds-badge ds-badge-warning">3. Cotización</span>',
            negociacion: '<span class="ds-badge ds-badge-primary">4. Negociación</span>',
            cierre: '<span class="ds-badge ds-badge-primary">5. Cierre</span>'
        };
        return map[etapa] || `<span class="ds-badge ds-badge-neutral">${_escB42(etapa)}</span>`;
    }

    function openNewOpportunityFromAccount(clientId) {
        if (!clientId) return;
        const cName = getClientName(clientId);
        if (typeof window !== 'undefined' && typeof window.openNewProspectModal === 'function') {
            window.openNewProspectModal();
            selectClientInSelector(clientId, cName);
        } else {
            _navigateView('list-view');
            selectClientInSelector(clientId, cName);
        }
    }

    function setAccount360Tab(tabId) {
        const clientId = _activeAccount360State.clientId || (typeof document !== 'undefined' && document.getElementById('client-id-edit') ? document.getElementById('client-id-edit').value : null);
        if (!clientId) return;
        const clientsList = _deps.getClients() || [];
        const c = clientsList.find(x => x && x.id === clientId);
        if (!c) return;
        renderAccount360Hub(c, tabId || 'resumen');
    }

    async function _loadAccount360ContactsAsync(clientId, c) {
        if (!clientId || typeof document === 'undefined') return;
        let items = _activeAccount360State.contactsCache[clientId] || null;
        if (!items && typeof window !== 'undefined' && window.CrmContacts && typeof window.CrmContacts.listAccountContacts === 'function') {
            try {
                const res = await window.CrmContacts.listAccountContacts(clientId, { includeHistorical: true });
                if (res && Array.isArray(res.items)) {
                    items = res.items;
                    _activeAccount360State.contactsCache[clientId] = items;
                }
            } catch (_) {
                items = [];
            }
        }
        if (!items) items = [];

        const esc = _deps.escapeHtmlDoc;
        const summaryBox = document.getElementById('account-360-summary-contacts-preview');
        const fullBox = document.getElementById('account-360-contacts-dynamic-box');

        const activeRelations = items.filter(it => it && it.relation && it.relation.status === 'active');
        const fallbackContactName = c && c.tipo === 'natural'
            ? `${c.nombres || ''} ${c.apellidos || ''}`.trim()
            : (c && c.contacto ? c.contacto : '');

        if (summaryBox) {
            if (activeRelations.length > 0) {
                summaryBox.innerHTML = activeRelations.slice(0, 4).map(item => {
                    const person = item.contact || {};
                    const rel = item.relation || {};
                    const roles = Array.isArray(rel.roles) && rel.roles.length ? rel.roles.join(', ') : (rel.cargo || 'Contacto comercial');
                    const pId = esc(person.id || rel.contactId || '');
                    const pName = esc(person.nombreCompleto || `${person.nombres || ''} ${person.apellidos || ''}`.trim() || 'Contacto');
                    const pCargo = esc(rel.cargo || roles);
                    const pPhone = esc(rel.telefonoCorporativo || person.telefono || c.telefono || '-');
                    const pEmail = esc(rel.correoCorporativo || person.correo || c.correo || '-');
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; padding:0.55rem 0.65rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC); margin-bottom:0.45rem;">
                            <div style="min-width:0;">
                                <div style="font-weight:700; font-size:0.84rem; color:var(--ds-text-primary, #0F172A);">${pName}</div>
                                <div style="font-size:0.74rem; color:var(--ds-text-secondary, #334155);">${pCargo} · 📞 ${pPhone} · ✉️ ${pEmail}</div>
                            </div>
                            ${pId ? `<button type="button" class="btn-secondary" style="padding:0.25rem 0.55rem; font-size:0.73rem; white-space:nowrap;" onclick="if(typeof ContactsUI!=='undefined'&&ContactsUI.openContact360View){ContactsUI.openContact360View('${pId}',{originAccountId:'${esc(clientId)}'})}else if(typeof ContactsUI!=='undefined'){ContactsUI.openAccountContactsModal('${esc(clientId)}')}">👤 Ficha 360</button>` : ''}
                        </div>
                    `;
                }).join('');
            } else if (fallbackContactName) {
                summaryBox.innerHTML = `
                    <div style="padding:0.65rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
                            <div>
                                <div style="font-weight:700; font-size:0.85rem; color:var(--ds-text-primary, #0F172A);">👤 ${esc(fallbackContactName)}</div>
                                <div style="font-size:0.76rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">Interlocutor registrado en ficha · 📞 ${esc(c.telefono || 'Sin teléfono')} · ✉️ ${esc(c.correo || 'Sin correo')}</div>
                            </div>
                            <span class="ds-badge ds-badge-info">Interlocutor</span>
                        </div>
                        ${c.rep_legal ? `<div style="margin-top:0.45rem; padding-top:0.45rem; border-top:1px solid var(--ds-border, #CBD5E1); font-size:0.76rem; color:var(--ds-text-secondary, #334155);">⚖️ <strong>Representante Legal:</strong> ${esc(c.rep_legal)} ${c.dui_rep ? `(DUI: ${esc(c.dui_rep)})` : ''}</div>` : ''}
                    </div>
                `;
            } else {
                summaryBox.innerHTML = `<div style="padding:0.75rem; text-align:center; color:var(--ds-text-muted, #64748B); font-size:0.8rem;">Sin contactos vinculados aún. Usa "Gestionar Contactos" para vincular o registrar personas.</div>`;
            }
        }

        if (fullBox) {
            if (items.length > 0) {
                fullBox.innerHTML = `
                    <div class="table-responsive">
                        <table style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr>
                                    <th>Persona / Identidad</th>
                                    <th>Cargo y Roles en la Cuenta</th>
                                    <th>Canales Corporativos</th>
                                    <th>Estado / Vigencia</th>
                                    <th style="text-align:right;">Acción</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${items.map(item => {
                                    const person = item.contact || {};
                                    const rel = item.relation || {};
                                    const isAct = rel.status === 'active';
                                    const pId = esc(person.id || rel.contactId || '');
                                    const pName = esc(person.nombreCompleto || `${person.nombres || ''} ${person.apellidos || ''}`.trim() || 'Contacto');
                                    const rolesArr = Array.isArray(rel.roles) ? rel.roles : [];
                                    const roleBadges = rolesArr.length
                                        ? rolesArr.map(r => `<span class="ds-badge ds-badge-primary" style="margin-right:4px;">${esc(r)}</span>`).join('')
                                        : `<span class="ds-badge ds-badge-neutral">${esc(rel.cargo || 'Comercial')}</span>`;
                                    const phone = esc(rel.telefonoCorporativo || person.telefono || '-');
                                    const email = esc(rel.correoCorporativo || person.correo || '-');
                                    const statusBadge = isAct
                                        ? '<span class="ds-badge ds-badge-success">Vigente</span>'
                                        : '<span class="ds-badge ds-badge-neutral">Histórico</span>';
                                    return `
                                        <tr>
                                            <td>
                                                <div style="font-weight:700; color:var(--ds-text-primary, #0F172A);">${pName}</div>
                                                <div style="font-size:0.75rem; color:var(--ds-text-muted, #64748B);">${person.dui ? `DUI: ${esc(person.dui)}` : 'Contacto comercial (DUI no requerido)'}</div>
                                            </td>
                                            <td>
                                                <div style="font-weight:600; font-size:0.83rem; color:var(--ds-text-primary, #0F172A); margin-bottom:2px;">${esc(rel.cargo || 'Interlocutor Comercial')}</div>
                                                <div>${roleBadges}</div>
                                            </td>
                                            <td style="font-size:0.82rem; color:var(--ds-text-secondary, #334155);">
                                                <div>📞 ${phone}</div>
                                                <div>✉️ ${email}</div>
                                            </td>
                                            <td>${statusBadge}</td>
                                            <td style="text-align:right; white-space:nowrap;">
                                                ${pId ? `<button type="button" class="btn-table-action" onclick="if(typeof ContactsUI!=='undefined'&&ContactsUI.openContact360View){ContactsUI.openContact360View('${pId}',{originAccountId:'${esc(clientId)}'})}">👤 Contacto 360</button>` : ''}
                                                <button type="button" class="btn-table-action" onclick="ContactsUI.openAccountContactsModal('${esc(clientId)}')">⚙️ Gestionar</button>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            } else {
                fullBox.innerHTML = `
                    <div style="padding:1rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:8px; background:var(--ds-bg-subtle, #F8FAFC);">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
                            <div>
                                <div style="font-weight:700; font-size:0.9rem; color:var(--ds-text-primary, #0F172A);">
                                    ${fallbackContactName ? `👤 Interlocutor registrado: ${esc(fallbackContactName)}` : 'Sin relaciones multiproceso registradas en account_contacts'}
                                </div>
                                <div style="font-size:0.8rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">
                                    📞 ${esc(c.telefono || 'Sin teléfono')} · ✉️ ${esc(c.correo || 'Sin correo')}
                                    ${c.rep_legal ? ` · ⚖️ Representante Legal: <strong>${esc(c.rep_legal)}</strong>` : ''}
                                </div>
                                <div style="font-size:0.76rem; color:var(--ds-text-muted, #64748B); margin-top:4px;">
                                    Nota de arquitectura B6: No se exige "Contacto Principal de Cuenta". Puedes vincular múltiples contactos comerciales, técnicos, representantes legales o apoderados reutilizando identidades globales.
                                </div>
                            </div>
                            <button type="button" class="btn-primary" style="padding:0.45rem 0.9rem; font-size:0.82rem;" onclick="ContactsUI.openAccountContactsModal('${esc(clientId)}')">
                                👥 Abrir Gestor de Contactos de la Cuenta
                            </button>
                        </div>
                    </div>
                `;
            }
        }
    }

    function renderAccount360Hub(c, activeTab = 'resumen') {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || !c) return;
        const hubContainer = document.getElementById('account-360-hub-container');
        if (!hubContainer) return;

        // First rescue #client-expediente-section back into #clientForm before replacing hubContainer.innerHTML
        _restoreExpedienteToForm();

        const validTabs = ['resumen', 'contactos', 'oportunidades', 'legal', 'finanzas', 'ficha'];
        const tab = validTabs.includes(activeTab) ? activeTab : 'resumen';
        _activeAccount360State.clientId = c.id;
        _activeAccount360State.activeTab = tab;

        const esc = _deps.escapeHtmlDoc;
        const currentUser = _deps.getCurrentUser();
        const isManager = Boolean(currentUser && currentUser.role === 'manager');
        const isNatural = c.tipo === 'natural';
        const isExport = c.es_exportacion === true || c.es_exportacion === 'true';
        const isGranContrib = c.is_gran_contribuyente === true || c.is_gran_contribuyente === 'true';
        const isAbsorbed = Boolean(typeof c.fusionada_en === 'string' && c.fusionada_en.trim());

        const displayName = isNatural
            ? `${c.nombres || ''} ${c.apellidos || ''}`.trim()
            : (c.empresa || 'Cuenta Comercial');

        const metrics = _computeAccount360MetricsSafe(c.id);
        const docsObj = (c.documentos && typeof c.documentos === 'object') ? c.documentos : {};
        const uploadedDocsCount = Object.keys(docsObj).filter(k => docsObj[k] && (docsObj[k].storagePath || docsObj[k].url || docsObj[k].fileName)).length;
        const requiredDocsCount = isNatural ? 3 : 6;
        const legalStatusBadge = uploadedDocsCount >= requiredDocsCount
            ? `<span class="ds-badge ds-badge-success">⚖️ Expediente Legal (${uploadedDocsCount}/${requiredDocsCount})</span>`
            : `<span class="ds-badge ds-badge-warning">⚖️ Doc. Legal (${uploadedDocsCount}/${requiredDocsCount})</span>`;

        const cxcBadge = metrics.overdueAmount > 0
            ? `<span class="ds-badge ds-badge-danger">Vencido: ${_formatUsdB6(metrics.overdueAmount)}</span>`
            : (metrics.saldoPorCobrar > 0
                ? `<span class="ds-badge ds-badge-warning">Por vencer</span>`
                : `<span class="ds-badge ds-badge-success">Al día</span>`);

        const kpiStripHtml = tab === 'legal' ? '' : `
            <div class="ds-kpi-grid" style="margin-bottom: 0.75rem;">
                <div class="ds-kpi-card">
                    <span class="ds-kpi-label">Facturación Histórica</span>
                    <div class="ds-kpi-value">${_formatUsdB6(metrics.facturacionTotal)}</div>
                    <div class="ds-kpi-sub">
                        <span class="ds-badge ds-badge-success">${metrics.wonCount} ganadas</span>
                        <span>Ticket prom: ${_formatUsdB6(metrics.ticketPromedio)}</span>
                    </div>
                </div>
                <div class="ds-kpi-card">
                    <span class="ds-kpi-label">Pipeline Activo</span>
                    <div class="ds-kpi-value" style="color:var(--ds-primary, #0062B8);">${_formatUsdB6(metrics.pipelineActivo)}</div>
                    <div class="ds-kpi-sub">
                        <span class="ds-badge ds-badge-info">${metrics.activeCount} activas</span>
                        <span>${metrics.opportunitiesNeedingAttention.length > 0 ? `<strong style="color:var(--ds-warning, #B45309);">⚠️ ${metrics.opportunitiesNeedingAttention.length} por atender</strong>` : 'Al día en seguimiento'}</span>
                    </div>
                </div>
                <div class="ds-kpi-card">
                    <span class="ds-kpi-label">Saldo Pendiente (CxC)</span>
                    <div class="ds-kpi-value" style="color:${metrics.overdueAmount > 0 ? 'var(--ds-danger, #B91C1C)' : 'var(--ds-text-primary, #0F172A)'};">${_formatUsdB6(metrics.saldoPorCobrar)}</div>
                    <div class="ds-kpi-sub">
                        ${cxcBadge}
                        <span>Cobrado: ${_formatUsdB6(metrics.totalCobrado)}</span>
                    </div>
                </div>
                <div class="ds-kpi-card">
                    <span class="ds-kpi-label">Win Rate &amp; Propuestas</span>
                    <div class="ds-kpi-value">${metrics.winRate.toFixed(1)}%</div>
                    <div class="ds-kpi-sub">
                        <span class="ds-badge ds-badge-primary" title="Cada oportunidad con propuesta entregada cuenta máximo 1 vez aunque tenga versiones v1..vN">${metrics.propuestasPresentadasCount} propuestas presentadas</span>
                        <span>Ciclo: ${metrics.cicloPromedioDias || 0}d</span>
                    </div>
                </div>
            </div>
        `;

        let tabBodyHtml = '';
        if (tab === 'resumen') {
            const oppsRowsHtml = metrics.opportunities.length === 0
                ? `<div style="padding:1.2rem; text-align:center; color:var(--ds-text-muted, #64748B); font-size:0.84rem;">
                    Esta cuenta aún no registra oportunidades comerciales.
                    <div style="margin-top:0.5rem;">
                        <button type="button" class="btn-primary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" onclick="ClientsUI.openNewOpportunityFromAccount('${esc(c.id)}')">+ Crear Primera Oportunidad</button>
                    </div>
                   </div>`
                : `<div class="table-responsive">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead>
                            <tr>
                                <th>Oportunidad / Proyecto</th>
                                <th>Etapa</th>
                                <th>Ciclo de Propuesta</th>
                                <th style="text-align:right;">Monto</th>
                                <th>Seguimiento</th>
                                <th style="text-align:right;">Acción</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${metrics.opportunities.slice(0, 8).map(p => {
                                const amt = Number(p.estado === 'ganado' ? (p.precio_pactado || p.precio_final || p.precio_cotizado || 0) : (p.precio_cotizado || p.precio_pactado || 0));
                                const attnBadge = p.requiresAttention
                                    ? `<span class="ds-badge ds-badge-warning" title="${esc((p.attentionReasons || []).join(' · '))}">⚠️ ${esc(p.attentionReasons[0] || 'Atención')}</span>`
                                    : (p.estado === 'activo' ? '<span class="ds-badge ds-badge-success">✅ Al día</span>' : '<span class="ds-badge ds-badge-neutral">Cerrada</span>');
                                return `
                                    <tr>
                                        <td>
                                            <div style="font-weight:700; color:var(--ds-text-primary, #0F172A);">${esc(p.proyecto || 'Proyecto sin título')}</div>
                                            <div style="font-size:0.74rem; color:var(--ds-text-muted, #64748B); font-family:monospace;">${esc(p.codigo || p.id)} · Vend: ${esc(p.vendedor || '-')}</div>
                                        </td>
                                        <td>${_renderStageBadgeB6(p)}</td>
                                        <td>${_renderProposalLifecycleBadgeB6(p.proposalLifecycle)}</td>
                                        <td style="text-align:right; font-weight:700; font-variant-numeric:tabular-nums;">${_formatUsdB6(amt)}</td>
                                        <td>${attnBadge}</td>
                                        <td style="text-align:right;">
                                            <button type="button" class="btn-table-action" onclick="if(typeof openDetail==='function'){openDetail('${esc(p.id)}')}">📂 Abrir</button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                   </div>`;

            tabBodyHtml = `
                <div class="ds-account-360-split">
                    <div style="display:flex; flex-direction:column; gap:0.85rem;">
                        <div class="ds-panel-box">
                            <div class="ds-panel-box-header">
                                <div class="ds-panel-box-title">
                                    <span>💼 Oportunidades de la Cuenta y Atención Prioritaria</span>
                                    ${metrics.opportunitiesNeedingAttention.length > 0 ? `<span class="ds-badge ds-badge-warning">⚠️ ${metrics.opportunitiesNeedingAttention.length} requieren atención</span>` : ''}
                                </div>
                                <div style="display:flex; gap:0.4rem;">
                                    <button type="button" class="btn-secondary" style="padding:0.3rem 0.65rem; font-size:0.76rem;" onclick="ClientsUI.setAccount360Tab('oportunidades')">Ver todas (${metrics.totalOpportunitiesCount})</button>
                                    <button type="button" class="btn-primary" style="padding:0.3rem 0.7rem; font-size:0.76rem;" onclick="ClientsUI.openNewOpportunityFromAccount('${esc(c.id)}')">+ Nueva Oportunidad</button>
                                </div>
                            </div>
                            ${oppsRowsHtml}
                        </div>

                        <div class="ds-panel-box">
                            <div class="ds-panel-box-header">
                                <div class="ds-panel-box-title">
                                    <span>📐 Regla Comercial de Propuestas Presentadas (1 máx. por oportunidad)</span>
                                </div>
                                <span class="ds-badge ds-badge-primary">${metrics.propuestasPresentadasCount} presentadas de ${metrics.totalOpportunitiesCount} op.</span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:0.55rem;">
                                <div style="padding:0.55rem 0.7rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                                    <div style="font-size:0.7rem; font-weight:700; color:var(--ds-text-muted, #64748B); text-transform:uppercase;">1. Preliminar</div>
                                    <div style="font-size:1.1rem; font-weight:800; color:var(--ds-text-primary, #0F172A); margin-top:2px;">${metrics.proposalCountsByState.preliminar}</div>
                                    <div style="font-size:0.72rem; color:var(--ds-text-secondary, #334155);">Prospecto / Levantamiento</div>
                                </div>
                                <div style="padding:0.55rem 0.7rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                                    <div style="font-size:0.7rem; font-weight:700; color:var(--ds-warning, #B45309); text-transform:uppercase;">2. Oferta Preparada</div>
                                    <div style="font-size:1.1rem; font-weight:800; color:var(--ds-warning, #B45309); margin-top:2px;">${metrics.proposalCountsByState.oferta_preparada}</div>
                                    <div style="font-size:0.72rem; color:var(--ds-text-secondary, #334155);">Cotización sin entrega</div>
                                </div>
                                <div style="padding:0.55rem 0.7rem; border:1px solid var(--ds-primary-border, #93C5FD); border-radius:6px; background:var(--ds-primary-soft, #EBF3FA);">
                                    <div style="font-size:0.7rem; font-weight:700; color:var(--ds-primary, #0062B8); text-transform:uppercase;">3. Propuesta Entregada</div>
                                    <div style="font-size:1.1rem; font-weight:800; color:var(--ds-primary, #0062B8); margin-top:2px;">${metrics.proposalCountsByState.propuesta_entregada}</div>
                                    <div style="font-size:0.72rem; color:var(--ds-text-secondary, #334155);">En negociación / cierre</div>
                                </div>
                                <div style="padding:0.55rem 0.7rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                                    <div style="font-size:0.7rem; font-weight:700; color:var(--ds-success, #047857); text-transform:uppercase;">4. Decidida</div>
                                    <div style="font-size:1.1rem; font-weight:800; color:var(--ds-text-primary, #0F172A); margin-top:2px;">${metrics.proposalCountsByState.decidida}</div>
                                    <div style="font-size:0.72rem; color:var(--ds-text-secondary, #334155);">${metrics.wonCount} ganadas · ${metrics.lostCount} perdidas</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:0.85rem;">
                        <div class="ds-panel-box">
                            <div class="ds-panel-box-header">
                                <div class="ds-panel-box-title">
                                    <span>👥 Contactos de la Cuenta</span>
                                </div>
                                <button type="button" class="btn-secondary" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="ContactsUI.openAccountContactsModal('${esc(c.id)}')">Gestionar</button>
                            </div>
                            <div id="account-360-summary-contacts-preview">
                                <div style="font-size:0.8rem; color:var(--ds-text-muted, #64748B);">Cargando contactos vinculados...</div>
                            </div>
                        </div>

                        <div class="ds-panel-box">
                            <div class="ds-panel-box-header">
                                <div class="ds-panel-box-title">
                                    <span>⚖️ Síntesis Legal y Fiscal</span>
                                </div>
                                <button type="button" class="btn-secondary" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="ClientsUI.setAccount360Tab('legal')">Ver Expediente</button>
                            </div>
                            <div style="font-size:0.82rem; color:var(--ds-text-secondary, #334155); display:flex; flex-direction:column; gap:0.4rem;">
                                <div><strong>Régimen:</strong> ${isNatural ? 'Persona Natural' : 'Persona Jurídica'} ${isGranContrib ? '· 🏛️ Gran Contribuyente (1% IVA)' : ''} ${isExport ? '· ✈️ Exportación (0% IVA)' : ''}</div>
                                <div><strong>NIT:</strong> <span style="font-family:monospace;">${esc(c.nit || 'Pendiente')}</span> · <strong>${isNatural ? 'DUI' : 'NRC'}:</strong> <span style="font-family:monospace;">${esc(isNatural ? (c.dui || 'Pendiente') : (c.nrc || 'Pendiente'))}</span></div>
                                ${!isNatural ? `<div><strong>Representante Legal:</strong> ${esc(c.rep_legal || 'Pendiente')}</div>` : ''}
                                <div><strong>Facturación Electrónica (DTE):</strong> ${esc(c.correo_fact || c.correo || 'Sin correo')}</div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (tab === 'contactos') {
            tabBodyHtml = `
                <div class="ds-panel-box">
                    <div class="ds-panel-box-header">
                        <div>
                            <div class="ds-panel-box-title">👥 Contactos Vinculados a ${esc(displayName)}</div>
                            <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">
                                Personas asociadas a esta cuenta comercial (roles comerciales, técnicos, representantes legales y apoderados). Una misma persona puede tener vínculos con varias empresas sin duplicar su identidad.
                            </div>
                        </div>
                        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                            <button type="button" class="btn-secondary" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="if(typeof showView==='function'){showView('contacts-view')}">🌐 Directorio Global de Contactos</button>
                            <button type="button" class="btn-primary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" onclick="ContactsUI.openAccountContactsModal('${esc(c.id)}')">+ Vincular / Gestionar Contactos</button>
                        </div>
                    </div>
                    <div id="account-360-contacts-dynamic-box">
                        <div style="padding:1rem; color:var(--ds-text-muted, #64748B); font-size:0.84rem;">Cargando directorio de contactos de la cuenta...</div>
                    </div>
                </div>
            `;
        } else if (tab === 'oportunidades') {
            tabBodyHtml = `
                <div class="ds-panel-box">
                    <div class="ds-panel-box-header">
                        <div>
                            <div class="ds-panel-box-title">💼 Historial Completo de Oportunidades y Propuestas (${metrics.totalOpportunitiesCount})</div>
                            <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">
                                Propuestas presentadas: <strong>${metrics.propuestasPresentadasCount}</strong> (cada oportunidad cuenta máximo 1 vez aunque tenga múltiples versiones v1..vN).
                            </div>
                        </div>
                        <button type="button" class="btn-primary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" onclick="ClientsUI.openNewOpportunityFromAccount('${esc(c.id)}')">+ Nueva Oportunidad</button>
                    </div>
                    ${metrics.opportunities.length === 0
                        ? `<div style="padding:1.5rem; text-align:center; color:var(--ds-text-muted, #64748B);">No hay oportunidades registradas para esta cuenta.</div>`
                        : `<div class="table-responsive">
                            <table style="width:100%; border-collapse:collapse;">
                                <thead>
                                    <tr>
                                        <th>Código</th>
                                        <th>Proyecto</th>
                                        <th>Vendedor</th>
                                        <th>Etapa</th>
                                        <th>Estado de Propuesta</th>
                                        <th>Evidencia Entrega</th>
                                        <th style="text-align:right;">Monto</th>
                                        <th>Atención</th>
                                        <th style="text-align:right;">Acción</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${metrics.opportunities.map(p => {
                                        const lc = p.proposalLifecycle || {};
                                        const amt = Number(p.estado === 'ganado' ? (p.precio_pactado || p.precio_final || p.precio_cotizado || 0) : (p.precio_cotizado || p.precio_pactado || 0));
                                        const evLabel = lc.deliveryEvidenceType === 'explicit'
                                            ? `<span style="color:var(--ds-success, #047857); font-weight:600; font-size:0.76rem;">📅 ${esc(lc.explicitDeliveryDate || 'Explícita')}</span>`
                                            : (lc.deliveryEvidenceType === 'inferred'
                                                ? `<span style="color:var(--ds-primary, #0062B8); font-size:0.76rem;" title="Inferida por avance histórico a negociación/cierre/ganado (sin inventar fecha)">🔄 Inferida por etapa</span>`
                                                : `<span style="color:var(--ds-text-muted, #64748B); font-size:0.76rem;">—</span>`);
                                        const attnBadge = p.requiresAttention
                                            ? `<span class="ds-badge ds-badge-warning">⚠️ ${esc((p.attentionReasons && p.attentionReasons[0]) || 'Atender')}</span>`
                                            : '<span class="ds-badge ds-badge-neutral">Normal</span>';
                                        return `
                                            <tr>
                                                <td style="font-family:monospace; font-size:0.8rem; font-weight:600;">${esc(p.codigo || p.id)}</td>
                                                <td style="font-weight:700; color:var(--ds-text-primary, #0F172A);">${esc(p.proyecto || '-')}</td>
                                                <td style="font-size:0.82rem;">${esc(p.vendedor || '-')}</td>
                                                <td>${_renderStageBadgeB6(p)}</td>
                                                <td>${_renderProposalLifecycleBadgeB6(lc)}</td>
                                                <td>${evLabel}</td>
                                                <td style="text-align:right; font-weight:700; font-variant-numeric:tabular-nums;">${_formatUsdB6(amt)}</td>
                                                <td>${attnBadge}</td>
                                                <td style="text-align:right;">
                                                    <button type="button" class="btn-table-action" onclick="if(typeof openDetail==='function'){openDetail('${esc(p.id)}')}">📂 Expediente</button>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                           </div>`}
                </div>
            `;
        } else if (tab === 'legal') {
            tabBodyHtml = `
                <div class="ds-panel-box" style="margin-bottom:0.85rem;">
                    <div class="ds-panel-box-header">
                        <div>
                            <div class="ds-panel-box-title">⚖️ Identidad Jurídica, Fiscal y Gobernanza Documental B3</div>
                            <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">
                                Vista unificada del expediente legal y fiscal de la cuenta (sin duplicar bloques de carga ni repetir KPIs comerciales).
                            </div>
                        </div>
                        <div style="display:flex; gap:0.45rem; flex-wrap:wrap;">
                            ${!isNatural ? `<button type="button" class="btn-secondary" style="padding:0.35rem 0.75rem; font-size:0.78rem;" onclick="ClientDocuments.openB3DossierHistoryModal('${esc(c.id)}')">📜 Historial Legal B3</button>` : ''}
                            <button type="button" class="btn-primary" style="padding:0.35rem 0.75rem; font-size:0.78rem;" onclick="ClientsUI.setAccount360Tab('ficha')">✏️ Editar Datos Fiscales</button>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.65rem; font-size:0.82rem;">
                        <div style="padding:0.55rem 0.75rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                            <div style="font-size:0.7rem; color:var(--ds-text-muted, #64748B); font-weight:700; text-transform:uppercase;">Razón Social / Titular</div>
                            <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); margin-top:2px;">${esc(displayName)}</div>
                        </div>
                        <div style="padding:0.55rem 0.75rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                            <div style="font-size:0.7rem; color:var(--ds-text-muted, #64748B); font-weight:700; text-transform:uppercase;">Identificación Fiscal</div>
                            <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); font-family:monospace; margin-top:2px;">NIT: ${esc(c.nit || 'Pendiente')} · ${isNatural ? `DUI: ${esc(c.dui || 'Pendiente')}` : `NRC: ${esc(c.nrc || 'Pendiente')}`}</div>
                        </div>
                        <div style="padding:0.55rem 0.75rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                            <div style="font-size:0.7rem; color:var(--ds-text-muted, #64748B); font-weight:700; text-transform:uppercase;">Representación Legal</div>
                            <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); margin-top:2px;">${esc(isNatural ? 'Titular Persona Natural' : (c.rep_legal || 'Sin RL registrado'))}</div>
                        </div>
                        <div style="padding:0.55rem 0.75rem; border:1px solid var(--ds-border, #CBD5E1); border-radius:6px; background:var(--ds-bg-subtle, #F8FAFC);">
                            <div style="font-size:0.7rem; color:var(--ds-text-muted, #64748B); font-weight:700; text-transform:uppercase;">Condición Tributaria</div>
                            <div style="font-weight:700; color:var(--ds-text-primary, #0F172A); margin-top:2px;">${isGranContrib ? '🏛️ Gran Contribuyente (1%)' : 'Régimen General'} ${isExport ? '· ✈️ Exportación' : ''}</div>
                        </div>
                    </div>
                </div>
                <div id="account-360-legal-dossier-mount"></div>
            `;
        } else if (tab === 'finanzas') {
            const wonOpps = metrics.opportunities.filter(p => p.estado === 'ganado' || (Array.isArray(p.facturas) && p.facturas.length > 0));
            tabBodyHtml = `
                <div class="ds-panel-box">
                    <div class="ds-panel-box-header">
                        <div>
                            <div class="ds-panel-box-title">💰 Estado de Cuenta, Facturación y Cobranza B5</div>
                            <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155); margin-top:2px;">
                                Facturado Histórico: <strong>${_formatUsdB6(metrics.facturacionTotal)}</strong> · Cobrado: <strong style="color:var(--ds-success, #047857);">${_formatUsdB6(metrics.totalCobrado)}</strong> · Saldo CxC: <strong style="color:${metrics.overdueAmount > 0 ? 'var(--ds-danger, #B91C1C)' : 'var(--ds-text-primary, #0F172A)'};">${_formatUsdB6(metrics.saldoPorCobrar)}</strong> · Margen Real Prom.: <strong>${metrics.margenRealPct.toFixed(1)}%</strong>
                            </div>
                        </div>
                        <button type="button" class="btn-secondary" style="padding:0.35rem 0.75rem; font-size:0.78rem;" onclick="if(typeof showView==='function'){showView('projects-view')}">🏗️ Ir a Proyectos y Cobros</button>
                    </div>
                    ${wonOpps.length === 0
                        ? `<div style="padding:1.4rem; text-align:center; color:var(--ds-text-muted, #64748B);">Esta cuenta aún no registra proyectos ganados ni facturas emitidas.</div>`
                        : `<div class="table-responsive">
                            <table style="width:100%; border-collapse:collapse;">
                                <thead>
                                    <tr>
                                        <th>Código / Proyecto</th>
                                        <th>Facturas</th>
                                        <th style="text-align:right;">Pactado / Facturado</th>
                                        <th style="text-align:right;">Cobrado</th>
                                        <th style="text-align:right;">Saldo Pendiente</th>
                                        <th>Estado Cobranza</th>
                                        <th style="text-align:right;">Acción</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${wonOpps.map(p => {
                                        const invs = Array.isArray(p.facturas) ? p.facturas.filter(f => f && String(f.estado || '').toLowerCase() !== 'anulada') : [];
                                        const billed = invs.length > 0
                                            ? invs.reduce((s, f) => s + (Number(f.montoTotal ?? f.monto ?? 0) || 0), 0)
                                            : Number(p.precio_final || p.precio_pactado || p.precio_cotizado || 0);
                                        const paid = invs.length > 0
                                            ? invs.reduce((s, f) => s + (Number(f.montoPagado ?? 0) || 0), 0)
                                            : (p.pago_completado ? billed : 0);
                                        const bal = Math.max(0, Math.round((billed - paid) * 100) / 100);
                                        const invLabels = invs.length > 0
                                            ? invs.map(f => esc(f.numeroFactura || f.correlativo || f.id || 'Fact')).join(', ')
                                            : (p.n_factura ? esc(p.n_factura) : 'Pendiente facturar');
                                        const statusBadge = bal <= 0.01 && billed > 0
                                            ? '<span class="ds-badge ds-badge-success">Pagado</span>'
                                            : (paid > 0 ? '<span class="ds-badge ds-badge-warning">Abono Parcial</span>' : '<span class="ds-badge ds-badge-info">Pendiente</span>');
                                        return `
                                            <tr>
                                                <td>
                                                    <div style="font-weight:700; color:var(--ds-text-primary, #0F172A);">${esc(p.proyecto || '-')}</div>
                                                    <div style="font-size:0.74rem; color:var(--ds-text-muted, #64748B); font-family:monospace;">${esc(p.codigo || p.id)}</div>
                                                </td>
                                                <td style="font-family:monospace; font-size:0.8rem;">${invLabels}</td>
                                                <td style="text-align:right; font-weight:700; font-variant-numeric:tabular-nums;">${_formatUsdB6(billed)}</td>
                                                <td style="text-align:right; color:var(--ds-success, #047857); font-weight:700; font-variant-numeric:tabular-nums;">${_formatUsdB6(paid)}</td>
                                                <td style="text-align:right; font-weight:700; font-variant-numeric:tabular-nums; color:${bal > 0 ? 'var(--ds-danger, #B91C1C)' : 'var(--ds-text-muted, #64748B)'};">${_formatUsdB6(bal)}</td>
                                                <td>${statusBadge}</td>
                                                <td style="text-align:right;">
                                                    <button type="button" class="btn-table-action" onclick="if(typeof openDetail==='function'){openDetail('${esc(p.id)}')}">📂 Ver</button>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                           </div>`}
                </div>
            `;
        }

        const ctxCardEl = document.getElementById('client-detail-context-card');
        if (ctxCardEl && ctxCardEl.style) ctxCardEl.style.display = 'none';

        hubContainer.style.display = 'block';
        hubContainer.innerHTML = `
            <div class="ds-record-header" style="padding:0.75rem 1rem; margin-bottom:0.7rem;">
                <div class="ds-record-header-top" style="margin-bottom:0;">
                    <div>
                        <div class="ds-breadcrumb" style="margin-bottom:0.2rem;">
                            <a href="javascript:void(0)" onclick="closeClientDetailView()" style="color:var(--ds-primary, #0062B8); text-decoration:none; font-weight:700;">← Directorio de Cuentas</a>
                            <span>/</span>
                            <span>Cuenta 360</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                            <h2 class="ds-record-title" style="font-size:1.2rem; margin:0;">${esc(displayName)}</h2>
                            <span class="ds-badge ${isNatural ? 'ds-badge-neutral' : 'ds-badge-primary'}">${isNatural ? '👤 Persona Natural' : '🏢 Persona Jurídica'}</span>
                            ${isGranContrib ? '<span class="ds-badge ds-badge-warning">🏛️ Gran Contribuyente (1%)</span>' : ''}
                            ${isExport ? '<span class="ds-badge ds-badge-info">✈️ Exportación (0%)</span>' : ''}
                            ${legalStatusBadge}
                        </div>
                        <div style="font-size:0.78rem; color:var(--ds-text-secondary, #334155); margin-top:0.25rem;">
                            NIT: <strong style="font-family:monospace;">${esc(c.nit || 'Pendiente')}</strong> ·
                            ${isNatural ? `DUI: <strong style="font-family:monospace;">${esc(c.dui || 'Pendiente')}</strong>` : `NRC: <strong style="font-family:monospace;">${esc(c.nrc || 'Pendiente')}</strong>`} ·
                            📞 ${esc(c.telefono || 'Sin teléfono')} · ✉️ ${esc(c.correo || 'Sin correo')}
                        </div>
                    </div>
                    <div class="ds-record-actions">
                        <button type="button" class="btn-primary" style="padding:0.4rem 0.85rem; font-size:0.8rem;" onclick="ClientsUI.openNewOpportunityFromAccount('${esc(c.id)}')">+ Nueva Oportunidad</button>
                        <button type="button" class="btn-secondary" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="ContactsUI.openAccountContactsModal('${esc(c.id)}')">👥 Contactos</button>
                        ${!isNatural ? `<button type="button" class="btn-secondary" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="ClientDocuments.openB3DossierHistoryModal('${esc(c.id)}')">📜 Historial Legal</button>` : ''}
                        ${isManager && !isAbsorbed ? `<button type="button" class="btn-secondary" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="openAccountMergePanel('${esc(c.id)}')">🔀 Fusionar</button>` : ''}
                    </div>
                </div>
            </div>

            ${kpiStripHtml}

            <div class="ds-tabs-bar" role="tablist" aria-label="Secciones de Cuenta 360">
                <button type="button" class="ds-tab-btn ${tab === 'resumen' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('resumen')">📊 Resumen 360</button>
                <button type="button" class="ds-tab-btn ${tab === 'contactos' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('contactos')">👥 Contactos</button>
                <button type="button" class="ds-tab-btn ${tab === 'oportunidades' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('oportunidades')">💼 Oportunidades (${metrics.totalOpportunitiesCount})</button>
                <button type="button" class="ds-tab-btn ${tab === 'legal' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('legal')">⚖️ Legal y Fiscal</button>
                <button type="button" class="ds-tab-btn ${tab === 'finanzas' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('finanzas')">💰 Finanzas e Historial</button>
                <button type="button" class="ds-tab-btn ${tab === 'ficha' ? 'active' : ''}" onclick="ClientsUI.setAccount360Tab('ficha')">✏️ Editar Datos Fiscales</button>
            </div>

            <div id="account-360-tab-panel-body">
                ${tabBodyHtml}
            </div>
        `;

        const contentEl = document.getElementById('clientDetailContent');
        if (tab === 'ficha') {
            if (contentEl && contentEl.style) contentEl.style.display = 'block';
        } else {
            if (contentEl && contentEl.style) contentEl.style.display = 'none';
            if (tab === 'legal') {
                const mountEl = document.getElementById('account-360-legal-dossier-mount');
                const expEl = document.getElementById('client-expediente-section');
                if (mountEl && expEl && typeof mountEl.appendChild === 'function') {
                    mountEl.appendChild(expEl);
                    if (expEl.style) expEl.style.display = 'block';
                }
            }
        }

        if (tab === 'resumen' || tab === 'contactos') {
            _loadAccount360ContactsAsync(c.id, c);
        }
    }

    const B42_REASON_LABELS = {
        nit: 'mismo NIT',
        nrc: 'mismo NRC',
        dui: 'mismo DUI',
        'nombre-igual': 'mismo nombre',
        'nombre-parecido': 'nombre muy similar',
        'nit-igual-a-dui-de-otro': 'NIT coincide con el DUI de otro cliente',
        telefono: 'mismo teléfono',
        correo: 'mismo correo',
        'same-name': 'mismo nombre',
        'similar-name': 'nombre muy similar'
    };

    function _escB42(str) {
        return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    function clearClientDuplicateFeedback() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const panel = document.getElementById('client-duplicate-feedback-panel');
        if (panel) {
            if (panel.style) panel.style.display = 'none';
            panel.innerHTML = '';
        }
        ['jur-nit', 'jur-nrc', 'nat-nit', 'nat-dui'].forEach(id => setClientFieldError(id, false));
    }

    function dismissDuplicateFeedback() {
        clearClientDuplicateFeedback();
    }

    function renderClientDuplicateFeedback(kind, res, candidateClient) {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const matches = (res && Array.isArray(res.matches)) ? res.matches : [];
        const allReasons = new Set();
        matches.forEach(m => {
            if (m && Array.isArray(m.reasons)) {
                m.reasons.forEach(r => allReasons.add(r));
            }
        });

        if (kind === 'duplicate') {
            const isNat = candidateClient && candidateClient.tipo === 'natural';
            if (allReasons.has('nit')) setClientFieldError(isNat ? 'nat-nit' : 'jur-nit', true);
            if (allReasons.has('nrc')) setClientFieldError('jur-nrc', true);
            if (allReasons.has('dui')) setClientFieldError('nat-dui', true);
        }

        const panel = document.getElementById('client-duplicate-feedback-panel');
        if (!panel) return;

        const matchItemsHtml = matches.map(m => {
            const why = (m.reasons || []).map(r => B42_REASON_LABELS[r] || r).join(', ') || 'coincidencia detectada';
            if (m.inPortfolio === false) {
                return `
                    <div class="b42-match-item b42-match-restricted" style="padding:10px 12px; border-radius:6px; background:rgba(15,23,42,0.65); border:1px solid rgba(148,163,184,0.28); margin-top:8px; font-size:0.84rem; color:#e2e8f0; line-height:1.45;">
                        🔒 <strong>Cuenta registrada fuera de tu cartera comercial</strong> — Coincidencia por <strong>${_escB42(why)}</strong>.<br>
                        <span style="color:#cbd5e1; font-size:0.8rem;">Por políticas de autorización no se exponen datos comerciales, fiscales ni documentales de esta cuenta. <strong>Consulta al gerente comercial</strong> para verificar la cuenta o gestionar su asignación.</span>
                    </div>
                `;
            }
            const typeLabel = m.tipo === 'natural' ? 'Persona Natural' : 'Persona Jurídica';
            const hintHtml = m.hint ? ` · <span style="font-family:monospace; color:#cbd5e1;">${_escB42(m.hint)}</span>` : '';
            const absorbedHtml = m.absorbedFrom ? ` <span class="badge" style="background:rgba(59,130,246,0.18); color:#93c5fd; font-size:0.7rem; margin-left:4px;">Cuenta canónica activa</span>` : '';
            const safeId = _escB42(m.clientId || '');
            const safeName = _escB42(m.nombre || 'Cuenta existente');
            const btnLabel = kind === 'duplicate' ? '📂 Ver / Usar cuenta existente' : '📂 Revisar / Usar cuenta existente';
            return `
                <div class="b42-match-item b42-match-authorized" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding:10px 12px; border-radius:6px; background:rgba(15,23,42,0.75); border:1px solid rgba(255,255,255,0.14); margin-top:8px;">
                    <div style="font-size:0.85rem; line-height:1.4;">
                        <strong style="color:white; font-size:0.92rem;">${safeName}</strong>${absorbedHtml}<br>
                        <span style="color:#94a3b8; font-size:0.8rem;">${typeLabel}${hintHtml} — Coincidencia: <strong style="color:#fde68a;">${_escB42(why)}</strong></span>
                    </div>
                    <div>
                        <button type="button" class="btn-secondary b42-btn-use-existing" data-client-id="${safeId}" style="padding:5px 12px; font-size:0.8rem; color:#38bdf8; border-color:rgba(56,189,248,0.45);" onclick="if(typeof ClientsUI!=='undefined'&&ClientsUI.useExistingAccount){ClientsUI.useExistingAccount('${safeId}','${safeName}')}">${btnLabel}</button>
                    </div>
                </div>
            `;
        }).join('');

        if (kind === 'duplicate') {
            panel.style.cssText = 'display:block; margin-bottom:1rem; padding:14px 16px; border-radius:8px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.5); color:#fecaca;';
            panel.innerHTML = `
                <div style="font-weight:700; font-size:0.95rem; color:#f87171; display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span>🚫</span> Identidad fiscal duplicada — No se puede crear ni guardar esta cuenta
                </div>
                <p style="margin:0 0 8px 0; font-size:0.84rem; color:#fecaca; line-height:1.45;">
                    Ya existe una cuenta registrada con el mismo identificador fiscal (NIT, NRC o DUI). El bloqueo de unicidad fiscal es estricto y no puede omitirse.
                </p>
                ${matchItemsHtml}
            `;
            return;
        }

        if (kind === 'needs-review') {
            panel.style.cssText = 'display:block; margin-bottom:1rem; padding:14px 16px; border-radius:8px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.5); color:#fde68a;';
            panel.innerHTML = `
                <div style="font-weight:700; font-size:0.95rem; color:#fbbf24; display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span>⚠️</span> Posible cuenta duplicada por similitud de nombre
                </div>
                <p style="margin:0 0 8px 0; font-size:0.84rem; color:#fef3c7; line-height:1.45;">
                    Se detectaron cuentas existentes con nombre idéntico o muy similar. Revisa si corresponde a una cuenta ya registrada antes de continuar.
                </p>
                ${matchItemsHtml}
                <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(245,158,11,0.3);">
                    <label for="b42-review-justification-input" style="display:block; font-weight:600; font-size:0.84rem; color:white; margin-bottom:4px;">
                        ¿Realmente se trata de una empresa o persona diferente? Ingresa una justificación breve para continuar: <span style="color:#f87171;">*</span>
                    </label>
                    <input type="text" id="b42-review-justification-input" placeholder="Ej. Empresa distinta del mismo grupo corporativo con NIT diferente / Homónimo verificado..." style="width:100%; padding:8px 10px; border-radius:6px; background:rgba(15,23,42,0.85); color:white; border:1px solid rgba(245,158,11,0.45); font-size:0.85rem;">
                    <div id="b42-review-justification-error" style="display:none; color:#f87171; font-size:0.78rem; margin-top:4px;">
                        Debes ingresar una justificación breve (mínimo 3 caracteres) para confirmar que es una cuenta diferente.
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px; flex-wrap:wrap;">
                        <button type="button" class="btn-secondary" id="btn-b42-cancel-similarity" style="padding:6px 12px; font-size:0.82rem;" onclick="if(typeof ClientsUI!=='undefined'&&ClientsUI.dismissDuplicateFeedback){ClientsUI.dismissDuplicateFeedback()}">Cancelar y revisar</button>
                        <button type="button" class="btn-primary" id="btn-b42-confirm-similarity" style="padding:6px 14px; font-size:0.82rem; font-weight:600;" onclick="if(typeof ClientsUI!=='undefined'&&ClientsUI.confirmSimilarityAndSave){ClientsUI.confirmSimilarityAndSave()}">Continuar — Es una cuenta diferente</button>
                    </div>
                </div>
            `;
        }
    }

    function useExistingAccount(clientId, nombre) {
        if (!clientId) return;
        if (typeof _deps.cancelPendingClientReservation === 'function') {
            _deps.cancelPendingClientReservation();
        }
        clearClientDuplicateFeedback();
        const modalOpen = typeof document !== 'undefined' && document.getElementById('newProspectModal') && document.getElementById('newProspectModal').style && document.getElementById('newProspectModal').style.display === 'block';
        if ((_clientViewOrigin && _clientViewOrigin.fromNewProspect) || modalOpen) {
            _deps.closeModal('clientDetailContent');
            _navigateView('list-view');
            selectClientInSelector(clientId, nombre || getClientName(clientId));
            return;
        }
        openClientDetailView(clientId, _clientViewOrigin ? { originView: _clientViewOrigin.view, prospectId: _clientViewOrigin.prospectId } : {});
    }

    async function confirmSimilarityAndSave() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const inputEl = document.getElementById('b42-review-justification-input');
        const errEl = document.getElementById('b42-review-justification-error');
        const justification = inputEl && typeof inputEl.value === 'string' ? inputEl.value.trim() : '';
        if (justification.length < 3) {
            setClientFieldError('b42-review-justification-input', true);
            if (errEl && errEl.style) errEl.style.display = 'block';
            _deps.alert("Debes ingresar una justificación breve para confirmar que se trata de una cuenta diferente.");
            return;
        }
        setClientFieldError('b42-review-justification-input', false);
        if (errEl && errEl.style) errEl.style.display = 'none';
        return saveClient(null, { confirmReview: true, reviewJustification: justification });
    }

    async function saveClient(e) {
        const saveOptions = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!saveOptions.confirmReview && typeof clearClientDuplicateFeedback === 'function') {
            clearClientDuplicateFeedback();
        }
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

            // The server decides (duplicates by NIT / NRC / DUI, ownership, id). A blocked / cancelled save returns null.
            const saved = await _deps.persistClientViaServer(c, editId, saveOptions);
            if (!saved) return;
            if (typeof clearClientDuplicateFeedback === 'function') {
                clearClientDuplicateFeedback();
            }
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
            if (c && typeof c.fusionada_en === 'string' && c.fusionada_en.trim()) return;
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
            ? `<span class="badge ds-badge ds-badge-primary" style="font-size: 0.72rem;">🏢 Empresa</span>`
            : `<span class="badge ds-badge ds-badge-neutral" style="font-size: 0.72rem;">👤 Persona Natural</span>`;

        const granContribBadge = isGranContribuyente
            ? `<span class="badge ds-badge ds-badge-warning" style="font-size: 0.72rem;">🏛️ Gran Contribuyente (1% IVA)</span>`
            : '';
        const exportBadge = isExport
            ? `<span class="badge ds-badge ds-badge-info" style="font-size: 0.72rem;">✈️ Exportación (0% IVA)</span>`
            : '';

        let contactPersonHtml = '';
        if (contactPerson) {
            contactPersonHtml = `<span class="client-contact-person" title="Contacto comercial">👤 Contacto: <strong>${_deps.escapeHtmlDoc(contactPerson)}</strong></span>`;
        } else {
            contactPersonHtml = `<span class="client-contact-person" style="color:var(--ds-text-muted, var(--text-muted)); font-weight:normal;" title="Sin contacto específico">👤 Sin contacto asignado</span>`;
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

        const safeClientId = p.clientId ? _deps.escapeHtmlDoc(p.clientId) : '';
        const accountLinkBtn = safeClientId
            ? `<button type="button" class="btn-secondary" style="padding:0.35rem 0.7rem; font-size:0.78rem;" onclick="if(typeof openClientDetailView==='function'){openClientDetailView('${safeClientId}',{originView:'detail-view',prospectId:'${_deps.escapeHtmlDoc(p.id || '')}'})}" title="Ir a Cuenta 360">🏢 Cuenta 360</button>`
            : '';

        cardEl.innerHTML = `
            <div class="client-contact-main">
                <div class="client-contact-name-row">
                    <a href="javascript:void(0)" class="client-contact-company ds-account-link" onclick="if(typeof openClientDetailView==='function'&&'${safeClientId}'){openClientDetailView('${safeClientId}',{originView:'detail-view',prospectId:'${_deps.escapeHtmlDoc(p.id || '')}'})}" title="Abrir Cuenta 360">${_deps.escapeHtmlDoc(clientName)}</a>
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
            <div class="client-contact-actions" style="display:flex; gap:0.45rem; align-items:center; flex-wrap:wrap;">
                ${accountLinkBtn}
                ${quickFollowUpBtn}
            </div>
        `;
        cardEl.style.display = 'flex';
    }

    // -------------------------------------------------------------------------
    // 7. Fusión Administrativa Excepcional de Cuentas Duplicadas (Fase 2 B4.3)
    // -------------------------------------------------------------------------
    let _activeMergeState = {
        sourceId: null,
        destinationId: null,
        preview: null
    };

    function _renderMergeFeedbackBox(kind, message) {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const box = document.getElementById('b43-merge-feedback');
        if (!box) return;
        if (!message) {
            if (box.style) box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        const isSuccess = kind === 'success';
        const isWarn = kind === 'warning';
        box.style.cssText = isSuccess
            ? 'display:block; margin-bottom:12px; padding:10px 12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem;'
            : isWarn
            ? 'display:block; margin-bottom:12px; padding:10px 12px; border-radius:6px; background:rgba(245,158,11,0.14); border:1px solid rgba(245,158,11,0.45); color:#fde68a; font-size:0.84rem;'
            : 'display:block; margin-bottom:12px; padding:10px 12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fecaca; font-size:0.84rem;';
        box.innerHTML = _escB42(message);
    }

    function closeAccountMergePanel() {
        _activeMergeState = { sourceId: null, destinationId: null, preview: null };
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const panel = document.getElementById('client-merge-admin-panel');
        if (panel && panel.style) panel.style.display = 'none';
        const previewContainer = document.getElementById('b43-merge-preview-container');
        if (previewContainer) {
            if (previewContainer.style) previewContainer.style.display = 'none';
            previewContainer.innerHTML = '';
        }
        const confirmSection = document.getElementById('b43-merge-confirm-section');
        if (confirmSection && confirmSection.style) confirmSection.style.display = 'none';
        const manualBox = document.getElementById('b43-manual-verification-box');
        if (manualBox && manualBox.style) manualBox.style.display = 'none';
        _renderMergeFeedbackBox(null, '');
    }

    function openAccountMergeFromTable(sourceId) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede fusionar cuentas.');
            return;
        }
        openClientDetailView(sourceId);
        openAccountMergePanel(sourceId);
    }

    function openAccountMergePanel(sourceId) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede acceder a la fusión administrativa de cuentas.');
            return;
        }
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const resolvedSourceId = sourceId || (document.getElementById('client-id-edit') ? document.getElementById('client-id-edit').value : '');
        if (!resolvedSourceId) {
            _deps.alert('Selecciona primero una cuenta existente para iniciar la fusión administrativa.');
            return;
        }
        const clientsList = _deps.getClients() || [];
        const sourceAcc = clientsList.find(c => c && c.id === resolvedSourceId);
        if (!sourceAcc) {
            _deps.alert('No se encontró la cuenta origen seleccionada.');
            return;
        }
        if (typeof sourceAcc.fusionada_en === 'string' && sourceAcc.fusionada_en.trim()) {
            _deps.alert('Esta cuenta ya fue absorbida anteriormente en una cuenta canónica.');
            return;
        }

        _activeMergeState = {
            sourceId: resolvedSourceId,
            destinationId: null,
            preview: null
        };

        const panel = document.getElementById('client-merge-admin-panel');
        if (panel && panel.style) panel.style.display = 'block';

        const sourceSummaryEl = document.getElementById('b43-merge-source-summary');
        if (sourceSummaryEl) {
            const srcName = getClientName(resolvedSourceId);
            const srcType = sourceAcc.tipo === 'natural' ? 'Persona Natural' : 'Persona Jurídica';
            const srcFiscal = sourceAcc.tipo === 'natural'
                ? `DUI: ${sourceAcc.dui || 'Sin DUI'} · NIT: ${sourceAcc.nit || 'Sin NIT'}`
                : `NIT: ${sourceAcc.nit || 'Sin NIT'} · NRC: ${sourceAcc.nrc || 'Sin NRC'}`;
            sourceSummaryEl.innerHTML = `
                <div><strong style="color:#d8b4fe;">Cuenta Origen (será absorbida):</strong> <strong>${_escB42(srcName)}</strong> (<code style="color:#fde68a;">${_escB42(resolvedSourceId)}</code>)</div>
                <div style="font-size:0.79rem; color:#94a3b8; margin-top:2px;">${_escB42(srcType)} · ${_escB42(srcFiscal)}</div>
            `;
        }

        const searchEl = document.getElementById('b43-merge-dest-search');
        if (searchEl) searchEl.value = '';
        const justEl = document.getElementById('b43-merge-justification');
        if (justEl) justEl.value = '';
        const verifyChk = document.getElementById('b43-legal-identity-verified');
        if (verifyChk) verifyChk.checked = false;
        const verifyEvid = document.getElementById('b43-verification-evidence');
        if (verifyEvid) verifyEvid.value = '';
        const explicitChk = document.getElementById('b43-merge-explicit-confirm');
        if (explicitChk) explicitChk.checked = false;

        const previewContainer = document.getElementById('b43-merge-preview-container');
        if (previewContainer) {
            if (previewContainer.style) previewContainer.style.display = 'none';
            previewContainer.innerHTML = '';
        }
        const confirmSection = document.getElementById('b43-merge-confirm-section');
        if (confirmSection && confirmSection.style) confirmSection.style.display = 'none';
        _renderMergeFeedbackBox(null, '');

        filterMergeDestinationSelect();
    }

    function filterMergeDestinationSelect() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const selectEl = document.getElementById('b43-merge-dest-select');
        if (!selectEl) return;
        const searchEl = document.getElementById('b43-merge-dest-search');
        const q = (searchEl && typeof searchEl.value === 'string') ? searchEl.value.toLowerCase().trim() : '';
        const sourceId = _activeMergeState.sourceId || (document.getElementById('client-id-edit') ? document.getElementById('client-id-edit').value : '');
        const clientsList = _deps.getClients() || [];
        const sourceAcc = clientsList.find(c => c && c.id === sourceId);

        const currentVal = selectEl.value || '';
        selectEl.innerHTML = '<option value="">-- Selecciona la cuenta canónica destino --</option>';

        clientsList.forEach(c => {
            if (!c || !c.id || c.id === sourceId) return;
            if (typeof c.fusionada_en === 'string' && c.fusionada_en.trim()) return;
            const name = c.tipo === 'natural' ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.empresa || '');
            const fiscal = c.tipo === 'natural' ? `DUI:${c.dui || '-'} NIT:${c.nit || '-'}` : `NIT:${c.nit || '-'} NRC:${c.nrc || '-'}`;
            const typePrefix = sourceAcc && c.tipo === sourceAcc.tipo ? '✓ ' : '⚠️ ';
            const label = `${typePrefix}${name || c.id} (${c.tipo === 'natural' ? 'Natural' : 'Jurídica'} · ${fiscal}) [${c.id}]`;
            if (q && !label.toLowerCase().includes(q)) return;
            if (typeof Option === 'function') {
                selectEl.add(new Option(label, c.id));
            } else {
                selectEl.innerHTML += `<option value="${_escB42(c.id)}">${_escB42(label)}</option>`;
            }
        });
        if (currentVal) {
            selectEl.value = currentVal;
        }
    }

    function onMergeDestinationChange() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const selectEl = document.getElementById('b43-merge-dest-select');
        _activeMergeState.destinationId = selectEl ? selectEl.value : null;
        _activeMergeState.preview = null;
        const previewContainer = document.getElementById('b43-merge-preview-container');
        if (previewContainer) {
            if (previewContainer.style) previewContainer.style.display = 'none';
            previewContainer.innerHTML = '';
        }
        const confirmSection = document.getElementById('b43-merge-confirm-section');
        if (confirmSection && confirmSection.style) confirmSection.style.display = 'none';
        _renderMergeFeedbackBox(null, '');
    }

    async function loadAccountMergePreview(destOverride) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede previsualizar fusiones de cuentas.');
            return null;
        }
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
        const sourceId = _activeMergeState.sourceId || (document.getElementById('client-id-edit') ? document.getElementById('client-id-edit').value : '');
        const selectEl = document.getElementById('b43-merge-dest-select');
        const destinationId = destOverride || (selectEl ? selectEl.value : '') || _activeMergeState.destinationId;
        if (!sourceId || !destinationId) {
            _renderMergeFeedbackBox('error', 'Selecciona tanto la cuenta origen como la cuenta canónica destino para evaluar la vista previa.');
            return null;
        }
        if (sourceId === destinationId) {
            _renderMergeFeedbackBox('error', 'No se permite fusionar una cuenta consigo misma.');
            return null;
        }
        _renderMergeFeedbackBox(null, '');
        const res = await _deps.previewAccountMerge(sourceId, destinationId);
        if (!res) return null;
        _activeMergeState.sourceId = sourceId;
        _activeMergeState.destinationId = destinationId;
        _activeMergeState.preview = res;
        renderAccountMergePreview(res);
        return res;
    }

    function renderAccountMergePreview(preview) {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || !preview) return;
        const container = document.getElementById('b43-merge-preview-container');
        const confirmSection = document.getElementById('b43-merge-confirm-section');
        const manualBox = document.getElementById('b43-manual-verification-box');
        if (!container) return;

        const src = preview.source || {};
        const dst = preview.destination || {};
        const idCheck = preview.legalIdentity || {};
        const chainInfo = preview.chainImpact || {};
        const warningText = preview.warningMessage || 'Al fusionar estas cuentas, el acceso a los registros históricos quedará gobernado por los permisos de la cuenta canónica.';

        const renderSideCard = (title, tagColor, acc) => {
            const sellers = acc.responsibleSellers || {};
            const sellerList = [
                sellers.createdBy ? `Creador: ${sellers.createdBy}` : null,
                Array.isArray(sellers.visibleTo) && sellers.visibleTo.length ? `Cartera (${sellers.visibleTo.length}): ${sellers.visibleTo.join(', ')}` : null,
                Array.isArray(sellers.closingVendors) && sellers.closingVendors.length ? `Cierres (${sellers.closingVendors.length}): ${sellers.closingVendors.join(', ')}` : null
            ].filter(Boolean).join(' · ') || 'Sin vendedores asignados';
            const billing = acc.billingSummary || {};
            const billingText = billing.hasBillingHistory
                ? `Sí (${billing.invoicesCount || 0} factura(s), ${billing.paymentsCount || 0} pago(s))`
                : 'Sin facturas ni pagos registrados';
            const prevAbsorbed = Array.isArray(acc.previouslyAbsorbedIds) && acc.previouslyAbsorbedIds.length
                ? acc.previouslyAbsorbedIds.join(', ')
                : 'Ninguna';
            return `
                <div style="padding:12px; border-radius:8px; background:rgba(15,23,42,0.85); border:1px solid ${tagColor}; font-size:0.82rem; color:#e2e8f0; line-height:1.45;">
                    <div style="font-weight:700; color:white; font-size:0.9rem; margin-bottom:6px;">${_escB42(title)}</div>
                    <div><strong>Razón Social / Nombre:</strong> ${_escB42(acc.displayName || acc.id || '-')} (<code style="color:#fde68a;">${_escB42(acc.id || '-')}</code>)</div>
                    <div><strong>Tipo de Entidad:</strong> ${_escB42(acc.tipo === 'natural' ? 'Persona Natural' : 'Persona Jurídica')}</div>
                    <div><strong>NIT:</strong> ${_escB42(acc.nit || 'No registrado')} · <strong>NRC:</strong> ${_escB42(acc.nrc || 'No registrado')}${acc.tipo === 'natural' ? ` · <strong>DUI:</strong> ${_escB42(acc.dui || 'No registrado')}` : ''}</div>
                    <div><strong>Vendedores responsables:</strong> ${_escB42(sellerList)}</div>
                    <div><strong>Contactos asociados:</strong> ${_escB42(String(acc.contactsCount || 0))}</div>
                    <div><strong>Oportunidades:</strong> ${_escB42(String(acc.opportunitiesCount || 0))}</div>
                    <div><strong>Documentos legales/fiscales:</strong> ${_escB42(String(acc.documentsCount || 0))}</div>
                    <div><strong>Facturas / Pagos históricos:</strong> ${_escB42(billingText)}</div>
                    <div><strong>Cuentas absorbidas previamente:</strong> ${_escB42(prevAbsorbed)}</div>
                </div>
            `;
        };

        const identityBannerHtml = !idCheck.allowed
            ? `<div style="padding:10px 12px; border-radius:6px; background:rgba(239,68,68,0.16); border:1px solid rgba(239,68,68,0.5); color:#fecaca; font-size:0.84rem; margin-top:10px;">
                🚫 <strong>Fusión bloqueada por validación de identidad jurídica:</strong> ${_escB42(idCheck.message || 'Las cuentas no cumplen los requisitos de identidad jurídica.')}
               </div>`
            : idCheck.requiresManualVerification
            ? `<div style="padding:10px 12px; border-radius:6px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.5); color:#fde68a; font-size:0.84rem; margin-top:10px;">
                ⚠️ <strong>Identificadores fiscales incompletos — Requiere verificación gerencial documentada:</strong> ${_escB42(idCheck.message || 'Confirma y documenta la evidencia legal antes de fusionar.')}
               </div>`
            : `<div style="padding:10px 12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem; margin-top:10px;">
                ✅ <strong>Coincidencia fiscal verificada:</strong> ${_escB42(idCheck.message || 'Identificadores fiscales compatibles para fusión administrativa.')}
               </div>`;

        container.style.display = 'block';
        container.innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">
                ${renderSideCard('📥 Cuenta Origen (Se Absorberá)', 'rgba(248,113,113,0.45)', src)}
                ${renderSideCard('🏛️ Cuenta Destino Canónica (Permanece Activa)', 'rgba(52,211,153,0.45)', dst)}
            </div>
            ${identityBannerHtml}
            <div class="b43-permission-warning-banner" style="margin-top:10px; padding:10px 12px; border-radius:6px; background:rgba(59,130,246,0.14); border:1px solid rgba(59,130,246,0.45); color:#bfdbfe; font-size:0.83rem;">
                🔐 <strong>Advertencia de Gobernanza B4.1:</strong> ${_escB42(warningText)}
                <span style="display:block; font-size:0.78rem; color:#93c5fd; margin-top:3px;">
                    Profundidad máxima de cadena tras la fusión: ${_escB42(String(chainInfo.resultingMaxDepth || 1))} / 5 · Ningún contacto, oportunidad, factura, pago ni documento en Storage será eliminado ni sobrescrito.
                </span>
            </div>
        `;

        if (confirmSection && confirmSection.style) {
            confirmSection.style.display = preview.canProceed ? 'block' : 'none';
        }
        if (manualBox && manualBox.style) {
            manualBox.style.display = (preview.canProceed && idCheck.requiresManualVerification) ? 'block' : 'none';
        }
    }

    async function confirmAndExecuteAccountMerge() {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede ejecutar fusiones administrativas de cuentas.');
            return null;
        }
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;

        const preview = _activeMergeState.preview;
        if (!preview || !preview.canProceed) {
            _renderMergeFeedbackBox('error', 'Debes evaluar primero una vista previa válida antes de confirmar la fusión.');
            return null;
        }

        const justEl = document.getElementById('b43-merge-justification');
        const justification = (justEl && typeof justEl.value === 'string') ? justEl.value.trim() : '';
        if (justification.length < 5) {
            _renderMergeFeedbackBox('error', 'Ingresa una justificación administrativa obligatoria (mínimo 5 caracteres).');
            return null;
        }

        const explicitChk = document.getElementById('b43-merge-explicit-confirm');
        if (!explicitChk || !explicitChk.checked) {
            _renderMergeFeedbackBox('error', 'Debes marcar la casilla de confirmación expresa de identidad jurídica y gobernanza de permisos B4.1.');
            return null;
        }

        const requiresManual = Boolean(preview.legalIdentity && preview.legalIdentity.requiresManualVerification);
        const verifyChk = document.getElementById('b43-legal-identity-verified');
        const verifyEvidEl = document.getElementById('b43-verification-evidence');
        const legalIdentityVerified = verifyChk ? Boolean(verifyChk.checked) : false;
        const verificationEvidence = (verifyEvidEl && typeof verifyEvidEl.value === 'string') ? verifyEvidEl.value.trim() : '';

        if (requiresManual) {
            if (!legalIdentityVerified) {
                _renderMergeFeedbackBox('error', 'Cuando una cuenta carece de NIT/NRC/DUI coincidente exacto, debes confirmar expresamente la verificación gerencial de identidad jurídica.');
                return null;
            }
            if (verificationEvidence.length < 10) {
                _renderMergeFeedbackBox('error', 'Debes describir la evidencia documental verificada (mínimo 10 caracteres).');
                return null;
            }
        }

        _renderMergeFeedbackBox(null, '');
        const destinationId = _activeMergeState.destinationId;
        const sourceId = _activeMergeState.sourceId;

        const res = await _deps.executeAccountMerge({
            sourceId,
            destinationId,
            justification,
            legalIdentityVerified: requiresManual ? legalIdentityVerified : true,
            verificationEvidence,
            expectedStateHash: preview.stateHash
        });

        if (!res) return null;

        closeAccountMergePanel();
        _deps.alert(`✅ Cuenta ${sourceId} fusionada exitosamente en la cuenta canónica ${destinationId}.`);
        renderClientsTable();
        renderClientSelect();
        openClientDetailView(destinationId);
        return res;
    }

    function navigateToCanonicalAccount(canonicalId) {
        if (!canonicalId) return;
        openClientDetailView(canonicalId, _clientViewOrigin ? { originView: _clientViewOrigin.view, prospectId: _clientViewOrigin.prospectId } : {});
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
        clearClientDuplicateFeedback,
        dismissDuplicateFeedback,
        renderClientDuplicateFeedback,
        useExistingAccount,
        confirmSimilarityAndSave,
        saveClient,
        renderClientSelect,
        selectClientInSelector,
        getClientName,
        getProspectClient,
        renderClientContactCard,
        openAccountMergeFromTable,
        openAccountMergePanel,
        closeAccountMergePanel,
        filterMergeDestinationSelect,
        onMergeDestinationChange,
        loadAccountMergePreview,
        renderAccountMergePreview,
        confirmAndExecuteAccountMerge,
        navigateToCanonicalAccount,
        renderAccount360Hub,
        setAccount360Tab,
        openNewOpportunityFromAccount,
        _deps
    };

    return ClientsUI;
});
