// functions/storageService.js
// SEC-05 Phase 1.1: Secure Storage Service
// Handles server-side route validation, business entity authorization,
// and short-lived signed URL generation for universal file downloads.

const {
  ServiceError,
  MAX_MERGE_DEPTH,
  isCallerActiveAndAuthenticated,
  authorizeClientAccess,
  resolveCanonicalAccount
} = require('./clientsService');

const ALLOWED_FOLDER_PREFIXES = [
  'clients',
  'clientes',
  'prospects',
  'proyectos',
  'facturas',
  'pagos',
  'ordenes_cambio',
  'requerimientos',
  'fabricacion_archivos'
];

const PRIVILEGED_ROLES = ['manager', 'gestor'];
const PLANT_ROLES = ['jefe_produccion', 'operario', 'control_calidad', 'despacho', 'encargado_armado'];

const DEFAULT_EXPIRATION_SECONDS = 900; // 15 min
const MAX_EXPIRATION_SECONDS = 900;     // Máximo 15 min
const MIN_EXPIRATION_SECONDS = 60;      // Mínimo 1 min

function normalizeExpirationSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_EXPIRATION_SECONDS;
  const num = parseInt(raw, 10);
  if (isNaN(num) || !Number.isFinite(num) || num <= 0) return DEFAULT_EXPIRATION_SECONDS;
  return Math.min(Math.max(num, MIN_EXPIRATION_SECONDS), MAX_EXPIRATION_SECONDS);
}

function sanitizeFileName(fileName, fallback = 'documento') {
  if (!fileName || typeof fileName !== 'string') return fallback;
  // Strip directory traversal sequences (..)
  let clean = fileName.replace(/\.{2,}/g, '');
  // Strip directory separators and invalid filename chars
  clean = clean.replace(/[/\\?%*:|"<>]/g, '_');
  // Strip control chars and CRLF to prevent HTTP header injection
  clean = clean.replace(/[\x00-\x1F\x7F\r\n\t]/g, '').trim();
  clean = clean.slice(0, 200);
  return clean || fallback;
}

function buildContentDisposition(cleanName, disposition = 'attachment') {
  // ASCII fallback for filename="" (RFC 6266): replace non-ASCII with '_' and strip quotes
  const asciiName = cleanName.replace(/["\\]/g, '').replace(/[^\x20-\x7E]/g, '_') || 'documento';
  // UTF-8 encoding for filename*=UTF-8''... preserving spaces (%20), accents, Spanish chars (á, é, í, ó, ú, ñ)
  const utf8Encoded = encodeURIComponent(cleanName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  const type = disposition === 'inline' ? 'inline' : 'attachment';
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Extrae y decodifica la ruta de almacenamiento canónica física desde un string de ruta o URL de Firebase Storage.
 * Retorna la ruta física exacta normalizada (sin query params, tokens ni host) o null si es inválida.
 */
function extractStoragePath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. URL estándar de Firebase Storage: /v0/b/<bucket>/o/<encodedPath>?alt=media&token=...
  const oMatch = trimmed.match(/\/o\/([^?#]+)/);
  if (oMatch && oMatch[1]) {
    try {
      return decodeURIComponent(oMatch[1]).replace(/^\/+/, '');
    } catch (_) {
      return oMatch[1].replace(/^\/+/, '');
    }
  }

  // 2. URL de Google Cloud Storage: https://storage.googleapis.com/<bucket>/<path>
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      const segments = u.pathname.replace(/^\/+/, '').split('/');
      if (segments.length >= 2) {
        return decodeURIComponent(segments.slice(1).join('/'));
      }
    } catch (_) {}
  }

  // 3. String con codificación URL parcial (ej. %2F)
  if (trimmed.includes('%2F') || trimmed.includes('%2f')) {
    try {
      return decodeURIComponent(trimmed).replace(/^\/+/, '');
    } catch (_) {}
  }

  // 4. Ruta directa (remover barras iniciales)
  return trimmed.replace(/^\/+/, '');
}

/**
 * Inspecciona recursivamente las propiedades de un documento de Firestore (prospecto o cliente)
 * para comprobar si contiene una referencia documental válida hacia targetPath.
 * Compatible con: string URL histórica, string ruta, objeto { storagePath }, objeto { path }, objeto { url }.
 * Utiliza comparación estricta de ruta canónica decodificada (sin coincidencia por subcadena).
 */
function objectReferencesStoragePath(obj, targetPath, depth = 0) {
  if (!obj || !targetPath || depth > 10) return false;
  if (typeof obj === 'string') {
    if (obj === targetPath) return true;
    const extracted = extractStoragePath(obj);
    if (extracted && extracted === targetPath) return true;
    return false;
  }
  if (Array.isArray(obj)) {
    return obj.some(item => objectReferencesStoragePath(item, targetPath, depth + 1));
  }
  if (typeof obj === 'object') {
    if (obj.storagePath === targetPath || obj.path === targetPath) return true;
    if (typeof obj.storagePath === 'string') {
      const ext = extractStoragePath(obj.storagePath);
      if (ext && ext === targetPath) return true;
    }
    if (typeof obj.path === 'string') {
      const ext = extractStoragePath(obj.path);
      if (ext && ext === targetPath) return true;
    }
    if (typeof obj.url === 'string' && objectReferencesStoragePath(obj.url, targetPath, depth + 1)) return true;
    return Object.values(obj).some(val => {
      if (val && (typeof val === 'object' || typeof val === 'string')) {
        return objectReferencesStoragePath(val, targetPath, depth + 1);
      }
      return false;
    });
  }
  return false;
}

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

function createStorageService({ db, bucket, suffix = '_prod' }) {
  if (!db) throw new Error('db is required');
  if (!bucket) throw new Error('bucket is required');

  const names = {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    users: `users${suffix}`,
    reservations: `client_reservations${suffix}`
  };

  function validateStoragePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new ServiceError('invalid-argument', 'Ruta de almacenamiento no especificada o inválida');
    }
    const cleanPath = rawPath.trim();
    if (cleanPath.length > 500) {
      throw new ServiceError('invalid-argument', 'Ruta de almacenamiento excede la longitud máxima permitida');
    }
    if (cleanPath.includes('..') || cleanPath.includes('//') || cleanPath.includes('\\')) {
      throw new ServiceError('invalid-argument', 'Ruta de almacenamiento contiene secuencias prohibidas');
    }

    const parts = cleanPath.split('/');
    if (parts.length < 3) {
      throw new ServiceError('invalid-argument', 'Ruta de almacenamiento incompleta');
    }

    const envPrefix = parts[0];
    const folder = parts[1];

    if (envPrefix !== 'prod_files' && envPrefix !== 'local_files') {
      throw new ServiceError('invalid-argument', 'Prefijo de almacenamiento inválido');
    }

    // In production, reject local_files prefix.
    if (suffix === '_prod' && envPrefix !== 'prod_files') {
      throw new ServiceError('permission-denied', 'Ruta de almacenamiento no permitida en este entorno');
    }

    if (!ALLOWED_FOLDER_PREFIXES.includes(folder)) {
      throw new ServiceError('permission-denied', `Carpeta de almacenamiento '${folder}' no autorizada`);
    }

    return cleanPath;
  }

  const boundResolveCanonicalAccount = (originId, opts = {}) =>
    resolveCanonicalAccount(db, originId, { suffix, clientsColName: names.clients, ...opts });

  async function assertCallerNotRevoked(caller) {
    if (!caller || typeof caller !== 'object' || !caller.uid || !caller.role) {
      throw new ServiceError('unauthenticated', 'Autenticación requerida');
    }
    if (!isCallerActiveAndAuthenticated(caller)) {
      throw new ServiceError('permission-denied', 'Se requiere un usuario activo del CRM vinculado a esta sesión');
    }
    if (caller.cid && db && typeof db.collection === 'function') {
      try {
        const usersCol = db.collection(names.users);
        if (usersCol && typeof usersCol.doc === 'function') {
          const uRef = usersCol.doc(String(caller.cid));
          if (uRef && typeof uRef.get === 'function') {
            const uSnap = await uRef.get();
            if (uSnap && uSnap.exists) {
              const u = uSnap.data() || {};
              if (
                u.activo === false ||
                u.revoked === true ||
                u.disabled === true ||
                (u.authUid && u.authUid !== caller.uid) ||
                (u.role && u.role !== caller.role)
              ) {
                throw new ServiceError('permission-denied', 'Se requiere un usuario activo del CRM vinculado a esta sesión');
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        // Ignore if mock db does not implement users collection
      }
    }
  }

  async function isClientReferencedInAccountOrChain(resolved, storagePath) {
    for (const snap of (resolved.chainSnaps || [])) {
      const cData = snap && typeof snap.data === 'function' ? snap.data() : null;
      if (cData && objectReferencesStoragePath(cData, storagePath)) {
        return true;
      }
    }
    for (const accId of (resolved.chain || [])) {
      try {
        const verSnap = await db
          .collection(names.clients)
          .doc(accId)
          .collection('document_versions')
          .where('storagePath', '==', storagePath)
          .limit(1)
          .get();
        if (verSnap && !verSnap.empty) return true;
      } catch (_) {
        // ignore
      }
    }
    // Also check accounts absorbed into resolved.canonicalId (when caller passed canonicalId directly as context.clientId)
    try {
      const absorbedSnap = await db
        .collection(names.clients)
        .where('fusionada_en', '==', resolved.canonicalId)
        .get();
      if (absorbedSnap && Array.isArray(absorbedSnap.docs)) {
        for (const d of absorbedSnap.docs) {
          if (resolved.chain && resolved.chain.includes(d.id)) continue;
          const absData = d.data() || {};
          if (objectReferencesStoragePath(absData, storagePath)) return true;
          try {
            const verSnap = await db
              .collection(names.clients)
              .doc(d.id)
              .collection('document_versions')
              .where('storagePath', '==', storagePath)
              .limit(1)
              .get();
            if (verSnap && !verSnap.empty) return true;
          } catch (_) {
            // ignore
          }
        }
      }
    } catch (_) {
      // ignore if mock db doesn't support where on clients
    }
    return false;
  }

  async function verifyDocumentAccess(caller, storagePath, context = {}) {
    await assertCallerNotRevoked(caller);

    const parts = storagePath.split('/');
    const folder = parts[1];
    const entityId = parts[2];

    // Plant files (requerimientos, fabricacion_archivos)
    if (folder === 'requerimientos' || folder === 'fabricacion_archivos') {
      if (caller.role === 'manager' || PLANT_ROLES.includes(caller.role)) return true;
      throw new ServiceError('permission-denied', 'Solo personal de planta autorizado puede acceder a estos archivos');
    }

    // If caller is plant role trying to access commercial documents
    if (PLANT_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'Personal de planta no tiene acceso a documentos comerciales');
    }

    // B4.2: Entity-scoped client path (`prod_files/clients/{originAccountId}/...`)
    // Evaluated through `resolveCanonicalAccount` and `authorizeClientAccess` for ALL commercial roles (`manager`, `gestor`, `vendedor`)
    if (folder === 'clients' && entityId) {
      const originSnap = await db.collection(names.clients).doc(entityId).get();
      if (!originSnap.exists) {
        // Check if it's an active, unexpired reservation owned by caller (or accessed by manager/gestor)
        const resSnap = await db.collection(names.reservations).doc(entityId).get();
        if (resSnap.exists) {
          if (context.clientId && String(context.clientId).trim() !== entityId) {
            throw new ServiceError('permission-denied', 'Contexto de cliente contradictorio con la ruta solicitada');
          }
          if (caller.role === 'manager' || caller.role === 'gestor') {
            return true;
          }
          const r = resSnap.data() || {};
          const nowMs = Date.now();
          let isNotExpired = false;
          if (typeof r.expiresAtMs === 'number' && r.expiresAtMs > 0) {
            isNotExpired = nowMs < r.expiresAtMs;
          } else if (r.expiresAt && typeof r.expiresAt.toMillis === 'function') {
            isNotExpired = nowMs < r.expiresAt.toMillis();
          } else if (r.expiresAt instanceof Date) {
            isNotExpired = nowMs < r.expiresAt.getTime();
          } else if (typeof r.expiresAt === 'string') {
            const parsed = Date.parse(r.expiresAt);
            isNotExpired = Number.isFinite(parsed) && nowMs < parsed;
          }
          if (r.createdBy === caller.cid && r.status === 'reserved' && isNotExpired) {
            return true;
          }
          if (r.createdBy === caller.cid) {
            throw new ServiceError('permission-denied', 'La reserva del cliente ha expirado o fue cancelada');
          }
        }
        throw new ServiceError('not-found', 'Cliente no encontrado');
      }

      // 1 & 2. Resolve merge chain from origin account (`entityId`) to terminal active account (`resolved.canonicalId`)
      const resolved = await boundResolveCanonicalAccount(entityId);

      // 3. Verify that any `context.clientId` belongs to the resolved chain (`resolved.chain`)
      // Belonging to the chain ONLY validates context coherence, it does NOT grant permissions.
      if (context.clientId !== undefined && context.clientId !== null && String(context.clientId).trim() !== '') {
        const ctxClientId = String(context.clientId).trim();
        if (!resolved.chain.includes(ctxClientId)) {
          throw new ServiceError('permission-denied', 'Contexto de cliente contradictorio con la ruta solicitada');
        }
      }

      if (context.prospectId) {
        const pSnap = await db.collection(names.prospects).doc(String(context.prospectId).trim()).get();
        if (pSnap.exists) {
          const pData = pSnap.data() || {};
          if (pData.clientId && !resolved.chain.includes(pData.clientId)) {
            let pCanonicalId = null;
            try {
              const pResolved = await boundResolveCanonicalAccount(pData.clientId);
              pCanonicalId = pResolved.canonicalId;
            } catch (_) {
              pCanonicalId = null;
            }
            if (pCanonicalId !== resolved.canonicalId) {
              throw new ServiceError('permission-denied', 'Contexto contradictorio: la oportunidad no corresponde al cliente indicado');
            }
          }
        }
      }

      // 4, 5 & 6. Execute `authorizeClientAccess(caller, resolved.canonicalData)` exclusively on the terminal active account
      if (!authorizeClientAccess(caller, resolved.canonicalData)) {
        throw new ServiceError('permission-denied', 'No tienes permiso para acceder a los documentos de este cliente');
      }

      return true;
    }

    if (folder === 'prospects' && entityId) {
      if (context.prospectId && context.prospectId !== entityId) {
        throw new ServiceError('permission-denied', 'Contexto de oportunidad contradictorio con la ruta solicitada');
      }
      // Entity-scoped prospect path: prod_files/prospects/{prospectId}/...
      const prospectSnap = await db.collection(names.prospects).doc(entityId).get();
      if (!prospectSnap.exists) {
        if (caller.role === 'manager' && !context.clientId) {
          return true;
        }
        throw new ServiceError('not-found', 'Oportunidad no encontrada');
      }
      const p = prospectSnap.data();
      if (p.eliminado === true) {
        throw new ServiceError('not-found', 'La oportunidad fue eliminada');
      }
      if (context.clientId && p.clientId && p.clientId !== context.clientId) {
        let sameCanonical = false;
        try {
          const [pRes, ctxRes] = await Promise.all([
            boundResolveCanonicalAccount(p.clientId),
            boundResolveCanonicalAccount(String(context.clientId).trim())
          ]);
          sameCanonical = pRes.canonicalId === ctxRes.canonicalId;
        } catch (_) {
          sameCanonical = false;
        }
        if (!sameCanonical) {
          throw new ServiceError('permission-denied', 'Contexto contradictorio: la oportunidad no corresponde al cliente indicado');
        }
      }
      if (caller.role === 'manager') {
        return true;
      }
      if (caller.role === 'gestor') {
        if (p.vendedorId === caller.cid || p.createdBy === caller.cid || hasEnteredPostclosing(p)) {
          return true;
        }
        throw new ServiceError('permission-denied', 'No tienes acceso a los documentos de esta oportunidad');
      }
      if (caller.role === 'vendedor') {
        const hasAccess = p.vendedorId === caller.cid || (!p.vendedorId && p.createdBy === caller.cid);
        if (hasAccess) {
          return true;
        }
        throw new ServiceError('permission-denied', 'No tienes acceso a los documentos de esta oportunidad');
      }
      throw new ServiceError('permission-denied', 'No tienes acceso a los documentos de esta oportunidad');
    }

    // Manager unrestricted access on flat legacy folders when no explicit entity context is being validated
    if (caller.role === 'manager' && !context.prospectId && !context.clientId) {
      return true;
    }

    // Flat legacy folders: must verify that the requested file is actually referenced in an authorized entity
    let prospectCheck = null;
    let clientCheck = null;

    if (context.prospectId && context.clientId) {
      const pSnapCheck = await db.collection(names.prospects).doc(context.prospectId).get();
      if (pSnapCheck.exists) {
        const pData = pSnapCheck.data();
        if (pData.clientId && pData.clientId !== context.clientId) {
          let coherentMerge = false;
          try {
            const pResolved = await boundResolveCanonicalAccount(pData.clientId);
            if (pResolved.chain.includes(String(context.clientId).trim())) {
              coherentMerge = true;
            } else {
              const ctxResolved = await boundResolveCanonicalAccount(String(context.clientId).trim());
              coherentMerge = pResolved.canonicalId === ctxResolved.canonicalId;
            }
          } catch (_) {
            coherentMerge = false;
          }
          if (!coherentMerge) {
            throw new ServiceError('permission-denied', 'Contexto contradictorio: la oportunidad no corresponde al cliente indicado');
          }
        }
      }
    }

    if (context.prospectId) {
      const pSnap = await db.collection(names.prospects).doc(context.prospectId).get();
      if (pSnap.exists) {
        const p = pSnap.data();
        if (p.eliminado === true) {
          prospectCheck = { error: new ServiceError('not-found', 'La oportunidad fue eliminada') };
        } else {
          let hasAccess = false;
          if (caller.role === 'manager') {
            hasAccess = true;
          } else if (caller.role === 'gestor') {
            hasAccess = p.vendedorId === caller.cid || p.createdBy === caller.cid || hasEnteredPostclosing(p);
          } else if (caller.role === 'vendedor') {
            hasAccess = p.vendedorId === caller.cid || (!p.vendedorId && p.createdBy === caller.cid);
          }
          if (hasAccess) {
            let isReferenced = objectReferencesStoragePath(p, storagePath);
            if (!isReferenced) {
              try {
                const verSnap = await db.collection(names.prospects).doc(context.prospectId).collection('document_versions').where('storagePath', '==', storagePath).limit(1).get();
                if (verSnap && !verSnap.empty) isReferenced = true;
              } catch (e) {
                // ignore
              }
            }
            if (isReferenced) {
              return true;
            }
            prospectCheck = { error: new ServiceError('permission-denied', 'El archivo no está vinculado a la oportunidad indicada') };
          } else {
            prospectCheck = { error: new ServiceError('permission-denied', 'No tienes acceso a los documentos de esta oportunidad') };
          }
        }
      } else {
        prospectCheck = { error: new ServiceError('not-found', 'Oportunidad no encontrada') };
      }
    }

    if (context.clientId) {
      let resolvedClient = null;
      try {
        resolvedClient = await boundResolveCanonicalAccount(String(context.clientId).trim());
      } catch (err) {
        if (err && err.code === 'failed-precondition') {
          throw err;
        }
        clientCheck = { error: err instanceof ServiceError ? err : new ServiceError('not-found', 'Cliente no encontrado') };
      }
      if (resolvedClient) {
        const hasAccess = authorizeClientAccess(caller, resolvedClient.canonicalData);
        if (hasAccess) {
          const isReferenced = await isClientReferencedInAccountOrChain(resolvedClient, storagePath);
          if (isReferenced) {
            return true;
          }
          clientCheck = { error: new ServiceError('permission-denied', 'El archivo no está vinculado al cliente indicado') };
        } else {
          clientCheck = { error: new ServiceError('permission-denied', 'No tienes permiso para acceder a los documentos de este cliente') };
        }
      }
    }

    // Si ambos fueron provistos y ninguno autorizó el archivo
    if (context.prospectId && context.clientId) {
      throw new ServiceError('permission-denied', 'El archivo no está vinculado ni a la oportunidad ni al cliente indicados');
    }
    if (prospectCheck && prospectCheck.error) {
      throw prospectCheck.error;
    }
    if (clientCheck && clientCheck.error) {
      throw clientCheck.error;
    }

    // If flat path and no associated entity confirmed with a reference to the file
    throw new ServiceError('permission-denied', 'No se pudo verificar la autorización para acceder al archivo solicitado');
  }

function resolveContentType(fileName, metaContentType) {
  if (metaContentType && metaContentType !== 'application/octet-stream') {
    return metaContentType;
  }
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  return metaContentType || 'application/octet-stream';
}

  async function getSecureDownloadUrl({ caller, storagePath, fileName, prospectId, clientId, expiresInSeconds = DEFAULT_EXPIRATION_SECONDS, disposition = 'attachment' }) {
    const cleanPath = validateStoragePath(storagePath);
    await verifyDocumentAccess(caller, cleanPath, { prospectId, clientId });

    const file = bucket.file(cleanPath);
    const [exists] = await file.exists();
    if (!exists) {
      throw new ServiceError('not-found', 'El archivo no existe en el almacenamiento');
    }

    let meta = {};
    try {
      const [m] = await file.getMetadata();
      meta = m || {};
    } catch (e) {
      // ignore
    }

    const safeFileName = sanitizeFileName(fileName || cleanPath.split('/').pop() || 'documento');
    const safeExpiresInSeconds = normalizeExpirationSeconds(expiresInSeconds);
    const contentDisposition = buildContentDisposition(safeFileName, disposition);
    const effectiveContentType = resolveContentType(safeFileName, meta.contentType);

    const size = parseInt(meta.size || 0, 10);
    const expiresAt = new Date(Date.now() + safeExpiresInSeconds * 1000).toISOString();

    // In emulator or mock environment
    if (process.env.STORAGE_EMULATOR_HOST) {
      const host = process.env.STORAGE_EMULATOR_HOST.replace(/\/$/, '');
      const signedUrl = `${host}/v0/b/${bucket.name}/o/${encodeURIComponent(cleanPath)}?alt=media`;
      return {
        signedUrl,
        storagePath: cleanPath,
        fileName: safeFileName,
        size,
        contentType: effectiveContentType,
        expiresAt
      };
    }

    // In production V4 signed URL
    const signedUrlOptions = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + safeExpiresInSeconds * 1000,
      responseDisposition: contentDisposition
    };
    if (effectiveContentType && effectiveContentType !== 'application/octet-stream') {
      signedUrlOptions.responseType = effectiveContentType;
    }
    const [signedUrl] = await file.getSignedUrl(signedUrlOptions);

    return {
      signedUrl,
      storagePath: cleanPath,
      fileName: safeFileName,
      size,
      contentType: effectiveContentType,
      expiresAt
    };
  }

  return {
    names,
    validateStoragePath,
    verifyDocumentAccess,
    getSecureDownloadUrl,
    resolveCanonicalAccount: boundResolveCanonicalAccount,
    authorizeClientAccess
  };
}

module.exports = {
  createStorageService,
  hasEnteredPostclosing,
  ALLOWED_FOLDER_PREFIXES,
  PRIVILEGED_ROLES,
  PLANT_ROLES,
  normalizeExpirationSeconds,
  sanitizeFileName,
  buildContentDisposition,
  objectReferencesStoragePath,
  extractStoragePath,
  MAX_MERGE_DEPTH,
  isCallerActiveAndAuthenticated,
  authorizeClientAccess,
  resolveCanonicalAccount
};
