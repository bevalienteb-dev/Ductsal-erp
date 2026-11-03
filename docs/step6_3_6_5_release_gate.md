# FASE 6.3.6.5 — RELEASE GATE FINAL

**Proyecto:** DUCTSAL ERP (`sales-reporting-system-release`)  
**Fecha de Evaluación:** 2 de Noviembre de 2026  
**Entorno de Evaluación:** Aislado local (`demo-ductsal-local`), Node.js v20, Firebase Emulators Suite (Auth 9099, Firestore 8080, Functions 5001)  
**ID de Proyecto de Producción:** `ductsal-erp` (948658286825)  
**Dominio de Producción:** `https://erp.ductsal.com`  
**Estado de Publicación:** **NO PUBLICADO** (Cero commits, cero push, cero PR, cero deploys, cero correos reales)

---

## 1. Dictamen Oficial del Release Gate

### Resultado: **`AUTORIZABLE CON OBSERVACIONES`**

#### Fundamentación Técnica:
1. **Calidad y Seguridad del Software (Frontend & Backend):**  
   El código fuente cumple estrictamente con todos los estándares corporativos y de seguridad:
   - Eliminación total de almacenamiento o generación de contraseñas provisionales en base de datos.
   - Protección anti-enumeración estricta en el modal de recuperación de contraseñas (respuesta neutra idéntica).
   - Prevención de doble envío mediante guardas en memoria (`userSaveInFlight`, `resetPassInFlight`) en el cliente y claves de idempotencia (`opId`) en el servidor.
   - Arquitectura Write-Ahead en el cliente (`CrmOutbox`) para garantizar consistencia operativa ante fallos de red o desconexiones.
   - Delegación exclusiva de despacho de correos nativos al Firebase Client SDK, sin generación de enlaces en Cloud Functions.
2. **2,333 Pruebas Automatizadas Aprobadas al 100%:**  
   Se certifica la aprobación íntegra de **2,272 pruebas unitarias** (89 suites) y **61 pruebas en emulador** (4 suites especializadas de aislamiento, propiedad de tickets, flujo nativo y ciclo E2E de usuario), sin un solo fallo ni regresión.
3. **Observación 1 — Estado de Validación DNS en Firebase (`IN_PROGRESS`):**  
   Los **cuatro registros DNS oficiales** (2 registros TXT y 2 registros CNAME) ya fueron agregados en Network Solutions. En la consola de Firebase Authentication, la verificación se encuentra en curso (**`IN_PROGRESS`**) mientras Google completa su ciclo periódico de validación.
4. **Observación 2 — Prueba de Navegador Chrome/CDP (PENDIENTE):**  
   La prueba automatizada de navegador (`test:client-sdk`) no pudo completar su ejecución en esta sesión debido a que el binario de Google Chrome en macOS (`/Applications/Google Chrome.app`, actualizado a las 17:41) quedó suspendido por el sistema operativo sin iniciar el socket de depuración CDP. Dicha prueba queda registrada formalmente como **PENDIENTE** y no forma parte del cómputo de 2,333 pruebas aprobadas. Se resolverá mediante la lista de comprobación de Smoke Tests en navegador real tras la publicación autorizada en Vercel, previo a cualquier envío de correos reales.

---

## 2. Verificación de Firebase y Configuración de Producción

Se inspeccionó directamente la configuración activa en Google Identity Platform (`projects/ductsal-erp/config`) vía API REST oficial:

```json
{
  "authorizedDomains": [
    "localhost",
    "ductsal-erp.firebaseapp.com",
    "ductsal-erp.web.app",
    "erp.ductsal.com",
    "auth.ductsal.com"
  ],
  "defaultLocale": "es",
  "dnsInfo": {
    "pendingCustomDomain": "auth.ductsal.com",
    "customDomainState": "IN_PROGRESS",
    "domainVerificationRequestTime": "2026-11-02T23:28:24.515Z"
  },
  "emailPrivacyConfig": {
    "enableImprovedEmailPrivacy": true
  }
}
```

### 2.1 Verificación de las Cuatro Plantillas de Correo
Se confirmó que el Reply-To oficial `informatica@grupogama.com` y el remitente visual `"DUCTSAL ERP"` están aplicados uniformemente en las 4 plantillas del proyecto:

| Plantilla | Asunto Oficial en Español | Remitente Visible | Reply-To Configurado | Estado |
| :--- | :--- | :--- | :--- | :---: |
| **Restablecimiento de Contraseña** (`resetPasswordTemplate`) | `"Cambia la contraseña de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` | **VERIFICADO** |
| **Verificación de Correo** (`verifyEmailTemplate`) | `"Verifica tu dirección de correo electrónico de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` | **VERIFICADO** |
| **Cambio de Correo** (`changeEmailTemplate`) | `"Se ha cambiado tu correo electrónico de inicio de sesión de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` | **VERIFICADO** |
| **Reversión de 2FA** (`revertSecondFactorAdditionTemplate`) | `"Has añadido la verificación en dos pasos a tu cuenta de %APP_NAME%."` | `"DUCTSAL ERP"` | `informatica@grupogama.com` | **VERIFICADO** |

### 2.2 Remitente Efectivo
- **Estado Actual (`customDomainState: IN_PROGRESS`):** Los correos de prueba se emitirán desde el remitente predeterminado de Firebase:  
  `"DUCTSAL ERP" <noreply@ductsal-erp.firebaseapp.com>`.
- **Estado Posterior (`customDomainState: VERIFIED`):** Una vez que Google verifique los registros propagados en Network Solutions, los correos se emitirán automáticamente desde:  
  `"DUCTSAL ERP" <noreply@auth.ductsal.com>`.

### 2.3 ActionCodeSettings y Protección Anti-Enumeración
- **`ActionCodeSettings` en Producción:**  
  `url: 'https://erp.ductsal.com/login?mode=activate'`, `handleCodeInApp: false`.  
  (Cero referencias a `localhost` o `127.0.0.1` en la constante `PRODUCTION_ACTION_CODE_SETTINGS`).
- **Protección Anti-Enumeración:**  
  `enableImprovedEmailPrivacy: true` activo a nivel de proyecto en Firebase, sumado al mensaje neutro idéntico implementado en `app_core.js`.

---

## 3. Manifiesto Técnico de Artefactos

A continuación se detalla la clasificación exhaustiva de todos los archivos involucrados en el release frente a la versión actualmente desplegada en producción:

### 3.1 Artefactos de Frontend (Destino: Vercel / `https://erp.ductsal.com`)

| Archivo | Tipo de Cambio | Propósito y Contenido del Cambio |
| :--- | :---: | :--- |
| `index.html` | **Modificado** | Añade modal accesible `#forgot-password-modal`, enlace "¿Olvidaste tu contraseña?", e incluye `crm_outbox.js` en el orden de carga. |
| `app_core.js` | **Modificado** | Controladores del modal de recuperación con mensaje neutro, observador de `mode=activate` para confirmación de activación, y reconciliación de outbox al autenticarse gerencia. |
| `crm_auth.js` | **Modificado** | `PRODUCTION_ACTION_CODE_SETTINGS`, `auth.languageCode = 'es'`, delegación de despacho a Client SDK e integración con la cola Write-Ahead local. |
| `modules/users/users_controller.js` | **Modificado** | Guardas de concurrencia contra doble clic (`userSaveInFlight`, `resetPassInFlight`), encolado en outbox y eliminación de escrituras a `users_prod`. |
| `crm_outbox.js` | **Nuevo** | Cola local Write-Ahead (`localStorage`), aislamiento por `managerAuthUid`, TTL 24 horas y regla `assertNoSecrets`. |
| `styles.css` | *Sin cambios* | Hojas de estilo corporativas y diseño adaptativo. |
| `logo.svg` | *Sin cambios* | Logotipo vectorial corporativo. |
| `crm_env.js` | *Sin cambios* | Selector de entorno (producción vs emulador explícito en localhost). |
| `crm_staging_config.js` | *Sin cambios* | Aislamiento de staging. |
| `crm_ui.js` | *Sin cambios* | Toasts y alertas modales. |
| `crm_clients.js` | *Sin cambios* | Gestión de clientes. |
| `crm_commercial.js` | *Sin cambios* | Gestión comercial y cotizaciones. |
| `crm_dashboard_calc.js` | *Sin cambios* | Cálculo de métricas gerenciales. |
| `crm_followup_calc.js` | *Sin cambios* | Métricas de seguimiento comercial. |
| `crm_formatters.js` | *Sin cambios* | Formateadores monetarios y de fecha. |
| `crm_work_calendar.js` | *Sin cambios* | Calendario laboral salvadoreño. |
| `core/*` | *Sin cambios* | Núcleo de datos y estado. |

### 3.2 Artefactos de Backend (Destino: Firebase Cloud Functions)

| Archivo / Objeto | Tipo de Cambio | Detalle del Cambio |
| :--- | :---: | :--- |
| `functions/index.js` | **Modificado** | Elimina llamadas a `generatePasswordResetLink` en flujos nativos; implementa callables de validación de tickets y activación (`recordInvitationOutcomeAdmin`, `confirmUserActivation`, `reconcileUserOp`). |
| `functions/invitationService.js` | **Nuevo** | Servicio de aislamiento de entornos (`isControlledEnvironment`), definición de estados de invitación y resolución de `ActionCodeSettings`. |
| `functions/package.json` | **Modificado** | Scripts de ejecución modular de pruebas (`test:unit`, `test:auth-env`, `test:ownership`, `test:native-auth`, `test:client-sdk`). |

### 3.3 Reglas e Índices de Firestore
- **`firestore.rules`:** **Idéntico a producción.** Contiene las reglas probadas que prohíben estrictamente cualquier escritura directa del cliente sobre `users_prod`, `userDirectory_prod` o `invitationOps_prod` (`allow write: if false;`).
- **`firestore.indexes.json`:** **Idéntico a producción.** Las operaciones de consulta y reconciliación no requieren índices compuestos adicionales.

### 3.4 Configuraciones Generales
- `.firebaserc` (`ductsal-erp` default/production) y `firebase.json`: **Sin cambios.**

### 3.5 Archivos Exclusivamente de Prueba (No forman parte del bundle de producción)
- `functions/__tests__/*` (89 suites de pruebas unitarias).
- `functions/emulator-tests/*` (4 suites de emulador).
- `functions/test-helpers/fakeFirebase.js` (Mocks de prueba).
- `scripts/verify_client_sdk_and_ui_flows.js` (Harness de CDP para pruebas locales).

---

## 4. Compatibilidad y Continuidad Operativa

### 4.1 Compatibilidad Frontend / Backend
Se verificó que las 10 funciones callable que el cliente invoca están exportadas y operativas en `functions/index.js`:
1. `createUserAdmin`
2. `updateUserAdmin`
3. `toggleUserStatusAdmin`
4. `resendInvitationAdmin`
5. `recordInvitationOutcomeAdmin`
6. `confirmUserActivation`
7. `reconcileUserOp`
8. `purgeHistoricalPasswordAdmin`
9. `listUsersAdmin`
10. `linkHistoricalUserAdmin`

### 4.2 Continuidad de Usuarios y Sesiones Existentes
- **Esquema de Documentos:** El esquema de `users_prod` se preserva intacto. No se alteran `id`, `authUid`, `nombre`, `role`, `activo` ni colecciones secundarias.
- **Sesiones Activas:** Los usuarios que ya cuentan con sesión iniciada conservan sus credenciales y tokens JWT de Firebase Auth. La función `revokeRefreshTokens` solo se dispara cuando un administrador modifica activamente el rol o desactiva la cuenta de un usuario mediante `updateUserAdmin`.
- **Cuentas Históricas:** Los perfiles previos sin cuenta Auth vinculada conservan su mecanismo de enlace transparente mediante `linkHistoricalUserAdmin`.

### 4.3 Plan de Rollback Coordinado
En caso de cualquier eventualidad tras la publicación autorizada:
1. **Rollback de Frontend (Vercel):** Acceder a Vercel Dashboard → Deployments → Seleccionar despliegue operativo anterior → **Instant Rollback**. Redirección perimetral instantánea en < 5 segundos.
2. **Rollback de Backend (Firebase):** Las funciones Cloud son 100% retrocompatibles (añaden callables y no eliminan contratos existentes). Si fuese necesario revertir, se redepliega el commit previo con `firebase deploy --only functions`.

---

## 5. Matriz de Pruebas y Plan de Desbloqueo de Navegador

### 5.1 Confirmación de las 2,333 Pruebas Automatizadas

```
================================================================================
                    CÓMPUTO OFICIAL DE PRUEBAS AUTOMATIZADAS
================================================================================
```

| Categoría de Prueba | Entorno de Ejecución | Suites | Pruebas Pasadas | Fallos | Estado |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Pruebas Unitarias** | Jest en memoria (`functions/__tests__/*`) | 89 | **2,272** | 0 | **100% PASS** |
| **Emulador: Aislamiento** | Jest + Auth Emulator (`authEmulatorIsolation.emu.js`) | 1 | **16** | 0 | **100% PASS** |
| **Emulador: Propiedad** | Jest + Firestore Emulator (`authTicketOwnership.emu.js`) | 1 | **8** | 0 | **100% PASS** |
| **Emulador: Flujo Nativo** | Jest + Auth/Firestore (`nativeAuthFlow.emu.js`) | 1 | **18** | 0 | **100% PASS** |
| **Emulador: Integración E2E** | Jest + Callables reales (`createUserAdmin.e2e.emu.js`) | 1 | **19** | 0 | **100% PASS** |
| **TOTAL AUTOMATIZADO** | **Firebase Emulators Suite (`demo-ductsal-local`)** | **93** | **2,333** | **0** | **100% PASS** |

*(Nota: Los 4 flujos de navegador no se incluyen en este total y se mantienen debidamente diferenciados).*

### 5.2 Plan de Resolución de la Prueba de Navegador
La prueba automatizada Chrome/CDP (`scripts/verify_client_sdk_and_ui_flows.js`) permanece **PENDIENTE** en este host debido a la suspensión de Google Chrome tras su actualización en macOS a las 17:41.

**Protocolo de Desbloqueo Antes de Envíos Reales:**
1. Tras el despliegue del frontend en Vercel, el operador o auditor abrirá `https://erp.ductsal.com` en su navegador habitual con DevTools abierto.
2. Se ejecutará la lista de comprobación de Smoke Tests en producción (ver Sección 6 de [docs/step6_3_6_4_release_execution_plan.md](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_6_4_release_execution_plan.md)).
3. Se verificará visual y funcionalmente la consola limpia, la apertura del modal "¿Olvidaste tu contraseña?", la respuesta neutral ante correo ficticio y el valor de `CrmAuth.ACTION_CODE_SETTINGS.url`.
4. Una vez cumplida esta validación visual interactiva, se dará por cerrada la verificación de navegador antes de emitir cualquier invitación o restablecimiento hacia buzones reales.

---

## 6. Estado de los Registros DNS en Network Solutions

Se deja constancia exacta de los 4 registros configurados en Network Solutions para `auth.ductsal.com`:

| N° | Tipo | Host / Nombre | Valor Exacto Configurado | Propósito |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **TXT** | `auth.ductsal.com` | `v=spf1 include:_spf.firebasemail.com ~all` | Autorización SPF para servidores de correo Firebase |
| **2** | **TXT** | `auth.ductsal.com` | `firebase=ductsal-erp` | Código de verificación de proyecto emitido por Firebase |
| **3** | **CNAME** | `firebase1._domainkey.auth.ductsal.com` | `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com.` | Selector DKIM primario |
| **4** | **CNAME** | `firebase2._domainkey.auth.ductsal.com` | `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com.` | Selector DKIM secundario |

---

## 7. Declaración de Cumplimiento

- **No se ha realizado ningún despliegue a producción en Vercel ni Firebase.**
- **No se han generado commits ni se ha modificado la rama `main` en Git.**
- **No se han enviado correos electrónicos a usuarios corporativos reales.**
- **El release se encuentra técnicamente listo, documentado y AUTORIZABLE CON OBSERVACIONES.**
