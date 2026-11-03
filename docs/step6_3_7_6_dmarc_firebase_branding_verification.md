# FASE 6.3.7.6 — INVESTIGACIÓN DEFINITIVA: RESOLUCIÓN DE `%APP_NAME%` EN FIREBASE AUTHENTICATION

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026 (21:20 CST / 03:20 UTC del 3 de Noviembre)  
**Documento:** Informe Técnico de Cierre de Investigación de Identidad de Marca (%APP_NAME%) y Estado DMARC  
**Estado:** **INVESTIGACIÓN DE LECTURA CONCLUIDA — CERO CAMBIOS EJECUTADOS**  
**Dictamen Técnico Definitivo:** **NO EXISTE VÍA SOPORTADA SIN HABILITAR GOOGLE SIGN-IN. SE RECOMIENDA MANTENER LA CONFIGURACIÓN ACTUAL.**  

---

## 1. Resumen Ejecutivo y Configuración Real Encontrada

A través de inspecciones de solo lectura contra las APIs oficiales de Google Cloud Platform y Firebase (`identitytoolkit.googleapis.com`, `firebase.googleapis.com` y `firebasehosting.googleapis.com`), se constató el estado real del proyecto:

| Parámetro | Valor Comprobado en Backend | Observación Técnica |
| :--- | :--- | :--- |
| **Project ID** | `ductsal-erp` | Identificador técnico inmutable asignado por Google Cloud. |
| **Project Number** | `948658286825` | Identificador numérico canónico de GCP. |
| **Project Display Name** | `DUCTSAL ERP` | Configurado como `DUCTSAL ERP` a nivel de proyecto Firebase (`v1beta1/projects/ductsal-erp`). |
| **Sitio predeterminado de Hosting** | `projects/ductsal-erp/sites/ductsal-erp` | URL por defecto: `https://ductsal-erp.web.app` (ID de sitio: `ductsal-erp`). |
| **Dominio personalizado de envío** | `auth.ductsal.com` | Activo y persistido en `notification.sendEmail.dnsInfo`. |
| **Remitente visible configurado** | `DUCTSAL ERP <noreply@auth.ductsal.com>` | Almacenado en `senderDisplayName: "DUCTSAL ERP"` y `senderLocalPart: "noreply"`. |
| **Reply-To configurado** | `informatica@grupogama.com` | Almacenado en `replyTo: "informatica@grupogama.com"`. |
| **Proveedores de autenticación** | **Exclusivamente Email/Password** | `defaultSupportedIdpConfigs` está vacío `{}`. Google Sign-In está deshabilitado. |
| **Consulta a IAP Brands API** | `403 PERMISSION_DENIED / SERVICE_DISABLED` | La API de Cloud Identity-Aware Proxy no está habilitada en el proyecto; no es un mecanismo aplicable a Firebase Auth. |
| **Modificación de plantillas** | **Bloqueada por Google Cloud** | La consola muestra *«Por el momento, no se pueden actualizar las plantillas de correo electrónico de este proyecto»* y la API devuelve `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`. |
| **Registro DMARC en DNS** | `v=DMARC1; p=none; sp=none; aspf=r; adkim=r` | **Publicado y verificado en DNS** en `_dmarc.auth.ductsal.com`. |

---

## 2. Origen Arquitectónico de `%APP_NAME%` y Mecanismos Documentados

### 2.1 Qué representa y cómo resuelve `%APP_NAME%`
Conforme a la documentación oficial y la FAQ de Firebase Authentication:
1. `%APP_NAME%` es un token reservado de interpolación dinámica en las plantillas nativas de correo de Identity Platform (`resetPasswordTemplate`, `verifyEmailTemplate`, `changeEmailTemplate`).
2. **`displayName` del proyecto NO alimenta `%APP_NAME%`:**  
   El campo `displayName` (`"DUCTSAL ERP"`) es un metadato de administración interna visible en las consolas de desarrollo (Firebase Console / GCP Console). El motor de correo transaccional de Firebase **no utiliza este campo para las plantillas**.
3. **Rol de la Marca OAuth en Firebase:**  
   La documentación de Firebase indica que `%APP_NAME%` busca resolver prioritariamente la marca OAuth / *Public-facing name* del proyecto, la cual se provisiona y vincula a Firebase Authentication cuando se habilita un proveedor federado como Google Sign-In.
4. **Comportamiento documentado sin marca OAuth (Resolución vía Hosting predeterminado):**  
   Respaldado por la FAQ oficial de soporte de Firebase, **cuando no existe una marca OAuth reconocida o vinculada a Firebase Authentication** (como sucede en aplicaciones web configuradas exclusivamente con Email/Password), el sistema recurre por diseño al **nombre del sitio predeterminado de Firebase Hosting (`ductsal-erp.web.app` / `ductsal-erp`)** como valor de respaldo para sustituir `%APP_NAME%`.
5. Por esta razón técnica documentada, en el primer envío real de prueba el correo mostró el asunto:  
   `Cambia la contraseña de ductsal-erp`.

---

## 3. Comprobaciones Específicas Requeridas

### 3.1 Comprobación 1: Estado de OAuth Brand y Clarificación de la API de IAP
* **Resultado de la consulta:** La consulta a `iap.googleapis.com/v1/projects/948658286825/brands` devolvió `403 PERMISSION_DENIED / SERVICE_DISABLED` debido a que la API de Cloud Identity-Aware Proxy no está habilitada en el proyecto `ductsal-erp`.
* **Aclaración técnica rigurosa:** Este error `403 SERVICE_DISABLED` indica únicamente que el servicio IAP no está habilitado, lo cual **no demuestra ni desmiente la existencia de configuraciones OAuth en otras capas de GCP**.  
  Por tanto, **no se debe presentar IAP Brands como equivalente a la marca o identidad de Firebase Authentication**. En proyectos web con solo Email/Password, Firebase Authentication no mantiene un enlace activo hacia marcas OAuth externas.

### 3.2 Comprobación 2: Configuración actual de proveedores de autenticación
* La llamada de solo lectura a `identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/defaultSupportedIdpConfigs` devuelve `{}` (código 200).
* Se confirma que **Google Sign-In está deshabilitado**, no existen proveedores federados adicionales y el proyecto opera estrictamente con `Email/Password`.

### 3.3 Comprobación 3: ¿Existe alguna propiedad en Firebase Auth para definir el nombre de marca sin `googleSignIn`?
* Se auditó el esquema formal completo de `GoogleCloudIdentitytoolkitAdminV2Config` (`projects/*/config`).
* Los campos existentes son: `name`, `signIn`, `notification`, `quota`, `monitoring`, `multiTenant`, `authorizedDomains`, `subtype`, `client`, `mfa`, `blockingFunctions`, `recaptchaConfig`, `smsRegionConfig`, `autodeleteAnonymousUsers`, `passwordPolicyConfig`, `emailPrivacyConfig`, `mobileLinksConfig` y `defaultHostingSite` (output only).
* **Resultado:** **NO existe ningún campo en la API de Firebase Authentication ni en Identity Platform que permita definir un "brand name" o "public-facing name" de forma independiente sin un IdP.** El único campo textual configurable es `senderDisplayName`, que ya está asignado a `"DUCTSAL ERP"` (controlando el nombre amigable del remitente).

### 3.4 Comprobación 4: Crear una marca en Google Cloud Console vs. Reconocimiento en Firebase Auth
* La pantalla de consentimiento OAuth en Google Cloud Console (`console.cloud.google.com/apis/credentials/consent`) gestiona autorizaciones para APIs de GCP.
* Sin embargo, la documentación oficial y el comportamiento de la plataforma confirman que **Firebase Authentication no enlaza su motor interno de plantillas a una pantalla de consentimiento de GCP a menos que el proveedor de Google esté activo en Firebase Auth**. Para proyectos que operan exclusivamente con `Email/Password`, Firebase Auth no consulta el Consent Screen externo de GCP, manteniendo la resolución a través del sitio predeterminado de Hosting.

### 3.5 Comprobación 5: Inmutabilidad del sitio predeterminado de Firebase Hosting
* **Documentación oficial de Firebase Hosting:**  
  > *«Once the default Firebase Hosting site has been created for your project, you cannot change its site ID/name or delete it.»*  
  *(Una vez creado el sitio predeterminado de Firebase Hosting para el proyecto, no es posible cambiar su ID/nombre ni eliminarlo).*
* El ID del sitio predeterminado es permanentemente `ductsal-erp`. No es viable renombrarlo ni sustituirlo en la infraestructura base del proyecto.

---

## 4. Estado de los Registros DNS (SPF, DKIM y DMARC)

Es fundamental mantener una distinción rigurosa entre la **publicación de registros DNS** y la **evaluación final de autenticación en buzón**:

1. **Registros DNS Publicados y Verificados en Red:**
   * **SPF:** Registro TXT activo en `auth.ductsal.com`: `v=spf1 include:_spf.firebasemail.com ~all`.
   * **DKIM:** Selectores CNAME `firebase1` y `firebase2` apuntando a `firebasemail.com`.
   * **DMARC:** Registro TXT publicado y propagado en `_dmarc.auth.ductsal.com`: `v=DMARC1; p=none; sp=none; aspf=r; adkim=r`.
   * **Aislamiento comprobado:** El dominio raíz `ductsal.com` y los registros de Microsoft 365 permanecen intactos sin cambios.
2. **Criterio de Evaluación de Autenticación (`PASS` y Alineación):**
   * Aunque los registros DNS requeridos están publicados de forma correcta y completa, **no se declara `PASS` definitivo ni alineación consumada hasta inspeccionar los encabezados RFC 822 originales (`Authentication-Results`) de un correo real recibido en el buzón**.
3. **Alcance Real de la Política `p=none`:**
   * La política `p=none` es de **observación y monitoreo pasivo**: indica que el dominio está supervisado pero no solicita que los mensajes sean rechazados ni enviados a cuarentena.
   * **Aclaración rigurosa:** La presencia del registro DMARC `p=none` **no garantiza la entregabilidad ni asegura la llegada a la Bandeja de Entrada (Inbox)**, ya que los motores de filtrado antispam (como Microsoft Defender / Exchange Online Protection) combinan la autenticación técnica con la reputación acumulada del dominio emisor, el volumen de envíos y el contenido del mensaje.

---

## 5. Dictamen Final y Conclusiones Operativas

```
================================================================================
                    DICTAMEN TÉCNICO DEFINITIVO
================================================================================
¿Existe algún mecanismo oficialmente soportado por Firebase Authentication para 
que %APP_NAME% resuelva a "DUCTSAL ERP", sin habilitar Google Sign-In, sin cambiar 
el sitio de Hosting y utilizando las plantillas nativas?

                         >>> NO EXISTE <<<

1. El campo displayName ("DUCTSAL ERP") es un metadato interno de desarrollo que 
   el motor de correos de Firebase no lee.
2. Sin una marca OAuth reconocida por Firebase Authentication (lo cual requiere 
   activar Google Sign-In), el sistema recurre al nombre del sitio predeterminado 
   de Hosting (ductsal-erp) para resolver %APP_NAME%.
3. El sitio predeterminado de Hosting es inmutable por diseño de la plataforma.
4. La edición directa del texto de las plantillas para reemplazar %APP_NAME% por 
   "DUCTSAL ERP" está congelada por Google (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED) 
   al tener un dominio personalizado activo.
================================================================================
```

### Conclusiones Operativas Obligatorias:
* **NO habilitar Google Sign-In.**
* **NO modificar el sitio de Firebase Hosting ni su configuración.**
* **NO alterar `authDomain`, dominios autorizados, ActionCodeSettings ni URLs.**
* **NO modificar proveedores de autenticación ni registros DNS adicionales.**

---

## 6. Recomendación Técnica: Mantener la Configuración Actual

En estricta concordancia con la instrucción del usuario:  
> *«Si no existe una vía documentada, declararlo expresamente y recomendar mantener la configuración actual.»*

Se recomienda de forma categórica **MANTENER LA CONFIGURACIÓN ACTUAL** y dejar formalmente documentada la limitación de `%APP_NAME%`:

1. **La identidad corporativa principal ya está establecida:**
   * **Remitente visible:** `DUCTSAL ERP <noreply@auth.ductsal.com>`. En Outlook, Superhuman y cualquier cliente de correo, el nombre mostrado al destinatario es claramente **DUCTSAL ERP**.
   * **Reply-To:** `informatica@grupogama.com`.
   * **Enlaces y flujos:** Conducen de forma segura y directa a `https://erp.ductsal.com/login?mode=activate`.
2. **Impacto exclusivamente cosmético:**
   * El único efecto observable es que el asunto del correo lee `Cambia la contraseña de ductsal-erp` (con el ID del proyecto / sitio predeterminado).
   * Este detalle estético no afecta la seguridad, no compromete la activación de cuentas y no justifica en absoluto encender proveedores de autenticación no deseados ni alterar la arquitectura productiva.
3. **Vía a Futuro (Si se requiriera personalización visual absoluta en fases posteriores):**
   * La única vía limpia documentada para control visual total consiste en generar los enlaces con el Firebase Admin SDK (`generatePasswordResetLink`) y despacharlos mediante Cloud Functions con un motor de correo transaccional propio.

---

## 7. Enlaces a Documentación Oficial de Respaldo

* [Firebase Authentication — Email Action Links and Templates](https://firebase.google.com/docs/auth/admin/email-action-links)
* [Google Cloud Identity Platform — projects.config REST Resource Schema](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/config)
* [Firebase Hosting — Multi-site Management & Default Site Immutability](https://firebase.google.com/docs/hosting/multisites)
* [Google Cloud — OAuth Consent Screen and App Branding Guidelines](https://developers.google.com/workspace/guides/configure-oauth-consent)
* [Firebase Support FAQ — Email Template Customization & Placeholders](https://firebase.google.com/support/faq#auth-email-templates)
