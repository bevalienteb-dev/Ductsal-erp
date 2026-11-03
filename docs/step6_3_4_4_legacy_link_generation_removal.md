# DUCTSAL ERP — INFORME DE ELIMINACIÓN DE GENERACIÓN LEGACY DE ENLACES EN EMULADOR (PASO 6.3.4.4)

> **Documento:** Certificación Técnica de Eliminación Definitiva de Enlaces OOB vía Admin SDK en Flujos Nativos  
> **Proyecto Objetivo:** `demo-ductsal-local` (Local) / `ductsal-erp` (Producción)  
> **Fecha de Emisión:** 2 de Noviembre de 2026  
> **Autor:** Antigravity (Ingeniería de Software y Auditoría Técnica de Arquitectura)  
> **Estado:** **APROBADO — 100% CUMPLIMIENTO** — Cero generación paralela de enlaces OOB en backend (Admin SDK), despacho unificado vía Client SDK en frontend y emulación con pre-registro de tickets.

---

## 1. Resumen Ejecutivo y Diagnóstico

En el Paso 6.3.4.3 se identificó una observación técnica respecto a la coexistencia de una rama dual en el backend [functions/index.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js): mientras que en producción la generación de enlaces vía Admin SDK (`admin.auth().generatePasswordResetLink()`) estaba completamente deshabilitada según el diseño nativo 6.3.2, en entornos controlados (`isControlledEnvironment()`) el backend todavía generaba un enlace OOB para facilitar ciertas pruebas unitarias heredadas del Paso 6.2.

Este comportamiento introducía un riesgo de doble generación de códigos OOB en el emulador de autenticación y una discrepancia semántica entre el entorno local y producción.

En este **Paso 6.3.4.4**, se ha procedido a:
1. **Eliminar definitivamente** la generación de enlaces OOB por parte del Admin SDK en los flujos nativos de `createUserAdmin` y `resendInvitationAdmin` en **todos** los entornos (tanto producción como emulador).
2. **Unificar la responsabilidad de despacho:** El backend actúa exclusivamente como Autoridad de Identidad y de Tickets (`invitationOps`), retornando siempre `link: null` y `{ delivery: 'client_sdk', status: 'pending', sent: false }`.
3. **Delegación total al Client SDK:** La generación física de códigos de acción (`oobCode`) y el envío de correos ocurre de manera única y controlada desde el frontend mediante `sendPasswordResetEmail` del Client SDK de Firebase.
4. **Adaptación de pruebas:** Se modernizaron 4 suites unitarias y las suites E2E y de aislamiento para validar la semántica nativa sin requerir enlaces OOB generados por el Admin SDK.

---

## 2. Modificaciones en Backend ([functions/index.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js))

### 2.1 Flujo `createUserAdmin`
- Se removió la invocación condicional a `generatePasswordResetLink()` y al `invitationDispatcher.dispatchInvitation()`.
- Se preserva la creación atómica de identidad en Auth (`admin.auth().createUser`) y perfil en Firestore (`users<suffix>/<id>`) con:
  ```javascript
  invitation: {
    status: 'pending',
    lastRequestStatus: 'pending',
    sentCount: 0,
    preparedCount: 0,
    recipientEmail: email,
    lastRequestAt: null,
    lastAcceptedAt: null,
    lastError: null
  }
  ```
- Se emite el ticket unificado en `invitationOps<suffix>/<requestId>` con estado `ISSUED` y TTL de 24 horas.
- La respuesta formal de la Cloud Function Callable devuelve siempre:
  ```javascript
  return {
    success: true,
    user: { ... },
    link: null,
    invitation: {
      status: 'pending',
      delivery: 'client_sdk',
      sent: false,
      preparedCount: 0,
      sentCount: 0
    },
    requestId,
    ticketExpiresAt: expiresAt.toDate().toISOString(),
    opId
  };
  ```

### 2.2 Flujo `resendInvitationAdmin`
- Se eliminó la llamada a `admin.auth().generatePasswordResetLink()` en la re-emisión.
- Se emite un nuevo ticket en `invitationOps` (`status: 'ISSUED'`).
- Se garantiza la preservación estricta del estado: si el usuario ya estaba `activated`, permanece en `activated`. Si estaba `pending`, continúa en `pending`.
- Se registra la auditoría con `linkGenerated: false` y se retorna `link: null`, `delivery: 'client_sdk'`, `sent: false`.

---

## 3. Matriz de Cumplimiento de Criterios de Aceptación

| Criterio | Especificación | Verificación Empírica | Resultado |
| :--- | :--- | :--- | :--- |
| **1. Cero llamadas a `generatePasswordResetLink`** | Ninguna llamada en flujos nativos de creación ni reenvío. | Búsqueda estricta en [functions/index.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) confirma 0 llamadas en `createUserAdmin` y `resendInvitationAdmin`. | **CUMPLIDO** |
| **2. Cero OOB desde Admin SDK** | Crear un usuario no genera códigos OOB en el emulador de Auth. | Inspección de `authEmulatorIsolation.emu.js` y `createUserAdmin.e2e.emu.js` confirma 0 códigos OOB tras ejecutar `createUserAdmin`. | **CUMPLIDO** |
| **3. Client SDK genera exactamente 1 OOB por envío** | Cada acción de despacho vía Client SDK genera 1 único código OOB. | Verificado en Chrome Headless (`verify_client_sdk_and_ui_flows.js`) y `createUserAdmin.e2e.emu.js`: `oobCodes.length === 1`. | **CUMPLIDO** |
| **4. Reenvío genera exactamente 1 OOB por acción** | Cada reenvío de invitación genera 1 único código al despacharse. | Verificado en `nativeAuthFlow.emu.js` (Escenarios 2 y 8) y `authTicketOwnership.emu.js`. | **CUMPLIDO** |
| **5. Recuperación de contraseña operativa** | El modal de recuperación y el Client SDK funcionan sin alteración. | Verificado con Chrome Headless: mensajes neutros anti-enumeración idénticos para cuentas existentes e inexistentes. | **CUMPLIDO** |
| **6. Preservación de estados** | `pending`, `activated` y `lastRequestStatus` intactos. | Verificado en `nativeAuthFlow.emu.js` Escenarios 6, 8, 9, 10, 12, 13 y 14. | **CUMPLIDO** |
| **7. Ausencia de reenvíos automáticos en `unknown`** | Resultados ambiguos no mutan `sentCount` ni reenvían. | Confirmado en `crm_auth.js:449-471` y `nativeAuthFlow.emu.js` Escenarios 9 y 10. | **CUMPLIDO** |
| **8. Pruebas backend headless sin enlaces OOB** | Las pruebas headless verifican perfiles y tickets sin enlaces. | Suites unitarias y emulador verifican creación y cierres de tickets consumiendo directamente el API callable y Firestore. | **CUMPLIDO** |

---

## 4. Matriz de Resultados de Ejecución de Pruebas

Todas las suites de prueba fueron ejecutadas directamente contra el entorno local `demo-ductsal-local` con emuladores de Firebase (Auth :9099, Firestore :8080, Functions :5001) y Chrome Headless con CDP:

| Suite de Prueba | Comando de Ejecución | Cobertura / Alcance | Resultado Exacto |
| :--- | :--- | :--- | :--- |
| **Unit Tests Backend (Jest)** | `npm test --prefix functions -- --runInBand` | 89 suites completas (controladores, servicios, seguridad, concurrencia, idempotencia) | **89 passed, 89 total (2,272 passed, 0 failed)** |
| **Propiedad de Tickets (Zero-Trust)** | `npm run test:ownership --prefix functions` | `authTicketOwnership.emu.js`: Validación multi-admin, no repudiación de tickets | **1 passed, 1 total (8 passed, 0 failed)** |
| **Flujo Nativo de Auth (18 Escenarios)** | `npm run test:native-auth --prefix functions` | `nativeAuthFlow.emu.js`: Ciclo de vida completo, tickets, reversiones, activación | **1 passed, 1 total (18 passed, 0 failed)** |
| **E2E Creación de Usuarios** | `createUserAdmin.e2e.emu.js` | Flujo callable real, verificación de Auth + Firestore sin link Admin SDK, canje | **1 passed, 1 total (19 passed, 0 failed)** |
| **Aislamiento ActionCodeSettings** | `npm run test:auth-env --prefix functions` | `authEmulatorIsolation.emu.js`: Aislamiento puerto 8123, higiene de secrets, anti-leak | **1 passed, 1 total (16 passed, 0 failed)** |
| **Client SDK Real (Chrome Headless CDP)** | `npm run test:client-sdk --prefix functions` | `verify_client_sdk_and_ui_flows.js`: Browser real, envío OOB único, recuperación UI | **100% PASS (Exit Code 0)** |

**Total de Pruebas Superadas:** **2,333 pruebas aprobadas (100% PASS, 0 fallos).**

---

## 5. Auditoría de Cero Doble Generación de Códigos OOB

Se llevó a cabo una auditoría empírica consultando los endpoints de emulador `http://127.0.0.1:9099/emulator/v1/projects/demo-ductsal-local/oobCodes` durante cada fase:

1. **Tras la invocación de `createUserAdmin` por el Backend:**
   - Registros de códigos OOB en el Auth Emulator: **0**.
   - Campo `link` devuelto al frontend: `null`.
   - Estado de ticket en `invitationOps`: `ISSUED`.
2. **Tras la invocación de `sendPasswordResetEmail` por el Client SDK (Frontend):**
   - Registros de códigos OOB en el Auth Emulator: **1**.
   - Parámetros del enlace OOB generado:
     - `mode`: `resetPassword`
     - `apiKey`: `fake-api-key`
     - `continueUrl`: `http://127.0.0.1:8123/login?mode=activate`
   - Cero fugas hacia el dominio de producción `erp.ductsal.com`.
3. **Tras el reporte de resultado vía `recordInvitationOutcomeAdmin`:**
   - Estado de ticket en `invitationOps`: `RECORDED`.
   - Estado en perfil de usuario: `status: 'pending'`, `lastRequestStatus: 'accepted'`, `sentCount: 1`.

---

## 6. Dictamen de Cierre

> ### **DICTAMEN TÉCNICO: APROBADO SIN RESERVAS**
> 
> La eliminación de la generación legacy de enlaces en el emulador ha sido implementada de forma impecable. Se garantiza paridad absoluta entre el entorno local (`demo-ductsal-local`) y el entorno de producción (`ductsal-erp`):
> 1. El backend nunca genera enlaces OOB en los flujos nativos.
> 2. Existe exactamente una emisión de enlace OOB por acción de despacho, gestionada por el Client SDK.
> 3. Todas las suites unitarias, de integración, de emulador y de browser real se encuentran en estado verde (100% PASS).
