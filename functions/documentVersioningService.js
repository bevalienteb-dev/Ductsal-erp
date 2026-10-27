// functions/documentVersioningService.js
// Domain service for document versioning, substitution validation, lazy migration of legacy records,
// idempotency enforcement, and binding commercial approvals to exact document versions.

const crypto = require('crypto');

class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

function extractDocPath(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc.trim();
  if (typeof doc === 'object') {
    const rawPath = typeof doc.storagePath === 'string' ? doc.storagePath.trim() : (typeof doc.path === 'string' ? doc.path.trim() : '');
    if (rawPath) return rawPath;
    if (typeof doc.url === 'string' && doc.url.trim()) return doc.url.trim();
  }
  return '';
}

function isSameDocument(docA, docB) {
  if (!docA && !docB) return true;
  if (!docA || !docB) return false;
  const pathA = extractDocPath(docA);
  const pathB = extractDocPath(docB);
  if (pathA && pathB) return pathA === pathB;
  return false;
}

function toCanonicalDocPointer(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const p = { name: doc.name || 'documento' };
  const sp = typeof doc.storagePath === 'string' ? doc.storagePath.trim() : (typeof doc.path === 'string' ? doc.path.trim() : null);
  if (sp) p.storagePath = sp;
  if (typeof doc.url === 'string' && doc.url.trim()) p.url = doc.url.trim();
  return p;
}

function generateVersionId(docKey, versionNumber) {
  const cleanKey = String(docKey || 'doc').replace(/[^a-zA-Z0-9_-]/g, '_');
  const rand = crypto.randomBytes(4).toString('hex');
  return `v_${cleanKey}_v${versionNumber}_${Date.now()}_${rand}`;
}

function computeDocPayloadHash(payload) {
  const sort = v => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((a, k) => { a[k] = sort(v[k]); return a; }, {}) : v;
  return crypto.createHash('sha256').update(JSON.stringify(sort(payload))).digest('hex');
}

function buildVersionRecord({
  versionId,
  versionNumber,
  entityType,
  entityId,
  docKey,
  doc,
  estado = 'vigente',
  reemplazaVersionId = null,
  motivoSustitucion = null,
  caller = null,
  esHeredado = false,
  creadoEn = null,
  opId = null,
  payloadHash = null,
  tipoArtefacto = null,
  precioAsociado = null,
  costoAsociado = null,
  hash = null,
  usadaEnCierre = false,
  FieldValue = null
}) {
  const name = (doc && typeof doc.name === 'string' && doc.name.trim())
    ? doc.name.trim()
    : (esHeredado ? 'Documento anterior' : 'Documento');
  const rawStoragePath = (doc && typeof doc.storagePath === 'string' && doc.storagePath.trim())
    ? doc.storagePath.trim()
    : ((doc && typeof doc.path === 'string' && doc.path.trim()) ? doc.path.trim() : null);
  const url = (doc && typeof doc.url === 'string' && doc.url.trim()) ? doc.url.trim() : null;
  const size = (doc && typeof doc.size === 'number' && Number.isFinite(doc.size)) ? doc.size : null;
  const contentType = (doc && typeof doc.contentType === 'string' && doc.contentType.trim()) ? doc.contentType.trim() : null;

  const record = {
    versionId,
    versionNumber: Number(versionNumber) || 1,
    entityType,       // 'client' | 'prospect'
    entityId: String(entityId),
    docKey: String(docKey),
    name,
    storagePath: rawStoragePath,
    url,
    size,
    contentType,
    estado,           // 'vigente' | 'historica'
    reemplazaVersionId: reemplazaVersionId || null,
    motivoSustitucion: motivoSustitucion ? String(motivoSustitucion).trim().slice(0, 500) : null,
    subidoPorId: caller ? (caller.cid || caller.uid || null) : null,
    subidoPorNombre: caller ? (caller.name || 'Comercial') : (esHeredado ? 'Registro anterior' : null),
    subidoPorRol: caller ? (caller.role || null) : null,
    creadoEn: creadoEn || new Date().toISOString(),
    esHeredado: !!esHeredado,
    opId: opId || null,
    payloadHash: payloadHash || null,
    tipoArtefacto: tipoArtefacto || null,
    precioAsociado: (typeof precioAsociado === 'number' && !isNaN(precioAsociado)) ? precioAsociado : null,
    costoAsociado: (typeof costoAsociado === 'number' && !isNaN(costoAsociado)) ? costoAsociado : null,
    hash: hash || null,
    usadaEnCierre: !!usadaEnCierre
  };

  if (FieldValue && typeof FieldValue.serverTimestamp === 'function') {
    record.createdAt = FieldValue.serverTimestamp();
  }

  return record;
}

/**
 * Applies document versioning inside an active Firestore transaction `tx` for multiple documents.
 * Crucial design: ALL Firestore reads (e.g. checking opId) execute in Phase 1 before ANY writes in Phase 2.
 */
async function applyDocumentVersionsTx({
  tx,
  db,
  entityType,
  entityId,
  parentColName,
  items = [],
  caller,
  FieldValue,
  now = () => new Date()
}) {
  const verCol = db.collection(`${parentColName}/${entityId}/document_versions`);
  const opsCol = db.collection(`${parentColName}/${entityId}/document_version_ops`);
  const nowIso = now().toISOString();

  // Phase 1: Preparation & Reads (Strictly BEFORE any tx.set / tx.update)
  const prepared = [];
  for (const item of items) {
    const { docKey, existingDoc, incomingDoc, motivoSustitucion, opId, tipoArtefacto, precioAsociado, costoAsociado, hash, usadaEnCierre } = item;
    if (!incomingDoc) {
      prepared.push({ skip: true, changed: false, substituted: false, doc: existingDoc, versionId: existingDoc ? existingDoc.versionId : null });
      continue;
    }

    const incomingPath = extractDocPath(incomingDoc);
    if (!incomingPath) {
      throw new ServiceError('invalid-argument', `Documento o ruta de archivo inválida para '${docKey}'`);
    }

    let payloadHash = null;
    let opRef = null;
    if (opId) {
      if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(opId)) {
        throw new ServiceError('invalid-argument', 'opId inválido');
      }
      payloadHash = computeDocPayloadHash({
        entityType,
        entityId,
        docKey,
        path: incomingPath,
        name: incomingDoc.name || '',
        motivo: motivoSustitucion || incomingDoc.motivoSustitucion || ''
      });
      opRef = opsCol.doc(opId);
      const opSnap = await tx.get(opRef); // READ
      if (opSnap.exists) {
        const prevOp = opSnap.data() || {};
        if (prevOp.payloadHash !== payloadHash) {
          throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        }
        prepared.push({
          skip: true,
          status: 'unchanged',
          replay: true,
          changed: false,
          substituted: false,
          doc: prevOp.doc || incomingDoc,
          canonicalDoc: toCanonicalDocPointer(prevOp.doc || incomingDoc),
          versionId: prevOp.versionId
        });
        continue;
      }
    }

    const hasExisting = !!(existingDoc && extractDocPath(existingDoc));
    if (!hasExisting) {
      prepared.push({
        type: 'initial',
        docKey,
        incomingDoc,
        opId,
        opRef,
        payloadHash,
        tipoArtefacto,
        precioAsociado,
        costoAsociado,
        hash,
        usadaEnCierre
      });
      continue;
    }

    if (isSameDocument(existingDoc, incomingDoc)) {
      prepared.push({
        skip: true,
        changed: false,
        substituted: false,
        doc: existingDoc,
        canonicalDoc: toCanonicalDocPointer(existingDoc),
        versionId: existingDoc.versionId || null,
        versionNumber: existingDoc.versionNumber || 1
      });
      continue;
    }

    const reason = (typeof motivoSustitucion === 'string' ? motivoSustitucion.trim() : '')
      || (typeof incomingDoc.motivoSustitucion === 'string' ? incomingDoc.motivoSustitucion.trim() : '');

    if (!reason) {
      throw new ServiceError('invalid-argument', `Toda sustitución de un documento existente requiere un motivo no vacío (documento: '${docKey}')`);
    }

    prepared.push({
      type: 'substitute',
      docKey,
      existingDoc,
      incomingDoc,
      reason,
      opId,
      opRef,
      payloadHash,
      tipoArtefacto,
      precioAsociado,
      costoAsociado,
      hash,
      usadaEnCierre
    });
  }

  // Phase 2: Writes (AFTER all reads are completed)
  const results = [];
  for (const prep of prepared) {
    if (prep.skip) {
      results.push(prep);
      continue;
    }

    if (prep.type === 'initial') {
      const versionNumber = 1;
      const versionId = generateVersionId(prep.docKey, versionNumber);
      const verRecord = buildVersionRecord({
        versionId,
        versionNumber,
        entityType,
        entityId,
        docKey: prep.docKey,
        doc: prep.incomingDoc,
        estado: 'vigente',
        reemplazaVersionId: null,
        motivoSustitucion: null,
        caller,
        esHeredado: false,
        creadoEn: nowIso,
        opId: prep.opId,
        payloadHash: prep.payloadHash,
        tipoArtefacto: prep.tipoArtefacto,
        precioAsociado: prep.precioAsociado,
        costoAsociado: prep.costoAsociado,
        hash: prep.hash,
        usadaEnCierre: prep.usadaEnCierre,
        FieldValue
      });

      tx.set(verCol.doc(versionId), verRecord);

      const stampedDoc = {
        ...prep.incomingDoc,
        versionId,
        versionNumber: 1,
        actualizadoEn: nowIso
      };

      if (prep.opRef) {
        tx.set(prep.opRef, {
          opId: prep.opId,
          payloadHash: prep.payloadHash,
          versionId,
          doc: stampedDoc,
          createdBy: caller ? caller.cid : null,
          createdAt: FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : nowIso
        });
      }

      results.push({
        changed: true,
        substituted: false,
        doc: stampedDoc,
        canonicalDoc: toCanonicalDocPointer(prep.incomingDoc),
        versionId,
        versionNumber: 1
      });
      continue;
    }

    if (prep.type === 'substitute') {
      let prevVersionId = prep.existingDoc.versionId || null;
      let prevVersionNumber = typeof prep.existingDoc.versionNumber === 'number' ? prep.existingDoc.versionNumber : 1;

      if (prevVersionId) {
        tx.update(verCol.doc(prevVersionId), {
          estado: 'historica',
          reemplazadoEn: nowIso,
          reemplazadoPorId: caller ? caller.cid : null,
          reemplazadoPorNombre: caller ? (caller.name || 'Comercial') : null
        });
      } else {
        prevVersionId = `v_legacy_${prep.docKey}_${entityId}`;
        prevVersionNumber = 1;
        const legacyRec = buildVersionRecord({
          versionId: prevVersionId,
          versionNumber: 1,
          entityType,
          entityId,
          docKey: prep.docKey,
          doc: prep.existingDoc,
          estado: 'historica',
          reemplazaVersionId: null,
          motivoSustitucion: null,
          caller: null,
          esHeredado: true,
          creadoEn: prep.existingDoc.actualizadoEn || prep.existingDoc.fecha || nowIso,
          opId: null,
          payloadHash: null,
          tipoArtefacto: prep.tipoArtefacto,
          precioAsociado: prep.precioAsociado,
          costoAsociado: prep.costoAsociado,
          hash: prep.hash,
          FieldValue
        });
        legacyRec.reemplazadoEn = nowIso;
        legacyRec.reemplazadoPorId = caller ? caller.cid : null;
        tx.set(verCol.doc(prevVersionId), legacyRec);
      }

      const newVersionNumber = prevVersionNumber + 1;
      const newVersionId = generateVersionId(prep.docKey, newVersionNumber);

      const newRecord = buildVersionRecord({
        versionId: newVersionId,
        versionNumber: newVersionNumber,
        entityType,
        entityId,
        docKey: prep.docKey,
        doc: prep.incomingDoc,
        estado: 'vigente',
        reemplazaVersionId: prevVersionId,
        motivoSustitucion: prep.reason,
        caller,
        esHeredado: false,
        creadoEn: nowIso,
        opId: prep.opId,
        payloadHash: prep.payloadHash,
        tipoArtefacto: prep.tipoArtefacto,
        precioAsociado: prep.precioAsociado,
        costoAsociado: prep.costoAsociado,
        hash: prep.hash,
        usadaEnCierre: prep.usadaEnCierre,
        FieldValue
      });

      tx.set(verCol.doc(newVersionId), newRecord);

      const stampedDoc = {
        ...prep.incomingDoc,
        versionId: newVersionId,
        versionNumber: newVersionNumber,
        actualizadoEn: nowIso,
        motivoSustitucion: prep.reason
      };

      if (prep.opRef) {
        tx.set(prep.opRef, {
          opId: prep.opId,
          payloadHash: prep.payloadHash,
          versionId: newVersionId,
          doc: stampedDoc,
          createdBy: caller ? caller.cid : null,
          createdAt: FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : nowIso
        });
      }

      results.push({
        changed: true,
        substituted: true,
        doc: stampedDoc,
        canonicalDoc: toCanonicalDocPointer(prep.incomingDoc),
        versionId: newVersionId,
        versionNumber: newVersionNumber,
        oldVersionId: prevVersionId,
        motivoSustitucion: prep.reason
      });
    }
  }

  return results;
}

/**
 * Applies document versioning for a single document inside an active Firestore transaction `tx`.
 */
async function applyDocumentVersionTx(args) {
  const [res] = await applyDocumentVersionsTx({
    ...args,
    items: [args]
  });
  return res;
}

function bindNoContractApproval({
  prospect = null,
  datos = null,
  caller,
  offerDoc = null,
  why = null,
  isoStamp = new Date().toISOString()
}) {
  const currentOffer = offerDoc
    || (datos && (datos.doc_firmado || datos.doc_oferta_firmada || datos.doc_oferta))
    || (prospect && (prospect.doc_firmado || (prospect.datos && (prospect.datos.doc_firmado || prospect.datos.doc_oferta_firmada))))
    || null;
  const offerPath = extractDocPath(currentOffer) || null;
  const offerVerId = currentOffer ? (currentOffer.versionId || null) : null;
  const currentPrice = Number((prospect && prospect.precio_cotizado) || (datos && datos.precio_cotizado) || 0);

  if (datos) {
    datos.autorizado_sin_contrato = true;
    datos.autorizado_por = caller.name;
    datos.autorizado_por_id = caller.cid;
  }

  const record = {
    estado: 'aprobada',
    autorizado_por: caller.name,
    autorizado_por_id: caller.cid,
    fecha_aprobacion: isoStamp,
    motivo_decision: why || null,
    montoAutorizado: currentPrice,
    storagePathAprobado: offerPath,
    versionIdAprobada: offerVerId,
    docKey: 'doc_firmado'
  };

  if (prospect) {
    prospect.aprobacion_sin_contrato = record;
  }
  return record;
}

function checkAndInvalidateOfferApproval({
  prospect = null,
  datos = null,
  caller,
  prospectId,
  isoStamp = new Date().toISOString(),
  motivoSustitucion = ''
}) {
  const aprobacion = (prospect && prospect.aprobacion_sin_contrato)
    || (datos && datos.aprobacion_sin_contrato)
    || (prospect && prospect.datos && prospect.datos.aprobacion_sin_contrato);

  const wasAuthorized = (datos && datos.autorizado_sin_contrato === true)
    || (prospect && prospect.datos && prospect.datos.autorizado_sin_contrato === true)
    || (prospect && prospect.autorizado_sin_contrato === true)
    || (aprobacion && aprobacion.estado === 'aprobada');

  if (!wasAuthorized) return null;

  if (datos) {
    datos.autorizado_sin_contrato = false;
  }
  if (prospect && prospect.datos) {
    prospect.datos.autorizado_sin_contrato = false;
  }

  const updatedAprobacion = {
    ...(aprobacion || {}),
    estado: 'invalidada_por_sustitucion',
    fecha_invalidacion: isoStamp,
    invalidado_por_id: caller ? caller.cid : null,
    invalidado_por_nombre: caller ? (caller.name || 'Comercial') : 'Comercial',
    motivo_invalidacion: `Sustitución de oferta firmada (${motivoSustitucion || 'Actualización de documento'}). Requiere nueva aprobación gerencial sobre la nueva versión.`
  };

  if (prospect) {
    prospect.aprobacion_sin_contrato = updatedAprobacion;
  }

  return {
    invalidated: true,
    aprobacionRecord: updatedAprobacion,
    logMsg: 'ADVERTENCIA: La autorización para cerrar sin contrato fue invalidada automáticamente porque se sustituyó la oferta firmada. Se requiere nueva autorización de gerencia sobre la nueva versión.',
    auditDetail: {
      prospectId,
      razon: 'sustitucion_oferta_firmada',
      motivoSustitucion: motivoSustitucion || null,
      versionIdAnteriorAprobada: (aprobacion && aprobacion.versionIdAprobada) ? aprobacion.versionIdAprobada : null,
      storagePathAnteriorAprobado: (aprobacion && aprobacion.storagePathAprobado) ? aprobacion.storagePathAprobado : null
    }
  };
}

function isNoContractApprovalValid({ prospect, datos, activeDocFirmado }) {
  const autorizado = (datos && datos.autorizado_sin_contrato === true)
    || (prospect && prospect.datos && prospect.datos.autorizado_sin_contrato === true)
    || (prospect && prospect.autorizado_sin_contrato === true);

  if (!autorizado) return false;

  const aprobacion = (prospect && prospect.aprobacion_sin_contrato)
    || (datos && datos.aprobacion_sin_contrato)
    || (prospect && prospect.datos && prospect.datos.aprobacion_sin_contrato);

  // Preserve consultation and historical validity for projects already won
  const isWon = (prospect && prospect.estado === 'ganado') || (datos && datos.estado === 'ganado');
  if (isWon) {
    if (!aprobacion) return true;
    if (aprobacion.estado === 'invalidada_por_sustitucion') return false;
    return true;
  }

  // H-02: Active opportunities require an explicit approval record
  if (!aprobacion) return false;
  if (aprobacion.estado !== 'aprobada') return false;

  if (aprobacion.storagePathAprobado) {
    const activePath = extractDocPath(activeDocFirmado);
    if (!activePath || activePath !== aprobacion.storagePathAprobado) return false;
  } else {
    // Legacy approval without storagePathAprobado in an active prospect:
    // Requires an active signed document to be attached
    if (!activeDocFirmado) return false;
  }

  // H-02: For an active opportunity, approval must have a registered montoAutorizado
  if (typeof aprobacion.montoAutorizado !== 'number' || !Number.isFinite(aprobacion.montoAutorizado)) {
    return false;
  }

  // H-01: Exact comparison to cents (rejects both higher and lower prices, no arbitrary tolerance)
  const curP = Number((prospect && prospect.precio_cotizado) || (datos && datos.precio_cotizado) || 0);
  const autP = Number(aprobacion.montoAutorizado);
  if (Math.round(curP * 100) !== Math.round(autP * 100)) {
    return false;
  }

  return true;
}

module.exports = {
  extractDocPath,
  isSameDocument,
  toCanonicalDocPointer,
  generateVersionId,
  computeDocPayloadHash,
  buildVersionRecord,
  applyDocumentVersionsTx,
  applyDocumentVersionTx,
  bindNoContractApproval,
  checkAndInvalidateOfferApproval,
  isNoContractApprovalValid
};
