# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 1: Inventario Completo de Cambios en Git

**Fecha:** 31 de Octubre de 2026  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Directorio local:** `/Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release`  
**Último commit base (HEAD):** `19c01e9 fix(crm): improve role routing, commercial closure and project UI`  
**Estado:** **PRESERVADO SIN PÉRDIDAS**  

---

## 1. RESUMEN DEL ESTADO DE GIT

El repositorio contiene el trabajo acumulado de las **Fases 6.1 a 6.7**. En estricto cumplimiento de las directivas de preservación, no se ha ejecutado ningún comando destructivo (`git reset`, `git restore`, `git clean`, `git checkout`).

### Diagnóstico de Comandos Base

- **`git log -1 --oneline`**:
  ```text
  19c01e9 (HEAD -> main, origin/main, origin/HEAD) fix(crm): improve role routing, commercial closure and project UI
  ```
- **`git diff --check`**:
  *0 advertencias, 0 errores de sintaxis o espacios en blanco residuales.*
- **`git diff --stat`**:
  *25 archivos rastreados modificados: 2,445 inserciones(+), 7,390 supresiones(-).*

---

## 2. INVENTARIO DETALLADO DE ARCHIVOS

### 2.1 Archivos Rastreados Modificados (Tracked Files Modified — 25)

| Archivo | Inserciones (+) | Supresiones (-) | Fase Relacionada | Propósito del Cambio |
| :--- | :---: | :---: | :---: | :--- |
| `app_core.js` | 1,868 | 7,153 | 6.1–6.7 | Reducción de 9,268 a 4,744 líneas (-48.81%). Delegación a módulos, fachadas de compatibilidad, suscripción reactiva a `AppState`. |
| `crm_auth.js` | 29 | 0 | 6.6 | Validación de claims de token (`cid`, `role`, `manager`), mitigación de desincronización y función `resendInvitationViaFunction`. |
| `firestore.rules` | 10 | 2 | 6.4 / 6.6 | Ajuste estricto en la función `isPostclosing` (`d != null`, validación de `estado != activo && estado != perdido`). |
| `storage.rules` | 10 | 2 | 6.1 / 6.4 | Sincronización de función `isPostclosing` idéntica a `firestore.rules`. |
| `index.html` | 28 | 2 | 6.1–6.7 | Inclusión ordenada de los 24 scripts modulares (`core/` y `modules/`) antes de `app_core.js`. |
| `functions/__tests__/clientDocumentsSec05.test.js` | 8 | 8 | 6.1 / 6.2 | Compatibilidad de visualización documental y permisos de clientes. |
| `functions/__tests__/clientFormUi.unit.test.js` | 16 | 16 | 6.2 | Pruebas de validación y renderizado de formulario de clientes. |
| `functions/__tests__/clientStorageUiFlow.test.js` | 30 | 29 | 6.1 / 6.2 | Flujo de subida y almacenamiento seguro de documentos de clientes. |
| `functions/__tests__/clientVisibility.test.js` | 29 | 29 | 6.2 / 6.6 | Reglas de visibilidad de clientes por rol y asignación comercial. |
| `functions/__tests__/commercialClosureAndPriority.unit.test.js` | 6 | 0 | 6.3 | Reglas comerciales de prioridad y cierre de oportunidades. |
| `functions/__tests__/commercialUiFlow.test.js` | 16 | 15 | 6.3 | Transición de etapas comerciales y logs idempotentes. |
| `functions/__tests__/crmClients.client.test.js` | 9 | 8 | 6.2 | Operaciones cliente en memoria y persistencia Firestore. |
| `functions/__tests__/crmCommercial.client.test.js` | 23 | 22 | 6.3 | Cálculo de etapas, probabilidades y fechas de cadencia. |
| `functions/__tests__/crmUi.unit.test.js` | 69 | 69 | 6.1–6.7 | Actualización de selectores de interfaz y pruebas de componentes UI. |
| `functions/__tests__/dashboardAndOperativeClosure.unit.test.js` | 5 | 5 | 6.5 | Métricas operativas y flujo de cierre comercial en dashboards. |
| `functions/__tests__/financialAndStagnationUi.unit.test.js` | 62 | 62 | 6.4 | Interfaz financiera, control de anticipos, retenciones y estancamiento. |
| `functions/__tests__/jointInventory.unit.test.js` | 15 | 14 | 6.4 / 6.5 | Consistencia de inventario conjunto y estados comerciales. |
| `functions/__tests__/rolePermissionsAndUiAudit.unit.test.js` | 7 | 6 | 6.6 | Auditoría de permisos de roles (`manager`, `admin`, `gestor`, `vendedor`). |
| `functions/__tests__/storageDownload.unit.test.js` | 8 | 7 | 6.1 | Descarga y tokens seguros de Storage. |
| `functions/__tests__/storageReview.unit.test.js` | 2 | 2 | 6.1 | Validación de metadatos y revisión de archivos en Storage. |
| `functions/__tests__/storageSecurity.unit.test.js` | 6 | 5 | 6.1 | Reglas de seguridad y lista blanca de extensiones documentales. |
| `functions/__tests__/uiEnhancementsAndPreview.test.js` | 30 | 29 | 6.1 | Modal y previsualización segura de documentos. |
| `functions/__tests__/viewSecureDocumentFlow.test.js` | 10 | 10 | 6.1 | Flujo completo de visualización segura mediante `DocumentViewer`. |
| `functions/__tests__/workflowUiFlow.test.js` | 15 | 15 | 6.3 / 6.5 | Flujos de trabajo y transición de vistas operativas. |
| `functions/isolated-tests/storage.rules.iso.js` | 12 | 0 | 6.1 | Pruebas aisladas para el motor de reglas de Firebase Storage. |

---

### 2.2 Archivos Nuevos Creados en `core/` (Capa Central — 3)

| Archivo | Líneas | Fase | Responsabilidad |
| :--- | :---: | :---: | :--- |
| `core/document_viewer.js` | 195 | 6.1 | Visor centralizado de documentos seguro (PDF, imágenes, Word/Excel) con sandboxing y tokens. |
| `core/app_state.js` | 370 | 6.7 | Estado compartido multi-dominio (`session`, `collections`, `selection`, `navigation`, `filters`, `lifecycle`), `syncWithScope(window)` y Pub/Sub. |
| `core/app_router.js` | 230 | 6.7 | Enrutador autónomo, control de acceso por rol, anti-spoofing en consola, scroll vertical y sincronización de cabeceras móviles. |

---

### 2.3 Archivos Nuevos Creados en `modules/` (Módulos de Dominio — 21)

#### Módulos de Clientes (`modules/clients/` — Fase 6.2)
1. `modules/clients/clients_controller.js`: Lógica de negocio, CRUD y validación de clientes.
2. `modules/clients/client_documents.js`: Gestión de documentación adjunta y subida de archivos de cliente.
3. `modules/clients/clients_ui.js`: Renderizado de tarjetas, listados, formularios y modales de cliente.

#### Módulos de Oportunidades (`modules/opportunities/` — Fase 6.3)
4. `modules/opportunities/opportunities_controller.js`: Ciclo de vida de prospectos, cotizaciones y transiciones de etapas.
5. `modules/opportunities/opportunities_ui.js`: Renderizado de tarjetas de oportunidad, vistas pipeline y agenda.

#### Módulos de Finanzas y Cobranzas (`modules/finance/` — Fase 6.4)
6. `modules/finance/finance_calculations.js`: Fórmulas puras de cobros, saldos, facturas y anticipos.
7. `modules/finance/finance_change_orders.js`: Gestión y aplicación de órdenes de cambio (aditivas y deductivas).
8. `modules/finance/finance_contracts.js`: Administración contractual y límites de monto.
9. `modules/finance/finance_invoicing.js`: Facturación, validación de retenciones y fechas fiscales.
10. `modules/finance/finance_payments.js`: Registro y conciliación de abonos y anticipos.
11. `modules/finance/finance_controller.js`: Orquestador de operaciones financieras y validación de roles.
12. `modules/finance/finance_ui.js`: Renderizado de tablas de amortización, facturación y estados de cobro.

#### Módulos de Dashboards y Analítica (`modules/dashboard/` — Fase 6.5)
13. `modules/dashboard/dashboard_audit.js`: Auditoría de consistencia de prospectos y métricas históricas.
14. `modules/dashboard/dashboard_charts.js`: Gestión y ciclo de vida de gráficos Chart.js (destrucción previa y re-render).
15. `modules/dashboard/dashboard_manager_workflow.js`: Flujo gerencial de escalaciones y reasignaciones comerciales.
16. `modules/dashboard/dashboard_controller.js`: Orquestador de métricas comerciales y filtros de cartera.
17. `modules/dashboard/dashboard_ui.js`: Renderizado de KPIs, tarjetas gerenciales y vistas de desempeño.

#### Módulos de Usuarios y Autenticación (`modules/users/` — Fase 6.6)
18. `modules/users/users_permissions.js`: Matriz central de autorización por rol (`manager`, `admin`, `gestor`, `vendedor`).
19. `modules/users/users_ui.js`: Interfaz de administración de usuarios y modales de perfil comercial.
20. `modules/users/users_controller.js`: Gestión de usuarios, invocación a Cloud Functions administrativas e invitaciones.
21. `modules/users/auth_session.js`: Manejador de ciclo de sesión de Firebase Auth, mitigación de desincronización y logout.

---

### 2.4 Nuevas Suites de Pruebas en `functions/__tests__/` (10)

| Archivo | Tests | Cobertura / Propósito |
| :--- | :---: | :--- |
| `functions/__tests__/appState.unit.test.js` | 16 | Dominios de estado, getters/setters, `syncWithScope(window)`, pub/sub, `resetAll`. |
| `functions/__tests__/appRouter.unit.test.js` | 11 | Enrutamiento inicial por rol, anti-spoofing en consola, preservación de scroll. |
| `functions/__tests__/financeModules.unit.test.js` | 28 | Módulos de cálculo financiero, órdenes de cambio, facturación y contratos. |
| `functions/__tests__/dashboardManagerWorkflow.unit.test.js` | 12 | Flujo de escalaciones gerenciales, resolución idempotente y filtros. |
| `functions/__tests__/usersModules.unit.test.js` | 24 | Gestión de usuarios, permisos, creación administrativa y autenticación. |
| `functions/__tests__/phase66ComplementaryVerification.unit.test.js` | 18 | Claims de tokens, segregación de roles comerciales y roles de planta. |
| `functions/__tests__/phase66SecurityAudit.unit.test.js` | 15 | Pruebas de seguridad negativa, rechazo de escalación y protección de perfiles. |
| `functions/__tests__/closingStorageAuthIncident.unit.test.js` | 8 | Validación del cierre del incidente de autenticación y tokens en Storage. |
| `functions/__tests__/commercialAttributionMigration.unit.test.js` | 9 | Validación de idempotencia y reversibilidad del plan de migración de atribución. |
| `functions/__tests__/stagingIsolation.unit.test.js` | 7 | Aislamiento estricto de base de datos de staging y emuladores. |

---

### 2.5 Scripts y Archivos Auxiliares en `functions/scripts/` y Raíz

- `functions/scripts/commercialAttributionMigration.js`: Script de migración de atribución comercial.
- `functions/scripts/assertTargetProject.js`: Guardia de seguridad para impedir ejecuciones accidentales contra el proyecto erróneo.
- `functions/scripts/seedStagingEnvironment.js`: Creador de datos de prueba en staging.
- `functions/scripts/commercial_attribution_plan_*.json`: Planes de migración generados para auditoría de atribución.
- `crm_staging_config.js`: Configuración aislada de variables para entorno de staging.
- `docs/`: Documentación acumulada de las Fases 6.4, 6.5, 6.6 y 6.7.

---

### 2.6 Archivos Temporales y Herramientas en `scratch/`

El directorio `scratch/` contiene artefactos de auditoría forense, capturas de pantalla de fases previas y backups preservados:
- `scratch/app_core_backup.js`: Respaldo del monolito original (9,268 líneas) utilizado para verificar la reducción matemática.
- `scratch/verify_phase67_cdp.js`: Script de prueba CDP automatizado para Chrome Headless en servidor local.
- `scratch/cdp_phase67_audit_report.json`: Reporte de ejecución CDP en tiempo real con 0 excepciones.
- Herramientas auxiliares de generación y análisis (`apply_ast_proxies.py`, `apply_dashboard_modularization.py`, etc.).
- Capturas de verificación visual de fases 5.4, 5.5, 6.1, 6.2, 6.4, 6.5, 6.6 y 6.7.

---

## 3. CONFIRMACIÓN DE PRESERVACIÓN

1. **Integridad de Fases Precedentes**: Ningún archivo funcional de las fases 6.1 a 6.6 fue removido ni descartado.
2. **Cero Pérdida de Historial**: Los backups de referencia en `scratch/` se mantienen intactos.
3. **Consistencia de Cambios**: Todas las modificaciones están alineadas con la arquitectura modular y la suite de 81 pruebas automatizadas.
