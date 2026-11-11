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
const DashboardUI = require('../../modules/dashboard/dashboard_ui');
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
    'clients-table-body', 'cli-search', 'client-detail-content', 'clientDetailContent', 'clientForm',
    'dash-stagnant-table-body', 'dash-active-times-body', 'dash-stagnant-empty-box', 'dash-stagnant-table-wrapper', 'dash-stagnant-counter-badge',
    'dash-wip-stage-prospecto', 'dash-wip-stage-levantamiento', 'dash-wip-stage-cotizacion', 'dash-wip-stage-negociacion', 'dash-wip-stage-cierre',
    'metric-alertas-count', 'metric-alertas-sub'
  ].forEach(id => makeEl(id));

  elements['stage-title-text'].parentElement = makeEl('stage-title-parent');
  const mainContent = makeEl('main-content-container');
  const appContainer = makeEl('app-container-root');

  const doc = {
    scrollingElement: { scrollTop: 0 },
    documentElement: { scrollTop: 0 },
    body: { scrollTop: 0, classList: { add: () => {}, remove: () => {} } },
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeEl('', tag),
    querySelector: (sel) => {
      if (sel === '.view-section.active') return viewSections.find(v => v.classList.contains('active')) || null;
      if (sel === '.main-content') return mainContent;
      if (sel === '.app-container') return appContainer;
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
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts),
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

    // Verificar que al abrir el expediente el scroll se restablece automáticamente a 0 sin perder la posición guardada (420)
    expect(global.window.scrollY).toBe(0);
    expect(mainContent.scrollTop).toBe(0);
    expect(AppRouter.getLastListScrollY()).toBe(420);

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
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts)
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

    // Verificar que al abrir el expediente de cliente el scroll se restablece automáticamente a 0
    expect(global.window.scrollY).toBe(0);
    expect(mainContent.scrollTop).toBe(0);
    expect(AppRouter.getLastListScrollY()).toBe(310);

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

  test('1.4: Regresar desde oportunidad abierta en el dashboard, botón Atrás del navegador y ciclos repetidos sin errores ni pérdida de contexto', () => {
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

    const sampleProspects = [
      { id: 'OPP-DASH-1', codigo: '202605101', proyecto: 'Centro Logístico', clientId: 'CLI-1', vendedorId: 'USR-V1', etapa: 'cotizacion', clasificacion: 'ejecucion', estado: 'activo', precio_cotizado: 45000, fecha_creacion: '2026-04-01T10:00:00.000Z', stage_timestamps: { cotizacion: '2026-04-02T10:00:00.000Z' } },
      { id: 'OPP-DASH-2', codigo: '202605102', proyecto: 'Bodega Frigorífica', clientId: 'CLI-2', vendedorId: 'USR-V1', etapa: 'negociacion', clasificacion: 'presupuesto', estado: 'activo', precio_cotizado: 60000, fecha_creacion: '2026-05-02T10:00:00.000Z', stage_timestamps: { negociacion: '2026-05-05T10:00:00.000Z' } }
    ];
    const sampleClients = [
      { id: 'CLI-1', tipo: 'juridica', empresa: 'Logística Integral SA', contacto: 'Ing. Mario', nit: '0614-010190-101-1', telefono: '2200-1100', correo: 'info@log.com', documentos: { dui: '111' } },
      { id: 'CLI-2', tipo: 'juridica', empresa: 'Frigoríficos del Sur', contacto: 'Lic. Ana', nit: '0614-020290-102-2', telefono: '2200-2200', correo: 'info@frigo.com', documentos: { dui: '222' } }
    ];

    let listMode = 'pipeline';
    let dashRenderedCount = 0;

    const renderDashboardStub = () => {
      dashRenderedCount++;
      elements['dash-stagnant-table-body'].innerHTML = `<tr data-prospect-id="OPP-DASH-1"><td>202605101</td></tr>`;
    };

    AppRouter.initAppRouter({
      getDocument: () => doc,
      getWindow: () => global.window,
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getAppState: () => AppState,
      getCurrentListMode: () => listMode,
      setCurrentListMode: (m) => { listMode = m; },
      switchListMode: (m) => { listMode = m; OpportunitiesUI.renderList({ doc }); },
      renderDashboard: renderDashboardStub,
      renderList: () => OpportunitiesUI.renderList({ doc }),
      renderClientsTable: () => ClientsUI.renderClientsTable(),
      goBackFromDetail: (opts) => OpportunitiesUI.goBackFromDetail(opts),
      closeClientDetailView: (opts) => ClientsUI.closeClientDetailView(opts)
    });

    OpportunitiesController.initOpportunitiesController({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      renderList: () => OpportunitiesUI.renderList({ doc })
    });

    OpportunitiesUI.initOpportunitiesUI({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      getClients: () => sampleClients,
      getOppStatusFilter: () => OpportunitiesController.getOppStatusFilter(),
      getOppClasifFilter: () => OpportunitiesController.getOppClasifFilter(),
      getOppStageFilter: () => OpportunitiesController.getOppStageFilter(),
      getOppSortCol: () => OpportunitiesController.getOppSortCol(),
      getOppSortDir: () => OpportunitiesController.getOppSortDir(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts),
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection()
    });

    ClientsUI.initClientsModule({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getClients: () => sampleClients,
      getVisibleClients: () => sampleClients,
      getProspects: () => sampleProspects,
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts)
    });

    // A) Abrir oportunidad desde el Dashboard y regresar al Dashboard (no a list-view)
    AppRouter.showView('dashboard-view');
    global.window.scrollY = 580;
    mainContent.scrollTop = 580;

    OpportunitiesUI.openDetail('OPP-DASH-1');
    expect(elements['detail-view'].classList.contains('active')).toBe(true);
    expect(AppRouter.getLastViewedSection()).toBe('dashboard-view');

    expect(global.window.scrollY).toBe(0);
    expect(mainContent.scrollTop).toBe(0);
    expect(AppRouter.getLastListScrollY()).toBe(580);

    // Presionar Volver desde una oportunidad abierta en el dashboard
    OpportunitiesUI.goBackFromDetail();
    jest.runAllTimers();

    expect(elements['dashboard-view'].classList.contains('active')).toBe(true);
    expect(elements['list-view'].classList.contains('active')).toBe(false);
    expect(global.window.scrollY).toBe(580);
    expect(mainContent.scrollTop).toBe(580);
    const dashRow = doc.querySelector('[data-prospect-id="OPP-DASH-1"]');
    expect(dashRow).not.toBeNull();
    expect(dashRow.classList.contains('row-context-restored')).toBe(true);

    // B) Usar botón Atrás del navegador (popstate) desde una oportunidad abierta en list-view
    AppRouter.showView('list-view');
    OpportunitiesController.setOppClasifFilter('presupuesto');
    elements['opp-search'].value = 'Bodega';
    OpportunitiesUI.renderList({ doc });
    global.window.scrollY = 275;
    mainContent.scrollTop = 275;

    OpportunitiesUI.openDetail('OPP-DASH-2');
    expect(elements['detail-view'].classList.contains('active')).toBe(true);
    expect(global.window.scrollY).toBe(0);
    expect(mainContent.scrollTop).toBe(0);

    popstateHandler({ state: { crmView: 'list-view', listMode: 'pipeline' } });
    jest.runAllTimers();

    expect(elements['list-view'].classList.contains('active')).toBe(true);
    expect(OpportunitiesController.getOppClasifFilter()).toBe('presupuesto');
    expect(elements['opp-search'].value).toBe('Bodega');
    expect(global.window.scrollY).toBe(275);

    // C) Repetir la operación 5 ciclos consecutivos alternando Oportunidades, Clientes y Dashboard sin pérdida de contexto
    for (let cycle = 1; cycle <= 5; cycle++) {
      const scrollOpp = 150 + cycle * 40;
      AppRouter.showView('list-view');
      global.window.scrollY = scrollOpp;
      mainContent.scrollTop = scrollOpp;
      OpportunitiesUI.openDetail('OPP-DASH-2');
      expect(elements['detail-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      OpportunitiesUI.goBackFromDetail();
      jest.runAllTimers();
      expect(elements['list-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(scrollOpp);
      expect(OpportunitiesController.getOppClasifFilter()).toBe('presupuesto');
      expect(elements['opp-search'].value).toBe('Bodega');

      const scrollCli = 200 + cycle * 30;
      AppRouter.showView('clients-view');
      elements['cli-search'].value = 'Frigo';
      ClientsUI.renderClientsTable();
      global.window.scrollY = scrollCli;
      mainContent.scrollTop = scrollCli;
      ClientsUI.openClientDetailView('CLI-2');
      expect(elements['client-detail-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      ClientsUI.closeClientDetailView();
      jest.runAllTimers();
      expect(elements['clients-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(scrollCli);
      expect(elements['cli-search'].value).toBe('Frigo');
    }

    jest.useRealTimers();
  });

  test('1.5: Hotfix posición de scroll al abrir expedientes (8 escenarios obligatorios: parte superior, parte inferior, Volver, Clientes, Dashboard, popstate, ciclos repetidos y contenedores internos)', () => {
    jest.useFakeTimers();
    const { doc, elements, mainContent } = makeMockDom();
    global.document = doc;

    let winScrollY = 0;
    let popstateHandler = null;
    const consoleErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => { consoleErrors.push(args); };

    global.window = {
      scrollY: 0,
      pageYOffset: 0,
      innerHeight: 800,
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      scrollTo: (arg1, arg2) => {
        winScrollY = typeof arg1 === 'object' ? Number(arg1.top || 0) : Number(arg2 || 0);
        global.window.scrollY = winScrollY;
        global.window.pageYOffset = winScrollY;
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

    const sampleProspects = [
      { id: 'OPP-TOP', codigo: '202605201', proyecto: 'Torre Superior', clientId: 'CLI-A', vendedorId: 'USR-V1', etapa: 'cotizacion', clasificacion: 'ejecucion', estado: 'activo', precio_cotizado: 18000, fecha_creacion: '2026-05-01T10:00:00.000Z' },
      { id: 'OPP-BOTTOM', codigo: '202605299', proyecto: 'Complejo Sur Final', clientId: 'CLI-B', vendedorId: 'USR-V1', etapa: 'negociacion', clasificacion: 'presupuesto', estado: 'activo', precio_cotizado: 92000, fecha_creacion: '2026-05-03T10:00:00.000Z' }
    ];
    const sampleClients = [
      { id: 'CLI-A', tipo: 'juridica', empresa: 'Constructora Cumbre SA', contacto: 'Ing. Carlos', nit: '0614-111190-101-1', telefono: '2211-0000', correo: 'cumbre@test.com', documentos: { dui: '111' } },
      { id: 'CLI-B', tipo: 'juridica', empresa: 'Desarrollos del Valle SA', contacto: 'Arq. Elena', nit: '0614-222290-102-2', telefono: '2222-9999', correo: 'valle@test.com', documentos: { dui: '222' } }
    ];

    let listMode = 'pipeline';
    const renderDashboardStub = () => {
      elements['dash-stagnant-table-body'].innerHTML = `<tr data-prospect-id="OPP-BOTTOM"><td>202605299</td></tr>`;
    };

    AppRouter.initAppRouter({
      getDocument: () => doc,
      getWindow: () => global.window,
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getAppState: () => AppState,
      getCurrentListMode: () => listMode,
      setCurrentListMode: (m) => { listMode = m; },
      switchListMode: (m) => { listMode = m; OpportunitiesUI.renderList({ doc }); },
      renderDashboard: renderDashboardStub,
      renderList: () => OpportunitiesUI.renderList({ doc }),
      renderClientsTable: () => ClientsUI.renderClientsTable(),
      goBackFromDetail: (opts) => OpportunitiesUI.goBackFromDetail(opts),
      closeClientDetailView: (opts) => ClientsUI.closeClientDetailView(opts)
    });

    OpportunitiesController.initOpportunitiesController({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      renderList: () => OpportunitiesUI.renderList({ doc })
    });

    OpportunitiesUI.initOpportunitiesUI({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getProspects: () => sampleProspects,
      getClients: () => sampleClients,
      getOppStatusFilter: () => OpportunitiesController.getOppStatusFilter(),
      getOppClasifFilter: () => OpportunitiesController.getOppClasifFilter(),
      getOppStageFilter: () => OpportunitiesController.getOppStageFilter(),
      getOppSortCol: () => OpportunitiesController.getOppSortCol(),
      getOppSortDir: () => OpportunitiesController.getOppSortDir(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts),
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection()
    });

    ClientsUI.initClientsModule({
      getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
      getClients: () => sampleClients,
      getVisibleClients: () => sampleClients,
      getProspects: () => sampleProspects,
      showView: (v, opts) => AppRouter.showView(v, opts),
      getLastViewedSection: () => AppRouter.getLastViewedSection(),
      saveListScrollPosition: (opts) => AppRouter.saveListScrollPosition(opts),
      restoreListScrollPosition: (opts) => AppRouter.restoreListScrollPosition(opts),
      scrollDetailViewToTop: (viewId, opts) => AppRouter.scrollDetailViewToTop(viewId, opts)
    });

    try {
      // Escenario 1: Abrir oportunidad en la parte superior de la lista → expediente inicia arriba (scrollTop = 0)
      AppRouter.showView('list-view');
      OpportunitiesUI.renderList({ doc });
      global.window.scrollY = 0;
      mainContent.scrollTop = 0;
      OpportunitiesUI.openDetail('OPP-TOP');
      jest.runAllTimers();
      expect(elements['detail-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      expect(elements['detail-view'].scrollTop).toBe(0);
      OpportunitiesUI.goBackFromDetail();
      jest.runAllTimers();

      // Escenario 2: Abrir oportunidad al final de una lista larga → expediente inicia arriba (NO hereda scroll de tabla)
      global.window.scrollY = 1280;
      doc.scrollingElement.scrollTop = 1280;
      doc.documentElement.scrollTop = 1280;
      doc.body.scrollTop = 1280;
      mainContent.scrollTop = 1280;
      elements['detail-view'].scrollTop = 450;
      elements['logs-container'].scrollTop = 210;

      OpportunitiesUI.openDetail('OPP-BOTTOM');
      expect(elements['detail-view'].classList.contains('active')).toBe(true);
      // Debe iniciar inmediatamente en 0 en todos los contenedores posibles
      expect(global.window.scrollY).toBe(0);
      expect(doc.scrollingElement.scrollTop).toBe(0);
      expect(doc.documentElement.scrollTop).toBe(0);
      expect(doc.body.scrollTop).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      expect(elements['detail-view'].scrollTop).toBe(0);
      expect(elements['logs-container'].scrollTop).toBe(0);
      // Y debe conservar intacta la posición de la lista de origen (1280)
      expect(AppRouter.getLastListScrollY()).toBe(1280);
      expect(AppRouter.getLastMainContentScrollTop()).toBe(1280);

      // Incluso si el usuario se desplaza dentro del expediente y se re-renderiza el mismo expediente (ej. tras guardar bitácora),
      // no se sobrescribe la posición guardada de la lista de origen (1280)
      global.window.scrollY = 340;
      mainContent.scrollTop = 340;
      OpportunitiesUI.openDetail('OPP-BOTTOM');
      expect(AppRouter.getLastListScrollY()).toBe(1280);

      // Escenario 3: Presionar Volver → regresa exactamente al punto anterior de la lista (1280)
      OpportunitiesUI.goBackFromDetail();
      jest.runAllTimers();
      expect(elements['list-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(1280);
      expect(mainContent.scrollTop).toBe(1280);
      const oppBottomRow = doc.querySelector('[data-prospect-id="OPP-BOTTOM"]');
      expect(oppBottomRow).not.toBeNull();
      expect(oppBottomRow.classList.contains('row-context-restored')).toBe(true);

      // Escenario 4: Repetir con Clientes al final de la lista → expediente de cliente inicia arriba y Volver restaura scroll
      AppRouter.showView('clients-view');
      ClientsUI.renderClientsTable();
      global.window.scrollY = 940;
      doc.scrollingElement.scrollTop = 940;
      doc.documentElement.scrollTop = 940;
      mainContent.scrollTop = 940;
      elements['client-detail-view'].scrollTop = 380;
      elements['clientDetailContent'].scrollTop = 290;
      elements['clientForm'].scrollTop = 150;

      ClientsUI.openClientDetailView('CLI-B');
      expect(elements['client-detail-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(0);
      expect(doc.scrollingElement.scrollTop).toBe(0);
      expect(doc.documentElement.scrollTop).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      expect(elements['client-detail-view'].scrollTop).toBe(0);
      expect(elements['clientDetailContent'].scrollTop).toBe(0);
      expect(elements['clientForm'].scrollTop).toBe(0);
      expect(AppRouter.getLastListScrollY()).toBe(940);

      ClientsUI.closeClientDetailView();
      jest.runAllTimers();
      expect(elements['clients-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(940);
      expect(mainContent.scrollTop).toBe(940);

      // Escenario 5: Abrir expediente desde el Dashboard desplazado hacia abajo → expediente inicia arriba y Volver regresa al Dashboard en su posición
      AppRouter.showView('dashboard-view');
      global.window.scrollY = 670;
      mainContent.scrollTop = 670;
      OpportunitiesUI.openDetail('OPP-BOTTOM');
      expect(elements['detail-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      expect(AppRouter.getLastListScrollY()).toBe(670);

      OpportunitiesUI.goBackFromDetail();
      jest.runAllTimers();
      expect(elements['dashboard-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(670);
      expect(mainContent.scrollTop).toBe(670);

      // Escenario 6: Probar con botón Atrás del navegador (popstate) tanto en Oportunidades como en Clientes
      AppRouter.showView('list-view');
      global.window.scrollY = 815;
      mainContent.scrollTop = 815;
      OpportunitiesUI.openDetail('OPP-BOTTOM');
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      popstateHandler({ state: { crmView: 'list-view', listMode: 'pipeline' } });
      jest.runAllTimers();
      expect(elements['list-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(815);
      expect(mainContent.scrollTop).toBe(815);

      AppRouter.showView('clients-view');
      global.window.scrollY = 530;
      mainContent.scrollTop = 530;
      ClientsUI.openClientDetailView('CLI-A');
      expect(global.window.scrollY).toBe(0);
      expect(mainContent.scrollTop).toBe(0);
      popstateHandler({ state: { crmView: 'clients-view' } });
      jest.runAllTimers();
      expect(elements['clients-view'].classList.contains('active')).toBe(true);
      expect(global.window.scrollY).toBe(530);
      expect(mainContent.scrollTop).toBe(530);

      // Escenario 7: Repetir varios ciclos seguidos sin saltos raros (incluyendo transición rápida antes de que expiren timers previos)
      for (let i = 1; i <= 4; i++) {
        const targetScroll = 300 + i * 110;
        AppRouter.showView('list-view');
        global.window.scrollY = targetScroll;
        mainContent.scrollTop = targetScroll;

        OpportunitiesUI.openDetail('OPP-BOTTOM');
        // Verificar inmediatamente y también después de timers diferidos (rAF / setTimeout) que el expediente sigue en 0
        expect(global.window.scrollY).toBe(0);
        expect(mainContent.scrollTop).toBe(0);
        jest.runAllTimers();
        expect(global.window.scrollY).toBe(0);
        expect(mainContent.scrollTop).toBe(0);

        OpportunitiesUI.goBackFromDetail();
        jest.runAllTimers();
        expect(global.window.scrollY).toBe(targetScroll);
        expect(mainContent.scrollTop).toBe(targetScroll);
      }

      // Escenario 8: Confirmar ausencia total de errores en consola
      expect(consoleErrors).toHaveLength(0);
    } finally {
      console.error = origConsoleError;
      jest.useRealTimers();
    }
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

  test('2.5: Compatibilidad con presupuestos históricos que YA se encontraban en Negociación antes del cambio (sin sla_pausado_en ni migración previa)', async () => {
    const env = makeBackendEnv(new Date('2026-10-15T14:00:00.000Z'));
    const { fdb, wf, commercial, caller } = env;
    const seller = caller('vendedor', 'USR-V1', 'Alejandra Ayala');

    // Oportunidad histórica creada en febrero y que entró a Negociación el 16 de febrero de 2026 ANTES del cambio
    // (no tiene sla_pausado_en, ni sla_estado, ni seguimiento.cadencia.sla_pausado persistidos en Firestore)
    const legacyBudgetInNeg = {
      id: 'OPP-LEGACY-BUDGET-01',
      codigo: '202602008',
      proyecto: 'Planta Solar Fase II (Presupuesto Histórico)',
      clientId: 'C-PRES',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'presupuesto',
      fecha_creacion: '2026-02-02T09:00:00.000Z',
      stage_timestamps: {
        prospecto: '2026-02-02T09:00:00.000Z',
        levantamiento: '2026-02-04T09:00:00.000Z',
        cotizacion: '2026-02-09T09:00:00.000Z',
        negociacion: '2026-02-16T09:00:00.000Z'
      },
      tiempos_etapas_acumulados: {
        prospecto: 2,
        levantamiento: 3,
        cotizacion: 5
      },
      logs: [
        { date: '2026-02-16T09:00:00.000Z', text: 'Avanzó a Negociación con oferta presupuestaria' }
      ]
    };

    const evalNow = new Date('2026-10-15T14:00:00.000Z'); // 8 meses después

    // 1. Es reconocida automáticamente como presupuesto con SLA pausado sin necesidad de avanzar, retroceder ni reclasificar
    const sla = CrmFollowUpCalc.calculateStageSla(legacyBudgetInNeg, evalNow);
    expect(sla.slaPaused).toBe(true);
    expect(sla.estadoSla).toBe('pausado_presupuesto');
    expect(sla.isOverdue).toBe(false);
    // No acumula como tiempo operativo la espera presupuestaria histórica (elapsedBusinessDays === 0)
    expect(sla.elapsedBusinessDays).toBe(0);
    // Conserva intactos los tiempos anteriores (2 + 3 + 5 = 10 días hábiles operativos)
    expect(sla.tiempoOperativoAcumuladoDias).toBe(10);
    expect(sla.tiempoOperativoDias).toBe(10);
    // Conserva la antigüedad calendario total (255 días) y la espera presupuestaria histórica (241 días desde el 16 de febrero)
    expect(sla.tiempoEsperaPresupuestoDias).toBe(241);
    expect(sla.antiguedadTotalDias).toBe(255);

    // 2. No requiere ninguna acción artificial para quedar al día en Agenda, Atención del Gerente ni WIP del Dashboard
    const followUp = CrmFollowUpCalc.classifyFollowUp(legacyBudgetInNeg, evalNow);
    expect(followUp.status).toBe('al_dia');
    expect(followUp.inAgenda).toBe(false);

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([legacyBudgetInNeg], null, {
      filterStatus: 'pendientes',
      now: evalNow
    });
    expect(attention.items).toHaveLength(0);
    expect(attention.counts.totalPending).toBe(0);

    const wip = CrmDashboardCalc.calculateActiveWipTimes([legacyBudgetInNeg], null, evalNow);
    expect(wip.totalOverLimit).toBe(0);
    expect(wip.allItems[0].isOverLimit).toBe(false);
    expect(wip.allItems[0].slaPaused).toBe(true);

    // 3. Si ese presupuesto histórico posteriormente se reactiva a Ejecución o se revierte, tampoco contamina tiempos_etapas_acumulados.negociacion
    await fdb.seed('prospects_prod/OPP-LEGACY-BUDGET-01', legacyBudgetInNeg);
    const recRes = await commercial.reclassifyProspect({
      caller: seller,
      prospectId: 'OPP-LEGACY-BUDGET-01',
      clasificacion: 'ejecucion',
      motivo: 'Cliente histórico obtuvo financiamiento y reactiva proyecto para ejecución',
      opId: 'op_legacy_budget_react_01'
    });
    expect(recRes.status).toBe('reclassified');
    expect(recRes.tiempo_espera_presupuesto_acumulado_dias).toBe(241);

    const afterReact = await fdb.data('prospects_prod/OPP-LEGACY-BUDGET-01');
    expect(afterReact.tiempos_etapas_acumulados).toEqual({
      prospecto: 2,
      levantamiento: 3,
      cotizacion: 5
    });
    expect(afterReact.tiempo_espera_presupuesto_acumulado_dias).toBe(241);
    expect(afterReact.logs.length).toBeGreaterThanOrEqual(2); // Conserva bitácora original + auditoría de reclasificación
  });

  test('2.6: Reclasificación de Ejecución a Presupuesto cuando la oportunidad YA está en Negociación activa la pausa correctamente y preserva los días operativos previos', async () => {
    const env = makeBackendEnv(new Date('2026-06-05T15:00:00.000Z')); // Viernes 5 de junio de 2026
    const { fdb, commercial, caller } = env;
    const seller = caller('vendedor', 'USR-V1', 'Alejandra Ayala');

    // Oportunidad de Ejecución que entró a Negociación el lunes 1 de junio (4 días hábiles transcurridos en Negociación)
    await fdb.seed('prospects_prod/OPP-EJEC-TO-PRESUP', {
      id: 'OPP-EJEC-TO-PRESUP',
      codigo: '202606001',
      proyecto: 'Ampliación Planta Farmacéutica',
      clientId: 'C-PRES',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'ejecucion',
      fecha_creacion: '2026-05-25T09:00:00.000Z',
      stage_timestamps: {
        prospecto: '2026-05-25T09:00:00.000Z',
        levantamiento: '2026-05-26T09:00:00.000Z',
        cotizacion: '2026-05-28T09:00:00.000Z',
        negociacion: '2026-06-01T15:00:00.000Z'
      },
      tiempos_etapas_acumulados: {
        prospecto: 1,
        levantamiento: 2,
        cotizacion: 2
      },
      seguimiento: {
        proxima_accion: {
          fecha: '2026-06-08',
          tipo: 'llamada',
          descripcion: 'Llamada de seguimiento'
        }
      }
    });

    const recRes = await commercial.reclassifyProspect({
      caller: seller,
      prospectId: 'OPP-EJEC-TO-PRESUP',
      clasificacion: 'presupuesto',
      motivo: 'El cliente pospuso la ejecución para el presupuesto de inversión del próximo trimestre',
      opId: 'op_reclass_ejec_to_presup_01'
    });

    expect(recRes.status).toBe('reclassified');
    expect(recRes.clasificacion).toBe('presupuesto');
    expect(recRes.sla_estado).toBe('pausado_presupuesto');

    const updated = await fdb.data('prospects_prod/OPP-EJEC-TO-PRESUP');
    expect(updated.clasificacion).toBe('presupuesto');
    expect(updated.sla_estado).toBe('pausado_presupuesto');
    expect(updated.sla_pausado_en).toBe('2026-06-05T15:00:00.000Z');
    expect(updated.sla_pausado_etapa).toBe('negociacion');
    expect(updated.seguimiento.proxima_accion).toBeNull();
    expect(updated.seguimiento.cadencia.sla_pausado).toBe(true);
    // Capturó los 4 días hábiles operativos transcurridos en Negociación antes de pausar
    expect(updated.tiempos_etapas_acumulados.negociacion).toBe(4);

    // 90 días después (3 de septiembre de 2026), el tiempo operativo sigue en 9d (1+2+2+4) y la espera presupuestaria es de 90d
    const later = new Date('2026-09-03T15:00:00.000Z');
    const sla = CrmFollowUpCalc.calculateStageSla(updated, later);
    expect(sla.slaPaused).toBe(true);
    expect(sla.estadoSla).toBe('pausado_presupuesto');
    expect(sla.isOverdue).toBe(false);
    expect(sla.elapsedBusinessDays).toBe(0);
    expect(sla.tiempoOperativoAcumuladoDias).toBe(9);
    expect(sla.tiempoOperativoDias).toBe(9);
    expect(sla.tiempoEsperaPresupuestoDias).toBe(90);
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

  test('3.3: Umbral de 45 días hábiles (permanencia_pipeline) descuenta espera presupuestaria, no se presenta como incumplimiento operativo del vendedor y mantiene consistencia en el Dashboard', () => {
    const evalNow = new Date('2026-11-10T15:00:00.000Z');

    // A) Oportunidad reactivada que tiene > 100 días de antigüedad total, pero 90 días fueron espera presupuestaria legítima
    const oppReactivadaSinAbandono = {
      id: 'OPP-REACT-CLEAN',
      codigo: '202605088',
      proyecto: 'Centro Comercial Fase III',
      clientId: 'CLI-88',
      vendedorId: 'USR-ALEJANDRA',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'ejecucion',
      fecha_creacion: '2026-06-01T10:00:00.000Z',
      tiempo_espera_presupuesto_acumulado_dias: 150, // ~105 días hábiles de espera presupuestaria previa
      stage_timestamps: {
        negociacion: '2026-11-02T10:00:00.000Z'
      }
    };

    const attClean = CrmFollowUpCalc.calculateManagerAttentionItems([oppReactivadaSinAbandono], null, {
      filterStatus: 'pendientes',
      now: evalNow
    });
    expect(attClean.items).toHaveLength(0);

    // B) Oportunidad de Ejecución en Negociación abandonada sin seguimiento vigente y > 45 días hábiles operativos
    const oppAntiguedadProlongada = {
      id: 'OPP-LONG-AGE',
      codigo: '202607044',
      proyecto: 'Complejo Industrial Sin Seguimiento',
      clientId: 'CLI-44',
      vendedor: 'Alejandra Ayala',
      vendedorId: 'USR-ALEJANDRA',
      estado: 'activo',
      etapa: 'negociacion',
      clasificacion: 'ejecucion',
      fecha_creacion: '2026-07-01T10:00:00.000Z',
      stage_timestamps: {
        negociacion: '2026-07-10T10:00:00.000Z'
      }
    };

    const attAge = CrmFollowUpCalc.calculateManagerAttentionItems([oppAntiguedadProlongada], null, {
      filterStatus: 'pendientes',
      now: evalNow
    });
    expect(attAge.items).toHaveLength(1);
    const ageMotivo = attAge.items[0].motivoObjects.find(m => m.tipo === 'permanencia_pipeline');
    expect(ageMotivo).toBeDefined();
    expect(ageMotivo.esIncumplimientoOperativo).toBe(false);
    expect(ageMotivo.categoria).toBe('antiguedad_pipeline');
    expect(ageMotivo.descripcion).toContain('Antigüedad prolongada en pipeline sin cierre');

    // C) Verificar consistencia visual del Dashboard (renderDashboardActiveTimes):
    //    permanencia_pipeline se muestra con badge azul "🗓️ Antigüedad Pipeline" (y NO como "⏰ Límite Etapa")
    const { doc, elements } = makeMockDom();
    const origDoc = global.document;
    global.document = doc;
    try {
      DashboardUI.setDeps({
        getDocument: () => doc,
        getCurrentUser: () => ({ id: 'USR-MGR', role: 'manager' }),
        getProspects: () => [caso017, oppAntiguedadProlongada],
        getUsers: () => [],
        getCrmDashboardCalc: () => CrmDashboardCalc,
        getCrmFollowUpCalc: () => CrmFollowUpCalc,
        getClientName: () => 'Inversiones Industriales'
      });

      const wipData = CrmDashboardCalc.calculateActiveWipTimes([caso017, oppAntiguedadProlongada], null, evalNow);
      DashboardUI.renderDashboardActiveTimes(wipData.allItems);

      expect(elements['dash-stagnant-counter-badge'].textContent).toBe('1 pendiente');
      expect(elements['dash-active-times-body'].innerHTML).toContain('Antigüedad Pipeline');
      expect(elements['dash-active-times-body'].innerHTML).not.toContain('Límite Etapa');
      expect(elements['dash-active-times-body'].innerHTML).not.toContain('CASA 725');
    } finally {
      global.document = origDoc;
    }
  });
});

