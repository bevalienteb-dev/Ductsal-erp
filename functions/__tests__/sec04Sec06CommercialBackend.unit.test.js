// functions/__tests__/sec04Sec06CommercialBackend.unit.test.js
// SEC-04 / SEC-06: Commercial backend closure and authorization boundary tests.
// Validates server-side authorization, parameter tampering resistance, visibility synchronization,
// role isolation, and atomic index management.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

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
      // Intento reasignar a inactivo -> rechazado
      await expect(
        commSvc.reassign({
          caller: caller('ges'),
          prospectId: 'P1',
          vendedorId: USERS.inact.id
        })
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      // Vendedor común no puede reasignar
      await expect(
        commSvc.reassign({
          caller: caller('v1'),
          prospectId: 'P1',
          vendedorId: USERS.v3.id
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor reasigna P1 a V3 -> actualiza prospecto y client.visibleTo
      const res = await commSvc.reassign({
        caller: caller('ges'),
        prospectId: 'P1',
        vendedorId: USERS.v3.id
      });
      expect(res.status).toBe('reassigned');

      const p1 = db.data('prospects_prod/P1');
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
      await expect(
        wfSvc.editBasePrice({
          caller: caller('v1'),
          prospectId: 'P1',
          precio: 20000,
          costo: 12000,
          motivo: 'Ajuste no autorizado'
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });

      // Gestor sí puede editar precio base en prospecto activo
      const res = await wfSvc.editBasePrice({
        caller: caller('ges'),
        prospectId: 'P1',
        precio: 18000,
        costo: 11000,
        motivo: 'Corrección aprobada de costos'
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
});
