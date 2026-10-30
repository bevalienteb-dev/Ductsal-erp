// functions/__tests__/commercialClosureAndPriority.unit.test.js
// Pruebas unitarias para:
// 1. Columna Prioridad en Agenda (badge estructurado, días diferenciados, adaptabilidad y alineación)
// 2. Cierre Comercial Ordinario sin Permiso Especial (5 reglas de negocio, controles de acceso y caso 202610153)

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const CrmFollowUpCalc = require('../crm_followup_calc');

global.window = {
  location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
  _docStore: new Map(),
  CrmFollowUpCalc
};

const mockFirestore = {
  settings: () => {},
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      onSnapshot: jest.fn(() => jest.fn()),
      get: async () => ({ exists: false, data: () => ({}) })
    })),
    onSnapshot: jest.fn(() => jest.fn()),
    where: jest.fn(() => ({ onSnapshot: jest.fn(() => jest.fn()) }))
  }))
};

global.firebase = {
  initializeApp: () => ({}),
  firestore: () => mockFirestore,
  storage: () => ({ ref: () => ({}) }),
  auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged: jest.fn() }),
  functions: () => ({ httpsCallable: () => async () => ({ data: {} }) })
};

global.localStorage = {
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
  removeItem: jest.fn()
};

global.Chart = jest.fn(() => ({ destroy: jest.fn(), update: jest.fn() }));
global.Chart.defaults = { color: '', font: {} };
global.db = mockFirestore;
global.DB_SUFFIX = '_prod';
global.CrmFollowUpCalc = CrmFollowUpCalc;

let domElements = {};
function makeMockEl(id, initial = {}) {
  const classes = new Set(initial.classes || []);
  const el = Object.assign({
    id,
    tagName: 'DIV',
    value: '',
    style: {},
    dataset: {},
    files: [],
    options: [],
    children: [],
    textContent: '',
    innerHTML: '',
    disabled: false,
    classList: {
      add: jest.fn(c => classes.add(c)),
      remove: jest.fn(c => classes.delete(c)),
      contains: jest.fn(c => classes.has(c))
    },
    appendChild: jest.fn(function(child) {
      if (!this.children) this.children = [];
      this.children.push(child);
      this.innerHTML += (child && child.innerHTML) ? child.innerHTML : '';
    }),
    getContext: jest.fn(() => ({}))
  }, initial);
  domElements[id] = el;
  return el;
}

global.document = {
  getElementById: (id) => domElements[id] || makeMockEl(id),
  createElement: (tag) => makeMockEl(`dyn_${Math.random()}`, { tagName: tag.toUpperCase() }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: jest.fn()
};
global.alert = jest.fn();
global.confirm = jest.fn(() => false);

const appCore = require('../../app_core');

const CLOCK = new Date('2026-10-29T12:00:00.000Z');

function makeEnv(customClock = CLOCK) {
  const fdb = createFakeFirestore({ clock: () => customClock });
  const live = { ok: true, calls: [] };
  const service = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => customClock,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });
  const wf = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: service.kit });
  const caller = (role, cid = 'VENDEDOR-1', name = 'Vendedor Uno') => ({
    uid: `uid_${cid}`,
    cid,
    name,
    role
  });
  return { fdb, service, wf, caller, live, now: customClock };
}

const fileObj = (name, folder = 'proyectos', prospectId = 'p-100') => ({
  name,
  storagePath: `prod_files/${folder}/${prospectId}/${name}`
});

describe('1. Columna Prioridad en Agenda — Estructura, Legibilidad y Adaptación', () => {

  beforeEach(() => {
    domElements = {};
    makeMockEl('agenda-table-body');
    makeMockEl('agenda-empty-state');
    makeMockEl('agenda-table-wrapper');
    makeMockEl('agenda-badge-counter');
    makeMockEl('agenda-seller-filter-wrap');
    makeMockEl('agenda-seller-select', { options: [] });
    makeMockEl('filter-agenda-escaladas');
    makeMockEl('count-agenda-todas');
    makeMockEl('count-agenda-vencidas');
    makeMockEl('count-agenda-hoy');
    makeMockEl('count-agenda-proximas');
    makeMockEl('count-agenda-pendientes');
    makeMockEl('count-agenda-escaladas');

    appCore.setCurrentUser({ id: 'V-01', cid: 'V-01', role: 'vendedor', nombre: 'Carlos Vendedor', activo: true });
    appCore.setClients([{ id: 'c-1', empresa: 'Cliente Corporativo Alfa S.A.' }]);
    jest.clearAllMocks();
  });

  test('1.1 Genera componente priority-badge-group con información de estado y días diferenciados para 1, 2 y 3 dígitos', () => {
    // Caso A: 1 dígito (1d de atraso)
    const p1 = {
      id: 'p-1',
      codigo: 'PRJ-001',
      proyecto: 'Fabricación Ductos Línea 1',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        ultimo_contacto: { fecha: '2026-10-20', canal: 'llamada', resultado: 'sin_respuesta' },
        proxima_accion: { fecha: '2026-10-28', tipo: 'llamada', descripcion: 'Llamar al cliente' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 1 }
      }
    };

    // Caso B: 2 dígitos (74d de atraso)
    const p74 = {
      id: 'p-74',
      codigo: 'PRJ-074',
      proyecto: 'Instalación Nave Industrial B',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        ultimo_contacto: { fecha: '2026-08-01', canal: 'correo', resultado: 'sin_respuesta' },
        proxima_accion: { fecha: '2026-08-16', tipo: 'llamada', descripcion: 'Revisar propuesta técnica' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 2 }
      }
    };

    // Caso C: 3 dígitos (120d de atraso)
    const p120 = {
      id: 'p-120',
      codigo: 'PRJ-120',
      proyecto: 'Ductería Extracción Central',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        ultimo_contacto: { fecha: '2026-06-01', canal: 'llamada', resultado: 'sin_respuesta' },
        proxima_accion: { fecha: '2026-07-01', tipo: 'llamada', descripcion: 'Seguimiento general' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 2 }
      }
    };

    appCore.setProspects([p1, p74, p120]);
    appCore.renderDailyAgenda();

    const tbody = domElements['agenda-table-body'];
    expect(tbody).toBeDefined();
    const html = tbody.innerHTML;

    // Verificar que contiene la clase moderna de agrupación
    expect(html).toContain('priority-badge-group');
    expect(html).toContain('badge-urgency-vencida');

    // Verificar que la etiqueta "Vencida" y los días son elementos separados
    expect(html).toContain('<span class="priority-label">🚨 Vencida</span>');
    expect(html).toContain('<span class="priority-days">1d</span>');
    expect(html).toContain('<span class="priority-days">74d</span>');
    expect(html).toContain('<span class="priority-days">120d</span>');

    // Comprobar que la celda tiene la clase col-agenda-priority
    expect(html).toContain('class="col-agenda-priority"');
    expect(html).toContain('class="col-agenda-code"');
    expect(html).toContain('class="col-agenda-client"');
  });

  test('1.2 Estados no vencidos: "Para Hoy", "Próxima" y "Decisión" se muestran ordenados sin solapamientos', () => {
    const todayYMD = '2026-10-29';
    const futureYMD = '2026-11-05';

    const pHoy = {
      id: 'p-hoy',
      codigo: 'PRJ-HOY',
      proyecto: 'Extracción Cocina Industrial',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        proxima_accion: { fecha: todayYMD, tipo: 'llamada', descripcion: 'Llamar hoy al mediodía' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 0 }
      }
    };

    const pProx = {
      id: 'p-prox',
      codigo: 'PRJ-PROX',
      proyecto: 'Campana Extractora Filtros',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        proxima_accion: { fecha: futureYMD, tipo: 'llamada', descripcion: 'Llamar próxima semana' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 0 }
      }
    };

    const pDecision = {
      id: 'p-dec',
      codigo: 'PRJ-DEC',
      proyecto: 'Sistema HVAC Planta Farmacéutica',
      clientId: 'c-1',
      vendedorId: 'V-01',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'ejecucion',
      seguimiento: {
        ultimo_contacto: { fecha: '2026-10-25', canal: 'llamada', resultado: 'sin_respuesta' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 3 }
      }
    };

    appCore.setProspects([pHoy, pProx, pDecision]);
    appCore.renderDailyAgenda();

    const tbody = domElements['agenda-table-body'];
    const html = tbody.innerHTML;

    expect(html).toContain('badge-urgency-hoy');
    expect(html).toContain('<span class="priority-label">📌 Para Hoy</span>');

    expect(html).toContain('badge-urgency-proxima');
    expect(html).toContain('<span class="priority-label">⏳ Próxima</span>');

    expect(html).toContain('badge-urgency-decision');
    expect(html).toContain('<span class="priority-label">⚠️ Decisión</span>');
    expect(html).toContain('<span class="priority-days">3 int.</span>');
  });
});

describe('2. Regla de Negocio: Cierre Comercial Ordinario sin Permiso Especial', () => {

  const baseClient = {
    id: 'c-alpha',
    tipo: 'juridica',
    empresa: 'Corporación Industrial Alfa S.A. de C.V.',
    contacto: 'Ing. Rodrigo Mendoza',
    telefono: '2233-4455',
    correo: 'compras@alfa.com',
    correo_fact: 'facturacion@alfa.com',
    nit: '0614-101015-102-1',
    nrc: '123456-7',
    documentos: {
      dui: '01234567-8'
    }
  };

  const standardProject = {
    id: 'prj-5000',
    codigo: '202610200',
    proyecto: 'Sistema de Ventilación Naves 1 y 2',
    clientId: 'c-alpha',
    vendedorId: 'CARLOS-VENDEDOR',
    createdBy: 'CARLOS-VENDEDOR',
    encargado: 'Carlos Vendedor',
    etapa: 'cierre',
    estado: 'activo',
    precio_cotizado: 5000,
    costo_venta: 3200,
    tipo_proyecto: 'Fabricación',
    clasificacion: 'ejecucion',
    fecha_creacion: '2026-10-01',
    fecha_inicio_cierre: '2026-10-25',
    datos: {}
  };

  test('2.1 Regla 1: Vendedor asignado o gestor con acceso legítimo completa el cierre normal SIN requerir autorización gerencial', async () => {
    const { fdb, wf, caller, live } = makeEnv();
    await fdb.seed('clients_prod/c-alpha', baseClient);
    await fdb.seed('prospects_prod/prj-5000', standardProject);

    // Vendedor asignado realiza la llamada
    const result = await wf.finalizeProspect({
      caller: caller('vendedor', 'CARLOS-VENDEDOR', 'Carlos Vendedor'),
      prospectId: 'prj-5000',
      data: {
        doc_firmado: fileObj('oferta_firmada_alfa.pdf', 'proyectos', 'prj-5000'),
        doc_comprobante: fileObj('comprobante_anticipo_alfa.pdf', 'facturas', 'prj-5000'),
        forma_pago: '50/50',
        factura_anticipo: 'FCF-5501'
      }
    });

    expect(result.status).toBe('finalized');
    expect(result.etapa).toBe('cierre');
    expect(result.estado).toBe('ganado');
    expect(result.facturaAnticipo).toBe('FCF-5501');

    // Verificar que NO se requirió ninguna llamada de verificación gerencial
    expect(live.calls).toHaveLength(0);

    // Verificar persistencia en Firestore
    const snap = await fdb.collection('prospects_prod').doc('prj-5000').get();
    const updated = snap.data();
    expect(updated.estado).toBe('ganado');
    expect(updated.postcierre_habilitado).toBe(true);
    expect(updated.fecha_cierre).toBeDefined();
    expect(updated.facturas).toHaveLength(1);
    expect(updated.facturas[0].numero).toBe('FCF-5501');
    expect(updated.facturas[0].monto).toBe(2825); // 5000 * 1.13 * 0.5 = 2825
  });

  test('2.2 Regla 2: La operación rechaza a usuarios no autenticados o vendedores no asignados', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/c-alpha', baseClient);
    await fdb.seed('prospects_prod/prj-5000', standardProject);

    const validClosingData = {
      doc_firmado: fileObj('oferta_firmada_alfa.pdf', 'proyectos', 'prj-5000'),
      doc_comprobante: fileObj('comprobante_anticipo_alfa.pdf', 'facturas', 'prj-5000'),
      forma_pago: '50/50',
      factura_anticipo: 'FCF-5501'
    };

    // Caso A: Usuario no autenticado / sin rol CRM
    await expect(wf.finalizeProspect({
      caller: null,
      prospectId: 'prj-5000',
      data: validClosingData
    })).rejects.toThrow();

    // Caso B: Vendedor ajeno (no asignado y no creador)
    await expect(wf.finalizeProspect({
      caller: caller('vendedor', 'OTRO-VENDEDOR', 'Otro Vendedor'),
      prospectId: 'prj-5000',
      data: validClosingData
    })).rejects.toThrow(/No tienes acceso a esta oportunidad/i);
  });

  test('2.3 Regla 3: Los requisitos documentales válidos siguen verificándose de forma obligatoria', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/c-alpha', baseClient);
    await fdb.seed('prospects_prod/prj-5000', standardProject);

    const callerVendedor = caller('vendedor', 'CARLOS-VENDEDOR');

    // Falta oferta firmada
    await expect(wf.finalizeProspect({
      caller: callerVendedor,
      prospectId: 'prj-5000',
      data: {
        doc_comprobante: fileObj('comprobante.pdf'),
        forma_pago: '100% anticipado',
        factura_anticipo: 'FCF-001'
      }
    })).rejects.toThrow(/Debe adjuntar la oferta firmada para finalizar/i);

    // Falta comprobante de anticipo
    await expect(wf.finalizeProspect({
      caller: callerVendedor,
      prospectId: 'prj-5000',
      data: {
        doc_firmado: fileObj('oferta.pdf'),
        forma_pago: '100% anticipado',
        factura_anticipo: 'FCF-001'
      }
    })).rejects.toThrow(/Debe adjuntar el comprobante o factura de anticipo para finalizar/i);

    // Falta número de factura
    await expect(wf.finalizeProspect({
      caller: callerVendedor,
      prospectId: 'prj-5000',
      data: {
        doc_firmado: fileObj('oferta.pdf'),
        doc_comprobante: fileObj('comprobante.pdf'),
        forma_pago: '100% anticipado'
      }
    })).rejects.toThrow(/El número de factura de anticipo es obligatorio/i);

    // Falta forma de pago
    await expect(wf.finalizeProspect({
      caller: callerVendedor,
      prospectId: 'prj-5000',
      data: {
        doc_firmado: fileObj('oferta.pdf'),
        doc_comprobante: fileObj('comprobante.pdf'),
        factura_anticipo: 'FCF-001'
      }
    })).rejects.toThrow(/Forma de pago inválida/i);
  });

  test('2.4 Regla 4: Las autorizaciones de operaciones diferentes continúan requiriendo permisos gerenciales', async () => {
    const { fdb, wf, service, caller, live } = makeEnv();
    await fdb.seed('clients_prod/c-alpha', baseClient);

    // Proyecto de Fabricación e Instalación mayor a $10k SIN contrato requiere resolución gerencial
    await fdb.seed('prospects_prod/prj-big', {
      ...standardProject,
      id: 'prj-big',
      vendedorId: 'ALEJANDRA-AYALA',
      createdBy: 'ALEJANDRA-AYALA',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 25000,
      costo_venta: 16000
    });

    const callerGestor = caller('gestor', 'ALEJANDRA-AYALA');

    // 1. Intentar resolver una solicitud de venta sin contrato siendo Gestor (rechazado: solo manager en vivo)
    await expect(service.resolveNoContractAuthorization({
      caller: callerGestor,
      prospectId: 'prj-big',
      requestId: 'req-01',
      decision: 'approve',
      motivoDecision: 'Aprobación indebida por gestor'
    })).rejects.toThrow(/Solo un gerente puede resolver solicitudes de venta sin contrato/i);

    // Eliminación lógica de prospecto sigue siendo exclusiva de Manager
    await expect(wf.deleteProspect({
      caller: callerGestor,
      prospectId: 'prj-big',
      motivo: 'Intento de borrado por gestor'
    })).rejects.toThrow(/Solo un gerente puede eliminar proyectos/i);

    // Comprobamos que un Manager con verificación viva sí puede eliminarlo
    const callerManager = caller('manager', 'GERENTE-01');
    const delRes = await wf.deleteProspect({
      caller: callerManager,
      prospectId: 'prj-big',
      motivo: 'Proyecto cancelado formalmente por gerencia'
    });
    expect(delRes.status).toBe('deleted');
    expect(live.calls).toContain('uid_GERENTE-01');
  });

  test('2.5 Regla 5: El proyecto cerrado se envía a Proyectos y Cobros y es visible para gestor y vendedor asignado', () => {
    const closedProject = {
      id: 'prj-closed-01',
      codigo: 'PRJ-2026-888',
      proyecto: 'Instalación Ductos Industriales A',
      clientId: 'c-alpha',
      vendedorId: 'CARLOS-V',
      encargado: 'Carlos V',
      etapa: 'cierre',
      estado: 'ganado',
      postcierre_habilitado: true,
      precio_cotizado: 10000,
      facturas: [{ id: 'f-1', numero: 'FCF-100', monto: 5650, pagos: [] }]
    };

    makeMockEl('proj-table-body');
    makeMockEl('projects-view-title');
    makeMockEl('projects-view-desc');
    makeMockEl('count-proj-pendientes');
    makeMockEl('count-proj-pagados');
    makeMockEl('count-proj-todos');

    // Gestor ve el proyecto en Proyectos y Control de Cobros
    appCore.setCurrentUser({ id: 'ALEJANDRA', role: 'gestor', nombre: 'Alejandra Ayala' });
    appCore.setProspects([closedProject]);
    appCore.setClients([baseClient]);

    appCore.renderProjectsList();

    const tbody = domElements['proj-table-body'];
    expect(tbody.innerHTML).toContain('PRJ-2026-888');
    expect(tbody.innerHTML).toContain('Corporación Industrial Alfa');

    // Vendedor asignado también lo ve en "Mis Proyectos y Cobros Asignados"
    appCore.setCurrentUser({ id: 'CARLOS-V', role: 'vendedor', nombre: 'Carlos V' });
    appCore.renderProjectsList();
    expect(domElements['proj-table-body'].innerHTML).toContain('PRJ-2026-888');

    // Otro vendedor NO asignado NO lo ve en sus proyectos
    appCore.setCurrentUser({ id: 'OTRO-V', role: 'vendedor', nombre: 'Otro Vendedor' });
    appCore.renderProjectsList();
    expect(domElements['proj-table-body'].innerHTML).not.toContain('PRJ-2026-888');
  });

  test('2.6 Caso 202610153 (Alejandra Ayala — GRADO 0): Alerta de requisitos faltantes sin atribuir problemas de permisos', async () => {
    const project202610153 = {
      id: '1792004940382',
      codigo: '202610153',
      proyecto: '4 METROS',
      clientId: 'c-grado0',
      vendedorId: 'ALEJANDRA-AYALA',
      createdBy: 'ALEJANDRA-AYALA',
      encargado: 'Alejandra Ayala',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 185.48,
      tipo_proyecto: 'Fabricación',
      datos: {}
    };

    const clientGrado0 = {
      id: 'c-grado0',
      empresa: 'GRADO 0 S.A. DE C.V.',
      tipo: 'juridica',
      documentos: { dui: '02345678-9' }
    };

    appCore.setCurrentUser({ id: 'ALEJANDRA-AYALA', role: 'gestor', nombre: 'Alejandra Ayala' });
    appCore.setClients([clientGrado0]);
    appCore.setProspects([project202610153]);

    makeMockEl('closing-forma-pago', { value: '' });
    makeMockEl('closing-fac-anticipo', { value: '' });
    makeMockEl('closing-file-doc-firmado', { files: [] });
    makeMockEl('closing-file-doc-comprobante', { files: [] });

    await appCore.finalizeOpportunity('1792004940382');

    expect(global.alert).toHaveBeenCalled();
    const msg = global.alert.mock.calls[0][0];

    // Verifica que se señalan con transparencia los 4 recaudos pendientes
    expect(msg).toContain('Forma de pago pactada');
    expect(msg).toContain('Número de factura de anticipo');
    expect(msg).toContain('Oferta firmada por cliente');
    expect(msg).toContain('Copia de factura o comprobante de anticipo');

    // Verifica que NO se le imputa error de permisos ni requerimiento de gerencia
    expect(msg).not.toContain('permiso');
    expect(msg).not.toContain('autorización');
    expect(msg).not.toContain('gerencia');
    expect(msg).not.toContain('contrato');
  });
});
