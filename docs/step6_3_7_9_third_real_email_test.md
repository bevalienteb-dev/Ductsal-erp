# FASE 6.3.7.9 — TERCERA Y ÚLTIMA PRUEBA REAL DE CORREO: IMPACTO DE «NOT JUNK» Y CIERRE DE PRESUPUESTO

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha de Ejecución:** 2 de Noviembre de 2026 (21:25 CST / 03:25 UTC del 3 de Noviembre)  
**Documento:** Informe Técnico de Despacho del Envío 3, Cierre de Presupuesto y Comparativa de Entregabilidad  
**Estado:** **ENVÍO 3 DESPACHADO (HTTP 200 OK) — PRESUPUESTO 3/3 CERRADO — EN ESPERA DE INSPECCIÓN DE CARPETA Y ENCABEZADOS**  
**Dictamen Parcial:** **PREFLIGHT APROBADO — DESPACHO COMPLETADO — PRESUPUESTO AGOTADO AL 100% (NO HABRÁ MÁS ENVÍOS)**  

---

## 1. Resumen Ejecutivo y Cierre Definitivo de Presupuesto

En cumplimiento estricto de la autorización para la **Fase 6.3.7.9**, tras la acción manual del usuario de marcar el Envío 2 como **«No es correo no deseado»** (*Not Junk*) en `bvaliente@grupogama.com`, se consumió el **tercer y último correo real** autorizado para DUCTSAL ERP.

### 1.1 Consolidación Final del Presupuesto de Pruebas Reales
| Envío | Timestamp (UTC / CST) | Propósito Técnico | Resultado de Autenticación | Clasificación en Buzón |
| :---: | :--- | :--- | :---: | :---: |
| **Envío 1** | `2026-11-03T02:03:58Z` (20:03 CST) | Invitación inicial / Establecimiento de credencial | SPF Pass, DKIM Pass, DMARC ausente | Junk (Falta de DMARC) |
| **Envío 2** | `2026-11-03T03:17:01Z` (21:17 CST) | Recuperación con DMARC activo (`p=none`) | **SPF Pass, DKIM Pass, DMARC Pass, Compauth Pass** | Junk (SCL: 5 por dominio nuevo) |
| **Envío 3** | `2026-11-03T03:24:39Z` (21:24 CST) | Recuperación tras marcación manual «Not Junk» | Despacho HTTP 200 OK confirmado | *Pendiente de inspección* |

* **Presupuesto consumido:** **3 de 3 correos utilizados (100% AGOTADO)**.
* **Prohibición estricta:** **Queda terminantemente prohibido realizar un cuarto envío bajo cualquier circunstancia.**

---

## 2. Fase de Preflight de Solo Lectura (Pre-Despacho 3)

A las `2026-11-03T03:24:34Z`, se comprobó que todos los componentes se encontraban intactos:

* **Identity Platform API v2:** `projects/948658286825/config` (**PASS**).
* **Remitente visible:** `DUCTSAL ERP <noreply@auth.ductsal.com>` (**PASS**).
* **Reply-To:** `informatica@grupogama.com` (**PASS**).
* **Custom Domain:** `auth.ductsal.com` (`useCustomDomain: true`) (**PASS**).
* **Registro DMARC:** `v=DMARC1; p=none; sp=none; aspf=r; adkim=r` (**PASS**).
* **Registro SPF:** `v=spf1 include:_spf.firebasemail.com ~all` (**PASS**).
* **Registros DKIM:** Selectores CNAME `firebase1` y `firebase2` activos (**PASS**).

---

## 3. Registro Técnico del Envío 3 (Despacho Final)

* **Destinatario autorizado exclusivamente:** `bvaliente@grupogama.com`.
* **Operación:** Despacho nativo de restablecimiento (`PASSWORD_RESET`) vía Firebase Identity Platform (`/v1/accounts:sendOobCode`).
* **Fecha y Hora del Despacho:** `2026-11-03T03:24:39.056Z` (Local: `2026-11-02 21:24:39 CST`).
* **URL de Retorno / ActionCodeSettings:** `https://erp.ductsal.com/login?mode=activate` (`handleCodeInApp: false`).
* **Respuesta de la API de Firebase:**
  ```json
  {
    "httpStatus": 200,
    "email": "bvaliente@grupogama.com",
    "success": true,
    "hasOobCode": false,
    "error": null
  }
  ```
* **Higiene de Secretos:** Cero exposición de `oobCode` en el cliente local. Mensaje aceptado por la infraestructura de Firebase para entrega directa al servidor MX de Microsoft 365 (`grupogama-com.mail.protection.outlook.com`).
* **Regla de Operación:** **No se debe redimir el enlace de restablecimiento recibido en este envío**, a fin de preservar la validez del token y las credenciales existentes.

---

## 4. Parámetros a Comparar con el Envío 2

Una vez que el usuario proporcione los datos o encabezados brutos del Envío 3, se auditará la siguiente matriz comparativa:

| Métrica / Cabecera | Envío 2 (Llegó a Junk) | Envío 3 (Tras acción «Not Junk») | Hipótesis / Objetivo |
| :--- | :---: | :---: | :--- |
| **Carpeta de Destino** | `dest: J` (Junk) | *Pendiente* | Comprobar si se entregó en **Inbox** o si persistió en **Junk**. |
| **Spam Confidence Level (SCL)** | `SCL: 5` | *Pendiente* | Comprobar si disminuyó (`SCL: 1`, `SCL: 0` o `SCL: -1` por remitente seguro). |
| **Spam Filtering Verdict (SFV)** | `SFV: SPM` | *Pendiente* | Comprobar si cambió a `SFV: SFE` (*Safe Sender List*) o `SFV: NSPM` (*Not Spam*). |
| **Categoría Antispam (CAT)** | `CAT: SPM` | *Pendiente* | Comprobar si cambió a `CAT: NONE` o `CAT: SFE`. |
| **Authentication-Results** | `spf=pass; dkim=pass; dmarc=pass; compauth=pass` | *Pendiente* | Verificar mantenimiento de la tríada criptográfica en PASS. |
| **Inference Classification** | `focused` | *Pendiente* | Verificar clasificación inteligente en Superhuman/Outlook. |

---

## 5. Advertencia Técnica Fundamental sobre el Alcance del Resultado

> [!WARNING]
> **ALCANCE Y VALIDEZ DEL RESULTADO:**  
> Si el Envío 3 aterriza con éxito en la **Bandeja de Entrada (Inbox)** de `bvaliente@grupogama.com` gracias a la acción previa de «No es correo no deseado»:
> 1. Esto demuestra que los mecanismos de retroalimentación de usuario de Microsoft 365 / Exchange Online Protection están operativos para ese buzón individual.
> 2. **NO demuestra ni constituye una garantía de entrega directa en Inbox para otros destinatarios** (por ejemplo, nuevos colaboradores que jamás hayan interactuado con `auth.ductsal.com`).
> 3. **NO demuestra entregabilidad garantizada hacia otros proveedores de correo** (Gmail, Yahoo, iCloud, etc.), los cuales mantienen sus propios motores de reputación independientes.
> 4. La reputación global de un dominio nuevo (`auth.ductsal.com`) se construye de forma acumulativa a lo largo del tiempo con el volumen continuo de correos abiertos y la ausencia de quejas de spam.

---

## 6. Dictamen Parcial y Próxima Acción

```
================================================================================
               DICTAMEN TÉCNICO FASE 6.3.7.9: EN ESPERA DE FEEDBACK
================================================================================
1. Preflight: 100% APROBADO (Parámetros verificados).
2. Envío 3: DESPACHADO (HTTP 200 OK) hacia bvaliente@grupogama.com.
3. Timestamp: 2026-11-03T03:24:39.056Z
4. Presupuesto Real: 3 de 3 consumidos (CIERRE DEFINITIVO).
5. Siguiente Acción: Solicitar al usuario confirmar la carpeta de llegada (Inbox vs Junk) 
   y compartir los encabezados RFC 822 brutos para completar la comparativa técnica.
================================================================================
```
