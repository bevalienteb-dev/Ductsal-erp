# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 5: Auditoría de Preparación Previa a Producción

**Fecha:** 31 de Octubre de 2026  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**URL de Producción Actual:** `https://erp.ductsal.com/`  
**Proyecto Firebase:** `ductsal-erp`  
**Estado:** **LISTO PARA PUBLICACIÓN CONTROLADA**  

---

## 1. RESUMEN EJECUTIVO PRE-PRODUCCIÓN

Este documento audita y certifica el estado de preparación de los componentes de Frontend, Backend Firebase, Reglas de Seguridad y Scripts de Migración para una futura publicación en producción, asegurando que:
1. No se requieran migraciones masivas destructivas.
2. La arquitectura UMD/IIFE no introduzca pasos de build complejos que puedan fallar en CI/CD.
3. El orden de dependencias en `index.html` sea 100% determinista.
4. Las reglas de Firebase y las Cloud Functions estén sincronizadas con los requerimientos del frontend modular.

---

## 2. AUDITORÍA DEL FRONTEND (VERCEL / HOSTING ESTÁTICO)

### 2.1 Modelo de Despliegue
- La aplicación es una Single-Page Application (SPA) basada en JavaScript vanilla, HTML5 y CSS3 sin transpiladores pesados (no utiliza Webpack, Babel ni frameworks reactivos que requieran compilación).
- Se distribuye directamente como archivos estáticos servidos en la raíz del repositorio (`index.html`, `app_core.js`, `core/`, `modules/`, hojas de estilo y utilidades `crm_*.js`).

### 2.2 Orden Determinista de Carga en `index.html`
Se verificó que los 24 módulos y utilidades se importan en riguroso orden jerárquico:
1. **Librerías CDN**: `chart.js`, `xlsx.full.min.js`, Firebase Compat SDKs (App, Firestore, Storage, Auth, Functions).
2. **Entorno y Utilidades Base**: `crm_env.js`, `crm_auth.js`, `crm_clients.js`, `crm_commercial.js`, `crm_dashboard_calc.js`, `crm_work_calendar.js`, `crm_followup_calc.js`, `crm_ui.js`, `crm_formatters.js`.
3. **Capa Núcleo**: `core/document_viewer.js`, `core/app_state.js`.
4. **Módulos de Dominio**: `modules/clients/`, `modules/opportunities/`, `modules/finance/`, `modules/dashboard/`, `modules/users/`.
5. **Capa de Navegación**: `core/app_router.js`.
6. **Fachada de Arranque**: `app_core.js`.

### 2.3 Recomendaciones de Seguridad HTTP para el Servidor Web (Vercel)
Para maximizar la robustez en `erp.ductsal.com`, se recomienda configurar los siguientes encabezados HTTP de seguridad:
- `X-Frame-Options: SAMEORIGIN` (mitigación de clickjacking).
- `X-Content-Type-Options: nosniff` (prevención de MIME-type sniffing).
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- `Content-Security-Policy`: Permitir dominios oficiales de Firebase (`*.firebaseio.com`, `*.googleapis.com`, `identitytoolkit.googleapis.com`, `firebasestorage.googleapis.com`).

---

## 3. AUDITORÍA DEL BACKEND FIREBASE

### 3.1 Identificación y Aislamiento de Proyectos
- **Producción**: `ductsal-erp` (proyecto oficial activo).
- **Staging / Pruebas**: `crm_staging_config.js` implementa `assertStagingIsolation` que aborta inmediatamente cualquier intento de inicializar producción desde entornos no autorizados.
- **Guardia de Ejecución (`functions/scripts/assertTargetProject.js`)**: Impide que scripts de mantenimiento se ejecuten por error contra un proyecto distinto al especificado explícitamente por el operador.

### 3.2 Cloud Functions (`functions/`)
- **Entorno de Ejecución**: Node.js 18 / 20 compatible.
- **Archivo de Reglas y Exclusiones (`firebase.json`)**:
  Configurado adecuadamente para omitir archivos de testing (`**/__tests__/**`), scripts temporales y documentación durante el empaquetado y despliegue de Functions.
- **Funciones Administrativas Obligatorias**:
  `createUserAdmin`, `updateUserAdmin`, `toggleUserStatusAdmin`, `resendInvitationAdmin`, `resolveProspectEscalationAdmin`.

### 3.3 Reglas de Firestore y Storage
- **`firestore.rules`**: Implementa la versión auditada con función `isPostclosing` robusta (`d != null`, validación de `estado != activo && estado != perdido`), inmutabilidad de `users_prod`, y prohibición de modificaciones directas a `prospects_prod`.
- **`storage.rules`**: Sincronizada exactamente con `firestore.rules` y reforzada con lista blanca de extensiones documentales.

---

## 4. AUDITORÍA DE MIGRACIONES DE DATOS

### 4.1 Plan de Corrección de Atribución Comercial (`commercialAttributionMigration.js`)
- **Naturaleza**: Migración analítica de reconciliación de `vendedorId`, `vendedorName` y `vendedorRole`.
- **Precondiciones**:
  1. Ejecución obligatoria en modo dry-run preliminar (`--dry-run`).
  2. Generación y revisión de plan auditable en JSON (`functions/scripts/commercial_attribution_plan_*.json`).
  3. Verificación de bandera `--allow-authorized-production-run`.
- **Blindaje**:
  El script cuenta con la lista de protección `FORBIDDEN_PATCH_FIELDS` (impide tocar precios, facturas, fechas de creación, estados, etapas o costos).
- **Reversibilidad**:
  Genera registros de respaldo previo a cada mutación por lote, permitiendo reversión quirúrgica individualizada sin alterar ediciones humanas concurrentes.
- **Recomendación**:
  **No requiere ejecución inmediata para la salida a producción de la Fase 6.7.** Puede ejecutarse de manera desacoplada en una ventana de mantenimiento posterior si la gerencia comercial lo determina.

---

## 5. LISTA DE COMPROBACIÓN PREVIA AL DESPLIEGUE (PRE-FLIGHT CHECKLIST)

- [x] 81/81 suites de prueba de Jest aprobadas (2,168/2,168 tests pasados).
- [x] 10/10 escenarios funcionales de Chrome CDP validados con 0 excepciones JS.
- [x] Cero contraseñas en texto plano en la base de datos o en el código fuente.
- [x] Reglas de seguridad de Firestore y Storage auditadas y sincronizadas.
- [x] Sincronización bidireccional de `AppState` con `window` verificada.
- [x] Enrutamiento por rol y control de acceso anti-spoofing comprobado.
- [x] Backups y archivos de diagnóstico preservados.
- [x] Sin modificaciones de git destructivas en el entorno local.
