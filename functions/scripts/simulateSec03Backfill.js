// functions/scripts/simulateSec03Backfill.js
// Simulation and dry-run planner for SEC-03 Phase F2 data backfill.
// Evaluates prospects_prod, clients_prod, and userDirectory_prod.
// STRICT SAFEGUARDS: READ-ONLY ONLY. Zero production writes.

const { resolveAdminProjectId } = require('./provisionManager');

const KNOWN_USERS = {
  '1776895495203': { id: '1776895495203', nombre: 'Benjamin Valiente', role: 'manager', activo: true },
  '1776904494660': { id: '1776904494660', nombre: 'Denys González', role: 'manager', activo: true },
  '1776904514932': { id: '1776904514932', nombre: 'Alejandra Ayala', role: 'gestor', activo: true },
  '1784221928346': { id: '1784221928346', nombre: 'Gustavo Velásquez', role: 'vendedor', activo: false },
  '1788471603604': { id: '1788471603604', nombre: 'Roberto Flores', role: 'vendedor', activo: true }
};

/**
 * Normalizes a string for safe comparison.
 */
function normalizeStr(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Resolves a seller name string to a known user CID.
 */
function resolveSellerNameToCid(name, usersMap) {
  if (!name || typeof name !== 'string') return null;
  const n = normalizeStr(name);
  for (const [cid, u] of Object.entries(usersMap || KNOWN_USERS)) {
    if (normalizeStr(u.nombre) === n) return cid;
  }
  return null;
}

/**
 * Plans backfill for prospects.
 * Categorizes documents into:
 * - UP_TO_DATE: createdBy and vendedorId both present and valid
 * - PROPOSED_UPDATE: clear evidence allows proposing missing createdBy and/or vendedorId
 * - AMBIGUOUS_MANUAL_REVIEW: missing or contradictory fields without clear evidence
 */
function planProspectsBackfill(prospectsList, usersMap = KNOWN_USERS) {
  const result = {
    total: prospectsList.length,
    upToDate: [],
    proposedUpdates: [],
    ambiguousManualReview: []
  };

  for (const p of prospectsList) {
    const id = p.id;
    const rawCreatedBy = p.createdBy ? String(p.createdBy).trim() : null;
    const rawVendedorId = p.vendedorId ? String(p.vendedorId).trim() : null;
    const rawVendedor = p.vendedor ? String(p.vendedor).trim() : null;

    // Both present and valid
    if (rawCreatedBy && rawVendedorId) {
      result.upToDate.push({
        id,
        createdBy: rawCreatedBy,
        vendedorId: rawVendedorId,
        vendedor: rawVendedor
      });
      continue;
    }

    // Try to resolve seller from name or existing ID
    let resolvedCid = null;
    let evidence = null;

    if (rawVendedorId && usersMap[rawVendedorId]) {
      resolvedCid = rawVendedorId;
      evidence = `vendedorId matches known user ${usersMap[rawVendedorId].nombre} (${rawVendedorId})`;
    } else if (rawVendedor) {
      const matched = resolveSellerNameToCid(rawVendedor, usersMap);
      if (matched) {
        resolvedCid = matched;
        evidence = `vendedor string "${rawVendedor}" matches known user ${usersMap[matched].nombre} (${matched})`;
      }
    }

    // Case 1: Lacks createdBy
    if (!rawCreatedBy) {
      if (resolvedCid) {
        const patch = { createdBy: resolvedCid };
        if (!rawVendedorId) patch.vendedorId = resolvedCid;

        result.proposedUpdates.push({
          id,
          clientId: p.clientId || null,
          category: 'PROSPECT_MISSING_CREATED_BY_RESOLVED',
          current: { createdBy: null, vendedorId: rawVendedorId, vendedor: rawVendedor },
          proposedPatch: patch,
          evidence
        });
      } else {
        result.ambiguousManualReview.push({
          id,
          clientId: p.clientId || null,
          category: 'PROSPECT_MISSING_CREATED_BY_UNRESOLVED',
          current: { createdBy: null, vendedorId: rawVendedorId, vendedor: rawVendedor },
          reason: 'No recognizable vendedor name or ID found on prospect document.'
        });
      }
      continue;
    }

    // Case 2: Has createdBy, lacks vendedorId
    if (rawCreatedBy && !rawVendedorId) {
      // If rawVendedor is present and contradicts createdBy
      if (rawVendedor && resolvedCid && resolvedCid !== rawCreatedBy) {
        result.ambiguousManualReview.push({
          id,
          clientId: p.clientId || null,
          category: 'PROSPECT_CREATEDBY_VENDEDOR_CONFLICT',
          current: { createdBy: rawCreatedBy, vendedorId: null, vendedor: rawVendedor },
          reason: `createdBy (${rawCreatedBy}) contradicts vendedor string (${rawVendedor} -> ${resolvedCid}).`
        });
      } else {
        // Safe proposition: assign vendedorId to the creator (or resolved vendedor)
        const targetVendedorId = resolvedCid || rawCreatedBy;
        result.proposedUpdates.push({
          id,
          clientId: p.clientId || null,
          category: 'PROSPECT_MISSING_VENDEDOR_ID_STANDARDIZED',
          current: { createdBy: rawCreatedBy, vendedorId: null, vendedor: rawVendedor },
          proposedPatch: { vendedorId: targetVendedorId },
          evidence: resolvedCid
            ? `Standardizing vendedorId from resolved vendedor string (${resolvedCid})`
            : `Standardizing vendedorId from existing createdBy (${rawCreatedBy})`
        });
      }
    }
  }

  return result;
}

/**
 * Plans backfill for clients.
 * Calculates derived visibleTo and closingVendors based on linked prospects.
 * Categorizes documents into:
 * - UP_TO_DATE: visibleTo and closingVendors already match calculated arrays, createdBy present
 * - PROPOSED_VISIBILITY_UPDATE: visibleTo or closingVendors need recalculation
 * - CLIENTS_WITHOUT_CREATED_BY_RESOLVED: missing createdBy with unanimous linked prospect owner
 * - ORPHANED_OR_AMBIGUOUS_MANUAL_REVIEW: clients with no prospects or conflicting prospect owners
 */
function planClientsVisibilityBackfill(clientsList, prospectsList, usersMap = KNOWN_USERS) {
  // Map prospects by clientId (excluding soft-deleted)
  const clientProspectsMap = new Map();
  for (const p of prospectsList) {
    if (!p.clientId || p.eliminado === true) continue;
    const cid = String(p.clientId);
    if (!clientProspectsMap.has(cid)) clientProspectsMap.set(cid, []);
    clientProspectsMap.get(cid).push(p);
  }

  const result = {
    total: clientsList.length,
    upToDate: [],
    proposedUpdates: [],
    missingCreatedByResolved: [],
    ambiguousManualReview: []
  };

  for (const c of clientsList) {
    const id = String(c.id);
    const rawCreatedBy = c.createdBy ? String(c.createdBy).trim() : null;
    const linkedProspects = clientProspectsMap.get(id) || [];

    // Calculate derived visibleTo and closingVendors sets
    const visibleSet = new Set();
    const closingSet = new Set();
    const prospectCreatorsSet = new Set();

    for (const p of linkedProspects) {
      // Gather creators/vendors
      const pCb = p.createdBy ? String(p.createdBy).trim() : null;
      let pVd = p.vendedorId ? String(p.vendedorId).trim() : null;

      if (!pVd && p.vendedor) {
        pVd = resolveSellerNameToCid(p.vendedor, usersMap);
      }

      if (pCb && pCb !== 'sistema') {
        visibleSet.add(pCb);
        prospectCreatorsSet.add(pCb);
      }
      if (pVd && pVd !== 'sistema') {
        visibleSet.add(pVd);
        prospectCreatorsSet.add(pVd);
      }

      if (p.etapa === 'cierre' && p.estado !== 'perdido') {
        if (pCb && pCb !== 'sistema') closingSet.add(pCb);
        if (pVd && pVd !== 'sistema') closingSet.add(pVd);
      }
    }

    const calculatedVisibleTo = Array.from(visibleSet).sort();
    const calculatedClosingVendors = Array.from(closingSet).sort();

    const currentVisibleTo = Array.isArray(c.visibleTo) ? [...c.visibleTo].sort() : [];
    const currentClosingVendors = Array.isArray(c.closingVendors) ? [...c.closingVendors].sort() : [];

    const visNeedsUpdate =
      !Array.isArray(c.visibleTo) ||
      currentVisibleTo.length !== calculatedVisibleTo.length ||
      !currentVisibleTo.every((v, i) => v === calculatedVisibleTo[i]);

    const closeNeedsUpdate =
      !Array.isArray(c.closingVendors) ||
      currentClosingVendors.length !== calculatedClosingVendors.length ||
      !currentClosingVendors.every((v, i) => v === calculatedClosingVendors[i]);

    // Check createdBy status
    let proposedCreatedBy = null;
    let createdByEvidence = null;

    if (!rawCreatedBy) {
      if (linkedProspects.length === 0) {
        result.ambiguousManualReview.push({
          id,
          nombre: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim() || 'Sin nombre',
          category: 'CLIENT_ORPHANED_NO_PROSPECTS',
          reason: 'Client has no linked prospects; cannot deduce owner or visibility.'
        });
        continue;
      }

      if (prospectCreatorsSet.size === 1) {
        proposedCreatedBy = Array.from(prospectCreatorsSet)[0];
        createdByEvidence = `Unanimous owner across ${linkedProspects.length} linked prospect(s): ${usersMap[proposedCreatedBy]?.nombre || proposedCreatedBy}`;
      } else if (prospectCreatorsSet.size > 1) {
        result.ambiguousManualReview.push({
          id,
          nombre: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim() || 'Sin nombre',
          category: 'CLIENT_CONFLICTING_PROSPECT_OWNERS',
          linkedVendors: Array.from(prospectCreatorsSet),
          reason: 'Client has prospects owned by multiple different sellers; createdBy cannot be assigned automatically.'
        });
        // Still can calculate visibleTo for multi-vendor clients
      }
    }

    const patch = {};
    if (visNeedsUpdate) patch.visibleTo = calculatedVisibleTo;
    if (closeNeedsUpdate) patch.closingVendors = calculatedClosingVendors;

    if (!rawCreatedBy && proposedCreatedBy) {
      patch.createdBy = proposedCreatedBy;
      result.missingCreatedByResolved.push({
        id,
        nombre: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim(),
        linkedProspectsCount: linkedProspects.length,
        proposedCreatedBy,
        evidence: createdByEvidence,
        proposedPatch: patch
      });
    } else if (visNeedsUpdate || closeNeedsUpdate) {
      result.proposedUpdates.push({
        id,
        nombre: c.empresa || `${c.nombres || ''} ${c.apellidos || ''}`.trim(),
        createdBy: rawCreatedBy,
        linkedProspectsCount: linkedProspects.length,
        current: { visibleTo: c.visibleTo || null, closingVendors: c.closingVendors || null },
        proposedPatch: patch
      });
    } else {
      result.upToDate.push({
        id,
        createdBy: rawCreatedBy,
        visibleTo: currentVisibleTo,
        closingVendors: currentClosingVendors
      });
    }
  }

  return result;
}

/**
 * Plans synchronization for userDirectory_prod.
 * Strictly projects only public non-sensitive fields: { id, nombre, role, activo }.
 * Completely excludes password, email, authUid, authProvider, tokens, etc.
 */
function planUserDirectorySync(usersList, currentDirectoryList = []) {
  const currentDirMap = new Map();
  for (const d of currentDirectoryList) {
    currentDirMap.set(String(d.id), d);
  }

  const result = {
    totalUsers: usersList.length,
    currentDirectorySize: currentDirectoryList.length,
    toCreate: [],
    toUpdate: [],
    toDelete: [],
    upToDate: []
  };

  const activeUserIds = new Set();

  for (const u of usersList) {
    const id = String(u.id);
    activeUserIds.add(id);

    const projected = {
      id,
      nombre: u.nombre || '',
      role: u.role || 'vendedor',
      activo: u.activo !== false
    };

    // Assert strictly no sensitive keys exist
    const sensitiveKeys = ['password', 'email', 'authUid', 'authProvider', 'creado', 'hasPassword', 'token'];
    for (const k of sensitiveKeys) {
      if (k in projected) {
        throw new Error(`CRITICAL SECURITY FAILURE: Sensitive key ${k} found in userDirectory projection!`);
      }
    }

    const currentDoc = currentDirMap.get(id);
    if (!currentDoc) {
      result.toCreate.push({ id, projection: projected });
    } else {
      const match =
        currentDoc.id === projected.id &&
        currentDoc.nombre === projected.nombre &&
        currentDoc.role === projected.role &&
        currentDoc.activo === projected.activo;

      if (!match) {
        result.toUpdate.push({ id, current: currentDoc, proposed: projected });
      } else {
        result.upToDate.push({ id });
      }
    }
  }

  // Detect orphaned directory entries
  for (const [id, d] of currentDirMap.entries()) {
    if (!activeUserIds.has(id)) {
      result.toDelete.push({ id, current: d });
    }
  }

  return result;
}

/**
 * Executes the full dry-run simulation against live or provided Firestore instance.
 * Throws immediately if write is attempted.
 */
async function runBackfillSimulation({ admin, db, projectId = 'ductsal-erp', readOnly = true }) {
  if (!readOnly) {
    throw new Error('SAFEGUARD: This script is strictly read-only. Mutation mode is disabled.');
  }

  let effectiveProject = projectId;
  if (admin) {
    const res = resolveAdminProjectId(admin);
    if (res.error) throw new Error(`Project resolution error: ${res.error}`);
    effectiveProject = res.projectId;
  }

  if (!effectiveProject || effectiveProject !== 'ductsal-erp') {
    throw new Error(`ABORT: Target project is not "ductsal-erp" (found "${effectiveProject}").`);
  }

  console.log(`[SIMULATION] Target Project: ${effectiveProject}`);
  console.log('[SIMULATION] Fetching live collections (read-only)...');

  const [usersSnap, userDirSnap, clientsSnap, prospectsSnap] = await Promise.all([
    db.collection('users_prod').get(),
    db.collection('userDirectory_prod').get(),
    db.collection('clients_prod').get(),
    db.collection('prospects_prod').get()
  ]);

  const usersList = [];
  const usersMap = {};
  usersSnap.forEach(d => {
    const data = Object.assign({ id: d.id }, d.data());
    usersList.push(data);
    usersMap[d.id] = data;
  });

  const currentDirList = [];
  userDirSnap.forEach(d => currentDirList.push(Object.assign({ id: d.id }, d.data())));

  const clientsList = [];
  clientsSnap.forEach(d => clientsList.push(Object.assign({ id: d.id }, d.data())));

  const prospectsList = [];
  prospectsSnap.forEach(d => prospectsList.push(Object.assign({ id: d.id }, d.data())));

  console.log(`[SIMULATION] Live counts: users=${usersList.length}, userDir=${currentDirList.length}, clients=${clientsList.length}, prospects=${prospectsList.length}`);

  // 1. Plan Prospects
  const prospectsPlan = planProspectsBackfill(prospectsList, usersMap);

  // 2. Plan Clients
  const clientsPlan = planClientsVisibilityBackfill(clientsList, prospectsList, usersMap);

  // 3. Plan User Directory
  const userDirPlan = planUserDirectorySync(usersList, currentDirList);

  return {
    projectId: effectiveProject,
    timestamp: new Date().toISOString(),
    prospects: prospectsPlan,
    clients: clientsPlan,
    userDirectory: userDirPlan
  };
}

module.exports = {
  planProspectsBackfill,
  planClientsVisibilityBackfill,
  planUserDirectorySync,
  runBackfillSimulation,
  resolveSellerNameToCid,
  KNOWN_USERS
};

if (require.main === module) {
  const admin = require('firebase-admin');
  const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');

  (async () => {
    try {
      console.log('================================================================');
      console.log('       SEC-03 FASE F2: SIMULACIÓN DE BACKFILL (DRY-RUN)        ');
      console.log('          ESTRICTAMENTE SOLO LECTURA — ZERO ESCRITURAS         ');
      console.log('================================================================');

      await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
      const db = admin.firestore();

      const result = await runBackfillSimulation({
        db,
        projectId: 'ductsal-erp',
        readOnly: true
      });

      console.log('\n--- 1. PROSPECTS_PROD (TOTAL: ' + result.prospects.total + ') ---');
      console.log(`- Al día (createdBy y vendedorId presentes): ${result.prospects.upToDate.length}`);
      console.log(`- Propuestas de actualización: ${result.prospects.proposedUpdates.length}`);
      console.log(`  * Lote de 24 sin createdBy resueltos: ${result.prospects.proposedUpdates.filter(p => p.category === 'PROSPECT_MISSING_CREATED_BY_RESOLVED').length}`);
      console.log(`  * Lote de 58 sin vendedorId estandarizados: ${result.prospects.proposedUpdates.filter(p => p.category === 'PROSPECT_MISSING_VENDEDOR_ID_STANDARDIZED').length}`);
      console.log(`- Casos ambiguos / revisión manual: ${result.prospects.ambiguousManualReview.length}`);

      if (result.prospects.proposedUpdates.length > 0) {
        console.log('\nMuestra de propuestas en prospects (primeras 5):');
        console.log(JSON.stringify(result.prospects.proposedUpdates.slice(0, 5), null, 2));
      }

      console.log('\n--- 2. CLIENTS_PROD (TOTAL: ' + result.clients.total + ') ---');
      console.log(`- Al día: ${result.clients.upToDate.length}`);
      console.log(`- Propuestas de actualización visibleTo / closingVendors: ${result.clients.proposedUpdates.length}`);
      console.log(`- Clientes sin createdBy resueltos por prospectos unánimes: ${result.clients.missingCreatedByResolved.length}`);
      console.log(`- Clientes huérfanos / ambiguos / revisión manual: ${result.clients.ambiguousManualReview.length}`);

      if (result.clients.missingCreatedByResolved.length > 0) {
        console.log('\nMuestra de 41 clientes sin createdBy resueltos (primeros 5):');
        console.log(JSON.stringify(result.clients.missingCreatedByResolved.slice(0, 5), null, 2));
      }

      console.log('\n--- 3. USERDIRECTORY_PROD (TOTAL ACTUAL: ' + result.userDirectory.currentDirectorySize + ') ---');
      console.log(`- Documentos a sincronizar desde users_prod: ${result.userDirectory.toCreate.length}`);
      console.log(`- Documentos a actualizar: ${result.userDirectory.toUpdate.length}`);
      console.log(`- Documentos huérfanos a eliminar: ${result.userDirectory.toDelete.length}`);
      console.log('\nProyección propuesta para userDirectory_prod:');
      console.log(JSON.stringify(result.userDirectory.toCreate.map(c => c.projection), null, 2));

      console.log('\n================================================================');
      console.log('             SIMULACIÓN COMPLETADA SIN ESCRITURAS               ');
      console.log('================================================================');
    } catch (e) {
      console.error('[SIMULATION ERROR]', e);
      process.exit(1);
    }
  })();
}

