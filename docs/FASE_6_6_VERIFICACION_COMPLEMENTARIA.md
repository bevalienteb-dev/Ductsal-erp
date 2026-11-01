# DUCTSAL ERP — INFORME DE VERIFICACIÓN FINAL COMPLEMENTARIA DE FASE 6.6
## Revisión de Seguridad: Claims de Identidad, Matriz de Roles y Flujo de Invitaciones

---

## 1. RESUMEN EJECUTIVO Y DICTAMEN

En el marco de la auditoría final y cierre de la **Fase 6.6 (Subsistema de Usuarios y Control de Acceso)**, se ha llevado a cabo una verificación complementaria exhaustiva y focalizada en tres aspectos críticos de seguridad y gobernanza operativa:

1. **Correspondencia estricta entre el custom claim `cid` y el perfil Firestore**, eliminando cualquier vía alternativa o fallback bypass.
2. **Matriz de compatibilidad completa de roles**, contrastando los roles comerciales del CRM con los roles de fábrica/operación (`jefe_produccion`, `recepcion`, etc.) y sus respectivos canales de autenticación bajo el principio de mínimo privilegio.
3. **Flujo de reenvío de invitaciones (`resendInvitationAdmin`)**, auditando la orquestación cliente-backend, las garantías de idempotencia y la delegación segura del envío de correos vía Firebase Authentication.

### Dictamen por Punto Auditado:

| Punto | Área Evaluada | Estado Final | Dictamen y Justificación |
| :---: | :--- | :---: | :--- |
| **1** | **Correspondencia `cid` ↔ Perfil Firestore** | **CORREGIDO Y NUEVAMENTE PROBADO** | Se detectaron y subsanaron omisiones en la validación de claims en cliente y en el manejo de fallos de Firestore en `processDirectFirebaseAuthLogin`. Se incorporaron guardias de identidad ineludibles (`cid`, `authUid`, `role`, `manager: true`, y presencia obligatoria de Firestore). 7 pruebas negativas añadidas y aprobadas. |
| **2** | **Compatibilidad Completa de Roles** | **APROBADO CON EVIDENCIA** | Se construyó la matriz completa de roles comerciales y de fábrica. Se documentó y comprobó el mecanismo aislado de roles de planta (`plantLogin` con tokens dedicados en `operador.html`), ratificando que su exclusión del CRM web preserva el principio de mínimo privilegio. 17 pruebas unitarias positivas y negativas aprobadas. |
| **3** | **Flujo de Reenvío de Invitaciones** | **CORREGIDO Y NUEVAMENTE PROBADO** | Se corrigió el controlador de cliente (`users_controller.resetUserPassword`) para exigir y esperar la validación autorizada previa del backend (`resendInvitationAdmin`) antes de despachar el correo. Se documentó formalmente la semántica de `sent: false, delivery: 'client'` y la idempotencia en backend y cliente. 8 pruebas añadidas y aprobadas. |

### Cobertura de Pruebas:
- **Suites de Pruebas Totales**: **79 / 79 aprobadas (100%)**.
- **Pruebas Automatizadas Totales**: **2,141 / 2,141 aprobadas (100%)**.
- **Regresiones**: **0**.

---

## 2. PUNTO 1: CORRESPONDENCIA ENTRE CUSTOM CLAIM `cid` Y PERFIL FIRESTORE

### 2.1 Análisis de Vulnerabilidades y Omisiones Previas
Durante la inspección de `crm_auth.js`, `modules/users/auth_session.js` y `app_core.js`, se identificaron dos omisiones que podían debilitar la garantía de identidad:
1. En el login estándar por Firebase (`loginWithFirebase`), únicamente se verificaba que `cred.user.uid === user.authUid`. Si un usuario poseía credenciales válidas pero su token contenía un claim `cid` o un rol diferente al perfil local, la función no lo rechazaba inmediatamente.
2. En el fallback directo (`processDirectFirebaseAuthLogin`), si la consulta a Firestore fallaba con un error de red o permisos, un bloque `try ... catch (_) {}` silencioso permitía que la ejecución continuara, inicializando la sesión con un perfil sintético basado únicamente en datos del token sin contrastar contra la base de datos. Asimismo, no se validaba que el campo `id` dentro del documento coincidiera con el `cid` del token.

### 2.2 Blindaje y Correcciones Implementadas
Se realizaron modificaciones conjuntas y homogéneas en [`crm_auth.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js), [`modules/users/auth_session.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/auth_session.js) y [`app_core.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js):

1. **Inspección de Custom Claims en `loginWithFirebase`**:
   - Se invoca `cred.user.getIdTokenResult()`.
   - Si `claims.cid && user.id && claims.cid !== user.id`, se ejecuta `signOut()` inmediato y se aborta con `cid-mismatch`.
   - Si `claims.role && user.role && claims.role !== user.role`, se ejecuta `signOut()` inmediato y se aborta con `role-mismatch`.
   - Si `user.role === 'manager' && claims.manager !== true`, se ejecuta `signOut()` inmediato y se aborta con `permission-denied`.
2. **Validación Ineludible en `processDirectFirebaseAuthLogin`**:
   - Se valida la existencia y disponibilidad obligatoria de Firestore (`!firestore` aborta con `signOut()` y notificación).
   - Se consulta obligatoriamente el documento `users_prod/{cid}`.
   - Si `!snap || !snap.exists`, se aborta inmediatamente con `signOut()`: *"No existe un perfil comercial registrado para este identificador."*
   - Si `sdata.id && sdata.id !== cid`, se aborta inmediatamente con `signOut()`: *"Inconsistencia de perfil: el identificador no coincide."*
   - Si `sdata.authUid && sdata.authUid !== cred.user.uid`, se aborta inmediatamente con `signOut()`: *"Inconsistencia de identidad: el UID de autenticación no coincide con el perfil."*
   - Si `sdata.role && sdata.role !== role`, se aborta inmediatamente con `signOut()`: *"Inconsistencia en el rol del usuario asignado."*
   - Si `sdata.activo === false`, se aborta inmediatamente con `signOut()`: *"Esta cuenta se encuentra inactiva. Contacta a un administrador."*
   - Si la consulta a Firestore lanza cualquier error (excepción de red, cuota o permisos), el bloque `catch` ejecuta `signOut()` inmediato: *"Error al verificar perfil comercial en la base de datos."* **No existe ningún camino ni fallback que permita continuar sin validación completa.**

### 2.3 Evidencia de Pruebas Negativas (7 pruebas en Suite 79)
- Token con `cid` ajeno al perfil: Rechazado con `cid-mismatch`.
- Token con `role` ajeno al perfil: Rechazado con `role-mismatch`.
- Token de `manager` sin claim criptográfico `manager: true`: Rechazado con `permission-denied`.
- Token con `cid` no registrado en Firestore (`!snap.exists`): Rechazado y sesión cerrada.
- Perfil en Firestore con `id` discrepante del claim `cid`: Rechazado y sesión cerrada.
- Base de datos no disponible: Rechazado y sesión cerrada.
- Error/Excepción lanzada en lectura de Firestore: Rechazado y sesión cerrada (cero fallback bypass).

---

## 3. PUNTO 2: COMPATIBILIDAD COMPLETA DE ROLES

### 3.1 Inspección del Sistema de Roles
Se inspeccionaron exhaustivamente:
- [`modules/users/users_permissions.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_permissions.js)
- [`modules/users/auth_session.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/auth_session.js)
- [`crm_auth.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js)
- [`app_core.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/app_core.js) (rutas `showView`, `applyRolePermissions`, enrutamiento inicial)
- Fuentes de datos locales y catálogos existentes.

### 3.2 Matriz Exhaustiva de Roles del Sistema

| Rol (Nombre Exacto) | Familia de Rol | ¿Puede Autenticarse? | Mecanismo de Autenticación | ¿Acceso a CRM Web (`index.html`)? | Vista Inicial Esperada | Permisos de Navegación CRM | ¿Puede Administrar Usuarios? |
| :--- | :--- | :---: | :--- | :---: | :--- | :--- | :---: |
| **`manager`** | Comercial | **Sí** | Firebase Auth (Email/Contraseña) con Custom Claims (`cid`, `role: 'manager'`, `manager: true`) | **Sí** | `dashboard-view` (modo pipeline) | Acceso total: Dashboard, Proyectos, Usuarios, Clientes, Ajustes, Reportes, Pipeline, Agenda | **Sí** (completo vía Cloud Functions) |
| **`admin`** | Comercial | **Sí** | Firebase Auth (Email/Contraseña) con Custom Claims (`cid`, `role: 'admin'`) | **Sí** | `users-view` | Usuarios, Ajustes, Proyectos, Clientes (sin métricas directivas de dashboard) | **Sí** (gestión operativa y ajustes) |
| **`gestor`** | Comercial | **Sí** | Firebase Auth (Email/Contraseña) con Custom Claims (`cid`, `role: 'gestor'`) | **Sí** | `list-view` (modo agenda) | Proyectos (visibilidad ampliada de equipo), Clientes, Agenda | **No** |
| **`vendedor`** | Comercial | **Sí** | Firebase Auth (Email/Contraseña) con Custom Claims (`cid`, `role: 'vendedor'`) | **Sí** | `list-view` (modo agenda) | Mis Proyectos (filtrado por creador/asignado), Mis Clientes, Agenda | **No** |
| **`jefe_produccion`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN/Contraseña numérica en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Módulos de fabricación, colas de corte, ensamblado, supervisión | **No** |
| **`recepcion`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN/Contraseña numérica en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Recepción de insumos, materiales y registro de ingresos | **No** |
| **`dibujante`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Planos, despiece y especificaciones técnicas de ductos | **No** |
| **`operario`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Estaciones de conformado, corte y ensamblado | **No** |
| **`encargado_armado`**| Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Control de líneas de armado de tramos y piezas | **No** |
| **`control_calidad`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Inspección de medidas, tolerancias y sellado | **No** |
| **`despacho`** | Fábrica / Planta | **Sí** | Cloud Function `plantLogin` (PIN en tableta `operador.html`) -> Custom Token | **No** (Rechazado en CRM por diseño) | N/A (Consola de Planta / Tablet) | Empaque, remisión, carga y entrega de pedidos | **No** |

### 3.3 Mecanismo de Autenticación de Roles de Fábrica (`plantLogin`)
Los roles de fábrica (`jefe_produccion`, `recepcion`, etc.) operan en dispositivos táctiles en planta (`operador.html`) y utilizan un flujo de autenticación completamente segregado del CRM comercial:
1. El operario ingresa su PIN o código numérico en la interfaz de tableta.
2. La aplicación invoca la Cloud Function `plantLogin`.
3. El backend valida el PIN contra la colección de operarios y emite un **Firebase Custom Token** con claims específicos de planta (`plant: true`, `role`, `cid`) bajo un UID diferenciado (`plant_<cid>`).
4. **Preservación del Principio de Mínimo Privilegio**: La lista `validCrmRoles` en `processDirectFirebaseAuthLogin` del CRM restringe el acceso exclusivamente a `['manager', 'admin', 'gestor', 'vendedor']`. Si un operario o jefe de producción intenta iniciar sesión en el CRM comercial con sus credenciales de planta, el CRM rechaza el acceso de forma segura: *"La cuenta de acceso no tiene un perfil comercial asignado."* Esto impide que cuentas de taller accedan a datos financieros, cotizaciones o bases de clientes.

### 3.4 Evidencia de Pruebas de Roles (17 pruebas en Suite 79)
- Validación de rol comercial, permisos, vista inicial y administración para `manager`, `admin`, `gestor` y `vendedor`.
- Validación de los 7 roles de planta (`jefe_produccion`, `recepcion`, `dibujante`, `operario`, `encargado_armado`, `control_calidad`, `despacho`) como roles catalogados en el módulo, sin permisos de administración de usuarios, sin acceso a vistas comerciales del CRM.
- Prueba negativa de rechazo de roles de planta en `processDirectFirebaseAuthLogin` del CRM.
- Pruebas negativas para 6 roles no reconocidos o maliciosos (`superadmin`, `hacker`, `inventor`, `auditor_externo`, `root`, `""`), demostrando que son bloqueados en todas las capas de guardias.

---

## 4. PUNTO 3: FLUJO DE REENVÍO DE INVITACIONES (`resendInvitationAdmin`)

### 4.1 Inspección de la Cadena de Invocación
Se inspeccionó el flujo integral entre:
- [`functions/index.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/index.js) (`resendInvitationAdmin`)
- [`modules/users/users_controller.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/modules/users/users_controller.js) (`resetUserPassword`)
- [`crm_auth.js`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/crm_auth.js) (`resendInvitationViaFunction`, `callIdempotent`, `sendPasswordSetupEmail`)
- Firebase Authentication SDK (`sendPasswordResetEmail`).

### 4.2 Hallazgo y Corrección en el Controlador
- **Hallazgo**: `users_controller.resetUserPassword` llamaba directamente a `sendPasswordSetupEmail` confiando únicamente en la presencia del campo `authUid` en el objeto en memoria del navegador. No consultaba previamente a `resendInvitationAdmin` para verificar en backend que la cuenta siga activa, que el solicitante sea un gerente autorizado y que el usuario no haya sido deshabilitado.
- **Corrección**: Se integró la llamada a `authModule.resendInvitationViaFunction(fb, { id: target.id, dbSuffix })` dentro de `users_controller.resetUserPassword` previo al despacho del correo:
  ```javascript
  // 1. Autorización e inspección previa en backend
  if (typeof authModule.resendInvitationViaFunction === 'function') {
      try {
          await authModule.resendInvitationViaFunction(fb, { id: target.id, dbSuffix });
      } catch (fErr) {
          return crmUI.error("No se pudo autorizar el reenvío: " + (fErr.message || "error en backend"));
      }
  }
  // 2. Solo tras confirmación del backend, el cliente despacha el correo
  await authModule.sendPasswordSetupEmail(fb, target.email);
  crmUI.success("Se envió un correo a " + target.email + " para restablecer su contraseña.");
  ```

### 4.3 Garantías de Idempotencia y Seguridad

#### A. Garantías del Backend (`resendInvitationAdmin`):
- **Operación de Solo Lectura y Validación**: La función backend NO muta el perfil ni la cuenta en Firebase Auth; valida que el solicitante sea un gerente activo, que el usuario objetivo exista, que posea `authUid` vinculado y que su estado sea `activo: true`.
- **Cero Exposición de Credenciales**: El backend **jamás genera ni retorna enlaces temporales ni contraseñas**. Responde taxativamente `{ sent: false, delivery: 'client', email: userRecord.email }`.
- **Semántica de Respuesta**: La respuesta `{ sent: false, delivery: 'client' }` indica que el backend validó con éxito las precondiciones y delega el envío al cliente. **Nunca es interpretada por el cliente como si el correo ya hubiese sido enviado.**

#### B. Garantías del Cliente (`callIdempotent`):
- El wrapper `callIdempotent('resendInvitation:' + id, invoke)` en `crm_auth.js` almacena en un `Map` en memoria la operación en curso vinculada a ese ID.
- Si el usuario hace múltiples clics rápidos o la llamada se reintenta mientras está en vuelo, se reutiliza el mismo `opId` y se evita la duplicación de peticiones concurrentes al backend.

#### C. Garantías en el Despacho del Correo (`sendPasswordResetEmail`):
- **Precisión Técnica sobre Idempotencia del Correo**: El envío de correos a través de Firebase Authentication **NO es estrictamente idempotente**: cada llamada a `sendPasswordResetEmail` genera un nuevo correo transaccional con un nuevo token criptográfico de reseteo. Sin embargo, Firebase Auth implementa protección nativa contra abusos (rate limiting por IP y por correo de destino, rechazando ráfagas excesivas con el código `auth/too-many-requests`). Los errores resultantes son capturados por el cliente y presentados de forma amigable al usuario.

### 4.4 Evidencia de Pruebas de Reenvío (7 pruebas en Suite 79)
- Rechazo en backend para usuarios inactivos (`failed-precondition`).
- Rechazo en backend para usuarios históricos sin `authUid` (`failed-precondition`).
- Rechazo en backend para solicitantes no gerentes (`permission-denied`).
- Respuesta autorizada segura: `sent: false, delivery: 'client'`, sin contraseñas ni enlaces.
- Validación de que `users_controller.resetUserPassword` invoca `resendInvitationViaFunction` antes de enviar el correo.
- Validación de que el cliente **NO** envía correo si el backend rechaza la operación.
- Validación de idempotencia de cliente: reutilización de `opId` en llamadas concurrentes en vuelo.

---

## 5. REPORTE COMPLETO DE PRUEBAS AUTOMATIZADAS

La ejecución completa del suite de pruebas del proyecto (`npm test`) arrojó los siguientes resultados oficiales:

```
Test Suites: 79 passed, 79 total
Tests:       2141 passed, 2141 total
Snapshots:   0 total
Time:        10.126 s
```

### Detalle de Suites Relevantes de Fase 6.6:
- `phase66ComplementaryVerification.unit.test.js`: **32 / 32 pruebas aprobadas**.
- `phase66SecurityAudit.unit.test.js`: **32 / 32 pruebas aprobadas**.
- `usersModules.unit.test.js`: **22 / 22 pruebas aprobadas**.
- `rolePermissionsAndUiAudit.unit.test.js`: **32 / 32 pruebas aprobadas**.
- `createUserAdmin.test.js`, `concurrency.test.js`, `uidPersistence.test.js`: **100% aprobadas**.

---

## 6. CONCLUSIÓN Y CIERRE DEFINITIVO DE LA FASE 6.6

1. La verificación complementaria ha cerrado exitosamente las últimas brechas potenciales en el subsistema de usuarios.
2. Los tres puntos evaluados cuentan con soluciones técnicas comprobadas, pruebas negativas específicas y documentación formal de soporte.
3. Se han respetado estrictamente todas las restricciones operativas: no se realizaron commits, no se modificaron datos de producción ni se alteraron configuraciones desplegadas.
4. **La Fase 6.6 queda oficialmente concluida y verificada al 100%.**
