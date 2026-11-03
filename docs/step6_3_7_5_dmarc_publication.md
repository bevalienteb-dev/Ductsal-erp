# FASE 6.3.7.5 — PUBLICACIÓN Y VALIDACIÓN DEL REGISTRO DMARC EN NETWORK SOLUTIONS

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha de Validación:** 2 de Noviembre de 2026 (21:01 CST / 03:01 UTC del 3 de Noviembre)  
**Documento:** Informe Técnico de Publicación, Diagnóstico Autoritativo y Verificación de Propagación DNS de DMARC  
**Estado:** **PUBLICADO Y PROPAGADO EXITOSAMENTE**  
**Dictamen Técnico:** **APROBADO — 100% OPERATIVO EN SERVIDORES AUTORITATIVOS Y RECURSIVOS**  

---

## 1. Resumen Ejecutivo de la Publicación

En cumplimiento de la autorización expresa del usuario, se completó la publicación y validación técnica del registro TXT DMARC para el subdominio de autenticación de DUCTSAL ERP en Network Solutions:

```text
================================================================================
REGISTRO DMARC PUBLICADO EN NETWORK SOLUTIONS
================================================================================
Dominio / Zona:      ductsal.com
Host / Subdominio:   _dmarc.auth
FQDN Completo:       _dmarc.auth.ductsal.com
Tipo de Registro:    TXT
TTL:                 3600 segundos (1 hora)
Valor Verificado:    v=DMARC1; p=none; sp=none; aspf=r; adkim=r
================================================================================
```

---

## 2. Verificación en Servidores de Nombres Autoritativos

Se realizaron consultas directas mediante `dig` a los servidores DNS autoritativos de Network Solutions para el dominio `ductsal.com`:

* **Fecha y hora de consulta:** `2026-11-03T03:00:22Z` (21:00:22 CST).
* **Servidor 1:** `ns25.worldnic.com` (`162.159.26.132`)
* **Servidor 2:** `ns26.worldnic.com` (`162.159.27.77`)

### 2.1 Evidencia Autoritativa (`ns25.worldnic.com`)
```text
$ dig @ns25.worldnic.com _dmarc.auth.ductsal.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 3074
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
;; QUESTION SECTION:
;_dmarc.auth.ductsal.com. IN TXT

;; ANSWER SECTION:
_dmarc.auth.ductsal.com. 3600 IN TXT "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"

;; Query time: 118 msec
;; SERVER: 162.159.26.132#53(162.159.26.132)
```

### 2.2 Evidencia Autoritativa (`ns26.worldnic.com`)
```text
$ dig @ns26.worldnic.com _dmarc.auth.ductsal.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 2122
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
;; QUESTION SECTION:
;_dmarc.auth.ductsal.com. IN TXT

;; ANSWER SECTION:
_dmarc.auth.ductsal.com. 3600 IN TXT "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"

;; Query time: 305 msec
;; SERVER: 162.159.27.77#53(162.159.27.77)
```

* **Dictamen Autoritativo:** Ambos servidores de nombres de Network Solutions confirman la existencia del registro con la bandera de respuesta autoritativa (`flags: aa`), código `NOERROR`, exactamente 1 respuesta (`ANSWER: 1`) y el valor idéntico al autorizado.

---

## 3. Verificación de Propagación en Resolvers Recursivos Públicos

Se consultaron múltiples resolvers públicos mundiales para evaluar la propagación global del registro:

### 3.1 Google Public DNS (`dns.google`)
* **Consulta:** DNS-over-HTTPS (DoH) API de Google (`https://dns.google/resolve?name=_dmarc.auth.ductsal.com&type=TXT`)
* **Respuesta recibida:**
  ```json
  {
    "Status": 0,
    "Answer": [
      {
        "name": "_dmarc.auth.ductsal.com.",
        "type": 16,
        "TTL": 3600,
        "data": "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"
      }
    ],
    "Comment": "Response from 162.159.26.132."
  }
  ```
* **Estado:** **Propagado (Status 0 / NOERROR)**.

### 3.2 Cloudflare DNS (`cloudflare-dns.com` / `1.1.1.1`)
* **Consulta:** DNS-over-HTTPS (DoH) API de Cloudflare (`https://cloudflare-dns.com/dns-query?name=_dmarc.auth.ductsal.com&type=TXT`)
* **Respuesta recibida:**
  ```json
  {
    "Status": 0,
    "Answer": [
      {
        "name": "_dmarc.auth.ductsal.com",
        "type": 16,
        "TTL": 3600,
        "data": "\"v=DMARC1; p=none; sp=none; aspf=r; adkim=r\""
      }
    ]
  }
  ```
* **Estado:** **Propagado (Status 0 / NOERROR)**.

### 3.3 Quad9 (`9.9.9.9`)
```text
$ dig @9.9.9.9 _dmarc.auth.ductsal.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 62309
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
;; ANSWER SECTION:
_dmarc.auth.ductsal.com. 3600 IN TXT "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"
```
* **Estado:** **Propagado (Status NOERROR / ANSWER: 1)**.

### 3.4 OpenDNS (`208.67.222.222`)
```text
$ dig @208.67.222.222 _dmarc.auth.ductsal.com TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 19549
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
;; ANSWER SECTION:
_dmarc.auth.ductsal.com. 3600 IN TXT "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"
```
* **Estado:** **Propagado (Status NOERROR / ANSWER: 1)**.

---

## 4. Validación Técnica de Parámetros y Alcance

1. **Sintaxis DMARC:** 100% válida bajo RFC 7489 §6.3.
2. **Unicidad:** Exactamente un solo registro TXT DMARC publicado en `_dmarc.auth.ductsal.com`.
3. **Política efectiva `p=none`:**
   * Es una política de **monitoreo/observación pura**.
   * Indica a los servidores receptores (Microsoft 365, Google Workspace, Yahoo) que el dominio emisor está supervisado y certificado con DMARC, pero que **no deben rechazar (`reject`) ni poner en cuarentena (`quarantine`)** ningún mensaje en caso de anomalía.
   * *Aclaración técnica:* DMARC `p=none` cumple con los requisitos de autenticación modernos para evitar penalizaciones antispam, pero **no constituye una garantía matemática de entrega a Inbox**, ya que los motores bayesianos evalúan adicionalmente la reputación del remitente y el contenido.
4. **Política de subdominios `sp=none`:** Confinada pasivamente a cualquier eventual subdominio descendiente de `auth.ductsal.com`.
5. **Alineación SPF y DKIM (`aspf=r`, `adkim=r`):** En modo relajado, asegurando perfecta compatibilidad con el remitente real `noreply@auth.ductsal.com` y los servidores de correo de Firebase.
6. **Alcance Estricto y No Interferencia:**
   * La política protege **únicamente la identidad de envío del subdominio `auth.ductsal.com`**.
   * El registro `_dmarc.ductsal.com` en la raíz permanece **completamente intacto e inexistente (sin cambios)**.
   * El flujo de correo corporativo habitual de Microsoft 365 (`@ductsal.com`) y el SPF raíz (`include:spf.protection.outlook.com -all`) **no fueron modificados ni interferidos**.

---

## 5. Auditoría de Integridad: Registros Existentes Intactos

| Registro | Servidor de Consulta | Respuesta Observada | Estado |
| :--- | :--- | :--- | :---: |
| **SPF `auth.ductsal.com`** | `ns25.worldnic.com` | `v=spf1 include:_spf.firebasemail.com ~all` | **Intacto (PASS)** |
| **Verificación Firebase** | `ns25.worldnic.com` | `firebase=ductsal-erp` | **Intacto** |
| **DKIM 1 (`firebase1`)** | `ns25.worldnic.com` | `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com.` | **Intacto (PASS)** |
| **DKIM 2 (`firebase2`)** | `ns25.worldnic.com` | `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com.` | **Intacto (PASS)** |
| **DMARC Raíz (`ductsal.com`)** | `ns25.worldnic.com` | `ANSWER: 0` (Sin registro TXT) | **Intacto (Sin cambios)** |
| **SPF Raíz (`ductsal.com`)** | `ns25.worldnic.com` | `v=spf1 include:spf.protection.outlook.com -all` | **Intacto (Sin cambios)** |
| **MX Raíz (`ductsal.com`)** | `ns25.worldnic.com` | `ductsal-com.mail.protection.outlook.com` | **Intacto (Sin cambios)** |

---

## 6. Dictamen Final

```
================================================================================
               DICTAMEN TÉCNICO FASE 6.3.7.5: APROBADO
================================================================================
1. Registro publicado:
   Host: _dmarc.auth | Tipo: TXT | TTL: 3600
   Valor: v=DMARC1; p=none; sp=none; aspf=r; adkim=r
2. Verificación autoritativa: ns25 y ns26.worldnic.com responden con NOERROR, aa
   y exactamente el valor esperado.
3. Propagación global: Confirmada en Google DoH, Cloudflare DoH, Quad9 y OpenDNS.
4. Parámetros: p=none, sp=none, aspf=r, adkim=r, sintaxis 100% válida.
5. Aislamiento: Cero modificaciones a Microsoft 365, SPF raíz ni Grupo Gama.
6. Estado de Envíos: 1 de 3 consumidos (2 envíos reservados disponibles).
================================================================================
```
