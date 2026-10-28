// crm_dashboard_calc.js
// Motor matemático y semántico puro para el Dashboard Comercial de Ductsal ERP.
// Contiene funciones independientes del DOM para cálculos de ventas ganadas, órdenes de cambio,
// costos, márgenes, pipeline ponderado, cuentas por cobrar, tiempos de transición histórica,
// antigüedad de inventario abierto (WIP), conversión por canal y filtrado temporal (flujo vs stock).

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmDashboardCalc = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
    const DEFAULT_KPI_LIMITS = {
        prospecto: 5,
        levantamiento: 7,
        cotizacion: 5,
        negociacion: 10,
        cierre: 5
    };
    const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    /**
     * Calcula el subtotal consolidado de una oportunidad incluyendo órdenes de cambio.
     * Respeta la lógica canónica de getProjectSubtotal existente en app_core.js.
     */
    function getProjectSubtotal(p) {
        if (!p || typeof p !== 'object') return 0;
        let base = Number(p.precio_cotizado);
        if (isNaN(base)) base = 0;
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o) return;
                const precio = Number(o.precio) || 0;
                if (o.tipo === 'aumento') {
                    base += Math.abs(precio);
                } else if (o.tipo === 'disminucion') {
                    base -= Math.abs(precio);
                } else {
                    base += precio;
                }
            });
        }
        return base;
    }

    /**
     * Calcula el costo consolidado de una oportunidad incluyendo órdenes de cambio.
     * Respeta la lógica canónica de getProjectCosto existente en app_core.js.
     */
    function getProjectCosto(p) {
        if (!p || typeof p !== 'object') return 0;
        let base = Number(p.costo_venta);
        if (isNaN(base)) base = 0;
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o) return;
                const costo = Number(o.costo) || 0;
                if (o.tipo === 'aumento') {
                    base += Math.abs(costo);
                } else if (o.tipo === 'disminucion') {
                    base -= Math.abs(costo);
                } else {
                    base += costo;
                }
            });
        }
        return base;
    }

    /**
     * Determina si una oportunidad tiene un costo de venta registrado explícitamente.
     * Evita asumir costo = 0 cuando el dato simplemente no ha sido ingresado.
     */
    function hasKnownCost(p) {
        if (!p || typeof p !== 'object') return false;
        if (p.costo_venta === null || typeof p.costo_venta === 'undefined' || p.costo_venta === '') {
            return false;
        }
        const n = Number(p.costo_venta);
        return !isNaN(n);
    }

    /**
     * Valida y parsea una fecha en formato string o timestamp.
     * Retorna objeto Date válido o null si es inválida/ausente.
     */
    function parseValidDate(dateInput) {
        if (!dateInput) return null;
        const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Extrae todos los años disponibles en el dataset para poblar el selector de períodos.
     * No restringe la selección exclusivamente al año corriente.
     */
    function getAvailableYears(prospectsList, currentYear = new Date().getFullYear()) {
        const years = new Set([currentYear]);
        (prospectsList || []).forEach(p => {
            if (!p) return;
            [p.fecha_creacion, p.fecha_cierre, p.fecha_perdida].forEach(f => {
                const d = parseValidDate(f);
                if (d) {
                    const y = d.getFullYear();
                    if (y >= 2020 && y <= currentYear + 1) {
                        years.add(y);
                    }
                }
            });
        });
        return Array.from(years).sort((a, b) => b - a);
    }

    /**
     * Separa el inventario entre Flujo del período y Stock vivo.
     * - Flujo: ventas ganadas (fecha_cierre), perdidas (fecha_perdida) y altas (fecha_creacion) del período.
     * - Stock: todas las oportunidades abiertas actualmente (independientes del filtro).
     */
    function filterProspects(allProspects, filter = 'all') {
        const list = Array.isArray(allProspects) ? allProspects.filter(p => p && p.eliminado !== true) : [];

        // STOCK VIVO: Todas las oportunidades con estado 'activo' abiertas hoy
        const stockActivo = list.filter(p => p.estado === 'activo');

        if (!filter || filter === 'all') {
            const flujoGanadas = list.filter(p => p.estado === 'ganado');
            const flujoPerdidas = list.filter(p => p.estado === 'perdido');
            const flujoAltas = list;

            return {
                filter: 'all',
                isHistorical: true,
                flujoGanadas,
                flujoPerdidas,
                flujoAltas,
                stockActivo,
                closedInPeriod: [...flujoGanadas, ...flujoPerdidas]
            };
        }

        let targetYear = null;
        let targetMonth = null;
        let isYearOnly = false;

        if (filter.startsWith('year_')) {
            targetYear = parseInt(filter.split('_')[1], 10);
            isYearOnly = true;
        } else if (filter.includes('-')) {
            const parts = filter.split('-').map(Number);
            targetYear = parts[0];
            targetMonth = parts[1];
        } else {
            return filterProspects(allProspects, 'all');
        }

        const inPeriod = (dateInput) => {
            const d = parseValidDate(dateInput);
            if (!d) return false;
            if (isYearOnly) {
                return d.getFullYear() === targetYear;
            }
            return d.getFullYear() === targetYear && d.getMonth() === targetMonth;
        };

        // Flujo Ganadas por fecha de cierre demostrada
        const flujoGanadas = list.filter(p => {
            if (p.estado !== 'ganado') return false;
            const cDate = p.fecha_cierre || (p.stage_timestamps && p.stage_timestamps.cierre);
            return inPeriod(cDate);
        });

        // Flujo Perdidas por fecha de pérdida demostrada
        const flujoPerdidas = list.filter(p => {
            if (p.estado !== 'perdido') return false;
            return inPeriod(p.fecha_perdida);
        });

        // Flujo Altas por fecha de creación
        const flujoAltas = list.filter(p => inPeriod(p.fecha_creacion));

        return {
            filter,
            isHistorical: false,
            targetYear,
            targetMonth,
            isYearOnly,
            flujoGanadas,
            flujoPerdidas,
            flujoAltas,
            stockActivo,
            closedInPeriod: [...flujoGanadas, ...flujoPerdidas]
        };
    }

    /**
     * Retorna el intervalo semiabierto [inicio, fin) correspondiente a un filtro temporal.
     * Permite verificar con precisión matemática los límites de mes, bisiesto, cruce de año y YTD.
     */
    function getPeriodInterval(filter) {
        if (!filter || filter === 'all') {
            return { isHistorical: true, isYearOnly: false, year: null, month: null, start: null, end: null };
        }
        if (filter.startsWith('year_')) {
            const y = parseInt(filter.split('_')[1], 10);
            return {
                isHistorical: false,
                isYearOnly: true,
                year: y,
                month: null,
                start: new Date(y, 0, 1, 0, 0, 0, 0),
                end: new Date(y + 1, 0, 1, 0, 0, 0, 0)
            };
        }
        if (filter.includes('-')) {
            const parts = filter.split('-').map(Number);
            const y = parts[0];
            const m = parts[1];
            return {
                isHistorical: false,
                isYearOnly: false,
                year: y,
                month: m,
                start: new Date(y, m, 1, 0, 0, 0, 0),
                end: new Date(y, m + 1, 1, 0, 0, 0, 0)
            };
        }
        return { isHistorical: true, isYearOnly: false, year: null, month: null, start: null, end: null };
    }

    /**
     * Calcula métricas de Ventas Ganadas y Margen.
     * Utiliza getProjectSubtotal y getProjectCosto.
     * Si faltan costos de venta, no asume margen del 100% y marca el cálculo como incompleto.
     */
    function calculateWonMetrics(wonList) {
        let totalPrecio = 0;
        let totalCosto = 0;
        let countTotal = 0;
        let countWithCost = 0;
        let countWithoutCost = 0;
        let precioWithCost = 0;

        (wonList || []).forEach(p => {
            if (!p || p.eliminado === true) return;
            const subtotal = getProjectSubtotal(p);
            totalPrecio += subtotal;
            countTotal++;

            if (hasKnownCost(p)) {
                const costo = getProjectCosto(p);
                totalCosto += costo;
                precioWithCost += subtotal;
                countWithCost++;
            } else {
                countWithoutCost++;
            }
        });

        // Margen Bruto Conocido: Suma de subtotales de ventas ganadas con costo válido - suma de sus costos válidos.
        // Las operaciones sin costo registrado quedan excluidas del margen comercial para no asumir costo cero.
        const margen = countWithCost > 0 ? (precioWithCost - totalCosto) : 0;
        let margenPct = null;
        const isCostComplete = (countTotal > 0 && countWithoutCost === 0);

        if (countWithCost > 0 && precioWithCost > 0) {
            margenPct = ((precioWithCost - totalCosto) / precioWithCost) * 100;
        } else if (countTotal === 0) {
            margenPct = 0;
        }

        const coberturaPct = totalPrecio > 0 ? parseFloat(((precioWithCost / totalPrecio) * 100).toFixed(1)) : 100;

        return {
            totalPrecio,
            precioWithCost,
            totalCosto,
            margen,
            margenPct,
            coberturaPct,
            countTotal,
            countWithCost,
            countWithoutCost,
            isCostComplete
        };
    }

    /**
     * Calcula métricas de Ventas Perdidas.
     */
    function calculateLostMetrics(lostList) {
        let totalPrecio = 0;
        let count = 0;

        (lostList || []).forEach(p => {
            if (!p || p.eliminado === true) return;
            totalPrecio += getProjectSubtotal(p);
            count++;
        });

        return { totalPrecio, count };
    }

    /**
     * Calcula el Pipeline Ponderado del inventario activo actual.
     * Evalúa todas las oportunidades abiertas sin excluirlas por antigüedad.
     * Informa oportunidades no ponderables (sin probabilidad o sin precio).
     */
    function calculateActivePipelineMetrics(activeList) {
        let totalPonderado = 0;
        let totalPonderadoConCosto = 0;
        let costoPonderado = 0;
        let totalNominal = 0;
        let montoSinPonderar = 0;
        let montoSinProbabilidad = 0;
        let montoSinPrecio = 0;
        let countTotal = 0;
        let countPonderadas = 0;
        let countSinPonderar = 0;
        let countSinProbabilidad = 0;
        let countSinPrecio = 0;

        // Métricas específicas para Cotizaciones para Presupuesto (referenciales / planificación)
        let montoPresupuestoReferencial = 0;
        let countPresupuestoReferencial = 0;
        let countEjecucion = 0;

        (activeList || []).forEach(p => {
            if (!p || p.estado !== 'activo' || p.eliminado === true) return;
            countTotal++;
            const subtotal = getProjectSubtotal(p);

            // Regla: Presupuestos referenciales no se contabilizan en el pronóstico comercial de ejecución
            const clasificacion = p.clasificacion || 'ejecucion';
            if (clasificacion === 'presupuesto') {
                countPresupuestoReferencial++;
                montoPresupuestoReferencial += subtotal;
                return;
            }

            countEjecucion++;
            totalNominal += subtotal;

            const hasProb = typeof p.probabilidad !== 'undefined' && p.probabilidad !== null && p.probabilidad !== '' && !isNaN(Number(p.probabilidad));
            const prob = hasProb ? Number(p.probabilidad) : null;
            const validProb = prob !== null && prob >= 0 && prob <= 100;
            const hasPrice = subtotal > 0;

            if (validProb && hasPrice) {
                const factor = prob / 100;
                totalPonderado += (subtotal * factor);
                if (hasKnownCost(p)) {
                    totalPonderadoConCosto += (subtotal * factor);
                    costoPonderado += (getProjectCosto(p) * factor);
                }
                countPonderadas++;
            } else {
                countSinPonderar++;
                montoSinPonderar += subtotal;
                if (!validProb) {
                    countSinProbabilidad++;
                    montoSinProbabilidad += subtotal;
                }
                if (!hasPrice) {
                    countSinPrecio++;
                    montoSinPrecio += subtotal;
                }
            }
        });

        const margenPonderado = countPonderadas > 0 && totalPonderadoConCosto > 0 ? (totalPonderadoConCosto - costoPonderado) : 0;
        const margenPonderadoPct = totalPonderadoConCosto > 0 ? (margenPonderado / totalPonderadoConCosto) * 100 : 0;

        return {
            totalPonderado,
            totalPonderadoConCosto,
            totalNominal,
            costoPonderado,
            margenPonderado,
            margenPonderadoPct,
            montoSinPonderar,
            montoSinProbabilidad,
            montoSinPrecio,
            countTotal,
            countPonderadas,
            countSinPonderar,
            countSinProbabilidad,
            countSinPrecio,
            montoPresupuestoReferencial,
            countPresupuestoReferencial,
            countEjecucion
        };
    }

    /**
     * Calcula métricas de Cuentas por Cobrar (CxC).
     * Sanitiza valores numéricos, previene la propagación de NaN y contabiliza registros inválidos.
     */
    function calculateCxCMetrics(prospectsList) {
        let totalFacturado = 0;
        let totalCobrado = 0;
        let facturasCount = 0;
        let pagosCount = 0;
        let invalidFacturasCount = 0;
        let invalidPagosCount = 0;

        (prospectsList || []).forEach(p => {
            if (!p || p.eliminado === true || !Array.isArray(p.facturas)) return;
            p.facturas.forEach(f => {
                if (!f) return;
                const monto = Number(f.monto);
                if (f.monto !== null && typeof f.monto !== 'undefined' && !isNaN(monto) && isFinite(monto) && monto > 0) {
                    totalFacturado += monto;
                    facturasCount++;
                } else if (f.monto !== 0) {
                    invalidFacturasCount++;
                }
                if (Array.isArray(f.pagos)) {
                    f.pagos.forEach(b => {
                        if (!b) return;
                        const pMonto = Number(b.monto);
                        if (b.monto !== null && typeof b.monto !== 'undefined' && !isNaN(pMonto) && isFinite(pMonto) && pMonto > 0) {
                            totalCobrado += pMonto;
                            pagosCount++;
                        } else if (b.monto !== 0) {
                            invalidPagosCount++;
                        }
                    });
                }
            });
        });

        const totalCxC = Math.max(0, totalFacturado - totalCobrado);
        const pctCobrado = totalFacturado > 0 ? Math.min(100, (totalCobrado / totalFacturado) * 100) : 0;
        const hasInvalidRecords = (invalidFacturasCount > 0 || invalidPagosCount > 0);

        return {
            totalFacturado,
            totalCobrado,
            totalCxC,
            pctCobrado,
            facturasCount,
            pagosCount,
            invalidFacturasCount,
            invalidPagosCount,
            hasInvalidRecords
        };
    }

    /**
     * Calcula los Tiempos Promedio en Etapa basándose EXCLUSIVAMENTE en transiciones completadas.
     * Excluye oportunidades activas (en curso) para no contaminar promedios con Date.now().
     * Excluye oportunidades perdidas sin fecha de pérdida fiable.
     */
    function calculateStageTransitionTimes(prospectsList, stages = STAGES, kpiLimits = DEFAULT_KPI_LIMITS) {
        const stageList = Array.isArray(stages) && stages.length > 0 ? stages : STAGES;
        const limits = kpiLimits || DEFAULT_KPI_LIMITS;
        const results = {};

        stageList.forEach((stage, idx) => {
            let totalDays = 0;
            let countCompleted = 0;
            let countExcludedActive = 0;
            let countExcludedNoDate = 0;
            let countExcludedIncomplete = 0;
            let countInvalidDates = 0;

            (prospectsList || []).forEach(p => {
                if (!p || p.eliminado === true) return;

                // NIVEL 1: Acumulados canónicos oficiales registrados por el workflow
                const tiempos = (p.tiempos_etapas_acumulados && typeof p.tiempos_etapas_acumulados === 'object') ? p.tiempos_etapas_acumulados : null;
                if (tiempos && typeof tiempos[stage] === 'number' && !isNaN(tiempos[stage])) {
                    const accDays = tiempos[stage];
                    if (accDays >= 0) {
                        const isCurrentlyActiveInThisStage = p.estado === 'activo' && p.etapa === stage;
                        const hasPriorTransitions = Array.isArray(p.stage_transitions) && p.stage_transitions.some(t => t && t.from === stage);
                        if (isCurrentlyActiveInThisStage && !hasPriorTransitions && accDays === 0) {
                            countExcludedActive++;
                            return;
                        }
                        totalDays += accDays;
                        countCompleted++;
                        return;
                    }
                }

                // NIVEL 2: Reconstrucción histórica a partir de stage_transitions
                if (Array.isArray(p.stage_transitions) && p.stage_transitions.length > 0) {
                    const completedTransitions = p.stage_transitions.filter(t => t && t.from === stage);
                    if (completedTransitions.length > 0) {
                        let stageSum = 0;
                        let validTransitionCount = 0;
                        completedTransitions.forEach(t => {
                            if (typeof t.duracion_dias === 'number' && !isNaN(t.duracion_dias)) {
                                stageSum += t.duracion_dias;
                                validTransitionCount++;
                            }
                        });
                        if (validTransitionCount > 0) {
                            totalDays += Math.round(stageSum * 2) / 2;
                            countCompleted++;
                            return;
                        }
                    }
                }

                // NIVEL 3: Registros legacy / históricos sin acumulados ni transiciones estructuradas
                const ts = (p.stage_timestamps && typeof p.stage_timestamps === 'object') ? p.stage_timestamps : {};
                const stageStartStr = ts[stage];

                // Si continúa activa en esta etapa: excluir del promedio completado
                if (p.estado === 'activo' && p.etapa === stage) {
                    countExcludedActive++;
                    return;
                }

                if (!stageStartStr) {
                    return;
                }

                const startDate = parseValidDate(stageStartStr);
                if (!startDate) {
                    countExcludedNoDate++;
                    return;
                }

                let endDate = null;

                // 1. Verificar si avanzó a una etapa posterior en el embudo
                for (let k = idx + 1; k < stageList.length; k++) {
                    const nxt = stageList[k];
                    if (ts[nxt]) {
                        const candidate = parseValidDate(ts[nxt]);
                        if (candidate) {
                            endDate = candidate;
                            break;
                        }
                    }
                }

                // 2. Si no avanzó a otra etapa pero fue ganada
                if (!endDate && p.estado === 'ganado') {
                    const cDate = parseValidDate(p.fecha_cierre);
                    if (cDate) {
                        endDate = cDate;
                    }
                }

                // 3. Si fue perdida con fecha demostrada
                if (!endDate && p.estado === 'perdido') {
                    const lDate = parseValidDate(p.fecha_perdida);
                    if (lDate) {
                        endDate = lDate;
                    } else {
                        countExcludedNoDate++;
                        return;
                    }
                }

                if (endDate) {
                    const diffMs = endDate.getTime() - startDate.getTime();
                    if (diffMs < 0) {
                        // Fecha final anterior a la inicial: cronológicamente inválida o retroceso previo
                        countInvalidDates++;
                        countExcludedIncomplete++;
                        return;
                    }
                    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    totalDays += diffDays;
                    countCompleted++;
                    return;
                }

                // Sin fecha de salida comprobable en registro histórico
                countExcludedIncomplete++;
            });

            const avgDays = countCompleted > 0 ? parseFloat((totalDays / countCompleted).toFixed(1)) : 0;
            const limit = Object.prototype.hasOwnProperty.call(limits, stage) ? limits[stage] : 5;
            const isOverLimit = countCompleted > 0 && limit !== null && limit !== undefined && avgDays > limit;

            results[stage] = {
                stage,
                avgDays,
                countCompleted,
                countExcludedActive,
                countExcludedNoDate,
                countExcludedIncomplete,
                countInvalidDates,
                historial_parcial: countExcludedIncomplete > 0,
                limit,
                isOverLimit,
                hasData: countCompleted > 0
            };
        });

        return results;
    }

    /**
     * Calcula la antigüedad y alertas de estancamiento de todo el inventario activo abierto.
     * Evalúa los días transcurridos desde el ingreso a la etapa vigente hasta hoy.
     */
    function calculateActiveWipTimes(activeList, kpiLimits = DEFAULT_KPI_LIMITS, now = new Date()) {
        const limits = kpiLimits || DEFAULT_KPI_LIMITS;
        const nowDate = parseValidDate(now) || new Date();
        const nowMs = nowDate.getTime();

        const items = [];

        (activeList || []).forEach(p => {
            if (!p || p.estado !== 'activo' || p.eliminado === true) return;
            const etapa = p.etapa || 'prospecto';
            const ts = (p.stage_timestamps && typeof p.stage_timestamps === 'object') ? p.stage_timestamps : {};
            const stageStart = ts[etapa] || p.fecha_creacion;
            let days = 0;

            if (stageStart) {
                const sDate = parseValidDate(stageStart);
                if (sDate) {
                    days = Math.max(0, Math.floor((nowMs - sDate.getTime()) / (1000 * 60 * 60 * 24)));
                }
            }

            const limit = Object.prototype.hasOwnProperty.call(limits, etapa) ? limits[etapa] : 5;
            const isOverLimit = limit !== null && limit !== undefined && days > limit;
            const isWarning = !isOverLimit && limit !== null && limit !== undefined && days >= Math.max(1, limit - 2);

            items.push({
                id: p.id,
                codigo: p.codigo || (p.id ? String(p.id).slice(-4) : '-'),
                clientId: p.clientId,
                proyecto: p.proyecto || 'Sin Nombre',
                vendedor: p.vendedor || '-',
                monto: getProjectSubtotal(p),
                etapa,
                days,
                limit,
                isOverLimit,
                isWarning,
                fecha_inicio_etapa: stageStart
            });
        });

        items.sort((a, b) => b.days - a.days);
        const overLimitItems = items.filter(x => x.isOverLimit);

        return {
            allItems: items,
            overLimitItems,
            totalActive: items.length,
            totalOverLimit: overLimitItems.length
        };
    }

    /**
     * Calcula la efectividad y volumen por canal comercial.
     * Separa el volumen de oportunidades por estado de la Tasa de Cierre (Ganadas / Concluidas).
     */
    function calculateChannelConversion(prospectsList) {
        const originStats = {};

        (prospectsList || []).forEach(p => {
            if (!p || p.eliminado === true) return;
            const channel = (p.origen && String(p.origen).trim()) || 'Sin Canal';
            if (!originStats[channel]) {
                originStats[channel] = {
                    channel,
                    ganado: 0,
                    activo: 0,
                    perdido: 0,
                    desconocido: 0,
                    total: 0,
                    montoGanado: 0,
                    montoPerdido: 0,
                    montoActivo: 0
                };
            }

            const st = originStats[channel];
            const subtotal = getProjectSubtotal(p);
            st.total++;

            if (p.estado === 'ganado') {
                st.ganado++;
                st.montoGanado += subtotal;
            } else if (p.estado === 'activo') {
                st.activo++;
                st.montoActivo += subtotal;
            } else if (p.estado === 'perdido') {
                st.perdido++;
                st.montoPerdido += subtotal;
            } else {
                st.desconocido++;
            }
        });

        const channels = Object.keys(originStats);
        const summary = channels.map(channel => {
            const s = originStats[channel];
            const concluidas = s.ganado + s.perdido;
            const winRate = concluidas > 0 ? (s.ganado / concluidas) * 100 : null;

            return {
                ...s,
                concluidas,
                winRate,
                winRateFormatted: winRate !== null ? winRate.toFixed(1) + '%' : 'N/D'
            };
        });

        return {
            statsByChannel: originStats,
            channels,
            summary
        };
    }

    /**
     * Calcula la evolución mensual de ventas cerradas y margen bruto.
     * Reconcilia exactamente con calculateWonMetrics.
     * Retorna arreglo cronológico de meses con ventas, costos, margen y cobertura.
     */
    function calculateMonthlyEvolution(wonList, filterRes = null) {
        const MESES_NOMBRES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const list = Array.isArray(wonList) ? wonList.filter(p => p && p.estado === 'ganado' && p.eliminado !== true) : [];

        let targetYear = null;
        let isHistorical = false;

        if (filterRes) {
            targetYear = filterRes.targetYear;
            isHistorical = filterRes.isHistorical || filterRes.filter === 'all';
        }

        const monthKeys = [];
        if (targetYear && !isHistorical) {
            for (let m = 0; m < 12; m++) {
                const mm = String(m + 1).padStart(2, '0');
                monthKeys.push(`${targetYear}-${mm}`);
            }
        } else {
            let minYear = new Date().getFullYear();
            let maxYear = minYear;

            list.forEach(p => {
                const d = parseValidDate(p.fecha_cierre || (p.stage_timestamps && p.stage_timestamps.cierre));
                if (d) {
                    const y = d.getFullYear();
                    if (y < minYear) minYear = y;
                    if (y > maxYear) maxYear = y;
                }
            });

            for (let y = minYear; y <= maxYear; y++) {
                for (let m = 0; m < 12; m++) {
                    const mm = String(m + 1).padStart(2, '0');
                    monthKeys.push(`${y}-${mm}`);
                }
            }
        }

        const monthMap = {};
        monthKeys.forEach(k => {
            const [yStr, mStr] = k.split('-');
            const mIdx = parseInt(mStr, 10) - 1;
            const y = parseInt(yStr, 10);
            const label = isHistorical ? `${MESES_NOMBRES[mIdx]} ${String(y).slice(-2)}` : MESES_NOMBRES[mIdx];

            monthMap[k] = {
                key: k,
                year: y,
                monthIndex: mIdx,
                label,
                ventas: 0,
                costos: 0,
                precioConCosto: 0,
                margen: 0,
                margenPct: null,
                coberturaPct: 100,
                countGanadas: 0,
                countConCosto: 0,
                countSinCosto: 0,
                hasData: false
            };
        });

        list.forEach(p => {
            const d = parseValidDate(p.fecha_cierre || (p.stage_timestamps && p.stage_timestamps.cierre));
            if (!d) return;

            const y = d.getFullYear();
            const m = d.getMonth();
            const k = `${y}-${String(m + 1).padStart(2, '0')}`;

            if (!monthMap[k]) {
                const label = isHistorical ? `${MESES_NOMBRES[m]} ${String(y).slice(-2)}` : MESES_NOMBRES[m];
                monthMap[k] = {
                    key: k,
                    year: y,
                    monthIndex: m,
                    label,
                    ventas: 0,
                    costos: 0,
                    precioConCosto: 0,
                    margen: 0,
                    margenPct: null,
                    coberturaPct: 100,
                    countGanadas: 0,
                    countConCosto: 0,
                    countSinCosto: 0,
                    hasData: false
                };
                monthKeys.push(k);
            }

            const st = monthMap[k];
            const subtotal = getProjectSubtotal(p);
            st.ventas += subtotal;
            st.countGanadas++;
            st.hasData = true;

            if (hasKnownCost(p)) {
                const c = getProjectCosto(p);
                st.costos += c;
                st.precioConCosto += subtotal;
                st.countConCosto++;
            } else {
                st.countSinCosto++;
            }
        });

        const sortedKeys = Object.keys(monthMap).sort();
        const series = sortedKeys.map(k => {
            const item = monthMap[k];
            // Margen bruto conocido del mes sobre proyectos con costo registrado
            item.margen = item.countConCosto > 0 ? (item.precioConCosto - item.costos) : 0;

            if (item.precioConCosto > 0 && item.countConCosto > 0) {
                item.margenPct = parseFloat((((item.precioConCosto - item.costos) / item.precioConCosto) * 100).toFixed(1));
            } else if (item.countGanadas === 0) {
                item.margenPct = 0;
            } else {
                item.margenPct = null;
            }

            if (item.ventas > 0) {
                item.coberturaPct = parseFloat(((item.precioConCosto / item.ventas) * 100).toFixed(1));
            } else {
                item.coberturaPct = 100;
            }

            return item;
        });

        const totalVentas = series.reduce((acc, m) => acc + m.ventas, 0);
        const totalCostos = series.reduce((acc, m) => acc + m.costos, 0);
        const totalPrecioConCosto = series.reduce((acc, m) => acc + m.precioConCosto, 0);
        const totalMargen = series.reduce((acc, m) => acc + m.margen, 0);
        const totalCountGanadas = series.reduce((acc, m) => acc + m.countGanadas, 0);

        return {
            months: series,
            totalVentas,
            totalCostos,
            totalPrecioConCosto,
            totalMargen,
            totalCountGanadas
        };
    }

    /**
     * Calcula el rendimiento integral por vendedor en el período y en el stock vivo.
     * Separa resultados del período de la cartera abierta hoy.
     * No asume 100% de margen e informa la cobertura de costos por vendedor.
     */
    /**
     * Calcula métricas comparativas de rendimiento comercial por Vendedor y Gestor de Ventas.
     * Regla de Negocio: Los gestores nunca administran ventas de vendedores. Las carteras son independientes.
     * Cada oportunidad pertenece exclusivamente al vendedor o gestor asignado según las asignaciones reales del CRM.
     * Ningún gestor recibe operaciones asignadas a un vendedor, y ningún vendedor recibe operaciones de un gestor.
     * Los resultados individuales se consolidan sin duplicados conciliando con el total de la empresa.
     * No asume 100% de margen e informa la cobertura de costos por vendedor/gestor.
     *
     * Opciones de Filtrado (options):
     * - filterMode: 'active_only' (predeterminado) | 'all'
     *   - 'active_only': Incluye exclusivamente comerciales cuyo estado actual sea activo (activo === true).
     *   - 'all' (Histórico completo): Incluye comerciales activos e inactivos con actividad relevante.
     */
    function calculateSellerPerformance(wonList, lostList, activeList, userDirectory = [], options = {}) {
        let filterMode = 'active_only';
        if (typeof options === 'string') {
            filterMode = options === 'all' ? 'all' : 'active_only';
        } else if (options && typeof options === 'object') {
            if (options.filterMode === 'all' || options.includeInactive === true) {
                filterMode = 'all';
            } else {
                filterMode = 'active_only';
            }
        }

        const usersById = {};
        const usersByEmail = {};
        const usersByName = {};
        const sellersMap = {};

        // 1. Indexar directorio de usuarios (activos e inactivos)
        // Permite recuperar el nombre y rol canónico de todos los usuarios comerciales, incluso inactivos.
        (userDirectory || []).forEach(u => {
            if (!u) return;
            const uId = String(u.id);
            const role = String(u.role || '').toLowerCase().trim();
            const email = String(u.email || '').toLowerCase().trim();
            const nombre = String(u.nombre || '').trim();
            const normName = nombre.toLowerCase();
            const isActivo = u.activo !== false;

            const userObj = {
                id: uId,
                nombre: nombre || (role === 'gestor' ? `Gestor ${uId}` : `Usuario ${uId}`),
                email: email,
                role: role,
                activo: isActivo
            };

            usersById[uId] = userObj;
            if (email) usersByEmail[email] = userObj;
            if (normName) usersByName[normName] = userObj;

            // Pre-registrar en sellersMap perfiles comerciales (vendedor o gestor)
            if (role === 'vendedor' || role === 'gestor') {
                const roleLabel = role === 'gestor' ? 'Gestor' : 'Vendedor';
                const nombreConRol = isActivo
                    ? `${userObj.nombre} (${roleLabel})`
                    : `${userObj.nombre} (${roleLabel} - Inactivo)`;

                sellersMap[uId] = {
                    sellerId: uId,
                    nombre: userObj.nombre,
                    nombreConRol: nombreConRol,
                    role: role,
                    roleLabel: roleLabel,
                    isInactive: !isActivo,
                    ventasGanadas: 0,
                    costoGanadas: 0,
                    precioConCosto: 0,
                    margen: 0,
                    margenPct: null,
                    coberturaPct: 100,
                    countGanadas: 0,
                    countConCosto: 0,
                    countSinCosto: 0,
                    countPerdidas: 0,
                    montoPerdidas: 0,
                    pipelineNominal: 0,
                    pipelinePonderado: 0,
                    countActivas: 0,
                    countEstancadas: 0
                };
            }
        });

        function ensureSellerEntry(id, nombre, role, isInactive = false) {
            const key = String(id);
            if (!sellersMap[key]) {
                const baseRole = role || 'vendedor';
                const roleLabel = baseRole === 'gestor' ? 'Gestor' : (baseRole === 'vendedor' ? 'Vendedor' : 'Sin Asignar');
                const displayName = nombre || (baseRole === 'gestor' ? `Gestor ${key}` : (baseRole === 'vendedor' ? `Vendedor ${key}` : 'Sin Asignar'));

                let nombreConRol;
                if (baseRole === 'sin_asignar') {
                    nombreConRol = displayName;
                } else if (isInactive) {
                    nombreConRol = `${displayName} (${roleLabel} - Inactivo)`;
                } else {
                    nombreConRol = `${displayName} (${roleLabel})`;
                }

                sellersMap[key] = {
                    sellerId: key,
                    nombre: displayName,
                    nombreConRol: nombreConRol,
                    role: baseRole,
                    roleLabel: roleLabel,
                    isInactive: !!isInactive,
                    ventasGanadas: 0,
                    costoGanadas: 0,
                    precioConCosto: 0,
                    margen: 0,
                    margenPct: null,
                    coberturaPct: 100,
                    countGanadas: 0,
                    countConCosto: 0,
                    countSinCosto: 0,
                    countPerdidas: 0,
                    montoPerdidas: 0,
                    pipelineNominal: 0,
                    pipelinePonderado: 0,
                    countActivas: 0,
                    countEstancadas: 0
                };
            }
            return sellersMap[key];
        }

        /**
         * Resuelve de forma determinista la persona responsable de una oportunidad.
         * Prioridad:
         * 1) vendedorId / gestorId explícito.
         * 2) Nombre asignado (vendedor / vendedorName / gestor).
         * 3) Creador (createdBy) solo si es vendedor o gestor y no hay vendedorId asignado.
         * En caso de perfiles ambiguos, administrativos o no comerciales, no se infiere y va a 'Sin Asignar'.
         */
        function resolveSeller(p) {
            if (!p || typeof p !== 'object') return ensureSellerEntry('sin_asignar', 'Sin Asignar', 'sin_asignar', false);

            // 1. Asignación explícita por ID (vendedorId o gestorId)
            let explicitId = null;
            if (p.vendedorId && String(p.vendedorId).trim() !== '' && String(p.vendedorId) !== 'sistema' && String(p.vendedorId) !== 'Sin Asignar') {
                explicitId = String(p.vendedorId).trim();
            } else if (p.gestorId && String(p.gestorId).trim() !== '' && String(p.gestorId) !== 'sistema' && String(p.gestorId) !== 'Sin Asignar') {
                explicitId = String(p.gestorId).trim();
            }

            if (explicitId) {
                if (usersById[explicitId]) {
                    const u = usersById[explicitId];
                    if (u.role === 'vendedor' || u.role === 'gestor') {
                        return ensureSellerEntry(u.id, u.nombre, u.role, !u.activo);
                    }
                    if (p.vendedorRole === 'vendedor' || p.vendedorRole === 'gestor') {
                        return ensureSellerEntry(explicitId, p.vendedorName || u.nombre, p.vendedorRole, !u.activo);
                    }
                    // Usuario en usersById pero es manager/admin y no tiene rol comercial: Sin Asignar
                    return ensureSellerEntry('sin_asignar', 'Sin Asignar', 'sin_asignar', false);
                }

                if (usersByEmail[explicitId.toLowerCase()]) {
                    const u = usersByEmail[explicitId.toLowerCase()];
                    if (u.role === 'vendedor' || u.role === 'gestor') {
                        return ensureSellerEntry(u.id, u.nombre, u.role, !u.activo);
                    }
                }

                // ID no está en directorio local de usuarios: usar rol y nombre explícitos de la oportunidad
                const role = (p.vendedorRole || p.gestorRole || (String(explicitId).toLowerCase().includes('ges') ? 'gestor' : 'vendedor')).toLowerCase();
                const name = p.vendedorName || p.vendedor || (role === 'gestor' ? `Gestor ${explicitId}` : `Vendedor ${explicitId}`);
                return ensureSellerEntry(explicitId, name, role === 'gestor' ? 'gestor' : 'vendedor', false);
            }

            // 2. Asignación por nombre (vendedor / vendedorName / gestor)
            const nameCandidate = p.vendedorName || p.vendedor || p.gestor;
            if (nameCandidate && typeof nameCandidate === 'string' && nameCandidate.trim() !== '' && nameCandidate !== '-' && nameCandidate !== 'Sistema' && nameCandidate !== 'Sin Asignar') {
                const normName = nameCandidate.trim().toLowerCase();
                if (usersByName[normName]) {
                    const u = usersByName[normName];
                    if (u.role === 'vendedor' || u.role === 'gestor') {
                        return ensureSellerEntry(u.id, u.nombre, u.role, !u.activo);
                    }
                }
                const role = p.vendedorRole || (normName.includes('gestor') ? 'gestor' : 'vendedor');
                return ensureSellerEntry(nameCandidate.trim(), nameCandidate.trim(), role, false);
            }

            // 3. Creador original (createdBy) solo si no hay vendedor asignado y el creador es gestor o vendedor
            if (p.createdBy && String(p.createdBy).trim() !== '' && String(p.createdBy) !== 'sistema') {
                const cId = String(p.createdBy).trim();
                if (usersById[cId]) {
                    const u = usersById[cId];
                    if (u.role === 'vendedor' || u.role === 'gestor') {
                        return ensureSellerEntry(u.id, u.nombre, u.role, !u.activo);
                    }
                    // Si el creador es manager/admin: no inferir, va a 'Sin Asignar'
                    return ensureSellerEntry('sin_asignar', 'Sin Asignar', 'sin_asignar', false);
                }
                if (p.createdByRole === 'vendedor' || p.createdByRole === 'gestor') {
                    const name = p.createdByName || p.creado_por || (p.createdByRole === 'gestor' ? `Gestor ${cId}` : `Vendedor ${cId}`);
                    return ensureSellerEntry(cId, name, p.createdByRole, false);
                }
            }

            // 4. Perfil ambiguo o no asignado
            return ensureSellerEntry('sin_asignar', 'Sin Asignar', 'sin_asignar', false);
        }

        // Acumular ventas ganadas
        (wonList || []).forEach(p => {
            if (!p || p.eliminado === true) return;
            const s = resolveSeller(p);
            const subtotal = getProjectSubtotal(p);
            s.ventasGanadas += subtotal;
            s.countGanadas++;

            if (hasKnownCost(p)) {
                const costo = getProjectCosto(p);
                s.costoGanadas += costo;
                s.precioConCosto += subtotal;
                s.countConCosto++;
            } else {
                s.countSinCosto++;
            }
        });

        // Acumular pérdidas
        (lostList || []).forEach(p => {
            if (!p || p.eliminado === true) return;
            const s = resolveSeller(p);
            s.countPerdidas++;
            s.montoPerdidas += getProjectSubtotal(p);
        });

        // Acumular cartera activa
        (activeList || []).forEach(p => {
            if (!p || p.estado !== 'activo' || p.eliminado === true) return;
            const s = resolveSeller(p);
            const subtotal = getProjectSubtotal(p);

            const clasificacion = p.clasificacion || 'ejecucion';
            if (clasificacion === 'presupuesto') {
                s.montoPresupuestos = (s.montoPresupuestos || 0) + subtotal;
                s.countPresupuestos = (s.countPresupuestos || 0) + 1;
                s.countActivas++;
                return;
            }

            s.pipelineNominal += subtotal;
            s.countActivas++;

            const hasProb = typeof p.probabilidad !== 'undefined' && p.probabilidad !== null && p.probabilidad !== '' && !isNaN(Number(p.probabilidad));
            const prob = hasProb ? Number(p.probabilidad) : null;
            if (prob !== null && prob >= 0 && prob <= 100 && subtotal > 0) {
                s.pipelinePonderado += (subtotal * (prob / 100));
            }
        });

        const sellersList = Object.values(sellersMap).map(s => {
            // Margen bruto conocido del vendedor sobre ventas con costo conocido
            s.margen = s.countConCosto > 0 ? (s.precioConCosto - s.costoGanadas) : 0;
            if (s.precioConCosto > 0 && s.countConCosto > 0) {
                s.margenPct = parseFloat((((s.precioConCosto - s.costoGanadas) / s.precioConCosto) * 100).toFixed(1));
            } else if (s.countGanadas === 0) {
                s.margenPct = 0;
            } else {
                s.margenPct = null;
            }

            s.coberturaPct = s.ventasGanadas > 0
                ? parseFloat(((s.precioConCosto / s.ventasGanadas) * 100).toFixed(1))
                : 100;

            const concluidas = s.countGanadas + s.countPerdidas;
            s.concluidas = concluidas;
            s.winRate = concluidas > 0 ? parseFloat(((s.countGanadas / concluidas) * 100).toFixed(1)) : null;
            s.winRateFormatted = s.winRate !== null ? `${s.winRate.toFixed(1)}% (${s.countGanadas}/${concluidas})` : 'Sin cierres';

            return s;
        });

        // Métricas de comerciales inactivos que quedan excluidos en la vista 'active_only'
        const excludedInactiveMetrics = {
            countSellers: 0,
            ventasGanadas: 0,
            costoGanadas: 0,
            precioConCosto: 0,
            margen: 0,
            pipelineNominal: 0,
            pipelinePonderado: 0,
            countGanadas: 0,
            countPerdidas: 0,
            countActivas: 0
        };

        sellersList.forEach(s => {
            if (s.isInactive) {
                const hasAct = s.ventasGanadas > 0 || s.countPerdidas > 0 || s.pipelineNominal > 0 || s.countActivas > 0;
                if (hasAct) {
                    excludedInactiveMetrics.countSellers++;
                    excludedInactiveMetrics.ventasGanadas += s.ventasGanadas;
                    excludedInactiveMetrics.costoGanadas += s.costoGanadas;
                    excludedInactiveMetrics.precioConCosto += s.precioConCosto;
                    excludedInactiveMetrics.margen += s.margen;
                    excludedInactiveMetrics.pipelineNominal += s.pipelineNominal;
                    excludedInactiveMetrics.pipelinePonderado += s.pipelinePonderado;
                    excludedInactiveMetrics.countGanadas += s.countGanadas;
                    excludedInactiveMetrics.countPerdidas += s.countPerdidas;
                    excludedInactiveMetrics.countActivas += s.countActivas;
                }
            }
        });

        // Filtrar comerciales con actividad relevante
        const withActivity = sellersList.filter(s =>
            s.ventasGanadas > 0 || s.countPerdidas > 0 || s.pipelineNominal > 0 || s.countActivas > 0
        );

        let filteredSellers = [];
        if (filterMode === 'all') {
            filteredSellers = withActivity;
        } else {
            // 'active_only': Solo comerciales activos (isInactive !== true)
            // 'sin_asignar' se incluye solo si tiene actividad comercial
            filteredSellers = withActivity.filter(s => !s.isInactive);
        }

        filteredSellers.sort((a, b) => b.ventasGanadas - a.ventasGanadas || b.pipelineNominal - a.pipelineNominal);

        return {
            sellers: filteredSellers,
            totalSellers: filteredSellers.length,
            allSellersMap: sellersMap,
            filterMode: filterMode,
            excludedInactiveMetrics: excludedInactiveMetrics
        };
    }

    /**
     * Calcula la distribución del stock actual por etapa con valores nominales, ponderados y alertas.
     */
    function calculatePipelineStageDistribution(activeList, stages = STAGES, kpiLimits = DEFAULT_KPI_LIMITS) {
        const stageList = Array.isArray(stages) && stages.length > 0 ? stages : STAGES;
        const limits = kpiLimits || DEFAULT_KPI_LIMITS;
        const list = Array.isArray(activeList) ? activeList.filter(p => p && p.estado === 'activo' && p.eliminado !== true) : [];

        const stageResults = stageList.map(st => {
            const ops = list.filter(p => p.etapa === st);
            let montoNominal = 0;
            let montoPonderado = 0;
            let countSinProb = 0;
            let montoSinProb = 0;
            let montoPresupuesto = 0;
            let countPresupuesto = 0;
            let countEjecucion = 0;

            ops.forEach(p => {
                const subtotal = getProjectSubtotal(p);
                const clasificacion = p.clasificacion || 'ejecucion';
                if (clasificacion === 'presupuesto') {
                    montoPresupuesto += subtotal;
                    countPresupuesto++;
                    return;
                }

                countEjecucion++;
                montoNominal += subtotal;

                const hasProb = typeof p.probabilidad !== 'undefined' && p.probabilidad !== null && p.probabilidad !== '' && !isNaN(Number(p.probabilidad));
                const prob = hasProb ? Number(p.probabilidad) : null;
                const validProb = prob !== null && prob >= 0 && prob <= 100;

                if (validProb && subtotal > 0) {
                    montoPonderado += (subtotal * (prob / 100));
                } else {
                    countSinProb++;
                    montoSinProb += subtotal;
                }
            });

            return {
                stage: st,
                count: ops.length,
                countEjecucion,
                countPresupuesto,
                montoNominal,
                montoPonderado,
                montoPresupuesto,
                countSinProb,
                montoSinProb,
                limitDays: Object.prototype.hasOwnProperty.call(limits, st) ? limits[st] : 5
            };
        });

        const totalNominal = stageResults.reduce((acc, s) => acc + s.montoNominal, 0);
        const totalPonderado = stageResults.reduce((acc, s) => acc + s.montoPonderado, 0);
        const totalOps = stageResults.reduce((acc, s) => acc + s.count, 0);

        return {
            stages: stageResults,
            totalNominal,
            totalPonderado,
            totalOps
        };
    }

    return {
        STAGES,
        DEFAULT_KPI_LIMITS,
        MESES,
        getProjectSubtotal,
        getProjectCosto,
        hasKnownCost,
        parseValidDate,
        getAvailableYears,
        getPeriodInterval,
        filterProspects,
        calculateWonMetrics,
        calculateLostMetrics,
        calculateActivePipelineMetrics,
        calculateCxCMetrics,
        calculateStageTransitionTimes,
        calculateActiveWipTimes,
        calculateChannelConversion,
        calculateMonthlyEvolution,
        calculateSellerPerformance,
        calculatePipelineStageDistribution
    };
});
