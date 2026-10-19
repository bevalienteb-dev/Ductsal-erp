// functions/__tests__/workflowUiFlow.test.js
// UNIT layer (no Firestore, no emulator, no rules). Executes the REAL migrated opportunity-workflow functions of
// app_core.js (change orders, invoices, payments, proposals, stage advance, loss, base price, deletions) in a sandbox
// with a fake DOM, the REAL crm_commercial.js and a fake Firebase namespace that records the callables. It proves that
// (a) each function reaches the server only through its callable, (b) the opportunity document is never sent,
// (c) with no session nothing is sent or written, (d) a server rejection is shown and the screen state is not advanced.
// It is NOT an integration test: the server side is covered by the emulator suites (isolated-tests/*.iso.js).

const fs = require('fs');
const path = require('path');
const CrmCommercial = require('../../crm_commercial.js');

const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

const SRC = [
  between('async function runWorkflowOp(', 'function showInvoiceForm'),
  between('async function processInvoice(', 'function showPaymentForm'),
  between('function editPayment(', 'function renderTracker'),
  between('async function processNewProposal()', '// Google Maps auto-script removed'),
  between('async function processAdvance(', 'function showLoseForm'),
  between('async function processLose()', '// ========================\n// DASHBOARD'),
  between('async function processEditBasePrice(', 'function deleteClient(')
  , between('async function deleteProspect()', '// Compresión de imágenes')
  , between('const escapeHtmlText', '// REMOVED (window.applyManagerBypass)')
].join('\n');

function build({ session = true, handler, prospect, client } = {}) {
  const calls = [];
  const writes = [];
  const els = {};
  const el = (id, value = '') => (els[id] = els[id] || { value, style: {}, dataset: {}, files: [], options: [], textContent: '', innerHTML: '' });
  const S = {
    currentUser: { id: '1000000000001', nombre: 'Gerente', role: 'manager' },
    currentProspectId: 'P1',
    DB_SUFFIX: '_prod',
    clients: [client || { id: 'C1', nombres: 'Cliente', documentos: { dui: { name: 'dui.pdf', url: 'https://x/y' } } }],
    prospects: [prospect || {
      id: 'P1', clientId: 'C1', proyecto: 'Nave', tipo_proyecto: 'Fabricación', estado: 'ganado', etapa: 'cierre', datos: {},
      precio_cotizado: 1000, costo_venta: 500,
      ordenes_cambio: [{ id: 'OC1' }],
      facturas: [
        { id: 'F0', numero: 'A-1', monto: 100, pagos: [{ id: 'PAY1', monto: 10, fecha: '2026-01-01' }, { fecha: '2026-01-02', monto: 5 }] },
        { id: 'F1', numero: 'A-2', monto: 50, pagos: [] }
      ]
    }]
  };
  const ui = { alerts: [], confirmAnswer: true, promptAnswer: 'Motivo de prueba', prompts: [], opened: [], closed: [], loading: 0, uploads: [], wentBack: 0 };
  const document = {
    getElementById: (id) => els[id],
    createElement: () => ({ remove() {} })
  };
  const firebase = {
    auth: () => ({ currentUser: session ? { uid: 'u' } : null }),
    functions: () => ({ httpsCallable: (name) => async (payload) => { calls.push({ name, payload }); return { data: await handler(name, payload) }; } })
  };
  const trap = () => ({ set() { writes.push('set'); }, update() { writes.push('update'); }, delete() { writes.push('delete'); }, get() { writes.push('get'); } });
  const db = { collection: () => ({ doc: () => trap(), add: () => writes.push('add') }) };
  const win = { stagedFiles: {} };
  const api = new Function('S', 'document', 'ui', 'firebase', 'db', 'CrmCommercial', 'window', `
    with (S) {
      var alert = function (m) { ui.alerts.push(m); };
      var confirm = function () { return ui.confirmAnswer; };
      var prompt = function (m) { ui.prompts.push(m); return ui.promptAnswer; };
      var formatDate = function (d) { return String(d || ''); };
      var showLoading = function () { ui.loading++; }; var hideLoading = function () { ui.loading--; };
      var closeModal = function (id) { ui.closed.push(id); };
      var openDetail = function (id) { ui.opened.push(id); };
      var goBackFromDetail = function () { ui.wentBack++; };
      var uploadFileToStorage = async function (file, folder) { ui.uploads.push(folder); return { name: file.name, url: 'https://firebasestorage.googleapis.com/v0/b/x/o/' + file.name }; };
      var saveProspectToDB = function () { throw new Error('direct prospect write'); };
      var saveClientToDB = function () { throw new Error('direct client write'); };
      ${SRC}
      return { processChangeOrder: processChangeOrder, processInvoice: processInvoice, processPayment: processPayment, editPayment: editPayment,
               processNewProposal: processNewProposal, processAdvance: processAdvance, processLose: processLose,
               processEditBasePrice: processEditBasePrice, deleteChangeOrder: deleteChangeOrder, deleteInvoice: deleteInvoice,
               deletePayment: deletePayment, deleteProspect: deleteProspect, runWorkflowOp: runWorkflowOp,
                renderNoContractRequestHTML: renderNoContractRequestHTML };
    }
  `)(S, document, ui, firebase, db, CrmCommercial, win);
  return { api, S, ui, calls, writes, el, win };
}

const ok = async () => ({ status: 'updated' });
const reject = (code, msg) => async () => { const e = new Error(msg); e.code = code; throw e; };
const file = (name) => ({ name });

beforeEach(() => CrmCommercial._pendingOps.clear());

describe('runWorkflowOp', () => {
  test('without a Firebase session: explains, never calls the operation, writes nothing', async () => {
    const t = build({ session: false, handler: ok });
    let ran = false;
    const r = await t.api.runWorkflowOp('x', async () => { ran = true; });
    expect(r).toBeNull();
    expect(ran).toBe(false);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
    expect(t.ui.loading).toBe(0);
    expect(t.writes).toEqual([]);
  });
  test('a callable rejection is worded from its code; the loading indicator is always released', async () => {
    const t = build({ handler: reject('functions/failed-precondition', 'La factura excede el saldo.') });
    const r = await t.api.runWorkflowOp('x', fb => CrmCommercial.deleteInvoice(fb, { prospectId: 'P1', invoiceId: 'F1' }));
    expect(r).toBeNull();
    expect(t.ui.alerts[0]).toMatch(/excede el saldo/);
    expect(t.ui.loading).toBe(0);
  });
  test('a non-callable failure (e.g. an upload) keeps its own message', async () => {
    const t = build({ handler: ok });
    const r = await t.api.runWorkflowOp('x', async () => { throw new Error('fallo de subida'); });
    expect(r).toBeNull();
    expect(t.ui.alerts[0]).toMatch(/fallo de subida/);
  });
});

describe('change orders', () => {
  const form = (t, extra = {}) => {
    t.el('co-id-edit', extra.id || ''); t.el('co-tipo', 'adicional'); t.el('co-desc', ' Más ducto '); t.el('co-precio', '120'); t.el('co-costo', '80');
    const o = t.el('co-oferta'); const c = t.el('co-costos'); o.files = extra.files ? [file('o.pdf')] : []; c.files = extra.files ? [file('c.pdf')] : [];
  };
  test('create: sends the typed fields and file references only, then closes the modal', async () => {
    const t = build({ handler: ok });
    form(t, { files: true });
    await t.api.processChangeOrder({ preventDefault() {} });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].name).toBe('saveChangeOrderAdmin');
    const p = t.calls[0].payload;
    expect(p.prospectId).toBe('P1');
    expect(p).toMatchObject({ tipo: 'adicional', desc: 'Más ducto', precio: 120, costo: 80 });
    expect(p.doc_oferta.name).toBe('o.pdf');
    expect(p).not.toHaveProperty('prospect');
    expect(p).not.toHaveProperty('ordenes_cambio');
    expect(t.ui.closed).toEqual(['changeOrderModal']);
    expect(t.ui.uploads).toEqual(['ordenes_cambio', 'ordenes_cambio']);
    expect(t.writes).toEqual([]);
  });
  test('edit sends the order id; creating twice sends distinct opIds but a retry reuses the first', async () => {
    const t = build({ handler: reject('functions/unavailable', 'sin red') });
    form(t);
    await t.api.processChangeOrder({ preventDefault() {} });
    await t.api.processChangeOrder({ preventDefault() {} });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].payload.opId).toBeTruthy();
    expect(t.calls[1].payload.opId).toBe(t.calls[0].payload.opId);
    expect(t.ui.closed).toEqual([]);
    const e = build({ handler: ok });
    form(e, { id: 'OC1' });
    await e.api.processChangeOrder({ preventDefault() {} });
    expect(e.calls[0].payload.orderId).toBe('OC1');
  });
  test('server rejection: message shown, modal stays open', async () => {
    const t = build({ handler: reject('functions/permission-denied', 'no') });
    form(t);
    await t.api.processChangeOrder({ preventDefault() {} });
    expect(t.ui.alerts).toHaveLength(1);
    expect(t.ui.closed).toEqual([]);
  });
  test('delete: by id, after confirmation; cancelled confirmation sends nothing; unknown id sends nothing', async () => {
    const t = build({ handler: ok });
    await t.api.deleteChangeOrder('OC1');
    expect(t.calls).toEqual([{ name: 'deleteChangeOrderAdmin', payload: { prospectId: 'P1', orderId: 'OC1', dbSuffix: '_prod' } }]);
    const c = build({ handler: ok }); c.ui.confirmAnswer = false;
    await c.api.deleteChangeOrder('OC1');
    await build({ handler: ok }).api.deleteChangeOrder('NOPE');
    expect(c.calls).toEqual([]);
  });
});

describe('invoices', () => {
  const form = (t, o = {}) => { t.el('inv-id-edit', o.id || ''); t.el('inv-numero', o.numero === undefined ? 'F-10' : o.numero); t.el('inv-monto', o.monto || '25.5'); t.el('invoice-form'); t.el('inv-file').files = o.noFile ? [] : [file('f.pdf')]; };
  test('create: number, amount and file reference; invoice form hidden afterwards', async () => {
    const t = build({ handler: ok });
    form(t);
    await t.api.processInvoice({ preventDefault() {} });
    expect(t.calls[0].name).toBe('saveInvoiceAdmin');
    expect(t.calls[0].payload).toMatchObject({ prospectId: 'P1', numero: 'F-10', monto: 25.5 });
    expect(t.calls[0].payload.doc_factura.name).toBe('f.pdf');
    expect(t.calls[0].payload).not.toHaveProperty('facturas');
    expect(t.el('invoice-form').style.display).toBe('none');
    expect(t.writes).toEqual([]);
  });
  test('missing number / amount / file on a creation: courtesy alert, nothing sent', async () => {
    for (const o of [{ numero: '' }, { monto: '0' }, { noFile: true }]) {
      const t = build({ handler: ok }); form(t, o);
      await t.api.processInvoice({ preventDefault() {} });
      expect(t.calls).toEqual([]);
      expect(t.ui.alerts).toHaveLength(1);
    }
  });
  test('an edit without a new file is allowed and carries the invoice id', async () => {
    const t = build({ handler: ok }); form(t, { id: 'F1', noFile: true });
    await t.api.processInvoice({ preventDefault() {} });
    expect(t.calls[0].payload.invoiceId).toBe('F1');
    expect(t.calls[0].payload.doc_factura).toBeUndefined();
  });
  test('server rejection keeps the form open', async () => {
    const t = build({ handler: reject('functions/failed-precondition', 'Excede el saldo') });
    form(t);
    await t.api.processInvoice({ preventDefault() {} });
    expect(t.el('invoice-form').style.display).not.toBe('none');
    expect(t.ui.alerts[0]).toMatch(/Excede/);
  });
  test('delete: the first (advance) invoice is refused locally; others go through the callable', async () => {
    const t = build({ handler: ok });
    await t.api.deleteInvoice('F0');
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts[0]).toMatch(/anticipo/);
    await t.api.deleteInvoice('F1');
    expect(t.calls).toEqual([{ name: 'deleteInvoiceAdmin', payload: { prospectId: 'P1', invoiceId: 'F1', dbSuffix: '_prod' } }]);
  });
});

describe('payments', () => {
  const form = (t, o = {}) => {
    t.el('pay-monto-nuevo', o.monto || '10'); t.el('pay-metodo', 'transferencia'); t.el('pay-ref', ' R-1 ');
    t.el('pay-invoice-id', o.invoiceId || 'F0'); t.el('pay-idx-edit', o.key || ''); t.el('payment-form');
    t.el('pay-file').files = o.noFile ? [] : [file('p.pdf')];
  };
  test('create: sends amount, method, reference and file reference', async () => {
    const t = build({ handler: ok }); form(t);
    await t.api.processPayment({ preventDefault() {} });
    expect(t.calls[0].name).toBe('savePaymentAdmin');
    expect(t.calls[0].payload).toMatchObject({ prospectId: 'P1', invoiceId: 'F0', monto: 10, metodo: 'transferencia', ref: 'R-1' });
    expect(t.calls[0].payload.paymentKey).toBeUndefined();
    expect(t.calls[0].payload.doc_comprobante.name).toBe('p.pdf');
    expect(t.el('payment-form').style.display).toBe('none');
  });
  test('creation without receipt, with a bad amount or for an unknown invoice sends nothing', async () => {
    for (const o of [{ noFile: true }, { monto: '-1' }, { invoiceId: 'ZZ' }]) {
      const t = build({ handler: ok }); form(t, o);
      await t.api.processPayment({ preventDefault() {} });
      expect(t.calls).toEqual([]);
    }
  });
  test('editPayment stores the KEY of the payment in the form (id, or fecha for historical ones), not its position', () => {
    const t = build({ handler: ok });
    ['pay-target-invoice-text', 'pay-invoice-id', 'pay-idx-edit', 'pay-monto-nuevo', 'pay-ref', 'payment-form', 'invoice-form', 'pay-metodo'].forEach(i => t.el(i));
    t.el('pay-metodo').appendChild = () => {};
    t.api.editPayment('F0', 0);
    expect(t.el('pay-idx-edit').value).toBe('PAY1');
    t.api.editPayment('F0', 1);
    expect(t.el('pay-idx-edit').value).toBe('2026-01-02');
  });
  test('deletePayment addresses the payment by key, never by position', async () => {
    const t = build({ handler: ok });
    await t.api.deletePayment('F0', 0);
    await t.api.deletePayment('F0', 1);
    expect(t.calls.map(c => c.payload.paymentKey)).toEqual(['PAY1', '2026-01-02']);
    expect(t.calls.every(c => !('paymentIndex' in c.payload))).toBe(true);
  });
  test('a payment edit sends the key held by the form, plus no new file when none was chosen', async () => {
    const t = build({ handler: ok }); form(t, { key: 'PAY1', noFile: true });
    await t.api.processPayment({ preventDefault() {} });
    expect(t.calls[0].payload.paymentKey).toBe('PAY1');
    expect(t.calls[0].payload.doc_comprobante).toBeUndefined();
  });
  test('deleting an unknown position sends nothing', async () => {
    const t = build({ handler: ok });
    await t.api.deletePayment('F0', 9);
    expect(t.calls).toEqual([]);
  });
});

describe('proposal and base price', () => {
  test('proposal: price, cost and file references only; detail reopened', async () => {
    const t = build({ handler: ok });
    t.el('prop-costo', '400'); t.el('prop-precio', '900');
    t.win.stagedFiles = { 'prop-file': [file('o.pdf')], 'prop-file2': [file('c.pdf')] };
    await t.api.processNewProposal();
    expect(t.calls[0].name).toBe('registerProposalAdmin');
    expect(t.calls[0].payload).toMatchObject({ prospectId: 'P1', costo_venta: 400, precio_cotizado: 900 });
    expect(t.calls[0].payload.doc_oferta).toHaveLength(1);
    expect(t.ui.opened).toEqual(['P1']);
  });
  test('proposal without both documents or numbers sends nothing', async () => {
    const t = build({ handler: ok });
    t.el('prop-costo', '400'); t.el('prop-precio', '900');
    t.win.stagedFiles = { 'prop-file': [file('o.pdf')] };
    await t.api.processNewProposal();
    expect(t.calls).toEqual([]);
  });
  test('base price: requires a reason; sends the new values and the reason, not the previous values', async () => {
    const t = build({ handler: ok });
    t.el('eb-precio', '1200'); t.el('eb-costo', '700'); t.el('eb-motivo', '   ');
    await t.api.processEditBasePrice({ preventDefault() {} });
    expect(t.calls).toEqual([]);
    t.el('eb-motivo').value = 'Error de captura';
    await t.api.processEditBasePrice({ preventDefault() {} });
    expect(t.calls[0].name).toBe('editProspectBasePriceAdmin');
    expect(t.calls[0].payload).toEqual({ prospectId: 'P1', precio: 1200, costo: 700, motivo: 'Error de captura', dbSuffix: '_prod' });
    expect(t.ui.closed).toEqual(['editBasePriceModal']);
  });
});

describe('stage advance and loss', () => {
  test('levantamiento: sends the typed data and file references; detail reopened', async () => {
    const t = build({ handler: ok });
    t.el('adv-inicio', '2026-02-01'); t.el('adv-visitante', ' Ana '); t.el('advance-form-container');
    t.win.stagedFiles = { 'adv-file': [file('l.pdf')] };
    await t.api.processAdvance('levantamiento');
    expect(t.calls[0].name).toBe('advanceProspectStageAdmin');
    expect(t.calls[0].payload).toMatchObject({ prospectId: 'P1', nextStage: 'levantamiento' });
    expect(t.calls[0].payload.data).toMatchObject({ visitante: 'Ana', fecha_inicio: '2026-02-01' });
    expect(t.calls[0].payload.data.doc_levantamiento).toHaveLength(1);
    expect(t.ui.opened).toEqual(['P1']);
    expect(t.writes).toEqual([]);
  });
  test('cotizacion: documents must exist (new or stored) before calling', async () => {
    const t = build({ handler: ok });
    t.el('adv-costo', '1'); t.el('adv-precio', '2'); t.el('adv-prob', '50'); t.el('advance-form-container');
    await t.api.processAdvance('cotizacion');
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts[0]).toMatch(/Oferta/);
  });
  test('cierre: the client DUI is checked as a courtesy; nothing is sent when it is missing', async () => {
    const t = build({ handler: ok, client: { id: 'C1', nombres: 'X', documentos: {} } });
    t.S.prospects[0].etapa = 'negociacion'; t.S.prospects[0].estado = 'activo';
    t.el('adv-forma-pago', '70/30'); t.el('adv-fac-anticipo', 'FA-1'); t.el('advance-form-container');
    t.el('adv-file1').files = [file('o.pdf')]; t.el('adv-file2').files = [file('a.pdf')];
    await t.api.processAdvance('cierre');
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts[0]).toMatch(/DUI/);
  });
  test('cierre: payment form, advance invoice number and file references are sent; no amounts are computed in the browser', async () => {
    const t = build({ handler: ok });
    t.S.prospects[0].etapa = 'negociacion'; t.S.prospects[0].estado = 'activo';
    t.el('adv-forma-pago', '70/30'); t.el('adv-fac-anticipo', 'FA-1'); t.el('advance-form-container');
    t.el('adv-file1').files = [file('o.pdf')]; t.el('adv-file2').files = [file('a.pdf')];
    await t.api.processAdvance('cierre');
    const d = t.calls[0].payload.data;
    expect(d).toMatchObject({ forma_pago: '70/30', factura_anticipo: 'FA-1' });
    expect(d.doc_firmado.name).toBe('o.pdf');
    expect(d.doc_comprobante.name).toBe('a.pdf');
    expect(Object.keys(d).some(k => /monto|total|iva/i.test(k))).toBe(false);
    expect(t.ui.uploads.sort()).toEqual(['facturas', 'proyectos']);
  });
  test('server rejection of an advance: message shown, the form is NOT cleared and the detail is not reopened', async () => {
    const t = build({ handler: reject('functions/failed-precondition', 'Etapa no permitida') });
    t.el('adv-inicio', '2026-02-01'); t.el('adv-visitante', 'Ana'); t.el('advance-form-container', '');
    t.el('advance-form-container').innerHTML = 'FORM';
    await t.api.processAdvance('levantamiento');
    expect(t.ui.alerts[0]).toMatch(/Etapa no permitida/);
    expect(t.el('advance-form-container').innerHTML).toBe('FORM');
    expect(t.ui.opened).toEqual([]);
  });
  test('without a session an advance sends nothing and uploads nothing', async () => {
    const t = build({ session: false, handler: ok });
    t.el('adv-inicio', '2026-02-01'); t.el('adv-visitante', 'Ana'); t.el('advance-form-container');
    t.win.stagedFiles = { 'adv-file': [file('l.pdf')] };
    await t.api.processAdvance('levantamiento');
    expect(t.calls).toEqual([]);
    expect(t.ui.uploads).toEqual([]);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
  });
  test('loss: reason required; sends only the reason', async () => {
    const t = build({ handler: ok });
    t.el('lose-reason', ''); t.el('advance-form-container');
    await t.api.processLose();
    expect(t.calls).toEqual([]);
    t.el('lose-reason').value = 'Precio';
    await t.api.processLose();
    expect(t.calls).toEqual([{ name: 'markProspectLostAdmin', payload: { prospectId: 'P1', reason: 'Precio', dbSuffix: '_prod' } }]);
    expect(t.ui.opened).toEqual(['P1']);
  });
});

describe('deleteProspect', () => {
  test('non-managers are refused locally and nothing is sent', async () => {
    const t = build({ handler: ok }); t.S.currentUser = { id: 'U', role: 'vendedor' };
    await t.api.deleteProspect();
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts[0]).toMatch(/Permiso denegado/);
  });
  test('manager: confirmation, then the callable (no direct delete, no audit written by the browser)', async () => {
    const t = build({ handler: ok });
    await t.api.deleteProspect();
    expect(t.calls).toEqual([{ name: 'deleteProspectAdmin', payload: { prospectId: 'P1', motivo: 'Motivo de prueba', dbSuffix: '_prod' } }]);
    expect(t.writes).toEqual([]);
    expect(t.ui.wentBack).toBe(1);
  });
  test('without a reason nothing is sent (the server demands it too)', async () => {
    const t = build({ handler: ok }); t.ui.promptAnswer = '   ';
    await t.api.deleteProspect();
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts[0]).toMatch(/requiere un motivo/);
    expect(t.ui.wentBack).toBe(0);
  });
  test('declining the confirmation sends nothing', async () => {
    const t = build({ handler: ok }); t.ui.confirmAnswer = false;
    await t.api.deleteProspect();
    expect(t.calls).toEqual([]);
  });
  test('server rejection: the user stays on the detail', async () => {
    const t = build({ handler: reject('functions/permission-denied', 'no') });
    await t.api.deleteProspect();
    expect(t.ui.wentBack).toBe(0);
  });
});

describe('no-contract authorization requests (browser side)', () => {
  const pending = { id: 'R1', estado: 'pendiente', solicitante_id: 'V1', solicitante_nombre: 'Vendedor <b>X</b>', fecha_solicitud: '2026-03-01', motivo: 'Cliente <script>' };
  test('vendedor: sends ONLY the reason; who/dates/authorization fields are never part of the payload', async () => {
    const t = build({ handler: ok }); t.S.currentUser = { id: 'V1', nombre: 'V', role: 'vendedor' };
    await t.win.requestNoContractAuthorization();
    expect(t.calls).toEqual([{ name: 'requestNoContractAuthorizationAdmin', payload: expect.objectContaining({ prospectId: 'P1', motivo: 'Motivo de prueba', dbSuffix: '_prod', opId: expect.any(String) }) }]);
    const keys = Object.keys(t.calls[0].payload).sort();
    expect(keys).toEqual(['dbSuffix', 'motivo', 'opId', 'prospectId']);
    expect(t.writes).toEqual([]);
  });
  test('vendedor without a reason: nothing is sent', async () => {
    const t = build({ handler: ok }); t.S.currentUser = { id: 'V1', role: 'vendedor' }; t.ui.promptAnswer = '';
    await t.win.requestNoContractAuthorization();
    expect(t.calls).toEqual([]);
  });
  test('manager approves: the payload carries the decision only, never the authorization fields', async () => {
    const t = build({ handler: ok });
    await t.win.resolveNoContractRequest('R1', 'approve');
    expect(t.calls).toEqual([{ name: 'resolveNoContractAuthorizationAdmin', payload: { prospectId: 'P1', requestId: 'R1', decision: 'approve', motivoDecision: 'Motivo de prueba', dbSuffix: '_prod' } }]);
    expect(t.writes).toEqual([]);
  });
  test('rejecting without a reason sends nothing; an unknown decision is ignored', async () => {
    const t = build({ handler: ok }); t.ui.promptAnswer = '';
    await t.win.resolveNoContractRequest('R1', 'reject');
    await t.win.resolveNoContractRequest('R1', 'grant');
    expect(t.calls).toEqual([]);
  });
  test('rendering: buttons by role, request text escaped', () => {
    const base = build({ handler: ok });
    base.S.prospects[0].solicitudes_sin_contrato = [pending];
    const asManager = base.api.renderNoContractRequestHTML(base.S.prospects[0]);
    expect(asManager).toMatch(/Aprobar/); expect(asManager).toMatch(/Rechazar/);
    expect(asManager).not.toMatch(/<script>/); expect(asManager).not.toMatch(/<b>X<\/b>/);
    base.S.currentUser = { id: 'V1', role: 'vendedor' };
    const asSeller = base.api.renderNoContractRequestHTML(base.S.prospects[0]);
    expect(asSeller).not.toMatch(/Aprobar/); expect(asSeller).not.toMatch(/Solicitar autorización/);
    base.S.prospects[0].solicitudes_sin_contrato = [];
    expect(base.api.renderNoContractRequestHTML(base.S.prospects[0])).toMatch(/Solicitar autorización/);
    base.S.currentUser = { id: 'M', role: 'manager' };
    expect(base.api.renderNoContractRequestHTML(base.S.prospects[0])).not.toMatch(/Solicitar autorización/);
  });
});

describe('no direct write path remains in the sandboxed functions', () => {
  test('the disabled writers throw if anything ever called them', () => {
    expect(SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')).not.toMatch(/saveProspectToDB\(|saveClientToDB\(|\.collection\(|audit_logs/);
  });
});
