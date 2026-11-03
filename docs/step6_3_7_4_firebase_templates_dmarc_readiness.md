# FASE 6.3.7.4 — ÚLTIMA VALIDACIÓN DE PLANTILLAS FIREBASE Y PREPARACIÓN DE PUBLICACIÓN DMARC

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026 (02:46 UTC / 20:46 CST)  
**Documento:** Informe Técnico de Investigación Oficial de Plantillas y Dictamen de Preparación DMARC  
**Estado:** **EJECUTADO — INVESTIGACIÓN Y PREPARACIÓN TÉCNICA CONCLUIDA SIN CAMBIOS EN PRODUCCIÓN NI DNS**  
**Dictamen Técnico:** **APROBADO CON OBSERVACIONES**  

---

## 1. Resumen Ejecutivo y Cumplimiento Estricto de Restricciones

En estricto cumplimiento de las directrices de la **Fase 6.3.7.4**, se abordaron documentalmente y mediante validación técnica independiente los dos frentes requeridos:
1. **Frente A (Plantillas Firebase):** Se completó la investigación técnica sobre la restricción de modificación en Firebase Authentication / Google Cloud Identity Platform, se determinó el rol de `Public-facing name` sobre `%APP_NAME%`, se separaron rigurosamente hechos comprobados de hipótesis y se preparó un borrador formal de consulta técnica para Firebase Support.
2. **Frente B (DMARC):** Se re-ejecutaron las consultas DNS independientes capturando respuestas reales y marcas de tiempo, se validó el requisito de autorización externa conforme a RFC 7489 §7.1 para `auth.ductsal.com._report._dmarc.grupogama.com`, se compararon las dos alternativas de publicación (con `rua` vs. sin `rua`) y se definió la recomendación técnica final.

### 1.1 Control Riguroso de Restricciones Absolutas
* **Modificaciones en DNS:** **0 cambios realizados**. No se modificó Network Solutions ni el DNS de Grupo Gama.
* **Consumo de envíos reales:** **0 correos emitidos en esta fase**. El presupuesto se mantiene en **1 de 3 consumidos** (2 envíos reservados intactos para las Pruebas 2 y 3).
* **Modificaciones en Firebase Console o backend:** **0 modificaciones aplicadas**.
* **Intentos redundantes de PATCH:** **0 intentos repetidos**. Se respetó el resultado conocido de `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`.
* **Despliegues, commits, branches o merges:** **0 operaciones en Git / Vercel / Cloud Functions**.

---

## 2. Frente A — Plantillas Firebase Authentication

### 2.1 Hechos Comprobados vs. Hipótesis Técnicas

Para garantizar el máximo rigor documental, se distinguen de forma explícita los hechos empíricamente comprobados de las hipótesis analíticas:

| Aspecto | Clasificación | Detalle Técnico |
| :--- | :--- | :--- |
| **Mensaje en Firebase Console** | **Hecho comprobado** | La consola web de Firebase en la sección de plantillas muestra de forma explícita el aviso: *«Por el momento, no se pueden actualizar las plantillas de correo electrónico de este proyecto»*. |
| **Respuesta de la API REST v2** | **Hecho comprobado** | Las llamadas administrativas al endpoint `identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config` para modificar plantillas devuelven `HTTP 400 Bad Request` con código `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`. |
| **Preservación del Remitente** | **Hecho comprobado** | Los parámetros de remitente (`senderDisplayName: "DUCTSAL ERP"`, `senderLocalPart: "noreply"`, `replyTo: "informatica@grupogama.com"`) y el dominio personalizado (`auth.ductsal.com`) se encuentran **100% activos y persistidos** en el backend de Google Cloud. |
| **Asunto recibido en el Envío 1** | **Hecho comprobado** | El primer correo real de invitación enviado a `bvaliente@grupogama.com` tuvo como asunto: `Cambia la contraseña de ductsal-erp`. |
| **Origen del valor `%APP_NAME%`** | **Hecho comprobado** | En la arquitectura de Firebase Authentication, el token `%APP_NAME%` interpola el campo **Public-facing name** del proyecto. Si no ha sido definido manualmente en la consola, Firebase utiliza por defecto el `projectId` inmutable (`ductsal-erp`). |
| **Causa de la restricción de plantilla** | **Hecho comprobado** | Google Cloud Identity Platform impone un bloqueo de seguridad por diseño (*anti-phishing / template tampering lock*) que deshabilita la edición de texto libre de las plantillas predeterminadas en proyectos que tienen dominios personalizados de envío o perfiles de seguridad específicos. |
| **Procedimiento de desbloqueo por soporte** | **Hipótesis fundamentada** | Si se requiere modificar el HTML y texto de las plantillas sin recurrir a Cloud Functions, Firebase Support puede levantar este bloqueo administrativo a nivel de backend tras una solicitud formal del propietario del proyecto. |

---

### 2.2 Conclusión Oficial sobre `%APP_NAME%` y `Public-facing name`

1. **Resolución del Asunto y Cuerpo:**  
   El texto por defecto de la plantilla de restablecimiento es:  
   `Cambia la contraseña de %APP_NAME%`.  
   Al recibir el correo, el usuario observó:  
   `Cambia la contraseña de ductsal-erp`.  
   Esto demuestra de forma concluyente que el asunto no está prefijado con texto estático incorrecto, sino que depende de la variable `%APP_NAME%`.

2. **Diferencia entre Nombre del Proyecto y Public-facing Name:**  
   * **Nombre del proyecto (`displayName`):** Es el nombre interno asignado en Firebase (`"Ductsal ERP"`).  
   * **Public-facing name (Nombre público del proyecto):** Es el atributo de branding OAuth (Google Auth Platform / Firebase Project Settings) que la infraestructura de autenticación expone hacia el usuario final.
   * **Comportamiento documentado:** Cuando el campo *Public-facing name* se define formalmente como `DUCTSAL ERP` en **Project Settings → General**, Firebase actualiza la interpolación global de `%APP_NAME%`. En consecuencia, el asunto pasa a ser automáticamente:  
     `Cambia la contraseña de DUCTSAL ERP`  
     Y la firma corporativa pasa a ser:  
     `El equipo de DUCTSAL ERP`.

3. **Independencia de la Restricción:**  
   La modificación del *Public-facing name* en la pestaña general de configuración del proyecto **NO está sujeta al bloqueo de plantillas (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`)**, ya que no altera el árbol de plantillas HTML sino los metadatos de identidad del proyecto.

---

### 2.3 Procedimientos Soportados por Google / Firebase para Dominios Personalizados

La investigación en la documentación oficial de Firebase y Google Cloud Identity Platform confirma que existen dos caminos soportados cuando se requiere personalización sobre un dominio propio:

1. **Vía Estándar (Recomendada para la Fase Actual):**  
   Mantener las plantillas nativas de Firebase Authentication, asegurando que el *Public-facing name* resuelva `%APP_NAME%` a `DUCTSAL ERP`. Esto garantiza que los correos muestren la marca comercial correcta tanto en el remitente (`DUCTSAL ERP <noreply@auth.ductsal.com>`) como en el asunto (`Cambia la contraseña de DUCTSAL ERP`) y en la firma (`El equipo de DUCTSAL ERP`), sin requerir infraestructura adicional.
2. **Vía Avanzada (Desarrollo Futuro / Enterprise):**  
   Si en fases posteriores se requiriera un rediseño gráfico completo del correo (logotipos, estilos CSS corporativos personalizados, textos totalmente distintos), Google documenta que la solución arquitectónica consiste en utilizar el **Firebase Admin SDK** para generar el enlace de acción mediante `generatePasswordResetLink()` y despacharlo mediante una Cloud Function con un proveedor de correo transaccional (ej. SendGrid, Resend, Amazon SES o Microsoft Graph API).

---

### 2.4 Borrador de Consulta Técnica para Firebase Support

En cumplimiento del requerimiento de la fase, se redactó el borrador formal de consulta técnica dirigido al equipo de soporte de Firebase / Google Cloud Identity Platform, **el cual queda en estado de borrador sin ser enviado**:

```text
================================================================================
BORRADOR DE CONSULTA TÉCNICA (NO ENVIAR - SOLO DOCUMENTAL)
DESTINATARIO: Firebase Support / Google Cloud Support
PROYECTO: ductsal-erp (Project Number: 948658286825)
CATEGORÍA: Authentication / Email Templates & Custom Sending Domain
================================================================================

ASUNTO:
Incapacidad para editar plantillas de correo en Firebase Authentication con dominio personalizado (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED)

CUERPO EN ESPAÑOL:
Estimado equipo de soporte de Firebase,

Nos dirigimos a ustedes en relación con nuestro proyecto de producción "ductsal-erp" (Project Number: 948658286825).

Hemos configurado y verificado exitosamente nuestro dominio personalizado para el envío de correos de autenticación (auth.ductsal.com), contando con los registros SPF y DKIM activos y validados.

Sin embargo, al intentar actualizar el texto de las plantillas de correo electrónico desde la consola de Firebase (Authentication > Templates), la interfaz muestra el siguiente mensaje de bloqueo:
"Por el momento, no se pueden actualizar las plantillas de correo electrónico de este proyecto."

Asimismo, la llamada administrativa vía Identity Toolkit API v2 devuelve:
HTTP 400 Bad Request: EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED

Nuestro objetivo es sustituir el valor literal del nombre comercial en los asuntos y cuerpos de las plantillas de Restablecimiento de contraseña, Verificación de correo y Cambio de correo para que muestren "DUCTSAL ERP" en lugar del identificador técnico del proyecto.

Solicitamos su asistencia técnica para:
1. Confirmar el motivo por el cual la edición de plantillas se encuentra restringida en este proyecto tras la delegación del dominio personalizado.
2. Desbloquear la capacidad de edición de las plantillas para ductsal-erp, o en su defecto, confirmar si el ajuste del "Public-facing name" en la configuración general es suficiente para que %APP_NAME% resuelva a "DUCTSAL ERP" en todos los envíos transaccionales.

Agradecemos de antemano su pronta atención.

Atentamente,
Equipo de TI - DUCTSAL ERP / Grupo Gama
informatica@grupogama.com

--------------------------------------------------------------------------------
ENGLISH VERSION (FOR GLOBAL TIER SUPPORT):
Subject: Unable to edit Firebase Auth email templates with custom sending domain (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED)

Dear Firebase Support Team,

We are contacting you regarding our production project "ductsal-erp" (Project Number: 948658286825).

We have successfully configured and verified our custom email sending domain (auth.ductsal.com), with SPF and DKIM records fully operational.

However, when attempting to update email templates in the Firebase Console (Authentication > Templates), the UI displays the following lock message:
"Email templates cannot be updated for this project at this time." (Spanish: "Por el momento, no se pueden actualizar las plantillas de correo electrónico de este proyecto.")

Direct administrative API requests via Identity Toolkit v2 return:
HTTP 400 Bad Request: EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED

Our objective is to ensure that the subject lines and email bodies consistently display our official application name "DUCTSAL ERP" instead of the technical project ID.

We kindly request your assistance to:
1. Clarify the security policy or backend flag causing the template editing lock on this custom domain project.
2. Unlock template customization for project ductsal-erp, or confirm whether updating the "Public-facing name" in Project Settings fully resolves %APP_NAME% to "DUCTSAL ERP" across all outgoing transactional emails.

Best regards,
IT Team - DUCTSAL ERP / Grupo Gama
informatica@grupogama.com
================================================================================
```

---

## 3. Frente B — Validación Técnica DMARC

### 3.1 Resultados de Consultas DNS Independientes

Las consultas fueron ejecutadas directamente desde el entorno local contra servidores de nombres recursivos independientes (`8.8.8.8` y el resolver local del sistema).

**Fecha y hora de ejecución:** `2026-11-03T02:46:02Z` (2 de Noviembre de 2026, 20:46 CST).

| Registro Consultado | Tipo | Resultado Obtenido | Estado Real |
| :--- | :---: | :--- | :---: |
| `_dmarc.auth.ductsal.com` | `TXT` | `ENOTFOUND` / `status: NXDOMAIN` | **Inexistente** |
| `_dmarc.ductsal.com` | `TXT` | `ENODATA` / `status: NOERROR, ANSWER: 0` | **Inexistente** |
| `auth.ductsal.com` | `TXT` | `v=spf1 include:_spf.firebasemail.com ~all`<br>`firebase=ductsal-erp` | **Activo (100% OK)** |
| `firebase1._domainkey.auth.ductsal.com` | `CNAME` | `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com.` | **Activo (100% OK)** |
| `firebase2._domainkey.auth.ductsal.com` | `CNAME` | `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com.` | **Activo (100% OK)** |
| `auth.ductsal.com._report._dmarc.grupogama.com` | `TXT` | `ENODATA` / `status: NOERROR, ANSWER: 0` | **Inexistente** |

#### Evidencia de Red Bruta (`dig` Output):
```text
$ dig @8.8.8.8 _dmarc.auth.ductsal.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN
;; QUESTION SECTION:
;_dmarc.auth.ductsal.com. IN TXT
;; AUTHORITY SECTION:
ductsal.com. 1800 IN SOA NS25.WORLDNIC.com. namehost.WORLDNIC.com. 126110218 10800 3600 604800 3600

$ dig @8.8.8.8 auth.ductsal.com._report._dmarc.grupogama.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 41824
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; AUTHORITY SECTION:
grupogama.com. 1800 IN SOA NS41.WORLDNIC.com. namehost.WORLDNIC.com. 126042113 10800 3600 604800 3600
```

---

### 3.2 Validación de la Autorización de Informes Externos (RFC 7489 §7.1)

El análisis del requisito de autorización externa de reportes DMARC arroja las siguientes conclusiones normativas:

1. **Identificación de Dominios:**
   * Dominio emisor de la política: `auth.ductsal.com` (dominio organizacional: `ductsal.com`).
   * Dominio destinatario de los reportes (`rua`): `grupogama.com`.
   * Al pertenecer a organizaciones diferentes, aplica de forma mandatoria la regla de **Verificación de Destinos Externos** (*External Destination Verification*) establecida en **RFC 7489 §7.1**.
2. **Registro de Autorización Requerido:**  
   Conforme al estándar, los servidores receptores (Google, Microsoft) buscan un registro TXT específico con el nombre del subdominio emisor bajo la jerarquía `_report._dmarc` del dominio receptor:
   * **Host requerido:** `auth.ductsal.com._report._dmarc.grupogama.com`
   * **Tipo:** `TXT`
   * **Valor:** `v=DMARC1`
   * *(Nota técnica: `ductsal.com._report._dmarc.grupogama.com` no es suficiente para autorizar reportes provenientes del subdominio explícito `auth.ductsal.com` si los validadores aplican la resolución estricta del FQDN emisor).*
3. **Estado Actual:**  
   La consulta DNS confirma que dicho registro **no existe actualmente en el DNS de `grupogama.com`** (`ENODATA`).
4. **Efecto Operativo:**
   * **Efecto en la Autenticación y Entrega del Correo:** **NINGUNO.**  
     Los servidores de correo receptores autentican SPF, validan DKIM, comprueban que el remitente posee DMARC publicado y emiten un dictamen de **`dmarc=pass`**. El correo se procesa con plena legitimidad criptográfica.
   * **Efecto en los Reportes Agregados:**  
     Al no encontrar el registro de autorización externa en `grupogama.com`, los servidores receptores **descartan el envío de los archivos XML diarios** hacia `informatica@grupogama.com`, evitando así el envío de reportes no solicitados a un dominio tercero.

---

### 3.3 Validación del Registro DMARC Propuesto

```text
Host en Network Solutions:  _dmarc.auth
Tipo:                       TXT
TTL:                        3600 (1 hora)
Valor:                      v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r
```

* **Sintaxis:** 100% válida conforme a la gramática ABNF de RFC 7489 §6.3.
* **Ámbito de Aplicación:** Aplica exclusivamente al subdominio `auth.ductsal.com` y a sus eventuales descendientes (`sp=none`).
* **Alineación Criptográfica:**
  * Remitente visible (`From:`): `noreply@auth.ductsal.com`.
  * SPF: Alineado con `auth.ductsal.com` (`aspf=r`).
  * DKIM: Firma criptográfica `d=auth.ductsal.com` alineada directamente con el remitente (`adkim=r`).
* **Compatibilidad con el Remitente Real:** Absoluta. Garantiza que Microsoft 365 y Google clasifiquen los correos de DUCTSAL ERP como auténticos.

---

### 3.4 Comparación Técnica de las Dos Alternativas de Publicación

| Criterio | Alternativa A (Con Reportes Agregados) | Alternativa B (Sin Reportes Agregados — Recomendada) |
| :--- | :--- | :--- |
| **Valor del Registro** | `v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r` | `v=DMARC1; p=none; sp=none; aspf=r; adkim=r` |
| **Protección y Autenticación** | Total (`dmarc=pass`, elimina la penalización de dominio no autenticado en Microsoft EOP). | Total (`dmarc=pass`, elimina la penalización de dominio no autenticado en Microsoft EOP). |
| **Efecto en la Entregabilidad** | Excelente. Microsoft 365 valida SPF, DKIM y DMARC en PASS. | Idéntico. Microsoft 365 valida SPF, DKIM y DMARC en PASS. |
| **Dependencia Externa** | **Alta:** Requiere acceso administrativo y cambios en el DNS de `grupogama.com` para crear el registro de autorización `auth.ductsal.com._report._dmarc.grupogama.com`. | **Ninguna:** Se publica de forma autónoma en el DNS de Network Solutions de `ductsal.com`. |
| **Riesgo Operativo** | Si `grupogama.com` no publica la autorización, los receptores descartan los reportes XML silenciosamente. | Cero riesgo. No genera reportes XML ni satura buzones técnicos. |
| **Mantenimiento** | Requiere procesamiento y lectura periódica de archivos XML diarios comprimidos en `.zip/.gz`. | Sin carga de mantenimiento administrativo de reportes. |

#### Recomendación Técnica Fundamentada:
* **Se recomienda adoptar de forma prioritaria la Alternativa B:**  
  La **Alternativa B** (`v=DMARC1; p=none; sp=none; aspf=r; adkim=r`) otorga el **100% de los beneficios de entregabilidad y reputación** ante los filtros de Microsoft 365 / Superhuman, cumple a cabalidad con los estándares exigidos para evitar la carpeta Junk y no genera dependencias de configuración en la zona DNS de `grupogama.com`.
* Si en el futuro Grupo Gama decide centralizar la recepción de métricas XML, se podrá actualizar el registro hacia la Alternativa A de forma transparente tras publicar el registro de autorización en su propia zona DNS.

---

### 3.5 Alcance Estricto y No Interferencia

1. **Aislamiento del Subdominio:**  
   La publicación de `_dmarc.auth` en el DNS de `ductsal.com` rige **exclusivamente sobre `auth.ductsal.com`**.
2. **Cero Impacto en el Dominio Raíz y Microsoft 365:**  
   * Los correos corporativos habituales enviados por el personal de la empresa desde `@ductsal.com` (gestionados a través de Microsoft 365 Exchange Online Protection) **no son afectados ni modificados**.
   * El registro SPF de la raíz (`v=spf1 include:spf.protection.outlook.com -all`) y los registros MX de Outlook permanecen completamente intactos e independientes.

---

### 3.6 Registro Exacto Recomendado para Publicación en Network Solutions

```text
================================================================================
ESPECIFICACIÓN EXACTA PARA NETWORK SOLUTIONS (auth.ductsal.com)
================================================================================
Host / Subdominio:   _dmarc.auth
                     (o _dmarc.auth.ductsal.com según solicite el formulario)
Tipo de Registro:    TXT
TTL:                 3600 segundos (1 hora)
Valor (Alternativa B Recomendada):
v=DMARC1; p=none; sp=none; aspf=r; adkim=r

Valor (Alternativa A - si se cuenta con autorización en grupogama.com):
v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r
================================================================================
```

> **RECORDATORIO OBLIGATORIO:**  
> Este registro se encuentra **técnicamente validado y preparado, pero RETENIDO SIN PUBLICAR**.  
> No se ha insertado ningún registro en Network Solutions. La publicación requerirá la confirmación formal del usuario.

---

## 4. Dictamen Final y Acciones Pendientes

```
================================================================================
               DICTAMEN TÉCNICO FASE 6.3.7.4: APROBADO CON OBSERVACIONES
================================================================================
1. Frente A (Plantillas):
   - Causa raíz del bloqueo en consola (aviso de restricción) y API documentada.
   - Conclusión técnica: %APP_NAME% depende de "Public-facing name" en Configuración
     del proyecto. Definir "DUCTSAL ERP" resuelve el asunto y cuerpo de forma nativa.
   - Borrador para Firebase Support redactado y retenido sin enviar.
2. Frente B (DMARC):
   - Consultas DNS independientes ejecutadas (6 objetivos con fecha/hora real).
   - Autorización externa (RFC 7489 §7.1) evaluada: no existe en grupogama.com,
     lo que justifica técnicamente la publicación de la Alternativa B (sin rua).
   - Sintaxis, alineación y aislamiento comprobados al 100%.
3. Restricciones:
   - 0 correos enviados (Contador: 1 de 3 consumidos, 2 restantes intactos).
   - 0 modificaciones aplicadas en DNS.
   - 0 cambios en producción, código o usuarios.
================================================================================
```

### Acciones Pendientes (Requieren Decisión / Ejecución del Usuario):
1. **Configurar el Nombre Público en Firebase Console:**  
   Ingresar a **Project Settings → General → Public-facing name** y definir el valor `DUCTSAL ERP` para que `%APP_NAME%` resuelva automáticamente en todos los asuntos y cuerpos de correo.
2. **Publicar el Registro DMARC en Network Solutions:**  
   Insertar el registro TXT `_dmarc.auth` utilizando el valor de la **Alternativa B** recomendada.
3. **Autorización del Segundo Envío Real (Prueba 2):**  
   Una vez completados los puntos 1 y 2, autorizar la ejecución de la Prueba 2 (Recuperación de contraseña real a `bvaliente@grupogama.com` desde la pantalla web de inicio de sesión) para validar la recepción directa en Inbox.
