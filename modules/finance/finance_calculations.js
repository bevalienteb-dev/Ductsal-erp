// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: CALCULATIONS (Fase 6.4)
// Archivo: modules/finance/finance_calculations.js
// Responsabilidades:
// 1. Motor matemático de subtotales, costos, márgenes e IVA de proyectos.
// 2. Consolidación de órdenes de cambio (aumentos y disminuciones).
// 3. Verificación de liquidación completa de proyectos (isProjectFullyPaid).
// 4. Determinación de saldos vivos de Cuentas por Cobrar (CxC) y por facturar.
// 5. Cálculos individuales por factura y estado de pago (PAGADA / PENDIENTE).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceCalculations = api;
        if (typeof window !== 'undefined') {
            window.FinanceCalculations = api;
            window.getProjectSubtotal = api.getProjectSubtotal;
            window.getProjectCosto = api.getProjectCosto;
            window.isProjectFullyPaid = api.isProjectFullyPaid;
            window.calculateProjectFinancials = api.calculateProjectFinancials;
            window.calculateInvoiceStatus = api.calculateInvoiceStatus;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients) && clients.length > 0) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients) && window.clients.length > 0) return window.clients;
            if (typeof global !== 'undefined' && Array.isArray(global.clients) && global.clients.length > 0) return global.clients;
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            if (typeof global !== 'undefined' && Array.isArray(global.clients)) return global.clients;
            return [];
        }
    };

    const INVALID_FINANCIAL_STATUSES = [
        'anulado', 'anulada', 'revertido', 'revertida',
        'eliminado', 'eliminada', 'rechazado', 'rechazada',
        'voided', 'reversed', 'cancelado', 'cancelada'
    ];

    /**
     * Convierte un monto monetario a centavos enteros exactos.
     */
    function toCents(n) {
        const num = typeof n === 'number' ? n : parseFloat(n);
        if (!Number.isFinite(num)) return 0;
        return Math.round(num * 100);
    }

    /**
     * Convierte centavos enteros a dólares con 2 decimales.
     */
    function fromCents(cents) {
        const c = typeof cents === 'number' ? cents : parseInt(cents, 10);
        if (!Number.isFinite(c)) return 0;
        return Math.round(c) / 100;
    }

    function round2(n) {
        return fromCents(toCents(n));
    }

    function addMoney(...values) {
        let totalCents = 0;
        for (let i = 0; i < values.length; i++) {
            totalCents += toCents(values[i]);
        }
        return fromCents(totalCents);
    }

    function subMoney(a, b) {
        return fromCents(toCents(a) - toCents(b));
    }

    function normalizePaymentReference(ref) {
        if (typeof ref !== 'string') return '';
        const raw = ref.normalize('NFKC').trim().toUpperCase();
        if (!raw) return '';
        return raw.replace(/[\s\-_./#]+/g, '');
    }

    /**
     * Determina si una factura está activa y vigente (excluye anuladas, eliminadas o vacías).
     */
    function isActiveInvoice(fac) {
        if (!fac || typeof fac !== 'object') return false;
        if (
            fac.anulada === true || fac.anulado === true ||
            fac.eliminada === true || fac.eliminado === true ||
            fac.voided === true || fac.cancelada === true || fac.cancelado === true
        ) {
            return false;
        }
        const st = typeof fac.estado === 'string' ? fac.estado.trim().toLowerCase() : '';
        if (st && INVALID_FINANCIAL_STATUSES.includes(st)) return false;
        if (typeof fac.numero === 'string' && fac.numero.trim().length === 0) return false;
        return toCents(fac.monto) > 0;
    }

    /**
     * Determina si un registro de pago/aplicación está activo y vigente.
     */
    function isActivePaymentRecord(pay) {
        if (!pay || typeof pay !== 'object') return false;
        if (
            pay.anulado === true || pay.anulada === true ||
            pay.revertido === true || pay.revertida === true ||
            pay.eliminado === true || pay.eliminada === true ||
            pay.rechazado === true || pay.rechazada === true ||
            pay.voided === true || pay.reversed === true ||
            pay.promesa === true || pay.es_promesa === true ||
            pay.pendiente_verificacion === true ||
            pay.verificado === false || pay.confirmado === false
        ) {
            return false;
        }
        const st = typeof pay.estado === 'string' ? pay.estado.trim().toLowerCase() : '';
        if (st && INVALID_FINANCIAL_STATUSES.includes(st)) return false;
        return toCents(pay.monto) > 0;
    }

    function isRetentionPayment(pay) {
        if (!pay || typeof pay !== 'object') return false;
        return String(pay.metodo || '').trim().toLowerCase() === 'retencion_1pct';
    }

    function isBankMonetaryPayment(pay) {
        return isActivePaymentRecord(pay) && !isRetentionPayment(pay);
    }

    function resolveClientForProspect(p, clientOrList = null) {
        if (clientOrList && !Array.isArray(clientOrList) && typeof clientOrList === 'object') {
            return clientOrList;
        }
        const providedList = Array.isArray(clientOrList) ? clientOrList : null;
        const depList = (typeof _deps.getClients === 'function') ? _deps.getClients() : [];
        const fallbackList = providedList || ((Array.isArray(depList) && depList.length > 0)
            ? depList
            : ((typeof global !== 'undefined' && Array.isArray(global.clients)) ? global.clients : []));
        if (!p || !p.clientId || !Array.isArray(fallbackList) || fallbackList.length === 0) return null;
        const found = fallbackList.find(c => c && c.id === p.clientId);
        if (found && typeof found.fusionada_en === 'string' && found.fusionada_en.trim()) {
            const canonical = fallbackList.find(c => c && c.id === found.fusionada_en.trim());
            if (canonical) return canonical;
        }
        return found || null;
    }

    /**
     * Calcula el subtotal consolidado del proyecto sumando el precio cotizado
     * base con las órdenes de cambio aprobadas (aumento: +, disminución: -).
     * @param {Object} p - Objeto oportunidad / proyecto
     * @returns {number} Subtotal en dólares
     */
    function getProjectSubtotal(p) {
        if (!p || typeof p !== 'object') return 0;
        let baseCents = toCents(p.precio_cotizado);
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o || o.eliminado === true || o.anulado === true) return;
                const rawPrice = o.precio !== undefined ? o.precio : o.monto;
                const precioCents = Math.abs(toCents(rawPrice));
                const isDecrease = o.tipo === 'disminucion';
                baseCents += (isDecrease ? -precioCents : precioCents);
            });
        }
        return fromCents(baseCents);
    }

    /**
     * Calcula el costo presupuestado consolidado del proyecto sumando el costo
     * de venta base con las órdenes de cambio aprobadas.
     * @param {Object} p - Objeto oportunidad / proyecto
     * @returns {number} Costo total en dólares
     */
    function getProjectCosto(p) {
        if (!p || typeof p !== 'object') return 0;
        let baseCents = toCents(p.costo_venta);
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o || o.eliminado === true || o.anulado === true) return;
                const costoCents = Math.abs(toCents(o.costo));
                baseCents += (o.tipo === 'aumento' ? costoCents : -costoCents);
            });
        }
        return fromCents(baseCents);
    }

    /**
     * Determina con precisión de centavos si un proyecto está completamente cobrado.
     * Evalúa condición de exportación del cliente (0% IVA vs 13% IVA), total contratado
     * y la suma de todos los abonos válidos en todas sus facturas activas.
     * @param {Object} p - Objeto oportunidad / proyecto
     * @param {Object|Array} [clientOrList] - Cliente o lista de clientes opcional
     * @returns {boolean} True si totalCobrado >= (total - 0.05)
     */
    function isProjectFullyPaid(p, clientOrList = null) {
        if (!p || typeof p !== 'object') return false;
        const subtotal = getProjectSubtotal(p);
        if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal <= 0) return false;

        const client = resolveClientForProspect(p, clientOrList);
        const isExport = Boolean(client && (client.es_exportacion === true || client.es_exportacion === 'true'));

        const total = isExport ? round2(subtotal) : round2(subtotal * 1.13);
        if (total <= 0) return false;
        if (!Array.isArray(p.facturas) || p.facturas.length === 0) return false;

        let totalCobradoCents = 0;
        p.facturas.forEach(f => {
            if (!isActiveInvoice(f)) return;
            if (Array.isArray(f.pagos)) {
                f.pagos.forEach(pay => {
                    if (!isActivePaymentRecord(pay)) return;
                    totalCobradoCents += toCents(pay.monto);
                });
            }
        });

        const totalCobrado = fromCents(totalCobradoCents);
        if (totalCobrado <= 0) return false;
        return totalCobrado >= (total - 0.05);
    }

    /**
     * Calcula métricas financieras consolidadas de un proyecto (B5.1).
     * @param {Object} p - Objeto oportunidad / proyecto
     * @param {Object|Array} [client] - Cliente asociado o lista de clientes opcional
     * @returns {Object} Desglose completo de montos y porcentajes
     */
    function calculateProjectFinancials(p, client = null) {
        if (!p || typeof p !== 'object') {
            return {
                subtotal: 0, iva: 0, ivaRate: 1.13, total: 0, costo: 0, costoTotal: 0, margen: 0, margenPct: 0,
                totalFacturado: 0, totalCobrado: 0,
                montoEfectivoConfirmado: 0, montoRetencionConfirmada: 0,
                cobrosMonetariosAplicados: 0, retencionesAplicadas: 0,
                saldoCxC: 0, porFacturar: 0,
                ventasAdjudicadasSubtotal: 0, ventasAdjudicadasTotal: 0,
                facturacionRegistradaVigente: 0, cobrosAplicadosTotal: 0,
                saldoPorCobrar: 0, saldoPorFacturar: 0,
                costoPresupuestado: 0, margenBrutoEstimado: 0, margenBrutoEstimadoPct: 0,
                esMargenEstimadoPresupuestado: true,
                pctFacturado: 0, pctCobrado: 0, isFullyPaid: false, isExport: false, isGranContribuyente: false
            };
        }

        const activeClient = resolveClientForProspect(p, client);
        const isExport = !!(activeClient && (activeClient.es_exportacion === true || activeClient.es_exportacion === 'true'));
        const isGranContribuyente = !!(activeClient && (activeClient.is_gran_contribuyente === true || activeClient.is_gran_contribuyente === 'true'));
        const ivaRate = isExport ? 1.0 : 1.13;

        const subtotal = getProjectSubtotal(p);
        const iva = isExport ? 0 : round2(subtotal * 0.13);
        const total = isExport ? round2(subtotal) : round2(subtotal * 1.13);

        const costoTotal = getProjectCosto(p);
        const margen = subMoney(subtotal, costoTotal);
        const margenPct = subtotal > 0 ? (margen / subtotal) * 100 : 0;

        let totalFacturadoCents = 0;
        let montoEfectivoConfirmadoCents = 0;
        let montoRetencionConfirmadaCents = 0;

        if (Array.isArray(p.facturas)) {
            p.facturas.forEach(f => {
                if (!isActiveInvoice(f)) return;
                totalFacturadoCents += toCents(f.monto);
                if (Array.isArray(f.pagos)) {
                    f.pagos.forEach(pay => {
                        if (!isActivePaymentRecord(pay)) return;
                        const mCents = toCents(pay.monto);
                        if (isRetentionPayment(pay)) {
                            montoRetencionConfirmadaCents += mCents;
                        } else {
                            montoEfectivoConfirmadoCents += mCents;
                        }
                    });
                }
            });
        }

        const totalCobradoCents = montoEfectivoConfirmadoCents + montoRetencionConfirmadaCents;
        const totalCents = toCents(total);
        const saldoCxCCents = Math.max(0, totalFacturadoCents - totalCobradoCents);
        const porFacturarCents = Math.max(0, totalCents - totalFacturadoCents);

        const totalFacturado = fromCents(totalFacturadoCents);
        const totalCobrado = fromCents(totalCobradoCents);
        const montoEfectivoConfirmado = fromCents(montoEfectivoConfirmadoCents);
        const montoRetencionConfirmada = fromCents(montoRetencionConfirmadaCents);
        const saldoCxC = fromCents(saldoCxCCents);
        const porFacturar = fromCents(porFacturarCents);

        const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
        const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;
        const fullyPaid = isProjectFullyPaid(p, client);

        return {
            subtotal,
            iva,
            ivaRate,
            total,
            costo: costoTotal,
            costoTotal,
            margen,
            margenPct,
            totalFacturado,
            totalCobrado,
            montoEfectivoConfirmado,
            montoRetencionConfirmada,
            cobrosMonetariosAplicados: montoEfectivoConfirmado,
            retencionesAplicadas: montoRetencionConfirmada,
            saldoCxC,
            porFacturar,
            ventasAdjudicadasSubtotal: subtotal,
            ventasAdjudicadasTotal: total,
            pactado: total,
            facturado: totalFacturado,
            cobrado: totalCobrado,
            facturacionRegistradaVigente: totalFacturado,
            cobrosAplicadosTotal: totalCobrado,
            saldoPorCobrar: saldoCxC,
            saldoFacturadoPendienteCobrar: saldoCxC,
            saldoPorFacturar: porFacturar,
            pendienteFacturar: porFacturar,
            pendienteCobrar: fromCents(saldoCxCCents + porFacturarCents),
            costoPresupuestado: costoTotal,
            margenBrutoEstimado: margen,
            margenBrutoEstimadoPct: margenPct,
            esMargenEstimadoPresupuestado: true,
            pctFacturado,
            pctCobrado,
            isFullyPaid: fullyPaid,
            isExport,
            isGranContribuyente
        };
    }

    /**
     * Calcula los saldos y estado de una factura individual (B5.1).
     * @param {Object} f - Factura
     * @returns {Object} { monto, cobrado, montoEfectivoConfirmado, montoRetencionConfirmada, cobrosMonetariosAplicados, retencionesAplicadas, saldo, saldoPendiente, isPaid, isActive }
     */
    function calculateInvoiceStatus(f) {
        if (!f || typeof f !== 'object' || !isActiveInvoice(f)) {
            return {
                monto: 0,
                cobrado: 0,
                totalCobradoAplicado: 0,
                montoEfectivoConfirmado: 0,
                montoRetencionConfirmada: 0,
                cobrosMonetariosAplicados: 0,
                retencionesAplicadas: 0,
                saldo: 0,
                saldoPendiente: 0,
                isPaid: false,
                isActive: false
            };
        }
        const montoCents = toCents(f.monto);
        let montoEfectivoConfirmadoCents = 0;
        let montoRetencionConfirmadaCents = 0;
        if (Array.isArray(f.pagos)) {
            f.pagos.forEach(pay => {
                if (!isActivePaymentRecord(pay)) return;
                const mCents = toCents(pay.monto);
                if (isRetentionPayment(pay)) {
                    montoRetencionConfirmadaCents += mCents;
                } else {
                    montoEfectivoConfirmadoCents += mCents;
                }
            });
        }
        const cobradoCents = montoEfectivoConfirmadoCents + montoRetencionConfirmadaCents;
        const saldoCents = Math.max(0, montoCents - cobradoCents);
        const monto = fromCents(montoCents);
        const cobrado = fromCents(cobradoCents);
        const montoEfectivoConfirmado = fromCents(montoEfectivoConfirmadoCents);
        const montoRetencionConfirmada = fromCents(montoRetencionConfirmadaCents);
        const saldo = fromCents(saldoCents);
        const isPaid = (monto - cobrado) <= 0.009 && monto > 0;
        return {
            monto,
            cobrado,
            totalCobradoAplicado: cobrado,
            montoEfectivoConfirmado,
            montoRetencionConfirmada,
            cobrosMonetariosAplicados: montoEfectivoConfirmado,
            retencionesAplicadas: montoRetencionConfirmada,
            saldo,
            saldoPendiente: saldo,
            isPaid,
            isActive: true
        };
    }

    /**
     * Evalúa el estado canónico y saldos de un abono bancario (`payment_refs` / `BANK_<ref>`).
     */
    function calculateDepositStatus(dep) {
        if (!dep || typeof dep !== 'object') {
            return {
                isActive: false,
                estadoAbono: 'invalido',
                importeOriginalRecibido: 0,
                totalAplicado: 0,
                saldoDisponible: 0,
                activeApplicationsCount: 0,
                voidedApplicationsCount: 0
            };
        }
        const rawEstado = String(dep.estado_abono || dep.estado || dep.status || '').trim().toLowerCase();
        const isVoided = Boolean(
            dep.active === false ||
            dep.anulado === true ||
            dep.revertido === true ||
            rawEstado === 'anulado' ||
            rawEstado === 'revertido' ||
            rawEstado === 'resuelto_historico' ||
            rawEstado === 'conflicto_historico_auditoria'
        );

        const apps = Array.isArray(dep.aplicaciones) ? dep.aplicaciones : [];
        const activeApps = apps.filter(a => a && a.anulada !== true && a.anulado !== true && a.estado !== 'anulada' && a.estado !== 'anulado' && toCents(a.monto_aplicado ?? a.monto) > 0);
        const voidedApps = apps.filter(a => a && (a.anulada === true || a.anulado === true || a.estado === 'anulada' || a.estado === 'anulado'));

        let entriesSumCents = 0;
        if (activeApps.length > 0) {
            entriesSumCents = activeApps.reduce((acc, a) => acc + toCents(a.monto_aplicado ?? a.monto), 0);
        } else if (dep.entries && typeof dep.entries === 'object') {
            entriesSumCents = Object.values(dep.entries).reduce((acc, e) => {
                if (!e || typeof e !== 'object' || e.anulada === true || e.anulado === true) return acc;
                return acc + toCents(e.monto_aplicado ?? e.monto);
            }, 0);
        } else if (toCents(dep.total_aplicado ?? dep.totalAplicado) > 0) {
            entriesSumCents = toCents(dep.total_aplicado ?? dep.totalAplicado);
        } else if (!dep.es_abono_multifactura && !dep.es_comprobante_distribuido && toCents(dep.monto) > 0 && dep.prospectId && dep.invoiceId) {
            entriesSumCents = toCents(dep.monto);
        }

        const originalCents = Math.max(
            toCents(dep.importe_original_recibido ?? dep.monto_recibido ?? dep.importe_total_comprobante ?? dep.montoTotalComprobante ?? dep.monto),
            entriesSumCents
        );
        const appliedCents = isVoided ? 0 : Math.min(originalCents, entriesSumCents);
        const availableCents = isVoided ? 0 : Math.max(0, originalCents - appliedCents);

        let estadoAbono = 'recibido';
        if (isVoided) {
            estadoAbono = 'anulado';
        } else if (appliedCents > 0 && availableCents === 0) {
            estadoAbono = 'totalmente_aplicado';
        } else if (appliedCents > 0 && availableCents > 0) {
            estadoAbono = 'parcialmente_aplicado';
        }

        return {
            isActive: !isVoided && originalCents > 0,
            estadoAbono,
            importeOriginalRecibido: fromCents(originalCents),
            montoRecibido: fromCents(originalCents),
            totalAplicado: fromCents(appliedCents),
            montoAplicado: fromCents(appliedCents),
            saldoDisponible: fromCents(availableCents),
            activeApplicationsCount: activeApps.length || (dep.entries ? Object.keys(dep.entries).length : (dep.prospectId && dep.invoiceId ? 1 : 0)),
            voidedApplicationsCount: voidedApps.length
        };
    }

    /**
     * Calcula el resumen financiero canónico consolidado para un cliente (o conjunto de oportunidades y abonos),
     * garantizando que las transferencias multifactura se contabilicen una sola vez en `dineroRecibido`
     * y nunca mezclando retenciones con dinero recibido en banco.
     */
    function calculateClientFinancialSummary({ client, prospects = [], bankDeposits = [], clientsList = null } = {}) {
        const effectiveClients = Array.isArray(clientsList)
            ? clientsList
            : (client ? [client] : _deps.getClients());

        let ventasAdjudicadasSubtotalCents = 0;
        let ventasAdjudicadasTotalCents = 0;
        let facturacionVigenteCents = 0;
        let cobrosMonetariosAplicadosCents = 0;
        let retencionesAplicadasCents = 0;
        let saldoPorCobrarCents = 0;
        let saldoPorFacturarCents = 0;
        let activeBilledProspectsCount = 0;
        let wonProspectsCount = 0;

        const bankReceiptsByNormRef = new Map();

        for (const p of (Array.isArray(prospects) ? prospects : [])) {
            if (!p || typeof p !== 'object' || p.eliminado === true) continue;
            const fin = calculateProjectFinancials(p, effectiveClients);
            const pFacturadoCents = toCents(fin.facturacionRegistradaVigente);
            const pCobrosMonCents = toCents(fin.cobrosMonetariosAplicados);
            const pRetencionesCents = toCents(fin.retencionesAplicadas);
            const pSaldoCxCCents = toCents(fin.saldoPorCobrar);

            const isWonOrPostclosing = p.estado === 'ganado' || p.postcierre_habilitado === true || pFacturadoCents > 0;
            if (p.estado === 'ganado') {
                wonProspectsCount += 1;
            }
            if (isWonOrPostclosing) {
                ventasAdjudicadasSubtotalCents += toCents(fin.ventasAdjudicadasSubtotal);
                ventasAdjudicadasTotalCents += toCents(fin.ventasAdjudicadasTotal);
                saldoPorFacturarCents += toCents(fin.saldoPorFacturar);
            }

            if (pFacturadoCents > 0) {
                activeBilledProspectsCount += 1;
            }
            facturacionVigenteCents += pFacturadoCents;
            cobrosMonetariosAplicadosCents += pCobrosMonCents;
            retencionesAplicadasCents += pRetencionesCents;
            saldoPorCobrarCents += pSaldoCxCCents;

            if (Array.isArray(p.facturas)) {
                for (const fac of p.facturas) {
                    if (!isActiveInvoice(fac) || !Array.isArray(fac.pagos)) continue;
                    for (const pay of fac.pagos) {
                        if (!isBankMonetaryPayment(pay)) continue;
                        const normRef = normalizePaymentReference(
                            pay.referencia_bancaria_unica || pay.ref_bancaria_base || pay.ref_normalizada || pay.ref || ''
                        );
                        const key = normRef ? `BANK_${normRef}` : `LEGACY_${p.id}_${fac.id}_${pay.id || pay.fecha || Math.random()}`;
                        const voucherTotalCents = toCents(pay.importe_total_comprobante);
                        const payAmountCents = toCents(pay.monto);
                        const prev = bankReceiptsByNormRef.get(key) || { appliedSumCents: 0, explicitTotalCents: 0 };
                        prev.appliedSumCents += payAmountCents;
                        if (voucherTotalCents > prev.explicitTotalCents) {
                            prev.explicitTotalCents = voucherTotalCents;
                        }
                        bankReceiptsByNormRef.set(key, prev);
                    }
                }
            }
        }

        let abonosPendientesAplicarCents = 0;
        for (const dep of (Array.isArray(bankDeposits) ? bankDeposits : [])) {
            if (!dep || typeof dep !== 'object') continue;
            const metodo = String(dep.metodo || '').trim().toLowerCase();
            if (metodo === 'retencion_1pct') continue;
            const st = calculateDepositStatus(dep);
            if (!st.isActive) continue;
            const normRef = normalizePaymentReference(dep.normRef || dep.referencia_bancaria_unica || dep.ref || '');
            const key = normRef ? `BANK_${normRef}` : (dep.id || `DEP_${Math.random()}`);
            const origCents = toCents(st.importeOriginalRecibido);
            const availCents = toCents(st.saldoDisponible);
            abonosPendientesAplicarCents += availCents;
            const prev = bankReceiptsByNormRef.get(key) || { appliedSumCents: 0, explicitTotalCents: 0 };
            prev.explicitTotalCents = Math.max(prev.explicitTotalCents, origCents);
            prev.fromDepositDoc = true;
            bankReceiptsByNormRef.set(key, prev);
        }

        let dineroRecibidoCents = 0;
        for (const entry of bankReceiptsByNormRef.values()) {
            const voucherCents = entry.explicitTotalCents > 0
                ? Math.max(entry.explicitTotalCents, entry.appliedSumCents)
                : entry.appliedSumCents;
            dineroRecibidoCents += voucherCents;
        }

        if (dineroRecibidoCents < cobrosMonetariosAplicadosCents + abonosPendientesAplicarCents) {
            dineroRecibidoCents = cobrosMonetariosAplicadosCents + abonosPendientesAplicarCents;
        }

        const totalHistoricoFacturado = fromCents(facturacionVigenteCents);
        const totalCobrosMonetarios = fromCents(cobrosMonetariosAplicadosCents);
        const totalRetenciones = fromCents(retencionesAplicadasCents);
        const totalHistoricoCobrado = fromCents(cobrosMonetariosAplicadosCents + retencionesAplicadasCents);
        const totalDineroRecibido = fromCents(dineroRecibidoCents);
        const saldoAbonosPendientes = fromCents(abonosPendientesAplicarCents);
        const saldoPorCobrar = fromCents(saldoPorCobrarCents);
        const saldoPorFacturar = fromCents(saldoPorFacturarCents);
        const esClienteHistorico = Boolean(facturacionVigenteCents > 0 || (cobrosMonetariosAplicadosCents + retencionesAplicadasCents) > 0);

        return {
            ventas_adjudicadas_subtotal: fromCents(ventasAdjudicadasSubtotalCents),
            ventas_adjudicadas_total: fromCents(ventasAdjudicadasTotalCents),
            total_historico_facturado: totalHistoricoFacturado,
            total_historico_cobrado: totalHistoricoCobrado,
            total_dinero_recibido: totalDineroRecibido,
            total_cobros_monetarios_aplicados: totalCobrosMonetarios,
            total_retenciones_aplicadas: totalRetenciones,
            saldo_abonos_pendientes_aplicar: saldoAbonosPendientes,
            saldo_por_cobrar: saldoPorCobrar,
            saldo_por_cobrar_vivo: saldoPorCobrar,
            saldo_por_facturar: saldoPorFacturar,
            saldo_por_facturar_vivo: saldoPorFacturar,
            activeBilledProspectsCount,
            wonProspectsCount,
            es_cliente_historico: esClienteHistorico
        };
    }

    function setDeps(deps) {
        if (deps && typeof deps === 'object') {
            Object.assign(_deps, deps);
        }
    }

    // -------------------------------------------------------------------------
    // API Pública
    // -------------------------------------------------------------------------
    return {
        _deps,
        setDeps,
        toCents,
        fromCents,
        round2,
        addMoney,
        subMoney,
        normalizePaymentReference,
        isActiveInvoice,
        isActivePaymentRecord,
        isRetentionPayment,
        isBankMonetaryPayment,
        getProjectSubtotal,
        getProjectCosto,
        isProjectFullyPaid,
        calculateProjectFinancials,
        calculateInvoiceStatus,
        calculateDepositStatus,
        calculateClientFinancialSummary
    };
});
