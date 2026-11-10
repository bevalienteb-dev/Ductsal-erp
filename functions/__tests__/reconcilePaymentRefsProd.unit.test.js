// functions/__tests__/reconcilePaymentRefsProd.unit.test.js
// Unit and concurrency tests for the read-only reconciliation and idempotent backfill
// of historical payment references into `payment_refs_prod`.

const { createFakeFirestore, FieldValue } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const {
  CONFIRM_TOKEN,
  reconcileHistoricalPaymentRefs,
  executePaymentRefsBackfill
} = require('../scripts/reconcilePaymentRefsProd');

describe('Conciliación de referencias históricas e inicialización idempotente de payment_refs_prod', () => {
  test('1. Clasifica referencias bancarias y de retención, detecta faltantes en payment_refs_prod y excluye colisiones/duplicados/ambiguos', () => {
    const prospectsDocs = [
      {
        id: 'PRJ-HIST-1',
        data: {
          codigo: '202601001',
          clientId: 'CLI-1',
          facturas: [
            {
              id: 'INV-1',
              numero: 'CCF-001',
              monto: 5650,
              pagos: [
                { id: 'P-CLEAN-BANK', monto: 5600, metodo: 'transferencia', ref: 'TRX-HIST-001', fecha: '2026-05-10' },
                { id: 'P-CLEAN-RET-1', monto: 50, metodo: 'retencion_1pct', ref: 'CR-CONS-100', fecha: '2026-05-10' },
                { id: 'P-INDEXED', monto: 1000, metodo: 'cheque', ref: 'CHK-ALREADY-99', fecha: '2026-05-11' },
                { id: 'P-EMPTY-REF', monto: 200, metodo: 'transferencia', ref: '   ', fecha: '2026-05-12' },
                { id: 'P-PLACEHOLDER', monto: 300, metodo: 'transferencia', ref: 'N/A', fecha: '2026-05-13' },
                { id: 'P-VOIDED', monto: 400, metodo: 'transferencia', ref: 'TRX-VOID-1', anulado: true }
              ]
            },
            {
              id: 'INV-2',
              numero: 'CCF-002',
              monto: 5650,
              pagos: [
                // Misma constancia de retención consolidada del MISMO cliente en otra factura -> válida
                { id: 'P-CLEAN-RET-2', monto: 50, metodo: 'retencion_1pct', ref: 'cr cons 100', fecha: '2026-05-15' },
                // Referencia bancaria duplicada con PRJ-HIST-2 -> colisión excluida
                { id: 'P-COLL-BANK-A', monto: 1500, metodo: 'transferencia', ref: 'TRX-DUP-777', fecha: '2026-05-16' }
              ]
            }
          ]
        }
      },
      {
        id: 'PRJ-HIST-2',
        data: {
          codigo: '202601002',
          clientId: 'CLI-2',
          facturas: [
            {
              id: 'INV-3',
              numero: 'CCF-003',
              monto: 5650,
              pagos: [
                { id: 'P-COLL-BANK-B', monto: 1500, metodo: 'transferencia', ref: 'trx dup 777', fecha: '2026-06-01' },
                // Retención compartida entre dos clientes distintos -> colisión excluida
                { id: 'P-COLL-RET-CLI2', monto: 50, metodo: 'retencion_1pct', ref: 'CR-SHARED-BAD', fecha: '2026-06-02' }
              ]
            }
          ]
        }
      },
      {
        id: 'PRJ-HIST-3',
        data: {
          codigo: '202601003',
          clientId: 'CLI-1',
          facturas: [
            {
              id: 'INV-4',
              numero: 'CCF-004',
              monto: 5650,
              pagos: [
                { id: 'P-COLL-RET-CLI1', monto: 50, metodo: 'retencion_1pct', ref: 'CR-SHARED-BAD', fecha: '2026-06-03' }
              ]
            }
          ]
        }
      }
    ];

    const paymentRefsDocs = [
      {
        id: 'BANK_CHKALREADY99',
        data: {
          active: true,
          normRef: 'CHKALREADY99',
          prospectId: 'PRJ-HIST-1',
          invoiceId: 'INV-1',
          paymentKey: 'P-INDEXED'
        }
      }
    ];

    const plan = reconcileHistoricalPaymentRefs({ prospectsDocs, paymentRefsDocs });

    expect(plan.summary.totalActivePayments).toBe(10);
    expect(plan.summary.inactiveOrVoidedPayments).toBe(1);
    expect(plan.summary.totalBankReferences).toBe(3); // TRXHIST001, CHKALREADY99, TRXDUP777
    expect(plan.summary.totalRetentionReferences).toBe(2); // CRCONS100, CRSHAREDBAD
    expect(plan.summary.alreadyIndexedCount).toBe(1); // BANK_CHKALREADY99
    expect(plan.summary.missingIndexReadyCount).toBe(2); // BANK_TRXHIST001, RET_CRCONS100
    expect(plan.summary.collisionsCount).toBe(2); // BANK_TRXDUP777, RET_CRSHAREDBAD
    expect(plan.summary.paymentsMissingRefCount).toBe(1);
    expect(plan.summary.paymentsAmbiguousRefCount).toBe(1);
    expect(plan.summary.crossOpportunityReuseRisk).toBe(true);
    expect(plan.summary.requiresIndexInitialization).toBe(true);

    // Verificar que la constancia consolidada agrupa ambas facturas del mismo cliente CLI-1
    const consolidatedRet = plan.readyToIndex.find(r => r.lockId === 'RET_CRCONS100');
    expect(consolidatedRet).toBeDefined();
    expect(Object.keys(consolidatedRet.proposedDoc.entries)).toEqual([
      'PRJ-HIST-1__INV-1',
      'PRJ-HIST-1__INV-2'
    ]);
  });

  test('2. Demuestra que un pago histórico no indexado podría reutilizarse en otra oportunidad, y que el backfill idempotente cierra esa brecha sin tocar prospects_prod', async () => {
    const fdb = createFakeFirestore();
    const commercial = createCommercialService({
      db: fdb,
      FieldValue,
      suffix: '_prod',
      verifyManager: async () => true,
      now: () => new Date('2026-11-09T18:00:00.000Z')
    });
    const wf = createProspectWorkflowService({ db: fdb, FieldValue, kit: commercial.kit });

    const clientDoc = {
      id: 'CLI-BACKFILL',
      tipo: 'natural',
      nombres: 'Juan',
      apellidos: 'Pérez',
      dui: '01234567-8',
      es_exportacion: true,
      is_gran_contribuyente: false,
      documentos: { dui: { name: 'dui.pdf', storagePath: 'prod_files/clientes/CLI-BACKFILL/dui.pdf' } }
    };
    await fdb.seed('clients_prod/CLI-BACKFILL', clientDoc);

    // Oportunidad histórica 1 con un pago registrado ANTES de existir payment_refs_prod
    const histProspect1 = {
      id: 'PRJ-HIST-OLD',
      codigo: '202605001',
      clientId: 'CLI-BACKFILL',
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      precio_cotizado: 10000,
      forma_pago: '50/50',
      facturas: [
        {
          id: 'INV-HIST-1',
          numero: 'CCF-H1',
          monto: 5000,
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: { name: 'f1.pdf', storagePath: 'prod_files/facturas/PRJ-HIST-OLD/f1.pdf' },
          pagos: [
            {
              id: 'PAY-HIST-1',
              monto: 5000,
              metodo: 'transferencia',
              ref: 'TRX-HISTORICA-555',
              fecha: '2026-05-20',
              doc_comprobante: { name: 'p1.pdf', storagePath: 'prod_files/pagos/PRJ-HIST-OLD/p1.pdf' }
            }
          ]
        }
      ]
    };
    await fdb.seed('prospects_prod/PRJ-HIST-OLD', histProspect1);

    // Oportunidad 2 nueva donde se intentará reutilizar 'TRX-HISTORICA-555'
    await fdb.seed('prospects_prod/PRJ-NEW-2', {
      ...histProspect1,
      id: 'PRJ-NEW-2',
      codigo: '202611002',
      facturas: [
        {
          id: 'INV-NEW-2',
          numero: 'CCF-N2',
          monto: 5000,
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: { name: 'f2.pdf', storagePath: 'prod_files/facturas/PRJ-NEW-2/f2.pdf' },
          pagos: []
        }
      ]
    });

    // Ejecutar conciliación de solo lectura
    const pSnap = await fdb.collection('prospects_prod').get();
    const rSnap = await fdb.collection('payment_refs_prod').get();
    const plan = reconcileHistoricalPaymentRefs({
      prospectsDocs: pSnap.docs.map(d => ({ id: d.id, data: d.data() })),
      paymentRefsDocs: rSnap.docs.map(d => ({ id: d.id, data: d.data() }))
    });
    expect(plan.summary.missingIndexReadyCount).toBe(1);
    expect(plan.summary.crossOpportunityReuseRisk).toBe(true);

    // Rechaza ejecución sin token de confirmación
    await expect(executePaymentRefsBackfill({
      db: fdb,
      plan,
      suffix: '_prod',
      confirmToken: 'WRONG'
    })).rejects.toThrow(/confirmToken/);

    // Ejecutar backfill autorizado e idempotente
    const firstExec = await executePaymentRefsBackfill({
      db: fdb,
      plan,
      suffix: '_prod',
      confirmToken: CONFIRM_TOKEN
    });
    expect(firstExec.created).toEqual(['BANK_TRXHISTORICA555']);
    expect(firstExec.alreadyExistedSkipped).toEqual([]);

    // Re-ejecutar el backfill es 100% idempotente
    const secondExec = await executePaymentRefsBackfill({
      db: fdb,
      plan,
      suffix: '_prod',
      confirmToken: CONFIRM_TOKEN
    });
    expect(secondExec.created).toEqual([]);
    expect(secondExec.alreadyExistedSkipped).toEqual(['BANK_TRXHISTORICA555']);

    // Verificar que prospects_prod/PRJ-HIST-OLD NO fue modificado
    const afterHist = (await fdb.collection('prospects_prod').doc('PRJ-HIST-OLD').get()).data();
    expect(afterHist.facturas).toEqual(histProspect1.facturas);

    // Ahora, intentar reutilizar 'TRX-HISTORICA-555' en otra oportunidad (PRJ-NEW-2) es bloqueado en O(1)
    const gestor = { uid: 'u-ges', cid: 'GES-1', name: 'Gestor', role: 'gestor' };
    await expect(wf.savePayment({
      caller: gestor,
      prospectId: 'PRJ-NEW-2',
      invoiceId: 'INV-NEW-2',
      opId: 'OP-TRY-REUSE-HIST',
      monto: 1000,
      metodo: 'transferencia',
      ref: 'trx-historica 555',
      doc_comprobante: { name: 'dup.pdf', storagePath: 'prod_files/pagos/PRJ-NEW-2/dup.pdf' }
    })).rejects.toThrow('Este número de comprobante ya fue registrado en otro pago. Verifique la referencia antes de continuar.');
  });
});

