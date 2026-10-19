// functions/scripts/executeSec03Backfill.js
// Idempotent, batch-controlled, auditable and reversible backfill executor for SEC-03 F2.5.
// STRICT SAFEGUARDS:
//   - Dry-run mode by default.
//   - Requires explicit flags (--apply, --confirm-apply, --op-id) for mutations.
//   - Records exact before/after states for surgical rollback.
//   - Never reassigns AR Multiservicios silently; preserves Gustavo Velásquez historical attribution.
//   - Rollback detects concurrent modifications and avoids blind overwrites.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  planProspectsBackfill,
  planClientsVisibilityBackfill,
  planUserDirectorySync,
  KNOWN_USERS
} = require('./simulateSec03Backfill');
const { resolveAdminProjectId } = require('./provisionManager');

const BATCH_SIZE = 50;
const EXPECTED_PROJECT_ID = 'ductsal-erp';

/**
 * Generates an auditable operation ID if not supplied.
 */
function generateOpId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  return `sec03_bf_${ts}_${rand}`;
}

/**
 * Compares two arrays for shallow equality of primitives.
 */
function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, idx) => val === sb[idx]);
}

/**
 * Builds the full backfill plan by fetching current state and evaluating diffs.
 */
async function buildBackfillPlan(db, options = {}) {
  const usersMap = options.usersMap || KNOWN_USERS;

  const [usersSnap, userDirSnap, clientsSnap, prospectsSnap] = await Promise.all([
    db.collection('users_prod').get(),
    db.collection('userDirectory_prod').get(),
    db.collection('clients_prod').get(),
    db.collection('prospects_prod').get()
  ]);

  const usersList = [];
  const fetchedUsersMap = {};
  usersSnap.forEach(d => {
    const data = Object.assign({ id: d.id }, d.data());
    usersList.push(data);
    fetchedUsersMap[d.id] = data;
  });

  const currentDirList = [];
  userDirSnap.forEach(d => currentDirList.push(Object.assign({ id: d.id }, d.data())));

  const clientsList = [];
  clientsSnap.forEach(d => clientsList.push(Object.assign({ id: d.id }, d.data())));

  const prospectsList = [];
  prospectsSnap.forEach(d => prospectsList.push(Object.assign({ id: d.id }, d.data())));

  const effectiveUsersMap = Object.assign({}, KNOWN_USERS, fetchedUsersMap);

  const prospectsPlan = planProspectsBackfill(prospectsList, effectiveUsersMap);
  const clientsPlan = planClientsVisibilityBackfill(clientsList, prospectsList, effectiveUsersMap);
  const userDirPlan = planUserDirectorySync(usersList, currentDirList);

  return {
    timestamp: new Date().toISOString(),
    counts: {
      users: usersList.length,
      currentDirectory: currentDirList.length,
      clients: clientsList.length,
      prospects: prospectsList.length
    },
    prospects: prospectsPlan,
    clients: clientsPlan,
    userDirectory: userDirPlan,
    raw: {
      usersList,
      currentDirList,
      clientsList,
      prospectsList
    }
  };
}

/**
 * Chunks an array into batches of specified size.
 */
function chunkArray(items, size = BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Executes or simulates the backfill based on the generated plan.
 */
async function executeBackfill(db, plan, options = {}) {
  const {
    dryRun = true,
    opId = generateOpId(),
    targetProject = EXPECTED_PROJECT_ID,
    auditCollection = 'sec03MigrationAudit_prod',
    localBackupPath = null,
    admin = null
  } = options;

  if (admin) {
    const res = resolveAdminProjectId(admin);
    const expected = targetProject || EXPECTED_PROJECT_ID;
    if (res.contradiction || (res.projectId && res.projectId !== expected)) {
      throw new Error(`Project mismatch in executeBackfill: expected '${expected}', got '${res.projectId}'.`);
    }
  }

  const plannedMutations = [];

  // 1. Plan prospect updates
  for (const item of plan.prospects.proposedUpdates) {
    const rawDoc = plan.raw.prospectsList.find(p => p.id === item.id) || {};
    const before = {};
    for (const k of Object.keys(item.proposedPatch)) {
      before[k] = rawDoc[k] !== undefined ? rawDoc[k] : null;
    }

    // Check if already up-to-date (Idempotency)
    let isAlreadyApplied = true;
    for (const [k, v] of Object.entries(item.proposedPatch)) {
      if (rawDoc[k] !== v) {
        isAlreadyApplied = false;
        break;
      }
    }

    if (!isAlreadyApplied) {
      plannedMutations.push({
        type: 'UPDATE',
        collection: 'prospects_prod',
        docId: item.id,
        category: item.category,
        before,
        after: Object.assign({}, item.proposedPatch),
        patch: item.proposedPatch
      });
    }
  }

  // 2. Plan client updates (both missingCreatedByResolved and proposedUpdates)
  const clientCandidates = [
    ...plan.clients.missingCreatedByResolved,
    ...plan.clients.proposedUpdates
  ];

  for (const item of clientCandidates) {
    const rawDoc = plan.raw.clientsList.find(c => c.id === item.id) || {};
    const before = {};
    for (const k of Object.keys(item.proposedPatch)) {
      before[k] = rawDoc[k] !== undefined ? rawDoc[k] : null;
    }

    // Check if already up-to-date (Idempotency)
    let isAlreadyApplied = true;
    for (const [k, v] of Object.entries(item.proposedPatch)) {
      if (Array.isArray(v)) {
        if (!arraysEqual(rawDoc[k], v)) {
          isAlreadyApplied = false;
          break;
        }
      } else {
        if (rawDoc[k] !== v) {
          isAlreadyApplied = false;
          break;
        }
      }
    }

    if (!isAlreadyApplied) {
      plannedMutations.push({
        type: 'UPDATE',
        collection: 'clients_prod',
        docId: item.id,
        category: item.proposedPatch.createdBy ? 'CLIENT_CREATEDBY_AND_VISIBILITY' : 'CLIENT_VISIBILITY_ONLY',
        before,
        after: Object.assign({}, item.proposedPatch),
        patch: item.proposedPatch
      });
    }
  }

  // 3. Plan userDirectory_prod creations / updates
  for (const item of plan.userDirectory.toCreate) {
    plannedMutations.push({
      type: 'CREATE',
      collection: 'userDirectory_prod',
      docId: item.id,
      category: 'USER_DIRECTORY_PROJECTION_CREATE',
      before: null,
      after: item.projection,
      patch: item.projection
    });
  }

  for (const item of plan.userDirectory.toUpdate) {
    plannedMutations.push({
      type: 'UPDATE',
      collection: 'userDirectory_prod',
      docId: item.id,
      category: 'USER_DIRECTORY_PROJECTION_UPDATE',
      before: item.current,
      after: item.proposed,
      patch: item.proposed
    });
  }

  const executionSummary = {
    opId,
    mode: dryRun ? 'DRY_RUN' : 'LIVE_APPLY',
    timestamp: new Date().toISOString(),
    totalPlannedMutations: plannedMutations.length,
    byCollection: {
      prospects_prod: plannedMutations.filter(m => m.collection === 'prospects_prod').length,
      clients_prod: plannedMutations.filter(m => m.collection === 'clients_prod').length,
      userDirectory_prod: plannedMutations.filter(m => m.collection === 'userDirectory_prod').length
    },
    batchesCount: Math.ceil(plannedMutations.length / BATCH_SIZE),
    mutations: plannedMutations
  };

  // If DRY RUN: do not execute writes, save local preview if path provided
  if (dryRun) {
    if (localBackupPath) {
      fs.writeFileSync(localBackupPath, JSON.stringify(executionSummary, null, 2), 'utf-8');
    }
    return executionSummary;
  }

  // LIVE APPLY: Execute in controlled batches
  const chunks = chunkArray(plannedMutations, BATCH_SIZE);
  const appliedMutations = [];

  for (let bIdx = 0; bIdx < chunks.length; bIdx++) {
    const chunk = chunks[bIdx];
    const batch = db.batch();

    for (const mut of chunk) {
      const docRef = db.collection(mut.collection).doc(mut.docId);
      if (mut.type === 'CREATE') {
        batch.set(docRef, mut.patch);
      } else {
        batch.set(docRef, mut.patch, { merge: true });
      }
    }

    await batch.commit();
    appliedMutations.push(...chunk);
  }

  // Record Audit Trail in Firestore
  const auditDocRef = db.collection(auditCollection).doc(opId);
  const auditPayload = {
    opId,
    action: 'sec03_f2_5_backfill_apply',
    timestamp: new Date().toISOString(),
    totalApplied: appliedMutations.length,
    byCollection: executionSummary.byCollection,
    mutations: appliedMutations
  };

  await auditDocRef.set(auditPayload);

  if (localBackupPath) {
    fs.writeFileSync(localBackupPath, JSON.stringify(auditPayload, null, 2), 'utf-8');
  }

  return {
    ...executionSummary,
    status: 'SUCCEEDED',
    appliedCount: appliedMutations.length
  };
}

/**
 * Surgically rolls back changes made by a specific backfill opId.
 * Non-destructive: checks for concurrent user modifications before reverting.
 */
async function rollbackBackfill(db, auditRecord, options = {}) {
  const {
    dryRun = true,
    targetProject = EXPECTED_PROJECT_ID,
    admin = null
  } = options;

  if (admin) {
    const res = resolveAdminProjectId(admin);
    const expected = targetProject || EXPECTED_PROJECT_ID;
    if (res.contradiction || (res.projectId && res.projectId !== expected)) {
      throw new Error(`Project mismatch in rollbackBackfill: expected '${expected}', got '${res.projectId}'.`);
    }
  }

  if (!auditRecord || !Array.isArray(auditRecord.mutations)) {
    throw new Error('Invalid audit record: mutations array missing.');
  }

  const mutations = auditRecord.mutations;
  const rollbackPlan = [];
  const collisionsDetected = [];

  for (const mut of mutations) {
    const docRef = db.collection(mut.collection).doc(mut.docId);
    const snap = await docRef.get();

    if (!snap.exists) {
      if (mut.type === 'CREATE') {
        // Already gone, nothing to do
        continue;
      }
      collisionsDetected.push({
        docPath: `${mut.collection}/${mut.docId}`,
        reason: 'Document was deleted after migration.',
        action: 'SKIP'
      });
      continue;
    }

    const currentData = snap.data();

    if (mut.type === 'CREATE' && mut.collection === 'userDirectory_prod') {
      // Check if userDirectory was modified after creation
      let wasModifiedAfterMigration = false;
      for (const [k, v] of Object.entries(mut.after)) {
        if (currentData[k] !== v) {
          wasModifiedAfterMigration = true;
          break;
        }
      }

      if (wasModifiedAfterMigration) {
        collisionsDetected.push({
          docPath: `${mut.collection}/${mut.docId}`,
          reason: 'userDirectory document was modified after backfill. Preserving user edits.',
          action: 'SKIP'
        });
      } else {
        rollbackPlan.push({
          action: 'DELETE',
          collection: mut.collection,
          docId: mut.docId
        });
      }
      continue;
    }

    // UPDATE: Check if values currently match the 'after' state applied by migration
    const fieldsToRevert = {};
    let hasConcurrentEdit = false;

    for (const [k, appliedVal] of Object.entries(mut.after)) {
      const curVal = currentData[k];
      const match = Array.isArray(appliedVal)
        ? arraysEqual(curVal, appliedVal)
        : curVal === appliedVal;

      if (!match) {
        hasConcurrentEdit = true;
        collisionsDetected.push({
          docPath: `${mut.collection}/${mut.docId}`,
          field: k,
          currentValue: curVal,
          appliedValue: appliedVal,
          reason: `Field '${k}' was modified after backfill. Preserving user modification.`,
          action: 'SKIP_FIELD'
        });
      } else {
        // Clean to revert to before value
        const beforeVal = mut.before && mut.before[k] !== undefined ? mut.before[k] : null;
        fieldsToRevert[k] = beforeVal;
      }
    }

    if (Object.keys(fieldsToRevert).length > 0) {
      rollbackPlan.push({
        action: 'RESTORE_FIELDS',
        collection: mut.collection,
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

  // LIVE ROLLBACK: Execute in batches
  const chunks = chunkArray(rollbackPlan, BATCH_SIZE);
  for (const chunk of chunks) {
    const batch = db.batch();
    for (const rev of chunk) {
      const ref = db.collection(rev.collection).doc(rev.docId);
      if (rev.action === 'DELETE') {
        batch.delete(ref);
      } else {
        // To restore fields that were previously null/missing, we set null or delete if FieldValue available
        const patch = {};
        for (const [k, v] of Object.entries(rev.fields)) {
          patch[k] = v === null ? null : v;
        }
        batch.set(ref, patch, { merge: true });
      }
    }
    await batch.commit();
  }

  return {
    ...summary,
    status: 'SUCCEEDED'
  };
}

module.exports = {
  buildBackfillPlan,
  executeBackfill,
  rollbackBackfill,
  chunkArray,
  generateOpId,
  arraysEqual,
  BATCH_SIZE,
  EXPECTED_PROJECT_ID
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

      const getArg = (flag, def = null) => {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
      };

      const opId = getArg('--op-id', generateOpId());
      const backupPath = getArg('--backup-path', path.join(__dirname, `sec03_plan_${opId}.json`));

      console.log('================================================================');
      console.log('        SEC-03 F2.5: EJECUTOR Y PLANIFICADOR DE BACKFILL        ');
      console.log('================================================================');

      // 1. Initialise Admin App
      if (process.env.FIRESTORE_EMULATOR_HOST) {
        const emuProject = process.env.GCLOUD_PROJECT || 'demo-ductsal-isolated';
        if (!admin.apps.length) admin.initializeApp({ projectId: emuProject });
        console.log(`[INIT] Running against Firestore emulator on ${process.env.FIRESTORE_EMULATOR_HOST} (project: ${emuProject})`);
      } else {
        if (!isProdAllowed && (isApply || isRollback)) {
          console.error('\n[ABORT] Live mutations on production require explicit flag: --allow-authorized-production-run\n');
          process.exit(2);
        }
        await initializeImpersonatedAdminApp(admin, { projectId: EXPECTED_PROJECT_ID });
        console.log(`[INIT] Connected to production project: ${EXPECTED_PROJECT_ID}`);
      }

      const db = admin.firestore();

      // 2. Handle Rollback
      if (isRollback) {
        if (!isConfirmRollback) {
          console.error('\n[ABORT] Rollback requires explicit flag: --confirm-rollback\n');
          process.exit(2);
        }
        console.log(`[ROLLBACK] Fetching audit log for opId: ${opId}...`);
        const auditSnap = await db.collection('sec03MigrationAudit_prod').doc(opId).get();
        if (!auditSnap.exists) {
          throw new Error(`Audit log for operation ${opId} not found in sec03MigrationAudit_prod.`);
        }
        const auditRecord = auditSnap.data();
        const rbRes = await rollbackBackfill(db, auditRecord, { dryRun: false, admin });
        console.log('\n[ROLLBACK SUCCEEDED]');
        console.log(JSON.stringify(rbRes, null, 2));
        return;
      }

      // 3. Build Plan
      console.log('[PLAN] Scanning collections to build migration diffs...');
      const plan = await buildBackfillPlan(db);

      console.log(`- Prospects to update: ${plan.prospects.proposedUpdates.length}`);
      console.log(`- Clients to update: ${plan.clients.missingCreatedByResolved.length + plan.clients.proposedUpdates.length}`);
      console.log(`- userDirectory entries to create: ${plan.userDirectory.toCreate.length}`);
      console.log(`- userDirectory entries to update: ${plan.userDirectory.toUpdate.length}`);
      console.log(`- Ambiguous prospects for manual review: ${plan.prospects.ambiguousManualReview.length}`);
      console.log(`- Ambiguous clients for manual review: ${plan.clients.ambiguousManualReview.length}`);

      // 4. Dry-run mode by default
      if (!isApply || !isConfirmApply) {
        console.log('\n[DRY RUN] Simulating backfill execution (zero writes)...');
        const dryRes = await executeBackfill(db, plan, {
          dryRun: true,
          opId,
          localBackupPath: backupPath,
          admin
        });
        console.log(`\nSimulation complete for opId: ${opId}`);
        console.log(`Total planned mutations: ${dryRes.totalPlannedMutations}`);
        console.log(`Batches needed: ${dryRes.batchesCount}`);
        console.log(`Detailed plan preview written to: ${backupPath}`);
        console.log('\nTo apply live changes, you must provide: --apply --confirm-apply --op-id ' + opId + ' --allow-authorized-production-run');
        return;
      }

      // 5. Live apply mode
      console.log(`\n[LIVE APPLY] Executing backfill under opId: ${opId}...`);
      const liveRes = await executeBackfill(db, plan, {
        dryRun: false,
        opId,
        localBackupPath: backupPath,
        admin
      });

      console.log('\n================================================================');
      console.log('             BACKFILL COMPLETADO EXITOSAMENTE                   ');
      console.log('================================================================');
      console.log(`- Status: ${liveRes.status}`);
      console.log(`- Applied mutations count: ${liveRes.appliedCount}`);
      console.log(`- Audit doc recorded in: sec03MigrationAudit_prod/${opId}`);
      console.log(`- Local recovery log saved at: ${backupPath}`);
    } catch (err) {
      console.error('\n[BACKFILL EXECUTION ERROR]', err);
      process.exit(1);
    }
  })();
}

