# Legacy paths that still store or compare plaintext passwords

Documented, **not modified** in iteration 8 (changing them needs a decision on migrating historical
users). New accounts created through `createUserAdmin` have no `password` field and never use these
paths: they carry `authUid` and sign in with Firebase Authentication.

## `sales-reporting-system/app_core.js` (the file `index.html` loads)

| Line | Path | What it does | Next step |
|---|---|---|---|
| 418 | `checkInitialLoad` | If `users` is empty, writes a manager profile (`password: ''`, fixed email) to Firestore. Whoever first logs in with that email sets the manager password (see 586). **A self-bootstrap route to `manager`**, also in an empty `users_local`. | Remove, and provision the first manager out of band (see `scripts/seedEmulatorManager.js` for the emulator-only equivalent). |
| 552, 560 | `processLogin` | Compares the typed password with `user.password` in the browser. | Retire after historical users are migrated to Firebase Auth. |
| 586–587 | `processFirstTimeSetup` | `pendingSetupUser.password = p1; saveUserToDB(...)`: **writes the plaintext password to Firestore.** | Replace by the Firebase password-reset email flow once users are migrated. |
| 726 | `resetUserPassword` (non-linked users) | Sets `password = ""` so the user chooses one at next login, which then goes through 586. | Same as above. |
| 1992 | `applyManagerBypass` | Compares a manager's typed password with `manager.password`. A manager linked to Firebase has no such field, so this always fails for them (fails closed, but they cannot use the feature). | Re-authenticate the manager with Firebase (`reauthenticateWithCredential`) instead. |

Reads of the whole `users` collection by any client also expose these fields; closing that needs
Firestore rules (not in the repository, not touched).

## Other files (not modified)

- `sales-reporting-system/app.js`: stale copy not loaded by `index.html`; same patterns at lines 418, 554/562, 577, 656 (`saveUserToDB(nu)` with `password: ''`), 692, 1892.
- `fabricacion-dev/js/auth.js`: the same legacy login/first-time setup, a numeric PIN stored in `password` (lines ~246–341), **and a hard-coded master-login branch near the top of `processLogin`** (a fixed email and password literal that grants `manager`). Rotate/remove that credential as soon as possible; I did not reproduce it here.
- `fabricacion-dev/js/oportunidades.js` ~452: manager password comparison like `applyManagerBypass`.
- `fabricacion-dev` shares the `users<suffix>` collection, so it cannot authenticate Auth-linked users until it gets the same integration.
