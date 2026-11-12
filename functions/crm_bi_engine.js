// ============================================================================
// DUCTSAL ERP — MOTOR CANÓNICO DE FINANZAS Y BUSINESS INTELLIGENCE (Fase B5)
// Archivo: crm_bi_engine.js
// Universal (Node.js / Cloud Functions y Browser)
// Responsabilidades:
// 1. Separación estricta de Ventas Adjudicadas, Facturación Registrada Vigente,
//    Dinero Efectivamente Recibido, Cobros Monetarios Aplicados y Retenciones Aplicadas.
// 2. Deduplicación canónica de transferencias bancarias multifactura (1 ingreso
//    bancario -> N aplicaciones financieras).
// 3. Separación estricta entre métricas de Flujo del Período y métricas de Stock Vigente.
// 4. Cálculo de KPIs Comerciales (Pipeline, Ganadas, Perdidas, Win Rate, Ticket
//    Promedio, Ciclo Comercial, Recurrencia por cliente).
// 5. Cálculo de Márgenes Presupuestados (etiquetados explícitamente como estimados).
// 6. Análisis de Antigüedad de Cuentas por Cobrar (0-30, 31-60, 61-90, >90 días
//    solo con fecha de vencimiento válida; de lo contrario, sin_vencimiento_definido).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.CrmBiEngine = api;
        if (typeof window !== 'undefined') {
            window.CrmBiEngine = api;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    const IVA_RATE = 1.13;
    const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
    const INVALID_FINANCIAL_STATUSES = [
        'anulado', 'anulada', 'revertido', 'revertida',
        'eliminado', 'eliminada', 'rechazado', 'rechazada',
        'voided', 'reversed', 'cancelado', 'cancelada'
    ];

    function toCents(n) {
        const num = typeof n === 'number' ? n : parseFloat(n);
        if (!Number.isFinite(num)) return 0;
        return Math.round(num * 100);
    }

    function fromCents(cents) {
        const c = typeof cents === 'number' ? cents : parseInt(cents, 10);
        if (!Number.isFinite(c)) return 0;
        return Math.round(c) / 100;
    }

    function round2(n) {
        return fromCents(toCents(n));
    }

    function normalizePaymentReference(ref) {
        if (typeof ref !== 'string') return '';
        const raw = ref.normalize('NFKC').trim().toUpperCase();
        if (!raw) return '';
        const cleaned = raw.replace(/[\s\-_./#]+/g, '');
        if (
            cleaned === 'UNDEFINED' ||
            cleaned === 'NULL' ||
            cleaned === 'NAN' ||
            cleaned === 'NA' ||
            cleaned === 'SN' ||
            cleaned === 'HISTORICO' ||
            cleaned === 'IMPORTACIONEXCEL'
        ) {
            return '';
        }
        return cleaned;
    }

    function isExportClient(client) {
        return Boolean(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
    }

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

    function getProjectSubtotalCents(p) {
        if (!p || typeof p !== 'object') return 0;
        let baseCents = toCents(p.precio_cotizado);
        if (Array.isArray(p.ordenes_cambio)) {
            for (const oc of p.ordenes_cambio) {
                if (!oc || oc.eliminado === true || oc.anulado === true) continue;
                const rawPrice = oc.precio !== undefined ? oc.precio : oc.monto;
                const ocCents = Math.abs(toCents(rawPrice));
                const isDecrease = oc.tipo === 'disminucion';
                baseCents += (isDecrease ? -ocCents : ocCents);
            }
        }
        return baseCents;
    }

    function getProjectCostoCents(p) {
        if (!p || typeof p !== 'object') return 0;
        const rawCosto = p.costo_venta !== undefined
            ? p.costo_venta
            : (p.datos && (p.datos.costo_venta ?? p.datos.costo_directo));
        let baseCents = toCents(rawCosto);
        if (Array.isArray(p.ordenes_cambio)) {
            for (const oc of p.ordenes_cambio) {
                if (!oc || oc.eliminado === true || oc.anulado === true) continue;
                const ocCents = Math.abs(toCents(oc.costo));
                const isDecrease = oc.tipo === 'disminucion';
                baseCents += (isDecrease ? -ocCents : ocCents);
            }
        }
        return baseCents;
    }

    function toYMD(rawDate) {
        if (!rawDate) return null;
        if (typeof rawDate === 'string') {
            const trimmed = rawDate.trim();
            if (!trimmed) return null;
            if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
                return trimmed.slice(0, 10);
            }
            const parsed = new Date(trimmed);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed.toISOString().slice(0, 10);
            }
            return null;
        }
        if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
            return rawDate.toISOString().slice(0, 10);
        }
        if (typeof rawDate === 'object' && typeof rawDate.toDate === 'function') {
            const d = rawDate.toDate();
            if (d instanceof Date && !Number.isNaN(d.getTime())) {
                return d.toISOString().slice(0, 10);
            }
        }
        return null;
    }

    /**
     * Construye el filtro de ventana temporal (inicio y fin en formato YYYY-MM-DD).
     * Por defecto en B5.5.4: año en curso (`current_year`) salvo que se indique `all` o intervalo explícito.
     */
    function resolvePeriodBounds(filters = {}, referenceDate = new Date()) {
        const refObj = (referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()))
            ? referenceDate
            : new Date(referenceDate || Date.now());
        const refYMD = refObj.toISOString().slice(0, 10);
        const refYear = refYMD.slice(0, 4);
        const refMonth = refYMD.slice(0, 7);

        const rawPeriod = String(filters.period || filters.periodo || 'current_year').trim();
        const customFrom = toYMD(filters.dateFrom || filters.fechaInicio || filters.desde);
        const customTo = toYMD(filters.dateTo || filters.fechaFin || filters.hasta);

        if (customFrom || customTo) {
            return {
                periodType: 'custom',
                label: `${customFrom || 'inicio'} a ${customTo || 'hoy'}`,
                startYMD: customFrom || '0000-01-01',
                endYMD: customTo || '9999-12-31',
                isUnbounded: false,
                referenceYMD: refYMD
            };
        }

        if (rawPeriod === 'all' || rawPeriod === 'todos' || rawPeriod === 'historico') {
            return {
                periodType: 'all',
                label: 'Histórico completo',
                startYMD: null,
                endYMD: null,
                isUnbounded: true,
                referenceYMD: refYMD
            };
        }

        if (rawPeriod === 'month' || rawPeriod === 'current_month') {
            return {
                periodType: 'month',
                label: `Mes ${refMonth}`,
                startYMD: `${refMonth}-01`,
                endYMD: `${refMonth}-31`,
                isUnbounded: false,
                referenceYMD: refYMD
            };
        }

        if (/^year_\d{4}$/.test(rawPeriod)) {
            const y = rawPeriod.slice(5);
            return {
                periodType: 'year',
                label: `Año ${y}`,
                startYMD: `${y}-01-01`,
                endYMD: `${y}-12-31`,
                isUnbounded: false,
                referenceYMD: refYMD
            };
        }

        if (/^\d{4}$/.test(rawPeriod)) {
            return {
                periodType: 'year',
                label: `Año ${rawPeriod}`,
                startYMD: `${rawPeriod}-01-01`,
                endYMD: `${rawPeriod}-12-31`,
                isUnbounded: false,
                referenceYMD: refYMD
            };
        }

        // Default: Año en curso (`current_year`)
        return {
            periodType: 'current_year',
            label: `Año en curso (${refYear})`,
            startYMD: `${refYear}-01-01`,
            endYMD: `${refYear}-12-31`,
            isUnbounded: false,
            referenceYMD: refYMD
        };
    }

    function isDateInPeriod(rawDate, periodBounds, { fallbackDate = null } = {}) {
        if (!periodBounds || periodBounds.isUnbounded) return true;
        const ymd = toYMD(rawDate) || toYMD(fallbackDate);
        if (!ymd) return false;
        if (periodBounds.startYMD && ymd < periodBounds.startYMD) return false;
        if (periodBounds.endYMD && ymd > periodBounds.endYMD) return false;
        return true;
    }

    function resolveOpportunityWonDate(p) {
        if (!p || typeof p !== 'object') return null;
        return (
            toYMD(p.fecha_cierre) ||
            toYMD(p.fecha_finalizacion) ||
            toYMD(p.fecha_postcierre) ||
            toYMD(p.stage_timestamps && p.stage_timestamps.cierre) ||
            null
        );
    }

    function resolveOpportunityLostDate(p) {
        if (!p || typeof p !== 'object') return null;
        return (
            toYMD(p.fecha_perdida) ||
            toYMD(p.ultima_perdida && p.ultima_perdida.fecha) ||
            null
        );
    }

    /**
     * Evalúa el estado de un depósito bancario (`payment_refs/BANK_*`).
     */
    function evaluateBankDepositRecord(dep) {
        if (!dep || typeof dep !== 'object') {
            return {
                isActive: false,
                estadoAbono: 'invalido',
                estado: 'invalido',
                originalCents: 0,
                importeOriginalCents: 0,
                appliedCents: 0,
                totalAplicadoCents: 0,
                availableCents: 0,
                saldoDisponibleCents: 0,
                ref: '',
                normRef: '',
                clientId: null,
                metodo: '',
                fechaComprobante: null,
                fechaRegistro: null,
                activeApplications: [],
                voidedApplications: []
            };
        }
        const metodo = String(dep.metodo || 'transferencia').trim().toLowerCase();
        if (metodo === 'retencion_1pct') {
            return {
                isActive: false,
                estadoAbono: 'retencion_no_bancaria',
                estado: 'retencion_no_bancaria',
                originalCents: 0,
                importeOriginalCents: 0,
                appliedCents: 0,
                totalAplicadoCents: 0,
                availableCents: 0,
                saldoDisponibleCents: 0,
                ref: '',
                normRef: '',
                clientId: null,
                metodo,
                fechaComprobante: null,
                fechaRegistro: null,
                activeApplications: [],
                voidedApplications: []
            };
        }
        const rawEstado = String(dep.estado_abono || dep.estado || dep.status || '').trim().toLowerCase();
        const isVoided = Boolean(
            dep.active === false ||
            dep.anulado === true ||
            dep.revertido === true ||
            dep.conflicto_historico === true ||
            rawEstado === 'anulado' ||
            rawEstado === 'revertido' ||
            rawEstado === 'resuelto_historico' ||
            rawEstado === 'conflicto_historico' ||
            rawEstado === 'conflicto_historico_auditoria'
        );

        const apps = Array.isArray(dep.aplicaciones) ? dep.aplicaciones : [];
        const activeApps = apps.filter(a => a && a.anulada !== true && a.anulado !== true && a.estado !== 'anulada' && a.estado !== 'anulado' && toCents(a.monto_aplicado ?? a.monto) > 0);
        const voidedApps = apps.filter(a => a && (a.anulada === true || a.anulado === true || a.estado === 'anulada' || a.estado === 'anulado'));

        let entriesSumCents = 0;
        let derivedClientId = dep.clientId || null;
        if (activeApps.length > 0) {
            entriesSumCents = activeApps.reduce((acc, a) => acc + toCents(a.monto_aplicado ?? a.monto), 0);
            if (!derivedClientId && activeApps[0].clientId) derivedClientId = activeApps[0].clientId;
        } else if (dep.entries && typeof dep.entries === 'object') {
            for (const e of Object.values(dep.entries)) {
                if (!e || typeof e !== 'object' || e.anulada === true || e.anulado === true) continue;
                entriesSumCents += toCents(e.monto_aplicado ?? e.monto);
                if (!derivedClientId && e.clientId) derivedClientId = e.clientId;
            }
        } else if (toCents(dep.total_aplicado ?? dep.totalAplicado ?? dep.monto_aplicado_total) > 0) {
            entriesSumCents = toCents(dep.total_aplicado ?? dep.totalAplicado ?? dep.monto_aplicado_total);
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

        const rawRef = String(dep.ref || dep.referencia_bancaria || dep.rawRef || dep.normRef || (dep.id || dep.lockId || '').replace(/^BANK_/, '')).trim();
        const normRef = normalizePaymentReference(dep.normRef || rawRef);
        const fechaComprobante = dep.fecha_comprobante_bancario || dep.fecha_comprobante || dep.voucherDate || dep.fecha || dep.createdAt || null;
        const fechaRegistro = dep.fecha_registro_crm || dep.createdAt || dep.updatedAt || fechaComprobante || null;

        return {
            isActive: !isVoided && originalCents > 0,
            estadoAbono,
            estado: estadoAbono,
            originalCents,
            importeOriginalCents: originalCents,
            appliedCents,
            totalAplicadoCents: appliedCents,
            availableCents,
            saldoDisponibleCents: availableCents,
            ref: rawRef,
            normRef,
            clientId: derivedClientId,
            metodo,
            fechaComprobante,
            fechaRegistro,
            activeApplications: activeApps,
            voidedApplications: voidedApps
        };
    }

    /**
     * Clasifica la antigüedad de una factura con saldo pendiente según B5.5.5:
     * - Si tiene fecha de vencimiento válida (`fecha_vencimiento` / `vencimiento` / `dueDate`),
     *   calcula días vencidos respecto a `referenceYMD` (vigente_no_vencida, 0_30, 31_60, 61_90, mas_90).
     * - Si NO tiene fecha de vencimiento confiable, NO la inventa ni asume 30 días ni la marca como morosa:
     *   la clasifica en `sin_vencimiento_definido`.
     */
    function classifyInvoiceAging(fac, referenceYMD) {
        const rawDueDate = fac && (fac.fecha_vencimiento || fac.vencimiento || fac.dueDate || null);
        const dueYMD = toYMD(rawDueDate);
        const emissionYMD = toYMD(fac && fac.fecha);
        const refYMD = toYMD(referenceYMD) || new Date().toISOString().slice(0, 10);

        if (!dueYMD) {
            return {
                bucket: 'sin_vencimiento_definido',
                hasValidDueDate: false,
                dueDateYMD: null,
                emissionDateYMD: emissionYMD,
                daysPastDue: null,
                esMorosa: false
            };
        }

        const refMs = Date.parse(`${refYMD}T00:00:00.000Z`);
        const dueMs = Date.parse(`${dueYMD}T00:00:00.000Z`);
        const daysPastDue = Math.floor((refMs - dueMs) / 86400000);

        if (daysPastDue <= 0) {
            return {
                bucket: 'vigente_no_vencida',
                hasValidDueDate: true,
                dueDateYMD: dueYMD,
                emissionDateYMD: emissionYMD,
                daysPastDue: Math.min(0, daysPastDue),
                esMorosa: false
            };
        }
        if (daysPastDue <= 30) {
            return {
                bucket: '0_30',
                hasValidDueDate: true,
                dueDateYMD: dueYMD,
                emissionDateYMD: emissionYMD,
                daysPastDue,
                esMorosa: true
            };
        }
        if (daysPastDue <= 60) {
            return {
                bucket: '31_60',
                hasValidDueDate: true,
                dueDateYMD: dueYMD,
                emissionDateYMD: emissionYMD,
                daysPastDue,
                esMorosa: true
            };
        }
        if (daysPastDue <= 90) {
            return {
                bucket: '61_90',
                hasValidDueDate: true,
                dueDateYMD: dueYMD,
                emissionDateYMD: emissionYMD,
                daysPastDue,
                esMorosa: true
            };
        }
        return {
            bucket: 'mas_90',
            hasValidDueDate: true,
            dueDateYMD: dueYMD,
            emissionDateYMD: emissionYMD,
            daysPastDue,
            esMorosa: true
        };
    }

    /**
     * Motor principal de Business Intelligence (B5.5).
     * Calcula todos los indicadores comerciales, financieros, de márgenes y de antigüedad CxC
     * con separación estricta entre Flujo del Período y Stock Vigente.
     */
    function computeBIMetrics({
        prospects = [],
        clients = [],
        bankDeposits = [],
        paymentRefs = [],
        filters = {},
        referenceDate = new Date(),
        nowMs = null
    } = {}) {
        const effectiveReferenceDate = (typeof nowMs === 'number' && Number.isFinite(nowMs))
            ? new Date(nowMs)
            : referenceDate;
        const effectiveBankDeposits = (Array.isArray(bankDeposits) && bankDeposits.length > 0)
            ? bankDeposits
            : (Array.isArray(paymentRefs) ? paymentRefs : []);
        const periodBounds = resolvePeriodBounds(filters, effectiveReferenceDate);

        // 1. Mapa de clientes y resolución de cuentas fusionadas (`fusionada_en`)
        const clientsById = new Map();
        for (const c of (Array.isArray(clients) ? clients : [])) {
            if (c && c.id) {
                clientsById.set(String(c.id), c);
            }
        }

        const resolveCanonicalClientId = (rawClientId) => {
            if (!rawClientId) return null;
            let curId = String(rawClientId).trim();
            const visited = new Set([curId]);
            for (let depth = 0; depth < 6; depth++) {
                const c = clientsById.get(curId);
                if (!c || !c.fusionada_en || typeof c.fusionada_en !== 'string' || !c.fusionada_en.trim()) {
                    return curId;
                }
                const nextId = c.fusionada_en.trim();
                if (visited.has(nextId)) break;
                visited.add(nextId);
                curId = nextId;
            }
            return curId;
        };

        const resolveCanonicalClient = (rawClientId) => {
            const canonId = resolveCanonicalClientId(rawClientId);
            return canonId ? (clientsById.get(canonId) || { id: canonId }) : null;
        };

        // 2. Filtros estructurales (cliente, vendedor, gestor/encargado, clasificación, estado comercial)
        const targetCanonicalClientId = filters.clientId ? resolveCanonicalClientId(filters.clientId) : null;
        const filterVendedorId = filters.vendedorId ? String(filters.vendedorId).trim() : null;
        const filterGestor = filters.gestorId || filters.encargado ? String(filters.gestorId || filters.encargado).trim() : null;
        const filterClasificacion = filters.clasificacion ? String(filters.clasificacion).trim().toLowerCase() : null;
        const filterEstado = filters.estado ? String(filters.estado).trim().toLowerCase() : null;

        const matchesStructuralFilters = (p) => {
            if (!p || typeof p !== 'object' || p.eliminado === true) return false;
            if (targetCanonicalClientId) {
                const pCanonClientId = resolveCanonicalClientId(p.clientId);
                if (pCanonClientId !== targetCanonicalClientId) return false;
            }
            if (filterVendedorId && filterVendedorId !== 'all') {
                const vId = String(p.vendedorId || p.createdBy || '').trim();
                if (vId !== filterVendedorId) return false;
            }
            if (filterGestor && filterGestor !== 'all') {
                const enc = String(p.encargado || (p.datos && p.datos.encargado) || '').trim();
                if (enc !== filterGestor && String(p.vendedorId || '') !== filterGestor) return false;
            }
            if (filterClasificacion && filterClasificacion !== 'all' && filterClasificacion !== 'todas') {
                const clasif = String(p.clasificacion || 'ejecucion').trim().toLowerCase();
                if (clasif !== filterClasificacion) return false;
            }
            if (filterEstado && filterEstado !== 'all' && filterEstado !== 'todos') {
                if (String(p.estado || '').trim().toLowerCase() !== filterEstado) return false;
            }
            return true;
        };

        const rawProspects = Array.isArray(prospects) ? prospects : [];
        let eliminadasLogicamenteCount = 0;
        let excluidasPorFiltrosEstructuralesCount = 0;
        const eligibleProspects = [];
        for (const p of rawProspects) {
            if (!p || typeof p !== 'object') {
                excluidasPorFiltrosEstructuralesCount += 1;
                continue;
            }
            if (p.eliminado === true) {
                eliminadasLogicamenteCount += 1;
                continue;
            }
            if (matchesStructuralFilters(p)) {
                eligibleProspects.push(p);
            } else {
                excluidasPorFiltrosEstructuralesCount += 1;
            }
        }

        // ---------------------------------------------------------------------
        // A. INDICADORES COMERCIALES (B5.5.1)
        // ---------------------------------------------------------------------
        const stageDistribution = {};
        for (const st of STAGES) {
            stageDistribution[st] = { count: 0, valorNominal: 0, valorPonderado: 0 };
        }
        const classificationDistribution = {
            ejecucion: { count: 0, valorNominal: 0, valorPonderado: 0 },
            presupuesto: { count: 0, valorNominal: 0, valorPonderado: 0 }
        };

        let activeCount = 0;
        let activeNominalCents = 0;
        let activeWeightedCents = 0;

        // Ganadas y perdidas en el período vs histórico total
        let wonPeriodCount = 0;
        let wonPeriodSubtotalCents = 0;
        let wonPeriodTotalConIvaCents = 0;
        let wonPeriodCostoPresupuestadoCents = 0;
        let wonWithCostoDirectoPeriodCount = 0;

        let wonAllTimeCount = 0;
        let wonAllTimeSubtotalCents = 0;
        let wonAllTimeTotalConIvaCents = 0;
        let wonAllTimeCostoPresupuestadoCents = 0;
        let wonWithCostoDirectoAllTimeCount = 0;

        let lostPeriodCount = 0;
        let lostPeriodSubtotalCents = 0;
        const lostByReasonPeriod = {};

        let lostAllTimeCount = 0;
        let lostAllTimeSubtotalCents = 0;
        let otrasNoReconocidasCount = 0;

        // Ciclo comercial (promedio de días entre creación y adjudicación para ganadas con fechas válidas)
        let cycleDaysSumPeriod = 0;
        let cycleValidCountPeriod = 0;
        let cycleMissingDateCountPeriod = 0;

        let cycleDaysSumAllTime = 0;
        let cycleValidCountAllTime = 0;

        // Recurrencia por cliente canónico (oportunidades ganadas independientes, NO facturas parciales)
        const wonOppIdsByClientAllTime = new Map();
        const wonOppIdsByClientPeriod = new Map();

        for (const p of eligibleProspects) {
            const client = resolveCanonicalClient(p.clientId);
            const canonClientId = client ? String(client.id) : (p.clientId ? String(p.clientId) : 'SIN_CLIENTE');
            const isExport = isExportClient(client);
            const subtotalCents = getProjectSubtotalCents(p);
            const costoCents = getProjectCostoCents(p);
            const totalConIvaCents = isExport ? subtotalCents : toCents(fromCents(subtotalCents) * IVA_RATE);
            const prob = Number(p.probabilidad) || 0;
            const weightedCents = Math.round(subtotalCents * (prob / 100));
            const clasif = String(p.clasificacion || 'ejecucion').trim().toLowerCase() === 'presupuesto' ? 'presupuesto' : 'ejecucion';

            if (p.estado === 'activo') {
                activeCount += 1;
                activeNominalCents += subtotalCents;
                activeWeightedCents += weightedCents;

                const stageKey = STAGES.includes(p.etapa) ? p.etapa : 'prospecto';
                stageDistribution[stageKey].count += 1;
                stageDistribution[stageKey].valorNominal = round2(stageDistribution[stageKey].valorNominal + fromCents(subtotalCents));
                stageDistribution[stageKey].valorPonderado = round2(stageDistribution[stageKey].valorPonderado + fromCents(weightedCents));

                classificationDistribution[clasif].count += 1;
                classificationDistribution[clasif].valorNominal = round2(classificationDistribution[clasif].valorNominal + fromCents(subtotalCents));
                classificationDistribution[clasif].valorPonderado = round2(classificationDistribution[clasif].valorPonderado + fromCents(weightedCents));
            } else if (p.estado === 'ganado') {
                wonAllTimeCount += 1;
                wonAllTimeSubtotalCents += subtotalCents;
                wonAllTimeTotalConIvaCents += totalConIvaCents;
                wonAllTimeCostoPresupuestadoCents += costoCents;
                if (costoCents > 0) wonWithCostoDirectoAllTimeCount += 1;

                if (!wonOppIdsByClientAllTime.has(canonClientId)) {
                    wonOppIdsByClientAllTime.set(canonClientId, new Set());
                }
                wonOppIdsByClientAllTime.get(canonClientId).add(String(p.id));

                const wonYMD = resolveOpportunityWonDate(p);
                const createdYMD = toYMD(p.fecha_creacion);
                let cycleDays = null;
                if (createdYMD && wonYMD) {
                    const startMs = Date.parse(`${createdYMD}T00:00:00.000Z`);
                    const endMs = Date.parse(`${wonYMD}T00:00:00.000Z`);
                    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
                        cycleDays = Math.round((endMs - startMs) / 86400000);
                        cycleDaysSumAllTime += cycleDays;
                        cycleValidCountAllTime += 1;
                    }
                }

                if (isDateInPeriod(wonYMD, periodBounds, { fallbackDate: createdYMD })) {
                    wonPeriodCount += 1;
                    wonPeriodSubtotalCents += subtotalCents;
                    wonPeriodTotalConIvaCents += totalConIvaCents;
                    wonPeriodCostoPresupuestadoCents += costoCents;
                    if (costoCents > 0) wonWithCostoDirectoPeriodCount += 1;

                    if (!wonOppIdsByClientPeriod.has(canonClientId)) {
                        wonOppIdsByClientPeriod.set(canonClientId, new Set());
                    }
                    wonOppIdsByClientPeriod.get(canonClientId).add(String(p.id));

                    if (cycleDays !== null) {
                        cycleDaysSumPeriod += cycleDays;
                        cycleValidCountPeriod += 1;
                    } else {
                        cycleMissingDateCountPeriod += 1;
                    }
                }
            } else if (p.estado === 'perdido') {
                lostAllTimeCount += 1;
                lostAllTimeSubtotalCents += subtotalCents;

                const lostYMD = resolveOpportunityLostDate(p);
                const createdYMD = toYMD(p.fecha_creacion);
                if (isDateInPeriod(lostYMD, periodBounds, { fallbackDate: createdYMD })) {
                    lostPeriodCount += 1;
                    lostPeriodSubtotalCents += subtotalCents;
                    const reason = String(p.motivo_perdida || 'Sin especificar').trim();
                    if (!lostByReasonPeriod[reason]) {
                        lostByReasonPeriod[reason] = { count: 0, valor: 0 };
                    }
                    lostByReasonPeriod[reason].count += 1;
                    lostByReasonPeriod[reason].valor = round2(lostByReasonPeriod[reason].valor + fromCents(subtotalCents));
                }
            } else {
                otrasNoReconocidasCount += 1;
            }
        }

        const inventarioOportunidades = {
            totalDocumentos: rawProspects.length,
            elegiblesCount: eligibleProspects.length,
            activasCount: activeCount,
            ganadasHistoricoCount: wonAllTimeCount,
            perdidasHistoricoCount: lostAllTimeCount,
            eliminadasLogicamenteCount,
            excluidasPorFiltrosEstructuralesCount,
            otrasNoReconocidasCount,
            ecuacionReconciliacionCuadra: (
                rawProspects.length ===
                activeCount +
                wonAllTimeCount +
                lostAllTimeCount +
                eliminadasLogicamenteCount +
                excluidasPorFiltrosEstructuralesCount +
                otrasNoReconocidasCount
            )
        };

        const totalClosedPeriod = wonPeriodCount + lostPeriodCount;
        const winRatePeriodRatio = totalClosedPeriod > 0 ? (wonPeriodCount / totalClosedPeriod) : 0;
        const winRatePeriodPct = round2(winRatePeriodRatio * 100);

        const totalClosedAllTime = wonAllTimeCount + lostAllTimeCount;
        const winRateAllTimeRatio = totalClosedAllTime > 0 ? (wonAllTimeCount / totalClosedAllTime) : 0;
        const winRateAllTimePct = round2(winRateAllTimeRatio * 100);

        const ticketPromedioSubtotalPeriod = wonPeriodCount > 0 ? fromCents(Math.round(wonPeriodSubtotalCents / wonPeriodCount)) : 0;
        const ticketPromedioTotalPeriod = wonPeriodCount > 0 ? fromCents(Math.round(wonPeriodTotalConIvaCents / wonPeriodCount)) : 0;

        const ticketPromedioSubtotalAllTime = wonAllTimeCount > 0 ? fromCents(Math.round(wonAllTimeSubtotalCents / wonAllTimeCount)) : 0;
        const ticketPromedioTotalAllTime = wonAllTimeCount > 0 ? fromCents(Math.round(wonAllTimeTotalConIvaCents / wonAllTimeCount)) : 0;

        const cicloComercialPromedioDiasPeriod = cycleValidCountPeriod > 0
            ? round2(cycleDaysSumPeriod / cycleValidCountPeriod)
            : 0;
        const cicloComercialPromedioDiasAllTime = cycleValidCountAllTime > 0
            ? round2(cycleDaysSumAllTime / cycleValidCountAllTime)
            : 0;

        // Recurrencia
        const recurrenceByClient = [];
        let recurringClientsCount = 0;
        for (const [cid, oppIdSet] of wonOppIdsByClientAllTime.entries()) {
            const count = oppIdSet.size;
            if (count >= 2) recurringClientsCount += 1;
            const cObj = clientsById.get(cid);
            const cName = cObj ? (cObj.empresa || `${cObj.nombres || ''} ${cObj.apellidos || ''}`.trim() || cid) : cid;
            recurrenceByClient.push({
                clientId: cid,
                clienteNombre: cName,
                oportunidadesGanadasCount: count,
                oportunidadesGanadasPeriodoCount: wonOppIdsByClientPeriod.has(cid) ? wonOppIdsByClientPeriod.get(cid).size : 0,
                esClienteRecurrente: count >= 2
            });
        }
        recurrenceByClient.sort((a, b) => b.oportunidadesGanadasCount - a.oportunidadesGanadasCount);

        const singleClientRecurrenceCount = targetCanonicalClientId
            ? (wonOppIdsByClientAllTime.has(targetCanonicalClientId) ? wonOppIdsByClientAllTime.get(targetCanonicalClientId).size : 0)
            : null;

        // ---------------------------------------------------------------------
        // B. INDICADORES FINANCIEROS Y SEPARACIÓN FLUJO VS STOCK (B5.5.2, B5.5.4, B5.5.5)
        // ---------------------------------------------------------------------
        // STOCK VIGENTE (estado vivo actual):
        let stockVentasAdjudicadasSubtotalCents = 0;
        let stockVentasAdjudicadasTotalCents = 0;
        let stockFacturacionVigenteCents = 0;
        let stockCobrosMonetariosAplicadosCents = 0;
        let stockRetencionesAplicadasCents = 0;
        let stockCuentasPorCobrarVivasCents = 0;
        let stockSaldosAFavorCents = 0;
        let stockSaldoPorFacturarCents = 0;

        // FLUJO DEL PERÍODO (filtrado por fecha propia de cada documento fiscal / movimiento):
        let flowFacturacionEmitidaCents = 0;
        let flowFacturasEmitidasCount = 0;
        let flowCobrosMonetariosAplicadosCents = 0;
        let flowRetencionesAplicadasCents = 0;

        // Deduplicación de comprobantes bancarios recibidos (Stock histórico vs Flujo del período)
        const allTimeBankVouchers = new Map();
        const periodBankVouchers = new Map();

        // Desglose por cliente y por oportunidad + Antigüedad de CxC
        const clientPortfolioMap = new Map();
        const cxcByOpportunity = [];
        const agingBuckets = {
            vigente_no_vencida: { count: 0, montoCents: 0, facturas: [] },
            '0_30': { count: 0, montoCents: 0, facturas: [] },
            '31_60': { count: 0, montoCents: 0, facturas: [] },
            '61_90': { count: 0, montoCents: 0, facturas: [] },
            mas_90: { count: 0, montoCents: 0, facturas: [] },
            sin_vencimiento_definido: { count: 0, montoCents: 0, facturas: [] }
        };

        const ensureClientPortfolio = (canonClientId) => {
            const key = canonClientId || 'SIN_CLIENTE';
            if (!clientPortfolioMap.has(key)) {
                const cObj = clientsById.get(key);
                const cName = cObj ? (cObj.empresa || `${cObj.nombres || ''} ${cObj.apellidos || ''}`.trim() || key) : key;
                clientPortfolioMap.set(key, {
                    clientId: key,
                    clienteNombre: cName,
                    ventasAdjudicadasTotalCents: 0,
                    facturacionVigenteCents: 0,
                    cobrosMonetariosAplicadosCents: 0,
                    retencionesAplicadasCents: 0,
                    saldoPorCobrarCents: 0,
                    saldoAFavorCents: 0,
                    saldoPorFacturarCents: 0,
                    abonosDisponiblesSinAsignarCents: 0,
                    dineroRecibidoCents: 0,
                    activeBilledProspectsCount: 0,
                    wonOpportunitiesCount: wonOppIdsByClientAllTime.has(key) ? wonOppIdsByClientAllTime.get(key).size : 0
                });
            }
            return clientPortfolioMap.get(key);
        };

        for (const p of eligibleProspects) {
            const client = resolveCanonicalClient(p.clientId);
            const canonClientId = client ? String(client.id) : (p.clientId ? String(p.clientId) : 'SIN_CLIENTE');
            const isExport = isExportClient(client);
            const subtotalCents = getProjectSubtotalCents(p);
            const totalContratadoCents = isExport ? subtotalCents : toCents(fromCents(subtotalCents) * IVA_RATE);

            const activeInvoices = (Array.isArray(p.facturas) ? p.facturas : []).filter(isActiveInvoice);
            let pFacturadoCents = 0;
            let pCobrosMonCents = 0;
            let pRetencionesCents = 0;
            let pSaldoCxCCents = 0;
            let pSaldoAFavorCents = 0;
            const pendingInvoicesDetail = [];

            for (const fac of activeInvoices) {
                const facMontoCents = toCents(fac.monto);
                pFacturadoCents += facMontoCents;

                // Flujo de facturación emitida en el período (fecha propia de la factura)
                if (isDateInPeriod(fac.fecha, periodBounds, { fallbackDate: resolveOpportunityWonDate(p) || p.fecha_creacion })) {
                    flowFacturacionEmitidaCents += facMontoCents;
                    flowFacturasEmitidasCount += 1;
                }

                let facCobrosMonCents = 0;
                let facRetencionesCents = 0;
                const activePayments = (Array.isArray(fac.pagos) ? fac.pagos : []).filter(isActivePaymentRecord);

                for (const pay of activePayments) {
                    const payCents = toCents(pay.monto);
                    const payDate = pay.fecha_aplicacion || pay.fecha;
                    const voucherDate = pay.fecha_comprobante_bancario || pay.fecha;

                    if (isRetentionPayment(pay)) {
                        facRetencionesCents += payCents;
                        pRetencionesCents += payCents;
                        if (isDateInPeriod(payDate, periodBounds, { fallbackDate: fac.fecha })) {
                            flowRetencionesAplicadasCents += payCents;
                        }
                    } else {
                        facCobrosMonCents += payCents;
                        pCobrosMonCents += payCents;
                        if (isDateInPeriod(payDate, periodBounds, { fallbackDate: fac.fecha })) {
                            flowCobrosMonetariosAplicadosCents += payCents;
                        }

                        // Registrar comprobante bancario (deduplicado por cliente + referencia bancaria)
                        const normRef = normalizePaymentReference(
                            pay.referencia_bancaria_unica || pay.ref_bancaria_base || pay.ref_normalizada || pay.ref || ''
                        );
                        const vKey = normRef
                            ? `BANK_${canonClientId || 'SIN_CLIENTE'}_${normRef}`
                            : `LEGACY_${p.id}_${fac.id}_${pay.id || pay.fecha || Math.random()}`;
                        const explicitVoucherCents = toCents(pay.importe_total_comprobante);

                        const curAll = allTimeBankVouchers.get(vKey) || {
                            clientId: canonClientId,
                            appliedSumCents: 0,
                            explicitTotalCents: 0,
                            voucherDate
                        };
                        curAll.appliedSumCents += payCents;
                        if (explicitVoucherCents > curAll.explicitTotalCents) {
                            curAll.explicitTotalCents = explicitVoucherCents;
                        }
                        if (!curAll.voucherDate && voucherDate) curAll.voucherDate = voucherDate;
                        allTimeBankVouchers.set(vKey, curAll);

                        if (isDateInPeriod(voucherDate, periodBounds, { fallbackDate: payDate || fac.fecha })) {
                            const curPer = periodBankVouchers.get(vKey) || {
                                clientId: canonClientId,
                                appliedSumCents: 0,
                                explicitTotalCents: 0,
                                voucherDate
                            };
                            curPer.appliedSumCents += payCents;
                            if (explicitVoucherCents > curPer.explicitTotalCents) {
                                curPer.explicitTotalCents = explicitVoucherCents;
                            }
                            periodBankVouchers.set(vKey, curPer);
                        }
                    }
                }

                const facTotalCobradoCents = facCobrosMonCents + facRetencionesCents;
                const facSaldoPendienteCents = Math.max(0, facMontoCents - facTotalCobradoCents);
                const facSaldoAFavorCents = Math.max(0, facTotalCobradoCents - facMontoCents);
                pSaldoCxCCents += facSaldoPendienteCents;
                pSaldoAFavorCents += facSaldoAFavorCents;

                if (facSaldoPendienteCents > 0) {
                    const aging = classifyInvoiceAging(fac, periodBounds.referenceYMD);
                    const bObj = agingBuckets[aging.bucket] || agingBuckets.sin_vencimiento_definido;
                    const invSummary = {
                        prospectId: p.id,
                        codigoProyecto: p.codigo || '',
                        proyecto: p.proyecto || '',
                        clientId: canonClientId,
                        invoiceId: fac.id,
                        numeroFactura: fac.numero || '',
                        fechaFactura: toYMD(fac.fecha),
                        fechaVencimiento: aging.dueDateYMD,
                        diasVencidos: aging.daysPastDue,
                        esMorosa: aging.esMorosa,
                        bucketAntiguedad: aging.bucket,
                        montoOriginal: fromCents(facMontoCents),
                        cobrosMonetariosAplicados: fromCents(facCobrosMonCents),
                        retencionesAplicadas: fromCents(facRetencionesCents),
                        saldoPendiente: fromCents(facSaldoPendienteCents)
                    };
                    bObj.count += 1;
                    bObj.montoCents += facSaldoPendienteCents;
                    bObj.facturas.push(invSummary);
                    pendingInvoicesDetail.push(invSummary);
                }
            }

            const pTotalCobradoCents = pCobrosMonCents + pRetencionesCents;
            const isWonOrPostclosing = p.estado === 'ganado' || p.postcierre_habilitado === true || pFacturadoCents > 0;
            const pSaldoPorFacturarCents = isWonOrPostclosing ? Math.max(0, totalContratadoCents - pFacturadoCents) : 0;

            if (isWonOrPostclosing) {
                stockVentasAdjudicadasSubtotalCents += subtotalCents;
                stockVentasAdjudicadasTotalCents += totalContratadoCents;
                stockSaldoPorFacturarCents += pSaldoPorFacturarCents;
            }
            stockFacturacionVigenteCents += pFacturadoCents;
            stockCobrosMonetariosAplicadosCents += pCobrosMonCents;
            stockRetencionesAplicadasCents += pRetencionesCents;
            stockCuentasPorCobrarVivasCents += pSaldoCxCCents;
            stockSaldosAFavorCents += pSaldoAFavorCents;

            if (isWonOrPostclosing || pFacturadoCents > 0 || pTotalCobradoCents > 0) {
                const cp = ensureClientPortfolio(canonClientId);
                if (isWonOrPostclosing) {
                    cp.ventasAdjudicadasTotalCents += totalContratadoCents;
                    cp.saldoPorFacturarCents += pSaldoPorFacturarCents;
                }
                if (pFacturadoCents > 0) {
                    cp.activeBilledProspectsCount += 1;
                }
                cp.facturacionVigenteCents += pFacturadoCents;
                cp.cobrosMonetariosAplicadosCents += pCobrosMonCents;
                cp.retencionesAplicadasCents += pRetencionesCents;
                cp.saldoPorCobrarCents += pSaldoCxCCents;
                cp.saldoAFavorCents += pSaldoAFavorCents;
            }

            if (pSaldoCxCCents > 0) {
                const cp = ensureClientPortfolio(canonClientId);
                cxcByOpportunity.push({
                    prospectId: p.id,
                    codigo: p.codigo || '',
                    proyecto: p.proyecto || '',
                    clientId: canonClientId,
                    clienteNombre: cp.clienteNombre,
                    facturacionVigente: fromCents(pFacturadoCents),
                    cobrosMonetariosAplicados: fromCents(pCobrosMonCents),
                    retencionesAplicadas: fromCents(pRetencionesCents),
                    saldoPorCobrar: fromCents(pSaldoCxCCents),
                    facturasPendientesCount: pendingInvoicesDetail.length,
                    facturasPendientes: pendingInvoicesDetail
                });
            }
        }

        // Procesar documentos de abonos bancarios (`bankDeposits` / `payment_refs`)
        let stockAbonosPendientesAplicarCents = 0;
        const clientsWithUnappliedDepositsMap = new Map();

        for (const dep of effectiveBankDeposits) {
            if (!dep || typeof dep !== 'object') continue;
            const st = evaluateBankDepositRecord(dep);
            if (!st.isActive) continue;

            const depCanonClientId = resolveCanonicalClientId(dep.clientId || (dep.aplicaciones && dep.aplicaciones[0] && dep.aplicaciones[0].clientId) || null);
            if (targetCanonicalClientId && depCanonClientId !== targetCanonicalClientId) {
                continue;
            }
            // Si hay filtro de vendedor o clasificación y no es filtro global, verificar si el abono pertenece a alguno de los clientes/oportunidades elegibles
            if ((filterVendedorId && filterVendedorId !== 'all') || (filterClasificacion && filterClasificacion !== 'all')) {
                const hasMatchingApp = st.activeApplications.some(a => eligibleProspects.some(ep => ep.id === a.prospectId));
                const hasMatchingClient = depCanonClientId && eligibleProspects.some(ep => resolveCanonicalClientId(ep.clientId) === depCanonClientId);
                if (!hasMatchingApp && !hasMatchingClient) continue;
            }

            const normRef = normalizePaymentReference(dep.normRef || dep.referencia_bancaria_unica || dep.ref || '');
            const vKey = normRef
                ? `BANK_${depCanonClientId || 'SIN_CLIENTE'}_${normRef}`
                : (dep.id || `DEP_${Math.random()}`);
            const voucherDate = dep.fecha_comprobante_bancario || dep.fecha || dep.fecha_registro_crm || dep.updatedAt;

            stockAbonosPendientesAplicarCents += st.availableCents;

            const curAll = allTimeBankVouchers.get(vKey) || {
                clientId: depCanonClientId || 'SIN_CLIENTE',
                appliedSumCents: 0,
                explicitTotalCents: 0,
                voucherDate
            };
            curAll.explicitTotalCents = Math.max(curAll.explicitTotalCents, st.originalCents);
            if (depCanonClientId) curAll.clientId = depCanonClientId;
            allTimeBankVouchers.set(vKey, curAll);

            if (isDateInPeriod(voucherDate, periodBounds)) {
                const curPer = periodBankVouchers.get(vKey) || {
                    clientId: depCanonClientId || 'SIN_CLIENTE',
                    appliedSumCents: 0,
                    explicitTotalCents: 0,
                    voucherDate
                };
                curPer.explicitTotalCents = Math.max(curPer.explicitTotalCents, st.originalCents);
                periodBankVouchers.set(vKey, curPer);
            }

            if (depCanonClientId) {
                const cp = ensureClientPortfolio(depCanonClientId);
                cp.abonosDisponiblesSinAsignarCents += st.availableCents;
            }

            if (st.availableCents > 0) {
                const cidKey = depCanonClientId || 'SIN_CLIENTE';
                const cp = ensureClientPortfolio(cidKey);
                if (!clientsWithUnappliedDepositsMap.has(cidKey)) {
                    clientsWithUnappliedDepositsMap.set(cidKey, {
                        clientId: cidKey,
                        clienteNombre: cp.clienteNombre,
                        saldoDisponibleTotalCents: 0,
                        abonosCount: 0,
                        abonos: []
                    });
                }
                const entry = clientsWithUnappliedDepositsMap.get(cidKey);
                entry.saldoDisponibleTotalCents += st.availableCents;
                entry.abonosCount += 1;
                entry.abonos.push({
                    abonoId: dep.id || vKey,
                    ref: dep.ref || normRef,
                    metodo: dep.metodo || 'transferencia',
                    fechaComprobante: toYMD(voucherDate),
                    importeOriginal: fromCents(st.originalCents),
                    totalAplicado: fromCents(st.appliedCents),
                    saldoDisponible: fromCents(st.availableCents),
                    estadoAbono: st.estadoAbono
                });
            }
        }

        let stockDineroRecibidoCents = 0;
        for (const v of allTimeBankVouchers.values()) {
            const amountCents = v.explicitTotalCents > 0
                ? Math.max(v.explicitTotalCents, v.appliedSumCents)
                : v.appliedSumCents;
            stockDineroRecibidoCents += amountCents;
            if (v.clientId && clientPortfolioMap.has(v.clientId)) {
                clientPortfolioMap.get(v.clientId).dineroRecibidoCents += amountCents;
            }
        }
        if (stockDineroRecibidoCents < stockCobrosMonetariosAplicadosCents + stockAbonosPendientesAplicarCents) {
            stockDineroRecibidoCents = stockCobrosMonetariosAplicadosCents + stockAbonosPendientesAplicarCents;
        }

        let flowDineroRecibidoCents = 0;
        for (const v of periodBankVouchers.values()) {
            const amountCents = v.explicitTotalCents > 0
                ? Math.max(v.explicitTotalCents, v.appliedSumCents)
                : v.appliedSumCents;
            flowDineroRecibidoCents += amountCents;
        }

        const stockCobrosAplicadosTotalCents = stockCobrosMonetariosAplicadosCents + stockRetencionesAplicadasCents;
        const flowCobrosAplicadosTotalCents = flowCobrosMonetariosAplicadosCents + flowRetencionesAplicadasCents;

        const pctCobranzaSobreFacturado = stockFacturacionVigenteCents > 0
            ? round2((stockCobrosAplicadosTotalCents / stockFacturacionVigenteCents) * 100)
            : 0;
        const pctCobranzaSobreContratado = stockVentasAdjudicadasTotalCents > 0
            ? round2((stockCobrosAplicadosTotalCents / stockVentasAdjudicadasTotalCents) * 100)
            : 0;

        // Cartera pendiente por cliente
        const carteraPendientePorCliente = Array.from(clientPortfolioMap.values())
            .map(cp => ({
                clientId: cp.clientId,
                clienteNombre: cp.clienteNombre,
                ventasAdjudicadasTotal: fromCents(cp.ventasAdjudicadasTotalCents),
                facturacionRegistradaVigente: fromCents(cp.facturacionVigenteCents),
                dineroRecibido: fromCents(Math.max(cp.dineroRecibidoCents, cp.cobrosMonetariosAplicadosCents + cp.abonosDisponiblesSinAsignarCents)),
                cobrosMonetariosAplicados: fromCents(cp.cobrosMonetariosAplicadosCents),
                retencionesAplicadas: fromCents(cp.retencionesAplicadasCents),
                cobrosAplicadosTotal: fromCents(cp.cobrosMonetariosAplicadosCents + cp.retencionesAplicadasCents),
                saldoPorCobrar: fromCents(cp.saldoPorCobrarCents),
                saldoAFavor: fromCents(cp.saldoAFavorCents),
                saldoPorFacturar: fromCents(cp.saldoPorFacturarCents),
                abonosPendientesDeAplicar: fromCents(cp.abonosDisponiblesSinAsignarCents),
                importePendienteDeAplicar: fromCents(cp.abonosDisponiblesSinAsignarCents + cp.saldoAFavorCents),
                activeBilledProspectsCount: cp.activeBilledProspectsCount,
                wonOpportunitiesCount: cp.wonOpportunitiesCount,
                esClienteHistorico: Boolean(cp.facturacionVigenteCents > 0 || (cp.cobrosMonetariosAplicadosCents + cp.retencionesAplicadasCents) > 0)
            }))
            .sort((a, b) => b.saldoPorCobrar - a.saldoPorCobrar || b.facturacionRegistradaVigente - a.facturacionRegistradaVigente);

        cxcByOpportunity.sort((a, b) => b.saldoPorCobrar - a.saldoPorCobrar);

        const clientesConAbonosDisponibles = Array.from(clientsWithUnappliedDepositsMap.values())
            .map(item => ({
                clientId: item.clientId,
                clienteNombre: item.clienteNombre,
                saldoDisponibleTotal: fromCents(item.saldoDisponibleTotalCents),
                abonosCount: item.abonosCount,
                abonos: item.abonos
            }))
            .sort((a, b) => b.saldoDisponibleTotal - a.saldoDisponibleTotal);

        // ---------------------------------------------------------------------
        // C. MÁRGENES PRESUPUESTADOS / ESTIMADOS (B5.5.3)
        // ---------------------------------------------------------------------
        const margenBrutoEstimadoPeriodCents = wonPeriodSubtotalCents - wonPeriodCostoPresupuestadoCents;
        const margenPctPeriod = wonPeriodSubtotalCents > 0
            ? round2((margenBrutoEstimadoPeriodCents / wonPeriodSubtotalCents) * 100)
            : 0;

        const margenBrutoEstimadoAllTimeCents = wonAllTimeSubtotalCents - wonAllTimeCostoPresupuestadoCents;
        const margenPctAllTime = wonAllTimeSubtotalCents > 0
            ? round2((margenBrutoEstimadoAllTimeCents / wonAllTimeSubtotalCents) * 100)
            : 0;

        // ---------------------------------------------------------------------
        // D. ANTIGÜEDAD DE CUENTAS POR COBRAR (B5.5.5)
        // ---------------------------------------------------------------------
        const antiguedadBuckets = {
            vigente_no_vencida: {
                count: agingBuckets.vigente_no_vencida.count,
                monto: fromCents(agingBuckets.vigente_no_vencida.montoCents),
                facturas: agingBuckets.vigente_no_vencida.facturas
            },
            '0_30': {
                count: agingBuckets['0_30'].count,
                monto: fromCents(agingBuckets['0_30'].montoCents),
                facturas: agingBuckets['0_30'].facturas
            },
            '31_60': {
                count: agingBuckets['31_60'].count,
                monto: fromCents(agingBuckets['31_60'].montoCents),
                facturas: agingBuckets['31_60'].facturas
            },
            '61_90': {
                count: agingBuckets['61_90'].count,
                monto: fromCents(agingBuckets['61_90'].montoCents),
                facturas: agingBuckets['61_90'].facturas
            },
            mas_90: {
                count: agingBuckets.mas_90.count,
                monto: fromCents(agingBuckets.mas_90.montoCents),
                facturas: agingBuckets.mas_90.facturas
            },
            sin_vencimiento_definido: {
                count: agingBuckets.sin_vencimiento_definido.count,
                monto: fromCents(agingBuckets.sin_vencimiento_definido.montoCents),
                facturas: agingBuckets.sin_vencimiento_definido.facturas
            }
        };

        const antiguedadCxC = {
            ...antiguedadBuckets,
            buckets: antiguedadBuckets,
            totalConVencimientoVencido: fromCents(
                agingBuckets['0_30'].montoCents +
                agingBuckets['31_60'].montoCents +
                agingBuckets['61_90'].montoCents +
                agingBuckets.mas_90.montoCents
            ),
            totalSinVencimientoDefinido: fromCents(agingBuckets.sin_vencimiento_definido.montoCents),
            totalVigenteNoVencida: fromCents(agingBuckets.vigente_no_vencida.montoCents),
            totalCxCViva: fromCents(stockCuentasPorCobrarVivasCents)
        };

        const stockVivoSummary = {
            ventasAdjudicadasSubtotal: fromCents(stockVentasAdjudicadasSubtotalCents),
            ventasAdjudicadasTotal: fromCents(stockVentasAdjudicadasTotalCents),
            ventasAdjudicadas: fromCents(stockVentasAdjudicadasTotalCents),
            facturacionRegistradaVigente: fromCents(stockFacturacionVigenteCents),
            facturacionRegistrada: fromCents(stockFacturacionVigenteCents),
            dineroEfectivamenteRecibido: fromCents(stockDineroRecibidoCents),
            dineroRecibido: fromCents(stockDineroRecibidoCents),
            cobrosAplicados: fromCents(stockCobrosAplicadosTotalCents),
            cobrosMonetariosAplicados: fromCents(stockCobrosMonetariosAplicadosCents),
            retencionesAplicadas: fromCents(stockRetencionesAplicadasCents),
            cuentasPorCobrarVivas: fromCents(stockCuentasPorCobrarVivasCents),
            saldoPorCobrar: fromCents(stockCuentasPorCobrarVivasCents),
            saldoFacturadoPendienteCobrar: fromCents(stockCuentasPorCobrarVivasCents),
            saldosAFavor: fromCents(stockSaldosAFavorCents),
            saldoAFavor: fromCents(stockSaldosAFavorCents),
            saldoPorFacturar: fromCents(stockSaldoPorFacturarCents),
            abonosPendientesDeAplicar: fromCents(stockAbonosPendientesAplicarCents),
            saldoAbonosDisponibles: fromCents(stockAbonosPendientesAplicarCents),
            importePendienteDeAplicar: fromCents(stockAbonosPendientesAplicarCents + stockSaldosAFavorCents)
        };

        const margenesSummary = {
            etiqueta: 'Margen Bruto Estimado (Presupuestado)',
            tipoCosto: 'presupuestado_comercial',
            esCostoRealFabricacion: false,
            esEstimadoPresupuestado: true,
            oportunidadesConCostoDirecto: wonWithCostoDirectoPeriodCount,
            oportunidadesConCostoDirectoHistorico: wonWithCostoDirectoAllTimeCount,
            margenBrutoPresupuestadoMonto: fromCents(margenBrutoEstimadoPeriodCents),
            margenBrutoPresupuestadoPct: margenPctPeriod,
            periodo: {
                ventasAdjudicadasSubtotal: fromCents(wonPeriodSubtotalCents),
                costosPresupuestados: fromCents(wonPeriodCostoPresupuestadoCents),
                margenBrutoEstimado: fromCents(margenBrutoEstimadoPeriodCents),
                porcentajeMargenEstimado: margenPctPeriod,
                oportunidadesConCostoDirecto: wonWithCostoDirectoPeriodCount
            },
            historico: {
                ventasAdjudicadasSubtotal: fromCents(wonAllTimeSubtotalCents),
                costosPresupuestados: fromCents(wonAllTimeCostoPresupuestadoCents),
                margenBrutoEstimado: fromCents(margenBrutoEstimadoAllTimeCents),
                porcentajeMargenEstimado: margenPctAllTime,
                oportunidadesConCostoDirecto: wonWithCostoDirectoAllTimeCount
            }
        };

        return {
            periodo: periodBounds,
            filtrosAplicados: {
                clientId: targetCanonicalClientId,
                vendedorId: filterVendedorId,
                gestorId: filterGestor,
                clasificacion: filterClasificacion,
                estado: filterEstado
            },
            inventarioOportunidades,
            comercial: {
                inventarioOportunidades,
                oportunidadesActivasCount: activeCount,
                oportunidadesGanadasCount: wonPeriodCount,
                oportunidadesPerdidasCount: lostPeriodCount,
                winRatePct: winRatePeriodPct,
                oportunidadesActivas: {
                    cantidad: activeCount,
                    valorEstimado: fromCents(activeNominalCents),
                    valorPonderado: fromCents(activeWeightedCents),
                    distribucionPorEtapa: stageDistribution,
                    distribucionClasificacion: classificationDistribution
                },
                oportunidadesGanadas: {
                    cantidadPeriodo: wonPeriodCount,
                    valorAdjudicadoSubtotalPeriodo: fromCents(wonPeriodSubtotalCents),
                    valorAdjudicadoTotalPeriodo: fromCents(wonPeriodTotalConIvaCents),
                    cantidadHistorica: wonAllTimeCount,
                    valorAdjudicadoSubtotalHistorico: fromCents(wonAllTimeSubtotalCents),
                    valorAdjudicadoTotalHistorico: fromCents(wonAllTimeTotalConIvaCents)
                },
                oportunidadesPerdidas: {
                    cantidadPeriodo: lostPeriodCount,
                    valorPerdidoPeriodo: fromCents(lostPeriodSubtotalCents),
                    porMotivoPeriodo: lostByReasonPeriod,
                    cantidadHistorica: lostAllTimeCount,
                    valorPerdidoHistorico: fromCents(lostAllTimeSubtotalCents)
                },
                winRate: {
                    periodoRatio: round2(winRatePeriodRatio),
                    periodoPorcentaje: winRatePeriodPct,
                    ganadasPeriodo: wonPeriodCount,
                    perdidasPeriodo: lostPeriodCount,
                    cerradasElegiblesPeriodo: totalClosedPeriod,
                    historicoRatio: round2(winRateAllTimeRatio),
                    historicoPorcentaje: winRateAllTimePct,
                    ganadasHistorico: wonAllTimeCount,
                    perdidasHistorico: lostAllTimeCount
                },
                ticketPromedio: {
                    subtotalPeriodo: ticketPromedioSubtotalPeriod,
                    totalConIvaPeriodo: ticketPromedioTotalPeriod,
                    subtotalHistorico: ticketPromedioSubtotalAllTime,
                    totalConIvaHistorico: ticketPromedioTotalAllTime
                },
                cicloComercial: {
                    promedioDiasPeriodo: cicloComercialPromedioDiasPeriod,
                    oportunidadesConFechasValidasPeriodo: cycleValidCountPeriod,
                    oportunidadesSinFechaCierreValidaPeriodo: cycleMissingDateCountPeriod,
                    promedioDiasHistorico: cicloComercialPromedioDiasAllTime,
                    oportunidadesConFechasValidasHistorico: cycleValidCountAllTime
                },
                recurrencia: {
                    oportunidadesGanadasCliente: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount : wonAllTimeCount,
                    totalWonOpportunities: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount : wonAllTimeCount,
                    esClienteRecurrente: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount >= 2 : recurringClientsCount > 0,
                    clientesRecurrentesCount: recurringClientsCount,
                    clientesConVentasCount: wonOppIdsByClientAllTime.size,
                    detallePorCliente: recurrenceByClient
                },
                recurrenciaPorCliente: {
                    oportunidadesGanadasCliente: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount : wonAllTimeCount,
                    totalWonOpportunities: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount : wonAllTimeCount,
                    esClienteRecurrente: singleClientRecurrenceCount !== null ? singleClientRecurrenceCount >= 2 : recurringClientsCount > 0,
                    clientesRecurrentesCount: recurringClientsCount,
                    clientesConVentasCount: wonOppIdsByClientAllTime.size,
                    detallePorCliente: recurrenceByClient
                }
            },
            financiero: {
                // Conceptos canónicos separados (Sección 2.1 y 2.3)
                ...stockVivoSummary,
                stockVivo: stockVivoSummary,
                porcentajeCobranzaSobreFacturado: pctCobranzaSobreFacturado,
                porcentajeCobranzaSobreContratado: pctCobranzaSobreContratado,
                carteraPendientePorCliente,
                distribucionCxCPorOportunidad: cxcByOpportunity,
                clientesConAbonosDisponibles
            },
            flujoPeriodo: {
                ventasAdjudicadasSubtotal: fromCents(wonPeriodSubtotalCents),
                ventasAdjudicadasTotal: fromCents(wonPeriodTotalConIvaCents),
                oportunidadesGanadasCount: wonPeriodCount,
                oportunidadesPerdidasCount: lostPeriodCount,
                facturacionEmitida: fromCents(flowFacturacionEmitidaCents),
                facturasEmitidasCount: flowFacturasEmitidasCount,
                dineroRecibido: fromCents(flowDineroRecibidoCents),
                cobrosMonetariosAplicados: fromCents(flowCobrosMonetariosAplicadosCents),
                retencionesAplicadas: fromCents(flowRetencionesAplicadasCents),
                cobrosAplicadosTotal: fromCents(flowCobrosAplicadosTotalCents)
            },
            stockVigente: {
                pipelineActivoCount: activeCount,
                pipelineActivoNominal: fromCents(activeNominalCents),
                pipelineActivoPonderado: fromCents(activeWeightedCents),
                facturacionRegistradaVigente: fromCents(stockFacturacionVigenteCents),
                cuentasPorCobrarActuales: fromCents(stockCuentasPorCobrarVivasCents),
                saldosAFavorActuales: fromCents(stockSaldosAFavorCents),
                saldoPorFacturarActual: fromCents(stockSaldoPorFacturarCents),
                abonosNoAplicadosActuales: fromCents(stockAbonosPendientesAplicarCents),
                importePendienteAplicarActual: fromCents(stockAbonosPendientesAplicarCents + stockSaldosAFavorCents)
            },
            margenes: margenesSummary,
            margenPresupuestado: margenesSummary,
            antiguedadCxC
        };
    }

    return {
        toCents,
        fromCents,
        round2,
        normalizePaymentReference,
        isActiveInvoice,
        isActivePaymentRecord,
        isRetentionPayment,
        isBankMonetaryPayment,
        resolvePeriodBounds,
        isDateInPeriod,
        evaluateBankDepositRecord,
        classifyInvoiceAging,
        computeBIMetrics
    };
});
