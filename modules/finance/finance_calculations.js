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

    /**
     * Calcula el subtotal consolidado del proyecto sumando el precio cotizado
     * base con las órdenes de cambio aprobadas (aumento: +, disminución: -).
     * @param {Object} p - Objeto oportunidad / proyecto
     * @returns {number} Subtotal en dólares
     */
    function getProjectSubtotal(p) {
        if (!p || typeof p !== 'object') return 0;
        let base = parseFloat(p.precio_cotizado) || 0;
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o) return;
                const precio = parseFloat(o.precio) || 0;
                base += (o.tipo === 'aumento' ? precio : -Math.abs(precio));
            });
        }
        return base;
    }

    /**
     * Calcula el costo presupuestado consolidado del proyecto sumando el costo
     * de venta base con las órdenes de cambio aprobadas.
     * @param {Object} p - Objeto oportunidad / proyecto
     * @returns {number} Costo total en dólares
     */
    function getProjectCosto(p) {
        if (!p || typeof p !== 'object') return 0;
        let base = parseFloat(p.costo_venta) || 0;
        if (Array.isArray(p.ordenes_cambio)) {
            p.ordenes_cambio.forEach(o => {
                if (!o) return;
                const costo = parseFloat(o.costo) || 0;
                base += (o.tipo === 'aumento' ? costo : -Math.abs(costo));
            });
        }
        return base;
    }

    /**
     * Determina con precisión de centavos si un proyecto está completamente cobrado.
     * Evalúa condición de exportación del cliente (0% IVA vs 13% IVA), total contratado
     * y la suma de todos los abonos en todas sus facturas.
     * @param {Object} p - Objeto oportunidad / proyecto
     * @returns {boolean} True si totalCobrado >= (total - 0.05)
     */
    function isProjectFullyPaid(p) {
        if (!p || typeof p !== 'object') return false;
        const subtotal = getProjectSubtotal(p);
        if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal <= 0) return false;

        let isExport = false;
        let clientList = (typeof _deps.getClients === 'function') ? _deps.getClients() : [];
        if ((!clientList || clientList.length === 0) && typeof global !== 'undefined' && Array.isArray(global.clients)) {
            clientList = global.clients;
        }
        if (p.clientId && Array.isArray(clientList) && clientList.length > 0) {
            const client = clientList.find(c => c && c.id === p.clientId);
            if (client) isExport = client.es_exportacion === true || client.es_exportacion === 'true';
        }

        const total = isExport ? Math.round(subtotal * 100) / 100 : Math.round(subtotal * 1.13 * 100) / 100;
        if (total <= 0) return false;
        if (!Array.isArray(p.facturas) || p.facturas.length === 0) return false;

        let totalCobrado = 0;
        p.facturas.forEach(f => {
            if (f && Array.isArray(f.pagos)) {
                f.pagos.forEach(pay => {
                    const m = parseFloat(pay && pay.monto);
                    if (!isNaN(m) && m > 0) totalCobrado += m;
                });
            }
        });

        if (totalCobrado <= 0) return false;
        return totalCobrado >= (total - 0.05);
    }

    /**
     * Calcula métricas financieras consolidadas de un proyecto.
     * @param {Object} p - Objeto oportunidad / proyecto
     * @param {Object} [client] - Cliente asociado opcional
     * @returns {Object} Desglose completo de montos y porcentajes
     */
    function calculateProjectFinancials(p, client = null) {
        if (!p || typeof p !== 'object') {
            return {
                subtotal: 0, iva: 0, total: 0, costoTotal: 0, margen: 0, margenPct: 0,
                totalFacturado: 0, totalCobrado: 0, saldoCxC: 0, porFacturar: 0,
                pctFacturado: 0, pctCobrado: 0, isFullyPaid: false, isExport: false, isGranContribuyente: false
            };
        }

        const clientList = (typeof _deps.getClients === 'function') ? _deps.getClients() : [];
        const fallbackList = (Array.isArray(clientList) && clientList.length > 0) ? clientList : ((typeof global !== 'undefined' && Array.isArray(global.clients)) ? global.clients : []);
        const activeClient = client || (fallbackList.find(c => c && c.id === p.clientId) || null);
        const isExport = !!(activeClient && (activeClient.es_exportacion === true || activeClient.es_exportacion === 'true'));
        const isGranContribuyente = !!(activeClient && (activeClient.is_gran_contribuyente === true || activeClient.is_gran_contribuyente === 'true'));

        const subtotal = getProjectSubtotal(p);
        const iva = isExport ? 0 : Math.round(subtotal * 0.13 * 100) / 100;
        const total = isExport ? Math.round(subtotal * 100) / 100 : Math.round(subtotal * 1.13 * 100) / 100;

        const costoTotal = getProjectCosto(p);
        const margen = subtotal - costoTotal;
        const margenPct = subtotal > 0 ? (margen / subtotal) * 100 : 0;

        let totalFacturado = 0;
        let totalCobrado = 0;
        let montoEfectivoConfirmado = 0;
        let montoRetencionConfirmada = 0;

        if (Array.isArray(p.facturas)) {
            p.facturas.forEach(f => {
                if (!f) return;
                const fm = parseFloat(f.monto);
                if (!isNaN(fm) && fm > 0) totalFacturado += fm;
                if (Array.isArray(f.pagos)) {
                    f.pagos.forEach(pay => {
                        const m = parseFloat(pay && pay.monto);
                        if (!isNaN(m) && m > 0) {
                            totalCobrado += m;
                            if (pay && pay.metodo === 'retencion_1pct') {
                                montoRetencionConfirmada += m;
                            } else {
                                montoEfectivoConfirmado += m;
                            }
                        }
                    });
                }
            });
        }

        montoEfectivoConfirmado = Math.round(montoEfectivoConfirmado * 100) / 100;
        montoRetencionConfirmada = Math.round(montoRetencionConfirmada * 100) / 100;
        const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);
        const porFacturar = Math.max(0, Math.round((total - totalFacturado) * 100) / 100);
        const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
        const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;
        const fullyPaid = isProjectFullyPaid(p);

        return {
            subtotal,
            iva,
            total,
            costoTotal,
            margen,
            margenPct,
            totalFacturado,
            totalCobrado,
            montoEfectivoConfirmado,
            montoRetencionConfirmada,
            saldoCxC,
            porFacturar,
            pctFacturado,
            pctCobrado,
            isFullyPaid: fullyPaid,
            isExport,
            isGranContribuyente
        };
    }

    /**
     * Calcula los saldos y estado de una factura individual.
     * @param {Object} f - Factura
     * @returns {Object} { cobrado, montoEfectivoConfirmado, montoRetencionConfirmada, saldo, saldoPendiente, isPaid }
     */
    function calculateInvoiceStatus(f) {
        if (!f || typeof f !== 'object') {
            return { cobrado: 0, montoEfectivoConfirmado: 0, montoRetencionConfirmada: 0, saldo: 0, saldoPendiente: 0, isPaid: false };
        }
        const monto = parseFloat(f.monto) || 0;
        let cobrado = 0;
        let montoEfectivoConfirmado = 0;
        let montoRetencionConfirmada = 0;
        if (Array.isArray(f.pagos)) {
            f.pagos.forEach(pay => {
                const m = parseFloat(pay && pay.monto) || 0;
                if (m > 0) {
                    cobrado += m;
                    if (pay && pay.metodo === 'retencion_1pct') {
                        montoRetencionConfirmada += m;
                    } else {
                        montoEfectivoConfirmado += m;
                    }
                }
            });
        }
        cobrado = Math.round(cobrado * 100) / 100;
        montoEfectivoConfirmado = Math.round(montoEfectivoConfirmado * 100) / 100;
        montoRetencionConfirmada = Math.round(montoRetencionConfirmada * 100) / 100;
        const saldo = Math.max(0, Math.round((monto - cobrado) * 100) / 100);
        const isPaid = (monto - cobrado) <= 0.009;
        return {
            cobrado,
            montoEfectivoConfirmado,
            montoRetencionConfirmada,
            saldo,
            saldoPendiente: saldo,
            isPaid
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
        getProjectSubtotal,
        getProjectCosto,
        isProjectFullyPaid,
        calculateProjectFinancials,
        calculateInvoiceStatus
    };
});
