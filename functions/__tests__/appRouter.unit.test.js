// functions/__tests__/appRouter.unit.test.js
// DUCTSAL ERP — PRUEBAS UNITARIAS DEL ROUTER CENTRAL (Fase 6.7 - Etapa C)

const AppRouter = require('../../core/app_router');
const AppState = require('../../core/app_state');
const UsersPermissions = require('../../modules/users/users_permissions');

function createMockDom() {
  const elements = {};
  const queryAllMap = {
    '.view-section': [],
    '.nav-links li': []
  };

  function createEl(id, isSection = false, isNavItem = false) {
    const classes = new Set();
    const el = {
      id,
      style: { display: '' },
      classList: {
        add: jest.fn(c => classes.add(c)),
        remove: jest.fn(c => classes.delete(c)),
        contains: jest.fn(c => classes.has(c))
      },
      textContent: '',
      innerHTML: ''
    };
    elements[id] = el;
    if (isSection) queryAllMap[''.concat('.view-section')].push(el);
    if (isNavItem) queryAllMap[''.concat('.nav-links li')].push(el);
    return el;
  }

  // Vistas
  createEl('dashboard-view', true);
  createEl('users-view', true);
  createEl('projects-view', true);
  createEl('settings-view', true);
  createEl('list-view', true);
  createEl('clients-view', true);
  createEl('detail-view', true);

  // Nav Links
  createEl('nav-dashboard', false, true);
  createEl('nav-users', false, true);
  createEl('nav-projects', false, true);
  createEl('nav-settings', false, true);
  createEl('nav-list', false, true);
  createEl('nav-clients', false, true);

  // Responsive Headers
  createEl('mobile-header-default');
  createEl('detail-mobile-sticky-bar');

  return {
    getElementById: jest.fn(id => elements[id] || null),
    querySelectorAll: jest.fn(sel => queryAllMap[sel] || [])
  };
}

describe('AppRouter: Central Application Router Module', () => {
  let mockDoc;
  let alertSpy;

  beforeEach(() => {
    AppState.resetAll();
    AppRouter.resetRouterState();
    mockDoc = createMockDom();
    alertSpy = jest.fn();

    AppRouter.init({
      getCurrentUser: () => AppState.session.getCurrentUser(),
      getCurrentView: () => AppState.navigation.getCurrentView(),
      setCurrentView: v => AppState.navigation.setCurrentView(v),
      getLastViewedSection: () => AppState.navigation.getLastViewedSection(),
      setLastViewedSection: v => AppState.navigation.setLastViewedSection(v),
      getCurrentListMode: () => AppState.navigation.getCurrentListMode(),
      setCurrentListMode: m => AppState.navigation.setCurrentListMode(m),
      isInitialRoleViewRouted: () => AppState.lifecycle.isInitialRoleViewRouted(),
      setInitialRoleViewRouted: v => AppState.lifecycle.setInitialRoleViewRouted(v),
      getUsersPermissions: () => UsersPermissions,
      renderDashboard: jest.fn(),
      renderProjectsList: jest.fn(),
      renderClientsTable: jest.fn(),
      renderList: jest.fn(),
      renderDailyAgenda: jest.fn(),
      renderUsersTable: jest.fn(),
      fetchAdminUsers: jest.fn(),
      switchListMode: jest.fn(),
      alert: alertSpy,
      doc: mockDoc,
      win: { scrollY: 150, scrollTo: jest.fn() }
    });
  });

  describe('1. Control de Acceso y Autorización en showView', () => {
    test('gerente puede acceder a dashboard-view', () => {
      AppState.session.setCurrentUser({ id: 'm1', role: 'manager' }, { persist: false });
      AppRouter.showView('dashboard-view');

      expect(mockDoc.getElementById('dashboard-view').classList.add).toHaveBeenCalledWith('active');
      expect(mockDoc.getElementById('nav-dashboard').classList.add).toHaveBeenCalledWith('active');
      expect(alertSpy).not.toHaveBeenCalled();
    });

    test('no-gerente (vendedor) es bloqueado de dashboard-view y redirigido a list-view', () => {
      AppState.session.setCurrentUser({ id: 'v1', role: 'vendedor' }, { persist: false });
      AppRouter.showView('dashboard-view');

      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('exclusivo para la Gerencia General'));
      expect(mockDoc.getElementById('list-view').classList.add).toHaveBeenCalledWith('active');
    });

    test('no-gerente (gestor) es bloqueado de dashboard-view y redirigido a list-view', () => {
      AppState.session.setCurrentUser({ id: 'g1', role: 'gestor' }, { persist: false });
      AppRouter.showView('dashboard-view');

      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('exclusivo para la Gerencia General'));
      expect(mockDoc.getElementById('list-view').classList.add).toHaveBeenCalledWith('active');
    });

    test('vendedor es bloqueado de users-view y redirigido a list-view', () => {
      AppState.session.setCurrentUser({ id: 'v1', role: 'vendedor' }, { persist: false });
      AppRouter.showView('users-view');

      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('exclusivo para la Gerencia General'));
      expect(mockDoc.getElementById('list-view').classList.add).toHaveBeenCalledWith('active');
    });
  });

  describe('2. Enrutamiento Inicial según Rol (routeInitialView)', () => {
    test('manager -> dashboard-view en modo pipeline', () => {
      const user = { id: 'm1', role: 'manager' };
      AppRouter.routeInitialView(user);

      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(true);
      expect(AppState.navigation.getCurrentListMode()).toBe('pipeline');
      expect(mockDoc.getElementById('dashboard-view').classList.add).toHaveBeenCalledWith('active');
    });

    test('gestor -> list-view en modo agenda', () => {
      const user = { id: 'g1', role: 'gestor' };
      AppRouter.routeInitialView(user);

      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(true);
      expect(AppState.navigation.getCurrentListMode()).toBe('agenda');
      expect(mockDoc.getElementById('list-view').classList.add).toHaveBeenCalledWith('active');
    });

    test('vendedor -> list-view en modo agenda', () => {
      const user = { id: 'v1', role: 'vendedor' };
      AppRouter.routeInitialView(user);

      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(true);
      expect(AppState.navigation.getCurrentListMode()).toBe('agenda');
      expect(mockDoc.getElementById('list-view').classList.add).toHaveBeenCalledWith('active');
    });
  });

  describe('3. Modo de Lista y Navegación Responsive', () => {
    test('sincronización de cabecera móvil en vista de detalle', () => {
      AppState.session.setCurrentUser({ id: 'v1', role: 'vendedor' }, { persist: false });
      AppRouter.showView('detail-view');

      const defHeader = mockDoc.getElementById('mobile-header-default');
      const detHeader = mockDoc.getElementById('detail-mobile-sticky-bar');

      expect(defHeader.style.display).toBe('none');
      expect(detHeader.style.display).toBe('flex');

      AppRouter.showView('list-view');
      expect(defHeader.style.display).toBe('flex');
      expect(detHeader.style.display).toBe('none');
    });

    test('gestión de scroll: saveListScrollPosition y restoreListScrollPosition', () => {
      const saved = AppRouter.saveListScrollPosition();
      expect(saved).toBe(150);
      expect(AppRouter.getLastListScrollY()).toBe(150);
    });

    test('resetRouterState restaura valores iniciales', () => {
      AppState.lifecycle.setInitialRoleViewRouted(true);
      AppRouter.saveListScrollPosition();
      AppRouter.resetRouterState();

      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(false);
      expect(AppRouter.getLastListScrollY()).toBe(0);
      expect(AppRouter.getCurrentView()).toBe('list-view');
    });
  });

  describe('4. Ramas Críticas de Seguridad y Control de Navegación', () => {
    test('canUserAccessView tolera argumentos invertidos (viewId, user) y (user, viewId)', () => {
      const mgr = { id: 'm1', role: 'manager' };
      const vnd = { id: 'v1', role: 'vendedor' };

      expect(AppRouter.canUserAccessView('dashboard-view', mgr)).toBe(true);
      expect(AppRouter.canUserAccessView(mgr, 'dashboard-view')).toBe(true);

      expect(AppRouter.canUserAccessView('dashboard-view', vnd)).toBe(false);
      expect(AppRouter.canUserAccessView(vnd, 'dashboard-view')).toBe(false);
    });

    test('canUserAccessView utiliza matriz de contingencia si UsersPermissions no está disponible', () => {
      AppRouter.init({ getUsersPermissions: () => null });

      const mgr = { id: 'm1', role: 'manager' };
      const gst = { id: 'g1', role: 'gestor' };
      const vnd = { id: 'v1', role: 'vendedor' };

      expect(AppRouter.canUserAccessView(mgr, 'dashboard-view')).toBe(true);
      expect(AppRouter.canUserAccessView(mgr, 'users-view')).toBe(true);
      expect(AppRouter.canUserAccessView(gst, 'dashboard-view')).toBe(false);
      expect(AppRouter.canUserAccessView(gst, 'users-view')).toBe(false);
      expect(AppRouter.canUserAccessView(gst, 'projects-view')).toBe(true);
      expect(AppRouter.canUserAccessView(vnd, 'projects-view')).toBe(true);
      expect(AppRouter.canUserAccessView(vnd, 'users-view')).toBe(false);
      expect(AppRouter.canUserAccessView(vnd, 'dashboard-view')).toBe(false);
      expect(AppRouter.canUserAccessView(null, 'dashboard-view')).toBe(false);
      expect(AppRouter.canUserAccessView(null, 'list-view')).toBe(true);
    });

    test('showView con detail-view no sobreescribe lastViewedSection', () => {
      AppState.session.setCurrentUser({ id: 'm1', role: 'manager' }, { persist: false });
      AppRouter.showView('clients-view');
      expect(AppRouter.getLastViewedSection()).toBe('clients-view');

      AppRouter.showView('detail-view');
      expect(AppRouter.getLastViewedSection()).toBe('clients-view');
      expect(AppRouter.getCurrentView()).toBe('detail-view');
    });

    test('routeInitialView es idempotente y respeta bandera isInitialRoleViewRouted', () => {
      const mgr = { id: 'm1', role: 'manager' };
      AppRouter.routeInitialView(mgr);
      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(true);

      const gst = { id: 'g1', role: 'gestor' };
      // Segunda llamada no debe modificar la vista si ya fue enrutado
      AppRouter.routeInitialView(gst);
      expect(AppState.navigation.getCurrentView()).toBe('dashboard-view');
    });

    test('routeInitialView con usuario nulo no enruta y preserva estado pendiente de autenticación', () => {
      AppRouter.resetRouterState();
      AppRouter.routeInitialView(null);

      expect(AppState.lifecycle.isInitialRoleViewRouted()).toBe(false);
    });

    test('saveListScrollPosition y restoreListScrollPosition operan de forma segura si win es nulo', () => {
      AppRouter.init({ win: null });
      expect(AppRouter.saveListScrollPosition()).toBe(0);
      expect(AppRouter.restoreListScrollPosition()).toBe(0);
    });

    test('showView ejecuta los renderizadores correspondientes a cada módulo', () => {
      const renderProjectsSpy = jest.fn();
      const renderClientsSpy = jest.fn();
      const renderUsersSpy = jest.fn();
      const fetchAdminSpy = jest.fn();

      AppRouter.init({
        getUsersPermissions: () => UsersPermissions,
        renderProjectsList: renderProjectsSpy,
        renderClientsTable: renderClientsSpy,
        renderUsersTable: renderUsersSpy,
        fetchAdminUsers: fetchAdminSpy,
        doc: mockDoc
      });

      AppState.session.setCurrentUser({ id: 'm1', role: 'manager' }, { persist: false });

      AppRouter.showView('projects-view');
      expect(renderProjectsSpy).toHaveBeenCalledTimes(1);

      AppRouter.showView('clients-view');
      expect(renderClientsSpy).toHaveBeenCalledTimes(1);

      AppRouter.showView('users-view');
      expect(renderUsersSpy).toHaveBeenCalledTimes(1);
      expect(fetchAdminSpy).toHaveBeenCalledTimes(1);
    });
  });
});
