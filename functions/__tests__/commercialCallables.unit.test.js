// functions/__tests__/commercialCallables.unit.test.js
// UNIT layer, entry points: the commercial callables of functions/index.js (createProspectAdmin, addProspectLogAdmin,
// deleteProspectLogAdmin, reassignProspectAdmin, setNoContractAuthorizationAdmin, updateSettingsAdmin,
// deleteClientAdmin) and the opportunity-workflow callables (advanceProspectStageAdmin, markProspectLostAdmin,
// registerProposalAdmin, editProspectBasePriceAdmin, save/deleteChangeOrderAdmin, save/deleteInvoiceAdmin,
// save/deletePaymentAdmin, deleteProspectAdmin) with the in-memory Firestore and a fake Auth. Covers session handling, caller resolution from the
// CRM profile (never from the request), the live manager check, payload hygiene and error mapping.
// Not covered here (other layers): Firestore security rules, the real Functions runtime, a real Auth backend.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => {
  const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
  const fdb = createFakeFirestore({ clock: () => new Date('2026-03-15T12:00:00.000Z') });
  const authState = { users: {}, failWith: null };
  const firestore = () => fdb;
  firestore.FieldValue = fdb.FieldValue;
  firestore.Timestamp = { fromDate: d => ({ toDate: () => d }) };
  const auth = () => ({
    async getUser(uid) {
      if (authState.failWith) throw authState.failWith;
      const u = authState.users[uid];
      if (!u) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return { uid, ...u };
    }
  });
  return { initializeApp: () => {}, firestore, auth, __db: fdb, __auth: authState };
}, { virtual: true });

const admin = require('firebase-admin');
const fns = require('../index');
const fdb = admin.__db;
const authState = admin.__auth;

const MGR = { id: '1000000000001', authUid: 'uid-mgr', role: 'manager', nombre: 'Gerente Alfa', activo: true };
const GES = { id: '1000000000002', authUid: 'uid-ges', role: 'gestor', nombre: 'Gestora Gamma', activo: true };
const V1 = { id: '1792037387205', authUid: 'uid-v1', role: 'vendedor', nombre: 'Vendedor Uno', activo: true };
const V2 = { id: '1792038830686', authUid: 'uid-v2', role: 'vendedor', nombre: 'Vendedor Dos', activo: true };
const ctx = (p, token = {}) => ({ auth: { uid: p.authUid, token: { cid: p.id, role: p.role, ...(p.role === 'manager' ? { manager: true } : {}), ...token } } });
const NOSESSION = [null, {}, { auth: null }];

let n = 0;
const op = () => `op-cb-${String(++n).padStart(8, '0')}`;
const prospectInput = (o = {}) => ({ clientId: 'C1', proyecto: 'Torre Norte', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos', ...o });

// name -> { fn, data, who: roles that must succeed, managerOnly }
const CALLS = {
  createProspectAdmin: { fn: fns.createProspectAdmin, data: () => ({ prospect: prospectInput(), opId: op() }) },
  addProspectLogAdmin: { fn: fns.addProspectLogAdmin, data: () => ({ prospectId: 'P1', text: 'nota', opId: op() }) },
  deleteProspectLogAdmin: { fn: fns.deleteProspectLogAdmin, data: () => ({ prospectId: 'P1', date: '2026-01-01T00:00:00.000Z', text: '(Ana)  nota vieja' }) },
  reassignProspectAdmin: { fn: fns.reassignProspectAdmin, data: () => ({ prospectId: 'P1', vendedorId: V2.id }) },
  setNoContractAuthorizationAdmin: { fn: fns.setNoContractAuthorizationAdmin, data: () => ({ prospectId: 'P1', authorized: true }), managerOnly: true },
  updateSettingsAdmin: { fn: fns.updateSettingsAdmin, data: () => ({ action: 'addItem', list: 'visitantes', value: 'Beto' }), managerOnly: true },
  deleteClientAdmin: { fn: fns.deleteClientAdmin, data: () => ({ clientId: 'C2' }), managerOnly: true },
  advanceProspectStageAdmin: { fn: fns.advanceProspectStageAdmin, data: () => ({ prospectId: 'P1', nextStage: 'levantamiento', data: { visitante: 'Ana', fecha_inicio: '2026-03-01' } }) },
  markProspectLostAdmin: { fn: fns.markProspectLostAdmin, data: () => ({ prospectId: 'P1', reason: 'Precio' }) },
  registerProposalAdmin: { fn: fns.registerProposalAdmin, data: () => ({ prospectId: 'P1', costo_venta: 1, precio_cotizado: 2, doc_oferta: [], doc_costos: [] }) },
  editProspectBasePriceAdmin: { fn: fns.editProspectBasePriceAdmin, data: () => ({ prospectId: 'P1', precio: 2, costo: 1, motivo: 'x', expectedOldPrice: 2, expectedOldCost: 1 }) },
  saveChangeOrderAdmin: { fn: fns.saveChangeOrderAdmin, data: () => ({ prospectId: 'P1', tipo: 'adicional', desc: 'x', precio: 1, costo: 1, opId: op() }) },
  deleteChangeOrderAdmin: { fn: fns.deleteChangeOrderAdmin, data: () => ({ prospectId: 'P1', orderId: 'OC1' }) },
  saveInvoiceAdmin: { fn: fns.saveInvoiceAdmin, data: () => ({ prospectId: 'P1', numero: 'F1', monto: 1, opId: op() }) },
  deleteInvoiceAdmin: { fn: fns.deleteInvoiceAdmin, data: () => ({ prospectId: 'P1', invoiceId: 'F1' }) },
  savePaymentAdmin: { fn: fns.savePaymentAdmin, data: () => ({ prospectId: 'P1', invoiceId: 'F1', monto: 1, metodo: 'transferencia', ref: 'r', opId: op() }) },
  deletePaymentAdmin: { fn: fns.deletePaymentAdmin, data: () => ({ prospectId: 'P1', invoiceId: 'F1', paymentKey: 'PAY1' }) },
  deleteProspectAdmin: { fn: fns.deleteProspectAdmin, data: () => ({ prospectId: 'P1' }), managerOnly: true }
};

beforeEach(() => {
  fdb.clear();
  authState.users = { 'uid-mgr': { customClaims: { manager: true, role: 'manager' } }, 'uid-ges': { customClaims: { role: 'gestor' } }, 'uid-v1': { customClaims: { role: 'vendedor' } } };
  authState.failWith = null;
  delete process.env.FUNCTIONS_EMULATOR; delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  for (const p of [MGR, GES, V1, V2]) fdb.seed(`users_prod/${p.id}`, p);
  fdb.seed('users_prod/OP1', { id: 'OP1', authUid: 'uid-op', role: 'operario', nombre: 'Operario', activo: true });
  fdb.seed('users_prod/INACT', { id: 'INACT', authUid: 'uid-in', role: 'vendedor', nombre: 'Inactivo', activo: false });
  fdb.seed('users_prod/LEGACY1', { id: 'LEGACY1', role: 'vendedor', nombre: 'Historico', activo: true, password: 'legacy-placeholder' });
  fdb.seed('clients_prod/C1', { id: 'C1', tipo: 'juridica', empresa: 'Delta', contacto: 'Ana', telefono: '1', createdBy: V1.id });
  fdb.seed('clients_prod/C2', { id: 'C2', tipo: 'juridica', empresa: 'Sin Proyectos', contacto: 'Z', telefono: '1', createdBy: V1.id });
  fdb.seed('prospects_prod/P1', {
    id: 'P1', codigo: '202601001', clientId: 'C1', createdBy: V1.id, vendedorId: V1.id, vendedorName: 'Vendedor Uno', fecha_creacion: '2026-01-01T00:00:00.000Z', estado: 'activo', datos: {},
    logs: [{ text: '(Ana)  nota vieja', date: '2026-01-01T00:00:00.000Z', auto: false }], facturas: []
  });
});

describe.each(Object.entries(CALLS))('%s: session and caller resolution', (name, { fn, data }) => {
  test.each(NOSESSION)('no session (%j) -> unauthenticated', async (c) => {
    await expect(fn(data(), c)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  test('Auth account without a CRM profile -> permission-denied', async () => {
    await expect(fn(data(), { auth: { uid: 'uid-x', token: { cid: 'NOPE' } } })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(fn(data(), { auth: { uid: 'uid-x', token: {} } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('inactive profile -> permission-denied', async () => {
    await expect(fn(data(), { auth: { uid: 'uid-in', token: { cid: 'INACT' } } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('historical profile (no authUid) cannot be reached with a forged cid claim', async () => {
    await expect(fn(data(), { auth: { uid: 'uid-evil', token: { cid: 'LEGACY1', role: 'vendedor' } } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('a cid claim that points at SOMEONE ELSE\'s profile is refused (uid must match the profile)', async () => {
    await expect(fn(data(), { auth: { uid: 'uid-v1', token: { cid: MGR.id, role: 'manager', manager: true } } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('plant role (operario) has no access to commercial operations', async () => {
    await expect(fn(data(), { auth: { uid: 'uid-op', token: { cid: 'OP1' } } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('unknown dbSuffix is refused before anything else', async () => {
    await expect(fn({ ...data(), dbSuffix: '_evil' }, ctx(MGR))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('under the Functions emulator it refuses to run without both emulators (could reach production)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    await expect(fn(data(), ctx(MGR))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  test('an unexpected failure is reported as internal WITHOUT leaking its message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fdb.state.hooks.beforeGet = (p) => { if (p.startsWith('users_prod/')) throw new Error('secret db detail'); };
    const err = await fn(data(), ctx(MGR)).catch(e => e);
    expect(err.code).toBe('internal');
    expect(String(err.message)).not.toMatch(/secret/);
    spy.mockRestore();
  });
});

describe('role resolution never trusts the token or the payload', () => {
  test('role and manager flags in the REQUEST body change nothing', async () => {
    await expect(fns.setNoContractAuthorizationAdmin({ prospectId: 'P1', authorized: true, role: 'manager', manager: true }, ctx(V1))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(fns.updateSettingsAdmin({ action: 'addItem', list: 'visitantes', value: 'x', role: 'manager' }, ctx(GES))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(fns.reassignProspectAdmin({ prospectId: 'P1', vendedorId: V2.id, role: 'gestor' }, ctx(V1))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fdb.data('prospects_prod/P1').datos).toEqual({});
  });

  test('a vendedor profile whose token CLAIMS manager is still a vendedor', async () => {
    const forged = ctx(V1, { role: 'manager', manager: true });
    await expect(fns.deleteClientAdmin({ clientId: 'C2' }, forged)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fdb.data('clients_prod/C2')).toBeDefined();
  });

  test('a manager profile whose TOKEN lacks the manager claim is refused', async () => {
    await expect(fns.updateSettingsAdmin({ action: 'addItem', list: 'visitantes', value: 'x' }, { auth: { uid: MGR.authUid, token: { cid: MGR.id, role: 'manager' } } })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('a manager token whose Auth account has LOST the claim (stale token) is refused by the live check', async () => {
    authState.users['uid-mgr'] = { customClaims: { role: 'manager' } };
    await expect(fns.setNoContractAuthorizationAdmin({ prospectId: 'P1', authorized: true }, ctx(MGR))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fdb.data('prospects_prod/P1').datos).toEqual({});
  });

  test('a manager token whose Auth account is DISABLED or deleted is refused', async () => {
    authState.users['uid-mgr'] = { customClaims: { manager: true }, disabled: true };
    await expect(fns.deleteClientAdmin({ clientId: 'C2' }, ctx(MGR))).rejects.toMatchObject({ code: 'permission-denied' });
    delete authState.users['uid-mgr'];
    await expect(fns.deleteClientAdmin({ clientId: 'C2' }, ctx(MGR))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fdb.data('clients_prod/C2')).toBeDefined();
  });

  test('if the live Auth lookup itself fails the answer is internal, never an implicit grant', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    authState.failWith = Object.assign(new Error('auth backend down'), { code: 'auth/internal-error' });
    const err = await fns.deleteClientAdmin({ clientId: 'C2' }, ctx(MGR)).catch(e => e);
    expect(err.code).toBe('internal');
    expect(String(err.message)).not.toMatch(/backend/);
    expect(fdb.data('clients_prod/C2')).toBeDefined();
    spy.mockRestore();
  });

  test('a linked profile with NO cid claim is served (resolved by authUid) with the profile role', async () => {
    const r = await fns.addProspectLogAdmin({ prospectId: 'P1', text: 'sin claim cid', opId: op() }, { auth: { uid: 'uid-v1', token: {} } });
    expect(r.status).toBe('added');
    const last = fdb.data('prospects_prod/P1').logs.slice(-1)[0];
    expect(last).toMatchObject({ by: V1.id, byName: 'Vendedor Uno' });
  });
});

describe('legitimate calls through the real entry points', () => {
  test('createProspectAdmin: vendedor creates; forged identity fields in the body are ignored', async () => {
    const r = await fns.createProspectAdmin({ prospect: prospectInput({ createdBy: MGR.id, createdByName: 'Gerente Alfa', vendedorName: 'x', etapa: 'cierre', estado: 'ganado' }), opId: op() }, ctx(V1));
    expect(r.status).toBe('created');
    const p = fdb.data(`prospects_prod/${r.prospect.id}`);
    expect(p).toMatchObject({ createdBy: V1.id, createdByName: 'Vendedor Uno', createdByRole: 'vendedor', vendedorId: V1.id, etapa: 'prospecto', estado: 'activo' });
  });

  test('createProspectAdmin: assigning to another user is refused for a vendedor and allowed for a gestor and manager', async () => {
    await expect(fns.createProspectAdmin({ prospect: prospectInput({ vendedorId: V2.id }), opId: op() }, ctx(V1))).rejects.toMatchObject({ code: 'permission-denied' });
    const rGes = await fns.createProspectAdmin({ prospect: prospectInput({ vendedorId: V2.id }), opId: op() }, ctx(GES));
    expect(fdb.data(`prospects_prod/${rGes.prospect.id}`)).toMatchObject({ createdBy: GES.id, vendedorId: V2.id, vendedorName: 'Vendedor Dos' });
    const r = await fns.createProspectAdmin({ prospect: prospectInput({ vendedorId: V2.id }), opId: op() }, ctx(MGR));
    expect(fdb.data(`prospects_prod/${r.prospect.id}`)).toMatchObject({ createdBy: MGR.id, vendedorId: V2.id, vendedorName: 'Vendedor Dos' });
  });

  test('createProspectAdmin: a missing `prospect` object is an invalid argument', async () => {
    await expect(fns.createProspectAdmin({ opId: op() }, ctx(V1))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(fns.createProspectAdmin(null, ctx(V1))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('addProspectLogAdmin: author, date and kind sent by the browser are ignored', async () => {
    await fns.addProspectLogAdmin({ prospectId: 'P1', text: 'hola', opId: op(), author: 'Gerente Alfa', by: MGR.id, auto: true, date: '1999-01-01T00:00:00.000Z' }, ctx(V1));
    const e = fdb.data('prospects_prod/P1').logs.slice(-1)[0];
    expect(e).toMatchObject({ text: '(Vendedor Uno)  hola', auto: false, by: V1.id });
    expect(e.date).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Math.abs(Date.now() - new Date(e.date).getTime())).toBeLessThan(10000); // server clock
  });

  test('deleteProspectLogAdmin: an author removes a note; the stored history of others is protected', async () => {
    const add = await fns.addProspectLogAdmin({ prospectId: 'P1', text: 'borrar', opId: op() }, ctx(V1));
    await expect(fns.deleteProspectLogAdmin({ prospectId: 'P1', date: '2026-01-01T00:00:00.000Z', text: '(Ana)  nota vieja' }, ctx(V1))).rejects.toMatchObject({ code: 'permission-denied' });
    const r = await fns.deleteProspectLogAdmin({ prospectId: 'P1', date: add.entry.date, text: add.entry.text }, ctx(V1));
    expect(r.status).toBe('deleted');
  });

  test('reassignProspectAdmin: only manager reassigns; gestor and vendedor cannot', async () => {
    await expect(fns.reassignProspectAdmin({ prospectId: 'P1', vendedorId: V2.id }, ctx(V1))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(fns.reassignProspectAdmin({ prospectId: 'P1', vendedorId: V2.id }, ctx(GES))).rejects.toMatchObject({ code: 'permission-denied' });
    const r = await fns.reassignProspectAdmin({ prospectId: 'P1', vendedorId: V2.id }, ctx(MGR));
    expect(r.status).toBe('reassigned');
    expect(fdb.data('prospects_prod/P1')).toMatchObject({ createdBy: V1.id, vendedorId: V2.id, vendedorName: 'Vendedor Dos' });
  });

  test('setNoContractAuthorizationAdmin: manager grants; the authoriser is the session profile (only in closing, eligible)', async () => {
    fdb.seed('prospects_prod/P1', { ...fdb.data('prospects_prod/P1'), etapa: 'cierre', tipo_proyecto: 'Fabricación e instalación', precio_cotizado: 15000, costo_venta: 8000 });
    const r = await fns.setNoContractAuthorizationAdmin({ prospectId: 'P1', authorized: true, autorizado_por: 'Otra Persona' }, ctx(MGR));
    expect(r.status).toBe('updated');
    expect(fdb.data('prospects_prod/P1').datos).toMatchObject({ autorizado_sin_contrato: true, autorizado_por: 'Gerente Alfa', autorizado_por_id: MGR.id });
  });

  test('setNoContractAuthorizationAdmin: rejected when prospect is in negociacion or earlier', async () => {
    fdb.seed('prospects_prod/P1', { ...fdb.data('prospects_prod/P1'), etapa: 'negociacion', tipo_proyecto: 'Fabricación e instalación', precio_cotizado: 15000, costo_venta: 8000 });
    await expect(fns.setNoContractAuthorizationAdmin({ prospectId: 'P1', authorized: true }, ctx(MGR))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('setNoContractAuthorizationAdmin: rejected when prospect is not eligible (> $10k e instalación)', async () => {
    fdb.seed('prospects_prod/P1', { ...fdb.data('prospects_prod/P1'), etapa: 'cierre', tipo_proyecto: 'Solo suministro', precio_cotizado: 5000, costo_venta: 3000 });
    await expect(fns.setNoContractAuthorizationAdmin({ prospectId: 'P1', authorized: true }, ctx(MGR))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('updateSettingsAdmin: manager adds a visitor', async () => {
    const r = await fns.updateSettingsAdmin({ action: 'addItem', list: 'visitantes', value: 'Beto' }, ctx(MGR));
    expect(r.settings.visitantes).toEqual(['Beto']);
  });

  test('deleteClientAdmin: manager deletes a client without opportunities; one with opportunities is refused', async () => {
    await expect(fns.deleteClientAdmin({ clientId: 'C1' }, ctx(MGR))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await fns.deleteClientAdmin({ clientId: 'C2' }, ctx(MGR))).status).toBe('deleted');
    expect(fdb.data('clients_prod/C2')).toBeUndefined();
  });

  test('operations act on the environment the request names (_prod here); _local collections stay untouched', async () => {
    fdb.seed('clients_local/C1', { id: 'C1', tipo: 'juridica', empresa: 'Local', contacto: 'x', telefono: '1', createdBy: V1.id });
    fdb.seed('users_local/' + V1.id, V1);
    const r = await fns.createProspectAdmin({ prospect: prospectInput(), opId: op(), dbSuffix: '_local' }, ctx(V1));
    expect(fdb.data(`prospects_local/${r.prospect.id}`)).toBeDefined();
    expect(fdb.data(`prospects_prod/${r.prospect.id}`)).toBeUndefined();
  });
});

describe('opportunity workflow through the real entry points', () => {
  test('markProspectLostAdmin: the owner loses their opportunity; another vendedor is refused; the audit comes from the session', async () => {
    await expect(fns.markProspectLostAdmin({ prospectId: 'P1', reason: 'Precio' }, ctx(V2))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fdb.data('prospects_prod/P1').estado).toBe('activo');
    const r = await fns.markProspectLostAdmin({ prospectId: 'P1', reason: 'Precio', usuario: 'Otro', by: MGR.id }, ctx(V1));
    expect(r.status).toBe('lost');
    expect(fdb.data('prospects_prod/P1').estado).toBe('perdido');
    const audits = JSON.stringify(fdb.list('commercialAudit_prod'));
    expect(audits).toContain(V1.id);
    expect(audits).not.toContain('Otro');
  });

  test('deleteProspectAdmin: only a manager; a vendedor who owns it, a gestor and a forged claim are refused', async () => {
    for (const who of [ctx(V1), ctx(GES), ctx(V1, { role: 'manager', manager: true })]) {
      await expect(fns.deleteProspectAdmin({ prospectId: 'P1', motivo: 'Duplicada' }, who)).rejects.toMatchObject({ code: 'permission-denied' });
    }
    expect(fdb.data('prospects_prod/P1').eliminado).toBeUndefined();
    await expect(fns.deleteProspectAdmin({ prospectId: 'P1' }, ctx(MGR))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await fns.deleteProspectAdmin({ prospectId: 'P1', motivo: 'Duplicada' }, ctx(MGR))).status).toBe('deleted');
    const gone = fdb.data('prospects_prod/P1');
    expect(gone).toBeDefined(); // logical deletion: the document and its history stay
    expect(gone.eliminado).toBe(true);
    expect(gone.eliminado_por_id).toBe(MGR.id);
    expect(gone.motivo_eliminacion).toBe('Duplicada');
    await expect(fns.markProspectLostAdmin({ prospectId: 'P1', reason: 'Precio' }, ctx(V1))).rejects.toMatchObject({ code: 'not-found' });
  });

  test('workflow operations act on the environment the request names; _prod stays untouched', async () => {
    fdb.seed('users_local/' + V1.id, V1);
    fdb.seed('prospects_local/PL', { id: 'PL', clientId: 'C1', createdBy: V1.id, vendedorId: V1.id, estado: 'activo', etapa: 'prospecto', datos: {}, logs: [] });
    const r = await fns.markProspectLostAdmin({ prospectId: 'PL', reason: 'Precio', dbSuffix: '_local' }, ctx(V1));
    expect(r.status).toBe('lost');
    expect(fdb.data('prospects_local/PL').estado).toBe('perdido');
    expect(fdb.data('prospects_prod/P1').estado).toBe('activo');
  });

  test('the request cannot name the stage, state or invoices of the document: extra fields are ignored', async () => {
    await fns.advanceProspectStageAdmin({ prospectId: 'P1', nextStage: 'levantamiento', data: { visitante: 'Ana', fecha_inicio: '2026-03-01', distancia: 5, etapa: 'cierre', estado: 'ganado', facturas: [{ id: 'X' }] }, estado: 'ganado', etapa: 'cierre' }, ctx(V1)).catch(() => {});
    const p = fdb.data('prospects_prod/P1');
    expect(p.estado).toBe('activo');
    expect(p.facturas).toEqual([]);
    expect(p.etapa).not.toBe('cierre');
  });
});
