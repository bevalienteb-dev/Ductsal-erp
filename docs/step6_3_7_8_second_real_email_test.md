# FASE 6.3.7.8 — SEGUNDA PRUEBA REAL DE CORREO FIREBASE NATIVE: ANÁLISIS DE ENCABEZADOS Y AUTENTICACIÓN

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha de Ejecución:** 2 de Noviembre de 2026 (21:25 CST / 03:25 UTC del 3 de Noviembre)  
**Documento:** Informe Técnico de Auditoría de Encabezados RFC 822, Evaluación Criptográfica y Clasificación EOP  
**Estado:** **SEGUNDA PRUEBA REAL COMPLETADA — ENCABEZADOS RFC 822 AUDITADOS AL 100%**  
**Dictamen Técnico:** **AUTENTICACIÓN CRIPTOGRÁFICA Y DMARC: APROBADA AL 100% (SPF PASS, DKIM PASS, DMARC PASS). CLASIFICACIÓN: JUNK POR REPUTACIÓN DE DOMINIO NUEVO (SCL: 5).**  

---

## 1. Resumen Ejecutivo de la Prueba

Se ejecutó la segunda prueba real de correo nativo de Firebase Authentication hacia el buzón autorizado `bvaliente@grupogama.com` para auditar el impacto directo de la publicación del registro DMARC (`v=DMARC1; p=none`) en los servidores de correo de destino (Microsoft 365 / Exchange Online Protection).

### 1.1 Control Riguroso del Presupuesto de Envíos
* **Límite total autorizado:** Máximo 3 correos reales.
* **Envío 1 (Fase 6.3.7):** Despachado el `2026-11-03T02:03:58Z` (Sin DMARC publicado en ese momento).
* **Envío 2 (Fase 6.3.7.8):** Despachado el `2026-11-03T03:17:01Z` (Con SPF, DKIM y DMARC activos).
* **Contador consolidado:** **2 de 3 envíos consumidos** (1 envío de reserva intacto).
* **Mutaciones productivas:** **0 usuarios creados, 0 contraseñas modificadas, 0 cambios de código, 0 cambios de DNS**.

---

## 2. Análisis Exhaustivo de Encabezados RFC 822 Recibidos

A partir del volcado de metadatos de red y encabezados de Internet proporcionados directamente desde Microsoft Graph / Exchange Online, se constatan los siguientes valores brutos:

### 2.1 Encabezados de Autenticación Críticos

#### A. `Authentication-Results`
```text
mx.microsoft.com 1;
spf=pass (sender IP is 2607:f8b0:4864:20::247) smtp.mailfrom=auth.ductsal.com;
dkim=pass (signature was verified) header.d=auth.ductsal.com;
dmarc=pass action=none header.from=auth.ductsal.com;
compauth=pass reason=100
```

#### B. `Received-SPF`
```text
Pass (protection.outlook.com: domain of auth.ductsal.com designates 2607:f8b0:4864:20::247 as permitted sender)
receiver=protection.outlook.com;
client-ip=2607:f8b0:4864:20::247;
helo=mail-oi1-x247.google.com;
pr=C
```

#### C. `DKIM-Signature`
```text
v=1; a=rsa-sha256; c=relaxed/relaxed;
d=auth.ductsal.com; s=firebase2; t=1793675822; x=1794280622; darn=grupogama.com;
h=content-type:to:from:subject:date:message-id:reply-to:mime-version:from:to:cc:subject:date:message-id:reply-to:content-type;
bh=DXH6Tzw5dacDsO9K/OfiEkOH/lP2oCpbMjhMsKmsq0c=;
b=NxMjCUhLVjjxMfKb12L8tmcd2pyMeuJD54wNRwfym/TffpC8HgNinNXPoo92zFn5QB...
```

#### D. Metadatos de Transporte e Identidad
* **`From:`** `"DUCTSAL ERP" <noreply@auth.ductsal.com>`
* **`Return-Path:`** `noreply@auth.ductsal.com`
* **`Reply-To:`** `<informatica@grupogama.com>`
* **`Date:`** `Tue, 3 Nov 2026 03:17:01 +0000`
* **`Message-ID:`** `<00000000000034882f065f56b2c8@google.com>`
* **`Subject:`** `Cambia la contraseña de ductsal-erp`
* **Servidor emisor verificado:** `mail-oi1-x247.google.com` (`2607:f8b0:4864:20::247`)
* **Servidor receptor de Microsoft:** `DM3PEPF000265C1.mail.protection.outlook.com` (Microsoft 365 EOP)

---

## 3. Determinaciones Individuales de Autenticación

| Mecanismo | Evaluación de Microsoft 365 | Dominio / Selector Evaluado | Alineación con `From: auth.ductsal.com` | Dictamen Técnico |
| :--- | :---: | :---: | :---: | :---: |
| **SPF** | **`PASS`** | `smtp.mailfrom=auth.ductsal.com` | **ALINEADO** (`auth.ductsal.com` == `auth.ductsal.com`) | **100% APROBADO** |
| **DKIM** | **`PASS`** | `d=auth.ductsal.com`, `s=firebase2` | **ALINEADO** (`auth.ductsal.com` == `auth.ductsal.com`) | **100% APROBADO** |
| **DMARC** | **`PASS`** | `header.from=auth.ductsal.com` | **ALINEADO** (`action=none`) | **100% APROBADO** |
| **Composite Auth** | **`PASS`** | `compauth=pass` (`reason=100`) | N/A | **100% APROBADO** |

### Conclusiones Criptográficas:
1. **La tríada de autenticación está impecable:** Por primera vez en la historia de DUCTSAL ERP, un mensaje enviado desde Firebase Authentication pasa simultáneamente **SPF, DKIM y DMARC en estado PASS** en los servidores de Microsoft 365.
2. **Alineación total:** La identidad visible (`auth.ductsal.com`), la identidad técnica de rebote (`Return-Path: auth.ductsal.com`) y la firma criptográfica (`d=auth.ductsal.com`) coinciden plenamente.
3. **`compauth=pass reason=100`:** Microsoft 365 certifica que el correo no es una suplantación de identidad (*anti-spoofing certified*).

---

## 4. Diagnóstico de la Clasificación en Microsoft 365 (Carpeta Junk y SCL: 5)

A pesar de que la autenticación criptográfica obtuvo **100% PASS**, el mensaje fue entregado en la carpeta de Correo no deseado (**Junk**). El análisis de los encabezados internos de filtrado antispam de Microsoft explica la causa exacta:

### 4.1 Encabezados de Filtrado Antispam Observados
* **`X-MS-Exchange-Organization-SCL`:** `5` (Spam Confidence Level 5: Clasificado como Spam).
* **`X-Forefront-Antispam-Report`:**
  * `CAT: SPM` (Categoría: Spam por contenido/reputación).
  * `SFV: SPM` (Spam Filtering Verdict: Spam).
  * `IPV: NLI` (*IP Not Listed / Neutral IP* — Sin lista negra pero sin reputación consolidada previa).
  * `SFS: (13230040)(704162011799003)...` (Reglas bayesianas de filtrado heurístico ejecutadas).
* **`X-Microsoft-Antispam-Mailbox-Delivery`:**
  * `dest: J` (Destination: Junk).
  * `RF: JunkEmail` (Reason Folder: Junk Email).
  * `OFR: SpamFilterAuthJ` (Override Filter Reason: Filtro de spam autenticado a Junk).

### 4.2 Causa Raíz Técnica de la Clasificación en Junk
1. **Ausencia de Reputación Histórica del Subdominio (`auth.ductsal.com`):**  
   El subdominio de envío `auth.ductsal.com` tiene menos de 24 horas de haber sido creado y configurado en DNS. En los algoritmos de filtrado de Microsoft Defender / Exchange Online Protection, los dominios nuevos con volumen de tráfico casi nulo carecen de historial reputacional (*domain warming*).
2. **Naturaleza del Contenido (Enlaces Transaccionales con Tokens):**  
   El correo contiene enlaces de restablecimiento de contraseña (`/__/auth/action?mode=resetPassword&oobCode=...`). Los filtros heurísticos de Microsoft son especialmente cautelosos con dominios nuevos que envían solicitudes de cambio de credenciales, asignándoles preventivamente un SCL de 5 hasta que el dominio madura.
3. **Diferenciación Crucial:**  
   * **El problema de autenticación está RESUELTO:** Microsoft ya NO marca el correo como "no autenticado" ni como "posible suplantación" (`compauth=pass`).
   * **El desafío restante es de REPUTACIÓN:** La transición de Junk a Inbox se logra de forma orgánica y progresiva cuando los usuarios internos de la organización marcan el correo como **«No es correo no deseado»** (*Not Junk*) o agregan `noreply@auth.ductsal.com` a la lista de remitentes seguros (*Safe Senders*) de Microsoft 365.

---

## 5. Verificación de Identidad Visual y Experiencia

| Elemento | Valor Observado en el Correo | Estado |
| :--- | :--- | :---: |
| **Nombre del Remitente** | `DUCTSAL ERP` | **Conforme** |
| **Dirección del Remitente** | `noreply@auth.ductsal.com` | **Conforme** |
| **Reply-To** | `informatica@grupogama.com` | **Conforme** |
| **Asunto** | `Cambia la contraseña de ductsal-erp` | **Conforme con limitación documentada** |
| **Idioma del Cuerpo** | Español (`es`) | **Conforme** |
| **Enlace de Acción** | Apunta al handler nativo de Firebase con redirección al ERP | **Conforme** |
| **Firma del Cuerpo** | `El equipo de ductsal-erp` | **Conforme con limitación documentada** |

---

## 6. Dictamen Final de la Fase 6.3.7.8

```
================================================================================
               DICTAMEN TÉCNICO FASE 6.3.7.8: APROBADO
================================================================================
1. Autenticación Criptográfica:
   - SPF: PASS (Alineado con auth.ductsal.com).
   - DKIM: PASS (Firma verificada d=auth.ductsal.com, selector firebase2).
   - DMARC: PASS (action=none, header.from=auth.ductsal.com).
   - Composite Auth: compauth=pass reason=100.
2. Identidad del Remitente:
   - "DUCTSAL ERP" <noreply@auth.ductsal.com> (100% verificado y presentado).
   - Reply-To: informatica@grupogama.com (100% verificado).
3. Entregabilidad en Microsoft 365:
   - SCL: 5 / Clasificado en Junk por ausencia de reputación previa del subdominio 
     (comportamiento estándar de Microsoft EOP ante dominios nuevos).
   - El correo NO fue rechazado ni puesto en cuarentena administrativa.
4. Presupuesto de Envíos:
   - 2 de 3 correos consumidos (1 envío restante de reserva intacto).
================================================================================
```

### Recomendación Operativa:
En el buzón de `bvaliente@grupogama.com`, marcar el correo recibido como **«No es correo no deseado»** (*Report as Not Junk / Add to Safe Senders*). Esto informa a los clasificadores bayesianos de Microsoft 365 que `auth.ductsal.com` es un remitente legítimo para Grupo Gama, iniciando el calentamiento de reputación (*domain reputation warming*) hacia la bandeja de entrada principal.
