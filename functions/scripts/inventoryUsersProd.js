// functions/scripts/inventoryUsersProd.js
// SEC-01 / SEC-03 Read-Only Inventory and Preflight Tool for users_prod.
//
// STRICT SAFEGUARDS:
//   - ZERO writes to Firestore, Auth, Storage, or any database.
//   - ZERO leakage: NEVER logs, exports, or prints password values, PINs, tokens, or secrets.
//   - Strictly targets project 'ductsal-erp' in production; fails closed on any mismatch.
//   - Conservative categorization: unrecognized records are classified as UNKNOWN.
//
// Usage:
//   In Emulator:
//     node functions/scripts/inventoryUsersProd.js --project demo-ductsal-isolated
//
//   In Production (Read-Only Preflight, requires explicit flag):
//     node functions/scripts/inventoryUsersProd.js --project ductsal-erp --allow-authorized-production-run [--json] [--check-auth]

const admin = require('firebase-admin');
const { emulatorIsolationProblems } = require('../emulatorGuard');
const { resolveAdminProjectId } = require('./provisionManager');

const EXPECTED_PROJECT_ID = 'ductsal-erp';

// Known commercial identities
const KNOWN_ACTIVE_COMMERCIAL = {
  '1776895495203': { email: 'bvaliente@grupogama.com', role: 'manager', expectedClaims: { role: 'manager', manager: true, cid: '1776895495203' } },
  '1776904494660': { email: 'dgonzalez@ductsal.com', role: 'manager', expectedClaims: { role: 'manager', manager: true, cid: '1776904494660' } },
  '1776904514932': { email: 'aayala@ductsal.com', role: 'gestor', expectedClaims: { role: 'gestor', cid: '1776904514932' } },
  '1788471603604': { email: 'rflores@ductsal.com', role: 'vendedor', expectedClaims: { role: 'vendedor', cid: '1788471603604' } }
};

const KNOWN_INACTIVE_COMMERCIAL = {
  '1784221928346': { email: 'gvelasquez@ductsal.com', role: 'vendedor', activo: false }
};

// Recognized fabrication roles (SEC-02)
const RECOGNIZED_PLANT_ROLES = new Set([
  'operario',
  'encargado_armado',
  'jefe_produccion',
  'control_calidad',
  'despacho',
  'dibujante',
  'recepcion'
]);

function parseArgs(argv) {
  const options = {
    project: null,
    allowProduction: false,
    outputJson: false,
    checkAuth: false,
    collectionName: 'users_prod'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) options.project = argv[++i];
    else if (arg === '--allow-authorized-production-run') options.allowProduction = true;
    else if (arg === '--json') options.outputJson = true;
    else if (arg === '--check-auth') options.checkAuth = true;
    else if (arg === '--collection' && argv[i + 1]) options.collectionName = argv[++i];
  }
  return options;
}

function areClaimsEqual(actual, expected) {
  if (!actual || !expected) return false;
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

/**
 * Audits the users collection strictly in read-only mode.
 */
async function auditUsersProd(adminInstance, options = {}) {
  const db = typeof adminInstance.firestore === 'function' ? adminInstance.firestore() : adminInstance.firestore;
  const auth = typeof adminInstance.auth === 'function' ? adminInstance.auth() : adminInstance.auth;
  const colName = options.collectionName || 'users_prod';

  const snap = await db.collection(colName).get();

  const inventory = {
    targetCollection: colName,
    totalDocuments: snap.size,
    totalWithPassword: 0,
    totalWithoutPassword: 0,
    totalWithAuthUid: 0,
    totalWithoutAuthUid: 0,
    categories: {
      activeCommercial: { count: 0, withPassword: 0, withAuthUid: 0, items: [] },
      inactiveCommercial: { count: 0, withPassword: 0, withAuthUid: 0, items: [] },
      plantFabrication: { count: 0, withPassword: 0, withPin: 0, items: [] },
      unknownRecords: { count: 0, withPassword: 0, withAuthUid: 0, items: [] }
    },
    authVerification: {
      performed: false,
      activeCommercialResults: []
    },
    schemaAnomalies: []
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const cid = doc.id;

    const hasPassword = Object.prototype.hasOwnProperty.call(data, 'password') && data.password !== undefined && data.password !== null;
    const hasPin = Object.prototype.hasOwnProperty.call(data, 'pin') && data.pin !== undefined && data.pin !== null;
    const rawRole = typeof data.role === 'string' ? data.role.trim() : '';
    const rawEmail = typeof data.email === 'string' ? data.email.trim() : '';
    const activo = data.activo;
    const authUid = typeof data.authUid === 'string' && data.authUid.trim().length > 0 ? data.authUid.trim() : null;

    if (hasPassword) inventory.totalWithPassword++;
    else inventory.totalWithoutPassword++;

    if (authUid) inventory.totalWithAuthUid++;
    else inventory.totalWithoutAuthUid++;

    // Safe anomaly detection (without revealing any secret payload)
    if (!rawEmail || !rawEmail.includes('@')) {
      inventory.schemaAnomalies.push({ cid, anomaly: 'MISSING_OR_INVALID_EMAIL' });
    }
    if (!rawRole) {
      inventory.schemaAnomalies.push({ cid, anomaly: 'MISSING_ROLE' });
    }
    if (typeof activo !== 'boolean') {
      inventory.schemaAnomalies.push({ cid, anomaly: `NON_BOOLEAN_ACTIVO (type: ${typeof activo})` });
    }
    if (data.id && String(data.id) !== cid) {
      inventory.schemaAnomalies.push({ cid, anomaly: `FIELD_ID_MISMATCH (data.id '${data.id}' !== doc.id '${cid}')` });
    }

    const safeItem = {
      cid,
      role: rawRole || '(none)',
      activo: Boolean(activo),
      hasPassword,
      hasPin,
      authUidPresent: Boolean(authUid)
    };

    // Categorization
    if (Object.prototype.hasOwnProperty.call(KNOWN_ACTIVE_COMMERCIAL, cid)) {
      inventory.categories.activeCommercial.count++;
      if (hasPassword) inventory.categories.activeCommercial.withPassword++;
      if (authUid) inventory.categories.activeCommercial.withAuthUid++;
      inventory.categories.activeCommercial.items.push(safeItem);
    } else if (Object.prototype.hasOwnProperty.call(KNOWN_INACTIVE_COMMERCIAL, cid)) {
      inventory.categories.inactiveCommercial.count++;
      if (hasPassword) inventory.categories.inactiveCommercial.withPassword++;
      if (authUid) inventory.categories.inactiveCommercial.withAuthUid++;
      inventory.categories.inactiveCommercial.items.push(safeItem);
    } else if (RECOGNIZED_PLANT_ROLES.has(rawRole) || hasPin) {
      inventory.categories.plantFabrication.count++;
      if (hasPassword) inventory.categories.plantFabrication.withPassword++;
      if (hasPin) inventory.categories.plantFabrication.withPin++;
      inventory.categories.plantFabrication.items.push(safeItem);
    } else {
      inventory.categories.unknownRecords.count++;
      if (hasPassword) inventory.categories.unknownRecords.withPassword++;
      if (authUid) inventory.categories.unknownRecords.withAuthUid++;
      inventory.categories.unknownRecords.items.push(safeItem);
    }
  }

  // Cross-reference with Firebase Auth if requested and available
  if (options.checkAuth && auth) {
    inventory.authVerification.performed = true;

    for (const [cid, meta] of Object.entries(KNOWN_ACTIVE_COMMERCIAL)) {
      const authReport = {
        cid,
        email: meta.email,
        expectedRole: meta.role,
        authExists: false,
        authUid: null,
        firestoreAuthUid: null,
        uidMatches: false,
        disabled: null,
        claimsMatch: false,
        lastSignInTimePresent: false
      };

      // Find doc in Firestore
      const docSnap = snap.docs.find(d => d.id === cid);
      const fsData = docSnap ? docSnap.data() : null;
      authReport.firestoreAuthUid = (fsData && fsData.authUid) || null;

      try {
        let authUser = null;
        if (authReport.firestoreAuthUid) {
          try {
            authUser = await auth.getUser(authReport.firestoreAuthUid);
          } catch (_) {
            authUser = await auth.getUserByEmail(meta.email);
          }
        } else {
          authUser = await auth.getUserByEmail(meta.email);
        }

        if (authUser) {
          authReport.authExists = true;
          authReport.authUid = authUser.uid;
          authReport.uidMatches = Boolean(authReport.firestoreAuthUid && authReport.firestoreAuthUid === authUser.uid);
          authReport.disabled = Boolean(authUser.disabled);
          authReport.claimsMatch = areClaimsEqual(authUser.customClaims, meta.expectedClaims);
          authReport.lastSignInTimePresent = Boolean(authUser.metadata && authUser.metadata.lastSignInTime);
        }
      } catch (authErr) {
        authReport.error = (authErr && authErr.code) || 'AUTH_LOOKUP_ERROR';
      }

      inventory.authVerification.activeCommercialResults.push(authReport);
    }
  }

  return inventory;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.allowProduction) {
    const problems = emulatorIsolationProblems(process.env, { strict: true });
    if (problems.length > 0) {
      console.error('Refusing to run: Environment is not provably isolated emulators:\n - ' + problems.join('\n - '));
      console.error('\nTo perform an authorized, read-only preflight on production:');
      console.error('  node functions/scripts/inventoryUsersProd.js --project ductsal-erp --allow-authorized-production-run [--json] [--check-auth]');
      process.exit(2);
    }
  }

  // Initialize Admin SDK with explicit guards
  if (!admin.apps.length) {
    if (options.allowProduction) {
      const targetProject = options.project || EXPECTED_PROJECT_ID;
      if (targetProject !== EXPECTED_PROJECT_ID) {
        console.error(`FATAL: Production run strictly requires project '${EXPECTED_PROJECT_ID}'. Received '${targetProject}'. Aborting.`);
        process.exit(1);
      }
      try {
        const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
        await initializeImpersonatedAdminApp(admin, { projectId: EXPECTED_PROJECT_ID });
      } catch (adapterErr) {
        admin.initializeApp({ projectId: EXPECTED_PROJECT_ID });
      }
    } else {
      const defaultProject = options.project || process.env.GCLOUD_PROJECT || 'demo-ductsal-isolated';
      admin.initializeApp({ projectId: defaultProject });
    }
  }

  // Verify project resolution consensus
  const resolution = resolveAdminProjectId(admin);
  if (resolution.contradiction) {
    console.error(`FATAL: Contradictory Firebase project configuration: ${resolution.error}`);
    process.exit(1);
  }
  if (options.allowProduction && resolution.projectId !== EXPECTED_PROJECT_ID) {
    console.error(`FATAL: Verified projectId '${resolution.projectId}' does not match expected '${EXPECTED_PROJECT_ID}'.`);
    process.exit(1);
  }

  const inventory = await auditUsersProd(admin, options);

  if (options.outputJson) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }

  // Human-readable summary output (guaranteed zero password values)
  console.log('================================================================');
  console.log('   AUDITORÍA DE PREFLIGHT DE SOLO LECTURA (SEC-01 / SEC-03)    ');
  console.log(`   Colección: ${inventory.targetCollection} | Proyecto: ${resolution.projectId || 'emulator'}`);
  console.log('================================================================');
  console.log(`Total Documentos Auditados:        ${inventory.totalDocuments}`);
  console.log(`Documentos CON campo password:     ${inventory.totalWithPassword}`);
  console.log(`Documentos SIN campo password:     ${inventory.totalWithoutPassword}`);
  console.log(`Documentos con authUid:            ${inventory.totalWithAuthUid}`);
  console.log(`Documentos sin authUid:            ${inventory.totalWithoutAuthUid}`);
  console.log('----------------------------------------------------------------');
  console.log('DESGLOSE POR CATEGORÍA:');
  console.log(`  1. Identidades Comerciales Activas (4 esperadas):`);
  console.log(`     - Encontradas: ${inventory.categories.activeCommercial.count}`);
  console.log(`     - Con password en texto plano: ${inventory.categories.activeCommercial.withPassword}`);
  console.log(`     - Con authUid vinculado:       ${inventory.categories.activeCommercial.withAuthUid}`);

  console.log(`  2. Perfil Comercial Inactivo (Gustavo Velásquez):`);
  console.log(`     - Encontradas: ${inventory.categories.inactiveCommercial.count}`);
  console.log(`     - Con password en texto plano: ${inventory.categories.inactiveCommercial.withPassword}`);
  console.log(`     - Con authUid:                 ${inventory.categories.inactiveCommercial.withAuthUid}`);

  console.log(`  3. Perfiles de Fabricación / Planta (SEC-02):`);
  console.log(`     - Encontradas: ${inventory.categories.plantFabrication.count}`);
  console.log(`     - Con password / pin:          ${inventory.categories.plantFabrication.withPassword} / ${inventory.categories.plantFabrication.withPin}`);

  console.log(`  4. Registros Desconocidos / Otros (NO TOCAR):`);
  console.log(`     - Encontradas: ${inventory.categories.unknownRecords.count}`);
  console.log(`     - Con password:                ${inventory.categories.unknownRecords.withPassword}`);
  console.log('----------------------------------------------------------------');

  if (inventory.schemaAnomalies.length > 0) {
    console.log(`ANOMALÍAS DE ESQUEMA DETECTADAS (${inventory.schemaAnomalies.length}):`);
    inventory.schemaAnomalies.forEach(a => {
      console.log(`  - CID ${a.cid}: ${a.anomaly}`);
    });
    console.log('----------------------------------------------------------------');
  } else {
    console.log('Anomalías de esquema: Ninguna detectada.');
    console.log('----------------------------------------------------------------');
  }

  if (inventory.authVerification.performed) {
    console.log('VERIFICACIÓN DE CUENTAS FIREBASE AUTH (SEC-03):');
    inventory.authVerification.activeCommercialResults.forEach(r => {
      const statusIcon = (r.authExists && r.uidMatches && r.claimsMatch && !r.disabled) ? '✅ OK' : '❌ DISCREPANCIA';
      console.log(`  [${statusIcon}] CID ${r.cid} (${r.email}):`);
      console.log(`       Auth Existe: ${r.authExists} | UID Coincide: ${r.uidMatches} | Claims Correctos: ${r.claimsMatch} | Deshabilitado: ${r.disabled}`);
      if (r.error) console.log(`       Error: ${r.error}`);
    });
    console.log('================================================================');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL ERROR:', err.message || err);
    process.exit(1);
  });
}

module.exports = { auditUsersProd, parseArgs };
