// functions/__tests__/clientsDocumentRemoval.unit.test.js
// UNIT layer: removing a document from a client's file through updateClientAdmin is a manager-only operation,
// enforced by the server (clientsService.update). Before this check only the UI hid the button.
// In-memory Firestore; rules / emulator layers are separate.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createClientsService } = require('../clientsService');

const fdb = createFakeFirestore({ clock: () => new Date('2026-03-15T12:00:00.000Z') });
const service = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });

const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
const OWNER = who('vendedor', 'V1');
const GES = who('gestor', 'G1');
const MGR = who('manager', 'M1');

const DUI = { name: 'dui.pdf', url: 'https://files.example/dui.pdf' };
const NIT = 'https://files.example/nit.pdf'; // historical shape: plain url string
const base = { tipo: 'juridica', empresa: 'Delta SA', contacto: 'Ana', telefono: '7000-0001' };

beforeEach(() => {
  fdb.clear();
  fdb.seed('clients_prod/C1', { id: 'C1', ...base, createdBy: 'V1', documentos: { dui: DUI, nit: NIT, escritura: 'gs://weird/not-http' } });
});
const docsNow = () => fdb.data('clients_prod/C1').documentos;

test('a vendedor cannot remove a document, in either stored shape; nothing changes', async () => {
  await expect(service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: { nit: NIT } } })).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: { dui: DUI } } })).rejects.toMatchObject({ code: 'permission-denied' });
  expect(docsNow()).toEqual({ dui: DUI, nit: NIT, escritura: 'gs://weird/not-http' });
});

test('a gestor cannot either: removal is reserved for the manager', async () => {
  await expect(service.update({ caller: GES, id: 'C1', client: { ...base, documentos: { nit: NIT } } })).rejects.toMatchObject({ code: 'permission-denied' });
  expect(docsNow().dui).toEqual(DUI);
});

test('the dry run applies the same authorization', async () => {
  await expect(service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: {} }, dryRun: true })).rejects.toMatchObject({ code: 'permission-denied' });
});

test('the manager can remove a document; the others stay', async () => {
  const r = await service.update({ caller: MGR, id: 'C1', client: { ...base, documentos: { nit: NIT } } });
  expect(r.status).toBe('updated');
  expect(docsNow()).toEqual({ nit: NIT });
});

test('an editor who keeps every document, replaces one or adds one is not blocked', async () => {
  const keep = await service.update({ caller: OWNER, id: 'C1', client: { ...base, telefono: '7000-9999', documentos: { dui: DUI, nit: NIT } } });
  expect(keep.status).toBe('updated');
  const replaced = await service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: { dui: { name: 'nuevo.pdf', url: 'https://files.example/nuevo.pdf', motivoSustitucion: 'Actualización de DUI' }, nit: NIT } } });
  expect(replaced.status).toBe('updated');
  const added = await service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: { dui: { ...DUI, motivoSustitucion: 'Restitución de DUI' }, nit: NIT, credencial: 'https://files.example/cred.pdf' } } });
  expect(added.status).toBe('updated');
  expect(Object.keys(docsNow()).sort()).toEqual(['credencial', 'dui', 'nit']);
});

test('an update that does not mention documents never removes any', async () => {
  const r = await service.update({ caller: OWNER, id: 'C1', client: { ...base, telefono: '7111-1111' } });
  expect(r.status).toBe('updated');
  expect(docsNow()).toEqual({ dui: DUI, nit: NIT, escritura: 'gs://weird/not-http' });
});

test('a stored value the sanitiser would discard anyway (not an http url) is not counted as a removal', async () => {
  const r = await service.update({ caller: OWNER, id: 'C1', client: { ...base, documentos: { dui: DUI, nit: NIT } } });
  expect(r.status).toBe('updated');
});
