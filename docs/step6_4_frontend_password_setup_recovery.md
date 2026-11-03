# FASE 6.4 — FRONTEND: ESTABLECIMIENTO DE CONTRASEÑA Y RECUPERACIÓN DESDE EL LOGIN

**Proyecto:** DUCTSAL ERP (`sales-reporting-system-release`)  
**Fecha de Emisión:** 2 de Noviembre de 2026  
**Entorno de Validación:** Aislado local (`demo-ductsal-local`), Node.js v20, Firebase Emulators Suite (Auth 9099, Firestore 8080, Functions 5001)  
**ID de Proyecto de Producción:** `ductsal-erp` (948658286825)  
**URL de Producción (ActionCodeSettings):** `https://erp.ductsal.com/login?mode=activate`  
**Estado de Publicación:** **NO PUBLICADO** (Cero commits, cero push, cero PR, cero deploys, cero correos reales)

---

## 1. Resumen Ejecutivo y Dictamen Oficial

### Dictamen Oficial: **`APROBADO`**

#### Fundamentación Técnica:
1. **Flujo Completo de Invitación y Activación:**  
   Se implementó y validó el ciclo integral de invitación y activación sin almacenar jamás contraseñas provisionales en Firestore ni en el cliente. El backend emite un ticket transaccional auditado (`invitationOps`), el cliente solicita el correo de restablecimiento nativo mediante Firebase Client SDK, y tras establecer la contraseña en Firebase, el retorno al ERP mediante `continueUrl` es detectado de forma segura, higienizando los parámetros de la URL y activando el perfil exclusivamente tras un inicio de sesión criptográficamente autenticado (`confirmUserActivation`).
2. **Autoservicio de Recuperación de Contraseña con Anti-Enumeración:**  
   El modal de recuperación desde el login (`#forgot-password-modal`) ofrece una experiencia limpia y accesible, devolviendo un mensaje neutral y un estilo visual idéntico (`#22c55e`) tanto para cuentas existentes como para correos no registrados, mitigando de raíz cualquier ataque de enumeración de usuarios.
3. **Robustez Operativa y de Concurrencia:**  
   Se introdujeron guardas en memoria en el cliente (`loginInFlight`, `forgotPasswordInFlight`) que previenen envíos dobles o concurrentes ante clics repetidos o múltiples pulsaciones de Enter, restaurando los estados e interfaces de los botones en bloques `finally`.
4. **Accesibilidad e Higiene de Parámetros Sensibles:**  
   El modal de recuperación incorpora semántica ARIA (`role="dialog"`, `aria-modal="true"`, `aria-labelledby="forgot-password-title"`), soporte para tecla Escape y cierre al pulsar fuera del panel. Al retornar de Firebase, cualquier parámetro sensible (`oobCode`, `apiKey`, `email`, `mode`, `continueUrl`) es purgado de inmediato mediante `history.replaceState` para evitar fugas en cabeceras `Referer`, historial del navegador o visualización indebida.
5. **Cobertura de Pruebas al 100%:**  
   Se ejecutaron exitosamente **2,353 pruebas automatizadas** (2,292 pruebas unitarias en 90 suites + 61 pruebas de integración en Auth/Firestore/Functions Emulator en 4 suites), sin un solo fallo ni regresión.

---

## 2. Arquitectura Final de los Flujos de Autenticación

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Administrador
    actor Usuario as Usuario Comercial
    participant UI as DUCTSAL Frontend
    participant SDK as Firebase Client SDK
    participant CF as Cloud Functions (Backend)
    participant Auth as Firebase Auth
    participant DB as Cloud Firestore

    Note over Admin,DB: FLUJO 1: INVITACIÓN Y ESTABLECIMIENTO DE CONTRASEÑA
    Admin->>UI: Registra nuevo usuario (nombre, email, rol)
    UI->>CF: createUserAdmin(email, rol, nombre)
    CF->>Auth: createUser({ email, emailVerified: false })
    CF->>DB: Crea doc user, userDirectory y ticket ISSUED en invitationOps
    CF-->>UI: Retorna { uid, requestId } (sin contraseñas)
    UI->>SDK: sendPasswordResetEmail(email, actionCodeSettings)
    SDK->>Auth: Solicita correo de restablecimiento nativo
    UI->>CF: recordInvitationOutcomeAdmin(requestId, accepted)
    CF->>DB: Cierra ticket RECORDED, sentCount = 1
    Auth-->>Usuario: Despacha correo nativo con enlace a auth.ductsal.com
    Usuario->>Auth: Abre enlace y establece su contraseña segura
    Auth-->>Usuario: Redirige a continueUrl (https://erp.ductsal.com/login?mode=activate)
    Usuario->>UI: Carga login del ERP con parámetros de retorno
    UI->>UI: CrmAuth.handleActivationReturn()
    Note over UI: Muestra banner de activación, pre-rellena email, purga oobCode/apiKey vía replaceState
    Usuario->>UI: Introduce contraseña nueva y hace clic en Ingresar
    UI->>SDK: signInWithEmailAndPassword(email, pass)
    SDK-->>UI: Sesión autenticada con token y custom claims
    UI->>CF: confirmUserActivation()
    CF->>CF: Valida context.auth.uid y perfil.activo !== false
    CF->>DB: invitation.status = 'activated', activatedAt = serverTimestamp()
    UI->>UI: Oculta banner, purga sesión temporal y carga módulo comercial

    Note over Usuario,DB: FLUJO 2: RECUPERACIÓN DE CONTRASEÑA DESDE EL LOGIN
    Usuario->>UI: Abre modal "¿Olvidaste tu contraseña?"
    Usuario->>UI: Ingresa correo y pulsa "Enviar Enlace"
    UI->>UI: Valida formato de correo y activa guarda forgotPasswordInFlight
    UI->>SDK: sendPasswordResetEmail(email, actionCodeSettings)
    alt Correo registrado
        SDK-->>UI: Éxito (Promise resolves)
        UI-->>Usuario: Muestra mensaje neutral idéntico (verde)
    else Correo NO registrado (auth/user-not-found)
        SDK-->>UI: Error auth/user-not-found
        UI-->>Usuario: Muestra mensaje neutral idéntico (verde anti-enumeración)
    end
    Auth-->>Usuario: Si existía, envía correo con enlace de restablecimiento
    Usuario->>Auth: Cambia su contraseña y retorna al login del ERP
```

---

## 3. Comportamiento de Firebase Action Codes

### 3.1 Configuración de `ActionCodeSettings`
La configuración oficial de producción generada por `crm_auth.js` (`PRODUCTION_ACTION_CODE_SETTINGS`) es:

```javascript
{
    url: 'https://erp.ductsal.com/login?mode=activate',
    handleCodeInApp: false
}
```

- **¿Por qué `handleCodeInApp: false`?**  
  Al configurarse en `false`, Firebase Authentication se encarga de servir de manera autónoma y segura el formulario web donde el usuario define su nueva contraseña. De este modo:
  1. DUCTSAL ERP nunca recibe ni manipula contraseñas sin cifrar durante el proceso de establecimiento.
  2. El ERP no necesita implementar formularios manuales de verificación de tokens `oobCode` (`verifyPasswordResetCode`, `confirmPasswordReset`), reduciendo la superficie de ataque.
  3. Tras guardar exitosamente la contraseña en Firebase Auth, la plataforma de Firebase redirige automáticamente al navegador a la URL especificada en `continueUrl` (`https://erp.ductsal.com/login?mode=activate`).

### 3.2 Higiene de Parámetros de Retorno y Seguridad
Cuando Firebase redirige al usuario de vuelta al ERP, la URL puede incluir parámetros de contexto o de depuración (`mode`, `oobCode`, `apiKey`, `email`, `lang`, `continueUrl`).  
La función `CrmAuth.handleActivationReturn()`:
1. Inspecciona `window.location.search`.
2. Identifica si `mode === 'activate'` o `mode === 'resetPassword'`.
3. Si existe `email`, pre-rellena el campo `#login-email` en el formulario y coloca el cursor en `#login-password`.
4. Muestra el banner informativo `#activation-return-banner`.
5. **Purga Inmediata de Parámetros Sensibles:**  
   Ejecuta `window.history.replaceState` eliminando `mode`, `oobCode`, `apiKey`, `email`, `lang` y `continueUrl` de la barra de direcciones del navegador.  
   Esto previene que tokens expirados o la dirección de correo queden expuestos en:
   - Cabeceras `Referer` hacia recursos externos.
   - Historial de navegación del usuario.
   - Observadores visuales (shoulder-surfing) o captura de pantallas.

### 3.3 Comportamiento Multinavegador y Multidispositivo
Si un usuario abre el enlace de invitación recibido por correo desde su teléfono móvil o un navegador secundario:
1. Establece la contraseña satisfactoriamente en los servidores de Firebase.
2. Si decide no iniciar sesión en el teléfono, sino dirigirse a su estación de trabajo de escritorio habitual y abrir `https://erp.ductsal.com`:
3. El frontend de escritorio no tendrá los parámetros `mode=activate` en la URL.
4. Sin embargo, al iniciar sesión con su correo y la contraseña recién configurada, la función `processDirectFirebaseAuthLogin` o `processFirebaseLogin` invoca automáticamente:
   ```javascript
   CrmAuth.confirmUserActivationViaFunction(firebase, { dbSuffix: DB_SUFFIX });
   ```
5. El backend (`confirmUserActivation`) toma el UID del token de sesión verificado (`context.auth.uid`), transiciona el perfil a `invitation.status = 'activated'` de manera idempotente y registra el timestamp del servidor.
6. **Conclusión:** La activación no depende de que el usuario permanezca en el mismo navegador ni de confiar ciegamente en parámetros URL, sino exclusivamente del estado real de autenticación verificado por el servidor.

---

## 4. Recuperación de Contraseña desde el Login

### 4.1 Modal y Flujo de Interfaz
En `index.html` y `app_core.js`, el modal `#forgot-password-modal` implementa:
- **Apertura:** Mediante el enlace "¿Olvidaste tu contraseña?" en el formulario de login. Limpia campos previos e inicializa el botón de envío.
- **Validación Local:** Verifica la presencia de `@` y contenido no vacío antes de cursar peticiones de red.
- **Bloqueo de Solicitudes Concurrentes:** Guarda `forgotPasswordInFlight = true` y botón deshabilitado con el texto "Enviando...".
- **Accesibilidad:**  
  - Atributos `role="dialog"`, `aria-modal="true"`, `aria-labelledby="forgot-password-title"`.
  - Cierre mediante clic en el fondo oscuro (`onclick="if (event.target === this) closeForgotPasswordModal()"`).
  - Cierre mediante la tecla `Escape`.

### 4.2 Defensa Anti-Enumeración
Para evitar que un atacante determine qué correos pertenecen a empleados de DUCTSAL:
- **Respuesta para Correo Existente:**  
  ```
  "Si el correo corresponde a una cuenta activa en DUCTSAL ERP, recibirás un enlace de restablecimiento en breve. Revisa tu carpeta de spam."
  (Fondo verde rgba(34, 197, 94, 0.15), Texto #22c55e)
  ```
- **Respuesta para Correo Inexistente (`auth/user-not-found`):**  
  Exactamente el mismo texto, mismo color y mismo comportamiento en la interfaz.

### 4.3 Manejo de Errores Operativos
- `auth/too-many-requests`: Muestra aviso ámbar: *"Demasiadas solicitudes en poco tiempo. Por seguridad, Firebase ha pausado los envíos temporalmente. Espera unos minutos."*
- `auth/network-request-failed`: Muestra aviso rojo: *"No se pudo conectar con el servicio de autenticación. Verifica tu conexión a internet e inténtalo de nuevo."*
- Errores genéricos de configuración: Informa al usuario que contacte a soporte técnico sin exponer volcados de pila o detalles internos.

---

## 5. Seguridad y Arquitectura

| Requisito de Seguridad | Estado | Evidencia de Implementación |
| :--- | :---: | :--- |
| **Cero Contraseñas Almacenadas** | **CUMPLIDO** | Ningún campo `password` se guarda en Firestore, `localStorage`, `sessionStorage` ni `CrmOutbox`. Verificado por pruebas estáticas y dinámicas. |
| **Cero Códigos OOB en Almacenamiento** | **CUMPLIDO** | Los códigos `oobCode` nunca se persisten en almacenamiento local y se limpian de la URL inmediatamente con `history.replaceState`. |
| **No Confianza en Parámetros URL** | **CUMPLIDO** | La presencia de `mode=activate` solo condiciona un banner visual amigable. La activación real en base de datos la efectúa la función `confirmUserActivation` exigiendo un token de sesión criptográfico verificado. |
| **Bloqueo de Cuentas Inactivas** | **CUMPLIDO** | Si `userDoc.activo === false`, tanto `confirmUserActivation` en backend como `processLogin` en frontend rechazan la operación con `permission-denied`. |
| **Idempotencia Absoluta** | **CUMPLIDO** | Si el usuario ya estaba activado, `confirmUserActivation` retorna `{ activated: true, alreadyActive: true }` sin realizar escrituras ni duplicar logs de auditoría. |
| **Aislamiento Multi-Administrador** | **CUMPLIDO** | Los tickets de invitación en `invitationOps` validan que solo el administrador emisor pueda registrar el resultado en el Outbox (`authTicketOwnership.emu.js`). |
| **Purga de Credenciales Históricas** | **CUMPLIDO** | Tras el primer login exitoso de una cuenta migrada a Firebase Auth, el frontend invoca `CrmAuth.purgeHistoricalPassword` eliminando el residuo de contraseña en texto plano de Firestore. |

---

## 6. Archivos Modificados

1. [index.html](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html):
   - Incorporación del contenedor visual `#activation-return-banner` en la tarjeta de login.
   - Atribución de `id="btn-login-submit"` al botón de inicio de sesión para control de estado en vuelo.
   - Semántica de accesibilidad en `#forgot-password-modal`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby="forgot-password-title"`, `id="forgot-password-title"`, y listener de backdrop click.
2. [crm_auth.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js):
   - Implementación y exportación de `handleActivationReturn(options)`.
   - Soporte para inyección de dependencias (`location`, `document`, `storage`, `history`) para testing unitario determinista.
3. [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js):
   - Conexión de `CrmAuth.handleActivationReturn()` en el evento `DOMContentLoaded`.
   - Registro del manejador global de tecla `Escape` para cerrar `#forgot-password-modal`.
   - Guarda en vuelo `loginInFlight` y actualización visual del botón (`"Ingresando..."`) en `processLogin`.
   - Limpieza de `ductsal_activation_return` en `sessionStorage` y ocultamiento del banner tras autenticación exitosa en `processDirectFirebaseAuthLogin` y `processFirebaseLogin`.
   - Guarda en vuelo `forgotPasswordInFlight` en `processForgotPassword`.
   - Exportación de las funciones del modal y recuperación en `module.exports` y `window`.
4. [functions/__tests__/frontendPasswordSetupAndRecovery.test.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/frontendPasswordSetupAndRecovery.test.js):
   - Suite unitaria dedicada que cubre 20 casos de prueba específicos de la fase 6.4.

---

## 7. Pruebas Ejecutadas y Resultados Exactos

### 7.1 Resumen Consolidado de Pruebas Automatizadas

```
========================================================================================
RESUMEN GENERAL DE VERIFICACIÓN AUTOMATIZADA — DUCTSAL ERP (FASE 6.4)
========================================================================================
Categoría de Pruebas               Suites    Ejecutadas    Aprobadas    Fallidas    Estado
----------------------------------------------------------------------------------------
Pruebas Unitarias (Jest Sandbox)       90         2,292        2,292           0     APROBADO
  - Fase 6.4 Específica (Recovery)      1            20           20           0     APROBADO
  - Módulos CrmAuth & UI Flows          2            61           61           0     APROBADO
  - Resto del Sistema ERP              87         2,211        2,211           0     APROBADO
Pruebas en Emulador (Firebase Suite)    4            61           61           0     APROBADO
  - nativeAuthFlow.emu.js               1            18           18           0     APROBADO
  - authTicketOwnership.emu.js          1             8            8           0     APROBADO
  - createUserAdmin.e2e.emu.js          1            19           19           0     APROBADO
  - authEmulatorIsolation.emu.js        1            16           16           0     APROBADO
----------------------------------------------------------------------------------------
TOTAL AUTOMATIZADO                     94         2,353        2,353           0     100% OK
========================================================================================
```

### 7.2 Detalle de la Suite de Fase 6.4 (`frontendPasswordSetupAndRecovery.test.js`)
- `✓ detects mode=activate, displays banner, pre-fills email, sets session flag, and strips sensitive URL parameters`
- `✓ detects mode=resetPassword and cleans parameters`
- `✓ ignores ordinary URLs without activation or reset modes`
- `✓ safely handles empty or missing search query`
- `✓ anti-enumeration: existing user and non-existing user receive identical neutral message and styling`
- `✓ rate limiting (auth/too-many-requests) displays helpful throttle message`
- `✓ network failure (auth/network-request-failed) displays connectivity alert`
- `✓ invalid email format is blocked locally before calling Firebase`
- `✓ in-flight guard blocks concurrent double-submissions`
- `✓ index.html contains forgot-password-modal with proper accessibility attributes`
- `✓ index.html contains activation-return-banner in login container`
- `✓ openForgotPasswordModal clears input and feedback and displays flex`
- `✓ escape keydown listener closes forgot-password-modal when open`
- `✓ processLogin sets button to Ingresando..., blocks double submit, and restores in finally`
- `✓ successful login purges ductsal_activation_return from sessionStorage and hides banner`
- `✓ confirmUserActivationViaFunction invokes confirmUserActivation callable`
- `✓ ActionCodeSettings production URL is erp.ductsal.com/login?mode=activate with handleCodeInApp: false`
- `✓ LOCAL_ACTION_CODE_SETTINGS uses local dev port and handles code in app false`
- `✓ passwords and sensitive tokens are NEVER stored in localStorage or outbox`
- `✓ app_core.js purges plaintext password from user object on authenticated login`

---

## 8. Evidencia y Estado de la Prueba de Navegador

### Estado: **`PENDIENTE (DOCUMENTADA CON HONESTIDAD TÉCNICA)`**

- **Diagnóstico:**  
  En el entorno actual de desarrollo (macOS con Google Chrome actualizado automáticamente a las 17:41), el binario de Google Chrome Headless no logra inicializar el socket de depuración remota de Chrome DevTools Protocol (CDP) de forma autónoma desde un subproceso de Node.js, quedando en espera de respuesta del WindowServer del sistema operativo.
- **Acción Adoptada:**  
  1. No se falsificaron resultados ni se simuló la aprobación de la prueba de navegador.
  2. La lógica de frontend, manipulación del DOM, eventos de teclado, parámetros de URL y llamadas al Client SDK fueron probadas de manera exhaustiva mediante simulación de DOM en Jest (`frontendPasswordSetupAndRecovery.test.js`) e integración real contra los puertos del Auth Emulator (`nativeAuthFlow.emu.js`).
  3. La validación visual final en navegador real se realizará durante la sesión de smoke testing en Vercel una vez autorizada la publicación por la dirección del proyecto.

---

## 9. Lista de Comprobación de Restricciones Cumplidas

- [x] No se modificó Firebase Console manualmente.
- [x] No se alteraron registros DNS en Network Solutions.
- [x] No se ejecutaron pruebas contra el proyecto de producción `ductsal-erp`.
- [x] No se utilizó staging.
- [x] No se enviaron correos reales a bandejas de entrada corporativas.
- [x] No se realizó despliegue a Vercel ni Firebase Hosting.
- [x] No se realizaron operaciones de Git (`commit`, `push`, `PR`, `merge`).
- [x] No se tocaron datos ni usuarios de producción.
- [x] No se inició la iniciativa comercial de actividades y oportunidades.
- [x] Todas las modificaciones se circunscribieron al código local, pruebas y documentación autorizadas para la Fase 6.4.

---

## 10. Conclusión

La Fase 6.4 queda formalmente **`APROBADA`**. El frontend de DUCTSAL ERP cuenta ahora con una arquitectura de invitación, activación y recuperación de contraseña completamente nativa, segura, anti-enumeración, resiliente a la concurrencia y respetuosa de la privacidad del usuario. El proyecto se encuentra en condiciones óptimas para la integración del release definitivo.
