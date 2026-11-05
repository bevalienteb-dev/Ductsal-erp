// functions/__tests__/accountDocuments.unit.test.js
// Comprehensive Unit Tests for Phase 2 Block B3:
// Legal and Fiscal Documents, Legal Representation Terms, Contract Powers,
// Automatic Power Invalidation, Expirations, Biennial Reviews, and Closing Validation.

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createAccountDocumentsService,
  CANONICAL_DOC_KEYS,
  POWER_DOC_KEY,
  ALL_DOC_KEYS,
  DOCUMENTS_REQUIRING_BIENNIAL_REVIEW,
  DOCUMENTS_WITH_EXPIRATION,
  ServiceError
} = require('../accountDocumentsService');

const state = admin.__state;
const FieldValue = admin.firestore.FieldValue;

const MGR = '1792037387201';
const GES = '1792037387202';
const V1 = '1792037387205';
const V2 = '1792037387206';

function callerUser(cid) {
  const profile = state.docs[`users_prod/${cid}`];
  return {
    cid: profile.id,
    uid: profile.authUid,
    role: profile.role,
    name: profile.nombre
  };
}

function seedBaseData() {
  state.docs[`users_prod/${MGR}`] = { id: MGR, authUid: 'uid-mgr', role: 'manager', activo: true, nombre: 'Gerente General' };
  state.docs[`users_prod/${GES}`] = { id: GES, authUid: 'uid-ges', role: 'gestor', activo: true, nombre: 'Gestor Comercial' };
  state.docs[`users_prod/${V1}`] = { id: V1, authUid: 'uid-v1', role: 'vendedor', activo: true, nombre: 'Vendedor Uno' };
  state.docs[`users_prod/${V2}`] = { id: V2, authUid: 'uid-v2', role: 'vendedor', activo: true, nombre: 'Vendedor Dos' };

  // Contacts (B1)
  state.docs['contacts_prod/CONT_ANA'] = {
    id: 'CONT_ANA',
    nombres: 'Ana',
    apellidos: 'Gómez',
    nombreCompleto: 'Ana Gómez',
    dui: '02345678-9',
    correo: 'ana@delta.com',
    telefono: '7890-1234'
  };
  state.docs['contacts_prod/CONT_CARLOS'] = {
    id: 'CONT_CARLOS',
    nombres: 'Carlos',
    apellidos: 'López',
    nombreCompleto: 'Carlos López',
    dui: '03456789-0',
    correo: 'carlos@delta.com',
    telefono: '7890-5678'
  };
  state.docs['contacts_prod/CONT_MARIO'] = {
    id: 'CONT_MARIO',
    nombres: 'Mario',
    apellidos: 'Santos',
    nombreCompleto: 'Mario Santos',
    dui: '04567890-1',
    correo: 'mario@delta.com',
    telefono: '7890-9999'
  };

  // Accounts
  state.docs['clients_prod/ACC_DELTA'] = {
    id: 'ACC_DELTA',
    tipo: 'juridica',
    empresa: 'Constructora Delta SA de CV',
    contacto: 'Ana Gómez',
    nit: '0614-120590-101-2',
    nrc: '123456-7',
    createdBy: V1,
    visibleTo: [V1],
    vendedor_asignado: V1,
    fecha_creacion: '2026-01-10T10:00:00.000Z',
    documentos: {
      escritura: {
        name: 'Escritura_Constitucion.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/legal/Escritura.pdf',
        actualizadoEn: '2026-01-10T10:00:00.000Z',
        versionId: 'v_esc_1',
        versionNumber: 1
      },
      nit: {
        name: 'NIT_Empresa.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/legal/NIT.pdf',
        actualizadoEn: '2026-01-10T10:00:00.000Z',
        versionId: 'v_nit_1',
        versionNumber: 1
      },
      nrc: {
        name: 'NRC_Empresa.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/legal/NRC.pdf',
        actualizadoEn: '2026-01-10T10:00:00.000Z',
        versionId: 'v_nrc_1',
        versionNumber: 1
      }
    }
  };

  state.docs['clients_prod/ACC_PERSONA_NATURAL'] = {
    id: 'ACC_PERSONA_NATURAL',
    tipo: 'natural',
    nombres: 'Roberto',
    apellidos: 'Martínez',
    dui: '01234567-8',
    nit: '0614-010185-102-3',
    createdBy: V1,
    visibleTo: [V1],
    vendedor_asignado: V1,
    fecha_creacion: '2026-01-10T10:00:00.000Z',
    documentos: {
      dui: {
        name: 'DUI_Roberto.pdf',
        storagePath: 'prod_files/clients/ACC_PERSONA_NATURAL/identificacion/DUI.pdf',
        versionId: 'v_dui_nat_1',
        versionNumber: 1,
        fechaVencimiento: '2028-12-31'
      },
      nit: {
        name: 'NIT_Roberto.pdf',
        storagePath: 'prod_files/clients/ACC_PERSONA_NATURAL/legal/NIT.pdf',
        versionId: 'v_nit_nat_1',
        versionNumber: 1
      }
    }
  };
}

describe('Phase 2 Block B3: Account Documents, Legal Representation & Powers', () => {
  let svc;

  beforeEach(() => {
    state.docs = {};
    state.hooks = {};
    seedBaseData();
    svc = createAccountDocumentsService({
      db: admin.firestore(),
      FieldValue,
      suffix: '_prod'
    });
  });

  describe('1. Catálogo y Compatibilidad de Claves Documentales', () => {
    test('expone las 6 claves canónicas existentes de DOC_KEYS intactas', () => {
      expect(CANONICAL_DOC_KEYS).toEqual(['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui']);
    });

    test('incorpora poder_firma_contrato como la única clave funcional para poderes', () => {
      expect(POWER_DOC_KEY).toBe('poder_firma_contrato');
      expect(ALL_DOC_KEYS).toContain('poder_firma_contrato');
      expect(ALL_DOC_KEYS.length).toBe(7);
    });

    test('clasifica los documentos en las familias requeridas por Dirección', () => {
      expect(DOCUMENTS_REQUIRING_BIENNIAL_REVIEW).toEqual(['escritura', 'mods_escritura']);
      expect(DOCUMENTS_WITH_EXPIRATION).toEqual(['dui', 'credencial']);
    });
  });

  describe('2. Registro y Renovación de Nombramiento de Representante Legal', () => {
    test('registra el primer nombramiento de Representante Legal exitosamente', async () => {
      const res = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-01-15',
        fechaInicio: '2026-01-15',
        fechaVencimiento: '2029-01-15',
        credencialDoc: {
          name: 'Credencial_2026_2029.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/Credencial_2026.pdf',
          sha256: 'a'.repeat(64)
        },
        duiDoc: {
          name: 'DUI_Ana.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/identificacion/DUI_Ana.pdf',
          sha256: 'b'.repeat(64),
          fechaVencimiento: '2030-05-20'
        }
      });

      expect(res.success).toBe(true);
      expect(res.estado).toBe('vigente');
      expect(res.nombre).toBe('Ana Gómez');
      expect(res.invalidatedPowersCount).toBe(0);

      // Verify client projection
      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.representanteLegalVigente).toBeDefined();
      expect(client.representanteLegalVigente.termId).toBe(res.termId);
      expect(client.representanteLegalVigente.nombre).toBe('Ana Gómez');
      expect(client.rep_legal).toBe('Ana Gómez');
      expect(client.documentos.credencial.storagePath).toBe('prod_files/clients/ACC_DELTA/legal/Credencial_2026.pdf');
      expect(client.documentos.dui.storagePath).toBe('prod_files/clients/ACC_DELTA/identificacion/DUI_Ana.pdf');
    });

    test('rechaza registro con fecha de vencimiento anterior a fecha de elección', async () => {
      await expect(svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-05-10',
        fechaVencimiento: '2025-05-10', // Anterior
        credencialDoc: { name: 'cred.pdf' },
        duiDoc: { name: 'dui.pdf' }
      })).rejects.toThrow('La fecha de vencimiento no puede ser anterior a la fecha de elección');
    });
  });

  describe('3. Otorgamiento de Poderes e Invalidación Automática por Nueva Elección', () => {
    let term1Id;

    beforeEach(async () => {
      // Seed first election (Ana Gómez as RL)
      const r = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2024-01-10',
        fechaVencimiento: '2027-01-10',
        credencialDoc: { name: 'cred1.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/cred1.pdf' },
        duiDoc: { name: 'dui1.pdf', storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui1.pdf', fechaVencimiento: '2028-01-01' }
      });
      term1Id = r.termId;
    });

    test('permite otorgar poder a un apoderado vinculado a contacts_prod', async () => {
      const pRes = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: {
          name: 'Poder_Especial_Carlos_Lopez.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/poderes/Poder_Carlos.pdf',
          sha256: 'c'.repeat(64)
        }
      });

      expect(pRes.success).toBe(true);
      expect(pRes.nombreApoderado).toBe('Carlos López');
      expect(pRes.termId).toBe(term1Id);
      expect(pRes.estado).toBe('vigente');

      // Verify client root projection
      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.apoderadosVigentes).toHaveLength(1);
      expect(client.apoderadosVigentes[0].contactId).toBe('CONT_CARLOS');
      expect(client.apoderadosVigentes[0].estado).toBe('vigente');
    });

    test('permite otorgar múltiples apoderados bajo el mismo nombramiento de RL', async () => {
      await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf', storagePath: 'prod_files/clients/ACC_DELTA/poderes/Poder_Carlos.pdf' }
      });

      await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_MARIO',
        documento: { name: 'Poder_Mario.pdf', storagePath: 'prod_files/clients/ACC_DELTA/poderes/Poder_Mario.pdf' }
      });

      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.apoderadosVigentes).toHaveLength(2);
    });

    test('rechaza otorgar poder duplicado al mismo contacto si ya tiene uno vigente', async () => {
      await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf' }
      });

      await expect(svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos_2.pdf' }
      })).rejects.toThrow('ya cuenta con un poder vigente para firma de contratos en esta cuenta');
    });

    test('REGLA FUNDAMENTAL: Nueva elección de RL invalida automáticamente TODOS los poderes anteriores (misma persona reelegida)', async () => {
      // Grant 2 powers under Term 1
      const p1 = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf' }
      });
      const p2 = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_MARIO',
        documento: { name: 'Poder_Mario.pdf' }
      });

      // Socio re-elects the SAME person (Ana Gómez) for a new term (Term 2)
      const newElectionRes = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez', // Misma persona
        fechaEleccion: '2026-11-01',
        fechaVencimiento: '2029-11-01',
        credencialDoc: { name: 'Credencial_Reeleccion.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/cred2.pdf' },
        duiDoc: { name: 'DUI_Ana_Renovado.pdf', storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui_renovado.pdf' }
      });

      expect(newElectionRes.invalidatedPowersCount).toBe(2);

      // Verify client active powers was cleared
      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.apoderadosVigentes).toEqual([]);

      // Verify individual power documents in subcollection
      const power1Doc = state.docs[`clients_prod/ACC_DELTA/contract_powers/${p1.powerId}`];
      expect(power1Doc.estado).toBe('anulado_por_nueva_eleccion');
      expect(power1Doc.anuladoPorTermId).toBe(newElectionRes.termId);

      const power2Doc = state.docs[`clients_prod/ACC_DELTA/contract_powers/${p2.powerId}`];
      expect(power2Doc.estado).toBe('anulado_por_nueva_eleccion');
      expect(power2Doc.anuladoPorTermId).toBe(newElectionRes.termId);
    });

    test('REGLA FUNDAMENTAL: Nueva elección con OTRA persona invalida automáticamente todos los poderes anteriores', async () => {
      const p1 = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf' }
      });

      // Nueva elección: Se elige a Mario Santos como nuevo RL
      const newElection = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(MGR),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_MARIO',
        nombre: 'Mario Santos',
        fechaEleccion: '2026-11-02',
        fechaVencimiento: '2029-11-02',
        credencialDoc: { name: 'Credencial_Mario.pdf' },
        duiDoc: { name: 'DUI_Mario.pdf' }
      });

      expect(newElection.invalidatedPowersCount).toBe(1);

      const powerDoc = state.docs[`clients_prod/ACC_DELTA/contract_powers/${p1.powerId}`];
      expect(powerDoc.estado).toBe('anulado_por_nueva_eleccion');
      expect(powerDoc.anuladoPorTermId).toBe(newElection.termId);
    });

    test('permite revocar un poder voluntariamente con motivo registrado', async () => {
      const p = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf' }
      });

      const revRes = await svc.revokeContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        powerId: p.powerId,
        motivo: 'Revocación por renuncia voluntaria del apoderado'
      });

      expect(revRes.success).toBe(true);
      expect(revRes.estado).toBe('revocado');

      const powerDoc = state.docs[`clients_prod/ACC_DELTA/contract_powers/${p.powerId}`];
      expect(powerDoc.estado).toBe('revocado');
      expect(powerDoc.motivoAnulacion).toBe('Revocación por renuncia voluntaria del apoderado');

      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.apoderadosVigentes).toHaveLength(0);
    });
  });

  describe('4. Control de Vencimientos y Huella SHA-256', () => {
    test('rechaza renovar documento vencido cargando el mismo archivo (mismo SHA-256)', async () => {
      // Set existing DUI as expired with hash H1
      const shaH1 = '1'.repeat(64);
      state.docs['clients_prod/ACC_DELTA'].documentos.dui = {
        name: 'DUI_Vencido.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/identificacion/DUI.pdf',
        fechaVencimiento: '2025-01-01', // Vencido
        sha256: shaH1,
        versionId: 'v_dui_old',
        versionNumber: 1
      };

      // Attempt to substitute uploading identical file (same SHA-256)
      await expect(svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: {
          name: 'DUI_Nuevo_Intento.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/identificacion/DUI_Nuevo.pdf',
          sha256: shaH1,
          fechaVencimiento: '2029-01-01'
        },
        motivoSustitucion: 'Intento con mismo archivo'
      })).rejects.toThrow('huella digital SHA-256 idéntica');
    });

    test('rechaza renovar documento vencido con fecha de vencimiento igual o anterior a la previa', async () => {
      state.docs['clients_prod/ACC_DELTA'].documentos.dui = {
        name: 'DUI_Vencido.pdf',
        fechaVencimiento: '2025-01-01',
        sha256: '1'.repeat(64),
        versionId: 'v_dui_old',
        versionNumber: 1
      };

      await expect(svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: {
          name: 'DUI_Distinto.pdf',
          sha256: '2'.repeat(64),
          fechaVencimiento: '2024-12-31' // Anterior a 2025-01-01
        },
        motivoSustitucion: 'Renovación con fecha antigua'
      })).rejects.toThrow('debe ser posterior a la fecha anterior');
    });

    test('acepta renovación legítima con archivo renovado (distinto SHA-256 y fecha futura)', async () => {
      state.docs['clients_prod/ACC_DELTA'].documentos.dui = {
        name: 'DUI_Vencido.pdf',
        fechaVencimiento: '2025-01-01',
        sha256: '1'.repeat(64),
        versionId: 'v_dui_old',
        versionNumber: 1
      };

      const res = await svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: {
          name: 'DUI_Renovado_2030.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/identificacion/DUI_2030.pdf',
          sha256: '2'.repeat(64),
          fechaVencimiento: '2030-01-01'
        },
        motivoSustitucion: 'Renovación de DUI ante Duicentro por vencimiento ordinario'
      });

      expect(res.success).toBe(true);
      expect(res.versionNumber).toBe(2);

      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.documentos.dui.fechaVencimiento).toBe('2030-01-01');
      expect(client.documentos.dui.sha256).toBe('2'.repeat(64));
    });
  });

  describe('5. Revisión Bienal (Pacto Social y Modificaciones)', () => {
    test('detecta documento que superó los 2 años sin validación ni confirmación', async () => {
      // Escritura cargada en 2024-01-01 (más de 2 años al 2026-11-03)
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.actualizadoEn = '2024-01-01T10:00:00.000Z';
      state.docs['clients_prod/ACC_DELTA'].documentos.credencial = {
        name: 'Cred.pdf',
        storagePath: 'prod_files/cred.pdf',
        fechaVencimiento: '2029-01-01'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.dui = {
        name: 'DUI.pdf',
        storagePath: 'prod_files/dui.pdf',
        fechaVencimiento: '2029-01-01'
      };

      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'PROSP_1',
        requiereContrato: false,
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(false);
      expect(val.documentsRequiringReview).toHaveLength(1);
      expect(val.documentsRequiringReview[0].docKey).toBe('escritura');
      expect(val.blockingReasons[0]).toMatch(/requiere revisión bienal/);
    });

    test('Caso B (sin actualizaciones): registra evento de confirmación sin pedir ni generar archivo, vinculado al documento y versión correcta, con fecha y usuario', async () => {
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.actualizadoEn = '2024-01-01T10:00:00.000Z';
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 2,
        docKey: 'escritura',
        estado: 'vigente',
        name: 'Escritura_Constitucion.pdf'
      };

      const versionsCountBefore = Object.keys(state.docs).filter(k => k.startsWith('clients_prod/ACC_DELTA/document_versions/')).length;

      const confRes = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Se consultó al cliente y confirmó que no existen modificaciones.',
        opportunityId: 'PROSP_1'
      });

      expect(confRes.success).toBe(true);
      expect(confRes.docKey).toBe('escritura');
      expect(confRes.documentVersionId).toBe('v_esc_1');
      expect(confRes.confirmedAt).toBeDefined();
      expect(confRes.nextReviewAt).toMatch(/^2028-/);

      // Verify NO new document version was created in document_versions
      const versionsCountAfter = Object.keys(state.docs).filter(k => k.startsWith('clients_prod/ACC_DELTA/document_versions/')).length;
      expect(versionsCountAfter).toBe(versionsCountBefore);

      // Verify confirmation event record in biennial_confirmations
      const savedConf = state.docs[`clients_prod/ACC_DELTA/biennial_confirmations/${confRes.confirmationId}`];
      expect(savedConf).toBeDefined();
      expect(savedConf.eventType).toBe('biennial_confirmation');
      expect(savedConf.docKey).toBe('escritura');
      expect(savedConf.documentVersionId).toBe('v_esc_1');
      expect(savedConf.versionNumber).toBe(2);
      expect(savedConf.confirmationType).toBe('no_changes');
      expect(savedConf.confirmedNoChanges).toBe(true);
      expect(savedConf.confirmedBy).toBe(V1);
      expect(savedConf.confirmedByName).toBe('Vendedor Uno');
      expect(savedConf.confirmedAt).toBeDefined();
      expect(savedConf.notas).toContain('Se consultó al cliente');

      // Verify client biennial review projection
      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.biennialReviews.escritura).toBeDefined();
      expect(client.biennialReviews.escritura.nextReviewAt).toMatch(/^2028-/);
      expect(client.biennialReviews.escritura.documentVersionId).toBe('v_esc_1');
      expect(client.biennialReviews.escritura.versionNumber).toBe(2);
    });

    test('Caso A (con actualizaciones): incorpora nueva versión documental, actualiza vigencia y renueva fecha de próxima revisión', async () => {
      const resMod = await svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'mods_escritura',
        doc: {
          name: 'Modificacion_Pacto_Capital.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/Mod_2026.pdf',
          sha256: '4'.repeat(64)
        },
        motivoSustitucion: 'Aumento de capital social inscrito en Registro de Comercio'
      });

      expect(resMod.success).toBe(true);
      expect(resMod.versionId).toBeDefined();
      expect(resMod.versionNumber).toBe(1);

      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.documentos.mods_escritura.versionId).toBe(resMod.versionId);
      expect(client.biennialReviews.mods_escritura).toBeDefined();
      expect(client.biennialReviews.mods_escritura.nextReviewAt).toMatch(/^2028-/);
      expect(client.biennialReviews.mods_escritura.documentVersionId).toBe(resMod.versionId);
    });

    test('El historial del expediente distingue claramente confirmaciones bienales (biennialConfirmations) frente a cargas de versión (documentVersions)', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente',
        name: 'Escritura_Inicial.pdf',
        createdAt: '2024-01-01T10:00:00.000Z'
      };

      const confRes = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Confirmación bienal sin cambios'
      });

      const dossier = await svc.getAccountDossier({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA'
      });

      expect(Array.isArray(dossier.documentVersions)).toBe(true);
      expect(Array.isArray(dossier.biennialConfirmations)).toBe(true);
      expect(dossier.documentVersions.some(v => v.id === confRes.confirmationId)).toBe(false);
      const foundConf = dossier.biennialConfirmations.find(c => c.id === confRes.confirmationId);
      expect(foundConf).toBeDefined();
      expect(foundConf.eventType).toBe('biennial_confirmation');
      expect(foundConf.documentVersionId).toBe('v_esc_1');
      expect(foundConf.confirmationType).toBe('no_changes');
    });

    test('Una confirmación bienal NO puede utilizarse para renovar un documento vencido', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_vencida'] = {
        versionId: 'v_esc_vencida',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente',
        fechaVencimiento: '2020-01-01'
      };

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_vencida',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/no puede utilizarse para renovar un documento vencido/);
    });

    test('Un documento que NO está configurado para revisión bienal (ej. dui, credencial, nit, nrc) rechaza el flujo de confirmación bienal', async () => {
      for (const nonBiennialDoc of ['dui', 'credencial', 'nit', 'nrc']) {
        await expect(svc.recordBiennialConfirmation({
          caller: callerUser(V1),
          accountId: 'ACC_DELTA',
          docKey: nonBiennialDoc,
          documentVersionId: 'v_any_1',
          confirmationType: 'no_changes',
          confirmedNoChanges: true
        })).rejects.toThrow(/no está sujeto a revisión bienal/);
      }
    });

    test('Caso B exige confirmación expresa (confirmedNoChanges === true)', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente'
      };

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: false
      })).rejects.toThrow(/Debe confirmar expresamente/);
    });

    test('Integridad de versión documental: rechaza si documentVersionId pertenece a otro docKey distinto al indicado', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_nit_1'] = {
        versionId: 'v_nit_1',
        versionNumber: 1,
        docKey: 'nit',
        estado: 'vigente'
      };

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_nit_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/corresponde al documento 'nit', no a 'escritura'/);
    });

    test('Integridad de versión documental: rechaza si documentVersionId tiene entityId de otra cuenta', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_foreign_1'] = {
        versionId: 'v_foreign_1',
        versionNumber: 1,
        entityId: 'ACC_OTRA_CUENTA',
        docKey: 'escritura',
        estado: 'vigente'
      };

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_foreign_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/no pertenece a la cuenta indicada/);
    });

    test('Integridad de versión documental: impide confirmar una versión histórica o desactualizada cuando ya existe una versión posterior (v2)', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'historica',
        reemplazadaPorVersionId: 'v_esc_2'
      };
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_2'] = {
        versionId: 'v_esc_2',
        versionNumber: 2,
        docKey: 'escritura',
        estado: 'vigente',
        reemplazaVersionId: 'v_esc_1'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId = 'v_esc_2';
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionNumber = 2;

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/versión documental vigente|histórica|desactualizada/);

      // Aún si v_esc_1 tuviera estado 'vigente' por error, el puntero activo v_esc_2 y la versión superior lo bloquean
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'].estado = 'vigente';
      delete state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'].reemplazadaPorVersionId;

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/desactualizada|versión posterior/);
    });

    test('Idempotencia con opId: reintentos con el mismo opId no duplican eventos ni auditoría y rechazan parámetros distintos', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId = 'v_esc_1';

      const res1 = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Confirmación idempotente',
        opId: 'op_bienal_idem_001'
      });

      const res2 = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Confirmación idempotente',
        opId: 'op_bienal_idem_001'
      });

      expect(res1.confirmationId).toBe('conf_op_bienal_idem_001');
      expect(res2.confirmationId).toBe(res1.confirmationId);
      expect(res2.idempotentReplay).toBe(true);

      const allConfs = Object.keys(state.docs).filter(k => k.startsWith('clients_prod/ACC_DELTA/biennial_confirmations/'));
      expect(allConfs).toHaveLength(1);

      // Reutilizar el mismo opId con otro docKey o usuario es rechazado con already-exists
      state.docs['clients_prod/ACC_DELTA'].documentos.mods_escritura = {
        name: 'Mod.pdf',
        versionId: 'v_mod_1',
        versionNumber: 1
      };
      state.docs['clients_prod/ACC_DELTA/document_versions/v_mod_1'] = {
        versionId: 'v_mod_1',
        versionNumber: 1,
        docKey: 'mods_escritura',
        estado: 'vigente'
      };

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'mods_escritura',
        documentVersionId: 'v_mod_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        opId: 'op_bienal_idem_001'
      })).rejects.toThrow(/ya fue utilizado con parámetros distintos/);
    });

    test('Seguridad de identidad en Cloud Function recordBiennialConfirmationAdmin: ignora cualquier intento de suplantar confirmedBy o confirmedByName desde el payload del cliente', async () => {
      const fns = require('../index');
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId = 'v_esc_1';

      const callable = fns.recordBiennialConfirmationAdmin;
      const handler = typeof callable === 'function' && callable.__handler ? callable.__handler : callable;

      const spoofedPayload = {
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        confirmedBy: MGR,
        confirmedByName: 'Gerente Suplantado',
        caller: { cid: MGR, uid: 'uid-mgr', name: 'Gerente Suplantado', role: 'manager' },
        dbSuffix: '_prod'
      };

      const authContext = {
        auth: {
          uid: 'uid-v1',
          token: { cid: V1, role: 'vendedor' }
        }
      };

      const res = await handler(spoofedPayload, authContext);
      expect(res.success).toBe(true);
      expect(res.confirmedBy).toBe(V1);
      expect(res.confirmedByName).toBe('Vendedor Uno');

      const savedConf = state.docs[`clients_prod/ACC_DELTA/biennial_confirmations/${res.confirmationId}`];
      expect(savedConf.confirmedBy).toBe(V1);
      expect(savedConf.confirmedByUid).toBe('uid-v1');
      expect(savedConf.confirmedByName).toBe('Vendedor Uno');
      expect(savedConf.confirmedBy).not.toBe(MGR);
    });

    test('Seguridad de autorización: vendedor V2 sin acceso a ACC_DELTA no puede registrar confirmación bienal', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId = 'v_esc_1';

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V2),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/No tienes acceso a esta cuenta/);
    });
  });

  describe('6. Control de Cierre y Validación de Oportunidades', () => {
    beforeEach(async () => {
      // Set up fully valid corporate account
      await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-01-01',
        fechaVencimiento: '2029-01-01',
        credencialDoc: {
          name: 'Credencial.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/cred.pdf',
          fechaVencimiento: '2029-01-01'
        },
        duiDoc: {
          name: 'DUI_Ana.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui.pdf',
          fechaVencimiento: '2029-01-01'
        }
      });
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.actualizadoEn = '2026-01-01T10:00:00.000Z';
    });

    test('oportunidad que NO requiere contrato con expediente completo: valid === true', async () => {
      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_100',
        requiereContrato: false,
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(true);
      expect(val.blockingReasons).toHaveLength(0);
      expect(val.documentsMissing).toHaveLength(0);
      expect(val.documentsExpired).toHaveLength(0);
      expect(val.documentsRequiringReview).toHaveLength(0);
      expect(val.validationId).toBeDefined();
    });

    test('oportunidad que NO requiere contrato pero con documento faltante: valid === false', async () => {
      delete state.docs['clients_prod/ACC_DELTA'].documentos.nrc;

      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_101',
        requiereContrato: false,
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(false);
      expect(val.documentsMissing).toContain('nrc');
      expect(val.blockingReasons[0]).toMatch(/Falta el documento obligatorio 'nrc'/);
    });

    test('oportunidad que SÍ requiere contrato sin firmante seleccionado: valid === false', async () => {
      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_102',
        requiereContrato: true,
        firmante: null,
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(false);
      expect(val.blockingReasons).toContain('La oportunidad requiere contrato: debe seleccionar quién firmará (Representante Legal o Apoderado acreditado).');
    });

    test('oportunidad que SÍ requiere contrato con Representante Legal vigente: valid === true', async () => {
      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_103',
        requiereContrato: true,
        firmante: { tipo: 'representante_legal' },
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(true);
      expect(val.signerValidation.valid).toBe(true);
      expect(val.signerValidation.tipo).toBe('representante_legal');
      expect(val.signerValidation.nombre).toBe('Ana Gómez');
    });

    test('oportunidad que SÍ requiere contrato con Apoderado vigente acreditado: valid === true', async () => {
      const p = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf', storagePath: 'prod_files/clients/ACC_DELTA/poderes/Poder_Carlos.pdf' }
      });

      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_104',
        requiereContrato: true,
        firmante: { tipo: 'apoderado', powerId: p.powerId },
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(true);
      expect(val.signerValidation.valid).toBe(true);
      expect(val.signerValidation.tipo).toBe('apoderado');
      expect(val.signerValidation.nombre).toBe('Carlos López');
    });

    test('oportunidad que SÍ requiere contrato con apoderado cuyo poder fue anulado por nueva elección: valid === false', async () => {
      const p = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf' }
      });

      // Nueva elección de RL (invalida el poder de Carlos)
      await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_MARIO',
        nombre: 'Mario Santos',
        fechaEleccion: '2026-11-02',
        fechaVencimiento: '2029-11-02',
        credencialDoc: { name: 'Cred_Mario.pdf', storagePath: 'prod_files/cred_mario.pdf', fechaVencimiento: '2029-11-02' },
        duiDoc: { name: 'DUI_Mario.pdf', storagePath: 'prod_files/dui_mario.pdf', fechaVencimiento: '2029-11-02' }
      });

      // Intento de cerrar usando el poder de Carlos
      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        prospectId: 'OPP_105',
        requiereContrato: true,
        firmante: { tipo: 'apoderado', powerId: p.powerId },
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(false);
      expect(val.blockingReasons[0]).toMatch(/no está vigente/);
      expect(val.signerValidation.valid).toBe(false);
    });

    test('cuenta de persona natural: valida DUI y NIT únicamente', async () => {
      const val = await svc.validateAccountDocumentsForOpportunityClose({
        caller: callerUser(V1),
        accountId: 'ACC_PERSONA_NATURAL',
        prospectId: 'OPP_NAT_1',
        requiereContrato: false,
        now: new Date('2026-11-03T18:00:00Z')
      });

      expect(val.valid).toBe(true);
      expect(val.blockingReasons).toHaveLength(0);
    });
  });

  describe('7. Seguridad y Cartera Comercial', () => {
    test('vendedor V2 ajeno a la cuenta ACC_DELTA es rechazado con permission-denied', async () => {
      await expect(svc.registerLegalRepresentativeTerm({
        caller: callerUser(V2),
        accountId: 'ACC_DELTA',
        nombre: 'Hacker',
        fechaEleccion: '2026-11-01',
        credencialDoc: { name: 'c.pdf' },
        duiDoc: { name: 'd.pdf' }
      })).rejects.toThrow('No tienes acceso a esta cuenta');
    });

    test('manager tiene acceso irrestricto a cualquier cuenta', async () => {
      const dossier = await svc.getAccountDossier({
        caller: callerUser(MGR),
        accountId: 'ACC_DELTA'
      });
      expect(dossier.accountId).toBe('ACC_DELTA');
      expect(dossier.tipoPersona).toBe('juridica');
    });
  });

  describe('8. Auditoría de UI B3 y Editar Cliente: Prohibición de Popups, Adaptadores Explícitos y Nomenclatura de Vistas', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..', '..');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const appCoreJs = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');
    const clientDocsJs = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'client_documents.js'), 'utf8');
    const clientsUiJs = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'clients_ui.js'), 'utf8');
    const clientsCtrlJs = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'clients_controller.js'), 'utf8');
    const contactsUiJs = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'contacts_ui.js'), 'utf8');
    const oppUiJs = fs.readFileSync(path.join(ROOT, 'modules', 'opportunities', 'opportunities_ui.js'), 'utf8');
    const finContractsJs = fs.readFileSync(path.join(ROOT, 'modules', 'finance', 'finance_contracts.js'), 'utf8');
    const docViewerJs = fs.readFileSync(path.join(ROOT, 'core', 'document_viewer.js'), 'utf8');

    test('index.html integra todas las vistas operativas de B3 y Editar Cliente como .view-section de pantalla completa dentro de <main>', () => {
      const mainStart = indexHtml.indexOf('<main');
      const mainEnd = indexHtml.indexOf('</main>');
      expect(mainStart).toBeGreaterThan(0);
      expect(mainEnd).toBeGreaterThan(mainStart);
      const mainContent = indexHtml.slice(mainStart, mainEnd);

      expect(mainContent).toContain('id="client-detail-view" class="view-section"');
      expect(mainContent).toContain('id="clientDetailContent"');
      expect(mainContent).toContain('id="b3-rl-election-view" class="view-section"');
      expect(mainContent).toContain('id="b3-grant-power-view" class="view-section"');
      expect(mainContent).toContain('id="b3-dossier-history-view" class="view-section"');
      expect(mainContent).toContain('id="b3-history-content"');
      expect(mainContent).toContain('id="b3-biennial-confirmation-view" class="view-section"');
      expect(mainContent).toContain('id="b3-substitute-doc-view" class="view-section"');
      expect(mainContent).toContain('id="b3-doc-version-history-view" class="view-section"');
    });

    test('Cero detección basada en [native code] o Function.prototype.toString en ningún módulo', () => {
      const filesToAudit = [appCoreJs, clientDocsJs, clientsUiJs, clientsCtrlJs, docViewerJs];
      for (const content of filesToAudit) {
        expect(content).not.toContain('[native code]');
        expect(content).not.toContain('Function.prototype.toString');
        expect(content).not.toMatch(/String\s*\(\s*(?:alert|confirm|prompt)\s*\)/);
      }
    });

    test('Nomenclatura limpia de vistas: cero referencias operativas a openClientModal, openRLElectionModal, openGrantPowerModal, openDossierHistoryModal, clientModal o b3-history-modal-body', () => {
      const allSources = [indexHtml, appCoreJs, clientDocsJs, clientsUiJs, clientsCtrlJs, contactsUiJs, oppUiJs, finContractsJs, docViewerJs];
      const legacyIdentifiers = [
        'openClientModal',
        'openRLElectionModal',
        'openGrantPowerModal',
        'openDossierHistoryModal',
        'clientModal',
        'b3-history-modal-body',
        'b3RLElectionModal',
        'b3PowerModal',
        'b3DossierHistoryModal',
        'docVersionHistoryModal'
      ];
      for (const src of allSources) {
        for (const legacyId of legacyIdentifiers) {
          expect(src).not.toContain(legacyId);
        }
      }
    });

    test('No se utilizan popups prompt() en la revocación de poderes ni flujos B3, y openClientDetailView navega a client-detail-view', () => {
      expect(clientDocsJs).not.toMatch(/\bprompt\s*\(/);
      expect(clientsUiJs).toContain('function openClientDetailView(');
      expect(clientsUiJs).toContain("_navigateView('client-detail-view')");
      expect(clientDocsJs).toContain("_navigateB3View('b3-rl-election-view')");
      expect(clientDocsJs).toContain("_navigateB3View('b3-grant-power-view')");
      expect(clientDocsJs).toContain("_navigateB3View('b3-dossier-history-view')");
      expect(clientDocsJs).toContain("_navigateB3View('b3-biennial-confirmation-view')");
      expect(clientDocsJs).toContain("_navigateB3View('b3-substitute-doc-view')");
      expect(docViewerJs).toContain("showView('b3-doc-version-history-view')");
    });
  });

  describe('9. Correcciones de Auditoría Integral PR #9 (ALTO-01..02, MEDIO-01..05, BAJO-01..04)', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..', '..');
    const { createProspectWorkflowService } = require('../prospectWorkflowService');
    const { createCommercialService } = require('../commercialService');

    test('ALTO-01: finalizeProspect ejecuta todas las lecturas transaccionales (incluido contract_powers) ANTES de cualquier escritura cuando se adjuntan doc_firmado y doc_comprobante con apoderado', async () => {
      Object.assign(state.docs['clients_prod/ACC_DELTA'], {
        telefono: '7890-1234',
        correo: 'contacto@delta.com',
        correo_fact: 'facturacion@delta.com'
      });
      const rlRes = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-01-10',
        fechaVencimiento: '2029-01-10',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/cred.pdf', fechaVencimiento: '2029-01-10' },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui.pdf', fechaVencimiento: '2029-01-10' }
      });
      const powerRes = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder_Carlos.pdf', storagePath: 'prod_files/clients/ACC_DELTA/poderes/poder.pdf' },
        notas: 'Facultado para contratos hasta $250,000'
      });

      state.docs['prospects_prod/OPP_ALTO_01'] = {
        id: 'OPP_ALTO_01',
        codigo: 'PRY-ALTO01',
        proyecto: 'Proyecto Contractual B3',
        clientId: 'ACC_DELTA',
        vendedorId: V1,
        createdBy: V1,
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 25000,
        costo_venta: 18000,
        requiere_contrato: true,
        datos: {
          requiere_contrato: true
        }
      };

      // Enforce strict Firestore transaction rule: NO tx.get allowed after first tx.set/tx.update/tx.create/tx.delete
      const dbInst = admin.firestore();
      const baseRunTx = dbInst.runTransaction.bind(dbInst);
      const strictDb = Object.create(dbInst);
      strictDb.runTransaction = async (updateFn) => {
        return baseRunTx(async (tx) => {
          let hasWritten = false;
          const strictTx = {
            get: async (...args) => {
              if (hasWritten) {
                throw new Error('Firestore transactions require all reads to be executed before all writes.');
              }
              return tx.get(...args);
            },
            set: (...args) => { hasWritten = true; return tx.set(...args); },
            update: (...args) => { hasWritten = true; return tx.update(...args); },
            create: (...args) => { hasWritten = true; return tx.create(...args); },
            delete: (...args) => { hasWritten = true; return tx.delete(...args); }
          };
          return updateFn(strictTx);
        });
      };

      const commSvc = createCommercialService({ db: strictDb, FieldValue, suffix: '_prod', verifyManager: async () => false });
      const wfSvc = createProspectWorkflowService({ db: strictDb, FieldValue, kit: commSvc.kit, suffix: '_prod' });
      const closeRes = await wfSvc.finalizeProspect({
        caller: callerUser(V1),
        prospectId: 'OPP_ALTO_01',
        data: {
          requiere_contrato: true,
          firmante_cierre: { tipo: 'apoderado', powerId: powerRes.powerId },
          forma_pago: '100% anticipado',
          factura_anticipo: 'FAC-B3-9001',
          encargado: 'Ing. Roberto Mena',
          doc_firmado: {
            name: 'Contrato_Firmado_Apoderado.pdf',
            storagePath: 'prod_files/prospects/OPP_ALTO_01/proyectos/Contrato_Firmado.pdf'
          },
          doc_comprobante: {
            name: 'Anticipo_9001.pdf',
            storagePath: 'prod_files/prospects/OPP_ALTO_01/facturas/Anticipo_9001.pdf'
          }
        }
      });

      expect(closeRes.status).toBe('finalized');
      expect(closeRes.estado).toBe('ganado');
      expect(state.docs['prospects_prod/OPP_ALTO_01'].estado).toBe('ganado');
      expect(state.docs['prospects_prod/OPP_ALTO_01'].firmante_cierre).toEqual({
        tipo: 'apoderado',
        powerId: powerRes.powerId
      });
      expect(rlRes.termId).toBeDefined();
    });

    test('ALTO-02 & MEDIO-03: client_documents.js invoca CrmAccountDocuments.saveAccountDocument en submitDocumentSubstitution y no invoca recordBiennialConfirmation en submitBiennialUpload', () => {
      const clientDocsJs = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'client_documents.js'), 'utf8');
      expect(clientDocsJs).not.toContain('uploadAccountDocumentVersion');

      // Extract submitDocumentSubstitution body
      const substStart = clientDocsJs.indexOf('async function submitDocumentSubstitution()');
      const substEnd = clientDocsJs.indexOf('async function openDossierHistoryView(');
      const substBody = clientDocsJs.slice(substStart, substEnd);
      expect(substBody).toContain('CrmAccountDocuments.saveAccountDocument(');
      expect(substBody).not.toContain('clientsModule.updateClient(');

      // Extract submitBiennialUpload body
      const bienStart = clientDocsJs.indexOf('async function submitBiennialUpload()');
      const bienEnd = clientDocsJs.indexOf('async function submitBiennialExpress()');
      const bienBody = clientDocsJs.slice(bienStart, bienEnd);
      expect(bienBody).toContain('CrmAccountDocuments.saveAccountDocument(');
      expect(bienBody).not.toContain('CrmAccountDocuments.recordBiennialConfirmation(');
    });

    test('MEDIO-01: finalizeProspect rechaza cierre cuando escritura tiene revisión bienal vencida (> 730 días) o cuando el período del RL firmante venció', async () => {
      Object.assign(state.docs['clients_prod/ACC_DELTA'], {
        telefono: '7890-1234',
        correo: 'contacto@delta.com',
        correo_fact: 'facturacion@delta.com'
      });
      await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-01-10',
        fechaVencimiento: '2029-01-10',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/cred.pdf', fechaVencimiento: '2029-01-10' },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui.pdf', fechaVencimiento: '2029-01-10' }
      });

      // Set escritura lastConfirmedAt > 3 years ago
      state.docs['clients_prod/ACC_DELTA'].biennialReviews = {
        escritura: {
          lastConfirmedAt: '2022-01-01T00:00:00.000Z',
          nextReviewAt: '2024-01-01'
        }
      };

      state.docs['prospects_prod/OPP_MEDIO_01'] = {
        id: 'OPP_MEDIO_01',
        codigo: 'PRY-M01',
        proyecto: 'Proyecto Bienal Vencida',
        clientId: 'ACC_DELTA',
        vendedorId: V1,
        createdBy: V1,
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Suministro',
        precio_cotizado: 5000,
        costo_venta: 3000,
        requiere_contrato: false,
        datos: {
          doc_firmado: { name: 'Oferta.pdf', storagePath: 'prod_files/prospects/OPP_MEDIO_01/proyectos/Oferta.pdf' },
          doc_comprobante: { name: 'Anticipo.pdf', storagePath: 'prod_files/prospects/OPP_MEDIO_01/facturas/Anticipo.pdf' },
          forma_pago: '50_50',
          factura_anticipo: 'FAC-M01'
        }
      };

      const dbInst = admin.firestore();
      const commSvc = createCommercialService({ db: dbInst, FieldValue, suffix: '_prod', verifyManager: async () => false });
      const wfSvc = createProspectWorkflowService({ db: dbInst, FieldValue, kit: commSvc.kit, suffix: '_prod' });
      await expect(wfSvc.finalizeProspect({
        caller: callerUser(V1),
        prospectId: 'OPP_MEDIO_01',
        data: {}
      })).rejects.toThrow(/revisión bienal/i);

      // Fix biennial review, but expire RL term when requires contract
      state.docs['clients_prod/ACC_DELTA'].biennialReviews.escritura = {
        lastConfirmedAt: new Date().toISOString(),
        nextReviewAt: '2028-11-01'
      };
      state.docs['clients_prod/ACC_DELTA'].representanteLegalVigente.fechaVencimiento = '2024-05-01';
      state.docs['clients_prod/ACC_DELTA'].documentos.credencial.fechaVencimiento = '2029-01-10';

      await expect(wfSvc.finalizeProspect({
        caller: callerUser(V1),
        prospectId: 'OPP_MEDIO_01',
        data: {
          requiere_contrato: true,
          firmante_cierre: { tipo: 'representante_legal' }
        }
      })).rejects.toThrow(/nombramiento del Representante Legal.*venció/i);
    });

    test('MEDIO-02: recordBiennialConfirmation soporta documentos iniciales con v_base sin versionId previo materializando/vinculando versión real en document_versions', async () => {
      // Simulate initial/legacy document without versionId
      delete state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId;
      delete state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionNumber;
      expect(state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId).toBeUndefined();

      const conf = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Confirmado sobre escritura inicial de la cuenta'
      });

      expect(conf.success).toBe(true);
      expect(conf.documentVersionId).toMatch(/^v_escritura_base_/);
      expect(state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId).toBe(conf.documentVersionId);
      expect(state.docs[`clients_prod/ACC_DELTA/document_versions/${conf.documentVersionId}`]).toBeDefined();
    });

    test('MEDIO-03: recordBiennialConfirmation rechaza confirmationType distinto de no_changes / biennial_no_changes', async () => {
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura',
        estado: 'vigente'
      };
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId = 'v_esc_1';

      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'modification_uploaded',
        confirmedNoChanges: false
      })).rejects.toThrow(/Tipo de confirmación bienal inválido/);
    });

    test('MEDIO-04: idempotencia por opId en registerLegalRepresentativeTerm, grantContractPower, revokeContractPower y saveAccountDocument', async () => {
      // 1. registerLegalRepresentativeTerm idempotency
      const rl1 = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-02-01',
        fechaVencimiento: '2029-02-01',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/cred.pdf' },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/dui.pdf', fechaVencimiento: '2029-05-01' },
        opId: 'op_rl_001'
      });
      const rl2 = await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-02-01',
        fechaVencimiento: '2029-02-01',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/cred.pdf' },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/dui.pdf', fechaVencimiento: '2029-05-01' },
        opId: 'op_rl_001'
      });
      expect(rl2.idempotentReplay).toBe(true);
      expect(rl2.termId).toBe(rl1.termId);

      // Reusing opId with different nombre fails
      await expect(svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        nombre: 'Otro Nombre',
        fechaEleccion: '2026-02-01',
        credencialDoc: { name: 'Cred.pdf' },
        duiDoc: { name: 'DUI.pdf' },
        opId: 'op_rl_001'
      })).rejects.toThrow(/ya fue utilizado con parámetros distintos/);

      // 2. grantContractPower idempotency
      const pw1 = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder.pdf', storagePath: 'prod_files/poder.pdf' },
        notas: 'Poder especial',
        opId: 'op_pw_001'
      });
      const pw2 = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder.pdf', storagePath: 'prod_files/poder.pdf' },
        notas: 'Poder especial',
        opId: 'op_pw_001'
      });
      expect(pw2.idempotentReplay).toBe(true);
      expect(pw2.powerId).toBe(pw1.powerId);

      // 3. revokeContractPower idempotency
      const rev1 = await svc.revokeContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        powerId: pw1.powerId,
        motivo: 'Fin de gestión',
        opId: 'op_rev_001'
      });
      const rev2 = await svc.revokeContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        powerId: pw1.powerId,
        motivo: 'Fin de gestión',
        opId: 'op_rev_001'
      });
      expect(rev2.idempotentReplay).toBe(true);
      expect(rev2.powerId).toBe(rev1.powerId);

      // 4. saveAccountDocument idempotency
      const sha = '9'.repeat(64);
      const sd1 = await svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'nit',
        doc: { name: 'NIT_v2.pdf', storagePath: 'prod_files/nit_v2.pdf', sha256: sha },
        motivoSustitucion: 'Actualización NIT',
        opId: 'op_save_001'
      });
      const sd2 = await svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'nit',
        doc: { name: 'NIT_v2.pdf', storagePath: 'prod_files/nit_v2.pdf', sha256: sha },
        motivoSustitucion: 'Actualización NIT',
        opId: 'op_save_001'
      });
      expect(sd2.idempotentReplay).toBe(true);
      expect(sd2.versionId).toBe(sd1.versionId);
    });

    test('MEDIO-05 & PUNTO 1: storage.rules autoriza cargas de identificación con visibleTo, pero restringe /legal/ y /poderes/ al responsable actual o vendedor en cierre', () => {
      const storageRules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');
      expect(storageRules).toContain('function isClientCurrentResponsible(cid)');
      expect(storageRules).toMatch(/isAuthorizedClientUpload\(cid\)[\s\S]*?isClientCurrentResponsible\(cid\)[\s\S]*?isClientVisible\(cid\)/);
      expect(storageRules).toMatch(/isAuthorizedLegalAccess\(cid\)[\s\S]*?isClientCurrentResponsible\(cid\)[\s\S]*?isClientClosing\(cid\)[\s\S]*?isReservationValid\(cid\)/);
      expect(storageRules).toMatch(/isAuthorizedLegalUpload\(cid\)[\s\S]*?isClientCurrentResponsible\(cid\)[\s\S]*?isClientClosing\(cid\)[\s\S]*?isReservationValid\(cid\)/);
      // Verify /legal/ and /poderes/ do NOT include isClientVisible(cid)
      const legalFnMatch = storageRules.match(/function isAuthorizedLegalAccess\(cid\)\s*\{[\s\S]*?\}/);
      expect(legalFnMatch).not.toBeNull();
      expect(legalFnMatch[0]).not.toContain('isClientVisible');
      const legalUploadFnMatch = storageRules.match(/function isAuthorizedLegalUpload\(cid\)\s*\{[\s\S]*?\}/);
      expect(legalUploadFnMatch).not.toBeNull();
      expect(legalUploadFnMatch[0]).not.toContain('isClientVisible');
    });

    test('BAJO-01: grantContractPower persiste notas y retorna objeto power; registerLegalRepresentativeTerm preserva fechaVencimiento en duiDoc', async () => {
      await svc.registerLegalRepresentativeTerm({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-03-01',
        fechaVencimiento: '2029-03-01',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/cred.pdf', fechaVencimiento: '2029-03-01' },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/dui.pdf', fechaVencimiento: '2030-08-15' }
      });

      const clientAfterRL = state.docs['clients_prod/ACC_DELTA'];
      expect(clientAfterRL.documentos.dui.fechaVencimiento).toBe('2030-08-15');
      expect(clientAfterRL.representanteLegalVigente.duiDoc.fechaVencimiento).toBe('2030-08-15');

      const pwRes = await svc.grantContractPower({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder.pdf', storagePath: 'prod_files/poder.pdf' },
        notas: 'Limitado a proyectos de climatización industrial'
      });

      expect(pwRes.notas).toBe('Limitado a proyectos de climatización industrial');
      expect(pwRes.power).toBeDefined();
      expect(pwRes.power.notas).toBe('Limitado a proyectos de climatización industrial');
      expect(state.docs[`clients_prod/ACC_DELTA/contract_powers/${pwRes.powerId}`].notas).toBe('Limitado a proyectos de climatización industrial');
      expect(state.docs['clients_prod/ACC_DELTA'].apoderadosVigentes[0].notas).toBe('Limitado a proyectos de climatización industrial');
    });

    test('BAJO-03: scripts/verify_b3_browser_real.js no contiene rutas locales hardcodeadas (/Users/...)', () => {
      const verifyScript = fs.readFileSync(path.join(ROOT, 'scripts', 'verify_b3_browser_real.js'), 'utf8');
      expect(verifyScript).not.toContain('/Users/Benjamin');
    });

    test('BAJO-04: saveAccountDocument exige sha256 y nueva fechaVencimiento vigente al renovar un documento vencido', async () => {
      const expiredSha = 'a'.repeat(64);
      const newSha = 'b'.repeat(64);
      state.docs['clients_prod/ACC_DELTA'].documentos.dui = {
        name: 'DUI_Vencido.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui_old.pdf',
        versionId: 'v_dui_old',
        versionNumber: 1,
        sha256: expiredSha,
        fechaVencimiento: '2024-01-01'
      };

      // Sin sha256 -> rechaza
      await expect(svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: { name: 'DUI_Nuevo.pdf', storagePath: 'prod_files/dui_new.pdf' },
        fechaVencimiento: '2029-12-31'
      })).rejects.toThrow(/obligatorio proporcionar la huella digital SHA-256/);

      // Sin fechaVencimiento -> rechaza
      await expect(svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: { name: 'DUI_Nuevo.pdf', storagePath: 'prod_files/dui_new.pdf', sha256: newSha }
      })).rejects.toThrow(/obligatorio especificar la nueva fecha de vencimiento/);

      // Con fechaVencimiento posterior a 2024-01-01 pero todavía vencida (2025-01-01 < hoy) -> rechaza
      await expect(svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'dui',
        doc: { name: 'DUI_Nuevo.pdf', storagePath: 'prod_files/dui_new.pdf', sha256: newSha },
        fechaVencimiento: '2025-01-01'
      })).rejects.toThrow(/ya se encuentra vencida/);
    });
  });

  // ===========================================================================
  // 7. Ronda Correctiva Final B3: PUNTO 2, PUNTO 3 y PUNTO 4
  // ===========================================================================
  describe('7. Ronda Correctiva Final B3 — Integridad v_base, Concurrencia y Huellas Semánticas de Idempotencia', () => {
    beforeEach(() => {
      state.docs['clients_prod/ACC_DELTA'].documentos = {
        escritura: {
          name: 'Escritura_Base.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/escritura_base.pdf'
        },
        nit: {
          name: 'NIT.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/nit.pdf',
          versionId: 'v_nit_1',
          versionNumber: 1
        }
      };
      delete state.docs['clients_prod/ACC_DELTA/document_versions/v_escritura_1'];
    });

    test('PUNTO 2: rechaza materializar v_base si currentActiveDoc solo contiene name o metadatos sin referencia válida a Storage', async () => {
      // Caso 1: Solo { name } sin storagePath ni url
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura = {
        name: 'Escritura_Solo_Nombre.pdf',
        ext: 'pdf'
      };
      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/no cuenta con un archivo válido en Storage/);

      // Caso 2: storagePath vacío
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura = {
        name: 'Escritura_Vacia.pdf',
        storagePath: '   ',
        url: ''
      };
      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/no cuenta con un archivo válido en Storage/);

      // Caso 3: storagePath corrupto o con secuencias prohibidas (.. o sin prefijo válido)
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura = {
        name: 'Escritura_Corrupta.pdf',
        storagePath: '../outside/escritura.pdf'
      };
      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/no cuenta con un archivo válido en Storage/);

      // Verificar que NO se creó ninguna versión ficticia ni confirmación bienal
      const versionKeys = Object.keys(state.docs).filter(k => k.startsWith('clients_prod/ACC_DELTA/document_versions/'));
      expect(versionKeys).toHaveLength(0);
      const confKeys = Object.keys(state.docs).filter(k => k.startsWith('clients_prod/ACC_DELTA/biennial_confirmations/'));
      expect(confKeys).toHaveLength(0);
    });

    test('PUNTO 2 & PUNTO 3: materializa v_base con ID determinístico (v_escritura_base_1) cuando hay storagePath o url válido y resuelve llamadas subsecuentes con v_base sin duplicar versiones', async () => {
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura = {
        name: 'Escritura_Real.pdf',
        storagePath: 'prod_files/clients/ACC_DELTA/legal/escritura_real.pdf',
        size: 204800,
        contentType: 'application/pdf'
      };

      const res1 = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Confirmación inicial v_base',
        opId: 'op_vbase_1'
      });

      expect(res1.documentVersionId).toBe('v_escritura_base_1');
      const baseVer = state.docs['clients_prod/ACC_DELTA/document_versions/v_escritura_base_1'];
      expect(baseVer).toBeDefined();
      expect(baseVer.storagePath).toBe('prod_files/clients/ACC_DELTA/legal/escritura_real.pdf');
      expect(baseVer.size).toBe(204800);
      expect(baseVer.contentType).toBe('application/pdf');
      expect(state.docs['clients_prod/ACC_DELTA'].documentos.escritura.versionId).toBe('v_escritura_base_1');

      // Segunda llamada concurrente/subsecuente que aún envía documentVersionId: 'v_base' con distinto opId
      const res2 = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Segunda confirmación concurrente con v_base',
        opId: 'op_vbase_2'
      });

      expect(res2.documentVersionId).toBe('v_escritura_base_1');
      const escrituraVersions = Object.keys(state.docs).filter(
        k => k.startsWith('clients_prod/ACC_DELTA/document_versions/') && state.docs[k].docKey === 'escritura'
      );
      expect(escrituraVersions).toHaveLength(1);
    });

    test('PUNTO 3: rechaza v_base si la cuenta ya avanzó a una versión superior (v2+)', async () => {
      // Materializa v1
      await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      });

      // Carga v2 mediante saveAccountDocument
      await svc.saveAccountDocument({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        doc: {
          name: 'Escritura_v2.pdf',
          storagePath: 'prod_files/clients/ACC_DELTA/legal/escritura_v2.pdf',
          sha256: 'c'.repeat(64)
        },
        motivoSustitucion: 'Reforma de estatutos'
      });

      // Intentar confirmar v_base cuando ya existe v2 debe fallar con failed-precondition
      await expect(svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true
      })).rejects.toThrow(/versión desactualizada/);
    });

    test('PUNTO 4: huella semántica canónica en las 5 operaciones rechaza reutilización de opId ante cambios en cualquier parámetro primario o secundario', async () => {
      // 1. registerLegalRepresentativeTerm
      const baseRL = {
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_ANA',
        nombre: 'Ana Gómez',
        fechaEleccion: '2026-03-01',
        fechaVencimiento: '2031-03-01',
        credencialDoc: { name: 'Cred.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/cred1.pdf', sha256: '1'.repeat(64) },
        duiDoc: { name: 'DUI.pdf', storagePath: 'prod_files/clients/ACC_DELTA/identificacion/dui1.pdf', sha256: '2'.repeat(64) },
        opId: 'op_fp_rl_1'
      };
      const rl1 = await svc.registerLegalRepresentativeTerm(baseRL);
      expect(rl1.success).toBe(true);

      // Reintento idéntico (incluso con orden distinto de propiedades en objetos anidados) -> idempotentReplay: true
      const rlReplay = await svc.registerLegalRepresentativeTerm({
        ...baseRL,
        credencialDoc: { sha256: '1'.repeat(64), storagePath: 'prod_files/clients/ACC_DELTA/legal/cred1.pdf', name: 'Cred.pdf' }
      });
      expect(rlReplay.idempotentReplay).toBe(true);
      expect(rlReplay.termId).toBe(rl1.termId);

      // Cambio en parámetro secundario: fechaVencimiento
      await expect(svc.registerLegalRepresentativeTerm({
        ...baseRL,
        fechaVencimiento: '2032-03-01'
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio en parámetro secundario: contactId
      await expect(svc.registerLegalRepresentativeTerm({
        ...baseRL,
        contactId: 'CONT_CARLOS'
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio en parámetro secundario: credencialDoc.storagePath
      await expect(svc.registerLegalRepresentativeTerm({
        ...baseRL,
        credencialDoc: { ...baseRL.credencialDoc, storagePath: 'prod_files/clients/ACC_DELTA/legal/cred_other.pdf' }
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio en parámetro secundario: duiDoc.sha256
      await expect(svc.registerLegalRepresentativeTerm({
        ...baseRL,
        duiDoc: { ...baseRL.duiDoc, sha256: '3'.repeat(64) }
      })).rejects.toThrow(/parámetros distintos/);

      // 2. grantContractPower
      const basePower = {
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        contactId: 'CONT_CARLOS',
        documento: { name: 'Poder1.pdf', storagePath: 'prod_files/clients/ACC_DELTA/poderes/p1.pdf', sha256: '4'.repeat(64) },
        notas: 'Notas originales',
        opId: 'op_fp_pw_1'
      };
      const pw1 = await svc.grantContractPower(basePower);
      expect(pw1.success).toBe(true);

      // Reintento idéntico -> idempotentReplay: true
      const pwReplay = await svc.grantContractPower({ ...basePower });
      expect(pwReplay.idempotentReplay).toBe(true);

      // Cambio secundario en documento.storagePath
      await expect(svc.grantContractPower({
        ...basePower,
        documento: { ...basePower.documento, storagePath: 'prod_files/clients/ACC_DELTA/poderes/p2.pdf' }
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio secundario en notas
      await expect(svc.grantContractPower({
        ...basePower,
        notas: 'Notas alteradas'
      })).rejects.toThrow(/parámetros distintos/);

      // 3. revokeContractPower
      const baseRevoke = {
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        powerId: pw1.powerId,
        motivo: 'Motivo original',
        opId: 'op_fp_rev_1'
      };
      const rev1 = await svc.revokeContractPower(baseRevoke);
      expect(rev1.success).toBe(true);

      const revReplay = await svc.revokeContractPower({ ...baseRevoke });
      expect(revReplay.idempotentReplay).toBe(true);

      await expect(svc.revokeContractPower({
        ...baseRevoke,
        motivo: 'Motivo cambiado'
      })).rejects.toThrow(/parámetros distintos/);

      // 4. recordBiennialConfirmation
      const baseBiennial = {
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_base',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        notas: 'Sin cambios 2026',
        opportunityId: 'OPP_1',
        opId: 'op_fp_bi_1'
      };
      const bi1 = await svc.recordBiennialConfirmation(baseBiennial);
      expect(bi1.success).toBe(true);

      const biReplay = await svc.recordBiennialConfirmation({ ...baseBiennial });
      expect(biReplay.idempotentReplay).toBe(true);

      // Cambio secundario en notas
      await expect(svc.recordBiennialConfirmation({
        ...baseBiennial,
        notas: 'Con notas distintas'
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio secundario en opportunityId
      await expect(svc.recordBiennialConfirmation({
        ...baseBiennial,
        opportunityId: 'OPP_2'
      })).rejects.toThrow(/parámetros distintos/);

      // 5. saveAccountDocument
      const baseSave = {
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'nit',
        doc: { name: 'NIT_2026.pdf', storagePath: 'prod_files/clients/ACC_DELTA/legal/nit_2026.pdf', sha256: '5'.repeat(64) },
        motivoSustitucion: 'Actualización fiscal',
        fechaVencimiento: '2030-12-31',
        opId: 'op_fp_save_1'
      };
      const sv1 = await svc.saveAccountDocument(baseSave);
      expect(sv1.success).toBe(true);

      const svReplay = await svc.saveAccountDocument({ ...baseSave });
      expect(svReplay.idempotentReplay).toBe(true);

      // Cambio secundario en storagePath (incluso sin cambiar sha256 o sin sha256)
      await expect(svc.saveAccountDocument({
        ...baseSave,
        doc: { ...baseSave.doc, storagePath: 'prod_files/clients/ACC_DELTA/legal/nit_otro.pdf' }
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio secundario en motivoSustitucion
      await expect(svc.saveAccountDocument({
        ...baseSave,
        motivoSustitucion: 'Otro motivo distinto'
      })).rejects.toThrow(/parámetros distintos/);

      // Cambio secundario en fechaVencimiento
      await expect(svc.saveAccountDocument({
        ...baseSave,
        fechaVencimiento: '2031-12-31'
      })).rejects.toThrow(/parámetros distintos/);
    });
  });
});
