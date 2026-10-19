// functions/isolated-tests/commercialFlow.e2e.iso.js
// END TO END on the isolated emulators (Auth 9399, Firestore 8190, Functions 5101): the commercial workflow callables
// (createProspectAdmin, advanceProspectStageAdmin, markProspectLostAdmin, saveInvoiceAdmin, savePaymentAdmin,
// deleteInvoiceAdmin, deleteProspectAdmin ...) called over HTTP with REAL Auth tokens (real custom claims), running in
// the REAL Functions emulator against the REAL Firestore emulator. Calls use dbSuffix '_prod' (the collections the
// proposed rules protect); this is the isolated emulator: nothing here can reach a Firebase project.
// What this proves that the unit/service layers cannot: the deployed-shape wiring (index.js exports, runtime guards, claims
// -> profile resolution, transaction contention over HTTP). What it does NOT prove: production behaviour, real Storage links.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { fsApi, clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, PROJECT } = require('./iso');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();

const AUTH = 'http://127.0.0.1:9399';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;
const CID = { MGR: '1000000000001', GES: '1000000000002', A: '1792037387205', B: '1792038830686', LEGACY: '1700000000001', OPER: '1800000000002' };
const S = {};

async function post(url, body, token) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const call = (name, data, token) => post(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, token);

async function makeAccount(tag, cid, role, { linked = true } = {}) {
  const email = `${tag}@ductsal-test.invalid`;
  const password = 'Pw-' + crypto.randomBytes(12).toString('hex') + '!'; // random, test-only, never printed
  const up = await post(idt('accounts:signUp'), { email, password, returnSecureToken: true });
  const uid = up.json.localId;
  await auth.setCustomUserClaims(uid, { role, cid, ...(role === 'manager' ? { manager: true } : {}) });
  const profile = { id: cid, nombre: tag, email, role, activo: true };
  if (linked) profile.authUid = uid;
  await db.collection('users_prod').doc(cid).set(profile);
  const inn = await post(idt('accounts:signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid, token: inn.json.idToken, cid };
}

let seq = 0;
const opId = () => `op-flow-${Date.now()}-${++seq}`;
const file = n => ({ name: n, url: `http://127.0.0.1:9290/v0/b/${PROJECT}.appspot.com/o/${n}?alt=media` });
const CLIENT = { id: 'CW', tipo: 'juridica', empresa: 'Industrias Delta', contacto: 'Ana', nit: '0614-1', nrc: '1-2', telefono: '7000', correo: 'a@b.c', correo_fact: 'f@b.c', documentos: { dui: file('dui.pdf') } };
const prospectDoc = async id => (await db.collection('prospects_prod').doc(id).get()).data();
const audits = async action => (await db.collection('commercialAudit_prod').get()).docs.map(d => d.data()).filter(a => !action || a.action === action);
let pid;

beforeAll(async () => {
  await assertIsolatedUp();
  const fnUp = await fetch('http://127.0.0.1:5101/').catch(() => null);
  if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering: start the isolated emulators with functions');
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await clearIsolatedFirestore();
  await loadFirestoreRules();
  S.MGR = await makeAccount('gerente', CID.MGR, 'manager');
  S.GES = await makeAccount('gestor', CID.GES, 'gestor');
  S.A = await makeAccount('vendedor.a', CID.A, 'vendedor');
  S.B = await makeAccount('vendedor.b', CID.B, 'vendedor');
  S.OPER = await makeAccount('operario', CID.OPER, 'operario');
  S.LEGACY = await makeAccount('historico', CID.LEGACY, 'vendedor', { linked: false });
  await db.collection('clients_prod').doc('CW').set(CLIENT);
}, 60000);

describe('end to end: commercial workflow through real tokens, the Functions emulator and Firestore', () => {
  test('every workflow callable rejects a request without session', async () => {
    for (const n of ['createProspectAdmin', 'advanceProspectStageAdmin', 'markProspectLostAdmin', 'registerProposalAdmin', 'editProspectBasePriceAdmin', 'saveChangeOrderAdmin', 'deleteChangeOrderAdmin', 'saveInvoiceAdmin', 'deleteInvoiceAdmin', 'savePaymentAdmin', 'deletePaymentAdmin', 'deleteProspectAdmin', 'requestNoContractAuthorizationAdmin', 'resolveNoContractAuthorizationAdmin']) {
      const r = await call(n, { prospectId: 'X', opId: opId() }, null);
      expect(r.json.error.status).toBe('UNAUTHENTICATED');
    }
  });

  test('plant and historical (unlinked) profiles are refused', async () => {
    for (const s of [S.OPER, S.LEGACY]) {
      const r = await call('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'X', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, s.token);
      expect(r.json.error.status).toBe('PERMISSION_DENIED');
    }
  });

  test('vendedor A creates an opportunity: identity and code are decided by the server', async () => {
    const r = await call('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'Nave Industrial', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos', createdBy: CID.B, etapa: 'cierre', estado: 'ganado' }, opId: opId() }, S.A.token);
    expect(r.json.error).toBeUndefined();
    pid = r.json.result.prospect.id;
    const p = await prospectDoc(pid);
    expect(p).toMatchObject({ createdBy: CID.A, etapa: 'prospecto', estado: 'activo' });
    expect(p.codigo).toBeTruthy();
  });

  test('vendedor B cannot touch A\'s opportunity (any operation), and nothing changes', async () => {
    const before = await prospectDoc(pid);
    const attempts = [
      ['markProspectLostAdmin', { prospectId: pid, reason: 'Precio' }],
      ['advanceProspectStageAdmin', { prospectId: pid, nextStage: 'levantamiento', data: { visitante: 'B', distancia: 1 } }],
      ['editProspectBasePriceAdmin', { prospectId: pid, precio: 1, costo: 1, motivo: 'x' }],
      ['deleteProspectAdmin', { prospectId: pid, motivo: 'Intento ajeno' }],
      ['requestNoContractAuthorizationAdmin', { prospectId: pid, motivo: 'Intento ajeno', opId: opId() }]
    ];
    for (const [n, d] of attempts) expect((await call(n, d, S.B.token)).json.error.status).toBe('PERMISSION_DENIED');
    expect(await prospectDoc(pid)).toEqual(before);
  });

  test('stages must be followed in order; a skip to cierre is refused by the server', async () => {
    const skip = await call('advanceProspectStageAdmin', { prospectId: pid, nextStage: 'cierre', data: { forma_pago: '70/30', factura_anticipo: 'F-1', doc_firmado: file('f.pdf'), doc_comprobante: file('c.pdf') } }, S.A.token);
    expect(skip.json.error.status).toBe('FAILED_PRECONDITION');
    expect((await prospectDoc(pid)).etapa).toBe('prospecto');
  });

  test('A walks prospecto -> levantamiento -> cotizacion -> negociacion -> cierre; the advance invoice is computed by the server', async () => {
    const step = async (nextStage, data) => { const r = await call('advanceProspectStageAdmin', { prospectId: pid, nextStage, data }, S.A.token); expect(r.json.error).toBeUndefined(); return r.json.result; };
    await step('levantamiento', { visitante: 'Luis', fecha_inicio: '2026-04-01', ubicacion: 'San Salvador', distancia: 12, fecha_visita: '2026-03-20', doc_levantamiento: [file('lev.pdf')] });
    await step('cotizacion', { costo_venta: 6000, precio_cotizado: 10000, probabilidad: 'alta', doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')] });
    await step('negociacion', { costo_venta: 6000, precio_cotizado: 10000, probabilidad: 'alta' });
    // amount / state fields sent by the browser are ignored: only the server computes the invoice
    const r = await step('cierre', { forma_pago: '70/30', factura_anticipo: 'FAC-1', doc_firmado: file('firmado.pdf'), doc_comprobante: file('comp.pdf'), monto: 1, estado: 'activo' });
    expect(r).toMatchObject({ status: 'advanced', etapa: 'cierre', estado: 'ganado' });
    const p = await prospectDoc(pid);
    expect(p.facturas).toHaveLength(1);
    expect(p.facturas[0].monto).toBe(7910); // 10000 x 1.13 x 70%
    expect(p.facturas[0].numero).toBe('FAC-1');
    expect((await audits('advanceStage')).map(a => a.actorCid)).toEqual(expect.arrayContaining([CID.A]));
  });

  test('closing again is idempotent: still exactly one advance invoice', async () => {
    const r = await call('advanceProspectStageAdmin', { prospectId: pid, nextStage: 'cierre', data: { forma_pago: '70/30', factura_anticipo: 'FAC-1', doc_firmado: file('firmado.pdf'), doc_comprobante: file('comp.pdf') } }, S.A.token);
    expect(r.json.error).toBeUndefined();
    expect(r.json.result.status).toBe('unchanged');
    expect((await prospectDoc(pid)).facturas).toHaveLength(1);
  });

  test('invoices: the balance ceiling holds when four invoices race over HTTP (3390 remaining, 4 x 1000)', async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(n => call('saveInvoiceAdmin', { prospectId: pid, numero: `RACE-${n}`, monto: 1000, doc_factura: file(`r${n}.pdf`), opId: opId() }, n % 2 ? S.A.token : S.GES.token)));
    const ok = rs.filter(r => r.json.result && r.json.result.status === 'created');
    const refused = rs.filter(r => r.json.error);
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(refused[0].json.error.status).toBe('FAILED_PRECONDITION');
    const p = await prospectDoc(pid);
    expect(p.facturas).toHaveLength(4);
    expect(p.facturas.reduce((s, f) => s + f.monto, 0)).toBeLessThanOrEqual(11300.1);
  });

  test('a retried creation (same opId) never duplicates the invoice', async () => {
    const id = opId();
    const p0 = await prospectDoc(pid);
    const room = 11300 - p0.facturas.reduce((s, f) => s + f.monto, 0);
    const a = await call('saveInvoiceAdmin', { prospectId: pid, numero: 'RETRY', monto: Math.min(100, Math.floor(room)), doc_factura: file('rt.pdf'), opId: id }, S.A.token);
    const b = await call('saveInvoiceAdmin', { prospectId: pid, numero: 'RETRY', monto: Math.min(100, Math.floor(room)), doc_factura: file('rt.pdf'), opId: id }, S.A.token);
    expect(a.json.result.status).toBe('created');
    expect(b.json.result.status).toBe('unchanged');
    expect((await prospectDoc(pid)).facturas.filter(f => f.numero === 'RETRY')).toHaveLength(1);
  });

  test('payments: recorded against the stored invoice with the session identity; a payment above the balance is refused', async () => {
    const p = await prospectDoc(pid);
    const inv = p.facturas[0];
    const over = await call('savePaymentAdmin', { prospectId: pid, invoiceId: inv.id, monto: inv.monto + 500, metodo: 'transferencia', ref: 'R', doc_comprobante: file('pg.pdf'), opId: opId() }, S.A.token);
    expect(over.json.error.status).toBe('FAILED_PRECONDITION');
    const ok = await call('savePaymentAdmin', { prospectId: pid, invoiceId: inv.id, monto: 1000, metodo: 'transferencia', ref: 'R-1', doc_comprobante: file('pg.pdf'), opId: opId(), usuario: 'Otro' }, S.A.token);
    expect(ok.json.result.status).toBe('created');
    const after = await prospectDoc(pid);
    expect(after.facturas[0].pagos).toHaveLength(1);
    expect(JSON.stringify(after.logs.slice(-1))).not.toContain('Otro');
  });

  test('deleting: the advance invoice cannot be deleted; deleting another leaves an audit and a panel notice from the session identity', async () => {
    const p = await prospectDoc(pid);
    const first = await call('deleteInvoiceAdmin', { prospectId: pid, invoiceId: p.facturas[0].id }, S.GES.token);
    expect(first.json.error.status).toBe('FAILED_PRECONDITION');
    const target = p.facturas[p.facturas.length - 1];
    const del = await call('deleteInvoiceAdmin', { prospectId: pid, invoiceId: target.id }, S.GES.token);
    expect(del.json.result.status).toBe('deleted');
    expect((await audits('deleteInvoice')).some(a => a.actorCid === CID.GES)).toBe(true);
    const notices = (await db.collection('audit_logs_prod').get()).docs.map(d => d.data());
    expect(notices.some(n => n.usuarioId === CID.GES && n.source === 'callable')).toBe(true);
  });

  test('deleteProspectAdmin (logical deletion): owner A and gestor are refused; the manager needs a reason; the document stays, marked, with audit + notice', async () => {
    for (const s of [S.A, S.GES]) expect((await call('deleteProspectAdmin', { prospectId: pid, motivo: 'Duplicada' }, s.token)).json.error.status).toBe('PERMISSION_DENIED');
    expect((await prospectDoc(pid)).eliminado).toBeUndefined();
    expect((await call('deleteProspectAdmin', { prospectId: pid }, S.MGR.token)).json.error.status).toBe('INVALID_ARGUMENT');
    expect((await call('deleteProspectAdmin', { prospectId: pid, motivo: '   ' }, S.MGR.token)).json.error.status).toBe('INVALID_ARGUMENT');
    const r = await call('deleteProspectAdmin', { prospectId: pid, motivo: 'Proyecto duplicado' }, S.MGR.token);
    expect(r.json.result.status).toBe('deleted');
    const gone = await prospectDoc(pid);
    expect(gone).toBeDefined(); // nothing was physically deleted: invoices, payments, files and history are still there
    expect(gone).toMatchObject({ eliminado: true, eliminado_por_id: CID.MGR, motivo_eliminacion: 'Proyecto duplicado' });
    expect(gone.fecha_eliminacion).toBeTruthy();
    expect(gone.facturas.length).toBeGreaterThan(0);
    expect((await audits('deleteProspect')).some(a => a.actorCid === CID.MGR && a.detail && a.detail.logical === true)).toBe(true);
    const notices = (await db.collection('audit_logs_prod').get()).docs.map(d => d.data());
    expect(notices.some(n => n.usuarioId === CID.MGR && /elimin/i.test(JSON.stringify(n)) && /Proyecto duplicado/.test(JSON.stringify(n)))).toBe(true);
    const again = await call('deleteProspectAdmin', { prospectId: pid, motivo: 'Otra vez' }, S.MGR.token);
    expect(again.json.result.status).toBe('unchanged');
    expect((await prospectDoc(pid)).motivo_eliminacion).toBe('Proyecto duplicado'); // the first deletion record is never overwritten
  });

  test('a logically deleted opportunity cannot be modified by any normal callable (owner, gestor or manager)', async () => {
    const before = await prospectDoc(pid);
    const attempts = [
      ['markProspectLostAdmin', { prospectId: pid, reason: 'Precio' }],
      ['advanceProspectStageAdmin', { prospectId: pid, nextStage: 'cierre', data: {} }],
      ['saveInvoiceAdmin', { prospectId: pid, numero: 'ZZ-1', monto: 1, doc_factura: file('z.pdf'), opId: opId() }],
      ['savePaymentAdmin', { prospectId: pid, invoiceId: before.facturas[0].id, monto: 1, metodo: 'transferencia', ref: 'Z', doc_comprobante: file('z.pdf'), opId: opId() }],
      ['deleteInvoiceAdmin', { prospectId: pid, invoiceId: before.facturas[0].id }],
      ['editProspectBasePriceAdmin', { prospectId: pid, precio: 1, costo: 1, motivo: 'x' }],
      ['setNoContractAuthorizationAdmin', { prospectId: pid, authorized: true }],
      ['requestNoContractAuthorizationAdmin', { prospectId: pid, motivo: 'x', opId: opId() }]
    ];
    for (const s of [S.A, S.GES, S.MGR]) {
      for (const [n, d] of attempts) {
        const r = await call(n, d, s.token);
        expect(r.json.error).toBeDefined();
        expect(['NOT_FOUND', 'PERMISSION_DENIED', 'FAILED_PRECONDITION', 'INVALID_ARGUMENT']).toContain(r.json.error.status);
      }
    }
    expect(await prospectDoc(pid)).toEqual(before);
  });

  test('markProspectLostAdmin end to end: the owner closes the opportunity as lost', async () => {
    const c = await call('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'Perdido', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, S.A.token);
    const id = c.json.result.prospect.id;
    const r = await call('markProspectLostAdmin', { prospectId: id, reason: 'Precio' }, S.A.token);
    expect(r.json.result.status).toBe('lost');
    expect((await prospectDoc(id)).estado).toBe('perdido');
    const again = await call('markProspectLostAdmin', { prospectId: id, reason: 'Precio' }, S.A.token);
    expect(again.json.result.status).toBe('unchanged');
  });

  const newProspect = async (token, proyecto) => {
    const c = await call('createProspectAdmin', { prospect: { clientId: 'CW', proyecto, origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, token);
    expect(c.json.error).toBeUndefined();
    return c.json.result.prospect.id;
  };

  test('base price and cost: only manager/gestor, only while the opportunity is active (the stored state decides)', async () => {
    const id = await newProspect(S.A.token, 'Precio base');
    const edit = (token, precio) => call('editProspectBasePriceAdmin', { prospectId: id, precio, costo: 100, motivo: 'Corrección' }, token);
    expect((await edit(S.A.token, 500)).json.error.status).toBe('PERMISSION_DENIED'); // the owner seller cannot
    expect((await edit(S.B.token, 500)).json.error.status).toBe('PERMISSION_DENIED');
    expect((await prospectDoc(id)).precio_cotizado).not.toBe(500);
    expect((await edit(S.GES.token, 500)).json.result.status).toBe('updated');
    expect((await edit(S.MGR.token, 700)).json.result.status).toBe('updated');
    expect(await prospectDoc(id)).toMatchObject({ precio_cotizado: 700, costo_venta: 100 });
    expect((await audits('editBasePrice')).length).toBeGreaterThanOrEqual(2);
    expect((await call('markProspectLostAdmin', { prospectId: id, reason: 'Precio' }, S.A.token)).json.result.status).toBe('lost');
    const late = await edit(S.MGR.token, 900);
    expect(late.json.error.status).toBe('FAILED_PRECONDITION');
    expect((await prospectDoc(id)).precio_cotizado).toBe(700);
  });

  test('base price after the closing is refused for the manager too (no invoice/payment is ever recomputed)', async () => {
    const id = await newProspect(S.A.token, 'Precio tras cierre');
    const step = async (nextStage, data) => { const r = await call('advanceProspectStageAdmin', { prospectId: id, nextStage, data }, S.A.token); expect(r.json.error).toBeUndefined(); };
    await step('levantamiento', { visitante: 'Luis', fecha_inicio: '2026-04-01', ubicacion: 'San Salvador', distancia: 12, fecha_visita: '2026-03-20', doc_levantamiento: [file('l2.pdf')] });
    await step('cotizacion', { costo_venta: 6000, precio_cotizado: 10000, probabilidad: 'alta', doc_oferta: [file('o2.pdf')], doc_costos: [file('c2.pdf')] });
    await step('negociacion', { costo_venta: 6000, precio_cotizado: 10000, probabilidad: 'alta' });
    expect((await call('editProspectBasePriceAdmin', { prospectId: id, precio: 8000, costo: 6000, motivo: 'Negociado' }, S.GES.token)).json.result.status).toBe('updated');
    await step('cierre', { forma_pago: '70/30', factura_anticipo: 'FAC-PB', doc_firmado: file('f2.pdf'), doc_comprobante: file('p2.pdf') });
    const closed = await prospectDoc(id);
    expect(closed.estado).toBe('ganado');
    expect(closed.facturas[0].monto).toBe(6328); // 8000 x 1.13 x 70 %: the corrected price, taken at the closing
    for (const s of [S.MGR, S.GES]) {
      expect((await call('editProspectBasePriceAdmin', { prospectId: id, precio: 20000, costo: 6000, motivo: 'Tarde' }, s.token)).json.error.status).toBe('FAILED_PRECONDITION');
    }
    const after = await prospectDoc(id);
    expect(after.precio_cotizado).toBe(8000);
    expect(after.facturas[0].monto).toBe(6328);
  });

  test('no-contract authorization: request and resolution with real identities, states, audit and idempotency', async () => {
    const id = await newProspect(S.A.token, 'Sin contrato');
    const req = (token, motivo, op) => call('requestNoContractAuthorizationAdmin', { prospectId: id, motivo, opId: op || opId() }, token);
    const resolve = (token, d) => call('resolveNoContractAuthorizationAdmin', { prospectId: id, ...d }, token);
    // who may ask
    expect((await req(S.B.token, 'No es mi proyecto')).json.error.status).toBe('PERMISSION_DENIED'); // another seller
    expect((await req(S.MGR.token, 'El gerente autoriza directo')).json.error.status).toBe('PERMISSION_DENIED');
    expect((await req(S.A.token, '   ')).json.error.status).toBe('INVALID_ARGUMENT');
    const op = opId();
    const first = await req(S.A.token, 'Cliente institucional sin contrato', op);
    expect(first.json.result.status).toBe('requested');
    const rid = first.json.result.request.id;
    // a retry with the same opId and a double click never create a second request
    expect((await req(S.A.token, 'Cliente institucional sin contrato', op)).json.result.replay).toBe(true);
    expect((await req(S.A.token, 'Cliente institucional sin contrato')).json.result.status).toBe('unchanged');
    expect((await req(S.A.token, 'Otro motivo')).json.error.status).toBe('FAILED_PRECONDITION'); // already one pending
    let p = await prospectDoc(id);
    expect(p.solicitudes_sin_contrato).toHaveLength(1);
    expect(p.solicitudes_sin_contrato[0]).toMatchObject({ estado: 'pendiente', solicitante_id: CID.A, motivo: 'Cliente institucional sin contrato', resuelto_por_id: null });
    expect(p.solicitudes_sin_contrato[0].fecha_solicitud).toBeTruthy();
    expect(p.datos.autorizado_sin_contrato).toBeFalsy();
    // who may NOT resolve: the requester, another seller, a gestor, and nobody can send the authorization fields
    for (const s of [S.A, S.B, S.GES]) expect((await resolve(s.token, { requestId: rid, decision: 'approve' })).json.error.status).toBe('PERMISSION_DENIED');
    const forged = await call('requestNoContractAuthorizationAdmin', { prospectId: id, motivo: 'x', opId: opId(), autorizado_sin_contrato: true, datos: { autorizado_sin_contrato: true }, estado: 'aprobada' }, S.A.token);
    expect(forged.json.error === undefined || forged.json.error.status === 'FAILED_PRECONDITION').toBe(true);
    p = await prospectDoc(id);
    expect(p.datos.autorizado_sin_contrato).toBeFalsy();
    expect(p.solicitudes_sin_contrato.every(r => r.estado === 'pendiente')).toBe(true);
    // the manager rejects only with a reason, from his own session
    expect((await resolve(S.MGR.token, { requestId: rid, decision: 'reject' })).json.error.status).toBe('INVALID_ARGUMENT');
    expect((await resolve(S.MGR.token, { requestId: 'NOEXISTE', decision: 'approve' })).json.error.status).toBe('NOT_FOUND');
    expect((await resolve(S.MGR.token, { requestId: rid, decision: 'grant' })).json.error.status).toBe('INVALID_ARGUMENT');
    const rej = await resolve(S.MGR.token, { requestId: rid, decision: 'reject', motivoDecision: 'Falta carta de compromiso' });
    expect(rej.json.result.status).toBe('rejected');
    p = await prospectDoc(id);
    expect(p.solicitudes_sin_contrato[0]).toMatchObject({ estado: 'rechazada', resuelto_por_id: CID.MGR, motivo_decision: 'Falta carta de compromiso' });
    expect(p.solicitudes_sin_contrato[0].fecha_resolucion).toBeTruthy();
    expect(p.datos.autorizado_sin_contrato).toBeFalsy();
    expect((await resolve(S.MGR.token, { requestId: rid, decision: 'reject', motivoDecision: 'Falta carta de compromiso' })).json.result.status).toBe('unchanged');
    expect((await resolve(S.MGR.token, { requestId: rid, decision: 'approve' })).json.error.status).toBe('FAILED_PRECONDITION'); // contradictory, late
    // a new request after the rejection; two simultaneous approvals produce ONE approval
    const second = await req(S.A.token, 'Nueva carta recibida');
    const rid2 = second.json.result.request.id;
    expect(rid2).not.toBe(rid);
    const races = await Promise.all([1, 2, 3].map(() => resolve(S.MGR.token, { requestId: rid2, decision: 'approve', motivoDecision: 'Carta verificada' })));
    expect(races.every(r => r.json.result)).toBe(true);
    expect(races.filter(r => r.json.result.status === 'approved')).toHaveLength(1);
    expect(races.filter(r => r.json.result.status === 'unchanged')).toHaveLength(2);
    p = await prospectDoc(id);
    expect(p.datos).toMatchObject({ autorizado_sin_contrato: true, autorizado_por_id: CID.MGR });
    expect(p.solicitudes_sin_contrato.map(r => r.estado)).toEqual(['rechazada', 'aprobada']);
    // after the approval a new request is refused
    expect((await req(S.A.token, 'Otra más')).json.error.status).toBe('FAILED_PRECONDITION');
    // every transition has its audit record, written by the server with the session identity
    const mine = (await audits()).filter(a => a.targetId === id);
    const count = a => mine.filter(x => x.action === a).length;
    expect(count('requestNoContractAuthorization')).toBeGreaterThanOrEqual(2);
    expect(count('rejectNoContractRequest')).toBe(1);
    expect(count('approveNoContractRequest')).toBe(1);
    expect(mine.filter(x => x.action === 'approveNoContractRequest')[0].actorCid).toBe(CID.MGR);
    expect(mine.filter(x => x.action === 'requestNoContractAuthorization').every(x => x.actorCid === CID.A)).toBe(true);
  });

  test('rules: a vendedor cannot delete an opportunity directly either (the callable is the only way)', async () => {
    const c = await call('createProspectAdmin', { prospect: { clientId: 'CW', proyecto: 'Directo', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos' }, opId: opId() }, S.A.token);
    const id = c.json.result.prospect.id;
    expect((await fsApi.del('prospects_prod', id, S.A.token)).status).toBe(403);
    expect(await prospectDoc(id)).toBeDefined();
  });
});
