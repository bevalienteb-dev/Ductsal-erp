// functions/__tests__/commercialUiFlow.test.js
// UNIT layer (no Firestore, no emulator, no rules). Executes the REAL migrated functions of app_core.js
// (createNewProspect, addLog, deleteLog, applyNoContractAuthorization + the two toggles, deleteClient,
// addSetting / removeSetting / saveMapsSettings) in a sandbox with a fake DOM, the REAL crm_commercial.js and a
// fake Firebase namespace that records the callables. This catches wiring mistakes the static guards cannot
// (e.g. a free variable that does not exist in the page) and proves there is no write besides the callables.

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
  between('// Settings are manager-only and decided by the server', 'function renderSettingsLists'),
  between('async function addSetting', 'function showView'),
  between('// The opportunity is created by createProspectAdmin', '// DETAIL VIEW & ADVANCEMENT'),
  between('// Manager-only decision resolved by setNoContractAuthorizationAdmin', 'window.applyManagerBypass'),
  between('function deleteLog(', 'function showNewProposalForm'),
  between('function deleteClient(', 'async function deleteProspect()')
].join('\n');

function build({ session = true, handler } = {}) {
  const calls = [];
  const writes = []; // anything that would touch Firestore directly
  const els = {};
  const el = (id, value = '') => (els[id] = els[id] || { value, textContent: '', disabled: false, reset() { this.resetCalled = true; } });
  const S = {
    currentUser: { id: '1000000000001', nombre: 'Gerente', role: 'manager' },
    currentProspectId: 'P1',
    DB_SUFFIX: '_prod',
    settings: { visitantes: ['Ana'], encargados: [] },
    users: [], clients: [{ id: 'C1', nombres: 'Cliente', empresa: '' }, { id: 'C2', nombres: 'Sin proyectos', empresa: '' }],
    prospects: [{ id: 'P1', clientId: 'C1', logs: [{ text: '(Ana) hola', date: '2026-01-01T00:00:00.000Z', auto: false }], datos: {} }]
  };
  const ui = { alerts: [], confirmAnswer: true, opened: [], advance: 0, closed: [], renderLogs: 0, renderList: 0, renderSettings: 0, loading: 0 };
  const document = { getElementById: (id) => els[id] };
  const firebase = {
    auth: () => ({ currentUser: session ? { uid: 'u' } : null }),
    functions: () => ({ httpsCallable: (name) => async (payload) => { calls.push({ name, payload }); return { data: await handler(name, payload) }; } })
  };
  const trap = () => { writes.push('direct write'); return { set() { writes.push('set'); }, delete() { writes.push('delete'); }, add() { writes.push('add'); } }; };
  const db = { collection: () => ({ doc: () => trap(), add: () => writes.push('add') }) };
  const api = new Function('S', 'document', 'ui', 'firebase', 'db', 'CrmCommercial', 'window', `
    with (S) {
      var alert = function (m) { ui.alerts.push(m); };
      var confirm = function () { return ui.confirmAnswer; };
      var showLoading = function () { ui.loading++; }; var hideLoading = function () { ui.loading--; };
      var closeModal = function (id) { ui.closed.push(id); };
      var renderList = function () { ui.renderList++; };
      var renderLogs = function () { ui.renderLogs++; };
      var openDetail = function (id) { ui.opened.push(id); };
      var showAdvanceForm = function () { ui.advance++; };
      var getClientName = function () { return 'x'; };
      var saveProspectToDB = function () { throw new Error('direct prospect write'); };
      var saveClientToDB = function () { throw new Error('direct client write'); };
      ${SRC}
      return { createNewProspect: createNewProspect, addLog: addLog, deleteLog: deleteLog, deleteClient: deleteClient,
               toggleManagerApproval: window.toggleManagerApproval, toggleManagerApprovalInForm: window.toggleManagerApprovalInForm,
               addSetting: addSetting, removeSetting: removeSetting, saveMapsSettings: saveMapsSettings };
    }
  `)(S, document, ui, firebase, db, CrmCommercial, {});
  // renderSettingsLists is inside the slice boundary: provide it through S so the sandbox can call it.
  S.renderSettingsLists = () => { ui.renderSettings++; };
  return { api, S, ui, calls, writes, el };
}

beforeEach(() => CrmCommercial._pendingOps.clear());

describe('createNewProspect (real function)', () => {
  const form = (el, extra = {}) => {
    el('new-cliente-select', 'C1'); el('new-proyecto', 'Nave'); el('new-origen', 'Referido');
    el('new-tipo-proyecto', 'Industrial'); el('new-tipo-producto', 'Ducto');
    el('new-vendedor-select', extra.vendor || ''); el('newProspectModal'); el('newProspectForm');
  };
  test('sends only what the user typed; identity fields are not sent; result is shown', async () => {
    const t = build({ handler: async (n, p) => ({ status: 'created', prospect: { id: 'P9', codigo: '202610001', clientId: p.prospect.clientId } }) });
    form(t.el);
    await t.api.createNewProspect({ preventDefault() {} });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].name).toBe('createProspectAdmin');
    expect(Object.keys(t.calls[0].payload.prospect).sort()).toEqual(['clientId', 'origen', 'proyecto', 'tipo_producto', 'tipo_proyecto']);
    expect(t.S.prospects.some(p => p.id === 'P9')).toBe(true);
    expect(t.ui.closed).toEqual(['newProspectModal']);
    expect(t.writes).toEqual([]);
    expect(t.ui.loading).toBe(0);
  });
  test('manager can pass an assignee hint; a vendedor cannot even send it', async () => {
    const m = build({ handler: async () => ({ status: 'created', prospect: { id: 'P9' } }) });
    form(m.el, { vendor: 'U2' });
    await m.api.createNewProspect({ preventDefault() {} });
    expect(m.calls[0].payload.prospect.vendedorId).toBe('U2');

    const v = build({ handler: async () => ({ status: 'created', prospect: { id: 'P9' } }) });
    v.S.currentUser = { id: 'U7', nombre: 'Vend', role: 'vendedor' };
    form(v.el, { vendor: 'U2' });
    await v.api.createNewProspect({ preventDefault() {} });
    expect(v.calls[0].payload.prospect).not.toHaveProperty('vendedorId');
  });
  test('without a Firebase session: explained, nothing sent, nothing written (no fallback)', async () => {
    const t = build({ session: false, handler: async () => { throw new Error('must not be called'); } });
    form(t.el);
    await t.api.createNewProspect({ preventDefault() {} });
    expect(t.calls).toEqual([]);
    expect(t.writes).toEqual([]);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
    expect(t.ui.closed).toEqual([]);
  });
  test('server rejection: message shown, modal stays open, nothing written', async () => {
    const t = build({ handler: async () => { const e = new Error('Cliente inexistente'); e.code = 'functions/not-found'; throw e; } });
    form(t.el);
    await t.api.createNewProspect({ preventDefault() {} });
    expect(t.ui.alerts[0]).toMatch(/Cliente inexistente/);
    expect(t.ui.closed).toEqual([]);
    expect(t.writes).toEqual([]);
    expect(t.ui.loading).toBe(0);
  });
  test('retry after a network failure reuses the opId (the second click cannot create a duplicate)', async () => {
    let n = 0;
    const t = build({ handler: async () => { if (++n === 1) { const e = new Error('net'); e.code = 'functions/unavailable'; throw e; } return { status: 'created', prospect: { id: 'P9' } }; } });
    form(t.el);
    await t.api.createNewProspect({ preventDefault() {} });
    await t.api.createNewProspect({ preventDefault() {} });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].payload.opId).toBe(t.calls[1].payload.opId);
    expect(t.S.prospects.filter(p => p.id === 'P9')).toHaveLength(1);
  });
  test('no client selected: nothing is called', async () => {
    const t = build({ handler: async () => ({}) });
    form(t.el); t.el('new-cliente-select').value = '';
    await t.api.createNewProspect({ preventDefault() {} });
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts).toEqual(['Debes seleccionar un cliente']);
  });
});

describe('addLog / deleteLog (real functions)', () => {
  test('addLog sends text + prospect id only and shows the server entry; the author is never composed in the browser', async () => {
    const entry = { text: '(Gerente) llamé', date: '2026-10-16T00:00:00.000Z', auto: false, by: '1000000000001' };
    const t = build({ handler: async () => ({ status: 'added', entry }) });
    const box = t.el('new-log-text', '  llamé  '); const btn = {}; box.nextElementSibling = btn;
    t.addLogCalls = 0;
    t.api.addLog();
    await new Promise(r => setImmediate(r));
    expect(t.calls[0].name).toBe('addProspectLogAdmin');
    expect(Object.keys(t.calls[0].payload).sort()).toEqual(['dbSuffix', 'opId', 'prospectId', 'text']);
    expect(t.calls[0].payload.text).toBe('llamé');
    expect(t.S.prospects[0].logs).toContainEqual(entry);
    expect(box.value).toBe('');
    expect(btn.disabled).toBe(false);
    expect(t.writes).toEqual([]);
  });
  test('addLog without session: nothing sent, button untouched, user told', async () => {
    const t = build({ session: false, handler: async () => ({}) });
    const box = t.el('new-log-text', 'x'); box.nextElementSibling = {};
    t.api.addLog();
    await new Promise(r => setImmediate(r));
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
    expect(t.S.prospects[0].logs).toHaveLength(1);
  });
  test('addLog server denial: message shown, local history unchanged, button re-enabled', async () => {
    const t = build({ handler: async () => { const e = new Error('Sin acceso'); e.code = 'functions/permission-denied'; throw e; } });
    const box = t.el('new-log-text', 'x'); const btn = {}; box.nextElementSibling = btn;
    t.api.addLog();
    await new Promise(r => setImmediate(r));
    expect(t.ui.alerts[0]).toMatch(/Sin acceso/);
    expect(t.S.prospects[0].logs).toHaveLength(1);
    expect(btn.disabled).toBe(false);
  });
  test('deleteLog identifies the note by date + text and removes it locally only after the server confirms', async () => {
    const t = build({ handler: async () => ({ status: 'deleted' }) });
    t.api.deleteLog('P1', 0);
    await new Promise(r => setImmediate(r));
    expect(t.calls[0].name).toBe('deleteProspectLogAdmin');
    expect(t.calls[0].payload).toMatchObject({ prospectId: 'P1', date: '2026-01-01T00:00:00.000Z', text: '(Ana) hola' });
    expect(t.S.prospects[0].logs).toEqual([]);
    expect(t.writes).toEqual([]);
  });
  test('deleteLog denied by the server keeps the note', async () => {
    const t = build({ handler: async () => { const e = new Error('Solo puedes eliminar las notas que tú escribiste'); e.code = 'functions/permission-denied'; throw e; } });
    t.api.deleteLog('P1', 0);
    await new Promise(r => setImmediate(r));
    expect(t.S.prospects[0].logs).toHaveLength(1);
    expect(t.ui.alerts[0]).toMatch(/escribiste/);
  });
  test('deleteLog "absent" (already removed, e.g. a retry) is treated as done', async () => {
    const t = build({ handler: async () => ({ status: 'absent' }) });
    t.api.deleteLog('P1', 0);
    await new Promise(r => setImmediate(r));
    expect(t.S.prospects[0].logs).toEqual([]);
  });
  test('deleteLog cancelled in the confirm dialog: no call', async () => {
    const t = build({ handler: async () => ({}) });
    t.ui.confirmAnswer = false;
    t.api.deleteLog('P1', 0);
    expect(t.calls).toEqual([]);
  });
  test('deleteLog without session: no call, no write', async () => {
    const t = build({ session: false, handler: async () => ({}) });
    t.api.deleteLog('P1', 0);
    expect(t.calls).toEqual([]);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
  });
});

describe('no-contract authorization toggles (real functions)', () => {
  test('grant: name comes from the server answer, not from currentUser; no direct write', async () => {
    const t = build({ handler: async () => ({ status: 'updated', authorized: true, autorizado_por: 'Nombre del servidor' }) });
    t.S.currentUser = { id: '1', nombre: 'NOMBRE-DEL-NAVEGADOR', role: 'manager' };
    await t.api.toggleManagerApproval(true);
    expect(t.calls[0]).toMatchObject({ name: 'setNoContractAuthorizationAdmin', payload: { prospectId: 'P1', authorized: true } });
    expect(t.S.prospects[0].datos.autorizado_por).toBe('Nombre del servidor');
    expect(t.S.prospects[0].datos.autorizado_sin_contrato).toBe(true);
    expect(t.ui.opened).toEqual(['P1']);
    expect(t.writes).toEqual([]);
  });
  test('revoke clears the local flag and name', async () => {
    const t = build({ handler: async () => ({ status: 'updated', authorized: false, autorizado_por: null }) });
    t.S.prospects[0].datos = { autorizado_sin_contrato: true, autorizado_por: 'X' };
    await t.api.toggleManagerApprovalInForm(false);
    expect(t.S.prospects[0].datos.autorizado_sin_contrato).toBe(false);
    expect(t.S.prospects[0].datos).not.toHaveProperty('autorizado_por');
    expect(t.ui.advance).toBe(1);
  });
  test('a non-manager (server denial) leaves the local state untouched and re-renders the real one', async () => {
    const t = build({ handler: async () => { const e = new Error('Solo un gerente'); e.code = 'functions/permission-denied'; throw e; } });
    t.S.currentUser = { id: 'U7', nombre: 'Vend', role: 'vendedor' };
    await t.api.toggleManagerApproval(true);
    expect(t.S.prospects[0].datos).toEqual({});
    expect(t.ui.alerts[0]).toMatch(/Solo un gerente/);
    expect(t.ui.opened).toEqual(['P1']); // checkbox state is re-rendered from the real data
    expect(t.writes).toEqual([]);
  });
  test('without session: nothing sent', async () => {
    const t = build({ session: false, handler: async () => ({}) });
    await t.api.toggleManagerApproval(true);
    expect(t.calls).toEqual([]);
    expect(t.S.prospects[0].datos).toEqual({});
  });
});

describe('deleteClient (real function)', () => {
  test('manager with session: only the callable is used (no direct delete, no client-written audit)', async () => {
    const t = build({ handler: async () => ({ status: 'deleted' }) });
    t.api.deleteClient('C2');
    await new Promise(r => setImmediate(r));
    expect(t.calls[0]).toMatchObject({ name: 'deleteClientAdmin', payload: { clientId: 'C2' } });
    expect(t.writes).toEqual([]);
    expect(t.ui.alerts).toEqual(['Cliente eliminado exitosamente.']);
  });
  test('non-manager is stopped before any call; client with projects is stopped locally', async () => {
    const v = build({ handler: async () => ({}) });
    v.S.currentUser = { id: 'U7', nombre: 'V', role: 'vendedor' };
    v.api.deleteClient('C2');
    expect(v.calls).toEqual([]);
    const m = build({ handler: async () => ({}) });
    m.S.prospects.push({ id: 'P2', clientId: 'C1' });
    m.api.deleteClient('C1');
    expect(m.calls).toEqual([]);
    expect(m.ui.alerts[0]).toMatch(/proyectos asociados/);
  });
  test('server refusal is shown; no success message', async () => {
    const t = build({ handler: async () => { const e = new Error('Tiene proyectos'); e.code = 'functions/failed-precondition'; throw e; } });
    t.api.deleteClient('C2');
    await new Promise(r => setImmediate(r));
    expect(t.ui.alerts).toEqual(['Tiene proyectos.']);
  });
  test('without session: no call and no direct delete', async () => {
    const t = build({ session: false, handler: async () => ({}) });
    t.api.deleteClient('C2');
    expect(t.calls).toEqual([]);
    expect(t.writes).toEqual([]);
    expect(t.ui.alerts).toEqual([CrmCommercial.NO_SESSION_MESSAGE]);
  });
});

describe('settings (real functions)', () => {
  test('addSetting calls updateSettingsAdmin and refreshes the local lists from the answer', async () => {
    const t = build({ handler: async () => ({ status: 'updated', settings: { visitantes: ['Ana', 'Beto'], encargados: [], factory_address: '' } }) });
    const input = t.el('new-visitantes-input', ' Beto ');
    await t.api.addSetting('visitantes');
    expect(t.calls[0]).toMatchObject({ name: 'updateSettingsAdmin', payload: { action: 'addItem', list: 'visitantes', value: 'Beto' } });
    expect(t.S.settings.visitantes).toEqual(['Ana', 'Beto']);
    expect(input.value).toBe('');
    expect(t.writes).toEqual([]);
  });
  test('removeSetting sends the VALUE (not the index) so a stale list cannot remove another item', async () => {
    const t = build({ handler: async () => ({ status: 'updated', settings: { visitantes: [], encargados: [] } }) });
    await t.api.removeSetting('visitantes', 0);
    expect(t.calls[0].payload).toMatchObject({ action: 'removeItem', list: 'visitantes', value: 'Ana' });
    await t.api.removeSetting('visitantes', 7); // out of range: nothing sent
    expect(t.calls).toHaveLength(1);
  });
  test('saveMapsSettings: denial shows the reason and does not claim success', async () => {
    const t = build({ handler: async () => { const e = new Error('Solo gerentes'); e.code = 'functions/permission-denied'; throw e; } });
    t.el('set-gmaps-factory', ' Calle 1 ');
    await t.api.saveMapsSettings();
    expect(t.ui.alerts).toHaveLength(1);
    expect(t.ui.alerts[0]).toMatch(/Solo gerentes/);
    expect(t.calls[0].payload).toMatchObject({ action: 'setFactoryAddress', value: 'Calle 1' });
  });
  test('without session: nothing is sent and the local settings are not changed', async () => {
    const t = build({ session: false, handler: async () => ({}) });
    t.el('new-visitantes-input', 'Beto');
    await t.api.addSetting('visitantes');
    expect(t.calls).toEqual([]);
    expect(t.S.settings.visitantes).toEqual(['Ana']);
  });
});
