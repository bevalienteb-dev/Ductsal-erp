// ============================================================================
// DUCTSAL ERP — DASHBOARD MODULE: CONTROLLER (Fase 6.5.1)
// Archivo: modules/dashboard/dashboard_controller.js
// Responsabilidades:
// 1. Estado y orquestación del Centro de Mando Comercial (Dashboard).
// 2. Gestión y poblado del filtro temporal multianual (populateTimeFilter).
// 3. Segmentación del dataset en flujo y stock (getFilteredProspects).
// 4. Gestión del modo de filtro de vendedores (setSellerFilterMode).
// 5. Orquestador de actualización reactiva (renderDashboard).
// 6. Fachada unificada y compatibilidad UMD/global con app_core.js.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.DashboardController = api;
        if (typeof window !== 'undefined') {
            window.DashboardController = api;
            window.populateTimeFilter = api.populateTimeFilter;
            window.getFilteredProspects = api.getFilteredProspects;
            window.setSellerFilterMode = api.setSellerFilterMode;
            window.getSellerFilterMode = api.getSellerFilterMode;
            window.updateSellerFilterButtons = api.updateSellerFilterButtons;
            window.renderDashboard = api.renderDashboard;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado local del Dashboard Controller
    // -------------------------------------------------------------------------
    let _currentSellerFilterMode = 'active_only';

    // Constante canónica de meses para el filtro temporal
    const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    // -------------------------------------------------------------------------
    // 2. Dependencias inyectadas con fallbacks seguros a globales
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
        getDashboardUI: () => {
            if (typeof DashboardUI !== 'undefined') return DashboardUI;
            if (typeof window !== 'undefined' && window.DashboardUI) return window.DashboardUI;
            return null;
        },
        getDashboardCharts: () => {
            if (typeof DashboardCharts !== 'undefined') return DashboardCharts;
            if (typeof window !== 'undefined' && window.DashboardCharts) return window.DashboardCharts;
            return null;
        },
        getDashboardAudit: () => {
            if (typeof DashboardAudit !== 'undefined') return DashboardAudit;
            if (typeof window !== 'undefined' && window.DashboardAudit) return window.DashboardAudit;
            return null;
        },
        getDashboardManagerWorkflow: () => {
            if (typeof DashboardManagerWorkflow !== 'undefined') return DashboardManagerWorkflow;
            if (typeof window !== 'undefined' && window.DashboardManagerWorkflow) return window.DashboardManagerWorkflow;
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
    // 3. Gestión del Filtro de Período Temporal
    // -------------------------------------------------------------------------
    function populateTimeFilter() {
        const doc = _deps.getDocument();
        if (!doc) return;
        const select = doc.getElementById('dash-time-filter');
        if (!select) return;
        const currentVal = select.value;

        select.innerHTML = '<option value="all">Histórico Completo</option>';

        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();

        const prospectsList = _deps.getProspects();
        const calc = _deps.getCrmDashboardCalc();

        // Descubrir años disponibles en el dataset para consulta multianual
        const availableYears = (calc && typeof calc.getAvailableYears === 'function')
            ? calc.getAvailableYears(prospectsList, currentYear)
            : [currentYear];

        availableYears.forEach(year => {
            const isCurrent = (year === currentYear);
            const ytdLabel = isCurrent ? `YTD ${year} (Año en curso)` : `Año ${year} Completo`;
            select.innerHTML += `<option value="year_${year}">${ytdLabel}</option>`;

            const maxMonth = isCurrent ? currentMonth : 11;
            for (let i = maxMonth; i >= 0; i--) {
                select.innerHTML += `<option value="${year}-${i}">${MESES[i]} ${year}</option>`;
            }
        });

        if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
            select.value = currentVal;
        } else {
            const ytdOpt = Array.from(select.options).find(o => o.value === `year_${currentYear}`);
            select.value = ytdOpt ? `year_${currentYear}` : 'all';
        }
    }

    function getFilteredProspects() {
        const doc = _deps.getDocument();
        const select = doc ? doc.getElementById('dash-time-filter') : null;
        const filter = (select && select.value) || 'all';
        const prospectsList = _deps.getProspects();
        const calc = _deps.getCrmDashboardCalc();

        if (calc && typeof calc.filterProspects === 'function') {
            return calc.filterProspects(prospectsList, filter);
        }

        const stockActivo = prospectsList.filter(p => p && p.estado === 'activo' && p.eliminado !== true);
        const flujoGanadas = prospectsList.filter(p => p && p.estado === 'ganado' && p.eliminado !== true);
        const flujoPerdidas = prospectsList.filter(p => p && p.estado === 'perdido' && p.eliminado !== true);
        return {
            filter,
            isHistorical: filter === 'all',
            flujoGanadas,
            flujoPerdidas,
            flujoAltas: prospectsList.filter(p => p && p.eliminado !== true),
            stockActivo,
            closedInPeriod: [...flujoGanadas, ...flujoPerdidas]
        };
    }

    // -------------------------------------------------------------------------
    // 4. Gestión del Filtro de Vendedores (Solo Activos vs Histórico)
    // -------------------------------------------------------------------------
    function setSellerFilterMode(mode) {
        if (mode === 'active_only' || mode === 'all') {
            _currentSellerFilterMode = mode;
            updateSellerFilterButtons();
            renderDashboard();
        }
    }

    function getSellerFilterMode() {
        return _currentSellerFilterMode;
    }

    function updateSellerFilterButtons() {
        const doc = _deps.getDocument();
        if (!doc) return;
        const btnActive = doc.getElementById('btn-seller-filter-active');
        const btnAll = doc.getElementById('btn-seller-filter-all');
        if (btnActive) {
            if (_currentSellerFilterMode === 'active_only') {
                btnActive.classList.add('active');
            } else {
                btnActive.classList.remove('active');
            }
        }
        if (btnAll) {
            if (_currentSellerFilterMode === 'all') {
                btnAll.classList.add('active');
            } else {
                btnAll.classList.remove('active');
            }
        }
    }

    // -------------------------------------------------------------------------
    // 5. Orquestador Principal: renderDashboard()
    // -------------------------------------------------------------------------
    function renderDashboard() {
        const doc = _deps.getDocument();
        const filterRes = getFilteredProspects();
        const select = doc ? doc.getElementById('dash-time-filter') : null;
        const filterVal = (select && select.value) || 'all';

        // 0. ACTUALIZAR CABECERA: Período activo y timestamp de sincronización
        if (doc) {
            const periodBadge = doc.getElementById('dash-active-period-badge');
            if (periodBadge && select) {
                const activeOption = select.options[select.selectedIndex];
                periodBadge.textContent = activeOption ? activeOption.text : 'Histórico Completo';
            }
            const lastUpdatedElem = doc.getElementById('dash-last-updated');
            if (lastUpdatedElem) {
                lastUpdatedElem.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
            }
        }

        const prospectsList = _deps.getProspects();
        const usersList = _deps.getUsers();
        const currentUserObj = _deps.getCurrentUser();
        const ui = _deps.getDashboardUI();
        const charts = _deps.getDashboardCharts();
        const audit = _deps.getDashboardAudit();

        // 1 a 7. RENDERIZAR TARJETAS KPI (Flujo, Stock Vivo, CxC, Alertas)
        if (ui && typeof ui.renderDashboardKpiCards === 'function') {
            ui.renderDashboardKpiCards(filterRes, prospectsList, usersList, { filterVal });
        } else {
            // Fallback si DashboardUI aún no está inicializado o cargado
            _renderKpiCardsFallback(filterRes, prospectsList, usersList, filterVal);
        }

        // 8. RENDERIZADO DE GRÁFICOS Y TABLAS (Flujo vs Stock)
        if (charts && typeof charts.renderCharts === 'function') {
            charts.renderCharts(filterRes);
        } else if (typeof renderCharts === 'function') {
            renderCharts(filterRes);
        }

        if (ui && typeof ui.renderDashboardKpiTimes === 'function') {
            ui.renderDashboardKpiTimes(filterRes);
        } else if (typeof renderDashboardKpiTimes === 'function') {
            renderDashboardKpiTimes(filterRes);
        }

        if (ui && typeof ui.renderDashboardActiveTimes === 'function') {
            ui.renderDashboardActiveTimes();
        } else if (typeof renderDashboardActiveTimes === 'function') {
            renderDashboardActiveTimes();
        }

        // 9. AUDITORÍA (Solo manager, suscripción controlada)
        if (currentUserObj && currentUserObj.role === 'manager') {
            if (audit && typeof audit.fetchAuditLogs === 'function') {
                audit.fetchAuditLogs();
            } else if (typeof fetchAuditLogs === 'function') {
                fetchAuditLogs();
            }
        }
    }

    // -------------------------------------------------------------------------
    // 6. Implementación Fallback de Tarjetas KPI
    // -------------------------------------------------------------------------
    function _renderKpiCardsFallback(filterRes, prospectsList, usersList, filterVal) {
        const doc = _deps.getDocument();
        if (!doc) return;
        const calc = _deps.getCrmDashboardCalc();
        const followUp = _deps.getCrmFollowUpCalc();
        const formatMoney = _deps.formatCurrency;

        // 1. VENTAS GANADAS Y MARGEN
        const wonMetrics = (calc && typeof calc.calculateWonMetrics === 'function')
            ? calc.calculateWonMetrics(filterRes.flujoGanadas)
            : { totalPrecio: 0, totalCosto: 0, margen: 0, margenPct: 0, countTotal: 0, countWithCost: 0, countWithoutCost: 0, isCostComplete: true };

        const metricGanadas = doc.getElementById('metric-ganadas');
        if (metricGanadas) metricGanadas.textContent = formatMoney(wonMetrics.totalPrecio);

        const subGanadas = doc.getElementById('sub-metric-ganadas');
        if (subGanadas) subGanadas.textContent = `${wonMetrics.countTotal} operaciones ganadas`;

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
                margenPctElem.style.background = 'rgba(160, 185, 129, 0.2)';
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

        // 2. TASA DE CIERRE REAL
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

        // 3. ALTAS DEL PERÍODO
        const altas = filterRes.flujoAltas || [];
        const totalAltasCotizado = altas.reduce((acc, p) => acc + (calc && typeof calc.getProjectSubtotal === 'function' ? calc.getProjectSubtotal(p) : (Number(p.precio_cotizado) || 0)), 0);

        const metricAltasCount = doc.getElementById('metric-altas-count');
        if (metricAltasCount) metricAltasCount.textContent = altas.length;

        const subAltas = doc.getElementById('sub-metric-altas');
        if (subAltas) subAltas.textContent = `Cotizado: ${formatMoney(totalAltasCotizado)}`;

        // 4. VENTAS PERDIDAS
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

        // 5. PIPELINE PONDERADO & NOMINAL (Stock vivo)
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

        // 6. CXC GLOBAL (Stock vivo de cuentas por cobrar)
        const cxcUniverse = (prospectsList && Array.isArray(prospectsList)) ? prospectsList.filter(p => p && p.eliminado !== true) : [];
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
            ? followUp.calculateManagerAttentionItems(prospectsList, usersList)
            : { counts: { total: 0, pendientes: 0, autorizadas: 0, orden_cierre: 0 }, items: [], pendingUniqueCount: 0 };

        const metricAlertasCount = doc.getElementById('metric-alertas-count');
        if (metricAlertasCount) metricAlertasCount.textContent = managerAttention.pendingUniqueCount;

        const metricActivasTotal = doc.getElementById('metric-activas-total-count');
        if (metricActivasTotal) metricActivasTotal.textContent = filterRes.stockActivo ? filterRes.stockActivo.length : (prospectsList ? prospectsList.filter(p => p && p.estado === 'activo' && p.eliminado !== true).length : 0);

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
    // 7. API Pública del Dashboard Controller
    // -------------------------------------------------------------------------
    return {
        setDeps,
        getSellerFilterMode,
        setSellerFilterMode,
        updateSellerFilterButtons,
        populateTimeFilter,
        getFilteredProspects,
        renderDashboard,
        _renderKpiCardsFallback
    };
});
