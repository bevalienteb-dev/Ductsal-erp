// functions/migrateHistoricalQuotes.js
// Idempotent and auditable migration service for historical quotes (doc_oferta) and cost sheets (doc_costos).
// Designed for dry-run simulation, ambiguity detection, duplicate auditing, and safe batching without touching production.

const crypto = require('crypto');
const { extractDocPath, toCanonicalDocPointer } = require('./documentVersioningService');

function isValidStoragePathOrUrl(path) {
  if (!path || typeof path !== 'string') return false;
  const p = path.trim();
  return p.startsWith('prod_files/') || p.startsWith('local_files/') || p.startsWith('https://') || p.startsWith('gs://');
}

/**
 * Plans and optionally executes a dry-run migration of historical quotes.
 *
 * @param {Object} options
 * @param {Object} options.db - Firestore instance (Admin SDK or emulator)
 * @param {string} [options.suffix='_prod'] - Collection suffix
 * @param {boolean} [options.dryRun=true] - If true, only plans and audits; does not write to Firestore.
 * @returns {Promise<Object>} Migration report with pre/post counts, itemized categories and audit trail.
 */
async function planHistoricalQuotesMigration({ db, suffix = '_prod', dryRun = true }) {
  if (!db) throw new Error('db is required for migration');

  const prospectsColName = `prospects${suffix}`;
  const snap = await db.collection(prospectsColName).get();

  const report = {
    dryRun: !!dryRun,
    collection: prospectsColName,
    timestamp: new Date().toISOString(),
    counts: {
      totalProspects: snap.size,
      prospectsWithQuotes: 0,
      migrableQuotes: 0,
      migrableCostSheets: 0,
      alreadyVersioned: 0,
      ambiguous: 0,
      duplicates: 0,
      manualReviewRequired: 0,
      executedWrites: 0
    },
    details: {
      migrable: [],
      alreadyVersioned: [],
      ambiguous: [],
      duplicates: [],
      manualReview: []
    }
  };

  for (const docSnap of snap.docs) {
    const prospectId = docSnap.id;
    const p = docSnap.data() || {};
    const datos = (p.datos && typeof p.datos === 'object') ? p.datos : {};

    const hasOferta = !!(datos.doc_oferta && (Array.isArray(datos.doc_oferta) ? datos.doc_oferta.length > 0 : true));
    const hasCostos = !!(datos.doc_costos && (Array.isArray(datos.doc_costos) ? datos.doc_costos.length > 0 : true));

    if (!hasOferta && !hasCostos) {
      continue;
    }

    report.counts.prospectsWithQuotes++;

    // Check existing versions in subcollection
    const verSnap = await db.collection(`${prospectsColName}/${prospectId}/document_versions`).get();
    const existingVersionKeys = new Set();
    const existingStoragePaths = new Set();

    for (const vDoc of verSnap.docs) {
      const vData = vDoc.data() || {};
      if (vData.docKey) existingVersionKeys.add(vData.docKey);
      if (vData.storagePath) existingStoragePaths.add(vData.storagePath);
    }

    // Inspect doc_oferta
    if (hasOferta) {
      const rawOfertaList = Array.isArray(datos.doc_oferta) ? datos.doc_oferta : [datos.doc_oferta];
      for (let idx = 0; idx < rawOfertaList.length; idx++) {
        const item = rawOfertaList[idx];
        const path = extractDocPath(item);

        if (!path || !isValidStoragePathOrUrl(path)) {
          report.counts.ambiguous++;
          report.details.ambiguous.push({
            prospectId,
            docKey: 'doc_oferta',
            index: idx,
            reason: 'Documento de oferta sin ruta de almacenamiento válida',
            raw: item
          });
          continue;
        }

        if (existingStoragePaths.has(path)) {
          report.counts.alreadyVersioned++;
          report.details.alreadyVersioned.push({ prospectId, docKey: 'doc_oferta', path });
          continue;
        }

        // Duplicate check within same prospect
        const dupCount = rawOfertaList.filter(o => extractDocPath(o) === path).length;
        if (dupCount > 1 && idx > 0) {
          report.counts.duplicates++;
          report.details.duplicates.push({ prospectId, docKey: 'doc_oferta', path, count: dupCount });
          continue;
        }

        // Check if manual review needed (e.g. malformed or contradictory)
        if (typeof item === 'object' && item && !item.name && !item.storagePath && !item.url) {
          report.counts.manualReviewRequired++;
          report.details.manualReview.push({
            prospectId,
            docKey: 'doc_oferta',
            reason: 'Objeto de documento con campos no conformes',
            item
          });
          continue;
        }

        report.counts.migrableQuotes++;
        report.details.migrable.push({
          prospectId,
          docKey: 'doc_oferta',
          tipoArtefacto: 'oferta_comercial',
          doc: item,
          path,
          precioAsociado: typeof p.precio_cotizado === 'number' ? p.precio_cotizado : null,
          costoAsociado: typeof p.costo_venta === 'number' ? p.costo_venta : null,
          vendedorId: p.vendedorId || p.createdBy || 'desconocido',
          creadoEn: p.fecha_creacion || p.createdAt || 'desconocido'
        });
      }
    }

    // Inspect doc_costos
    if (hasCostos) {
      const rawCostosList = Array.isArray(datos.doc_costos) ? datos.doc_costos : [datos.doc_costos];
      for (let idx = 0; idx < rawCostosList.length; idx++) {
        const item = rawCostosList[idx];
        const path = extractDocPath(item);

        if (!path || !isValidStoragePathOrUrl(path)) {
          report.counts.ambiguous++;
          report.details.ambiguous.push({
            prospectId,
            docKey: 'doc_costos',
            index: idx,
            reason: 'Cuadro de costos sin ruta de almacenamiento válida',
            raw: item
          });
          continue;
        }

        if (existingStoragePaths.has(path)) {
          report.counts.alreadyVersioned++;
          report.details.alreadyVersioned.push({ prospectId, docKey: 'doc_costos', path });
          continue;
        }

        const dupCount = rawCostosList.filter(c => extractDocPath(c) === path).length;
        if (dupCount > 1 && idx > 0) {
          report.counts.duplicates++;
          report.details.duplicates.push({ prospectId, docKey: 'doc_costos', path, count: dupCount });
          continue;
        }

        if (typeof item === 'object' && item && !item.name && !item.storagePath && !item.url) {
          report.counts.manualReviewRequired++;
          report.details.manualReview.push({
            prospectId,
            docKey: 'doc_costos',
            reason: 'Objeto de costos con campos no conformes',
            item
          });
          continue;
        }

        report.counts.migrableCostSheets++;
        report.details.migrable.push({
          prospectId,
          docKey: 'doc_costos',
          tipoArtefacto: 'cuadro_costos_interno',
          doc: item,
          path,
          precioAsociado: typeof p.precio_cotizado === 'number' ? p.precio_cotizado : null,
          costoAsociado: typeof p.costo_venta === 'number' ? p.costo_venta : null,
          vendedorId: p.vendedorId || p.createdBy || 'desconocido',
          creadoEn: p.fecha_creacion || p.createdAt || 'desconocido'
        });
      }
    }
  }

  // If not dry-run, execute the writes safely and idempotently
  if (!dryRun && report.details.migrable.length > 0) {
    for (const item of report.details.migrable) {
      const verCol = db.collection(`${prospectsColName}/${item.prospectId}/document_versions`);
      const pathHash = crypto.createHash('sha256').update(`${item.docKey}:${item.path}`).digest('hex').slice(0, 16);
      const versionDocId = `v_hist_${item.docKey}_${pathHash}`;

      const name = (typeof item.doc === 'object' && item.doc && item.doc.name)
        ? String(item.doc.name).trim()
        : (item.docKey === 'doc_oferta' ? 'Oferta Comercial Histórica' : 'Cuadro de Costos Histórico');

      const versionRecord = {
        versionId: versionDocId,
        versionNumber: 1,
        entityType: 'prospect',
        entityId: item.prospectId,
        docKey: item.docKey,
        name,
        storagePath: item.path,
        url: (typeof item.doc === 'object' && item.doc && item.doc.url) ? item.doc.url : null,
        size: (typeof item.doc === 'object' && item.doc && typeof item.doc.size === 'number') ? item.doc.size : null,
        contentType: null,
        estado: 'vigente',
        reemplazaVersionId: null,
        motivoSustitucion: null, // explicitly null, not invented
        subidoPorId: item.vendedorId,
        subidoPorNombre: 'Registro histórico anterior',
        subidoPorRol: 'vendedor',
        creadoEn: item.creadoEn,
        esHeredado: true,
        tipoArtefacto: item.tipoArtefacto,
        precioAsociado: item.precioAsociado,
        costoAsociado: item.costoAsociado,
        hash: null, // explicitly null when bytes not computed
        usadaEnCierre: false,
        migradoEn: new Date().toISOString()
      };

      await verCol.doc(versionDocId).set(versionRecord);
      report.counts.executedWrites++;
    }
  }

  return report;
}

module.exports = {
  planHistoricalQuotesMigration
};
