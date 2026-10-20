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
  await fsApi.seed('prospects_prod', 'PS_COLAB', { id: 'PS_COLAB', createdBy: ID.GES, vendedorId: V2, clientId: 'C1', datos: {} });
  await fsApi.seed('prospects_prod', 'PS_GES_OWN', { id: 'PS_GES_OWN', createdBy: ID.GES, vendedorId: ID.GES, clientId: 'C1', datos: {} });
  await fsApi.seed('prospects_prod', 'PS_POST', { id: 'PS_POST', createdBy: V1, vendedorId: V1, clientId: 'C1', postcierre_habilitado: true, datos: {}, facturas: [{ id: 'FAC1' }] });
  await fsApi.seed('prospects_prod', 'PS_REASSIGNED', { id: 'PS_REASSIGNED', createdBy: V1, vendedorId: V2, clientId: 'C1', datos: {} });
  await fsApi.seed('prospects_prod', 'PS_HIST_NOCB', { id: 'PS_HIST_NOCB', vendedorId: V1, clientId: 'C1', datos: {} });
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
  await stApi.seed('prod_files/prospects/PS_COLAB/proyectos/propuesta-seed.pdf');
  await stApi.seed('prod_files/prospects/PS_POST/facturas/fac-seed.pdf');
  await stApi.seed('prod_files/clients/' + V1 + '/dui-seed.pdf');
  await stApi.seed('prod_files/clients/C1/identificacion/dui.pdf');
  await stApi.seed('prod_files/clients/C1/legal/escritura.pdf');
  await stApi.seed('prod_files/proyectos/legacy.pdf');
  await stApi.seed('prod_files/requerimientos/req-seed.pdf');
  await stApi.seed('prod_files/fabricacion_archivos/fab-seed.pdf');
  await stApi.seed('prod_files/prospects/PS_HIST_NOCB/proyectos/propuesta-seed.pdf');
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
  // A. Operaciones en oportunidad ordinaria abierta (PS1 asignada a V1)
  allow('owner reads', () => stApi.download(SEEDED, T.v1));
  deny('unrelated vendedor reads', () => stApi.download(SEEDED, T.v3));
  deny('gestor cannot read another seller open lead (horizontal isolation)', () => stApi.download(SEEDED, T.ges));
  allow('manager reads', () => stApi.download(SEEDED, T.mgr));
  deny('plant operator reads commercial files', () => stApi.download(SEEDED, T.oper));
  allow('owner uploads a new project file', () => stApi.upload(`${PS1}/new-owner.pdf`, T.v1));
  allow('owner uploads downpayment invoice file', () => stApi.upload('prod_files/prospects/PS1/facturas/anticipo.pdf', T.v1));
  deny('vendedor cannot upload payments (postclosing only)', () => stApi.upload('prod_files/prospects/PS1/pagos/pago.pdf', T.v1));
  deny('vendedor cannot upload change orders (postclosing only)', () => stApi.upload('prod_files/prospects/PS1/ordenes_cambio/oc.pdf', T.v1));
  deny('unrelated vendedor uploads into someone else opportunity', () => stApi.upload(`${PS1}/intruso.pdf`, T.v3));
  deny('gestor cannot upload into another seller open lead (horizontal isolation)', () => stApi.upload(`${PS1}/by-gestor.pdf`, T.ges));
  allow('manager uploads into any opportunity folder', () => stApi.upload(`${PS1}/by-mgr.pdf`, T.mgr));

  // B. Colaboración comercial: Gestora crea oportunidad y asigna vendedor operativo (PS_COLAB)
  allow('gestor creator reads proposal file in collaborative lead', () => stApi.download('prod_files/prospects/PS_COLAB/proyectos/propuesta-seed.pdf', T.ges));
  allow('assigned vendedor reads proposal file in collaborative lead', () => stApi.download('prod_files/prospects/PS_COLAB/proyectos/propuesta-seed.pdf', T.v2));
  deny('unrelated vendedor cannot read collaborative lead', () => stApi.download('prod_files/prospects/PS_COLAB/proyectos/propuesta-seed.pdf', T.v1));
  allow('gestor creator uploads quote/costs proposal in collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/proyectos/cotiz-alejandra.pdf', T.ges));
  allow('gestor creator uploads downpayment invoice in collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/facturas/ccf-anticipo.pdf', T.ges));
  deny('gestor creator cannot upload payments before closing', () => stApi.upload('prod_files/prospects/PS_COLAB/pagos/abono-anticipado.pdf', T.ges));
  deny('gestor creator cannot upload change orders before closing', () => stApi.upload('prod_files/prospects/PS_COLAB/ordenes_cambio/oc-previa.pdf', T.ges));
  allow('assigned vendedor uploads project file in collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/proyectos/levantamiento-v2.pdf', T.v2));
  deny('assigned vendedor cannot upload payments', () => stApi.upload('prod_files/prospects/PS_COLAB/pagos/abono.pdf', T.v2));
  deny('unrelated vendedor cannot upload to collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/proyectos/intruso.pdf', T.v1));

  // C. Oportunidad directa de Gestora (PS_GES_OWN: gestora como vendedor y creador)
  allow('gestor uploads project file to own managed lead', () => stApi.upload('prod_files/prospects/PS_GES_OWN/proyectos/oferta-propia.pdf', T.ges));
  deny('vendedor cannot upload to gestor lead', () => stApi.upload('prod_files/prospects/PS_GES_OWN/proyectos/intruso.pdf', T.v1));

  // D. Proyectos cerrados y operaciones postcierre (PS_POST en Proyectos y Cobros)
  allow('gestor reads postclosing invoice', () => stApi.download('prod_files/prospects/PS_POST/facturas/fac-seed.pdf', T.ges));
  allow('gestor uploads postclosing invoice', () => stApi.upload('prod_files/prospects/PS_POST/facturas/fac-avance.pdf', T.ges));
  allow('gestor uploads postclosing payment receipt', () => stApi.upload('prod_files/prospects/PS_POST/pagos/comprobante-pago.pdf', T.ges));
  allow('gestor uploads postclosing change order', () => stApi.upload('prod_files/prospects/PS_POST/ordenes_cambio/orden-1.pdf', T.ges));
  deny('gestor cannot upload proposals to closed project', () => stApi.upload('prod_files/prospects/PS_POST/proyectos/oferta-post.pdf', T.ges));
  deny('vendedor who closed project CANNOT upload payments in postclosing', () => stApi.upload('prod_files/prospects/PS_POST/pagos/pago-vendedor.pdf', T.v1));
  deny('vendedor who closed project CANNOT upload change orders in postclosing', () => stApi.upload('prod_files/prospects/PS_POST/ordenes_cambio/oc-vendedor.pdf', T.v1));
  deny('vendedor who closed project CANNOT upload invoices in postclosing', () => stApi.upload('prod_files/prospects/PS_POST/facturas/fac-vendedor.pdf', T.v1));
  deny('vendedor who closed project CANNOT upload proposals after closing', () => stApi.upload('prod_files/prospects/PS_POST/proyectos/prop-post.pdf', T.v1));

  // E. Aislamiento tras reasignación (PS_REASSIGNED: creada por V1, reasignada a V2)
  allow('new assigned vendedor uploads to reassigned lead', () => stApi.upload('prod_files/prospects/PS_REASSIGNED/proyectos/nuevo-vendedor.pdf', T.v2));
  deny('previous vendedor CANNOT upload after reassignment (H-01/H-02)', () => stApi.upload('prod_files/prospects/PS_REASSIGNED/proyectos/ex-vendedor.pdf', T.v1));
  deny('previous vendedor CANNOT read after reassignment (H-01/H-02)', () => stApi.download('prod_files/prospects/PS_REASSIGNED/proyectos/nuevo-vendedor.pdf', T.v1));

  // F. Restricciones de integridad, sobrescritura, borrado, tipos y tamaños
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
  deny('upload exceeding 10 MB in restricted pagos folder (e.g. 15 MB) by gestor in postclosing', () => stApi.upload('prod_files/prospects/PS_POST/pagos/abono-15mb.pdf', T.ges, { size: 15 * 1024 * 1024 }));
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

describe('Storage: document, CAD, Revit and engineering format policy (INC-UPLOAD-ALEJANDRA)', () => {
  // 1. PDF
  allow('owner uploads PDF proposal', () => stApi.upload(`${PS1}/propuesta-v1.pdf`, T.v1, { contentType: 'application/pdf' }));
  allow('gestor uploads PDF in collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/proyectos/propuesta-ale.pdf', T.ges, { contentType: 'application/pdf' }));

  // 2. Excel (.xlsx, .xls, .xlsm)
  allow('owner uploads modern Excel spreadsheet (.xlsx)', () => stApi.upload(`${PS1}/cuadro-costos.xlsx`, T.v1, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));
  allow('gestor creator uploads Excel (.xlsx) in collaborative lead', () => stApi.upload('prod_files/prospects/PS_COLAB/proyectos/cuadro-costos-ale.xlsx', T.ges, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));
  allow('owner uploads legacy Excel spreadsheet (.xls)', () => stApi.upload(`${PS1}/presupuesto-antiguo.xls`, T.v1, {
    contentType: 'application/vnd.ms-excel'
  }));
  allow('owner uploads macro-enabled Excel spreadsheet (.xlsm)', () => stApi.upload(`${PS1}/calculo-ductos.xlsm`, T.v1, {
    contentType: 'application/vnd.ms-excel.sheet.macroEnabled.12'
  }));

  // 3. Word (.docx, .doc)
  allow('owner uploads modern Word document (.docx)', () => stApi.upload(`${PS1}/especificaciones.docx`, T.v1, {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }));
  allow('owner uploads legacy Word document (.doc)', () => stApi.upload(`${PS1}/contrato-base.doc`, T.v1, {
    contentType: 'application/msword'
  }));

  // 4. CAD (.dwg, .dxf)
  allow('owner uploads AutoCAD DWG with image/vnd.dwg', () => stApi.upload(`${PS1}/plano-piso1.dwg`, T.v1, {
    contentType: 'image/vnd.dwg'
  }));
  allow('owner uploads AutoCAD DWG with application/octet-stream', () => stApi.upload(`${PS1}/plano-ductos.dwg`, T.v1, {
    contentType: 'application/octet-stream'
  }));
  allow('owner uploads AutoCAD DXF with image/vnd.dxf', () => stApi.upload(`${PS1}/corte-seccion.dxf`, T.v1, {
    contentType: 'image/vnd.dxf'
  }));
  allow('owner uploads AutoCAD DXF with application/octet-stream', () => stApi.upload(`${PS1}/corte-seccion2.dxf`, T.v1, {
    contentType: 'application/octet-stream'
  }));
  allow('plant operario uploads DWG drawing to requerimientos', () => stApi.upload('prod_files/requerimientos/taller-ducto.dwg', T.oper, {
    contentType: 'application/octet-stream'
  }));

  // 5. Autodesk Revit (.rvt, .rfa, .rte, .rft)
  allow('owner uploads Revit project model (.rvt)', () => stApi.upload(`${PS1}/edificio-bim.rvt`, T.v1, {
    contentType: 'application/vnd.autodesk.revit'
  }));
  allow('owner uploads Revit project model (.rvt) with octet-stream', () => stApi.upload(`${PS1}/edificio-bim2.rvt`, T.v1, {
    contentType: 'application/octet-stream'
  }));
  allow('owner uploads Revit family (.rfa)', () => stApi.upload(`${PS1}/difusor-aire.rfa`, T.v1, {
    contentType: 'application/vnd.autodesk.revit'
  }));
  allow('owner uploads Revit template (.rte)', () => stApi.upload(`${PS1}/plantilla-ductsal.rte`, T.v1, {
    contentType: 'application/octet-stream'
  }));
  allow('owner uploads Revit family template (.rft)', () => stApi.upload(`${PS1}/plantilla-familia.rft`, T.v1, {
    contentType: 'application/octet-stream'
  }));

  // 6. Formatos de imagen (.jpg, .jpeg, .png, .webp, .gif, .tif, .tiff)
  allow('owner uploads JPEG image', () => stApi.upload(`${PS1}/sitio-obra.jpg`, T.v1, { contentType: 'image/jpeg' }));
  allow('owner uploads PNG screenshot', () => stApi.upload(`${PS1}/levantamiento.png`, T.v1, { contentType: 'image/png' }));
  allow('owner uploads WebP photo', () => stApi.upload(`${PS1}/fachada.webp`, T.v1, { contentType: 'image/webp' }));
  allow('owner uploads GIF animation/diagram', () => stApi.upload(`${PS1}/flujo-aire.gif`, T.v1, { contentType: 'image/gif' }));
  allow('owner uploads TIFF scanned drawing', () => stApi.upload(`${PS1}/escaneo-original.tif`, T.v1, { contentType: 'image/tiff' }));
  allow('owner uploads compressed ZIP package of drawings', () => stApi.upload(`${PS1}/paquete-planos.zip`, T.v1, {
    contentType: 'application/zip'
  }));

  // 7. Rechazo estricto de ejecutables, scripts y contenido activo peligroso
  deny('DENY executable (.exe) even claiming application/pdf', () => stApi.upload(`${PS1}/malware.exe`, T.v1, { contentType: 'application/pdf' }));
  deny('DENY executable (.exe) with application/octet-stream', () => stApi.upload(`${PS1}/trojan.exe`, T.v1, { contentType: 'application/octet-stream' }));
  deny('DENY double extension executable (.pdf.exe)', () => stApi.upload(`${PS1}/cotizacion.pdf.exe`, T.v1, { contentType: 'application/pdf' }));
  deny('DENY shell script (.sh)', () => stApi.upload(`${PS1}/exploit.sh`, T.v1, { contentType: 'application/x-sh' }));
  deny('DENY PHP script (.php)', () => stApi.upload(`${PS1}/backdoor.php`, T.v1, { contentType: 'application/x-httpd-php' }));
  deny('DENY Windows batch file (.bat)', () => stApi.upload(`${PS1}/run.bat`, T.v1, { contentType: 'application/octet-stream' }));
  deny('DENY Windows command file (.cmd)', () => stApi.upload(`${PS1}/run.cmd`, T.v1, { contentType: 'application/octet-stream' }));
  deny('DENY JavaScript file (.js)', () => stApi.upload(`${PS1}/payload.js`, T.v1, { contentType: 'application/javascript' }));
  deny('DENY HTML file (.html)', () => stApi.upload(`${PS1}/phishing.html`, T.v1, { contentType: 'text/html' }));
  deny('DENY SVG file (.svg)', () => stApi.upload(`${PS1}/vector-xss.svg`, T.v1, { contentType: 'image/svg+xml' }));
  deny('DENY standalone XML (.xml)', () => stApi.upload(`${PS1}/data.xml`, T.v1, { contentType: 'text/xml' }));
  deny('DENY application/xml', () => stApi.upload(`${PS1}/config.xml`, T.v1, { contentType: 'application/xml' }));

  // 8. Incoherencias de carpeta y restricciones por ámbito
  deny('DENY CAD drawing (.dwg) in client identification/DUI folder', () => stApi.upload('prod_files/clients/C1/identificacion/plano.dwg', T.v1, { contentType: 'application/octet-stream' }));
  deny('DENY Revit model (.rvt) in client identification/DUI folder', () => stApi.upload('prod_files/clients/C1/identificacion/modelo.rvt', T.v1, { contentType: 'application/octet-stream' }));
  deny('DENY CAD drawing (.dwg) in pagos folder', () => stApi.upload('prod_files/prospects/PS_POST/pagos/plano.dwg', T.ges, { contentType: 'application/octet-stream' }));
  deny('DENY ZIP package in pagos folder', () => stApi.upload('prod_files/prospects/PS_POST/pagos/abono.zip', T.ges, { contentType: 'application/zip' }));
  allow('ALLOW invoice spreadsheet (.xlsx) in facturas folder', () => stApi.upload('prod_files/prospects/PS_POST/facturas/detalle-factura.xlsx', T.ges, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));

  // 9. Preservación del aislamiento horizontal comercial
  deny('unrelated vendedor cannot upload CAD file into someone else lead', () => stApi.upload(`${PS1}/plano-intruso.dwg`, T.v3, { contentType: 'application/octet-stream' }));
  deny('unrelated vendedor cannot upload Excel into someone else lead', () => stApi.upload(`${PS1}/costos-intruso.xlsx`, T.v3, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));
  deny('gestor cannot upload CAD into unassigned open lead', () => stApi.upload(`${PS1}/plano-gestor.dwg`, T.ges, { contentType: 'application/octet-stream' }));

  // 10. Expedientes históricos sin campo createdBy (resiliencia CEL)
  allow('vendedor reads historical prospect without createdBy', () => stApi.download('prod_files/prospects/PS_HIST_NOCB/proyectos/propuesta-seed.pdf', T.v1));
  allow('vendedor uploads PDF to historical prospect without createdBy', () => stApi.upload('prod_files/prospects/PS_HIST_NOCB/proyectos/oferta-nocb.pdf', T.v1, { contentType: 'application/pdf' }));
  allow('vendedor uploads Excel to historical prospect without createdBy', () => stApi.upload('prod_files/prospects/PS_HIST_NOCB/proyectos/costos-nocb.xlsx', T.v1, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));
  deny('unrelated vendedor cannot read historical lead without createdBy', () => stApi.download('prod_files/prospects/PS_HIST_NOCB/proyectos/propuesta-seed.pdf', T.v2));
  deny('unrelated gestor cannot read historical open lead without createdBy', () => stApi.download('prod_files/prospects/PS_HIST_NOCB/proyectos/propuesta-seed.pdf', T.ges));
  deny('unrelated gestor cannot upload to historical open lead without createdBy', () => stApi.upload('prod_files/prospects/PS_HIST_NOCB/proyectos/up-gestor.pdf', T.ges));
  deny('unrelated vendedor cannot upload to historical open lead without createdBy', () => stApi.upload('prod_files/prospects/PS_HIST_NOCB/proyectos/up-v2.pdf', T.v2));

  // 11. Límites de tamaño segmentados por carpeta (pruebas de frontera: límite exacto vs excedido)
  // - proyectos: límite 100 MiB (104,857,600 bytes)
  allow('proyectos allows file at exact 100 MiB limit', () => stApi.upload(`${PS1}/limit-100mb.dwg`, T.v1, { size: 100 * 1024 * 1024 }));
  deny('proyectos denies file exceeding 100 MiB by 1 KiB', () => stApi.upload(`${PS1}/limit-100mb-plus.dwg`, T.v1, { size: 100 * 1024 * 1024 + 1024 }));
  // - ordenes_cambio: límite 35 MiB (36,700,160 bytes)
  allow('ordenes_cambio allows file at exact 35 MiB limit', () => stApi.upload('prod_files/prospects/PS_POST/ordenes_cambio/limit-35mb.pdf', T.ges, { size: 35 * 1024 * 1024 }));
  deny('ordenes_cambio denies file exceeding 35 MiB by 1 KiB', () => stApi.upload('prod_files/prospects/PS_POST/ordenes_cambio/limit-35mb-plus.pdf', T.ges, { size: 35 * 1024 * 1024 + 1024 }));
  // - legal: límite 25 MiB (26,214,400 bytes)
  allow('legal folder allows file at exact 25 MiB limit', () => stApi.upload('prod_files/clients/C1/legal/limit-25mb.pdf', T.v1, { size: 25 * 1024 * 1024 }));
  deny('legal folder denies file exceeding 25 MiB by 1 KiB', () => stApi.upload('prod_files/clients/C1/legal/limit-25mb-plus.pdf', T.v1, { size: 25 * 1024 * 1024 + 1024 }));
  // - facturas: límite 15 MiB (15,728,640 bytes)
  allow('facturas allows file at exact 15 MiB limit', () => stApi.upload('prod_files/prospects/PS1/facturas/limit-15mb.pdf', T.v1, { size: 15 * 1024 * 1024 }));
  deny('facturas denies file exceeding 15 MiB by 1 KiB', () => stApi.upload('prod_files/prospects/PS1/facturas/limit-15mb-plus.pdf', T.v1, { size: 15 * 1024 * 1024 + 1024 }));
  // - clientes (directo): límite 15 MiB (15,728,640 bytes)
  allow('clientes direct folder allows file at exact 15 MiB limit', () => stApi.upload(`prod_files/clients/${V1}/limit-15mb.pdf`, T.v1, { size: 15 * 1024 * 1024 }));
  deny('clientes direct folder denies file exceeding 15 MiB by 1 KiB', () => stApi.upload(`prod_files/clients/${V1}/limit-15mb-plus.pdf`, T.v1, { size: 15 * 1024 * 1024 + 1024 }));
  // - identificacion: límite 10 MiB (10,485,760 bytes)
  allow('identificacion allows file at exact 10 MiB limit', () => stApi.upload('prod_files/clients/C1/identificacion/limit-10mb.pdf', T.v1, { size: 10 * 1024 * 1024 }));
  deny('identificacion denies file exceeding 10 MiB by 1 KiB', () => stApi.upload('prod_files/clients/C1/identificacion/limit-10mb-plus.pdf', T.v1, { size: 10 * 1024 * 1024 + 1024 }));
  // - pagos: límite 10 MiB (10,485,760 bytes)
  allow('pagos allows file at exact 10 MiB limit', () => stApi.upload('prod_files/prospects/PS_POST/pagos/limit-10mb.pdf', T.ges, { size: 10 * 1024 * 1024 }));
  deny('pagos denies file exceeding 10 MiB by 1 KiB', () => stApi.upload('prod_files/prospects/PS_POST/pagos/limit-10mb-plus.pdf', T.ges, { size: 10 * 1024 * 1024 + 1024 }));
});

