// functions/__tests__/salvadoranFinancialE2E.unit.test.js
// TEST DE INTEGRACIÓN E2E FINANCIERO Y COMERCIAL PARA EL SALVADOR
// Contexto fiscal real de DUCTSAL:
// - Moneda de curso legal: Dólares de los Estados Unidos de América (USD, $)
// - Impuesto a la Transferencia de Bienes Muebles y a la Prestación de Servicios (IVA): 13%
// - Identificación tributaria salvadoreña: NIT (14 dígitos o 9 según DUI) y NRC (Número de Registro de Contribuyente)
// - Documentos de Personería Jurídica: Escritura de Constitución, Credencial de Elección de Junta Directiva, NIT, NRC y DUI del representante legal
// - Retención del 1% de IVA: Aplica exclusivamente a clientes clasificados como "Gran Contribuyente" en operaciones sujetas
// - Ciclo operativo: Cliente -> Oportunidad -> Cotización -> Proyecto Ganado -> Contrato -> Anticipo -> Facturas -> Órdenes de Cambio -> Pagos -> Dashboard

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const FinanceCalculations = require('../../modules/finance/finance_calculations');
const CrmDashboardCalc = require('../../crm_dashboard_calc');

const CLOCK = new Date('2026-10-31T12:00:00.000Z');
const URL_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/demo/o/';
const docFile = (name) => ({ name, url: `${URL_PREFIX}${name}?alt=media` });

describe('DUCTSAL ERP — Validación E2E Financiera y Comercial para El Salvador', () => {
  let fdb;
  let commercial;
  let wf;
  let opSeq = 0;
  const nextOpId = () => `op-sv-${Date.now()}-${++opSeq}`;

  // Actores del sistema
  const VENDOR = { uid: 'uid-vnd-01', cid: 'vnd_01', role: 'vendedor', name: 'Carlos Mendoza (Vendedor)' };
  const GESTOR = { uid: 'uid-gst-01', cid: 'gst_01', role: 'gestor', name: 'Patricia Ramos (Gestora)' };
  const MANAGER = { uid: 'uid-mgr-01', cid: 'mgr_01', role: 'manager', name: 'Ing. Rodrigo Alfaro (Gerente)' };

  // Cliente salvadoreño legalmente constituido en San Salvador
  const CLIENT_SALVADORENO = {
    id: 'CLI-SV-001',
    tipo: 'juridica',
    empresa: 'Constructora e Inmobiliaria Cuscatlán S.A. de C.V.',
    contacto: 'Ing. Mauricio Henríquez',
    nit: '0614-150992-102-1',
    nrc: '284751-9',
    telefono: '2250-9800',
    correo: 'mhenriquez@cuscatlan.com.sv',
    correo_fact: 'contabilidad@cuscatlan.com.sv',
    es_exportacion: false,
    is_gran_contribuyente: true, // Gran Contribuyente sujeto a retención 1% de IVA
    activo: true,
    createdBy: VENDOR.cid,
    visibleTo: [VENDOR.cid, GESTOR.cid, MANAGER.cid],
    documentos: {
      dui: docFile('dui_representante_legal.pdf'),
      escritura: docFile('escritura_constitucion_cuscatlan.pdf'),
      credencial: docFile('credencial_eleccion_junta.pdf'),
      nit: docFile('tarjeta_nit_empresa.pdf'),
      nrc: docFile('tarjeta_nrc_iva.pdf')
    }
  };

  beforeEach(async () => {
    fdb = createFakeFirestore({ clock: () => CLOCK });
    commercial = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => CLOCK,
      verifyManager: async (uid) => uid === MANAGER.uid
    });
    wf = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: commercial.kit
    });

    // Sembrar usuarios y cliente en Firestore en memoria
    await fdb.seed(`users_prod/${VENDOR.cid}`, { id: VENDOR.cid, authUid: VENDOR.uid, role: 'vendedor', activo: true, nombre: VENDOR.name });
    await fdb.seed(`users_prod/${GESTOR.cid}`, { id: GESTOR.cid, authUid: GESTOR.uid, role: 'gestor', activo: true, nombre: GESTOR.name });
    await fdb.seed(`users_prod/${MANAGER.cid}`, { id: MANAGER.cid, authUid: MANAGER.uid, role: 'manager', activo: true, nombre: MANAGER.name });
    await fdb.seed(`clients_prod/${CLIENT_SALVADORENO.id}`, CLIENT_SALVADORENO);
  });

  test('Ciclo Completo: Cotización USD -> 13% IVA -> Anticipo 50% -> Órdenes de Cambio (+/-) -> Retención 1% IVA -> Finiquito y Balance Cero', async () => {
    // -----------------------------------------------------------------------------------
    // 1. Oportunidad Comercial: Fabricación e instalación de ductos en lámina galvanizada
    // -----------------------------------------------------------------------------------
    const prospectId = 'PRJ-SV-2026-001';
    await fdb.seed(`prospects_prod/${prospectId}`, {
      id: prospectId,
      codigo: '2026-SV-001',
      clientId: CLIENT_SALVADORENO.id,
      proyecto: 'Suministro y Montaje de Ductería HVAC - Hospital San Rafael',
      tipo_proyecto: 'Fabricación e instalación',
      tipo_producto: 'Ducto',
      createdBy: VENDOR.cid,
      vendedorId: VENDOR.cid,
      etapa: 'prospecto',
      estado: 'activo',
      fecha_creacion: '2026-10-01T08:00:00.000Z',
      datos: {},
      facturas: [],
      ordenes_cambio: [],
      logs: []
    });

    // -----------------------------------------------------------------------------------
    // 2. Levantamiento Técnico en Obra
    // -----------------------------------------------------------------------------------
    const advLev = await wf.advanceStage({
      caller: VENDOR,
      prospectId,
      nextStage: 'levantamiento',
      data: {
        visitante: 'Arq. Jorge Guardado',
        distancia: 12.5, // 12.5 km desde planta en Santa Tecla / San Salvador
        ubicacion: 'Final 4a Calle Oriente, Santa Tecla',
        fecha_visita: '2026-10-03',
        doc_levantamiento: [docFile('levantamiento_medidas_planos.pdf')]
      }
    });
    expect(advLev.status).toBe('advanced');

    // -----------------------------------------------------------------------------------
    // 3. Cotización y Propuesta Comercial (Moneda USD, Tasa IVA 13%)
    // Valor neto base: $20,000.00 USD | Costo directo: $12,000.00 USD
    // -----------------------------------------------------------------------------------
    const precioCotizadoUSD = 20000.00;
    const costoVentaUSD = 12000.00;

    const advCot = await wf.advanceStage({
      caller: VENDOR,
      prospectId,
      nextStage: 'cotizacion',
      data: {
        costo_venta: costoVentaUSD,
        precio_cotizado: precioCotizadoUSD,
        probabilidad: 'alta', // 75%
        doc_oferta: [docFile('oferta_economica_hvac_san_rafael.pdf')],
        doc_costos: [docFile('hoja_costos_materia_prima_lamina.pdf')]
      }
    });
    expect(advCot.status).toBe('advanced');

    // Transición a Negociación (entrega formal de oferta al cliente)
    const advNeg = await wf.advanceStage({
      caller: VENDOR,
      prospectId,
      nextStage: 'negociacion',
      data: {
        costo_venta: costoVentaUSD,
        precio_cotizado: precioCotizadoUSD,
        probabilidad: 'alta',
        doc_oferta: [docFile('oferta_economica_hvac_san_rafael.pdf')],
        doc_costos: [docFile('hoja_costos_materia_prima_lamina.pdf')]
      }
    });
    expect(advNeg.status).toBe('advanced');

    // Transición a Cierre
    const advCie = await wf.advanceStage({
      caller: VENDOR,
      prospectId,
      nextStage: 'cierre',
      data: {
        forma_pago: '50/50', // 50% anticipo de fabricación, 50% finiquito contra entrega
        factura_anticipo: 'CCF-2026-00412', // Comprobante de Crédito Fiscal
        encargado: 'Ing. Mario Quintanilla (Jefe de Montaje)',
        doc_firmado: docFile('contrato_firmado_cuscatlan.pdf'),
        doc_comprobante: docFile('comprobante_transferencia_anticipo.pdf')
      }
    });
    expect(advCie.status).toBe('advanced');

    // -----------------------------------------------------------------------------------
    // 4. Formalización y Pase a Proyecto Ganado (Cálculo exacto del 13% IVA en USD)
    // Subtotal: $20,000.00 USD
    // IVA 13%:   $2,600.00 USD
    // Total:    $22,600.00 USD
    // Anticipo 50%: $11,300.00 USD
    // -----------------------------------------------------------------------------------
    const finalRes = await wf.finalizeProspect({
      caller: VENDOR,
      prospectId,
      data: {
        forma_pago: '50/50',
        factura_anticipo: 'CCF-2026-00412',
        encargado: 'Ing. Mario Quintanilla (Jefe de Montaje)',
        doc_firmado: docFile('contrato_firmado_cuscatlan.pdf'),
        doc_comprobante: docFile('comprobante_transferencia_anticipo.pdf')
      },
      opId: nextOpId()
    });

    expect(finalRes.status).toBe('finalized');
    expect(finalRes.montoAnticipo).toBe(11300.00); // 50% exacto de $22,600.00 USD

    const storedProject = await fdb.data(`prospects_prod/${prospectId}`);
    expect(storedProject.estado).toBe('ganado');
    expect(storedProject.postcierre_habilitado).toBe(true);
    expect(storedProject.facturas).toHaveLength(1);
    expect(storedProject.facturas[0].numero).toBe('CCF-2026-00412');
    expect(storedProject.facturas[0].monto).toBe(11300.00);

    // Regla de Negocio: La factura de anticipo no puede ser eliminada
    const advanceFacId = storedProject.facturas[0].id;
    await expect(wf.deleteInvoice({
      caller: GESTOR,
      prospectId,
      invoiceId: advanceFacId
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // -----------------------------------------------------------------------------------
    // 5. Órdenes de Cambio durante Ejecución de Obra:
    // a) Orden Aditiva: +$2,000.00 USD (Costo: $1,200 USD) -> "Ampliación de ductos para UCI Nivel 3"
    // b) Orden Deductiva: -$500.00 USD (Costo: $300 USD) -> "Ajuste de trayectoria ducto extracción"
    // Nuevo Subtotal: $20,000 + $2,000 - $500 = $21,500.00 USD
    // Nuevo IVA 13%: $21,500 * 0.13 = $2,795.00 USD
    // Nuevo Total Contratado: $24,295.00 USD
    // Techo Restante a Facturar: $24,295.00 - $11,300.00 = $12,995.00 USD
    // -----------------------------------------------------------------------------------
    const addOrderRes = await wf.saveChangeOrder({
      caller: GESTOR,
      prospectId,
      tipo: 'aumento',
      desc: 'Ampliación de ductos para UCI Nivel 3',
      precio: 2000.00,
      costo: 1200.00,
      doc_oferta: docFile('orden_cambio_01_aditiva.pdf'),
      doc_costos: docFile('costos_oc_01.pdf'),
      opId: nextOpId()
    });
    expect(addOrderRes.status).toBe('created');

    const subOrderRes = await wf.saveChangeOrder({
      caller: GESTOR,
      prospectId,
      tipo: 'disminucion',
      desc: 'Ajuste de trayectoria ducto extracción',
      precio: 500.00,
      costo: 300.00,
      doc_oferta: docFile('orden_cambio_02_deductiva.pdf'),
      doc_costos: docFile('costos_oc_02.pdf'),
      opId: nextOpId()
    });
    expect(subOrderRes.status).toBe('created');

    // -----------------------------------------------------------------------------------
    // 6. Facturación del Saldo Restante de Proyecto (Factura de Finiquito)
    // -----------------------------------------------------------------------------------
    // Intento inválido: Facturar por encima del techo restante ($12,995.01 USD) debe ser rechazado
    await expect(wf.saveInvoice({
      caller: GESTOR,
      prospectId,
      numero: 'CCF-2026-00489',
      monto: 12995.50,
      doc_factura: docFile('factura_finiquito.pdf'),
      opId: nextOpId()
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // Facturación legítima: $12,995.00 USD exactos
    const finalInvRes = await wf.saveInvoice({
      caller: GESTOR,
      prospectId,
      numero: 'CCF-2026-00489',
      monto: 12995.00,
      doc_factura: docFile('factura_finiquito.pdf'),
      opId: nextOpId()
    });
    expect(finalInvRes.status).toBe('created');

    // -----------------------------------------------------------------------------------
    // 7. Pagos, Amortización y Retención del 1% de IVA (Gran Contribuyente)
    // -----------------------------------------------------------------------------------
    // Pago 1: Liquidación completa del anticipo ($11,300.00 USD) vía transferencia
    const pay1 = await wf.savePayment({
      caller: GESTOR,
      prospectId,
      invoiceId: advanceFacId,
      monto: 11300.00,
      metodo: 'transferencia',
      ref: 'TR-BANCO-CUSCATLAN-99120',
      doc_comprobante: docFile('voucher_transferencia_anticipo.pdf'),
      opId: nextOpId()
    });
    expect(pay1.status).toBe('created');

    const finalFacId = finalInvRes.invoice.id;

    // Pago 2: Abono parcial a la factura de saldo por $6,000.00 USD vía cheque
    const pay2 = await wf.savePayment({
      caller: GESTOR,
      prospectId,
      invoiceId: finalFacId,
      monto: 6000.00,
      metodo: 'cheque',
      ref: 'CHEQUE-BANCO-AGRICOLA-3091',
      doc_comprobante: docFile('recibo_cheque_6000.pdf'),
      opId: nextOpId()
    });
    expect(pay2.status).toBe('created');
    // Saldo pendiente en factura final: $12,995.00 - $6,000.00 = $6,995.00 USD

    // Pago 3: Retención del 1% de IVA para Gran Contribuyente en El Salvador
    // Base imponible neta correspondiente a la factura final: $11,500.00 USD
    // 1% Retención IVA = $115.00 USD
    const pay3 = await wf.savePayment({
      caller: GESTOR,
      prospectId,
      invoiceId: finalFacId,
      monto: 115.00,
      metodo: 'retencion_1pct',
      ref: 'COMPROBANTE-RETENCION-MH-00912',
      doc_comprobante: docFile('comprobante_retencion_1pct_mh.pdf'),
      opId: nextOpId()
    });
    expect(pay3.status).toBe('created');
    // Saldo pendiente en factura final: $6,995.00 - $115.00 = $6,880.00 USD

    // Pago 4: Finiquito final restante ($6,880.00 USD) vía transferencia bancaria
    const pay4 = await wf.savePayment({
      caller: GESTOR,
      prospectId,
      invoiceId: finalFacId,
      monto: 6880.00,
      metodo: 'transferencia',
      ref: 'TR-BANCO-CUSCATLAN-99841',
      doc_comprobante: docFile('voucher_transferencia_finiquito.pdf'),
      opId: nextOpId()
    });
    expect(pay4.status).toBe('created');

    // -----------------------------------------------------------------------------------
    // 8. Verificación de Consistencia Financiera Integral (Módulos de Finanzas y Dashboard)
    // -----------------------------------------------------------------------------------
    const projectEndState = await fdb.data(`prospects_prod/${prospectId}`);

    FinanceCalculations.setDeps({ getClients: () => [CLIENT_SALVADORENO] });
    const financials = FinanceCalculations.calculateProjectFinancials(projectEndState);

    expect(financials.subtotal).toBe(21500.00); // $20,000 base + $2,000 OC1 - $500 OC2
    expect(financials.iva).toBe(2795.00);       // 13% exacto de $21,500.00 USD
    expect(financials.total).toBe(24295.00);     // $21,500 + $2,795
    expect(financials.totalFacturado).toBe(24295.00); // $11,300 anticipo + $12,995 finiquito
    expect(financials.totalCobrado).toBe(24295.00);   // $11,300 + $6,000 + $115 + $6,880
    expect(financials.saldoCxC).toBe(0.00);           // Saldo de cuentas por cobrar perfectamente liquidado
    expect(financials.isFullyPaid).toBe(true);
    expect(financials.pctCobrado).toBe(100);

    // Verificación en Dashboard Comercial y Gerencial
    const wonMetrics = CrmDashboardCalc.calculateWonMetrics([projectEndState]);
    expect(wonMetrics.totalPrecio).toBe(21500.00); // Subtotal con órdenes de cambio (+2,000, -500)
    expect(wonMetrics.totalCosto).toBe(12900.00);  // Costo con órdenes de cambio (+1,200, -300)
    expect(wonMetrics.margen).toBe(8600.00);       // Margen bruto en USD ($21,500 - $12,900)
    expect(wonMetrics.countTotal).toBe(1);

    const sellerMetrics = CrmDashboardCalc.calculateSellerPerformance(
      [projectEndState], [], [],
      [{ id: VENDOR.cid, nombre: VENDOR.name, role: 'vendedor' }]
    );
    const vendorRow = sellerMetrics.sellers.find(s => s.sellerId === VENDOR.cid);
    expect(vendorRow).toBeDefined();
    expect(vendorRow.countGanadas).toBe(1);
    expect(vendorRow.ventasGanadas).toBe(21500.00);

    const cxcMetrics = CrmDashboardCalc.calculateCxCMetrics([projectEndState]);
    expect(cxcMetrics.totalFacturado).toBe(24295.00);
    expect(cxcMetrics.totalCobrado).toBe(24295.00);
    expect(cxcMetrics.totalCxC).toBe(0.00);
    expect(cxcMetrics.pctCobrado).toBe(100);
  });

  test('Escenario de Exportación (0% IVA): Cliente en Centroamérica sin IVA salvadoreño', async () => {
    const CLIENT_EXPORT = {
      ...CLIENT_SALVADORENO,
      id: 'CLI-EXP-002',
      empresa: 'Corporación Hotelera de Guatemala S.A.',
      es_exportacion: true,
      is_gran_contribuyente: false
    };
    await fdb.seed(`clients_prod/${CLIENT_EXPORT.id}`, CLIENT_EXPORT);

    const expProspectId = 'PRJ-EXP-2026-002';
    await fdb.seed(`prospects_prod/${expProspectId}`, {
      id: expProspectId,
      clientId: CLIENT_EXPORT.id,
      proyecto: 'Fabricación de Ductos Especiales para Exportación',
      tipo_proyecto: 'Fabricación',
      precio_cotizado: 15000.00,
      costo_venta: 9000.00,
      createdBy: VENDOR.cid,
      vendedorId: VENDOR.cid,
      etapa: 'cierre',
      estado: 'activo',
      facturas: [],
      ordenes_cambio: [],
      datos: {
        doc_firmado: docFile('orden_compra_internacional.pdf'),
        doc_comprobante: docFile('anticipo_exportacion.pdf'),
        factura_anticipo: 'EXP-FAC-001'
      }
    });

    // Cierre 100% anticipado para exportación
    const expClose = await wf.finalizeProspect({
      caller: VENDOR,
      prospectId: expProspectId,
      data: {
        forma_pago: '100% anticipado',
        factura_anticipo: 'EXP-FAC-001',
        doc_firmado: docFile('orden_compra_internacional.pdf'),
        doc_comprobante: docFile('anticipo_exportacion.pdf')
      },
      opId: nextOpId()
    });

    expect(expClose.status).toBe('finalized');
    expect(expClose.montoAnticipo).toBe(15000.00); // 0% IVA: Monto total = Subtotal ($15,000 USD)

    FinanceCalculations.setDeps({ getClients: () => [CLIENT_EXPORT] });
    const expProject = await fdb.data(`prospects_prod/${expProspectId}`);
    const expFin = FinanceCalculations.calculateProjectFinancials(expProject);

    expect(expFin.isExport).toBe(true);
    expect(expFin.subtotal).toBe(15000.00);
    expect(expFin.iva).toBe(0.00); // Exento de IVA por exportación
    expect(expFin.total).toBe(15000.00);
    expect(expFin.totalFacturado).toBe(15000.00);
  });
});
