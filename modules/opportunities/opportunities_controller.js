// ============================================================================
// DUCTSAL ERP — OPPORTUNITIES MODULE: CONTROLLER (Fase 6.3.1 - Bloque 1)
// Archivo: modules/opportunities/opportunities_controller.js
// Responsabilidades:
// 1. Estado y gestión de oportunidades y prospectos en memoria.
// 2. Filtrado multidimensional (estado comercial, clasificación técnica, etapa, búsqueda, rango de fechas).
// 3. Ordenamiento determinista con desempate por código/id.
// 4. Atribución comercial, resolución de responsables y reasignación de vendedores.
// 5. Visibilidad y matriz de permisos por rol (gerente, gestor, vendedor).
// 6. Eliminación lógica protegida (deleteProspectAdmin) y reactivación de pérdidas (reactivateLostProspectAdmin).
// 7. Acceso a datos mediante dependencias inyectadas con fallbacks seguros.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.OpportunitiesController = api;
        // Compatibilidad global con window y handlers existentes
        if (typeof window !== 'undefined') {
            window.OpportunitiesController = api;
            window.parseProspectDate = api.parseProspectDate;
            window.formatProspectDate = api.formatProspectDate;
            window.clearOppDateFilter = api.clearOppDateFilter;
            window.toggleOppSort = api.toggleOppSort;
            window.getOppSortCol = api.getOppSortCol;
            window.getOppSortDir = api.getOppSortDir;
            window.updateOppSortIcons = api.updateOppSortIcons;
            window.getOppStatusFilter = api.getOppStatusFilter;
            window.getOppClasifFilter = api.getOppClasifFilter;
            window.getOppStageFilter = api.getOppStageFilter;
            window.setOppStatusFilter = api.setOppStatusFilter;
            window.setOppClasifFilter = api.setOppClasifFilter;
            window.setOppStageFilter = api.setOppStageFilter;
            window.getProspectVendorInfo = api.getProspectVendorInfo;
            window.reassignVendor = api.reassignVendor;
            window.processConfirmReassign = api.processConfirmReassign;
            window.deleteProspect = api.deleteProspect;
            window.reactivateLostProspect = api.reactivateLostProspect;
            window.getVisibleProspects = api.getVisibleProspects;
            window.canUserViewProspect = api.canUserViewProspect;
            window.canUserEditProspect = api.canUserEditProspect;
            window.canUserDeleteProspect = api.canUserDeleteProspect;
            window.canUserReassignProspect = api.canUserReassignProspect;
            window.canUserReactivateProspect = api.canUserReactivateProspect;
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
        setProspects: (p) => {
            if (typeof prospects !== 'undefined') prospects = p;
            if (typeof window !== 'undefined') window.prospects = p;
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getUsers: () => {
            if (typeof users !== 'undefined' && Array.isArray(users)) return users;
            if (typeof window !== 'undefined' && Array.isArray(window.users)) return window.users;
            return [];
        },
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : (typeof window !== 'undefined' && window.firebase ? window.firebase : null)),
        getCrmCommercial: () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : (typeof window !== 'undefined' && window.CrmCommercial ? window.CrmCommercial : null)),
        getCrmFollowUpCalc: () => (typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc : (typeof window !== 'undefined' && window.CrmFollowUpCalc ? window.CrmFollowUpCalc : null)),
        getClientName: (id) => {
            if (typeof getClientName === 'function') return getClientName(id);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(id);
            const clientsList = _deps.getClients();
            const c = clientsList.find(x => x.id === id);
            return c ? (c.empresa || c.nombres || id) : (id || '-');
        },
        getCurrentProspectId: () => {
            if (typeof currentProspectId !== 'undefined') return currentProspectId;
            if (typeof window !== 'undefined' && window.currentProspectId) return window.currentProspectId;
            return null;
        },
        setCurrentProspectId: (id) => {
            if (typeof currentProspectId !== 'undefined') currentProspectId = id;
            if (typeof window !== 'undefined') window.currentProspectId = id;
        },
        openModal: (id) => {
            if (typeof openModal === 'function') return openModal(id);
            if (typeof window !== 'undefined' && typeof window.openModal === 'function') return window.openModal(id);
            const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
            if (el) el.style.display = 'flex';
        },
        closeModal: (id) => {
            if (typeof closeModal === 'function') return closeModal(id);
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(id);
            const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
            if (el) el.style.display = 'none';
        },
        openDetail: (id) => {
            if (typeof openDetail === 'function') return openDetail(id);
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') return window.openDetail(id);
        },
        renderList: () => {
            if (typeof renderList === 'function') return renderList();
            if (typeof window !== 'undefined' && typeof window.renderList === 'function') return window.renderList();
        },
        renderTracker: (p) => {
            if (typeof renderTracker === 'function') return renderTracker(p);
            if (typeof window !== 'undefined' && typeof window.renderTracker === 'function') return window.renderTracker(p);
        },
        renderInfo: (p) => {
            if (typeof renderInfo === 'function') return renderInfo(p);
            if (typeof window !== 'undefined' && typeof window.renderInfo === 'function') return window.renderInfo(p);
        },
        goBackFromDetail: () => {
            if (typeof goBackFromDetail === 'function') return goBackFromDetail();
            if (typeof window !== 'undefined' && typeof window.goBackFromDetail === 'function') return window.goBackFromDetail();
        },
        runWorkflowOp: (label, fn) => {
            if (typeof runWorkflowOp === 'function') return runWorkflowOp(label, fn);
            if (typeof window !== 'undefined' && typeof window.runWorkflowOp === 'function') return window.runWorkflowOp(label, fn);
            const fb = _deps.getFirebase();
            const CrmCommercial = _deps.getCrmCommercial();
            if (!CrmCommercial || !CrmCommercial.hasSessionSync(fb)) {
                _deps.alert(CrmCommercial && CrmCommercial.NO_SESSION_MESSAGE ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
                return Promise.resolve(null);
            }
            _deps.showLoading(label);
            return fn(fb).catch(err => {
                if (err && String(err.code || '').startsWith('functions/')) _deps.alert(CrmCommercial.errorMessage(err));
                else _deps.alert('No se pudo completar la operación: ' + ((err && err.message) || 'error desconocido'));
                console.error(err);
                return null;
            }).finally(() => {
                _deps.hideLoading();
            });
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
            if (typeof alert === 'function') alert(msg);
            else console.warn('[OpportunitiesController]', msg);
        },
        confirm: (msg) => {
            if (typeof confirm === 'function') return confirm(msg);
            return true;
        },
        prompt: (msg) => {
            if (typeof prompt === 'function') return prompt(msg);
            return '';
        },
        formatCurrency: (n) => {
            if (typeof formatCurrency === 'function') return formatCurrency(n);
            if (typeof window !== 'undefined' && typeof window.formatCurrency === 'function') return window.formatCurrency(n);
            return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        hasEnteredPostclosing: (p) => {
            if (typeof hasEnteredPostclosing === 'function') return hasEnteredPostclosing(p);
            if (typeof window !== 'undefined' && typeof window.hasEnteredPostclosing === 'function') return window.hasEnteredPostclosing(p);
            return !!(p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado')));
        }
    };

    function initOpportunitiesController(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            Object.assign(_deps, customDeps);
        }
        return OpportunitiesController;
    }

    // -------------------------------------------------------------------------
    // 2. Estado interno del módulo de oportunidades
    // -------------------------------------------------------------------------
    let oppStatusFilter = 'activas';  // 'activas' | 'perdidas' | 'todas'
    let oppClasifFilter = 'todas';    // 'todas' | 'ejecucion' | 'presupuesto'
    let oppStageFilter = 'todas';     // 'todas' | 'prospecto' | 'levantamiento' | 'cotizacion' | 'negociacion' | 'cierre'
    let oppSortCol = '';              // '' | 'codigo' | 'cliente' | 'proyecto' | 'vendedor' | 'fecha' | 'etapa' | 'monto' | 'estado'
    let oppSortDir = 'asc';           // 'asc' | 'desc'

    // -------------------------------------------------------------------------
    // 3. Manejo de Fechas de Prospectos / Oportunidades
    // -------------------------------------------------------------------------
    /**
     * Parsea con tolerancia cualquier representación de fecha de prospecto/oportunidad:
     * - Objeto Date nativo
     * - Timestamp de Firestore (con método .toDate() o propiedades .seconds / ._seconds)
     * - Timestamp numérico (milisegundos o segundos)
     * - String ISO o formato reconocible
     * Retorna un objeto Date válido o null si es inexistente / inválido.
     */
    function parseProspectDate(raw) {
        if (!raw) return null;
        if (raw instanceof Date) {
            return isNaN(raw.getTime()) ? null : raw;
        }
        if (typeof raw === 'object') {
            if (typeof raw.toDate === 'function') {
                try {
                    const d = raw.toDate();
                    if (d instanceof Date && !isNaN(d.getTime())) return d;
                } catch (_) {}
            }
            if (typeof raw.seconds === 'number') {
                const d = new Date(raw.seconds * 1000);
                return isNaN(d.getTime()) ? null : d;
            }
            if (typeof raw._seconds === 'number') {
                const d = new Date(raw._seconds * 1000);
                return isNaN(d.getTime()) ? null : d;
            }
        }
        if (typeof raw === 'number') {
            const ms = raw < 1e11 ? raw * 1000 : raw;
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d;
        }
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (!trimmed) return null;
            const d = new Date(trimmed);
            return isNaN(d.getTime()) ? null : d;
        }
        return null;
    }

    /**
     * Formatea una fecha de ingreso canónica a DD/MM/AAAA.
     * Si el registro no tiene fecha válida, retorna '-' para representar fecha desconocida de forma coherente.
     */
    function formatProspectDate(raw) {
        const d = parseProspectDate(raw);
        if (!d) return '-';
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    /**
     * Limpia el filtro de rango de fechas de ingreso de oportunidades y re-renderiza la lista.
     */
    function clearOppDateFilter() {
        if (typeof document !== 'undefined') {
            const startEl = document.getElementById('opp-date-start');
            const endEl = document.getElementById('opp-date-end');
            if (startEl) startEl.value = '';
            if (endEl) endEl.value = '';
        }
        _deps.renderList();
    }

    // -------------------------------------------------------------------------
    // 4. Ordenamiento de Oportunidades
    // -------------------------------------------------------------------------
    function getOppSortCol() {
        return oppSortCol;
    }

    function getOppSortDir() {
        return oppSortDir;
    }

    function setOppSort(column, direction) {
        oppSortCol = column || '';
        oppSortDir = direction === 'desc' ? 'desc' : 'asc';
    }

    function toggleOppSort(column) {
        if (oppSortCol === column) {
            oppSortDir = oppSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            oppSortCol = column;
            oppSortDir = 'asc';
        }
        _deps.renderList();
        updateOppSortIcons();
    }

    function updateOppSortIcons() {
        if (typeof document === 'undefined') return;
        const columns = ['codigo', 'cliente', 'proyecto', 'vendedor', 'fecha', 'etapa', 'monto', 'estado'];
        columns.forEach(col => {
            const el = document.getElementById(`sort-opp-${col}`);
            if (!el) return;
            if (oppSortCol === col) {
                el.innerHTML = oppSortDir === 'asc' ? '▲' : '▼';
                el.style.color = 'var(--brand-gold)';
            } else if (!oppSortCol && col === 'fecha') {
                el.innerHTML = '▼';
                el.style.color = 'var(--text-secondary)';
            } else {
                el.innerHTML = '↕';
                el.style.color = 'var(--text-muted)';
            }
        });
    }

    function sortProspects(list, col, dir) {
        const c = typeof col !== 'undefined' ? col : oppSortCol;
        const d = typeof dir !== 'undefined' ? dir : oppSortDir;
        if (!c || !Array.isArray(list)) return list;

        const copy = list.slice();
        copy.sort((a, b) => {
            if (c === 'fecha') {
                const dateA = parseProspectDate(a.fecha_creacion);
                const dateB = parseProspectDate(b.fecha_creacion);
                let dateDiff = 0;
                if (dateA && dateB) {
                    dateDiff = d === 'asc' ? dateA.getTime() - dateB.getTime() : dateB.getTime() - dateA.getTime();
                } else if (dateA) {
                    dateDiff = -1;
                } else if (dateB) {
                    dateDiff = 1;
                }
                if (dateDiff !== 0) return dateDiff;
                const tieA = a.codigo || a.id || '';
                const tieB = b.codigo || b.id || '';
                return tieA.localeCompare(tieB, 'es', { sensitivity: 'base' });
            }

            let valA = '';
            let valB = '';

            if (c === 'codigo') {
                valA = a.codigo || a.id.substring(a.id.length - 4);
                valB = b.codigo || b.id.substring(b.id.length - 4);
            } else if (c === 'cliente') {
                valA = _deps.getClientName(a.clientId);
                valB = _deps.getClientName(b.clientId);
            } else if (c === 'proyecto') {
                valA = a.proyecto || '';
                valB = b.proyecto || '';
            } else if (c === 'vendedor') {
                valA = getProspectVendorInfo(a).name;
                valB = getProspectVendorInfo(b).name;
            } else if (c === 'etapa') {
                valA = a.etapa || '';
                valB = b.etapa || '';
            } else if (c === 'monto') {
                valA = parseFloat(a.precio_cotizado) || 0;
                valB = parseFloat(b.precio_cotizado) || 0;
            } else if (c === 'estado') {
                valA = a.estado || '';
                valB = b.estado || '';
            }

            let comp = 0;
            if (typeof valA === 'string') {
                comp = d === 'asc'
                    ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                    : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
            } else {
                comp = d === 'asc' ? valA - valB : valB - valA;
            }

            if (comp !== 0) return comp;
            // Desempate determinista
            const tieA = a.codigo || a.id || '';
            const tieB = b.codigo || b.id || '';
            return tieA.localeCompare(tieB, 'es', { sensitivity: 'base' });
        });
        return copy;
    }

    // -------------------------------------------------------------------------
    // 5. Filtros de Oportunidades (Estado, Clasificación, Etapa)
    // -------------------------------------------------------------------------
    function getOppStatusFilter() {
        return oppStatusFilter;
    }

    function getOppClasifFilter() {
        return oppClasifFilter;
    }

    function getOppStageFilter() {
        return oppStageFilter;
    }

    function setOppStatusFilter(filterKey) {
        if (['activas', 'perdidas', 'todas'].includes(filterKey)) {
            oppStatusFilter = filterKey;
            _deps.renderList();
        }
    }

    function setOppClasifFilter(filterKey) {
        if (['todas', 'ejecucion', 'presupuesto'].includes(filterKey)) {
            oppClasifFilter = filterKey;
            _deps.renderList();
        }
    }

    function setOppStageFilter(filterKey) {
        const validStages = ['todas', 'prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
        if (validStages.includes(filterKey)) {
            if (oppStageFilter === filterKey && filterKey !== 'todas') {
                oppStageFilter = 'todas';
            } else {
                oppStageFilter = filterKey;
            }
            _deps.renderList();
        }
    }

    function filterProspectsByStatus(list, filter) {
        const f = filter || oppStatusFilter;
        if (!Array.isArray(list)) return [];
        if (f === 'activas') return list.filter(p => p && p.estado !== 'perdido');
        if (f === 'perdidas') return list.filter(p => p && p.estado === 'perdido');
        return list; // 'todas'
    }

    function filterProspectsByClasif(list, filter) {
        const f = filter || oppClasifFilter;
        if (!Array.isArray(list)) return [];
        if (f === 'ejecucion') return list.filter(p => p && (p.clasificacion || 'ejecucion') === 'ejecucion');
        if (f === 'presupuesto') return list.filter(p => p && p.clasificacion === 'presupuesto');
        return list; // 'todas'
    }

    function filterProspectsByStage(list, filter) {
        const f = filter || oppStageFilter;
        if (!Array.isArray(list)) return [];
        if (f && f !== 'todas') return list.filter(p => p && p.etapa === f);
        return list;
    }

    function filterProspectsBySearch(list, searchTerm) {
        if (!Array.isArray(list)) return [];
        const term = String(searchTerm || '').toLowerCase().trim();
        if (!term) return list;
        return list.filter(p => {
            if (!p) return false;
            const codeMatch = (p.codigo || '').toLowerCase().includes(term) || (p.id && p.id.substring(p.id.length - 4).toLowerCase().includes(term));
            const clientMatch = _deps.getClientName(p.clientId).toLowerCase().includes(term);
            const projectMatch = (p.proyecto || '').toLowerCase().includes(term);
            const vendorInfo = getProspectVendorInfo(p);
            const vendorMatch = vendorInfo.name.toLowerCase().includes(term) || vendorInfo.role.toLowerCase().includes(term);
            const stageMatch = (p.etapa || '').toLowerCase().includes(term);
            const amountMatch = p.precio_cotizado ? _deps.formatCurrency(p.precio_cotizado).toLowerCase().includes(term) || String(p.precio_cotizado).includes(term) : false;
            const statusMatch = (p.estado || '').toLowerCase().includes(term);
            const dateStr = formatProspectDate(p.fecha_creacion);
            const dateMatch = dateStr !== '-' && dateStr.toLowerCase().includes(term);
            return codeMatch || clientMatch || projectMatch || vendorMatch || stageMatch || amountMatch || statusMatch || dateMatch;
        });
    }

    function filterProspectsByDateRange(list, startVal, endVal) {
        if (!Array.isArray(list)) return [];
        if (!startVal && !endVal) return list;
        let startTime = null;
        let endTime = null;
        if (startVal) {
            const [y, m, d] = String(startVal).split('-').map(Number);
            startTime = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        }
        if (endVal) {
            const [y, m, d] = String(endVal).split('-').map(Number);
            endTime = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        }
        return list.filter(p => {
            if (!p) return false;
            const pDate = parseProspectDate(p.fecha_creacion);
            if (!pDate) return false;
            const pTime = pDate.getTime();
            if (startTime !== null && pTime < startTime) return false;
            if (endTime !== null && pTime > endTime) return false;
            return true;
        });
    }

    function getFilteredProspects(options = {}) {
        let result = getVisibleProspects(options.user);
        // Las oportunidades ganadas pertenecen al módulo de Proyectos y Cobros
        result = result.filter(p => p && p.estado !== 'ganado');

        result = filterProspectsByStatus(result, options.statusFilter);
        result = filterProspectsByClasif(result, options.clasifFilter);
        result = filterProspectsByStage(result, options.stageFilter);

        if (options.searchTerm) {
            result = filterProspectsBySearch(result, options.searchTerm);
        }
        if (options.startDate || options.endDate) {
            result = filterProspectsByDateRange(result, options.startDate, options.endDate);
        }
        if (options.sortCol) {
            result = sortProspects(result, options.sortCol, options.sortDir);
        } else if (oppSortCol) {
            result = sortProspects(result, oppSortCol, oppSortDir);
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // 6. Atribución Comercial y Reasignación de Vendedor
    // -------------------------------------------------------------------------
    function getProspectVendorInfo(p) {
        if (!p) return { id: '', name: 'Sistema', role: '' };

        const users = _deps.getUsers();
        const CrmFollowUpCalc = _deps.getCrmFollowUpCalc();

        let userId = p.vendedorId || p.createdBy;
        let name = (CrmFollowUpCalc && typeof CrmFollowUpCalc.resolveSellerName === 'function')
            ? CrmFollowUpCalc.resolveSellerName(p, users)
            : (p.vendedorName || p.createdByName || p.creado_por || p.vendedor);
        let role = p.vendedorRole || p.createdByRole || '';

        if (userId) {
            const u = Array.isArray(users) ? users.find(x => x && (x.id === userId || (x.authUid && x.authUid === userId))) : null;
            if (u) {
                if (!name || name === 'Sin Asignar') name = u.nombre;
                role = u.role || role;
            }
        }

        if (!name || name === 'Sin Asignar') {
            name = p.vendedorName || p.vendedor || 'Sin Asignar';
        }

        let roleText = '';
        if (role === 'manager') roleText = 'Gerente';
        else if (role === 'gestor') roleText = 'Gestor de Ventas';
        else if (role === 'vendedor') roleText = 'Vendedor';

        return { id: userId, name, role: roleText };
    }

    function reassignVendor(prospectId, directTargetId) {
        const prospectsList = _deps.getProspects();
        const p = prospectsList.find(x => x.id === prospectId);
        if (!p) return;
        const isClosed = (typeof _deps.hasEnteredPostclosing === 'function' ? _deps.hasEnteredPostclosing(p) : (p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado'))));
        if (isClosed) {
            return _deps.alert("No se puede reasignar una oportunidad que ya completó el cierre comercial.");
        }
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            return _deps.alert("Solo los Gerentes pueden reasignar oportunidades.");
        }

        const currentVendor = getProspectVendorInfo(p);
        const doc = (typeof document !== 'undefined') ? document : null;
        const modalEl = (doc && doc.getElementById) ? doc.getElementById('reassignModal') : null;

        const users = _deps.getUsers();

        if (modalEl && !directTargetId) {
            const subTitle = doc.getElementById('reassign-modal-subtitle');
            if (subTitle) subTitle.textContent = `Proyecto: ${p.proyecto || p.codigo || '-'}`;

            const currVendorEl = doc.getElementById('reassign-current-vendor');
            if (currVendorEl) {
                const roleLabel = currentVendor.role ? ` (${currentVendor.role})` : '';
                currVendorEl.textContent = `${currentVendor.name}${roleLabel}`;
            }

            const pidInput = doc.getElementById('reassign-prospect-id');
            if (pidInput) pidInput.value = p.id;

            const errBox = doc.getElementById('reassign-error-box');
            if (errBox) {
                errBox.style.display = 'none';
                errBox.textContent = '';
            }

            const selectEl = doc.getElementById('reassign-new-vendor-select');
            if (selectEl) {
                selectEl.innerHTML = '<option value="">-- Selecciona un vendedor o gestor --</option>';

                // Solo usuarios activos con rol 'vendedor' o 'gestor'
                // Se excluyen explícitamente gerentes, administradores e inactivos.
                const validUsers = (Array.isArray(users) ? users : []).filter(u => {
                    if (!u || u.activo === false) return false;
                    const r = String(u.role || '').toLowerCase();
                    return r === 'vendedor' || r === 'gestor';
                });

                validUsers.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

                validUsers.forEach(u => {
                    const opt = doc.createElement('option');
                    opt.value = u.id;
                    const roleName = u.role === 'gestor' ? 'Gestor' : 'Vendedor';
                    opt.textContent = `${u.nombre} (${roleName})`;
                    if (u.id === currentVendor.id) {
                        opt.textContent += ' [Actual]';
                    }
                    selectEl.appendChild(opt);
                });
            }

            const btnSubmit = doc.getElementById('btn-confirm-reassign');
            if (btnSubmit) {
                btnSubmit.disabled = false;
                btnSubmit.textContent = 'Confirmar Reasignación';
            }

            _deps.openModal('reassignModal');
            return;
        }

        // Fallback para entornos de prueba sin modal DOM completo o invocación directa
        let targetUser = null;
        const activeVendors = (Array.isArray(users) ? users : []).filter(u => u && u.activo !== false && (u.role === 'vendedor' || u.role === 'gestor'));

        if (directTargetId) {
            targetUser = activeVendors.find(u => u.id === directTargetId || u.cid === directTargetId || (u.email && u.email.toLowerCase() === String(directTargetId).toLowerCase()));
        } else if (typeof prompt === 'function' || typeof _deps.prompt === 'function') {
            const promptFn = typeof _deps.prompt === 'function' ? _deps.prompt : prompt;
            const selStr = promptFn(`Reasignar Oportunidad: "${p.proyecto}"\nVendedor Actual: ${currentVendor.name}`);
            if (!selStr) return;
            targetUser = activeVendors.find(u => (u.email && u.email.toLowerCase() === selStr.toLowerCase().trim()) || (u.nombre && u.nombre.toLowerCase().includes(selStr.toLowerCase().trim())));
            const num = parseInt(selStr, 10);
            if (!targetUser && !isNaN(num) && num > 0 && num <= activeVendors.length) {
                targetUser = activeVendors[num - 1];
            }
        }

        if (!targetUser) return _deps.alert("Vendedor no encontrado.");

        const fb = _deps.getFirebase();
        const CrmCommercial = _deps.getCrmCommercial();
        if (!CrmCommercial || !CrmCommercial.hasSessionSync(fb)) {
            return _deps.alert(CrmCommercial && CrmCommercial.NO_SESSION_MESSAGE ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        }
        _deps.showLoading('Reasignando vendedor...');
        return CrmCommercial.reassign(fb, { prospectId: p.id, vendedorId: targetUser.id, dbSuffix: _deps.getDbSuffix() }).then(res => {
            if (res && res.status === 'reassigned') {
                p.vendedorId = res.vendedorId;
                p.vendedorName = res.vendedorName;
                p.vendedorRole = res.vendedorRole;
            }
            _deps.openDetail(p.id);
            _deps.renderList();
            _deps.alert(res && res.status === 'reassigned' ? `✔️ Oportunidad reasignada exitosamente a ${targetUser.nombre}.` : 'La oportunidad ya estaba asignada a ese vendedor.');
        }).catch(err => _deps.alert(CrmCommercial.errorMessage(err))).finally(() => {
            _deps.hideLoading();
        });
    }

    async function processConfirmReassign(event) {
        if (event && event.preventDefault) event.preventDefault();
        const doc = (typeof document !== 'undefined') ? document : null;
        const pidInput = doc ? doc.getElementById('reassign-prospect-id') : null;
        const selectEl = doc ? doc.getElementById('reassign-new-vendor-select') : null;
        const errBox = doc ? doc.getElementById('reassign-error-box') : null;
        const btnSubmit = doc ? doc.getElementById('btn-confirm-reassign') : null;

        const prospectId = pidInput ? pidInput.value : null;
        const targetUserId = selectEl ? selectEl.value : null;

        if (!prospectId) return;

        if (!targetUserId) {
            if (errBox) {
                errBox.textContent = 'Por favor selecciona un nuevo responsable comercial.';
                errBox.style.display = 'block';
            }
            return;
        }

        const users = _deps.getUsers();
        const targetUser = (Array.isArray(users) ? users : []).find(u => u.id === targetUserId);
        if (!targetUser || (targetUser.role !== 'vendedor' && targetUser.role !== 'gestor')) {
            if (errBox) {
                errBox.textContent = 'El usuario seleccionado no es un Vendedor o Gestor válido.';
                errBox.style.display = 'block';
            }
            return;
        }

        const prospectsList = _deps.getProspects();
        const p = prospectsList.find(x => x.id === prospectId);
        if (!p) return;

        const fb = _deps.getFirebase();
        const CrmCommercial = _deps.getCrmCommercial();
        if (!CrmCommercial || !CrmCommercial.hasSessionSync(fb)) {
            if (errBox) {
                errBox.textContent = CrmCommercial ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.';
                errBox.style.display = 'block';
            }
            return;
        }

        if (btnSubmit) {
            btnSubmit.disabled = true;
            btnSubmit.textContent = 'Reasignando...';
        }
        if (errBox) errBox.style.display = 'none';

        try {
            const res = await CrmCommercial.reassign(fb, { prospectId: p.id, vendedorId: targetUser.id, dbSuffix: _deps.getDbSuffix() });
            if (res && res.status === 'reassigned') {
                p.vendedorId = res.vendedorId;
                p.vendedorName = res.vendedorName;
                p.vendedorRole = res.vendedorRole;
            }
            _deps.closeModal('reassignModal');
            _deps.openDetail(p.id);
            _deps.renderList();
            _deps.alert(res && res.status === 'reassigned' ? `✔️ Oportunidad reasignada exitosamente a ${targetUser.nombre}.` : 'La oportunidad ya estaba asignada a ese vendedor.');
        } catch (err) {
            if (errBox) {
                errBox.textContent = CrmCommercial.errorMessage(err);
                errBox.style.display = 'block';
            } else {
                _deps.alert(CrmCommercial.errorMessage(err));
            }
        } finally {
            if (btnSubmit) {
                btnSubmit.disabled = false;
                btnSubmit.textContent = 'Confirmar Reasignación';
            }
        }
    }

    // -------------------------------------------------------------------------
    // 7. Visibilidad y Permisos de Oportunidades por Rol
    // -------------------------------------------------------------------------
    function getVisibleProspects(user) {
        const u = user || _deps.getCurrentUser();
        const list = _deps.getProspects();
        if (!u) return [];
        if (u.role === 'manager' || u.role === 'admin') {
            return list.filter(p => p && p.eliminado !== true);
        }
        if (u.role === 'gestor' || u.role === 'vendedor') {
            return list.filter(p => {
                if (!p || p.eliminado === true) return false;
                const isAssigned = p.vendedorId === u.id || (!p.vendedorId && p.createdBy === u.id);
                if (isAssigned) return true;
                if (u.role === 'gestor' && typeof _deps.hasEnteredPostclosing === 'function' && _deps.hasEnteredPostclosing(p)) {
                    return true;
                }
                return false;
            });
        }
        return [];
    }

    function canUserViewProspect(p, user) {
        if (!p || p.eliminado === true) return false;
        const u = user || _deps.getCurrentUser();
        if (!u) return false;
        if (u.role === 'manager' || u.role === 'admin') return true;
        if (u.role === 'gestor' || u.role === 'vendedor') {
            const isAssigned = p.vendedorId === u.id || (!p.vendedorId && p.createdBy === u.id);
            if (isAssigned) return true;
            if (u.role === 'gestor' && typeof _deps.hasEnteredPostclosing === 'function' && _deps.hasEnteredPostclosing(p)) {
                return true;
            }
            return false;
        }
        return false;
    }

    function canUserEditProspect(p, user) {
        if (!p || p.estado !== 'activo' || p.eliminado === true) return false;
        const u = user || _deps.getCurrentUser();
        if (!u) return false;
        const isEditableStage = p.etapa !== 'cierre' && (!p.postcierre_habilitado);
        if (!isEditableStage) return false;
        if (u.role === 'manager') return true;
        const isAssigned = p.vendedorId === u.id || (!p.vendedorId && p.createdBy === u.id);
        if (isAssigned) return true;
        if (u.role === 'gestor' && (p.vendedorId === u.id || p.createdBy === u.id)) return true;
        return false;
    }

    function canUserDeleteProspect(p, user) {
        if (!p || p.eliminado === true) return false;
        const u = user || _deps.getCurrentUser();
        return !!u && u.role === 'manager';
    }

    function canUserReassignProspect(p, user) {
        if (!p || p.eliminado === true) return false;
        const u = user || _deps.getCurrentUser();
        if (!u || u.role !== 'manager') return false;
        const isClosed = (typeof _deps.hasEnteredPostclosing === 'function' ? _deps.hasEnteredPostclosing(p) : (p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado'))));
        return !isClosed;
    }

    function canUserReactivateProspect(p, user) {
        if (!p || p.eliminado === true || p.estado !== 'perdido') return false;
        const u = user || _deps.getCurrentUser();
        return !!u && u.role === 'manager';
    }

    // -------------------------------------------------------------------------
    // 8. Eliminación Lógica y Reactivación Protegida
    // -------------------------------------------------------------------------
    // Logical deletion (deleteProspectAdmin): the opportunity is MARKED as deleted (who / when / why) and disappears from the listings;
    // its data, the files and the manufacturing project stay untouched. The reason is mandatory and is validated by the server too.
    async function deleteProspect(targetId, motivoText) {
        const prospectId = targetId || _deps.getCurrentProspectId();
        if (!prospectId) return;
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') return _deps.alert("Permiso denegado.");

        const prospectsList = _deps.getProspects();
        const p = prospectsList.find(x => x.id === prospectId);
        if (!p) return;

        if (typeof motivoText !== 'string' && !_deps.confirm(`¿Eliminar el proyecto "${p.proyecto}"?\n\nSe marcará como eliminado y dejará de aparecer en los listados. No se borran sus datos, ni los archivos, ni el proyecto de fabricación asociado.`)) return;

        let motivo = motivoText;
        if (typeof motivo !== 'string') {
            const promptFn = typeof _deps.prompt === 'function' ? _deps.prompt : prompt;
            motivo = String(promptFn('Indica el motivo de la eliminación (obligatorio):') || '').trim();
        } else {
            motivo = motivo.trim();
        }
        if (!motivo) return _deps.alert("La eliminación requiere un motivo. No se eliminó nada.");

        const CrmCommercial = _deps.getCrmCommercial();
        const dbSuffix = _deps.getDbSuffix();
        const res = await _deps.runWorkflowOp('Eliminando proyecto...', fb => CrmCommercial.deleteProspect(fb, { prospectId: p.id, motivo, dbSuffix }));
        if (!res) return;
        _deps.alert("Proyecto eliminado exitosamente.");
        _deps.goBackFromDetail();
    }

    // Reactivation of lost opportunity (reactivateLostProspectAdmin): restores an opportunity marked as lost to active status,
    // preserving its loss history and restoring commercial stage and visibility. Only managers can perform this.
    async function reactivateLostProspect(targetId, motivoText) {
        const prospectId = targetId || _deps.getCurrentProspectId();
        if (!prospectId) return;
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') return _deps.alert("Permiso denegado: solo un usuario con rol de gerencia puede reactivar proyectos.");

        const prospectsList = _deps.getProspects();
        const p = prospectsList.find(x => x.id === prospectId);
        if (!p) return;
        if (p.estado !== 'perdido') return _deps.alert("Solo se pueden reactivar proyectos que se encuentren en estado 'perdido'.");
        if (p.eliminado === true) return _deps.alert("No se puede reactivar un proyecto eliminado lógicamente.");

        if (typeof motivoText !== 'string' && !_deps.confirm(`¿Deseas reactivar el proyecto "${p.proyecto}"?\n\nEl proyecto volverá a estar activo en su etapa comercial previa y se restaurará la visibilidad comercial para su equipo.`)) return;

        let motivo = motivoText;
        if (typeof motivo !== 'string') {
            const promptFn = typeof _deps.prompt === 'function' ? _deps.prompt : prompt;
            motivo = String(promptFn('Indica el motivo de la reactivación (obligatorio):') || '').trim();
        } else {
            motivo = motivo.trim();
        }
        if (!motivo) return _deps.alert("La reactivación requiere un motivo obligatorio. Operación cancelada.");

        const CrmCommercial = _deps.getCrmCommercial();
        const dbSuffix = _deps.getDbSuffix();
        const res = await _deps.runWorkflowOp('Reactivando proyecto...', fb => CrmCommercial.reactivateProspect(fb, { prospectId: p.id, motivo, dbSuffix }));
        if (!res) return;
        const resData = (res && res.data) || {};
        _deps.alert(`Proyecto reactivado exitosamente. Etapa activa: ${resData.etapa || p.etapa || 'restaurada'}.`);
        p.estado = 'activo';
        if (resData.etapa) p.etapa = resData.etapa;
        delete p.motivo_perdida;
        delete p.fecha_perdida;
        _deps.openDetail(p.id);
    }

    // -------------------------------------------------------------------------
    // 9. Consultas de Estado y Acceso Directo
    // -------------------------------------------------------------------------
    function getProspectById(id) {
        const list = _deps.getProspects();
        return list.find(x => x && x.id === id) || null;
    }

    const OpportunitiesController = {
        init: initOpportunitiesController,
        initOpportunitiesController,
        parseProspectDate,
        formatProspectDate,
        clearOppDateFilter,
        getOppSortCol,
        getOppSortDir,
        setOppSort,
        toggleOppSort,
        updateOppSortIcons,
        sortProspects,
        getOppStatusFilter,
        getOppClasifFilter,
        getOppStageFilter,
        setOppStatusFilter,
        setOppClasifFilter,
        setOppStageFilter,
        filterProspectsByStatus,
        filterProspectsByClasif,
        filterProspectsByStage,
        filterProspectsBySearch,
        filterProspectsByDateRange,
        getFilteredProspects,
        getProspectVendorInfo,
        reassignVendor,
        processConfirmReassign,
        getVisibleProspects,
        canUserViewProspect,
        canUserEditProspect,
        canUserDeleteProspect,
        canUserReassignProspect,
        canUserReactivateProspect,
        deleteProspect,
        reactivateLostProspect,
        getProspectById,
        _deps
    };

    return OpportunitiesController;
});
