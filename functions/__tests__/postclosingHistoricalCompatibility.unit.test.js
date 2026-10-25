// functions/__tests__/postclosingHistoricalCompatibility.unit.test.js
// Automated test suite for Historical Compatibility of hasEnteredPostclosing()
// Covering all 9 mandatory scenarios:
// 1. Historical won sale without postcierre_habilitado, but with valid closing evidence: retains access.
// 2. New opportunity in Cierre pending documentation: no access.
// 3. New opportunity finalized with postcierre_habilitado === true: has access.
// 4. Active opportunity with inherited fecha_cierre, without sufficient evidence: not enabled.
// 5. Inconsistent historical record: denied access by default and documented.
// 6. Invoicing, payments, and change orders blocked for Cierre pending.
// 7. Invoicing, payments, and change orders allowed for legitimate historical closed sales.
// 8. Invoicing, payments, and change orders allowed for sales finalized with the new flow.
// 9. Existing Cierre flow, manager bypass without contract, and idempotency preserved.

const fs = require('fs');
const path = require('path');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService, hasEnteredPostclosing: commHasEnteredPostclosing } = require('../commercialService');
const { createProspectWorkflowService, hasEnteredPostclosing: wfHasEnteredPostclosing, POLICY } = require('../prospectWorkflowService');
const { createStorageService, hasEnteredPostclosing: storageHasEnteredPostclosing } = require('../storageService');

// Read frontend hasEnteredPostclosing implementation from app_core.js for parity check
const appCoreSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const fnMatch = appCoreSrc.match(/function hasEnteredPostclosing\(p\) \{[\s\S]*?\n\}/);
if (!fnMatch) throw new Error('hasEnteredPostclosing not found in app_core.js');
const frontendHasEnteredPostclosing = new Function(`return ${fnMatch[0]}`)();

const CLOCK = new Date('2026-10-25T12:00:00.000Z');

function makeEnv(customClock = CLOCK) {
  const fdb = createFakeFirestore({ clock: () => customClock });
  const live = { ok: true, calls: [] };
  const commSvc = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => customClock,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });

  const wfSvc = createProspectWorkflowService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    kit: commSvc.kit,
    fileUrlPrefixes: ['https://firebasestorage.googleapis.com/v0/b/']
  });

  const mockFiles = new Map();
  const mockBucket = {
    file: filePath => ({
      name: filePath,
      exists: async () => [mockFiles.has(filePath)],
      getMetadata: async () => {
        if (!mockFiles.has(filePath)) throw new Error('File not found');
        return [mockFiles.get(filePath)];
      },
      getSignedUrl: async () => [`https://storage.googleapis.com/test-bucket/${filePath}?token=test_token`]
    })
  };

  const storageSvc = createStorageService({
    db: fdb,
    bucket: mockBucket,
    suffix: '_prod'
  });

  const caller = (role, cid = 'USR-01') => ({
    uid: `uid_${cid}`,
    cid,
    name: `Usuario ${cid}`,
    role
  });

  return {
    fdb,
    commSvc,
    wfSvc,
    storageSvc,
    mockFiles,
    caller,
    hasEnteredPostclosing: commSvc.hasEnteredPostclosing,
    commHasEnteredPostclosing,
    wfHasEnteredPostclosing,
    storageHasEnteredPostclosing,
    frontendHasEnteredPostclosing
  };
}

function makeClientNatural(id = 'C-NATURAL', overrides = {}) {
  return {
    id,
    tipo: 'natural',
    nombres: 'Carlos',
    apellidos: 'Rivas',
    dui: '01234567-8',
    nit: '0614-010190-101-1',
    telefono: '7777-8888',
    correo: 'carlos@example.com',
    correo_fact: 'facturas@example.com',
    documentos: { dui: '01234567-8' },
    ...overrides
  };
}

describe('Postclosing Historical Compatibility Suite', () => {
  // =========================================================================
  // SCENARIO 1: Venta histórica ganada sin postcierre_habilitado
  // =========================================================================
  describe('1. Venta histórica ganada sin postcierre_habilitado pero con evidencia válida', () => {
    test('1.1 Venta histórica con estado ganado, fecha_cierre y facturas registradas conserva acceso', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const histWonWithFacturas = {
        id: 'HIST-WON-01',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-04-10T10:00:00.000Z',
        facturas: [
          { id: 'FAC-1', numero: 'CCF-001-OLD', monto: 5000, pagos: [], fecha: '2025-04-10T10:00:00.000Z' }
        ]
      };

      expect(hasEnteredPostclosing(histWonWithFacturas)).toBe(true);
      expect(frontendHasEnteredPostclosing(histWonWithFacturas)).toBe(true);
    });

    test('1.2 Venta histórica con estado ganado, fecha_cierre, contrato_archivo y facturas vacías conserva acceso', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const histWonWithContract = {
        id: 'HIST-WON-02',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-05-15T15:30:00.000Z',
        contrato_archivo: { name: 'contrato_firmado.pdf', storagePath: 'prod_files/prospects/HIST-WON-02/cierre/contrato_firmado.pdf' },
        facturas: []
      };

      expect(hasEnteredPostclosing(histWonWithContract)).toBe(true);
      expect(frontendHasEnteredPostclosing(histWonWithContract)).toBe(true);
    });

    test('1.3 Venta histórica con solo forma de pago y fecha es denegada (no constituye prueba formalizada)', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const histWonWithPaymentTerms = {
        id: 'HIST-WON-03',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        stage_timestamps: { cierre: '2025-06-01T12:00:00.000Z' },
        forma_pago: 'credito_30',
        facturas: []
      };

      // Criterio 4: forma_pago aislada con fecha jamás se considera prueba suficiente
      expect(hasEnteredPostclosing(histWonWithPaymentTerms)).toBe(false);
      expect(frontendHasEnteredPostclosing(histWonWithPaymentTerms)).toBe(false);
    });

    test('1.4 Venta histórica con contrato y comprobante de anticipo conserva acceso; comprobante aislado es denegado', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const histWonWithFullDocs = {
        id: 'HIST-WON-04-FULL',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-07-20T08:00:00.000Z',
        datos: {
          doc_contrato: { name: 'contrato.pdf', storagePath: 'prod_files/prospects/HIST-WON-04/cierre/contrato.pdf' },
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: 'prod_files/prospects/HIST-WON-04/facturas/ccf_anticipo.pdf' }
        },
        facturas: []
      };

      expect(hasEnteredPostclosing(histWonWithFullDocs)).toBe(true);
      expect(frontendHasEnteredPostclosing(histWonWithFullDocs)).toBe(true);

      const histWonOnlyComprobante = {
        id: 'HIST-WON-04-PARTIAL',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-07-20T08:00:00.000Z',
        datos: {
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: 'prod_files/prospects/HIST-WON-04/facturas/ccf_anticipo.pdf' }
        },
        facturas: []
      };

      expect(hasEnteredPostclosing(histWonOnlyComprobante)).toBe(false);
      expect(frontendHasEnteredPostclosing(histWonOnlyComprobante)).toBe(false);
    });

    test('1.5 Venta histórica con autorización sin contrato y comprobante conserva acceso; bypass aislado es denegado', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const histWonWithBypassAndVoucher = {
        id: 'HIST-WON-05-VALID',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-08-01T10:00:00.000Z',
        autorizado_sin_contrato: true,
        doc_comprobante: { name: 'recibo_anticipo.pdf', storagePath: 'prod_files/prospects/HIST-WON-05/facturas/recibo_anticipo.pdf' },
        facturas: []
      };

      expect(hasEnteredPostclosing(histWonWithBypassAndVoucher)).toBe(true);
      expect(frontendHasEnteredPostclosing(histWonWithBypassAndVoucher)).toBe(true);

      const histWonWithBypassIsolated = {
        id: 'HIST-WON-05-ISOLATED',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-08-01T10:00:00.000Z',
        autorizado_sin_contrato: true,
        facturas: []
      };

      expect(hasEnteredPostclosing(histWonWithBypassIsolated)).toBe(false);
      expect(frontendHasEnteredPostclosing(histWonWithBypassIsolated)).toBe(false);
    });

    test('1.6 Gestor comercial y Storage conceden acceso a expediente histórico legítimamente cerrado', async () => {
      const { fdb, commSvc, storageSvc, mockFiles, caller } = makeEnv();
      const filePath = 'prod_files/prospects/HIST-ACC-01/facturas/factura_anticipo.pdf';
      mockFiles.set(filePath, { size: 3000, contentType: 'application/pdf' });

      const histProject = {
        id: 'HIST-ACC-01',
        clientId: 'C-01',
        createdBy: 'V-OTRO',
        vendedorId: 'V-OTRO',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-03-01T10:00:00.000Z',
        contrato_archivo: { name: 'contrato.pdf', storagePath: filePath },
        facturas: [{ id: 'F1', numero: 'CCF-001', monto: 1200, pagos: [] }]
      };
      await fdb.seed('prospects_prod/HIST-ACC-01', histProject);

      const gestorCaller = caller('gestor', 'GES-01');
      expect(commSvc.kit.canAccessProspect(gestorCaller, histProject)).toBe(true);

      const dlRes = await storageSvc.getSecureDownloadUrl({
        caller: gestorCaller,
        storagePath: filePath,
        prospectId: 'HIST-ACC-01'
      });
      expect(dlRes.signedUrl).toBeDefined();
    });
  });

  // =========================================================================
  // SCENARIO 2: Oportunidad nueva en Cierre pendiente
  // =========================================================================
  describe('2. Oportunidad nueva en Cierre pendiente de documentación', () => {
    test('2.1 Oportunidad en etapa cierre con estado activo no tiene acceso a postcierre', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const pCierrePending = {
        id: 'P-NEW-PENDING-01',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        fecha_inicio_cierre: '2026-10-25T08:00:00.000Z',
        stage_timestamps: { cierre: '2026-10-25T08:00:00.000Z' },
        facturas: []
      };

      expect(hasEnteredPostclosing(pCierrePending)).toBe(false);
      expect(frontendHasEnteredPostclosing(pCierrePending)).toBe(false);
    });

    test('2.2 Oportunidad con documentos parciales guardados sigue bloqueada mientras esté en estado activo', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const pCierrePartialDocs = {
        id: 'P-NEW-PENDING-02',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        fecha_inicio_cierre: '2026-10-25T08:00:00.000Z',
        stage_timestamps: { cierre: '2026-10-25T08:00:00.000Z' },
        contrato_archivo: { name: 'contrato.pdf', storagePath: 'prod_files/prospects/P-NEW-PENDING-02/cierre/contrato.pdf' },
        facturas: []
      };

      expect(hasEnteredPostclosing(pCierrePartialDocs)).toBe(false);
      expect(frontendHasEnteredPostclosing(pCierrePartialDocs)).toBe(false);
    });
  });

  // =========================================================================
  // SCENARIO 3: Oportunidad nueva finalizada con postcierre_habilitado === true
  // =========================================================================
  describe('3. Oportunidad nueva finalizada con postcierre_habilitado === true', () => {
    test('3.1 Oportunidad formalmente finalizada con estado ganado y postcierre_habilitado === true tiene acceso', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const pFinalized = {
        id: 'P-NEW-FINALIZED-01',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_postcierre: '2026-10-25T11:00:00.000Z',
        fecha_cierre: '2026-10-25T11:00:00.000Z',
        fecha_finalizacion: '2026-10-25T11:00:00.000Z',
        facturas: [{ id: 'FAC-NEW', numero: 'CCF-999-NEW', monto: 3500, pagos: [] }]
      };

      expect(hasEnteredPostclosing(pFinalized)).toBe(true);
      expect(frontendHasEnteredPostclosing(pFinalized)).toBe(true);
    });

    test('3.2 Gestor accede válidamente a oportunidad formalmente finalizada', async () => {
      const { fdb, commSvc, storageSvc, mockFiles, caller } = makeEnv();
      const filePath = 'prod_files/prospects/P-FINAL-DL/facturas/ccf_anticipo.pdf';
      mockFiles.set(filePath, { size: 4000, contentType: 'application/pdf' });

      const finalizedProspect = {
        id: 'P-FINAL-DL',
        clientId: 'C-01',
        createdBy: 'V-02',
        vendedorId: 'V-02',
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_postcierre: '2026-10-25T11:00:00.000Z',
        fecha_cierre: '2026-10-25T11:00:00.000Z',
        facturas: [{ id: 'F1', numero: 'CCF-001', monto: 1000, pagos: [] }]
      };
      await fdb.seed('prospects_prod/P-FINAL-DL', finalizedProspect);

      const gestorCaller = caller('gestor', 'GES-01');
      expect(commSvc.kit.canAccessProspect(gestorCaller, finalizedProspect)).toBe(true);

      const dlRes = await storageSvc.getSecureDownloadUrl({
        caller: gestorCaller,
        storagePath: filePath,
        prospectId: 'P-FINAL-DL'
      });
      expect(dlRes.signedUrl).toBeDefined();
    });
  });

  // =========================================================================
  // SCENARIO 4: Oportunidad activa con fecha_cierre heredada
  // =========================================================================
  describe('4. Oportunidad activa con fecha_cierre heredada pero sin finalización', () => {
    test('4.1 Oportunidad activa en cotización con fecha_cierre heredada no se habilita automáticamente', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const activeWithInheritedDate = {
        id: 'P-ACTIVE-COTIZACION',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cotizacion',
        estado: 'activo',
        fecha_cierre: '2025-01-01T00:00:00.000Z',
        facturas: []
      };

      expect(hasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
      expect(frontendHasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
    });

    test('4.2 Oportunidad activa en levantamiento con fecha_cierre heredada no se habilita', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const activeWithInheritedDate = {
        id: 'P-ACTIVE-LEVANTAMIENTO',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'levantamiento',
        estado: 'activo',
        fecha_cierre: '2024-12-15T00:00:00.000Z',
        facturas: []
      };

      expect(hasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
      expect(frontendHasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
    });

    test('4.3 Oportunidad activa en negociación con fecha_cierre estimada no se habilita', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const activeWithInheritedDate = {
        id: 'P-ACTIVE-NEGOCIACION',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'negociacion',
        estado: 'activo',
        fecha_cierre: '2026-11-01T00:00:00.000Z',
        facturas: []
      };

      expect(hasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
      expect(frontendHasEnteredPostclosing(activeWithInheritedDate)).toBe(false);
    });
  });

  // =========================================================================
  // SCENARIO 5: Registro histórico inconsistente
  // =========================================================================
  describe('5. Registro histórico inconsistente: acceso denegado por defecto', () => {
    test('5.1 Documento con fecha_cierre o stage_timestamps.cierre pero facturas vacías y sin comprobantes es denegado', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      // Caso 6 documentado en COMMERCIAL_OPERATIONS.md:434: fecha_cierre sin facturas ni documentos de cierre
      const inconsistentAmbiguous = {
        id: 'HIST-INCONSISTENT-01',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        fecha_cierre: '2024-03-01T10:00:00.000Z',
        stage_timestamps: { cierre: '2024-03-01T10:00:00.000Z' },
        facturas: []
      };

      expect(hasEnteredPostclosing(inconsistentAmbiguous)).toBe(false);
      expect(frontendHasEnteredPostclosing(inconsistentAmbiguous)).toBe(false);
    });

    test('5.2 Expediente con estado perdido y stage_timestamps.cierre sin postcierre_habilitado es denegado', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      const lostBeforeClose = {
        id: 'HIST-LOST-BEFORE-CLOSE',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'perdido',
        motivo_perdida: 'Cliente no aprobó presupuesto',
        stage_timestamps: { cierre: '2024-04-01T10:00:00.000Z' },
        facturas: []
      };

      expect(hasEnteredPostclosing(lostBeforeClose)).toBe(false);
      expect(frontendHasEnteredPostclosing(lostBeforeClose)).toBe(false);
    });

    test('5.3 Documento que solo tiene estado ganado sin fechas de cierre, facturas ni documentación es denegado', () => {
      const { hasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();
      // Caso 5 descartado en COMMERCIAL_OPERATIONS.md:431: estado == 'ganado' aislado
      const orphanGanado = {
        id: 'HIST-ORPHAN-GANADO',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        estado: 'ganado',
        facturas: []
      };

      expect(hasEnteredPostclosing(orphanGanado)).toBe(false);
      expect(frontendHasEnteredPostclosing(orphanGanado)).toBe(false);
    });
  });

  // =========================================================================
  // SCENARIO 6: Facturación, pagos y órdenes de cambio bloqueados para Cierre pendiente
  // =========================================================================
  describe('6. Facturación, pagos y órdenes de cambio bloqueados para Cierre pendiente', () => {
    let env;
    let pendingId;
    beforeEach(async () => {
      env = makeEnv();
      pendingId = 'P-PENDING-FINANCIAL';
      await env.fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await env.fdb.seed(`prospects_prod/${pendingId}`, {
        id: pendingId,
        codigo: '202610001',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        precio_cotizado: 10000,
        fecha_inicio_cierre: '2026-10-25T08:00:00.000Z',
        stage_timestamps: { cierre: '2026-10-25T08:00:00.000Z' },
        facturas: []
      });
    });

    test('6.1 saveInvoice rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.saveInvoice({
        caller: caller('manager'),
        prospectId: pendingId,
        numero: 'FAC-PENDING-001',
        monto: 3000,
        doc_factura: { name: 'f.pdf', storagePath: 'prod_files/prospects/P-PENDING-FINANCIAL/facturas/f.pdf' },
        opId: 'op-inv-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    test('6.2 savePayment rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.savePayment({
        caller: caller('manager'),
        prospectId: pendingId,
        invoiceId: 'F1',
        monto: 1000,
        metodo: 'transferencia',
        ref: 'TR-001',
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P-PENDING-FINANCIAL/pagos/recibo.pdf' },
        opId: 'op-pay-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    test('6.3 saveChangeOrder rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.saveChangeOrder({
        caller: caller('manager'),
        prospectId: pendingId,
        tipo: 'aumento',
        precio: 500,
        costo: 300,
        desc: 'Aumento de ductería',
        opId: 'op-co-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    test('6.4 deleteInvoice rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.deleteInvoice({
        caller: caller('manager'),
        prospectId: pendingId,
        invoiceId: 'F1'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    test('6.5 deletePayment rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.deletePayment({
        caller: caller('manager'),
        prospectId: pendingId,
        invoiceId: 'F1',
        paymentKey: 'PAY-1'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    test('6.6 deleteChangeOrder rechaza oportunidades en Cierre pendiente', async () => {
      const { wfSvc, caller } = env;
      await expect(wfSvc.deleteChangeOrder({
        caller: caller('manager'),
        prospectId: pendingId,
        orderId: 'CO-1'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });
  });

  // =========================================================================
  // SCENARIO 7: Facturación, pagos y órdenes de cambio permitidos para ventas históricas legítimas
  // =========================================================================
  describe('7. Facturación, pagos y órdenes de cambio permitidos para ventas históricas legítimamente cerradas', () => {
    let env;
    let histId;
    beforeEach(async () => {
      env = makeEnv();
      histId = 'P-HIST-LEGIT-FINANCIAL';
      await env.fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await env.fdb.seed(`prospects_prod/${histId}`, {
        id: histId,
        codigo: '202503001',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        precio_cotizado: 10000,
        fecha_cierre: '2025-03-10T10:00:00.000Z',
        contrato_archivo: { name: 'contrato_firmado.pdf', storagePath: 'prod_files/prospects/P-HIST-LEGIT-FINANCIAL/cierre/contrato_firmado.pdf' },
        facturas: [
          {
            id: 'F_HIST_1',
            numero: 'CCF-HIST-001',
            monto: 3000,
            pagos: [],
            fecha: '2025-03-10T10:00:00.000Z'
          }
        ]
      });
    });

    test('7.1 saveInvoice permitido en venta histórica legítimamente cerrada', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.saveInvoice({
        caller: caller('gestor', 'GES-01'),
        prospectId: histId,
        numero: 'CCF-HIST-002',
        monto: 4000,
        doc_factura: { name: 'ccf2.pdf', storagePath: 'prod_files/prospects/P-HIST-LEGIT-FINANCIAL/facturas/ccf2.pdf' },
        opId: 'op-hist-inv-02'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(histId).get()).data();
      expect(updated.facturas.length).toBe(2);
      expect(updated.facturas[1].numero).toBe('CCF-HIST-002');
    });

    test('7.2 savePayment permitido en venta histórica legítimamente cerrada', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.savePayment({
        caller: caller('gestor', 'GES-01'),
        prospectId: histId,
        invoiceId: 'F_HIST_1',
        monto: 1500,
        metodo: 'transferencia',
        ref: 'TR-HIST-100',
        doc_comprobante: { name: 'comprobante_banco.pdf', storagePath: 'prod_files/prospects/P-HIST-LEGIT-FINANCIAL/pagos/comprobante_banco.pdf' },
        opId: 'op-hist-pay-01'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(histId).get()).data();
      expect(updated.facturas[0].pagos.length).toBe(1);
      expect(updated.facturas[0].pagos[0].monto).toBe(1500);
    });

    test('7.3 saveChangeOrder permitido en venta histórica legítimamente cerrada', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.saveChangeOrder({
        caller: caller('manager'),
        prospectId: histId,
        tipo: 'aumento',
        precio: 800,
        costo: 500,
        desc: 'Ampliación de contrato histórico',
        opId: 'op-hist-co-01'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(histId).get()).data();
      expect(updated.ordenes_cambio.length).toBe(1);
      expect(updated.ordenes_cambio[0].precio).toBe(800);
    });
  });

  // =========================================================================
  // SCENARIO 8: Facturación, pagos y órdenes de cambio permitidos para ventas finalizadas nuevas
  // =========================================================================
  describe('8. Facturación, pagos y órdenes de cambio permitidos para ventas finalizadas con flujo nuevo', () => {
    let env;
    let newFinalizedId;
    beforeEach(async () => {
      env = makeEnv();
      newFinalizedId = 'P-NEW-FINAL-FINANCIAL';
      await env.fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await env.fdb.seed(`prospects_prod/${newFinalizedId}`, {
        id: newFinalizedId,
        codigo: '202610002',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        precio_cotizado: 8000,
        fecha_postcierre: '2026-10-25T10:00:00.000Z',
        fecha_cierre: '2026-10-25T10:00:00.000Z',
        fecha_finalizacion: '2026-10-25T10:00:00.000Z',
        facturas: [
          {
            id: 'F_NEW_1',
            numero: 'CCF-ADV-001',
            monto: 2400,
            pagos: [],
            fecha: '2026-10-25T10:00:00.000Z'
          }
        ]
      });
    });

    test('8.1 saveInvoice permitido en oportunidad finalizada con flujo nuevo', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.saveInvoice({
        caller: caller('gestor', 'GES-01'),
        prospectId: newFinalizedId,
        numero: 'CCF-ADV-002',
        monto: 3000,
        doc_factura: { name: 'f2.pdf', storagePath: 'prod_files/prospects/P-NEW-FINAL-FINANCIAL/facturas/f2.pdf' },
        opId: 'op-new-inv-02'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(newFinalizedId).get()).data();
      expect(updated.facturas.length).toBe(2);
    });

    test('8.2 savePayment permitido en oportunidad finalizada con flujo nuevo', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.savePayment({
        caller: caller('gestor', 'GES-01'),
        prospectId: newFinalizedId,
        invoiceId: 'F_NEW_1',
        monto: 1200,
        metodo: 'cheque',
        ref: 'CHQ-555',
        doc_comprobante: { name: 'cheque.pdf', storagePath: 'prod_files/prospects/P-NEW-FINAL-FINANCIAL/pagos/cheque.pdf' },
        opId: 'op-new-pay-01'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(newFinalizedId).get()).data();
      expect(updated.facturas[0].pagos.length).toBe(1);
    });

    test('8.3 saveChangeOrder permitido en oportunidad finalizada con flujo nuevo', async () => {
      const { wfSvc, caller, fdb } = env;
      const res = await wfSvc.saveChangeOrder({
        caller: caller('manager'),
        prospectId: newFinalizedId,
        tipo: 'aumento',
        precio: 600,
        costo: 350,
        desc: 'Adición de rejillas',
        opId: 'op-new-co-01'
      });
      expect(res.status).toBe('created');
      const updated = (await fdb.collection('prospects_prod').doc(newFinalizedId).get()).data();
      expect(updated.ordenes_cambio.length).toBe(1);
    });
  });

  // =========================================================================
  // SCENARIO 9: Preservación de pruebas existentes, bypass y idempotencia
  // =========================================================================
  describe('9. Preservación del flujo de Cierre, autorización sin contrato e idempotencia', () => {
    test('9.1 Avanzar a Cierre sin finalizar mantiene postcierre deshabilitado', async () => {
      const { fdb, wfSvc, caller, hasEnteredPostclosing } = makeEnv();
      const pId = 'P-ADV-CIERRE-01';
      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed(`prospects_prod/${pId}`, {
        id: pId,
        codigo: '202610003',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'negociacion',
        estado: 'activo',
        precio_cotizado: 5000,
        costo_venta: 3000,
        facturas: []
      });

      const res = await wfSvc.advanceStage({
        caller: caller('vendedor', 'V-01'),
        prospectId: pId,
        nextStage: 'cierre',
        data: {}
      });
      expect(res.status).toBe('advanced');
      expect(res.etapa).toBe('cierre');

      const updated = (await fdb.collection('prospects_prod').doc(pId).get()).data();
      expect(updated.estado).toBe('activo');
      expect(updated.postcierre_habilitado).toBe(false);
      expect(hasEnteredPostclosing(updated)).toBe(false);
    });

    test('9.2 Finalización con autorización sin contrato habilita postcierre', async () => {
      const { fdb, wfSvc, caller, hasEnteredPostclosing } = makeEnv();
      const pId = 'P-FIN-BYPASS-01';
      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed(`prospects_prod/${pId}`, {
        id: pId,
        codigo: '202610004',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        precio_cotizado: 15000,
        costo_venta: 9000,
        datos: {
          autorizado_sin_contrato: true,
          autorizado_por: 'Gerente General'
        },
        facturas: []
      });

      const res = await wfSvc.finalizeProspect({
        caller: caller('manager'),
        prospectId: pId,
        data: {
          forma_pago: '50/50',
          factura_anticipo: 'CCF-BYPASS-001',
          doc_firmado: { name: 'oferta_firmada.pdf', storagePath: 'prod_files/prospects/P-FIN-BYPASS-01/cierre/oferta_firmada.pdf' },
          doc_comprobante: { name: 'recibo_anticipo.pdf', storagePath: 'prod_files/prospects/P-FIN-BYPASS-01/facturas/recibo_anticipo.pdf' }
        },
        opId: 'op-fin-bypass-01'
      });
      expect(res.status).toBe('finalized');
      expect(res.estado).toBe('ganado');

      const updated = (await fdb.collection('prospects_prod').doc(pId).get()).data();
      expect(updated.postcierre_habilitado).toBe(true);
      expect(hasEnteredPostclosing(updated)).toBe(true);
    });

    test('9.3 Reintento de finalización es idempotente y no duplica facturas ni altera postcierre', async () => {
      const { fdb, wfSvc, caller, hasEnteredPostclosing } = makeEnv();
      const pId = 'P-FIN-IDEM-01';
      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed(`prospects_prod/${pId}`, {
        id: pId,
        codigo: '202610005',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        precio_cotizado: 5000,
        costo_venta: 3000,
        facturas: []
      });

      const opId = 'op-idempotent-finalization-01';
      const finData = {
        forma_pago: '50/50',
        factura_anticipo: 'CCF-IDEM-001',
        doc_firmado: { name: 'oferta_firmada.pdf', storagePath: 'prod_files/prospects/P-FIN-IDEM-01/cierre/oferta_firmada.pdf' },
        doc_comprobante: { name: 'ccf.pdf', storagePath: 'prod_files/prospects/P-FIN-IDEM-01/facturas/ccf.pdf' }
      };

      const res1 = await wfSvc.finalizeProspect({
        caller: caller('manager'),
        prospectId: pId,
        data: finData,
        opId
      });
      expect(res1.status).toBe('finalized');

      // Segundo intento con el mismo opId
      const res2 = await wfSvc.finalizeProspect({
        caller: caller('manager'),
        prospectId: pId,
        data: finData,
        opId
      });
      expect(res2.status).toBe('already_finalized');
      expect(res2.estado).toBe('ganado');

      const updated = (await fdb.collection('prospects_prod').doc(pId).get()).data();
      expect(updated.facturas.length).toBe(1);
      expect(updated.postcierre_habilitado).toBe(true);
      expect(hasEnteredPostclosing(updated)).toBe(true);
    });
  });

  // =========================================================================
  // SCENARIO 10: Verificación expresa de autorización real en backend y paridad
  // =========================================================================
  describe('10. Verificación expresa de autorización real en backend y casos límite solicitados', () => {
    // 10.1: Oportunidad perdida con factura residual
    test('10.1 Oportunidad perdida con factura residual: denegada en helpers y rechazada en servicios financieros y descarga', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, storageSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const pLostResidual = {
        id: 'P-TEST-LOST-RESIDUAL',
        codigo: '202610010',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cotizacion',
        estado: 'perdido',
        motivo_perdida: 'Presupuesto no aceptado',
        facturas: [
          { id: 'F_RES_1', numero: 'FAC-DRAFT-01', monto: 1200, pagos: [] }
        ]
      };

      // Validación en los cuatro helpers
      expect(hasEnteredPostclosing(pLostResidual)).toBe(false);
      expect(commHasEnteredPostclosing(pLostResidual)).toBe(false);
      expect(wfHasEnteredPostclosing(pLostResidual)).toBe(false);
      expect(storageHasEnteredPostclosing(pLostResidual)).toBe(false);
      expect(frontendHasEnteredPostclosing(pLostResidual)).toBe(false);

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-LOST-RESIDUAL', pLostResidual);

      // Llamada real a backend financiero: bloqueada
      await expect(wfSvc.saveInvoice({
        caller: caller('manager'),
        prospectId: 'P-TEST-LOST-RESIDUAL',
        numero: 'CCF-LOST-NEW',
        monto: 500,
        doc_factura: { name: 'f.pdf', storagePath: 'prod_files/prospects/P-TEST-LOST-RESIDUAL/facturas/f.pdf' },
        opId: 'op-inv-lost-res-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');

      await expect(wfSvc.savePayment({
        caller: caller('manager'),
        prospectId: 'P-TEST-LOST-RESIDUAL',
        invoiceId: 'F_RES_1',
        monto: 200,
        metodo: 'transferencia',
        ref: 'REF-01',
        doc_comprobante: { name: 'rec.pdf', storagePath: 'prod_files/prospects/P-TEST-LOST-RESIDUAL/pagos/rec.pdf' },
        opId: 'op-pay-lost-res-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');

      await expect(wfSvc.saveChangeOrder({
        caller: caller('manager'),
        prospectId: 'P-TEST-LOST-RESIDUAL',
        tipo: 'aumento',
        precio: 300,
        costo: 100,
        desc: 'Aumento no autorizado',
        opId: 'op-co-lost-res-01'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');

      await expect(wfSvc.deleteInvoice({
        caller: caller('manager'),
        prospectId: 'P-TEST-LOST-RESIDUAL',
        invoiceId: 'F_RES_1'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');

      // Gestor ajeno no tiene acceso a descarga por no haber entrado a postcierre
      await expect(storageSvc.getSecureDownloadUrl({
        caller: caller('gestor', 'GES-OTHER'),
        storagePath: 'prod_files/prospects/P-TEST-LOST-RESIDUAL/facturas/f.pdf',
        prospectId: 'P-TEST-LOST-RESIDUAL'
      })).rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });

    // 10.2: Oportunidad perdida con postcierre_habilitado === true
    test('10.2 Oportunidad perdida con postcierre_habilitado === true: autorizada en helpers, auditoría y liquidación por Gestor/Manager', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, storageSvc, mockFiles, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const filePath = 'prod_files/prospects/P-TEST-LOST-POST/cierre/contrato.pdf';
      mockFiles.set(filePath, { size: 5000, contentType: 'application/pdf' });

      const pLostPost = {
        id: 'P-TEST-LOST-POST',
        codigo: '202610011',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'perdido',
        motivo_perdida: 'Cancelación post-cierre por mutuo acuerdo',
        postcierre_habilitado: true,
        fecha_cierre: '2026-03-01T10:00:00.000Z',
        fecha_postcierre: '2026-03-01T10:00:00.000Z',
        facturas: [
          { id: 'F_POST_1', numero: 'CCF-POST-01', monto: 5000, pagos: [] }
        ],
        ordenes_cambio: []
      };

      // Validación en los cuatro helpers: conserva postcierre
      expect(hasEnteredPostclosing(pLostPost)).toBe(true);
      expect(commHasEnteredPostclosing(pLostPost)).toBe(true);
      expect(wfHasEnteredPostclosing(pLostPost)).toBe(true);
      expect(storageHasEnteredPostclosing(pLostPost)).toBe(true);
      expect(frontendHasEnteredPostclosing(pLostPost)).toBe(true);

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-LOST-POST', pLostPost);

      // Gestor conserva acceso a expediente y descarga documental para auditoría (SEC-04/06)
      const gestorCaller = caller('gestor', 'GES-01');
      const dlRes = await storageSvc.getSecureDownloadUrl({
        caller: gestorCaller,
        storagePath: filePath,
        prospectId: 'P-TEST-LOST-POST'
      });
      expect(dlRes.signedUrl).toBeDefined();

      // Gestor puede registrar liquidación / pagos pendientes en proyecto que estuvo formalmente en postcierre
      const payRes = await wfSvc.savePayment({
        caller: gestorCaller,
        prospectId: 'P-TEST-LOST-POST',
        invoiceId: 'F_POST_1',
        monto: 2500,
        metodo: 'transferencia',
        ref: 'ABONO-LIQ',
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P-TEST-LOST-POST/pagos/recibo.pdf' },
        opId: 'op-pay-lost-post'
      });
      expect(payRes.status).toBe('created');

      // Gestor puede registrar orden de cambio de ajuste / rescisión en proyecto postcierre
      const coRes = await wfSvc.saveChangeOrder({
        caller: gestorCaller,
        prospectId: 'P-TEST-LOST-POST',
        tipo: 'aumento',
        precio: 300,
        costo: 180,
        desc: 'Ajuste de cancelación postcierre',
        opId: 'op-co-lost-post'
      });
      expect(coRes.status).toBe('created');

      // Vendedor sigue estrictamente bloqueado de operaciones financieras (pagos y órdenes de cambio)
      await expect(wfSvc.savePayment({
        caller: caller('vendedor', 'V-01'),
        prospectId: 'P-TEST-LOST-POST',
        invoiceId: 'F_POST_1',
        monto: 500,
        metodo: 'transferencia',
        ref: 'TR-FAIL',
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P-TEST-LOST-POST/pagos/recibo.pdf' },
        opId: 'op-pay-vendedor-fail'
      })).rejects.toThrow('Tu rol no puede realizar esta operación');

      await expect(wfSvc.saveChangeOrder({
        caller: caller('vendedor', 'V-01'),
        prospectId: 'P-TEST-LOST-POST',
        tipo: 'aumento',
        precio: 100,
        costo: 50,
        desc: 'Intento vendedor',
        opId: 'op-co-vendedor-fail'
      })).rejects.toThrow('Tu rol no puede realizar esta operación');
    });

    // 10.3: Oportunidad activa con documentos parciales
    test('10.3 Oportunidad activa con documentos parciales: helpers deniegan y servicios financieros rechazan', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const pActivePartial = {
        id: 'P-TEST-ACTIVE-PARTIAL',
        codigo: '202610012',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        fecha_inicio_cierre: '2026-10-25T08:00:00.000Z',
        contrato_archivo: { name: 'contrato_borrador.pdf', storagePath: 'prod_files/prospects/P-TEST-ACTIVE-PARTIAL/cierre/contrato_borrador.pdf' },
        datos: {
          doc_firmado: { name: 'oferta.pdf', storagePath: 'prod_files/prospects/P-TEST-ACTIVE-PARTIAL/cierre/oferta.pdf' }
        },
        facturas: []
      };

      // Validación en los cuatro helpers: activo sin formalizar es falso
      expect(hasEnteredPostclosing(pActivePartial)).toBe(false);
      expect(commHasEnteredPostclosing(pActivePartial)).toBe(false);
      expect(wfHasEnteredPostclosing(pActivePartial)).toBe(false);
      expect(storageHasEnteredPostclosing(pActivePartial)).toBe(false);
      expect(frontendHasEnteredPostclosing(pActivePartial)).toBe(false);

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-ACTIVE-PARTIAL', pActivePartial);

      // Toda operación financiera es rechazada
      await expect(wfSvc.saveInvoice({
        caller: caller('manager'),
        prospectId: 'P-TEST-ACTIVE-PARTIAL',
        numero: 'CCF-PARTIAL-01',
        monto: 1000,
        doc_factura: { name: 'f.pdf', storagePath: 'prod_files/prospects/P-TEST-ACTIVE-PARTIAL/facturas/f.pdf' },
        opId: 'op-inv-act-fail'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');

      await expect(wfSvc.saveChangeOrder({
        caller: caller('manager'),
        prospectId: 'P-TEST-ACTIVE-PARTIAL',
        tipo: 'aumento',
        precio: 200,
        costo: 100,
        desc: 'Cambio previo al cierre',
        opId: 'op-co-act-fail'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    // 10.4: Venta histórica cerrada con evidencia contable válida
    test('10.4 Venta histórica cerrada con evidencia contable válida: helpers conceden y servicios financieros permiten operaciones', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, storageSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const pHistValid = {
        id: 'P-TEST-HIST-VALID',
        codigo: '202502001',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        precio_cotizado: 10000,
        fecha_cierre: '2025-02-10T12:00:00.000Z',
        facturas: [
          { id: 'F_HIST_VALID_1', numero: 'CCF-098-HIST', monto: 4500, pagos: [] }
        ]
      };

      // Validación en los cuatro helpers
      expect(hasEnteredPostclosing(pHistValid)).toBe(true);
      expect(commHasEnteredPostclosing(pHistValid)).toBe(true);
      expect(wfHasEnteredPostclosing(pHistValid)).toBe(true);
      expect(storageHasEnteredPostclosing(pHistValid)).toBe(true);
      expect(frontendHasEnteredPostclosing(pHistValid)).toBe(true);

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-HIST-VALID', pHistValid);

      // Operaciones financieras permitidas
      const invRes = await wfSvc.saveInvoice({
        caller: caller('gestor', 'GES-01'),
        prospectId: 'P-TEST-HIST-VALID',
        numero: 'CCF-099-HIST',
        monto: 2000,
        doc_factura: { name: 'f2.pdf', storagePath: 'prod_files/prospects/P-TEST-HIST-VALID/facturas/f2.pdf' },
        opId: 'op-hist-inv-val'
      });
      expect(invRes.status).toBe('created');

      const payRes = await wfSvc.savePayment({
        caller: caller('gestor', 'GES-01'),
        prospectId: 'P-TEST-HIST-VALID',
        invoiceId: 'F_HIST_VALID_1',
        monto: 1500,
        metodo: 'transferencia',
        ref: 'TR-HIST-VAL',
        doc_comprobante: { name: 'rec.pdf', storagePath: 'prod_files/prospects/P-TEST-HIST-VALID/pagos/rec.pdf' },
        opId: 'op-hist-pay-val'
      });
      expect(payRes.status).toBe('created');
    });

    // 10.5: Venta histórica con solo forma de pago y fecha
    test('10.5 Venta histórica con solo forma de pago y fecha: helpers deniegan y servicios financieros rechazan', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const pHistPaymentOnly = {
        id: 'P-TEST-HIST-PAYMENT-ONLY',
        codigo: '202504001',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        etapa: 'cierre',
        estado: 'ganado',
        fecha_cierre: '2025-04-15T10:00:00.000Z',
        forma_pago: '50/50',
        facturas: []
      };

      // Criterio 4: forma_pago aislada no constituye prueba formalizada
      expect(hasEnteredPostclosing(pHistPaymentOnly)).toBe(false);
      expect(commHasEnteredPostclosing(pHistPaymentOnly)).toBe(false);
      expect(wfHasEnteredPostclosing(pHistPaymentOnly)).toBe(false);
      expect(storageHasEnteredPostclosing(pHistPaymentOnly)).toBe(false);
      expect(frontendHasEnteredPostclosing(pHistPaymentOnly)).toBe(false);

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-HIST-PAYMENT-ONLY', pHistPaymentOnly);

      await expect(wfSvc.saveInvoice({
        caller: caller('manager'),
        prospectId: 'P-TEST-HIST-PAYMENT-ONLY',
        numero: 'CCF-FAIL',
        monto: 1000,
        doc_factura: { name: 'f.pdf', storagePath: 'prod_files/prospects/P-TEST-HIST-PAYMENT-ONLY/facturas/f.pdf' },
        opId: 'op-inv-pay-only-fail'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    // 10.6: Venta histórica con factura incompleta o mal formada
    test('10.6 Venta histórica con factura incompleta o mal formada: validación estricta de esquema contable', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const malformedCases = [
        { desc: 'facturas vacías', facturas: [] },
        { desc: 'objeto factura vacío', facturas: [{}] },
        { desc: 'número vacío', facturas: [{ numero: '', monto: 500 }] },
        { desc: 'número solo espacios', facturas: [{ numero: '   ', monto: 500 }] },
        { desc: 'monto cero', facturas: [{ numero: 'CCF-01', monto: 0 }] },
        { desc: 'monto negativo', facturas: [{ numero: 'CCF-01', monto: -100 }] },
        { desc: 'monto no numérico', facturas: [{ numero: 'CCF-01', monto: 'invalido' }] },
        { desc: 'elemento nulo en facturas', facturas: [null] },
        { desc: 'elemento undefined en facturas', facturas: [undefined] }
      ];

      for (const c of malformedCases) {
        const obj = {
          id: `P-MALFORMED-${c.desc}`,
          estado: 'ganado',
          fecha_cierre: '2025-01-10T10:00:00.000Z',
          facturas: c.facturas
        };
        expect(hasEnteredPostclosing(obj)).toBe(false);
        expect(commHasEnteredPostclosing(obj)).toBe(false);
        expect(wfHasEnteredPostclosing(obj)).toBe(false);
        expect(storageHasEnteredPostclosing(obj)).toBe(false);
        expect(frontendHasEnteredPostclosing(obj)).toBe(false);
      }

      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed('prospects_prod/P-TEST-MALFORMED-DB', {
        id: 'P-TEST-MALFORMED-DB',
        codigo: '202501002',
        clientId: 'C-01',
        createdBy: 'V-OLD',
        vendedorId: 'V-OLD',
        estado: 'ganado',
        fecha_cierre: '2025-01-10T10:00:00.000Z',
        facturas: [{ numero: '', monto: 0 }]
      });

      await expect(wfSvc.saveInvoice({
        caller: caller('manager'),
        prospectId: 'P-TEST-MALFORMED-DB',
        numero: 'CCF-ATTEMPT',
        monto: 1000,
        doc_factura: { name: 'f.pdf', storagePath: 'prod_files/prospects/P-TEST-MALFORMED-DB/facturas/f.pdf' },
        opId: 'op-inv-malformed-fail'
      })).rejects.toThrow('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    });

    // 10.7: Oportunidad nueva finalizada correctamente
    test('10.7 Oportunidad nueva finalizada correctamente: habilitación transaccional completa y operaciones financieras autorizadas', async () => {
      const env = makeEnv();
      const { fdb, wfSvc, caller, hasEnteredPostclosing, frontendHasEnteredPostclosing, commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing } = env;

      const pId = 'P-TEST-NEW-FINALIZE';
      await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
      await fdb.seed(`prospects_prod/${pId}`, {
        id: pId,
        codigo: '202610013',
        clientId: 'C-01',
        createdBy: 'V-01',
        vendedorId: 'V-01',
        etapa: 'cierre',
        estado: 'activo',
        postcierre_habilitado: false,
        precio_cotizado: 6000,
        costo_venta: 3500,
        facturas: []
      });

      const finRes = await wfSvc.finalizeProspect({
        caller: caller('manager'),
        prospectId: pId,
        data: {
          forma_pago: '50/50',
          factura_anticipo: 'CCF-FIN-NEW-01',
          doc_firmado: { name: 'oferta_firmada.pdf', storagePath: `prod_files/prospects/${pId}/cierre/oferta_firmada.pdf` },
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: `prod_files/prospects/${pId}/facturas/ccf_anticipo.pdf` }
        },
        opId: 'op-fin-test-10-7'
      });
      expect(finRes.status).toBe('finalized');
      expect(finRes.estado).toBe('ganado');

      const after = (await fdb.collection('prospects_prod').doc(pId).get()).data();
      expect(after.postcierre_habilitado).toBe(true);
      expect(hasEnteredPostclosing(after)).toBe(true);
      expect(commHasEnteredPostclosing(after)).toBe(true);
      expect(wfHasEnteredPostclosing(after)).toBe(true);
      expect(storageHasEnteredPostclosing(after)).toBe(true);
      expect(frontendHasEnteredPostclosing(after)).toBe(true);

      // Gestor realiza cobro y cambio posteriores sin restricción
      const invRes = await wfSvc.saveInvoice({
        caller: caller('gestor', 'GES-01'),
        prospectId: pId,
        numero: 'CCF-FIN-NEW-02',
        monto: 3000,
        doc_factura: { name: 'f2.pdf', storagePath: `prod_files/prospects/${pId}/facturas/f2.pdf` },
        opId: 'op-inv-10-7'
      });
      expect(invRes.status).toBe('created');
    });

    // 10.8: Coherencia entre las cuatro implementaciones del helper
    test('10.8 Coherencia y paridad idéntica entre las cuatro implementaciones del helper hasEnteredPostclosing', () => {
      const { commHasEnteredPostclosing, wfHasEnteredPostclosing, storageHasEnteredPostclosing, frontendHasEnteredPostclosing } = makeEnv();

      const testMatrix = [
        null,
        undefined,
        12345,
        'cadena_invalida',
        {},
        { postcierre_habilitado: false },
        { etapa: 'cierre', estado: 'activo', postcierre_habilitado: false },
        { etapa: 'cierre', estado: 'activo', fecha_inicio_cierre: '2026-10-25T08:00:00.000Z' },
        { etapa: 'cierre', estado: 'activo', stage_timestamps: { cierre: '2026-10-25T08:00:00.000Z' } },
        { etapa: 'cierre', estado: 'activo', contrato_archivo: { name: 'c.pdf' } },
        { etapa: 'cierre', estado: 'activo', facturas: [{ numero: 'CCF-01', monto: 1000 }] },
        { etapa: 'cotizacion', estado: 'activo', fecha_cierre: '2025-01-01' },
        { estado: 'perdido', facturas: [{ numero: 'CCF-RESIDUAL', monto: 800 }] },
        { estado: 'perdido', postcierre_habilitado: true },
        { estado: 'perdido', stage_timestamps: { cierre: '2025-01-01' } },
        { estado: 'ganado', fecha_cierre: '2025-01-01', forma_pago: '50/50' },
        { estado: 'ganado', fecha_cierre: '2025-01-01', facturas: [{ numero: '', monto: 0 }] },
        { estado: 'ganado', fecha_cierre: '2025-01-01', facturas: [{ numero: 'CCF-LEGIT', monto: 2000 }] },
        { estado: 'ganado', fecha_cierre: '2025-01-01', contrato_archivo: { name: 'c.pdf' } },
        { estado: 'ganado', fecha_cierre: '2025-01-01', datos: { doc_contrato: { name: 'c.pdf' }, doc_comprobante: { name: 'rec.pdf' } } },
        { estado: 'ganado', fecha_postcierre: '2025-01-01', autorizado_sin_contrato: true, doc_comprobante: { name: 'rec.pdf' } },
        { estado: 'ganado', fecha_cierre: '2025-01-01', autorizado_sin_contrato: true },
        { estado: 'ganado' } // huérfano
      ];

      testMatrix.forEach((prospect, idx) => {
        const resComm = commHasEnteredPostclosing(prospect);
        const resWf = wfHasEnteredPostclosing(prospect);
        const resStorage = storageHasEnteredPostclosing(prospect);
        const resFrontend = frontendHasEnteredPostclosing(prospect);

        expect(resWf).toBe(resComm);
        expect(resStorage).toBe(resComm);
        expect(resFrontend).toBe(resComm);
      });
    });
  });
});
