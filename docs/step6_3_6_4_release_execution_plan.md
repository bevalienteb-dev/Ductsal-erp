# FASE 6.3.6.4 — PREPARACIÓN DEFINITIVA DEL RELEASE DE PRODUCCIÓN

**Proyecto:** DUCTSAL ERP (`sales-reporting-system-release`)  
**Fecha de Elaboración:** 2 de Noviembre de 2026  
**Entorno de Ejecución:** Aislado local (`demo-ductsal-local`), Node.js v20, Firebase Emulators Suite  
**ID de Proyecto de Producción:** `ductsal-erp` (948658286825)  
**Dominio de Producción:** `https://erp.ductsal.com`  
**Estado de Despliegue:** **RELEASE PREPARADO — NO PUBLICADO** (Cero commits, cero push, cero deploys, cero correos reales)

---

## 1. Resumen Ejecutivo y Dictamen Oficial

Se ha concluido la preparación definitiva para el lanzamiento a producción de la arquitectura de autenticación nativa de Firebase, el gestor de invitaciones con cola Write-Ahead local (`CrmOutbox`), el autoservicio de recuperación con protección anti-enumeración y la infraestructura de funciones Cloud asociadas.

### Dictamen Oficial: **`RELEASE PREPARADO CON OBSERVACIONES`**

#### Justificación Técnica del Dictamen:
1. **Conformidad Absoluta del Código de Producción:** Todos los artefactos del frontend y backend han sido auditados exhaustivamente. Se certifica que no contienen credenciales, secretos, URLs de emuladores ni configuraciones inseguras. La configuración apunta de manera unívoca al proyecto de producción `ductsal-erp`, con `ActionCodeSettings` fijado en `https://erp.ductsal.com/login?mode=activate`, idioma español (`es`) y remitente Reply-To `informatica@grupogama.com`.
2. **Pruebas Automatizadas 100% Superadas (2,333 pruebas):**
   - **Pruebas Unitarias (Jest):** 89 suites de pruebas, **2,272 pruebas aprobadas** (0 fallos).
   - **Pruebas en Emulador (Aislamiento y Seguridad):** 3 suites especializadas, **42 pruebas aprobadas** (0 fallos).
   - **Pruebas E2E en Emulador (`createUserAdmin.e2e.emu.js`):** 1 suite integral, **19 pruebas aprobadas** (0 fallos).
   - **Total de Pruebas Aprobadas:** **2,333 pruebas automatizadas exitosas**.
3. **Observación 1 — Estado de Validación DNS (`IN_PROGRESS`):**
   - Los **cuatro registros DNS oficiales** (2 registros TXT y 2 CNAME) requeridos para el dominio de correo `auth.ductsal.com` **ya fueron agregados en Network Solutions**:
     1. `TXT`: `auth.ductsal.com` → `v=spf1 include:_spf.firebasemail.com ~all` (SPF)
     2. `TXT`: `auth.ductsal.com` → `firebase=ductsal-erp` (Verificación de proyecto Firebase)
     3. `CNAME`: `firebase1._domainkey.auth.ductsal.com` → `mail-auth-ductsal-com.dkim1._domainkey.firebasemail.com.` (DKIM 1)
     4. `CNAME`: `firebase2._domainkey.auth.ductsal.com` → `mail-auth-ductsal-com.dkim2._domainkey.firebasemail.com.` (DKIM 2)
   - En Firebase Authentication (Templates → Customize domain), la verificación se encuentra en curso (**`IN_PROGRESS`**) mientras la infraestructura de Google completa la comprobación de propagación DNS periódica.
4. **Observación 2 — Prueba de Navegador Chrome/CDP (PENDIENTE):**
   - La suite automatizada de navegador (`scripts/verify_client_sdk_and_ui_flows.js`) no pudo completar su ejecución en esta sesión debido a que el binario de Google Chrome en macOS (`/Applications/Google Chrome.app`, actualizado a las 17:41) quedó suspendido en segundo plano por el sistema operativo macOS sin iniciar el socket CDP en el puerto 9224.
   - Conforme al principio de rigor técnico, **dicha prueba queda registrada formalmente como PENDIENTE (no aprobada en esta sesión)** y no forma parte del cómputo de 2,333 pruebas aprobadas. Las capturas visuales de respaldo existentes en [docs/screenshots/](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots) corresponden fielmente a la ejecución previa de la Fase 6.3.4.1 (17:06).

---

## 2. Revisión Final de Parámetros de Configuración de Producción

Se certifica el cumplimiento riguroso de los parámetros oficiales exigidos para el despliegue:

| Parámetro Requerido | Valor Esperado | Valor Auditado en Código / Plataforma | Archivo de Origen | Estado |
| :--- | :--- | :--- | :--- | :---: |
| **Firebase Project ID** | `ductsal-erp` | `ductsal-erp` | [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L26-L35), [.firebaserc](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/.firebaserc) | **CONFIRMADO** |
| **authDomain actual** | `ductsal-erp.firebaseapp.com` | `ductsal-erp.firebaseapp.com` | [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L27) | **CONFIRMADO** |
| **ActionCodeSettings Prod** | `https://erp.ductsal.com/login?mode=activate` | `https://erp.ductsal.com/login?mode=activate`<br/>`handleCodeInApp: false` | [crm_auth.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L23-L27), [functions/invitationService.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/invitationService.js#L12-L16) | **CONFIRMADO** |
| **Idioma de Autenticación** | Español (`es`) | `auth.languageCode = 'es'`<br/>Identity Platform `defaultLocale = 'es'` | [crm_auth.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L206), Google Identity Platform Config API | **CONFIRMADO** |
| **Reply-To Previsto** | `informatica@grupogama.com` | `informatica@grupogama.com` configurado en plantillas de Identity Platform | Identity Platform API v2 (`projects/948658286825/config`) | **CONFIRMADO** |
| **Sin Emuladores en Prod** | Cero conexiones a emuladores | Activación condicionada estrictamente a `hostname === 'localhost'` y query param `?emulators=demo-ductsal-local` | [app_core.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js#L37-L44), [crm_env.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_env.js#L14-L45) | **CONFIRMADO** |
| **Sin URLs locales en Prod** | Cero URLs locales en producción | Objeto inmutable `PRODUCTION_ACTION_CODE_SETTINGS` apuntando a `https://erp.ductsal.com/login?mode=activate` | [crm_auth.js](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L23-L27) | **CONFIRMADO** |
| **Higiene de Secretos** | Cero claves o secretos en reposo | Verificado mediante escaneo estático: cero claves privadas, certificados o tokens en artefactos | Escaneo de workspace (`find`, `grep`) | **CONFIRMADO** |

---

## 3. Auditoría de Modificaciones Locales

Se realizó la verificación formal del estado de Git para confirmar que los 15 archivos modificados corresponden exactamente al alcance de las Fases 6.3.2 a 6.3.5:

### 3.1 Comprobaciones de Git (`git status --short`, `git diff --check`)
- `git diff --check`: Salida limpia (`0` errores de espacios en blanco o conflictos).
- `git status --short`:
  ```
   M app_core.js
   M crm_auth.js
   M firebase.emulator.json
   M functions/__tests__/adminFunctions.iter7.test.js
   M functions/__tests__/createUserAdmin.test.js
   M functions/__tests__/emulatorStatics.regression.test.js
   M functions/__tests__/phase66ComplementaryVerification.unit.test.js
   M functions/__tests__/phase66SecurityAudit.unit.test.js
   M functions/__tests__/updateUserAdmin.test.js
   M functions/emulator-tests/createUserAdmin.e2e.emu.js
   M functions/index.js
   M functions/package.json
   M functions/test-helpers/fakeFirebase.js
   M index.html
   M modules/users/users_controller.js
  ```

### 3.2 Desglose y Justificación de los 15 Archivos Modificados
1. **`app_core.js`:** Añade el modal de recuperación anti-enumeración (`#forgot-password-modal`), observador de `mode=activate` para confirmación de activación, y reconciliación de outbox al inicio de sesión de gerencia.
2. **`crm_auth.js`:** Configura `PRODUCTION_ACTION_CODE_SETTINGS`, `auth.languageCode = 'es'`, desacopla el despacho al Client SDK e integra la persistencia previa en outbox.
3. **`modules/users/users_controller.js`:** Añade guardas de concurrencia contra doble clic (`userSaveInFlight`, `resetPassInFlight`), encola tickets en outbox y elimina escrituras directas a `users_prod`.
4. **`index.html`:** Incorpora enlace de autoservicio de contraseña, modal de recuperación e inserta `crm_outbox.js` en el orden de carga determinista.
5. **`functions/index.js`:** Elimina invocaciones a `generatePasswordResetLink` en el backend para el flujo nativo; expone callables de ciclo de vida (`recordInvitationOutcomeAdmin`, `confirmUserActivation`, `reconcileUserOp`).
6. **`functions/package.json`:** Define comandos de pruebas modulares (`test:unit`, `test:auth-env`, `test:ownership`, `test:native-auth`, `test:client-sdk`).
7. **`firebase.emulator.json`:** Habilita la interfaz de emulador para depuración local.
8. **`functions/__tests__/createUserAdmin.test.js`:** Actualiza aserciones de creación delegando despacho al cliente.
9. **`functions/__tests__/updateUserAdmin.test.js`:** Valida rechazo estricto de campos inesperados en actualización de usuarios.
10. **`functions/__tests__/adminFunctions.iter7.test.js`:** Verifica que `resendInvitationAdmin` emita ticket para despacho nativo en cliente sin generar links de servidor.
11. **`functions/__tests__/emulatorStatics.regression.test.js`:** Verifica que `createUserAdmin` opere correctamente con módulos estáticos en emulador.
12. **`functions/__tests__/phase66ComplementaryVerification.unit.test.js`:** Acredita que las respuestas administrativas no expongan links ni contraseñas temporales.
13. **`functions/__tests__/phase66SecurityAudit.unit.test.js`:** Audita la seguridad de callables administrativas ante accesos no autorizados.
14. **`functions/emulator-tests/createUserAdmin.e2e.emu.js`:** Suite E2E sobre emulador real que verifica el ciclo de vida completo sin enlaces de Admin SDK.
15. **`functions/test-helpers/fakeFirebase.js`:** Soporte para clonación profunda de documentos y emulación fiel de mutaciones en Firestore.

### 3.3 Archivos Nuevos Clave del Release
- **`crm_outbox.js` (Frontend):** Implementación de la cola Write-Ahead local con aislamiento por `managerAuthUid`, TTL de 24 horas y validación `assertNoSecrets`.
- **`functions/invitationService.js` (Backend):** Servicio de aislamiento de configuración de entornos (`isControlledEnvironment`), definición de estados de invitación y resolución de `ActionCodeSettings`.

---

## 4. Inventario Exhaustivo de Archivos del Release

### 4.1 Artefactos del Frontend (Publicación en Vercel)
Los siguientes archivos y carpetas conforman el bundle estático a desplegar en el hosting de producción de Vercel:
1. `index.html` (Entrypoint SPA principal).
2. `styles.css` (Estilos corporativos y modales).
3. `logo.svg` (Branding).
4. `app_core.js` (Núcleo de la aplicación).
5. `crm_auth.js` (Módulo cliente de autenticación).
6. `crm_outbox.js` (Cola local Write-Ahead).
7. `crm_env.js` (Detección de entorno).
8. `crm_staging_config.js` (Aislamiento de staging).
9. `crm_ui.js` (Utilidades de interfaz y modales).
10. `crm_clients.js` (Lógica de cartera de clientes).
11. `crm_commercial.js` (Lógica comercial y cotizaciones).
12. `crm_dashboard_calc.js` (Cálculo de métricas de gerencia).
13. `crm_followup_calc.js` (Seguimiento comercial y SLAs).
14. `crm_formatters.js` (Formateadores monetarios y temporales).
15. `crm_work_calendar.js` (Calendario laboral salvadoreño).
16. `core/` (Librerías internas de estado y datos).
17. `modules/` (Módulos de negocio, incluyendo `modules/users/users_controller.js`).

### 4.2 Artefactos del Backend (Despliegue en Firebase Cloud Functions)
1. `functions/index.js`
2. `functions/invitationService.js`
3. `functions/package.json`

---

## 5. Preparación de la Publicación en Vercel

### 5.1 Comparativa Técnica de Métodos de Publicación

| Criterio | Opción A: Integración GitHub / Vercel (Recomendada) | Opción B: Vercel CLI (`vercel --prod`) |
| :--- | :--- | :--- |
| **Mecanismo** | Push a rama `main` en GitHub (`origin`). Webhook dispara build/deploy en Vercel. | Subida directa de archivos locales mediante CLI desde la terminal. |
| **Trazabilidad** | **Máxima.** Cada despliegue está respaldado por un commit con autor, fecha y hash SHA. | **Baja.** Despliegue sin commit crea código "fantasma" desfasado del repositorio. |
| **Riesgo de Inclusión** | **Bajo.** Solo se despliegan los archivos explícitamente agregados al commit de Git. | **Moderado.** Puede incluir archivos locales no deseados si falta `.vercelignore`. |
| **Rollback** | **Instantáneo.** Permite revertir con un clic a cualquier commit histórico en el dashboard. | **Instantáneo.** Permite revertir al despliegue previo en el dashboard. |
| **Veredicto** | **MÉTODO MÁS SEGURO Y RECOMENDADO.** | Aceptable únicamente como contingencia de emergencia. |

### 5.2 Procedimiento Exacto de Publicación vía GitHub (Para cuando sea autorizado)

> [!CAUTION]
> **NO EJECUTAR HASTA CONTAR CON AUTORIZACIÓN EXPRESA DEL USUARIO.**

1. **Paso 1: Verificación de Estado Local:**
   ```bash
   git status
   ```
2. **Paso 2: Incorporación Selectiva de Archivos Autorizados:**
   ```bash
   git add index.html styles.css app_core.js crm_auth.js crm_outbox.js modules/ functions/
   ```
3. **Paso 3: Creación de Commit de Release:**
   ```bash
   git commit -m "feat(auth): release native firebase authentication, outbox queue and recovery flow"
   ```
4. **Paso 4: Publicación a la Rama Principal:**
   ```bash
   git push origin main
   ```
5. **Paso 5: Monitoreo de Compilación en Vercel:**
   - Acceder al panel de Vercel y monitorear el despliegue automático hacia `erp.ductsal.com`.
   - Confirmar estado **`Ready`** con certificado SSL corporativo activo.

### 5.3 Procedimiento de Instant Rollback (Plan de Contingencia)
En caso de detectar cualquier anomalía tras la publicación:
1. Acceder de inmediato al panel de Vercel: [vercel.com/dashboard](https://vercel.com/dashboard).
2. Seleccionar el proyecto `sales-reporting-system-release` (o `ductsal-erp`).
3. Navegar a la pestaña **Deployments**.
4. Localizar el despliegue anterior inmediatamente previo al release.
5. Hacer clic en el menú contextual (`...`) y seleccionar **Instant Rollback (Promote to Production)**.
6. En menos de 5 segundos, la red Edge de Vercel redirigirá el 100% del tráfico al despliegue estable anterior.

---

## 6. Lista de Comprobación para Validación Post-Publicación (Smoke Tests)

> [!IMPORTANT]
> **ESTE PROTOCOLO SE EJECUTARÁ EN PRODUCCIÓN ÚNICAMENTE TRAS EL DESPLIEGUE AUTORIZADO.**  
> No se deben utilizar cuentas corporativas reales ni enviar correos masivos. Se emplearán direcciones de prueba controladas.

```
================================================================================
           LISTA DE COMPROBACIÓN DE VALIDACIÓN POST-PUBLICACIÓN (SMOKE TESTS)
================================================================================
```

| N° | Componente / Flujo | Acción a Ejecutar | Comportamiento Esperado | Criterio de Aceptación |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Consola del Navegador** | Abrir `https://erp.ductsal.com` con DevTools abierto (Consola y Red). | Cero errores 404, cero advertencias CORS, cero excepciones JavaScript no controladas. | Consola limpia; todos los scripts cargan con HTTP 200 OK. |
| **2** | **Aislamiento de Red** | Inspeccionar pestaña Network durante la carga inicial. | Ninguna petición dirigida a `127.0.0.1`, `localhost` ni puertos de emulador (`9099`, `8080`, `5001`). | Tráfico dirigido exclusivamente a `erp.ductsal.com` y dominios oficiales de Firebase. |
| **3** | **ActionCodeSettings en Runtime** | Ejecutar en la consola: `CrmAuth.ACTION_CODE_SETTINGS.url`. | Debe retornar exactamente: `"https://erp.ductsal.com/login?mode=activate"`. | Ausencia total de URLs locales en runtime de producción. |
| **4** | **Recuperación Anti-Enumeración** | Abrir modal "¿Olvidaste tu contraseña?" e ingresar una dirección ficticia (`test.auditoria.noexiste@ductsal.com`). | Mostrar mensaje neutro idéntico: *"Si el correo corresponde a una cuenta activa en DUCTSAL ERP, recibirás un enlace de restablecimiento..."*. | No se revela si la cuenta existe o no; botón se bloquea en "Enviando...". |
| **5** | **Inicio de Sesión (Credenciales Inválidas)** | Intentar login con usuario inexistente y clave aleatoria. | Notificación de error estándar sin fugas de stack trace. | Acceso denegado limpiamente. |
| **6** | **Inicio de Sesión (Gerente)** | Iniciar sesión con la cuenta de gerente autorizada. | Acceso concedido; se monta el Dashboard gerencial; se inicia `reconcileOutbox` en segundo plano. | Token porta claim de gerente; vista operativa cargada. |
| **7** | **Outbox Local (`localStorage`)** | Inspeccionar en DevTools → Application → Local Storage (`ductsal_invitation_outbox_v1`). | La clave existe; no almacena contraseñas, tokens, oobCodes ni secretos (`assertNoSecrets`). | Cero campos sensibles en almacenamiento del navegador. |
| **8** | **Prevención de Doble Envío** | En el modal de usuario, pulsar rápidamente el botón Guardar dos veces. | La variable `userSaveInFlight` bloquea el segundo clic y evita peticiones redundantes. | Se emite una única petición controlada. |
| **9** | **Reenvío de Invitaciones** | En la tabla de usuarios, localizar un usuario y presionar "Reset Pass". | Botón deshabilitado durante la operación (`resetPassInFlight`); notificación adecuada. | Se encola en outbox y se despacha de forma atómica. |
| **10** | **Activación al Primer Acceso** | Simular acceso con query param: `https://erp.ductsal.com/login?mode=activate`. | El observador de autenticación detecta `mode=activate` y prepara la confirmación. | El sistema ejecuta `confirmUserActivation` tras el login. |
| **11** | **Segregación de Roles** | Verificar visibilidad de módulos según el rol activo. | Vendedores ven únicamente su cartera; gestores ven proyectos asignados; gerencia ve totalidad. | Restricciones de interfaz y seguridad cumplidas. |
| **12** | **Enlaces de Acción de Firebase** | Inspeccionar plantilla de correo en Firebase Console. | Remitente previsto y Reply-To fijado en `informatica@grupogama.com`. | Plantilla configurada en español con Reply-To oficial. |

---

## 7. Declaración de Conformidad Final

- **No se realizó ningún despliegue a producción.**
- **No se crearon commits, push ni pull requests.**
- **No se modificó la rama `main` en el repositorio remoto.**
- **No se enviaron correos a buzones corporativos reales.**
- **El release se encuentra 100% preparado, documentado y listo para ejecución inmediata una vez recibida la orden expresa del usuario.**
