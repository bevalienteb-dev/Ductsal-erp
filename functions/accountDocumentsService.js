// functions/accountDocumentsService.js
// Server-side logic for Account Documents, Legal Representation, Powers, Biennial Reviews,
// and Document Validation at Opportunity Closing (Phase 2, Block B3).
//
// Invariants enforced:
//   1. Compatibility: Preserves canonical `DOC_KEYS = ['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui']`
//      and seamlessly integrates `poder_firma_contrato` as the single functional contract representation key.
//   2. RL Representation Periods: Multiple independent election terms preserved in history.
//   3. AUTOMATIC INVALIDATION OF POWERS: Any new election of a Legal Representative (whether re-election or new person)
//      automatically and atomically invalidates ALL powers granted under the previous term (`anulado_por_nueva_eleccion`).
//   4. Expirations: Enforces validity of documents with defined expiration (DUI, credencial). Prevents renewing an expired
//      document with an identical file (SHA-256 integrity check) or equal/past expiration date.
//   5. Biennial Reviews: Requires review every 2 years for documents without fixed expiration (e.g. pacto social / mods).
//      Allows Option A (new modification) or Option B (explicit no-changes confirmation for 2 more years).
//   6. Closing Validation: Centralized `validateAccountDocumentsForOpportunityClose` checks all mandatory docs, expirations,
//      biennial reviews, and contractual signatory accreditation (RL vs valid attorney-in-fact) when a contract is required.

const crypto = require('crypto');

class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const CRM_ROLES = ['manager', 'gestor', 'vendedor'];
const PRIVILEGED = ['manager', 'gestor'];
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const CANONICAL_DOC_KEYS = ['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui'];
const POWER_DOC_KEY = 'poder_firma_contrato';
const ALL_DOC_KEYS = [...CANONICAL_DOC_KEYS, POWER_DOC_KEY];

const DOC_FAMILIES = {
  CONSTITUCION_GOBIERNO: ['escritura', 'mods_escritura', 'credencial'],
  IDENTIDAD_FISCAL: ['dui', 'nit', 'nrc'],
  REPRESENTACION_CONTRACTUAL: ['poder_firma_contrato']
};

const DOCUMENTS_REQUIRING_BIENNIAL_REVIEW = ['escritura', 'mods_escritura'];
const DOCUMENTS_WITH_EXPIRATION = ['dui', 'credencial'];

function namesFor(suffix) {
  return {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    users: `users${suffix}`,
    contacts: `contacts${suffix}`,
    audit: `commercialAudit${suffix}`,
    ops: `accountDocumentOps${suffix}`
  };
}

function reqString(val, name, max = 200) {
  if (val === undefined || val === null) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  const s = String(val).trim();
  if (!s) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  if (s.length > max) throw new ServiceError('invalid-argument', `${name} no puede superar los ${max} caracteres`);
  return s;
}

function sanitizeSha256(val) {
  if (!val || typeof val !== 'string') return null;
  const clean = val.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : null;
}

function sanitizeDate(val, name) {
  if (!val) return null;
  const s = String(val).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ServiceError('invalid-argument', `${name} debe tener formato YYYY-MM-DD`);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new ServiceError('invalid-argument', `${name} es una fecha inválida`);
  }
  return s;
}

function isTodayOrFuture(dateStr, todayStr = new Date().toISOString().slice(0, 10)) {
  if (!dateStr) return true;
  return dateStr >= todayStr;
}

function computeDaysDifference(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  const diffMs = Math.abs(d2.getTime() - d1.getTime());
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function createAccountDocumentsService({ db, FieldValue, suffix = '_prod' }) {
  if (!db) throw new Error('db is required');
  if (!FieldValue) throw new Error('FieldValue is required');

  const names = namesFor(suffix);
  const col = k => db.collection(names[k]);

  async function resolveCaller(context) {
    if (!context || !context.auth || !context.auth.uid) throw new ServiceError('unauthenticated', 'Authentication required');
    const uid = context.auth.uid;
    const token = context.auth.token || {};
    let profile = null;
    if (token.cid) {
      const snap = await col('users').doc(String(token.cid)).get();
      if (snap.exists) profile = { ...snap.data(), docId: snap.id || (snap.data() && snap.data().id) };
    } else {
      const q = await col('users').where('authUid', '==', uid).limit(2).get();
      if (q.size === 1) profile = { ...q.docs[0].data(), docId: q.docs[0].id };
    }
    const deny = () => new ServiceError('permission-denied', 'Se requiere un usuario activo del CRM vinculado a esta sesión');
    if (!profile || profile.authUid !== uid || profile.activo !== true || !CRM_ROLES.includes(profile.role)) throw deny();
    if (profile.role === 'manager' && token.manager !== true) throw deny();
    return { uid, cid: profile.docId, role: profile.role, name: profile.nombre || '' };
  }

  function assertCaller(caller) {
    if (!caller || !caller.uid || !caller.role || !caller.cid) {
      throw new ServiceError('unauthenticated', 'Se requiere una sesión activa del CRM');
    }
    if (!CRM_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'Rol no autorizado para operaciones de gestión documental');
    }
  }

  function canAccessAccount(caller, client) {
    if (!caller || !client) return false;
    if (PRIVILEGED.includes(caller.role)) return true;
    if (client.createdBy === caller.cid) return true;
    if (Array.isArray(client.visibleTo) && client.visibleTo.includes(caller.cid)) return true;
    if (client.vendedor_asignado === caller.cid) return true;
    if (Array.isArray(client.closingVendors) && client.closingVendors.includes(caller.cid)) return true;
    return false;
  }

  function addAudit(tx, caller, action, entityId, metadata = {}, result = 'success') {
    const ref = col('audit').doc();
    const entry = {
      actor: {
        cid: caller.cid,
        uid: caller.uid,
        name: caller.name || 'Comercial',
        role: caller.role
      },
      action,
      entity: 'account_document',
      entityId: String(entityId),
      metadata,
      result,
      environment: suffix === '_prod' ? 'production' : 'local',
      timestamp: FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString()
    };
    tx.set(ref, entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // 1. Registro y Renovación de Término de Representante Legal
  // ---------------------------------------------------------------------------
  async function registerLegalRepresentativeTerm({
    caller,
    accountId,
    contactId = null,
    nombre,
    fechaEleccion,
    fechaInicio = null,
    fechaVencimiento = null,
    credencialDoc,
    duiDoc,
    opId = null
  }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');
    const cleanNombre = reqString(nombre, 'nombre del representante legal');
    const cleanFechaEleccion = sanitizeDate(reqString(fechaEleccion, 'fechaEleccion'), 'fechaEleccion');
    const cleanFechaInicio = sanitizeDate(fechaInicio, 'fechaInicio');
    const cleanFechaVencimiento = sanitizeDate(fechaVencimiento, 'fechaVencimiento');

    if (cleanFechaVencimiento && cleanFechaVencimiento < cleanFechaEleccion) {
      throw new ServiceError('invalid-argument', 'La fecha de vencimiento no puede ser anterior a la fecha de elección');
    }

    if (!credencialDoc || typeof credencialDoc !== 'object') {
      throw new ServiceError('invalid-argument', 'Debe adjuntar la credencial que acredita el nombramiento');
    }
    if (!duiDoc || typeof duiDoc !== 'object') {
      throw new ServiceError('invalid-argument', 'Debe adjuntar el DUI del representante legal');
    }

    return db.runTransaction(async tx => {
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const clientTermsCol = clientRef.collection('legal_representative_terms');
      const clientPowersCol = clientRef.collection('contract_powers');
      const clientVersionsCol = clientRef.collection('document_versions');

      // 1. Read existing active term (if any)
      const activeTermsSnap = await tx.get(clientTermsCol.where('estado', '==', 'vigente'));
      const previousActiveTerm = !activeTermsSnap.empty ? { id: activeTermsSnap.docs[0].id, ...activeTermsSnap.docs[0].data() } : null;

      // 2. Read all currently active contract powers to invalidate them
      const activePowersSnap = await tx.get(clientPowersCol.where('estado', '==', 'vigente'));
      const powersToInvalidate = [];
      activePowersSnap.forEach(d => {
        powersToInvalidate.push({ id: d.id, ref: d.ref, ...d.data() });
      });

      const nowIso = new Date().toISOString();
      const rand = crypto.randomBytes(4).toString('hex');
      const newTermId = `term_${Date.now()}_${rand}`;

      // Invalidate previous term
      if (previousActiveTerm) {
        tx.update(clientTermsCol.doc(previousActiveTerm.id), {
          estado: 'historico',
          reemplazadoPorTermId: newTermId,
          reemplazadoEn: nowIso,
          reemplazadoPor: caller.cid,
          updatedAt: FieldValue.serverTimestamp()
        });
        addAudit(tx, caller, 'LEGAL_REPRESENTATIVE_TERM_CLOSED', previousActiveTerm.id, {
          accountId: cleanAccountId,
          previousTermId: previousActiveTerm.id,
          newTermId,
          previousNombre: previousActiveTerm.nombre,
          newNombre: cleanNombre
        });
      }

      // 3. Atomically invalidate all powers granted under previous election
      for (const power of powersToInvalidate) {
        tx.update(power.ref, {
          estado: 'anulado_por_nueva_eleccion',
          anuladoEn: nowIso,
          anuladoPor: caller.cid,
          anuladoPorTermId: newTermId,
          motivoAnulacion: 'Poder invalidado automáticamente por nueva elección de Representante Legal',
          updatedAt: FieldValue.serverTimestamp()
        });
        addAudit(tx, caller, 'POWER_INVALIDATED_BY_NEW_ELECTION', power.id, {
          accountId: cleanAccountId,
          powerId: power.id,
          apoderadoNombre: power.nombreApoderado,
          previousTermId: power.termId,
          newTermId,
          motivo: 'Invalidación automática por nueva elección'
        });
      }

      // 4. Register version for Credencial
      const credVersionId = `v_cred_${Date.now()}_${rand}`;
      const credRecord = {
        versionId: credVersionId,
        versionNumber: (client.documentos && client.documentos.credencial && client.documentos.credencial.versionNumber) ? (client.documentos.credencial.versionNumber + 1) : 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: 'credencial',
        name: credencialDoc.name || 'Credencial de Elección',
        storagePath: credencialDoc.storagePath || credencialDoc.path || null,
        url: credencialDoc.url || null,
        size: credencialDoc.size || null,
        contentType: credencialDoc.contentType || null,
        sha256: sanitizeSha256(credencialDoc.sha256) || null,
        fechaEmision: cleanFechaEleccion,
        fechaVencimiento: cleanFechaVencimiento,
        termId: newTermId,
        estado: 'vigente',
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(credVersionId), credRecord);

      // 5. Register version for DUI
      const duiVersionId = `v_dui_${Date.now()}_${rand}`;
      const duiRecord = {
        versionId: duiVersionId,
        versionNumber: (client.documentos && client.documentos.dui && client.documentos.dui.versionNumber) ? (client.documentos.dui.versionNumber + 1) : 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: 'dui',
        name: duiDoc.name || 'DUI Representante Legal',
        storagePath: duiDoc.storagePath || duiDoc.path || null,
        url: duiDoc.url || null,
        size: duiDoc.size || null,
        contentType: duiDoc.contentType || null,
        sha256: sanitizeSha256(duiDoc.sha256) || null,
        fechaVencimiento: duiDoc.fechaVencimiento ? sanitizeDate(duiDoc.fechaVencimiento, 'fechaVencimiento DUI') : null,
        termId: newTermId,
        estado: 'vigente',
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(duiVersionId), duiRecord);

      // 6. Store new term document
      const newTermData = {
        id: newTermId,
        accountId: cleanAccountId,
        contactId: contactId ? String(contactId).trim() : null,
        nombre: cleanNombre,
        fechaEleccion: cleanFechaEleccion,
        fechaInicio: cleanFechaInicio,
        fechaVencimiento: cleanFechaVencimiento,
        credencialDoc: {
          name: credRecord.name,
          storagePath: credRecord.storagePath,
          url: credRecord.url,
          versionId: credVersionId,
          versionNumber: credRecord.versionNumber,
          sha256: credRecord.sha256,
          fechaVencimiento: cleanFechaVencimiento
        },
        duiDoc: {
          name: duiRecord.name,
          storagePath: duiRecord.storagePath,
          url: duiRecord.url,
          versionId: duiVersionId,
          versionNumber: duiRecord.versionNumber,
          sha256: duiRecord.sha256
        },
        estado: 'vigente',
        invalidatedPowersCount: powersToInvalidate.length,
        registradoPor: caller.cid,
        registradoPorNombre: caller.name,
        registradoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientTermsCol.doc(newTermId), newTermData);

      // 7. Update client root document (maintaining backward-compatible pointer map)
      const updatedDocs = { ...(client.documentos || {}) };
      updatedDocs.credencial = newTermData.credencialDoc;
      updatedDocs.dui = newTermData.duiDoc;

      tx.update(clientRef, {
        representanteLegalVigente: {
          termId: newTermId,
          contactId: newTermData.contactId,
          nombre: cleanNombre,
          fechaEleccion: cleanFechaEleccion,
          fechaInicio: cleanFechaInicio,
          fechaVencimiento: cleanFechaVencimiento,
          credencialVersionId: credVersionId,
          duiVersionId: duiVersionId,
          credencialDoc: newTermData.credencialDoc,
          duiDoc: newTermData.duiDoc,
          estado: 'vigente'
        },
        rep_legal: cleanNombre,
        apoderadosVigentes: [], // Empty because all powers were invalidated
        documentos: updatedDocs,
        updatedAt: FieldValue.serverTimestamp()
      });

      addAudit(tx, caller, 'LEGAL_REPRESENTATIVE_ELECTION_REGISTERED', newTermId, {
        accountId: cleanAccountId,
        termId: newTermId,
        nombre: cleanNombre,
        contactId: newTermData.contactId,
        fechaEleccion: cleanFechaEleccion,
        fechaVencimiento: cleanFechaVencimiento,
        invalidatedPowersCount: powersToInvalidate.length
      });

      return {
        success: true,
        termId: newTermId,
        invalidatedPowersCount: powersToInvalidate.length,
        estado: 'vigente',
        nombre: cleanNombre,
        credencialVersionId: credVersionId,
        duiVersionId: duiVersionId
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Otorgamiento de Poder para Firma de Contratos
  // ---------------------------------------------------------------------------
  async function grantContractPower({
    caller,
    accountId,
    contactId,
    documento,
    documentoDoc,
    notas = null,
    opId = null
  }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');
    const cleanContactId = reqString(contactId, 'contactId');

    const effectiveDoc = documento || documentoDoc;
    if (!effectiveDoc || typeof effectiveDoc !== 'object') {
      throw new ServiceError('invalid-argument', 'Debe adjuntar el documento que acredita el poder para firma de contratos');
    }

    return db.runTransaction(async tx => {
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      // 1. Must have an active legal representative term
      const activeTerm = client.representanteLegalVigente;
      if (!activeTerm || activeTerm.estado !== 'vigente' || !activeTerm.termId) {
        throw new ServiceError('failed-precondition', 'No es posible otorgar poderes sin un nombramiento vigente de Representante Legal en la cuenta');
      }

      // 2. Read contact from contacts_prod (B1 catalog)
      const contactRef = col('contacts').doc(cleanContactId);
      const contactSnap = await tx.get(contactRef);
      if (!contactSnap.exists) {
        throw new ServiceError('not-found', 'La persona seleccionada no existe en el catálogo de contactos');
      }
      const contactData = contactSnap.data();
      const nombreApoderado = contactData.nombreCompleto || `${contactData.nombres || ''} ${contactData.apellidos || ''}`.trim() || 'Apoderado';

      // 3. Verify no existing active power for this contact on this account
      const clientPowersCol = clientRef.collection('contract_powers');
      const existingPowersSnap = await tx.get(
        clientPowersCol.where('contactId', '==', cleanContactId).where('estado', '==', 'vigente')
      );
      if (!existingPowersSnap.empty) {
        throw new ServiceError('failed-precondition', `El contacto ${nombreApoderado} ya cuenta con un poder vigente para firma de contratos en esta cuenta`);
      }

      const nowIso = new Date().toISOString();
      const rand = crypto.randomBytes(4).toString('hex');
      const newPowerId = `power_${Date.now()}_${rand}`;
      const versionId = `v_power_${Date.now()}_${rand}`;

      // 4. Save version in document_versions subcollection
      const clientVersionsCol = clientRef.collection('document_versions');
      const versionRecord = {
        versionId,
        versionNumber: 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: POWER_DOC_KEY,
        name: effectiveDoc.name || 'Poder para Firma de Contratos',
        storagePath: effectiveDoc.storagePath || effectiveDoc.path || null,
        url: effectiveDoc.url || null,
        size: effectiveDoc.size || null,
        contentType: effectiveDoc.contentType || null,
        sha256: sanitizeSha256(effectiveDoc.sha256) || null,
        termId: activeTerm.termId,
        powerId: newPowerId,
        contactId: cleanContactId,
        estado: 'vigente',
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(versionId), versionRecord);

      // 5. Create power record bound to the active RL term
      const powerData = {
        id: newPowerId,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        nombreApoderado,
        termId: activeTerm.termId,
        documento: {
          name: versionRecord.name,
          storagePath: versionRecord.storagePath,
          url: versionRecord.url,
          versionId,
          versionNumber: 1,
          sha256: versionRecord.sha256
        },
        estado: 'vigente',
        registradoPor: caller.cid,
        registradoPorNombre: caller.name,
        registradoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientPowersCol.doc(newPowerId), powerData);

      // 6. Update client root projection
      const currentActivePowers = Array.isArray(client.apoderadosVigentes) ? [...client.apoderadosVigentes] : [];
      currentActivePowers.push({
        powerId: newPowerId,
        contactId: cleanContactId,
        nombreApoderado,
        termId: activeTerm.termId,
        versionId,
        storagePath: versionRecord.storagePath,
        url: versionRecord.url,
        estado: 'vigente'
      });

      tx.update(clientRef, {
        apoderadosVigentes: currentActivePowers,
        updatedAt: FieldValue.serverTimestamp()
      });

      addAudit(tx, caller, 'POWER_GRANTED', newPowerId, {
        accountId: cleanAccountId,
        powerId: newPowerId,
        contactId: cleanContactId,
        nombreApoderado,
        termId: activeTerm.termId
      });

      return {
        success: true,
        powerId: newPowerId,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        termId: activeTerm.termId,
        nombreApoderado,
        estado: 'vigente'
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Revocación Voluntaria / Anticipada de Poder
  // ---------------------------------------------------------------------------
  async function revokeContractPower({ caller, accountId, powerId, motivo }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');
    const cleanPowerId = reqString(powerId, 'powerId');
    const cleanMotivo = reqString(motivo, 'motivo de revocación', 500);

    return db.runTransaction(async tx => {
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const powerRef = clientRef.collection('contract_powers').doc(cleanPowerId);
      const powerSnap = await tx.get(powerRef);
      if (!powerSnap.exists) throw new ServiceError('not-found', 'Poder no encontrado');
      const powerData = powerSnap.data();

      if (powerData.estado !== 'vigente') {
        throw new ServiceError('failed-precondition', `El poder ya se encuentra en estado '${powerData.estado}'`);
      }

      const nowIso = new Date().toISOString();
      tx.update(powerRef, {
        estado: 'revocado',
        anuladoEn: nowIso,
        anuladoPor: caller.cid,
        motivoAnulacion: cleanMotivo,
        updatedAt: FieldValue.serverTimestamp()
      });

      // Update client root projection
      const currentActivePowers = Array.isArray(client.apoderadosVigentes)
        ? client.apoderadosVigentes.filter(p => p.powerId !== cleanPowerId)
        : [];

      tx.update(clientRef, {
        apoderadosVigentes: currentActivePowers,
        updatedAt: FieldValue.serverTimestamp()
      });

      addAudit(tx, caller, 'POWER_REVOKED', cleanPowerId, {
        accountId: cleanAccountId,
        powerId: cleanPowerId,
        contactId: powerData.contactId,
        nombreApoderado: powerData.nombreApoderado,
        motivo: cleanMotivo
      });

      return { success: true, powerId: cleanPowerId, estado: 'revocado' };
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Confirmación Bienal de Documentos Societarios
  //    Caso A: El documento sí tuvo actualizaciones (nueva versión cargada + renovación bienal)
  //    Caso B: El documento no tuvo actualizaciones (evento de confirmación expresa sin archivo)
  // ---------------------------------------------------------------------------
  async function recordBiennialConfirmation({
    caller,
    accountId,
    docKey,
    documentVersionId,
    confirmationType = 'no_changes',
    confirmedNoChanges = true,
    notas = null,
    opportunityId = null,
    opId = null
  }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId', 128);
    const cleanDocKey = reqString(docKey, 'docKey', 64);
    const cleanVersionId = reqString(documentVersionId, 'documentVersionId', 128);
    const cleanOpId = opId ? reqString(opId, 'opId', 128) : null;

    if (!DOC_ID_RE.test(cleanAccountId)) {
      throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
    }
    if (!DOC_ID_RE.test(cleanVersionId)) {
      throw new ServiceError('invalid-argument', 'Identificador de versión documental inválido');
    }
    if (cleanOpId && !DOC_ID_RE.test(cleanOpId)) {
      throw new ServiceError('invalid-argument', 'Identificador de operación (opId) inválido');
    }

    if (!DOCUMENTS_REQUIRING_BIENNIAL_REVIEW.includes(cleanDocKey)) {
      throw new ServiceError('invalid-argument', `El documento '${cleanDocKey}' no está sujeto a revisión bienal`);
    }

    const isNoChangesType = confirmationType === 'no_changes' || confirmationType === 'biennial_no_changes';
    if (isNoChangesType && confirmedNoChanges !== true) {
      throw new ServiceError('invalid-argument', 'Debe confirmar expresamente que consultó al cliente y que no existen modificaciones');
    }

    return db.runTransaction(async tx => {
      // --- FASE 1 DE TRANSACCIÓN: TODAS LAS LECTURAS ---
      const opRef = cleanOpId ? col('ops').doc(`biennial_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;

      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        if (
          prevOp.callerCid !== caller.cid ||
          prevOp.accountId !== cleanAccountId ||
          prevOp.docKey !== cleanDocKey ||
          prevOp.documentVersionId !== cleanVersionId
        ) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
      }

      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      // Verify that documentVersionId exists under this account's subcollection
      const clientVersionsCol = clientRef.collection('document_versions');
      const versionRef = clientVersionsCol.doc(cleanVersionId);
      const versionSnap = await tx.get(versionRef);
      if (!versionSnap.exists) {
        throw new ServiceError('not-found', 'La versión documental especificada no existe en el expediente de esta cuenta');
      }
      const versionData = versionSnap.data();

      // Also read all versions for this docKey in the transaction to detect any newer version
      const docKeyVersionsSnap = await tx.get(clientVersionsCol.where('docKey', '==', cleanDocKey));

      // --- FASE 2 DE TRANSACCIÓN: VALIDACIONES DE INTEGRIDAD Y VIGENCIA ---
      // 2.1 Verify account and docKey ownership on the version record itself
      if (versionData.entityId && versionData.entityId !== cleanAccountId) {
        throw new ServiceError('invalid-argument', 'La versión documental no pertenece a la cuenta indicada');
      }
      if (versionData.accountId && versionData.accountId !== cleanAccountId) {
        throw new ServiceError('invalid-argument', 'La versión documental no pertenece a la cuenta indicada');
      }
      if (versionData.docKey !== cleanDocKey) {
        throw new ServiceError(
          'invalid-argument',
          `La versión documental '${cleanVersionId}' corresponde al documento '${versionData.docKey || 'desconocido'}', no a '${cleanDocKey}'`
        );
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const todayStr = nowIso.slice(0, 10);

      // 2.2 Verify the document exists in the account's current active documents
      const currentActiveDoc = client.documentos && client.documentos[cleanDocKey] ? client.documentos[cleanDocKey] : null;
      if (!currentActiveDoc) {
        throw new ServiceError('failed-precondition', `El documento '${cleanDocKey}' no tiene una versión vigente activa en la cuenta`);
      }

      // 2.3 A biennial confirmation cannot renew a document that has an expired fechaVencimiento
      const effectiveExpiry = versionData.fechaVencimiento || currentActiveDoc.fechaVencimiento || null;
      if (effectiveExpiry && String(effectiveExpiry).slice(0, 10) < todayStr) {
        throw new ServiceError('failed-precondition', 'Una confirmación de revisión bienal no puede utilizarse para renovar un documento vencido');
      }

      // 2.4 Verify the version being confirmed is the current active version (not historical or superseded)
      if (versionData.estado && versionData.estado !== 'vigente') {
        throw new ServiceError('failed-precondition', 'La confirmación bienal solo puede registrarse sobre la versión documental vigente');
      }
      if (versionData.reemplazadaPorVersionId) {
        throw new ServiceError('failed-precondition', 'No es posible confirmar una versión histórica que ya fue sustituida por una versión posterior');
      }
      if (currentActiveDoc.versionId && currentActiveDoc.versionId !== cleanVersionId) {
        throw new ServiceError(
          'failed-precondition',
          `No es posible confirmar una versión desactualizada ('${cleanVersionId}') cuando la versión vigente actual es '${currentActiveDoc.versionId}'`
        );
      }

      const targetVersionNumber = Number(versionData.versionNumber) || Number(currentActiveDoc.versionNumber) || 1;
      if (docKeyVersionsSnap && typeof docKeyVersionsSnap.forEach === 'function') {
        let supersededByHigher = false;
        docKeyVersionsSnap.forEach(d => {
          const dData = d.data() || {};
          const dId = d.id || dData.versionId;
          if (dId !== cleanVersionId) {
            if ((Number(dData.versionNumber) || 0) > targetVersionNumber || dData.reemplazaVersionId === cleanVersionId) {
              supersededByHigher = true;
            }
          }
        });
        if (supersededByHigher) {
          throw new ServiceError('failed-precondition', 'No es posible confirmar una versión histórica o desactualizada cuando ya existe una versión posterior');
        }
      }

      // --- FASE 3 DE TRANSACCIÓN: TODAS LAS ESCRITURAS ATÓMICAS ---
      // Next review at: 2 calendar years (730 days) from confirmation
      const nextReviewDate = new Date(now.getTime() + 730 * 24 * 60 * 60 * 1000);
      const nextReviewIso = nextReviewDate.toISOString().slice(0, 10);

      const rand = crypto.randomBytes(4).toString('hex');
      const confId = cleanOpId ? `conf_${cleanOpId}` : `conf_${Date.now()}_${rand}`;
      const cleanNotas = notas ? String(notas).trim().slice(0, 500) : null;

      // Identity is taken strictly from server-resolved `caller`
      const confirmationRecord = {
        id: confId,
        eventType: 'biennial_confirmation',
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        documentVersionId: cleanVersionId,
        versionNumber: targetVersionNumber,
        confirmationType,
        confirmedNoChanges: !!confirmedNoChanges,
        notas: cleanNotas,
        confirmedBy: caller.cid,
        confirmedByUid: caller.uid,
        confirmedByName: caller.name || 'Comercial',
        confirmedByRole: caller.role,
        confirmedAt: nowIso,
        nextReviewAt: nextReviewIso,
        opportunityId: opportunityId ? String(opportunityId).trim() : null,
        opId: cleanOpId,
        createdAt: FieldValue.serverTimestamp()
      };

      tx.set(clientRef.collection('biennial_confirmations').doc(confId), confirmationRecord);

      // Project onto client root atomically
      const biennialReviews = { ...(client.biennialReviews || {}) };
      biennialReviews[cleanDocKey] = {
        confirmationId: confId,
        lastConfirmedAt: nowIso,
        nextReviewAt: nextReviewIso,
        confirmedBy: caller.cid,
        confirmedByName: caller.name || 'Comercial',
        documentVersionId: cleanVersionId,
        versionNumber: targetVersionNumber,
        confirmationType
      };

      tx.update(clientRef, {
        biennialReviews,
        updatedAt: FieldValue.serverTimestamp()
      });

      addAudit(tx, caller, 'ACCOUNT_DOCUMENT_REVIEW_CONFIRMED', confId, {
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        documentVersionId: cleanVersionId,
        versionNumber: targetVersionNumber,
        confirmationType,
        nextReviewAt: nextReviewIso,
        opportunityId: confirmationRecord.opportunityId,
        opId: cleanOpId
      });

      const resultPayload = {
        success: true,
        confirmationId: confId,
        docKey: cleanDocKey,
        documentVersionId: cleanVersionId,
        versionNumber: targetVersionNumber,
        confirmedBy: caller.cid,
        confirmedByName: caller.name || 'Comercial',
        confirmedAt: nowIso,
        nextReviewAt: nextReviewIso
      };

      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          accountId: cleanAccountId,
          docKey: cleanDocKey,
          documentVersionId: cleanVersionId,
          callerCid: caller.cid,
          callerUid: caller.uid,
          result: resultPayload,
          createdAt: FieldValue.serverTimestamp()
        });
      }

      return resultPayload;
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Sustitución Segura de Documentos con Control de Vencimiento y Hash SHA-256
  // ---------------------------------------------------------------------------
  async function saveAccountDocument({
    caller,
    accountId,
    docKey,
    doc,
    motivoSustitucion = null,
    fechaEmision = null,
    fechaVencimiento = null,
    opId = null
  }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');
    const cleanDocKey = reqString(docKey, 'docKey');

    if (!doc || typeof doc !== 'object') {
      throw new ServiceError('invalid-argument', 'Documento inválido');
    }

    const cleanFechaVencimiento = sanitizeDate(fechaVencimiento || doc.fechaVencimiento, 'fechaVencimiento');
    const cleanFechaEmision = sanitizeDate(fechaEmision || doc.fechaEmision, 'fechaEmision');
    const incomingSha = sanitizeSha256(doc.sha256);

    return db.runTransaction(async tx => {
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const clientVersionsCol = clientRef.collection('document_versions');
      const existingDoc = (client.documentos && client.documentos[cleanDocKey]) ? client.documentos[cleanDocKey] : null;

      // Rule 6.1: When substituting an expired document, prevent uploading identical file (SHA-256 check)
      if (existingDoc) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const prevExpired = existingDoc.fechaVencimiento && existingDoc.fechaVencimiento < todayStr;

        if (prevExpired) {
          if (incomingSha && existingDoc.sha256 && incomingSha === existingDoc.sha256) {
            throw new ServiceError('failed-precondition', 'No se puede renovar un documento cargando el mismo archivo vencido (huella digital SHA-256 idéntica). Se requiere evidencia de renovación efectiva.');
          }
          if (cleanFechaVencimiento && cleanFechaVencimiento <= existingDoc.fechaVencimiento) {
            throw new ServiceError('failed-precondition', `La fecha de vencimiento renovada (${cleanFechaVencimiento}) debe ser posterior a la fecha anterior (${existingDoc.fechaVencimiento}).`);
          }
        }
      }

      const nowIso = new Date().toISOString();
      const rand = crypto.randomBytes(4).toString('hex');
      const versionId = `v_${cleanDocKey}_${Date.now()}_${rand}`;
      const prevVersionNumber = (existingDoc && existingDoc.versionNumber) ? existingDoc.versionNumber : 0;
      const newVersionNumber = prevVersionNumber + 1;

      // Mark previous version as 'historica' if exists
      if (existingDoc && existingDoc.versionId) {
        const prevVersionRef = clientVersionsCol.doc(existingDoc.versionId);
        const prevVersionSnap = await tx.get(prevVersionRef);
        if (prevVersionSnap.exists) {
          tx.update(prevVersionRef, {
            estado: 'historica',
            reemplazadaPorVersionId: versionId,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      }

      const versionRecord = {
        versionId,
        versionNumber: newVersionNumber,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: cleanDocKey,
        name: doc.name || 'Documento',
        storagePath: doc.storagePath || doc.path || null,
        url: doc.url || null,
        size: doc.size || null,
        contentType: doc.contentType || null,
        sha256: incomingSha,
        fechaEmision: cleanFechaEmision,
        fechaVencimiento: cleanFechaVencimiento,
        estado: 'vigente',
        reemplazaVersionId: (existingDoc && existingDoc.versionId) ? existingDoc.versionId : null,
        motivoSustitucion: motivoSustitucion ? String(motivoSustitucion).trim().slice(0, 500) : null,
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(versionId), versionRecord);

      // Update client root pointers
      const updatedDocs = { ...(client.documentos || {}) };
      updatedDocs[cleanDocKey] = {
        name: versionRecord.name,
        storagePath: versionRecord.storagePath,
        url: versionRecord.url,
        versionId,
        versionNumber: newVersionNumber,
        sha256: incomingSha,
        fechaEmision: cleanFechaEmision,
        fechaVencimiento: cleanFechaVencimiento,
        actualizadoEn: nowIso
      };

      const updatePayload = {
        documentos: updatedDocs,
        updatedAt: FieldValue.serverTimestamp()
      };

      // If document is subject to biennial review, uploading a new modification resets biennial review timer
      if (DOCUMENTS_REQUIRING_BIENNIAL_REVIEW.includes(cleanDocKey)) {
        const nextReviewDate = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000);
        const nextReviewIso = nextReviewDate.toISOString().slice(0, 10);
        const updatedBiennialReviews = { ...(client.biennialReviews || {}) };
        updatedBiennialReviews[cleanDocKey] = {
          lastConfirmedAt: nowIso,
          nextReviewAt: nextReviewIso,
          confirmedBy: caller.cid,
          confirmedByName: caller.name || 'Comercial',
          documentVersionId: versionId,
          versionNumber: newVersionNumber,
          tipo: 'nueva_modificacion'
        };
        updatePayload.biennialReviews = updatedBiennialReviews;
      }

      tx.update(clientRef, updatePayload);

      addAudit(tx, caller, existingDoc ? 'ACCOUNT_DOCUMENT_SUBSTITUTE' : 'ACCOUNT_DOCUMENT_UPLOAD', versionId, {
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        versionId,
        versionNumber: newVersionNumber,
        previousVersionId: (existingDoc && existingDoc.versionId) ? existingDoc.versionId : null,
        motivoSustitucion
      });

      return {
        success: true,
        versionId,
        versionNumber: newVersionNumber,
        docKey: cleanDocKey
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Validación Centralizada para Cierre de Oportunidades
  // ---------------------------------------------------------------------------
  async function validateAccountDocumentsForOpportunityClose({
    caller,
    accountId,
    prospectId,
    requiereContrato = false,
    firmante = null,
    now = new Date()
  }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');
    const cleanProspectId = reqString(prospectId, 'prospectId');

    const clientRef = col('clients').doc(cleanAccountId);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
    const client = clientSnap.data();

    if (!canAccessAccount(caller, client)) {
      throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
    }

    const todayStr = now.toISOString().slice(0, 10);
    const blockingReasons = [];
    const documentsMissing = [];
    const documentsExpired = [];
    const documentsRequiringReview = [];

    const isJuridica = client.tipo === 'juridica';
    const docs = (client.documentos && typeof client.documentos === 'object') ? client.documentos : {};

    // 1. Mandatory documents present check
    const requiredKeys = isJuridica
      ? ['dui', 'escritura', 'credencial', 'nit', 'nrc']
      : ['dui', 'nit'];

    for (const key of requiredKeys) {
      const doc = docs[key];
      const hasValidDoc = doc && (doc.storagePath || doc.url || typeof doc === 'string');
      if (!hasValidDoc) {
        documentsMissing.push(key);
        blockingReasons.push(`Falta el documento obligatorio '${key}' en el expediente de la cuenta.`);
      }
    }

    // 2. Expiration checks (DUI and Credencial)
    for (const key of DOCUMENTS_WITH_EXPIRATION) {
      const doc = docs[key];
      if (doc && typeof doc === 'object' && doc.fechaVencimiento) {
        if (doc.fechaVencimiento < todayStr) {
          documentsExpired.push({
            docKey: key,
            fechaVencimiento: doc.fechaVencimiento,
            versionId: doc.versionId || null
          });
          blockingReasons.push(`El documento '${key}' venció el ${doc.fechaVencimiento}. Debe renovarse en el expediente.`);
        }
      }
    }

    // 3. Biennial reviews check (for escritura and mods_escritura)
    if (isJuridica) {
      const biennialReviews = client.biennialReviews || {};
      for (const key of DOCUMENTS_REQUIRING_BIENNIAL_REVIEW) {
        const doc = docs[key];
        // If document is present, verify biennial review status
        if (doc) {
          const rev = biennialReviews[key];
          let isReviewPending = false;
          let reviewDateStr = null;

          if (rev && rev.lastConfirmedAt) {
            const daysSince = computeDaysDifference(rev.lastConfirmedAt.slice(0, 10), todayStr);
            if (daysSince > 730) {
              isReviewPending = true;
              reviewDateStr = rev.lastConfirmedAt;
            }
          } else {
            // Check doc upload date
            const uploadDate = doc.actualizadoEn || client.fecha_creacion || null;
            if (uploadDate) {
              const daysSince = computeDaysDifference(uploadDate.slice(0, 10), todayStr);
              if (daysSince > 730) {
                isReviewPending = true;
                reviewDateStr = uploadDate;
              }
            }
          }

          if (isReviewPending) {
            documentsRequiringReview.push({
              docKey: key,
              lastValidationDate: reviewDateStr,
              motivo: 'Han transcurrido más de dos años desde la última validación o confirmación bienal.'
            });
            blockingReasons.push(`El documento '${key}' requiere revisión bienal (han transcurrido más de dos años). Registre una modificación o confirme la ausencia de cambios.`);
          }
        }
      }
    }

    // 4. Contractual Signatory validation (only if requires contract)
    let signerValidation = null;
    if (requiereContrato) {
      if (!firmante || typeof firmante !== 'object' || !firmante.tipo) {
        blockingReasons.push('La oportunidad requiere contrato: debe seleccionar quién firmará (Representante Legal o Apoderado acreditado).');
        signerValidation = { valid: false, error: 'Signatory not selected' };
      } else if (firmante.tipo === 'representante_legal') {
        const rl = client.representanteLegalVigente;
        if (!rl || rl.estado !== 'vigente' || !rl.termId) {
          blockingReasons.push('El firmante seleccionado es Representante Legal, pero la cuenta no tiene un nombramiento vigente registrado.');
          signerValidation = { valid: false, error: 'No active legal representative term' };
        } else {
          // Check RL DUI & Credencial
          const rlDuiExpired = rl.fechaVencimiento && rl.fechaVencimiento < todayStr;
          if (rlDuiExpired) {
            blockingReasons.push(`El nombramiento del Representante Legal (${rl.nombre}) venció el ${rl.fechaVencimiento}.`);
            signerValidation = { valid: false, error: 'Legal representative term expired' };
          } else {
            signerValidation = {
              valid: true,
              tipo: 'representante_legal',
              termId: rl.termId,
              contactId: rl.contactId || null,
              nombre: rl.nombre,
              credencialVersionId: rl.credencialVersionId || null
            };
          }
        }
      } else if (firmante.tipo === 'apoderado') {
        const powerId = firmante.powerId || firmante.id;
        if (!powerId) {
          blockingReasons.push('Debe especificar el poder que acredita al apoderado seleccionado.');
          signerValidation = { valid: false, error: 'Power ID not specified' };
        } else {
          const powerSnap = await clientRef.collection('contract_powers').doc(String(powerId)).get();
          if (!powerSnap.exists) {
            blockingReasons.push('El poder notarial seleccionado no existe en el expediente de la cuenta.');
            signerValidation = { valid: false, error: 'Power not found' };
          } else {
            const powerData = powerSnap.data();
            const activeRL = client.representanteLegalVigente;

            if (powerData.estado !== 'vigente') {
              blockingReasons.push(`El poder del apoderado '${powerData.nombreApoderado}' no está vigente (estado: ${powerData.estado}).`);
              signerValidation = { valid: false, error: `Power status is ${powerData.estado}` };
            } else if (!activeRL || powerData.termId !== activeRL.termId) {
              blockingReasons.push(`El poder del apoderado '${powerData.nombreApoderado}' fue otorgado bajo un nombramiento de Representante Legal anterior y ha quedado anulado por una nueva elección.`);
              signerValidation = { valid: false, error: 'Power superseded by new election' };
            } else {
              signerValidation = {
                valid: true,
                tipo: 'apoderado',
                powerId,
                contactId: powerData.contactId,
                nombre: powerData.nombreApoderado,
                termId: powerData.termId,
                documentoVersionId: powerData.documento ? powerData.documento.versionId : null
              };
            }
          }
        }
      } else {
        blockingReasons.push(`Tipo de firmante '${firmante.tipo}' no reconocido. Debe ser 'representante_legal' o 'apoderado'.`);
        signerValidation = { valid: false, error: 'Invalid signer type' };
      }
    }

    const isValid = blockingReasons.length === 0;
    const validationId = `val_${cleanProspectId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    try {
      const auditRef = col('audit').doc();
      const auditEntry = {
        actor: {
          cid: caller.cid,
          uid: caller.uid,
          name: caller.name || 'Comercial',
          role: caller.role
        },
        action: 'ACCOUNT_DOCUMENT_CLOSE_VALIDATION',
        entity: 'account_document',
        entityId: cleanAccountId,
        metadata: {
          opportunityId: cleanProspectId,
          validationId,
          valid: isValid,
          blockingReasons,
          documentsMissing,
          documentsExpired,
          documentsRequiringReview,
          requiereContrato: !!requiereContrato,
          signerValidation: signerValidation ? {
            valid: signerValidation.valid,
            tipo: signerValidation.tipo || null,
            termId: signerValidation.termId || null,
            powerId: signerValidation.powerId || null
          } : null,
          versionsChecked: Object.entries(docs).reduce((acc, [k, v]) => {
            if (v && typeof v === 'object' && v.versionId) acc[k] = v.versionId;
            return acc;
          }, {})
        },
        result: isValid ? 'success' : 'blocked',
        environment: suffix === '_prod' ? 'production' : 'local',
        timestamp: FieldValue.serverTimestamp(),
        createdAt: now.toISOString()
      };
      await auditRef.set(auditEntry);
    } catch (auditErr) {
      console.warn('Failed to record close validation audit:', auditErr && auditErr.message);
    }

    return {
      valid: isValid,
      validationId,
      blockingReasons,
      documentsMissing,
      documentsExpired,
      documentsRequiringReview,
      signerValidation,
      requiereContrato: !!requiereContrato,
      checkedAt: now.toISOString()
    };
  }

  // ---------------------------------------------------------------------------
  // 7. Consulta Estructurada del Expediente B3
  // ---------------------------------------------------------------------------
  async function getAccountDossier({ caller, accountId }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId');

    const clientRef = col('clients').doc(cleanAccountId);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
    const client = clientSnap.data();

    if (!canAccessAccount(caller, client)) {
      throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
    }

    // Read subcollections
    const [termsSnap, powersSnap, confirmationsSnap, versionsSnap] = await Promise.all([
      clientRef.collection('legal_representative_terms').orderBy('createdAt', 'desc').limit(20).get(),
      clientRef.collection('contract_powers').orderBy('createdAt', 'desc').limit(50).get(),
      clientRef.collection('biennial_confirmations').orderBy('createdAt', 'desc').limit(20).get(),
      clientRef.collection('document_versions').orderBy('createdAt', 'desc').limit(100).get()
    ]);

    const terms = termsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const powers = powersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const confirmations = confirmationsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const versions = versionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const activeRL = terms.find(t => t.estado === 'vigente') || client.representanteLegalVigente || null;
    const activePowers = powers.filter(p => p.estado === 'vigente');
    const historicalPowers = powers.filter(p => p.estado !== 'vigente');

    return {
      accountId: cleanAccountId,
      tipoPersona: client.tipo || 'juridica',
      empresa: client.empresa || null,
      nombres: client.nombres || null,
      apellidos: client.apellidos || null,
      documentosVigentes: client.documentos || {},
      activeRL,
      rlTermsHistory: terms,
      activePowers,
      historicalPowers,
      biennialConfirmations: confirmations,
      biennialReviews: client.biennialReviews || {},
      documentVersions: versions
    };
  }

  return {
    names,
    CANONICAL_DOC_KEYS,
    POWER_DOC_KEY,
    ALL_DOC_KEYS,
    DOC_FAMILIES,
    DOCUMENTS_REQUIRING_BIENNIAL_REVIEW,
    DOCUMENTS_WITH_EXPIRATION,
    registerLegalRepresentativeTerm,
    grantContractPower,
    revokeContractPower,
    recordBiennialConfirmation,
    saveAccountDocument,
    validateAccountDocumentsForOpportunityClose,
    getAccountDossier,
    resolveCaller
  };
}

module.exports = {
  createAccountDocumentsService,
  ServiceError,
  CANONICAL_DOC_KEYS,
  POWER_DOC_KEY,
  ALL_DOC_KEYS,
  DOC_FAMILIES,
  DOCUMENTS_REQUIRING_BIENNIAL_REVIEW,
  DOCUMENTS_WITH_EXPIRATION
};
