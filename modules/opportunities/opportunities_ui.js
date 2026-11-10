// ============================================================================
// DUCTSAL ERP — OPPORTUNITIES MODULE: UI, DETAIL, LOGS & FORMS (Fase 6.3 - Bloque 2)
// Archivo: modules/opportunities/opportunities_ui.js
// Responsabilidades:
// 2A: Pipeline Comercial, Tabla, Filtros, Ordenamiento, Badges y Estados Vacíos.
// 2B: Detalle de Oportunidad, Navegación, Aislamiento y Permisos.
// 2C: Tracker de Etapas, Información Comercial, Historial, Logs y Bitácora Comercial.
// 2D: Formularios, Creación, Edición Base, Transiciones de Etapa, Documentación de Cierre,
//     Sustitución de Archivos, Finalización, Marcado de Pérdida y Modales.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        const api = factory();
        module.exports = api;
        if (typeof global !== 'undefined') {
            global.OpportunitiesUI = api;
        }
    } else {
        const api = factory();
        root.OpportunitiesUI = api;
        // Compatibilidad global con window y handlers HTML existentes (68 inline handlers)
        if (typeof window !== 'undefined') {
            window.OpportunitiesUI = api;
            // 2A - Pipeline / Listado
            window.renderList = api.renderList;
            window.updateFilterBadges = api.updateFilterBadges;
            window.renderPipelineRow = api.renderPipelineRow;
            window.renderEmptyState = api.renderEmptyState;

            // 2B - Detalle y Navegación
            window.openDetail = api.openDetail;
            window.goBackFromDetail = api.goBackFromDetail;

            // 2C - Tracker, Información, Logs y Bitácora
            window.renderTracker = api.renderTracker;
            window.renderInfo = api.renderInfo;
            window.renderLogs = api.renderLogs;
            window.deleteLog = api.deleteLog;
            window.addLogToProspect = api.addLogToProspect;
            window.onLogTextInput = api.onLogTextInput;
            window.dismissCommercialIntentBanner = api.dismissCommercialIntentBanner;
            window.transferTextToFollowUpModal = api.transferTextToFollowUpModal;
            window.addLog = api.addLog;

            // 2C - Seguimiento Comercial y Cadencias
            window.renderFollowUpSummary = api.renderFollowUpSummary;
            window.openRecordFollowUpModal = api.openRecordFollowUpModal;
            window.updateSuggestedFollowUpDate = api.updateSuggestedFollowUpDate;
            window.handleFollowUpCanalChange = api.handleFollowUpCanalChange;
            window.handleFollowUpResultadoChange = api.handleFollowUpResultadoChange;
            window.processSaveFollowUp = api.processSaveFollowUp;
            window.openCadenceModal = api.openCadenceModal;
            window.handleCadenceSelectChange = api.handleCadenceSelectChange;
            window.processSaveCadence = api.processSaveCadence;
            window.openReclassifyModal = api.openReclassifyModal;
            window.handleReclassifySelectChange = api.handleReclassifySelectChange;
            window.processSaveReclassification = api.processSaveReclassification;

            // 2D - Formularios, Edición Base y Creación
            window.openNewModal = api.openNewModal;
            window.createNewProspect = api.createNewProspect;
            window.openEditBasePriceModal = api.openEditBasePriceModal;
            window.processEditBasePrice = api.processEditBasePrice;
            window.showNewProposalForm = api.showNewProposalForm;
            window.processNewProposal = api.processNewProposal;
            window.toggleContractRequirement = api.toggleContractRequirement;

            // 2D - Autorización sin Contrato
            window.applyNoContractAuthorization = api.applyNoContractAuthorization;
            window['toggleManagerApproval'] = api.toggleManagerApproval;
            window['toggleManagerApprovalInForm'] = api.toggleManagerApprovalInForm;
            window.noContractRequestsOf = api.noContractRequestsOf;
            window.renderNoContractRequestHTML = api.renderNoContractRequestHTML;
            window.requestNoContractAuthorization = api.requestNoContractAuthorization;
            window.resolveNoContractRequest = api.resolveNoContractRequest;

            // 2D - Avance y Retroceso de Etapa
            window.showAdvanceForm = api.showAdvanceForm;
            window.processAdvance = api.processAdvance;
            window.confirmAdvanceToCierre = api.confirmAdvanceToCierre;
            window.showRevertForm = api.showRevertForm;
            window.cancelRevertForm = api.cancelRevertForm;
            window.processRevertStage = api.processRevertStage;

            // 2D - Cierre Documental y Finalización
            window.renderClosingDocumentationPanel = api.renderClosingDocumentationPanel;
            window.toggleProspectDocSubstForm = api.toggleProspectDocSubstForm;
            window.cancelProspectDocSubstForm = api.cancelProspectDocSubstForm;
            window.confirmProspectDocSubstitution = api.confirmProspectDocSubstitution;
            window.saveClosingProgress = api.saveClosingProgress;
            window.finalizeOpportunity = api.finalizeOpportunity;
            window.renderActivePowersOptions = api.renderActivePowersOptions;
            window.renderSignatoryStatusFeedback = api.renderSignatoryStatusFeedback;
            window.toggleClosingContractSection = api.toggleClosingContractSection;
            window.onClosingSignatoryTypeChange = api.onClosingSignatoryTypeChange;
            window.runB3CloseValidation = api.runB3CloseValidation;

            // 2D - Marcado de Pérdida
            window.showLoseForm = api.showLoseForm;
            window.openMarkLostModal = api.openMarkLostModal;
            window.closeMarkLostModal = api.closeMarkLostModal;
            window.processConfirmMarkLost = api.processConfirmMarkLost;
            window.processLose = api.processLose;

            // 2D - Modales
            window.openModal = api.openModal;
            window.closeModal = api.closeModal;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado local y dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    let currentProspectId = null;
    let DB_SUFFIX = (typeof window !== 'undefined' && window.DB_SUFFIX) ? window.DB_SUFFIX : (typeof global !== 'undefined' && global.DB_SUFFIX ? global.DB_SUFFIX : '_prod');

    function renderInlineOpportunityNotice(message, type = 'info') {
        if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
            const isSuccess = /exitosamente|✅|🎉|guardad|registrad|confirmad|actualizad/i.test(String(message || '')) && !/error|no se|denegado|inválid|falta|requiere|❌|⛔/i.test(String(message || ''));
            window.CrmUI.notify(isSuccess ? 'success' : 'error', String(message || ''));
        }
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
        const activeView = document.querySelector('.view-section.active')
            || (typeof document.getElementById === 'function' ? (document.getElementById('detail-view') || document.getElementById('list-view')) : null);
        if (!activeView || typeof document.createElement !== 'function') return;
        let banner = typeof document.getElementById === 'function' ? document.getElementById('b3-inline-view-notice') : null;
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'b3-inline-view-notice';
            banner.setAttribute('role', 'status');
            if (activeView.firstChild && typeof activeView.insertBefore === 'function') {
                activeView.insertBefore(banner, activeView.firstChild);
            } else if (typeof activeView.appendChild === 'function') {
                activeView.appendChild(banner);
            }
        } else if (banner.parentElement !== activeView && activeView.firstChild && typeof activeView.insertBefore === 'function') {
            activeView.insertBefore(banner, activeView.firstChild);
        }
        const isError = type === 'error' || /error|no se|denegado|inválid|falta|requiere|obligatorio|❌|⛔/i.test(String(message || ''));
        const isSuccess = !isError && (type === 'success' || /exitosamente|✅|🎉|guardad|registrad|confirmad|actualizad/i.test(String(message || '')));
        banner.style.cssText = isError
            ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fca5a5; font-size:0.84rem;'
            : (isSuccess
                ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem;'
                : 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(56,189,248,0.14); border:1px solid rgba(56,189,248,0.45); color:#bae6fd; font-size:0.84rem;');
        banner.textContent = String(message || '');
    }

    const _deps = {
        alert: (msg) => renderInlineOpportunityNotice(msg),
        confirm: () => true,
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            if (typeof global !== 'undefined' && global.currentUser) return global.currentUser;
            return null;
        },
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            if (typeof global !== 'undefined' && Array.isArray(global.prospects)) return global.prospects;
            return [];
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            if (typeof global !== 'undefined' && Array.isArray(global.clients)) return global.clients;
            return [];
        },
        getUsers: () => {
            if (typeof users !== 'undefined' && Array.isArray(users)) return users;
            if (typeof window !== 'undefined' && Array.isArray(window.users)) return window.users;
            if (typeof global !== 'undefined' && Array.isArray(global.users)) return global.users;
            return [];
        },
        getOpportunitiesController: () => {
            if (typeof OpportunitiesController !== 'undefined') return OpportunitiesController;
            if (typeof window !== 'undefined' && window.OpportunitiesController) return window.OpportunitiesController;
            if (typeof global !== 'undefined' && global.OpportunitiesController) return global.OpportunitiesController;
            return null;
        },
        getClientName: (id) => {
            if (typeof global !== 'undefined' && typeof global.getClientName === 'function') return global.getClientName(id);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(id);
            const clientsList = _deps.getClients();
            const c = (Array.isArray(clientsList) ? clientsList : []).find(x => x && x.id === id);
            return c ? (c.empresa || c.nombres || id) : (id || '-');
        },
        getProspectVendorInfo: (p) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getProspectVendorInfo === 'function') return ctrl.getProspectVendorInfo(p);
            if (typeof global !== 'undefined' && typeof global.getProspectVendorInfo === 'function') return global.getProspectVendorInfo(p);
            if (typeof window !== 'undefined' && typeof window.getProspectVendorInfo === 'function') return window.getProspectVendorInfo(p);
            if (!p) return { id: '', name: 'Sistema', role: '', avatar: '?' };
            const usersList = _deps.getUsers();
            let userId = p.vendedorId || p.createdBy;
            let name = p.vendedorName || p.createdByName || p.creado_por || p.vendedor;
            let role = p.vendedorRole || p.createdByRole || '';
            if (userId && Array.isArray(usersList)) {
                const u = usersList.find(x => x && (x.id === userId || (x.authUid && x.authUid === userId)));
                if (u) {
                    if (!name || name === 'Sin Asignar') name = u.nombre;
                    role = u.role || role;
                }
            }
            if (!name || name === 'Sin Asignar') name = p.vendedorName || p.vendedor || 'Sin Asignar';
            let roleText = '';
            if (role === 'manager') roleText = 'Gerente';
            else if (role === 'gestor') roleText = 'Gestor';
            else if (role === 'vendedor') roleText = 'Vendedor';
            else if (role === 'consultor') roleText = 'Consultor';
            else roleText = role;
            return {
                id: userId || '',
                name: name || 'Sin Asignar',
                role: roleText,
                avatar: (name[0] || '?').toUpperCase()
            };
        },
        parseProspectDate: (raw) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.parseProspectDate === 'function') return ctrl.parseProspectDate(raw);
            if (typeof global !== 'undefined' && typeof global.parseProspectDate === 'function') return global.parseProspectDate(raw);
            if (typeof window !== 'undefined' && typeof window.parseProspectDate === 'function') return window.parseProspectDate(raw);
            if (!raw) return null;
            if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
            if (typeof raw === 'object' && typeof raw.toDate === 'function') {
                try { const d = raw.toDate(); return (d instanceof Date && !isNaN(d.getTime())) ? d : null; } catch (e) { return null; }
            }
            if (typeof raw === 'object' && (typeof raw.seconds === 'number' || typeof raw._seconds === 'number')) {
                const s = typeof raw.seconds === 'number' ? raw.seconds : raw._seconds;
                const d = new Date(s * 1000);
                return isNaN(d.getTime()) ? null : d;
            }
            const d = new Date(raw);
            return isNaN(d.getTime()) ? null : d;
        },
        formatProspectDate: (raw) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.formatProspectDate === 'function') return ctrl.formatProspectDate(raw);
            if (typeof global !== 'undefined' && typeof global.formatProspectDate === 'function') return global.formatProspectDate(raw);
            if (typeof window !== 'undefined' && typeof window.formatProspectDate === 'function') return window.formatProspectDate(raw);
            const d = _deps.parseProspectDate(raw);
            if (!d) return '-';
            return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
        },
        formatCurrency: (n) => {
            if (typeof global !== 'undefined' && typeof global.formatCurrency === 'function') return global.formatCurrency(n);
            if (typeof window !== 'undefined' && typeof window.formatCurrency === 'function') return window.formatCurrency(n);
            const val = Number(n || 0);
            return isNaN(val) ? '$0.00' : '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        escapeHtmlDoc: (s) => {
            if (typeof global !== 'undefined' && typeof global.escapeHtmlDoc === 'function') return global.escapeHtmlDoc(s);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(s);
            return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },
        openDetail: (id) => {
            return openDetail(id);
        },
        getOppStatusFilter: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getOppStatusFilter === 'function') return ctrl.getOppStatusFilter();
            if (typeof oppStatusFilter !== 'undefined') return oppStatusFilter;
            if (typeof window !== 'undefined' && typeof window.oppStatusFilter !== 'undefined') return window.oppStatusFilter;
            return 'activas';
        },
        getOppClasifFilter: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getOppClasifFilter === 'function') return ctrl.getOppClasifFilter();
            if (typeof oppClasifFilter !== 'undefined') return oppClasifFilter;
            if (typeof window !== 'undefined' && typeof window.oppClasifFilter !== 'undefined') return window.oppClasifFilter;
            return 'todas';
        },
        getOppStageFilter: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getOppStageFilter === 'function') return ctrl.getOppStageFilter();
            if (typeof oppStageFilter !== 'undefined') return oppStageFilter;
            if (typeof window !== 'undefined' && typeof window.oppStageFilter !== 'undefined') return window.oppStageFilter;
            return 'todas';
        },
        getOppSortCol: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getOppSortCol === 'function') return ctrl.getOppSortCol();
            if (typeof oppSortCol !== 'undefined') return oppSortCol;
            if (typeof window !== 'undefined' && typeof window.oppSortCol !== 'undefined') return window.oppSortCol;
            return '';
        },
        getOppSortDir: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.getOppSortDir === 'function') return ctrl.getOppSortDir();
            if (typeof oppSortDir !== 'undefined') return oppSortDir;
            if (typeof window !== 'undefined' && typeof window.oppSortDir !== 'undefined') return window.oppSortDir;
            return 'asc';
        },
        updateOppSortIcons: () => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.updateOppSortIcons === 'function') return ctrl.updateOppSortIcons();
            if (typeof global !== 'undefined' && typeof global.updateOppSortIcons === 'function') return global.updateOppSortIcons();
            if (typeof window !== 'undefined' && typeof window.updateOppSortIcons === 'function') return window.updateOppSortIcons();
        },
        getCrmLoadError: () => {
            if (typeof crmLoadError !== 'undefined') return crmLoadError;
            if (typeof window !== 'undefined' && typeof window.crmLoadError !== 'undefined') return window.crmLoadError;
            return null;
        },
        getInitialLoadCompleted: () => {
            if (typeof initialLoadCompleted !== 'undefined') return initialLoadCompleted;
            if (typeof window !== 'undefined' && typeof window.initialLoadCompleted !== 'undefined') return window.initialLoadCompleted;
            return true;
        },
        retryDataListeners: () => {
            if (typeof global !== 'undefined' && typeof global.retryDataListeners === 'function') return global.retryDataListeners();
            if (typeof window !== 'undefined' && typeof window.retryDataListeners === 'function') return window.retryDataListeners();
        },
        getCurrentProspectId: () => {
            if (currentProspectId) return currentProspectId;
            if (typeof window !== 'undefined' && window.currentProspectId) return window.currentProspectId;
            return null;
        },
        setCurrentProspectId: (id) => {
            currentProspectId = id;
            if (typeof window !== 'undefined') window.currentProspectId = id;
            if (typeof global !== 'undefined') global.currentProspectId = id;
        },
        getSettings: () => {
            if (typeof settings !== 'undefined' && settings) return settings;
            if (typeof window !== 'undefined' && window.settings) return window.settings;
            return { visitantes: [], encargados: [] };
        },
        getDbSuffix: () => {
            if (typeof DB_SUFFIX !== 'undefined') return DB_SUFFIX;
            if (typeof window !== 'undefined' && window.DB_SUFFIX) return window.DB_SUFFIX;
            return '_staging';
        },
        getStages: () => {
            if (typeof STAGES !== 'undefined' && Array.isArray(STAGES)) return STAGES;
            if (typeof window !== 'undefined' && Array.isArray(window.STAGES)) return window.STAGES;
            return ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
        },
        getMotivosPerdida: () => {
            if (typeof MOTIVOS_PERDIDA !== 'undefined' && Array.isArray(MOTIVOS_PERDIDA)) return MOTIVOS_PERDIDA;
            if (typeof window !== 'undefined' && Array.isArray(window.MOTIVOS_PERDIDA)) return window.MOTIVOS_PERDIDA;
            return ["Precio", "Falta de seguimiento", "No se cumplían los requerimientos técnicos", "Tiempo de entrega", "Cliente desiste"];
        },
        hasEnteredPostclosing: (p) => {
            if (typeof global !== 'undefined' && typeof global.hasEnteredPostclosing === 'function') return global.hasEnteredPostclosing(p);
            if (typeof window !== 'undefined' && typeof window.hasEnteredPostclosing === 'function') return window.hasEnteredPostclosing(p);
            if (!p) return false;
            if (p.estado === 'ganado') return true;
            if (p.etapa === 'cierre' && p.datos && p.datos.aprobado_cierre) return true;
            return false;
        },
        saveListScrollPosition: (opts) => {
            if (typeof global !== 'undefined' && typeof global.saveListScrollPosition === 'function') return global.saveListScrollPosition(opts);
            if (typeof window !== 'undefined' && typeof window.saveListScrollPosition === 'function') return window.saveListScrollPosition(opts);
        },
        restoreListScrollPosition: (opts) => {
            if (typeof global !== 'undefined' && typeof global.restoreListScrollPosition === 'function') return global.restoreListScrollPosition(opts);
            if (typeof window !== 'undefined' && typeof window.restoreListScrollPosition === 'function') return window.restoreListScrollPosition(opts);
        },
        showView: (v, opts) => {
            if (typeof global !== 'undefined' && typeof global.showView === 'function') return global.showView(v, opts);
            if (typeof window !== 'undefined' && typeof window.showView === 'function') return window.showView(v, opts);
        },
        getLastViewedSection: () => {
            if (typeof AppRouter !== 'undefined' && typeof AppRouter.getLastViewedSection === 'function') return AppRouter.getLastViewedSection();
            if (typeof lastViewedSection !== 'undefined' && typeof lastViewedSection === 'string') return lastViewedSection;
            if (typeof window !== 'undefined' && typeof window.lastViewedSection === 'string') return window.lastViewedSection;
            if (typeof global !== 'undefined' && typeof global.lastViewedSection === 'string') return global.lastViewedSection;
            return 'list-view';
        },
        showLoading: (m) => {
            if (typeof global !== 'undefined' && typeof global.showLoading === 'function') return global.showLoading(m);
            if (typeof window !== 'undefined' && typeof window.showLoading === 'function') return window.showLoading(m);
        },
        hideLoading: () => {
            if (typeof global !== 'undefined' && typeof global.hideLoading === 'function') return global.hideLoading();
            if (typeof window !== 'undefined' && typeof window.hideLoading === 'function') return window.hideLoading();
        },
        formatDate: (d) => {
            if (typeof global !== 'undefined' && typeof global.formatDate === 'function') return global.formatDate(d);
            if (typeof window !== 'undefined' && typeof window.formatDate === 'function') return window.formatDate(d);
            return d ? String(d).slice(0, 10) : '-';
        },
        getDaysDifference: (d1) => {
            if (typeof global !== 'undefined' && typeof global.getDaysDifference === 'function') return global.getDaysDifference(d1);
            if (typeof window !== 'undefined' && typeof window.getDaysDifference === 'function') return window.getDaysDifference(d1);
            return Math.floor((new Date() - new Date(d1 || new Date())) / (1000 * 60 * 60 * 24));
        },
        getCrmWorkCalendar: () => {
            if (typeof CrmWorkCalendar !== 'undefined') return CrmWorkCalendar;
            if (typeof window !== 'undefined' && window.CrmWorkCalendar) return window.CrmWorkCalendar;
            return null;
        },
        getCrmFollowUpCalc: () => {
            if (typeof CrmFollowUpCalc !== 'undefined') return CrmFollowUpCalc;
            if (typeof window !== 'undefined' && window.CrmFollowUpCalc) return window.CrmFollowUpCalc;
            return null;
        },
        getCrmCommercial: () => {
            if (typeof CrmCommercial !== 'undefined') return CrmCommercial;
            if (typeof window !== 'undefined' && window.CrmCommercial) return window.CrmCommercial;
            return null;
        },
        getCrmUI: () => {
            if (typeof CrmUI !== 'undefined') return CrmUI;
            if (typeof window !== 'undefined' && window.CrmUI) return window.CrmUI;
            return null;
        },
        getFirebase: () => {
            if (typeof firebase !== 'undefined') return firebase;
            if (typeof window !== 'undefined' && window.firebase) return window.firebase;
            return null;
        },
        runWorkflowOp: (label, fn) => {
            if (typeof global !== 'undefined' && typeof global.runWorkflowOp === 'function') return global.runWorkflowOp(label, fn);
            if (typeof window !== 'undefined' && typeof window.runWorkflowOp === 'function') return window.runWorkflowOp(label, fn);
            const fb = _deps.getFirebase();
            const cm = _deps.getCrmCommercial();
            if (!cm || !cm.hasSessionSync(fb)) {
                const msg = (cm && cm.NO_SESSION_MESSAGE) ? cm.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.';
                _deps.alert(msg);
                return Promise.resolve(null);
            }
            _deps.showLoading(label);
            return fn(fb).catch(err => {
                if (err && String(err.code || '').startsWith('functions/')) _deps.alert(cm.errorMessage(err));
                else _deps.alert('No se pudo completar la operación: ' + ((err && err.message) || 'error desconocido'));
                console.error(err);
                return null;
            }).finally(() => {
                _deps.hideLoading();
            });
        },
        renderClientContactCard: (p) => {
            if (typeof global !== 'undefined' && typeof global.renderClientContactCard === 'function') return global.renderClientContactCard(p);
            if (typeof window !== 'undefined' && typeof window.renderClientContactCard === 'function') return window.renderClientContactCard(p);
        },
        renderOpportunityParticipants: (p) => {
            if (typeof global !== 'undefined' && typeof global.renderOpportunityParticipants === 'function') return global.renderOpportunityParticipants(p);
            if (typeof window !== 'undefined' && typeof window.renderOpportunityParticipants === 'function') return window.renderOpportunityParticipants(p);
        },
        renderFinancials: (p) => {
            if (typeof global !== 'undefined' && typeof global.renderFinancials === 'function') return global.renderFinancials(p);
            if (typeof window !== 'undefined' && typeof window.renderFinancials === 'function') return window.renderFinancials(p);
        },
        renderClientSelect: () => {
            if (typeof global !== 'undefined' && typeof global.renderClientSelect === 'function') return global.renderClientSelect();
            if (typeof window !== 'undefined' && typeof window.renderClientSelect === 'function') return window.renderClientSelect();
        },
        renderDailyAgenda: () => {
            if (typeof global !== 'undefined' && typeof global.renderDailyAgenda === 'function') return global.renderDailyAgenda();
            if (typeof window !== 'undefined' && typeof window.renderDailyAgenda === 'function') return window.renderDailyAgenda();
        },
        cancelPendingClientReservation: () => {
            if (typeof global !== 'undefined' && typeof global.cancelPendingClientReservation === 'function') return global.cancelPendingClientReservation();
            if (typeof window !== 'undefined' && typeof window.cancelPendingClientReservation === 'function') return window.cancelPendingClientReservation();
        },
        getProspectClient: (id) => {
            if (typeof global !== 'undefined' && typeof global.getProspectClient === 'function') return global.getProspectClient(id);
            if (typeof window !== 'undefined' && typeof window.getProspectClient === 'function') return window.getProspectClient(id);
            const cl = _deps.getClients();
            return (Array.isArray(cl) ? cl : []).find(c => c && c.id === id) || null;
        },
        normalizeWhatsAppNumber: (phone) => {
            if (typeof global !== 'undefined' && typeof global.normalizeWhatsAppNumber === 'function') return global.normalizeWhatsAppNumber(phone);
            if (typeof window !== 'undefined' && typeof window.normalizeWhatsAppNumber === 'function') return window.normalizeWhatsAppNumber(phone);
            if (typeof CrmFormatters !== 'undefined' && typeof CrmFormatters.normalizeWhatsAppNumber === 'function') return CrmFormatters.normalizeWhatsAppNumber(phone);
            return (phone || '').replace(/\D/g, '');
        },
        getDocStore: () => {
            if (typeof window !== 'undefined' && typeof window.getDocStore === 'function') return window.getDocStore();
            if (typeof global !== 'undefined' && typeof global.getDocStore === 'function') return global.getDocStore();
            if (typeof window !== 'undefined') {
                if (!window._docStore) window._docStore = new Map();
                return window._docStore;
            }
            if (typeof global !== 'undefined') {
                if (!global._docStore) global._docStore = new Map();
                return global._docStore;
            }
            return new Map();
        },
        uploadFileToStorage: (...args) => {
            if (typeof global !== 'undefined' && typeof global.uploadFileToStorage === 'function') return global.uploadFileToStorage(...args);
            if (typeof window !== 'undefined' && typeof window.uploadFileToStorage === 'function') return window.uploadFileToStorage(...args);
        },
        uploadClientDocumentFromClosing: (...args) => {
            if (typeof global !== 'undefined' && typeof global.uploadClientDocumentFromClosing === 'function') return global.uploadClientDocumentFromClosing(...args);
            if (typeof window !== 'undefined' && typeof window.uploadClientDocumentFromClosing === 'function') return window.uploadClientDocumentFromClosing(...args);
        },
        toggleClientDocSubstForm: (...args) => {
            if (typeof global !== 'undefined' && typeof global.toggleClientDocSubstForm === 'function') return global.toggleClientDocSubstForm(...args);
            if (typeof window !== 'undefined' && typeof window.toggleClientDocSubstForm === 'function') return window.toggleClientDocSubstForm(...args);
        },
        cancelClientDocSubstForm: (...args) => {
            if (typeof global !== 'undefined' && typeof global.cancelClientDocSubstForm === 'function') return global.cancelClientDocSubstForm(...args);
            if (typeof window !== 'undefined' && typeof window.cancelClientDocSubstForm === 'function') return window.cancelClientDocSubstForm(...args);
        },
        viewStoredClientDoc: (...args) => {
            if (typeof global !== 'undefined' && typeof global.viewStoredClientDoc === 'function') return global.viewStoredClientDoc(...args);
            if (typeof window !== 'undefined' && typeof window.viewStoredClientDoc === 'function') return window.viewStoredClientDoc(...args);
        },
        downloadStoredClientDoc: (...args) => {
            if (typeof global !== 'undefined' && typeof global.downloadStoredClientDoc === 'function') return global.downloadStoredClientDoc(...args);
            if (typeof window !== 'undefined' && typeof window.downloadStoredClientDoc === 'function') return window.downloadStoredClientDoc(...args);
        },
        viewSecureDocument: (...args) => {
            if (typeof global !== 'undefined' && typeof global.viewSecureDocument === 'function') return global.viewSecureDocument(...args);
            if (typeof window !== 'undefined' && typeof window.viewSecureDocument === 'function') return window.viewSecureDocument(...args);
        },
        downloadSecureDocument: (...args) => {
            if (typeof global !== 'undefined' && typeof global.downloadSecureDocument === 'function') return global.downloadSecureDocument(...args);
            if (typeof window !== 'undefined' && typeof window.downloadSecureDocument === 'function') return window.downloadSecureDocument(...args);
        },
        showDocumentVersionHistory: (...args) => {
            if (typeof global !== 'undefined' && typeof global.showDocumentVersionHistory === 'function') return global.showDocumentVersionHistory(...args);
            if (typeof window !== 'undefined' && typeof window.showDocumentVersionHistory === 'function') return window.showDocumentVersionHistory(...args);
        },
        resolveStoragePath: (...args) => {
            if (typeof global !== 'undefined' && typeof global.resolveStoragePath === 'function') return global.resolveStoragePath(...args);
            if (typeof window !== 'undefined' && typeof window.resolveStoragePath === 'function') return window.resolveStoragePath(...args);
            return null;
        },
        isFormatPreviewable: (...args) => {
            if (typeof global !== 'undefined' && typeof global.isFormatPreviewable === 'function') return global.isFormatPreviewable(...args);
            if (typeof window !== 'undefined' && typeof window.isFormatPreviewable === 'function') return window.isFormatPreviewable(...args);
            return false;
        },
        updateSelectedFilesList: (el) => {
            if (typeof global !== 'undefined' && typeof global.updateSelectedFilesList === 'function') return global.updateSelectedFilesList(el);
            if (typeof window !== 'undefined' && typeof window.updateSelectedFilesList === 'function') return window.updateSelectedFilesList(el);
        },
        renderStagedFiles: (id) => {
            if (typeof global !== 'undefined' && typeof global.renderStagedFiles === 'function') return global.renderStagedFiles(id);
            if (typeof window !== 'undefined' && typeof window.renderStagedFiles === 'function') return window.renderStagedFiles(id);
        },
        reassignVendor: (id) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.reassignVendor === 'function') return ctrl.reassignVendor(id);
            if (typeof global !== 'undefined' && typeof global.reassignVendor === 'function') return global.reassignVendor(id);
            if (typeof window !== 'undefined' && typeof window.reassignVendor === 'function') return window.reassignVendor(id);
        },
        deleteProspect: (...args) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.deleteProspect === 'function') return ctrl.deleteProspect(...args);
            if (typeof global !== 'undefined' && typeof global.deleteProspect === 'function') return global.deleteProspect(...args);
            if (typeof window !== 'undefined' && typeof window.deleteProspect === 'function') return window.deleteProspect(...args);
        },
        reactivateLostProspect: (...args) => {
            const ctrl = _deps.getOpportunitiesController();
            if (ctrl && typeof ctrl.reactivateLostProspect === 'function') return ctrl.reactivateLostProspect(...args);
            if (typeof global !== 'undefined' && typeof global.reactivateLostProspect === 'function') return global.reactivateLostProspect(...args);
            if (typeof window !== 'undefined' && typeof window.reactivateLostProspect === 'function') return window.reactivateLostProspect(...args);
        }
    };

    function initOpportunitiesUI(injectedDeps) {
        if (injectedDeps && typeof injectedDeps === 'object') {
            Object.assign(_deps, injectedDeps);
        }
        return OpportunitiesUI;
    }
    // Delegated dependency wrappers for unqualified calls within the module
    const getClientName = (...args) => _deps.getClientName(...args);
    const getProspectVendorInfo = (...args) => _deps.getProspectVendorInfo(...args);
    const updateOppSortIcons = (...args) => _deps.updateOppSortIcons(...args);
    const retryDataListeners = (...args) => _deps.retryDataListeners(...args);
    const saveListScrollPosition = (...args) => _deps.saveListScrollPosition(...args);
    const restoreListScrollPosition = (...args) => _deps.restoreListScrollPosition(...args);
    const showView = (...args) => _deps.showView(...args);
    const showLoading = (...args) => _deps.showLoading(...args);
    const hideLoading = (...args) => _deps.hideLoading(...args);
    const runWorkflowOp = (...args) => _deps.runWorkflowOp(...args);
    const renderClientContactCard = (...args) => _deps.renderClientContactCard(...args);
    const renderOpportunityParticipants = (...args) => _deps.renderOpportunityParticipants(...args);
    const renderFinancials = (...args) => _deps.renderFinancials(...args);
    const renderClientSelect = (...args) => _deps.renderClientSelect(...args);
    const renderDailyAgenda = (...args) => _deps.renderDailyAgenda(...args);
    const cancelPendingClientReservation = (...args) => _deps.cancelPendingClientReservation(...args);
    const getProspectClient = (...args) => _deps.getProspectClient(...args);
    const normalizeWhatsAppNumber = (...args) => _deps.normalizeWhatsAppNumber(...args);
    const getDocStore = (...args) => _deps.getDocStore(...args);
    const uploadFileToStorage = (...args) => _deps.uploadFileToStorage(...args);
    const uploadClientDocumentFromClosing = (...args) => _deps.uploadClientDocumentFromClosing(...args);
    const toggleClientDocSubstForm = (...args) => _deps.toggleClientDocSubstForm(...args);
    const cancelClientDocSubstForm = (...args) => _deps.cancelClientDocSubstForm(...args);
    const viewStoredClientDoc = (...args) => _deps.viewStoredClientDoc(...args);
    const downloadStoredClientDoc = (...args) => _deps.downloadStoredClientDoc(...args);
    const viewSecureDocument = (...args) => _deps.viewSecureDocument(...args);
    const downloadSecureDocument = (...args) => _deps.downloadSecureDocument(...args);
    const showDocumentVersionHistory = (...args) => _deps.showDocumentVersionHistory(...args);
    const resolveStoragePath = (...args) => _deps.resolveStoragePath(...args);
    const isFormatPreviewable = (...args) => _deps.isFormatPreviewable(...args);
    const updateSelectedFilesList = (...args) => _deps.updateSelectedFilesList(...args);
    const renderStagedFiles = (...args) => _deps.renderStagedFiles(...args);
    const reassignVendor = (...args) => _deps.reassignVendor(...args);
    const deleteProspect = (...args) => _deps.deleteProspect(...args);
    const reactivateLostProspect = (...args) => _deps.reactivateLostProspect(...args);
    const escapeHtmlDoc = (...args) => _deps.escapeHtmlDoc(...args);
    const formatCurrency = (...args) => _deps.formatCurrency(...args);
    const alert = (...args) => _deps.alert(...args);
    const confirm = (...args) => _deps.confirm(...args);
    const formatDate = (...args) => _deps.formatDate(...args);
    const getDaysDifference = (...args) => _deps.getDaysDifference(...args);
    const hasEnteredPostclosing = (...args) => _deps.hasEnteredPostclosing(...args);
    const parseProspectDate = (...args) => _deps.parseProspectDate(...args);
    const formatProspectDate = (...args) => _deps.formatProspectDate(...args);

    // -------------------------------------------------------------------------
    // 2. Renderizado del Pipeline y Listado (Subbloque 2A)
    // -------------------------------------------------------------------------
    function renderList(options) {
        const opts = (options && typeof options === 'object') ? options : {};
        const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;

        const tbody = doc.getElementById('opp-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const currentUser = (opts.currentUser !== undefined) ? opts.currentUser : _deps.getCurrentUser();
        const rawProspects = (opts.prospects !== undefined) ? opts.prospects : _deps.getProspects();
        let filtered = Array.isArray(rawProspects) ? rawProspects : [];

        // Regla de aislamiento por rol para Vendedor y Gestor
        if (currentUser && (currentUser.role === 'gestor' || currentUser.role === 'vendedor')) {
            filtered = filtered.filter(p => p && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id)));
        }

        // Las oportunidades ganadas pertenecen al módulo de Proyectos y Cobros
        const baseProspects = filtered.filter(p => p && p.estado !== 'ganado');

        // Actualizar contadores y clases de filtros en el DOM
        updateFilterBadges(baseProspects, doc, opts);

        // Obtener filtros actuales (permitiendo anulación por opciones en sandboxes)
        const statusFilter = (opts.oppStatusFilter !== undefined) ? opts.oppStatusFilter : _deps.getOppStatusFilter();
        const clasifFilter = (opts.oppClasifFilter !== undefined) ? opts.oppClasifFilter : _deps.getOppClasifFilter();
        const stageFilter = (opts.oppStageFilter !== undefined) ? opts.oppStageFilter : _deps.getOppStageFilter();
        const sortCol = (opts.oppSortCol !== undefined) ? opts.oppSortCol : _deps.getOppSortCol();
        const sortDir = (opts.oppSortDir !== undefined) ? opts.oppSortDir : _deps.getOppSortDir();

        const getClientNameFn = (opts && typeof opts.getClientName === 'function')
            ? opts.getClientName
            : (id => {
                if (opts && opts.clients && Array.isArray(opts.clients)) {
                    const c = opts.clients.find(x => x && x.id === id);
                    if (c) return c.empresa || c.nombres || id;
                }
                return _deps.getClientName(id);
            });

        const getProspectVendorInfoFn = (opts && typeof opts.getProspectVendorInfo === 'function')
            ? opts.getProspectVendorInfo
            : (p => {
                if (opts && opts.users && Array.isArray(opts.users)) {
                    if (!p) return { id: '', name: 'Sistema', role: '' };
                    let userId = p.vendedorId || p.createdBy;
                    let name = p.vendedorName || p.createdByName || p.creado_por || p.vendedor;
                    let role = p.vendedorRole || p.createdByRole || '';
                    if (userId) {
                        const u = opts.users.find(x => x && (x.id === userId || (x.authUid && x.authUid === userId)));
                        if (u) {
                            if (!name || name === 'Sin Asignar') name = u.nombre;
                            role = u.role || role;
                        }
                    }
                    if (!name || name === 'Sin Asignar') name = p.vendedorName || p.vendedor || 'Sin Asignar';
                    let roleText = '';
                    if (role === 'manager') roleText = 'Gerente';
                    else if (role === 'gestor') roleText = 'Gestor';
                    else if (role === 'vendedor') roleText = 'Vendedor';
                    else if (role === 'consultor') roleText = 'Consultor';
                    else roleText = role;
                    return { id: userId || '', name: name || 'Sin Asignar', role: roleText };
                }
                return _deps.getProspectVendorInfo(p);
            });

        const formatProspectDateFn = (opts && typeof opts.formatProspectDate === 'function') ? opts.formatProspectDate : _deps.formatProspectDate;
        const parseProspectDateFn = (opts && typeof opts.parseProspectDate === 'function') ? opts.parseProspectDate : _deps.parseProspectDate;
        const formatCurrencyFn = (opts && typeof opts.formatCurrency === 'function') ? opts.formatCurrency : _deps.formatCurrency;
        const escapeHtmlDocFn = (opts && typeof opts.escapeHtmlDoc === 'function') ? opts.escapeHtmlDoc : _deps.escapeHtmlDoc;

        const helpers = {
            getClientName: getClientNameFn,
            getProspectVendorInfo: getProspectVendorInfoFn,
            formatProspectDate: formatProspectDateFn,
            parseProspectDate: parseProspectDateFn,
            formatCurrency: formatCurrencyFn,
            escapeHtmlDoc: escapeHtmlDocFn
        };

        // 1. Filtro de Estado Comercial ('activas' excluye estrictamente perdidas)
        let visibleProspects = baseProspects;
        if (statusFilter === 'activas') {
            visibleProspects = baseProspects.filter(p => p.estado !== 'perdido');
        } else if (statusFilter === 'perdidas') {
            visibleProspects = baseProspects.filter(p => p.estado === 'perdido');
        } else if (statusFilter === 'todas') {
            visibleProspects = baseProspects;
        }

        // 2. Filtro de Clasificación Técnica ('ejecucion' | 'presupuesto')
        if (clasifFilter === 'ejecucion') {
            visibleProspects = visibleProspects.filter(p => (p.clasificacion || 'ejecucion') === 'ejecucion');
        } else if (clasifFilter === 'presupuesto') {
            visibleProspects = visibleProspects.filter(p => p.clasificacion === 'presupuesto');
        }

        // 3. Filtro de Etapa Comercial
        if (stageFilter && stageFilter !== 'todas') {
            visibleProspects = visibleProspects.filter(p => p.etapa === stageFilter);
        }

        // 4. Filtro de Búsqueda de Texto
        const searchEl = doc.getElementById('opp-search');
        const searchVal = (searchEl && typeof searchEl.value === 'string') ? searchEl.value.toLowerCase().trim() : '';
        if (searchVal) {
            visibleProspects = visibleProspects.filter(p => {
                const codeMatch = (p.codigo || '').toLowerCase().includes(searchVal) || (p.id && p.id.substring(p.id.length - 4).toLowerCase().includes(searchVal));
                const clientMatch = getClientNameFn(p.clientId).toLowerCase().includes(searchVal);
                const projectMatch = (p.proyecto || '').toLowerCase().includes(searchVal);
                const vendorInfo = getProspectVendorInfoFn(p);
                const vendorMatch = vendorInfo.name.toLowerCase().includes(searchVal) || vendorInfo.role.toLowerCase().includes(searchVal);
                const stageMatch = (p.etapa || '').toLowerCase().includes(searchVal);
                const amountMatch = p.precio_cotizado ? formatCurrencyFn(p.precio_cotizado).toLowerCase().includes(searchVal) || String(p.precio_cotizado).includes(searchVal) : false;
                const statusMatch = (p.estado || '').toLowerCase().includes(searchVal);
                const dateStr = formatProspectDateFn(p.fecha_creacion);
                const dateMatch = dateStr !== '-' && dateStr.toLowerCase().includes(searchVal);
                return codeMatch || clientMatch || projectMatch || vendorMatch || stageMatch || amountMatch || statusMatch || dateMatch;
            });
        }

        // 5. Filtro de Rango de Fechas (Fecha de Ingreso)
        const dateStartEl = doc.getElementById('opp-date-start');
        const dateEndEl = doc.getElementById('opp-date-end');
        const dateStartVal = (dateStartEl && typeof dateStartEl.value === 'string') ? dateStartEl.value : '';
        const dateEndVal = (dateEndEl && typeof dateEndEl.value === 'string') ? dateEndEl.value : '';
        const btnClearDates = doc.getElementById('btn-clear-opp-dates');
        if (btnClearDates) {
            btnClearDates.style.display = (dateStartVal || dateEndVal) ? 'inline-block' : 'none';
        }

        if (dateStartVal || dateEndVal) {
            let startTime = null;
            let endTime = null;
            if (dateStartVal) {
                const parts = dateStartVal.split('-').map(Number);
                startTime = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
            }
            if (dateEndVal) {
                const parts = dateEndVal.split('-').map(Number);
                endTime = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999).getTime();
            }

            visibleProspects = visibleProspects.filter(p => {
                const pDate = parseProspectDateFn(p.fecha_creacion);
                if (!pDate) return false;
                const pTime = pDate.getTime();
                if (startTime !== null && pTime < startTime) return false;
                if (endTime !== null && pTime > endTime) return false;
                return true;
            });
        }

        // Actualizar Badge de Cantidad Total Visible
        const countBadge = doc.getElementById('opp-count-badge');
        if (countBadge) {
            countBadge.textContent = `${visibleProspects.length} ${visibleProspects.length === 1 ? 'oportunidad' : 'oportunidades'}`;
        }

        // 6. Ordenamiento Multicriterio con Desempate Determinista
        if (sortCol) {
            visibleProspects.sort((a, b) => {
                if (sortCol === 'fecha') {
                    const dateA = parseProspectDateFn(a.fecha_creacion);
                    const dateB = parseProspectDateFn(b.fecha_creacion);
                    let dateDiff = 0;
                    if (dateA && dateB) {
                        dateDiff = sortDir === 'asc'
                            ? dateA.getTime() - dateB.getTime()
                            : dateB.getTime() - dateA.getTime();
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

                if (sortCol === 'codigo') {
                    valA = a.codigo || a.id.substring(a.id.length - 4);
                    valB = b.codigo || b.id.substring(b.id.length - 4);
                } else if (sortCol === 'cliente') {
                    valA = getClientNameFn(a.clientId);
                    valB = getClientNameFn(b.clientId);
                } else if (sortCol === 'proyecto') {
                    valA = a.proyecto || '';
                    valB = b.proyecto || '';
                } else if (sortCol === 'vendedor') {
                    valA = getProspectVendorInfoFn(a).name;
                    valB = getProspectVendorInfoFn(b).name;
                } else if (sortCol === 'etapa') {
                    valA = a.etapa || '';
                    valB = b.etapa || '';
                } else if (sortCol === 'monto') {
                    valA = parseFloat(a.precio_cotizado) || 0;
                    valB = parseFloat(b.precio_cotizado) || 0;
                } else if (sortCol === 'estado') {
                    valA = a.estado || '';
                    valB = b.estado || '';
                }

                let comp = 0;
                if (typeof valA === 'string') {
                    comp = sortDir === 'asc'
                        ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                        : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
                } else {
                    comp = sortDir === 'asc' ? valA - valB : valB - valA;
                }

                if (comp !== 0) return comp;
                // Desempate determinista
                const tieA = a.codigo || a.id || '';
                const tieB = b.codigo || b.id || '';
                return tieA.localeCompare(tieB, 'es', { sensitivity: 'base' });
            });
        } else {
            // Orden inicial predeterminado: Fecha de ingreso descendente (más reciente primero) con desempate determinista
            visibleProspects.sort((a, b) => {
                const dateA = parseProspectDateFn(a.fecha_creacion);
                const dateB = parseProspectDateFn(b.fecha_creacion);
                if (dateA && dateB) {
                    const diff = dateB.getTime() - dateA.getTime();
                    if (diff !== 0) return diff;
                } else if (dateA && !dateB) {
                    return -1;
                } else if (!dateA && dateB) {
                    return 1;
                }
                const tieA = a.codigo || a.id || '';
                const tieB = b.codigo || b.id || '';
                return tieB.localeCompare(tieA, 'es', { sensitivity: 'base' });
            });
        }

        // Renderizado de Estado Vacío
        if (visibleProspects.length === 0) {
            renderEmptyState(tbody, {
                statusFilter,
                doc,
                activeError: (opts && opts.activeError !== undefined) ? opts.activeError : undefined,
                isInitialLoaded: (opts && opts.initialLoadCompleted !== undefined) ? opts.initialLoadCompleted : undefined,
                prospects: rawProspects,
                escapeHtmlDoc: escapeHtmlDocFn
            });
            return;
        }

        // Renderizado de Filas de la Tabla
        const openDetailFn = opts.openDetail || _deps.openDetail;
        visibleProspects.forEach(p => {
            const tr = renderPipelineRow(p, doc, openDetailFn, helpers);
            if (tr) tbody.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------------
    // 3. Renderizado de Badges y Contadores de Filtros
    // -------------------------------------------------------------------------
    function updateFilterBadges(baseProspects, doc, options) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d) return;

        const opts = (options && typeof options === 'object') ? options : {};
        const list = Array.isArray(baseProspects) ? baseProspects : [];

        // Contadores de filtro de estado
        const countActivas = list.filter(p => p.estado !== 'perdido').length;
        const countPerdidas = list.filter(p => p.estado === 'perdido').length;
        const countTodas = list.length;

        const elActivas = d.getElementById('count-opp-activas');
        if (elActivas) elActivas.textContent = countActivas;
        const elPerdidas = d.getElementById('count-opp-perdidas');
        if (elPerdidas) elPerdidas.textContent = countPerdidas;
        const elTodas = d.getElementById('count-opp-todas');
        if (elTodas) elTodas.textContent = countTodas;

        const statusFilter = (opts.oppStatusFilter !== undefined) ? opts.oppStatusFilter : _deps.getOppStatusFilter();
        ['activas', 'perdidas', 'todas'].forEach(key => {
            const btn = d.getElementById(`filter-opp-${key}`);
            if (btn) {
                if (key === statusFilter) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });

        // Contadores de filtro de clasificación técnica
        const countEjecucion = list.filter(p => (p.clasificacion || 'ejecucion') === 'ejecucion').length;
        const countPresupuesto = list.filter(p => p.clasificacion === 'presupuesto').length;

        const elEjecucion = d.getElementById('count-opp-ejecucion');
        if (elEjecucion) elEjecucion.textContent = countEjecucion;
        const elPresupuesto = d.getElementById('count-opp-presupuesto');
        if (elPresupuesto) elPresupuesto.textContent = countPresupuesto;

        const clasifFilter = (opts.oppClasifFilter !== undefined) ? opts.oppClasifFilter : _deps.getOppClasifFilter();
        ['todas', 'ejecucion', 'presupuesto'].forEach(key => {
            const btn = d.getElementById(`filter-clasif-${key}`);
            if (btn) {
                if (key === clasifFilter) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });

        // Contadores de filtro de etapas comerciales
        const stageBase = (statusFilter === 'perdidas')
            ? list.filter(p => p.estado === 'perdido')
            : (statusFilter === 'todas' ? list : list.filter(p => p.estado !== 'perdido'));

        const PIPELINE_STAGES = _deps.getStages();

        PIPELINE_STAGES.forEach(key => {
            const el = d.getElementById(`count-stage-${key}`);
            if (el) el.textContent = stageBase.filter(p => p.etapa === key).length;
        });
        const elStageTodas = d.getElementById('count-stage-todas');
        if (elStageTodas) elStageTodas.textContent = stageBase.length;

        const stageFilter = (opts.oppStageFilter !== undefined) ? opts.oppStageFilter : _deps.getOppStageFilter();
        ['todas', ...PIPELINE_STAGES].forEach(key => {
            const btn = d.getElementById(`filter-stage-${key}`);
            if (btn) {
                if (key === stageFilter) {
                    btn.classList.add('active');
                    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', 'true');
                } else {
                    btn.classList.remove('active');
                    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', 'false');
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // 4. Renderizado de Fila Individual del Pipeline
    // -------------------------------------------------------------------------
    function renderPipelineRow(p, doc, openDetailFn, helpers) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d || !p) return null;

        const h = (helpers && typeof helpers === 'object') ? helpers : {};
        const getClientNameFn = h.getClientName || _deps.getClientName;
        const getProspectVendorInfoFn = h.getProspectVendorInfo || _deps.getProspectVendorInfo;
        const formatProspectDateFn = h.formatProspectDate || _deps.formatProspectDate;
        const parseProspectDateFn = h.parseProspectDate || _deps.parseProspectDate;
        const formatCurrencyFn = h.formatCurrency || _deps.formatCurrency;
        const escapeHtmlDocFn = h.escapeHtmlDoc || _deps.escapeHtmlDoc;

        const tr = d.createElement('tr');
        if (p && p.id && typeof tr.setAttribute === 'function') {
            tr.setAttribute('data-prospect-id', p.id);
        }
        tr.classList.add('cursor-pointer');
        tr.onclick = () => {
            if (typeof openDetailFn === 'function') openDetailFn(p.id);
            else _deps.openDetail(p.id);
        };

        const badgeClass = p.estado === 'activo' ? 'activo' : 'perdido';

        // Cálculo seguro de días en etapa usando parseProspectDate
        const rawStageDate = (p.stage_timestamps && p.stage_timestamps[p.etapa]) ? p.stage_timestamps[p.etapa] : p.fecha_creacion;
        const parsedStageDate = parseProspectDateFn(rawStageDate);
        let daysInStage = null;
        if (parsedStageDate) {
            const now = new Date();
            const diffMs = now.getTime() - parsedStageDate.getTime();
            if (!isNaN(diffMs) && diffMs >= 0) {
                daysInStage = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            }
        }

        const vendor = getProspectVendorInfoFn(p);
        const vendorBadge = vendor.role ? `<span style="font-size:0.75rem; color:var(--text-secondary); display:block;">(${vendor.role})</span>` : '';

        const isPresupuesto = p.clasificacion === 'presupuesto';
        const clasifBadge = isPresupuesto
            ? `<span class="badge" style="background: rgba(147, 51, 234, 0.15); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.35); font-size: 0.72rem; display: inline-flex; align-items: center; justify-content: center; gap: 3px; white-space: nowrap;" title="Cotización referencial para presupuesto">📐 Presupuesto</span>`
            : `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 0.72rem; display: inline-flex; align-items: center; justify-content: center; gap: 3px; white-space: nowrap;" title="Oferta para ejecución comercial">🏗️ Ejecución</span>`;

        // Formateo seguro de monto
        const rawPrice = (p.precio_cotizado !== null && p.precio_cotizado !== undefined && p.precio_cotizado !== '') ? Number(p.precio_cotizado) : NaN;
        const formattedAmount = (!isNaN(rawPrice) && isFinite(rawPrice) && rawPrice > 0)
            ? formatCurrencyFn(rawPrice)
            : '-';
        const amountDisplay = formattedAmount !== '-'
            ? `<strong class="opp-amount-val" style="color: var(--brand-gold); font-size: 0.92rem;">${formattedAmount}</strong>`
            : `<span style="color: var(--text-muted);">-</span>`;

        const stageColorMap = {
            'prospecto': 'background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3);',
            'levantamiento': 'background: rgba(56, 189, 248, 0.15); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.35);',
            'cotizacion': 'background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35);',
            'negociacion': 'background: rgba(168, 85, 247, 0.15); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.35);',
            'cierre': 'background: rgba(245, 158, 11, 0.15); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.35);'
        };
        const stageBadgeStyle = stageColorMap[p.etapa] || 'background: rgba(255, 255, 255, 0.1); color: var(--text-primary);';

        // Mostrar días en etapa si existe fecha válida (respetando SLA pausado de Presupuesto en Negociación)
        let daysDisplay = '';
        if (isPresupuesto && p.etapa === 'negociacion' && p.estado === 'activo') {
            const waitDays = (daysInStage !== null && !isNaN(daysInStage)) ? daysInStage : 0;
            daysDisplay = `<span class="opp-stage-days" style="color:#c084fc;" title="SLA operativo detenido en Negociación por clasificación Presupuesto (Espera presupuestaria: ${waitDays}d)">⏸️ Pausa</span>`;
        } else if (daysInStage !== null && !isNaN(daysInStage)) {
            const isHighAntiquity = (p.estado === 'activo') && (
                (p.etapa !== 'negociacion' && daysInStage >= 15) || 
                (p.etapa === 'cierre' && daysInStage >= 5) ||
                (p.etapa === 'prospecto' && daysInStage >= 5)
            );
            const warnClass = isHighAntiquity ? ' opp-stage-days-warn' : '';
            const warnTitle = isHighAntiquity ? `Antigüedad elevada en etapa: ${daysInStage} días` : `Tiempo en etapa: ${daysInStage} días`;
            daysDisplay = `<span class="opp-stage-days${warnClass}" title="${warnTitle}">${daysInStage}d</span>`;
        }

        const stageBadge = `<span class="badge opp-stage-pill" style="text-transform: capitalize; ${stageBadgeStyle}"><span class="opp-stage-name">${p.etapa || '-'}</span>${daysDisplay}</span>`;

        const codeVal = p.codigo || p.id.substring(p.id.length - 4);
        const clientVal = getClientNameFn(p.clientId);
        const projectName = escapeHtmlDocFn(p.proyecto || '-');

        tr.innerHTML = `<td class="col-opp-code"><span class="opp-code-badge" style="font-weight:600; color:var(--text-secondary);">${codeVal}</span></td><td class="col-opp-client"><strong>${clientVal}</strong></td><td class="col-opp-project"><div class="opp-project-wrap"><span class="opp-project-name" title="${projectName}">${projectName}</span><span class="opp-project-status-col">${clasifBadge}</span></div></td><td class="col-opp-vendor"><strong>${vendor.name}</strong>${vendorBadge}</td><td class="col-opp-date"><span class="opp-date-val">${formatProspectDateFn(p.fecha_creacion)}</span></td><td class="col-opp-stage">${stageBadge}</td><td class="col-opp-amount">${amountDisplay}</td><td class="col-opp-status"><span class="badge ${badgeClass}">${(p.estado || '').toUpperCase()}</span></td><td class="col-opp-action"><button type="button" class="btn-secondary btn-opp-view" style="padding: 0.25rem 0.55rem; font-size:0.75rem;" onclick="event.stopPropagation(); openDetail('${p.id}')">Ver</button></td>`;

        return tr;
    }

    // -------------------------------------------------------------------------
    // 5. Renderizado de Estados Vacíos
    // -------------------------------------------------------------------------
    function renderEmptyState(tbody, context) {
        if (!tbody) return;
        const ctx = (context && typeof context === 'object') ? context : {};
        const statusFilter = ctx.statusFilter || _deps.getOppStatusFilter();
        const activeError = (ctx.activeError !== undefined) ? ctx.activeError : _deps.getCrmLoadError();
        const isInitialLoaded = (ctx.isInitialLoaded !== undefined) ? ctx.isInitialLoaded : _deps.getInitialLoadCompleted();
        const rawProspects = (ctx.prospects !== undefined) ? ctx.prospects : _deps.getProspects();
        const esc = ctx.escapeHtmlDoc || _deps.escapeHtmlDoc;

        if (activeError) {
            tbody.innerHTML = `<tr><td colspan="9" style="padding: 2.5rem 1rem; text-align: center; border: none;">
                <div class="dash-empty-state-box" style="background: transparent; border: none; padding: 0;">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.85;">⚠️</div>
                    <div style="font-weight: 600; color: #f87171; font-size: 1rem; margin-bottom: 0.35rem;">Acceso a datos comerciales no disponible</div>
                    <div style="color: var(--text-secondary); font-size: 0.82rem; max-width: 440px; margin: auto; line-height: 1.4; margin-bottom: 1rem;">
                        No se pudo cargar la cartera (${esc(activeError.collection || 'comercial')}: ${esc(activeError.message || 'permiso denegado')}). Verifica que tu usuario esté activo y con el rol adecuado.
                    </div>
                    <button type="button" class="btn-primary" onclick="retryDataListeners()" style="padding: 6px 14px; font-size: 0.82rem;">
                        🔄 Reintentar conexión
                    </button>
                </div>
            </td></tr>`;
            return;
        }

        if (!isInitialLoaded && Array.isArray(rawProspects) && rawProspects.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="padding: 2.5rem 1rem; text-align: center; border: none;">
                <div class="dash-empty-state-box" style="background: transparent; border: none; padding: 0;">
                    <div style="display: inline-block; border: 3px solid rgba(255,255,255,0.2); border-top: 3px solid var(--brand-gold); border-radius: 50%; width: 28px; height: 28px; animation: spin 1s linear infinite; margin-bottom: 0.75rem;"></div>
                    <div style="font-weight: 600; color: white; font-size: 0.95rem;">Cargando oportunidades comerciales...</div>
                </div>
            </td></tr>`;
            return;
        }

        const emptyMsg = statusFilter === 'perdidas'
            ? 'No hay oportunidades marcadas como perdidas.'
            : 'No se encontraron oportunidades.';
        const emptySub = statusFilter === 'perdidas'
            ? 'No existen oportunidades marcadas con cierre no exitoso bajo los filtros seleccionados.'
            : 'Intenta modificar el término de búsqueda, el rango de fechas o los filtros de etapa y clasificación.';

        tbody.innerHTML = `<tr><td colspan="9" style="padding: 2.5rem 1rem; text-align: center; border: none;">
            <div class="dash-empty-state-box" style="background: transparent; border: none; padding: 0;">
                <div style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.85;">🔍</div>
                <div style="font-weight: 600; color: white; font-size: 1rem; margin-bottom: 0.35rem;">${emptyMsg}</div>
                <div style="color: var(--text-secondary); font-size: 0.82rem; max-width: 400px; margin: auto; line-height: 1.4;">${emptySub}</div>
            </div>
        </td></tr>`;
    }

    // -------------------------------------------------------------------------
    // 3. Detalle de Oportunidad y Navegación (Subbloque 2B)
    // -------------------------------------------------------------------------
    function goBackFromDetail(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const navCtx = (typeof AppRouter !== 'undefined' && typeof AppRouter.getNavigationContext === 'function')
        ? AppRouter.getNavigationContext()
        : null;
    let rawTarget = (navCtx && navCtx.originView)
        || (typeof _deps !== 'undefined' && typeof _deps.getLastViewedSection === 'function' ? _deps.getLastViewedSection() : null)
        || (typeof lastViewedSection !== 'undefined' ? lastViewedSection : 'list-view');
    if (rawTarget && typeof rawTarget === 'object' && typeof rawTarget.current === 'string') {
        rawTarget = rawTarget.current;
    }
    const targetSection = (typeof rawTarget === 'string' && rawTarget && rawTarget !== 'detail-view' && rawTarget !== 'client-detail-view' && !rawTarget.startsWith('b3-'))
        ? rawTarget
        : 'list-view';
    showView(targetSection, { fromPopstate: !!opts.fromPopstate, preserveListMode: true });
    restoreListScrollPosition({
        recordId: currentProspectId,
        recordType: 'prospect',
        targetSection,
        fromPopstate: !!opts.fromPopstate
    });
}


function openDetail(id, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const activeViewEl = (typeof document !== 'undefined' && typeof document.querySelector === 'function')
        ? document.querySelector('.view-section.active')
        : null;
    const isAlreadyInDetail = activeViewEl && activeViewEl.id === 'detail-view';
    currentProspectId = id;
    if (typeof _deps !== 'undefined' && typeof _deps.setCurrentProspectId === 'function') {
        _deps.setCurrentProspectId(id);
    }
    if (typeof window !== 'undefined') {
        window.currentProspectId = id;
        window.currentDetailId = id;
    }
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const prospectList = (typeof prospects !== 'undefined' && Array.isArray(prospects) && prospects.length > 0)
        ? prospects
        : _deps.getProspects();
    const p = prospectList.find(x => x && x.id === id);
    if (!p) return;
    const activeUser = currentUser || ((typeof window !== 'undefined') ? window.currentUser : null);
    if (currentUser && (currentUser.role === 'vendedor' || currentUser.role === 'gestor')) {
        const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);
        const inPostclosing = currentUser.role === 'gestor' && hasEnteredPostclosing(p);
        if (!isAssigned && !inPostclosing) {
            alert('No tienes acceso a esta oportunidad');
            showView('list-view');
            return;
        }
    } else if (activeUser && (activeUser.role === 'vendedor' || activeUser.role === 'gestor')) {
        const isAssigned = p.vendedorId === activeUser.id || (!p.vendedorId && p.createdBy === activeUser.id);
        const inPostclosing = activeUser.role === 'gestor' && hasEnteredPostclosing(p);
        if (!isAssigned && !inPostclosing) {
            alert('No tienes acceso a esta oportunidad');
            showView('list-view');
            return;
        }
    }
    if (!isAlreadyInDetail && !opts.skipSaveContext && typeof saveListScrollPosition === 'function') {
        saveListScrollPosition({
            recordId: id,
            recordType: 'prospect',
            filters: {
                status: _deps.getOppStatusFilter(),
                clasif: _deps.getOppClasifFilter(),
                stage: _deps.getOppStageFilter()
            },
            sort: {
                col: _deps.getOppSortCol(),
                dir: _deps.getOppSortDir()
            }
        });
    }
    showView('detail-view');
    const clientNameStr = getClientName(p.clientId);
    document.getElementById('detail-cliente').textContent = clientNameStr;
    document.getElementById('detail-proyecto').innerHTML = `${p.proyecto} <span class="badge bg-neutral ml-2">${p.codigo || ''}</span>`;

    // Sincronizar barra móvil pegajosa superior (Fase 5.2 Bloque 3)
    const stickyClient = document.getElementById('sticky-detail-client');
    if (stickyClient) stickyClient.textContent = clientNameStr;
    const stickyCode = document.getElementById('sticky-detail-code');
    if (stickyCode) stickyCode.textContent = p.codigo || (p.id ? p.id.slice(-4) : '-');
    const stickyBar = document.getElementById('detail-mobile-sticky-bar');
    if (stickyBar) {
        const stickyQuickAction = stickyBar.querySelector('.btn-sticky-quick-action');
        if (stickyQuickAction) {
            stickyQuickAction.style.display = (p.estado === 'activo') ? 'inline-flex' : 'none';
        }
    }

    document.getElementById('advance-form-container').innerHTML = '';
    const textEl = document.getElementById('new-log-text');
    if (textEl) textEl.value = '';

    const payForm = document.getElementById('payment-form'); if (payForm) payForm.style.display = 'none';
    const invForm = document.getElementById('invoice-form'); if (invForm) invForm.style.display = 'none';

    // Show Delete / Reactivate Prospect buttons for managers
    const btnDeleteProspect = document.getElementById('btn-delete-prospect');
    if (btnDeleteProspect) {
        btnDeleteProspect.style.display = (currentUser && currentUser.role === 'manager') ? 'inline-block' : 'none';
    }
    const btnReactivateProspect = document.getElementById('btn-reactivate-prospect');
    if (btnReactivateProspect) {
        btnReactivateProspect.style.display = (currentUser && currentUser.role === 'manager' && p.estado === 'perdido') ? 'inline-block' : 'none';
    }

    const actionContainer = document.getElementById('action-buttons-container');
    const finTracker = document.getElementById('financial-tracker-container');
    const stageTitleText = document.getElementById('stage-title-text');
    const stageWorkflowBox = document.getElementById('stage-workflow-box');

    const trackerContainer = document.getElementById('stage-tracker');

    if (p.estado === 'activo') {
        actionContainer.style.display = 'flex';
        finTracker.style.display = 'none';
        stageTitleText.parentElement.style.display = 'block';
        trackerContainer.style.display = 'flex';
        stageTitleText.textContent = p.etapa === 'cierre' ? "Cierre Pendiente de Documentación" : "Avance de Etapa";
        const btnAdv = document.getElementById('btn-advance');
        if (btnAdv) btnAdv.style.display = p.etapa === 'cierre' ? 'none' : 'inline-flex';
        const btnRevert = document.getElementById('btn-revert');
        if (btnRevert) btnRevert.style.display = (p.etapa !== 'prospecto') ? 'inline-flex' : 'none';
        const btnNewProp = document.getElementById('btn-new-proposal');
        if (btnNewProp) btnNewProp.style.display = p.etapa === 'negociacion' ? 'inline-flex' : 'none';
        const btnLose = document.getElementById('btn-lose');
        if (btnLose) btnLose.style.display = 'inline-flex';
        if (stageWorkflowBox) stageWorkflowBox.style.display = 'block';

        if (p.etapa === 'cierre' && typeof renderClosingDocumentationPanel === 'function') {
            renderClosingDocumentationPanel(p);
        }
    } else if (p.estado === 'ganado' || (hasEnteredPostclosing(p) && currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor'))) {
        actionContainer.style.display = 'none'; finTracker.style.display = 'block'; stageTitleText.parentElement.style.display = 'none'; trackerContainer.style.display = 'none'; if (stageWorkflowBox) stageWorkflowBox.style.display = 'none'; renderFinancials(p);
    } else {
        actionContainer.style.display = 'none'; finTracker.style.display = 'none'; stageTitleText.parentElement.style.display = 'block'; trackerContainer.style.display = 'flex'; stageTitleText.textContent = "Línea de Tiempo";
        if (stageWorkflowBox) stageWorkflowBox.style.display = 'block';
    }

    const ts = (p.stage_timestamps && typeof p.stage_timestamps === 'object') ? p.stage_timestamps : {};
    const stageStart = (p.etapa === 'cierre' ? (p.fecha_inicio_cierre || ts.cierre) : ts[p.etapa])
        || (p.stage_transitions && Array.isArray(p.stage_transitions) && p.stage_transitions.length > 0
            ? (p.stage_transitions.slice().reverse().find(t => t && t.to === p.etapa) || {}).fecha
            : null)
        || (p.etapa === 'prospecto' ? (ts.prospecto || p.fecha_creacion) : null)
        || p.fecha_creacion;

    const calendarDays = stageStart ? getDaysDifference(stageStart) : 0;
    const workCal = typeof CrmWorkCalendar !== 'undefined' ? CrmWorkCalendar : null;
    let businessDays = 0;
    if (workCal && typeof workCal.getWorkTimeBetween === 'function' && stageStart) {
        businessDays = Math.floor(workCal.getWorkTimeBetween(stageStart, new Date(), { excludeSaturday: true }));
    } else {
        businessDays = calendarDays;
    }

    const slaInfo = (typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.calculateStageSla === 'function')
        ? CrmFollowUpCalc.calculateStageSla(p, new Date())
        : null;

    const timeInStageEl = document.getElementById('detail-time-in-stage');
    if (timeInStageEl) {
        if (slaInfo && slaInfo.slaPaused) {
            const waitDays = typeof slaInfo.tiempoEsperaPresupuestoDias === 'number' ? slaInfo.tiempoEsperaPresupuestoDias : calendarDays;
            timeInStageEl.textContent = `Tiempo operativo en etapa: 0 días hábiles (⏸️ SLA detenido en Negociación · Espera presupuestaria: ${waitDays} días naturales)`;
        } else {
            timeInStageEl.textContent = `Tiempo en etapa: ${businessDays} días hábiles (${calendarDays} días naturales)`;
        }
    }

    const lastContactEl = document.getElementById('detail-last-contact');
    if (lastContactEl) {
        const ultFecha = (p.seguimiento && p.seguimiento.ultimo_contacto && p.seguimiento.ultimo_contacto.fecha) ? p.seguimiento.ultimo_contacto.fecha : null;
        if (!ultFecha) {
            lastContactEl.innerHTML = 'Último contacto: <span style="color:var(--text-muted); font-style:italic;">Sin contacto registrado</span>';
        } else {
            const daysSince = getDaysDifference(ultFecha);
            const dateStr = formatDate(ultFecha);
            const daysLabel = daysSince === 1 ? 'hace 1 día' : `hace ${daysSince} días`;
            lastContactEl.innerHTML = `Último contacto: <strong style="color:white;">${daysLabel}</strong> <span style="color:var(--text-muted); font-size:0.7rem;">(${dateStr})</span>`;
        }
    }
    renderClientContactCard(p);
    renderOpportunityParticipants(p);
    renderTracker(p); renderInfo(p); renderLogs(p);
    renderFollowUpSummary(p);
}


    // -------------------------------------------------------------------------
    // 4. Tracker de Etapas, Información y Documentos (Subbloque 2C)
    // -------------------------------------------------------------------------
    function renderTracker(p) {
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const STAGES = _deps.getStages();
    const tracker = document.getElementById('stage-tracker'); tracker.innerHTML = ''; const currentIndex = STAGES.indexOf(p.etapa);
    STAGES.forEach((stage, index) => {
        let statusClass = '';
        if (p.estado === 'perdido' && index <= currentIndex) statusClass = 'completed';
        else if (p.estado !== 'perdido') { if (index < currentIndex) statusClass = 'completed'; if (index === currentIndex) statusClass = 'current'; if (p.estado === 'ganado' && stage === 'cierre') statusClass = 'completed'; }
        tracker.innerHTML += `<div class="stage-step ${statusClass}"><div class="stage-circle">${index + 1}</div><div class="stage-label">${stage}</div></div>`;
    });
    const isPresupuesto = p.clasificacion === 'presupuesto';
    const clasifBadge = isPresupuesto
        ? `<span class="badge" style="background: rgba(147, 51, 234, 0.2); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.45); font-size: 0.75rem; margin-left: 8px;">📐 Cotización para Presupuesto</span>`
        : `<span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.45); font-size: 0.75rem; margin-left: 8px;">🏗️ Oferta para Ejecución</span>`;

    const isAssigned = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const canReclassify = p.estado === 'activo' && !!currentUser && (currentUser.role === 'manager' || isAssigned);
    const reclassBtn = canReclassify
        ? `<button type="button" class="btn-secondary" onclick="openReclassifyModal('${p.id}')" style="padding: 2px 8px; font-size: 0.72rem; margin-left: 8px;" title="Cambiar clasificación comercial">🔄 Clasificación</button>`
        : '';

    const cierreDocBadge = (p.etapa === 'cierre' && p.estado === 'activo')
        ? `<span class="badge" style="background: rgba(212, 175, 55, 0.2); color: var(--brand-gold); border: 1px solid var(--brand-gold); margin-left: 8px;">PENDIENTE DE DOCUMENTACIÓN</span>`
        : '';

    document.getElementById('detail-badges').innerHTML = `<span class="badge ${p.estado === 'activo' ? 'activo' : (p.estado === 'ganado' ? 'ganado' : 'perdido')}">${(p.estado || 'activo').toUpperCase()}</span>${cierreDocBadge}${clasifBadge}${reclassBtn}`;
}

function renderInfo(p) {
    if (!p) return;
    if (!p.datos) p.datos = {};
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));

    const vendor = getProspectVendorInfo(p);
    const daysTotal = getDaysDifference(p.fecha_creacion);
    const dateFormatted = formatProspectDate(p.fecha_creacion);

    const isAssignedBase = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const isEditableStage = p.etapa === 'cotizacion' || p.etapa === 'negociacion';
    const canEditBase = !!currentUser && (currentUser.role === 'manager' || isAssignedBase || (currentUser.role === 'gestor' && (p.vendedorId === currentUser.id || p.createdBy === currentUser.id))) && p.estado === 'activo' && isEditableStage;
    const editBaseLink = canEditBase ? ` <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold); text-decoration:underline;" onclick="openEditBasePriceModal()">[Editar Costo/Precio]</span>` : '';

    // 1. Resumen Comercial / KPI Hero (Prioridad 2)
    const heroEtapa = document.getElementById('hero-etapa');
    if (heroEtapa) heroEtapa.textContent = p.etapa || '-';

    const heroVendedor = document.getElementById('hero-vendedor');
    if (heroVendedor) {
        heroVendedor.innerHTML = `<span>${vendor.name}</span> ${vendor.role ? `<span style="font-size:0.75rem; color:var(--text-secondary); font-weight:normal;">(${vendor.role})</span>` : ''}`;
    }
    const heroVendedorAction = document.getElementById('hero-vendedor-action');
    if (heroVendedorAction) {
        if (currentUser && currentUser.role === 'manager' && !hasEnteredPostclosing(p) && p.etapa !== 'cierre') {
            heroVendedorAction.innerHTML = `<span class="cursor-pointer" style="color:var(--brand-gold); text-decoration:underline;" onclick="reassignVendor('${p.id}')">🔄 Reasignar vendedor</span>`;
        } else {
            heroVendedorAction.innerHTML = '';
        }
    }

    const heroFecha = document.getElementById('hero-fecha');
    if (heroFecha) heroFecha.textContent = dateFormatted;

    const heroAntiguedad = document.getElementById('hero-antiguedad');
    if (heroAntiguedad) {
        heroAntiguedad.textContent = `${daysTotal} ${daysTotal === 1 ? 'día' : 'días'} desde ingreso`;
    }

    const heroPrecio = document.getElementById('hero-precio');
    if (heroPrecio) heroPrecio.textContent = p.precio_cotizado ? formatCurrency(p.precio_cotizado) : '-';

    const heroPrecioAction = document.getElementById('hero-precio-action');
    if (heroPrecioAction) heroPrecioAction.innerHTML = editBaseLink;

    const heroCosto = document.getElementById('hero-costo');
    if (heroCosto) heroCosto.textContent = p.costo_venta ? formatCurrency(p.costo_venta) : '-';

    const heroMargen = document.getElementById('hero-margen');
    if (heroMargen) {
        const numPrecio = parseFloat(p.precio_cotizado) || 0;
        const numCosto = parseFloat(p.costo_venta) || 0;
        if (numPrecio > 0) {
            const margenVal = numPrecio - numCosto;
            const margenPct = Math.round((margenVal / numPrecio) * 100);
            const margenColor = margenVal >= 0 ? 'var(--success)' : 'var(--danger)';
            heroMargen.style.color = margenColor;
            heroMargen.textContent = `Margen: ${formatCurrency(margenVal)} (${margenPct}%)`;
        } else {
            heroMargen.textContent = 'Margen: -';
        }
    }

    // 2. Información Complementaria en lista (Prioridad 4 - Especificaciones Técnicas y Operativas)
    const list = document.getElementById('info-list');
    if (list) {
        list.innerHTML = `<li><strong>Origen:</strong> ${escapeHtmlDoc(p.origen || '-')}</li><li><strong>Tipo Proy:</strong> ${escapeHtmlDoc(p.tipo_proyecto || '-')}</li><li><strong>Producto:</strong> ${escapeHtmlDoc(p.tipo_producto || '-')}</li>`;

        if (typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.calculateStageSla === 'function' && p.estado === 'activo') {
            const slaSummary = CrmFollowUpCalc.calculateStageSla(p, new Date());
            if (slaSummary && slaSummary.inSla) {
                const estadoSlaBadge = slaSummary.slaPaused
                    ? `<span class="badge" style="background:rgba(147,51,234,0.2); color:#c084fc; border:1px solid rgba(147,51,234,0.45); font-size:0.72rem;">⏸️ Pausado en Negociación (Presupuesto)</span>`
                    : (slaSummary.isOverdue
                        ? `<span class="badge" style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid rgba(239,68,68,0.45); font-size:0.72rem;">🚨 Vencido (+${slaSummary.diasAtraso}d hábiles)</span>`
                        : `<span class="badge" style="background:rgba(16,185,129,0.2); color:#6ee7b7; border:1px solid rgba(16,185,129,0.45); font-size:0.72rem;">✔️ Al día</span>`);
                list.innerHTML += `<li style="font-size:0.78rem; color:var(--text-secondary); background:rgba(255,255,255,0.03); padding:6px 8px; border-radius:4px; margin-top:4px; line-height:1.45;">
                    <div><strong>⏱️ Estado SLA Operativo:</strong> ${estadoSlaBadge}</div>
                    <div style="margin-top:3px;">• <strong>Antigüedad total:</strong> ${slaSummary.antiguedadTotalDias ?? daysTotal} días calendario (${slaSummary.antiguedadTotalDiasHabiles ?? 0}d hábiles)</div>
                    <div>• <strong>Tiempo operativo DUCTSAL:</strong> ${slaSummary.tiempoOperativoDias ?? slaSummary.elapsedBusinessDays ?? 0} días hábiles</div>
                    ${(p.clasificacion === 'presupuesto' || (slaSummary.tiempoEsperaPresupuestoDias || 0) > 0) ? `<div>• <strong>Espera presupuestaria / decisión cliente:</strong> ${slaSummary.tiempoEsperaPresupuestoDias || 0} días calendario${slaSummary.slaPausadoEn ? ` (detenido desde ${escapeHtmlDoc(String(slaSummary.slaPausadoEn).slice(0, 10))})` : ''}</div>` : ''}
                </li>`;
            }
        }

        if (Array.isArray(p.historial_clasificacion) && p.historial_clasificacion.length > 0) {
            const lastChg = p.historial_clasificacion[p.historial_clasificacion.length - 1];
            list.innerHTML += `<li style="font-size:0.75rem; color:var(--text-secondary); background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px; margin-top:4px;">
                🔄 <strong>Último cambio de clasificación:</strong> ${escapeHtmlDoc(lastChg.fecha ? lastChg.fecha.slice(0, 16).replace('T', ' ') : '-')} por ${escapeHtmlDoc(lastChg.usuarioNombre || 'Usuario')} (Motivo: "${escapeHtmlDoc(lastChg.motivo || '-')}")
            </li>`;
        }

        if (p.datos && p.datos.ubicacion) {
            list.innerHTML += `<li><span class="label">Ubicación:</span> ${escapeHtmlDoc(p.datos.ubicacion)}</li>`;
            if (p.datos.distancia) list.innerHTML += `<li><span class="label">Distancia a fábrica:</span> ${escapeHtmlDoc(p.datos.distancia)} km</li>`;
        }
        if (p.datos && p.datos.visitante) list.innerHTML += `<li><strong>Visitó:</strong> ${escapeHtmlDoc(p.datos.visitante)} (${escapeHtmlDoc(p.datos.fecha_visita || 'Sin fecha')})</li>`;
        if (p.datos && p.datos.fecha_inicio) list.innerHTML += `<li><strong>Est. Inicio:</strong> ${escapeHtmlDoc(p.datos.fecha_inicio)}</li>`;
        if (p.probabilidad) list.innerHTML += `<li><strong>Probabilidad:</strong> ${escapeHtmlDoc(p.probabilidad)}%</li>`;

        const isBigInstalacionInfo = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));
        if (isBigInstalacionInfo && p.estado === 'activo' && p.etapa === 'cierre') {
            const isAuthorized = p.datos && p.datos.autorizado_sin_contrato === true;
            if (isAuthorized) {
                list.innerHTML += `<li><strong style="color: var(--success)">✔️ Cierre Sin Contrato Autorizado</strong> (por ${escapeHtmlDoc(p.datos.autorizado_por || 'Gerente')})</li>`;
            } else {
                list.innerHTML += `<li><strong style="color: var(--danger)">⚠️ Requiere Contrato o Autorización en Cierre (> $10k)</strong></li>`;
            }
        }

        if (p.estado === 'ganado') {
            list.innerHTML += `<li><strong style="color:var(--brand-gold)">Forma de Pago:</strong> ${escapeHtmlDoc(p.forma_pago || '-')}</li>`;
            if (p.encargado) list.innerHTML += `<li><strong style="color:var(--brand-gold)">Encargado Inst.:</strong> ${escapeHtmlDoc(p.encargado)}</li>`;
        }
        if (p.estado === 'perdido') list.innerHTML += `<li><strong style="color:var(--danger)">Motivo Pérdida:</strong> ${escapeHtmlDoc(p.motivo_perdida || '-')}</li>`;
    }

    // 3. Documentos Adjuntos (Prioridad 5)
    const docsList = document.getElementById('docs-list');
    if (!docsList) return;
    docsList.innerHTML = '';
    let hasDocs = false;
    let docCount = 0;

    function dlCard(doc, category, docKey = null) {
        if (!doc) return '';
        let name = typeof doc === 'object' ? (doc.name || 'Documento') : doc;
        let id = 'doc_' + Math.random().toString(36).substring(2, 9);
        if (typeof window !== 'undefined') {
            if (!window._docStore) window._docStore = new Map();
            window._docStore.set(id, doc);
        }
        const hasStorageRef = !!resolveStoragePath(doc);
        const previewable = hasStorageRef && isFormatPreviewable(name);
        const pId = (p && p.id) ? p.id : '';
        const ext = String(name || '').split('.').pop().toUpperCase() || 'DOC';
        let icon = '📁';
        if (ext === 'PDF') icon = '📄';
        else if (ext === 'XLSX' || ext === 'XLS') icon = '📊';
        else if (['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].includes(ext)) icon = '🖼️';

        const histBtn = docKey
            ? `<a href="javascript:void(0)" onclick="showDocumentVersionHistory('prospect', '${pId}', '${docKey}', '${escapeHtmlDoc(category)}')" class="btn-doc-dl" style="color:var(--brand-gold); margin-left:4px;" title="Ver historial de versiones">📜 Historial</a>`
            : '';

        let actionsHtml = '';
        if (hasStorageRef) {
            const viewBtn = previewable
                ? `<a href="javascript:void(0)" onclick="viewSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" class="btn-doc-view" title="Previsualizar en visor">👁️ Ver</a>`
                : '';
            const dlBtn = `<a href="javascript:void(0)" onclick="downloadSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" class="btn-doc-dl" title="Descargar archivo">⬇️ Descargar</a>`;
            actionsHtml = `${viewBtn}${dlBtn}${histBtn}`;
        } else {
            actionsHtml = `<span style="font-size:0.75rem; color:var(--text-muted); font-style:italic; margin-right:4px;">(Registro histórico)</span>${histBtn}`;
        }

        return `<li class="doc-card-row">` +
               `<div class="doc-card-info">` +
               `<span class="doc-card-category">${escapeHtmlDoc(category)}</span>` +
               `<span class="doc-card-name" title="${escapeHtmlDoc(name)}">${icon} ${escapeHtmlDoc(name)}</span>` +
               `</div>` +
               `<div class="doc-card-actions">` +
               actionsHtml +
               `</div>` +
               `</li>`;
    }

    function addDoc(field, category, docKey = null) {
        if (!field) return;
        if (Array.isArray(field)) {
            field.forEach(d => {
                if (d) {
                    docsList.innerHTML += dlCard(d, category, docKey);
                    docCount++;
                    hasDocs = true;
                }
            });
        } else {
            docsList.innerHTML += dlCard(field, category, docKey);
            docCount++;
            hasDocs = true;
        }
    }

    addDoc(p.datos.doc_levantamiento, 'Planos / Notas', 'doc_levantamiento');
    const isOfferDraft = (p.datos && p.datos.estado_propuesta === 'borrador') || p.etapa === 'cotizacion';
    const ofertaLabel = isOfferDraft ? 'Oferta / Cotización (Borrador)' : 'Oferta / Cotización';
    const costosLabel = isOfferDraft ? 'Cuadro de Costos (Borrador)' : 'Cuadro de Costos';
    addDoc(p.datos.doc_oferta, ofertaLabel, 'doc_oferta');
    addDoc(p.datos.doc_costos, costosLabel, 'doc_costos');
    addDoc(p.datos.doc_oferta_firmada || p.datos.doc_firmado, 'Oferta Firmada', 'doc_oferta_firmada');
    addDoc(p.datos.doc_contrato, 'Contrato', 'doc_contrato');
    if (p.datos.doc_comprobante) {
        addDoc(p.datos.doc_comprobante, 'Comprobante Anticipo', 'doc_comprobante');
    }
    if (p.datos.oferta_sustento_cierre) {
        addDoc(p.datos.oferta_sustento_cierre, 'Oferta Sustento de Cierre (Definitiva)', 'doc_oferta');
    }

    if (p.facturas && p.facturas.length > 0) {
        p.facturas.forEach(f => {
            if (f.doc_factura) {
                addDoc(f.doc_factura, `Factura ${f.numero || ''}`);
            }
        });
    }

    const docsBadge = document.getElementById('docs-count-badge');
    if (docsBadge) {
        docsBadge.textContent = `${docCount} ${docCount === 1 ? 'doc' : 'docs'}`;
    }

    if (!hasDocs) {
        docsList.innerHTML = `<li style="color:var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">No hay documentos adjuntos.</li>`;
    }
}


// Manager-only decision resolved by setNoContractAuthorizationAdmin on the server (which marks who/when from the session,
// creates an audit row, and rejects non-manager callers).
async function applyNoContractAuthorization(checked) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return false;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        return false;
    }
    showLoading('Guardando autorización...');
    try {
        const res = await CrmCommercial.setNoContractAuthorization(fb, { prospectId: p.id, authorized: !!checked, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        if (!p.datos) p.datos = {};
        p.datos.autorizado_sin_contrato = !!checked;
        if (checked) p.datos.autorizado_por = (res && res.autorizado_por) || p.datos.autorizado_por; else delete p.datos.autorizado_por;
        return true;
    } catch (e) {
        alert(CrmCommercial.errorMessage(e));
        return false;
    } finally {
        hideLoading();
    }
}

// window.toggleManagerApproval =
const toggleManagerApproval = async function (checked) {
    if (await applyNoContractAuthorization(checked)) openDetail(currentProspectId);
    else { const p = prospects.find(x => x.id === currentProspectId); if (p) openDetail(p.id); }
};
if (typeof window !== 'undefined') window.toggleManagerApproval = toggleManagerApproval;

const toggleManagerApprovalInForm = async function (checked) {
    if (await applyNoContractAuthorization(checked)) { openDetail(currentProspectId); showAdvanceForm(); }
    else { const p = prospects.find(x => x.id === currentProspectId); if (p) { openDetail(p.id); showAdvanceForm(); } }
};
if (typeof window !== 'undefined') window.toggleManagerApprovalInForm = toggleManagerApprovalInForm;

// window.applyManagerBypass

// Request / resolve flow for the exception (state kept on the opportunity: `solicitudes_sin_contrato`). Everything here is only the
// presentation and the call: who asks / resolves, the dates and the authorization fields are set by the server from the session, and
// the server refuses a manager's own request being resolved by him, a repeated approval and any non-manager resolution.
const escapeHtmlText = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function noContractRequestsOf(p) { return Array.isArray(p && p.solicitudes_sin_contrato) ? p.solicitudes_sin_contrato.filter(Boolean) : []; }
function renderNoContractRequestHTML(p) {
    const user = (typeof currentUser !== 'undefined' ? currentUser : null) || ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const reqs = noContractRequestsOf(p);
    const pending = reqs.find(r => r.estado === 'pendiente');
    const last = reqs.length ? reqs[reqs.length - 1] : null;
    const isManager = !!user && user.role === 'manager';
    const canAsk = !!user && (user.role === 'vendedor' || user.role === 'gestor');
    let html = '<div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px; font-size: 0.8rem; color: var(--text-secondary);">';
    if (pending) {
        html += `<div>\u23F3 <strong>Solicitud de autorización sin contrato pendiente</strong> de ${escapeHtmlText(pending.solicitante_nombre || pending.solicitante_id)} (${formatDate(pending.fecha_solicitud)}).<br>Motivo: ${escapeHtmlText(pending.motivo)}</div>`;
        if (isManager) {
            html += `<div style="margin-top:6px;"><button type="button" class="btn-primary" style="padding:4px 8px; font-size:0.75rem;" onclick="resolveNoContractRequest('${escapeHtmlText(pending.id)}','approve')">Aprobar</button> <button type="button" class="btn-danger" style="padding:4px 8px; font-size:0.75rem; margin-left:4px;" onclick="resolveNoContractRequest('${escapeHtmlText(pending.id)}','reject')">Rechazar</button></div>`;
        }
    } else {
        if (last && last.estado === 'rechazada') {
            html += `<div style="color: var(--danger);">\u274C Última solicitud rechazada por ${escapeHtmlText(last.resuelto_por || 'el gerente')} (${formatDate(last.fecha_resolucion)}). Motivo: ${escapeHtmlText(last.motivo_decision)}</div>`;
        }
        if (canAsk) {
            html += `<div style="margin-top:6px;">Esta autorización solo la concede un gerente desde su propia sesión. Puedes pedírsela con el motivo:<br><button type="button" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem; margin-top:4px;" onclick="requestNoContractAuthorization()">Solicitar autorización sin contrato</button></div>`;
        } else if (!isManager) {
            html += '<div>La autorización sin contrato solo puede otorgarla un gerente desde su propia sesión.</div>';
        }
    }
    return html + '</div>';
}

const requestNoContractAuthorization = async function () {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const motivo = String(prompt('Indica el motivo por el que esta venta debe cerrarse sin contrato (se enviará al gerente):') || '').trim();
    if (!motivo) return alert('La solicitud requiere un motivo. No se envió nada.');
    const res = await runWorkflowOp('Enviando solicitud...', fb => CrmCommercial.requestNoContractAuthorization(fb, { prospectId: p.id, motivo, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) }));
    if (!res) return;
    alert(res.status === 'unchanged' ? 'La solicitud ya estaba registrada y sigue pendiente.' : 'Solicitud enviada al gerente.');
    openDetail(p.id);
};
if (typeof window !== 'undefined') window.requestNoContractAuthorization = requestNoContractAuthorization;

const resolveNoContractRequest = async function (requestId, decision) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || (decision !== 'approve' && decision !== 'reject')) return;
    let motivoDecision = '';
    if (decision === 'reject') {
        motivoDecision = String(prompt('Indica el motivo del rechazo (obligatorio):') || '').trim();
        if (!motivoDecision) return alert('El rechazo requiere un motivo. No se resolvió la solicitud.');
    } else {
        if (!confirm('¿Aprobar el cierre de esta venta sin contrato?')) return;
        motivoDecision = String(prompt('Comentario de la aprobación (opcional):') || '').trim();
    }
    const res = await runWorkflowOp('Resolviendo solicitud...', fb => CrmCommercial.resolveNoContractAuthorization(fb, { prospectId: p.id, requestId, decision, motivoDecision, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) }));
    if (!res) return;
    openDetail(p.id);
};
if (typeof window !== 'undefined') window.resolveNoContractRequest = resolveNoContractRequest;


    // -------------------------------------------------------------------------
    // 5. Logs Comerciales y Bitácora (Subbloque 2C)
    // -------------------------------------------------------------------------
    function renderLogs(p) {
    const cont = document.getElementById('logs-container');
    if (!cont) return;
    cont.innerHTML = '';
    if (!p || !p.logs || !Array.isArray(p.logs)) return;

    // Clonamos el array para no mutarlo al hacer reverse
    const safeLogs = JSON.parse(JSON.stringify(p.logs));
    const origLen = p.logs.length;
    safeLogs.reverse().forEach((l, i) => {
        const realIdx = origLen - 1 - i;

        let deleteBtn = '';
        if (l.auto !== true && l.auto !== 'true') {
            deleteBtn = `<span class="cursor-pointer" style="margin-left:10px; font-size:0.75rem; color:var(--danger); font-weight:bold; text-decoration:underline;" onclick="deleteLog('${p.id}', ${realIdx})">[X Eliminar]</span>`;
        }

        cont.innerHTML += `<div class="log-item ${l.auto ? 'auto' : ''}">
            <span class="date">${formatDate(l.date)}</span>${l.text}
            ${deleteBtn}
        </div>`;
    });
}

function deleteLog(prospectId, idx) {
    let pObj = prospects.find(x => x.id === prospectId);
    if (!pObj || !pObj.logs) return;
    const entry = pObj.logs[idx];
    if (!entry) return;

    const doDelete = () => {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
            const noSessionMsg = typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.';
            if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(noSessionMsg);
            else if (typeof alert === 'function') alert(noSessionMsg);
            return;
        }

        // The server identifies the note by date + text (not by array position, which can be stale) and authorizes the author/role.
        return CrmCommercial.deleteLog(fb, { prospectId, date: entry.date, text: entry.text, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) }).then(res => {
            if (res && (res.status === 'deleted' || res.status === 'absent')) {
                const at = pObj.logs.findIndex(l => l && l.date === entry.date && l.text === entry.text);
                if (at !== -1) pObj.logs.splice(at, 1);
            }
            renderLogs(pObj);
            if (typeof CrmUI !== 'undefined' && CrmUI.success) {
                CrmUI.success('Nota eliminada de la bitácora.');
            }
            return res;
        }).catch(err => {
            const errMsg = (typeof CrmCommercial !== 'undefined' && CrmCommercial.errorMessage) ? CrmCommercial.errorMessage(err) : (err && err.message ? err.message : String(err));
            if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(errMsg);
            else if (typeof alert === 'function') alert(errMsg);
        });
    };

    if (typeof CrmUI !== 'undefined' && CrmUI && CrmUI.confirm) {
        return CrmUI.confirm({
            title: 'Eliminar Nota',
            message: '¿Estás seguro de eliminar esta nota de la bitácora?',
            confirmText: 'Eliminar',
            cancelText: 'Cancelar',
            type: 'danger',
            danger: true
        }).then(confirmed => {
            if (!confirmed) return;
            return doDelete();
        }).catch(err => {
            console.error('Error al solicitar confirmación para eliminar nota:', err);
            const safeMsg = 'No se pudo confirmar la eliminación. La nota no fue eliminada.';
            if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(safeMsg);
            else if (typeof alert === 'function') alert(safeMsg);
        });
    }

    let confirmed = false;
    if (typeof confirm === 'function') {
        try {
            confirmed = confirm('¿Estás seguro de eliminar esta nota?');
        } catch (_err) {
            confirmed = false;
        }
    }
    if (!confirmed) return;
    return doDelete();
}

function addLogToProspect(p, text, isAuto = false) {
    if (!p.logs || !Array.isArray(p.logs)) p.logs = [];
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const curUser = (typeof currentUser !== 'undefined' ? currentUser : (typeof _deps !== 'undefined' && _deps.getCurrentUser ? _deps.getCurrentUser() : null));
    const author = curUser ? curUser.nombre : 'Sistema';
    p.logs.push({ text: `${isAuto ? '' : '(' + author + ') '} ${text}`, date: new Date().toISOString(), auto: isAuto });
}

function onLogTextInput(el) {
    const text = (el && el.value) ? el.value.trim() : '';
    const banner = document.getElementById('log-commercial-intent-banner');
    if (!banner) return;
    if (!text) {
        banner.removeAttribute('data-dismissed');
        banner.style.display = 'none';
        return;
    }
    if (banner.getAttribute('data-dismissed') === 'true') {
        banner.style.display = 'none';
        return;
    }
    const commercialPattern = /(llam[eéó]|llamada|telefon|marqu[eé]|no contest|buz[oó]n|whatsapp|mensaj|reuni[oó]n|visit|habl[eé]|convers|contact|cotizaci[oó]n)/i;
    if (commercialPattern.test(text)) {
        banner.style.display = 'block';
    } else {
        banner.style.display = 'none';
    }
}

function dismissCommercialIntentBanner() {
    const banner = document.getElementById('log-commercial-intent-banner');
    if (banner) {
        banner.style.display = 'none';
        banner.setAttribute('data-dismissed', 'true');
    }
}

function transferTextToFollowUpModal() {
    const textEl = document.getElementById('new-log-text');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) return;

    window._pendingFollowUpDraft = text;

    if (!currentProspectId) return;
    openRecordFollowUpModal(currentProspectId);

    const detalleEl = document.getElementById('followup-detalle');
    if (detalleEl) {
        detalleEl.value = text;
    }

    const canalEl = document.getElementById('followup-canal');
    if (canalEl) {
        if (/\b(llam|marqu|telefon)/i.test(text)) {
            canalEl.value = 'llamada';
        } else if (/\b(whatsapp|mensaj)/i.test(text)) {
            canalEl.value = 'whatsapp';
        } else if (/\b(reuni|visit)/i.test(text)) {
            canalEl.value = 'reunion';
        } else if (/\b(correo|email)/i.test(text)) {
            canalEl.value = 'correo';
        }
        handleFollowUpCanalChange();
    }

    const banner = document.getElementById('log-commercial-intent-banner');
    if (banner) banner.style.display = 'none';
}

function addLog() {
    const textEl = document.getElementById('new-log-text');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) return;
    const btnEl = textEl ? textEl.nextElementSibling : null;
    const bannerEl = document.getElementById('log-commercial-intent-banner');

    let pObj = prospects.find(x => x.id === currentProspectId);
    if (!pObj) return;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        const noSessionMsg = typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.';
        if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(noSessionMsg);
        else if (typeof alert === 'function') alert(noSessionMsg);
        return;
    }
    if (btnEl) btnEl.disabled = true;

    // The author comes from the Firebase session on the server; a retry after an uncertain failure reuses the same opId.
    return CrmCommercial.addLog(fb, { prospectId: pObj.id, text, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) }).then(res => {
        if (res && res.entry) {
            if (!Array.isArray(pObj.logs)) pObj.logs = [];
            pObj.logs.push(res.entry);
        }
        if (textEl) textEl.value = '';
        if (bannerEl) {
            bannerEl.style.display = 'none';
            bannerEl.removeAttribute('data-dismissed');
        }
        if (typeof window !== 'undefined') window._pendingFollowUpDraft = null;
        renderLogs(pObj);
        if (typeof CrmUI !== 'undefined' && CrmUI.success) {
            CrmUI.success('Nota agregada a la bitácora.');
        }
        return res;
    }).catch(err => {
        const errMsg = (typeof CrmCommercial !== 'undefined' && CrmCommercial.errorMessage) ? CrmCommercial.errorMessage(err) : (err && err.message ? err.message : String(err));
        if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(errMsg);
        else if (typeof alert === 'function') alert(errMsg);
        console.error(err);
    }).finally(() => { if (btnEl) btnEl.disabled = false; });
}


    // -------------------------------------------------------------------------
    // 6. Seguimiento Comercial, Cadencia y Reclasificación (Subbloque 2C / 2D)
    // -------------------------------------------------------------------------
    function openRecordFollowUpModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    currentProspectId = prospectId;
    const idInput = document.getElementById('followup-prospect-id');
    if (idInput) idInput.value = prospectId;

    const client = getProspectClient(p.clientId);
    const clientName = getClientName(p.clientId);
    let contactPerson = '';
    let clientPhone = '';
    if (client) {
        if (client.tipo === 'natural') {
            contactPerson = [client.nombres, client.apellidos].filter(Boolean).join(' ').trim();
        } else {
            contactPerson = (client.contacto || client.rep_legal || '').trim();
        }
        clientPhone = (client.telefono || '').trim();
    }

    const subEl = document.getElementById('followup-modal-subtitle');
    if (subEl) {
        let contactInfo = '';
        if (contactPerson) contactInfo += ` | Contacto: ${contactPerson}`;
        if (clientPhone) contactInfo += ` | Tel: ${clientPhone}`;
        subEl.textContent = `Proyecto: ${p.proyecto || '-'} (${p.codigo || p.id.slice(-4)}) | Cliente: ${clientName}${contactInfo}`;
    }

    const contactStrip = document.getElementById('followup-modal-contact-strip');
    if (contactStrip) {
        if (contactPerson || clientPhone) {
            const waNumber = normalizeWhatsAppNumber(clientPhone);
            const cleanDigits = clientPhone ? clientPhone.replace(/[^\d+]/g, '') : '';
            const telPart = clientPhone
                ? `<a href="tel:${cleanDigits}" style="color:#93c5fd; text-decoration:none; font-weight:600;">📞 ${escapeHtmlDoc(clientPhone)}</a>`
                : '<span style="color:var(--text-muted)">Sin teléfono</span>';
            const waPart = waNumber
                ? `<a href="https://wa.me/${waNumber}" target="_blank" rel="noopener noreferrer" style="color:#6ee7b7; text-decoration:none; font-weight:600; margin-left:8px;">💬 WhatsApp</a>`
                : '';
            contactStrip.innerHTML = `<span>👤 Contacto: <strong>${escapeHtmlDoc(contactPerson || 'Cliente')}</strong></span> <span style="display:flex; align-items:center;">${telPart}${waPart}</span>`;
            contactStrip.style.display = 'flex';
        } else {
            contactStrip.style.display = 'none';
            contactStrip.innerHTML = '';
        }
    }

    const clasif = typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc.classifyFollowUp(p, new Date()) : { intentos_fallidos: 0, llamada_obligatoria: false };
    const intentos = clasif.intentos_fallidos || 0;

    // Alerta contextual
    const alertBox = document.getElementById('followup-cadence-alert-box');
    if (alertBox) {
        if (intentos >= 5 || clasif.isEscaladoGerencia) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(239, 68, 68, 0.2)';
            alertBox.style.border = '1px solid var(--danger)';
            alertBox.style.color = '#fca5a5';
            alertBox.innerHTML = `<strong>🚨 Oportunidad Escalada a Gerencia:</strong> Esta oportunidad acumula ${intentos} intentos sin respuesta del cliente. La continuidad debe ser revisada por la gerencia.`;
        } else if (intentos >= 3 || clasif.isDecisionVendedor) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(245, 158, 11, 0.2)';
            alertBox.style.border = '1px solid var(--warning)';
            alertBox.style.color = '#fde68a';
            alertBox.innerHTML = `<strong>⚠️ Decisión Comercial Requerida:</strong> Acumula 3 intentos sin respuesta. Debes justificar la continuidad para programar un siguiente contacto.`;
        } else if (clasif.llamada_obligatoria) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(59, 130, 246, 0.2)';
            alertBox.style.border = '1px solid #3b82f6';
            alertBox.style.color = '#bfdbfe';
            alertBox.innerHTML = `<strong>📞 Llamada Obligatoria:</strong> Al no haber respuesta en el primer intento, la cadencia comercial establece que el segundo contacto debe realizarse por llamada telefónica.`;
        } else {
            alertBox.style.display = 'none';
        }
    }

    // Canal y resultado iniciales
    const canalEl = document.getElementById('followup-canal');
    const resultadoEl = document.getElementById('followup-resultado');
    if (canalEl) {
        canalEl.value = clasif.llamada_obligatoria ? 'llamada' : 'llamada';
    }
    if (resultadoEl) {
        resultadoEl.value = 'respondio_evaluando';
    }

    // Detalle limpio
    const detalleEl = document.getElementById('followup-detalle');
    if (detalleEl) detalleEl.value = '';

    const cadencia = (p.seguimiento && p.seguimiento.cadencia) || {};

    // Sección de justificación tras 3 intentos
    const decisionBox = document.getElementById('followup-decision-box');
    const justifInput = document.getElementById('followup-justificacion');
    if (decisionBox) {
        decisionBox.style.display = intentos >= 3 ? 'block' : 'none';
        if (justifInput) justifInput.value = cadencia.justificacion_continuidad || '';
    }

    // Cuadro explicativo de cliente no continúa (oculto por defecto)
    const noContinuaBox = document.getElementById('followup-no-continua-box');
    if (noContinuaBox) noContinuaBox.style.display = 'none';
    const proxFechaGroup = document.getElementById('followup-prox-fecha-group');
    if (proxFechaGroup) proxFechaGroup.style.display = 'block';
    const proxTipoGroup = document.getElementById('followup-prox-tipo-group');
    if (proxTipoGroup) proxTipoGroup.style.display = 'block';
    const proxDescGroup = document.getElementById('followup-prox-desc-group');
    if (proxDescGroup) proxDescGroup.style.display = 'block';

    // Próxima acción sugerida
    updateSuggestedFollowUpDate();

    // Mostrar modal
    openModal('followUpModal');
}

function updateSuggestedFollowUpDate() {
    if (typeof CrmFollowUpCalc === 'undefined') return;
    const resultadoEl = document.getElementById('followup-resultado');
    const proxFechaEl = document.getElementById('followup-prox-fecha');
    const sugerenciaEl = document.getElementById('followup-prox-sugerencia');
    if (!resultadoEl || !proxFechaEl) return;

    const res = resultadoEl.value;
    const pid = (document.getElementById('followup-prospect-id') && document.getElementById('followup-prospect-id').value) || currentProspectId;
    const p = prospects.find(x => x.id === pid);
    const curCadence = (p && p.seguimiento && p.seguimiento.cadencia) || {};
    const intentos = (curCadence && curCadence.intentos_fallidos) || 0;
    const tipoCadencia = curCadence.tipo_cadencia || 'estandar';
    const cadConfig = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.getCadenceConfig)
        ? CrmFollowUpCalc.getCadenceConfig(tipoCadencia)
        : { dias_primer_contacto: 5, intervalo_sin_respuesta: 2, dias_solicito_tiempo: 15, nombre: 'Estándar Ductsal' };

    const canalEl = document.getElementById('followup-canal');
    const canal = canalEl ? canalEl.value : 'llamada';
    const isInternal = canal === 'interno';

    const suggested = CrmFollowUpCalc.suggestNextContactDate(new Date(), res, intentos, { channel: canal, isInternal, cadenceConfig: cadConfig });
    if (suggested) {
        const ymd = CrmFollowUpCalc.formatDateYMD(suggested);
        proxFechaEl.value = ymd;
    } else {
        if (res === 'no_continua') {
            proxFechaEl.value = '';
        }
    }

    if (sugerenciaEl) {
        const cadLbl = cadConfig.nombre || tipoCadencia;
        if (res === 'solicito_tiempo') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.dias_solicito_tiempo} días calendario acordados`;
        } else if (res === 'sin_respuesta') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.intervalo_sin_respuesta} días hábiles (salta fines de semana y asuetos)`;
        } else if (res === 'solicito_cambios') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.dias_primer_contacto} días hábiles para cotizar cambios`;
        } else if (res === 'no_continua') {
            sugerenciaEl.textContent = '💡 Cliente no continúa: No se programa seguimiento automático (la oportunidad no se marca como perdida).';
        } else if (res === 'nota_interna') {
            sugerenciaEl.textContent = '💡 Nota interna: No altera la cadencia comercial con el cliente.';
        } else {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.intervalo_sin_respuesta} días hábiles`;
        }

        if (suggested) {
            const ymd = CrmFollowUpCalc.formatDateYMD(suggested);
            const workCal = (typeof CrmWorkCalendar !== 'undefined' ? CrmWorkCalendar : (typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null));
            if (isInternal && workCal && workCal.isHalfDay(ymd)) {
                sugerenciaEl.textContent += ' [Programado para sábado: Media jornada interna 8:00 - 12:00]';
            }
        }
    }
}

function handleFollowUpCanalChange() {
    const canalEl = document.getElementById('followup-canal');
    const resultadoEl = document.getElementById('followup-resultado');
    if (!canalEl || !resultadoEl) return;

    if (canalEl.value === 'interno') {
        let optInterna = Array.from(resultadoEl.options).find(o => o.value === 'nota_interna');
        if (optInterna) optInterna.style.display = 'block';
        resultadoEl.value = 'nota_interna';
    } else {
        if (resultadoEl.value === 'nota_interna') {
            resultadoEl.value = 'respondio_evaluando';
        }
    }
    updateSuggestedFollowUpDate();
}

function handleFollowUpResultadoChange() {
    const resultadoEl = document.getElementById('followup-resultado');
    const decisionBox = document.getElementById('followup-decision-box');
    const noContinuaBox = document.getElementById('followup-no-continua-box');
    const proxFechaGroup = document.getElementById('followup-prox-fecha-group');
    const proxTipoGroup = document.getElementById('followup-prox-tipo-group');
    const proxDescGroup = document.getElementById('followup-prox-desc-group');
    const pid = (document.getElementById('followup-prospect-id') && document.getElementById('followup-prospect-id').value) || currentProspectId;
    const p = prospects.find(x => x.id === pid);
    const intentos = (p && p.seguimiento && p.seguimiento.cadencia && p.seguimiento.cadencia.intentos_fallidos) || 0;

    const resVal = resultadoEl ? resultadoEl.value : '';
    const isNoContinua = resVal === 'no_continua';

    if (decisionBox) {
        decisionBox.style.display = (resVal === 'sin_respuesta' && intentos >= 3) ? 'block' : 'none';
    }
    if (noContinuaBox) {
        noContinuaBox.style.display = isNoContinua ? 'block' : 'none';
    }
    if (proxFechaGroup) proxFechaGroup.style.display = isNoContinua ? 'none' : 'block';
    if (proxTipoGroup) proxTipoGroup.style.display = isNoContinua ? 'none' : 'block';
    if (proxDescGroup) proxDescGroup.style.display = isNoContinua ? 'none' : 'block';

    updateSuggestedFollowUpDate();
}

async function processSaveFollowUp(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('followup-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const canal = document.getElementById('followup-canal').value;
    const resultado = document.getElementById('followup-resultado').value;
    const detalle = document.getElementById('followup-detalle').value.trim();

    if (!detalle) {
        return alert('Por favor describe el detalle de la gestión.');
    }

    const proxFecha = document.getElementById('followup-prox-fecha').value;
    const proxTipo = document.getElementById('followup-prox-tipo').value;
    const proxDesc = document.getElementById('followup-prox-desc').value.trim();

    const justifInput = document.getElementById('followup-justificacion');
    const justificacionContinuidad = justifInput ? justifInput.value.trim() : '';

    const payload = {
        canal,
        resultado,
        detalle,
        proxima_accion: proxFecha ? { fecha: proxFecha, tipo: proxTipo, descripcion: proxDesc } : undefined,
        justificacion_continuidad: justificacionContinuidad || undefined
    };

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const btn = document.getElementById('btn-save-followup');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.recordFollowUp(fb, { prospectId, followUp: payload, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        if (res && res.seguimiento) {
            p.seguimiento = res.seguimiento;
            if (!Array.isArray(p.logs)) p.logs = [];
            const entryToAdd = res.logEntry || res.entry;
            if (entryToAdd) {
                const exists = p.logs.some(l => l && (l.date === entryToAdd.date || (entryToAdd.gestionId && l.gestionId === entryToAdd.gestionId) || (entryToAdd.opId && l.opId === entryToAdd.opId)));
                if (!exists) {
                    p.logs.push(entryToAdd);
                }
            }

            // Preservación de borrador: limpiar únicamente tras guardado confirmado exitoso
            const textEl = document.getElementById('new-log-text');
            if (textEl && (textEl.value.trim() === detalle || (window._pendingFollowUpDraft && textEl.value.trim() === window._pendingFollowUpDraft))) {
                textEl.value = '';
                const banner = document.getElementById('log-commercial-intent-banner');
                if (banner) {
                    banner.style.display = 'none';
                    banner.removeAttribute('data-dismissed');
                }
            }
            window._pendingFollowUpDraft = null;
        }

        closeModal('followUpModal');
        renderDailyAgenda();
        renderList();

        if (currentProspectId === prospectId) {
            renderFollowUpSummary(p);
            renderLogs(p);
        }
    } catch (err) {
        alert(CrmCommercial.errorMessage(err));
        console.error(err);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function renderFollowUpSummary(p) {
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const badgeEl = document.getElementById('detail-followup-badge');
    const summaryEl = document.getElementById('detail-followup-summary');
    if (!summaryEl) return;

    if (!p) {
        summaryEl.innerHTML = '';
        return;
    }

    const clasif = typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc.classifyFollowUp(p, new Date()) : null;

    if (badgeEl) {
        if (!clasif || clasif.status === 'inactivo') {
            badgeEl.className = 'badge bg-neutral';
            badgeEl.textContent = (p.estado || 'Activo').toUpperCase();
        } else if (p.clasificacion === 'presupuesto' && p.etapa === 'negociacion') {
            badgeEl.className = 'badge bg-neutral';
            badgeEl.textContent = '⏸️ SLA en Pausa (Presupuesto)';
        } else if (clasif.isEscaladoGerencia) {
            badgeEl.className = 'badge badge-urgency-escalada';
            badgeEl.textContent = '🚨 Escalada a Gerencia';
        } else if (clasif.status === 'vencida') {
            badgeEl.className = 'badge badge-urgency-vencida';
            badgeEl.textContent = `🚨 Vencida (${clasif.dias_retraso}d)`;
        } else if (clasif.status === 'hoy') {
            badgeEl.className = 'badge badge-urgency-hoy';
            badgeEl.textContent = '📌 Para Hoy';
        } else if (clasif.status === 'proxima') {
            badgeEl.className = 'badge badge-urgency-proxima';
            badgeEl.textContent = '⏳ Próxima';
        } else if (clasif.status === 'pendiente_decision') {
            badgeEl.className = 'badge badge-urgency-decision';
            badgeEl.textContent = '⚠️ Decisión';
        } else {
            badgeEl.className = 'badge bg-neutral';
            badgeEl.textContent = '📋 Al día';
        }
    }

    const seg = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
    const cad = (seg.cadencia && typeof seg.cadencia === 'object') ? seg.cadencia : {};
    const ult = (seg.ultimo_contacto && typeof seg.ultimo_contacto === 'object') ? seg.ultimo_contacto : null;
    const prox = (seg.proxima_accion && typeof seg.proxima_accion === 'object') ? seg.proxima_accion : null;
    const hist = Array.isArray(seg.historial_gestiones) ? seg.historial_gestiones : [];

    const intentos = Number(cad.intentos_fallidos) || 0;

    let ultHtml = '<span style="color:var(--text-muted); font-style:italic;">Sin contactos previos registrados</span>';
    if (ult && ult.fecha) {
        const canalLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[ult.canal]) || ult.canal;
        const resLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[ult.resultado]) || ult.resultado;
        const resColor = (ult.resultado === 'contacto_positivo' || ult.resultado === 'reunion_agendada') ? 'var(--brand-gold)' : 'var(--text-secondary)';
        ultHtml = `<div><strong>${escapeHtmlDoc(canalLbl)}</strong> (${formatDate(ult.fecha)})</div><div style="color:${resColor}; font-size:0.8rem; margin-top:2px;">${escapeHtmlDoc(resLbl)}</div>`;
    }

    let proxHtml = '<span style="color:var(--text-muted); font-style:italic;">Sin próxima acción programada</span>';
    if (prox && prox.fecha) {
        proxHtml = `<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;"><strong style="color:white; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; font-size:0.82rem;">📅 ${prox.fecha}</strong> ${prox.descripcion ? `<span style="color:var(--text-secondary); font-size:0.82rem;">${escapeHtmlDoc(prox.descripcion)}</span>` : ''}</div>`;
    }

    // Historial de gestiones estructuradas
    let histHtml = '';
    if (hist.length > 0) {
        histHtml = `<div style="margin-top:10px; border-top:1px solid var(--panel-border); padding-top:8px;">
            <div style="font-size:0.78rem; font-weight:700; color:var(--text-secondary); margin-bottom:6px;">Historial de Gestiones (${hist.length}):</div>`;
        const reversed = hist.slice().reverse().slice(0, 5); // últimas 5
        reversed.forEach(g => {
            const cLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[g.canal]) || g.canal;
            const rLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[g.resultado]) || g.resultado;
            histHtml += `
                <div class="followup-history-item ${!g.es_contacto_valido ? 'no-contact' : ''}">
                    <div><strong>${formatDate(g.fecha)}</strong> — <strong>${escapeHtmlDoc(cLbl)}</strong> por ${escapeHtmlDoc(g.usuarioNombre || 'Comercial')}</div>
                    <div style="color:var(--brand-gold);">${escapeHtmlDoc(rLbl)}</div>
                    ${g.detalle ? `<div style="color:var(--text-secondary); margin-top:2px;">${escapeHtmlDoc(g.detalle)}</div>` : ''}
                </div>
            `;
        });
        histHtml += `</div>`;
    }

    const etapa = p.etapa || 'prospecto';
    const deliveryDate = p.fecha_entrega_oferta || cad.fecha_entrega_oferta || null;
    let deliveryHtml = '';
    if (deliveryDate) {
        const ymd = (typeof CrmFollowUpCalc !== 'undefined') ? CrmFollowUpCalc.getCommercialYMD(deliveryDate) : String(deliveryDate).slice(0, 10);
        const deliverer = cad.entregado_por_nombre ? ` <span style="color:var(--text-secondary); font-size:0.75rem;">(por ${escapeHtmlDoc(cad.entregado_por_nombre)})</span>` : '';
        deliveryHtml = `
            <div class="followup-card-row">
                <div class="followup-card-row-header"><span>📅 Fecha de Entrega de Oferta</span></div>
                <div class="followup-card-row-content">
                    <strong style="color:white;">${ymd}</strong>${deliverer}
                </div>
            </div>`;
    } else if (etapa === 'negociacion' || etapa === 'cierre') {
        deliveryHtml = `
            <div class="followup-card-row">
                <div class="followup-card-row-header"><span>📅 Fecha de Entrega de Oferta</span></div>
                <div class="followup-card-row-content">
                    <span class="badge" style="background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); font-size:0.75rem; white-space:normal; line-height:1.3;">⚠️ Sin fecha de entrega de oferta registrada (Histórica)</span>
                </div>
            </div>`;
    }

    const tipoCadencia = cad.tipo_cadencia || 'estandar';
    const cadConfig = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.getCadenceConfig) ? CrmFollowUpCalc.getCadenceConfig(tipoCadencia) : { nombre: 'Estándar Ductsal' };
    const isAssigned = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const canChangeCadence = p.estado === 'activo' && !!currentUser && (currentUser.role === 'manager' || isAssigned);

    const cadenceChangeBtn = canChangeCadence
        ? `<button type="button" class="btn-secondary" onclick="openCadenceModal('${p.id}')" style="padding:2px 8px; font-size:0.7rem; border-radius:4px; cursor:pointer;" title="Configurar cadencia comercial">⚙️ Cambiar</button>`
        : '';

    let cadHistHtml = '';
    const cadHist = Array.isArray(cad.historial_cambios) ? cad.historial_cambios : [];
    if (cadHist.length > 0) {
        cadHistHtml = `<div style="margin-top:6px; border-top:1px dashed rgba(255,255,255,0.08); padding-top:6px; font-size:0.75rem; color:var(--text-secondary);">
            <div style="font-weight:700; color:var(--text-muted); margin-bottom:4px;">Historial de Cambios de Cadencia:</div>
            ${cadHist.map(h => {
                const fStr = (typeof formatDate === 'function') ? formatDate(h.fecha) : h.fecha;
                return `<div style="margin-bottom:2px;">• <strong>${fStr}</strong>: ${escapeHtmlDoc(h.cadenciaAnterior)} ➔ <strong>${escapeHtmlDoc(h.cadenciaNueva)}</strong> por ${escapeHtmlDoc(h.usuarioNombre || 'Comercial')}. <span style="color:var(--text-muted); font-style:italic;">"${escapeHtmlDoc(h.motivo || '')}"</span></div>`;
            }).join('')}
        </div>`;
    }

    let postClosingFinancialHtml = '';
    if (p.estado === 'ganado' && typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.evaluateFinancialMilestones === 'function') {
        const clientObj = getProspectClient(p.clientId);
        const fm = CrmFollowUpCalc.evaluateFinancialMilestones(p, clientObj);
        const ccfBadge = fm.ccfAnticipoStatus === 'emitido'
            ? `<span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-size:0.72rem;">✅ Emitido ${fm.ccfAnticipoNumero ? '(' + escapeHtmlDoc(fm.ccfAnticipoNumero) + ')' : ''}</span>`
            : `<span class="badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); font-size:0.72rem;">⏳ Pendiente</span>`;
        const antBadge = fm.anticipoPagoStatus === 'pagado'
            ? `<span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-size:0.72rem;">✅ Pagado (${formatCurrency(fm.montoConfirmado)})</span>`
            : (fm.anticipoPagoStatus === 'parcialmente_pagado'
                ? `<span class="badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); font-size:0.72rem;">⚠️ Parcialmente pagado (${formatCurrency(fm.montoConfirmado)} / ${formatCurrency(fm.montoExigible)})</span>`
                : `<span class="badge" style="background:rgba(239,68,68,0.18); color:#fca5a5; border:1px solid rgba(239,68,68,0.4); font-size:0.72rem;">⏳ Pendiente (Exigible: ${formatCurrency(fm.montoExigible)})</span>`);
        const fabBadge = fm.habilitadoFabricacion
            ? `<span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-size:0.72rem;">✅ Anticipo confirmado para fabricación</span>`
            : `<span class="badge" style="background:rgba(239,68,68,0.18); color:#fca5a5; border:1px solid rgba(239,68,68,0.4); font-size:0.72rem;">🔒 Bloqueado fabricación (Faltan ${formatCurrency(fm.saldoPendienteAnticipo)})</span>`;
        const obligHtml = Array.isArray(fm.obligacionesSeguimiento) && fm.obligacionesSeguimiento.length > 0
            ? `<div style="margin-top:6px; font-size:0.74rem; color:#fde68a;"><strong>Obligaciones pendientes:</strong><ul style="margin:4px 0 0 16px; padding:0;">${fm.obligacionesSeguimiento.map(ob => `<li>${escapeHtmlDoc(ob)}</li>`).join('')}</ul></div>`
            : '';
        postClosingFinancialHtml = `
            <div style="margin-top:8px; padding:8px 10px; background:rgba(15,23,42,0.75); border:1px solid ${fm.habilitadoFabricacion ? 'rgba(16,185,129,0.35)' : 'rgba(245,158,11,0.4)'}; border-radius:6px;">
                <div style="font-size:0.78rem; font-weight:700; color:var(--brand-gold); margin-bottom:6px;">💰 Hitos Financieros Post-Cierre (${escapeHtmlDoc(fm.formaPago || '-')})</div>
                <div style="display:flex; flex-direction:column; gap:5px; font-size:0.76rem;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;"><span>1. CCF de anticipo:</span> ${ccfBadge}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;"><span>2. Cobro de anticipo:</span> ${antBadge}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;"><span>3. Fabricación:</span> ${fabBadge}</div>
                </div>
                ${obligHtml}
            </div>
        `;
    }

    summaryEl.innerHTML = `
        <div class="followup-panel-card">
            ${postClosingFinancialHtml}
            <div class="followup-card-row">
                <div class="followup-card-row-header">
                    <span>💬 Último Contacto</span>
                </div>
                <div class="followup-card-row-content">
                    ${ultHtml}
                </div>
            </div>

            <div class="followup-card-row">
                <div class="followup-card-row-header">
                    <span>🎯 Próxima Acción</span>
                </div>
                <div class="followup-card-row-content">
                    ${proxHtml}
                </div>
            </div>

            ${deliveryHtml}

            <div class="followup-cadence-grid">
                <div class="followup-card-row">
                    <div class="followup-card-row-header">
                        <span>⏱️ Cadencia</span>
                    </div>
                    <div class="followup-card-row-content" style="display:flex; align-items:center; justify-content:space-between; gap:4px; flex-wrap:wrap; margin-top:2px;">
                        <span class="badge bg-neutral" style="font-size:0.75rem; border:1px solid var(--border-color);" title="${cadConfig.descripcion || ''}">
                            ${escapeHtmlDoc(cadConfig.nombre || tipoCadencia)}
                        </span>
                        ${cadenceChangeBtn}
                    </div>
                </div>

                <div class="followup-card-row">
                    <div class="followup-card-row-header">
                        <span>📞 Intentos</span>
                    </div>
                    <div class="followup-card-row-content" style="margin-top:2px;">
                        <span class="badge ${intentos >= 5 ? 'badge-urgency-escalada' : (intentos >= 3 ? 'badge-urgency-decision' : 'bg-neutral')}" style="font-size:0.75rem;">
                            ${intentos} de 5 fallidos
                        </span>
                    </div>
                </div>
            </div>

            ${cad.alerta_gerencial ? `
                <div style="padding:6px 10px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); border-radius:6px; font-size:0.78rem; color:#fca5a5; display:flex; align-items:center; gap:6px;">
                    <span>🚨</span> <strong>Alerta Gerencial Activa</strong> (Límite de 5 intentos alcanzado)
                </div>
            ` : ''}

            ${cad.justificacion_continuidad ? `
                <div style="font-size:0.75rem; color:var(--text-secondary); padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                    <strong style="color:var(--brand-gold);">Justificación continuidad:</strong> ${escapeHtmlDoc(cad.justificacion_continuidad)}
                </div>
            ` : ''}

            ${cadHistHtml}
        </div>
        ${histHtml}
    `;
}

function openCadenceModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;
    const modal = document.getElementById('cadenceModal');
    if (!modal) return;

    document.getElementById('cadence-prospect-id').value = prospectId;
    document.getElementById('cadence-modal-title').textContent = `Proyecto: ${p.codigo || ''} ${p.proyecto || ''}`;

    const curCadence = (p.seguimiento && p.seguimiento.cadencia) || {};
    const curTipo = curCadence.tipo_cadencia || 'estandar';
    const selectEl = document.getElementById('cadence-select-tipo');
    if (selectEl) {
        selectEl.value = curTipo;
        handleCadenceSelectChange();
    }

    const motivoEl = document.getElementById('cadence-motivo');
    if (motivoEl) motivoEl.value = '';

    modal.style.display = 'flex';
}

function handleCadenceSelectChange() {
    const selectEl = document.getElementById('cadence-select-tipo');
    const descBox = document.getElementById('cadence-desc-box');
    if (!selectEl || !descBox) return;

    const val = selectEl.value;
    if (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.CADENCIAS_VALIDAS && CrmFollowUpCalc.CADENCIAS_VALIDAS[val]) {
        const c = CrmFollowUpCalc.CADENCIAS_VALIDAS[val];
        descBox.innerHTML = `<strong>${c.nombre}:</strong> ${c.descripcion}`;
    }
}

async function processSaveCadence(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('cadence-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const selectEl = document.getElementById('cadence-select-tipo');
    const motivoEl = document.getElementById('cadence-motivo');
    const tipoCadencia = selectEl ? selectEl.value : 'estandar';
    const motivo = motivoEl ? motivoEl.value.trim() : '';

    if (!motivo || motivo.length < 5) {
        return alert('Por favor indica el motivo comercial del cambio de cadencia (mínimo 5 caracteres).');
    }

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const btn = document.getElementById('btn-save-cadence');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.updateProspectCadence(fb, { prospectId, tipoCadencia, motivo, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        if (res && res.cadencia) {
            if (!p.seguimiento) p.seguimiento = {};
            p.seguimiento.cadencia = res.cadencia;
            if (res.seguimiento) p.seguimiento = res.seguimiento;
            if (!Array.isArray(p.logs)) p.logs = [];
            p.logs.push({
                text: `(${currentUser ? currentUser.nombre : 'Comercial'}) [CADENCIA COMERCIAL] Cadencia cambiada a "${tipoCadencia}". Motivo: ${motivo}`,
                date: new Date().toISOString(),
                auto: true
            });
        }

        closeModal('cadenceModal');
        renderDailyAgenda();
        renderList();
        if (currentProspectId === prospectId) {
            renderFollowUpSummary(p);
        }
    } catch (err) {
        console.error('Error al actualizar cadencia:', err);
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.errorMessage(err) : (err.message || 'Error al actualizar cadencia comercial.'));
    } finally {
        if (btn) btn.disabled = false;
    }
}


function openReclassifyModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const idInput = document.getElementById('reclassify-prospect-id');
    const titleEl = document.getElementById('reclassify-modal-title');
    const selectEl = document.getElementById('reclassify-select');
    const motivoEl = document.getElementById('reclassify-motivo');

    if (idInput) idInput.value = prospectId;
    if (titleEl) {
        titleEl.textContent = `Proyecto: ${p.proyecto} (${getClientName(p.clientId)}) · Clasificación actual: ${p.clasificacion === 'presupuesto' ? 'Cotización para Presupuesto' : 'Oferta para Ejecución'}`;
    }
    if (selectEl) {
        selectEl.value = (p.clasificacion === 'presupuesto') ? 'ejecucion' : 'presupuesto';
    }
    if (motivoEl) motivoEl.value = '';

    handleReclassifySelectChange();
    openModal('reclassifyModal');
}

function handleReclassifySelectChange() {
    const selectEl = document.getElementById('reclassify-select');
    const descBox = document.getElementById('reclassify-desc-box');
    if (!selectEl || !descBox) return;

    if (selectEl.value === 'ejecucion') {
        descBox.innerHTML = '<strong>🏗️ Oferta para Ejecución:</strong> Representa una oportunidad con intención de compra/ejecución confirmada. Se incluye en el pronóstico ponderado y reanuda los cómputos operativos y de seguimiento comercial sin borrar el historial.';
    } else {
        descBox.innerHTML = '<strong>📐 Cotización para Presupuesto:</strong> Estimación referencial o de planificación presupuestaria del cliente. Avanza normalmente por el embudo hasta Negociación, donde detiene su SLA operativo mientras espera decisión del cliente.';
    }
}

async function processSaveReclassification(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('reclassify-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const selectEl = document.getElementById('reclassify-select');
    const motivoEl = document.getElementById('reclassify-motivo');
    const clasificacion = selectEl ? selectEl.value : 'ejecucion';
    const motivo = motivoEl ? motivoEl.value.trim() : '';

    if (!motivo || motivo.length < 5) {
        return alert('Por favor indica el motivo comercial del cambio de clasificación (mínimo 5 caracteres).');
    }

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial !== 'undefined' && !CrmCommercial.hasSessionSync(fb)) {
        return alert(CrmCommercial.NO_SESSION_MESSAGE);
    }

    const btn = document.getElementById('btn-save-reclassify');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.reclassifyProspect(fb, { prospectId, clasificacion, motivo, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        if (res && res.clasificacion) {
            p.clasificacion = res.clasificacion;
            if (res.historial_clasificacion) {
                p.historial_clasificacion = res.historial_clasificacion;
            }
            if (res.sla_pausado_en !== undefined) p.sla_pausado_en = res.sla_pausado_en;
            if (res.sla_estado !== undefined) p.sla_estado = res.sla_estado;
            if (res.fecha_reactivacion_ejecucion !== undefined) p.fecha_reactivacion_ejecucion = res.fecha_reactivacion_ejecucion;
            if (res.tiempo_espera_presupuesto_acumulado_dias !== undefined) p.tiempo_espera_presupuesto_acumulado_dias = res.tiempo_espera_presupuesto_acumulado_dias;
            if (res.stage_timestamps) p.stage_timestamps = res.stage_timestamps;
            if (res.tiempos_etapas_acumulados) p.tiempos_etapas_acumulados = res.tiempos_etapas_acumulados;
            if (!Array.isArray(p.logs)) p.logs = [];
            p.logs.push({
                text: `(${currentUser ? currentUser.nombre : 'Comercial'}) [CLASIFICACIÓN COMERCIAL] Clasificación cambiada a "${clasificacion === 'ejecucion' ? 'Oferta para ejecución' : 'Cotización para presupuesto'}". Motivo: ${motivo}`,
                date: new Date().toISOString(),
                auto: true
            });
        }

        closeModal('reclassifyModal');
        renderList();
        if (currentProspectId === prospectId) {
            renderTracker(p);
            renderInfo(p);
            renderFollowUpSummary(p);
            const advContainer = document.getElementById('advance-form-container');
            if (advContainer) advContainer.innerHTML = '';
        }
    } catch (err) {
        console.error('Error al reclasificar prospecto:', err);
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.errorMessage(err) : (err.message || 'Error al cambiar clasificación comercial.'));
    } finally {
        if (btn) btn.disabled = false;
    }
}



    // -------------------------------------------------------------------------
    // 7. Formularios, Creación, Edición y Transiciones de Etapa (Subbloque 2D)
    // -------------------------------------------------------------------------
    function openNewModal() {
    renderClientSelect();
    const vendorGroup = document.getElementById('vendedor-assign-group');
    const vendorSelect = document.getElementById('new-vendedor-select');
    if (vendorGroup && vendorSelect) {
        if (currentUser && currentUser.role === 'manager') {
            vendorGroup.style.display = 'block';
            vendorSelect.innerHTML = `<option value="${currentUser.id}">Mismo Creador: ${currentUser.nombre} (Gerente)</option>`;
            users.filter(u => u.activo !== false && u.id !== currentUser.id).forEach(u => {
                const rText = u.role === 'manager' ? 'Gerente' : (u.role === 'gestor' ? 'Gestor' : 'Vendedor');
                vendorSelect.innerHTML += `<option value="${u.id}">${u.nombre} (${rText})</option>`;
            });
        } else {
            vendorGroup.style.display = 'none';
        }
    }
    document.getElementById('newProspectModal').style.display = 'block';
}


function openModal(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = 'flex';
        if (typeof document !== 'undefined' && document.body && document.body.classList) {
            document.body.classList.add('modal-open');
        }
    }
}

function closeModal(id) {
    if (id === 'docPreviewModal' && typeof closeDocPreviewModal === 'function') {
        closeDocPreviewModal();
        return;
    }
    if (id === 'clientDetailContent') {
        cancelPendingClientReservation();
        if (typeof ClientsUI !== 'undefined' && typeof ClientsUI.closeClientDetailView === 'function') {
            ClientsUI.closeClientDetailView();
            return;
        }
    }
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';

    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const openModals = document.querySelectorAll('.modal');
        let anyOpen = false;
        for (let i = 0; i < openModals.length; i++) {
            if (openModals[i].style.display === 'flex' || openModals[i].style.display === 'block') {
                anyOpen = true;
                break;
            }
        }
        if (!anyOpen && document.body && document.body.classList) {
            document.body.classList.remove('modal-open');
        }
    } else if (typeof document !== 'undefined' && document.body && document.body.classList) {
        document.body.classList.remove('modal-open');
    }
}


// The opportunity is created by createProspectAdmin: the server decides who creates it (from the Firebase session), the code
// and the initial history. The browser only sends what the user typed and, for manager/gestor, an optional assignee id.
async function createNewProspect(e) {
    e.preventDefault(); const clientId = document.getElementById('new-cliente-select').value; if (!clientId) return alert("Debes seleccionar un cliente");
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const clasifEl = document.getElementById('new-clasificacion');
    const prospect = {
        clientId: clientId,
        proyecto: document.getElementById('new-proyecto').value,
        origen: document.getElementById('new-origen').value,
        tipo_proyecto: document.getElementById('new-tipo-proyecto').value,
        tipo_producto: document.getElementById('new-tipo-producto').value
    };
    if (clasifEl && clasifEl.value) {
        prospect.clasificacion = clasifEl.value;
    }
    const vendorSelect = document.getElementById('new-vendedor-select');
    if (vendorSelect && vendorSelect.value && currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
        prospect.vendedorId = vendorSelect.value; // only a hint: the server re-checks the role and that the user exists
    }

    showLoading('Creando prospecto...');
    try {
        const res = await CrmCommercial.createProspect(fb, { prospect, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        if (res && res.prospect && res.prospect.id && !prospects.some(x => x.id === res.prospect.id)) prospects.push(res.prospect);
        closeModal('newProspectModal');
        document.getElementById('newProspectForm').reset();
        renderList();
    } catch (err) {
        alert(CrmCommercial.errorMessage(err));
    } finally {
        hideLoading();
    }
}

// ========================
// DETAIL VIEW & ADVANCEMENT
// ========================


function openEditBasePriceModal() {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    if (p.etapa !== 'cotizacion' && p.etapa !== 'negociacion') {
        return alert("Los montos base solo pueden corregirse durante las etapas de cotización y negociación. En cierre quedan congelados.");
    }
    const precio = p.precio_cotizado || 0;
    const costo = p.costo_venta || 0;
    document.getElementById('eb-precio').value = precio;
    document.getElementById('eb-costo').value = costo;
    document.getElementById('eb-motivo').value = '';
    const modal = document.getElementById('editBasePriceModal');
    if (modal) {
        modal.setAttribute('data-old-precio', String(precio));
        modal.setAttribute('data-old-costo', String(costo));
        modal.style.display = 'block';
    }
}

async function processEditBasePrice(e) {
    e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    if (p.etapa !== 'cotizacion' && p.etapa !== 'negociacion') {
        return alert("Los montos base solo pueden corregirse durante las etapas de cotización y negociación. En cierre quedan congelados.");
    }
    const precio = parseFloat(document.getElementById('eb-precio').value);
    const costo = parseFloat(document.getElementById('eb-costo').value);
    const motivo = document.getElementById('eb-motivo').value.trim();
    if (isNaN(precio) || isNaN(costo)) return alert("Ingresa un precio y un costo válidos.");
    if (!motivo) return alert("Indica el motivo de la corrección.");
    if (motivo.length < 5) return alert("El motivo de la corrección debe tener al menos 5 caracteres.");

    const modal = document.getElementById('editBasePriceModal');
    const expectedOldPrice = modal ? parseFloat(modal.getAttribute('data-old-precio') || String(p.precio_cotizado || 0)) : (p.precio_cotizado || 0);
    const expectedOldCost = modal ? parseFloat(modal.getAttribute('data-old-costo') || String(p.costo_venta || 0)) : (p.costo_venta || 0);

    // editProspectBasePriceAdmin: includes optimistic concurrency control and stage validation
    const res = await runWorkflowOp('Guardando corrección...', fb => CrmCommercial.editBasePrice(fb, {
        prospectId: p.id,
        precio,
        costo,
        motivo,
        expectedOldPrice,
        expectedOldCost,
        dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod'))
    }));
    if (res) closeModal('editBasePriceModal');
}


function showNewProposalForm() {
    const p = prospects.find(x => x.id === currentProspectId);
    const container = document.getElementById('advance-form-container');

    window.stagedFiles = { 'prop-file': [], 'prop-file2': [] };

    let formHTML = `<h4><span style="color:var(--success)">Registrar Nueva Propuesta</span></h4>
        <div class="form-grid mt-2">
            <div class="form-group"><label>Nuevo Costo (Subtotal)</label><input type="number" id="prop-costo" value="${p.costo_venta || ''}" required></div>
            <div class="form-group"><label>Nuevo Precio (Subtotal)</label><input type="number" id="prop-precio" value="${p.precio_cotizado || ''}" required></div>
            <div class="form-group full-width">
                <label>Nueva Oferta (PDF/Word)</label>
                <input type="file" id="prop-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="prop-file-list" style="margin-top: 8px;"></div>
            </div>
            <div class="form-group full-width">
                <label>Nuevo Cuadro de Costos (PDF/Excel)</label>
                <input type="file" id="prop-file2" multiple onchange="updateSelectedFilesList(this)">
                <div id="prop-file2-list" style="margin-top: 8px;"></div>
            </div>
        </div>
        <button class="btn-success mt-2" onclick="processNewProposal()">Guardar Propuesta</button>
        <button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
    `;
    container.innerHTML = formHTML;
    renderStagedFiles('prop-file');
    renderStagedFiles('prop-file2');
}

async function processNewProposal() {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const c = parseFloat(document.getElementById('prop-costo').value);
    const pr = parseFloat(document.getElementById('prop-precio').value);
    if (isNaN(c) || isNaN(pr)) return alert("Completa costos y precios.");

    const files1 = window.stagedFiles && window.stagedFiles['prop-file'] ? window.stagedFiles['prop-file'] : [];
    const files2 = window.stagedFiles && window.stagedFiles['prop-file2'] ? window.stagedFiles['prop-file2'] : [];
    if (files1.length === 0 || files2.length === 0) return alert("Debe subir la nueva oferta y el cuadro de costos.");

    // registerProposalAdmin: only in an active opportunity in negotiation; price, cost, documents, history and audit are written together.
    const res = await runWorkflowOp('Subiendo nueva propuesta...', async fb => {
        const [docOferta, docCostos] = await Promise.all([
            Promise.all(files1.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id }))),
            Promise.all(files2.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })))
        ]);
        return CrmCommercial.registerProposal(fb, { prospectId: p.id, costo_venta: c, precio_cotizado: pr, doc_oferta: docOferta, doc_costos: docCostos, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
    });
    if (res) openDetail(p.id);
}

// Google Maps auto-script removed per user request

function toggleContractRequirement(checked) {
    const contractSec = document.getElementById('contract-fields-container');
    const noContractSec = document.getElementById('no-contract-fields-container');
    const file1Contract = document.getElementById('adv-file1-contract');
    const file1NoContract = document.getElementById('adv-file1-nocontract');
    const companyDocsWarning = document.getElementById('company-docs-warning');
    const companyDocsSuccess = document.getElementById('company-docs-success');

    if (checked) {
        if (contractSec) contractSec.style.display = 'none';
        if (noContractSec) noContractSec.style.display = 'block';
        if (file1Contract) file1Contract.required = false;
        if (file1NoContract) file1NoContract.required = true;
        if (companyDocsWarning) companyDocsWarning.style.display = 'none';
        if (companyDocsSuccess) companyDocsSuccess.style.display = 'none';
    } else {
        if (contractSec) contractSec.style.display = 'block';
        if (noContractSec) noContractSec.style.display = 'none';
        if (file1Contract) file1Contract.required = true;
        if (file1NoContract) file1NoContract.required = false;
        if (companyDocsWarning) companyDocsWarning.style.display = 'block';
        if (companyDocsSuccess) companyDocsSuccess.style.display = 'block';
    }
}

function showAdvanceForm() {
    const prospects = _deps.getProspects();
    const STAGES = _deps.getStages();
    const settings = _deps.getSettings();
    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const p = prospects.find(x => x && x.id === currentProspectId); const container = document.getElementById('advance-form-container');
    const currentIndex = STAGES.indexOf(p.etapa); if (currentIndex >= STAGES.length - 1) return; const nextStage = STAGES[currentIndex + 1];

    if (nextStage === 'cierre' && p.clasificacion === 'presupuesto') {
        container.innerHTML = `<div style="background: rgba(147, 51, 234, 0.1); border: 1px solid rgba(147, 51, 234, 0.5); padding: 1.5rem; border-radius: 6px; margin-top: 1rem;">
            <h4 style="color:#c084fc">📐 Proyecto de Presupuesto en Negociación (SLA Detenido)</h4>
            <p style="font-size: 0.9rem; margin-top: 0.5rem; color: var(--text-primary); line-height: 1.5;">
                Esta oportunidad se encuentra en <strong>Negociación</strong> bajo clasificación de <strong>Presupuesto</strong> con su reloj de SLA operativo detenido en espera de decisión del cliente.
            </p>
            <p style="font-size: 0.85rem; margin-top: 0.5rem; color: var(--text-secondary); line-height: 1.4;">
                Para avanzar a <em>Cierre</em> comercial, primero debes <strong>reactivarla como Oferta para Ejecución</strong> indicando la justificación comercial correspondiente.
            </p>
            <div style="margin-top: 1rem; display: flex; gap: 0.75rem;">
                <button type="button" class="btn-primary" onclick="openReclassifyModal('${p.id}')">🔄 Reactivar como Oferta para Ejecución</button>
                <button type="button" class="btn-secondary" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
            </div>
        </div>`;
        return;
    }

    if (nextStage === 'cierre') {
        container.innerHTML = `<div style="background: rgba(212, 175, 55, 0.08); border: 1px solid var(--brand-gold); padding: 1.5rem; border-radius: 8px; margin-top: 1rem;">
            <h4 style="color:var(--brand-gold); margin-top:0;">🚀 Avanzar a Cierre (Pendiente de Documentación)</h4>
            <p style="font-size: 0.9rem; margin-top: 0.5rem; color: var(--text-primary); line-height: 1.5;">
                Esta acción avanza la oportunidad comercial de <strong>Negociación</strong> a la etapa de <strong>Cierre</strong> para formalización y validación documental.
            </p>
            <ul style="font-size: 0.85rem; color: var(--text-secondary); margin: 0.75rem 0 1rem 1.25rem; line-height: 1.6;">
                <li>Se registrará la fecha y hora oficial de entrada a Cierre.</li>
                <li>Inicia el plazo oficial de <strong>5 días hábiles</strong> para recopilar, adjuntar y validar la documentación requerida.</li>
                <li>La oportunidad permanece <strong>abierta y en proceso</strong> (no ganada).</li>
                <li>No se transferirá a Proyectos y Cobros hasta que se ejecute la acción <strong>Finalizar oportunidad</strong> con todos los documentos aprobados.</li>
            </ul>
            <div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
                <button type="button" class="btn-primary" onclick="confirmAdvanceToCierre('${p.id}')">Avanzar a Cierre</button>
                <button type="button" class="btn-secondary" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
            </div>
        </div>`;
        return;
    }

    let formHTML = `<h4>Avanzar a: <span style="text-transform:capitalize; color:var(--brand-gold)">${nextStage}</span></h4>`;
    if (nextStage === 'negociacion' && p.clasificacion === 'presupuesto') {
        formHTML += `<div style="background: rgba(147, 51, 234, 0.12); border: 1px solid rgba(147, 51, 234, 0.45); padding: 0.85rem 1rem; border-radius: 6px; margin-top: 0.5rem; font-size: 0.84rem; color: #e9d5ff; line-height: 1.45;">
            ⏸️ <strong>Regla SLA de Presupuesto:</strong> Al avanzar a <strong>Negociación</strong>, el reloj del SLA operativo se detendrá automáticamente mientras el proyecto conserve su condición presupuestaria y espere decisión del cliente. El tiempo operativo previo quedará preservado.
        </div>`;
    }
    formHTML += `<div class="form-grid mt-2">`;

    if (nextStage === 'levantamiento') {
        let visOpts = settings.visitantes.map(v => `<option value="${v}">${v}</option>`).join('');
        if (!visOpts) visOpts = `<option value="">-- Sin configurar (Vaya a ajustes) --</option>`;

        if (p.tipo_proyecto === 'Fabricación') {
            formHTML += `<div class="form-group"><label>Vendedor que atendió</label><select id="adv-visitante" required><option value="">-- Seleccione --</option>${visOpts}</select></div>
            <div class="form-group"><label>Fecha est. inicio (Opcional)</label><input type="date" id="adv-inicio"></div>
            <div class="form-group full-width">
                <label>Documentos/Planos</label>
                <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file-list" style="margin-top: 8px;"></div>
            </div>`;
        } else {
            let mapLink = "https://maps.google.com";
            if (settings.factory_address) mapLink += `?q=${encodeURIComponent(settings.factory_address)}`;

            formHTML += `<div class="form-group full-width"><label>Ubicación del Proyecto (Opcional)</label><input type="text" id="adv-ubicacion" placeholder="Ej. Calle Principal #123"></div>
                <div class="form-group"><label>Distancia a Fábrica (km) <a href="${mapLink}" target="_blank" style="color:var(--brand-gold); font-size: 0.8rem; margin-left: 5px;">[Abrir Mapa]</a></label><input type="number" step="0.1" id="adv-distancia" required></div>
                <div class="form-group"><label>Quién visitó</label><select id="adv-visitante" required><option value="">-- Seleccione --</option>${visOpts}</select></div><div class="form-group"><label>Fecha de visita (Opcional)</label><input type="date" id="adv-fecha"></div><div class="form-group"><label>Fecha est. inicio (Opcional)</label><input type="date" id="adv-inicio"></div>
                <div class="form-group full-width">
                    <label>Notas/Planos</label>
                    <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                    <div id="adv-file-list" style="margin-top: 8px;"></div>
                </div>`;
        }
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        let isNeg = nextStage === 'negociacion';
        let selAlta = p.probabilidad === 75 ? 'selected' : ''; let selMedia = p.probabilidad === 50 ? 'selected' : ''; let selBaja = p.probabilidad === 25 ? 'selected' : ''; let selImprobable = p.probabilidad === 10 ? 'selected' : '';
        formHTML += `<div class="form-group"><label>Costo de Venta (Subtotal)</label><input type="number" id="adv-costo" value="${p.costo_venta || ''}" required></div>
            <div class="form-group"><label>Precio Cotizado (Subtotal)</label><input type="number" id="adv-precio" value="${p.precio_cotizado || ''}" required></div>
            <div class="form-group"><label>Probabilidad</label><select id="adv-prob" required>
                    <option value="alta" ${selAlta}>Alta (75%)</option><option value="media" ${selMedia}>Media (50%)</option><option value="baja" ${selBaja}>Baja (25%)</option><option value="improbable" ${selImprobable}>Improbable (10%)</option>
                </select></div>
            <div class="form-group full-width">
                <label>Oferta (PDF/Word)</label>
                <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file-list" style="margin-top: 8px;"></div>
            </div>
            <div class="form-group full-width">
                <label>Cuadro de Costos (PDF/Excel)</label>
                <input type="file" id="adv-file2" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file2-list" style="margin-top: 8px;"></div>
            </div>`;
    }
    formHTML += `</div><button type="button" class="btn-primary mt-2" onclick="processAdvance('${nextStage}')">Confirmar Avance</button><button type="button" class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>`;

    window.stagedFiles = { 'adv-file': [], 'adv-file2': [] };

    container.innerHTML = formHTML;

    if (document.getElementById('adv-file-list')) renderStagedFiles('adv-file');
    if (document.getElementById('adv-file2-list')) renderStagedFiles('adv-file2');
}

// Stage transitions are decided by advanceProspectStageAdmin: it reads the CURRENT document, enforces the order of the stages and the
// closing requirements, computes the advance invoice (VAT / export, payment form) and writes the history, the timestamps and the audit
// record. This function only collects what the user typed and the file references returned by the uploads; the checks below are
// a courtesy (fast feedback), not the rule. There is no fallback write.
async function processAdvance(nextStage) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const data = {};

    if (nextStage === 'levantamiento') {
        const dI = document.getElementById('adv-inicio').value;
        const v = document.getElementById('adv-visitante').value.trim();

        if (p.tipo_proyecto !== 'Fabricación') {
            const elF = document.getElementById('adv-fecha');
            const elU = document.getElementById('adv-ubicacion');
            const elDist = document.getElementById('adv-distancia');
            const dist = elDist ? elDist.value : "";
            if (!dist) return alert("Completa la distancia a la fábrica.");
            data.fecha_visita = elF ? elF.value : "";
            data.ubicacion = elU ? elU.value.trim() : "";
            data.distancia = parseFloat(dist);
        }

        if (!v) return alert("Completa el vendedor/visitante.");
        data.visitante = v; data.fecha_inicio = dI;

        const files = window.stagedFiles && window.stagedFiles['adv-file'] ? window.stagedFiles['adv-file'] : [];
        const ok = await runWorkflowOp('Subiendo documentos de levantamiento...', async fb => {
            if (files.length > 0) data.doc_levantamiento = await Promise.all(files.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        });
        if (!ok) return;
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        const c = parseFloat(document.getElementById('adv-costo').value); const pr = parseFloat(document.getElementById('adv-precio').value); const prob = document.getElementById('adv-prob').value;
        if (isNaN(c) || isNaN(pr) || !prob) return alert("Completa costos, precios y probabilidad.");

        const files1 = window.stagedFiles && window.stagedFiles['adv-file'] ? window.stagedFiles['adv-file'] : [];
        const files2 = window.stagedFiles && window.stagedFiles['adv-file2'] ? window.stagedFiles['adv-file2'] : [];
        const hasOferta = (files1.length > 0) || (p.datos && p.datos.doc_oferta);
        const hasCostos = (files2.length > 0) || (p.datos && p.datos.doc_costos);
        if (!hasOferta || !hasCostos) {
            return alert("Es obligatorio adjuntar tanto la Oferta como el Cuadro de Costos.");
        }

        data.costo_venta = c; data.precio_cotizado = pr; data.probabilidad = prob;
        const ok = await runWorkflowOp('Subiendo cotizaciones y costos...', async fb => {
            if (files1.length > 0) data.doc_oferta = await Promise.all(files1.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            if (files2.length > 0) data.doc_costos = await Promise.all(files2.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
        });
        if (!ok) return;
    } else if (nextStage === 'cierre') {
        const fpEl = document.getElementById('adv-forma-pago');
        if (fpEl) {
            const fp = fpEl.value; if (!fp) return alert("Selecciona la forma de pago.");
            const facNum = document.getElementById('adv-fac-anticipo').value.trim(); if (!facNum) return alert("Ingresa el número de factura de anticipo.");
            data.forma_pago = fp; data.factura_anticipo = facNum;
            if (p.tipo_proyecto === 'Fabricación e instalación') { const enc = document.getElementById('adv-encargado').value.trim(); if (!enc) return alert("Debe asignar un Encargado de Instalación."); data.encargado = enc; }

            const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));
            // Only reflects the manager's STORED authorization (the checkbox is rendered from it); the server decides from the stored value too.
            const authNoContractEl = document.getElementById('adv-auth-no-contract');
            const bypassContract = authNoContractEl ? authNoContractEl.checked : false;

            const c = clients.find(x => x.id === p.clientId);
            if (!c) return alert("No se encontró el cliente de esta oportunidad.");
            if (!c.documentos) c.documentos = {};

            // DUI is always mandatory for all closing transactions
            if (!c.documentos.dui) {
                return alert("❌ OBLIGATORIO: Falta el DUI (del representante o cliente) en el Directorio de Clientes. Ve al Directorio, edita el cliente y sube el documento antes de poder cerrar este proyecto.");
            }

            if (isBigInstalacion && !bypassContract) {
                if (c.tipo === 'juridica') {
                    if (!c.documentos.escritura || !c.documentos.credencial || !c.documentos.nit || !c.documentos.nrc) {
                        return alert("❌ OBLIGATORIO: Para cerrar este proyecto con contrato, primero debes ir al Directorio de Clientes y adjuntar todos los documentos legales de la Empresa (Escritura, Credencial, NIT, NRC).");
                    }
                }
            }

            let f1;
            if (isBigInstalacion) {
                f1 = bypassContract ? document.getElementById('adv-file1-nocontract') : document.getElementById('adv-file1-contract');
            } else {
                f1 = document.getElementById('adv-file1');
            }

            if (!f1 || f1.files.length === 0) return alert("Es obligatorio subir el Contrato o la Oferta firmada.");

            const f2 = document.getElementById('adv-file2');
            if (!f2 || f2.files.length === 0) return alert("Es obligatorio subir la Factura o Comprobante de anticipo.");

            const ok = await runWorkflowOp('Avanzando a Cierre y subiendo documentos...', async fb => {
                const [docFirmado, docComprobante] = await Promise.all([
                    uploadFileToStorage(f1.files[0], 'proyectos', { prospectId: p.id }),
                    uploadFileToStorage(f2.files[0], 'facturas', { prospectId: p.id })
                ]);
                data.doc_firmado = docFirmado; data.doc_comprobante = docComprobante;
                return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
            });
            if (!ok) return;
        } else {
            const ok = await runWorkflowOp('Avanzando a Cierre...', async fb => {
                return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage: 'cierre', data: {}, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
            });
            if (!ok) return;
        }
    }

    document.getElementById('advance-form-container').innerHTML = ''; openDetail(p.id);
}

async function confirmAdvanceToCierre(prospectId) {
    const id = prospectId || currentProspectId;
    const p = prospects.find(x => x.id === id);
    if (!p) return;
    return processAdvance('cierre');
}

let currentRevertOpId = null;

function showRevertForm() {
    const p = prospects.find(x => x.id === currentProspectId);
    const container = document.getElementById('advance-form-container');
    if (!p || !container) return;

    const REVERSION_PREV = {
        cierre: 'negociacion',
        negociacion: 'cotizacion',
        cotizacion: 'levantamiento',
        levantamiento: 'prospecto'
    };

    const targetStage = REVERSION_PREV[p.etapa];
    if (!targetStage) {
        alert('La etapa actual (' + p.etapa + ') no puede retroceder.');
        return;
    }

    if (!currentRevertOpId) {
        const cm = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : null;
        currentRevertOpId = (cm && typeof cm.generateCryptoOpId === 'function')
            ? cm.generateCryptoOpId()
            : ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : null);
    }

    let warningHtml = '';
    if (p.etapa === 'cierre' && targetStage === 'negociacion') {
        warningHtml = `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); padding: 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.85rem; color: var(--text-primary); line-height: 1.4;">
            ⚠️ <strong>Aviso de Autorización y Cierre:</strong> Al retroceder a Negociación, cualquier autorización para venta sin contrato quedará automáticamente <strong>invalidada</strong> y las solicitudes pendientes serán <strong>anuladas</strong>. Los accesos exclusivos de Cierre serán actualizados.
        </div>`;
    } else if (p.etapa === 'negociacion' && targetStage === 'cotizacion') {
        warningHtml = `<div style="background: rgba(245, 158, 11, 0.1); border: 1px solid var(--brand-gold); padding: 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.85rem; color: var(--text-primary); line-height: 1.4;">
            ℹ️ <strong>Aviso Documental y Cadencia:</strong> La oferta y el cuadro de costos actuales se conservarán identificados como <strong>borradores</strong>. La cadencia activa de negociación será desescalada para permitir la preparación de la nueva propuesta.
        </div>`;
    }

    container.innerHTML = `<div style="background: var(--panel-bg); border: 1px solid var(--panel-border); padding: 1.25rem; border-radius: 8px; margin-top: 1rem;">
        <h4 style="color: var(--text-primary); margin-top: 0; display: flex; align-items: center; gap: 0.5rem;">
            <span>↩️ Retroceder Etapa:</span>
            <span style="color: var(--brand-gold); text-transform: capitalize;">${p.etapa} → ${targetStage}</span>
        </h4>
        ${warningHtml}
        <div class="form-group mt-2">
            <label for="revert-reason" style="font-weight: 600; font-size: 0.85rem; color: var(--text-secondary);">
                Motivo obligatorio de retroceso (mínimo 10 caracteres, máx. 500):
            </label>
            <textarea id="revert-reason" class="form-control" rows="3" maxlength="500" placeholder="Describe claramente el motivo comercial o técnico del retroceso..." style="width: 100%; margin-top: 0.25rem; padding: 0.5rem; background: var(--bg-input); border: 1px solid var(--panel-border); border-radius: 4px; color: var(--text-primary); font-size: 0.85rem;"></textarea>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;" id="revert-char-count">0 / 500 caracteres</div>
        </div>
        <div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
            <button type="button" class="btn-danger" id="btn-confirm-revert" onclick="processRevertStage('${targetStage}')">Confirmar Retroceso</button>
            <button type="button" class="btn-secondary" onclick="cancelRevertForm()">Cancelar</button>
        </div>
    </div>`;

    const txt = document.getElementById('revert-reason');
    if (txt) {
        txt.addEventListener('input', function() {
            const len = (txt.value || '').trim().length;
            const countEl = document.getElementById('revert-char-count');
            if (countEl) countEl.textContent = `${len} / 500 caracteres`;
        });
    }
}

function cancelRevertForm() {
    currentRevertOpId = null;
    const container = document.getElementById('advance-form-container');
    if (container) container.innerHTML = '';
}

async function processRevertStage(targetStage) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const txt = document.getElementById('revert-reason');
    const reason = txt ? (txt.value || '').trim() : '';
    if (!reason || reason.length < 10) {
        alert('El motivo del retroceso es obligatorio y debe tener al menos 10 caracteres.');
        if (txt) txt.focus();
        return;
    }
    if (reason.length > 500) {
        alert('El motivo no puede exceder 500 caracteres.');
        return;
    }

    const confirmBtn = document.getElementById('btn-confirm-revert');
    if (confirmBtn) {
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
    }

    try {
        const opIdToUse = currentRevertOpId;
        const ok = await runWorkflowOp('Procesando retroceso de etapa...', async fb => {
            return CrmCommercial.revertStage(fb, {
                prospectId: p.id,
                currentStage: p.etapa,
                targetStage,
                motivo: reason,
                opId: opIdToUse,
                dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod'))
            });
        });

        if (ok) {
            currentRevertOpId = null;
            const container = document.getElementById('advance-form-container');
            if (container) container.innerHTML = '';
            openDetail(p.id);
        }
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

// -----------------------------------------------------------------------------
// B3 Helpers: Selección de Firmante Contractual y Validación de Cierre
// -----------------------------------------------------------------------------

function renderActivePowersOptions(client, selectedPowerId) {
    const powers = (client && Array.isArray(client.apoderadosVigentes)) ? client.apoderadosVigentes : [];
    if (powers.length === 0) {
        return '<option value="">-- Sin apoderados con poder vigente --</option>';
    }
    return '<option value="">-- Seleccionar apoderado acreditado --</option>' +
        powers.map(pw => {
            const id = pw.id || pw.powerId;
            const sel = (selectedPowerId && selectedPowerId === id) ? 'selected' : '';
            return `<option value="${escapeHtmlDoc(id)}" ${sel}>${escapeHtmlDoc(pw.nombreApoderado || 'Apoderado')} (Vigente)</option>`;
        }).join('');
}

function renderSignatoryStatusFeedback(client, firmante) {
    if (!firmante || !firmante.tipo) {
        return 'ℹ️ Seleccione si el contrato lo suscribirá el Representante Legal vigente o un Apoderado con poder notarial.';
    }
    if (firmante.tipo === 'representante_legal') {
        const rl = client && client.representanteLegalVigente;
        if (rl && rl.estado === 'vigente') {
            return `🟢 <strong>Representante Legal:</strong> ${escapeHtmlDoc(rl.nombre)} (Nombramiento vigente en el expediente).`;
        }
        return `🔴 <strong>Atención:</strong> La cuenta no tiene un nombramiento vigente de Representante Legal. Debe registrarse en el expediente societario.`;
    }
    if (firmante.tipo === 'apoderado') {
        const powers = (client && Array.isArray(client.apoderadosVigentes)) ? client.apoderadosVigentes : [];
        if (powers.length === 0) {
            return `🔴 <strong>Sin Apoderados:</strong> La cuenta no tiene apoderados con poder vigente. Registre o acredite un poder antes de cerrar.`;
        }
        return `🟢 <strong>Apoderado Facultado:</strong> Seleccione el apoderado acreditado con poder notarial para firma de contratos.`;
    }
    return '';
}

function toggleClosingContractSection(isChecked) {
    const p = document.getElementById('closing-contract-signatory-panel');
    if (p) p.style.display = isChecked ? 'block' : 'none';
}

function onClosingSignatoryTypeChange(val, accountId) {
    const container = document.getElementById('closing-apoderado-select-container');
    const feedback = document.getElementById('closing-signatory-feedback');
    if (container) container.style.display = (val === 'apoderado') ? 'block' : 'none';
    if (feedback) {
        const clientList = (typeof _deps !== 'undefined' && typeof _deps.getClients === 'function')
            ? _deps.getClients() : ((typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : []);
        const client = clientList.find(x => x && x.id === accountId) || {};
        feedback.innerHTML = renderSignatoryStatusFeedback(client, { tipo: val });
    }
}

async function runB3CloseValidation(prospectId, accountId) {
    const resEl = document.getElementById('closing-b3-validation-result');
    const btn = document.getElementById('btn-validate-b3-close');
    if (!resEl) return;

    const reqContratoEl = document.getElementById('closing-requiere-contrato');
    const requiereContrato = reqContratoEl ? reqContratoEl.checked : false;

    let firmante = null;
    if (requiereContrato) {
        const tipoEl = document.getElementById('closing-firmante-tipo');
        const pwEl = document.getElementById('closing-firmante-power-id');
        const tipo = tipoEl ? tipoEl.value : null;
        if (tipo === 'representante_legal') {
            firmante = { tipo: 'representante_legal' };
        } else if (tipo === 'apoderado') {
            firmante = { tipo: 'apoderado', powerId: pwEl ? pwEl.value : null };
        }
    }

    resEl.style.display = 'block';
    resEl.innerHTML = '<div style="font-size:0.78rem; color:var(--text-muted); padding:8px; background:rgba(0,0,0,0.3); border-radius:4px;">⏳ Validando expediente con el backend de DUCTSAL...</div>';
    if (btn) btn.disabled = true;

    try {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.validateAccountDocumentsForOpportunityClose !== 'function') {
            throw new Error('Módulo CrmAccountDocuments no disponible.');
        }

        const res = await CrmAccountDocuments.validateAccountDocumentsForOpportunityClose(fb, {
            accountId,
            prospectId,
            requiereContrato,
            firmante,
            dbSuffix: (typeof _deps !== 'undefined' && typeof _deps.getDbSuffix === 'function') ? _deps.getDbSuffix() : ((typeof window !== 'undefined' && window.DB_SUFFIX) ? window.DB_SUFFIX : DB_SUFFIX)
        });

        if (res.valid) {
            resEl.innerHTML = `
                <div style="font-size:0.8rem; background:rgba(16,185,129,0.15); border:1px solid #10b981; color:#a7f3d0; padding:10px; border-radius:6px;">
                    ✅ <strong>Expediente Validado Exitosamente:</strong> Todos los documentos legales y fiscales obligatorios están vigentes y al día. ${requiereContrato ? 'Firmante contractual debidamente acreditado.' : 'No requiere contrato.'}
                </div>
            `;
        } else {
            resEl.innerHTML = `
                <div style="font-size:0.8rem; background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:12px; border-radius:6px;">
                    <div style="font-weight:700; margin-bottom:4px;">⚠️ Validación Backend: Requisitos pendientes para el cierre:</div>
                    <ul style="margin:0 0 10px 0; padding-left:1.2rem; line-height:1.4;">
                        ${(res.blockingReasons || []).map(r => `<li>${escapeHtmlDoc(r)}</li>`).join('')}
                    </ul>
                    <div style="display:flex; flex-wrap:wrap; gap:6px; padding-top:8px; border-top:1px dashed rgba(239,68,68,0.4);">
                        <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px;" onclick="ClientDocuments.openRLElectionView('${accountId}', { originView: 'detail-view', prospectId: '${prospectId}' })">⚖️ Registrar / Cambiar RL</button>
                        <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px;" onclick="ClientDocuments.openGrantPowerView('${accountId}', { originView: 'detail-view', prospectId: '${prospectId}' })">📜 Registrar Apoderado / Poder</button>
                        <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px;" onclick="ClientDocuments.openBiennialConfirmationView('${accountId}', { originView: 'detail-view', prospectId: '${prospectId}' })">🗓️ Confirmación Bienal</button>
                        <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px;" onclick="openClientDetailView('${accountId}', { originView: 'detail-view', prospectId: '${prospectId}' })">✏️ Resolver en Ficha de Cliente</button>
                    </div>
                </div>
            `;
        }
    } catch (e) {
        console.error('Error in B3 validation check:', e);
        resEl.innerHTML = `
            <div style="font-size:0.8rem; background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:8px; border-radius:6px;">
                ❌ Error al validar con backend: ${escapeHtmlDoc(e.message || 'Error desconocido')}
            </div>
        `;
    } finally {
        if (btn) btn.disabled = false;
    }
}

if (typeof window !== 'undefined') {
    window.toggleClosingContractSection = toggleClosingContractSection;
    window.onClosingSignatoryTypeChange = onClosingSignatoryTypeChange;
    window.runB3CloseValidation = runB3CloseValidation;
}

function renderClosingDocumentationPanel(p) {
    const container = document.getElementById('advance-form-container');
    if (!container) return;

    var currentUser = ((typeof _deps !== 'undefined' && _deps.getCurrentUser) ? _deps.getCurrentUser() : null) || (typeof window !== 'undefined' ? window.currentUser : (typeof global !== 'undefined' ? global.currentUser : null));
    const clientList = _deps.getClients();
    const users = _deps.getUsers();
    const settings = _deps.getSettings();
    const c = (Array.isArray(clientList) ? clientList : []).find(x => x && x.id === p.clientId) || {};
    const clientDocs = (c && c.documentos && typeof c.documentos === 'object') ? c.documentos : {};
    const datos = (p && p.datos && typeof p.datos === 'object') ? p.datos : {};
    const isWon = p.estado === 'ganado';

    const sla = typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.calculateStageSla === 'function'
        ? CrmFollowUpCalc.calculateStageSla(p, new Date())
        : { elapsedBusinessDays: 0, limitBusinessDays: 5, diasAtraso: 0, isOverdue: false, fechaInicio: p.fecha_inicio_cierre || null, fechaLimite: p.fecha_limite_cierre || null };

    const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));

    // Evaluación estricta de autorización sin contrato (Fase 4B.3 / 4B.4 / 4C)
    const aprobacionSinContrato = p.aprobacion_sin_contrato || (datos && datos.aprobacion_sin_contrato) || null;
    const isApprovalInvalidated = (aprobacionSinContrato && aprobacionSinContrato.estado === 'invalidada_por_sustitucion');
    
    // H-01: Si hay monto autorizado registrado, debe coincidir exactamente a centavos con precio_cotizado
    let approvalAmountValid = true;
    if (isBigInstalacion && p.estado === 'activo' && aprobacionSinContrato && typeof aprobacionSinContrato.montoAutorizado === 'number') {
        const curP = parseFloat(p.precio_cotizado) || 0;
        const autP = aprobacionSinContrato.montoAutorizado;
        approvalAmountValid = (Math.round(curP * 100) === Math.round(autP * 100));
    }

    const isApprovalActive = !isApprovalInvalidated && approvalAmountValid && (
        datos.autorizado_sin_contrato === true ||
        (aprobacionSinContrato && aprobacionSinContrato.estado === 'aprobada') ||
        (p.solicitud_sin_contrato && p.solicitud_sin_contrato.estado === 'aprobada')
    );

    // Evaluaciones documentales con soporte de alias históricos
    const hasDui = !!(clientDocs.dui || clientDocs.dui_rep);
    const hasEscritura = !!(clientDocs.escritura || clientDocs.escritura_constitucion);
    const hasCredencial = !!(clientDocs.credencial || clientDocs.credencial_rep);
    const hasNit = !!(clientDocs.nit || clientDocs.nit_empresa || clientDocs.nit_rep);
    const hasNrc = !!(clientDocs.nrc || clientDocs.nrc_empresa);
    const hasCompanyDocs = !isBigInstalacion || isApprovalActive || (c.tipo !== 'juridica') || (hasEscritura && hasCredencial && hasNit && hasNrc);
    const activeDocFirmado = datos.doc_firmado || (isBigInstalacion && !isApprovalActive ? (datos.doc_contrato || datos.doc_firmado) : (datos.doc_oferta_firmada || datos.doc_firmado));
    const hasDocFirmado = !!activeDocFirmado;
    const hasDocComprobante = !!datos.doc_comprobante;
    const hasFacturaAnticipo = !!(p.factura_anticipo || datos.factura_anticipo);
    const hasFormaPago = !!(p.forma_pago || datos.forma_pago);
    const hasEncargado = (p.tipo_proyecto !== 'Fabricación e instalación') || !!(p.encargado || datos.encargado);

    // Listas de estado documental
    const reqList = [];
    const okList = [];
    const pendingList = [];

    // DUI
    reqList.push("DUI de identificación (Cliente)");
    if (hasDui) okList.push("DUI de identificación");
    else pendingList.push("DUI de identificación");

    // Jurídica Docs
    if (isBigInstalacion && !isApprovalActive && c.tipo === 'juridica') {
        reqList.push("Documentos legales corporativos (Escritura, Credencial, NIT, NRC)");
        if (hasCompanyDocs) okList.push("Documentos legales corporativos");
        else pendingList.push("Documentos legales corporativos");
    }

    // Contrato u Oferta
    if (isBigInstalacion && !isApprovalActive) {
        reqList.push("Contrato firmado escaneado (Proyecto > $10k)");
        if (hasDocFirmado) okList.push("Contrato firmado escaneado");
        else pendingList.push("Contrato firmado escaneado");
    } else {
        reqList.push("Oferta firmada por cliente");
        if (hasDocFirmado) okList.push("Oferta firmada por cliente");
        else pendingList.push("Oferta firmada por cliente");
    }

    // Comprobante y CCF de anticipo: hitos financieros posteriores (no bloquean el cierre comercial)
    if (hasDocComprobante) okList.push("Comprobante / CCF de anticipo");
    if (hasFacturaAnticipo) okList.push(`Factura de anticipo (#${p.factura_anticipo || datos.factura_anticipo})`);

    // Forma de pago
    reqList.push("Forma de pago acordada");
    if (hasFormaPago) okList.push(`Forma de pago (${p.forma_pago || datos.forma_pago})`);
    else pendingList.push("Forma de pago acordada");

    // Encargado si aplica
    if (p.tipo_proyecto === 'Fabricación e instalación') {
        reqList.push("Encargado de instalación");
        if (hasEncargado) okList.push(`Encargado (${p.encargado || datos.encargado})`);
        else pendingList.push("Encargado de instalación");
    }

    const isContractualRequired = (p && (p.requiere_contrato === true || (datos && datos.requiere_contrato === true))) || false;
    const currentFirmante = (p && (p.firmante_cierre || (datos && datos.firmante_cierre))) || null;
    const currentFirmanteTipo = (currentFirmante && currentFirmante.tipo) || '';
    const currentFirmantePowerId = (currentFirmante && (currentFirmante.powerId || currentFirmante.id)) || '';

    // Requerimiento Contractual B3
    if (isContractualRequired) {
        reqList.push("Contrato formal y acreditación de firmante");
        if (currentFirmanteTipo === 'representante_legal') {
            const rl = c && c.representanteLegalVigente;
            if (rl && rl.estado === 'vigente') {
                okList.push(`Firmante: RL (${rl.nombre || 'Vigente'})`);
            } else {
                pendingList.push("Acreditación vigente de Representante Legal para firma");
            }
        } else if (currentFirmanteTipo === 'apoderado') {
            const powers = (c && Array.isArray(c.apoderadosVigentes)) ? c.apoderadosVigentes : [];
            const pw = powers.find(x => (x.id === currentFirmantePowerId || x.powerId === currentFirmantePowerId));
            if (pw && pw.estado === 'vigente') {
                okList.push(`Firmante: Apoderado (${pw.nombreApoderado || 'Poder Vigente'})`);
            } else {
                pendingList.push("Acreditación de Apoderado con poder vigente para firma");
            }
        } else {
            pendingList.push("Designación de firmante facultado para el contrato");
        }
    }

    const respName = (typeof users !== 'undefined' && Array.isArray(users))
        ? ((users.find(u => u.id === (p.vendedorId || p.createdBy)) || {}).nombre || p.vendedorId || 'No asignado')
        : (p.vendedorId || 'No asignado');

    let encOpts = (typeof settings !== 'undefined' && settings.encargados)
        ? settings.encargados.map(e => `<option value="${e}" ${(p.encargado || datos.encargado) === e ? 'selected' : ''}>${e}</option>`).join('')
        : '';
    if (!encOpts) encOpts = `<option value="">-- Sin encargados (Configure en ajustes) --</option>`;

    const currentFp = p.forma_pago || datos.forma_pago || '';
    const currentFac = p.factura_anticipo || datos.factura_anticipo || '';

    // =========================================================================
    // Definición de documentos del cliente a mostrar contextualmente
    // =========================================================================
    const clientDocSpecs = (c.tipo === 'juridica') ? [
        { key: 'dui', aliases: ['dui_rep'], label: 'DUI Rep. Legal', isLegal: false, required: true },
        { key: 'escritura', aliases: ['escritura_constitucion'], label: 'Escritura de Constitución', isLegal: true, required: isBigInstalacion && !isApprovalActive },
        { key: 'credencial', aliases: ['credencial_rep'], label: 'Credencial Rep. Legal', isLegal: true, required: isBigInstalacion && !isApprovalActive },
        { key: 'nit', aliases: ['nit_empresa', 'nit_rep'], label: 'NIT Empresa', isLegal: true, required: isBigInstalacion && !isApprovalActive },
        { key: 'nrc', aliases: ['nrc_empresa'], label: 'NRC Empresa', isLegal: true, required: isBigInstalacion && !isApprovalActive },
        { key: 'mods_escritura', aliases: ['mods'], label: 'Mods. Escritura', isLegal: true, required: false }
    ] : [
        { key: 'dui', aliases: ['dui_rep'], label: 'DUI de Identificación', isLegal: false, required: true },
        { key: 'nit', aliases: ['nit_rep', 'nit_empresa'], label: 'NIT Personal', isLegal: true, required: false }
    ];

    let clientDocsRowsHtml = '';
    for (const spec of clientDocSpecs) {
        let doc = clientDocs[spec.key];
        let actualKey = spec.key;
        if (!doc && spec.aliases) {
            for (const alias of spec.aliases) {
                if (clientDocs[alias]) {
                    doc = clientDocs[alias];
                    actualKey = alias;
                    break;
                }
            }
        }
        const isPresent = !!doc;
        const reqBadge = spec.required
            ? `<span style="font-size:0.7rem; color:#f87171; font-weight:600; margin-left:4px;">[Obligatorio]</span>`
            : `<span style="font-size:0.7rem; color:var(--text-muted); margin-left:4px;">[Opcional]</span>`;

        let docMeta = '';
        let fileActions = '';
        const fileName = isPresent ? ((typeof doc === 'object' && doc.name) ? doc.name : (typeof doc === 'string' ? doc.split('?')[0].split('/').pop() : spec.label)) : '';
        if (isPresent) {
            const dateStr = (typeof doc === 'object' && doc.actualizadoEn) ? doc.actualizadoEn.replace('T', ' ').slice(0, 16) : '';
            docMeta = `
                <div style="font-size:0.8rem; color:var(--success); display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:2px;">
                    <span>✅ <strong>${escapeHtmlDoc(fileName)}</strong></span>
                    ${dateStr ? `<span style="font-size:0.72rem; color:var(--text-muted);">(${dateStr})</span>` : ''}
                </div>
            `;
            const storeId = 'cdoc_cierre_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
            getDocStore().set(storeId, {
                docRef: doc,
                fileName: fileName,
                label: spec.label,
                clientId: c.id,
                docKey: actualKey
            });
            fileActions = `
                <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">
                    <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="viewStoredClientDoc('${storeId}')" title="Ver documento">👁️ Ver</button>
                    <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="downloadStoredClientDoc('${storeId}')" title="Descargar documento">⬇️</button>
                    <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="showDocumentVersionHistory('client', '${c.id}', '${actualKey}', '${escapeHtmlDoc(spec.label)}')" title="Consultar historial de versiones">📜 Historial</button>
                    ${!isWon ? `<button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem; border-color:var(--brand-gold); color:var(--brand-gold);" onclick="toggleClientDocSubstForm('${actualKey}')" title="Sustituir por nueva versión">🔄 Sustituir</button>` : ''}
                </div>
            `;
        } else {
            docMeta = `<div style="font-size:0.78rem; color:#fca5a5; margin-top:2px;">⚠️ No adjunto en el expediente</div>`;
            if (!isWon) {
                fileActions = `
                    <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                        <input type="file" id="closing-client-file-${actualKey}" style="font-size:0.75rem; max-width:100%; box-sizing:border-box;">
                        <button type="button" class="btn-primary" style="padding:3px 10px; font-size:0.75rem;" onclick="uploadClientDocumentFromClosing('${c.id}', '${p.id}', '${actualKey}', false)" title="Subir primera versión">📤 Subir</button>
                    </div>
                `;
            }
        }

        const substFormHtml = (isPresent && !isWon) ? `
            <div id="subst-container-client-${actualKey}" class="subst-form-panel" style="display:none; margin-top:10px; padding:14px; background:rgba(15, 23, 42, 0.95); border:1px solid var(--brand-gold); border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                    <div>
                        <div style="font-size:0.85rem; font-weight:700; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                            <span>🔄 Sustituir Versión:</span> <span>${escapeHtmlDoc(spec.label)}</span>
                        </div>
                        <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">
                            Archivo vigente: <strong style="color:white;">${escapeHtmlDoc(fileName)}</strong>
                        </div>
                    </div>
                    <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="cancelClientDocSubstForm('${actualKey}')" title="Cancelar">✖️</button>
                </div>

                <div style="background:rgba(245, 158, 11, 0.12); border-left:3px solid #f59e0b; padding:8px 10px; border-radius:4px; font-size:0.75rem; color:#fde68a; margin-bottom:10px;">
                    ⚠️ <strong>Aviso de Versionado:</strong> El archivo actual se archivará de forma inmutable en el historial con su sello de tiempo y responsable. Debe justificar el reemplazo.
                </div>

                <div style="display:flex; flex-direction:column; gap:10px;">
                    <div>
                        <label for="closing-client-subst-file-${actualKey}" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">
                            Nuevo archivo (PDF, JPG, PNG) <span style="color:#ef4444;">*</span>
                        </label>
                        <input type="file" id="closing-client-subst-file-${actualKey}" accept=".pdf,.png,.jpg,.jpeg,.webp" style="font-size:0.78rem; width:100%; color:var(--text-secondary);">
                    </div>

                    <div>
                        <label for="closing-client-motivo-${actualKey}" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">
                            Motivo obligatorio de sustitución <span style="color:#ef4444;">*</span>
                        </label>
                        <textarea id="closing-client-motivo-${actualKey}" rows="2" placeholder="Describa el motivo por el cual se reemplaza este documento..." style="width:100%; box-sizing:border-box; font-size:0.78rem; padding:6px 10px; background:rgba(255,255,255,0.07); border:1px solid var(--panel-border); border-radius:4px; color:white; resize:vertical;"></textarea>
                        <small style="font-size:0.7rem; color:var(--text-muted); display:block; margin-top:2px;">Mínimo 3 caracteres requeridos para auditoría.</small>
                    </div>

                    <div id="closing-client-subst-feedback-${actualKey}" style="display:none; font-size:0.75rem; padding:6px 10px; border-radius:4px;"></div>

                    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
                        <button type="button" class="btn-secondary" id="btn-cancel-subst-${actualKey}" onclick="cancelClientDocSubstForm('${actualKey}')" style="padding:5px 12px; font-size:0.78rem;">Cancelar</button>
                        <button type="button" class="btn-primary" id="btn-confirm-client-subst-${actualKey}" onclick="uploadClientDocumentFromClosing('${c.id}', '${p.id}', '${actualKey}', true)" style="padding:5px 14px; font-size:0.78rem; background:var(--brand-gold); color:black; font-weight:600;">Confirmar Reemplazo</button>
                    </div>
                </div>
            </div>
        ` : '';

        clientDocsRowsHtml += `
            <div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <div>
                        <strong style="font-size:0.85rem; color:var(--text-primary);">${escapeHtmlDoc(spec.label)}</strong>
                        ${reqBadge}
                        ${docMeta}
                    </div>
                    <div>
                        ${fileActions}
                    </div>
                </div>
                ${substFormHtml}
            </div>
        `;
    }

    // Nombre y metadata de documentos propios del cierre
    const firmadoName = (activeDocFirmado && typeof activeDocFirmado === 'object' && activeDocFirmado.name)
        ? activeDocFirmado.name
        : (typeof activeDocFirmado === 'string' ? activeDocFirmado.split('?')[0].split('/').pop() : 'Oferta / Contrato');

    const comprobanteName = (datos.doc_comprobante && typeof datos.doc_comprobante === 'object' && datos.doc_comprobante.name)
        ? datos.doc_comprobante.name
        : (typeof datos.doc_comprobante === 'string' ? datos.doc_comprobante.split('?')[0].split('/').pop() : 'Comprobante Anticipo');

    let firmadoDocStoreId = '';
    if (hasDocFirmado) {
        firmadoDocStoreId = 'pdoc_firmado_' + Math.random().toString(36).substring(2, 9);
        getDocStore().set(firmadoDocStoreId, {
            docRef: activeDocFirmado,
            fileName: firmadoName,
            prospectId: p.id
        });
    }

    let compDocStoreId = '';
    if (hasDocComprobante) {
        compDocStoreId = 'pdoc_comp_' + Math.random().toString(36).substring(2, 9);
        getDocStore().set(compDocStoreId, {
            docRef: datos.doc_comprobante,
            fileName: comprobanteName,
            prospectId: p.id
        });
    }

    let html = `
    <div class="closing-panel glass-panel">
        <!-- Cabecera de SLA y Estado -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--panel-border); padding-bottom: 1rem; margin-bottom: 1.25rem; flex-wrap: wrap; gap: 1rem;">
            <div>
                <h4 style="margin: 0; color: var(--brand-gold); display: flex; align-items: center; gap: 8px;">
                    <span>📁 Cierre Comercial: Documentación y Validación</span>
                </h4>
                <p style="margin: 4px 0 0 0; font-size: 0.85rem; color: var(--text-secondary);">
                    Responsable de cierre: <strong style="color: white;">${escapeHtmlDoc(respName)}</strong>
                </p>
            </div>
            <div style="text-align: right;">
                ${isWon ? `
                    <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--success); border: 1px solid var(--success); font-size: 0.85rem; padding: 4px 10px;">🏆 Oportunidad Ganada (Cerrada)</span>
                ` : sla.isOverdue
                    ? `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); font-size: 0.85rem; padding: 4px 10px;">🚨 Plazo Vencido (+${sla.diasAtraso} días hábiles de atraso)</span>`
                    : `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--success); border: 1px solid var(--success); font-size: 0.85rem; padding: 4px 10px;">⏱️ Dentro del Plazo (${Math.max(0, 5 - sla.elapsedBusinessDays)} días hábiles restantes)</span>`
                }
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">
                    Entrada a Cierre: <strong>${sla.fechaInicio || p.fecha_inicio_cierre || '-'}</strong> | Límite (5d hábiles): <strong>${sla.fechaLimite || p.fecha_limite_cierre || '-'}</strong>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">
                    Días hábiles transcurridos: <strong>${sla.elapsedBusinessDays}</strong> de 5 permitidos
                </div>
            </div>
        </div>

        <!-- Checklist de Validación Documental -->
        <div class="closing-checklist-grid">
            <!-- Documentos Requeridos -->
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--panel-border); border-radius: 6px; padding: 0.75rem 1rem;">
                <div style="font-size: 0.82rem; font-weight: bold; color: var(--text-primary); margin-bottom: 0.5rem;">📋 Requisitos de Cierre (${reqList.length})</div>
                <ul style="font-size: 0.78rem; color: var(--text-secondary); margin: 0; padding-left: 1.2rem; line-height: 1.5;">
                    ${reqList.map(r => `<li>${escapeHtmlDoc(r)}</li>`).join('')}
                </ul>
            </div>

            <!-- Cargados y Validados -->
            <div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px; padding: 0.75rem 1rem;">
                <div style="font-size: 0.82rem; font-weight: bold; color: var(--success); margin-bottom: 0.5rem;">✅ Cargados y Validados (${okList.length})</div>
                <ul style="font-size: 0.78rem; color: #a7f3d0; margin: 0; padding-left: 1.2rem; line-height: 1.5;">
                    ${okList.length > 0 ? okList.map(r => `<li>${escapeHtmlDoc(r)}</li>`).join('') : '<li style="color:var(--text-muted);">Ningún documento validado aún</li>'}
                </ul>
            </div>

            <!-- Pendientes -->
            <div style="background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; padding: 0.75rem 1rem;">
                <div style="font-size: 0.82rem; font-weight: bold; color: ${pendingList.length > 0 ? 'var(--danger)' : 'var(--success)'}; margin-bottom: 0.5rem;">
                    ${pendingList.length > 0 ? `⚠️ Pendientes (${pendingList.length})` : '🎉 ¡Expediente Completo!'}
                </div>
                <ul style="font-size: 0.78rem; color: ${pendingList.length > 0 ? '#fca5a5' : 'var(--success)'}; margin: 0; padding-left: 1.2rem; line-height: 1.5;">
                    ${pendingList.length > 0 ? pendingList.map(r => `<li>${escapeHtmlDoc(r)}</li>`).join('') : '<li>Todos los requisitos obligatorios están cumplidos. Puedes finalizar la oportunidad.</li>'}
                </ul>
            </div>
        </div>

        <!-- Alerta de Autorización Invalidada por sustitución de oferta previa -->
        ${isApprovalInvalidated ? `
            <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1.25rem; font-size: 0.85rem; color: #fca5a5;">
                🚨 <strong>AUTORIZACIÓN INVALIDADA POR SUSTITUCIÓN DE OFERTA:</strong> La autorización previa para cerrar sin contrato fue invalidada automáticamente porque se sustituyó la oferta firmada (${escapeHtmlDoc(aprobacionSinContrato.motivo_invalidacion || 'Sustitución de oferta')}). Se requiere que un Gerente reautorice la nueva oferta antes de poder finalizar el cierre.
            </div>
        ` : ''}

        <!-- Autorización de Contrato (si aplica para proyectos grandes) -->
        ${isBigInstalacion ? `
            <div style="margin-bottom: 1.25rem;">
                ${isApprovalActive ? `
                    <div style="background: rgba(46, 204, 113, 0.1); border: 1px solid var(--success); padding: 0.75rem; border-radius: 6px;">
                        <span style="color: var(--success); font-weight: bold;">✔️ Cierre Sin Contrato Autorizado</span>
                        <p style="font-size: 0.75rem; color: var(--text-secondary); margin: 4px 0 0 0;">
                            Autorizado por: <strong>${escapeHtmlDoc(datos.autorizado_por || (aprobacionSinContrato && aprobacionSinContrato.autorizado_por) || 'Gerencia')}</strong>
                        </p>
                    </div>
                ` : `
                    <div style="background: rgba(212, 175, 55, 0.1); border: 1px solid var(--brand-gold); padding: 0.75rem; border-radius: 6px;">
                        <div style="font-weight: bold; color: var(--brand-gold);">⚠️ Venta > $10k e Instalación: Requiere Contrato o Autorización Gerencial</div>
                        <p style="font-size: 0.75rem; color: var(--text-secondary); margin: 4px 0 8px 0;">
                            Si el Gerente aprueba exceptuar el contrato, puede autorizarlo desde su sesión o a través de la solicitud de excepción.
                        </p>
                        ${(currentUser && currentUser.role === 'manager') ? `
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--brand-gold); font-weight: bold; margin-bottom: 6px;">
                                <input type="checkbox" id="closing-auth-no-contract-checkbox" onchange="toggleManagerApprovalInForm(this.checked)">
                                <span>Autorizar sin Contrato (Modo Gerente)</span>
                            </label>
                        ` : ''}
                        ${typeof renderNoContractRequestHTML === 'function' ? renderNoContractRequestHTML(p) : ''}
                    </div>
                `}
            </div>
        ` : ''}

        <!-- SECCIÓN 1: EXPEDIENTE DOCUMENTAL DEL CLIENTE (Contextual 4B.4) -->
        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(212, 175, 55, 0.25); border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 0.5rem; margin-bottom: 0.75rem;">
                <div>
                    <h5 style="margin: 0; color: var(--brand-gold); font-size: 0.92rem; display: flex; align-items: center; gap: 6px;">
                        <span>📇 Documentación del Cliente</span>
                    </h5>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                        Expediente de <strong>${escapeHtmlDoc(c.empresa || (c.nombres ? `${c.nombres} ${c.apellidos || ''}`.trim() : 'Cliente'))}</strong> (${c.tipo === 'juridica' ? 'Persona Jurídica' : 'Persona Natural'}). Gestiona los recaudos directamente desde este panel o en vista de pantalla completa.
                    </div>
                </div>
                <button type="button" class="btn-secondary" style="font-size: 0.75rem; padding: 4px 10px;" onclick="openClientDetailView('${c.id}', { originView: 'detail-view', prospectId: '${p.id}' })">
                    ✏️ Editar Cliente en Vista Completa
                </button>
            </div>

            <!-- Listado de documentos del cliente con estado, consulta e inline upload/substitution -->
            <div style="display: flex; flex-direction: column;">
                ${clientDocsRowsHtml}
            </div>
        </div>

        <!-- SECCIÓN B3: REQUERIMIENTO CONTRACTUAL Y PODERES DE FIRMA (Fase 2 - B3) -->
        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 0.5rem; margin-bottom: 0.75rem;">
                <div>
                    <h5 style="margin: 0; color: #60a5fa; font-size: 0.92rem; display: flex; align-items: center; gap: 6px;">
                        <span>⚖️ Control Contractual y Representación Legal (B3)</span>
                    </h5>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                        Definición explícita de suscripción de contrato comercial y acreditación del firmante societario en vistas de pantalla completa.
                    </div>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                    <button type="button" class="btn-secondary" style="font-size: 0.74rem; padding: 4px 10px; border-color: #ef4444; color: #f87171;" onclick="ClientDocuments.openRLElectionView('${c.id}', { originView: 'detail-view', prospectId: '${p.id}' })">
                        ⚖️ Registrar / Cambiar RL
                    </button>
                    <button type="button" class="btn-secondary" style="font-size: 0.74rem; padding: 4px 10px; border-color: #38bdf8; color: #38bdf8;" onclick="ClientDocuments.openGrantPowerView('${c.id}', { originView: 'detail-view', prospectId: '${p.id}' })">
                        📜 Registrar Apoderado
                    </button>
                    <button type="button" class="btn-secondary" style="font-size: 0.74rem; padding: 4px 10px; border-color: #34d399; color: #34d399;" onclick="ClientDocuments.openBiennialConfirmationView('${c.id}', { originView: 'detail-view', prospectId: '${p.id}' })">
                        🗓️ Confirmación Bienal
                    </button>
                    <button type="button" class="btn-secondary" style="font-size: 0.74rem; padding: 4px 10px; border-color: #fbbf24; color: #fbbf24;" onclick="ClientDocuments.openDossierHistoryView('${c.id}', { originView: 'detail-view', prospectId: '${p.id}' })">
                        🗂️ Historial B3
                    </button>
                </div>
            </div>

            <!-- Checkbox de Requerimiento de Contrato -->
            <div style="margin-bottom: 1rem;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); font-size: 0.88rem; font-weight: 600;">
                    <input type="checkbox" id="closing-requiere-contrato" ${isContractualRequired ? 'checked' : ''} ${isWon ? 'disabled' : ''} onchange="toggleClosingContractSection(this.checked)" style="transform: scale(1.15);">
                    <span>Esta oportunidad requiere suscripción de Contrato Formal</span>
                </label>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-left: 28px; margin-top: 2px;">
                    Si se marca, el cierre exigirá que la cuenta tenga Representante Legal acreditado o Apoderado con poder notarial vigente.
                </div>
            </div>

            <!-- Panel condicional de Firmante -->
            <div id="closing-contract-signatory-panel" style="${isContractualRequired ? 'display:block;' : 'display:none;'} background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 6px; padding: 12px; margin-bottom: 1rem;">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; align-items: start;">
                    <div>
                        <label for="closing-firmante-tipo" style="display:block; font-size:0.78rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">
                            Sujeto Facultado para Firmar el Contrato <span style="color:#ef4444;">*</span>
                        </label>
                        <select id="closing-firmante-tipo" class="form-control" ${isWon ? 'disabled' : ''} onchange="onClosingSignatoryTypeChange(this.value, '${c.id}')" style="width:100%; font-size:0.8rem; padding:6px 10px; background:rgba(255,255,255,0.07); border:1px solid var(--panel-border); border-radius:4px; color:white;">
                            <option value="">-- Seleccionar firmante --</option>
                            <option value="representante_legal" ${currentFirmanteTipo === 'representante_legal' ? 'selected' : ''}>Representante Legal de la Sociedad</option>
                            <option value="apoderado" ${currentFirmanteTipo === 'apoderado' ? 'selected' : ''}>Apoderado con Poder Notarial para Contratos</option>
                        </select>
                    </div>

                    <div id="closing-apoderado-select-container" style="${currentFirmanteTipo === 'apoderado' ? 'display:block;' : 'display:none;'}">
                        <label for="closing-firmante-power-id" style="display:block; font-size:0.78rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">
                            Poder Notarial Vigente <span style="color:#ef4444;">*</span>
                        </label>
                        <select id="closing-firmante-power-id" class="form-control" ${isWon ? 'disabled' : ''} style="width:100%; font-size:0.8rem; padding:6px 10px; background:rgba(255,255,255,0.07); border:1px solid var(--panel-border); border-radius:4px; color:white;">
                            ${renderActivePowersOptions(c, currentFirmantePowerId)}
                        </select>
                    </div>
                </div>

                <div id="closing-signatory-feedback" style="font-size:0.78rem; color:var(--text-secondary); margin-top:8px; padding:6px 10px; background:rgba(0,0,0,0.25); border-radius:4px;">
                    ${renderSignatoryStatusFeedback(c, currentFirmante)}
                </div>
            </div>

            <!-- Botón de Pre-validación B3 -->
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <button type="button" class="btn-secondary" id="btn-validate-b3-close" onclick="runB3CloseValidation('${p.id}', '${c.id}')" style="font-size:0.78rem; padding:5px 12px; display:inline-flex; align-items:center; gap:6px;">
                    <span>🔍</span> Pre-validar Requisitos Legales y Fiscales para Cierre
                </button>
                <span style="font-size:0.72rem; color:var(--text-muted);">Comprueba vigencia de DUI, Credencial, Escritura y Poderes con el backend.</span>
            </div>
            <div id="closing-b3-validation-result" style="display:none; margin-top:10px;"></div>
        </div>

        <!-- SECCIÓN 2: DOCUMENTOS PROPIOS DEL CIERRE DE LA OPORTUNIDAD -->
        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1.5rem;">
            <h5 style="margin: 0 0 0.75rem 0; color: var(--brand-gold); font-size: 0.92rem; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 0.5rem;">
                <span>📑 Documentación y Datos de la Oportunidad</span>
            </h5>

            <div class="form-grid" style="margin-bottom: 1rem;">
                <div class="form-group">
                    <label>Forma de Pago Pactada</label>
                    <select id="closing-forma-pago" required ${isWon ? 'disabled' : ''}>
                        <option value="">-- Seleccione --</option>
                        <option value="100% anticipado" ${currentFp === '100% anticipado' ? 'selected' : ''}>100% Anticipado</option>
                        <option value="70/30" ${currentFp === '70/30' ? 'selected' : ''}>70% Anticipo / 30% Cierre</option>
                        <option value="50/50" ${currentFp === '50/50' ? 'selected' : ''}>50% Anticipo / 50% Cierre</option>
                    </select>
                </div>

                <div class="form-group">
                    <label>Número Factura / CCF de Anticipo <span style="font-size:0.72rem; color:var(--text-secondary); font-weight:normal;">(Opcional en cierre comercial — Hito posterior)</span></label>
                    <input type="text" id="closing-fac-anticipo" value="${escapeHtmlDoc(currentFac)}" placeholder="Ej. FCF-001 (o registrar en postcierre)" ${isWon ? 'disabled' : ''}>
                </div>

                ${p.tipo_proyecto === 'Fabricación e instalación' ? `
                    <div class="form-group">
                        <label>Encargado de Instalación</label>
                        <select id="closing-encargado" required ${isWon ? 'disabled' : ''}>
                            <option value="">-- Seleccione --</option>
                            ${encOpts}
                        </select>
                    </div>
                ` : ''}

                <!-- Subida de Oferta / Contrato -->
                <div class="form-group full-width" style="padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <label style="margin: 0;">${(isBigInstalacion && !isApprovalActive) ? 'Contrato Firmado (Proyecto > $10k)' : 'Oferta Firmada por Cliente'}</label>
                        ${hasDocFirmado ? `
                            <div style="display: flex; gap: 4px; align-items: center;">
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="viewStoredClientDoc('${firmadoDocStoreId}')" title="Ver archivo actual">👁️ Ver</button>
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="downloadStoredClientDoc('${firmadoDocStoreId}')" title="Descargar">⬇️</button>
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="showDocumentVersionHistory('prospect', '${p.id}', 'doc_firmado', 'Oferta Firmada')" title="Historial">📜 Historial</button>
                                ${!isWon ? `<button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; border-color: var(--brand-gold); color: var(--brand-gold);" onclick="toggleProspectDocSubstForm('doc_firmado')">🔄 Sustituir</button>` : ''}
                            </div>
                        ` : ''}
                    </div>

                    ${(isBigInstalacion && !isApprovalActive) ? `
                        <div style="margin-bottom: 6px;">
                            <button type="button" class="btn-secondary" style="font-size: 0.78rem; padding: 4px 8px;" onclick="generarContrato('${p.id}')">📄 Generar Contrato (Imprimible)</button>
                        </div>
                    ` : ''}

                    ${hasDocFirmado ? `
                        <div style="font-size: 0.8rem; color: var(--success); margin-bottom: 4px;">
                            ✔️ Archivo vigente cargado: <strong>${escapeHtmlDoc(firmadoName)}</strong>
                        </div>
                    ` : ''}

                    <div id="subst-container-prospect-doc_firmado" class="subst-form-panel" style="${hasDocFirmado ? 'display:none;' : 'display:block;'} margin-top: 8px; padding: 12px; background: rgba(15, 23, 42, 0.95); border: 1px solid ${hasDocFirmado ? 'var(--brand-gold)' : 'var(--panel-border)'}; border-radius: 8px;">
                        ${hasDocFirmado ? `
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                                <div>
                                    <div style="font-size:0.85rem; font-weight:700; color:var(--brand-gold);">🔄 Sustituir Oferta/Contrato Firmado</div>
                                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">Archivo vigente: <strong style="color:white;">${escapeHtmlDoc(firmadoName)}</strong></div>
                                </div>
                                <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="cancelProspectDocSubstForm('doc_firmado')" title="Cancelar">✖️</button>
                            </div>
                            <div style="background:rgba(245, 158, 11, 0.12); border-left:3px solid #f59e0b; padding:8px 10px; border-radius:4px; font-size:0.75rem; color:#fde68a; margin-bottom:10px;">
                                ⚠️ <strong>Aviso de Versionado:</strong> El archivo actual se archivará en el historial. La nueva versión requerirá justificación obligatoria.
                            </div>
                            ${isApprovalActive ? `
                                <div style="font-size: 0.75rem; color: #fca5a5; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; padding: 8px 10px; border-radius: 4px; margin-bottom: 10px;">
                                    ⚠️ <strong>Atención crítica:</strong> Sustituir este documento invalidará automáticamente la autorización para cerrar sin contrato. Se requerirá nueva autorización gerencial.
                                </div>
                            ` : ''}
                        ` : `
                            <label for="closing-file-doc-firmado" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Cargar documento de oferta firmada / contrato:</label>
                        `}
                        <div>
                            <label for="closing-file-doc-firmado" style="display:${hasDocFirmado ? 'block' : 'none'}; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Nuevo archivo (PDF, JPG, PNG) <span style="color:#ef4444;">*</span></label>
                            <input type="file" id="closing-file-doc-firmado" accept=".pdf,.png,.jpg,.jpeg,.webp" ${isWon ? 'disabled' : ''} style="font-size:0.78rem; width:100%;">
                            <small style="color:var(--text-secondary); display:block; margin-top:2px;">Formatos: PDF, JPG, PNG.</small>
                        </div>
                        ${hasDocFirmado ? `
                            <div style="margin-top: 8px;">
                                <label for="closing-motivo-doc-firmado" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Motivo obligatorio de sustitución <span style="color:#ef4444;">*</span></label>
                                <textarea id="closing-motivo-doc-firmado" rows="2" placeholder="Motivo obligatorio por el que se sustituye la oferta firmada..." style="font-size: 0.78rem; width: 100%; box-sizing:border-box; padding: 6px 10px; background: rgba(255,255,255,0.07); border: 1px solid var(--panel-border); border-radius: 4px; color: white; resize:vertical;"></textarea>
                                <small style="font-size:0.7rem; color:var(--text-muted); display:block; margin-top:2px;">Mínimo 3 caracteres requeridos para auditoría.</small>
                            </div>
                            <div id="closing-prospect-feedback-doc_firmado" style="display:none; font-size:0.75rem; padding:6px 10px; border-radius:4px; margin-top:6px;"></div>
                            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
                                <button type="button" class="btn-secondary" id="btn-cancel-prospect-subst-doc_firmado" onclick="cancelProspectDocSubstForm('doc_firmado')" style="padding:4px 12px; font-size:0.78rem;">Cancelar</button>
                                <button type="button" class="btn-primary" id="btn-confirm-prospect-subst-doc_firmado" onclick="confirmProspectDocSubstitution('${p.id}', 'doc_firmado')" style="padding:4px 14px; font-size:0.78rem; background:var(--brand-gold); color:black; font-weight:600;">Confirmar Reemplazo</button>
                            </div>
                        ` : ''}
                    </div>
                </div>

                <!-- Subida de Factura / Comprobante (Hito posterior no bloqueante para cierre comercial) -->
                <div class="form-group full-width" style="padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <label style="margin: 0;">Copia de Factura o CCF de Anticipo Emitido <span style="font-size:0.72rem; color:var(--text-secondary); font-weight:normal;">(Opcional al cerrar — Requerido y pagado antes de fabricación)</span></label>
                        ${hasDocComprobante ? `
                            <div style="display: flex; gap: 4px; align-items: center;">
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="viewStoredClientDoc('${compDocStoreId}')" title="Ver archivo actual">👁️ Ver</button>
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="downloadStoredClientDoc('${compDocStoreId}')" title="Descargar">⬇️</button>
                                <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="showDocumentVersionHistory('prospect', '${p.id}', 'doc_comprobante', 'Comprobante de Anticipo')" title="Historial">📜 Historial</button>
                                ${!isWon ? `<button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; border-color: var(--brand-gold); color: var(--brand-gold);" onclick="toggleProspectDocSubstForm('doc_comprobante')">🔄 Sustituir</button>` : ''}
                            </div>
                        ` : ''}
                    </div>

                    ${hasDocComprobante ? `
                        <div style="font-size: 0.8rem; color: var(--success); margin-bottom: 4px;">
                            ✔️ Archivo vigente cargado: <strong>${escapeHtmlDoc(comprobanteName)}</strong>
                        </div>
                    ` : ''}

                    <div id="subst-container-prospect-doc_comprobante" class="subst-form-panel" style="${hasDocComprobante ? 'display:none;' : 'display:block;'} margin-top: 8px; padding: 12px; background: rgba(15, 23, 42, 0.95); border: 1px solid ${hasDocComprobante ? 'var(--brand-gold)' : 'var(--panel-border)'}; border-radius: 8px;">
                        ${hasDocComprobante ? `
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                                <div>
                                    <div style="font-size:0.85rem; font-weight:700; color:var(--brand-gold);">🔄 Sustituir Comprobante de Anticipo</div>
                                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">Archivo vigente: <strong style="color:white;">${escapeHtmlDoc(comprobanteName)}</strong></div>
                                </div>
                                <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;" onclick="cancelProspectDocSubstForm('doc_comprobante')" title="Cancelar">✖️</button>
                            </div>
                            <div style="background:rgba(245, 158, 11, 0.12); border-left:3px solid #f59e0b; padding:8px 10px; border-radius:4px; font-size:0.75rem; color:#fde68a; margin-bottom:10px;">
                                ⚠️ <strong>Aviso de Versionado:</strong> El comprobante actual se archivará en el historial. La nueva versión requerirá justificación obligatoria.
                            </div>
                        ` : `
                            <label for="closing-file-doc-comprobante" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Cargar copia de factura o comprobante de anticipo:</label>
                        `}
                        <div>
                            <label for="closing-file-doc-comprobante" style="display:${hasDocComprobante ? 'block' : 'none'}; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Nuevo archivo (PDF, JPG, PNG) <span style="color:#ef4444;">*</span></label>
                            <input type="file" id="closing-file-doc-comprobante" accept=".pdf,.png,.jpg,.jpeg,.webp" ${isWon ? 'disabled' : ''} style="font-size:0.78rem; width:100%;">
                            <small style="color:var(--text-secondary); display:block; margin-top:2px;">Formatos: PDF, JPG, PNG.</small>
                        </div>
                        ${hasDocComprobante ? `
                            <div style="margin-top: 8px;">
                                <label for="closing-motivo-doc-comprobante" style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-primary); margin-bottom:4px;">Motivo obligatorio de sustitución <span style="color:#ef4444;">*</span></label>
                                <textarea id="closing-motivo-doc-comprobante" rows="2" placeholder="Motivo obligatorio por el que se sustituye el comprobante..." style="font-size: 0.78rem; width: 100%; box-sizing:border-box; padding: 6px 10px; background: rgba(255,255,255,0.07); border: 1px solid var(--panel-border); border-radius: 4px; color: white; resize:vertical;"></textarea>
                                <small style="font-size:0.7rem; color:var(--text-muted); display:block; margin-top:2px;">Mínimo 3 caracteres requeridos para auditoría.</small>
                            </div>
                            <div id="closing-prospect-feedback-doc_comprobante" style="display:none; font-size:0.75rem; padding:6px 10px; border-radius:4px; margin-top:6px;"></div>
                            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
                                <button type="button" class="btn-secondary" id="btn-cancel-prospect-subst-doc_comprobante" onclick="cancelProspectDocSubstForm('doc_comprobante')" style="padding:4px 12px; font-size:0.78rem;">Cancelar</button>
                                <button type="button" class="btn-primary" id="btn-confirm-prospect-subst-doc_comprobante" onclick="confirmProspectDocSubstitution('${p.id}', 'doc_comprobante')" style="padding:4px 14px; font-size:0.78rem; background:var(--brand-gold); color:black; font-weight:600;">Confirmar Reemplazo</button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        </div>

        <!-- Botones de Acción: Guardar Avances vs Finalizar Oportunidad -->
        <div style="display: flex; gap: 1rem; align-items: center; border-top: 1px solid var(--panel-border); padding-top: 1rem; flex-wrap: wrap;">
            <button type="button" class="btn-secondary" onclick="saveClosingProgress('${p.id}')" style="display: flex; align-items: center; gap: 6px;" ${isWon ? 'disabled' : ''}>
                <span>💾</span> Guardar Avances Documentales
            </button>
            <button type="button" class="btn-primary" onclick="finalizeOpportunity('${p.id}')" style="background: #10b981; border-color: #10b981; color: white; font-weight: 600; display: flex; align-items: center; gap: 6px; margin-left: auto;" ${isWon ? 'disabled' : ''}>
                <span>🏁</span> Finalizar Oportunidad (Ganada)
            </button>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem; text-align: right;">
            * La oportunidad solo se transferirá a Proyectos y Cobros al pulsar <strong>Finalizar Oportunidad</strong> tras validar todos los requisitos.
        </div>
    </div>`;

    container.innerHTML = html;
}

// toggleClientDocSubstForm y cancelClientDocSubstForm extraídos a modules/clients/client_documents.js (Fase 6.2.1)


function toggleProspectDocSubstForm(docKey) {
    const el = document.getElementById(`subst-container-prospect-${docKey}`);
    if (el) {
        el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
    }
}

function cancelProspectDocSubstForm(docKey) {
    const fileEl = document.getElementById(`closing-file-${docKey}`);
    if (fileEl) fileEl.value = '';
    const motivoEl = document.getElementById(`closing-motivo-${docKey}`);
    if (motivoEl) motivoEl.value = '';
    const feedbackEl = document.getElementById(`closing-prospect-feedback-${docKey}`);
    if (feedbackEl) {
        feedbackEl.style.display = 'none';
        feedbackEl.innerHTML = '';
    }
    const container = document.getElementById(`subst-container-prospect-${docKey}`);
    if (container) container.style.display = 'none';
}

async function confirmProspectDocSubstitution(prospectId, docKey) {
    const prospectList = (typeof prospects !== 'undefined' && Array.isArray(prospects) && prospects.length > 0)
        ? prospects
        : ((typeof window !== 'undefined' && Array.isArray(window.prospects)) ? window.prospects : []);
    const p = prospectList.find(x => x.id === prospectId) || null;
    if (!p) return alert('Oportunidad no encontrada');
    if (p.estado === 'ganado') return alert('No se pueden modificar documentos de una oportunidad ya ganada.');

    const fileInput = document.getElementById(`closing-file-${docKey}`);
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        return alert('Debe seleccionar un archivo para sustituir el documento actual.');
    }

    const motivoInput = document.getElementById(`closing-motivo-${docKey}`);
    const motivo = motivoInput ? motivoInput.value.trim() : '';
    if (!motivo || motivo.length < 3) {
        return alert('Toda sustitución de un documento existente requiere un motivo obligatorio (mínimo 3 caracteres).');
    }

    const confirmBtn = document.getElementById(`btn-confirm-prospect-subst-${docKey}`);
    const feedbackEl = document.getElementById(`closing-prospect-feedback-${docKey}`);
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '⏳ Subiendo a Storage...';
    }
    if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = 'rgba(59, 130, 246, 0.15)';
        feedbackEl.style.color = '#93c5fd';
        feedbackEl.innerHTML = '⏳ Subiendo nuevo archivo a Storage seguro...';
    }

    try {
        const uploader = (typeof window !== 'undefined' && typeof window.uploadFileToStorage === 'function')
            ? window.uploadFileToStorage
            : uploadFileToStorage;
        const folder = docKey === 'doc_comprobante' ? 'facturas' : 'proyectos';
        const docRef = await uploader(fileInput.files[0], folder, { prospectId: p.id });
        docRef.motivoSustitucion = motivo;

        if (confirmBtn) confirmBtn.innerHTML = '⏳ Registrando versión...';
        if (feedbackEl) feedbackEl.innerHTML = '⏳ Registrando nueva versión y archivando anterior...';

        const data = {};
        if (docKey === 'doc_firmado') {
            data.doc_firmado = docRef;
            data.motivo_doc_firmado = motivo;
        } else if (docKey === 'doc_comprobante') {
            data.doc_comprobante = docRef;
            data.motivo_doc_comprobante = motivo;
        }

        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        await CrmCommercial.saveClosingDocuments(fb, {
            prospectId: p.id,
            data,
            dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod'))
        });

        if (feedbackEl) {
            feedbackEl.style.background = 'rgba(16, 185, 129, 0.15)';
            feedbackEl.style.color = '#6ee7b7';
            feedbackEl.innerHTML = '✅ Documento sustituido exitosamente.';
        }

        alert(`Documento sustituido y archivado exitosamente.`);
        openDetail(p.id);
    } catch (err) {
        console.error('Error al sustituir documento del prospecto:', err);
        if (feedbackEl) {
            feedbackEl.style.background = 'rgba(239, 68, 68, 0.15)';
            feedbackEl.style.color = '#fca5a5';
            feedbackEl.innerHTML = '❌ Error: ' + escapeHtmlDoc(err.message || 'Error al guardar');
        }
        alert('Error al sustituir documento: ' + (err.message || 'Error desconocido') + '. La versión anterior se conservó intacta.');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = 'Confirmar Reemplazo';
        }
    }
}

// uploadClientDocumentFromClosing extraído a modules/clients/client_documents.js (Fase 6.2.1)


async function saveClosingProgress(prospectId) {
    const prospectList = (typeof _deps !== 'undefined' && typeof _deps.getProspects === 'function')
        ? _deps.getProspects()
        : ((typeof prospects !== 'undefined' && Array.isArray(prospects)) ? prospects : []);
    const p = (Array.isArray(prospectList) ? prospectList : []).find(x => x && x.id === prospectId) || null;
    if (!p) return;
    if (p.estado === 'ganado') {
        return alert('No se pueden modificar documentos de una oportunidad ya ganada.');
    }

    const fpEl = document.getElementById('closing-forma-pago');
    const facEl = document.getElementById('closing-fac-anticipo');
    const encEl = document.getElementById('closing-encargado');
    const f1El = document.getElementById('closing-file-doc-firmado');
    const f2El = document.getElementById('closing-file-doc-comprobante');
    const m1El = document.getElementById('closing-motivo-doc-firmado');
    const m2El = document.getElementById('closing-motivo-doc-comprobante');

    const hasNewF1 = f1El && f1El.files && f1El.files.length > 0;
    const hasExistingF1 = !!(p.datos && (p.datos.doc_firmado || p.datos.doc_contrato || p.datos.doc_oferta_firmada));
    if (hasNewF1 && hasExistingF1) {
        const motivo1 = m1El ? m1El.value.trim() : '';
        if (!motivo1) {
            return alert('Toda sustitución de la oferta firmada requiere un motivo obligatorio no vacío.');
        }
    }

    const hasNewF2 = f2El && f2El.files && f2El.files.length > 0;
    const hasExistingF2 = !!(p.datos && p.datos.doc_comprobante);
    if (hasNewF2 && hasExistingF2) {
        const motivo2 = m2El ? m2El.value.trim() : '';
        if (!motivo2) {
            return alert('Toda sustitución del comprobante de anticipo requiere un motivo obligatorio no vacío.');
        }
    }

    const data = {};
    if (fpEl && fpEl.value) data.forma_pago = fpEl.value;
    if (facEl && facEl.value.trim()) data.factura_anticipo = facEl.value.trim();
    if (encEl && encEl.value.trim()) data.encargado = encEl.value.trim();
    if (hasNewF1 && m1El && m1El.value.trim()) data.motivo_doc_firmado = m1El.value.trim();
    if (hasNewF2 && m2El && m2El.value.trim()) data.motivo_doc_comprobante = m2El.value.trim();

    const reqContratoEl = document.getElementById('closing-requiere-contrato');
    if (reqContratoEl) {
        data.requiere_contrato = reqContratoEl.checked;
        if (reqContratoEl.checked) {
            const tipoEl = document.getElementById('closing-firmante-tipo');
            const pwEl = document.getElementById('closing-firmante-power-id');
            const tipo = tipoEl ? tipoEl.value : null;
            if (tipo === 'representante_legal') {
                data.firmante_cierre = { tipo: 'representante_legal' };
            } else if (tipo === 'apoderado') {
                data.firmante_cierre = { tipo: 'apoderado', powerId: (pwEl ? pwEl.value : null) };
            } else {
                data.firmante_cierre = null;
            }
        } else {
            data.firmante_cierre = null;
        }
    }

    const ok = await runWorkflowOp('Guardando avances documentales...', async fb => {
        const uploader = (typeof window !== 'undefined' && typeof window.uploadFileToStorage === 'function')
            ? window.uploadFileToStorage
            : uploadFileToStorage;
        if (hasNewF1) {
            data.doc_firmado = await uploader(f1El.files[0], 'proyectos', { prospectId: p.id });
            if (data.motivo_doc_firmado) data.doc_firmado.motivoSustitucion = data.motivo_doc_firmado;
        }
        if (hasNewF2) {
            data.doc_comprobante = await uploader(f2El.files[0], 'facturas', { prospectId: p.id });
            if (data.motivo_doc_comprobante) data.doc_comprobante.motivoSustitucion = data.motivo_doc_comprobante;
        }
        return CrmCommercial.saveClosingDocuments(fb, { prospectId: p.id, data, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
    });

    if (ok) {
        alert('Avances documentales guardados exitosamente.');
        openDetail(p.id);
    }
}

async function finalizeOpportunity(prospectId) {
    const prospectList = (typeof _deps !== 'undefined' && typeof _deps.getProspects === 'function')
        ? _deps.getProspects()
        : ((typeof prospects !== 'undefined' && Array.isArray(prospects)) ? prospects : []);
    const p = (Array.isArray(prospectList) ? prospectList : []).find(x => x && x.id === prospectId) || null;
    if (!p) return;
    if (p.estado === 'ganado') {
        return alert('Esta oportunidad ya fue finalizada previamente.');
    }

    const fpEl = document.getElementById('closing-forma-pago');
    const facEl = document.getElementById('closing-fac-anticipo');
    const encEl = document.getElementById('closing-encargado');
    const f1El = document.getElementById('closing-file-doc-firmado');
    const f2El = document.getElementById('closing-file-doc-comprobante');
    const m1El = document.getElementById('closing-motivo-doc-firmado');
    const m2El = document.getElementById('closing-motivo-doc-comprobante');

    const clientList = (typeof _deps !== 'undefined' && typeof _deps.getClients === 'function')
        ? _deps.getClients()
        : ((typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : []);
    const c = (Array.isArray(clientList) ? clientList : []).find(x => x && x.id === p.clientId) || {};
    const clientDocs = (c && c.documentos && typeof c.documentos === 'object') ? c.documentos : {};
    const datos = (p && p.datos && typeof p.datos === 'object') ? p.datos : {};

    const formaPago = (fpEl && fpEl.value) || p.forma_pago || datos.forma_pago;
    const facAnticipo = (facEl && facEl.value.trim()) || p.factura_anticipo || datos.factura_anticipo;
    const encargado = (encEl && encEl.value.trim()) || p.encargado || datos.encargado;

    const hasNewF1 = f1El && f1El.files && f1El.files.length > 0;
    const hasExistingF1 = !!(datos.doc_firmado || datos.doc_contrato || datos.doc_oferta_firmada);
    const hasNewF2 = f2El && f2El.files && f2El.files.length > 0;
    const hasExistingF2 = !!datos.doc_comprobante;

    const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));
    const aprobacionSinContrato = p.aprobacion_sin_contrato || (datos && datos.aprobacion_sin_contrato) || null;
    const isApprovalInvalidated = (aprobacionSinContrato && aprobacionSinContrato.estado === 'invalidada_por_sustitucion');
    const isAuthorized = !isApprovalInvalidated && (
        datos.autorizado_sin_contrato === true ||
        (aprobacionSinContrato && aprobacionSinContrato.estado === 'aprobada') ||
        (p.solicitud_sin_contrato && p.solicitud_sin_contrato.estado === 'aprobada')
    );

    // Validación de autorización invalidada
    if (isBigInstalacion && isApprovalInvalidated) {
        return alert("❌ No se puede finalizar la oportunidad: La autorización para cerrar sin contrato fue invalidada por una sustitución previa de la oferta.\n\nSe requiere una nueva autorización de gerencia antes de poder finalizar.");
    }

    if (hasNewF1 && hasExistingF1) {
        const motivo1 = m1El ? m1El.value.trim() : '';
        if (!motivo1) {
            return alert('Toda sustitución de la oferta firmada requiere un motivo obligatorio no vacío.');
        }
    }

    if (hasNewF2 && hasExistingF2) {
        const motivo2 = m2El ? m2El.value.trim() : '';
        if (!motivo2) {
            return alert('Toda sustitución del comprobante de anticipo requiere un motivo obligatorio no vacío.');
        }
    }

    // Validación preventiva en cliente con reporte claro de requisitos faltantes
    const missing = [];
    if (!clientDocs.dui) missing.push("DUI del cliente o representante (en sección Documentación del Cliente)");
    if (isBigInstalacion && !isAuthorized && c.tipo === 'juridica') {
        if (!clientDocs.escritura || !clientDocs.credencial || !clientDocs.nit || !clientDocs.nrc) {
            missing.push("Documentos legales corporativos (Escritura, Credencial, NIT, NRC en Documentación del Cliente)");
        }
    }
    if (!formaPago) missing.push("Forma de pago pactada");
    if (p.tipo_proyecto === 'Fabricación e instalación' && !encargado) missing.push("Encargado de instalación");
    if (!hasNewF1 && !hasExistingF1) {
        missing.push(isBigInstalacion && !isAuthorized ? "Contrato firmado escaneado" : "Oferta firmada por cliente");
    }

    const reqContratoEl = document.getElementById('closing-requiere-contrato');
    const requiereContrato = reqContratoEl ? reqContratoEl.checked : (p.requiere_contrato === true || (datos && datos.requiere_contrato === true));

    let firmanteCierre = null;
    if (requiereContrato) {
        const tipoEl = document.getElementById('closing-firmante-tipo');
        const pwEl = document.getElementById('closing-firmante-power-id');
        const tipo = tipoEl ? tipoEl.value : ((p.firmante_cierre && p.firmante_cierre.tipo) || (datos.firmante_cierre && datos.firmante_cierre.tipo));
        if (!tipo) {
            missing.push("Designación de firmante para contrato (Representante Legal o Apoderado facultado)");
        } else if (tipo === 'representante_legal') {
            const rl = c && c.representanteLegalVigente;
            if (!rl || rl.estado !== 'vigente') {
                missing.push("Acreditación societaria vigente del Representante Legal en el expediente del cliente");
            } else {
                firmanteCierre = { tipo: 'representante_legal' };
            }
        } else if (tipo === 'apoderado') {
            const powerId = pwEl ? pwEl.value : ((p.firmante_cierre && p.firmante_cierre.powerId) || (datos.firmante_cierre && datos.firmante_cierre.powerId));
            if (!powerId) {
                missing.push("Selección de poder notarial vigente del apoderado firmante");
            } else {
                const powers = (c && Array.isArray(c.apoderadosVigentes)) ? c.apoderadosVigentes : [];
                const pw = powers.find(x => (x.id === powerId || x.powerId === powerId));
                if (!pw || pw.estado !== 'vigente') {
                    missing.push("Poder notarial seleccionado no se encuentra vigente en el expediente de la cuenta");
                } else {
                    firmanteCierre = { tipo: 'apoderado', powerId: powerId };
                }
            }
        }
    }

    if (missing.length > 0) {
        return alert("❌ No se puede finalizar la oportunidad. Faltan los siguientes requisitos obligatorios:\n\n• " + missing.join("\n• "));
    }

    const ccfConfirmNote = (facAnticipo && (hasNewF2 || hasExistingF2))
        ? `• Se generará la factura de anticipo (${facAnticipo})`
        : `• El CCF de anticipo y su cobro quedarán como hitos pendientes (obligatorios antes de enviar a fabricación)`;

    if (!confirm(`¿Confirmas la finalización definitiva de esta oportunidad comercial?\n\n• Se marcará el estado como 'Ganado'\n• Se habilitará la transferencia a Proyectos y Cobros\n${ccfConfirmNote}`)) {
        return;
    }

    const data = {
        forma_pago: formaPago,
        requiere_contrato: requiereContrato
    };
    if (facAnticipo) data.factura_anticipo = facAnticipo;
    if (firmanteCierre) data.firmante_cierre = firmanteCierre;
    if (encargado) data.encargado = encargado;
    if (hasNewF1 && m1El && m1El.value.trim()) data.motivo_doc_firmado = m1El.value.trim();
    if (hasNewF2 && m2El && m2El.value.trim()) data.motivo_doc_comprobante = m2El.value.trim();

    const ok = await runWorkflowOp('Finalizando oportunidad y transfiriendo a Proyectos y Cobros...', async fb => {
        if (hasNewF1) {
            data.doc_firmado = await uploadFileToStorage(f1El.files[0], 'proyectos', { prospectId: p.id });
            if (data.motivo_doc_firmado) data.doc_firmado.motivoSustitucion = data.motivo_doc_firmado;
        }
        if (hasNewF2) {
            data.doc_comprobante = await uploadFileToStorage(f2El.files[0], 'facturas', { prospectId: p.id });
            if (data.motivo_doc_comprobante) data.doc_comprobante.motivoSustitucion = data.motivo_doc_comprobante;
        }
        return CrmCommercial.finalizeProspect(fb, { prospectId: p.id, data, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) });
    });

    if (ok) {
        alert('🎉 ¡Oportunidad finalizada exitosamente! Se ha transferido a Proyectos y Cobros.');
        openDetail(p.id);
    }
}


function showLoseForm() {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    openMarkLostModal(p.id);
}

function openMarkLostModal(prospectId) {
    const prospectList = (typeof prospects !== 'undefined' && Array.isArray(prospects) && prospects.length > 0)
        ? prospects
        : ((typeof window !== 'undefined' && Array.isArray(window.prospects)) ? window.prospects : []);
    const p = prospectList.find(x => x && x.id === prospectId);
    if (!p) return;

    currentProspectId = prospectId;
    const modal = document.getElementById('markLostModal');
    if (!modal) {
        let opts = MOTIVOS_PERDIDA.map(m => `<option value="${m}">${m}</option>`).join('');
        const advBox = document.getElementById('advance-form-container');
        if (advBox) {
            advBox.innerHTML = `<div class="form-group mt-4"><label style="color:var(--danger)">Motivo de pérdida</label><select id="lose-reason" required><option value="">-- Selecciona --</option>${opts}</select><button class="btn-danger mt-2" onclick="processLose()">Confirmar Pérdida</button><button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button></div>`;
        }
        return;
    }

    const idInput = document.getElementById('mark-lost-prospect-id');
    if (idInput) idInput.value = prospectId;

    const clientName = getClientName(p.clientId);
    const subEl = document.getElementById('mark-lost-subtitle');
    if (subEl) {
        subEl.textContent = `Proyecto: ${p.codigo || ''} ${p.proyecto || '-'} | Cliente: ${clientName}`;
    }

    const precioEl = document.getElementById('mark-lost-precio');
    if (precioEl) {
        precioEl.textContent = formatCurrency(p.precio_cotizado || 0);
    }

    const gestionesEl = document.getElementById('mark-lost-gestiones');
    if (gestionesEl) {
        const hist = (p.seguimiento && Array.isArray(p.seguimiento.historial_gestiones)) ? p.seguimiento.historial_gestiones : [];
        gestionesEl.textContent = `${hist.length} ${hist.length === 1 ? 'gestión' : 'gestiones'}`;
    }

    const intentosEl = document.getElementById('mark-lost-intentos');
    if (intentosEl) {
        const cad = (p.seguimiento && p.seguimiento.cadencia) || {};
        const intentos = Number(cad.intentos_fallidos !== undefined ? cad.intentos_fallidos : cad.intentos_validos_sin_respuesta) || 0;
        intentosEl.textContent = `${intentos} de 5 fallidos`;
    }

    const selectEl = document.getElementById('mark-lost-reason');
    if (selectEl) {
        selectEl.innerHTML = '<option value="">-- Selecciona un motivo justificado --</option>' +
            MOTIVOS_PERDIDA.map(m => `<option value="${m}">${m}</option>`).join('');
        selectEl.value = '';
    }

    modal.style.display = 'block';
}

function closeMarkLostModal() {
    closeModal('markLostModal');
    const form = document.getElementById('markLostForm');
    if (form) form.reset();
}

async function processConfirmMarkLost(event) {
    return processLose(event);
}

async function processLose() {
    const event = arguments[0] || (typeof window !== 'undefined' ? window.event : null);
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const prospectId = (document.getElementById('mark-lost-prospect-id') && document.getElementById('mark-lost-prospect-id').value) || currentProspectId;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const selectEl = document.getElementById('mark-lost-reason') || document.getElementById('lose-reason');
    const reason = selectEl ? selectEl.value : '';
    if (!reason) {
        alert("Debes seleccionar un motivo obligatorio.");
        return;
    }

    const submitBtn = document.getElementById('btn-submit-mark-lost');
    if (submitBtn) {
        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
    }

    try {
        // markProspectLostAdmin validates the reason and that the opportunity is still active, and writes history and audit.
        const res = await runWorkflowOp('Registrando pérdida...', fb => CrmCommercial.markLost(fb, { prospectId: p.id, reason, dbSuffix: (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof _deps !== 'undefined' && _deps.getDbSuffix ? _deps.getDbSuffix() : '_prod')) }));
        if (!res) return;

        if (typeof closeMarkLostModal === 'function') closeMarkLostModal();
        const advBox = document.getElementById('advance-form-container');
        if (advBox) advBox.innerHTML = '';
        openDetail(p.id);
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}


    // -------------------------------------------------------------------------
    // 8. Exportación de API del Módulo
    // -------------------------------------------------------------------------
    const OpportunitiesUI = {
        init: initOpportunitiesUI,
        initOpportunitiesUI,

        // 2A - Pipeline / Listado
        renderList,
        updateFilterBadges,
        renderPipelineRow,
        renderEmptyState,

        // 2B - Detalle y Navegación
        openDetail,
        goBackFromDetail,

        // 2C - Tracker, Información y Logs
        renderTracker,
        renderInfo,
        renderLogs,
        deleteLog,
        addLogToProspect,
        onLogTextInput,
        dismissCommercialIntentBanner,
        transferTextToFollowUpModal,
        addLog,

        // 2C - Seguimiento y Cadencias
        renderFollowUpSummary,
        openRecordFollowUpModal,
        updateSuggestedFollowUpDate,
        handleFollowUpCanalChange,
        handleFollowUpResultadoChange,
        processSaveFollowUp,
        openCadenceModal,
        handleCadenceSelectChange,
        processSaveCadence,
        openReclassifyModal,
        handleReclassifySelectChange,
        processSaveReclassification,

        // 2D - Formularios, Creación y Edición
        openNewModal,
        createNewProspect,
        openEditBasePriceModal,
        processEditBasePrice,
        showNewProposalForm,
        processNewProposal,
        toggleContractRequirement,

        // 2D - Autorización sin Contrato
        applyNoContractAuthorization,
        toggleManagerApproval: (typeof window !== 'undefined' && window.toggleManagerApproval) || null,
        toggleManagerApprovalInForm: (typeof window !== 'undefined' && window.toggleManagerApprovalInForm) || null,
        noContractRequestsOf,
        renderNoContractRequestHTML,
        requestNoContractAuthorization: (typeof window !== 'undefined' && window.requestNoContractAuthorization) || null,
        resolveNoContractRequest: (typeof window !== 'undefined' && window.resolveNoContractRequest) || null,

        // 2D - Avance y Retroceso de Etapa
        showAdvanceForm,
        processAdvance,
        confirmAdvanceToCierre,
        showRevertForm,
        cancelRevertForm,
        processRevertStage,

        // 2D - Cierre Documental y Finalización
        renderClosingDocumentationPanel,
        toggleProspectDocSubstForm,
        cancelProspectDocSubstForm,
        confirmProspectDocSubstitution,
        saveClosingProgress,
        finalizeOpportunity,
        renderActivePowersOptions,
        renderSignatoryStatusFeedback,
        toggleClosingContractSection,
        onClosingSignatoryTypeChange,
        runB3CloseValidation,

        // 2D - Marcado de Pérdida
        showLoseForm,
        openMarkLostModal,
        closeMarkLostModal,
        processConfirmMarkLost,
        processLose,

        // 2D - Modales
        openModal,
        closeModal,

        _deps
    };

    return OpportunitiesUI;
});
