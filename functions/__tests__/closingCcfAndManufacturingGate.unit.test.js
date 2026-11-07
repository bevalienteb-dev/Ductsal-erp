'use strict';

/**
 * DUCTSAL ERP — Pruebas focalizadas: Separación del CCF de anticipo del cierre comercial
 * y bloqueo financiero obligatorio antes de fabricación.
 *
 * Cubre los 10 escenarios requeridos:
 * 1. Cierre comercial exitoso sin CCF de anticipo cuando toda la demás documentación obligatoria está completa.
 * 2. Cierre comercial bloqueado cuando falta cualquier otro documento obligatorio distinto del CCF.
 * 3. Cierre comercial bloqueado si la condición de pago no es 50/50, 70/30 o 100% anticipado.
 * 4. Oportunidad cerrada con CCF pendiente y anticipo pendiente: seguimiento financiero visible y fabricación bloqueada.
 * 5. Oportunidad cerrada con CCF emitido pero anticipo no pagado: fabricación bloqueada.
 * 6. Oportunidad 50/50 con pago confirmado menor al 50%: fabricación bloqueada.
 * 7. Oportunidad 50/50 con pago confirmado igual o mayor al 50%: fabricación permitida.
 * 8. Oportunidad 70/30 con pago confirmado menor al 70% vs. igual o mayor al 70%.
 * 9. Oportunidad 100% anticipado con pago confirmado menor al 100% vs. igual al 100%.
 * 10. Intentos de eludir la regla con banderas booleanas, pagos no confirmados/anulados o llamadas directas sin permiso.
 */

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const CrmFollowUpCalc = require('../../crm_followup_calc');
const FunctionsCrmFollowUpCalc = require('../crm_followup_calc');

describe('Separación de CCF de anticipo del cierre comercial y bloqueo financiero de fabricación', () => {
  const fileObj = (name, folder = 'proyectos') => ({
    name,
    type: 'application/pdf',
    size: 2048,
    data: `https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2F${folder}%2F${encodeURIComponent(name)}?alt=media`,
    storagePath: `prod_files/${folder}/${name}`,
    uploadedAt: '2026-11-07T12:00:00.000Z'
  });

  const makeEnv = () => {
    let clock = 1794000000000;
    const fdb = createFakeFirestore({
      clock: () => {
        clock += 1000;
        return new Date(clock);
      }
    });
    const service = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
      verifyManager: async () => true
    });
    const wf = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: service.kit
    });
    const caller = (role, cid = `USR-${role.toUpperCase()}`, name = `Usuario ${role}`) => ({
      uid: `uid-${cid}`,
      cid,
      id: cid,
      name,
      nombre: name,
      role,
      active: true
    });
    return { fdb, service, wf, caller };
  };

  const baseClient = {
    id: 'CLI-ACERO-01',
    tipo: 'juridica',
    empresa: 'INDUSTRIAS METALURGICAS S.A. DE C.V.',
    contacto: 'Ing. Roberto Gómez',
    cargo: 'Gerente de Operaciones',
    telefono: '2250-9000',
    correo: 'rgomez@metalurgicas.sv',
    correo_fact: 'facturacion@metalurgicas.sv',
    correo_facturacion: 'facturacion@metalurgicas.sv',
    contacto_pagos: 'Lic. Ana Morales',
    tel_pagos: '2250-9001',
    nit: '0614-010100-101-2',
    nrc: '123456-7',
    giro: 'Fabricación industrial',
    direccion_fiscal: 'Zona Industrial Plan de La Laguna, Antiguo Cuscatlán',
    es_exportacion: false,
    documentos: {
      dui: fileObj('dui_rep.pdf', 'clientes'),
      nit: fileObj('nit_sociedad.pdf', 'clientes'),
      nrc: fileObj('nrc_sociedad.pdf', 'clientes'),
      escritura: fileObj('escritura_constitucion.pdf', 'clientes'),
      credencial: fileObj('credencial_vigente.pdf', 'clientes')
    },
    documentos_meta: {
      credencial: {
        estado_validacion: 'vigente',
        fecha_vencimiento: '2028-12-31'
      },
      escritura: {
        estado_validacion: 'vigente',
        proxima_revision: '2028-06-30'
      },
      nrc: {
        estado_validacion: 'vigente',
        proxima_revision: '2028-06-30'
      }
    }
  };

  const baseClosingProspect = {
    id: 'PRJ-CLOSE-01',
    codigo: '202611001',
    clientId: 'CLI-ACERO-01',
    proyecto: 'Sistema de extracción industrial Planta 2',
    tipo_proyecto: 'Fabricación e instalación',
    etapa: 'cierre',
    estado: 'activo',
    vendedorId: 'ALEJANDRA-AYALA',
    vendedorName: 'Alejandra Ayala',
    createdBy: 'ALEJANDRA-AYALA',
    costo_venta: 6000,
    precio_cotizado: 10000, // Con IVA 13% => Total contrato = $11,300.00
    fecha_inicio_cierre: '2026-11-03T14:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-10-20T10:00:00.000Z',
      cotizacion: '2026-10-24T10:00:00.000Z',
      negociacion: '2026-10-28T10:00:00.000Z',
      cierre: '2026-11-03T14:00:00.000Z'
    },
    datos: {
      doc_oferta: fileObj('oferta_cotizacion.pdf'),
      doc_costos: fileObj('cuadro_costos.xlsx')
    },
    facturas: [],
    ordenes_cambio: [],
    logs: []
  };

  test('Escenario 1: Cierre comercial exitoso sin CCF de anticipo cuando toda la demás documentación obligatoria está completa', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');

    // En etapa cierre, calculateStageSla ya NO marca el CCF ni número de factura como bloqueantes
    const slaBefore = CrmFollowUpCalc.calculateStageSla(
      {
        ...baseClosingProspect,
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez',
        datos: {
          ...baseClosingProspect.datos,
          doc_firmado: fileObj('contrato_firmado.pdf'),
          forma_pago: '50/50'
        }
      },
      new Date('2026-11-05T15:00:00.000Z'),
      baseClient
    );
    expect(slaBefore.pendingDocumentation).toEqual([]);

    const res = await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
        // Sin factura_anticipo ni doc_comprobante
      }
    });

    expect(res.status).toBe('finalized');
    expect(res.estado).toBe('ganado');
    expect(res.forma_pago).toBe('50/50');
    expect(res.ccf_anticipo_emitido).toBe(false);
    expect(res.monto_anticipo_exigible).toBe(5650); // 50% de $11,300.00 (10,000 * 1.13)
    expect(res.facturas).toEqual([]);
    expect(res.fecha_inicio_cierre).toBe('2026-11-03T14:00:00.000Z'); // Fecha adjudicación preservada
    expect(res.fecha_cierre).toBeTruthy(); // Fecha de cierre comercial distinta y registrada
  });

  test('Escenario 2: Cierre comercial bloqueado cuando falta cualquier otro documento o requisito obligatorio distinto del CCF', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');

    // 2a. Falta doc_firmado (contrato / oferta firmada)
    await expect(wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    })).rejects.toThrow(/Debe adjuntar el Contrato firmado|Debe adjuntar la oferta firmada/i);

    // 2b. Falta encargado en proyecto de Fabricación e instalación
    await expect(wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: ''
      }
    })).rejects.toThrow(/Debe asignar un Encargado de Instalación/i);

    // 2c. Falta DUI del cliente (siempre obligatorio) o documento societario en cierre con contrato
    await fdb.seed('clients_prod/CLI-ACERO-01', {
      ...baseClient,
      documentos: {
        ...baseClient.documentos,
        dui: null
      }
    });
    await expect(wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    })).rejects.toThrow(/Falta el DUI/i);

    await fdb.seed('clients_prod/CLI-ACERO-01', {
      ...baseClient,
      documentos: {
        ...baseClient.documentos,
        escritura: null
      }
    });
    await expect(wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        requiere_contrato: true,
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    })).rejects.toThrow(/Faltan documentos societarios|escritura/i);
  });

  test('Escenario 3: Cierre comercial bloqueado si la condición de pago no es 50/50, 70/30 o 100% anticipado', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');

    for (const invalidTerm of ['', 'Crédito 30 días', 'Contra entrega', '0% anticipo', '30/70', '60/40', null]) {
      await expect(wf.finalizeProspect({
        caller: vendedora,
        prospectId: 'PRJ-CLOSE-01',
        data: {
          doc_firmado: fileObj('contrato_firmado.pdf'),
          forma_pago: invalidTerm,
          encargado: 'Ing. Carlos Pérez'
        }
      })).rejects.toThrow(/Forma de pago inválida/i);
    }
  });

  test('Escenario 4: Oportunidad cerrada con CCF pendiente y anticipo pendiente — seguimiento financiero visible y fabricación bloqueada', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    });

    const closedDoc = (await fdb.collection('prospects_prod').doc('PRJ-CLOSE-01').get()).data();

    // Verificar hitos financieros tanto en módulo frontend como backend
    const fmClient = CrmFollowUpCalc.evaluateFinancialMilestones(closedDoc, baseClient);
    const fmServer = FunctionsCrmFollowUpCalc.evaluateFinancialMilestones(closedDoc, baseClient);
    expect(fmClient).toEqual(fmServer);
    expect(fmClient.ccfAnticipoStatus).toBe('pendiente');
    expect(fmClient.anticipoPagoStatus).toBe('pendiente');
    expect(fmClient.montoExigible).toBe(5650);
    expect(fmClient.montoConfirmado).toBe(0);
    expect(fmClient.saldoPendienteAnticipo).toBe(5650);
    expect(fmClient.habilitadoFabricacion).toBe(false);
    expect(fmClient.obligacionesSeguimiento.length).toBeGreaterThanOrEqual(2);

    // Validación de fabricación en backend rechaza con ANTICIPO_PENDIENTE
    await expect(wf.validateManufacturingReadiness({
      caller: caller('jefe_produccion'),
      prospectId: 'PRJ-CLOSE-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        formaPago: '50/50',
        montoExigible: 5650,
        montoConfirmado: 0,
        saldoPendiente: 5650,
        ccfAnticipoStatus: 'pendiente',
        anticipoPagoStatus: 'pendiente'
      })
    });
  });

  test('Escenario 5: Oportunidad cerrada con CCF emitido pero anticipo NO pagado — fabricación bloqueada', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    });

    // Gestor emite posteriormente el CCF de anticipo en post-cierre (sin pagos registrados)
    const afterInvoice = await wf.saveInvoice({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01',
      opId: 'OP-INV-501',
      numero: 'CCF-2026-0501',
      monto: 5650,
      doc_factura: fileObj('ccf_2026_0501.pdf', 'facturas')
    });

    expect(afterInvoice.ccf_anticipo_emitido).toBe(true);
    expect(afterInvoice.factura_anticipo).toBe('CCF-2026-0501');

    const storedProspect = (await fdb.collection('prospects_prod').doc('PRJ-CLOSE-01').get()).data();
    const fm = CrmFollowUpCalc.evaluateFinancialMilestones(storedProspect, baseClient);
    expect(fm.ccfAnticipoStatus).toBe('emitido');
    expect(fm.ccfAnticipoNumero).toBe('CCF-2026-0501');
    expect(fm.anticipoPagoStatus).toBe('pendiente');
    expect(fm.montoConfirmado).toBe(0);
    expect(fm.habilitadoFabricacion).toBe(false);

    // Un CCF emitido sin pago confirmado NO habilita fabricación
    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        ccfAnticipoStatus: 'emitido',
        anticipoPagoStatus: 'pendiente',
        montoExigible: 5650,
        montoConfirmado: 0,
        saldoPendiente: 5650
      })
    });
  });

  test('Escenario 6 y 7: Oportunidad 50/50 con pago confirmado menor al 50% (bloqueada) vs. igual o mayor al 50% (permitida)', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-01', baseClosingProspect);

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-01',
      data: {
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    });

    const invCreated = await wf.saveInvoice({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01',
      opId: 'OP-INV-5050-1',
      numero: 'CCF-5050-01',
      monto: 5650,
      doc_factura: fileObj('ccf_5050.pdf', 'facturas')
    });
    const invId = invCreated.invoice.id;

    // Escenario 6: Pago parcial confirmado ($3,000.00 < $5,650.00 requeridos)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01',
      invoiceId: invId,
      opId: 'OP-PAY-5050-1',
      monto: 3000,
      metodo: 'transferencia',
      ref: 'TRX-PARTIAL-01',
      doc_comprobante: fileObj('vaucher_3000.pdf', 'pagos')
    });

    const partialProspect = (await fdb.collection('prospects_prod').doc('PRJ-CLOSE-01').get()).data();
    const fmPartial = CrmFollowUpCalc.evaluateFinancialMilestones(partialProspect, baseClient);
    expect(fmPartial.anticipoPagoStatus).toBe('parcialmente_pagado');
    expect(fmPartial.habilitadoFabricacion).toBe(false);

    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        anticipoPagoStatus: 'parcialmente_pagado',
        montoExigible: 5650,
        montoConfirmado: 3000,
        saldoPendiente: 2650
      })
    });

    // Escenario 7: Segundo abono confirmado por $2,650.00 completa el 50% ($5,650.00)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01',
      invoiceId: invId,
      opId: 'OP-PAY-5050-2',
      monto: 2650,
      metodo: 'transferencia',
      ref: 'TRX-COMPLETO-02',
      doc_comprobante: fileObj('vaucher_2650.pdf', 'pagos')
    });

    const readyRes = await wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-01'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.status).toBe('ready_for_manufacturing');
    expect(readyRes.formaPago).toBe('50/50');
    expect(readyRes.montoExigible).toBe(5650);
    expect(readyRes.montoConfirmado).toBe(5650);
    expect(readyRes.saldoPendiente).toBe(0);
    expect(readyRes.anticipoPagoStatus).toBe('pagado');
  });

  test('Escenario 8: Oportunidad 70/30 con pago confirmado menor al 70% vs. igual o mayor al 70%', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-7030', {
      ...baseClosingProspect,
      id: 'PRJ-CLOSE-7030',
      codigo: '202611002'
    });

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-7030',
      data: {
        doc_firmado: fileObj('contrato_firmado_7030.pdf'),
        forma_pago: '70/30',
        encargado: 'Ing. Carlos Pérez',
        factura_anticipo: 'CCF-7030-01',
        doc_comprobante: fileObj('ccf_7030.pdf', 'facturas')
      }
    });

    // 70% de $11,300.00 = $7,910.00
    const closedSnap = await fdb.collection('prospects_prod').doc('PRJ-CLOSE-7030').get();
    const invId = closedSnap.data().facturas[0].id;
    expect(closedSnap.data().monto_anticipo_exigible).toBe(7910);

    // Pago confirmado menor al 70% ($5,650.00 = 50% < 70%)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-7030',
      invoiceId: invId,
      opId: 'OP-PAY-7030-1',
      monto: 5650,
      metodo: 'transferencia',
      ref: 'TRX-7030-A',
      doc_comprobante: fileObj('pago_5650.pdf', 'pagos')
    });

    await expect(wf.validateManufacturingReadiness({
      caller: caller('manager'),
      prospectId: 'PRJ-CLOSE-7030'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        formaPago: '70/30',
        montoExigible: 7910,
        montoConfirmado: 5650,
        saldoPendiente: 2260
      })
    });

    // Completar el 70% (+$2,260.00 = $7,910.00)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-7030',
      invoiceId: invId,
      opId: 'OP-PAY-7030-2',
      monto: 2260,
      metodo: 'cheque',
      ref: 'CHQ-7030-B',
      doc_comprobante: fileObj('pago_2260.pdf', 'pagos')
    });

    const readyRes = await wf.validateManufacturingReadiness({
      caller: caller('manager'),
      prospectId: 'PRJ-CLOSE-7030'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.montoExigible).toBe(7910);
    expect(readyRes.montoConfirmado).toBe(7910);
  });

  test('Escenario 9: Oportunidad 100% anticipado con pago confirmado menor al 100% vs. igual al 100%', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-CLOSE-100', {
      ...baseClosingProspect,
      id: 'PRJ-CLOSE-100',
      codigo: '202611003'
    });

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-CLOSE-100',
      data: {
        doc_firmado: fileObj('contrato_firmado_100.pdf'),
        forma_pago: '100% anticipado',
        encargado: 'Ing. Carlos Pérez',
        factura_anticipo: 'CCF-100-01',
        doc_comprobante: fileObj('ccf_100.pdf', 'facturas')
      }
    });

    const closedSnap = await fdb.collection('prospects_prod').doc('PRJ-CLOSE-100').get();
    const invId = closedSnap.data().facturas[0].id;
    expect(closedSnap.data().monto_anticipo_exigible).toBe(11300);

    // Pago de 90% ($10,170.00 < $11,300.00) -> bloqueado
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-100',
      invoiceId: invId,
      opId: 'OP-PAY-100-1',
      monto: 10170,
      metodo: 'transferencia',
      ref: 'TRX-100-A',
      doc_comprobante: fileObj('pago_10170.pdf', 'pagos')
    });

    await expect(wf.validateManufacturingReadiness({
      caller: caller('jefe_produccion'),
      prospectId: 'PRJ-CLOSE-100'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        formaPago: '100% anticipado',
        montoExigible: 11300,
        montoConfirmado: 10170,
        saldoPendiente: 1130
      })
    });

    // Completar el 100% (+$1,130.00 = $11,300.00) -> habilitado
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-CLOSE-100',
      invoiceId: invId,
      opId: 'OP-PAY-100-2',
      monto: 1130,
      metodo: 'transferencia',
      ref: 'TRX-100-B',
      doc_comprobante: fileObj('pago_1130.pdf', 'pagos')
    });

    const readyRes = await wf.validateManufacturingReadiness({
      caller: caller('jefe_produccion'),
      prospectId: 'PRJ-CLOSE-100'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.montoExigible).toBe(11300);
    expect(readyRes.montoConfirmado).toBe(11300);
    expect(readyRes.saldoPendiente).toBe(0);
  });

  test('Escenario 10: Rechaza intentos de eludir la regla con banderas booleanas, pagos no confirmados/anulados/duplicados o llamadas sin permiso', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);

    // Sembrar oportunidad cerrada con banderas booleanas manipuladas pero pagos inválidos/anulados/no verificados
    const forgedProspect = {
      ...baseClosingProspect,
      id: 'PRJ-FORGED-01',
      etapa: 'cierre',
      estado: 'ganado',
      ganada: true,
      forma_pago: '50/50',
      encargado: 'Ing. Carlos Pérez',
      fecha_cierre: '2026-11-07T16:00:00.000Z',
      // Banderas booleanas que NO deben ser aceptadas como fuente de verdad
      anticipo_pagado: true,
      habilitado_fabricacion: true,
      fabricacion_autorizada: true,
      datos: {
        ...baseClosingProspect.datos,
        doc_firmado: fileObj('contrato_firmado.pdf'),
        forma_pago: '50/50',
        anticipo_pagado: true
      },
      facturas: [
        {
          id: 'INV-F1',
          numero: 'CCF-900',
          monto: 5650,
          fecha: '2026-11-07',
          doc_factura: fileObj('ccf_900.pdf', 'facturas'),
          pagos: [
            // 1. Pago anulado
            {
              id: 'PAY-ANULADO',
              monto: 5650,
              fecha: '2026-11-07',
              metodo: 'Transferencia',
              anulado: true,
              doc_comprobante: fileObj('anulado.pdf', 'pagos')
            },
            // 2. Pago pendiente de verificación
            {
              id: 'PAY-UNVERIFIED',
              monto: 5650,
              fecha: '2026-11-07',
              metodo: 'Transferencia',
              estado: 'pendiente_verificacion',
              doc_comprobante: fileObj('promesa.pdf', 'pagos')
            },
            // 3. Pago sin doc_comprobante
            {
              id: 'PAY-NODOC',
              monto: 5650,
              fecha: '2026-11-07',
              metodo: 'Transferencia',
              doc_comprobante: null
            },
            // 4. Pago con campos confirmado/verificado ausentes (undefined): NO debe contabilizarse como cobrado
            {
              id: 'PAY-MISSING-CONFIRM',
              monto: 5650,
              fecha: '2026-11-07',
              metodo: 'transferencia',
              doc_comprobante: fileObj('sin_confirmar_backend.pdf', 'pagos')
            },
            // 5. Pago positivamente confirmado en backend de $2,000 y su duplicado con mismo id
            {
              id: 'PAY-DUP-1',
              monto: 2000,
              fecha: '2026-11-07',
              metodo: 'transferencia',
              confirmado: true,
              estado: 'confirmado',
              confirmado_por: 'Gestor Financiero',
              confirmado_por_uid: 'uid-GESTOR-FIN',
              confirmado_por_rol: 'gestor',
              confirmado_en: '2026-11-07T16:10:00.000Z',
              doc_comprobante: fileObj('valido_2000.pdf', 'pagos')
            },
            {
              id: 'PAY-DUP-1',
              monto: 2000,
              fecha: '2026-11-07',
              metodo: 'transferencia',
              confirmado: true,
              estado: 'confirmado',
              confirmado_por: 'Gestor Financiero',
              confirmado_por_uid: 'uid-GESTOR-FIN',
              confirmado_por_rol: 'gestor',
              confirmado_en: '2026-11-07T16:10:00.000Z',
              doc_comprobante: fileObj('valido_2000.pdf', 'pagos')
            }
          ]
        }
      ]
    };

    await fdb.seed('prospects_prod/PRJ-FORGED-01', forgedProspect);

    // 10a. Llamadas sin sesión o desde roles sin permiso para liberar fabricación son rechazadas con permission-denied / unauthenticated
    await expect(wf.validateManufacturingReadiness({
      caller: null,
      prospectId: 'PRJ-FORGED-01'
    })).rejects.toMatchObject({ code: 'unauthenticated' });

    await expect(wf.validateManufacturingReadiness({
      caller: caller('vendedor', 'ALEJANDRA-AYALA'),
      prospectId: 'PRJ-FORGED-01'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    await expect(wf.validateManufacturingReadiness({
      caller: caller('consultor', 'CONS-01'),
      prospectId: 'PRJ-FORGED-01'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // 10b. Con rol autorizado, ignora las banderas booleanas, descarta pagos anulados/no verificados/sin comprobante/sin confirmación positiva/duplicados
    // y solo contabiliza $2,000.00 positivamente confirmados (faltan $3,650.00)
    await expect(wf.validateManufacturingReadiness({
      caller: caller('manager'),
      prospectId: 'PRJ-FORGED-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        montoExigible: 5650,
        montoConfirmado: 2000,
        montoRegistradoNoConfirmado: 5650,
        saldoPendiente: 3650
      })
    });
  });

  test('Escenario 11: Pago histórico con confirmado/verificado ausentes NO habilita fabricación hasta ser confirmado positivamente por backend autorizado', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);

    // Oportunidad con pago histórico legítimo (sin campos confirmado/verificado) por el 100% del anticipo ($5,650.00)
    await fdb.seed('prospects_prod/PRJ-LEGACY-PAY', {
      ...baseClosingProspect,
      id: 'PRJ-LEGACY-PAY',
      codigo: '202611011',
      etapa: 'cierre',
      estado: 'ganado',
      ganada: true,
      forma_pago: '50/50',
      encargado: 'Ing. Carlos Pérez',
      fecha_cierre: '2026-10-15T16:00:00.000Z',
      datos: {
        ...baseClosingProspect.datos,
        doc_firmado: fileObj('contrato_firmado_legacy.pdf'),
        forma_pago: '50/50'
      },
      facturas: [
        {
          id: 'INV-LEGACY-01',
          numero: 'CCF-LEGACY-101',
          monto: 5650,
          fecha: '2026-10-16',
          doc_factura: fileObj('ccf_legacy_101.pdf', 'facturas'),
          pagos: [
            {
              id: 'PAY-LEGACY-01',
              monto: 5650,
              fecha: '2026-10-17',
              metodo: 'transferencia',
              ref: 'TRX-LEGACY-99',
              doc_comprobante: fileObj('comprobante_legacy.pdf', 'pagos')
              // confirmado y verificado ausentes (undefined)
            }
          ]
        }
      ]
    });

    const beforeDoc = (await fdb.collection('prospects_prod').doc('PRJ-LEGACY-PAY').get()).data();
    const fmBefore = CrmFollowUpCalc.evaluateFinancialMilestones(beforeDoc, baseClient);
    expect(fmBefore.montoConfirmado).toBe(0);
    expect(fmBefore.montoRegistradoNoConfirmado).toBe(5650);
    expect(fmBefore.habilitadoFabricacion).toBe(false);

    // No habilita fabricación automáticamente sin confirmación positiva de backend
    await expect(wf.validateManufacturingReadiness({
      caller: caller('manager'),
      prospectId: 'PRJ-LEGACY-PAY'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        montoExigible: 5650,
        montoConfirmado: 0,
        montoRegistradoNoConfirmado: 5650,
        saldoPendiente: 5650
      })
    });

    // Un gestor confirma explícitamente el pago histórico mediante el flujo autorizado savePayment({ confirmar: true })
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');
    const confirmRes = await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-LEGACY-PAY',
      invoiceId: 'INV-LEGACY-01',
      paymentId: 'PAY-LEGACY-01',
      monto: 5650,
      fecha: '2026-10-17',
      metodo: 'transferencia',
      ref: 'TRX-LEGACY-99',
      confirmar: true
    });

    expect(confirmRes.payment.confirmado).toBe(true);
    expect(confirmRes.payment.estado).toBe('confirmado');
    expect(confirmRes.payment.confirmado_por_uid).toBe('uid-GESTOR-FIN');
    expect(confirmRes.payment.confirmado_por_rol).toBe('gestor');
    expect(confirmRes.payment.confirmado_en).toBeTruthy();

    const readyRes = await wf.validateManufacturingReadiness({
      caller: caller('jefe_produccion'),
      prospectId: 'PRJ-LEGACY-PAY'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.montoConfirmado).toBe(5650);
    expect(readyRes.montoRegistradoNoConfirmado).toBe(0);
  });

  test('Escenario 12: Pagos de facturas ajenas al anticipo NO habilitan fabricación y la factura de anticipo se preserva ante reordenamiento o intentos de borrado', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/CLI-ACERO-01', baseClient);
    await fdb.seed('prospects_prod/PRJ-MULTI-INV', {
      ...baseClosingProspect,
      id: 'PRJ-MULTI-INV',
      codigo: '202611012'
    });

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-MULTI-INV',
      data: {
        doc_firmado: fileObj('contrato_multi.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez'
      }
    });

    // 1. Emitir factura de anticipo ($5,650.00) sin pagos
    const advCreated = await wf.saveInvoice({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      opId: 'OP-ADV-INV',
      numero: 'CCF-ANT-001',
      monto: 5650,
      doc_factura: fileObj('ccf_ant_001.pdf', 'facturas')
    });
    const advId = advCreated.invoice.id;
    expect(advCreated.invoice.es_anticipo).toBe(true);
    expect(advCreated.invoice.tipo_factura).toBe('anticipo');

    // 2. Registrar orden de cambio en aumento (+$2,000 + IVA = $2,260) y su factura independiente
    await wf.saveChangeOrder({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      opId: 'OP-CO-001',
      tipo: 'aumento',
      precio: 2000,
      costo: 1000,
      desc: 'Ductería adicional cuarto limpio',
      doc_oferta: fileObj('oc_aumento.pdf')
    });

    const otherCreated = await wf.saveInvoice({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      opId: 'OP-ORD-INV',
      numero: 'CCF-OC-002',
      monto: 5650,
      doc_factura: fileObj('ccf_oc_002.pdf', 'facturas')
    });
    const otherId = otherCreated.invoice.id;
    expect(otherCreated.invoice.es_anticipo).toBe(false);
    expect(otherCreated.invoice.tipo_factura).toBe('ordinaria');

    // 3. Registrar pago confirmado de $5,650.00 en la SEGUNDA factura (ajena al anticipo)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      invoiceId: otherId,
      opId: 'OP-PAY-OTHER',
      monto: 5650,
      metodo: 'transferencia',
      ref: 'TRX-OTHER-01',
      doc_comprobante: fileObj('pago_otra_factura.pdf', 'pagos')
    });

    // Verificar que el pago de otra factura NO se suma al anticipo y fabricación sigue bloqueada
    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        montoExigible: 5650,
        montoConfirmado: 0,
        montoConfirmadoOtrasFacturas: 5650,
        saldoPendiente: 5650
      })
    });

    // 4. Reordenar el arreglo facturas (colocar la factura ordinaria en índice 0 y la de anticipo en índice 1)
    const snap = await fdb.collection('prospects_prod').doc('PRJ-MULTI-INV').get();
    const curData = snap.data();
    const reordered = [curData.facturas[1], curData.facturas[0]];
    await fdb.seed('prospects_prod/PRJ-MULTI-INV', {
      ...curData,
      facturas: reordered
    });

    // Intentar eliminar la factura de anticipo (aunque ahora esté en índice 1) debe ser bloqueado
    await expect(wf.deleteInvoice({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      invoiceId: advId
    })).rejects.toThrow(/factura de anticipo.*no puede ser eliminada/i);

    // Aún reordenada, la factura ordinaria en índice 0 NO se confunde con la de anticipo
    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        ccfAnticipoId: advId,
        ccfAnticipoNumero: 'CCF-ANT-001',
        montoConfirmado: 0,
        montoConfirmadoOtrasFacturas: 5650
      })
    });

    // 5. Pagar la factura de anticipo real (índice 1) habilita fabricación
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV',
      invoiceId: advId,
      opId: 'OP-PAY-ADV-REAL',
      monto: 5650,
      metodo: 'transferencia',
      ref: 'TRX-ADV-REAL',
      doc_comprobante: fileObj('pago_anticipo_real.pdf', 'pagos')
    });

    const readyRes = await wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-MULTI-INV'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.ccfAnticipoId).toBe(advId);
    expect(readyRes.montoConfirmado).toBe(5650);
    expect(readyRes.montoConfirmadoOtrasFacturas).toBe(5650);
  });

  test('Escenario 13: Tratamiento fiscal de retencion_1pct en el anticipo (Gran Contribuyente 99% efectivo + 1% retención vs. excesos o sin efectivo)', async () => {
    const { fdb, wf, caller } = makeEnv();
    const granContribClient = {
      ...baseClient,
      id: 'CLI-GRAN-01',
      is_gran_contribuyente: true,
      es_exportacion: false
    };
    await fdb.seed('clients_prod/CLI-GRAN-01', granContribClient);
    await fdb.seed('prospects_prod/PRJ-RET-01', {
      ...baseClosingProspect,
      id: 'PRJ-RET-01',
      clientId: 'CLI-GRAN-01',
      codigo: '202611013'
    });

    const vendedora = caller('vendedor', 'ALEJANDRA-AYALA', 'Alejandra Ayala');
    const gestor = caller('gestor', 'GESTOR-FIN', 'Gestor Financiero');

    await wf.finalizeProspect({
      caller: vendedora,
      prospectId: 'PRJ-RET-01',
      data: {
        doc_firmado: fileObj('contrato_gran_contrib.pdf'),
        forma_pago: '50/50',
        encargado: 'Ing. Carlos Pérez',
        factura_anticipo: 'CCF-RET-001',
        doc_comprobante: fileObj('ccf_ret_001.pdf', 'facturas')
      }
    });

    // Anticipo 50% de $11,300.00 = $5,650.00 (Subtotal sin IVA del anticipo = $5,000.00, IVA = $650.00, Retención 1% = $50.00)
    const snap = await fdb.collection('prospects_prod').doc('PRJ-RET-01').get();
    const invId = snap.data().facturas[0].id;

    // 13a. Registrar únicamente retención 1% ($50.00) sin cobro efectivo -> montoEfectivoConfirmado = 0 -> retención reconocida = 0
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-RET-01',
      invoiceId: invId,
      opId: 'OP-RET-ONLY',
      monto: 50,
      metodo: 'retencion_1pct',
      ref: 'COMP-RET-001',
      doc_comprobante: fileObj('comprobante_retencion_50.pdf', 'pagos')
    });

    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-RET-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        montoExigible: 5650,
        montoEfectivoConfirmado: 0,
        montoRetencionConfirmada: 0,
        montoConfirmado: 0
      })
    });

    // 13b. Registrar transferencia por $5,000.00 + retención excesiva adicional por $600.00 (total retención bruta $650.00 > tope 1% $56.50)
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-RET-01',
      invoiceId: invId,
      opId: 'OP-CASH-5000',
      monto: 5000,
      metodo: 'transferencia',
      ref: 'TRX-5000',
      doc_comprobante: fileObj('vaucher_5000.pdf', 'pagos')
    });
    const excessRet = await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-RET-01',
      invoiceId: invId,
      opId: 'OP-RET-EXCESS',
      monto: 600,
      metodo: 'retencion_1pct',
      ref: 'COMP-RET-EXCESS',
      doc_comprobante: fileObj('retencion_exceso.pdf', 'pagos')
    });

    await expect(wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-RET-01'
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({
        errorCode: 'ANTICIPO_PENDIENTE',
        montoExigible: 5650,
        montoEfectivoConfirmado: 5000,
        montoRetencionConfirmada: 56.5,
        montoRetencionExcedente: 593.5,
        montoConfirmado: 5056.5
      })
    });

    // 13c. Eliminar la retención excesiva y registrar el complemento efectivo ($600.00) para llegar a $5,600.00 efectivo + $50.00 retención 1% = $5,650.00
    await wf.deletePayment({
      caller: gestor,
      prospectId: 'PRJ-RET-01',
      invoiceId: invId,
      paymentId: excessRet.payment.id
    });
    await wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-RET-01',
      invoiceId: invId,
      opId: 'OP-CASH-600',
      monto: 600,
      metodo: 'transferencia',
      ref: 'TRX-600',
      doc_comprobante: fileObj('vaucher_600.pdf', 'pagos')
    });

    const readyRes = await wf.validateManufacturingReadiness({
      caller: gestor,
      prospectId: 'PRJ-RET-01'
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.montoExigible).toBe(5650);
    expect(readyRes.montoEfectivoConfirmado).toBe(5600);
    expect(readyRes.montoRetencionConfirmada).toBe(50);
    expect(readyRes.montoConfirmado).toBe(5650);
    expect(readyRes.saldoPendiente).toBe(0);
  });
});
