// ============================================================================
// DUCTSAL ERP — DASHBOARD MODULE: UI (Fase 6.5.2)
// Archivo: modules/dashboard/dashboard_ui.js
// Responsabilidades:
// 1. Renderizado de tarjetas KPI de Flujo del Período (ganadas, margen, win rate, altas, perdidas).
// 2. Renderizado de tarjetas KPI de Stock Vivo (pipeline nominal/ponderado, CxC global, alertas).
// 3. Renderizado de la cuadrícula de Tiempos Promedio en Etapa (renderDashboardKpiTimes).
// 4. Renderizado y gestión de filtros de la tabla de Atención Gerencial (renderDashboardActiveTimes).
// 5. Gestión de badges de estado, estados vacíos y compatibilidad UMD/global.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.DashboardUI = api;
        if (typeof window !== 'undefined') {
            window.DashboardUI = api;
            window.renderDashboardKpiTimes = api.renderDashboardKpiTimes;
            window.renderDashboardActiveTimes = api.renderDashboardActiveTimes;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Constantes canónicas del dominio
    // -------------------------------------------------------------------------
    const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
    const KPI_LIMITS = { 'prospecto': 3, 'levantamiento': 5, 'cotizacion': 5, 'negociacion': null, 'cierre': 5 };

    const STAGE_LABELS = {
        prospecto: 'Prospecto',
        levantamiento: 'Levantamiento',
        cotizacion: 'Cotización',
        negociacion: 'Negociación',
        cierre: 'Cierre'
    };

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
        getCrmDashboardCalc: () => {
            if (typeof CrmDashboardCalc !== 'undefined') return CrmDashboardCalc;
            if (typeof window !== 'undefined' && window.CrmDashboardCalc) return window.CrmDashboardCalc;
            if (typeof global !== 'undefined' && global.CrmDashboardCalc) return global.CrmDashboardCalc;
            return null;
        },
        getCrmFollowUpCalc: () => {
            if (typeof CrmFollowUpCalc !== 'undefined') return CrmFollowUpCalc;
            if (typeof window !== 'undefined' && window.CrmFollowUpCalc) return window.CrmFollowUpCalc;
            if (typeof global !== 'undefined' && global.CrmFollowUpCalc) return global.CrmFollowUpCalc;
            return null;
        },
        getDocument: () => {
            if (typeof document !== 'undefined') return document;
            return null;
        },
        formatCurrency: (val) => {
            if (typeof formatCurrency === 'function') return formatCurrency(val);
            if (typeof window !== 'undefined' && typeof window.formatCurrency === 'function') return window.formatCurrency(val);
            return '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        },
        formatDate: (dateStr) => {
            if (typeof formatDate === 'function') return formatDate(dateStr);
            if (typeof window !== 'undefined' && typeof window.formatDate === 'function') return window.formatDate(dateStr);
            if (!dateStr) return '-';
            try {
                const d = new Date(dateStr);
                return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
            } catch (e) {
                return String(dateStr);
            }
        },
        escapeHtmlDoc: (str) => {
            if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        getClientName: (clientId) => {
            if (typeof getClientName === 'function') return getClientName(clientId);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(clientId);
            return clientId || '-';
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
    // 3. Renderizado de Tarjetas KPI (Flujo del Período y Stock Vivo)
    // -------------------------------------------------------------------------
    function renderDashboardKpiCards(filterRes, prospectsList, usersList, options) {
        const doc = _deps.getDocument();
        if (!doc) return;
        const calc = _deps.getCrmDashboardCalc();
        const followUp = _deps.getCrmFollowUpCalc();
        const formatMoney = _deps.formatCurrency;
        const filterVal = (options && options.filterVal) || 'all';

        const safeProspects = Array.isArray(prospectsList) ? prospectsList : _deps.getProspects();
        const safeUsers = Array.isArray(usersList) ? usersList : _deps.getUsers();

        // 1. VENTAS GANADAS Y MARGEN (Flujo del período con órdenes de cambio)
        const wonMetrics = (calc && typeof calc.calculateWonMetrics === 'function')
            ? calc.calculateWonMetrics(filterRes.flujoGanadas)
            : { totalPrecio: 0, totalCosto: 0, margen: 0, margenPct: 0, countTotal: 0, countWithCost: 0, countWithoutCost: 0, isCostComplete: true };

        const metricGanadas = doc.getElementById('metric-ganadas');
        if (metricGanadas) metricGanadas.textContent = formatMoney(wonMetrics.totalPrecio);

        const subGanadas = doc.getElementById('sub-metric-ganadas');
        if (subGanadas) {
            subGanadas.textContent = `${wonMetrics.countTotal} operaciones ganadas`;
        }

        const metricMargen = doc.getElementById('metric-margen');
        if (metricMargen) metricMargen.textContent = formatMoney(wonMetrics.margen);

        const subMargen = doc.getElementById('sub-metric-margen');
        if (subMargen) {
            if (!wonMetrics.isCostComplete && wonMetrics.countWithoutCost > 0) {
                const cov = wonMetrics.coberturaPct !== undefined && wonMetrics.coberturaPct !== null
                    ? wonMetrics.coberturaPct.toFixed(1)
                    : ((wonMetrics.precioWithCost / (wonMetrics.totalPrecio || 1)) * 100).toFixed(1);
                subMargen.textContent = `Margen bruto conocido (${cov}% cob.)`;
                subMargen.title = `Margen calculado sobre ${formatMoney(wonMetrics.precioWithCost)} en ventas con costo conocido de un total de ${formatMoney(wonMetrics.totalPrecio)} (${cov}% de cobertura)`;
            } else {
                subMargen.textContent = 'Margen bruto conocido';
                subMargen.title = 'Margen comercial consolidado con 100% de costos registrados';
            }
        }

        const margenPctElem = doc.getElementById('metric-margen-pct');
        if (margenPctElem) {
            if (wonMetrics.margenPct !== null) {
                margenPctElem.textContent = wonMetrics.margenPct.toFixed(1) + '%';
                margenPctElem.style.background = 'rgba(16, 185, 129, 0.2)';
                margenPctElem.style.color = 'var(--success)';
                margenPctElem.title = wonMetrics.isCostComplete
                    ? 'Margen comercial consolidado con órdenes de cambio'
                    : `Margen calculado sobre ${wonMetrics.countWithCost}/${wonMetrics.countTotal} operaciones con costo registrado (${wonMetrics.coberturaPct !== undefined ? wonMetrics.coberturaPct.toFixed(1) : ''}% cobertura)`;
            } else {
                margenPctElem.textContent = 'N/D';
                margenPctElem.style.background = 'rgba(160, 170, 191, 0.2)';
                margenPctElem.style.color = 'var(--text-secondary)';
                margenPctElem.title = 'Sin costos de venta registrados en las operaciones ganadas';
            }
        }

        const costWarning = doc.getElementById('metric-cost-warning');
        if (costWarning) {
            if (!wonMetrics.isCostComplete && wonMetrics.countWithoutCost > 0) {
                costWarning.style.display = 'inline';
                costWarning.textContent = `⚠️ ${wonMetrics.countWithoutCost} sin costo`;
                costWarning.title = `${wonMetrics.countWithoutCost} proyecto(s) ganado(s) (${formatMoney(wonMetrics.totalPrecio - wonMetrics.precioWithCost)}) no tienen costo registrado y quedan excluidos del margen comercial`;
            } else {
                costWarning.style.display = 'none';
            }
        }

        // 2. TASA DE CIERRE REAL (Ganadas / [Ganadas + Perdidas])
        const countGanadas = filterRes.flujoGanadas ? filterRes.flujoGanadas.length : 0;
        const countPerdidas = filterRes.flujoPerdidas ? filterRes.flujoPerdidas.length : 0;
        const countConcluidas = countGanadas + countPerdidas;
        const winRate = countConcluidas > 0 ? (countGanadas / countConcluidas) * 100 : null;

        const metricWinRate = doc.getElementById('metric-win-rate');
        if (metricWinRate) {
            metricWinRate.textContent = winRate !== null ? `${winRate.toFixed(1)}%` : 'N/D';
        }

        const subWinRate = doc.getElementById('sub-metric-win-rate');
        if (subWinRate) {
            subWinRate.textContent = countConcluidas > 0
                ? `${countGanadas} ganadas de ${countConcluidas} cerradas`
                : 'Sin operaciones cerradas en el período';
        }

        // 3. ALTAS DEL PERÍODO (Nuevas oportunidades)
        const altas = filterRes.flujoAltas || [];
        const totalAltasCotizado = altas.reduce((acc, p) => acc + (calc && typeof calc.getProjectSubtotal === 'function' ? calc.getProjectSubtotal(p) : (Number(p.precio_cotizado) || 0)), 0);

        const metricAltasCount = doc.getElementById('metric-altas-count');
        if (metricAltasCount) metricAltasCount.textContent = altas.length;

        const subAltas = doc.getElementById('sub-metric-altas');
        if (subAltas) subAltas.textContent = `Cotizado: ${formatMoney(totalAltasCotizado)}`;

        // 4. VENTAS PERDIDAS (Flujo del período seleccionado)
        const lostMetrics = (calc && typeof calc.calculateLostMetrics === 'function')
            ? calc.calculateLostMetrics(filterRes.flujoPerdidas)
            : { totalPrecio: 0, count: 0 };

        const metricPerdidas = doc.getElementById('metric-perdidas');
        if (metricPerdidas) metricPerdidas.textContent = formatMoney(lostMetrics.totalPrecio);

        const subPerdidas = doc.getElementById('sub-metric-perdidas');
        if (subPerdidas) {
            subPerdidas.textContent = filterVal === 'all'
                ? `${lostMetrics.count} operaciones perdidas en histórico total`
                : `${lostMetrics.count} operaciones perdidas en el período seleccionado`;
        }

        // 5. PIPELINE PONDERADO & NOMINAL (STOCK VIVO - Todas las oportunidades activas hoy)
        const activeMetrics = (calc && typeof calc.calculateActivePipelineMetrics === 'function')
            ? calc.calculateActivePipelineMetrics(filterRes.stockActivo)
            : { totalPonderado: 0, totalNominal: 0, montoSinProbabilidad: 0, countSinProbabilidad: 0, margenPonderado: 0, margenPonderadoPct: 0, countPonderadas: 0, countSinPonderar: 0 };

        const metricPipePond = doc.getElementById('metric-pipeline-ponderado');
        if (metricPipePond) {
            metricPipePond.textContent = formatMoney(activeMetrics.totalPonderado);
            metricPipePond.title = activeMetrics.countSinPonderar > 0
                ? `Nominal total: ${formatMoney(activeMetrics.totalNominal)} | Ponderado: ${formatMoney(activeMetrics.totalPonderado)} | Sin ponderar: ${formatMoney(activeMetrics.montoSinPonderar || 0)} (${activeMetrics.countSinPonderar} ops sin precio o probabilidad)`
                : `Nominal total: ${formatMoney(activeMetrics.totalNominal)} (100% ponderado)`;
        }

        const metricPipeNominal = doc.getElementById('metric-pipeline-nominal');
        if (metricPipeNominal) metricPipeNominal.textContent = formatMoney(activeMetrics.totalNominal);

        const metricPipeMargen = doc.getElementById('metric-pipeline-margen');
        if (metricPipeMargen) metricPipeMargen.textContent = formatMoney(activeMetrics.margenPonderado);

        const pipeMargenPctElem = doc.getElementById('metric-pipeline-margen-pct');
        if (pipeMargenPctElem) {
            pipeMargenPctElem.textContent = activeMetrics.margenPonderadoPct.toFixed(1) + '%';
        }

        const unweightedBadge = doc.getElementById('metric-pipeline-unweighted-badge');
        if (unweightedBadge) {
            if (activeMetrics.countSinProbabilidad > 0) {
                unweightedBadge.style.display = 'inline-block';
                unweightedBadge.textContent = `⚠️ ${activeMetrics.countSinProbabilidad} sin prob. (${formatMoney(activeMetrics.montoSinProbabilidad)})`;
                unweightedBadge.title = `${activeMetrics.countSinProbabilidad} oportunidades activas no tienen probabilidad válida y no están sumadas al ponderado.`;
            } else {
                unweightedBadge.style.display = 'none';
            }
        }

        // 6. CXC GLOBAL (Stock vivo de cuentas por cobrar hoy)
        const prospects = safeProspects;
        const cxcUniverse = (prospects && Array.isArray(prospects)) ? prospects.filter(p => p && p.eliminado !== true) : [];
        const cxcMetrics = (calc && typeof calc.calculateCxCMetrics === 'function')
            ? calc.calculateCxCMetrics(cxcUniverse)
            : { totalFacturado: 0, totalCobrado: 0, totalCxC: 0, pctCobrado: 0 };

        const metricFacturado = doc.getElementById('metric-total-facturado');
        if (metricFacturado) metricFacturado.textContent = formatMoney(cxcMetrics.totalFacturado);

        const metricCobrado = doc.getElementById('metric-total-cobrado');
        if (metricCobrado) metricCobrado.textContent = formatMoney(cxcMetrics.totalCobrado);

        const metricTotalCxc = doc.getElementById('metric-total-cxc');
        if (metricTotalCxc) {
            metricTotalCxc.textContent = formatMoney(cxcMetrics.totalCxC);
            if (cxcMetrics.hasInvalidRecords) {
                metricTotalCxc.title = `Atención: ${cxcMetrics.invalidFacturasCount} facturas o ${cxcMetrics.invalidPagosCount} abonos con datos incompletos excluidos del cálculo.`;
            }
        }

        const cxcPctBadge = doc.getElementById('cxc-pct-badge');
        if (cxcPctBadge) {
            cxcPctBadge.textContent = `${cxcMetrics.pctCobrado.toFixed(1)}% cobrado`;
        }

        const cxcBar = doc.getElementById('cxc-bar-cobrado');
        if (cxcBar) cxcBar.style.width = cxcMetrics.pctCobrado + '%';

        // 7. ALERTAS Y RESUMEN OPERATIVO DEL STOCK: ATENCIÓN GERENCIAL
        const managerAttention = (followUp && typeof followUp.calculateManagerAttentionItems === 'function')
            ? followUp.calculateManagerAttentionItems(safeProspects, safeUsers)
            : { counts: { total: 0, pendientes: 0, autorizadas: 0, orden_cierre: 0 }, items: [], pendingUniqueCount: 0 };

        const metricAlertasCount = doc.getElementById('metric-alertas-count');
        if (metricAlertasCount) metricAlertasCount.textContent = managerAttention.pendingUniqueCount;

        const metricActivasTotal = doc.getElementById('metric-activas-total-count');
        if (metricActivasTotal) metricActivasTotal.textContent = filterRes.stockActivo ? filterRes.stockActivo.length : (safeProspects ? safeProspects.filter(p => p && p.estado === 'activo' && p.eliminado !== true).length : 0);

        const dashStagnantBadge = doc.getElementById('dash-stagnant-counter-badge');
        if (dashStagnantBadge) {
            dashStagnantBadge.textContent = `${managerAttention.pendingUniqueCount} pendiente${managerAttention.pendingUniqueCount !== 1 ? 's' : ''}`;
            dashStagnantBadge.style.background = managerAttention.pendingUniqueCount > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)';
            dashStagnantBadge.style.color = managerAttention.pendingUniqueCount > 0 ? 'var(--danger)' : 'var(--success)';
            dashStagnantBadge.style.borderColor = managerAttention.pendingUniqueCount > 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)';
        }

        const subAlertasStatus = doc.getElementById('sub-metric-alertas-status');
        if (subAlertasStatus) {
            subAlertasStatus.textContent = managerAttention.pendingUniqueCount > 0
                ? `${managerAttention.pendingUniqueCount} oportunidades requieren decisión gerencial`
                : 'Sin alertas gerenciales pendientes';
        }
    }

    // -------------------------------------------------------------------------
    // 4. Renderizado de Tiempos Promedio en Etapa (Cuadrícula)
    // -------------------------------------------------------------------------
    function renderDashboardKpiTimes(filterRes) {
        const doc = _deps.getDocument();
        if (!doc) return;
        const grid = doc.getElementById('kpi-times-grid');
        if (!grid) return;

        const safeProspects = _deps.getProspects();
        const calc = _deps.getCrmDashboardCalc();

        const universe = (filterRes && filterRes.closedInPeriod && filterRes.closedInPeriod.length > 0)
            ? [...filterRes.closedInPeriod, ...(filterRes.stockActivo || [])]
            : safeProspects;

        const transitionStats = (calc && typeof calc.calculateStageTransitionTimes === 'function')
            ? calc.calculateStageTransitionTimes(universe, STAGES, KPI_LIMITS)
            : {};

        let html = '';

        STAGES.forEach(stage => {
            const stat = transitionStats[stage] || { avgDays: 0, countCompleted: 0, isOverLimit: false, hasData: false };
            const isOverLimit = stat.isOverLimit;
            const stageName = STAGE_LABELS[stage] || stage;
            const avgDisplay = stat.hasData
                ? `${stat.avgDays} <span style="font-size:0.75rem; font-weight:normal; color:var(--text-secondary)">d</span>`
                : '-';
            const countSubtitle = stat.hasData
                ? `${stat.countCompleted} transic.`
                : 'Sin datos';

            html += `
                <div class="dash-stage-card ${isOverLimit ? 'over-limit' : ''}">
                    <div class="dash-stage-name" title="${stageName}">${stageName}</div>
                    <div class="dash-stage-val ${isOverLimit ? 'val-danger' : ''}">${avgDisplay}</div>
                    <div class="dash-stage-sub">${countSubtitle}</div>
                </div>
            `;
        });

        grid.innerHTML = html;
    }

    // -------------------------------------------------------------------------
    // 5. Renderizado de Tabla de Oportunidades con Atención Gerencial
    // -------------------------------------------------------------------------
    function renderDashboardActiveTimes(activeList) {
        const doc = _deps.getDocument();
        if (!doc) return;

        const tableWrapper = doc.getElementById('dash-stagnant-table-wrapper');
        const emptyBox = doc.getElementById('dash-stagnant-empty-box');
        const tbody = doc.getElementById('dash-active-times-body');
        const counterBadge = doc.getElementById('dash-stagnant-counter-badge');

        const safeProspects = _deps.getProspects();
        const safeUsers = _deps.getUsers();
        const currentUserObj = _deps.getCurrentUser();
        const followUp = _deps.getCrmFollowUpCalc();
        const escapeHtml = _deps.escapeHtmlDoc;
        const resolveClientName = _deps.getClientName;

        // 1. Obtener filtros de atención gerencial
        const filterMotivo = doc.getElementById('filter-mgr-motivo') ? doc.getElementById('filter-mgr-motivo').value : 'all';
        const filterRespSelect = doc.getElementById('filter-mgr-responsable');
        const filterResp = filterRespSelect ? filterRespSelect.value : 'all';
        const filterEstado = doc.getElementById('filter-mgr-estado') ? doc.getElementById('filter-mgr-estado').value : 'pendientes';

        // 2. Calcular universo de atención gerencial con reglas oficiales
        const attentionData = (followUp && typeof followUp.calculateManagerAttentionItems === 'function')
            ? followUp.calculateManagerAttentionItems(safeProspects, safeUsers, {
                filterMotivo,
                filterResponsable: filterResp,
                filterEstado
            })
            : { counts: { total: 0, pendientes: 0, autorizadas: 0, orden_cierre: 0 }, items: [], pendingUniqueCount: 0 };

        // 3. Poblar dropdown de responsables dinámicamente si no está poblado
        if (followUp && typeof followUp.calculateManagerAttentionItems === 'function' && filterRespSelect && filterRespSelect.options.length <= 1) {
            const rawItems = followUp.calculateManagerAttentionItems(safeProspects, safeUsers, { filterMotivo: 'all', filterResponsable: 'all', filterEstado: 'todas' }).items;
            const respSet = new Set();
            rawItems.forEach(it => { if (it.responsable && it.responsable !== '-') respSet.add(it.responsable); });
            Array.from(respSet).sort().forEach(respName => {
                const opt = doc.createElement('option');
                opt.value = respName;
                opt.textContent = respName;
                filterRespSelect.appendChild(opt);
            });
        }

        const pendingCount = attentionData.pendingUniqueCount;

        if (counterBadge) {
            if (pendingCount === 0) {
                counterBadge.textContent = '0 pendientes';
                counterBadge.style.color = '#10b981';
                counterBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                counterBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';
            } else {
                counterBadge.textContent = `${pendingCount} pendiente${pendingCount > 1 ? 's' : ''}`;
                counterBadge.style.color = 'var(--danger)';
                counterBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                counterBadge.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            }
        }

        const displayItems = attentionData.items;

        if (displayItems.length === 0) {
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (emptyBox) emptyBox.style.display = 'flex';
            if (tbody) tbody.innerHTML = '';
            return;
        }

        if (emptyBox) emptyBox.style.display = 'none';
        if (tableWrapper) tableWrapper.style.display = 'block';

        if (!tbody) return;

        const isManager = currentUserObj && currentUserObj.role === 'manager';

        let rowsHtml = '';
        displayItems.forEach(item => {
            const clientName = resolveClientName(item.clientId);

            let statusBadge = '';
            if (item.alerta_estado === 'continuidad_autorizada') {
                statusBadge = '<span class="badge-mgr-alert badge-mgr-authorized">✅ Continuidad Autorizada</span>';
            } else if (item.alerta_estado === 'orden_cierre_pendiente') {
                statusBadge = '<span class="badge-mgr-alert badge-mgr-closing">🛑 Orden Cierre Pendiente</span>';
            } else if (item.alerta_estado === 'orden_cierre_ejecutada') {
                statusBadge = '<span class="badge-mgr-alert badge-mgr-resolved">🔒 Cierre Ejecutado</span>';
            } else {
                statusBadge = '<span class="badge-mgr-alert badge-mgr-pending">⏳ Decisión Pendiente</span>';
            }

            const motivosHtml = (item.motivoObjects && item.motivoObjects.length > 0)
                ? item.motivoObjects.map(m => {
                    if (m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos' || m.subtipo === 'cinco_intentos') {
                        return `<span class="badge-mgr-reason badge-mgr-followup" style="display: block; font-size: 0.78rem; color: #f87171; font-weight: 600; line-height: 1.3; margin-bottom: 2px;">📞 <span style="background: rgba(239, 68, 68, 0.2); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem; margin-right: 3px; border: 1px solid rgba(239, 68, 68, 0.4);">Seguimiento</span> ${escapeHtml(m.descripcion)}</span>`;
                    } else if (m.tipo === 'solicitud_sin_contrato') {
                        return `<span class="badge-mgr-reason badge-mgr-contract" style="display: block; font-size: 0.78rem; color: var(--brand-gold); font-weight: 600; line-height: 1.3; margin-bottom: 2px;">📄 <span style="background: rgba(245, 158, 11, 0.2); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem; margin-right: 3px; border: 1px solid rgba(245, 158, 11, 0.4);">Sin Contrato</span> ${escapeHtml(m.descripcion)}</span>`;
                    } else if (m.tipo === 'limite_etapa') {
                        return `<span class="badge-mgr-reason badge-mgr-overdue" style="display: block; font-size: 0.78rem; color: #f87171; font-weight: 600; line-height: 1.3; margin-bottom: 2px;">⏰ <span style="background: rgba(239, 68, 68, 0.2); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem; margin-right: 3px; border: 1px solid rgba(239, 68, 68, 0.4);">Límite Etapa</span> ${escapeHtml(m.descripcion)}</span>`;
                    }
                    return `<span style="display: block; font-size: 0.78rem; color: var(--danger); font-weight: 600; line-height: 1.3; margin-bottom: 2px;">⚠️ ${escapeHtml(m.descripcion || m)}</span>`;
                }).join('')
                : (item.motivos || [item.motivoPrincipal]).map(m =>
                    `<span style="display: block; font-size: 0.78rem; color: var(--danger); font-weight: 600; line-height: 1.3;">⚠️ ${escapeHtml(m)}</span>`
                ).join('');

            let historialSummary = '';
            if (item.intentosValidos > 0) {
                historialSummary += `<span style="font-size: 0.78rem; color: var(--text-secondary); display: block;">${item.intentosValidos} intentos sin respuesta</span>`;
            }
            if (item.hasStageLimitOverrun || (item.motivoObjects && item.motivoObjects.some(m => m.tipo === 'limite_etapa'))) {
                const overrunObj = item.motivoObjects ? item.motivoObjects.find(m => m.tipo === 'limite_etapa') : null;
                const atraso = overrunObj ? overrunObj.diasAtraso : (item.diasAtraso || item.dias_retraso);
                historialSummary += `<span style="font-size: 0.78rem; color: #fca5a5; display: block;">Etapa: <strong>${item.etapa || '-'}</strong> | Atraso: <strong>+${atraso}d hábiles</strong></span>`;
            }
            if (item.justificacionVendedor) {
                historialSummary += `<span style="font-size: 0.75rem; color: var(--brand-gold); display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.justificacionVendedor)}">💬 Vendedor: ${escapeHtml(item.justificacionVendedor)}</span>`;
            }
            if (!historialSummary) {
                historialSummary = `<span style="font-size: 0.75rem; color: var(--text-muted);">-</span>`;
            }

            const canDecideFollowUp = isManager && item.isPending && (item.hasFollowUpEscalation || (item.motivoObjects && item.motivoObjects.some(m => m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos')));
            const canResolveNoContract = isManager && item.isPending && (item.hasNoContractRequest || (item.motivoObjects && item.motivoObjects.some(m => m.tipo === 'solicitud_sin_contrato')));

            let actionButtonsHtml = '';
            if (canDecideFollowUp) {
                actionButtonsHtml += `<button class="btn-table-action" style="background: rgba(245, 158, 11, 0.2); color: var(--brand-gold); border: 1px solid var(--brand-gold); padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 700;" onclick="openManagerDecisionModal('${item.id}')" title="Tomar decisión de continuidad o cierre">⚖️ Decidir</button>`;
            }
            if (canResolveNoContract && !canDecideFollowUp) {
                actionButtonsHtml += `<button class="btn-table-action" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid #3b82f6; padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 700;" onclick="openDetail('${item.id}')" title="Revisar y resolver solicitud sin contrato">📄 Resolver</button>`;
            }
            actionButtonsHtml += `<button class="btn-table-action btn-table-edit" onclick="openDetail('${item.id}')" title="Ver detalle completo">👁️ Ver</button>`;

            rowsHtml += `
                <tr class="cursor-pointer" onclick="openDetail('${item.id}')">
                    <td><strong style="color: var(--brand-gold);">${escapeHtml(item.codigo || item.id.slice(-4))}</strong></td>
                    <td>
                        <strong style="color: white; display: block;">${escapeHtml(item.proyecto)}</strong>
                        <small style="color: var(--text-secondary);">${escapeHtml(clientName)}</small>
                    </td>
                    <td><strong style="color: white; font-size: 0.85rem;">${escapeHtml(item.responsable)}</strong></td>
                    <td>${motivosHtml}</td>
                    <td>${historialSummary}</td>
                    <td style="text-align: center;">${statusBadge}</td>
                    <td style="text-align: right;" onclick="event.stopPropagation()">
                        <div style="display: flex; gap: 0.35rem; justify-content: flex-end; flex-wrap: wrap;">
                            ${actionButtonsHtml}
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = rowsHtml;
    }

    // -------------------------------------------------------------------------
    // 6. API Pública de Dashboard UI
    // -------------------------------------------------------------------------
    return {
        setDeps,
        renderDashboardKpiCards,
        renderDashboardKpiTimes,
        renderDashboardActiveTimes,
        STAGES,
        KPI_LIMITS,
        STAGE_LABELS
    };
});
