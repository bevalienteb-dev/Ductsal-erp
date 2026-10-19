// functions/isolated-tests/clientsService.iso.js
// clientsService (duplicate-safe creation / edition, catalogue search, visibleTo) against the REAL isolated Firestore
// emulator through the Admin SDK: real transactions, real contention. Authorization is the service's own (server side),
// the Admin SDK ignores Firestore rules by design - the rules are covered in firestore.rules.iso.js.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { createClientsService, ServiceError } = require('../clientsService');
const { clearIsolatedFirestore, assertIsolatedUp } = require('./iso');

if (!getApps().length) initializeApp({ projectId: 'demo-ductsal-isolated' });
const db = getFirestore();
const SUFFIX = '_local';
const col = n => db.collection(n + SUFFIX);

let seq = 0;
const newService = (extra = {}) => createClientsService({ db, FieldValue, suffix: SUFFIX, cacheTtlMs: 0, ...extra });
const opId = () => `op-test-${Date.now()}-${++seq}`;

const V1 = '1792037387205', V2 = '1792038830686', V3 = '1792099999999', GES = '1000000000002', MGR = '1000000000001';
const caller = (cid, role) => ({ uid: 'uid-' + cid, cid, role, name: 'N' + cid });
const asV1 = caller(V1, 'vendedor'), asV2 = caller(V2, 'vendedor'), asV3 = caller(V3, 'vendedor'), asGes = caller(GES, 'gestor'), asMgr = caller(MGR, 'manager');

const empresa = (o = {}) => ({ tipo: 'juridica', empresa: 'Industrias Delta S.A. de C.V.', contacto: 'Ana Perez', telefono: '7000-0001', ...o });
const natural = (o = {}) => ({ tipo: 'natural', nombres: 'Maria Elena', apellidos: 'Lopez Quintanilla', telefono: '7000-0002', ...o });

const svc = newService();
const ids = () => col('clients').get().then(s => s.docs.map(d => d.id));
const keyDocs = () => db.collection('clientIdentifiers' + SUFFIX).get().then(s => s.docs.map(d => d.id).sort());

beforeAll(async () => { await assertIsolatedUp(); });
beforeEach(async () => { await clearIsolatedFirestore(); svc.invalidateCache(); });

describe('resolveCaller (server-side authorization)', () => {
  const profile = (o = {}) => ({ id: V1, authUid: 'uid-1', role: 'vendedor', activo: true, nombre: 'V1', ...o });
  const ctx = (uid, claims = {}) => ({ auth: { uid, token: { ...claims } } });

  test('no session -> unauthenticated', async () => {
    await expect(svc.resolveCaller(null)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(svc.resolveCaller({})).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  test('active vendedor resolved by cid claim; commercial id is kept (not the uid)', async () => {
    await col('users').doc(V1).set(profile());
    await expect(svc.resolveCaller(ctx('uid-1', { cid: V1 }))).resolves.toMatchObject({ cid: V1, role: 'vendedor', uid: 'uid-1' });
  });
  test('active vendedor without a cid claim is resolved through authUid', async () => {
    await col('users').doc(V1).set(profile());
    await expect(svc.resolveCaller(ctx('uid-1'))).resolves.toMatchObject({ cid: V1 });
  });
  test('inactive profile is denied', async () => {
    await col('users').doc(V1).set(profile({ activo: false }));
    await expect(svc.resolveCaller(ctx('uid-1', { cid: V1 }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('historical profile without authUid is denied (and cannot be reached with a forged cid claim)', async () => {
    await col('users').doc('LEGACY1').set({ id: 'LEGACY1', role: 'vendedor', activo: true, password: 'legacy-placeholder' });
    await expect(svc.resolveCaller(ctx('uid-x', { cid: 'LEGACY1' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('cid claim pointing at another account profile is denied', async () => {
    await col('users').doc(V1).set(profile());
    await expect(svc.resolveCaller(ctx('uid-intruder', { cid: V1 }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('unknown profile is denied', async () => {
    await expect(svc.resolveCaller(ctx('uid-zzz', { cid: 'NOPE' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('plant role has no access to the client catalogue', async () => {
    await col('users').doc('P1').set(profile({ id: 'P1', authUid: 'uid-p', role: 'operario' }));
    await expect(svc.resolveCaller(ctx('uid-p', { cid: 'P1' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('manager needs the verified manager claim', async () => {
    await col('users').doc(MGR).set(profile({ id: MGR, authUid: 'uid-m', role: 'manager' }));
    await expect(svc.resolveCaller(ctx('uid-m', { cid: MGR }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(svc.resolveCaller(ctx('uid-m', { cid: MGR, manager: true }))).resolves.toMatchObject({ role: 'manager' });
  });
  test('a vendedor cannot become manager by sending manager: true (role comes from the profile)', async () => {
    await col('users').doc(V1).set(profile());
    const c = await svc.resolveCaller(ctx('uid-1', { cid: V1, manager: true, role: 'manager' }));
    expect(c.role).toBe('vendedor');
  });
});

describe('create: sanitising and ownership', () => {
  test('creates a client owned by the caller; createdBy / id / visibleTo from the browser are ignored', async () => {
    const r = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '0614-123456-123-4', createdBy: V3, id: 'HACK', visibleTo: [V3], fecha_creacion: '1999', authUid: 'x' }) });
    expect(r.status).toBe('created');
    const doc = (await col('clients').doc(r.client.id).get()).data();
    expect(doc.createdBy).toBe(V1);
    expect(doc.id).toBe(r.client.id);
    expect(doc.id).not.toBe('HACK');
    expect(doc.visibleTo).toBeUndefined();
    expect(doc.authUid).toBeUndefined();
    expect(doc.fecha_creacion).not.toBe('1999');
    expect(await keyDocs()).toEqual(['NIT_06141234561234']);
  });
  test('required data keeps being required (type, names, contact) - nothing new is mandatory', async () => {
    await expect(svc.create({ caller: asV1, opId: opId(), client: { empresa: 'x' } })).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.create({ caller: asV1, opId: opId(), client: { tipo: 'natural', nombres: 'A' } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(svc.create({ caller: asV1, opId: opId(), client: { tipo: 'juridica', empresa: 'A', contacto: 'B' } })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('NIT and DUI are optional: clients without documents are created and are not indexed', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'Alfa Metales' }) });
    const b = await svc.create({ caller: asV2, opId: opId(), client: natural({ nombres: 'Jose', apellidos: 'Rivera' }) });
    expect([a.status, b.status]).toEqual(['created', 'created']);
    expect(await keyDocs()).toEqual([]);
  });
  test('opId is mandatory for a real creation', async () => {
    await expect(svc.create({ caller: asV1, client: empresa() })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(svc.create({ caller: asV1, opId: 'short', client: empresa() })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('dryRun writes nothing', async () => {
    const r = await svc.create({ caller: asV1, dryRun: true, client: empresa({ nit: '06141234561234' }) });
    expect(r.status).toBe('ok');
    expect(await ids()).toEqual([]);
    expect(await keyDocs()).toEqual([]);
  });
});

describe('create: exact duplicates by NIT / DUI (normalised)', () => {
  test.each([
    ['0614-123456-123-4', '06141234561234'],
    ['0614 123456 123 4', '0614-123456-123-4'],
    ['  06141234561234  ', '0614-123456-123-4']
  ])('NIT %s matches %s', async (a, b) => {
    const first = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: a }) });
    expect(first.status).toBe('created');
    const dup = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'Otro Nombre Distinto', nit: b }) });
    expect(dup.status).toBe('duplicate');
    expect(dup.matches[0]).toMatchObject({ clientId: first.client.id, level: 'exact' });
    expect(await ids()).toHaveLength(1);
  });
  test.each([
    ['01234567-8', '012345678'],
    ['012345678', '0 1 2 3 4 5 6 7-8'],
    ['01234567-8', '1234567-8'] // 8 digits: a lost leading zero
  ])('DUI %s matches %s (persona natural)', async (a, b) => {
    const first = await svc.create({ caller: asV1, opId: opId(), client: natural({ dui: a }) });
    expect(first.status).toBe('created');
    const dup = await svc.create({ caller: asV3, opId: opId(), client: natural({ nombres: 'Pedro', apellidos: 'Gomez', dui: b }) });
    expect(dup.status).toBe('duplicate');
    expect(await ids()).toHaveLength(1);
  });
  test('the duplicate answer hides what the caller must not learn (no phone / e-mail / owner / full document)', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234', correo: 'secreto@x.invalid' }) });
    const dup = await svc.create({ caller: asV2, opId: opId(), client: empresa({ nit: '0614-123456-123-4' }) });
    const text = JSON.stringify(dup);
    expect(text).not.toContain('secreto@x.invalid');
    expect(text).not.toContain('7000-0001');
    expect(text).not.toContain('06141234561234');
    expect(text).not.toContain(V1);
    expect(dup.matches[0].hint).toMatch(/····/);
    expect(dup.matches[0].inPortfolio).toBe(false); // the caller is told the client exists, not given its data
  });
  test('inPortfolio is true when the existing client belongs to the caller', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234' }) });
    const dup = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234' }) });
    expect(dup.status).toBe('duplicate');
    expect(dup.matches[0].inPortfolio).toBe(true);
  });
  test('an exact duplicate cannot be forced with confirmReview', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234' }) });
    const r = await svc.create({ caller: asV2, opId: opId(), confirmReview: true, client: empresa({ nit: '0614-123456-123-4' }) });
    expect(r.status).toBe('duplicate');
    expect(await ids()).toHaveLength(1);
  });
  test('DUI is a key only for personas naturales: dui_rep / nit_rep / nrc of a company never block', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: natural({ dui: '012345678' }) });
    const r = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'Zeta Aceros', dui_rep: '012345678', nit_rep: '06141234561234', nrc: '123456' }) });
    expect(['created', 'needs-review']).toContain(r.status);
    expect(r.status).not.toBe('duplicate');
  });
  test('NIT and DUI are not interchangeable: nine digits as NIT are not a DUI match', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: natural({ dui: '012345678' }) });
    const r = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'Gamma Industrial', nit: '012345678' }) });
    expect(r.status).not.toBe('duplicate'); // at most a review warning (same digits across namespaces)
  });
  test('malformed documents are never used as a key (warning only)', async () => {
    const r = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '123' }) });
    expect(r.status).toBe('created');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(await keyDocs()).toEqual([]);
  });
});

describe('create: doubtful matches only warn', () => {
  test('same name with a DIFFERENT document -> needs-review, then created after confirmation', async () => {
    const first = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234' }) });
    const same = { ...empresa({ nit: '06149999999999' }) };
    const r1 = await svc.create({ caller: asV2, opId: opId(), client: same });
    expect(r1.status).toBe('needs-review');
    expect(r1.matches[0]).toMatchObject({ clientId: first.client.id, level: 'review' });
    expect(await ids()).toHaveLength(1);
    const r2 = await svc.create({ caller: asV2, opId: opId(), client: same, confirmReview: true });
    expect(r2.status).toBe('created');
    expect(await ids()).toHaveLength(2);
    expect(await keyDocs()).toEqual(['NIT_06141234561234', 'NIT_06149999999999']);
  });
  test('similar name (company suffix noise) without documents -> needs-review', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'Industrias Delta' }) });
    const r = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'INDUSTRIAS DELTA, S.A. DE C.V.' }) });
    expect(r.status).toBe('needs-review');
  });
  test('same name, no documents on either side: warn, never block', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: natural() });
    const r = await svc.create({ caller: asV2, opId: opId(), client: natural(), confirmReview: true });
    expect(r.status).toBe('created');
  });
  test('only a phone in common is information, not a warning that blocks', async () => {
    await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'Primera Empresa', telefono: '7777-7777' }) });
    const r = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'Segunda Distinta', telefono: '7777-7777' }) });
    expect(r.status).toBe('created');
  });
});

describe('create: concurrency and retries', () => {
  test('8 simultaneous attempts for the same NIT (different opIds) create exactly one client', async () => {
    const services = Array.from({ length: 8 }, () => newService());
    const results = await Promise.all(services.map((s, i) => s.create({
      caller: i % 2 ? asV1 : asV2, opId: opId(), client: empresa({ empresa: 'Concurrente ' + i, nit: i % 2 ? '0614-123456-123-4' : '06141234561234' })
    }).catch(e => ({ status: 'error', code: e.code, message: e.message }))));
    const created = results.filter(r => r.status === 'created');
    const dups = results.filter(r => r.status === 'duplicate');
    expect(results.filter(r => r.status === 'error')).toEqual([]);
    expect(created).toHaveLength(1);
    expect(dups).toHaveLength(7);
    for (const d of dups) expect(d.matches[0].clientId).toBe(created[0].client.id);
    expect(await ids()).toHaveLength(1);
    expect(await keyDocs()).toEqual(['NIT_06141234561234']);
  });
  test('8 simultaneous attempts for the same DUI create exactly one client', async () => {
    const services = Array.from({ length: 8 }, () => newService());
    const results = await Promise.all(services.map((s, i) => s.create({
      caller: asV1, opId: opId(), client: natural({ nombres: 'Nombre' + i, apellidos: 'Apellido' + i, dui: i % 2 ? '01234567-8' : '012345678' })
    }).catch(e => ({ status: 'error', code: e.code }))));
    expect(results.filter(r => r.status === 'error')).toEqual([]);
    expect(results.filter(r => r.status === 'created')).toHaveLength(1);
    expect(await ids()).toHaveLength(1);
  });
  test('simultaneous attempts WITHOUT documents are independent (nothing to collide on)', async () => {
    const services = Array.from({ length: 5 }, () => newService());
    const results = await Promise.all(services.map((s, i) => s.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'Sin Doc Numero ' + i * 7 + 'x' + i, contacto: 'C' + i }) })));
    expect(results.every(r => r.status === 'created')).toBe(true);
    expect(await ids()).toHaveLength(5);
  });
  test('the same request retried (same opId and payload) returns the same client and writes nothing new', async () => {
    const id = opId();
    const payload = empresa({ nit: '06141234561234' });
    const a = await svc.create({ caller: asV1, opId: id, client: payload });
    const b = await svc.create({ caller: asV1, opId: id, client: payload });
    expect(a.status).toBe('created');
    expect(b).toMatchObject({ status: 'created', replay: true });
    expect(b.client.id).toBe(a.client.id);
    expect(await ids()).toHaveLength(1);
  });
  test('retry of a creation while two copies run at once still creates one client', async () => {
    const id = opId();
    const payload = empresa({ nit: '06141234561234' });
    const [a, b] = await Promise.all([newService().create({ caller: asV1, opId: id, client: payload }), newService().create({ caller: asV1, opId: id, client: payload })]);
    expect(await ids()).toHaveLength(1);
    expect([a.status, b.status].filter(s => s === 'created')).toHaveLength(2); // both report the same single client
    expect(a.client.id).toBe(b.client.id);
  });
  test('same opId with other data is refused', async () => {
    const id = opId();
    await svc.create({ caller: asV1, opId: id, client: empresa({ nit: '06141234561234' }) });
    await expect(svc.create({ caller: asV1, opId: id, client: empresa({ empresa: 'Distinta', nit: '06149999999999' }) })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  test('an opId cannot be replayed by another user', async () => {
    const id = opId();
    const payload = empresa({ nit: '06141234561234' });
    await svc.create({ caller: asV1, opId: id, client: payload });
    await expect(svc.create({ caller: asV2, opId: id, client: payload })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('historical duplicates (already in the database, not indexed)', () => {
  beforeEach(async () => {
    await col('clients').doc('H1').set({ id: 'H1', tipo: 'juridica', empresa: 'Historica Uno', contacto: 'A', telefono: '1', nit: '0614-111111-111-1', createdBy: V1 });
    await col('clients').doc('H2').set({ id: 'H2', tipo: 'juridica', empresa: 'Historica Dos', contacto: 'B', telefono: '2', nit: '06141111111111', createdBy: V2 }); // same NIT, other format
  });
  test('a new client with that NIT is blocked and BOTH historical clients are shown', async () => {
    const r = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Nueva', nit: '06141111111111' }) });
    expect(r.status).toBe('duplicate');
    expect(r.matches.map(m => m.clientId).sort()).toEqual(['H1', 'H2']);
    expect(await keyDocs()).toEqual([]);
  });
  test('editing an unrelated field of a historical duplicate is allowed (not this edit\'s problem) and no history is altered', async () => {
    const r = await svc.update({ caller: asMgr, id: 'H1', client: { tipo: 'juridica', empresa: 'Historica Uno', contacto: 'A', telefono: '1', nit: '0614-111111-111-1', correo: 'nuevo@x.invalid' } });
    expect(r.status).toBe('updated');
    const h2 = (await col('clients').doc('H2').get()).data();
    expect(h2.empresa).toBe('Historica Dos');
    expect(h2.nit).toBe('06141111111111');
  });
  test('the service never merges or deletes historical duplicates', async () => {
    await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Nueva', nit: '06141111111111' }) });
    expect(await ids()).toEqual(expect.arrayContaining(['H1', 'H2']));
    expect(await ids()).toHaveLength(2);
  });
});

describe('update', () => {
  test('claiming a NIT that belongs to another client is blocked; the index stays consistent', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'A Uno', nit: '06141234561234' }) });
    const b = await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'B Dos Totalmente Distinta', nit: '06149999999999' }) });
    const r = await svc.update({ caller: asV1, id: b.client.id, client: empresa({ empresa: 'B Dos Totalmente Distinta', nit: '0614-123456-123-4' }) });
    expect(r.status).toBe('duplicate');
    expect(r.matches[0].clientId).toBe(a.client.id);
    expect((await col('clients').doc(b.client.id).get()).data().nit).toBe('06149999999999');
  });
  test('changing the NIT releases the old key and claims the new one', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa({ nit: '06141234561234' }) });
    const r = await svc.update({ caller: asV1, id: a.client.id, client: empresa({ nit: '06149999999999' }) });
    expect(r.status).toBe('updated');
    expect(await keyDocs()).toEqual(['NIT_06149999999999']);
    const free = await svc.create({ caller: asV2, opId: opId(), client: empresa({ empresa: 'Quien Reutiliza', nit: '06141234561234' }) });
    expect(free.status).toBe('created');
  });
  test('update keeps createdBy / fecha_creacion / visibleTo even if the browser sends others', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa() });
    await col('clients').doc(a.client.id).update({ visibleTo: [V2] });
    const before = (await col('clients').doc(a.client.id).get()).data();
    const r = await svc.update({ caller: asV1, id: a.client.id, client: { ...empresa({ telefono: '7999-9999' }), createdBy: V3, visibleTo: [V3], fecha_creacion: 'x' } });
    expect(r.status).toBe('updated');
    const after = (await col('clients').doc(a.client.id).get()).data();
    expect(after.createdBy).toBe(V1);
    expect(after.visibleTo).toEqual([V2]);
    expect(after.fecha_creacion).toBe(before.fecha_creacion);
    expect(after.telefono).toBe('7999-9999');
  });
  test('a vendedor cannot edit a client that is not in its portfolio', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa() });
    await expect(svc.update({ caller: asV2, id: a.client.id, client: empresa({ empresa: 'Robado' }) })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('a vendedor can edit a client linked to an opportunity assigned to it', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa() });
    await col('prospects').doc('PA').set({ id: 'PA', createdBy: GES, vendedorId: V2, clientId: a.client.id });
    const r = await svc.update({ caller: asV2, id: a.client.id, client: empresa({ telefono: '7123-4567' }) });
    expect(r.status).toBe('updated');
  });
  test('gestor and manager can edit any client; unknown id is not-found', async () => {
    const a = await svc.create({ caller: asV1, opId: opId(), client: empresa() });
    expect((await svc.update({ caller: asGes, id: a.client.id, client: empresa({ telefono: '1' }) })).status).toBe('updated');
    expect((await svc.update({ caller: asMgr, id: a.client.id, client: empresa({ telefono: '2' }) })).status).toBe('updated');
    await expect(svc.update({ caller: asMgr, id: 'NOPE', client: empresa() })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('catalogue search (selector of new opportunities)', () => {
  async function seedCatalogue() {
    const own = await svc.create({ caller: asV1, opId: opId(), client: empresa({ empresa: 'Aceros del Pacifico', nit: '06141234561234', telefono: '7000-1111', correo: 'privado@x.invalid' }) });
    const other = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Aceros Centroamericanos', nit: '06149999999999', telefono: '7000-2222', correo: 'otro@x.invalid' }) });
    return { own: own.client.id, other: other.client.id };
  }
  test('a vendedor finds and can select a client created by another vendedor', async () => {
    const { other } = await seedCatalogue();
    const r = await svc.search({ caller: asV2, q: 'aceros centro' });
    expect(r.results.map(x => x.id)).toEqual([other]);
  });
  test('the catalogue is searched by name prefix and by document digits', async () => {
    const { own } = await seedCatalogue();
    expect((await svc.search({ caller: asV2, q: 'pacifico' })).results.map(x => x.id)).toEqual([own]);
    expect((await svc.search({ caller: asV2, q: '0614-1234' })).results.map(x => x.id)).toEqual([own]);
  });
  test('results carry only id / nombre / tipo / masked hint / inPortfolio', async () => {
    const { other } = await seedCatalogue();
    const r = await svc.search({ caller: asV2, q: 'aceros' });
    for (const x of r.results) expect(Object.keys(x).sort()).toEqual(['hint', 'id', 'inPortfolio', 'nombre', 'tipo']);
    const text = JSON.stringify(r);
    for (const secret of ['privado@x.invalid', 'otro@x.invalid', '7000-1111', '7000-2222', '06141234561234', '06149999999999', V1, V3]) expect(text).not.toContain(secret);
    expect(r.results.find(x => x.id === other).inPortfolio).toBe(false);
  });
  test('inPortfolio is true for own clients', async () => {
    const { own } = await seedCatalogue();
    const r = await svc.search({ caller: asV1, q: 'aceros' });
    expect(r.results.find(x => x.id === own).inPortfolio).toBe(true);
  });
  test('too-short queries return nothing (no catalogue dump)', async () => {
    await seedCatalogue();
    expect(await svc.search({ caller: asV2, q: 'a' })).toMatchObject({ results: [], tooShort: true });
    expect(await svc.search({ caller: asV2, q: '' })).toMatchObject({ results: [], tooShort: true });
    expect(await svc.search({ caller: asV2, q: '061' })).toMatchObject({ results: [], tooShort: true });
  });
  test('the result list is capped', async () => {
    for (let i = 0; i < 30; i++) await col('clients').doc('B' + i).set({ id: 'B' + i, tipo: 'juridica', empresa: 'Bulk Cliente ' + i, createdBy: V3 });
    const r = await svc.search({ caller: asV2, q: 'bulk', limit: 1000 });
    expect(r.results.length).toBeLessThanOrEqual(50);
    const r2 = await svc.search({ caller: asV2, q: 'bulk' });
    expect(r2.results).toHaveLength(20);
    expect(r2.truncated).toBe(true);
  });
  test('gestor and manager keep their catalogue (everything is inPortfolio)', async () => {
    const { other } = await seedCatalogue();
    for (const c of [asGes, asMgr]) {
      const r = await svc.search({ caller: c, q: 'aceros centro' });
      expect(r.results.find(x => x.id === other).inPortfolio).toBe(true);
    }
  });
  test('search never changes the client (createdBy / visibleTo untouched)', async () => {
    const { other } = await seedCatalogue();
    await svc.search({ caller: asV2, q: 'aceros' });
    const d = (await col('clients').doc(other).get()).data();
    expect(d.createdBy).toBe(V3);
    expect(d.visibleTo).toBeUndefined();
  });
});

describe('visibleTo (portfolio derived from opportunities)', () => {
  test('selecting a catalogue client for an own opportunity makes it visible; the owner is unchanged', async () => {
    const c = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Cartera Ajena' }) });
    expect((await col('clients').doc(c.client.id).get()).data().visibleTo).toBeUndefined();
    const prospect = { id: 'PX1', createdBy: V2, vendedorId: V2, clientId: c.client.id };
    await col('prospects').doc('PX1').set(prospect);
    await svc.onProspectWrite(null, prospect);
    const d = (await col('clients').doc(c.client.id).get()).data();
    expect(d.visibleTo).toEqual([V2]);
    expect(d.createdBy).toBe(V3);
  });
  test('an assignment by a gestor adds the assignee and the creator of the opportunity; "sistema" is ignored', async () => {
    const c = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Asignada' }) });
    await col('prospects').doc('PX2').set({ id: 'PX2', createdBy: GES, vendedorId: V2, clientId: c.client.id });
    await col('prospects').doc('PX3').set({ id: 'PX3', createdBy: 'sistema', vendedorId: V1, clientId: c.client.id });
    await svc.recomputeVisibility([c.client.id]);
    expect((await col('clients').doc(c.client.id).get()).data().visibleTo).toEqual([V1, V2, GES].sort());
  });
  test('a reassignment moves visibility away from the previous holder and recomputes both clients', async () => {
    const c1 = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Cliente Re Uno' }) });
    const c2 = await svc.create({ caller: asV3, opId: opId(), client: empresa({ empresa: 'Cliente Re Dos Distinto' }) });
    const before = { id: 'PR', createdBy: GES, vendedorId: V1, clientId: c1.client.id };
    await col('prospects').doc('PR').set(before);
    await svc.recomputeVisibility([c1.client.id]);
    expect((await col('clients').doc(c1.client.id).get()).data().visibleTo).toEqual([V1, GES].sort());
    const after = { ...before, vendedorId: V2, clientId: c2.client.id };
    await col('prospects').doc('PR').set(after);
    await svc.onProspectWrite(before, after);
    expect((await col('clients').doc(c1.client.id).get()).data().visibleTo).toEqual([]); // no opportunity left on c1
    expect((await col('clients').doc(c2.client.id).get()).data().visibleTo).toEqual([V2, GES].sort());
  });
  test('backfill is a dry run by default and idempotent when applied; the historical owner field is never touched', async () => {
    await col('clients').doc('HB').set({ id: 'HB', tipo: 'juridica', empresa: 'Hist Backfill', createdBy: V1 });
    await col('prospects').doc('PB').set({ id: 'PB', createdBy: V1, vendedorId: V2, clientId: 'HB' });
    // When the Functions emulator is running (it is, in the isolated environment) the syncClientVisibility_local trigger reacts to the
    // write above and fills visibleTo by itself. This test models a HISTORICAL client that never went through the trigger, so wait for the
    // trigger (if any) to settle and put the client back into that historical state.
    for (let i = 0; i < 40; i++) {
      if ((await col('clients').doc('HB').get()).data().visibleTo !== undefined) { await col('clients').doc('HB').update({ visibleTo: FieldValue.delete() }); break; }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(await svc.backfillVisibility()).toEqual({ planned: 1, applied: 0 });
    expect((await col('clients').doc('HB').get()).data().visibleTo).toBeUndefined();
    expect(await svc.backfillVisibility({ apply: true })).toEqual({ planned: 1, applied: 1 });
    expect(await svc.backfillVisibility({ apply: true })).toEqual({ planned: 1, applied: 0 });
    const d = (await col('clients').doc('HB').get()).data();
    expect(d.createdBy).toBe(V1);
    expect(d.visibleTo).toEqual([V1, V2].sort());
  });
});
