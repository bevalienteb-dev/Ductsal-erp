// functions/scripts/importLegacyLocalStorage.js
// Owner-run import of clients / opportunities / lists exported from the OLD browser localStorage (see ../LEGACY_IMPORT.md).
// Replaces the automatic block that used to run on every page load. Dry run by default; `--apply` writes.
//
// In this phase it runs ONLY against the emulators: the same strict guard as the seeding script (demo- project, loopback
// Auth + Firestore, no service-account credentials). Running it against a real project is a pending decision, so there is
// deliberately no flag for it.
//
// Usage:
//   GCLOUD_PROJECT=demo-ductsal-local FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   node scripts/importLegacyLocalStorage.js ./export.json [--suffix _local|_prod] [--apply] [--operator "Nombre"]

const fs = require('fs');
const { emulatorIsolationProblems } = require('../emulatorGuard');

function parseArgs(argv) {
  const out = { file: null, apply: false, suffix: '_local', operator: process.env.USER || 'unknown' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--suffix') out.suffix = argv[++i];
    else if (a === '--operator') out.operator = argv[++i];
    else if (!a.startsWith('--') && !out.file) out.file = a;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!out.file) throw new Error('Indica el archivo JSON exportado');
  if (out.suffix !== '_local' && out.suffix !== '_prod') throw new Error('--suffix debe ser _local o _prod');
  return out;
}

async function main() {
  const problems = emulatorIsolationProblems(process.env, { strict: true });
  if (problems.length > 0) {
    console.error('Refusing to run: the environment is not provably the emulators.\n - ' + problems.join('\n - '));
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const { importLegacy } = require('../legacyImport');
  const report = await importLegacy({ db: admin.firestore(), FieldValue: admin.firestore.FieldValue, suffix: args.suffix, payload, apply: args.apply, operator: args.operator });
  console.log(JSON.stringify(report, null, 2));
  if (!args.apply) console.log('\nDry run: nothing was written. Re-run with --apply to create the records marked "new".');
}

if (require.main === module) main().catch(err => { console.error(err.message || err); process.exit(1); });

module.exports = { parseArgs };
