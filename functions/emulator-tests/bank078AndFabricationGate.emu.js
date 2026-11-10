// functions/emulator-tests/bank078AndFabricationGate.emu.js
// ======================================================================================================
// DUCTSAL ERP — Cierre técnico de BANK_078 e integración segura con Fabricación
// Suite de integración real contra Firebase Emulator Suite (Auth: 9099, Firestore: 8080 + firestore.rules, Functions: 5001)
// Cubre los 10 casos obligatorios de la Sección C.
// ======================================================================================================

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const H = require('./helpers');

const DB_SUFFIX = '_prod';
const TAG = `b078_${Date.now()}`;
const RULES_PATH = path.resolve(__dirname, '../../firestore.rules');
const DOCS_URL = `${H.FIRESTORE}/v1/projects/${H.PROJECT}/databases/(default)/documents`;

const PERSONAS = {
  manager: {
    uid: `uid_mgr_${TAG}`,
    email: `mgr.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000901',
    nombre: 'Gerente General',
    role: 'manager',
    claims: { role: 'manager', manager: true, cid: '1000000000901' }
  },
  gestor: {
    uid: `uid_ges_${TAG}`,
    email: `ges.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000902',
    nombre: 'Gestor Financiero',
    role: 'gestor',
    claims: { role: 'gestor', cid: '1000000000902' }
  },
  jefe: {
    uid: `uid_jefe_${TAG}`,
    email: `jefe.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1800000000903',
    nombre: 'Jefe de Producción',
    role: 'jefe_produccion',
    claims: { role: 'jefe_produccion', cid: '1800000000903' }
  },
  recepcion: {
    uid: `uid_recep_${TAG}`,
    email: `recep.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1800000000904',
    nombre: 'Recepción Planta',
    role: 'recepcion',
    claims: { role: 'recepcion', cid: '1800000000904' }
  },
  dibujante: {
    uid: `uid_dibu_${TAG}`,
    email: `dibu.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1800000000905',
    nombre: 'Dibujante Planta',
    role: 'dibujante',
    claims: { role: 'dibujante', cid: '1800000000905' }
  },
  operario: {
    uid: `uid_oper_${TAG}`,
    email: `oper.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1800000000906',
    nombre: 'Operario Planta',
    role: 'operario',
    claims: { role: 'operario', cid: '1800000000906' }
  }
};

const tokens = {};
let adminApp = null;
let adminAuth = null;

async function loadRealFirestoreRules() {
  const rulesContent = fs.readFileSync(RULES_PATH, 'utf8');
  const res = await fetch(`${H.FIRESTORE}/emulator/v1/projects/${H.PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: {
        files: [{ name: 'firestore.rules', content: rulesContent }]
      }
    })
  });
  if (res.status !== 200) {
    throw new Error(`Failed to load firestore.rules into emulator: ${res.status} ${await res.text()}`);
  }
}

async function clientSetDoc(collection, docId, data, idToken) {
  const res = await fetch(`${DOCS_URL}/${collection}/${docId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ fields: H.encodeFields(data) })
  });
  return { status: res.status, text: await res.text() };
}

async function clientCreateDoc(collection, docId, data, idToken) {
  const res = await fetch(`${DOCS_URL}/${collection}?documentId=${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ fields: H.encodeFields(data) })
  });
  return { status: res.status, text: await res.text() };
}

async function clientPatchDoc(collection, docId, patchData, idToken) {
  const mask = Object.keys(patchData)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${DOCS_URL}/${collection}/${docId}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ fields: H.encodeFields(patchData) })
  });
  return { status: res.status, text: await res.text() };
}

const fileUrl = name => ({
  name,
  url: `https://firebasestorage.googleapis.com/v0/b/${H.PROJECT}.appspot.com/o/prod_files%2F${encodeURIComponent(name)}?alt=media`
});

beforeAll(async () => {
  await H.assertEmulatorsUp();
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

  await loadRealFirestoreRules();

  adminApp = admin.apps.find(a => a && a.name === `emu_admin_${TAG}`)
    || admin.initializeApp({ projectId: H.PROJECT }, `emu_admin_${TAG}`);
  adminAuth = adminApp.auth();

  for (const [key, p] of Object.entries(PERSONAS)) {
    const up = await H.signUp(p.email, p.password);
    p.uid = up.uid;
    await adminAuth.setCustomUserClaims(p.uid, p.claims);
    await H.setDoc(`users${DB_SUFFIX}`, p.cid, {
      id: p.cid,
      authUid: p.uid,
      nombre: p.nombre,
      email: p.email,
      role: p.role,
      activo: true
    });
    const signed = await H.signIn(p.email, p.password);
    tokens[key] = signed.idToken;
  }
});

afterAll(async () => {
  if (adminApp) {
    await adminApp.delete().catch(() => {});
  }
});

describe('Sección C — Pruebas focalizadas obligatorias en emulador (Firestore Rules + Cloud Functions)', () => {
  const CLIENT_CS = 'CUST-1777081077121-95';
  const OPP_PRES = '1779123328318';
  const INV_PRES = '1789408613812';
  const PAY_PRES = '1789408660067';

  const OPP_DESIRE = 'OPP-1777081077278-7';
  const INV_DESIRE = '1789408531939';
  const PAY_DESIRE = '1789408594230';

  async function seedBank078CollisionScenario() {
    await H.setDoc(`clients${DB_SUFFIX}`, CLIENT_CS, {
      id: CLIENT_CS,
      tipo: 'juridica',
      empresa: 'CONSTRU-SERVICES, S.A. DE C.V.',
      nit: '0614-123456-101-2',
      nrc: '123456-7',
      es_exportacion: false,
      is_gran_contribuyente: false,
      createdBy: PERSONAS.manager.cid,
      visibleTo: [PERSONAS.manager.cid, PERSONAS.gestor.cid]
    });

    await H.setDoc(`prospects${DB_SUFFIX}`, OPP_PRES, {
      id: OPP_PRES,
      codigo: '202605023',
      proyecto: 'PRESURIZACION DE ESCALERAS PROYECTO DESIRE',
      clientId: CLIENT_CS,
      vendedorId: PERSONAS.manager.cid,
      createdBy: PERSONAS.manager.cid,
      estado: 'ganado',
      etapa: 'cierre',
      precio_cotizado: 16214.50,
      forma_pago: '50/50',
      datos: {
        forma_pago: '50/50',
        doc_firmado: fileUrl('contrato_presurizacion.pdf')
      },
      factura_anticipo_id: INV_PRES,
      facturas: [
        {
          id: INV_PRES,
          numero: '078',
          monto: 9161.19,
          fecha: '2026-08-29',
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileUrl('CCF_078_PRESURIZACION.pdf'),
          pagos: [
            {
              id: PAY_PRES,
              fecha: '2026-09-09',
              monto: 9161.19,
              metodo: 'transferencia',
              ref: '078',
              doc_comprobante: fileUrl('abono_50_presurizacion.pdf')
            }
          ]
        }
      ],
      logs: []
    });

    await H.setDoc(`prospects${DB_SUFFIX}`, OPP_DESIRE, {
      id: OPP_DESIRE,
      codigo: 'DESIRE',
      proyecto: 'EDIFICIO DESIRE',
      clientId: CLIENT_CS,
      vendedorId: PERSONAS.manager.cid,
      createdBy: PERSONAS.manager.cid,
      estado: 'ganado',
      etapa: 'cierre',
      precio_cotizado: 13844.81,
      forma_pago: '50/50',
      datos: {
        forma_pago: '50/50',
        doc_firmado: fileUrl('contrato_desire.pdf')
      },
      factura_anticipo_id: INV_DESIRE,
      facturas: [
        {
          id: INV_DESIRE,
          numero: '078',
          monto: 7822.32,
          fecha: '2026-09-02',
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileUrl('CCF_078_DESIRE.pdf'),
          pagos: [
            {
              id: PAY_DESIRE,
              fecha: '2026-09-09',
              monto: 7822.32,
              metodo: 'transferencia',
              ref: '078',
              doc_comprobante: fileUrl('abono_50_desire.pdf')
            }
          ]
        }
      ],
      logs: []
    });

    await H.setDoc(`payment_refs${DB_SUFFIX}`, 'BANK_078', {
      normRef: '078',
      ref: '078',
      active: true,
      estado: 'conflicto_historico_auditoria',
      bloqueado_nuevos_usos: true,
      motivo_bloqueo: 'Referencia bancaria histórica duplicada en 2 pagos antes del índice transaccional.',
      pagos_en_conflicto: [
        {
          prospectId: OPP_PRES,
          codigo: '202605023',
          invoiceId: INV_PRES,
          invoiceNum: '078',
          paymentId: PAY_PRES,
          monto: 9161.19,
          fecha: '2026-09-09'
        },
        {
          prospectId: OPP_DESIRE,
          codigo: 'DESIRE',
          invoiceId: INV_DESIRE,
          invoiceNum: '078',
          paymentId: PAY_DESIRE,
          monto: 7822.32,
          fecha: '2026-09-09'
        }
      ]
    });

    await H.deleteDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650');
    await H.deleteDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650202605023');
    await H.deleteDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650DESIRE');
  }

  test('Caso 3: Rechazo si la suma de aplicaciones supera el importe total del comprobante (US$16,983.51)', async () => {
    await seedBank078CollisionScenario();

    const exceedCall = await H.callFunction(
      'resolveHistoricalBankConflictAdmin',
      {
        dbSuffix: DB_SUFFIX,
        conflictLockId: 'BANK_078',
        opId: `OP_EXCEED_${TAG}`,
        resolutionType: 'split_single_transfer_across_opportunities',
        trueBankRef: '868355650',
        bankName: 'Banco Agrícola',
        transferTotalAmount: 16983.50, // menor que 9161.19 + 7822.32 = 16983.51
        transferDate: '2026-09-09',
        consolidatedDteNumber: 'DTE-03-M001P001-000000000000078',
        consolidatedDteTotal: 16983.52,
        justification: 'Intento con suma de aplicaciones mayor al comprobante bancario.',
        allocations: [
          {
            prospectId: OPP_PRES,
            invoiceId: INV_PRES,
            paymentId: PAY_PRES,
            expectedAmount: 9161.19,
            applicationId: 'APP_868355650_1779123328318_1789408613812',
            tramoId: 'TRAMO_1_202605023'
          },
          {
            prospectId: OPP_DESIRE,
            invoiceId: INV_DESIRE,
            paymentId: PAY_DESIRE,
            expectedAmount: 7822.32,
            applicationId: 'APP_868355650_OPP-1777081077278-7_1789408531939',
            tramoId: 'TRAMO_2_DESIRE'
          }
        ]
      },
      tokens.manager
    );

    expect(exceedCall.error).toBeDefined();
    expect(exceedCall.error.status).toBe('FAILED_PRECONDITION');
    expect(exceedCall.error.message).toMatch(/supera el importe total del comprobante bancario|excede el importe total del comprobante bancario/i);

    const lock078After = await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_078');
    expect(lock078After.data.active).toBe(true);
    expect(lock078After.data.estado).toBe('conflicto_historico_auditoria');
    expect(await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650')).toBeNull();
  });

  test('Caso 1: Resolución de BANK_078 con preservación de ambos pagos bajo la referencia bancaria única 868355650', async () => {
    await seedBank078CollisionScenario();

    const res = await H.callFunction(
      'resolveHistoricalBankConflictAdmin',
      {
        dbSuffix: DB_SUFFIX,
        conflictLockId: 'BANK_078',
        opId: `OP_RESOLVE_078_${TAG}`,
        resolutionType: 'split_single_transfer_across_opportunities',
        trueBankRef: '868355650',
        bankName: 'Banco Agrícola',
        transferTotalAmount: 16983.51,
        transferDate: '2026-09-09',
        consolidatedDteNumber: 'DTE-03-M001P001-000000000000078',
        consolidatedDteCodigoGeneracion: 'CCF-078-CONSOLIDADO-CONSTRU-SERVICES',
        consolidatedDteTotal: 16983.52,
        roundingDifferenceReason: 'El DTE consolidado #078 redondeó al alza la base neta del 50% de Chute ($6,922.405 -> $6,922.41) y calculó el IVA del 13% sobre el subtotal combinado ($15,029.66 * 0.13 = $1,953.8558 -> $1,953.86), generando +$0.01 frente a la suma de las 2 facturas en el CRM ($9,161.19 + $7,822.32 = $16,983.51).',
        justification: 'Conciliación documental auditada: transferencia única #868355650 por US$16,983.51 aplicada a dos facturas de anticipo de CONSTRU-SERVICES.',
        allocations: [
          {
            prospectId: OPP_PRES,
            invoiceId: INV_PRES,
            paymentId: PAY_PRES,
            expectedAmount: 9161.19,
            applicationId: 'APP_868355650_1779123328318_1789408613812',
            tramoId: 'TRAMO_1_202605023',
            concepto: '50% Anticipo Presurización de Escaleras'
          },
          {
            prospectId: OPP_DESIRE,
            invoiceId: INV_DESIRE,
            paymentId: PAY_DESIRE,
            expectedAmount: 7822.32,
            applicationId: 'APP_868355650_OPP-1777081077278-7_1789408531939',
            tramoId: 'TRAMO_2_DESIRE',
            concepto: '50% Anticipo Ducto Chute de Basura'
          }
        ]
      },
      tokens.manager
    );

    expect(res.error).toBeUndefined();
    expect(res.result.status).toBe('resolved');
    expect(res.result.trueBankRef).toBe('868355650');
    expect(res.result.totalApplied).toBe(16983.51);
    expect(res.result.saldoDisponibleComprobante).toBe(0);

    // 1. Verificar que ambos pagos mantienen su monto y la referencia bancaria única '868355650'
    const pPres = await H.getDoc(`prospects${DB_SUFFIX}`, OPP_PRES);
    const pay1 = pPres.data.facturas[0].pagos[0];
    expect(pay1.monto).toBe(9161.19);
    expect(pay1.ref).toBe('868355650');
    expect(pay1.ref_bancaria_real).toBe('868355650');
    expect(pay1.ref_historica_original).toBe('078');
    expect(pay1.aplicacion_id).toBe('APP_868355650_1779123328318_1789408613812');
    expect(pay1.tramo_id).toBe('TRAMO_1_202605023');
    expect(pay1.confirmado).toBe(true);

    const pDesire = await H.getDoc(`prospects${DB_SUFFIX}`, OPP_DESIRE);
    const pay2 = pDesire.data.facturas[0].pagos[0];
    expect(pay2.monto).toBe(7822.32);
    expect(pay2.ref).toBe('868355650');
    expect(pay2.ref_bancaria_real).toBe('868355650');
    expect(pay2.ref_historica_original).toBe('078');
    expect(pay2.aplicacion_id).toBe('APP_868355650_OPP-1777081077278-7_1789408531939');
    expect(pay2.tramo_id).toBe('TRAMO_2_DESIRE');
    expect(pay2.confirmado).toBe(true);

    // 2. Verificar que NO se crearon sub-referencias bancarias ficticias
    expect(await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650202605023')).toBeNull();
    expect(await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650DESIRE')).toBeNull();

    // 3. Verificar estructura de 7 puntos en payment_refs_prod/BANK_868355650
    const lock868 = (await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_868355650')).data;
    expect(lock868.ref).toBe('868355650');
    expect(lock868.normRef).toBe('868355650');
    expect(lock868.transaccion_bancaria.referencia_bancaria_unica).toBe('868355650');
    expect(lock868.importe_total_comprobante).toBe(16983.51);
    expect(lock868.total_aplicado).toBe(16983.51);
    expect(lock868.saldo_disponible).toBe(0);
    expect(lock868.aplicaciones).toHaveLength(2);
    expect(lock868.auditoria.resuelto_por_cid).toBe(PERSONAS.manager.cid);

    // 4. Verificar que BANK_078 pasó a active: false y estado: 'resuelto_historico'
    const lock078 = (await H.getDoc(`payment_refs${DB_SUFFIX}`, 'BANK_078')).data;
    expect(lock078.active).toBe(false);
    expect(lock078.estado).toBe('resuelto_historico');
    expect(lock078.bloqueado_nuevos_usos).toBe(true);
    expect(lock078.referencia_bancaria_real).toBe('868355650');
  });

  test('Caso 2: Rechazo de tercer uso del comprobante 868355650 (y de la referencia histórica 078)', async () => {
    const oppThirdId = `OPP_THIRD_${TAG}`;
    await H.setDoc(`prospects${DB_SUFFIX}`, oppThirdId, {
      id: oppThirdId,
      codigo: '202611999',
      proyecto: 'TERCERA OPORTUNIDAD CONSTRU-SERVICES',
      clientId: CLIENT_CS,
      vendedorId: PERSONAS.manager.cid,
      createdBy: PERSONAS.manager.cid,
      estado: 'ganado',
      etapa: 'cierre',
      precio_cotizado: 5000,
      forma_pago: '50/50',
      datos: { forma_pago: '50/50', doc_firmado: fileUrl('c3.pdf') },
      factura_anticipo_id: 'INV-THIRD-1',
      facturas: [
        {
          id: 'INV-THIRD-1',
          numero: 'CCF-999',
          monto: 2825,
          fecha: '2026-11-10',
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileUrl('f3.pdf'),
          pagos: []
        }
      ],
      logs: []
    });

    const reuse868 = await H.callFunction(
      'savePaymentAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: oppThirdId,
        invoiceId: 'INV-THIRD-1',
        opId: `OP_REUSE_868_${TAG}`,
        monto: 100,
        metodo: 'transferencia',
        ref: '868355650',
        doc_comprobante: fileUrl('reuse868.pdf')
      },
      tokens.gestor
    );
    expect(reuse868.error).toBeDefined();
    expect(reuse868.error.status).toBe('FAILED_PRECONDITION');
    expect(reuse868.error.message).toMatch(/868355650/);

    const reuse078 = await H.callFunction(
      'savePaymentAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: oppThirdId,
        invoiceId: 'INV-THIRD-1',
        opId: `OP_REUSE_078_${TAG}`,
        monto: 100,
        metodo: 'transferencia',
        ref: '078',
        doc_comprobante: fileUrl('reuse078.pdf')
      },
      tokens.gestor
    );
    expect(reuse078.error).toBeDefined();
    expect(reuse078.error.status).toBe('FAILED_PRECONDITION');
  });

  test('Caso 4: Rechazo de escritura directa en proyectos_fabricacion_prod desde cliente con ANTICIPO_CONFIRMADO', async () => {
    for (const roleKey of ['manager', 'gestor', 'jefe', 'recepcion', 'dibujante', 'operario']) {
      const fakeProjId = `FAKE_PROJ_${roleKey}_${TAG}`;
      const attempt = await clientSetDoc(
        `proyectos_fabricacion${DB_SUFFIX}`,
        fakeProjId,
        {
          id: fakeProjId,
          codigo: '202611404',
          nombre_proyecto: 'PROYECTO BYPASS CLIENTE',
          origen_tipo: 'oportunidad',
          prospecto_id: OPP_PRES,
          estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
          autorizado_backend: true
        },
        tokens[roleKey]
      );
      expect(attempt.status).toBe(403);
      expect(await H.getDoc(`proyectos_fabricacion${DB_SUFFIX}`, fakeProjId)).toBeNull();
    }
  });

  test('Caso 5: Rechazo de creación directa en fabricacion_prod omitiendo estado de habilitación', async () => {
    for (const roleKey of ['manager', 'gestor', 'jefe', 'recepcion', 'dibujante', 'operario']) {
      const fakeOrdId = `FAKE_ORD_${roleKey}_${TAG}`;
      const attempt = await clientCreateDoc(
        `fabricacion${DB_SUFFIX}`,
        fakeOrdId,
        {
          id: fakeOrdId,
          proyecto: 'ORDEN BYPASS CLIENTE',
          etapa: 'Dibujo',
          status: 'pendiente'
        },
        tokens[roleKey]
      );
      expect(attempt.status).toBe(403);
      expect(await H.getDoc(`fabricacion${DB_SUFFIX}`, fakeOrdId)).toBeNull();
    }
  });

  test('Caso 6: Rechazo de creación directa o llamada con origen_tipo: interno falsificado para una oportunidad comercial sin anticipo', async () => {
    const unpaidOppId = `OPP_UNPAID_${TAG}`;
    await H.setDoc(`prospects${DB_SUFFIX}`, unpaidOppId, {
      id: unpaidOppId,
      codigo: '202611606',
      proyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
      clientId: CLIENT_CS,
      vendedorId: PERSONAS.manager.cid,
      createdBy: PERSONAS.manager.cid,
      estado: 'ganado',
      etapa: 'cierre',
      precio_cotizado: 10000,
      forma_pago: '50/50',
      datos: { forma_pago: '50/50', doc_firmado: fileUrl('c6.pdf') },
      factura_anticipo_id: 'INV-UNPAID-6',
      facturas: [
        {
          id: 'INV-UNPAID-6',
          numero: 'CCF-606',
          monto: 5650,
          fecha: '2026-11-10',
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileUrl('f6.pdf'),
          pagos: []
        }
      ],
      logs: []
    });

    // 6a. Escritura directa falsificando origen_tipo: 'interno' en proyectos_fabricacion_prod y fabricacion_prod -> 403
    const directProj = await clientSetDoc(
      `proyectos_fabricacion${DB_SUFFIX}`,
      `FORGED_INT_PROJ_${TAG}`,
      {
        id: `FORGED_INT_PROJ_${TAG}`,
        codigo: '202611606',
        nombre_proyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
        origen_tipo: 'interno',
        estado_habilitacion_fabricacion: 'ORDEN_INTERNA_NO_COMERCIAL'
      },
      tokens.jefe
    );
    expect(directProj.status).toBe(403);

    const directOrd = await clientSetDoc(
      `fabricacion${DB_SUFFIX}`,
      `FORGED_INT_ORD_${TAG}`,
      {
        id: `FORGED_INT_ORD_${TAG}`,
        codigo_proyecto: '202611606',
        proyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
        origen_tipo: 'interno',
        etapa: 'Fabricación',
        status: 'en_proceso'
      },
      tokens.jefe
    );
    expect(directOrd.status).toBe(403);

    // 6b. Llamada al backend falsificando origenTipo: 'interno' pero coincidiendo con el código/nombre de la oportunidad comercial sin anticipo
    const forgedBackendCall = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        fabProjectId: `FORGED_INT_PROJ_${TAG}`,
        codigoProyecto: '202611606',
        nombreProyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
        origenTipo: 'interno',
        stageTransition: 'crear_proyecto_manual',
        projectPayload: {
          id: `FORGED_INT_PROJ_${TAG}`,
          codigo: '202611606',
          nombre_proyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
          origen_tipo: 'interno'
        }
      },
      tokens.jefe
    );
    expect(forgedBackendCall.error).toBeDefined();
    expect(forgedBackendCall.error.status).toBe('FAILED_PRECONDITION');
    expect(forgedBackendCall.error.message).toBe(
      'No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$5,650.00.'
    );
  });

  test('Caso 7: Rechazo cuando el cliente envía un prospecto_id distinto al del proyecto real (OPORTUNIDAD_INCONSISTENTE)', async () => {
    const unpaidOppId = `OPP_UNPAID_${TAG}`;
    const projUnpaidId = `FAB_PROJ_UNPAID_${TAG}`;

    // Sembrar proyecto de fabricación asociado a la oportunidad sin anticipo
    await H.setDoc(`proyectos_fabricacion${DB_SUFFIX}`, projUnpaidId, {
      id: projUnpaidId,
      codigo: '202611606',
      nombre_proyecto: 'PROYECTO COMERCIAL SIN ANTICIPO',
      origen_tipo: 'oportunidad',
      prospecto_id: unpaidOppId,
      estado_habilitacion_fabricacion: 'ANTICIPO_PENDIENTE'
    });

    // El cliente intenta autorizar una orden del proyecto sin anticipo enviando el prospectId de OPP_PRES (que sí tiene anticipo pagado)
    const spoofedCall = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES, // Oportunidad pagada distinta a la del proyecto real
        fabProjectId: projUnpaidId,
        fabOrderId: `ORD_SPOOF_${TAG}`,
        codigoProyecto: '202611606',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        orderPayload: {
          id: `ORD_SPOOF_${TAG}`,
          padre_id: projUnpaidId,
          etapa: 'Dibujo',
          status: 'pendiente'
        }
      },
      tokens.jefe
    );
    expect(spoofedCall.error).toBeDefined();
    expect(spoofedCall.error.status).toBe('FAILED_PRECONDITION');
    expect(spoofedCall.error.message).toMatch(/OPORTUNIDAD_INCONSISTENTE/);
    expect(await H.getDoc(`fabricacion${DB_SUFFIX}`, `ORD_SPOOF_${TAG}`)).toBeNull();
  });

  test('Caso 8: Rechazo de transición directa Dibujo -> Fabricación por SDK cliente y rechazo de creación directa en fabricacion_tasks_prod', async () => {
    const ordInDibujoId = `ORD_DIBUJO_${TAG}`;
    await H.setDoc(`fabricacion${DB_SUFFIX}`, ordInDibujoId, {
      id: ordInDibujoId,
      padre_id: `FAB-PROJ-${OPP_PRES}`,
      prospecto_id: OPP_PRES,
      origen_tipo: 'oportunidad',
      codigo_proyecto: '202605023',
      proyecto: 'PRESURIZACION DE ESCALERAS PROYECTO DESIRE',
      etapa: 'Dibujo',
      status: 'pendiente',
      estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
      autorizado_backend: true,
      liberado_a_fabricacion_backend: false,
      discrepancia_financiera: false,
      bloqueado_avance_etapa: false
    });

    // 8a. Actualización legítima dentro de Dibujo (ej. asignar dibujante / nota) -> PERMITIDA (200)
    const drawingUpdate = await clientPatchDoc(
      `fabricacion${DB_SUFFIX}`,
      ordInDibujoId,
      { dibujante_asignado: 'Dibujante Planta', etapa: 'Dibujo' },
      tokens.dibujante
    );
    expect(drawingUpdate.status).toBe(200);

    // 8b. Transición directa Dibujo -> Fabricación por SDK cliente -> RECHAZADA (403) para todos los roles
    for (const roleKey of ['manager', 'jefe', 'recepcion', 'dibujante', 'operario']) {
      const bypassStage = await clientPatchDoc(
        `fabricacion${DB_SUFFIX}`,
        ordInDibujoId,
        { etapa: 'Fabricación', status: 'en_proceso' },
        tokens[roleKey]
      );
      expect(bypassStage.status).toBe(403);
    }

    // 8c. Intento de mutar prospecto_id, origen_tipo o estado_habilitacion_fabricacion por SDK cliente -> RECHAZADO (403)
    const mutateProtectedField = await clientPatchDoc(
      `fabricacion${DB_SUFFIX}`,
      ordInDibujoId,
      { origen_tipo: 'interno' },
      tokens.manager
    );
    expect(mutateProtectedField.status).toBe(403);

    // 8d. Creación directa de tarea en fabricacion_tasks_prod por SDK cliente -> RECHAZADA (403)
    for (const roleKey of ['manager', 'jefe', 'dibujante', 'operario']) {
      const directTask = await clientCreateDoc(
        `fabricacion_tasks${DB_SUFFIX}`,
        `FAKE_TASK_${roleKey}_${TAG}`,
        {
          id: `FAKE_TASK_${roleKey}_${TAG}`,
          fabricacion_id: ordInDibujoId,
          area: 'Plasma',
          status: 'pendiente'
        },
        tokens[roleKey]
      );
      expect(directTask.status).toBe(403);
    }
  });

  test('Casos 9 y 10: Autorización completa cuando el anticipo está 100% confirmado y prevención de órdenes/liberaciones duplicadas (ORDEN_YA_LIBERADA)', async () => {
    // 9a. Enviar oportunidad OPP_PRES (anticipo 50/50 de US$9,161.19 100% confirmado) a fabricación
    const sendRes = await H.callFunction(
      'sendProspectToFabricationAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        opId: `OP_SEND_${TAG}`
      },
      tokens.jefe
    );
    expect(sendRes.error).toBeUndefined();
    expect(sendRes.result.status).toBe('sent');
    const fabProjectId = sendRes.result.projectId;
    expect(fabProjectId).toBe(`FAB-PROJ-${OPP_PRES}`);

    const projDoc = await H.getDoc(`proyectos_fabricacion${DB_SUFFIX}`, fabProjectId);
    expect(projDoc).not.toBeNull();
    expect(projDoc.data.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
    expect(projDoc.data.monto_anticipo_exigible).toBe(9161.19);
    expect(projDoc.data.monto_anticipo_confirmado).toBe(9161.19);
    expect(projDoc.data.saldo_pendiente_anticipo).toBe(0);

    // 9b. Crear orden hija en etapa Dibujo mediante validateAndAuthorizeFabricationOrderAdmin
    const childOrderId = `FAB_ORD_REAL_${TAG}`;
    const createOrderOpId = `OP_CREATE_ORD_${TAG}`;
    const createOrdRes = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: childOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        opId: createOrderOpId,
        orderPayload: {
          id: childOrderId,
          padre_id: fabProjectId,
          codigo_orden: '202605023-01',
          proyecto: 'PRESURIZACION DE ESCALERAS PROYECTO DESIRE - NIVEL 1',
          etapa: 'Dibujo',
          status: 'pendiente',
          partidas: [{ descripcion: 'Ducto TDC', cantidad: 8 }]
        }
      },
      tokens.jefe
    );
    expect(createOrdRes.error).toBeUndefined();
    expect(createOrdRes.result.status).toBe('authorized');

    const createdOrdDoc = await H.getDoc(`fabricacion${DB_SUFFIX}`, childOrderId);
    expect(createdOrdDoc).not.toBeNull();
    expect(createdOrdDoc.data.etapa).toBe('Dibujo');
    expect(createdOrdDoc.data.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
    expect(createdOrdDoc.data.autorizado_backend).toBe(true);
    expect(createdOrdDoc.data.liberado_a_fabricacion_backend).toBe(false);

    // 10a. Repetir la creación de la misma orden hija -> rechazado con ORDEN_YA_LIBERADA
    const dupCreateOrd = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: childOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        opId: createOrderOpId,
        orderPayload: {
          id: childOrderId,
          padre_id: fabProjectId,
          etapa: 'Dibujo'
        }
      },
      tokens.jefe
    );
    expect(dupCreateOrd.error).toBeDefined();
    expect(dupCreateOrd.error.status).toBe('FAILED_PRECONDITION');
    expect(dupCreateOrd.error.message).toMatch(/ORDEN_YA_LIBERADA/);

    // 9c. Liberar orden de Dibujo -> Fabricación y generar tareas productivas en backend
    const task1Id = `TASK_1_${TAG}`;
    const task2Id = `TASK_2_${TAG}`;
    const releaseRes = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: childOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        opId: `OP_REL_${TAG}`,
        orderUpdate: {
          etapa: 'Fabricación',
          status: 'en_proceso',
          dibujo_completado_en: '2026-11-10T12:00:00.000Z'
        },
        tasks: [
          { id: task1Id, fabricacion_id: childOrderId, area: 'Plasma', status: 'pendiente', piezas: 8 },
          { id: task2Id, fabricacion_id: childOrderId, area: 'Armado', status: 'bloqueado', piezas: 8 }
        ]
      },
      tokens.jefe
    );
    expect(releaseRes.error).toBeUndefined();
    expect(releaseRes.result.status).toBe('authorized');
    expect(releaseRes.result.writtenTasksCount).toBe(2);

    const releasedOrdDoc = await H.getDoc(`fabricacion${DB_SUFFIX}`, childOrderId);
    expect(releasedOrdDoc.data.etapa).toBe('Fabricación');
    expect(releasedOrdDoc.data.liberado_a_fabricacion_backend).toBe(true);

    const t1Doc = await H.getDoc(`fabricacion_tasks${DB_SUFFIX}`, task1Id);
    const t2Doc = await H.getDoc(`fabricacion_tasks${DB_SUFFIX}`, task2Id);
    expect(t1Doc).not.toBeNull();
    expect(t2Doc).not.toBeNull();
    expect(t1Doc.data.creada_en_backend).toBe(true);

    // 9d. Verificar que los operarios de planta pueden actualizar el progreso de las tareas ya creadas por el backend
    const opTaskUpdate = await clientPatchDoc(
      `fabricacion_tasks${DB_SUFFIX}`,
      task1Id,
      { status: 'en_proceso', piezas_completadas: 4 },
      tokens.operario
    );
    expect(opTaskUpdate.status).toBe(200);

    // 10b. Repetir la liberación Dibujo -> Fabricación sobre la misma orden -> rechazado con ORDEN_YA_LIBERADA
    const dupRelease = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: childOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        opId: `OP_REL_DUP_${TAG}`,
        orderUpdate: { etapa: 'Fabricación', status: 'en_proceso' },
        tasks: [
          { id: `TASK_DUP_${TAG}`, fabricacion_id: childOrderId, area: 'Plasma', status: 'pendiente' }
        ]
      },
      tokens.jefe
    );
    expect(dupRelease.error).toBeDefined();
    expect(dupRelease.error.status).toBe('FAILED_PRECONDITION');
    expect(dupRelease.error.message).toMatch(/ORDEN_YA_LIBERADA/);
    expect(await H.getDoc(`fabricacion_tasks${DB_SUFFIX}`, `TASK_DUP_${TAG}`)).toBeNull();
  });

  test('Caso 11: Modificación/eliminación de pago posterior a la liberación registra discrepancia sin cancelar órdenes en ejecución y bloquea nuevos avances hasta subsanar, manteniendo operativas las órdenes internas legítimas', async () => {
    const fabProjectId = `FAB-PROJ-${OPP_PRES}`;
    const executingOrderId = `FAB_ORD_REAL_${TAG}`;
    const secondDibujoOrderId = `FAB_ORD_DIBUJO_2_${TAG}`;

    // 1. Crear una segunda orden hija en etapa Dibujo antes de modificar el pago
    const createSecondOrd = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: secondDibujoOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        opId: `OP_CREATE_ORD2_${TAG}`,
        orderPayload: {
          id: secondDibujoOrderId,
          padre_id: fabProjectId,
          codigo_orden: '202605023-02',
          proyecto: 'PRESURIZACION DE ESCALERAS PROYECTO DESIRE - NIVEL 2',
          etapa: 'Dibujo',
          status: 'pendiente'
        }
      },
      tokens.jefe
    );
    expect(createSecondOrd.error).toBeUndefined();

    // 2. Reducir el pago confirmado de OPP_PRES después de la liberación (de US$9,161.19 a US$5,000.00 -> saldo pendiente US$4,161.19)
    const editPayRes = await H.callFunction(
      'savePaymentAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        invoiceId: INV_PRES,
        paymentKey: PAY_PRES,
        monto: 5000,
        metodo: 'transferencia',
        ref: '868355650'
      },
      tokens.gestor
    );
    expect(editPayRes.error).toBeUndefined();
    expect(editPayRes.result.status).toBe('updated');

    // 3. Verificar que la orden que ya estaba en Fabricación NO se cancela y permite actualizaciones operativas de planta
    const execOrdAfter = await H.getDoc(`fabricacion${DB_SUFFIX}`, executingOrderId);
    expect(execOrdAfter.data.etapa).toBe('Fabricación');
    expect(execOrdAfter.data.cancelada_por_discrepancia).toBe(false);
    expect(execOrdAfter.data.discrepancia_financiera).toBe(true);
    expect(execOrdAfter.data.bloqueado_avance_etapa).toBe(false);

    const plantProgressOnExecutingOrder = await clientPatchDoc(
      `fabricacion${DB_SUFFIX}`,
      executingOrderId,
      { laminas_manuales: 3, etapa: 'Quality Control' },
      tokens.operario
    );
    expect(plantProgressOnExecutingOrder.status).toBe(200);

    // 4. Verificar que la orden en Dibujo quedó bloqueada (tanto en Firestore Rules como en Cloud Functions) y no se permiten nuevas órdenes
    const dibujoOrdAfter = await H.getDoc(`fabricacion${DB_SUFFIX}`, secondDibujoOrderId);
    expect(dibujoOrdAfter.data.discrepancia_financiera).toBe(true);
    expect(dibujoOrdAfter.data.bloqueado_avance_etapa).toBe(true);

    const blockedClientPatch = await clientPatchDoc(
      `fabricacion${DB_SUFFIX}`,
      secondDibujoOrderId,
      { dibujante_asignado: 'Intento Con Discrepancia' },
      tokens.dibujante
    );
    expect(blockedClientPatch.status).toBe(403);

    const blockedReleaseCall = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: secondDibujoOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        orderUpdate: { etapa: 'Fabricación', status: 'en_proceso' },
        tasks: [{ id: `TASK_BLOCKED_${TAG}`, fabricacion_id: secondDibujoOrderId, area: 'Plasma', status: 'pendiente' }]
      },
      tokens.jefe
    );
    expect(blockedReleaseCall.error).toBeDefined();
    expect(blockedReleaseCall.error.status).toBe('FAILED_PRECONDITION');
    expect(blockedReleaseCall.error.message).toBe(
      'No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$4,161.19.'
    );

    // 5. Restablecer el pago a US$9,161.19 subsana la discrepancia y permite liberar la segunda orden
    const restorePayRes = await H.callFunction(
      'savePaymentAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        invoiceId: INV_PRES,
        paymentKey: PAY_PRES,
        monto: 9161.19,
        metodo: 'transferencia',
        ref: '868355650'
      },
      tokens.gestor
    );
    expect(restorePayRes.error).toBeUndefined();

    const unblockedReleaseCall = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        prospectId: OPP_PRES,
        fabProjectId,
        fabOrderId: secondDibujoOrderId,
        codigoProyecto: '202605023',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        orderUpdate: { etapa: 'Fabricación', status: 'en_proceso' },
        tasks: [{ id: `TASK_UNBLOCKED_${TAG}`, fabricacion_id: secondDibujoOrderId, area: 'Plasma', status: 'pendiente' }]
      },
      tokens.jefe
    );
    expect(unblockedReleaseCall.error).toBeUndefined();
    expect(unblockedReleaseCall.result.status).toBe('authorized');

    // 6. Confirmar que las órdenes internas legítimas (no comerciales) siguen funcionando normalmente
    const internalOrdId = `INT_ORD_LEGIT_${TAG}`;
    const internalCreateRes = await H.callFunction(
      'validateAndAuthorizeFabricationOrderAdmin',
      {
        dbSuffix: DB_SUFFIX,
        fabOrderId: internalOrdId,
        codigoProyecto: `MANT-INT-${TAG}`,
        nombreProyecto: 'MANTENIMIENTO INTERNO DE TALLER',
        origenTipo: 'interno',
        stageTransition: 'crear_orden_unica_manual',
        orderPayload: {
          id: internalOrdId,
          codigo_orden: `MANT-INT-${TAG}_01`,
          codigo_proyecto: `MANT-INT-${TAG}`,
          proyecto: 'MANTENIMIENTO INTERNO DE TALLER',
          origen_tipo: 'interno',
          etapa: 'Dibujo',
          status: 'pendiente'
        }
      },
      tokens.jefe
    );
    expect(internalCreateRes.error).toBeUndefined();
    expect(internalCreateRes.result.status).toBe('authorized_internal');
    expect(internalCreateRes.result.estadoHabilitacion).toBe('ORDEN_INTERNA_NO_COMERCIAL');
  });
});
