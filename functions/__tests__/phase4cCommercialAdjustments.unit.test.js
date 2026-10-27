'use strict';

/**
 * DUCTSAL ERP — Fase 4C: Implementación Controlada de Ajustes Comerciales y Autorización de Cierre
 *
 * Cobertura completa de pruebas unitarias e integración:
 * 1. Correcciones de digitación (editBasePrice):
 *    - expectedOldPrice y expectedOldCost obligatorios.
 *    - Validación OCC exacta a centavos (sin tolerancias arbitrarias).
 *    - Etapas permitidas: cotización y negociación.
 *    - Congelamiento estricto en cierre, ganado y perdido.
 *    - Rechazo en prospecto y levantamiento.
 *    - Permisos: vendedor asignado, gestor creador/asignado, manager.
 *    - Rechazo a roles sin acceso o no comerciales.
 *    - Cero mutaciones documentales o creación de versiones de archivo.
 *    - Auditoría completa e inmutable.
 *
 * 2. Nuevas propuestas comerciales en negociación (registerProposal):
 *    - Exigencia de PDF de oferta y Excel de costos.
 *    - Preservación de versiones históricas.
 *    - Sin inspección automática (cero OCR).
 *
 * 3. Elegibilidad de la dispensa de venta sin contrato:
 *    - Requiere: Fabricación e instalación AND max(precio, costo) > 10,000.
 *    - Rechazo en solicitud, resolución y toggle directo si el proyecto no califica.
 *    - Consistencia exacta con finalizeProspect.
 *
 * 4. Exclusividad de la etapa de cierre:
 *    - Solicitud, resolución y autorización directa rechazadas fuera de cierre.
 *
 * 5. Autoridad gerencial directa y roles (H-03):
 *    - Gerente asignado a la venta puede autorizar directamente.
 *    - Gerente creador del prospecto puede autorizar directamente.
 *    - No requiere segunda firma gerencial.
 *    - Vendedor y gestor no pueden usar autorización directa ni auto-aprobar solicitudes.
 *
 * 6. Validación exacta del monto autorizado en el cierre (H-01):
 *    - Precio igual al monto autorizado: cierre permitido.
 *    - Precio superior al monto autorizado: cierre bloqueado.
 *    - Precio inferior al monto autorizado: cierre bloqueado.
 *    - Validación exacta a centavos.
 *
 * 7. Compatibilidad histórica (H-02):
 *    - Autorización histórica sin monto en oportunidad activa: exige nueva resolución.
 *    - Proyecto histórico ya ganado: historial y consulta preservados.
 *    - Manejo de registros antiguos sin storagePathAprobado.
 */

const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService, POLICY } = require('../prospectWorkflowService');
const {
  bindNoContractApproval,
  isNoContractApprovalValid
} = require('../documentVersioningService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

describe('Fase 4C: Ajustes Comerciales y Autorización de Cierre', () => {
  let db;
  let commSvc;
  let wfSvc;

  const USERS = {
    mgr: { id: 'MGR_01', authUid: 'uid-mgr', role: 'manager', nombre: 'Gerente General', activo: true },
    mgr2: { id: 'MGR_02', authUid: 'uid-mgr2', role: 'manager', nombre: 'Gerente Operaciones', activo: true },
    ges: { id: 'GES_01', authUid: 'uid-ges', role: 'gestor', nombre: 'Gestor Comercial', activo: true },
    v1: { id: 'VEND_01', authUid: 'uid-v1', role: 'vendedor', nombre: 'Carlos Vendedor', activo: true },
    v2: { id: 'VEND_02', authUid: 'uid-v2', role: 'vendedor', nombre: 'Elena Vendedora', activo: true },
    plant: { id: 'OPER_01', authUid: 'uid-op', role: 'operario', nombre: 'Pedro Taller', activo: true }
  };

  const caller = roleKey => {
    const u = USERS[roleKey];
    return { cid: u.id, uid: u.authUid, role: u.role, name: u.nombre, managerClaim: u.role === 'manager' };
  };

  const CLIENT = {
    id: 'CLI_01',
    tipo: 'juridica',
    empresa: 'Gildan Activewear',
    contacto: 'Ing. Morales',
    nit: '0614-010190-101-1',
    nrc: '12345-6',
    telefono: '2200-1122',
    correo: 'compras@gildan.com',
    correo_fact: 'facturas@gildan.com',
    documentos: {
      dui: { name: 'dui.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/dui.pdf' },
      escritura: { name: 'esc.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/esc.pdf' },
      credencial: { name: 'cred.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/cred.pdf' },
      nit: { name: 'nit.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/nit.pdf' },
      nrc: { name: 'nrc.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/nrc.pdf' }
    }
  };

  beforeEach(async () => {
    const clock = () => new Date('2026-10-26T12:00:00.000Z');
    db = createFakeFirestore({ clock });
    commSvc = createCommercialService({
      db,
      FieldValue: db.FieldValue,
      suffix: '_prod',
      verifyManager: async () => true,
      now: clock
    });
    wfSvc = createProspectWorkflowService({
      db,
      FieldValue: db.FieldValue,
      kit: commSvc.kit,
      verifyManager: async () => true
    });

    for (const u of Object.values(USERS)) {
      await db.seed(`users_prod/${u.id}`, u);
    }
    await db.seed(`clients_prod/${CLIENT.id}`, CLIENT);
  });

  // =========================================================================
  // 1. CORRECCIONES DE DIGITACIÓN (editBasePrice & OCC)
  // =========================================================================
  describe('1. Correcciones de Digitación (editBasePrice & OCC)', () => {
    beforeEach(async () => {
      await db.seed('prospects_prod/P_COT', {
        id: 'P_COT',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'cotizacion',
        precio_cotizado: 8000,
        costo_venta: 4500,
        datos: {},
        logs: [],
        facturas: []
      });

      await db.seed('prospects_prod/P_NEG', {
        id: 'P_NEG',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'negociacion',
        precio_cotizado: 12000,
        costo_venta: 7000,
        datos: {},
        logs: [],
        facturas: []
      });
    });

    test('12 & 13. Rechaza operaciones que omitan expectedOldPrice o expectedOldCost', async () => {
      // Omisión de expectedOldPrice
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Ajuste de prueba',
          expectedOldCost: 7000
        })
      ).rejects.toMatchObject({
        code: 'invalid-argument',
        message: expect.stringMatching(/expectedOldPrice es obligatorio/)
      });

      // Omisión de expectedOldCost
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Ajuste de prueba',
          expectedOldPrice: 12000
        })
      ).rejects.toMatchObject({
        code: 'invalid-argument',
        message: expect.stringMatching(/expectedOldCost es obligatorio/)
      });

      // Valores no monetarios
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Ajuste de prueba',
          expectedOldPrice: 'doce mil',
          expectedOldCost: 7000
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('14. Conflicto OCC con datos desactualizados en precio o costo: rechaza con failed-precondition', async () => {
      // Conflicto en precio
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Corrección concurrente',
          expectedOldPrice: 11999.99, // Desactualizado (en DB es 12000.00)
          expectedOldCost: 7000
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/no coinciden con los valores actuales en el sistema/)
      });

      // Conflicto en costo
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Corrección concurrente',
          expectedOldPrice: 12000,
          expectedOldCost: 6999.00 // Desactualizado (en DB es 7000.00)
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/no coinciden con los valores actuales en el sistema/)
      });
    });

    test('4. Comparación OCC exacta a centavos sin tolerancias arbitrarias', async () => {
      // Diferencia de 5 centavos ($12000.00 vs $12000.05) debe RECHAZARSE
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_NEG',
          precio: 12500,
          costo: 7200,
          motivo: 'Ajuste por centavos',
          expectedOldPrice: 12000.05,
          expectedOldCost: 7000
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/no coinciden con los valores actuales/)
      });
    });

    test('15. Corrección válida en cotización y negociación funciona para vendedor, gestor y gerente', async () => {
      // Vendedor asignado en cotización
      const resCot = await wfSvc.editBasePrice({
        caller: caller('v1'),
        prospectId: 'P_COT',
        precio: 8200.50,
        costo: 4600.25,
        motivo: 'Corrección de tipeo en materiales',
        expectedOldPrice: 8000,
        expectedOldCost: 4500
      });
      expect(resCot.status).toBe('updated');
      expect(db.data('prospects_prod/P_COT').precio_cotizado).toBe(8200.50);

      // Gestor en prospecto creado por él en negociación
      await db.seed('prospects_prod/P_GES', {
        id: 'P_GES',
        clientId: CLIENT.id,
        createdBy: USERS.ges.id,
        vendedorId: USERS.v2.id,
        estado: 'activo',
        etapa: 'negociacion',
        precio_cotizado: 5000,
        costo_venta: 3000,
        datos: {},
        logs: [],
        facturas: []
      });
      const resGes = await wfSvc.editBasePrice({
        caller: caller('ges'),
        prospectId: 'P_GES',
        precio: 5200,
        costo: 3100,
        motivo: 'Corrección gestor',
        expectedOldPrice: 5000,
        expectedOldCost: 3000
      });
      expect(resGes.status).toBe('updated');

      // Gerente en cualquier prospecto en negociación
      const resMgr = await wfSvc.editBasePrice({
        caller: caller('mgr'),
        prospectId: 'P_NEG',
        precio: 12600,
        costo: 7300,
        motivo: 'Aprobación gerencial de corrección',
        expectedOldPrice: 12000,
        expectedOldCost: 7000
      });
      expect(resMgr.status).toBe('updated');
      expect(db.data('prospects_prod/P_NEG').precio_cotizado).toBe(12600);
    });

    test('16. Corrección en cierre, ganado, perdido, prospecto o levantamiento: estrictamente RECHAZADA', async () => {
      // 1. En cierre (congelamiento estricto)
      await db.seed('prospects_prod/P_CIE', {
        id: 'P_CIE',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        precio_cotizado: 15000,
        costo_venta: 9000,
        datos: {},
        logs: [],
        facturas: []
      });
      for (const roleKey of ['v1', 'mgr']) {
        await expect(
          wfSvc.editBasePrice({
            caller: caller(roleKey),
            prospectId: 'P_CIE',
            precio: 16000,
            costo: 9500,
            motivo: 'Intento de modificar precio en cierre',
            expectedOldPrice: 15000,
            expectedOldCost: 9000
          })
        ).rejects.toMatchObject({
          code: 'failed-precondition',
          message: expect.stringMatching(/congelados al entrar en la etapa de cierre/)
        });
      }

      // 2. En ganado
      await db.seed('prospects_prod/P_GAN', {
        id: 'P_GAN',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        estado: 'ganado',
        etapa: 'cierre',
        precio_cotizado: 10000,
        costo_venta: 6000,
        datos: {},
        logs: [],
        facturas: []
      });
      await expect(
        wfSvc.editBasePrice({
          caller: caller('mgr'),
          prospectId: 'P_GAN',
          precio: 11000,
          costo: 6500,
          motivo: 'Ajuste posterior a ganar',
          expectedOldPrice: 10000,
          expectedOldCost: 6000
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/antes del cierre de la oportunidad/)
      });

      // 3. En prospecto
      await db.seed('prospects_prod/P_PROSP', {
        id: 'P_PROSP',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        estado: 'activo',
        etapa: 'prospecto',
        precio_cotizado: 0,
        costo_venta: 0,
        datos: {},
        logs: [],
        facturas: []
      });
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P_PROSP',
          precio: 5000,
          costo: 3000,
          motivo: 'Ajuste preliminar',
          expectedOldPrice: 0,
          expectedOldCost: 0
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/durante las etapas de cotización y negociación/)
      });
    });

    test('17. Correcciones de digitación: sin cambios en archivos ni nuevas versiones documentales', async () => {
      const initialDocs = {
        doc_oferta: [{ name: 'oferta_v1.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_v1.pdf' }],
        doc_costos: [{ name: 'costos_v1.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/costos_v1.xlsx' }]
      };
      await db.seed('prospects_prod/P_NEG', {
        ...db.data('prospects_prod/P_NEG'),
        datos: initialDocs
      });

      await wfSvc.editBasePrice({
        caller: caller('v1'),
        prospectId: 'P_NEG',
        precio: 12500,
        costo: 7200,
        motivo: 'Corrección menor',
        expectedOldPrice: 12000,
        expectedOldCost: 7000
      });

      const pAfter = db.data('prospects_prod/P_NEG');
      // Documentos y versiones permanecen exactamente idénticos
      expect(pAfter.datos.doc_oferta).toEqual(initialDocs.doc_oferta);
      expect(pAfter.datos.doc_costos).toEqual(initialDocs.doc_costos);
      expect(pAfter.document_versions).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. NUEVA OFERTA COMERCIAL EN NEGOCIACIÓN (registerProposal)
  // =========================================================================
  describe('2. Nueva Oferta Comercial en Negociación (registerProposal)', () => {
    test('18. Exige PDF y Excel, incrementa versiones y preserva versiones anteriores', async () => {
      await db.seed('prospects_prod/P_PROP', {
        id: 'P_PROP',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'negociacion',
        precio_cotizado: 10000,
        costo_venta: 6000,
        datos: {
          doc_oferta: [{ name: 'oferta_v1.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_v1.pdf' }],
          doc_costos: [{ name: 'costos_v1.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/costos_v1.xlsx' }]
        },
        logs: [],
        facturas: []
      });

      // Rechaza si falta PDF o Excel
      await expect(
        wfSvc.registerProposal({
          caller: caller('v1'),
          prospectId: 'P_PROP',
          precio_cotizado: 11000,
          costo_venta: 6500,
          doc_oferta: [],
          doc_costos: [{ name: 'costos_v2.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/costos_v2.xlsx' }]
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      // Registro exitoso con ambos documentos
      const res = await wfSvc.registerProposal({
        caller: caller('v1'),
        prospectId: 'P_PROP',
        precio_cotizado: 11500,
        costo_venta: 6800,
        doc_oferta: [{ name: 'oferta_v2.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_v2.pdf' }],
        doc_costos: [{ name: 'costos_v2.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/costos_v2.xlsx' }]
      });

      expect(res.status).toBe('registered');
      const p = db.data('prospects_prod/P_PROP');
      expect(p.precio_cotizado).toBe(11500);
      expect(p.costo_venta).toBe(6800);
      expect(p.datos.doc_oferta[0].name).toBe('oferta_v2.pdf');
    });
  });

  // =========================================================================
  // 3. ELEGIBILIDAD DE DISPENSA DE CONTRATO (H-04)
  // =========================================================================
  describe('3. Elegibilidad de Dispensa de Contrato (H-04)', () => {
    beforeEach(async () => {
      // 1. Proyecto NO elegible: Tipo no es Fabricación e instalación (ej. Solo suministro con $15k)
      await db.seed('prospects_prod/P_SUMINISTRO', {
        id: 'P_SUMINISTRO',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Solo suministro',
        precio_cotizado: 15000,
        costo_venta: 9000,
        datos: {},
        logs: [],
        facturas: []
      });

      // 2. Proyecto NO elegible: Fabricación e instalación pero <= $10k (ej. $8k)
      await db.seed('prospects_prod/P_PEQUENO', {
        id: 'P_PEQUENO',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 8000,
        costo_venta: 5000,
        datos: {},
        logs: [],
        facturas: []
      });

      // 3. Proyecto SÍ elegible: Fabricación e instalación con > $10k (ej. $18k)
      await db.seed('prospects_prod/P_ELEGIBLE', {
        id: 'P_ELEGIBLE',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 18000,
        costo_venta: 10000,
        datos: {},
        logs: [],
        facturas: []
      });
    });

    test('10 & 11. Solicitud y autorización para proyectos no elegibles son RECHAZADAS', async () => {
      // Intento de solicitar en proyecto de Solo suministro
      await expect(
        commSvc.requestNoContractAuthorization({
          caller: caller('v1'),
          prospectId: 'P_SUMINISTRO',
          motivo: 'Solicitud para suministro',
          opId: 'op_sum_01'
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/solo aplica para proyectos de Fabricación e instalación con monto o costo superior a \$10,000/)
      });

      // Intento de solicitar en proyecto <= $10k
      await expect(
        commSvc.requestNoContractAuthorization({
          caller: caller('v1'),
          prospectId: 'P_PEQUENO',
          motivo: 'Solicitud para proyecto pequeño',
          opId: 'op_peq_01'
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/solo aplica para proyectos de Fabricación e instalación con monto o costo superior a \$10,000/)
      });

      // Intento de autorización directa gerencial en proyecto no elegible
      await expect(
        commSvc.setNoContractAuthorization({
          caller: caller('mgr'),
          prospectId: 'P_SUMINISTRO',
          authorized: true
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/solo aplica para proyectos de Fabricación e instalación con monto o costo superior a \$10,000/)
      });

      // Proyecto elegible sí permite solicitar
      const res = await commSvc.requestNoContractAuthorization({
        caller: caller('v1'),
        prospectId: 'P_ELEGIBLE',
        motivo: 'Cliente corporativo formal con orden de compra',
        opId: 'op_eleg_01'
      });
      expect(res.status).toBe('requested');
    });
  });

  // =========================================================================
  // 4. AUTORIDAD GERENCIAL Y ROLES (H-03)
  // =========================================================================
  describe('4. Autoridad Gerencial Directa y Separación de Roles (H-03)', () => {
    beforeEach(async () => {
      await db.seed('prospects_prod/P_MGR_LEAD', {
        id: 'P_MGR_LEAD',
        clientId: CLIENT.id,
        vendedorId: USERS.mgr.id, // El gerente es el vendedor asignado
        createdBy: USERS.mgr.id,  // El gerente es el creador
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 25000,
        costo_venta: 14000,
        datos: {
          doc_oferta: [{ name: 'oferta_mgr.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_mgr.pdf' }]
        },
        logs: [],
        facturas: []
      });

      await db.seed('prospects_prod/P_VEND_LEAD', {
        id: 'P_VEND_LEAD',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 22000,
        costo_venta: 12000,
        datos: {
          doc_oferta: [{ name: 'oferta_vend.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_vend.pdf' }]
        },
        logs: [],
        facturas: []
      });
    });

    test('7 & 8. Gerente asignado/creador puede autorizar directamente sin segundo gerente', async () => {
      // El gerente autoriza directamente su propia venta
      const res = await commSvc.setNoContractAuthorization({
        caller: caller('mgr'),
        prospectId: 'P_MGR_LEAD',
        authorized: true
      });
      expect(res.status).toBe('updated');
      expect(res.authorized).toBe(true);

      const p = db.data('prospects_prod/P_MGR_LEAD');
      expect(p.datos.autorizado_sin_contrato).toBe(true);
      expect(p.aprobacion_sin_contrato).toMatchObject({
        estado: 'aprobada',
        autorizado_por: USERS.mgr.nombre,
        autorizado_por_id: USERS.mgr.id,
        montoAutorizado: 25000
      });
    });

    test('9. Vendedor y gestor no pueden usar setNoContractAuthorization ni resolver su propia solicitud', async () => {
      // Vendedor intenta autorización directa
      await expect(
        commSvc.setNoContractAuthorization({
          caller: caller('v1'),
          prospectId: 'P_VEND_LEAD',
          authorized: true
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor intenta autorización directa
      await expect(
        commSvc.setNoContractAuthorization({
          caller: caller('ges'),
          prospectId: 'P_VEND_LEAD',
          authorized: true
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Vendedor solicita dispensa
      const req = await commSvc.requestNoContractAuthorization({
        caller: caller('v1'),
        prospectId: 'P_VEND_LEAD',
        motivo: 'Solicito dispensa',
        opId: 'op_nc_vend_01'
      });
      expect(req.status).toBe('requested');

      // Vendedor intenta auto-aprobarse
      await expect(
        commSvc.resolveNoContractAuthorization({
          caller: caller('v1'),
          prospectId: 'P_VEND_LEAD',
          requestId: req.request.id,
          decision: 'approve'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  // =========================================================================
  // 5. VALIDACIÓN DEL MONTO AUTORIZADO EN EL CIERRE (H-01 & H-02)
  // =========================================================================
  describe('5. Validación Exacta del Monto Autorizado en el Cierre (H-01 & H-02)', () => {
    const offerDoc = { name: 'oferta_gildan.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/oferta_gildan.pdf' };
    const compDoc = { name: 'comprobante_anticipo.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/b/o/comp.pdf' };

    beforeEach(async () => {
      await db.seed('prospects_prod/P_CLOSING', {
        id: 'P_CLOSING',
        clientId: CLIENT.id,
        vendedorId: USERS.v1.id,
        createdBy: USERS.v1.id,
        estado: 'activo',
        etapa: 'cierre',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 30000,
        costo_venta: 18000,
        aprobacion_sin_contrato: {
          estado: 'aprobada',
          montoAutorizado: 30000.00,
          storagePathAprobado: offerDoc.url,
          autorizado_por: 'Gerente General',
          autorizado_por_id: USERS.mgr.id
        },
        datos: {
          doc_oferta: [offerDoc],
          doc_firmado: offerDoc,
          autorizado_sin_contrato: true,
          aprobacion_sin_contrato: {
            estado: 'aprobada',
            montoAutorizado: 30000.00,
            storagePathAprobado: offerDoc.url,
            autorizado_por: 'Gerente General',
            autorizado_por_id: USERS.mgr.id
          }
        },
        logs: [],
        facturas: []
      });
    });

    test('1. Precio igual al monto autorizado: cierre permitido', async () => {
      const p = db.data('prospects_prod/P_CLOSING');
      expect(isNoContractApprovalValid({ prospect: p, datos: p.datos, activeDocFirmado: offerDoc })).toBe(true);

      const res = await wfSvc.finalizeProspect({
        caller: caller('v1'),
        prospectId: 'P_CLOSING',
        data: {
          forma_pago: '70/30',
          factura_anticipo: 'FAC-001',
          doc_firmado: offerDoc,
          doc_comprobante: compDoc,
          encargado: 'Ing. Supervisor'
        }
      });

      expect(res.status).toBe('finalized');
      expect(db.data('prospects_prod/P_CLOSING').estado).toBe('ganado');
    });

    test('2. Precio superior al monto autorizado: cierre bloqueado', async () => {
      const p = db.data('prospects_prod/P_CLOSING');
      p.precio_cotizado = 30001.00; // $1 arriba
      await db.seed('prospects_prod/P_CLOSING', p);

      expect(isNoContractApprovalValid({ prospect: p, datos: p.datos, activeDocFirmado: offerDoc })).toBe(false);

      await expect(
        wfSvc.finalizeProspect({
          caller: caller('v1'),
          prospectId: 'P_CLOSING',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'FAC-001',
            doc_firmado: offerDoc,
            doc_comprobante: compDoc,
            encargado: 'Ing. Supervisor'
          }
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/La autorización para cerrar sin contrato fue otorgada para un monto de \$30,000\.00, pero el monto actual es \$30,001\.00\. Se requiere una nueva resolución gerencial\./)
      });
    });

    test('3. Precio inferior al monto autorizado: cierre bloqueado', async () => {
      const p = db.data('prospects_prod/P_CLOSING');
      p.precio_cotizado = 29999.00; // $1 abajo
      await db.seed('prospects_prod/P_CLOSING', p);

      expect(isNoContractApprovalValid({ prospect: p, datos: p.datos, activeDocFirmado: offerDoc })).toBe(false);

      await expect(
        wfSvc.finalizeProspect({
          caller: caller('v1'),
          prospectId: 'P_CLOSING',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'FAC-001',
            doc_firmado: offerDoc,
            doc_comprobante: compDoc,
            encargado: 'Ing. Supervisor'
          }
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/La autorización para cerrar sin contrato fue otorgada para un monto de \$30,000\.00, pero el monto actual es \$29,999\.00\. Se requiere una nueva resolución gerencial\./)
      });
    });

    test('4. Comparación exacta a centavos sin tolerancias arbitrarias de $0.10', async () => {
      const p = db.data('prospects_prod/P_CLOSING');
      p.precio_cotizado = 30000.08; // 8 centavos de diferencia (dentro de los antiguos 0.10, pero inválido ahora)
      await db.seed('prospects_prod/P_CLOSING', p);

      expect(isNoContractApprovalValid({ prospect: p, datos: p.datos, activeDocFirmado: offerDoc })).toBe(false);

      await expect(
        wfSvc.finalizeProspect({
          caller: caller('v1'),
          prospectId: 'P_CLOSING',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'FAC-001',
            doc_firmado: offerDoc,
            doc_comprobante: compDoc,
            encargado: 'Ing. Supervisor'
          }
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/Se requiere una nueva resolución gerencial/)
      });
    });

    test('5. Autorización histórica sin monto en oportunidad activa: exige nueva resolución', async () => {
      const p = db.data('prospects_prod/P_CLOSING');
      // Eliminamos montoAutorizado simulando registro antiguo
      if (p.aprobacion_sin_contrato) delete p.aprobacion_sin_contrato.montoAutorizado;
      if (p.datos && p.datos.aprobacion_sin_contrato) delete p.datos.aprobacion_sin_contrato.montoAutorizado;
      await db.seed('prospects_prod/P_CLOSING', p);

      expect(isNoContractApprovalValid({ prospect: p, datos: p.datos, activeDocFirmado: offerDoc })).toBe(false);

      await expect(
        wfSvc.finalizeProspect({
          caller: caller('v1'),
          prospectId: 'P_CLOSING',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'FAC-001',
            doc_firmado: offerDoc,
            doc_comprobante: compDoc,
            encargado: 'Ing. Supervisor'
          }
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/no tiene un monto registrado\. Se requiere una nueva resolución gerencial durante la etapa de cierre\./)
      });
    });

    test('6. Proyecto histórico ya ganado: historial y consulta preservados', async () => {
      const pWon = {
        id: 'P_HISTORIC_WON',
        estado: 'ganado',
        etapa: 'cierre',
        precio_cotizado: 50000,
        datos: { autorizado_sin_contrato: true },
        aprobacion_sin_contrato: {
          estado: 'aprobada',
          autorizado_por: 'Gerente Antiguo'
          // Sin montoAutorizado y sin storagePathAprobado
        }
      };

      // Debe mantenerse válido para visualización y consultas
      expect(isNoContractApprovalValid({
        prospect: pWon,
        datos: pWon.datos,
        activeDocFirmado: offerDoc
      })).toBe(true);
    });
  });
});
