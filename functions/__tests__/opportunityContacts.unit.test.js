// functions/__tests__/opportunityContacts.unit.test.js
// Comprehensive Unit Tests for Phase 2 Block 2 (B2):
// Opportunity Contacts, Roles, Primary Contact Lifecycle, Account Changes, and Deletion Cascades.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createOpportunityContactsService,
  INITIAL_ROLES,
  ServiceError
} = require('../opportunityContactsService');
const {
  seedOpportunityContactRolesAdmin,
  listOpportunityContactRolesAdmin,
  manageOpportunityContactRoleAdmin,
  addOpportunityContactAdmin,
  updateOpportunityContactRoleAdmin,
  setOpportunityPrimaryContactAdmin,
  removeOpportunityContactAdmin,
  listOpportunityContactsAdmin,
  changeOpportunityAccountAdmin,
  deleteProspectAdmin
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

  state.requesters = {
    'uid-mgr': { customClaims: { manager: true } },
    'uid-ges': { customClaims: { role: 'gestor' } },
    'uid-v1': { customClaims: { role: 'vendedor' } },
    'uid-v2': { customClaims: { role: 'vendedor' } }
  };
}

function seedData() {
  // Accounts
  state.docs['clients_prod/ACC_DELTA'] = {
    id: 'ACC_DELTA',
    empresa: 'Constructora Delta SA de CV',
    createdBy: V1,
    visibleTo: [V1],
    vendedor_asignado: V1
  };
  state.docs['clients_prod/ACC_OMEGA'] = {
    id: 'ACC_OMEGA',
    empresa: 'Industrias Omega SA de CV',
    createdBy: V2,
    visibleTo: [V2],
    vendedor_asignado: V2
  };
  state.docs['clients_prod/ACC_GAMMA'] = {
    id: 'ACC_GAMMA',
    empresa: 'Gamma Proyectos SA de CV',
    createdBy: V1,
    visibleTo: [V1],
    vendedor_asignado: V1
  };

  // Persons (contacts_prod)
  state.docs['contacts_prod/CT_CARLOS'] = {
    id: 'CT_CARLOS',
    nombres: 'Carlos Roberto',
    apellidos: 'Mendoza Gómez',
    correo: 'cmendoza@delta.com',
    telefono: '2200-3333'
  };
  state.docs['contacts_prod/CT_ANA'] = {
    id: 'CT_ANA',
    nombres: 'Ana María',
    apellidos: 'López Ramos',
    correo: 'alopez@delta.com',
    telefono: '2200-4444'
  };
  state.docs['contacts_prod/CT_LUIS'] = {
    id: 'CT_LUIS',
    nombres: 'Luis Alberto',
    apellidos: 'Torres Martínez',
    correo: 'ltorres@omega.com',
    telefono: '2200-5555'
  };

  // Account Relations (account_contacts_prod)
  state.docs['account_contacts_prod/AC_DELTA_CARLOS'] = {
    id: 'AC_DELTA_CARLOS',
    accountId: 'ACC_DELTA',
    contactId: 'CT_CARLOS',
    cargo: 'Gerente de Mantenimiento',
    correo_corporativo: 'c.mendoza@constructora-delta.com',
    telefono_corporativo: '2200-3333',
    extension: '104',
    activo: true,
    eliminado: false
  };
  state.docs['account_contacts_prod/AC_DELTA_ANA'] = {
    id: 'AC_DELTA_ANA',
    accountId: 'ACC_DELTA',
    contactId: 'CT_ANA',
    cargo: 'Directora de Compras',
    correo_corporativo: 'a.lopez@constructora-delta.com',
    telefono_corporativo: '2200-4444',
    extension: '201',
    activo: true,
    eliminado: false
  };
  state.docs['account_contacts_prod/AC_DELTA_INACTIVE'] = {
    id: 'AC_DELTA_INACTIVE',
    accountId: 'ACC_DELTA',
    contactId: 'CT_CARLOS',
    cargo: 'Ex-Asistente',
    activo: false,
    eliminado: false
  };
  state.docs['account_contacts_prod/AC_OMEGA_LUIS'] = {
    id: 'AC_OMEGA_LUIS',
    accountId: 'ACC_OMEGA',
    contactId: 'CT_LUIS',
    cargo: 'Jefe de Planta',
    correo_corporativo: 'luis@omega.com',
    telefono_corporativo: '2200-5555',
    activo: true,
    eliminado: false
  };

  // Opportunities (prospects_prod)
  state.docs['prospects_prod/OPP_1'] = {
    id: 'OPP_1',
    codigo: '2026-001',
    proyecto: 'Instalación de Ductos HVAC Fase 1',
    clientId: 'ACC_DELTA',
    vendedorId: V1,
    createdBy: V1,
    etapa: 'prospecto',
    estado: 'activo',
    _version: 1,
    eliminado: false
  };
  state.docs['prospects_prod/OPP_QUOTED'] = {
    id: 'OPP_QUOTED',
    codigo: '2026-002',
    proyecto: 'Mantenimiento de Silos',
    clientId: 'ACC_DELTA',
    vendedorId: V1,
    createdBy: V1,
    etapa: 'cotizacion',
    estado: 'activo',
    precio_cotizado: 25000,
    cotizaciones: ['doc_1.pdf'],
    _version: 1,
    eliminado: false
  };
  state.docs['prospects_prod/OPP_V2'] = {
    id: 'OPP_V2',
    codigo: '2026-003',
    proyecto: 'Proyecto Exclusivo Omega',
    clientId: 'ACC_OMEGA',
    vendedorId: V2,
    createdBy: V2,
    etapa: 'prospecto',
    estado: 'activo',
    _version: 1,
    eliminado: false
  };
}

describe('Opportunity Contacts & Roles — Backend Unit Tests (Phase 2 Block B2)', () => {
  let svc;

  beforeEach(() => {
    state.docs = {};
    state.hooks = {};
    seedUsers();
    seedData();
    svc = createOpportunityContactsService({
      db: admin.firestore(),
      FieldValue,
      suffix: '_prod',
      now: () => new Date('2026-11-03T10:00:00.000Z'),
      verifyManager: async (uid) => uid === 'uid-mgr'
    });
  });

  // =========================================================================
  // 1. Roles Catalogue
  // =========================================================================
  describe('Roles Catalogue', () => {
    test('listOpportunityContactRoles is strictly read-only and does not write to Firestore when catalogue is empty', async () => {
      const res = await svc.listOpportunityContactRoles({ caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' } });
      expect(res.roles).toEqual([]);
      // Zero writes verification: no role documents in state
      const roleDocs = Object.keys(state.docs).filter(k => k.startsWith('opportunity_contact_roles_prod/'));
      expect(roleDocs).toHaveLength(0);
    });

    test('seedOpportunityContactRoles explicitly seeds initial 8 roles and restricts to managers', async () => {
      // Vendedor rejected
      await expect(
        svc.seedOpportunityContactRoles({ caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' } })
      ).rejects.toThrow('Solo un gerente puede inicializar el catálogo de roles');

      // Gestor rejected
      await expect(
        svc.seedOpportunityContactRoles({ caller: { uid: 'uid-ges', cid: GES, role: 'gestor' } })
      ).rejects.toThrow('Solo un gerente puede inicializar el catálogo de roles');

      // Manager allowed: seeds roles and writes atomic audit entry
      const seeded = await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' } });
      expect(seeded.status).toBe('seeded');
      expect(seeded.count).toBe(8);
      expect(seeded.auditId).toBeDefined();

      // Verify audit document in commercialAudit_prod
      const auditDocs = Object.keys(state.docs)
        .filter(k => k.startsWith('commercialAudit_prod/'))
        .map(k => state.docs[k]);
      const seedAudit = auditDocs.find(a => a.action === 'seedOpportunityContactRoles');
      expect(seedAudit).toBeDefined();
      expect(seedAudit.targetId).toBe('opportunity_contact_roles_prod');
      expect(seedAudit.userId).toBe(MGR);
      expect(seedAudit.userName).toBe('Gerente General');
      expect(seedAudit.userRole).toBe('manager');
      expect(seedAudit.details).toMatchObject({
        action: 'seedOpportunityContactRoles',
        entidad: 'opportunity_contact_roles_prod',
        entorno: '_prod',
        rolesCount: 8,
        force: false,
        resultado: 'seeded',
        roleIds: expect.arrayContaining(['decisor', 'comprador_economico'])
      });

      // Re-seeding without force reports already-seeded idempotently
      const reseed = await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
      expect(reseed.status).toBe('already-seeded');

      // Query now returns 8 roles
      const list = await svc.listOpportunityContactRoles({ caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' } });
      expect(list.roles).toHaveLength(8);
      expect(list.roles.map(r => r.name)).toEqual([
        'Decisor',
        'Comprador Económico',
        'Evaluador Técnico',
        'Influenciador',
        'Usuario',
        'Patrocinador Ejecutivo',
        'Compras',
        'Otro'
      ]);
    });

    test('seedOpportunityContactRoles with force:true overwrites catalogue and generates transactional audit', async () => {
      // First seed
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' } });

      // Modify a role name
      await svc.manageOpportunityContactRole({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        roleId: 'decisor',
        name: 'Rol Alterado'
      });
      const checkModified = await svc.listOpportunityContactRoles({ caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' } });
      expect(checkModified.roles.find(r => r.id === 'decisor').name).toBe('Rol Alterado');

      // Re-seed with force: true
      const forceRes = await svc.seedOpportunityContactRoles({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager', name: 'Gerente General' },
        force: true
      });
      expect(forceRes.status).toBe('seeded');
      expect(forceRes.count).toBe(8);

      // Decisor role was restored to original
      const checkRestored = await svc.listOpportunityContactRoles({ caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' } });
      expect(checkRestored.roles.find(r => r.id === 'decisor').name).toBe('Decisor');

      // Audit trail contains force: true record
      const auditDocs = Object.keys(state.docs)
        .filter(k => k.startsWith('commercialAudit_prod/'))
        .map(k => state.docs[k]);
      const forceAudit = auditDocs.find(a => a.action === 'seedOpportunityContactRoles' && a.details && a.details.force === true);
      expect(forceAudit).toBeDefined();
      expect(forceAudit.details.rolesCount).toBe(8);
      expect(forceAudit.details.resultado).toBe('seeded');
    });

    test('restricts role creation and update to managers only', async () => {
      // Vendedor rejected
      await expect(
        svc.manageOpportunityContactRole({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          roleId: 'decisor',
          name: 'Decisor Modificado'
        })
      ).rejects.toThrow('Solo un gerente');

      // Gestor rejected
      await expect(
        svc.manageOpportunityContactRole({
          caller: { uid: 'uid-ges', cid: GES, role: 'gestor' },
          roleId: 'decisor',
          name: 'Decisor Modificado'
        })
      ).rejects.toThrow('Solo un gerente');

      // Manager allowed
      const updated = await svc.manageOpportunityContactRole({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        roleId: 'decisor',
        name: 'Tomador de Decisiones'
      });
      expect(updated.status).toBe('updated');
      expect(updated.role.name).toBe('Tomador de Decisiones');
    });

    test('permits activating and deactivating roles in catalogue', async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
      await svc.listOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });

      // Deactivate 'otro'
      await svc.manageOpportunityContactRole({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        roleId: 'otro',
        activo: false
      });

      // Sellers do not see inactive roles
      const sellerList = await svc.listOpportunityContactRoles({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
        includeInactive: false
      });
      expect(sellerList.roles.find(r => r.id === 'otro')).toBeUndefined();

      // Manager can see inactive when requested
      const mgrList = await svc.listOpportunityContactRoles({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        includeInactive: true
      });
      const otroRole = mgrList.roles.find(r => r.id === 'otro');
      expect(otroRole).toBeDefined();
      expect(otroRole.activo).toBe(false);
    });

    test('preserves historical roleName snapshot in participant when catalogue role is renamed', async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });

      // Assign participant with role 'decisor'
      const assigned = await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: false
      });
      expect(assigned.participant.roleName).toBe('Decisor');

      // Manager renames catalogue role
      await svc.manageOpportunityContactRole({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        roleId: 'decisor',
        name: 'Presidente o Director General'
      });

      // Stored participant document still preserves original historical snapshot
      const participantDoc = state.docs[`opportunity_contacts_prod/${assigned.participant.id}`];
      expect(participantDoc.roleName).toBe('Decisor');
    });
  });

  // =========================================================================
  // 2. Model & Authorization (Assignments)
  // =========================================================================
  describe('Model & Authorization', () => {
    beforeEach(async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
    });

    test('valid assignment captures contactSnapshot and creates deterministic ID', async () => {
      const res = await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'evaluador_tecnico',
        notes: 'Revisa planos y calibres',
        isPrimary: false
      });

      expect(res.status).toBe('created');
      expect(res.participant.id).toBe('OC_OPP_1_AC_DELTA_CARLOS');
      expect(res.participant.accountId).toBe('ACC_DELTA');
      expect(res.participant.roleName).toBe('Evaluador Técnico');
      expect(res.participant.estado_participacion).toBe('activo');
      expect(res.participant.isPrimary).toBe(false);

      // Verify contact snapshot
      expect(res.participant.contactSnapshot).toEqual({
        contactId: 'CT_CARLOS',
        nombre: 'Carlos Roberto Mendoza Gómez',
        cargo: 'Gerente de Mantenimiento',
        correo: 'c.mendoza@constructora-delta.com',
        telefono: '2200-3333',
        extension: '104'
      });
    });

    test('strictly rejects assignment of a contact belonging to a different account', async () => {
      // OPP_1 belongs to ACC_DELTA, AC_OMEGA_LUIS belongs to ACC_OMEGA
      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          accountContactId: 'AC_OMEGA_LUIS',
          roleId: 'decisor'
        })
      ).rejects.toThrow('El contacto no pertenece a la cuenta de la oportunidad');
    });

    test('strictly rejects inactive account relation', async () => {
      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          accountContactId: 'AC_DELTA_INACTIVE',
          roleId: 'compras'
        })
      ).rejects.toThrow('El contacto no posee una relación activa con la cuenta');
    });

    test('strictly rejects non-existent account-contact relation', async () => {
      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          accountContactId: 'AC_NON_EXISTENT',
          roleId: 'compras'
        })
      ).rejects.toThrow('La relación persona-cuenta especificada no existe');
    });

    test('strictly rejects inactive catalogue role', async () => {
      await svc.manageOpportunityContactRole({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        roleId: 'otro',
        activo: false
      });

      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          accountContactId: 'AC_DELTA_CARLOS',
          roleId: 'otro'
        })
      ).rejects.toThrow('El rol seleccionado no está activo');
    });

    test('enforces portfolio isolation between sellers', async () => {
      // V1 trying to access OPP_V2 (belongs to V2) -> denied
      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_V2',
          accountContactId: 'AC_OMEGA_LUIS',
          roleId: 'decisor'
        })
      ).rejects.toThrow('No tienes acceso a esta oportunidad');

      // V1 trying to list participants of OPP_V2 -> denied
      await expect(
        svc.listOpportunityContacts({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_V2'
        })
      ).rejects.toThrow('No tienes acceso a esta oportunidad');

      // Manager and Gestor can access OPP_V2
      const mgrList = await svc.listOpportunityContacts({
        caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
        opportunityId: 'OPP_V2'
      });
      expect(mgrList.contacts).toEqual([]);
    });

    test('rejects duplicate active participation in the same opportunity', async () => {
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'evaluador_tecnico'
      });

      await expect(
        svc.addOpportunityContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          accountContactId: 'AC_DELTA_CARLOS',
          roleId: 'decisor'
        })
      ).rejects.toThrow('El contacto ya participa activamente en esta oportunidad');
    });
  });

  // =========================================================================
  // 3. Primary Contact Lifecycle & Invariants
  // =========================================================================
  describe('Primary Contact Lifecycle', () => {
    beforeEach(async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
    });

    test('designating initial primary contact updates prospect SSOT and synchronizes projection', async () => {
      const res = await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });

      expect(res.participant.isPrimary).toBe(true);

      // Verify prospect document SSOT
      const prospect = state.docs['prospects_prod/OPP_1'];
      expect(prospect.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_CARLOS');
      expect(prospect.primaryContactSnapshot).toEqual(res.participant.contactSnapshot);
      expect(prospect._version).toBe(2);
    });

    test('substituting primary contact atomically unmarks previous primary and marks new primary', async () => {
      // 1. Add Carlos as primary
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });

      // 2. Add Ana as regular participant
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'comprador_economico',
        isPrimary: false
      });

      // Verify initial state
      expect(state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'].isPrimary).toBe(true);
      expect(state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'].isPrimary).toBe(false);
      expect(state.docs['prospects_prod/OPP_1'].primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_CARLOS');

      // 3. Promote Ana to primary via setOpportunityPrimaryContact
      const promoteRes = await svc.setOpportunityPrimaryContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA'
      });
      expect(promoteRes.status).toBe('updated');
      expect(promoteRes.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_ANA');

      // Invariant: Never two primary contacts!
      const carlosDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];
      const anaDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'];
      const prospectDoc = state.docs['prospects_prod/OPP_1'];

      expect(carlosDoc.isPrimary).toBe(false);
      expect(anaDoc.isPrimary).toBe(true);
      expect(prospectDoc.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_ANA');
      expect(prospectDoc.primaryContactSnapshot.nombre).toBe('Ana María López Ramos');
    });

    test('OCC detects concurrent conflicts on setOpportunityPrimaryContact', async () => {
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'comprador_economico',
        isPrimary: false
      });

      // Opp version is now 2. Caller sends expectedVersion = 1 (stale)
      await expect(
        svc.setOpportunityPrimaryContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA',
          expectedVersion: 1
        })
      ).rejects.toThrow('Conflicto de concurrencia al designar contacto principal');
    });

    test('concurrent racing operations with Promise.all guarantee exactly one primary contact', async () => {
      // Setup Carlos and Ana as active participants, neither primary
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: false
      });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'comprador_economico',
        isPrimary: false
      });

      // Launch both promotions concurrently in a Promise.all race
      await Promise.all([
        svc.setOpportunityPrimaryContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS'
        }),
        svc.setOpportunityPrimaryContact({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA'
        })
      ]);

      const prospect = state.docs['prospects_prod/OPP_1'];
      const carlos = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];
      const ana = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'];

      // Invariant: Exactly ONE participant is primary, and prospect SSOT matches
      const primaryCount = (carlos.isPrimary === true ? 1 : 0) + (ana.isPrimary === true ? 1 : 0);
      expect(primaryCount).toBe(1);

      const winningId = carlos.isPrimary ? 'OC_OPP_1_AC_DELTA_CARLOS' : 'OC_OPP_1_AC_DELTA_ANA';
      expect(prospect.primaryOpportunityContactId).toBe(winningId);
      expect(prospect.primaryContactSnapshot.nombre).toBe(carlos.isPrimary ? 'Carlos Roberto Mendoza Gómez' : 'Ana María López Ramos');
    });

    test('removing primary contact clears prospect SSOT without auto-assigning another', async () => {
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'comprador_economico',
        isPrimary: false
      });

      // Remove Carlos (primary)
      const removeRes = await svc.removeOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS',
        motivo: 'Dejó de liderar el proyecto'
      });
      expect(removeRes.status).toBe('deactivated');
      expect(removeRes.clearedPrimary).toBe(true);

      const carlosDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];
      const anaDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'];
      const prospectDoc = state.docs['prospects_prod/OPP_1'];

      expect(carlosDoc.estado_participacion).toBe('inactivo');
      expect(carlosDoc.isPrimary).toBe(false);

      // Ana must NOT be auto-promoted
      expect(anaDoc.isPrimary).toBe(false);

      // Prospect primary fields MUST be null
      expect(prospectDoc.primaryOpportunityContactId).toBeNull();
      expect(prospectDoc.primaryContactSnapshot).toBeNull();
    });
  });

  // =========================================================================
  // 4. Change Opportunity Account (`changeOpportunityAccountAdmin`)
  // =========================================================================
  describe('Opportunity Account Change', () => {
    beforeEach(async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
      // Add participants to OPP_1
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'compras',
        isPrimary: false
      });
    });

    test('allows account change in stage prospecto without active quotation', async () => {
      const res = await svc.changeOpportunityAccount({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        newAccountId: 'ACC_GAMMA',
        motivo: 'El cliente transfirió el proyecto a su filial Gamma'
      });

      expect(res.status).toBe('updated');
      expect(res.newAccountId).toBe('ACC_GAMMA');

      const prospect = state.docs['prospects_prod/OPP_1'];
      expect(prospect.clientId).toBe('ACC_GAMMA');
      expect(prospect.primaryOpportunityContactId).toBeNull();
      expect(prospect.primaryContactSnapshot).toBeNull();

      // Invariant: Historical participants kept physically but marked inactive and not primary
      const carlosDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];
      const anaDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'];

      expect(carlosDoc.estado_participacion).toBe('inactivo');
      expect(carlosDoc.isPrimary).toBe(false);
      expect(anaDoc.estado_participacion).toBe('inactivo');
      expect(anaDoc.isPrimary).toBe(false);

      // Operative list without inactive returns empty
      const activeList = await svc.listOpportunityContacts({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
        opportunityId: 'OPP_1',
        includeInactive: false
      });
      expect(activeList.contacts).toEqual([]);
    });

    test('rejects account change if opportunity is in stage subsequent to prospecto', async () => {
      state.docs['prospects_prod/OPP_1'].etapa = 'levantamiento';

      await expect(
        svc.changeOpportunityAccount({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          newAccountId: 'ACC_GAMMA',
          motivo: 'Intento en levantamiento'
        })
      ).rejects.toThrow('El cambio de cuenta solo está permitido en la etapa inicial "prospecto"');
    });

    test('rejects account change if opportunity has an active quotation', async () => {
      // OPP_QUOTED is in cotizacion with price and files
      await expect(
        svc.changeOpportunityAccount({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_QUOTED',
          newAccountId: 'ACC_GAMMA',
          motivo: 'Intento con cotización'
        })
      ).rejects.toThrow();
    });

    test('rejects account change across all quotation indicator formats in the ERP', async () => {
      const cases = [
        { label: 'cotizaciones array', patch: { cotizaciones: ['oferta_v1.pdf'] } },
        { label: 'datos.doc_oferta', patch: { datos: { doc_oferta: [{ name: 'of.pdf' }] } } },
        { label: 'root doc_oferta', patch: { doc_oferta: ['of.pdf'] } },
        { label: 'datos.doc_costos', patch: { datos: { doc_costos: [{ name: 'cost.pdf' }] } } },
        { label: 'root doc_costos', patch: { doc_costos: ['cost.pdf'] } },
        { label: 'precio_cotizado > 0', patch: { precio_cotizado: 15000 } },
        { label: 'costo_venta > 0', patch: { costo_venta: 8000 } },
        { label: 'activeQuoteId flag', patch: { activeQuoteId: 'QUOTE_999' } },
        { label: 'cotizacion string', patch: { cotizacion: 'QT_123' } },
        { label: 'datos.cotizaciones array', patch: { datos: { cotizaciones: ['q1.pdf'] } } }
      ];

      for (const c of cases) {
        state.docs['prospects_prod/OPP_TEST_QUOTE'] = {
          id: 'OPP_TEST_QUOTE',
          codigo: '2026-999',
          proyecto: 'Proyecto Test Cotizaciones',
          clientId: 'ACC_DELTA',
          vendedorId: V1,
          createdBy: V1,
          etapa: 'prospecto',
          estado: 'activo',
          _version: 1,
          eliminado: false,
          ...c.patch
        };

        await expect(
          svc.changeOpportunityAccount({
            caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
            opportunityId: 'OPP_TEST_QUOTE',
            newAccountId: 'ACC_GAMMA',
            motivo: `Intento con ${c.label}`
          })
        ).rejects.toThrow('No se puede cambiar la cuenta si existe una cotización activa');
      }
    });

    test('rejects account change to an account outside seller portfolio', async () => {
      // V1 cannot transfer OPP_1 to ACC_OMEGA (ACC_OMEGA belongs to V2)
      await expect(
        svc.changeOpportunityAccount({
          caller: { uid: 'uid-v1', cid: V1, role: 'vendedor' },
          opportunityId: 'OPP_1',
          newAccountId: 'ACC_OMEGA',
          motivo: 'Transferencia no autorizada'
        })
      ).rejects.toThrow('No tiene permisos para transferir la oportunidad a esta cuenta');
    });
  });

  // =========================================================================
  // 5. Logical Deletion of Opportunity (`deleteProspectAdmin`)
  // =========================================================================
  describe('Logical Deletion Cascades', () => {
    beforeEach(async () => {
      await svc.seedOpportunityContactRoles({ caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' } });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true
      });
      await svc.addOpportunityContact({
        caller: { uid: 'uid-v1', cid: V1, role: 'vendedor', name: 'Vendedor Uno' },
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'evaluador_tecnico',
        isPrimary: false
      });
    });

    test('deleteProspectAdmin cascades logical deletion to all subordinate participants and clears primary fields', async () => {
      // Call deleteProspectAdmin as manager
      const res = await deleteProspectAdmin(
        { prospectId: 'OPP_1', motivo: 'Proyecto cancelado por el cliente' },
        ctx('uid-mgr', { manager: true, cid: MGR })
      );
      expect(res.status).toBe('deleted');

      // Check prospect
      const prospect = state.docs['prospects_prod/OPP_1'];
      expect(prospect.eliminado).toBe(true);
      expect(prospect.primaryOpportunityContactId).toBeNull();
      expect(prospect.primaryContactSnapshot).toBeNull();

      // Check all participants: eliminado = true, estado_participacion = 'inactivo', isPrimary = false
      const carlosDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];
      const anaDoc = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_ANA'];

      expect(carlosDoc.eliminado).toBe(true);
      expect(carlosDoc.estado_participacion).toBe('inactivo');
      expect(carlosDoc.isPrimary).toBe(false);

      expect(anaDoc.eliminado).toBe(true);
      expect(anaDoc.estado_participacion).toBe('inactivo');
      expect(anaDoc.isPrimary).toBe(false);

      // Invariant: Deleted participants are excluded from operative queries
      // Querying deleted prospect throws not-found
      await expect(
        svc.listOpportunityContacts({
          caller: { uid: 'uid-mgr', cid: MGR, role: 'manager' },
          opportunityId: 'OPP_1',
          includeInactive: true
        })
      ).rejects.toThrow('La oportunidad fue eliminada');
    });

    test('handles large participant volume (> 400) without exceeding Firestore limits and completes idempotently', async () => {
      // Seed 450 participants for OPP_1
      for (let i = 1; i <= 450; i++) {
        const id = `OC_OPP_1_BULK_${i}`;
        state.docs[`opportunity_contacts_prod/${id}`] = {
          id,
          opportunityId: 'OPP_1',
          accountContactId: `AC_BULK_${i}`,
          isPrimary: i === 1,
          estado_participacion: 'activo',
          eliminado: false
        };
      }

      const res = await deleteProspectAdmin(
        { prospectId: 'OPP_1', motivo: 'Eliminación masiva de participantes' },
        ctx('uid-mgr', { manager: true, cid: MGR })
      );
      expect(res.status).toBe('deleted');

      // Verify all 450 participants are marked eliminado: true, inactivo, isPrimary: false
      let activeRemaining = 0;
      for (let i = 1; i <= 450; i++) {
        const id = `OC_OPP_1_BULK_${i}`;
        const doc = state.docs[`opportunity_contacts_prod/${id}`];
        if (doc.eliminado !== true || doc.estado_participacion !== 'inactivo' || doc.isPrimary !== false) {
          activeRemaining++;
        }
      }
      expect(activeRemaining).toBe(0);
      expect(state.docs['prospects_prod/OPP_1'].eliminado).toBe(true);
    });

    test('recovers from interrupted deletion when prospect was already marked eliminado', async () => {
      // Simulate partially applied deletion where prospect is already deleted but participants remain
      state.docs['prospects_prod/OPP_1'].eliminado = true;
      state.docs['prospects_prod/OPP_1'].motivo_eliminacion = 'Eliminación interrumpida previa';

      state.docs['opportunity_contacts_prod/OC_REMAINING_1'] = {
        id: 'OC_REMAINING_1',
        opportunityId: 'OPP_1',
        estado_participacion: 'activo',
        isPrimary: true,
        eliminado: false
      };
      state.docs['opportunity_contacts_prod/OC_REMAINING_2'] = {
        id: 'OC_REMAINING_2',
        opportunityId: 'OPP_1',
        estado_participacion: 'activo',
        isPrimary: false,
        eliminado: false
      };

      // Retry deleteProspectAdmin
      const retryRes = await deleteProspectAdmin(
        { prospectId: 'OPP_1', motivo: 'Reintento de recuperación' },
        ctx('uid-mgr', { manager: true, cid: MGR })
      );

      expect(retryRes.status).toBe('deleted');
      expect(retryRes.recoveredParticipants).toBeGreaterThanOrEqual(2);

      expect(state.docs['opportunity_contacts_prod/OC_REMAINING_1'].eliminado).toBe(true);
      expect(state.docs['opportunity_contacts_prod/OC_REMAINING_2'].eliminado).toBe(true);

      // Third call when all participants are already clean returns unchanged
      const thirdRes = await deleteProspectAdmin(
        { prospectId: 'OPP_1', motivo: 'Tercer llamado idempotente' },
        ctx('uid-mgr', { manager: true, cid: MGR })
      );
      expect(thirdRes.status).toBe('unchanged');
    });
  });

  // =========================================================================
  // 6. Cloud Functions Callables Integration
  // =========================================================================
  describe('Cloud Functions Callables Integration', () => {
    beforeEach(async () => {
      await seedOpportunityContactRolesAdmin({ dbSuffix: '_prod' }, ctx('uid-mgr', { manager: true, cid: MGR }));
    });

    test('addOpportunityContactAdmin, setOpportunityPrimaryContactAdmin, and listOpportunityContactsAdmin', async () => {
      // 1. Add participant
      const addRes = await addOpportunityContactAdmin({
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true,
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(addRes.status).toBe('created');
      expect(addRes.participant.isPrimary).toBe(true);

      // 2. Add second participant
      await addOpportunityContactAdmin({
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_ANA',
        roleId: 'compras',
        isPrimary: false,
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      // 3. List
      const listRes = await listOpportunityContactsAdmin({
        opportunityId: 'OPP_1',
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(listRes.contacts).toHaveLength(2);
      expect(listRes.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_CARLOS');

      // 4. Set Ana as primary
      const setPriRes = await setOpportunityPrimaryContactAdmin({
        opportunityId: 'OPP_1',
        opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA',
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(setPriRes.status).toBe('updated');
      expect(setPriRes.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_ANA');

      // 5. Update Ana's role
      const updateRoleRes = await updateOpportunityContactRoleAdmin({
        opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA',
        roleId: 'comprador_economico',
        notes: 'Aprobación final de presupuestos',
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(updateRoleRes.status).toBe('updated');
      expect(updateRoleRes.participant.roleId).toBe('comprador_economico');
      expect(updateRoleRes.participant.notes).toBe('Aprobación final de presupuestos');

      // 6. Remove Ana
      const removeRes = await removeOpportunityContactAdmin({
        opportunityContactId: 'OC_OPP_1_AC_DELTA_ANA',
        motivo: 'Cambio de funciones',
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(removeRes.status).toBe('deactivated');
      expect(removeRes.clearedPrimary).toBe(true);
    });
  });

  // =========================================================================
  // 7. Canonical Fields Consistency & Deleted Opportunity Exclusion
  // =========================================================================
  describe('Canonical Fields Consistency & Deleted Opportunity Exclusion', () => {
    beforeEach(async () => {
      await seedOpportunityContactRolesAdmin({ dbSuffix: '_prod' }, ctx('uid-mgr', { manager: true, cid: MGR }));
    });

    test('immediately excludes deleted opportunities from all subordinate operations and listings', async () => {
      // First, create an active participant on OPP_1
      await addOpportunityContactAdmin({
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true,
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      // Soft delete OPP_1 directly
      state.docs['prospects_prod/OPP_1'].eliminado = true;
      state.docs['prospects_prod/OPP_1'].motivo_eliminacion = 'Test exclusion';

      // 1. Listing throws not-found with 'La oportunidad fue eliminada', immediately excluding it
      await expect(
        listOpportunityContactsAdmin({
          opportunityId: 'OPP_1',
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');

      // 2. addOpportunityContactAdmin fails immediately
      await expect(
        addOpportunityContactAdmin({
          opportunityId: 'OPP_1',
          accountContactId: 'AC_DELTA_ANA',
          roleId: 'compras',
          isPrimary: false,
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');

      // 3. updateOpportunityContactRoleAdmin fails immediately
      await expect(
        updateOpportunityContactRoleAdmin({
          opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS',
          roleId: 'evaluador_tecnico',
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');

      // 4. setOpportunityPrimaryContactAdmin fails immediately
      await expect(
        setOpportunityPrimaryContactAdmin({
          opportunityId: 'OPP_1',
          opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS',
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');

      // 5. removeOpportunityContactAdmin fails immediately
      await expect(
        removeOpportunityContactAdmin({
          opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS',
          motivo: 'Intento en eliminada',
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');

      // 6. changeOpportunityAccountAdmin fails immediately
      await expect(
        changeOpportunityAccountAdmin({
          opportunityId: 'OPP_1',
          newAccountId: 'ACC_GAMMA',
          motivo: 'Intento en eliminada',
          dbSuffix: '_prod'
        }, ctx('uid-v1', { cid: V1 }))
      ).rejects.toThrow('La oportunidad fue eliminada');
    });

    test('verifies single source of truth for primary contact and canonical field structures', async () => {
      // Add a primary contact
      const res = await addOpportunityContactAdmin({
        opportunityId: 'OPP_1',
        accountContactId: 'AC_DELTA_CARLOS',
        roleId: 'decisor',
        isPrimary: true,
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      expect(res.status).toBe('created');

      const opp = state.docs['prospects_prod/OPP_1'];
      const participant = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];

      // SSOT in prospect:
      expect(opp.primaryOpportunityContactId).toBe('OC_OPP_1_AC_DELTA_CARLOS');
      expect(opp.primaryContactSnapshot).toEqual({
        contactId: 'CT_CARLOS',
        nombre: 'Carlos Roberto Mendoza Gómez',
        cargo: 'Gerente de Mantenimiento',
        correo: 'c.mendoza@constructora-delta.com',
        telefono: '2200-3333',
        extension: '104'
      });

      // No parallel truth fields in prospect document:
      expect(opp.primaryContactId).toBeUndefined();
      expect(opp.primaryContactName).toBeUndefined();
      expect(opp.primaryContactEmail).toBeUndefined();
      expect(opp.primaryContactPhone).toBeUndefined();

      // Participant projection:
      expect(participant.isPrimary).toBe(true);

      // Canonical participation state:
      expect(participant.estado_participacion).toBe('activo');
      expect(participant.eliminado).toBe(false);
      // Ensure 'activo' is NOT improperly set or overriding estado_participacion on opportunity_contacts
      expect(participant.activo).toBeUndefined();

      // Remove contact: deactivates participation and clears primary snapshot, preserves historical record
      await removeOpportunityContactAdmin({
        opportunityContactId: 'OC_OPP_1_AC_DELTA_CARLOS',
        motivo: 'Salida de la empresa',
        dbSuffix: '_prod'
      }, ctx('uid-v1', { cid: V1 }));

      const updatedOpp = state.docs['prospects_prod/OPP_1'];
      const updatedPart = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];

      expect(updatedOpp.primaryOpportunityContactId).toBeNull();
      expect(updatedOpp.primaryContactSnapshot).toBeNull();
      expect(updatedPart.isPrimary).toBe(false);
      expect(updatedPart.estado_participacion).toBe('inactivo');
      expect(updatedPart.eliminado).toBe(false);

      // Deleting the entire prospect cascades logical deletion (eliminado: true)
      await deleteProspectAdmin(
        { prospectId: 'OPP_1', motivo: 'Cierre de proyecto' },
        ctx('uid-mgr', { manager: true, cid: MGR })
      );

      const cascadedOpp = state.docs['prospects_prod/OPP_1'];
      const cascadedPart = state.docs['opportunity_contacts_prod/OC_OPP_1_AC_DELTA_CARLOS'];

      expect(cascadedOpp.eliminado).toBe(true);
      expect(cascadedPart.eliminado).toBe(true);
      expect(cascadedPart.estado_participacion).toBe('inactivo');
      expect(cascadedPart.isPrimary).toBe(false);
    });
  });
});

