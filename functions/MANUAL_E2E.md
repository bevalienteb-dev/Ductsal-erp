# Prueba manual en Chrome: alta de usuario contra los emuladores (Iteración 11)

Todo ocurre contra `demo-ductsal-local` en `127.0.0.1`. **Nada de esto se ha ejecutado en un navegador todavía:** el
navegador automatizado del entorno no pudo arrancar. Los resultados que se pidan abajo son los que hay que comunicar.

Los comandos se ejecutan desde la raíz del repositorio (`sales-reporting-system`). Ningún comando imprime
contraseñas ni tokens: las contraseñas de prueba (solo válidas en el emulador) se copian al portapapeles.

## 0. Preparación (terminal)

Los emuladores deben estar en marcha (ver `EMULATOR.md`) y el semillero aplicado.

```
node functions/scripts/manualE2E.js check        # emuladores, proyecto y gerente ficticio -> todo [OK]
node functions/scripts/serveLocalUI.js 8123      # deja este servidor en una terminal aparte
node functions/scripts/manualE2E.js server 8123  # servidor solo loopback + CSP -> todo [OK]
```

## 1. Abrir el navegador (solo esta URL)

1. Chrome → **ventana de incógnito** (evita extensiones y datos antiguos).
2. Abre DevTools (`⌥⌘I`) **antes** de navegar. Pestaña **Network**: marca *Preserve log* y *Disable cache*. Pestaña **Console** visible.
3. Navega a **exactamente**: `http://127.0.0.1:8123/?emulators=demo-ductsal-local`

## 2. Verificación del modo emuladores (ANTES de iniciar sesión)

**A. Debe verse:** una franja **naranja** arriba que dice `MODO EMULADORES — proyecto demo-ductsal-local …` y la
pantalla "Ingresar al Sistema". **No** debe verse la caja roja "Modo emuladores bloqueado" (si aparece, copia su texto: es
el fallo seguro y dirá qué emulador falta).

**B. Consola:** debe haber un aviso `MODO EMULADORES ACTIVO. Proyecto: demo-ductsal-local | Auth 127.0.0.1:9099 | Firestore 127.0.0.1:8080 | Functions 127.0.0.1:5001 | …`.
Comunica cualquier mensaje rojo, en especial los que digan `Refused to connect` / `Content Security Policy`
(significan que la página intentó una conexión externa y el navegador la bloqueó).

**C. Pega en la consola** (si Chrome lo pide, escribe `allow pasting`):

```js
(() => {
  const o = firebase.app().options;
  const origins = [...new Set(performance.getEntriesByType('resource').map(e => new URL(e.name).origin))];
  const staticOk = ['https://www.gstatic.com', 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
  const external = origins.filter(x => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(x));
  return JSON.stringify({
    emulatorMode: CRM_EMULATOR_MODE,
    projectId: o.projectId,
    apiKey: o.apiKey,
    banner: (document.getElementById('emulator-banner') || {}).textContent || null,
    origins,
    unexpectedExternal: external.filter(x => !staticOk.includes(x))
  }, null, 1);
})()
```

**Resultado esperado:** `emulatorMode: true`, `projectId: "demo-ductsal-local"`, `apiKey: "demo-emulator-key"`,
banner con texto, y **`unexpectedExternal: []`**. Los orígenes externos permitidos son solo scripts/estilos/fuentes
(gstatic, jsdelivr, fonts). **Si `unexpectedExternal` no está vacío, o aparece `ductsal-erp`, `firebaseapp.com`,
`firestore.googleapis.com`, `identitytoolkit.googleapis.com`, `cloudfunctions.net`: DETENTE, no inicies sesión y comunícamelo.**

**D. Network:** al recargar (`⌘R`) comprueba que las peticiones a Firestore/Auth van a `127.0.0.1:8080` / `127.0.0.1:9099`.

**Comunícame:** el JSON del paso C, y si el banner y el aviso de consola estaban presentes.

## 3. Iniciar sesión como gerente ficticio

```
node functions/scripts/manualE2E.js manager-password
```
Restablece la contraseña **solo de la cuenta del emulador** y la copia al portapapeles (no la imprime).
Login: correo `gerente.prueba@ductsal-test.invalid`, contraseña con `⌘V`. Después copia otra cosa para vaciar el portapapeles.

**Observa:** entra al panel; en el menú lateral aparecen Dashboard, Proyectos, Configuración, **Usuarios**, etc.
El nombre mostrado es "Gerente de Prueba (emulador)", rol "Gerente". No debe haberse creado ningún otro perfil (el bootstrap
automático está desactivado en este modo).

## 4. Crear el vendedor desde la interfaz

Usuarios → **+ Nuevo Usuario**: nombre `Vendedor Manual`, correo `vendedor.manual@ductsal-test.invalid`, rol **Vendedor** → Guardar.

**Observa y comunícame el texto exacto de la alerta.** Esperado: `Usuario creado. Se envió un correo a
vendedor.manual@ductsal-test.invalid para que establezca su contraseña.` (el emulador **no envía correo**: el texto solo
es literalmente cierto en producción), el modal se cierra y el usuario aparece en la tabla.

```
node functions/scripts/manualE2E.js verify vendedor.manual@ductsal-test.invalid
```
Esperado: todo `[OK]` — 1 cuenta de Auth, 1 perfil en `users_local`, `authUid` coincide, ID comercial distinto, sin
claim `manager`, sin ningún campo de contraseña en Firestore, sin colecciones `*_prod`.

## 5. Establecimiento de contraseña y primer inicio de sesión

El mecanismo real del CRM es `sendPasswordResetEmail` (botón **Reset Pass** de la fila). En el emulador, el código queda
registrado en vez de enviarse por correo.

1. En la fila del vendedor pulsa **Reset Pass** → confirma. Esperado: alerta `Correo de restablecimiento enviado.`
2. Terminal: `node functions/scripts/manualE2E.js set-password vendedor.manual@ductsal-test.invalid`
   Completa ese código de restablecimiento en el emulador con una contraseña aleatoria y la copia al portapapeles.
   (Si dice que no hay código pendiente, repite el paso 1.)
3. **Cerrar sesión** del gerente (`🚪 Cerrar Sesión`, abajo en el menú). Esperado: vuelve a "Ingresar al Sistema".
4. Login con `vendedor.manual@ductsal-test.invalid` y la contraseña (`⌘V`). También debe funcionar escribiendo el correo con mayúsculas.

**Observa:** entra como "Vendedor Manual", rol "Vendedor".
Nota conocida: el campo dice "en blanco si es primera vez" (texto histórico); para este tipo de usuario dejarlo en blanco
da la alerta "Ingresa tu contraseña.". Comunícame si esto te confunde.

## 6. El vendedor no puede usar funciones administrativas

**Observa en la interfaz:** el menú solo muestra la lista de oportunidades y clientes; **no** hay Dashboard, Proyectos,
Configuración ni Usuarios.

**Pega en la consola** (como vendedor):

```js
(async () => {
  const msgs = [];
  const viaApp = await CrmAuth.adminCreateUser(firebase, { nombre: 'Intruso', email: 'intruso@ductsal-test.invalid', role: 'vendedor', dbSuffix: DB_SUFFIX }, m => msgs.push(m));
  let direct;
  try {
    const r = await firebase.functions().httpsCallable('createUserAdmin')({ email: 'intruso2@ductsal-test.invalid', nombre: 'Intruso', role: 'vendedor', opId: 'manual-' + Date.now(), dbSuffix: DB_SUFFIX });
    direct = 'UNEXPECTED SUCCESS ' + JSON.stringify(r.data);
  } catch (e) { direct = e.code; }
  return JSON.stringify({ viaApp, msgs, direct }, null, 1);
})()
```
**Esperado:** `viaApp: "unavailable"`, un mensaje "No se creó el usuario: …", y `direct: "functions/permission-denied"`.

```
node functions/scripts/manualE2E.js absent intruso@ductsal-test.invalid
node functions/scripts/manualE2E.js absent intruso2@ductsal-test.invalid
```
Esperado: `Auth: 0 accounts` y `Firestore: 0 profiles` en ambos.

(El menú oculto es solo presentación; la protección real es la del servidor, que es lo que prueba el paso anterior.)

## 7. Cierre de sesión del vendedor

Pulsa `🚪 Cerrar Sesión`. **Observa:** vuelve a "Ingresar al Sistema". Comprueba en la consola:

```js
JSON.stringify({ firebaseUser: firebase.auth().currentUser, savedUser: localStorage.getItem('ductsal_current_user') })
```
**Esperado:** `{"firebaseUser":null,"savedUser":null}`. Recarga (`⌘R`): debe seguir mostrando el login.

## 8. Conexiones a producción

Al terminar, en Network (con *Preserve log*) no debe aparecer ninguna petición a `ductsal-erp`, `firebaseio.com`,
`*.googleapis.com` (salvo `fonts.googleapis.com`) ni `cloudfunctions.net`. Repite el JSON del paso 2.C y comunícame el resultado.

## Qué comunicarme

1. Si la franja naranja y el aviso de consola estaban presentes, y el JSON del paso 2.C.
2. Texto exacto de la alerta del paso 4 y la salida de `verify`.
3. Resultado del paso 5 (¿entró el vendedor? ¿con el nombre y rol correctos?).
4. Resultado del paso 6 (JSON y los dos `absent`).
5. Resultado del paso 7.
6. Cualquier mensaje rojo en la consola, alerta inesperada o pantalla en blanco (con captura si puedes).

## Al terminar

Detén el servidor (`Ctrl+C`). Los datos de prueba solo viven en el emulador y se pierden al detenerlo.
