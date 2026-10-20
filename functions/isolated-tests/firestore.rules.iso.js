// functions/isolated-tests/firestore.rules.iso.js
// REAL Firestore security rules (../../firestore.rules, byte for byte) evaluated by the isolated Firestore emulator.
// Not mocks: every case is an HTTP request the emulator authorises or rejects with the rules under test.
// Run: see ../ISOLATED_TESTS.md  (npx jest -c jest.isolated.config.js --runInBand)

const { fsApi, clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, ID, T, profile, seedUsers } = require('./iso');
const { MGR, GES, V1, V2, V3 } = ID;

const ok = r => r.status === 200;
const allow = (name, thunk) => test(`ALLOW ${name}`, async () => { const r = await thunk(); expect({ name, status: r.status, body: ok(r) ? '' : r.body.slice(0, 200) }).toMatchObject({ status: 200 }); });
const deny = (name, thunk) => test(`DENY  ${name}`, async () => { const r = await thunk(); expect({ name, status: r.status, body: r.status === 403 ? '' : r.body.slice(0, 200) }).toMatchObject({ status: 403 }); });

beforeAll(async () => {
  await assertIsolatedUp();
  await clearIsolatedFirestore();
  await loadFirestoreRules();
  await seedUsers();
  await fsApi.seed('userDirectory_prod', V1, { id: V1, nombre: 'V1', role: 'vendedor', activo: true });
  // C1.visibleTo mirrors what the syncClientVisibility trigger derives from P1 (V1), P2 (V2) and P3 (created by MGR): [MGR, V1, V2].
  // Seeding anything else makes the result depend on how fast the Functions emulator (if running) recomputes it.
  await fsApi.seed('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'Cliente Uno', nit: '06141234567890', createdBy: V1, visibleTo: [MGR, V1, V2] });
  await fsApi.seed('clients_prod', 'C2', { id: 'C2', empresa: 'Cliente Dos', createdBy: V3, visibleTo: [V3] });
  await fsApi.seed('clients_prod', 'CHIST', { id: 'CHIST', empresa: 'Historico sin visibleTo', createdBy: V1 });
  await fsApi.seed('clients_prod', 'CALIEN', { id: 'CALIEN', empresa: 'Ajeno', createdBy: V3 });
  await fsApi.seed('clientIdentifiers_prod', 'NIT_06141234567890', { key: 'NIT_06141234567890', clientId: 'C1' });
  await fsApi.seed('clientOps_prod', 'op-12345678', { status: 'succeeded' });
  await fsApi.seed('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V1, clientId: 'C1', estado: 'prospecto', datos: {} });
  await fsApi.seed('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V2, clientId: 'C1', estado: 'prospecto', datos: {} });
  await fsApi.seed('prospects_prod', 'P3', { id: 'P3', createdBy: MGR, vendedorId: V2, clientId: 'C1', estado: 'prospecto', datos: {} });
  await fsApi.seed('prospects_prod', 'PHIST', { id: 'PHIST', createdBy: V1, clientId: 'CHIST', estado: 'ganado', datos: {} });
  await fsApi.seed('prospects_prod', 'PV3', { id: 'PV3', createdBy: V3, vendedorId: V3, clientId: 'C2', estado: 'prospecto', datos: {} });
  await fsApi.seed('system_prod', 'settings', { visitantes: ['a'], encargados: ['b'] });
  await fsApi.seed('audit_logs_prod', 'A1', { usuario: 'x', timestamp: 't' });
  await fsApi.seed('userOps', 'op1', { status: 'succeeded' });
  await fsApi.seed('clients_local', 'X', { id: 'X' });
  await fsApi.seed('clients', 'OLD', { id: 'OLD' });
  await fsApi.seed('fabricacion_prod', 'F1', { id: 'F1', proyecto: 'p' });
  await fsApi.seed('fabricacion_tasks_prod', 'TK1', { id: 'TK1', estado: 'pendiente' });
  await fsApi.seed('proyectos_fabricacion_prod', 'PF1', { id: 'PF1', nombre: 'Proyecto' });
  await fsApi.seed('bobinas_soldadura_prod', 'B1', { id: 'B1', kg: 10 });
  await fsApi.seed('config', 'maquinas', { a: 1 });
  await fsApi.seed('config', 'estado_equipos', { m1: 'ok' });
  await fsApi.seed('alertas_maquinas', 'AL1', { id: 'AL1', estado: 'abierta' });
});

describe('A. unauthenticated / unlinked / inactive identities', () => {
  for (const [col, id] of [['users_prod', V1], ['userDirectory_prod', V1], ['clients_prod', 'C1'], ['prospects_prod', 'P1'], ['system_prod', 'settings'], ['audit_logs_prod', 'A1'], ['fabricacion_prod', 'F1'], ['config', 'maquinas']]) {
    deny(`anon get ${col}`, () => fsApi.get(col, id, T.anon));
    deny(`self-signup account without claims get ${col}`, () => fsApi.get(col, id, T.noClaims));
  }
  deny('anon list clients', () => fsApi.query('clients_prod', null, T.anon));
  deny('anon list prospects', () => fsApi.query('prospects_prod', null, T.anon));
  deny('anon list user directory', () => fsApi.query('userDirectory_prod', null, T.anon));
  deny('anon list audit logs', () => fsApi.query('audit_logs_prod', null, T.anon));
  deny('self-signup account list user directory', () => fsApi.query('userDirectory_prod', null, T.noClaims));
  deny('self-signup account list prospects', () => fsApi.query('prospects_prod', null, T.noClaims));
  deny('anon write a prospect', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V1, clientId: 'C1', datos: {} }, T.anon));
  deny('anon create a user profile', () => fsApi.create('users_prod', 'EVIL', { id: 'EVIL', role: 'manager', activo: true, authUid: 'x' }, T.anon));
  deny('self-signup create a manager profile', () => fsApi.create('users_prod', 'EVIL2', { id: 'EVIL2', role: 'manager', activo: true, authUid: 'uid-selfsignup' }, T.noClaims));
  deny('inactive profile (clients)', () => fsApi.get('clients_prod', 'C1', T.v4inactive));
  deny('stale role claim (profile says vendedor)', () => fsApi.get('clients_prod', 'C1', T.v2StaleRole));
  deny('claim cid with someone else uid', () => fsApi.get('clients_prod', 'C1', T.v2WrongUid));
  deny('spoofed manager flag on a vendedor profile writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: [] }, T.v2SpoofManager));
  deny('manager token missing manager=true writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: [] }, T.mgrNoFlag));
  deny('historical profile without authUid cannot be impersonated by a claim', () => fsApi.get('clients_prod', 'C1', require('./iso').token('uid-legacy', { role: 'vendedor', cid: 'LEGACY1' })));
});

describe('B. users (written only by Cloud Functions)', () => {
  allow('vendedor reads own profile', () => fsApi.get('users_prod', V2, T.v2));
  deny('vendedor reads other profile (passwords!)', () => fsApi.get('users_prod', V1, T.v2));
  deny('vendedor reads legacy profile with password', () => fsApi.get('users_prod', 'LEGACY1', T.v2));
  deny('vendedor lists users', () => fsApi.query('users_prod', null, T.v2));
  deny('gestor lists users', () => fsApi.query('users_prod', null, T.ges));
  allow('manager lists users', () => fsApi.query('users_prod', null, T.mgr));
  deny('manager writes users directly (Functions only)', () => fsApi.set('users_prod', V2, profile(V2, 'uid-v2', 'manager'), T.mgr));
  deny('vendedor promotes self', () => fsApi.set('users_prod', V2, profile(V2, 'uid-v2', 'manager'), T.v2));
  deny('vendedor changes own authUid', () => fsApi.set('users_prod', V2, profile(V2, 'uid-evil', 'vendedor'), T.v2));
  deny('vendedor reactivates self', () => fsApi.set('users_prod', ID.V4, profile(ID.V4, 'uid-v4', 'vendedor', true), T.v2));
  deny('vendedor deletes own profile', () => fsApi.del('users_prod', V2, T.v2));
  allow('vendedor reads the user directory', () => fsApi.get('userDirectory_prod', V1, T.v2));
  allow('vendedor lists the user directory', () => fsApi.query('userDirectory_prod', null, T.v2));
  allow('gestor reads the user directory', () => fsApi.get('userDirectory_prod', V1, T.ges));
  allow('gestor lists the user directory', () => fsApi.query('userDirectory_prod', null, T.ges));
  deny('inactive user reads the user directory', () => fsApi.get('userDirectory_prod', V1, T.v4inactive));
  deny('vendedor writes the user directory', () => fsApi.set('userDirectory_prod', V1, { id: V1 }, T.v2));
  deny('manager reads userOps (Functions only)', () => fsApi.get('userOps', 'op1', T.mgr));
});

describe('C. clients: portfolio reads, creation only through the server', () => {
  allow('V2 gets C1 through P2 (visibleTo)', () => fsApi.get('clients_prod', 'C1', T.v2));
  allow('V1 still gets C1 (creator)', () => fsApi.get('clients_prod', 'C1', T.v1));
  deny('V3 (unrelated) gets C1', () => fsApi.get('clients_prod', 'C1', T.v3));
  allow('V1 gets historical client without visibleTo (creator)', () => fsApi.get('clients_prod', 'CHIST', T.v1));
  deny('V2 gets historical client of V1', () => fsApi.get('clients_prod', 'CHIST', T.v2));
  deny('V2 gets a client created by another vendedor it is not linked to', () => fsApi.get('clients_prod', 'CALIEN', T.v2));
  deny('V2 unfiltered client list (the catalogue is NOT a direct read)', () => fsApi.query('clients_prod', null, T.v2));
  allow('V2 list createdBy==me', () => fsApi.query('clients_prod', ['createdBy', 'EQUAL', V2], T.v2));
  allow('V2 list visibleTo array-contains me', () => fsApi.query('clients_prod', ['visibleTo', 'ARRAY_CONTAINS', V2], T.v2));
  deny('V2 list createdBy==V1', () => fsApi.query('clients_prod', ['createdBy', 'EQUAL', V1], T.v2));
  deny('V2 list visibleTo array-contains V1', () => fsApi.query('clients_prod', ['visibleTo', 'ARRAY_CONTAINS', V1], T.v2));
  allow('manager unfiltered client list', () => fsApi.query('clients_prod', null, T.mgr));
  allow('gestor unfiltered client list', () => fsApi.query('clients_prod', null, T.ges));

  deny('vendedor creates a client directly (bypasses duplicate check)', () => fsApi.create('clients_prod', 'CNEW', { id: 'CNEW', empresa: 'N', createdBy: V1 }, T.v1));
  deny('vendedor creates a client owned by someone else', () => fsApi.create('clients_prod', 'CNEW2', { id: 'CNEW2', empresa: 'N', createdBy: V2 }, T.v1));
  deny('vendedor creates a client with visibleTo', () => fsApi.create('clients_prod', 'CNEW3', { id: 'CNEW3', createdBy: V1, visibleTo: [V3] }, T.v1));
  deny('gestor creates a client directly', () => fsApi.create('clients_prod', 'CNEW4', { id: 'CNEW4', empresa: 'N', createdBy: GES }, T.ges));
  deny('manager creates a client directly', () => fsApi.create('clients_prod', 'CNEW5', { id: 'CNEW5', empresa: 'N', createdBy: MGR }, T.mgr));
  deny('vendedor overwrites a NON existing id through set (create path)', () => fsApi.set('clients_prod', 'CNEW6', { id: 'CNEW6', empresa: 'N', createdBy: V1 }, T.v1));

  allow('V2 edits non-identity data of C1 (visible)', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'Editado', nit: '06141234567890', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 changes the NIT of C1 directly (index bypass)', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', nit: '06149999999999', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 removes the NIT of C1 directly', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 adds a DUI to C1 directly', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', nit: '06141234567890', dui: '012345678', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 changes the type of C1 directly', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'natural', empresa: 'x', nit: '06141234567890', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 changes C1 createdBy', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', nit: '06141234567890', createdBy: V2, visibleTo: [MGR, V1, V2] }, T.v2));
  deny('V2 adds itself to another visibleTo', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', nit: '06141234567890', createdBy: V1, visibleTo: [V1, V2, V3] }, T.v2));
  deny('V3 edits C1', () => fsApi.set('clients_prod', 'C1', { id: 'C1', tipo: 'juridica', empresa: 'x', nit: '06141234567890', createdBy: V1, visibleTo: [MGR, V1, V2] }, T.v3));
  deny('V2 edits an alien client by direct access', () => fsApi.set('clients_prod', 'CALIEN', { id: 'CALIEN', empresa: 'robado', createdBy: V2 }, T.v2));
  allow('gestor edits non-identity data of any client', () => fsApi.set('clients_prod', 'C2', { id: 'C2', empresa: 'Cliente Dos B', createdBy: V3, visibleTo: [V3] }, T.ges));
  deny('gestor changes createdBy of a client', () => fsApi.set('clients_prod', 'C2', { id: 'C2', empresa: 'Cliente Dos B', createdBy: GES, visibleTo: [V3] }, T.ges));
  deny('vendedor deletes a client', () => fsApi.del('clients_prod', 'CHIST', T.v1));
  deny('gestor deletes a client', () => fsApi.del('clients_prod', 'C2', T.ges));
  deny('manager deletes a client directly (SEC-06: must use deleteClientAdmin)', () => fsApi.del('clients_prod', 'CALIEN', T.mgr));
  deny('inactive user deletes a client directly', () => fsApi.del('clients_prod', 'C1', T.v4inactive));
  deny('anon deletes a client directly', () => fsApi.del('clients_prod', 'C1', T.anon));

  deny('vendedor reads the identifier index', () => fsApi.get('clientIdentifiers_prod', 'NIT_06141234567890', T.v1));
  deny('manager reads the identifier index (Admin SDK only)', () => fsApi.get('clientIdentifiers_prod', 'NIT_06141234567890', T.mgr));
  deny('vendedor lists the identifier index', () => fsApi.query('clientIdentifiers_prod', null, T.v1));
  deny('vendedor frees an identifier (delete)', () => fsApi.del('clientIdentifiers_prod', 'NIT_06141234567890', T.v1));
  deny('vendedor plants an identifier for a document it wants to block', () => fsApi.create('clientIdentifiers_prod', 'NIT_00000000000000', { key: 'k', clientId: 'C1' }, T.v1));
  deny('manager plants an identifier directly', () => fsApi.create('clientIdentifiers_prod', 'DUI_000000000', { key: 'k', clientId: 'C1' }, T.mgr));
  deny('vendedor reads clientOps', () => fsApi.get('clientOps_prod', 'op-12345678', T.v1));
  deny('manager writes clientOps', () => fsApi.set('clientOps_prod', 'op-12345678', { status: 'x' }, T.mgr));
});

describe('D. prospects (opportunities)', () => {
  allow('V1 reads P1', () => fsApi.get('prospects_prod', 'P1', T.v1));
  deny('V1 reads P2', () => fsApi.get('prospects_prod', 'P2', T.v1));
  allow('V2 reads P3 (created by manager, assigned to V2)', () => fsApi.get('prospects_prod', 'P3', T.v2));
  allow('V1 reads historical prospect without vendedorId (creator)', () => fsApi.get('prospects_prod', 'PHIST', T.v1));
  deny('V2 reads historical prospect of V1', () => fsApi.get('prospects_prod', 'PHIST', T.v2));
  deny('V2 unfiltered prospect list', () => fsApi.query('prospects_prod', null, T.v2));
  allow('V2 list createdBy==me', () => fsApi.query('prospects_prod', ['createdBy', 'EQUAL', V2], T.v2));
  allow('V2 list vendedorId==me', () => fsApi.query('prospects_prod', ['vendedorId', 'EQUAL', V2], T.v2));
  deny('V2 list vendedorId==V1', () => fsApi.query('prospects_prod', ['vendedorId', 'EQUAL', V1], T.v2));
  deny('gestor unfiltered prospect list (SEC-04: gestor cannot query all leads unfiltered)', () => fsApi.query('prospects_prod', null, T.ges));
  allow('gestor list createdBy==me', () => fsApi.query('prospects_prod', ['createdBy', 'EQUAL', GES], T.ges));
  allow('gestor list vendedorId==me', () => fsApi.query('prospects_prod', ['vendedorId', 'EQUAL', GES], T.ges));
  allow('manager lists all prospects', () => fsApi.query('prospects_prod', null, T.mgr));

  // SEC-04: Direct updates to prospects_prod are completely forbidden by rules
  deny('V2 updates own P2 (stage) directly (SEC-04: must use advanceProspectStageAdmin)', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V2, clientId: 'C1', estado: 'cotizacion', datos: {} }, T.v2));
  deny('V1 updates historical PHIST without vendedorId directly', () => fsApi.set('prospects_prod', 'PHIST', { id: 'PHIST', createdBy: V1, clientId: 'CHIST', estado: 'ganado', datos: { x: 1 } }, T.v1));
  deny('V1 updates P2 directly', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V2, clientId: 'C1', estado: 'perdido', datos: {} }, T.v1));
  deny('V2 reassigns own P2 to V3 directly (SEC-04: must use reassignProspectAdmin)', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V3, clientId: 'C1', estado: 'cotizacion', datos: {} }, T.v2));
  deny('V2 changes createdBy of P2 directly', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V3, vendedorId: V2, clientId: 'C1', estado: 'cotizacion', datos: {} }, T.v2));
  deny('V2 repoints P2 clientId directly', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V2, clientId: 'C2', estado: 'cotizacion', datos: {} }, T.v2));
  deny('V2 self-authorises no-contract directly', () => fsApi.set('prospects_prod', 'P2', { id: 'P2', createdBy: V2, vendedorId: V2, clientId: 'C1', estado: 'cotizacion', datos: { autorizado_sin_contrato: true, autorizado_por: 'x' } }, T.v2));
  deny('gestor authorises no-contract directly', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V1, clientId: 'C1', estado: 'prospecto', datos: { autorizado_sin_contrato: true } }, T.ges));
  deny('manager authorises no-contract directly (SEC-04: must use setNoContractAuthorizationAdmin)', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V1, clientId: 'C1', estado: 'prospecto', datos: { autorizado_sin_contrato: true, autorizado_por: 'G' } }, T.mgr));
  deny('gestor reassigns P1 to V3 directly (SEC-04: must use reassignProspectAdmin)', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V3, clientId: 'C1', estado: 'prospecto', datos: { autorizado_sin_contrato: true, autorizado_por: 'G' } }, T.ges));
  deny('gestor changes createdBy', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: GES, vendedorId: V3, clientId: 'C1', datos: { autorizado_sin_contrato: true, autorizado_por: 'G' } }, T.ges));
  deny('inactive user updates a prospect directly', () => fsApi.set('prospects_prod', 'P1', { id: 'P1', createdBy: V1, vendedorId: V1, clientId: 'C1', datos: {} }, T.v4inactive));

  // Verify that an opportunity assigned via server SDK can be read by the assignee and is denied to reassigned creator (H-01 remediation)
  test('assigned opportunity can be read by assignee (V3) and is denied to reassigned creator (V1) (H-01)', async () => {
    await fsApi.seed('prospects_prod', 'P_ASSIGNED', { id: 'P_ASSIGNED', createdBy: V1, vendedorId: V3, clientId: 'C1', estado: 'prospecto', datos: {} });
    expect((await fsApi.get('prospects_prod', 'P_ASSIGNED', T.v3)).status).toBe(200);
    expect((await fsApi.get('prospects_prod', 'P_ASSIGNED', T.v1)).status).toBe(403);
  });

  // Catalogue: ANY existing client can be chosen, even one the vendedor cannot read. Choosing never touches the client.
  allow('V2 creates own opportunity on a client created by another vendedor and NOT in its portfolio (C2)', () => fsApi.create('prospects_prod', 'PCAT', { id: 'PCAT', createdBy: V2, vendedorId: V2, clientId: 'C2', datos: {} }, T.v2));
  allow('V2 creates own opportunity on a visible client', () => fsApi.create('prospects_prod', 'PNEW', { id: 'PNEW', createdBy: V2, vendedorId: V2, clientId: 'C1', datos: {} }, T.v2));
  deny('V2 assigns a new opportunity to V1', () => fsApi.create('prospects_prod', 'PNEW2', { id: 'PNEW2', createdBy: V2, vendedorId: V1, clientId: 'C1', datos: {} }, T.v2));
  deny('V2 creates an opportunity as V1', () => fsApi.create('prospects_prod', 'PNEW3', { id: 'PNEW3', createdBy: V1, vendedorId: V1, clientId: 'C1', datos: {} }, T.v2));
  deny('V2 creates an opportunity for a missing client (no client is created implicitly)', () => fsApi.create('prospects_prod', 'PNEW4', { id: 'PNEW4', createdBy: V2, vendedorId: V2, clientId: 'NOPE', datos: {} }, T.v2));
  deny('V2 creates an opportunity with self-authorised no-contract', () => fsApi.create('prospects_prod', 'PNEW6', { id: 'PNEW6', createdBy: V2, vendedorId: V2, clientId: 'C1', datos: { autorizado_sin_contrato: true } }, T.v2));
  allow('gestor creates an opportunity assigned to V2', () => fsApi.create('prospects_prod', 'PNEW5', { id: 'PNEW5', createdBy: GES, vendedorId: V2, clientId: 'C1', datos: {} }, T.ges));
  deny('vendedor deletes a prospect', () => fsApi.del('prospects_prod', 'PNEW', T.v2));
  deny('gestor deletes a prospect', () => fsApi.del('prospects_prod', 'PNEW5', T.ges));
  deny('manager deletes a prospect directly (SEC-04/06: must use deleteProspectAdmin)', () => fsApi.del('prospects_prod', 'PNEW', T.mgr));
  deny('inactive user deletes a prospect directly', () => fsApi.del('prospects_prod', 'P1', T.v4inactive));
  deny('anon deletes a prospect directly', () => fsApi.del('prospects_prod', 'P1', T.anon));
  test('choosing a catalogue client left the client untouched (createdBy)', async () => {
    const r = await fsApi.get('clients_prod', 'C2', T.mgr);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).fields.createdBy.stringValue).toBe(V3);
  });
});

describe('E. settings, audit, defaults', () => {
  allow('vendedor reads settings', () => fsApi.get('system_prod', 'settings', T.v1));
  deny('vendedor writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: [] }, T.v1));
  deny('gestor writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: [] }, T.ges));
  allow('manager writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: ['a'], encargados: ['b'] }, T.mgr));
  allow('jefe de produccion writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: ['a'], encargados: ['b'] }, T.jefe));
  deny('operario writes settings', () => fsApi.set('system_prod', 'settings', { visitantes: [] }, T.oper));
  allow('vendedor appends an audit log', () => fsApi.create('audit_logs_prod', 'A2', { usuario: 'v1', timestamp: 't' }, T.v1));
  deny('vendedor reads audit logs', () => fsApi.get('audit_logs_prod', 'A1', T.v1));
  allow('manager reads audit logs', () => fsApi.get('audit_logs_prod', 'A1', T.mgr));
  allow('manager lists audit logs ordered/limited', () => fsApi.query('audit_logs_prod', null, T.mgr, { orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }], limit: 20 }));
  deny('nobody edits audit logs', () => fsApi.set('audit_logs_prod', 'A1', { usuario: 'x' }, T.mgr));
  deny('nobody deletes audit logs', () => fsApi.del('audit_logs_prod', 'A1', T.mgr));
  deny('manager touches *_local collections', () => fsApi.get('clients_local', 'X', T.mgr));
  deny('manager touches un-suffixed legacy collections', () => fsApi.get('clients', 'OLD', T.mgr));
  deny('manager writes an unknown collection', () => fsApi.set('coleccion_nueva', 'a', { a: 1 }, T.mgr));
});

describe('F. fabricacion + tablets (role-level design)', () => {
  // operario = tablet operator
  allow('operario reads fabrication tasks', () => fsApi.get('fabricacion_tasks_prod', 'TK1', T.oper));
  allow('operario advances a task', () => fsApi.set('fabricacion_tasks_prod', 'TK1', { id: 'TK1', estado: 'en_proceso' }, T.oper));
  deny('operario creates a task', () => fsApi.create('fabricacion_tasks_prod', 'TK2', { id: 'TK2' }, T.oper));
  deny('operario deletes a task', () => fsApi.del('fabricacion_tasks_prod', 'TK1', T.oper));
  allow('jefe creates a task', () => fsApi.create('fabricacion_tasks_prod', 'TK3', { id: 'TK3' }, T.jefe));
  allow('operario reads the projects of fabrication', () => fsApi.get('proyectos_fabricacion_prod', 'PF1', T.oper));
  deny('operario writes the projects of fabrication', () => fsApi.set('proyectos_fabricacion_prod', 'PF1', { id: 'PF1', nombre: 'x' }, T.oper));
  allow('jefe writes the projects of fabrication', () => fsApi.set('proyectos_fabricacion_prod', 'PF1', { id: 'PF1', nombre: 'y' }, T.jefe));
  allow('operario reads/writes welding coils', () => fsApi.set('bobinas_soldadura_prod', 'B1', { id: 'B1', kg: 9 }, T.oper));
  deny('recepcion writes welding coils', () => fsApi.set('bobinas_soldadura_prod', 'B1', { id: 'B1', kg: 1 }, T.recep));
  allow('recepcion creates a fabrication record', () => fsApi.create('fabricacion_prod', 'F2', { id: 'F2' }, T.recep));
  allow('dibujante updates a fabrication record', () => fsApi.set('fabricacion_prod', 'F1', { id: 'F1', proyecto: 'z' }, T.dibu));
  deny('operario updates a fabrication record', () => fsApi.set('fabricacion_prod', 'F1', { id: 'F1', proyecto: 'z' }, T.oper));
  deny('operario deletes a fabrication record', () => fsApi.del('fabricacion_prod', 'F1', T.oper));
  allow('operario reports machine status from the tablet', () => fsApi.set('config', 'estado_equipos', { m1: 'paro' }, T.oper));
  deny('operario edits machine configuration', () => fsApi.set('config', 'maquinas', { a: 2 }, T.oper));
  allow('jefe edits machine configuration', () => fsApi.set('config', 'maquinas', { a: 3 }, T.jefe));
  allow('operario raises a machine alert', () => fsApi.create('alertas_maquinas', 'AL2', { id: 'AL2' }, T.oper));
  deny('operario closes a machine alert', () => fsApi.set('alertas_maquinas', 'AL1', { id: 'AL1', estado: 'cerrada' }, T.oper));
  allow('jefe closes a machine alert', () => fsApi.set('alertas_maquinas', 'AL1', { id: 'AL1', estado: 'cerrada' }, T.jefe));
  deny('nobody deletes machine alerts', () => fsApi.del('alertas_maquinas', 'AL1', T.jefe));

  // plant roles must not see commercial data
  deny('operario reads a client', () => fsApi.get('clients_prod', 'C1', T.oper));
  deny('operario lists clients', () => fsApi.query('clients_prod', null, T.oper));
  deny('jefe reads a prospect', () => fsApi.get('prospects_prod', 'P2', T.jefe));
  deny('operario reads user profiles', () => fsApi.get('users_prod', V1, T.oper));
  allow('operario reads own profile', () => fsApi.get('users_prod', ID.OPER, T.oper));
  deny('operario creates a prospect', () => fsApi.create('prospects_prod', 'PX', { id: 'PX', createdBy: ID.OPER, vendedorId: ID.OPER, clientId: 'C1', datos: {} }, T.oper));
  // sales roles vs fabrication (current design: vendedor has NO access; a human must decide if sellers need to see the status)
  deny('vendedor reads fabrication projects (design decision pending)', () => fsApi.get('proyectos_fabricacion_prod', 'PF1', T.v1));
});

describe('G. fabricacion: unauthenticated, inactive, spoofed', () => {
  deny('anon reads tasks', () => fsApi.get('fabricacion_tasks_prod', 'TK1', T.anon));
  deny('anon writes machine status', () => fsApi.set('config', 'estado_equipos', { m1: 'x' }, T.anon));
  deny('anon creates a machine alert', () => fsApi.create('alertas_maquinas', 'AL9', { id: 'AL9' }, T.anon));
  deny('inactive operario reads tasks', () => fsApi.get('fabricacion_tasks_prod', 'TK1', T.operInactive));
  deny('inactive operario writes machine status', () => fsApi.set('config', 'estado_equipos', { m1: 'x' }, T.operInactive));
  deny('vendedor profile claiming a plant role', () => fsApi.get('fabricacion_tasks_prod', 'TK1', T.operSpoofPlant));
  deny('self-signup account without claims writes machine status', () => fsApi.set('config', 'estado_equipos', { m1: 'x' }, T.noClaims));
  deny('vendedor writes a task', () => fsApi.set('fabricacion_tasks_prod', 'TK1', { id: 'TK1', estado: 'x' }, T.v1));
  deny('gestor writes machine configuration', () => fsApi.set('config', 'maquinas', { a: 9 }, T.ges));
  deny('vendedor reads the welding coils', () => fsApi.get('bobinas_soldadura_prod', 'B1', T.v1));
});
