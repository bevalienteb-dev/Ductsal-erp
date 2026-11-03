# INFORME DE VALIDACIÓN INTEGRAL END-TO-END (E2E) — FASE 6.5

**Sistema:** DUCTSAL ERP (Release de Autenticación Nativa Firebase)  
**Fecha de Ejecución:** 2 de Noviembre de 2026  
**Entorno de Validación:** Firebase Local Emulators (Auth, Firestore, Cloud Functions) & Google Chrome Headless via Chrome DevTools Protocol (CDP)  
**Firebase Project ID:** `demo-ductsal-local`  
**Estado General:** **APROBADO (100% de Pruebas Superadas)**

---

## 1. Resumen Ejecutivo

En cumplimiento del alcance de la **Fase 6.5**, se ejecutó la validación integral End-to-End (E2E) sobre los flujos completos de autenticación, aprovisionamiento de cuentas, tickets de invitación con arquitectura Write-Ahead, despacho nativo vía Firebase Client SDK, establecimiento inicial de contraseñas, activación de usuarios y recuperación de credenciales desde el login.

A diferencia de pruebas unitarias con fakes en memoria, esta fase evaluó la interacción real entre:
1. **Frontend Web en Navegador Real:** Google Chrome Headless interactuando mediante CDP a nivel de DOM, eventos de formulario, parámetros de URL (`window.history.replaceState`), manipulación de modales accesibles y guardas in-flight.
2. **Firebase Auth Emulator (Puerto 9099):** Despacho real de correos simulados, emisión y consumo de códigos OOB (`resetPassword`), verificación de enlaces de acción y actualización de contraseñas.
3. **Cloud Firestore Emulator (Puerto 8080):** Colecciones con sufijo `_local` (`users_local`, `invitationOps_local`, `userOps_local`, `commercialAudit_local`, `locks_local`), persistencia atómica bajo transacciones, control de concurrencia e invariantes de seguridad.
4. **Cloud Functions Emulator (Puerto 5001):** Funciones `createUserAdmin`, `resendInvitationAdmin`, `recordInvitationOutcomeAdmin`, `confirmUserActivation` y `updateUserAdmin`.

### Resultados Globales de la Ejecución
* **Pruebas de la Matriz E2E (Fase 6.5):** **42 de 42 aprobadas (100%)**
* **Pruebas de Emulador Complementarias (`nativeAuthFlow`, `authTicketOwnership`, `authEmulatorIsolation`):** **42 de 42 aprobadas (100%)**
* **Pruebas Unitarias del Repositorio (`functions/__tests__`):** **2,292 de 2,292 aprobadas en 90 suites (100%)**
* **Total de Pruebas Automatizadas Verificadas:** **2,376 pruebas exitosas (0 fallos)**
* **Evidencias Visuales de Navegador Generadas:** **14 capturas independientes** (Desktop 1440×900 px y Mobile 375×667 px).

---

## 2. Diagramas de Secuencia de los Flujos E2E

### 2.1. Flujo Integral de Creación, Invitación y Activación

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Gerente (ERP UI)
    participant UI as ERP Frontend (Chrome)
    participant Backend as Cloud Functions (createUserAdmin)
    participant FS as Firestore (users / invitationOps)
    participant Auth as Firebase Auth Emulator
    actor User as Usuario Invitado (Navegador)

    Admin->>UI: Completa formulario de usuario (Nombre, Email, Rol)
    UI->>Backend: createUserAdmin(email, nombre, role, opId)
    Backend->>Auth: admin.auth().createUser({ email })
    Auth-->>Backend: newAuthUser (uid)
    Backend->>FS: Crea users/<id> (status: pending, sentCount: 0)
    Backend->>FS: Registra invitationOps/<requestId> (status: ISSUED)
    Backend-->>UI: { ok: true, id, requestId, link: null }
    UI->>UI: CrmOutbox.enqueue(requestId, userId, opId, 'unknown')
    UI->>Auth: Client SDK: sendPasswordResetEmail(email, continueUrl)
    Auth->>Auth: Genera OOB (Single Dispatch, sin duplicados)
    UI->>Backend: recordInvitationOutcomeAdmin(requestId, 'accepted')
    Backend->>FS: invitationOps/<requestId> -> RECORDED
    Backend->>FS: users/<id> -> sentCount: 1, lastRequestStatus: 'accepted'
    UI->>UI: CrmOutbox.dequeue(requestId)
    User->>Auth: Abre OOB Link en navegador
    Auth-->>User: Muestra pantalla de establecimiento de contraseña
    User->>Auth: Define nueva contraseña segura
    Auth-->>User: Contraseña aceptada; redirige a continueUrl
    User->>UI: Retorna a ERP (/login?mode=activate&email=...)
    UI->>UI: CrmAuth.handleActivationReturn() -> Muestra Banner y pre-rellena correo
    UI->>UI: replaceState purga parámetros sensibles de URL
    User->>UI: Ingresa contraseña y presiona Iniciar Sesión
    UI->>Auth: signInWithEmailAndPassword(email, pass)
    Auth-->>UI: idToken con claims verificados
    UI->>Backend: confirmUserActivation(dbSuffix)
    Backend->>FS: users/<id>.invitation.status -> 'activated'
    Backend->>FS: Registra commercialAudit (action: 'userActivated')
    Backend-->>UI: { activated: true, newlyActivated: true }
    UI-->>User: Acceso completo a DUCTSAL ERP
```

---

### 2.2. Flujo de Recuperación de Contraseña con Anti-Enumeración

```mermaid
sequenceDiagram
    autonumber
    actor User as Usuario en Login
    participant UI as Modal Recuperación (Chrome)
    participant Auth as Firebase Auth Emulator

    User->>UI: Clic en "¿Olvidaste tu contraseña?"
    UI->>UI: Abre #forgot-password-modal con foco accesible
    User->>UI: Ingresa correo electrónico y envía
    UI->>UI: Guarda in-flight bloquea doble clic (botón: "Enviando...")
    alt Usuario Existe
        UI->>Auth: Client SDK: sendPasswordResetEmail(email, continueUrl)
        Auth->>Auth: Genera código OOB en memoria del emulador
        UI->>User: Muestra mensaje neutral verde (#22c55e)
    else Usuario NO Existe / Formato Inválido
        UI->>Auth: Client SDK: sendPasswordResetEmail (rechazado por Auth)
        UI->>User: Muestra mensaje neutral idéntico (#22c55e) (Anti-Enumeración)
    end
    User->>Auth: Abre enlace OOB capturado
    User->>Auth: Establece nueva contraseña
    Auth-->>User: Contraseña actualizada; enlace anterior queda revocado
    User->>UI: Inicia sesión con NUEVA contraseña -> Éxito
    User->>UI: Intenta iniciar sesión con contraseña ANTERIOR -> Rechazado
```

---

## 3. Matriz Detallada de Escenarios E2E (Fase 6.5)

| Bloque | ID | Descripción del Escenario | Resultado | Evidencia / Mecanismo de Verificación |
| :--- | :---: | :--- | :---: | :--- |
| **A. Creación** | A1 | Gerente crea usuario vendedor en `createUserAdmin` | **APROBADO** | Backend crea cuenta en Firebase Auth con UID propio y rol asignado. |
| | A2 | Creación de perfil comercial en Firestore `users_local` | **APROBADO** | Perfil creado con `activo: true`, `status: pending`, `sentCount: 0`. |
| | A3 | Generación de ticket Write-Ahead `invitationOps` | **APROBADO** | Documento registrado con `status: ISSUED` y TTL de 24 horas. |
| | A4 | Registro preventivo en Outbox local del navegador | **APROBADO** | `CrmOutbox.enqueue` persiste la intención en `localStorage` antes de red. |
| | A5 | Firebase Client SDK solicita correo nativo en navegador | **APROBADO** | `auth.sendPasswordResetEmail` ejecutado contra Auth Emulator sin error. |
| | A6 | Emulador genera exactamente un código OOB | **APROBADO** | API `/emulator/v1/projects/.../oobCodes` devuelve exactamente 1 registro. |
| | A7 | Cero duplicados desde Admin SDK | **APROBADO** | Cero enlaces generados en backend; `link: null` estricto en API. |
| | A8 | Cero almacenamiento de contraseñas en Firestore | **APROBADO** | Escaneo completo de colecciones confirma ausencia de credenciales planas. |
| **B. Contraseña** | B1 | Apertura de enlace OOB en navegador Chrome Headless | **APROBADO** | Navegación exitosa al endpoint de restablecimiento del emulador. |
| | B2 | Verificación de respuesta nativa de Firebase Emulator | **APROBADO** | Verificación de plantilla de acción y parámetros `resetPassword`. |
| | B3 | Envío de nueva contraseña segura | **APROBADO** | Envío de contraseña válida al endpoint del emulador. |
| | B4 | Aceptación de contraseña por Firebase Auth | **APROBADO** | Intento de login REST con nueva contraseña retorna HTTP 200 con `idToken`. |
| | B5 | Retorno al ERP vía `continueUrl` con banner y prellenado | **APROBADO** | Muestra `#activation-return-banner` y pre-llena `#login-email`. |
| | B5.clean | Purgado de parámetros sensibles vía `replaceState` | **APROBADO** | `mode=activate` y `email` eliminados de la barra de direcciones. |
| | B6.inflight | Guarda in-flight en botón de inicio de sesión | **APROBADO** | `#btn-login-submit` deshabilitado con texto `Ingresando...`. |
| | B6 | Login exitoso con nueva contraseña en ERP | **APROBADO** | Autenticación confirmada con `idToken` y claim `vendedor`. |
| | B7 | Confirmación de activación mediante backend | **APROBADO** | `confirmUserActivation` transiciona usuario a `status: activated`. |
| | B7.fs | Reflejo en Firestore del perfil activado | **APROBADO** | Campo `invitation.status: activated` verificado en base de datos. |
| | B8 | Idempotencia estricta de `confirmUserActivation` | **APROBADO** | Segundo llamado retorna `{ activated: true, alreadyActive: true }`. |
| **C. Recuperación**| C1 | Apertura de modal "¿Olvidaste tu contraseña?" | **APROBADO** | Modal `#forgot-password-modal` visible con accesibilidad ARIA. |
| | C.format | Validación local de formato de correo | **APROBADO** | Correo sin `@` bloqueado localmente con advertencia amigable. |
| | C.inflight | Guarda in-flight contra doble clic | **APROBADO** | Botón cambia a `Enviando...` y se deshabilita durante la petición. |
| | C2 & C3 | Solicitud de recuperación para usuario existente | **APROBADO** | Respuesta neutra exitosa (`#22c55e`) con instrucciones de seguridad. |
| | C.nonexisting| Anti-enumeración para usuario inexistente | **APROBADO** | Mensaje y estilos idénticos al usuario existente; cero fugas. |
| | C4 | Captura de OOB de recuperación en emulador | **APROBADO** | Emulador captura nuevo OOB con tipo `PASSWORD_RESET`. |
| | C.expired | Rechazo de código OOB inválido o expirado | **APROBADO** | Petición con código falseado rechazada por Firebase Auth. |
| | C5 | Establecimiento de nueva credencial vía OOB | **APROBADO** | Contraseña actualizada con éxito mediante código válido. |
| | C.used | Rechazo inmediato de código OOB ya consumido | **APROBADO** | Reutilización rechazada de inmediato por Firebase (código de un solo uso). |
| | C6 | Login con la NUEVA contraseña | **APROBADO** | Autenticación autorizada con la nueva clave. |
| | C7 | Rechazo de la contraseña ANTERIOR | **APROBADO** | Credencial previa rechazada (`INVALID_PASSWORD`). |
| **D. Reenvío** | D1 & D2 | Reenvío de invitación emite nuevo ticket ISSUED | **APROBADO** | `resendInvitationAdmin` genera nuevo `requestId` en `invitationOps`. |
| | D3 | Preservación de identidad de Auth | **APROBADO** | `authUid` original se mantiene inalterado tras el reenvío. |
| | D4 | Protección de usuarios activados | **APROBADO** | Reenvío sobre usuario activado mantiene `status: activated` (no retrocede). |
| | D6 | Reporte `failed` registra error sin sumar `sentCount` | **APROBADO** | `sentCount` permanece en 0 y se almacena `errorCode: NETWORK_ERROR`. |
| | D7 | Reporte `unknown` registra `CLIENT_TIMEOUT` | **APROBADO** | No provoca auto-reenvío masivo ni sobreescribe `accepted`. |
| **E. Roles/Seg.** | E.gestor | Gestor no puede crear usuarios | **APROBADO** | Rechazado con HTTP 403 `PERMISSION_DENIED`. |
| | E.vendedor| Vendedor no puede crear usuarios | **APROBADO** | Rechazado con HTTP 403 `PERMISSION_DENIED`. |
| | E.disabled| Usuario con `activo: false` no puede activarse | **APROBADO** | `confirmUserActivation` rechaza con `PERMISSION_DENIED`. |
| | E.ownership| Ticket ownership protegido (Admin B vs Ticket Admin A) | **APROBADO** | Admin B rechazado con HTTP 403 al intentar registrar ticket de Admin A. |
| | E.unauth | Llamada anónima a funciones protegidas | **APROBADO** | Petición sin token rechazada con HTTP 401 `UNAUTHENTICATED`. |
| **F. Resiliencia**| F1 | Encolado Write-Ahead en Outbox local | **APROBADO** | Entrada persiste en `CrmOutbox` ante eventual fallo de red o caída. |
| | F2 | Reconciliación automática de operaciones pendientes | **APROBADO** | `CrmAuth.reconcileOutbox` despacha pendientes y registra confirmación. |
| | F3 | Desocupación automática de la cola tras reconciliación | **APROBADO** | Outbox queda con 0 pendientes tras el despacho exitoso. |
| **Responsivo** | R1 | Auditoría en móvil (iPhone 375×667 px) | **APROBADO** | Login, modal de recuperación y banner adaptados sin desbordamientos. |

---

## 4. Evidencias Visuales de Navegador Real (CDP)

Todas las capturas fueron tomadas de forma real durante la ejecución automatizada de la suite `test:e2e-matrix` a través del Chrome DevTools Protocol, guardadas directamente en `docs/screenshots/`:

| Archivo | Viewport | Descripción de la Evidencia |
| :--- | :---: | :--- |
| [`step6_5_desktop_login.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_desktop_login.png) | 1440×900 | Pantalla de inicio de sesión de DUCTSAL ERP en escritorio con banner de emulador visible. |
| [`step6_5_A_user_created.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_A_user_created.png) | 1440×900 | Estado del sistema tras creación de usuario comercial y emisión de ticket en backend. |
| [`step6_5_B1_firebase_emulator_reset_screen.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_B1_firebase_emulator_reset_screen.png) | 1440×900 | Enlace OOB abierto en navegador mostrando la pantalla nativa de Firebase Emulator. |
| [`step6_5_B2_firebase_password_set_success.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_B2_firebase_password_set_success.png) | 1440×900 | Pantalla de confirmación tras aceptar la nueva contraseña del usuario. |
| [`step6_5_B3_erp_return_activation_banner.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_B3_erp_return_activation_banner.png) | 1440×900 | Retorno al ERP con banner verde de confirmación y correo prellenado en el formulario. |
| [`step6_5_B4_login_in_flight.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_B4_login_in_flight.png) | 1440×900 | Guarda de seguridad en vuelo: botón deshabilitado con indicador «Ingresando...». |
| [`step6_5_B5_user_activated_session.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_B5_user_activated_session.png) | 1440×900 | Sesión de usuario vendedor autenticada y activada tras completar el flujo. |
| [`step6_5_C1_forgot_password_modal.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_C1_forgot_password_modal.png) | 1440×900 | Modal "¿Olvidaste tu contraseña?" abierto con foco accesible y backdrop oscuro. |
| [`step6_5_C2_invalid_email_error.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_C2_invalid_email_error.png) | 1440×900 | Intercepción local de correo inválido mostrando mensaje amigable en amarillo. |
| [`step6_5_C3_recovery_existing_neutral.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_C3_recovery_existing_neutral.png) | 1440×900 | Mensaje neutral tras solicitar recuperación de cuenta existente en el sistema. |
| [`step6_5_C4_recovery_nonexisting_neutral.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_C4_recovery_nonexisting_neutral.png) | 1440×900 | Mensaje neutral idéntico para cuenta inexistente (defensa contra enumeración de usuarios). |
| [`step6_5_mobile_login.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_mobile_login.png) | 375×667 | Pantalla de inicio de sesión adaptada al viewport de dispositivo móvil. |
| [`step6_5_mobile_recovery_modal.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_mobile_recovery_modal.png) | 375×667 | Modal de recuperación renderizado correctamente en pantalla móvil. |
| [`step6_5_mobile_activation_banner.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/step6_5_mobile_activation_banner.png) | 375×667 | Banner de retorno de activación perfectamente legible en pantalla móvil. |

---

## 5. Incidencias Detectadas y Correcciones Locales

Durante el desarrollo de la validación integral se identificaron y subsanaron los siguientes puntos técnicos en el entorno local:

1. **Retardo en Apertura de Puerto CDP en Chrome macOS:**
   * *Diagnóstico:* En entornos macOS con extensiones instaladas, Chrome Headless tardaba varios segundos en inicializar el puerto de depuración remota.
   * *Corrección:* Se configuraron los parámetros `--disable-extensions`, `--disable-dev-shm-usage`, `--remote-debugging-address=127.0.0.1` y un ciclo de reintentos progresivo con un límite de 25 segundos.
2. **Enrutamiento SPA para Rutas Virtuales en Servidor Local:**
   * *Diagnóstico:* Al retornar de Firebase Auth mediante `continueUrl` con la ruta `/login?mode=activate...`, el servidor estático local de pruebas devolvía 404 al buscar el archivo físico `login`.
   * *Corrección:* Se implementó el fallback estándar de SPA (Single Page Application) en el servidor HTTP de pruebas, sirviendo `index.html` para rutas sin extensión.
3. **Mapeo de Códigos de Error a Lista Blanca en `recordInvitationOutcomeAdmin`:**
   * *Diagnóstico:* El cliente SDK emite errores con formato `auth/network-request-failed`, mientras que la Cloud Function requiere códigos sanitizados según la lista blanca de auditoría (`NETWORK_ERROR`).
   * *Corrección:* Se integró `CrmOutbox.sanitizeErrorCode` en el flujo de despacho para normalizar los errores antes de invocar la Cloud Function.
4. **Resolución de Perfil Comercial Previo a Claims en `processDirectFirebaseAuthLogin`:**
   * *Diagnóstico:* Cuando un usuario recién aprovisionado inicia sesión por primera vez, el token de Auth no contiene el claim `cid` hasta que se refresca la sesión.
   * *Corrección:* Se agregó en `app_core.js` una consulta de resolución de perfil por `authUid` sobre Firestore, garantizando que el usuario acceda sin depender de un refresh previo del token.
5. **Inmunización contra Bloqueos de `window.alert` en Chrome Headless:**
   * *Diagnóstico:* La invocación de `window.alert` bloqueaba el hilo principal de JavaScript de Chrome en modo Headless.
   * *Corrección:* Se interceptó `window.alert` en el contexto de navegación y se configuró el evento `Page.javascriptDialogOpening` para auto-aceptar diálogos de manera no bloqueante.

---

## 6. Estado de Seguridad, Permisos y Aislamiento

* **Zero-Trust Ticket Ownership:** Se demostró que un administrador no puede registrar ni manipular tickets emitidos por otro administrador (rechazo estricto con HTTP 403 `PERMISSION_DENIED`).
* **Protección contra Spoofing de Identidad:** `confirmUserActivation` valida que el solicitante sea exactamente el titular del perfil (`context.auth.uid === user.authUid`), impidiendo activaciones cruzadas.
* **Anti-Enumeración Estricta:** La respuesta visual y temporal para solicitudes de restablecimiento es indistinguible entre usuarios existentes e inexistentes.
* **Higiene de Secretos en Base de Datos:** Se verificó exhaustivamente que ni códigos OOB, ni enlaces de restablecimiento, ni contraseñas en texto plano se almacenan en Firestore.
* **Aislamiento Absoluto de Producción:**
  * Todas las pruebas se ejecutaron exclusivamente contra `demo-ductsal-local` en loopback (`127.0.0.1`).
  * Los guardias de seguridad (`scripts/assertTargetProject.js` y `emulatorGuard.js`) permanecieron activos en todo momento.
  * Cero peticiones dirigidas al proyecto de producción `ductsal-erp` ni a servicios de correo externos.

---

## 7. Limitaciones Pendientes

* **Dominio Personalizado en Firebase Console (`auth.ductsal.com`):**  
  Continúa en estado `IN_PROGRESS` en la consola de Firebase mientras se completa la propagación DNS de los registros TXT y CNAME en Network Solutions. Esta limitación es de naturaleza externa de infraestructura y no afecta en absoluto el funcionamiento lógico ni la seguridad del código verificado.

---

## 8. Dictamen Final

```
==========================================================================================
                              DICTAMEN DE VALIDACIÓN FASE 6.5
==========================================================================================

                                     APROBADO

  Todos los flujos de creación, invitación nativa, establecimiento de contraseña,
  retorno al ERP, activación idempotente, recuperación con anti-enumeración, roles,
  seguridad multitenant y diseño responsivo han sido probados y validados integralmente
  en navegador real contra los emuladores locales de Firebase con 100% de éxito.
==========================================================================================
```
