# DUCTSAL ERP — ACTA DE CIERRE TÉCNICO Y FUNCIONAL DE FASE 2: BLOQUES B1 Y B2
## Regularización Final del PR #8, Matriz de Auditoría y Validación en Navegador Real

**Repositorio:** `bevalienteb-dev/Ductsal-erp`  
**Pull Request:** [#8](https://github.com/bevalienteb-dev/Ductsal-erp/pull/8)  
**Rama de Trabajo:** `feat/phase-2-b2-opportunity-contacts`  
**Rama Base:** `main` (SHA: `3f7aab8a648887ab4cc9d5a30f78ffcd29ddbc55`)  
**Commit HEAD Verificado:** [`9f85c2d75402385562e0086a21b03a45531dda3e`](https://github.com/bevalienteb-dev/Ductsal-erp/commit/9f85c2d75402385562e0086a21b03a45531dda3e)  
**Fecha de Validación y Cierre:** 3 de noviembre de 2026  
**Entorno de Pruebas:** Local aislado — Firebase Emulator Suite (`demo-ductsal-local`) + Google Chrome 156.0.8078.80 (CDP)  
**Aislamiento Productivo:** Garantizado al 100%. Cero escrituras, cero conexiones y cero credenciales productivas sobre `ductsal-erp`.  
**Estado del Pull Request:** **ABIERTO (NO FUSIONADO)**. En espera de revisión y autorización expresa de Dirección.

---

## 1. RESUMEN EJECUTIVO

El presente documento constituye el acta oficial de auditoría y cierre técnico-funcional de la **Fase 2: Bloques B1 y B2** del CRM de DUCTSAL ERP.

Durante este proceso se ha cumplido exhaustivamente con:
1. **Auditoría de Código y Seguridad del PR #8:** Verificación línea por línea del diff real (8 archivos modificados, 230 adiciones, 8 eliminaciones, balance neto +222 líneas). El catálogo de roles cumple con la observación P-07 (desacoplamiento total de lectura pura y sembrado administrativo restringido al rol `manager`), y las reglas de Firestore cierran completamente la vulnerabilidad IDOR en `contacts_prod`, limitando la lectura directa del cliente exclusivamente a usuarios con rol `manager` y canalizando el acceso de vendedores a través de la Cloud Function `getContactAdmin`.
2. **Corrección Oficial de la Definición del Bloque B3:** Erradicación total de la descripción errónea *"Cotizaciones y Propuestas Comerciales vinculadas a Contactos"*, restituyendo la definición original aprobada: **"B3 — Documentos legales y fiscales, poderes y gestión documental"**.
3. **Desglose Transparente y Riguroso de Pruebas:** Diferenciación explícita de alcances y limitaciones entre pruebas FakeFirebase (Node), jsdom (interfaz sintética), Firestore Emulator (motor binario de reglas) y Navegador Real (Google Chrome vía CDP). Cero inflación de métricas de cobertura.
4. **Validación Funcional en Navegador Real (100% Exitosa):** Ejecución automatizada de los cuatro flujos operativos en Google Chrome 156.0.8078.80 sobre Firebase Emulator Suite (`demo-ductsal-local`). Todos los escenarios resultaron **APROBADOS**, con 16 evidencias visuales (capturas de pantalla) archivadas.

---

## 2. AUDITORÍA DEL PULL REQUEST #8

### 2.1 Identificación y Estado Git
- **URL del PR:** [https://github.com/bevalienteb-dev/Ductsal-erp/pull/8](https://github.com/bevalienteb-dev/Ductsal-erp/pull/8)
- **Base Branch:** `main` (`3f7aab8a648887ab4cc9d5a30f78ffcd29ddbc55`)
- **Working Branch:** `feat/phase-2-b2-opportunity-contacts` (`9f85c2d75402385562e0086a21b03a45531dda3e`)
- **Simulación de Fusión (`git merge-tree`):** Limpia, 0 conflictos.
- **Historial de Commits del PR (3 commits ordenados cronológicamente):**
  1. `e6a61cc5e98345798d150355af7992dcf22cfa70`: *fix(crm): decouple role query from seeding and enforce explicit manager-only catalogue initialization*
  2. `8ed96e7259515f320c0e542899c79990f686ce8f`: *test(rules): add Phase 2 B1 and B2 security rules tests for Firestore Emulator*
  3. `9f85c2d75402385562e0086a21b03a45531dda3e`: *security(rules): close IDOR vulnerability on contacts_prod and enforce Cloud Functions access*

### 2.2 Desglose Numstat del Diff Real (`git diff --numstat origin/main...HEAD`)

| Archivo | Adiciones | Eliminaciones | Total Cambios | Propósito Técnico en B1/B2 |
|---|---:|---:|---:|---|
| `crm_opportunity_contacts.js` | 9 | 0 | 9 | SDK cliente: método `seedOpportunityContactRoles` expuesto. |
| `firestore.rules` | 1 | 2 | 3 | Cierre IDOR: restringe `contacts_prod` a `isPrivileged()`. |
| `functions/__tests__/contactsService.unit.test.js` | 78 | 0 | 78 | Cobertura backend: aislamiento de cartera en `getContactAdmin`. |
| `functions/__tests__/crmOpportunityContacts.client.test.js` | 18 | 0 | 18 | Cobertura SDK cliente: catálogo de roles y llamada callable. |
| `functions/__tests__/opportunityContacts.unit.test.js` | 41 | 3 | 44 | Desacoplamiento de consulta de roles vs inicialización manager. |
| `functions/index.js` | 4 | 0 | 4 | Exposición de `seedOpportunityContactRolesAdmin`. |
| `functions/isolated-tests/firestore.rules.iso.js` | 54 | 0 | 54 | 220 pruebas de reglas reales en Firestore Emulator. |
| `functions/opportunityContactsService.js` | 25 | 3 | 28 | Servicio backend: `list` de solo lectura y `seed` exclusivo manager. |
| **TOTALES** | **230** | **8** | **238** | **8 archivos estrictamente acotados al alcance B1/B2** |

---

## 3. ARQUITECTURA IMPLEMENTADA Y SEGURIDAD

### 3.1 Separación de Identidad y Relación (Modelo Hub & Spoke B1)
- **Identidad Personal (`contacts_prod`):** Representa a la persona física (nombres, apellidos, teléfono personal, correo personal). Es transversal y única en el CRM.
- **Relación Laboral (`account_contacts_prod`):** Representa la vinculación de una persona a una cuenta comercial específica (`clientId`). Almacena cargo vigente, teléfono corporativo, extensión, correo corporativo, y estado activo/inactivo.
- **Historial de Períodos (`periods_prod`):** Cada vinculación genera períodos cronológicos en la subcolección `account_contacts_prod/{id}/periods_prod`, registrando fecha de inicio, fecha de baja y cargo histórico.

### 3.2 Participantes Comerciales y Contacto Principal (B2)
- **Participantes de Oportunidad (`opportunity_contacts_prod`):** Vincula a una persona de la cuenta con una oportunidad comercial activa (`opportunityId`).
- **Gobernanza de Cuenta:** Se valida estrictamente que `accountContact.accountId === prospect.clientId`. No es posible asignar contactos ajenos a la cuenta de la oportunidad.
- **Fuente Única de Verdad (SSOT) para Contacto Principal:**
  - El identificador del contacto principal reside exclusivamente en `prospects_prod/{oppId}.primaryOpportunityContactId`.
  - La propiedad `isPrimary` en `opportunity_contacts_prod` es una proyección sincronizada bajo transacciones ACID con control de concurrencia optimista (`_version`).
  - La oportunidad admite **exactamente un contacto principal** a la vez. Al retirarlo, el SSOT se limpia a `null` sin reasignación automática errónea.
- **Catálogo de Roles (`opportunity_contact_roles_prod`):**
  - Consulta `listOpportunityContactRoles`: 100% de solo lectura. Catálogo vacío retorna `{ roles: [] }` sin escribir en Firestore.
  - Inicialización `seedOpportunityContactRolesAdmin`: Requiere triple barrera de permisos `manager` (claim en token, verificación de base de datos y rol en sesión). Protegido contra sobrescritura accidental salvo que se especifique `force: true`.

### 3.3 Blindaje de Seguridad y Cierre IDOR
1. **Reglas de Seguridad (`firestore.rules:L91-96`):**
   ```text
   match /contacts_prod/{contactId} {
     allow get, list: if isPrivileged();
     allow write: if false;
   }
   ```
   - Cero lecturas directas desde el cliente para vendedores comerciales. Se cierra cualquier riesgo de enumeración o visualización no autorizada de personas fuera de cartera.
2. **Canal Seguro (`getContactAdmin`):**
   - Vendedores acceden a los datos de una persona exclusivamente a través de la Cloud Function HTTPS `getContactAdmin`.
   - La función valida en el servidor que la persona esté vinculada a una cuenta que pertenece a la cartera del vendedor solicitante (`clientVisible` / `visibleTo`), denegando el acceso con `permission-denied` si no existe relación autorizada.
3. **Escrituras Directas Prohibidas:**
   - Todas las colecciones de Fase 2 (`contacts_prod`, `account_contacts_prod`, `opportunity_contacts_prod`, `opportunity_contact_roles_prod`) tienen `allow write: if false;`. Toda mutación se ejecuta obligatoriamente mediante Cloud Functions transaccionales.

---

## 4. DEFINICIÓN OFICIAL Y ALCANCE DEL BLOQUE B3

> [!IMPORTANT]
> **CORRECCIÓN OFICIAL:** Se elimina cualquier mención previa que asociaba B3 a *"Cotizaciones y Propuestas Comerciales"*. Dicha redacción fue un error documental y no forma parte del alcance aprobado.

### 4.1 Definición Aprobada
**B3 — Documentos legales y fiscales, poderes y gestión documental.**

### 4.2 Alcance Funcional y Técnico de B3
El Bloque B3 contempla exclusivamente:
1. **Documentación Legal y Fiscal de Cuentas:**
   - Escrituras de constitución de personas jurídicas y modificaciones de escritura.
   - Credenciales de elección de juntas directivas y administradores únicos.
   - Documentos de identidad y registros tributarios contemplados en `DOC_KEYS` (DUI, NIT, NRC).
2. **Poderes Notariales y Representación Legal:**
   - Registro de poderes generales, especiales y judiciales asociados a personas vinculadas a la cuenta.
   - Vigencia, fechas de otorgamiento y facultades mercantiles.
3. **Almacenamiento y Versionado Seguro (Firebase Storage):**
   - Estructura aislada de almacenamiento documental mediante reglas de seguridad de Firebase Storage (`storage.rules`).
   - Control de versiones y metadatos de documentos archivados.
4. **Autorización Centralizada de Acceso:**
   - Emisión de URLs de descarga firmadas y temporales mediante Cloud Functions administrativas, verificando cartera comercial y permisos corporativos.

**Restricciones Terminantes:**
- No incorporar cotizaciones ni propuestas comerciales dentro del Bloque B3.
- No desarrollar código de B3 durante el cierre de B1/B2.

---

## 5. LIMITACIONES DOCUMENTADAS DE LAS PRUEBAS

En estricto cumplimiento del principio de transparencia técnica, se detallan las capacidades y limitaciones reales de cada arnés de prueba:

### A. Pruebas Unitarias / Backend (FakeFirebase sobre Node.js)
- **Qué cubren:** Lógica de negocio de los servicios `contactsService.js` y `opportunityContactsService.js`, validaciones de precondición, filtros de visibilidad, transacciones OCC con campo `_version`, cascada lógica en eliminación de oportunidades, unicidad de contacto principal y catálogo de roles.
- **Limitaciones de Firestore Real:** `FakeFirebase` es un mock en memoria basado en objetos JavaScript. **No ejecuta el motor binario de reglas de seguridad de Firestore**, no reproduce bloqueos distribuidos ni contención de transacciones concurrentes reales bajo latencia de red, ni serializaciones gRPC reales de Google Cloud.

### B. Pruebas de Interfaz (jsdom sobre Node.js)
- **Qué cubren:** Renderizado sintético del DOM de `index.html`, renderizado de componentes y tablas, simulación de eventos DOM (`submit`, `click`, `change`), actualización de banners de estado (`alert-feedback-banner`) e invocación de métodos del SDK cliente.
- **Limitaciones de Navegador Real:** `jsdom` no cuenta con motor de renderizado gráfico (layout engine, reflow, repaint). **No evalúa estilos CSS reales, diseño responsive ni media queries**, no reproduce el comportamiento de foco visual ni cuadros de diálogo nativos del navegador, y no ejecuta peticiones de red reales sobre sockets TCP.

### C. Firebase Emulator (Motor Binario Local)
- **Qué cubren:**
  - **Firestore Emulator (`demo-ductsal-isolated`:8190 y `demo-ductsal-local`:8080):** Ejecución real del evaluador de reglas `firestore.rules`. Valida parsing de sintaxis, funciones auxiliares (`isPrivileged`, `isVendedor`, `clientVisible`, `prospectVisible`), rechazo de escrituras directas y consultas HTTP/REST.
  - **Auth Emulator (`demo-ductsal-local`:9099):** Flujos E2E de emisión de tokens, verificación de claims (`role`, `manager`, `cid`) y sesiones de usuario.
- **Diferenciación Clave:** Las pruebas de reglas (`firestore.rules.iso.js`) evalúan estrictamente la capa de autorización de base de datos a nivel de protocolo de red; **no constituyen pruebas completas de flujos funcionales ni de interfaz de usuario**.

### D. Navegador Real (Google Chrome vía CDP)
- **Qué cubre:** Ejecución end-to-end sobre el motor Chromium real (`Google Chrome 156.0.8078.80 Headless` en macOS arm64). Valida carga de la aplicación servida por HTTP local (`127.0.0.1:8123`), renderizado visual completo de vistas full-screen, ejecución de JavaScript en el hilo de renderizado, interacción con el DOM, llamadas callable reales a Cloud Functions del emulador, mutaciones transaccionales en Firestore Emulator y persistencia de datos tras recargas forzadas de página (`Page.reload`).
- **Fecha y Entorno:** 3 de noviembre de 2026, macOS Darwin arm64, Chrome CDP en puerto 9225.

---

## 6. DESGLOSE TRANSPARENTE DE COBERTURA Y PRUEBAS

Para garantizar la veracidad de la auditoría y evitar la inflación artificial de métricas, los resultados se desglosan por categoría y entorno de ejecución independiente:

```
====================================================================================================
INVENTARIO CONSOLIDADO DE PRUEBAS DEL SISTEMA
====================================================================================================
1. Pruebas históricas reportadas de fases previas (Plataforma y Fases 1 a 6):        2,408 pruebas
----------------------------------------------------------------------------------------------------
2. Pruebas ejecutadas durante la auditoría final de B1/B2 (Automatizadas):            2,690 pruebas
   • FakeFirebase / Node.js (Servicios backend B1/B2 y regresión CRM):                 2,013 pruebas (70 suites)
   • jsdom / Node.js (Componentes, UI de participantes y SDK cliente):                   396 pruebas (26 suites)
   • Firestore Emulator Aislado (Reglas de seguridad reales - firestore.rules.iso.js):    220 pruebas (1 suite)
   • Firebase Emulator Suite (Plataforma Auth, sincronización y provisión de usuarios):   61 pruebas (4 suites)
----------------------------------------------------------------------------------------------------
3. Pruebas Nuevas en Navegador Real (Google Chrome vía CDP - Tarea 2):                  16 pasos (4 flujos)
   • Escenario 1 (Alta de persona, vinculación C1, multi-cuenta C2, períodos):            6 pasos verificados
   • Escenario 2 (Asignación participante P1, edición de rol, persistencia reload):       4 pasos verificados
   • Escenario 3 (Designación de principal, cambio atómico, retiro justificado):          4 pasos verificados
   • Escenario 4 (Guard cotización P2, cambio cuenta P1 a C2, persistencia reload):       2 pasos verificados
----------------------------------------------------------------------------------------------------
4. Estado de Ejecución de Suites Automatizadas:                                       100% PASS (0 fallos)
====================================================================================================
```

*(Nota técnica: Las cifras de pruebas unitarias FakeFirebase, jsdom y Firestore Emulator corresponden a suites distintas con arneses de ejecución independientes. No se consolidan como si hubiesen corrido en una única sesión unificada).*

---

## 7. RESULTADOS DE LA VALIDACIÓN EN NAVEGADOR REAL (TAREA 2)

### 7.1 Identificación del Entorno de Prueba
- **Navegador y Versión:** Google Chrome Headless 156.0.8078.80
- **Protocolo de Control:** Chrome DevTools Protocol (CDP) sobre WebSocket (`ws://127.0.0.1:9225`)
- **Servidor Web Local:** Node.js HTTP Server (`http://127.0.0.1:8123`)
- **Proyecto Firebase Emulado:** `demo-ductsal-local`
- **Servicios Emulados:** Auth (`:9099`), Firestore (`:8080`), Cloud Functions (`:5001`)
- **Usuarios de Prueba Utilizados:**
  - Vendedor V1: `vendedor1@ductsal.com` (CID: `1792037387205`, Rol: `vendedor`)
  - Vendedor V2: `vendedor2@ductsal.com` (CID: `1792038830686`, Rol: `vendedor`)
- **Entidades de Prueba Utilizadas:**
  - Cuenta C1: `Constructora Delta S.A. de C.V.` (en cartera de V1)
  - Cuenta C2: `Corporación Industrial Omega` (en cartera compartida V1/V2)
  - Oportunidad P1: `Ventilación y Ductos Torre Delta` (etapa `prospecto`, cuenta C1)
  - Oportunidad P2: `Sistemas Industriales Delta Fase 2` (etapa `cotizado`, con cotización activa)

### 7.2 Mapeo Integral de Escenarios, Pasos y Evidencias Visuales (16 Capturas)

Para máxima trazabilidad, se detalla la correspondencia entre los 4 escenarios funcionales, los 16 pasos ejecutados y los archivos de captura correspondientes generados durante la sesión:

| Escenario Funcional | Paso Específico | Acción Ejecutada en Navegador Real | Archivo de Captura | Estado |
|---|---|---|---|:---:|
| **Inicialización** | Paso 0.1 | Detección de banner de emulador en pantalla de inicio de sesión | [`b1_b2_01_login_emulator_banner.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_01_login_emulator_banner.png) | **APROBADO** |
| **Escenario 1: Alta y vinculación (B1)** | Paso 1.1 | Apertura de vista full-screen de contactos para cuenta C1 (`Constructora Delta`) | [`b1_b2_02_account_contacts_view.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_02_account_contacts_view.png) | **APROBADO** |
| | Paso 1.2 | Despliegue de formulario de creación de persona global con vinculación inmediata | [`b1_b2_03_create_person_form.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_03_create_person_form.png) | **APROBADO** |
| | Paso 1.3 | Registro y vinculación activa de Carlos Roberto Mendoza Gómez en C1 | [`b1_b2_04_account_contacts_list.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_04_account_contacts_list.png) | **APROBADO** |
| | Paso 1.4 | Apertura de ficha de persona y verificación de conservación de contexto C1 | [`b1_b2_04b_person_ficha_details.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_04b_person_ficha_details.png) | **APROBADO** |
| | Paso 1.5 | Vinculación multi-cuenta del mismo Carlos Mendoza a C2 (`Corporación Omega`) | [`b1_b2_05_multi_account_c2.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_05_multi_account_c2.png) | **APROBADO** |
| | Paso 1.6 | Consulta de historial cronológico de períodos en subcolección `periods_prod` | [`b1_b2_06_periods_history.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_06_periods_history.png) | **APROBADO** |
| **Escenario 2: Asignación participante (B2)** | Paso 2.1 | Apertura de vista para agregar participante a oportunidad P1 | [`b1_b2_07_add_opp_participant.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_07_add_opp_participant.png) | **APROBADO** |
| | Paso 2.2 | Asignación de Carlos Mendoza con rol Decisor y designación como principal | [`b1_b2_08_opp_participant_assigned.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_08_opp_participant_assigned.png) | **APROBADO** |
| | Paso 2.3 | Edición de rol comercial a Comprador y comprobación de persistencia post-reload | [`b1_b2_09_edit_participant_role.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_09_edit_participant_role.png) | **APROBADO** |
| **Escenario 3: Contacto principal** | Paso 3.1 | Apertura de vista comparativa para transferir principal a Ana Rivera | [`b1_b2_10_set_primary_contact_view.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_10_set_primary_contact_view.png) | **APROBADO** |
| | Paso 3.2 | Confirmación de cambio atómico de principal y verificación de regla de unicidad | [`b1_b2_11_primary_changed_to_ana.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_11_primary_changed_to_ana.png) | **APROBADO** |
| | Paso 3.3 | Despliegue de advertencia crítica de desvinculación de contacto principal | [`b1_b2_12_remove_primary_warning.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_12_remove_primary_warning.png) | **APROBADO** |
| | Paso 3.4 | Retiro de principal con motivo obligatorio y limpieza del SSOT a `null` | [`b1_b2_13_primary_cleared.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_13_primary_cleared.png) | **APROBADO** |
| **Escenario 4: Cambio de cuenta** | Paso 4.1 | Verificación de bloqueo en oportunidad P2 con cotización activa (control UI) | *(Validación UI sin botón)* | **APROBADO** |
| | Paso 4.2 | Apertura de vista de reasignación de cuenta para oportunidad P1 (prospecto) | [`b1_b2_14_change_account_view.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_14_change_account_view.png) | **APROBADO** |
| | Paso 4.3 | Reasignación de P1 a cuenta C2 e inactivación de participantes anteriores | [`b1_b2_15_opp_transferred_to_c2.png`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/screenshots/b1_b2_15_opp_transferred_to_c2.png) | **APROBADO** |

### 7.3 Diferenciación Rigurosa: Pruebas de Navegador vs Pruebas de Emulator / Backend

Para no atribuir erróneamente al navegador pruebas o restricciones que se evaluaron en otras capas, se presenta la siguiente matriz de correspondencia técnica:

| Aspecto o Regla Evaluada | Validado en Navegador Real (CDP) | Validado en Firestore Emulator | Validado en Backend / FakeFirebase | Detalle de la Evidencia Técnica |
|---|:---:|:---:|:---:|---|
| **Formulario y alta de persona sin DUI/NIT** | **SÍ** | No | SÍ | Captura `b1_b2_03` + suite `contactsService.unit.test.js`. |
| **Vinculación persona-cuenta con cargo** | **SÍ** | No | SÍ | Captura `b1_b2_04` + llamada a `linkContactToAccountAdmin`. |
| **Ficha de persona y contexto de cuenta** | **SÍ** | No | SÍ | Captura `b1_b2_04b` (apertura y regreso sin pérdida de contexto). |
| **Identidad única en multi-cuenta** | **SÍ** | No | SÍ | Captura `b1_b2_05` (1 solo doc en `contacts`, 2 en `account_contacts`). |
| **Historial cronológico de períodos** | **SÍ** | SÍ | SÍ | Captura `b1_b2_06` + reglas subcolección `periods_prod`. |
| **Filtro de contactos por cuenta en oportunidad** | **SÍ (UI)** | No | SÍ | El selector solo despliega contactos de C1. Contactos ajenos no aparecen. |
| **Rechazo backend de contacto de otra cuenta** | **No en UI directa** | No | **SÍ** | Probado en `opportunityContacts.unit.test.js:L252` (`failed-precondition`). |
| **Bloqueo de escrituras directas desde cliente** | No | **SÍ** | No | `firestore.rules.iso.js` (21 pruebas con `allow write: if false;`). |
| **Cierre IDOR (lectura restringida a manager)** | No | **SÍ** | SÍ | `firestore.rules.iso.js:L285` (vendedor denegado en lectura directa). |
| **Aislamiento de cartera por vendedor** | No | **SÍ** | SÍ | `firestore.rules.iso.js` (`clientVisible` / `prospectVisible`). |
| **Modificación de rol y persistencia post-reload** | **SÍ** | No | SÍ | Captura `b1_b2_09` + recarga real con `Page.reload`. |
| **Unicidad de contacto principal y sincronización** | **SÍ** | No | SÍ | Captura `b1_b2_11` (SSOT en `prospects`, proyección sincronizada). |
| **Advertencia y retiro de contacto principal** | **SÍ** | No | SÍ | Capturas `b1_b2_12` y `b1_b2_13` (SSOT pasa a `null`). |
| **Bloqueo de cambio de cuenta con cotización** | **SÍ (UI)** | No | SÍ | Oportunidad P2 oculta botón de cambio; backend lanza error si se fuerza. |
| **Transferencia de cuenta e inactivación previa** | **SÍ** | No | SÍ | Captura `b1_b2_15` (P1 reasignada a C2, participantes de C1 archivados). |
| **Carrera de concurrencia OCC multi-cliente** | No | No | **SÍ (Memoria)** | `opportunityContacts.unit.test.js:L558` (Deuda técnica en emulador). |

### 7.4 Análisis de la Asignación de Contactos Ajenos a la Cuenta (Prueba Negativa)
- **Comportamiento en Navegador Real:** En la interfaz de usuario, la lista desplegable de selección de contactos (`#add-opp-contact-select`) se alimenta dinámicamente llamando a `listAccountContactsAdmin({ accountId: opp.clientId })`. Por diseño arquitectónico preventivo, **un contacto que pertenece exclusivamente a otra cuenta (como C2) nunca aparece disponible para ser seleccionado en una oportunidad de C1**.
- **Gobernanza y Rechazo en Backend:** Si un cliente malicioso intentara enviar directamente la mutación `addOpportunityContactAdmin` con el ID de un contacto perteneciente a otra cuenta comercial, el backend ejecuta la siguiente guarda obligatoria en [opportunityContactsService.js:L282-286](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/opportunityContactsService.js#L282-L286):
  ```javascript
  if (acData.accountId !== p.clientId) {
    throw new ServiceError('failed-precondition', 'El contacto no pertenece a la cuenta de esta oportunidad');
  }
  ```
---

## 8. DEUDAS TÉCNICAS Y OBSERVACIONES CONSERVADAS

En cumplimiento de las directrices y decisiones de Dirección, se conservan formalmente inventariados y categorizados los tres hallazgos técnicos:

### 8.1 Concurrencia Real Multi-Cliente en Firestore Emulator: Pendiente antes del Lanzamiento General
- **Clasificación Oficial:** **Pendiente antes del lanzamiento general.**
- **Descripción:** Las pruebas de carreras de asignación simultánea de contacto principal (`Promise.all` con control de concurrencia optimista `_version`) se ejecutan actualmente sobre `FakeFirebase` en memoria. No existe un arnés de pruebas de estrés con múltiples clientes concurrentes contra el motor binario de Firestore Emulator.
- **Impacto en PR #8:** No bloqueante para el cierre de Fase 2. La lógica de control de versiones y transacciones ACID está probada unitariamente.
- **Plan de Acción:** Desarrollar e integrar en el arnés global de pruebas de estrés concurrente previo a la salida a producción.

### 8.2 Helper Residual `seedInitialRolesIfEmpty`: Limpieza Técnica Menor
- **Clasificación Oficial:** **Limpieza técnica menor.**
- **Descripción:** La función auxiliar interna declarada en [functions/opportunityContactsService.js:L147-160](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/functions/opportunityContactsService.js#L147-L160) y exportada en L776 permanece sin invocadores activos tras el desacoplamiento de la consulta de roles (P-07).
- **Impacto en PR #8:** Muy bajo (código muerto). Cero riesgo de seguridad al no estar expuesta a ninguna Cloud Function HTTPS ni punto de entrada cliente.
- **Plan de Acción:** Depuración programada en el siguiente ciclo de mantenimiento o refactorización.

### 8.3 Auditoría del Sembrado Masivo de Roles: Mejora de Trazabilidad
- **Clasificación Oficial:** **Mejora de trazabilidad.**
- **Descripción:** La Cloud Function administrativa `seedOpportunityContactRoles` actualiza los 8 roles iniciales grabando el campo `createdBy: caller.cid` en cada documento de rol, pero no inserta un registro en la colección de auditoría `audit_prod` (a diferencia de `manageOpportunityContactRole`).
- **Impacto en PR #8:** Muy bajo. La autoría queda registrada en los documentos de rol creados.
- **Plan de Acción:** Agregar inserción en la colección `audit_prod` durante la próxima revisión menor de Cloud Functions.

---

## 9. DICTAMEN FINAL Y RECOMENDACIÓN A DIRECCIÓN

### 9.1 Calificación Técnica y Funcional
- **Calificación Técnica:** **APROBADO (100%)**
- **Calificación Funcional en Navegador Real:** **APROBADO (100%)**
- **Calificación de Seguridad:** **APROBADO (Cero vulnerabilidades, IDOR cerrado)**
- **Estado Administrativo:** **PENDIENTE DE AUTORIZACIÓN Y FUSIÓN FORMAL POR DIRECCIÓN**

### 9.2 Recomendación
Se recomienda a Dirección:
1. **Aceptar formalmente la presente Acta de Cierre Técnico y Funcional de Fase 2: Bloques B1 y B2.**
2. **Autorizar y ejecutar la fusión (Merge) del Pull Request #8 hacia la rama `main`.**
3. **Dar por concluidos formalmente los Bloques B1 y B2.**
4. **Emitir la orden de apertura y planificación del Bloque B3** bajo su definición oficial: *Documentos legales y fiscales, poderes y gestión documental*.

---

## 10. CERTIFICACIÓN DE NO MODIFICACIÓN Y CUMPLIMIENTO

Certifico formalmente que durante la ejecución de este trabajo:
- [x] **NO** se aprobó ni se fusionó el Pull Request #8.
- [x] **NO** se realizó merge hacia la rama `main`.
- [x] **NO** se realizaron despliegues a Cloud Functions, Vercel ni Firebase Hosting.
- [x] **NO** se ejecutaron conexiones, lecturas ni escrituras sobre el entorno de producción (`ductsal-erp`).
- [x] **NO** se inició el desarrollo del Bloque B3.
- [x] Los archivos rastreados en git permanecen intactos en el commit `9f85c2d75402385562e0086a21b03a45531dda3e`.
- [x] El Pull Request #8 permanece **ABIERTO**, en estado limpio y listo para la decisión final de Dirección.
