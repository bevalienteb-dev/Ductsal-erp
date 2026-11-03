# CIERRE DE CONDICIONES OPERATIVAS Y AUDITORÍA DE RELEASE 6.2 + 6.3

**Proyecto:** DUCTSAL ERP (`sales-reporting-system-release`)  
**Fecha de Evaluación:** 2 de Noviembre de 2026 (21:55 CST / 03:55 UTC del 3 de Noviembre)  
**ID de Proyecto de Producción:** `ductsal-erp` (Google Cloud Project Number: `948658286825`)  
**Dominio de Producción:** `https://erp.ductsal.com`  
**Documento:** Análisis de Riesgos Operativos, Protocolos de Recuperación, Compatibilidad de Usuarios Existentes y Criterios de Publicación  
**Estado:** **AUDITORÍA OPERATIVA ACTUALIZADA CON RESTRICCIÓN ESTRICTA DE CORREOS — CERO OPERACIONES DE PUBLICACIÓN EJECUTADAS**  
**Dictamen:** **CONDICIONES OPERATIVAS DEFINIDAS — A LA ESPERA DE DECISIÓN DE PUBLICACIÓN DEL USUARIO**  

---

## 1. Gestión de la Ventana de Despliegue

### 1.1 Naturaleza del Riesgo en el Intervalo de Despliegue
En el procedimiento de despliegue secuencial obligatorio:
1. **Despliegue de Backend (Cloud Functions):** Demora aproximadamente entre 60 y 90 segundos.
2. **Despliegue de Frontend (Vercel):** Demora aproximadamente entre 30 y 45 segundos.

Durante el **intervalo transitorio de ~2 minutos** entre ambos eventos:
* El **backend nuevo** ya está activo en Google Cloud.
* El **frontend anterior** continúa siendo servido a los navegadores de los usuarios desde la red perimetral de Vercel.

#### ¿Qué ocurre si un gerente intenta crear un usuario en ese intervalo?
* El frontend anterior invoca la Cloud Function `createUserAdmin`.
* El backend nuevo procesa la solicitud:
  - Crea el usuario en Firebase Authentication.
  - Persiste el perfil en Firestore (`users_prod`) con `invitation.status = 'prepared'`.
  - Retorna `{ sent: false, delivery: 'prepared', requestId: '...' }` (sin enlace en texto plano).
* El frontend anterior recibe la respuesta, pero **carece del módulo `crm_outbox.js` y de la llamada `sendPasswordSetupEmail` en cliente**.
* **Consecuencia Operativa:** El usuario queda creado correctamente en la base de datos y en Firebase Auth, pero el correo electrónico de invitación **no se emite en ese instante**.

---

### 1.2 Análisis de Mecanismos de Mitigación y Alternativa Recomendada

Se evaluaron tres opciones técnicas para gestionar este intervalo:

| Mecanismo Evaluado | Viabilidad Técnica | Impacto en el Sistema | Riesgo Operativo |
| :--- | :---: | :--- | :---: |
| **Opción A: Bloqueo de Callables por Flag en Base de Datos** | Baja | Exigiría modificar el código de `createUserAdmin` para leer un flag de mantenimiento en Firestore, requiriendo un doble despliegue de Functions (bloquear, desplegar frontend, desbloquear). | **Alto** (Añade mutaciones de código no probadas y duplica el riesgo de despliegue). |
| **Opción B: Regla Temporal en Firestore Rules** | Nula | Las Cloud Functions operan con Firebase Admin SDK, el cual **bypasea por diseño las reglas de seguridad de Firestore** (`firestore.rules`). No bloquearía la función administrativa. | **Ineficaz** (No detiene la ejecución del backend). |
| **Opción C: Ventana de Mantenimiento Administrativo Programado (RECOMENDADA)** | **Alta (100%)** | Procedimiento puramente operativo: notificar formalmente a los 1-2 administradores de DUCTSAL no acceder a la pestaña de Usuarios durante los 10 minutos del despliegue. | **Cero** (Cero modificaciones en código, cero riesgo de efectos colaterales). |

### 1.3 Procedimiento Recomendado y Consecuencias
* **Recomendación:** Aplicar la **Opción C (Ventana de Mantenimiento Administrativo Programado)**.  
  Dado que en DUCTSAL ERP la creación de usuarios es una potestad exclusiva de gerencia (exactamente 1 o 2 personas en Grupo Gama), basta con programar el despliegue en un horario de baja actividad comercial y acordar que no se abrirá el modal de gestión de usuarios durante el ciclo de publicación (10 minutos).
* **Consecuencias Operativas:**
  1. El resto de la empresa (vendedores y gestores) **no experimenta ninguna interrupción**: pueden continuar iniciando sesión, visualizando clientes, cotizando y consultando agendas.
  2. Si fortuitamente un gerente diera de alta un usuario en esos 120 segundos, **la base de datos no se corrompe**: el usuario queda registrado en estado `prepared`. Sin embargo, dado el agotamiento estricto del presupuesto de correos (3/3), **la emisión de su invitación no se ejecutará automáticamente**; si se requiriese emitir dicho correo, se deberá detener la acción y solicitar autorización expresa al usuario antes de proceder.

---

## 2. Procedimientos de Recuperación y Rollback para Escenarios Específicos

> [!IMPORTANT]
> **RESTRICCIÓN ABSOLUTA DE ENVÍOS DE CORREO:**  
> El presupuesto de pruebas reales está cerrado de manera terminante en 3/3 envíos.  
> **Durante el release actual, sus smoke tests y cualquier procedimiento de contingencia o rollback, NO se realizará ningún envío real de correo adicional.**  
> Si durante la operación ocurriese un escenario que requiera emitir o restablecer una contraseña mediante correo (sea desde Firebase Console, desde el frontend o mediante callables), **dicha operación debe detenerse de inmediato y solicitarse autorización expresa e independiente al usuario antes de continuar**.  
> **La autorización para publicar el release NO constituye bajo ningún concepto autorización para enviar correos.**  
> Los procedimientos descritos a continuación se documentan como capacidades técnicas verificadas, distinguiendo taxativamente su viabilidad técnica de su autorización operativa.

---

### 2.1 Escenario 1: Backend nuevo desplegado, frontend anterior activo (Ventana transitoria)
* **Componentes funcionando:** 100% de las funciones de login, consultas de clientes, cotizaciones, cálculo de comisiones y visualización de reportes.
* **Información en Firestore:** Esquema intacto. Si se creara un usuario, queda en `users_prod` con `invitation.status = 'prepared'` y ticket emitido en `invitationOps_prod`.
* **Operaciones de recuperación:** Ninguna inmediata. Continuar con el despliegue del frontend en Vercel (Paso 2).
* **Operaciones que deben evitarse:** Evitar reintentar clics sucesivos de creación de usuarios en el frontend viejo.
* **Intervención manual:** Ninguna.

---

### 2.2 Escenario 2: Backend y frontend nuevos desplegados, pero falla la activación (ej. token expirado o corte de red del usuario)
* **Componentes funcionando:** La plataforma entera funciona normalmente. El usuario no puede entrar porque aún no tiene contraseña.
* **Información en Firestore:** El documento en `users_prod` conserva `invitation.status: 'prepared'` (o `lastRequestStatus: 'failed' / 'unknown'`). La cuenta en Firebase Auth permanece intacta.
* **Operaciones de recuperación técnicamente disponibles (Requieren Autorización Previa):**
  1. **Vía Autoservicio del Usuario:** En la pantalla de login (`https://erp.ductsal.com`), el enlace "¿Olvidaste tu contraseña?". *(Técnicamente disponible, pero al emitir un correo real, su ejecución requiere autorización previa e independiente)*.
  2. **Vía Gerencial:** El botón "Reset Pass" en el panel de usuarios. *(Técnicamente disponible, pero al emitir un correo real, su ejecución requiere autorización previa e independiente)*.
* **Directiva Operativa:** Si el usuario no puede activar su cuenta, **NO presionar "Reset Pass" ni usar autoservicio de forma no autorizada**. Se debe notificar la situación y solicitar autorización expresa para un nuevo envío antes de ejecutar la acción.
* **Operaciones que deben evitarse:** No modificar manualmente el documento en Firestore ni intentar recrear el usuario eliminándolo.

---

### 2.3 Escenario 3: Rollback del frontend con backend nuevo (ej. issue visual en Vercel)
* **Componentes funcionando:** El frontend revertido restaura de inmediato la interfaz anterior (< 5 segundos). El inicio de sesión de todos los usuarios existentes sigue operando normalmente.
* **Información en Firestore:** Todos los datos permanecen seguros e íntegros. Los usuarios creados previamente con el nuevo flujo siguen existiendo en `users_prod`.
* **Operaciones de recuperación:**
  - En el panel de control de Vercel, pulsar **Instant Rollback** sobre el despliegue anterior.
* **Operaciones que deben evitarse:** No intentar crear nuevos usuarios ni reenviar invitaciones mientras el frontend esté revertido.
* **Intervención manual:** Ejecución del Instant Rollback en Vercel Dashboard.

---

### 2.4 Escenario 4: Rollback del backend después de haber creado usuarios con el nuevo flujo
* **Auditoría Técnica del Backend Legacy:**  
  Se verificó el código del backend anterior en el repositorio ([`HEAD:functions/index.js:894-921`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js)). Se constató que **en la versión anterior NO existe ningún generador de enlaces de servidor (Admin SDK)**: la función `resendInvitationAdmin` ya respondía `{ sent: false, delivery: 'client', email: profile.email }` delegando el envío al cliente. Por tanto, no existe ningún mecanismo para generar enlaces en texto plano desde el backend viejo.
* **Estado de la Información en Firestore:**  
  Los documentos creados en `users_prod` durante la vigencia del nuevo backend **no se eliminan**. Poseen `nombre`, `email`, `role`, `activo: true`, `authUid` y el sub-objeto `invitation`. La cuenta en Firebase Authentication existe.
* **Procedimiento Técnico de Recuperación si se Revierte el Backend:**
  1. **Regla de Acoplamiento Ineludible:** Si se hace rollback del backend, **ES OBLIGATORIO HACER ROLLBACK DEL FRONTEND INMEDIATAMENTE** en Vercel. Mantener el frontend nuevo conectado al backend viejo provocaría fallos de HTTP 404 al invocar callables inexistentes (`recordInvitationOutcomeAdmin`, `confirmUserActivation`).
  2. **Habilitación de Usuarios Creados (Disponibilidad Técnica vs. Autorización):**  
     Para los usuarios creados durante la ventana del nuevo backend, sus perfiles en `users_prod` son leídos sin ningún error por el backend anterior. Existen dos alternativas técnicas para permitirles definir contraseña:
     - **Alternativa 1 (Firebase Console):** Administrador accede a **Firebase Console > Authentication > Users**, localiza al usuario y pulsa **"Send password reset email"**.
     - **Alternativa 2 (Frontend Revertido):** El gerente pulsa "Reset Pass" en el frontend viejo, el cual invoca `resendInvitationAdmin` legacy y despacha `sendPasswordSetupEmail` en cliente.
  3. **ADVERTENCIA Y RESTRICCIÓN DE AUTORIZACIÓN:**  
     **Ambas alternativas generan correos electrónicos reales hacia el destinatario.**  
     Dado que el presupuesto de 3/3 correos está formalmente agotado, **ninguna de estas dos alternativas puede ejecutarse automáticamente durante un rollback**.  
     Si ocurre un rollback y se requiere habilitar a un usuario creado con el nuevo backend, **la operación debe detenerse y se debe solicitar una autorización expresa e independiente al usuario para emitir el correo correspondiente**.
* **Operaciones que deben evitarse:** No intentar editar a mano los hashes o contraseñas en Firestore ni ejecutar envíos sin autorización.

---

### 2.5 Escenario 5: Reconciliación de Tickets y Distinción Estricta de Estados

Para evitar ambigüedades técnicas, se definen taxativamente los cuatro niveles de estado que intervienen en la arquitectura:

```
[1. Firestore: invitationOps] ---> [2. LocalStorage: Outbox] ---> [3. Firebase API: HTTP 200] ---> [4. Servidor MX Destino]
   (ISSUED / RECORDED)             (unknown / accepted / failed)      (Solicitud Encolada)            (Buzón / Inbox / Junk)
```

1. **Estado del Ticket en Firestore (`invitationOps_prod/<requestId>`):**
   - `ISSUED`: El backend emitió la autorización del ticket y lo pre-registró con un TTL de 24 horas. **No implica que el cliente haya emitido la petición de correo**.
   - `RECORDED`: El backend procesó el reporte del cliente (`recordInvitationOutcomeAdmin`), registrando el resultado final (`outcome: 'accepted' | 'failed' | 'unknown'`) y cerrando el ciclo del ticket.
2. **Estado del Outbox en `localStorage` del Cliente (`crm_outbox.js`):**
   - `unknown`: El ticket fue persistido localmente antes de invocar la red, o la petición quedó sin respuesta confirmada por corte de conexión o timeout.
   - `accepted`: El Firebase Client SDK completó la llamada `sendPasswordResetEmail` sin arrojar excepción.
   - `failed`: El Firebase Client SDK arrojó un error controlado (ej. `auth/too-many-requests`).
3. **Aceptación de la Solicitud por Firebase (HTTP 200 en Identity Toolkit):**
   - La API de Google aceptó la solicitud y la encoló en su infraestructura de mensajería interna. **NO es sinónimo de entrega en buzón**, solo de aceptación por el proveedor de autenticación.
4. **Entrega Efectiva del Correo (Transferencia SMTP al Servidor MX de Destino):**
   - El servidor de Google contacta vía SMTP al servidor de correo corporativo (`grupogama-com.mail.protection.outlook.com`).
   - El filtro antispam de destino (EOP) evalúa el mensaje y decide si lo ubica en Inbox o Junk.
   - **Limitación Arquitectónica Fundamental:** Firebase Authentication no expone webhooks ni eventos de entrega SMTP hacia el CRM. Por lo tanto, el sistema DUCTSAL ERP nunca puede certificar de manera automática si un correo fue abierto o clasificado como spam.

#### ¿Qué resuelve automáticamente `reconcileOutbox` y qué requiere intervención manual?
* **Lo que resuelve automáticamente:**
  - Sincroniza tickets locales que quedaron en `unknown` en el navegador del gerente (por ejemplo, si se cerró la pestaña tras enviar o hubo latencia de red).
  - Al iniciar sesión gerencial, `CrmAuth.reconcileOutbox` consulta a la Cloud Function `reconcileUserOp` y cierra el estado en Firestore.
  - Purga automáticamente registros locales con más de 24 horas (TTL).
* **Lo que requiere intervención manual:**
  - **Rebotes permanentes (*hard bounces*):** Si el correo corporativo del destinatario no existe o fue deshabilitado por IT, el sistema no recibe notificación; el gerente debe verificar la dirección manualmente con el colaborador.
  - **Clasificación en Junk (Spam Filter):** Si Microsoft 365 clasifica el mensaje como Junk (SCL 5), el CRM registró la operación como `accepted` (a nivel de API), pero el usuario debe revisar manualmente su carpeta de correo no deseado hasta que IT aplique la regla correspondiente en el tenant.
  - **Pérdida de almacenamiento local:** Si el gerente limpia la caché del navegador antes de reconectar, el registro local se pierde (el ticket en Firestore expirará limpiamente por TTL).

---

### 2.6 Escenario 6: Usuario Creado sin Haber Completado la Activación
* **Componentes funcionando:** El usuario existe en Firebase Auth y en Firestore, pero no tiene credenciales operativas. El resto de usuarios opera normalmente.
* **Información en Firestore:** `users_prod/<id>` conserva `activo: true`, `authUid: "..."`, `invitation.status: 'prepared'`, `invitation.sentCount: 1`.
* **Operaciones de recuperación:**
  - El usuario puede redimir el enlace recibido previamente en su buzón dentro del periodo de vigencia (3 días) sin generar tráfico nuevo.
  - Si el enlace caducó y se requiere emitir uno nuevo, **se deberá solicitar autorización expresa previa antes de usar "Reset Pass" o "¿Olvidaste tu contraseña?"**.
* **Operaciones que deben evitarse:** No desactivar la cuenta en Firestore a menos que se desee cancelar la contratación.
* **Intervención manual:** Ninguna si el enlace está vigente.

---

## 3. Compatibilidad de Usuarios Existentes

Se auditó de forma minuciosa la compatibilidad del nuevo sistema con los 4 usuarios activos en producción:
* `dgonzalez@ductsal.com` (Administrador / Gerencia)
* `bvaliente@grupogama.com` (Administrador / TI / Auditoría)
* `aayala@ductsal.com` (Ventas / Operativo)
* `rflores@ductsal.com` (Ventas / Operativo)

### 3.1 Verificación del Flujo de Autenticación
1. **Inicio de Sesión (Login):**  
   - El formulario `#login-form` invoca `CrmAuth.loginWithFirebase(firebase, user, pass)`.
   - La validación de credenciales se delega directamente a `firebase.auth().signInWithEmailAndPassword(email, pass)`.
   - Las cuentas existentes en Firebase Auth **no sufren ninguna modificación de contraseña, hash ni estado**.
   - La resolución de perfiles en [`crm_auth.js:157-164`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js#L157-L164) (`findLoginUser`) realiza búsqueda exacta primero y coincidencia insensible a mayúsculas para perfiles vinculados activos.
   - **Resultado:** Inicio de sesión transparente y respaldado para los 4 usuarios.
2. **Recuperación de Contraseña:**  
   - Los usuarios existentes que olviden su contraseña dispondrán del modal `#forgot-password-modal`.
   - La solicitud se envía a Google Identity Platform con `PRODUCTION_ACTION_CODE_SETTINGS` (`https://erp.ductsal.com/login?mode=activate`).
   - Al redimir el enlace, establecen su nueva contraseña en Firebase Auth y regresan a DUCTSAL ERP con su sesión habilitada.
3. **Roles y Permisos:**  
   - El perfil de Firestore `users_prod` mantiene inalterados los campos `role` (`manager`, `vendedor`, `gestor`), `nombre` y `activo`.
   - La verificación de roles en el cliente (`currentUser.role`) y en el backend (`assertManager`, `assertRequesterProfileActive`) sigue leyendo exactamente los mismos campos.
4. **Relación Firebase Auth UID y Perfil Firestore:**  
   - Los 4 usuarios existentes cuentan con su `authUid` formalmente vinculado en `users_prod`.
   - Las guardas de seguridad en el backend y frontend verifican que `context.auth.uid === user.authUid`. Al estar ya alineados, no se dispara ningún error de discrepancia (`uid-mismatch`).
5. **Compatibilidad con Cuentas Históricas:**  
   - La Cloud Function `linkHistoricalUserAdmin` se preserva intacta en [`functions/index.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) para permitir que perfiles antiguos sin cuenta Auth puedan vincularse de manera transparente si fuera necesario en el futuro.

### 3.2 Dictamen de Compatibilidad Respaldado por Evidencia
Con base en las **2,371 pruebas automatizadas aprobadas** (2,310 unitarias Jest y 61 en emuladores reales) y la auditoría estática del código:
* La compatibilidad de los flujos de autenticación, roles, consultas comerciales y permisos de los 4 usuarios activos actuales se encuentra **plenamente respaldada en todos los escenarios evaluados**.
* No se identificaron regresiones en las llamadas de sesión ni en la estructura de documentos de Firestore existentes.

---

## 4. Criterios de Publicación, Aborto y Rollback

### 4.1 Criterios Previos al Despliegue (Pre-Flight Checklist)
Antes de ejecutar cualquier comando de publicación, deben cumplirse las siguientes condiciones obligatorias:
* [ ] **Autorización Expresa del Usuario para Publicar:** Aprobación formal y por escrito para iniciar la publicación.
* [ ] **Ratificación de Restricción de Correos:** Certificación de que el presupuesto está agotado en 3/3 y **no se emitirá ningún correo durante el release ni sus pruebas**. Se entiende expresamente que la autorización de despliegue no autoriza envíos de correo.
* [ ] **Git Limpio:** Salida limpia de `git diff --check` (0 observaciones de formato).
* [ ] **Pruebas Automatizadas Verificadas:** 2,371 pruebas aprobadas (2,310 unitarias + 61 en emulador real).
* [ ] **Ventana de Mantenimiento Notificada:** Confirmación de que gerencia no creará usuarios en los 10 minutos previstos.
* [ ] **Disponibilidad de Consolas de Rollback:** Sesiones abiertas y listas en Vercel Dashboard y Firebase Console.

---

### 4.2 Criterios Durante el Despliegue (In-Flight Checklist)
* [ ] **Secuencia Estricta:**  
  1. **Desplegar Backend Primero:** `firebase deploy --only functions --project ductsal-erp`.  
  2. **Verificar Salida:** Confirmar mensaje `Deploy complete!` con HTTP 200 para todas las callables.  
  3. **Desplegar Frontend Inmediatamente Después:** Publicar el commit del release en la rama `main` de Vercel.  
  4. **Verificar Pipeline Vercel:** Confirmar que el build termine en estado `Ready` (< 60 segundos).

---

### 4.3 Criterios de Aborto Inmediato (Abort Triggers)
Se cancela la operación de publicación antes de afectar a producción si ocurre cualquiera de los siguientes eventos:
1. **Fallo en `firebase deploy --only functions`:** Si Google Cloud Functions rechaza el despliegue por error de compilación, sintaxis, cuota o permisos, **ABORTAR INMEDIATAMENTE**. No tocar Vercel. El sistema de producción permanece 100% operativo en su versión anterior.
2. **Fallo en Vercel Build:** Si Vercel rechaza el empaquetado del frontend, **ABORTAR**. Revertir el backend si fuese necesario o corregir el build antes de propagar.

---

### 4.4 Criterios de Rollback Inmediato (Rollback Triggers)
Tras la propagación en Vercel, se ejecutará el rollback inmediato si se presenta cualquiera de las siguientes condiciones en los Smoke Tests:
1. **Pantalla Blanca o Excepción Crítica:** `https://erp.ductsal.com` no carga o arroja excepción bloqueante en consola (`TypeError`, `ReferenceError`).  
   → **Acción:** Pulsar **Instant Rollback** en Vercel Dashboard (< 5 segundos).
2. **Fallo de Login en Usuario Existente:** Un usuario administrativo no puede iniciar sesión con sus credenciales válidas habituales.  
   → **Acción:** Instant Rollback en Vercel y posterior rollback de Cloud Functions.
3. **Discrepancia en ActionCodeSettings:** La variable `CrmAuth.ACTION_CODE_SETTINGS.url` no resuelve a `https://erp.ductsal.com/login?mode=activate`.  
   → **Acción:** Instant Rollback en Vercel.

---

### 4.5 Smoke Tests Posteriores al Despliegue (Validación en Vivo sin Envíos Reales)
> [!IMPORTANT]
> **RESTRICCIÓN ABSOLUTA DE CORREO:**  
> Dado que el presupuesto de pruebas reales está formalmente cerrado en 3/3 envíos, **NO se realizará ninguna activación real adicional ni se enviarán correos durante los smoke tests**.  
> Las comprobaciones se limitarán estrictamente a la integridad de la interfaz, carga de librerías, constantes y respuestas neutrales locales:

Nada más propagarse Vercel, el auditor abrirá `https://erp.ductsal.com` con DevTools abierto y verificará:
* [ ] **ST-1 (Carga Limpia):** La página carga sin errores 404 ni excepciones JavaScript en consola.
* [ ] **ST-2 (Constante de Retorno):** Ejecutar en consola `CrmAuth.ACTION_CODE_SETTINGS.url` y confirmar que retorne `'https://erp.ductsal.com/login?mode=activate'`.
* [ ] **ST-3 (Modal Accesible):** Clic en "¿Olvidaste tu contraseña?", comprobar apertura fluida de `#forgot-password-modal` y cierre con tecla `Escape`.
* [ ] **ST-4 (Anti-Enumeración Sintética):** En el modal de recuperación, ingresar una dirección de prueba sintética (`smoke.test@ductsal.com`), pulsar "Enviar Enlace", verificar estado in-flight en el botón y confirmar mensaje neutral idéntico sin revelar la inexistencia de la cuenta y sin crear registros productivos.
* [ ] **ST-5 (Sesión Gerencial Existente):** Iniciar sesión con una cuenta administrativa existente y verificar carga completa del dashboard gerencial sin errores de permisos ni alteración de perfil.

---

## 5. Dictamen Técnico Final de Cierre Operativo

```
================================================================================
           DICTAMEN TÉCNICO FINAL DE CIERRE OPERATIVO (RELEASE 6.2 + 6.3)
================================================================================
ESTADO TÉCNICO: PREPARACIÓN OPERATIVA COMPLETADA CON OBSERVACIONES
DICTAMEN: PAQUETE TÉCNICAMENTE LISTO PARA PUBLICACIÓN CONTROLADA

SÍNTESIS DE CONDICIONES AUDITADAS Y RESTRICCIONES RATIFICADAS:
1. Restricción Absoluta de Correos: Presupuesto cerrado en 3/3. No se emitirá 
   ningún correo durante el despliegue, smoke tests ni rollback. La autorización 
   de release NO ampara envíos de correo. Si se requiere enviar un correo, se debe 
   detener la acción y solicitar autorización independiente previa.
2. Ventana de Despliegue: Mitigada mediante Ventana de Mantenimiento Administrativo 
   Programado (Opción C, sin mutar código ni alterar el ERP).
3. Protocolos de Recuperación: Documentada la disponibilidad técnica de las 
   opciones de recuperación en Firebase Console y frontend, dejando asentado 
   que su ejecución efectiva requiere autorización previa por generar correos reales.
4. Reconciliación de Tickets: Claramente diferenciadas las 4 capas (Firestore, 
   LocalStorage, API de Google y Servidor MX de destino). Identificados los límites 
   de automatización y los casos de intervención manual.
5. Compatibilidad de Usuarios Existentes: Plenamente respaldada por 2,371 pruebas 
   automatizadas aprobadas (0 fallos).
6. Integridad de Repositorio: Cero commits, cero despliegues, código congelado.
================================================================================
```

*Se aclara formalmente que el presente dictamen técnico de preparación **no constituye autorización de publicación**. La decisión y el momento de autorizar el despliegue corresponden de manera exclusiva e independiente al usuario.*
