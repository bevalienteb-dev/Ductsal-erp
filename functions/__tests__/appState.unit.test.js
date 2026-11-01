// functions/__tests__/appState.unit.test.js
// DUCTSAL ERP — PRUEBAS UNITARIAS DEL ESTADO CENTRAL (Fase 6.7)

const AppState = require('../../core/app_state');

describe('AppState: Central Application State Module', () => {
  beforeEach(() => {
    AppState.resetAll();
  });

  describe('1. Dominio de Sesión (session)', () => {
    test('inicia con currentUser nulo o desde almacenamiento', () => {
      expect(AppState.session.getCurrentUser()).toBeNull();
    });

    test('setCurrentUser actualiza el usuario y notifica observadores', () => {
      let notifiedUser = null;
      const unsubscribe = AppState.subscribe('session:user', u => {
        notifiedUser = u;
      });

      const user = { id: 'usr_1', role: 'manager', nombre: 'Carlos Gerente' };
      AppState.session.setCurrentUser(user, { persist: false });

      expect(AppState.session.getCurrentUser()).toEqual(user);
      expect(notifiedUser).toEqual(user);

      unsubscribe();
    });

    test('pendingSetupUser se gestiona limpiamente', () => {
      expect(AppState.session.getPendingSetupUser()).toBeNull();
      AppState.session.setPendingSetupUser({ id: 'u_setup', email: 'setup@test.com' });
      expect(AppState.session.getPendingSetupUser()).toEqual({ id: 'u_setup', email: 'setup@test.com' });
    });

    test('generación de sesión incrementa y controla race conditions', () => {
      const g1 = AppState.session.getGeneration();
      const g2 = AppState.session.nextGeneration();
      expect(g2).toBe(g1 + 1);
    });

    test('resetSession limpia usuario y avanza generación', () => {
      AppState.session.setCurrentUser({ id: 'u1' }, { persist: false });
      const genBefore = AppState.session.getGeneration();
      AppState.session.resetSession();

      expect(AppState.session.getCurrentUser()).toBeNull();
      expect(AppState.session.getPendingSetupUser()).toBeNull();
      expect(AppState.session.getGeneration()).toBeGreaterThan(genBefore);
    });
  });

  describe('2. Dominio de Colecciones (collections)', () => {
    test('colecciones inician vacías', () => {
      expect(AppState.collections.getClients()).toEqual([]);
      expect(AppState.collections.getProspects()).toEqual([]);
      expect(AppState.collections.getUsers()).toEqual([]);
      expect(AppState.collections.getSettings().visitantes).toEqual([]);
    });

    test('setClients, setProspects, setUsers y setSettings actualizan y notifican', () => {
      const clientsData = [{ id: 'c1', nombre: 'Cliente Uno' }];
      const prospectsData = [{ id: 'p1', proyecto: 'Ductos Hospital' }];
      const usersData = [{ id: 'u1', role: 'vendedor' }];
      const settingsData = { visitantes: ['Ana'], encargados: ['Luis'], gmaps_api_key: 'xyz', factory_address: 'Planta 1' };

      AppState.collections.setClients(clientsData);
      AppState.collections.setProspects(prospectsData);
      AppState.collections.setUsers(usersData);
      AppState.collections.setSettings(settingsData);

      expect(AppState.collections.getClients()).toEqual(clientsData);
      expect(AppState.collections.getProspects()).toEqual(prospectsData);
      expect(AppState.collections.getUsers()).toEqual(usersData);
      expect(AppState.collections.getSettings()).toEqual(settingsData);
    });

    test('resetCollections restablece las estructuras a valores por defecto', () => {
      AppState.collections.setClients([{ id: 'c1' }]);
      AppState.collections.resetCollections();

      expect(AppState.collections.getClients()).toEqual([]);
      expect(AppState.collections.getProspects()).toEqual([]);
      expect(AppState.collections.getUsers()).toEqual([]);
      expect(AppState.collections.getSettings().visitantes).toEqual([]);
    });
  });

  describe('3. Dominio de Selección (selection)', () => {
    test('currentProspectId inicia en null y se actualiza', () => {
      expect(AppState.selection.getCurrentProspectId()).toBeNull();
      AppState.selection.setCurrentProspectId('prospect_123');
      expect(AppState.selection.getCurrentProspectId()).toBe('prospect_123');

      AppState.selection.clearSelection();
      expect(AppState.selection.getCurrentProspectId()).toBeNull();
    });
  });

  describe('4. Dominio de Navegación (navigation)', () => {
    test('currentView y lastViewedSection inician en list-view', () => {
      expect(AppState.navigation.getCurrentView()).toBe('list-view');
      expect(AppState.navigation.getLastViewedSection()).toBe('list-view');
    });

    test('setCurrentView actualiza vista y notifica', () => {
      let navEvent = null;
      AppState.subscribe('navigation:view', e => { navEvent = e; });

      AppState.navigation.setCurrentView('dashboard-view');
      expect(AppState.navigation.getCurrentView()).toBe('dashboard-view');
      expect(navEvent).toEqual({ current: 'dashboard-view', previous: 'list-view' });
    });

    test('currentListMode alterna correctamente entre pipeline y agenda', () => {
      expect(AppState.navigation.getCurrentListMode()).toBe('agenda');
      AppState.navigation.setCurrentListMode('pipeline');
      expect(AppState.navigation.getCurrentListMode()).toBe('pipeline');
      AppState.navigation.setCurrentListMode('otro_invalido');
      expect(AppState.navigation.getCurrentListMode()).toBe('agenda');
    });
  });

  describe('5. Dominio de Ciclo de Vida (lifecycle)', () => {
    test('incrementLoadedCollections avanza contador y activa initialLoadCompleted al llegar a 4', () => {
      expect(AppState.lifecycle.getLoadedCollections()).toBe(0);
      expect(AppState.lifecycle.isInitialLoadCompleted()).toBe(false);

      AppState.lifecycle.incrementLoadedCollections();
      AppState.lifecycle.incrementLoadedCollections();
      AppState.lifecycle.incrementLoadedCollections();
      expect(AppState.lifecycle.isInitialLoadCompleted()).toBe(false);

      AppState.lifecycle.incrementLoadedCollections(); // 4ta colección
      expect(AppState.lifecycle.getLoadedCollections()).toBe(4);
      expect(AppState.lifecycle.isInitialLoadCompleted()).toBe(true);
    });

    test('gestión de unsubscribers de Firestore', () => {
      const unsub1 = jest.fn();
      const unsub2 = jest.fn();

      AppState.lifecycle.addUnsubscriber(unsub1);
      AppState.lifecycle.addUnsubscriber(unsub2);
      expect(AppState.lifecycle.getActiveUnsubscribers().length).toBe(2);

      const cleared = AppState.lifecycle.clearUnsubscribers();
      expect(cleared).toBe(2);
      expect(unsub1).toHaveBeenCalledTimes(1);
      expect(unsub2).toHaveBeenCalledTimes(1);
      expect(AppState.lifecycle.getActiveUnsubscribers().length).toBe(0);
    });

    test('crmLoadError y currentSubscribedUser', () => {
      expect(AppState.lifecycle.getCrmLoadError()).toBeNull();
      AppState.lifecycle.setCrmLoadError({ code: 'permission-denied', message: 'Falta permiso' });
      expect(AppState.lifecycle.getCrmLoadError()).toEqual({ code: 'permission-denied', message: 'Falta permiso' });

      AppState.lifecycle.setCurrentSubscribedUser({ uid: 'u1', role: 'manager' });
      expect(AppState.lifecycle.getCurrentSubscribedUser()).toEqual({ uid: 'u1', role: 'manager' });
    });
  });

  describe('6. Sincronización con Ámbito Global (syncWithScope)', () => {
    test('syncWithScope vincula propiedades con getters y setters bidireccionales', () => {
      const fakeWindow = {};
      AppState.syncWithScope(fakeWindow);

      // Asignar en fakeWindow debe reflejarse en AppState
      fakeWindow.currentUser = { id: 'w_u1', role: 'admin' };
      expect(AppState.session.getCurrentUser()).toEqual({ id: 'w_u1', role: 'admin' });

      fakeWindow.clients = [{ id: 'w_c1' }];
      expect(AppState.collections.getClients()).toEqual([{ id: 'w_c1' }]);

      fakeWindow.currentProspectId = 'w_p99';
      expect(AppState.selection.getCurrentProspectId()).toBe('w_p99');

      fakeWindow.currentListMode = 'pipeline';
      expect(AppState.navigation.getCurrentListMode()).toBe('pipeline');

      // Modificar en AppState debe reflejarse en fakeWindow
      AppState.session.setCurrentUser({ id: 'w_u2', role: 'gestor' }, { persist: false });
      expect(fakeWindow.currentUser).toEqual({ id: 'w_u2', role: 'gestor' });
    });
  });
});
