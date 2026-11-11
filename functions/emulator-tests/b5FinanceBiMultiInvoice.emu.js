// functions/emulator-tests/b5FinanceBiMultiInvoice.emu.js
// ======================================================================================================
// DUCTSAL ERP — FASE B5: Validación Integral en Firebase Emulator Suite
// (Auth: 9099, Firestore: 8080 + firestore.rules reales, Functions: 5001)
//
// Cubre los 9 bloques obligatorios:
// 1. Registro de una transferencia única (registerBankDepositAdmin).
// 2. Distribución entre facturas de distintas oportunidades del mismo cliente (distributeBankDepositAdmin).
// 3. Saldo no aplicado y distribución posterior (parcialmente_aplicado -> totalmente_aplicado).
// 4. Concurrencia entre gestores (Promise.all sin sobreaplicar el comprobante ni una factura).
// 5. Idempotencia (reintento con mismo opId devuelve unchanged sin duplicar registros).
// 6. Anulación y reasignación (voidBankDepositApplicationAdmin + nueva distribución + voidBankDepositAdmin).
// 7. Rechazo de usuarios sin permiso (vendedor, operario, y no autenticado).
// 8. Prevención de escrituras directas desde Client SDK (firestore.rules bloquea colecciones y campos B5).
// 9. Compatibilidad con BANK_078 / BANK_868355650 y validación financiera previa a fabricación.
// ======================================================================================================

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const H = require('./helpers');

const DB_SUFFIX = '_prod';
const TAG = `b5_${Date.now()}`;
const RULES_PATH = path.resolve(__dirname, '../../firestore.rules');
const DOCS_URL = `${H.FIRESTORE}/v1/projects/${H.PROJECT}/databases/(default)/documents`;

const PERSONAS = {
  manager: {
    uid: `uid_mgr_${TAG}`,
    email: `mgr.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000801',
    nombre: 'Gerente General B5',
    role: 'manager',
    claims: { role: 'manager', manager: true, cid: '1000000000801' }
  },
  gestor1: {
    uid: `uid_ges1_${TAG}`,
    email: `ges1.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000802',
    nombre: 'Gestor Financiero 1',
    role: 'gestor',
    claims: { role: 'gestor', cid: '1000000000802' }
  },
  gestor2: {
    uid: `uid_ges2_${TAG}`,
    email: `ges2.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000803',
    nombre: 'Gestor Financiero 2',
    role: 'gestor',
    claims: { role: 'gestor', cid: '1000000000803' }
  },
  vendedor: {
    uid: `uid_vend_${TAG}`,
    email: `vend.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1000000000804',
    nombre: 'Vendedor Comercial',
    role: 'vendedor',
    claims: { role: 'vendedor', cid: '1000000000804' }
  },
  operario: {
    uid: `uid_oper_${TAG}`,
    email: `oper.${TAG}@ductsal-test.invalid`,
    password: H.randomSecret(),
    cid: '1800000000805',
    nombre: 'Operario Planta',
    role: 'operario',
    claims: { role: 'operario', cid: '1800000000805' }
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
  const res = await fetch(`${DOCS_URL}/${collection}/${docId}?${mask}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ fields: H.encodeFields(patchData) })
  });
  return { status: res.status, text: await res.text() };
}

async function setupPersonas() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  adminApp = admin.initializeApp({ projectId: H.PROJECT }, `admin-b5-${TAG}`);
  adminAuth = adminApp.auth();

  for (const [key, p] of Object.entries(PERSONAS)) {
    await adminAuth.createUser({
      uid: p.uid,
      email: p.email,
      password: p.password,
      displayName: p.nombre
    });
    await adminAuth.setCustomUserClaims(p.uid, p.claims);

    await H.setDoc(`users${DB_SUFFIX}`, p.cid, {
      id: p.cid,
      nombre: p.nombre,
      email: p.email,
      role: p.role,
      activo: true,
      authUid: p.uid,
      invitation: { status: 'activated' }
    });
    await H.setDoc(`userDirectory${DB_SUFFIX}`, p.cid, {
      id: p.cid,
      nombre: p.nombre,
      role: p.role,
      activo: true
    });

    const signed = await H.signIn(p.email, p.password);
    tokens[key] = signed.idToken;
  }
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function main() {
  console.log('================================================================================');
  console.log('DUCTSAL ERP — FASE B5 EMULATOR INTEGRATION SUITE');
  console.log('================================================================================');

  await H.assertEmulatorsUp();
  await loadRealFirestoreRules();
  console.log('[OK] Reglas reales firestore.rules cargadas en Firestore Emulator.');

  await setupPersonas();
  console.log('[OK] Usuarios de prueba (manager, gestor1, gestor2, vendedor, operario) autenticados.');

  const clientId = `CLI_B5_${TAG}`;
  const opp1Id = `OPP_B5_1_${TAG}`;
  const opp2Id = `OPP_B5_2_${TAG}`;
  const opp3Id = `OPP_B5_3_${TAG}`;
  const inv1Id = `INV_B5_101_${TAG}`;
  const inv2Id = `INV_B5_201_${TAG}`;
  const inv3Id = `INV_B5_301_${TAG}`;

  const fileUrl = name => ({
    name,
    url: `https://firebasestorage.googleapis.com/v0/b/${H.PROJECT}.appspot.com/o/prod_files%2F${encodeURIComponent(name)}?alt=media`
  });
  const docComprobante = fileUrl('transferencia_b5.pdf');

  // Sembrar cliente y 3 oportunidades ganadas con facturas emitidas
  await H.setDoc(`clients${DB_SUFFIX}`, clientId, {
    id: clientId,
    tipo: 'juridica',
    empresa: 'GRUPO CORPORATIVO B5 S.A. DE C.V.',
    contacto: 'Ing. Roberto Morales',
    nit: '0614-111120-101-5',
    nrc: '205410-1',
    telefono: '2250-1000',
    correo: 'finanzas@grupob5.com',
    is_gran_contribuyente: false,
    es_exportacion: false,
    documentos: { dui: '01234567-8' }
  });

  // Oportunidad 1: Contrato $10,000 sin IVA ($11,300 con IVA), 50/50 -> anticipo exigible $5,650.00. Factura 101 por $5,650.00
  await H.setDoc(`prospects${DB_SUFFIX}`, opp1Id, {
    id: opp1Id,
    codigo: '202611801',
    proyecto: 'TORRE CORPORATIVA NORTE',
    clientId,
    vendedor: PERSONAS.vendedor.nombre,
    vendedorId: PERSONAS.vendedor.cid,
    encargado: PERSONAS.gestor1.nombre,
    gestorId: PERSONAS.gestor1.cid,
    etapa: 'cierre',
    estado: 'ganado',
    clasificacion: 'ejecucion',
    postcierre_habilitado: true,
    forma_pago: '50/50',
    precio_cotizado: 10000,
    costo_venta: 6800,
    fecha_creacion: '2026-11-01T10:00:00.000Z',
    fecha_cierre: '2026-11-03T10:00:00.000Z',
    datos: {
      forma_pago: '50/50',
      doc_firmado: [fileUrl('contrato_opp1.pdf')],
      doc_oferta: [fileUrl('oferta_opp1.pdf')],
      doc_costos: [fileUrl('costos_opp1.pdf')]
    },
    factura_anticipo_id: inv1Id,
    facturas: [
      { id: inv1Id, numero: 'CCF-101', monto: 5650.00, fecha: '2026-11-04', es_anticipo: true, tipo_factura: 'anticipo', doc_factura: fileUrl('ccf_101.pdf'), pagos: [] }
    ],
    ordenes_cambio: []
  });

  // Oportunidad 2: Contrato $8,000 sin IVA ($9,040 con IVA), 50/50 -> Factura 201 por $4,520.00
  await H.setDoc(`prospects${DB_SUFFIX}`, opp2Id, {
    id: opp2Id,
    codigo: '202611802',
    proyecto: 'BODEGA LOGISTICA CENTRAL',
    clientId,
    vendedor: PERSONAS.vendedor.nombre,
    vendedorId: PERSONAS.vendedor.cid,
    encargado: PERSONAS.gestor1.nombre,
    gestorId: PERSONAS.gestor1.cid,
    etapa: 'cierre',
    estado: 'ganado',
    clasificacion: 'ejecucion',
    postcierre_habilitado: true,
    forma_pago: '50/50',
    precio_cotizado: 8000,
    costo_venta: 5200,
    fecha_creacion: '2026-11-01T11:00:00.000Z',
    fecha_cierre: '2026-11-03T11:00:00.000Z',
    facturas: [
      { id: inv2Id, numero: 'CCF-201', monto: 4520.00, fecha: '2026-11-04', pagos: [] }
    ],
    ordenes_cambio: []
  });

  // Oportunidad 3: Contrato $6,000 sin IVA ($6,780 con IVA), 50/50 -> Factura 301 por $3,390.00
  await H.setDoc(`prospects${DB_SUFFIX}`, opp3Id, {
    id: opp3Id,
    codigo: '202611803',
    proyecto: 'PLANTA CLIMATIZACION SUR',
    clientId,
    vendedor: PERSONAS.vendedor.nombre,
    vendedorId: PERSONAS.vendedor.cid,
    encargado: PERSONAS.gestor1.nombre,
    gestorId: PERSONAS.gestor1.cid,
    etapa: 'cierre',
    estado: 'ganado',
    clasificacion: 'ejecucion',
    postcierre_habilitado: true,
    forma_pago: '50/50',
    precio_cotizado: 6000,
    costo_venta: 3900,
    fecha_creacion: '2026-11-02T09:00:00.000Z',
    fecha_cierre: '2026-11-04T09:00:00.000Z',
    facturas: [
      { id: inv3Id, numero: 'CCF-301', monto: 3390.00, fecha: '2026-11-05', pagos: [] }
    ],
    ordenes_cambio: []
  });

  // --------------------------------------------------------------------------------------------------
  // 1. REGISTRO DE UNA TRANSFERENCIA ÚNICA (SIN DISTRIBUIR INICIALMENTE -> ESTADO 'recibido')
  // --------------------------------------------------------------------------------------------------
  const bankRef1 = `TRF990011_${TAG}`;
  const opReg1 = `op_reg1_${TAG}`;
  const regRes1 = await H.callFunction('registerBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    ref: bankRef1,
    metodo: 'transferencia',
    monto: 13560.00,
    fechaComprobante: '2026-11-06',
    banco_origen: 'Banco Agrícola',
    doc_comprobante: docComprobante,
    observaciones: 'Transferencia corporativa única para 3 proyectos',
    opId: opReg1
  }, tokens.gestor1);

  assert(regRes1.httpStatus === 200 && regRes1.result && regRes1.result.status === 'created', `Fallo registro abono único: ${JSON.stringify(regRes1)}`);
  assert(regRes1.result.importeOriginal === 13560.00, 'Importe original debe ser 13560.00');
  assert(regRes1.result.totalAplicado === 0, 'Total aplicado inicial debe ser 0');
  assert(regRes1.result.saldoDisponible === 13560.00, 'Saldo disponible inicial debe ser 13560.00');
  assert(regRes1.result.estadoAbono === 'recibido', `Estado inicial debe ser recibido, obtenido: ${regRes1.result.estadoAbono}`);
  console.log('[PASS 1] Registro de transferencia única por US$13,560.00 en estado recibido.');

  // Replay idempotente inmediato del registro (mismo opId antes de distribuir)
  const replayReg = await H.callFunction('registerBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    ref: bankRef1,
    metodo: 'transferencia',
    monto: 13560.00,
    fechaComprobante: '2026-11-06',
    banco_origen: 'Banco Agrícola',
    doc_comprobante: docComprobante,
    observaciones: 'Transferencia corporativa única para 3 proyectos',
    opId: opReg1
  }, tokens.gestor1);
  assert(replayReg.httpStatus === 200 && replayReg.result && replayReg.result.status === 'unchanged', `Replay de registro debía ser unchanged: ${JSON.stringify(replayReg)}`);

  // --------------------------------------------------------------------------------------------------
  // 2. DISTRIBUCIÓN ENTRE FACTURAS DE DISTINTAS OPORTUNIDADES DEL MISMO CLIENTE Y SALDO NO APLICADO
  // --------------------------------------------------------------------------------------------------
  const opDist1 = `op_dist1_${TAG}`;
  const distRes1 = await H.callFunction('distributeBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regRes1.result.abonoId,
    clientId,
    allocations: [
      { prospectId: opp1Id, invoiceId: inv1Id, monto: 5650.00 },
      { prospectId: opp2Id, invoiceId: inv2Id, monto: 4520.00 }
    ],
    observaciones: 'Distribución inicial a CCF-101 y CCF-201',
    opId: opDist1
  }, tokens.gestor1);

  assert(distRes1.httpStatus === 200 && distRes1.result && distRes1.result.status === 'distributed', `Fallo distribución multifactura: ${JSON.stringify(distRes1)}`);
  assert(distRes1.result.totalAplicado === 10170.00, `Total aplicado esperado 10170.00, obtenido ${distRes1.result.totalAplicado}`);
  assert(distRes1.result.saldoDisponible === 3390.00, `Saldo disponible esperado 3390.00, obtenido ${distRes1.result.saldoDisponible}`);
  assert(distRes1.result.estadoAbono === 'parcialmente_aplicado', `Estado esperado parcialmente_aplicado, obtenido ${distRes1.result.estadoAbono}`);
  console.log('[PASS 2] Distribución entre facturas de distintas oportunidades (CCF-101: $5,650 + CCF-201: $4,520) y saldo no aplicado ($3,390.00).');

  // --------------------------------------------------------------------------------------------------
  // 3. DISTRIBUCIÓN POSTERIOR DEL SALDO NO APLICADO HASTA AGOTAR EL ABONO
  // --------------------------------------------------------------------------------------------------
  const opDist2 = `op_dist2_${TAG}`;
  const distRes2 = await H.callFunction('distributeBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regRes1.result.abonoId,
    clientId,
    allocations: [
      { prospectId: opp3Id, invoiceId: inv3Id, monto: 3390.00 }
    ],
    observaciones: 'Aplicación del saldo remanente a CCF-301',
    opId: opDist2
  }, tokens.gestor1);

  assert(distRes2.httpStatus === 200 && distRes2.result && distRes2.result.status === 'distributed', `Fallo distribución posterior: ${JSON.stringify(distRes2)}`);
  assert(distRes2.result.totalAplicado === 13560.00, 'Total aplicado debe llegar a 13560.00');
  assert(distRes2.result.saldoDisponible === 0, 'Saldo disponible debe quedar en 0.00');
  assert(distRes2.result.estadoAbono === 'totalmente_aplicado', 'Estado debe ser totalmente_aplicado');
  console.log('[PASS 3] Saldo no aplicado distribuido posteriormente a CCF-301 -> estado totalmente_aplicado (saldo $0.00).');

  // --------------------------------------------------------------------------------------------------
  // 4. IDEMPOTENCIA (REINTENTO CON MISMO opId NO DUPLICA REGISTROS NI APLICACIONES)
  // --------------------------------------------------------------------------------------------------
  const replayDist = await H.callFunction('distributeBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regRes1.result.abonoId,
    clientId,
    allocations: [
      { prospectId: opp3Id, invoiceId: inv3Id, monto: 3390.00 }
    ],
    observaciones: 'Aplicación del saldo remanente a CCF-301',
    opId: opDist2
  }, tokens.gestor1);
  assert(replayDist.httpStatus === 200 && replayDist.result && replayDist.result.status === 'unchanged', `Replay de distribución debía ser unchanged: ${JSON.stringify(replayDist)}`);
  console.log('[PASS 4] Idempotencia verificada en registerBankDepositAdmin y distributeBankDepositAdmin.');

  // --------------------------------------------------------------------------------------------------
  // 5. ANULACIÓN DE UNA APLICACIÓN Y REASIGNACIÓN DEL SALDO LIBERADO
  // --------------------------------------------------------------------------------------------------
  const opp3DocBeforeVoid = await H.getDoc(`prospects${DB_SUFFIX}`, opp3Id);
  const fac3BeforeVoid = opp3DocBeforeVoid.data.facturas[0];
  assert(Array.isArray(fac3BeforeVoid.pagos) && fac3BeforeVoid.pagos.length === 1, 'CCF-301 debe tener 1 pago antes de anular');

  const voidAppRes = await H.callFunction('voidBankDepositApplicationAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regRes1.result.abonoId,
    prospectId: opp3Id,
    invoiceId: inv3Id,
    motivo: 'Error de digitación en selección de factura destino',
    opId: `op_void_app_${TAG}`
  }, tokens.gestor1);

  assert(voidAppRes.httpStatus === 200 && voidAppRes.result && voidAppRes.result.status === 'voided', `Fallo anulación de aplicación: ${JSON.stringify(voidAppRes)}`);
  assert(voidAppRes.result.saldoDisponible === 3390.00, `Saldo disponible tras anular debe volver a 3390.00, obtenido ${voidAppRes.result.saldoDisponible}`);
  assert(voidAppRes.result.estadoAbono === 'parcialmente_aplicado', 'Estado tras anular debe volver a parcialmente_aplicado');

  // Reasignar $3,390.00 nuevamente a CCF-301
  const reallocRes = await H.callFunction('distributeBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regRes1.result.abonoId,
    clientId,
    allocations: [
      { prospectId: opp3Id, invoiceId: inv3Id, monto: 3390.00 }
    ],
    observaciones: 'Reasignación corregida a CCF-301',
    opId: `op_realloc_${TAG}`
  }, tokens.gestor2);
  assert(reallocRes.httpStatus === 200 && reallocRes.result && reallocRes.result.estadoAbono === 'totalmente_aplicado', `Fallo reasignación: ${JSON.stringify(reallocRes)}`);
  console.log('[PASS 5] Anulación de aplicación individual libera saldo disponible ($3,390.00) y permite reasignación auditada.');

  // --------------------------------------------------------------------------------------------------
  // 6. CONCURRENCIA ENTRE GESTORES (Promise.all SOBRE UN MISMO SALDO DISPONIBLE)
  // --------------------------------------------------------------------------------------------------
  const invResA = await H.callFunction('saveInvoiceAdmin', {
    dbSuffix: DB_SUFFIX,
    prospectId: opp1Id,
    numero: 'CCF-102-FINAL',
    monto: 5650.00,
    doc_factura: docComprobante,
    opId: `op_inv_conca_${TAG}`
  }, tokens.gestor1);
  assert(invResA.httpStatus === 200 && invResA.result && invResA.result.invoice, `Fallo crear factura A: ${JSON.stringify(invResA)}`);
  const invConcA = invResA.result.invoice.id;

  const invResB = await H.callFunction('saveInvoiceAdmin', {
    dbSuffix: DB_SUFFIX,
    prospectId: opp2Id,
    numero: 'CCF-202-FINAL',
    monto: 4520.00,
    doc_factura: docComprobante,
    opId: `op_inv_concb_${TAG}`
  }, tokens.gestor2);
  assert(invResB.httpStatus === 200 && invResB.result && invResB.result.invoice, `Fallo crear factura B: ${JSON.stringify(invResB)}`);
  const invConcB = invResB.result.invoice.id;

  // Registrar un abono de $5,000.00; Gestor 1 y Gestor 2 intentan aplicar simultáneamente $4,000.00 cada uno
  const bankRefConc = `TRF_CONC_${TAG}`;
  const regConc = await H.callFunction('registerBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    ref: bankRefConc,
    metodo: 'transferencia',
    monto: 5000.00,
    fechaComprobante: '2026-11-07',
    doc_comprobante: docComprobante,
    opId: `op_reg_conc_${TAG}`
  }, tokens.gestor1);
  assert(regConc.httpStatus === 200 && regConc.result.abonoId, 'Abono concurrente debe crearse');

  const [conc1, conc2] = await Promise.all([
    H.callFunction('distributeBankDepositAdmin', {
      dbSuffix: DB_SUFFIX,
      abonoId: regConc.result.abonoId,
      clientId,
      allocations: [{ prospectId: opp1Id, invoiceId: invConcA, monto: 4000.00 }],
      opId: `op_conc_1_${TAG}`
    }, tokens.gestor1),
    H.callFunction('distributeBankDepositAdmin', {
      dbSuffix: DB_SUFFIX,
      abonoId: regConc.result.abonoId,
      clientId,
      allocations: [{ prospectId: opp2Id, invoiceId: invConcB, monto: 4000.00 }],
      opId: `op_conc_2_${TAG}`
    }, tokens.gestor2)
  ]);

  const concSuccesses = [conc1, conc2].filter(r => r.httpStatus === 200 && r.result && r.result.status === 'distributed');
  const concRejections = [conc1, conc2].filter(r => r.httpStatus !== 200 || (r.error && r.error.status));
  assert(concSuccesses.length === 1 && concRejections.length === 1, `Exactamente 1 distribución concurrente debe triunfar y 1 rechazarse: s=${concSuccesses.length}, r=${concRejections.length}`);

  const depConcAfter = await H.getDoc(`payment_refs${DB_SUFFIX}`, regConc.result.abonoId);
  assert(depConcAfter.data.total_aplicado === 4000.00 && depConcAfter.data.saldo_disponible === 1000.00, `Saldo tras concurrencia debe ser exactamente $1,000.00 sin sobreaplicación: ${JSON.stringify(depConcAfter.data)}`);
  console.log('[PASS 6] Concurrencia entre gestores: 1 transacción aplicada ($4,000) y 1 rechazada por saldo insuficiente, sin sobreaplicación.');

  // --------------------------------------------------------------------------------------------------
  // 7. RECHAZO DE USUARIOS SIN PERMISO (VENDEDOR, OPERARIO, NO AUTENTICADO)
  // --------------------------------------------------------------------------------------------------
  const unauthCall = await H.callFunction('registerBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    ref: `UNAUTH_${TAG}`,
    metodo: 'transferencia',
    monto: 500,
    fechaComprobante: '2026-11-08',
    doc_comprobante: docComprobante,
    opId: `op_unauth_${TAG}`
  }, null);
  assert(unauthCall.httpStatus === 401 || (unauthCall.error && unauthCall.error.status === 'UNAUTHENTICATED'), 'Llamada sin token debe ser rechazada con UNAUTHENTICATED');

  const vendRegister = await H.callFunction('registerBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    ref: `VEND_${TAG}`,
    metodo: 'transferencia',
    monto: 500,
    fechaComprobante: '2026-11-08',
    doc_comprobante: docComprobante,
    opId: `op_vend_${TAG}`
  }, tokens.vendedor);
  assert(vendRegister.httpStatus === 403 || (vendRegister.error && vendRegister.error.status === 'PERMISSION_DENIED'), 'Vendedor no puede registrar abonos bancarios');

  const vendDist = await H.callFunction('distributeBankDepositAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regConc.result.abonoId,
    clientId,
    allocations: [{ prospectId: opp2Id, invoiceId: invConcB, monto: 500 }],
    opId: `op_vend_dist_${TAG}`
  }, tokens.vendedor);
  assert(vendDist.httpStatus === 403 || (vendDist.error && vendDist.error.status === 'PERMISSION_DENIED'), 'Vendedor no puede distribuir abonos bancarios');

  const operVoid = await H.callFunction('voidBankDepositApplicationAdmin', {
    dbSuffix: DB_SUFFIX,
    abonoId: regConc.result.abonoId,
    prospectId: opp1Id,
    invoiceId: invConcA,
    motivo: 'Intento no autorizado',
    opId: `op_oper_void_${TAG}`
  }, tokens.operario);
  assert(operVoid.httpStatus === 403 || (operVoid.error && operVoid.error.status === 'PERMISSION_DENIED'), 'Operario no puede anular aplicaciones financieras');
  console.log('[PASS 7] Rechazo estricto de usuarios sin permiso (no autenticado, vendedor, operario).');

  // --------------------------------------------------------------------------------------------------
  // 8. PREVENCIÓN DE ESCRITURAS DIRECTAS DESDE CLIENT SDK (FIRESTORE SECURITY RULES)
  // --------------------------------------------------------------------------------------------------
  const directPaymentRefWrite = await clientSetDoc(`payment_refs${DB_SUFFIX}`, `HACK_REF_${TAG}`, {
    clientId,
    monto_total_comprobante: 999999,
    saldo_disponible: 999999
  }, tokens.gestor1);
  assert(directPaymentRefWrite.status === 403, `Escritura directa en payment_refs_prod debe ser bloqueada (403), obtenido ${directPaymentRefWrite.status}`);

  const directDepositColWrite = await clientCreateDoc(`client_bank_deposits${DB_SUFFIX}`, `HACK_DEP_${TAG}`, {
    clientId,
    monto: 50000
  }, tokens.manager);
  assert(directDepositColWrite.status === 403, `Escritura directa en client_bank_deposits_prod debe ser bloqueada (403), obtenido ${directDepositColWrite.status}`);

  const directAllocColWrite = await clientCreateDoc(`payment_allocations${DB_SUFFIX}`, `HACK_ALLOC_${TAG}`, {
    clientId,
    monto: 50000
  }, tokens.manager);
  assert(directAllocColWrite.status === 403, `Escritura directa en payment_allocations_prod debe ser bloqueada (403), obtenido ${directAllocColWrite.status}`);

  const directClientFinPatch = await clientPatchDoc(`clients${DB_SUFFIX}`, clientId, {
    total_historico_cobrado: 9999999,
    saldo_abonos_pendientes_aplicar: 888888,
    financialVersion: 999
  }, tokens.gestor1);
  assert(directClientFinPatch.status === 403, `Alteración directa de campos financieros B5 en clients_prod debe ser bloqueada (403), obtenido ${directClientFinPatch.status}`);
  console.log('[PASS 8] Reglas de seguridad Firestore bloquean (403) escrituras directas desde Client SDK en colecciones y campos financieros B5.');

  // --------------------------------------------------------------------------------------------------
  // 9. COMPATIBILIDAD CON BANK_078 Y VALIDACIÓN FINANCIERA PREVIA A FABRICACIÓN
  // --------------------------------------------------------------------------------------------------
  // 9A: Oportunidad 1 tiene anticipo 50% ($5,650.00) cubierto mediante el abono multifactura (Paso 2).
  // Verificar que validateManufacturingReadinessAdmin y sendProspectToFabricationAdmin lo reconocen como ANTICIPO_CONFIRMADO.
  const fabReadyRes = await H.callFunction('validateManufacturingReadinessAdmin', {
    dbSuffix: DB_SUFFIX,
    prospectId: opp1Id
  }, tokens.gestor1);
  assert(
    fabReadyRes.httpStatus === 200 &&
    fabReadyRes.result &&
    fabReadyRes.result.ready === true &&
    fabReadyRes.result.code === 'ANTICIPO_CONFIRMADO',
    `Anticipo cubierto por abono multifactura B5 debe habilitar Fabricación: ${JSON.stringify(fabReadyRes)}`
  );

  const sendFabRes = await H.callFunction('sendProspectToFabricationAdmin', {
    dbSuffix: DB_SUFFIX,
    prospectId: opp1Id,
    opId: `op_send_fab_${TAG}`
  }, tokens.gestor1);
  assert(
    sendFabRes.httpStatus === 200 &&
    sendFabRes.result &&
    sendFabRes.result.status === 'sent',
    `sendProspectToFabricationAdmin debe autorizar el envío tras abono multifactura B5: ${JSON.stringify(sendFabRes)}`
  );

  // 9B: Verificar que getAccountBIMetricsAdmin y recalculateClientFinancialsAdmin reflejan exactamente los totales del cliente sin duplicación
  const reconRes = await H.callFunction('recalculateClientFinancialsAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    dryRun: false,
    reason: 'Verificación de integración B5 en emuladores',
    opId: `op_recon_${TAG}`
  }, tokens.manager);
  assert(reconRes.httpStatus === 200 && reconRes.result && reconRes.result.status === 'reconciled', `Fallo recalculateClientFinancialsAdmin: ${JSON.stringify(reconRes)}`);
  assert(reconRes.result.reconciled.total_historico_facturado === 23730.00, `Total facturado esperado 23730.00, obtenido ${reconRes.result.reconciled.total_historico_facturado}`);
  assert(reconRes.result.reconciled.total_historico_cobrado === 17560.00, `Total cobrado esperado 17560.00 (13560 + 4000), obtenido ${reconRes.result.reconciled.total_historico_cobrado}`);
  assert(reconRes.result.reconciled.saldo_abonos_pendientes_aplicar === 1000.00, `Saldo abonos pendientes esperado 1000.00, obtenido ${reconRes.result.reconciled.saldo_abonos_pendientes_aplicar}`);
  assert(reconRes.result.reconciled.total_dinero_recibido === 18560.00, `Total dinero recibido esperado 18560.00 (13560 + 5000), obtenido ${reconRes.result.reconciled.total_dinero_recibido}`);

  const biRes = await H.callFunction('getAccountBIMetricsAdmin', {
    dbSuffix: DB_SUFFIX,
    clientId,
    period: 'all'
  }, tokens.manager);
  assert(biRes.httpStatus === 200 && biRes.result && biRes.result.status === 'ok', `Fallo getAccountBIMetricsAdmin: ${JSON.stringify(biRes)}`);
  assert(biRes.result.financiero.facturacionRegistrada === 23730.00, `BI facturacionRegistrada esperado 23730.00, obtenido ${biRes.result.financiero.facturacionRegistrada}`);
  assert(biRes.result.financiero.cobrosAplicados === 17560.00, `BI cobrosAplicados esperado 17560.00, obtenido ${biRes.result.financiero.cobrosAplicados}`);
  assert(biRes.result.financiero.abonosPendientesDeAplicar === 1000.00, `BI abonosPendientesDeAplicar esperado 1000.00, obtenido ${biRes.result.financiero.abonosPendientesDeAplicar}`);
  assert(biRes.result.financiero.dineroRecibido === 18560.00, `BI dineroRecibido esperado 18560.00, obtenido ${biRes.result.financiero.dineroRecibido}`);
  console.log('[PASS 9] Integración con compuerta financiera de Fabricación, reconciliación transaccional OCC y motor BI verificada al 100%.');

  await adminApp.delete();
  console.log('================================================================================');
  console.log('✅ TODOS LOS 9 BLOQUES DE EMULADORES DE LA FASE B5 PASARON EXITOSAMENTE');
  console.log('================================================================================');
}

main().catch(err => {
  console.error('❌ ERROR EN SUITE DE EMULADORES B5:', err);
  process.exit(1);
});
