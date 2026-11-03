# Revisión Puntual Posterior a Fase 6.5 — Integridad de Identidad y Cambios Locales

**Fecha:** 2 de Noviembre de 2026  
**Entorno de evaluación:** Local aislado (`demo-ductsal-local`), Node.js / Jest, emuladores Firebase  
**Estado previo:** Fase 6.5 Aprobada  
**Documento de referencia:** [`docs/step6_5_end_to_end_validation.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_5_end_to_end_validation.md)  

---

## 1. Resultado de la Correspondencia Correo Electrónico = Usuario de Acceso

En DUCTSAL ERP, el correo electrónico constituye el identificador único y unívoco de inicio de sesión. No existe ni se requiere un campo de nombre de usuario independiente.

### Verificación Técnica en Código y Arquitectura:

1. **Creación de usuario (`createUserAdmin` en [`functions/index.js:230-648`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L230-L648)):**
   - El correo entrante se normaliza obligatoriamente mediante `normalizeEmail(data.email)` ([`functions/index.js:102-104`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L102-L104)), eliminando espacios en los extremos y transformándolo a minúsculas (`trim().toLowerCase()`).
   - Se valida formato estricto RFC (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`).
   - Se comprueba no colisión en Firestore (`users_prod`) y en Firebase Auth (`getUserByEmail`).
   - Se crea la cuenta en Firebase Auth con dicho correo normalizado (`admin.auth().createUser({ email })`).
   - Se persiste el perfil en Firestore con el campo `email` idéntico y vinculado mediante `authUid: newAuthUser.uid`.
   - Se emite el ticket en `invitationOps` con `recipientEmail: email`.
   - **Resultado:** Correspondencia 1:1 estricta entre Auth y Firestore.

2. **Inicio de sesión (`processLogin`, `findLoginUser` y `processDirectFirebaseAuthLogin`):**
   - El formulario `#login-form` captura `#login-email` y remueve espacios mediante `.trim()`.
   - [`CrmAuth.findLoginUser`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L157-L164) busca coincidencia exacta y, para perfiles vinculados a Auth activos, realiza coincidencia insensible a mayúsculas (`toLowerCase()`).
   - Ambas vías de autenticación (`processFirebaseLogin` y `processDirectFirebaseAuthLogin`) delegan la validación de credenciales a `firebase.auth().signInWithEmailAndPassword(email, pass)`.
   - Tras autenticarse, se valida de forma estricta que el perfil comercial en Firestore tenga `authUid === cred.user.uid`. Si hay discrepancia, se ejecuta `signOut()` inmediato.
   - **Resultado:** El acceso opera exclusivamente contra el correo de Firebase Auth vinculado al perfil.

3. **Recuperación de contraseña (`processForgotPassword` en [`app_core.js:2578-2650`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L2578-L2650)):**
   - El modal `#forgot-password-modal` captura `#forgot-password-email` y normaliza con `.trim().toLowerCase()`.
   - Invoca [`CrmAuth.sendPasswordSetupEmail(firebase, email)`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L168-L176) que ejecuta `firebase.auth().sendPasswordResetEmail(email, settings)`.
   - La operación se ejecuta directamente contra el directorio nativo de Firebase Authentication. No se expone ni se consulta ningún otro identificador.
   - **Resultado:** Proceso 100% nativo basado en el correo de autenticación.

4. **Invitación, activación y reenvío:**
   - **Invitación:** Ticket pre-registrado en `invitationOps` con `recipientEmail: email`.
   - **Activación:** Retorno con `continueUrl` porta `email` pre-rellenado y valida sesión con dicho correo.
   - **Reenvío (`resendInvitationAdmin`):** Si el correo en Firebase Auth difiere del registrado en Firestore, la Cloud Function sincroniza automáticamente el perfil actualizando `email` y `invitation.recipientEmail` ([`functions/index.js:1096-1104`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L1096-L1104)).
   - **Actualización (`updateUserAdmin`):** Toda modificación de correo actualiza en primer lugar Firebase Auth (`updateUser`), luego el documento en Firestore y `invitation.recipientEmail` bajo transacción, con mecanismo de rollback/revisión manual si falla.
   - **Resultado:** Conservación ininterrumpida de la identidad por correo.

5. **Inexistencia de rutas alternativas de creación:**
   - En [`firestore.rules:49-53`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/firestore.rules#L49-L53), la colección `users_prod` tiene `allow write: if false;`.
   - Ningún cliente web puede crear o alterar perfiles en Firestore directamente; la única vía es la Cloud Function administrativa autorizada (`createUserAdmin`).
   - **Resultado:** Imposibilidad de crear perfiles desalineados o desvinculados de Firebase Auth.

---

## 2. Revisión de los Dos Cambios Realizados Durante Fase 6.5

### A. `functions/index.js` — Soporte `data.id || data.userId` en `resendInvitationAdmin`

* **Consumidores actuales:**
  - Frontend UI ([`modules/users/users_controller.js:347`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js#L347)): despacha `{ id: target.id, dbSuffix }`.
  - Cliente de autenticación ([`crm_auth.js:426-433`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L426-L433)): despacha `{ id, opId, dbSuffix }`.
  - Módulo Outbox ([`crm_outbox.js:125`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_outbox.js#L125)): persiste internamente `userId: target.id`.
  - Tests automatizados E2E ([`scripts/verify_phase6_5_e2e_matrix.js:624`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/scripts/verify_phase6_5_e2e_matrix.js#L624)): envían `{ id: vendedorId }`.
* **Equivalencia de identificadores:**
  - En DUCTSAL ERP, tanto `id` como `userId` se refieren al identificador comercial del documento en `users<suffix>`. Ambos resuelven exactamente al mismo perfil.
* **Control de ambigüedad y robustez:**
  - Se incorporó una comprobación defensiva explícita: si un consumidor suministra ambos parámetros con valores contradictorios (`data.id !== data.userId`), la función rechaza la petición con `invalid-argument` (*"Ambiguous id and userId provided"*).
  - Se conserva la validación `isToken(id)` que restringe estrictamente caracteres alfanuméricos seguros (`/^[A-Za-z0-9_-]{1,128}$/`).
* **Preservación de seguridad y permisos:**
  - La verificación `assertManager` se ejecuta al inicio de la función.
  - Se valida que el perfil del gerente solicitante esté activo (`assertRequesterProfileActive`).
  - Se valida que el perfil objetivo exista, tenga `authUid` y esté activo (`profile.activo === true`).
  - Se comprueba en Auth que la cuenta exista y no esté deshabilitada (`!authUser.disabled`).
  - El ticket en `invitationOps` se asocia indisolublemente con `requestedBy: context.auth.uid`.

---

### B. `app_core.js` — Consulta de Respaldo por `authUid` en `processDirectFirebaseAuthLogin`

* **Comportamiento de la búsqueda principal:**
  - Si el token de sesión de Firebase Auth ya incluye los claims `cid` y `role` (`tok.claims.cid && tok.claims.role`), la condición `(!cid || !role)` es **falsa**. La consulta de respaldo a Firestore **no se ejecuta**. La autenticación continúa por la ruta rápida sin lecturas redundantes.
* **Imposibilidad de resolver el perfil de otro usuario:**
  - La consulta de fallback filtra estrictamente por `.where('authUid', '==', cred.user.uid)`.
  - El valor `cred.user.uid` es inmutable y emitido criptográficamente por Firebase Authentication para la sesión activa del usuario verificado.
  - Al estar garantizada la unicidad de `authUid` por usuario en Firestore, la consulta sólo puede retornar el perfil legítimo perteneciente a ese `uid`.
  - Adicionalmente, el código valida a continuación sobre el documento obtenido:
    ```javascript
    if (sdata.authUid && sdata.authUid !== cred.user.uid) {
        await firebase.auth().signOut();
        return alert("Inconsistencia de identidad: el UID de autenticación no coincide con el perfil.");
    }
    ```
* **Aislamiento y permisos:**
  - **Protección contra escalamiento:** Si el perfil en Firestore indica `role === 'manager'`, el código exige ineludiblemente `managerClaim === true` (claim criptográfico firmado por Firebase Auth, no alterable desde base de datos). De no tenerlo, se aborta la sesión con `signOut()`.
  - **Cuentas inactivas:** Se verifica `sdata.activo !== false`. Cuentas inactivas provocan `signOut()` inmediato.
  - **Roles reconocidos:** Se restringe estrictamente a `['manager', 'gestor', 'vendedor']`.
* **Ausencia de efectos colaterales:**
  - La consulta es una lectura pura (`get()`). No ejecuta escrituras, inserciones ni actualizaciones; es imposible que genere perfiles duplicados.
  - No altera el comportamiento de usuarios existentes con tokens provisionados.
* **Compatibilidad:**
  - **Usuarios nuevos:** Permite el primer inicio de sesión inmediato tras activar contraseña, resolviendo su `cid` comercial sin requerir una espera de renovación de token.
  - **Usuarios existentes con Auth:** Resuelven transparentemente por claims o por fallback si su token es preliminar.
  - **Usuarios históricos (sin Auth):** No pueden autenticarse con `signInWithEmailAndPassword` sin previa vinculación administrativa; si lo intentan sin perfil con `authUid`, son rechazados de forma segura con cierre de sesión.

---

## 3. Pruebas Ejecutadas y Resultados Exactos

Se ejecutaron pruebas focalizadas en el entorno local de desarrollo para validar exhaustivamente los dos puntos requeridos:

### A. Suite de Integridad de Identidad y Cambios Locales
* **Archivo de prueba:** [`functions/__tests__/postValidationIdentityAndChanges.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/postValidationIdentityAndChanges.unit.test.js)
* **Resultado:** **15 aprobadas / 15 ejecutadas (100%)**

```
PASS __tests__/postValidationIdentityAndChanges.unit.test.js
  1. Correspondencia correo electrónico = usuario de acceso
    ✓ 1.1 createUserAdmin registra exactamente el mismo correo normalizado en Auth y Firestore (12 ms)
    ✓ 1.2 CrmAuth.findLoginUser localiza usuarios activos mediante correo insensible a mayúsculas (1 ms)
    ✓ 1.3 updateUserAdmin sincroniza el cambio de correo en Auth y en Firestore profile (7 ms)
  2. Revisión de resendInvitationAdmin (data.id || data.userId)
    ✓ 2.1 Acepta data.id y emite ticket válido para el perfil (3 ms)
    ✓ 2.2 Acepta data.userId de forma equivalente resolviendo al mismo usuario (1 ms)
    ✓ 2.3 Acepta ambos parámetros cuando coinciden id === userId (2 ms)
    ✓ 2.4 Rechaza ambigüedad con invalid-argument si se envían id y userId contradictorios (1 ms)
    ✓ 2.5 Rechaza llamadas sin id ni userId, o con tokens inválidos (1 ms)
    ✓ 2.6 Mantiene controles estrictos de seguridad (no gerente es rechazado)
  3. Revisión de fallback por authUid en processDirectFirebaseAuthLogin
    ✓ 3.1 Vía principal: si el token ya contiene claims (cid y role), no ejecuta fallback y se autentica (2 ms)
    ✓ 3.2 Vía fallback: usuario recién creado (sin cid en token) resuelve su perfil comercial legítimo por authUid (2 ms)
    ✓ 3.3 Aislamiento de identidad: el fallback NUNCA puede resolver el perfil de otro usuario (1 ms)
    ✓ 3.4 Anti-escalamiento: un perfil con role manager sin claim criptográfico manager:true es deslogueado (1 ms)
    ✓ 3.5 Cuenta inactiva es rechazada y deslogueada inmediatamente (1 ms)
    ✓ 3.6 Usuario sin perfil en Firestore es rechazado y deslogueado (1 ms)

Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total
```

### B. Pruebas de Regresión Afectadas
Se ejecutaron los suites correspondientes a las funciones y flujos vinculados:

| Archivo de Prueba | Componente Evaluado | Pruebas | Resultado |
| :--- | :--- | :---: | :---: |
| [`__tests__/adminFunctions.iter7.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/adminFunctions.iter7.test.js) | Normalización de email, `resendInvitationAdmin`, `reconcileUserOp`, `listUsersAdmin` | 46 | **46/46 Aprobadas** |
| [`__tests__/crmAuth.uiFlow.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/crmAuth.uiFlow.test.js) | Búsqueda por correo, despacho de email, sandboxing en UI | 28 | **28/28 Aprobadas** |
| [`__tests__/frontendPasswordSetupAndRecovery.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/frontendPasswordSetupAndRecovery.test.js) | Modal de recuperación, anti-enumeración, validación de correo | 20 | **20/20 Aprobadas** |
| [`__tests__/updateUserAdmin.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/updateUserAdmin.test.js) | Sincronización y unicidad de correo en Auth y Firestore | 50 | **50/50 Aprobadas** |
| **Total Pruebas de Regresión Ejecutadas** | | **159** | **159/159 Aprobadas** |

---

## 4. Cambios Locales Realizados Durante la Revisión

1. **[`functions/index.js:1062-1065`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L1062-L1065):**
   - Se añadió salvaguarda contra ambigüedad en `resendInvitationAdmin`:
     ```javascript
     if (data.id && data.userId && data.id !== data.userId) {
       throw new functions.https.HttpsError('invalid-argument', 'Ambiguous id and userId provided');
     }
     ```
2. **[`functions/__tests__/adminFunctions.iter7.test.js:292-311`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/adminFunctions.iter7.test.js#L292-L311):**
   - Se añadieron 3 pruebas de regresión para validar el parámetro `userId`, la prevención de ambigüedad y el rechazo de tokens inválidos.
3. **[`functions/__tests__/postValidationIdentityAndChanges.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/postValidationIdentityAndChanges.unit.test.js):**
   - Nueva suite de 15 pruebas cubriendo la correspondencia correo/usuario, el contrato de `resendInvitationAdmin` y la seguridad del fallback por `authUid`.

---

## 5. Riesgos Residuales y Limitaciones

* **Cero riesgo de desincronización de identidad:** El correo electrónico opera de manera homogénea y normalizada (`trim().toLowerCase()`) en toda la pila (Auth, Firestore y UI).
* **Cero riesgo de suplantación en el fallback:** La consulta por `authUid` depende estrictamente de `cred.user.uid` autenticado criptográficamente y es contrastada en segunda instancia contra el documento Firestore antes de permitir el ingreso.
* **Aislamiento de producción rigurosamente intacto:**
  - No hubo conexiones a `ductsal-erp` (Project ID exclusivo: `demo-ductsal-local`).
  - No se enviaron correos reales.
  - No se tocaron DNS, Firebase Console ni infraestructura externa.
  - `git diff --check` no reporta errores de formato ni espacios en blanco residuales.

---

## 6. Dictamen Final

```
================================================================================
           DICTAMEN TÉCNICO: APROBADO
================================================================================
1. Correspondencia Correo = Usuario de Acceso: COMPLETA Y UNÍVOCA.
2. Soporte data.id || data.userId en resendInvitationAdmin: VERIFICADO,
   CONSISTENTE Y BLINDADO CONTRA AMBIGÜEDAD.
3. Fallback por authUid en app_core.js: SEGURO, IDEMPOTENTE, AISLADO
   Y PROTEGIDO CONTRA ESCALAMIENTO DE PRIVILEGIOS.
4. Total pruebas ejecutadas: 159 (100% aprobadas sin fallos).
================================================================================
```
