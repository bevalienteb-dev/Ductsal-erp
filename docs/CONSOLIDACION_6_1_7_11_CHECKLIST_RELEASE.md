# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 11: Lista de Control de Preparación y Criterios de Aceptación para Release

**Fecha:** 31 de Octubre de 2026  
**Auditor:** Release Engineering Lead / QA Architect  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Dominio Objetivo:** `https://erp.ductsal.com/`  
**Proyecto Firebase:** `ductsal-erp`  
**Estado:** **LISTO PARA SOLICITAR AUTORIZACIÓN DE PUBLICACIÓN**  

---

## 1. LISTA DE CONTROL DE COMPROBACIÓN TÉCNICA (CHECKLIST)

### 1.1 Código Fuente y Arquitectura
- [x] **Cero comandos destructivos de git**: No se ha ejecutado `git reset`, `git restore`, `git clean` ni `git checkout` para descartar cambios.
- [x] **24 módulos desacoplados**: `core/` (3 módulos) y `modules/` (21 módulos) operan bajo arquitectura DAG sin dependencias circulares.
- [x] **Reducción de `app_core.js`**: Disminución verificada de 9,268 a 4,744 líneas (-48.81%).
- [x] **Orden de carga determinista**: `index.html` importa librerías CDN, utilidades, núcleo, dominios y enrutador antes de `app_core.js`.
- [x] **Sincronización `syncWithScope(window)`**: Puente bidireccional entre `AppState` y ámbito global verificado con descriptores de propiedad y Pub/Sub.

### 1.2 Calidad y Pruebas Automatizadas
- [x] **Suite Jest completa**: **81/81 suites aprobadas** y **2,168/2,168 pruebas aprobadas (100%)**.
- [x] **Cobertura global**: 83.32% en líneas, 81.14% en sentencias, 86.94% en backend (`functions/`).
- [x] **Cero pruebas omitidas**: 0 pruebas `skip`, 0 pruebas debilitadas.
- [x] **Determinismo**: Pruebas con fechas y timers aislados mediante `jest.useFakeTimers()`.

### 1.3 Validación en Navegador Real (CDP / Chromium)
- [x] **10/10 escenarios funcionales superados**: Sin autenticación, login de los 4 roles comerciales, modales, document viewer, scroll y logout.
- [x] **11 capturas de pantalla físicas generadas**: Incluyendo capturas específicas para T7 (modal abierto) y T9 (scroll restaurado).
- [x] **Cero excepciones no controladas**: 0 errores JS en runtime y 0 unhandled promise rejections.
- [x] **Defensa anti-spoofing**: Alertas de denegación y redirección forzada verificadas ante intentos de acceso en consola.

### 1.4 Seguridad y Backend Firebase
- [x] **`firestore.rules` blindadas**: Regla `isPostclosing` validada (`d != null`, estado válido), inmutabilidad de `users_prod`, mutaciones comerciales exclusivamente por Cloud Functions.
- [x] **`storage.rules` sincronizadas**: Aislamiento de prefijos por entorno (`prod_files/` vs. `local_files/`) y lista blanca de extensiones.
- [x] **Cloud Functions auditadas**: `createUserAdmin`, `updateUserAdmin`, `toggleUserStatusAdmin`, `resendInvitationAdmin`, `resolveProspectEscalationAdmin` con verificación estricta de claims `manager === true`, bloqueo de concurrencia e idempotencia.
- [x] **Cero credenciales en código**: 0 claves privadas, 0 secretos y 0 contraseñas en texto plano.

### 1.5 Aislamiento de Entornos y Migraciones
- [x] **Aislamiento Staging vs. Producción**: `crm_staging_config.js` implementa `assertStagingIsolation` que aborta si se intenta conectar a `ductsal-erp` desde un entorno no productivo.
- [x] **Guardia de scripts**: `assertTargetProject.js` previene la ejecución accidental de scripts de mantenimiento sobre proyectos no autorizados.
- [x] **Migración de Atribución Comercial**: `commercialAttributionMigration.js` está blindado con modo dry-run por defecto, lista de campos prohibidos (`FORBIDDEN_PATCH_FIELDS`) y reversibilidad quirúrgica. **No se requiere su ejecución para la publicación de la Fase 6.7**.

---

## 2. CRITERIOS DE ACEPTACIÓN PARA PUBLICACIÓN

| Criterio | Requisito Mínimo | Estado Verificado | Cumplimiento |
| :--- | :--- | :--- | :---: |
| **Integridad de Fases 6.1 a 6.7** | Cero regresiones en funcionalidades previas | 81/81 suites de prueba aprobadas | **100%** |
| **Seguridad de Datos** | Sin mutaciones no autorizadas desde frontend | Reglas de denegación total y validación de claims activas | **100%** |
| **Estabilidad de UI** | Sin parpadeos ni excepciones de consola | 10 escenarios CDP aprobados con 0 errores | **100%** |
| **Reversibilidad** | Procedimiento de rollback claro para frontend y reglas | Procedimiento documentado en Documento 6 | **100%** |

---

## 3. PROCEDIMIENTO DE ROLLBACK DIFERENCIADO

1. **Frontend (Vercel)**:
   - *Mecanismo*: Instant Rollback en consola de Vercel hacia el despliegue previo estable (`19c01e9`).
   - *Tiempo estimado*: Menos de 1 minuto.
   - *Impacto en datos*: Cero impacto (el frontend no almacena datos locales permanentes).
2. **Reglas de Seguridad (Firestore y Storage)**:
   - *Mecanismo*: Despliegue de reglas base mediante `git checkout 19c01e9 -- firestore.rules storage.rules && firebase deploy --only firestore:rules,storage:rules`.
   - *Tiempo estimado*: Menos de 2 minutos.
3. **Cloud Functions**:
   - *Mecanismo*: Re-despliegue de la versión previa de functions desde commit `19c01e9`.
   - *Consideración*: Si se requiere rollback, verificar que no existan operaciones concurrentes en vuelo (`userOpsLocks`).
