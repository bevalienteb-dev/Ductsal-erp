// functions/__tests__/contactsService.unit.test.js
// Unit tests for Person & Account Contacts module (Phase 2, Block 1).
// Validates:
// 1. Person creation without DUI/NIT, person updates, search.
// 2. Linking person to account, deterministic relation ID (`AC_${accountId}_${contactId}`).
// 3. Subcollection `periods_prod` lifecycle: creation, closing on deactivation, opening on reactivation.
// 4. Verification that at most 1 period is open at any time and historical periods are never overwritten.
// 5. Portfolio authorization (vendedor restricted to visible accounts, manager/gestor privileged).
// 6. Transactional integrity and error handling.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createContactsService,
  ServiceError
} = require('../contactsService');
const {
  createContactAdmin,
  updateContactAdmin,
  getContactAdmin,
  searchContactsAdmin,
  linkContactToAccountAdmin,
  updateAccountContactAdmin,
  deactivateAccountContactAdmin,
  reactivateAccountContactAdmin,
  listAccountContactsAdmin,
  listContactPeriodsAdmin
} = require('../index');

const state = admin.__state;
const FieldValue = admin.firestore.FieldValue;

const MGR = '1792037387201';
const GES = '1792037387202';
const V1 = '1792037387205';
const V2 = '1792037387206';

const ctx = (uid, token = {}) => ({ auth: { uid, token } });

function seedUsers() {
  state.docs[`users_prod/${MGR}`] = { id: MGR, authUid: 'uid-mgr', role: 'manager', activo: true, nombre: 'Gerente General' };
  state.docs[`users_prod/${GES}`] = { id: GES, authUid: 'uid-ges', role: 'gestor', activo: true, nombre: 'Gestor Comercial' };
  state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-v1', role: 'vendedor', activo: true, nombre: 'Vendedor Uno' };
  state.docs[`users_prod/${V2}`] = { id: V2, authUid: 'uid-v2', role: 'vendedor', activo: true, nombre: 'Vendedor Dos' };
}

function seedClients() {
  state.docs['clients_prod/C1'] = {
    id: 'C1',
    tipo: 'juridica',
    empresa: 'Constructora Delta SA de CV',
    contacto: 'Contacto Legado',
    telefono: '2200-1111',
    createdBy: V1,
    visibleTo: [V1]
  };
  state.docs['clients_prod/C2'] = {
    id: 'C2',
    tipo: 'juridica',
    empresa: 'Industrias Omega SA de CV',
    contacto: 'Contacto Omega',
    telefono: '2200-2222',
    createdBy: V2,
    visibleTo: [V2]
  };
}

describe('Contacts Service — Unit Tests (Phase 2 Block 1)', () => {
  let svc;

  beforeEach(() => {
    state.docs = {};
    state.hooks = {};
    seedUsers();
    seedClients();
    svc = createContactsService({
      db: admin.firestore(),
      FieldValue,
      suffix: '_prod'
    });
  });

  // ===========================================================================
  // 1. Person Identity (`contacts_prod`)
  // ===========================================================================
  describe('Person Identity (contacts_prod)', () => {
    test('creates person without DUI or NIT requirement', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const res = await svc.createContact({
        caller,
        contact: {
          nombres: 'Carlos Roberto',
          apellidos: 'Mendoza',
          telefono: '7000-1111',
          correo: 'carlos.mendoza@gmail.com'
        }
      });

      expect(res.status).toBe('created');
      expect(res.contact.id).toMatch(/^CT_/);
      expect(res.contact.nombres).toBe('Carlos Roberto');
      expect(res.contact.apellidos).toBe('Mendoza');
      expect(res.contact.telefono).toBe('7000-1111');
      expect(res.contact.correo).toBe('carlos.mendoza@gmail.com');
      expect(res.contact.createdBy).toBe(V1);
      expect(res.contact.fecha_creacion).toBeDefined();

      // Verify persisted in Firestore
      const stored = state.docs[`contacts_prod/${res.contact.id}`];
      expect(stored).toBeDefined();
      expect(stored.nombres).toBe('Carlos Roberto');
    });

    test('validates required fields: rejects missing nombres or apellidos', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      await expect(svc.createContact({ caller, contact: { apellidos: 'Gómez' } }))
        .rejects.toThrow('Los nombres es obligatorio');
      await expect(svc.createContact({ caller, contact: { nombres: 'Ana' } }))
        .rejects.toThrow('Los apellidos es obligatorio');
    });

    test('validates email format if provided', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      await expect(svc.createContact({
        caller,
        contact: { nombres: 'Ana', apellidos: 'López', correo: 'invalid-email' }
      })).rejects.toThrow('El correo electrónico no tiene un formato válido');
    });

    test('updates person details', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const created = await svc.createContact({
        caller,
        contact: { nombres: 'Roberto', apellidos: 'Pérez', telefono: '7111-2222' }
      });

      const updated = await svc.updateContact({
        caller,
        contactId: created.contact.id,
        contact: { telefono: '7999-8888', correo: 'roberto.perez@empresa.com' }
      });

      expect(updated.status).toBe('updated');
      expect(updated.contact.telefono).toBe('7999-8888');
      expect(updated.contact.correo).toBe('roberto.perez@empresa.com');
      expect(updated.contact.updatedBy).toBe(V1);
    });

    test('searches contacts by name, email or phone', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      await svc.createContact({ caller, contact: { nombres: 'Guillermo', apellidos: 'Del Toro', correo: 'memo@cinema.com' } });
      await svc.createContact({ caller, contact: { nombres: 'Guillermo', apellidos: 'Navarro', telefono: '7888-0000' } });
      await svc.createContact({ caller, contact: { nombres: 'María', apellidos: 'Salazar', correo: 'maria@test.com' } });

      const resName = await svc.searchContacts({ caller, q: 'Guillermo' });
      expect(resName.results.length).toBe(2);

      const resEmail = await svc.searchContacts({ caller, q: 'memo@cinema.com' });
      expect(resEmail.results.length).toBe(1);
      expect(resEmail.results[0].apellidos).toBe('Del Toro');

      const resPhone = await svc.searchContacts({ caller, q: '78880000' });
      expect(resPhone.results.length).toBe(1);
      expect(resPhone.results[0].apellidos).toBe('Navarro');
    });

    test('searchContacts isolates contacts by commercial portfolio and prevents unauthorized discovery', async () => {
      const callerV1 = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const callerV2 = { uid: 'uid-v2', cid: V2, role: 'vendedor', name: 'Vendedor Dos' };
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };

      // V2 creates a contact and links to C2 (exclusive to V2's portfolio)
      const resV2 = await svc.createContact({
        caller: callerV2,
        contact: {
          nombres: 'Esteban',
          apellidos: 'Banderas',
          correo: 'esteban.banderas@omega.com',
          telefono: '7999-5555'
        }
      });
      const contactV2 = resV2.contact;
      await svc.linkContactToAccount({
        caller: callerV2,
        accountId: 'C2',
        contactId: contactV2.id,
        cargo: 'Gerente de Logística'
      });

      // V1 searches using various search tactics (name, partial, email, phone, case variations, spaces)
      const tactics = [
        'Esteban',
        'Banderas',
        'esteban',
        'ESTEBAN',
        '  esteban  ',
        'banderas@omega',
        'esteban.banderas@omega.com',
        '79995555',
        '7999-5555'
      ];

      for (const query of tactics) {
        const searchRes = await svc.searchContacts({ caller: callerV1, q: query });
        expect(searchRes.results).toHaveLength(0);
        expect(searchRes.contacts).toHaveLength(0);
      }

      // V1 attempts direct getContact for contactV2 -> rejected with permission-denied
      await expect(svc.getContact({ caller: callerV1, contactId: contactV2.id }))
        .rejects.toThrow('No tiene permisos para consultar los datos de esta persona');

      // V1 attempts to modify contactV2 -> rejected with permission-denied
      await expect(svc.updateContact({
        caller: callerV1,
        contactId: contactV2.id,
        contact: { nombres: 'Hacker' }
      })).rejects.toThrow('No tiene permisos para modificar los datos de esta persona');

      // V1 attempts to link contactV2 to V1's account C1 -> rejected with permission-denied
      await expect(svc.linkContactToAccount({
        caller: callerV1,
        accountId: 'C1',
        contactId: contactV2.id,
        cargo: 'Espía Corporativo'
      })).rejects.toThrow('No tiene permisos para vincular esta persona');

      // Manager CAN search and find contactV2
      const mgrSearch = await svc.searchContacts({ caller: callerMgr, q: 'Banderas' });
      expect(mgrSearch.results.length).toBeGreaterThanOrEqual(1);
      expect(mgrSearch.results.some(c => c.id === contactV2.id)).toBe(true);

      // excludeAccountId excludes persons already linked actively to that account
      const mgrExcludeC2 = await svc.searchContacts({ caller: callerMgr, q: 'Banderas', excludeAccountId: 'C2' });
      expect(mgrExcludeC2.results.some(c => c.id === contactV2.id)).toBe(false);

      const mgrExcludeC1 = await svc.searchContacts({ caller: callerMgr, q: 'Banderas', excludeAccountId: 'C1' });
      expect(mgrExcludeC1.results.some(c => c.id === contactV2.id)).toBe(true);

      // Verify data minimization: result fields must only expose safe commercial fields
      const item = mgrSearch.results.find(c => c.id === contactV2.id);
      expect(Object.keys(item).sort()).toEqual(['apellidos', 'correo', 'id', 'nombre_completo', 'nombres', 'telefono'].sort());
      expect(item.createdBy).toBeUndefined();
      expect(item.fecha_creacion).toBeUndefined();
    });

    test('getContact enforces strict portfolio isolation and authorship across all scenarios', async () => {
      const callerV1 = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const callerV2 = { uid: 'uid-v2', cid: V2, role: 'vendedor', name: 'Vendedor Dos' };
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };

      // 1. Contact created by V1 and linked to C1 (V1 portfolio)
      const resA = await svc.createContact({
        caller: callerV1,
        contact: { nombres: 'Carlos', apellidos: 'Propio', correo: 'carlos@v1.test' }
      });
      await svc.linkContactToAccount({
        caller: callerV1,
        accountId: 'C1',
        contactId: resA.contact.id,
        cargo: 'Gerente'
      });

      // 2. Contact created by V2 and linked exclusively to C2 (alien to V1)
      const resB = await svc.createContact({
        caller: callerV2,
        contact: { nombres: 'Bernardo', apellidos: 'Ajeno', correo: 'bernardo@v2.test' }
      });
      await svc.linkContactToAccount({
        caller: callerV2,
        accountId: 'C2',
        contactId: resB.contact.id,
        cargo: 'Director'
      });

      // 3. Shared contact created by V2, linked to both C1 (V1) and C2 (V2)
      const resC = await svc.createContact({
        caller: callerV2,
        contact: { nombres: 'Cecilia', apellidos: 'Compartida', correo: 'cecilia@multi.test' }
      });
      await svc.linkContactToAccount({
        caller: callerV2,
        accountId: 'C2',
        contactId: resC.contact.id,
        cargo: 'Asesora'
      });
      await svc.linkContactToAccount({
        caller: callerMgr,
        accountId: 'C1',
        contactId: resC.contact.id,
        cargo: 'Consultora'
      });

      // 4. Orphan contact created by V1 without active relations
      const resD = await svc.createContact({
        caller: callerV1,
        contact: { nombres: 'David', apellidos: 'CreadoPorV1', correo: 'david@v1.test' }
      });

      // Scenario A: V1 queries portfolio contact via backend -> ALLOWED
      const getA = await svc.getContact({ caller: callerV1, contactId: resA.contact.id });
      expect(getA.contact.nombres).toBe('Carlos');

      // Scenario B: V1 queries exclusive V2 contact via backend -> DENIED
      await expect(svc.getContact({ caller: callerV1, contactId: resB.contact.id }))
        .rejects.toThrow('No tiene permisos para consultar los datos de esta persona');

      // Scenario C: V1 queries shared contact linked to own account -> ALLOWED
      const getC = await svc.getContact({ caller: callerV1, contactId: resC.contact.id });
      expect(getC.contact.nombres).toBe('Cecilia');

      // Scenario D: V1 queries contact created by them without active relations -> ALLOWED (authorship policy)
      const getD = await svc.getContact({ caller: callerV1, contactId: resD.contact.id });
      expect(getD.contact.nombres).toBe('David');

      // Scenario E: Manager queries all contacts -> ALLOWED
      const mgrA = await svc.getContact({ caller: callerMgr, contactId: resA.contact.id });
      const mgrB = await svc.getContact({ caller: callerMgr, contactId: resB.contact.id });
      const mgrD = await svc.getContact({ caller: callerMgr, contactId: resD.contact.id });
      expect(mgrA.contact.nombres).toBe('Carlos');
      expect(mgrB.contact.nombres).toBe('Bernardo');
      expect(mgrD.contact.nombres).toBe('David');
    });
  });

  // ===========================================================================
  // 2. Relation Person-Account & Periods Subcollection
  // ===========================================================================
  describe('Relation Person-Account & Periods Lifecycle', () => {
    let person;

    beforeEach(async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const res = await svc.createContact({
        caller,
        contact: { nombres: 'Ing. Mauricio', apellidos: 'Alas', correo: 'mauricio.alas@gmail.com' }
      });
      person = res.contact;
    });

    test('links person to account with deterministic relation ID and opens first period', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const res = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Director de Operaciones',
        telefono_corporativo: '2222-3333',
        extension: '101',
        correo_corporativo: 'malas@constructora-delta.com'
      });

      expect(res.status).toBe('linked');
      const expectedRelId = `AC_C1_${person.id}`;
      expect(res.accountContact.id).toBe(expectedRelId);
      expect(res.accountContact.accountId).toBe('C1');
      expect(res.accountContact.contactId).toBe(person.id);
      expect(res.accountContact.cargo).toBe('Director de Operaciones');
      expect(res.accountContact.activo).toBe(true);
      expect(res.accountContact.total_periodos).toBe(1);
      expect(res.accountContact.periodo_actual_id).toBeDefined();

      // Verify period subcollection document
      const periodId = res.accountContact.periodo_actual_id;
      const periodDoc = state.docs[`account_contacts_prod/${expectedRelId}/periods_prod/${periodId}`];
      expect(periodDoc).toBeDefined();
      expect(periodDoc.id).toBe(periodId);
      expect(periodDoc.cargo).toBe('Director de Operaciones');
      expect(periodDoc.fecha_inicio).toBeDefined();
      expect(periodDoc.fecha_fin).toBeNull();
      expect(periodDoc.motivo_salida).toBeNull();
    });

    test('prevents linking if an active relation already exists between person and account', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Jefe de Taller'
      });

      await expect(svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Gerente General'
      })).rejects.toThrow('La persona ya posee una relación activa con esta cuenta');
    });

    test('same person can be linked to a different account simultaneously', async () => {
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };
      const res1 = await svc.linkContactToAccount({
        caller: callerMgr,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Asesor Externo'
      });
      const res2 = await svc.linkContactToAccount({
        caller: callerMgr,
        accountId: 'C2',
        contactId: person.id,
        cargo: 'Consultor de Proyectos'
      });

      expect(res1.accountContact.id).toBe(`AC_C1_${person.id}`);
      expect(res2.accountContact.id).toBe(`AC_C2_${person.id}`);
      expect(res1.accountContact.activo).toBe(true);
      expect(res2.accountContact.activo).toBe(true);
    });

    test('deactivates relation: closes open period with fecha_fin and sets activo = false', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const linked = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Supervisor de Obra'
      });

      const relId = linked.accountContact.id;
      const periodId = linked.accountContact.periodo_actual_id;

      const deact = await svc.deactivateAccountContact({
        caller,
        accountContactId: relId,
        motivo_salida: 'Cambio de empleo'
      });

      expect(deact.status).toBe('deactivated');
      expect(deact.accountContact.activo).toBe(false);
      expect(deact.accountContact.periodo_actual_id).toBeNull();

      // Verify period closed
      const periodDoc = state.docs[`account_contacts_prod/${relId}/periods_prod/${periodId}`];
      expect(periodDoc.fecha_fin).toBeDefined();
      expect(periodDoc.fecha_fin).not.toBeNull();
      expect(periodDoc.motivo_salida).toBe('Cambio de empleo');

      // Subsequent deactivation returns unchanged
      const deactAgain = await svc.deactivateAccountContact({
        caller,
        accountContactId: relId
      });
      expect(deactAgain.status).toBe('unchanged');
    });

    test('reactivates relation: opens new period without overwriting historical period and increments total_periodos', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const linked = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Ingeniero Residente'
      });
      const relId = linked.accountContact.id;
      const firstPeriodId = linked.accountContact.periodo_actual_id;

      // Deactivate first period
      await svc.deactivateAccountContact({
        caller,
        accountContactId: relId,
        motivo_salida: 'Finalización de contrato temporal'
      });

      // Reactivate with new promotion/cargo
      const reactivated = await svc.reactivateAccountContact({
        caller,
        accountContactId: relId,
        cargo: 'Gerente de Proyectos HVAC',
        motivo_reingreso: 'Recontratación fija',
        telefono_corporativo: '2299-8877'
      });

      expect(reactivated.status).toBe('reactivated');
      expect(reactivated.accountContact.activo).toBe(true);
      expect(reactivated.accountContact.cargo).toBe('Gerente de Proyectos HVAC');
      expect(reactivated.accountContact.total_periodos).toBe(2);
      expect(reactivated.accountContact.periodo_actual_id).not.toBe(firstPeriodId);

      const secondPeriodId = reactivated.accountContact.periodo_actual_id;

      // Verify BOTH periods exist in Firestore: first period remains intact and closed, second is open
      const firstPeriodDoc = state.docs[`account_contacts_prod/${relId}/periods_prod/${firstPeriodId}`];
      const secondPeriodDoc = state.docs[`account_contacts_prod/${relId}/periods_prod/${secondPeriodId}`];

      expect(firstPeriodDoc).toBeDefined();
      expect(firstPeriodDoc.cargo).toBe('Ingeniero Residente');
      expect(firstPeriodDoc.fecha_fin).not.toBeNull();
      expect(firstPeriodDoc.motivo_salida).toBe('Finalización de contrato temporal');

      expect(secondPeriodDoc).toBeDefined();
      expect(secondPeriodDoc.cargo).toBe('Gerente de Proyectos HVAC');
      expect(secondPeriodDoc.fecha_inicio).toBeDefined();
      expect(secondPeriodDoc.fecha_fin).toBeNull();
      expect(secondPeriodDoc.motivo_reingreso).toBe('Recontratación fija');
    });

    test('re-linking an inactive relation via linkContactToAccount acts as reactivation', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const linked = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Analista'
      });
      await svc.deactivateAccountContact({
        caller,
        accountContactId: linked.accountContact.id,
        motivo_salida: 'Renuncia'
      });

      // Call linkContactToAccount again
      const relinked = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Jefe de Analistas'
      });

      expect(relinked.status).toBe('reactivated');
      expect(relinked.accountContact.activo).toBe(true);
      expect(relinked.accountContact.cargo).toBe('Jefe de Analistas');
      expect(relinked.accountContact.total_periodos).toBe(2);
    });

    test('updates corporate information of active relation and synchronizes cargo in current period', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const linked = await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Coordinador'
      });
      const relId = linked.accountContact.id;
      const periodId = linked.accountContact.periodo_actual_id;

      const updated = await svc.updateAccountContact({
        caller,
        accountContactId: relId,
        cargo: 'Coordinador Senior',
        extension: '205',
        correo_corporativo: 'coord@delta.com'
      });

      expect(updated.status).toBe('updated');
      expect(updated.accountContact.cargo).toBe('Coordinador Senior');
      expect(updated.accountContact.extension).toBe('205');
      expect(updated.accountContact.correo_corporativo).toBe('coord@delta.com');

      // Verify period cargo synchronized
      const periodDoc = state.docs[`account_contacts_prod/${relId}/periods_prod/${periodId}`];
      expect(periodDoc.cargo).toBe('Coordinador Senior');
    });

    test('lists account contacts joining person identity and supports period history inquiry', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Gerente General'
      });

      // Add a second contact
      const person2 = (await svc.createContact({
        caller,
        contact: { nombres: 'Elena', apellidos: 'Rivas' }
      })).contact;
      await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person2.id,
        cargo: 'Contadora'
      });

      const listRes = await svc.listAccountContacts({ caller, accountId: 'C1' });
      expect(listRes.contacts.length).toBe(2);
      expect(listRes.contacts[0].persona).toBeDefined();
      expect(listRes.contacts.some(c => c.persona.nombres === 'Elena')).toBe(true);
      expect(listRes.contacts.some(c => c.cargo === 'Gerente General')).toBe(true);

      // Inquire periods
      const relId = `AC_C1_${person.id}`;
      const periodsRes = await svc.listContactPeriods({ caller, accountContactId: relId });
      expect(periodsRes.periods.length).toBe(1);
      expect(periodsRes.periods[0].cargo).toBe('Gerente General');
    });

    test('overlapping concurrent linkContactToAccount operations coordinate atomically via parent document', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const relId = `AC_C1_${person.id}`;

      // Execute two simultaneous link operations on the exact same person and account
      const p1 = svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Asesor Técnico A'
      });
      const p2 = svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Asesor Técnico B'
      });

      const [r1, r2] = await Promise.allSettled([p1, p2]);

      // Exactly one operation must succeed, and the conflicting one must be rejected
      const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
      const rejected = [r1, r2].filter(r => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.status).toBe('linked');
      expect(rejected[0].reason.message).toMatch(/ya posee una relación activa|concurrent conflicts/i);

      // Verify parent document state integrity
      const parentDoc = state.docs[`account_contacts_prod/${relId}`];
      expect(parentDoc).toBeDefined();
      expect(parentDoc.activo).toBe(true);
      expect(parentDoc.total_periodos).toBe(1);
      expect(parentDoc.periodo_actual_id).toBeDefined();

      // Verify periods subcollection has exactly 1 document and exactly 1 open period
      const prefix = `account_contacts_prod/${relId}/periods_prod/`;
      const periodKeys = Object.keys(state.docs).filter(k => k.startsWith(prefix));
      expect(periodKeys).toHaveLength(1);

      const periodDoc = state.docs[periodKeys[0]];
      expect(periodDoc.fecha_fin).toBeNull();
      expect(periodDoc.id).toBe(parentDoc.periodo_actual_id);
    });

    test('overlapping concurrent deactivation operations resolve atomically without leaving multiple open periods', async () => {
      const caller = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const relId = `AC_C1_${person.id}`;

      // First link
      await svc.linkContactToAccount({
        caller,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Supervisor'
      });

      // Execute two simultaneous deactivations
      const d1 = svc.deactivateAccountContact({ caller, accountContactId: relId, motivo_salida: 'Causa 1' });
      const d2 = svc.deactivateAccountContact({ caller, accountContactId: relId, motivo_salida: 'Causa 2' });

      const [r1, r2] = await Promise.allSettled([d1, d2]);

      // Both should settle without throwing unhandled exceptions
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('fulfilled');

      const statuses = [r1.value.status, r2.value.status];
      expect(statuses).toContain('deactivated');

      // Parent doc state: inactive, no current period
      const parentDoc = state.docs[`account_contacts_prod/${relId}`];
      expect(parentDoc.activo).toBe(false);
      expect(parentDoc.periodo_actual_id).toBeNull();

      // Subcollection: period closed with fecha_fin
      const prefix = `account_contacts_prod/${relId}/periods_prod/`;
      const periodKeys = Object.keys(state.docs).filter(k => k.startsWith(prefix));
      expect(periodKeys).toHaveLength(1);
      expect(state.docs[periodKeys[0]].fecha_fin).not.toBeNull();
    });
  });

  // ===========================================================================
  // 3. Portfolio & Role Authorization Tests
  // ===========================================================================
  describe('Portfolio & Role Authorization', () => {
    let person;

    beforeEach(async () => {
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };
      const res = await svc.createContact({
        caller: callerMgr,
        contact: { nombres: 'Jorge', apellidos: 'Campos' }
      });
      person = res.contact;
    });

    test('vendedor CANNOT access or link contacts to an account outside their portfolio', async () => {
      // C2 is owned by V2, V1 has no rights on C2
      const callerV1 = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const callerV2 = { uid: 'uid-v2', cid: V2, role: 'vendedor', name: 'Vendedor Dos' };
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };
      const callerGes = { uid: 'uid-ges', cid: GES, role: 'gestor', name: 'Gestor Comercial' };

      // Link person to C2 by V2 first
      const linkRes = await svc.linkContactToAccount({
        caller: callerV2,
        accountId: 'C2',
        contactId: person.id,
        cargo: 'Auditor Externo'
      });
      const relIdC2 = linkRes.accountContact.id;

      // 1. Vendedor V1 intentando vincular contacto a cuenta de V2
      await expect(svc.linkContactToAccount({
        caller: callerV1,
        accountId: 'C2',
        contactId: person.id,
        cargo: 'Auditor'
      })).rejects.toThrow('No tiene permisos para acceder a esta cuenta');

      // 2. Vendedor V1 intentando listar relaciones de cuentas de V2
      await expect(svc.listAccountContacts({
        caller: callerV1,
        accountId: 'C2'
      })).rejects.toThrow('No tiene permisos para acceder a esta cuenta');

      // 3. Vendedor V1 intentando leer/modificar una relación por ID de una cuenta de V2
      await expect(svc.updateAccountContact({
        caller: callerV1,
        accountContactId: relIdC2,
        cargo: 'Intento de Modificación'
      })).rejects.toThrow('No tiene permisos para acceder a esta cuenta');

      // 4. Vendedor V1 intentando listar períodos de esa relación
      await expect(svc.listContactPeriods({
        caller: callerV1,
        accountContactId: relIdC2
      })).rejects.toThrow('No tiene permisos para acceder a esta cuenta');

      // 5. Manager y gestor accediendo a los mismos datos de C2
      const mgrList = await svc.listAccountContacts({ caller: callerMgr, accountId: 'C2' });
      expect(mgrList.contacts.length).toBe(1);

      const mgrPeriods = await svc.listContactPeriods({ caller: callerMgr, accountContactId: relIdC2 });
      expect(mgrPeriods.periods.length).toBe(1);

      const gesList = await svc.listAccountContacts({ caller: callerGes, accountId: 'C2' });
      expect(gesList.contacts.length).toBe(1);

      const gesPeriods = await svc.listContactPeriods({ caller: callerGes, accountContactId: relIdC2 });
      expect(gesPeriods.periods.length).toBe(1);
    });

    test('vendedor CAN access and link contacts to an account in their portfolio', async () => {
      // C1 was created by V1
      const callerV1 = { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' };
      const res = await svc.linkContactToAccount({
        caller: callerV1,
        accountId: 'C1',
        contactId: person.id,
        cargo: 'Asesor Técnico'
      });
      expect(res.status).toBe('linked');
    });

    test('manager and gestor can access any account', async () => {
      const callerMgr = { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' };
      const callerGes = { uid: 'uid-ges', cid: GES, role: 'gestor', name: 'Gestor Comercial' };

      const res1 = await svc.linkContactToAccount({
        caller: callerMgr,
        accountId: 'C2',
        contactId: person.id,
        cargo: 'Director Ejecutivo'
      });
      expect(res1.status).toBe('linked');

      const res2 = await svc.listAccountContacts({
        caller: callerGes,
        accountId: 'C2'
      });
      expect(res2.contacts.length).toBe(1);
    });

    test('unauthenticated caller is rejected with unauthenticated error', async () => {
      await expect(svc.resolveCaller(null)).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(svc.resolveCaller({})).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    test('inactive user profile is rejected with permission-denied', async () => {
      state.docs[`users_prod/${V1}`].activo = false;
      await expect(svc.resolveCaller(ctx('uid-v1', { cid: V1 }))).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  // ===========================================================================
  // 4. Callable Entry Points in functions/index.js
  // ===========================================================================
  describe('Callable Cloud Functions Entry Points', () => {
    test('createContactAdmin callable execution through auth context', async () => {
      const data = {
        contact: { nombres: 'Sofía', apellidos: 'Linares', correo: 'sofia@linares.com' },
        dbSuffix: '_prod'
      };
      const context = ctx('uid-v1', { cid: V1, role: 'vendedor' });
      const res = await createContactAdmin(data, context);
      expect(res.status).toBe('created');
      expect(res.contact.nombres).toBe('Sofía');
    });

    test('linkContactToAccountAdmin and listAccountContactsAdmin callables', async () => {
      const cContext = ctx('uid-v1', { cid: V1, role: 'vendedor' });
      const personRes = await createContactAdmin({
        contact: { nombres: 'Mateo', apellidos: 'Quijada' },
        dbSuffix: '_prod'
      }, cContext);

      const linkRes = await linkContactToAccountAdmin({
        accountId: 'C1',
        contactId: personRes.contact.id,
        cargo: 'Gerente de Planta',
        dbSuffix: '_prod'
      }, cContext);
      expect(linkRes.status).toBe('linked');

      const listRes = await listAccountContactsAdmin({
        accountId: 'C1',
        dbSuffix: '_prod'
      }, cContext);
      expect(listRes.contacts.length).toBeGreaterThanOrEqual(1);
      expect(listRes.contacts.some(c => c.persona.nombres === 'Mateo')).toBe(true);
    });
  });
});
