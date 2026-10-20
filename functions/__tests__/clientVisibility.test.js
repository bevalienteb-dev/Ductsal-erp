// functions/__tests__/clientVisibility.test.js
// Client visibility for vendedores (list + selector) versus the opportunities assigned to them.
// Runs the REAL functions of app_core.js (getVisibleClients, renderClientsTable, renderClientSelect,
// getClientName, getProspectVendorInfo, reassignVendor) in a sandbox with in-memory state and a fake DOM.
// Nothing here touches Firebase, the emulators or any network.

const fs = require('fs');
const path = require('path');

const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

const SRC = [
  between('function getProspectVendorInfo', 'function updateOppSortIcons'), // + reassignVendor
  between('// Clients visible to the current user', 'function toggleClientFields'), // getVisibleClients + renderClientsTable
  between('// Selector of NEW opportunities', '// The opportunity is created by createProspectAdmin'), // selector + catalogue search (ends before the now-async createNewProspect)
  between('function getClientName', 'function renderList')
].join('\n');

// Free variables resolve against the state object S (read AND written), like the globals of app_core.js.
function sandbox(S) {
  // Select fake: innerHTML (set / get) and add(Option), the two ways app_core.js fills the selector.
  const select = {
    html: '', options: [], selectedIndex: 0, value: '',
    get innerHTML() { return this.html; },
    set innerHTML(v) { this.html = v; this.options = []; },
    add(o) { this.options.push(o); this.html += `<option value="${o.value}">${o.text}</option>`; }
  };
  const ui = { tbody: { innerHTML: '' }, select, search: { value: '', style: {} }, hint: { textContent: '', style: {} }, alerts: [], saved: [], promptAnswer: null, session: true, reassignCalls: [] };
  const document = {
    getElementById: (id) => ({
      'clients-table-body': ui.tbody,
      'cli-search': { value: '' },
      'new-cliente-select': ui.select,
      'new-cliente-search': ui.search,
      'new-cliente-search-hint': ui.hint
    })[id]
  };
  const api = new Function('S', 'document', 'ui', `
    var cliSortCol = ''; var cliSortDir = 'asc';
    var Option = function (text, value) { this.text = text; this.value = value; };
    var setTimeout = function () {}; var clearTimeout = function () {}; var DB_SUFFIX = '_prod';
    with (S) {
      var prompt = function () { return ui.promptAnswer; };
      var alert = function (m) { ui.alerts.push(m); };
      var saveProspectToDB = function (p) { ui.saved.push(p.id); };
      var addLogToProspect = function (p, text) { p.logs = (p.logs || []).concat([text]); };
      var showLoading = function () {}; var hideLoading = function () {};
      var firebase = { auth: function () { return { currentUser: ui.session ? { uid: 'u' } : null }; } };
      // Stand-in for the callable: what reassignProspectAdmin answers for an existing active user.
      var CrmCommercial = {
        NO_SESSION_MESSAGE: 'no-session',
        hasSessionSync: function (f) { return !!(f && f.auth().currentUser); },
        errorMessage: function (e) { return 'ERR:' + e.message; },
        reassign: function (f, a) {
          ui.reassignCalls.push(a);
          var t = S.users.find(function (u) { return u.id === a.vendedorId; });
          if (!t) return Promise.reject(new Error('not-found'));
          if (S.prospects.find(function (p) { return p.id === a.prospectId; }).vendedorId === t.id) return Promise.resolve({ status: 'unchanged', vendedorId: t.id });
          return Promise.resolve({ status: 'reassigned', vendedorId: t.id, vendedorName: t.nombre, vendedorRole: t.role });
        }
      };
      var openDetail = function () {}; var renderList = function () {};
      ${SRC}
      return { getVisibleClients: getVisibleClients, renderClientsTable: renderClientsTable, renderClientSelect: renderClientSelect, runClientCatalogSearch: runClientCatalogSearch, selectClientInSelector: selectClientInSelector,
               getClientName: getClientName, reassignVendor: reassignVendor, getProspectVendorInfo: getProspectVendorInfo };
    }
  `)(S, document, ui);
  return { api, ui };
}

// ---------- fictitious users, clients and opportunities ----------
const U = {
  v1: { id: '1792037387205', nombre: 'Vendedor 1', email: 'vendedor.prueba@ductsal-test.invalid', role: 'vendedor', activo: true },
  v2: { id: '1792038830686', nombre: 'Vendedor 2', email: 'vendedor.segundo@ductsal-test.invalid', role: 'vendedor', activo: true },
  v3: { id: '1792039999999', nombre: 'Vendedor 3', email: 'vendedor.tres@ductsal-test.invalid', role: 'vendedor', activo: true },
  vNone: { id: '1792040000001', nombre: 'Vendedor Sin Datos', email: 'vendedor.nada@ductsal-test.invalid', role: 'vendedor', activo: true },
  mgr: { id: '1000000000001', nombre: 'Gerente', email: 'gerente.prueba@ductsal-test.invalid', role: 'manager', activo: true },
  gest: { id: '1000000000002', nombre: 'Gestor', email: 'gestor.prueba@ductsal-test.invalid', role: 'gestor', activo: true }
};
const client = (id, createdBy, nombres) => ({ id, tipo: 'natural', nombres, apellidos: 'Ficticio', createdBy });
const prospect = (id, clientId, createdBy, vendedorId) => ({ id, codigo: id, clientId, createdBy, vendedorId, proyecto: '[PRUEBA] ' + id, etapa: 'prospecto', estado: 'activo' });

function world() {
  return {
    users: Object.values(U),
    clients: [
      client('CTEST-VIS-C1', U.v1.id, 'Cliente Uno'),   // created by seller 1
      client('C-MGR', U.mgr.id, 'Cliente Gerente'),     // created by the manager, no opportunity
      client('C-V3', U.v3.id, 'Cliente Tres')           // created by seller 3
    ],
    prospects: [
      prospect('TEST-VIS-P1', 'CTEST-VIS-C1', U.v1.id, U.v1.id), // seller 1's opportunity on C1
      prospect('TEST-VIS-P2', 'CTEST-VIS-C1', U.v2.id, U.v2.id)  // seller 2's opportunity on C1 (created by seller 1)
    ],
    currentUser: null
  };
}
const ids = (list) => list.map((c) => c.id).sort();
const asUser = (S, u) => { S.currentUser = u; return sandbox(S); };

describe('getVisibleClients for vendedores', () => {
  test('seller 2 sees C1 through P2 (and nothing else of the others)', () => {
    const S = world();
    const { api } = asUser(S, U.v2);
    expect(ids(api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
  });

  test('seller 1 still sees C1 (created it and has P1)', () => {
    const S = world();
    const { api } = asUser(S, U.v1);
    expect(ids(api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
  });

  test('a vendedor with no relation to C1 does not see it (only their own client)', () => {
    const S = world();
    const { api } = asUser(S, U.v3);
    expect(ids(api.getVisibleClients())).toEqual(['C-V3']);
    expect(ids(api.getVisibleClients())).not.toContain('CTEST-VIS-C1');
  });

  test('a vendedor with no clients and no opportunities sees nothing', () => {
    const S = world();
    const { api, ui } = asUser(S, U.vNone);
    expect(api.getVisibleClients()).toEqual([]);
    api.renderClientsTable();
    api.renderClientSelect();
    expect(ui.tbody.innerHTML).toBe('');
    expect(ui.select.innerHTML).not.toMatch(/<option value="C/);
  });

  test('an opportunity created by the manager and assigned to the vendedor exposes its client (assignment only)', () => {
    const S = world();
    S.prospects.push(prospect('P-MGR', 'C-MGR', U.mgr.id, U.v1.id));
    expect(ids(asUser(S, U.v1).api.getVisibleClients())).toEqual(['C-MGR', 'CTEST-VIS-C1']);
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
  });

  test('an opportunity created by the vendedor but assigned to someone else transfers client visibility to assignee only', () => {
    const S = world();
    S.prospects.push(prospect('P-X', 'C-V3', U.v2.id, U.v3.id)); // created by seller 2, assigned to seller 3
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
    expect(ids(asUser(S, U.v3).api.getVisibleClients())).toEqual(['C-V3']);
  });

  test('dangling clientId in an opportunity is harmless', () => {
    const S = world();
    S.prospects.push(prospect('P-DANGLING', 'C-DOES-NOT-EXIST', U.v2.id, U.v2.id));
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
  });
});

describe('historical login (no server session): the selector falls back to the portfolio', () => {
  test('seller 2: C1 appears in the clients table AND in the new-opportunity selector', () => {
    const S = world();
    const { api, ui } = asUser(S, U.v2);
    api.renderClientsTable();
    api.renderClientSelect();
    expect(ui.tbody.innerHTML).toContain('Cliente Uno');
    expect(ui.tbody.innerHTML).toContain("openClientModal('CTEST-VIS-C1')");
    expect(ui.tbody.innerHTML).not.toContain('Cliente Tres');
    expect(ui.tbody.innerHTML).not.toContain('Cliente Gerente');
    expect(ui.select.innerHTML).toContain('<option value="CTEST-VIS-C1">');
    expect(ui.select.innerHTML).not.toContain('C-V3');
    expect(ui.select.innerHTML).not.toContain('C-MGR');
  });

  test('seller 3 does not get C1 in either place', () => {
    const S = world();
    const { api, ui } = asUser(S, U.v3);
    api.renderClientsTable();
    api.renderClientSelect();
    expect(ui.tbody.innerHTML).not.toContain('Cliente Uno');
    expect(ui.select.innerHTML).not.toContain('CTEST-VIS-C1');
    expect(ui.tbody.innerHTML).toContain('Cliente Tres');
  });
});

describe('gerente and gestor are unchanged', () => {
  test.each([['manager', U.mgr], ['gestor', U.gest]])('%s sees every client in the list and the selector', (_n, user) => {
    const S = world();
    const { api, ui } = asUser(S, user);
    expect(api.getVisibleClients()).toBe(S.clients); // same array as before the change
    api.renderClientsTable();
    api.renderClientSelect();
    for (const c of S.clients) {
      expect(ui.tbody.innerHTML).toContain(c.nombres);
      expect(ui.select.innerHTML).toContain(`<option value="${c.id}">`);
    }
  });

  test('no session keeps the previous behaviour (no filtering)', () => {
    const S = world();
    const { api } = asUser(S, null);
    expect(api.getVisibleClients()).toBe(S.clients);
  });

  test('only the manager gets the delete button (unchanged)', () => {
    const S = world();
    const m = asUser(S, U.mgr); m.api.renderClientsTable();
    const v = asUser(S, U.v2); v.api.renderClientsTable();
    expect(m.ui.tbody.innerHTML).toContain('deleteClient(');
    expect(v.ui.tbody.innerHTML).not.toContain('deleteClient(');
  });
});

describe('reassigning an opportunity (real reassignVendor)', () => {
  test('moving a manager-created opportunity from seller 1 to seller 2 moves the client visibility with it', async () => {
    const S = world();
    S.prospects.push(prospect('P-MOVE', 'C-MGR', U.mgr.id, U.v1.id));
    expect(ids(asUser(S, U.v1).api.getVisibleClients())).toContain('C-MGR');
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).not.toContain('C-MGR');

    const { api, ui } = asUser(S, U.mgr);
    ui.promptAnswer = U.v2.email;
    await api.reassignVendor('P-MOVE');
    expect(S.prospects.find((p) => p.id === 'P-MOVE').vendedorId).toBe(U.v2.id);
    expect(ui.reassignCalls).toHaveLength(1);
    expect(ui.reassignCalls[0]).toMatchObject({ prospectId: 'P-MOVE', vendedorId: U.v2.id });
    expect(ui.saved).toEqual([]); // no direct write of the opportunity from the browser

    expect(ids(asUser(S, U.v1).api.getVisibleClients())).not.toContain('C-MGR'); // lost the opportunity and the client
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).toContain('C-MGR');     // gained both
  });

  test('without a Firebase session nothing is reassigned and no write is attempted (no fallback)', async () => {
    const S = world();
    S.prospects.push(prospect('P-NOS', 'C-MGR', U.mgr.id, U.v1.id));
    const { api, ui } = asUser(S, U.mgr);
    ui.session = false;
    ui.promptAnswer = U.v2.email;
    await api.reassignVendor('P-NOS');
    expect(S.prospects.find((p) => p.id === 'P-NOS').vendedorId).toBe(U.v1.id);
    expect(ui.reassignCalls).toEqual([]);
    expect(ui.saved).toEqual([]);
    expect(ui.alerts).toEqual(['no-session']);
  });

  test('reassigning an opportunity removes client visibility if vendor has no other links and did not create client', async () => {
    const S = world();
    const { api, ui } = asUser(S, U.mgr);
    ui.promptAnswer = U.v1.email;
    await api.reassignVendor('TEST-VIS-P2'); // created by seller 2, now assigned to seller 1
    expect(S.prospects.find((p) => p.id === 'TEST-VIS-P2').vendedorId).toBe(U.v1.id);
    expect(ids(asUser(S, U.v1).api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
    expect(ids(asUser(S, U.v2).api.getVisibleClients())).toEqual([]); // no longer linked to CTEST-VIS-C1
  });

  test('invariant: after every reassignment, each client of a visible opportunity is visible', async () => {
    // Same criterion renderList applies to opportunities for a vendedor.
    const visibleProspects = (S, u) => S.prospects.filter((p) => p.vendedorId === u.id || (p.createdBy === u.id && (!p.vendedorId || p.vendedorId === u.id)));
    const S = world();
    S.prospects.push(prospect('P-A', 'C-MGR', U.mgr.id, U.v1.id), prospect('P-B', 'C-V3', U.v3.id, U.v3.id));
    const sellers = [U.v1, U.v2, U.v3, U.vNone];
    const check = () => {
      for (const u of sellers) {
        const visible = new Set(asUser(S, u).api.getVisibleClients().map((c) => c.id));
        for (const p of visibleProspects(S, u)) {
          if (S.clients.some((c) => c.id === p.clientId)) expect(visible.has(p.clientId)).toBe(true);
        }
      }
    };
    check();
    for (const [pid, to] of [['P-A', U.v2], ['P-A', U.vNone], ['P-B', U.v1], ['TEST-VIS-P1', U.v3], ['TEST-VIS-P2', U.vNone]]) {
      const { api, ui } = asUser(S, U.mgr);
      ui.promptAnswer = to.email;
      await api.reassignVendor(pid);
      expect(S.prospects.find((p) => p.id === pid).vendedorId).toBe(to.id); // the move really happened
      check();
    }
  });
});

describe('the detail still resolves the client independently of the list', () => {
  test('getClientName finds C1 for seller 2 either way (it reads the full clients array)', () => {
    const S = world();
    const { api } = asUser(S, U.v3); // seller 3 cannot see C1 in the list...
    expect(ids(api.getVisibleClients())).not.toContain('CTEST-VIS-C1');
    expect(api.getClientName('CTEST-VIS-C1')).toBe('Cliente Uno Ficticio'); // ...but names still resolve by clientId
  });
});

describe('no stored data is modified by the visibility logic', () => {
  test('clients and prospects are byte-identical after rendering for every role', () => {
    const S = world();
    const before = JSON.stringify([S.clients, S.prospects]);
    for (const u of Object.values(U)) {
      const { api } = asUser(S, u);
      api.getVisibleClients();
      api.renderClientsTable();
      api.renderClientSelect();
    }
    expect(JSON.stringify([S.clients, S.prospects])).toBe(before);
  });

  test('for a vendedor the function returns a new array (never the global one)', () => {
    const S = world();
    const { api } = asUser(S, U.v2);
    expect(api.getVisibleClients()).not.toBe(S.clients);
  });
});

describe('static guards', () => {
  test('list uses getVisibleClients; the selector reaches it only through the legacy fallback; no inline createdBy filtering', () => {
    const table = between('function renderClientsTable', 'function toggleClientFields');
    const select = between('// Selector of NEW opportunities', 'function createNewProspect');
    expect(table).toContain('getVisibleClients()');
    expect(select).toContain('getVisibleClients()'); // only as the degraded fallback (see the catalogue tests)
    expect(table).not.toMatch(/c\.createdBy === currentUser\.id/);
    expect(select).not.toMatch(/c\.createdBy === currentUser\.id/);
  });

  test('the opportunity list still uses the criterion this logic mirrors', () => {
    const list = between('function renderList', 'function renderProjectsList');
    expect(list).toContain('p.createdBy === currentUser.id');
    expect(list).toContain('p.vendedorId === currentUser.id');
  });

  test('getVisibleClients contains no writes to stored fields', () => {
    const fn = between('function getVisibleClients', 'function renderClientsTable');
    expect(fn).not.toMatch(/\.(createdBy|vendedorId|clientId)\s*=[^=]/);
    expect(fn).not.toMatch(/saveClientToDB|saveProspectToDB|\.set\(|\.update\(|\.delete\(/);
  });
});

describe('catalogue selector (vendedor with a Firebase session): different criterion from the portfolio list', () => {
  const entry = (id, nombre, inPortfolio = false) => ({ id, nombre, tipo: 'natural', hint: 'DUI ····5678', inPortfolio });
  const withSession = (S, results) => {
    S.firebase = {};
    S.DB_SUFFIX = '_local';
    S.calls = [];
    S.CrmClients = {
      hasSessionSync: () => true,
      searchCatalog: async (_fb, args) => { S.calls.push(args); return { results, tooShort: false, truncated: false }; },
      catalogOptionLabel: (e) => `${e.nombre} - ${e.hint}${e.inPortfolio ? ' *' : ''}`,
      errorMessage: () => 'error'
    };
  };

  test('the selector starts empty (no download of the catalogue) and the search box is shown', () => {
    const S = world(); withSession(S, []);
    const { api, ui } = asUser(S, U.v2);
    api.renderClientSelect();
    expect(ui.select.options).toHaveLength(0);
    expect(ui.select.innerHTML).toBe('<option value="">-- Selecciona Cliente --</option>');
    expect(ui.search.style.display).toBe('block');
  });

  test('seller 2 searches and selects a client created by seller 3 that is NOT in their portfolio', async () => {
    const S = world(); withSession(S, [entry('C-V3', 'Cliente Tres Ficticio')]);
    const { api, ui } = asUser(S, U.v2);
    api.renderClientSelect();
    ui.search.value = 'tres';
    await api.runClientCatalogSearch();
    expect(S.calls).toEqual([{ q: 'tres', dbSuffix: '_local' }]);
    expect(ui.select.innerHTML).toContain('<option value="C-V3">');
    // ...while the portfolio list still hides it
    expect(ids(api.getVisibleClients())).toEqual(['CTEST-VIS-C1']);
    api.renderClientsTable();
    expect(ui.tbody.innerHTML).not.toContain('Cliente Tres');
  });

  test('choosing a catalogue client modifies nothing (createdBy, vendedorId, clientId untouched)', async () => {
    const S = world(); withSession(S, [entry('C-V3', 'Cliente Tres Ficticio')]);
    const before = JSON.stringify([S.clients, S.prospects]);
    const { api, ui } = asUser(S, U.v2);
    api.renderClientSelect();
    ui.search.value = 'tres';
    await api.runClientCatalogSearch();
    api.selectClientInSelector('C-V3', 'Cliente Tres Ficticio');
    expect(ui.select.value).toBe('C-V3');
    expect(JSON.stringify([S.clients, S.prospects])).toBe(before);
    expect(S.clients.find((c) => c.id === 'C-V3').createdBy).toBe(U.v3.id);
  });

  test('once an opportunity of seller 2 points at that client, it joins their portfolio list', () => {
    const S = world(); withSession(S, []);
    S.prospects.push(prospect('P-NEW', 'C-V3', U.v2.id, U.v2.id));
    const { api } = asUser(S, U.v2);
    expect(ids(api.getVisibleClients())).toEqual(['C-V3', 'CTEST-VIS-C1']);
  });

  test('gerente and gestor keep the complete local list even with a session (no server search)', () => {
    for (const user of [U.mgr, U.gest]) {
      const S = world(); withSession(S, []);
      const { api, ui } = asUser(S, user);
      api.renderClientSelect();
      for (const c of S.clients) expect(ui.select.innerHTML).toContain(`<option value="${c.id}">`);
      expect(ui.search.style.display).toBe('none');
    }
  });

  test('the selector code never writes data and never reuses the portfolio function for a session', () => {
    const src = between('// Selector of NEW opportunities', 'async function persistClientViaServer');
    expect(src).not.toMatch(/saveClientToDB|saveProspectToDB|\.set\(|\.update\(|\.delete\(|\.createdBy\s*=[^=]/);
    expect(src).toContain('CrmClients.searchCatalog');
  });
});
