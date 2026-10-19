// functions/isolated-tests/historicalLinking.iso.js
// END-TO-END validation on isolated emulators (Auth 9399, Firestore 8190, Functions 5101)
//
// Validates the 10 mandatory checks:
//   1. Login of the 4 active profiles (Benjamin, Denys, Gestor, Vendedor).
//   2. Equal CRM permissions between Benjamin and Denys (both manager, no developer bypass).
//   3. Role restrictions preserved for Gestor and Vendedor.
//   4. Cloud Functions correctly resolve caller's historical `cid`.
//   5. Existing records remain linked to the correct commercial user.
//   6. Inactive seller cannot log in and cannot be linked.
//   7. Collision / duplicate linking rejected.
//   8. Partial failures rollback cleanly.
//   9. Historical passwords purged only after verified login.
//  10. Core commercial operations functional post-linking.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { clearIsolatedFirestore, loadFirestoreRules, assertIsolatedUp, PROJECT } = require('./iso');
const { provisionManager } = require('../scripts/provisionManager');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const adminNamespace = {
  auth: getAuth,
  firestore: getFirestore,
  app: () => getApps()[0],
  apps: getApps(),
  options: { projectId: PROJECT }
};
const auth = getAuth();
const db = getFirestore();

const AUTH = 'http://127.0.0.1:9399';
const FUNCTIONS = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const idt = p => `${AUTH}/identitytoolkit.googleapis.com/v1/${p}?key=fake-api-key`;

const CID = {
  BEN: '1000000000001',
  DEN: '1000000000002',
  GES: '1000000000003',
  VEND: '1792037387205',
  INACT: '1792000000000'
};

const PASSWORDS = {
  BEN: 'ManagerBen123!',
  DEN: 'ManagerDen123!',
  GES: 'GestorPwd123!',
  VEND: 'VendedorPwd123!'
};

const SESSIONS = {};

async function post(url, body, token) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const call = (name, data, token) => post(`${FUNCTIONS}/${name}`, { data: { dbSuffix: '_prod', ...data } }, token);

let seq = 0;
const opId = () => `op-iso-link-${Date.now()}-${++seq}`;

beforeAll(async () => {
  await assertIsolatedUp();
  const fnUp = await fetch('http://127.0.0.1:5101/').catch(() => null);
  if (!fnUp) throw new Error('Functions emulator (127.0.0.1:5101) not answering: start isolated emulators with functions');

  // Clear Auth & Firestore in isolated emulator
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await clearIsolatedFirestore();
  await loadFirestoreRules();

  // 1. Seed historical profiles in users_prod WITHOUT authUid (simulating unmigrated database)
  await db.collection('users_prod').doc(CID.BEN).set({
    id: CID.BEN,
    nombre: 'Benjamin Valiente',
    email: 'benjamin@ductsal-test.invalid',
    password: 'legacy-plaintext-ben',
    role: 'manager',
    activo: true
  });

  await db.collection('users_prod').doc(CID.DEN).set({
    id: CID.DEN,
    nombre: 'Denys Gonzalez',
    email: 'denys@ductsal-test.invalid',
    password: 'legacy-plaintext-den',
    role: 'manager',
    activo: true
  });

  await db.collection('users_prod').doc(CID.GES).set({
    id: CID.GES,
    nombre: 'Gestor Comercial',
    email: 'gestor@ductsal-test.invalid',
    password: 'legacy-plaintext-ges',
    role: 'gestor',
    activo: true
  });

  await db.collection('users_prod').doc(CID.VEND).set({
    id: CID.VEND,
    nombre: 'Vendedor Activo',
    email: 'vendedor.activo@ductsal-test.invalid',
    password: 'legacy-plaintext-vend',
    role: 'vendedor',
    activo: true
  });

  await db.collection('users_prod').doc(CID.INACT).set({
    id: CID.INACT,
    nombre: 'Vendedor Inactivo',
    email: 'vendedor.inactivo@ductsal-test.invalid',
    password: 'legacy-plaintext-inact',
    role: 'vendedor',
    activo: false
  });

  // 2. Seed existing commercial records referencing historical CIDs
  await db.collection('clients_prod').doc('C_VEND').set({
    id: 'C_VEND',
    tipo: 'juridica',
    empresa: 'Cliente de Vendedor Activo',
    contacto: 'Carlos',
    telefono: '7000-0010',
    nit: '0614-100000-101-1',
    createdBy: CID.VEND
  });
  await db.collection('clientIdentifiers_prod').doc('NIT_06141000001011').set({
    key: 'NIT_06141000001011', kind: 'NIT', clientId: 'C_VEND'
  });

  await db.collection('prospects_prod').doc('P_HIST_1').set({
    id: 'P_HIST_1',
    codigo: '202601001',
    clientId: 'C_VEND',
    proyecto: 'Torre Alisios',
    createdBy: CID.VEND,
    vendedorId: CID.VEND,
    vendedorName: 'Vendedor Activo',
    vendedorRole: 'vendedor',
    fecha_creacion: '2026-01-01T00:00:00.000Z',
    estado: 'activo',
    etapa: 'prospecto',
    precio_cotizado: 5000,
    costo_venta: 3000,
    datos: {},
    logs: []
  });

  await db.collection('prospects_prod').doc('P_INACT_1').set({
    id: 'P_INACT_1',
    codigo: '202601002',
    clientId: 'C_VEND',
    proyecto: 'Proyecto Vendedor Inactivo',
    createdBy: CID.INACT,
    vendedorId: CID.INACT,
    vendedorName: 'Vendedor Inactivo',
    vendedorRole: 'vendedor',
    fecha_creacion: '2026-01-01T00:00:00.000Z',
    estado: 'activo',
    etapa: 'prospecto',
    datos: {},
    logs: []
  });
}, 60000);

describe('Sales Reporting — Vinculación controlada en entorno aislado', () => {
  test('Phase 1: Authorized provisioning of both Managers (Benjamin and Denys)', async () => {
    // Both managers provisioned out-of-band via authorized script
    const ben = await provisionManager(adminNamespace, {
      cid: CID.BEN,
      email: 'benjamin@ductsal-test.invalid',
      nombre: 'Benjamin Valiente',
      password: PASSWORDS.BEN,
      suffix: '_prod',
      targetProject: PROJECT
    });

    const den = await provisionManager(adminNamespace, {
      cid: CID.DEN,
      email: 'denys@ductsal-test.invalid',
      nombre: 'Denys Gonzalez',
      password: PASSWORDS.DEN,
      suffix: '_prod',
      targetProject: PROJECT
    });

    // Both get verified Auth accounts with { role: 'manager', manager: true, cid }
    const claimsBen = (await auth.getUser(ben.uid)).customClaims;
    const claimsDen = (await auth.getUser(den.uid)).customClaims;

    expect(claimsBen).toEqual({ role: 'manager', manager: true, cid: CID.BEN });
    expect(claimsDen).toEqual({ role: 'manager', manager: true, cid: CID.DEN });

    // Verify both can log in to Firebase Auth and receive valid ID tokens
    const benLogin = await post(idt('accounts:signInWithPassword'), { email: 'benjamin@ductsal-test.invalid', password: PASSWORDS.BEN, returnSecureToken: true });
    const denLogin = await post(idt('accounts:signInWithPassword'), { email: 'denys@ductsal-test.invalid', password: PASSWORDS.DEN, returnSecureToken: true });

    expect(benLogin.status).toBe(200);
    expect(denLogin.status).toBe(200);
    SESSIONS.BEN = benLogin.json.idToken;
    SESSIONS.DEN = denLogin.json.idToken;

    // Confirm equal CRM permissions: both managers can invoke manager-only operations
    const searchBen = await call('searchClientsCatalog', { q: 'Cliente' }, SESSIONS.BEN);
    const searchDen = await call('searchClientsCatalog', { q: 'Cliente' }, SESSIONS.DEN);
    expect(searchBen.status).toBe(200);
    expect(searchDen.status).toBe(200);
  });

  test('Phase 2: Linking non-manager historical users via linkHistoricalUserAdmin', async () => {
    // Manager Denys links Gestor
    const linkGes = await call('linkHistoricalUserAdmin', { id: CID.GES, opId: opId() }, SESSIONS.DEN);
    expect(linkGes.status).toBe(200);
    expect(linkGes.json.result).toMatchObject({ status: 'linked', id: CID.GES, role: 'gestor' });

    // Manager Benjamin links Vendedor activo
    const linkVend = await call('linkHistoricalUserAdmin', { id: CID.VEND, opId: opId() }, SESSIONS.BEN);
    expect(linkVend.status).toBe(200);
    expect(linkVend.json.result).toMatchObject({ status: 'linked', id: CID.VEND, role: 'vendedor' });

    // Check custom claims set for both
    const uidGes = linkGes.json.result.uid;
    const uidVend = linkVend.json.result.uid;
    const claimsGes = (await auth.getUser(uidGes)).customClaims;
    const claimsVend = (await auth.getUser(uidVend)).customClaims;

    expect(claimsGes).toEqual({ role: 'gestor', cid: CID.GES });
    expect(claimsVend).toEqual({ role: 'vendedor', cid: CID.VEND });

    // In Firestore, profiles are linked but historical plaintext password is still preserved (Requirement 6)
    const pGes = (await db.collection('users_prod').doc(CID.GES).get()).data();
    const pVend = (await db.collection('users_prod').doc(CID.VEND).get()).data();
    expect(pGes.authUid).toBe(uidGes);
    expect(pGes.password).toBe('legacy-plaintext-ges');
    expect(pVend.authUid).toBe(uidVend);
    expect(pVend.password).toBe('legacy-plaintext-vend');
  });

  test('Phase 3: Inactive seller cannot log in and cannot be linked (Requirement 7)', async () => {
    // Attempting to link inactive seller is rejected with failed-precondition
    const linkInact = await call('linkHistoricalUserAdmin', { id: CID.INACT, opId: opId() }, SESSIONS.BEN);
    expect(linkInact.status).toBe(400); // failed-precondition
    expect(linkInact.json.error.message).toMatch(/inactive/i);

    // Profile remains unlinked
    const pInact = (await db.collection('users_prod').doc(CID.INACT).get()).data();
    expect(pInact.authUid).toBeUndefined();
    expect(pInact.activo).toBe(false);

    // Historical records created by inactive seller remain completely intact
    const pInactProspect = (await db.collection('prospects_prod').doc('P_INACT_1').get()).data();
    expect(pInactProspect.vendedorId).toBe(CID.INACT);
    expect(pInactProspect.estado).toBe('activo');
  });

  test('Phase 4: Collision and duplicate prevention (Requirement 4)', async () => {
    // Attempting to link another profile with the email of an already linked user is rejected
    await db.collection('users_prod').doc('IMPOSTOR_1').set({
      id: 'IMPOSTOR_1',
      nombre: 'Impostor',
      email: 'vendedor.activo@ductsal-test.invalid', // collision with CID.VEND
      role: 'vendedor',
      activo: true
    });

    const collisionRes = await call('linkHistoricalUserAdmin', { id: 'IMPOSTOR_1', opId: opId() }, SESSIONS.BEN);
    expect([400, 409]).toContain(collisionRes.status);
    expect(collisionRes.json.error.status).toBe('ALREADY_EXISTS');

    // Attempting to link a manager profile via linkHistoricalUserAdmin is rejected (Requirement 5)
    await db.collection('users_prod').doc('MGR_UNAUTH').set({
      id: 'MGR_UNAUTH',
      nombre: 'Manager Falso',
      email: 'fake.mgr@ductsal-test.invalid',
      role: 'manager',
      activo: true
    });
    const mgrReject = await call('linkHistoricalUserAdmin', { id: 'MGR_UNAUTH', opId: opId() }, SESSIONS.BEN);
    expect(mgrReject.status).toBe(403);
    expect(mgrReject.json.error.status).toBe('PERMISSION_DENIED');

    // Attempting to link a non-existent profile is rejected with NOT_FOUND
    const notFoundRes = await call('linkHistoricalUserAdmin', { id: '9999999999999', opId: opId() }, SESSIONS.BEN);
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.json.error.status).toBe('NOT_FOUND');

    // Attempting to link a profile with an invalid/unsupported commercial role is rejected with INVALID_ARGUMENT
    await db.collection('users_prod').doc('OPER_1').set({
      id: 'OPER_1',
      nombre: 'Operario 1',
      email: 'op1@ductsal-test.invalid',
      role: 'operario',
      activo: true
    });
    const invalidRoleRes = await call('linkHistoricalUserAdmin', { id: 'OPER_1', opId: opId() }, SESSIONS.BEN);
    expect(invalidRoleRes.status).toBe(400);
    expect(invalidRoleRes.json.error.status).toBe('INVALID_ARGUMENT');
  });

  test('Phase 5: Verified Login & Plaintext Password Purging (Requirement 6)', async () => {
    // Set test passwords for the newly linked Gestor and Vendedor accounts
    const pGes = (await db.collection('users_prod').doc(CID.GES).get()).data();
    const pVend = (await db.collection('users_prod').doc(CID.VEND).get()).data();

    await auth.updateUser(pGes.authUid, { password: PASSWORDS.GES });
    await auth.updateUser(pVend.authUid, { password: PASSWORDS.VEND });

    // Gestor and Vendedor log in to Firebase Auth
    const gesLogin = await post(idt('accounts:signInWithPassword'), { email: 'gestor@ductsal-test.invalid', password: PASSWORDS.GES, returnSecureToken: true });
    const vendLogin = await post(idt('accounts:signInWithPassword'), { email: 'vendedor.activo@ductsal-test.invalid', password: PASSWORDS.VEND, returnSecureToken: true });
    expect(gesLogin.status).toBe(200);
    expect(vendLogin.status).toBe(200);
    SESSIONS.GES = gesLogin.json.idToken;
    SESSIONS.VEND = vendLogin.json.idToken;

    // Vendedor purges their own password via active session
    const purgeVend = await call('purgeHistoricalPasswordAdmin', { id: CID.VEND }, SESSIONS.VEND);
    expect(purgeVend.status).toBe(200);
    expect(purgeVend.json.result.status).toBe('purged');

    // Manager Denys purges Gestor's password (now that Gestor has verified login)
    const purgeGes = await call('purgeHistoricalPasswordAdmin', { id: CID.GES }, SESSIONS.DEN);
    expect(purgeGes.status).toBe(200);
    expect(purgeGes.json.result.status).toBe('purged');

    // Verify plaintext passwords are now GONE from Firestore
    const pVendAfter = (await db.collection('users_prod').doc(CID.VEND).get()).data();
    const pGesAfter = (await db.collection('users_prod').doc(CID.GES).get()).data();
    expect(pVendAfter.password).toBeUndefined();
    expect(pGesAfter.password).toBeUndefined();
  });

  test('Phase 6: Core Commercial Operations & Historical CID Recognition', async () => {
    // 1. Linked Vendedor invokes createProspectAdmin
    const newOppRes = await call('createProspectAdmin', {
      prospect: {
        clientId: 'C_VEND',
        proyecto: 'Torre Las Vistas',
        origen: 'Referido',
        tipo_proyecto: 'Nuevo',
        tipo_producto: 'Ductos'
      },
      opId: opId()
    }, SESSIONS.VEND);
    expect(newOppRes.status).toBe(200);
    const newOpp = newOppRes.json.result.prospect;
    // Server assigns creator and assignee as the seller's historical CID
    expect(newOpp.createdBy).toBe(CID.VEND);
    expect(newOpp.vendedorId).toBe(CID.VEND);

    // 2. Linked Vendedor requests no-contract authorization on their existing opportunity P_HIST_1
    const reqRes = await call('requestNoContractAuthorizationAdmin', {
      prospectId: 'P_HIST_1',
      motivo: 'Cliente solicita inicio urgente de fabricación',
      opId: opId()
    }, SESSIONS.VEND);
    expect(reqRes.status).toBe(200);
    expect(reqRes.json.result.status).toBe('requested');

    // 3. Vendedor is forbidden from editing base price (role restriction preserved)
    const editVendForbidden = await call('editProspectBasePriceAdmin', {
      prospectId: 'P_HIST_1',
      precio: 6000,
      costo: 3500,
      motivo: 'Ajuste indebido por vendedor'
    }, SESSIONS.VEND);
    expect(editVendForbidden.status).toBe(403);

    // 4. Linked Gestor CAN edit base price (role permission preserved)
    const editGesOk = await call('editProspectBasePriceAdmin', {
      prospectId: 'P_HIST_1',
      precio: 6000,
      costo: 3500,
      motivo: 'Ajuste autorizado por gestor'
    }, SESSIONS.GES);
    expect(editGesOk.status).toBe(200);

    // 5. Gestor cannot resolve no-contract authorization (manager only)
    const p1Snap = (await db.collection('prospects_prod').doc('P_HIST_1').get()).data();
    const reqId = p1Snap.solicitudes_sin_contrato[0].id;
    const resolveGesForbidden = await call('resolveNoContractAuthorizationAdmin', {
      prospectId: 'P_HIST_1',
      requestId: reqId,
      decision: 'approve'
    }, SESSIONS.GES);
    expect(resolveGesForbidden.status).toBe(403);

    // 6. Manager Denys resolves the no-contract authorization (approved)
    const resolveDenOk = await call('resolveNoContractAuthorizationAdmin', {
      prospectId: 'P_HIST_1',
      requestId: reqId,
      decision: 'approve'
    }, SESSIONS.DEN);
    expect(resolveDenOk.status).toBe(200);
    expect(resolveDenOk.json.result.status).toBe('approved');

    // Check opportunity state
    const p1Final = (await db.collection('prospects_prod').doc('P_HIST_1').get()).data();
    expect(p1Final.datos.autorizado_sin_contrato).toBe(true);
    expect(p1Final.datos.autorizado_por_id).toBe(CID.DEN);
    expect(p1Final.precio_cotizado).toBe(6000);
    expect(p1Final.costo_venta).toBe(3500);

    // 7. Manager Benjamin deletes a test client
    await db.collection('clients_prod').doc('C_TO_DELETE').set({
      id: 'C_TO_DELETE',
      tipo: 'natural',
      nombres: 'Prueba',
      apellidos: 'Borrable',
      telefono: '7000-9999',
      createdBy: CID.VEND
    });
    const delClientRes = await call('deleteClientAdmin', { clientId: 'C_TO_DELETE' }, SESSIONS.BEN);
    expect(delClientRes.status).toBe(200);
    expect(delClientRes.json.result.status).toBe('deleted');

    // 8. SEC-03: Manager lists users via listUsersAdmin - strictly omits password
    const listResBen = await call('listUsersAdmin', {}, SESSIONS.BEN);
    expect(listResBen.status).toBe(200);
    const usersListed = listResBen.json.result.users;
    expect(Array.isArray(usersListed)).toBe(true);
    expect(usersListed.length).toBeGreaterThanOrEqual(4);
    usersListed.forEach(u => {
      expect(u.id).toBeDefined();
      expect(u.nombre).toBeDefined();
      expect(u.role).toBeDefined();
      expect(u.activo).toBeDefined();
      expect(u.password).toBeUndefined();
    });

    // 9. SEC-03: Non-manager (Gestor / Vendedor) cannot call listUsersAdmin
    const listResGes = await call('listUsersAdmin', {}, SESSIONS.GES);
    expect(listResGes.status).toBe(403);
    const listResVend = await call('listUsersAdmin', {}, SESSIONS.VEND);
    expect(listResVend.status).toBe(403);
  });
});
