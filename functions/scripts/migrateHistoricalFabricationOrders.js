#!/usr/bin/env node
/**
 * DUCTSAL ERP — Script Auditado de Compatibilidad para Órdenes Históricas de Fabricación (Bloque 4)
 *
 * Propósito:
 * Identificar e instrumentar de forma mínima, segura y auditada las órdenes de fabricación
 * preexistentes creadas antes de la compuerta financiera de anticipo obligatorio, garantizando:
 * 1. NUNCA asignar indiscriminadamente `liberado_a_fabricacion_backend: true` a órdenes históricas.
 * 2. Establecer `excepcion_legado_verificada: true` y `origen_excepcion_legado: 'MIGRACION_HISTORICA_PRE_COMPUERTA'`
 *    únicamente mediante Admin SDK (backend), campos protegidos contra edición desde el navegador en `firestore.rules`.
 * 3. Permitir continuidad operativa legítima a órdenes ya iniciadas en `Fabricación`, `Quality Control`,
 *    `Control de Calidad`, `Despacho` y `Entregado`.
 * 4. Impedir que proyectos u órdenes comerciales en `Recepción` o `Dibujo` utilicen la excepción de legado
 *    para crear nuevas órdenes comerciales o liberarse a `Fabricación` sin anticipo 100% confirmado.
 * 5. Incluir modo `--dry-run` (por defecto) y procedimiento de `--rollback` determinista con manifiesto auditable.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const POST_DIBUJO_STAGES = new Set([
  'Fabricación',
  'Quality Control',
  'Control de Calidad',
  'Despacho',
  'Entregado',
  'Completado'
]);

const LEGACY_FIELDS = [
  'excepcion_legado_verificada',
  'origen_excepcion_legado',
  'fecha_excepcion_legado',
  'autorizado_excepcion_legado_por',
  'estado_habilitacion_fabricacion',
  'liberado_a_fabricacion_backend'
];

function snapshotLegacyFields(data) {
  const snap = {};
  for (const key of LEGACY_FIELDS) {
    snap[key] = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : '__ABSENT__';
  }
  return snap;
}

/**
 * Ejecuta la inspección, migración auditada o rollback de órdenes históricas de fabricación.
 */
async function runHistoricalFabricationMigration({
  db,
  FieldValue = null,
  dbSuffix = '_prod',
  apply = false,
  confirmMigration = false,
  rollback = false,
  rollbackManifest = null,
  caller = {
    uid: 'script-migrate-historical-fab',
    cid: 'ADMIN_MIGRATION_HISTORICAL_FAB',
    role: 'manager',
    name: 'Migración Auditada de Órdenes Históricas de Fabricación'
  },
  nowIso = new Date().toISOString()
}) {
  if (!db) {
    throw new Error('Se requiere una instancia válida de Firestore (db).');
  }
  const cleanSuffix = dbSuffix === '_local' ? '_local' : '_prod';
  const colName = (base) => `${base}${cleanSuffix}`;

  if (rollback) {
    if (!rollbackManifest || !Array.isArray(rollbackManifest.entries)) {
      throw new Error('Para ejecutar --rollback debe proporcionar un manifiesto válido con entries[].');
    }
    let restoredCount = 0;
    const batch = db.batch();
    for (const entry of rollbackManifest.entries) {
      if (!entry || !entry.collection || !entry.docId || !entry.previousFields) continue;
      const docRef = db.collection(entry.collection).doc(entry.docId);
      const docSnap = await docRef.get();
      if (!docSnap.exists) continue;
      const currentData = { ...(docSnap.data() || {}) };
      for (const [k, prevVal] of Object.entries(entry.previousFields)) {
        if (prevVal === '__ABSENT__') {
          if (FieldValue && typeof FieldValue.delete === 'function') {
            currentData[k] = FieldValue.delete();
          } else {
            delete currentData[k];
          }
        } else {
          currentData[k] = prevVal;
        }
      }
      if (FieldValue && typeof FieldValue.delete === 'function') {
        batch.update(docRef, currentData);
      } else {
        batch.set(docRef, currentData);
      }
      restoredCount++;
    }
    const auditId = `AUD_ROLLBACK_HIST_FAB_${Date.now()}`;
    batch.set(db.collection(colName('audit_logs')).doc(auditId), {
      id: auditId,
      action: 'rollbackHistoricalFabricationOrders',
      actorUid: caller.uid,
      actorCid: caller.cid,
      actorRole: caller.role,
      targetId: `HIST_FAB_${cleanSuffix}`,
      timestamp: nowIso,
      details: {
        dbSuffix: cleanSuffix,
        restoredCount,
        manifestCreatedAt: rollbackManifest.createdAt || null
      }
    });
    await batch.commit();
    return {
      status: 'rolled_back',
      mode: 'ROLLBACK_APPLIED',
      dbSuffix: cleanSuffix,
      restoredCount,
      timestamp: nowIso
    };
  }

  if (apply && !confirmMigration) {
    throw new Error('Para aplicar la migración histórica debe confirmar con confirmMigration: true (--confirm-historical-fabrication-migration).');
  }

  const [projsSnap, ordersSnap, tasksSnap] = await Promise.all([
    db.collection(colName('proyectos_fabricacion')).get(),
    db.collection(colName('fabricacion')).get(),
    db.collection(colName('fabricacion_tasks')).get()
  ]);

  const byStage = {};
  let missingAutorizadoBackend = 0;
  let missingLiberadoBackend = 0;
  let missingEstadoHabilitacion = 0;
  let linkedToProspectCount = 0;
  let internalCount = 0;

  const plannedOrderUpdates = [];
  const plannedTaskUpdates = [];
  const manifestEntries = [];

  for (const doc of ordersSnap.docs) {
    const d = doc.data() || {};
    const etapa = String(d.etapa || 'SIN_ETAPA').trim();
    byStage[etapa] = (byStage[etapa] || 0) + 1;

    const hasAutorizado = d.autorizado_backend === true;
    const hasLiberado = d.liberado_a_fabricacion_backend === true;
    const hasEstadoHab = Boolean(d.estado_habilitacion_fabricacion);
    const hasProspect = Boolean(d.prospecto_id && String(d.prospecto_id).trim());
    const isAlreadyVerifiedLegacy = Boolean(
      d.excepcion_legado_verificada === true &&
      typeof d.origen_excepcion_legado === 'string' &&
      d.origen_excepcion_legado.trim().length > 0
    );

    if (!hasAutorizado) missingAutorizadoBackend++;
    if (!hasLiberado) missingLiberadoBackend++;
    if (!hasEstadoHab) missingEstadoHabilitacion++;
    if (hasProspect || d.origen_tipo === 'oportunidad') {
      linkedToProspectCount++;
    } else {
      internalCount++;
    }

    // Identificar únicamente órdenes preexistentes que carecen de autorización backend nueva y aún no tienen excepción de legado
    if (!hasLiberado && !hasAutorizado && !isAlreadyVerifiedLegacy) {
      const isPostDibujo = POST_DIBUJO_STAGES.has(etapa);
      const isCommercial = Boolean(hasProspect || d.origen_tipo === 'oportunidad');
      // Importante:
      // - Si la orden ya está iniciada en planta (Fabricación / QA / Despacho / Entregado), recibe
      //   `estado_habilitacion_fabricacion: 'EXCEPCION_HISTORIA_PREEXISTENTE'` (o `'ORDEN_INTERNA_NO_COMERCIAL'` si es interna),
      //   SIN asignar `liberado_a_fabricacion_backend: true`.
      // - Si la orden está en pre-fabricación (Recepción / Dibujo) y es comercial, NO se marca como liberada ni exenta de anticipo
      //   para avanzar a Fabricación; conserva su requisito de validación financiera en `validateAndAuthorizeFabricationOrderAdmin`.
      let targetEstadoHab = d.estado_habilitacion_fabricacion || null;
      if (!targetEstadoHab) {
        if (!isCommercial) {
          targetEstadoHab = 'ORDEN_INTERNA_NO_COMERCIAL';
        } else if (isPostDibujo) {
          targetEstadoHab = 'EXCEPCION_HISTORIA_PREEXISTENTE';
        } else {
          targetEstadoHab = 'PENDIENTE_VALIDACION_COMPUERTA';
        }
      }

      const patch = {
        excepcion_legado_verificada: true,
        origen_excepcion_legado: 'MIGRACION_HISTORICA_PRE_COMPUERTA',
        fecha_excepcion_legado: nowIso,
        autorizado_excepcion_legado_por: caller.cid || caller.uid,
        liberado_a_fabricacion_backend: false,
        estado_habilitacion_fabricacion: targetEstadoHab
      };

      plannedOrderUpdates.push({
        docId: doc.id,
        codigo_orden: d.codigo_orden || null,
        proyecto: d.proyecto || null,
        etapa,
        origen_tipo: d.origen_tipo || (hasProspect ? 'oportunidad' : 'interno'),
        prospecto_id: d.prospecto_id || null,
        patch
      });

      manifestEntries.push({
        collection: colName('fabricacion'),
        docId: doc.id,
        previousFields: snapshotLegacyFields(d)
      });
    }
  }

  for (const doc of tasksSnap.docs) {
    const td = doc.data() || {};
    const isTaskVerifiedLegacy = Boolean(
      td.excepcion_legado_verificada === true &&
      typeof td.origen_excepcion_legado === 'string' &&
      td.origen_excepcion_legado.trim().length > 0
    );
    if (td.creada_en_backend !== true && !isTaskVerifiedLegacy) {
      const taskPatch = {
        excepcion_legado_verificada: true,
        origen_excepcion_legado: 'MIGRACION_HISTORICA_PRE_COMPUERTA',
        fecha_excepcion_legado: nowIso,
        autorizado_excepcion_legado_por: caller.cid || caller.uid
      };
      plannedTaskUpdates.push({
        docId: doc.id,
        fabricacion_id: td.fabricacion_id || null,
        station: td.station || null,
        status: td.status || null,
        patch: taskPatch
      });
      manifestEntries.push({
        collection: colName('fabricacion_tasks'),
        docId: doc.id,
        previousFields: snapshotLegacyFields(td)
      });
    }
  }

  const summary = {
    dbSuffix: cleanSuffix,
    collections: {
      proyectos_fabricacion: projsSnap.size,
      fabricacion: ordersSnap.size,
      fabricacion_tasks: tasksSnap.size
    },
    byStage,
    missingAutorizadoBackend,
    missingLiberadoBackend,
    missingEstadoHabilitacion,
    linkedToProspectCount,
    internalCount,
    plannedOrderUpdatesCount: plannedOrderUpdates.length,
    plannedTaskUpdatesCount: plannedTaskUpdates.length
  };

  const rollbackManifestOut = {
    createdAt: nowIso,
    dbSuffix: cleanSuffix,
    actorCid: caller.cid || caller.uid,
    entries: manifestEntries
  };

  if (!apply) {
    return {
      status: 'dry_run_ready',
      mode: 'DRY_RUN_READ_ONLY',
      summary,
      plannedOrderUpdates,
      plannedTaskUpdatesCount: plannedTaskUpdates.length,
      rollbackManifest: rollbackManifestOut
    };
  }

  const batch = db.batch();
  for (const item of plannedOrderUpdates) {
    const ref = db.collection(colName('fabricacion')).doc(item.docId);
    batch.update(ref, item.patch);
  }
  for (const tItem of plannedTaskUpdates) {
    const tRef = db.collection(colName('fabricacion_tasks')).doc(tItem.docId);
    batch.update(tRef, tItem.patch);
  }

  const auditId = `AUD_MIGRATE_HIST_FAB_${Date.now()}`;
  batch.set(db.collection(colName('audit_logs')).doc(auditId), {
    id: auditId,
    action: 'migrateHistoricalFabricationOrders',
    actorUid: caller.uid,
    actorCid: caller.cid,
    actorRole: caller.role,
    targetId: `HIST_FAB_${cleanSuffix}`,
    timestamp: nowIso,
    details: {
      dbSuffix: cleanSuffix,
      migratedOrdersCount: plannedOrderUpdates.length,
      migratedTasksCount: plannedTaskUpdates.length,
      origenExcepcionLegado: 'MIGRACION_HISTORICA_PRE_COMPUERTA'
    }
  });

  await batch.commit();

  return {
    status: 'migrated',
    mode: 'APPLIED',
    summary,
    migratedOrdersCount: plannedOrderUpdates.length,
    migratedTasksCount: plannedTaskUpdates.length,
    rollbackManifest: rollbackManifestOut
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const confirmMigration = args.includes('--confirm-historical-fabrication-migration');
  const rollback = args.includes('--rollback');
  const dbSuffix = args.includes('--local') ? '_local' : '_prod';
  const manifestIdx = args.indexOf('--manifest');
  const manifestPath = manifestIdx >= 0 ? args[manifestIdx + 1] : null;
  const saveManifestIdx = args.indexOf('--save-manifest');
  const saveManifestPath = saveManifestIdx >= 0 ? args[saveManifestIdx + 1] : null;

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'ductsal-erp' });
  }
  const db = admin.firestore();

  let rollbackManifest = null;
  if (rollback) {
    if (!manifestPath) {
      throw new Error('Debe especificar --manifest <ruta.json> para ejecutar --rollback.');
    }
    rollbackManifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  }

  const res = await runHistoricalFabricationMigration({
    db,
    FieldValue: admin.firestore.FieldValue,
    dbSuffix,
    apply,
    confirmMigration,
    rollback,
    rollbackManifest
  });

  if (saveManifestPath && res.rollbackManifest) {
    fs.writeFileSync(path.resolve(saveManifestPath), JSON.stringify(res.rollbackManifest, null, 2), 'utf8');
  }

  console.log(JSON.stringify(res, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = {
  runHistoricalFabricationMigration,
  POST_DIBUJO_STAGES
};

