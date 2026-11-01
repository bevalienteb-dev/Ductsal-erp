# DUCTSAL ERP — FASE 6.7: REDUCCIÓN FINAL DE app_core.js Y ESTADO CENTRAL / ROUTER

## 1. RESUMEN EJECUTIVO

La **Fase 6.7** concluye la modularización arquitectónica del CRM DUCTSAL mediante dos piezas estructurales fundamentales:
1. **`core/app_state.js`**: Estado centralizado de la aplicación organizado en dominios coherentes (`session`, `collections`, `selection`, `navigation`, `filters`, `lifecycle`), con sincronización bidireccional reactiva (`syncWithScope`) hacia el ámbito global y bus de eventos desacoplado (`subscribe` / `notify`).
2. **`core/app_router.js`**: Enrutador centralizado que asume el control de vistas (`showView`), enrutamiento inicial basado en roles (`routeInitialView`), control de acceso a vistas protegidas según matriz de seguridad, sincronización de encabezados móviles e invariantes de scroll de listado (`saveListScrollPosition` / `restoreListScrollPosition`).
3. **Reducción de `app_core.js`**: Limpieza de variables residuales de dashboards obsoletas (`chartFunnel`, etc.), delegación de responsabilidades de enrutamiento y estado hacia `AppRouter` y `AppState`, conservando el 100% de las firmas y fachadas de compatibilidad requeridas por los módulos existentes y las suites de pruebas automatizadas.

**Resultado de Validación Automatizada:**
- **Test Suites:** 81/81 aprobadas (100%).
- **Pruebas:** 2,168/2,168 aprobadas (100%).
- **Regresiones:** 0.

---

## 2. MAPA DE ARCHIVOS CREADOS Y ACTUALIZADOS

| Archivo | Rol Arquitectónico | Estado |
| :--- | :--- | :--- |
| `core/app_state.js` | Estado centralizado organizado por dominios | Creado |
| `core/app_router.js` | Enrutador y controlador de vistas y navegación | Creado |
| `index.html` | Carga secuencial de scripts UMD/IIFE | Actualizado |
| `app_core.js` | Núcleo de inicialización, integración Firebase y fachadas | Reducido / Delegado |
| `functions/__tests__/appState.unit.test.js` | Suite de 16 pruebas unitarias para AppState | Creado (16/16 pass) |
| `functions/__tests__/appRouter.unit.test.js` | Suite de 11 pruebas unitarias para AppRouter | Creado (11/11 pass) |
| `docs/FASE_6_7_INVENTARIO_ESTADO.md` | Inventario exhaustivo del estado global | Creado |
| `docs/FASE_6_7_REDUCCION_APP_CORE.md` | Informe final de clasificación y reducción | Creado |

---

## 3. CLASIFICACIÓN DE FUNCIONES RESTANTES EN app_core.js

De acuerdo con las directrices de la Fase 6.7, cada sección y función restante en `app_core.js` ha sido categorizada según su rol arquitectónico:

### Categoría A — Inicialización Esencial del CRM e Integración Firebase
Funciones que constituyen el punto de entrada y ciclo de vida de la infraestructura del CRM:
- **Configuración e inicialización Firebase (`firebaseConfig`, `CRM_EMULATOR_MODE`, `db.settings`, etc.)**: Inicialización del runtime y compatibilidad con emuladores.
- **`attachDataListeners(role, userId)`**: Suscripciones `onSnapshot` acotadas por rol y UID a `system/settings`, `userDirectory`, `clients` y `prospects` conforme a las reglas Firestore.
- **`detachSnapshotListeners()`**: Limpieza de suscripciones activas y reinicio del ciclo de vida en `AppState.lifecycle`.
- **`checkInitialLoad()`**: Barrera de sincronización reactiva (cuenta de 3 colecciones requeridas) que dispara el renderizado inicial de la aplicación.
- **`reRenderApp()`**: Orquestación de refresco de la UI ante mutaciones reactivas del estado.
- **`document.addEventListener('DOMContentLoaded', ...)`**: Detección de emuladores, detección de residuos locales y guardia de sesión de `firebase.auth().onAuthStateChanged`.

### Categoría B — Fachadas de Compatibilidad Temporal y Redirección
Funciones expuestas globalmente para garantizar que el DOM (`onclick`, formularios HTML) y las pruebas automatizadas heredadas sigan operando sin alteraciones:
- **`showView(viewId)`**: Fachada que delega inmediatamente en `AppRouter.showView(viewId)`, conservando fallback de seguridad y sincronización de barra sticky móvil.
- **`saveListScrollPosition()`**: Fachada que delega en `AppRouter.saveListScrollPosition()`.
- **`restoreListScrollPosition()`**: Fachada que delega en `AppRouter.restoreListScrollPosition()`.
- **`applyRolePermissions()`**: Fachada que delega en `UsersPermissions.applyRolePermissions()`, conservando la estructura inspectable para pruebas estáticas.
- **`checkAuth()`**: Fachada que delega en `AuthSession.checkAuth()`.
- **`processLogout()`**: Fachada que invoca `AppState.resetAll()`, `AppRouter.resetRouterState()` y `CrmAuth.signOut()`.
- **`fetchAdminUsers()`**: Fachada que delega en `UsersController.fetchAdminUsers()`.
- **`openUserModal(id)`**: Fachada que delega en `UsersUI.openUserModal()`.
- **`saveUser(e)`**: Fachada que delega en `UsersController.saveUser()`.
- **`toggleUserStatus(id)`**: Fachada que delega en `UsersController.toggleUserStatus()`.
- **`resetUserPassword(id)`**: Fachada que delega en `UsersController.resetUserPassword()`.
- **`renderUsersTable()`**: Fachada que delega en `UsersUI.renderUsersTable()`.
- **Fachadas Comerciales y Financieras**: `deleteInvoice`, `deletePayment`, `deleteProspect`, `reactivateLostProspect`, `formatProspectDate`, `parseProspectDate`, `clearOppDateFilter`, `toggleOppSort`, `reassignVendor`, delegando a sus respectivos controladores extraídos en Fases 6.1 a 6.4.

### Categoría C — Funciones Compartidas Sin Módulo Propietario Aislado
Funciones de utilidad compartida y soporte operativo que permanecen en el núcleo hasta fases posteriores o consolidación:
- **`hasEnteredPostclosing(p)`**: Verificador canónico de postcierre y elegibilidad de proyectos.
- **`runWorkflowOp(msg, op)`**: Envoltorio de operaciones asíncronas con feedback visual de progreso.
- **`uploadFileToStorage(file, path, ...)`**: Gestión de subidas a Firebase Storage, compresión de imágenes y cálculo de progreso global (`updateGlobalProgress`).
- **`compressImage(file, maxDimension, quality)`**: Compresión canvas en cliente para optimización de almacenamiento.
- **`saveUserToDB(u)`**: Escritor directo restringido a perfiles históricos sin cuenta Auth, con guardias estrictas (`authUid` prohibido, roles privilegiados denegados, contraseñas eliminadas).

### Categoría D — Funciones Extraídas a Módulos Propietarios en Fase 6.7
Funciones cuya responsabilidad fue trasladada íntegramente a `core/app_state.js` y `core/app_router.js`:
1. **Control de Vistas y Permisos de Navegación**:
   - `AppRouter.showView(viewId, options)`
   - `AppRouter.canUserAccessView(viewId, user)`
   - `AppRouter.routeInitialView(user)`
   - `AppRouter.syncMobileHeader(viewId)`
2. **Preservación de Estado de Desplazamiento**:
   - `AppRouter.saveListScrollPosition()`
   - `AppRouter.restoreListScrollPosition()`
   - `AppRouter.getLastListScrollY()`
3. **Gestión Centralizada del Estado**:
   - `AppState.session` (`currentUser`, `generation`, `pendingSetupUser`)
   - `AppState.collections` (`clients`, `prospects`, `users`, `settings`)
   - `AppState.selection` (`currentProspectId`)
   - `AppState.navigation` (`currentView`, `lastViewedSection`, `currentListMode`)
   - `AppState.filters` (`opportunities`, `agenda`)
   - `AppState.lifecycle` (`loadedCollections`, `initialLoadCompleted`, `initialRoleViewRouted`, etc.)

### Categoría E — Código Obsoleto o Duplicado Eliminado de app_core.js
Líneas de código demostradas como redundantes o sin referencias funcionales:
- **Variables de Gráficos Residuales**: `let chartFunnel = null; let chartProduct = null; let chartProject = null; let chartOrigin = null; let chartLoss = null; let chartOppProduct = null; let chartOppProject = null; let chartMonthly = null; let chartSeller = null;` eliminadas (el estado de renderizado reside en `modules/dashboard/dashboard_charts.js`).
- **Control de estado en vuelo duplicado**: Declaraciones huérfanas reemplazadas por los controles de concurrencia y flags residentes en los controladores de dominio correspondientes.

---

## 4. DISEÑO Y COMPORTAMIENTO DE core/app_state.js

### 4.1 Principios de Diseño
1. **Fuente Única de Verdad**: Todo el estado compartido reside en un único registro desacoplado por dominios, evitando discrepancias entre módulos.
2. **Sincronización Bidireccional Reactiva (`syncWithScope`)**: Utiliza `Object.defineProperty` para vincular getters y setters en el objeto global (`window`), permitiendo que el código legado y las pruebas que acceden a `currentUser`, `clients`, `prospects`, etc., interactúen de forma transparente con el estado central sin romper retrocompatibilidad.
3. **Sistema Pub/Sub (`subscribe` / `notify`)**: Permite que cualquier módulo u observador reaccione a eventos de cambio (por ejemplo `session:user`, `collections:prospects`, `navigation:view`, `lifecycle:reset`) sin acoplamiento directo.
4. **Reseteo Seguro en Cierre de Sesión (`resetAll`)**: Limpieza atómica de todos los dominios durante el logout para evitar fugas de memoria o datos entre sesiones de usuario.

### 4.2 Dominios Implementados
- **`session`**: Almacena el usuario autenticado, generación de token y usuario pendiente de configuración inicial.
- **`collections`**: Almacena los catálogos en memoria (`clients`, `prospects`, `users`, `settings`).
- **`selection`**: Mantiene la oportunidad/proyecto activo (`currentProspectId`).
- **`navigation`**: Controla la vista activa (`currentView`), última sección visitada (`lastViewedSection`) y modo de listado (`currentListMode`: agenda vs. pipeline).
- **`filters`**: Parámetros de ordenamiento y filtrado de cartera y agenda.
- **`lifecycle`**: Variables de arranque y sincronización de red (`loadedCollections`, `initialLoadCompleted`, `initialRoleViewRouted`, `activeUnsubscribers`, `crmLoadError`).

---

## 5. DISEÑO Y COMPORTAMIENTO DE core/app_router.js

### 5.1 Principios de Seguridad y Navegación
1. **No Autoridad de Seguridad Primaria**: El router valida roles para guiar la interfaz visual, pero la autorización real está protegida incondicionalmente por Firestore Security Rules y Cloud Functions en el backend.
2. **Protección Anti-Spoofing en Consola/DOM**: Intentar invocar `showView('dashboard-view')` o alterar el DOM siendo `vendedor` o `gestor` es rechazado inmediatamente con alerta y redirección forzada a `list-view`.
3. **Enrutamiento Inicial por Rol (`routeInitialView`)**:
   - `manager`: Redirige automáticamente a `dashboard-view` en modo Cartera Completa / Pipeline.
   - `admin`: Redirige a `users-view`.
   - `gestor` / `vendedor`: Redirigen a `list-view` en modo Agenda Diaria de Seguimiento.
4. **Preservación de Estado de Listado y Desplazamiento**: Guarda y restaura con precisión milimétrica la posición vertical del scroll (`lastListScrollY`) al navegar entre el listado y el detalle de oportunidad.
5. **Sincronización de Encabezados Móviles**: Alterna dinámicamente entre `#mobile-header-default` y `#detail-mobile-sticky-bar` según si se visualiza `detail-view` u otra sección.

---

## 6. VALIDACIÓN DE PRUEBAS AUTOMATIZADAS

### 6.1 Resumen Global
Se ejecutaron todas las suites de pruebas del proyecto (`npm test` en `functions/`):
- **Total Test Suites:** 81 passed, 81 total.
- **Total Tests:** 2,168 passed, 2,168 total.
- **Tiempo de Ejecución:** ~7.8 segundos.
- **Snapshots:** 0 fallidos.

### 6.2 Cobertura de Pruebas de la Fase 6.7
1. **`appState.unit.test.js` (16 pruebas)**:
   - Inicialización por dominios (`session`, `collections`, `selection`, `navigation`, `filters`, `lifecycle`).
   - Persistencia y recuperación en `localStorage`.
   - Despacho reactivo de eventos mediante `subscribe` y `notify`.
   - Puente reactivo `syncWithScope(window)` con getters y setters funcionales.
   - Reseteo integral en logout (`resetAll`).
2. **`appRouter.unit.test.js` (11 pruebas)**:
   - Control de acceso y denegación por rol en `showView`.
   - Autorización de vistas legítimas (`users-view` para admin, `dashboard-view` para manager).
   - Guardado y restauración del scroll (`saveListScrollPosition`, `restoreListScrollPosition`).
   - Enrutamiento inicial determinista por rol (`routeInitialView`).
   - Sincronización de encabezados móviles integrado en `showView`.
   - Reseteo de flags de navegación en cierre de sesión (`resetRouterState`).

---

## 7. CONCLUSIÓN Y PRÓXIMOS PASOS

La Fase 6.7 concluye con éxito todos sus objetivos:
- Estado central unificado en `core/app_state.js`.
- Router y navegación modularizados en `core/app_router.js`.
- Reducción y depuración de `app_core.js`, preservando el 100% de la funcionalidad histórica y la compatibilidad con todas las fases anteriores (6.1 a 6.6).
- 81 suites y 2,168 pruebas verificadas sin regresiones.

**Nota:** Conforme al alcance acordado, **no se inicia la consolidación general de las fases 6.1–6.7**. La fase actual queda cerrada y lista para inspección.
