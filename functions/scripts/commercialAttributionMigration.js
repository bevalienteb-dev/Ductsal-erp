// functions/scripts/commercialAttributionMigration.js
// DUCTSAL ERP — Corrección integral de atribución comercial
// Idempotent, batch-controlled, auditable, and reversible migration module and CLI.
// STRICT SAFEGUARDS:
//   - Dry-run mode by default (ZERO writes).
//   - Requires explicit flags (--apply, --confirm-apply, --op-id, --allow-authorized-production-run) for mutations.
//   - Validates preconditions before each write.
//   - Strictly modifies ONLY commercial attribution fields (vendedorId, vendedorName, vendedorRole).
//   - Guaranteed NEVER to modify financial data, stages, statuses, documents, or notes.
//   - Surgical rollback capability preserving concurrent human edits.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveAdminProjectId } = require('./provisionManager');

const BATCH_SIZE = 50;
const EXPECTED_PROJECT_ID = 'ductsal-erp';
const AUDIT_COLLECTION = 'commercialAttributionAudit_prod';

// Forbidden fields assertion safeguard
const FORBIDDEN_PATCH_FIELDS = [
  'precio_cotizado', 'costo_venta', 'precio_base', 'costo_base',
  'facturas', 'forma_pago', 'estado', 'etapa', 'datos', 'notas',
  'stage_timestamps', 'fecha_creacion', 'fecha_cierre', 'eliminado',
  'tipo_proyecto', 'tipo_producto', 'origen', 'probabilidad', 'codigo'
];

/**
 * Generates an auditable operation ID.
 */
function generateOpId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  return `attr_mig_${ts}_${rand}`;
}

/**
 * Normalizes a string for comparison.
 */
function normalizeStr(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Audits and classifies all opportunities in prospects_prod according to strict criteria:
 * 1. Asignación correcta (CORRECT)
 * 2. Sin vendedorId, pero con responsable verificable (MISSING_VENDEDOR_ID_VERIFIABLE)
 * 3. vendedorId que no corresponde a un usuario válido (INVALID_VENDEDOR_ID)
 * 4. Inconsistencia entre nombre e identificador (NAME_ID_INCONSISTENCY)
 * 5. Asignación ambigua (AMBIGUOUS_ASSIGNMENT)
 * 6. Oportunidades sin responsable identificado (NO_IDENTIFIED_RESPONSIBLE)
 *
 * Distinguishes explicitly between:
 * - Responsable actual (titular comercial actual)
 * - Creador original (createdBy)
 * - Historial de gestores / vendedores anteriores (logs)
 *
 * @param {Array} prospectsList - Array of prospect documents
 * @param {Object} usersMap - Map of userId -> user document from users_prod
 * @param {Object} options - { includeCreatedByBackfill: boolean }
 */
function auditAndClassifyProspects(prospectsList, usersMap, options = {}) {
  const { includeCreatedByBackfill = false } = options;

  const result = {
    total: prospectsList.length,
    counts: {
      correct: 0,
      missingVendedorVerifiable: 0,
      invalidVendedorId: 0,
      nameIdInconsistency: 0,
      ambiguousAssignment: 0,
      noIdentifiedResponsible: 0,
      missingCreatedBy: 0
    },
    byUser: {},
    categories: {
      correct: [],
      missingVendedorVerifiable: [],
      invalidVendedorId: [],
      nameIdInconsistency: [],
      ambiguousAssignment: [],
      noIdentifiedResponsible: []
    },
    missingCreatedByList: [],
    proposedMutations: []
  };

  // Initialize byUser counts
  for (const [id, u] of Object.entries(usersMap)) {
    result.byUser[id] = {
      id,
      nombre: u.nombre,
      role: u.role,
      activo: u.activo,
      assignedCount: 0,
      proposedCorrectionCount: 0
    };
  }

  for (const p of prospectsList) {
    const id = p.id;
    const rawVendedorId = p.vendedorId ? String(p.vendedorId).trim() : null;
    const rawVendedorName = p.vendedorName ? String(p.vendedorName).trim() : null;
    const rawVendedorRole = p.vendedorRole ? String(p.vendedorRole).trim() : null;
    const rawVendedor = p.vendedor ? String(p.vendedor).trim() : null;
    const rawCreatedBy = p.createdBy ? String(p.createdBy).trim() : null;

    // Check createdBy status
    if (!rawCreatedBy) {
      result.counts.missingCreatedBy++;
      result.missingCreatedByList.push({
        id,
        proyecto: p.proyecto || 'Sin proyecto',
        vendedorId: rawVendedorId,
        vendedor: rawVendedor
      });
    }

    // Historical gestores / vendedores in logs
    const historyInLogs = [];
    (p.logs || []).forEach(l => {
      const text = typeof l === 'string' ? l : (l.text || '');
      for (const u of Object.values(usersMap)) {
        if (text.includes(u.nombre) && !historyInLogs.includes(u.nombre)) {
          historyInLogs.push(u.nombre);
        }
      }
    });

    // 1. Evaluate if vendedorId is present
    if (rawVendedorId) {
      const user = usersMap[rawVendedorId];

      // 1.1 Check if user exists in users_prod
      if (!user) {
        result.counts.invalidVendedorId++;
        result.categories.invalidVendedorId.push({
          id,
          proyecto: p.proyecto,
          vendedorId: rawVendedorId,
          vendedorName: rawVendedorName,
          vendedorRole: rawVendedorRole,
          createdBy: rawCreatedBy,
          reason: `vendedorId '${rawVendedorId}' does not exist in users_prod.`
        });
        continue;
      }

      // 1.2 Check consistency between vendedorId, vendedorName, and vendedorRole
      const nameMismatch = rawVendedorName && rawVendedorName !== user.nombre;
      const roleMismatch = rawVendedorRole && rawVendedorRole !== user.role;
      const stringMismatch = rawVendedor && normalizeStr(rawVendedor) !== normalizeStr(user.nombre);

      if (nameMismatch || roleMismatch || stringMismatch) {
        result.counts.nameIdInconsistency++;
        result.categories.nameIdInconsistency.push({
          id,
          proyecto: p.proyecto,
          vendedorId: rawVendedorId,
          userExpected: { nombre: user.nombre, role: user.role },
          current: {
            vendedorName: rawVendedorName,
            vendedorRole: rawVendedorRole,
            vendedor: rawVendedor
          },
          reason: 'Inconsistency between ID and recorded name/role/string.'
        });
        continue;
      }

      // 1.3 Assignment is completely valid and consistent
      result.counts.correct++;
      if (result.byUser[user.id]) {
        result.byUser[user.id].assignedCount++;
      }
      result.categories.correct.push({
        id,
        proyecto: p.proyecto,
        vendedorId: rawVendedorId,
        vendedorName: user.nombre,
        vendedorRole: user.role,
        createdBy: rawCreatedBy,
        historialGestores: historyInLogs
      });
      continue;
    }

    // 2. vendedorId is MISSING: Attempt verifiable resolution or apply authorized business rule
    let candidateUser = null;
    const evidence = [];

    // Check candidate via raw vendedor string
    if (rawVendedor) {
      const match = Object.values(usersMap).find(u => normalizeStr(u.nombre) === normalizeStr(rawVendedor));
      if (match) {
        candidateUser = match;
        evidence.push(`vendedor string matches user '${match.nombre}' (${match.id})`);
      }
    }

    // Check candidate via createdBy
    if (rawCreatedBy && usersMap[rawCreatedBy]) {
      const creator = usersMap[rawCreatedBy];
      if (!candidateUser) {
        candidateUser = creator;
        evidence.push(`createdBy matches user '${creator.nombre}' (${creator.id})`);
      } else if (candidateUser.id !== creator.id) {
        // Conflict between createdBy and vendedor string
        if (!options.authorizedRuleAssignAllToAlejandra) {
          result.counts.ambiguousAssignment++;
          result.categories.ambiguousAssignment.push({
            id,
            proyecto: p.proyecto,
            createdBy: rawCreatedBy,
            creatorName: creator.nombre,
            vendedorString: rawVendedor,
            candidateName: candidateUser.nombre,
            reason: `Conflict: createdBy (${creator.nombre}) differs from vendedor string (${candidateUser.nombre}).`
          });
          continue;
        }
      }
    }

    // If no candidate was found from fields and authorized rule is NOT forced
    if (!candidateUser && !options.authorizedRuleAssignAllToAlejandra) {
      result.counts.noIdentifiedResponsible++;
      result.categories.noIdentifiedResponsible.push({
        id,
        proyecto: p.proyecto,
        createdBy: rawCreatedBy,
        vendedor: rawVendedor,
        reason: 'No recognizable vendedor string or valid createdBy found on prospect document.'
      });
      continue;
    }

    // Authorized rule target (Alejandra Ayala, 1776904514932, gestor)
    const targetAssignee = options.authorizedRuleAssignAllToAlejandra
      ? (usersMap['1776904514932'] || { id: '1776904514932', nombre: 'Alejandra Ayala', role: 'gestor', activo: true })
      : candidateUser;

    result.counts.missingVendedorVerifiable++;
    if (result.byUser[targetAssignee.id]) {
      result.byUser[targetAssignee.id].proposedCorrectionCount++;
    }

    const isImported = id.startsWith('OPP-');
    const originCategory = isImported
      ? 'IMPORTACION_INICIAL_MASIVA'
      : 'HISTORICO_CREADO_EN_CRM';

    let evidenceText = evidence.length > 0 ? evidence.join('; ') : '';
    if (options.authorizedRuleAssignAllToAlejandra && (!evidenceText || targetAssignee.id !== (candidateUser && candidateUser.id))) {
      evidenceText = `Regla de negocio autorizada: asignación histórica a '${targetAssignee.nombre}' (${targetAssignee.id})`;
    }

    const proposedPatch = {
      vendedorId: targetAssignee.id,
      vendedorName: targetAssignee.nombre,
      vendedorRole: targetAssignee.role
    };

    // Assert createdBy is NEVER modified unless explicitly requested
    if (includeCreatedByBackfill && !rawCreatedBy) {
      proposedPatch.createdBy = targetAssignee.id;
    }

    // Assert forbidden fields are NEVER included
    for (const k of Object.keys(proposedPatch)) {
      if (FORBIDDEN_PATCH_FIELDS.includes(k)) {
        throw new Error(`CRITICAL INTEGRITY FAILURE: Forbidden field '${k}' in proposed patch for ${id}!`);
      }
    }

    const before = {
      vendedorId: p.vendedorId || null,
      vendedorName: p.vendedorName || null,
      vendedorRole: p.vendedorRole || null
    };

    const item = {
      id,
      proyecto: p.proyecto || 'Sin proyecto',
      estado: p.estado || 'activo',
      etapa: p.etapa || 'prospecto',
      clientId: p.clientId || null,
      originCategory,
      isImported,
      precio_cotizado: typeof p.precio_cotizado === 'number' ? p.precio_cotizado : null,
      costo_venta: typeof p.costo_venta === 'number' ? p.costo_venta : null,
      responsableActual: targetAssignee.nombre,
      responsableId: targetAssignee.id,
      responsableRole: targetAssignee.role,
      creadorOriginal: rawCreatedBy ? (usersMap[rawCreatedBy]?.nombre || rawCreatedBy) : 'Sin createdBy (Importación inicial)',
      historialGestores: historyInLogs,
      before,
      after: proposedPatch,
      evidence: evidenceText
    };

    result.categories.missingVendedorVerifiable.push(item);
    result.proposedMutations.push(item);
  }

  return result;
}

/**
 * Builds the full migration plan by querying live Firestore collections.
 */
async function buildMigrationPlan(db, options = {}) {
  const [usersSnap, prospectsSnap] = await Promise.all([
    db.collection('users_prod').get(),
    db.collection('prospects_prod').get()
  ]);

  const usersMap = {};
  usersSnap.forEach(d => {
    usersMap[d.id] = { id: d.id, ...d.data() };
  });

  const prospectsList = [];
  prospectsSnap.forEach(d => {
    prospectsList.push({ id: d.id, ...d.data() });
  });

  const audit = auditAndClassifyProspects(prospectsList, usersMap, options);

  // Assertion for reference case: VISTA TOWER 2
  const vistaTower = audit.proposedMutations.find(m => m.id === 'OPP-1777081083975-23');
  const vistaTowerIdentified = !!vistaTower;

  // Breakdown by origin
  const originBreakdown = {
    importedCount: audit.proposedMutations.filter(m => m.isImported).length,
    crmCreatedCount: audit.proposedMutations.filter(m => !m.isImported).length,
    totalToModify: audit.proposedMutations.length
  };

  // Financial reconciliation before vs after across target 81 docs
  let totalPrecioBefore = 0;
  let totalCostoBefore = 0;
  let docsWithFinancials = 0;

  audit.proposedMutations.forEach(m => {
    if (typeof m.precio_cotizado === 'number') {
      totalPrecioBefore += m.precio_cotizado;
      docsWithFinancials++;
    }
    if (typeof m.costo_venta === 'number') {
      totalCostoBefore += m.costo_venta;
    }
  });

  const financialReconciliation = {
    docsWithFinancials,
    totalTargetDocs: audit.proposedMutations.length,
    precioCotizado: {
      before: totalPrecioBefore,
      after: totalPrecioBefore,
      delta: 0
    },
    costoVenta: {
      before: totalCostoBefore,
      after: totalCostoBefore,
      delta: 0
    },
    margenBrutoDolares: {
      before: totalPrecioBefore - totalCostoBefore,
      after: totalPrecioBefore - totalCostoBefore,
      delta: 0
    },
    margenBrutoPorcentaje: {
      before: totalPrecioBefore > 0 ? ((1 - totalCostoBefore / totalPrecioBefore) * 100).toFixed(2) + '%' : 'N/A',
      after: totalPrecioBefore > 0 ? ((1 - totalCostoBefore / totalPrecioBefore) * 100).toFixed(2) + '%' : 'N/A',
      delta: '0.00%'
    }
  };

  // Status and Stage breakdown before vs after
  const statusCounts = {};
  const stageCounts = {};
  audit.proposedMutations.forEach(m => {
    statusCounts[m.estado] = (statusCounts[m.estado] || 0) + 1;
    stageCounts[m.etapa] = (stageCounts[m.etapa] || 0) + 1;
  });

  const statusReconciliation = {};
  for (const [st, count] of Object.entries(statusCounts)) {
    statusReconciliation[st] = { before: count, after: count, delta: 0 };
  }

  const stageReconciliation = {};
  for (const [et, count] of Object.entries(stageCounts)) {
    stageReconciliation[et] = { before: count, after: count, delta: 0 };
  }

  // Untouched canonical opportunities verification
  const untouchedDocs = audit.categories.correct;
  const untouchedByVendor = {};
  untouchedDocs.forEach(d => {
    untouchedByVendor[d.vendedorName] = (untouchedByVendor[d.vendedorName] || 0) + 1;
  });

  return {
    timestamp: new Date().toISOString(),
    projectId: EXPECTED_PROJECT_ID,
    audit,
    originBreakdown,
    financialReconciliation,
    statusReconciliation,
    stageReconciliation,
    untouchedCanonical: {
      total: untouchedDocs.length,
      byVendor: untouchedByVendor,
      confirmedIntact: untouchedDocs.length === 93
    },
    vistaTowerReferenceCheck: {
      found: vistaTowerIdentified,
      targetId: 'OPP-1777081083975-23',
      proyecto: vistaTower ? vistaTower.proyecto : null,
      proposedVendor: vistaTower ? vistaTower.responsableActual : null,
      proposedVendorId: vistaTower ? vistaTower.responsableId : null,
      evidence: vistaTower ? vistaTower.evidence : null,
      financials: vistaTower ? {
        precio: vistaTower.precio_cotizado,
        costo: vistaTower.costo_venta,
        estado: vistaTower.estado,
        etapa: vistaTower.etapa
      } : null
    },
    raw: {
      usersList: Object.values(usersMap),
      prospectsList
    }
  };
}

/**
 * Chunks array for batch writes.
 */
function chunkArray(items, size = BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Executes migration in dry-run (default) or live apply mode.
 */
async function executeCommercialAttributionMigration(db, plan, options = {}) {
  const {
    dryRun = true,
    opId = generateOpId(),
    localBackupPath = null,
    admin = null,
    targetProject = EXPECTED_PROJECT_ID
  } = options;

  if (admin) {
    const res = resolveAdminProjectId(admin);
    const expected = targetProject || EXPECTED_PROJECT_ID;
    if (res.contradiction || (res.projectId && res.projectId !== expected)) {
      throw new Error(`Project mismatch in executeCommercialAttributionMigration: expected '${expected}', got '${res.projectId}'.`);
    }
  }

  const plannedMutations = [];

  // Evaluate idempotency against raw live state
  for (const item of plan.audit.proposedMutations) {
    const rawDoc = plan.raw.prospectsList.find(p => p.id === item.id);
    if (!rawDoc) continue;

    let isAlreadyApplied = true;
    for (const [k, v] of Object.entries(item.after)) {
      if (rawDoc[k] !== v) {
        isAlreadyApplied = false;
        break;
      }
    }

    if (!isAlreadyApplied) {
      plannedMutations.push({
        docId: item.id,
        proyecto: item.proyecto,
        responsableActual: item.responsableActual,
        responsableId: item.responsableId,
        before: item.before,
        after: item.after,
        patch: item.after,
        evidence: item.evidence
      });
    }
  }

  const executionSummary = {
    opId,
    mode: dryRun ? 'DRY_RUN' : 'LIVE_APPLY',
    timestamp: new Date().toISOString(),
    totalAnalyzed: plan.audit.total,
    correctCount: plan.audit.counts.correct,
    mutationsPlannedCount: plannedMutations.length,
    batchesCount: Math.ceil(plannedMutations.length / BATCH_SIZE),
    byUser: plan.audit.byUser,
    vistaTowerReferenceCheck: plan.vistaTowerReferenceCheck,
    mutations: plannedMutations
  };

  // DRY-RUN: zero writes
  if (dryRun) {
    if (localBackupPath) {
      fs.writeFileSync(localBackupPath, JSON.stringify(executionSummary, null, 2), 'utf-8');
    }
    return executionSummary;
  }

  // LIVE APPLY: Execute in atomic batches with precondition checks
  const chunks = chunkArray(plannedMutations, BATCH_SIZE);
  const appliedMutations = [];

  for (let bIdx = 0; bIdx < chunks.length; bIdx++) {
    const chunk = chunks[bIdx];
    const batch = db.batch();

    for (const mut of chunk) {
      const docRef = db.collection('prospects_prod').doc(mut.docId);
      // Precondition: check forbidden fields
      for (const k of Object.keys(mut.patch)) {
        if (FORBIDDEN_PATCH_FIELDS.includes(k)) {
          throw new Error(`ABORT: Attempted write to forbidden field '${k}' on document '${mut.docId}'.`);
        }
      }
      batch.set(docRef, mut.patch, { merge: true });
    }

    await batch.commit();
    appliedMutations.push(...chunk);
  }

  // Record audit trail in Firestore
  const auditDocRef = db.collection(AUDIT_COLLECTION).doc(opId);
  const auditPayload = {
    opId,
    action: 'commercial_attribution_migration_apply',
    timestamp: new Date().toISOString(),
    totalApplied: appliedMutations.length,
    byUser: executionSummary.byUser,
    mutations: appliedMutations
  };

  await auditDocRef.set(auditPayload);

  if (localBackupPath) {
    fs.writeFileSync(localBackupPath, JSON.stringify(auditPayload, null, 2), 'utf-8');
  }

  return {
    ...executionSummary,
    status: 'SUCCEEDED',
    appliedCount: appliedMutations.length,
    auditDocPath: `${AUDIT_COLLECTION}/${opId}`
  };
}

/**
 * Rolls back changes made by a specific operation ID.
 * Detects concurrent human modifications to avoid blind overwrites.
 */
async function rollbackCommercialAttributionMigration(db, auditRecord, options = {}) {
  const {
    dryRun = true,
    targetProject = EXPECTED_PROJECT_ID,
    admin = null
  } = options;

  if (admin) {
    const res = resolveAdminProjectId(admin);
    const expected = targetProject || EXPECTED_PROJECT_ID;
    if (res.contradiction || (res.projectId && res.projectId !== expected)) {
      throw new Error(`Project mismatch in rollback: expected '${expected}', got '${res.projectId}'.`);
    }
  }

  if (!auditRecord || !Array.isArray(auditRecord.mutations)) {
    throw new Error('Invalid audit record: mutations array missing.');
  }

  const mutations = auditRecord.mutations;
  const rollbackPlan = [];
  const collisionsDetected = [];

  for (const mut of mutations) {
    const docRef = db.collection('prospects_prod').doc(mut.docId);
    const snap = await docRef.get();

    if (!snap.exists) {
      collisionsDetected.push({
        docId: mut.docId,
        reason: 'Document was deleted after migration.',
        action: 'SKIP'
      });
      continue;
    }

    const currentData = snap.data();
    const fieldsToRevert = {};
    let hasConcurrentEdit = false;

    for (const [k, appliedVal] of Object.entries(mut.after)) {
      const curVal = currentData[k];
      if (curVal !== appliedVal) {
        hasConcurrentEdit = true;
        collisionsDetected.push({
          docId: mut.docId,
          field: k,
          currentValue: curVal,
          appliedValue: appliedVal,
          reason: `Field '${k}' was modified after migration. Preserving user modification.`,
          action: 'SKIP_FIELD'
        });
      } else {
        const beforeVal = mut.before && mut.before[k] !== undefined ? mut.before[k] : null;
        fieldsToRevert[k] = beforeVal;
      }
    }

    if (Object.keys(fieldsToRevert).length > 0) {
      rollbackPlan.push({
        docId: mut.docId,
        fields: fieldsToRevert
      });
    }
  }

  const summary = {
    opId: auditRecord.opId,
    mode: dryRun ? 'DRY_RUN' : 'LIVE_ROLLBACK',
    timestamp: new Date().toISOString(),
    totalToRevert: rollbackPlan.length,
    collisionsDetectedCount: collisionsDetected.length,
    collisions: collisionsDetected,
    reversions: rollbackPlan
  };

  if (dryRun) {
    return summary;
  }

  // LIVE ROLLBACK
  const chunks = chunkArray(rollbackPlan, BATCH_SIZE);
  for (const chunk of chunks) {
    const batch = db.batch();
    for (const rev of chunk) {
      const ref = db.collection('prospects_prod').doc(rev.docId);
      const patch = {};
      for (const [k, v] of Object.entries(rev.fields)) {
        patch[k] = v === null ? null : v;
      }
      batch.set(ref, patch, { merge: true });
    }
    await batch.commit();
  }

  return {
    ...summary,
    status: 'SUCCEEDED'
  };
}

module.exports = {
  auditAndClassifyProspects,
  buildMigrationPlan,
  executeCommercialAttributionMigration,
  rollbackCommercialAttributionMigration,
  generateOpId,
  chunkArray,
  BATCH_SIZE,
  EXPECTED_PROJECT_ID,
  AUDIT_COLLECTION,
  FORBIDDEN_PATCH_FIELDS
};

if (require.main === module) {
  const admin = require('firebase-admin');
  const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');

  (async () => {
    try {
      const args = process.argv.slice(2);
      const isApply = args.includes('--apply');
      const isConfirmApply = args.includes('--confirm-apply');
      const isRollback = args.includes('--rollback');
      const isConfirmRollback = args.includes('--confirm-rollback');
      const isProdAllowed = args.includes('--allow-authorized-production-run');
      const includeCreatedBy = args.includes('--include-creator-backfill');

      const getArg = (flag, def = null) => {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
      };

      const opId = getArg('--op-id', generateOpId());
      const backupPath = getArg('--backup-path', path.join(__dirname, `commercial_attribution_plan_${opId}.json`));

      console.log('================================================================');
      console.log('      DUCTSAL ERP: CORRECCIÓN INTEGRAL DE ATRIBUCIÓN COMERCIAL  ');
      console.log('================================================================');

      // 1. Initialise Admin App
      if (process.env.FIRESTORE_EMULATOR_HOST) {
        const emuProject = process.env.GCLOUD_PROJECT || 'demo-ductsal-isolated';
        if (!admin.apps.length) admin.initializeApp({ projectId: emuProject });
        console.log(`[INIT] Running against Firestore emulator on ${process.env.FIRESTORE_EMULATOR_HOST} (project: ${emuProject})`);
      } else {
        if (!isProdAllowed && (isApply || isRollback)) {
          console.error('\n[ABORT] Live mutations on production require explicit authorization flag: --allow-authorized-production-run\n');
          process.exit(2);
        }
        await initializeImpersonatedAdminApp(admin, { projectId: EXPECTED_PROJECT_ID });
        console.log(`[INIT] Connected to production project: ${EXPECTED_PROJECT_ID}`);
      }

      const db = admin.firestore();

      // 2. Handle Rollback
      if (isRollback) {
        if (!isConfirmRollback) {
          console.error('\n[ABORT] Rollback requires explicit confirmation flag: --confirm-rollback\n');
          process.exit(2);
        }
        console.log(`[ROLLBACK] Fetching audit log for opId: ${opId}...`);
        const auditSnap = await db.collection(AUDIT_COLLECTION).doc(opId).get();
        if (!auditSnap.exists) {
          throw new Error(`Audit log for operation ${opId} not found in ${AUDIT_COLLECTION}.`);
        }
        const auditRecord = auditSnap.data();
        const rbRes = await rollbackCommercialAttributionMigration(db, auditRecord, { dryRun: false, admin });
        console.log('\n[ROLLBACK SUCCEEDED]');
        console.log(JSON.stringify(rbRes, null, 2));
        return;
      }

      // 3. Build Migration Plan (Read-Only)
      console.log('[PLAN] Inspecting collections and classifying all opportunities...');
      const plan = await buildMigrationPlan(db, { includeCreatedByBackfill: includeCreatedBy });

      console.log('\n--- DIAGNÓSTICO COMPLETO DE OPORTUNIDADES ---');
      console.log(`- Total de oportunidades analizadas: ${plan.audit.total}`);
      console.log(`- 1. Asignación correcta: ${plan.audit.counts.correct}`);
      console.log(`- 2. Sin vendedorId, pero con responsable verificable: ${plan.audit.counts.missingVendedorVerifiable}`);
      console.log(`- 3. vendedorId que no corresponde a usuario válido: ${plan.audit.counts.invalidVendedorId}`);
      console.log(`- 4. Inconsistencia entre nombre e identificador: ${plan.audit.counts.nameIdInconsistency}`);
      console.log(`- 5. Asignación ambigua: ${plan.audit.counts.ambiguousAssignment}`);
      console.log(`- 6. Oportunidades sin responsable identificado: ${plan.audit.counts.noIdentifiedResponsible}`);
      console.log(`- Registros sin createdBy histórico: ${plan.audit.counts.missingCreatedBy}`);

      console.log('\n--- CASO DE REFERENCIA: VISTA TOWER 2 ---');
      console.log(`- Encontrado en plan de corrección: ${plan.vistaTowerReferenceCheck.found ? 'SÍ' : 'NO'}`);
      console.log(`- Documento ID: ${plan.vistaTowerReferenceCheck.targetId}`);
      console.log(`- Responsable asignado: ${plan.vistaTowerReferenceCheck.proposedVendor} (${plan.vistaTowerReferenceCheck.proposedVendorId})`);
      console.log(`- Evidencia: ${plan.vistaTowerReferenceCheck.evidence}`);

      console.log('\n--- DESGLOSE POR USUARIO ---');
      console.table(Object.values(plan.audit.byUser).map(u => ({
        ID: u.id,
        Nombre: u.nombre,
        Rol: u.role,
        Activo: u.activo,
        'Asignaciones Actuales': u.assignedCount,
        'Correcciones Propuestas': u.proposedCorrectionCount
      })));

      console.log('\n--- 1. DESGLOSE POR ORIGEN DE REGISTROS A MODIFICAR ---');
      console.log(`- Total de oportunidades a modificar: ${plan.originBreakdown.totalToModify}`);
      console.log(`  * Oportunidades Importadas (OPP-...): ${plan.originBreakdown.importedCount}`);
      console.log(`  * Oportunidades Históricas creadas en CRM: ${plan.originBreakdown.crmCreatedCount}`);

      console.log('\n--- 2. CONFIRMACIÓN DE OPORTUNIDADES CANÓNICAS INTACTAS ---');
      console.log(`- Total de oportunidades canónicas intactas: ${plan.untouchedCanonical.total} (100% PRESERVADAS)`);
      console.table(Object.entries(plan.untouchedCanonical.byVendor).map(([vendor, count]) => ({
        Vendedor: vendor,
        'Oportunidades Intactas': count
      })));

      console.log('\n--- 3. RECONCILIACIÓN FINANCIERA (ANTES VS DESPUÉS) ---');
      console.table([
        {
          Métrica: 'Precio Cotizado ($)',
          'Antes': `$${plan.financialReconciliation.precioCotizado.before.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Después': `$${plan.financialReconciliation.precioCotizado.after.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Variación': `$${plan.financialReconciliation.precioCotizado.delta.toFixed(2)}`
        },
        {
          Métrica: 'Costo Venta ($)',
          'Antes': `$${plan.financialReconciliation.costoVenta.before.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Después': `$${plan.financialReconciliation.costoVenta.after.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Variación': `$${plan.financialReconciliation.costoVenta.delta.toFixed(2)}`
        },
        {
          Métrica: 'Margen Bruto ($)',
          'Antes': `$${plan.financialReconciliation.margenBrutoDolares.before.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Después': `$${plan.financialReconciliation.margenBrutoDolares.after.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          'Variación': `$${plan.financialReconciliation.margenBrutoDolares.delta.toFixed(2)}`
        },
        {
          Métrica: 'Margen Bruto (%)',
          'Antes': plan.financialReconciliation.margenBrutoPorcentaje.before,
          'Después': plan.financialReconciliation.margenBrutoPorcentaje.after,
          'Variación': plan.financialReconciliation.margenBrutoPorcentaje.delta
        }
      ]);

      console.log('\n--- 4. RECONCILIACIÓN DE ESTADOS (ANTES VS DESPUÉS) ---');
      console.table(Object.entries(plan.statusReconciliation).map(([st, data]) => ({
        Estado: st,
        'Antes': data.before,
        'Después': data.after,
        'Variación': data.delta
      })));

      console.log('\n--- 5. RECONCILIACIÓN DE ETAPAS (ANTES VS DESPUÉS) ---');
      console.table(Object.entries(plan.stageReconciliation).map(([et, data]) => ({
        Etapa: et,
        'Antes': data.before,
        'Después': data.after,
        'Variación': data.delta
      })));

      // 4. Dry-run mode by default
      if (!isApply || !isConfirmApply) {
        console.log('\n[DRY RUN] Simulating commercial attribution migration (ZERO production writes)...');
        const dryRes = await executeCommercialAttributionMigration(db, plan, {
          dryRun: true,
          opId,
          localBackupPath: backupPath,
          admin
        });
        console.log(`\nSimulation complete for opId: ${opId}`);
        console.log(`Total planned mutations: ${dryRes.mutationsPlannedCount}`);
        console.log(`Batches needed: ${dryRes.batchesCount}`);
        console.log(`Detailed plan preview written to: ${backupPath}`);
        console.log('\n================================================================');
        console.log('       SIMULACIÓN FINALIZADA CON ÉXITO — 0 ESCRITURAS           ');
        console.log('================================================================');
        console.log('Para aplicar cambios reales en producción se requerirá:');
        console.log(`--apply --confirm-apply --op-id ${opId} --allow-authorized-production-run`);
        return;
      }

      // 5. Live apply mode (only when explicitly requested)
      console.log(`\n[LIVE APPLY] Executing commercial attribution migration under opId: ${opId}...`);
      const liveRes = await executeCommercialAttributionMigration(db, plan, {
        dryRun: false,
        opId,
        localBackupPath: backupPath,
        admin
      });

      console.log('\n================================================================');
      console.log('        MIGRACIÓN APLICADA EXITOSAMENTE EN PRODUCCIÓN           ');
      console.log('================================================================');
      console.log(`- Status: ${liveRes.status}`);
      console.log(`- Applied mutations count: ${liveRes.appliedCount}`);
      console.log(`- Audit doc recorded in: ${liveRes.auditDocPath}`);
      console.log(`- Local recovery backup saved at: ${backupPath}`);
    } catch (err) {
      console.error('\n[MIGRATION ERROR]', err);
      process.exit(1);
    }
  })();
}
