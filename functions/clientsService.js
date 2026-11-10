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
const { applyDocumentVersionsTx, applyDocumentVersionTx, isSameDocument, toCanonicalDocPointer } = require('./documentVersioningService');

class ServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'ServiceError'; this.code = code; }
}

const CRM_ROLES = ['manager', 'gestor', 'vendedor'];
const PRIVILEGED = ['manager', 'gestor'];

const COMMON_FIELDS = ['tipo', 'telefono', 'correo', 'correo_fact'];
const NATURAL_FIELDS = ['nombres', 'apellidos', 'dui', 'nit', 'nrc', 'profesion', 'domicilio'];
const JURIDICA_FIELDS = ['empresa', 'contacto', 'nit', 'nrc', 'rep_legal', 'profesion_rep', 'domicilio_rep', 'dui_rep', 'nit_rep'];
const BOOLEAN_FIELDS = ['es_exportacion', 'is_gran_contribuyente'];
const DOC_KEYS = ['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui'];
const STRING_FIELDS = Array.from(new Set([...COMMON_FIELDS, ...NATURAL_FIELDS, ...JURIDICA_FIELDS]));
const MAX_STR = 500;

function namesFor(suffix) {
  return {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    contacts: `contacts${suffix}`,
    accountContacts: `account_contacts${suffix}`,
    users: `users${suffix}`,
    identifiers: `clientIdentifiers${suffix}`,
    ops: `clientOps${suffix}`,
    reservations: `client_reservations${suffix}`,
    payment_refs: `payment_refs${suffix}`,
    audit: `commercialAudit${suffix}`
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
    if (typeof v.versionId === 'string' && v.versionId.length <= 120) doc.versionId = str(v.versionId);
    if (typeof v.versionNumber === 'number' && Number.isFinite(v.versionNumber)) doc.versionNumber = v.versionNumber;
    if (typeof v.actualizadoEn === 'string' && v.actualizadoEn.length <= 50) doc.actualizadoEn = str(v.actualizadoEn);
    if (typeof v.motivoSustitucion === 'string' && v.motivoSustitucion.length <= 500) doc.motivoSustitucion = str(v.motivoSustitucion);
    if (typeof v.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(v.sha256.trim())) doc.sha256 = v.sha256.trim().toLowerCase();
    if (typeof v.fechaEmision === 'string' && v.fechaEmision.length <= 30) doc.fechaEmision = str(v.fechaEmision);
    if (typeof v.fechaVencimiento === 'string' && v.fechaVencimiento.length <= 30) doc.fechaVencimiento = str(v.fechaVencimiento);
    if (typeof v.termId === 'string' && v.termId.length <= 120) doc.termId = str(v.termId);
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
  if (raw.motivosSustitucion && typeof raw.motivosSustitucion === 'object' && !Array.isArray(raw.motivosSustitucion)) {
    c.motivosSustitucion = {};
    for (const k of Object.keys(raw.motivosSustitucion)) {
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(k) && typeof raw.motivosSustitucion[k] === 'string') {
        c.motivosSustitucion[k] = str(raw.motivosSustitucion[k]).slice(0, 500);
      }
    }
  }
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

function resolveDocumentsForUpdate(caller, existingDocs, rawDocs, baseDocs, motivosSustitucion) {
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
    if (inRaw && inBase && (stableHash(rawVal) === stableHash(baseVal) || (!Array.isArray(rawVal) && !Array.isArray(baseVal) && isSameDocument(rawVal, baseVal)))) {
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

    // Check if replacing an existing valid document
    if (inCur && sanitizeDocumento(curVal) && !isSameDocument(curVal, sanitized)) {
      const motivo = (sanitized && sanitized.motivoSustitucion)
        || (motivosSustitucion && motivosSustitucion[k])
        || (rawDocs && rawDocs.motivosSustitucion && rawDocs.motivosSustitucion[k])
        || '';
      if (!motivo || !motivo.trim()) {
        throw new ServiceError('invalid-argument', `Toda sustitución de un documento existente requiere un motivo no vacío (documento: '${k}')`);
      }
      sanitized.motivoSustitucion = motivo.trim();
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

// =====================================================================================================
// B4.2 — Resolución de Identidad de Cuenta Canónica (`resolveCanonicalAccount`)
// y Autorización Centralizada (`authorizeClientAccess`)
// =====================================================================================================

const MAX_MERGE_DEPTH = 5;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isCallerActiveAndAuthenticated(caller) {
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)) return false;
  if (typeof caller.uid !== 'string' || !caller.uid.trim()) return false;
  if (typeof caller.role !== 'string' || !caller.role.trim()) return false;
  if (
    caller.activo === false ||
    caller.revoked === true ||
    caller.disabled === true ||
    caller.status === 'revoked' ||
    caller.status === 'inactive' ||
    caller.estado === 'inactivo' ||
    caller.estado === 'revocado'
  ) {
    return false;
  }
  if (caller.token && typeof caller.token === 'object') {
    if (caller.token.revoked === true || caller.token.activo === false || caller.token.disabled === true) {
      return false;
    }
    if (caller.role === 'manager' && caller.token.manager === false) {
      return false;
    }
  }
  return true;
}

/**
 * B4.2 — Única función autoritativa de autorización sobre la cuenta activa terminal.
 * Reglas:
 * - `manager`: acceso general autorizado.
 * - `gestor`: acceso general autorizado.
 * - `vendedor`: acceso autorizado únicamente si se cumple al menos una condición sobre la cuenta activa terminal:
 *     1. `canonicalClientData.createdBy === caller.cid`
 *     2. `Array.isArray(canonicalClientData.visibleTo) && canonicalClientData.visibleTo.includes(caller.cid)`
 *     3. `Array.isArray(canonicalClientData.closingVendors) && canonicalClientData.closingVendors.includes(caller.cid)`
 * - Cualquier caso fuera de estas reglas (usuario no autenticado, revocado/inactivo, rol no autorizado o cuenta intermedia no resuelta) es denegado (`false`).
 */
function authorizeClientAccess(caller, canonicalClientData) {
  if (!isCallerActiveAndAuthenticated(caller)) return false;
  if (!canonicalClientData || typeof canonicalClientData !== 'object' || Array.isArray(canonicalClientData)) {
    return false;
  }
  // Una cuenta que aún tiene puntero de fusión activo no es una cuenta terminal canónica
  if (typeof canonicalClientData.fusionada_en === 'string' && canonicalClientData.fusionada_en.trim() !== '') {
    return false;
  }

  if (caller.role === 'manager') return true;
  if (caller.role === 'gestor') return true;

  if (caller.role === 'vendedor') {
    const cid = typeof caller.cid === 'string' ? caller.cid.trim() : '';
    if (!cid) return false;
    const isCreatedBy = canonicalClientData.createdBy === cid;
    const isVisibleTo = Array.isArray(canonicalClientData.visibleTo) && canonicalClientData.visibleTo.includes(cid);
    const isClosingVendor = Array.isArray(canonicalClientData.closingVendors) && canonicalClientData.closingVendors.includes(cid);
    return Boolean(isCreatedBy || isVisibleTo || isClosingVendor);
  }

  return false;
}

/**
 * B4.2 — Resolución de identidad de cuenta canónica (`resolveCanonicalAccount`).
 * Recorre punteros `fusionada_en` hasta alcanzar la cuenta activa terminal.
 * - Profundidad máxima: 5 niveles (`MAX_MERGE_DEPTH = 5`).
 * - Detecta y rechaza ciclos (`C1 -> C2 -> C1` o `C1 -> C1`).
 * - Rechaza referencias a cuentas inexistentes (`not-found`).
 * - Preserva los identificadores históricos en `chain`.
 */
async function resolveCanonicalAccount(arg1, arg2, arg3 = {}) {
  let db = null;
  let clientsCol = null;
  let originId = null;
  let options = {};

  if (typeof arg1 === 'string') {
    originId = arg1;
    options = (arg2 && typeof arg2 === 'object') ? arg2 : {};
    db = options.db || null;
    clientsCol = options.clientsCol || null;
  } else if (arg1 && typeof arg1 === 'object') {
    originId = arg2;
    options = (arg3 && typeof arg3 === 'object') ? arg3 : {};
    if (typeof arg1.collection === 'function') {
      db = arg1;
    } else if (typeof arg1.doc === 'function') {
      clientsCol = arg1;
    } else {
      db = arg1.db || options.db || null;
      clientsCol = arg1.clientsCol || options.clientsCol || null;
    }
  }

  if (typeof originId !== 'string' || !originId.trim()) {
    throw new ServiceError('invalid-argument', 'Identificador de cuenta requerido');
  }
  const cleanOriginId = originId.trim();
  if (!ACCOUNT_ID_RE.test(cleanOriginId)) {
    throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
  }

  const suffix = options.suffix || '_prod';
  const clientsColName = options.clientsColName || `clients${suffix}`;
  const tx = options.tx || null;
  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? options.maxDepth : MAX_MERGE_DEPTH;
  const notFoundMessage = options.notFoundMessage || 'Cliente no encontrado';

  const getDocRef = (docId) => {
    if (clientsCol && typeof clientsCol.doc === 'function') {
      return clientsCol.doc(docId);
    }
    if (db && typeof db.collection === 'function') {
      return db.collection(clientsColName).doc(docId);
    }
    throw new Error('resolveCanonicalAccount requires db or clientsCol');
  };

  const readSnap = async (docId) => {
    const ref = getDocRef(docId);
    return tx ? tx.get(ref) : ref.get();
  };

  const chain = [];
  const chainSnaps = [];
  const visited = new Set([cleanOriginId]);
  let currentId = cleanOriginId;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const snap = await readSnap(currentId);
    if (!snap || !snap.exists) {
      if (depth === 0) {
        throw new ServiceError('not-found', notFoundMessage);
      }
      throw new ServiceError('not-found', `Cuenta destino de fusión '${currentId}' no encontrada`);
    }

    const data = snap.data() || {};
    chain.push(currentId);
    chainSnaps.push(snap);

    const rawTarget = data.fusionada_en;
    if (rawTarget === undefined || rawTarget === null || (typeof rawTarget === 'string' && rawTarget.trim() === '')) {
      return {
        originId: cleanOriginId,
        originSnap: chainSnaps[0],
        originData: chainSnaps[0].data() || {},
        canonicalId: currentId,
        canonicalSnap: snap,
        canonicalData: data,
        chain,
        chainSnaps,
        depth,
        isMerged: chain.length > 1
      };
    }

    if (typeof rawTarget !== 'string' || !ACCOUNT_ID_RE.test(rawTarget.trim())) {
      throw new ServiceError('failed-precondition', `Referencia de cuenta fusionada inválida en '${currentId}'`);
    }
    const nextId = rawTarget.trim();

    if (visited.has(nextId)) {
      throw new ServiceError(
        'failed-precondition',
        `Ciclo detectado en la cadena de fusión de cuentas: ${[...chain, nextId].join(' -> ')}`
      );
    }

    if (depth >= maxDepth) {
      throw new ServiceError(
        'failed-precondition',
        `La cadena de fusión de cuentas excede la profundidad máxima permitida (${maxDepth} niveles)`
      );
    }

    visited.add(nextId);
    currentId = nextId;
  }

  throw new ServiceError(
    'failed-precondition',
    `La cadena de fusión de cuentas excede la profundidad máxima permitida (${maxDepth} niveles)`
  );
}

function createClientsService({ db, FieldValue, suffix, verifyManager = async () => true, now = () => new Date(), newId = () => 'C' + Date.now(), cacheTtlMs = 30000 }) {
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
  const PROJECTION = ['tipo', 'nombres', 'apellidos', 'empresa', 'contacto', 'nit', 'nrc', 'dui', 'telefono', 'correo', 'createdBy', 'visibleTo', 'closingVendors', 'fusionada_en'];
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
  const inPortfolio = (caller, portfolio, c) => {
    if (!c) return false;
    if (authorizeClientAccess(caller, c)) return true;
    return portfolio === null || c.createdBy === caller.cid || (c.id ? portfolio.has(c.id) : false);
  };

  function resolveCanonicalFromMapSync(byId, originId) {
    if (!originId || !byId.has(originId)) return { canonicalId: originId, canonicalClient: byId.get(originId) || null, chain: [originId], isMerged: false };
    const visited = new Set([originId]);
    const chain = [];
    let currentId = originId;
    for (let depth = 0; depth <= MAX_MERGE_DEPTH; depth++) {
      const cur = byId.get(currentId);
      if (!cur) {
        const lastValidId = chain[chain.length - 1] || originId;
        return { canonicalId: lastValidId, canonicalClient: byId.get(lastValidId) || null, chain, isMerged: chain.length > 1, invalidChain: true };
      }
      chain.push(currentId);
      const nextRaw = cur.fusionada_en;
      if (nextRaw === undefined || nextRaw === null || (typeof nextRaw === 'string' && nextRaw.trim() === '')) {
        return { canonicalId: currentId, canonicalClient: cur, chain, isMerged: chain.length > 1 };
      }
      const nextId = String(nextRaw).trim();
      if (!ACCOUNT_ID_RE.test(nextId) || visited.has(nextId) || depth >= MAX_MERGE_DEPTH) {
        return { canonicalId: currentId, canonicalClient: cur, chain, isMerged: chain.length > 1, invalidChain: true };
      }
      visited.add(nextId);
      currentId = nextId;
    }
    return { canonicalId: originId, canonicalClient: byId.get(originId) || null, chain, isMerged: false };
  }

  const publicMatch = (caller, portfolio, byId, m) => {
    const resolved = resolveCanonicalFromMapSync(byId, m.clientId);
    const canonicalId = resolved.canonicalId || m.clientId;
    const c = resolved.canonicalClient || byId.get(canonicalId) || byId.get(m.clientId) || m.data || {};
    const allowed = inPortfolio(caller, portfolio, { ...c, id: canonicalId });
    const out = {
      clientId: canonicalId,
      level: m.level,
      reasons: m.reasons,
      nombre: allowed ? id.displayName(c) : null,
      tipo: allowed ? (c.tipo || '') : '',
      hint: allowed ? id.identifierHint(c) : null,
      inPortfolio: allowed
    };
    if (!allowed) {
      out.restricted = true;
    }
    const absorbedFrom = m.absorbedFrom || (m.clientId !== canonicalId ? m.clientId : null);
    if (allowed && absorbedFrom && absorbedFrom !== canonicalId) {
      out.absorbedFrom = absorbedFrom;
    }
    return out;
  };

  // ---------- audit helpers (B4.2 Section 8) ----------
  function buildAuditEntry(caller, action, targetId, detail) {
    const safeCaller = (caller && typeof caller === 'object') ? caller : {};
    const ts = FieldValue && typeof FieldValue.serverTimestamp === 'function'
      ? FieldValue.serverTimestamp()
      : now().toISOString();
    return {
      action,
      targetType: 'client',
      targetId: targetId || null,
      actorUid: safeCaller.uid || null,
      actorCid: safeCaller.cid || null,
      actorName: safeCaller.name || '',
      actorRole: safeCaller.role || '',
      at: ts,
      atIso: now().toISOString(),
      detail: detail || {}
    };
  }

  async function recordDuplicateRejectionAudit(caller, operation, candidate, matches, targetId = null) {
    try {
      const ids = id.identifiersOf(candidate);
      const safeMatches = (matches || []).map(m => ({
        clientId: m.inPortfolio ? m.clientId : null,
        reasons: m.reasons || [],
        inPortfolio: !!m.inPortfolio,
        ...(m.inPortfolio && m.absorbedFrom ? { absorbedFrom: m.absorbedFrom } : {}),
        ...(m.inPortfolio && m.nombre ? { nombre: m.nombre } : {})
      }));
      const entry = buildAuditEntry(caller, 'clientDuplicateRejected', targetId, {
        operation,
        candidateType: (candidate && candidate.tipo) || '',
        candidateName: id.displayName(candidate),
        candidateHints: [
          id.maskDigits(ids.nit.digits, 'NIT'),
          id.maskDigits(ids.nrc.digits, 'NRC'),
          id.maskDigits(ids.dui.digits, 'DUI')
        ].filter(Boolean),
        reasons: Array.from(new Set(safeMatches.flatMap(m => m.reasons))),
        matchedAccountIds: safeMatches.filter(m => m.inPortfolio).map(m => m.clientId),
        authorizedMatchIds: safeMatches.filter(m => m.inPortfolio).map(m => m.clientId),
        restrictedMatchCount: safeMatches.filter(m => !m.inPortfolio).length,
        matches: safeMatches
      });
      await col('audit').doc().set(entry);
    } catch (_) {
      // Non-blocking audit write
    }
  }

  function normalizeReviewJustification(rawJustification, confirmReview, hasReviewMatches) {
    if (!hasReviewMatches || !confirmReview) return null;
    if (rawJustification !== undefined && rawJustification !== null) {
      const cleaned = str(rawJustification).slice(0, 500);
      if (!cleaned) {
        throw new ServiceError('invalid-argument', 'Debe ingresar una justificación breve para confirmar que se trata de una cuenta diferente');
      }
      return cleaned;
    }
    return 'Confirmación expresa de creación/edición pese a similitud de nombre sin coincidencia fiscal';
  }

  function buildSimilarityConfirmedAuditEntry(caller, operation, targetId, candidate, reviewMatches, justification) {
    const safeMatches = (reviewMatches || []).map(m => ({
      clientId: m.inPortfolio ? m.clientId : null,
      reasons: m.reasons || [],
      inPortfolio: !!m.inPortfolio,
      ...(m.inPortfolio && m.absorbedFrom ? { absorbedFrom: m.absorbedFrom } : {}),
      ...(m.inPortfolio && m.nombre ? { nombre: m.nombre } : {})
    }));
    return buildAuditEntry(caller, 'clientSimilarityConfirmed', targetId, {
      operation,
      decision: 'continue_different_account',
      justification: justification || 'Confirmación expresa de creación/edición pese a similitud de nombre sin coincidencia fiscal',
      createdClientId: targetId,
      candidateType: (candidate && candidate.tipo) || '',
      candidateName: id.displayName(candidate),
      matchedAccountIds: safeMatches.filter(m => m.inPortfolio).map(m => m.clientId),
      authorizedMatchIds: safeMatches.filter(m => m.inPortfolio).map(m => m.clientId),
      restrictedMatchCount: safeMatches.filter(m => !m.inPortfolio).length,
      matches: safeMatches
    });
  }

  async function checkIdentifierOwnerTx(tx, k, selfIdsSet) {
    const idx = await tx.get(col('identifiers').doc(k));
    if (!idx.exists) return null;
    const idxData = idx.data() || {};
    const ownerId = idxData.clientId;
    if (ownerId && selfIdsSet.has(ownerId)) return null;

    if (ownerId) {
      const ownerSnap = await tx.get(col('clients').doc(ownerId));
      if (ownerSnap.exists) {
        const ownerData = ownerSnap.data() || {};
        if (typeof ownerData.fusionada_en === 'string' && ownerData.fusionada_en.trim() !== '') {
          try {
            const resolved = await resolveCanonicalAccount(col('clients'), ownerId, { tx, suffix });
            if (selfIdsSet.has(resolved.canonicalId)) return null;
            return {
              key: k,
              clientId: resolved.canonicalId,
              absorbedFrom: ownerId,
              data: resolved.canonicalData
            };
          } catch (_) {
            return { key: k, clientId: ownerSnap.id, data: ownerData };
          }
        }
        return { key: k, clientId: ownerSnap.id, data: ownerData };
      }
    }

    const resId = idxData.reservationId || ownerId;
    if (resId && !selfIdsSet.has(resId)) {
      const resSnap = await tx.get(col('reservations').doc(resId));
      if (resSnap.exists) {
        const rData = resSnap.data() || {};
        const expMs = rData.expiresAtMs || (rData.expiresAt && rData.expiresAt.toMillis ? rData.expiresAt.toMillis() : new Date(rData.expiresAt).getTime());
        if (rData.status === 'reserved' && now().getTime() <= expMs) {
          return {
            key: k,
            clientId: rData.clientId || rData.id,
            data: rData.clientSnapshot || {
              id: rData.clientId || rData.id,
              tipo: rData.tipo || '',
              empresa: rData.empresa || '',
              nombres: rData.nombres || '',
              apellidos: rData.apellidos || '',
              nit: rData.nit || '',
              nrc: rData.nrc || '',
              dui: rData.dui || '',
              createdBy: rData.createdBy
            }
          };
        }
      }
    }
    return null;
  }

  // ---------- check / create ----------
  async function evaluate(caller, candidate, { ignoreId, onlyKeys } = {}) {
    const existing = await listClientsFresh();
    const byId = new Map(existing.map(c => [c.id, c]));

    // Build ignore set including absorbed accounts that belong to ignoreId
    const ignoreSet = new Set();
    if (ignoreId) {
      ignoreSet.add(ignoreId);
      const targetResolved = resolveCanonicalFromMapSync(byId, ignoreId);
      const targetCanonicalId = targetResolved.canonicalId || ignoreId;
      ignoreSet.add(targetCanonicalId);
      for (const c of existing) {
        const r = resolveCanonicalFromMapSync(byId, c.id);
        if (r.canonicalId === targetCanonicalId || r.chain.includes(ignoreId)) {
          ignoreSet.add(c.id);
        }
      }
    }

    let rawMatches = id.findMatches(candidate, existing, ignoreSet);
    if (onlyKeys) {
      // Edition: an exact match only blocks for a document the user is NEWLY claiming. A historical duplicate on an
      // UNCHANGED document is not this edit's problem: it is downgraded to a review warning instead of blocking.
      const ids = id.identifiersOf(candidate);
      const relevant = m =>
        (m.reasons.includes('nit') && onlyKeys.has(ids.nit.key)) ||
        (m.reasons.includes('nrc') && onlyKeys.has(ids.nrc.key)) ||
        (m.reasons.includes('dui') && onlyKeys.has(ids.dui.key));
      rawMatches = rawMatches.map(m => (m.level === 'exact' && !relevant(m)) ? { ...m, level: 'review' } : m);
    }

    // Consolidate matches by canonical account ID so absorbed accounts resolve to their active terminal account
    const levelOrder = { exact: 0, review: 1, info: 2 };
    const consolidatedMap = new Map();
    for (const m of rawMatches) {
      const resolved = resolveCanonicalFromMapSync(byId, m.clientId);
      const canonicalId = resolved.canonicalId || m.clientId;
      if (ignoreSet.has(canonicalId)) continue;
      const absorbedFrom = m.clientId !== canonicalId ? m.clientId : null;
      if (!consolidatedMap.has(canonicalId)) {
        consolidatedMap.set(canonicalId, {
          clientId: canonicalId,
          level: m.level,
          reasons: [...m.reasons],
          ...(absorbedFrom ? { absorbedFrom } : {})
        });
      } else {
        const prev = consolidatedMap.get(canonicalId);
        if (levelOrder[m.level] < levelOrder[prev.level]) {
          prev.level = m.level;
        }
        for (const r of m.reasons) {
          if (!prev.reasons.includes(r)) prev.reasons.push(r);
        }
        if (absorbedFrom && !prev.absorbedFrom) {
          prev.absorbedFrom = absorbedFrom;
        }
      }
    }

    const matches = Array.from(consolidatedMap.values()).sort((x, y) => levelOrder[x.level] - levelOrder[y.level]);
    const portfolio = await portfolioIds(caller);
    const pub = matches.map(m => publicMatch(caller, portfolio, byId, m));
    return { pub, exact: pub.filter(m => m.level === 'exact'), review: pub.filter(m => m.level === 'review') };
  }

  async function create({ caller, client: raw, opId, confirmReview = false, reviewJustification, dryRun = false }) {
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
    if (ev.exact.length) {
      if (!dryRun) await recordDuplicateRejectionAudit(caller, 'create', client, ev.exact, null);
      return { status: 'duplicate', matches: ev.pub, warnings };
    }
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    const cleanJustification = normalizeReviewJustification(reviewJustification, confirmReview, ev.review.length > 0);
    if (dryRun) return { status: 'ok', matches: ev.pub, warnings };

    const keys = id.keysOf(client);
    const selfIdsSet = new Set();
    const result = await db.runTransaction(async tx => {
      const opSnap = await tx.get(opRef);
      if (opSnap.exists) return { replay: opSnap.data() };

      // 1) every read before the first write
      const owners = [];
      for (const k of keys) {
        const conflictOwner = await checkIdentifierOwnerTx(tx, k, selfIdsSet);
        if (conflictOwner) owners.push(conflictOwner);
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
      if (!doc.documentos) {
        doc.documentos = {};
      } else {
        const initialDocs = {};
        for (const k of Object.keys(doc.documentos)) {
          const item = doc.documentos[k];
          if (Array.isArray(item) || typeof item === 'string') {
            initialDocs[k] = item;
          } else if (item && typeof item === 'object') {
            await applyDocumentVersionTx({
              tx,
              db,
              entityType: 'client',
              entityId: clientId,
              parentColName: names.clients,
              docKey: k,
              existingDoc: null,
              incomingDoc: item,
              caller,
              motivoSustitucion: null,
              opId: null,
              FieldValue,
              now
            });
            initialDocs[k] = item;
          }
        }
        doc.documentos = initialDocs;
      }
      tx.create(col('clients').doc(clientId), doc);
      for (const k of keys) {
        tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      }
      if (ev.review.length > 0 && confirmReview) {
        tx.create(col('audit').doc(), buildSimilarityConfirmedAuditEntry(caller, 'create', clientId, client, ev.review, cleanJustification));
      }
      tx.create(opRef, { kind: 'create', status: 'succeeded', clientId, payloadHash, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      return { created: doc };
    });

    if (result.replay) return replayOf(result.replay, payloadHash, caller);
    if (result.conflict) {
      // Lost a race against a concurrent creation of the same document: report the winner.
      const byId = new Map(result.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = result.conflict.map(o => publicMatch(caller, portfolio, byId, {
        clientId: o.clientId,
        absorbedFrom: o.absorbedFrom,
        data: o.data,
        level: 'exact',
        reasons: [o.key.split('_')[0].toLowerCase()]
      }));
      await recordDuplicateRejectionAudit(caller, 'create', client, matches, null);
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

  async function reserveCreation({ caller, client: raw, confirmReview = false, reviewJustification }) {
    const client = sanitizeClient(raw);
    const warnings = id.formatWarnings(client);
    const ev = await evaluate(caller, client);
    if (ev.exact.length) {
      await recordDuplicateRejectionAudit(caller, 'reserve', client, ev.exact, null);
      return { status: 'duplicate', matches: ev.pub, warnings };
    }
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    const cleanJustification = normalizeReviewJustification(reviewJustification, confirmReview, ev.review.length > 0);

    const keys = id.keysOf(client);
    const expiresMs = now().getTime() + RESERVATION_TTL_MS;
    const expiresDate = new Date(expiresMs);
    const selfIdsSet = new Set();

    const outcome = await db.runTransaction(async tx => {
      const owners = [];
      for (const k of keys) {
        const conflictOwner = await checkIdentifierOwnerTx(tx, k, selfIdsSet);
        if (conflictOwner) owners.push(conflictOwner);
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
        clientSnapshot: {
          id: reservationId,
          tipo: client.tipo,
          empresa: client.empresa || '',
          nombres: client.nombres || '',
          apellidos: client.apellidos || '',
          nit: client.nit || '',
          nrc: client.nrc || '',
          dui: client.dui || '',
          createdBy: caller.cid
        },
        ...(cleanJustification ? { reviewJustification: cleanJustification } : {}),
        status: 'reserved',
        createdAt: now().toISOString(),
        expiresAt: expiresDate,
        expiresAtMs: expiresMs,
        expiresAtIso: expiresDate.toISOString()
      };

      tx.create(col('reservations').doc(reservationId), resDoc);
      for (const k of keys) {
        tx.set(col('identifiers').doc(k), {
          key: k,
          kind: k.split('_')[0],
          clientId: reservationId,
          reservationId,
          status: 'reserved',
          expiresAtMs: expiresMs,
          createdBy: caller.cid,
          createdAt: FieldValue.serverTimestamp()
        });
      }
      return { reservation: resDoc };
    });

    if (outcome.conflict) {
      const byId = new Map(outcome.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = outcome.conflict.map(o => publicMatch(caller, portfolio, byId, {
        clientId: o.clientId,
        absorbedFrom: o.absorbedFrom,
        data: o.data,
        level: 'exact',
        reasons: [o.key.split('_')[0].toLowerCase()]
      }));
      await recordDuplicateRejectionAudit(caller, 'reserve', client, matches, null);
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
    return db.runTransaction(async tx => {
      const snap = await tx.get(resRef);
      if (!snap.exists) throw new ServiceError('not-found', 'Reserva no encontrada');
      const resData = snap.data();
      if (resData.createdBy !== caller.cid && !PRIVILEGED.includes(caller.role)) {
        throw new ServiceError('permission-denied', 'No puedes cancelar una reserva de otro usuario');
      }
      if (resData.status !== 'reserved') {
        return { status: resData.status, reservationId };
      }
      const toRelease = [];
      for (const k of (Array.isArray(resData.keys) ? resData.keys : [])) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists) {
          const idxData = idx.data() || {};
          if (idxData.clientId === reservationId && idxData.status === 'reserved') {
            toRelease.push(k);
          }
        }
      }
      tx.update(resRef, {
        status: 'cancelled',
        cancelledAt: now().toISOString(),
        cancelledBy: caller.cid
      });
      for (const k of toRelease) {
        tx.delete(col('identifiers').doc(k));
      }
      return { status: 'cancelled', reservationId };
    });
  }

  async function finalizeCreation({ caller, reservationId, client: raw, opId, confirmReview = false, reviewJustification }) {
    if (typeof reservationId !== 'string' || !reservationId) throw new ServiceError('invalid-argument', 'reservationId requerido');
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(opId)) throw new ServiceError('invalid-argument', 'opId requerido');
    const client = sanitizeClient(raw);
    const warnings = id.formatWarnings(client);
    const payloadHash = stableHash({ reservationId, client });
    const opRef = col('ops').doc(opId);

    const prevOp = await opRef.get();
    if (prevOp.exists) return replayOf(prevOp.data(), payloadHash, caller);

    const ev = await evaluate(caller, client, { ignoreId: reservationId });
    if (ev.exact.length) {
      await recordDuplicateRejectionAudit(caller, 'finalize', client, ev.exact, reservationId);
      return { status: 'duplicate', matches: ev.pub, warnings };
    }
    if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    const cleanJustification = normalizeReviewJustification(reviewJustification, confirmReview, ev.review.length > 0);

    const keys = id.keysOf(client);
    const selfIdsSet = new Set([reservationId]);
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
        const conflictOwner = await checkIdentifierOwnerTx(tx, k, selfIdsSet);
        if (conflictOwner) owners.push(conflictOwner);
      }
      if (owners.length) return { conflict: owners };

      const staleReservedKeys = [];
      for (const rk of (Array.isArray(resData.keys) ? resData.keys : [])) {
        if (!keys.includes(rk)) {
          const idx = await tx.get(col('identifiers').doc(rk));
          if (idx.exists && (idx.data() || {}).clientId === reservationId) {
            staleReservedKeys.push(rk);
          }
        }
      }

      const doc = {
        ...client,
        id: reservationId,
        createdBy: caller.cid,
        fecha_creacion: now().toISOString(),
        visibleTo: [caller.cid],
        closingVendors: []
      };
      if (!doc.documentos) {
        doc.documentos = {};
      } else {
        const initialDocs = {};
        for (const k of Object.keys(doc.documentos)) {
          const item = doc.documentos[k];
          if (Array.isArray(item) || typeof item === 'string') {
            initialDocs[k] = item;
          } else if (item && typeof item === 'object') {
            const vRes = await applyDocumentVersionTx({
              tx,
              db,
              entityType: 'client',
              entityId: reservationId,
              parentColName: names.clients,
              docKey: k,
              existingDoc: null,
              incomingDoc: item,
              caller,
              motivoSustitucion: null,
              opId: null,
              FieldValue,
              now
            });
            initialDocs[k] = {
              ...item,
              ...(vRes && vRes.versionId ? { versionId: vRes.versionId } : {}),
              ...(vRes && vRes.versionNumber !== undefined && vRes.versionNumber !== null ? { versionNumber: vRes.versionNumber } : {})
            };
          }
        }
        doc.documentos = initialDocs;
      }

      tx.create(col('clients').doc(reservationId), doc);
      for (const k of keys) {
        tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId: reservationId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      }
      for (const rk of staleReservedKeys) {
        tx.delete(col('identifiers').doc(rk));
      }
      tx.update(resRef, {
        status: 'finalized',
        finalizedAt: now().toISOString(),
        finalizedBy: caller.cid
      });
      if (ev.review.length > 0 && confirmReview) {
        const effJust = (reviewJustification !== undefined && reviewJustification !== null)
          ? cleanJustification
          : (resData.reviewJustification || cleanJustification);
        tx.create(col('audit').doc(), buildSimilarityConfirmedAuditEntry(caller, 'finalize', reservationId, client, ev.review, effJust));
      }
      tx.create(opRef, { kind: 'finalize', status: 'succeeded', clientId: reservationId, reservationId, payloadHash, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      return { created: doc };
    });

    if (result.replay) return replayOf(result.replay, payloadHash, caller);
    if (result.conflict) {
      const byId = new Map(result.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = result.conflict.map(o => publicMatch(caller, portfolio, byId, {
        clientId: o.clientId,
        absorbedFrom: o.absorbedFrom,
        data: o.data,
        level: 'exact',
        reasons: [o.key.split('_')[0].toLowerCase()]
      }));
      await recordDuplicateRejectionAudit(caller, 'finalize', client, matches, reservationId);
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

  async function update({ caller, id: clientId, client: raw, confirmReview = false, reviewJustification, dryRun = false, opId = null, motivosSustitucion = null }) {
    if (typeof clientId !== 'string' || !clientId) throw new ServiceError('invalid-argument', 'id requerido');
    const incoming = sanitizeClient({ ...raw, documentos: undefined });
    const resolved = await resolveCanonicalAccount(col('clients'), clientId);
    const ref = col('clients').doc(clientId);
    const existing = resolved.originData;
    if (!authorizeClientAccess(caller, resolved.canonicalData) && !(await isRelated(caller, resolved.canonicalId))) {
      throw new ServiceError('permission-denied', 'No tienes acceso a este cliente');
    }
    const activeMotivos = raw ? (raw.motivosSustitucion || motivosSustitucion) : motivosSustitucion;
    const opKey = (raw && typeof raw.opId === 'string' && raw.opId.trim())
      ? raw.opId.trim()
      : (typeof opId === 'string' && opId.trim() ? opId.trim() : null);
    if (opKey && !/^[A-Za-z0-9_-]{8,100}$/.test(opKey)) {
      throw new ServiceError('invalid-argument', 'opId inválido');
    }
    const updatePayloadHash = opKey
      ? stableHash({ clientId, incoming, rawDocs: raw ? raw.documentos : null, motivos: activeMotivos || null })
      : null;
    const opRef = (!dryRun && opKey) ? col('ops').doc(`upd_${clientId}_${opKey}`) : null;
    if (opRef) {
      const prevOp = await opRef.get();
      if (prevOp.exists) {
        const prevData = prevOp.data() || {};
        if (prevData.createdBy !== caller.cid) throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
        if (prevData.payloadHash !== updatePayloadHash) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
        return { status: 'updated', replay: true, client: prevData.client || { ...existing, id: clientId }, matches: [], warnings: [] };
      }
    }

    const incomingDocs = resolveDocumentsForUpdate(caller, existing.documentos, raw ? raw.documentos : undefined, raw ? raw.baseDocumentos : undefined, activeMotivos);
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
    let reviewList = [];
    if (toClaim.length || nameChanged) {
      const ev = await evaluate(caller, merged, { ignoreId: clientId, onlyKeys: new Set(toClaim) });
      pub = ev.pub;
      reviewList = ev.review;
      if (ev.exact.length) {
        if (!dryRun) await recordDuplicateRejectionAudit(caller, 'update', merged, ev.exact, clientId);
        return { status: 'duplicate', matches: ev.pub, warnings };
      }
      if (ev.review.length && !confirmReview) return { status: 'needs-review', matches: ev.pub, warnings };
    }
    const cleanJustification = normalizeReviewJustification(reviewJustification, confirmReview, reviewList.length > 0);
    if (dryRun) return { status: 'ok', matches: pub, warnings };

    const selfIdsSet = new Set(resolved.chain || [clientId, resolved.canonicalId]);
    const outcome = await db.runTransaction(async tx => {
      if (opRef) {
        const opSnap = await tx.get(opRef);
        if (opSnap.exists) return { replay: opSnap.data() };
      }
      const cur = await tx.get(ref);
      if (!cur.exists) throw new ServiceError('not-found', 'Cliente no encontrado');
      const curData = cur.data();
      const txDocs = resolveDocumentsForUpdate(caller, curData.documentos, raw ? raw.documentos : undefined, raw ? raw.baseDocumentos : undefined, activeMotivos);
      const claims = [];
      for (const k of toClaim) {
        const conflictOwner = await checkIdentifierOwnerTx(tx, k, selfIdsSet);
        if (conflictOwner) return { conflict: [conflictOwner] };
        claims.push(k);
      }
      const releases = [];
      for (const k of toRelease) {
        const idx = await tx.get(col('identifiers').doc(k));
        if (idx.exists && idx.data().clientId === clientId && !idx.data().absorbedClientId) releases.push(k);
      }
      const doc = { ...curData, ...incoming, id: clientId };
      if (curData.createdBy !== undefined) {
        doc.createdBy = curData.createdBy;
      } else {
        delete doc.createdBy;
      }
      if (txDocs !== undefined) {
        const finalDocs = { ...txDocs };
        const itemsToVersion = [];
        for (const k of Object.keys(txDocs)) {
          const curDoc = curData.documentos ? curData.documentos[k] : null;
          const incDoc = txDocs[k];
          if (Array.isArray(incDoc)) {
            finalDocs[k] = incDoc;
          } else if (incDoc && typeof incDoc === 'object') {
            const motivo = (incDoc && incDoc.motivoSustitucion)
              || (raw && raw.motivosSustitucion && raw.motivosSustitucion[k])
              || (motivosSustitucion && motivosSustitucion[k])
              || null;
            itemsToVersion.push({
              docKey: k,
              existingDoc: curDoc,
              incomingDoc: incDoc,
              motivoSustitucion: motivo,
              opId: opKey ? `${opKey}_${k}` : null
            });
            finalDocs[k] = incDoc;
          }
        }
        if (itemsToVersion.length > 0) {
          await applyDocumentVersionsTx({
            tx,
            db,
            entityType: 'client',
            entityId: clientId,
            parentColName: names.clients,
            items: itemsToVersion,
            caller,
            FieldValue,
            now
          });
        }
        doc.documentos = finalDocs;
      } else if (curData.documentos !== undefined) {
        doc.documentos = curData.documentos;
      }
      if (curData.fecha_creacion !== undefined) doc.fecha_creacion = curData.fecha_creacion;
      if (curData.visibleTo !== undefined) doc.visibleTo = curData.visibleTo;
      for (const k of Object.keys(doc)) {
        if (doc[k] === undefined) delete doc[k];
      }
      tx.set(ref, doc);
      for (const k of claims) tx.set(col('identifiers').doc(k), { key: k, kind: k.split('_')[0], clientId, createdBy: caller.cid, createdAt: FieldValue.serverTimestamp() });
      for (const k of releases) tx.delete(col('identifiers').doc(k));
      if (reviewList.length > 0 && confirmReview) {
        tx.create(col('audit').doc(), buildSimilarityConfirmedAuditEntry(caller, 'update', clientId, merged, reviewList, cleanJustification));
      }
      if (opRef) {
        tx.set(opRef, {
          kind: 'update',
          status: 'succeeded',
          clientId,
          payloadHash: updatePayloadHash,
          client: doc,
          createdBy: caller.cid,
          createdAt: FieldValue.serverTimestamp()
        });
      }
      return { updated: doc };
    });
    if (outcome.replay) {
      const prevData = outcome.replay || {};
      if (prevData.createdBy !== caller.cid) throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
      if (prevData.payloadHash !== updatePayloadHash) throw new ServiceError('failed-precondition', 'opId ya usado con otros datos');
      return { status: 'updated', replay: true, client: prevData.client || { ...existing, id: clientId }, matches: [], warnings: [] };
    }
    if (outcome.conflict) {
      const byId = new Map(outcome.conflict.map(o => [o.clientId, o.data]));
      const portfolio = await portfolioIds(caller);
      const matches = outcome.conflict.map(o => publicMatch(caller, portfolio, byId, {
        clientId: o.clientId,
        absorbedFrom: o.absorbedFrom,
        data: o.data,
        level: 'exact',
        reasons: [o.key.split('_')[0].toLowerCase()]
      }));
      await recordDuplicateRejectionAudit(caller, 'update', merged, matches, clientId);
      return { status: 'duplicate', warnings, matches };
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
    const byId = new Map(list.map(c => [c.id, c]));
    const portfolio = await portfolioIds(caller);
    const scoredByCanonical = new Map();
    for (const c of list) {
      const full = id.foldText(id.displayName(c));
      if (!full) continue;
      const tokens = full.split(' ');
      let score = 0;
      if (digits) {
        const ids = id.identifiersOf(c);
        if (
          (ids.nit.digits && ids.nit.digits.includes(digits)) ||
          (ids.nrc.digits && ids.nrc.digits.includes(digits)) ||
          (ids.dui.digits && ids.dui.digits.includes(digits))
        ) score = 2;
      } else if (qTokens.every(t => tokens.some(w => w.startsWith(t)))) {
        score = full.startsWith(text) ? 3 : 2;
      }
      if (score) {
        const resolved = resolveCanonicalFromMapSync(byId, c.id);
        const canonicalClient = resolved.canonicalClient || c;
        if (canonicalClient && typeof canonicalClient.fusionada_en === 'string' && canonicalClient.fusionada_en.trim() !== '') continue;
        const canonicalFull = id.foldText(id.displayName(canonicalClient)) || full;
        const existingHit = scoredByCanonical.get(canonicalClient.id);
        if (!existingHit || score > existingHit.score) {
          scoredByCanonical.set(canonicalClient.id, { c: canonicalClient, score, full: canonicalFull });
        }
      }
    }
    const scored = Array.from(scoredByCanonical.values());
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
    const queue = Array.from(new Set((clientIds || []).filter(Boolean).map(String)));
    const processed = new Set();

    while (queue.length > 0) {
      const clientId = queue.shift();
      if (!clientId || processed.has(clientId)) continue;
      processed.add(clientId);

      const ref = col('clients').doc(String(clientId));
      const [snap, ps] = await Promise.all([
        ref.get(),
        col('prospects').where('clientId', '==', clientId).select('createdBy', 'vendedorId', 'eliminado', 'etapa', 'estado').get()
      ]);
      if (!snap.exists) continue;
      const clientData = snap.data() || {};
      if (typeof clientData.fusionada_en === 'string' && clientData.fusionada_en.trim()) {
        try {
          const resolved = await resolveCanonicalAccount(col('clients'), clientId);
          if (resolved.canonicalId && !processed.has(resolved.canonicalId)) {
            queue.push(resolved.canonicalId);
          }
        } catch (_) {
          // Ignore invalid/cyclic chains during background recompute
        }
      }

      const set = new Set();
      const closingSet = new Set();
      ps.docs.forEach(d => {
        const p = d.data();
        if (p.eliminado === true) return;
        const activeSeller = p.vendedorId || p.createdBy;
        if (activeSeller && activeSeller !== 'sistema') {
          set.add(String(activeSeller));
          if (p.etapa === 'cierre' && p.estado !== 'perdido') {
            closingSet.add(String(activeSeller));
          }
        }
        if (p.createdBy && p.createdBy !== 'sistema') {
          set.add(String(p.createdBy));
        }
      });
      const next = Array.from(set).sort();
      const nextClosing = Array.from(closingSet).sort();
      const cur = Array.isArray(clientData.visibleTo) ? [...clientData.visibleTo].sort() : null;
      const curClosing = Array.isArray(clientData.closingVendors) ? [...clientData.closingVendors].sort() : null;

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

  const boundResolveCanonicalAccount = (originId, opts = {}) =>
    resolveCanonicalAccount(col('clients'), originId, { suffix, ...opts });

  // ===================================================================================================
  // B4.3 — Fusión administrativa excepcional de cuentas duplicadas (Exclusiva para Manager)
  // ===================================================================================================
  const MERGE_PERMISSION_WARNING =
    'La fusión modificará los permisos efectivos de acceso a los registros históricos conforme a B4.1: ' +
    'todo acceso a documentos, contactos y oportunidades históricas se evaluará exclusivamente contra los permisos ' +
    'de la cuenta canónica destino. No se realiza unión automática de carteras.';

  async function requireManagerForMerge(caller) {
    if (!caller || typeof caller !== 'object' || Array.isArray(caller) || typeof caller.uid !== 'string' || !caller.uid.trim()) {
      throw new ServiceError('unauthenticated', 'Autenticación requerida');
    }
    if (!isCallerActiveAndAuthenticated(caller)) {
      throw new ServiceError('permission-denied', 'Usuario inactivo o con permisos revocados');
    }
    if (caller.role !== 'manager') {
      throw new ServiceError('permission-denied', 'Solo un usuario con rol manager puede fusionar cuentas');
    }

    // Re-check CRM user profile in Firestore if present
    const lookupIds = Array.from(new Set([caller.cid, caller.id].filter(v => typeof v === 'string' && v.trim())));
    let userRecord = null;
    for (const docId of lookupIds) {
      const snap = await col('users').doc(docId).get();
      if (snap && snap.exists) {
        userRecord = snap.data() || {};
        break;
      }
    }
    if (!userRecord) {
      const q = await col('users').where('authUid', '==', caller.uid.trim()).limit(1).get();
      if (q && Array.isArray(q.docs) && q.docs.length > 0) {
        userRecord = q.docs[0].data() || {};
      }
    }
    if (userRecord) {
      if (
        userRecord.activo === false ||
        userRecord.revoked === true ||
        userRecord.disabled === true ||
        userRecord.status === 'revoked' ||
        userRecord.status === 'inactive' ||
        userRecord.estado === 'inactivo' ||
        userRecord.estado === 'revocado' ||
        (userRecord.role && userRecord.role !== 'manager')
      ) {
        throw new ServiceError('permission-denied', 'Permisos gerenciales revocados o usuario inactivo');
      }
    }

    const liveOk = await verifyManager(caller.uid);
    if (!liveOk) {
      throw new ServiceError('permission-denied', 'Permisos gerenciales no verificados en sesión activa');
    }
  }

  function analyzeMergeChainImpact(allClients, sourceId, destinationId, sourceData, destData) {
    const blockingReasons = [];
    const byId = new Map((allClients || []).map(c => [c.id, c]));
    if (sourceData && sourceId) byId.set(sourceId, { ...sourceData, id: sourceId });
    if (destData && destinationId) byId.set(destinationId, { ...destData, id: destinationId });

    const srcMergedInto = sourceData && typeof sourceData.fusionada_en === 'string' ? sourceData.fusionada_en.trim() : '';
    if (srcMergedInto) {
      blockingReasons.push(`La cuenta origen (${sourceId}) ya fue absorbida previamente en '${srcMergedInto}' y no puede volver a fusionarse.`);
    }

    const dstMergedInto = destData && typeof destData.fusionada_en === 'string' ? destData.fusionada_en.trim() : '';
    if (dstMergedInto) {
      blockingReasons.push(`La cuenta destino (${destinationId}) está absorbida en '${dstMergedInto}'. Seleccione la cuenta canónica activa como destino.`);
    }

    // Check if destination's outgoing chain reaches sourceId
    if (destinationId && byId.has(destinationId)) {
      const visitedDst = new Set([destinationId]);
      let curId = destinationId;
      for (let d = 0; d <= MAX_MERGE_DEPTH + 1; d++) {
        const cur = byId.get(curId);
        if (!cur) break;
        const nextRaw = typeof cur.fusionada_en === 'string' ? cur.fusionada_en.trim() : '';
        if (!nextRaw) break;
        if (nextRaw === sourceId) {
          blockingReasons.push('Ciclo detectado: la cuenta destino depende directa o indirectamente de la cuenta origen.');
          break;
        }
        if (visitedDst.has(nextRaw)) {
          blockingReasons.push('La cuenta destino pertenece a una cadena con ciclo inválido.');
          break;
        }
        visitedDst.add(nextRaw);
        curId = nextRaw;
      }
    }

    const incomingToSourceIds = [];
    const incomingToDestinationIds = [];
    let incomingMaxDepth = 0;

    for (const [cid, cDoc] of byId.entries()) {
      if (!cid || cid === sourceId) continue;
      const visited = new Set([cid]);
      let curId = cid;
      let steps = 0;
      while (steps <= MAX_MERGE_DEPTH + 2) {
        const cur = byId.get(curId);
        if (!cur) break;
        const nextRaw = typeof cur.fusionada_en === 'string' ? cur.fusionada_en.trim() : '';
        if (!nextRaw) break;
        steps += 1;
        if (nextRaw === sourceId) {
          incomingToSourceIds.push(cid);
          if (steps > incomingMaxDepth) incomingMaxDepth = steps;
          if (cid === destinationId) {
            blockingReasons.push('Ciclo detectado: la cuenta destino apunta a la cuenta origen.');
          }
          break;
        }
        if (nextRaw === destinationId && cid !== destinationId) {
          incomingToDestinationIds.push(cid);
        }
        if (visited.has(nextRaw)) {
          break;
        }
        visited.add(nextRaw);
        curId = nextRaw;
      }
    }

    const resultingMaxDepth = incomingMaxDepth + 1;
    if (resultingMaxDepth > MAX_MERGE_DEPTH) {
      blockingReasons.push(
        `La fusión generaría una cadena histórica de ${resultingMaxDepth} niveles, excediendo el límite máximo permitido en B4.1 (${MAX_MERGE_DEPTH} niveles).`
      );
    }

    return {
      blockingReasons,
      incomingToSourceIds: Array.from(new Set(incomingToSourceIds)).sort(),
      incomingToDestinationIds: Array.from(new Set(incomingToDestinationIds)).sort(),
      incomingMaxDepth,
      resultingMaxDepth,
      maxAllowedDepth: MAX_MERGE_DEPTH
    };
  }

  function validateLegalIdentityForMerge(sourceData, destData, options = {}) {
    const blockingReasons = [];
    const warnings = [];
    const src = sourceData || {};
    const dst = destData || {};

    const srcTipo = src.tipo === 'juridico' ? 'juridica' : (src.tipo || '');
    const dstTipo = dst.tipo === 'juridico' ? 'juridica' : (dst.tipo || '');

    if ((srcTipo !== 'juridica' && srcTipo !== 'natural') || (dstTipo !== 'juridica' && dstTipo !== 'natural')) {
      blockingReasons.push('Ambas cuentas deben tener un tipo de persona válido (Persona Jurídica o Persona Natural).');
    } else if (srcTipo !== dstTipo) {
      blockingReasons.push('No se permite fusionar una Persona Natural con una Persona Jurídica: los tipos jurídicos son incompatibles.');
    }

    const srcIds = id.identifiersOf(src);
    const dstIds = id.identifiersOf(dst);

    if (srcIds.nit.status === 'invalid' || dstIds.nit.status === 'invalid') {
      blockingReasons.push('Formato de NIT inválido en una de las cuentas. Corrija el NIT antes de ejecutar la fusión.');
    }
    if (srcIds.nrc.status === 'invalid' || dstIds.nrc.status === 'invalid') {
      blockingReasons.push('Formato de NRC inválido en una de las cuentas. Corrija el NRC antes de ejecutar la fusión.');
    }
    if (srcTipo === 'natural' && (srcIds.dui.status === 'invalid' || dstIds.dui.status === 'invalid')) {
      blockingReasons.push('Formato de DUI inválido en una de las cuentas. Corrija el DUI antes de ejecutar la fusión.');
    }

    // Rule 1: Two non-empty contradictory fiscal identifiers prevent merging
    if (srcIds.nit.key && dstIds.nit.key && srcIds.nit.key !== dstIds.nit.key) {
      blockingReasons.push(
        `Identidad fiscal contradictoria: la cuenta origen tiene NIT (${src.nit}) distinto al NIT de la cuenta destino (${dst.nit}).`
      );
    }
    if (srcIds.nrc.key && dstIds.nrc.key && srcIds.nrc.key !== dstIds.nrc.key) {
      blockingReasons.push(
        `Identidad fiscal contradictoria: la cuenta origen tiene NRC (${src.nrc}) distinto al NRC de la cuenta destino (${dst.nrc}).`
      );
    }
    if (srcTipo === 'natural' && srcIds.dui.key && dstIds.dui.key && srcIds.dui.key !== dstIds.dui.key) {
      blockingReasons.push(
        `Identidad contradictoria: la cuenta origen tiene DUI (${src.dui}) distinto al DUI de la cuenta destino (${dst.dui}).`
      );
    }

    const sameNit = Boolean(srcIds.nit.key && dstIds.nit.key && srcIds.nit.key === dstIds.nit.key);
    const sameNrc = Boolean(srcIds.nrc.key && dstIds.nrc.key && srcIds.nrc.key === dstIds.nrc.key);
    const sameDui = Boolean(srcTipo === 'natural' && srcIds.dui.key && dstIds.dui.key && srcIds.dui.key === dstIds.dui.key);
    const hasExactFiscalMatch = sameNit || sameNrc || sameDui;

    const nameComparison = id.compareNames(id.nameTokens(src), id.nameTokens(dst)); // 'same' | 'similar' | null

    // Rule 6: Do not allow merging different companies simply because they belong to the same corporate group
    const combinedJustification = `${options.justification || ''} ${options.verificationEvidence || ''}`.trim();
    const mentionsCorporateGroup = /\b(mismo grupo empresarial|grupo corporativo|empresas?\s+distintas?\s+del\s+grupo|sociedades?\s+distintas?|filial\s+del\s+grupo|subsidiaria\s+del\s+grupo)\b/i.test(combinedJustification) &&
      !/\b(no\s+son\s+empresas\s+distintas|misma\s+entidad\s+jur[ií]dica|misma\s+sociedad)\b/i.test(combinedJustification);
    if (options.sameCorporateGroupOnly === true || mentionsCorporateGroup) {
      blockingReasons.push('No se permite fusionar dos empresas o sociedades distintas simplemente porque pertenecen al mismo grupo empresarial.');
    }

    const requiresDocumentedVerification = !hasExactFiscalMatch;

    if (!hasExactFiscalMatch) {
      if (nameComparison === null) {
        blockingReasons.push(
          'Identidad jurídica no demostrada: las cuentas no comparten ningún identificador fiscal (NIT/NRC/DUI) ni presentan correspondencia en su razón social o nombre.'
        );
      } else {
        warnings.push(
          'Una o ambas cuentas carecen de identificadores fiscales coincidentes. La similitud de nombres por sí sola no prueba identidad jurídica: el gerente debe verificar y documentar el respaldo legal antes de confirmar.'
        );
        if (options.enforceExecution === true) {
          const cleanEvidence = typeof options.verificationEvidence === 'string' ? options.verificationEvidence.trim() : '';
          if (options.legalIdentityVerified !== true || cleanEvidence.length < 10) {
            blockingReasons.push(
              'La similitud de nombres por sí sola no constituye prueba suficiente de que ambas cuentas son la misma entidad. Debe marcar la verificación de identidad jurídica y documentar el respaldo legal verificado (mínimo 10 caracteres).'
            );
          }
        }
      }
    } else if (nameComparison === null) {
      warnings.push(
        'Las cuentas comparten identidad fiscal exacta pero registran denominaciones o nombres distintos (posible cambio de razón social o nombre comercial). Revise el expediente antes de confirmar.'
      );
    }

    let identityStatus = 'blocked';
    if (blockingReasons.length === 0) {
      identityStatus = hasExactFiscalMatch
        ? 'verified_by_fiscal_id'
        : (options.legalIdentityVerified === true && typeof options.verificationEvidence === 'string' && options.verificationEvidence.trim().length >= 10
          ? 'verified_by_documented_evidence'
          : 'requires_documented_verification');
    }

    return {
      valid: blockingReasons.length === 0,
      blockingReasons,
      warnings,
      hasExactFiscalMatch,
      sameNit,
      sameNrc,
      sameDui,
      nameComparison,
      requiresDocumentedVerification,
      identityStatus,
      sourceIdentifiers: {
        nit: srcIds.nit.digits || '',
        nrc: srcIds.nrc.digits || '',
        dui: srcIds.dui.digits || ''
      },
      destinationIdentifiers: {
        nit: dstIds.nit.digits || '',
        nrc: dstIds.nrc.digits || '',
        dui: dstIds.dui.digits || ''
      },
      allowed: blockingReasons.length === 0,
      requiresManualVerification: requiresDocumentedVerification,
      message: blockingReasons.length > 0
        ? blockingReasons.join(' ')
        : (warnings.length > 0 ? warnings.join(' ') : 'Identificadores fiscales compatibles para fusión administrativa.')
    };
  }

  function computeMergeAccountStateSnapshot(accData) {
    const c = accData || {};
    const ids = id.identifiersOf(c);
    return {
      tipo: c.tipo || '',
      empresa: (c.empresa || '').trim(),
      nombres: (c.nombres || '').trim(),
      apellidos: (c.apellidos || '').trim(),
      nitKey: ids.nit.key || '',
      nrcKey: ids.nrc.key || '',
      duiKey: ids.dui.key || '',
      fusionada_en: typeof c.fusionada_en === 'string' ? c.fusionada_en.trim() : '',
      estado_cuenta: c.estado_cuenta || '',
      createdBy: c.createdBy || '',
      visibleTo: Array.isArray(c.visibleTo) ? [...c.visibleTo].sort() : [],
      closingVendors: Array.isArray(c.closingVendors) ? [...c.closingVendors].sort() : []
    };
  }

  function computeMergePairStateHash(sourceData, destData) {
    return stableHash(JSON.stringify({
      source: computeMergeAccountStateSnapshot(sourceData),
      destination: computeMergeAccountStateSnapshot(destData)
    }));
  }

  function countClientDocuments(c) {
    if (!c || !c.documentos || typeof c.documentos !== 'object' || Array.isArray(c.documentos)) return 0;
    let count = 0;
    for (const k of Object.keys(c.documentos)) {
      const v = c.documentos[k];
      if (!v) continue;
      if (Array.isArray(v)) {
        count += v.filter(Boolean).length;
      } else if (typeof v === 'object' || typeof v === 'string') {
        count += 1;
      }
    }
    return count;
  }

  async function buildAccountMergeComparisonItem(accId, accData, roleInMerge, directAbsorbedIds, chainAbsorbedIds) {
    const [prospectsSnap, accContactsSnap, legacyContactsSnap] = await Promise.all([
      col('prospects').where('clientId', '==', accId).get(),
      col('accountContacts').where('accountId', '==', accId).get(),
      col('contacts').where('clientId', '==', accId).get()
    ]);

    const activeProspects = (prospectsSnap && Array.isArray(prospectsSnap.docs) ? prospectsSnap.docs : [])
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.eliminado !== true);

    let invoicesCount = 0;
    let paymentsCount = 0;
    for (const p of activeProspects) {
      if (Array.isArray(p.facturas) && p.facturas.length > 0) {
        invoicesCount += p.facturas.filter(Boolean).length;
      } else if (p.factura_anticipo) {
        invoicesCount += 1;
      }
      if (Array.isArray(p.pagos) && p.pagos.length > 0) {
        paymentsCount += p.pagos.filter(Boolean).length;
      } else if (p.anticipo_pagado === true || (p.datos_cierre && p.datos_cierre.doc_comprobante)) {
        paymentsCount += 1;
      }
    }

    const contactIds = new Set();
    const accContactDocs = accContactsSnap && Array.isArray(accContactsSnap.docs) ? accContactsSnap.docs : [];
    for (const d of accContactDocs) {
      const r = d.data() || {};
      if (r.eliminado === true) continue;
      contactIds.add(r.contactId || d.id);
    }
    const legContactDocs = legacyContactsSnap && Array.isArray(legacyContactsSnap.docs) ? legacyContactsSnap.docs : [];
    for (const d of legContactDocs) {
      const c = d.data() || {};
      if (c.eliminado === true) continue;
      contactIds.add(d.id);
    }

    const ids = id.identifiersOf(accData);
    const docsCount = countClientDocuments(accData);
    const isNat = accData.tipo === 'natural';
    const razonSocial = isNat
      ? `${accData.nombres || ''} ${accData.apellidos || ''}`.trim()
      : (accData.empresa || accData.razonSocial || '');

    return {
      id: accId,
      roleInMerge, // 'absorbed' | 'canonical_survivor'
      roleLabel: roleInMerge === 'absorbed' ? 'Cuenta Origen (Será absorbida)' : 'Cuenta Destino (Sobrevivirá como cuenta canónica)',
      nombre: id.displayName(accData),
      displayName: id.displayName(accData),
      razonSocial,
      nombreComercial: accData.nombreComercial || accData.empresa || razonSocial,
      contacto: accData.contacto || '',
      repLegal: accData.rep_legal || '',
      tipo: accData.tipo || '',
      nit: accData.nit || '',
      nrc: accData.nrc || '',
      dui: accData.dui || '',
      nitNormalized: ids.nit.digits || '',
      nrcNormalized: ids.nrc.digits || '',
      duiNormalized: ids.dui.digits || '',
      isGranContribuyente: accData.is_gran_contribuyente === true,
      esExportacion: accData.es_exportacion === true,
      createdBy: accData.createdBy || null,
      visibleTo: Array.isArray(accData.visibleTo) ? [...accData.visibleTo] : [],
      closingVendors: Array.isArray(accData.closingVendors) ? [...accData.closingVendors] : [],
      responsibleSellers: {
        createdBy: accData.createdBy || null,
        visibleTo: Array.isArray(accData.visibleTo) ? [...accData.visibleTo] : [],
        closingVendors: Array.isArray(accData.closingVendors) ? [...accData.closingVendors] : []
      },
      contactsCount: contactIds.size,
      accountContactLinksCount: accContactDocs.length,
      opportunitiesCount: activeProspects.length,
      documentsCount: docsCount,
      billingSummary: {
        hasBillingHistory: invoicesCount > 0 || paymentsCount > 0,
        hasInvoices: invoicesCount > 0,
        hasPayments: paymentsCount > 0,
        invoicesCount,
        paymentsCount
      },
      fusionadaEn: accData.fusionada_en || null,
      directAbsorbedAccountIds: directAbsorbedIds || [],
      previouslyAbsorbedAccountIds: chainAbsorbedIds || [],
      previouslyAbsorbedIds: chainAbsorbedIds || []
    };
  }

  async function previewMerge({ caller, sourceId: rawSourceId, destinationId: rawDestinationId }) {
    await requireManagerForMerge(caller);

    const sourceId = typeof rawSourceId === 'string' ? rawSourceId.trim() : '';
    const destinationId = typeof rawDestinationId === 'string' ? rawDestinationId.trim() : '';
    if (!sourceId || !ACCOUNT_ID_RE.test(sourceId)) {
      throw new ServiceError('invalid-argument', 'Cuenta origen inválida');
    }
    if (!destinationId || !ACCOUNT_ID_RE.test(destinationId)) {
      throw new ServiceError('invalid-argument', 'Cuenta destino inválida');
    }
    if (sourceId === destinationId) {
      throw new ServiceError('invalid-argument', 'No se puede fusionar una cuenta consigo misma');
    }

    const [sourceSnap, destSnap, allClientsSnap] = await Promise.all([
      col('clients').doc(sourceId).get(),
      col('clients').doc(destinationId).get(),
      col('clients').get()
    ]);

    if (!sourceSnap || !sourceSnap.exists) {
      throw new ServiceError('not-found', `Cuenta origen '${sourceId}' no encontrada`);
    }
    if (!destSnap || !destSnap.exists) {
      throw new ServiceError('not-found', `Cuenta destino '${destinationId}' no encontrada`);
    }

    const sourceData = { id: sourceId, ...sourceSnap.data() };
    const destData = { id: destinationId, ...destSnap.data() };
    const allClients = (allClientsSnap && Array.isArray(allClientsSnap.docs) ? allClientsSnap.docs : [])
      .map(d => ({ id: d.id, ...d.data() }));

    const chainImpact = analyzeMergeChainImpact(allClients, sourceId, destinationId, sourceData, destData);
    const identityValidation = validateLegalIdentityForMerge(sourceData, destData, { enforceExecution: false });

    const directSourceAbsorbed = allClients.filter(c => c.fusionada_en === sourceId).map(c => c.id);
    const directDestAbsorbed = allClients.filter(c => c.fusionada_en === destinationId).map(c => c.id);

    const [sourceSummary, destinationSummary] = await Promise.all([
      buildAccountMergeComparisonItem(sourceId, sourceData, 'absorbed', directSourceAbsorbed, chainImpact.incomingToSourceIds),
      buildAccountMergeComparisonItem(destinationId, destData, 'canonical_survivor', directDestAbsorbed, chainImpact.incomingToDestinationIds)
    ]);

    const blockingReasons = [
      ...chainImpact.blockingReasons,
      ...identityValidation.blockingReasons
    ];
    const warnings = [
      MERGE_PERMISSION_WARNING,
      ...identityValidation.warnings
    ];

    const stateHash = computeMergePairStateHash(sourceData, destData);

    const isReady = blockingReasons.length === 0;
    const combinedLegalIdentity = {
      ...identityValidation,
      allowed: isReady,
      blockingReasons,
      requiresManualVerification: identityValidation.requiresDocumentedVerification,
      message: !isReady
        ? blockingReasons.join(' ')
        : (identityValidation.warnings.length > 0
          ? identityValidation.warnings.join(' ')
          : 'Identificadores fiscales compatibles para fusión administrativa.')
    };

    return {
      status: isReady ? 'ready' : 'blocked',
      canMerge: isReady,
      canProceed: isReady,
      survivingAccountId: destinationId,
      absorbedAccountId: sourceId,
      source: sourceSummary,
      destination: destinationSummary,
      identityValidation,
      legalIdentity: combinedLegalIdentity,
      chainImpact,
      blockingReasons,
      warnings,
      permissionWarning: MERGE_PERMISSION_WARNING,
      warningMessage: MERGE_PERMISSION_WARNING,
      stateHash
    };
  }

  async function recordMergeRejectionAudit(caller, sourceId, destinationId, reason, detail = {}) {
    try {
      const entry = buildAuditEntry(caller, 'clientAccountMergeRejected', destinationId || null, {
        sourceId: sourceId || null,
        destinationId: destinationId || null,
        reason,
        ...detail
      });
      await col('audit').doc().set(entry);
    } catch (_) {
      // Non-blocking audit write on rejection
    }
  }

  async function mergeAccounts({
    caller,
    sourceId: rawSourceId,
    destinationId: rawDestinationId,
    justification: rawJustification,
    legalIdentityVerified = false,
    verificationEvidence: rawEvidence = '',
    expectedStateHash = null,
    sameCorporateGroupOnly = false,
    opId
  }) {
    await requireManagerForMerge(caller);

    const sourceId = typeof rawSourceId === 'string' ? rawSourceId.trim() : '';
    const destinationId = typeof rawDestinationId === 'string' ? rawDestinationId.trim() : '';
    if (!sourceId || !ACCOUNT_ID_RE.test(sourceId)) {
      throw new ServiceError('invalid-argument', 'Cuenta origen inválida');
    }
    if (!destinationId || !ACCOUNT_ID_RE.test(destinationId)) {
      throw new ServiceError('invalid-argument', 'Cuenta destino inválida');
    }
    if (sourceId === destinationId) {
      throw new ServiceError('invalid-argument', 'No se puede fusionar una cuenta consigo misma');
    }
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(opId)) {
      throw new ServiceError('invalid-argument', 'opId requerido');
    }

    const cleanJustification = typeof rawJustification === 'string' ? rawJustification.trim().slice(0, 1000) : '';
    if (cleanJustification.length < 5) {
      const msg = 'La justificación gerencial de fusión es obligatoria (mínimo 5 caracteres)';
      await recordMergeRejectionAudit(caller, sourceId, destinationId, msg, { opId, code: 'invalid-argument' });
      throw new ServiceError('invalid-argument', msg);
    }
    const cleanEvidence = typeof rawEvidence === 'string' ? rawEvidence.trim().slice(0, 1000) : '';

    const payloadHash = stableHash({
      kind: 'mergeAccounts',
      sourceId,
      destinationId,
      justification: cleanJustification,
      legalIdentityVerified: Boolean(legalIdentityVerified),
      verificationEvidence: cleanEvidence
    });

    const opRef = col('ops').doc(opId);
    const prevOpSnap = await opRef.get();
    if (prevOpSnap.exists) {
      const prevOp = prevOpSnap.data() || {};
      if (prevOp.payloadHash !== payloadHash) {
        throw new ServiceError('failed-precondition', 'opId ya usado con otros parámetros de fusión');
      }
      if (prevOp.createdBy !== caller.cid) {
        throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
      }
      return {
        status: 'merged',
        replay: true,
        opId,
        auditId: prevOp.auditId || null,
        sourceId,
        destinationId,
        canonicalId: destinationId,
        canonicalAccountId: destinationId,
        absorbedAccountId: sourceId
      };
    }

    const allClientsSnap = await col('clients').get();
    const allClients = (allClientsSnap && Array.isArray(allClientsSnap.docs) ? allClientsSnap.docs : [])
      .map(d => ({ id: d.id, ...d.data() }));

    const preChainImpact = analyzeMergeChainImpact(
      allClients,
      sourceId,
      destinationId,
      allClients.find(c => c.id === sourceId) || null,
      allClients.find(c => c.id === destinationId) || null
    );
    const dependentChainIds = Array.from(new Set([
      ...preChainImpact.incomingToSourceIds,
      ...preChainImpact.incomingToDestinationIds
    ])).filter(cid => cid !== sourceId && cid !== destinationId);

    const nowIso = now().toISOString();

    let txOutcome;
    try {
      txOutcome = await db.runTransaction(async tx => {
        // 1) All reads first
        const opSnap = await tx.get(opRef);
        if (opSnap.exists) {
          return { replay: opSnap.data() };
        }

        const sourceRef = col('clients').doc(sourceId);
        const destRef = col('clients').doc(destinationId);
        const sourceSnap = await tx.get(sourceRef);
        const destSnap = await tx.get(destRef);

        if (!sourceSnap || !sourceSnap.exists) {
          throw new ServiceError('not-found', `Cuenta origen '${sourceId}' no encontrada`);
        }
        if (!destSnap || !destSnap.exists) {
          throw new ServiceError('not-found', `Cuenta destino '${destinationId}' no encontrada`);
        }

        const sourceData = { id: sourceId, ...sourceSnap.data() };
        const destData = { id: destinationId, ...destSnap.data() };

        // Read dependent chain accounts inside transaction to detect concurrent chain modifications
        const freshMap = new Map(allClients.map(c => [c.id, c]));
        freshMap.set(sourceId, sourceData);
        freshMap.set(destinationId, destData);
        for (const depId of dependentChainIds) {
          const depSnap = await tx.get(col('clients').doc(depId));
          if (depSnap && depSnap.exists) {
            freshMap.set(depId, { id: depId, ...depSnap.data() });
          }
        }

        // Idempotent check if already merged to the same destination
        if (sourceData.fusionada_en === destinationId) {
          if (sourceData.merge_meta && sourceData.merge_meta.opId === opId) {
            return {
              replay: {
                payloadHash,
                createdBy: caller.cid,
                auditId: sourceData.merge_meta.auditId || null
              }
            };
          }
          return {
            alreadyMerged: {
              status: 'already-merged',
              sourceId,
              destinationId,
              canonicalId: destinationId,
              canonicalAccountId: destinationId,
              absorbedAccountId: sourceId
            }
          };
        }

        // Verify state hasn't changed incompatibly since preview
        if (expectedStateHash && typeof expectedStateHash === 'string' && expectedStateHash.trim()) {
          const currentHash = computeMergePairStateHash(sourceData, destData);
          if (currentHash !== expectedStateHash.trim()) {
            throw new ServiceError(
              'failed-precondition',
              'El estado o la identidad fiscal de una de las cuentas cambió desde la vista previa. Recargue la vista previa antes de confirmar.'
            );
          }
        }

        // Validate chain/cycle/depth inside transaction
        const txChainImpact = analyzeMergeChainImpact(Array.from(freshMap.values()), sourceId, destinationId, sourceData, destData);
        if (txChainImpact.blockingReasons.length > 0) {
          throw new ServiceError('failed-precondition', txChainImpact.blockingReasons[0]);
        }

        // Validate legal identity inside transaction
        const txIdentity = validateLegalIdentityForMerge(sourceData, destData, {
          justification: cleanJustification,
          legalIdentityVerified: Boolean(legalIdentityVerified),
          verificationEvidence: cleanEvidence,
          sameCorporateGroupOnly: Boolean(sameCorporateGroupOnly),
          enforceExecution: true
        });
        if (!txIdentity.valid) {
          throw new ServiceError('failed-precondition', txIdentity.blockingReasons[0]);
        }

        // Read fiscal identifier index docs (`clientIdentifiers_{suffix}`) before any writes
        const sourceKeys = id.keysOf(sourceData);
        const destKeys = id.keysOf(destData);
        const allKeys = Array.from(new Set([...sourceKeys, ...destKeys]));
        const allowedOwnerIds = new Set([
          sourceId,
          destinationId,
          ...txChainImpact.incomingToSourceIds,
          ...txChainImpact.incomingToDestinationIds
        ]);

        const existingIndexDocs = new Map();
        for (const k of allKeys) {
          const idxSnap = await tx.get(col('identifiers').doc(k));
          if (idxSnap && idxSnap.exists) {
            const idxData = idxSnap.data() || {};
            const ownerId = idxData.clientId;
            if (ownerId && !allowedOwnerIds.has(ownerId)) {
              const ownerSnap = await tx.get(col('clients').doc(ownerId));
              if (ownerSnap && ownerSnap.exists) {
                const ownerData = ownerSnap.data() || {};
                const ownerMergedInto = typeof ownerData.fusionada_en === 'string' ? ownerData.fusionada_en.trim() : '';
                if (ownerMergedInto !== sourceId && ownerMergedInto !== destinationId) {
                  throw new ServiceError(
                    'failed-precondition',
                    `Inconsistencia de índice fiscal: el identificador '${k}' pertenece a otra cuenta activa (${ownerId}).`
                  );
                }
              }
            }
            existingIndexDocs.set(k, idxData);
          }
        }

        // 2) Writes (atomic update of source account, fiscal identifier index, audit log, and opId record)
        const auditRef = col('audit').doc();
        const mergeMeta = {
          opId,
          auditId: auditRef.id,
          sourceId,
          destinationId,
          mergedAt: nowIso,
          mergedByCid: caller.cid,
          mergedByUid: caller.uid,
          mergedByName: caller.name || '',
          justification: cleanJustification,
          legalIdentityVerified: Boolean(legalIdentityVerified),
          verificationEvidence: cleanEvidence || null,
          identityBasis: txIdentity.identityStatus
        };

        tx.update(sourceRef, {
          fusionada_en: destinationId,
          fusionada_at: nowIso,
          fusionada_por: caller.cid,
          fusionada_por_uid: caller.uid,
          fusionada_por_nombre: caller.name || '',
          fusionada_motivo: cleanJustification,
          estado_cuenta: 'fusionada',
          merge_meta: mergeMeta
        });

        // Update fiscal identifier locks so all source/destination keys resolve to canonical destinationId
        const sourceKeySet = new Set(sourceKeys);
        for (const k of allKeys) {
          const prevIdx = existingIndexDocs.get(k) || {};
          const fromSource = sourceKeySet.has(k);
          tx.set(col('identifiers').doc(k), {
            key: k,
            kind: k.split('_')[0],
            clientId: destinationId,
            ...(fromSource ? { absorbedClientId: sourceId } : (prevIdx.absorbedClientId ? { absorbedClientId: prevIdx.absorbedClientId } : {})),
            createdBy: destData.createdBy || sourceData.createdBy || caller.cid,
            createdAt: prevIdx.createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            mergedByOpId: opId
          });
        }

        const srcIds = id.identifiersOf(sourceData);
        const dstIds = id.identifiersOf(destData);
        const auditDoc = {
          action: 'clientAccountMerged',
          targetType: 'client',
          targetId: destinationId,
          targetClientId: destinationId,
          sourceId,
          destinationId,
          opId,
          actorUid: caller.uid,
          actorCid: caller.cid,
          actorName: caller.name || '',
          actorRole: caller.role,
          at: FieldValue.serverTimestamp(),
          atIso: nowIso,
          justification: cleanJustification,
          result: 'merged',
          detail: {
            opId,
            sourceId,
            destinationId,
            sourceAccountId: sourceId,
            destinationAccountId: destinationId,
            canonicalId: destinationId,
            justification: cleanJustification,
            legalIdentityVerified: Boolean(legalIdentityVerified),
            verificationEvidence: cleanEvidence || null,
            identityValidation: {
              identityStatus: txIdentity.identityStatus,
              hasExactFiscalMatch: txIdentity.hasExactFiscalMatch,
              sameNit: txIdentity.sameNit,
              sameNrc: txIdentity.sameNrc,
              sameDui: txIdentity.sameDui,
              nameComparison: txIdentity.nameComparison
            },
            chainImpact: {
              incomingToSourceIds: txChainImpact.incomingToSourceIds,
              incomingMaxDepth: txChainImpact.incomingMaxDepth,
              resultingMaxDepth: txChainImpact.resultingMaxDepth
            },
            updatedIdentifierKeys: allKeys,
            sourceSnapshot: {
              id: sourceId,
              nombre: id.displayName(sourceData),
              tipo: sourceData.tipo || '',
              nitHint: id.maskDigits(srcIds.nit.digits, 'NIT'),
              nrcHint: id.maskDigits(srcIds.nrc.digits, 'NRC'),
              duiHint: id.maskDigits(srcIds.dui.digits, 'DUI'),
              createdBy: sourceData.createdBy || null,
              visibleTo: Array.isArray(sourceData.visibleTo) ? [...sourceData.visibleTo] : [],
              closingVendors: Array.isArray(sourceData.closingVendors) ? [...sourceData.closingVendors] : []
            },
            destinationSnapshot: {
              id: destinationId,
              nombre: id.displayName(destData),
              tipo: destData.tipo || '',
              nitHint: id.maskDigits(dstIds.nit.digits, 'NIT'),
              nrcHint: id.maskDigits(dstIds.nrc.digits, 'NRC'),
              duiHint: id.maskDigits(dstIds.dui.digits, 'DUI'),
              createdBy: destData.createdBy || null,
              visibleTo: Array.isArray(destData.visibleTo) ? [...destData.visibleTo] : [],
              closingVendors: Array.isArray(destData.closingVendors) ? [...destData.closingVendors] : []
            }
          }
        };

        tx.create(auditRef, auditDoc);
        tx.create(opRef, {
          kind: 'mergeAccounts',
          status: 'succeeded',
          opId,
          sourceId,
          destinationId,
          canonicalId: destinationId,
          auditId: auditRef.id,
          payloadHash,
          createdBy: caller.cid,
          createdAt: FieldValue.serverTimestamp(),
          createdAtIso: nowIso
        });

        return {
          merged: {
            status: 'merged',
            opId,
            auditId: auditRef.id,
            sourceId,
            destinationId,
            canonicalId: destinationId,
            canonicalAccountId: destinationId,
            absorbedAccountId: sourceId,
            mergedAt: nowIso,
            updatedIdentifierKeys: allKeys,
            identityStatus: txIdentity.identityStatus
          }
        };
      });
    } catch (err) {
      if (err instanceof ServiceError) {
        await recordMergeRejectionAudit(caller, sourceId, destinationId, err.message, { opId, code: err.code });
      }
      throw err;
    }

    if (txOutcome.alreadyMerged) {
      return txOutcome.alreadyMerged;
    }

    if (txOutcome.replay) {
      if (txOutcome.replay.payloadHash !== payloadHash) {
        throw new ServiceError('failed-precondition', 'opId ya usado con otros parámetros de fusión');
      }
      if (txOutcome.replay.createdBy !== caller.cid) {
        throw new ServiceError('permission-denied', 'opId pertenece a otro usuario');
      }
      return {
        status: 'merged',
        replay: true,
        opId,
        auditId: txOutcome.replay.auditId || null,
        sourceId,
        destinationId,
        canonicalId: destinationId,
        canonicalAccountId: destinationId,
        absorbedAccountId: sourceId
      };
    }

    invalidateCache();
    return txOutcome.merged;
  }

  /**
   * B4.3 / Compatibilidad B5-B6 (Account 360):
   * Resuelve la cuenta canónica y devuelve el conjunto completo de cuentas absorbidas que convergen en ella,
   * preservando el identificador de origen de cada cuenta para consultas consolidadas sin duplicación.
   */
  async function getCanonicalAccountCluster({ caller, accountId }) {
    const resolved = await boundResolveCanonicalAccount(accountId);
    if (!authorizeClientAccess(caller, resolved.canonicalData) && !(await isRelated(caller, resolved.canonicalId))) {
      throw new ServiceError('permission-denied', 'No tienes permiso para acceder a esta cuenta');
    }
    const allClientsSnap = await col('clients').get();
    const allClients = (allClientsSnap && Array.isArray(allClientsSnap.docs) ? allClientsSnap.docs : [])
      .map(d => ({ id: d.id, ...d.data() }));
    const byId = new Map(allClients.map(c => [c.id, c]));

    const absorbedAccounts = [];
    for (const c of allClients) {
      if (c.id === resolved.canonicalId) continue;
      if (!c.fusionada_en) continue;
      const r = resolveCanonicalFromMapSync(byId, c.id);
      if (r.canonicalId === resolved.canonicalId) {
        absorbedAccounts.push({
          id: c.id,
          fusionada_en: c.fusionada_en,
          fusionada_at: c.fusionada_at || null,
          fusionada_motivo: c.fusionada_motivo || null,
          chain: r.chain
        });
      }
    }

    const absorbedAccountIds = absorbedAccounts.map(a => a.id).sort();
    return {
      requestedAccountId: accountId,
      canonicalId: resolved.canonicalId,
      canonicalAccount: { id: resolved.canonicalId, ...resolved.canonicalData },
      isRequestedAbsorbed: resolved.isMerged,
      resolutionChain: resolved.chain,
      absorbedAccountIds,
      absorbedAccounts,
      allAccountIds: [resolved.canonicalId, ...absorbedAccountIds]
    };
  }

  return {
    names, resolveCaller, create, reserveCreation, cancelReservation, finalizeCreation,
    update, search, recomputeVisibility, onProspectWrite, backfillVisibility, invalidateCache,
    resolveCanonicalAccount: boundResolveCanonicalAccount,
    authorizeClientAccess,
    previewMerge,
    mergeAccounts,
    getCanonicalAccountCluster,
    validateLegalIdentityForMerge,
    computeMergePairStateHash
  };
}

module.exports = {
  createClientsService,
  ServiceError,
  sanitizeClient,
  sanitizeDocumento,
  resolveDocumentsForUpdate,
  assertDocumentRemovalAllowed,
  docRefKey,
  countDocKeys,
  namesFor,
  stableHash,
  CRM_ROLES,
  PRIVILEGED,
  MAX_MERGE_DEPTH,
  isCallerActiveAndAuthenticated,
  authorizeClientAccess,
  resolveCanonicalAccount
};
