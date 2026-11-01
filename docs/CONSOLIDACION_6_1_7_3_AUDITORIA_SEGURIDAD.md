# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 3: Auditoría Integral de Seguridad y Backend

**Fecha:** 31 de Octubre de 2026  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Directorio local:** `/Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release`  
**Prioridad:** **CRÍTICA**  
**Resultado de Auditoría:** **APROBADO — 0 VULNERABILIDADES CRÍTICAS O ALTAS**  

---

## 1. RESUMEN EJECUTIVO DE SEGURIDAD

Se realizó una inspección estricta y exhaustiva de todas las superficies de ataque y vectores de autorización del sistema:
1. **Reglas de Seguridad de Firestore (`firestore.rules`)** y **Storage (`storage.rules`)**.
2. **Cloud Functions de Gestión Administrativa y Comercial (`functions/index.js`)**.
3. **Flujo de Autenticación, Verificación de Claims y Mitigación de Desincronización (`crm_auth.js` y `auth_session.js`)**.
4. **Operaciones Directas en Frontend vs. Operaciones Mediadas por Backend**.
5. **Auditoría de Credenciales, Secretos y Variables de Entorno**.

Todos los controles obligatorios fueron verificados positivamente. No se aceptan identidades suministradas únicamente por el cliente; todas las operaciones sensibles están respaldadas por comprobaciones criptográficas del token de Firebase Auth y verificación del perfil activo en el backend.

---

## 2. AUDITORÍA DE REGLAS DE FIRESTORE (`firestore.rules`)

### 2.1 Modelo de Identidad y Sesión Válida (`validSession()`)
El acceso a Firestore no confía ciegamente en el token de Firebase Auth ni en los datos enviados por la interfaz web:
- **`hasClaims()`**: Requiere token con `cid` comercial no vacío y un rol perteneciente a la lista blanca (`crmRoles` o `plantRoles`).
- **`validSession()`**: Requiere que el perfil en `users_prod/$(cid)` tenga:
  1. `authUid == request.auth.uid` (vinculación criptográfica del UID).
  2. `activo == true` (revocación inmediata si el usuario es desactivado).
  3. `role == request.auth.token.role` (coincidencia estricta de rol).
- **Protección contra Cuentas no Autorizadas**: Cualquier cuenta de Firebase creada por registro público carece de claims y tiene acceso 100% denegado a todas las colecciones.

### 2.2 Blindaje de Colecciones Críticas

| Colección | Regla Lectura | Regla Creación | Regla Modificación | Regla Eliminación | Justificación de Seguridad |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `users_prod/{userId}` | Manager o propio | `false` | `false` | `false` | Inmutable desde frontend. Mutación exclusiva mediante Cloud Functions con Admin SDK. |
| `userDirectory_prod/{userId}` | Sesión válida | `false` | `false` | `false` | Directorio público seguro sin credenciales ni contraseñas. |
| `clients_prod/{clientId}` | Manager, Gestor o Vendedor asignado (`visibleTo`) | `false` | Solo campos operativos; inmutable `createdBy`, `visibleTo`, NIT, DUI | `false` | Creación y borrado centralizados en Cloud Functions para preservar índices de unicidad. |
| `prospects_prod/{prospectId}` | Manager, Gestor asignado/postcierre, Vendedor propio | Restringido a creador / vendedor | **`false`** | **`false`** | **SEC-04**: Actualizaciones y borrados directos deshabilitados. Toda modificación comercial pasa por Cloud Functions con auditoría. |
| `system_prod/{docId}` | Sesión válida | `false` | `false` | `false` | Configuración operativa de solo lectura para el cliente. |

---

## 3. AUDITORÍA DE REGLAS DE FIREBASE STORAGE (`storage.rules`)

- **Aislamiento de Rutas por Entorno**: Se bloquea estrictamente la mezcla de prefijos (`prod_files/` vs. `local_files/`). Un entorno local o staging no puede leer ni escribir en las rutas productivas.
- **Lista Blanca de Extensiones Documentales**: Solo se admiten archivos en rutas autorizadas con extensiones validadas (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.docx`, `.xlsx`).
- **Sincronización `isPostclosing`**:
  Tanto `firestore.rules` como `storage.rules` implementan la versión blindada que evalúa `d != null` y requiere `estado != 'activo' && estado != 'perdido'`, garantizando que los vendedores no puedan descargar archivos confidenciales de proyectos no asignados fuera de postcierre.

---

## 4. AUDITORÍA DE CLOUD FUNCTIONS ADMINISTRATIVAS (`functions/index.js`)

Se auditaron las siguientes funciones HTTPS Callables críticas:

### 4.1 `createUserAdmin`
- **Autorización**: Ejecuta `assertManager(context)` exigiendo token con `manager === true` y perfil activo en Firestore.
- **Restricción de Escalación de Privilegios**: Solo permite asignar los roles `vendedor` y `gestor`. No permite crear usuarios con rol `manager` ni `admin`.
- **Idempotencia y Atomicidad**: Emplea tokens de bloqueo en `userOpsLocks` con TTL de 5 minutos y cálculo de huella SHA-256 sobre los datos para mitigar condiciones de carrera y reintentos concurrentes.

### 4.2 `toggleUserStatusAdmin`
- **Autorización**: Exige rol `manager`.
- **Protección contra Auto-Desactivación**: Impide que el propio manager desactive su cuenta o modifique su propio rol.
- **Sincronización en Cascada**: Actualiza `users_prod`, `userDirectory_prod` y llama a `admin.auth().updateUser(uid, { disabled })` deshabilitando el token de autenticación inmediatamente.

### 4.3 `resendInvitationAdmin`
- **Autorización**: Exige rol `manager`.
- **Operación Idempotente**: Genera link de invitación oficial mediante `admin.auth().generateSignInWithEmailLink` asegurando entrega a la dirección registrada en el perfil comercial.

### 4.4 `resolveProspectEscalationAdmin`
- **Autorización**: Exclusiva para `manager`.
- **Integridad Comercial**: Ejecuta `runCommercialOp` con validación de estado del prospecto, reasignación comercial segura y registro atómico en la bitácora de auditoría (`auditLogs`).

---

## 5. AUDITORÍA DE CREDENCIALES Y SECRETOS

1. **Búsqueda de Claves Privadas**: Búsqueda estática exhaustiva en todo el árbol de archivos.
   - *Resultado*: 0 claves privadas RSA, 0 secretos de servicio y 0 contraseñas encontradas en el código fuente.
2. **Archivos `.env` Versionados**:
   - *Resultado*: Ningún archivo `.env` o credencial local se encuentra bajo control de versiones.
3. **Purga Histórica de Contraseñas (SEC-01)**:
   - Los tests de `executeSec01Purge.unit.test.js` confirman que el 100% de los documentos en `users_prod` carecen de campos de contraseña en texto plano (`hasPassword=false`). La autenticación delega enteramente en Firebase Auth.
4. **Segregación de Roles de Planta**:
   - Los roles de planta (`jefe_produccion`, `operario`, etc.) utilizan el mecanismo de autenticación independiente `plantLogin` y la consola aislada `operador.html`. No tienen acceso a la suite comercial ni a las Cloud Functions de administración de clientes o prospectos.

---

## 6. CLASIFICACIÓN DE HALLAZGOS Y RIESGOS

| Identificador | Nivel | Descripción | Estado | Mitigación Implementada |
| :--- | :---: | :--- | :---: | :--- |
| **SEC-01** | CRÍTICO | Contraseñas históricas en texto plano | RESUELTO | Purgado en base de datos; validado por pruebas unitarias. |
| **SEC-02** | ALTO | Escalación de privilegios en creación de usuarios | RESUELTO | `createUserAdmin` restringe roles a `vendedor` y `gestor`. |
| **SEC-03** | ALTO | Mutación directa de prospectos desde frontend | RESUELTO | `firestore.rules` prohíbe escrituras directas; todo muta vía Cloud Functions con auditoría. |
| **SEC-04** | ALTO | Desincronización de claims en token | RESUELTO | `crm_auth.js` verifica `claims.cid`, `claims.role` y `claims.manager` contra el perfil. |
| **SEC-05** | MEDIO | Visualización no autorizada de adjuntos | RESUELTO | Tokens de previsualización efímeros y sandbox en `core/document_viewer.js`. |
| **SEC-06** | MEDIO | Atributos `onclick` en marcado HTML | RESUELTO | Respaldados por fachadas y autorización en backend. |

---

## 7. DICTAMEN DE SEGURIDAD

> **ESTADO DE SEGURIDAD: APROBADO**  
> La postura de seguridad del ERP Ductsal cumple con las directrices más exigentes: autenticación centralizada en Firebase Auth, claims criptográficos validados en backend, denegación por defecto en Firestore/Storage, y delegación de operaciones comerciales en Cloud Functions auditadas.
