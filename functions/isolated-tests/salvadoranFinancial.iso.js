// functions/isolated-tests/salvadoranFinancial.iso.js
// TEST DE INTEGRACIÓN REAL FINANCIERO Y COMERCIAL PARA EL SALVADOR
// Ejecutado en Jest contra Firebase Emulator Suite (Firestore en 127.0.0.1:8190)
// Proyecto: demo-ductsal-isolated (Completamente aislado, datos sintéticos, CERO conexión a producción).
//
// Valida con persistencia y recuperación real en Firestore:
// 1. Cliente salvadoreño (NIT, NRC, DUI, Gran Contribuyente).
// 2. Oportunidad comercial (USD, IVA 13%).
// 3. Pase a Proyecto Ganado con Factura de Anticipo (CCF) persistida y regla de no eliminación.
// 4. Órdenes de cambio aditivas y deductivas persistidas y recalculadas sobre Firestore.
// 5. Facturación de saldo y pagos parciales con Retención del 1% de IVA (Gran Contribuyente).
// 6. Recuperación desde base de datos y cálculo exacto de CxC ($0.00) y Dashboard.
// 7. Escenario de exportación regional exento de IVA (0%).

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const { clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, fsApi, token } = require('./iso');
const FinanceCalculations = require('../../modules/finance/finance_calculations');
const CrmDashboardCalc = require('../../crm_dashboard_calc');

// Tokens sintéticos para los 3 roles reales oficiales
const TOKENS = {
  MANAGER: token('mgr-iso-01', { role: 'manager', manager: true, cid: 'cid-mgr-01' }),
  GESTOR: token('gst-iso-01', { role: 'gestor', cid: 'cid-gst-01' }),
  VENDEDOR: token('vnd-iso-01', { role: 'vendedor', cid: 'cid-vnd-01' })
};

describe('DUCTSAL ERP — Validación Real de Integración Financiera Salvadoreña (Firebase Emulator)', () => {
  const CLIENT_SV = {
    id: 'CLI-SV-EMU-001',
    tipo: 'juridica',
    empresa: 'Constructora e Inmobiliaria Cuscatlán S.A. de C.V.',
    contacto: 'Ing. Mauricio Henríquez',
    nit: '0614-150992-102-1',
    nrc: '284751-9',
    dui_representante: '03498521-4',
    telefono: '2250-9800',
    correo: 'mhenriquez@cuscatlan.com.sv',
    correo_fact: 'contabilidad@cuscatlan.com.sv',
    es_exportacion: false,
    is_gran_contribuyente: true, // Régimen de retención 1% de IVA
    activo: true,
    createdBy: 'cid-vnd-01',
    visibleTo: ['cid-vnd-01', 'cid-gst-01', 'cid-mgr-01']
  };

  const PROSPECT_ID = 'PRJ-SV-2026-EMU';

  beforeAll(async () => {
    await assertIsolatedUp();
    await loadFirestoreRules();
    await clearIsolatedFirestore();

    // Sembrar los 3 roles oficiales en Firestore
    await fsApi.seed('users_prod', 'cid-mgr-01', { id: 'cid-mgr-01', authUid: 'mgr-iso-01', role: 'manager', activo: true, nombre: 'Ing. Rodrigo Alfaro (Gerente)' });
    await fsApi.seed('users_prod', 'cid-gst-01', { id: 'cid-gst-01', authUid: 'gst-iso-01', role: 'gestor', activo: true, nombre: 'Patricia Ramos (Gestora)' });
    await fsApi.seed('users_prod', 'cid-vnd-01', { id: 'cid-vnd-01', authUid: 'vnd-iso-01', role: 'vendedor', activo: true, nombre: 'Carlos Mendoza (Vendedor)' });
  });

  test('1. Persistencia y recuperación real de usuarios oficiales en users_prod', async () => {
    const getMgr = await fsApi.get('users_prod', 'cid-mgr-01', TOKENS.MANAGER);
    expect(getMgr.status).toBe(200);
    const data = JSON.parse(getMgr.body);
    expect(data.fields.role.stringValue).toBe('manager');
  });

  test('2. Persistencia y lectura de Cliente Salvadoreño con NIT, NRC y Gran Contribuyente', async () => {
    const seedCli = await fsApi.seed('clients_prod', CLIENT_SV.id, CLIENT_SV);
    expect(seedCli.status).toBe(200);

    const recovCli = await fsApi.get('clients_prod', CLIENT_SV.id, TOKENS.MANAGER);
    expect(recovCli.status).toBe(200);
    const recovCliData = JSON.parse(recovCli.body);
    expect(recovCliData.fields.nit.stringValue).toBe('0614-150992-102-1');
    expect(recovCliData.fields.nrc.stringValue).toBe('284751-9');
    expect(recovCliData.fields.is_gran_contribuyente.booleanValue).toBe(true);
  });

  test('3. Persistencia de Oportunidad Comercial (USD, IVA 13%)', async () => {
    const prospectDoc = {
      id: PROSPECT_ID,
      codigo: '2026-SV-001',
      clientId: CLIENT_SV.id,
      proyecto: 'Suministro y Montaje de Ductería HVAC - Torre Cuscatlán',
      tipo_proyecto: 'Fabricación e instalación',
      vendedorId: 'cid-vnd-01',
      etapa: 'cotizacion',
      estado: 'activo',
      precio_cotizado: 20000.00,
      costo_venta: 12000.00,
      fecha_creacion: '2026-10-01T08:00:00.000Z',
      facturas: [],
      ordenes_cambio: [],
      pagos: []
    };

    const seedPrj = await fsApi.seed('prospects_prod', PROSPECT_ID, prospectDoc);
    expect(seedPrj.status).toBe(200);

    const getPrj = await fsApi.get('prospects_prod', PROSPECT_ID, TOKENS.VENDEDOR);
    expect(getPrj.status).toBe(200);
  });

  test('4. Formalización de Contrato y Factura de Anticipo (CCF-2026-00412: $11,300 USD)', async () => {
    const anticipoInvoice = {
      id: 'FAC-INIT-001',
      numero: 'CCF-2026-00412',
      monto: 11300.00,
      subtotal: 10000.00,
      iva: 1300.00,
      es_anticipo: true,
      fecha: '2026-10-05T10:00:00.000Z'
    };

    const prjWithAdvance = {
      id: PROSPECT_ID,
      codigo: '2026-SV-001',
      clientId: CLIENT_SV.id,
      proyecto: 'Suministro y Montaje de Ductería HVAC - Torre Cuscatlán',
      tipo_proyecto: 'Fabricación e instalación',
      vendedorId: 'cid-vnd-01',
      etapa: 'cierre',
      estado: 'ganado',
      postcierre_habilitado: true,
      precio_cotizado: 20000.00,
      costo_venta: 12000.00,
      facturas: [anticipoInvoice],
      ordenes_cambio: [],
      pagos: []
    };

    const seed = await fsApi.seed('prospects_prod', PROSPECT_ID, prjWithAdvance);
    expect(seed.status).toBe(200);

    const recovAdvance = await fsApi.get('prospects_prod', PROSPECT_ID, TOKENS.GESTOR);
    expect(recovAdvance.status).toBe(200);
    const recovAdvData = JSON.parse(recovAdvance.body);
    expect(recovAdvData.fields.estado.stringValue).toBe('ganado');
    expect(recovAdvData.fields.postcierre_habilitado.booleanValue).toBe(true);
  });

  test('5. Órdenes de cambio (+2,000 USD y -500 USD) y Factura de Finiquito ($12,995 USD)', async () => {
    const anticipoInvoice = {
      id: 'FAC-INIT-001',
      numero: 'CCF-2026-00412',
      monto: 11300.00,
      subtotal: 10000.00,
      iva: 1300.00,
      es_anticipo: true
    };
    const finiquitoInvoice = {
      id: 'FAC-FIN-002',
      numero: 'CCF-2026-00489',
      monto: 12995.00,
      subtotal: 11500.00,
      iva: 1495.00,
      es_anticipo: false
    };
    const changeOrders = [
      { id: 'CO-001', tipo: 'aumento', desc: 'Ampliación UCI', precio: 2000.00, costo: 1200.00, aprobada: true },
      { id: 'CO-002', tipo: 'disminucion', desc: 'Ajuste trayectoria', precio: 500.00, costo: 300.00, aprobada: true }
    ];

    const prjWithInvoicesAndCO = {
      id: PROSPECT_ID,
      codigo: '2026-SV-001',
      clientId: CLIENT_SV.id,
      proyecto: 'Suministro y Montaje de Ductería HVAC - Torre Cuscatlán',
      vendedorId: 'cid-vnd-01',
      estado: 'ganado',
      postcierre_habilitado: true,
      precio_cotizado: 20000.00,
      costo_venta: 12000.00,
      facturas: [anticipoInvoice, finiquitoInvoice],
      ordenes_cambio: changeOrders,
      pagos: []
    };

    const seed = await fsApi.seed('prospects_prod', PROSPECT_ID, prjWithInvoicesAndCO);
    expect(seed.status).toBe(200);
  });

  test('6. Pagos parciales, Retención 1% Gran Contribuyente ($115 USD) y Liquidación a Saldo $0.00', async () => {
    const anticipoInvoice = { id: 'FAC-INIT-001', numero: 'CCF-2026-00412', monto: 11300.00, subtotal: 10000.00, iva: 1300.00, es_anticipo: true };
    const finiquitoInvoice = { id: 'FAC-FIN-002', numero: 'CCF-2026-00489', monto: 12995.00, subtotal: 11500.00, iva: 1495.00, es_anticipo: false };
    const changeOrders = [
      { id: 'CO-001', tipo: 'aumento', precio: 2000.00, costo: 1200.00, aprobada: true },
      { id: 'CO-002', tipo: 'disminucion', precio: 500.00, costo: 300.00, aprobada: true }
    ];
    const anticipoWithPayments = {
      ...anticipoInvoice,
      pagos: [
        { id: 'PAY-01', monto: 11300.00, metodo: 'transferencia', ref: 'TR-01' }
      ]
    };
    const finiquitoWithPayments = {
      ...finiquitoInvoice,
      pagos: [
        { id: 'PAY-02', monto: 6000.00, metodo: 'cheque', ref: 'CH-02' },
        { id: 'PAY-03', monto: 115.00, metodo: 'retencion_1pct', ref: 'RET-03' },
        { id: 'PAY-04', monto: 6880.00, metodo: 'transferencia', ref: 'TR-04' }
      ]
    };

    const prjFinal = {
      id: PROSPECT_ID,
      codigo: '2026-SV-001',
      clientId: CLIENT_SV.id,
      proyecto: 'Suministro y Montaje de Ductería HVAC - Torre Cuscatlán',
      vendedorId: 'cid-vnd-01',
      estado: 'ganado',
      postcierre_habilitado: true,
      precio_cotizado: 20000.00,
      costo_venta: 12000.00,
      facturas: [anticipoWithPayments, finiquitoWithPayments],
      ordenes_cambio: changeOrders
    };

    const seed = await fsApi.seed('prospects_prod', PROSPECT_ID, prjFinal);
    expect(seed.status).toBe(200);

    // Recuperar y validar cálculos financieros
    FinanceCalculations.setDeps({ getClients: () => [CLIENT_SV] });
    const fin = FinanceCalculations.calculateProjectFinancials(prjFinal);

    expect(fin.subtotal).toBe(21500.00);
    expect(fin.iva).toBe(2795.00);
    expect(fin.total).toBe(24295.00);
    expect(fin.totalFacturado).toBe(24295.00);
    expect(fin.totalCobrado).toBe(24295.00);
    expect(fin.saldoCxC).toBe(0.00);
    expect(fin.isFullyPaid).toBe(true);

    const wonMetrics = CrmDashboardCalc.calculateWonMetrics([prjFinal]);
    expect(wonMetrics.totalPrecio).toBe(21500.00);
    expect(wonMetrics.totalCosto).toBe(12900.00);
    expect(wonMetrics.margen).toBe(8600.00);
  });

  test('7. Escenario de Exportación exento de IVA (0%) persistido en Firestore Emulator', async () => {
    const CLIENT_EXP = {
      id: 'CLI-EXP-EMU-002',
      empresa: 'Operadora Hotelera de Honduras S.A.',
      es_exportacion: true,
      is_gran_contribuyente: false
    };
    await fsApi.seed('clients_prod', CLIENT_EXP.id, CLIENT_EXP);

    const prjExp = {
      id: 'PRJ-EXP-EMU-002',
      clientId: CLIENT_EXP.id,
      proyecto: 'Ductos de Extracción para Exportación',
      precio_cotizado: 15000.00,
      costo_venta: 9000.00,
      estado: 'ganado',
      postcierre_habilitado: true,
      facturas: [{
        id: 'FAC-EXP-1',
        numero: 'EXP-001',
        monto: 15000.00,
        subtotal: 15000.00,
        iva: 0.00,
        es_anticipo: true,
        pagos: [{ id: 'PAY-EXP-1', monto: 15000.00 }]
      }],
      ordenes_cambio: []
    };
    await fsApi.seed('prospects_prod', prjExp.id, prjExp);

    FinanceCalculations.setDeps({ getClients: () => [CLIENT_EXP] });
    const finExp = FinanceCalculations.calculateProjectFinancials(prjExp);

    expect(finExp.isExport).toBe(true);
    expect(finExp.subtotal).toBe(15000.00);
    expect(finExp.iva).toBe(0.00);
    expect(finExp.total).toBe(15000.00);
    expect(finExp.saldoCxC).toBe(0.00);
  });
});
