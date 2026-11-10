// functions/scripts/reconcilePaymentRefsProd.js
// Read-only reconciliation and idempotent backfill planner/executor for `payment_refs_prod`.
// Strictly read-only by default (--dry-run). Never modifies `prospects_prod`, invoices, or payments.
// Excludes any duplicate, colliding, empty, or ambiguous historical reference from automatic backfill.

const { createProspectWorkflowService } = require('../prospectWorkflowService');

const CONFIRM_TOKEN = 'DUCTSAL_PAYMENT_REFS_BACKFILL';
const AMBIGUOUS_PLACEHOLDER_REFS = new Set([
  'NA', 'N/A', 'SN', 'S/N', 'SINREF', 'SINREFERENCIA', 'PENDIENTE',
  'NINGUNA', 'NINGUNO', 'NONE', 'NULL', 'UNDEFINED', '0', '00', '000', '0000'
]);

function normalizePaymentReference(ref) {
  if (typeof ref !== 'string') return '';
  const raw = ref.normalize('NFKC').trim().toUpperCase();
  if (!raw) return '';
  return raw.replace(/[\s\-_./#]+/g, '');
}

function buildPaymentRefLockId({ metodo, normRef }) {
  const cleanMethod = String(metodo || '').trim().toLowerCase();
  if (cleanMethod === 'retencion_1pct') {
    return `RET_${normRef}`;
  }
  return `BANK_${normRef}`;
}

function isActiveInvoiceRecord(fac) {
  if (!fac || typeof fac !== 'object') return false;
  if (
    fac.anulada === true || fac.anulado === true ||
    fac.revertida === true || fac.revertido === true ||
    fac.eliminada === true || fac.eliminado === true ||
    fac.voided === true || fac.reversed === true
  ) {
    return false;
  }
  const estado = typeof fac.estado === 'string' ? fac.estado.trim().toLowerCase() : '';
  if (['anulada', 'anulado', 'eliminada', 'eliminado', 'revertida', 'revertido'].includes(estado)) {
    return false;
  }
  const numero = typeof fac.numero === 'string' ? fac.numero.trim() : '';
  const monto = Number(fac.monto);
  return Boolean(numero && Number.isFinite(monto) && monto > 0);
}

function isActivePaymentRecord(pay) {
  if (!pay || typeof pay !== 'object') return false;
  if (
    pay.anulado === true || pay.anulada === true ||
    pay.revertido === true || pay.revertida === true ||
    pay.eliminado === true || pay.eliminada === true ||
    pay.rechazado === true || pay.rechazada === true ||
    pay.voided === true || pay.reversed === true ||
    pay.promesa === true || pay.es_promesa === true ||
    pay.pendiente_verificacion === true ||
    pay.verificado === false || pay.confirmado === false
  ) {
    return false;
  }
  const estado = typeof pay.estado === 'string' ? pay.estado.trim().toLowerCase() : '';
  if (['anulado', 'anulada', 'eliminado', 'eliminada', 'revertido', 'revertida', 'rechazado', 'rechazada', 'pendiente_verificacion'].includes(estado)) {
    return false;
  }
  return true;
}

/**
 * Pure reconciliation of historical payments in `prospects_prod` against `payment_refs_prod`.
 * @param {Object} params
 * @param {Array<{id: string, data: Object}>} params.prospectsDocs
 * @param {Array<{id: string, data: Object}>} params.paymentRefsDocs
 */
function reconcileHistoricalPaymentRefs({ prospectsDocs = [], paymentRefsDocs = [] }) {
  const existingLocks = new Map();
  for (const doc of paymentRefsDocs) {
    if (doc && doc.id) {
      existingLocks.set(doc.id, doc.data || {});
    }
  }

  let totalProspects = 0;
  let activeProspects = 0;
  let prospectsWithInvoices = 0;
  let totalActiveInvoices = 0;
  let totalActivePayments = 0;
  let inactiveOrVoidedPayments = 0;

  const paymentsMissingRef = [];
  const paymentsAmbiguousRef = [];
  const validOccurrencesByLockId = new Map();

  for (const pDoc of prospectsDocs) {
    if (!pDoc || !pDoc.id) continue;
    totalProspects++;
    const p = pDoc.data || {};
    if (p.eliminado === true) continue;
    activeProspects++;

    const facturas = Array.isArray(p.facturas) ? p.facturas : [];
    const activeFacturas = facturas.filter(isActiveInvoiceRecord);
    if (activeFacturas.length > 0) prospectsWithInvoices++;

    for (const fac of activeFacturas) {
      totalActiveInvoices++;
      const pagos = Array.isArray(fac.pagos) ? fac.pagos : [];
      for (let idx = 0; idx < pagos.length; idx++) {
        const pay = pagos[idx];
        if (!isActivePaymentRecord(pay)) {
          inactiveOrVoidedPayments++;
          continue;
        }
        totalActivePayments++;

        const rawRef = typeof pay.ref === 'string' ? pay.ref.trim() : '';
        const normRef = normalizePaymentReference(rawRef);
        const metodo = typeof pay.metodo === 'string' ? pay.metodo.trim().toLowerCase() : 'transferencia';
        const paymentKey = String(pay.id || pay.fecha || `idx_${idx}`);
        const monto = Math.round((Number(pay.monto) || 0) * 100) / 100;

        const recordSummary = {
          prospectId: pDoc.id,
          prospectCodigo: p.codigo || null,
          clientId: p.clientId || null,
          invoiceId: fac.id || null,
          invoiceNumero: fac.numero || null,
          paymentKey,
          paymentId: pay.id || null,
          fecha: pay.fecha || null,
          metodo,
          monto,
          rawRef,
          normRef,
          opId: pay.opId || null
        };

        if (!normRef) {
          paymentsMissingRef.push({ ...recordSummary, reason: 'EMPTY_NORMALIZED_REF' });
          continue;
        }

        if (AMBIGUOUS_PLACEHOLDER_REFS.has(normRef) || normRef.length < 2) {
          paymentsAmbiguousRef.push({ ...recordSummary, reason: 'AMBIGUOUS_OR_PLACEHOLDER_REF' });
          continue;
        }

        const lockId = buildPaymentRefLockId({ metodo, normRef });
        if (!validOccurrencesByLockId.has(lockId)) {
          validOccurrencesByLockId.set(lockId, []);
        }
        validOccurrencesByLockId.get(lockId).push({ ...recordSummary, lockId });
      }
    }
  }

  let totalBankReferences = 0;
  let totalRetentionReferences = 0;
  const alreadyIndexed = [];
  const readyToIndex = [];
  const collisions = [];

  for (const [lockId, occurrences] of validOccurrencesByLockId.entries()) {
    const isRetention = lockId.startsWith('RET_');
    if (isRetention) {
      totalRetentionReferences++;
    } else {
      totalBankReferences++;
    }

    // Check for collisions / duplicates
    let collisionReason = null;
    if (!isRetention) {
      if (occurrences.length > 1) {
        collisionReason = 'DUPLICATE_BANK_REF_ACROSS_PAYMENTS';
      }
    } else {
      const clientIds = new Set(occurrences.map(o => o.clientId).filter(Boolean));
      const missingClient = occurrences.some(o => !o.clientId);
      if (missingClient) {
        collisionReason = 'RETENTION_MISSING_CLIENT_ID';
      } else if (clientIds.size > 1) {
        collisionReason = 'RETENTION_REF_ACROSS_MULTIPLE_CLIENTS';
      } else {
        const invoiceSlots = new Set();
        for (const occ of occurrences) {
          const slot = `${occ.prospectId}__${occ.invoiceId}`;
          if (invoiceSlots.has(slot)) {
            collisionReason = 'DUPLICATE_RETENTION_REF_SAME_INVOICE';
            break;
          }
          invoiceSlots.add(slot);
        }
      }
    }

    // Also check if existing lock in payment_refs_prod conflicts with historical occurrences
    const existingLock = existingLocks.get(lockId);
    if (!collisionReason && existingLock && existingLock.active !== false) {
      const firstOcc = occurrences[0];
      if (!isRetention) {
        if (
          existingLock.prospectId &&
          (existingLock.prospectId !== firstOcc.prospectId || existingLock.invoiceId !== firstOcc.invoiceId)
        ) {
          collisionReason = 'CONFLICTS_WITH_EXISTING_PAYMENT_REF_LOCK';
        }
      } else if (existingLock.clientId && firstOcc.clientId && existingLock.clientId !== firstOcc.clientId) {
        collisionReason = 'CONFLICTS_WITH_EXISTING_RETENTION_LOCK_CLIENT';
      }
    }

    if (collisionReason) {
      const conflictEntries = {};
      const conflictPayments = occurrences.map((occ, idx) => {
        const entryKey = `${occ.prospectId}__${occ.invoiceId}__${occ.paymentKey || idx}`;
        conflictEntries[entryKey] = {
          prospectId: occ.prospectId,
          prospectCodigo: occ.prospectCodigo || null,
          invoiceId: occ.invoiceId,
          invoiceNumero: occ.invoiceNumero || null,
          paymentKey: occ.paymentKey,
          paymentId: occ.paymentId || null,
          clientId: occ.clientId || null,
          opId: occ.opId || null,
          monto: occ.monto,
          metodo: occ.metodo,
          fecha: occ.fecha || null
        };
        return {
          prospectId: occ.prospectId,
          prospectCodigo: occ.prospectCodigo || null,
          clientId: occ.clientId || null,
          invoiceId: occ.invoiceId,
          invoiceNumero: occ.invoiceNumero || null,
          paymentKey: occ.paymentKey,
          paymentId: occ.paymentId || null,
          fecha: occ.fecha || null,
          metodo: occ.metodo,
          monto: occ.monto,
          rawRef: occ.rawRef,
          normRef: occ.normRef
        };
      });
      const alreadyReservedConflict = Boolean(
        existingLock &&
        existingLock.active !== false &&
        (existingLock.estado === 'conflicto_historico' ||
          existingLock.status === 'conflicto_historico' ||
          existingLock.conflicto_historico === true)
      );
      collisions.push({
        lockId,
        normRef: occurrences[0].normRef,
        metodo: occurrences[0].metodo,
        reason: collisionReason,
        alreadyReservedConflict,
        proposedConflictDoc: {
          active: true,
          estado: 'conflicto_historico',
          status: 'conflicto_historico',
          conflicto_historico: true,
          reason: collisionReason,
          normRef: occurrences[0].normRef,
          ref: occurrences[0].rawRef,
          metodo: occurrences[0].metodo,
          prospectId: null,
          invoiceId: null,
          paymentKey: null,
          clientId: null,
          entries: conflictEntries,
          conflictPayments,
          requiresAdministrativeResolution: true,
          backfilledFromHistorical: true
        },
        occurrences
      });
      continue;
    }

    if (existingLock && existingLock.active !== false) {
      alreadyIndexed.push({
        lockId,
        normRef: occurrences[0].normRef,
        metodo: occurrences[0].metodo,
        occurrences
      });
      continue;
    }

    // Build proposed payment_refs_prod document
    const entries = {};
    for (const occ of occurrences) {
      entries[`${occ.prospectId}__${occ.invoiceId}`] = {
        prospectId: occ.prospectId,
        invoiceId: occ.invoiceId,
        paymentKey: occ.paymentKey,
        clientId: occ.clientId || null,
        opId: occ.opId || null,
        monto: occ.monto,
        metodo: occ.metodo,
        updatedAt: occ.fecha || new Date().toISOString()
      };
    }
    const primary = occurrences[0];
    readyToIndex.push({
      lockId,
      proposedDoc: {
        active: true,
        normRef: primary.normRef,
        ref: primary.rawRef,
        metodo: primary.metodo,
        monto: primary.monto,
        prospectId: primary.prospectId,
        invoiceId: primary.invoiceId,
        clientId: primary.clientId || null,
        paymentKey: primary.paymentKey,
        opId: primary.opId || null,
        entries,
        backfilledFromHistorical: true
      },
      occurrences
    });
  }

  const crossOpportunityReuseRisk = (readyToIndex.length > 0);
  const alreadyReservedConflictsCount = collisions.filter(c => c.alreadyReservedConflict).length;
  const pendingConflictReservationsCount = collisions.length - alreadyReservedConflictsCount;

  return {
    summary: {
      totalProspects,
      activeProspects,
      prospectsWithInvoices,
      totalActiveInvoices,
      totalActivePayments,
      inactiveOrVoidedPayments,
      existingPaymentRefsDocsCount: existingLocks.size,
      totalUniqueValidReferences: validOccurrencesByLockId.size,
      totalBankReferences,
      totalRetentionReferences,
      alreadyIndexedCount: alreadyIndexed.length,
      missingIndexReadyCount: readyToIndex.length,
      collisionsCount: collisions.length,
      alreadyReservedConflictsCount,
      pendingConflictReservationsCount,
      paymentsMissingRefCount: paymentsMissingRef.length,
      paymentsAmbiguousRefCount: paymentsAmbiguousRef.length,
      crossOpportunityReuseRisk,
      requiresIndexInitialization: readyToIndex.length > 0 || pendingConflictReservationsCount > 0
    },
    alreadyIndexed,
    readyToIndex,
    collisions,
    paymentsMissingRef,
    paymentsAmbiguousRef
  };
}

function buildPlanFingerprint(plan) {
  if (!plan) return '';
  const readyIds = (plan.readyToIndex || []).map(r => r.lockId).sort();
  const collisionIds = (plan.collisions || []).map(c => `${c.lockId}:${c.occurrences.length}`).sort();
  const ambigCount = (plan.paymentsMissingRef || []).length + (plan.paymentsAmbiguousRef || []).length;
  return JSON.stringify({ readyIds, collisionIds, ambigCount });
}

/**
 * Idempotent execution of the backfill into `payment_refs${suffix}`.
 * Never modifies `prospects${suffix}`, invoices, or payments.
 * Recalculates the manifest before writing if `recalculateBeforeWrite !== false`.
 * Creates clean index entries and explicit `conflicto_historico` reservations for collisions,
 * while excluding ambiguous/placeholder references (such as "undefined") from any write.
 */
async function executePaymentRefsBackfill({
  db,
  plan,
  suffix = '_prod',
  confirmToken,
  reserveCollisions = true,
  recalculateBeforeWrite = true,
  now = () => new Date()
}) {
  if (confirmToken !== CONFIRM_TOKEN) {
    throw new Error(`Backfill execution aborted: valid confirmToken ('${CONFIRM_TOKEN}') is required.`);
  }
  if (!plan || !Array.isArray(plan.readyToIndex)) {
    throw new Error('Backfill execution requires a valid reconciliation plan.');
  }

  const prospectsColName = `prospects${suffix}`;
  const colName = `payment_refs${suffix}`;

  let effectivePlan = plan;
  let manifestRecalculated = false;
  let stateChangedSinceInitialPlan = false;

  if (recalculateBeforeWrite !== false && db && typeof db.collection === 'function') {
    const [pSnap, rSnap] = await Promise.all([
      db.collection(prospectsColName).get(),
      db.collection(colName).get()
    ]);
    const freshPlan = reconcileHistoricalPaymentRefs({
      prospectsDocs: pSnap.docs.map(d => ({ id: d.id, data: d.data() })),
      paymentRefsDocs: rSnap.docs.map(d => ({ id: d.id, data: d.data() }))
    });
    manifestRecalculated = true;
    stateChangedSinceInitialPlan = buildPlanFingerprint(plan) !== buildPlanFingerprint(freshPlan);
    effectivePlan = freshPlan;
  }

  const results = {
    created: [],
    alreadyExistedSkipped: [],
    conflictReserved: [],
    conflictAlreadyExistedSkipped: [],
    manifestRecalculated,
    stateChangedSinceInitialPlan,
    excludedCollisionsCount: Array.isArray(effectivePlan.collisions) ? effectivePlan.collisions.length : 0,
    excludedAmbiguousCount:
      (Array.isArray(effectivePlan.paymentsMissingRef) ? effectivePlan.paymentsMissingRef.length : 0) +
      (Array.isArray(effectivePlan.paymentsAmbiguousRef) ? effectivePlan.paymentsAmbiguousRef.length : 0)
  };

  const collisionLockIds = new Set((effectivePlan.collisions || []).map(c => c.lockId));
  const candidateMap = new Map();
  for (const item of (plan.readyToIndex || [])) {
    if (item && item.lockId && !collisionLockIds.has(item.lockId)) {
      candidateMap.set(item.lockId, item);
    }
  }
  for (const item of (effectivePlan.readyToIndex || [])) {
    if (item && item.lockId && !collisionLockIds.has(item.lockId)) {
      candidateMap.set(item.lockId, item);
    }
  }

  for (const item of candidateMap.values()) {
    const lockRef = db.collection(colName).doc(item.lockId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(lockRef);
      if (snap.exists && (snap.data() || {}).active !== false) {
        results.alreadyExistedSkipped.push(item.lockId);
        return;
      }
      const nowIso = now().toISOString();
      const payload = {
        ...item.proposedDoc,
        updatedAt: nowIso,
        updatedBy: 'system_historical_backfill'
      };
      if (!snap.exists && typeof tx.create === 'function') {
        tx.create(lockRef, payload);
      } else {
        tx.set(lockRef, payload);
      }
      results.created.push(item.lockId);
    });
  }

  if (reserveCollisions !== false && Array.isArray(effectivePlan.collisions)) {
    for (const collision of effectivePlan.collisions) {
      if (!collision || !collision.lockId || !collision.proposedConflictDoc) continue;
      const lockRef = db.collection(colName).doc(collision.lockId);
      await db.runTransaction(async tx => {
        const snap = await tx.get(lockRef);
        if (snap.exists && (snap.data() || {}).active !== false) {
          results.conflictAlreadyExistedSkipped.push(collision.lockId);
          return;
        }
        const nowIso = now().toISOString();
        const payload = {
          ...collision.proposedConflictDoc,
          updatedAt: nowIso,
          updatedBy: 'system_historical_backfill'
        };
        if (!snap.exists && typeof tx.create === 'function') {
          tx.create(lockRef, payload);
        } else {
          tx.set(lockRef, payload);
        }
        results.conflictReserved.push(collision.lockId);
      });
    }
  }

  return results;
}

module.exports = {
  CONFIRM_TOKEN,
  AMBIGUOUS_PLACEHOLDER_REFS,
  normalizePaymentReference,
  buildPaymentRefLockId,
  reconcileHistoricalPaymentRefs,
  executePaymentRefsBackfill
};

if (require.main === module) {
  const admin = require('firebase-admin');
  const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');

  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const confirmArg = args.find(a => a.startsWith('--confirm-backfill='));
  const confirmToken = confirmArg ? confirmArg.split('=')[1] : '';

  (async () => {
    try {
      await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
      const db = admin.firestore();

      console.log('================================================================');
      console.log('  DUCTSAL ERP — CONCILIACIÓN DE REFERENCIAS HISTÓRICAS DE PAGO  ');
      console.log(`  Modo: ${isExecute ? 'EJECUCIÓN AUTORIZADA' : 'SOLO LECTURA (DRY-RUN)'}`);
      console.log('================================================================');

      const [prospectsSnap, paymentRefsSnap] = await Promise.all([
        db.collection('prospects_prod').get(),
        db.collection('payment_refs_prod').get()
      ]);

      const prospectsDocs = prospectsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
      const paymentRefsDocs = paymentRefsSnap.docs.map(d => ({ id: d.id, data: d.data() }));

      const plan = reconcileHistoricalPaymentRefs({ prospectsDocs, paymentRefsDocs });
      console.log('\n--- RESUMEN DE CONCILIACIÓN ---');
      console.log(JSON.stringify(plan.summary, null, 2));

      if (plan.readyToIndex.length > 0) {
        console.log('\n--- REFERENCIAS HISTÓRICAS PENDIENTES DE INDEXAR ---');
        console.log(JSON.stringify(plan.readyToIndex.map(r => ({
          lockId: r.lockId,
          normRef: r.proposedDoc.normRef,
          rawRef: r.proposedDoc.ref,
          metodo: r.proposedDoc.metodo,
          monto: r.proposedDoc.monto,
          prospectId: r.proposedDoc.prospectId,
          invoiceId: r.proposedDoc.invoiceId,
          clientId: r.proposedDoc.clientId
        })), null, 2));
      }

      if (plan.collisions.length > 0) {
        console.log('\n--- COLISIONES / DUPLICADOS DETECTADOS (EXCLUIDOS) ---');
        console.log(JSON.stringify(plan.collisions, null, 2));
      }

      if (plan.paymentsMissingRef.length > 0 || plan.paymentsAmbiguousRef.length > 0) {
        console.log('\n--- PAGOS SIN REFERENCIA O CON REFERENCIA AMBIGUA (EXCLUIDOS) ---');
        console.log(JSON.stringify({
          missingRef: plan.paymentsMissingRef,
          ambiguousRef: plan.paymentsAmbiguousRef
        }, null, 2));
      }

      if (isExecute) {
        const execRes = await executePaymentRefsBackfill({
          db,
          plan,
          suffix: '_prod',
          confirmToken
        });
        console.log('\n--- RESULTADO DE BACKFILL ---');
        console.log(JSON.stringify(execRes, null, 2));
      } else {
        console.log('\n[DRY-RUN COMPLETADO] Cero escrituras realizadas en Firestore.');
      }
    } catch (err) {
      console.error('[ERROR]', err.message || err);
      process.exit(1);
    }
  })();
}

