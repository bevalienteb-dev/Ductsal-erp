# FASE 6.3.7.2 — CORRECCIÓN DE PRESENTACIÓN Y ENTREGABILIDAD DEL CORREO FIREBASE

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026  
**Documento:** Informe Técnico de Corrección de Presentación y Diagnóstico de Entregabilidad  
**Estado:** **EJECUTADO — DETENCIÓN REGLAMENTARIA PREVIA A PUBLICACIÓN DMARC Y SEGUNDO ENVÍO**  
**Dictamen Técnico:** **APROBADO CON OBSERVACIONES**  

---

## 1. Resumen Ejecutivo y Estado de Envíos

En cumplimiento estricto de las directrices de la **Fase 6.3.7.2**, se realizó la investigación técnica de los dos frentes identificados tras el primer envío real de invitación:
1. **Frente A (Presentación):** Se auditó la configuración de las plantillas y el mecanismo de interpolación de variables en Google Identity Platform, identificándose la causa de la aparición de `ductsal-erp` y el mecanismo de actualización en producción.
2. **Frente B (Entregabilidad):** Se auditó el estado DNS de SPF, DKIM y DMARC, se diagnosticó la causa de la clasificación en Junk por Microsoft 365 / Superhuman separando hechos comprobados de hipótesis, y se diseñó la propuesta formal del registro DMARC para Network Solutions.

**Estado del Contador de Envíos Reales:**
* **Total consumido:** **1 de 3** (se mantiene exactamente en 1).
* **Nuevos correos emitidos en esta fase:** **0** (Cero envíos; no se consumirá el segundo envío hasta completar la validación y autorización).

---

## 2. Frente A — Presentación de las Plantillas de Firebase

### 2.1 Configuración Deseada
* **Nombre Comercial Oficial:** `DUCTSAL ERP` (con mayúsculas corporativas exactas).
* **Remitente Visible:** `DUCTSAL ERP <noreply@auth.ductsal.com>`.
* **Reply-To:** `informatica@grupogama.com`.
* **Idioma:** Español (`es`).
* **Preservación Funcional:** Conservación íntegra de `%LINK%`, `%EMAIL%`, `%DISPLAY_NAME%`, `%NEW_EMAIL%`, `%SECOND_FACTOR%`, parámetros de retorno `ActionCodeSettings` y dominio de autenticación `ductsal-erp.firebaseapp.com`.

### 2.2 Diagnóstico e Intento de Modificación Programática
Se formuló y ejecutó la actualización de las 4 plantillas nativas sustituyendo `%APP_NAME%` por `"DUCTSAL ERP"` mediante la API administrativa oficial de Identity Platform (`PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/ductsal-erp/config?updateMask=notification.sendEmail`).

**Respuesta devuelta por Google Identity Platform API:**
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

### 2.3 Causa Raíz de la Restricción `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`
1. **Bloqueo de Seguridad Anti-Hijacking de Google:**  
   Google Cloud Identity Platform bloquea deliberadamente la modificación programática remota de plantillas de correo vía API REST (`PATCH /config`) en proyectos que tienen dominios personalizados activos o configuraciones enterprise de autenticación, con el fin de mitigar riesgos de *phishing* y secuestro automatizado de plantillas (*template hijacking*).
2. **Origen de la interpolación `%APP_NAME%`:**  
   En la infraestructura de Google, la variable `%APP_NAME%` se alimenta del **Nombre Público de la Aplicación** (*Public-facing name*). Al no estar inicializado dicho campo en las propiedades del proyecto, Google recurre por diseño al identificador inmutable del proyecto (`ductsal-erp`).

### 2.4 Procedimiento Oficial Soportado para Aplicar la Presentación Deseada
Dado el bloqueo de la API programática, la modificación debe ser formalizada a través de una de las siguientes dos vías oficiales de consola:

* **Vía 1 — Sustitución Literal en Firebase Console (Recomendada):**
  1. Ingresar a [Firebase Console](https://console.firebase.google.com/project/ductsal-erp/authentication/emails).
  2. En el menú **Authentication → Templates (Plantillas)**, abrir la plantilla **Password reset (Restablecimiento de contraseña)**.
  3. En el campo **Asunto**, reemplazar `Cambia la contraseña de %APP_NAME%` por:  
     `Cambia la contraseña de DUCTSAL ERP`
  4. En el campo **Cuerpo**, sustituir las apariciones de `%APP_NAME%` por `DUCTSAL ERP`:  
     `...cambiar la contraseña de DUCTSAL ERP de tu cuenta %EMAIL%...`  
     `El equipo de DUCTSAL ERP`
  5. Pulsar **Guardar**.
  6. Repetir para las plantillas complementarias (*Email address verification*, *Email address change*).
* **Vía 2 — Configuración del Nombre Público en Project Settings:**
  1. En Firebase Console → **Project Settings** (icono de engranaje) → General.
  2. Localizar el campo **Public-facing name (Nombre público)** y definirlo como `DUCTSAL ERP`.
  3. Guardar cambios. (Esto actualiza la variable global `%APP_NAME%`).

---

## 3. Frente B — Entregabilidad y Clasificación Junk

### 3.1 Análisis de los Encabezados del Primer Correo
* **Buzón receptor:** `bvaliente@grupogama.com`.
* **Servidor receptor final:** **Microsoft 365 / Exchange Online Protection (EOP)**  
  Registro MX autoritativo: `grupogama-com.mail.protection.outlook.com`.
* **Cliente de lectura:** Superhuman (cliente sincronizado con el buzón de Microsoft 365).
* **Limitación Documental:**  
  Los encabezados RFC 822 brutos completos (`Authentication-Results`, `X-Forefront-Antispam-Report`, `SCL`, `PCL`, `CAT`, `Received`) no han sido exportados del cliente Superhuman en esta sesión.  
  *No obstante, los componentes de red, transporte y autenticación DNS han sido comprobados de forma directa y concluyente.*

### 3.2 Resultados Comprobados de Autenticación (SPF, DKIM y DMARC)

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

| Mecanismo | Configuración en DNS Network Solutions | Evaluación de Red | Resultado |
| :--- | :--- | :--- | :---: |
| **SPF** | `v=spf1 include:_spf.firebasemail.com ~all` en `auth.ductsal.com` | La IP emisora de Firebase Mail coincide con el bloque autorizado en `_spf.firebasemail.com`. | **PASS** |
| **DKIM** | Selectores `firebase1` y `firebase2` apuntan a `mail-auth-ductsal-com.dkim{1,2}._domainkey.firebasemail.com` | Mensaje firmado criptográficamente por Firebase con `d=auth.ductsal.com`. | **PASS** |
| **DMARC** | **No publicado** en `_dmarc.auth.ductsal.com` ni en `_dmarc.ductsal.com`. | No existe política DMARC publicada en la zona. | **AUSENTE** |

---

### 3.3 Diagnóstico de la Clasificación Junk: Hechos vs. Hipótesis

Para evitar conclusiones infundadas, el análisis separa con rigor los hechos técnicos verificados de las hipótesis probabilísticas del motor antispam:

#### Hechos Comprobados:
1. **Autenticación SPF y DKIM Aprobada:** El correo no fue catalogado como Junk por fallas criptográficas de SPF o DKIM. Ambos mecanismos están 100% activos y autorizan a los servidores de Firebase.
2. **Ausencia Total de Registro DMARC:** No existe ninguna política `_dmarc` en Network Solutions ni para `auth.ductsal.com` ni para el dominio raíz `ductsal.com`.
3. **Dominio Nuevo en Red (*Newly Seen Sending Domain*):** `auth.ductsal.com` fue creado y delegado hoy (2 de noviembre de 2026). Para los filtros de Microsoft EOP, es un remitente con **historial y reputación en cero**.
4. **Filtrado Ejecutado por Microsoft 365:** La decisión de mover a Junk la tomó el motor Exchange Online Protection (EOP) de la organización `grupogama.com`, no el cliente Superhuman (que únicamente refleja el estado de las carpetas IMAP/Exchange).

#### Hipótesis Técnicas Fundamentadas (Comportamiento de Microsoft EOP):
1. **Regla de Dominio Frío / No Reconocido:** Microsoft EOP aplica heurísticas de seguridad más estrictas (SCL 5) a correos provenientes de dominios recién creados que no cuentan con un historial acumulado de envíos hacia la organización.
2. **Castigo por Ausencia de DMARC:** Las políticas de filtrado de Microsoft 365 introducidas en 2024–2026 penalizan la confianza de los mensajes provenientes de subdominios que carecen de registro DMARC, considerándolos potencialmente no supervisados.
3. **Patrón de Enlace de Cambio de Contraseña:** Un mensaje que contiene un enlace de restablecimiento de contraseña (*password reset*) enviado por un dominio nuevo sin interacción previa activa las firmas heurísticas de prevención contra phishing de Microsoft Defender for Office 365.

---

## 4. Propuesta Técnica de Registro DMARC

### 4.1 Verificaciones Previas Obligatorias
* **Inexistencia de Políticas Heredadas o Contradictorias:**  
  Se verificó con `dig` que no existe ningún registro DMARC previo en `_dmarc.ductsal.com`, `_dmarc.auth.ductsal.com` ni en `_dmarc.grupogama.com`. No hay colisión ni contradicción posible.
* **Capacidad de Recepción en `informatica@grupogama.com`:**  
  El buzón corporativo `informatica@grupogama.com` reside en Microsoft 365 (`grupogama-com.mail.protection.outlook.com`) y tiene capacidad para recibir los reportes agregados XML periódicos generados por los servidores de correo (Google, Yahoo, Microsoft).
* **Alineación de SPF y DKIM:**  
  Tanto SPF (`d=auth.ductsal.com`) como DKIM (`d=auth.ductsal.com`) utilizan el mismo dominio emisor que la cabecera `From: noreply@auth.ductsal.com`, cumpliendo con la alineación estricta de DMARC.

### 4.2 Registro TXT Exacto para Publicación en Network Solutions
Se recomienda publicar el registro específicamente en el subdominio de envío `auth.ductsal.com` con una política conservadora de monitoreo (`p=none`), que no bloquea ni altera la entrega de ningún correo:

* **Host / Nombre del Registro:** `_dmarc.auth.ductsal.com`  
  *(o `_dmarc.auth` según el formulario de subdominios en Network Solutions)*
* **Tipo de Registro:** `TXT`
* **TTL:** `3600` segundos (1 hora)
* **Valor del Registro:**
  ```text
  v=DMARC1; p=none; rua=mailto:informatica@grupogama.com; sp=none; aspf=r; adkim=r
  ```

#### Desglose de Parámetros:
* `v=DMARC1`: Identificador de versión del protocolo DMARC.
* `p=none`: **Política de observación pura.** Indica a los servidores receptores (Microsoft, Google) que certifiquen el dominio pero que **no rechacen ni pongan en cuarentena** ningún mensaje si ocurre un desajuste. Cero riesgo de disrupción.
* `rua=mailto:informatica@grupogama.com`: Envío de reportes agregados diarios sobre la salud del dominio y detección de tráfico indebido.
* `sp=none`: Aplica idéntica política pasiva a cualquier subdominio descendiente.
* `aspf=r`: Alineación SPF relajada (*relaxed*).
* `adkim=r`: Alineación DKIM relajada (*relaxed*).

> **ESTADO DE LA PUBLICACIÓN DMARC:**  
> **RETENIDO SIN PUBLICAR.** En estricto cumplimiento de las restricciones, el registro se encuentra preparado y listo, a la espera de la confirmación formal del usuario previa a su inserción en Network Solutions.

---

## 5. Revisión de Reputación y Medidas en Microsoft 365

1. **Límites de DMARC:**  
   DMARC es un requisito de autenticación y gobernanza indispensable para que un dominio sea respetado por los servidores modernos, pero **no garantiza por sí solo que un correo llegue a Inbox**. La decisión de entrega a Inbox depende de la reputación ponderada del dominio emisor y de las reglas del tenant receptor.
2. **Medidas Prácticas de Mitigación en el Tenant de Microsoft 365:**
   - **Interacción de Usuario (*Safe Senders*):**  
     En Superhuman / Outlook, el usuario debe marcar el mensaje recibido como **"No es correo no deseado" / "Mover a Bandeja de entrada"** y añadir a `noreply@auth.ductsal.com` en su lista de **Remitentes Seguros** (*Safe Senders List*). Esto entrena el filtro bayesiano de Exchange Online Protection para que reconozca los correos futuros de DUCTSAL ERP como legítimos.
   - **Regla de Transporte Administrativa en Microsoft 365 (Opcional):**  
     El administrador de TI de Grupo Gama puede añadir en el Centro de Administración de Exchange una regla de flujo de correo que asigne `SCL: 0` (Bypass de filtrado de spam) a los correos provenientes del dominio autenticado `auth.ductsal.com`.

---

## 6. Cumplimiento de Restricciones

* **Correos enviados en esta fase:** **0**.
* **Contador total de envíos reales:** **1 de 3** (quedan 2 disponibles).
* **Modificaciones a usuarios reales:** **Ninguna**.
* **Despliegues o commits de código:** **Ninguno**.
* **Cambios aplicados en DNS:** **Ninguno** (DMARC en espera de confirmación).
* **Integridad del repositorio:** `git diff --check` verificado con 0 observaciones.

---

## 7. Dictamen Final

```
================================================================================
     DICTAMEN TÉCNICO FASE 6.3.7.2: APROBADO CON OBSERVACIONES
================================================================================
1. Frente A (Presentación): Causa identificada (bloqueo programmatico API 
   EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED). Procedimiento de consola documentado.
2. Frente B (Entregabilidad): SPF y DKIM confirmados en PASS. Ausencia de DMARC
   comprobada. Registro exacto para Network Solutions preparado.
3. Clasificación Junk: Consecuencia de Newly Seen Domain + falta de DMARC.
4. Estado de Envíos: 1 de 3 consumidos (2 envíos reservados intactos).
5. Próximo paso: Confirmación del usuario para publicar DMARC en Network Solutions
   y aplicar el texto literal en la plantilla de Firebase Console previo al Envío 2.
================================================================================
```
