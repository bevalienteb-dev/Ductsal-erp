# Datos locales de la versión anterior (localStorage): detección e importación controlada

> Estado: **implementado localmente, sin desplegar**. La importación solo se ejecuta contra los **emuladores**; ejecutarla
> contra un proyecto real es una decisión pendiente (no existe ningún indicador para ello a propósito).

## 1. Qué hacía el bloque original (`app_core.js`, `DOMContentLoaded`, ~L457-472)

| Pregunta | Respuesta verificada en el código original |
|---|---|
| ¿Quién lo activaba? | **Cualquier visitante** que abriera la página: no exigía sesión, rol ni confirmación |
| ¿Se ejecutaba solo? | **Sí**, en cada carga, antes de enganchar los listeners (la página esperaba a que terminara) |
| ¿Qué escribía? | `clients_*`, `prospects_*`, **`users_*`** (con contraseñas en texto plano y roles) y `system_*/settings`, a partir de las claves de localStorage `ductsal_clients`, `ductsal_prospects`, `hexasales_users`, `ductsal_settings` |
| ¿Sobrescribía? | **Sí**: usaba `.set()` por `id`, así que reemplazaba el documento existente; no había comprobación de duplicados (NIT/DUI, `codigo`) |
| ¿Tenía un propósito legítimo? | Sí: es el resto de la versión previa a Firebase (migrar datos guardados en el navegador). **Ningún código actual escribe esas claves**, así que lo que haya en un navegador es residuo de esa versión |
| ¿Se podía abusar? | Sí: quien pudiera dejar esas claves en su navegador (o tuviera un residuo antiguo) creaba **usuarios con rol `manager`** y pisaba clientes y oportunidades reales |

`fabricacion-dev/app.js` contiene un bloque idéntico. **No se modificó** (fuera del alcance); sigue siendo un riesgo mientras
las reglas de Firestore permitan esas escrituras (ver `COMMERCIAL_OPERATIONS.md` §5).

## 2. Qué se hizo

* El bloque automático **ya no escribe nada**. Solo **detecta** (lectura) si el navegador conserva alguna de las cuatro claves y
  avisa en la consola (`console.warn`) con la referencia a este documento.
* El administrador inicial automático (usuario `manager` con contraseña vacía cuando no había usuarios) también está
  **deshabilitado**: solo avisa. El primer gerente lo crea quien administra el proyecto (en emuladores:
  `functions/scripts/seedEmulatorManager.js`; en un proyecto real: `createUserAdmin`, pendiente de decisión sobre cómo se
  entrega el primer gerente).
* Se sustituye por un proceso **explícito, ejecutado por el propietario, con validación previa e idempotente**:
  [`scripts/importLegacyLocalStorage.js`](scripts/importLegacyLocalStorage.js) + [`legacyImport.js`](legacyImport.js).
* No queda ninguna ruta de respaldo que escriba sin autorización (hay pruebas estáticas y de sandbox que lo vigilan).

## 3. Cómo usarlo (solo emuladores)

1. En el navegador que conserva los datos, abre la consola y exporta (no modifica nada):

   ```js
   copy(JSON.stringify({
     clients: JSON.parse(localStorage.getItem('ductsal_clients') || '[]'),
     prospects: JSON.parse(localStorage.getItem('ductsal_prospects') || '[]'),
     settings: JSON.parse(localStorage.getItem('ductsal_settings') || 'null')
   }));
   ```

   Pega el resultado en `export.json`. **No incluyas usuarios**: `hexasales_users` (contraseñas en texto plano) nunca se importa.
2. Valida (simulacro, **no escribe**):

   ```bash
   GCLOUD_PROJECT=demo-ductsal-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
   node scripts/importLegacyLocalStorage.js ./export.json --suffix _local
   ```

3. Revisa el informe (`new`, `identical`, `conflict`, `invalid`, `problems`) y, si es correcto, repite con `--apply --operator "Tu nombre"`.

## 4. Garantías del importador

* **Entorno**: se niega a ejecutarse si el entorno no es demostrablemente el de los emuladores (proyecto `demo-`, Auth y
  Firestore en `127.0.0.1`, sin credenciales de cuenta de servicio). No hay opción para un proyecto real.
* **Validación previa**: identificadores, tipo de cliente y nombre, estado y etapa de la oportunidad, listas, referencia
  oportunidad → cliente y `codigo` único. (No valida el formato de NIT/DUI: usa las mismas claves normalizadas de
  `clientIdentity.js` que `createClientAdmin` para detectar repetidos.) Cualquier registro **inválido** impide `--apply` por
  completo (no se escribe nada).
* **Solo crea** (`create`/transacción): un `id` existente **nunca se sobrescribe**. Mismo contenido → `identical`; contenido
  distinto → `conflict` (se conserva lo almacenado y se informa).
* **Sin duplicados de identidad**: NIT/DUI repetidos (en el archivo o contra el índice `clientIdentifiers_*`) → `conflict`;
  se crea el índice de identificadores igual que `createClientAdmin`. Una oportunidad cuyo cliente no existe ni viene en el
  archivo se omite como `conflict` (no se crean huérfanas).
* **Idempotente**: ejecutar el mismo archivo dos veces no crea ni cambia nada la segunda vez.
* **Ajustes**: solo las claves del CRM (`visitantes`, `encargados`, `factory_address`) y solo si `system/settings` **no existe**;
  claves como `gmaps_api_key` se descartan.
* **Auditoría**: una entrada `legacyImport` en `commercialAudit_*` con hash del archivo, cuántos registros se crearon y quién
  lo ejecutó.
* **Usuarios**: nunca se importan (contraseñas en texto plano; la migración de identidad es una decisión aparte).
* **Código de oportunidad (`codigo`)**: las oportunidades importadas conservan su `codigo`; el importador comprueba que no
  choque con uno existente, pero **no avanza el contador anual** de `createProspectAdmin`. El contador de un año se siembra
  con el máximo existente la primera vez que se usa: importa los datos de un año **antes** de crear la primera oportunidad
  nueva de ese año; si ya existe el contador de ese año, revisa el siguiente código antes de importar datos de ese mismo año.

## 5. Pruebas

* Unitaria: `__tests__/legacyImport.unit.test.js` (Firestore en memoria).
* Emulador (Firestore real aislado): `isolated-tests/legacyImport.iso.js`.
* Estáticas / sandbox: `__tests__/crmCommercial.client.test.js` (el bloque de `app_core.js` no escribe).

## 6. Pendiente (decisión del propietario)

* Si se quiere importar a un proyecto real hace falta una vía autorizada distinta (cuenta de administración fuera del
  navegador y plan de copia de seguridad). No se implementó.
* Identidad del primer gerente de un proyecto vacío.
