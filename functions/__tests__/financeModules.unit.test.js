// functions/__tests__/financeModules.unit.test.js
// UNIT TEST SUITE: DUCTSAL ERP — Phase 6.4 Finance, Invoicing and Collections Modules
// Tests all 7 modules in modules/finance/ directly:
// 1. finance_calculations.js
// 2. finance_change_orders.js
// 3. finance_invoicing.js
// 4. finance_payments.js
// 5. finance_contracts.js
// 6. finance_controller.js
// 7. finance_ui.js

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const FinanceCalculations = require(path.join(ROOT, 'modules', 'finance', 'finance_calculations.js'));
const FinanceChangeOrders = require(path.join(ROOT, 'modules', 'finance', 'finance_change_orders.js'));
const FinanceInvoicing = require(path.join(ROOT, 'modules', 'finance', 'finance_invoicing.js'));
const FinancePayments = require(path.join(ROOT, 'modules', 'finance', 'finance_payments.js'));
const FinanceContracts = require(path.join(ROOT, 'modules', 'finance', 'finance_contracts.js'));
const FinanceController = require(path.join(ROOT, 'modules', 'finance', 'finance_controller.js'));
const FinanceUI = require(path.join(ROOT, 'modules', 'finance', 'finance_ui.js'));

describe('Phase 6.4: Finance Subsystem Modules', () => {

  // =========================================================================
  // 1. FinanceCalculations
  // =========================================================================
  describe('1. FinanceCalculations', () => {
    test('getProjectSubtotal and getProjectCosto compute totals with change orders (aumento / disminucion)', () => {
      const p = {
        precio_cotizado: 10000,
        costo_venta: 6000,
        ordenes_cambio: [
          { id: 'OC1', tipo: 'aumento', precio: 2000, costo: 1200 },
          { id: 'OC2', tipo: 'disminucion', precio: 500, costo: 300 }
        ]
      };
      expect(FinanceCalculations.getProjectSubtotal(p)).toBe(11500);
      expect(FinanceCalculations.getProjectCosto(p)).toBe(6900);
    });

    test('isProjectFullyPaid handles standard clients (13% IVA) and export clients (0% IVA)', () => {
      const clientStandard = { id: 'C_STD', es_exportacion: false };
      const clientExport = { id: 'C_EXP', es_exportacion: true };

      FinanceCalculations.setDeps({
        getClients: () => [clientStandard, clientExport]
      });

      const pExport = {
        clientId: 'C_EXP',
        precio_cotizado: 10000,
        facturas: [{ id: 'F1', monto: 10000, pagos: [{ monto: 10000 }] }]
      };
      expect(FinanceCalculations.isProjectFullyPaid(pExport)).toBe(true);

      const pStdUnpaid = {
        clientId: 'C_STD',
        precio_cotizado: 10000, // total with IVA = 11,300
        facturas: [{ id: 'F1', monto: 10000, pagos: [{ monto: 10000 }] }] // paid 10,000 < 11,300
      };
      expect(FinanceCalculations.isProjectFullyPaid(pStdUnpaid)).toBe(false);

      const pStdPaid = {
        clientId: 'C_STD',
        precio_cotizado: 10000,
        facturas: [{ id: 'F1', monto: 11300, pagos: [{ monto: 11300 }] }]
      };
      expect(FinanceCalculations.isProjectFullyPaid(pStdPaid)).toBe(true);
    });

    test('calculateProjectFinancials computes comprehensive project metrics', () => {
      const client = { id: 'C1', es_exportacion: false };
      const p = {
        clientId: 'C1',
        precio_cotizado: 10000,
        costo_venta: 5000,
        ordenes_cambio: [{ id: 'OC1', tipo: 'aumento', precio: 1000, costo: 500 }],
        facturas: [
          { id: 'F1', monto: 6000, pagos: [{ monto: 4000 }] },
          { id: 'F2', monto: 4000, pagos: [{ monto: 1000 }] }
        ]
      };
      const fin = FinanceCalculations.calculateProjectFinancials(p, [client]);
      expect(fin.subtotal).toBe(11000);
      expect(fin.total).toBe(12430); // 11,000 * 1.13
      expect(fin.totalFacturado).toBe(10000);
      expect(fin.totalCobrado).toBe(5000);
      expect(fin.saldoCxC).toBe(5000);
      expect(fin.porFacturar).toBe(2430);
      expect(fin.margen).toBe(5500); // 11000 - 5500
      expect(fin.margenPct).toBe(50);
      expect(fin.pctCobrado).toBeCloseTo((5000 / 12430) * 100, 1);
    });

    test('calculateInvoiceStatus computes cobrado, saldo and isPaid flag', () => {
      const fac = {
        monto: 5000,
        pagos: [{ monto: 3000 }, { monto: 2000 }]
      };
      const st = FinanceCalculations.calculateInvoiceStatus(fac);
      expect(st.cobrado).toBe(5000);
      expect(st.saldo).toBe(0);
      expect(st.isPaid).toBe(true);
    });
  });

  // =========================================================================
  // 2. FinanceChangeOrders
  // =========================================================================
  describe('2. FinanceChangeOrders', () => {
    test('blocks vendedor role with alert in openChangeOrderModal, editChangeOrder, processChangeOrder, deleteChangeOrder', async () => {
      const alerts = [];
      FinanceChangeOrders.setDeps({
        getCurrentUser: () => ({ id: 'V1', role: 'vendedor' })
      });
      global.alert = (m) => alerts.push(m);

      FinanceChangeOrders.openChangeOrderModal();
      FinanceChangeOrders.editChangeOrder('OC1');
      await FinanceChangeOrders.processChangeOrder();
      await FinanceChangeOrders.deleteChangeOrder('OC1');

      expect(alerts).toHaveLength(4);
      expect(alerts.every(a => a.includes('Los vendedores tienen acceso financiero en modo solo lectura'))).toBe(true);
    });

    test('openChangeOrderModal resets form and opens modal for manager', () => {
      const els = {
        changeOrderForm: { resetCalled: false, reset() { this.resetCalled = true; } },
        'co-id-edit': { value: 'prev' },
        changeOrderModal: { style: {} }
      };
      global.document = { getElementById: (id) => els[id] };
      FinanceChangeOrders.setDeps({
        getCurrentUser: () => ({ id: 'M1', role: 'manager' })
      });

      FinanceChangeOrders.openChangeOrderModal();
      expect(els.changeOrderForm.resetCalled).toBe(true);
      expect(els['co-id-edit'].value).toBe('');
      expect(els.changeOrderModal.style.display).toBe('block');
    });
  });

  // =========================================================================
  // 3. FinanceInvoicing
  // =========================================================================
  describe('3. FinanceInvoicing', () => {
    test('blocks vendedor role with alert across all operations', async () => {
      const alerts = [];
      FinanceInvoicing.setDeps({
        getCurrentUser: () => ({ id: 'V1', role: 'vendedor' })
      });
      global.alert = (m) => alerts.push(m);

      FinanceInvoicing.showInvoiceForm();
      FinanceInvoicing.editInvoice('F1');
      await FinanceInvoicing.processInvoice();
      await FinanceInvoicing.deleteInvoice('F1');

      expect(alerts).toHaveLength(4);
      expect(alerts.every(a => a.includes('solo lectura'))).toBe(true);
    });

    test('deleteInvoice refuses deletion of index 0 (advance invoice)', async () => {
      const alerts = [];
      const calls = [];
      global.alert = (m) => alerts.push(m);
      global.confirm = () => true;

      FinanceInvoicing.setDeps({
        getCurrentUser: () => ({ id: 'M1', role: 'manager' }),
        getCurrentProspectId: () => 'P1',
        getProspects: () => [{
          id: 'P1',
          facturas: [
            { id: 'F0', numero: 'INV-001' },
            { id: 'F1', numero: 'INV-002' }
          ]
        }],
        runWorkflowOp: async (desc, fn) => { calls.push(desc); return await fn({}); }
      });

      await FinanceInvoicing.deleteInvoice('F0');
      expect(alerts[0]).toContain('la factura de anticipo (la primera) no puede ser eliminada');
      expect(calls).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. FinancePayments
  // =========================================================================
  describe('4. FinancePayments', () => {
    test('handlePaymentMethodChange calculates 1% retention for Grandes Contribuyentes', () => {
      const els = {
        'pay-metodo': { value: 'retencion_1pct' },
        'pay-invoice-id': { value: 'F1' },
        'pay-monto-nuevo': { value: '', dataset: { invoiceTotal: 11300 } }
      };
      global.document = { getElementById: (id) => els[id] };

      FinancePayments.handlePaymentMethodChange();
      expect(els['pay-monto-nuevo'].value).toBe('113.00'); // 1% of 11300
    });

    test('blocks vendedor role with alert across all operations', async () => {
      const alerts = [];
      FinancePayments.setDeps({
        getCurrentUser: () => ({ id: 'V1', role: 'vendedor' })
      });
      global.alert = (m) => alerts.push(m);

      FinancePayments.showPaymentForm('F1', 'INV-1');
      FinancePayments.editPayment('F1', 0);
      await FinancePayments.processPayment();
      await FinancePayments.deletePayment('F1', 0);

      expect(alerts).toHaveLength(4);
      expect(alerts.every(a => a.includes('solo lectura'))).toBe(true);
    });
  });

  // =========================================================================
  // 5. FinanceContracts
  // =========================================================================
  describe('5. FinanceContracts', () => {
    test('generarContrato validates client dossier and prompts to complete missing documents', () => {
      let openedDetailView = false;
      const alerts = [];
      global.alert = (m) => alerts.push(m);

      FinanceContracts.setDeps({
        getProspects: () => [{ id: 'P1', clientId: 'C_INCOMPLETE' }],
        getClients: () => [{ id: 'C_INCOMPLETE', tipo: 'persona', documentos: {} }],
        openClientDetailView: () => { openedDetailView = true; },
        getProjectSubtotal: () => 10000,
        alert: (m) => alerts.push(m)
      });

      FinanceContracts.generarContrato('P1');
      expect(openedDetailView).toBe(true);
      expect(alerts[0]).toContain('Faltan datos en el perfil del cliente para el contrato');
    });
  });

  // =========================================================================
  // 6. FinanceController
  // =========================================================================
  describe('6. FinanceController', () => {
    test('manages projPaymentFilter, projSortCol and projSortDir with toggles', () => {
      let listRendered = false;
      FinanceController.setDeps({
        renderProjectsList: () => { listRendered = true; },
        getDocument: () => ({ getElementById: () => null })
      });

      FinanceController.setProjPaymentFilter('pagados');
      expect(FinanceController.getProjPaymentFilter()).toBe('pagados');
      expect(listRendered).toBe(true);

      FinanceController.toggleProjSort('proyecto');
      expect(FinanceController.getProjSortCol()).toBe('proyecto');
      expect(FinanceController.getProjSortDir()).toBe('asc');

      FinanceController.toggleProjSort('proyecto');
      expect(FinanceController.getProjSortDir()).toBe('desc');
    });

    test('exposes specialized submodules through facade getters', () => {
      expect(FinanceController.calculations).toBeDefined();
      expect(FinanceController.invoicing).toBeDefined();
      expect(FinanceController.payments).toBeDefined();
      expect(FinanceController.changeOrders).toBeDefined();
      expect(FinanceController.contracts).toBeDefined();
      expect(FinanceController.ui).toBeDefined();
    });
  });

  // =========================================================================
  // 7. FinanceUI
  // =========================================================================
  describe('7. FinanceUI', () => {
    test('renderProjectsList strictly filters out projects of other vendors when user is vendedor', () => {
      const createdRows = [];
      const tbody = {
        innerHTML: '',
        appendChild(tr) { createdRows.push(tr); }
      };
      const els = {
        'proj-table-body': tbody,
        'count-proj-pendientes': {},
        'count-proj-pagados': {},
        'count-proj-todos': {},
        'proj-search-input': { value: '' }
      };
      const doc = {
        getElementById: (id) => els[id] || null,
        createElement: (tag) => ({ tagName: tag, innerHTML: '', style: {}, classList: { add() {}, remove() {} } })
      };

      FinanceUI.setDeps({
        getCurrentUser: () => ({ id: 'VENDEDOR_1', role: 'vendedor' }),
        getProspects: () => [
          { id: 'P_MY', vendedorId: 'VENDEDOR_1', estado: 'ganado', precio_cotizado: 5000, facturas: [] },
          { id: 'P_OTHER', vendedorId: 'VENDEDOR_2', estado: 'ganado', precio_cotizado: 9000, facturas: [] }
        ],
        getClients: () => [],
        getClientName: () => 'Cliente Test',
        hasEnteredPostclosing: () => true,
        isProjectFullyPaid: () => false,
        getProjectSubtotal: (p) => p.precio_cotizado || 0,
        getProjectCosto: () => 0,
        formatCurrency: (n) => `$${n}`,
        formatDate: () => '2026-10-31',
        escapeHtmlDoc: (s) => String(s || ''),
        getProjPaymentFilter: () => 'todos',
        getProjSortCol: () => 'proyecto',
        getProjSortDir: () => 'asc',
        openDetail: () => {},
        getDocument: () => doc
      });

      FinanceUI.renderProjectsList();
      // Only 1 row created for VENDEDOR_1, P_OTHER is isolated horizontally
      expect(createdRows).toHaveLength(1);
    });
  });

});
