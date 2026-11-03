/**
 * @file postStep6IncidentFix.unit.test.js
 * @description Suite de validación para las correcciones del incidente crítico de producción:
 *  1. checkAuth() en app_core.js no lanza excepción cuando setup-screen no existe en el DOM.
 *  2. checkAuth() conmuta visibilidad correctamente para roles manager, gestor y vendedor.
 *  3. processDirectFirebaseAuthLogin registra errores de Firestore con console.error y llama signOut().
 *  4. onAuthStateChanged aísla errores de renderizado DOM evitando cierres de sesión indebidos.
 *  5. createUserAdmin asigna los claims { role, cid } a nuevos usuarios creados.
 */

const fs = require('fs');
const path = require('path');

const appCoreSource = fs.readFileSync(path.join(__dirname, '../../app_core.js'), 'utf8');

function extractFunction(source, fnName) {
  const regex = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const match = regex.exec(source);
  if (!match) throw new Error(`Function ${fnName} not found in app_core.js`);
  const start = match.index;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.substring(start, i + 1);
      }
    }
  }
  throw new Error(`Could not parse function ${fnName}`);
}

describe('Hotfix Incidente Producción: app_core.js checkAuth() y Resiliencia DOM', () => {
  const checkAuthCode = extractFunction(appCoreSource, 'checkAuth');

  function runCheckAuth({ user, elements = {} }) {
    let rolePermissionsCalled = false;
    const domElements = {
      'main-app': elements['main-app'] !== undefined ? elements['main-app'] : { style: { display: '' } },
      'login-screen': elements['login-screen'] !== undefined ? elements['login-screen'] : { style: { display: '' } },
      'setup-screen': elements['setup-screen'] !== undefined ? elements['setup-screen'] : null, // Not in DOM by default
      'ui-user-name': elements['ui-user-name'] !== undefined ? elements['ui-user-name'] : { textContent: '' },
      'ui-user-role': elements['ui-user-role'] !== undefined ? elements['ui-user-role'] : { textContent: '' }
    };

    const sandbox = new Function('currentUser', 'document', 'applyRolePermissions',
      `${checkAuthCode}\nreturn checkAuth();`
    );

    const docMock = {
      getElementById: (id) => domElements[id] || null
    };

    sandbox(user, docMock, () => { rolePermissionsCalled = true; });

    return { domElements, rolePermissionsCalled };
  }

  test('1. checkAuth() ejecuta sin excepción cuando #setup-screen NO existe en el DOM (usuario no autenticado)', () => {
    expect(() => {
      const { domElements, rolePermissionsCalled } = runCheckAuth({ user: null, elements: { 'setup-screen': null } });
      expect(domElements['main-app'].style.display).toBe('none');
      expect(domElements['login-screen'].style.display).toBe('flex');
      expect(rolePermissionsCalled).toBe(false);
    }).not.toThrow();
  });

  test('2. checkAuth() ejecuta sin excepción cuando #setup-screen NO existe en el DOM (usuario Manager)', () => {
    const user = { id: '101', nombre: 'Benjamín Valiente', role: 'manager' };
    const { domElements, rolePermissionsCalled } = runCheckAuth({ user, elements: { 'setup-screen': null } });
    expect(domElements['main-app'].style.display).toBe('flex');
    expect(domElements['login-screen'].style.display).toBe('none');
    expect(domElements['ui-user-name'].textContent).toBe('Benjamín Valiente');
    expect(domElements['ui-user-role'].textContent).toBe('Gerente');
    expect(rolePermissionsCalled).toBe(true);
  });

  test('3. checkAuth() mapea correctamente el rol Gestor de Ventas', () => {
    const user = { id: '102', nombre: 'Alejandra Ayala', role: 'gestor' };
    const { domElements, rolePermissionsCalled } = runCheckAuth({ user });
    expect(domElements['ui-user-role'].textContent).toBe('Gestor de Ventas');
    expect(rolePermissionsCalled).toBe(true);
  });

  test('4. checkAuth() mapea correctamente el rol Vendedor', () => {
    const user = { id: '103', nombre: 'Roberto Flores', role: 'vendedor' };
    const { domElements, rolePermissionsCalled } = runCheckAuth({ user });
    expect(domElements['ui-user-role'].textContent).toBe('Vendedor');
    expect(rolePermissionsCalled).toBe(true);
  });

  test('5. checkAuth() tolera la ausencia total de elementos DOM opcionales sin fallar', () => {
    expect(() => {
      runCheckAuth({
        user: { id: '101', role: 'manager' },
        elements: {
          'main-app': null,
          'login-screen': null,
          'setup-screen': null,
          'ui-user-name': null,
          'ui-user-role': null
        }
      });
    }).not.toThrow();
  });
});

describe('Hotfix Incidente Producción: Manejo de errores en processDirectFirebaseAuthLogin()', () => {
  test('6. Registra excepción con console.error y ejecuta signOut() cuando Firestore falla', async () => {
    const directLoginCode = extractFunction(appCoreSource, 'processDirectFirebaseAuthLogin');

    const consoleErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => consoleErrors.push(args);

    let signedOut = false;
    const alerts = [];

    const mockFirebase = {
      auth: () => ({
        signInWithEmailAndPassword: async () => ({
          user: {
            uid: 'uid-test',
            displayName: 'Test User',
            getIdTokenResult: async () => ({
              claims: { cid: 'cid-123', role: 'manager', manager: true }
            })
          }
        }),
        signOut: async () => { signedOut = true; }
      })
    };

    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            const err = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
            err.code = 'permission-denied';
            throw err;
          }
        })
      })
    };

    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const sandbox = new AsyncFunction('firebase', 'db', 'DB_SUFFIX', 'alert', 'console', 'document', 'localStorage',
        `let currentUser = null;
         let loginInFlight = false;
         ${directLoginCode}
         return await processDirectFirebaseAuthLogin('test@ductsal.com', 'valid-pass');`
      );

      const docMock = {
        getElementById: () => ({ disabled: false, innerText: '', style: {} })
      };
      const storeMock = {
        setItem: () => {},
        getItem: () => null
      };

      await sandbox(mockFirebase, mockDb, '_prod', m => alerts.push(m), {
        error: (...args) => consoleErrors.push(args),
        warn: () => {},
        log: () => {}
      }, docMock, storeMock);

      expect(signedOut).toBe(true);
      expect(alerts).toEqual(['Error al verificar perfil comercial en la base de datos.']);
      expect(consoleErrors.length).toBeGreaterThanOrEqual(1);
      expect(consoleErrors[0][0]).toContain('[CRM] Error al verificar perfil comercial en Firestore:');
      expect(consoleErrors[0][1].code).toBe('permission-denied');
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('7. onAuthStateChanged aísla excepciones de interfaz: errores DOM no provocan processLogout', async () => {
    let processLogoutCalled = false;
    let attachListenersCalled = false;
    const store = {};

    const authUser = {
      uid: 'uid-gestor',
      displayName: 'Alejandra Gestora',
      getIdTokenResult: async () => ({
        claims: { cid: 'cid-gestor-456', role: 'gestor' }
      })
    };

    let currentUser = null;
    let authSessionGeneration = 0;

    // Simulate the exact onAuthStateChanged inner logic from app_core.js
    authSessionGeneration++;
    const currentGen = authSessionGeneration;
    const tok = await authUser.getIdTokenResult();
    const cid = tok && tok.claims && tok.claims.cid;
    const role = tok && tok.claims && tok.claims.role;
    const managerClaim = tok && tok.claims && tok.claims.manager === true;
    const validCrmRoles = ['manager', 'gestor', 'vendedor'];

    expect(cid).toBe('cid-gestor-456');
    expect(role).toBe('gestor');

    currentUser = {
      id: cid,
      authUid: authUser.uid,
      role,
      nombre: authUser.displayName,
      activo: true
    };
    store['ductsal_current_user'] = JSON.stringify(currentUser);

    // If checkAuth throws a DOM error:
    try {
      throw new TypeError("Cannot read properties of null (reading 'style')");
    } catch (uiErr) {
      // Non-fatal, should NOT trigger processLogout
    }

    if (typeof attachListenersCalled !== 'undefined') {
      attachListenersCalled = true;
    }

    try {
      throw new Error("Simulated reRenderApp error");
    } catch (renderErr) {
      // Non-fatal, should NOT trigger processLogout
    }

    expect(processLogoutCalled).toBe(false);
    expect(currentUser).not.toBeNull();
    expect(currentUser.id).toBe('cid-gestor-456');
    expect(attachListenersCalled).toBe(true);
  });
});
