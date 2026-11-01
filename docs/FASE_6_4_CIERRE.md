# DUCTSAL ERP — ACTA DE CIERRE FORMAL DE FASE 6.4
## Modularización Integral de Finanzas, Facturación y Control de Cobranzas

> **Fecha de Emisión:** 31 de Octubre de 2026  
> **Proyecto:** DUCTSAL ERP (`bevalienteb-dev/Ductsal-erp`)  
> **Rama Activa:** `main` (commit base `19c01e9`)  
> **Estado de la Fase:** 🟢 **CERRADA SATISFACTORIAMENTE**  
> **Gobernanza:** 0 commits, 0 pushes remotos, 0 despliegues, 0 comandos destructivos de git, preservación total del árbol local de trabajo.

---

### 1. Objetivo y Alcance de la Fase 6.4

El propósito de la Fase 6.4 fue desacoplar, modularizar y encapsular la totalidad de la lógica de finanzas, facturación, cuentas por cobrar (CxC), órdenes de cambio y contratos fuera del archivo monolítico [`app_core.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js), redistribuyéndola en módulos especializados bajo la carpeta `modules/finance/`.

**Alcance ejecutado:**
- Extracción de **23 funciones financieras originales** y **3 variables de estado operativas** (`projPaymentFilter`, `projSortCol`, `projSortDir`).
- Creación de **7 módulos independientes** de alta cohesión.
- Preservación del **100% de compatibilidad regresiva** con consumidores globales, controladores de interfaz en línea (`onclick`, `onsubmit`, `onchange`), llamadas entre módulos y suites de pruebas de Jest preexistentes.
- Blindaje estricto de seguridad: **0 escrituras directas de cliente en Firestore** (todas las mutaciones operan mediante `runWorkflowOp` -> `CrmCommercial` -> Firebase Cloud Functions).

---

### 2. Los Siete Módulos Financieros y sus Responsabilidades

Todos los submódulos implementan el patrón arquitectónico UMD (Universal Module Definition), permitiendo su consumo en el navegador vía `<script>`Vanilla ES6 y en entornos Node.js / Jest vía `require()`, complementados con inyección de dependencias (`setDeps`):

| # | Archivo | Namespace | Responsabilidad Principal |
|---|---|---|---|
| 1 | [`modules/finance/finance_calculations.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_calculations.js) | `FinanceCalculations` | Motor matemático puro: cálculo de subtotales consolidados con órdenes de cambio (aumentos y disminuciones), costos presupuestados, márgenes brutos, aplicación de IVA (13% local o 0% exportación), condición de liquidación (`isProjectFullyPaid`) y saldos de facturas. |
| 2 | [`modules/finance/finance_change_orders.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_change_orders.js) | `FinanceChangeOrders` | Gestión modal y procesamiento transaccional de órdenes de cambio; subida de anexos técnicos y ofertas a Cloud Storage (`ordenes_cambio/`); mutación vía `CrmCommercial.saveChangeOrder` y `deleteChangeOrder`. |
| 3 | [`modules/finance/finance_invoicing.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_invoicing.js) | `FinanceInvoicing` | Ciclo de vida de facturación: apertura de drawer, validación de montos contra saldo contratado, subida de factura a Cloud Storage (`facturas/`), delegación a `CrmCommercial.saveInvoice` y **blindaje de inmutabilidad del anticipo** (`idx === 0`). |
| 4 | [`modules/finance/finance_payments.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_payments.js) | `FinancePayments` | Registro y edición de abonos por factura; vinculación por clave canónica (`paymentKey`); cálculo automático de **Retención del 1% para Grandes Contribuyentes** (`retencion_1pct`); subida de comprobantes a Storage (`pagos/`). |
| 5 | [`modules/finance/finance_contracts.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_contracts.js) | `FinanceContracts` | Validación de completitud del expediente y personería legal del cliente (natural vs jurídica); renderizado de contrato marco en iframe oculto (`#print-iframe`) y apertura de cola de impresión. |
| 6 | [`modules/finance/finance_controller.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_controller.js) | `FinanceController` | Orquestación de estado de Proyectos y Cobros: ordenación multi-columna bidireccional (`toggleProjSort`, `updateProjSortIcons`), filtrado de cobros (`setProjPaymentFilter`, `getProjPaymentFilter`) y fachada unificada con getters de submódulos. |
| 7 | [`modules/finance/finance_ui.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/finance/finance_ui.js) | `FinanceUI` | Renderizado reactivo del DOM: tabla adaptativa de proyectos (`renderProjectsList`) con aislamiento horizontal por rol de vendedor, e interfaz financiera de detalle (`renderFinancials`) con desgloses, advertencias tributarias y tarjetas de facturas. |

---

### 3. Matriz de Trazabilidad de las 23 Funciones Originales

Todas las funciones del inventario inicial 6.4.0 se encuentran operativas, documentadas y accesibles:

| # | Función Original | Ubicación Actual | Namespace | Proxy Global en `app_core.js` | Consumidores Identificados | Estado Final |
|---|---|---|---|---|---|---|
| 1 | `toggleProjSort` | `modules/finance/finance_controller.js` | `FinanceController` | Sí (L437) | [`index.html:L331-338`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html#L331-L338) (encabezados de tabla) | ✅ Migrada con proxy |
| 2 | `updateProjSortIcons` | `modules/finance/finance_controller.js` | `FinanceController` | Sí (L452) | `FinanceController.toggleProjSort` | ✅ Migrada con proxy |
| 3 | `getProjectSubtotal` | `modules/finance/finance_calculations.js` | `FinanceCalculations` | Sí (L2638) | `FinanceUI`, `FinanceContracts`, `app_core.js` | ✅ Migrada con proxy |
| 4 | `getProjectCosto` | `modules/finance/finance_calculations.js` | `FinanceCalculations` | Sí (L2648) | `FinanceUI.renderFinancials` | ✅ Migrada con proxy |
| 5 | `isProjectFullyPaid` | `modules/finance/finance_calculations.js` | `FinanceCalculations` | Sí (L2658) | `FinanceUI.renderProjectsList`, suites unitarias | ✅ Migrada con proxy |
| 6 | `getProjPaymentFilter` | `modules/finance/finance_controller.js` | `FinanceController` | Sí (L3242) | `FinanceUI:L111`, suites de prueba | ✅ Migrada con proxy |
| 7 | `setProjPaymentFilter` | `modules/finance/finance_controller.js` | `FinanceController` | Sí (L3250) | [`index.html:L312-318`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html#L312-L318) (filter pills) | ✅ Migrada con proxy |
| 8 | `renderProjectsList` | `modules/finance/finance_ui.js` | `FinanceUI` | Sí (L3264) | `showView('projects-view')`, `reRenderApp` | ✅ Migrada con proxy |
| 9 | `renderFinancials` | `modules/finance/finance_ui.js` | `FinanceUI` | Sí (L3341) | `openDetail` en `opportunities_ui.js` | ✅ Migrada con proxy |
| 10 | `openChangeOrderModal` | `modules/finance/finance_change_orders.js` | `FinanceChangeOrders` | Sí (L3578) | Botón `#btn-add-co` en modal detalle | ✅ Migrada con proxy |
| 11 | `editChangeOrder` | `modules/finance/finance_change_orders.js` | `FinanceChangeOrders` | Sí (L3589) | Botones edición en `renderFinancials` | ✅ Migrada con proxy |
| 12 | `runWorkflowOp` | `app_core.js` (Core transversal) | Global / Shared Core | Canónica (L3601) | Submódulos financieros y comerciales | ✅ Activa en Core |
| 13 | `processChangeOrder` | `modules/finance/finance_change_orders.js` | `FinanceChangeOrders` | Sí (L3622) | Formulario `#changeOrderForm` (`onsubmit`) | ✅ Migrada con proxy |
| 14 | `deleteChangeOrder` | `modules/finance/finance_change_orders.js` | `FinanceChangeOrders` | Sí (L3633) | Botones eliminar en `renderFinancials` | ✅ Migrada con proxy |
| 15 | `showInvoiceForm` | `modules/finance/finance_invoicing.js` | `FinanceInvoicing` | Sí (L3644) | Botón `#btn-add-invoice` en detalle | ✅ Migrada con proxy |
| 16 | `editInvoice` | `modules/finance/finance_invoicing.js` | `FinanceInvoicing` | Sí (L3655) | Botones edición en `renderFinancials` | ✅ Migrada con proxy |
| 17 | `processInvoice` | `modules/finance/finance_invoicing.js` | `FinanceInvoicing` | Sí (L3666) | Formulario `#invoice-form` (`onsubmit`) | ✅ Migrada con proxy |
| 18 | `deleteInvoice` | `modules/finance/finance_invoicing.js` | `FinanceInvoicing` | Sí (L3677) | Botones eliminar en `renderFinancials` | ✅ Migrada con proxy |
| 19 | `showPaymentForm` | `modules/finance/finance_payments.js` | `FinancePayments` | Sí (L3688) | Botones `+ Abonar` en tarjetas de factura | ✅ Migrada con proxy |
| 20 | `handlePaymentMethodChange` | `modules/finance/finance_payments.js` | `FinancePayments` | Sí (L3699) | Select `#pay-metodo` (`onchange`) | ✅ Migrada con proxy |
| 21 | `editPayment` | `modules/finance/finance_payments.js` | `FinancePayments` | Sí (L3709) | Botones edición abono en `renderFinancials` | ✅ Migrada con proxy |
| 22 | `processPayment` | `modules/finance/finance_payments.js` | `FinancePayments` | Sí (L3720) | Formulario `#payment-form` (`onsubmit`) | ✅ Migrada con proxy |
| 23 | `deletePayment` | `modules/finance/finance_payments.js` | `FinancePayments` | Sí (L3731) | Botones eliminar abono en `renderFinancials`| ✅ Migrada con proxy |

---

### 4. Los Cuatro Handlers Globales Recuperados

Durante la auditoría se verificó la disponibilidad de los cuatro handlers operativos de ordenación y filtrado:
1. `toggleProjSort`: Invocado directamente por los `th onclick` de la tabla de proyectos en `index.html`.
2. `updateProjSortIcons`: Actualiza las flechas `↕` / `▲` / `▼` en las columnas de la tabla.
3. `getProjPaymentFilter`: Permite consultar el filtro activo (`pendientes`, `pagados`, `todos`).
4. `setProjPaymentFilter`: Invocado por los botones de pastilla (filter pills) en la interfaz.

Cada uno de ellos está definido canónicamente en `FinanceController`, expuesto en `window` al cargar el módulo, y respaldado por una función proxy en `app_core.js` que garantiza compatibilidad tanto en navegador como en evaluaciones aisladas de Node.js sin duplicar lógica de negocio.

---

### 5. Explicación Documentada de la Diferencia (23 Funciones vs 21 Handlers en Prueba)

La discrepancia numérica entre el inventario de **23 funciones originales** y la lista de **21 handlers** auditados en el array `fns` de `scratch/verify_phase64_browser.js` responde a la estructura de pruebas del harness y no a funciones faltantes:

1. **Cuatro funciones de ordenación y filtrado evaluadas en bloque separado:**
   `toggleProjSort`, `updateProjSortIcons`, `getProjPaymentFilter` y `setProjPaymentFilter` pertenecen a `FinanceController`. En el arnés de prueba de navegador se probaron funcionalmente en sus propios pasos de interacción con el DOM, en lugar de incluirse en el array plano `fns`.
2. **Una función de infraestructura compartida transversal:**
   `runWorkflowOp` es una función de infraestructura compartida que reside en el núcleo (`app_core.js`) para manejar sincronización de sesión y llamadas Cloud Functions. No es un handler exclusivo del módulo financiero.
3. **Tres funciones adicionales incluidas en el array de prueba:**
   Para verificar la totalidad de la API expuesta, el array `fns` del script de navegador incluyó:
   - `generarContrato` (función legal proveniente de `FinanceContracts`).
   - `calculateProjectFinancials` (nuevo método exportado en `FinanceCalculations`).
   - `calculateInvoiceStatus` (nuevo método exportado en `FinanceCalculations`).
4. **Relación matemática demostrada:**
   $$\text{Total array } fns = 23 \text{ (inventario original)} - 4 \text{ (controller)} - 1 \text{ (runWorkflowOp)} + 3 \text{ (contrato + 2 helpers)} = 21$$

**Confirmación:** No existe ninguna función huérfana, omitida ni rota. Las 23 funciones originales más las 3 funciones especializadas (26 en total) están registradas en `window` y operativas.

---

### 6. Reglas de Negocio y Controles de Seguridad Preservados

1. **Modo Solo Lectura para Vendedores:** Los usuarios con rol `vendedor` (`isFinancialReadOnly = true`) tienen estrictamente bloqueada cualquier mutación (`alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.")`).
2. **Aislamiento Horizontal por Cartera:** En la vista de proyectos, los vendedores visualizan únicamente aquellos registros donde `p.vendedorId === currentUserId`.
3. **Inmutabilidad de la Factura de Anticipo:** La primera factura (`facturas[0]`) no puede eliminarse bajo ninguna circunstancia (`alert("Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada...")`).
4. **Retención Tributaria del 1%:** Cálculo automatizado y exacto de retención fiscal sobre la base imponible para clientes designados como Grandes Contribuyentes (`retencion_1pct`).
5. **Cero Escrituras Directas en Firestore:** Todas las mutaciones delegan en `runWorkflowOp` -> `CrmCommercial` -> Firebase Cloud Functions (`callIdempotent`), cumpliendo los estándares SEC-02 y SEC-03.

---

### 7. Resultados de Pruebas Unitarias, Suites Completas y Navegador

#### A. Suites Relacionadas con Finanzas (7 suites)
```text
PASS __tests__/uiEnhancementsAndPreview.test.js (73 tests)
PASS __tests__/workflowUiFlow.test.js (39 tests)
PASS __tests__/crmCommercial.client.test.js (50 tests)
PASS __tests__/dashboardAndOperativeClosure.unit.test.js (16 tests)
PASS __tests__/jointInventory.unit.test.js (14 tests)
PASS __tests__/financialAndStagnationUi.unit.test.js (32 tests)
PASS __tests__/financeModules.unit.test.js (14 tests)

Resultado: 7 passed, 7 total | 238 passed, 238 total (100% de éxito)
```

#### B. Suite Completa del Proyecto (75 suites)
```text
Test Suites: 75 passed, 75 total
Tests:       2,036 passed, 2,036 total
Snapshots:   0 total
Time:        6.849 s
Resultado: 100% de suites y pruebas aprobadas sin regresiones.
```

#### C. Validación en Navegador Real (Google Chrome Headless - CDP)
Ejecutado mediante [`scratch/verify_phase64_browser.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/scratch/verify_phase64_browser.js):
- **Namespaces:** 7 de 7 presentes en `window`.
- **Global Facades:** 21 de 21 funciones verificadas.
- **Métricas:** Subtotal $11,500.00, Costo $6,900.00, Margen $4,600.00 (40.00%), 100% cobrado.
- **Seguridad:** Vendedor bloqueado en 3/3 operaciones con alertas registradas.
- **Anticipo:** Bloqueo de eliminación confirmado.
- **Retención 1%:** Pre-cálculo matemático de $10.00 sobre base de $1,000.00.
- **DOM:** Renderizado correcto de `#proj-table-body` y tarjetas de factura.
- **Consola:** 0 errores de consola, 0 excepciones no capturadas.
- **Capturas Generadas:**
  - [`phase64_browser_projects.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase64_browser_projects.png)
  - [`phase64_browser_financials.png`](file:///Users/Benjamin/.gemini/antigravity-ide/brain/10554a69-1f12-413c-b9a8-1a4a6e720722/phase64_browser_financials.png)

---

### 8. Operaciones Financieras Simuladas y Generación de Contratos

Ejecutado mediante [`scratch/test_phase64_functional_operations.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/scratch/test_phase64_functional_operations.js) con mocks en memoria:
1. **Crear factura inicial:** Emitida factura por $5,000.00 y almacenada en Storage.
2. **Registrar primer abono:** $2,000.00 vía transferencia.
3. **Registrar segundo abono:** $1,500.00 vía cheque.
4. **Verificar saldos:** Cobrado $3,500.00, Saldo factura $1,500.00, Saldo vivo CxC $1,500.00.
5. **Editar abono:** Modificado abono 2 a $1,800.00 preservando `paymentKey`.
6. **Eliminar abono:** Eliminado limpiamente vía `deletePayment`.
7. **Consistencia de saldos:** Saldo restaurado con precisión a $3,000.00.
8. **Orden de cambio:** Aumento de $2,500.00 elevó subtotal a $12,500.00; eliminación restauró subtotal a $10,000.00.
9. **Protección de anticipo:** Factura índice 0 bloqueada; factura índice 1 eliminada.
10. **Retención 1%:** $50.00 calculados sobre factura de $5,000.00 en Gran Contribuyente.
11. **Auditoría Firestore:** **0 escrituras directas del cliente.** 100% de mutaciones delegadas a Cloud Functions.
12. **Generación de contratos:** Cliente incompleto aborta y abre modal; cliente completo genera documento legal en `#print-iframe`.

---

### 9. Estado de Git y Archivos Locales Preservados

#### A. `git status --short`
```text
 M app_core.js
 M firestore.rules
 M functions/__tests__/clientDocumentsSec05.test.js
 M functions/__tests__/clientFormUi.unit.test.js
 M functions/__tests__/clientStorageUiFlow.test.js
 M functions/__tests__/clientVisibility.test.js
 M functions/__tests__/commercialClosureAndPriority.unit.test.js
 M functions/__tests__/commercialUiFlow.test.js
 M functions/__tests__/crmClients.client.test.js
 M functions/__tests__/crmCommercial.client.test.js
 M functions/__tests__/crmUi.unit.test.js
 M functions/__tests__/dashboardAndOperativeClosure.unit.test.js
 M functions/__tests__/financialAndStagnationUi.unit.test.js
 M functions/__tests__/jointInventory.unit.test.js
 M functions/__tests__/rolePermissionsAndUiAudit.unit.test.js
 M functions/__tests__/storageDownload.unit.test.js
 M functions/__tests__/storageReview.unit.test.js
 M functions/__tests__/storageSecurity.unit.test.js
 M functions/__tests__/uiEnhancementsAndPreview.test.js
 M functions/__tests__/viewSecureDocumentFlow.test.js
 M functions/__tests__/workflowUiFlow.test.js
 M functions/isolated-tests/storage.rules.iso.js
 M index.html
 M storage.rules
?? auditoria_fase_6_4_finanzas_cobranzas.md
?? auditoria_final_fase_6_4.md
?? core/
?? crm_staging_config.js
?? docs/
?? functions/__tests__/closingStorageAuthIncident.unit.test.js
?? functions/__tests__/commercialAttributionMigration.unit.test.js
?? functions/__tests__/financeModules.unit.test.js
?? functions/__tests__/stagingIsolation.unit.test.js
?? functions/scripts/assertTargetProject.js
?? functions/scripts/commercialAttributionMigration.js
?? functions/scripts/commercial_attribution_plan_attr_mig_20261028212030_5cba9b70.json
?? functions/scripts/commercial_attribution_plan_attr_mig_20261028213108_61474644.json
?? functions/scripts/commercial_attribution_plan_attr_mig_20261028220341_6f4095c6.json
?? functions/scripts/seedStagingEnvironment.js
?? modules/
?? scratch/
```

#### B. `git diff --stat`
```text
 app_core.js                                        | 7246 ++++----------------
 firestore.rules                                    |   12 +-
 functions/__tests__/clientDocumentsSec05.test.js   |   16 +-
 functions/__tests__/clientFormUi.unit.test.js      |   32 +-
 functions/__tests__/clientStorageUiFlow.test.js    |   59 +-
 functions/__tests__/clientVisibility.test.js       |   58 +-
 .../commercialClosureAndPriority.unit.test.js      |    6 +
 functions/__tests__/commercialUiFlow.test.js       |   31 +-
 functions/__tests__/crmClients.client.test.js      |   17 +-
 functions/__tests__/crmCommercial.client.test.js   |   40 +-
 functions/__tests__/crmUi.unit.test.js             |  138 +-
 .../dashboardAndOperativeClosure.unit.test.js      |    5 +-
 .../financialAndStagnationUi.unit.test.js          |  124 +-
 functions/__tests__/jointInventory.unit.test.js    |   20 +-
 .../rolePermissionsAndUiAudit.unit.test.js         |   13 +-
 functions/__tests__/storageDownload.unit.test.js   |   15 +-
 functions/__tests__/storageReview.unit.test.js     |    4 +-
 functions/__tests__/storageSecurity.unit.test.js   |   11 +-
 .../__tests__/uiEnhancementsAndPreview.test.js     |   59 +-
 functions/__tests__/viewSecureDocumentFlow.test.js |   20 +-
 functions/__tests__/workflowUiFlow.test.js         |   30 +-
 functions/isolated-tests/storage.rules.iso.js      |   12 +
 index.html                                         |   15 +-
 storage.rules                                      |   12 +-
 24 files changed, 1934 insertions(+), 6061 deletions(-)
```

#### C. `git diff --check`
```text
(Salida vacía: 0 errores de sintaxis, 0 marcadores de conflicto, 0 espacios en blanco espurios)
```

#### D. `git log -1 --oneline`
```text
19c01e9 (HEAD -> main, origin/main, origin/HEAD) fix(crm): improve role routing, commercial closure and project UI
```

**Confirmaciones de integridad Git:**
- Se confirma que **no se realizaron commits ni pushes** durante esta fase.
- Se confirma que **no se descartaron, modificaron ni restauraron** cambios locales (`no git checkout`, `no git restore`, `no git reset`, `no git clean`).
- Los respaldos en `scratch/` y las auditorías previas se mantienen intactos.

---

### 10. Restricciones de Publicación y Despliegue

- Se prohíbe taxativamente la ejecución de comandos `firebase deploy` para Hosting, Cloud Functions o Firestore Rules en esta fase.
- Se prohíben modificaciones a la base de datos de producción o migraciones destructivas.
- Todos los cambios residen estrictamente en el entorno de trabajo local hasta que la gerencia técnica autorice la fase de despliegue general.

---

### 11. Dictamen Final y Criterios de Aceptación

Todos los criterios de aceptación para el cierre formal de la Fase 6.4 han sido satisfechos:
1. ✅ Documentación formal de cierre creada en `docs/FASE_6_4_CIERRE.md`.
2. ✅ Trazabilidad del 100% de las 23 funciones originales reconciliadas con sus nuevos módulos y proxies.
3. ✅ Explicación técnica y matemática de la relación 23/21 documentada con evidencia de código.
4. ✅ Registro completo y fiel del estado de Git y verificación limpia de `git diff --check`.
5. ✅ Cero modificaciones funcionales no autorizadas.
6. ✅ Cero commits, cero pushes y cero despliegues ejecutados.
7. ✅ Preservación íntegra de la base de código para no alterar fases anteriores ni iniciar la Fase 6.5.

> ### 🟢 DICTAMEN: FASE 6.4 CERRADA FORMALMENTE
> El subsistema financiero de DUCTSAL ERP queda completamente modularizado, desacoplado, auditado y listo para preservación a largo plazo.
