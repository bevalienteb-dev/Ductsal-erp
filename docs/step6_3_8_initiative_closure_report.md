# FASE 6.3.8 — INFORME TÉCNICO DE CIERRE DE LA INICIATIVA 6.3

**Iniciativa:** 6.3 — Arquitectura de Autenticación Nativa de Firebase, Eliminación de Contraseñas Provisionales y Gestión de Identidad  
**Fecha de Cierre:** 2 de Noviembre de 2026 (21:38 CST / 03:38 UTC del 3 de Noviembre)  
**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Documento:** Informe Oficial de Cierre, Trazabilidad de Requisitos R1–R9, Auditoría de Pruebas y Guía de Diagnóstico IT  
**Estado:** **INICIATIVA 6.3 COMPLETADA Y AUDITADA — PENDIENTE DE DESPLIEGUE A PRODUCCIÓN**  
**Dictamen Técnico Oficial:** **APROBADO CON OBSERVACIONES OPERATIVAS (LISTO PARA FASE DE RELEASE)**  

---

## 1. Resumen Ejecutivo y Dictamen de la Iniciativa 6.3

La Iniciativa 6.3 tuvo como propósito central transformar de raíz la gestión de usuarios, el proceso de invitación y la recuperación de credenciales en DUCTSAL ERP:
1. **Eliminar definitivamente el almacenamiento de contraseñas provisionales** en texto plano dentro de Firestore (`users_prod`).
2. **Erradicar la generación dual de enlaces en servidor** (`generatePasswordResetLink`) en Cloud Functions.
3. **Implementar una arquitectura Write-Ahead local (`CrmOutbox`)** en el cliente web para garantizar la consistencia operativa ante fallos de conectividad.
4. **Delegar el despacho de correos de invitación y restablecimiento al Firebase Client SDK** (`auth.sendPasswordResetEmail`) con protección anti-enumeración estricta y forzando idioma español.
5. **Configurar y certificar el dominio de envío corporativo `auth.ductsal.com`** con la tríada completa de autenticación criptográfica en DNS (**SPF, DKIM y DMARC**).

### Dictamen Oficial de la Iniciativa: **`APROBADO CON OBSERVACIONES OPERATIVAS`**
* **Calidad de Código y Seguridad:** **100% CONFORME**. Cero contraseñas en base de datos, cero enlaces legacy en backend, guardas anti-doble envío en cliente y servidor, y protección anti-enumeración de usuarios activa.
* **Pruebas Automatizadas:** **100% PASADAS**. 91 suites unitarias (2,310 pruebas) y 4 suites en emuladores reales (61 pruebas) ejecutadas con **0 fallos**.
* **Autenticación Criptográfica en Red:** **100% CONFORME**. Comprobado en encabezados RFC 822 de Microsoft 365 con **SPF PASS, DKIM PASS, DMARC PASS y Compauth PASS (reason=100)**.
* **Presupuesto de Correo Real:** **3 de 3 envíos consumidos (100% CERRADO)**. Cero envíos adicionales permitidos.
* **Observación 1 (Presentación):** En proyectos sin Google Sign-In, Firebase Auth recurre al sitio de Hosting (`ductsal-erp`) para `%APP_NAME%` (limitación técnica oficial de Google documentada en 6.3.7.6, sin impacto funcional ni de seguridad).
* **Observación 2 (Entregabilidad EOP):** Los envíos 2 y 3 fueron clasificados en Junk por Microsoft 365 con SCL: 5 y SFV: SPM. Se entrega una guía de diagnóstico para IT sin aplicar cambios no autorizados.

---

## 2. Auditoría Exhaustiva de Pruebas Automatizadas

En cumplimiento del mandato de rigor técnico:
* Se ejecutaron las suites completas en el entorno local.
* Se identificó individualmente cada suite, número de casos y resultado.
* Se analizaron los solapamientos entre capas para **no presentar sumas engañosas de pruebas únicas**.

### 2.1 Pruebas Unitarias en Memoria (`npm test` en `functions/`)
* **Entorno:** Jest en Node.js v20, ejecución en memoria con emulación de Firestore y Firebase Auth vía [`fakeFirebase.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/test-helpers/fakeFirebase.js).
* **Alcance:** Lógica de negocio, validaciones de esquema, sanitización de entradas, normalización de correos, transacciones simuladas, guardas de proyecto y contratos de Cloud Functions.
* **Resultado Consolidado:**
  ```text
  Test Suites: 91 passed, 91 total
  Tests:       2310 passed, 2310 total
  Snapshots:   0 total
  Time:        7.193 s
  ```
* **Suites representativas de la Iniciativa 6.3:**
  - `createUserAdmin.test.js` (6 pruebas) — Creación administrativa delegando despacho al cliente.
  - `updateUserAdmin.test.js` (8 pruebas) — Actualización atómica de perfiles y sincronización Auth.
  - `adminFunctions.iter7.test.js` (9 pruebas) — Reenvío sin generación de enlaces en servidor.
  - `actionCodeSettingsIsolation.unit.test.js` (5 pruebas) — Invariantes de ActionCodeSettings y URLs.
  - `nativeArchitectureVerification.unit.test.js` (4 pruebas) — Cero llamadas a `generatePasswordResetLink`.
  - `crmOutbox.unit.test.js` (7 pruebas) — Ciclo de vida de outbox, TTL y rechazo `assertNoSecrets`.
  - `frontendPasswordSetupAndRecovery.test.js` (6 pruebas) — Respuestas neutras anti-enumeración.
  - `createUserAdmin.concurrency.test.js` (5 pruebas) — Concurrencia e idempotencia por `opId`.

---

### 2.2 Pruebas de Integración sobre Emuladores Reales (`jest.emulator.config.js`)
* **Entorno:** Firebase Emulators Suite (`demo-ductsal-local` en `127.0.0.1`: Auth 9099, Firestore 8080, Functions 5001).
* **Alcance:** Ejecución contra los motores reales de Firebase emulados (base de datos real en memoria, triggers reales `syncUserDirectory_local`, generación de tokens OOB y consumo de endpoints).
* **Resultado Consolidado:**
  ```text
  Test Suites: 4 passed, 4 total
  Tests:       61 passed, 61 total
  Snapshots:   0 total
  Time:        14.727 s
  ```
* **Desglose por Suite de Emulador:**
  1. [`authEmulatorIsolation.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/authEmulatorIsolation.emu.js) — **16 casos (PASS)**:
     - Verificación de binding local `127.0.0.1` y rechazo estricto de proyectos de producción (`ductsal-erp`).
     - Creación de usuario y pre-registro de ticket sin enlaces Admin SDK.
     - Captura de códigos OOB en endpoint emulado y verificación de higiene en Firestore (cero contraseñas en perfil).
     - Validación de un solo uso de tokens OOB y rechazo de creación de roles de gerencia.
  2. [`authTicketOwnership.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/authTicketOwnership.emu.js) — **8 casos (PASS)**:
     - Autoridad de emisión de tickets restringida a managers autenticados.
     - Registro y actualización de estados en `invitationOps`.
     - Aislamiento cross-tenant de tickets.
  3. [`nativeAuthFlow.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/nativeAuthFlow.emu.js) — **18 casos (PASS)**:
     - Flujo nativo completo: invitación → generación OOB → cambio de contraseña → confirmación de activación.
     - Blindaje de reglas de seguridad (`firestore.rules` bloquea escrituras directas del cliente a `users_prod`).
     - Restricción de reintentos y tokens caducados.
  4. [`createUserAdmin.e2e.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/createUserAdmin.e2e.emu.js) — **19 casos (PASS)**:
     - Ciclo de vida completo end-to-end de un usuario nuevo.
     - Verificación de sincronización con `userDirectory_local` y perfil comercial.
     - Comprobación de que `result.data.link === null`.

---

### 2.3 Análisis de Solapamiento y Diferenciación de Capas
* **Diferenciación de Capas:**
  - Los **2,310 casos unitarios** validan aislamiento de funciones en JavaScript puro con dobles de prueba (`stubs`).
  - Los **61 casos de emulador** validan la interacción real entre servicios acoplados (Auth, Firestore, Callables y Reglas de Seguridad).
* **Solapamiento conceptual:** Existen casos que evalúan la misma función (por ejemplo, `createUserAdmin` se evalúa en `createUserAdmin.test.js` y en `createUserAdmin.e2e.emu.js`). No obstante, en la capa unitaria se prueba el manejo de errores síncronos y parámetros, mientras que en emuladores se prueba la persistencia en el motor Java de Firestore y la generación criptográfica de Firebase Auth.
* **Cómputo Transparente:**
  - **Pruebas Unitarias Únicas (Mocks):** 2,310 casos.
  - **Pruebas de Integración Únicas (Emulador Real):** 61 casos.
  - **Total de Pruebas Automatizadas Ejecutadas y Aprobadas:** **2,371 ejecuciones exitosas (0 fallos)**.

---

## 3. Matriz de Cumplimiento de Requisitos R1–R9

Se audita cada requisito de la iniciativa con evidencia directa y contrastable:

### R1 — Eliminación de Contraseñas Provisionales en Base de Datos
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** En [`functions/index.js:594-642`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js#L594-L642) (`createUserAdmin`), el perfil inicial en `users_prod` solo contiene `nombre`, `email`, `role`, `activo`, `authUid`, `fechaCreacion` e `invitation`. No se escribe ningún campo de contraseña.
* **Prueba / Archivo:** [`functions/emulator-tests/authEmulatorIsolation.emu.js:156-163`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/authEmulatorIsolation.emu.js#L156-L163) (`expect(userData.password).toBeUndefined(); expect(userData.tempPassword).toBeUndefined();`).
* **Limitaciones Conocidas:** Ninguna.
* **Dictamen:** **CONFORME**.

### R2 — Eliminación de Enlaces de Servidor (Admin SDK)
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Búsqueda en [`functions/index.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) arroja 0 llamadas a `generatePasswordResetLink()`. `createUserAdmin` y `resendInvitationAdmin` retornan `{ link: null, sent: false, delivery: 'prepared' }`.
* **Prueba / Archivo:** [`functions/__tests__/nativeArchitectureVerification.unit.test.js:45-88`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/nativeArchitectureVerification.unit.test.js#L45-L88) y [`functions/emulator-tests/createUserAdmin.e2e.emu.js:105-120`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/createUserAdmin.e2e.emu.js#L105-L120).
* **Limitaciones Conocidas:** Ninguna.
* **Dictamen:** **CONFORME**.

### R3 — Cola Write-Ahead Local (Outbox)
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Implementación en [`crm_outbox.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_outbox.js) con almacenamiento en `localStorage`, clave `crm_outbox_${managerUid}`, TTL de 24 horas y método `assertNoSecrets` que arroja excepción si detecta `password`, `token`, `oobCode` o `apiKey`.
* **Prueba / Archivo:** [`functions/__tests__/crmOutbox.unit.test.js:1-120`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/crmOutbox.unit.test.js#L1-L120).
* **Limitaciones Conocidas:** Si el gerente limpia los datos del navegador antes de reconectar, los tickets locales no enviados se purgan (el backend conserva la colección `invitationOps_prod`).
* **Dictamen:** **CONFORME**.

### R4 — Despacho Nativo en Cliente (Client SDK)
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** [`crm_auth.js:168-176`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L168-L176) ejecuta `fb.auth().sendPasswordResetEmail(normalizedEmail, PRODUCTION_ACTION_CODE_SETTINGS)`. Forzado de idioma español con `auth.languageCode = 'es'` ([`crm_auth.js:206`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L206)).
* **Prueba / Archivo:** [`functions/__tests__/crmAuth.client.test.js:40-75`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/crmAuth.client.test.js#L40-L75).
* **Limitaciones Conocidas:** Requiere conectividad HTTPS directa del navegador cliente hacia Google Identity Toolkit.
* **Dictamen:** **CONFORME**.

### R5 — Protección Anti-Enumeración de Usuarios
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Modal `#forgot-password-modal` en [`app_core.js:2590-2645`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L2590-L2645) responde con el mismo mensaje genérico idéntico tanto ante éxito como ante error `auth/user-not-found` o `auth/invalid-email`. Flag `enableImprovedEmailPrivacy: true` verificado en Google Identity Platform API.
* **Prueba / Archivo:** [`functions/__tests__/frontendPasswordSetupAndRecovery.test.js:35-80`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/frontendPasswordSetupAndRecovery.test.js#L35-L80).
* **Limitaciones Conocidas:** Ninguna.
* **Dictamen:** **CONFORME**.

### R6 — Guardas Anti-Doble Envío
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Guardas en memoria `userSaveInFlight` ([`modules/users/users_controller.js:284`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js#L284)), `resetPassInFlight` ([`modules/users/users_controller.js:338`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js#L338)) y `forgotPasswordInFlight` ([`app_core.js:2582`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L2582)). En backend, clave de idempotencia `opId` en Firestore.
* **Prueba / Archivo:** [`functions/__tests__/createUserAdmin.concurrency.test.js:1-65`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/createUserAdmin.concurrency.test.js#L1-L65).
* **Limitaciones Conocidas:** Las guardas en memoria operan a nivel de pestaña activa.
* **Dictamen:** **CONFORME**.

### R7 — Dominio de Remitente Personalizado
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Google Identity Platform API reporta `customDomain: "auth.ductsal.com"`, `useCustomDomain: true`, `senderDisplayName: "DUCTSAL ERP"`, `senderLocalPart: "noreply"`, `replyTo: "informatica@grupogama.com"`. Encabezados de correo recibido muestran `From: "DUCTSAL ERP" <noreply@auth.ductsal.com>`.
* **Prueba / Archivo:** Volcado de encabezados RFC 822 en Fase 6.3.7.8 ([`docs/step6_3_7_8_second_real_email_test.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_7_8_second_real_email_test.md)).
* **Limitaciones Conocidas:** El asunto de la plantilla muestra `Cambia la contraseña de ductsal-erp` (resolución de `%APP_NAME%` al sitio predeterminado de Hosting en proyectos Email/Password sin Google Sign-In).
* **Dictamen:** **CONFORME CON OBSERVACIÓN DE PLANTILLA**.

### R8 — Autenticación Criptográfica Completa (SPF, DKIM, DMARC)
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Registros publicados en Network Solutions (`ns25.worldnic.com`). Encabezados de Internet auditados en Microsoft 365:
  - `spf=pass smtp.mailfrom=auth.ductsal.com`
  - `dkim=pass header.d=auth.ductsal.com (s=firebase2)`
  - `dmarc=pass action=none header.from=auth.ductsal.com`
  - `compauth=pass reason=100`
* **Prueba / Archivo:** Encabezados brutos de Microsoft Graph en Fase 6.3.7.8 y 6.3.7.9.
* **Limitaciones Conocidas:** Política DMARC en modo de observación `p=none`.
* **Dictamen:** **CONFORME**.

### R9 — Pruebas Reales Controladas y Presupuesto
* **Estado:** **CUMPLIDO AL 100%**.
* **Evidencia Concreta:** Tres envíos reales ejecutados hacia `bvaliente@grupogama.com` vía Firebase Identity Platform (`/v1/accounts:sendOobCode`):
  - Envío 1: Invitación inicial (`2026-11-03T02:03:58Z`) — HTTP 200 OK.
  - Envío 2: Recuperación (`2026-11-03T03:17:01Z`) — HTTP 200 OK. Encabezados auditados.
  - Envío 3: Recuperación tras Not Junk (`2026-11-03T03:24:39Z`) — HTTP 200 OK.
  - **Presupuesto:** **3 de 3 correos consumidos (100% CERRADO)**. Cero envíos adicionales permitidos.
* **Prueba / Archivo:** [`docs/step6_3_7_real_email_validation.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_7_real_email_validation.md), [`docs/step6_3_7_8_second_real_email_test.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_7_8_second_real_email_test.md) y [`docs/step6_3_7_9_third_real_email_test.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_7_9_third_real_email_test.md).
* **Limitaciones Conocidas:** Clasificación Junk (SCL: 5) en los envíos 2 y 3.
* **Dictamen:** **CONFORME CON OBSERVACIÓN DE ENTREGABILIDAD**.

---

## 4. Auditoría de Entregabilidad y Guía de Diagnóstico para IT

### 4.1 Evidencia Comprobada en Microsoft 365
A partir de los encabezados originales del Envío 2 y Envío 3 procesados por `DM3PEPF000265C1.mail.protection.outlook.com`:
* **Autenticación:**
  - `Authentication-Results: mx.microsoft.com 1; spf=pass; dkim=pass; dmarc=pass action=none; compauth=pass reason=100`.
  - Microsoft 365 certifica que el mensaje **NO es una suplantación** y cumple plenamente los estándares de validación criptográfica.
* **Clasificación Antispam:**
  - `X-MS-Exchange-Organization-SCL: 5` (Spam Confidence Level 5: umbral de correo no deseado).
  - `X-Forefront-Antispam-Report: SFV:SPM; CAT:SPM; IPV:NLI; DIR:INB;`.
  - `X-Microsoft-Antispam-Mailbox-Delivery: dest:J; RF:JunkEmail; OFR:SpamFilterAuthJ;`.
* **Cierre de Presupuesto:** **3/3 consumido.** Queda terminantemente prohibido realizar más envíos de prueba.

### 4.2 Análisis Objetivo de la Clasificación (Sin Suposiciones Categóricas)
Conforme a la instrucción técnica, **no se atribuye categóricamente la clasificación a un factor único sin evidencia adicional**:
* Exchange Online Protection (EOP) evalúa de forma combinada múltiples capas: reglas heurísticas de contenido (`SFS rules`), enlaces con parámetros OOB de restablecimiento, historial/volumen del dominio emisor y configuraciones de directivas del tenant.
* La determinación exacta de qué regla de EOP disparó el SCL 5 solo puede obtenerse mediante las herramientas administrativas del portal de seguridad de Microsoft 365 de Grupo Gama.

---

### 4.3 Guía de Diagnóstico para el Administrador de IT (Microsoft 365)
> [!NOTE]
> **GUÍA DE INVESTIGACIÓN (NO APLICAR REGLAS PREMATURAS NI MODIFICACIONES):**  
> El objetivo de esta guía es permitir que el administrador de TI de Grupo Gama inspeccione la causa raíz exacta en el portal de administración, sin alterar la configuración del tenant hasta tener el diagnóstico formal.

1. **Paso 1: Localización del Mensaje en el Explorador de Amenazas (Threat Explorer / Message Trace):**
   - Acceder al portal de **Microsoft Defender** (`https://security.microsoft.com`) con credenciales de administrador de seguridad.
   - Navegar a **Email & collaboration** → **Explorer** (o **Exchange Admin Center** → **Mail flow** → **Message trace**).
   - Filtrar por:
     - Remitente: `noreply@auth.ductsal.com`
     - Destinatario: `bvaliente@grupogama.com`
     - Rango de fechas: `2026-11-02` / `2026-11-03`.
2. **Paso 2: Inspección de los Detalles de Entrega y Filtrado:**
   - Abrir el detalle del mensaje con Network Message ID: `0972685c-4f5a-4f00-194e-08df3958ee39`.
   - Consultar la pestaña **Detection technologies** y **Policy override**.
   - Comprobar qué motor específico marcó `SPM`:
     - ¿Heurística de contenido de enlaces (*URL Detonation / Safe Links*)?
     - ¿Filtro bayesiano de palabras clave (*Content Filtering*)?
     - ¿Evaluación de dominio emisor (*Anti-spam inbound policy default threshold*)?
3. **Paso 3: Análisis de las Reglas SFS (Spam Filtering System):**
   - En los encabezados aparece la lista de reglas disparadas:  
     `SFS:(13230040)(704162011799003)(43022699015)...`.
   - Comparar estas reglas con la documentación de soporte interno de Microsoft Premier / Exchange para identificar la regla específica con mayor ponderación de puntos.
4. **Paso 4: Determinación de la Solución Corporativa Adecuada:**
   - Una vez comprobada la causa, IT podrá decidir si corresponde:
     - Añadir el subdominio `auth.ductsal.com` a la lista de remitentes permitidos en la directiva antispam personalizada del tenant (**Tenant Allow/Block List** en Defender).
     - Crear una regla de flujo de correo (*Mail Flow Rule*) en Exchange Admin Center que fije el SCL en `0` o `-1` (Bypass Spam Filtering) para los mensajes autenticados con DKIM `auth.ductsal.com`.

---

## 5. Inventario de Cambios Locales y Auditoría de Git

### 5.1 Verificación de Integridad de Formato
Se ejecutó `git diff --check` arrojando **0 errores de formato, 0 espacios en blanco al final de línea y 0 conflictos**.

### 5.2 Inventario de los 15 Archivos Modificados en el Repositorio
Todos los archivos modificados en el árbol de trabajo corresponden estrictamente al alcance de las Fases 6.2, 6.3 y 6.5:

| Archivo Modificado | Componente | Justificación del Cambio en la Iniciativa |
| :--- | :---: | :--- |
| [`app_core.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js) | Frontend | Modal `#forgot-password-modal` con mensaje neutro, observador `mode=activate` y reconciliación de outbox al login. |
| [`crm_auth.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js) | Frontend | `PRODUCTION_ACTION_CODE_SETTINGS`, `auth.languageCode = 'es'`, delegación a Client SDK y enlace a outbox. |
| [`modules/users/users_controller.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js) | Frontend | Guardas anti-doble clic (`userSaveInFlight`, `resetPassInFlight`), encolado previo en outbox y cero escrituras a `users_prod`. |
| [`index.html`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/index.html) | Frontend | Marcado del modal de recuperación accesible y adición de `crm_outbox.js` en orden determinista de carga. |
| [`functions/index.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) | Backend | Eliminación de llamadas a `generatePasswordResetLink`; exposición de callables de ciclo de vida (`recordInvitationOutcomeAdmin`, `confirmUserActivation`, `reconcileUserOp`). |
| [`functions/package.json`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/package.json) | Backend | Comandos de pruebas modulares (`test:unit`, `test:auth-env`, `test:ownership`, `test:native-auth`). |
| [`firebase.emulator.json`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/firebase.emulator.json) | Config | Configuración de emuladores locales para pruebas aisladas. |
| [`functions/test-helpers/fakeFirebase.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/test-helpers/fakeFirebase.js) | Pruebas | Mock de Firestore y Auth con soporte para clonación profunda y transacciones. |
| [`functions/__tests__/createUserAdmin.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/createUserAdmin.test.js) | Pruebas | Aserciones unitarias de creación delegando despacho al cliente. |
| [`functions/__tests__/updateUserAdmin.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/updateUserAdmin.test.js) | Pruebas | Validación de rechazo de campos no autorizados y sincronización Auth/Firestore. |
| [`functions/__tests__/adminFunctions.iter7.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/adminFunctions.iter7.test.js) | Pruebas | Comprobación de reenvío de invitación sin enlaces de servidor. |
| [`functions/__tests__/emulatorStatics.regression.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/emulatorStatics.regression.test.js) | Pruebas | Pruebas de compatibilidad con módulos estáticos. |
| [`functions/__tests__/phase66ComplementaryVerification.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/phase66ComplementaryVerification.unit.test.js) | Pruebas | Acreditación de respuestas sin contraseñas temporales. |
| [`functions/__tests__/phase66SecurityAudit.unit.test.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/__tests__/phase66SecurityAudit.unit.test.js) | Pruebas | Auditoría de seguridad de callables administrativas ante accesos no autorizados. |
| [`functions/emulator-tests/createUserAdmin.e2e.emu.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/emulator-tests/createUserAdmin.e2e.emu.js) | Pruebas | Suite E2E de ciclo de usuario sin enlaces Admin SDK. |

---

### 5.3 Archivos Nuevos Clave de la Iniciativa 6.3
* [`crm_outbox.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_outbox.js) (Frontend): Módulo Write-Ahead Outbox.
* [`functions/invitationService.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js) (Backend): Servicio de configuración, estados de invitación y resolución de ActionCodeSettings.
* Suites especializadas de emulador en `functions/emulator-tests/`:
  - `authEmulatorIsolation.emu.js`, `authTicketOwnership.emu.js`, `nativeAuthFlow.emu.js`, `authEmulatorTestHelper.js`.
* Suites especializadas de pruebas unitarias en `functions/__tests__/`:
  - `actionCodeSettingsIsolation.unit.test.js`, `crmOutbox.unit.test.js`, `frontendPasswordSetupAndRecovery.test.js`, `nativeArchitectureVerification.unit.test.js`, `userLifecycleBackend.unit.test.js`.

---

### 5.4 Archivos No Pertenecientes a la Iniciativa 6.3
Se identificaron con precisión los elementos del workspace que corresponden a fases previas u otras herramientas:
1. **Artefactos del Paso 5 (Optimizaciones y Evidencias de Rendimiento):**
   - `DUCTSAL_PASO5_EVIDENCIA_VISUAL_CORREGIDA.zip`
   - `docs/evidence_step5/`
   - `docs/optimization_manager_firestore_reads_report.md`
   - `docs/validation_performance_firestore_report.md`
   - `docs/validation_step5_complementary_report.md`
   - `docs/validation_step5_final_closure_report.md`
   - `docs/validation_step5_integral_report.md`
2. **Personalizaciones del Entorno de Desarrollo:**
   - `.agents/` (Directorio de configuraciones y reglas del IDE).
3. **Scripts de Utilidad / Verificación:**
   - `scripts/execute_controlled_real_email.js` (Harness del despacho controlado de pruebas reales).
   - `scripts/verify_client_sdk_and_ui_flows.js` (Harness de CDP para pruebas de navegador).
   - `scripts/verify_phase6_5_e2e_matrix.js` (Harness de verificación de matriz E2E Fase 6.5).

* **Regla de Integridad:** Ningún archivo fue descartado, sobreescrito ni eliminado. Cero operaciones de `git commit`, `push`, `PR` o `merge`.

---

## 6. Estado de Firebase y DNS

* **Google Identity Platform (`ductsal-erp`):**
  - Subdominio de envío: `auth.ductsal.com` (**ACTIVO Y APLICADO**).
  - Remitente visible: `DUCTSAL ERP <noreply@auth.ductsal.com>` (**CONFIGURADO**).
  - Reply-To: `informatica@grupogama.com` (**CONFIGURADO**).
  - Idioma: `defaultLocale: "es"` (**CONFIGURADO**).
  - Privacidad de correo: `enableImprovedEmailPrivacy: true` (**CONFIGURADO**).
  - Proveedores: Exclusivamente `Email/Password` (Google Sign-In deshabilitado).
* **Servidores DNS de Network Solutions (`ns25.worldnic.com` / `ns26.worldnic.com`):**
  - `auth.ductsal.com TXT "firebase=ductsal-erp"` (**PROPAGADO**).
  - `auth.ductsal.com TXT "v=spf1 include:_spf.firebasemail.com ~all"` (**PROPAGADO**).
  - `firebase1._domainkey.auth.ductsal.com CNAME mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com` (**PROPAGADO**).
  - `firebase2._domainkey.auth.ductsal.com CNAME mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com` (**PROPAGADO**).
  - `_dmarc.auth.ductsal.com TXT "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"` (**PROPAGADO**).
  - Dominio raíz `ductsal.com`: Registros MX y SPF de Microsoft 365 intactos sin ninguna afectación.

---

## 7. Dictamen Final de la Iniciativa 6.3

```
================================================================================
                    DICTAMEN TÉCNICO OFICIAL DE CIERRE
================================================================================
INICIATIVA 6.3: ARQUITECTURA DE AUTENTICACIÓN NATIVA FIREBASE Y GESTIÓN DE USUARIOS
ESTADO: APROBADA CON OBSERVACIONES OPERATIVAS

1. Cero contraseñas provisionales en Firestore: CUMPLIDO.
2. Cero generación de enlaces en Cloud Functions: CUMPLIDO.
3. Cola Write-Ahead Outbox local en cliente: CUMPLIDO.
4. Despacho nativo de correos al Client SDK: CUMPLIDO.
5. Protección anti-enumeración de usuarios: CUMPLIDO.
6. Guardas anti-doble envío en frontend y backend: CUMPLIDO.
7. Dominio personalizado auth.ductsal.com y remitente visible: CUMPLIDO.
8. Tríada criptográfica (SPF PASS, DKIM PASS, DMARC PASS): CUMPLIDO.
9. Pruebas reales de correo: 3/3 consumidas (PRESUPUESTO AGOTADO Y CERRADO).
10. Pruebas automatizadas: 2,371 ejecuciones exitosas (2,310 unitarias + 61 emuladas).
11. Repositorio local: git diff --check LIMPIO (0 observaciones).

OBSERVACIONES REGISTRADAS:
- Asunto de plantilla resuelve "ductsal-erp" por diseño oficial sin Google Sign-In.
- Clasificación Junk en Microsoft 365 transferida a IT con Guía de Diagnóstico.

ESTADO DE DESPLIEGUE:
- Cero commits, cero push, cero deploys a producción.
- Código y release retenidos localmente a la espera de autorización independiente.
================================================================================
```
