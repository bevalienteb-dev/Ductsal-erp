// functions/storageService.js
// SEC-05 Phase 1.1: Secure Storage Service
// Handles server-side route validation, business entity authorization,
// and short-lived signed URL generation for universal file downloads.

const { ServiceError } = require('./clientsService');

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

function buildContentDisposition(cleanName) {
  // ASCII fallback for filename="" (RFC 6266): replace non-ASCII with '_' and strip quotes
  const asciiName = cleanName.replace(/["\\]/g, '').replace(/[^\x20-\x7E]/g, '_') || 'documento';
  // UTF-8 encoding for filename*=UTF-8''... preserving spaces (%20), accents, Spanish chars (á, é, í, ó, ú, ñ)
  const utf8Encoded = encodeURIComponent(cleanName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Encoded}`;
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
  return p.postcierre_habilitado === true
    || (typeof p.fecha_cierre === 'string' && p.fecha_cierre.length > 0)
    || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre)
    || (Array.isArray(p.facturas) && p.facturas.length > 0);
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

  async function verifyDocumentAccess(caller, storagePath, context = {}) {
    if (!caller || !caller.uid || !caller.role) {
      throw new ServiceError('unauthenticated', 'Autenticación requerida');
    }

    const parts = storagePath.split('/');
    const folder = parts[1];
    const entityId = parts[2];

    // Manager has unrestricted access to all CRM documents
    if (caller.role === 'manager') {
      return true;
    }

    // Plant files (requerimientos, fabricacion_archivos)
    if (folder === 'requerimientos' || folder === 'fabricacion_archivos') {
      if (PLANT_ROLES.includes(caller.role)) return true;
      throw new ServiceError('permission-denied', 'Solo personal de planta autorizado puede acceder a estos archivos');
    }

    // If caller is plant role trying to access commercial documents
    if (PLANT_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'Personal de planta no tiene acceso a documentos comerciales');
    }

    // Gestor has full access to client documents (catalog verification)
    if (caller.role === 'gestor' && folder === 'clients') {
      return true;
    }

    // Commercial seller (vendedor) checks:
    if (folder === 'clients' && entityId) {
      // Entity-scoped client path: prod_files/clients/{clientId}/...
      const clientSnap = await db.collection(names.clients).doc(entityId).get();
      if (!clientSnap.exists) {
        // Check if it's an active reservation owned by caller
        const resSnap = await db.collection(names.reservations).doc(entityId).get();
        if (resSnap.exists && resSnap.data().createdBy === caller.cid) {
          return true;
        }
        throw new ServiceError('not-found', 'Cliente no encontrado');
      }
      const c = clientSnap.data();
      const isOwner = c.createdBy === caller.cid;
      const isVisible = Array.isArray(c.visibleTo) && c.visibleTo.includes(caller.cid);
      const isClosing = Array.isArray(c.closingVendors) && c.closingVendors.includes(caller.cid);
      if (isOwner || isVisible || isClosing) return true;
      throw new ServiceError('permission-denied', 'No tienes permiso para acceder a los documentos de este cliente');
    }

    if (folder === 'prospects' && entityId) {
      // Entity-scoped prospect path: prod_files/prospects/{prospectId}/...
      const prospectSnap = await db.collection(names.prospects).doc(entityId).get();
      if (!prospectSnap.exists) {
        throw new ServiceError('not-found', 'Oportunidad no encontrada');
      }
      const p = prospectSnap.data();
      if (p.eliminado === true) {
        throw new ServiceError('not-found', 'La oportunidad fue eliminada');
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

    // Flat legacy folders: must verify that the requested file is actually referenced in an authorized entity
    let prospectCheck = null;
    let clientCheck = null;

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
            if (objectReferencesStoragePath(p, storagePath)) {
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
      const cSnap = await db.collection(names.clients).doc(context.clientId).get();
      if (cSnap.exists) {
        const c = cSnap.data();
        const hasAccess = caller.role === 'manager' || caller.role === 'gestor'
          || (c.createdBy === caller.cid || (Array.isArray(c.visibleTo) && c.visibleTo.includes(caller.cid)) || (Array.isArray(c.closingVendors) && c.closingVendors.includes(caller.cid)));
        if (hasAccess) {
          if (objectReferencesStoragePath(c, storagePath)) {
            return true;
          }
          clientCheck = { error: new ServiceError('permission-denied', 'El archivo no está vinculado al cliente indicado') };
        } else {
          clientCheck = { error: new ServiceError('permission-denied', 'No tienes permiso para acceder a los documentos de este cliente') };
        }
      } else {
        clientCheck = { error: new ServiceError('not-found', 'Cliente no encontrado') };
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

  async function getSecureDownloadUrl({ caller, storagePath, fileName, prospectId, clientId, expiresInSeconds = DEFAULT_EXPIRATION_SECONDS }) {
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
    const contentDisposition = buildContentDisposition(safeFileName);

    const size = parseInt(meta.size || 0, 10);
    const contentType = meta.contentType || 'application/octet-stream';
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
        contentType,
        expiresAt
      };
    }

    // In production V4 signed URL
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + safeExpiresInSeconds * 1000,
      responseDisposition: contentDisposition
    });

    return {
      signedUrl,
      storagePath: cleanPath,
      fileName: safeFileName,
      size,
      contentType,
      expiresAt
    };
  }

  return {
    names,
    validateStoragePath,
    verifyDocumentAccess,
    getSecureDownloadUrl
  };
}

module.exports = {
  createStorageService,
  ALLOWED_FOLDER_PREFIXES,
  PRIVILEGED_ROLES,
  PLANT_ROLES,
  normalizeExpirationSeconds,
  sanitizeFileName,
  buildContentDisposition,
  objectReferencesStoragePath,
  extractStoragePath
};
