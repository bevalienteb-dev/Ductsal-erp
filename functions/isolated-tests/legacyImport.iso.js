// functions/isolated-tests/legacyImport.iso.js
// EMULATOR layer: the explicit, owner-run replacement of the old localStorage auto-migration (functions/legacyImport.js)
// against the REAL isolated Firestore emulator through the Admin SDK (real create() semantics, real transactions).
// Isolation: hard-coded 127.0.0.1:8190 + demo project, same constants as the other *.iso.js files.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { importLegacy } = require('../legacyImport');
const { clearIsolatedFirestore, assertIsolatedUp } = require('./iso');

if (!getApps().length) initializeApp({ projectId: 'demo-ductsal-isolated' });
const db = getFirestore();
const CLOCK = new Date('2026-03-15T12:00:00.000Z');

const client = (o = {}) => ({ id: 'C1', tipo: 'juridica', empresa: 'Industrias Delta', nit: '0614-123456-123-4', telefono: '7000', ...o });
const prospect = (o = {}) => ({ id: '1700000000001', codigo: '202401001', clientId: 'C1', estado: 'activo', etapa: 'prospecto', proyecto: 'Torre', logs: [], facturas: [], ...o });
const run = (payload, opts = {}) => importLegacy({ db, FieldValue, suffix: '_local', payload, now: () => CLOCK, ...opts });
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : undefined; };
const size = async (c) => (await db.collection(c).get()).size;

beforeAll(async () => { await assertIsolatedUp(); });
beforeEach(async () => { await clearIsolatedFirestore(); });

describe('importLegacy against the real isolated Firestore emulator', () => {
  test('dry run writes nothing', async () => {
    const r = await run({ clients: [client()], prospects: [prospect()] });
    expect(r.mode).toBe('dry-run');
    for (const c of ['clients_local', 'prospects_local', 'clientIdentifiers_local', 'commercialAudit_local']) expect(await size(c)).toBe(0);
  });

  test('apply creates the records, the identifier index and one audit entry; users are never imported', async () => {
    const r = await run({ clients: [client()], prospects: [prospect()], users: [{ id: 'U1', role: 'manager', password: 'x' }], settings: { visitantes: ['Ana'], gmaps_api_key: 'SECRET' } }, { apply: true, operator: 'Benjamin' });
    expect(r.created).toMatchObject({ clients: 1, prospects: 1, settings: true });
    expect(await get('clients_local/C1')).toEqual(client());
    expect(await get('prospects_local/1700000000001')).toEqual(prospect());
    expect(await get('clientIdentifiers_local/NIT_06141234561234')).toMatchObject({ clientId: 'C1' });
    expect(await get('system_local/settings')).toEqual({ visitantes: ['Ana'] }); // unsafe keys (gmaps_api_key) are dropped
    expect(await size('users_local')).toBe(0);
    expect(await size('commercialAudit_local')).toBe(1);
  });

  test('idempotent and create-only: a second run creates nothing; a different stored version is a conflict and is kept', async () => {
    const payload = { clients: [client()], prospects: [prospect()] };
    await run(payload, { apply: true });
    const again = await run(payload, { apply: true });
    expect(again.created).toMatchObject({ clients: 0, prospects: 0 });
    await db.doc('clients_local/C1').update({ empresa: 'Nombre Actual' });
    const conflict = await run(payload, { apply: true });
    expect(conflict.clients.conflict).toBe(1);
    expect((await get('clients_local/C1')).empresa).toBe('Nombre Actual');
    expect(await size('clients_local')).toBe(1);
  });

  test('an INVALID record refuses the whole apply: nothing is written', async () => {
    const r = await run({ clients: [client(), client({ id: undefined })], prospects: [prospect()] }, { apply: true });
    expect(r.applied).toBe(false);
    expect(r.refused).toMatch(/inválidos/);
    expect(await size('clients_local')).toBe(0);
    expect(await size('prospects_local')).toBe(0);
    expect(await size('commercialAudit_local')).toBe(0);
  });

  test('a prospect whose client exists nowhere is a conflict: it is skipped, never created orphaned', async () => {
    const r = await run({ clients: [client()], prospects: [prospect({ clientId: 'NOPE' })] }, { apply: true });
    expect(r.prospects.conflict).toBe(1);
    expect(r.created).toMatchObject({ clients: 1, prospects: 0 });
    expect(await size('prospects_local')).toBe(0);
  });
});
