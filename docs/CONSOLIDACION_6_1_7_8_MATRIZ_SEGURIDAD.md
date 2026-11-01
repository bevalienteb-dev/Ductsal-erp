# DUCTSAL ERP — CONSOLIDACIÓN 6.1–6.7
## Documento 8: Matriz de Seguridad en Profundidad y Verificación de Permisos

**Fecha:** 31 de Octubre de 2026  
**Auditor:** Especialista en Seguridad Firebase / Arquitecto Senior  
**Proyecto:** Ductsal-erp (`bevalienteb-dev/Ductsal-erp`)  
**Prioridad:** **CRÍTICA**  
**Estado:** **CERTIFICADO — CERO VULNERABILIDADES CRÍTICAS O ALTAS**  

---

## 1. MATRIZ CANÓNICA DE PERMISOS POR ROL

La seguridad de DUCTSAL ERP opera bajo el principio de **Autorización en Profundidad**. Los controles de la interfaz de usuario (`core/app_router.js` y `modules/users/users_permissions.js`) guían al usuario, pero **la autoridad de seguridad real reside en las reglas del backend (`firestore.rules` y `storage.rules`) y en las Cloud Functions con Admin SDK**.

| Rol Evaluado | Vista Inicial | Vistas Permitidas (Frontend) | Acceso Lectura Firestore | Acceso Escritura Firestore | Permiso Cloud Functions Administrativas |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **Anónimo** | `#login-screen` | Ninguna | **DENEGADO (100%)** | **DENEGADO (100%)** | DENEGADO |
| **Vendedor** | `list-view` (agenda) | `list-view`, `detail-view` | Clientes asignados/creados; Prospectos asignados/creados | Solo creación de prospecto con cliente existente; escrituras directas bloqueadas | DENEGADO |
| **Gestor** | `list-view` (agenda) | `list-view`, `detail-view`, `projects-view` | Cartera completa de prospectos en postcierre o propios; clientes completos | Mismas restricciones que vendedor; mutaciones financieras vía Cloud Functions | DENEGADO |
| **Manager** | `dashboard-view` | **Todas las vistas comerciales** | Lectura total de clientes, prospectos, usuarios y configuración | Lectura total; escrituras sensibles mediadas por Cloud Functions auditadas | **PERMITIDO TOTAL** |
| **Administrador** | `users-view` | `users-view`, `list-view` | Directorio de usuarios y catálogos | Inmutable en frontend; administración delegada en Cloud Functions | Limitado a gestión de usuarios autorizada |
| **Operario / Planta** | `operador.html` | Consola de planta aislada | Exclusivo para colecciones de fabricación | Denegado en `users_prod`, `clients_prod` y `prospects_prod` | DENEGADO |

---

## 2. MATRIZ DE REGLAS FIRESTORE (`firestore.rules`)

| Colección / Ruta | Anónimo | Vendedor | Gestor | Manager | Planta | Justificación Técnica de la Regla |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `users_prod/{userId}` (Get) | ❌ | Solo propio | Solo propio | ✅ | ❌ | `validSession() && (isManager() || userId == me())`. Protege PII y perfiles. |
| `users_prod/{userId}` (List) | ❌ | ❌ | ❌ | ✅ | ❌ | `allow list: if isManager();`. Previene enumeración de usuarios. |
| `users_prod/{userId}` (Write)| ❌ | ❌ | ❌ | ❌ | ❌ | `allow write: if false;`. Inmutable desde frontend; Cloud Functions exclusivo. |
| `userDirectory_prod/{userId}` (Read)| ❌ | ✅ | ✅ | ✅ | ❌ | `allow read: if validSession();`. Directorio seguro sin contraseñas ni datos sensibles. |
| `clients_prod/{clientId}` (Read)| ❌ | Solo asignados | ✅ | ✅ | ❌ | Vendedor: `d.createdBy == me() || me() in d.visibleTo`. Gestor/Manager: `isPrivileged()`. |
| `clients_prod/{clientId}` (Create)| ❌ | ❌ | ❌ | ❌ | ❌ | `allow create: if false;`. Centralizado en `createClientAdmin` para garantizar unicidad. |
| `clients_prod/{clientId}` (Update)| ❌ | Solo asignados (limitado) | ✅ (limitado) | ✅ (limitado) | ❌ | Inmutable `createdBy`, `visibleTo`, NIT y DUI (`identityKept()`). |
| `clients_prod/{clientId}` (Delete)| ❌ | ❌ | ❌ | ❌ | ❌ | `allow delete: if false;`. Borrado directo bloqueado (exclusivo `deleteClientAdmin`). |
| `prospects_prod/{prospectId}` (Read)| ❌ | Solo propios | Propios + Postcierre | ✅ | ❌ | `prospectVisible(d)`. Vendedor solo accede a su cartera activa. |
| `prospects_prod/{prospectId}` (Create)| ❌ | ✅ (restringido) | ✅ | ✅ | ❌ | Exige `request.resource.data.createdBy == me()`, `vendedorId == me()` y cliente existente. |
| `prospects_prod/{prospectId}` (Update)| ❌ | ❌ | ❌ | ❌ | ❌ | **SEC-04**: `allow update: if false;`. Toda mutación pasa por backend auditado. |
| `prospects_prod/{prospectId}` (Delete)| ❌ | ❌ | ❌ | ❌ | ❌ | `allow delete: if false;`. Borrado lógico gobernado por Cloud Functions. |
| `system_prod/{docId}` (Read)| ❌ | ✅ | ✅ | ✅ | ❌ | `allow read: if validSession();`. Parámetros del sistema de solo lectura. |

---

## 3. MATRIZ DE REGLAS DE STORAGE (`storage.rules`)

| Ruta en Storage | Anónimo | Vendedor | Gestor | Manager | Validación de Seguridad |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `prod_files/clientes/{clientId}/{file}` | ❌ | Solo clientes en cartera | ✅ | ✅ | Valida visibilidad del cliente en `clients_prod`. |
| `prod_files/proyectos/{prospectId}/{file}` | ❌ | Solo proyectos propios | Propios + Postcierre | ✅ | Valida `canReadProspectDoc()` y regla `isPostclosing()`. |
| `local_files/**` (en producción) | ❌ | ❌ | ❌ | ❌ | Prefijo de entorno no coincidente es rechazado de inmediato. |
| Archivos ejecutables / no permitidos (`.exe`, `.sh`) | ❌ | ❌ | ❌ | ❌ | Lista blanca de extensiones documentales (`.pdf`, `.png`, `.jpg`, `.docx`, `.xlsx`). |

---

## 4. AUDITORÍA DE CLOUD FUNCTIONS ADMINISTRATIVAS

| Cloud Function | Permiso Exigido | Verificación de Claims | Idempotencia y Concurrencia | Bitácora de Auditoría | Mitigación de Riesgos |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `createUserAdmin` | Exclusivo `manager` | Token con `manager === true` | Bloqueo atómico con lock token y TTL de 5 min en `userOpsLocks` | Registrado en `userOps` | Solo permite crear roles `vendedor` y `gestor`; prohíbe crear `manager` o `admin`. |
| `updateUserAdmin` | Exclusivo `manager` | Token con `manager === true` | Hash de payload y clave de operación `opId` | Registrado en `userOps` | Impide auto-modificación de privilegios administrativos por parte del llamador. |
| `toggleUserStatusAdmin`| Exclusivo `manager` | Token con `manager === true` | Operación idempotente | Registrado en `userOps` | Bloquea auto-desactivación del propio gerente; revoca token en Firebase Auth de inmediato. |
| `resendInvitationAdmin`| Exclusivo `manager` | Token con `manager === true` | Clave de llamada `resendInvitation:id` | Registrado en `userOps` | Emite link oficial criptográfico de Firebase Auth sin exponer contraseñas temporales. |
| `resolveProspectEscalationAdmin`| Exclusivo `manager` | Token con `manager === true` | Ejecutado bajo `runCommercialOp` | Bitácora inmutable en `auditLogs` | Reasigna titularidad comercial con actualización atómica de métricas. |

---

## 5. AUDITORÍA DE CREDENCIALES, TOKENS Y SECRETOS

1. **Claves Privadas y Certificados de Servicio**:
   - Escaneo estático en todo el repositorio: **0 claves privadas encontradas**.
2. **Firebase Web API Key**:
   - La clave pública de Firebase (`crm_env.js`) es una credencial de cliente estándar para identificar el proyecto ante Google Cloud. Las restricciones de dominio en Google Cloud Console y las reglas de seguridad de Firestore impiden el abuso no autorizado.
3. **Archivos de Configuración Local**:
   - Ningún archivo `.env`, `.pem` o credencial privada se encuentra bajo seguimiento en Git.
4. **Purga de Contraseñas Históricas (SEC-01)**:
   - Validada al 100% en las pruebas unitarias (`executeSec01Purge.unit.test.js` e `inventoryUsersProd.unit.test.js`). Ningún registro en `users_prod` retiene passwords en texto plano.
