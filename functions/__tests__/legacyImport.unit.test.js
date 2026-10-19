// functions/__tests__/legacyImport.unit.test.js
// UNIT layer (in-memory Firestore): the explicit replacement of the old localStorage auto-migration. Proves the
// import logic (validation, create-only, idempotence, identity checks, users never imported). Not an emulator test.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { importLegacy } = require('../legacyImport');
const { parseArgs } = require('../scripts/importLegacyLocalStorage');

const CLOCK = new Date('2026-03-15T12:00:00.000Z');
const client = (o = {}) => ({ id: 'C1', tipo: 'juridica', empresa: 'Industrias Delta', nit: '0614-123456-123-4', telefono: '7000', ...o });
const prospect = (o = {}) => ({ id: '1700000000001', codigo: '202401001', clientId: 'C1', estado: 'activo', etapa: 'prospecto', proyecto: 'Torre', logs: [], facturas: [], ...o });

describe('importLegacy', () => {
  let fdb;
  const run = (payload, opts = {}) => importLegacy({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_local', payload, now: () => CLOCK, ...opts });
  beforeEach(() => { fdb = createFakeFirestore({ clock: () => CLOCK }); });

  test('dry run (default) validates and reports but writes NOTHING', async () => {
    const r = await run({ clients: [client()], prospects: [prospect()], settings: { visitantes: ['Ana'] } });
    expect(r.mode).toBe('dry-run');
    expect(r.applied).toBe(false);
    expect(r.clients).toMatchObject({ total: 1, new: 1 });
    expect(r.prospects).toMatchObject({ total: 1, new: 1 });
    expect(r.settings.status).toBe('new');
    for (const c of ['clients_local', 'prospects_local', 'system_local', 'clientIdentifiers_local', 'commercialAudit_local']) expect(await fdb.list(c)).toHaveLength(0);
  });

  test('apply creates clients (with identifier index), prospects, safe settings keys and one server audit entry', async () => {
    const r = await run({ clients: [client()], prospects: [prospect()], settings: { visitantes: ['Ana', 'Ana', ' Luis '], encargados: ['Pedro'], gmaps_api_key: 'SECRET', otra: 1 } }, { apply: true, operator: 'Benjamin' });
    expect(r.applied).toBe(true);
    expect(r.created).toMatchObject({ clients: 1, prospects: 1, settings: true });
    expect(fdb.data('clients_local/C1')).toEqual(client());
    expect(fdb.data('prospects_local/1700000000001')).toEqual(prospect());
    expect(fdb.data('clientIdentifiers_local/NIT_06141234561234')).toMatchObject({ clientId: 'C1', createdBy: 'legacy-import' });
    expect(fdb.data('system_local/settings')).toEqual({ visitantes: ['Ana', 'Luis'], encargados: ['Pedro'] }); // no gmaps key, no unknown fields
    const audit = await fdb.list('commercialAudit_local');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'legacyImport', actorRole: 'owner', actorCid: 'Benjamin', detail: { clients: 1, prospects: 1, settings: true } });
  });

  test('idempotent: running the same file again creates nothing and overwrites nothing', async () => {
    const payload = { clients: [client()], prospects: [prospect()] };
    await run(payload, { apply: true });
    const again = await run(payload, { apply: true });
    expect(again.clients).toMatchObject({ new: 0, identical: 1, conflict: 0 });
    expect(again.prospects).toMatchObject({ new: 0, identical: 1, conflict: 0 });
    expect(again.created).toMatchObject({ clients: 0, prospects: 0 });
    expect(await fdb.list('clients_local')).toHaveLength(1);
  });

  test('never overwrites: an existing id with different data is a conflict and keeps the stored version', async () => {
    fdb.seed('clients_local/C1', client({ empresa: 'Nombre Actual' }));
    fdb.seed('prospects_local/1700000000001', prospect({ proyecto: 'Version actual' }));
    const r = await run({ clients: [client()], prospects: [prospect()] }, { apply: true });
    expect(r.clients.conflict).toBe(1);
    expect(r.prospects.conflict).toBe(1);
    expect(fdb.data('clients_local/C1').empresa).toBe('Nombre Actual');
    expect(fdb.data('prospects_local/1700000000001').proyecto).toBe('Version actual');
    expect(r.problems.some(p => /no se sobrescribe/.test(p.problem))).toBe(true);
  });

  test('users are never imported, even if the file carries them with passwords', async () => {
    const r = await run({ clients: [client()], users: [{ id: 'U1', nombre: 'Ana', role: 'manager', password: '1234' }] }, { apply: true });
    expect(r.users.skipped).toBe(1);
    expect(await fdb.list('users_local')).toHaveLength(0);
  });

  test('a client whose NIT already belongs to another client is a conflict (no duplicate identity)', async () => {
    fdb.seed('clients_local/C9', client({ id: 'C9', empresa: 'Otra' }));
    fdb.seed('clientIdentifiers_local/NIT_06141234561234', { key: 'NIT_06141234561234', kind: 'NIT', clientId: 'C9' });
    const r = await run({ clients: [client()] }, { apply: true });
    expect(r.clients.conflict).toBe(1);
    expect(r.problems[0].problem).toMatch(/NIT_06141234561234 ya pertenece al cliente C9/);
    expect(fdb.data('clients_local/C1')).toBeUndefined();
  });

  test('two clients of the file with the same NIT: neither is created', async () => {
    const r = await run({ clients: [client(), client({ id: 'C2', empresa: 'Gemela' })] }, { apply: true });
    expect(r.clients.conflict).toBe(1);
    expect(await fdb.list('clients_local')).toHaveLength(1);
  });

  test('invalid records are reported and an apply with invalid records writes nothing at all', async () => {
    const payload = { clients: [client(), { id: '../x', tipo: 'juridica', empresa: 'X' }, client({ id: 'C3', tipo: 'otro' }), { id: 'C4', tipo: 'natural' }], prospects: [prospect({ estado: 'raro' }), prospect({ id: '17', etapa: 'x' })] };
    const dry = await run(payload);
    expect(dry.clients.invalid).toBe(3);
    expect(dry.prospects.invalid).toBe(2);
    const r = await run(payload, { apply: true });
    expect(r.applied).toBe(false);
    expect(r.refused).toMatch(/inválidos/);
    expect(await fdb.list('clients_local')).toHaveLength(0);
    expect(await fdb.list('commercialAudit_local')).toHaveLength(0);
  });

  test('a repeated id inside the file is invalid (no last-one-wins)', async () => {
    const r = await run({ clients: [client(), client({ empresa: 'Otra vez' })] });
    expect(r.clients.invalid).toBe(1);
  });

  test('a prospect needs its client (in the database or in the file) and a unique opportunity code', async () => {
    const r1 = await run({ prospects: [prospect({ clientId: 'NOPE' })] });
    expect(r1.prospects.conflict).toBe(1);
    // client created by the same file
    const r2 = await run({ clients: [client()], prospects: [prospect()] }, { apply: true });
    expect(r2.created.prospects).toBe(1);
    // same code, different id
    const r3 = await run({ prospects: [prospect({ id: '1700000000002' })] }, { apply: true });
    expect(r3.prospects.conflict).toBe(1);
    expect(r3.problems[0].problem).toMatch(/código 202401001/);
    expect(fdb.data('prospects_local/1700000000002')).toBeUndefined();
  });

  test('a prospect of a client that could not be imported is not imported either', async () => {
    fdb.seed('clients_local/C9', client({ id: 'C9' }));
    fdb.seed('clientIdentifiers_local/NIT_06141234561234', { key: 'NIT_06141234561234', kind: 'NIT', clientId: 'C9' });
    const r = await run({ clients: [client()], prospects: [prospect()] }, { apply: true });
    expect(r.prospects.conflict).toBe(1);
    expect(fdb.data('prospects_local/1700000000001')).toBeUndefined();
  });

  test('existing settings are never overwritten', async () => {
    fdb.seed('system_local/settings', { visitantes: ['Actual'], encargados: [] });
    const r = await run({ settings: { visitantes: ['Viejo'] } }, { apply: true });
    expect(r.settings.status).toMatch(/exists/);
    expect(r.created.settings).toBe(false);
    expect(fdb.data('system_local/settings').visitantes).toEqual(['Actual']);
  });

  test('refuses malformed input and oversize files before touching anything', async () => {
    await expect(run('texto')).rejects.toThrow(/objeto JSON/);
    await expect(run({ clients: 'x' })).rejects.toThrow(/listas/);
    await expect(run({ clients: Array.from({ length: 5001 }, (_, i) => client({ id: `C${i}` })) })).rejects.toThrow(/Demasiados/);
    await expect(importLegacy({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_x', payload: {} })).rejects.toThrow(/suffix/);
  });
});

describe('script arguments', () => {
  test('dry run by default, emulator suffix by default, unknown flags refused (there is no flag for a real project)', () => {
    expect(parseArgs(['x.json'])).toMatchObject({ file: 'x.json', apply: false, suffix: '_local' });
    expect(parseArgs(['x.json', '--apply', '--suffix', '_prod', '--operator', 'B'])).toMatchObject({ apply: true, suffix: '_prod', operator: 'B' });
    expect(() => parseArgs(['x.json', '--production'])).toThrow(/desconocido/);
    expect(() => parseArgs([])).toThrow(/archivo/);
    expect(() => parseArgs(['x.json', '--suffix', '_x'])).toThrow(/suffix/);
  });
  test('the script refuses to run outside the emulators', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [require.resolve('../scripts/importLegacyLocalStorage.js'), 'x.json'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not provably the emulators/);
  });
});
