// functions/__tests__/initialLoadAndRoleRouting.unit.test.js
/**
 * DUCTSAL ERP — Suite de Pruebas Unitarias de Enrutamiento Inicial por Rol y Reactividad
 *
 * Verifica las 9 reglas obligatorias de inicio, reactividad y control de acceso:
 * 1. Gerente inicia en Dashboard.
 * 2. Vendedor inicia en Agenda Diaria de Seguimiento.
 * 3. Gestor inicia en Agenda Diaria de Seguimiento.
 * 4. Administrador inicia en Gestión de Usuarios.
 * 5. La agenda muestra los datos sin navegación manual.
 * 6. El Dashboard muestra los datos sin navegación manual.
 * 7. Cambiar de pantalla manualmente funciona y las actualizaciones de Firestore no alteran esa selección.
 * 8. Cerrar sesión e iniciar con un usuario de otro rol selecciona la pantalla correcta.
 * 9. No se generan listeners duplicados ni se debilitan las autorizaciones.
 */

describe('DUCTSAL ERP — Regla Definitiva de Pantalla Inicial por Rol y Reactividad', () => {

  let domElements = {};
  let activeSectionId = null;

  function makeEl(id, extra = {}) {
    const el = {
      id,
      style: { display: '' },
      classList: {
        _classes: new Set(),
        add: jest.fn(function(c) {
          el.classList._classes.add(c);
          if (c === 'active' && extra.isViewSection) {
            activeSectionId = id;
          }
        }),
        remove: jest.fn(function(c) {
          el.classList._classes.delete(c);
          if (c === 'active' && extra.isViewSection && activeSectionId === id) {
            activeSectionId = null;
          }
        }),
        contains: jest.fn(function(c) {
          return el.classList._classes.has(c);
        })
      },
      tagName: extra.tagName || 'DIV',
      innerHTML: '',
      textContent: '',
      get outerHTML() {
        return `<${el.tagName}>${el.innerHTML}</${el.tagName}>`;
      },
      appendChild: jest.fn(function(child) {
        if (child) {
          el.innerHTML += (child.outerHTML || child.innerHTML || child.textContent || '');
        }
      }),
      getContext: jest.fn(() => ({})),
      addEventListener: jest.fn(),
      options: extra.options || [],
      value: extra.value || '',
      selectedIndex: extra.selectedIndex || 0,
      ...extra
    };
    domElements[id] = el;
    return el;
  }

  function getEl(id) {
    if (!domElements[id]) {
      domElements[id] = makeEl(id);
    }
    return domElements[id];
  }

  // Set up globals BEFORE loading app_core
  global.window = {
    location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
    _docStore: new Map()
  };

  const mockFirestore = {
    settings: () => {},
    collection: jest.fn((colName) => ({
      doc: jest.fn((docId) => ({
        onSnapshot: jest.fn(() => jest.fn()),
        get: async () => ({ exists: false, data: () => ({}) })
      })),
      onSnapshot: jest.fn(() => jest.fn()),
      where: jest.fn(() => ({
        onSnapshot: jest.fn(() => jest.fn())
      })),
      orderBy: jest.fn(() => ({
        limit: jest.fn(() => ({
          onSnapshot: jest.fn(() => jest.fn()),
          get: async () => ({ docs: [] })
        }))
      }))
    }))
  };

  global.firebase = {
    initializeApp: () => ({}),
    firestore: () => mockFirestore,
    storage: () => ({ ref: () => ({}) }),
    auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged: jest.fn() }),
    functions: () => ({
      httpsCallable: () => async () => ({ data: {} })
    })
  };

  global.db = mockFirestore;
  global.DB_SUFFIX = '_prod';

  // Mock Chart.js
  const mockChartInstance = { destroy: jest.fn(), update: jest.fn() };
  global.Chart = jest.fn(() => mockChartInstance);
  global.Chart.defaults = { color: '', font: {} };

  global.document = {
    getElementById: (id) => getEl(id),
    querySelector: (sel) => {
      if (sel === '.view-section.active') {
        return activeSectionId ? domElements[activeSectionId] : null;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '.view-section') {
        return ['list-view', 'dashboard-view', 'projects-view', 'clients-view', 'users-view', 'detail-view'].map(id => getEl(id));
      }
      if (sel === '.nav-links li') {
        return ['nav-list', 'nav-dashboard', 'nav-projects', 'nav-clients', 'nav-users', 'nav-settings'].map(id => getEl(id));
      }
      return [];
    },
    createElement: (tag) => makeEl(`dynamic_${Math.random().toString(36).substring(2, 7)}`, { tagName: tag.toUpperCase() }),
    addEventListener: jest.fn()
  };

  global.alert = jest.fn();
  global.confirm = jest.fn(() => true);
  global.localStorage = {
    getItem: jest.fn(() => null),
    setItem: jest.fn(),
    removeItem: jest.fn()
  };

  const CrmFollowUpCalc = require('../crm_followup_calc');
  global.CrmFollowUpCalc = CrmFollowUpCalc;
  global.window.CrmFollowUpCalc = CrmFollowUpCalc;

  const CrmDashboardCalc = require('../../crm_dashboard_calc');
  global.CrmDashboardCalc = CrmDashboardCalc;
  global.window.CrmDashboardCalc = CrmDashboardCalc;

  // Now require app_core
  const appCore = require('../../app_core');

  beforeEach(() => {
    domElements = {};
    activeSectionId = null;

    // View sections
    makeEl('list-view', { isViewSection: true });
    makeEl('dashboard-view', { isViewSection: true });
    makeEl('projects-view', { isViewSection: true });
    makeEl('clients-view', { isViewSection: true });
    makeEl('users-view', { isViewSection: true });
    makeEl('detail-view', { isViewSection: true });

    // Nav elements
    makeEl('nav-list');
    makeEl('nav-dashboard');
    makeEl('nav-projects');
    makeEl('nav-projects-text');
    makeEl('nav-clients');
    makeEl('nav-users');
    makeEl('nav-settings');
    makeEl('client-action-header');

    // UI elements
    makeEl('main-app');
    makeEl('login-screen');
    makeEl('setup-screen');
    makeEl('ui-user-name');
    makeEl('ui-user-role');
    makeEl('agenda-view-container');
    makeEl('pipeline-view-container');
    makeEl('tab-agenda-mode');
    makeEl('tab-pipeline-mode');
    makeEl('agenda-table-body');
    makeEl('agenda-empty-state');
    makeEl('agenda-table-wrapper');
    makeEl('agenda-badge-counter');
    makeEl('agenda-seller-filter-wrap');
    makeEl('agenda-seller-select', { options: [] });
    makeEl('filter-agenda-escaladas');
    makeEl('pipeline-table-body');
    makeEl('projects-table-body');
    makeEl('proj-table-body');
    makeEl('clients-table-body');
    makeEl('users-table-body');

    // Dashboard elements
    makeEl('dash-time-filter', { value: 'all', options: [{ text: 'Histórico Completo' }], selectedIndex: 0 });
    makeEl('dash-active-period-badge');
    makeEl('dash-last-updated');
    makeEl('metric-ganadas');
    makeEl('sub-metric-ganadas');
    makeEl('metric-margen');
    makeEl('sub-metric-margen');
    makeEl('kpi-active-total');
    makeEl('kpi-active-total-sub');

    appCore.setCurrentUser(null);
    appCore.setProspects([]);
    appCore.setClients([]);
    jest.clearAllMocks();
  });

  // =========================================================================
  // REGLAS OBLIGATORIAS 1 A 4: ENRUTAMIENTO INICIAL POR ROL
  // =========================================================================

  test('1. Gerente (manager): inicia en Dashboard (dashboard-view)', () => {
    appCore.setCurrentUser({ id: 'U-MGR', cid: 'U-MGR', role: 'manager', nombre: 'Gerente General', activo: true });
    appCore.setInitialRoleViewRouted(false);

    appCore.applyRolePermissions();

    expect(appCore.getInitialRoleViewRouted()).toBe(true);
    expect(activeSectionId).toBe('dashboard-view');
    expect(getEl('nav-dashboard').classList.add).toHaveBeenCalledWith('active');
  });

  test('2. Vendedor (vendedor): inicia en Agenda Diaria de Seguimiento (list-view en modo agenda con contenedor visible)', () => {
    appCore.setCurrentUser({ id: 'U-VEN', cid: 'U-VEN', role: 'vendedor', nombre: 'Carlos Vendedor', activo: true });
    appCore.setInitialRoleViewRouted(false);

    appCore.applyRolePermissions();

    expect(appCore.getInitialRoleViewRouted()).toBe(true);
    expect(activeSectionId).toBe('list-view');
    expect(getEl('nav-list').classList.add).toHaveBeenCalledWith('active');
    expect(appCore.getCurrentListMode()).toBe('agenda');
    expect(getEl('agenda-view-container').style.display).toBe('block');
    expect(getEl('pipeline-view-container').style.display).toBe('none');
  });

  test('3. Gestor (gestor): inicia en Agenda Diaria de Seguimiento (list-view en modo agenda con contenedor visible)', () => {
    appCore.setCurrentUser({ id: 'U-GES', cid: 'U-GES', role: 'gestor', nombre: 'Alejandra Ayala', activo: true });
    appCore.setInitialRoleViewRouted(false);

    appCore.applyRolePermissions();

    expect(appCore.getInitialRoleViewRouted()).toBe(true);
    expect(activeSectionId).toBe('list-view');
    expect(getEl('nav-list').classList.add).toHaveBeenCalledWith('active');
    expect(appCore.getCurrentListMode()).toBe('agenda');
    expect(getEl('agenda-view-container').style.display).toBe('block');
    expect(getEl('pipeline-view-container').style.display).toBe('none');
  });

  test('4. Administrador (admin): inicia en Gestión de Usuarios (users-view)', () => {
    appCore.setCurrentUser({ id: 'U-ADM', cid: 'U-ADM', role: 'admin', nombre: 'Admin TI', activo: true });
    appCore.setInitialRoleViewRouted(false);

    appCore.applyRolePermissions();

    expect(appCore.getInitialRoleViewRouted()).toBe(true);
    expect(activeSectionId).toBe('users-view');
    expect(getEl('nav-users').classList.add).toHaveBeenCalledWith('active');
  });

  // =========================================================================
  // REGLAS OBLIGATORIAS 5 Y 6: DATOS VISIBLES SIN NAVEGACIÓN MANUAL
  // =========================================================================

  test('5. La agenda muestra los datos sin navegación manual tras recibir snapshots de Firestore', () => {
    // Gestor entra a list-view en modo agenda
    appCore.setCurrentUser({ id: 'U-GES', cid: 'U-GES', role: 'gestor', nombre: 'Alejandra Ayala', activo: true });
    appCore.setInitialRoleViewRouted(false);
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('list-view');

    // Llegan datos de Firestore
    appCore.setProspects([
      {
        id: 'p-agenda-1',
        codigo: '202610153',
        proyecto: 'Sustitución de Ductos Planta Tintura',
        clientId: 'c-grado0',
        vendedorId: 'U-GES',
        createdBy: 'U-GES',
        etapa: 'cierre',
        estado: 'activo',
        clasificacion: 'ejecucion',
        precio_cotizado: 185.48,
        costo_venta: 120.00,
        fecha_creacion: '2026-07-01',
        fecha_inicio_cierre: '2026-07-03'
      }
    ]);
    appCore.setClients([{ id: 'c-grado0', empresa: 'GRADO 0 S.A. DE C.V.' }]);

    // Disparo reactivo del snapshot
    appCore.reRenderApp();

    // Comprobamos que la tabla de agenda se llenó inmediatamente sin requerir navegación manual
    const tbody = getEl('agenda-table-body');
    expect(tbody.innerHTML).toContain('202610153');
    expect(tbody.innerHTML).toContain('Sustitución de Ductos Planta Tintura');
  });

  test('6. El Dashboard muestra los datos sin navegación manual tras recibir snapshots de Firestore', () => {
    // Gerente entra a dashboard-view
    appCore.setCurrentUser({ id: 'U-MGR', cid: 'U-MGR', role: 'manager', nombre: 'Gerente General', activo: true });
    appCore.setInitialRoleViewRouted(false);
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('dashboard-view');

    // Llegan datos de operaciones ganadas a Firestore
    appCore.setProspects([
      {
        id: 'p-won-1',
        codigo: '202610099',
        proyecto: 'Montaje HVAC Industrial',
        clientId: 'c-ind',
        vendedorId: 'U-VEN',
        etapa: 'postcierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        precio_cotizado: 25000,
        costo_venta: 15000,
        fecha_creacion: '2026-09-01'
      }
    ]);

    // Disparo reactivo de Firestore
    appCore.reRenderApp();

    // Comprobamos que el KPI del Dashboard se actualizó automáticamente
    const metricGanadas = getEl('metric-ganadas');
    expect(metricGanadas.textContent).toBe('$25,000.00');
  });

  // =========================================================================
  // REGLAS OBLIGATORIAS 7 A 9: PRESERVACIÓN, LOGOUT Y AUSENCIA DE DUPLICADOS
  // =========================================================================

  test('7. Cambiar de pantalla manualmente funciona y las actualizaciones de Firestore no alteran esa selección', () => {
    appCore.setCurrentUser({ id: 'U-GES', cid: 'U-GES', role: 'gestor', nombre: 'Alejandra Ayala', activo: true });
    appCore.setInitialRoleViewRouted(false);
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('list-view');

    // El gestor navega manualmente a Proyectos y Cobros
    appCore.showView('projects-view');
    expect(activeSectionId).toBe('projects-view');

    // Llega una nueva actualización de Firestore o reevaluación de permisos
    appCore.setProspects([
      {
        id: 'p-proj-1',
        codigo: '202610202',
        proyecto: 'Instalación Central',
        clientId: 'c-ind',
        vendedorId: 'U-GES',
        etapa: 'postcierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        precio_cotizado: 12000,
        costo_venta: 7000
      }
    ]);
    appCore.applyRolePermissions();
    appCore.reRenderApp();

    // La vista activa DEBE seguir siendo projects-view, sin redirigir al usuario
    expect(activeSectionId).toBe('projects-view');
    expect(getEl('proj-table-body').innerHTML).toContain('202610202');
  });

  test('8. Cerrar sesión e iniciar con un usuario de otro rol selecciona la pantalla correcta', () => {
    // 1. Inicia sesión como Gerente -> enruta a Dashboard
    appCore.setCurrentUser({ id: 'U-MGR', cid: 'U-MGR', role: 'manager', nombre: 'Gerente' });
    appCore.setInitialRoleViewRouted(false);
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('dashboard-view');
    expect(appCore.getInitialRoleViewRouted()).toBe(true);

    // 2. Cierra sesión
    appCore.processLogout();
    expect(appCore.getInitialRoleViewRouted()).toBe(false);
    expect(appCore.getCurrentUser()).toBeNull();

    // 3. Inicia sesión como Gestor -> debe enrutar limpiamente a Agenda
    appCore.setCurrentUser({ id: 'U-GES', cid: 'U-GES', role: 'gestor', nombre: 'Alejandra Ayala' });
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('list-view');
    expect(appCore.getCurrentListMode()).toBe('agenda');
    expect(getEl('agenda-view-container').style.display).toBe('block');

    // 4. Cierra sesión e inicia como Administrador -> debe enrutar a Usuarios
    appCore.processLogout();
    appCore.setCurrentUser({ id: 'U-ADM', cid: 'U-ADM', role: 'admin', nombre: 'Admin General' });
    appCore.applyRolePermissions();
    expect(activeSectionId).toBe('users-view');
  });

  test('9. No se generan listeners duplicados ni se debilitan las autorizaciones', () => {
    // 9.1 Prevención de listeners duplicados
    mockFirestore.collection.mockClear();
    appCore.attachDataListeners('manager', 'U-MGR');
    const firstCallCount = mockFirestore.collection.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Segunda llamada idéntica con el mismo usuario y rol activo
    appCore.attachDataListeners('manager', 'U-MGR');
    expect(mockFirestore.collection.mock.calls.length).toBe(firstCallCount);

    // 9.2 Las autorizaciones no se debilitan: vendedor intentando forzar dashboard-view es rechazado
    appCore.setCurrentUser({ id: 'U-VEN', role: 'vendedor', nombre: 'Carlos Vendedor' });
    global.alert.mockClear();

    appCore.showView('dashboard-view');

    expect(global.alert).toHaveBeenCalledWith(expect.stringMatching(/Acceso denegado/i));
    expect(activeSectionId).not.toBe('dashboard-view');
    expect(activeSectionId).toBe('list-view');

    // 9.3 Gestor intentando entrar a users-view es rechazado
    appCore.setCurrentUser({ id: 'U-GES', role: 'gestor', nombre: 'Alejandra Ayala' });
    global.alert.mockClear();

    appCore.showView('users-view');

    expect(global.alert).toHaveBeenCalledWith(expect.stringMatching(/Acceso denegado/i));
    expect(activeSectionId).not.toBe('users-view');
    expect(activeSectionId).toBe('list-view');
  });
});
