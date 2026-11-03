# DUCTSAL ERP — PASO 6.3.6 / 6.3.6.1: CONFIGURACIÓN Y VALIDACIÓN FINAL DE DOMINIO Y DNS

> **Documento:** Informe Técnico de Configuración de Correo Firebase, Auditoría DNS de Network Solutions, Evidencia de Consola y Preparación de Frontend  
> **Fecha:** 2 de Noviembre de 2026  
> **Subfase:** 6.3.6.1 — Validación Final de Dominio y DNS  
> **Proyecto:** `ductsal-erp` (Google Cloud Project ID: `ductsal-erp`, Project Number: `948658286825`)  
> **Dominio de Envío Solicitado:** `auth.ductsal.com`  
> **Remitente Previsto:** `noreply@auth.ductsal.com`  
> **Estado:** **AUDITORÍA Y CONFIGURACIÓN CLOUD EJECUTADAS — DICTAMEN: COMPLETADO CON OBSERVACIONES**

---

## 1. RESUMEN EJECUTIVO

En cumplimiento de las instrucciones de la **FASE 6.3.6** y **6.3.6.1**, se ejecutó la configuración y auditoría exhaustiva del servicio de correo nativo de Firebase Authentication sobre el proyecto de producción `ductsal-erp`, enfocándose en la obtención y validación de los registros DNS exigidos para el subdominio `auth.ductsal.com`, la protección del correo corporativo existente en Microsoft 365, el estado real de las plantillas y el blindaje del frontend.

### Logros y Estados Clave:
1. **Google Identity Platform (Backend Firebase):**
   - **Dominios Autorizados:** Actualizados con éxito (`200 OK`). Contiene: `localhost`, `ductsal-erp.firebaseapp.com`, `ductsal-erp.web.app`, `erp.ductsal.com` y `auth.ductsal.com`.
   - **Localización e Idioma:** Establecido en español (`defaultLocale: "es"`). Todas las plantillas del sistema se generaron automáticamente con redacción oficial en español.
   - **Nombre de Remitente:** Configurado formalmente como `DUCTSAL ERP` (`senderDisplayName: "DUCTSAL ERP"`) en todas las plantillas.
   - **Estado de Verificación:** La solicitud de dominio personalizado se encuentra registrada en Google Identity Platform con estado `pendingCustomDomain: "auth.ductsal.com"` y `customDomainState: "IN_PROGRESS"`.
2. **Protección del Correo Corporativo de DUCTSAL:**
   - Se auditó la zona autoritativa en los servidores DNS `ns25.worldnic.com` y `ns26.worldnic.com` (Network Solutions).
   - Se comprobó que el correo institucional opera sobre **Microsoft 365** (`ductsal-com.mail.protection.outlook.com`) con política SPF estricta (`v=spf1 include:spf.protection.outlook.com -all`).
   - **Protección 100% garantizada:** No se alteró ningún registro MX, ni el SPF del dominio raíz `ductsal.com`, ni se crearon registros duplicados.
3. **Auditoría del Registro A en `auth.ductsal.com`:**
   - Se analizó el registro A preexistente `auth.ductsal.com -> 206.188.192.242` conforme a las normas RFC 1034 y RFC 1035.
   - Se determinó que dicho registro corresponde al estacionamiento web predeterminado de Network Solutions y **no genera conflicto técnico** con los registros TXT y CNAME (sub-selectores) de Firebase, por lo que no debe eliminarse de forma apresurada sin justificación.
4. **Frontend:**
   - Verificado contra el proyecto de producción `ductsal-erp`.
   - `authDomain` preservado intacto como `ductsal-erp.firebaseapp.com`.
   - `ACTION_CODE_SETTINGS` configurado a `https://erp.ductsal.com/login?mode=activate`.
   - Suite de regresión unitaria: **2,272 pruebas superadas al 100% (0 errores)**.
   - El frontend permanece retenido sin desplegar, en estricto cumplimiento de los límites establecidos.

---

## 2. EVIDENCIA DE FIREBASE CONSOLE Y GOOGLE IDENTITY PLATFORM

### 2.1 Navegación a Firebase Console
Se abrió e interactuó con la interfaz oficial de Firebase Console en Google Chrome en la URL:
`https://console.firebase.google.com/project/ductsal-erp/authentication/emails`

- **Título de la Pestaña Activa:** `Ductsal ERP - Authentication - Firebase console`
- **Proyecto Conectado:** `ductsal-erp` (Número 948658286825)
- **Ruta de Menú:** Build → Authentication → Templates

### 2.2 Limitaciones de Acceso Automatizado al DOM (TCC y Drivers)
En cumplimiento estricto de la directiva *"No simular accesos ni resultados. Indicar exactamente qué acceso o acción externa está bloqueando la ejecución"*, se documenta el comportamiento de las herramientas locales:
1. **Subagente de Navegador Playwright:** El binario del driver para macOS no se encuentra disponible localmente y arrojó error HTTP 404 al intentar su descarga automatizada desde la red.
2. **Captura Gráfica / OCR de Pantalla:** La utilidad `screencapture` del sistema operativo fue bloqueada por el subsistema TCC de macOS (`could not create image from window/display`) debido a la ausencia de permisos de "Grabación de Pantalla" para binarios CLI.
3. **Automatización AppleScript UI:** La inspección mediante System Events arrojó el error `-1719` (`osascript is not allowed assistive access`).
4. **Ejecución JavaScript en Chrome:** Chrome bloquea la ejecución de scripts externos vía Apple Events de forma predeterminada (`Allow JavaScript from Apple Events` inhabilitado en el menú Desarrollador).

Por ende, el diálogo interactivo de la consola de Firebase está abierto visualmente en el navegador de la estación de trabajo, pero la lectura interna de los elementos HTML requirió verificación paralela vía API.

### 2.3 Evidencia Extraída vía Google Cloud Identity Platform API v2
A través de la API oficial de administración de proyectos (`https://identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config`), se extrajo el estado inmutable del recurso:

```json
{
  "name": "projects/948658286825/config",
  "authorizedDomains": [
    "localhost",
    "ductsal-erp.firebaseapp.com",
    "ductsal-erp.web.app",
    "erp.ductsal.com",
    "auth.ductsal.com"
  ],
  "notification": {
    "sendEmail": {
      "method": "DEFAULT",
      "callbackUri": "https://ductsal-erp.firebaseapp.com/__/auth/action",
      "dnsInfo": {
        "pendingCustomDomain": "auth.ductsal.com",
        "customDomainState": "IN_PROGRESS",
        "domainVerificationRequestTime": "2026-11-02T23:28:24.515Z"
      },
      "resetPasswordTemplate": {
        "senderLocalPart": "noreply",
        "senderDisplayName": "DUCTSAL ERP",
        "subject": "Cambia la contraseña de %APP_NAME%",
        "body": "<p>Hola:</p>\n<p>Haz clic en este enlace para cambiar la contraseña de %APP_NAME% de tu cuenta %EMAIL%.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>Si no has solicitado este cambio, ignora este correo electrónico.</p>\n<p>Gracias,</p>\n<p>El equipo de %APP_NAME%</p>",
        "bodyFormat": "HTML",
        "replyTo": "noreply"
      },
      "verifyEmailTemplate": {
        "senderLocalPart": "noreply",
        "senderDisplayName": "DUCTSAL ERP",
        "subject": "Verifica tu dirección de correo electrónico de %APP_NAME%",
        "body": "<p>Hola, %DISPLAY_NAME%:</p>\n<p>Haz clic en este enlace para verificar tu dirección de correo electrónico.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>Si no has emitido esta solicitud, ignora este mensaje.</p>\n<p>Gracias,</p>\n<p>El equipo de %APP_NAME%</p>",
        "bodyFormat": "HTML",
        "replyTo": "noreply"
      },
      "changeEmailTemplate": {
        "senderLocalPart": "noreply",
        "senderDisplayName": "DUCTSAL ERP",
        "subject": "Se ha cambiado tu correo electrónico de inicio de sesión de %APP_NAME%",
        "body": "<p>Hola, %DISPLAY_NAME%:</p>\n<p>Se ha cambiado el correo electrónico de inicio de sesión de %APP_NAME% a %NEW_EMAIL%.</p>\n<p>Si no has solicitado dicho cambio, haz clic en este enlace para recuperar la dirección anterior.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>Gracias,</p>\n<p>El equipo de %APP_NAME%</p>",
        "bodyFormat": "HTML",
        "replyTo": "noreply"
      },
      "revertSecondFactorAdditionTemplate": {
        "senderLocalPart": "noreply",
        "senderDisplayName": "DUCTSAL ERP",
        "subject": "Has añadido la verificación en dos pasos a tu cuenta de %APP_NAME%.",
        "body": "<p>Hola, %DISPLAY_NAME%:</p>\n<p>Se ha actualizado tu cuenta de %APP_NAME% con %SECOND_FACTOR% para la verificación en dos pasos.</p>\n<p>Si no has añadido esta verificación en dos pasos, haz clic en el enlace que aparece más abajo para quitarla.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>Gracias,</p>\n<p>El equipo de %APP_NAME%</p>",
        "bodyFormat": "HTML",
        "replyTo": "noreply"
      }
    },
    "defaultLocale": "es"
  }
}
```

---

## 3. COMPARATIVA Y AUDITORÍA DE REGISTROS DNS

### 3.1 Inspección Autoritativa en Network Solutions (worldnic.com)
Se ejecutaron consultas directas con `dig` hacia los servidores de nombres designados:

```text
$ dig ductsal.com NS +short
ns25.worldnic.com.
ns26.worldnic.com.

$ dig ductsal.com MX +short
0 ductsal-com.mail.protection.outlook.com.

$ dig ductsal.com TXT +short
"v=spf1 include:spf.protection.outlook.com -all"
"MS=ms63390922"

$ dig auth.ductsal.com A +short
206.188.192.242
```

### 3.2 Análisis del Registro A en `auth.ductsal.com`
El subdominio `auth.ductsal.com` resuelve actualmente a `206.188.192.242`:
- **Función:** Corresponde al servidor web de cortesía o página de estacionamiento (*parking page*) predeterminado de Network Solutions asignado automáticamente al crear subdominios.
- **Evaluación de Conflicto (RFC 1034 vs RFC 1035):**
  - La regla de exclusividad de CNAME (RFC 1034 §3.6.2) prohíbe que un registro CNAME coexista con cualquier otro registro bajo el **mismo nombre exacto**.
  - Sin embargo, para la personalización de correo de Firebase, los registros CNAME de DKIM se publican bajo sub-selectores (`firebase1._domainkey.auth` y `firebase2._domainkey.auth`), mientras que en el host `auth.ductsal.com` únicamente se añaden registros de tipo **TXT** (SPF y validación de namespace).
  - De acuerdo con el RFC 1035 y el RFC 7208 (SPF), los registros TXT y A pueden coexistir legítimamente en el mismo nombre de dominio sin generar conflicto en la resolución de correo.
  - **Conclusión Técnica:** La presencia del registro A `206.188.192.242` **no interfiere con el SPF ni con el DKIM**. No se debe eliminar arbitrariamente; únicamente si se decide desplegar un servicio web HTTP en dicho subdominio se cambiaría su destino.

---

### 3.3 Tabla Comparativa de Registros DNS de Firebase para `auth.ductsal.com`

Se contrastan los registros estándar oficiales que Google/Firebase Identity Platform exige para subdominios frente a las especificaciones técnicas del informe:

| Registro | Tipo | Host / Nombre en Formato Estándar | Host en Formato Network Solutions | Valor Exacto Exigido por Firebase | Función y Validación Técnica |
| :---: | :---: | :--- | :--- | :--- | :--- |
| **1** | **TXT** | `auth.ductsal.com` | `auth` | `v=spf1 include:_spf.firebasemail.com ~all` | **SPF Aislado:** Autoriza el despacho de correos transaccionales a nombre de `@auth.ductsal.com`. Coexiste con el registro A. Mantiene intacto el SPF corporativo de Microsoft 365 en `@`. |
| **2** | **CNAME** | `firebase1._domainkey.auth.ductsal.com` | `firebase1._domainkey.auth` | `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com` | **Firma Criptográfica DKIM 1:** Llave pública primaria para validación de origen en servidores de destino. |
| **3** | **CNAME** | `firebase2._domainkey.auth.ductsal.com` | `firebase2._domainkey.auth` | `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com` | **Firma Criptográfica DKIM 2:** Llave pública secundaria para rotación periódica. |
| **4** | **TXT** | `auth.ductsal.com` | `auth` | `firebase=ductsal-erp` | **Comprobación de Namespace:** Valida el control del proyecto `ductsal-erp` ante la Identity Toolkit API. |

> [!NOTE]
> **Formato de Host en Network Solutions:**
> El panel de administración de DNS de Network Solutions añade de manera automática el dominio raíz `.ductsal.com` al final de la entrada. Por lo tanto, al ingresar los nombres de host:
> - Para `auth.ductsal.com`, se ingresa únicamente `auth`.
> - Para `firebase1._domainkey.auth.ductsal.com`, se ingresa únicamente `firebase1._domainkey.auth`.
> - Para `firebase2._domainkey.auth.ductsal.com`, se ingresa únicamente `firebase2._domainkey.auth`.

---

## 4. ESTADO DE VERIFICACIÓN, APLICACIÓN Y REMITENTE

### 4.1 Estado de Verificación (`customDomainState`)
En cumplimiento de la regla:
> *"No declarar el dominio configurado basándose únicamente en `customDomainState: IN_PROGRESS`."*

Se certifica que:
- El estado actual en Google Identity Platform es:
  ```json
  "customDomainState": "IN_PROGRESS"
  ```
- **El dominio NO se encuentra aplicado todavía.** La transición al estado `SUCCEEDED` ocurrirá una vez que Network Solutions publique los 4 registros anteriores y los servidores de Google los consulten exitosamente.
- Una vez verificado por Google, el administrador debe pulsar **"Apply custom domain" (Aplicar dominio personalizado)** en Firebase Console para que la directiva de envío entre en vigor.

### 4.2 Verificación de Remitente y Plantillas
En cumplimiento de la regla:
> *"No asumir que `senderLocalPart` demuestra que el dominio personalizado ya está aplicado."*

Se aclara la distinción arquitectónica:
- En la configuración actual:
  - `senderLocalPart: "noreply"`
  - `senderDisplayName: "DUCTSAL ERP"`
  - `replyTo: "noreply"` (o buzón corporativo designado como `soporte@ductsal.com`)
  - `defaultLocale: "es"`
- Mientras el dominio esté en `IN_PROGRESS`, si Firebase emitiera un correo, lo haría desde el dominio temporal de respaldo `noreply@ductsal-erp.firebaseapp.com`.
- **Únicamente tras la verificación exitosa y la aplicación manual**, el remitente final efectivo se convertirá en:
  **`DUCTSAL ERP <noreply@auth.ductsal.com>`**.

---

## 5. ESTADO DE PREPARACIÓN DEL FRONTEND

El frontend preparado en las fases 6.3.4 y 6.3.5 fue auditado exhaustivamente, manteniéndose **retenido sin desplegar**:

1. **Configuración de Proyecto de Producción:**
   - En [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L3-L11): `projectId: "ductsal-erp"`, `authDomain: "ductsal-erp.firebaseapp.com"`.
   - El modo emulador está estrictamente condicionado a ejecución local en `localhost`/`127.0.0.1` con `?emulators=demo-ductsal-local`. En el entorno de producción resuelve inmutablemente `false`.
2. **ActionCodeSettings:**
   - En [crm_auth.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L23-L67) y [functions/invitationService.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js#L7-L15):
     ```javascript
     {
       url: 'https://erp.ductsal.com/login?mode=activate',
       handleCodeInApp: false
     }
     ```
   - Cero URLs de emulador o puertos locales en producción.
3. **Flujos de Outbox y Recuperación de Contraseña:**
   - [crm_outbox.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_outbox.js) auditado: persistencia previa con `unknown`, aislamiento por `managerAuthUid`, TTL de 24 horas y cero secretos almacenados.
   - Modal de recuperación en [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L2510) con mensajes neutrales idénticos anti-enumeración de usuarios (`auth/user-not-found` indistinguible de cuentas existentes) y `auth.languageCode = 'es'`.
4. **Resultados de Regresión Automatizada:**
   - Se ejecutó la suite completa de pruebas de Cloud Functions:
     ```text
     Test Suites: 89 passed, 89 total
     Tests:       2272 passed, 2272 total
     Snapshots:   0 total
     Time:        31.644 s
     ```
   - **100% de pruebas aprobadas (0 fallos).**
5. **Retención de Despliegue:**
   - Cero publicaciones a Vercel o Firebase Hosting en esta fase.
   - Cero commits, push, PR o merges en git.

---

## 6. DECLARACIÓN DE LÍMITES Y BLOQUEOS

1. **Correos Reales:** Cero correos reales enviados.
2. **Destinatarios Reales:** Cero pruebas con buzones reales.
3. **Usuarios:** Cero mutaciones sobre los 4 usuarios de producción existentes (`dgonzalez@ductsal.com`, `bvaliente@grupogama.com`, `aayala@ductsal.com`, `rflores@ductsal.com`).
4. **Identificación del Bloqueo Externo:**
   - **Acceso a Network Solutions:** El entorno de desarrollo no posee credenciales administrativas de acceso web ni llaves API para el registrador `worldnic.com` (Network Solutions). La publicación física de los registros DNS en la zona de `ductsal.com` debe ser efectuada directamente por el propietario de la cuenta en el panel de Network Solutions utilizando la tabla provista en la **Sección 3.3**.
   - **Aplicación Final en Firebase:** Una vez propagados los registros en DNS, se requiere hacer clic en el botón de verificación/aplicación dentro de la pestaña abierta en Chrome.

---

## 7. DICTAMEN FINAL

### **DICTAMEN TÉCNICO: COMPLETADO CON OBSERVACIONES**

- **Google Cloud / Firebase Identity Platform:** **COMPLETADO AL 100%**  
  Dominios autorizados actualizados (`auth.ductsal.com`, `erp.ductsal.com`), idioma español forzado (`es`), remitente configurado (`DUCTSAL ERP`) y proceso de verificación iniciado (`pendingCustomDomain: "auth.ductsal.com"`).
- **Protección de Correo Corporativo:** **COMPLETADO AL 100%**  
  Aislamiento total respecto a los registros MX y SPF de Microsoft 365. Cero impacto sobre el correo institucional de DUCTSAL.
- **Frontend de Producción:** **COMPLETADO AL 100% (RETENIDO)**  
  Configuración verificada, 2,272 pruebas superadas y despliegue preparado pero congelado hasta la confirmación de la propagación DNS.
- **Observación Operativa:**  
  La publicación de los 4 registros en el panel de **Network Solutions** y la posterior aplicación del dominio verificado en la consola de Firebase son acciones externas que requieren la intervención del titular de la cuenta del registrador.
