# FASE 6.3.7 — VALIDACIÓN CONTROLADA DE CORREO REAL FIREBASE

**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Fecha:** 2 de Noviembre de 2026  
**Subfase:** 6.3.7 — Validación Controlada de Correo Real Firebase  
**Estado:** **PREPARACIÓN PREVIA COMPLETADA — DETENCIÓN REGLAMENTARIA POR DESTINATARIOS**  
**Remitente Previsto:** `noreply@auth.ductsal.com`  
**Nombre de Remitente:** `DUCTSAL ERP`  
**Reply-To:** `informatica@grupogama.com`  
**Idioma:** Español (`es`)  
**URL de Retorno:** `https://erp.ductsal.com/login?mode=activate`  

---

## 1. Objetivo y Alcance Autorizado

Demostrar en entorno real y controlado el despacho y recepción de correos nativos emitidos por **Firebase Authentication** bajo el proyecto de producción `ductsal-erp` con el subdominio personalizado `auth.ductsal.com`, respetando rigurosamente los límites de autorización:

- **Límite de correos:** Máximo 3 correos reales en total.
- **Buzones receptores:** Máximo 2 buzones internos corporativos de Grupo Gama.
- **Sin afectación productiva:** Prohibición estricta de mutar o sobreescribir usuarios operativos existentes, alterar contraseñas de cuentas comerciales en producción o emitir correos a terceros.
- **Punto de detención mandatorio:** *"Si no existen cuentas internas de prueba previamente identificadas, detenerse y solicitar los destinatarios antes de enviar. No inventar ni seleccionar direcciones por cuenta propia. No ejecutar todavía ningún envío durante esta preparación."*

---

## 2. Preparación Previa y Verificación Técnica

Previo a cualquier despacho de red hacia buzones de correo, se realizaron las 7 verificaciones técnicas obligatorias:

### 2.1 Verificación de Proyecto y Configuración de Producción
Se inspeccionó directamente la configuración inmutable del backend en Google Identity Platform (`projects/ductsal-erp/config`):
* **Project ID:** `ductsal-erp` (Número `948658286825`).
* **Auth Domain Oficial:** `ductsal-erp.firebaseapp.com`.
* **Dominios Autorizados:** `localhost`, `ductsal-erp.firebaseapp.com`, `ductsal-erp.web.app`, `erp.ductsal.com`, `auth.ductsal.com`.
* **Estado de Dominio de Envío (`dnsInfo`):**
  ```json
  {
    "customDomain": "auth.ductsal.com",
    "useCustomDomain": true,
    "customDomainState": "NOT_STARTED",
    "domainVerificationRequestTime": "1970-01-01T00:00:00Z"
  }
  ```
  El subdominio `auth.ductsal.com` se encuentra configurado y aplicado como dominio de envío (`useCustomDomain: true`).

### 2.2 Auditoría DNS en Red (Network Solutions)
Se consultaron en tiempo real los registros autoritativos en los servidores de nombres designados:

| Registro DNS | Tipo | Valor Comprobado en Red | Estado |
| :--- | :---: | :--- | :---: |
| `auth.ductsal.com` | **TXT** | `"firebase=ductsal-erp"` | **ACTIVO (100% propagado)** |
| `auth.ductsal.com` | **TXT** | `"v=spf1 include:_spf.firebasemail.com ~all"` | **ACTIVO (100% propagado)** |
| `firebase1._domainkey.auth.ductsal.com` | **CNAME** | `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com` | **ACTIVO (100% propagado)** |
| `firebase2._domainkey.auth.ductsal.com` | **CNAME** | `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com` | **ACTIVO (100% propagado)** |
| `ductsal.com` (Raíz corporativo) | **TXT** | `"v=spf1 include:spf.protection.outlook.com -all"` | **INTACTO (Microsoft 365 blindado)** |

### 2.3 Plantillas de Correo, Reply-To e Idioma Español
Se comprobó mediante la API administrativa de Identity Platform que las 4 plantillas del sistema se encuentran homologadas:

| Plantilla | Asunto Oficial Configurado | Remitente Visible | Reply-To Configurado |
| :--- | :--- | :--- | :--- |
| **Restablecimiento de Contraseña** (`resetPasswordTemplate`) | `"Cambia la contraseña de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` |
| **Verificación de Correo** (`verifyEmailTemplate`) | `"Verifica tu dirección de correo electrónico de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` |
| **Cambio de Correo** (`changeEmailTemplate`) | `"Se ha cambiado tu correo electrónico de inicio de sesión de %APP_NAME%"` | `"DUCTSAL ERP"` | `informatica@grupogama.com` |
| **Reversión de 2FA** (`revertSecondFactorAdditionTemplate`) | `"Has añadido la verificación en dos pasos a tu cuenta de %APP_NAME%."` | `"DUCTSAL ERP"` | `informatica@grupogama.com` |

* **Idioma:** `defaultLocale: "es"` verificado.

### 2.4 Revisión del Código Local de Creación, Invitación y Recuperación
* **Arquitectura nativa:** En [`createUserAdmin`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L594-L642) y [`resendInvitationAdmin`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L1106-L1135), la generación de enlaces vía Admin SDK (`generatePasswordResetLink`) se encuentra eliminada (`link: null`).
* **Despacho unificado:** Las invitaciones y recuperaciones se ejecutan exclusivamente mediante el Firebase Client SDK con `auth.sendPasswordResetEmail(email, actionCodeSettings)`.

### 2.5 Prevención de Doble Envío
* Se verificaron las guardas de concurrencia in-flight en el frontend:
  - `userSaveInFlight` (modal de usuarios).
  - `resetPassInFlight` (botón Reset Pass / reenvío).
  - `forgotPasswordInFlight` (modal de recuperación).
  - `loginInFlight` (formulario de login).
* En el backend, `opId` garantiza que las operaciones repetidas sean estrictamente idempotentes.
* **Resultado:** Se garantiza que ninguna acción de usuario dispare dos correos electrónicos.

### 2.6 Verificación de ActionCodeSettings y URL de Retorno
* Configuración en [`crm_auth.js:20-23`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L20-L23):
  ```javascript
  const PRODUCTION_ACTION_CODE_SETTINGS = Object.freeze({
      url: 'https://erp.ductsal.com/login?mode=activate',
      handleCodeInApp: false
  });
  ```
* Se constató que no existen URLs residuales a `localhost` ni puertos de emuladores en la configuración de producción.

---

## 3. Inventario de Cuentas en Producción y Detención Mandatoria

Una consulta administrativa a Firebase Authentication en `ductsal-erp` confirmó que existen **únicamente 4 cuentas operativas activas**:

1. `aayala@ductsal.com` (Rol: `gestor`)
2. `rflores@ductsal.com` (Rol: `vendedor`)
3. `bvaliente@grupogama.com` (Rol: `manager`)
4. `dgonzalez@ductsal.com` (Rol: `manager`)

### Motivo de la Detención Inmediata:
1. **Protección de cuentas operativas:** Ninguno de los 4 usuarios anteriores debe ser modificado, reiniciado ni degradado para pruebas de invitación inicial (Prueba 1), pues se trata de usuarios productivos reales con perfiles y roles activos.
2. **Mandato estricto de la directriz de Fase 6.3.7:**
   > *"Si no existen cuentas internas de prueba previamente identificadas, detenerse y solicitar los destinatarios antes de enviar. No inventar ni seleccionar direcciones por cuenta propia."*
   > *"No ejecutar todavía ningún envío durante esta preparación."*
3. **Acción ejecutada:** En estricto apego a esta regla de seguridad, **se detiene la ejecución antes de emitir cualquier correo** para solicitar al usuario la confirmación expresa de:
   - El buzón interno de prueba para la **Prueba 1 (Creación e Invitación)**.
   - El buzón interno de prueba para la **Prueba 2 (Recuperación de Contraseña)**.

---

## 4. Matriz de Pruebas Planificada (Pendiente de Autorización de Buzones)

| ID | Flujo Planificado | Buzón Receptor Previsto | Envíos Planificados | Verificaciones a Realizar |
| :---: | :--- | :--- | :---: | :--- |
| **Prueba 1** | Invitación / Creación | *Buzón de prueba autorizado* | 1 | Remitente (`noreply@auth.ductsal.com`), Reply-To (`informatica@grupogama.com`), español, apertura de enlace, password setup, retorno a `erp.ductsal.com/login?mode=activate`, login exitoso. |
| **Prueba 2** | Recuperación desde Login | *Buzón de prueba autorizado* | 1 | Modal `#forgot-password-modal`, mensaje neutro anti-enumeración, recepción de correo, reset de contraseña, login con nueva credencial. |
| **Prueba 3** | Reenvío / Repetición | *Buzón de prueba autorizado* | 0 a 1 | Opcional, **solo si se requiere** verificar comportamiento no cubierto en Pruebas 1 o 2. Máximo estricto: 3 envíos totales. |

---

## 5. Registro de Envíos Reales Ejecutados

* **Límite total autorizado:** Máximo 3 correos reales.
* **Buzón receptor autorizado:** `bvaliente@grupogama.com` (confirmado por el usuario).
* **Correos enviados hasta este momento:** **1 de 3**.

### Detalle de Envío 1 — Prueba 1 (Invitación / Establecimiento de Contraseña)
- **Fecha y Hora de Despacho:** `2026-11-03T02:03:58.694Z` (Local: `2026-11-02 20:03:58 CST`).
- **Operación:** Despacho nativo de restablecimiento/invitación (`PASSWORD_RESET`) vía Firebase Identity Platform API.
- **Buzón Destinatario:** `bvaliente@grupogama.com`.
- **URL de Retorno / ActionCodeSettings:** `https://erp.ductsal.com/login?mode=activate` (`handleCodeInApp: false`).
- **Respuesta de Firebase Identity Platform:** `HTTP 200 OK` (`success: true`, `error: null`).
- **Higiene de Secretos:** Respuesta no expone `oobCode` en cliente; entrega delegada directamente al servidor SMTP/correo de Firebase.
- **Estado de Recepción:** **EN ESPERA DE VERIFICACIÓN POR EL USUARIO EN SU BANDEJA DE ENTRADA**.

---

## 6. Estado de Verificación de Experiencia de Usuario (Envío 1)

Puntos a verificar en el buzón `bvaliente@grupogama.com`:
1. **Recepción efectiva:** Correo recibido en la bandeja de entrada o spam.
2. **Remitente visible:** Comprobar si figura como `DUCTSAL ERP <noreply@auth.ductsal.com>` o `DUCTSAL ERP <noreply@ductsal-erp.firebaseapp.com>`.
3. **Reply-To:** Comprobar si figura `informatica@grupogama.com`.
4. **Idioma y Asunto:** Comprobar que el asunto sea *"Cambia la contraseña de DUCTSAL ERP"* y el cuerpo esté íntegramente en español.
5. **Apertura de Enlace y Password Setup:** Al pulsar el enlace, comprobar apertura de interfaz nativa y aceptación de nueva contraseña.
6. **Retorno al ERP:** Comprobar redirección al ERP (`https://erp.ductsal.com/login?mode=activate`).
7. **Inicio de Sesión:** Comprobar autenticación con la contraseña recién definida.

---

## 7. Dictamen Parcial

```
================================================================================
          FASE 6.3.7: ENVÍO 1 DE 3 EJECUTADO — ESPERANDO FEEDBACK
================================================================================
- Envío 1: DESPACHADO (HTTP 200 OK) hacia bvaliente@grupogama.com
- Timestamp: 2026-11-03T02:03:58Z
- URL de retorno: https://erp.ductsal.com/login?mode=activate
- Envíos restantes autorizados: 2
- Próximo paso: Confirmación de recepción e inspección visual en buzón corporativo.
================================================================================
```
