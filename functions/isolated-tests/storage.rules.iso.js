// functions/isolated-tests/storage.rules.iso.js
// REAL Cloud Storage rules (../../storage.rules, byte for byte) evaluated by the isolated Storage emulator, which
// reads the session profile and prospect ownership from the isolated Firestore emulator (cross-service rules).
// Run: see ../ISOLATED_TESTS.md

const { fsApi, stApi, clearIsolatedFirestore, clearIsolatedStorage, assertIsolatedUp, ID, T, seedUsers, token } = require('./iso');
const { V1, V2, V3 } = ID;

const allow = (name, thunk) => test(`ALLOW ${name}`, async () => { const r = await thunk(); expect({ name, status: r.status, body: r.status === 200 ? '' : r.body.slice(0, 200) }).toMatchObject({ status: 200 }); });
const deny = (name, thunk) => test(`DENY  ${name}`, async () => { const r = await thunk(); expect({ name, status: r.status, body: r.status === 403 ? '' : r.body.slice(0, 200) }).toMatchObject({ status: 403 }); });

const PS1 = 'prod_files/prospects/PS1/proyectos';
const SEEDED = `${PS1}/seeded.pdf`;

beforeAll(async () => {
  await assertIsolatedUp();
  await clearIsolatedFirestore();
  await clearIsolatedStorage();
  await seedUsers();
  await fsApi.seed('prospects_prod', 'PS1', { id: 'PS1', createdBy: V1, vendedorId: V1, clientId: 'C1', datos: {} });
  await fsApi.seed('prospects_prod', 'PS2', { id: 'PS2', createdBy: ID.MGR, vendedorId: V2, clientId: 'C1', datos: {} });
  await fsApi.seed('clients_prod', 'C1', {
    id: 'C1',
    tipo: 'empresa',
    empresa: 'Empresa Test',
    createdBy: V1,
    visibleTo: [V1, V2],
    closingVendors: []
  });
  await fsApi.seed('client_reservations_prod', 'RES1', {
    reservationId: 'RES1',
    createdBy: V1,
    authUid: 'uid-v1',
    status: 'reserved',
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000)
  });
  await fsApi.seed('client_reservations_prod', 'RES_EXP', {
    reservationId: 'RES_EXP',
    createdBy: V1,
    authUid: 'uid-v1',
    status: 'reserved',
    expiresAtMs: Date.now() - 60 * 1000,
    expiresAt: new Date(Date.now() - 60 * 1000)
  });
  await fsApi.seed('client_reservations_prod', 'RES_CANC', {
    reservationId: 'RES_CANC',
    createdBy: V1,
    authUid: 'uid-v1',
    status: 'cancelled',
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000)
  });
  // Real tablet profiles without authUid (mimicking real plantLogin / users_prod state)
  await fsApi.seed('users_prod', '1800000000010', { id: '1800000000010', nombre: 'Operario Taller Real', role: 'operario', activo: true, pin: '1234', password: '5678' });
  await fsApi.seed('users_prod', '1800000000011', { id: '1800000000011', nombre: 'Operario Inactivo', role: 'operario', activo: false, pin: '2222', password: '3333' });
  await fsApi.seed('users_prod', '1800000000012', { id: '1800000000012', nombre: 'Jefe Produccion Tablet', role: 'jefe_produccion', activo: true, pin: '9999', password: '8888' });
  await fsApi.seed('users_prod', '1800000000013', { id: '1800000000013', nombre: 'Vendedor Spoof Plant', role: 'vendedor', activo: true, pin: '7777', password: '8888' });
  const s = await stApi.seed(SEEDED);
  if (s.status !== 200) throw new Error('storage seed failed: ' + s.status + ' ' + s.body.slice(0, 200));
  await stApi.seed('prod_files/clients/' + V1 + '/dui-seed.pdf');
  await stApi.seed('prod_files/clients/C1/identificacion/dui.pdf');
  await stApi.seed('prod_files/clients/C1/legal/escritura.pdf');
  await stApi.seed('prod_files/proyectos/legacy.pdf');
  await stApi.seed('prod_files/requerimientos/req-seed.pdf');
  await stApi.seed('prod_files/fabricacion_archivos/fab-seed.pdf');
  await stApi.seed('local_files/proyectos/legacy.pdf');
});

describe('Storage: unauthenticated / unlinked / inactive', () => {
  deny('anon reads a prospect file', () => stApi.download(SEEDED, T.anon));
  deny('anon uploads a prospect file', () => stApi.upload(`${PS1}/anon.pdf`, T.anon));
  deny('anon deletes a file', () => stApi.del(SEEDED, T.anon));
  deny('anon lists a folder', () => stApi.list('prod_files/', T.anon));
  deny('self-signup (no claims) reads', () => stApi.download(SEEDED, T.noClaims));
  deny('self-signup (no claims) uploads', () => stApi.upload(`${PS1}/signup.pdf`, T.noClaims));
  deny('inactive vendedor reads', () => stApi.download(SEEDED, T.v4inactive));
  deny('inactive operario uploads a requirement', () => stApi.upload('prod_files/requerimientos/inactive.pdf', T.operInactive));
  deny('stale role claim reads', () => stApi.download(SEEDED, T.v2StaleRole));
  deny('claim with someone else uid reads', () => stApi.download(SEEDED, T.v2WrongUid));
  deny('vendedor claiming a plant role uploads a requirement', () => stApi.upload('prod_files/requerimientos/spoof.pdf', T.operSpoofPlant));
});

describe('Storage: opportunity / project files', () => {
  allow('owner reads', () => stApi.download(SEEDED, T.v1));
  deny('unrelated vendedor reads', () => stApi.download(SEEDED, T.v3));
  allow('gestor reads', () => stApi.download(SEEDED, T.ges));
  allow('manager reads', () => stApi.download(SEEDED, T.mgr));
  deny('plant operator reads commercial files', () => stApi.download(SEEDED, T.oper));
  allow('assigned vendedor (not creator) reads PS2 file after upload by gestor', async () => {
    const up = await stApi.upload('prod_files/prospects/PS2/facturas/inv.pdf', T.ges);
    if (up.status !== 200) return up;
    return stApi.download('prod_files/prospects/PS2/facturas/inv.pdf', T.v2);
  });
  allow('owner uploads a new file', () => stApi.upload(`${PS1}/new-owner.pdf`, T.v1));
  deny('unrelated vendedor uploads into someone else opportunity', () => stApi.upload(`${PS1}/intruso.pdf`, T.v3));
  allow('gestor uploads', () => stApi.upload(`${PS1}/by-gestor.pdf`, T.ges));
  deny('owner overwrites an existing file', () => stApi.upload(SEEDED, T.v1, { content: 'overwritten' }));
  deny('manager overwrites an existing file', () => stApi.upload(SEEDED, T.mgr, { content: 'overwritten' }));
  deny('owner deletes a file', () => stApi.del(SEEDED, T.v1));
  deny('manager deletes a file', () => stApi.del(SEEDED, T.mgr));
  deny('owner lists the folder', () => stApi.list(PS1 + '/', T.v1));
  deny('manager lists the bucket', () => stApi.list('prod_files/', T.mgr));
  deny('upload into an unknown folder of the opportunity', () => stApi.upload('prod_files/prospects/PS1/otra/x.pdf', T.v1));
  deny('upload for a prospect that does not exist', () => stApi.upload('prod_files/prospects/NOPE/proyectos/x.pdf', T.v1));
  deny('upload of active content (html)', () => stApi.upload(`${PS1}/x.html`, T.v1, { contentType: 'text/html' }));
  deny('upload of active content (svg)', () => stApi.upload(`${PS1}/x.svg`, T.v1, { contentType: 'image/svg+xml' }));
  allow('upload of project file between 20 MB and 100 MB (e.g. 50 MB)', () => stApi.upload(`${PS1}/plano-50mb.dwg`, T.v1, { size: 50 * 1024 * 1024 }));
  deny('upload of project file exceeding 100 MB (e.g. 105 MB)', () => stApi.upload(`${PS1}/too-big.dwg`, T.v1, { size: 105 * 1024 * 1024 }));
  deny('upload exceeding 10 MB in restricted pagos folder (e.g. 15 MB)', () => stApi.upload('prod_files/prospects/PS1/pagos/abono-15mb.pdf', T.v1, { size: 15 * 1024 * 1024 }));
  deny('upload exceeding 15 MB in facturas folder (e.g. 20 MB)', () => stApi.upload('prod_files/prospects/PS1/facturas/fac-20mb.pdf', T.v1, { size: 20 * 1024 * 1024 }));
  deny('unauthorized vendedor cannot upload large project file to someone else opportunity', () => stApi.upload(`${PS1}/plano-intruso.dwg`, T.v3, { size: 50 * 1024 * 1024 }));
  deny('anonymous user cannot upload large project file', () => stApi.upload(`${PS1}/plano-anon.dwg`, T.anon, { size: 50 * 1024 * 1024 }));
  allow('upload of an ordinary image', () => stApi.upload(`${PS1}/foto.png`, T.v1, { contentType: 'image/png' }));
});

describe('Storage: client expediente files (identification & legacy)', () => {
  allow('owner uploads into own legacy client folder', () => stApi.upload(`prod_files/clients/${V1}/dui-1.pdf`, T.v1));
  deny('vendedor uploads into another seller legacy client folder', () => stApi.upload(`prod_files/clients/${V2}/dui-1.pdf`, T.v1));
  allow('owner reads own legacy client file', () => stApi.download(`prod_files/clients/${V1}/dui-seed.pdf`, T.v1));
  deny('another vendedor reads legacy client file', () => stApi.download(`prod_files/clients/${V1}/dui-seed.pdf`, T.v2));
  allow('gestor reads legacy client file', () => stApi.download(`prod_files/clients/${V1}/dui-seed.pdf`, T.ges));
  deny('owner overwrites legacy client file', () => stApi.upload(`prod_files/clients/${V1}/dui-seed.pdf`, T.v1, { content: 'x2' }));
  deny('owner deletes legacy client file', () => stApi.del(`prod_files/clients/${V1}/dui-seed.pdf`, T.v1));
  deny('plant operator reads legacy client file', () => stApi.download(`prod_files/clients/${V1}/dui-seed.pdf`, T.oper));

  // Hierarchical identification (DUI)
  allow('client creator reads identification/DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.v1));
  allow('associated vendedor (in visibleTo, initial stage) reads DUI from start of opportunity', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.v2));
  allow('gestor reads client identification/DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.ges));
  allow('manager reads client identification/DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.mgr));
  deny('unrelated vendedor (not in visibleTo) reads DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.v3));
  deny('plant operator reads client identification/DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T.oper));
  deny('client creator overwrites identification/DUI', () => stApi.upload('prod_files/clients/C1/identificacion/dui.pdf', T.v1, { content: 'over' }));
  deny('client creator deletes identification/DUI', () => stApi.del('prod_files/clients/C1/identificacion/dui.pdf', T.v1));
  deny('manager deletes identification/DUI directly from browser', () => stApi.del('prod_files/clients/C1/identificacion/dui.pdf', T.mgr));
});

describe('Storage: client sensitive legal files by stage & closingVendors', () => {
  // Before closing stage: V2 is in visibleTo, but NOT in closingVendors
  allow('client creator reads sensitive legal docs', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v1));
  allow('gestor reads sensitive legal docs', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.ges));
  allow('manager reads sensitive legal docs', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.mgr));
  deny('associated vendedor DENIED sensitive legal docs before cierre', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v2));
  deny('unrelated vendedor DENIED sensitive legal docs', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v3));
  deny('plant operator DENIED sensitive legal docs', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.oper));
  deny('associated vendedor DENIED legal upload before cierre', () => stApi.upload('prod_files/clients/C1/legal/nuevo-doc.pdf', T.v2));

  // Stage transition to cierre: V2 added to closingVendors
  test('entering cierre grants legal access and allows first-time upload', async () => {
    await fsApi.set('clients_prod', 'C1', {
      id: 'C1',
      tipo: 'empresa',
      empresa: 'Empresa Test',
      createdBy: V1,
      visibleTo: [V1, V2],
      closingVendors: [V2]
    }, 'owner');

    // Read granted in cierre
    const r1 = await stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v2);
    expect(r1.status).toBe(200);

    // Upload first-time legal document allowed in cierre
    const up = await stApi.upload('prod_files/clients/C1/legal/balance-cierre.pdf', T.v2);
    expect(up.status).toBe(200);

    // Read back uploaded document
    const r2 = await stApi.download('prod_files/clients/C1/legal/balance-cierre.pdf', T.v2);
    expect(r2.status).toBe(200);

    // Write-once: overwriting uploaded document is denied
    const over = await stApi.upload('prod_files/clients/C1/legal/balance-cierre.pdf', T.v2, { content: 'mod' });
    expect(over.status).toBe(403);

    // Deleting legal document from browser is denied
    const del = await stApi.del('prod_files/clients/C1/legal/balance-cierre.pdf', T.v2);
    expect(del.status).toBe(403);
  });

  // Leaving cierre: V2 removed from closingVendors (lost, cancelled, or stage rollback)
  test('leaving cierre revokes legal access immediately', async () => {
    await fsApi.set('clients_prod', 'C1', {
      id: 'C1',
      tipo: 'empresa',
      empresa: 'Empresa Test',
      createdBy: V1,
      visibleTo: [V1, V2],
      closingVendors: []
    }, 'owner');

    // Read revoked after leaving cierre
    const r1 = await stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v2);
    expect(r1.status).toBe(403);

    // Upload revoked after leaving cierre
    const up = await stApi.upload('prod_files/clients/C1/legal/otro-intento.pdf', T.v2);
    expect(up.status).toBe(403);

    // Creator and managers still have access
    const rc = await stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.v1);
    expect(rc.status).toBe(200);
    const rm = await stApi.download('prod_files/clients/C1/legal/escritura.pdf', T.mgr);
    expect(rm.status).toBe(200);
  });
});

describe('Storage: client reservation upload authorization', () => {
  allow('active reservation holder uploads identification file', () => stApi.upload('prod_files/clients/RES1/identificacion/dui-res.pdf', T.v1));
  allow('active reservation holder uploads legal file', () => stApi.upload('prod_files/clients/RES1/legal/escritura-res.pdf', T.v1));
  allow('active reservation holder reads back uploaded file', async () => {
    return stApi.download('prod_files/clients/RES1/identificacion/dui-res.pdf', T.v1);
  });
  deny('another vendedor cannot upload to someone else reservation (impersonation prevented)', () => stApi.upload('prod_files/clients/RES1/identificacion/intruder.pdf', T.v2));
  deny('upload with expired reservation is denied', () => stApi.upload('prod_files/clients/RES_EXP/identificacion/exp.pdf', T.v1));
  deny('upload with cancelled reservation is denied', () => stApi.upload('prod_files/clients/RES_CANC/identificacion/canc.pdf', T.v1));
  deny('upload to non-existent client or reservation is denied', () => stApi.upload('prod_files/clients/INEXISTENTE/identificacion/none.pdf', T.v1));
});

describe('Storage: fabricacion / tablets and flat CRM transitional paths', () => {
  // Historical CRM flat path transitional reads
  allow('vendedor reads historical CRM flat file', () => stApi.download('prod_files/proyectos/legacy.pdf', T.v1));
  allow('gestor reads historical CRM flat file', () => stApi.download('prod_files/proyectos/legacy.pdf', T.ges));
  allow('manager reads historical CRM flat file', () => stApi.download('prod_files/proyectos/legacy.pdf', T.mgr));

  // No new flat CRM uploads allowed
  deny('vendedor cannot upload new flat file into proyectos', () => stApi.upload('prod_files/proyectos/new-flat.pdf', T.v1));
  deny('manager cannot upload new flat file into proyectos', () => stApi.upload('prod_files/proyectos/new-flat.pdf', T.mgr));
  deny('vendedor cannot upload into flat clients folder', () => stApi.upload('prod_files/clientes/new-flat.pdf', T.v1));

  // Plant operations
  allow('operario uploads a requirement file', () => stApi.upload('prod_files/requerimientos/ok.pdf', T.oper));
  allow('operario uploads large requirement file up to 100 MB (e.g. 50 MB)', () => stApi.upload('prod_files/requerimientos/plano-planta-50mb.dwg', T.oper, { size: 50 * 1024 * 1024 }));
  deny('operario uploads requirement file exceeding 100 MB (e.g. 105 MB)', () => stApi.upload('prod_files/requerimientos/plano-planta-105mb.dwg', T.oper, { size: 105 * 1024 * 1024 }));
  allow('operario reads a requirement file', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T.oper));
  allow('recepcion uploads a fabrication file', () => stApi.upload('prod_files/fabricacion_archivos/ok.pdf', T.recep));
  allow('gestor reads a requirement file', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T.ges));
  deny('vendedor reads a requirement file', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T.v1));
  deny('vendedor uploads a requirement file', () => stApi.upload('prod_files/requerimientos/v.pdf', T.v1));
  deny('operario overwrites a requirement file', () => stApi.upload('prod_files/requerimientos/req-seed.pdf', T.oper, { content: 'x' }));
  deny('operario deletes a requirement file', () => stApi.del('prod_files/requerimientos/req-seed.pdf', T.oper));
  deny('operario uploads into an unknown flat folder', () => stApi.upload('prod_files/otra/x.pdf', T.oper));
  deny('operario uploads html', () => stApi.upload('prod_files/requerimientos/x.html', T.oper, { contentType: 'text/html' }));
  deny('manager reads local_files (not a production path)', () => stApi.download('local_files/proyectos/legacy.pdf', T.mgr));
  deny('manager uploads outside prod_files', () => stApi.upload('otra_raiz/x.pdf', T.mgr));
  deny('manager uploads to bucket root', () => stApi.upload('x.pdf', T.mgr));
});

describe('Storage: real fabrication tablet sessions (plantLogin tokens, no authUid in profile)', () => {
  const T_TABLET = {
    validOperario: token('plant_1800000000010', { plant: true, role: 'operario', cid: '1800000000010' }),
    validJefe: token('plant_1800000000012', { plant: true, role: 'jefe_produccion', cid: '1800000000012' }),
    noPlantClaim: token('plant_1800000000010', { role: 'operario', cid: '1800000000010' }),
    mismatchUid: token('plant_intruder', { plant: true, role: 'operario', cid: '1800000000010' }),
    noPlantPrefixUid: token('1800000000010', { plant: true, role: 'operario', cid: '1800000000010' }),
    inactiveProfile: token('plant_1800000000011', { plant: true, role: 'operario', cid: '1800000000011' }),
    nonexistentProfile: token('plant_9999999999999', { plant: true, role: 'operario', cid: '9999999999999' }),
    disallowedRole: token('plant_1800000000010', { plant: true, role: 'vendedor', cid: '1800000000010' }),
    spoofedRole: token('plant_1800000000010', { plant: true, role: 'jefe_produccion', cid: '1800000000010' }),
    spoofedCrmUser: token('plant_1800000000013', { plant: true, role: 'operario', cid: '1800000000013' }),
    impersonateCid: token('plant_1800000000015', { plant: true, role: 'operario', cid: '1800000000010' })
  };

  // 1. Token legítimo y perfil activo: acceso a rutas autorizadas
  allow('legitimate tablet operario reads requirement file', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T_TABLET.validOperario));
  allow('legitimate tablet operario reads fabrication file', () => stApi.download('prod_files/fabricacion_archivos/fab-seed.pdf', T_TABLET.validOperario));
  allow('legitimate tablet operario uploads new requirement file', () => stApi.upload('prod_files/requerimientos/tablet-req.pdf', T_TABLET.validOperario));
  allow('legitimate tablet operario uploads new fabrication file', () => stApi.upload('prod_files/fabricacion_archivos/tablet-fab.pdf', T_TABLET.validOperario));
  allow('legitimate tablet jefe uploads up to 100 MB requirement file (50 MB)', () => stApi.upload('prod_files/requerimientos/tablet-50mb.dwg', T_TABLET.validJefe, { size: 50 * 1024 * 1024 }));

  // 2. Denegación de acceso a rutas comerciales y no autorizadas
  deny('tablet operario cannot read commercial prospect file', () => stApi.download(SEEDED, T_TABLET.validOperario));
  deny('tablet operario cannot read client identification DUI', () => stApi.download('prod_files/clients/C1/identificacion/dui.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot read client sensitive legal file', () => stApi.download('prod_files/clients/C1/legal/escritura.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot upload to client folders', () => stApi.upload('prod_files/clients/C1/identificacion/intruder.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot upload to opportunity folders', () => stApi.upload(`${PS1}/intruder.pdf`, T_TABLET.validOperario));
  deny('tablet operario cannot upload outside prod_files', () => stApi.upload('local_files/requerimientos/x.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot upload into unknown flat folder', () => stApi.upload('prod_files/desconocida/x.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot upload to bucket root', () => stApi.upload('x.pdf', T_TABLET.validOperario));

  // 3. Token sin claim plant
  deny('tablet token missing plant claim is denied upload', () => stApi.upload('prod_files/requerimientos/no-plant.pdf', T_TABLET.noPlantClaim));
  deny('tablet token missing plant claim is denied download', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T_TABLET.noPlantClaim));

  // 4. UID y cid inconsistentes
  deny('tablet token with uid mismatching cid is denied upload', () => stApi.upload('prod_files/requerimientos/mismatch.pdf', T_TABLET.mismatchUid));
  deny('tablet token with uid mismatching cid is denied download', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T_TABLET.mismatchUid));
  deny('tablet token without plant_ prefix in uid is denied', () => stApi.upload('prod_files/requerimientos/no-prefix.pdf', T_TABLET.noPlantPrefixUid));

  // 5. Perfil inexistente o inactivo
  deny('tablet token with inactive profile in users_prod is denied', () => stApi.upload('prod_files/requerimientos/inactive.pdf', T_TABLET.inactiveProfile));
  deny('tablet token with nonexistent profile in users_prod is denied', () => stApi.upload('prod_files/requerimientos/nonexistent.pdf', T_TABLET.nonexistentProfile));

  // 6. Rol no permitido o inconsistente
  deny('tablet token claiming disallowed role (vendedor) is denied', () => stApi.upload('prod_files/requerimientos/disallowed.pdf', T_TABLET.disallowedRole));
  deny('tablet token with spoofed role inconsistent with profile is denied', () => stApi.upload('prod_files/requerimientos/spoofed.pdf', T_TABLET.spoofedRole));
  deny('tablet token for CRM user profile spoofing plant role is denied', () => stApi.upload('prod_files/requerimientos/spoofed-crm.pdf', T_TABLET.spoofedCrmUser));

  // 7. Intento de suplantar cid de otro operador
  deny('tablet token attempting cid impersonation of another user is denied', () => stApi.upload('prod_files/requerimientos/impersonate.pdf', T_TABLET.impersonateCid));

  // 8. Protecciones H-01 y H-05 preservadas para tabletas
  deny('tablet operario cannot overwrite existing fabrication file (write-once)', () => stApi.upload('prod_files/fabricacion_archivos/fab-seed.pdf', T_TABLET.validOperario, { content: 'mod' }));
  deny('tablet operario cannot delete fabrication file', () => stApi.del('prod_files/fabricacion_archivos/fab-seed.pdf', T_TABLET.validOperario));
  deny('tablet operario cannot list bucket prefix', () => stApi.list('prod_files/requerimientos/', T_TABLET.validOperario));
  deny('tablet operario cannot upload file exceeding 100 MB (105 MB)', () => stApi.upload('prod_files/requerimientos/too-big.dwg', T_TABLET.validOperario, { size: 105 * 1024 * 1024 }));
  deny('tablet operario cannot upload active content (html)', () => stApi.upload('prod_files/requerimientos/bad.html', T_TABLET.validOperario, { contentType: 'text/html' }));
  deny('tablet operario cannot upload active content (svg)', () => stApi.upload('prod_files/requerimientos/bad.svg', T_TABLET.validOperario, { contentType: 'image/svg+xml' }));

  // 9. Usuarios autenticados del CRM conservan sus permisos y no obtienen acceso a rutas de planta
  deny('authenticated CRM vendedor cannot upload to requerimientos', () => stApi.upload('prod_files/requerimientos/vendedor-intruder.pdf', T.v1));
  deny('authenticated CRM vendedor cannot upload to fabricacion_archivos', () => stApi.upload('prod_files/fabricacion_archivos/vendedor-intruder.pdf', T.v1));
  deny('authenticated CRM vendedor cannot read requerimientos', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T.v1));
  deny('authenticated CRM vendedor cannot read fabricacion_archivos', () => stApi.download('prod_files/fabricacion_archivos/fab-seed.pdf', T.v1));
  allow('authenticated CRM manager retains privileged read to requerimientos', () => stApi.download('prod_files/requerimientos/req-seed.pdf', T.mgr));
  allow('authenticated CRM manager retains privileged read to fabricacion_archivos', () => stApi.download('prod_files/fabricacion_archivos/fab-seed.pdf', T.mgr));
});
