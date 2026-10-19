# Catálogo global de clientes, prevención de duplicados y reglas de seguridad

Estado: **desarrollo local, nada desplegado**. Todo lo descrito se probó solo en emuladores aislados
(proyecto `demo-ductsal-isolated`, puertos 9399 / 8190 / 9290 / 5101) y con pruebas unitarias.
Las reglas (`firestore.rules`, `storage.rules`) son una **propuesta**: no están publicadas.

## 1. Comportamiento comercial implementado

| Pieza | Criterio | Dónde |
|---|---|---|
| **Selector de nuevas oportunidades** (vendedor) | TODO el catálogo, búsqueda en el servidor (`searchClientsCatalog`): id, nombre, tipo y pista enmascarada (`NIT ····1234`) + si ya está en su cartera. Mínimo 2 letras o 4 dígitos, máx. 20 (tope 50). | `functions/clientsService.js` `search`, `crm_clients.js`, `app_core.js` `renderClientSelect` |
| **Listado de Clientes** (vendedor) | `createdBy == mi id` **o** cliente referenciado (`clientId`) por una oportunidad cuyo `createdBy`/`vendedorId` soy yo. | `app_core.js` `getVisibleClients` (sin cambios de criterio) |
| Gerente / gestor | Catálogo y listado globales, como antes. | `app_core.js` (lista local completa) |

Son **funciones distintas a propósito** (hay una prueba estática que lo exige). Elegir un cliente existente no crea
otro cliente, no cambia `createdBy` y la oportunidad conserva su `createdBy`/`vendedorId`/`clientId`.

Cartera = `clients.visibleTo` (campo derivado: ids de quienes crearon o tienen asignada una oportunidad del cliente,
sin `'sistema'`). Lo mantiene el trigger `syncClientVisibility_<sufijo>` (Admin SDK); las reglas prohíben que ningún
cliente lo escriba. `createdBy` histórico nunca se toca.

## 2. Prevención de duplicados (servidor)

* **Esquema real** (inspeccionado): `tipo` = `natural` | `juridica`. Natural: `dui`, `nit`. Jurídica: `nit`, `nrc`,
  `dui_rep`, `nit_rep`. Todos opcionales (no se inventó ningún requisito).
* **Claves** (`functions/clientIdentity.js`): NIT (14 o 9 dígitos; 13/8 se rellenan con un 0) para cualquier cliente;
  DUI (9 dígitos; 8 se rellena) **solo** para persona natural. `dui_rep`, `nit_rep`, `nrc` nunca son claves.
  NIT y DUI no son intercambiables: mismos dígitos en el otro campo → solo advertencia de revisión.
* **Niveles**: `exact` (mismo NIT/DUI normalizado) → bloquea, no se puede forzar; `review` (nombre igual/parecido,
  o dígitos en el campo contrario) → advierte y el usuario confirma; `info` (solo teléfono/correo) → no pide nada.
* **Atomicidad**: `createClientAdmin` hace (1) lectura de los clientes existentes (cubre históricos no indexados) y
  (2) una transacción que reclama `clientIdentifiers_<sufijo>/{NIT_x|DUI_x}` y crea el cliente en el mismo commit.
  Dos peticiones simultáneas con el mismo documento: solo una crea (probado con 8 y 4 llamadas concurrentes,
  incluida la prueba end-to-end con tokens reales). Una entrada de índice huérfana (cliente borrado) se recupera.
* **Reintentos**: `opId` obligatorio (8–100 caracteres) registrado en `clientOps_<sufijo>` con hash del contenido:
  mismo opId+datos → mismo cliente sin escribir nada nuevo; mismos opId con otros datos → `failed-precondition`;
  otro usuario → `permission-denied`.
* **Eludir el cliente**: las reglas tienen `clients_prod: create false` y no permiten cambiar `nit`, `dui`, `tipo`,
  `createdBy`, `visibleTo` por escritura directa; `clientIdentifiers*` y `clientOps*` están denegados a todos.
  El navegador solo recibe el veredicto; la respuesta de duplicado no incluye teléfono, correo, propietario ni
  documento completo.
* **Edición** (`updateClientAdmin`): reclama/libera claves en la misma transacción; un duplicado histórico en un
  documento que NO cambia no bloquea la edición (se degrada a revisión). No fusiona nada.

## 3. Duplicados históricos (informe + plan; NO se corrige nada)

Informe de solo lectura: `node functions/scripts/detectDuplicateClients.js --input clientes.json --out informe.md`
(`clientes.json` = exportación hecha por una persona autorizada; el script no se conecta a producción). También
`--emulator`. La salida es enmascarada. Hallazgos reales: **pendiente de ejecutar sobre la exportación de producción**
(no se copiaron datos reales a los emuladores).

Plan de resolución propuesto (requiere autorización humana):
1. Exportar `clients_prod` + `prospects_prod` (lectura) y generar el informe.
2. Revisión manual por grupo: elegir cliente canónico; verificar que las oportunidades no se rompen.
3. Fusión **manual y reversible** mediante una función de gerente (aún no existe): reasigna `clientId` de las
   oportunidades del duplicado al canónico, deja el duplicado marcado `mergedInto` (no se borra), registra auditoría.
4. Solo cuando no queden duplicados exactos: `backfillClientIdentifiers` (pendiente) puebla el índice
   (`backfillVisibility` ya existe en el servicio y es *dry-run* por defecto).
5. Hasta entonces el servidor ya bloquea nuevos duplicados (escaneo completo en cada alta).

## 4. Reglas: «lo probado es lo desplegado»

`firestore.rules` y `storage.rules` de la raíz son los archivos que cargan las pruebas, byte a byte.
Sesión válida = claims `cid` + `role` **y** perfil `users_prod/{cid}` con el mismo `authUid`, `activo == true`, mismo
`role`; gerente además `manager == true`. Un perfil histórico sin `authUid`, un inactivo, un rol obsoleto en el claim
o un `cid` ajeno no obtienen nada. Todo lo no listado (incl. `*_local`, colecciones sin sufijo, `userOps*`) está denegado.

### Hallazgos que BLOQUEAN un despliegue (no resueltos)

1. **Falta el claim `cid`.** `createUserAdmin` asigna solo `{ role }`; las reglas exigen `cid`. Ningún usuario actual
   lo tiene. Opciones: (a) asignar `{role, cid}` tras crear el perfil + migración puntual de claims de usuarios
   existentes; (b) índice `authLinks_prod/{authUid} → cid` leído por las reglas. Requiere decisión y producción.
2. **El CRM descarga colecciones completas** (`onSnapshot` de clients/prospects/users). Con reglas restrictivas hay
   que migrar a consultas filtradas (`createdBy ==`, `visibleTo array-contains`, `vendedorId ==`...). Las reglas ya
   las permiten; el cambio de `app_core.js` **no está hecho**.
3. **Login histórico**: usuarios sin `authUid` no tienen sesión Firebase → no pueden usar los callables ni las reglas.
   Mientras tanto `saveClient` les muestra un mensaje (no hay escritura directa de reserva). Necesita estrategia de
   migración aprobada (no se tocaron contraseñas ni usuarios).
4. **Storage**: las reglas esperan rutas `prod_files/prospects/{id}/{carpeta}/…` y `prod_files/clients/{cid}/…`, pero
   `uploadFileToStorage` sube a `prod_files/<carpeta>/<ts>_<nombre>` (plano). Con estas reglas las subidas de
   vendedores serían rechazadas hasta cambiar las rutas. Además `getDownloadURL` con token ignora las reglas: los
   enlaces ya guardados siguen siendo públicos para quien los tenga hasta rotar tokens.
   Limitación del emulador: toda subida se evalúa como `create`; por eso las reglas añaden `resource == null`.
5. **Fabricación / tablets** (ver §5).
6. Escrituras que siguen siendo directas desde el navegador (permitidas por reglas, con propiedad): oportunidades,
   `audit_logs` (el campo `usuario` es falsificable), `system` (visibles/encargados), borrado de clientes/oportunidades
   por gerente (sin limpieza de Storage ni índice). Objetivo: callables.

## 5. Fabricación y tablets (`fabricacion-dev`, `operador.html`) – inspección y diseño

* Es una copia del CRM: usa las mismas colecciones compartidas (`clients*`, `prospects*`, `users*`, `system*`,
  `audit_logs*`) más `fabricacion*`, `fabricacion_tasks*`, `proyectos_fabricacion*`, `bobinas_soldadura*` y, **sin
  sufijo de entorno**, `config` y `alertas_maquinas` (compartidas entre local y producción).
* **No usa Firebase Authentication.** `operador.js` hace login consultando `users` desde el navegador y comparando
  `password`/`pin` en el cliente; `app.js` descarga clients/prospects/users completos y contiene su propia copia de
  `saveClientToDB`/`clientes.js`/`oportunidades.js` (escritura directa de clientes: saltaría la validación de duplicados
  y las reglas la rechazarían).
* Roles detectados en el código: `manager`, `gestor`, `vendedor`, `jefe_produccion`, `control_calidad`, `operario`,
  `despacho`, `recepcion`, `dibujante`, `encargado_armado`.
* Diseño de reglas incluido (a nivel de rol, sin acceso público): la planta no tiene acceso a clientes ni
  oportunidades; `operario` avanza tareas, reporta `config/estado_equipos` y crea alertas; solo jefe/gerente editan
  configuración y cierran alertas; el vendedor no ve fabricación (decisión pendiente si debe ver el estado de su venta).
  **Pruebas de reglas: aprobadas, pero el módulo no podrá usarlas hasta tener sesión Firebase para planta** (login
  por PIN → callable que emita sesión/claims, o cuentas Auth por operador). No se modificó `fabricacion-dev`.

## 6. Cómo ejecutar las pruebas

```
# unitarias (sin emuladores)
cd functions && npx jest

# aisladas (emuladores propios, puertos distintos del emulador de desarrollo)
export JAVA_HOME="$HOME/.local/jdk/jdk-21.0.12.1+1/Contents/Home"; export PATH="$JAVA_HOME/bin:$HOME/.local/bin:$PATH"
firebase emulators:start --config firebase.isolated-emulator.json --project demo-ductsal-isolated --only auth,firestore,storage,functions
cd functions && npx jest -c jest.isolated.config.js --runInBand
```

Las pruebas aisladas tienen los hosts fijos (127.0.0.1) y proyecto `demo-`; borran **solo** el emulador aislado.

## 7. Reversión

Todo es aditivo y sin desplegar. Para revertir en local: eliminar `crm_clients.js`, `firestore.rules`, `storage.rules`,
`firebase.isolated-emulator.json`, `functions/{clientsService,clientIdentity}.js`, `functions/isolated-tests/`,
`functions/jest.isolated.config.js`, `functions/scripts/detectDuplicateClients.js`, los tests nuevos de
`functions/__tests__/` y restaurar de `app_core.js` los bloques `persistClientViaServer` / selector de catálogo (volver a
`saveClientToDB(c)` y a `getVisibleClients()` en `renderClientSelect`), de `index.html` el cuadro de búsqueda y la
etiqueta `crm_clients.js`, y de `functions/index.js` el bloque final «Client catalogue».
Como no hay despliegue, no hay nada que revertir en producción. Si en el futuro se publican reglas, conservar las
actuales (`allow … if request.time < …`) en un archivo aparte para volver a ellas con `firebase deploy --only firestore:rules`.
