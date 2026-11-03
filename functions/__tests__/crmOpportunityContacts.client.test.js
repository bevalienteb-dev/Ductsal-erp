// functions/__tests__/crmOpportunityContacts.client.test.js
// Client module unit tests for Opportunity Contacts & Roles (Phase 2 Block 2 - B2).
// Tests crm_opportunity_contacts.js client SDK, idempotency, parameter forwarding,
// index.html DOM structures, and opportunities_ui.js integration.

const fs = require('fs');
const path = require('path');
const CrmOpportunityContacts = require('../../crm_opportunity_contacts.js');

const ROOT = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const oppsUi = fs.readFileSync(path.join(ROOT, 'modules', 'opportunities', 'opportunities_ui.js'), 'utf8');
const oppContactsUi = fs.readFileSync(path.join(ROOT, 'modules', 'opportunities', 'opportunity_contacts_ui.js'), 'utf8');
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

describe('CrmOpportunityContacts Client Callable Wrappers', () => {
  test('listOpportunityContactRoles calls listOpportunityContactRolesAdmin with filters', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      roles: [{ id: 'decisor', name: 'Decisor', activo: true }]
    }));

    const res = await CrmOpportunityContacts.listOpportunityContactRoles(fb, {
      includeInactive: false,
      dbSuffix: '_prod'
    });

    expect(res.roles).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('listOpportunityContactRolesAdmin');
    expect(calls[0].payload.includeInactive).toBe(false);
    expect(calls[0].payload.dbSuffix).toBe('_prod');
  });

  test('manageOpportunityContactRole calls manageOpportunityContactRoleAdmin', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      status: 'updated',
      role: { id: payload.roleId, name: payload.name, activo: payload.activo }
    }));

    const res = await CrmOpportunityContacts.manageOpportunityContactRole(fb, {
      roleId: 'decisor',
      name: 'Director General',
      activo: true,
      dbSuffix: '_prod'
    });

    expect(res.status).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('manageOpportunityContactRoleAdmin');
    expect(calls[0].payload.roleId).toBe('decisor');
    expect(calls[0].payload.name).toBe('Director General');
  });

  test('addOpportunityContact calls addOpportunityContactAdmin with idempotency retry protection', async () => {
    let attempt = 0;
    const { fb, calls } = fbWith((name, payload) => {
      if (++attempt === 1) {
        const err = new Error('network down');
        err.code = 'functions/unavailable';
        throw err;
      }
      return {
        status: 'created',
        participant: { id: 'OC_OPP_1_AC_1', ...payload }
      };
    });

    const params = {
      opportunityId: 'OPP_1',
      accountContactId: 'AC_1',
      roleId: 'evaluador_tecnico',
      notes: 'Valida ductos',
      isPrimary: true,
      dbSuffix: '_prod'
    };

    await expect(CrmOpportunityContacts.addOpportunityContact(fb, params)).rejects.toThrow();
    const res = await CrmOpportunityContacts.addOpportunityContact(fb, params);

    expect(res.status).toBe('created');
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('addOpportunityContactAdmin');
    expect(calls[1].name).toBe('addOpportunityContactAdmin');
    expect(calls[0].payload.opportunityId).toBe('OPP_1');
    expect(calls[0].payload.isPrimary).toBe(true);
  });

  test('updateOpportunityContactRole calls updateOpportunityContactRoleAdmin', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      status: 'updated',
      participant: { id: payload.opportunityContactId, roleId: payload.roleId }
    }));

    const res = await CrmOpportunityContacts.updateOpportunityContactRole(fb, {
      opportunityContactId: 'OC_OPP_1_AC_1',
      roleId: 'comprador_economico',
      notes: 'Notas actualizadas',
      dbSuffix: '_prod'
    });

    expect(res.status).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('updateOpportunityContactRoleAdmin');
    expect(calls[0].payload.roleId).toBe('comprador_economico');
  });

  test('setOpportunityPrimaryContact calls setOpportunityPrimaryContactAdmin with expectedVersion', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      status: 'updated',
      primaryOpportunityContactId: payload.opportunityContactId,
      version: 3
    }));

    const res = await CrmOpportunityContacts.setOpportunityPrimaryContact(fb, {
      opportunityId: 'OPP_1',
      opportunityContactId: 'OC_OPP_1_AC_1',
      expectedVersion: 2,
      dbSuffix: '_prod'
    });

    expect(res.status).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('setOpportunityPrimaryContactAdmin');
    expect(calls[0].payload.opportunityId).toBe('OPP_1');
    expect(calls[0].payload.opportunityContactId).toBe('OC_OPP_1_AC_1');
    expect(calls[0].payload.expectedVersion).toBe(2);
  });

  test('removeOpportunityContact calls removeOpportunityContactAdmin with motivo', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      status: 'deactivated',
      opportunityContactId: payload.opportunityContactId,
      clearedPrimary: true
    }));

    const res = await CrmOpportunityContacts.removeOpportunityContact(fb, {
      opportunityContactId: 'OC_OPP_1_AC_1',
      motivo: 'Contacto desvinculado del proyecto',
      dbSuffix: '_prod'
    });

    expect(res.status).toBe('deactivated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('removeOpportunityContactAdmin');
    expect(calls[0].payload.motivo).toBe('Contacto desvinculado del proyecto');
  });

  test('changeOpportunityAccount calls changeOpportunityAccountAdmin', async () => {
    const { fb, calls } = fbWith((name, payload) => ({
      status: 'updated',
      opportunityId: payload.opportunityId,
      newAccountId: payload.newAccountId
    }));

    const res = await CrmOpportunityContacts.changeOpportunityAccount(fb, {
      opportunityId: 'OPP_1',
      newAccountId: 'ACC_GAMMA',
      motivo: 'Transferencia por filial',
      dbSuffix: '_prod'
    });

    expect(res.status).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('changeOpportunityAccountAdmin');
    expect(calls[0].payload.newAccountId).toBe('ACC_GAMMA');
  });
});

describe('Phase 2 Block B2 Frontend & Security Audit', () => {
  test('index.html contains opportunity-participants-card container', () => {
    expect(indexHtml).toContain('id="opportunity-participants-card"');
  });

  test('index.html contains B2 modals for adding, editing, and changing account', () => {
    expect(indexHtml).toContain('id="modal-add-opportunity-contact"');
    expect(indexHtml).toContain('id="modal-edit-opportunity-contact"');
    expect(indexHtml).toContain('id="modal-change-opportunity-account"');
  });

  test('index.html includes script tags for crm_opportunity_contacts.js and opportunity_contacts_ui.js', () => {
    expect(indexHtml).toContain('src="crm_opportunity_contacts.js?v=1"');
    expect(indexHtml).toContain('src="modules/opportunities/opportunity_contacts_ui.js?v=1"');
  });

  test('opportunities_ui.js invokes renderOpportunityParticipants on detail render', () => {
    expect(oppsUi).toContain('renderOpportunityParticipants(p);');
  });

  test('opportunity UI ensures that contact creation from opportunity is not permitted', () => {
    expect(indexHtml).toContain('No se pueden crear personas desde la oportunidad');
  });

  test('firestore.rules disables client-side writes for opportunity_contact_roles_prod and opportunity_contacts_prod', () => {
    expect(firestoreRules).toMatch(/match \/opportunity_contact_roles_prod\/\{roleId\}\s*\{[\s\S]*?allow write:\s*if false;/);
    expect(firestoreRules).toMatch(/match \/opportunity_contacts_prod\/\{ocId\}\s*\{[\s\S]*?allow write:\s*if false;/);
  });
});
