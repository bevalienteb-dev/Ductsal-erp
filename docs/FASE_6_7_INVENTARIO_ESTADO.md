# DUCTSAL ERP — INVENTARIO DEL ESTADO GLOBAL (FASE 6.7 - ETAPA A)
## Subsistema de Estado, Datos Compartidos, Ciclo de Vida y Navegación

---

## 1. INTRODUCCIÓN Y ALCANCE

En el marco de la **Fase 6.7 (Estado central, router y reducción final de `app_core.js`)**, esta Etapa A realiza una auditoría e inventario exhaustivo de todo el estado mutable, variables globales, colecciones compartidas, flags de ciclo de vida, filtros, referencias de sesión y dependencias cruzadas en DUCTSAL ERP.

El propósito de este inventario es clasificar formalmente qué propiedades constituyen **Estado Central Compartido** que debe migrar a `core/app_state.js`, cuáles pertenecen a la responsabilidad de navegación en `core/app_router.js`, y cuáles son **Estado Privado Encapsulado** que debe permanecer dentro de los módulos específicos extraídos en las Fases 6.1 a 6.6.

---

## 2. ARQUITECTURA ACTUAL DEL ESTADO

Actualmente, el estado de la aplicación reside en tres niveles superpuestos:
1. **Variables Globales en `app_core.js`**: Declaradas en el ámbito léxico del script principal (`clients`, `prospects`, `users`, `currentUser`, `currentProspectId`, `settings`, etc.), sincronizadas con el objeto global `window` para compatibilidad con handlers en línea de `index.html`.
2. **Dependencias Inyectadas en Módulos (`_deps`)**: Módulos como `ClientsController`, `OpportunitiesController`, `FinanceController`, `DashboardController`, `UsersController` y `DocumentViewer` leen y escriben el estado mediante closures y accesores inyectados (`getCurrentUser()`, `getProspects()`, `getClients()`, `setClients()`).
3. **Estado Privado por Módulo**: Variables de instancia local encapsuladas dentro de IIFEs (por ejemplo, instancias de gráficos Chart.js en `DashboardCharts`, flags de carga en `UsersController`, reservas en `ClientsController`).

---

## 3. INVENTARIO DETALLADO DE VARIABLES

### 3.1 Dominio: Sesión y Autenticación

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`currentUser`** | `JSON.parse(localStorage.getItem('ductsal_current_user')) \|\| null` | `Object \| null` | `app_core.js`, `auth_session.js`, `users_permissions.js`, `users_controller.js`, `clients_controller.js`, `client_documents.js`, `opportunities_controller.js`, `opportunities_ui.js`, `finance_controller.js`, `finance_ui.js`, `finance_change_orders.js`, `finance_invoicing.js`, `finance_payments.js`, `dashboard_controller.js`, `dashboard_ui.js`, `dashboard_manager_workflow.js`, `document_viewer.js` | `auth_session.js` (login, logout, direct login), `app_core.js` | **Sí** | **Sí** (`localStorage`) | **Sí** | **`AppState.session.currentUser`** (Fuente única de verdad). |
| **`pendingSetupUser`** | `null` | `Object \| null` | `auth_session.js`, `app_core.js` | `auth_session.js`, `app_core.js` | No | No | Sí | **Privado de `AuthSession`** con acceso vía `AppState.session.pendingSetupUser`. |
| **`authSessionGeneration`** | `0` | `number` | `auth_session.js`, `app_core.js` | `auth_session.js`, `app_core.js` (logout, retry) | **Sí** | No | Sí | **`AppState.session.generation`** (Control de concurrencia e invalidación de race conditions). |

---

### 3.2 Dominio: Colecciones de Datos Principales (Firestore)

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`clients`** | `[]` | `Array<Object>` | `app_core.js`, `clients_controller.js`, `clients_ui.js`, `client_documents.js`, `opportunities_controller.js`, `opportunities_ui.js`, `finance_ui.js`, `finance_invoicing.js`, `finance_payments.js`, `crm_clients.js` | `app_core.js` (listener Firestore `clients_prod`), `clients_controller.js` (creación/edición), `auth_session.js` (logout) | **Sí** | No (Firestore) | Sí | **`AppState.collections.clients`** (Colección central compartida). |
| **`prospects`** | `[]` | `Array<Object>` | `app_core.js`, `opportunities_controller.js`, `opportunities_ui.js`, `finance_controller.js`, `finance_ui.js`, `finance_change_orders.js`, `finance_invoicing.js`, `finance_payments.js`, `dashboard_controller.js`, `dashboard_ui.js`, `dashboard_charts.js`, `dashboard_audit.js`, `dashboard_manager_workflow.js`, `clients_controller.js`, `client_documents.js` | `app_core.js` (listener Firestore `prospects_prod`), `opportunities_controller.js`, `auth_session.js` (logout) | **Sí** | No (Firestore) | Sí | **`AppState.collections.prospects`** (Colección central compartida). |
| **`users`** | `[]` | `Array<Object>` | `app_core.js`, `users_controller.js`, `users_ui.js`, `opportunities_controller.js`, `opportunities_ui.js`, `dashboard_controller.js`, `dashboard_ui.js`, `dashboard_charts.js`, `crm_followup_calc.js` | `app_core.js` (listener Firestore `users_prod`), `users_controller.js` (`fetchAdminUsers`), `auth_session.js` (logout) | **Sí** | No (Firestore) | Sí | **`AppState.collections.users`** (Colección central compartida). |
| **`settings`** | `{ visitantes: [], encargados: [], gmaps_api_key: "", factory_address: "" }` | `Object` | `app_core.js`, `opportunities_ui.js` | `app_core.js` (listener Firestore `system/settings`, `applySettingsChange`), `auth_session.js` (logout) | **Sí** | No (Firestore) | No | **`AppState.collections.settings`** (Colección central compartida). |

---

### 3.3 Dominio: Navegación y Vistas

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`currentView`** | `'list-view'` (o según rol) | `string` | `app_core.js` (`reRenderApp`), pruebas automatizadas, DOM | `app_core.js` (`showView`), `users_permissions.js` (`applyRolePermissions`), `AppRouter` | **Sí** | No | Sí | **`AppRouter.currentView`** / **`AppState.navigation.currentView`**. |
| **`lastViewedSection`** | `'list-view'` | `string` | `app_core.js`, `opportunities_ui.js` (`goBackFromDetail`) | `app_core.js` (`showView`), `AppRouter` | No | No | Sí | **`AppRouter.lastViewedSection`** / **`AppState.navigation.lastViewedSection`**. |
| **`currentListMode`** | `'agenda'` | `string` (`'agenda'` \| `'pipeline'`) | `app_core.js`, `opportunities_ui.js`, `users_permissions.js`, pruebas de enrutamiento | `app_core.js` (`switchListMode`, `showView`), `users_permissions.js`, `AppRouter` | **Sí** | No | Sí | **`AppRouter.currentListMode`** / **`AppState.navigation.currentListMode`**. |
| **`lastListScrollY`** | `0` | `number` | `app_core.js`, `opportunities_ui.js` | `app_core.js` (`saveListScrollPosition`, `restoreListScrollPosition`), `AppRouter` | No | No | Sí | **Privado de `AppRouter`**. |

---

### 3.4 Dominio: Selección y Detalle

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`currentProspectId`** | `null` | `string \| null` | `app_core.js`, `document_viewer.js`, `opportunities_ui.js`, `finance_change_orders.js`, `finance_invoicing.js`, `finance_payments.js`, `finance_ui.js`, `finance_contracts.js` | `opportunities_ui.js` (`openDetail`), `app_core.js` (`openDetail`, `closeModal`) | **Sí** | No | Sí | **`AppState.selection.currentProspectId`** (Fuente única de verdad). |

---

### 3.5 Dominio: Filtros y Ordenamiento

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`oppSortCol` / `oppSortDir`** | `''` / `'asc'` | `string` | `opportunities_controller.js`, `opportunities_ui.js`, `app_core.js` | `opportunities_controller.js` (`toggleOppSort`), `app_core.js` | Sí | No | Sí | Gestionado por `OpportunitiesController`, reflejado en `AppState.filters.opportunities`. |
| **`oppStatusFilter`, `oppClasifFilter`, `oppStageFilter`** | `'activas'`, `'todas'`, `'todas'` | `string` | `opportunities_controller.js`, `opportunities_ui.js`, `app_core.js` | `opportunities_controller.js`, `app_core.js` | Sí | No | Sí | Gestionado por `OpportunitiesController`, reflejado en `AppState.filters.opportunities`. |
| **`currentAgendaFilter`** | `'todas'` | `string` | `app_core.js`, `opportunities_ui.js` | `app_core.js` (`filterAgenda`), `opportunities_ui.js` | Sí | No | Sí | **`AppState.filters.agenda`**. |
| **`projSortCol` / `projSortDir`** | `''` / `'asc'` | `string` | `finance_controller.js`, `finance_ui.js`, `app_core.js` | `finance_controller.js` | Sí | No | Sí | **Privado de `FinanceController`** (con fachada pública). |
| **`projPaymentFilter`** | `'pendientes'` | `string` | `finance_controller.js`, `finance_ui.js`, `app_core.js` | `finance_controller.js` | Sí | No | Sí | **Privado de `FinanceController`** (con fachada pública). |
| **`cliSortCol` / `cliSortDir`** | `''` / `'asc'` | `string` | `clients_ui.js`, `app_core.js` | `clients_ui.js`, `app_core.js` | Sí | No | Sí | **Privado de `ClientsController` / `ClientsUI`**. |
| **`_currentSellerFilterMode`** | `'active_only'` | `string` | `dashboard_controller.js`, `dashboard_ui.js` | `dashboard_controller.js` | Sí | No | Sí | **Privado de `DashboardController`**. |

---

### 3.6 Dominio: Ciclo de Vida, Listeners y Carga Inicial

| Variable | Valor Inicial | Tipo | Módulos Lectores | Módulos Escritores | Reactiva | Persistente | Específica de Sesión | Destino Arquitectónico |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`loadedCollections`** | `0` | `number` | `app_core.js` | `app_core.js` (incrementado al recibir el snapshot de cada colección) | Sí | No | Sí | **`AppState.lifecycle.loadedCollections`**. |
| **`initialLoadCompleted`** | `false` | `boolean` | `app_core.js`, suites de prueba | `app_core.js` (establecido en `true` cuando `loadedCollections >= 4`) | Sí | No | Sí | **`AppState.lifecycle.initialLoadCompleted`**. |
| **`initialRoleViewRouted`** | `false` | `boolean` | `app_core.js`, `users_permissions.js`, `AppRouter`, pruebas de inicio | `users_permissions.js`, `app_core.js`, `AppRouter` | Sí | No | Sí | **`AppRouter.initialRoleViewRouted`** / **`AppState.lifecycle.initialRoleViewRouted`**. |
| **`activeUnsubscribers`** | `[]` | `Array<Function>` | `app_core.js` | `app_core.js` (listeners Firestore) | No | No | Sí | **`AppState.lifecycle.activeUnsubscribers`**. |
| **`currentSubscribedUser`** | `null` | `{ uid, role } \| null` | `app_core.js` | `app_core.js` (`attachDataListeners`, `detachSnapshotListeners`) | Sí | No | Sí | **`AppState.lifecycle.currentSubscribedUser`**. |
| **`crmLoadError`** | `null` | `Object \| null` | `app_core.js` (`reRenderApp`) | `app_core.js` (`handleListenerError`, `retryDataListeners`) | Sí | No | Sí | **`AppState.lifecycle.crmLoadError`**. |

---

### 3.7 Variables Obsoletas o Duplicadas en `app_core.js` (Candidatas a Limpieza)

Las siguientes variables son residuos históricos de versiones monolíticas anteriores a las Fases 6.1–6.6, cuyas implementaciones reales residen ahora dentro de sus módulos correspondientes:

1. **Instancias de Gráficos Chart.js** (`chartFunnel`, `chartProduct`, `chartProject`, `chartOrigin`, `chartLoss`, `chartOppProduct`, `chartOppProject`, `chartMonthly`, `chartSeller`):
   - *Estado real*: `modules/dashboard/dashboard_charts.js` gestiona sus propias referencias privadas (`_chartMonthly`, `_chartOrigin`, etc.). Las variables en `app_core.js` nunca se leen ni se actualizan en el flujo moderno.
2. **Flags de Modales y Cargas Administrativas** (`adminUsersLoading`, `userSaveInFlight`):
   - *Estado real*: `modules/users/users_controller.js` mantiene sus propios flags internos (`adminUsersLoading`, `userSaveInFlight`). Las copias en `app_core.js` son duplicadas.
3. **Reservas y Búsqueda de Clientes** (`currentClientReservationId`, `catalogueSearchActive`):
   - *Estado real*: Encapsuladas en `modules/clients/clients_controller.js`.

---

## 4. MATRIZ DE CLASIFICACIÓN: COMPARTIDO VS PRIVADO

```
========================================================================================
ESTADO CENTRAL COMPARTIDO (AppState)
========================================================================================
├── session
│   ├── currentUser           (Identidad, rol, claims, sincronizado con localStorage)
│   ├── pendingSetupUser      (Transición de primer ingreso)
│   └── generation            (Contador de invalidación asíncrona)
├── collections
│   ├── clients               (Catálogo de clientes Firestore)
│   ├── prospects             (Cartera de oportunidades/proyectos Firestore)
│   ├── users                 (Catálogo de usuarios comerciales Firestore)
│   └── settings              (Ajustes generales del sistema Firestore)
├── selection
│   └── currentProspectId     (Oportunidad/proyecto actualmente abierto en detalle)
├── navigation
│   ├── currentView           (Vista activa: dashboard-view, list-view, etc.)
│   ├── lastViewedSection     (Vista de retorno tras detalle)
│   └── currentListMode       (Modo de lista: 'pipeline' | 'agenda')
└── lifecycle
    ├── loadedCollections     (Contador de colecciones sincronizadas)
    ├── initialLoadCompleted  (Bandera de carga completada)
    ├── initialRoleViewRouted (Bandera de enrutamiento inicial ejecutado)
    ├── currentSubscribedUser (Usuario actualmente suscrito a listeners)
    └── crmLoadError          (Error de permisos/red en listeners)

========================================================================================
ESTADO PRIVADO ENCAPSULADO (Módulos específicos)
========================================================================================
├── FinanceController
│   ├── _projPaymentFilter    (Filtro local de pagos: pendientes/pagados/todos)
│   └── _projSortCol / _Dir   (Ordenamiento de tabla de proyectos)
├── DashboardController & DashboardCharts
│   ├── _currentSellerFilterMode (Filtro activo/todos de vendedores)
│   └── _charts (8 instancias)   (Instancias nativas de Chart.js)
├── ClientsController
│   ├── _reservationId        (Reserva atómica de NIT/DUI en curso)
│   └── _catalogueSearchActive(Búsqueda asíncrona en catálogo remoto)
├── UsersController
│   ├── _adminUsersLoading    (Flag de petición a Cloud Function listUsersAdmin)
│   └── _userSaveInFlight     (Flag de concurrencia en guardado de usuario)
└── AppRouter
    └── _lastListScrollY      (Posición vertical de scroll para retorno suave)
```

---

## 5. DEPENDENCIAS CIRCULARES Y REFERENCIAS CRUZADAS

Durante la auditoría se identificaron las siguientes dependencias cruzadas que deben ser desacopladas mediante el Estado Central y el Router:

1. **`app_core.js` ↔ `UsersPermissions` ↔ `AppRouter`**:
   - `applyRolePermissions` en `app_core.js` duplicaba lógica de visibilidad y enrutamiento que ya existe en `UsersPermissions`.
   - *Solución*: `AppRouter` utilizará `UsersPermissions.canAccessView` para autorización y `AppState` para consultar el usuario actual, mientras que `applyRolePermissions` delegará formalmente en `UsersPermissions.applyRolePermissions`.
2. **`opportunities_ui.js` ↔ `finance_ui.js` / `document_viewer.js`**:
   - Módulos de finanzas y visor leen `currentProspectId` directamente del ámbito global.
   - *Solución*: `AppState.selection.getCurrentProspectId()` y `AppState.selection.setCurrentProspectId()` actuarán como canal único y documentado, manteniendo sincronizada la variable global `window.currentProspectId`.
3. **`auth_session.js` ↔ `app_core.js` (Listeners y Renderers)**:
   - `auth_session.js` necesita ejecutar `attachDataListeners`, `reRenderApp` y limpiar estructuras.
   - *Solución*: Inyección limpia de callbacks a través de `AppState.subscribe` o eventos de ciclo de vida, evitando acoplamientos rígidos.

---

## 6. CONCLUSIÓN DE LA ETAPA A

El inventario demuestra que el estado de DUCTSAL ERP no es caótico, sino que se agrupa de forma natural en **5 dominios compartidos** (`session`, `collections`, `selection`, `navigation`, `lifecycle`).

Crear `core/app_state.js` organizado en estos 5 dominios y `core/app_router.js` para la navegación resolverá la dispersión actual, permitirá eliminar las variables residuales obsoletas de `app_core.js` y preservará el 100% de compatibilidad con las suites de prueba existentes.
