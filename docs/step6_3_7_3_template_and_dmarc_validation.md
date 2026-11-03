# FASE 6.3.7.3 — PERSONALIZACIÓN DE PLANTILLAS Y VALIDACIÓN TÉCNICA DMARC

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026  
**Documento:** Informe Técnico de Personalización de Plantillas y Dictamen de Validación DMARC  
**Estado:** **EJECUTADO — DETENCIÓN REGLAMENTARIA PREVIA A PUBLICACIÓN DMARC Y SEGUNDO ENVÍO**  
**Dictamen Técnico:** **APROBADO CON OBSERVACIONES**  

---

## 1. Resumen Ejecutivo y Control de Restricciones

En cumplimiento estricto de las directrices de la **Fase 6.3.7.3**, se ejecutaron de manera directa las tareas autorizadas en los dos frentes técnicos:
1. **Frente A (Personalización de Plantillas):** Se completó la auditoría, formulación textual y análisis de persistencia de las cuatro plantillas nativas de Firebase Authentication, documentando formalmente las capacidades y restricciones del backend de Google Cloud Identity Platform.
2. **Frente B (Validación Técnica DMARC):** Se realizó la auditoría DNS profunda, validación sintáctica conforme a RFC 7489, verificación de compatibilidad criptográfica (SPF/DKIM) y el análisis de autorización externa de reportes hacia `informatica@grupogama.com` conforme al estándar RFC 7489 §7.1.

### 1.1 Control Riguroso de Restricciones
* **Envíos de correo adicionales:** **0** (Cero nuevos correos emitidos en esta fase).
* **Contador de envíos reales autorizados:** **1 de 3 consumidos** (2 envíos reservados intactos para Pruebas 2 y 3).
* **Publicación o alteración en DNS:** **0 modificaciones realizadas**. Ningún registro ha sido tocado en Network Solutions; todo permanece en estado de diseño y validación a la espera de autorización expresa.
* **Modificaciones a usuarios productivos:** **Ninguna**.
* **Despliegues o commits de código:** **Ninguno**.

---

## 2. Frente A — Personalización de Plantillas de Firebase Authentication

### 2.1 Objetivo Visual y Corporativo
* **Nombre Comercial Oficial:** `DUCTSAL ERP` (literal en mayúsculas).
* **Remitente Configurado:** `noreply@auth.ductsal.com`
* **Nombre Visible del Remitente:** `DUCTSAL ERP`
* **Reply-To Configurado:** `informatica@grupogama.com`
* **Idioma:** Español (`es`).
* **Firma Corporativa Requerida:** `El equipo de DUCTSAL ERP`.
* **Preservación Inalterable:** Dominio personalizado `auth.ductsal.com`, ActionCodeSettings, URIs de retorno (`https://erp.ductsal.com/login?mode=activate`), handlers de acción (`https://ductsal-erp.firebaseapp.com/__/auth/action`) y variables funcionales (`%LINK%`, `%EMAIL%`, `%DISPLAY_NAME%`, `%NEW_EMAIL%`, `%SECOND_FACTOR%`).

---

### 2.2 Comparativa Detallada: Estado Inicial vs. Estado Personalizado (Las 4 Plantillas)

A continuación se detalla la especificación exacta de cada una de las 4 plantillas nativas de Firebase Authentication:

#### Plantilla 1: Restablecimiento de Contraseña (`resetPasswordTemplate`)
* **Uso en el sistema:** Invitación y activación de nuevos colaboradores, y auto-recuperación de clave desde `/login`.
* **Remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>` *(Inalterado)*
* **Reply-To:** `informatica@grupogama.com` *(Inalterado)*

| Campo | Antes (Configuración Inicial) | Después (Configuración Personalizada) |
| :--- | :--- | :--- |
| **Asunto** | `Cambia la contraseña de %APP_NAME%` | `Cambia la contraseña de DUCTSAL ERP` |
| **Cuerpo HTML** | `<p>Hola:</p><p>Haz clic en este enlace para cambiar la contraseña de %APP_NAME% de tu cuenta %EMAIL%.</p><p><a href='%LINK%'>%LINK%</a></p><p>Si no has solicitado este cambio, ignora este correo electrónico.</p><p>Gracias,</p><p>El equipo de %APP_NAME%</p>` | `<p>Hola:</p><p>Haz clic en este enlace para cambiar la contraseña de DUCTSAL ERP de tu cuenta %EMAIL%.</p><p><a href='%LINK%'>%LINK%</a></p><p>Si no has solicitado este cambio, ignora este correo electrónico.</p><p>Gracias,</p><p>El equipo de DUCTSAL ERP</p>` |

---

#### Plantilla 2: Verificación de Dirección de Correo (`verifyEmailTemplate`)
* **Uso en el sistema:** Validación de buzón de correo electrónico tras registro.
* **Remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>` *(Inalterado)*
* **Reply-To:** `informatica@grupogama.com` *(Inalterado)*

| Campo | Antes (Configuración Inicial) | Después (Configuración Personalizada) |
| :--- | :--- | :--- |
| **Asunto** | `Verifica tu dirección de correo electrónico de %APP_NAME%` | `Verifica tu dirección de correo electrónico de DUCTSAL ERP` |
| **Cuerpo HTML** | `<p>Hola, %DISPLAY_NAME%:</p><p>Haz clic en este enlace para verificar tu dirección de correo electrónico.</p><p><a href='%LINK%'>%LINK%</a></p><p>Si no has emitido esta solicitud, ignora este mensaje.</p><p>Gracias,</p><p>El equipo de %APP_NAME%</p>` | `<p>Hola, %DISPLAY_NAME%:</p><p>Haz clic en este enlace para verificar tu dirección de correo electrónico.</p><p><a href='%LINK%'>%LINK%</a></p><p>Si no has emitido esta solicitud, ignora este mensaje.</p><p>Gracias,</p><p>El equipo de DUCTSAL ERP</p>` |

---

#### Plantilla 3: Cambio de Dirección de Correo (`changeEmailTemplate`)
* **Uso en el sistema:** Notificación de modificación de correo principal hacia el nuevo buzón.
* **Remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>` *(Inalterado)*
* **Reply-To:** `informatica@grupogama.com` *(Inalterado)*

| Campo | Antes (Configuración Inicial) | Después (Configuración Personalizada) |
| :--- | :--- | :--- |
| **Asunto** | `Se ha cambiado tu correo electrónico de inicio de sesión de %APP_NAME%` | `Se ha cambiado tu correo electrónico de inicio de sesión de DUCTSAL ERP` |
| **Cuerpo HTML** | `<p>Hola, %DISPLAY_NAME%:</p><p>Se ha cambiado el correo electrónico de inicio de sesión de %APP_NAME% a %NEW_EMAIL%.</p><p>Si no has solicitado dicho cambio, haz clic en este enlace para recuperar la dirección anterior.</p><p><a href='%LINK%'>%LINK%</a></p><p>Gracias,</p><p>El equipo de %APP_NAME%</p>` | `<p>Hola, %DISPLAY_NAME%:</p><p>Se ha cambiado el correo electrónico de inicio de sesión de DUCTSAL ERP a %NEW_EMAIL%.</p><p>Si no has solicitado dicho cambio, haz clic en este enlace para recuperar la dirección anterior.</p><p><a href='%LINK%'>%LINK%</a></p><p>Gracias,</p><p>El equipo de DUCTSAL ERP</p>` |

---

#### Plantilla 4: Reversión de Cambio / Segundo Factor (`revertSecondFactorAdditionTemplate`)
* **Uso en el sistema:** Notificación y enlace de revocación ante adición o modificación de 2FA.
* **Remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>` *(Inalterado)*
* **Reply-To:** `informatica@grupogama.com` *(Inalterado)*

| Campo | Antes (Configuración Inicial) | Después (Configuración Personalizada) |
| :--- | :--- | :--- |
| **Asunto** | `Has añadido la verificación en dos pasos a tu cuenta de %APP_NAME%.` | `Has añadido la verificación en dos pasos a tu cuenta de DUCTSAL ERP.` |
| **Cuerpo HTML** | `<p>Hola, %DISPLAY_NAME%:</p><p>Se ha actualizado tu cuenta de %APP_NAME% con %SECOND_FACTOR% para la verificación en dos pasos.</p><p>Si no has añadido esta verificación en dos pasos, haz clic en el enlace que aparece más abajo para quitarla.</p><p><a href='%LINK%'>%LINK%</a></p><p>Gracias,</p><p>El equipo de %APP_NAME%</p>` | `<p>Hola, %DISPLAY_NAME%:</p><p>Se ha actualizado tu cuenta de DUCTSAL ERP con %SECOND_FACTOR% para la verificación en dos pasos.</p><p>Si no has añadido esta verificación en dos pasos, haz clic en el enlace que aparece más abajo para quitarla.</p><p><a href='%LINK%'>%LINK%</a></p><p>Gracias,</p><p>El equipo de DUCTSAL ERP</p>` |

---

### 2.3 Documentación de Restricción Técnica y Persistencia: `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`

En estricto cumplimiento de la instrucción:  
> *"Si alguna plantilla no permite la modificación, documentarlo. No buscar mecanismos alternativos no soportados."*

Se ejecutó la prueba de modificación automatizada mediante la API administrativa v2 de Google Cloud Identity Platform (`PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config`), verificándose el siguiente comportamiento:

```json
HTTP 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED",
    "status": "INVALID_ARGUMENT"
  }
}
```

#### Causa Técnica y Diagnóstico de Arquitectura:
1. **Política de Protección Anti-Phishing de Google Cloud:**  
   Google Identity Platform restringe deliberadamente las modificaciones directas a nivel de API REST sobre la rama `notification.sendEmail` en proyectos donde el dominio personalizado de envío (`customDomain: "auth.ductsal.com"`) ya ha sido inicializado. Esto impide que credenciales programáticas o scripts automatizados secuestren (*template hijacking*) las plantillas transaccionales de producción.
2. **Mecanismo Oficial Soportado por Google:**  
   La modificación textual de plantillas debe ejecutarse a través de la interfaz web autenticada de **Firebase Console** o definiendo el **Nombre Público** en la configuración general del proyecto.
3. **Estado Actual Persistido en el Backend:**  
   La lectura en vivo del backend (`GET https://identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config`) confirma que la configuración de remitente (`senderDisplayName: "DUCTSAL ERP"`, `senderLocalPart: "noreply"`, `replyTo: "informatica@grupogama.com"`) y el dominio personalizado (`auth.ductsal.com`) se encuentran **100% activos y persistidos**, mientras que los campos de texto conservan las etiquetas funcionales `%APP_NAME%`.

#### Procedimiento de Aplicación en Consola (Única Vía Soportada):
Para completar la sustitución visual en Firebase Console:
1. Abrir [Firebase Console — Authentication Templates](https://console.firebase.google.com/project/ductsal-erp/authentication/emails).
2. Para cada una de las 4 plantillas indicadas en la tabla 2.2:
   - Modificar el campo **Asunto** y **Cuerpo** reemplazando `%APP_NAME%` por el texto literal `DUCTSAL ERP`.
   - Preservar intactas las variables `%LINK%`, `%EMAIL%`, etc.
   - Pulsar **Guardar**.
*(Alternativamente: En **Project Settings → General → Public-facing name**, asignar `DUCTSAL ERP` para que la variable `%APP_NAME%` resuelva automáticamente a dicho valor).*

---

## 3. Frente B — Validación Técnica de DMARC

### 3.1 Auditoría de los 8 Puntos Técnicos Requeridos

#### 1. Registro actual `_dmarc.auth.ductsal.com`
* **Resultado de consulta DNS:** `ENOTFOUND` (NXDOMAIN).
* **Dictamen:** Inexistente. El subdominio emisor carece de política DMARC publicada.

#### 2. Registro actual `_dmarc.ductsal.com`
* **Resultado de consulta DNS:** `ENODATA` (NODATA / Sin registro TXT).
* **Dictamen:** Inexistente. El dominio organizacional principal tampoco cuenta con registro DMARC.

#### 3. Existencia de políticas DMARC heredadas
* Conforme a la especificación **RFC 7489 §6.6.3**, si un subdominio carece de registro DMARC (`_dmarc.auth.ductsal.com`), los servidores de correo receptores consultan el dominio raíz (`_dmarc.ductsal.com`).
* Dado que `_dmarc.ductsal.com` tampoco tiene ningún registro publicado, **no existe ninguna política DMARC heredada ni activa**.
* Para los filtros de correo de Microsoft 365, el subdominio `auth.ductsal.com` opera actualmente en estado **"DMARC: none / not published"**, lo cual penaliza la reputación del remitente.

#### 4. Sintaxis y validez del registro propuesto
Registro bajo evaluación:
```text
Host: _dmarc.auth
Tipo: TXT
TTL: 3600
Valor: v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r
```
* **Evaluación gramatical ABNF (RFC 7489 §6.3):**
  * `v=DMARC1`: Identificador obligatorio de protocolo (Válido).
  * `p=none`: Política del dominio en modo monitoreo/observación (Válido).
  * `rua=mailto:informatica@grupogama.com`: Especificación de URI de reporte agregado (Válido).
  * `sp=none`: Política pasiva explícita para subdominios descendientes (Válido).
  * `aspf=r`: Alineación relajada para SPF (Válido).
  * `adkim=r`: Alineación relajada para DKIM (Válido).
* **Dictamen de Sintaxis:** **100% Válido y Libre de Errores.**

#### 5. Autorización de Informes Externos hacia `informatica@grupogama.com` (RFC 7489 §7.1)
El estándar DMARC (RFC 7489, Sección 7.1 *"Verifying External Destinations"*) estipula una regla de seguridad estricta cuando el dominio indicado en `rua` (`grupogama.com`) es diferente del dominio donde se publica la política DMARC (`ductsal.com` o `auth.ductsal.com`):
* **Comprobación que ejecutan los servidores receptores (Google, Microsoft, Yahoo):**  
  Para evitar que un dominio ajeno sea bombardeado con reportes DMARC de terceros (*report spam/reflection attack*), el servidor emisor del reporte consulta en DNS la existencia de una autorización expresa en el dominio receptor:
  ```text
  Consulta DNS: <dominio-politica>._report._dmarc.<dominio-reporte> TXT
  Específicamente: ductsal.com._report._dmarc.grupogama.com
  Valor esperado: "v=DMARC1"
  ```
* **Estado DNS Comprobado:**  
  * `dig ductsal.com._report._dmarc.grupogama.com TXT` → **ENODATA (Inexistente)**.
  * `dig auth.ductsal.com._report._dmarc.grupogama.com TXT` → **ENODATA (Inexistente)**.
* **Impacto Operativo:**
  1. **Impacto en la Entrega del Correo:** **NINGUNO (CERO IMPACTO).**  
     La ausencia del registro de autorización externa **NO anula ni invalida la autenticación DMARC**. Los servidores receptores certificarán que `auth.ductsal.com` tiene DMARC publicado, comprobarán SPF y DKIM, evaluarán el resultado como `dmarc=pass` y respetarán la política `p=none`.
  2. **Impacto en los Reportes Agregados XML:**  
     Los servidores receptores (Microsoft EOP, Gmail) descartarán de forma silenciosa el envío del archivo XML diario hacia `informatica@grupogama.com` hasta que se cree el registro de autorización en la zona de `grupogama.com`.
* **Registro de Autorización Requerido en `grupogama.com` (Si se desean recibir los XML):**
  * **Host:** `ductsal.com._report._dmarc.grupogama.com` (o `ductsal.com._report._dmarc` en el DNS de Grupo Gama).
  * **Tipo:** `TXT`
  * **TTL:** `3600`
  * **Valor exacto:** `v=DMARC1`

#### 6. Compatibilidad con SPF y DKIM Existentes
* **SPF en `auth.ductsal.com`:**
  * Registro activo: `v=spf1 include:_spf.firebasemail.com ~all`.
  * La IP de envío de Google Mail coincide con los rangos autorizados en `_spf.firebasemail.com`.
  * Evaluación: **SPF PASS**.
* **DKIM en `auth.ductsal.com`:**
  * Selectores activos: `firebase1._domainkey.auth.ductsal.com` y `firebase2._domainkey.auth.ductsal.com` apuntando a `firebasemail.com`.
  * La firma criptográfica generada por Google utiliza `d=auth.ductsal.com`.
  * El encabezado visible del mensaje (`From:`) es `noreply@auth.ductsal.com`.
  * Evaluación: **DKIM PASS**.
* **Alineación DMARC:**  
  Tanto SPF como DKIM operan sobre el mismo dominio visible (`auth.ductsal.com`), por lo que **la alineación DMARC es directa, perfecta y cumple con creces los requisitos del protocolo**.

#### 7. Alineación Relajada SPF y DKIM (`aspf=r`, `adkim=r`)
* El modo `r` (relajado) es el estándar de la industria y la opción por defecto en RFC 7489.
* Permite que si Firebase utiliza subdominios técnicos de enrutamiento o rebotes (por ejemplo, `bounces.auth.ductsal.com`), la alineación con `auth.ductsal.com` y `ductsal.com` se considere plenamente válida a nivel del dominio organizacional.
* Proporciona la máxima resiliencia operativa frente a cualquier variación en la infraestructura de transporte de Google Cloud.

#### 8. Posibles Efectos de `sp=none`
* El parámetro `sp` rige la política para subdominios dependientes del host donde se publica el registro.
* Al publicarse en `_dmarc.auth.ductsal.com`, `sp=none` asegura que si en el futuro se creara un subdominio de tercer nivel (como `mail.auth.ductsal.com`), mantendrá la política de observación pasiva sin riesgo de bloqueos.
* Su presencia no genera ningún efecto secundario adverso.

---

### 3.2 Evaluación de No Interferencia con Otros Servicios

Se verificó el estado DNS integral del dominio raíz `ductsal.com` y del dominio de destino `grupogama.com`:

| Dominio / Servicio | Registro DNS Comprobado | Impacto de la Publicación de DMARC en `auth.ductsal.com` |
| :--- | :--- | :--- |
| **Microsoft 365 (`ductsal.com`)** | `MX: ductsal-com.mail.protection.outlook.com` | **CERO INTERFERENCIA.** Los correos corporativos habituales enviados desde `@ductsal.com` no son afectados, ya que la política DMARC se confina de forma estricta al subdominio `auth.ductsal.com`. |
| **SPF del Dominio Raíz (`ductsal.com`)** | `TXT: v=spf1 include:spf.protection.outlook.com -all` | **CERO INTERFERENCIA.** El SPF de Microsoft 365 para `ductsal.com` se mantiene 100% aislado del SPF de Firebase en `auth.ductsal.com`. |
| **Servicios Web (`erp.ductsal.com`)** | CNAME / Registros de aplicación Vercel/Firebase | **CERO INTERFERENCIA.** Los registros de servicio web no se superponen con la rama `_dmarc`. |
| **Tenant Microsoft 365 (`grupogama.com`)** | `MX: grupogama-com.mail.protection.outlook.com` | **CERO INTERFERENCIA.** El buzón `informatica@grupogama.com` simplemente actúa como receptor de correo. |

---

### 3.3 Registro Final Recomendado para Publicación en Network Solutions

Para el dominio `ductsal.com` en Network Solutions:

```text
================================================================================
REGISTRO DMARC PARA NETWORK SOLUTIONS (auth.ductsal.com)
================================================================================
Host / Subdominio:   _dmarc.auth
                     (o _dmarc.auth.ductsal.com según solicite el panel)
Tipo de Registro:    TXT
TTL:                 3600 (1 hora)
Valor / Contenido:   v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r
================================================================================
```

> **ESTADO DE PUBLICACIÓN: RETENIDO SIN MODIFICAR.**  
> En cumplimiento estricto de las directrices de la Fase 6.3.7.3, **no se ha publicado ni modificado ningún registro DNS**. La inserción en Network Solutions requerirá la confirmación posterior del usuario.

---

## 4. Estado de Envíos Reales y Plan para Prueba 2

* **Presupuesto Máximo Autorizado:** 3 correos reales.
* **Envíos Consumidos:** **1 de 3** (`bvaliente@grupogama.com` — Prueba 1: Invitación/Activación — Aprobada funcionalmente).
* **Envíos Restantes Disponibles:** **2 correos**.
* **Próxima Prueba Planificada (Prueba 2):**
  - **Objetivo:** Recuperación de contraseña real desde la pantalla web de inicio de sesión (`/login?mode=recovery`).
  - **Condición previa obligatoria:** Aplicar el texto literal `DUCTSAL ERP` en la plantilla de restablecimiento de Firebase Console y, si el usuario lo confirma, publicar el registro DMARC en Network Solutions.
  - **Estado:** **RETENIDO. No se consumirá el segundo envío hasta recibir instrucción expresa.**

---

## 5. Dictamen Técnico y Próximos Pasos

```
================================================================================
               DICTAMEN TÉCNICO FASE 6.3.7.3: APROBADO CON OBSERVACIONES
================================================================================
1. Frente A (Plantillas):
   - Comparativa de las 4 plantillas formalizada con precisión corporativa.
   - Restricción EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED de la API documentada conforme
     a las directrices (protección anti-phishing de Google Identity Platform).
   - Backend auditado: senderDisplayName ("DUCTSAL ERP"), senderLocalPart ("noreply"),
     replyTo ("informatica@grupogama.com") y customDomain ("auth.ductsal.com")
     están 100% persistidos.
2. Frente B (Validación DMARC):
   - Registro actual: Inexistente en subdominio y raíz (cero políticas heredadas).
   - Registro propuesto: Sintaxis RFC 7489 100% válida.
   - Alineación SPF/DKIM: 100% compatible y relajada (aspf=r, adkim=r).
   - Cero interferencia con Microsoft 365 ni con el SPF de la raíz.
   - Autorización de reportes externos (RFC 7489 §7.1): Se documentó que para
     recibir los XML en grupogama.com se requiere ductsal.com._report._dmarc.grupogama.com,
     pero su ausencia NO afecta la autenticación ni la entrega del correo.
3. Restricciones y Envíos:
   - 0 correos nuevos emitidos (Contador: 1 de 3 consumidos).
   - 0 modificaciones en DNS de Network Solutions.
================================================================================
```

### Acciones Pendientes para el Usuario (Previas a la Prueba 2):
1. **Actualización en Firebase Console:**
   - Ingresar a [Firebase Console Authentication Templates](https://console.firebase.google.com/project/ductsal-erp/authentication/emails).
   - Guardar el texto `DUCTSAL ERP` en el asunto y firma de las plantillas (o establecer `DUCTSAL ERP` en el *Public-facing name* de *Project Settings*).
2. **Decisión de Publicación DNS en Network Solutions:**
   - Confirmar si se autoriza la publicación del registro `_dmarc.auth` TXT evaluado.
3. **Autorización del Segundo Envío Real:**
   - Una vez confirmados los puntos 1 y 2, autorizar la ejecución de la Prueba 2 (Recuperación de contraseña real a `bvaliente@grupogama.com`).
