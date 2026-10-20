# Operaciones comerciales en el servidor (CRM) — estado, pruebas y dependencias

> Estado: **implementado localmente, sin desplegar, sin commit**. Unitarias, reglas y emuladores (Firestore, Auth, Functions,
> Storage aislados) **ejecutadas el 2026-10-16** (ver §4). Nada de este documento autoriza un despliegue.

## 1. Funciones (Cloud Functions, JS plano, `functions/index.js` + `functions/commercialService.js`)

Estructura real respetada: JavaScript, Node 20, `firebase-functions` v4 (`functions.https.onCall`), `firebase-admin` v11, sin
TypeScript ni `functions/src/`. Las funciones de administración existentes **no se tocaron ni se duplicaron**:
`createUserAdmin`, `toggleUserStatusAdmin`, `resendInvitationAdmin`, `reconcileUserOp`, `createClientAdmin`,
`updateClientAdmin`, `searchClientsCatalog`.

Identidad y autorización comunes (`runCommercialOp` → `clientsServiceFor(suffix).resolveCaller`):
sesión Firebase obligatoria → perfil CRM vinculado por `authUid` (o por el claim `cid` solo si el perfil apunta a ese `uid`)
→ perfil activo → rol del **perfil** (nunca el que envía el navegador) ∈ `manager | gestor | vendedor`. Perfiles históricos
(sin `authUid`) y roles de planta quedan denegados. El `suffix` de entorno se valida contra una lista cerrada y el guardián
de emulador (`assertEmulatorIsolated`) se aplica igual que en las funciones de clientes.

| Función | Quién puede | Qué decide el servidor (el navegador no puede) | Idempotencia / concurrencia | Auditoría |
|---|---|---|---|---|
| `createProspectAdmin` `{prospect, opId}` | manager, gestor, vendedor. Asignar a **otro** vendedor: manager o gestor al crear | `id`, `codigo` (`AAAAMM`+secuencia anual por contador transaccional), `createdBy*` (inmutable), `vendedor*` (nombre y rol del perfil destino), fechas, etapa, estado, primer log | `opId` obligatorio; reintento con el mismo `opId` devuelve el mismo registro; mismo `opId` con otro cuerpo/otro usuario se rechaza; colisión de `id` → siguiente id, nunca sobrescribe | `commercialAudit_*` |
| `addProspectLogAdmin` `{prospectId, text, opId}` | manager: todas; gestor: solo leads ingresados por él (`createdBy === caller.cid`) o proyectos en postcierre; vendedor: asignado (`vendedorId`) o creado | autor (`by`, `byName`) y fecha | `opId` guardado en la entrada: el reintento no duplica la nota | no (nota ordinaria) |
| `deleteProspectLogAdmin` `{prospectId, date, text}` | manager: cualquier nota manual; gestor: manuales de sus leads/postcierre; vendedor: **solo las suyas**. Notas automáticas: nadie | qué nota (por fecha+texto, no por posición) | borrar algo ya borrado → `absent` sin error ni segunda auditoría | `commercialAudit_*` |
| `reassignProspectAdmin` `{prospectId, vendedorId}` | **solo manager (en vivo)** (§7.7) | destino existente, no inactivo y de rol comercial; `createdBy` **inmutable**; recálculo transaccional de cartera (`visibleTo`/`closingVendors`); auditoría de autorización | misma asignación → `unchanged` sin escribir | `commercialAudit_*` |
| `setNoContractAuthorizationAdmin` `{prospectId, authorized}` | **solo manager**, verificado en vivo contra Auth (claim `manager`) | quién autoriza (`autorizado_por`, `autorizado_por_id`), entrada de historial; además cierra la solicitud pendiente (→ `aprobada`) o marca la aprobada como `revocada` | mismo estado → `unchanged` | `commercialAudit_*` |
| `requestNoContractAuthorizationAdmin` `{prospectId, motivo, opId}` (**nueva, §7.2**) | vendedor / gestor con acceso al registro (el gerente autoriza directo) | solicitante, rol, fecha, estado `pendiente` | `opId` guardado en la solicitud; misma persona + mismo motivo → `unchanged` | `commercialAudit_*` |
| `resolveNoContractAuthorizationAdmin` `{prospectId, requestId, decision, motivoDecision}` (**nueva, §7.2**) | **solo manager** en vivo; nunca el solicitante | gerente que resuelve, fecha, estado final, `datos.autorizado_*` al aprobar | por estado almacenado: misma decisión → `unchanged`; contradictoria → rechazo | `commercialAudit_*` |
| `updateSettingsAdmin` `{action, list, value}` (`addItem`/`removeItem`/`setFactoryAddress`) | **solo manager** (en vivo) | solo las claves del CRM (`visitantes`, `encargados`, `factory_address`), con `merge`; borrado **por valor**, no por índice | alta/baja repetida → `unchanged` | `commercialAudit_*` |
| `deleteClientAdmin` `{clientId}` | **solo manager** (en vivo) | rechaza si hay oportunidades que lo referencian (misma transacción); libera solo los identificadores NIT/DUI que le pertenecen | borrado repetido → `absent` | `audit_logs_*` con la forma que ya lee el panel del gerente (`usuario` sale del perfil autenticado) |

Cambio adicional en `functions/clientsService.js`: quitar un **documento adjunto** de un cliente (`documentos`) mediante
`updateClientAdmin` ahora es **solo manager** (`assertDocumentRemovalAllowed`; antes cualquier usuario con acceso podía hacerlo).
Se comprueba antes y dentro de la transacción. En la interfaz, `deleteClientDocument` sigue usando `updateClientAdmin`.

Auditoría: las operaciones sensibles escriben su entrada **en la misma transacción** que el cambio, con identidad del contexto
autenticado (`uid`, `cid`, rol, nombre del perfil), id automático y colección solo-servidor. El panel de auditoría del CRM
(`fetchAuditLogs`) pinta toda entrada de `audit_logs_*` como "X eliminó Y", por eso solo los borrados van ahí; el resto va a
`commercialAudit_*` (sin pantalla todavía).

### 1.1 Flujo de la oportunidad (`functions/prospectWorkflowService.js`, 11 callables)

Todas usan la misma resolución de identidad que §1 (`runCommercialOp`). Rol permitido: `manager | gestor | vendedor` **con acceso al
registro** (creador o asignado; manager/gestor, todas) — salvo `deleteProspectAdmin` (solo manager, verificado en vivo). Cada
operación es **una transacción sobre el documento almacenado**: el navegador nunca envía el documento ni importes calculados, y
lo que otro usuario haya escrito entre tanto (notas, autorización, facturas) no se pisa.

| Función | Campos que el navegador puede enviar | Transiciones / reglas que decide el servidor | Idempotencia | Auditoría |
|---|---|---|---|---|
| `advanceProspectStageAdmin` | `nextStage`, `data` (visitante, fechas, ubicación, distancia, costo, precio, probabilidad, forma de pago, número de factura de anticipo, encargado, archivos) | Una etapa cada vez (`prospecto→levantamiento→cotizacion→negociacion→cierre`), nunca saltar ni retroceder; solo oportunidad `activo`. **Cierre**: cliente con registro completo, `documentos.dui`, regla de contrato (instalación con precio/costo > 10 000 exige contrato **salvo** `datos.autorizado_sin_contrato === true` **almacenado**; lo que envíe el navegador se ignora), `forma_pago` ∈ {100% anticipado, 70/30, 50/50}, encargado en "Fabricación e instalación". La **factura de anticipo** la calcula el servidor (subtotal × 1,13 salvo exportación × porcentaje, redondeada a centavos) | Repetir la etapa ya alcanzada → `unchanged` (una sola factura de anticipo y un solo log de cierre) | `commercialAudit_*` (`advanceStage`) |
| `markProspectLostAdmin` | `reason` | Motivo de la lista cerrada; solo `activo`; mismo motivo repetido → `unchanged`, otro motivo → rechazo | sí | `markLost` |
| `registerProposalAdmin` | precio, costo, archivos de oferta y costos (obligatorios) | Solo en `activo` + `negociacion` | mismos valores → `unchanged` | `registerProposal` |
| `editProspectBasePriceAdmin` | precio, costo, `motivo` (obligatorio) | **Solo manager/gestor** y **solo con `estado === 'activo'` almacenado** (§7.1); importes válidos; valores anteriores y entrada de historial salen del documento almacenado | mismos valores → `unchanged` | `editBasePrice` |
| `saveChangeOrderAdmin` / `deleteChangeOrderAdmin` | tipo, descripción, importes, archivos; `orderId` para editar/borrar | **Solo manager y gestor** (vendedor denegado). Requisito: haber entrado a postcierre (`hasEnteredPostclosing`); alta por `opId`; borrado por `id` | reintento con el mismo `opId` no duplica; borrar lo ya borrado → `absent` | `saveChangeOrder` / `deleteChangeOrder` + aviso en `audit_logs_*` al borrar |
| `saveInvoiceAdmin` / `deleteInvoiceAdmin` | número, monto, archivo; `invoiceId` para editar/borrar | **Solo manager y gestor** (vendedor denegado). Requisito: haber entrado a postcierre (`hasEnteredPostclosing`); tope transaccional de saldo; factura de anticipo no eliminable | `opId` guardado en la factura | `saveInvoice` / `deleteInvoice` + aviso al borrar |
| `savePaymentAdmin` / `deletePaymentAdmin` | monto, método, referencia, comprobante; `paymentKey` para editar/borrar | **Solo manager y gestor** (vendedor denegado). Requisito: haber entrado a postcierre (`hasEnteredPostclosing`); tope de saldo de la factura; retención 1% solo gran contribuyente | `opId` guardado en el abono | `savePayment` / `deletePayment` + aviso al borrar |
| `deleteProspectAdmin` | `prospectId`, `motivo` (obligatorio) | **Solo gerente (en vivo)**. **Eliminación lógica** (§7.4): marca `eliminado`, quién, cuándo y por qué; no borra el documento, ni `proyectos_fabricacion`, ni archivos | ya eliminada → `unchanged`; inexistente → `absent` | `deleteProspect` (`detail.logical: true`) + aviso en `audit_logs_*` con el motivo |
| `reactivateLostProspectAdmin` | `prospectId`, `motivo` (obligatorio) | **Solo gerente (en vivo)**. **Reactivación de proyecto perdido** (§7.5): restaura estado a `activo` en la etapa comercial previa; archiva `historial_perdidas` y `ultima_perdida`; remueve `motivo_perdida` y `fecha_perdida` del documento raíz; sincroniza atómicamente `visibleTo` del cliente y `closingVendors` si la etapa restaurada es `cierre` | reintento con mismo motivo → `unchanged`; estado activo/ganado/eliminado → rechazo | `commercialAudit_*` (`reactivateProspect`) + log de sistema en la oportunidad |

Validación común: importes numéricos finitos y no negativos; referencias de archivo `{name, url}` cuya URL empiece por
`https://firebasestorage.googleapis.com/v0/b/` (solo bajo el emulador de Functions se aceptan también `http://127.0.0.1:` y
`http://localhost:`).

Las autorizaciones de venta sin contrato **no** viajan por ninguna de estas operaciones: solo `setNoContractAuthorizationAdmin`
(§1) escribe `datos.autorizado_*`, y las operaciones del flujo ignoran cualquier valor equivalente que envíe el navegador (hay
pruebas que lo verifican, incluida la de cierre con `autorizado_sin_contrato` falso en el `data`).

**Cambios de comportamiento respecto al código anterior (identificados antes de migrar):**

* Las facturas de anticipo se guardan redondeadas a centavos (antes podían quedar `7909.999999999998`).
* El servidor rechaza importes negativos / no numéricos y URL de archivo que no sean de Storage (la página no lo comprobaba).
* Las comprobaciones del servidor son más estrictas que las de la página a propósito (etapa, estado, tope de saldo contra el
  documento almacenado y no contra la copia local).
* Los abonos antiguos sin `id` se identifican por `fecha`: si hubiera dos con la misma `fecha`, la operación actúa sobre el primero.

## 2. Interfaz: qué usa ya las funciones y qué sigue pendiente

Módulo de navegador nuevo: [crm_commercial.js](../crm_commercial.js) (cargado en [index.html](../index.html) antes de
`app_core.js`, `app_core.js?v=17`). **No hay respaldo a escritura directa**: sin sesión Firebase o si el servidor falla, la
operación no ocurre y se explica (`NO_SESSION_MESSAGE` / `errorMessage`). No existe ninguna bandera que reactive escrituras
directas (hay una prueba estática que lo vigila).

| Operación en la interfaz (`app_core.js`) | Estado | Función |
|---|---|---|
| Crear oportunidad (`createNewProspect`) | **migrada** | `createProspectAdmin` |
| Agregar nota (`addLog`) | **migrada** | `addProspectLogAdmin` |
| Eliminar nota (`deleteLog`) | **migrada** | `deleteProspectLogAdmin` |
| Reasignar vendedor (`reassignVendor`) | **migrada** | `reassignProspectAdmin` |
| Autorizar/revocar venta sin contrato (`toggleManagerApproval`, `…InForm`) | **migrada** | `setNoContractAuthorizationAdmin` |
| Solicitar / aprobar / rechazar venta sin contrato (`requestNoContractAuthorization`, `resolveNoContractRequest`) | **nueva** | `requestNoContractAuthorizationAdmin` / `resolveNoContractAuthorizationAdmin` |
| Editar nombre / rol de usuario con `authUid` (`saveUser` → `CrmAuth.adminUpdateUser`) | **nueva** | `updateUserAdmin` |
| Ajustes: visitantes, encargados, dirección de planta (`addSetting`, `removeSetting`, `saveMapsSettings`) | **migrada** | `updateSettingsAdmin` |
| Eliminar cliente (`deleteClient`) | **migrada** | `deleteClientAdmin` |
| Crear/editar cliente, búsqueda de catálogo | ya estaba migrada (fase anterior); quitar documento también por `updateClientAdmin` | `createClientAdmin` / `updateClientAdmin` / `searchClientsCatalog` |
| `saveSettings()`, `saveProspectToDB()`, `saveClientToDB()` | **deshabilitadas**: lanzan un error, sin llamadas restantes | — |
| Cambiar etapa / avanzar, perder, nueva propuesta, corregir precio (`processAdvance`, `processLose`, `processNewProposal`, `processEditBasePrice`) | **migradas** | `advanceProspectStageAdmin`, `markProspectLostAdmin`, `registerProposalAdmin`, `editProspectBasePriceAdmin` |
| Órdenes de cambio, facturas, abonos (alta, edición, borrado) | **migradas** | `save/deleteChangeOrderAdmin`, `save/deleteInvoiceAdmin`, `save/deletePaymentAdmin` |
| Eliminar oportunidad (`deleteProspect`) | **migrada**; ahora eliminación lógica con motivo obligatorio; el listener de oportunidades omite `eliminado === true` | `deleteProspectAdmin` |
| Reactivar oportunidad perdida (`reactivateLostProspect`) | **nueva**; visible solo a managers en proyectos con `estado === 'perdido'`, confirmación, motivo obligatorio, actualiza vista tras respuesta del servidor | `reactivateLostProspectAdmin` |
| Bloque "migrar localStorage a Firebase" y administrador inicial automático | **retirados**: solo detecta y avisa; importación explícita en [LEGACY_IMPORT.md](LEGACY_IMPORT.md) | `scripts/importLegacyLocalStorage.js` (solo emuladores) |
| `reportToManager` | **eliminada**: escribía en `audit_logs` con el correo que el navegador decía tener | — |
| `applyManagerBypass` (formulario de contraseña del gerente) | **eliminada**: comparaba una contraseña en texto plano en JavaScript y escribía directo. La autorización la concede el gerente desde su propia sesión (`setNoContractAuthorizationAdmin`) | `setNoContractAuthorizationAdmin` |

**Escrituras directas que siguen pendientes (solo usuarios históricos, sin cuenta de Firebase Auth):**

1. `saveUserToDB` en `processFirstTimeSetup`, rama histórica de `resetUserPassword`, rama histórica de `toggleUserStatus` y la
   edición de usuarios sin `authUid` en `saveUser`: el login histórico compara una contraseña en texto plano guardada en
   `users_*`. Cerrarlo **es la migración de identidad** (fuera de alcance: no se inventó una estrategia de autenticación ni se
   migraron usuarios). `saveUserToDB` **lanza** para perfiles con `authUid`.
2. Editar nombre/rol de un usuario con `authUid`: **resuelto en §7.3** (`updateUserAdmin`). Los perfiles históricos siguen sin
   función (migración de identidad fuera de alcance).
3. **Las reglas siguen permitiendo escrituras directas.** No se tocaron `firestore.rules`/`storage.rules`. Con las reglas
   propuestas (no desplegadas) un vendedor sigue pudiendo, desde la consola del navegador, **crear y actualizar** las
   oportunidades que le pertenecen (con `autorizado_sin_contrato` protegido para quien no es gerente, pero con `etapa`,
   `estado`, `facturas`, `logs`… modificables), un gestor actualizar cualquiera y un gerente todo (solo el borrado es exclusivo
   del gerente). La interfaz ya no lo hace, pero **la protección de servidor solo será efectiva cuando se endurezcan las
   reglas** (§5), lo que depende de adaptar antes fabricación. Las reglas **vigentes en producción** no se han leído ni
   comparado en esta tarea (no se accede a producción).

**Dependencia de despliegue:** todos los usuarios históricos (sin `authUid`, login con contraseña en texto plano) **no tienen
sesión Firebase**, así que **todas** las operaciones migradas (§2) les devuelven "sin sesión" hasta que se migren a Firebase Auth.
Es el comportamiento pedido (sin respaldo); significa que **no se puede publicar esta interfaz para usuarios sin migrar**.

## 3. Roles, claims e identificadores históricos (verificado en código)

* Roles comerciales conservados: `manager`, `gestor`, `vendedor`. Roles de planta (`jefe_produccion`, `recepcion`, `dibujante`,
  `operario`, `encargado_armado`, `control_calidad`, `despacho`) **no** se mapean a ningún rol comercial: las funciones
  comerciales los deniegan.
* `cid` = id comercial histórico (`Date.now()` como texto; `C<timestamp>` en clientes). Se conserva en `createdBy`, `vendedorId`,
  `by` y auditoría. El `uid` de Auth nunca lo sustituye.
* **Desalineación claims ↔ reglas (no corregida: no se tocan claims en esta tarea):** `createUserAdmin` asigna claims `{role}`
  sin `cid`, mientras `firestore.rules` exige `cid` y, para gerentes, `manager: true`. Las funciones comerciales lo resuelven
  por `authUid` y comprueban `manager` en vivo, por lo que funcionan hoy; las **reglas candidatas** no funcionarían para esas
  cuentas hasta alinear los claims.

## 4. Pruebas — capas separadas (resultados reales, 2026-10-16)

Entorno: JDK 21 en `/Users/Benjamin/.local/jdk/jdk-21.0.12.1+1/Contents/Home` (no está en el PATH; `/usr/bin/java` es un stub),
Firebase CLI **no instalado**: se usó `npx -y firebase-tools@latest` (v15.34.0, descargado a la caché de npx; no se instaló nada en el
sistema). Emuladores aislados: `firebase emulators:start --config firebase.isolated-emulator.json --project demo-ductsal-isolated
--only auth,firestore,storage,functions` (Auth 9399, Firestore 8190, Storage 9290, Functions 5101). Los emuladores de desarrollo
(9099 / 8080 / 5001) no se tocaron. Ninguna prueba usó el proyecto de producción.

### 4.1 Unitarias — EJECUTADAS: `cd functions && npx jest`
Resultado tras la fase §7 (2026-10-16): **25 suites, 919 pruebas, 0 fallos** (al inicio de la fase: 24 / 832; nueva suite `updateUserAdmin.test.js`, 44 pruebas simuladas con `firebase-admin`/`firebase-functions` falsos; ampliadas las suites del flujo, comercial, UI y cliente). Firestore **simulado en memoria**
(`test-helpers/fakeFirestore.js`) y DOM/Firebase falsos: **no son pruebas de integración**.

| Suite | Qué cubre |
|---|---|
| `prospectWorkflow.unit.test.js` (51) | Servicio del flujo contra Firestore en memoria: autorización, etapas, cierre, facturas, abonos, órdenes de cambio, concurrencia, idempotencia |
| `commercialCallables.unit.test.js` (219) | Puntos de entrada `onCall` de las 18 funciones comerciales: sin sesión, perfil histórico/inactivo/de planta, claim falso, `dbSuffix`, guardián de emulador, errores sin fuga |
| `workflowUiFlow.test.js` (32) | Ejecuta las funciones **reales** migradas de `app_core.js` (facturas, abonos, órdenes, propuesta, etapa, pérdida, precio base, borrados) con DOM falso: solo callables, nunca el documento, sin sesión no se envía ni se sube nada, clave de abono en lugar de posición, reutilización de `opId` |
| `crmCommercial.client.test.js`, `commercialUiFlow.test.js`, `crmEnv.unit.test.js` | Módulo del navegador y guardas estáticas: sin `saveProspectToDB`/`saveClientToDB` en uso, sin contraseña de gerente en el navegador, la migración de localStorage no escribe, el administrador automático no escribe |
| `legacyImport.unit.test.js` | Importador explícito (solo lógica, Firestore en memoria) |
| Resto | Regresión (clientes, visibilidad, usuarios, entorno…) |

### 4.2 Reglas de Firestore y Storage — EJECUTADAS contra emuladores (reglas **sin cambios**)
`firestore.rules.iso.js` (168 pruebas) y `storage.rules.iso.js`: verdes. Una primera pasada de la suite completa falló una prueba
de reglas (`V2 edits non-identity data of C1`): **no era un fallo de las reglas** sino una carrera de la propia prueba. Su semilla
dejaba `C1.visibleTo = [V1, V2]`, pero con la oportunidad P3 (creada por el gerente) el disparador `syncClientVisibility` del
emulador de Functions lo recalcula a `[MGR, V1, V2]`; según la rapidez del disparador la prueba pasaba o fallaba (pasó en la
primera ejecución y falló, de forma reproducible, después). Se corrigió **la semilla de la prueba** para que coincida con lo que
deriva el servidor (ni `firestore.rules` ni `storage.rules` se modificaron). Resultado posterior: 3 ejecuciones aisladas verdes y
la suite completa verde.

### 4.3 Emuladores — EJECUTADAS: `npx jest -c jest.isolated.config.js --runInBand`
Resultado tras la fase §7 (2026-10-16): **9 suites, 467 pruebas, 0 fallos** (al inicio de la fase: 8 / 428), con `firestore.rules` y `storage.rules` sin cambios. Nueva: `userAdmin.e2e.iso.js` (gestión de usuarios por HTTP con cuentas y claims reales de Auth, bloqueo y transacciones reales). Una primera pasada de esta fase falló una prueba (`editBasePrice` esperaba un orden de auditorías que Firestore no garantiza); se corrigió **la aserción** (no el código) y la segunda pasada completa quedó verde. Antes de esa primera pasada había un emulador Firestore aislado huérfano de una sesión anterior (puerto 8190, proyecto `demo-ductsal-isolated`), que se detuvo; los emuladores de desarrollo no se tocaron.

| Suite | Capa real que ejerce |
|---|---|
| `commercialService.iso.js`, `prospectWorkflow.iso.js`, `clientsService.iso.js`, `legacyImport.iso.js` | Firestore real aislado con el Admin SDK (transacciones, contención y `create` reales). **No** prueban reglas (el Admin SDK las ignora) |
| `functionsCallables.iso.js` | Auth + Functions + Firestore + reglas: callables de clientes con tokens reales |
| `commercialFlow.e2e.iso.js` (**nueva**, 14) | Extremo a extremo con **tokens reales de Auth**, Functions emulado y Firestore emulado: crear → levantamiento → cotización → negociación → cierre → factura → abonos → borrados → eliminar; vendedor ajeno rechazado, salto de etapa rechazado, cierre idempotente, 4 facturas simultáneas por HTTP (exactamente 3 pasan), reintento con `opId`, auditoría con la identidad de la sesión, borrado directo denegado por reglas |
| `firestore.rules.iso.js`, `storage.rules.iso.js` | Reglas reales |

Limitaciones exactas: Storage solo se probó con las reglas (las URL de archivo de los callables son referencias; no se subieron
archivos reales); nada se probó contra un navegador real; el disparador `syncClientVisibility` funciona dentro del emulador pero
no se verificó su comportamiento en el entorno desplegado.

### 4.4 Revisión de `clientsService.js` (cambios anteriores)
Cambio revisado: `assertDocumentRemovalAllowed` (quitar un documento adjunto: solo gerente). Sin regresiones detectadas: `clientsService.iso.js`
y `functionsCallables.iso.js` verdes tras el cambio. `saveClient` clona el cliente completo (incluidos sus `documentos`) antes de
editar, así que editar otros campos **no** cuenta como quitar documentos. Riesgos residuales (no corregidos): (a) si un no
gerente edita desde una copia vieja a la que le falta un documento que otro acaba de subir, la edición se rechaza con
"Solo el gerente puede eliminar documentos" hasta recargar (falla del lado seguro); (b) un gerente que edita desde una copia vieja
sí puede **borrar sin querer** un documento recién subido, porque `documentos` se reemplaza completo (limitación previa a este
cambio).


## 5. Reglas: propuesta (no desplegada, sin cambios) y dependencias con fabricación

`firestore.rules` (propuesta previa, no desplegada) **no se cambió** y ninguna colección de clientes, oportunidades, usuarios
ni ajustes usa `allow read: if true`. Con las operaciones ya migradas, el objetivo (cuando todo esté migrado y validado) sería:

| Colección | Endurecimiento posible | Escrituras directas que se bloquearían (fabricación-dev) |
|---|---|---|
| `clients_*` | `create/update/delete: false` desde clientes (todo por callables) | `js/clientes.js` L203, L293 (`saveClientToDB`), L327 (`delete` + `audit_logs`); `app.js` L319 (migración local) |
| `prospects_*` | `create: false`; `delete: false`; `logs` y `datos.autorizado_*` inalterables desde el navegador | `app.js` L162 y L320; `js/oportunidades.js` (L218, L399, L425, L466, L489, L521, L583, L983, L1001 `set`; L1017 `delete` + cascada `proyectos_fabricacion`), `js/proyectos.js` (L386…L666 `saveProspectToDB`) |
| `system_*/settings` | impedir que un cliente cambie `visitantes`, `encargados`, `factory_address` (p. ej. `diff().affectedKeys()`), dejando libres las claves de fabricación | `js/ui.js` (`saveSettings()` reescribe **todo** el documento: `colores_pintura`, `tipos_base`, `maquinas`, `usbs`, `meta_diaria_piezas`) |
| `audit_logs_*` | `create: false` (solo servidor) | `js/clientes.js` L328, `js/oportunidades.js` L1026, `js/proyectos.js` L816, y `reportToManager`/`deleteProspect` del CRM |
| `users_*` | ya `write: false` en la propuesta | `js/auth.js` (6 `saveUserToDB`), `app.js` L271/L321, login de operarios por consulta a `users_*` en `operador.js` L262 (PIN) |
| `config`, `alertas_maquinas` | sin sufijo de entorno (compartidos local/prod) | Lecturas/escrituras de tablets y fabricación |

**No se modificó ni se exigió nada del flujo de operarios** (PIN y contraseña numérica intactos; no se exigen correos). Todo
lo anterior son **dependencias a resolver antes de activar reglas restrictivas en colecciones compartidas**:

1. Fabricación lee colecciones completas (`clients`, `prospects`, `users`) **sin autenticación** y escribe directamente; con
   reglas restrictivas dejaría de funcionar hasta que tenga sesión y rutas propias (o use los callables).
2. `system/settings` es **compartido**: el CRM solo toca 3 claves (con `merge`); fabricación reescribe el documento completo.
3. Fabricación crea oportunidades y clientes con su propio generador de códigos: puede **colisionar** con el contador
   transaccional de `createProspectAdmin` mientras ambos caminos coexistan.
4. Borrado de oportunidad con cascada en `proyectos_fabricacion`: decidir si pasa a un callable que haga ambas cosas.
5. Operarios (`operador.html`): login por PIN consultando `users_*` sin sesión Firebase; decidir un modelo de identidad de
   planta antes de cerrar `users_*` (sin inventar equivalencias de rol).
6. Colecciones sin sufijo (`config`, `alertas_maquinas`): lo que se pruebe en local afecta al mismo documento que producción.

## 6. Qué falta antes de una validación conjunta y un despliegue controlado

> **Actualización (2026-10-16, validación conjunta):** la validación conjunta CRM + fabricación se ejecutó en el entorno aislado y
> está en [JOINT_VALIDATION.md](JOINT_VALIDATION.md): matriz de permisos medida, rutas de Storage, escrituras directas pendientes,
> incompatibilidades priorizadas y plan por etapas. Resultado: **no son compatibles con las reglas candidatas actuales** (tabletas sin sesión,
> rutas planas de Storage, listeners sin filtro). Las reglas siguen sin cambios y sin desplegar.

Hecho en esta fase: Java/CLI usados vía `npx`, suites de reglas y emuladores ejecutadas, flujo extremo a extremo de los callables
comerciales, migración de las escrituras de oportunidades, retirada de la migración automática de localStorage, del bypass por
contraseña y de `reportToManager`. Pendiente:

1. **Decisiones funcionales (bloqueos):**
   * ~~Precio/costo base~~, ~~solicitud de venta sin contrato~~, ~~edición de nombre/rol~~ y ~~borrado de oportunidad~~:
     **decididos e implementados** (§7). Quedan las decisiones adicionales de §7.5.
   * Primer gerente de un proyecto vacío y si se importará localStorage a un proyecto real.
   * Recuperación / consulta administrativa de oportunidades eliminadas: **no definida** (quién la usaría); no se implementó.
2. Alinear los claims de `createUserAdmin` con las reglas (`cid`, `manager: true`): cambio de claims, requiere autorización.
3. Migrar los usuarios históricos a Firebase Auth (sin ello **todas** las operaciones migradas les devuelven "sin sesión" y no se
   puede publicar esta interfaz) y con ello las escrituras de `saveUserToDB` que siguen para históricos.
4. Resolver con fabricación las dependencias de §5 y probar **juntas** ambas aplicaciones contra las reglas candidatas.
5. Redactar y validar las reglas candidatas (las vigentes no se cambiaron): hasta entonces las reglas siguen permitiendo escrituras
   directas desde la consola; `firestore.rules` y `storage.rules` se despliegan solo tal como fueron probadas.
6. Storage: `storage.rules` (propuesta) espera `prod_files/prospects/{pid}/{carpeta}/{archivo}`, pero el CRM sube a
   `${STORAGE_PREFIX}/{carpeta}/…` (plano). Incompatibilidad por resolver antes de activar esas reglas.
7. Cliente: dar visibilidad al gerente de `commercialAudit_*` (hoy sin pantalla).

## 7. Fase de decisiones funcionales (2026-10-16): precio base, venta sin contrato, usuarios, eliminación lógica

> Todo implementado **localmente**, sin desplegar, sin commit, sin tocar `firestore.rules` / `storage.rules`, sin tocar
> `fabricacion-dev`, sin migrar usuarios históricos y sin cambiar datos ni claims de producción. Las protecciones descritas son de
> **servidor (Cloud Functions)**; mientras las reglas compartidas permitan escrituras directas, un usuario con la consola del
> navegador sigue pudiendo escribir en Firestore (ver §2, punto 3): estas funciones son la única vía **de la interfaz**, no un
> cierre de la base de datos.

### 7.1 Precio y costo base (`editProspectBasePriceAdmin`)

* Solo `manager` y `gestor` (`POLICY.editBasePrice`). El vendedor, aunque sea el creador, recibe `permission-denied`. En la interfaz
  el enlace de editar solo se muestra a manager/gestor con la oportunidad `activo`, y se retiró el enlace de la vista de ganadas.
* Solo si el `estado` **almacenado** es `activo`; si no (`ganado`, `perdido`) → `failed-precondition` "solo pueden corregirse antes
  del cierre". El estado se lee dentro de la transacción: una corrección que compite con el cierre o gana (y entonces el cierre ve el
  precio nuevo) o pierde (rechazada); no hay forma de editar tras el cierre.
* **Efecto sobre cotizaciones y anticipos (documentado, comportamiento de cálculo sin cambios):** la factura de anticipo se calcula **en el
  cierre** a partir del `precio_cotizado` almacenado (subtotal × 1,13 salvo exportación × porcentaje de anticipo). Por eso una corrección
  **antes** del cierre cambia el anticipo futuro (prueba: 8 000 × 1,13 × 70 % = 6 328 en lugar de 7 910). Tras el cierre la edición se
  rechaza, así que **nunca se recalculan** facturas, abonos ni órdenes de cambio ya emitidos. `registerProposalAdmin` (negociación) sigue
  siendo el otro camino previo al cierre para cambiar precio/costo. La corrección conserva `motivo` obligatorio, valores anterior/nuevo
  y entrada de historial + auditoría `editBasePrice`.

### 7.2 Autorización de venta sin contrato: solicitud y resolución

Estado guardado en la oportunidad: `solicitudes_sin_contrato: [{id, estado, solicitante_id, solicitante_nombre, solicitante_rol,
fecha_solicitud, motivo, resuelto_por_id, resuelto_por, fecha_resolucion, motivo_decision, opId}]`; `estado` ∈ `pendiente | aprobada |
rechazada | revocada` (máximo 30 solicitudes por oportunidad).

| Transición | Quién | Reglas del servidor |
|---|---|---|
| `requestNoContractAuthorizationAdmin` → `pendiente` | vendedor/gestor con acceso (un gerente es rechazado: autoriza directo) | motivo obligatorio ≤ 500; solicitante, rol y fecha salen de la sesión; solo oportunidad `activo` y aún sin autorizar; una sola pendiente; reintento con el mismo `opId` o doble clic (misma persona y motivo) → sin duplicar; otro motivo mientras hay una pendiente → `failed-precondition` |
| `resolveNoContractAuthorizationAdmin` `approve` → `aprobada` | **solo manager**, comprobado en vivo; **nunca el solicitante** | escribe `datos.autorizado_sin_contrato/_por/_por_id` (los mismos campos que el cierre ya lee); requiere `activo`; repetir la misma aprobación → `unchanged` |
| ídem `reject` → `rechazada` | solo manager | motivo de la decisión obligatorio; tras el rechazo el vendedor puede pedir de nuevo |
| `setNoContractAuthorizationAdmin` (existente) | solo manager | si concede, la solicitud pendiente pasa a `aprobada` ("Autorización directa del gerente"); si revoca, la aprobada pasa a `revocada` |

La lectura y escritura son **una transacción sobre el documento**: se decide por el estado almacenado en ese instante, así que dos
aprobaciones simultáneas producen **una** aprobación y N-1 `unchanged`, y una decisión contradictoria o tardía falla. El vendedor no puede
enviar `autorizado_*`, estado, solicitante ni fechas (la función solo lee `prospectId`, `motivo`, `opId`; probado también que campos
falsificados se ignoran). Cada transición escribe auditoría: `requestNoContractAuthorization`, `approveNoContractRequest`,
`rejectNoContractRequest` (y las existentes de concesión/revocación), más una entrada en el historial de la oportunidad. **Compatibilidad
con el cierre:** el cierre sigue leyendo únicamente `datos.autorizado_sin_contrato === true` almacenado; esa regla no cambió.

Limitación: con las reglas actuales (propuestas, no desplegadas) el dueño de una oportunidad aún podría escribir directamente el
campo `solicitudes_sin_contrato` desde la consola; una solicitud falsificada **no tiene efecto** porque solo `datos.autorizado_*`
(protegido) habilita el cierre, y el gerente resuelve contra el contenido almacenado, pero el historial de solicitudes no será
inalterable hasta endurecer las reglas.

### 7.3 Usuarios vinculados a Firebase Auth (`updateUserAdmin`, `toggleUserStatusAdmin`)

* **`updateUserAdmin` `{id, nombre?, role?, opId}`** (nueva; `id` = id comercial, no el `uid`). Cualquier otro campo (`activo`, `authUid`,
  `password`, `email`, `claims`…) → `invalid-argument` antes de leer nada. Roles asignables: **solo `vendedor` y `gestor`**; `manager`
  y los roles de planta → `permission-denied` (el código no concede `manager` en ningún caso; ascender a gerente sigue siendo una
  acción manual del propietario). Perfiles históricos (sin `authUid`) → `failed-precondition`, sin tocar nada.
* **Autorización en vivo:** claim `manager === true` leído de Auth en cada llamada (no del token), cuenta no deshabilitada y perfil
  activo; para cambios de rol se **reverifica dentro del bloqueo global** `role.change.global` (colección `userOpsLocks*`, TTL 2 min).
  Un gerente degradado cuyo token sigue siendo válido queda rechazado de inmediato (probado con tokens reales en el emulador).
* **Sin autoprivilegio ni último gerente:** nadie cambia su propio rol (`permission-denied`; sí puede editar su nombre). Como quien
  llama es siempre un gerente vivo distinto del objetivo, degradar a **otro** gerente nunca deja el sistema sin gerente; dos gerentes
  que se degradan mutuamente a la vez se serializan con el bloqueo (gana uno, el otro recibe `already-exists` o `permission-denied`;
  probado con concurrencia real: siempre queda exactamente un gerente). `toggleUserStatusAdmin` sigue rechazando cuentas de gerente y la
  propia (para desactivar a un gerente hay que degradarlo antes).
* **Coherencia Auth ↔ Firestore:** orden fijo: (1) claims de Auth (la reducción de privilegio entra primero) = los existentes
  menos `manager` más `{role, cid}`; (2) perfil + auditoría en **una** transacción, solo si el perfil sigue siendo el validado
  (si cambió → `aborted`); (3) `revokeRefreshTokens` (mejor esfuerzo, el resultado trae `sessionsRevoked`). Si falla (2) se restauran
  los claims anteriores; si la restauración también falla la operación queda en `manualReview` y el llamador recibe
  `failed-precondition`. **Nunca se devuelve éxito para un cambio a medias.** `opId` idempotente (huella de `{id,nombre,role}` + gerente
  solicitante; repetición completada devuelve el resultado guardado; `manualReview` bloquea reintentos; mismo `opId` con otro cuerpo →
  `already-exists`); sin cambios reales → `unchanged` sin auditoría; un rol igual con claims sin `cid` se repara y cuenta como cambio.
* **Auditoría** (`commercialAudit*`, solo servidor): `updateUser` / `toggleUserStatus` con `detail.before` y `detail.after` (nombre, rol,
  activo, resumen de claims `{role, cid, manager}`), actor (uid, cid, nombre, rol) y `opId`. **Nunca** correo, contraseña ni tokens
  (hay pruebas que lo comprueban). `toggleUserStatusAdmin` ahora escribe perfil y auditoría en una transacción y, si falla, devuelve la
  cuenta de Auth al estado previo.
* No se migró ningún usuario histórico ni se cambió ningún claim existente; `createUserAdmin` no se modificó (sigue asignando solo
  `{role}`; `updateUserAdmin` escribe `{role, cid}`, de modo que editar a un usuario también alinea sus claims con lo que esperan las reglas
  candidatas, pero solo cuando un gerente lo ejecuta explícitamente). Sin correos ficticios; el acceso de operarios por PIN no se tocó.

### 7.4 Eliminación lógica de oportunidades (`deleteProspectAdmin`)

* Solo gerente (en vivo); `motivo` obligatorio (≤ 300). Marca `eliminado: true`, `eliminado_por_id`, `eliminado_por`, `fecha_eliminacion`,
  `motivo_eliminacion`, añade una entrada al historial, escribe auditoría `deleteProspect` (`detail.logical: true`) y el aviso del panel
  con el motivo. El primer registro de eliminación **no se sobrescribe** (repetir → `unchanged`).
* **No hay cascada:** no se tocan facturas, abonos, órdenes, archivos de Storage, `proyectos_fabricacion` ni el cliente.
* **Listados y operaciones:** el listener de oportunidades del CRM omite `eliminado === true`; `clientsService` (cartera / `visibleTo`) ignora las
  eliminadas. Toda operación normal (avanzar, perder, precio, facturas, abonos, notas, reasignar, autorizar, solicitar) sobre una
  oportunidad eliminada devuelve `not-found` "La oportunidad fue eliminada" (probado con vendedor dueño, gestor y gerente).
* **Recuperación/consulta administrativa: no implementada** (no está definido quién la usaría).
* Efecto cruzado a revisar: `fabricacion-dev` **no conoce** `eliminado` y sigue leyendo `prospects`, así que una oportunidad eliminada lógicamente
  **seguirá apareciendo en fabricación** (antes desaparecía con el borrado físico). No se modificó fabricación; ver §7.6.

### 7.5 Reactivación de oportunidades comerciales perdidas (`reactivateLostProspectAdmin`)

* **Autorización en el servidor:** Solo gerente verificado en vivo (`requireManager(caller, 'reactivar proyectos')`). Vendedores, gestores o usuarios inactivos son rechazados con `permission-denied`.
* **Validación de estado:** Comprobación estricta en Firestore. Solo se pueden reactivar oportunidades con `estado === 'perdido'` y `eliminado !== true`. Proyectos activos, ganados o eliminados lógicamente son rechazados con `failed-precondition`.
* **Restauración de etapa comercial previa:** En el sistema comercial, al marcar una pérdida (`markProspectLostAdmin`), `etapa` no se sobreescribe (se mantiene la etapa en que se encontraba la oportunidad). La reactivación restaura esta etapa validada. Si la etapa fuera desconocida o corrupta, consulta cronológicamente el último valor registrado en `stage_timestamps` (o fallback a `'prospecto'`), documentando la razón.
* **Preservación y aislamiento del historial de pérdida:**
  - El motivo y fecha de pérdida anteriores se archivan en `historial_perdidas` (array) y en `ultima_perdida` (objeto).
  - Los campos raíz `motivo_perdida` y `fecha_perdida` se eliminan atómicamente con `FieldValue.delete()` para evitar que consultas analíticas o tableros de control sigan contabilizando simultáneamente el proyecto como perdido y activo.
* **Auditoría e integridad:**
  - Registra `reactivado_por_id`, `reactivado_por`, `fecha_reactivacion`, `motivo_reactivacion` y un mensaje detallado en `logs`.
  - `createdBy` original y demás campos comerciales (documentos, propuestas, órdenes, facturas) permanecen estrictamente inmutables.
  - Se genera registro en `commercialAudit_*` con la acción `reactivateProspect`.
* **Sincronización de visibilidad y closingVendors:**
  - Dentro de la misma transacción (cumpliendo la regla de que todas las lecturas preceden a las escrituras en Firestore), se asegura que el vendedor asignado, el creador y el gerente queden en `clients_*.visibleTo`.
  - Si la etapa restaurada es `'cierre'`, se agrega de nuevo el vendedor asignado a `clients_*.closingVendors` mediante `FieldValue.arrayUnion`.
* **Idempotencia:** Reintentar la operación con el mismo motivo devuelve `{ status: 'unchanged', estado: 'activo', etapa }` sin alterar el documento ni duplicar registros de auditoría.

### 7.6 Limitaciones y decisiones adicionales pendientes

1. `deleteClientAdmin` sigue bloqueando el borrado de un cliente mientras **cualquier** oportunidad lo referencie, incluidas las eliminadas
   lógicamente (decidir si deben contar).
2. Ascender a `manager` y reactivar/desactivar gerentes: sin función (manual del propietario).
3. Qué debe hacer fabricación con oportunidades `eliminado === true` (ocultarlas) y si el borrado lógico debe cascadear algo allí.
4. Quién (si alguien) podrá restaurar o consultar oportunidades eliminadas.
5. `solicitudes_sin_contrato` y `eliminado*` solo serán inalterables desde el navegador cuando se endurezcan las reglas (excluido en esta fase).
6. Las notificaciones al gerente son por estado: el gerente ve la solicitud pendiente en la oportunidad; no hay aviso push/correo.

### 7.7 Modelo definitivo de permisos comerciales y cierre de seguridad (SEC-04 / SEC-06)

Implementado y verificado el modelo estricto de tres perfiles para resolver definitivamente las brechas de permisos comerciales:

#### 1. Matriz de permisos por perfil y operación

| Operación | Gerente (`manager`) | Gestor (`gestor`) | Vendedor (`vendedor`) | Justificación / Mecanismo de seguridad |
|---|---|---|---|---|
| **Consultar oportunidades (Leads ordinarios)** | Todas | Solo los que ingresó originalmente (`createdBy == me`) | Solo asignados (`vendedorId == me`) o propios | Aislamiento horizontal estricto en Firestore Rules (`allow list/get`) y `canAccessProspect`. |
| **Consultar «Proyectos y cobros» (Postcierre)** | Todos | Proyectos que entraron válidamente a postcierre (`hasEnteredPostclosing`) | **PROHIBIDO** | Vendedores denegados en UI (menú, rutas, vistas), Firestore rules y funciones backend. |
| **Crear oportunidad** | Sí (puede asignar a cualquier vendedor) | Sí (puede asignar a vendedor o gestionar él mismo) | Sí (solo a su propio nombre) | Asignación a terceros en creación requiere rol privilegiado (`manager`/`gestor`). |
| **Avanzar etapa (prospecto→levantamiento→cotización→negociación→cierre)** | Sí | Solo en sus propios leads | Solo en leads asignados a su cargo | Vendedores no pueden modificar oportunidades ajenas; gestores no pueden alterar leads de vendedores. |
| **Reasignar oportunidad (`reassign`)** | **Exclusivo (solo manager)** | **Prohibido** | **Prohibido** | Backend valida identidad en vivo con `requireManager(caller, 'reasignar oportunidades')`. |
| **Editar precio base (`editBasePrice`)** | Sí (proyectos activos antes del cierre) | Sí (solo en leads creados por él) | **Prohibido** | Política comercial: los vendedores no pueden alterar precios base fuera del flujo de cotización. |
| **Operaciones postcierre (facturas, pagos, órdenes de cambio)** | Sí | Sí (en expedientes con postcierre habilitado) | **Prohibido** | `POLICY` restringe a `['manager', 'gestor']`. Verificación en backend de `hasEnteredPostclosing`. |
| **Reactivar proyectos perdidos (`reactivateLostProspect`)** | **Exclusivo (solo manager)** | **Prohibido** | **Prohibido** | Backend valida con `requireManager`. |
| **Eliminar oportunidad lógicamente (`deleteProspect`)** | **Exclusivo (solo manager)** | **Prohibido** | **Prohibido** | Backend valida con `requireManager`. |
| **Ajustes y Configuración (`updateSettings`)** | **Exclusivo (solo manager)** | **Prohibido** | **Prohibido** | Backend valida con `requireManager`. |

#### 2. Separación entre atribución original y responsable actual

- **Atribución de comisiones inmutable:** `createdBy` representa al creador original del lead y **permanece estrictamente inmutable** a lo largo de todo el ciclo de vida del expediente. Ninguna operación comercial ni reasignación puede alterar `createdBy`.
- **Responsable operativo actual:** `vendedorId` representa al responsable comercial operativo actual de la venta.
- **Autoridad de reasignación:** Solo un gerente verificado en vivo puede reasignar un lead (`reassignProspectAdmin`). Gestores y vendedores que intenten reasignar son rechazados con `permission-denied`.
- **Recálculo transaccional de visibilidad en clientes:**
  - Al reasignar, el nuevo vendedor (`target.cid`) se agrega a `clients.visibleTo` (y a `clients.closingVendors` si la oportunidad está en etapa `cierre`).
  - El vendedor anterior (`oldVendor`) se remueve de `clients.visibleTo` **si y solo si** no es el creador del cliente (`oldVendor !== client.createdBy`) y no conserva ninguna otra oportunidad activa o no eliminada vinculada a dicho cliente.
  - El vendedor anterior se remueve de `clients.closingVendors` si no conserva ninguna otra oportunidad en etapa `cierre`.
  - El cálculo se ejecuta atómicamente dentro de la transacción de reasignación.
- **Historial y auditoría:** Cada reasignación registra en el historial del expediente quién autorizó la reasignación, el responsable anterior, el nuevo y la fecha (`logs`). Adicionalmente, escribe en `commercialAudit_*` un evento con `action: 'reassignProspect'` registrando `from`, `to`, `authorizedBy` y fecha del servidor.

#### 3. Acceso persistente a «Proyectos y cobros» (Postcierre)

- **Criterio de entrada:** Una oportunidad ingresa válidamente a postcierre cuando completa la transición a la etapa `cierre` cumpliendo todos los requisitos contractuales y de facturación de anticipo.
- **Marcador persistente (`postcierre_habilitado`):**
  - Al avanzar exitosamente a la etapa `cierre`, el servidor estampa de manera irreversible:
    ```javascript
    patch.postcierre_habilitado = true;
    patch.fecha_postcierre = at;
    ```
- **Helper canónico (`hasEnteredPostclosing`):**
  Reutiliza de forma determinista tanto el nuevo marcador persistente como los indicadores históricos equivalentes:
  ```javascript
  function hasEnteredPostclosing(p) {
    if (!p || typeof p !== 'object') return false;
    return p.postcierre_habilitado === true
      || (typeof p.fecha_cierre === 'string' && p.fecha_cierre.length > 0)
      || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre)
      || (Array.isArray(p.facturas) && p.facturas.length > 0);
  }
  ```
- **Persistencia ante cambios de estado posteriores:**
  Una vez que un proyecto tiene habilitado el postcierre, el gestor conserva acceso a «Proyectos y cobros» para consultar el expediente y registrar pagos o ajustes, **incluso si el proyecto pasa posteriormente a estado `perdido` o es cancelado**.
- **No dependencia de `estado: 'ganado'` en cliente:** El acceso no depende de una bandera mutable enviada por el navegador, sino de la verificación server-side de `hasEnteredPostclosing(p)`.

#### 4. Procedimiento de migración histórica para `postcierre_habilitado` (Solo Documentación — No ejecutar en producción)

Si en el futuro se requiriera unificar formalmente el campo `postcierre_habilitado` en todos los documentos históricos de `prospects_prod`, el procedimiento idempotente es:
1. **Fase de simulación obligatoria:** Ejecutar en modo solo lectura (`dry-run`) identificando proyectos que cumplen `hasEnteredPostclosing(p) === true` pero carecen de `postcierre_habilitado: true`.
2. **Procesamiento por lotes (`batch` ≤ 250 docs):** Escribir `{ postcierre_habilitado: true, fecha_postcierre: p.fecha_cierre || p.stage_timestamps?.cierre || p.fecha_creacion }` únicamente en los documentos identificados.
3. **Inmutabilidad de campos comerciales:** Ningún otro campo (`createdBy`, `vendedorId`, importes, facturas) debe ser modificado.
4. **Reversibilidad y registro:** Almacenar el registro de cambios previo/posterior en una colección de migración.
> **Importante:** Conforme a las restricciones de seguridad del proyecto, este procedimiento queda únicamente documentado y **no se ejecuta en producción**.
