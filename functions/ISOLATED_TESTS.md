# Pruebas con emuladores aislados

Las instrucciones están en [CLIENT_CATALOG_AND_DEDUPE.md](CLIENT_CATALOG_AND_DEDUPE.md), sección 6.

Resumen:

1. `firebase emulators:start --config firebase.isolated-emulator.json --project demo-ductsal-isolated --only auth,firestore,storage,functions`
   (puertos Auth 9399, Firestore 8190, Storage 9290, Functions 5101; el emulador de desarrollo usa 9099 / 8080 / 5001 y
   no se toca).
2. `cd functions && npx jest -c jest.isolated.config.js --runInBand`

Suites (`isolated-tests/*.iso.js`):

| Archivo | Qué prueba | Contra qué |
|---|---|---|
| `firestore.rules.iso.js` | `firestore.rules` real: identidades, usuarios, clientes, oportunidades, fabricación | Emulador Firestore (REST, tokens sin firmar del emulador) |
| `storage.rules.iso.js` | `storage.rules` real: leer / subir / sobrescribir / borrar / listar | Emuladores Storage + Firestore |
| `clientsService.iso.js` | duplicados, concurrencia, reintentos, históricos, búsqueda, `visibleTo` | Firestore real (Admin SDK) |
| `functionsCallables.iso.js` | flujo completo con cuentas Auth y claims reales, callables, trigger y reglas | Auth + Firestore + Functions |
| `commercialService.iso.js` | operaciones comerciales (oportunidades, notas, reasignación, autorización sin contrato, ajustes, borrado de cliente): la **misma suite** que la capa unitaria, con transacciones y contención reales | Firestore real (Admin SDK) |
| `prospectWorkflow.iso.js` | flujo de la oportunidad (etapas, cierre, facturas, abonos, órdenes de cambio, borrados): la **misma suite** que la capa unitaria, con transacciones y contención reales | Firestore real (Admin SDK) |
| `legacyImport.iso.js` | importador explícito de localStorage (simulacro, solo crea, idempotente, conflictos) | Firestore real (Admin SDK) |
| `commercialFlow.e2e.iso.js` | flujo comercial completo con cuentas Auth y claims reales por HTTP: callables + auditoría + reglas; precio base (roles/estado), solicitud y resolución de venta sin contrato (identidades, estados, concurrencia), eliminación lógica | Auth + Functions + Firestore |
| `userAdmin.e2e.iso.js` | `updateUserAdmin` / `toggleUserStatusAdmin` por HTTP con claims reales: roles, autoprivilegio, último gerente, bloqueo global, idempotencia, auditoría | Auth + Functions + Firestore |
| `jointValidation.iso.js` | validación **conjunta CRM + fabricación** (solo diagnóstico, sin cambiar reglas): reproducción de las escrituras directas de ambos módulos, matriz de permisos 44 operaciones × 10 sesiones contra las reglas candidatas, rutas de Storage reales vs. previstas, escenario integrado, códigos/concurrencia y aislamiento de tabletas. Las pruebas "KNOWN GAP" afirman el comportamiento defectuoso actual. Informe: [JOINT_VALIDATION.md](JOINT_VALIDATION.md). Con `JOINT_MATRIX_OUT=<ruta>` exporta la matriz medida en JSON | Auth + Functions + Firestore + Storage |
| `storageTokenRevocation.iso.js` | revocación de tokens de descarga de Storage (delete_token), retención de metadatos personalizados y rollback (SEC-08) | Emulador Storage (REST) |
| `sec10HorizontalIsolation.iso.js` | aislamiento horizontal E2E de documentos (SEC-10): vendedores, gestor, reasignación, perfiles inactivos y no-emisión de URLs firmadas | Auth + Firestore + Storage + Functions |

Los tokens sin firmar solo los aceptan los emuladores. No se usa ninguna credencial ni dato de producción.

## Estado de ejecución (2026-10-16)

Requisitos: JDK 21 (en esta máquina: `/Users/Benjamin/.local/jdk/jdk-21.0.12.1+1/Contents/Home`, fuera del PATH) y Firebase CLI
(se usó `npx -y firebase-tools@latest`, v15.34.0; no está instalado globalmente). Arranque:
`env JAVA_HOME=<jdk> PATH=<jdk>/bin:$PATH npx -y firebase-tools@latest emulators:start --config firebase.isolated-emulator.json --project demo-ductsal-isolated --only auth,firestore,storage,functions`.

| Capa | Estado |
|---|---|
| Unitaria (`npx jest`, sin emuladores; Firestore y DOM simulados) | **Ejecutada: 26 suites / 933 pruebas, 0 fallos** (incluye `jointInventory.unit.test.js`, inspección estática de ambos repositorios; antes 25 / 919) (ver [COMMERCIAL_OPERATIONS.md](COMMERCIAL_OPERATIONS.md) §4.1 y §7) |
| Emuladores, incluidas las reglas de Firestore y Storage (`npx jest -c jest.isolated.config.js --runInBand`) | **Ejecutada: 10 suites / 567 pruebas, 0 fallos** (antes 9 / 467; +100 de `jointValidation.iso.js`), con `firestore.rules` y `storage.rules` sin cambios |

Nota: una primera pasada falló una prueba de `firestore.rules.iso.js` por una carrera en su semilla (el disparador
`syncClientVisibility` recalcula `C1.visibleTo`); se corrigió la semilla, no las reglas. Detalle en `COMMERCIAL_OPERATIONS.md` §4.2.

Nota (validación conjunta): en `clientsService.iso.js` la prueba de relleno histórico (`backfillVisibility`) competía con el disparador
`syncClientVisibility_local` del emulador de Functions (rellenaba `visibleTo` antes del relleno). Se corrigió la prueba esperando al disparador y
devolviendo el cliente a su estado histórico; el servicio y las reglas no se tocaron. La suite conjunta carga las reglas abiertas solo en su
bloque A y vuelve a cargar `firestore.rules` sin cambios antes de seguir; las demás suites cargan sus propias reglas en `beforeAll`.
