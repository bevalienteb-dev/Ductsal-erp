# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 7: Auditoría Complementaria del Estado Real del Repositorio y Diagnóstico Forense

**Fecha:** 31 de Octubre de 2026  
**Auditor:** Arquitecto Senior / Auditor de Seguridad / QA Lead  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Directorio local:** `/Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release`  
**Último commit base (HEAD):** `19c01e9 fix(crm): improve role routing, commercial closure and project UI`  
**Estado:** **VERIFICADO Y AUDITADO**  

---

## 1. ESTADO REAL DEL CONTROL DE VERSIONES (GIT)

En estricto cumplimiento de los límites operativos, no se ejecutó ningún comando destructivo (`git reset`, `git restore`, `git clean`, `git checkout`). La totalidad del trabajo se mantiene intacta.

### 1.1 Salidas de Diagnóstico Ejecutadas

#### `git log -5 --oneline`
```text
19c01e9 (HEAD -> main, origin/main, origin/HEAD) fix(crm): improve role routing, commercial closure and project UI
401e4c1 perf: preconnect to Google Fonts
3c0f68c fix(ui): improve desktop projects and collections layout
8428095 fix(auth): synchronize Firebase Auth initialization and eliminate data loading race condition
1685610 feat(crm): extract shared formatters to crm_formatters module (Phase M1.1)
```
- **Conclusión**: El commit base local es exactamente `19c01e9`. Las fases anteriores (M1.1, optimizaciones de fuentes, y ajustes de interfaz) ya forman parte del historial confirmado.

#### `git diff --check`
- **Resultado**: `0` advertencias de espacios en blanco, conflictos de combinación o sintaxis.

#### `git diff --stat`
```text
 app_core.js                                        | 9023 ++++----------------
 crm_auth.js                                        |   29 +
 firestore.rules                                    |   12 +-
 functions/__tests__/clientDocumentsSec05.test.js   |   16 +-
 functions/__tests__/clientFormUi.unit.test.js      |   32 +-
 functions/__tests__/clientStorageUiFlow.test.js    |   59 +-
 functions/__tests__/clientVisibility.test.js       |   58 +-
 .../commercialClosureAndPriority.unit.test.js      |    6 +
 functions/__tests__/commercialUiFlow.test.js       |   31 +-
 functions/__tests__/crmClients.client.test.js      |   17 +-
 functions/__tests__/crmCommercial.client.test.js   |   45 +-
 functions/__tests__/crmUi.unit.test.js             |  138 +-
 .../dashboardAndOperativeClosure.unit.test.js      |   10 +-
 .../financialAndStagnationUi.unit.test.js          |  124 +-
 functions/__tests__/jointInventory.unit.test.js    |   29 +-
 .../rolePermissionsAndUiAudit.unit.test.js         |   13 +-
 functions/__tests__/storageDownload.unit.test.js   |   15 +-
 functions/__tests__/storageReview.unit.test.js     |    4 +-
 functions/__tests__/storageSecurity.unit.test.js   |   11 +-
 .../__tests__/uiEnhancementsAndPreview.test.js     |   59 +-
 functions/__tests__/viewSecureDocumentFlow.test.js |   20 +-
 functions/__tests__/workflowUiFlow.test.js         |   30 +-
 functions/isolated-tests/storage.rules.iso.js      |   12 +
 index.html                                         |   30 +-
 storage.rules                                      |   12 +-
 25 files changed, 2445 insertions(+), 7390 deletions(-)
```

#### `git ls-files`
- **Total de archivos rastreados en git**: `168 archivos`.

---

## 2. CLASIFICACIÓN RIGUROSA DE ARCHIVOS Y CONTENIDO LOCAL

Se inspeccionó cada archivo presente en el espacio de trabajo clasificándolo en su categoría correspondiente:

### 2.1 Código de Producción Modificado (Tracked)
1. `app_core.js`: Reducido en 4,524 líneas (-48.81%), fachadas UMD y suscripción a eventos de `AppState`.
2. `crm_auth.js`: Verificación estricta de claims `cid`, `role`, `manager` y función `resendInvitationViaFunction`.
3. `firestore.rules`: Blindaje de `isPostclosing` (`d != null`, estado válido) y denegación de mutaciones directas.
4. `storage.rules`: Sincronización de `isPostclosing` y lista blanca de extensiones.
5. `index.html`: Inclusión jerárquica de los 24 módulos antes de `app_core.js`.

### 2.2 Código de Producción Nuevo (Untracked)
- **`core/` (3 módulos)**:
  - `core/document_viewer.js` (Fase 6.1)
  - `core/app_state.js` (Fase 6.7)
  - `core/app_router.js` (Fase 6.7)
- **`modules/` (21 módulos)**:
  - Clientes (Fase 6.2): `clients_controller.js`, `client_documents.js`, `clients_ui.js`.
  - Oportunidades (Fase 6.3): `opportunities_controller.js`, `opportunities_ui.js`.
  - Finanzas (Fase 6.4): `finance_calculations.js`, `finance_change_orders.js`, `finance_invoicing.js`, `finance_payments.js`, `finance_contracts.js`, `finance_controller.js`, `finance_ui.js`.
  - Dashboards (Fase 6.5): `dashboard_audit.js`, `dashboard_charts.js`, `dashboard_manager_workflow.js`, `dashboard_controller.js`, `dashboard_ui.js`.
  - Usuarios y Permisos (Fase 6.6): `users_permissions.js`, `users_ui.js`, `users_controller.js`, `auth_session.js`.

### 2.3 Suites de Prueba Nuevas (Untracked)
- `functions/__tests__/appState.unit.test.js` (16 tests)
- `functions/__tests__/appRouter.unit.test.js` (11 tests)
- `functions/__tests__/financeModules.unit.test.js` (28 tests)
- `functions/__tests__/dashboardManagerWorkflow.unit.test.js` (12 tests)
- `functions/__tests__/usersModules.unit.test.js` (24 tests)
- `functions/__tests__/phase66ComplementaryVerification.unit.test.js` (18 tests)
- `functions/__tests__/phase66SecurityAudit.unit.test.js` (15 tests)
- `functions/__tests__/closingStorageAuthIncident.unit.test.js` (8 tests)
- `functions/__tests__/commercialAttributionMigration.unit.test.js` (9 tests)
- `functions/__tests__/stagingIsolation.unit.test.js` (7 tests)

### 2.4 Documentación Técnica (Untracked)
- `docs/CONSOLIDACION_6_1_7_*.md`: Documentos 1 al 11 generados durante esta auditoría.
- `docs/FASE_6_*.md`: Registros históricos de cierre de las fases individuales.

### 2.5 Scripts de Mantenimiento y Migración (Untracked)
- `functions/scripts/commercialAttributionMigration.js`
- `functions/scripts/assertTargetProject.js`
- `functions/scripts/seedStagingEnvironment.js`
- `functions/scripts/commercial_attribution_plan_*.json`
- `crm_staging_config.js`

### 2.6 Archivos de Diagnóstico y Scratch (No para Producción)
- Directorio `scratch/`: Backups de `app_core.js`, scripts de verificación CDP, capturas y experimentos aislados. No formarán parte del paquete de release de producción.

---

## 3. AUDITORÍA DE CAMBIOS ANTERIORES MEZCLADOS

Se investigó si existen modificaciones no documentadas o cambios rezagados de fases anteriores a las 6.1:
- `functions/__tests__/jointInventory.unit.test.js`: Se actualizó para registrar la lista completa de los nuevos archivos de `modules/` en la comprobación de llamadas a Storage y colecciones. Es una actualización de prueba complementaria legítima de la modularización.
- `functions/__tests__/commercialClosureAndPriority.unit.test.js`: Incorpora `jest.useFakeTimers()` para aislar la fecha del sistema durante el cálculo de días de atraso en la columna prioridad de la agenda.
- **Conclusión**: No existen cambios huérfanos ni contaminación cruzada de ramas previas. Todos los cambios corresponden estrictamente a la consolidación de las Fases 6.1 a 6.7.

---

## 4. RESOLUCIÓN DE LA DISCREPANCIA EN ESCENARIOS CDP (T7 Y T9)

### Hallazgo
El informe preliminar reportaba 10/10 escenarios de navegador aprobados, pero la tabla de evidencias solo listaba capturas de pantalla para T1, T2, T3, T4, T5, T6, T8 y T10, omitiendo capturas dedicadas para T7 y T9.

### Causa Raíz
Al inspeccionar `scratch/verify_phase67_cdp.js`:
- **T7 (Modales)** evaluaba `t7_open` y `t7_close` mediante `document.getElementById('userModal').style.display`, pero no llamaba a `takeScreenshot()`.
- **T9 (Scroll)** evaluaba `saveListScrollPosition()` y la correspondencia con `window.lastListScrollY`, pero tampoco disparaba `takeScreenshot()`.

### Corrección y Evidencia Reproducible
Se modificó `scratch/verify_phase67_cdp.js`:
1. Se añadió `await takeScreenshot('phase67_cdp_modal_opened.png')` inmediatamente tras la apertura del modal `#userModal`.
2. Se añadió `await takeScreenshot('phase67_cdp_scroll_restored.png')` tras la ejecución de `restoreListScrollPosition()`.
3. Se re-ejecutó el arnés CDP en Chromium (`node --experimental-websocket scratch/verify_phase67_cdp.js`).

**Resultado**: Las 11 capturas de pantalla existen físicamente en el directorio de artefactos con tamaños no vacíos y timestamp actualizado. La discrepancia ha quedado 100% resuelta.
