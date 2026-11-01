#!/usr/bin/env node
// functions/scripts/seedStagingEnvironment.js
// Idempotent seeding script for DUCTSAL ERP Staging Environment ('ductsal-erp-staging').
//
// STRICT SAFEGUARDS:
// 1. Refuses to run against production ('ductsal-erp'): strictly checked via assertSafeTargetProject.
// 2. Uses exclusively synthetic test accounts, synthetic clients, and synthetic projects.
// 3. Formats opportunities to cover all Phase 4C, 4D, and 4E commercial cycle validation scenarios.

const admin = require('firebase-admin');
const { assertSafeTargetProject } = require('./assertTargetProject');


// =================================================================================================
// 1. SYNTHETIC USERS
// =================================================================================================
const STAGING_USERS = [
  {
    id: '1000000000001',
    nombre: 'Gerente General (Staging)',
    email: 'gerente.staging@ductsal.com',
    role: 'manager',
    activo: true,
    expectedClaims: { role: 'manager', manager: true, cid: '1000000000001' }
  },
  {
    id: '1000000000002',
    nombre: 'Gestor Comercial (Staging)',
    email: 'gestor.staging@ductsal.com',
    role: 'gestor',
    activo: true,
    expectedClaims: { role: 'gestor', cid: '1000000000002' }
  },
  {
    id: '1000000000003',
    nombre: 'Carlos Vendedor (Staging 1)',
    email: 'carlos.vendedor@ductsal.com',
    role: 'vendedor',
    activo: true,
    expectedClaims: { role: 'vendedor', cid: '1000000000003' }
  },
  {
    id: '1000000000004',
    nombre: 'Elena Vendedora (Staging 2)',
    email: 'elena.vendedora@ductsal.com',
    role: 'vendedor',
    activo: true,
    expectedClaims: { role: 'vendedor', cid: '1000000000004' }
  }
];

// =================================================================================================
// 2. SYNTHETIC CLIENTS
// =================================================================================================
const STAGING_CLIENTS = [
  {
    id: 'CLI_STAGING_01',
    tipo: 'juridica',
    empresa: 'Industrias Beta S.A. de C.V. (Staging)',
    contacto: 'Lic. Roberto Valdés',
    cargo: 'Gerente de Operaciones',
    telefono: '2250-8800',
    correo: 'compras@industriasbeta-staging.com',
    correo_fact: 'facturas@industriasbeta-staging.com',
    direccion: 'Zona Industrial Merliot, Antiguo Cuscatlán',
    nit: '0614-010185-102-3',
    nrc: '45678-9',
    giro: 'Manufactura textil',
    createdBy: '1000000000003',
    closingVendors: ['1000000000003'],
    documentos: {
      escritura: { name: 'Escritura_Constitucion_Beta.pdf', storagePath: `prod_files/clients/CLI_STAGING_01/legal/escritura.pdf` },
      credencial: { name: 'Credencial_Representante.pdf', storagePath: `prod_files/clients/CLI_STAGING_01/legal/credencial.pdf` },
      nit: { name: 'NIT_Empresa.pdf', storagePath: `prod_files/clients/CLI_STAGING_01/legal/nit.pdf` },
      nrc: { name: 'NRC_Empresa.pdf', storagePath: `prod_files/clients/CLI_STAGING_01/legal/nrc.pdf` }
    }
  },
  {
    id: 'CLI_STAGING_02',
    tipo: 'natural',
    empresa: 'Ing. Alejandro Martell (Staging)',
    contacto: 'Ing. Alejandro Martell',
    cargo: 'Propietario',
    telefono: '7800-4411',
    correo: 'amartell@proyectos-staging.com',
    correo_fact: 'amartell@proyectos-staging.com',
    direccion: 'Colonia Escalón, San Salvador',
    nit: '0614-250878-101-5',
    nrc: '89101-2',
    giro: 'Consultoría y construcción',
    createdBy: '1000000000004',
    closingVendors: ['1000000000004'],
    documentos: {
      dui: { name: 'DUI_Alejandro_Martell.pdf', storagePath: `prod_files/clients/CLI_STAGING_02/identificacion/dui.pdf` },
      nit: { name: 'NIT_Personal.pdf', storagePath: `prod_files/clients/CLI_STAGING_02/legal/nit.pdf` }
    }
  }
];

// =================================================================================================
// 3. SYNTHETIC PROSPECTS (Covering all stages and testing scenarios)
// =================================================================================================
const STAGING_PROSPECTS = [
  // 1. Prospecto en Levantamiento (para probar retroceso a Prospecto o avance a Cotización)
  {
    id: 'OP_STAGING_001',
    codigo: 'STG-2026-001',
    clientId: 'CLI_STAGING_01',
    empresa: 'Industrias Beta S.A. de C.V. (Staging)',
    contacto: 'Lic. Roberto Valdés',
    createdBy: '1000000000003',
    vendedorId: '1000000000003',
    vendedorName: 'Carlos Vendedor (Staging 1)',
    vendedorRole: 'vendedor',
    estado: 'activo',
    etapa: 'levantamiento',
    tipo_proyecto: 'Nuevo',
    precio_cotizado: 18500,
    costo_venta: 11000,
    datos: {
      nota: 'Visita técnica realizada para medición de ductos en nave principal',
      doc_levantamiento: { name: 'Levantamiento_Beta_Nave.pdf', storagePath: 'prod_files/prospects/OP_STAGING_001/doc_levantamiento/plano.pdf' }
    },
    stage_timestamps: {
      prospecto: '2026-10-01T08:00:00.000Z',
      levantamiento: '2026-10-05T10:00:00.000Z'
    },
    tiempos_etapas_acumulados: { prospecto: 3 },
    stage_transitions: [
      { from: 'prospecto', to: 'levantamiento', tipo: 'avance', duracion_dias: 3, fecha: '2026-10-05T10:00:00.000Z' }
    ]
  },

  // 2. Prospecto en Cotización (para probar ajuste de precio/costo OCC y avance a Negociación)
  {
    id: 'OP_STAGING_002',
    codigo: 'STG-2026-002',
    clientId: 'CLI_STAGING_01',
    empresa: 'Industrias Beta S.A. de C.V. (Staging)',
    contacto: 'Lic. Roberto Valdés',
    createdBy: '1000000000003',
    vendedorId: '1000000000003',
    vendedorName: 'Carlos Vendedor (Staging 1)',
    vendedorRole: 'vendedor',
    estado: 'activo',
    etapa: 'cotizacion',
    tipo_proyecto: 'Modificación',
    precio_cotizado: 32000,
    costo_venta: 19500,
    datos: {
      nota: 'Elaborando presupuesto de suministro y montaje',
      estado_propuesta: 'borrador',
      doc_oferta: { name: 'Oferta_Preliminar_v1.pdf', storagePath: 'prod_files/prospects/OP_STAGING_002/doc_oferta/oferta.pdf' },
      doc_costos: { name: 'Costos_Preliminar_v1.xlsx', storagePath: 'prod_files/prospects/OP_STAGING_002/doc_costos/costos.xlsx' }
    },
    stage_timestamps: {
      prospecto: '2026-10-02T08:00:00.000Z',
      levantamiento: '2026-10-08T09:00:00.000Z',
      cotizacion: '2026-10-15T14:00:00.000Z'
    },
    tiempos_etapas_acumulados: { prospecto: 4, levantamiento: 5 },
    stage_transitions: [
      { from: 'prospecto', to: 'levantamiento', tipo: 'avance', duracion_dias: 4, fecha: '2026-10-08T09:00:00.000Z' },
      { from: 'levantamiento', to: 'cotizacion', tipo: 'avance', duracion_dias: 5, fecha: '2026-10-15T14:00:00.000Z' }
    ]
  },

  // 3. Prospecto en Negociación (para probar sustitución documental, cadencia y retroceso a Cotización con borrador)
  {
    id: 'OP_STAGING_003',
    codigo: 'STG-2026-003',
    clientId: 'CLI_STAGING_02',
    empresa: 'Ing. Alejandro Martell (Staging)',
    contacto: 'Ing. Alejandro Martell',
    createdBy: '1000000000004',
    vendedorId: '1000000000004',
    vendedorName: 'Elena Vendedora (Staging 2)',
    vendedorRole: 'vendedor',
    estado: 'activo',
    etapa: 'negociacion',
    tipo_proyecto: 'Nuevo',
    precio_cotizado: 45000,
    costo_venta: 27000,
    fecha_entrega_oferta: '2026-10-20T11:00:00.000Z',
    datos: {
      nota: 'Oferta enviada por correo. En espera de aprobación técnica del cliente',
      estado_propuesta: 'vigente',
      doc_oferta: { name: 'Oferta_Comercial_Oficial.pdf', storagePath: 'prod_files/prospects/OP_STAGING_003/doc_oferta/oferta_oficial.pdf' },
      doc_costos: { name: 'Costos_Detallados.xlsx', storagePath: 'prod_files/prospects/OP_STAGING_003/doc_costos/costos_det.xlsx' }
    },
    seguimiento: {
      cadencia: '5_dias',
      proxima_accion: 'Llamar al cliente para seguimiento de propuesta técnica',
      fecha_proxima_accion: '2026-10-28T14:00:00.000Z'
    },
    stage_timestamps: {
      prospecto: '2026-10-01T08:00:00.000Z',
      levantamiento: '2026-10-06T09:00:00.000Z',
      cotizacion: '2026-10-12T10:00:00.000Z',
      negociacion: '2026-10-20T11:00:00.000Z'
    },
    tiempos_etapas_acumulados: { prospecto: 3, levantamiento: 4, cotizacion: 6 },
    stage_transitions: [
      { from: 'prospecto', to: 'levantamiento', tipo: 'avance', duracion_dias: 3, fecha: '2026-10-06T09:00:00.000Z' },
      { from: 'levantamiento', to: 'cotizacion', tipo: 'avance', duracion_dias: 4, fecha: '2026-10-12T10:00:00.000Z' },
      { from: 'cotizacion', to: 'negociacion', tipo: 'avance', duracion_dias: 6, fecha: '2026-10-20T11:00:00.000Z' }
    ]
  },

  // 4. Prospecto en Cierre con Dispensa sin Contrato (para probar retroceso a Negociación con invalidación de dispensa)
  {
    id: 'OP_STAGING_004',
    codigo: 'STG-2026-004',
    clientId: 'CLI_STAGING_01',
    empresa: 'Industrias Beta S.A. de C.V. (Staging)',
    contacto: 'Lic. Roberto Valdés',
    createdBy: '1000000000003',
    vendedorId: '1000000000003',
    vendedorName: 'Carlos Vendedor (Staging 1)',
    vendedorRole: 'vendedor',
    estado: 'activo',
    etapa: 'cierre',
    tipo_proyecto: 'Nuevo',
    precio_cotizado: 58000,
    costo_venta: 34000,
    fecha_inicio_cierre: '2026-10-24T09:00:00.000Z',
    fecha_limite_cierre: '2026-11-05T18:00:00.000Z',
    datos: {
      nota: 'Cierre aprobado por gerencia sin contrato formal por orden de compra corporativa',
      autorizado_sin_contrato: true,
      estado_propuesta: 'vigente',
      doc_oferta: { name: 'Oferta_Final_Aprobada.pdf', storagePath: 'prod_files/prospects/OP_STAGING_004/doc_oferta/oferta_aprobada.pdf' },
      doc_costos: { name: 'Costos_Finales.xlsx', storagePath: 'prod_files/prospects/OP_STAGING_004/doc_costos/costos_finales.xlsx' }
    },
    aprobacion_sin_contrato: {
      estado: 'aprobada',
      aprobado_por_id: '1000000000001',
      aprobado_por_nombre: 'Gerente General (Staging)',
      fecha_aprobacion: '2026-10-24T10:00:00.000Z',
      monto_autorizado: 58000,
      motivo: 'Cliente corporativo de alta solvencia con orden de compra formal emitida'
    },
    solicitudes_sin_contrato: [
      {
        id: 'req_stg_001',
        estado: 'aprobada',
        solicitado_por_id: '1000000000003',
        fecha_solicitud: '2026-10-24T09:15:00.000Z',
        motivo: 'Solicitud para iniciar compras de lámina y perfiles previo a firma notarial'
      }
    ],
    stage_timestamps: {
      prospecto: '2026-09-20T08:00:00.000Z',
      levantamiento: '2026-09-28T09:00:00.000Z',
      cotizacion: '2026-10-08T10:00:00.000Z',
      negociacion: '2026-10-16T11:00:00.000Z',
      cierre: '2026-10-24T09:00:00.000Z'
    },
    tiempos_etapas_acumulados: { prospecto: 6, levantamiento: 8, cotizacion: 6, negociacion: 6 },
    stage_transitions: [
      { from: 'prospecto', to: 'levantamiento', tipo: 'avance', duracion_dias: 6, fecha: '2026-09-28T09:00:00.000Z' },
      { from: 'levantamiento', to: 'cotizacion', tipo: 'avance', duracion_dias: 8, fecha: '2026-10-08T10:00:00.000Z' },
      { from: 'cotizacion', to: 'negociacion', tipo: 'avance', duracion_dias: 6, fecha: '2026-10-16T11:00:00.000Z' },
      { from: 'negociacion', to: 'cierre', tipo: 'avance', duracion_dias: 6, fecha: '2026-10-24T09:00:00.000Z' }
    ]
  },

  // 5. Oportunidad Ganada (para verificar métricas de dashboard, órdenes de cambio y bloqueo de reversiones)
  {
    id: 'OP_STAGING_005',
    codigo: 'STG-2026-005',
    clientId: 'CLI_STAGING_02',
    empresa: 'Ing. Alejandro Martell (Staging)',
    contacto: 'Ing. Alejandro Martell',
    createdBy: '1000000000004',
    vendedorId: '1000000000004',
    vendedorName: 'Elena Vendedora (Staging 2)',
    vendedorRole: 'vendedor',
    estado: 'ganado',
    etapa: 'cierre',
    postcierre_habilitado: true,
    tipo_proyecto: 'Nuevo',
    precio_cotizado: 28000,
    costo_venta: 16500,
    fecha_cierre: '2026-10-10T15:00:00.000Z',
    datos: {
      nota: 'Proyecto ganado y formalizado con anticipo facturado',
      doc_oferta: { name: 'Oferta_Ganada.pdf', storagePath: 'prod_files/prospects/OP_STAGING_005/doc_oferta/oferta.pdf' },
      doc_contrato: { name: 'Contrato_Firmado.pdf', storagePath: 'prod_files/prospects/OP_STAGING_005/doc_contrato/contrato.pdf' }
    },
    facturas: [
      {
        id: 'FAC_STG_01',
        numero: 'FC-101',
        monto: 14000,
        fecha: '2026-10-10T16:00:00.000Z',
        pagos: [
          { key: 'pago_1', monto: 14000, metodo: 'transferencia', ref: 'TR-998877', fecha: '2026-10-11T10:00:00.000Z' }
        ]
      }
    ],
    ordenes_cambio: [],
    stage_timestamps: {
      prospecto: '2026-09-01T08:00:00.000Z',
      levantamiento: '2026-09-10T09:00:00.000Z',
      cotizacion: '2026-09-18T10:00:00.000Z',
      negociacion: '2026-09-28T11:00:00.000Z',
      cierre: '2026-10-05T09:00:00.000Z'
    },
    tiempos_etapas_acumulados: { prospecto: 7, levantamiento: 6, cotizacion: 7, negociacion: 5, cierre: 4 }
  }
];

async function seedStaging(targetProject, options = {}) {
  const TARGET_PROJECT = targetProject || process.env.STAGING_PROJECT || process.argv[2] || 'ductsal-erp-staging';

  // Execute target project assertion before anything else
  assertSafeTargetProject(TARGET_PROJECT, 'seedStagingEnvironment');

  // Initialize Admin SDK for Staging with service account if available
  if (!admin.apps.length) {
    const fs = require('fs');
    const path = require('path');
    const possibleKeyPaths = [
      path.resolve(__dirname, '../../staging-service-account.json'),
      path.resolve(__dirname, '../staging-service-account.json'),
      path.resolve('staging-service-account.json'),
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ].filter(Boolean);

    let credential;
    for (const kp of possibleKeyPaths) {
      if (fs.existsSync(kp)) {
        try {
          credential = admin.credential.cert(require(kp));
          console.log(`[AUTH] Service account credential loaded from: ${kp}`);
          break;
        } catch (e) {
          // ignore and continue
        }
      }
    }

    if (!credential) {
      credential = admin.credential.applicationDefault();
    }

    admin.initializeApp({
      credential,
      projectId: TARGET_PROJECT,
      storageBucket: `${TARGET_PROJECT}.firebasestorage.app`
    });
  }

  const db = admin.firestore();
  const auth = admin.auth();
  const FieldValue = admin.firestore.FieldValue;

  // Collection names in staging use '_prod' (matching staging deployed rules) or '_staging'
  const SUFFIX = options.dbSuffix || process.env.DB_SUFFIX || '_prod';
  const USERS_COL = `users${SUFFIX}`;
  const DIR_COL = `userDirectory${SUFFIX}`;
  const CLIENTS_COL = `clients${SUFFIX}`;
  const PROSPECTS_COL = `prospects${SUFFIX}`;

  const DEFAULT_STAGING_PASSWORD = process.env.STAGING_USER_PASSWORD || 'DuctsalStaging2026!';

  console.log(`\n--- INICIANDO SEMILLA SINTÉTICA EN STAGING (${TARGET_PROJECT}) ---`);
  console.log(`Base de colecciones: ${USERS_COL}, ${CLIENTS_COL}, ${PROSPECTS_COL}\n`);

  // 1. Usuarios en Firebase Auth y Firestore
  console.log('1. Aprovisionando usuarios sintéticos (Auth + Firestore)...');
  for (const u of STAGING_USERS) {
    let authUid = null;
    try {
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(u.email);
        await auth.updateUser(userRecord.uid, {
          password: DEFAULT_STAGING_PASSWORD,
          displayName: u.nombre
        });
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          userRecord = await auth.createUser({
            email: u.email,
            password: DEFAULT_STAGING_PASSWORD,
            displayName: u.nombre
          });
        } else {
          throw err;
        }
      }
      authUid = userRecord.uid;
      await auth.setCustomUserClaims(authUid, u.expectedClaims);
      console.log(`   [AUTH OK] ${u.email} -> UID: ${authUid} (Claims: ${JSON.stringify(u.expectedClaims)})`);
    } catch (authErr) {
      console.warn(`   [AUTH WARN] No se pudo aprovisionar Auth para ${u.email}:`, authErr.message);
    }

    const userDocData = {
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      role: u.role,
      activo: u.activo,
      fecha_creacion: FieldValue.serverTimestamp()
    };
    if (authUid) {
      userDocData.authUid = authUid;
    }

    await db.collection(USERS_COL).doc(u.id).set(userDocData, { merge: true });

    await db.collection(DIR_COL).doc(u.id).set({
      id: u.id,
      nombre: u.nombre,
      role: u.role,
      activo: u.activo
    }, { merge: true });
    console.log(`   [FIRESTORE OK] Usuario: ${u.nombre} (${u.role}) - ID: ${u.id}`);
  }

  // 2. Clientes
  console.log('\n2. Aprovisionando clientes sintéticos...');
  for (const c of STAGING_CLIENTS) {
    await db.collection(CLIENTS_COL).doc(c.id).set({
      ...c,
      creadoEn: FieldValue.serverTimestamp(),
      actualizadoEn: FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`   [OK] Cliente: ${c.empresa} - ID: ${c.id}`);
  }

  // 3. Oportunidades
  console.log('\n3. Aprovisionando oportunidades sintéticas de prueba...');
  for (const p of STAGING_PROSPECTS) {
    await db.collection(PROSPECTS_COL).doc(p.id).set({
      ...p,
      version: 1,
      logs: [
        { text: `Oportunidad sintética creada en staging para pruebas de etapa ${p.etapa.toUpperCase()}`, date: new Date().toISOString(), auto: true }
      ]
    }, { merge: true });
    console.log(`   [OK] Oportunidad: [${p.codigo}] en etapa ${p.etapa.toUpperCase()} (${p.estado}) - ID: ${p.id}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log(`✅ SEMILLA COMPLETADA EXITOSAMENTE EN: ${TARGET_PROJECT}`);
  console.log('Conjunto de datos 100% sintético y aislado listo para pruebas de Fase 4F.');
  console.log('='.repeat(80) + '\n');
}

if (require.main === module) {
  seedStaging()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\n❌ ERROR EN SEMILLA STAGING:', err);
      process.exit(1);
    });
}

module.exports = { seedStaging, STAGING_USERS, STAGING_CLIENTS, STAGING_PROSPECTS };
