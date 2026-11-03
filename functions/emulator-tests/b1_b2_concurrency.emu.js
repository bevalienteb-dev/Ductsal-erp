// functions/emulator-tests/b1_b2_concurrency.emu.js
// ======================================================================================================
// DUCTSAL ERP — FASE 2 (BLOQUES B1 Y B2): SUITE DE CONCURRENCIA REAL MULTI-CLIENTE
// ======================================================================================================
// Ejecución real contra Firebase Emulator Suite (Auth: 9099, Firestore: 8080, Functions: 5001).
// NO utiliza mocks ni FakeFirebase: toda operación se procesa a través del motor Firestore real.
//
// Los 4 escenarios obligatorios de concurrencia evaluados:
//  1. Dos clientes estableciendo simultáneamente diferentes contactos principales en la misma oportunidad.
//  2. Retiro de contacto principal concurrente con asignación/promoción de uno nuevo.
//  3. Modificaciones simultáneas de períodos de vinculación B1 (desactivación concurrente con actualización).
//  4. Asignación simultánea duplicada de participantes en la misma oportunidad.
//
// Clientes independientes con SDK real, credenciales Auth aisladas, barrera de sincronización Promise.all
// y validación de invariantes leyendo directamente del Firestore Emulator mediante API REST administrativa.
// ======================================================================================================

const admin = require('firebase-admin');
const H = require('./helpers');
const { createOpportunityContactsService } = require('../opportunityContactsService');
const { createContactsService } = require('../contactsService');

const SUFFIX = '_local';
const TAG = 'conc_' + Date.now();

// Credenciales y CIDs para clientes independientes
const USERS = {
  seller1: {
    uid: `uid_seller1_${TAG}`,
    email: `seller1.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1792037387205`, // vendedor registrado en CRM
    nombre: 'Carlos Vendedor 1',
    role: 'vendedor'
  },
  seller2: {
    uid: `uid_seller2_${TAG}`,
    email: `seller2.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1792038830686`, // vendedora registrada en CRM
    nombre: 'Ana Vendedora 2',
    role: 'vendedor'
  },
  manager: {
    uid: `uid_mgr_${TAG}`,
    email: `mgr.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1000000000001`,
    nombre: 'Gerente General Conc',
    role: 'manager'
  }
};

const state = {
  tokens: {},
  appA: null,
  appB: null,
  dbA: null,
  dbB: null,
  svcA: null,
  svcB: null
};

// Sincronizador de inicio de carrera (barrera de concurrencia)
function createBarrier(count) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrived = 0;
  return {
    async enter(fn) {
      arrived++;
      if (arrived === count) {
        release();
      }
      await gate;
      return fn();
    }
  };
}

beforeAll(async () => {
  await H.assertEmulatorsUp();

  // 1. Instancias independientes del Firebase Admin SDK conectadas al Firestore Emulator
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

  state.appA = admin.initializeApp({ projectId: H.PROJECT }, `client_sdk_a_${TAG}`);
  state.appB = admin.initializeApp({ projectId: H.PROJECT }, `client_sdk_b_${TAG}`);
  state.dbA = state.appA.firestore();
  state.dbB = state.appB.firestore();

  state.svcA = createOpportunityContactsService({ db: state.dbA, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX });
  state.svcB = createOpportunityContactsService({ db: state.dbB, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX });

  // 2. Creación de usuarios con roles y CIDs en Auth Emulator y colección users_local
  for (const [key, u] of Object.entries(USERS)) {
    // Auth account
    await fetch(`${H.AUTH}/identitytoolkit.googleapis.com/v1/projects/${H.PROJECT}/accounts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: u.uid,
        email: u.email,
        password: u.password,
        displayName: u.nombre
      })
    });

    // Custom claims
    const claims = { role: u.role, cid: u.cid };
    if (u.role === 'manager') claims.manager = true;
    await fetch(`${H.AUTH}/identitytoolkit.googleapis.com/v1/projects/${H.PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: u.uid,
        customAttributes: JSON.stringify(claims)
      })
    });

    // Documento de perfil en users_local
    await H.setDoc('users_local', u.cid, {
      id: u.cid,
      authUid: u.uid,
      authProvider: 'firebase',
      nombre: u.nombre,
      email: u.email,
      role: u.role,
      activo: true
    });

    // Iniciar sesión para obtener ID token independiente
    const session = await H.signIn(u.email, u.password);
    state.tokens[key] = session.idToken;
  }

  // 3. Sembrado inicial del catálogo de roles de oportunidad si no existen
  const roles = [
    { id: 'decisor', name: 'Decisor Económico / Tomador de Decisión', orden: 10, activo: true },
    { id: 'evaluador_tecnico', name: 'Evaluador Técnico', orden: 20, activo: true },
    { id: 'sponsor_economico', name: 'Sponsor Económico', orden: 30, activo: true },
    { id: 'usuario_final', name: 'Usuario Final / Operativo', orden: 40, activo: true },
    { id: 'bloqueador', name: 'Bloqueador / Detractor', orden: 50, activo: true },
    { id: 'coach_interno', name: 'Coach Interno / Promotor', orden: 60, activo: true }
  ];
  for (const r of roles) {
    await H.setDoc('opportunity_contact_roles_local', r.id, r);
  }
});

afterAll(async () => {
  if (state.appA) await state.appA.delete().catch(() => null);
  if (state.appB) await state.appB.delete().catch(() => null);
});

describe('FASE 2 B1/B2: Concurrencia Real Multi-Cliente en Firestore Emulator', () => {

  // ====================================================================================================
  // ESCENARIO 1: Dos clientes estableciendo simultáneamente diferentes contactos principales
  // ====================================================================================================
  describe('Escenario 1: Designación Concurrente de Contacto Principal', () => {
    test('5 iteraciones concurrentes: exactamente 1 contacto principal final y SSOT consistente entre prospects y opportunityContacts', async () => {
      const ITERATIONS = 5;
      const results = [];

      for (let i = 1; i <= ITERATIONS; i++) {
        const oppId = `OPP_CONC_E1_${TAG}_${i}`;
        const accountId = `ACC_CONC_E1_${TAG}_${i}`;
        const personAId = `PER_E1_A_${TAG}_${i}`;
        const personBId = `PER_E1_B_${TAG}_${i}`;
        const acAId = `AC_E1_A_${TAG}_${i}`;
        const acBId = `AC_E1_B_${TAG}_${i}`;
        const ocAId = `OC_${oppId}_${acAId}`;
        const ocBId = `OC_${oppId}_${acBId}`;

        // 1. Sembrado directo del estado inicial en Firestore Emulator
        await H.setDoc('clients_local', accountId, {
          id: accountId,
          empresa: `Cliente Concurrente E1 ${i}`,
          visibleTo: [USERS.seller1.cid, USERS.seller2.cid, USERS.manager.cid],
          activo: true
        });

        await H.setDoc('contacts_local', personAId, {
          id: personAId,
          nombres: `Persona A ${i}`,
          apellidos: 'Test',
          correo: `perA_${i}@ductsal.test`
        });
        await H.setDoc('contacts_local', personBId, {
          id: personBId,
          nombres: `Persona B ${i}`,
          apellidos: 'Test',
          correo: `perB_${i}@ductsal.test`
        });

        await H.setDoc('account_contacts_local', acAId, {
          id: acAId,
          accountId,
          contactId: personAId,
          cargo: 'Gerente General',
          activo: true
        });
        await H.setDoc('account_contacts_local', acBId, {
          id: acBId,
          accountId,
          contactId: personBId,
          cargo: 'Director Comercial',
          activo: true
        });

        await H.setDoc('prospects_local', oppId, {
          id: oppId,
          clientId: accountId,
          vendedorId: USERS.seller1.cid,
          createdBy: USERS.seller1.cid,
          estado: 'prospecto',
          primaryOpportunityContactId: null,
          _version: 0,
          datos: {}
        });

        await H.setDoc('opportunity_contacts_local', ocAId, {
          id: ocAId,
          opportunityId: oppId,
          accountId,
          accountContactId: acAId,
          roleId: 'decisor',
          roleName: 'Decisor Económico',
          isPrimary: false,
          estado_participacion: 'activo',
          eliminado: false
        });
        await H.setDoc('opportunity_contacts_local', ocBId, {
          id: ocBId,
          opportunityId: oppId,
          accountId,
          accountContactId: acBId,
          roleId: 'sponsor_economico',
          roleName: 'Sponsor Económico',
          isPrimary: false,
          estado_participacion: 'activo',
          eliminado: false
        });

        // 2. Disparo concurrente multi-cliente con barrera sincronizada
        const barrier = createBarrier(2);

        const callClient1 = barrier.enter(() =>
          H.callFunction('setOpportunityPrimaryContactAdmin', {
            opportunityId: oppId,
            opportunityContactId: ocAId,
            dbSuffix: SUFFIX
          }, state.tokens.seller1)
        );

        const callClient2 = barrier.enter(() =>
          H.callFunction('setOpportunityPrimaryContactAdmin', {
            opportunityId: oppId,
            opportunityContactId: ocBId,
            dbSuffix: SUFFIX
          }, state.tokens.manager)
        );

        const [res1, res2] = await Promise.all([callClient1, callClient2]);

        // Ambos llamados deben completarse con éxito (uno gana la primera escritura, el otro reintenta y actualiza)
        expect(res1.httpStatus).toBe(200);
        expect(res2.httpStatus).toBe(200);
        expect(res1.result.status).toBe('updated');
        expect(res2.result.status).toBe('updated');

        // 3. Inspección directa de invariantes en el Firestore Emulator (Admin bypass)
        const finalProspect = await H.getDoc('prospects_local', oppId);
        expect(finalProspect).not.toBeNull();
        const primaryId = finalProspect.data.primaryOpportunityContactId;
        expect([ocAId, ocBId]).toContain(primaryId);

        const finalOcA = await H.getDoc('opportunity_contacts_local', ocAId);
        const finalOcB = await H.getDoc('opportunity_contacts_local', ocBId);
        expect(finalOcA).not.toBeNull();
        expect(finalOcB).not.toBeNull();

        // Invariante estricto: EXACTAMENTE UNO es primary y coincide con prospects_local
        if (primaryId === ocAId) {
          expect(finalOcA.data.isPrimary).toBe(true);
          expect(finalOcB.data.isPrimary).toBe(false);
        } else {
          expect(finalOcA.data.isPrimary).toBe(false);
          expect(finalOcB.data.isPrimary).toBe(true);
        }

        // El número de versión debió incrementarse por ambas transacciones
        expect(finalProspect.data._version).toBeGreaterThanOrEqual(1);

        results.push({ iteration: i, winner: primaryId.split('_').slice(-2).join('_'), version: finalProspect.data._version });
      }

      expect(results).toHaveLength(ITERATIONS);
    }, 45000);
  });

  // ====================================================================================================
  // ESCENARIO 2: Retiro de contacto principal concurrente con asignación de uno nuevo
  // ====================================================================================================
  describe('Escenario 2: Retiro Concurrente vs Nueva Designación de Principal', () => {
    test('Retiro de contacto A concurrente con designación de contacto B: estado final libre de huérfanos y SSOT preservado', async () => {
      const ITERATIONS = 3;

      for (let i = 1; i <= ITERATIONS; i++) {
        const oppId = `OPP_CONC_E2_${TAG}_${i}`;
        const accountId = `ACC_CONC_E2_${TAG}_${i}`;
        const personAId = `PER_E2_A_${TAG}_${i}`;
        const personBId = `PER_E2_B_${TAG}_${i}`;
        const acAId = `AC_E2_A_${TAG}_${i}`;
        const acBId = `AC_E2_B_${TAG}_${i}`;
        const ocAId = `OC_${oppId}_${acAId}`;
        const ocBId = `OC_${oppId}_${acBId}`;

        // Sembrado: OC_A comienza como contacto principal
        await H.setDoc('clients_local', accountId, {
          id: accountId,
          empresa: `Cliente Concurrente E2 ${i}`,
          visibleTo: [USERS.seller1.cid, USERS.manager.cid],
          activo: true
        });

        await H.setDoc('contacts_local', personAId, {
          id: personAId,
          nombres: `Persona Titular ${i}`,
          apellidos: 'Retiro',
          correo: `ret_${i}@ductsal.test`
        });
        await H.setDoc('contacts_local', personBId, {
          id: personBId,
          nombres: `Persona Nueva ${i}`,
          apellidos: 'Promocion',
          correo: `new_${i}@ductsal.test`
        });

        await H.setDoc('account_contacts_local', acAId, {
          id: acAId, accountId, contactId: personAId, cargo: 'Director Saliente', activo: true
        });
        await H.setDoc('account_contacts_local', acBId, {
          id: acBId, accountId, contactId: personBId, cargo: 'Director Entrante', activo: true
        });

        await H.setDoc('prospects_local', oppId, {
          id: oppId,
          clientId: accountId,
          vendedorId: USERS.seller1.cid,
          createdBy: USERS.seller1.cid,
          estado: 'prospecto',
          primaryOpportunityContactId: ocAId,
          _version: 1,
          datos: {}
        });

        await H.setDoc('opportunity_contacts_local', ocAId, {
          id: ocAId,
          opportunityId: oppId,
          accountId,
          accountContactId: acAId,
          roleId: 'decisor',
          roleName: 'Decisor Económico',
          isPrimary: true,
          estado_participacion: 'activo',
          eliminado: false
        });
        await H.setDoc('opportunity_contacts_local', ocBId, {
          id: ocBId,
          opportunityId: oppId,
          accountId,
          accountContactId: acBId,
          roleId: 'evaluador_tecnico',
          roleName: 'Evaluador Técnico',
          isPrimary: false,
          estado_participacion: 'activo',
          eliminado: false
        });

        // Ejecución concurrente: Cliente 1 retira OC_A; Cliente 2 promueve OC_B
        const barrier = createBarrier(2);

        const callRemoveA = barrier.enter(() =>
          H.callFunction('removeOpportunityContactAdmin', {
            opportunityContactId: ocAId,
            motivo: 'Salida de la corporación por reestructuración',
            dbSuffix: SUFFIX
          }, state.tokens.seller1)
        );

        const callPromoteB = barrier.enter(() =>
          H.callFunction('setOpportunityPrimaryContactAdmin', {
            opportunityId: oppId,
            opportunityContactId: ocBId,
            dbSuffix: SUFFIX
          }, state.tokens.manager)
        );

        const [resRemove, resPromote] = await Promise.all([callRemoveA, callPromoteB]);

        expect(resRemove.httpStatus).toBe(200);
        expect(resPromote.httpStatus).toBe(200);
        expect(resRemove.result.status).toBe('deactivated');
        expect(resPromote.result.status).toBe('updated');

        // Inspección directa en Firestore Emulator
        const finalOcA = await H.getDoc('opportunity_contacts_local', ocAId);
        const finalOcB = await H.getDoc('opportunity_contacts_local', ocBId);
        const finalOpp = await H.getDoc('prospects_local', oppId);

        // Invariantes:
        // 1. OC_A queda inactivo y NO es principal
        expect(finalOcA.data.estado_participacion).toBe('inactivo');
        expect(finalOcA.data.isPrimary).toBe(false);
        expect(finalOcA.data.motivo_retiro).toContain('Salida de la corporación');

        // 2. OC_B queda activo y es principal
        expect(finalOcB.data.estado_participacion).toBe('activo');
        expect(finalOcB.data.isPrimary).toBe(true);

        // 3. prospects_local apunta a OC_B, nunca al contacto retirado OC_A
        expect(finalOpp.data.primaryOpportunityContactId).toBe(ocBId);
        expect(finalOpp.data.primaryOpportunityContactId).not.toBe(ocAId);
      }
    }, 45000);
  });

  // ====================================================================================================
  // ESCENARIO 3: Modificaciones simultáneas de períodos de vinculación B1
  // ====================================================================================================
  describe('Escenario 3: Modificaciones Simultáneas de Períodos B1', () => {
    test('Desactivación de relación concurrente con actualización de cargo: serialización segura sin períodos huérfanos', async () => {
      const ITERATIONS = 3;

      for (let i = 1; i <= ITERATIONS; i++) {
        const accountId = `ACC_CONC_E3_${TAG}_${i}`;
        const personId = `PER_CONC_E3_${TAG}_${i}`;
        const acId = `AC_${accountId}_${personId}`;
        const periodId = `PR_CONC_INIT_${TAG}_${i}`;

        await H.setDoc('clients_local', accountId, {
          id: accountId,
          empresa: `Empresa Periodos Concurrente ${i}`,
          visibleTo: [USERS.seller1.cid, USERS.manager.cid],
          activo: true
        });

        await H.setDoc('contacts_local', personId, {
          id: personId,
          nombres: `Ingeniero ${i}`,
          apellidos: 'Operaciones',
          correo: `ing_${i}@ductsal.test`
        });

        // Relación activa con período actual abierto (fecha_fin: null)
        await H.setDoc('account_contacts_local', acId, {
          id: acId,
          accountId,
          contactId: personId,
          cargo: 'Coordinador Junior',
          activo: true,
          periodo_actual_id: periodId,
          total_periodos: 1
        });

        await H.setDoc(`account_contacts_local/${acId}/periods_local`, periodId, {
          id: periodId,
          accountContactId: acId,
          accountId,
          contactId: personId,
          cargo: 'Coordinador Junior',
          fecha_inicio: new Date().toISOString(),
          fecha_fin: null,
          motivo_salida: null
        });

        // Lanzamiento concurrente: Cliente 1 desactiva; Cliente 2 actualiza cargo
        const barrier = createBarrier(2);

        const callDeactivate = barrier.enter(() =>
          H.callFunction('deactivateAccountContactAdmin', {
            accountContactId: acId,
            motivo_salida: 'Desvinculación voluntaria',
            dbSuffix: SUFFIX
          }, state.tokens.seller1)
        );

        const callUpdate = barrier.enter(() =>
          H.callFunction('updateAccountContactAdmin', {
            accountContactId: acId,
            cargo: 'Gerente Regional de Operaciones',
            dbSuffix: SUFFIX
          }, state.tokens.manager)
        );

        const [resDeact, resUpd] = await Promise.all([callDeactivate, callUpdate]);

        // La desactivación siempre debe completarse exitosamente
        expect(resDeact.httpStatus).toBe(200);

        // La actualización puede completarse (si se ejecutó antes de desactivar) o rechazarse con failed-precondition (si la relación ya fue cerrada)
        expect([200, 400]).toContain(resUpd.httpStatus);

        // Inspección directa de invariantes en Firestore Emulator
        const finalRel = await H.getDoc('account_contacts_local', acId);
        expect(finalRel).not.toBeNull();

        const periods = await H.listDocs(`account_contacts_local/${acId}/periods_local`);
        expect(periods.length).toBeGreaterThanOrEqual(1);

        // Si la relación quedó inactiva, ningún período puede estar abierto
        if (finalRel.data.activo === false) {
          expect(finalRel.data.periodo_actual_id).toBeNull();
          const openPeriods = periods.filter(p => p.data.fecha_fin === null);
          expect(openPeriods).toHaveLength(0);

          // El período inicial debe tener fecha de fin y motivo
          const closedPeriod = periods.find(p => p.id === periodId);
          expect(closedPeriod).toBeDefined();
          expect(closedPeriod.data.fecha_fin).not.toBeNull();
        } else {
          // Si por orden de serialización quedó activa, exactamente 1 período está abierto
          const openPeriods = periods.filter(p => p.data.fecha_fin === null);
          expect(openPeriods).toHaveLength(1);
          expect(openPeriods[0].id).toBe(finalRel.data.periodo_actual_id);
        }
      }
    }, 45000);
  });

  // ====================================================================================================
  // ESCENARIO 4: Asignación simultánea duplicada de participantes
  // ====================================================================================================
  describe('Escenario 4: Asignación Simultánea Duplicada de Participantes', () => {
    test('Dos clientes intentan asignar al mismo contacto a la oportunidad simultáneamente: exactamente 1 éxito y 1 rechazo con failed-precondition', async () => {
      const ITERATIONS = 3;

      for (let i = 1; i <= ITERATIONS; i++) {
        const oppId = `OPP_CONC_E4_${TAG}_${i}`;
        const accountId = `ACC_CONC_E4_${TAG}_${i}`;
        const personId = `PER_CONC_E4_${TAG}_${i}`;
        const acId = `AC_${accountId}_${personId}`;
        const expectedOcId = `OC_${oppId}_${acId}`;

        // Sembrado del escenario
        await H.setDoc('clients_local', accountId, {
          id: accountId,
          empresa: `Empresa Asignación Duplicada ${i}`,
          visibleTo: [USERS.seller1.cid, USERS.seller2.cid, USERS.manager.cid],
          activo: true
        });

        await H.setDoc('contacts_local', personId, {
          id: personId,
          nombres: `Licenciada ${i}`,
          apellidos: 'Finanzas',
          correo: `lic_${i}@ductsal.test`
        });

        await H.setDoc('account_contacts_local', acId, {
          id: acId,
          accountId,
          contactId: personId,
          cargo: 'Directora Financiera',
          activo: true
        });

        await H.setDoc('prospects_local', oppId, {
          id: oppId,
          clientId: accountId,
          vendedorId: USERS.seller1.cid,
          createdBy: USERS.seller1.cid,
          estado: 'prospecto',
          primaryOpportunityContactId: null,
          _version: 0,
          datos: {}
        });

        // Asegurarse de que NO exista el participante
        await H.deleteDoc('opportunity_contacts_local', expectedOcId);

        // Disparo simultáneo con clientes independientes
        const barrier = createBarrier(2);

        const callAdd1 = barrier.enter(() =>
          H.callFunction('addOpportunityContactAdmin', {
            opportunityId: oppId,
            accountContactId: acId,
            roleId: 'evaluador_tecnico',
            notes: 'Asignación concurrente por Cliente A',
            dbSuffix: SUFFIX
          }, state.tokens.seller1)
        );

        const callAdd2 = barrier.enter(() =>
          H.callFunction('addOpportunityContactAdmin', {
            opportunityId: oppId,
            accountContactId: acId,
            roleId: 'sponsor_economico',
            notes: 'Asignación concurrente por Cliente B',
            dbSuffix: SUFFIX
          }, state.tokens.manager)
        );

        const [res1, res2] = await Promise.all([callAdd1, callAdd2]);

        const statuses = [res1.httpStatus, res2.httpStatus].sort();
        // Exactamente uno debe tener éxito (200) y el otro debe fallar por duplicado (400 failed-precondition)
        expect(statuses).toEqual([200, 400]);

        const successfulRes = res1.httpStatus === 200 ? res1 : res2;
        const failedRes = res1.httpStatus === 400 ? res1 : res2;

        expect(successfulRes.result.status).toBe('created');
        expect(failedRes.error).toBeDefined();
        expect(failedRes.error.message).toContain('El contacto ya participa activamente en esta oportunidad');

        // Inspección directa en Firestore Emulator
        const finalOc = await H.getDoc('opportunity_contacts_local', expectedOcId);
        expect(finalOc).not.toBeNull();
        expect(finalOc.data.opportunityId).toBe(oppId);
        expect(finalOc.data.accountContactId).toBe(acId);
        expect(finalOc.data.estado_participacion).toBe('activo');

        // Confirmar que solo existe UN documento en la colección para esta oportunidad y participante
        const allOcs = await H.listDocs('opportunity_contacts_local');
        const matches = allOcs.filter(d => d.data.opportunityId === oppId && d.data.accountContactId === acId && d.data.eliminado !== true);
        expect(matches).toHaveLength(1);
      }
    }, 45000);
  });

  // ====================================================================================================
  // SUITE COMPLEMENTARIA: Concurrencia de Driver SDK con dos instancias independientes de Firestore
  // ====================================================================================================
  describe('Prueba de Driver Multi-SDK: Dos Instancias Independientes de Firestore', () => {
    test('Instancia dbA vs Instancia dbB: OCC resuelve concurrencia transaccional cruzada limpiamente', async () => {
      const oppId = `OPP_DRIVER_OCC_${TAG}`;
      const accountId = `ACC_DRIVER_OCC_${TAG}`;
      const personAId = `PER_DRV_A_${TAG}`;
      const personBId = `PER_DRV_B_${TAG}`;
      const acAId = `AC_DRV_A_${TAG}`;
      const acBId = `AC_DRV_B_${TAG}`;
      const ocAId = `OC_${oppId}_${acAId}`;
      const ocBId = `OC_${oppId}_${acBId}`;

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: 'Cliente Driver Multi-SDK',
        visibleTo: [USERS.seller1.cid, USERS.manager.cid],
        activo: true
      });

      await H.setDoc('contacts_local', personAId, { id: personAId, nombres: 'Contacto A', apellidos: 'Driver' });
      await H.setDoc('contacts_local', personBId, { id: personBId, nombres: 'Contacto B', apellidos: 'Driver' });

      await H.setDoc('account_contacts_local', acAId, { id: acAId, accountId, contactId: personAId, cargo: 'Cargo A', activo: true });
      await H.setDoc('account_contacts_local', acBId, { id: acBId, accountId, contactId: personBId, cargo: 'Cargo B', activo: true });

      await H.setDoc('prospects_local', oppId, {
        id: oppId,
        clientId: accountId,
        vendedorId: USERS.seller1.cid,
        createdBy: USERS.seller1.cid,
        estado: 'prospecto',
        primaryOpportunityContactId: null,
        _version: 0,
        datos: {}
      });

      await H.setDoc('opportunity_contacts_local', ocAId, {
        id: ocAId, opportunityId: oppId, accountId, accountContactId: acAId, roleId: 'decisor', isPrimary: false, estado_participacion: 'activo', eliminado: false
      });
      await H.setDoc('opportunity_contacts_local', ocBId, {
        id: ocBId, opportunityId: oppId, accountId, accountContactId: acBId, roleId: 'evaluador_tecnico', isPrimary: false, estado_participacion: 'activo', eliminado: false
      });

      // svcA usa dbA (instancia cliente A); svcB usa dbB (instancia cliente B)
      const callerA = { uid: USERS.seller1.uid, cid: USERS.seller1.cid, role: 'vendedor', name: USERS.seller1.nombre };
      const callerB = { uid: USERS.manager.uid, cid: USERS.manager.cid, role: 'manager', name: USERS.manager.nombre };

      const barrier = createBarrier(2);
      const callA = barrier.enter(() => state.svcA.setOpportunityPrimaryContact({ caller: callerA, opportunityId: oppId, opportunityContactId: ocAId }));
      const callB = barrier.enter(() => state.svcB.setOpportunityPrimaryContact({ caller: callerB, opportunityId: oppId, opportunityContactId: ocBId }));

      const [resA, resB] = await Promise.all([callA, callB]);
      expect(resA.status).toBe('updated');
      expect(resB.status).toBe('updated');

      // Verificación directa en Emulator
      const oppSnap = await H.getDoc('prospects_local', oppId);
      const winId = oppSnap.data.primaryOpportunityContactId;
      expect([ocAId, ocBId]).toContain(winId);

      const snapA = await H.getDoc('opportunity_contacts_local', ocAId);
      const snapB = await H.getDoc('opportunity_contacts_local', ocBId);

      expect(snapA.data.isPrimary).toBe(winId === ocAId);
      expect(snapB.data.isPrimary).toBe(winId === ocBId);
    });
  });
});
