'use strict';

/**
 * functions/scripts/reconcileB5ClientFinancialsProd.js
 *
 * Script administrativo idempotente con soporte de dry-run, respaldo previo obligatorio (backup),
 * control de concurrencia optimista (`financialVersion` / fail-fast OCC), validación de invariantes
 * matemáticas B5 y rollback auditado no destructivo para sincronizar los agregados financieros B5
 * (`total_historico_facturado`, `total_historico_cobrado`, `total_dinero_recibido`,
 * `total_cobros_monetarios_aplicados`, `total_retenciones_aplicadas`,
 * `saldo_abonos_pendientes_aplicar`, `saldo_a_favor`, `importe_pendiente_aplicar`,
 * `saldo_por_cobrar`, `saldo_por_facturar`, `total_ventas_adjudicadas`,
 * `activeBilledProspectsCount`, `es_cliente_historico`, `financialVersion`, `_finProspects`)
 * de los clientes con actividad comercial/financiera en `clients_prod`.
 *
 * Modos de uso:
 * 1. Dry-run (por defecto, 0 escrituras en Firestore):
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --dry-run [--backup <ruta-backup.json>]
 *
 * 2. Aplicación controlada (requiere bandera explícita de confirmación y genera backup previo obligatorio):
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --apply --confirm-b5-reconciliation [--backup <ruta-backup.json>]
 *
 * 3. Rollback auditado desde archivo de respaldo (protege mutaciones posteriores al despliegue):
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --rollback <ruta-backup.json> --confirm-b5-rollback
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

const toCents = n => Math.round((Number(n) || 0) * 100);

const RESTORABLE_FIELDS = [
  'total_historico_facturado',
  'total_historico_cobrado',
  'activeBilledProspectsCount',
  'es_cliente_historico',
  'total_dinero_recibido',
  'total_cobros_monetarios_aplicados',
  'total_retenciones_aplicadas',
  'saldo_abonos_pendientes_aplicar',
  'saldo_a_favor',
  'importe_pendiente_aplicar',
  'saldo_por_cobrar',
  'saldo_por_cobrar_vivo',
  'saldo_facturado_pendiente_cobrar',
  'saldo_por_facturar',
  'saldo_por_facturar_vivo',
  'total_ventas_adjudicadas',
  'financialVersion',
  'lastFinancialMutationAt',
  'lastReconciledAt',
  '_finProspects'
];

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    confirmApply: false,
    rollbackFile: null,
    confirmRollback: false,
    backupFile: null,
    suffix: '_prod'
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (a === '--confirm-b5-reconciliation') {
      args.confirmApply = true;
    } else if (a === '--rollback' && argv[i + 1]) {
      args.rollbackFile = argv[++i];
      args.dryRun = false;
    } else if (a.startsWith('--rollback=')) {
      args.rollbackFile = a.slice('--rollback='.length);
      args.dryRun = false;
    } else if (a === '--confirm-b5-rollback') {
      args.confirmRollback = true;
    } else if (a === '--backup' && argv[i + 1]) {
      args.backupFile = argv[++i];
    } else if (a.startsWith('--backup=')) {
      args.backupFile = a.slice('--backup='.length);
    } else if (a === '--suffix' && argv[i + 1]) {
      args.suffix = argv[++i];
    } else if (a.startsWith('--suffix=')) {
      args.suffix = a.slice('--suffix='.length);
    }
  }
  return args;
}

function validateClientFinancialInvariants(rec) {
  if (!rec || typeof rec !== 'object') {
    return { valid: false, reasons: ['reconciled object is missing'] };
  }
  const reasons = [];
  const factCents = toCents(rec.total_historico_facturado);
  const cobCents = toCents(rec.total_historico_cobrado);
  const monCents = toCents(rec.total_cobros_monetarios_aplicados);
  const retCents = toCents(rec.total_retenciones_aplicadas);
  const recCents = toCents(rec.total_dinero_recibido);
  const abonosPendCents = toCents(rec.saldo_abonos_pendientes_aplicar);
  const favorCents = toCents(rec.saldo_a_favor);
  const impPendCents = toCents(rec.importe_pendiente_aplicar);
  const cxcCents = toCents(rec.saldo_por_cobrar);

  if (cobCents !== monCents + retCents) {
    reasons.push(`total_historico_cobrado (${cobCents}) !== monetarios (${monCents}) + retenciones (${retCents})`);
  }
  if (factCents - cobCents !== cxcCents - favorCents) {
    reasons.push(`facturado - cobrado (${factCents - cobCents}) !== saldo_por_cobrar - saldo_a_favor (${cxcCents - favorCents})`);
  }
  if (recCents < monCents + abonosPendCents) {
    reasons.push(`total_dinero_recibido (${recCents}) < cobros_monetarios (${monCents}) + abonos_pendientes (${abonosPendCents})`);
  }
  if (impPendCents !== abonosPendCents + favorCents) {
    reasons.push(`importe_pendiente_aplicar (${impPendCents}) !== abonos_pendientes (${abonosPendCents}) + saldo_a_favor (${favorCents})`);
  }
  return {
    valid: reasons.length === 0,
    reasons
  };
}

async function runRollback(db, FieldValue, rollbackFile, confirmRollback, suffix = '_prod') {
  if (!confirmRollback) {
    throw new Error('Para ejecutar rollback debe incluir explícitamente --confirm-b5-rollback');
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(rollbackFile), 'utf8'));
  const docs = Array.isArray(raw.documents) ? raw.documents : [];
  const restored = [];
  const skippedConcurrent = [];

  for (const entry of docs) {
    const colName = entry.collection || `clients${suffix}`;
    const docRef = db.collection(colName).doc(entry.docId);
    const before = entry.beforeData || {};
    const expectedMaxVersion = typeof entry.expectedPostApplyVersion === 'number'
      ? entry.expectedPostApplyVersion
      : ((typeof before.financialVersion === 'number' ? before.financialVersion : 0) + 1);

    await db.runTransaction(async tx => {
      const liveSnap = await tx.get(docRef);
      if (!liveSnap.exists) return;
      const liveData = liveSnap.data() || {};
      const liveVersion = typeof liveData.financialVersion === 'number' ? liveData.financialVersion : 0;

      // No destruir movimientos bancarios ni facturas registrados después de la reconciliación
      if (liveVersion > expectedMaxVersion) {
        skippedConcurrent.push({
          clientId: entry.docId,
          liveFinancialVersion: liveVersion,
          expectedMaxVersion,
          reason: 'Cliente presenta movimientos financieros posteriores a la reconciliación; se preserva estado actual para no destruir operaciones recientes.'
        });
        return;
      }

      const patch = {};
      for (const f of RESTORABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(before, f)) {
          patch[f] = before[f];
        } else {
          patch[f] = FieldValue.delete();
        }
      }
      tx.update(docRef, patch);

      const auditRef = db.collection(`audit_logs${suffix}`).doc();
      tx.create(auditRef, {
        action: 'rollbackB5ClientFinancials',
        entityType: 'client',
        entityId: entry.docId,
        timestamp: new Date().toISOString(),
        actorId: 'SYSTEM_ADMIN_B5',
        actorName: 'Rollback Auditado B5',
        detail: {
          rollbackFile: path.basename(rollbackFile),
          restoredFinancialVersion: before.financialVersion || 0,
          previousLiveVersion: liveVersion
        }
      });
      restored.push(entry.docId);
    });
  }

  return {
    mode: 'ROLLBACK_EXECUTED',
    restoredCount: restored.length,
    restoredClientIds: restored,
    skippedPostDeployMutationsCount: skippedConcurrent.length,
    skippedPostDeployMutations: skippedConcurrent
  };
}

async function executeReconciliation({ db, FieldValue, args }) {
  if (args.rollbackFile) {
    return runRollback(db, FieldValue, args.rollbackFile, args.confirmRollback, args.suffix);
  }

  if (args.apply && !args.confirmApply) {
    throw new Error('Por seguridad, --apply requiere incluir --confirm-b5-reconciliation');
  }

  const commercial = createCommercialService({
    db,
    FieldValue,
    suffix: args.suffix,
    now: () => new Date(),
    verifyManager: async () => true
  });
  const wf = createProspectWorkflowService({
    db,
    FieldValue,
    kit: commercial.kit
  });

  const caller = {
    uid: 'system-admin-b5-reconciler',
    cid: 'SYSTEM_ADMIN_B5',
    name: 'Reconciliación Histórica B5',
    role: 'manager',
    active: true
  };

  const clientsSnap = await db.collection(`clients${args.suffix}`).get();
  const activeClients = clientsSnap.docs
    .map(d => ({ id: d.id, ...(d.data() || {}) }))
    .filter(c => c.eliminado !== true);

  const pendingClients = [];
  const backupDocs = [];
  const invariantFailures = [];

  for (const c of activeClients) {
    const dryRes = await wf.recalculateClientFinancials({
      caller,
      clientId: c.id,
      dryRun: true,
      reason: 'Auditoria previa B5'
    });
    const rec = dryRes.reconciled || {};
    const invCheck = validateClientFinancialInvariants(rec);
    if (!invCheck.valid) {
      invariantFailures.push({
        clientId: c.id,
        empresa: c.empresa || c.id,
        reasons: invCheck.reasons
      });
    }

    const hasFinancialActivity = (
      rec.total_historico_facturado > 0 ||
      rec.total_historico_cobrado > 0 ||
      rec.total_ventas_adjudicadas > 0 ||
      rec.saldo_abonos_pendientes_aplicar > 0 ||
      rec.saldo_a_favor > 0
    );
    if (hasFinancialActivity && dryRes.discrepancyDetected) {
      pendingClients.push({
        clientId: c.id,
        canonicalClientId: dryRes.canonicalClientId,
        clusterIds: dryRes.clusterIds,
        preScanVersion: dryRes.preScanVersion,
        empresa: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim() || c.id,
        nit: c.nit || c.dui || 'S/N',
        previous: dryRes.previous,
        reconciled: dryRes.reconciled,
        invariantsValid: invCheck.valid
      });
      backupDocs.push({
        collection: `clients${args.suffix}`,
        docId: c.id,
        preScanVersion: dryRes.preScanVersion,
        expectedPostApplyVersion: dryRes.preScanVersion + 1,
        beforeData: c
      });
    }
  }

  if (invariantFailures.length > 0) {
    const err = new Error(`DISCREPANCIA_MATERIAL_NO_RESUELTA: Se detectaron ${invariantFailures.length} clientes con invariantes financieras inválidas. Reconciliación abortada.`);
    err.invariantFailures = invariantFailures;
    throw err;
  }

  // En modo --apply, generar respaldo previo es obligatorio antes de cualquier escritura
  const effectiveBackupFile = args.backupFile || (args.apply
    ? path.resolve(process.cwd(), `backup_b5_clients_${Date.now()}.json`)
    : null);

  if (effectiveBackupFile) {
    fs.writeFileSync(path.resolve(effectiveBackupFile), JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectId: 'ductsal-erp',
      suffix: args.suffix,
      totalClientsBackedUp: backupDocs.length,
      documents: backupDocs
    }, null, 2));
  }

  let appliedCount = 0;
  const results = [];

  if (args.apply && args.confirmApply) {
    for (const item of pendingClients) {
      const res = await wf.recalculateClientFinancials({
        caller,
        clientId: item.clientId,
        dryRun: false,
        reason: 'Sincronización inicial controlada Fase B5',
        opId: `b5_init_sync_${item.clientId}`,
        expectedFinancialVersion: item.preScanVersion,
        failFastOnOcc: true
      });
      appliedCount += 1;
      results.push({
        clientId: item.clientId,
        empresa: item.empresa,
        status: res.status,
        preScanVersion: item.preScanVersion,
        financialVersion: res.financialVersion,
        reconciled: res.reconciled
      });
    }
  }

  return {
    mode: args.apply ? 'APPLY_EXECUTED' : 'DRY_RUN_READ_ONLY',
    writesExecuted: appliedCount,
    totalActiveClientsScanned: activeClients.length,
    totalClientsPendingSynchronization: pendingClients.length,
    allInvariantsValid: invariantFailures.length === 0,
    backupFileWritten: effectiveBackupFile ? path.resolve(effectiveBackupFile) : null,
    pendingClients,
    appliedResults: results
  };
}

async function main() {
  const args = parseArgs(process.argv);
  await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const out = await executeReconciliation({ db, FieldValue, args });
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, executeReconciliation, validateClientFinancialInvariants, runRollback, RESTORABLE_FIELDS };
