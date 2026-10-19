# Prueba de visibilidad por vendedor (C1, P1, P2) — procedimiento

Solo emulador `demo-ductsal-local` (Auth 9099, Firestore 8080, Functions 5001, todo en `127.0.0.1`).
El script de carga existe pero **no se ha ejecutado** (ni siquiera en `--dry-run`). Comandos desde la raíz del repositorio.

## Qué se crea

| Documento | Propietario (campo) | Notas |
|---|---|---|
| `clients_local/CTEST-VIS-C1` (C1) | `createdBy` = vendedor 1 | los clientes no tienen `vendedorId` en este CRM |
| `prospects_local/TEST-VIS-P1` (P1) | `createdBy` = `vendedorId` = vendedor 1 | `codigo: TEST-001`, `clientId` = C1 |
| `prospects_local/TEST-VIS-P2` (P2) | `createdBy` = `vendedorId` = vendedor 2 | `codigo: TEST-002`, `clientId` = C1 (a propósito) |

Los tres llevan `esDatoDePrueba: true` y `escenarioPrueba: "visibilidad-vendedores-v1"`.
- Vendedor 1: `vendedor.prueba@ductsal-test.invalid` (ya existe, se reutiliza).
- Vendedor 2: `vendedor.segundo@ductsal-test.invalid` (**se crea desde la interfaz**, nunca desde código).

## 1. Crear el vendedor 2 desde la interfaz del CRM (flujo ya probado)

1. Emuladores en marcha y comprobados: `node functions/scripts/manualE2E.js check`
2. Servidor local (terminal aparte): `node functions/scripts/serveLocalUI.js 8123`
3. Chrome (incógnito, DevTools abierto) en **exactamente** `http://127.0.0.1:8123/?emulators=demo-ductsal-local`.
   Comprueba la franja naranja `MODO EMULADORES` (detalle en `MANUAL_E2E.md`, sección 2). Si no está, no sigas.
4. Contraseña del gerente ficticio al portapapeles (no se imprime): `node functions/scripts/manualE2E.js manager-password`
   Login con `gerente.prueba@ductsal-test.invalid` y `⌘V`.
5. Usuarios → **+ Nuevo Usuario**: nombre `Vendedor Segundo`, correo `vendedor.segundo@ductsal-test.invalid`, rol **Vendedor** → Guardar.
   Esperado: alerta `Usuario creado. Se envió un correo a …` (el emulador no envía correo) y el usuario en la tabla.
6. Comprobar: `node functions/scripts/manualE2E.js verify vendedor.segundo@ductsal-test.invalid` → todo `[OK]`.
7. Contraseñas para iniciar sesión más tarde con cada vendedor (en la UI: **Reset Pass** de su fila, y luego en terminal;
   la contraseña va al portapapeles, no se imprime):
   ```
   node functions/scripts/manualE2E.js set-password vendedor.segundo@ductsal-test.invalid
   node functions/scripts/manualE2E.js set-password vendedor.prueba@ductsal-test.invalid
   ```
   (Cada `set-password` necesita un "Reset Pass" previo de ese usuario; copia otra cosa al portapapeles cuando termines.)

## 2. Revisar el script antes de ejecutarlo (no escribe nada)

```
cd functions
node --check scripts/seedVisibilityData.js                      # solo sintaxis, no se ejecuta
npx jest __tests__/seedVisibilityData.unit.test.js --runInBand   # 48 pruebas con un fetch simulado; sin red ni emuladores
cd ..
less functions/scripts/seedVisibilityData.js
```

## 3. Ejecución (SOLO tras tu visto bueno)

```
node functions/scripts/seedVisibilityData.js --dry-run    # comprueba todo y lista lo que crearía; no escribe (lee del emulador)
node functions/scripts/seedVisibilityData.js              # crea C1, P1 y P2 (solo crear, nunca sobrescribe)
node functions/scripts/seedVisibilityData.js              # repetirlo es inocuo: detecta los existentes y no escribe
```
Códigos de salida: 0 correcto, 1 abortado, 2 entorno inseguro o argumentos incorrectos.

El script **aborta sin escribir** si: el proyecto no es `demo-ductsal-local` (argumento o variables `GCLOUD_PROJECT`,
`GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `FIREBASE_CONFIG`); hay `GOOGLE_APPLICATION_CREDENTIALS`; el hub de emuladores no muestra
Auth/Firestore/Functions en `127.0.0.1` y los puertos 9099/8080/5001; falta el gerente semilla (Auth y `users_local`); falta el
vendedor 2 o alguno de los vendedores no es un `vendedor` activo vinculado por `authUid` con cuenta Auth habilitada;
`clients_local` o `prospects_local` contienen algún documento sin `esDatoDePrueba: true`; o alguno de los tres ids ya existe
con otro propietario o sin marca (se valida todo antes de la primera escritura). Solo escribe en `clients_local` y
`prospects_local`; no toca usuarios, Auth ni otras colecciones.

## 4. Comprobar los datos directamente (solo lectura)

```
curl -s -H 'Authorization: Bearer owner' "http://127.0.0.1:8080/v1/projects/demo-ductsal-local/databases/(default)/documents/clients_local"
curl -s -H 'Authorization: Bearer owner' "http://127.0.0.1:8080/v1/projects/demo-ductsal-local/databases/(default)/documents/prospects_local"
```

## 5. Verificar el filtrado en el navegador

Sesiones: vendedor 1, vendedor 2 y gerente (cerrando sesión entre una y otra). Visita **Oportunidades** y **Clientes**
y pega en la consola:

```js
JSON.stringify({
  sesion: currentUser.email, rol: currentUser.role,
  enMemoria: { prospects: prospects.length, clients: clients.length },
  filasOportunidades: [...document.querySelectorAll('#opp-table-body tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()),
  filasClientes: [...document.querySelectorAll('#clients-table-body tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim())
}, null, 1)
```

| Sesión | Oportunidades visibles | Clientes visibles | En memoria (prospects / clients) |
|---|---|---|---|
| vendedor 1 | P1 (`TEST-001`) | C1 | 2 / 1 |
| vendedor 2 | P2 (`TEST-002`) | ninguno | 2 / 1 |
| gerente | P1 y P2 | C1 | 2 / 1 |

Además, como vendedor 2: **Nueva Oportunidad** no debe ofrecer C1 en el selector de cliente.
La columna "En memoria" muestra que el filtro es solo de presentación (la app descarga las colecciones completas); es el
comportamiento actual del código y no se modifica en esta fase. No hay reglas de Firestore en el repositorio.

## 6. Limpieza

```
node functions/scripts/seedVisibilityData.js --cleanup --dry-run   # lista lo que borraría
node functions/scripts/seedVisibilityData.js --cleanup             # borra solo esos 3 documentos
```
Borra únicamente `CTEST-VIS-C1`, `TEST-VIS-P1` y `TEST-VIS-P2`, y solo si llevan `esDatoDePrueba: true` y
`escenarioPrueba: "visibilidad-vendedores-v1"` (si alguno existe sin la marca, no borra ninguno). Usa como condición la
`updateTime` leída, de modo que un documento modificado entretanto no se borra. No toca usuarios, cuentas de Auth ni otros
documentos. Los usuarios de prueba (vendedor 2) se quedan; los datos del emulador desaparecen igualmente al detenerlo.
