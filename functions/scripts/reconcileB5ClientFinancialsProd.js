'use strict';

/**
 * functions/scripts/reconcileB5ClientFinancialsProd.js
 *
 * Script administrativo idempotente con soporte de dry-run, respaldo previo (backup) y rollback
 * para sincronizar los agregados financieros B5 (`total_historico_facturado`, `total_historico_cobrado`,
 * `total_dinero_recibido`, `total_cobros_monetarios_aplicados`, `total_retenciones_aplicadas`,
 * `saldo_abonos_pendientes_aplicar`, `saldo_por_cobrar`, `saldo_por_facturar`, `total_ventas_adjudicadas`,
 * `activeBilledProspectsCount`, `es_cliente_historico`, `financialVersion`, `_finProspects`)
 * de los clientes con actividad comercial/financiera en `clients_prod`.
 *
 * Modos de uso:
 * 1. Dry-run (por defecto, 0 escrituras en Firestore):
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --dry-run [--backup <ruta-backup.json>]
 *
 * 2. Aplicación controlada (requiere bandera explícita de confirmación):
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --apply --confirm-b5-reconciliation [--backup <ruta-backup.json>]
 *
 * 3. Rollback desde archivo de respaldo:
 *    node functions/scripts/reconcileB5ClientFinancialsProd.js --rollback <ruta-backup.json> --confirm-b5-rollback
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

const RESTORABLE_FIELDS = [
  'total_historico_facturado',
  'total_historico_cobrado',
  'activeBilledProspectsCount',
  'es_cliente_historico',
  'total_dinero_recibido',
  'total_cobros_monetarios_aplicados',
  'total_retenciones_aplicadas',
  'saldo_abonos_pendientes_aplicar',
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
    } else if (a === '--confirm-b5-rollback') {
      args.confirmRollback = true;
    } else if (a === '--backup' && argv[i + 1]) {
      args.backupFile = argv[++i];
    }
  }
  return args;
}

async function runRollback(db, FieldValue, rollbackFile, confirmRollback) {
  if (!confirmRollback) {
    throw new Error('Para ejecutar rollback debe incluir explícitamente --confirm-b5-rollback');
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(rollbackFile), 'utf8'));
  const docs = Array.isArray(raw.documents) ? raw.documents : [];
  const restored = [];

  for (const entry of docs) {
    const docRef = db.collection(entry.collection || 'clients_prod').doc(entry.docId);
    const before = entry.beforeData || {};
    const patch = {};
    for (const f of RESTORABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(before, f)) {
        patch[f] = before[f];
      } else {
        patch[f] = FieldValue.delete();
      }
    }
    await docRef.update(patch);
    restored.push(entry.docId);
  }

  return {
    mode: 'ROLLBACK_EXECUTED',
    restoredCount: restored.length,
    restoredClientIds: restored
  };
}

async function main() {
  const args = parseArgs(process.argv);
  await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  if (args.rollbackFile) {
    const rbResult = await runRollback(db, FieldValue, args.rollbackFile, args.confirmRollback);
    console.log(JSON.stringify(rbResult, null, 2));
    return;
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

  for (const c of activeClients) {
    const dryRes = await wf.recalculateClientFinancials({
      caller,
      clientId: c.id,
      dryRun: true,
      reason: 'Auditoria previa B5'
    });
    const rec = dryRes.reconciled || {};
    const hasFinancialActivity = (
      rec.total_historico_facturado > 0 ||
      rec.total_historico_cobrado > 0 ||
      rec.total_ventas_adjudicadas > 0 ||
      rec.saldo_abonos_pendientes_aplicar > 0
    );
    if (hasFinancialActivity && dryRes.discrepancyDetected) {
      pendingClients.push({
        clientId: c.id,
        empresa: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim() || c.id,
        nit: c.nit || c.dui || 'S/N',
        previous: dryRes.previous,
        reconciled: dryRes.reconciled
      });
      backupDocs.push({
        collection: `clients${args.suffix}`,
        docId: c.id,
        beforeData: c
      });
    }
  }

  if (args.backupFile) {
    fs.writeFileSync(path.resolve(args.backupFile), JSON.stringify({
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
        opId: `b5_init_sync_${item.clientId}`
      });
      appliedCount += 1;
      results.push({
        clientId: item.clientId,
        empresa: item.empresa,
        status: res.status,
        financialVersion: res.financialVersion,
        reconciled: res.reconciled
      });
    }
  }

  console.log(JSON.stringify({
    mode: args.apply ? 'APPLY_EXECUTED' : 'DRY_RUN_READ_ONLY',
    writesExecuted: appliedCount,
    totalActiveClientsScanned: activeClients.length,
    totalClientsPendingSynchronization: pendingClients.length,
    backupFileWritten: args.backupFile ? path.resolve(args.backupFile) : null,
    pendingClients,
    appliedResults: results
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };

