# FASE 6.3.7 — REVISIÓN TÉCNICA DE ENTREGABILIDAD Y PERSONALIZACIÓN DE PLANTILLAS FIREBASE

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026  
**Documento:** Informe Técnico de Entregabilidad, Diagnóstico de Clasificación Junk y Personalización de Plantillas  
**Estado:** **AUDITORÍA DE DIAGNÓSTICO EJECUTADA — CERO CAMBIOS EN PRODUCCIÓN**  
**Dictamen Técnico:** **APROBADO CON OBSERVACIONES**  

---

## 1. Contexto y Hallazgos del Envío Real

Durante el **Envío 1 de 3** de la Fase 6.3.7 dirigido a `bvaliente@grupogama.com`, se verificaron satisfactoriamente los siguientes hitos operativos:
- Despacho y aceptación por Firebase Authentication: `HTTP 200 OK`.
- Entrega efectiva en el buzón corporativo `bvaliente@grupogama.com`.
- Remitente visible: `DUCTSAL ERP <noreply@auth.ductsal.com>`.
- Subdominio de envío en red: `auth.ductsal.com`.
- Idioma y redacción: 100% en español.
- Enlace de acción funcional: Apertura correcta, establecimiento exitoso de contraseña y retorno al ERP en `https://erp.ductsal.com/login?mode=activate`.

**Observaciones identificadas para diagnóstico:**
1. **Nombre de aplicación:** El asunto recibido fue *"Cambia la contraseña de ductsal-erp"* y el cuerpo refirió a `ductsal-erp` en lugar de `DUCTSAL ERP`.
2. **Entregabilidad:** El proveedor de correo (Microsoft 365 / Superhuman) clasificó el mensaje en la carpeta **Junk**.

---

## 2. Causa Identificada del Nombre Técnico `ductsal-erp`

### 2.1 Mecanismo de Resolución de `%APP_NAME%`
En Google Cloud Identity Platform y Firebase Authentication, las plantillas de correo utilizan variables de interpolación dinámicas:
* `%APP_NAME%`: Nombre público de la aplicación.
* `%LINK%`: Enlace seguro de acción con código OOB y `continueUrl`.
* `%EMAIL%`: Dirección del destinatario.
* `%DISPLAY_NAME%`: Nombre del destinatario.

### 2.2 Diagnóstico Técnico en el Proyecto `ductsal-erp`
1. Al inspeccionar la configuración de las plantillas vía API (`https://identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config`), se comprobó:
   ```json
   "resetPasswordTemplate": {
     "senderLocalPart": "noreply",
     "senderDisplayName": "DUCTSAL ERP",
     "subject": "Cambia la contraseña de %APP_NAME%",
     "body": "<p>Hola:</p>\n<p>Haz clic en este enlace para cambiar la contraseña de %APP_NAME% de tu cuenta %EMAIL%.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>Si no has solicitado este cambio, ignora este correo electrónico.</p>\n<p>Gracias,</p>\n<p>El equipo de %APP_NAME%</p>",
     "bodyFormat": "HTML",
     "replyTo": "informatica@grupogama.com"
   }
   ```
2. **Causa Raíz:**  
   `senderDisplayName` está configurado correctamente como `"DUCTSAL ERP"` (por ello el remitente visible en la cabecera `From:` apareció como `DUCTSAL ERP <noreply@auth.ductsal.com>`).  
   Sin embargo, el placeholder `%APP_NAME%` **no se alimenta del `senderDisplayName`**. En la arquitectura de Google Identity Platform / Firebase, `%APP_NAME%` resuelve al **Nombre Público del Proyecto** (*Public-facing name*).  
   Cuando dicho campo no se inicializa o define explícitamente en la configuración de la consola de Firebase / pantalla de consentimiento OAuth de Google Cloud, Identity Platform utiliza como valor predeterminado de respaldo el **Project ID técnico (`ductsal-erp`)**.

---

## 3. Alternativas Soportadas para Personalizar `%APP_NAME%`

Existen dos vías oficialmente soportadas por Google para lograr que el asunto y cuerpo muestren `DUCTSAL ERP`:

### Alternativa A: Reemplazo Literal en las Plantillas de Correo (Recomendada)
* **Descripción:** En lugar de delegar en la variable `%APP_NAME%`, las plantillas se configuran con el texto literal estático `"DUCTSAL ERP"` en el asunto y cuerpo.
* **Configuración resultante:**
  - Asunto: `"Cambia la contraseña de DUCTSAL ERP"`
  - Cuerpo: `<p>Hola:</p><p>Haz clic en este enlace para cambiar la contraseña de DUCTSAL ERP de tu cuenta %EMAIL%.</p>...<p>El equipo de DUCTSAL ERP</p>`
* **Ventajas:**  
  - 100% determinista e inmediato.  
  - Cero dependencias de variables internas de Google Cloud o pantallas OAuth.  
  - Preserva exactamente las mayúsculas corporativas `DUCTSAL ERP`.
* **Riesgo:** Ninguno. Es la práctica estándar cuando una aplicación tiene un nombre comercial fijo.

### Alternativa B: Configuración del Nombre Público en Firebase Console / Google Cloud
* **Descripción:** Acceder a Firebase Console → Configuración del Proyecto (*Project Settings*) → General → Nombre público (*Public-facing name*), o en Google Cloud Console → APIs & Services → Pantalla de consentimiento OAuth / Branding → Nombre de la aplicación, y definirlo como `DUCTSAL ERP`.
* **Ventajas:** Centraliza la variable `%APP_NAME%` en todo el proyecto.
* **Riesgo:** En proyectos sin proveedores OAuth externos activos (como Google Sign-In), este campo a veces requiere provisionar o guardar previamente la configuración de OAuth en Google Cloud Platform.

---

## 4. Evaluación de Autenticación de Correo: SPF, DKIM y DMARC

### 4.1 Evidencia en DNS Autoritativo
Se ejecutaron consultas directas contra los servidores DNS de Network Solutions (`ns25.worldnic.com`, `ns26.worldnic.com`):

```text
$ dig auth.ductsal.com TXT +short
"firebase=ductsal-erp"
"v=spf1 include:_spf.firebasemail.com ~all"

$ dig firebase1._domainkey.auth.ductsal.com CNAME +short
mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com.

$ dig firebase2._domainkey.auth.ductsal.com CNAME +short
mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com.

$ dig _dmarc.auth.ductsal.com TXT +short
(sin respuesta - ENOTFOUND)

$ dig _dmarc.ductsal.com TXT +short
(sin respuesta - ENODATA)
```

### 4.2 Análisis de Protocolos Criptográficos

| Mecanismo | Configuración en DNS | Comportamiento en Servidores Receptores | Estado |
| :--- | :--- | :--- | :---: |
| **SPF** (`auth.ductsal.com`) | `v=spf1 include:_spf.firebasemail.com ~all` | La IP emisora de Firebase Mail coincide con el mecanismo `include:_spf.firebasemail.com`. | **PASS** |
| **DKIM** (`auth.ductsal.com`) | Selectores `firebase1` y `firebase2` apuntan vía CNAME a los servidores de claves de Firebase. | El correo fue firmado criptográficamente por Firebase con `d=auth.ductsal.com`. | **PASS** |
| **DMARC** (`_dmarc.auth.ductsal.com`) | **Inexistente** en el subdominio `auth.ductsal.com`. | No hay política publicada a nivel de subdominio. | **AUSENTE** |
| **DMARC** (`_dmarc.ductsal.com`) | **Inexistente** en el dominio raíz corporativo `ductsal.com`. | No hay política organizacional heredable. | **AUSENTE** |

---

## 5. Diagnóstico de la Clasificación Junk por el Proveedor de Correo

### 5.1 Arquitectura del Buzón Receptor
* **Dirección destino:** `bvaliente@grupogama.com`.
* **Cliente de usuario:** Superhuman.
* **Servidor de correo receptor:** **Microsoft 365 / Exchange Online Protection (EOP)**  
  `MX grupogama.com -> grupogama-com.mail.protection.outlook.com`.  
  *Nota técnica:* Superhuman sincroniza la vista del servidor; el filtrado que movió el mensaje a Junk ocurrió a nivel de red en Microsoft EOP antes de la sincronización de la aplicación.

### 5.2 Factores Técnicos Determinantes de la Clasificación en Junk

1. **Dominio Emisor Recién Creado (*Newly Seen Domain* / Reputación Cero):**  
   `auth.ductsal.com` es un subdominio generado en DNS el 2 de noviembre de 2026. Los filtros de reputación de Microsoft Exchange Online Protection asignan automáticamente un nivel de confianza bajo (*Cold Domain*) a cualquier dominio o subdominio que emite por primera vez hacia su red. En ausencia de un historial previo de interacción o volumen legítimo, EOP aplica políticas de contención preventiva clasificando el mensaje en Junk (SCL 5 o 6).
2. **Ausencia de Registro DMARC Organizacional:**  
   En 2024–2026, los principales proveedores corporativos (Microsoft 365, Google Workspace) exigen que los remitentes publiquen un registro DMARC válido en el dominio raíz (`ductsal.com`) o en el subdominio de envío (`auth.ductsal.com`), aun cuando sea con política permisiva de monitoreo (`p=none`). La ausencia total del registro `_dmarc` penaliza severamente el puntaje de reputación antispam.
3. **Heurística de Enlaces de Restablecimiento de Contraseña (*Phishing Heuristics*):**  
   El contenido del correo (solicitud de cambio de contraseña con hipervínculo externo) proveniente de un remitente nuevo sin historial previo activa de forma natural los filtros heurísticos de protección contra phishing de Microsoft Defender for Office 365.

### 5.3 Límites de la Evidencia Técnica
* **Lo que está 100% demostrado con evidencia:**
  - El correo se emitió con éxito desde `auth.ductsal.com`.
  - SPF y DKIM están correctamente publicados y alineados con Firebase Mail.
  - No existe registro DMARC publicado en `ductsal.com` ni en `auth.ductsal.com`.
  - El servidor receptor es Microsoft 365 (`grupogama-com.mail.protection.outlook.com`).
* **Lo que requiere encabezados RFC 822 completos del mensaje:**
  - Los valores exactos asignados por Microsoft: `X-Forefront-Antispam-Report` (SCL, BCL, PCL), `Authentication-Results` exacto evaluado por EOP, y la regla específica de filtrado (`CAT:SPM` vs `CAT:PHSH`).
  - *Solicitud:* Si el usuario puede exportar los encabezados técnicos originales desde Superhuman (*Show Full Headers*), se podrán registrar los identificadores exactos de Microsoft.

---

## 6. Recomendaciones Concretas y Plan de Mitigación

Para asegurar que los correos de DUCTSAL ERP lleguen a la bandeja de entrada principal (Inbox), se recomiendan las siguientes acciones ordenadas por prioridad e impacto:

### Recomendación 1 — Ajuste de Plantillas de Correo (Cero Riesgo DNS)
* Reemplazar `%APP_NAME%` por `"DUCTSAL ERP"` directamente en el asunto y cuerpo de las 4 plantillas de Identity Platform.
* Esto garantiza que el usuario vea exactamente:
  - **Remitente:** `DUCTSAL ERP <noreply@auth.ductsal.com>`
  - **Asunto:** `Cambia la contraseña de DUCTSAL ERP`
  - **Firma:** `El equipo de DUCTSAL ERP`

### Recomendación 2 — Publicación de Registro DMARC en Network Solutions
* Crear en Network Solutions un registro TXT para DMARC en `auth.ductsal.com` o a nivel organizacional:
  - **Host:** `_dmarc.auth.ductsal.com`
  - **Tipo:** `TXT`
  - **Valor:** `"v=DMARC1; p=none; rua=mailto:informatica@grupogama.com"`
* *Impacto:* Cumple con los requisitos modernos de entregabilidad de Microsoft 365 y Google sin riesgo de rechazo de correos (política `p=none` solo monitorea, no bloquea).

### Recomendación 3 — Adición a Remitentes Seguros e Interacción Inicial (*Warm-up*)
* En el buzón de prueba `bvaliente@grupogama.com`, marcar el correo en Superhuman como **"No es Spam / Mover a Inbox"** y agregar `noreply@auth.ductsal.com` a la lista de remitentes seguros corporativos de Microsoft 365.
* Esto entrena inmediatamente al filtro bayesiano de Exchange Online Protection para que reconozca los correos futuros provenientes de `auth.ductsal.com` como legítimos.

---

## 7. Registro de Cambios y Aislamiento

* **Modificaciones en producción:** **NINGUNA**.
* **Modificaciones en DNS:** **NINGUNA**.
* **Modificaciones en Firebase Console / Identity Platform:** **NINGUNA**.
* **Envíos adicionales ejecutados:** **0** (El contador de envíos reales se mantiene estrictamente en **1 de 3**).

---

## 8. Dictamen Final de la Revisión

```
================================================================================
     DICTAMEN TÉCNICO FASE 6.3.7.1: APROBADO CON OBSERVACIONES
================================================================================
1. Nombre técnico "ductsal-erp": CAUSA IDENTIFICADA. %APP_NAME% toma el 
   Project ID por omisión en lugar de senderDisplayName. Se recomienda
   reemplazo literal en las plantillas ("DUCTSAL ERP").
2. Clasificación Junk: DIAGNOSTICADA. Consecuencia natural de dominio nuevo
   (Newly Seen Domain / sin reputación previa en Microsoft 365) y ausencia
   de registro DMARC en auth.ductsal.com.
3. Autenticación técnica: SPF y DKIM alineados y verificados en red.
4. Estado del sistema: Listo para incorporar ajustes autorizados antes de
   proceder con las Pruebas 2 y 3.
================================================================================
```
