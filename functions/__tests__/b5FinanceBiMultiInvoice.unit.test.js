'use strict';

/**
 * DUCTSAL ERP — FASE B5
 * Suite integral de pruebas unitarias e integración backend:
 *  - B5.1: Modelo financiero canónico y aritmética exacta en centavos
 *  - B5.2: Abono bancario multi-factura (20 escenarios obligatorios)
 *  - B5.4: Coordinación transaccional financiera por cliente y reconciliación OCC
 *  - B5.5: Motor de Business Intelligence (getAccountBIMetrics y CrmBiEngine)
 *  - B5.6: Integración con bloqueo financiero de Fabricación
 *  - B5.7: Compatibilidad regresiva con BANK_078 / 868355650
 */

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const FinanceCalc = require('../../modules/finance/finance_calculations');
const { runResolution } = require('../scripts/resolveBank078Prod');

describe('FASE B5 — Coordinación Transaccional Financiera, Abonos Multi-Factura y Business Intelligence', () => {
  const fileObj = (name, folder = 'pagos') => ({
    name,
    type: 'application/pdf',
    size: 4096,
    data: `https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2F${folder}%2F${encodeURIComponent(name)}?alt=media`,
    storagePath: `prod_files/${folder}/${name}`,
    uploadedAt: '2026-11-10T12:00:00.000Z'
  });

  const makeEnv = () => {
    let clock = 1794300000000;
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

  const getDocData = async (fdb, colName, docId) => {
    const snap = await fdb.collection(colName).doc(docId).get();
    return snap.exists ? snap.data() : null;
  };

  const seedClient = async (fdb, id = 'CUST-B5-1', overrides = {}) => {
    await fdb.seed(`clients_prod/${id}`, {
      id,
      tipo: 'juridica',
      empresa: 'CORPORACION INDUSTRIAL B5, S.A. DE C.V.',
      nit: '0614-101020-101-1',
      nrc: '123456-7',
      es_exportacion: false,
      is_gran_contribuyente: true,
      documentos: {
        dui: fileObj('dui.pdf', 'clientes'),
        nit: fileObj('nit.pdf', 'clientes'),
        nrc: fileObj('nrc.pdf', 'clientes'),
        escritura: fileObj('escritura.pdf', 'clientes'),
        credencial: fileObj('credencial.pdf', 'clientes')
      },
      ...overrides
    });
  };

  const seedWonProspect = async (fdb, id, clientId, {
    codigo = `202611${id}`,
    proyecto = `PROYECTO ${id}`,
    precio_cotizado = 10000, // + 13% IVA = 11300.00
    forma_pago = '50/50',
    facturas = []
  } = {}) => {
    await fdb.seed(`prospects_prod/${id}`, {
      id,
      codigo,
      clientId,
      cliente: 'CORPORACION INDUSTRIAL B5, S.A. DE C.V.',
      proyecto,
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      precio_cotizado,
      costo_venta: precio_cotizado * 0.65,
      forma_pago,
      fecha_creacion: '2026-10-01T10:00:00.000Z',
      fecha_cierre: '2026-10-15T15:00:00.000Z',
      datos: {
        forma_pago,
        costo_directo: precio_cotizado * 0.65,
        doc_firmado: fileObj('CONTRATO_FIRMADO.pdf', 'proyectos')
      },
      ordenes_cambio: [],
      facturas
    });
  };

  describe('B5.1 — Modelo Financiero Canónico y Aritmética en Centavos', () => {
    test('separa estrictamente ventas adjudicadas, facturación vigente, cobros monetarios, retenciones 1% y dinero bancario recibido', () => {
      const client = { id: 'C1', es_exportacion: false, is_gran_contribuyente: true };
      const project = {
        id: 'P1',
        estado: 'ganado',
        precio_cotizado: 10000, // 11300 con IVA
        ordenes_cambio: [{ id: 'OC1', tipo: 'aumento', precio: 1000 }], // +1130 con IVA -> total 12430.00
        facturas: [
          {
            id: 'F1',
            numero: 'CCF-001',
            monto: 6215,
            pagos: [
              { id: 'PAY1', monto: 5000, metodo: 'transferencia', ref: 'TRX-100' },
              { id: 'RET1', monto: 55, metodo: 'retencion_1pct', ref: 'RET-001' },
              { id: 'VOID1', monto: 1000, metodo: 'transferencia', ref: 'TRX-VOID', anulado: true }
            ]
          },
          {
            id: 'F-ANULADA',
            numero: 'CCF-002',
            monto: 6215,
            anulada: true,
            pagos: []
          }
        ]
      };

      const fin = FinanceCalc.calculateProjectFinancials(project, client);
      expect(fin.pactado).toBe(12430);
      expect(fin.facturado).toBe(6215);
      expect(fin.cobrosMonetariosAplicados).toBe(5000);
      expect(fin.retencionesAplicadas).toBe(55);
      expect(fin.cobrado).toBe(5055);
      expect(fin.pendienteFacturar).toBe(6215);
      expect(fin.saldoFacturadoPendienteCobrar).toBe(1160);
      expect(fin.pendienteCobrar).toBe(7375);

      const depositStatus = FinanceCalc.calculateDepositStatus({
        monto_recibido: 8000,
        aplicaciones: [
          { aplicacion_id: 'A1', monto_aplicado: 5000, estado: 'activa' },
          { aplicacion_id: 'A2', monto_aplicado: 1500, estado: 'anulada' }
        ]
      });
      expect(depositStatus.montoRecibido).toBe(8000);
      expect(depositStatus.montoAplicado).toBe(5000);
      expect(depositStatus.saldoDisponible).toBe(3000);
      expect(depositStatus.estadoAbono).toBe('parcialmente_aplicado');
    });
  });

  describe('B5.2 & B5.6 — 20 Escenarios Obligatorios de Abonos Bancarios Multi-Factura', () => {
    test('Escenario 1: Abono único aplicado 100% a 1 factura', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-1');
      await seedWonProspect(fdb, 'OPP-1', 'CUST-1', {
        precio_cotizado: 10000, // 11,300 IVA inc.
        facturas: [{ id: 'FAC-1', numero: '101', monto: 5650, doc_factura: fileObj('f1.pdf', 'facturas'), pagos: [] }]
      });

      const res = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-01',
        clientId: 'CUST-1',
        deposit: {
          referencia_bancaria: '9001001',
          banco: 'Banco Agrícola',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-01',
          monto_recibido: 5650,
          doc_comprobante: fileObj('v1.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-1', invoiceId: 'FAC-1', monto_aplicado: 5650 }]
        }
      });

      expect(res.status).toBe('applied');
      expect(res.estadoAbono).toBe('totalmente_aplicado');
      expect(res.saldoDisponible).toBe(0);
      expect(res.montoAplicadoTotal).toBe(5650);

      const lockDoc = await getDocData(fdb, 'payment_refs_prod', 'BANK_9001001');
      expect(lockDoc).toBeTruthy();
      expect(lockDoc.estado_abono).toBe('totalmente_aplicado');
      expect(lockDoc.saldo_disponible).toBe(0);
      expect(lockDoc.aplicaciones).toHaveLength(1);
    });

    test('Escenario 2: Abono único distribuido entre 2 facturas del mismo cliente en distintas oportunidades', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-2');
      await seedWonProspect(fdb, 'OPP-2A', 'CUST-2', {
        precio_cotizado: 10000,
        facturas: [{ id: 'FAC-2A', numero: '201', monto: 5650, doc_factura: fileObj('f2a.pdf', 'facturas'), pagos: [] }]
      });
      await seedWonProspect(fdb, 'OPP-2B', 'CUST-2', {
        precio_cotizado: 8000, // 9040 IVA inc -> 50% = 4520
        facturas: [{ id: 'FAC-2B', numero: '202', monto: 4520, doc_factura: fileObj('f2b.pdf', 'facturas'), pagos: [] }]
      });

      const res = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-02',
        clientId: 'CUST-2',
        deposit: {
          referencia_bancaria: '9001002',
          banco: 'BAC Credomatic',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-02',
          monto_recibido: 10170,
          doc_comprobante: fileObj('v2.pdf', 'pagos'),
          applications: [
            { prospectId: 'OPP-2A', invoiceId: 'FAC-2A', monto_aplicado: 5650 },
            { prospectId: 'OPP-2B', invoiceId: 'FAC-2B', monto_aplicado: 4520 }
          ]
        }
      });

      expect(res.estadoAbono).toBe('totalmente_aplicado');
      expect(res.saldoDisponible).toBe(0);
      expect(res.applicationsCreated).toHaveLength(2);

      const p2a = await getDocData(fdb, 'prospects_prod', 'OPP-2A');
      const p2b = await getDocData(fdb, 'prospects_prod', 'OPP-2B');
      expect(p2a.facturas[0].pagos[0].ref).toBe('9001002');
      expect(p2b.facturas[0].pagos[0].ref).toBe('9001002');
      expect(p2a.facturas[0].pagos[0].aplicacion_id).not.toBe(p2b.facturas[0].pagos[0].aplicacion_id);
      expect(p2a.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
      expect(p2b.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
    });

    test('Escenario 3: Abono único distribuido entre 3 facturas del mismo cliente', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-3');
      await seedWonProspect(fdb, 'OPP-3', 'CUST-3', {
        precio_cotizado: 30000,
        facturas: [
          { id: 'F3-1', numero: '301', monto: 3000, doc_factura: fileObj('f31.pdf', 'facturas'), pagos: [] },
          { id: 'F3-2', numero: '302', monto: 4000, doc_factura: fileObj('f32.pdf', 'facturas'), pagos: [] },
          { id: 'F3-3', numero: '303', monto: 5000, doc_factura: fileObj('f33.pdf', 'facturas'), pagos: [] }
        ]
      });

      const res = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-03',
        clientId: 'CUST-3',
        deposit: {
          referencia_bancaria: '9001003',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-03',
          monto_recibido: 12000,
          doc_comprobante: fileObj('v3.pdf', 'pagos'),
          applications: [
            { prospectId: 'OPP-3', invoiceId: 'F3-1', monto_aplicado: 3000 },
            { prospectId: 'OPP-3', invoiceId: 'F3-2', monto_aplicado: 4000 },
            { prospectId: 'OPP-3', invoiceId: 'F3-3', monto_aplicado: 5000 }
          ]
        }
      });

      expect(res.estadoAbono).toBe('totalmente_aplicado');
      expect(res.applicationsCreated).toHaveLength(3);
    });

    test('Escenarios 4 y 5: Abono aplicado parcialmente dejando saldo disponible y aplicación posterior del saldo remanente a nueva factura', async () => {
      const { fdb, wf, caller } = makeEnv();
      const gestor = caller('gestor');
      await seedClient(fdb, 'CUST-4');
      await seedWonProspect(fdb, 'OPP-4', 'CUST-4', {
        precio_cotizado: 10000,
        facturas: [
          { id: 'F4-1', numero: '401', monto: 4000, doc_factura: fileObj('f41.pdf', 'facturas'), pagos: [] },
          { id: 'F4-2', numero: '402', monto: 3500, doc_factura: fileObj('f42.pdf', 'facturas'), pagos: [] }
        ]
      });

      const regRes = await wf.registerBankDeposit({
        caller: gestor,
        opId: 'OP-ESCENARIO-04',
        clientId: 'CUST-4',
        deposit: {
          referencia_bancaria: '9001004',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-04',
          monto_recibido: 7500,
          doc_comprobante: fileObj('v4.pdf', 'pagos'),
          applications: [
            { prospectId: 'OPP-4', invoiceId: 'F4-1', monto_aplicado: 4000 }
          ]
        }
      });

      expect(regRes.estadoAbono).toBe('parcialmente_aplicado');
      expect(regRes.montoAplicadoTotal).toBe(4000);
      expect(regRes.saldoDisponible).toBe(3500);

      // Escenario 5: Aplicar el saldo remanente de 3500 a la segunda factura
      const distRes = await wf.distributeBankDeposit({
        caller: gestor,
        opId: 'OP-ESCENARIO-05',
        depositId: 'BANK_9001004',
        applications: [
          { prospectId: 'OPP-4', invoiceId: 'F4-2', monto_aplicado: 3500 }
        ]
      });

      expect(distRes.estadoAbono).toBe('totalmente_aplicado');
      expect(distRes.montoAplicadoTotal).toBe(7500);
      expect(distRes.saldoDisponible).toBe(0);
    });

    test('Escenario 6: Una factura pagada con 2 abonos bancarios distintos (N abonos -> 1 factura)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-6');
      await seedWonProspect(fdb, 'OPP-6', 'CUST-6', {
        precio_cotizado: 10000,
        facturas: [
          { id: 'F6-1', numero: '601', monto: 6000, doc_factura: fileObj('f61.pdf', 'facturas'), pagos: [] }
        ]
      });

      await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-06A',
        clientId: 'CUST-6',
        deposit: {
          referencia_bancaria: '9006001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-05',
          monto_recibido: 2500,
          doc_comprobante: fileObj('v6a.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-6', invoiceId: 'F6-1', monto_aplicado: 2500 }]
        }
      });

      await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-06B',
        clientId: 'CUST-6',
        deposit: {
          referencia_bancaria: '9006002',
          metodo: 'cheque',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 3500,
          doc_comprobante: fileObj('v6b.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-6', invoiceId: 'F6-1', monto_aplicado: 3500 }]
        }
      });

      const p6 = await getDocData(fdb, 'prospects_prod', 'OPP-6');
      expect(p6.facturas[0].pagos).toHaveLength(2);
      const invStatus = FinanceCalc.calculateInvoiceStatus(p6.facturas[0]);
      expect(invStatus.cobrosMonetariosAplicados).toBe(6000);
      expect(invStatus.saldoPendiente).toBe(0);
      expect(invStatus.isPaid).toBe(true);
    });

    test('Escenario 7: Factura pagada con abono bancario + retención 1% (dinero recibido solo cuenta el abono bancario)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-7', { is_gran_contribuyente: true });
      await seedWonProspect(fdb, 'OPP-7', 'CUST-7', {
        precio_cotizado: 10000, // 11300 IVA inc
        facturas: [
          { id: 'F7-1', numero: '701', monto: 5650, doc_factura: fileObj('f71.pdf', 'facturas'), pagos: [] }
        ]
      });

      // Abono bancario por 5600 (5650 - 50 retención 1% sobre 5000 neto)
      await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-07-DEP',
        clientId: 'CUST-7',
        deposit: {
          referencia_bancaria: '9007001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 5600,
          doc_comprobante: fileObj('v7.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-7', invoiceId: 'F7-1', monto_aplicado: 5600 }]
        }
      });

      // Retención 1% por 50.00
      await wf.savePayment({
        caller: mgr,
        opId: 'OP-ESCENARIO-07-RET',
        prospectId: 'OPP-7',
        invoiceId: 'F7-1',
        monto: 50,
        metodo: 'retencion_1pct',
        ref: 'CR-7001',
        fecha: '2026-11-06',
        doc_comprobante: fileObj('ret7.pdf', 'pagos')
      });

      const clientDoc = await getDocData(fdb, 'clients_prod', 'CUST-7');
      expect(clientDoc.total_dinero_recibido).toBe(5600);
      expect(clientDoc.total_cobros_monetarios_aplicados).toBe(5600);
      expect(clientDoc.total_retenciones_aplicadas).toBe(50);
      expect(clientDoc.total_historico_cobrado).toBe(5650);
      expect(clientDoc.saldo_facturado_pendiente_cobrar).toBe(0);
    });

    test('Escenario 8: Rechazo al intentar aplicar más que el saldo disponible del abono', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-8');
      await seedWonProspect(fdb, 'OPP-8', 'CUST-8', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F8-1', numero: '801', monto: 5000, doc_factura: fileObj('f81.pdf', 'facturas'), pagos: [] }]
      });

      await expect(wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-08',
        clientId: 'CUST-8',
        deposit: {
          referencia_bancaria: '9008001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 3000,
          doc_comprobante: fileObj('v8.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-8', invoiceId: 'F8-1', monto_aplicado: 3000.01 }]
        }
      })).rejects.toThrow(/supera el importe recibido/i);
    });

    test('Escenario 9: Rechazo al intentar aplicar más que el saldo pendiente de la factura', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-9');
      await seedWonProspect(fdb, 'OPP-9', 'CUST-9', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F9-1', numero: '901', monto: 2000, doc_factura: fileObj('f91.pdf', 'facturas'), pagos: [] }]
      });

      await expect(wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-09',
        clientId: 'CUST-9',
        deposit: {
          referencia_bancaria: '9009001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 5000,
          doc_comprobante: fileObj('v9.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-9', invoiceId: 'F9-1', monto_aplicado: 2500 }]
        }
      })).rejects.toThrow(/supera el saldo de esta factura/i);
    });

    test('Escenario 10: Rechazo al intentar aplicar un abono a una factura de otro cliente', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-10A');
      await seedClient(fdb, 'CUST-10B');
      await seedWonProspect(fdb, 'OPP-10B', 'CUST-10B', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F10-B', numero: '1001', monto: 3000, doc_factura: fileObj('f10b.pdf', 'facturas'), pagos: [] }]
      });

      await expect(wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-10',
        clientId: 'CUST-10A',
        deposit: {
          referencia_bancaria: '9010001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 3000,
          doc_comprobante: fileObj('v10.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-10B', invoiceId: 'F10-B', monto_aplicado: 3000 }]
        }
      })).rejects.toThrow(/otro cliente/i);
    });

    test('Escenario 11: Rechazo al intentar aplicar a factura anulada o de oportunidad eliminada', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-11');
      await seedWonProspect(fdb, 'OPP-11', 'CUST-11', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F11-VOID', numero: '1101', monto: 3000, anulada: true, doc_factura: fileObj('f11.pdf', 'facturas'), pagos: [] }]
      });

      await expect(wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-11',
        clientId: 'CUST-11',
        deposit: {
          referencia_bancaria: '9011001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 3000,
          doc_comprobante: fileObj('v11.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-11', invoiceId: 'F11-VOID', monto_aplicado: 1000 }]
        }
      })).rejects.toThrow(/anulada/i);
    });

    test('Escenario 12: Rechazo al intentar reutilizar la misma referencia bancaria en otro abono nuevo o savePayment', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-12');
      await seedWonProspect(fdb, 'OPP-12', 'CUST-12', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F12-1', numero: '1201', monto: 5000, doc_factura: fileObj('f12.pdf', 'facturas'), pagos: [] }]
      });

      await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-12-1',
        clientId: 'CUST-12',
        deposit: {
          referencia_bancaria: 'REF-UNICA-12',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 2000,
          doc_comprobante: fileObj('v12.pdf', 'pagos'),
          applications: []
        }
      });

      await expect(wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-12-2',
        clientId: 'CUST-12',
        deposit: {
          referencia_bancaria: 'ref-unica-12',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 1000,
          doc_comprobante: fileObj('v12b.pdf', 'pagos'),
          applications: []
        }
      })).rejects.toThrow(/ya fue registrado/i);
    });

    test('Escenario 13: Idempotencia ante reintentos con el mismo opId y rechazo con payload distinto', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-13');
      await seedWonProspect(fdb, 'OPP-13', 'CUST-13', {
        precio_cotizado: 10000,
        facturas: [{ id: 'F13-1', numero: '1301', monto: 5000, doc_factura: fileObj('f13.pdf', 'facturas'), pagos: [] }]
      });

      const payload = {
        caller: mgr,
        opId: 'OP-IDEMP-13',
        clientId: 'CUST-13',
        deposit: {
          referencia_bancaria: '9013001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 2500,
          doc_comprobante: fileObj('v13.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-13', invoiceId: 'F13-1', monto_aplicado: 2500 }]
        }
      };

      const first = await wf.registerBankDeposit(payload);
      const second = await wf.registerBankDeposit(payload);
      expect(first.depositId).toBe(second.depositId);

      const p13 = await getDocData(fdb, 'prospects_prod', 'OPP-13');
      expect(p13.facturas[0].pagos).toHaveLength(1);

      await expect(wf.registerBankDeposit({
        ...payload,
        deposit: { ...payload.deposit, monto_recibido: 9999 }
      })).rejects.toThrow(/opId ya usado con otros datos/i);
    });

    test('Escenario 14: Anulación de aplicación individual (restituye saldo_disponible y preserva comprobante) y reasignación atómica a otra factura', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-14');
      await seedWonProspect(fdb, 'OPP-14', 'CUST-14', {
        precio_cotizado: 10000,
        facturas: [
          { id: 'F14-WRONG', numero: '1401', monto: 4000, doc_factura: fileObj('f14w.pdf', 'facturas'), pagos: [] },
          { id: 'F14-RIGHT', numero: '1402', monto: 4000, doc_factura: fileObj('f14r.pdf', 'facturas'), pagos: [] }
        ]
      });

      const regRes = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-E14-REG',
        clientId: 'CUST-14',
        deposit: {
          referencia_bancaria: '9014001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 4000,
          doc_comprobante: fileObj('v14.pdf', 'pagos'),
          applications: [{ prospectId: 'OPP-14', invoiceId: 'F14-WRONG', monto_aplicado: 4000 }]
        }
      });

      const appId = regRes.applicationsCreated[0].aplicacion_id;

      // Reasignar atómicamente de F14-WRONG a F14-RIGHT
      const voidRes = await wf.voidBankDepositApplication({
        caller: mgr,
        opId: 'OP-E14-REALLOC',
        depositId: 'BANK_9014001',
        applicationId: appId,
        motivo: 'Error de digitación de factura destino; corresponde a factura 1402',
        reallocateTo: {
          prospectId: 'OPP-14',
          invoiceId: 'F14-RIGHT',
          monto_aplicado: 3000
        }
      });

      expect(voidRes.status).toBe('voided');
      expect(voidRes.saldoDisponible).toBe(1000);
      expect(voidRes.estadoAbono).toBe('parcialmente_aplicado');
      expect(voidRes.reallocatedApplication).toBeTruthy();
      expect(voidRes.reallocatedApplication.invoiceId).toBe('F14-RIGHT');

      const lockDoc = await getDocData(fdb, 'payment_refs_prod', 'BANK_9014001');
      expect(lockDoc.doc_comprobante).toBeTruthy();
      expect(lockDoc.doc_comprobante.name).toBe('v14.pdf');
      expect(lockDoc.saldo_disponible).toBe(1000);
    });

    test('Escenario 15: Integración con bloqueo de Fabricación (anticipo cubierto con abono compartido, bloqueo por aplicación parcial y discrepancia post-envío)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-15', { is_gran_contribuyente: false });
      await seedWonProspect(fdb, 'OPP-15A', 'CUST-15', {
        precio_cotizado: 10000, // 11300 IVA inc -> 50% = 5650
        forma_pago: '50/50',
        facturas: [{ id: 'F15A', numero: '1501', monto: 5650, doc_factura: fileObj('f15a.pdf', 'facturas'), pagos: [] }]
      });
      await seedWonProspect(fdb, 'OPP-15B', 'CUST-15', {
        precio_cotizado: 10000, // 11300 IVA inc -> 50% = 5650
        forma_pago: '50/50',
        facturas: [{ id: 'F15B', numero: '1502', monto: 5650, doc_factura: fileObj('f15b.pdf', 'facturas'), pagos: [] }]
      });

      // Abono compartido que cubre el 100% de OPP-15A (5650) pero solo 3000 de OPP-15B
      const regRes = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-E15-REG',
        clientId: 'CUST-15',
        deposit: {
          referencia_bancaria: '9015001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 8650,
          doc_comprobante: fileObj('v15.pdf', 'pagos'),
          applications: [
            { prospectId: 'OPP-15A', invoiceId: 'F15A', monto_aplicado: 5650 },
            { prospectId: 'OPP-15B', invoiceId: 'F15B', monto_aplicado: 3000 }
          ]
        }
      });

      // OPP-15A puede enviarse a Fabricación
      const send15A = await wf.sendProspectToFabrication({
        caller: mgr,
        opId: 'OP-E15-SEND-A',
        prospectId: 'OPP-15A'
      });
      expect(send15A.status).toBe('sent');

      // OPP-15B está bloqueada porque su anticipo de 5650 solo tiene 3000 aplicados
      await expect(wf.sendProspectToFabrication({
        caller: mgr,
        opId: 'OP-E15-SEND-B',
        prospectId: 'OPP-15B'
      })).rejects.toThrow(/Anticipo/i);

      // Ahora anulamos la aplicación de OPP-15A DESPUÉS de haber sido enviada a fabricación
      const app15A = regRes.applicationsCreated.find((a) => a.prospectId === 'OPP-15A');
      const voidAfterFab = await wf.voidBankDepositApplication({
        caller: mgr,
        opId: 'OP-E15-VOID-AFTER-FAB',
        depositId: 'BANK_9015001',
        applicationId: app15A.aplicacion_id,
        motivo: 'Reversión bancaria posterior al envío a fabricación'
      });

      expect(voidAfterFab.discrepancyTriggered).toBe(true);
      const p15A = await getDocData(fdb, 'prospects_prod', 'OPP-15A');
      expect(p15A.estado_habilitacion_fabricacion).toBe('ANTICIPO_PENDIENTE');
      expect(p15A.discrepancia_financiera_fabricacion).toBe(true);
      // No elimina ni cancela automáticamente el estado enviado_a_fabricacion existente
      expect(p15A.enviado_a_fabricacion).toBe(true);
    });

    test('Escenario 16: Permisos por rol (vendedor no puede registrar, distribuir, anular ni recalcular finanzas)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const vendedor = caller('vendedor', 'USR-VEND-1');
      await seedClient(fdb, 'CUST-16');

      await expect(wf.registerBankDeposit({
        caller: vendedor,
        opId: 'OP-E16-1',
        clientId: 'CUST-16',
        deposit: {
          referencia_bancaria: '9016001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 1000,
          doc_comprobante: fileObj('v16.pdf', 'pagos')
        }
      })).rejects.toThrow(/rol no puede realizar esta operación/i);

      await expect(wf.distributeBankDeposit({
        caller: vendedor,
        opId: 'OP-E16-2',
        depositId: 'BANK_9016001',
        applications: []
      })).rejects.toThrow(/rol no puede realizar esta operación/i);

      await expect(wf.voidBankDepositApplication({
        caller: vendedor,
        opId: 'OP-E16-3',
        depositId: 'BANK_9016001',
        applicationId: 'APP-1',
        motivo: 'Intento no autorizado'
      })).rejects.toThrow(/rol no puede realizar esta operación/i);

      await expect(wf.recalculateClientFinancials({
        caller: vendedor,
        clientId: 'CUST-16'
      })).rejects.toThrow(/rol no puede realizar esta operación/i);
    });

    test('Escenario 17: Cuentas fusionadas (fusionada_en) resuelven al cliente canónico y permiten distribuir entre oportunidades del clúster', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-CANONICAL');
      await seedClient(fdb, 'CUST-MERGED', {
        cuenta_fusionada: true,
        fusionada_en: 'CUST-CANONICAL'
      });
      await seedWonProspect(fdb, 'OPP-CANON', 'CUST-CANONICAL', {
        precio_cotizado: 10000,
        facturas: [{ id: 'FC-1', numero: '1701', monto: 3000, doc_factura: fileObj('fc1.pdf', 'facturas'), pagos: [] }]
      });
      await seedWonProspect(fdb, 'OPP-MERGED', 'CUST-MERGED', {
        precio_cotizado: 10000,
        facturas: [{ id: 'FM-1', numero: '1702', monto: 2000, doc_factura: fileObj('fm1.pdf', 'facturas'), pagos: [] }]
      });

      const res = await wf.registerBankDeposit({
        caller: mgr,
        opId: 'OP-ESCENARIO-17',
        clientId: 'CUST-MERGED', // Se invoca con el ID secundario y debe resolver a CUST-CANONICAL
        deposit: {
          referencia_bancaria: '9017001',
          metodo: 'transferencia',
          fecha_comprobante: '2026-11-06',
          monto_recibido: 5000,
          doc_comprobante: fileObj('v17.pdf', 'pagos'),
          applications: [
            { prospectId: 'OPP-CANON', invoiceId: 'FC-1', monto_aplicado: 3000 },
            { prospectId: 'OPP-MERGED', invoiceId: 'FM-1', monto_aplicado: 2000 }
          ]
        }
      });

      expect(res.clientId).toBe('CUST-CANONICAL');
      expect(res.estadoAbono).toBe('totalmente_aplicado');

      const canonicalClient = await getDocData(fdb, 'clients_prod', 'CUST-CANONICAL');
      expect(canonicalClient.total_dinero_recibido).toBe(5000);
      expect(canonicalClient.total_cobros_monetarios_aplicados).toBe(5000);
    });

    test('Escenario 18: Compatibilidad regresiva con BANK_078 / 868355650 (CONSTRU-SERVICES)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');

      await seedClient(fdb, 'CUST-1777081077121-95', {
        empresa: 'CONSTRU-SERVICES, S.A. DE C.V.',
        is_gran_contribuyente: false
      });
      await fdb.seed('prospects_prod/1779123328318', {
        id: '1779123328318',
        codigo: '202605023',
        clientId: 'CUST-1777081077121-95',
        proyecto: 'PRESURIZACION',
        estado: 'ganado',
        etapa: 'cierre',
        postcierre_habilitado: true,
        precio_cotizado: 16214.5,
        forma_pago: '50/50',
        datos: { forma_pago: '50/50', doc_firmado: fileObj('c.pdf', 'proyectos') },
        facturas: [{
          id: '1789408613812',
          numero: '078',
          monto: 9161.1925,
          doc_factura: fileObj('f1.pdf', 'facturas'),
          pagos: [{ fecha: '2026-09-14T19:13:28.456Z', monto: 9161.19, metodo: 'transferencia', ref: '078', doc_comprobante: fileObj('p.jpg', 'pagos') }]
        }]
      });
      await fdb.seed('prospects_prod/OPP-1777081077278-7', {
        id: 'OPP-1777081077278-7',
        codigo: null,
        clientId: 'CUST-1777081077121-95',
        proyecto: 'EDIFICIO DESIRE',
        estado: 'ganado',
        etapa: 'cierre',
        postcierre_habilitado: true,
        precio_cotizado: 13844.81,
        forma_pago: '100% anticipado',
        datos: { doc_firmado: fileObj('c.pdf', 'proyectos') },
        facturas: [{
          id: '1789408531939',
          numero: '078',
          monto: 7822.32,
          doc_factura: fileObj('f2.pdf', 'facturas'),
          pagos: [{ fecha: '2026-09-14T19:11:44.724Z', monto: 7822.32, metodo: 'transferencia', ref: '078', doc_comprobante: fileObj('p.jpg', 'pagos') }]
        }]
      });
      await fdb.seed('payment_refs_prod/BANK_078', {
        lockId: 'BANK_078',
        kind: 'bank',
        normRef: '078',
        rawRef: '078',
        active: true,
        estado: 'conflicto_historico',
        conflicto_historico: true
      });

      await runResolution({ db: fdb, FieldValue: fdb.FieldValue, apply: true, actor: 'test-b5' });

      // Recalcular finanzas del cliente CONSTRU-SERVICES con el motor B5
      const recalc = await wf.recalculateClientFinancials({
        caller: mgr,
        clientId: 'CUST-1777081077121-95',
        reason: 'b5_regression_check_bank078'
      });

      expect(recalc.summary.total_dinero_recibido).toBe(16983.51);
      expect(recalc.summary.total_cobros_monetarios_aplicados).toBe(16983.51);
      expect(recalc.summary.saldo_abonos_pendientes_aplicar).toBe(0);

      // Listar abonos del cliente devuelve BANK_868355650 con sus 2 aplicaciones y saldo 0
      const listRes = await wf.listClientBankDeposits({
        caller: mgr,
        clientId: 'CUST-1777081077121-95'
      });
      const bank868 = listRes.deposits.find((d) => d.lockId === 'BANK_868355650');
      expect(bank868).toBeTruthy();
      expect(bank868.monto_recibido).toBe(16983.51);
      expect(bank868.monto_aplicado_total).toBe(16983.51);
      expect(bank868.saldo_disponible).toBe(0);
      expect(bank868.estado_abono).toBe('totalmente_aplicado');

      // Intentar distribuir más dinero desde BANK_868355650 falla porque saldo_disponible es 0
      await expect(wf.distributeBankDeposit({
        caller: mgr,
        opId: 'OP-TRY-REUSE-868355650',
        depositId: 'BANK_868355650',
        applications: [{ prospectId: '1779123328318', invoiceId: '1789408613812', monto_aplicado: 10 }]
      })).rejects.toThrow(/no tiene saldo disponible/i);
    });

    test('Escenario 19: Coordinación transaccional por cliente en todos los puntos de entrada y reconciliación OCC con auditoría', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-19', { is_gran_contribuyente: false });
      await seedWonProspect(fdb, 'OPP-19', 'CUST-19', {
        precio_cotizado: 10000, // 11300 IVA inc
        facturas: []
      });

      // 1. Crear factura
      await wf.saveInvoice({
        caller: mgr,
        opId: 'OP-19-INV',
        prospectId: 'OPP-19',
        numero: '1901',
        monto: 5650,
        fecha: '2026-11-01',
        fecha_vencimiento: '2026-11-15',
        doc_factura: fileObj('f19.pdf', 'facturas')
      });

      let c19 = await getDocData(fdb, 'clients_prod', 'CUST-19');
      expect(c19.total_historico_facturado).toBe(5650);
      expect(c19.total_historico_cobrado).toBe(0);
      expect(c19.es_cliente_historico).toBe(true);
      expect(c19.activeBilledProspectsCount).toBe(1);
      expect(c19.financialVersion).toBe(1);

      // 2. Crear orden de cambio
      await wf.saveChangeOrder({
        caller: mgr,
        opId: 'OP-19-OC-01',
        prospectId: 'OPP-19',
        tipo: 'aumento',
        desc: 'Ducto adicional',
        precio: 1000, // +1130 IVA inc -> pactado = 12430
        costo: 600,
        doc_oferta: fileObj('oc19.pdf', 'ordenes_cambio')
      });

      c19 = await getDocData(fdb, 'clients_prod', 'CUST-19');
      expect(c19.total_ventas_adjudicadas).toBe(12430);
      expect(c19.saldo_por_facturar).toBe(6780);
      expect(c19.financialVersion).toBe(2);

      // 3. Simular discrepancia manual en cliente y ejecutar recalculateClientFinancials
      await fdb.collection('clients_prod').doc('CUST-19').set({
        total_historico_facturado: 999999
      }, { merge: true });

      const recalc = await wf.recalculateClientFinancials({
        caller: mgr,
        clientId: 'CUST-19',
        reason: 'audit_verification'
      });

      expect(recalc.hasDiscrepancy).toBe(true);
      expect(recalc.summary.total_historico_facturado).toBe(5650);
      expect(recalc.summary.total_ventas_adjudicadas).toBe(12430);
    });

    test('Escenario 20: Business Intelligence (getAccountBIMetrics y CrmBiEngine) — Win Rate, Recurrencia, Margen Presupuestado, Antigüedad CxC sin inventar vencimientos', async () => {
      const { fdb, wf, caller } = makeEnv();
      const mgr = caller('manager');
      await seedClient(fdb, 'CUST-20', { is_gran_contribuyente: true });

      // Oportunidad Ganada 1 con 2 facturas (una con fecha_vencimiento vencida y otra sin fecha_vencimiento)
      await seedWonProspect(fdb, 'OPP-20-W1', 'CUST-20', {
        precio_cotizado: 20000, // 22600 IVA inc
        facturas: [
          {
            id: 'F20-1',
            numero: '2001',
            monto: 11300,
            fecha: '2026-09-01',
            fecha_vencimiento: '2026-09-30', // Vencida > 30 días al 2026-11-10 (41 días -> tramo 31_60)
            doc_factura: fileObj('f201.pdf', 'facturas'),
            pagos: [
              { id: 'P20-1', monto: 5000, metodo: 'transferencia', ref: '9020001', fecha: '2026-10-05' },
              { id: 'P20-RET', monto: 100, metodo: 'retencion_1pct', ref: 'RET-2001', fecha: '2026-10-05' }
            ]
          },
          {
            id: 'F20-2',
            numero: '2002',
            monto: 5000,
            fecha: '2026-10-10',
            // SIN fecha_vencimiento -> debe clasificarse en sin_vencimiento_definido
            doc_factura: fileObj('f202.pdf', 'facturas'),
            pagos: []
          }
        ]
      });

      // Oportunidad Perdida para probar Win Rate = 1 / (1 + 1) = 50%
      await fdb.seed('prospects_prod/OPP-20-L1', {
        id: 'OPP-20-L1',
        clientId: 'CUST-20',
        proyecto: 'PROYECTO PERDIDO',
        estado: 'perdido',
        etapa: 'cierre',
        precio_cotizado: 15000,
        fecha_creacion: '2026-10-01T10:00:00.000Z',
        fecha_cierre: '2026-10-20T10:00:00.000Z',
        facturas: []
      });

      // Abono bancario con saldo disponible a favor (1000 disponible)
      await fdb.seed('payment_refs_prod/BANK_9020001', {
        lockId: 'BANK_9020001',
        kind: 'bank',
        normRef: '9020001',
        referencia_bancaria: '9020001',
        clientId: 'CUST-20',
        active: true,
        metodo: 'transferencia',
        fecha_comprobante: '2026-10-05',
        monto_recibido: 6000,
        monto_aplicado_total: 5000,
        saldo_disponible: 1000,
        estado_abono: 'parcialmente_aplicado',
        aplicaciones: [
          { aplicacion_id: 'APP-20-1', prospectId: 'OPP-20-W1', invoiceId: 'F20-1', monto_aplicado: 5000, estado: 'activa', fecha_aplicacion: '2026-10-05' }
        ]
      });

      const bi = await wf.getAccountBIMetrics({
        caller: mgr,
        clientId: 'CUST-20',
        period: 'all',
        nowMs: Date.parse('2026-11-10T12:00:00.000Z')
      });

      // Comercial: 1 ganada (con 2 facturas) cuenta como 1 sola venta adjudicada, NO 2
      expect(bi.comercial.oportunidadesGanadasCount).toBe(1);
      expect(bi.comercial.oportunidadesPerdidasCount).toBe(1);
      expect(bi.comercial.winRatePct).toBe(50);
      expect(bi.comercial.recurrenciaPorCliente.totalWonOpportunities).toBe(1);

      // Financiero vivo
      expect(bi.financiero.stockVivo.ventasAdjudicadas).toBe(22600);
      expect(bi.financiero.stockVivo.facturacionRegistrada).toBe(16300);
      expect(bi.financiero.stockVivo.dineroEfectivamenteRecibido).toBe(6000);
      expect(bi.financiero.stockVivo.cobrosMonetariosAplicados).toBe(5000);
      expect(bi.financiero.stockVivo.retencionesAplicadas).toBe(100);
      expect(bi.financiero.stockVivo.saldoAbonosDisponibles).toBe(1000);
      expect(bi.financiero.stockVivo.saldoFacturadoPendienteCobrar).toBe(11200); // (11300 - 5100) + 5000

      // Antigüedad CxC: F20-1 (6200) en tramo 31_60 y F20-2 (5000) en sin_vencimiento_definido
      expect(bi.antiguedadCxC.buckets['31_60'].monto).toBe(6200);
      expect(bi.antiguedadCxC.buckets.sin_vencimiento_definido.monto).toBe(5000);
      expect(bi.antiguedadCxC.buckets['0_30'].monto).toBe(0);

      // Margen presupuestado
      expect(bi.margenPresupuestado.esCostoRealFabricacion).toBe(false);
      expect(bi.margenPresupuestado.oportunidadesConCostoDirecto).toBe(1);
      expect(bi.margenPresupuestado.margenBrutoPresupuestadoMonto).toBe(7000); // 20000 - 13000
      expect(bi.margenPresupuestado.margenBrutoPresupuestadoPct).toBe(35);
    });
  });
});
