// functions/__tests__/usersModules.unit.test.js
// Suite de pruebas unitarias exhaustiva para los módulos de Usuarios y Autenticación (Fase 6.6)
// modules/users/users_permissions.js
// modules/users/users_ui.js
// modules/users/users_controller.js
// modules/users/auth_session.js

const UsersPermissions = require('../../modules/users/users_permissions.js');
const UsersUI = require('../../modules/users/users_ui.js');
const UsersController = require('../../modules/users/users_controller.js');
const AuthSession = require('../../modules/users/auth_session.js');
const CrmAuth = require('../../crm_auth.js');

describe('Fase 6.6: Módulos de Usuarios y Autenticación', () => {

    // Helper DOM stub
    function makeFakeDoc() {
        const elements = {};
        let activeViewId = null;

        function getOrCreate(id) {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    style: { display: '' },
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    classList: {
                        _classes: new Set(),
                        add(c) {
                            elements[id].classList._classes.add(c);
                            if (c === 'active') activeViewId = id;
                        },
                        remove(c) {
                            elements[id].classList._classes.delete(c);
                            if (c === 'active' && activeViewId === id) activeViewId = null;
                        },
                        contains(c) { return elements[id].classList._classes.has(c); }
                    }
                };
            }
            return elements[id];
        }

        return {
            elements,
            getElementById: (id) => getOrCreate(id),
            querySelector: (sel) => {
                if (sel === '.view-section.active') {
                    return activeViewId ? elements[activeViewId] : null;
                }
                return null;
            }
        };
    }

    // Helper localStorage stub
    function makeFakeStorage() {
        const store = new Map();
        return {
            getItem: jest.fn(k => store.get(k) || null),
            setItem: jest.fn((k, v) => store.set(k, String(v))),
            removeItem: jest.fn(k => store.delete(k)),
            clear: jest.fn(() => store.clear())
        };
    }

    // =========================================================================
    // 1. UsersPermissions
    // =========================================================================
    describe('1. UsersPermissions', () => {
        test('1.1 Catálogo de roles y traducción de nombres', () => {
            expect(UsersPermissions.CRM_ROLES).toEqual(['manager', 'gestor', 'vendedor']);
            expect(UsersPermissions.isCrmRole('manager')).toBe(true);
            expect(UsersPermissions.isCrmRole('gestor')).toBe(true);
            expect(UsersPermissions.isCrmRole('vendedor')).toBe(true);
            expect(UsersPermissions.isCrmRole('admin')).toBe(false);
            expect(UsersPermissions.isCrmRole('operario')).toBe(false);

            expect(UsersPermissions.isPlantRole('jefe_produccion')).toBe(true);
            expect(UsersPermissions.isPlantRole('operario')).toBe(true);
            expect(UsersPermissions.isPlantRole('manager')).toBe(false);

            expect(UsersPermissions.getRoleDisplayName('manager')).toBe('Gerente');
            expect(UsersPermissions.getRoleDisplayName('gestor')).toBe('Gestor de Ventas');
            expect(UsersPermissions.getRoleDisplayName('vendedor')).toBe('Vendedor');
            expect(UsersPermissions.getRoleDisplayName('jefe_produccion')).toBe('Jefe de Producción');
            expect(UsersPermissions.getRoleDisplayName('operario')).toBe('Operario de Fabricación');
        });

        test('1.2 canAccessView: control de acceso por vista', () => {
            const manager = { role: 'manager' };
            const gestor = { role: 'gestor' };
            const vendedor = { role: 'vendedor' };

            // dashboard-view solo para manager
            expect(UsersPermissions.canAccessView(manager, 'dashboard-view')).toBe(true);
            expect(UsersPermissions.canAccessView(gestor, 'dashboard-view')).toBe(false);
            expect(UsersPermissions.canAccessView(vendedor, 'dashboard-view')).toBe(false);

            // users-view solo para manager (Gerente)
            expect(UsersPermissions.canAccessView(manager, 'users-view')).toBe(true);
            expect(UsersPermissions.canAccessView(gestor, 'users-view')).toBe(false);
            expect(UsersPermissions.canAccessView(vendedor, 'users-view')).toBe(false);

            // projects-view para manager, gestor y vendedor
            expect(UsersPermissions.canAccessView(manager, 'projects-view')).toBe(true);
            expect(UsersPermissions.canAccessView(gestor, 'projects-view')).toBe(true);
            expect(UsersPermissions.canAccessView(vendedor, 'projects-view')).toBe(true);

            // list-view y clients-view permitidos a todos
            expect(UsersPermissions.canAccessView(vendedor, 'list-view')).toBe(true);
            expect(UsersPermissions.canAccessView(vendedor, 'clients-view')).toBe(true);
        });

        test('1.3 canManageUsers y canExecuteManagerActions', () => {
            expect(UsersPermissions.canManageUsers({ role: 'manager' })).toBe(true);
            expect(UsersPermissions.canManageUsers({ role: 'gestor' })).toBe(false);
            expect(UsersPermissions.canManageUsers({ role: 'vendedor' })).toBe(false);

            expect(UsersPermissions.canExecuteManagerActions({ role: 'manager' })).toBe(true);
            expect(UsersPermissions.canExecuteManagerActions({ role: 'gestor' })).toBe(false);
            expect(UsersPermissions.canExecuteManagerActions({ role: 'vendedor' })).toBe(false);
        });

        test('1.4 applyRolePermissions: enrutamiento y visibilidad para Manager', () => {
            const doc = makeFakeDoc();
            const spies = {
                showView: jest.fn(),
                renderList: jest.fn(),
                renderClientsTable: jest.fn(),
                renderUsersTable: jest.fn(),
                fetchAdminUsers: jest.fn()
            };
            let listMode = 'agenda';
            let initialRouted = false;

            UsersPermissions.applyRolePermissions({
                getCurrentUser: () => ({ id: 'M-1', role: 'manager', nombre: 'Gerente Test' }),
                setCurrentListMode: m => { listMode = m; },
                getCurrentListMode: () => listMode,
                getInitialRoleViewRouted: () => initialRouted,
                setInitialRoleViewRouted: v => { initialRouted = v; },
                showView: spies.showView,
                renderList: spies.renderList,
                renderClientsTable: spies.renderClientsTable,
                renderUsersTable: spies.renderUsersTable,
                fetchAdminUsers: spies.fetchAdminUsers,
                doc
            });

            expect(initialRouted).toBe(true);
            expect(listMode).toBe('pipeline');
            expect(spies.showView).toHaveBeenCalledWith('dashboard-view');
            expect(doc.getElementById('nav-dashboard').style.display).toBe('flex');
            expect(doc.getElementById('nav-users').style.display).toBe('flex');
            expect(spies.renderUsersTable).toHaveBeenCalled();
            expect(spies.fetchAdminUsers).toHaveBeenCalled();
        });

        test('1.5 applyRolePermissions: enrutamiento y visibilidad para Vendedor', () => {
            const doc = makeFakeDoc();
            const spies = {
                showView: jest.fn(),
                switchListMode: jest.fn(),
                renderDailyAgenda: jest.fn(),
                renderClientsTable: jest.fn(),
                renderUsersTable: jest.fn()
            };
            let listMode = 'pipeline';
            let initialRouted = false;

            UsersPermissions.applyRolePermissions({
                getCurrentUser: () => ({ id: 'V-1', role: 'vendedor', nombre: 'Vendedor Test' }),
                setCurrentListMode: m => { listMode = m; },
                getCurrentListMode: () => listMode,
                getInitialRoleViewRouted: () => initialRouted,
                setInitialRoleViewRouted: v => { initialRouted = v; },
                showView: spies.showView,
                switchListMode: spies.switchListMode,
                renderDailyAgenda: spies.renderDailyAgenda,
                renderClientsTable: spies.renderClientsTable,
                renderUsersTable: spies.renderUsersTable,
                doc
            });

            expect(initialRouted).toBe(true);
            expect(listMode).toBe('agenda');
            expect(spies.showView).toHaveBeenCalledWith('list-view');
            expect(doc.getElementById('nav-dashboard').style.display).toBe('none');
            expect(doc.getElementById('nav-users').style.display).toBe('none');
            expect(doc.getElementById('client-action-header').style.display).toBe('table-cell');
            expect(spies.renderUsersTable).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 2. UsersUI
    // =========================================================================
    describe('2. UsersUI', () => {
        test('2.1 renderUsersTable: genera HTML de tabla con filas y acciones', () => {
            const doc = makeFakeDoc();
            const users = [
                { id: 'u1', nombre: 'Benjamin Valiente', email: 'bvaliente@grupogama.com', role: 'manager', activo: true },
                { id: 'u2', nombre: 'Carlos Vendedor', email: 'carlos@ductsal.com', role: 'vendedor', activo: false }
            ];

            UsersUI.renderUsersTable({
                getUsers: () => users,
                doc
            });

            const tbody = doc.getElementById('users-body');
            expect(tbody.innerHTML).toContain('Benjamin Valiente');
            expect(tbody.innerHTML).toContain('Gerente');
            expect(tbody.innerHTML).toContain('Activo');
            expect(tbody.innerHTML).toContain("openUserModal('u1')");

            expect(tbody.innerHTML).toContain('Carlos Vendedor');
            expect(tbody.innerHTML).toContain('Vendedor');
            expect(tbody.innerHTML).toContain('Inactivo');
            expect(tbody.innerHTML).toContain("toggleUserStatus('u2')");
        });

        test('2.2 openUserModal: modo registro (nuevo usuario)', () => {
            const doc = makeFakeDoc();
            UsersUI.openUserModal({ getUsers: () => [], doc }, null);

            expect(doc.getElementById('user-id-edit').value).toBe('');
            expect(doc.getElementById('usr-nombre').value).toBe('');
            expect(doc.getElementById('usr-email').value).toBe('');
            expect(doc.getElementById('usr-rol').value).toBe('vendedor');
            expect(doc.getElementById('user-modal-title').textContent).toBe('Registrar Usuario');
            expect(doc.getElementById('userModal').style.display).toBe('block');
        });

        test('2.3 openUserModal: modo edición con ID', () => {
            const doc = makeFakeDoc();
            const users = [{ id: 'usr-100', nombre: 'Alejandra Ayala', email: 'aayala@ductsal.com', role: 'gestor' }];

            UsersUI.openUserModal({ getUsers: () => users, doc }, 'usr-100');

            expect(doc.getElementById('user-id-edit').value).toBe('usr-100');
            expect(doc.getElementById('usr-nombre').value).toBe('Alejandra Ayala');
            expect(doc.getElementById('usr-email').value).toBe('aayala@ductsal.com');
            expect(doc.getElementById('usr-rol').value).toBe('gestor');
            expect(doc.getElementById('user-modal-title').textContent).toBe('Editar Usuario');
            expect(doc.getElementById('userModal').style.display).toBe('block');
        });

        test('2.4 closeUserModal: invoca función o cierra modal', () => {
            const doc = makeFakeDoc();
            const spyClose = jest.fn();
            UsersUI.closeUserModal({ closeModalFn: spyClose, doc });
            expect(spyClose).toHaveBeenCalledWith('userModal');
        });
    });

    // =========================================================================
    // 3. UsersController
    // =========================================================================
    describe('3. UsersController', () => {
        test('3.1 fetchAdminUsers: carga administrativa restringida a manager y admin', async () => {
            const mockCrmAuth = {
                listUsersViaFunction: jest.fn(async () => [
                    { id: 'u1', nombre: 'Ben', role: 'manager', activo: true },
                    { id: 'u3', nombre: 'Nuevo Admin', role: 'gestor', activo: true }
                ])
            };
            const users = [{ id: 'u1', nombre: 'Ben Old', role: 'manager', activo: true }];
            const spyRender = jest.fn();

            // Vendedor no tiene permiso
            await UsersController.fetchAdminUsers({
                getCurrentUser: () => ({ id: 'v1', role: 'vendedor' }),
                getUsers: () => users,
                getCrmAuth: () => mockCrmAuth,
                getFirebase: () => ({}),
                renderUsersTable: spyRender
            });
            expect(mockCrmAuth.listUsersViaFunction).not.toHaveBeenCalled();

            // Manager sí tiene permiso
            await UsersController.fetchAdminUsers({
                getCurrentUser: () => ({ id: 'm1', role: 'manager' }),
                getUsers: () => users,
                getCrmAuth: () => mockCrmAuth,
                getFirebase: () => ({}),
                renderUsersTable: spyRender
            });
            expect(mockCrmAuth.listUsersViaFunction).toHaveBeenCalled();
            expect(users).toHaveLength(2);
            expect(users[0].nombre).toBe('Ben');
            expect(users[1].id).toBe('u3');
            expect(spyRender).toHaveBeenCalled();
        });

        test('3.2 saveUser: rechaza correo duplicado en alta', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('user-id-edit').value = '';
            doc.getElementById('usr-nombre').value = 'Duplicado';
            doc.getElementById('usr-email').value = 'existe@ductsal.com';
            doc.getElementById('usr-rol').value = 'vendedor';

            const users = [{ id: 'x1', email: 'existe@ductsal.com' }];
            const alerts = [];

            await UsersController.saveUser({
                getUsers: () => users,
                getCrmAuth: () => ({ CREATABLE_ROLES: ['vendedor', 'gestor'] }),
                notify: m => alerts.push(m),
                doc
            }, { preventDefault: () => {} });

            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatch(/ya está en uso/i);
        });

        test('3.3 saveUser: rechaza cambiar correo de usuario con cuenta Firebase Auth', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('user-id-edit').value = 'u-auth-1';
            doc.getElementById('usr-nombre').value = 'Nombre Modificado';
            doc.getElementById('usr-email').value = 'nuevo_correo@ductsal.com'; // intento de cambio
            doc.getElementById('usr-rol').value = 'gestor';

            const users = [{ id: 'u-auth-1', authUid: 'uid-123', email: 'original@ductsal.com', role: 'gestor' }];
            const alerts = [];

            await UsersController.saveUser({
                getUsers: () => users,
                getCrmAuth: () => ({ CREATABLE_ROLES: ['vendedor', 'gestor'] }),
                notify: m => alerts.push(m),
                doc
            }, { preventDefault: () => {} });

            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatch(/no se puede cambiar desde aquí/i);
        });

        test('3.4 saveUser: rechaza asignar rol de gerente desde interfaz', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('user-id-edit').value = 'u-auth-2';
            doc.getElementById('usr-nombre').value = 'Nombre';
            doc.getElementById('usr-email').value = 'vendedor@ductsal.com';
            doc.getElementById('usr-rol').value = 'manager'; // prohibido elevar a gerente

            const users = [{ id: 'u-auth-2', authUid: 'uid-456', email: 'vendedor@ductsal.com', role: 'vendedor' }];
            const alerts = [];

            await UsersController.saveUser({
                getUsers: () => users,
                getCrmAuth: () => ({ CREATABLE_ROLES: ['vendedor', 'gestor'] }),
                notify: m => alerts.push(m),
                doc
            }, { preventDefault: () => {} });

            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatch(/solo se puede asignar el rol de vendedor o gestor/i);
        });

        test('3.5 saveUser: alta exitosa con Cloud Function y CrmAuth', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('user-id-edit').value = '';
            doc.getElementById('usr-nombre').value = 'Nuevo Gestor';
            doc.getElementById('usr-email').value = 'nuevo.gestor@ductsal.com';
            doc.getElementById('usr-rol').value = 'gestor';

            const mockCrmAuth = {
                CREATABLE_ROLES: ['vendedor', 'gestor'],
                adminCreateUser: jest.fn(async () => 'created')
            };
            const users = [];
            const spies = { closeModal: jest.fn(), renderUsersTable: jest.fn(), fetchAdminUsers: jest.fn() };

            await UsersController.saveUser({
                getUsers: () => users,
                getCrmAuth: () => mockCrmAuth,
                getFirebase: () => ({}),
                getDbSuffix: () => '_prod',
                closeModal: spies.closeModal,
                renderUsersTable: spies.renderUsersTable,
                fetchAdminUsers: spies.fetchAdminUsers,
                doc
            }, { preventDefault: () => {} });

            expect(mockCrmAuth.adminCreateUser).toHaveBeenCalledWith(
                expect.anything(),
                { nombre: 'Nuevo Gestor', email: 'nuevo.gestor@ductsal.com', role: 'gestor', dbSuffix: '_prod' },
                expect.any(Function)
            );
            expect(spies.closeModal).toHaveBeenCalledWith('userModal');
            expect(spies.renderUsersTable).toHaveBeenCalled();
            expect(spies.fetchAdminUsers).toHaveBeenCalled();
        });

        test('3.6 toggleUserStatus: impide auto-desactivación del usuario activo', async () => {
            const users = [{ id: 'me-1', authUid: 'uid-me', activo: true }];
            const alerts = [];

            await UsersController.toggleUserStatus({
                getUsers: () => users,
                getCurrentUser: () => ({ id: 'me-1' }),
                notify: m => alerts.push(m)
            }, 'me-1');

            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatch(/no puedes desactivarte a ti mismo/i);
            expect(users[0].activo).toBe(true);
        });

        test('3.7 toggleUserStatus: alterna estado mediante Cloud Function para cuentas Auth', async () => {
            const users = [{ id: 'target-1', authUid: 'uid-target', activo: true }];
            const mockCrmAuth = {
                adminSetUserActive: jest.fn(async () => 'updated')
            };
            const spies = { renderUsersTable: jest.fn(), fetchAdminUsers: jest.fn() };

            await UsersController.toggleUserStatus({
                getUsers: () => users,
                getCurrentUser: () => ({ id: 'me-1' }),
                getCrmAuth: () => mockCrmAuth,
                getFirebase: () => ({}),
                getDbSuffix: () => '_prod',
                renderUsersTable: spies.renderUsersTable,
                fetchAdminUsers: spies.fetchAdminUsers
            }, 'target-1');

            expect(mockCrmAuth.adminSetUserActive).toHaveBeenCalledWith(
                expect.anything(),
                { id: 'target-1', activo: false, dbSuffix: '_prod' },
                expect.any(Function)
            );
            expect(users[0].activo).toBe(false);
            expect(spies.renderUsersTable).toHaveBeenCalled();
            expect(spies.fetchAdminUsers).toHaveBeenCalled();
        });

        test('3.8 resetUserPassword: envía correo de Firebase Auth para usuarios vinculados', async () => {
            const users = [{ id: 'target-2', authUid: 'uid-target-2', email: 'pass@ductsal.com', activo: true }];
            const mockCrmAuth = {
                sendPasswordSetupEmail: jest.fn(async () => {})
            };
            const mockUI = {
                confirm: jest.fn(async () => true),
                success: jest.fn()
            };

            await UsersController.resetUserPassword({
                getUsers: () => users,
                getCrmAuth: () => mockCrmAuth,
                getCrmUI: () => mockUI,
                getFirebase: () => ({})
            }, 'target-2');

            expect(mockUI.confirm).toHaveBeenCalled();
            expect(mockCrmAuth.sendPasswordSetupEmail).toHaveBeenCalledWith(expect.anything(), 'pass@ductsal.com');
            expect(mockUI.success).toHaveBeenCalledWith('Correo de restablecimiento enviado.');
        });
    });

    // =========================================================================
    // 4. AuthSession
    // =========================================================================
    describe('4. AuthSession', () => {
        test('4.1 checkAuth: conmuta visibilidad entre login y main-app', () => {
            const doc = makeFakeDoc();
            const spyPerm = jest.fn();

            // Sin usuario activo
            AuthSession.checkAuth({
                getCurrentUser: () => null,
                applyRolePermissions: spyPerm,
                doc
            });
            expect(doc.getElementById('main-app').style.display).toBe('none');
            expect(doc.getElementById('login-screen').style.display).toBe('flex');
            expect(spyPerm).not.toHaveBeenCalled();

            // Con usuario activo
            AuthSession.checkAuth({
                getCurrentUser: () => ({ id: 'u-1', nombre: 'Gerente General', role: 'manager' }),
                applyRolePermissions: spyPerm,
                doc
            });
            expect(doc.getElementById('main-app').style.display).toBe('flex');
            expect(doc.getElementById('login-screen').style.display).toBe('none');
            expect(doc.getElementById('ui-user-name').textContent).toBe('Gerente General');
            expect(doc.getElementById('ui-user-role').textContent).toBe('Gerente');
            expect(spyPerm).toHaveBeenCalled();
        });

        test('4.2 processLogin: usuario no encontrado muestra advertencia', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('login-email').value = 'noexiste@ductsal.com';
            doc.getElementById('login-password').value = '1234';

            const alerts = [];
            await AuthSession.processLogin({
                getUsers: () => [],
                getCrmAuth: CrmAuth,
                notify: m => alerts.push(m),
                doc
            }, { preventDefault: () => {} });

            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatch(/usuario no encontrado o inactivo/i);
        });

        test('4.3 processLogin: usuario con authUid delega a processFirebaseLogin', async () => {
            const doc = makeFakeDoc();
            doc.getElementById('login-email').value = 'ben@ductsal.com';
            doc.getElementById('login-password').value = 'mypassword';

            const user = { id: 'u-ben', email: 'ben@ductsal.com', authUid: 'uid-ben', activo: true };
            const spyFbLogin = jest.fn();

            await AuthSession.processLogin({
                getUsers: () => [user],
                getCrmAuth: CrmAuth,
                processFirebaseLogin: spyFbLogin,
                doc
            }, { preventDefault: () => {} });

            expect(spyFbLogin).toHaveBeenCalledWith(user, 'mypassword');
        });

        test('4.4 processFirebaseLogin: login exitoso actualiza estado, localStorage y re-renderiza', async () => {
            const user = { id: 'u-ben', email: 'ben@ductsal.com', authUid: 'uid-ben', role: 'manager', activo: true };
            const mockCrmAuth = {
                loginWithFirebase: jest.fn(async () => ({ ok: true }))
            };
            const storage = makeFakeStorage();
            let currentUserState = null;
            const spies = {
                attachDataListeners: jest.fn(),
                checkAuth: jest.fn(),
                reRenderApp: jest.fn()
            };

            await AuthSession.processFirebaseLogin({
                getFirebase: () => ({}),
                getCrmAuth: () => mockCrmAuth,
                setCurrentUser: u => { currentUserState = u; },
                getCurrentUser: () => currentUserState,
                attachDataListeners: spies.attachDataListeners,
                checkAuth: spies.checkAuth,
                reRenderApp: spies.reRenderApp,
                storage
            }, user, 'pass123');

            expect(mockCrmAuth.loginWithFirebase).toHaveBeenCalled();
            expect(currentUserState).toEqual(user);
            expect(storage.setItem).toHaveBeenCalledWith('ductsal_current_user', JSON.stringify(user));
            expect(spies.attachDataListeners).toHaveBeenCalledWith('manager', 'u-ben');
            expect(spies.checkAuth).toHaveBeenCalled();
            expect(spies.reRenderApp).toHaveBeenCalled();
        });

        test('4.5 processLogout: limpia colecciones, listeners, localStorage y desconecta sesión', () => {
            const storage = makeFakeStorage();
            storage.setItem('ductsal_current_user', '{"id":"test"}');

            let currentUserState = { id: 'test' };
            let initialRouted = true;
            let sessionGen = 1;
            const spies = {
                detachSnapshotListeners: jest.fn(),
                clearCollections: jest.fn(),
                signOut: jest.fn(),
                checkAuth: jest.fn()
            };

            AuthSession.processLogout({
                getFirebase: () => ({}),
                getCrmAuth: () => ({ signOut: spies.signOut }),
                detachSnapshotListeners: spies.detachSnapshotListeners,
                clearCollections: spies.clearCollections,
                setCurrentUser: u => { currentUserState = u; },
                setInitialRoleViewRouted: v => { initialRouted = v; },
                incrementAuthSessionGeneration: () => { sessionGen++; },
                checkAuth: spies.checkAuth,
                storage
            });

            expect(sessionGen).toBe(2);
            expect(spies.detachSnapshotListeners).toHaveBeenCalled();
            expect(spies.clearCollections).toHaveBeenCalled();
            expect(spies.signOut).toHaveBeenCalled();
            expect(currentUserState).toBeNull();
            expect(initialRouted).toBe(false);
            expect(storage.removeItem).toHaveBeenCalledWith('ductsal_current_user');
            expect(spies.checkAuth).toHaveBeenCalled();
        });
    });
});
