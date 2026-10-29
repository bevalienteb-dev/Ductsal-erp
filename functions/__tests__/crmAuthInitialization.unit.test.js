// functions/__tests__/crmAuthInitialization.unit.test.js
// Unit tests for controlled Firebase Auth initialization, race condition prevention,
// deduplicated listeners, permission-denied recovery, and role-based listener subscriptions in app_core.js.

const fs = require('fs');
const path = require('path');

const appCoreSrc = fs.readFileSync(path.join(__dirname, '../../app_core.js'), 'utf8');

describe('CRM Auth Initialization & Listener Race Condition Prevention', () => {

  function createTestSandbox() {
    const store = {};
    const localStorage = {
      getItem: k => store[k] !== undefined ? store[k] : null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      clear: () => { Object.keys(store).forEach(k => delete store[k]); }
    };

    const listeners = { DOMContentLoaded: [] };
    const elements = {};

    function makeElementStub(id = '', extra = {}) {
      const classes = new Set(extra.classes || []);
      const el = {
        id,
        style: {},
        textContent: '',
        innerHTML: '',
        value: '',
        options: [],
        children: [],
        setAttribute: () => {},
        getAttribute: () => null,
        removeAttribute: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        classList: {
          add: (...names) => names.forEach(n => classes.add(n)),
          remove: (...names) => names.forEach(n => classes.delete(n)),
          toggle: (name, force) => {
            if (force === undefined) {
              if (classes.has(name)) { classes.delete(name); return false; }
              else { classes.add(name); return true; }
            } else if (force) {
              classes.add(name); return true;
            } else {
              classes.delete(name); return false;
            }
          },
          contains: name => classes.has(name)
        },
        ...extra
      };
      return el;
    }

    // Pre-populate known elements
    ['main-app', 'login-screen', 'setup-screen', 'ui-user-name', 'ui-user-role',
     'opp-table-body', 'nav-dashboard', 'nav-projects', 'nav-settings', 'nav-users',
     'nav-list', 'nav-clients', 'client-action-header', 'list-view', 'projects-view',
     'dashboard-view', 'users-view', 'clients-view', 'detail-view', 'mobile-header-default',
     'detail-mobile-sticky-bar', 'login-email', 'login-password', 'role-filter',
     'vendedor-filter', 'status-filter', 'search-box', 'stats-total-amount',
     'stats-total-count', 'stats-pending-count', 'stats-urgent-count', 'prospect-count'
    ].forEach(id => {
      elements[id] = makeElementStub(id);
    });

    // Special initial styles
    elements['main-app'].style.display = 'none';
    elements['login-screen'].style.display = 'flex';
    elements['setup-screen'].style.display = 'none';

    const document = {
      addEventListener: (evt, handler) => {
        if (!listeners[evt]) listeners[evt] = [];
        listeners[evt].push(handler);
      },
      getElementById: id => {
        if (!elements[id]) {
          elements[id] = makeElementStub(id);
        }
        return elements[id];
      },
      querySelector: sel => makeElementStub(sel),
      querySelectorAll: sel => [makeElementStub(sel)]
    };

    const firestoreCalls = {
      collections: [],
      docs: [],
      queries: [],
      listenersAttached: 0,
      unsubs: 0
    };

    const makeQueryStub = (colName, filterDesc) => {
      const q = {
        where: (field, op, val) => makeQueryStub(colName, `${filterDesc || ''} [${field} ${op} ${val}]`),
        orderBy: () => q,
        limit: () => q,
        onSnapshot: (onNext, onError) => {
          firestoreCalls.listenersAttached++;
          firestoreCalls.queries.push({ colName, filterDesc, onNext, onError });
          return () => {
            firestoreCalls.unsubs++;
          };
        }
      };
      return q;
    };

    const db = {
      settings: () => {},
      collection: name => {
        firestoreCalls.collections.push(name);
        return {
          doc: id => {
            firestoreCalls.docs.push({ collection: name, id });
            return {
              onSnapshot: (onNext, onError) => {
                firestoreCalls.listenersAttached++;
                firestoreCalls.queries.push({ colName: name, docId: id, onNext, onError });
                return () => { firestoreCalls.unsubs++; };
              },
              get: async () => ({ exists: false, data: () => null }),
              set: async () => {},
              update: async () => {}
            };
          },
          where: (field, op, val) => makeQueryStub(name, `[${field} ${op} ${val}]`),
          orderBy: () => makeQueryStub(name, 'ordered'),
          onSnapshot: (onNext, onError) => {
            firestoreCalls.listenersAttached++;
            firestoreCalls.queries.push({ colName: name, filterDesc: 'ALL', onNext, onError });
            return () => { firestoreCalls.unsubs++; };
          }
        };
      }
    };

    let authStateCallback = null;
    let mockAuthUser = null;
    const authObj = {
      get currentUser() { return mockAuthUser; },
      onAuthStateChanged: cb => {
        authStateCallback = cb;
        return () => { authStateCallback = null; };
      },
      signOut: jest.fn(async () => {
        mockAuthUser = null;
        if (authStateCallback) authStateCallback(null);
      })
    };

    const firebase = {
      initializeApp: () => {},
      auth: () => authObj,
      firestore: () => db,
      storage: () => ({ ref: () => ({ child: () => ({}) }) }),
      functions: () => ({ httpsCallable: () => () => ({ data: {} }) })
    };

    // Load app_core in a sandbox context
    const sandboxExports = {};
    const module = { exports: sandboxExports };
    const window = {
      location: { hostname: 'erp.ductsal.com', protocol: 'https:' },
      localStorage,
      document,
      firebase,
      alert: () => {},
      confirm: () => true
    };

    const evalFn = new Function(
      'window', 'document', 'localStorage', 'firebase', 'module', 'exports', 'console',
      'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      appCoreSrc
    );

    evalFn(
      window, document, localStorage, firebase, module, sandboxExports,
      {
        log: () => {},
        warn: (...args) => console.log('SANDBOX_WARN:', ...args),
        error: (...args) => console.log('SANDBOX_ERR:', ...args)
      },
      () => {}, // alert
      () => true, // confirm
      () => '', // prompt
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    );

    return {
      store,
      localStorage,
      document,
      elements,
      db,
      firestoreCalls,
      firebase,
      authObj,
      triggerAuthStateChanged: async user => {
        mockAuthUser = user;
        if (authStateCallback) await authStateCallback(user);
      },
      triggerDOMContentLoaded: async () => {
        for (const handler of (listeners.DOMContentLoaded || [])) {
          await handler();
        }
      },
      exports: module.exports
    };
  }

  test('1. DOMContentLoaded does NOT attach commercial listeners from unverified localStorage', async () => {
    const sandbox = createTestSandbox();

    // Simulate pre-cached user in localStorage
    sandbox.localStorage.setItem('ductsal_current_user', JSON.stringify({
      id: 'usr-101',
      authUid: 'uid-101',
      role: 'vendedor',
      nombre: 'Roberto Flores',
      activo: true
    }));

    // Trigger DOMContentLoaded BEFORE onAuthStateChanged fires
    await sandbox.triggerDOMContentLoaded();

    // CRITICAL SECURITY & RACE CONDITION CHECK:
    // Zero listeners must be attached to Firestore before Auth verification
    expect(sandbox.firestoreCalls.listenersAttached).toBe(0);
    expect(sandbox.firestoreCalls.collections).toHaveLength(0);
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
  });

  test('2. onAuthStateChanged attaches listeners with verified session and claims', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUser = {
      uid: 'uid-vendedor-1',
      displayName: 'Vendedor Test',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-vendedor-1', role: 'vendedor' }
      })
    };

    await sandbox.triggerAuthStateChanged(mockUser);

    // Listeners must now be attached
    expect(sandbox.firestoreCalls.listenersAttached).toBeGreaterThan(0);
    const sub = sandbox.exports.getCurrentSubscribedUser();
    expect(sub).toEqual({ role: 'vendedor', userId: 'cid-vendedor-1' });

    // Vendedor queries attached:
    // system_prod, userDirectory_prod, clients_prod (propios + visibles), prospects_prod (asignados)
    expect(sandbox.firestoreCalls.collections).toContain('system_prod');
    expect(sandbox.firestoreCalls.collections).toContain('userDirectory_prod');
    expect(sandbox.firestoreCalls.collections).toContain('clients_prod');
    expect(sandbox.firestoreCalls.collections).toContain('prospects_prod');

    // Verify localStorage updated
    const saved = JSON.parse(sandbox.localStorage.getItem('ductsal_current_user'));
    expect(saved.id).toBe('cid-vendedor-1');
    expect(saved.role).toBe('vendedor');
    expect(saved.authUid).toBe('uid-vendedor-1');
  });

  test('3. Role verification: Manager role requires manager: true claim', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    // Manager role without manager claim must be rejected
    const mockUserInvalid = {
      uid: 'uid-fake-mgr',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-mgr', role: 'manager', manager: false }
      })
    };

    await sandbox.triggerAuthStateChanged(mockUserInvalid);

    // Must be logged out and zero listeners attached
    expect(sandbox.firestoreCalls.listenersAttached).toBe(0);
    expect(sandbox.localStorage.getItem('ductsal_current_user')).toBeNull();
  });

  test('4. Gestor role attaches 3 prospects queries (own, assigned, postcierre)', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockGestor = {
      uid: 'uid-gestor-1',
      displayName: 'Alejandra Ayala',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-gestor-1', role: 'gestor' }
      })
    };

    await sandbox.triggerAuthStateChanged(mockGestor);

    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'gestor', userId: 'cid-gestor-1' });
    // Gestor has: 1 settings + 1 userDir + 1 clients + 3 prospects = 6 listeners
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(6);
  });

  test('5. Manager role attaches full collections without filters', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockManager = {
      uid: 'uid-mgr-1',
      displayName: 'Benjamin Valiente',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-mgr-1', role: 'manager', manager: true }
      })
    };

    await sandbox.triggerAuthStateChanged(mockManager);

    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'manager', userId: 'cid-mgr-1' });
    // Manager has: 1 settings + 1 userDir + 1 clients (all) + 1 prospects (all) = 4 listeners
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(4);
  });

  test('6. Deduplication: repeated onAuthStateChanged calls do not duplicate listeners', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUser = {
      uid: 'uid-vendedor-1',
      displayName: 'Vendedor Test',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-vendedor-1', role: 'vendedor' }
      })
    };

    await sandbox.triggerAuthStateChanged(mockUser);
    const initialCount = sandbox.exports.getActiveUnsubscribers().length;
    expect(initialCount).toBe(5); // 1 settings + 1 userDir + 2 clients + 1 prospects

    // Trigger auth state changed again with the same user
    await sandbox.triggerAuthStateChanged(mockUser);
    expect(sandbox.exports.getActiveUnsubscribers().length).toBe(initialCount);
  });

  test('7. Explicit permission-denied error handling and controlled retry', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUser = {
      uid: 'uid-v-1',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-v-1', role: 'vendedor' } }),
      getIdToken: jest.fn(async () => 'fresh-token')
    };

    await sandbox.triggerAuthStateChanged(mockUser);

    // Simulate permission-denied on prospects query
    const prospectQuery = sandbox.firestoreCalls.queries.find(q => q.colName === 'prospects_prod');
    expect(prospectQuery).toBeDefined();

    prospectQuery.onError({ code: 'permission-denied', message: 'Missing or insufficient permissions' });

    // Verify error is explicitly tracked
    const err = sandbox.exports.getCrmLoadError();
    expect(err).toBeDefined();
    expect(err.code).toBe('permission-denied');
    expect(err.collection).toBe('prospects (asignados)');

    // Verify retryDataListeners clears error and refreshes token
    await sandbox.exports.retryDataListeners();
    expect(mockUser.getIdToken).toHaveBeenCalledWith(true);
    expect(sandbox.exports.getCrmLoadError()).toBeNull();
  });

  test('8. Logout and session expiration cleanup', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUser = {
      uid: 'uid-v-1',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-v-1', role: 'vendedor' } })
    };

    await sandbox.triggerAuthStateChanged(mockUser);
    expect(sandbox.exports.getActiveUnsubscribers().length).toBeGreaterThan(0);

    // Simulate session expired / logout (authUser = null)
    await sandbox.triggerAuthStateChanged(null);

    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.localStorage.getItem('ductsal_current_user')).toBeNull();
    expect(sandbox.elements['login-screen'].style.display).toBe('flex');
    expect(sandbox.elements['main-app'].style.display).toBe('none');
  });

  test('9. User switch: cleanly detaches old listeners and attaches new subscriptions', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockVendedor = {
      uid: 'uid-vend-1',
      displayName: 'Vendedor Uno',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-vend-1', role: 'vendedor' } })
    };

    const mockManager = {
      uid: 'uid-mgr-1',
      displayName: 'Manager Dos',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-mgr-1', role: 'manager', manager: true } })
    };

    // 1. First user signs in
    await sandbox.triggerAuthStateChanged(mockVendedor);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'vendedor', userId: 'cid-vend-1' });
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(5);

    // 2. Switch to second user
    await sandbox.triggerAuthStateChanged(mockManager);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'manager', userId: 'cid-mgr-1' });
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(4);

    const saved = JSON.parse(sandbox.localStorage.getItem('ductsal_current_user'));
    expect(saved.id).toBe('cid-mgr-1');
    expect(saved.role).toBe('manager');
  });

  test('10. Invalid role or missing claims: denies access and purges state', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockInvalidUser = {
      uid: 'uid-hacker',
      displayName: 'Invalid User',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-hacker', role: 'superadmin' } }) // unauthorized role
    };

    await sandbox.triggerAuthStateChanged(mockInvalidUser);

    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    expect(sandbox.localStorage.getItem('ductsal_current_user')).toBeNull();
  });

  test('11. Reintento sin usuario autenticado: cero suscripciones y error unauthenticated', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    sandbox.localStorage.setItem('ductsal_current_user', JSON.stringify({ id: 'cid-forged', role: 'manager' }));

    // No authenticated user (mockAuthUser is null)
    await sandbox.exports.retryDataListeners();

    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    expect(sandbox.firestoreCalls.listenersAttached).toBe(0);
    const err = sandbox.exports.getCrmLoadError();
    expect(err).toBeDefined();
    expect(err.code).toBe('unauthenticated');
  });

  test('12. Error al refrescar token: cero fallback a localStorage', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    sandbox.localStorage.setItem('ductsal_current_user', JSON.stringify({ id: 'cid-forged', role: 'manager' }));

    const mockFailingUser = {
      uid: 'uid-fail',
      getIdToken: jest.fn().mockRejectedValue(new Error('Network error during refresh')),
      getIdTokenResult: jest.fn()
    };

    // Attach mock failing user
    await sandbox.triggerAuthStateChanged(mockFailingUser);
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();

    // Trigger retryDataListeners
    await sandbox.exports.retryDataListeners();

    // Must not fallback to localStorage
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    const err = sandbox.exports.getCrmLoadError();
    expect(err).toBeDefined();
    expect(err.code).toBe('token-refresh-error');
  });

  test('13. Token sin cid durante reintento: cero suscripciones', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUserNoCid = {
      uid: 'uid-nocid',
      getIdToken: jest.fn(async () => 'token'),
      getIdTokenResult: jest.fn(async () => ({ claims: { role: 'vendedor' } })) // Missing cid
    };

    await sandbox.triggerAuthStateChanged(mockUserNoCid);
    await sandbox.exports.retryDataListeners();

    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    const err = sandbox.exports.getCrmLoadError();
    expect(err.code).toBe('permission-denied');
  });

  test('14. Rol inválido durante reintento: cero suscripciones', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUserInvalidRole = {
      uid: 'uid-badrole',
      getIdToken: jest.fn(async () => 'token'),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-1', role: 'auditor' } })) // Invalid role
    };

    await sandbox.triggerAuthStateChanged(mockUserInvalidRole);
    await sandbox.exports.retryDataListeners();

    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
  });

  test('15. Manager sin manager === true durante reintento: cero suscripciones', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    const mockUserFakeManager = {
      uid: 'uid-fakemgr',
      getIdToken: jest.fn(async () => 'token'),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-1', role: 'manager', manager: false } }))
    };

    await sandbox.triggerAuthStateChanged(mockUserFakeManager);
    await sandbox.exports.retryDataListeners();

    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    const err = sandbox.exports.getCrmLoadError();
    expect(err.message).toContain('Gerencia General');
  });

  test('16. Cierre de sesión mientras getIdToken(true) está pendiente: cero nuevas suscripciones posteriores', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    let resolveToken;
    const tokenPromise = new Promise(r => { resolveToken = r; });
    const mockUser = {
      uid: 'uid-closing-session',
      displayName: 'User Logging Out',
      getIdToken: jest.fn(() => tokenPromise),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-close', role: 'vendedor' } }))
    };

    // First, complete regular login
    const instantUser = {
      uid: 'uid-closing-session',
      getIdToken: async () => 'tok',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-close', role: 'vendedor' } })
    };
    await sandbox.triggerAuthStateChanged(instantUser);
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(5);

    // Set mockUser as current auth user and launch retry
    await sandbox.triggerAuthStateChanged(mockUser);
    const retryPromise = sandbox.exports.retryDataListeners();

    // User logs out while token refresh is in flight!
    await sandbox.triggerAuthStateChanged(null);
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();

    // Now old retry's getIdToken resolves
    resolveToken('token-late');
    await retryPromise;

    // Must strictly remain logged out with 0 listeners!
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(0);
    expect(sandbox.exports.getCurrentSubscribedUser()).toBeNull();
    expect(sandbox.localStorage.getItem('ductsal_current_user')).toBeNull();
  });

  test('17. Cambio del UID durante el reintento: cero suscripciones del usuario anterior', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    let resolveTokenA;
    const tokenPromiseA = new Promise(r => { resolveTokenA = r; });
    const mockUserA = {
      uid: 'uid-user-a',
      getIdToken: jest.fn(() => tokenPromiseA),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-user-a', role: 'vendedor' } }))
    };

    // Start with User A
    const instantUserA = {
      uid: 'uid-user-a',
      getIdToken: async () => 'tok-a',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-user-a', role: 'vendedor' } })
    };
    await sandbox.triggerAuthStateChanged(instantUserA);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'vendedor', userId: 'cid-user-a' });

    // Switch to mockUserA with deferred token and launch retry
    await sandbox.triggerAuthStateChanged(mockUserA);
    const retryPromiseA = sandbox.exports.retryDataListeners();

    // Before User A resolves, User B logs in!
    const mockUserB = {
      uid: 'uid-user-b',
      getIdToken: async () => 'tok-b',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-user-b', role: 'gestor' } })
    };
    await sandbox.triggerAuthStateChanged(mockUserB);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'gestor', userId: 'cid-user-b' });

    // Now User A's slow retry resolves
    resolveTokenA('tok-a-late');
    await retryPromiseA;

    // User B must remain active! User A must NOT overwrite User B!
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'gestor', userId: 'cid-user-b' });
  });

  test('18. Reintento válido para cada uno de los tres roles: suscripciones correctas sin duplicados', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    // 18.1 Vendedor
    const mockVendedor = {
      uid: 'uid-v-retry',
      getIdToken: jest.fn(async () => 'tok-v'),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-v-retry', role: 'vendedor' } }))
    };
    await sandbox.triggerAuthStateChanged(mockVendedor);
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(5);
    await sandbox.exports.retryDataListeners();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(5);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'vendedor', userId: 'cid-v-retry' });

    // 18.2 Gestor
    const mockGestor = {
      uid: 'uid-g-retry',
      getIdToken: jest.fn(async () => 'tok-g'),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-g-retry', role: 'gestor' } }))
    };
    await sandbox.triggerAuthStateChanged(mockGestor);
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(6);
    await sandbox.exports.retryDataListeners();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(6);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'gestor', userId: 'cid-g-retry' });

    // 18.3 Manager
    const mockManager = {
      uid: 'uid-m-retry',
      getIdToken: jest.fn(async () => 'tok-m'),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-m-retry', role: 'manager', manager: true } }))
    };
    await sandbox.triggerAuthStateChanged(mockManager);
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(4);
    await sandbox.exports.retryDataListeners();
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(4);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'manager', userId: 'cid-m-retry' });
  });

  test('19. Reintento antiguo que termina después de iniciarse una sesión nueva: no modifica el estado de la sesión nueva', async () => {
    const sandbox = createTestSandbox();
    await sandbox.triggerDOMContentLoaded();

    let rejectTokenOld;
    const oldPromise = new Promise((_, rej) => { rejectTokenOld = rej; });
    const mockOldUser = {
      uid: 'uid-old-session',
      getIdToken: jest.fn(() => oldPromise),
      getIdTokenResult: jest.fn(async () => ({ claims: { cid: 'cid-old', role: 'vendedor' } }))
    };

    // User A triggers retry that will eventually fail
    const instantOld = {
      uid: 'uid-old-session',
      getIdToken: async () => 'tok',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-old', role: 'vendedor' } })
    };
    await sandbox.triggerAuthStateChanged(instantOld);

    await sandbox.triggerAuthStateChanged(mockOldUser);
    const retryPromiseOld = sandbox.exports.retryDataListeners();

    // User B signs in cleanly as manager
    const mockNewManager = {
      uid: 'uid-new-mgr',
      getIdToken: async () => 'tok-new',
      getIdTokenResult: async () => ({ claims: { cid: 'cid-new-mgr', role: 'manager', manager: true } })
    };
    await sandbox.triggerAuthStateChanged(mockNewManager);
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'manager', userId: 'cid-new-mgr' });
    expect(sandbox.exports.getCrmLoadError()).toBeNull();

    // Old retry now rejects with an error
    rejectTokenOld(new Error('Network failure from previous session'));
    await retryPromiseOld;

    // Verify User B's state is completely unpolluted:
    expect(sandbox.exports.getCurrentSubscribedUser()).toEqual({ role: 'manager', userId: 'cid-new-mgr' });
    expect(sandbox.exports.getActiveUnsubscribers()).toHaveLength(4);
    expect(sandbox.exports.getCrmLoadError()).toBeNull(); // Must NOT be overwritten with old error!
  });

});

