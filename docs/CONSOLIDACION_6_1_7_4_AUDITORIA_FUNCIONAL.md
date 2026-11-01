# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 4: Auditoría de Integridad Funcional de los Módulos

**Fecha:** 31 de Octubre de 2026  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Directorio local:** `/Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release`  
**Estado:** **APROBADO — INTERACCIONES DE DOMINIO VERIFICADAS**  

---

## 1. RESUMEN DE INTEGRIDAD FUNCIONAL

La consolidación arquitectónica de las Fases 6.1 a 6.7 comprobó no solo el aislamiento unitario de cada módulo, sino la **interacción integral entre dominios de negocio**. Todos los flujos operativos entre módulos desacoplados preservan la semántica y reglas de negocio del sistema preexistente.

---

## 2. CLIENTES Y OPORTUNIDADES (FASES 6.2 Y 6.3)

### 2.1 Flujo Cliente $\rightarrow$ Oportunidad
- **Creación y Vinculación**: La creación de una oportunidad (`opportunities_controller.js`) exige un `clientId` válido existente en `clients_prod`.
- **Integridad Referencial**: Los datos comerciales del cliente (razón social, contacto, teléfono, NIT/DUI) se sincronizan en memoria a través de `AppState.collections.getClients()` y se reflejan reactivamente en las tarjetas de pipeline y modales de edición.
- **Visibilidad Cruzada**:
  - Un vendedor solo puede ver clientes que ha creado o que están vinculados a oportunidades que le han sido asignadas (`visibleTo`).
  - Los managers y gestores tienen acceso irrestricto a la cartera total de clientes y oportunidades.

### 2.2 Ciclo de Vida y Transición de Etapas
- La máquina de estados comerciales en `opportunities_controller.js` gobierna las etapas:
  `contacto` $\rightarrow$ `levantamiento` $\rightarrow$ `cotizacion` $\rightarrow$ `negociacion` $\rightarrow$ `ganado` / `perdido`.
- El cambio a `ganado` desencadena la habilitación de postcierre y la creación de la ficha de proyecto en el módulo financiero.
- Los logs de seguimiento se registran mediante invocaciones idempotentes (`addLog`), evitando duplicación por clics múltiples.

---

## 3. FINANZAS Y COBRANZAS (FASE 6.4)

### 3.1 Contratos, Anticipos y Facturación
- **Cálculos Matemáticos Puros (`finance_calculations.js`)**:
  - Subtotal, IVA (13%), retención de IVA (1% para Grandes Contribuyentes), retención de renta si aplica.
  - El saldo CxC se calcula con precisión monetaria:  
    $$\text{Saldo CxC} = \text{Total Contratado} - \text{Total Cobrado}$$
- **Protección de Facturas de Anticipo**:
  - `finance_invoicing.js` impide registrar facturas ordinarias o créditos fiscales si existe un anticipo contractual pendiente de amortización o facturación.
- **Órdenes de Cambio (`finance_change_orders.js`)**:
  - Las órdenes de cambio aditivas incrementan el monto contractual total, recalculando el porcentaje de facturación y cobro.
  - Las órdenes deductivas reducen el compromiso contractual y validan que el nuevo total no sea inferior a lo ya facturado o cobrado.

### 3.2 Restricciones por Rol en Finanzas
- Los vendedores únicamente poseen permisos de lectura en la vista de proyectos (`projects-view`). Los botones de emisión de facturas, registro de abonos y generación de órdenes de cambio están ocultos e inhabilitados en la UI y rechazados en las Cloud Functions.
- La gestión financiera operativa corresponde exclusivamente a usuarios con rol `manager` o `gestor`.

---

## 4. DASHBOARDS Y ANALÍTICA GERENCIAL (FASE 6.5)

### 4.1 Agregaciones y KPIs en Tiempo Real
- `dashboard_controller.js` procesa en memoria el catálogo de prospectos de `AppState.collections.getProspects()` para calcular:
  - Total de ventas ganadas en el período seleccionado.
  - Pipeline activo ponderado por probabilidad de éxito.
  - Tasa de conversión por etapa y tiempo promedio de permanencia por fase.
- **Preservación Histórica de Métricas**:
  - Se confirmó la correcta atribución de ventas históricas (incluyendo registros de Carlos Mendoza y Alejandra Ayala) sin duplicidades ni exclusiones erróneas.

### 4.2 Ciclo de Vida de Gráficos (`dashboard_charts.js`)
- Cada llamada a `renderCharts()` destruye explícitamente las instancias previas de `Chart.js` (`destroyAllCharts()`), liberando los contextos 2D de los elementos `<canvas>` y previniendo fugas de memoria (memory leaks) o parpadeos en pantalla.

### 4.3 Flujo Gerencial de Escalación (`dashboard_manager_workflow.js`)
- Permite a los gerentes reasignar prospectos estancados o resolver disputas de cartera mediante `resolveProspectEscalationAdmin`, asegurando atomicidad y registro en bitácora.

---

## 5. USUARIOS, ROLES Y AUTENTICACIÓN (FASE 6.6)

### 5.1 Matriz de Roles y Navegación
- **`manager`**: Acceso integral a todas las vistas (`dashboard-view`, `projects-view`, `clients-view`, `users-view`, `list-view`).
- **`admin`**: Vista principal en `users-view` para mantenimiento de usuarios y configuración del sistema.
- **`gestor`**: Vista principal en `list-view` (agenda operativa) y `projects-view` para seguimiento de cobranza y proyectos ganados.
- **`vendedor`**: Vista restringida a `list-view` (agenda y pipeline personal). Intentos de acceder a `dashboard-view` o `users-view` son bloqueados por el router con alerta visual y redirección forzada.

### 5.2 Ciclo de Sesión y Logout Atómico (`auth_session.js` / `AppState.resetAll`)
- El cierre de sesión (`processLogout`):
  1. Invoca `firebase.auth().signOut()`.
  2. Ejecuta `AppState.resetAll()` reiniciando colecciones a `[]`, usuario a `null`, desuscribiendo los listeners de Firestore y limpiando `localStorage`.
  3. Ejecuta `AppRouter.resetRouterState()` devolviendo la vista a `#login-screen`.
  4. Garantiza que ninguna información de una sesión anterior sea visible para el siguiente usuario.

---

## 6. VISOR DOCUMENTAL Y STORAGE (FASE 6.1)

- `core/document_viewer.js` centraliza la previsualización segura de documentos de clientes y contratos de prospectos.
- Soporta renderizado de PDFs nativos en iframe sandboxed, imágenes optimizadas y vista previa de documentos Office.
- El cierre del modal destruye las referencias a URLs blob o tokens temporales para mitigar retención de memoria.

---

## 7. DICTAMEN DE INTEGRIDAD FUNCIONAL

> **ESTADO FUNCIONAL: APROBADO**  
> Todas las interacciones entre los módulos de Clientes, Oportunidades, Finanzas, Dashboards, Usuarios y Visor Documental operan de manera armónica, sin desincronización de estado ni regresiones en la lógica de negocio.
