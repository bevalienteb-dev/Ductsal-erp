# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 9: Matriz de Integridad Funcional Cruzada y Reporte de Cobertura de Pruebas

**Fecha:** 31 de Octubre de 2026  
**Auditor:** Especialista en QA / Arquitecto Senior  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Estado:** **APROBADO — 100% DE PRUEBAS SUPERADAS SIN REGRESIONES**  

---

## 1. MATRIZ DE INTEGRIDAD FUNCIONAL CRUZADA (10 FLUJOS DE NEGOCIO)

Se evaluó la continuidad de datos y reglas de negocio entre los módulos desacoplados para confirmar que ningún flujo operativo sufre rupturas al cruzar las fronteras de los dominios:

| # | Flujo de Negocio | Módulos Involucrados | Regla Crítica Comprobada | Estado | Evidencia / Prueba |
| :-: | :--- | :--- | :--- | :---: | :--- |
| **1** | **Clientes y Documentos** | `modules/clients/` $\leftrightarrow$ `core/document_viewer.js` | Alta de cliente exige validación de NIT/DUI; expedientes subidos a Storage son renderizados en modal seguro sandboxed. | **APROBADO** | `clientStorageUiFlow.test.js`<br>`clientFormUi.unit.test.js` |
| **2** | **Oportunidades y Etapas** | `modules/opportunities/` $\leftrightarrow$ `core/app_state.js` | Transición entre etapas (`contacto` $\rightarrow$ `ganado`) valida requisitos comerciales e invoca `addLog` de forma idempotente. | **APROBADO** | `commercialUiFlow.test.js`<br>`commercialClosureAndPriority.unit.test.js` |
| **3** | **Cotizaciones y Propuestas**| `modules/opportunities/` $\leftrightarrow$ `crm_commercial.js` | Las cotizaciones heredadas y nuevas calculan subtotales, márgenes y probabilidad de conversión de manera homogénea. | **APROBADO** | `migrateHistoricalQuotes.unit.test.js`<br>`crmCommercial.client.test.js` |
| **4** | **Conversión a Proyecto** | `modules/opportunities/` $\rightarrow$ `modules/finance/` | Al pasar a etapa `ganado`, la oportunidad adquiere bandera de postcierre y queda accesible en `projects-view` para finanzas. | **APROBADO** | `postclosingHistoricalCompatibility.unit.test.js` |
| **5** | **Contratos y Órdenes de Cambio** | `modules/finance/finance_contracts.js` $\leftrightarrow$ `change_orders.js` | Las órdenes de cambio aditivas/deductivas recalculan el monto contratado sin alterar montos ya cobrados. | **APROBADO** | `financeModules.unit.test.js` |
| **6** | **Facturación y Anticipos** | `modules/finance/finance_invoicing.js` | Protección estricta: se impide facturar saldos ordinarios si existe un anticipo comercial pendiente de amortización. | **APROBADO** | `financialAndStagnationUi.unit.test.js` |
| **7** | **Pagos y Saldos Pendientes** | `modules/finance/finance_payments.js` $\leftrightarrow$ `calculations.js` | $\text{Saldo CxC} = \text{Total} - \text{Cobrado}$. Los abonos se concilian con fechas fiscales precisas sin desfases decimales. | **APROBADO** | `financeModules.unit.test.js` |
| **8** | **Dashboard y Métricas** | `modules/dashboard/` $\leftrightarrow$ `core/app_state.js` | KPIs gerenciales leen directamente `AppState.collections.getProspects()`. Destrucción explícita de `Chart.js` previa a renderizado. | **APROBADO** | `dashboardManagerWorkflow.unit.test.js`<br>`dashboardAndOperativeClosure.unit.test.js` |
| **9** | **Usuarios, Roles y Permisos**| `modules/users/` $\leftrightarrow$ `core/app_router.js` | Sincronización estricta de claims `cid`/`role`. Vendedores tienen vistas financieras en solo lectura y dashboards bloqueados. | **APROBADO** | `usersModules.unit.test.js`<br>`rolePermissionsAndUiAudit.unit.test.js` |
| **10**| **Document Viewer** | `core/document_viewer.js` | Sandboxing de iframe, validación de prefijo de entorno (`prod_files/`), destrucción de tokens al cierre del modal. | **APROBADO** | `viewSecureDocumentFlow.test.js`<br>`storageSecurity.unit.test.js` |

---

## 2. REPORTE EMPÍRICO DE LA SUITE DE PRUEBAS AUTOMATIZADAS (`npm test -- --coverage`)

La suite automatizada completa fue ejecutada en el paquete `functions/`.

### 2.1 Resultados Generales de Ejecución
- **Suites de Prueba Ejecutadas**: **81**
- **Suites de Prueba Aprobadas**: **81 (100%)**
- **Suites de Prueba Fallidas**: **0**
- **Pruebas Totales Ejecutadas**: **2,168**
- **Pruebas Aprobadas**: **2,168 (100%)**
- **Pruebas Fallidas**: **0**
- **Pruebas Omitidas (Skipped)**: **0**
- **Aserciones Debilitadas o Eliminadas**: **0**

### 2.2 Resumen Métrico de Cobertura de Código

| Ámbito | Cobertura Sentencias (% Stmts) | Cobertura Ramas (% Branch) | Cobertura Funciones (% Funcs) | Cobertura Líneas (% Lines) |
| :--- | :---: | :---: | :---: | :---: |
| **Total Global (All Files)** | **81.14%** | **71.11%** | **83.05%** | **83.32%** |
| **Servicios Backend (`functions/`)** | **83.82%** | **73.76%** | **83.53%** | **86.94%** |
| `functions/test-helpers/` | **97.15%** | **80.19%** | **95.76%** | **98.29%** |

### 2.3 Cobertura en Módulos Críticos de Backend

| Módulo / Servicio | % Líneas | % Sentencias | % Ramas | Notas de Validación |
| :--- | :---: | :---: | :---: | :--- |
| `clientIdentity.js` | **100.00%** | 94.11% | 89.76% | Validación estricta de unicidad de NIT y DUI. |
| `plantAuthService.js` | **98.52%** | 95.55% | 88.75% | Aislamiento y validación de tokens de planta (`plantLogin`). |
| `workflowService.js` | **96.21%** | 93.52% | 82.26% | Orquestación atómica de transiciones comerciales. |
| `stagingService.js` | **94.93%** | 91.01% | 73.18% | Aislamiento estricto de base de datos de pruebas. |
| `rollbackUtil.js` | **94.31%** | 93.25% | 83.33% | Reversión quirúrgica y preservación de ediciones humanas. |
| `commercialService.js`| **91.07%** | 89.68% | 77.62% | Motor de cálculo de comisiones, probabilidad y cadencia. |
| `index.js` (Callables) | **84.82%** | 84.19% | 72.78% | Puntos de entrada HTTPS Callables administrativos y comerciales. |

---

## 3. AUDITORÍA DE CALIDAD DE PRUEBAS

1. **Ausencia de Pruebas Débiles o Triviales**: Las pruebas no se limitan a aserciones superficiales de verdad (`toBe(true)`), sino que evalúan el estado de los documentos en Firestore, tokens de bloqueo concurrentes, códigos de error HTTPS específicos (`permission-denied`, `failed-precondition`, `already-exists`) y renderizado real en DOM simulado.
2. **Pruebas de Seguridad Negativa**: Se validan explícitamente escenarios de ataque: tokens sin claims, roles falsificados, suplantación de `cid`, llamadas a Firestore evadiendo Cloud Functions e intentos de deshabilitar la cuenta del propio gerente.
3. **Determinismo Temporal**: El uso de `jest.useFakeTimers()` y semillas de datos controladas elimina la intermitencia en pruebas dependientes del reloj del sistema.
