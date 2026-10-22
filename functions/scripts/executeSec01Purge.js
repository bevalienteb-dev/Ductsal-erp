// functions/scripts/executeSec01Purge.js
// SEC-01 Controlled Sequential Purge of Historical Plaintext Passwords.
//
// AUTHORIZED SCOPE:
//   Exclusively the 5 verified documents in users_prod:
//     - 1776895495203 (Benjamin Valiente, manager, active)
//     - 1776904494660 (Denys González, manager, active)
//     - 1776904514932 (Alejandra Ayala, gestor, active)
//     - 1788471603604 (Roberto Flores, vendedor, active)
//     - 1784221928346 (Gustavo Velásquez, vendedor, inactive)
//
// SAFEGUARDS:
//   - Zero exposure: NEVER logs, copies, or reveals password values.
//   - Strict project validation: strictly requires 'ductsal-erp'.
//   - Immediate preflight verification before any mutation.
//   - Individual transaction per document with immediate post-read verification.
//   - Hard stop on ANY failure or discrepancy; does not proceed automatically.
//   - Preserves all business fields: id, nombre, email, role, activo, authUid.
//   - Full audit logging in commercialAudit_prod.

const admin = require('firebase-admin');
const { emulatorIsolationProblems } = require('../emulatorGuard');
const { resolveAdminProjectId } = require('./provisionManager');
const { auditUsersProd } = require('./inventoryUsersProd');

const EXPECTED_PROJECT_ID = 'ductsal-erp';

const AUTHORIZED_ACTIVE_CIDS = ['1776895495203', '1776904494660', '1776904514932', '1788471603604'];
const AUTHORIZED_INACTIVE_CID = '1784221928346';

/**
 * Executes the controlled SEC-01 purge against the authorized documents.
 */
async function executeSec01Purge(adminInstance, options = {}) {
  const db = typeof adminInstance.firestore === 'function' ? adminInstance.firestore() : adminInstance.firestore;
  const auth = typeof adminInstance.auth === 'function' ? adminInstance.auth() : adminInstance.auth;
  let FieldValue;
  if (adminInstance.firestore && adminInstance.firestore.FieldValue) {
    FieldValue = adminInstance.firestore.FieldValue;
  } else if (typeof adminInstance.firestore === 'function' && adminInstance.firestore().FieldValue) {
    FieldValue = adminInstance.firestore().FieldValue;
  } else {
    try {
      FieldValue = require('firebase-admin/firestore').FieldValue;
    } catch (_) {
      FieldValue = (admin.firestore && admin.firestore.FieldValue) || {};
    }
  }

  const results = {
    startedAt: new Date().toISOString(),
    preflightPassed: false,
    activeUsersPurged: [],
    inactiveUserPurged: null,
    finalAudit: null,
    success: false
  };

  // =========================================================================
  // FASE 1: Comprobaciones Inmediatas
  // =========================================================================
  console.log('--- FASE 1: Comprobaciones Inmediatas (Preflight) ---');
  const preCheck = await auditUsersProd(adminInstance, { checkAuth: true });

  if (preCheck.totalDocuments !== 5) {
    throw new Error(`CRITERIO DE PARADA: Se esperaban exactamente 5 documentos en users_prod, se encontraron ${preCheck.totalDocuments}. Abortando.`);
  }
  if (preCheck.totalWithPassword !== 5) {
    throw new Error(`CRITERIO DE PARADA: Se esperaban 5 documentos con password, se encontraron ${preCheck.totalWithPassword}. Abortando.`);
  }
  if (preCheck.categories.activeCommercial.count !== 4 || preCheck.categories.activeCommercial.withPassword !== 4) {
    throw new Error('CRITERIO DE PARADA: Inconsistencia en las 4 cuentas comerciales activas. Abortando.');
  }
  if (preCheck.categories.inactiveCommercial.count !== 1 || preCheck.categories.inactiveCommercial.withPassword !== 1) {
    throw new Error('CRITERIO DE PARADA: Inconsistencia en la cuenta inactiva. Abortando.');
  }
  if (preCheck.categories.plantFabrication.count !== 0 || preCheck.categories.unknownRecords.count !== 0) {
    throw new Error('CRITERIO DE PARADA: Se detectaron cuentas de planta o desconocidas en users_prod. Abortando.');
  }

  // Verificar Auth en las 4 cuentas activas
  for (const authRes of preCheck.authVerification.activeCommercialResults) {
    if (!authRes.authExists || !authRes.uidMatches || !authRes.claimsMatch || authRes.disabled || !authRes.lastSignInTimePresent) {
      throw new Error(`CRITERIO DE PARADA: La cuenta ${authRes.cid} (${authRes.email}) falló la verificación de Auth: ${JSON.stringify(authRes)}. Abortando.`);
    }
  }

  // Verificar cuenta inactiva
  const inactiveDocSnap = await db.collection('users_prod').doc(AUTHORIZED_INACTIVE_CID).get();
  if (!inactiveDocSnap.exists) {
    throw new Error(`CRITERIO DE PARADA: Documento inactivo ${AUTHORIZED_INACTIVE_CID} no existe.`);
  }
  const inactiveData = inactiveDocSnap.data() || {};
  if (inactiveData.activo !== false || inactiveData.authUid) {
    throw new Error(`CRITERIO DE PARADA: Cuenta ${AUTHORIZED_INACTIVE_CID} tiene activo !== false o authUid presente.`);
  }

  results.preflightPassed = true;
  console.log('✅ Fase 1 superada: 5 documentos confirmados, 4 cuentas activas con sesión verificada, 1 cuenta inactiva sin Auth.');

  // =========================================================================
  // FASE 2: Purga de los Cuatro Usuarios Activos
  // =========================================================================
  console.log('\n--- FASE 2: Purga Atómica de los Cuatro Usuarios Activos ---');

  for (const cid of AUTHORIZED_ACTIVE_CIDS) {
    const docRef = db.collection('users_prod').doc(cid);

    // Ejecución atómica en transacción
    const txResult = await db.runTransaction(async tx => {
      const snap = await tx.get(docRef);
      if (!snap.exists) throw new Error(`Documento ${cid} no existe en transacción.`);
      const d = snap.data() || {};

      if (!d.authUid) throw new Error(`Documento ${cid} carece de authUid en transacción.`);
      if (d.activo !== true) throw new Error(`Documento ${cid} no está activo en transacción.`);

      // Validar Auth
      const authUser = await auth.getUser(d.authUid);
      if (authUser.disabled) throw new Error(`Cuenta Auth de ${cid} está deshabilitada.`);
      if (!authUser.metadata || !authUser.metadata.lastSignInTime) {
        throw new Error(`Cuenta Auth de ${cid} no tiene lastSignInTime registrado.`);
      }

      if (d.password === undefined) {
        return { status: 'already-purged', cid };
      }

      tx.update(docRef, { password: FieldValue.delete() });

      // Registro de auditoría
      const auditRef = db.collection('commercialAudit_prod').doc();
      tx.set(auditRef, {
        action: 'purgeHistoricalPassword',
        targetId: cid,
        authUid: d.authUid,
        email: d.email || '',
        actor: { uid: 'sec01-executor', role: 'admin_cli' },
        timestamp: FieldValue.serverTimestamp()
      });

      return { status: 'purged', cid };
    });

    // Inmediata comprobación posterior (Post-check)
    const postSnap = await docRef.get();
    const postData = postSnap.data() || {};

    if (postData.password !== undefined) {
      throw new Error(`FALLO CRÍTICO: El campo password sigue presente en ${cid} tras la actualización. Abortando.`);
    }
    if (!postData.authUid || postData.activo !== true || !postData.email || !postData.role) {
      throw new Error(`FALLO CRÍTICO: Los campos comerciales de ${cid} fueron alterados indebidamente.`);
    }

    const logEntry = {
      cid,
      status: txResult.status,
      hasPassword: false,
      authUid: postData.authUid,
      role: postData.role,
      email: postData.email,
      timestamp: new Date().toISOString()
    };
    results.activeUsersPurged.push(logEntry);
    console.log(`  [✅ PURGADO] CID ${cid} (${postData.email}): status=${txResult.status}, hasPassword=false, authUid=${postData.authUid}`);
  }

  // =========================================================================
  // FASE 3: Purga del Perfil Comercial Inactivo (1784221928346)
  // =========================================================================
  console.log('\n--- FASE 3: Purga del Perfil Comercial Inactivo (1784221928346) ---');
  const inactiveRef = db.collection('users_prod').doc(AUTHORIZED_INACTIVE_CID);

  const inactiveTxResult = await db.runTransaction(async tx => {
    const snap = await tx.get(inactiveRef);
    if (!snap.exists) throw new Error(`Documento ${AUTHORIZED_INACTIVE_CID} no existe.`);
    const d = snap.data() || {};

    if (d.activo !== false) throw new Error(`Documento ${AUTHORIZED_INACTIVE_CID} no tiene activo === false.`);
    if (d.authUid) throw new Error(`Documento ${AUTHORIZED_INACTIVE_CID} tiene authUid inesperado.`);

    if (d.password === undefined) {
      return { status: 'already-purged', cid: AUTHORIZED_INACTIVE_CID };
    }

    tx.update(inactiveRef, { password: FieldValue.delete() });

    const auditRef = db.collection('commercialAudit_prod').doc();
    tx.set(auditRef, {
      action: 'purgeHistoricalPasswordInactive',
      targetId: AUTHORIZED_INACTIVE_CID,
      actor: { uid: 'sec01-executor', role: 'admin_cli' },
      timestamp: FieldValue.serverTimestamp()
    });

    return { status: 'purged', cid: AUTHORIZED_INACTIVE_CID };
  });

  // Post-check inactivo
  const postInactiveSnap = await inactiveRef.get();
  const postInactiveData = postInactiveSnap.data() || {};

  if (postInactiveData.password !== undefined) {
    throw new Error(`FALLO CRÍTICO: El campo password sigue presente en ${AUTHORIZED_INACTIVE_CID}.`);
  }
  if (postInactiveData.activo !== false || postInactiveData.authUid) {
    throw new Error(`FALLO CRÍTICO: El estado de ${AUTHORIZED_INACTIVE_CID} fue alterado indebidamente.`);
  }

  results.inactiveUserPurged = {
    cid: AUTHORIZED_INACTIVE_CID,
    status: inactiveTxResult.status,
    hasPassword: false,
    activo: postInactiveData.activo,
    timestamp: new Date().toISOString()
  };
  console.log(`  [✅ PURGADO] CID ${AUTHORIZED_INACTIVE_CID} (Gustavo Velásquez): status=${inactiveTxResult.status}, activo=false, hasPassword=false`);

  // =========================================================================
  // FASE 4: Auditoría Posterior Completa
  // =========================================================================
  console.log('\n--- FASE 4: Auditoría Posterior Completa ---');
  const finalAudit = await auditUsersProd(adminInstance, { checkAuth: true });
  results.finalAudit = finalAudit;

  if (finalAudit.totalDocuments !== 5) {
    throw new Error(`FALLO DE AUDITORÍA FINAL: Total de documentos es ${finalAudit.totalDocuments} (esperado: 5).`);
  }
  if (finalAudit.totalWithPassword !== 0) {
    throw new Error(`FALLO DE AUDITORÍA FINAL: Documentos con password es ${finalAudit.totalWithPassword} (esperado: 0).`);
  }
  if (finalAudit.totalWithoutPassword !== 5) {
    throw new Error(`FALLO DE AUDITORÍA FINAL: Documentos sin password es ${finalAudit.totalWithoutPassword} (esperado: 5).`);
  }

  // Certificar UIDs y Claims en auditoría final
  for (const authRes of finalAudit.authVerification.activeCommercialResults) {
    if (!authRes.authExists || !authRes.uidMatches || !authRes.claimsMatch || authRes.disabled) {
      throw new Error(`FALLO DE AUDITORÍA FINAL en Auth para CID ${authRes.cid}.`);
    }
  }

  results.success = true;
  results.completedAt = new Date().toISOString();
  console.log('✅ FASE 4 SUPERADA: 0 documentos con password en users_prod. 100% de identidades comerciales intactas y operativas.');

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const allowProd = args.includes('--allow-authorized-production-run');
  const targetProject = args.includes('--project') ? args[args.indexOf('--project') + 1] : EXPECTED_PROJECT_ID;

  if (!allowProd) {
    const problems = emulatorIsolationProblems(process.env, { strict: true });
    if (problems.length > 0) {
      console.error('Refusing to run: Environment is not provably isolated emulators:\n - ' + problems.join('\n - '));
      process.exit(2);
    }
  }

  if (targetProject !== EXPECTED_PROJECT_ID) {
    console.error(`FATAL: Execution strictly restricted to project '${EXPECTED_PROJECT_ID}'. Received '${targetProject}'.`);
    process.exit(1);
  }

  if (!admin.apps.length) {
    if (allowProd) {
      try {
        const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
        await initializeImpersonatedAdminApp(admin, { projectId: EXPECTED_PROJECT_ID });
      } catch (_) {
        admin.initializeApp({ projectId: EXPECTED_PROJECT_ID });
      }
    } else {
      admin.initializeApp({ projectId: 'demo-ductsal-isolated' });
    }
  }

  const resolution = resolveAdminProjectId(admin);
  if (resolution.contradiction || resolution.projectId !== EXPECTED_PROJECT_ID) {
    console.error(`FATAL: Contradiction or invalid project: ${JSON.stringify(resolution)}`);
    process.exit(1);
  }

  const results = await executeSec01Purge(admin, { allowProd });
  console.log('\n================================================================');
  console.log('      SEC-01: PURGA HISTÓRICA COMPLETADA EXITOSAMENTE           ');
  console.log('================================================================');
  console.log(JSON.stringify({
    success: results.success,
    activeUsersPurged: results.activeUsersPurged.length,
    inactiveUserPurged: Boolean(results.inactiveUserPurged),
    totalWithPasswordRemaining: results.finalAudit.totalWithPassword,
    completedAt: results.completedAt
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ ERROR DURANTE LA PURGA:', err.message || err);
    process.exit(1);
  });
}

module.exports = { executeSec01Purge };
