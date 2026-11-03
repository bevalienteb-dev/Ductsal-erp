# PROPUESTA DE RELEASE — INICIATIVAS 6.2, 6.3 Y 6.5

**Proyecto:** DUCTSAL ERP (`sales-reporting-system-release`)  
**Fecha:** 2 de Noviembre de 2026 (21:40 CST / 03:40 UTC del 3 de Noviembre)  
**ID de Proyecto de Producción:** `ductsal-erp` (Google Cloud Project Number: `948658286825`)  
**Dominio de Producción:** `https://erp.ductsal.com`  
**Documento:** Análisis de Release, Inventario Git, Matriz de Dependencias, Evaluación de Riesgos y Plan de Despliegue  
**Estado:** **PROPUESTA TÉCNICA DE RELEASE — CERO MODIFICACIONES, CERO DESPLIEGUES EJECUTADOS**  
**Dictamen:** **LISTO PARA PROPUESTA — REQUIERE AUTORIZACIÓN INDEPENDIENTE PARA PUBLICACIÓN**  

---

## 1. Inventario Completo de Git y Clasificación por Iniciativa

Se realizó una auditoría exhaustiva del árbol de trabajo (`git status`, `git diff --stat`, `git ls-files -d`, `git ls-files --others`).

### 1.1 Resumen Métrico del Árbol de Trabajo
* **Archivos modificados (Tracked):** 15 archivos (`1,242 inserciones(+), 129 eliminaciones(-)`).
* **Archivos eliminados (Tracked):** **0 archivos**.
* **Archivos nuevos (Untracked):** 76 archivos (desglosados entre código de producción, pruebas, evidencias visuales y documentación).
* **Integridad de formato:** `git diff --check` limpio (**0 errores de espacios o formato**).

---

### 1.2 Clasificación Detallada de Archivos Modificados

| Archivo Modificado | Iniciativa | Estado | Diferencias Relevantes y Justificación Técnica |
| :--- | :---: | :---: | :--- |
| [`app_core.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js) | **6.2 / 6.3** | Modificado | **6.2:** Elimina el manejador `processFirstTimeSetup` que guardaba contraseñas en Firestore.<br/>**6.3:** Añade modal `#forgot-password-modal`, observador de retorno `mode=activate`, reconciliación de outbox al login de gerencia y guarda `loginInFlight`. |
| [`crm_auth.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js) | **6.3** | Modificado | Configura `PRODUCTION_ACTION_CODE_SETTINGS` (`url: 'https://erp.ductsal.com/login?mode=activate'`, `handleCodeInApp: false`), `auth.languageCode = 'es'`, delegación de despacho a Client SDK, integración con `CrmOutbox` y purga de parámetros sensibles (`history.replaceState`). |
| [`modules/users/users_controller.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js) | **6.2 / 6.3** | Modificado | **6.2:** Elimina escrituras directas del cliente a `users_prod`.<br/>**6.3:** Añade guardas anti-doble clic en memoria (`userSaveInFlight`, `resetPassInFlight`) y encola tickets en el outbox local. |
| [`index.html`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html) | **6.2 / 6.3** | Modificado | **6.2:** Elimina modal legacy `#setup-screen`.<br/>**6.3:** Añade modal accesible `#forgot-password-modal`, enlace "¿Olvidaste tu contraseña?", banner de retorno e inserta `crm_outbox.js` en el orden de carga. |
| [`functions/index.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) | **6.2 / 6.3 / 6.5** | Modificado | **6.2:** `createUserAdmin` elimina almacenamiento de contraseñas provisionales en Firestore.<br/>**6.3:** Elimina llamadas a `generatePasswordResetLink()` en `createUserAdmin` y `resendInvitationAdmin`. Expone callables: `recordInvitationOutcomeAdmin`, `confirmUserActivation`, `reconcileUserOp`.<br/>**6.5:** Cláusula `const id = data.id || data.userId;` en `resendInvitationAdmin` para compatibilidad de identificador. |
| [`functions/package.json`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/package.json) | **Infraestructura** | Modificado | Define comandos de ejecución modular de pruebas (`test:unit`, `test:auth-env`, `test:ownership`, `test:native-auth`). |
| [`firebase.emulator.json`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/firebase.emulator.json) | **Infraestructura** | Modificado | Ajuste de configuración para habilitar UI de emuladores locales en `127.0.0.1`. |
| [`functions/test-helpers/fakeFirebase.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/test-helpers/fakeFirebase.js) | **Infraestructura** | Modificado | Mocks de prueba con soporte para clonación profunda y transacciones simuladas de Firestore. |
| [`functions/__tests__/createUserAdmin.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/createUserAdmin.test.js) | **6.2 / 6.3** | Modificado | Aserciones de creación delegando despacho al cliente y verificando ausencia de contraseñas. |
| [`functions/__tests__/updateUserAdmin.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/updateUserAdmin.test.js) | **6.2** | Modificado | Rechazo estricto de campos no autorizados y sincronización Auth/Firestore. |
| [`functions/__tests__/adminFunctions.iter7.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/adminFunctions.iter7.test.js) | **6.3** | Modificado | Reenvío de invitación emite ticket para cliente sin generar link en servidor. |
| [`functions/__tests__/emulatorStatics.regression.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/emulatorStatics.regression.test.js) | **6.3** | Modificado | Regresión de módulos estáticos de Firestore en emulador. |
| [`functions/__tests__/phase66ComplementaryVerification.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/phase66ComplementaryVerification.unit.test.js) | **6.2** | Modificado | Verificación de respuestas sin contraseñas temporales ni secretos. |
| [`functions/__tests__/phase66SecurityAudit.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/phase66SecurityAudit.unit.test.js) | **6.2 / 6.3** | Modificado | Auditoría de autorización y roles sobre callables administrativas. |
| [`functions/emulator-tests/createUserAdmin.e2e.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/createUserAdmin.e2e.emu.js) | **6.3** | Modificado | Suite E2E de ciclo de usuario sobre emulador real (`result.data.link === null`). |

---

### 1.3 Clasificación Detallada de Archivos Nuevos (Untracked)

#### A. Código de Producción (Obligatorio para Release)
1. [`crm_outbox.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_outbox.js) (**Iniciativa 6.3 — Frontend**): Cola Write-Ahead local (`localStorage`), clave `crm_outbox_${managerUid}`, TTL 24 horas y regla `assertNoSecrets`.
2. [`functions/invitationService.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js) (**Iniciativa 6.3 — Backend**): Servicio de aislamiento de entornos (`isControlledEnvironment`), definición de estados de invitación (`INVITATION_STATUS`) y resolución de ActionCodeSettings.

#### B. Suites de Pruebas Unitarias y en Emulador (No empaquetadas en producción)
* **Iniciativa 6.3 (Pruebas de Emulador):**
  - `functions/emulator-tests/authEmulatorIsolation.emu.js`
  - `functions/emulator-tests/authEmulatorTestHelper.js`
  - `functions/emulator-tests/authTicketOwnership.emu.js`
  - `functions/emulator-tests/nativeAuthFlow.emu.js`
  - `functions/scripts/cleanEmulatorData.js`
* **Iniciativa 6.3 (Pruebas Unitarias Jest):**
  - `functions/__tests__/actionCodeSettingsIsolation.unit.test.js`
  - `functions/__tests__/authEmulatorEnvironment.unit.test.js`
  - `functions/__tests__/crmOutbox.unit.test.js`
  - `functions/__tests__/frontendPasswordSetupAndRecovery.test.js`
  - `functions/__tests__/nativeArchitectureVerification.unit.test.js`
  - `functions/__tests__/userLifecycleBackend.unit.test.js`
* **Iniciativa 6.5 (Pruebas Unitarias y Scripts):**
  - `functions/__tests__/postValidationIdentityAndChanges.unit.test.js` (Verificación de correspondencia de correo e ID/userId).
  - `scripts/verify_phase6_5_e2e_matrix.js` (Harness de ejecución de matriz E2E).
* **Otras Pruebas de Mantenimiento:**
  - `functions/__tests__/gestorQueryOptimization.unit.test.js`

#### C. Evidencia o Documentación
* **Informes de Fases 6.1 a 6.3.8:**
  - `docs/step6_1_user_auth_email_audit.md`
  - `docs/step6_2_backend_final_audit.md`
  - `docs/step6_2_backend_implementation_report.md`
  - `docs/step6_3_1_firebase_native_email_audit.md` a `docs/step6_3_8_initiative_closure_report.md` (21 informes técnicos de la serie 6.3).
  - `docs/step6_4_frontend_password_setup_recovery.md`
  - `docs/step6_5_end_to_end_validation.md`
  - `docs/step6_5_post_validation_review.md`
* **Capturas de Pantalla:** `docs/screenshots/*` (Evidencia visual de 6.3.4.1 y 6.5).
* **Artefactos Ajenos a la Serie 6 (Paso 5):**
  - `DUCTSAL_PASO5_EVIDENCIA_VISUAL_CORREGIDA.zip`
  - `docs/evidence_step5/*` (19 archivos de evidencia gráfica y hashes del Paso 5).
  - Reportes de optimización de lecturas Firestore del Paso 5 (`docs/optimization_manager_firestore_reads_report.md`, `docs/validation_performance_firestore_report.md`, `docs/validation_step5_*`).
* **Configuraciones de Entorno IDE:** `.agents/rules/environments.md`.
* **Scripts Utilitarios:** `scripts/execute_controlled_real_email.js`, `scripts/update_email_templates_app_name.js`, `scripts/verify_client_sdk_and_ui_flows.js`.

---

## 2. Dependencias entre Cambios y Viabilidad de Separación

### 2.1 Dependencia Inseparable entre 6.2 y 6.3
* **6.2 (Eliminación del flujo legacy inseguro):** Elimina el almacenamiento de contraseñas provisionales en Firestore y la pantalla `#setup-screen`.
* **6.3 (Implementación del flujo nativo seguro):** Provee el mecanismo sustituto mediante invitación y recuperación por Client SDK y Outbox local.
* **Dictamen de Dependencia:** **6.2 y 6.3 NO PUEDEN SEPARARSE.** Si se publicara 6.2 sin 6.3, el sistema crearía usuarios sin contraseña pero sin ningún mecanismo para enviarles su invitación ni permitirles definir credenciales. Ambas iniciativas constituyen una única solución técnica coherente.

### 2.2 Tratamiento e Integración de la Iniciativa 6.5
* **Naturaleza de 6.5:** La Fase 6.5 fue una fase de **validación y verificación de matriz E2E sobre emuladores**.
* **Único cambio en código de producción atribuible a 6.5:**  
  En [`functions/index.js:1065`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L1065) (`resendInvitationAdmin`):
  ```javascript
  if (data.id && data.userId && data.id !== data.userId) {
    throw new functions.https.HttpsError('invalid-argument', 'Ambiguous id and userId provided');
  }
  const id = data.id || data.userId;
  ```
* **Análisis de Impacto:** Este cambio es una **mejora de tolerancia y robustez defensiva 100% retrocompatible**: permite que la Cloud Function acepte tanto el identificador tradicional `data.id` (enviado por el modal de usuarios) como `data.userId` (persistido por el outbox). No altera contratos, no introduce riesgo y ya fue auditado en `docs/step6_5_post_validation_review.md`.
* **Archivos auxiliares de 6.5:** `scripts/verify_phase6_5_e2e_matrix.js`, `postValidationIdentityAndChanges.unit.test.js` y las capturas de pantalla son exclusivamente artefactos de prueba local. **No forman parte del bundle de producción que se despliega a Vercel ni a Firebase.**

---

## 3. Propuesta de Release: Alcance Funcional y Técnico

La propuesta contempla desplegar de forma atómica y coordinada el **paquete productivo consolidado de 6.2 y 6.3** (incorporando la tolerancia defensiva de 6.5 en backend):

```
+-------------------------------------------------------------------------------+
| BUNDLE DE FRONTEND (Destino: Vercel / https://erp.ductsal.com)                |
| 1. index.html                          (Modal recuperación, banner, orden)    |
| 2. app_core.js                         (Controladores, anti-enumeración)      |
| 3. crm_auth.js                         (Client SDK, ActionCodeSettings)       |
| 4. crm_outbox.js [NUEVO]               (Cola Write-Ahead local localStorage)  |
| 5. modules/users/users_controller.js   (Guardas in-flight, outbox)            |
+-------------------------------------------------------------------------------+
| BUNDLE DE BACKEND (Destino: Firebase Cloud Functions / ductsal-erp)           |
| 1. functions/index.js                  (Callables 6.3, cero contraseñas)      |
| 2. functions/invitationService.js [NUEVO] (Aislamiento y reglas de tickets)   |
| 3. functions/package.json              (Scripts y dependencias)               |
+-------------------------------------------------------------------------------+
| BASE DE DATOS Y REGLAS (Firestore / ductsal-erp)                              |
| - firestore.rules                      (SIN CAMBIOS - Ya protege users_prod)  |
| - firestore.indexes.json               (SIN CAMBIOS - No requiere índices)    |
+-------------------------------------------------------------------------------+
```

---

## 4. Evaluación de Riesgos y Medidas de Mitigación

| Riesgo Técnico Identificado | Nivel de Riesgo | Medida de Mitigación Implementada y Verificada |
| :--- | :---: | :--- |
| **Afectación a usuarios existentes en producción** | **Bajo** | Los 4 usuarios activos (`dgonzalez`, `bvaliente`, `aayala`, `rflores`) conservan intactos sus perfiles en `users_prod` y sus credenciales en Firebase Auth. No se ejecuta `revokeRefreshTokens` a menos que se edite su rol. |
| **Pérdida de tickets en outbox local ante limpieza de navegador** | **Bajo** | El backend mantiene la colección inmutable `invitationOps_prod`. La función `reconcileUserOp` reconcilia el estado ante discrepancias. |
| **Reenvío sucesivo de correos por doble clic** | **Mitigado** | Guardas en memoria `userSaveInFlight`, `resetPassInFlight`, `forgotPasswordInFlight` en frontend; claves de idempotencia `opId` en backend. |
| **Enumeración maliciosa de correos registrados** | **Mitigado** | `enableImprovedEmailPrivacy: true` en Firebase Auth y mensaje neutro idéntico en el modal `#forgot-password-modal`. |
| **Clasificación en Junk en Microsoft 365 para nuevos usuarios** | **Medio** | La autenticación criptográfica está en **PASS** (SPF, DKIM, DMARC). Se proporciona la Guía de Diagnóstico IT para que el administrador de Grupo Gama gestione la directiva del tenant según corresponda. |

---

## 5. Requisitos Productivos y Dependencias

### 5.1 Estado de Infraestructura de Producción
* **Google Identity Platform (`ductsal-erp`):**
  - Subdominio `auth.ductsal.com` verificado y activo (`useCustomDomain: true`).
  - Remitente visible: `DUCTSAL ERP <noreply@auth.ductsal.com>`.
  - Reply-To: `informatica@grupogama.com`.
  - Idioma predeterminado: `defaultLocale: "es"`.
  - `enableImprovedEmailPrivacy: true` activo.
* **DNS en Network Solutions (`ns25.worldnic.com` / `ns26.worldnic.com`):**
  - SPF en `auth.ductsal.com`: ACTIVO.
  - DKIM selectores `firebase1` y `firebase2`: ACTIVOS.
  - DMARC en `_dmarc.auth.ductsal.com`: ACTIVO (`p=none`).
  - Dominio raíz `ductsal.com`: Registros MX y SPF de Microsoft 365 blindados e intactos.
* **Vercel (`https://erp.ductsal.com`):**
  - No requiere variables de entorno nuevas. Utiliza la configuración pública de Firebase ya presente en `app_core.js`.

### 5.2 Migraciones o Cambios de Datos
* **CERO migraciones de base de datos requeridas.**
* Los perfiles existentes conservan su estructura.
* Los perfiles nuevos simplemente se crean con `invitation: { status: 'prepared', ... }` sin campo de contraseña.
* La colección `invitationOps_prod` se aprovisiona dinámicamente en Firestore con el primer ticket emitido.

---

## 6. Plan de Ejecución del Despliegue y Rollback

### 6.1 Orden Estricto de Despliegue (Secuencia Segura)
1. **Paso 1: Commit Atómico Local:**
   - Agrupar exclusivamente los archivos de código y pruebas pertenecientes al release en un commit limpio y descriptivo.
2. **Paso 2: Despliegue del Backend (Firebase Cloud Functions):**
   - Ejecutar: `firebase deploy --only functions --project ductsal-erp`.
   - *Justificación del orden:* Asegura que las nuevas funciones callables (`recordInvitationOutcomeAdmin`, `confirmUserActivation`, `reconcileUserOp`) ya estén disponibles en Google Cloud antes de que el frontend intente invocarlas.
3. **Paso 3: Despliegue del Frontend (Vercel):**
   - Publicar el commit en la rama de despliegue de Vercel (`main`).
   - El pipeline de Vercel genera el despliegue de los activos estáticos en el edge network global.

### 6.2 Plan de Rollback Inmediato (< 5 minutos)
* **Rollback de Frontend (Vercel):**
  - Acceder a Vercel Dashboard → Deployments → Seleccionar el despliegue inmediatamente anterior → Pulsar **Instant Rollback**.
  - Redirección del tráfico a nivel perimetral en < 5 segundos sin tiempo de inactividad.
* **Rollback de Backend (Firebase):**
  - Las nuevas callables son aditivas y no eliminan contratos previos. Si fuese necesario revertir, se redepliega el commit anterior con `firebase deploy --only functions`.

---

## 7. Protocolo de Smoke Tests Posteriores al Despliegue

Tras completar la publicación autorizada en Vercel, el operador o auditor ejecutará en su navegador habitual sobre `https://erp.ductsal.com` los siguientes 5 puntos de validación (saldando formalmente la observación pendiente de navegador de 6.3.6.4):

1. **Carga Limpia de la Aplicación:**
   - Abrir `https://erp.ductsal.com` con DevTools (F12) abierto.
   - Verificar que no existan errores rojos de red ni excepciones JavaScript en consola.
2. **Verificación de ActionCodeSettings en Consola:**
   - Ejecutar en la consola del navegador: `CrmAuth.ACTION_CODE_SETTINGS.url`.
   - Comprobar que retorne inmutablemente: `'https://erp.ductsal.com/login?mode=activate'`.
3. **Modal de Recuperación "¿Olvidaste tu contraseña?":**
   - Pulsar el enlace en la pantalla de login.
   - Comprobar apertura fluida del modal accesible `#forgot-password-modal`.
   - Probar tecla `Escape` y verificar cierre del modal.
4. **Prueba de Respuesta Neutral Anti-Enumeración:**
   - Ingresar un correo ficticio (ej. `verificacion.smoke.test@ductsal.com`) y pulsar "Enviar Enlace".
   - Verificar que el botón muestre estado in-flight y el modal responda con el mensaje neutral idéntico sin arrojar error visible.
5. **Comprobación de Sesión Existente:**
   - Iniciar sesión con un usuario administrativo existente y comprobar carga normal del dashboard sin bloqueos.

---

## 8. Confirmación Obligatoria de Presupuesto de Correos

```
================================================================================
                    CERTIFICACIÓN DE PRESUPUESTO DE CORREO
================================================================================
- Envío 1: Invitación inicial                (2026-11-03 02:03:58Z) -> CONSUMIDO
- Envío 2: Restablecimiento DMARC            (2026-11-03 03:17:01Z) -> CONSUMIDO
- Envío 3: Restablecimiento tras Not Junk    (2026-11-03 03:24:39Z) -> CONSUMIDO

ESTADO: 3 de 3 correos consumidos (100% AGOTADO).
CERTIFICACIÓN: Durante este proceso de preparación y en el despliegue posterior, 
NO SE REALIZARÁ NINGÚN ENVÍO ADICIONAL DE CORREO REAL BAJO NINGUNA CIRCUNSTANCIA.
================================================================================
```

---

## 9. Estado de Espera

En estricto cumplimiento de las restricciones:
* **No se ha modificado ningún archivo del proyecto.**
* **No se ha realizado staging, commit, push, PR ni merge.**
* **No se ha ejecutado ningún despliegue a Vercel ni a Firebase.**
* **No se ha modificado Firebase Console, DNS ni Microsoft 365.**
* **No se han alterado datos ni usuarios en producción.**

**Quedamos formalmente a la espera de la autorización expresa del usuario antes de proceder con cualquier fase de publicación.**
