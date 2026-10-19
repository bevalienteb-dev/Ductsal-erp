# Local emulator environment (Auth + Firestore + Functions)

> **Status: prepared, NOT yet run.** In the environment where this was written there is **no Java
> runtime and no `firebase-tools`**, so none of the commands in "Start / stop" below has been
> executed. What *has* been verified is listed in "What is verified". Nothing here deploys anything
> or touches the production project.

## Prerequisites (not installed here; install them yourself)

- `firebase-tools` (Firebase CLI).
- A JDK (needed by the Firestore emulator; the CLI prints the minimum version it requires).
- Node 20 (already used by `functions/`).

## Isolation design

| Layer | Mechanism |
|---|---|
| Project | `--project demo-ductsal-local`. A `demo-` project id makes the Firebase CLI refuse to connect to real services. The real project id is never used. |
| Config | [`firebase.emulator.json`](../firebase.emulator.json) is not named `firebase.json`, so a plain `firebase deploy` cannot pick it up. It has no Firestore/Storage rules and no import/export: data is **ephemeral** and starts empty each run. |
| Hosts | All emulators bind `127.0.0.1`. |
| Functions code | `assertManager` (used by all four functions) refuses to run when `FUNCTIONS_EMULATOR === 'true'` unless `FIRESTORE_EMULATOR_HOST` **and** `FIREBASE_AUTH_EMULATOR_HOST` are set to loopback addresses ([`emulatorGuard.js`](emulatorGuard.js)). This covers `--only functions`, which would otherwise use the real Auth/Firestore. |
| Seed script | [`scripts/seedEmulatorManager.js`](scripts/seedEmulatorManager.js) refuses to start unless: project id is `demo-…`, both emulator hosts are loopback, and `GOOGLE_APPLICATION_CREDENTIALS` is unset. |

How the SDKs consume the variables (read in `node_modules`, not assumed):
`@google-cloud/firestore` reads `FIRESTORE_EMULATOR_HOST` when the client is constructed (first
`admin.firestore()`) and it overrides any host in code, so it must be set **before** loading the
code; `firebase-admin` Auth reads `FIREBASE_AUTH_EMULATOR_HOST` on every request;
`FUNCTIONS_EMULATOR` is only set by the CLI and no SDK enforces anything with it (hence the guard).

> **Do not use `npm start` in `functions/`.** It runs `--only functions` against the default project.
> The runtime guard would refuse the calls, but use the command below instead.

## Start / stop

Run from the repository root (`sales-reporting-system/`):

```bash
# Start (terminal 1). Leave it running.
firebase emulators:start --config firebase.emulator.json --project demo-ductsal-local --only auth,firestore,functions

# Seed the test manager (terminal 2). Emulator only; the script refuses otherwise.
cd functions
GCLOUD_PROJECT=demo-ductsal-local \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
node scripts/seedEmulatorManager.js
# Optional: SEED_MANAGER_PASSWORD=... (otherwise a random one is printed once, when the account is created)

# Stop: press Ctrl+C in terminal 1. Everything is discarded (no --import / --export-on-exit).
# Reset without stopping:
curl -X DELETE "http://127.0.0.1:9099/emulator/v1/projects/demo-ductsal-local/accounts"
curl -X DELETE "http://127.0.0.1:8080/emulator/v1/projects/demo-ductsal-local/databases/(default)/documents"
```

The seed creates (idempotently) one Auth account `gerente.prueba@ductsal-test.invalid` (uid
`seed-test-manager`, claim `{ manager: true }`) and one profile `users_local/1000000000001`
(`authUid` linked, no password field). It aborts rather than adopt an account/profile it does not own.

## What is verified (and how)

- **Unit tests with in-memory fakes** (`npx jest --runInBand`): guard logic, the four functions
  refusing to run without both emulators, seed idempotency/ownership, no password in Firestore.
  These are **not** emulator tests.
- **Real processes, no emulator running:** the seed script refuses to start in six unsafe
  environments (exit code 2); with a valid emulator environment it passes the guard and the error
  observed is a refused connection to `127.0.0.1:9099`, which indicates the Admin SDK follows
  `FIREBASE_AUTH_EMULATOR_HOST`. An equivalent probe for Firestore (a read with only
  `FIRESTORE_EMULATOR_HOST` set) timed out after 12 s without an answer: **inconclusive**, so the
  Firestore host handling is confirmed from the SDK source only, not by observation.

## Iteration 10: end-to-end against the real emulators

Run (emulators already started as above, seed already applied):

```
cd functions
npx jest -c jest.emulator.config.js --runInBand     # real emulators, no Firebase mocks
npx jest --runInBand                                 # default suite: unit tests with fakes, needs nothing running
```

`emulator-tests/createUserAdmin.e2e.emu.js` resets the seeded manager's password **on the emulator
only** (admin endpoint, random value, never printed), signs in over the Auth REST API, and calls
`createUserAdmin` with the callable protocol (`POST /<project>/us-central1/createUserAdmin`,
`Authorization: Bearer <idToken>`, body `{"data":{...}}`). It then reads Auth and Firestore directly.
Every URL is a hard-coded `127.0.0.1` constant; nothing is read from the environment.

Password setup: the emulator **does not send email**. `crm_auth.js` calls `sendPasswordResetEmail`
(Auth `accounts:sendOobCode`); the test reads the generated code from
`GET /emulator/v1/projects/demo-ductsal-local/oobCodes` and completes it with `accounts:resetPassword`.
The CRM message "Se envió un correo..." is therefore only literally true outside the emulator.

The real `crm_auth.js` and the real `saveUser` are driven through a small REST stand-in for the Firebase
namespace, because the Firebase JS SDK is not installed. That is **not** the browser SDK.

### Opening the CRM against the emulators (explicit opt-in)

Plain `localhost` still talks to the real `ductsal-erp` project. Emulator mode needs both a loopback page
**and** the exact query `?emulators=demo-ductsal-local` (see `crm_env.js`):

```
node functions/scripts/serveLocalUI.js 8123     # 127.0.0.1 only; CSP connect-src limited to loopback
open "http://127.0.0.1:8123/?emulators=demo-ductsal-local"
```

In that mode Firebase is initialised with the demo project and a dummy key (the real config is never
used), Auth/Firestore/Functions/Storage are pointed at `127.0.0.1`, an orange banner is shown, the
first-manager auto-bootstrap is disabled, and the page is blocked if any emulator does not answer or if
the `emulators` parameter is present but invalid. Check the console for `MODO EMULADORES ACTIVO`.
Storage has no emulator in `firebase.emulator.json`: file uploads simply fail locally.

Browser verification status: **not done** in the Iteration 10 environment (the browser tool could not
start). The isolation is demonstrated by unit tests that execute the real start-up block of `app_core.js`
against a recording fake, and by the CSP of the local server; it has not been observed in a real browser console.

Bug found by these tests and fixed: inside the Firebase CLI's Functions emulator `admin.firestore.FieldValue`
and `.Timestamp` are undefined, which made every `createUserAdmin` call return INTERNAL
(`firestoreStatics()` in `index.js`; regression test `emulatorStatics.regression.test.js`).
