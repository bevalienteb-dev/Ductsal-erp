# Validación conjunta CRM + fabricación (entorno aislado) — 2026-10-16

> **Conclusión corta: CRM y fabricación NO son compatibles con las reglas candidatas (`firestore.rules`, `storage.rules`) tal como están hoy.**
> Lo que sí se probó y funciona: el flujo comercial del CRM por Cloud Functions (clientes, oportunidades, roles, venta sin contrato,
> facturas, abonos, eliminación lógica, códigos concurrentes). Lo que se probó y **se rompería**: las subidas a Storage de ambos módulos,
> los listeners sin filtro del CRM y de fabricación, y todas las operaciones de las tabletas de operarios (no tienen sesión de Firebase).
> No se endureció ninguna regla, no se desplegó, no se tocó producción.

Reglas y archivos compartidos **sin cambios**: `firestore.rules` y `storage.rules` conservan su fecha de modificación (15 oct 10:05 / 10:13).
El repositorio `fabricacion-dev` se leyó solo en modo lectura; sus cambios locales preexistentes siguen intactos.

---

## 1. Inventario inspeccionado

### 1.1 Repositorios y configuración

| Tema | CRM (`sales-reporting-system`) | Fabricación (`fabricacion-dev`) |
|---|---|---|
| Cambios locales | `M` app.js, app_core.js, index.html; muchos archivos nuevos sin seguimiento (`crm_*.js`, `firestore.rules`, `storage.rules`, `functions/`, configs de emulador) | `M` app.js, index.html, js/clientes.js, js/oportunidades.js, js/proyectos.js, js/ui.js; archivos sin seguimiento (pdf/xlsx/assets). Ninguno modificado por esta fase |
| Config Firebase de despliegue | No hay `firebase.json` ni `.firebaserc` de despliegue; solo `firebase.emulator.json` y `firebase.isolated-emulator.json` | No hay ningún archivo de configuración Firebase |
| Proyecto | `ductsal-erp` (hardcodeado en el navegador; bucket `ductsal-erp.firebasestorage.app`, también prueba `.appspot.com`) | El mismo `ductsal-erp` y el mismo bucket |
| SDK en el navegador | App + Firestore + Auth + Functions + Storage | `index.html`: App + Firestore + Storage (**sin Auth ni Functions**). `operador.html`: App + Firestore (**sin Auth, Storage ni Functions**) |
| Sufijo de entorno | `DB_SUFFIX` (`_prod` / `_local`) | `DB_SUFFIX` (`_prod` / `_local`) |

### 1.2 Colecciones compartidas (verificado por análisis estático, `jointInventory.unit.test.js`)

* **Con sufijo de entorno** (`*_prod` / `*_local`): `users`, `clients`, `prospects`, `system`, `audit_logs`, `fabricacion`, `fabricacion_tasks`, `proyectos_fabricacion`, `bobinas_soldadura`.
* **Sin sufijo — mismo documento para navegadores locales y de producción**: `config`, `alertas_maquinas`.
* Solo CRM: `prospectCounters_*`, `clientIdentifiers_*`, `userOpsLocks*` (escritas solo por Cloud Functions). Las reglas candidatas declaran además `userDirectory_*` (lista de usuarios sin contraseñas) pero **ninguna función la mantiene todavía**.
* Solo fabricación: `fabricacion`, `fabricacion_tasks`, `proyectos_fabricacion`, `bobinas_soldadura`, `config`, `alertas_maquinas`.
* Comparten lectura **y escritura**: `clients`, `prospects`, `users`, `system/settings`, `audit_logs`.

### 1.3 Supuesto sobre las reglas actuales

Las reglas de producción **no se leyeron** (restricción). Como línea base se usó `isolated-tests/rules/legacy-open.firestore.rules`
(`allow read, write: if true`, solo en el emulador aislado). Es un **supuesto** sobre cómo funcionan hoy las apps: ambas escriben y leen
directo desde el navegador sin sesión de servidor, lo que solo es posible con reglas abiertas o muy permisivas.

---

## 2. Qué se ejecutó y qué no

| Capa | Qué | Resultado | Archivo |
|---|---|---|---|
| **Unitaria** (sin emuladores) | CRM: lógica de servicios, simulaciones de Firestore/DOM | **26 suites / 933 pruebas, 0 fallos** | `functions/__tests__/*` |
| Unitaria (inspección estática) | Deriva de inventario: colecciones, escritores directos, rutas de Storage, SDK cargados, ausencia de `runTransaction`, código de fabricación leído **sin ejecutarse** (14 pruebas) | Pasan (parte de las 933) | `functions/__tests__/jointInventory.unit.test.js` |
| **Emulador** (Auth + Firestore + Storage + Functions, proyecto `demo-ductsal-isolated`) | Las 9 suites anteriores + la nueva suite conjunta (100 pruebas) | **10 suites / 567 pruebas, 0 fallos** | `functions/isolated-tests/*.iso.js` |
| Emulador — conjunta | A reproducción con reglas abiertas · B matriz de permisos con reglas candidatas (44 operaciones × 10 sesiones = 440 mediciones) · C Storage · D escenario integrado con cuentas Auth reales + callables por HTTP · E códigos y concurrencia · F aislamiento tabletas/CRM | Pasan; los "KNOWN GAP" son pruebas de **caracterización** que afirman el comportamiento defectuoso real | `functions/isolated-tests/jointValidation.iso.js` |
| **No ejecutable / no ejecutado** | Navegador real (no se abrió ni el CRM ni fabricación; el JavaScript de fabricación solo se **reproduce** como llamadas equivalentes a Firestore/Storage, y `generateProspectCode` se extrajo y ejecutó con `vm`) · tabletas físicas · login de operarios real (PIN / contraseña numérica) contra Auth, porque hoy no usa Auth · reglas reales de producción (no leídas) · comportamiento de Storage con reglas abiertas (el emulador de Storage aislado usa `storage.rules` candidatas) · descargas por URL con token · carga con muchos usuarios reales · Cloud Functions desplegadas |

Notas de honestidad:
* Las sesiones de la matriz (sección B) son tokens sin firmar del emulador con claims `{role, cid}` y perfil en `users_prod`. La sección D usa cuentas
  Auth reales del emulador + Functions. **Ninguna** representa a una tableta de operario actual, que no tiene sesión: esa columna es `Tablet sin sesión`.
* Dos fallos aparecieron durante la fase y se corrigieron **en las pruebas, no en las reglas ni en el código**: una expectativa mía mal derivada
  (una réplica de `saveClientToDB` con un `visibleTo` distinto del almacenado, y `gestor` sí puede subir a su propia carpeta `clients/{cid}`), y una carrera preexistente en
  `clientsService.iso.js` (el disparador `syncClientVisibility_local` rellenaba `visibleTo` antes de la prueba de relleno histórico).

---

## 3. Matriz de permisos medida (reglas candidatas)

Se midió contra `firestore.rules` y `storage.rules` **sin modificar**. Los roles de planta (Jefe, Operario, Calidad, Despacho) representan
una **sesión de Firebase con claims** (el objetivo de diseño); la columna `Tablet sin sesión` representa lo que hacen hoy las tabletas.

### A. Resumen por colección, operación y rol (reglas candidatas, medido en el emulador)

✔ = todas las operaciones medidas de esa clase se permiten · ◐ = solo algunas · ✘ = ninguna. `Tablet sin sesión` es la situación real de las tabletas hoy (sin Firebase Auth).

| Colección | Op. | n | Tablet sin sesión | Gerente | Gestor | Vendedor | Jefe prod. | Operario | Calidad | Despacho | Recepción | Dibujante |
|---|---|--:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `clients` | list | 1 | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `prospects` | list | 1 | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `users` | list | 2 | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `system` | read | 1 | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `audit_logs` | list | 1 | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `fabricacion` | list | 1 | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `fabricacion_tasks` | list | 1 | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `proyectos_fabricacion` | list | 2 | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `bobinas_soldadura` | list | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `config` | read | 2 | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `alertas_maquinas` | list | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `clients` | update | 1 | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `clients` | create | 1 | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `clients` | delete | 1 | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `audit_logs` | create | 1 | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `prospects` | update | 1 | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `prospects` | create | 1 | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `prospects` | delete | 1 | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `proyectos_fabricacion` | delete | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `users` | update | 1 | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `system` | update | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `proyectos_fabricacion` | create | 1 | ✘ | ✔ | ✔ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `fabricacion` | update | 2 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✔ | ✔ |
| `fabricacion` | create | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✔ | ✔ |
| `fabricacion_tasks` | update | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `fabricacion_tasks` | create | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `fabricacion_tasks` | delete | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `bobinas_soldadura` | update | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ |
| `config` | update | 2 | ✘ | ✔ | ✘ | ✘ | ✔ | ◐ | ◐ | ◐ | ◐ | ◐ |
| `alertas_maquinas` | create | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `alertas_maquinas` | update | 1 | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `prospects_local` | create | 1 | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `storage` | create | 7 | ✘ | ◐ | ◐ | ✘ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |

### B. Detalle por operación real

| Módulo | Operación | Origen | Tablet sin sesión | Gerente | Gestor | Vendedor | Jefe prod. | Operario | Calidad | Despacho | Recepción | Dibujante |
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| CRM+FAB | list.clients (unfiltered onSnapshot) | `app_core.js:472, fabricacion app.js:329` | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM+FAB | list.prospects (unfiltered onSnapshot) | `app_core.js:475, fabricacion app.js:330` | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM+FAB | list.users (unfiltered onSnapshot) | `app_core.js:476, fabricacion app.js:331` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM+FAB | get.system/settings (onSnapshot) | `app_core.js:478, app.js:336` | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| CRM | list.audit_logs orderBy timestamp limit 20 | `app_core.js:2674` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB+TAB | list.fabricacion (onSnapshot) | `app.js:332, operador.js:4025` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB+TAB | list.fabricacion_tasks (onSnapshot) | `app.js:334, operador.js:4036` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB | list.proyectos_fabricacion (onSnapshot) | `app.js:333` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB+TAB | list.bobinas_soldadura (onSnapshot) | `app.js:369, operador.js:4063` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB+TAB | get.config/maquinas (onSnapshot) | `app.js:350, operador.js:4047` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| TAB | get.config/estado_equipos (onSnapshot) | `operador.js:4055` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB+TAB | list.alertas_maquinas (onSnapshot) | `operador.js:4074, ui.js:637` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| TAB | TAB login: users where role in [plant roles] (PIN / password compare in the browser) | `operador.js:262` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveClientToDB: set existing client | `app.js:397, js/clientes.js` | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveClientToDB: create a new client | `js/clientes.js (new client)` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.delete client + audit | `js/clientes.js:327` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM+FAB | write.audit_logs add (forgeable "usuario") | `js/clientes.js:328, oportunidades.js:1026, proyectos.js:816` | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB | write.saveProspectToDB: set existing opportunity | `app.js:398, js/oportunidades.js:521, js/proyectos.js` | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveProspectToDB: create opportunity directly (own code generator, no audit) | `js/oportunidades.js:197,521` | ✘ | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.delete opportunity (physical) | `js/oportunidades.js:1017` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | cascade.list proyectos_fabricacion where prospecto_id == P1 | `js/oportunidades.js:1020` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB | cascade.delete proyectos_fabricacion | `js/oportunidades.js:1022` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveUserToDB: set a user profile | `app.js:399, js/auth.js` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveSettings: set system/settings (whole document) | `app.js:403, js/ui.js` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.send to fabricacion: create proyectos_fabricacion | `js/fabricacion.js:122,158` | ✘ | ✔ | ✔ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.saveFabricacionToDB: set existing order | `app.js:400` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✔ | ✔ |
| FAB | write.create fabricacion order / split order batch.set | `js/fabricacion.js:1191-1196` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✔ | ✔ |
| TAB | write.OPERATOR updates the parent order (status / progress) | `operador.js:1997,2046,2595,2828,3185,3522,3914,5657` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✔ | ✔ |
| TAB | write.OPERATOR advances a task (batch.update) | `operador.js:1951,2359,2558,2791,3145,3485,3575,3966,4422,5620,5712` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| FAB | write.create fabricacion_tasks (order generation) | `app.js:401, js/fabricacion.js:2412` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.delete fabricacion_tasks | `js/fabricacion.js` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| TAB | write.OPERATOR welding spool (bobinas) update / create | `operador.js:3822-3842` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ |
| FAB | write.config/maquinas set | `js/ui.js:808` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| TAB | write.config/estado_equipos batch.set (machine status from tablets) | `operador.js:4217, js/ui.js:637` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| TAB | write.alertas_maquinas add (operator reports a machine failure) | `operador.js:5733` | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| TAB+FAB | write.alertas_maquinas mark as read | `operador.js:5750,4231, js/ui.js:650` | ✘ | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM+FAB+TAB | write._local collection (forced_db_suffix=_local from a browser pointed at this project) | `DB_SUFFIX switch (app.js:29, operador.js:181)` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM + fabricacion pages | storage upload prod_files/clientes/… | `uploadFileToStorage` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM + fabricacion pages | storage upload prod_files/ordenes_cambio/… | `uploadFileToStorage` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM + fabricacion pages | storage upload prod_files/facturas/… | `uploadFileToStorage` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM + fabricacion pages | storage upload prod_files/pagos/… | `uploadFileToStorage` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CRM + fabricacion pages (oferta, costos, levantamiento, contrato) | storage upload prod_files/proyectos/… | `uploadFileToStorage` | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| fabricacion (js/fabricacion.js:98) | storage upload prod_files/requerimientos/… | `uploadFileToStorage` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| fabricacion (js/fabricacion.js:2305-2316) | storage upload prod_files/fabricacion_archivos/… | `uploadFileToStorage` | ✘ | ✔ | ✔ | ✘ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |


### Lectura de la matriz

* **Vendedor**: nunca puede listar `clients` ni `prospects` sin filtro (los listeners actuales). Sí puede con filtro `createdBy == yo` /
  `vendedorId == yo` (medido en D) y no puede leer lo de otro vendedor.
* **Gestor**: lista todo lo comercial, no `users`, no `audit_logs`; crea `proyectos_fabricacion` pero no gestiona tareas ni órdenes.
* **Gerente**: todo, incluida la eliminación física de `prospects`, `clients`, `proyectos_fabricacion` (brecha: ver P2).
* **Planta**: lee fabricación/config/alertas; **no** lee datos comerciales (`prospects`, `clients`, `users`) — medido en D.
* **`operario`, `control_calidad`, `despacho` no pueden actualizar la orden padre (`fabricacion`)** aunque tengan sesión, pero las tabletas lo hacen en 8 puntos (`operador.js`). Es una incompatibilidad **de las propias reglas**, no de la sesión.
* `users`: ningún rol puede escribir (`allow write: if false`) → `saveUserToDB` de fabricación y del CRM (históricos) dejan de funcionar.
* `audit_logs`: cualquier sesión válida puede crear con un `usuario` falsificable.

---

## 4. Rutas de Storage: reales vs. previstas

| Origen | Ruta realmente usada | Ruta que aceptan las reglas candidatas | ¿Funciona? (medido) |
|---|---|---|---|
| CRM `app_core.js:303` y fabricación `app.js:168` | `prod_files/{clientes\|ordenes_cambio\|facturas\|pagos\|proyectos}/{timestamp}_{nombre}` | `prod_files/prospects/{pid}/{folder}/{file}` o `prod_files/clients/{cid}/{file}` | **No, para nadie** (ni gerente) — 403 |
| Fabricación `js/fabricacion.js:98` | `prod_files/requerimientos/…` | `prod_files/{requerimientos\|fabricacion_archivos}/{file}` | Solo con sesión válida (gerente, gestor, planta); fabricación no tiene sesión → **no** |
| Fabricación `js/fabricacion.js:2305-2316` | `prod_files/fabricacion_archivos/…` | idem | idem |
| Entorno local (`STORAGE_PREFIX` local) | `local_files/**` | ninguna (denegado) | **No, nadie** |
| Operarios (`operador.js`) | no usan Storage (no cargan el SDK) | — | n/a |
| Rutas previstas `prospects/{pid}/…` y `clients/{cid}/…` | **no las produce ningún código actual** | las aceptan | Gerente ✔, gestor ✔, vendedor ✔ (en sus carpetas), planta ✘, tableta ✘ |

Otros límites: las reglas son de solo creación (sin listar/actualizar/borrar); los enlaces con token ya almacenados en Firestore **ignoran las reglas**
(siguen funcionando para quien los tenga hasta rotar los tokens) — por eso la migración de rutas no rompe documentos ya guardados, pero tampoco los protege.

---

## 5. Escrituras directas a Firestore que aún existen

### 5.1 CRM

| Operación | Origen | Función de servidor que debe sustituirla | Riesgo / incompatibilidad |
|---|---|---|---|
| `saveUserToDB` (solo perfiles históricos sin `authUid`; rechaza perfiles con Auth) | `app_core.js:~491` | Ninguna aún: la migración de identidad histórica está fuera de alcance. Hará falta una función de migración/primer acceso | Con `users` write=false el flujo de primera contraseña / reinicio de históricos **dejaría de funcionar**. Único escritor directo del CRM (comprobado) |
| Listeners sin filtro `clients`, `prospects`, `users`, `system/settings`, `audit_logs` | `app_core.js:472,475,476,478,2674` | Consultas filtradas (`createdBy`/`vendedorId`/`visibleTo`) o callables de lectura paginada; un directorio de usuarios sin contraseñas (`userDirectory_*` está en las reglas pero **aún no existe quien lo escriba**) | Vendedor: 403 (medido). Gestor: `users` y `audit_logs` 403 |
| Subidas a Storage | `app_core.js:303` | Función que emita una ruta firmada/permitida `prospects/{pid}/{folder}/…`, o ajuste de reglas a las rutas planas | 403 para todos |

### 5.2 Fabricación (índice)

| Operación | Origen | Función que debería sustituirla | Riesgo / incompatibilidad |
|---|---|---|---|
| `saveClientToDB` (set de cliente existente) | `app.js:397`, `js/clientes.js` | `updateClientAdmin` | Con reglas: gerente/gestor/vendedor visibles ✔ si no cambian identidad; sin transacción ni auditoría |
| Crear cliente | `js/clientes.js` | `createClientAdmin` | `clients` create=false → **falla**; además sin deduplicación por NIT/DUI |
| Borrar cliente + `audit_logs` | `js/clientes.js:327-328` | `deleteClientAdmin` | Gerente puede borrar físico con reglas; sin comprobar proyectos; auditoría falsificable |
| `saveProspectToDB` (editar oportunidad) | `app.js:398`, `js/oportunidades.js:521`, `js/proyectos.js` | `advanceProspectStageAdmin`, `editProspectBasePriceAdmin`, `reassignProspectAdmin`, etc. (según la acción) | Reescribe el documento entero desde el snapshot local (datos obsoletos, campos protegidos `autorizado_*`) |
| Crear oportunidad (código propio) | `js/oportunidades.js:197,521` | `createProspectAdmin` | Código duplicado (E); sin auditoría |
| Borrado físico + cascada a `proyectos_fabricacion` | `js/oportunidades.js:1017-1022` | `deleteProspectAdmin` (eliminación lógica) | **Contradice la decisión de eliminación lógica**: borra proyectos; las reglas candidatas aún lo permiten al gerente |
| `audit_logs.add` | `js/clientes.js:328`, `js/oportunidades.js:1026`, `js/proyectos.js:816` | Auditoría solo del servidor | Forjable por cualquier sesión válida |
| `saveUserToDB` | `app.js:399`, `js/auth.js` | Funciones de usuarios (`create/update/toggleUserAdmin`) | Denegado a todos; hoy además lee contraseñas en claro |
| `saveSettings` (`system/settings` completo) | `app.js:403`, `js/ui.js` | `updateSettingsAdmin` | Reescribe todo el documento (el CRM toca solo 3 claves) |
| Migración localStorage | `app.js:319-322` | Importador explícito del CRM (`functions/scripts/importLegacyLocalStorage.js` + `legacyImport.js`; no es un callable) | Escribe sin autorización desde el navegador; con `users`/`clients`/`prospects` restringidos fallaría |
| Crear `proyectos_fabricacion` (id `FAB-PROJ-`+`Date.now()`) | `js/fabricacion.js:122,158` | **Falta**: `createFabricationProjectAdmin` con id y código idempotentes | Sobrescritura silenciosa con `set()` (E); vendedor dueño de la venta no puede enviar a fabricación (D) |
| Órdenes y tareas (`fabricacion`, `fabricacion_tasks`: crear, dividir, borrar, batches) | `js/fabricacion.js:963-972,1156-1196,2412,2635-2646`, `js/op-despacho.js`, `js/op-qa.js` | **Falta**: funciones de fabricación | Recepción/dibujante pueden crear órdenes pero no tareas; batches sin transacción |
| `config/maquinas`, `config/estado_equipos`, `alertas_maquinas` | `js/ui.js:637-653,808` | **Falta**: funciones de configuración | Colecciones **sin sufijo**: un navegador de prueba escribe sobre producción |
| Subidas a Storage | `app.js:168`, `js/fabricacion.js:98,2305-2316` | Rutas emitidas por servidor | 403 (`clientes`…`proyectos`); requerimientos solo con sesión |

### 5.3 Tabletas de operarios (`operador.html` / `operador.js`)

| Operación | Origen | Función que debería sustituirla | Riesgo / incompatibilidad |
|---|---|---|---|
| **Login**: consulta `users` con `role in [roles de planta]` y compara PIN / contraseña en el navegador | `operador.js:259-272` | **Falta**: callable de login de planta (verifica PIN / contraseña numérica en servidor y emite sesión). **No implementado ni decidido** | Medido en A: hoy la consulta devuelve PIN y contraseña **en claro a un cliente sin sesión**. Con reglas candidatas: 403 |
| Avanzar tareas (`batch.update` en ~11 sitios) | `operador.js:1951,2359,…,5712` | Función de fabricación (con transacción) | Sin sesión → 403. Sin transacción: 4 escrituras simultáneas → 1 sobrevive, 3 se pierden en silencio (medido en E) |
| Actualizar la orden padre | `operador.js:1997,…,5657` | idem | **Las reglas candidatas lo deniegan a operario, calidad y despacho incluso con sesión** |
| Bobinas de soldadura | `operador.js:3822-3842` | idem | Calidad/despacho no pueden |
| `config/estado_equipos`, `alertas_maquinas` | `operador.js:4217,4231,5733,5750` | idem | Marcar alerta como leída solo gerente/jefe |

---

## 6. Resultados por escenario solicitado

| Escenario | Resultado medido |
|---|---|
| Crear y consultar clientes y oportunidades | CRM por callables ✔ (D). Consultas filtradas por `createdBy`/`vendedorId` ✔; listeners sin filtro ✘ para vendedor |
| Permisos vendedor / gestor / gerente | Matriz §3. Vendedor ✘ lista sin filtro; gestor ✘ `users`/`audit_logs`; solo gerente resuelve venta sin contrato |
| Autorización sin contrato | ✔ (D): sin autorización el cierre es rechazado; vendedor solicita; vendedor y gestor **no** resuelven (`PERMISSION_DENIED`); el gerente aprueba; el cierre pasa a `ganado` |
| Facturas, pagos y documentos | ✔ por callables (`saveInvoiceAdmin`, `savePaymentAdmin`), documentos por URL; **las subidas a Storage fallan** (§4) |
| Proyectos de fabricación | Crear/consultar: gerente, gestor y jefe ✔; el vendedor dueño ✘; planta lee ✔ pero no ve la oportunidad ni el cliente |
| Operarios (PIN / numérica) | No se pudo probar con el login real (no usa Auth). Reproducido: sin sesión todo ✘; con sesión de planta las operaciones de tareas ✔, orden padre ✘ |
| Aislamiento tabletas ↔ CRM | ✔ en F: una cuenta de planta es rechazada por todos los callables comerciales; sesiones comerciales no escriben colecciones de planta. ✘ Las colecciones `config`/`alertas_maquinas` son compartidas sin sufijo |
| Eliminación lógica | ✔ (D): la oportunidad queda marcada `eliminado`, el proyecto de fabricación y el archivo de Storage intactos. ✘ Fabricación **no conoce `eliminado`** y la sigue mostrando; su propio borrado es físico y en cascada |
| Códigos y concurrencia | CRM ✔ 10 creaciones simultáneas → 10 códigos distintos y consecutivos. ✘ Fabricación cuenta documentos del snapshot: dos clientes con el mismo snapshot generan el mismo código y, escrito directo, **duplica un código que el CRM ya emitió** |
| Escrituras directas que dejarían de funcionar | §5 |

---

## 7. Incompatibilidades priorizadas

**P1 — bloquean cualquier endurecimiento**

1. **Tabletas sin sesión** (`operador.html`): sin Auth, todas sus lecturas y escrituras serían 403. Además el login actual expone PIN y contraseña en claro. *No se modificó la autenticación de operarios.* Decisión pendiente (propuesta, no implementada): callable que verifique PIN/contraseña numérica y devuelva un custom token con claims de planta, conservando la experiencia de PIN.
2. **Rutas de Storage**: ambos módulos suben a rutas planas que las reglas candidatas rechazan a todos.
3. **Listeners sin filtro** del CRM y de fabricación (clients, prospects, users, audit_logs): fallan para vendedor/gestor; fabricación (sin Auth) falla para todos.
4. **`users` write=false** rompe `saveUserToDB` de fabricación y el flujo de históricos del CRM.

**P2 — datos incorrectos o decisiones funcionales vulneradas**

5. Borrado físico + cascada desde fabricación (y permitido al gerente por reglas) vs. eliminación lógica aprobada; fabricación ignora `eliminado`.
6. Códigos duplicados de oportunidad (fabricación vs. contador transaccional del CRM).
7. Reglas demasiado estrictas para planta: `operario`/`control_calidad`/`despacho` no actualizan la orden padre; calidad/despacho no escriben bobinas; el vendedor dueño no envía a fabricación; recepción/dibujante crean órdenes sin poder crear tareas.
8. `audit_logs.create` abierto a cualquier sesión (campo `usuario` falsificable).
9. Fabricación reescribe oportunidades y clientes completos desde su snapshot (datos obsoletos, riesgo para `autorizado_*`).

**P3 — endurecimiento posterior**

10. `config` y `alertas_maquinas` sin sufijo de entorno (pruebas locales escriben sobre producción).
11. `system/settings` reescrito completo por fabricación (`saveSettings`) vs. 3 claves del CRM.
12. Ids `FAB-PROJ-`+`Date.now()` con `set()` (sobrescritura silenciosa) y operarios sin transacciones (última escritura gana).
13. Tokens de descarga ya emitidos ignoran las reglas de Storage.
14. Lectura de contraseñas y PIN en claro desde el cliente de fabricación (`users`).

---

## 8. Plan de corrección por etapas (sin ejecutar en esta fase)

| Etapa | Contenido | Requisitos / criterio de salida |
|---|---|---|
| 0. Decisión | Decidir con negocio: método de sesión de tabletas (custom token por PIN), política de rutas de Storage, qué rol puede qué en fabricación | Aprobación explícita; ninguna regla cambia |
| 1. Servidor para fabricación | Funciones para proyectos (crear/borrar con id idempotente), órdenes, tareas, bobinas, config, alertas; login de planta; reutilizar el patrón de bloqueos (`userOpsLocks`), idempotencia y auditoría del CRM | Suite de emulador equivalente a `commercialFlow.e2e` para fabricación; sin cambiar las reglas |
| 2. Migrar los clientes de fabricación | Fabricación pasa a llamar a las funciones (CRM ya listo): clientes, oportunidades, códigos, auditoría; entender `eliminado`; quitar borrado físico/cascada | Validación en emulador con ambos módulos; códigos únicos; eliminación lógica preservando proyectos y archivos |
| 3. Lecturas y Storage | Consultas filtradas o callables de lectura; rutas de Storage emitidas por servidor o reglas ajustadas a las rutas reales; un directorio de usuarios sin contraseñas mantenido por servidor (hoy inexistente) en vez de `users` | Matriz de permisos medida de nuevo sin 403 en operaciones legítimas |
| 4. Históricos | Migración explícita de identidades (fuera de esta fase; no se tocaron usuarios) | Plan aprobado, ensayo en emulador |
| 5. Reglas | Solo ahora aplicar reglas restrictivas, en emulador primero; corregir reglas de planta (orden padre, bobinas) y `audit_logs` | Repetir toda esta batería (`jointValidation.iso.js`) con todos los casos A–F en verde sin "KNOWN GAP" |
| 6. Despliegue controlado | Por entornos, con reversa | Fuera del alcance de esta fase |

Cada "KNOWN GAP" de `jointValidation.iso.js` es una prueba que **debe cambiar a expectativa de rechazo** cuando su etapa se complete.

---

## 9. Cómo reproducir

```
# emuladores aislados (no tocan los de desarrollo)
env JAVA_HOME=<jdk21> PATH=<jdk21>/bin:$PATH npx -y firebase-tools@latest emulators:start \
  --config firebase.isolated-emulator.json --project demo-ductsal-isolated --only auth,firestore,storage,functions
cd functions
npx jest                                              # unitarias (incluye jointInventory)
JOINT_MATRIX_OUT=/ruta/matriz.json npx jest -c jest.isolated.config.js --runInBand   # emulador (la suite conjunta exporta la matriz JSON)
```
