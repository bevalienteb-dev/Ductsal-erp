// functions/__tests__/crmClients.client.test.js
// Browser module of the client catalogue (crm_clients.js) and static guards on how app_core.js / index.html use it.
// No Firebase, no network: the Firebase namespace is a stub.

const fs = require('fs');
const path = require('path');
const CrmClients = require('../../crm_clients.js');

const ROOT = path.join(__dirname, '..', '..');
const appCore = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const between = (from, to) => appCore.slice(appCore.indexOf(from), appCore.indexOf(to, appCore.indexOf(from)));

function fbWith(impl, { session = true } = {}) {
  const calls = [];
  const fb = {
    auth: () => ({ currentUser: session ? { uid: 'u' } : null }),
    functions: () => ({ httpsCallable: (name) => async (payload) => { calls.push({ name, payload }); return { data: await impl(name, payload, calls.length) }; } })
  };
  return { fb, calls };
}
const client = { tipo: 'juridica', empresa: 'Delta', contacto: 'Ana', telefono: '1', nit: '0614-123456-123-4' };

beforeEach(() => CrmClients._pendingOps.clear());

describe('session hint', () => {
  test('true only with a Firebase user', () => {
    expect(CrmClients.hasSessionSync(fbWith(() => ({}), { session: true }).fb)).toBe(true);
    expect(CrmClients.hasSessionSync(fbWith(() => ({}), { session: false }).fb)).toBe(false);
    expect(CrmClients.hasSessionSync(null)).toBe(false);
    expect(CrmClients.hasSessionSync({})).toBe(false);
  });
});

describe('createClient retries', () => {
  test('an uncertain failure keeps the SAME opId for the retry (cannot create two clients)', async () => {
    let n = 0;
    const { fb, calls } = fbWith(() => { if (++n === 1) { const e = new Error('net'); e.code = 'functions/unavailable'; throw e; } return { status: 'created', client: { id: 'C1' } }; });
    await expect(CrmClients.createClient(fb, { client, dbSuffix: '_prod' })).rejects.toBeTruthy();
    await CrmClients.createClient(fb, { client, dbSuffix: '_prod' });
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
  });
  test('a definite answer (duplicate) clears the key: the next attempt gets a new opId', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'duplicate', matches: [] }));
    await CrmClients.createClient(fb, { client, dbSuffix: '_prod' });
    await CrmClients.createClient(fb, { client, dbSuffix: '_prod' });
    expect(calls[0].payload.opId).not.toBe(calls[1].payload.opId);
  });
  test('a validation error is definite too', async () => {
    const { fb, calls } = fbWith(() => { const e = new Error('x'); e.code = 'functions/invalid-argument'; throw e; });
    await expect(CrmClients.createClient(fb, { client, dbSuffix: '_prod' })).rejects.toBeTruthy();
    await expect(CrmClients.createClient(fb, { client, dbSuffix: '_prod' })).rejects.toBeTruthy();
    expect(calls[0].payload.opId).not.toBe(calls[1].payload.opId);
  });
  test('different data gets a different opId', async () => {
    const { fb, calls } = fbWith(() => { const e = new Error('x'); e.code = 'unavailable'; throw e; });
    await CrmClients.createClient(fb, { client, dbSuffix: '_prod' }).catch(() => {});
    await CrmClients.createClient(fb, { client: { ...client, empresa: 'Otra' }, dbSuffix: '_prod' }).catch(() => {});
    expect(calls[0].payload.opId).not.toBe(calls[1].payload.opId);
  });
  test('the browser never sends createdBy / id / visibleTo of its own (it only forwards what the form built)', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'created', client: { id: 'C1' } }));
    await CrmClients.createClient(fb, { client, dbSuffix: '_local', confirmReview: true });
    expect(Object.keys(calls[0].payload).sort()).toEqual(['client', 'confirmReview', 'dbSuffix', 'opId']);
    expect(calls[0].name).toBe('createClientAdmin');
  });
});

describe('search and update', () => {
  test('search calls the catalogue callable with the text and suffix only', async () => {
    const { fb, calls } = fbWith(() => ({ results: [] }));
    await CrmClients.searchCatalog(fb, { q: 'delta', dbSuffix: '_local' });
    expect(calls[0]).toEqual({ name: 'searchClientsCatalog', payload: { q: 'delta', dbSuffix: '_local' } });
  });
  test('update calls updateClientAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'updated' }));
    await CrmClients.updateClient(fb, { id: 'C1', client, dbSuffix: '_local' });
    expect(calls[0].name).toBe('updateClientAdmin');
    expect(calls[0].payload.id).toBe('C1');
  });
});

describe('client reservation and finalization', () => {
  test('reserveCreation calls reserveClientCreationAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'reserved', reservationId: 'RES-1' }));
    const res = await CrmClients.reserveCreation(fb, { client, dbSuffix: '_prod', confirmReview: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('reserveClientCreationAdmin');
    expect(calls[0].payload).toEqual({ client, dbSuffix: '_prod', confirmReview: true });
    expect(res.reservationId).toBe('RES-1');
  });

  test('finalizeCreation calls finalizeClientCreationAdmin with idempotent opId', async () => {
    let n = 0;
    const { fb, calls } = fbWith(() => {
      if (++n === 1) { const e = new Error('net'); e.code = 'functions/unavailable'; throw e; }
      return { status: 'created', client: { id: 'RES-1' } };
    });
    await expect(CrmClients.finalizeCreation(fb, { reservationId: 'RES-1', client, dbSuffix: '_prod' })).rejects.toBeTruthy();
    const res = await CrmClients.finalizeCreation(fb, { reservationId: 'RES-1', client, dbSuffix: '_prod' });
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('finalizeClientCreationAdmin');
    expect(calls[1].name).toBe('finalizeClientCreationAdmin');
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
    expect(res.client.id).toBe('RES-1');
  });

  test('cancelReservation calls cancelClientReservationAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'cancelled', reservationId: 'RES-1' }));
    const res = await CrmClients.cancelReservation(fb, { reservationId: 'RES-1', dbSuffix: '_prod' });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('cancelClientReservationAdmin');
    expect(calls[0].payload).toEqual({ reservationId: 'RES-1', dbSuffix: '_prod' });
    expect(res.status).toBe('cancelled');
  });
});

describe('wording', () => {
  const match = { clientId: 'C1', nombre: 'Delta S.A.', hint: 'NIT ····1234', reasons: ['nit'], inPortfolio: true };
  test('duplicate message names the existing client, never full documents', () => {
    const m = CrmClients.duplicateMessage({ matches: [match] });
    expect(m).toContain('Delta S.A.');
    expect(m).toContain('NIT ····1234');
    expect(m).toContain('mismo NIT');
    expect(m).toContain('ya está en tu cartera');
    expect(m).not.toMatch(/\d{9,}/);
  });
  test('review message asks for confirmation', () => {
    expect(CrmClients.reviewMessage({ matches: [{ ...match, reasons: ['nombre-parecido'], inPortfolio: false }] })).toMatch(/nombre parecido/);
  });
  test('error messages by code', () => {
    expect(CrmClients.errorMessage({ code: 'functions/permission-denied' })).toMatch(/permiso/);
    expect(CrmClients.errorMessage({ code: 'functions/unauthenticated' })).toMatch(/sesión/);
    expect(CrmClients.errorMessage({ code: 'functions/unavailable' })).toMatch(/reintentar/);
    expect(CrmClients.errorMessage({ code: 'functions/failed-precondition' })).toMatch(/reserva.*(expirado|vencid).*cancelada/i);
    expect(CrmClients.errorMessage({ code: 'functions/already-exists' })).toMatch(/formalizad/i);
  });
});

describe('static guards on the page', () => {
  test('saving a client never writes it straight to Firestore, and there is no fallback', () => {
    const save = between('async function saveClient', '// PROSPECTS & PROJECTS LISTS');
    expect(save).toContain('persistClientViaServer');
    expect(save).not.toContain('saveClientToDB');
    const persist = between('async function persistClientViaServer', 'function createNewProspect');
    expect(persist).not.toMatch(/saveClientToDB|\.collection\(|\.set\(/);
  });
  test('no direct client write remains: document removal also goes through updateClientAdmin (manager only on the server)', () => {
    const uses = appCore.split('\n').filter(l => l.includes('saveClientToDB(') && !l.includes('function saveClientToDB'));
    expect(uses).toHaveLength(0);
    const removal = between('async function deleteClientDocument', 'async function saveClient');
    expect(removal).toContain('CrmClients.updateClient');
  });
  test('index.html loads crm_clients.js before app_core.js and has the catalogue search box', () => {
    expect(indexHtml.indexOf('crm_clients.js')).toBeGreaterThan(indexHtml.indexOf('crm_auth.js'));
    expect(indexHtml.indexOf('crm_clients.js')).toBeLessThan(indexHtml.indexOf('app_core.js'));
    expect(indexHtml).toContain('id="new-cliente-search"');
  });
  test('the portfolio list and the selector use different functions', () => {
    expect(between('function renderClientsTable', 'function toggleClientFields')).toContain('getVisibleClients()');
    expect(between('function renderClientsTable', 'function toggleClientFields')).not.toContain('searchCatalog');
  });
});
