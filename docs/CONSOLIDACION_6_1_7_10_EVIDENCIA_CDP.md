# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 10: Evidencia Completa y Reproducible de Navegador Real (Chrome CDP)

**Fecha:** 31 de Octubre de 2026  
**Auditor:** Especialista en QA / Release Engineering Lead  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Entorno de Ejecución:** Chromium Headless (Puppeteer/CDP vía puerto 9233) sobre Servidor Local HTTP (puerto 8097)  
**Script de Verificación:** [`scratch/verify_phase67_cdp.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/scratch/verify_phase67_cdp.js)  
**Estado:** **10/10 ESCENARIOS APROBADOS — 11 CAPTURAS VERIFICADAS**  

---

## 1. RESUMEN EJECUTIVO Y RESOLUCIÓN DE LA DISCREPANCIA

El informe preliminar de la fase reportaba 10 escenarios evaluados pero solo 8 capturas registradas en la tabla de evidencias (faltando capturas dedicadas para T7 y T9).  
Se auditó el código de `scratch/verify_phase67_cdp.js` comprobando que las aserciones de T7 (apertura y cierre de modales) y T9 (preservación de scroll) se ejecutaban en memoria y DOM, pero no invocaban `takeScreenshot()`.

### Corrección Aplicada:
1. En **T7**: Se introdujo `await takeScreenshot('phase67_cdp_modal_opened.png')` inmediatamente tras abrir el modal `#userModal`.
2. En **T9**: Se introdujo `await takeScreenshot('phase67_cdp_scroll_restored.png')` tras la ejecución y retorno de `restoreListScrollPosition()`.
3. Se re-ejecutó el arnés CDP completo, generando las **11 capturas físicas** en el directorio de artefactos con cero errores de runtime.

---

## 2. MATRIZ DETALLADA DE LOS 10 ESCENARIOS FUNCIONALES EN NAVEGADOR

| ID | Escenario Validado | Rol / Contexto | Aserciones Clave Evaluadas en DOM | Diálogos / Alertas Interceptadas | Resultado | Captura de Evidencia |
| :-: | :--- | :--- | :--- | :--- | :---: | :--- |
| **T1** | **Sin Autenticación** | Anónimo | `#login-screen` con `display: flex`, `#main-app` con `display: none`, `currentUser: null`, `AppState.session.getCurrentUser(): null`. | Ninguno | **APROBADO** | [`phase67_cdp_unauthenticated.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_unauthenticated.png) |
| **T2** | **Login Manager** | `manager` | Enrutamiento automático a `dashboard-view`, tarjetas de KPIs gerenciales visibles, saludo contextual y visibilidad total en menú lateral. | Ninguno | **APROBADO** | [`phase67_cdp_manager_dashboard.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_manager_dashboard.png) |
| **T3** | **Navegación Manager** | `manager` | Transición secuencial entre `projects-view`, `clients-view`, `users-view` y `list-view`. Clases `.active` sincronizadas y `lastViewedSection` preservado. | Ninguno | **APROBADO** | [`phase67_cdp_projects_financials.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_projects_financials.png) |
| **T4** | **Login Admin y Control** | `admin` | Vista inicial `users-view`. Intento de invocar `showView('dashboard-view')` es bloqueado por router y devuelto a `users-view`. | *"Acceso denegado: este módulo es exclusivo para la Gerencia General."* | **APROBADO** | [`phase67_cdp_admin_users.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_admin_users.png) |
| **T5** | **Login Gestor** | `gestor` | Vista inicial `list-view` con modo `currentListMode: 'agenda'`. Botones y menús restringidos según matriz de autorización. | Ninguno | **APROBADO** | [`phase67_cdp_gestor_agenda.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_gestor_agenda.png) |
| **T6** | **Login Vendedor & Anti-Spoofing** | `vendedor` | Vista inicial `list-view` en modo agenda. Intentos forzados en consola de acceder a `dashboard-view` y `users-view` son interceptados y bloqueados. | 1. *"Acceso denegado: este módulo es exclusivo para la Gerencia General."*<br>2. *"Acceso denegado: este módulo es exclusivo para Administradores y Gerencia."* | **APROBADO** | [`phase67_cdp_vendedor_agenda.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_vendedor_agenda.png)<br>[`phase67_cdp_blocked_unauthorized.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_blocked_unauthorized.png) |
| **T7** | **Apertura y Cierre de Modales** | `admin` | `openUserModal()` establece `display: block/flex`. `closeModal('userModal')` restituye `display: none` sin duplicar elementos. | Ninguno | **APROBADO** | [`phase67_cdp_modal_opened.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_modal_opened.png) |
| **T8** | **Document Viewer Seguro** | Operativo | `DocumentViewer.openDocPreviewModal()` activa `#docPreviewModal` (`display: block`) y limpia el contenedor al invocar `closeDocPreviewModal()`. | Ninguno | **APROBADO** | [`phase67_cdp_document_viewer.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_document_viewer.png) |
| **T9** | **Preservación de Scroll** | Lista $\leftrightarrow$ Detalle | `saveListScrollPosition()` registra la posición vertical y `restoreListScrollPosition()` la recupera de forma fluida. | Ninguno | **APROBADO** | [`phase67_cdp_scroll_restored.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_scroll_restored.png) |
| **T10**| **Logout y Limpieza Atómica** | Sesión $\rightarrow$ Salida | `AppState.resetAll()` reinicia colecciones (`clients: 0`, `prospects: 0`, `users: 0`), usuario nulo, borrado de `localStorage` y despliegue de `#login-screen`. | Ninguno | **APROBADO** | [`phase67_cdp_logout_clean.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase67_cdp_logout_clean.png) |

---

## 3. AUDITORÍA DE EXCEPCIONES Y ERRORES DE RUNTIME

- **Errores JavaScript en Runtime**: **0**
- **Promesas Rechazadas no Manejadas**: **0**
- **Peticiones de Red Denegadas No Previstas**: **0**
- **Distinción de Eventos**:
  - Las alertas registradas en T4 y T6 corresponden al comportamiento legítimo y esperado de la defensa anti-spoofing implementada en `core/app_router.js`. No son fallos de la aplicación, sino la prueba positiva de que los intentos de evasión son interceptados y neutralizados en la capa cliente.
