// ============================================================================
// DUCTSAL ERP — CLIENTS MODULE: CONTROLLER (Fase 6.2)
// Archivo: modules/clients/clients_controller.js
// Responsabilidad:
// 1. Gestión del ciclo de vida y estado de clientes en memoria.
// 2. Persistencia autorizada vía Cloud Functions (creación atómica en 3 pasos y edición con 3-way merge).
// 3. Manejo de reservas de identificadores (NIT/DUI) y cancelación de reservas pendientes.
// 4. Búsqueda remota en catálogo de clientes para el selector de oportunidades.
// 5. Filtrado de cartera visible según rol y atribución comercial (getVisibleClients).
// 6. Eliminación protegida de clientes (exclusiva de manager, sin proyectos asociados).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.ClientsController = api;
        // Compatibilidad global con window
        if (typeof window !== 'undefined') {
            window.ClientsController = api;
            window.getVisibleClients = api.getVisibleClients;
            window.persistClientViaServer = api.persistClientViaServer;
            window.cancelPendingClientReservation = api.cancelPendingClientReservation;
            window.catalogueSearchActive = api.catalogueSearchActive;
            window.getSelectorClientsLocal = api.getSelectorClientsLocal;
            window.onClientCatalogSearchInput = api.onClientCatalogSearchInput;
            window.runClientCatalogSearch = api.runClientCatalogSearch;
            window.deleteClient = api.deleteClient;
            window.previewAccountMerge = api.previewAccountMerge;
            window.executeAccountMerge = api.executeAccountMerge;
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
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
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
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        getStoragePrefix: () => (typeof STORAGE_PREFIX !== 'undefined' ? STORAGE_PREFIX : (typeof window !== 'undefined' && window.STORAGE_PREFIX ? window.STORAGE_PREFIX : 'prod_files')),
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : (typeof window !== 'undefined' && window.firebase ? window.firebase : null)),
        getFirestore: () => (typeof db !== 'undefined' ? db : (typeof window !== 'undefined' && window.db ? window.db : null)),
        getCrmClients: () => (typeof CrmClients !== 'undefined' ? CrmClients : (typeof window !== 'undefined' && window.CrmClients ? window.CrmClients : null)),
        getCrmCommercial: () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : (typeof window !== 'undefined' && window.CrmCommercial ? window.CrmCommercial : null)),
        hasStagedClientFiles: (type) => {
            if (typeof window !== 'undefined' && typeof window.hasStagedClientFiles === 'function') return window.hasStagedClientFiles(type);
            return false;
        },
        uploadClientStagedFiles: async (targetId, type, existingDocs) => {
            if (typeof window !== 'undefined' && typeof window.uploadClientStagedFiles === 'function') {
                return window.uploadClientStagedFiles(targetId, type, existingDocs);
            }
            return existingDocs;
        },
        selectClientInSelector: (id, label) => {
            if (typeof window !== 'undefined' && typeof window.selectClientInSelector === 'function') {
                return window.selectClientInSelector(id, label);
            }
        },
        closeModal: (id) => {
            if (typeof closeModal === 'function') return closeModal(id);
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(id);
        },
        renderClientsTable: () => {
            if (typeof renderClientsTable === 'function') return renderClientsTable();
            if (typeof window !== 'undefined' && typeof window.renderClientsTable === 'function') return window.renderClientsTable();
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
            return renderInlineControllerNotice(msg);
        },
        confirm: () => {
            return true;
        }
    };

    function renderInlineControllerNotice(msg) {
        const text = String(msg || '');
        const isSuccess = /exitosamente|✅|guardad|registrad|confirmad|actualizad/i.test(text) && !/error|no se|denegado|inválid|falta|requiere/i.test(text);
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
     * Inicializa o actualiza dependencias del controlador de clientes.
     */
    function initClientsController(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const k of Object.keys(customDeps)) {
                if (typeof customDeps[k] === 'function') {
                    _deps[k] = customDeps[k];
                } else {
                    _deps[k] = () => customDeps[k];
                }
            }
        }
        return ClientsController;
    }

    // -------------------------------------------------------------------------
    // 2. Visibilidad y Cartera
    // -------------------------------------------------------------------------
    // Clients visible to the current user (list and selector). A vendedor sees the clients they created plus the
    // clients referenced (clientId) by opportunities they created or that are assigned to them: the same criterion
    // renderList uses for opportunities, so an assigned opportunity never points at a client the vendedor cannot see.
    // Gerente, gestor and any other role keep seeing every client. Read-only: no stored data is modified.
    function getVisibleClients() {
        const currentUser = _deps.getCurrentUser();
        const clientsList = _deps.getClients();
        if (!currentUser || currentUser.role !== 'vendedor') return clientsList;
        const related = new Set();
        const prospectsList = _deps.getProspects();
        prospectsList.forEach(p => {
            const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);
            if (isAssigned && p.eliminado !== true && p.clientId) {
                related.add(p.clientId);
            }
        });
        const byId = Object.create(null);
        clientsList.forEach(c => {
            if (c && c.id) byId[c.id] = c;
        });
        const resolveCanonical = (account) => {
            let cur = account;
            let depth = 0;
            const visited = new Set();
            while (cur && typeof cur.fusionada_en === 'string' && cur.fusionada_en.trim() && depth < 5) {
                const nextId = cur.fusionada_en.trim();
                if (visited.has(nextId)) break;
                visited.add(nextId);
                const next = byId[nextId];
                if (!next) break;
                cur = next;
                depth += 1;
            }
            return cur || account;
        };
        const isAuthorizedAccount = (acc) => Boolean(
            acc && (
                acc.createdBy === currentUser.id ||
                related.has(acc.id) ||
                (Array.isArray(acc.visibleTo) && acc.visibleTo.includes(currentUser.id))
            )
        );
        return clientsList.filter(c => {
            const target = (c && typeof c.fusionada_en === 'string' && c.fusionada_en.trim())
                ? resolveCanonical(c)
                : c;
            return isAuthorizedAccount(target);
        });
    }

    // -------------------------------------------------------------------------
    // 3. Gestión de Reservas de Clientes
    // -------------------------------------------------------------------------
    let currentClientReservationId = null;

    function getPendingClientReservationId() {
        return currentClientReservationId;
    }

    function setPendingClientReservationId(id) {
        currentClientReservationId = id;
    }

    async function cancelPendingClientReservation() {
        if (!currentClientReservationId) return;
        const resId = currentClientReservationId;
        currentClientReservationId = null;
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        if (fb && CrmClients && typeof CrmClients.cancelReservation === 'function') {
            try {
                await CrmClients.cancelReservation(fb, { reservationId: resId, dbSuffix: _deps.getDbSuffix() });
            } catch (e) {
                console.warn('No se pudo cancelar la reserva pendiente:', e);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Catálogo Remoto y Selector
    // -------------------------------------------------------------------------
    // Selector of NEW opportunities. Deliberately NOT getVisibleClients(): that is the portfolio shown in the Clients
    // section. A vendedor with a Firebase session searches the WHOLE catalogue on the server (searchClientsCatalog: id,
    // name and a masked document hint only); picking a client never creates or modifies it. Gerente / gestor keep the
    // complete local list. A vendedor on the historical login has no server session, so the portfolio is the best available.
    function catalogueSearchActive() {
        const currentUser = _deps.getCurrentUser();
        const CrmClients = _deps.getCrmClients();
        const fb = _deps.getFirebase();
        return !!(currentUser && currentUser.role === 'vendedor' && CrmClients && typeof CrmClients.hasSessionSync === 'function' && CrmClients.hasSessionSync(fb));
    }

    function getSelectorClientsLocal() {
        const currentUser = _deps.getCurrentUser();
        const base = (currentUser && currentUser.role === 'vendedor') ? getVisibleClients() : _deps.getClients();
        return Array.isArray(base)
            ? base.filter(c => !(c && typeof c.fusionada_en === 'string' && c.fusionada_en.trim()))
            : [];
    }

    let catalogueSearchTimer = null;
    let catalogueSearchSeq = 0;

    function onClientCatalogSearchInput() {
        if (typeof clearTimeout === 'function') clearTimeout(catalogueSearchTimer);
        if (typeof setTimeout === 'function') {
            catalogueSearchTimer = setTimeout(runClientCatalogSearch, 300);
        } else {
            runClientCatalogSearch();
        }
    }

    async function runClientCatalogSearch() {
        if (typeof document === 'undefined') return;
        const search = document.getElementById('new-cliente-search');
        const hint = document.getElementById('new-cliente-search-hint');
        const select = document.getElementById('new-cliente-select');
        if (!search || !hint || !select) return;
        const seq = ++catalogueSearchSeq;
        const q = search.value.trim();
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        if (!CrmClients || typeof CrmClients.searchCatalog !== 'function') return;

        try {
            const res = await CrmClients.searchCatalog(fb, { q, dbSuffix: _deps.getDbSuffix() });
            if (seq !== catalogueSearchSeq) return; // a newer search is in flight
            const keep = select.value ? { id: select.value, label: select.options[select.selectedIndex].text } : null;
            select.innerHTML = '<option value="">-- Selecciona Cliente --</option>';
            if (keep && typeof Option === 'function') select.add(new Option(keep.label, keep.id));
            (res.results || []).forEach(r => {
                if ((!keep || keep.id !== r.id) && typeof Option === 'function') {
                    select.add(new Option(CrmClients.catalogOptionLabel(r), r.id));
                }
            });
            if (keep) select.value = keep.id;
            hint.textContent = res.tooShort ? 'Escribe al menos 2 letras o 4 dígitos para buscar.'
                : (res.results || []).length === 0 ? 'Sin resultados. Si el cliente no existe, usa "+ Nuevo".'
                : `${res.results.length} resultado(s)${res.truncated ? ' (hay más: afina la búsqueda)' : ''}. ★ = ya está en tu cartera.`;
        } catch (err) {
            if (seq === catalogueSearchSeq) hint.textContent = CrmClients.errorMessage(err);
        }
    }

    // -------------------------------------------------------------------------
    // 5. Persistencia Autorizada vía Cloud Functions
    // -------------------------------------------------------------------------
    // Creates / edits a client through Cloud Functions with server reservation and hierarchical storage.
    // Returns the saved client, or null when nothing was saved (duplicate, review declined, error, no session).
    async function persistClientViaServer(c, editId) {
        const options = arguments[2] && typeof arguments[2] === 'object' ? arguments[2] : {};
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        const crmClients = CrmClients;
        if (!CrmClients || typeof CrmClients.hasSessionSync !== 'function' || !CrmClients.hasSessionSync(fb)) {
            _deps.hideLoading();
            _deps.alert(CrmClients && CrmClients.NO_SESSION_MESSAGE ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
            return null;
        }
        let confirmReview = Boolean(options.confirmReview);
        let reviewJustification = typeof options.reviewJustification === 'string' && options.reviewJustification.trim()
            ? options.reviewJustification.trim()
            : undefined;
        const dbSuffix = _deps.getDbSuffix();

        const isContextualDuplicatePanelActive = () => {
            if (typeof _deps.renderDuplicateFeedback === 'function') return true;
            if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
                const panel = document.getElementById('client-duplicate-feedback-panel');
                if (panel && ((panel.dataset && panel.dataset.b42Contextual === 'true') || (typeof panel.getAttribute === 'function' && panel.getAttribute('data-b42-contextual') === 'true'))) {
                    return true;
                }
            }
            return false;
        };

        const notifyDuplicateFeedback = (kind, resObj) => {
            if (typeof _deps.renderDuplicateFeedback === 'function') {
                _deps.renderDuplicateFeedback(kind, resObj, c, editId);
            } else if (typeof renderClientDuplicateFeedback === 'function') {
                renderClientDuplicateFeedback(kind, resObj, c, editId);
            } else if (typeof window !== 'undefined' && window.ClientsUI && typeof window.ClientsUI.renderClientDuplicateFeedback === 'function') {
                window.ClientsUI.renderClientDuplicateFeedback(kind, resObj, c, editId);
            }
        };

        // A) EDIT EXISTING CLIENT
        if (editId) {
            const filesStaged = _deps.hasStagedClientFiles(c.tipo);
            if (filesStaged) {
                _deps.showLoading('Subiendo documentos del cliente...');
                try {
                    const activeBaseDocs = (typeof window !== 'undefined' && window._activeClientBaseDocs !== undefined && window._activeClientBaseDocs !== null)
                        ? window._activeClientBaseDocs
                        : null;
                    c.baseDocumentos = (activeBaseDocs !== null)
                        ? JSON.parse(JSON.stringify(activeBaseDocs))
                        : (c.documentos ? JSON.parse(JSON.stringify(c.documentos)) : {});
                    c.documentos = await _deps.uploadClientStagedFiles(editId, c.tipo, c.documentos);
                } catch (uploadErr) {
                    _deps.hideLoading();
                    _deps.alert("Error al subir documentos: " + uploadErr.message);
                    return null;
                }
            } else {
                // General data update: do NOT send documentos so live Firestore documents remain untouched
                delete c.documentos;
                delete c.baseDocumentos;
            }

            _deps.showLoading('Guardando cambios en cliente...');
            for (let attempt = 0; attempt < 2; attempt++) {
                let res;
                try {
                    res = await crmClients.updateClient(fb, { id: editId, client: c, dbSuffix, confirmReview, reviewJustification });
                } catch (err) {
                    _deps.hideLoading();
                    _deps.alert(crmClients.errorMessage(err));
                    return null;
                }
                if (res.status === 'duplicate') {
                    _deps.hideLoading();
                    notifyDuplicateFeedback('duplicate', res);
                    _deps.alert(crmClients.duplicateMessage(res));
                    return null;
                }
                if (res.status === 'needs-review') {
                    _deps.hideLoading();
                    notifyDuplicateFeedback('needs-review', res);
                    if (isContextualDuplicatePanelActive()) {
                        _deps.alert(crmClients.reviewMessage(res));
                        return null;
                    }
                    if (!_deps.confirm(crmClients.reviewMessage(res))) return null;
                    _deps.showLoading('Guardando cliente...');
                    confirmReview = true;
                    continue;
                }
                const mergedClient = Object.assign({}, c, res.client || {});
                if (typeof window !== 'undefined') {
                    window._activeClientBaseDocs = (mergedClient.documentos && typeof mergedClient.documentos === 'object')
                        ? JSON.parse(JSON.stringify(mergedClient.documentos))
                        : null;
                }
                return mergedClient;
            }
            return null;
        }

        // B) CREATE NEW CLIENT (RESERVATION -> UPLOAD -> FINALIZE)
        let reservationId = null;
        _deps.showLoading('Validando y reservando registro de cliente...');

        for (let attempt = 0; attempt < 2; attempt++) {
            let res;
            try {
                res = await crmClients.reserveCreation(fb, { client: c, dbSuffix, confirmReview, reviewJustification });
            } catch (err) {
                _deps.hideLoading();
                _deps.alert(crmClients.errorMessage(err));
                return null;
            }

            if (res.status === 'duplicate') {
                _deps.hideLoading();
                notifyDuplicateFeedback('duplicate', res);
                _deps.alert(crmClients.duplicateMessage(res));
                const modalOpen = typeof document !== 'undefined' && document.getElementById('newProspectModal') && document.getElementById('newProspectModal').style.display === 'block';
                if (!isContextualDuplicatePanelActive() && modalOpen && res.matches && res.matches.length === 1 && res.matches[0].inPortfolio !== false) {
                    _deps.closeModal('clientDetailContent');
                    _deps.selectClientInSelector(res.matches[0].clientId, res.matches[0].nombre);
                }
                return null;
            }

            if (res.status === 'needs-review') {
                _deps.hideLoading();
                notifyDuplicateFeedback('needs-review', res);
                if (isContextualDuplicatePanelActive()) {
                    _deps.alert(crmClients.reviewMessage(res));
                    return null;
                }
                if (!_deps.confirm(crmClients.reviewMessage(res))) return null;
                _deps.showLoading('Confirmando revisión de cliente...');
                confirmReview = true;
                continue;
            }

            if (res.status === 'reserved' && res.reservationId) {
                reservationId = res.reservationId;
                currentClientReservationId = reservationId;
                break;
            }

            _deps.hideLoading();
            _deps.alert('Respuesta inesperada al reservar cliente: ' + (res.status || 'error'));
            return null;
        }

        if (!reservationId) return null;

        // STEP 2: Upload staged files with active server reservation
        try {
            c.documentos = await _deps.uploadClientStagedFiles(reservationId, c.tipo, c.documentos);
        } catch (uploadErr) {
            _deps.hideLoading();
            console.error('Error al subir documentos de la reserva:', uploadErr);
            if (_deps.confirm(`Error al subir documentos: ${uploadErr.message}. ¿Deseas cancelar la reserva para intentar de nuevo?`)) {
                await cancelPendingClientReservation();
            }
            return null;
        }

        // STEP 3: Finalize Client Creation
        _deps.showLoading('Formalizando creación del cliente...');
        let finRes;
        try {
            finRes = await crmClients.finalizeCreation(fb, { reservationId, client: c, dbSuffix, confirmReview, reviewJustification });
        } catch (finErr) {
            _deps.hideLoading();
            _deps.alert(crmClients.errorMessage(finErr));
            return null;
        }

        if (finRes.status === 'duplicate') {
            _deps.hideLoading();
            notifyDuplicateFeedback('duplicate', finRes);
            _deps.alert(crmClients.duplicateMessage(finRes));
            return null;
        }
        if (finRes.status !== 'created' && finRes.status !== 'ok') {
            _deps.hideLoading();
            _deps.alert('No se pudo formalizar el cliente: ' + (finRes.status || 'error desconocido'));
            return null;
        }

        currentClientReservationId = null; // Successfully finalized!
        return Object.assign({}, c, finRes.client || { id: reservationId });
    }

    // -------------------------------------------------------------------------
    // 6. Eliminación de Cliente
    // -------------------------------------------------------------------------
    function deleteClient(id) {
        const skipInlineConfirm = arguments[1] === true;
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') return _deps.alert("Permiso denegado.");
        const clientsList = _deps.getClients();
        const c = clientsList.find(x => x.id === id);
        if (!c) return;

        const prospectsList = _deps.getProspects();
        const hasProjects = prospectsList.some(p => p.clientId === id);
        if (hasProjects) {
            return _deps.alert("⚠️ No puedes eliminar este cliente porque tiene proyectos asociados. Debes eliminar primero todos sus proyectos.");
        }

        const displayName = String(c.nombres || c.empresa || id).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        const safeId = String(id).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        const clientsView = (typeof document !== 'undefined') ? document.getElementById('clients-view') : null;
        if (!skipInlineConfirm && clientsView && typeof clientsView.insertBefore === 'function' && typeof document.createElement === 'function') {
            let confirmBox = document.getElementById('b3-inline-delete-client-confirm');
            if (!confirmBox) {
                confirmBox = document.createElement('div');
                confirmBox.id = 'b3-inline-delete-client-confirm';
                clientsView.insertBefore(confirmBox, clientsView.firstChild);
            }
            confirmBox.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; font-size:0.85rem;';
            confirmBox.innerHTML = `
                <span>⚠️ ¿Confirmar eliminación permanente del cliente <strong>${displayName}</strong>? Esta acción no se puede deshacer.</span>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="btn-danger" style="padding:4px 10px; font-size:0.78rem;" onclick="const el=document.getElementById('b3-inline-delete-client-confirm'); if(el) el.remove(); deleteClient('${safeId}', true)">Confirmar eliminación</button>
                    <button type="button" class="btn-secondary" style="padding:4px 10px; font-size:0.78rem;" onclick="const el=document.getElementById('b3-inline-delete-client-confirm'); if(el) el.remove();">Cancelar</button>
                </div>
            `;
            return;
        }

        if (!skipInlineConfirm && !_deps.confirm(`¿Estás SEGURO de que deseas eliminar permanentemente el cliente "${c.nombres || c.empresa || id}"?\n\nEsta acción NO se puede deshacer.`)) return;
        const fb = _deps.getFirebase();
        const CrmCommercial = _deps.getCrmCommercial();
        if (!CrmCommercial || typeof CrmCommercial.hasSessionSync !== 'function' || !CrmCommercial.hasSessionSync(fb)) {
            return _deps.alert(CrmCommercial && CrmCommercial.NO_SESSION_MESSAGE ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        }

        // deleteClientAdmin re-checks the manager role live, refuses clients with projects, frees the identifiers and writes the audit.
        CrmCommercial.deleteClient(fb, { clientId: id, dbSuffix: _deps.getDbSuffix() })
            .then(() => _deps.alert("Cliente eliminado exitosamente."))
            .catch(err => _deps.alert(CrmCommercial.errorMessage(err)));
    }

    // -------------------------------------------------------------------------
    // 7. Fusión Administrativa Excepcional de Cuentas Duplicadas (Fase 2 B4.3)
    // -------------------------------------------------------------------------
    async function previewAccountMerge(sourceId, destinationId) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede previsualizar o ejecutar la fusión administrativa de cuentas.');
            return null;
        }
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        if (!CrmClients || typeof CrmClients.hasSessionSync !== 'function' || !CrmClients.hasSessionSync(fb)) {
            _deps.alert(CrmClients && CrmClients.NO_SESSION_MESSAGE ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
            return null;
        }
        _deps.showLoading('Generando vista previa comparativa de fusión...');
        try {
            const res = await CrmClients.previewMergeAccounts(fb, {
                sourceId,
                destinationId,
                dbSuffix: _deps.getDbSuffix()
            });
            return res;
        } catch (err) {
            _deps.alert(CrmClients.errorMessage ? CrmClients.errorMessage(err) : (err.message || 'Error al generar vista previa de fusión.'));
            return null;
        } finally {
            _deps.hideLoading();
        }
    }

    async function executeAccountMerge(payload = {}) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            _deps.alert('Permiso denegado: solo el gerente puede ejecutar la fusión administrativa de cuentas.');
            return null;
        }
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        if (!CrmClients || typeof CrmClients.hasSessionSync !== 'function' || !CrmClients.hasSessionSync(fb)) {
            _deps.alert(CrmClients && CrmClients.NO_SESSION_MESSAGE ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
            return null;
        }
        _deps.showLoading('Ejecutando fusión administrativa de cuentas...');
        try {
            const res = await CrmClients.mergeAccounts(fb, {
                sourceId: payload.sourceId,
                destinationId: payload.destinationId,
                justification: payload.justification,
                legalIdentityVerified: Boolean(payload.legalIdentityVerified),
                verificationEvidence: payload.verificationEvidence,
                expectedStateHash: payload.expectedStateHash,
                dbSuffix: _deps.getDbSuffix()
            });
            if (res && (res.status === 'merged' || res.status === 'already-merged')) {
                const updatedList = [...(_deps.getClients() || [])];
                const idx = updatedList.findIndex(x => x && x.id === payload.sourceId);
                if (idx > -1) {
                    updatedList[idx] = Object.assign({}, updatedList[idx], {
                        fusionada_en: payload.destinationId,
                        fusionada_at: res.mergedAt || new Date().toISOString(),
                        fusionada_por: currentUser.id,
                        fusionada_motivo: payload.justification || '',
                        estado_cuenta: 'fusionada'
                    });
                    _deps.setClients(updatedList);
                }
            }
            return res;
        } catch (err) {
            _deps.alert(CrmClients.errorMessage ? CrmClients.errorMessage(err) : (err.message || 'Error al fusionar cuentas.'));
            return null;
        } finally {
            _deps.hideLoading();
        }
    }

    const ClientsController = {
        init: initClientsController,
        initClientsController,
        getVisibleClients,
        getPendingClientReservationId,
        setPendingClientReservationId,
        cancelPendingClientReservation,
        catalogueSearchActive,
        getSelectorClientsLocal,
        onClientCatalogSearchInput,
        runClientCatalogSearch,
        persistClientViaServer,
        deleteClient,
        previewAccountMerge,
        executeAccountMerge,
        _deps
    };

    return ClientsController;
});
