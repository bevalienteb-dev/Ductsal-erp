// functions/__tests__/sec04Sec06CommercialBackend.unit.test.js
// SEC-04 / SEC-06: Commercial backend closure and authorization boundary tests.
// Validates server-side authorization, parameter tampering resistance, visibility synchronization,
// role isolation, and atomic index management.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createStorageService } = require('../storageService');

const CLOCK = new Date('2026-03-20T12:00:00.000Z');

const USERS = {
  mgr: { id: 'MGR_001', authUid: 'uid-mgr', role: 'manager', nombre: 'Gerente Operaciones', activo: true },
  ges: { id: 'GES_001', authUid: 'uid-ges', role: 'gestor', nombre: 'Gestor Comercial', activo: true },
  v1:  { id: 'VEN_001', authUid: 'uid-v1',  role: 'vendedor', nombre: 'Vendedor Uno', activo: true },
  v2:  { id: 'VEN_002', authUid: 'uid-v2',  role: 'vendedor', nombre: 'Vendedor Dos', activo: true },
  v3:  { id: 'VEN_003', authUid: 'uid-v3',  role: 'vendedor', nombre: 'Vendedor Tres', activo: true },
  inact: { id: 'VEN_INACT', authUid: 'uid-inact', role: 'vendedor', nombre: 'Vendedor Inactivo', activo: false }
};

const caller = key => ({
  uid: USERS[key].authUid,
  cid: USERS[key].id,
  role: USERS[key].role,
  name: USERS[key].nombre
});

function setupEnvironment() {
  const fdb = createFakeFirestore({ clock: () => CLOCK });
  const liveManagers = new Set(['uid-mgr']);

  const commSvc = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => CLOCK,
    newProspectId: () => 'PROSP_' + Math.floor(Math.random() * 1000000),
    verifyManager: async uid => liveManagers.has(uid)
  });

  const wfSvc = createProspectWorkflowService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    kit: commSvc.kit,
    fileUrlPrefixes: ['https://firebasestorage.googleapis.com/v0/b/']
  });

  return { fdb, commSvc, wfSvc, liveManagers };
}

describe('SEC-04 / SEC-06 Commercial Backend Security Boundary', () => {
  let env;
  let db;
  let commSvc;
  let wfSvc;

  beforeEach(async () => {
    env = setupEnvironment();
    db = env.fdb;
    commSvc = env.commSvc;
    wfSvc = env.wfSvc;

    // Seed users
    for (const u of Object.values(USERS)) {
      await db.seed(`users_prod/${u.id}`, { ...u });
    }

    // Seed client C1 (owned by V1)
    await db.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'Corporacion Alpha',
      contacto: 'Roberto Alpha',
      nit: '0614-010190-101-1',
      nrc: '12345-6',
      telefono: '7000-0001',
      correo: 'contacto@alpha.com',
      correo_fact: 'facturacion@alpha.com',
      createdBy: USERS.v1.id,
      visibleTo: [USERS.v1.id],
      closingVendors: [],
      documentos: {
        dui: { name: 'dui.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/dui.pdf' },
        escritura: { name: 'escritura.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/esc.pdf' },
        credencial: { name: 'credencial.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/cred.pdf' },
        nit: { name: 'nit.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/nit.pdf' },
        nrc: { name: 'nrc.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/nrc.pdf' }
      }
    });
    await db.seed('clientIdentifiers_prod/NIT_06140101901011', { key: 'NIT_06140101901011', kind: 'NIT', clientId: 'C1' });

    // Seed prospect P1 belonging to V1
    await db.seed('prospects_prod/P1', {
      id: 'P1',
      codigo: '202603001',
      clientId: 'C1',
      createdBy: USERS.v1.id,
      vendedorId: USERS.v1.id,
      vendedorName: USERS.v1.nombre,
      vendedorRole: USERS.v1.role,
      etapa: 'prospecto',
      estado: 'activo',
      proyecto: 'Instalacion Torre A',
      tipo_proyecto: 'Fabricación e instalación',
      tipo_producto: 'Ductos',
      precio_cotizado: 15000,
      costo_venta: 9000,
      datos: {},
      logs: [],
      facturas: []
    });
  });

  describe('SEC-04: Opportunity Creation & Assignment Boundaries', () => {
    test('vendedor cannot forge createdBy or assign to another vendor', async () => {
      await expect(
        commSvc.createProspect({
          caller: caller('v1'),
          data: {
            clientId: 'C1',
            proyecto: 'Intento de forja',
            origen: 'Llamada',
            tipo_proyecto: 'Fabricación',
            tipo_producto: 'Ductos',
            vendedorId: USERS.v2.id // Intentando asignar a V2
          },
          opId: 'op_forge_vendor_001'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('vendedor creating prospect updates client visibleTo atomically', async () => {
      const res = await commSvc.createProspect({
        caller: caller('v2'), // V2 creates opportunity for C1 (catalog selection)
        data: {
          clientId: 'C1',
          proyecto: 'Proyecto Legitimo V2',
          origen: 'Referido',
          tipo_proyecto: 'Fabricación',
          tipo_producto: 'Ductos'
        },
        opId: 'op_create_v2_legit'
      });

      expect(res.status).toBe('created');
      const c1Data = db.data('clients_prod/C1');
      expect(c1Data.visibleTo).toContain(USERS.v1.id);
      expect(c1Data.visibleTo).toContain(USERS.v2.id);
    });

    test('reassigning prospect to another vendor adds target to visibleTo and rejects inactive target', async () => {
      // Inactivo rechazado por manager
      await expect(
        commSvc.reassign({
          caller: caller('mgr'),
          prospectId: 'P1',
          vendedorId: USERS.inact.id
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      // Ni vendedor ni gestor pueden reasignar
      await expect(
        commSvc.reassign({
          caller: caller('v1'),
          prospectId: 'P1',
          vendedorId: USERS.v3.id
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        commSvc.reassign({
          caller: caller('ges'),
          prospectId: 'P1',
          vendedorId: USERS.v3.id
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Solo gerente reasigna P1 a V3 -> actualiza prospecto y client.visibleTo
      const res = await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P1',
        vendedorId: USERS.v3.id
      });
      expect(res.status).toBe('reassigned');

      const p1 = db.data('prospects_prod/P1');
      expect(p1.createdBy).toBe(USERS.v1.id);
      expect(p1.vendedorId).toBe(USERS.v3.id);

      const c1 = db.data('clients_prod/C1');
      expect(c1.visibleTo).toContain(USERS.v3.id);
    });
  });

  describe('SEC-04: Workflow Stages & Cross-Vendor Isolation', () => {
    test('vendedor V2 cannot advance stage or mark lost on V1 opportunity', async () => {
      await expect(
        wfSvc.advanceStage({
          caller: caller('v2'),
          prospectId: 'P1',
          nextStage: 'levantamiento',
          data: { visitante: 'Vendedor Dos', distancia: 10 }
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        wfSvc.markLost({
          caller: caller('v2'),
          prospectId: 'P1',
          reason: 'Precio'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('vendedor cannot edit base price (only manager and gestor)', async () => {
      // Vendedor no puede editar precio base ni en su propio prospecto
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P1',
          precio: 20000,
          costo: 12000,
          motivo: 'Ajuste no autorizado'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor NO puede editar precio base en un prospecto ingresado por un vendedor
      await expect(
        wfSvc.editBasePrice({
          caller: caller('ges'),
          prospectId: 'P1',
          precio: 18000,
          costo: 11000,
          motivo: 'Corrección aprobada de costos'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor SÍ puede editar precio base en un prospecto que ingresó originalmente
      await db.seed('prospects_prod/P_GES', {
        id: 'P_GES',
        clientId: 'C1',
        createdBy: USERS.ges.id,
        vendedorId: USERS.v2.id,
        etapa: 'prospecto',
        estado: 'activo',
        precio_cotizado: 10000,
        costo_venta: 6000,
        datos: {},
        logs: [],
        facturas: []
      });
      const resGes = await wfSvc.editBasePrice({
        caller: caller('ges'),
        prospectId: 'P_GES',
        precio: 11000,
        costo: 6500,
        motivo: 'Ajuste inicial gestor'
      });
      expect(resGes.status).toBe('updated');
      expect(db.data('prospects_prod/P_GES').precio_cotizado).toBe(11000);

      // Gerente sí puede editar precio base en cualquier prospecto activo
      const res = await wfSvc.editBasePrice({
        caller: caller('mgr'),
        prospectId: 'P1',
        precio: 18000,
        costo: 11000,
        motivo: 'Corrección gerencial'
      });
      expect(res.status).toBe('updated');
      const p1 = db.data('prospects_prod/P1');
      expect(p1.precio_cotizado).toBe(18000);
      expect(p1.costo_venta).toBe(11000);
    });

    test('cierre stage atomically synchronizes closingVendors and visibleTo', async () => {
      // Configurar prospecto en negociación
      await db.seed('prospects_prod/P1', {
        ...db.data('prospects_prod/P1'),
        etapa: 'negociacion',
        precio_cotizado: 8000, // Menor a 10000 para no exigir contrato especial
        costo_venta: 5000,
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/costos.pdf' }]
        }
      });

      const res = await wfSvc.advanceStage({
        caller: caller('v1'),
        prospectId: 'P1',
        nextStage: 'cierre',
        data: {
          forma_pago: '70/30',
          factura_anticipo: 'FAC-001',
          encargado: 'Juan Instalador',
          doc_firmado: { name: 'firmado.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/firmado.pdf' },
          doc_comprobante: { name: 'pago.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/pago.pdf' }
        }
      });

      expect(res.status).toBe('advanced');
      expect(res.estado).toBe('ganado');

      const c1 = db.data('clients_prod/C1');
      expect(c1.closingVendors).toContain(USERS.v1.id);
      expect(c1.visibleTo).toContain(USERS.v1.id);
    });

    test('marking prospect lost removes seller from closingVendors if no other closing prospects exist', async () => {
      // Prospecto activo en etapa de cierre
      await db.seed('prospects_prod/P1', {
        ...db.data('prospects_prod/P1'),
        etapa: 'cierre',
        estado: 'activo'
      });
      await db.seed('clients_prod/C1', {
        ...db.data('clients_prod/C1'),
        closingVendors: [USERS.v1.id]
      });

      const res = await wfSvc.markLost({
        caller: caller('v1'),
        prospectId: 'P1',
        reason: 'Cliente desiste'
      });

      expect(res.status).toBe('lost');
      const c1 = db.data('clients_prod/C1');
      expect(c1.closingVendors).not.toContain(USERS.v1.id);
    });
  });

  describe('SEC-04 / SEC-06: Deletion Controls & Index Integrity', () => {
    test('non-manager cannot delete prospect (SEC-04)', async () => {
      await expect(
        wfSvc.deleteProspect({
          caller: caller('v1'),
          prospectId: 'P1',
          motivo: 'Borrado no autorizado'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        wfSvc.deleteProspect({
          caller: caller('ges'),
          prospectId: 'P1',
          motivo: 'Gestor intentando borrar'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Manager sí puede: eliminación lógica
      const res = await wfSvc.deleteProspect({
        caller: caller('mgr'),
        prospectId: 'P1',
        motivo: 'Proyecto cancelado por el cliente de mutuo acuerdo'
      });
      expect(res.status).toBe('deleted');

      const p1 = db.data('prospects_prod/P1');
      expect(p1.eliminado).toBe(true);
      expect(p1.motivo_eliminacion).toBe('Proyecto cancelado por el cliente de mutuo acuerdo');
      expect(p1.eliminado_por_id).toBe(USERS.mgr.id);
    });

    test('deleteClientAdmin refuses deletion if prospect exists, releases NIT/DUI atomically when clean (SEC-06)', async () => {
      // Con P1 activo, borrar C1 debe fallar
      await expect(
        commSvc.deleteClient({
          caller: caller('mgr'),
          clientId: 'C1'
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // Borramos P1 para simular cliente sin dependencias
      await db.collection('prospects_prod').doc('P1').delete();

      // Borrado por vendedor -> rechazado
      await expect(
        commSvc.deleteClient({
          caller: caller('v1'),
          clientId: 'C1'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Borrado por manager -> exitoso y libera identificador
      const res = await commSvc.deleteClient({
        caller: caller('mgr'),
        clientId: 'C1'
      });
      expect(res.status).toBe('deleted');
      expect(res.releasedIdentifiers).toBe(1);

      expect(db.data('clients_prod/C1')).toBeUndefined();
      expect(db.data('clientIdentifiers_prod/NIT_06140101901011')).toBeUndefined();
    });
  });

  describe('No-Contract Authorization Governance', () => {
    test('seller cannot approve their own no-contract authorization request', async () => {
      // V1 solicita autorización
      const reqRes = await commSvc.requestNoContractAuthorization({
        caller: caller('v1'),
        prospectId: 'P1',
        motivo: 'Cliente VIP solicita anticipar fabricación sin contrato formal',
        opId: 'op_req_nocontract_01'
      });
      expect(reqRes.status).toBe('requested');
      const reqId = reqRes.request.id;

      // V1 intenta resolver su propia solicitud -> rechazado
      await expect(
        commSvc.resolveNoContractAuthorization({
          caller: caller('v1'),
          prospectId: 'P1',
          requestId: reqId,
          decision: 'approve'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Manager resuelve la solicitud
      const resolveRes = await commSvc.resolveNoContractAuthorization({
        caller: caller('mgr'),
        prospectId: 'P1',
        requestId: reqId,
        decision: 'approve',
        motivoDecision: 'Aprobado bajo fianza corporativa'
      });
      expect(resolveRes.status).toBe('approved');

      const p1 = db.data('prospects_prod/P1');
      expect(p1.datos.autorizado_sin_contrato).toBe(true);
      expect(p1.datos.autorizado_por_id).toBe(USERS.mgr.id);
    });
  });

  describe('Reactivate Lost Prospect (SEC-04 / SEC-06)', () => {
    beforeEach(async () => {
      // Mark P1 lost first
      await wfSvc.markLost({
        caller: caller('v1'),
        prospectId: 'P1',
        reason: 'Precio'
      });
      const p1Lost = db.data('prospects_prod/P1');
      expect(p1Lost.estado).toBe('perdido');
      expect(p1Lost.motivo_perdida).toBe('Precio');
    });

    test('active manager can reactivate a lost prospect, restoring stage and visibility atomically', async () => {
      const res = await wfSvc.reactivateProspect({
        caller: caller('mgr'),
        prospectId: 'P1',
        motivo: 'Cliente retomó contacto y aceptó renegociar condiciones'
      });

      expect(res.status).toBe('reactivated');
      expect(res.estado).toBe('activo');
      expect(res.etapa).toBe('prospecto'); // P1 was in stage 'prospecto'

      const p1 = db.data('prospects_prod/P1');
      expect(p1.estado).toBe('activo');
      expect(p1.etapa).toBe('prospecto');
      expect(p1.motivo_perdida).toBeUndefined();
      expect(p1.fecha_perdida).toBeUndefined();
      expect(p1.motivo_reactivacion).toBe('Cliente retomó contacto y aceptó renegociar condiciones');
      expect(p1.reactivado_por_id).toBe(USERS.mgr.id);
      expect(p1.createdBy).toBe(USERS.v1.id); // createdBy NEVER modified
      expect(p1.vendedorId).toBe(USERS.v1.id);

      // Verify loss history preserved
      expect(Array.isArray(p1.historial_perdidas)).toBe(true);
      expect(p1.historial_perdidas.length).toBe(1);
      expect(p1.historial_perdidas[0].motivo).toBe('Precio');
      expect(p1.ultima_perdida.motivo).toBe('Precio');

      // Verify client visibleTo
      const c1 = db.data('clients_prod/C1');
      expect(c1.visibleTo).toContain(USERS.v1.id);
      expect(c1.visibleTo).toContain(USERS.mgr.id);
    });

    test('restoring a prospect lost during cierre restores closingVendors', async () => {
      await db.seed('prospects_prod/P_CIERRE', {
        id: 'P_CIERRE',
        codigo: '202603099',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        estado: 'perdido',
        etapa: 'cierre',
        motivo_perdida: 'Cliente desiste',
        fecha_perdida: '2026-03-10T10:00:00.000Z',
        eliminado: false
      });

      const res = await wfSvc.reactivateProspect({
        caller: caller('mgr'),
        prospectId: 'P_CIERRE',
        motivo: 'Dirección autorizó descuento especial de cierre'
      });

      expect(res.status).toBe('reactivated');
      expect(res.etapa).toBe('cierre');

      const p = db.data('prospects_prod/P_CIERRE');
      expect(p.estado).toBe('activo');
      expect(p.etapa).toBe('cierre');

      const c1 = db.data('clients_prod/C1');
      expect(c1.closingVendors).toContain(USERS.v1.id);
    });

    test('vendedor and gestor cannot reactivate lost prospect', async () => {
      // Vendedor attempt
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('v1'),
          prospectId: 'P1',
          motivo: 'Intento de reactivación por vendedor'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor attempt
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('ges'),
          prospectId: 'P1',
          motivo: 'Intento de reactivación por gestor'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('inactive user or non-verified manager cannot reactivate', async () => {
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('inact'),
          prospectId: 'P1',
          motivo: 'Intento inactivo'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Manager unverified in live claim check
      env.liveManagers.delete('uid-mgr');
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P1',
          motivo: 'Intento sin live claim'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('cannot reactivate an active, won, or logically deleted prospect', async () => {
      // 1. Reactivate P1 first to make it active
      await wfSvc.reactivateProspect({
        caller: caller('mgr'),
        prospectId: 'P1',
        motivo: 'Primera reactivacion'
      });

      // Attempting to reactivate an already active prospect with different motive -> rejected
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P1',
          motivo: 'Segunda reactivacion con otro motivo'
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // 2. Won prospect
      await db.seed('prospects_prod/P_WON', {
        id: 'P_WON',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        estado: 'ganado',
        etapa: 'cierre',
        eliminado: false
      });
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P_WON',
          motivo: 'Reactivar ganado'
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // 3. Logically deleted prospect
      await db.seed('prospects_prod/P_DEL', {
        id: 'P_DEL',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        estado: 'perdido',
        eliminado: true
      });
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P_DEL',
          motivo: 'Reactivar eliminado'
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    test('motivo is strictly required and validated', async () => {
      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P1',
          motivo: ''
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      await expect(
        wfSvc.reactivateProspect({
          caller: caller('mgr'),
          prospectId: 'P1',
          motivo: null
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('idempotency: retrying reactivation with same motive returns unchanged', async () => {
      const first = await wfSvc.reactivateProspect({
        caller: caller('mgr'),
        prospectId: 'P1',
        motivo: 'Reactivación por renegociación presupuestaria'
      });
      expect(first.status).toBe('reactivated');

      // Retry
      const retry = await wfSvc.reactivateProspect({
        caller: caller('mgr'),
        prospectId: 'P1',
        motivo: 'Reactivación por renegociación presupuestaria'
      });
      expect(retry.status).toBe('unchanged');
      expect(retry.estado).toBe('activo');
    });
  });

  describe('Definitive Commercial Permissions Model (Manager, Gestor, Vendedor)', () => {
    test('gestor lead isolation: gestor cannot access unclosed leads created by vendors or other gestores', async () => {
      // P1 createdBy USERS.v1.id
      await expect(
        wfSvc.advanceStage({
          caller: caller('ges'),
          prospectId: 'P1',
          nextStage: 'levantamiento',
          data: { visitante: 'Gestor', distancia: 5 }
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        wfSvc.markLost({
          caller: caller('ges'),
          prospectId: 'P1',
          reason: 'Precio'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        commSvc.addLog({
          caller: caller('ges'),
          prospectId: 'P1',
          text: 'Nota del gestor',
          opId: 'op_ges_p1_denied'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('gestor can access and manage direct-entry leads they created', async () => {
      await db.seed('prospects_prod/P_DIRECT_GES', {
        id: 'P_DIRECT_GES',
        clientId: 'C1',
        createdBy: USERS.ges.id,
        vendedorId: USERS.ges.id,
        etapa: 'prospecto',
        estado: 'activo',
        precio_cotizado: 5000,
        costo_venta: 3000,
        stage_timestamps: { prospecto: '2026-03-01T00:00:00.000Z' },
        datos: {},
        logs: [],
        facturas: []
      });

      const adv = await wfSvc.advanceStage({
        caller: caller('ges'),
        prospectId: 'P_DIRECT_GES',
        nextStage: 'levantamiento',
        data: { visitante: 'Gestor Gamma', distancia: 8 }
      });
      expect(adv.status).toBe('advanced');

      const log = await commSvc.addLog({
        caller: caller('ges'),
        prospectId: 'P_DIRECT_GES',
        text: 'Seguimiento por gestor',
        opId: 'op_ges_log_ok'
      });
      expect(log.status).toBe('added');
    });

    test('vendedor is strictly blocked from postclosing operations (saveInvoice, savePayment, saveChangeOrder)', async () => {
      // Seed a won project that entered postclosing
      await db.seed('prospects_prod/P_WON_V1', {
        id: 'P_WON_V1',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        precio_cotizado: 10000,
        costo_venta: 6000,
        facturas: [{ id: 'F1', numero: 'FAC-001', monto: 7910, pagos: [] }],
        ordenes_cambio: []
      });

      // Vendedor V1 created and is assigned, but CANNOT operate postclosing
      await expect(
        wfSvc.saveInvoice({
          caller: caller('v1'),
          prospectId: 'P_WON_V1',
          numero: 'FAC-002',
          monto: 1000,
          doc_factura: { name: 'f2.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/f2.pdf' },
          opId: 'op_v1_inv_denied'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        wfSvc.savePayment({
          caller: caller('v1'),
          prospectId: 'P_WON_V1',
          invoiceId: 'F1',
          monto: 1000,
          metodo: 'transferencia',
          ref: 'TRANS-1',
          doc_comprobante: { name: 'c.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/c.pdf' },
          opId: 'op_v1_pay_denied'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(
        wfSvc.saveChangeOrder({
          caller: caller('v1'),
          prospectId: 'P_WON_V1',
          tipo: 'aumento',
          desc: 'Adicional',
          precio: 500,
          costo: 300,
          opId: 'op_v1_co_denied'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('gestor has persistent postclosing access on any project that validly entered postclosing, even after status change', async () => {
      // Seed a project that was won and entered postclosing, but then marked lost or cancelled
      await db.seed('prospects_prod/P_POST_GES', {
        id: 'P_POST_GES',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'perdido',
        motivo_perdida: 'Cliente desiste',
        postcierre_habilitado: true,
        fecha_postcierre: '2026-03-01T00:00:00.000Z',
        precio_cotizado: 10000,
        costo_venta: 6000,
        facturas: [{ id: 'F1', numero: 'FAC-001', monto: 7910, pagos: [] }],
        ordenes_cambio: []
      });

      // Gestor can operate postclosing on this project even if estado is 'perdido' and was created by V1
      const payRes = await wfSvc.savePayment({
        caller: caller('ges'),
        prospectId: 'P_POST_GES',
        invoiceId: 'F1',
        monto: 2000,
        metodo: 'transferencia',
        ref: 'ABONO-POST-GES',
        doc_comprobante: { name: 'comp.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/comp.pdf' },
        opId: 'op_ges_post_pay'
      });
      expect(payRes.status).toBe('created');

      const coRes = await wfSvc.saveChangeOrder({
        caller: caller('ges'),
        prospectId: 'P_POST_GES',
        tipo: 'aumento',
        desc: 'Ajuste postcierre',
        precio: 500,
        costo: 300,
        opId: 'op_ges_post_co'
      });
      expect(coRes.status).toBe('created');
    });

    test('reassignment preserves createdBy immutable, transfers operation to new vendor, and recalculates client visibility', async () => {
      // Create Client C2 owned by Gestor
      await db.seed('clients_prod/C2', {
        id: 'C2',
        tipo: 'juridica',
        empresa: 'Corporacion Beta',
        createdBy: USERS.ges.id,
        visibleTo: [USERS.ges.id, USERS.v1.id],
        closingVendors: []
      });

      // Lead P2 on client C2: created by V1, assigned to V1
      await db.seed('prospects_prod/P2', {
        id: 'P2',
        clientId: 'C2',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        vendedorName: USERS.v1.nombre,
        etapa: 'prospecto',
        estado: 'activo',
        precio_cotizado: 8000,
        costo_venta: 4800,
        datos: {},
        logs: [],
        facturas: []
      });

      // Manager reassigns P2 from V1 to V2
      const res = await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P2',
        vendedorId: USERS.v2.id
      });
      expect(res.status).toBe('reassigned');

      const p2After = db.data('prospects_prod/P2');
      // Attribution integrity: createdBy is immutable
      expect(p2After.createdBy).toBe(USERS.v1.id);
      expect(p2After.vendedorId).toBe(USERS.v2.id);

      // Audit trail registered
      const auditLogs = await db.list('commercialAudit_prod');
      const reassignAudit = auditLogs.find(a => a.action === 'reassignProspect' && a.targetId === 'P2');
      expect(reassignAudit).toBeDefined();
      expect(reassignAudit.actorCid).toBe(USERS.mgr.id);
      expect(reassignAudit.detail.from).toBe(USERS.v1.id);
      expect(reassignAudit.detail.to).toBe(USERS.v2.id);
      expect(reassignAudit.detail.authorizedBy).toBe(USERS.mgr.id);

      // Client C2 visibility: V1 removed (has no other leads for C2, not creator), V2 added
      const c2After = db.data('clients_prod/C2');
      expect(c2After.visibleTo).toContain(USERS.v2.id);
      expect(c2After.visibleTo).toContain(USERS.ges.id);
      expect(c2After.visibleTo).not.toContain(USERS.v1.id);

      // V1 no longer has access to P2; V2 has access
      await expect(
        wfSvc.advanceStage({
          caller: caller('v1'),
          prospectId: 'P2',
          nextStage: 'levantamiento',
          data: { visitante: 'V1', distancia: 5 }
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      const advV2 = await wfSvc.advanceStage({
        caller: caller('v2'),
        prospectId: 'P2',
        nextStage: 'levantamiento',
        data: { visitante: 'V2', distancia: 5 }
      });
      expect(advV2.status).toBe('advanced');
    });
  });

  describe('Audit Remediation (H-01, H-02, H-03, H-04 & Postclosing Alignment)', () => {
    let mockFiles;
    let mockBucket;
    let storageSvc;

    beforeEach(() => {
      mockFiles = new Map();
      mockBucket = {
        name: 'ductsal-erp.firebasestorage.app',
        file: (filePath) => ({
          exists: async () => [mockFiles.has(filePath)],
          getMetadata: async () => {
            const f = mockFiles.get(filePath);
            if (!f) throw new Error('Not found');
            return [{ size: f.size, contentType: f.contentType }];
          },
          getSignedUrl: async () => [`https://storage.googleapis.com/test-bucket/${filePath}?signed=true`]
        })
      };

      storageSvc = createStorageService({
        db,
        bucket: mockBucket,
        suffix: '_prod',
        defaultExpirationSeconds: 900
      });
    });

    test('H-01: Reassigned vendor cannot access or mutate prospect even if they were the original creator (createdBy == me)', async () => {
      // Seed client and prospect originally created by V1 and assigned to V1
      await db.seed('clients_prod/C_H01', {
        id: 'C_H01',
        tipo: 'juridica',
        empresa: 'Audit Corp',
        createdBy: USERS.v1.id,
        visibleTo: [USERS.v1.id],
        closingVendors: []
      });

      await db.seed('prospects_prod/P_H01', {
        id: 'P_H01',
        clientId: 'C_H01',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'prospecto',
        estado: 'activo',
        precio_cotizado: 5000,
        costo_venta: 3000,
        datos: {},
        logs: [],
        facturas: []
      });

      // Manager reassigns P_H01 to V2
      await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P_H01',
        vendedorId: USERS.v2.id
      });

      // Verification: createdBy remains V1 (commission attribution intact)
      const pAfter = db.data('prospects_prod/P_H01');
      expect(pAfter.createdBy).toBe(USERS.v1.id);
      expect(pAfter.vendedorId).toBe(USERS.v2.id);

      // Operational mutation attempt by V1 is denied
      await expect(
        wfSvc.advanceStage({
          caller: caller('v1'),
          prospectId: 'P_H01',
          nextStage: 'levantamiento',
          data: { visitante: 'V1' }
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Modification attempt by V1 via addLog is denied
      await expect(
        commSvc.addLog({
          caller: caller('v1'),
          prospectId: 'P_H01',
          text: 'Intento de log no autorizado',
          opId: 'op-h01-log-attempt'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Marking lost attempt by V1 is denied
      await expect(
        wfSvc.markLost({
          caller: caller('v1'),
          prospectId: 'P_H01',
          reason: 'Precio'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('H-02: Former vendor is denied download access to documents of reassigned prospect', async () => {
      const filePath = 'prod_files/prospects/P_H02/cotizaciones/cotizacion_v1.pdf';
      mockFiles.set(filePath, { size: 1024, contentType: 'application/pdf' });

      // Prospect created by V1, currently assigned to V2
      await db.seed('prospects_prod/P_H02', {
        id: 'P_H02',
        clientId: 'C_H02',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v2.id,
        etapa: 'cotizacion',
        estado: 'activo',
        cotizaciones: [{ name: 'cotizacion_v1.pdf', storagePath: filePath }]
      });

      // V1 (former vendor, now reassigned) tries to download
      await expect(
        storageSvc.getSecureDownloadUrl({
          caller: caller('v1'),
          storagePath: filePath,
          prospectId: 'P_H02'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // V2 (active assigned vendor) is allowed to download
      const v2Res = await storageSvc.getSecureDownloadUrl({
        caller: caller('v2'),
        storagePath: filePath,
        prospectId: 'P_H02'
      });
      expect(v2Res.signedUrl).toBeDefined();
    });

    test('H-03: Gestor is denied download access to open/unclosed prospect created by another vendor', async () => {
      const filePath = 'prod_files/prospects/P_H03/levantamientos/plano.pdf';
      mockFiles.set(filePath, { size: 2048, contentType: 'application/pdf' });

      // Open unclosed opportunity created by V1, assigned to V1
      await db.seed('prospects_prod/P_H03', {
        id: 'P_H03',
        clientId: 'C_H03',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'levantamiento',
        estado: 'activo',
        levantamiento_archivo: { name: 'plano.pdf', storagePath: filePath }
      });

      // Gestor attempts to download without legitimate postclosing or authorship
      await expect(
        storageSvc.getSecureDownloadUrl({
          caller: caller('ges'),
          storagePath: filePath,
          prospectId: 'P_H03'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('H-03 / Postclosing Alignment: Gestor is granted download access once prospect enters postclosing across all valid criteria', async () => {
      const filePathA = 'prod_files/prospects/P_POST_A/cierre/contrato_a.pdf';
      const filePathB = 'prod_files/prospects/P_POST_B/cierre/contrato_b.pdf';
      const filePathC = 'prod_files/prospects/P_POST_C/cierre/contrato_c.pdf';
      const filePathD = 'prod_files/prospects/P_POST_D/cierre/contrato_d.pdf';
      mockFiles.set(filePathA, { size: 1000, contentType: 'application/pdf' });
      mockFiles.set(filePathB, { size: 1000, contentType: 'application/pdf' });
      mockFiles.set(filePathC, { size: 1000, contentType: 'application/pdf' });
      mockFiles.set(filePathD, { size: 1000, contentType: 'application/pdf' });

      // Criterion 1: postcierre_habilitado === true (even if marked perdido)
      await db.seed('prospects_prod/P_POST_A', {
        id: 'P_POST_A',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        estado: 'perdido',
        postcierre_habilitado: true,
        contrato_archivo: { name: 'contrato_a.pdf', storagePath: filePathA }
      });

      // Criterion 2: fecha_cierre set
      await db.seed('prospects_prod/P_POST_B', {
        id: 'P_POST_B',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        fecha_cierre: '2026-02-15T10:00:00.000Z',
        contrato_archivo: { name: 'contrato_b.pdf', storagePath: filePathB }
      });

      // Criterion 3: stage_timestamps.cierre set
      await db.seed('prospects_prod/P_POST_C', {
        id: 'P_POST_C',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        stage_timestamps: { cierre: '2026-02-20T14:00:00.000Z' },
        contrato_archivo: { name: 'contrato_c.pdf', storagePath: filePathC }
      });

      // Criterion 4: facturas.length > 0
      await db.seed('prospects_prod/P_POST_D', {
        id: 'P_POST_D',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        facturas: [{ numero: 'FAC-001', monto: 1000 }],
        contrato_archivo: { name: 'contrato_d.pdf', storagePath: filePathD }
      });

      const resA = await storageSvc.getSecureDownloadUrl({ caller: caller('ges'), storagePath: filePathA, prospectId: 'P_POST_A' });
      const resB = await storageSvc.getSecureDownloadUrl({ caller: caller('ges'), storagePath: filePathB, prospectId: 'P_POST_B' });
      const resC = await storageSvc.getSecureDownloadUrl({ caller: caller('ges'), storagePath: filePathC, prospectId: 'P_POST_C' });
      const resD = await storageSvc.getSecureDownloadUrl({ caller: caller('ges'), storagePath: filePathD, prospectId: 'P_POST_D' });

      expect(resA.signedUrl).toBeDefined();
      expect(resB.signedUrl).toBeDefined();
      expect(resC.signedUrl).toBeDefined();
      expect(resD.signedUrl).toBeDefined();
    });

    test('H-04: Reassigned vendor loses visibility to client when their only prospect was reassigned', async () => {
      // Client C_H04 created by Gestor, visible to V1 because V1 has prospect P_H04
      await db.seed('clients_prod/C_H04', {
        id: 'C_H04',
        tipo: 'juridica',
        empresa: 'Client H04 Test',
        createdBy: USERS.ges.id,
        visibleTo: [USERS.ges.id, USERS.v1.id],
        closingVendors: []
      });

      await db.seed('prospects_prod/P_H04', {
        id: 'P_H04',
        clientId: 'C_H04',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'prospecto',
        estado: 'activo',
        facturas: []
      });

      // Reassign P_H04 to V2
      await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P_H04',
        vendedorId: USERS.v2.id
      });

      // Client visibility in database was updated: V1 removed, V2 added
      const cAfter = db.data('clients_prod/C_H04');
      expect(cAfter.visibleTo).toContain(USERS.v2.id);
      expect(cAfter.visibleTo).not.toContain(USERS.v1.id);
    });
  });

  describe('Section 10: Validación de vendedorId como responsable que cierra', () => {
    beforeEach(async () => {
      // Seed client with complete corporate and legal documentation for closure
      await db.seed('clients_prod/C_CLOSE', {
        id: 'C_CLOSE',
        tipo: 'juridica',
        empresa: 'Corporativo Cierre S.A. de C.V.',
        contacto: 'Lic. Roberto Gómez',
        telefono: '2222-3333',
        correo: 'info@cierre.com',
        correo_fact: 'facturacion@cierre.com',
        nit: '0614-010190-101-1',
        nrc: '123456-7',
        createdBy: USERS.mgr.id,
        visibleTo: [USERS.mgr.id, USERS.v1.id, USERS.v2.id, USERS.ges.id],
        closingVendors: [],
        documentos: {
          dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_CLOSE/identificacion/dui.pdf' },
          escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/escritura.pdf' },
          credencial: { name: 'credencial.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/credencial.pdf' },
          nit: { name: 'nit.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/nit.pdf' },
          nrc: { name: 'nrc.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/nrc.pdf' }
        }
      });
    });

    test('1 & 2: Cierre por vendedor conserva vendedorId y registra CCF de anticipo', async () => {
      await db.seed('prospects_prod/P_CLS_V1', {
        id: 'P_CLS_V1',
        clientId: 'C_CLOSE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        vendedorName: USERS.v1.nombre,
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 15000,
        costo_venta: 9000,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_V1/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_V1/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      const res = await wfSvc.advanceStage({
        caller: caller('v1'),
        prospectId: 'P_CLS_V1',
        nextStage: 'cierre',
        data: {
          forma_pago: '70/30',
          factura_anticipo: 'CCF-001-V1',
          encargado: 'Carlos Instalador',
          doc_firmado: { name: 'contrato.pdf', storagePath: 'prod_files/prospects/P_CLS_V1/proyectos/contrato.pdf' },
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: 'prod_files/prospects/P_CLS_V1/facturas/ccf_anticipo.pdf' }
        }
      });

      expect(res.status).toBe('advanced');
      expect(res.estado).toBe('ganado');

      const pAfter = db.data('prospects_prod/P_CLS_V1');
      expect(pAfter.vendedorId).toBe(USERS.v1.id);
      expect(pAfter.createdBy).toBe(USERS.v1.id);
      expect(pAfter.postcierre_habilitado).toBe(true);
      expect(pAfter.fecha_cierre).toBeDefined();
      expect(pAfter.facturas.length).toBe(1);
      expect(pAfter.facturas[0].numero).toBe('CCF-001-V1');
      expect(pAfter.facturas[0].doc_factura).toBeDefined();
    });

    test('3 & 6: Cierre por gestor cuando es el responsable efectivo conserva vendedorId del gestor sin ampliar permisos ajenos', async () => {
      // Prospect assigned to Gestor as commercial responsible (e.g. direct entry or manager assignment)
      await db.seed('prospects_prod/P_CLS_GES', {
        id: 'P_CLS_GES',
        clientId: 'C_CLOSE',
        createdBy: USERS.mgr.id,
        vendedorId: USERS.ges.id,
        vendedorName: USERS.ges.nombre,
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 12000,
        costo_venta: 7500,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_GES/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_GES/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      const res = await wfSvc.advanceStage({
        caller: caller('ges'),
        prospectId: 'P_CLS_GES',
        nextStage: 'cierre',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'CCF-GES-99',
          encargado: 'Mauricio Armador',
          doc_firmado: { name: 'contrato.pdf', storagePath: 'prod_files/prospects/P_CLS_GES/proyectos/contrato.pdf' },
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: 'prod_files/prospects/P_CLS_GES/facturas/ccf_anticipo.pdf' }
        }
      });

      expect(res.status).toBe('advanced');
      expect(res.estado).toBe('ganado');

      const pAfter = db.data('prospects_prod/P_CLS_GES');
      expect(pAfter.vendedorId).toBe(USERS.ges.id); // Gestor is identified as closing responsible
      expect(pAfter.createdBy).toBe(USERS.mgr.id); // Creator immutable
      expect(pAfter.postcierre_habilitado).toBe(true);
      expect(pAfter.facturas[0].numero).toBe('CCF-GES-99');

      // Gestor cannot close another vendor's open prospect
      await db.seed('prospects_prod/P_CLS_OTHER', {
        id: 'P_CLS_OTHER',
        clientId: 'C_CLOSE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 5000,
        costo_venta: 3000,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_OTHER/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_OTHER/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      await expect(
        wfSvc.advanceStage({
          caller: caller('ges'),
          prospectId: 'P_CLS_OTHER',
          nextStage: 'cierre',
          data: {
            forma_pago: '70/30',
            factura_anticipo: 'CCF-HACK',
            doc_firmado: { name: 'c.pdf', storagePath: 'prod_files/prospects/P_CLS_OTHER/proyectos/c.pdf' },
            doc_comprobante: { name: 'p.pdf', storagePath: 'prod_files/prospects/P_CLS_OTHER/facturas/p.pdf' }
          }
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('4: Cierre ejecutado por manager no sobrescribe vendedorId del responsable comercial', async () => {
      await db.seed('prospects_prod/P_CLS_MGR', {
        id: 'P_CLS_MGR',
        clientId: 'C_CLOSE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        vendedorName: USERS.v1.nombre,
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 6000,
        costo_venta: 3500,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_MGR/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_MGR/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      // Manager closes on behalf of operational flow
      await wfSvc.advanceStage({
        caller: caller('mgr'),
        prospectId: 'P_CLS_MGR',
        nextStage: 'cierre',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'CCF-MGR-01',
          doc_firmado: { name: 'oferta_firmada.pdf', storagePath: 'prod_files/prospects/P_CLS_MGR/proyectos/oferta_firmada.pdf' },
          doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P_CLS_MGR/facturas/recibo.pdf' }
        }
      });

      const pAfter = db.data('prospects_prod/P_CLS_MGR');
      // Must NOT be overwritten with caller (manager); vendedorId remains USERS.v1.id
      expect(pAfter.vendedorId).toBe(USERS.v1.id);
      expect(pAfter.createdBy).toBe(USERS.v1.id);
      expect(pAfter.estado).toBe('ganado');
    });

    test('5: Reasignación previa al cierre identifica al responsable que finalmente cierra', async () => {
      await db.seed('prospects_prod/P_CLS_REASSIGN', {
        id: 'P_CLS_REASSIGN',
        clientId: 'C_CLOSE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        vendedorName: USERS.v1.nombre,
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 8000,
        costo_venta: 4500,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_REASSIGN/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_REASSIGN/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      // Manager reassigns from V1 to V2 before closure
      await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P_CLS_REASSIGN',
        vendedorId: USERS.v2.id
      });

      const pMid = db.data('prospects_prod/P_CLS_REASSIGN');
      expect(pMid.vendedorId).toBe(USERS.v2.id);
      expect(pMid.createdBy).toBe(USERS.v1.id);

      // V2 executes closure
      const res = await wfSvc.advanceStage({
        caller: caller('v2'),
        prospectId: 'P_CLS_REASSIGN',
        nextStage: 'cierre',
        data: {
          forma_pago: '50/50',
          factura_anticipo: 'CCF-V2-FINAL',
          doc_firmado: { name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_REASSIGN/proyectos/oferta.pdf' },
          doc_comprobante: { name: 'anticipo.pdf', storagePath: 'prod_files/prospects/P_CLS_REASSIGN/facturas/anticipo.pdf' }
        }
      });

      expect(res.status).toBe('advanced');
      expect(res.estado).toBe('ganado');

      const pAfter = db.data('prospects_prod/P_CLS_REASSIGN');
      expect(pAfter.vendedorId).toBe(USERS.v2.id); // Identifies V2 as the closer
      expect(pAfter.createdBy).toBe(USERS.v1.id);  // Historical origin preserved
      expect(pAfter.facturas[0].numero).toBe('CCF-V2-FINAL');
    });

    test('7: Transición a cierre exige CCF de anticipo y datos de cliente completos', async () => {
      // Incomplete client missing DUI and billing details
      await db.seed('clients_prod/C_INCOMPLETE', {
        id: 'C_INCOMPLETE',
        tipo: 'natural',
        nombres: 'Pedro',
        createdBy: USERS.v1.id,
        visibleTo: [USERS.v1.id],
        closingVendors: [],
        documentos: {}
      });

      await db.seed('prospects_prod/P_CLS_FAIL', {
        id: 'P_CLS_FAIL',
        clientId: 'C_INCOMPLETE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 4000,
        costo_venta: 2000,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_CLS_FAIL/cotizaciones/oferta.pdf' }],
          doc_costos: [{ name: 'costos.pdf', storagePath: 'prod_files/prospects/P_CLS_FAIL/cotizaciones/costos.pdf' }]
        },
        logs: [],
        facturas: []
      });

      // Missing client fields rejection
      await expect(
        wfSvc.advanceStage({
          caller: caller('v1'),
          prospectId: 'P_CLS_FAIL',
          nextStage: 'cierre',
          data: {
            forma_pago: '100% anticipado',
            factura_anticipo: 'FAC-FAIL',
            doc_firmado: { name: 'f.pdf', storagePath: 'prod_files/prospects/P_CLS_FAIL/proyectos/f.pdf' },
            doc_comprobante: { name: 'c.pdf', storagePath: 'prod_files/prospects/P_CLS_FAIL/facturas/c.pdf' }
          }
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });
  });

  describe('SEC-04 / SEC-06: Bloqueo absoluto de reasignación postcierre y preservación de vendedorId', () => {
    beforeEach(async () => {
      await db.seed('clients_prod/C_CLOSE', {
        id: 'C_CLOSE',
        tipo: 'juridica',
        empresa: 'Corporativo Cierre S.A. de C.V.',
        contacto: 'Lic. Roberto Gómez',
        telefono: '2222-3333',
        correo: 'info@cierre.com',
        correo_fact: 'facturacion@cierre.com',
        nit: '0614-010190-101-1',
        nrc: '123456-7',
        createdBy: USERS.mgr.id,
        visibleTo: [USERS.mgr.id, USERS.v1.id, USERS.v2.id, USERS.ges.id],
        closingVendors: [],
        documentos: {
          dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_CLOSE/identificacion/dui.pdf' },
          escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/escritura.pdf' },
          credencial: { name: 'credencial.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/credencial.pdf' },
          nit: { name: 'nit.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/nit.pdf' },
          nrc: { name: 'nrc.pdf', storagePath: 'prod_files/clients/C_CLOSE/legal/nrc.pdf' }
        }
      });
    });

    test('1. Un gerente puede reasignar un prospecto abierto cuando está autorizado', async () => {
      await db.seed('prospects_prod/P_OPEN_REASSIGN', {
        id: 'P_OPEN_REASSIGN',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cotizacion',
        estado: 'activo',
        logs: [],
        facturas: []
      });
      const res = await commSvc.reassign({
        caller: caller('mgr'),
        prospectId: 'P_OPEN_REASSIGN',
        vendedorId: USERS.v2.id
      });
      expect(res.status).toBe('reassigned');
      expect(res.vendedorId).toBe(USERS.v2.id);
      const updated = db.data('prospects_prod/P_OPEN_REASSIGN');
      expect(updated.vendedorId).toBe(USERS.v2.id);
      expect(updated.createdBy).toBe(USERS.v1.id); // inmutable
    });

    test('2. Un vendedor o gestor no puede reasignar un prospecto si su rol no lo permite', async () => {
      await db.seed('prospects_prod/P_OPEN_UNAUTH', {
        id: 'P_OPEN_UNAUTH',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'prospecto',
        estado: 'activo',
        logs: [],
        facturas: []
      });
      await expect(
        commSvc.reassign({ caller: caller('v1'), prospectId: 'P_OPEN_UNAUTH', vendedorId: USERS.v2.id })
      ).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(
        commSvc.reassign({ caller: caller('ges'), prospectId: 'P_OPEN_UNAUTH', vendedorId: USERS.v2.id })
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect(db.data('prospects_prod/P_OPEN_UNAUTH').vendedorId).toBe(USERS.v1.id);
    });

    test('3 & 4. Un gerente NO puede reasignar un prospecto cerrado; llamada directa al backend es rechazada con failed-precondition', async () => {
      await db.seed('prospects_prod/P_CLOSED_MGR', {
        id: 'P_CLOSED_MGR',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_cierre: '2026-03-01T10:00:00.000Z',
        fecha_postcierre: '2026-03-01T10:00:00.000Z',
        logs: [],
        facturas: []
      });

      // Direct backend call by manager is rejected
      await expect(
        commSvc.reassign({
          caller: caller('mgr'),
          prospectId: 'P_CLOSED_MGR',
          vendedorId: USERS.v2.id
        })
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('No se puede reasignar una oportunidad que ya completó el cierre comercial')
      });

      // vendedorId remains untouched
      expect(db.data('prospects_prod/P_CLOSED_MGR').vendedorId).toBe(USERS.v1.id);
    });

    test('5. La reasignación rechazada no modifica datos ni confiere/retira permisos indebidamente al vendedor anterior o nuevo', async () => {
      await db.seed('clients_prod/C_CLOSING_STABLE', {
        id: 'C_CLOSING_STABLE',
        tipo: 'empresa',
        empresa: 'Corporación Estable',
        createdBy: USERS.mgr.id,
        visibleTo: [USERS.v1.id],
        closingVendors: [USERS.v1.id]
      });

      await db.seed('prospects_prod/P_CLOSED_AUDIT_STABLE', {
        id: 'P_CLOSED_AUDIT_STABLE',
        clientId: 'C_CLOSING_STABLE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_cierre: '2026-03-02T10:00:00.000Z',
        logs: [{ text: 'Cierre completado', date: '2026-03-02' }]
      });

      const auditBefore = await db.list('commercialAudit_prod');
      const auditCountBefore = auditBefore.length;

      await expect(
        commSvc.reassign({
          caller: caller('mgr'),
          prospectId: 'P_CLOSED_AUDIT_STABLE',
          vendedorId: USERS.v2.id
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // Document untouched
      const pAfter = db.data('prospects_prod/P_CLOSED_AUDIT_STABLE');
      expect(pAfter.vendedorId).toBe(USERS.v1.id);
      expect(pAfter.logs).toHaveLength(1);

      // Client permissions untouched (V1 keeps closingVendors & visibleTo; V2 does NOT gain them)
      const cAfter = db.data('clients_prod/C_CLOSING_STABLE');
      expect(cAfter.closingVendors).toEqual([USERS.v1.id]);
      expect(cAfter.visibleTo).toEqual([USERS.v1.id]);

      // No audit event written for rejected operation
      const auditAfter = await db.list('commercialAudit_prod');
      expect(auditAfter.length).toBe(auditCountBefore);
    });

    test('6. Transición simultánea al cierre y reasignación: si cierre se procesa, reasignación es rechazada y vendedorId se conserva', async () => {
      await db.seed('prospects_prod/P_RACE', {
        id: 'P_RACE',
        clientId: 'C_CLOSE',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 5000,
        costo_venta: 2500,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'of.pdf', storagePath: 'prod_files/prospects/P_RACE/cotizaciones/of.pdf' }],
          doc_costos: [{ name: 'co.pdf', storagePath: 'prod_files/prospects/P_RACE/cotizaciones/co.pdf' }],
          autorizado_sin_contrato: true,
          autorizado_por: 'Gerente'
        },
        logs: [],
        facturas: []
      });

      // Close the prospect first
      await wfSvc.advanceStage({
        caller: caller('mgr'),
        prospectId: 'P_RACE',
        nextStage: 'cierre',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FAC-RACE',
          doc_firmado: { name: 'f.pdf', storagePath: 'prod_files/prospects/P_RACE/proyectos/f.pdf' },
          doc_comprobante: { name: 'c.pdf', storagePath: 'prod_files/prospects/P_RACE/facturas/c.pdf' }
        }
      });

      // Subsequent or concurrent reassignment fails
      await expect(
        commSvc.reassign({
          caller: caller('mgr'),
          prospectId: 'P_RACE',
          vendedorId: USERS.v2.id
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // vendedorId accurately reflects the original closer (V1), NOT overwritten by manager or target
      const pFinal = db.data('prospects_prod/P_RACE');
      expect(pFinal.vendedorId).toBe(USERS.v1.id);
      expect(pFinal.postcierre_habilitado).toBe(true);
    });

    test('7. vendedorId se conserva al cerrar tanto si el responsable es vendedor como si es gestor (gerente no lo sobrescribe)', async () => {
      // Gestor as assigned vendedorId on complete client C_CLOSE
      await db.seed('prospects_prod/P_GES_CLOSE', {
        id: 'P_GES_CLOSE',
        clientId: 'C_CLOSE',
        createdBy: USERS.ges.id,
        vendedorId: USERS.ges.id,
        vendedorName: 'Gestora Beta',
        vendedorRole: 'gestor',
        tipo_proyecto: 'Fabricación',
        precio_cotizado: 3000,
        costo_venta: 1500,
        etapa: 'negociacion',
        estado: 'activo',
        datos: {
          doc_oferta: [{ name: 'of.pdf', storagePath: 'prod_files/prospects/P_GES_CLOSE/cotizaciones/of.pdf' }],
          doc_costos: [{ name: 'co.pdf', storagePath: 'prod_files/prospects/P_GES_CLOSE/cotizaciones/co.pdf' }],
          autorizado_sin_contrato: true,
          autorizado_por: 'Gerente'
        },
        logs: [],
        facturas: []
      });

      // Manager executes the administrative closing action
      const res = await wfSvc.advanceStage({
        caller: caller('mgr'),
        prospectId: 'P_GES_CLOSE',
        nextStage: 'cierre',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FAC-GES-1',
          doc_firmado: { name: 'firmado.pdf', storagePath: 'prod_files/prospects/P_GES_CLOSE/proyectos/firmado.pdf' },
          doc_comprobante: { name: 'ccf.pdf', storagePath: 'prod_files/prospects/P_GES_CLOSE/facturas/ccf.pdf' }
        }
      });

      expect(res.status).toBe('advanced');
      const pAfter = db.data('prospects_prod/P_GES_CLOSE');
      expect(pAfter.vendedorId).toBe(USERS.ges.id); // Preserved as Gestor, NOT overwritten by Manager (mgr)
      expect(pAfter.postcierre_habilitado).toBe(true);

      const clientAfter = db.data('clients_prod/C_CLOSE');
      expect(clientAfter.closingVendors).toContain(USERS.ges.id);
    });

    test('8. Proyecto cerrado conserva acceso legítimo de postcierre aun si cambia posteriormente de estado administrativo (perdido/cancelado)', async () => {
      const closedLost = {
        id: 'P_CLOSED_THEN_LOST',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'perdido',
        motivo_perdida: 'Cancelado por cliente postcierre',
        postcierre_habilitado: true,
        fecha_cierre: '2026-03-05T00:00:00.000Z',
        fecha_postcierre: '2026-03-05T00:00:00.000Z',
        facturas: []
      };

      // Gestor retains access because postcierre_habilitado is true, regardless of estado: 'perdido'
      expect(commSvc.hasEnteredPostclosing(closedLost)).toBe(true);
      expect(commSvc.kit.canAccessProspect(caller('ges'), closedLost)).toBe(true);
      expect(commSvc.kit.canAccessProspect(caller('mgr'), closedLost)).toBe(true);
    });

    test('9. Cierre comercial válido concede postcierre sin exigir comprobante CCF repetido para la autorización', async () => {
      // Document completed closure with postcierre_habilitado, no facturas yet
      const projectWithoutInvoices = {
        id: 'P_POST_NO_INV',
        clientId: 'C1',
        createdBy: USERS.v1.id,
        vendedorId: USERS.v1.id,
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_postcierre: '2026-03-06T00:00:00.000Z',
        facturas: [] // zero facturas
      };

      expect(commSvc.hasEnteredPostclosing(projectWithoutInvoices)).toBe(true);
      expect(commSvc.kit.canAccessProspect(caller('ges'), projectWithoutInvoices)).toBe(true);
    });
  });
});
