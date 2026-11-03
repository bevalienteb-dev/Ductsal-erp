// functions/__tests__/crmContacts.client.test.js
// Client module unit tests for Contacts & Relations (Phase 2 Block 1 - B1).
// Tests crm_contacts.js idempotent callable wrappers and UI integration guards in index.html and modules/clients/.

const fs = require('fs');
const path = require('path');
const CrmContacts = require('../../crm_contacts.js');

const ROOT = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const clientsUi = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'clients_ui.js'), 'utf8');
const contactsUi = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'contacts_ui.js'), 'utf8');
const firestoreRules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

function fbWith(impl) {
  const calls = [];
  const fb = {
    functions: () => ({
      httpsCallable: (name) => async (payload) => {
        calls.push({ name, payload });
        return { data: await impl(name, payload, calls.length) };
      }
    })
  };
  return { fb, calls };
}

describe('CrmContacts Client Callable Wrappers', () => {
  const samplePerson = { nombres: 'Carlos', apellidos: 'Rivera', correo: 'carlos@ejemplo.com', telefono: '7890-1234' };

  test('createContact calls createContactAdmin with opId and dbSuffix', async () => {
    const { fb, calls } = fbWith((name, payload) => ({ status: 'created', contact: { id: 'CT_1', ...payload.contact } }));
    const res = await CrmContacts.createContact(fb, { contact: samplePerson, dbSuffix: '_prod' });
    expect(res.status).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('createContactAdmin');
    expect(calls[0].payload.contact.nombres).toBe('Carlos');
    expect(calls[0].payload.dbSuffix).toBe('_prod');
    expect(typeof calls[0].payload.opId).toBe('string');
  });

  test('createContact retries preserve the same opId on uncertain network failure', async () => {
    let attempt = 0;
    const { fb, calls } = fbWith(() => {
      if (++attempt === 1) {
        const err = new Error('network down');
        err.code = 'functions/unavailable';
        throw err;
      }
      return { status: 'created', contact: { id: 'CT_1' } };
    });

    await expect(CrmContacts.createContact(fb, { contact: samplePerson, dbSuffix: '_prod' })).rejects.toThrow();
    const res = await CrmContacts.createContact(fb, { contact: samplePerson, dbSuffix: '_prod' });
    expect(res.status).toBe('created');
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
  });

  test('linkContactToAccount calls linkContactToAccountAdmin with deterministic parameters', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'linked', accountContact: { id: 'AC_C1_CT_1', activo: true } }));
    const res = await CrmContacts.linkContactToAccount(fb, {
      accountId: 'C1',
      contactId: 'CT_1',
      cargo: 'Jefe de Proyectos',
      telefono_corporativo: '2222-3333',
      extension: '101',
      correo_corporativo: 'carlos@empresa.com',
      dbSuffix: '_prod'
    });
    expect(res.status).toBe('linked');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('linkContactToAccountAdmin');
    expect(calls[0].payload.accountId).toBe('C1');
    expect(calls[0].payload.contactId).toBe('CT_1');
    expect(calls[0].payload.cargo).toBe('Jefe de Proyectos');
  });

  test('deactivateAccountContact calls deactivateAccountContactAdmin with motive', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'deactivated', accountContactId: 'AC_C1_CT_1' }));
    const res = await CrmContacts.deactivateAccountContact(fb, {
      accountContactId: 'AC_C1_CT_1',
      motivo_salida: 'Cambio de puesto',
      dbSuffix: '_prod'
    });
    expect(res.status).toBe('deactivated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('deactivateAccountContactAdmin');
    expect(calls[0].payload.motivo_salida).toBe('Cambio de puesto');
  });

  test('reactivateAccountContact calls reactivateAccountContactAdmin with motive and new cargo', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'reactivated', accountContactId: 'AC_C1_CT_1' }));
    const res = await CrmContacts.reactivateAccountContact(fb, {
      accountContactId: 'AC_C1_CT_1',
      cargo: 'Director General',
      motivo_reingreso: 'Ascenso corporativo',
      dbSuffix: '_prod'
    });
    expect(res.status).toBe('reactivated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('reactivateAccountContactAdmin');
    expect(calls[0].payload.cargo).toBe('Director General');
    expect(calls[0].payload.motivo_reingreso).toBe('Ascenso corporativo');
  });

  test('listAccountContacts calls listAccountContactsAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ contacts: [] }));
    const res = await CrmContacts.listAccountContacts(fb, { accountId: 'C1', includeInactive: true, dbSuffix: '_prod' });
    expect(res.contacts).toEqual([]);
    expect(calls[0].name).toBe('listAccountContactsAdmin');
    expect(calls[0].payload.accountId).toBe('C1');
  });

  test('listContactPeriods calls listContactPeriodsAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ periods: [] }));
    const res = await CrmContacts.listContactPeriods(fb, { accountContactId: 'AC_C1_CT_1', dbSuffix: '_prod' });
    expect(res.periods).toEqual([]);
    expect(calls[0].name).toBe('listContactPeriodsAdmin');
  });
});

describe('Static Architecture & UI Integration (Phase 2 Block 1)', () => {
  test('index.html loads crm_contacts.js and contacts_ui.js in proper sequence', () => {
    expect(indexHtml).toContain('<script src="crm_contacts.js?v=1"></script>');
    expect(indexHtml).toContain('<script src="modules/clients/contacts_ui.js?v=1"></script>');
    const posContactsJs = indexHtml.indexOf('crm_contacts.js');
    const posClientsJs = indexHtml.indexOf('crm_clients.js');
    const posContactsUi = indexHtml.indexOf('modules/clients/contacts_ui.js');
    expect(posContactsJs).toBeGreaterThan(posClientsJs);
    expect(posContactsUi).toBeGreaterThan(posContactsJs);
  });

  test('index.html contains required Hub & Spoke B1 modals', () => {
    expect(indexHtml).toContain('id="accountContactsModal"');
    expect(indexHtml).toContain('id="linkContactModal"');
    expect(indexHtml).toContain('id="editAccountContactModal"');
    expect(indexHtml).toContain('id="deactivateContactModal"');
    expect(indexHtml).toContain('id="reactivateContactModal"');
    expect(indexHtml).toContain('id="contactPeriodsModal"');
  });

  test('clients_ui.js links to openAccountContactsModal in clients table and modal', () => {
    expect(clientsUi).toContain('ContactsUI.openAccountContactsModal');
    expect(clientsUi).toContain('btn-client-modal-contacts');
  });

  test('contacts_ui.js exposes the required public API', () => {
    expect(contactsUi).toContain('openAccountContactsModal');
    expect(contactsUi).toContain('openLinkContactModal');
    expect(contactsUi).toContain('submitLinkContact');
    expect(contactsUi).toContain('openContactPeriodsModal');
    expect(contactsUi).toContain('openDeactivateContactModal');
    expect(contactsUi).toContain('openReactivateContactModal');
  });

  test('firestore.rules protects contacts_prod, account_contacts_prod and periods_prod', () => {
    expect(firestoreRules).toContain('match /contacts_prod/{contactId}');
    expect(firestoreRules).toContain('match /account_contacts_prod/{accountContactId}');
    expect(firestoreRules).toContain('match /periods_prod/{periodId}');
    expect(firestoreRules).toContain('allow write: if false;');
  });

  test('legacy clients_prod.contacto is preserved without auto-overwriting', () => {
    expect(clientsUi).toContain('c.contacto');
    expect(indexHtml).toContain('id="jur-contacto"');
  });
});
