// functions/plantAuthService.js
// Minimal authentication for the fabricacion TABLETS (operador.html). Phase scope: a Cloud Function validates the PIN /
// numeric password ON THE SERVER and, when valid, hands back a Firebase Auth CUSTOM TOKEN, so the tablet can keep reading and
// writing Firestore directly under security rules (see isolated-tests/rules/plant-tablet.firestore.rules).
//
// What this module does NOT do (explicit, out of scope):
//  - it does not create Auth accounts with e-mail, nor touch `users_*` profiles (no authUid, no password hash, no migration);
//  - it does not give any commercial permission: the token carries { plant: true, role, cid } under the uid `plant_<cid>`,
//    which can never equal a CRM profile's `authUid`, so every commercial callable and every commercial rule refuses it;
//  - it does not log, store or return the PIN / password. The identifier and the IP are only kept as HMAC hashes in a server-only
//    collection used for the attempt limit.
//
// Dependency injection (db, auth, FieldValue, now) like the other services, so the same code runs against a fake Firestore (unit)
// and the Firestore + Auth emulators (isolated tests).
const crypto = require('crypto');
const { ServiceError } = require('./clientsService');

// Roles that can sign in from a tablet. Same list operador.js filters on (operador.js handleLogin).
const TABLET_ROLES = ['operario', 'encargado_armado', 'jefe_produccion', 'control_calidad', 'despacho'];

// Basic attempt limit (see PLANT_AUTH.md). Attempts are counted BEFORE the credentials are checked, inside a
// transaction, so parallel guesses cannot exceed the limit; a successful login releases them.
const POLICY = Object.freeze({
  maxAttemptsPerIdentifier: 5,   // per identifier (PIN / name / e-mail typed), per window
  maxAttemptsPerIp: 40,          // per client address, per window (a whole plant behind one NAT logs in at shift start)
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000
});

const PASSWORD_FORMAT = /^[0-9]{1,32}$/;   // "contraseña numérica"
const IDENTIFIER_MAX = 80;
const UID_FORMAT = /^[A-Za-z0-9_-]{1,100}$/;

const namesFor = suffix => ({ users: `users${suffix}`, attempts: `plantLoginAttempts${suffix}` });

function createPlantAuthService({ db, auth, FieldValue, suffix, now = () => new Date(), pepper = process.env.PLANT_LOGIN_PEPPER || '', policy = POLICY }) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  const names = namesFor(suffix);

  const hmac = (kind, value) => crypto.createHmac('sha256', `plant-login:${pepper}`).update(`${kind}:${suffix}:${value}`).digest('hex');
  // Constant-time equality over fixed-length digests (no length leak, no early exit).
  const safeEqual = (a, b) => {
    const da = crypto.createHash('sha256').update(String(a === undefined || a === null ? '' : a)).digest();
    const db_ = crypto.createHash('sha256').update(String(b === undefined || b === null ? '' : b)).digest();
    return crypto.timingSafeEqual(da, db_) && String(a === undefined || a === null ? '' : a) !== '';
  };

  // ---------- attempt limit ----------
  // Reserve one attempt on `key`. Refuses (resource-exhausted) while the key is locked, and locks it when the window's budget is spent.
  // The lock is written by the same transaction that decides it (the transaction returns instead of throwing, so it commits).
  async function reserveAttempt(key, max) {
    const ref = db.collection(names.attempts).doc(key);
    const t = now().getTime();
    const minutesLeft = until => Math.max(1, Math.ceil((until - t) / 60000));
    const blocked = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const d = snap.exists ? (snap.data() || {}) : {};
      if (d.lockedUntilMs && d.lockedUntilMs > t) return { until: d.lockedUntilMs };
      let count = d.count || 0;
      let windowStartMs = d.windowStartMs || t;
      if (t - windowStartMs > policy.windowMs || d.lockedUntilMs) { count = 0; windowStartMs = t; }   // window over, or a lock that has expired
      count += 1;
      if (count > max) {
        const until = t + policy.lockMs;
        tx.set(ref, { count: 0, windowStartMs: t, lockedUntilMs: until, lockedAtIso: now().toISOString() });
        return { until };
      }
      tx.set(ref, { count, windowStartMs, lockedUntilMs: 0 });
      return null;
    });
    if (blocked) throw new ServiceError('resource-exhausted', `Demasiados intentos fallidos. Intenta de nuevo en ${minutesLeft(blocked.until)} minuto(s).`);
  }
  // A good login gives the budget back: the identifier's counter is cleared, the address counter is decremented.
  async function releaseAttempt(key, mode) {
    const ref = db.collection(names.attempts).doc(key);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (mode === 'clear') tx.set(ref, { count: 0, windowStartMs: d.windowStartMs || now().getTime(), lockedUntilMs: 0 });
      else tx.set(ref, { ...d, count: Math.max(0, (d.count || 1) - 1) });
    });
  }

  // ---------- login ----------
  async function loadTabletProfiles() {
    const snaps = await Promise.all(TABLET_ROLES.map(r => db.collection(names.users).where('role', '==', r).get()));
    return snaps.flatMap(s => s.docs.map(d => ({ docId: d.id, ...d.data() })));
  }

  /**
   * @param {{ identifier: string, password: string, ip?: string }} input
   * @returns {Promise<{ token: string, profile: { id, nombre, role, stations, also_does_dispatch } }>}
   */
  async function login({ identifier, password, ip }) {
    if (typeof identifier !== 'string' || typeof password !== 'string') throw new ServiceError('invalid-argument', 'Datos de acceso inválidos');
    const ident = identifier.trim();
    if (!ident || ident.length > IDENTIFIER_MAX || !PASSWORD_FORMAT.test(password.trim())) {
      throw new ServiceError('invalid-argument', 'Indica tu PIN y tu contraseña numérica.');
    }
    const pass = password.trim();

    // 1. attempt limit (counted first, whether or not the identifier exists: no enumeration through the lock)
    if (ip) await reserveAttempt(`ip_${hmac('ip', ip)}`, policy.maxAttemptsPerIp);
    await reserveAttempt(`id_${hmac('id', ident.toLowerCase())}`, policy.maxAttemptsPerIdentifier);

    // 2. credentials, compared on the server. Every candidate is compared with the same work, match or not.
    const profiles = await loadTabletProfiles();
    const matches = profiles.filter(u => {
      // `|` / `&` (not `||` / `&&`) on purpose: every comparison always runs, so the time does not depend on which part matched.
      const idOk = safeEqual(u.pin, ident) | safeEqual(u.nombre, ident) | (typeof u.email === 'string' && safeEqual(u.email.trim().toLowerCase(), ident.toLowerCase()));
      const pwOk = safeEqual(u.password, pass);
      return !!(idOk & pwOk);
    });
    const denied = () => new ServiceError('permission-denied', 'Credenciales incorrectas o no tienes permisos de operador.');
    if (matches.length !== 1) throw denied();   // none, or ambiguous (two profiles share identifier AND password): never guess
    const u = matches[0];

    // 3. the operator must exist and be active (checked on the profile the server just read, not on anything the client sent)
    if (u.activo !== true) throw new ServiceError('permission-denied', 'Usuario inactivo. Consulta con el jefe de producción.');
    if (!TABLET_ROLES.includes(u.role)) throw denied();
    if (!UID_FORMAT.test(u.docId)) throw new ServiceError('failed-precondition', 'El perfil tiene un identificador no válido para iniciar sesión.');

    // 4. a successful login gives the attempts back, then the custom token is minted
    await releaseAttempt(`id_${hmac('id', ident.toLowerCase())}`, 'clear');
    if (ip) await releaseAttempt(`ip_${hmac('ip', ip)}`, 'decrement');

    // Claims are deliberately minimal and never include stations: the rules read the CURRENT profile on every request, so a change of
    // stations or a deactivation takes effect immediately (a custom token itself lives up to one hour).
    const token = await auth.createCustomToken(`plant_${u.docId}`, { plant: true, role: u.role, cid: u.docId });
    return {
      token,
      profile: {
        id: u.docId,
        nombre: u.nombre || '',
        role: u.role,
        stations: Array.isArray(u.stations) ? u.stations.filter(s => typeof s === 'string') : [],
        also_does_dispatch: u.also_does_dispatch === true
      }
    };
  }

  return { login, namesFor: () => names, TABLET_ROLES, POLICY: policy };
}

module.exports = { createPlantAuthService, TABLET_ROLES, POLICY, PASSWORD_FORMAT };
