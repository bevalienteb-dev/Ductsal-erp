// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: CONTROLLER (Fase 6.4)
// Archivo: modules/finance/finance_controller.js
// Responsabilidades:
// 1. Estado y coordinación del dominio financiero y de proyectos.
// 2. Filtros de pago (pendientes, pagados, todos) y ordenamiento de columnas.
// 3. Coordinación y fachada unificada para los módulos de cálculo, facturación,
//    pagos, órdenes de cambio, contratos y UI financiera.
// 4. Compatibilidad con el estado compartido del ERP y handlers globales.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceController = api;
        if (typeof window !== 'undefined') {
            window.FinanceController = api;
            window.getProjPaymentFilter = api.getProjPaymentFilter;
            window.setProjPaymentFilter = api.setProjPaymentFilter;
            window.toggleProjSort = api.toggleProjSort;
            window.updateProjSortIcons = api.updateProjSortIcons;
            window.getProjSortCol = api.getProjSortCol;
            window.setProjSortCol = api.setProjSortCol;
            window.getProjSortDir = api.getProjSortDir;
            window.setProjSortDir = api.setProjSortDir;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado local de Finanzas
    // -------------------------------------------------------------------------
    let _projPaymentFilter = 'pendientes';
    let _projSortCol = '';
    let _projSortDir = 'asc';

    // -------------------------------------------------------------------------
    // 2. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        renderProjectsList: () => {
            if (typeof FinanceUI !== 'undefined' && typeof FinanceUI.renderProjectsList === 'function') {
                return FinanceUI.renderProjectsList();
            }
            if (typeof renderProjectsList === 'function') {
                return renderProjectsList();
            }
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

    // -------------------------------------------------------------------------
    // 3. Métodos de Filtro de Pagos de Proyectos
    // -------------------------------------------------------------------------
    function getProjPaymentFilter() {
        return _projPaymentFilter;
    }

    function setProjPaymentFilter(filterKey) {
        if (['pendientes', 'pagados', 'todos'].includes(filterKey)) {
            _projPaymentFilter = filterKey;
            if (typeof window !== 'undefined') {
                window.projPaymentFilter = filterKey;
            }
            if (typeof _deps.renderProjectsList === 'function') {
                _deps.renderProjectsList();
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Métodos de Ordenamiento de Proyectos
    // -------------------------------------------------------------------------
    function getProjSortCol() {
        return _projSortCol;
    }

    function setProjSortCol(col) {
        _projSortCol = col || '';
        if (typeof window !== 'undefined') {
            window.projSortCol = _projSortCol;
        }
    }

    function getProjSortDir() {
        return _projSortDir;
    }

    function setProjSortDir(dir) {
        _projSortDir = dir === 'desc' ? 'desc' : 'asc';
        if (typeof window !== 'undefined') {
            window.projSortDir = _projSortDir;
        }
    }

    function toggleProjSort(column) {
        if (_projSortCol === column) {
            _projSortDir = _projSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            _projSortCol = column;
            _projSortDir = 'asc';
        }
        if (typeof window !== 'undefined') {
            window.projSortCol = _projSortCol;
            window.projSortDir = _projSortDir;
        }
        if (typeof _deps.renderProjectsList === 'function') {
            _deps.renderProjectsList();
        }
        updateProjSortIcons();
    }

    function updateProjSortIcons() {
        const doc = _deps.getDocument();
        if (!doc) return;
        const columns = ['codigo', 'cliente', 'proyecto', 'encargado', 'total', 'condicion', 'pctFacturado', 'pctCobrado'];
        columns.forEach(col => {
            const el = doc.getElementById(`sort-proj-${col}`);
            if (!el) return;
            if (_projSortCol === col) {
                el.innerHTML = _projSortDir === 'asc' ? '▲' : '▼';
                el.style.color = 'var(--brand-gold)';
            } else {
                el.innerHTML = '↕';
                el.style.color = 'var(--text-muted)';
            }
        });
    }

    // -------------------------------------------------------------------------
    // 5. API Pública y Fachada del Dominio Financiero
    // -------------------------------------------------------------------------
    return {
        // Estado y Filtros
        getProjPaymentFilter,
        setProjPaymentFilter,
        getProjSortCol,
        setProjSortCol,
        getProjSortDir,
        setProjSortDir,
        toggleProjSort,
        updateProjSortIcons,

        // Inyección de dependencias
        setDeps,

        // Submódulos especializados (getters dinámicos)
        get calculations() {
            return (typeof FinanceCalculations !== 'undefined') ? FinanceCalculations : null;
        },
        get invoicing() {
            return (typeof FinanceInvoicing !== 'undefined') ? FinanceInvoicing : null;
        },
        get payments() {
            return (typeof FinancePayments !== 'undefined') ? FinancePayments : null;
        },
        get changeOrders() {
            return (typeof FinanceChangeOrders !== 'undefined') ? FinanceChangeOrders : null;
        },
        get contracts() {
            return (typeof FinanceContracts !== 'undefined') ? FinanceContracts : null;
        },
        get ui() {
            return (typeof FinanceUI !== 'undefined') ? FinanceUI : null;
        }
    };
});
