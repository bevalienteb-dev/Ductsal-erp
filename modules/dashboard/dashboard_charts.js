// ============================================================================
// DUCTSAL ERP — DASHBOARD MODULE: CHARTS & VISUALIZATIONS (Fase 6.5.3)
// Archivo: modules/dashboard/dashboard_charts.js
// Responsabilidades:
// 1. Ciclo de vida seguro e idempotente de gráficos Chart.js (prevención de fugas de memoria).
// 2. Gráfico 1: Evolución Mensual de Ventas y Margen Bruto (monthlyEvolutionChart).
// 3. Gráfico 2: Embudo de Ventas Activas en HTML/CSS responsivo (css-funnel-container).
// 4. Gráfico 3: Rendimiento y Tasa de Cierre por Canal de Origen (conversionChart).
// 5. Gráfico 4: Rendimiento Comercial por Vendedor y Gestor (sellerChart).
// 6. Gráfico 5: Motivos de Pérdida Comercial (lossChart).
// 7. Gráficos 6-9: Composición de Cierres y Pipeline por Producto y Proyecto.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.DashboardCharts = api;
        if (typeof window !== 'undefined') {
            window.DashboardCharts = api;
            window.renderCharts = api.renderCharts;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Instancias internas de gráficos Chart.js
    // -------------------------------------------------------------------------
    let _chartMonthly = null;
    let _chartOrigin = null;
    let _chartSeller = null;
    let _chartLoss = null;
    let _chartProduct = null;
    let _chartProject = null;
    let _chartOppProduct = null;
    let _chartOppProject = null;

    // Constantes de dominio de gráficos
    const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
    const KPI_LIMITS = { 'prospecto': 3, 'levantamiento': 5, 'cotizacion': 5, 'negociacion': null, 'cierre': 5 };
    const MOTIVOS_PERDIDA = [
        'Precio',
        'Falta de seguimiento',
        'No se cumplían los requerimientos técnicos',
        'Tiempo de entrega',
        'Cliente desiste'
    ];

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
        getCrmDashboardCalc: () => {
            if (typeof CrmDashboardCalc !== 'undefined') return CrmDashboardCalc;
            if (typeof window !== 'undefined' && window.CrmDashboardCalc) return window.CrmDashboardCalc;
            if (typeof global !== 'undefined' && global.CrmDashboardCalc) return global.CrmDashboardCalc;
            return null;
        },
        getSellerFilterMode: () => {
            if (typeof DashboardController !== 'undefined' && typeof DashboardController.getSellerFilterMode === 'function') {
                return DashboardController.getSellerFilterMode();
            }
            if (typeof currentSellerFilterMode !== 'undefined') return currentSellerFilterMode;
            if (typeof window !== 'undefined' && window.currentSellerFilterMode) return window.currentSellerFilterMode;
            return 'active_only';
        },
        updateSellerFilterButtons: () => {
            if (typeof DashboardController !== 'undefined' && typeof DashboardController.updateSellerFilterButtons === 'function') {
                return DashboardController.updateSellerFilterButtons();
            }
            if (typeof updateSellerFilterButtons === 'function') return updateSellerFilterButtons();
        },
        getDocument: () => {
            if (typeof document !== 'undefined') return document;
            return null;
        },
        getChartConstructor: () => {
            if (typeof Chart !== 'undefined') return Chart;
            if (typeof window !== 'undefined' && window.Chart) return window.Chart;
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
    // 3. Destrucción Segura de Gráficos (Prevención de Fugas de Memoria)
    // -------------------------------------------------------------------------
    function destroyAllCharts() {
        if (_chartMonthly) { _chartMonthly.destroy(); _chartMonthly = null; }
        if (_chartOrigin) { _chartOrigin.destroy(); _chartOrigin = null; }
        if (_chartSeller) { _chartSeller.destroy(); _chartSeller = null; }
        if (_chartLoss) { _chartLoss.destroy(); _chartLoss = null; }
        if (_chartProduct) { _chartProduct.destroy(); _chartProduct = null; }
        if (_chartProject) { _chartProject.destroy(); _chartProject = null; }
        if (_chartOppProduct) { _chartOppProduct.destroy(); _chartOppProduct = null; }
        if (_chartOppProject) { _chartOppProject.destroy(); _chartOppProject = null; }
    }

    // -------------------------------------------------------------------------
    // 4. Orquestador de Visualizaciones: renderCharts(filterRes)
    // -------------------------------------------------------------------------
    function renderCharts(filterRes) {
        const ChartLib = _deps.getChartConstructor();
        const doc = _deps.getDocument();
        if (!ChartLib || !doc) return;

        ChartLib.defaults.color = '#a0aabf';
        const gold = '#ffcc4d', blue = '#3b476e', success = '#10b981', danger = '#ef4444', accent1 = '#8b5cf6', accent2 = '#f97316', cyan = '#38bdf8';
        const calc = _deps.getCrmDashboardCalc();
        const formatMoney = _deps.formatCurrency;

        // 0. GRÁFICA PRIORITARIA 1: EVOLUCIÓN MENSUAL DE VENTAS Y MARGEN BRUTO
        const wonForMonthly = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
        const monthlyStats = (calc && typeof calc.calculateMonthlyEvolution === 'function')
            ? calc.calculateMonthlyEvolution(wonForMonthly, filterRes)
            : { months: [], totalVentas: 0, totalCostos: 0, totalMargen: 0, totalCountGanadas: 0 };

        const monthlyCanvasBox = doc.getElementById('monthly-canvas-container');
        const monthlyEmptyBox = doc.getElementById('monthly-evolution-empty');
        const monthlyCoverageBadge = doc.getElementById('dash-monthly-coverage-badge');
        const monthlySummary = doc.getElementById('dash-monthly-summary');

        if (_chartMonthly) { _chartMonthly.destroy(); _chartMonthly = null; }
        const monthlyCanvas = doc.getElementById('monthlyEvolutionChart');
        if (monthlyCanvas && typeof ChartLib.getChart === 'function') {
            const existingMonthly = ChartLib.getChart(monthlyCanvas);
            if (existingMonthly) existingMonthly.destroy();
        }

        const hasMonthlyData = monthlyStats.totalCountGanadas > 0;
        if (!hasMonthlyData) {
            if (monthlyCanvasBox) monthlyCanvasBox.style.display = 'none';
            if (monthlyEmptyBox) monthlyEmptyBox.style.display = 'flex';
            if (monthlyCoverageBadge) monthlyCoverageBadge.style.display = 'none';
            if (monthlySummary) monthlySummary.textContent = '';
        } else {
            if (monthlyEmptyBox) monthlyEmptyBox.style.display = 'none';
            if (monthlyCanvasBox) monthlyCanvasBox.style.display = 'block';

            const totalPrecioConCosto = monthlyStats.months.reduce((acc, m) => acc + (m.precioConCosto || 0), 0);
            const totalVentasAll = monthlyStats.totalVentas || 0;
            const globalCoveragePct = totalVentasAll > 0 ? parseFloat(((totalPrecioConCosto / totalVentasAll) * 100).toFixed(1)) : 100;
            const countSinCostoTotal = monthlyStats.months.reduce((acc, m) => acc + (m.countSinCosto || 0), 0);

            if (monthlyCoverageBadge) {
                if (countSinCostoTotal > 0 && globalCoveragePct < 100) {
                    monthlyCoverageBadge.style.display = 'inline-block';
                    monthlyCoverageBadge.textContent = `⚠️ Cobertura costos: ${globalCoveragePct}%`;
                    monthlyCoverageBadge.title = `${countSinCostoTotal} operaciones cerradas sin costo de venta registrado en el período`;
                } else {
                    monthlyCoverageBadge.style.display = 'none';
                }
            }

            if (monthlySummary) {
                monthlySummary.textContent = `Ventas: ${formatMoney(monthlyStats.totalVentas)} | Margen: ${formatMoney(monthlyStats.totalMargen)}`;
            }

            if (monthlyCanvas) {
                const labels = monthlyStats.months.map(m => m.label);
                const dataVentas = monthlyStats.months.map(m => m.ventas);
                const dataMargen = monthlyStats.months.map(m => m.margen);
                const dataMargenPct = monthlyStats.months.map(m => m.margenPct);

                _chartMonthly = new ChartLib(monthlyCanvas.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                type: 'bar',
                                label: 'Ventas Ganadas ($)',
                                data: dataVentas,
                                backgroundColor: '#ffcc4d',
                                borderRadius: 3,
                                yAxisID: 'y'
                            },
                            {
                                type: 'bar',
                                label: 'Margen Bruto ($)',
                                data: dataMargen,
                                backgroundColor: '#10b981',
                                borderRadius: 3,
                                yAxisID: 'y'
                            },
                            {
                                type: 'line',
                                label: '% Margen',
                                data: dataMargenPct,
                                borderColor: '#38bdf8',
                                backgroundColor: '#38bdf8',
                                borderWidth: 2,
                                pointRadius: 3,
                                yAxisID: 'yPct',
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                display: true,
                                ticks: { font: { size: 10 }, color: '#a0aabf' },
                                grid: { display: false }
                            },
                            y: {
                                beginAtZero: true,
                                ticks: {
                                    callback: v => formatMoney(v),
                                    font: { size: 10 },
                                    color: '#a0aabf'
                                },
                                title: { display: true, text: 'Importe ($)', font: { size: 10 }, color: '#a0aabf' },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            },
                            yPct: {
                                position: 'right',
                                min: 0,
                                max: 100,
                                grid: { display: false },
                                ticks: {
                                    callback: v => v + '%',
                                    font: { size: 10 },
                                    color: '#a0aabf'
                                },
                                title: { display: true, text: '% Margen', font: { size: 10 }, color: '#a0aabf' }
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { boxWidth: 10, font: { size: 10 }, padding: 10, color: '#a0aabf' }
                            },
                            tooltip: {
                                callbacks: {
                                    afterTitle: function (context) {
                                        const idx = context[0].dataIndex;
                                        const m = monthlyStats.months[idx];
                                        if (!m) return '';
                                        if (!m.hasData) return 'Sin operaciones en este mes';
                                        let sub = `${m.countGanadas} op. ganadas`;
                                        if (m.countSinCosto > 0) {
                                            sub += ` · Cobertura costos: ${m.coberturaPct}% (${m.countSinCosto} sin costo)`;
                                        }
                                        return sub;
                                    },
                                    label: function (ctx) {
                                        if (ctx.dataset.yAxisID === 'yPct') {
                                            return ctx.raw !== null ? `% Margen: ${ctx.raw}%` : '% Margen: Costo no disponible';
                                        }
                                        return `${ctx.dataset.label}: ${formatMoney(ctx.raw || 0)}`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }

        // STOCK VIVO PARA EMBUDO Y PIPELINE
        const prospectsList = _deps.getProspects();
        const active = filterRes && filterRes.stockActivo
            ? filterRes.stockActivo
            : (prospectsList ? prospectsList.filter(p => p && p.estado === 'activo' && p.eliminado !== true) : []);

        // 1. EMBUDO DE VENTAS ACTIVAS (Stock vivo por etapa en HTML/CSS)
        const funnelContainer = doc.getElementById('css-funnel-container');
        if (funnelContainer) {
            if (active.length === 0) {
                funnelContainer.innerHTML = `
                    <div class="dash-empty-state-box">
                        <div style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.85;">📦</div>
                        <div style="font-weight: 600; color: white; font-size: 0.95rem;">Pipeline sin Oportunidades Activas</div>
                        <div style="font-size: 0.78rem; color: var(--text-secondary); max-width: 260px;">No hay oportunidades abiertas en el inventario actual.</div>
                    </div>
                `;
            } else {
                const stageDist = (calc && typeof calc.calculatePipelineStageDistribution === 'function')
                    ? calc.calculatePipelineStageDistribution(active, STAGES, KPI_LIMITS)
                    : { stages: [], totalNominal: 0, totalPonderado: 0, totalOps: 0 };

                const maxCount = Math.max(...stageDist.stages.map(s => s.count), 1);
                const colors = [blue, gold, success, '#f59e0b', danger];

                let funnelHTML = '';
                stageDist.stages.forEach((st, i) => {
                    const currentWidth = st.count > 0 ? Math.max((st.count / maxCount) * 100, 24) : 18;
                    const c = colors[i % colors.length];
                    const nominalStr = st.count > 0 ? formatMoney(st.montoNominal) : '-';
                    const ponderadoStr = st.count > 0 && st.montoPonderado > 0 ? `Pond: ${formatMoney(st.montoPonderado)}` : '';
                    const sinProbNotice = st.countSinProb > 0 ? ` <span title="${st.countSinProb} oportunidad(es) sin probabilidad asignada" style="color:var(--brand-gold); font-size:0.75rem;">(⚠️${st.countSinProb})</span>` : '';

                    funnelHTML += `
                        <div class="dash-funnel-row">
                            <div class="dash-funnel-label">
                                ${st.stage}<span class="dash-funnel-label-sub">${st.count} Op.${sinProbNotice}</span>
                            </div>
                            <div class="dash-funnel-bar-container">
                                <div class="dash-funnel-bar" style="width: ${currentWidth}%; background-color: ${c};">
                                    <span class="dash-funnel-val">${nominalStr}</span>
                                    ${ponderadoStr ? `<span class="dash-funnel-subval">${ponderadoStr}</span>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });

                funnelHTML += `
                    <div class="dash-funnel-note">
                        * Stock actual por etapa. No representa conversión secuencial de cohortes. Tasa de Cierre Real: Ganadas / (Ganadas + Perdidas).
                    </div>
                `;

                funnelContainer.innerHTML = `<div class="dash-funnel-wrapper">${funnelHTML}</div>`;
            }
        }

        // 2. EFECTIVIDAD Y VOLUMEN POR CANAL (Volumen apilado + Tasa de Cierre)
        const channelUniverse = (filterRes && filterRes.isHistorical)
            ? prospectsList
            : [...(filterRes.flujoGanadas || []), ...(filterRes.flujoPerdidas || []), ...(filterRes.stockActivo || [])];

        const channelStats = (calc && typeof calc.calculateChannelConversion === 'function')
            ? calc.calculateChannelConversion(channelUniverse)
            : { summary: [], channels: [] };

        const repNames = channelStats.channels;
        const dataGanado = [];
        const dataActivo = [];
        const dataPerdido = [];
        const dataWinRate = [];

        repNames.forEach(name => {
            const item = channelStats.summary.find(s => s.channel === name);
            if (item) {
                dataGanado.push(item.ganado);
                dataActivo.push(item.activo);
                dataPerdido.push(item.perdido);
                dataWinRate.push(item.winRate !== null ? parseFloat(item.winRate.toFixed(1)) : null);
            }
        });

        if (_chartOrigin) { _chartOrigin.destroy(); _chartOrigin = null; }
        const convCanvas = doc.getElementById('conversionChart');
        if (convCanvas) {
            if (typeof ChartLib.getChart === 'function') {
                const existing = ChartLib.getChart(convCanvas);
                if (existing) existing.destroy();
            }
            const isMobileScreen = typeof window !== 'undefined' && window.innerWidth <= 640;
            const chartLabels = repNames.map(name => (name ? String(name).trim() : ''));

            _chartOrigin = new ChartLib(convCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: chartLabels,
                    datasets: [
                        { type: 'bar', label: 'Ganado', data: dataGanado, backgroundColor: success, stack: 'ops', borderRadius: 2 },
                        { type: 'bar', label: 'En Proceso', data: dataActivo, backgroundColor: gold, stack: 'ops', borderRadius: 2 },
                        { type: 'bar', label: 'Perdido', data: dataPerdido, backgroundColor: danger, stack: 'ops', borderRadius: 2 },
                        {
                            type: 'line',
                            label: 'Tasa Cierre (%)',
                            data: dataWinRate,
                            borderColor: cyan,
                            backgroundColor: cyan,
                            borderWidth: 2,
                            pointRadius: isMobileScreen ? 3 : 4,
                            pointHoverRadius: 5,
                            yAxisID: 'yRate',
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: {
                        padding: {
                            left: isMobileScreen ? 2 : 6,
                            right: isMobileScreen ? 2 : 6,
                            top: 6,
                            bottom: isMobileScreen ? 8 : 10
                        }
                    },
                    scales: {
                        x: {
                            display: true,
                            ticks: {
                                font: { size: isMobileScreen ? 8.5 : 9.5, weight: '500' },
                                color: '#cbd5e1',
                                maxRotation: isMobileScreen ? 45 : 35,
                                minRotation: isMobileScreen ? 40 : 30,
                                autoSkip: false,
                                padding: 4
                            },
                            grid: { display: false }
                        },
                        y: {
                            stacked: true,
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1,
                                font: { size: isMobileScreen ? 9 : 10 },
                                color: '#a0aabf',
                                padding: isMobileScreen ? 3 : 6
                            },
                            title: {
                                display: true,
                                text: isMobileScreen ? 'Ops' : 'Volumen Ops',
                                font: { size: isMobileScreen ? 9 : 10 },
                                color: '#a0aabf'
                            },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        yRate: {
                            position: 'right',
                            min: 0,
                            max: 100,
                            grid: { display: false },
                            ticks: {
                                callback: v => v + '%',
                                font: { size: isMobileScreen ? 9 : 10 },
                                color: '#a0aabf',
                                padding: isMobileScreen ? 3 : 6
                            },
                            title: {
                                display: true,
                                text: isMobileScreen ? '% Cierre' : 'Tasa de Cierre',
                                font: { size: isMobileScreen ? 9 : 10 },
                                color: '#a0aabf'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                boxWidth: isMobileScreen ? 8 : 10,
                                font: { size: isMobileScreen ? 8.5 : 9.5 },
                                padding: isMobileScreen ? 8 : 12,
                                color: '#a0aabf'
                            }
                        },
                        tooltip: {
                            callbacks: {
                                title: function (items) {
                                    if (!items || !items.length) return '';
                                    const idx = items[0].dataIndex;
                                    return repNames[idx] || (Array.isArray(items[0].label) ? items[0].label.join(' ') : items[0].label);
                                },
                                label: function (context) {
                                    if (context.dataset.yAxisID === 'yRate') {
                                        return context.raw !== null ? `Tasa de Cierre: ${context.raw}% (Ganadas/Concluidas)` : 'Tasa: Sin cierres concluidos';
                                    }
                                    return `${context.dataset.label}: ${context.raw} Ops`;
                                }
                            }
                        }
                    }
                }
            });
        }

        // 3. RENDIMIENTO COMPARATIVO POR VENDEDOR Y GESTOR (Horizontal bar chart)
        const wonSellers = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
        const lostSellers = filterRes && filterRes.flujoPerdidas ? filterRes.flujoPerdidas : [];
        const activeSellersList = filterRes && filterRes.stockActivo ? filterRes.stockActivo : [];
        const usersList = _deps.getUsers();
        const currentSellerFilterMode = _deps.getSellerFilterMode();

        _deps.updateSellerFilterButtons();

        const sellerStats = (calc && typeof calc.calculateSellerPerformance === 'function')
            ? calc.calculateSellerPerformance(wonSellers, lostSellers, activeSellersList, usersList, { filterMode: currentSellerFilterMode })
            : { sellers: [], totalSellers: 0, excludedInactiveMetrics: {} };

        const sellerCanvasBox = doc.getElementById('seller-canvas-container');
        const sellerEmptyBox = doc.getElementById('seller-empty-container');
        const sellerEmptyText = doc.getElementById('seller-empty-text');
        const sellerCoverageBadge = doc.getElementById('dash-seller-coverage-badge');
        const sellerInactiveNotice = doc.getElementById('dash-seller-inactive-notice');
        const sellerInactiveNoticeText = doc.getElementById('dash-seller-inactive-notice-text');

        // Manejo de la nota contextual sobre comerciales inactivos
        if (sellerInactiveNotice && sellerInactiveNoticeText) {
            const excl = sellerStats.excludedInactiveMetrics;
            if (currentSellerFilterMode === 'active_only' && excl && (excl.ventasGanadas > 0 || excl.pipelineNominal > 0 || excl.countPerdidas > 0)) {
                const parts = [];
                if (excl.ventasGanadas > 0) {
                    parts.push(`${formatMoney(excl.ventasGanadas)} en ventas ganadas`);
                }
                if (excl.pipelineNominal > 0) {
                    parts.push(`${formatMoney(excl.pipelineNominal)} en cartera activa`);
                }
                let noticeMsg = 'El consolidado corporativo incluye ';
                if (parts.length > 0) {
                    noticeMsg += parts.join(' y ') + ' de colaboradores inactivos no listados en esta vista. Seleccione «Histórico Completo» para ver el desglose individual.';
                } else {
                    noticeMsg += 'operaciones de colaboradores inactivos que no figuran en esta vista. Seleccione «Histórico Completo» para ver el desglose individual.';
                }
                sellerInactiveNoticeText.textContent = noticeMsg;
                sellerInactiveNotice.style.display = 'flex';
            } else {
                sellerInactiveNotice.style.display = 'none';
                sellerInactiveNoticeText.textContent = '';
            }
        }

        if (_chartSeller) { _chartSeller.destroy(); _chartSeller = null; }
        const sellerCanvas = doc.getElementById('sellerChart');
        if (sellerCanvas && typeof ChartLib.getChart === 'function') {
            const existingSeller = ChartLib.getChart(sellerCanvas);
            if (existingSeller) existingSeller.destroy();
        }

        const sellers = sellerStats.sellers || [];
        const hasSellerActivity = sellers.some(s => s.ventasGanadas > 0 || s.countPerdidas > 0 || s.pipelineNominal > 0 || s.countActivas > 0);

        if (!hasSellerActivity || sellers.length === 0) {
            if (sellerCanvasBox) sellerCanvasBox.style.display = 'none';
            if (sellerEmptyBox) sellerEmptyBox.style.display = 'flex';
            if (sellerCoverageBadge) sellerCoverageBadge.style.display = 'none';
            if (sellerEmptyText) {
                if (currentSellerFilterMode === 'active_only' && sellerStats.excludedInactiveMetrics && sellerStats.excludedInactiveMetrics.countSellers > 0) {
                    sellerEmptyText.textContent = 'No se registran cierres ni carteras de colaboradores activos en el período seleccionado. Cambie a «Histórico Completo» para consultar registros de excolaboradores.';
                } else {
                    sellerEmptyText.textContent = 'No se registran cierres ni carteras comerciales asignadas a vendedores en el período seleccionado.';
                }
            }
        } else {
            if (sellerEmptyBox) sellerEmptyBox.style.display = 'none';
            if (sellerCanvasBox) sellerCanvasBox.style.display = 'block';

            const sellersWithIncompleteCosts = sellers.filter(s => s.ventasGanadas > 0 && s.coberturaPct < 100);
            if (sellerCoverageBadge) {
                if (sellersWithIncompleteCosts.length > 0) {
                    sellerCoverageBadge.style.display = 'inline-block';
                    sellerCoverageBadge.textContent = '⚠️ Costos parciales en vendedores';
                    sellerCoverageBadge.title = 'Algunos vendedores tienen ventas ganadas sin costo de venta registrado';
                } else {
                    sellerCoverageBadge.style.display = 'none';
                }
            }

            if (sellerCanvas) {
                const requiredHeight = Math.max(260, sellers.length * 48);
                sellerCanvasBox.style.height = `${requiredHeight}px`;

                _chartSeller = new ChartLib(sellerCanvas.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels: sellers.map(s => s.nombreConRol || (s.role === 'gestor' ? `${s.nombre} (Gestor)` : `${s.nombre} (Vendedor)`)),
                        datasets: [
                            {
                                label: 'Ventas Ganadas ($)',
                                data: sellers.map(s => s.ventasGanadas),
                                backgroundColor: '#ffcc4d',
                                borderRadius: 3
                            },
                            {
                                label: 'Margen Bruto ($)',
                                data: sellers.map(s => s.margen),
                                backgroundColor: '#10b981',
                                borderRadius: 3
                            },
                            {
                                label: 'Cartera Activa ($)',
                                data: sellers.map(s => s.pipelineNominal),
                                backgroundColor: '#38bdf8',
                                borderRadius: 3
                            }
                        ]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                beginAtZero: true,
                                ticks: {
                                    callback: v => formatMoney(v),
                                    font: { size: 10 },
                                    color: '#a0aabf'
                                },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            },
                            y: {
                                ticks: {
                                    font: { size: 11, weight: '500' },
                                    color: '#ffffff'
                                },
                                grid: { display: false }
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { boxWidth: 10, font: { size: 10 }, padding: 10, color: '#a0aabf' }
                            },
                            tooltip: {
                                callbacks: {
                                    title: function (items) {
                                        if (!items || !items.length) return '';
                                        const idx = items[0].dataIndex;
                                        const s = sellers[idx];
                                        if (!s) return '';
                                        const roleBadge = s.isInactive
                                            ? (s.role === 'gestor' ? 'Gestor de Ventas - Inactivo' : (s.role === 'vendedor' ? 'Vendedor - Inactivo' : 'Sin Asignar'))
                                            : (s.role === 'gestor' ? 'Gestor de Ventas' : (s.role === 'vendedor' ? 'Vendedor' : 'Sin Asignar'));
                                        return `${s.nombre} [${roleBadge}]`;
                                    },
                                    afterTitle: function (context) {
                                        const idx = context[0].dataIndex;
                                        const s = sellers[idx];
                                        if (!s) return '';
                                        return `Tasa Cierre: ${s.winRateFormatted} | Cobertura Costo: ${s.coberturaPct}%`;
                                    },
                                    label: function (ctx) {
                                        const idx = ctx.dataIndex;
                                        const s = sellers[idx];
                                        const dsLabel = ctx.dataset.label;
                                        const val = formatMoney(ctx.raw || 0);
                                        if (dsLabel.includes('Ventas')) {
                                            return `${dsLabel}: ${val} (${s.countGanadas} ganadas)`;
                                        }
                                        if (dsLabel.includes('Margen')) {
                                            const mPct = s.margenPct !== null ? `${s.margenPct}%` : 'Incompleto';
                                            return `${dsLabel}: ${val} (Margen: ${mPct})`;
                                        }
                                        if (dsLabel.includes('Cartera')) {
                                            const pond = formatMoney(s.pipelinePonderado || 0);
                                            return `${dsLabel}: ${val} (Ponderado: ${pond}, ${s.countActivas} activas)`;
                                        }
                                        return `${dsLabel}: ${val}`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }

        // 4. MOTIVOS DE PÉRDIDA (Flujo de pérdidas del período)
        const lostOps = filterRes && filterRes.flujoPerdidas ? filterRes.flujoPerdidas : [];
        const hasLostData = Array.isArray(lostOps) && lostOps.length > 0;
        const lossCanvasBox = doc.getElementById('loss-canvas-container');
        const lossEmptyBox = doc.getElementById('loss-empty-container');

        if (_chartLoss) { _chartLoss.destroy(); _chartLoss = null; }
        const lossCanvas = doc.getElementById('lossChart');
        if (lossCanvas && typeof ChartLib.getChart === 'function') {
            const existingLoss = ChartLib.getChart(lossCanvas);
            if (existingLoss) existingLoss.destroy();
        }

        if (!hasLostData) {
            if (lossCanvasBox) lossCanvasBox.style.display = 'none';
            if (lossEmptyBox) lossEmptyBox.style.display = 'flex';
        } else {
            if (lossEmptyBox) lossEmptyBox.style.display = 'none';
            if (lossCanvasBox) lossCanvasBox.style.display = 'block';
            if (lossCanvas) {
                _chartLoss = new ChartLib(lossCanvas.getContext('2d'), {
                    type: 'doughnut',
                    data: {
                        labels: MOTIVOS_PERDIDA,
                        datasets: [{
                            data: MOTIVOS_PERDIDA.map(m => lostOps.filter(p => p.motivo_perdida === m).length),
                            backgroundColor: [danger, '#f59e0b', accent2, accent1, '#6b7280'],
                            borderWidth: 0
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { boxWidth: 10, font: { size: 10 }, padding: 8, color: '#a0aabf' }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function (ctx) {
                                        const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                        const pct = total > 0 ? Math.round((ctx.raw / total) * 100) : 0;
                                        return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
                                    }
                                }
                            }
                        },
                        cutout: '55%'
                    }
                });
            }
        }

        // 5. GRÁFICOS DE COMPOSICIÓN (Ventas y Pipeline)
        const won = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
        const sumSubtotal = (arr) => arr.reduce((acc, p) => acc + (calc && typeof calc.getProjectSubtotal === 'function' ? calc.getProjectSubtotal(p) : (Number(p.precio_cotizado) || 0)), 0);

        const compositionOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 10 }, padding: 6, color: '#a0aabf' }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => ' ' + formatMoney(ctx.raw)
                    }
                }
            },
            cutout: '58%'
        };

        // A. CIERRES - PRODUCTO
        const prodW = [sumSubtotal(won.filter(p => p.tipo_producto === 'Chute')), sumSubtotal(won.filter(p => p.tipo_producto === 'Ducto'))];
        const prodWColors = [gold, blue];
        const prodWNo = sumSubtotal(won.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
        if (prodWNo > 0) { prodW.push(prodWNo); prodWColors.push('#6b7280'); }
        if (_chartProduct) { _chartProduct.destroy(); _chartProduct = null; }
        const prodCanvas = doc.getElementById('productChart');
        if (prodCanvas) {
            if (typeof ChartLib.getChart === 'function') {
                const existing = ChartLib.getChart(prodCanvas);
                if (existing) existing.destroy();
            }
            _chartProduct = new ChartLib(prodCanvas.getContext('2d'), {
                type: 'doughnut',
                data: { labels: prodWNo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodW, backgroundColor: prodWColors, borderWidth: 0 }] },
                options: compositionOptions
            });
        }

        // B. CIERRES - PROYECTO
        const projW = [sumSubtotal(won.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumSubtotal(won.filter(p => p.tipo_proyecto === 'Fabricación'))];
        const projWColors = [success, '#a0aabf'];
        const projWNo = sumSubtotal(won.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
        if (projWNo > 0) { projW.push(projWNo); projWColors.push('#6b7280'); }
        if (_chartProject) { _chartProject.destroy(); _chartProject = null; }
        const projCanvas = doc.getElementById('projectChart');
        if (projCanvas) {
            if (typeof ChartLib.getChart === 'function') {
                const existing = ChartLib.getChart(projCanvas);
                if (existing) existing.destroy();
            }
            _chartProject = new ChartLib(projCanvas.getContext('2d'), {
                type: 'doughnut',
                data: { labels: projWNo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projW, backgroundColor: projWColors, borderWidth: 0 }] },
                options: compositionOptions
            });
        }

        // C. PIPELINE - PRODUCTO
        const prodA = [sumSubtotal(active.filter(p => p.tipo_producto === 'Chute')), sumSubtotal(active.filter(p => p.tipo_producto === 'Ducto'))];
        const prodANo = sumSubtotal(active.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
        const prodAColors = [gold, blue];
        if (prodANo > 0) { prodA.push(prodANo); prodAColors.push('#6b7280'); }
        if (_chartOppProduct) { _chartOppProduct.destroy(); _chartOppProduct = null; }
        const oppProdCanvas = doc.getElementById('oppProductChart');
        if (oppProdCanvas) {
            if (typeof ChartLib.getChart === 'function') {
                const existing = ChartLib.getChart(oppProdCanvas);
                if (existing) existing.destroy();
            }
            _chartOppProduct = new ChartLib(oppProdCanvas.getContext('2d'), {
                type: 'doughnut',
                data: { labels: prodANo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodA, backgroundColor: prodAColors, borderWidth: 0 }] },
                options: compositionOptions
            });
        }

        // D. PIPELINE - PROYECTO
        const projA = [sumSubtotal(active.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumSubtotal(active.filter(p => p.tipo_proyecto === 'Fabricación'))];
        const projANo = sumSubtotal(active.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
        const projAColors = [accent1, accent2];
        if (projANo > 0) { projA.push(projANo); projAColors.push('#6b7280'); }
        if (_chartOppProject) { _chartOppProject.destroy(); _chartOppProject = null; }
        const oppProjCanvas = doc.getElementById('oppProjectChart');
        if (oppProjCanvas) {
            if (typeof ChartLib.getChart === 'function') {
                const existing = ChartLib.getChart(oppProjCanvas);
                if (existing) existing.destroy();
            }
            _chartOppProject = new ChartLib(oppProjCanvas.getContext('2d'), {
                type: 'doughnut',
                data: { labels: projANo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projA, backgroundColor: projAColors, borderWidth: 0 }] },
                options: compositionOptions
            });
        }
    }

    // -------------------------------------------------------------------------
    // 5. API Pública de Dashboard Charts
    // -------------------------------------------------------------------------
    return {
        setDeps,
        renderCharts,
        destroyAllCharts,
        getChartMonthly: () => _chartMonthly,
        getChartOrigin: () => _chartOrigin,
        getChartSeller: () => _chartSeller,
        getChartLoss: () => _chartLoss,
        getChartProduct: () => _chartProduct,
        getChartProject: () => _chartProject,
        getChartOppProduct: () => _chartOppProduct,
        getChartOppProject: () => _chartOppProject
    };
});
