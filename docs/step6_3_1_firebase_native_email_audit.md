# DUCTSAL ERP — PASO 6.3.1
## Auditoría de Firebase Authentication y Viabilidad de Correo Nativo

**Fecha:** 2 de Noviembre de 2026  
**Auditor:** Antigravity (Auditoría Técnica y Arquitectura)  
**Proyecto Firebase:** `ductsal-erp` (Producción) | `ductsal-erp-staging` (Staging) | `demo-ductsal-local` (Emuladores)  
**Alcance:** Exclusivo de inspección de solo lectura sobre la viabilidad del correo nativo de Firebase Authentication sin proveedores externos.  
**Estado:** Auditoría completada sin alteraciones de código, sin tráfico SMTP real y sin modificaciones en producción o DNS.  
**Dictamen:** **VIABLE CON LIMITACIONES**

---

## 1. Configuración Verificada de Firebase Authentication

Se realizó una inspección técnica de las configuraciones accesibles en el repositorio local y se identificaron los elementos que requieren consulta directa en Firebase Console.

### 1.1 Inventario de Parámetros y Estado de Verificación

| Parámetro | Valor Verificado en Repositorio | Requiere Acceso a Firebase Console | Estado / Observación |
| :--- | :--- | :---: | :--- |
| **Project ID** | `ductsal-erp` ([app_core.js:6](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L6), [.firebaserc:3](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/.firebaserc#L3)) | No | Proyecto principal de producción. |
| **Auth Domain** | `ductsal-erp.firebaseapp.com` ([app_core.js:5](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L5)) | No | Dominio predeterminado de autenticación de Google. |
| **Web API Key** | `AIzaSyBSnGhwh043oV_zW1FlE5z7N8_ywh9FUEA` ([app_core.js:4](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L4)) | No | Clave pública de cliente para Google Identity Toolkit. |
| **Métodos de Autenticación** | `Email/Password` habilitado exclusivamente | Sí (para confirmar bloqueo de federados) | El frontend y backend solo implementan autenticación por credenciales correo/contraseña. |
| **Idioma de Correo** | **No configurado** en cliente (`languageCode` ausente) | Sí (para idioma por defecto del proyecto) | Al no invocarse `firebase.auth().languageCode = 'es'`, los correos pueden emitirse en inglés según el navegador. |
| **Plantillas de Correo** | No residen en repositorio | **SÍ (Exclusivo en Consola)** | Las plantillas de restablecimiento, verificación y cambio residen en *Authentication > Templates*. |
| **Nombre de Remitente** | No definido en repositorio | **SÍ (Exclusivo en Consola)** | Por defecto toma el nombre del proyecto o `noreply@ductsal-erp.firebaseapp.com`. |
| **Dominio Personalizado** | No configurado en repositorio (`authDomain` usa `firebaseapp.com`) | **SÍ (Exclusivo en Consola)** | Se requiere inspeccionar si existe un trámite de personalización de remitente. |
| **URL de Acción (`ActionCodeSettings`)** | `https://erp.ductsal.com/login?mode=activate` ([functions/invitationService.js:12](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js#L12)) | No | `handleCodeInApp: false` definido para enlaces del servidor. |
| **Dominios Autorizados (OAuth/Continue)** | `erp.ductsal.com` inferido de la arquitectura operativa | **SÍ (Exclusivo en Consola)** | Requiere confirmar en *Authentication > Settings > Authorized domains* que `erp.ductsal.com` esté en lista blanca. |
| **Límites y Cuotas** | No consultable en código estático | **SÍ (Exclusivo en Consola)** | Cuotas de Identity Toolkit (100 correos/día en Spark, límites de ráfaga y cuotas Blaze). |

> [!IMPORTANT]
> **Datos que requieren acceso a Firebase Console:**  
> Ni el texto exacto de las plantillas actuales, ni el remitente configurado en la interfaz gráfica, ni la lista oficial de dominios autorizados se almacenan en el control de versiones de Git. Estos parámetros son gestionados exclusivamente en la infraestructura de Google Cloud / Firebase Console. No deben inferirse ni modificarse sin consultar previamente dicha consola.

---

## 2. Compatibilidad del Flujo Actual

Se inspeccionó línea por línea la interacción entre los componentes actuales del backend y el frontend.

### 2.1 Componentes Inspeccionados

1. **`createUserAdmin` ([functions/index.js:320–625](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L320-L625)):**
   - Crea el usuario en Firebase Authentication con `admin.auth().createUser`.
   - Crea el perfil en Firestore `users_prod/<id>` con `invitation: buildInitialInvitation(email)`.
   - Genera enlace mediante `admin.auth().generatePasswordResetLink(email, ACTION_CODE_SETTINGS)`.
   - Despacha mediante `invitationDispatcher` usando `defaultPreparedDriver` (Paso 6.2), retornando `sent: false`, `delivery: 'prepared'`.
2. **`resendInvitationAdmin` ([functions/index.js:1056–1170](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L1056-L1170)):**
   - Valida usuario activo y vinculado.
   - Genera nuevo enlace fresco con `generatePasswordResetLink`.
   - Despacha a través de `invitationDispatcher`, actualiza `preparedCount` en el perfil y audita. Retorna `{ sent: false, delivery: 'prepared' }`.
3. **`updateUserAdmin` ([functions/index.js:816–1048](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L816-L1048)):**
   - Gestiona cambios de nombre, rol y correo electrónico con sincronización Auth/Firestore y rollback compensatorio.
4. **`functions/invitationService.js` ([Líneas 1–180](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js)):**
   - Define `ACTION_CODE_SETTINGS` (`url: 'https://erp.ductsal.com/login?mode=activate'`, `handleCodeInApp: false`).
   - Define estados `INVITATION_STATUS` (`pending`, `prepared`, `link_failed`, `delivery_failed`, `activated`).
   - `InvitationDispatcher` soporta reemplazo dinámico de driver (`setDriver`).
5. **`crm_auth.js` ([Líneas 116–120, 271–277](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L116-L120)):**
   - `sendPasswordSetupEmail(fb, email)` invoca directamente `fb.auth().sendPasswordResetEmail(email)`.
   - En `adminCreateUser`, tras recibir la confirmación de la Cloud Function, el cliente web del gerente invoca de inmediato `sendPasswordSetupEmail(fb, normalized)`.
6. **`modules/users/users_controller.js` ([Líneas 335–347](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js#L335-L347)):**
   - Al pulsar "Reset Pass", invoca `resendInvitationViaFunction`. Si la función responde `sent: true`, notifica éxito. Si responde `sent: false`, el cliente ejecuta `await authModule.sendPasswordSetupEmail(fb, targetEmail)`.
7. **Formularios de Login y Recuperación ([index.html:22–48](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html#L22-L48)):**
   - El formulario `#login-screen` solo posee campos de correo y contraseña. **No dispone de hipervínculo de recuperación («¿Olvidaste tu contraseña?») ni formulario de solicitud de reseteo para autoservicio**.
   - El formulario `#setup-screen` contiene la lógica legada obsoleta `processFirstTimeSetup` en `app_core.js` que intentaba guardar contraseñas en texto plano en Firestore.

### 2.2 Distinción Técnica Fundamental entre Operaciones

Es mandatorio para la arquitectura distinguir con exactitud los 4 conceptos que a menudo se confunden en la operación diaria:

```mermaid
flowchart TD
    subgraph S1 ["1. Generación de Enlace (Admin SDK)"]
        A1["Cloud Function: generatePasswordResetLink()"] -->|Genera string con oobCode| A2["Enlace Criptográfico en Memoria"]
        A2 -->|NO envía correo| A3["Buzón Externo INTACTO"]
    end

    subgraph S2 ["2. Envío Nativo (Client SDK / REST API)"]
        B1["sendPasswordResetEmail() / accounts:sendOobCode"] -->|HTTPS POST| B2["Google Identity Toolkit"]
    end

    subgraph S3 ["3. Aceptación de Solicitud (HTTP 200)"]
        B2 -->|Valida API Key y formato| C1["Promise Resolved (HTTP 200 OK)"]
        C1 -->|Encolado en cola interna de Google| C2["Estado: Solicitud Aceptada"]
        C2 -->|NO garantiza entrega final| C3["Buzón aún no contactado"]
    end

    subgraph S4 ["4. Entrega Efectiva al Buzón"]
        C2 -->|Google Mailer SMTP Transfer| D1["Servidor MX de Destino"]
        D1 -->|Filtro Antispam / SPF / DKIM| D2{"¿Aceptado?"}
        D2 -->|Sí| D3["Bandeja de Entrada (Inbox)"]
        D2 -->|DMARC Fail| D4["Carpeta de Spam o Rechazado (Bounce)"]
    end
```

1. **Generación de enlace mediante Admin SDK (`generatePasswordResetLink`):**
   - Se ejecuta en el entorno seguro de Cloud Functions.
   - Crea un token de un solo uso (`oobCode`) y devuelve una URL válida.
   - **No envía ningún paquete SMTP ni contacta servidores de correo**.
2. **Envío nativo mediante Firebase Client SDK (`sendPasswordResetEmail`):**
   - Se ejecuta típicamente en el navegador del usuario (o mediante llamada REST a la API de Identity Toolkit).
   - Solicita a Google que genere el enlace y despache el correo utilizando la infraestructura de correo de Google.
3. **Aceptación de la solicitud de envío:**
   - Ocurre cuando la API de Google Identity Toolkit responde exitosamente (`HTTP 200`).
   - La Promise de JavaScript se resuelve.
   - **Garantía:** Google recibió el requerimiento y lo colocó en su cola de envío interna.
   - **Limitación:** No garantiza que el correo haya salido de los servidores de Google ni que haya superado los filtros de red.
4. **Entrega efectiva al buzón:**
   - Ocurre cuando el servidor de correo del destinatario (e.g. Gmail, Microsoft 365 de Ductsal) recibe los paquetes SMTP, valida firmas criptográficas (SPF/DKIM) y deposita el correo en el buzón.
   - **Firebase Authentication NO proporciona webhooks ni avisos de confirmación de entrega o rebote (bounce)**. La aplicación cliente/servidor permanece ciega ante rechazos posteriores a la aceptación de Google.

---

## 3. Compatibilidad de Enlaces de Acción (`ActionCodeSettings`)

### 3.1 Análisis de la Configuración Actual
En [functions/invitationService.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js#L11-L14):
```javascript
const ACTION_CODE_SETTINGS = Object.freeze({
  url: 'https://erp.ductsal.com/login?mode=activate',
  handleCodeInApp: false
});
```

### 3.2 Comportamiento según el Modo de Enlace

#### Opción A: Controlador Estándar de Firebase (`handleCodeInApp: false`) — **RECOMENDADO PARA CORREO NATIVO**
- **Estructura del enlace enviado:**  
  `https://ductsal-erp.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=...&apiKey=...&continueUrl=https://erp.ductsal.com/login?mode=activate&lang=es`
- **Flujo operativo:**
  1. El usuario hace clic en el enlace dentro de su correo.
  2. Su navegador abre la página predeterminada alojada en Google Firebase (`/__/auth/action`).
  3. Google renderiza un formulario seguro y limpio para escribir la nueva contraseña (localizado en español si se configuró `lang=es`).
  4. Google ejecuta directamente la mutación en Firebase Auth.
  5. Google muestra pantalla de confirmación exitosa con un botón para continuar hacia `continueUrl` (`https://erp.ductsal.com/login?mode=activate`).
  6. El usuario es redirigido a DUCTSAL ERP, donde inicia sesión normalmente.
- **Compatibilidad:** 100% compatible sin requerir modificaciones en el frontend de DUCTSAL ERP ni manipulación manual de tokens en el navegador.

#### Opción B: Controlador Personalizado en DUCTSAL ERP (`handleCodeInApp: true`)
- **Estructura del enlace:** Requiere Firebase Dynamic Links o configuración avanzada de dominio para redirigir directamente los parámetros a `https://erp.ductsal.com/login?mode=activate&oobCode=...`.
- **Requerimientos en Frontend:** DUCTSAL ERP debe interceptar la URL al cargar la página, extraer `oobCode`, validar el código con `firebase.auth().verifyPasswordResetCode(code)`, abrir un modal personalizado de restablecimiento, y ejecutar `firebase.auth().confirmPasswordReset(code, newPassword)`.
- **Evaluación:** Aunque permite mantener la estética corporativa (oro/marino) durante la escritura de la clave, **agrega complejidad innecesaria para una solución exclusivamente nativa** y depende de componentes previstos para los Pasos 6.4 y 6.5.

---

## 4. Dominio Corporativo y Configuración DNS

Si se utiliza el servicio nativo de Firebase Authentication sin configurar un dominio personalizado, los correos saldrán desde:  
`noreply@ductsal-erp.firebaseapp.com`

Para que los correos salgan desde un remitente corporativo (e.g. `noreply@ductsal.com` o `notificaciones@auth.ductsal.com`), Firebase Authentication permite personalizar el dominio del remitente en Firebase Console.

### 4.1 Registros DNS Requeridos por Firebase Authentication
Al solicitar la personalización de dominio en Firebase Console (*Authentication > Templates > Customize domain*), Google genera registros específicos que deben agregarse en el proveedor DNS del dominio:

1. **Registro TXT de Validación de Propiedad:**  
   - `google-site-verification=...` o token de Firebase.
2. **Registros CNAME para DKIM (DomainKeys Identified Mail):**  
   - Dos registros CNAME generados por Google (e.g. `firebase1._domainkey.ductsal.com` y `firebase2._domainkey.ductsal.com`) apuntando a los servidores de claves públicas de Google.
3. **Registro TXT para SPF (Sender Policy Framework):**  
   - Directiva que autoriza a los servidores de Google/Firebase a emitir correos en nombre del dominio.

### 4.2 Análisis de Riesgos Severos para el Correo Corporativo Existente

> [!CAUTION]
> **ALERTA CRÍTICA DE INTERFERENCIA CON EL CORREO CORPORATIVO ACTIVO:**  
> La empresa DUCTSAL posee cuentas de correo corporativo reales en uso cotidiano (`dgonzalez@ductsal.com`, `aayala@ductsal.com`, `rflores@ductsal.com`), operadas muy probablemente a través de Google Workspace o Microsoft 365.  
> Modificar indebidamente los registros DNS del dominio raíz `ductsal.com` conlleva los siguientes peligros catastróficos:
>
> 1. **Sobreescritura del Registro SPF (Invalidez Global):**  
>    Un dominio solo puede tener **un único registro TXT de SPF** (RFC 7208 §3.2). Si se agrega un segundo registro SPF para Firebase o si se sobreescribe el actual, los servidores de correo de todo el mundo clasificarán **todos los correos ordinarios de DUCTSAL como fallidos o fraudulentos**, enviándolos a Spam o rebotándolos.
> 2. **Riesgo en Registros MX:**  
>    Firebase Authentication **nunca debe asociarse a registros MX**, ya que solo emite correos y no recibe mensajes. Modificar registros MX interrumpiría la recepción de correos corporativos en toda la empresa.
> 3. **Alineación DMARC:**  
>    Si el dominio `ductsal.com` posee una política DMARC estricta (`p=reject` o `p=quarantine`), cualquier desalineación entre el encabezado `From:` y las firmas SPF/DKIM de Firebase bloqueará los correos de activación.

### 4.3 Recomendación Arquitectónica de Dominio: Subdominio Aislado
Para erradicar cualquier riesgo sobre la operación de la empresa, **se recomienda enfáticamente configurar un subdominio dedicado** para las notificaciones del ERP:
- **Subdominio recomendado:** `auth.ductsal.com` o `notificaciones.ductsal.com`.
- **Dirección del remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>`.
- **Ventaja de aislamiento:** Los registros SPF, DKIM y DMARC de `auth.ductsal.com` son completamente independientes del dominio raíz `ductsal.com`. Un error o cambio en el subdominio jamás afectará la comunicación por correo de los directivos y empleados.

---

## 5. Matriz de Flujos del Sistema

A continuación se detalla cómo opera cada caso bajo la arquitectura nativa de Firebase Authentication:

| Caso de Uso | Responsabilidad Cloud Functions | Responsabilidad Firebase Auth | Responsabilidad Frontend (ERP) |
| :--- | :--- | :--- | :--- |
| **1. Creación de Usuario** | `createUserAdmin`: Crea usuario Auth, perfil en Firestore, registra operación idempotente. | Encola y envía el correo nativo de reseteo (`sendPasswordResetEmail`). | Invoca `createUserAdmin`. Si la Cloud Function no envía correo directamente, el frontend invoca `sendPasswordResetEmail(email, settings)`. |
| **2. Reenvío de Invitación** | `resendInvitationAdmin`: Verifica perfil activo y vinculado, actualiza contadores `preparedCount`/`sentCount`. | Procesa la petición y emite correo nativo con nuevo token. | Invoca `resendInvitationAdmin`. Ejecuta `sendPasswordResetEmail` y notifica al gerente. |
| **3. Recuperación de Contraseña (Autoservicio)** | *No interviene* (desacoplamiento total para evitar saturar backend). | Valida existencia del usuario y envía correo nativo si la cuenta existe. | Presenta botón «¿Olvidaste tu contraseña?» en `#login-screen`. Invoca `firebase.auth().sendPasswordResetEmail(email, settings)`. |
| **4. Cambio de Correo** | `updateUserAdmin`: Verifica unicidad dual, muta Auth (`updateUser`), actualiza Firestore con rollback. | Actualiza el correo en la cuenta de Auth. | Envía petición administrativa. Notifica que el correo fue actualizado. |
| **5. Verificación de Nuevo Correo** | No obligatoria si es cambio administrativo de gerente. | Si se activa, emite plantilla `verifyBeforeUpdateEmail`. | Puede ofrecer al gerente la opción de emitir enlace de verificación o reenviar invitación. |
| **6. Activación de Cuenta** | Registra la transición `invitation.status = 'activated'` en el primer inicio de sesión verificado. | Aloja la interfaz de cambio de contraseña (`/__/auth/action`) y actualiza las credenciales. | Recibe la redirección en `erp.ductsal.com/login?mode=activate`, muestra saludo de activación y permite el login. |

---

## 6. Arquitectura Recomendada y Cambios de Código Necesarios

Para implementar el correo nativo de Firebase Authentication sin proveedores externos, existen dos arquitecturas posibles:

### Opción 1: Enfoque Híbrido (Cliente Despacha Correo Nativo) — **Recomendado por Simplicidad**
En este enfoque, las Cloud Functions se encargan de la seguridad administrativa (crear identidades, verificar permisos, vincular perfiles), y el cliente web (navegador) invoca el método nativo oficial `firebase.auth().sendPasswordResetEmail()`.

```mermaid
sequenceDiagram
    autonumber
    actor Gerente
    participant CRM as Frontend (crm_auth.js)
    participant CF as Cloud Function (createUserAdmin)
    participant Auth as Firebase Auth SDK / API
    actor NuevoUsuario as Nuevo Usuario (Buzón)

    Gerente->>CRM: Crear usuario (email, nombre, rol)
    CRM->>CF: createUserAdmin({ email, nombre, role, opId })
    CF->>Auth: admin.auth().createUser()
    CF->>CF: Guardar perfil en Firestore
    CF-->>CRM: { uid, id, status: 'created' }
    CRM->>Auth: auth.languageCode = 'es'
    CRM->>Auth: auth.sendPasswordResetEmail(email, ACTION_CODE_SETTINGS)
    Auth-->>CRM: Promise resolved (Solicitud aceptada)
    CRM-->>Gerente: "Usuario creado. Correo de activación enviado."
    Auth->>NuevoUsuario: Envío de correo nativo oficial
```

#### Cambios de código requeridos para Opción 1:
1. **Frontend (`crm_auth.js`):**
   - Asegurar `fb.auth().languageCode = 'es'` antes de cada llamada a `sendPasswordResetEmail`.
   - Incorporar `ACTION_CODE_SETTINGS` en `sendPasswordResetEmail(email, ACTION_CODE_SETTINGS)`.
   - Manejo explícito del error `auth/too-many-requests` informando al gerente que debe pausar los envíos.
2. **Frontend (`index.html` y `app_core.js`):**
   - Incorporar enlace «¿Olvidaste tu contraseña?» en `#login-screen`.
   - Crear modal de solicitud de reseteo para autoservicio de usuarios.
   - Retirar o sanear el código obsoleto de `#setup-screen` (`processFirstTimeSetup`).
3. **Backend (`functions/index.js` y `functions/invitationService.js`):**
   - Actualizar el contrato para que `resendInvitationAdmin` declare `{ sent: false, delivery: 'client_native' }`.
   - Documentar que el servidor delega el envío nativo al cliente.

---

### Opción 2: Enfoque Servidor Nativo (Cloud Functions vía Identity Toolkit REST API)
En este enfoque, la Cloud Function no solo crea el perfil, sino que implementa un nuevo driver en `invitationService.js` (`NativeIdentityToolkitDriver`) que realiza una petición HTTP POST a:
`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=API_KEY`
con el payload:
```json
{
  "requestType": "PASSWORD_RESET",
  "email": "usuario@ductsal.com",
  "continueUrl": "https://erp.ductsal.com/login?mode=activate"
}
```

#### Evaluación de Opción 2:
- **Ventaja:** Elimina la dependencia del navegador del gerente; el servidor dispara el correo nativo directamente.
- **Desventaja:** Requiere exponer o inyectar la Web API Key en Cloud Functions y realizar llamadas HTTP externas desde Node.js, lo cual sigue sujeto a las mismas cuotas y limitaciones de diseño de Firebase Auth.

---

## 7. Riesgos y Limitaciones del Envío Nativo de Firebase

| Factor de Riesgo / Limitación | Nivel de Severidad | Causa Técnica | Impacto en DUCTSAL ERP |
| :--- | :---: | :--- | :--- |
| **Cero Visibilidad de Entregabilidad** | **ALTO** | Firebase Auth no provee webhooks ni estados de rebote o spam. | Si un correo de activación es rechazado por el servidor de destino, el sistema nunca lo sabrá; el estado figurará falsamente como completado. |
| **Plantillas Rígidas sin Identidad Visual** | **MEDIO** | Firebase Console no admite HTML personalizado, CSS corporativo, botones estilizados ni logotipos en plantillas nativas. | El correo carece de la marca DUCTSAL (colores oro/marino, logo hexagonal), proyectando una apariencia genérica. |
| **Bloqueo por Rate Limiting (`too-many-requests`)** | **MEDIO** | Google limita drásticamente las solicitudes repetidas desde una misma IP o hacia un mismo buzón. | Un gerente que dé de alta varios empleados consecutivamente quedará bloqueado temporalmente por IP. |
| **Cuota Global de Envíos** | **MEDIO** | Proyectos estándar poseen un límite diario de correos de autenticación (100/día en plan Spark). | Riesgo de suspensión temporal de envíos si se realizan pruebas masivas o reenvíos intensivos. |
| **Dependencia de Conexión del Gerente (en Opción 1)** | **MEDIO** | Si el gerente cierra su laptop antes de que el cliente ejecute `sendPasswordResetEmail`, el usuario queda creado pero sin correo. | El usuario requiere que el gerente use posteriormente "Reset Pass". |

---

## 8. Plan de Implementación por Etapas (Paso 6.3)

Si la dirección técnica autoriza la adopción de correo nativo de Firebase Authentication, se recomienda ejecutar el siguiente plan por fases ordenadas:

```mermaid
gantt
    title Plan de Implementación Paso 6.3 — Correo Nativo Firebase
    dateFormat  X
    axisFormat %d
    section Fase 1
    Inspección y Configuración en Firebase Console :0, 2
    section Fase 2
    Configuración DNS de Subdominio (auth.ductsal.com) :2, 4
    section Fase 3
    Ajustes en Cloud Functions y Contratos :4, 6
    section Fase 4
    Ajustes en Frontend (Idioma, ActionCodeSettings, Modal Recuperación) :6, 9
    section Fase 5
    Pruebas en Emulador y Verificación de No-Regresión :9, 11
```

1. **Fase 1: Configuración en Firebase Console (Sin cambios de código):**
   - Acceder a Firebase Console del proyecto `ductsal-erp`.
   - Verificar y configurar plantilla de *Password Reset* con redacción profesional en español.
   - Verificar lista de *Authorized Domains* e incluir formalmente `erp.ductsal.com`.
2. **Fase 2: Configuración DNS de Subdominio Aislado:**
   - Tramitar en el registrador DNS de `ductsal.com` los registros TXT y CNAME para `auth.ductsal.com`.
   - Validar que el registro SPF raíz no sufra ninguna alteración.
3. **Fase 3: Ajustes de Contratos en Backend:**
   - Adaptar `functions/invitationService.js` para documentar la semántica de entrega nativa.
   - Mantener las suites de pruebas pasando al 100%.
4. **Fase 4: Adaptación del Frontend (Paso 6.3 UI):**
   - Fijar `languageCode = 'es'` en `crm_auth.js`.
   - Pasar `ACTION_CODE_SETTINGS` a `sendPasswordResetEmail`.
   - Añadir botón de autoservicio «¿Olvidaste tu contraseña?» en la pantalla de acceso.
5. **Fase 5: Validación Controlada:**
   - Ejecutar pruebas en el emulador local de Firebase Auth capturando los códigos OOB sin enviar tráfico externo.
   - Validar las 85 suites de pruebas automáticas.

---

## 9. Dictamen Técnico Final

# **VIABLE CON LIMITACIONES**

### Fundamentación Técnica:
1. **Viabilidad Confirmada:**
   Es técnicamente **completamente viable** utilizar el mecanismo nativo de Firebase Authentication (`sendPasswordResetEmail` junto con `ActionCodeSettings`) para invitar usuarios, enviar enlaces de activación y permitir la recuperación de contraseñas, **sin incorporar proveedores externos (Resend o SendGrid)**.
2. **Limitaciones Operativas y Estéticas Asumidas:**
   - Los correos no contarán con diseño HTML corporativo avanzado (logo, tipografía, paleta de colores).
   - No habrá telemetría de entrega efectiva (rebotes, aperturas o recepción en inbox).
   - Se debe aceptar el rate limiting nativo de Firebase (`auth/too-many-requests`) ante reintentos consecutivos.
   - Para no poner en riesgo el correo corporativo ordinario de la empresa, es indispensable que la personalización del remitente se realice **exclusivamente mediante un subdominio aislado (`auth.ductsal.com`)**, evitando cualquier manipulación del SPF raíz de `ductsal.com`.

---
*Fin del Informe de Auditoría Técnica Paso 6.3.1.*
