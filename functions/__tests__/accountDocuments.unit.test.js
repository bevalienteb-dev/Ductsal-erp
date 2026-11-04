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

    test('Opción B: confirmación expresa sin cambios renueva el período por 2 años', async () => {
      state.docs['clients_prod/ACC_DELTA'].documentos.escritura.actualizadoEn = '2024-01-01T10:00:00.000Z';
      state.docs['clients_prod/ACC_DELTA/document_versions/v_esc_1'] = {
        versionId: 'v_esc_1',
        versionNumber: 1,
        docKey: 'escritura'
      };

      const confRes = await svc.recordBiennialConfirmation({
        caller: callerUser(V1),
        accountId: 'ACC_DELTA',
        docKey: 'escritura',
        documentVersionId: 'v_esc_1',
        confirmationType: 'no_changes',
        confirmedNoChanges: true,
        opportunityId: 'PROSP_1'
      });

      expect(confRes.success).toBe(true);
      expect(confRes.docKey).toBe('escritura');
      expect(confRes.nextReviewAt).toMatch(/^2028-/);

      // Verify client biennial review projection
      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.biennialReviews.escritura).toBeDefined();
      expect(client.biennialReviews.escritura.nextReviewAt).toMatch(/^2028-/);
    });

    test('Opción A: incorporar nueva modificación renueva el período de revisión bienal', async () => {
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

      const client = state.docs['clients_prod/ACC_DELTA'];
      expect(client.biennialReviews.mods_escritura).toBeDefined();
      expect(client.biennialReviews.mods_escritura.nextReviewAt).toMatch(/^2028-/);
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
});
