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

  test('searchContacts passes query, limit, and excludeAccountId to searchContactsAdmin', async () => {
    const { fb, calls } = fbWith(() => ({ results: [] }));
    const res = await CrmContacts.searchContacts(fb, { q: 'Carlos', limit: 10, excludeAccountId: 'ACC_1', dbSuffix: '_prod' });
    expect(res.results).toEqual([]);
    expect(calls[0].name).toBe('searchContactsAdmin');
    expect(calls[0].payload.q).toBe('Carlos');
    expect(calls[0].payload.limit).toBe(10);
    expect(calls[0].payload.excludeAccountId).toBe('ACC_1');
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

  test('index.html replaces legacy B1 modals with 8 full-screen view sections', () => {
    // 1. Modals eradicated
    expect(indexHtml).not.toContain('id="accountContactsModal"');
    expect(indexHtml).not.toContain('id="linkContactModal"');
    expect(indexHtml).not.toContain('id="editAccountContactModal"');
    expect(indexHtml).not.toContain('id="deactivateContactModal"');
    expect(indexHtml).not.toContain('id="reactivateContactModal"');
    expect(indexHtml).not.toContain('id="contactPeriodsModal"');

    // 2. Full-screen view sections present
    expect(indexHtml).toContain('id="account-contacts-view"');
    expect(indexHtml).toContain('id="create-person-view"');
    expect(indexHtml).toContain('id="edit-person-view"');
    expect(indexHtml).toContain('id="link-contact-account-view"');
    expect(indexHtml).toContain('id="edit-account-contact-view"');
    expect(indexHtml).toContain('id="deactivate-account-contact-view"');
    expect(indexHtml).toContain('id="reactivate-account-contact-view"');
    expect(indexHtml).toContain('id="contact-periods-view"');
  });

  test('all 8 full-screen B1 views contain context cards, headers, actions, and status banners', () => {
    const requiredViews = [
      'account-contacts-view',
      'create-person-view',
      'edit-person-view',
      'link-contact-account-view',
      'edit-account-contact-view',
      'deactivate-account-contact-view',
      'reactivate-account-contact-view',
      'contact-periods-view'
    ];

    requiredViews.forEach(vId => {
      expect(indexHtml).toContain(`id="${vId}"`);
      const sectionHtml = indexHtml.substring(indexHtml.indexOf(`id="${vId}"`), indexHtml.indexOf(`</section>`, indexHtml.indexOf(`id="${vId}"`)));
      expect(sectionHtml).toContain('class="view-header"');
      expect(sectionHtml).toContain('card');
      expect(sectionHtml).toContain('alert-feedback-banner');
      expect(sectionHtml).toContain('ContactsUI.');
    });
  });

  test('clients_ui.js links to openAccountContactsModal / openAccountContactsView', () => {
    expect(clientsUi).toContain('ContactsUI.openAccountContactsModal');
    expect(clientsUi).toContain('btn-client-modal-contacts');
  });

  test('contacts_ui.js exposes full-screen navigation and preservation of context', () => {
    expect(contactsUi).toContain('openAccountContactsView');
    expect(contactsUi).toContain('returnToClientsView');
    expect(contactsUi).toContain('cancelContactOperation');
    expect(contactsUi).toContain('openCreatePersonView');
    expect(contactsUi).toContain('submitCreatePerson');
    expect(contactsUi).toContain('openEditPersonView');
    expect(contactsUi).toContain('submitEditPerson');
    expect(contactsUi).toContain('openLinkContactView');
    expect(contactsUi).toContain('openEditAccountContactView');
    expect(contactsUi).toContain('openDeactivateContactView');
    expect(contactsUi).toContain('openReactivateContactView');
    expect(contactsUi).toContain('openContactPeriodsView');

    // Backward-compatible aliases
    expect(contactsUi).toContain('openAccountContactsModal');
    expect(contactsUi).toContain('openLinkContactModal');
    expect(contactsUi).toContain('openEditAccountContactModal');
    expect(contactsUi).toContain('openDeactivateContactModal');
    expect(contactsUi).toContain('openReactivateContactModal');
    expect(contactsUi).toContain('openContactPeriodsModal');
  });

  test('contacts_ui.js does not use blocking browser popups (window.alert/confirm/prompt)', () => {
    expect(contactsUi).not.toContain('window.confirm(');
    expect(contactsUi).not.toContain('window.prompt(');
    expect(contactsUi).not.toContain('alert(');
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

describe('Firestore Security Rules Logic Evaluation (account_contacts_prod & periods_prod)', () => {
  // Exact model logic from firestore.rules lines 64-106
  function evalClientVisible(accountDoc, caller) {
    if (['manager', 'gestor'].includes(caller.role)) return true;
    if (caller.role === 'vendedor') {
      const isCreator = accountDoc.createdBy === caller.cid;
      const isVisible = Array.isArray(accountDoc.visibleTo) && accountDoc.visibleTo.includes(caller.cid);
      const isAssigned = accountDoc.vendedor_asignado === caller.cid;
      return isCreator || isVisible || isAssigned;
    }
    return false;
  }

  function evalAccountContactRule(op, accountDoc, caller) {
    if (['create', 'update', 'delete'].includes(op)) return false; // allow write: if false;
    if (['get', 'list'].includes(op)) {
      return evalClientVisible(accountDoc, caller);
    }
    return false;
  }

  function evalPeriodRule(op, accountDoc, caller) {
    if (['create', 'update', 'delete'].includes(op)) return false; // allow write: if false;
    if (['get', 'list'].includes(op)) {
      return evalClientVisible(accountDoc, caller);
    }
    return false;
  }

  const accountC1 = { id: 'C1', createdBy: 'V1', visibleTo: ['V1'] };
  const accountC2 = { id: 'C2', createdBy: 'V2', visibleTo: ['V2'], vendedor_asignado: 'V2' };

  const callerV1 = { cid: 'V1', role: 'vendedor' };
  const callerV2 = { cid: 'V2', role: 'vendedor' };
  const callerMgr = { cid: 'MGR', role: 'manager' };
  const callerGes = { cid: 'GES', role: 'gestor' };

  test('1. Vendedor V1 intentando listar relaciones de cuentas de V2 is DENIED by Firestore rules', () => {
    expect(evalAccountContactRule('list', accountC2, callerV1)).toBe(false);
  });

  test('2. Vendedor V1 intentando leer una relación por ID de una cuenta de V2 is DENIED by Firestore rules', () => {
    expect(evalAccountContactRule('get', accountC2, callerV1)).toBe(false);
  });

  test('3. Vendedor V1 intentando listar períodos de esa relación is DENIED by Firestore rules', () => {
    expect(evalPeriodRule('list', accountC2, callerV1)).toBe(false);
    expect(evalPeriodRule('get', accountC2, callerV1)).toBe(false);
  });

  test('4. Manager y gestor accediendo a los mismos datos de C2 are ALLOWED by Firestore rules', () => {
    // Manager
    expect(evalAccountContactRule('list', accountC2, callerMgr)).toBe(true);
    expect(evalAccountContactRule('get', accountC2, callerMgr)).toBe(true);
    expect(evalPeriodRule('list', accountC2, callerMgr)).toBe(true);
    expect(evalPeriodRule('get', accountC2, callerMgr)).toBe(true);

    // Gestor
    expect(evalAccountContactRule('list', accountC2, callerGes)).toBe(true);
    expect(evalAccountContactRule('get', accountC2, callerGes)).toBe(true);
    expect(evalPeriodRule('list', accountC2, callerGes)).toBe(true);
    expect(evalPeriodRule('get', accountC2, callerGes)).toBe(true);
  });

  test('5. Vendedor V1 accessing relations and periods of own account C1 is ALLOWED by Firestore rules', () => {
    expect(evalAccountContactRule('list', accountC1, callerV1)).toBe(true);
    expect(evalAccountContactRule('get', accountC1, callerV1)).toBe(true);
    expect(evalPeriodRule('list', accountC1, callerV1)).toBe(true);
    expect(evalPeriodRule('get', accountC1, callerV1)).toBe(true);
  });

  test('6. All direct client writes to account_contacts_prod and periods_prod are DENIED', () => {
    ['create', 'update', 'delete'].forEach(op => {
      expect(evalAccountContactRule(op, accountC1, callerV1)).toBe(false);
      expect(evalAccountContactRule(op, accountC1, callerMgr)).toBe(false);
      expect(evalPeriodRule(op, accountC1, callerV1)).toBe(false);
      expect(evalPeriodRule(op, accountC1, callerMgr)).toBe(false);
    });
  });
});
