#!/usr/bin/env node
// functions/scripts/seedSyntheticDashboardF3.js
// Idempotent synthetic dataset seeder for DUCTSAL ERP - Fase 3 Dashboard Testing.
// Strictly isolated to the local Firebase Emulator (demo-ductsal-local on 127.0.0.1:8080).
// Every document ID is prefixed with TEST_DASHBOARD_F3_ for clean identification and teardown.

const H = require('../emulator-tests/helpers');

const PREFIX = 'TEST_DASHBOARD_F3_';
const USERS_COL = 'users_local';
const DIR_COL = 'userDirectory_local';
const CLIENTS_COL = 'clients_local';
const PROSPECTS_COL = 'prospects_local';

// ---------- SYNTHETIC CLIENTS ----------
const CLIENTS = [
  {
    id: `${PREFIX}CLI_1`,
    tipo: 'juridica',
    empresa: 'Industrias Metálicas del Norte, S.A.',
    contacto: 'Ing. Mauricio Rivas',
    telefono: '2222-0001',
    correo: 'mrivas@norte.invalid',
    activo: true
  },
  {
    id: `${PREFIX}CLI_2`,
    tipo: 'juridica',
    empresa: 'Desarrollos Hoteleros de la Costa',
    contacto: 'Lic. Claudia Herrera',
    telefono: '2222-0002',
    correo: 'cherrera@costa.invalid',
    activo: true
  },
  {
    id: `${PREFIX}CLI_3`,
    tipo: 'juridica',
    empresa: 'Centro Comercial Galerías',
    contacto: 'Arq. Fernando Soto',
    telefono: '2222-0003',
    correo: 'fsoto@galerias.invalid',
    activo: true
  }
];

// ---------- SYNTHETIC SELLERS ----------
const SELLERS = [
  {
    id: `${PREFIX}VEN_1`,
    nombre: 'Carlos Mendoza',
    email: 'carlos.mendoza@ductsal-test.invalid',
    role: 'vendedor',
    activo: true
  },
  {
    id: `${PREFIX}VEN_2`,
    nombre: 'Ana Morales',
    email: 'ana.morales@ductsal-test.invalid',
    role: 'vendedor',
    activo: true
  },
  {
    id: `${PREFIX}VEN_3`,
    nombre: 'Roberto Flores',
    email: 'roberto.flores@ductsal-test.invalid',
    role: 'vendedor',
    activo: true
  }
];

// ---------- SYNTHETIC OPPORTUNITIES (PROSPECTS) ----------
const PROSPECTS = [
  // A. VENTAS GANADAS (5 operaciones)
  // 1. Ganada Enero 2026 - Carlos Mendoza (Costo completo $12k / Venta $20k)
  {
    id: `${PREFIX}WON_1`,
    codigo: '2026-001',
    clientId: `${PREFIX}CLI_1`,
    proyecto: 'Ventilación Nave Industrial Fase 1',
    estado: 'ganado',
    etapa: 'cierre',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Referido',
    vendedorId: `${PREFIX}VEN_1`,
    vendedor: 'Carlos Mendoza',
    vendedorName: 'Carlos Mendoza',
    precio_cotizado: 20000,
    costo_venta: 12000,
    fecha_cierre: '2026-01-20T10:00:00.000Z',
    fecha_creacion: '2026-01-05T09:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-01-05T09:00:00.000Z',
      levantamiento: '2026-01-08T10:00:00.000Z',
      cotizacion: '2026-01-12T14:00:00.000Z',
      negociacion: '2026-01-16T16:00:00.000Z',
      cierre: '2026-01-20T10:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [
      {
        id: 'FAC-001',
        numero: 'FAC-001',
        fecha: '2026-01-22T10:00:00.000Z',
        monto: 11300,
        pagos: [
          { id: 'PAG-001', monto: 11300, metodo: 'transferencia', ref: 'TR-101', fecha: '2026-01-25T11:00:00.000Z' }
        ]
      }
    ],
    postcierre_habilitado: true,
    eliminado: false
  },

  // 2. Ganada Febrero 2026 - Ana Morales (Orden de cambio aumento: Venta base 15k + 5k = 20k; Costo base 9k + 3k = 12k)
  {
    id: `${PREFIX}WON_2`,
    codigo: '2026-002',
    clientId: `${PREFIX}CLI_2`,
    proyecto: 'Sistema Chutes Torre Médica',
    estado: 'ganado',
    etapa: 'cierre',
    tipo_producto: 'Chute',
    tipo_proyecto: 'Fabricación',
    origen: 'Llamada',
    vendedorId: `${PREFIX}VEN_2`,
    vendedor: 'Ana Morales',
    vendedorName: 'Ana Morales',
    precio_cotizado: 15000,
    costo_venta: 9000,
    fecha_cierre: '2026-02-18T15:00:00.000Z',
    fecha_creacion: '2026-01-28T11:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-01-28T11:00:00.000Z',
      levantamiento: '2026-02-02T10:00:00.000Z',
      cotizacion: '2026-02-08T15:00:00.000Z',
      negociacion: '2026-02-14T10:00:00.000Z',
      cierre: '2026-02-18T15:00:00.000Z'
    },
    ordenes_cambio: [
      {
        id: 'OC-01',
        tipo: 'aumento',
        precio: 5000,
        costo: 3000,
        desc: 'Ampliación 2 niveles superiores',
        fecha: '2026-02-22T10:00:00.000Z'
      }
    ],
    facturas: [
      {
        id: 'FAC-002',
        numero: 'FAC-002',
        fecha: '2026-02-25T10:00:00.000Z',
        monto: 22600,
        pagos: [
          { id: 'PAG-002', monto: 10000, metodo: 'transferencia', ref: 'TR-102', fecha: '2026-02-28T09:00:00.000Z' }
        ]
      }
    ],
    postcierre_habilitado: true,
    eliminado: false
  },

  // 3. Ganada Marzo 2026 - Carlos Mendoza (Orden de cambio disminución: Venta base 30k - 5k = 25k; Costo base 18k - 3k = 15k)
  {
    id: `${PREFIX}WON_3`,
    codigo: '2026-003',
    clientId: `${PREFIX}CLI_1`,
    proyecto: 'Extracción Cocinas Hotel Bahía',
    estado: 'ganado',
    etapa: 'cierre',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Web',
    vendedorId: `${PREFIX}VEN_1`,
    vendedor: 'Carlos Mendoza',
    vendedorName: 'Carlos Mendoza',
    precio_cotizado: 30000,
    costo_venta: 18000,
    fecha_cierre: '2026-03-12T16:00:00.000Z',
    fecha_creacion: '2026-02-10T14:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-02-10T14:00:00.000Z',
      levantamiento: '2026-02-16T11:00:00.000Z',
      cotizacion: '2026-02-25T16:00:00.000Z',
      negociacion: '2026-03-05T10:00:00.000Z',
      cierre: '2026-03-12T16:00:00.000Z'
    },
    ordenes_cambio: [
      {
        id: 'OC-02',
        tipo: 'disminucion',
        precio: 5000,
        costo: 3000,
        desc: 'Cancelación módulo de filtros carbón',
        fecha: '2026-03-15T10:00:00.000Z'
      }
    ],
    facturas: [
      {
        id: 'FAC-003',
        numero: 'FAC-003',
        fecha: '2026-03-20T10:00:00.000Z',
        monto: 28250,
        pagos: []
      }
    ],
    postcierre_habilitado: true,
    eliminado: false
  },

  // 4. Ganada Marzo 2026 - Roberto Flores (Costo ausente: Venta 15k, Costo null)
  {
    id: `${PREFIX}WON_4`,
    codigo: '2026-004',
    clientId: `${PREFIX}CLI_3`,
    proyecto: 'Chute Descarga Basura Residencial',
    estado: 'ganado',
    etapa: 'cierre',
    tipo_producto: 'Chute',
    tipo_proyecto: 'Fabricación',
    origen: 'Referido',
    vendedorId: `${PREFIX}VEN_3`,
    vendedor: 'Roberto Flores',
    vendedorName: 'Roberto Flores',
    precio_cotizado: 15000,
    costo_venta: null, // Costo ausente
    fecha_cierre: '2026-03-25T11:30:00.000Z',
    fecha_creacion: '2026-03-01T09:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-03-01T09:00:00.000Z',
      levantamiento: '2026-03-08T10:00:00.000Z',
      cotizacion: '2026-03-15T12:00:00.000Z',
      negociacion: '2026-03-20T14:00:00.000Z',
      cierre: '2026-03-25T11:30:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    postcierre_habilitado: true,
    eliminado: false
  },

  // 5. Ganada Noviembre 2025 - Carlos Mendoza (Cierre del año anterior para Histórico vs YTD)
  {
    id: `${PREFIX}WON_5`,
    codigo: '2025-089',
    clientId: `${PREFIX}CLI_2`,
    proyecto: 'Ductos de Inyección Planta Farmacéutica',
    estado: 'ganado',
    etapa: 'cierre',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Llamada',
    vendedorId: `${PREFIX}VEN_1`,
    vendedor: 'Carlos Mendoza',
    vendedorName: 'Carlos Mendoza',
    precio_cotizado: 25000,
    costo_venta: 15000,
    fecha_cierre: '2025-11-15T14:00:00.000Z',
    fecha_creacion: '2025-10-10T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2025-10-10T10:00:00.000Z',
      levantamiento: '2025-10-20T11:00:00.000Z',
      cotizacion: '2025-10-30T15:00:00.000Z',
      negociacion: '2025-11-08T16:00:00.000Z',
      cierre: '2025-11-15T14:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    postcierre_habilitado: true,
    eliminado: false
  },

  // B. OPERACIONES PERDIDAS (2 operaciones)
  // 6. Perdida Febrero 2026 - Ana Morales (Fecha pérdida válida: 2026-02-20)
  {
    id: `${PREFIX}LOST_1`,
    codigo: '2026-005',
    clientId: `${PREFIX}CLI_3`,
    proyecto: 'Ductería Torre de Oficinas',
    estado: 'perdido',
    etapa: 'cotizacion',
    motivo_perdida: 'Precio',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Feria',
    vendedorId: `${PREFIX}VEN_2`,
    vendedor: 'Ana Morales',
    vendedorName: 'Ana Morales',
    precio_cotizado: 18000,
    costo_venta: 11000,
    fecha_creacion: '2026-01-15T10:00:00.000Z',
    fecha_perdida: '2026-02-20T12:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-01-15T10:00:00.000Z',
      levantamiento: '2026-01-25T11:00:00.000Z',
      cotizacion: '2026-02-05T14:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // 7. Perdida Sin Fecha Válida - Roberto Flores (Demuestra que no se atribuye a mes arbitrario)
  {
    id: `${PREFIX}LOST_2`,
    codigo: '2026-006',
    clientId: `${PREFIX}CLI_1`,
    proyecto: 'Chute Complejo Habitacional',
    estado: 'perdido',
    etapa: 'levantamiento',
    motivo_perdida: 'Competencia',
    tipo_producto: 'Chute',
    tipo_proyecto: 'Fabricación',
    origen: 'Referido',
    vendedorId: `${PREFIX}VEN_3`,
    vendedor: 'Roberto Flores',
    vendedorName: 'Roberto Flores',
    precio_cotizado: 12000,
    costo_venta: 7000,
    fecha_creacion: '2026-02-10T10:00:00.000Z',
    fecha_perdida: null, // Sin fecha demostrable
    stage_timestamps: {
      prospecto: '2026-02-10T10:00:00.000Z',
      levantamiento: '2026-02-18T11:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // C. PIPELINE ACTIVO VIVO (5 operaciones)
  // 8. Activo en Prospecto (prob 20%) - Carlos Mendoza
  {
    id: `${PREFIX}ACT_1`,
    codigo: '2026-010',
    clientId: `${PREFIX}CLI_1`,
    proyecto: 'Planta Procesadora Alimentos',
    estado: 'activo',
    etapa: 'prospecto',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Web',
    vendedorId: `${PREFIX}VEN_1`,
    vendedor: 'Carlos Mendoza',
    vendedorName: 'Carlos Mendoza',
    precio_cotizado: 10000,
    costo_venta: 6000,
    probabilidad: 20,
    fecha_creacion: '2026-10-18T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-10-18T10:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // 9. Activo en Levantamiento (prob 50%) - Ana Morales
  {
    id: `${PREFIX}ACT_2`,
    codigo: '2026-011',
    clientId: `${PREFIX}CLI_2`,
    proyecto: 'Centro Logístico Bodegas',
    estado: 'activo',
    etapa: 'levantamiento',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación',
    origen: 'Llamada',
    vendedorId: `${PREFIX}VEN_2`,
    vendedor: 'Ana Morales',
    vendedorName: 'Ana Morales',
    precio_cotizado: 20000,
    costo_venta: 12000,
    probabilidad: 50,
    fecha_creacion: '2026-10-15T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-10-15T10:00:00.000Z',
      levantamiento: '2026-10-19T10:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // 10. Activo en Cotización (prob 50% - ESTANCADA 17 días > 5 días límite) - Carlos Mendoza
  {
    id: `${PREFIX}ACT_3`,
    codigo: '2026-012',
    clientId: `${PREFIX}CLI_1`,
    proyecto: 'Torre Residencial Los Pinos',
    estado: 'activo',
    etapa: 'cotizacion',
    tipo_producto: 'Chute',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Referido',
    vendedorId: `${PREFIX}VEN_1`,
    vendedor: 'Carlos Mendoza',
    vendedorName: 'Carlos Mendoza',
    precio_cotizado: 30000,
    costo_venta: 18000,
    probabilidad: 50,
    fecha_creacion: '2026-09-20T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-09-20T10:00:00.000Z',
      levantamiento: '2026-09-28T10:00:00.000Z',
      cotizacion: '2026-10-05T10:00:00.000Z' // 17 días en cotización al 22 de Octubre
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // 11. Activo en Negociación (prob 80%) - Roberto Flores
  {
    id: `${PREFIX}ACT_4`,
    codigo: '2026-013',
    clientId: `${PREFIX}CLI_3`,
    proyecto: 'Clínica Quirúrgica Central',
    estado: 'activo',
    etapa: 'negociacion',
    tipo_producto: 'Ducto',
    tipo_proyecto: 'Fabricación e instalación',
    origen: 'Llamada',
    vendedorId: `${PREFIX}VEN_3`,
    vendedor: 'Roberto Flores',
    vendedorName: 'Roberto Flores',
    precio_cotizado: 25000,
    costo_venta: 15000,
    probabilidad: 80,
    fecha_creacion: '2026-10-01T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-10-01T10:00:00.000Z',
      levantamiento: '2026-10-08T10:00:00.000Z',
      cotizacion: '2026-10-12T10:00:00.000Z',
      negociacion: '2026-10-19T10:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  },

  // 12. Activo en Cierre (prob null -> Alerta sin probabilidad) - Ana Morales
  {
    id: `${PREFIX}ACT_5`,
    codigo: '2026-014',
    clientId: `${PREFIX}CLI_2`,
    proyecto: 'Edificio Corporativo Sur',
    estado: 'activo',
    etapa: 'cierre',
    tipo_producto: 'Chute',
    tipo_proyecto: 'Fabricación',
    origen: 'Web',
    vendedorId: `${PREFIX}VEN_2`,
    vendedor: 'Ana Morales',
    vendedorName: 'Ana Morales',
    precio_cotizado: 15000,
    costo_venta: 9000,
    probabilidad: null, // Sin probabilidad
    fecha_creacion: '2026-10-01T10:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-10-01T10:00:00.000Z',
      levantamiento: '2026-10-05T10:00:00.000Z',
      cotizacion: '2026-10-10T10:00:00.000Z',
      negociacion: '2026-10-15T10:00:00.000Z',
      cierre: '2026-10-20T10:00:00.000Z'
    },
    ordenes_cambio: [],
    facturas: [],
    eliminado: false
  }
];

// ---------- REST FIRESTORE CLIENT (Strictly 127.0.0.1:8080) ----------
function encodeValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encodeValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = encodeValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = encodeValue(v);
  }
  return fields;
}

async function writeDoc(collection, docId, data) {
  const url = `${H.FIRESTORE}/v1/projects/${H.PROJECT}/databases/(default)/documents/${collection}/${docId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...H.OWNER },
    body: JSON.stringify({ fields: encodeFields(data) })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Failed to write ${collection}/${docId} (status ${r.status}): ${text}`);
  }
  return { id: docId, collection };
}

async function seed() {
  console.log('--- DUCTSAL ERP: Carga de Datos Sintéticos para Fase 3 ---');
  console.log(`Verificando emulador en ${H.FIRESTORE} (proyecto: ${H.PROJECT})...`);
  await H.assertEmulatorsUp();
  console.log('✅ Emulador activo y respondiendo exclusivamente en 127.0.0.1.');

  const manifest = {
    clients: [],
    sellers: [],
    userDirectory: [],
    prospects: []
  };

  // 1. Cargar clientes sintéticos
  console.log(`Cargando ${CLIENTS.length} clientes sintéticos en ${CLIENTS_COL}...`);
  for (const c of CLIENTS) {
    await writeDoc(CLIENTS_COL, c.id, c);
    manifest.clients.push(c.id);
  }
  console.log(`  [OK] ${CLIENTS.length} clientes creados.`);

  // 2. Cargar vendedores sintéticos en users_local y userDirectory_local
  console.log(`Cargando ${SELLERS.length} vendedores sintéticos en ${USERS_COL} y ${DIR_COL}...`);
  for (const s of SELLERS) {
    await writeDoc(USERS_COL, s.id, {
      id: s.id,
      nombre: s.nombre,
      email: s.email,
      role: s.role,
      activo: s.activo
    });
    await writeDoc(DIR_COL, s.id, {
      id: s.id,
      nombre: s.nombre,
      role: s.role,
      activo: s.activo
    });
    manifest.sellers.push(s.id);
    manifest.userDirectory.push(s.id);
  }
  console.log(`  [OK] ${SELLERS.length} vendedores creados en ambas colecciones.`);

  // 3. Cargar oportunidades sintéticas en prospects_local
  console.log(`Cargando ${PROSPECTS.length} oportunidades sintéticas en ${PROSPECTS_COL}...`);
  for (const p of PROSPECTS) {
    await writeDoc(PROSPECTS_COL, p.id, p);
    manifest.prospects.push(p.id);
  }
  console.log(`  [OK] ${PROSPECTS.length} oportunidades creadas.`);

  console.log('\n--- RESUMEN DE DOCUMENTOS SINTÉTICOS CREADOS ---');
  console.log(`Total documentos creados: ${manifest.clients.length + manifest.sellers.length * 2 + manifest.prospects.length}`);
  console.log(`- Clientes (${CLIENTS_COL}): ${manifest.clients.join(', ')}`);
  console.log(`- Vendedores (${USERS_COL} / ${DIR_COL}): ${manifest.sellers.join(', ')}`);
  console.log(`- Oportunidades (${PROSPECTS_COL}):`);
  manifest.prospects.forEach(id => console.log(`    • ${id}`));
  console.log('\n✅ Carga sintética finalizada exitosamente.');
  return manifest;
}

if (require.main === module) {
  seed().catch(err => {
    console.error('❌ Error en seed:', err);
    process.exit(1);
  });
}

module.exports = { seed, PREFIX, CLIENTS, SELLERS, PROSPECTS };
