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

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const SETTINGS_LISTS = ['visitantes', 'encargados'];
const SETTINGS_ACTIONS = ['addItem', 'removeItem', 'setFactoryAddress'];
const CRM_TZ_OFFSET_MS = -6 * 3600 * 1000; // El Salvador (no DST): the year of the opportunity code follows local time
const MAX_LOGS = 2000;

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

function createCommercialService({ db, FieldValue, suffix, verifyManager, now = () => new Date(), newProspectId = () => String(Date.now()) }) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  if (typeof verifyManager !== 'function') throw new Error('verifyManager is required');
  const names = namesFor(suffix);
  const col = n => db.collection(names[n]);
  const iso = () => now().toISOString();

  // ---------- authorization ----------
  function hasEnteredPostclosing(p) {
    if (!p || typeof p !== 'object') return false;
    return p.postcierre_habilitado === true
      || (typeof p.fecha_cierre === 'string' && p.fecha_cierre.length > 0)
      || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre)
      || (Array.isArray(p.facturas) && p.facturas.length > 0);
  }

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
    const fields = {
      proyecto: reqString(data.proyecto, 'El nombre del proyecto', 200),
      origen: reqString(data.origen, 'El origen', 100),
      tipo_proyecto: reqString(data.tipo_proyecto, 'El tipo de proyecto', 100),
      tipo_producto: reqString(data.tipo_producto, 'El tipo de producto', 100)
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
      if (entry.auto === true || entry.auto === 'true') throw new ServiceError('permission-denied', 'Las entradas automáticas del historial no se pueden eliminar');
      if (!PRIVILEGED.includes(caller.role) && entry.by !== caller.cid) throw new ServiceError('permission-denied', 'Solo puedes eliminar las notas que tú escribiste');
      const next = logs.slice(0, at).concat(logs.slice(at + 1));
      tx.update(ref, { logs: next });
      tx.create(auditRef(), auditEntry(caller, 'deleteProspectLog', 'prospect', prospectId, { date: entryDate, textPreview: entryText.slice(0, 200), writtenBy: entry.by || null }));
      return { status: 'deleted' };
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
      const target = await readAssignee(tx, vendedorId);
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
      if (approve) {
        if (p.estado !== 'activo') throw new ServiceError('failed-precondition', 'Solo una oportunidad activa puede autorizarse sin contrato');
        datos.autorizado_sin_contrato = true;
        datos.autorizado_por = caller.name;
        datos.autorizado_por_id = caller.cid;
      }
      const resolved = { ...cur, estado: wanted, resuelto_por_id: caller.cid, resuelto_por: caller.name || '', fecha_resolucion: iso(), motivo_decision: why || null };
      const next = list.slice(); next[at] = resolved;
      const text = approve
        ? `Autorización de venta sin contrato APROBADA por gerente ${caller.name} (solicitada por ${cur.solicitante_nombre || cur.solicitante_id})${why ? `. Motivo: ${why}` : ''}`
        : `Solicitud de venta sin contrato RECHAZADA por gerente ${caller.name} (solicitada por ${cur.solicitante_nombre || cur.solicitante_id}). Motivo: ${why}`;
      tx.update(ref, { ...(approve ? { datos } : {}), solicitudes_sin_contrato: next, logs: logsOf(p).concat([logEntry(caller, text, { auto: true })]) });
      tx.create(auditRef(), auditEntry(caller, approve ? 'approveNoContractRequest' : 'rejectNoContractRequest', 'prospect', prospectId, { requestId, solicitanteId: cur.solicitante_id, motivoDecision: why || null }));
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
      if (authorized) {
        datos.autorizado_sin_contrato = true;
        datos.autorizado_por = caller.name;
        datos.autorizado_por_id = caller.cid;
      } else {
        datos.autorizado_sin_contrato = false;
        delete datos.autorizado_por;
        delete datos.autorizado_por_id;
      }
      const text = authorized
        ? `Autorización de venta sin contrato otorgada por gerente: ${caller.name}`
        : `Autorización de venta sin contrato revocada por gerente: ${caller.name}`;
      const patch = { datos, logs: logsOf(p).concat([logEntry(caller, text, { auto: true })]) };
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

  const kit = { col, iso, now, logEntry, logsOf, auditEntry, auditRef, hasEnteredPostclosing, canAccessProspect, requireProspectAccess, requireNotDeleted, requirePrivileged, requireManager, names };
  return { names, kit, hasEnteredPostclosing, createProspect, addLog, deleteLog, reassign, setNoContractAuthorization, requestNoContractAuthorization, resolveNoContractAuthorization, updateSettings, deleteClient };
}

module.exports = { createCommercialService, namesFor, SETTINGS_LISTS, SETTINGS_ACTIONS, validators: { bad, asObject, reqString, reqDocId, reqOpId, DOC_ID_RE, OP_ID_RE, MAX_LOGS } };
