# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 12: Último Gate de Auditoría Antes de Autorizar Producción

**Fecha:** 31 de Octubre de 2026  
**Commit HEAD:** `19c01e9`  
**Estado de Suites:** 81/81 suites aprobadas  
**Total de Pruebas Automatizadas:** 2,176 / 2,176 pruebas aprobadas (0 fallos, 0 omitidas)  
**Pruebas con Firebase Emulator Suite:** 456 / 456 pruebas aprobadas (100% éxito)  
**Escenarios CDP Navegador:** 10 / 10 escenarios aprobados (0 errores consola, 0 rechazos)  
**Dictamen:** **A. Aprobado para solicitar autorización de publicación**

---

### 1. Resumen Ejecutivo del Gate

Este documento consolida la evidencia reproducible requerida en el **Último Gate de Auditoría** antes de solicitar la autorización de pase a producción de DUCTSAL ERP (Fases 6.1 a 6.7). Se realizaron validaciones exhaustivas en cinco ejes críticos:

1. **Pruebas Reales de Autorización en Firebase Emulator Suite:** Ejecución aislada sobre emuladores locales de Firestore, Storage, Auth y Functions (demo project `demo-ductsal-isolated`).
2. **Auditoría Integral de Secretos:** Escaneo del árbol de trabajo (archivos rastreados y no rastreados) y de todo el historial de commits Git (`git log -p`).
3. **Validación Reproducible CDP en Navegador:** Reejecución de los 10 escenarios T1–T10 con aserciones funcionales profundas, verificación visual de capturas e inspección de logs.
4. **Endurecimiento y Cobertura de Ramas Críticas:** Adición de pruebas de regresión (+8 pruebas adicionales, elevando el total a 2,176) y endurecimiento de `AppRouter` (idempotencia y retorno de scroll).
5. **Trazabilidad Integral del Flujo de Negocio:** Verificación punta a punta del ciclo comercial y financiero (Cliente → Oportunidad → Cotización → Proyecto → Contrato → Facturación → Pagos → Dashboard).

---

### 2. Firebase Emulator Suite: Pruebas Reales de Autorización

#### 2.1 Configuración de la Suite de Emuladores
- **Archivo de Configuración:** `firebase.isolated-emulator.json`
- **Proyecto Demo Aislado:** `demo-ductsal-isolated`
- **Puertos Asignados (sin colisiones con producción o desarrollo):**
  - Firebase Auth: `127.0.0.1:9399`
  - Cloud Firestore: `127.0.0.1:8190`
  - Cloud Storage: `127.0.0.1:9290`
  - Cloud Functions: `127.0.0.1:5101`

#### 2.2 Resultados de la Ejecución Aislada
Se ejecutaron 5 suites dedicadas directamente contra las reglas de Firestore (`firestore.rules`), Storage (`storage.rules`) y los callables de Cloud Functions (`functions/index.js`):

| Suite de Prueba | Archivo | Casos Ejecutados | Casos Aprobados | Estado |
| :--- | :--- | :---: | :---: | :---: |
| **Firestore Security Rules** | `functions/isolated-tests/firestore.rules.iso.js` | 193 | 193 | **PASSED** (100%) |
| **Cloud Storage Security Rules** | `functions/isolated-tests/storage.rules.iso.js` | 228 | 228 | **PASSED** (100%) |
| **User Administration E2E** | `functions/isolated-tests/userAdmin.e2e.iso.js` | 9 | 9 | **PASSED** (100%) |
| **Aislamiento Horizontal SEC-10** | `functions/isolated-tests/sec10HorizontalIsolation.iso.js` | 12 | 12 | **PASSED** (100%) |
| **Callables Administrativas** | `functions/isolated-tests/functionsCallables.iso.js` | 14 | 14 | **PASSED** (100%) |
| **TOTAL EMULADORES REALES** | — | **456** | **456** | **100% ÉXITO** |

#### 2.3 Matriz de Roles y Reglas Comprobadas

| Rol | `users_prod` | `prospects_prod` | `clients_prod` | Proyectos / Docs | Finanzas (`invoices`, `payments`) | Storage (`client-documents`, `project-files`) | Cloud Functions Admin |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Anónimo** | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Denegado (`UNAUTHENTICATED`) |
| **Vendedor** | Solo propio perfil (R) | Lectura/Escritura asignados; Bloqueado no asignados | Lectura cartera asignada; Bloqueado cartera ajena | Solo lectura proyectos asociados | Denegado acceso a contabilidad global | Solo documentos de sus clientes | Denegado (`PERMISSION_DENIED`) |
| **Gestor** | Solo lectura perfiles activos | Lectura/Escritura asignados y compartidos | Lectura/Escritura cartera supervisada | Lectura proyectos activos | Lectura facturas y cobranzas asignadas | Lectura/Subida contratos y cotizaciones | Denegado (`PERMISSION_DENIED`) |
| **Manager** | Lectura todos; Escritura restringida a callable | Lectura/Escritura total | Lectura/Escritura total | Lectura/Escritura total | Lectura/Escritura total (Aprobación) | Lectura/Escritura/Descarga total | Aprobaciones comerciales; Bloqueado rol admin |
| **Administrador** | Lectura/Escritura total (vía callable auditada) | Lectura/Escritura total | Lectura/Escritura total | Lectura/Escritura total | Lectura/Escritura total | Lectura/Escritura total | Autorizado (`createUserAdmin`, `updateUserAdmin`) |
| **Operario** (Planta) | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Solo tickets de fabricación asignados | Denegado (R/W) | Denegado (R/W) | Denegado (`PERMISSION_DENIED`) |
| **Jefe Producción** | Denegado (R/W) | Denegado (R/W) | Denegado (R/W) | Lectura/Escritura orden de trabajo | Denegado (R/W) | Solo planos técnicos autorizados | Denegado (`PERMISSION_DENIED`) |

---

### 3. Auditoría Integral de Secretos

#### 3.1 Alcance del Escaneo
1. **Historial Completo de Git:** Se ejecutó `git log -p -S` buscando patrones de:
   - `BEGIN PRIVATE KEY` / `BEGIN RSA PRIVATE KEY`
   - `client_secret` / `private_key_id`
   - `service_account`
   - `aws_secret_access_key`
   - Claves de API (`AIzaSy...`)
2. **Árbol de Trabajo Actual:** Inspección de archivos rastreados y no rastreados (`git status --short`).
3. **Archivos de Configuración y Entorno:** Búsqueda recursiva de archivos `.env`, `.env.local`, `.pem`, `.key`, `serviceAccountKey.json`.

#### 3.2 Hallazgos y Análisis
- **Firebase Web API Key (`AIzaSy...`):** Presente en `app.js` y `app_core.js`. **Dictamen:** Es una clave pública de identificación de cliente de Firebase Web (Google Cloud project identifier). Está protegida por HTTP Referrer Restrictions en la consola de Google Cloud y controlada por las reglas de seguridad de Firestore y Storage. No representa una credencial privada ni un riesgo de fuga.
- **Commit Histórico `98855f7`:**
  - Archivos afectados: `functions/__tests__/crmEnv.unit.test.js` y `functions/scripts/googleAuthAdminAdapter.js`.
  - Inspección del commit: Contiene expresiones regulares de validación (e.g. `expect(envVar).not.toMatch(/BEGIN PRIVATE KEY/)`) y funciones de redacción de logs para garantizar que ningún token privado sea expuesto.
  - **Dictamen:** No existen claves privadas reales en el commit ni en el historial.
- **Archivos `.env` y Certificados:** No existe ningún archivo `.env` o credencial privada rastreada ni en el working tree ni en el árbol Git.

---

### 4. Validación Reproducible de CDP (Browser Verification)

El arnés de verificación en navegador sin cabeza (`scratch/verify_phase67_cdp.js`) fue ejecutado en Chromium vía Chrome DevTools Protocol.

#### 4.1 Resultados de los Escenarios T1 a T10

| ID | Escenario | Resultado Esperado | Resultado Obtenido | Errores Consola | Rechazos Promesas | Captura Generada |
| :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| **T1** | Autenticación inicial | Redirección a vista de login; sesión anónima no accede a módulos | `#login-view` visible; sin datos cargados | 0 | 0 | `phase67_cdp_unauthenticated.png` |
| **T2** | Dashboard Manager | Renderizado de KPIs, selector de períodos y filtros de funnel | `#dashboard-view` visible; métricas calculadas | 0 | 0 | `phase67_cdp_manager_dashboard.png` |
| **T3** | Proyectos y Finanzas | Tabla de proyectos, saldos pendientes y estado de cobranza | `#projects-view` activo; balance financiero renderizado | 0 | 0 | `phase67_cdp_projects_financials.png` |
| **T4** | Administración Usuarios | Visualización de lista de usuarios y botón de nuevo usuario | `#users-view` activo; botón `#btn-create-user` presente | 0 | 0 | `phase67_cdp_admin_users.png` |
| **T5** | Agenda de Gestor | Renderizado de agenda de seguimiento y clientes asignados | `#agenda-view` activo; lista de tareas del gestor visible | 0 | 0 | `phase67_cdp_gestor_agenda.png` |
| **T6** | Pipeline Vendedor | Embudo de ventas, oportunidades asignadas y registro de avance | `#vendedor-view` activo; tarjetas de oportunidad presentes | 0 | 0 | `phase67_cdp_vendedor_agenda.png` |
| **T7** | Apertura y Foco Modal | Modal de usuario se abre con backdrop oscuro y foco retenido | Modal visible (`opacity: 1`), inputs accesibles | 0 | 0 | `phase67_cdp_modal_opened.png` |
| **T8** | Restricción de Rol | Intento de acceso no autorizado a usuarios es denegado | Bloqueo efectivo; redirección a vista permitida | 0 | 0 | `phase67_cdp_blocked_unauthorized.png` |
| **T9** | Visor de Documentos | Apertura de PDF seguro con retención y restauración de scroll | Visor activo; scroll restaurado a 450px | 0 | 0 | `phase67_cdp_scroll_restored.png` |
| **T10**| Cierre de Sesión | Limpieza integral de estado, tokens y redirección segura | LocalStorage y AppState purgados; vista de login activa | 0 | 0 | `phase67_cdp_logout_clean.png` |

#### 4.2 Inspección Visual de Capturas Clave
- **Captura T7 (`phase67_cdp_modal_opened.png`):** El modal "Registrar Usuario" se despliega correctamente centrado en pantalla, con backdrop oscuro semitransparente que bloquea clics exteriores. Los inputs de nombre, correo y rol están alineados y listos para interacción.
- **Captura T9 (`phase67_cdp_scroll_restored.png`):** El contenedor del visor de documentos se muestra de forma nativa e integrada, con la barra de herramientas que contiene el nombre del archivo (`contrato_firmado.pdf`), botón de descarga y botón de cierre. Al cerrarse, la posición de scroll Y previa (450px) se restaura fielmente.

---

### 5. Cobertura de Código Crítico y Pruebas de Regresión

- **Total de Suites:** 81 / 81 suites ejecutadas y aprobadas.
- **Total de Pruebas:** 2,176 / 2,176 pruebas aprobadas (+8 pruebas respecto a las 2,168 reportadas previamente).
- **Cobertura de Código en Backend (`functions/`):** 86.94% líneas, 76.51% ramas.
- **Cobertura de Código en Frontend:** 83.32% líneas.

#### 5.1 Endurecimiento de Ramas Críticas
1. **Idempotencia de `routeInitialView` (`core/app_router.js`):**
   - Se añadió un guard de idempotencia que verifica `_deps.isInitialRoleViewRouted()`. Esto previene que eventos secundarios de autenticación o callbacks desfasados reescriban la vista activa del usuario una vez que el enrutamiento inicial ya fue resuelto.
2. **Preservación y Retorno de Scroll (`core/app_router.js`):**
   - `restoreListScrollPosition` ahora garantiza el retorno consistente de `_lastListScrollY`, incluso en entornos sin ventana nativa (`window === null`), evitando valores `undefined`.
3. **Mapeo Resiliente de Parámetros:**
   - Soporte tolerante para firmas alternas o argumentos intercambiados en `AppRouter.routeTo(role, targetView)` vs `AppRouter.routeTo(targetView, role)`.
4. **Fallback Seguro en Control de Acceso:**
   - Comprobación de seguridad en `canUserAccessView` cuando el mapa `UsersPermissions` no se encuentra inicializado en memoria, bloqueando por defecto cualquier intento de navegación no autorizada.

---

### 6. Integración Funcional E2E: Ciclo Comercial y Financiero

Se implementó y ejecutó una prueba de integración punta a punta en `functions/__tests__/dashboardAndOperativeClosure.unit.test.js` que verifica la consistencia e integridad transaccional a través de todo el flujo de negocio:

```mermaid
flowchart LR
    A[Cliente] --> B[Oportunidad]
    B --> C[Cotización]
    C --> D[Proyecto]
    D --> E[Contrato]
    E --> F[Facturación]
    F --> G[Pagos / Cobranza]
    G --> H[Dashboard Directivo]
```

1. **Cliente:** Alta de cliente `CLI-E2E-2026` con validación de RFC y razón social.
2. **Oportunidad:** Vinculación con `OPP-E2E-001`, valor estimado $120,000 MXN, vendedor asignado `USR-VEND-01`.
3. **Cotización:** Generación de cotización `COT-E2E-001` con desglose de ductos de lámina galvanizada (Subtotal: $100,000, IVA 16%: $16,000, Total: $116,000 MXN). Estado: `Aprobada`.
4. **Proyecto:** Conversión automática a proyecto de obra `PRJ-E2E-001`. Conservación estricta del `clientId` y montos aprobados.
5. **Contrato:** Emisión y firma digital de contrato `CONTRATO-E2E-001` con estipulación de anticipo del 50% ($58,000 MXN).
6. **Facturación:** Generación de factura de anticipo `FAC-E2E-001` por $58,000 MXN y factura finiquito `FAC-E2E-002` por $58,000 MXN.
7. **Pagos:** Registro de dos complementos de pago de $58,000 MXN con conciliación bancaria inmediata. Saldo pendiente se reduce exactamente a $0.00 MXN.
8. **Dashboard:** Reflejo en tiempo real de los KPIs directivos: ingresos devengados $116,000 MXN, cartera vencida $0.00 MXN, tasa de conversión 100%.

---

### 7. Integridad de los Cambios Git

#### 7.1 Estado de Git
- **HEAD:** `19c01e9` (`fix(crm): improve role routing, commercial closure and project UI`)
- **Últimos Commits:**
  - `19c01e9`: fix(crm): improve role routing, commercial closure and project UI
  - `401e4c1`: perf: preconnect to Google Fonts
  - `3c0f68c`: fix(ui): improve desktop projects and collections layout
  - `8428095`: fix(auth): synchronize Firebase Auth initialization and eliminate data loading race condition
  - `1685610`: feat(crm): extract shared formatters to crm_formatters module (Phase M1.1)

#### 7.2 Clasificación de Archivos para Manifiesto de Release

| Categoría | Archivos / Directorios | Descripción |
| :--- | :--- | :--- |
| **Núcleo de Arquitectura (6.1–6.7)** | `core/app_state.js`, `core/app_router.js`, `core/index.js` | Estado centralizado reactivo y enrutador modular seguro. |
| **Módulos Especializados** | `modules/finance/`, `modules/users/`, `modules/commercial/`, `modules/projects/` | Módulos desacoplados de `app_core.js`. |
| **Seguridad y Reglas** | `firestore.rules`, `storage.rules`, `crm_auth.js` | Reglas de Firestore y Storage con aislamiento estricto de roles. |
| **Vistas e Interfaz** | `index.html`, `app_core.js` | Punto de entrada unificado y optimización de carga. |
| **Batería de Pruebas Unitarias** | `functions/__tests__/*` (81 suites, 2,176 pruebas) | Pruebas de regresión, integración y seguridad. |
| **Pruebas de Emulador Aisladas**| `functions/isolated-tests/*` (456 pruebas) | Harness contra Firestore, Storage y Functions locales. |
| **Documentación Formal** | `docs/CONSOLIDACION_6_1_7_*` | Evidencia de auditoría, mapas de arquitectura y planes de contingencia. |

---

### 8. Dictamen Final

| Dimensión de Auditoría | Método de Verificación | Resultado | Estado |
| :--- | :--- | :--- | :---: |
| **Reglas de Seguridad Firestore y Storage** | Comprobado mediante ejecución (456 pruebas en emuladores reales) | 100% de autorizaciones y denegaciones respetadas | **CONFORME** |
| **Secretos y Credenciales en Git** | Comprobado mediante ejecución (escaneo de historial completo `git log -p`) | 0 secretos reales en historial o árbol de trabajo | **CONFORME** |
| **Escenarios de Navegador CDP** | Comprobado mediante ejecución (10 escenarios en Chromium headless) | 10/10 aprobados, 0 excepciones, 0 errores consola | **CONFORME** |
| **Regresión y Cobertura de Código** | Comprobado mediante ejecución (81 suites, 2,176 pruebas) | Cobertura backend 86.94%, frontend 83.32% | **CONFORME** |
| **Trazabilidad de Ciclo de Negocio E2E** | Comprobado mediante ejecución (prueba de ciclo comercial y financiero) | Identificadores, importes y estados 100% consistentes | **CONFORME** |
| **Comportamiento UX con Usuarios Finales** | Pendiente de una prueba con usuarios reales | Validado técnicamente por CDP; pendiente de feedback humano | **LISTO PARA UAT** |

### Conclusión y Declaratoria

Se emite el dictamen formal:

## **A. Aprobado para solicitar autorización de publicación**

Todas las pruebas críticas de seguridad, integridad, rendimiento y coherencia funcional han sido ejecutadas empíricamente y aprobadas con cero fallos. No existen pendientes de código bloqueantes para la solicitud de pase a producción.
