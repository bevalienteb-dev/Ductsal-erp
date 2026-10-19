// functions/__tests__/storageAuth.unit.test.js
// Unit tests for Storage Authorization Backend (Phase 1):
// - Client reservation creation, duplicate rejection, expiry, cancellation, and atomic finalization.
// - Client `closingVendors` maintenance across stage advances to `cierre`, loss, logical deletion, and reassignment.
// In-memory Firestore (fakeFirestore); no external dependencies.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createClientsService } = require('../clientsService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createCommercialService } = require('../commercialService');

describe('Storage Authorization Backend: Client Reservation & Finalization', () => {
  let nowMs = 1773576000000; // 2026-03-15T12:00:00.000Z
  const clock = () => new Date(nowMs);
  let fdb;
  let clientsSvc;

  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const V1 = who('vendedor', 'V1');
  const V2 = who('vendedor', 'V2');
  const MGR = who('manager', 'M1');

  const validClient = (overrides = {}) => ({
    tipo: 'natural',
    nombres: 'Carlos',
    apellidos: 'Gómez',
    dui: '01234567-8',
    nit: '0614-101090-101-1',
    telefono: '7000-1111',
    correo: 'carlos@example.com',
    ...overrides
  });

  beforeEach(() => {
    nowMs = 1773576000000;
    fdb = createFakeFirestore({ clock });
    clientsSvc = createClientsService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: clock,
      newId: () => 'C' + nowMs
    });
  });

  test('valid reservation creates document with status "reserved", 30m TTL, and caller info', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    expect(res.status).toBe('reserved');
    expect(res.reservationId).toBeDefined();
    expect(res.clientId).toBe(res.reservationId);
    expect(res.expiresAt).toBe(new Date(nowMs + 30 * 60 * 1000).toISOString());

    const saved = fdb.data(`client_reservations_prod/${res.reservationId}`);
    expect(saved).toBeDefined();
    expect(saved.status).toBe('reserved');
    expect(saved.createdBy).toBe('V1');
    expect(saved.authUid).toBe('uid-V1');
    expect(saved.tipo).toBe('natural');
    expect(saved.keys).toContain('DUI_012345678');
  });

  test('reservation rejects duplicate NIT or DUI before reserving', async () => {
    // Seed existing client
    fdb.seed('clients_prod/C_EXISTING', {
      id: 'C_EXISTING',
      tipo: 'natural',
      nombres: 'Carlos',
      apellidos: 'Gómez',
      dui: '01234567-8',
      nit: '0614-101090-101-1',
      createdBy: 'V2'
    });
    fdb.seed('clientIdentifiers_prod/DUI_012345678', {
      key: 'DUI_012345678',
      clientId: 'C_EXISTING',
      createdBy: 'V2'
    });

    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    expect(res.status).toBe('duplicate');
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0].clientId).toBe('C_EXISTING');
  });

  test('review match in reservation requires confirmReview', async () => {
    // Client with same name but different document
    fdb.seed('clients_prod/C_SIMILAR', {
      id: 'C_SIMILAR',
      tipo: 'natural',
      nombres: 'Carlos',
      apellidos: 'Gómez',
      dui: '99999999-9',
      createdBy: 'V2'
    });

    const blocked = await clientsSvc.reserveCreation({ caller: V1, client: validClient({ dui: '11111111-1' }) });
    expect(blocked.status).toBe('needs-review');

    const confirmed = await clientsSvc.reserveCreation({ caller: V1, client: validClient({ dui: '11111111-1' }), confirmReview: true });
    expect(confirmed.status).toBe('reserved');
  });

  test('cancelReservation: creator or manager can cancel an active reservation', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    const cancelRes = await clientsSvc.cancelReservation({ caller: V1, reservationId: res.reservationId });
    expect(cancelRes.status).toBe('cancelled');

    const doc = fdb.data(`client_reservations_prod/${res.reservationId}`);
    expect(doc.status).toBe('cancelled');
    expect(doc.cancelledBy).toBe('V1');
  });

  test('cancelReservation: another seller cannot cancel someone else reservation', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    await expect(clientsSvc.cancelReservation({ caller: V2, reservationId: res.reservationId }))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('finalizeCreation: formalizes client, updates reservation status, indexes identifiers, and creates op record', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    const opId = 'op_finalize_001';

    const fin = await clientsSvc.finalizeCreation({
      caller: V1,
      reservationId: res.reservationId,
      client: validClient(),
      opId
    });

    expect(fin.status).toBe('created');
    expect(fin.client.id).toBe(res.reservationId);
    expect(fin.client.createdBy).toBe('V1');
    expect(fin.client.visibleTo).toEqual(['V1']);
    expect(fin.client.closingVendors).toEqual([]);

    // Client exists in clients_prod
    const clientDoc = fdb.data(`clients_prod/${res.reservationId}`);
    expect(clientDoc).toBeDefined();
    expect(clientDoc.id).toBe(res.reservationId);

    // Reservation marked finalized
    const resDoc = fdb.data(`client_reservations_prod/${res.reservationId}`);
    expect(resDoc.status).toBe('finalized');
    expect(resDoc.finalizedBy).toBe('V1');

    // Identifiers indexed
    expect(fdb.data('clientIdentifiers_prod/DUI_012345678')).toBeDefined();
    expect(fdb.data('clientIdentifiers_prod/DUI_012345678').clientId).toBe(res.reservationId);

    // Op logged
    expect(fdb.data(`clientOps_prod/${opId}`)).toBeDefined();
    expect(fdb.data(`clientOps_prod/${opId}`).status).toBe('succeeded');
  });

  test('finalizeCreation: cannot finalize someone else reservation (impersonation prevented)', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    await expect(clientsSvc.finalizeCreation({
      caller: V2,
      reservationId: res.reservationId,
      client: validClient(),
      opId: 'op_spoof_001'
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('finalizeCreation: cannot finalize an expired reservation (> 30 min)', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });

    // Advance clock by 31 minutes
    nowMs += 31 * 60 * 1000;

    await expect(clientsSvc.finalizeCreation({
      caller: V1,
      reservationId: res.reservationId,
      client: validClient(),
      opId: 'op_expired_001'
    })).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('caducado') });
  });

  test('finalizeCreation: cannot finalize a cancelled reservation', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    await clientsSvc.cancelReservation({ caller: V1, reservationId: res.reservationId });

    await expect(clientsSvc.finalizeCreation({
      caller: V1,
      reservationId: res.reservationId,
      client: validClient(),
      opId: 'op_cancel_001'
    })).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('cancelada') });
  });

  test('finalizeCreation: cannot finalize the same reservation twice with a new opId', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    await clientsSvc.finalizeCreation({
      caller: V1,
      reservationId: res.reservationId,
      client: validClient(),
      opId: 'op_first_001'
    });

    // Second call with different opId
    await expect(clientsSvc.finalizeCreation({
      caller: V1,
      reservationId: res.reservationId,
      client: validClient(),
      opId: 'op_second_002'
    })).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('ya fue formalizada') });
  });

  test('finalizeCreation: replay of identical opId succeeds idempotently', async () => {
    const res = await clientsSvc.reserveCreation({ caller: V1, client: validClient() });
    const opId = 'op_replay_001';
    await clientsSvc.finalizeCreation({ caller: V1, reservationId: res.reservationId, client: validClient(), opId });

    const replay = await clientsSvc.finalizeCreation({ caller: V1, reservationId: res.reservationId, client: validClient(), opId });
    expect(replay.status).toBe('created');
    expect(replay.replay).toBe(true);
  });
});

describe('Storage Authorization Backend: closingVendors Maintenance', () => {
  let fdb;
  let workflowSvc;
  let commercialSvc;
  let clientsSvc;
  const now = new Date('2026-03-15T12:00:00.000Z');

  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: `User ${cid}` });
  const V1 = who('vendedor', 'V1');
  const V2 = who('vendedor', 'V2');
  const MGR = who('manager', 'M1');

  beforeEach(() => {
    fdb = createFakeFirestore({ clock: () => now });
    commercialSvc = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      verifyManager: async () => true,
      now: () => now
    });
    workflowSvc = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: commercialSvc.kit
    });
    clientsSvc = createClientsService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => now
    });

    // Seed client C1 with V1 as creator
    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'natural',
      nombres: 'Empresa',
      apellidos: 'Prueba',
      dui: '01234567-8',
      nit: '0614-101090-101-1',
      telefono: '7000-0000',
      correo: 'info@test.com',
      correo_fact: 'fact@test.com',
      createdBy: 'V1',
      visibleTo: ['V1'],
      closingVendors: [],
      documentos: {
        dui: { name: 'dui.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/dui.pdf' },
        nit: { name: 'nit.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/nit.pdf' }
      }
    });

    // Seed opportunity P1 for V2 in negociacion
    fdb.seed('prospects_prod/P1', {
      id: 'P1',
      codigo: '202601001',
      clientId: 'C1',
      createdBy: 'V2',
      vendedorId: 'V2',
      etapa: 'negociacion',
      estado: 'activo',
      precio_cotizado: 1000,
      costo_venta: 600,
      probabilidad: 50,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_oferta: [{ name: 'of.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/of.pdf' }],
        doc_costos: [{ name: 'co.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/co.pdf' }]
      },
      logs: [],
      facturas: []
    });
  });

  test('advanceStage to cierre adds the vendor to closingVendors atomically', async () => {
    // Before advance: closingVendors is empty
    expect(fdb.data('clients_prod/C1').closingVendors).toEqual([]);

    const res = await workflowSvc.advanceStage({
      caller: V2,
      prospectId: 'P1',
      nextStage: 'cierre',
      data: {
        forma_pago: '100% anticipado',
        factura_anticipo: 'FAC-001',
        doc_firmado: { name: 'oferta_firmada.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/f.pdf' },
        doc_comprobante: { name: 'comp.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/c.pdf' }
      }
    });

    expect(res.status).toBe('advanced');
    expect(res.etapa).toBe('cierre');

    // Client's closingVendors now includes V2
    const client = fdb.data('clients_prod/C1');
    expect(client.closingVendors).toContain('V2');
  });

  test('markLost removes vendor from closingVendors when no other closing opportunity remains', async () => {
    // Set P1 in cierre and V2 in closingVendors
    fdb.seed('prospects_prod/P1', {
      ...fdb.data('prospects_prod/P1'),
      etapa: 'cierre',
      estado: 'activo'
    });
    fdb.seed('clients_prod/C1', {
      ...fdb.data('clients_prod/C1'),
      closingVendors: ['V2']
    });

    const res = await workflowSvc.markLost({ caller: V2, prospectId: 'P1', reason: 'Precio' });
    expect(res.status).toBe('lost');

    // V2 is removed from closingVendors
    const client = fdb.data('clients_prod/C1');
    expect(client.closingVendors).not.toContain('V2');
  });

  test('markLost keeps vendor in closingVendors if vendor has a second opportunity in cierre', async () => {
    // V2 has P1 and P2 both in cierre
    fdb.seed('prospects_prod/P1', {
      ...fdb.data('prospects_prod/P1'),
      etapa: 'cierre',
      estado: 'activo'
    });
    fdb.seed('prospects_prod/P2', {
      id: 'P2',
      codigo: '202601002',
      clientId: 'C1',
      createdBy: 'V2',
      vendedorId: 'V2',
      etapa: 'cierre',
      estado: 'activo',
      logs: []
    });
    fdb.seed('clients_prod/C1', {
      ...fdb.data('clients_prod/C1'),
      closingVendors: ['V2']
    });

    // Mark P1 lost
    await workflowSvc.markLost({ caller: V2, prospectId: 'P1', reason: 'Precio' });

    // V2 is STILL in closingVendors because P2 is in cierre
    expect(fdb.data('clients_prod/C1').closingVendors).toContain('V2');

    // Now mark P2 lost
    await workflowSvc.markLost({ caller: V2, prospectId: 'P2', reason: 'Cliente desiste' });

    // Now V2 is removed from closingVendors
    expect(fdb.data('clients_prod/C1').closingVendors).not.toContain('V2');
  });

  test('deleteProspect removes vendor from closingVendors when no other closing opportunity remains', async () => {
    fdb.seed('prospects_prod/P1', {
      ...fdb.data('prospects_prod/P1'),
      etapa: 'cierre',
      estado: 'activo'
    });
    fdb.seed('clients_prod/C1', {
      ...fdb.data('clients_prod/C1'),
      closingVendors: ['V2']
    });

    // Delete P1
    const del = await workflowSvc.deleteProspect({ caller: MGR, prospectId: 'P1', motivo: 'Cancelación solicitada por cliente' });
    expect(del.status).toBe('deleted');

    // V2 is removed from closingVendors
    expect(fdb.data('clients_prod/C1').closingVendors).not.toContain('V2');
  });

  test('two sellers with different opportunities for same client are tracked independently', async () => {
    // V1 has P1 in cierre, V2 has P2 in negociacion
    fdb.seed('prospects_prod/P1', {
      ...fdb.data('prospects_prod/P1'),
      createdBy: 'V1',
      vendedorId: 'V1',
      etapa: 'cierre',
      estado: 'activo'
    });
    fdb.seed('prospects_prod/P2', {
      id: 'P2',
      clientId: 'C1',
      createdBy: 'V2',
      vendedorId: 'V2',
      etapa: 'negociacion',
      estado: 'activo',
      precio_cotizado: 2000,
      costo_venta: 1200,
      probabilidad: 50,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_oferta: [{ name: 'of.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/of.pdf' }],
        doc_costos: [{ name: 'co.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/co.pdf' }]
      },
      logs: [],
      facturas: []
    });
    fdb.seed('clients_prod/C1', {
      ...fdb.data('clients_prod/C1'),
      visibleTo: ['V1', 'V2'],
      closingVendors: ['V1']
    });

    // V2 advances P2 to cierre
    await workflowSvc.advanceStage({
      caller: V2,
      prospectId: 'P2',
      nextStage: 'cierre',
      data: {
        forma_pago: '100% anticipado',
        factura_anticipo: 'FAC-002',
        doc_firmado: { name: 'of2.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/of2.pdf' },
        doc_comprobante: { name: 'co2.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/co2.pdf' }
      }
    });

    // Both V1 and V2 are now in closingVendors
    let c = fdb.data('clients_prod/C1');
    expect(c.closingVendors).toContain('V1');
    expect(c.closingVendors).toContain('V2');

    // V1 loses P1
    await workflowSvc.markLost({ caller: V1, prospectId: 'P1', reason: 'Precio' });

    // V1 is removed, but V2 remains
    c = fdb.data('clients_prod/C1');
    expect(c.closingVendors).not.toContain('V1');
    expect(c.closingVendors).toContain('V2');
  });

  test('recomputeVisibility recalculates both visibleTo and closingVendors correctly', async () => {
    fdb.seed('prospects_prod/P1', {
      id: 'P1',
      clientId: 'C1',
      createdBy: 'V1',
      vendedorId: 'V1',
      etapa: 'cierre',
      estado: 'ganado'
    });
    fdb.seed('prospects_prod/P2', {
      id: 'P2',
      clientId: 'C1',
      createdBy: 'V2',
      vendedorId: 'V2',
      etapa: 'levantamiento',
      estado: 'activo'
    });
    fdb.seed('prospects_prod/P3', {
      id: 'P3',
      clientId: 'C1',
      createdBy: 'V3',
      vendedorId: 'V3',
      etapa: 'cierre',
      estado: 'perdido' // lost: not in closingVendors
    });

    await clientsSvc.recomputeVisibility(['C1']);

    const c = fdb.data('clients_prod/C1');
    // visibleTo has all sellers with non-deleted prospects
    expect(c.visibleTo).toEqual(['V1', 'V2', 'V3']);
    // closingVendors only has V1 (V2 is not in cierre; V3 is perdido)
    expect(c.closingVendors).toEqual(['V1']);
  });
});
