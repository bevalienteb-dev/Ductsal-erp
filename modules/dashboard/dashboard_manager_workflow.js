// ============================================================================
// DUCTSAL ERP — DASHBOARD MODULE: MANAGER WORKFLOW (Fase 6.5.4)
// Archivo: modules/dashboard/dashboard_manager_workflow.js
// Responsabilidades:
// 1. Gestión de la interfaz modal de Decisión Gerencial (modal-manager-decision).
// 2. Conmutación de pestañas (switchManagerDecisionTab): Autorizar Continuidad vs Ordenar Cierre.
// 3. Apertura y preparación modal con SLA dinámico (openManagerDecisionModal).
// 4. Envío transaccional y validación estricta de decisiones (submitManagerDecision).
// 5. Integración con Cloud Functions CrmCommercial.resolveFollowUpEscalation.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.DashboardManagerWorkflow = api;
        if (typeof window !== 'undefined') {
            window.DashboardManagerWorkflow = api;
            window.switchManagerDecisionTab = api.switchManagerDecisionTab;
            window.openManagerDecisionModal = api.openManagerDecisionModal;
            window.submitManagerDecision = api.submitManagerDecision;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado local de Decisión Gerencial
    // -------------------------------------------------------------------------
    let _currentDecisionProspectId = null;
    let _isSubmitting = false;

    // -------------------------------------------------------------------------
    // 2. Dependencias inyectadas con fallbacks a globales
    // -------------------------------------------------------------------------
    const _deps = {
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            if (typeof global !== 'undefined' && Array.isArray(global.prospects)) return global.prospects;
            return [];
        },
        getUsers: () => {
            if (typeof users !== 'undefined' && Array.isArray(users)) return users;
            if (typeof window !== 'undefined' && Array.isArray(window.users)) return window.users;
            if (typeof global !== 'undefined' && Array.isArray(global.users)) return global.users;
            return [];
        },
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            if (typeof global !== 'undefined' && global.currentUser) return global.currentUser;
            return null;
        },
        getCurrentProspectId: () => {
            if (typeof currentProspectId !== 'undefined') return currentProspectId;
            if (typeof window !== 'undefined' && window.currentProspectId) return window.currentProspectId;
            return null;
        },
        getDbSuffix: () => {
            if (typeof DB_SUFFIX !== 'undefined') return DB_SUFFIX;
            if (typeof window !== 'undefined' && typeof window.DB_SUFFIX !== 'undefined') return window.DB_SUFFIX;
            return '';
        },
        getCrmFollowUpCalc: () => {
            if (typeof CrmFollowUpCalc !== 'undefined') return CrmFollowUpCalc;
            if (typeof window !== 'undefined' && window.CrmFollowUpCalc) return window.CrmFollowUpCalc;
            return null;
        },
        getCrmWorkCalendar: () => {
            if (typeof CrmWorkCalendar !== 'undefined') return CrmWorkCalendar;
            if (typeof window !== 'undefined' && window.CrmWorkCalendar) return window.CrmWorkCalendar;
            return null;
        },
        getCrmCommercial: () => {
            if (typeof CrmCommercial !== 'undefined') return CrmCommercial;
            if (typeof window !== 'undefined' && window.CrmCommercial) return window.CrmCommercial;
            return null;
        },
        getDocument: () => {
            if (typeof document !== 'undefined') return document;
            return null;
        },
        getClientName: (clientId) => {
            if (typeof getClientName === 'function') return getClientName(clientId);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(clientId);
            return clientId || '-';
        },
        openModal: (modalId) => {
            if (typeof openModal === 'function') return openModal(modalId);
            if (typeof window !== 'undefined' && typeof window.openModal === 'function') return window.openModal(modalId);
            const m = typeof document !== 'undefined' ? document.getElementById(modalId) : null;
            if (m) m.style.display = 'block';
        },
        closeModal: (modalId) => {
            if (typeof closeModal === 'function') return closeModal(modalId);
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(modalId);
            const m = typeof document !== 'undefined' ? document.getElementById(modalId) : null;
            if (m) m.style.display = 'none';
        },
        openDetail: (prospectId) => {
            if (typeof openDetail === 'function') return openDetail(prospectId);
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') return window.openDetail(prospectId);
        },
        renderDashboard: () => {
            if (typeof DashboardController !== 'undefined' && typeof DashboardController.renderDashboard === 'function') {
                return DashboardController.renderDashboard();
            }
            if (typeof renderDashboard === 'function') return renderDashboard();
            if (typeof window !== 'undefined' && typeof window.renderDashboard === 'function') return window.renderDashboard();
        },
        runWorkflowOp: async (desc, opFn) => {
            if (typeof runWorkflowOp === 'function') return await runWorkflowOp(desc, opFn);
            if (typeof window !== 'undefined' && typeof window.runWorkflowOp === 'function') return await window.runWorkflowOp(desc, opFn);
            throw new Error('runWorkflowOp no disponible');
        },
        showAlert: (msg) => {
            if (typeof alert === 'function') alert(msg);
            else console.warn('[ALERT]', msg);
        }
    };

    function setDeps(customDeps) {
        if (!customDeps || typeof customDeps !== 'object') return;
        Object.keys(customDeps).forEach(key => {
            if (typeof customDeps[key] === 'function') {
                _deps[key] = customDeps[key];
            } else {
                _deps[key] = () => customDeps[key];
            }
        });
    }

    // -------------------------------------------------------------------------
    // 3. Conmutación de Pestañas del Modal
    // -------------------------------------------------------------------------
    function switchManagerDecisionTab(tab) {
        const doc = _deps.getDocument();
        if (!doc) return;

        const tabAutorizar = doc.getElementById('mgr-tab-autorizar');
        const tabCierre = doc.getElementById('mgr-tab-cierre');
        const btnAutorizar = doc.getElementById('tab-btn-autorizar');
        const btnCierre = doc.getElementById('tab-btn-cierre');

        if (tab === 'autorizar') {
            if (tabAutorizar) tabAutorizar.style.display = 'block';
            if (tabCierre) tabCierre.style.display = 'none';
            if (btnAutorizar) {
                btnAutorizar.style.background = 'rgba(16, 185, 129, 0.2)';
                btnAutorizar.style.borderColor = 'rgba(16, 185, 129, 0.5)';
                btnAutorizar.style.color = '#34d399';
            }
            if (btnCierre) {
                btnCierre.style.background = 'transparent';
                btnCierre.style.borderColor = 'var(--panel-border)';
                btnCierre.style.color = 'var(--text-secondary)';
            }
        } else {
            if (tabAutorizar) tabAutorizar.style.display = 'none';
            if (tabCierre) tabCierre.style.display = 'block';
            if (btnCierre) {
                btnCierre.style.background = 'rgba(239, 68, 68, 0.2)';
                btnCierre.style.borderColor = 'rgba(239, 68, 68, 0.5)';
                btnCierre.style.color = '#f87171';
            }
            if (btnAutorizar) {
                btnAutorizar.style.background = 'transparent';
                btnAutorizar.style.borderColor = 'var(--panel-border)';
                btnAutorizar.style.color = 'var(--text-secondary)';
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Apertura y Preparación del Modal de Decisión
    // -------------------------------------------------------------------------
    function openManagerDecisionModal(prospectId) {
        const currentUserObj = _deps.getCurrentUser();
        if (!currentUserObj || currentUserObj.role !== 'manager') {
            _deps.showAlert("Solo los usuarios con rol Gerente pueden registrar decisiones gerenciales.");
            return;
        }

        const prospectsList = _deps.getProspects();
        const p = prospectsList.find(x => x.id === prospectId);
        if (!p) {
            _deps.showAlert("Oportunidad no encontrada");
            return;
        }

        const doc = _deps.getDocument();
        if (!doc) return;

        _currentDecisionProspectId = prospectId;
        const idInput = doc.getElementById('mgr-decision-prospect-id');
        if (idInput) idInput.value = prospectId;

        const usersList = _deps.getUsers();
        const followUp = _deps.getCrmFollowUpCalc();
        const clientName = _deps.getClientName(p.clientId);
        const vendorName = (followUp && typeof followUp.resolveSellerName === 'function')
            ? followUp.resolveSellerName(p, usersList)
            : (p.vendedorName || p.vendedor || '-');

        const subtitle = doc.getElementById('mgr-decision-subtitle');
        if (subtitle) {
            subtitle.textContent = `Proyecto: ${p.proyecto || '-'} | Cliente: ${clientName} | Responsable: ${vendorName}`;
        }

        const seguimiento = p.seguimiento || {};
        const cadencia = seguimiento.cadencia || {};
        const intentos = cadencia.intentos_validos_sin_respuesta || 0;

        let motivoDesc = "Esta oportunidad ha alcanzado 5 intentos válidos de contacto sin respuesta por parte del cliente y requiere resolución gerencial para continuar o cerrar el caso.";
        if (cadencia.motivo_escalacion) {
            motivoDesc = cadencia.motivo_escalacion;
        }
        const motivoDescElem = doc.getElementById('mgr-decision-motivo-desc');
        if (motivoDescElem) motivoDescElem.textContent = motivoDesc;

        let histText = `Intentos registrados: ${intentos} intentos sin respuesta.`;
        if (cadencia.justificacion_continuidad) {
            histText += ` | Justificación anterior del vendedor: "${cadencia.justificacion_continuidad}"`;
        }
        const histElem = doc.getElementById('mgr-decision-historial-summary');
        if (histElem) histElem.textContent = histText;

        // Resetear campos
        const elAutJust = doc.getElementById('mgr-autorizar-justificacion');
        if (elAutJust) elAutJust.value = '';
        const elAutDesc = doc.getElementById('mgr-autorizar-prox-desc');
        if (elAutDesc) elAutDesc.value = '';
        const elCieJust = doc.getElementById('mgr-cierre-justificacion');
        if (elCieJust) elCieJust.value = '';
        const elCieMot = doc.getElementById('mgr-cierre-motivo');
        if (elCieMot) elCieMot.value = '';
        const elCieInm = doc.getElementById('mgr-cierre-ejecutar-inmediato');
        if (elCieInm) elCieInm.checked = true;

        // Fecha sugerida por defecto: 2 días hábiles a partir de hoy
        const workCal = _deps.getCrmWorkCalendar();
        const nextDate = (workCal && typeof workCal.addBusinessDays === 'function')
            ? workCal.addBusinessDays(new Date(), 2)
            : new Date(Date.now() + 2 * 86400000);
        const dateStr = nextDate.toISOString().split('T')[0];
        const elAutFecha = doc.getElementById('mgr-autorizar-prox-fecha');
        if (elAutFecha) elAutFecha.value = dateStr;

        switchManagerDecisionTab('autorizar');
        _deps.openModal('modal-manager-decision');
    }

    // -------------------------------------------------------------------------
    // 5. Envío y Procesamiento Transaccional de la Decisión
    // -------------------------------------------------------------------------
    async function submitManagerDecision(decisionType) {
        if (_isSubmitting) return;
        const doc = _deps.getDocument();
        if (!doc) return;

        const idInput = doc.getElementById('mgr-decision-prospect-id');
        const prospectId = _currentDecisionProspectId || (idInput ? idInput.value : null);
        if (!prospectId) return;

        const crmComm = _deps.getCrmCommercial();
        const dbSuffix = _deps.getDbSuffix();

        _isSubmitting = true;
        try {
            if (decisionType === 'autorizar_continuar') {
                const justificacionElem = doc.getElementById('mgr-autorizar-justificacion');
                const justificacion = justificacionElem ? justificacionElem.value.trim() : '';
                if (!justificacion || justificacion.length < 5) {
                    return _deps.showAlert("Por favor ingresa una justificación gerencial detallada (mínimo 5 caracteres).");
                }
                const fechaElem = doc.getElementById('mgr-autorizar-prox-fecha');
                const fecha = fechaElem ? fechaElem.value : '';
                if (!fecha) {
                    return _deps.showAlert("Debes seleccionar una fecha para la próxima acción de seguimiento.");
                }
                const tipoElem = doc.getElementById('mgr-autorizar-prox-tipo');
                const tipo = tipoElem ? tipoElem.value : 'llamada';
                const descElem = doc.getElementById('mgr-autorizar-prox-desc');
                const descripcion = descElem ? descElem.value.trim() : '';

                const payload = {
                    prospectId,
                    decision: 'autorizar_continuar',
                    justificacion,
                    proximaAccion: { fecha, tipo, descripcion },
                    dbSuffix: dbSuffix
                };

                const res = await _deps.runWorkflowOp('Registrando autorización gerencial...', fb => crmComm.resolveFollowUpEscalation(fb, payload));
                if (res) {
                    _deps.closeModal('modal-manager-decision');
                    _deps.renderDashboard();
                    const activeId = _deps.getCurrentProspectId();
                    if (activeId === prospectId) _deps.openDetail(prospectId);
                }
            } else if (decisionType === 'ordenar_cierre') {
                const motivoElem = doc.getElementById('mgr-cierre-motivo');
                const motivo = motivoElem ? motivoElem.value : '';
                if (!motivo) {
                    return _deps.showAlert("Debes seleccionar un motivo de pérdida comercial.");
                }
                const justificacionElem = doc.getElementById('mgr-cierre-justificacion');
                const justificacion = justificacionElem ? justificacionElem.value.trim() : '';
                const inmElem = doc.getElementById('mgr-cierre-ejecutar-inmediato');
                const ejecutarCierre = inmElem ? inmElem.checked : true;

                const payload = {
                    prospectId,
                    decision: 'ordenar_cierre',
                    motivo,
                    justificacion,
                    ejecutarCierre,
                    dbSuffix: dbSuffix
                };

                const res = await _deps.runWorkflowOp('Registrando orden de cierre...', fb => crmComm.resolveFollowUpEscalation(fb, payload));
                if (res) {
                    _deps.closeModal('modal-manager-decision');
                    _deps.renderDashboard();
                    const activeId = _deps.getCurrentProspectId();
                    if (activeId === prospectId) _deps.openDetail(prospectId);
                }
            }
        } finally {
            _isSubmitting = false;
        }
    }

    // -------------------------------------------------------------------------
    // 6. API Pública de Dashboard Manager Workflow
    // -------------------------------------------------------------------------
    return {
        setDeps,
        switchManagerDecisionTab,
        openManagerDecisionModal,
        submitManagerDecision,
        getCurrentDecisionProspectId: () => _currentDecisionProspectId,
        setCurrentDecisionProspectId: (id) => { _currentDecisionProspectId = id; }
    };
});
