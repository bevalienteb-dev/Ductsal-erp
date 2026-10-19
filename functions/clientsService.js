// functions/clientsService.js
// Server-side logic for the client catalogue: duplicate-safe creation / edition, catalogue search and the
// derived `visibleTo` portfolio field. No dependency on firebase-functions: errors are ServiceError(code, message)
// and index.js maps them to HttpsError. Everything is injected, so the SAME code runs against the Firestore
// emulator (isolated tests) and in the deployed function.
//
// Duplicate strategy (see CLIENT_CATALOG_AND_DEDUPE.md):
//   1. scan of the existing clients (covers historical clients that are not indexed yet) -> exact / review matches;
//   2. one Firestore transaction that claims `clientIdentifiers_*/{NIT_x|DUI_x}` documents with create-if-absent
//      semantics and creates the client in the same commit -> two concurrent requests for the same document can
//      never both succeed. A stale index entry (its client was deleted) is reclaimed.
//   The browser only ever gets the verdict; it cannot write clients (rules) nor the index (rules).

const crypto = require('crypto');
const id = require('./clientIdentity');

class ServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'ServiceError'; this.code = code; }
}

const CRM_ROLES = ['manager', 'gestor', 'vendedor'];
const PRIVILEGED = ['manager', 'gestor'];

const COMMON_FIELDS = ['tipo', 'telefono', 'correo', 'correo_fact'];
const NATURAL_FIELDS = ['nombres', 'apellidos', 'dui', 'nit', 'profesion', 'domicilio'];
const JURIDICA_FIELDS = ['empresa', 'contacto', 'nit', 'nrc', 'rep_legal', 'profesion_rep', 'domicilio_rep', 'dui_rep', 'nit_rep'];
const BOOLEAN_FIELDS = ['es_exportacion', 'is_gran_contribuyente'];
const DOC_KEYS = ['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui'];
const STRING_FIELDS = Array.from(new Set([...COMMON_FIELDS, ...NATURAL_FIELDS, ...JURIDICA_FIELDS]));
const MAX_STR = 500;

function namesFor(suffix) {
  return {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    users: `users${suffix}`,
    identifiers: `clientIdentifiers${suffix}`,
    ops: `clientOps${suffix}`,
    reservations: `client_reservations${suffix}`
  };
}

const str = v => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));
const isHttpUrl = u => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) && u.length <= 2000;

function sanitizeDocumento(v) {
  if (typeof v === 'string') return isHttpUrl(v) ? v : null;
  if (Array.isArray(v)) {
    const arr = v.map(sanitizeDocumento).filter(Boolean);
    return arr.length > 0 ? arr : null;
  }
  if (v && typeof v === 'object') {
    const isUrlValid = isHttpUrl(v.url);
    const rawPath = typeof v.storagePath === 'string' ? str(v.storagePath) : (typeof v.path === 'string' ? str(v.path) : '');
    const isPathValid = rawPath && !rawPath.includes('..') && !rawPath.includes('//') && !rawPath.includes('\\') &&
      /^(prod_files|local_files)\/(clients|clientes)\//.test(rawPath);
    if (!isUrlValid && !isPathValid) return null;
    const doc = { name: str(v.name).slice(0, 200) || 'Documento' };
    if (isUrlValid) doc.url = v.url;
    if (isPathValid) {
      doc.storagePath = rawPath;
      if (typeof v.path === 'string' && v.path.length <= 500) doc.path = str(v.path);
    } else if (typeof v.path === 'string' && v.path.length <= 500) {
      doc.path = str(v.path);
    }
    if (typeof v.bucket === 'string' && v.bucket.length <= 200) doc.bucket = str(v.bucket);
    if (typeof v.size === 'number' && Number.isFinite(v.size)) doc.size = v.size;
    if (typeof v.contentType === 'string' && v.contentType.length <= 100) doc.contentType = str(v.contentType);
    return doc;
  }
  return null;
}

// Allow-list. Anything else (createdBy, id, fecha_creacion, visibleTo, authUid ...) is ignored: it is never taken from the browser.
function sanitizeClient(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError('invalid-argument', 'Datos de cliente inválidos');
  const c = {};
  for (const k of STRING_FIELDS) if (raw[k] !== undefined) c[k] = str(raw[k]).slice(0, MAX_STR);
  for (const k of BOOLEAN_FIELDS) if (typeof raw[k] === 'boolean') c[k] = raw[k];
  if (raw.documentos && typeof raw.documentos === 'object' && !Array.isArray(raw.documentos)) {
    c.documentos = {};
    for (const k of Object.keys(raw.documentos)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(k)) continue;
      const val = raw.documentos[k];
      if (val === undefined || val === null) continue;
      const d = sanitizeDocumento(val);
      if (!d) {
        throw new ServiceError('invalid-argument', `Documento o ruta de almacenamiento inválida en '${k}'`);
      }
      c.documentos[k] = d;
    }
  }
  if (c.tipo !== 'natural' && c.tipo !== 'juridica') throw new ServiceError('invalid-argument', 'Debes seleccionar el Tipo de Persona.');
  if (c.tipo === 'natural' && (!c.nombres || !c.apellidos)) throw new ServiceError('invalid-argument', 'Nombres y Apellidos obligatorios.');
  if (c.tipo === 'juridica' && (!c.empresa || !c.contacto)) throw new ServiceError('invalid-argument', 'Nombre de la Empresa y del Contacto Principal obligatorios.');
  if (!c.telefono && !c.correo) throw new ServiceError('invalid-argument', 'Debe ingresar obligatoriamente un teléfono o correo.');
  return c;
}

function docRefKey(item) {
  if (!item) return '';
  if (typeof item === 'string') {
    const u = item.trim();
    return u ? `url:${u}` : '';
  }
  if (typeof item === 'object') {
    const rawPath = typeof item.storagePath === 'string'
      ? item.storagePath.trim()
      : (typeof item.path === 'string' ? item.path.trim() : '');
    if (rawPath) return `path:${rawPath}`;
    if (typeof item.url === 'string' && item.url.trim()) return `url:${item.url.trim()}`;
  }
  return `hash:${stableHash(item)}`;
}

function countDocKeys(items) {
  const counts = new Map();
  if (!Array.isArray(items)) return counts;
  for (const it of items) {
    if (!it) continue;
    if (!sanitizeDocumento(it)) continue;
    const key = docRefKey(it);
    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

// Removing a document from a client's file or substituting elements in arrays is a MANAGER operation,
// enforced here on the server. Values the sanitiser already discards are not counted as removals.
function assertDocumentRemovalAllowed(caller, existingDocs, incomingDocs) {
  if (caller && caller.role === 'manager') return;
  if (!existingDocs || typeof existingDocs !== 'object' || Array.isArray(existingDocs)) return;

  const hasAnyValidExisting = Object.keys(existingDocs).some(k => sanitizeDocumento(existingDocs[k]) !== null);
  if (!hasAnyValidExisting) return;

  if (!incomingDocs || typeof incomingDocs !== 'object' || Array.isArray(incomingDocs)) {
    throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
  }

  for (const k of Object.keys(existingDocs)) {
    const existVal = existingDocs[k];
    if (sanitizeDocumento(existVal) === null) continue;

    const hasIncoming = (k in incomingDocs) && incomingDocs[k] !== undefined && incomingDocs[k] !== null;
    if (!hasIncoming) {
      throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
    }

    const incomingVal = incomingDocs[k];

    if (Array.isArray(existVal)) {
      if (!Array.isArray(incomingVal)) {
        throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
      }
      const existCounts = countDocKeys(existVal);
      const incomingCounts = countDocKeys(incomingVal);
      for (const [refKey, count] of existCounts.entries()) {
        const incCount = incomingCounts.get(refKey) || 0;
        if (incCount < count) {
          throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
        }
      }
    } else {
      if (Array.isArray(incomingVal) && incomingVal.length === 0) {
        throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
      }
    }
  }
}

function resolveDocumentsForUpdate(caller, existingDocs, rawDocs, baseDocs) {
  if (rawDocs === undefined) return existingDocs ? { ...existingDocs } : undefined;
  if (!rawDocs || typeof rawDocs !== 'object' || Array.isArray(rawDocs)) {
    throw new ServiceError('invalid-argument', 'Formato de documentos inválido');
  }
  const cur = (existingDocs && typeof existingDocs === 'object' && !Array.isArray(existingDocs)) ? existingDocs : {};
  const hasBase = (baseDocs !== undefined && baseDocs !== null && typeof baseDocs === 'object' && !Array.isArray(baseDocs));
  const base = hasBase ? baseDocs : cur;

  // Authorization check: non-manager cannot remove or substitute existing valid documents
  assertDocumentRemovalAllowed(caller, base, rawDocs);
  if (!hasBase) {
    assertDocumentRemovalAllowed(caller, cur, rawDocs);
  }

  const allKeys = new Set([...Object.keys(cur), ...Object.keys(rawDocs), ...Object.keys(base)]);
  const resolved = {};

  for (const k of allKeys) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(k)) continue;

    const inRaw = (k in rawDocs) && rawDocs[k] !== undefined && rawDocs[k] !== null;
    const inBase = (k in base) && base[k] !== undefined && base[k] !== null;
    const inCur = (k in cur) && cur[k] !== undefined && cur[k] !== null;

    const rawVal = inRaw ? rawDocs[k] : undefined;
    const baseVal = inBase ? base[k] : undefined;
    const curVal = inCur ? cur[k] : undefined;

    // 1. Untouched key: not in rawDocs and not in base
    if (!inRaw && !inBase) {
      if (inCur) {
        // Concurrently added by another user: preserve it
        resolved[k] = curVal;
      }
      continue;
    }

    // 2. Unmodified by current user: rawVal matches baseVal
    if (inRaw && inBase && stableHash(rawVal) === stableHash(baseVal)) {
      if (inCur) {
        // Keep live Firestore version
        resolved[k] = curVal;
      }
      // If !inCur, another user legitimately deleted it concurrently: do NOT resurrect!
      continue;
    }

    // 3. Intentionally removed by current user: inBase is true, but !inRaw
    if (inBase && !inRaw) {
      if (inCur && sanitizeDocumento(curVal) && (!caller || caller.role !== 'manager')) {
        throw new ServiceError('permission-denied', 'Solo el gerente puede eliminar documentos del expediente');
      }
      // Allowed deletion: omit from resolved
      continue;
    }

    // 4. Intentionally added or modified by current user
    // Fast path: unchanged from current live version
    if (inCur && stableHash(rawVal) === stableHash(curVal)) {
      resolved[k] = curVal;
      continue;
    }

    if (Array.isArray(rawVal)) {
      const existingArray = Array.isArray(curVal) ? curVal : [];
      const baseArray = Array.isArray(baseVal) ? baseVal : [];
      const resolvedArray = [];

      for (const item of rawVal) {
        if (item === undefined || item === null) continue;
        const matchCur = existingArray.find(ex => docRefKey(ex) === docRefKey(item) || stableHash(ex) === stableHash(item));
        if (matchCur) {
          resolvedArray.push(matchCur);
          continue;
        }
        const sanitized = sanitizeDocumento(item);
        if (!sanitized) {
          throw new ServiceError('invalid-argument', `Documento o ruta de almacenamiento inválida en '${k}'`);
        }
        resolvedArray.push(sanitized);
      }

      // Preserve concurrent additions in curVal that were not in baseArray
      if (hasBase && Array.isArray(curVal)) {
        const baseKeys = new Set(baseArray.map(docRefKey));
        const resKeys = new Set(resolvedArray.map(docRefKey));
        for (const curItem of curVal) {
          const key = docRefKey(curItem);
          if (key && !baseKeys.has(key) && !resKeys.has(key)) {
            resolvedArray.push(curItem);
          }
        }
      }

      if (resolvedArray.length > 0) {
        resolved[k] = resolvedArray;
      }
      continue;
    }

    // Single document
    if (inCur && (docRefKey(rawVal) === docRefKey(curVal) || stableHash(rawVal) === stableHash(curVal))) {
      resolved[k] = curVal;
      continue;
    }

    const sanitized = sanitizeDocumento(rawVal);
    if (!sanitized) {
      throw new ServiceError('invalid-argument', `Documento o ruta de almacenamiento inválida en '${k}'`);
    }
    resolved[k] = sanitized;
  }

  return resolved;
}

function stableHash(obj) {
  const sort = v => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((a, k) => (a[k] = sort(v[k]), a), {}) : v;
  return crypto.createHash('sha256').update(JSON.stringify(sort(obj))).digest('hex');
}

function createClientsService({ db, FieldValue, suffix, now = () => new Date(), newId = () => 'C' + Date.now(), cacheTtlMs = 30000 }) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  const names = namesFor(suffix);
  const col = n => db.collection(names[n]);
  let catalogCache = null; // { at, list }

  // ---------- caller ----------
  // The role comes from the CRM profile, never from the request. A profile must be linked to this Auth account,
  // active and have a CRM role. A manager additionally needs the verified `manager` claim (same rule as assertManager).
  async function resolveCaller(context) {
    if (!context || !context.auth || !context.auth.uid) throw new ServiceError('unauthenticated', 'Authentication required');
    const uid = context.auth.uid;
    const token = context.auth.token || {};
    let profile = null;
    if (token.cid) {
      const snap = await col('users').doc(String(token.cid)).get();
      if (snap.exists) profile = { ...snap.data(), docId: snap.id };
    } else {
      const q = await col('users').where('authUid', '==', uid).limit(2).get();
      if (q.size === 1) profile = { ...q.docs[0].data(), docId: q.docs[0].id };
    }
    const deny = () => new ServiceError('permission-denied', 'Se requiere un usuario activo del CRM vinculado a esta sesión');
    if (!profile || profile.authUid !== uid || profile.activo !== true || !CRM_ROLES.includes(profile.role)) throw deny();
    if (profile.role === 'manager' && token.manager !== true) throw deny();
    return { uid, cid: profile.docId, role: profile.role, name: profile.nombre || '' };
  }

  // ---------- reads ----------
  const PROJECTION = ['tipo', 'nombres', 'apellidos', 'empresa', 'contacto', 'nit', 'dui', 'telefono', 'correo', 'createdBy'];
  async function listClientsFresh() {
    const snap = await col('clients').select(...PROJECTION).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function listClientsCached() {
    const t = now().getTime();
    if (catalogCache && t - catalogCache.at < cacheTtlMs) return catalogCache.list;
    const list = await listClientsFresh();
    catalogCache = { at: t, list };
    return list;
  }
  const invalidateCache = () => { catalogCache = null; };

  async function portfolioIds(caller) {
    const set = new Set();
    if (PRIVILEGED.includes(caller.role)) return null; // null = everything
    // Logically deleted opportunities (`eliminado: true`) no longer open a client to the seller (as when they were removed).
    const [a, b] = await Promise.all([
      col('prospects').where('createdBy', '==', caller.cid).select('clientId', 'eliminado').get(),
      col('prospects').where('vendedorId', '==', caller.cid).select('clientId', 'eliminado').get()
    ]);
    a.docs.concat(b.docs).forEach(d => { const x = d.data(); if (x.eliminado !== true && x.clientId) set.add(x.clientId); });
    return set;
  }
  const inPortfolio = (caller, portfolio, c) => portfolio === null || c.createdBy === caller.cid || portfolio.has(c.id);

  const publicMatch = (caller, portfolio, byId, m) => {
    const c = byId.get(m.clientId) || {};
    return {
      clientId: m.clientId, level: m.level, reasons: m.reasons,
      nombre: id.displayName(c), tipo: c.tipo || '', hint: id.identifierHint(c),
      inPortfolio: inPortfolio(caller, portfolio, { ...c, id: m.clientId })
    };
  };

  // ---------- check / create ----------
  async function evaluate(caller, candidate, { ignoreId, onlyKeys } = {}) {
    const existing = await listClientsFresh();
    const byId = new Map(existing.map(c => [c.id, c]));
    let matches = id.findMatches(candidate, existing, ignoreId);
    if (onlyKeys) {
      // Edition: an exact match only blocks for a document the user is NEWLY claiming. A historical duplicate on an
      // UNCHANGED document is not this edit's problem: it is downgraded to a review warning instead of blocking.
      const ids = id.identifiersOf(candidate);
      const relevant = m => (m.reasons.includes('nit') && onlyKeys.has(ids.nit.key)) || (m.reasons.includes('dui') && onlyKeys.has(ids.dui.key));
      matches = matches.map(m => (m.level === 'exact' && !relevant(m)) ? { ...m, level: 'review' } : m);
    }

    const portfolio = await portfolioIds(caller);
    const pub = matches.map(m => publicMatch(caller, portfolio, byId, m));
    return { pub, exact: pub.filter(m => m.level === 'exact'), review: pub.filter(m => m.level === 'review') };
  }

  async function create({ caller, client: raw, opId, confirmReview = false, dryRun = false }) {
    const client = sanitizeClient(raw);
    const warnings = id.formatWarnings(client);
    if (!dryRun && !(typeof opId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(opId))) throw new ServiceError('invalid-argument', 'opId requerido');
    const payloadHash = stableHash(client);
    const opRef = dryRun ? null : col('ops').doc(opId);

    if (opRef) {
      const prev = await opRef.get();
      if (prev.exists) return replayOf(prev.data(), payloadHash, caller);
    }

    const ev = await evaluate(caller, client);
    if (ev.exact.length) return { status: 'duplicate', matches: ev.pub, warnings };
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    if (dryRun) return { status: 'ok', matches: ev.pub, warnings };

    const keys = id.keysOf(client);
    const result = await db.runTransaction(async tx => {
      const opSnap = await tx.get(opRef);
      if (opSnap.exists) return { replay: opSnap.data() };

      // 1) every read before the first write
      const owners = [];
      for (const k of keys) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists) {
          const owner = await tx.get(col('clients').doc(idx.data().clientId));
          if (owner.exists) owners.push({ key: k, clientId: owner.id, data: owner.data() });
        }
      }
      if (owners.length) return { conflict: owners };

      let clientId = newId();
      for (let i = 0; i < 10; i++) {
        const taken = await tx.get(col('clients').doc(clientId));
        if (!taken.exists) break;
        clientId = 'C' + String(Number(clientId.slice(1)) + 1);
      }

      // 2) writes
      const doc = {
        ...client,
        id: clientId,
        createdBy: caller.cid,
        fecha_creacion: now().toISOString()
      };
      if (!doc.documentos) doc.documentos = {};
      tx.create(col('clients').doc(clientId), doc);
      for (const k of keys) {
        tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      }
      tx.create(opRef, { kind: 'create', status: 'succeeded', clientId, payloadHash, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      return { created: doc };
    });

    if (result.replay) return replayOf(result.replay, payloadHash, caller);
    if (result.conflict) {
      // Lost a race against a concurrent creation of the same document: report the winner.
      const byId = new Map(result.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = result.conflict.map(o => publicMatch(caller, portfolio, byId, { clientId: o.clientId, level: 'exact', reasons: [o.key.split('_')[0].toLowerCase()] }));
      return { status: 'duplicate', matches, warnings };
    }
    invalidateCache();
    return { status: 'created', client: result.created, matches: ev.pub, warnings };
  }

  function replayOf(op, payloadHash, caller) {
    if (op.payloadHash !== payloadHash) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
    if (op.createdBy !== caller.cid) throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
    return { status: 'created', replay: true, client: { id: op.clientId }, matches: [], warnings: [] };
  }

  // ---------- client creation reservations (two-step upload authorization) ----------
  const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  async function reserveCreation({ caller, client: raw, confirmReview = false }) {
    const client = sanitizeClient(raw);
    const warnings = id.formatWarnings(client);
    const ev = await evaluate(caller, client);
    if (ev.exact.length) return { status: 'duplicate', matches: ev.pub, warnings };
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };

    const keys = id.keysOf(client);
    const expiresMs = now().getTime() + RESERVATION_TTL_MS;
    const expiresDate = new Date(expiresMs);

    const outcome = await db.runTransaction(async tx => {
      const owners = [];
      for (const k of keys) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists) {
          const owner = await tx.get(col('clients').doc(idx.data().clientId));
          if (owner.exists) owners.push({ key: k, clientId: owner.id, data: owner.data() });
        }
      }
      if (owners.length) return { conflict: owners };

      let reservationId = newId();
      for (let i = 0; i < 10; i++) {
        const takenClient = await tx.get(col('clients').doc(reservationId));
        const takenRes = await tx.get(col('reservations').doc(reservationId));
        if (!takenClient.exists && !takenRes.exists) break;
        reservationId = 'C' + String(Number(reservationId.slice(1)) + 1);
      }

      const resDoc = {
        id: reservationId,
        clientId: reservationId,
        createdBy: caller.cid,
        authUid: caller.uid,
        tipo: client.tipo,
        keys,
        status: 'reserved',
        createdAt: now().toISOString(),
        expiresAt: expiresDate,
        expiresAtMs: expiresMs,
        expiresAtIso: expiresDate.toISOString()
      };

      tx.create(col('reservations').doc(reservationId), resDoc);
      return { reservation: resDoc };
    });

    if (outcome.conflict) {
      const byId = new Map(outcome.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = outcome.conflict.map(o => publicMatch(caller, portfolio, byId, { clientId: o.clientId, level: 'exact', reasons: [o.key.split('_')[0].toLowerCase()] }));
      return { status: 'duplicate', matches, warnings };
    }

    return {
      status: 'reserved',
      reservationId: outcome.reservation.id,
      clientId: outcome.reservation.clientId,
      expiresAt: outcome.reservation.expiresAtIso,
      expiresAtMs: outcome.reservation.expiresAtMs,
      matches: ev.pub,
      warnings
    };
  }

  async function cancelReservation({ caller, reservationId }) {
    if (typeof reservationId !== 'string' || !reservationId) throw new ServiceError('invalid-argument', 'reservationId requerido');
    const resRef = col('reservations').doc(reservationId);
    const snap = await resRef.get();
    if (!snap.exists) throw new ServiceError('not-found', 'Reserva no encontrada');
    const resData = snap.data();
    if (resData.createdBy !== caller.cid && !PRIVILEGED.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'No puedes cancelar una reserva de otro usuario');
    }
    if (resData.status !== 'reserved') {
      return { status: resData.status, reservationId };
    }
    await resRef.update({
      status: 'cancelled',
      cancelledAt: now().toISOString(),
      cancelledBy: caller.cid
    });
    return { status: 'cancelled', reservationId };
  }

  async function finalizeCreation({ caller, reservationId, client: raw, opId, confirmReview = false }) {
    if (typeof reservationId !== 'string' || !reservationId) throw new ServiceError('invalid-argument', 'reservationId requerido');
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(opId)) throw new ServiceError('invalid-argument', 'opId requerido');
    const client = sanitizeClient(raw);
    const warnings = id.formatWarnings(client);
    const payloadHash = stableHash({ reservationId, client });
    const opRef = col('ops').doc(opId);

    const prevOp = await opRef.get();
    if (prevOp.exists) return replayOf(prevOp.data(), payloadHash, caller);

    const ev = await evaluate(caller, client, { ignoreId: reservationId });
    if (ev.exact.length) return { status: 'duplicate', matches: ev.pub, warnings };
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };

    const keys = id.keysOf(client);
    const result = await db.runTransaction(async tx => {
      const opSnap = await tx.get(opRef);
      if (opSnap.exists) return { replay: opSnap.data() };

      const resRef = col('reservations').doc(reservationId);
      const resSnap = await tx.get(resRef);
      if (!resSnap.exists) throw new ServiceError('not-found', 'Reserva no encontrada');
      const resData = resSnap.data();

      if (resData.createdBy !== caller.cid) {
        throw new ServiceError('permission-denied', 'La reserva pertenece a otro usuario');
      }
      if (resData.status === 'cancelled') {
        throw new ServiceError('failed-precondition', 'La reserva fue cancelada');
      }
      if (resData.status === 'finalized') {
        throw new ServiceError('failed-precondition', 'La reserva ya fue formalizada');
      }
      if (resData.status !== 'reserved') {
        throw new ServiceError('failed-precondition', `Estado de reserva no válido: ${resData.status}`);
      }

      const expMs = resData.expiresAtMs || (resData.expiresAt && resData.expiresAt.toMillis ? resData.expiresAt.toMillis() : new Date(resData.expiresAt).getTime());
      if (now().getTime() > expMs) {
        throw new ServiceError('failed-precondition', 'La reserva ha caducado');
      }

      const existingClientSnap = await tx.get(col('clients').doc(reservationId));
      if (existingClientSnap.exists) {
        throw new ServiceError('already-exists', 'El cliente ya existe');
      }

      const owners = [];
      for (const k of keys) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists && idx.data().clientId !== reservationId) {
          const owner = await tx.get(col('clients').doc(idx.data().clientId));
          if (owner.exists) owners.push({ key: k, clientId: owner.id, data: owner.data() });
        }
      }
      if (owners.length) return { conflict: owners };

      const doc = {
        ...client,
        id: reservationId,
        createdBy: caller.cid,
        fecha_creacion: now().toISOString(),
        visibleTo: [caller.cid],
        closingVendors: []
      };
      if (!doc.documentos) doc.documentos = {};

      tx.create(col('clients').doc(reservationId), doc);
      for (const k of keys) {
        tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId: reservationId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      }
      tx.update(resRef, {
        status: 'finalized',
        finalizedAt: now().toISOString(),
        finalizedBy: caller.cid
      });
      tx.create(opRef, { kind: 'finalize', status: 'succeeded', clientId: reservationId, reservationId, payloadHash, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      return { created: doc };
    });

    if (result.replay) return replayOf(result.replay, payloadHash, caller);
    if (result.conflict) {
      const byId = new Map(result.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = result.conflict.map(o => publicMatch(caller, portfolio, byId, { clientId: o.clientId, level: 'exact', reasons: [o.key.split('_')[0].toLowerCase()] }));
      return { status: 'duplicate', matches, warnings };
    }

    invalidateCache();
    return { status: 'created', client: result.created, matches: ev.pub, warnings };
  }

  // ---------- update ----------
  async function isRelated(caller, clientId) {
    const portfolio = await portfolioIds(caller);
    return portfolio === null || portfolio.has(clientId);
  }

  async function update({ caller, id: clientId, client: raw, confirmReview = false, dryRun = false }) {
    if (typeof clientId !== 'string' || !clientId) throw new ServiceError('invalid-argument', 'id requerido');
    const incoming = sanitizeClient({ ...raw, documentos: undefined });
    const ref = col('clients').doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) throw new ServiceError('not-found', 'Cliente no encontrado');
    const existing = snap.data();
    if (!PRIVILEGED.includes(caller.role) && existing.createdBy !== caller.cid && !(await isRelated(caller, clientId))) {
      throw new ServiceError('permission-denied', 'No tienes acceso a este cliente');
    }
    const incomingDocs = resolveDocumentsForUpdate(caller, existing.documentos, raw ? raw.documentos : undefined, raw ? raw.baseDocumentos : undefined);
    if (incomingDocs !== undefined) incoming.documentos = incomingDocs;

    const merged = { ...existing, ...incoming };
    if (incoming.documentos) merged.documentos = incoming.documentos;
    const oldKeys = id.keysOf({ ...existing, id: clientId });
    const newKeys = id.keysOf(merged);
    const toClaim = newKeys.filter(k => !oldKeys.includes(k));
    const toRelease = oldKeys.filter(k => !newKeys.includes(k));
    const nameChanged = id.displayName(existing) !== id.displayName(merged);
    const warnings = id.formatWarnings(merged);

    let pub = [];
    if (toClaim.length || nameChanged) {
      const ev = await evaluate(caller, merged, { ignoreId: clientId, onlyKeys: new Set(toClaim) });
      pub = ev.pub;
      if (ev.exact.length) return { status: 'duplicate', matches: ev.pub, warnings };
      if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    }
    if (dryRun) return { status: 'ok', matches: pub, warnings };

    const outcome = await db.runTransaction(async tx => {
      const cur = await tx.get(ref);
      if (!cur.exists) throw new ServiceError('not-found', 'Cliente no encontrado');
      const curData = cur.data();
      const txDocs = resolveDocumentsForUpdate(caller, curData.documentos, raw ? raw.documentos : undefined, raw ? raw.baseDocumentos : undefined);
      const claims = [];
      for (const k of toClaim) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists && idx.data().clientId !== clientId) {
          const owner = await tx.get(col('clients').doc(idx.data().clientId));
          if (owner.exists) return { conflict: [{ key: k, clientId: owner.id, data: owner.data() }] };
        }
        claims.push(k);
      }
      const releases = [];
      for (const k of toRelease) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists && idx.data().clientId === clientId) releases.push(k);
      }
      const doc = { ...curData, ...incoming, id: clientId, createdBy: curData.createdBy };
      if (txDocs !== undefined) doc.documentos = txDocs;
      else if (curData.documentos !== undefined) doc.documentos = curData.documentos;
      if (curData.fecha_creacion !== undefined) doc.fecha_creacion = curData.fecha_creacion;
      if (curData.visibleTo !== undefined) doc.visibleTo = curData.visibleTo;
      tx.set(ref, doc);
      for (const k of claims) tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      for (const k of releases) tx.delete(col('identifiers').doc(k));
      return { updated: doc };
    });
    if (outcome.conflict) {
      const byId = new Map(outcome.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      return { status: 'duplicate', warnings, matches: outcome.conflict.map(o => publicMatch(caller, portfolio, byId, { clientId: o.clientId, level: 'exact', reasons: [o.key.split('_')[0].toLowerCase()] })) };
    }
    invalidateCache();
    return { status: 'updated', client: outcome.updated, matches: pub, warnings };
  }

  // ---------- catalogue search (selector of new opportunities) ----------
  // Returns at most `limit` entries with the minimum needed to choose a client: id, display name, type and a MASKED
  // document hint. No phone, e-mail, owner or document numbers. Scanning happens on the server (short cache), never in the browser.
  async function search({ caller, q, limit = 20 }) {
    const text = id.foldText(q);
    const digits = /[a-z]/.test(text) ? '' : id.onlyDigits(q);
    // a numeric query is a document search and needs 4 digits; a text query needs 2 letters
    if (digits ? digits.length < 4 : text.length < 2) return { results: [], tooShort: true, truncated: false };
    const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const qTokens = text.split(' ').filter(Boolean);
    const list = await listClientsCached();
    const portfolio = await portfolioIds(caller);
    const scored = [];
    for (const c of list) {
      const full = id.foldText(id.displayName(c));
      if (!full) continue;
      const tokens = full.split(' ');
      let score = 0;
      if (digits) {
        const ids = id.identifiersOf(c);
        if ((ids.nit.digits && ids.nit.digits.includes(digits)) || (ids.dui.digits && ids.dui.digits.includes(digits))) score = 2;
      } else if (qTokens.every(t => tokens.some(w => w.startsWith(t)))) {
        score = full.startsWith(text) ? 3 : 2;
      }
      if (score) scored.push({ c, score, full });
    }
    scored.sort((a, b) => b.score - a.score || a.full.localeCompare(b.full));
    return {
      results: scored.slice(0, max).map(({ c }) => ({
        id: c.id, nombre: id.displayName(c), tipo: c.tipo || '', hint: id.identifierHint(c), inPortfolio: inPortfolio(caller, portfolio, c)
      })),
      tooShort: false,
      truncated: scored.length > max
    };
  }

  // ---------- derived visibility (`visibleTo` and `closingVendors`) ----------
  // The creator of the client is covered by `createdBy`; `visibleTo` lists the commercial ids that created or are
  // assigned to an opportunity of the client. `closingVendors` lists those with an active opportunity in `cierre`.
  // Written ONLY here (Admin SDK); the rules forbid every client write to it.
  async function recomputeVisibility(clientIds) {
    const done = [];
    for (const clientId of Array.from(new Set((clientIds || []).filter(Boolean)))) {
      const ref = col('clients').doc(String(clientId));
      const [snap, ps] = await Promise.all([
        ref.get(),
        col('prospects').where('clientId', '==', clientId).select('createdBy', 'vendedorId', 'eliminado', 'etapa', 'estado').get()
      ]);
      if (!snap.exists) continue;
      const set = new Set();
      const closingSet = new Set();
      ps.docs.forEach(d => {
        const p = d.data();
        if (p.eliminado === true) return;
        [p.createdBy, p.vendedorId].forEach(v => {
          if (v && v !== 'sistema') {
            set.add(String(v));
            if (p.etapa === 'cierre' && p.estado !== 'perdido') {
              closingSet.add(String(v));
            }
          }
        });
      });
      const next = Array.from(set).sort();
      const nextClosing = Array.from(closingSet).sort();
      const cur = Array.isArray(snap.data().visibleTo) ? [...snap.data().visibleTo].sort() : null;
      const curClosing = Array.isArray(snap.data().closingVendors) ? [...snap.data().closingVendors].sort() : null;

      const visChanged = (cur === null && next.length > 0) || (cur && (cur.length !== next.length || !cur.every((v, i) => v === next[i])));
      const closeChanged = (curClosing === null && nextClosing.length > 0) || (curClosing && (curClosing.length !== nextClosing.length || !curClosing.every((v, i) => v === nextClosing[i])));

      if (!visChanged && !closeChanged) continue;
      const patch = {};
      if (visChanged) patch.visibleTo = next;
      if (closeChanged) patch.closingVendors = nextClosing;
      await ref.update(patch);
      done.push({ clientId, visibleTo: next, closingVendors: nextClosing });
    }
    return done;
  }

  // Trigger entry point: both the previous and the new clientId must be recomputed (a reassignment can move a client).
  async function onProspectWrite(before, after) {
    return recomputeVisibility([before && before.clientId, after && after.clientId]);
  }

  async function backfillVisibility({ apply = false } = {}) {
    const ps = await col('prospects').select('clientId').get();
    const ids = Array.from(new Set(ps.docs.map(d => d.data().clientId).filter(Boolean)));
    if (!apply) return { planned: ids.length, applied: 0 };
    const done = await recomputeVisibility(ids);
    return { planned: ids.length, applied: done.length };
  }

  return {
    names, resolveCaller, create, reserveCreation, cancelReservation, finalizeCreation,
    update, search, recomputeVisibility, onProspectWrite, backfillVisibility, invalidateCache
  };
}

module.exports = { createClientsService, ServiceError, sanitizeClient, sanitizeDocumento, resolveDocumentsForUpdate, assertDocumentRemovalAllowed, docRefKey, countDocKeys, namesFor, stableHash, CRM_ROLES, PRIVILEGED };
