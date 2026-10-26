// functions/commercialService.js
// Server-side commercial operations of the CRM that used to be plain browser writes: opportunities (prospects),
// the activity log of an opportunity, the "sale authorised without contract" decision, vendor reassignment, the
// shared settings document and the deletion of clients. Same design as clientsService.js: no firebase-functions
// dependency (errors are ServiceError(code, message), index.js maps them to HttpsError) and everything injected
// (`db`, `FieldValue`, `resolveCaller`, `verifyManager`, clock), so the SAME code runs in unit tests (in-memory
// Firestore), in the isolated emulator and when deployed.
//
// Rules every operation follows (see COMMERCIAL_OPERATIONS.md):
//   1. Identity comes from the authenticated session: `caller` is built by resolveCaller() from the Auth uid + the
//      CRM profile (active, linked, CRM role). Nothing about WHO acts is read from the request.
//   2. The operation is authorised explicitly against caller.role (and, for manager-only operations, against a LIVE
//      lookup of the Auth account: a stale token cannot keep a revoked manager claim alive).
//   3. Payloads are allow-listed and validated; protected fields (ids, createdBy*, roles, flags) are never taken from
//      the browser. Author names written into logs / authorisations come from the profile.
//   4. Read-modify-write happens inside a transaction; creations carry an opId (idempotency) and state changes are
//      idempotent by construction (re-sending the same request changes nothing and writes no second audit entry).
//   5. Sensitive operations leave an audit entry written in the SAME transaction as the change, with the server
//      identity (uid + commercial id + name), so it cannot be forged and cannot exist without the change.
//
// Historical identifiers are preserved: the user ids (users*/{id}) and client ids stay the document keys; opportunity ids keep the
// CRM format (Date.now() as text); `createdBy` / `vendedorId` always hold the commercial id (`cid`), never the Auth uid.

const crypto = require('crypto');
const identity = require('./clientIdentity');
const { ServiceError, CRM_ROLES, PRIVILEGED, stableHash } = require('./clientsService');
const { bindNoContractApproval } = require('./documentVersioningService');

let CrmFollowUpCalc = null;
try {
  CrmFollowUpCalc = require('./crm_followup_calc');
} catch (e) {
  try {
    CrmFollowUpCalc = require('../crm_followup_calc');
  } catch (e2) {}
}

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const SETTINGS_LISTS = ['visitantes', 'encargados'];
const SETTINGS_ACTIONS = ['addItem', 'removeItem', 'setFactoryAddress'];
const CRM_TZ_OFFSET_MS = -6 * 3600 * 1000; // El Salvador (no DST): the year of the opportunity code follows local time
const MAX_LOGS = 2000;
const MOTIVOS_PERDIDA = ['Precio', 'Falta de seguimiento', 'No se cumplían los requerimientos técnicos', 'Tiempo de entrega', 'Cliente desiste'];

function namesFor(suffix) {
  return {
    prospects: `prospects${suffix}`,
    clients: `clients${suffix}`,
    users: `users${suffix}`,
    identifiers: `clientIdentifiers${suffix}`,
    system: `system${suffix}`,
    auditLogs: `audit_logs${suffix}`,       // the manager's audit panel (deletions)
    audit: `commercialAudit${suffix}`,       // server-only trail of the other sensitive operations
    ops: `prospectOps${suffix}`,
    counters: `prospectCounters${suffix}`
  };
}

// ---------- validation helpers ----------
const bad = (message) => new ServiceError('invalid-argument', message);
function asObject(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} inválido`);
  return v;
}
function reqString(v, label, max) {
  if (typeof v !== 'string') throw bad(`${label} es obligatorio`);
  const s = v.trim();
  if (!s) throw bad(`${label} es obligatorio`);
  if (s.length > max) throw bad(`${label} excede ${max} caracteres`);
  return s;
}
function reqDocId(v, label) {
  if (typeof v !== 'string' || !DOC_ID_RE.test(v)) throw bad(`${label} inválido`);
  return v;
}
function reqOpId(v) {
  if (typeof v !== 'string' || !OP_ID_RE.test(v)) throw bad('opId requerido');
  return v;
}

// ---------- canonical postclosing helper ----------
function hasEnteredPostclosing(p) {
  if (!p || typeof p !== 'object') return false;

  // 1. Explicitly disabled postclosing
  if (p.postcierre_habilitado === false) return false;

  // 2. Active / open opportunities are in-process, never in postclosing
  // (unless explicitly finalized with postcierre_habilitado === true)
  if (p.estado === 'activo' && p.postcierre_habilitado !== true) return false;

  // 3. Modern finalized opportunity (formal closure via finalizeProspect)
  // Or closed project preserved in postclosing (even if subsequently marked 'perdido', per SEC-04/06)
  if (p.postcierre_habilitado === true) return true;

  // 4. Lost opportunities without postcierre_habilitado === true cannot enter postclosing
  // (residual invoices or historical tags on lost leads are not authorized)
  if (p.estado === 'perdido') return false;

  // 5. Historical records (created before postcierre_habilitado was introduced)
  // Must possess verifiable, consistent historical closing evidence.

  // 5a. Accounting / Fiscal evidence: at least one well-formed, valid invoice
  const hasFacturas = Array.isArray(p.facturas) && p.facturas.some(f => {
    if (!f || typeof f !== 'object') return false;
    const hasNumero = typeof f.numero === 'string' && f.numero.trim().length > 0;
    const numMonto = typeof f.monto === 'number' ? f.monto : parseFloat(f.monto);
    const hasMonto = typeof numMonto === 'number' && !isNaN(numMonto) && numMonto > 0;
    return hasNumero && hasMonto;
  });
  if (hasFacturas) return true;

  // 5b. Contractual / Documental evidence:
  // Must have a valid closure date or cierre stage timestamp
  const hasCloseDate = (typeof p.fecha_cierre === 'string' && p.fecha_cierre.trim().length > 0)
    || (typeof p.fecha_postcierre === 'string' && p.fecha_postcierre.trim().length > 0)
    || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre);

  if (!hasCloseDate) return false;

  const datos = (p.datos && typeof p.datos === 'object') ? p.datos : null;
  const hasDoc = d => (Array.isArray(d) ? d.length > 0 : !!d);

  // Contractual proof: contrato_archivo, doc_firmado, doc_contrato, or authorized bypass
  const hasContractOrSignedDoc = !!p.contrato_archivo
    || hasDoc(p.doc_firmado)
    || (!!datos && (hasDoc(datos.doc_contrato) || hasDoc(datos.doc_firmado)))
    || p.autorizado_sin_contrato === true
    || (!!datos && datos.autorizado_sin_contrato === true);

  // Advance receipt proof: doc_comprobante
  const hasAdvanceReceipt = hasDoc(p.doc_comprobante)
    || (!!datos && hasDoc(datos.doc_comprobante));

  // Closing evidence requires physical contract in storage (contrato_archivo)
  // OR both contractual proof AND advance receipt proof.
  // (forma_pago or factura_anticipo alone are NEVER sufficient)
  const hasClosingEvidence = !!p.contrato_archivo
    || (hasContractOrSignedDoc && hasAdvanceReceipt);

  if (hasClosingEvidence) {
    return true;
  }

  // 6. Inconsistent, ambiguous, or unverified records default to false (require manual review)
  return false;
}

function createCommercialService({ db, FieldValue, suffix, verifyManager, now = () => new Date(), newProspectId = () => String(Date.now()) }) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  if (typeof verifyManager !== 'function') throw new Error('verifyManager is required');
  const names = namesFor(suffix);
  const col = n => db.collection(names[n]);
  const iso = () => now().toISOString();

  // ---------- authorization ----------

  const canAccessProspect = (caller, p) => {
    if (!caller || !p) return false;
    if (caller.role === 'manager') return true;
    if (caller.role === 'gestor') {
      return p.vendedorId === caller.cid || p.createdBy === caller.cid || hasEnteredPostclosing(p);
    }
    if (caller.role === 'vendedor') {
      return p.vendedorId === caller.cid || (p.createdBy === caller.cid && (!p.vendedorId || p.vendedorId === caller.cid));
    }
    return false;
  };
  // A logically deleted opportunity (`eliminado: true`) is gone for every ordinary operation: it cannot be read through
  // the callables nor modified. Checked before access so that nobody learns anything about it.
  const requireNotDeleted = p => {
    if (p && p.eliminado === true) throw new ServiceError('not-found', 'La oportunidad fue eliminada');
  };
  function requireProspectAccess(caller, p) {
    requireNotDeleted(p);
    if (!canAccessProspect(caller, p)) throw new ServiceError('permission-denied', 'No tienes acceso a esta oportunidad');
  }
  function requirePrivileged(caller, what) {
    if (!PRIVILEGED.includes(caller.role)) throw new ServiceError('permission-denied', `Solo un gerente o gestor puede ${what}`);
  }
  // Manager-only: profile role AND a live check of the Auth account (claim present, account enabled). A token minted
  // before the claim was removed or the account was disabled is refused here, not at its expiry.
  async function requireManager(caller, what) {
    if (caller.role !== 'manager') throw new ServiceError('permission-denied', `Solo un gerente puede ${what}`);
    if (!(await verifyManager(caller.uid))) throw new ServiceError('permission-denied', `Solo un gerente puede ${what}`);
  }

  // ---------- shared pieces ----------
  // Log entry in the historical shape { text, date, auto } (+ server-side authorship fields that legacy readers ignore).
  function logEntry(caller, text, { auto, opId } = {}) {
    const prefix = auto ? '' : `(${caller.name || 'Sistema'}) `;
    const entry = { text: `${prefix} ${text}`, date: iso(), auto: !!auto };
    if (!auto) { entry.by = caller.cid; entry.byName = caller.name || ''; }
    if (opId) entry.opId = opId;
    return entry;
  }
  const logsOf = p => (Array.isArray(p.logs) ? p.logs : []);

  function auditEntry(caller, action, targetType, targetId, detail) {
    return {
      action, targetType, targetId, detail: detail || {},
      actorUid: caller.uid, actorCid: caller.cid, actorName: caller.name || '', actorRole: caller.role,
      at: FieldValue.serverTimestamp(), atIso: iso()
    };
  }
  // Auto ids: an audit entry is never keyed by anything the browser sent.
  const auditRef = () => col('audit').doc();

  // Assignee of an opportunity / target of a reassignment. Historical users (no Auth account) are valid assignees: they
  // are people the CRM already shows in its lists; only an inactive profile or a non-commercial role is refused.
  async function readAssignee(tx, cid) {
    const snap = await tx.get(col('users').doc(cid));
    if (!snap.exists) throw bad('El vendedor indicado no existe');
    const p = snap.data() || {};
    if (p.activo === false) throw bad('El vendedor indicado está inactivo');
    if (!CRM_ROLES.includes(p.role)) throw bad('El usuario indicado no es un usuario comercial');
    return { cid: snap.id, nombre: typeof p.nombre === 'string' ? p.nombre : '', role: p.role };
  }

  // ---------- opportunities ----------
  const localYear = () => new Date(now().getTime() + CRM_TZ_OFFSET_MS);

  // Existing sequence of the year, used ONLY to seed the counter the first time. max(count, highest suffix) so a
  // deleted opportunity never makes the next code collide with an existing one (the old browser generator did).
  async function seedFor(year) {
    const snap = await col('prospects').where('fecha_creacion', '>=', `${year}`).where('fecha_creacion', '<', `${year + 1}`).select('codigo').get();
    let max = 0;
    snap.docs.forEach(d => {
      const code = String((d.data() || {}).codigo || '');
      if (code.startsWith(String(year)) && /^\d{9,}$/.test(code)) max = Math.max(max, parseInt(code.slice(6), 10));
    });
    return Math.max(snap.size, max);
  }

  async function createProspect({ caller, data, opId }) {
    data = asObject(data, 'Datos de la oportunidad');
    reqOpId(opId);
    let clasificacion = 'ejecucion';
    if (data.clasificacion !== undefined && data.clasificacion !== null && data.clasificacion !== '') {
      const c = String(data.clasificacion).trim().toLowerCase();
      if (c !== 'ejecucion' && c !== 'presupuesto') {
        throw bad('Clasificación inválida: debe ser "ejecucion" o "presupuesto"');
      }
      clasificacion = c;
    }
    const fields = {
      proyecto: reqString(data.proyecto, 'El nombre del proyecto', 200),
      origen: reqString(data.origen, 'El origen', 100),
      tipo_proyecto: reqString(data.tipo_proyecto, 'El tipo de proyecto', 100),
      tipo_producto: reqString(data.tipo_producto, 'El tipo de producto', 100),
      clasificacion
    };
    const clientId = reqDocId(data.clientId, 'clientId');
    const askedVendor = (data.vendedorId === undefined || data.vendedorId === null || data.vendedorId === '') ? caller.cid : reqDocId(data.vendedorId, 'vendedorId');
    if (askedVendor !== caller.cid) requirePrivileged(caller, 'asignar una oportunidad a otro vendedor');

    // `createdBy*`, `id`, `codigo`, dates, stage and state are NEVER read from `data`.
    const payloadHash = stableHash({ ...fields, clientId, vendedorId: askedVendor });
    const opRef = col('ops').doc(opId);

    const outcome = await db.runTransaction(async tx => {
      const prev = await tx.get(opRef);
      if (prev.exists) return { replay: prev.data() };

      const clientSnap = await tx.get(col('clients').doc(clientId));
      if (!clientSnap.exists) throw new ServiceError('not-found', 'El cliente seleccionado no existe');
      const assignee = askedVendor === caller.cid ? { cid: caller.cid, nombre: caller.name, role: caller.role } : await readAssignee(tx, askedVendor);

      const year = localYear().getUTCFullYear();
      const counterRef = col('counters').doc(String(year));
      const counterSnap = await tx.get(counterRef);
      const last = counterSnap.exists && Number.isInteger((counterSnap.data() || {}).last) ? counterSnap.data().last : await seedFor(year);
      const seq = last + 1;
      const month = String(localYear().getUTCMonth() + 1).padStart(2, '0');
      const codigo = `${year}${month}${String(seq).padStart(3, '0')}`;

      let id = newProspectId();
      for (let i = 0; i < 20; i++) {
        const taken = await tx.get(col('prospects').doc(id));
        if (!taken.exists) break;
        id = String(Number(id) + 1);
      }

      const at = iso();
      const prospect = {
        id, codigo, clientId,
        createdBy: caller.cid, createdByName: caller.name || '', createdByRole: caller.role,
        vendedorId: assignee.cid, vendedorName: assignee.nombre, vendedorRole: assignee.role,
        ...fields,
        fecha_creacion: at, etapa: 'prospecto', estado: 'activo',
        stage_timestamps: { prospecto: at },
        logs: [logEntry(caller, `Prospecto creado por ${caller.name || 'Sistema'}. Vendedor asignado: ${assignee.nombre}. Origen: ${fields.origen}`, { auto: true })],
        datos: {}, facturas: []
      };
      tx.create(col('prospects').doc(id), prospect);
      tx.set(counterRef, { last: seq, updatedAt: FieldValue.serverTimestamp() });
      tx.create(opRef, { kind: 'createProspect', status: 'succeeded', prospectId: id, codigo, payloadHash, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      const visibleVendors = [caller.cid, assignee.cid].filter(v => v && v !== 'sistema');
      if (visibleVendors.length > 0) {
        tx.update(col('clients').doc(clientId), { visibleTo: FieldValue.arrayUnion(...visibleVendors) });
      }
      return { created: prospect };
    });

    if (outcome.replay) {
      const op = outcome.replay;
      if (op.createdBy !== caller.cid) throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
      if (op.payloadHash !== payloadHash) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
      return { status: 'created', replay: true, prospect: { id: op.prospectId, codigo: op.codigo } };
    }
    return { status: 'created', prospect: outcome.created };
  }

  // ---------- activity log ----------
  async function addLog({ caller, prospectId, text, opId }) {
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    const clean = reqString(text, 'La nota', 2000);
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);
      const logs = logsOf(p);
      const prior = logs.find(l => l && l.opId === opId);
      if (prior) {
        // Same opId, same author, same text: the request was already applied (retry). Anything else is a misuse of the key.
        if (prior.by !== caller.cid || !prior.text.endsWith(` ${clean}`)) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        return { status: 'added', replay: true };
      }
      if (logs.length >= MAX_LOGS) throw new ServiceError('failed-precondition', 'La oportunidad alcanzó el máximo de notas');
      const entry = logEntry(caller, clean, { auto: false, opId });
      tx.update(ref, { logs: logs.concat([entry]) });
      return { status: 'added', entry };
    });
  }

  // Only MANUAL notes can be removed (automatic ones are the history of what happened). A vendedor removes only the notes
  // they wrote; manager / gestor can remove any manual note. The entry is identified by its content, not by an array index
  // (an index is stale as soon as someone else adds or removes a note).
  async function deleteLog({ caller, prospectId, date, text }) {
    reqDocId(prospectId, 'prospectId');
    const entryDate = reqString(date, 'La fecha de la nota', 64);
    const entryText = reqString(text, 'El texto de la nota', 3000);
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);
      const logs = logsOf(p);
      const at = logs.findIndex(l => l && l.date === entryDate && String(l.text).trim() === entryText);
      if (at === -1) return { status: 'absent' }; // already removed (retry) or never existed: nothing to do
      const entry = logs[at];
      if (entry.gestionId || entry.tipo === 'gestion_comercial' || entry.tipo === 'gestion_anulada' || (typeof entry.text === 'string' && (entry.text.includes('[GESTIÓN COMERCIAL]') || entry.text.includes('[GESTIÓN ANULADA]')))) {
        throw new ServiceError('failed-precondition', 'Las notas vinculadas a gestiones comerciales estructuradas no se pueden eliminar desde la bitácora. Requieren anulación gerencial.');
      }
      if (entry.auto === true || entry.auto === 'true') throw new ServiceError('permission-denied', 'Las entradas automáticas del historial no se pueden eliminar');
      if (caller.role !== 'manager' && entry.by !== caller.cid) throw new ServiceError('permission-denied', 'Solo puedes eliminar las notas que tú escribiste');
      const next = logs.slice(0, at).concat(logs.slice(at + 1));
      tx.update(ref, { logs: next });
      tx.create(auditRef(), auditEntry(caller, 'deleteProspectLog', 'prospect', prospectId, { date: entryDate, textPreview: entryText.slice(0, 200), writtenBy: entry.by || null }));
      return { status: 'deleted' };
    });
  }

  // ---------- daily follow-up management ----------
  const FOLLOWUP_CHANNELS = ['llamada', 'correo', 'whatsapp', 'reunion', 'interno'];
  const FOLLOWUP_RESULTS = ['respondio_evaluando', 'solicito_tiempo', 'solicito_cambios', 'sin_respuesta', 'no_continua', 'nota_interna'];
  const FOLLOWUP_RESULT_LABELS = {
    respondio_evaluando: 'Cliente respondió y continúa evaluando',
    solicito_tiempo: 'Cliente solicitó más tiempo',
    solicito_cambios: 'Cliente solicitó cambios o nueva cotización',
    sin_respuesta: 'Se intentó contactar y no hubo respuesta',
    no_continua: 'Cliente confirmó que no desea continuar',
    nota_interna: 'Nota interna sin contacto con el cliente'
  };
  const FOLLOWUP_CHANNEL_LABELS = {
    llamada: 'Llamada',
    correo: 'Correo',
    whatsapp: 'WhatsApp',
    reunion: 'Reunión',
    interno: 'Nota Interna'
  };

  async function recordFollowUp({ caller, prospectId, data, opId }) {
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    data = asObject(data, 'Datos del seguimiento');

    const canal = reqString(data.canal, 'El canal de seguimiento', 50);
    if (!FOLLOWUP_CHANNELS.includes(canal)) throw bad('Canal de seguimiento inválido');

    const resultado = reqString(data.resultado, 'El resultado del contacto', 50);
    if (!FOLLOWUP_RESULTS.includes(resultado)) throw bad('Resultado de seguimiento inválido');

    const detalle = reqString(data.detalle, 'El detalle de la gestión', 2000);

    const proximaAccionInput = data.proxima_accion && typeof data.proxima_accion === 'object' ? data.proxima_accion : null;
    let proximaAccion = null;
    if (proximaAccionInput && proximaAccionInput.fecha) {
      proximaAccion = {
        fecha: reqString(proximaAccionInput.fecha, 'La fecha de próxima acción', 50),
        tipo: typeof proximaAccionInput.tipo === 'string' ? proximaAccionInput.tipo.trim() : 'llamada',
        descripcion: typeof proximaAccionInput.descripcion === 'string' ? proximaAccionInput.descripcion.trim().slice(0, 500) : ''
      };
    }

    const justificacionContinuidad = (typeof data.justificacion_continuidad === 'string' && data.justificacion_continuidad.trim())
      || (typeof data.justificacionContinuidad === 'string' && data.justificacionContinuidad.trim())
      || '';
    const fechaEntregaOferta = (typeof data.fecha_entrega_oferta === 'string' && data.fecha_entrega_oferta.trim())
      || (typeof data.fechaEntregaOferta === 'string' && data.fechaEntregaOferta.trim())
      || null;

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);

      // Restricción horizontal estricta: Gestores y Vendedores solo gestionan sus propias oportunidades asignadas (o creadas si no tienen vendedor asignado)
      if (caller.role === 'gestor' || caller.role === 'vendedor') {
        const isAssigned = p.vendedorId === caller.cid || (!p.vendedorId && p.createdBy === caller.cid);
        if (!isAssigned) {
          throw new ServiceError('permission-denied', 'No tienes permiso para gestionar el seguimiento de una oportunidad ajena');
        }
      }

      if (p.estado !== 'activo') {
        throw new ServiceError('failed-precondition', 'Solo se pueden registrar seguimientos en oportunidades activas');
      }

      const seguimiento = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
      const historial = Array.isArray(seguimiento.historial_gestiones) ? seguimiento.historial_gestiones : [];

      const currentPayloadHash = stableHash({
        usuarioId: caller.cid,
        canal,
        resultado,
        detalle,
        proxima_accion: proximaAccion ? {
          fecha: proximaAccion.fecha,
          tipo: proximaAccion.tipo || 'llamada',
          descripcion: proximaAccion.descripcion || ''
        } : null,
        justificacion_continuidad: justificacionContinuidad || ''
      });

      // Idempotency: retry with same opId
      const prior = historial.find(g => g && g.opId === opId);
      if (prior) {
        // Validación completa de coincidencia con la operación original (H-ID-01)
        const priorProx = prior.proxima_accion || null;
        const proxMatches = (() => {
          if (!priorProx && !proximaAccion) return true;
          if (!priorProx || !proximaAccion) return false;
          return priorProx.fecha === proximaAccion.fecha &&
            (priorProx.tipo || 'llamada') === (proximaAccion.tipo || 'llamada') &&
            (priorProx.descripcion || '') === (proximaAccion.descripcion || '');
        })();

        const matches = (
          (!prior.usuarioId || prior.usuarioId === caller.cid) &&
          prior.canal === canal &&
          prior.resultado === resultado &&
          prior.detalle === detalle &&
          proxMatches &&
          (!prior.justificacion_continuidad || prior.justificacion_continuidad === justificacionContinuidad) &&
          (!prior.payloadHash || prior.payloadHash === currentPayloadHash)
        );

        if (!matches) {
          throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        }

        const priorLog = logsOf(p).find(l => l && (l.opId === opId || (prior.id && l.gestionId === prior.id)));
        return { status: 'recorded', replay: true, seguimiento: p.seguimiento, logEntry: priorLog || null, entry: priorLog || null };
      }

      // Evitar que el opId se reutilice si ya fue usado en una nota de bitácora
      const priorLogOther = logsOf(p).find(l => l && l.opId === opId);
      if (priorLogOther) {
        throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
      }

      const curCadence = (seguimiento.cadencia && typeof seguimiento.cadencia === 'object') ? seguimiento.cadencia : {};
      const prevAttempts = Number(curCadence.intentos_fallidos || curCadence.intentos_validos_sin_respuesta) || 0;

      const esContactoValido = canal !== 'interno' && resultado !== 'nota_interna';

      // Rule check: 2nd attempt MUST be by phone call if previous attempt was unanswered
      if (esContactoValido && resultado === 'sin_respuesta' && prevAttempts === 1 && canal !== 'llamada') {
        throw new ServiceError('failed-precondition', 'El segundo intento de contacto debe realizarse mediante llamada telefónica obligatoria');
      }

      // Rule check: after 3 failed attempts, continuing requires justification
      if (esContactoValido && resultado === 'sin_respuesta' && prevAttempts >= 3) {
        const justif = justificacionContinuidad || curCadence.justificacion_continuidad;
        if (!justif || justif.length < 5) {
          throw new ServiceError('failed-precondition', 'Tras 3 intentos fallidos es obligatorio registrar la justificación de continuidad comercial');
        }
      }

      let newAttempts = prevAttempts;
      let estadoCadencia = curCadence.estado_cadencia || 'normal';
      let alertaGerencial = curCadence.alerta_gerencial === true;
      let fechaEscalacion = curCadence.fecha_escalacion || null;

      const at = iso();

      if (esContactoValido) {
        if (resultado === 'sin_respuesta') {
          newAttempts = prevAttempts + 1;
          if (newAttempts >= 5) {
            alertaGerencial = true;
            estadoCadencia = 'escalado_gerencia';
            if (!fechaEscalacion) fechaEscalacion = at;
          } else if (newAttempts >= 3) {
            estadoCadencia = 'requiere_decision_vendedor';
          } else {
            estadoCadencia = 'normal';
          }
        } else {
          // Client responded (evaluando, pidio tiempo, cambios, no continua): resets unanswered attempts
          newAttempts = 0;
          alertaGerencial = false;
          estadoCadencia = 'normal';
        }
      }

      const gestionId = `gest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const gestionEntry = {
        id: gestionId,
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        canal,
        resultado,
        detalle,
        justificacion_continuidad: justificacionContinuidad || null,
        es_contacto_valido: esContactoValido,
        intento_numero: esContactoValido && resultado === 'sin_respuesta' ? newAttempts : 0,
        proxima_accion: proximaAccion,
        opId,
        payloadHash: currentPayloadHash
      };

      const nextHistorial = historial.concat([gestionEntry]);

      const nextCadencia = {
        ...curCadence,
        tipo_cadencia: curCadence.tipo_cadencia || 'estandar',
        intentos_fallidos: newAttempts,
        intentos_validos_sin_respuesta: newAttempts,
        estado_cadencia: estadoCadencia,
        alerta_gerencial: alertaGerencial,
        fecha_escalacion: fechaEscalacion,
        fecha_entrega_oferta: curCadence.fecha_entrega_oferta || p.fecha_entrega_oferta || null
      };
      if (justificacionContinuidad) {
        nextCadencia.justificacion_continuidad = justificacionContinuidad;
      }

      const nextSeguimiento = {
        ...seguimiento,
        ultimo_contacto: esContactoValido ? {
          fecha: at,
          canal,
          resultado,
          detalle,
          usuarioId: caller.cid,
          usuarioNombre: caller.name || 'Comercial'
        } : (seguimiento.ultimo_contacto || null),
        proxima_accion: (resultado === 'no_continua' && (!proximaAccion || !proximaAccion.fecha)) ? null : (proximaAccion || seguimiento.proxima_accion || null),
        cadencia: nextCadencia,
        historial_gestiones: nextHistorial
      };

      // Also append a formatted note in logs for classic timeline visibility
      const canalLbl = FOLLOWUP_CHANNEL_LABELS[canal] || canal;
      const resLbl = FOLLOWUP_RESULT_LABELS[resultado] || resultado;
      const proxText = proximaAccion && proximaAccion.fecha ? ` | Próx: ${proximaAccion.fecha}${proximaAccion.descripcion ? ' (' + proximaAccion.descripcion + ')' : ''}` : '';
      const logText = `[GESTIÓN COMERCIAL] ${canalLbl} -> ${resLbl}${proxText}. Detalle: ${detalle}`;
      const noteEntry = {
        ...logEntry(caller, logText, { auto: true, opId }),
        tipo: 'gestion_comercial',
        gestionId: gestionEntry.id
      };
      const nextLogs = logsOf(p).concat([noteEntry]);

      tx.update(ref, {
        seguimiento: nextSeguimiento,
        logs: nextLogs
      });

      tx.create(auditRef(), auditEntry(caller, 'recordFollowUp', 'prospect', prospectId, {
        canal,
        resultado,
        intentos_fallidos: newAttempts,
        alerta_gerencial: alertaGerencial,
        estado_cadencia: estadoCadencia,
        es_contacto_valido: esContactoValido,
        gestionId: gestionEntry.id
      }));

      return { status: 'recorded', seguimiento: nextSeguimiento, logEntry: noteEntry, entry: noteEntry };
    });
  }

  // ---------- manager decision on follow-up escalation ----------
  // Permite a la gerencia intervenir sobre oportunidades con 5 intentos sin respuesta u otros límites excedidos:
  // Opción 1 ('ordenar_cierre'): Exige motivo reglamentario. Si ejecutarCierre es true, ejecuta el cierre formal como pérdida.
  // Opción 2 ('autorizar_continuar'): Exige justificación gerencial (>= 5 caracteres) y próxima acción con fecha.
  // Preserva historial completo, intentos fallidos y no reinicia artificialmente el contador.
  async function resolveFollowUpEscalation({ caller, prospectId, decision, motivo, justificacion, proximaAccion, ejecutarCierre, opId }) {
    await requireManager(caller, 'tomar decisiones gerenciales de seguimiento');
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    if (decision !== 'autorizar_continuar' && decision !== 'ordenar_cierre') {
      throw bad('decision debe ser autorizar_continuar u ordenar_cierre');
    }

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireNotDeleted(p);

      const seguimiento = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
      const curCadence = (seguimiento.cadencia && typeof seguimiento.cadencia === 'object') ? seguimiento.cadencia : {};
      const escalaciones = Array.isArray(curCadence.historial_escalaciones) ? curCadence.historial_escalaciones : [];

      // Idempotency: retry with same opId
      const prior = escalaciones.find(e => e && e.opId === opId);
      if (prior) {
        return { status: 'resolved', replay: true, escalacion: prior, seguimiento: p.seguimiento };
      }

      const stamp = iso();
      const attempts = Number(curCadence.intentos_fallidos || curCadence.intentos_validos_sin_respuesta) || 0;
      let nextCadence = {
        ...curCadence,
        intentos_fallidos: attempts,
        intentos_validos_sin_respuesta: attempts
      };
      let nextSeguimiento = { ...seguimiento };
      let patch = {};
      let auditDetail = { decision, prospectId };

      if (decision === 'autorizar_continuar') {
        if (typeof justificacion !== 'string' || justificacion.trim().length < 5) {
          throw bad('Es obligatorio indicar una justificación gerencial detallada (mínimo 5 caracteres)');
        }
        const why = justificacion.trim().slice(0, 1000);

        const proxInput = proximaAccion && typeof proximaAccion === 'object' ? proximaAccion : null;
        if (!proxInput || !proxInput.fecha) {
          throw bad('Es obligatorio establecer la fecha de la próxima acción de seguimiento');
        }
        const nextAction = {
          fecha: reqString(proxInput.fecha, 'La fecha de próxima acción', 50),
          tipo: typeof proxInput.tipo === 'string' ? proxInput.tipo.trim() : 'llamada',
          descripcion: typeof proxInput.descripcion === 'string' ? proxInput.descripcion.trim().slice(0, 500) : ''
        };

        const escalacionEntry = {
          id: `esc_res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          decision: 'autorizar_continuar',
          estado: 'continuidad_autorizada',
          fecha_resolucion: stamp,
          resuelto_por_id: caller.cid,
          resuelto_por: caller.name || 'Gerente',
          justificacion: why,
          proxima_accion: nextAction,
          opId
        };

        nextCadence.alerta_gerencial = false;
        nextCadence.estado_cadencia = 'continuidad_autorizada';
        nextCadence.justificacion_gerencial = why;
        nextCadence.historial_escalaciones = escalaciones.concat([escalacionEntry]);

        nextSeguimiento.cadencia = nextCadence;
        nextSeguimiento.proxima_accion = nextAction;

        const logText = `[DECISIÓN GERENCIAL] Continuidad comercial AUTORIZADA por gerente ${caller.name}. Justificación: ${why}. Próxima acción: ${nextAction.fecha} (${nextAction.tipo || 'seguimiento'})`;
        patch.seguimiento = nextSeguimiento;
        patch.logs = logsOf(p).concat([logEntry(caller, logText, { auto: true, opId })]);

        auditDetail.justificacion = why;
        auditDetail.proxima_accion = nextAction;
      } else if (decision === 'ordenar_cierre') {
        const reason = reqString(motivo, 'El motivo de cierre', 100);
        if (!MOTIVOS_PERDIDA.includes(reason)) {
          throw bad('Motivo de cierre comercial inválido');
        }
        const why = (typeof justificacion === 'string' && justificacion.trim()) ? justificacion.trim().slice(0, 1000) : null;
        const executeNow = ejecutarCierre === true;

        const escalacionEntry = {
          id: `esc_res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          decision: 'ordenar_cierre',
          estado: executeNow ? 'orden_cierre_ejecutada' : 'orden_cierre_pendiente',
          fecha_resolucion: stamp,
          resuelto_por_id: caller.cid,
          resuelto_por: caller.name || 'Gerente',
          motivo: reason,
          justificacion: why,
          ejecutarCierre: executeNow,
          opId
        };

        nextCadence.alerta_gerencial = false;
        nextCadence.estado_cadencia = executeNow ? 'cerrada' : 'orden_cierre_pendiente';
        nextCadence.motivo_cierre_gerencial = reason;
        nextCadence.historial_escalaciones = escalaciones.concat([escalacionEntry]);

        nextSeguimiento.cadencia = nextCadence;
        if (executeNow) {
          nextSeguimiento.proxima_accion = null;
        }

        patch.seguimiento = nextSeguimiento;

        if (executeNow) {
          if (p.estado !== 'activo') {
            throw new ServiceError('failed-precondition', 'Solo una oportunidad activa puede marcarse como perdida');
          }
          patch.estado = 'perdido';
          patch.motivo_perdida = reason;
          patch.fecha_perdida = stamp;

          let vendorsToRemove = [];
          if (p.etapa === 'cierre' && p.clientId) {
            const otherSnap = await tx.get(
              col('prospects')
                .where('clientId', '==', p.clientId)
                .where('etapa', '==', 'cierre')
            );
            const candidates = [p.vendedorId, p.createdBy].filter(v => v && v !== 'sistema');
            const remainingClosing = new Set();
            otherSnap.docs.forEach(d => {
              if (d.id === prospectId) return;
              const op = d.data() || {};
              if (op.eliminado === true || op.estado === 'perdido') return;
              if (op.vendedorId) remainingClosing.add(String(op.vendedorId));
              if (op.createdBy) remainingClosing.add(String(op.createdBy));
            });
            vendorsToRemove = candidates.filter(v => !remainingClosing.has(String(v)));
          }

          for (const v of vendorsToRemove) {
            tx.update(col('clients').doc(p.clientId), {
              closingVendors: FieldValue.arrayRemove(v)
            });
          }

          const logText = `[DECISIÓN GERENCIAL] CIERRE EJECUTADO por gerente ${caller.name}. Motivo: ${reason}${why ? `. Justificación: ${why}` : ''}`;
          patch.logs = logsOf(p).concat([logEntry(caller, logText, { auto: true, opId })]);
        } else {
          const logText = `[DECISIÓN GERENCIAL] ORDEN DE CIERRE EMITIDA por gerente ${caller.name}. Motivo ordenado: ${reason}${why ? `. Instrucción: ${why}` : ''}`;
          patch.logs = logsOf(p).concat([logEntry(caller, logText, { auto: true, opId })]);
        }

        auditDetail.motivo = reason;
        auditDetail.justificacion = why;
        auditDetail.ejecutarCierre = executeNow;
      }

      tx.update(ref, patch);
      tx.create(auditRef(), auditEntry(caller, 'resolveFollowUpEscalation', 'prospect', prospectId, auditDetail));

      return {
        status: 'resolved',
        decision,
        seguimiento: nextSeguimiento,
        estado: patch.estado || p.estado
      };
    });
  }

  // ---------- voiding / annulling a mistakenly recorded follow-up (manager only) ----------
  async function voidFollowUp({ caller, prospectId, gestionId, motivo, opId }) {
    await requireManager(caller, 'anular gestiones comerciales');
    reqDocId(prospectId, 'prospectId');
    const gid = reqString(gestionId, 'El identificador de la gestión', 100);
    reqOpId(opId);
    const why = reqString(motivo, 'El motivo de anulación', 1000);
    if (why.length < 5) {
      throw bad('Es obligatorio indicar el motivo de anulación (mínimo 5 caracteres)');
    }

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireNotDeleted(p);

      const seguimiento = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
      const historial = Array.isArray(seguimiento.historial_gestiones) ? seguimiento.historial_gestiones : [];

      const idx = historial.findIndex(g => g && (g.id === gid || g.opId === gid));
      if (idx === -1) throw new ServiceError('not-found', 'Gestión no encontrada en el historial');

      const targetGestion = historial[idx];

      // Idempotency: verificar si el opId ya fue utilizado en la anulación
      const priorVoidByOp = historial.find(g => g && g.voidOpId === opId);
      if (priorVoidByOp) {
        if (priorVoidByOp.id !== targetGestion.id || priorVoidByOp.anuladoPor !== caller.cid || priorVoidByOp.motivoAnulacion !== why) {
          throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        }
        const priorVoidLog = logsOf(p).find(l => l && (l.tipo === 'gestion_anulada' && l.gestionIdVoided === targetGestion.id));
        return { status: 'already_voided', replay: true, seguimiento: p.seguimiento, logEntry: priorVoidLog || null, entry: priorVoidLog || null };
      }

      const priorGestionByOp = historial.find(g => g && g.opId === opId);
      if (priorGestionByOp) {
        throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
      }

      const priorLogOther = logsOf(p).find(l => l && l.opId === opId && l.gestionIdVoided !== targetGestion.id);
      if (priorLogOther) {
        throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
      }

      if (targetGestion.anulada === true) {
        const priorVoidLog = logsOf(p).find(l => l && (l.tipo === 'gestion_anulada' && l.gestionIdVoided === targetGestion.id));
        return { status: 'already_voided', seguimiento: p.seguimiento, logEntry: priorVoidLog || null, entry: priorVoidLog || null };
      }

      const at = iso();

      const updatedGestion = {
        ...targetGestion,
        anulada: true,
        fechaAnulacion: at,
        anuladoPor: caller.cid,
        anuladoPorNombre: caller.name || 'Gerencia',
        motivoAnulacion: why,
        voidOpId: opId
      };

      const nextHistorial = historial.slice(0, idx).concat([updatedGestion]).concat(historial.slice(idx + 1));

      // Recompute active state from non-annulled valid gestiones
      const activeValidGestiones = nextHistorial.filter(g => g && !g.anulada && g.es_contacto_valido);

      const curCadence = (seguimiento.cadencia && typeof seguimiento.cadencia === 'object') ? seguimiento.cadencia : {};
      const prevTotal = Number(curCadence.intentos_fallidos || curCadence.intentos_validos_sin_respuesta) || 0;
      const wasFailedAttempt = targetGestion.es_contacto_valido && targetGestion.resultado === 'sin_respuesta';

      let activeAttempts = 0;
      if (activeValidGestiones.length > 0) {
        for (let i = activeValidGestiones.length - 1; i >= 0; i--) {
          const g = activeValidGestiones[i];
          if (g.resultado === 'sin_respuesta') {
            activeAttempts++;
          } else {
            break;
          }
        }
      }

      // Si el historial estructurado no contiene intentos históricos heredados, preservar el decremento seguro
      if (wasFailedAttempt && (activeValidGestiones.length < (prevTotal - 1) || activeAttempts < (prevTotal - 1))) {
        activeAttempts = Math.max(activeAttempts, prevTotal - 1);
      }

      let estadoCadencia = 'normal';
      let alertaGerencial = false;
      let fechaEscalacion = null;

      if (activeAttempts >= 5) {
        alertaGerencial = true;
        estadoCadencia = 'escalado_gerencia';
        let c = 0;
        for (let i = 0; i < activeValidGestiones.length; i++) {
          if (activeValidGestiones[i].resultado === 'sin_respuesta') {
            c++;
            if (c === 5) {
              fechaEscalacion = activeValidGestiones[i].fecha;
              break;
            }
          }
        }
      } else if (activeAttempts >= 3) {
        estadoCadencia = 'requiere_decision_vendedor';
      }

      const nextCadence = {
        ...curCadence,
        intentos_fallidos: activeAttempts,
        intentos_validos_sin_respuesta: activeAttempts,
        estado_cadencia: estadoCadencia,
        alerta_gerencial: alertaGerencial,
        fecha_escalacion: fechaEscalacion
      };

      const lastActiveValid = activeValidGestiones.length > 0 ? activeValidGestiones[activeValidGestiones.length - 1] : null;
      const nextUltimoContacto = lastActiveValid ? {
        fecha: lastActiveValid.fecha,
        canal: lastActiveValid.canal,
        resultado: lastActiveValid.resultado,
        detalle: lastActiveValid.detalle,
        usuarioId: lastActiveValid.usuarioId,
        usuarioNombre: lastActiveValid.usuarioNombre
      } : null;

      let nextProximaAccion = null;
      if (lastActiveValid && lastActiveValid.proxima_accion && lastActiveValid.proxima_accion.fecha) {
        nextProximaAccion = lastActiveValid.proxima_accion;
      } else if (p.fecha_entrega_oferta && curCadence.tipo_cadencia) {
        const dias1er = curCadence.tipo_cadencia === 'urgente' ? 3 : 5;
        let primerYMD = '';
        if (CrmFollowUpCalc && typeof CrmFollowUpCalc.addBusinessDaysForExternalContact === 'function') {
          const dt = CrmFollowUpCalc.addBusinessDaysForExternalContact(p.fecha_entrega_oferta, dias1er);
          primerYMD = CrmFollowUpCalc.formatDateYMD(dt);
        } else {
          primerYMD = p.fecha_entrega_oferta.slice(0, 10);
        }
        nextProximaAccion = {
          fecha: primerYMD,
          tipo: 'llamada',
          descripcion: `Primer seguimiento comercial post-oferta (${dias1er} días hábiles)`
        };
      }

      const nextSeguimiento = {
        ...seguimiento,
        ultimo_contacto: nextUltimoContacto,
        proxima_accion: nextProximaAccion,
        cadencia: nextCadence,
        historial_gestiones: nextHistorial
      };

      const canalLbl = FOLLOWUP_CHANNEL_LABELS[targetGestion.canal] || targetGestion.canal;
      const logText = `[GESTIÓN ANULADA] Gestión (${canalLbl}) anulada por gerente ${caller.name || 'Gerencia'}. Motivo: ${why}`;
      const voidLogEntry = {
        ...logEntry(caller, logText, { auto: true, opId }),
        tipo: 'gestion_anulada',
        gestionIdVoided: targetGestion.id
      };
      const nextLogs = logsOf(p).concat([voidLogEntry]);

      tx.update(ref, {
        seguimiento: nextSeguimiento,
        logs: nextLogs
      });

      tx.create(auditRef(), auditEntry(caller, 'voidFollowUp', 'prospect', prospectId, {
        gestionId: targetGestion.id,
        canal: targetGestion.canal,
        resultado: targetGestion.resultado,
        motivo: why,
        previousAttempts: Number(curCadence.intentos_fallidos || 0),
        newAttempts: activeAttempts
      }));

      return { status: 'voided', seguimiento: nextSeguimiento, logEntry: voidLogEntry, entry: voidLogEntry };
    });
  }

  // ---------- cadencia configurable y controlada por límites (Fase 2.1) ----------
  async function updateProspectCadence({ caller, prospectId, tipoCadencia, motivo, opId }) {
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    const targetCadence = reqString(tipoCadencia, 'El tipo de cadencia', 50).toLowerCase();
    const reason = reqString(motivo, 'El motivo del cambio de cadencia', 500);
    if (reason.length < 5) {
      throw bad('Es obligatorio registrar el motivo del cambio de cadencia (mínimo 5 caracteres)');
    }

    // Validar que la cadencia sea una de las alternativas aprobadas
    const validation = CrmFollowUpCalc ? CrmFollowUpCalc.validateCadenceSelection(targetCadence) : { valid: ['estandar', 'urgente', 'corporativa'].includes(targetCadence) };
    if (!validation.valid) {
      throw bad(validation.error || 'Alternativa de cadencia comercial no autorizada');
    }

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);

      if (caller.role === 'gestor' || caller.role === 'vendedor') {
        const isAssigned = p.vendedorId === caller.cid || (!p.vendedorId && p.createdBy === caller.cid);
        if (!isAssigned) {
          throw new ServiceError('permission-denied', 'No tienes permiso para modificar la cadencia de una oportunidad ajena');
        }
      }

      if (p.estado !== 'activo') {
        throw new ServiceError('failed-precondition', 'Solo se puede configurar la cadencia en oportunidades activas');
      }

      const seguimiento = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
      const curCadence = (seguimiento.cadencia && typeof seguimiento.cadencia === 'object') ? seguimiento.cadencia : {};
      const historialCambios = Array.isArray(curCadence.historial_cambios) ? curCadence.historial_cambios : [];

      // Idempotency: retry with same opId
      const prior = historialCambios.find(c => c && c.opId === opId);
      if (prior) {
        return { status: 'updated', replay: true, cadencia: curCadence, seguimiento: p.seguimiento };
      }

      const prevCadenceId = curCadence.tipo_cadencia || 'estandar';
      if (prevCadenceId === targetCadence) {
        return { status: 'unchanged', cadencia: curCadence, seguimiento: p.seguimiento };
      }

      // Invariants inviolables (Fase 2.1):
      // No permitir que la selección modifique umbrales de escalamiento, elimine intentos fallidos ni reinicie contadores
      const attempts = Number(curCadence.intentos_fallidos || curCadence.intentos_validos_sin_respuesta) || 0;
      const estadoCadencia = curCadence.estado_cadencia || 'normal';
      const alertaGerencial = curCadence.alerta_gerencial === true;
      const fechaEscalacion = curCadence.fecha_escalacion || null;

      const at = iso();
      const cambioEntry = {
        id: `cad_chg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        cadenciaAnterior: prevCadenceId,
        cadenciaNueva: targetCadence,
        motivo: reason,
        opId
      };

      const cadProfile = CrmFollowUpCalc ? CrmFollowUpCalc.CADENCIAS_VALIDAS[targetCadence] : null;

      const nextCadence = {
        ...curCadence,
        tipo_cadencia: targetCadence,
        nombre_cadencia: cadProfile ? cadProfile.nombre : targetCadence,
        intentos_fallidos: attempts,
        intentos_validos_sin_respuesta: attempts,
        estado_cadencia: estadoCadencia,
        alerta_gerencial: alertaGerencial,
        fecha_escalacion: fechaEscalacion,
        historial_cambios: historialCambios.concat([cambioEntry])
      };

      const nextSeguimiento = {
        ...seguimiento,
        cadencia: nextCadence
      };

      const logText = `[CADENCIA COMERCIAL] Cadencia cambiada de "${prevCadenceId}" a "${targetCadence}" por ${caller.name || 'Comercial'}. Motivo: ${reason}`;
      const patch = {
        seguimiento: nextSeguimiento,
        logs: logsOf(p).concat([logEntry(caller, logText, { auto: true, opId })])
      };

      tx.update(ref, patch);
      tx.create(auditRef(), auditEntry(caller, 'updateCadence', 'prospect', prospectId, {
        cadenciaAnterior: prevCadenceId,
        cadenciaNueva: targetCadence,
        motivo: reason,
        intentos_preservados: attempts
      }));

      return {
        status: 'updated',
        tipoCadencia: targetCadence,
        cadencia: nextCadence,
        seguimiento: nextSeguimiento
      };
    });
  }

  // ---------- clasificación comercial: presupuesto frente a ejecución ----------
  async function reclassifyProspect({ caller, prospectId, clasificacion, motivo, opId }) {
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    if (!clasificacion || typeof clasificacion !== 'string') {
      throw bad('Clasificación requerida');
    }
    const targetClasif = clasificacion.trim().toLowerCase();
    if (targetClasif !== 'ejecucion' && targetClasif !== 'presupuesto') {
      throw bad('Clasificación comercial inválida. Opciones válidas: ejecucion, presupuesto');
    }

    const reason = reqString(motivo, 'El motivo comercial del cambio de clasificación', 500);
    if (reason.trim().length < 5) {
      throw bad('El motivo del cambio de clasificación debe tener al menos 5 caracteres');
    }

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);

      if (caller.role === 'gestor' || caller.role === 'vendedor') {
        const isAssigned = p.vendedorId === caller.cid || (!p.vendedorId && p.createdBy === caller.cid);
        if (!isAssigned) {
          throw new ServiceError('permission-denied', 'No tienes permiso para modificar la clasificación de una oportunidad ajena');
        }
      }

      if (p.estado !== 'activo') {
        throw new ServiceError('failed-precondition', 'Solo se pueden reclasificar oportunidades activas');
      }

      const historialClasificacion = Array.isArray(p.historial_clasificacion) ? p.historial_clasificacion : [];

      // Idempotency: retry with same opId
      const prior = historialClasificacion.find(c => c && c.opId === opId);
      if (prior) {
        return { status: 'reclassified', replay: true, clasificacion: p.clasificacion || targetClasif, historial_clasificacion: historialClasificacion };
      }

      const prevClasif = p.clasificacion || 'ejecucion';
      if (prevClasif === targetClasif) {
        return { status: 'unchanged', clasificacion: prevClasif, historial_clasificacion: historialClasificacion };
      }

      const at = iso();
      const cambioEntry = {
        id: `clasif_chg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        clasificacionAnterior: prevClasif,
        clasificacionNueva: targetClasif,
        motivo: reason,
        opId
      };

      const nextHistorial = historialClasificacion.concat([cambioEntry]);
      const patch = {
        clasificacion: targetClasif,
        historial_clasificacion: nextHistorial,
        updatedAt: at
      };

      // Si pasa de presupuesto a ejecución: activar reglas comerciales correspondientes en el momento adecuado
      // Si la oportunidad ya estaba en etapa de negociación, registrar fecha_entrega_oferta
      if (prevClasif === 'presupuesto' && targetClasif === 'ejecucion') {
        if (p.etapa === 'negociacion') {
          const curDelivery = p.fecha_entrega_oferta || (p.seguimiento && p.seguimiento.cadencia && p.seguimiento.cadencia.fecha_entrega_oferta);
          if (!curDelivery) {
            patch.fecha_entrega_oferta = at;
          }
          const curSeg = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
          if (!curSeg.proxima_accion || !curSeg.proxima_accion.fecha) {
            const cadConfig = CrmFollowUpCalc ? CrmFollowUpCalc.getCadenceConfig((curSeg.cadencia && curSeg.cadencia.tipo_cadencia) || 'estandar') : { dias_primer_contacto: 5 };
            const dias1er = cadConfig.dias_primer_contacto || 5;
            let proxYMD = '';
            if (CrmFollowUpCalc) {
              const d = CrmFollowUpCalc.addBusinessDaysForExternalContact(at, dias1er);
              proxYMD = CrmFollowUpCalc.formatDateYMD(d);
            } else {
              const d = new Date();
              d.setDate(d.getDate() + 7);
              proxYMD = d.toISOString().slice(0, 10);
            }
            patch['seguimiento.proxima_accion'] = {
              fecha: proxYMD,
              tipo: 'llamada',
              descripcion: '1er contacto de seguimiento post-oferta (activado tras confirmar oferta para ejecución)'
            };
          }
        }
      }

      const prevLabel = prevClasif === 'presupuesto' ? 'Cotización para presupuesto' : 'Oferta para ejecución';
      const newLabel = targetClasif === 'presupuesto' ? 'Cotización para presupuesto' : 'Oferta para ejecución';
      const logText = `[CLASIFICACIÓN COMERCIAL] Clasificación cambiada de "${prevLabel}" a "${newLabel}" por ${caller.name || 'Comercial'}. Motivo: ${reason}`;
      const logs = logsOf(p);
      logs.push(logEntry(caller, logText, { auto: true }));
      patch.logs = logs;

      tx.update(ref, patch);

      tx.create(auditRef(), auditEntry(caller, 'reclassifyProspect', 'prospect', prospectId, {
        clasificacionAnterior: prevClasif,
        clasificacionNueva: targetClasif,
        motivo: reason
      }));

      return {
        status: 'reclassified',
        clasificacion: targetClasif,
        historial_clasificacion: nextHistorial
      };
    });
  }

  // ---------- reassignment ----------
  async function reassign({ caller, prospectId, vendedorId }) {
    await requireManager(caller, 'reasignar oportunidades');
    reqDocId(prospectId, 'prospectId');
    reqDocId(vendedorId, 'vendedorId');
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireNotDeleted(p);
      if (hasEnteredPostclosing(p) || (p.etapa === 'cierre' && p.estado === 'ganado')) {
        throw new ServiceError('failed-precondition', 'No se puede reasignar una oportunidad que ya completó el cierre comercial');
      }
      const target = await readAssignee(tx, vendedorId);
      if (target.role !== 'vendedor' && target.role !== 'gestor') {
        throw bad('Solo se pueden reasignar oportunidades a usuarios con rol Vendedor o Gestor');
      }
      if (p.vendedorId === target.cid) return { status: 'unchanged', vendedorId: target.cid }; // retry of an applied request

      let clientRef = null;
      let clientSnap = null;
      let hasOtherProspects = false;
      let hasOtherClosing = false;
      let isClientCreator = false;

      if (p.clientId) {
        clientRef = col('clients').doc(p.clientId);
        clientSnap = await tx.get(clientRef);
        const otherSnap = await tx.get(
          col('prospects')
            .where('clientId', '==', p.clientId)
        );
        const otherDocs = otherSnap.docs.filter(d => d.id !== prospectId && (d.data() || {}).eliminado !== true);
        hasOtherProspects = otherDocs.some(d => {
          const op = d.data() || {};
          return op.vendedorId === p.vendedorId || op.createdBy === p.vendedorId;
        });
        hasOtherClosing = otherDocs.some(d => {
          const op = d.data() || {};
          return op.etapa === 'cierre' && op.estado !== 'perdido' && (op.vendedorId === p.vendedorId || op.createdBy === p.vendedorId);
        });
        isClientCreator = clientSnap.exists && (clientSnap.data() || {}).createdBy === p.vendedorId;
      }

      const logs = logsOf(p).concat([logEntry(caller, `Vendedor reasignado de ${p.vendedorName || p.vendedorId || 'N/A'} a ${target.nombre} por gerente ${caller.name}`, { auto: true })]);
      tx.update(ref, { vendedorId: target.cid, vendedorName: target.nombre, vendedorRole: target.role, logs });

      if (clientRef && clientSnap && clientSnap.exists) {
        const clientData = clientSnap.data() || {};
        const clientPatch = {};
        const visibleSet = new Set(Array.isArray(clientData.visibleTo) ? clientData.visibleTo : []);
        if (target.cid && target.cid !== 'sistema') {
          visibleSet.add(target.cid);
        }
        if (p.vendedorId && p.vendedorId !== 'sistema' && !hasOtherProspects && !isClientCreator) {
          visibleSet.delete(p.vendedorId);
        }
        clientPatch.visibleTo = Array.from(visibleSet);

        if (p.etapa === 'cierre') {
          const closingSet = new Set(Array.isArray(clientData.closingVendors) ? clientData.closingVendors : []);
          if (target.cid && target.cid !== 'sistema') {
            closingSet.add(target.cid);
          }
          if (p.vendedorId && p.vendedorId !== 'sistema' && !hasOtherClosing) {
            closingSet.delete(p.vendedorId);
          }
          clientPatch.closingVendors = Array.from(closingSet);
        }
        if (Object.keys(clientPatch).length > 0) {
          tx.update(clientRef, clientPatch);
        }
      }

      tx.create(auditRef(), auditEntry(caller, 'reassignProspect', 'prospect', prospectId, {
        from: p.vendedorId || null,
        fromName: p.vendedorName || null,
        to: target.cid,
        toName: target.nombre,
        authorizedBy: caller.cid,
        authorizedByName: caller.name
      }));
      return { status: 'reassigned', vendedorId: target.cid, vendedorName: target.nombre, vendedorRole: target.role };
    });
  }

  // ---------- "sale authorised without contract" ----------
  // Two ways to obtain the exception, both ending in the SAME stored decision (`datos.autorizado_sin_contrato`, the only
  // thing the closing reads):
  //   1. request / resolve: a vendedor (or gestor) with access to the opportunity asks with a reason; a manager, from
  //      their own authenticated session, approves or rejects. The request lives in `solicitudes_sin_contrato` on the
  //      opportunity (the manager's browser already listens to prospects) with its whole life cycle:
  //      { id, estado: pendiente|aprobada|rechazada|revocada, solicitante_id/_nombre/_rol, fecha_solicitud, motivo,
  //        resuelto_por_id, resuelto_por, fecha_resolucion, motivo_decision, opId }
  //   2. direct decision by a manager (setNoContractAuthorization, unchanged behaviour): it also settles the request.
  // The browser never sends who requests, who resolves, dates or the authorisation flags: they come from the session and
  // the stored document. Every transition writes a commercialAudit record and a history entry.
  const NC_MAX_REQUESTS = 30;
  const ncOf = p => (Array.isArray(p.solicitudes_sin_contrato) ? p.solicitudes_sin_contrato : []);
  const ncPending = list => list.find(r => r && r.estado === 'pendiente');
  const ncId = taken => { let id = Number(now().getTime()); while (taken.includes(String(id))) id += 1; return String(id); };
  const ncPublic = r => ({ id: r.id, estado: r.estado, solicitante_id: r.solicitante_id, solicitante_nombre: r.solicitante_nombre, fecha_solicitud: r.fecha_solicitud, motivo: r.motivo, resuelto_por: r.resuelto_por || null, fecha_resolucion: r.fecha_resolucion || null, motivo_decision: r.motivo_decision || null });

  async function requestNoContractAuthorization({ caller, prospectId, motivo, opId }) {
    if (!['vendedor', 'gestor'].includes(caller.role)) {
      throw new ServiceError('permission-denied', caller.role === 'manager' ? 'Un gerente autoriza directamente, no necesita solicitarlo' : 'Tu rol no puede solicitar esta autorización');
    }
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId);
    const reason = reqString(motivo, 'El motivo de la solicitud', 500);
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireProspectAccess(caller, p);
      const list = ncOf(p);
      const prior = list.find(r => r && r.opId === opId);
      if (prior) {
        // Same opId: a retry of an applied request. Used by someone else or with other data: misuse of the key.
        if (prior.solicitante_id !== caller.cid || prior.motivo !== reason) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        return { status: 'requested', replay: true, request: ncPublic(prior) };
      }
      const datos = p.datos && typeof p.datos === 'object' ? p.datos : {};
      if (datos.autorizado_sin_contrato === true) throw new ServiceError('failed-precondition', 'La venta ya está autorizada sin contrato');
      if (p.estado !== 'activo') throw new ServiceError('failed-precondition', 'Solo una oportunidad activa puede solicitar la autorización');
      const pending = ncPending(list);
      if (pending) {
        // Double click / second tab by the same person with the same reason: the request is already there.
        if (pending.solicitante_id === caller.cid && pending.motivo === reason) return { status: 'unchanged', request: ncPublic(pending) };
        throw new ServiceError('failed-precondition', 'Ya hay una solicitud pendiente para esta oportunidad');
      }
      if (list.length >= NC_MAX_REQUESTS) throw new ServiceError('failed-precondition', 'La oportunidad alcanzó el máximo de solicitudes');
      const request = {
        id: ncId(list.map(r => r && r.id)), estado: 'pendiente',
        solicitante_id: caller.cid, solicitante_nombre: caller.name || '', solicitante_rol: caller.role,
        fecha_solicitud: iso(), motivo: reason,
        resuelto_por_id: null, resuelto_por: null, fecha_resolucion: null, motivo_decision: null, opId
      };
      tx.update(ref, {
        solicitudes_sin_contrato: list.concat([request]),
        logs: logsOf(p).concat([logEntry(caller, `Solicitud de autorización de venta sin contrato registrada por ${caller.name || 'Sistema'}. Motivo: ${reason}`, { auto: true })])
      });
      tx.create(auditRef(), auditEntry(caller, 'requestNoContractAuthorization', 'prospect', prospectId, { requestId: request.id, motivo: reason }));
      return { status: 'requested', request: ncPublic(request) };
    });
  }

  async function resolveNoContractAuthorization({ caller, prospectId, requestId, decision, motivoDecision }) {
    await requireManager(caller, 'resolver solicitudes de venta sin contrato');
    reqDocId(prospectId, 'prospectId');
    reqDocId(requestId, 'requestId');
    if (decision !== 'approve' && decision !== 'reject') throw bad('decision debe ser approve o reject');
    const approve = decision === 'approve';
    let why = '';
    if (motivoDecision !== undefined && motivoDecision !== null && motivoDecision !== '') {
      if (typeof motivoDecision !== 'string') throw bad('El motivo de la decisión es inválido');
      why = motivoDecision.trim();
      if (why.length > 500) throw bad('El motivo de la decisión excede 500 caracteres');
    }
    if (!approve && !why) throw bad('El motivo del rechazo es obligatorio');
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireNotDeleted(p);
      const list = ncOf(p);
      const at = list.findIndex(r => r && r.id === requestId);
      if (at === -1) throw new ServiceError('not-found', 'Solicitud no encontrada');
      const cur = list[at];
      if (cur.solicitante_id === caller.cid) throw new ServiceError('permission-denied', 'No puedes resolver una solicitud que tú mismo hiciste');
      const wanted = approve ? 'aprobada' : 'rechazada';
      // The CURRENT state decides: a repeated decision is a no-op, a contradictory or late one is refused.
      if (cur.estado === wanted) return { status: 'unchanged', request: ncPublic(cur) };
      if (cur.estado !== 'pendiente') throw new ServiceError('failed-precondition', `La solicitud ya fue resuelta (${cur.estado})`);
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      let aprobacionRecord = null;
      if (approve) {
        if (p.estado !== 'activo') throw new ServiceError('failed-precondition', 'Solo una oportunidad activa puede autorizarse sin contrato');
        aprobacionRecord = bindNoContractApproval({
          prospect: p,
          datos,
          caller,
          offerDoc: (datos && (datos.doc_firmado || datos.doc_oferta_firmada || datos.doc_oferta)) || p.doc_firmado,
          why,
          isoStamp: iso()
        });
      }
      const resolved = { ...cur, estado: wanted, resuelto_por_id: caller.cid, resuelto_por: caller.name || '', fecha_resolucion: iso(), motivo_decision: why || null };
      const next = list.slice(); next[at] = resolved;
      const text = approve
        ? `Autorización de venta sin contrato APROBADA por gerente ${caller.name} (solicitada por ${cur.solicitante_nombre || cur.solicitante_id})${why ? `. Motivo: ${why}` : ''}`
        : `Solicitud de venta sin contrato RECHAZADA por gerente ${caller.name} (solicitada por ${cur.solicitante_nombre || cur.solicitante_id}). Motivo: ${why}`;
      tx.update(ref, {
        ...(approve ? { datos, aprobacion_sin_contrato: aprobacionRecord } : {}),
        solicitudes_sin_contrato: next,
        logs: logsOf(p).concat([logEntry(caller, text, { auto: true })])
      });
      tx.create(auditRef(), auditEntry(caller, approve ? 'approveNoContractRequest' : 'rejectNoContractRequest', 'prospect', prospectId, { requestId, solicitanteId: cur.solicitante_id || cur.solicitanteId || null, motivoDecision: why || null }));
      return { status: approve ? 'approved' : 'rejected', request: ncPublic(resolved) };
    });
  }

  // A manager decision. The name stored comes from the manager's profile; the browser cannot choose who "authorised".
  async function setNoContractAuthorization({ caller, prospectId, authorized }) {
    await requireManager(caller, 'autorizar ventas sin contrato');
    reqDocId(prospectId, 'prospectId');
    if (typeof authorized !== 'boolean') throw bad('authorized debe ser verdadero o falso');
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};
      requireNotDeleted(p);
      if (p.estado !== 'activo') throw new ServiceError('failed-precondition', 'Solo una oportunidad activa puede autorizarse sin contrato');
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      const current = datos.autorizado_sin_contrato === true;
      if (current === authorized) return { status: 'unchanged', authorized };
      // Keep the request history coherent with the decision: granting settles a pending request as approved, revoking marks
      // the approved one as revoked. Nothing is deleted.
      const stamp = iso();
      const list = ncOf(p).map(r => {
        if (!r) return r;
        if (authorized && r.estado === 'pendiente') {
          return { ...r, estado: 'aprobada', resuelto_por_id: caller.cid, resuelto_por: caller.name || '', fecha_resolucion: stamp, motivo_decision: 'Autorización directa del gerente' };
        }
        if (!authorized && r.estado === 'aprobada') {
          return { ...r, estado: 'revocada', resuelto_por_id: caller.cid, resuelto_por: caller.name || '', fecha_resolucion: stamp, motivo_decision: 'Autorización revocada por el gerente' };
        }
        return r;
      });
      let aprobacionRecord = null;
      if (authorized) {
        aprobacionRecord = bindNoContractApproval({
          prospect: p,
          datos,
          caller,
          offerDoc: (datos && (datos.doc_firmado || datos.doc_oferta_firmada || datos.doc_oferta)) || p.doc_firmado,
          why: 'Autorización directa del gerente',
          isoStamp: stamp
        });
      } else {
        datos.autorizado_sin_contrato = false;
        delete datos.autorizado_por;
        delete datos.autorizado_por_id;
        aprobacionRecord = {
          ...(p.aprobacion_sin_contrato || (datos && datos.aprobacion_sin_contrato) || {}),
          estado: 'revocada',
          fecha_revocacion: stamp,
          revocado_por_id: caller.cid
        };
      }
      const text = authorized
        ? `Autorización de venta sin contrato otorgada por gerente: ${caller.name}`
        : `Autorización de venta sin contrato revocada por gerente: ${caller.name}`;
      const patch = {
        datos,
        aprobacion_sin_contrato: aprobacionRecord,
        logs: logsOf(p).concat([logEntry(caller, text, { auto: true })])
      };
      if (ncOf(p).length > 0) patch.solicitudes_sin_contrato = list;
      tx.update(ref, patch);
      tx.create(auditRef(), auditEntry(caller, authorized ? 'grantNoContractAuthorization' : 'revokeNoContractAuthorization', 'prospect', prospectId, {}));
      return { status: 'updated', authorized, autorizado_por: authorized ? caller.name : null };
    });
  }

  // ---------- shared settings ----------
  // `system*/settings` is SHARED with fabricacion (colores_pintura, tipos_base, maquinas, usbs, meta_diaria_piezas ...).
  // The CRM used to rewrite the whole document from its in-memory copy. Here only the CRM-owned fields are touched, by
  // value (not by index), with a merge: a stale copy can no longer erase or overwrite fabricacion's fields.
  async function updateSettings({ caller, action, list, value }) {
    await requireManager(caller, 'modificar los ajustes del sistema');
    if (!SETTINGS_ACTIONS.includes(action)) throw bad('Acción de ajustes no válida');
    return db.runTransaction(async tx => {
      const ref = col('system').doc('settings');
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() || {}) : {};
      let patch; let detail;
      if (action === 'setFactoryAddress') {
        if (typeof value !== 'string' || value.length > 300) throw bad('Dirección inválida');
        const next = value.trim();
        if ((cur.factory_address || '') === next) return { status: 'unchanged', settings: view(cur) };
        patch = { factory_address: next }; detail = { action, from: cur.factory_address || '', to: next };
      } else {
        if (!SETTINGS_LISTS.includes(list)) throw bad('Lista de ajustes no válida');
        const item = reqString(value, 'El nombre', 120);
        const items = Array.isArray(cur[list]) ? cur[list].filter(x => typeof x === 'string') : [];
        if (action === 'addItem') {
          if (items.includes(item)) return { status: 'unchanged', settings: view(cur) };
          patch = { [list]: items.concat([item]) };
        } else {
          if (!items.includes(item)) return { status: 'unchanged', settings: view(cur) };
          patch = { [list]: items.filter(x => x !== item) };
        }
        detail = { action, list, value: item };
      }
      tx.set(ref, patch, { merge: true });
      tx.create(auditRef(), auditEntry(caller, 'updateSettings', 'settings', 'settings', detail));
      return { status: 'updated', settings: view({ ...cur, ...patch }) };
    });
    function view(s) {
      return {
        visitantes: Array.isArray(s.visitantes) ? s.visitantes : [],
        encargados: Array.isArray(s.encargados) ? s.encargados : [],
        factory_address: typeof s.factory_address === 'string' ? s.factory_address : ''
      };
    }
  }

  // ---------- client deletion ----------
  // Manager only. Refused while any opportunity references the client (checked in the same transaction as the delete,
  // so an opportunity created at the same moment either blocks the delete or sees the client gone). The identifier index
  // entries OWNED by this client are released with it.
  async function deleteClient({ caller, clientId }) {
    await requireManager(caller, 'eliminar clientes');
    reqDocId(clientId, 'clientId');
    return db.runTransaction(async tx => {
      const ref = col('clients').doc(clientId);
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 'absent' }; // retry of an applied delete
      const c = snap.data() || {};
      const refs = await tx.get(col('prospects').where('clientId', '==', clientId).limit(1));
      if (!refs.empty) throw new ServiceError('failed-precondition', 'El cliente tiene proyectos asociados: elimínalos primero');
      const owned = [];
      for (const k of identity.keysOf({ ...c, id: clientId })) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists && (idx.data() || {}).clientId === clientId) owned.push(k);
      }
      const label = identity.displayName(c) || clientId;
      tx.delete(ref);
      owned.forEach(k => tx.delete(col('identifiers').doc(k)));
      tx.create(col('auditLogs').doc(), {
        fecha: iso(), timestamp: FieldValue.serverTimestamp(),
        usuario: caller.name || caller.cid, usuarioId: caller.cid, usuarioUid: caller.uid,
        proyectoId: 'N/A', proyectoNombre: label, item: 'Cliente', detalle: 'Cliente eliminado por completo',
        source: 'callable'
      });
      return { status: 'deleted', releasedIdentifiers: owned.length };
    });
  }

  const kit = { col, iso, now, logEntry, logsOf, auditEntry, auditRef, hasEnteredPostclosing, canAccessProspect, requireProspectAccess, requireNotDeleted, requirePrivileged, requireManager, names, reclassifyProspect };
  return { names, kit, hasEnteredPostclosing, createProspect, addLog, deleteLog, recordFollowUp, voidFollowUp, updateProspectCadence, resolveFollowUpEscalation, reclassifyProspect, reassign, setNoContractAuthorization, requestNoContractAuthorization, resolveNoContractAuthorization, updateSettings, deleteClient };
}

module.exports = { createCommercialService, hasEnteredPostclosing, namesFor, SETTINGS_LISTS, SETTINGS_ACTIONS, validators: { bad, asObject, reqString, reqDocId, reqOpId, DOC_ID_RE, OP_ID_RE, MAX_LOGS } };
