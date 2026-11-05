// functions/emulator-tests/b3_concurrency.emu.js
// ======================================================================================================
// DUCTSAL ERP — FASE 2 (BLOQUE B3): SUITE DE CONCURRENCIA REAL MULTI-CLIENTE
// ======================================================================================================
// Ejecución real contra Firebase Emulator Suite (Auth: 9099, Firestore: 8080, Functions: 5001).
// NO utiliza mocks ni FakeFirebase: toda operación se procesa a través del motor Firestore real.
//
// Escenarios obligatorios de concurrencia B3 evaluados:
//  1. Otorgamiento de poder concurrente con nueva elección de Representante Legal (invariante de anulación atómica).
//  2. Elecciones simultáneas concurrentes de Representante Legal (SSOT y estado 'vigente' único).
//  3. Cierre de oportunidad concurrente con invalidación de poder de firmante.
//  4. Confirmaciones bienales concurrentes en escritura societaria.
// ======================================================================================================

const admin = require('firebase-admin');
const H = require('./helpers');
const { createAccountDocumentsService } = require('../accountDocumentsService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createCommercialService } = require('../commercialService');

const SUFFIX = '_local';
const TAG = 'b3_conc_' + Date.now();

const USERS = {
  admin1: {
    uid: `uid_b3_adm1_${TAG}`,
    email: `adm1.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1000000000001`,
    nombre: 'Administrador Conc 1',
    role: 'manager'
  },
  admin2: {
    uid: `uid_b3_adm2_${TAG}`,
    email: `adm2.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1000000000002`,
    nombre: 'Administrador Conc 2',
    role: 'manager'
  },
  seller: {
    uid: `uid_b3_seller_${TAG}`,
    email: `seller.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: `1792037387205`,
    nombre: 'Carlos Vendedor B3',
    role: 'vendedor'
  }
};

const state = {
  tokens: {},
  appA: null,
  appB: null,
  dbA: null,
  dbB: null,
  docSvcA: null,
  docSvcB: null,
  wfSvcA: null,
  wfSvcB: null
};

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

  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

  state.appA = admin.initializeApp({ projectId: H.PROJECT }, `b3_client_sdk_a_${TAG}`);
  state.appB = admin.initializeApp({ projectId: H.PROJECT }, `b3_client_sdk_b_${TAG}`);
  state.dbA = state.appA.firestore();
  state.dbB = state.appB.firestore();

  state.docSvcA = createAccountDocumentsService({ db: state.dbA, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX });
  state.docSvcB = createAccountDocumentsService({ db: state.dbB, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX });

  const verifyManager = async () => true;
  const commSvcA = createCommercialService({ db: state.dbA, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX, verifyManager });
  const commSvcB = createCommercialService({ db: state.dbB, FieldValue: admin.firestore.FieldValue, suffix: SUFFIX, verifyManager });

  state.wfSvcA = createProspectWorkflowService({ db: state.dbA, FieldValue: admin.firestore.FieldValue, kit: commSvcA.kit, suffix: SUFFIX });
  state.wfSvcB = createProspectWorkflowService({ db: state.dbB, FieldValue: admin.firestore.FieldValue, kit: commSvcB.kit, suffix: SUFFIX });

  for (const [key, u] of Object.entries(USERS)) {
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

    await H.setDoc('users_local', u.cid, {
      id: u.cid,
      authUid: u.uid,
      authProvider: 'firebase',
      nombre: u.nombre,
      email: u.email,
      role: u.role,
      activo: true
    });

    const session = await H.signIn(u.email, u.password);
    state.tokens[key] = session.idToken;
  }
});

afterAll(async () => {
  if (state.appA) await state.appA.delete().catch(() => null);
  if (state.appB) await state.appB.delete().catch(() => null);
});

describe('FASE 2 B3: Concurrencia Real Multi-Cliente en Firestore Emulator', () => {

  // ====================================================================================================
  // ESCENARIO 1: Otorgamiento de poder vs Nueva Elección de Representante Legal
  // Invariante estricto: Todo poder del período anterior debe quedar en 'anulado_por_nueva_eleccion'.
  // Bajo ninguna circunstancia un poder del período previo puede quedar 'vigente'.
  // ====================================================================================================
  describe('Escenario 1: Otorgamiento de Poder vs Nueva Elección Concurrente de RL', () => {
    test('Carrera concurrente: invariante de anulación atómica e integridad de apoderadosVigentes', async () => {
      const accountId = `CLI_B3_CONC_E1_${TAG}`;
      const contactAId = `CONT_B3_E1_A_${TAG}`;
      const contactBId = `CONT_B3_E1_B_${TAG}`;

      // Sembrado inicial de cliente jurídico con Representante Legal Período 1
      const initialTerm = {
        termId: `term_init_${TAG}`,
        nombre: 'Ing. Rodrigo Méndez',
        cargo: 'Presidente de Junta Directiva',
        contactId: contactAId,
        fechaEleccion: '2024-01-15',
        fechaVencimiento: '2027-01-15',
        estado: 'vigente',
        credencialDoc: { name: 'credencial_mendez.pdf', storagePath: 'prod_files/clients/test/legal/c1.pdf' },
        duiDoc: { name: 'dui_mendez.pdf', storagePath: 'prod_files/clients/test/identificacion/d1.pdf' }
      };

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Corporación Industrial B3 Concurrente ${TAG}`,
        tipo: 'juridica',
        representanteLegalVigente: initialTerm,
        apoderadosVigentes: [],
        documentos: {
          credencial: initialTerm.credencialDoc,
          dui: initialTerm.duiDoc
        },
        visibleTo: [USERS.admin1.cid, USERS.admin2.cid, USERS.seller.cid],
        activo: true
      });

      // Subcolección con el período inicial
      await H.setDoc(`clients_local/${accountId}/legal_representative_terms`, initialTerm.termId, initialTerm);

      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const callerB = { uid: USERS.admin2.uid, email: USERS.admin2.email, role: 'manager', cid: USERS.admin2.cid, profileId: USERS.admin2.cid, name: USERS.admin2.nombre };

      // Configurar barrera para disparo simultáneo
      const barrier = createBarrier(2);

      const promisePower = barrier.enter(() =>
        state.docSvcA.grantContractPower({
          caller: callerA,
          accountId,
          contactId: contactBId,
          documento: {
            name: 'poder_morales.pdf',
            storagePath: 'prod_files/clients/test/poderes/p1.pdf',
            nombreApoderado: 'Lic. Claudia Morales',
            tipoPoder: 'especial',
            facultadFirmaContratos: true,
            fechaOtorgamiento: '2025-06-01',
            fechaVencimiento: '2026-12-31',
            notario: 'Lic. Samuel Rivera'
          }
        }).catch(err => ({ error: err.message }))
      );

      const promiseNewRL = barrier.enter(() =>
        state.docSvcB.registerLegalRepresentativeTerm({
          caller: callerB,
          accountId,
          contactId: contactBId,
          nombre: 'Licda. Gabriela Solís',
          cargo: 'Directora Ejecutiva y Rep. Legal',
          fechaEleccion: '2026-01-10',
          fechaVencimiento: '2029-01-10',
          credencialDoc: { name: 'credencial_solis.pdf', storagePath: 'prod_files/clients/test/legal/c2.pdf' },
          duiDoc: { name: 'dui_solis.pdf', storagePath: 'prod_files/clients/test/identificacion/d2.pdf' }
        }).catch(err => ({ error: err.message }))
      );

      const [resPower, resNewRL] = await Promise.all([promisePower, promiseNewRL]);

      // Verificación directa en Firestore
      const snap = await H.getDoc('clients_local', accountId);
      const clientDoc = snap.data;
      const rlFinal = clientDoc.representanteLegalVigente;
      const powersFinal = clientDoc.apoderadosVigentes || [];

      expect(resNewRL.error).toBeUndefined();
      expect(rlFinal).toBeDefined();
      expect(rlFinal.nombre).toBe('Licda. Gabriela Solís');
      expect(rlFinal.estado).toBe('vigente');

      // INVARIANTE CRÍTICO B3:
      // Ningún poder del período anterior (asociado a Rodrigo Méndez) puede quedar como 'vigente'.
      for (const pw of powersFinal) {
        expect(pw.termId).toBe(rlFinal.termId);
      }

      // Si el poder fue otorgado, su estado en subcolección debe ser 'anulado_por_nueva_eleccion' si pertenecía a initialTerm
      if (!resPower.error && resPower.powerId) {
        const pwSnap = await H.getDoc(`clients_local/${accountId}/contract_powers`, resPower.powerId);
        const powerInDb = pwSnap.data;
        if (powerInDb.termId === initialTerm.termId) {
          expect(powerInDb.estado).toBe('anulado_por_nueva_eleccion');
        }
      }
    });
  });

  // ====================================================================================================
  // ESCENARIO 2: Elecciones concurrentes de Representante Legal
  // Exactamente una elección debe prevalecer como activa y vigente.
  // ====================================================================================================
  describe('Escenario 2: Elecciones Concurrentes de Representante Legal', () => {
    test('Dos administradores registrando elecciones simultáneamente: exactamente 1 RL vigente y consistente', async () => {
      const accountId = `CLI_B3_CONC_E2_${TAG}`;

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Distribuidora Salvadoreña ${TAG}`,
        tipo: 'juridica',
        visibleTo: [USERS.admin1.cid, USERS.admin2.cid],
        activo: true
      });

      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const callerB = { uid: USERS.admin2.uid, email: USERS.admin2.email, role: 'manager', cid: USERS.admin2.cid, profileId: USERS.admin2.cid, name: USERS.admin2.nombre };

      const barrier = createBarrier(2);

      const promiseA = barrier.enter(() =>
        state.docSvcA.registerLegalRepresentativeTerm({
          caller: callerA,
          accountId,
          nombre: 'Ing. Carlos Mendoza (Candidato A)',
          cargo: 'Presidente',
          fechaEleccion: '2025-01-01',
          fechaVencimiento: '2028-01-01',
          credencialDoc: { name: 'cred_a.pdf', storagePath: 'prod_files/clients/test/legal/ca.pdf' },
          duiDoc: { name: 'dui_a.pdf', storagePath: 'prod_files/clients/test/identificacion/da.pdf' }
        })
      );

      const promiseB = barrier.enter(() =>
        state.docSvcB.registerLegalRepresentativeTerm({
          caller: callerB,
          accountId,
          nombre: 'Dra. Patricia Alfaro (Candidata B)',
          cargo: 'Presidenta',
          fechaEleccion: '2025-01-02',
          fechaVencimiento: '2028-01-02',
          credencialDoc: { name: 'cred_b.pdf', storagePath: 'prod_files/clients/test/legal/cb.pdf' },
          duiDoc: { name: 'dui_b.pdf', storagePath: 'prod_files/clients/test/identificacion/db.pdf' }
        })
      );

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      // Ambas transacciones completan secuencialmente vía transacciones de Firestore
      expect(resA.termId).toBeDefined();
      expect(resB.termId).toBeDefined();

      const snap = await H.getDoc('clients_local', accountId);
      const clientDoc = snap.data;
      const rlFinal = clientDoc.representanteLegalVigente;

      expect(rlFinal).toBeDefined();
      expect(rlFinal.estado).toBe('vigente');
      // Debe ser o Candidato A o Candidata B
      expect(['Ing. Carlos Mendoza (Candidato A)', 'Dra. Patricia Alfaro (Candidata B)']).toContain(rlFinal.nombre);
    });
  });

  // ====================================================================================================
  // ESCENARIO 3: Cierre de oportunidad con invalidación concurrente de poder
  // ====================================================================================================
  describe('Escenario 3: Finalización de Oportunidad con Poder Invalidado Concurrentemente', () => {
    test('finalizeProspect rechaza el cierre si el poder del firmante es invalidado', async () => {
      const accountId = `CLI_B3_CONC_E3_${TAG}`;
      const prospectId = `OPP_B3_CONC_E3_${TAG}`;
      const powerId = `pow_e3_${TAG}`;

      const initialTerm = {
        termId: `term_e3_init_${TAG}`,
        nombre: 'Ing. Hugo Rivas',
        cargo: 'Presidente',
        fechaEleccion: '2024-01-01',
        fechaVencimiento: '2027-01-01',
        estado: 'vigente',
        credencialDoc: { name: 'cred.pdf', storagePath: 'prod_files/clients/test/legal/c.pdf' },
        duiDoc: { name: 'dui.pdf', storagePath: 'prod_files/clients/test/identificacion/d.pdf' }
      };

      const powerDoc = {
        id: powerId,
        powerId,
        termId: initialTerm.termId,
        nombreApoderado: 'Lic. Fernando Cruz',
        facultadFirmaContratos: true,
        estado: 'vigente',
        testimonioDoc: { name: 'poder.pdf', storagePath: 'prod_files/clients/test/poderes/p.pdf' }
      };

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Construcciones Industriales ${TAG}`,
        tipo: 'juridica',
        contacto: 'Lic. Fernando Cruz',
        nit: '0614-010180-101-1',
        nrc: '123456-7',
        telefono: '7890-1234',
        correo: 'contacto@construcciones.test',
        correo_fact: 'facturacion@construcciones.test',
        representanteLegalVigente: initialTerm,
        apoderadosVigentes: [powerDoc],
        documentos: {
          dui: { name: 'dui.pdf' },
          escritura: { name: 'escritura.pdf' },
          credencial: { name: 'cred.pdf' },
          nit: { name: 'nit.pdf' },
          nrc: { name: 'nrc.pdf' }
        },
        visibleTo: [USERS.admin1.cid, USERS.seller.cid],
        activo: true
      });

      await H.setDoc(`clients_local/${accountId}/contract_powers`, powerId, powerDoc);

      await H.setDoc('prospects_local', prospectId, {
        id: prospectId,
        nombre: `Proyecto Contrato B3 ${TAG}`,
        clientId: accountId,
        etapa: 'cierre',
        estado: 'activo',
        vendedorId: USERS.seller.cid,
        tipo_proyecto: 'Instalación',
        precio_cotizado: 5000,
        requiere_contrato: true,
        firmante_cierre: { tipo: 'apoderado', powerId },
        datos: {
          doc_firmado: { name: 'contrato_firmado.pdf', storagePath: 'prod_files/proyectos/c.pdf' },
          doc_comprobante: { name: 'ccf_anticipo.pdf', storagePath: 'prod_files/facturas/f.pdf' }
        }
      });

      const callerAdmin = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const callerSeller = { uid: USERS.seller.uid, email: USERS.seller.email, role: 'vendedor', cid: USERS.seller.cid, profileId: USERS.seller.cid, name: USERS.seller.nombre };

      // Registrar nueva elección de RL para invalidar todos los poderes
      await state.docSvcA.registerLegalRepresentativeTerm({
        caller: callerAdmin,
        accountId,
        nombre: 'Lic. Roberto Lemus (Nuevo RL)',
        cargo: 'Presidente',
        fechaEleccion: '2026-02-01',
        fechaVencimiento: '2029-02-01',
        credencialDoc: { name: 'cred2.pdf', storagePath: 'prod_files/clients/test/legal/c2.pdf' },
        duiDoc: { name: 'dui2.pdf', storagePath: 'prod_files/clients/test/identificacion/d2.pdf' }
      });

      // Intentar finalizar la oportunidad con el apoderado del período anterior (incluyendo docs nuevos con motivoSustitucion en data para activar applyDocumentVersionsTx)
      await expect(
        state.wfSvcB.finalizeProspect({
          caller: callerSeller,
          prospectId,
          data: {
            forma_pago: '100% anticipado',
            factura_anticipo: 'FAC-12345',
            requiere_contrato: true,
            firmante_cierre: { tipo: 'apoderado', powerId },
            doc_firmado: { name: 'contrato_firmado_nuevo.pdf', storagePath: 'prod_files/proyectos/c_new.pdf', motivoSustitucion: 'Actualización de contrato' },
            doc_comprobante: { name: 'ccf_anticipo_nuevo.pdf', storagePath: 'prod_files/facturas/f_new.pdf', motivoSustitucion: 'Actualización de anticipo' }
          }
        })
      ).rejects.toThrow(/anulado_por_nueva_eleccion/i);
    });

    test('ALTO-01: finalizeProspect con apoderado vigente y documentos nuevos en data completa la transacción real en Firestore sin violar read-before-write', async () => {
      const accountId = `CLI_B3_CONC_E3_OK_${TAG}`;
      const prospectId = `OPP_B3_CONC_E3_OK_${TAG}`;
      const powerId = `pow_e3_ok_${TAG}`;

      const activeTerm = {
        termId: `term_e3_ok_${TAG}`,
        nombre: 'Ing. Hugo Rivas Vigente',
        cargo: 'Presidente',
        fechaEleccion: '2025-01-01',
        fechaVencimiento: '2029-01-01',
        estado: 'vigente',
        credencialDoc: { name: 'cred.pdf', storagePath: 'prod_files/clients/test/legal/c.pdf', fechaVencimiento: '2029-01-01' },
        duiDoc: { name: 'dui.pdf', storagePath: 'prod_files/clients/test/identificacion/d.pdf', fechaVencimiento: '2029-01-01' }
      };

      const activePower = {
        id: powerId,
        powerId,
        termId: activeTerm.termId,
        nombreApoderado: 'Lic. Fernando Cruz Vigente',
        facultadFirmaContratos: true,
        fechaOtorgamiento: '2025-02-01',
        fechaVencimiento: '2028-12-31',
        estado: 'vigente',
        testimonioDoc: { name: 'poder.pdf', storagePath: 'prod_files/clients/test/poderes/p.pdf' }
      };

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Construcciones Vigentes ALTO-01 ${TAG}`,
        tipo: 'juridica',
        contacto: 'Lic. Fernando Cruz Vigente',
        nit: '0614-010180-101-1',
        nrc: '123456-7',
        telefono: '7890-1234',
        correo: 'contacto@construcciones-ok.test',
        correo_fact: 'facturacion@construcciones-ok.test',
        representanteLegalVigente: activeTerm,
        apoderadosVigentes: [activePower],
        biennialReviews: {
          escritura: {
            docKey: 'escritura',
            lastConfirmedAt: new Date().toISOString(),
            nextReviewAt: '2028-01-01'
          }
        },
        documentos: {
          dui: { name: 'dui.pdf', fechaVencimiento: '2029-01-01' },
          escritura: { name: 'escritura.pdf', fechaSubida: new Date().toISOString() },
          credencial: { name: 'cred.pdf', fechaVencimiento: '2029-01-01' },
          nit: { name: 'nit.pdf' },
          nrc: { name: 'nrc.pdf' }
        },
        visibleTo: [USERS.admin1.cid, USERS.seller.cid],
        activo: true
      });

      await H.setDoc(`clients_local/${accountId}/contract_powers`, powerId, activePower);

      await H.setDoc('prospects_local', prospectId, {
        id: prospectId,
        nombre: `Proyecto Contrato ALTO-01 ${TAG}`,
        clientId: accountId,
        etapa: 'cierre',
        estado: 'activo',
        vendedorId: USERS.seller.cid,
        tipo_proyecto: 'Instalación',
        precio_cotizado: 8500,
        requiere_contrato: true,
        firmante_cierre: { tipo: 'apoderado', powerId },
        datos: {}
      });

      const callerSeller = { uid: USERS.seller.uid, email: USERS.seller.email, role: 'vendedor', cid: USERS.seller.cid, profileId: USERS.seller.cid, name: USERS.seller.nombre };

      const res = await state.wfSvcA.finalizeProspect({
        caller: callerSeller,
        prospectId,
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FAC-ALTO01-99',
          requiere_contrato: true,
          firmante_cierre: { tipo: 'apoderado', powerId },
          doc_firmado: { name: 'contrato_firmado_alto01.pdf', storagePath: 'prod_files/proyectos/c_alto01.pdf' },
          doc_comprobante: { name: 'ccf_anticipo_alto01.pdf', storagePath: 'prod_files/facturas/f_alto01.pdf' }
        }
      });

      expect(res.status).toBe('finalized');
      expect(res.estado).toBe('ganado');
      const pSnap = await H.getDoc('prospects_local', prospectId);
      expect(pSnap.data.estado).toBe('ganado');
    });
  });

  // ====================================================================================================
  // ESCENARIO 4: Confirmaciones Bienales Concurrentes
  // ====================================================================================================
  describe('Escenario 4: Confirmaciones Bienales Concurrentes', () => {
    test('Dos usuarios confirmando bienalmente la escritura sin cambios: ambas confirmaciones registradas en auditoría', async () => {
      const accountId = `CLI_B3_CONC_E4_${TAG}`;
      const versionId = `v_esc_e4_${TAG}`;

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Inversiones Bienales ${TAG}`,
        tipo: 'juridica',
        documentos: {
          escritura: {
            name: 'escritura_original.pdf',
            storagePath: 'prod_files/clients/test/legal/esc.pdf',
            fechaSubida: '2023-01-10T10:00:00Z',
            ultimaRevisionBienal: '2023-01-10',
            versionId
          }
        },
        visibleTo: [USERS.admin1.cid, USERS.admin2.cid],
        activo: true
      });

      await H.setDoc(`clients_local/${accountId}/document_versions`, versionId, {
        id: versionId,
        versionId,
        docKey: 'escritura',
        name: 'escritura_original.pdf',
        versionNumber: 1
      });

      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const callerB = { uid: USERS.admin2.uid, email: USERS.admin2.email, role: 'manager', cid: USERS.admin2.cid, profileId: USERS.admin2.cid, name: USERS.admin2.nombre };

      const barrier = createBarrier(2);

      const promiseA = barrier.enter(() =>
        state.docSvcA.recordBiennialConfirmation({
          caller: callerA,
          accountId,
          docKey: 'escritura',
          documentVersionId: versionId,
          notas: 'Confirmación Usuario A: sin reformas al pacto social'
        })
      );

      const promiseB = barrier.enter(() =>
        state.docSvcB.recordBiennialConfirmation({
          caller: callerB,
          accountId,
          docKey: 'escritura',
          documentVersionId: versionId,
          notas: 'Confirmación Usuario B: verificación notarial periódica'
        })
      );

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      expect(resA.confirmationId).toBeDefined();
      expect(resB.confirmationId).toBeDefined();

      const snap = await H.getDoc('clients_local', accountId);
      const clientDoc = snap.data;
      expect(clientDoc.biennialReviews).toBeDefined();
      expect(clientDoc.biennialReviews.escritura).toBeDefined();
      expect(clientDoc.biennialReviews.escritura.lastConfirmedAt).toBeDefined();
      expect(clientDoc.biennialReviews.escritura.nextReviewAt).toBeDefined();

      const confSnapA = await H.getDoc(`clients_local/${accountId}/biennial_confirmations`, resA.confirmationId);
      expect(confSnapA.data.confirmedNoChanges).toBe(true);
      const confSnapB = await H.getDoc(`clients_local/${accountId}/biennial_confirmations`, resB.confirmationId);
      expect(confSnapB.data.confirmedNoChanges).toBe(true);
    });

    test('Reintentos concurrentes idempotentes con el mismo opId producen exactamente 1 confirmación y 0 duplicados', async () => {
      const accountId = `CLI_B3_CONC_E4_IDEM_${TAG}`;
      const versionId = `v_esc_idem_${TAG}`;
      const sharedOpId = `op_idem_${TAG}`;

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Inversiones Idempotentes ${TAG}`,
        tipo: 'juridica',
        documentos: {
          escritura: {
            name: 'escritura_idem.pdf',
            storagePath: 'prod_files/clients/test/legal/esc_idem.pdf',
            versionId,
            versionNumber: 1
          }
        },
        visibleTo: [USERS.admin1.cid],
        activo: true
      });

      await H.setDoc(`clients_local/${accountId}/document_versions`, versionId, {
        id: versionId,
        versionId,
        docKey: 'escritura',
        name: 'escritura_idem.pdf',
        versionNumber: 1,
        estado: 'vigente'
      });

      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const barrier = createBarrier(2);

      const p1 = barrier.enter(() =>
        state.docSvcA.recordBiennialConfirmation({
          caller: callerA,
          accountId,
          docKey: 'escritura',
          documentVersionId: versionId,
          confirmationType: 'no_changes',
          confirmedNoChanges: true,
          notas: 'Reintento concurrente mismo opId',
          opId: sharedOpId
        })
      );

      const p2 = barrier.enter(() =>
        state.docSvcB.recordBiennialConfirmation({
          caller: callerA,
          accountId,
          docKey: 'escritura',
          documentVersionId: versionId,
          confirmationType: 'no_changes',
          confirmedNoChanges: true,
          notas: 'Reintento concurrente mismo opId',
          opId: sharedOpId
        })
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.confirmationId).toBe(`conf_${sharedOpId}`);
      expect(r2.confirmationId).toBe(r1.confirmationId);

      const confsCol = await state.dbA.collection(`clients_local/${accountId}/biennial_confirmations`).get();
      expect(confsCol.size).toBe(1);
    });

    test('Carrera entre carga de nueva versión (v2) y confirmación bienal sobre versión anterior (v1): sin estados contradictorios', async () => {
      const accountId = `CLI_B3_CONC_E4_RACE_${TAG}`;
      const v1Id = `v_esc_v1_${TAG}`;

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Corporación Carrera Versión ${TAG}`,
        tipo: 'juridica',
        documentos: {
          escritura: {
            name: 'escritura_v1.pdf',
            storagePath: 'prod_files/clients/test/legal/esc_v1.pdf',
            versionId: v1Id,
            versionNumber: 1
          }
        },
        visibleTo: [USERS.admin1.cid, USERS.admin2.cid],
        activo: true
      });

      await H.setDoc(`clients_local/${accountId}/document_versions`, v1Id, {
        id: v1Id,
        versionId: v1Id,
        docKey: 'escritura',
        name: 'escritura_v1.pdf',
        versionNumber: 1,
        estado: 'vigente'
      });

      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };
      const callerB = { uid: USERS.admin2.uid, email: USERS.admin2.email, role: 'manager', cid: USERS.admin2.cid, profileId: USERS.admin2.cid, name: USERS.admin2.nombre };

      const barrier = createBarrier(2);

      // Admin A sube nueva versión v2 de la escritura
      const pUploadV2 = barrier.enter(() =>
        state.docSvcA.saveAccountDocument({
          caller: callerA,
          accountId,
          docKey: 'escritura',
          doc: {
            name: 'escritura_v2.pdf',
            storagePath: 'prod_files/clients/test/legal/esc_v2.pdf',
            sha256: '9'.repeat(64)
          },
          motivoSustitucion: 'Reforma estatutaria v2'
        })
      );

      // Admin B intenta confirmar sin cambios la versión v1 simultáneamente
      const pConfirmV1 = barrier.enter(() =>
        state.docSvcB.recordBiennialConfirmation({
          caller: callerB,
          accountId,
          docKey: 'escritura',
          documentVersionId: v1Id,
          confirmationType: 'no_changes',
          confirmedNoChanges: true,
          notas: 'Intento de confirmar v1 en paralelo con subida de v2'
        }).catch(err => ({ rejected: true, code: err.code, message: err.message }))
      );

      const [resUpload, resConfirm] = await Promise.all([pUploadV2, pConfirmV1]);
      expect(resUpload.success).toBe(true);
      expect(resUpload.versionNumber).toBe(2);

      const clientSnap = await H.getDoc('clients_local', accountId);
      const clientDoc = clientSnap.data;

      // Invariante: el documento vigente en el cliente es v2, y si la confirmación de v1 ocurrió después de v2, fue rechazada.
      // Si la confirmación de v1 ocurrió antes de v2, la subida de v2 actualizó biennialReviews.escritura a v2.
      expect(clientDoc.documentos.escritura.versionId).toBe(resUpload.versionId);
      if (resConfirm && resConfirm.rejected) {
        expect(resConfirm.message).toMatch(/vigente|desactualizada|sustituida|histórica/i);
        expect(clientDoc.biennialReviews.escritura.documentVersionId).toBe(resUpload.versionId);
      } else {
        // Confirmación de v1 entró primero y luego v2 la sustituyó atómicamente
        expect(clientDoc.biennialReviews.escritura.documentVersionId).toBe(resUpload.versionId);
      }

      // Verificar que una vez v2 está vigente, cualquier intento posterior de confirmar v1 es rechazado siempre
      await expect(
        state.docSvcB.recordBiennialConfirmation({
          caller: callerB,
          accountId,
          docKey: 'escritura',
          documentVersionId: v1Id,
          confirmationType: 'no_changes',
          confirmedNoChanges: true
        })
      ).rejects.toThrow(/vigente|desactualizada|sustituida|histórica/i);
    });
  });

  // ====================================================================================================
  // ESCENARIO 5: Idempotencia Transaccional (MEDIO-04) en Endpoints Mutadores B3
  // ====================================================================================================
  describe('Escenario 5: Idempotencia Transaccional por opId en Endpoints Mutadores B3', () => {
    test('Reintentos con el mismo opId en registerLegalRepresentativeTerm, grantContractPower, revokeContractPower y saveAccountDocument son idempotentes', async () => {
      const accountId = `CLI_B3_CONC_E5_IDEM_${TAG}`;
      const contactId = `CONT_B3_E5_${TAG}`;
      const callerA = { uid: USERS.admin1.uid, email: USERS.admin1.email, role: 'manager', cid: USERS.admin1.cid, profileId: USERS.admin1.cid, name: USERS.admin1.nombre };

      await H.setDoc('contacts_local', contactId, {
        id: contactId,
        nombres: 'Claudia',
        apellidos: 'Idempotente',
        nombreCompleto: 'Lic. Claudia Idempotente',
        dui: '04567890-1',
        activo: true
      });

      await H.setDoc('clients_local', accountId, {
        id: accountId,
        empresa: `Corporación Idempotencia MEDIO-04 ${TAG}`,
        tipo: 'juridica',
        documentos: {},
        visibleTo: [USERS.admin1.cid],
        activo: true
      });

      // 1. registerLegalRepresentativeTerm idempotente
      const opRl = `op_rl_idem_${TAG}`;
      const rlPayload = {
        caller: callerA,
        accountId,
        nombre: 'Ing. Roberto Idempotente',
        cargo: 'Presidente',
        fechaEleccion: '2025-01-10',
        fechaVencimiento: '2028-01-10',
        credencialDoc: { name: 'cred_idem.pdf', storagePath: 'prod_files/clients/test/legal/c_idem.pdf', sha256: '1'.repeat(64) },
        duiDoc: { name: 'dui_idem.pdf', storagePath: 'prod_files/clients/test/identificacion/d_idem.pdf', sha256: '2'.repeat(64), fechaVencimiento: '2029-05-01' },
        opId: opRl
      };
      const rlRes1 = await state.docSvcA.registerLegalRepresentativeTerm(rlPayload);
      const rlRes2 = await state.docSvcB.registerLegalRepresentativeTerm(rlPayload);
      expect(rlRes1.termId).toBe(rlRes2.termId);

      const termsCol = await state.dbA.collection(`clients_local/${accountId}/legal_representative_terms`).get();
      expect(termsCol.size).toBe(1);

      // 2. grantContractPower idempotente
      const opGrant = `op_grant_idem_${TAG}`;
      const grantPayload = {
        caller: callerA,
        accountId,
        contactId: `CONT_B3_E5_${TAG}`,
        notas: 'Poder con nota persistida BAJO-01',
        documento: {
          name: 'poder_idem.pdf',
          storagePath: 'prod_files/clients/test/poderes/p_idem.pdf',
          sha256: '3'.repeat(64),
          nombreApoderado: 'Lic. Claudia Idempotente',
          tipoPoder: 'especial',
          facultadFirmaContratos: true,
          fechaOtorgamiento: '2025-03-01',
          fechaVencimiento: '2027-03-01',
          notario: 'Lic. Notario'
        },
        opId: opGrant
      };
      const gRes1 = await state.docSvcA.grantContractPower(grantPayload);
      const gRes2 = await state.docSvcB.grantContractPower(grantPayload);
      expect(gRes1.powerId).toBe(gRes2.powerId);
      expect(gRes1.power.notas).toBe('Poder con nota persistida BAJO-01');

      const powersCol = await state.dbA.collection(`clients_local/${accountId}/contract_powers`).get();
      expect(powersCol.size).toBe(1);

      // 3. revokeContractPower idempotente
      const opRevoke = `op_rev_idem_${TAG}`;
      const revPayload = {
        caller: callerA,
        accountId,
        powerId: gRes1.powerId,
        motivo: 'Revocación idempotente',
        opId: opRevoke
      };
      const revRes1 = await state.docSvcA.revokeContractPower(revPayload);
      const revRes2 = await state.docSvcB.revokeContractPower(revPayload);
      expect(revRes1.estado).toBe('revocado');
      expect(revRes2.estado).toBe('revocado');

      // 4. saveAccountDocument idempotente
      const opSave = `op_save_idem_${TAG}`;
      const savePayload = {
        caller: callerA,
        accountId,
        docKey: 'nit',
        doc: {
          name: 'nit_idem.pdf',
          storagePath: 'prod_files/clients/test/fiscal/nit_idem.pdf',
          sha256: '4'.repeat(64)
        },
        opId: opSave
      };
      const sRes1 = await state.docSvcA.saveAccountDocument(savePayload);
      const sRes2 = await state.docSvcB.saveAccountDocument(savePayload);
      expect(sRes1.versionId).toBe(sRes2.versionId);
      expect(sRes1.versionNumber).toBe(1);
      expect(sRes2.versionNumber).toBe(1);
    });
  });
});
