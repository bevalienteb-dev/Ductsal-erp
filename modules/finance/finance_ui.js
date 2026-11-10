// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: UI (Fase 6.4)
// Archivo: modules/finance/finance_ui.js
// Responsabilidades:
// 1. Renderizado de la lista de proyectos y control de cobros (renderProjectsList).
// 2. Renderizado del panel financiero, órdenes de cambio, facturación y pagos (renderFinancials).
// 3. Manejo de alertas fiscales (Gran Contribuyente 1% retención, Exención IVA exportación).
// 4. Cumplimiento estricto del modo solo lectura financiero para vendedores.
// 5. Integración con DocumentViewer para documentos de facturas, órdenes de cambio y pagos.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceUI = api;
        if (typeof window !== 'undefined') {
            window.FinanceUI = api;
            window.renderProjectsList = api.renderProjectsList;
            window.renderFinancials = api.renderFinancials;
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
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getClientName: (id) => {
            if (typeof getClientName === 'function') return getClientName(id);
            if (typeof window !== 'undefined' && typeof window.getClientName === 'function') return window.getClientName(id);
            const clientsList = _deps.getClients();
            const c = clientsList.find(item => item.id === id);
            return c ? (c.nombre || c.empresa || id) : (id || '-');
        },
        hasEnteredPostclosing: (p) => {
            if (typeof hasEnteredPostclosing === 'function') return hasEnteredPostclosing(p);
            if (typeof window !== 'undefined' && typeof window.hasEnteredPostclosing === 'function') return window.hasEnteredPostclosing(p);
            return Boolean(p && (p.ganada === true || p.stage === 'cerrada_ganada' || p.estado === 'ganado' || p.fecha_cierre));
        },
        isProjectFullyPaid: (p) => {
            if (typeof FinanceCalculations !== 'undefined' && typeof FinanceCalculations.isProjectFullyPaid === 'function') {
                return FinanceCalculations.isProjectFullyPaid(p);
            }
            if (typeof isProjectFullyPaid === 'function') return isProjectFullyPaid(p);
            if (typeof window !== 'undefined' && typeof window.isProjectFullyPaid === 'function') return window.isProjectFullyPaid(p);
            return false;
        },
        getProjectSubtotal: (p) => {
            if (typeof FinanceCalculations !== 'undefined' && typeof FinanceCalculations.getProjectSubtotal === 'function') {
                return FinanceCalculations.getProjectSubtotal(p);
            }
            if (typeof getProjectSubtotal === 'function') return getProjectSubtotal(p);
            if (typeof window !== 'undefined' && typeof window.getProjectSubtotal === 'function') return window.getProjectSubtotal(p);
            return parseFloat(p?.precio_cotizado) || 0;
        },
        getProjectCosto: (p) => {
            if (typeof FinanceCalculations !== 'undefined' && typeof FinanceCalculations.getProjectCosto === 'function') {
                return FinanceCalculations.getProjectCosto(p);
            }
            if (typeof getProjectCosto === 'function') return getProjectCosto(p);
            if (typeof window !== 'undefined' && typeof window.getProjectCosto === 'function') return window.getProjectCosto(p);
            return parseFloat(p?.costo_venta) || 0;
        },
        formatCurrency: (val) => {
            if (typeof formatCurrency === 'function') return formatCurrency(val);
            if (typeof window !== 'undefined' && typeof window.formatCurrency === 'function') return window.formatCurrency(val);
            const n = parseFloat(val) || 0;
            return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        },
        formatDate: (val) => {
            if (typeof formatDate === 'function') return formatDate(val);
            if (typeof window !== 'undefined' && typeof window.formatDate === 'function') return window.formatDate(val);
            if (!val) return 'N/A';
            try {
                const d = new Date(val);
                return isNaN(d.getTime()) ? String(val) : d.toLocaleDateString('es-SV');
            } catch (e) {
                return String(val);
            }
        },
        escapeHtmlDoc: (str) => {
            if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
            if (str == null) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        getProjPaymentFilter: () => {
            if (typeof FinanceController !== 'undefined' && typeof FinanceController.getProjPaymentFilter === 'function') {
                return FinanceController.getProjPaymentFilter();
            }
            if (typeof getProjPaymentFilter === 'function') return getProjPaymentFilter();
            if (typeof window !== 'undefined' && typeof window.getProjPaymentFilter === 'function') return window.getProjPaymentFilter();
            if (typeof projPaymentFilter !== 'undefined') return projPaymentFilter;
            return 'pendientes';
        },
        getProjSortCol: () => {
            if (typeof FinanceController !== 'undefined' && typeof FinanceController.getProjSortCol === 'function') {
                return FinanceController.getProjSortCol();
            }
            if (typeof projSortCol !== 'undefined') return projSortCol;
            if (typeof window !== 'undefined' && typeof window.projSortCol !== 'undefined') return window.projSortCol;
            return '';
        },
        getProjSortDir: () => {
            if (typeof FinanceController !== 'undefined' && typeof FinanceController.getProjSortDir === 'function') {
                return FinanceController.getProjSortDir();
            }
            if (typeof projSortDir !== 'undefined') return projSortDir;
            if (typeof window !== 'undefined' && typeof window.projSortDir !== 'undefined') return window.projSortDir;
            return 'asc';
        },
        openDetail: (id) => {
            if (typeof openDetail === 'function') return openDetail(id);
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') return window.openDetail(id);
        },
        getDocument: () => {
            if (typeof document !== 'undefined') return document;
            return null;
        }
    };

    function setDeps(customDeps) {
        if (!customDeps || typeof customDeps !== 'object') return;
        Object.assign(_deps, customDeps);
    }

    function _evaluateFinancialMilestones(p, client) {
        if (typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.evaluateFinancialMilestones === 'function') {
            return CrmFollowUpCalc.evaluateFinancialMilestones(p, client);
        }
        if (typeof window !== 'undefined' && window.CrmFollowUpCalc && typeof window.CrmFollowUpCalc.evaluateFinancialMilestones === 'function') {
            return window.CrmFollowUpCalc.evaluateFinancialMilestones(p, client);
        }
        if (typeof require === 'function') {
            try {
                const calc = require('../../crm_followup_calc');
                if (calc && typeof calc.evaluateFinancialMilestones === 'function') {
                    return calc.evaluateFinancialMilestones(p, client);
                }
            } catch (e) { /* ignore fallback */ }
        }
        const terms = { '100% anticipado': 1.0, '70/30': 0.7, '50/50': 0.5 };
        const formaPago = p && typeof p.forma_pago === 'string' ? p.forma_pago.trim() : null;
        const pct = formaPago && Object.prototype.hasOwnProperty.call(terms, formaPago) ? terms[formaPago] : null;
        const basePrecio = parseFloat(p && p.precio_cotizado) || 0;
        const currentSubtotal = _deps.getProjectSubtotal(p);
        const subtotal = basePrecio > 0 ? (currentSubtotal > 0 ? Math.min(basePrecio, currentSubtotal) : basePrecio) : currentSubtotal;
        const isExport = Boolean(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
        const isGranContribuyente = Boolean(client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true'));
        const total = Math.round((isExport ? subtotal : subtotal * 1.13) * 100) / 100;
        const montoExigible = pct !== null ? Math.round(total * pct * 100) / 100 : 0;
        const facturas = Array.isArray(p && p.facturas) ? p.facturas : [];
        const activeFacturas = facturas.filter(f => f && !f.anulada && !f.eliminada && f.estado !== 'anulada' && parseFloat(f.monto) > 0 && f.numero);
        let advInv = activeFacturas.find(f => f.es_anticipo === true || String(f.tipo_factura || f.tipo || '').toLowerCase() === 'anticipo');
        if (!advInv && p && p.factura_anticipo_id) {
            advInv = activeFacturas.find(f => f.id === p.factura_anticipo_id && f.es_anticipo !== false);
        }
        if (!advInv && activeFacturas.length > 0 && activeFacturas[0].es_anticipo !== false && String(activeFacturas[0].tipo_factura || '').toLowerCase() !== 'ordinaria') {
            advInv = activeFacturas[0];
        }
        const ccfEmitido = Boolean(advInv && advInv.numero && advInv.doc_factura);
        const ccfNumero = ccfEmitido ? String(advInv.numero).trim() : null;
        const advMonto = advInv ? (Math.round(parseFloat(advInv.monto) * 100) / 100) : 0;
        let montoEfectivoConfirmado = 0;
        let montoRetencionBruta = 0;
        if (advInv && Array.isArray(advInv.pagos)) {
            advInv.pagos.forEach(pay => {
                if (!pay || pay.anulado === true || pay.eliminado === true || pay.revertido === true || pay.verificado === false || pay.confirmado === false || pay.estado === 'pendiente_verificacion') return;
                const isConfirmed = (pay.confirmado === true || pay.verificado === true || pay.estado === 'confirmado' || pay.estado === 'verificado') &&
                    Boolean((pay.confirmado_por_uid || pay.confirmado_por || pay.verificado_por_uid || pay.verificado_por) && (pay.confirmado_en || pay.verificado_en));
                if (!isConfirmed) return;
                const pm = parseFloat(pay.monto);
                if (isNaN(pm) || pm <= 0 || !pay.doc_comprobante) return;
                const metodo = String(pay.metodo || '').trim().toLowerCase();
                if (metodo === 'retencion_1pct') {
                    if (!client || (isGranContribuyente && !isExport)) montoRetencionBruta += pm;
                } else if (metodo === 'transferencia' || metodo === 'cheque') {
                    montoEfectivoConfirmado += pm;
                }
            });
        }
        montoEfectivoConfirmado = Math.round(montoEfectivoConfirmado * 100) / 100;
        const advBaseSinIva = advInv ? (isExport ? advMonto : Math.round((advMonto / 1.13) * 100) / 100) : 0;
        const maxRetencion = (advInv && (!client || (isGranContribuyente && !isExport)) && advBaseSinIva >= 100)
            ? Math.round(advBaseSinIva * 0.01 * 100) / 100
            : 0;
        const montoRetencionConfirmada = Math.round(Math.min(montoRetencionBruta, maxRetencion) * 100) / 100;
        const montoConfirmado = advInv ? Math.min(advMonto, Math.round((montoEfectivoConfirmado + montoRetencionConfirmada) * 100) / 100) : 0;
        const saldoPendienteAnticipo = Math.max(0, Math.round((montoExigible - montoConfirmado) * 100) / 100);
        const anticipoCumplido = Boolean(pct !== null && montoExigible > 0 && advInv && (advMonto + 0.009 >= montoExigible) && (montoConfirmado + 0.009 >= montoExigible));
        const anticipoPagoStatus = anticipoCumplido ? 'pagado' : (montoConfirmado > 0.009 ? 'parcialmente_pagado' : 'pendiente');
        const obligacionesSeguimiento = [];
        if (!ccfEmitido) obligacionesSeguimiento.push('Emitir CCF de anticipo y adjuntar respaldo fiscal.');
        if (!anticipoCumplido) {
            obligacionesSeguimiento.push(
                anticipoPagoStatus === 'parcialmente_pagado'
                    ? `Completar cobro de anticipo (faltan $${saldoPendienteAnticipo.toFixed(2)}).`
                    : `Registrar cobro confirmado del anticipo ($${montoExigible.toFixed(2)}).`
            );
        }
        return {
            formaPago,
            formaPagoValida: pct !== null,
            porcentajeAnticipo: pct,
            ccfAnticipoStatus: ccfEmitido ? 'emitido' : 'pendiente',
            ccfAnticipoNumero: ccfNumero,
            anticipoPagoStatus,
            montoExigible,
            montoConfirmado,
            montoEfectivoConfirmado,
            montoRetencionConfirmada,
            saldoPendienteAnticipo,
            anticipoCumplido,
            habilitadoFabricacion: Boolean(p && p.estado === 'ganado' && pct !== null && anticipoCumplido),
            obligacionesSeguimiento
        };
    }

    // -------------------------------------------------------------------------
    // 2. Renderizado de Proyectos y Control de Cobros
    // -------------------------------------------------------------------------
    function renderProjectsList() {
        const doc = _deps.getDocument();
        if (!doc) return;

        const curUser = _deps.getCurrentUser();
        const isVendedor = Boolean(curUser && curUser.role === 'vendedor');

        // Adapt view title and subtitle dynamically according to role
        const titleEl = doc.getElementById('projects-view-title');
        const descEl = doc.getElementById('projects-view-desc');
        if (titleEl) {
            titleEl.textContent = isVendedor ? 'Mis Proyectos y Cobros Asignados' : 'Proyectos y Control de Cobros';
        }
        if (descEl) {
            descEl.textContent = isVendedor
                ? 'Consulta de expedientes y estado financiero de tus proyectos asignados.'
                : 'Gestión operativa y financiera de proyectos y liquidación de cobros.';
        }

        const tbody = doc.getElementById('proj-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const prospectList = _deps.getProspects();
        let allProjects = prospectList.filter(p => _deps.hasEnteredPostclosing(p));

        // Vendedor restriction: isolated strictly to assigned projects (p.vendedorId === currentUserId)
        if (isVendedor) {
            const currentUserId = curUser?.id || curUser?.uid;
            allProjects = allProjects.filter(p => p.vendedorId === currentUserId);
        }

        const countPendientes = allProjects.filter(p => !_deps.isProjectFullyPaid(p)).length;
        const countPagados = allProjects.filter(p => _deps.isProjectFullyPaid(p)).length;
        const countTodos = allProjects.length;

        const elPendientes = doc.getElementById('count-proj-pendientes');
        if (elPendientes) elPendientes.textContent = countPendientes;
        const elPagados = doc.getElementById('count-proj-pagados');
        if (elPagados) elPagados.textContent = countPagados;
        const elTodos = doc.getElementById('count-proj-todos');
        if (elTodos) elTodos.textContent = countTodos;

        const activeFilter = _deps.getProjPaymentFilter();
        ['pendientes', 'pagados', 'todos'].forEach(key => {
            const btn = document.getElementById(`filter-proj-${key}`) || document.getElementById(`pill-proj-${key}`) || (doc && (doc.getElementById(`filter-proj-${key}`) || doc.getElementById(`pill-proj-${key}`)));
            if (btn) {
                if (key === activeFilter) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });

        if (allProjects.length === 0) {
            const emptyTitle = isVendedor
                ? 'No tienes proyectos cerrados / ganados asignados todavía'
                : 'No hay proyectos cerrados / ganados todavía';
            const emptyDesc = isVendedor
                ? 'Tus oportunidades ganadas ingresarán automáticamente a este módulo para consulta de facturas y cobros.'
                : 'Las oportunidades ganadas ingresarán automáticamente a este módulo.';
            tbody.innerHTML = `
                <tr>
                    <td colspan="9">
                        <div class="table-empty-box">
                            <div style="font-size:2rem; margin-bottom:0.4rem;">📊</div>
                            <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">${emptyTitle}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">${emptyDesc}</div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        let activeProjects = allProjects;
        if (activeFilter === 'pendientes') {
            activeProjects = allProjects.filter(p => !_deps.isProjectFullyPaid(p));
        } else if (activeFilter === 'pagados') {
            activeProjects = allProjects.filter(p => _deps.isProjectFullyPaid(p));
        }

        const clientsList = _deps.getClients();

        // Map projects to calculated objects for search and sort
        let mappedProjects = activeProjects.map(p => {
            const subtotal = _deps.getProjectSubtotal(p);
            const client = clientsList.find(c => c.id === p.clientId);
            const isExport = Boolean(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
            const total = isExport ? Math.round(subtotal * 100) / 100 : Math.round(subtotal * 1.13 * 100) / 100;
            const fullyPaid = _deps.isProjectFullyPaid(p);

            let totalFacturado = 0;
            let totalCobrado = 0;
            if (Array.isArray(p.facturas)) {
                p.facturas.forEach(f => {
                    const fm = parseFloat(f.monto);
                    if (!isNaN(fm) && fm > 0) totalFacturado += fm;
                    if (Array.isArray(f.pagos)) {
                        f.pagos.forEach(pay => {
                            const m = parseFloat(pay.monto);
                            if (!isNaN(m) && m > 0) totalCobrado += m;
                        });
                    }
                });
            }

            const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);
            const porFacturar = Math.max(0, Math.round((total - totalFacturado) * 100) / 100);

            const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
            const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;

            return {
                original: p,
                codigo: p.codigo || (p.id ? p.id.substring(p.id.length - 4) : '-'),
                cliente: _deps.getClientName(p.clientId),
                isExport: isExport,
                proyecto: p.proyecto || '',
                encargado: p.encargado || '',
                total: total,
                totalFacturado: totalFacturado,
                totalCobrado: totalCobrado,
                saldoCxC: saldoCxC,
                porFacturar: porFacturar,
                condicion: p.forma_pago || 'N/A',
                pctFacturado: pctFacturado,
                pctCobrado: pctCobrado,
                isFullyPaid: fullyPaid
            };
        });

        // Apply Search Filter
        const searchInput = doc.getElementById('proj-search');
        const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
        if (searchVal) {
            mappedProjects = mappedProjects.filter(mp => {
                return mp.codigo.toLowerCase().includes(searchVal) ||
                    mp.cliente.toLowerCase().includes(searchVal) ||
                    mp.proyecto.toLowerCase().includes(searchVal) ||
                    mp.encargado.toLowerCase().includes(searchVal) ||
                    mp.condicion.toLowerCase().includes(searchVal) ||
                    _deps.formatCurrency(mp.total).toLowerCase().includes(searchVal) ||
                    String(mp.total).includes(searchVal) ||
                    _deps.formatCurrency(mp.saldoCxC).toLowerCase().includes(searchVal) ||
                    String(mp.saldoCxC).includes(searchVal) ||
                    mp.pctFacturado.toFixed(0).includes(searchVal) ||
                    mp.pctCobrado.toFixed(0).includes(searchVal);
            });
        }

        // Apply Sorting
        const sortCol = _deps.getProjSortCol();
        const sortDir = _deps.getProjSortDir();
        if (sortCol) {
            mappedProjects.sort((a, b) => {
                let valA = a[sortCol];
                let valB = b[sortCol];

                if (typeof valA === 'string') {
                    return sortDir === 'asc'
                        ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                        : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
                } else {
                    return sortDir === 'asc' ? valA - valB : valB - valA;
                }
            });
        } else {
            mappedProjects.reverse();
        }

        if (mappedProjects.length === 0) {
            const filterMsg = activeFilter === 'pagados'
                ? 'No hay proyectos completamente pagados.'
                : (activeFilter === 'pendientes' ? 'No hay proyectos pendientes de cobro.' : 'No se encontraron proyectos.');
            tbody.innerHTML = `
                <tr>
                    <td colspan="9">
                        <div class="table-empty-box">
                            <div style="font-size:2rem; margin-bottom:0.4rem;">🔍</div>
                            <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">${filterMsg}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">
                                ${searchVal ? 'Prueba cambiando los términos de búsqueda o el filtro de cobro.' : 'Puedes alternar entre pendientes, pagados o todos con los filtros superiores.'}
                            </div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        mappedProjects.forEach(mp => {
            const p = mp.original;
            const tr = doc.createElement('tr');
            tr.classList.add('cursor-pointer');
            tr.onclick = () => _deps.openDetail(p.id);

            const exportBadge = mp.isExport ? ' <span class="badge" style="background:rgba(33, 150, 243, 0.15); color:#60a5fa; border:1px solid rgba(33, 150, 243, 0.35); font-size:0.68rem; margin-left:4px; vertical-align:middle;">✈️ Exp</span>' : '';
            const encargadoDisplay = mp.encargado
                ? `<div class="cell-ellipsis" style="max-width:115px; color:var(--text-primary);" title="${_deps.escapeHtmlDoc(mp.encargado)}">${_deps.escapeHtmlDoc(mp.encargado)}</div>`
                : '<span style="color:var(--text-muted); font-style:italic; font-size:0.8rem;">No asignado</span>';

            const cobradoColor = mp.isFullyPaid ? 'var(--success)' : (mp.pctCobrado > 0 ? '#60a5fa' : 'var(--text-muted)');
            const cobradoBadge = mp.isFullyPaid
                ? '<span class="badge" style="background:rgba(16, 185, 129, 0.2); color:#10b981; border:1px solid rgba(16, 185, 129, 0.4); font-size:0.65rem; padding:1px 5px; margin-left:4px;">100% Pagado</span>'
                : '';

            const cxcBadgeHtml = mp.saldoCxC > 0.009
                ? `<div class="proj-cxc-badge-wrap"><span class="proj-cxc-badge proj-cxc-due" title="Saldo vivo pendiente de cobro">Saldo: ${_deps.formatCurrency(mp.saldoCxC)}</span></div>`
                : (mp.totalFacturado > 0
                    ? `<div class="proj-cxc-badge-wrap"><span class="proj-cxc-badge proj-cxc-paid">✓ Al día / Pagado</span></div>`
                    : `<div class="proj-cxc-badge-wrap"><span class="proj-cxc-badge proj-cxc-neutral">Sin facturar</span></div>`);

            const ivaLabel = mp.isExport ? '✈️ Exento (0% IVA)' : '(Inc. IVA)';
            const pClient = clientsList.find(c => c.id === p.clientId);
            const fm = _evaluateFinancialMilestones(p, pClient);
            let advanceStatusBadgeHtml = '';
            if (fm && fm.formaPagoValida) {
                if (fm.anticipoPagoStatus === 'pagado') {
                    advanceStatusBadgeHtml = `<div style="margin-top:3px;"><span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-size:0.65rem; padding:1px 5px;" title="Anticipo 100% confirmado — Habilitado para fabricación">✓ Anticipo OK</span></div>`;
                } else if (fm.anticipoPagoStatus === 'parcialmente_pagado') {
                    advanceStatusBadgeHtml = `<div style="margin-top:3px;"><span class="badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); font-size:0.65rem; padding:1px 5px;" title="Anticipo parcialmente pagado — Faltan ${_deps.formatCurrency(fm.saldoPendienteAnticipo)}">⚠️ Anticipo Parcial</span></div>`;
                } else if (fm.ccfAnticipoStatus !== 'emitido') {
                    advanceStatusBadgeHtml = `<div style="margin-top:3px;"><span class="badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); font-size:0.65rem; padding:1px 5px;" title="Pendiente emitir CCF de anticipo y cobro">⏳ CCF / Anticipo Pend.</span></div>`;
                } else {
                    advanceStatusBadgeHtml = `<div style="margin-top:3px;"><span class="badge" style="background:rgba(239,68,68,0.18); color:#fca5a5; border:1px solid rgba(239,68,68,0.4); font-size:0.65rem; padding:1px 5px;" title="CCF emitido, cobro de anticipo pendiente (${_deps.formatCurrency(fm.montoExigible)})">🔒 Anticipo Pendiente</span></div>`;
                }
            }

            tr.innerHTML = `
                <td class="col-proj-code" style="white-space:nowrap;"><strong style="font-family:monospace; color:var(--brand-gold); font-size:0.82rem;">${_deps.escapeHtmlDoc(mp.codigo)}</strong></td>
                <td class="col-proj-client">
                    <div class="cell-ellipsis proj-client-wrap" style="max-width:145px; font-weight:600; color:white;" title="${_deps.escapeHtmlDoc(mp.cliente)}">
                        ${_deps.escapeHtmlDoc(mp.cliente)}${exportBadge}
                    </div>
                </td>
                <td class="col-proj-project">
                    <div class="cell-ellipsis proj-title-wrap" style="max-width:160px; color:var(--text-primary);" title="${_deps.escapeHtmlDoc(mp.proyecto)}">
                        ${_deps.escapeHtmlDoc(mp.proyecto || '-')}
                    </div>
                </td>
                <td class="col-proj-lead">${encargadoDisplay}</td>
                <td class="col-proj-total col-money" style="white-space:nowrap; text-align:right;">
                    <div class="proj-amount-wrap">
                        <div class="proj-amount-main">
                            <div class="proj-total-val">${_deps.formatCurrency(mp.total)}</div>
                            <div class="proj-total-iva">${ivaLabel}</div>
                        </div>
                        ${cxcBadgeHtml}
                    </div>
                </td>
                <td class="col-proj-condition"><span class="badge bg-neutral" style="font-size:0.75rem;">${_deps.escapeHtmlDoc(mp.condicion)}</span>${advanceStatusBadgeHtml}</td>
                <td class="col-proj-invoiced col-money" style="text-align:right;">
                    <div class="table-progress-wrap">
                        <div class="table-progress-header">
                            <span class="table-progress-label">Facturado</span>
                            <span class="table-progress-pct" style="color:#93c5fd;">${mp.pctFacturado.toFixed(0)}%</span>
                        </div>
                        <div class="table-progress-bar">
                            <div class="table-progress-fill-facturado" style="width:${Math.min(100, mp.pctFacturado)}%;"></div>
                        </div>
                        <div class="table-progress-amount">${_deps.formatCurrency(mp.totalFacturado)}</div>
                    </div>
                </td>
                <td class="col-proj-collected col-money" style="text-align:right;">
                    <div class="table-progress-wrap">
                        <div class="table-progress-header">
                            <span class="table-progress-label">Cobrado</span>
                            <div class="table-progress-pct-wrap">
                                <span class="table-progress-pct" style="color:${cobradoColor};">${mp.pctCobrado.toFixed(0)}%</span>
                                ${cobradoBadge}
                            </div>
                        </div>
                        <div class="table-progress-bar">
                            <div class="table-progress-fill-cobrado" style="width:${Math.min(100, mp.pctCobrado)}%;"></div>
                        </div>
                        <div class="table-progress-amount">${_deps.formatCurrency(mp.totalCobrado)}</div>
                    </div>
                </td>
                <td class="col-proj-action" style="text-align:right; white-space:nowrap;">
                    <button type="button" class="btn-table-action btn-table-edit" style="width:100%; justify-content:center;">
                        Gestionar ➔
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------------
    // 3. Renderizado del Panel Financiero del Proyecto
    // -------------------------------------------------------------------------
    function renderFinancials(p) {
        const doc = _deps.getDocument();
        if (!doc || !p) return;

        const currentUser = _deps.getCurrentUser();
        const isFinancialReadOnly = (currentUser && currentUser.role === 'vendedor');

        const clientsList = _deps.getClients();
        const client = clientsList.find(c => c.id === p.clientId);
        const isExport = Boolean(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
        const getProjectSubtotal = (proj) => _deps.getProjectSubtotal(proj);
        const subtotal = getProjectSubtotal(p);
        const iva = isExport ? 0 : subtotal * 0.13;
        const total = subtotal + iva;

        const costoTotal = _deps.getProjectCosto(p);
        const margen = subtotal - costoTotal;
        const margenPct = subtotal > 0 ? (margen / subtotal) * 100 : 0;

        const elPrecioOrig = doc.getElementById('fin-precio-original');
        if (elPrecioOrig) elPrecioOrig.textContent = _deps.formatCurrency(p.precio_cotizado || 0);

        const elCostoOrig = doc.getElementById('fin-costo-original');
        if (elCostoOrig) elCostoOrig.textContent = _deps.formatCurrency(p.costo_venta || 0);

        const ordContainer = doc.getElementById('fin-ordenes-container');
        const costContainer = doc.getElementById('fin-costos-ordenes-container');

        if (ordContainer) ordContainer.innerHTML = '';
        if (costContainer) costContainer.innerHTML = '';

        const btnAddCo = doc.getElementById('btn-add-co');
        if (btnAddCo) {
            btnAddCo.style.display = isFinancialReadOnly ? 'none' : 'flex';
        }

        // Advertencia de Retención 1% (Gran Contribuyente)
        const isGranContribuyente = Boolean(client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true'));
        const warningContainer = doc.getElementById('fin-retencion-warning');
        const invoicesListEl = doc.getElementById('invoices-list');
        if (isGranContribuyente) {
            if (!warningContainer && invoicesListEl && invoicesListEl.parentNode) {
                const warnDiv = doc.createElement('div');
                warnDiv.id = 'fin-retencion-warning';
                warnDiv.style.cssText = 'background-color: rgba(255, 193, 7, 0.15); border-left: 4px solid var(--brand-gold); padding: 10px; margin-bottom: 15px; border-radius: 4px; color: var(--brand-gold); font-size: 0.9rem;';
                warnDiv.innerHTML = `<strong>⚠️ Agente de Retención:</strong> Este cliente es Gran Contribuyente. Recuerda que el <strong>1% de cada factura</strong> quedará como saldo pendiente (CXC) hasta que se registre el <em>Comprobante de Retención</em> como pago.`;
                invoicesListEl.parentNode.insertBefore(warnDiv, invoicesListEl);
            } else if (warningContainer) {
                warningContainer.style.display = 'block';
            }
        } else if (warningContainer) {
            warningContainer.style.display = 'none';
        }

        // Advertencia de Cliente de Exportación (Sin IVA)
        const exportContainer = doc.getElementById('fin-export-warning');
        if (isExport) {
            if (!exportContainer && invoicesListEl && invoicesListEl.parentNode) {
                const expDiv = doc.createElement('div');
                expDiv.id = 'fin-export-warning';
                expDiv.style.cssText = 'background-color: rgba(33, 150, 243, 0.15); border-left: 4px solid #2196F3; padding: 10px; margin-bottom: 15px; border-radius: 4px; color: #64B5F6; font-size: 0.9rem;';
                expDiv.innerHTML = `<strong>✈️ Cliente de Exportación:</strong> Este cliente está exento de IVA (0% IVA). Los montos de facturación y cobro no incluyen impuesto.`;
                invoicesListEl.parentNode.insertBefore(expDiv, invoicesListEl);
            } else if (exportContainer) {
                exportContainer.style.display = 'block';
            }
        } else if (exportContainer) {
            exportContainer.style.display = 'none';
        }

        // Hitos financieros post-cierre (CCF de anticipo, Cobro de anticipo y Bloqueo de fabricación)
        const fm = _evaluateFinancialMilestones(p, client);
        let milestonesBanner = doc.getElementById('fin-advance-milestones-banner');
        if (fm && fm.formaPagoValida) {
            if (!milestonesBanner && invoicesListEl && invoicesListEl.parentNode) {
                milestonesBanner = doc.createElement('div');
                milestonesBanner.id = 'fin-advance-milestones-banner';
                invoicesListEl.parentNode.insertBefore(milestonesBanner, invoicesListEl);
            }
            if (milestonesBanner) {
                const ccfBadge = fm.ccfAnticipoStatus === 'emitido'
                    ? `<span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4);">✅ Emitido${fm.ccfAnticipoNumero ? ' (' + _deps.escapeHtmlDoc(fm.ccfAnticipoNumero) + ')' : ''}</span>`
                    : `<span class="badge" style="background:rgba(245,158,11,0.2); color:#fbbf24; border:1px solid rgba(245,158,11,0.4);">⏳ Pendiente de emisión</span>`;
                const antBadge = fm.anticipoPagoStatus === 'pagado'
                    ? `<span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4);">✅ Pagado (${_deps.formatCurrency(fm.montoConfirmado)} / ${_deps.formatCurrency(fm.montoExigible)})</span>`
                    : (fm.anticipoPagoStatus === 'parcialmente_pagado'
                        ? `<span class="badge" style="background:rgba(245,158,11,0.2); color:#fbbf24; border:1px solid rgba(245,158,11,0.4);">⚠️ Parcialmente pagado (${_deps.formatCurrency(fm.montoConfirmado)} de ${_deps.formatCurrency(fm.montoExigible)})</span>`
                        : `<span class="badge" style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid rgba(239,68,68,0.4);">⏳ Pendiente (${_deps.formatCurrency(fm.montoExigible)} exigible)</span>`);
                const fabBadge = fm.habilitadoFabricacion
                    ? `<span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4);">✅ Anticipo confirmado — Habilitado para fabricación</span>`
                    : `<span class="badge" style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid rgba(239,68,68,0.4);">🔒 Bloqueado para fabricación (Saldo anticipo: ${_deps.formatCurrency(fm.saldoPendienteAnticipo)})</span>`;
                const obligHtml = Array.isArray(fm.obligacionesSeguimiento) && fm.obligacionesSeguimiento.length > 0
                    ? `<div style="margin-top:8px; font-size:0.8rem; color:#fde68a;"><strong>Seguimiento financiero pendiente:</strong> ${fm.obligacionesSeguimiento.map(ob => _deps.escapeHtmlDoc(ob)).join(' • ')}</div>`
                    : '';
                const estadoHabilitacionCode = fm.habilitadoFabricacion ? 'ANTICIPO_CONFIRMADO' : 'ANTICIPO_PENDIENTE';
                const pendingUsdMsg = !fm.habilitadoFabricacion
                    ? `<div style="margin-top:6px; font-size:0.8rem; color:#fca5a5;"><strong>${estadoHabilitacionCode}:</strong> No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$${Number(fm.saldoPendienteAnticipo || 0).toFixed(2)}.</div>`
                    : '';
                const discrepancyHtml = p.discrepancia_financiera_fabricacion === true
                    ? `<div style="margin-top:6px; padding:6px 8px; border-radius:4px; background:rgba(239,68,68,0.18); border:1px solid rgba(239,68,68,0.45); color:#fecaca; font-size:0.79rem;"><strong>🚨 Discrepancia financiera post-liberación:</strong> Se eliminó o revirtió un abono de anticipo tras enviar a fabricación. Las órdenes en curso no se cancelan automáticamente, pero quedan bloqueadas nuevas liberaciones hasta cubrir el saldo pendiente.</div>`
                    : '';
                milestonesBanner.style.cssText = `background:rgba(15,23,42,0.75); border:1px solid ${fm.habilitadoFabricacion ? 'rgba(16,185,129,0.4)' : 'rgba(245,158,11,0.45)'}; border-radius:6px; padding:10px 12px; margin-bottom:14px; font-size:0.84rem;`;
                milestonesBanner.innerHTML = `
                    <div style="font-weight:700; color:var(--brand-gold); margin-bottom:6px;">📌 Control de Anticipo y Fabricación (${_deps.escapeHtmlDoc(fm.formaPago || '-')})</div>
                    <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
                        <div><span style="color:var(--text-secondary);">CCF Anticipo:</span> ${ccfBadge}</div>
                        <div><span style="color:var(--text-secondary);">Cobro Anticipo:</span> ${antBadge}</div>
                        <div><span style="color:var(--text-secondary);">Fabricación:</span> ${fabBadge}</div>
                    </div>
                    <div style="display:flex; flex-wrap:wrap; gap:14px; margin-top:8px; font-size:0.8rem; color:var(--text-secondary);">
                        <span><strong>Anticipo exigible:</strong> ${_deps.formatCurrency(fm.montoExigible)}</span>
                        <span><strong>Anticipo reconocido:</strong> ${_deps.formatCurrency(fm.montoConfirmado)}</span>
                        <span><strong>Saldo pendiente:</strong> ${_deps.formatCurrency(fm.saldoPendienteAnticipo)}</span>
                        <span><strong>Estado de habilitación:</strong> <code>${estadoHabilitacionCode}</code></span>
                    </div>
                    ${pendingUsdMsg}
                    ${discrepancyHtml}
                    ${obligHtml}
                `;
            }
        } else if (milestonesBanner) {
            milestonesBanner.style.display = 'none';
        }

        if (Array.isArray(p.ordenes_cambio) && p.ordenes_cambio.length > 0) {
            p.ordenes_cambio.forEach(o => {
                let sign = o.tipo === 'aumento' ? '+' : '-';
                let color = o.tipo === 'aumento' ? 'var(--brand-gold)' : 'var(--danger)';

                if (ordContainer) {
                    let ocDocLink = '';
                    if (o.doc_oferta) {
                        ocDocLink = `<span style="margin-left:5px;"><a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.ordenes_cambio?.find(oc => oc.id === '${o.id}')?.doc_oferta, 'Oferta OC', { prospectId: '${p.id}' })" style="color:var(--brand-gold); text-decoration:none; cursor:pointer;" title="Previsualizar">📄 Doc</a> <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.ordenes_cambio?.find(oc => oc.id === '${o.id}')?.doc_oferta, 'Oferta OC', { prospectId: '${p.id}' })" style="color:var(--text-secondary); margin-left:3px; font-size:0.75rem; text-decoration:none; cursor:pointer;" title="Descargar documento">⬇️</a></span>`;
                    }
                    const ocActionSpans = !isFinancialReadOnly
                        ? ` <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--brand-gold);" onclick="editChangeOrder('${o.id}')">[Editar]</span>
                            <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--danger);" onclick="deleteChangeOrder('${o.id}')">[Eliminar]</span>`
                        : '';
                    ordContainer.innerHTML += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; color:${color}; margin-top:2px;">
                        <span>↳ ${_deps.escapeHtmlDoc(o.desc)} ${ocDocLink}${ocActionSpans}</span> <span>${sign}${_deps.formatCurrency(o.precio)}</span>
                    </div>`;
                }
                if (costContainer) {
                    costContainer.innerHTML += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; color:${color}; margin-top:2px;">
                        <span>↳ ${_deps.escapeHtmlDoc(o.desc)}</span> <span>${sign}${_deps.formatCurrency(o.costo)}</span>
                    </div>`;
                }
            });
        }

        const elCostoTotal = doc.getElementById('fin-costo-total');
        if (elCostoTotal) elCostoTotal.textContent = _deps.formatCurrency(costoTotal);

        const margenEl = doc.getElementById('fin-margen');
        if (margenEl) {
            margenEl.textContent = _deps.formatCurrency(margen);
            margenEl.style.color = margen >= 0 ? 'var(--success)' : 'var(--danger)';
            const elMargenPct = doc.getElementById('fin-margen-pct');
            if (elMargenPct) {
                elMargenPct.textContent = `(${margenPct.toFixed(1)}%)`;
                elMargenPct.style.color = margen >= 0 ? 'var(--success)' : 'var(--danger)';
            }
        }

        let totalFacturado = 0;
        let totalCobrado = 0;

        const listDiv = doc.getElementById('invoices-list');
        if (listDiv) {
            listDiv.innerHTML = '';
        }

        if (!p.facturas) p.facturas = [];

        p.facturas.forEach((f, invoiceIndex) => {
            const fMonto = parseFloat(f.monto) || 0;
            totalFacturado += fMonto;
            let pCobrado = 0;
            let pEfectivo = 0;
            let pRetencion = 0;
            if (Array.isArray(f.pagos)) {
                f.pagos.forEach(b => {
                    const bm = parseFloat(b && b.monto) || 0;
                    if (bm > 0) {
                        pCobrado += bm;
                        if (b && b.metodo === 'retencion_1pct') {
                            pRetencion += bm;
                        } else {
                            pEfectivo += bm;
                        }
                    }
                });
            }
            totalCobrado += pCobrado;
            let pSaldo = fMonto - pCobrado;
            let isPaid = pSaldo <= 0.009;

            let pHistory = '';
            if (Array.isArray(f.pagos) && f.pagos.length > 0) {
                pHistory = `
                    <div class="invoice-payments-section">
                        <div class="invoice-payments-header">
                            <div class="invoice-payments-title">
                                <span style="color:var(--brand-gold); margin-right:6px;">💳</span>
                                <strong>Historial de Pagos de esta factura:</strong>
                            </div>
                            <span class="invoice-payments-counter">${f.pagos.length} ${f.pagos.length === 1 ? 'abono registrado' : 'abonos registrados'}</span>
                        </div>
                        <div class="invoice-payments-list">
                            ${f.pagos.map((pay, i) => {
                    let docLink = '';
                    if (pay.doc_comprobante) {
                        docLink = `<div class="payment-doc-chip">
                                        <a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.pagos?.[${i}]?.doc_comprobante, 'Comprobante', { prospectId: '${p.id}' })" class="btn-doc-link" title="Previsualizar comprobante">📄 Comprobante</a>
                                        <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.pagos?.[${i}]?.doc_comprobante, 'Comprobante', { prospectId: '${p.id}' })" class="btn-doc-dl" title="Descargar comprobante">⬇️</a>
                                    </div>`;
                    } else {
                        docLink = `<span class="pay-no-doc">Sin comprobante</span>`;
                    }
                    let lbl = pay.metodo === 'retencion_1pct' ? '<span class="badge badge-retencion" style="color:var(--brand-gold);">[Retención 1%]</span>' : '<span class="badge badge-abono">Abono:</span>';
                    let met = pay.metodo === 'retencion_1pct' ? 'Comprobante Fiscal' : (pay.metodo || 'N/A');
                    let editDelPaySpans = !isFinancialReadOnly
                        ? `<div class="payment-item-actions">
                                           <button type="button" class="btn-subtle-edit" onclick="editPayment('${f.id}', ${i})" title="Editar abono">✏️ [Editar]</button>
                                           <button type="button" class="btn-subtle-delete" onclick="deletePayment('${f.id}', ${i})" title="Eliminar abono">🗑️ [Eliminar]</button>
                                       </div>`
                        : '';
                    return `
                                    <div class="payment-item-card">
                                        <div class="pay-item-top">
                                            <div class="pay-item-main">
                                                <span class="pay-item-date">📅 ${_deps.formatDate(pay.fecha)}</span>
                                                ${lbl}
                                                <span class="pay-method-name">${_deps.escapeHtmlDoc(met)}</span>
                                                ${pay.ref ? `<span class="pay-reference">(Ref: <strong>${_deps.escapeHtmlDoc(pay.ref)}</strong>)</span>` : ''}
                                            </div>
                                            <div class="pay-item-amount-col">
                                                <span class="pay-amount-label">Monto</span>
                                                <strong class="pay-amount-val tabular-nums">${_deps.formatCurrency(pay.monto)}</strong>
                                            </div>
                                        </div>
                                        <div class="pay-item-bottom">
                                            <div class="pay-item-voucher-col">
                                                ${docLink}
                                            </div>
                                            ${editDelPaySpans}
                                        </div>
                                    </div>
                                `;
                }).join('')}
                        </div>
                    </div>
                `;
            }

            const invActionSpans = !isFinancialReadOnly
                ? `<button type="button" class="btn-subtle-edit" onclick="editInvoice('${f.id}')" title="Editar datos de la factura">✏️ [Editar Factura]</button>
                   ${invoiceIndex > 0
                    ? `<button type="button" class="btn-subtle-delete" onclick="deleteInvoice('${f.id}')" title="Eliminar factura e historial de pagos">🗑️ [Eliminar Factura]</button>`
                    : `<span class="badge-anticipo-lock" title="La factura de anticipo no puede ser eliminada">🔒 Anticipo</span>`}`
                : '';
            const btnAbonarHtml = (!isPaid && !isFinancialReadOnly)
                ? `<button type="button" class="btn-abono-primary" onclick="showPaymentForm('${f.id}', '${f.numero}')"><span style="margin-right:4px;">💰</span>+ Abonar a Factura</button>`
                : '';

            if (listDiv) {
                listDiv.innerHTML += `
                    <div class="invoice-card-modern">
                        <div class="invoice-card-header">
                            <div class="invoice-header-meta">
                                <strong class="invoice-number">${_deps.escapeHtmlDoc(f.numero)}</strong>
                                <span class="badge ${isPaid ? 'badge-invoice-paid' : 'badge-invoice-pending'}">${isPaid ? 'PAGADA' : 'PENDIENTE'}</span>
                                ${f.doc_factura ? `
                                    <div class="invoice-doc-chip">
                                        <a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.doc_factura, 'Factura ${_deps.escapeHtmlDoc(f.numero)}', { prospectId: '${p.id}' })" class="invoice-doc-link" title="Previsualizar factura digital">📄 ${typeof f.doc_factura === 'object' && f.doc_factura.name ? _deps.escapeHtmlDoc(f.doc_factura.name) : 'Factura PDF'}</a>
                                        <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.doc_factura, 'Factura ${_deps.escapeHtmlDoc(f.numero)}', { prospectId: '${p.id}' })" class="invoice-doc-dl" title="Descargar documento">⬇️</a>
                                    </div>` : ''}
                            </div>
                            <div class="invoice-header-actions">
                                ${btnAbonarHtml}
                                <div class="invoice-mgmt-actions">
                                    ${invActionSpans}
                                </div>
                            </div>
                        </div>
                        <div class="invoice-amounts-strip">
                            <div class="inv-strip-col">
                                <span class="inv-strip-label">Monto Facturado</span>
                                <span class="inv-strip-val fin-val-blue tabular-nums">${_deps.formatCurrency(f.monto)}</span>
                            </div>
                            <div class="inv-strip-col">
                                <span class="inv-strip-label">Total Abonado</span>
                                <span class="inv-strip-val fin-val-green tabular-nums">${_deps.formatCurrency(pCobrado)}</span>
                                ${pRetencion > 0 ? `<span style="display:block; font-size:0.72rem; color:var(--text-secondary);">Efectivo: ${_deps.formatCurrency(pEfectivo)} | Retención 1%: ${_deps.formatCurrency(pRetencion)}</span>` : ''}
                            </div>
                            <div class="inv-strip-col">
                                <span class="inv-strip-label">Saldo Pendiente</span>
                                <span class="inv-strip-val ${isPaid ? 'fin-val-green' : 'fin-val-danger'} tabular-nums" style="color:${isPaid ? '#34d399' : 'var(--danger)'};">${_deps.formatCurrency(Math.max(0, pSaldo))}</span>
                            </div>
                        </div>
                        ${pHistory}
                    </div>
                `;
            }
        });

        if (listDiv && p.facturas.length === 0) {
            listDiv.innerHTML = '<div style="text-align:center; padding: 1rem; color:var(--text-muted);">No hay facturas emitidas todavía.</div>';
        }

        const cxc = totalFacturado - totalCobrado;
        const porFacturar = total - totalFacturado;

        const elSubtotal = doc.getElementById('fin-subtotal');
        if (elSubtotal) elSubtotal.textContent = _deps.formatCurrency(subtotal);

        const elIva = doc.getElementById('fin-iva');
        if (elIva) elIva.textContent = isExport ? "$0 (0% Exportación)" : _deps.formatCurrency(iva);

        const elTotal = doc.getElementById('fin-total');
        if (elTotal) elTotal.textContent = _deps.formatCurrency(total);

        const elFacturado = doc.getElementById('fin-facturado');
        if (elFacturado) elFacturado.textContent = _deps.formatCurrency(totalFacturado);

        const elCobrado = doc.getElementById('fin-cobrado');
        if (elCobrado) elCobrado.textContent = _deps.formatCurrency(totalCobrado);

        const elSaldo = doc.getElementById('fin-saldo');
        if (elSaldo) elSaldo.textContent = _deps.formatCurrency(cxc);

        const elPorFacturar = doc.getElementById('fin-por-facturar');
        if (elPorFacturar) elPorFacturar.textContent = _deps.formatCurrency(porFacturar > 0 ? porFacturar : 0);

        const btnAddInvoice = doc.getElementById('btn-add-invoice');
        if (btnAddInvoice) {
            if (isFinancialReadOnly || totalFacturado >= (total - 0.1)) {
                btnAddInvoice.style.display = 'none';
                const invForm = doc.getElementById('invoice-form');
                if (invForm) invForm.style.display = 'none';
            } else {
                btnAddInvoice.style.display = 'inline-block';
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. API Pública
    // -------------------------------------------------------------------------
    return {
        renderProjectsList,
        renderFinancials,
        setDeps
    };
});
