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

const DOC_KEY_SUBFOLDER_MAP = {
  dui: 'identificacion',
  escritura: 'legal',
  mods_escritura: 'legal',
  credencial: 'legal',
  nit: 'legal',
  nrc: 'legal',
  poder_firma_contrato: 'poderes'
};

const PROD_ALLOWED_BUCKETS = [
  'ductsal-erp.firebasestorage.app',
  'ductsal-erp.appspot.com'
];

const NON_PROD_ALLOWED_BUCKETS = [
  'demo-ductsal-isolated.appspot.com',
  'demo-ductsal-local.appspot.com'
];

function getExpectedStoragePrefix(suffix) {
  return suffix === '_prod' ? 'prod_files' : 'local_files';
}

function getAllowedBucketsForSuffix(suffix) {
  return suffix === '_prod' ? PROD_ALLOWED_BUCKETS : NON_PROD_ALLOWED_BUCKETS;
}

function reqString(val, name, max = 200) {
  if (val === undefined || val === null) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  const s = String(val).trim();
  if (!s) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  if (s.length > max) throw new ServiceError('invalid-argument', `${name} no puede superar los ${max} caracteres`);
  return s;
}

function optMaxString(val, name, max = 500) {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string' && typeof val !== 'number') {
    throw new ServiceError('invalid-argument', `${name} debe ser una cadena de texto válida`);
  }
  const s = String(val).trim();
  if (!s) return null;
  if (s.length > max) {
    throw new ServiceError('invalid-argument', `${name} no puede superar los ${max} caracteres`);
  }
  return s;
}

function sanitizeSha256(val) {
  if (!val || typeof val !== 'string') return null;
  const clean = val.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : null;
}

function validateOptionalSha256(val, label = 'sha256') {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val !== 'string') {
    throw new ServiceError('invalid-argument', `${label} debe ser un hash hexadecimal válido de 64 caracteres`);
  }
  const clean = val.trim();
  if (!/^[a-f0-9]{64}$/i.test(clean)) {
    throw new ServiceError('invalid-argument', `${label} debe ser un hash hexadecimal válido de 64 caracteres`);
  }
  return clean.toLowerCase();
}

function validateOptionalSize(val, label = 'size') {
  if (val === undefined || val === null || val === '') return null;
  let num;
  if (typeof val === 'number') {
    num = val;
  } else if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new ServiceError('invalid-argument', `${label} debe ser un entero positivo y finito`);
    }
    num = Number(trimmed);
  } else {
    throw new ServiceError('invalid-argument', `${label} debe ser un entero positivo y finito`);
  }
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0 || num > Number.MAX_SAFE_INTEGER) {
    throw new ServiceError('invalid-argument', `${label} debe ser un entero positivo y finito`);
  }
  return num;
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

function extractObjectPathFromAuthorizedStorageUrl(rawUrl, {
  suffix,
  allowedBuckets,
  errorCode = 'invalid-argument',
  label = 'documento'
}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: URL vacía o inválida`);
  }
  const s = rawUrl.trim();
  if (
    s.length > 2048 ||
    /[\x00-\x1f\x7f\\]/.test(s) ||
    /%2e/i.test(s) ||
    /%5c/i.test(s) ||
    /%00/i.test(s) ||
    s.includes('..')
  ) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: URL con secuencias prohibidas`);
  }

  if (s.startsWith('gs://')) {
    const match = s.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: URL gs:// malformada`);
    }
    const bucketName = match[1];
    const rawObjPath = match[2];
    if (!allowedBuckets.includes(bucketName)) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: bucket '${bucketName}' no autorizado para el entorno`);
    }
    if (/%2f/i.test(rawObjPath) || rawObjPath.includes('//') || rawObjPath.includes('..')) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta gs:// con secuencias prohibidas`);
    }
    try {
      return decodeURIComponent(rawObjPath);
    } catch (_) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: codificación URI inválida`);
    }
  }

  if (s.startsWith('https://') || s.startsWith('http://')) {
    let parsed;
    try {
      parsed = new URL(s);
    } catch (_) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: URL malformada`);
    }

    const isLocalEmulatorHost = suffix !== '_prod' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalEmulatorHost)) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: protocolo '${parsed.protocol}' no permitido`);
    }

    if (parsed.hostname === 'firebasestorage.googleapis.com' || isLocalEmulatorHost) {
      const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/([^/]+)$/);
      if (!match) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: estructura de ruta Firebase Storage inválida`);
      }
      let bucketName;
      let decodedPath;
      try {
        bucketName = decodeURIComponent(match[1]);
        const encodedObjPath = match[2];
        if (/%2f%2f/i.test(encodedObjPath) || encodedObjPath.includes('..')) {
          throw new Error('Traversal or double slash');
        }
        decodedPath = decodeURIComponent(encodedObjPath);
      } catch (_) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta codificada inválida`);
      }
      if (!allowedBuckets.includes(bucketName)) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: bucket '${bucketName}' no autorizado para el entorno`);
      }
      return decodedPath;
    }

    if (parsed.hostname === 'storage.googleapis.com') {
      const match = parsed.pathname.match(/^\/([^/]+)\/(.+)$/);
      if (!match) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: estructura de ruta GCS inválida`);
      }
      let bucketName;
      let decodedPath;
      try {
        bucketName = decodeURIComponent(match[1]);
        const rawObjPath = match[2];
        if (/%2f/i.test(rawObjPath) || rawObjPath.includes('//') || rawObjPath.includes('..')) {
          throw new Error('Invalid GCS path');
        }
        decodedPath = decodeURIComponent(rawObjPath);
      } catch (_) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta GCS codificada inválida`);
      }
      if (!allowedBuckets.includes(bucketName)) {
        throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: bucket '${bucketName}' no autorizado para el entorno`);
      }
      return decodedPath;
    }

    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: host externo no autorizado ('${parsed.hostname}')`);
  }

  throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: formato de URL no reconocido`);
}

function validateCanonicalStoragePath(candidatePath, {
  accountId,
  docKey,
  suffix,
  allowHistoricalBase = false,
  errorCode = 'invalid-argument',
  label = 'documento'
}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta vacía`);
  }
  const raw = candidatePath.trim();
  if (
    raw.length > 500 ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    raw.includes('..') ||
    raw.includes('//') ||
    raw.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    /%2e/i.test(raw) ||
    /%2f/i.test(raw) ||
    /%5c/i.test(raw) ||
    /%00/i.test(raw) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
  ) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta malformada o con secuencias prohibidas`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: codificación URI inválida en ruta`);
  }

  if (
    !decoded ||
    decoded.startsWith('/') ||
    decoded.endsWith('/') ||
    decoded.includes('..') ||
    decoded.includes('//') ||
    decoded.includes('\\') ||
    decoded.includes('%') ||
    /[\x00-\x1f\x7f]/.test(decoded)
  ) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: ruta decodificada inválida`);
  }

  const segments = decoded.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..')) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: segmentos de ruta inválidos`);
  }

  const expectedPrefix = getExpectedStoragePrefix(suffix);
  if (segments[0] !== expectedPrefix) {
    throw new ServiceError(
      errorCode,
      `El ${label} no cuenta con un archivo válido en Storage: prefijo de entorno '${segments[0]}' no coincide con '${expectedPrefix}'`
    );
  }

  const expectedSubfolder = DOC_KEY_SUBFOLDER_MAP[docKey];
  if (!expectedSubfolder) {
    throw new ServiceError(errorCode, `Clave documental '${docKey}' no reconocida para validación de Storage`);
  }

  const fileName = segments[segments.length - 1];
  if (!fileName || fileName.length > 200 || fileName === '.' || fileName === '..') {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: nombre de archivo inválido`);
  }

  if (!allowHistoricalBase) {
    if (segments.length !== 5 || segments[1] !== 'clients') {
      throw new ServiceError(
        errorCode,
        `El ${label} no cuenta con un archivo válido en Storage: la ruta debe seguir la jerarquía '${expectedPrefix}/clients/${accountId}/${expectedSubfolder}/<archivo>'`
      );
    }
    if (segments[2] !== accountId) {
      throw new ServiceError(
        errorCode,
        `El ${label} no cuenta con un archivo válido en Storage: la ruta pertenece a otra cuenta ('${segments[2]}' !== '${accountId}')`
      );
    }
    if (segments[3] !== expectedSubfolder) {
      throw new ServiceError(
        errorCode,
        `El ${label} no cuenta con un archivo válido en Storage: subcarpeta '${segments[3]}' inválida para '${docKey}' (se esperaba '${expectedSubfolder}')`
      );
    }
    return decoded;
  }

  // Historical v_base compatibility: allow canonical 5-segment path, legacy 4-segment same-account path, or legacy 3-segment flat 'clientes' path
  const isCanonical = segments.length === 5 && segments[1] === 'clients' && segments[2] === accountId && segments[3] === expectedSubfolder;
  const isLegacySameAccount = segments.length === 4 && segments[1] === 'clients' && segments[2] === accountId;
  const isLegacyFlatClientes = segments.length === 3 && segments[1] === 'clientes';

  if (!isCanonical && !isLegacySameAccount && !isLegacyFlatClientes) {
    throw new ServiceError(
      errorCode,
      `El ${label} no cuenta con un archivo válido en Storage perteneciente a la cuenta '${accountId}'`
    );
  }

  return decoded;
}

function validateAndNormalizeStorageDoc(doc, {
  accountId,
  docKey,
  suffix,
  allowHistoricalBase = false,
  defaultName = 'Documento',
  overrideFechaEmision = undefined,
  overrideFechaVencimiento = undefined,
  errorCode = 'invalid-argument',
  label = 'documento'
}) {
  if (!doc) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage (storagePath o url)`);
  }

  let docObj = doc;
  if (allowHistoricalBase && typeof doc === 'string') {
    const trimmed = doc.trim();
    if (!trimmed) {
      throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage (storagePath o url)`);
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      docObj = { url: trimmed };
    } else {
      docObj = { storagePath: trimmed };
    }
  }

  if (typeof docObj !== 'object' || Array.isArray(docObj)) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage (storagePath o url)`);
  }

  if (docObj.storagePath !== undefined && docObj.storagePath !== null && typeof docObj.storagePath !== 'string') {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: storagePath de tipo inválido`);
  }
  if (docObj.path !== undefined && docObj.path !== null && typeof docObj.path !== 'string') {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: path de tipo inválido`);
  }
  if (docObj.url !== undefined && docObj.url !== null && typeof docObj.url !== 'string') {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: url de tipo inválido`);
  }

  const sp1 = typeof docObj.storagePath === 'string' ? docObj.storagePath.trim() : '';
  const sp2 = typeof docObj.path === 'string' ? docObj.path.trim() : '';
  if (sp1 && sp2 && sp1 !== sp2) {
    throw new ServiceError(errorCode, `El ${label} no cuenta con un archivo válido en Storage: conflicto entre storagePath y path`);
  }
  const rawStoragePath = sp1 || sp2 || null;
  const rawUrl = typeof docObj.url === 'string' && docObj.url.trim() ? docObj.url.trim() : null;

  if (!rawStoragePath && !rawUrl) {
    throw new ServiceError(
      errorCode,
      `El ${label} no cuenta con un archivo válido en Storage (storagePath o url)`
    );
  }

  const allowedBuckets = getAllowedBucketsForSuffix(suffix);
  let pathFromStoragePath = null;
  let pathFromUrl = null;

  if (rawStoragePath) {
    pathFromStoragePath = validateCanonicalStoragePath(rawStoragePath, {
      accountId,
      docKey,
      suffix,
      allowHistoricalBase,
      errorCode,
      label
    });
  }

  if (rawUrl) {
    const extracted = extractObjectPathFromAuthorizedStorageUrl(rawUrl, {
      suffix,
      allowedBuckets,
      errorCode,
      label
    });
    pathFromUrl = validateCanonicalStoragePath(extracted, {
      accountId,
      docKey,
      suffix,
      allowHistoricalBase,
      errorCode,
      label
    });
  }

  if (pathFromStoragePath && pathFromUrl && pathFromStoragePath !== pathFromUrl) {
    throw new ServiceError(
      errorCode,
      `El ${label} no cuenta con un archivo válido en Storage: storagePath y url apuntan a rutas distintas`
    );
  }

  const canonicalStoragePath = pathFromStoragePath || pathFromUrl;
  const cleanUrl = rawUrl || null;
  const cleanName = optMaxString(docObj.name, `nombre de ${label}`, 200) || defaultName;
  const cleanContentType = optMaxString(docObj.contentType, `contentType de ${label}`, 120);
  const cleanSha256 = validateOptionalSha256(docObj.sha256, `sha256 de ${label}`);
  const cleanSize = validateOptionalSize(docObj.size, `size de ${label}`);

  const effectiveEmision = overrideFechaEmision !== undefined
    ? overrideFechaEmision
    : sanitizeDate(docObj.fechaEmision, `fechaEmision de ${label}`);
  const effectiveVencimiento = overrideFechaVencimiento !== undefined
    ? overrideFechaVencimiento
    : sanitizeDate(docObj.fechaVencimiento, `fechaVencimiento de ${label}`);

  return {
    name: cleanName,
    storagePath: canonicalStoragePath,
    url: cleanUrl,
    size: cleanSize,
    contentType: cleanContentType,
    sha256: cleanSha256,
    fechaEmision: effectiveEmision || null,
    fechaVencimiento: effectiveVencimiento || null
  };
}

function canonicalizeValue(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'boolean') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(item => canonicalizeValue(item));
  }
  if (typeof val === 'object') {
    const sortedKeys = Object.keys(val).sort();
    const out = {};
    for (const k of sortedKeys) {
      out[k] = canonicalizeValue(val[k]);
    }
    return out;
  }
  return String(val);
}

function computeOperationFingerprint(action, semanticPayload) {
  const canonical = canonicalizeValue({
    action,
    payload: semanticPayload
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function createAccountDocumentsService({ db, FieldValue, bucket = null, suffix = '_prod' }) {
  if (!db) throw new Error('db is required');
  if (!FieldValue) throw new Error('FieldValue is required');

  const names = namesFor(suffix);
  const col = k => db.collection(names[k]);

  async function assertStorageObjectExists(storagePath, label = 'documento') {
    if (!storagePath || typeof storagePath !== 'string') {
      throw new ServiceError(
        'failed-precondition',
        `El ${label} no cuenta con un archivo válido en Storage (storagePath nulo)`
      );
    }
    if (!bucket || typeof bucket.file !== 'function') {
      throw new ServiceError(
        'failed-precondition',
        `Servicio de almacenamiento (Storage bucket) no disponible para verificar la existencia física de ${label}`
      );
    }
    const fileRef = bucket.file(storagePath);
    if (!fileRef || typeof fileRef.exists !== 'function') {
      throw new ServiceError(
        'failed-precondition',
        `Referencia de archivo Storage inválida para ${label}`
      );
    }
    const existsRes = await fileRef.exists();
    const exists = Array.isArray(existsRes) ? Boolean(existsRes[0]) : Boolean(existsRes);
    if (!exists) {
      throw new ServiceError(
        'failed-precondition',
        `El archivo referenciado en Storage ('${storagePath}') para ${label} no existe físicamente en el bucket`
      );
    }
  }

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
    const cleanAccountId = reqString(accountId, 'accountId', 128);
    if (!DOC_ID_RE.test(cleanAccountId)) {
      throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
    }
    const cleanNombre = reqString(nombre, 'nombre del representante legal', 200);
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

    const cleanOpId = opId ? reqString(opId, 'opId', 128) : null;
    if (cleanOpId && !DOC_ID_RE.test(cleanOpId)) {
      throw new ServiceError('invalid-argument', 'Identificador de operación (opId) inválido');
    }

    const cleanContactId = optMaxString(contactId, 'contactId', 128);
    const cleanDuiExpiry = duiDoc.fechaVencimiento ? sanitizeDate(duiDoc.fechaVencimiento, 'fechaVencimiento DUI') : null;

    return db.runTransaction(async tx => {
      // 1. Cargar primero clientRef y autorizar acceso a la cuenta antes de evaluar documentos o idempotencia
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const cleanCredDoc = validateAndNormalizeStorageDoc(credencialDoc, {
        accountId: cleanAccountId,
        docKey: 'credencial',
        suffix,
        defaultName: 'Credencial de Elección',
        overrideFechaEmision: cleanFechaEleccion,
        overrideFechaVencimiento: cleanFechaVencimiento,
        label: 'credencial del representante legal'
      });

      const cleanDuiDoc = validateAndNormalizeStorageDoc(duiDoc, {
        accountId: cleanAccountId,
        docKey: 'dui',
        suffix,
        defaultName: 'DUI Representante Legal',
        overrideFechaEmision: null,
        overrideFechaVencimiento: cleanDuiExpiry,
        label: 'DUI del representante legal'
      });

      const payloadHash = cleanOpId ? computeOperationFingerprint('registerLegalRepresentativeTerm', {
        callerCid: caller.cid,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        nombre: cleanNombre,
        fechaEleccion: cleanFechaEleccion,
        fechaInicio: cleanFechaInicio,
        fechaVencimiento: cleanFechaVencimiento,
        credencialDoc: cleanCredDoc,
        duiDoc: cleanDuiDoc
      }) : null;

      const opRef = cleanOpId ? col('ops').doc(`rl_term_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;
      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        const isMismatch = prevOp.payloadHash
          ? (prevOp.callerCid !== caller.cid || prevOp.payloadHash !== payloadHash)
          : (
              prevOp.callerCid !== caller.cid ||
              prevOp.accountId !== cleanAccountId ||
              prevOp.nombre !== cleanNombre ||
              prevOp.fechaEleccion !== cleanFechaEleccion ||
              (prevOp.contactId !== undefined && prevOp.contactId !== cleanContactId) ||
              (prevOp.fechaVencimiento !== undefined && prevOp.fechaVencimiento !== cleanFechaVencimiento)
            );
        if (isMismatch) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
      }

      const clientTermsCol = clientRef.collection('legal_representative_terms');
      const clientPowersCol = clientRef.collection('contract_powers');
      const clientVersionsCol = clientRef.collection('document_versions');

      // 2. Read existing active term (if any)
      const activeTermsSnap = await tx.get(clientTermsCol.where('estado', '==', 'vigente'));
      const previousActiveTerm = !activeTermsSnap.empty ? { id: activeTermsSnap.docs[0].id, ...activeTermsSnap.docs[0].data() } : null;

      // 3. Read all currently active contract powers to invalidate them
      const activePowersSnap = await tx.get(clientPowersCol.where('estado', '==', 'vigente'));
      const powersToInvalidate = [];
      activePowersSnap.forEach(d => {
        powersToInvalidate.push({ id: d.id, ref: d.ref, ...d.data() });
      });

      // 4. Verify physical existence of both files in Firebase Storage before any Firestore write
      await assertStorageObjectExists(cleanCredDoc.storagePath, 'credencial del representante legal');
      await assertStorageObjectExists(cleanDuiDoc.storagePath, 'DUI del representante legal');

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

      // 5. Atomically invalidate all powers granted under previous election
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

      // 6. Register version for Credencial (exact normalized fields used in payloadHash)
      const credVersionId = `v_cred_${Date.now()}_${rand}`;
      const credRecord = {
        versionId: credVersionId,
        versionNumber: (client.documentos && client.documentos.credencial && client.documentos.credencial.versionNumber) ? (client.documentos.credencial.versionNumber + 1) : 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: 'credencial',
        name: cleanCredDoc.name,
        storagePath: cleanCredDoc.storagePath,
        url: cleanCredDoc.url,
        size: cleanCredDoc.size,
        contentType: cleanCredDoc.contentType,
        sha256: cleanCredDoc.sha256,
        fechaEmision: cleanCredDoc.fechaEmision,
        fechaVencimiento: cleanCredDoc.fechaVencimiento,
        termId: newTermId,
        estado: 'vigente',
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(credVersionId), credRecord);

      // 7. Register version for DUI (exact normalized fields used in payloadHash)
      const duiVersionId = `v_dui_${Date.now()}_${rand}`;
      const duiRecord = {
        versionId: duiVersionId,
        versionNumber: (client.documentos && client.documentos.dui && client.documentos.dui.versionNumber) ? (client.documentos.dui.versionNumber + 1) : 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: 'dui',
        name: cleanDuiDoc.name,
        storagePath: cleanDuiDoc.storagePath,
        url: cleanDuiDoc.url,
        size: cleanDuiDoc.size,
        contentType: cleanDuiDoc.contentType,
        sha256: cleanDuiDoc.sha256,
        fechaEmision: cleanDuiDoc.fechaEmision,
        fechaVencimiento: cleanDuiDoc.fechaVencimiento,
        termId: newTermId,
        estado: 'vigente',
        subidoPorId: caller.cid,
        subidoPorNombre: caller.name,
        subidoPorRol: caller.role,
        creadoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientVersionsCol.doc(duiVersionId), duiRecord);

      // 8. Store new term document
      const newTermData = {
        id: newTermId,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        nombre: cleanNombre,
        fechaEleccion: cleanFechaEleccion,
        fechaInicio: cleanFechaInicio,
        fechaVencimiento: cleanFechaVencimiento,
        credencialDoc: {
          name: credRecord.name,
          storagePath: credRecord.storagePath,
          url: credRecord.url,
          size: credRecord.size,
          contentType: credRecord.contentType,
          versionId: credVersionId,
          versionNumber: credRecord.versionNumber,
          sha256: credRecord.sha256,
          fechaEmision: credRecord.fechaEmision,
          fechaVencimiento: credRecord.fechaVencimiento
        },
        duiDoc: {
          name: duiRecord.name,
          storagePath: duiRecord.storagePath,
          url: duiRecord.url,
          size: duiRecord.size,
          contentType: duiRecord.contentType,
          versionId: duiVersionId,
          versionNumber: duiRecord.versionNumber,
          sha256: duiRecord.sha256,
          fechaEmision: duiRecord.fechaEmision,
          fechaVencimiento: duiRecord.fechaVencimiento
        },
        estado: 'vigente',
        invalidatedPowersCount: powersToInvalidate.length,
        registradoPor: caller.cid,
        registradoPorNombre: caller.name,
        registradoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientTermsCol.doc(newTermId), newTermData);

      // 9. Update client root document
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

      const resultPayload = {
        success: true,
        termId: newTermId,
        invalidatedPowersCount: powersToInvalidate.length,
        estado: 'vigente',
        nombre: cleanNombre,
        credencialVersionId: credVersionId,
        duiVersionId: duiVersionId
      };

      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          action: 'registerLegalRepresentativeTerm',
          accountId: cleanAccountId,
          contactId: cleanContactId,
          nombre: cleanNombre,
          fechaEleccion: cleanFechaEleccion,
          fechaInicio: cleanFechaInicio,
          fechaVencimiento: cleanFechaVencimiento,
          payloadHash,
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
    const cleanAccountId = reqString(accountId, 'accountId', 128);
    if (!DOC_ID_RE.test(cleanAccountId)) {
      throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
    }
    const cleanContactId = reqString(contactId, 'contactId', 128);

    const effectiveDoc = documento || documentoDoc;
    if (!effectiveDoc || typeof effectiveDoc !== 'object') {
      throw new ServiceError('invalid-argument', 'Debe adjuntar el documento que acredita el poder para firma de contratos');
    }

    const cleanOpId = opId ? reqString(opId, 'opId', 128) : null;
    if (cleanOpId && !DOC_ID_RE.test(cleanOpId)) {
      throw new ServiceError('invalid-argument', 'Identificador de operación (opId) inválido');
    }

    const cleanNotas = optMaxString(notas, 'notas', 500);

    return db.runTransaction(async tx => {
      // 1. Cargar primero clientRef y autorizar acceso a la cuenta antes de evaluar documentos o idempotencia
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const cleanPowerDoc = validateAndNormalizeStorageDoc(effectiveDoc, {
        accountId: cleanAccountId,
        docKey: POWER_DOC_KEY,
        suffix,
        defaultName: 'Poder para Firma de Contratos',
        label: 'poder para firma de contratos'
      });

      const payloadHash = cleanOpId ? computeOperationFingerprint('grantContractPower', {
        callerCid: caller.cid,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        notas: cleanNotas,
        documento: cleanPowerDoc
      }) : null;

      const opRef = cleanOpId ? col('ops').doc(`grant_power_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;
      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        const isMismatch = prevOp.payloadHash
          ? (prevOp.callerCid !== caller.cid || prevOp.payloadHash !== payloadHash)
          : (
              prevOp.callerCid !== caller.cid ||
              prevOp.accountId !== cleanAccountId ||
              prevOp.contactId !== cleanContactId ||
              (prevOp.notas !== undefined && prevOp.notas !== cleanNotas) ||
              (prevOp.result && prevOp.result.notas !== undefined && prevOp.result.notas !== cleanNotas) ||
              (prevOp.result && prevOp.result.power && prevOp.result.power.storagePath && prevOp.result.power.storagePath !== cleanPowerDoc.storagePath)
            );
        if (isMismatch) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
      }

      // 2. Must have an active legal representative term
      const activeTerm = client.representanteLegalVigente;
      if (!activeTerm || activeTerm.estado !== 'vigente' || !activeTerm.termId) {
        throw new ServiceError('failed-precondition', 'No es posible otorgar poderes sin un nombramiento vigente de Representante Legal en la cuenta');
      }

      // 3. Read contact from contacts_prod (B1 catalog)
      const contactRef = col('contacts').doc(cleanContactId);
      const contactSnap = await tx.get(contactRef);
      if (!contactSnap.exists) {
        throw new ServiceError('not-found', 'La persona seleccionada no existe en el catálogo de contactos');
      }
      const contactData = contactSnap.data();
      const nombreApoderado = contactData.nombreCompleto || `${contactData.nombres || ''} ${contactData.apellidos || ''}`.trim() || 'Apoderado';

      // 4. Verify no existing active power for this contact on this account
      const clientPowersCol = clientRef.collection('contract_powers');
      const existingPowersSnap = await tx.get(
        clientPowersCol.where('contactId', '==', cleanContactId).where('estado', '==', 'vigente')
      );
      if (!existingPowersSnap.empty) {
        throw new ServiceError('failed-precondition', `El contacto ${nombreApoderado} ya cuenta con un poder vigente para firma de contratos en esta cuenta`);
      }

      // 5. Verify physical existence of power document in Firebase Storage before any Firestore write
      await assertStorageObjectExists(cleanPowerDoc.storagePath, 'poder para firma de contratos');

      const nowIso = new Date().toISOString();
      const rand = crypto.randomBytes(4).toString('hex');
      const newPowerId = `power_${Date.now()}_${rand}`;
      const versionId = `v_power_${Date.now()}_${rand}`;

      // 6. Save version in document_versions subcollection (exact normalized fields used in payloadHash)
      const clientVersionsCol = clientRef.collection('document_versions');
      const versionRecord = {
        versionId,
        versionNumber: 1,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: POWER_DOC_KEY,
        name: cleanPowerDoc.name,
        storagePath: cleanPowerDoc.storagePath,
        url: cleanPowerDoc.url,
        size: cleanPowerDoc.size,
        contentType: cleanPowerDoc.contentType,
        sha256: cleanPowerDoc.sha256,
        fechaEmision: cleanPowerDoc.fechaEmision,
        fechaVencimiento: cleanPowerDoc.fechaVencimiento,
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

      // 7. Create power record bound to the active RL term
      const powerData = {
        id: newPowerId,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        nombreApoderado,
        termId: activeTerm.termId,
        notas: cleanNotas,
        documento: {
          name: versionRecord.name,
          storagePath: versionRecord.storagePath,
          url: versionRecord.url,
          size: versionRecord.size,
          contentType: versionRecord.contentType,
          versionId,
          versionNumber: 1,
          sha256: versionRecord.sha256,
          fechaEmision: versionRecord.fechaEmision,
          fechaVencimiento: versionRecord.fechaVencimiento
        },
        estado: 'vigente',
        registradoPor: caller.cid,
        registradoPorNombre: caller.name,
        registradoEn: nowIso,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.set(clientPowersCol.doc(newPowerId), powerData);

      // 8. Update client root projection
      const currentActivePowers = Array.isArray(client.apoderadosVigentes) ? [...client.apoderadosVigentes] : [];
      currentActivePowers.push({
        powerId: newPowerId,
        contactId: cleanContactId,
        nombreApoderado,
        termId: activeTerm.termId,
        notas: cleanNotas,
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
        termId: activeTerm.termId,
        notas: cleanNotas
      });

      const resultPayload = {
        success: true,
        powerId: newPowerId,
        accountId: cleanAccountId,
        contactId: cleanContactId,
        termId: activeTerm.termId,
        nombreApoderado,
        notas: cleanNotas,
        estado: 'vigente',
        power: {
          id: newPowerId,
          powerId: newPowerId,
          accountId: cleanAccountId,
          contactId: cleanContactId,
          nombreApoderado,
          termId: activeTerm.termId,
          notas: cleanNotas,
          documento: powerData.documento,
          versionId,
          storagePath: versionRecord.storagePath,
          url: versionRecord.url,
          estado: 'vigente',
          registradoPor: caller.cid,
          registradoPorNombre: caller.name,
          registradoEn: nowIso
        }
      };

      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          action: 'grantContractPower',
          accountId: cleanAccountId,
          contactId: cleanContactId,
          notas: cleanNotas,
          payloadHash,
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
  // 3. Revocación Voluntaria / Anticipada de Poder
  // ---------------------------------------------------------------------------
  async function revokeContractPower({ caller, accountId, powerId, motivo, opId = null }) {
    assertCaller(caller);
    const cleanAccountId = reqString(accountId, 'accountId', 128);
    if (!DOC_ID_RE.test(cleanAccountId)) {
      throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
    }
    const cleanPowerId = reqString(powerId, 'powerId', 128);
    const cleanMotivo = reqString(motivo, 'motivo de revocación', 500);

    const cleanOpId = opId ? reqString(opId, 'opId', 128) : null;
    if (cleanOpId && !DOC_ID_RE.test(cleanOpId)) {
      throw new ServiceError('invalid-argument', 'Identificador de operación (opId) inválido');
    }
    const payloadHash = cleanOpId ? computeOperationFingerprint('revokeContractPower', {
      callerCid: caller.cid,
      accountId: cleanAccountId,
      powerId: cleanPowerId,
      motivo: cleanMotivo
    }) : null;

    return db.runTransaction(async tx => {
      // 1. Cargar primero clientRef y autorizar acceso a la cuenta antes de evaluar idempotencia
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const opRef = cleanOpId ? col('ops').doc(`revoke_power_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;
      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        const isMismatch = prevOp.payloadHash
          ? (prevOp.callerCid !== caller.cid || prevOp.payloadHash !== payloadHash)
          : (prevOp.callerCid !== caller.cid || prevOp.accountId !== cleanAccountId || prevOp.powerId !== cleanPowerId || prevOp.motivo !== cleanMotivo);
        if (isMismatch) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
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
        ? client.apoderadosVigentes.filter(p => p.powerId !== cleanPowerId && p.id !== cleanPowerId)
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

      const resultPayload = { success: true, powerId: cleanPowerId, estado: 'revocado' };
      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          action: 'revokeContractPower',
          accountId: cleanAccountId,
          powerId: cleanPowerId,
          motivo: cleanMotivo,
          payloadHash,
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

    const cleanConfirmationType = typeof confirmationType === 'string' ? confirmationType.trim() : '';
    const isNoChangesType = cleanConfirmationType === 'no_changes' || cleanConfirmationType === 'biennial_no_changes';
    if (!isNoChangesType) {
      throw new ServiceError(
        'invalid-argument',
        `Tipo de confirmación bienal inválido ('${confirmationType}'). Este endpoint registra exclusivamente eventos de confirmación sin cambios ('no_changes' o 'biennial_no_changes'); para modificaciones documentales utilice saveAccountDocument.`
      );
    }
    if (confirmedNoChanges !== true) {
      throw new ServiceError('invalid-argument', 'Debe confirmar expresamente que consultó al cliente y que no existen modificaciones');
    }

    const cleanNotas = optMaxString(notas, 'notas', 500);
    const cleanOpportunityId = optMaxString(opportunityId, 'opportunityId', 128);
    const payloadHash = cleanOpId ? computeOperationFingerprint('recordBiennialConfirmation', {
      callerCid: caller.cid,
      accountId: cleanAccountId,
      docKey: cleanDocKey,
      requestedVersionId: cleanVersionId,
      confirmationType: cleanConfirmationType,
      confirmedNoChanges: true,
      notas: cleanNotas,
      opportunityId: cleanOpportunityId
    }) : null;

    return db.runTransaction(async tx => {
      // --- FASE 1 DE TRANSACCIÓN: TODAS LAS LECTURAS (AUTORIZACIÓN ANTES DE IDEMPOTENCIA) ---
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const opRef = cleanOpId ? col('ops').doc(`biennial_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;

      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        const isMismatch = prevOp.payloadHash
          ? (prevOp.callerCid !== caller.cid || prevOp.payloadHash !== payloadHash)
          : (
              prevOp.callerCid !== caller.cid ||
              prevOp.accountId !== cleanAccountId ||
              prevOp.docKey !== cleanDocKey ||
              (prevOp.requestedVersionId && prevOp.requestedVersionId !== cleanVersionId && prevOp.documentVersionId !== cleanVersionId) ||
              (prevOp.notas !== undefined && prevOp.notas !== cleanNotas) ||
              (prevOp.opportunityId !== undefined && prevOp.opportunityId !== cleanOpportunityId)
            );
        if (isMismatch) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
      }

      const clientVersionsCol = clientRef.collection('document_versions');
      const versionRef = clientVersionsCol.doc(cleanVersionId);
      const deterministicBaseId = `v_${cleanDocKey}_base_1`;
      const deterministicBaseRef = clientVersionsCol.doc(deterministicBaseId);
      const currentActiveDoc = client.documentos && client.documentos[cleanDocKey] ? client.documentos[cleanDocKey] : null;
      const activePointerId = (currentActiveDoc && typeof currentActiveDoc === 'object' && currentActiveDoc.versionId)
        ? String(currentActiveDoc.versionId)
        : null;

      const versionSnap = await tx.get(versionRef);
      const deterministicBaseSnap = (cleanVersionId === 'v_base' && cleanVersionId !== deterministicBaseId)
        ? await tx.get(deterministicBaseRef)
        : null;
      const activePointerSnap = (cleanVersionId === 'v_base' && activePointerId && activePointerId !== cleanVersionId && activePointerId !== deterministicBaseId)
        ? await tx.get(clientVersionsCol.doc(activePointerId))
        : null;
      const docKeyVersionsSnap = await tx.get(clientVersionsCol.where('docKey', '==', cleanDocKey));

      const now = new Date();
      const nowIso = now.toISOString();
      const todayStr = nowIso.slice(0, 10);
      const rand = crypto.randomBytes(4).toString('hex');

      if (!currentActiveDoc) {
        if (!versionSnap.exists) {
          throw new ServiceError('not-found', 'La versión documental especificada no existe en el expediente de esta cuenta');
        }
        throw new ServiceError('failed-precondition', `El documento '${cleanDocKey}' no tiene una versión vigente activa en la cuenta`);
      }

      let effectiveVersionId = cleanVersionId;
      let versionData = versionSnap.exists ? versionSnap.data() : null;
      let lazyBaseVersionToCreate = null;
      let healClientDocVersionPointer = false;

      if (!versionSnap.exists) {
        // MEDIO-02 / PUNTO 2 & PUNTO 3 / DEF-A1 & DEF-A2: Support initial/legacy client documents ('v_base')
        // with strict Storage reference validation, physical existence check, and concurrency-safe deterministic base resolution.
        if (cleanVersionId === 'v_base') {
          let resolvedBase = null;

          // Case 1: A concurrent transaction just materialized v_base and healed currentActiveDoc.versionId
          if (activePointerId) {
            let pointerDocData = null;
            if (activePointerId === deterministicBaseId && deterministicBaseSnap && deterministicBaseSnap.exists) {
              pointerDocData = deterministicBaseSnap.data();
            } else if (activePointerSnap && activePointerSnap.exists) {
              pointerDocData = activePointerSnap.data();
            }
            if (pointerDocData) {
              const pNum = Number(pointerDocData.versionNumber) || 1;
              if (pNum === 1 && pointerDocData.estado === 'vigente' && !pointerDocData.reemplazadaPorVersionId) {
                resolvedBase = { id: activePointerId, data: pointerDocData, needsHeal: false };
              } else {
                throw new ServiceError(
                  'failed-precondition',
                  `No es posible confirmar una versión desactualizada ('v_base') cuando la versión vigente actual es '${activePointerId}'`
                );
              }
            }
          }

          // Case 2: Deterministic base version document already exists in document_versions
          if (!resolvedBase && deterministicBaseSnap && deterministicBaseSnap.exists) {
            resolvedBase = {
              id: deterministicBaseId,
              data: deterministicBaseSnap.data(),
              needsHeal: !activePointerId
            };
          }

          // Case 3: Query snapshot of document_versions for docKey contains an existing version
          if (!resolvedBase && docKeyVersionsSnap && typeof docKeyVersionsSnap.forEach === 'function') {
            let activeVersionDoc = null;
            docKeyVersionsSnap.forEach(d => {
              const dData = d.data() || {};
              if (dData.estado === 'vigente' || !activeVersionDoc || (Number(dData.versionNumber) || 0) > (Number(activeVersionDoc.data.versionNumber) || 0)) {
                activeVersionDoc = { id: d.id || dData.versionId, data: dData };
              }
            });
            if (activeVersionDoc && activeVersionDoc.id) {
              const foundNum = Number(activeVersionDoc.data.versionNumber) || 1;
              if (foundNum > 1 && activePointerId && activePointerId !== 'v_base') {
                throw new ServiceError(
                  'failed-precondition',
                  `No es posible confirmar una versión desactualizada ('v_base') cuando la versión vigente actual es '${activeVersionDoc.id}'`
                );
              }
              resolvedBase = {
                id: activeVersionDoc.id,
                data: activeVersionDoc.data,
                needsHeal: !activePointerId
              };
            }
          }

          if (resolvedBase) {
            effectiveVersionId = resolvedBase.id;
            versionData = resolvedBase.data;
            healClientDocVersionPointer = Boolean(resolvedBase.needsHeal);
          } else {
            // Case 4: Materialize deterministic base version ONLY if currentActiveDoc has a valid Storage reference
            // AND the object physically exists in Firebase Storage.
            const normalizedBaseDoc = validateAndNormalizeStorageDoc(currentActiveDoc, {
              accountId: cleanAccountId,
              docKey: cleanDocKey,
              suffix,
              allowHistoricalBase: true,
              defaultName: cleanDocKey,
              errorCode: 'failed-precondition',
              label: `documento '${cleanDocKey}'`
            });

            await assertStorageObjectExists(normalizedBaseDoc.storagePath, `documento base '${cleanDocKey}'`);

            effectiveVersionId = deterministicBaseId;
            versionData = {
              versionId: effectiveVersionId,
              versionNumber: (typeof currentActiveDoc === 'object' && Number(currentActiveDoc.versionNumber)) || 1,
              entityType: 'client',
              entityId: cleanAccountId,
              docKey: cleanDocKey,
              name: normalizedBaseDoc.name,
              storagePath: normalizedBaseDoc.storagePath,
              url: normalizedBaseDoc.url,
              size: normalizedBaseDoc.size,
              contentType: normalizedBaseDoc.contentType,
              sha256: normalizedBaseDoc.sha256,
              fechaEmision: normalizedBaseDoc.fechaEmision,
              fechaVencimiento: normalizedBaseDoc.fechaVencimiento,
              estado: 'vigente',
              subidoPorId: client.createdBy || caller.cid,
              creadoEn: (typeof currentActiveDoc === 'object' && currentActiveDoc.actualizadoEn) || client.fecha_creacion || nowIso,
              createdAt: FieldValue.serverTimestamp()
            };
            lazyBaseVersionToCreate = versionData;
            healClientDocVersionPointer = true;
          }
        } else {
          throw new ServiceError('not-found', 'La versión documental especificada no existe en el expediente de esta cuenta');
        }
      }

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
          `La versión documental '${effectiveVersionId}' corresponde al documento '${versionData.docKey || 'desconocido'}', no a '${cleanDocKey}'`
        );
      }

      // 2.3 A biennial confirmation cannot renew a document that has an expired fechaVencimiento
      const effectiveExpiry = versionData.fechaVencimiento || (typeof currentActiveDoc === 'object' ? currentActiveDoc.fechaVencimiento : null) || null;
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
      if (typeof currentActiveDoc === 'object' && currentActiveDoc.versionId && currentActiveDoc.versionId !== effectiveVersionId) {
        throw new ServiceError(
          'failed-precondition',
          `No es posible confirmar una versión desactualizada ('${effectiveVersionId}') cuando la versión vigente actual es '${currentActiveDoc.versionId}'`
        );
      }

      const targetVersionNumber = Number(versionData.versionNumber) || (typeof currentActiveDoc === 'object' && Number(currentActiveDoc.versionNumber)) || 1;
      if (docKeyVersionsSnap && typeof docKeyVersionsSnap.forEach === 'function') {
        let supersededByHigher = false;
        docKeyVersionsSnap.forEach(d => {
          const dData = d.data() || {};
          const dId = d.id || dData.versionId;
          if (dId !== effectiveVersionId) {
            if ((Number(dData.versionNumber) || 0) > targetVersionNumber || dData.reemplazaVersionId === effectiveVersionId) {
              supersededByHigher = true;
            }
          }
        });
        if (supersededByHigher) {
          throw new ServiceError('failed-precondition', 'No es posible confirmar una versión histórica o desactualizada cuando ya existe una versión posterior');
        }
      }

      // --- FASE 3 DE TRANSACCIÓN: TODAS LAS ESCRITURAS ATÓMICAS ---
      if (lazyBaseVersionToCreate) {
        tx.set(clientVersionsCol.doc(effectiveVersionId), lazyBaseVersionToCreate);
      }

      // Next review at: 2 calendar years (730 days) from confirmation
      const nextReviewDate = new Date(now.getTime() + 730 * 24 * 60 * 60 * 1000);
      const nextReviewIso = nextReviewDate.toISOString().slice(0, 10);

      const confId = cleanOpId ? `conf_${cleanOpId}` : `conf_${Date.now()}_${rand}`;

      // Identity is taken strictly from server-resolved `caller`
      const confirmationRecord = {
        id: confId,
        eventType: 'biennial_confirmation',
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        documentVersionId: effectiveVersionId,
        versionNumber: targetVersionNumber,
        confirmationType: cleanConfirmationType,
        confirmedNoChanges: true,
        notas: cleanNotas,
        confirmedBy: caller.cid,
        confirmedByUid: caller.uid,
        confirmedByName: caller.name || 'Comercial',
        confirmedByRole: caller.role,
        confirmedAt: nowIso,
        nextReviewAt: nextReviewIso,
        opportunityId: cleanOpportunityId,
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
        documentVersionId: effectiveVersionId,
        versionNumber: targetVersionNumber,
        confirmationType: cleanConfirmationType
      };

      const clientUpdatePatch = {
        biennialReviews,
        updatedAt: FieldValue.serverTimestamp()
      };
      if (healClientDocVersionPointer && client.documentos && typeof client.documentos === 'object') {
        const updatedDocs = { ...client.documentos };
        const existingEntry = typeof updatedDocs[cleanDocKey] === 'object' ? { ...updatedDocs[cleanDocKey] } : { url: updatedDocs[cleanDocKey] };
        existingEntry.versionId = effectiveVersionId;
        existingEntry.versionNumber = targetVersionNumber;
        if (lazyBaseVersionToCreate) {
          existingEntry.storagePath = lazyBaseVersionToCreate.storagePath;
          existingEntry.name = lazyBaseVersionToCreate.name;
        }
        updatedDocs[cleanDocKey] = existingEntry;
        clientUpdatePatch.documentos = updatedDocs;
      }

      tx.update(clientRef, clientUpdatePatch);

      addAudit(tx, caller, 'ACCOUNT_DOCUMENT_REVIEW_CONFIRMED', confId, {
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        documentVersionId: effectiveVersionId,
        versionNumber: targetVersionNumber,
        confirmationType: cleanConfirmationType,
        nextReviewAt: nextReviewIso,
        opportunityId: confirmationRecord.opportunityId,
        opId: cleanOpId
      });

      const resultPayload = {
        success: true,
        confirmationId: confId,
        docKey: cleanDocKey,
        documentVersionId: effectiveVersionId,
        versionNumber: targetVersionNumber,
        confirmedBy: caller.cid,
        confirmedByName: caller.name || 'Comercial',
        confirmedAt: nowIso,
        nextReviewAt: nextReviewIso
      };

      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          action: 'recordBiennialConfirmation',
          accountId: cleanAccountId,
          docKey: cleanDocKey,
          documentVersionId: effectiveVersionId,
          requestedVersionId: cleanVersionId,
          confirmationType: cleanConfirmationType,
          notas: cleanNotas,
          opportunityId: cleanOpportunityId,
          payloadHash,
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
    const cleanAccountId = reqString(accountId, 'accountId', 128);
    if (!DOC_ID_RE.test(cleanAccountId)) {
      throw new ServiceError('invalid-argument', 'Identificador de cuenta inválido');
    }
    const cleanDocKey = reqString(docKey, 'docKey', 64);
    if (!ALL_DOC_KEYS.includes(cleanDocKey)) {
      throw new ServiceError('invalid-argument', `Clave documental '${cleanDocKey}' no reconocida`);
    }

    if (!doc || typeof doc !== 'object') {
      throw new ServiceError('invalid-argument', 'Documento inválido');
    }

    const rawFechaVenc = fechaVencimiento !== undefined && fechaVencimiento !== null ? fechaVencimiento : doc.fechaVencimiento;
    const rawFechaEmi = fechaEmision !== undefined && fechaEmision !== null ? fechaEmision : doc.fechaEmision;
    const cleanFechaVencimiento = sanitizeDate(rawFechaVenc, 'fechaVencimiento');
    const cleanFechaEmision = sanitizeDate(rawFechaEmi, 'fechaEmision');
    const cleanMotivoSustitucion = optMaxString(motivoSustitucion, 'motivoSustitucion', 500);

    const cleanOpId = opId ? reqString(opId, 'opId', 128) : null;
    if (cleanOpId && !DOC_ID_RE.test(cleanOpId)) {
      throw new ServiceError('invalid-argument', 'Identificador de operación (opId) inválido');
    }

    return db.runTransaction(async tx => {
      // 1. Cargar primero clientRef y autorizar acceso a la cuenta antes de evaluar documentos o idempotencia
      const clientRef = col('clients').doc(cleanAccountId);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) throw new ServiceError('not-found', 'Cuenta no encontrada');
      const client = clientSnap.data();

      if (!canAccessAccount(caller, client)) {
        throw new ServiceError('permission-denied', 'No tienes acceso a esta cuenta');
      }

      const cleanSaveDoc = validateAndNormalizeStorageDoc(doc, {
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        suffix,
        defaultName: 'Documento',
        overrideFechaEmision: cleanFechaEmision,
        overrideFechaVencimiento: cleanFechaVencimiento,
        label: `documento '${cleanDocKey}'`
      });
      const incomingSha = cleanSaveDoc.sha256;

      const payloadHash = cleanOpId ? computeOperationFingerprint('saveAccountDocument', {
        callerCid: caller.cid,
        accountId: cleanAccountId,
        docKey: cleanDocKey,
        motivoSustitucion: cleanMotivoSustitucion,
        fechaEmision: cleanSaveDoc.fechaEmision,
        fechaVencimiento: cleanSaveDoc.fechaVencimiento,
        doc: cleanSaveDoc
      }) : null;

      const opRef = cleanOpId ? col('ops').doc(`save_doc_${cleanAccountId}_${cleanOpId}`) : null;
      const opSnap = opRef ? await tx.get(opRef) : null;
      if (opSnap && opSnap.exists) {
        const prevOp = opSnap.data();
        const isMismatch = prevOp.payloadHash
          ? (prevOp.callerCid !== caller.cid || prevOp.payloadHash !== payloadHash)
          : (
              prevOp.callerCid !== caller.cid ||
              prevOp.accountId !== cleanAccountId ||
              prevOp.docKey !== cleanDocKey ||
              ((prevOp.sha256 || null) !== (incomingSha || null)) ||
              (prevOp.storagePath !== undefined && prevOp.storagePath !== cleanSaveDoc.storagePath) ||
              (prevOp.motivoSustitucion !== undefined && prevOp.motivoSustitucion !== cleanMotivoSustitucion)
            );
        if (isMismatch) {
          throw new ServiceError('already-exists', 'El identificador de operación (opId) ya fue utilizado con parámetros distintos');
        }
        return {
          ...prevOp.result,
          idempotentReplay: true
        };
      }

      const clientVersionsCol = clientRef.collection('document_versions');
      const existingDoc = (client.documentos && client.documentos[cleanDocKey]) ? client.documentos[cleanDocKey] : null;
      const prevVersionRef = (existingDoc && existingDoc.versionId) ? clientVersionsCol.doc(existingDoc.versionId) : null;
      const prevVersionSnap = prevVersionRef ? await tx.get(prevVersionRef) : null;

      const todayStr = new Date().toISOString().slice(0, 10);

      // Rule 6.1 & BAJO-04: Prevent duplicate SHA-256 and enforce renewal rules when substituting an expired document
      if (existingDoc) {
        const prevExpired = existingDoc.fechaVencimiento && String(existingDoc.fechaVencimiento).slice(0, 10) < todayStr;

        if (incomingSha && existingDoc.sha256 && incomingSha === existingDoc.sha256) {
          throw new ServiceError('failed-precondition', 'No se puede sustituir o renovar un documento cargando el mismo archivo vencido (huella digital SHA-256 idéntica). Se requiere evidencia de renovación efectiva.');
        }

        if (prevExpired) {
          if (!incomingSha) {
            throw new ServiceError('invalid-argument', 'Para renovar un documento vencido es obligatorio proporcionar la huella digital SHA-256 del nuevo archivo.');
          }
          if (!cleanFechaVencimiento) {
            throw new ServiceError('invalid-argument', 'Para renovar un documento vencido es obligatorio especificar la nueva fecha de vencimiento.');
          }
          if (cleanFechaVencimiento <= existingDoc.fechaVencimiento) {
            throw new ServiceError('failed-precondition', `La fecha de vencimiento renovada (${cleanFechaVencimiento}) debe ser posterior a la fecha anterior (${existingDoc.fechaVencimiento}).`);
          }
        }
      }

      // BAJO-04: Reject already-expired fechaVencimiento on any upload/substitution
      if (cleanFechaVencimiento && cleanFechaVencimiento < todayStr) {
        throw new ServiceError('failed-precondition', `La fecha de vencimiento especificada (${cleanFechaVencimiento}) ya se encuentra vencida. Debe indicar una fecha vigente.`);
      }

      // Verify physical existence in Firebase Storage before any Firestore write
      await assertStorageObjectExists(cleanSaveDoc.storagePath, `documento '${cleanDocKey}'`);

      const nowIso = new Date().toISOString();
      const rand = crypto.randomBytes(4).toString('hex');
      const versionId = `v_${cleanDocKey}_${Date.now()}_${rand}`;
      const prevVersionNumber = (existingDoc && existingDoc.versionNumber) ? existingDoc.versionNumber : 0;
      const newVersionNumber = prevVersionNumber + 1;

      // Mark previous version as 'historica' if exists
      if (prevVersionSnap && prevVersionSnap.exists) {
        tx.update(prevVersionRef, {
          estado: 'historica',
          reemplazadaPorVersionId: versionId,
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      const versionRecord = {
        versionId,
        versionNumber: newVersionNumber,
        entityType: 'client',
        entityId: cleanAccountId,
        docKey: cleanDocKey,
        name: cleanSaveDoc.name,
        storagePath: cleanSaveDoc.storagePath,
        url: cleanSaveDoc.url,
        size: cleanSaveDoc.size,
        contentType: cleanSaveDoc.contentType,
        sha256: cleanSaveDoc.sha256,
        fechaEmision: cleanSaveDoc.fechaEmision,
        fechaVencimiento: cleanSaveDoc.fechaVencimiento,
        estado: 'vigente',
        reemplazaVersionId: (existingDoc && existingDoc.versionId) ? existingDoc.versionId : null,
        motivoSustitucion: cleanMotivoSustitucion,
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
        size: versionRecord.size,
        contentType: versionRecord.contentType,
        versionId,
        versionNumber: newVersionNumber,
        sha256: versionRecord.sha256,
        fechaEmision: versionRecord.fechaEmision,
        fechaVencimiento: versionRecord.fechaVencimiento,
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
        motivoSustitucion: cleanMotivoSustitucion
      });

      const resultPayload = {
        success: true,
        versionId,
        versionNumber: newVersionNumber,
        docKey: cleanDocKey
      };

      if (opRef) {
        tx.set(opRef, {
          opId: cleanOpId,
          action: 'saveAccountDocument',
          accountId: cleanAccountId,
          docKey: cleanDocKey,
          storagePath: cleanSaveDoc.storagePath,
          sha256: incomingSha || null,
          motivoSustitucion: cleanMotivoSustitucion,
          payloadHash,
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
