# DUCTSAL ERP — FASE 6.6: INVENTARIO ARQUITECTÓNICO Y PLAN DE MODULARIZACIÓN
## Subsistema de Usuarios, Autenticación, Sesiones y Autorización

---

## 1. RESUMEN EJECUTIVO

La **Fase 6.6** del plan de modularización de DUCTSAL ERP aborda la extracción y desacoplamiento del subsistema de **Usuarios y Autenticación** actualmente centralizado entre `crm_auth.js` y `app_core.js`.

El subsistema abarca cinco áreas críticas:
1. **Autenticación y Ciclo de Vida de Sesión**: Inicialización de Firebase Auth, listener `onAuthStateChanged`, login con credenciales / Firebase Auth, logout, recuperación de contraseñas, purga de contraseñas heredadas, y sincronización reactiva de estado.
2. **Administración de Usuarios**: Listado administrativo (`listUsersAdmin`), modal de alta/edición, creación atómica e idempotente (`createUserAdmin`), actualización de perfiles y roles (`updateUserAdmin`), alternancia de estado activo/inactivo (`toggleUserStatusAdmin`), y restablecimiento de contraseña (`resendInvitationAdmin` / `sendPasswordResetEmail`).
3. **Roles y Autorización**: Matriz exhaustiva de roles (`manager`, `admin`, `gestor`, `vendedor`, y roles de fábrica), resolución de visibilidad en interfaz (`applyRolePermissions`), enrutamiento inicial por rol, protección de vistas y respeto irrestricto de la autoridad de seguridad del backend (Cloud Functions y Firestore Security Rules).
4. **Perfiles e Identidad Comercial**: Manejo de identidad dual (`authUid` de Firebase Authentication vs `cid` de perfil comercial histórico), asignaciones de oportunidades/clientes y consistencia del estado de sesión en memoria y `localStorage`.
5. **Compatibilidad e Integración**: Preservación del modelo UMD/IIFE clásico en navegador y CommonJS en Jest, fachadas y proxies transparentes en `app_core.js` y `window`, y cero regresiones en los 76 suites de pruebas existentes.

---

## 2. INVENTARIO DETALLADO DE RESPONSABILIDADES

A continuación se detalla la matriz de inventario exhaustivo para cada función y responsabilidad del subsistema:

### 2.1 Autenticación, Sesión e Identidad

| Responsabilidad / Función | Archivo Origen | Dependencias | Estado Mutable Compartido | Consumidores | Destino Propuesto | Riesgo de Extracción | Pruebas Existentes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Listener `onAuthStateChanged`** | `app_core.js:1930-1994` | `firebase.auth`, `getIdTokenResult`, `attachDataListeners`, `reRenderApp`, `checkAuth`, `processLogout` | `currentUser`, `authSessionGeneration`, `localStorage` | Inicialización de app, eventos de sesión de Firebase Auth | `modules/users/auth_session.js` (delegación desde `app_core.js`) | **Alto**: Condiciones de carrera en recarga y cambio de token; verificación estricta de claims (`cid`, `role`, `manager`). | `initialLoadAndRoleRouting.unit.test.js`, `crmAuth.uiFlow.test.js` |
| **`checkAuth()`** | `app_core.js:2180-2196` | DOM (`#main-app`, `#login-screen`, `#setup-screen`, `#ui-user-name`, `#ui-user-role`), `applyRolePermissions` | `currentUser` | `onAuthStateChanged`, `processLogin`, `processLogout`, carga inicial | `modules/users/auth_session.js` (con fachada en `app_core.js`) | **Medio**: Elementos del DOM deben sincronizarse sin parpadeo; llamadas en múltiples flujos. | `initialLoadAndRoleRouting.unit.test.js` |
| **`processLogin(e)`** | `app_core.js:2200-2223` | DOM (`#login-email`, `#login-password`), `CrmAuth.findLoginUser`, `processFirebaseLogin`, `processDirectFirebaseAuthLogin` | `users`, `currentUser` | Formulario `#login-form` (`onsubmit`) | `modules/users/auth_session.js` (con fachada en `app_core.js`) | **Medio**: Distinción entre usuarios con `authUid` y login directo contra Firebase Auth. | `crmAuth.uiFlow.test.js` (utiliza slice textual `between`) |
| **`processDirectFirebaseAuthLogin(email, pass)`** | `app_core.js:2225-2263` | `firebase.auth().signInWithEmailAndPassword`, `db.collection('users' + DB_SUFFIX)`, `CrmAuth.purgeHistoricalPassword`, `checkAuth`, `reRenderApp` | `currentUser`, `localStorage`, `DB_SUFFIX` | `processLogin` | `modules/users/auth_session.js` | **Medio**: Lectura de claims de token, fallback a Firestore y purga de password histórico. | `crmAuth.uiFlow.test.js` |
| **`processFirebaseLogin(user, pass)`** | `app_core.js:2265-2288` | `CrmAuth.loginWithFirebase`, `CrmAuth.purgeHistoricalPassword`, `checkAuth`, `reRenderApp` | `currentUser`, `localStorage`, `DB_SUFFIX` | `processLogin` | `modules/users/auth_session.js` | **Medio**: Verificación segura contra Firebase Auth y eliminación de clave en Firestore. | `crmAuth.uiFlow.test.js` |
| **`processFirstTimeSetup(e)`** | `app_core.js:2290-2305` | DOM (`#setup-password`, `#setup-password-confirm`), `saveUserToDB`, `checkAuth`, `reRenderApp` | `pendingSetupUser`, `currentUser`, `localStorage` | Formulario `#setup-form` | `modules/users/auth_session.js` | **Bajo**: Flujo histórico legacy para cuentas sin Auth. | `crmAuth.uiFlow.test.js` |
| **`processLogout()`** | `app_core.js:2307-2318` | `detachSnapshotListeners`, `CrmAuth.signOut`, `checkAuth`, `localStorage` | `currentUser`, `clients`, `prospects`, `users`, `authSessionGeneration`, `initialRoleViewRouted` | Botón Salir en header móvil / web, fallos de sesión | `modules/users/auth_session.js` (con fachada en `app_core.js`) | **Alto**: Limpieza integral de colecciones reactivas y cancelación de listeners sin fugas. | `initialLoadAndRoleRouting.unit.test.js`, `crmAuth.uiFlow.test.js` |
| **`retryCRMDataLoad()`** | `app_core.js:1615-1712` | `firebase.auth().currentUser`, `getIdToken(true)`, `getIdTokenResult()`, `attachDataListeners`, `reRenderApp` | `currentUser`, `crmLoadError`, `authSessionGeneration` | Botón reintentar en pantallas de error | `modules/users/auth_session.js` | **Medio**: Revalidación forzada de tokens y sincronización de estado de error. | `clientStorageUiFlow.test.js`, `workflowUiFlow.test.js` |
| **`loginWithFirebase(fb, user, pass)`** | `crm_auth.js:55-67` | `fb.auth().signInWithEmailAndPassword`, `signOut` | Ninguno (inmutable) | `processFirebaseLogin`, `AuthSession` | `crm_auth.js` (conservar como cliente de bajo nivel) | **Bajo**: Ya desacoplado e inmutable. | `crmAuth.uiFlow.test.js` |
| **`findLoginUser(users, rawEmail)`** | `crm_auth.js:88-95` | Ninguno | Ninguno | `processLogin`, `AuthSession` | `crm_auth.js` | **Bajo**: Función pura de búsqueda insensible a mayúsculas para cuentas Auth. | `crmAuth.uiFlow.test.js` |
| **`signOut(fb)`** | `crm_auth.js:80-83` | `fb.auth().signOut` | Ninguno | `processLogout`, `AuthSession` | `crm_auth.js` | **Bajo**: Ya desacoplado. | `crmAuth.uiFlow.test.js` |
| **`hasManagerSession(fb)`** | `crm_auth.js:105-115` | `fb.auth()`, `getIdTokenResult()` | Ninguno | `adminCreateUser`, `adminSetUserActive`, `adminUpdateUser` | `crm_auth.js` | **Bajo**: Validador de claim `manager: true`. | `crmAuth.uiFlow.test.js` |

---

### 2.2 Roles, Permisos y Navegación

| Responsabilidad / Función | Archivo Origen | Dependencias | Estado Mutable Compartido | Consumidores | Destino Propuesto | Riesgo de Extracción | Pruebas Existentes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`applyRolePermissions()`** | `app_core.js:2320-2421` | DOM (`nav-*`, `client-action-header`, etc.), `showView`, `switchListMode`, `renderDailyAgenda`, `renderList`, `renderClientsTable`, `renderUsersTable`, `fetchAdminUsers` | `currentUser`, `currentListMode`, `initialRoleViewRouted` | `checkAuth`, `onAuthStateChanged`, inicialización | `modules/users/users_permissions.js` (con fachada en `app_core.js`) | **Crítico**: Controla visibilidad de navegación, enrutamiento inicial por rol, preservación de vista activa, y llamadas reactivas a vistas. | `initialLoadAndRoleRouting.unit.test.js`, `rolePermissionsAndUiAudit.unit.test.js` |
| **Matriz de roles y capacidades (`canAccessView`, `canManageUsers`, `canDeleteProspect`, `canEscalate`, etc.)** | Disperso en `app_core.js`, `modules/opportunities/`, `modules/finance/`, `modules/dashboard/` | `currentUser` | `currentUser.role` | Vistas, botones de acción, modales | `modules/users/users_permissions.js` (centralizado canónico) | **Medio**: Estandarizar resolución sin alterar comportamiento actual. | `rolePermissionsAndUiAudit.unit.test.js` |
| **`showView(viewId)` (guards de acceso)** | `app_core.js:2095-2125` | `currentUser.role`, DOM `.view-section`, `.nav-links` | `activeSectionId` | Handlers de navegación, `applyRolePermissions` | `modules/users/users_permissions.js` (validación de acceso) | **Medio**: Bloquea acceso a `dashboard-view` a no-managers y `users-view` a no-admins/managers. | `initialLoadAndRoleRouting.unit.test.js` |

---

### 2.3 Administración de Usuarios e Integración Backend

| Responsabilidad / Función | Archivo Origen | Dependencias | Estado Mutable Compartido | Consumidores | Destino Propuesto | Riesgo de Extracción | Pruebas Existentes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`fetchAdminUsers()`** | `app_core.js:2427-2451` | `CrmAuth.listUsersViaFunction`, `firebase`, `renderUsersTable` | `users`, `adminUsersLoading`, `currentUser`, `DB_SUFFIX` | `applyRolePermissions`, `saveUser`, `toggleUserStatus` | `modules/users/users_controller.js` | **Medio**: Consulta vía Cloud Function `listUsersAdmin`, fusión reactiva con `users` local. | `crmAuth.uiFlow.test.js`, `adminFunctions.iter7.test.js` |
| **`openUserModal(id)`** | `app_core.js:2453-2469` | DOM (`#userModal`, `#user-id-edit`, `#usr-nombre`, `#usr-email`, `#usr-rol`, `#user-modal-title`) | `users` | Botón `+ Nuevo Usuario`, botones `Editar` en tabla | `modules/users/users_ui.js` | **Bajo**: Apertura y llenado de formulario modal. | `crmAuth.uiFlow.test.js` |
| **`saveUser(e)`** | `app_core.js:2472-2553` | DOM, `CrmAuth.adminCreateUser`, `CrmAuth.adminUpdateUser`, `closeModal`, `renderUsersTable`, `fetchAdminUsers`, `saveUserToDB` | `users`, `userSaveInFlight`, `currentUser`, `DB_SUFFIX` | Formulario `#userForm` (`onsubmit`) | `modules/users/users_controller.js` (con UI en `users_ui.js` y fachada en `app_core.js`) | **Alto**: `crmAuth.uiFlow.test.js` inspecciona `saveUser` vía `between('let userSaveInFlight', ...)`; maneja idempotencia, prevención de cambio de email en cuentas Auth, y restricción de asignación de roles. | `crmAuth.uiFlow.test.js`, `createUserAdmin.test.js`, `updateUserAdmin.test.js` |
| **`renderUsersTable()`** | `app_core.js:2555-2581` | DOM (`#users-body`), `openUserModal`, `resetUserPassword`, `toggleUserStatus` | `users` | `applyRolePermissions`, `fetchAdminUsers`, `saveUser`, `toggleUserStatus` | `modules/users/users_ui.js` | **Medio**: Construcción dinámica de filas de tabla con etiquetas y botones de acción. | `crmAuth.uiFlow.test.js` |
| **`resetUserPassword(id)`** | `app_core.js:2583-2622` | `CrmUI.confirm`, `CrmAuth.sendPasswordSetupEmail`, `firebase` | `users` | Botón `Reset Pass` en tabla de usuarios | `modules/users/users_controller.js` | **Medio**: Flujo de restablecimiento seguro vía Firebase Auth; no toca Firestore directamente. | `crmAuth.uiFlow.test.js` |
| **`toggleUserStatus(id)`** | `app_core.js:2624-2653` | `CrmAuth.adminSetUserActive`, `saveUserToDB`, `renderUsersTable`, `fetchAdminUsers`, `CrmUI` | `users`, `currentUser`, `DB_SUFFIX` | Botón `Activar`/`Desactivar` en tabla de usuarios | `modules/users/users_controller.js` (con fachada en `app_core.js`) | **Alto**: `crmAuth.uiFlow.test.js` inspecciona `toggleUserStatus` vía `between('async function toggleUserStatus', 'const formatCurrency')`; prevención de auto-desactivación, llamada atómica a Cloud Function. | `crmAuth.uiFlow.test.js`, `adminFunctions.iter7.test.js` |
| **`adminCreateUser`** | `crm_auth.js:237-260` | `hasManagerSession`, `createUserViaFunction`, `sendPasswordSetupEmail` | `pendingOps` | `saveUser` | `crm_auth.js` | **Bajo**: Ya testeado y encapsulado con idempotencia. | `crmAuth.uiFlow.test.js`, `createUserAdmin.test.js` |
| **`adminSetUserActive`** | `crm_auth.js:263-275` | `hasManagerSession`, `setUserActiveViaFunction` | `pendingOps` | `toggleUserStatus` | `crm_auth.js` | **Bajo**: Ya encapsulado con idempotencia. | `crmAuth.uiFlow.test.js` |
| **`adminUpdateUser`** | `crm_auth.js:279-291` | `hasManagerSession`, `updateUserViaFunction` | `pendingOps` | `saveUser` | `crm_auth.js` | **Bajo**: Ya encapsulado con idempotencia. | `updateUserAdmin.test.js` |
| **`purgeHistoricalPassword`** | `crm_auth.js:302-307` | `fb.functions().httpsCallable('purgeHistoricalPasswordAdmin')` | Ninguno | `processDirectFirebaseAuthLogin`, `processFirebaseLogin` | `crm_auth.js` | **Bajo**: Elimina password plano en Firestore tras login exitoso. | `executeSec01Purge.unit.test.js` |
| **`listUsersViaFunction`** | `crm_auth.js:309-314` | `fb.functions().httpsCallable('listUsersAdmin')` | Ninguno | `fetchAdminUsers` | `crm_auth.js` | **Bajo**: Consulta administrativa autorizada. | `adminFunctions.iter7.test.js` |

---

## 3. INVENTARIO DE ROLES Y MATRIZ DE AUTORIZACIÓN

### 3.1 Roles Reales del Sistema
El sistema DUCTSAL ERP opera con una jerarquía bien definida de roles dividida entre el subsistema comercial/administrativo y el subsistema de fabricación/planta:

#### Roles Comerciales y Administrativos:
1. **`manager` (Gerente / Gerente General)**:
   - **Acceso a Vistas**: Todas (`dashboard-view`, `projects-view`, `list-view`, `clients-view`, `users-view`, `detail-view`, `audit-panel`).
   - **Modo de Lista Inicial**: `pipeline` (inicia en `dashboard-view`).
   - **Operaciones Autorizadas**: Alta, edición y cambio de estado de usuarios; reasignación de prospectos; resolución de escalaciones gerenciales; autorización sin contrato; eliminación de clientes/prospectos; configuración global; visualización consolidada de todo el pipeline y finanzas.
   - **Requisito de Seguridad**: Claim en Firebase Auth token `manager: true`, claim `role: 'manager'`, y `cid` comercial vinculado y activo.
2. **`admin` (Administrador de TI / Accesos)**:
   - **Acceso a Vistas**: `users-view`, `settings-view` (`nav-settings`), `list-view`, `clients-view`. NO tiene acceso a `dashboard-view` gerencial.
   - **Modo de Lista Inicial**: `pipeline` (inicia en `users-view`).
   - **Operaciones Autorizadas**: Alta y administración de usuarios, ajustes generales de configuración. NO puede autorizar escalaciones gerenciales ni eliminar clientes sin pasar por auditoría de gerencia.
3. **`gestor` (Gestor de Ventas)**:
   - **Acceso a Vistas**: `projects-view`, `list-view`, `clients-view`, `detail-view`. NO tiene acceso a `dashboard-view` ni a `users-view`.
   - **Modo de Lista Inicial**: `agenda` (inicia en `list-view`).
   - **Operaciones Autorizadas**: Gestión y seguimiento de oportunidades asignadas o creadas por él; creación y edición de propuestas; registro de órdenes de cambio; emisión de facturas y cobros; escalación gerencial; solicitud de excepción sin contrato; reactivación de perdidos autorizados.
4. **`vendedor` (Vendedor)**:
   - **Acceso a Vistas**: `projects-view` ("Mis Proyectos y Cobros Asignados"), `list-view`, `clients-view`, `detail-view`. NO tiene acceso a `dashboard-view` ni a `users-view`.
   - **Modo de Lista Inicial**: `agenda` (inicia en `list-view`).
   - **Operaciones Autorizadas**: Seguimiento de su cartera personal de prospectos y clientes vinculados; avance y retroceso de etapas en sus oportunidades; registro de bitácoras y agendamiento de acciones. Visibilidad filtrada a sus propios registros (`vendedorId == me()` o `createdBy == me()`).

#### Roles de Fábrica / Planta (Integrados en `plantAuthService` y opciones del selector de usuario):
5. **`jefe_produccion`**: Jefe de Producción.
6. **`recepcion`**: Recepción de Requerimientos.
7. **`dibujante`**: Dibujante.
8. **`operario`**: Operario de Fabricación.
9. **`control_calidad`**: Control de Calidad.
10. **`despacho`**: Despacho.

*(Autenticados vía `plantLogin` con custom tokens y claims de fábrica).*

---

## 4. ANÁLISIS DE RIESGOS Y ESTRATEGIA DE PRESERVACIÓN

### 4.1 Riesgo Crítico: Pruebas con "String Slicing" (`crmAuth.uiFlow.test.js`)
La suite de pruebas unitarias [`crmAuth.uiFlow.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/crmAuth.uiFlow.test.js) no utiliza `require('app_core.js')` de forma convencional, sino que lee el código fuente de `app_core.js` como texto y extrae bloques completos con `indexOf`:
```javascript
const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a);
  return appCore.slice(a, b);
};
```
Específicamente extrae:
- `between('let userSaveInFlight', 'function renderUsersTable')`
- `between('async function saveUser', 'function renderUsersTable')`
- `between('async function toggleUserStatus', 'const formatCurrency')`
- `between('let pendingSetupUser', 'async function processFirebaseLogin')`
- `between('function processLogout', 'function applyRolePermissions')`

**Estrategia de Preservación**:
1. Los módulos en `modules/users/` contendrán la lógica desacoplada, canónica, limpia y testeable.
2. En `app_core.js`, conservaremos las declaraciones de funciones y variables en los mismos rangos delimitados por esos marcadores, pero implementadas de forma que deleguen directamente al subsistema modular (`UsersController`, `UsersUI`, `UsersPermissions`, `AuthSession`), manteniendo a su vez compatibilidad con los entornos sandboxed que crea `crmAuth.uiFlow.test.js`.
3. Esto garantiza que las pruebas de slice textual sigan encontrando los marcadores y ejecutándose al 100%, mientras que en ejecución real del ERP y en pruebas de integración, la lógica se ejecuta a través de los nuevos módulos.

### 4.2 Invariante de Seguridad: Cero Escritores Directos a Firestore
[`jointInventory.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/jointInventory.unit.test.js) valida de forma estricta que:
```javascript
test('the only direct Firestore writer left in the CRM is saveUserToDB, kept for historical users without an Auth account (refuses profiles with authUid)', () => {
  const writers = [...src.matchAll(/collection\([^)]*\)[^;\n]*\.(set|update|delete|add)\(/g)].map(m => m[0].slice(0, 90));
  expect(writers).toEqual(['collection(`users${DB_SUFFIX}`).doc(u.id).set(']);
  expect(src).toMatch(/function saveUserToDB\(u\) \{\s*if \(u && u\.authUid\) throw/);
});
```
**Estrategia de Preservación**:
Los nuevos archivos de `modules/users/` NUNCA deben realizar llamadas directas `.set()`, `.update()`, `.delete()` o `.add()` sobre colecciones de Firestore. Toda operación de creación, actualización o cambio de estado de usuario se canaliza exclusivamente a través de Cloud Functions mediante `CrmAuth` (`createUserAdmin`, `toggleUserStatusAdmin`, `updateUserAdmin`).

---

## 5. ESTRUCTURA MODULAR PROPUESTA

Bajo el directorio `modules/users/`, se crearán los siguientes módulos:

```
modules/users/
├── auth_session.js          # Ciclo de vida de sesión, login, logout, sincronización y listener de Auth
├── users_permissions.js     # Resolución de permisos, roles, visibilidad en DOM y enrutamiento inicial
├── users_controller.js      # Orquestación de datos de usuarios, operaciones administrativas y llamadas backend
└── users_ui.js              # Renderizado de tabla de usuarios, control de modal de usuario y mensajes
```

### 5.1 `modules/users/users_permissions.js`
- **Rol y Capacidades**:
  - `ROLES`: constante con `manager`, `admin`, `gestor`, `vendedor` y roles de planta.
  - `getRoleDisplayName(role)`: traducción oficial a nombres legibles ('Gerente', 'Gestor de Ventas', 'Vendedor', etc.).
  - `canAccessView(user, viewId)`: reglas para permitir/bloquear vistas.
  - `canManageUsers(user)`: autoriza solo a `manager` y `admin`.
  - `canExecuteManagerActions(user)`: requiere `role === 'manager'` y token claim `manager === true`.
  - `applyRolePermissions(deps)`: lógica de visualización de barras de navegación, configuración del modo de lista (`pipeline` vs `agenda`), y enrutamiento inicial o preservación de vista activa.

### 5.2 `modules/users/users_ui.js`
- **Renderizado e Interacción DOM**:
  - `renderUsersTable(deps)`: genera el HTML de filas en `#users-body` con badges de estado, roles traducidos y botones de acción contextuales.
  - `openUserModal(deps, id)`: prepara y abre el modal `#userModal` en modo registro o edición.
  - `closeUserModal(deps)`: cierra el modal `#userModal`.

### 5.3 `modules/users/users_controller.js`
- **Operaciones de Datos y Backend**:
  - `fetchAdminUsers(deps)`: coordina la carga administrativa desde `CrmAuth.listUsersViaFunction` e integra los resultados a la lista reactiva de usuarios.
  - `saveUser(deps, event)`: orquesta la validación de unicidad de email, verificación de credenciales de gerente, prevención de modificación de email en usuarios Auth, llamada idempotente a `CrmAuth.adminCreateUser` o `CrmAuth.adminUpdateUser`, y refresco de interfaz.
  - `toggleUserStatus(deps, id)`: valida que el usuario no se desactive a sí mismo y ejecuta `CrmAuth.adminSetUserActive` de forma idempotente.
  - `resetUserPassword(deps, id)`: ejecuta la confirmación de usuario y envía el correo oficial de restablecimiento vía `CrmAuth.sendPasswordSetupEmail`.

### 5.4 `modules/users/auth_session.js`
- **Sesión, Login y Logout**:
  - `checkAuth(deps)`: conmuta visibilidad entre `#main-app`, `#login-screen` y `#setup-screen`, e invoca permisos por rol.
  - `processLogin(deps, event)`: valida formulario, consulta usuario vía `CrmAuth.findLoginUser`, y deriva a `processFirebaseLogin` o `processDirectFirebaseAuthLogin`.
  - `processFirebaseLogin(deps, user, pass)`: autentica credenciales con Firebase Auth y purga contraseña histórica si existiese.
  - `processDirectFirebaseAuthLogin(deps, email, pass)`: autenticación directa contra Firebase Auth con verificación de claims en token y estado en Firestore.
  - `processLogout(deps)`: desuscribe listeners de Firestore, limpia colecciones en memoria, revoca sesión de Firebase Auth con `CrmAuth.signOut` y purga `localStorage`.
  - `setupAuthListener(deps)`: listener centralizado `onAuthStateChanged` con validación estricta de claims y control de generación (`authSessionGeneration`).

---

## 6. PLAN DE EJECUCIÓN AUTÓNOMA

1. **Subfase 6.6.1**: Implementar `modules/users/users_permissions.js`.
2. **Subfase 6.6.2**: Implementar `modules/users/users_ui.js`.
3. **Subfase 6.6.3**: Implementar `modules/users/users_controller.js`.
4. **Subfase 6.6.4**: Implementar `modules/users/auth_session.js`.
5. **Subfase 6.6.5**: Conectar en `index.html` los nuevos scripts en el orden de dependencias correcto antes de `app_core.js`.
6. **Subfase 6.6.6**: Configurar en `app_core.js` la inyección de dependencias y fachadas hacia los nuevos módulos de usuarios, preservando compatibilidad con los marcadores textuales de `crmAuth.uiFlow.test.js`.
7. **Subfase 6.6.7**: Actualizar `jointInventory.unit.test.js` para incorporar los nuevos módulos en `CRM_CLIENT_FILES`.
8. **Subfase 6.6.8**: Crear suite de pruebas unitarias exhaustiva `functions/__tests__/usersModules.unit.test.js`.
9. **Subfase 6.6.9**: Ejecutar la suite completa de pruebas Jest (`npm test`), validando que los 76 suites actuales más la nueva suite pasen al 100%.
10. **Subfase 6.6.10**: Elaborar reporte de cierre de fase `docs/FASE_6_6_MODULARIZACION_USUARIOS.md`.
