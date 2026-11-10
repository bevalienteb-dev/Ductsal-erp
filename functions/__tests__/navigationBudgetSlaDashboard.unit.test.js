// functions/__tests__/navigationBudgetSlaDashboard.unit.test.js
// Suite integral de pruebas automatizadas para:
// - BLOQUE 1: Botón Volver, preservación de contexto (filtros, búsqueda, orden, paginación, scroll, fila) y botón Atrás (popstate).
// - BLOQUE 2: SLA de proyectos clasificados como Presupuesto (avance hasta Negociación, detención de SLA, separación de tiempos, reactivación y reversión).
// - BLOQUE 3: Unificación de fuente de verdad del SLA en Dashboard y reproducción exacta del caso 0-17.

const CrmWorkCalendar = require('../../crm_work_calendar');
const CrmFollowUpCalc = require('../../crm_followup_calc');
const CrmDashboardCalc = require('../../crm_dashboard_calc');
const AppState = require('../../core/app_state');
const AppRouter = require('../../core/app_router');
const OpportunitiesController = require('../../modules/opportunities/opportunities_controller');
const OpportunitiesUI = require('../../modules/opportunities/opportunities_ui');
const ClientsUI = require('../../modules/clients/clients_ui');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

function makeBackendEnv(initialClock = new Date('2026-06-01T10:00:00.000Z')) {
  let currentClock = initialClock;
  const fdb = createFakeFirestore({ clock: () => currentClock });
  const commercial = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => currentClock,
    verifyManager: async () => true
  });
  const wf = createProspectWorkflowService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    kit: commercial.kit
  });
  const caller = (role, cid = 'USR-V1', name = 'Alejandra Ayala') => ({
    uid: `uid_${cid}`,
    cid,
    name,
    role
  });
  return {
    fdb,
    commercial,
    wf,
    caller,
    getClock: () => currentClock,
    setClock: (newDate) => { currentClock = newDate instanceof Date ? newDate : new Date(newDate); }
  };
}

// Simulador ligero de DOM para verificar navegación, tablas, filtros, scroll y History API
function makeMockDom() {
  const elements = {};
  const viewSections = [];
  const navItems = [];
  const rowsByAttr = {};

  function makeEl(id, tag = 'div') {
    const classSet = new Set();
    const attrs = {};
    const children = [];
    let _innerHtml = '';
    const el = {
      id,
      tagName: tag.toUpperCase(),
      style: { display: '' },
      value: '',
      textContent: '',
      get innerHTML() { return _innerHtml; },
      set innerHTML(val) {
        _innerHtml = String(val || '');
        const regex = /data-(client|prospect)-id="([^"]+)"/g;
        let match;
        while ((match = regex.exec(_innerHtml)) !== null) {
          const attrKey = `data-${match[1]}-id="${match[2]}"`;
          if (!rowsByAttr[attrKey]) {
            const tr = makeEl('', 'tr');
            tr.setAttribute(`data-${match[1]}-id`, match[2]);
          }
        }
      },
      scrollTop: 0,
      children,
      classList: {
        add: (...cls) => cls.forEach(c => classSet.add(c)),
        remove: (...cls) => cls.forEach(c => classSet.delete(c)),
        contains: (c) => classSet.has(c)
      },
      setAttribute: (k, v) => {
        attrs[k] = String(v);
        if (k === 'data-prospect-id' || k === 'data-client-id') {
          rowsByAttr[`${k}="${v}"`] = el;
        }
      },
      getAttribute: (k) => attrs[k] !== undefined ? attrs[k] : null,
      removeAttribute: (k) => { delete attrs[k]; },
      appendChild: (child) => { children.push(child); return child; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 240, bottom: 288, height: 48 }),
      scrollIntoViewCalls: 0,
      scrollIntoView: function () { this.scrollIntoViewCalls++; }
    };
    if (id) elements[id] = el;
    return el;
  }

  ['dashboard-view', 'list-view', 'clients-view', 'projects-view', 'users-view', 'detail-view', 'client-detail-view'].forEach(id => {
    const v = makeEl(id, 'section');
    v.classList.add('view-section');
    viewSections.push(v);
  });
  elements['list-view'].classList.add('active');

  ['nav-dashboard', 'nav-list', 'nav-clients', 'nav-projects', 'nav-users'].forEach(id => {
    const li = makeEl(id, 'li');
    navItems.push(li);
  });

  [
    'opp-table-body', 'opp-search', 'opp-date-start', 'opp-date-end', 'btn-clear-opp-dates', 'opp-count-badge',
    'count-opp-activas', 'count-opp-perdidas', 'count-opp-todas',
    'filter-opp-activas', 'filter-opp-perdidas', 'filter-opp-todas',
    'count-opp-ejecucion', 'count-opp-presupuesto',
    'filter-clasif-todas', 'filter-clasif-ejecucion', 'filter-clasif-presupuesto',
    'count-stage-todas', 'count-stage-prospecto', 'count-stage-levantamiento', 'count-stage-cotizacion', 'count-stage-negociacion', 'count-stage-cierre',
    'filter-stage-todas', 'filter-stage-prospecto', 'filter-stage-levantamiento', 'filter-stage-cotizacion', 'filter-stage-negociacion', 'filter-stage-cierre',
    'detail-cliente', 'detail-proyecto', 'sticky-detail-client', 'sticky-detail-code', 'detail-mobile-sticky-bar',
    'mobile-header-default', 'advance-form-container', 'new-log-text', 'payment-form', 'invoice-form',
    'btn-delete-prospect', 'btn-reactivate-prospect', 'action-buttons-container', 'financial-tracker-container',
    'stage-title-text', 'stage-workflow-box', 'stage-tracker', 'btn-advance', 'btn-revert', 'btn-new-proposal', 'btn-lose',
    'detail-time-in-stage', 'detail-last-contact', 'detail-badges', 'info-list', 'docs-list', 'docs-count-badge',
    'logs-container', 'detail-followup-badge', 'detail-followup-summary',
    'clients-table-body', 'cli-search', 'client-detail-content'
  ].forEach(id => makeEl(id));

  elements['stage-title-text'].parentElement = makeEl('stage-title-parent');
  const mainContent = makeEl('main-content-container');

  const doc = {
    documentElement: { scrollTop: 0 },
    body: { scrollTop: 0, classList: { add: () => {}, remove: () => {} } },
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeEl('', tag),
    querySelector: (sel) => {
      if (sel === '.view-section.active') return viewSections.find(v => v.classList.contains('active')) || null;
      if (sel === '.main-content') return mainContent;
      const m = sel.match(/\[(data-(?:prospect|client)-id="[^"]+")\]/);
      if (m && rowsByAttr[m[1]]) return rowsByAttr[m[1]];
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '.view-section') return viewSections;
      if (sel === '.nav-links li') return navItems;
      if (sel === '.row-context-restored') return Object.values(rowsByAttr).filter(r => r.classList.contains('row-context-restored'));
      return [];
    }
  };

  return { doc, elements, mainContent, rowsByAttr, viewSections };
}

describe('BLOQUE 1 — Botón Volver, preservación de contexto y navegación', () => {
  let origDocument;
  let origWindow;

  beforeEach(() => {
    origDocument = global.document;
    origWindow = global.window;
    AppState.resetAll();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.document = origDocument;
    global.window = origWindow;
  });

  test('1.1: AppState.subscribe("navigation:view") no corrompe lastViewedSection con el objeto { current, previous } ni al abrir detail-view', () => {
    const { doc } = makeMockDom();
    global.document = doc;

    let lastViewedSection = 'list-view';
    // Simular la suscripción reparada en app_core.js
    const unsub = AppState.subscribe('navigation:view', (v) => {
      const targetView = (v && typeof v === 'object' && typeof v.current === 'string') ? v.current : v;
      if (typeof targetView === 'string' && targetView && targetView !== 'detail-view' && targetView !== 'client-detail-view' && !targetView.startsWith('b3-')) {
        lastViewedSection = targetView;
      }
    });

    AppRouter.initAppRouter({
      getDocument: () => doc,
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getAppState: () => AppState
    });

    AppRouter.showView('list-view');
    expect(typeof lastViewedSection).toBe('string');
    expect(lastViewedSection).toBe('list-view');

    // Al abrir detail-view, lastViewedSection debe conservar 'list-view' (string) y nunca convertirse en objeto ni en 'detail-view'
    AppRouter.showView('detail-view');
    expect(typeof lastViewedSection).toBe('string');
    expect(lastViewedSection).toBe('list-view');
    expect(AppRouter.getLastViewedSection()).toBe('list-view');

    unsub();
  });

  test('1.2: Abrir oportunidad desde tabla filtrada y presionar Volver restaura vista, filtros, búsqueda, orden, scroll y fila', () => {
    jest.useFakeTimers();
    const { doc, elements, mainContent } = makeMockDom();
    global.document = doc;

    let winScrollY = 0;
    const historyStack = [];
    let popstateHandler = null;

    global.window = {
      scrollY: 0,
      pageYOffset: 0,
      innerHeight: 800,
      scrollTo: (arg1, arg2) => {
        winScrollY = typeof arg1 === 'object' ? arg1.top : arg2;
        global.window.scrollY = winScrollY;
      },
      history: {
        state: null,
        pushState: (st) => { historyStack.push(st); global.window.history.state = st; },
        replaceState: (st) => { global.window.history.state = st; }
      },
      addEventListener: (evt, fn) => {
        if (evt === 'popstate') popstateHandler = fn;
      }
    };

    const sampleProspects = [
      { id: 'OPP-101', codigo: '202605001', proyecto: 'Edificio Norte', clientId: 'CLI-1', vendedorId: 'USR-V1', etapa: 'negociacion', clasificacion: 'presupuesto', estado: 'activo', precio_cotizado: 15000, fecha_creacion: '2026-05-01T10:00:00.000Z' },
      { id: 'OPP-102', codigo: '202605002', proyecto: 'Torre Sur', clientId: 'CLI-2', vendedorId: 'USR-V1', etapa: 'negociacion', clasificacion: 'presupuesto', estado: 'activo', precio_cotizado: 28000, fecha_creacion: '2026-05-02T10:00:00.000Z' }
    ];

    let listMode = 'pipeline';
    AppRouter.initAppRouter({
      getDocument: () => doc,
      getWindow: () => global.window,
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getAppState: () => AppState,
      getCurrentListMode: () => listMode,
      setCurrentListMode: (m) => { listMode = m; },
      switchListMode: (m) => { listMode = m; OpportunitiesUI.renderList({ doc }); },
      renderList: () => OpportunitiesUI.renderList({ doc }),
      goBackFromDetail: (opts) => OpportunitiesUI.goBackFromDetail(opts)
    });

    OpportunitiesController.initOpportunitiesController({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      renderList: () => OpportunitiesUI.renderList({ doc })
    });

    OpportunitiesUI.initOpportunitiesUI({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      getClients: () => [{ id: 'CLI-1', empresa: 'Constructora Alfa' }, { id: 'CLI-2', empresa: 'Inmobiliaria Beta' }],
      getOppStatusFilter: () => OpportunitiesController.getOppStatusFilter(),
      getOppClasifFilter: () => OpportunitiesController.getOppClasifFilter(),
      getOppStageFilter: () => OpportunitiesController.getOppStageFilter(),
      getOppSortCol: () => OpportunitiesController.getOppSortCol(),
      getOppSortDir: () => OpportunitiesController.getOppSortDir(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection()
    });

    // 1. Situarse en Oportunidades (list-view) con filtros activos, búsqueda, orden y scroll
    AppRouter.showView('list-view');
    OpportunitiesController.setOppStatusFilter('activas');
    OpportunitiesController.setOppClasifFilter('presupuesto');
    OpportunitiesController.setOppStageFilter('negociacion');
    OpportunitiesController.setOppSort('monto', 'desc');
    elements['opp-search'].value = 'Torre';
    OpportunitiesUI.renderList({ doc });

    // Simular scroll vertical antes de abrir detalle
    global.window.scrollY = 420;
    mainContent.scrollTop = 420;

    // 2. Abrir detalle de OPP-102
    OpportunitiesUI.openDetail('OPP-102');
    expect(elements['detail-view'].classList.contains('active')).toBe(true);
    expect(AppRouter.getLastViewedSection()).toBe('list-view');

    // Simular que la vista de detalle alteró el scroll a 0
    global.window.scrollY = 0;
    mainContent.scrollTop = 0;

    // 3. Presionar botón Volver
    OpportunitiesUI.goBackFromDetail();
    jest.runAllTimers();

    // Verificar regreso a la tabla original (NO al dashboard)
    expect(elements['list-view'].classList.contains('active')).toBe(true);
    expect(elements['dashboard-view'].classList.contains('active')).toBe(false);

    // Verificar conservación de filtros, búsqueda y ordenamiento
    expect(OpportunitiesController.getOppStatusFilter()).toBe('activas');
    expect(OpportunitiesController.getOppClasifFilter()).toBe('presupuesto');
    expect(OpportunitiesController.getOppStageFilter()).toBe('negociacion');
    expect(OpportunitiesController.getOppSortCol()).toBe('monto');
    expect(OpportunitiesController.getOppSortDir()).toBe('desc');
    expect(elements['opp-search'].value).toBe('Torre');

    // Verificar restauración de posición de scroll y visibilidad de la fila abierta
    expect(global.window.scrollY).toBe(420);
    expect(mainContent.scrollTop).toBe(420);
    const restoredRow = doc.querySelector('[data-prospect-id="OPP-102"]');
    expect(restoredRow).not.toBeNull();
    expect(restoredRow.classList.contains('row-context-restored')).toBe(true);

    jest.useRealTimers();
  });

  test('1.3: Abrir cliente desde tabla con búsqueda y scroll y presionar Volver (o Atrás del navegador) conserva contexto', () => {
    jest.useFakeTimers();
    const { doc, elements, mainContent } = makeMockDom();
    global.document = doc;

    let winScrollY = 0;
    let popstateHandler = null;
    global.window = {
      scrollY: 0,
      pageYOffset: 0,
      innerHeight: 800,
      scrollTo: (arg1, arg2) => {
        winScrollY = typeof arg1 === 'object' ? arg1.top : arg2;
        global.window.scrollY = winScrollY;
      },
      history: {
        state: null,
        pushState: (st) => { global.window.history.state = st; },
        replaceState: (st) => { global.window.history.state = st; }
      },
      addEventListener: (evt, fn) => {
        if (evt === 'popstate') popstateHandler = fn;
      }
    };

    const sampleClients = [
      { id: 'CLI-10', tipo: 'juridica', empresa: 'CONSTRU-SERVICES SA DE CV', contacto: 'Ing. Roberto', nit: '0614-101090-101-1', telefono: '2222-1111', correo: 'info@constru.com', documentos: { dui: '123' } },
      { id: 'CLI-20', tipo: 'juridica', empresa: 'DESARROLLOS URBANOS', contacto: 'Arq. Silvia', nit: '0614-202090-102-2', telefono: '2222-3333', correo: 'info@urb.com', documentos: { dui: '456' } }
    ];

    ClientsUI.initClientsModule({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getClients: () => sampleClients,
      getVisibleClients: () => sampleClients,
      getProspects: () => [],
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts)
    });

    AppRouter.initAppRouter({
      getDocument: () => doc,
      getWindow: () => global.window,
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getAppState: () => AppState,
      renderClientsTable: () => ClientsUI.renderClientsTable(),
      closeClientDetailView: (opts) => ClientsUI.closeClientDetailView(opts)
    });

    // 1. Abrir vista de clientes, aplicar búsqueda, orden y scroll
    AppRouter.showView('clients-view');
    elements['cli-search'].value = 'CONSTRU';
    ClientsUI.setCliSort('nombre', 'asc');
    ClientsUI.renderClientsTable();

    global.window.scrollY = 310;
    mainContent.scrollTop = 310;

    // 2. Abrir expediente del cliente CLI-10
    ClientsUI.openClientDetailView('CLI-10');
    expect(elements['client-detail-view'].classList.contains('active')).toBe(true);
    expect(AppRouter.getLastViewedSection()).toBe('clients-view');

    global.window.scrollY = 0;
    mainContent.scrollTop = 0;

    // 3. Simular navegación con botón Atrás del navegador (popstate) o botón Volver
    expect(typeof popstateHandler).toBe('function');
    popstateHandler({ state: { crmView: 'clients-view' } });
    jest.runAllTimers();

    expect(elements['clients-view'].classList.contains('active')).toBe(true);
    expect(elements['cli-search'].value).toBe('CONSTRU');
    expect(ClientsUI.getCliSortCol()).toBe('nombre');
    expect(global.window.scrollY).toBe(310);
    expect(mainContent.scrollTop).toBe(310);
    const clientRow = doc.querySelector('[data-client-id="CLI-10"]');
    expect(clientRow).not.toBeNull();
    expect(clientRow.classList.contains('row-context-restored')).toBe(true);

    jest.useRealTimers();
  });
});

describe('BLOQUE 2 — SLA de proyectos clasificados como Presupuesto', () => {
  test('2.1: Proyecto Presupuesto avanza hasta Negociación, detiene su SLA operativo al entrar y no genera vencimientos tras meses de espera', async () => {
    const env = makeBackendEnv(new Date('2026-05-04T09:00:00.000Z')); // Lunes 4 de mayo de 2026
    const { fdb, wf, caller } = env;
    const seller = caller('vendedor', 'USR-V1', 'Alejandra Ayala');

    await fdb.seed('clients_prod/C-PRES', {
      id: 'C-PRES',
      tipo: 'juridica',
      empresa: 'Inversiones Futuras SA',
      documentos: { dui: '01234567-8' }
    });

    // Oportunidad creada el 4 de mayo, avanzó por prospecto (1d hábil) y levantamiento (2d hábiles), entra a cotización el 7 de mayo
    await fdb.seed('prospects_prod/OPP-BUDGET-01', {
      id: 'OPP-BUDGET-01',
      codigo: '202605010',
      proyecto: 'Torre Corporativa Fase Preliminar',
      clientId: 'C-PRES',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      tipo_proyecto: 'Fabricación',
      fecha_creacion: '2026-05-04T09:00:00.000Z',
      stage_timestamps: {
        prospecto: '2026-05-04T09:00:00.000Z',
        levantamiento: '2026-05-05T09:00:00.000Z',
        cotizacion: '2026-05-07T09:00:00.000Z'
      },
      tiempos_etapas_acumulados: {
        prospecto: 1,
        levantamiento: 2
      },
      datos: {
        doc_oferta: [{ name: 'presupuesto.pdf', storagePath: 'prod_files/proyectos/OPP-BUDGET-01/presupuesto.pdf' }],
        doc_costos: [{ name: 'costos.xlsx', storagePath: 'prod_files/proyectos/OPP-BUDGET-01/costos.xlsx' }]
      }
    });

    // El lunes 11 de mayo (2 días hábiles en cotización) avanza a Negociación
    env.setClock(new Date('2026-05-11T15:00:00.000Z'));
    const advRes = await wf.advanceStage({
      caller: seller,
      prospectId: 'OPP-BUDGET-01',
      nextStage: 'negociacion',
      data: {
        costo_venta: 42000,
        precio_cotizado: 65000,
        probabilidad: 'media'
      }
    });

    expect(advRes.status).toBe('advanced');
    expect(advRes.etapa).toBe('negociacion');

    const inNeg = await fdb.data('prospects_prod/OPP-BUDGET-01');
    expect(inNeg.etapa).toBe('negociacion');
    expect(inNeg.estado).toBe('activo');
    expect(inNeg.sla_estado).toBe('pausado_presupuesto');
    expect(inNeg.sla_pausado_en).toBe('2026-05-11T15:00:00.000Z');
    // Preservó el tiempo operativo acumulado anteriormente (1 + 2 + 2 = 5 días hábiles)
    expect(inNeg.tiempos_etapas_acumulados).toEqual({
      prospecto: 1,
      levantamiento: 2,
      cotizacion: 2
    });

    // Pasan 5 meses de espera presupuestaria (11 de octubre de 2026)
    const fiveMonthsLater = new Date('2026-10-11T15:00:00.000Z');
    const sla = CrmFollowUpCalc.calculateStageSla(inNeg, fiveMonthsLater);

    expect(sla.slaPaused).toBe(true);
    expect(sla.estadoSla).toBe('pausado_presupuesto');
    expect(sla.isOverdue).toBe(false);
    expect(sla.elapsedBusinessDays).toBe(0); // No incrementa tiempo operativo durante la espera
    expect(sla.tiempoOperativoAcumuladoDias).toBe(5);
    expect(sla.tiempoOperativoDias).toBe(5); // Conserva intactos los 5 días operativos previos
    expect(sla.tiempoEsperaPresupuestoDias).toBe(153); // 153 días calendario de espera presupuestaria
    expect(sla.antiguedadTotalDias).toBe(160); // 160 días calendario desde el 4 de mayo

    // No genera vencimiento en Agenda ni alerta en Atención del Gerente ni en WIP del Dashboard
    const followUp = CrmFollowUpCalc.classifyFollowUp(inNeg, fiveMonthsLater);
    expect(followUp.inAgenda).toBe(false);
    expect(followUp.status).toBe('al_dia');
    expect(followUp.isPresupuesto).toBe(true);

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([inNeg], null, { filterStatus: 'pendientes', now: fiveMonthsLater });
    expect(attention.items).toHaveLength(0);
    expect(attention.counts.totalPending).toBe(0);

    const wip = CrmDashboardCalc.calculateActiveWipTimes([inNeg], null, fiveMonthsLater);
    expect(wip.totalOverLimit).toBe(0);
    expect(wip.allItems[0].isOverLimit).toBe(false);
    expect(wip.allItems[0].slaPaused).toBe(true);
  });

  test('2.2: Reactivación de Presupuesto a proyecto comercial de Ejecución reanuda cómputos sin borrar historial', async () => {
    const env = makeBackendEnv(new Date('2026-05-11T15:00:00.000Z'));
    const { fdb, commercial, caller } = env;
    const seller = caller('vendedor', 'USR-V1', 'Alejandra Ayala');

    await fdb.seed('prospects_prod/OPP-BUDGET-REACT', {
      id: 'OPP-BUDGET-REACT',
      codigo: '202605011',
      proyecto: 'Hospital Privado Climatización',
      clientId: 'C-PRES',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'presupuesto',
      fecha_creacion: '2026-05-04T09:00:00.000Z',
      sla_pausado_en: '2026-05-11T15:00:00.000Z',
      sla_pausado_etapa: 'negociacion',
      sla_estado: 'pausado_presupuesto',
      stage_timestamps: {
        prospecto: '2026-05-04T09:00:00.000Z',
        levantamiento: '2026-05-05T09:00:00.000Z',
        cotizacion: '2026-05-07T09:00:00.000Z',
        negociacion: '2026-05-11T15:00:00.000Z'
      },
      tiempos_etapas_acumulados: {
        prospecto: 1,
        levantamiento: 2,
        cotizacion: 2
      }
    });

    // El cliente aprueba presupuesto 60 días calendario después (10 de julio de 2026) y se reactiva a Ejecución
    const reactivateDate = new Date('2026-07-10T15:00:00.000Z');
    env.setClock(reactivateDate);

    const recRes = await commercial.reclassifyProspect({
      caller: seller,
      prospectId: 'OPP-BUDGET-REACT',
      clasificacion: 'ejecucion',
      motivo: 'Junta directiva aprobó presupuesto y solicitó oferta final para ejecución inmediata',
      opId: 'op_reactivate_budget_01'
    });

    expect(recRes.status).toBe('reclassified');
    expect(recRes.clasificacion).toBe('ejecucion');
    expect(recRes.sla_estado).toBe('activo');
    expect(recRes.tiempo_espera_presupuesto_acumulado_dias).toBe(60);

    const reactivated = await fdb.data('prospects_prod/OPP-BUDGET-REACT');
    expect(reactivated.clasificacion).toBe('ejecucion');
    expect(reactivated.sla_pausado_en).toBeNull();
    expect(reactivated.sla_estado).toBe('activo');
    expect(reactivated.fecha_reactivacion_ejecucion).toBe('2026-07-10T15:00:00.000Z');
    expect(reactivated.fecha_entrada_negociacion_original).toBe('2026-05-11T15:00:00.000Z');
    expect(reactivated.tiempo_espera_presupuesto_acumulado_dias).toBe(60);
    expect(reactivated.seguimiento.proxima_accion.fecha).toBeDefined();

    // Evaluar SLA tras reactivación: conserva los 60d de espera histórica, los 5d operativos previos y está al día
    const slaAfter = CrmFollowUpCalc.calculateStageSla(reactivated, new Date('2026-07-13T15:00:00.000Z'));
    expect(slaAfter.slaPaused).toBe(false);
    expect(slaAfter.estadoSla).toBe('al_dia');
    expect(slaAfter.tiempoOperativoAcumuladoDias).toBe(5);
    expect(slaAfter.tiempoEsperaPresupuestoDias).toBe(60);
    expect(slaAfter.antiguedadTotalDias).toBe(70);
  });

  test('2.3: Reversión de etapa desde Negociación a Cotización en Presupuesto exige motivo, audita y NO suma espera al tiempo operativo', async () => {
    const env = makeBackendEnv(new Date('2026-05-11T15:00:00.000Z'));
    const { fdb, wf, caller } = env;
    const seller = caller('vendedor', 'USR-V1', 'Alejandra Ayala');

    await fdb.seed('prospects_prod/OPP-BUDGET-REV', {
      id: 'OPP-BUDGET-REV',
      codigo: '202605012',
      proyecto: 'Nave Industrial Zona Franca',
      clientId: 'C-PRES',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'presupuesto',
      fecha_creacion: '2026-05-04T09:00:00.000Z',
      sla_pausado_en: '2026-05-11T15:00:00.000Z',
      sla_pausado_etapa: 'negociacion',
      sla_estado: 'pausado_presupuesto',
      stage_timestamps: {
        cotizacion: '2026-05-07T09:00:00.000Z',
        negociacion: '2026-05-11T15:00:00.000Z'
      },
      tiempos_etapas_acumulados: {
        prospecto: 1,
        levantamiento: 2,
        cotizacion: 2
      }
    });

    // 30 días después (10 de junio) se revierte de Negociación a Cotización para recalcular ingeniería
    env.setClock(new Date('2026-06-10T15:00:00.000Z'));

    const revRes = await wf.revertStage({
      caller: seller,
      prospectId: 'OPP-BUDGET-REV',
      currentStage: 'negociacion',
      targetStage: 'cotizacion',
      motivo: 'El cliente rediseñó planos arquitectónicos y requiere recotizar capacidades',
      opId: 'op_rev_budget_01'
    });

    expect(revRes.status).toBe('reverted');
    expect(revRes.etapa).toBe('cotizacion');

    const reverted = await fdb.data('prospects_prod/OPP-BUDGET-REV');
    expect(reverted.etapa).toBe('cotizacion');
    expect(reverted.sla_pausado_en).toBeNull();
    expect(reverted.sla_estado).toBe('activo');
    // El tiempo de espera en Negociación (30 días) NO se sumó como tiempo operativo imputable a DUCTSAL
    expect(reverted.tiempos_etapas_acumulados.negociacion).toBe(0);
    // Se preservó en el acumulador de espera presupuestaria
    expect(reverted.tiempo_espera_presupuesto_acumulado_dias).toBe(30);
    // Y en Cotización el reloj operativo vuelve a correr desde la fecha de reversión
    const slaInCotiz = CrmFollowUpCalc.calculateStageSla(reverted, new Date('2026-06-12T15:00:00.000Z'));
    expect(slaInCotiz.slaPaused).toBe(false);
    expect(slaInCotiz.elapsedBusinessDays).toBe(2);
    expect(slaInCotiz.isOverdue).toBe(false);
  });

  test('2.4: Proyecto normal (Ejecución) conserva sus reglas vigentes y el cierre comercial de 5 días hábiles no se altera', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    const oppEjecucionCierreVencido = {
      id: 'OPP-EJEC-CIERRE',
      estado: 'activo',
      etapa: 'cierre',
      clasificacion: 'ejecucion',
      fecha_creacion: '2026-09-15T10:00:00.000Z',
      fecha_inicio_cierre: '2026-10-01T10:00:00.000Z'
    };

    const sla = CrmFollowUpCalc.calculateStageSla(oppEjecucionCierreVencido, now);
    expect(sla.slaPaused).toBe(false);
    expect(sla.limitBusinessDays).toBe(5);
    expect(sla.isOverdue).toBe(true);
    expect(sla.estadoSla).toBe('vencido');
  });
});

describe('BLOQUE 3 — Indicadores del Dashboard y caso concreto 0-17', () => {
  // Reproducción exacta del documento productivo 0-17 ("CASA 725", Alejandra Ayala)
  const caso017 = {
    id: 'OPP-1777081081370-17',
    codigo: '0-17',
    proyecto: 'CASA 725',
    clientId: 'CLI-CASA725',
    vendedor: 'Alejandra Ayala',
    vendedorId: 'USR-ALEJANDRA',
    createdBy: 'USR-ALEJANDRA',
    estado: 'activo',
    etapa: 'negociacion',
    clasificacion: 'ejecucion',
    precio_cotizado: 18500,
    costo_venta: 12400,
    probabilidad: 75,
    fecha_creacion: '2026-02-12T14:00:00.000Z',
    fecha_entrega_oferta: '2026-05-26T16:00:00.000Z',
    stage_timestamps: {
      prospecto: '2026-02-12T14:00:00.000Z',
      levantamiento: '2026-02-16T10:00:00.000Z',
      cotizacion: '2026-05-20T10:00:00.000Z',
      negociacion: '2026-05-26T16:00:00.000Z'
    },
    seguimiento: {
      cadencia: {
        tipo_cadencia: 'estandar',
        fecha_entrega_oferta: '2026-05-26T16:00:00.000Z',
        fecha_entrega_oferta_ymd: '2026-05-26',
        intentos_fallidos: 0,
        alerta_gerencial: false
      },
      ultimo_contacto: {
        fecha: '2026-10-30T15:20:00.000Z',
        canal: 'llamada',
        resultado: 'respondio_evaluando',
        detalle: 'Cliente evaluando propuesta con arquitecto, acordó seguimiento en noviembre'
      },
      proxima_accion: {
        fecha: '2026-11-20',
        tipo: 'llamada',
        descripcion: 'Seguimiento acordado con cliente'
      }
    }
  };

  test('3.1: Caso concreto 0-17 ("CASA 725") al día en Negociación NO aparece como vencida ni excedida en ficha, listado ni dashboard', () => {
    const evalNow = new Date('2026-11-10T15:00:00.000Z');

    // 1. Ficha de oportunidad (SLA + Seguimiento)
    const sla017 = CrmFollowUpCalc.calculateStageSla(caso017, evalNow);
    const followUp017 = CrmFollowUpCalc.classifyFollowUp(caso017, evalNow);

    expect(sla017.isOverdue).toBe(false);
    expect(sla017.estadoSla).toBe('al_dia');
    expect(sla017.antiguedadTotalDias).toBeGreaterThan(250); // Gran antigüedad calendario total
    expect(followUp017.status).toBe('al_dia'); // Pero operativamente al día
    expect(followUp017.inAgenda).toBe(false);

    // 2. Dashboard — Panel de Atención del Gerente (calculateManagerAttentionItems)
    const managerAttention = CrmFollowUpCalc.calculateManagerAttentionItems([caso017], null, {
      filterStatus: 'pendientes',
      now: evalNow
    });
    expect(managerAttention.items).toHaveLength(0);
    expect(managerAttention.counts.totalPending).toBe(0);
    expect(managerAttention.counts.estancamiento_pipeline || 0).toBe(0);
    expect(managerAttention.counts.limite_etapa || 0).toBe(0);

    // 3. Dashboard — Antigüedad WIP y Límites de Etapa (calculateActiveWipTimes)
    const wip = CrmDashboardCalc.calculateActiveWipTimes([caso017], null, evalNow);
    expect(wip.totalActive).toBe(1);
    expect(wip.totalOverLimit).toBe(0);
    expect(wip.overLimitItems).toHaveLength(0);
    expect(wip.allItems[0].id).toBe('OPP-1777081081370-17');
    expect(wip.allItems[0].isOverLimit).toBe(false);
    expect(wip.allItems[0].slaStatus).toBe('al_dia');
  });

  test('3.2: Coincidencia exacta entre ficha, listado/agenda y dashboard para oportunidad realmente vencida vs al día vs Presupuesto en Negociación', () => {
    const evalNow = new Date('2026-11-10T15:00:00.000Z');

    const oppRealmenteVencidaEnCotizacion = {
      id: 'OPP-OVERDUE-COT',
      codigo: '202610099',
      proyecto: 'Planta Industrial Vencida',
      clientId: 'CLI-99',
      vendedorId: 'USR-ALEJANDRA',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'ejecucion',
      fecha_creacion: '2026-10-15T10:00:00.000Z',
      stage_timestamps: {
        cotizacion: '2026-10-20T10:00:00.000Z' // > 5 días hábiles al 10 de noviembre
      },
      seguimiento: {
        proxima_accion: {
          fecha: '2026-10-27',
          tipo: 'interno',
          descripcion: 'Entregar propuesta técnica y comercial'
        }
      }
    };

    const oppPresupuestoEnNegociacion = {
      id: 'OPP-PRESUP-NEG',
      codigo: '202604050',
      proyecto: 'Presupuesto Licitación Pública',
      clientId: 'CLI-50',
      vendedorId: 'USR-ALEJANDRA',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'presupuesto',
      fecha_creacion: '2026-04-01T10:00:00.000Z',
      sla_pausado_en: '2026-04-10T10:00:00.000Z',
      sla_estado: 'pausado_presupuesto',
      stage_timestamps: {
        negociacion: '2026-04-10T10:00:00.000Z'
      }
    };

    const universe = [caso017, oppRealmenteVencidaEnCotizacion, oppPresupuestoEnNegociacion];

    // Evaluación en Ficha (calculateStageSla)
    expect(CrmFollowUpCalc.calculateStageSla(caso017, evalNow).isOverdue).toBe(false);
    expect(CrmFollowUpCalc.calculateStageSla(oppRealmenteVencidaEnCotizacion, evalNow).isOverdue).toBe(true);
    expect(CrmFollowUpCalc.calculateStageSla(oppPresupuestoEnNegociacion, evalNow).isOverdue).toBe(false);

    // Evaluación en Agenda Comercial (generateAgenda)
    const seller = { id: 'USR-ALEJANDRA', role: 'vendedor' };
    const agendaVencidas = CrmFollowUpCalc.generateAgenda(universe, seller, 'vencidas', evalNow);
    expect(agendaVencidas.items.map(i => i.id)).toEqual(['OPP-OVERDUE-COT']);

    // Evaluación en Dashboard — Atención del Gerente
    const attention = CrmFollowUpCalc.calculateManagerAttentionItems(universe, null, {
      filterStatus: 'pendientes',
      now: evalNow
    });
    expect(attention.items.map(i => i.id)).toEqual(['OPP-OVERDUE-COT']);

    // Evaluación en Dashboard — WIP OverLimit
    const wip = CrmDashboardCalc.calculateActiveWipTimes(universe, null, evalNow);
    expect(wip.overLimitItems.map(i => i.id)).toEqual(['OPP-OVERDUE-COT']);
  });
});

