// functions/legacyImport.js
// Explicit, owner-run replacement of the old automatic "migrate localStorage to Firebase" block of app_core.js.
//
// What the old block did (removed): on EVERY page load, for ANY visitor and before login, if the browser held
// `ductsal_clients` and no `migrated_to_firebase` flag, it `.set()` (overwrite by id) the browser's clients, prospects, users
// (with their plaintext passwords and roles) and the whole `system/settings` document, then set the flag.
//
// What this does instead:
//   - It is NOT reachable from any page. It runs with the Admin SDK under the owner's own credentials (script
//     scripts/importLegacyLocalStorage.js), from a JSON file the owner exported from the old browser.
//   - Validation first (dry run by default): shape, ids, enumerations, client identity (NIT / DUI) against the existing
//     identifier index, opportunity -> client reference, opportunity code uniqueness. Nothing is written until `apply`.
//   - Create-only. An id that already exists is `identical` (skipped, so re-running is idempotent) or `conflict` (skipped and
//     reported). It never overwrites a document and never touches a collection that is not clients / prospects /
//     the lists of system/settings.
//   - Users are NEVER imported: they carry plaintext passwords and identity migration is a separate, pending decision.
//   - One server-side audit entry (counts + hash of the file) is written on apply.
// The opportunity counter of the year is not touched: see LEGACY_IMPORT.md for the code-collision consideration.

const crypto = require('crypto');
const identity = require('./clientIdentity');
const { stableHash } = require('./clientsService');

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORDS = 5000;
const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
const ESTADOS = ['activo', 'ganado', 'perdido'];
const CLIENT_TYPES = ['natural', 'juridica'];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const hasName = c => (c.tipo === 'natural' ? !!(c.nombres || c.apellidos) : !!c.empresa);

// JSON from localStorage has no Firestore-only types, so structural equality via a stable hash is exact.
const sameData = (a, b) => stableHash(a) === stableHash(b);

function validateClient(c) {
  const problems = [];
  if (!isObj(c)) return ['no es un objeto'];
  if (typeof c.id !== 'string' || !DOC_ID_RE.test(c.id)) problems.push('id inválido');
  if (!CLIENT_TYPES.includes(c.tipo)) problems.push('tipo inválido');
  else if (!hasName(c)) problems.push('sin nombre');
  return problems;
}

function validateProspect(p) {
  const problems = [];
  if (!isObj(p)) return ['no es un objeto'];
  if (typeof p.id !== 'string' || !DOC_ID_RE.test(p.id)) problems.push('id inválido');
  if (typeof p.clientId !== 'string' || !DOC_ID_RE.test(p.clientId)) problems.push('clientId inválido');
  if (!ESTADOS.includes(p.estado)) problems.push('estado inválido');
  if (!STAGES.includes(p.etapa)) problems.push('etapa inválida');
  if (p.logs !== undefined && !Array.isArray(p.logs)) problems.push('logs inválido');
  if (p.facturas !== undefined && !Array.isArray(p.facturas)) problems.push('facturas inválido');
  return problems;
}

function validateSettings(s) {
  if (s === undefined || s === null) return { value: null, problems: [] };
  if (!isObj(s)) return { value: null, problems: ['settings no es un objeto'] };
  const out = {};
  const problems = [];
  for (const k of ['visitantes', 'encargados']) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || s[k].some(x => typeof x !== 'string' || !x.trim() || x.length > 120)) problems.push(`${k} inválido`);
    else out[k] = Array.from(new Set(s[k].map(x => x.trim())));
  }
  if (s.factory_address !== undefined) {
    if (typeof s.factory_address !== 'string' || s.factory_address.length > 300) problems.push('factory_address inválido');
    else out.factory_address = s.factory_address.trim();
  }
  return { value: Object.keys(out).length ? out : null, problems }; // gmaps_api_key and anything else is deliberately not imported
}

/**
 * @param db        Admin Firestore (pointed at an emulator by the caller)
 * @param payload   { clients?: [], prospects?: [], users?: [] (ignored), settings?: {} }
 * @param suffix    '_local' | '_prod'
 * @param apply     false (default) = validate and report only
 * @returns report  { mode, fileHash, clients, prospects, settings, users, problems[] , applied }
 */
async function importLegacy({ db, FieldValue, suffix, payload, apply = false, operator = 'unknown', now = () => new Date() }) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  if (!isObj(payload)) throw new Error('El archivo debe ser un objeto JSON con clients / prospects / settings');
  const clients = payload.clients === undefined ? [] : payload.clients;
  const prospects = payload.prospects === undefined ? [] : payload.prospects;
  if (!Array.isArray(clients) || !Array.isArray(prospects)) throw new Error('clients y prospects deben ser listas');
  if (clients.length + prospects.length > MAX_RECORDS) throw new Error(`Demasiados registros (máximo ${MAX_RECORDS} por archivo)`);

  const col = n => db.collection(`${n}${suffix}`);
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    fileHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    clients: { total: clients.length, new: 0, identical: 0, conflict: 0, invalid: 0 },
    prospects: { total: prospects.length, new: 0, identical: 0, conflict: 0, invalid: 0 },
    settings: { status: 'absent-in-file' },
    users: { skipped: Array.isArray(payload.users) ? payload.users.length : 0, reason: 'users are never imported (plaintext passwords; identity migration is a separate decision)' },
    problems: [],
    applied: false
  };
  const note = (kind, id, problem) => report.problems.push({ kind, id: id === undefined ? null : id, problem });

  // ---- structural validation of the whole file first: duplicates inside the file are invalid, not "last one wins" ----
  const seen = { clients: new Set(), prospects: new Set() };
  const goodClients = []; const goodProspects = [];
  for (const [kind, list, good] of [['clients', clients, goodClients], ['prospects', prospects, goodProspects]]) {
    for (const rec of list) {
      const problems = kind === 'clients' ? validateClient(rec) : validateProspect(rec);
      const id = isObj(rec) ? rec.id : undefined;
      if (problems.length === 0 && seen[kind].has(rec.id)) problems.push('id repetido en el archivo');
      if (problems.length) { report[kind].invalid += 1; note(kind, id, problems.join('; ')); continue; }
      seen[kind].add(rec.id);
      good.push(rec);
    }
  }
  const settingsCheck = validateSettings(payload.settings);
  settingsCheck.problems.forEach(p => note('settings', 'settings', p));

  // Identity inside the file: two clients of the file claiming the same NIT / DUI cannot both be created.
  const fileKeyOwner = new Map();
  const dupInFile = new Set();
  for (const c of goodClients) {
    for (const k of identity.keysOf(c)) {
      if (fileKeyOwner.has(k) && fileKeyOwner.get(k) !== c.id) { dupInFile.add(c.id); note('clients', c.id, `comparte ${k} con el cliente ${fileKeyOwner.get(k)} del mismo archivo`); } else fileKeyOwner.set(k, c.id);
    }
  }
  const codeOwner = new Map();
  const dupCode = new Set();
  for (const p of goodProspects) {
    if (!p.codigo) continue;
    if (codeOwner.has(p.codigo) && codeOwner.get(p.codigo) !== p.id) { dupCode.add(p.id); note('prospects', p.id, `el código ${p.codigo} se repite en el archivo`); } else codeOwner.set(p.codigo, p.id);
  }

  // ---- per-record classification against the database; the same function runs inside the transaction when applying ----
  async function classifyClient(read, c) {
    if (dupInFile.has(c.id)) return { status: 'conflict' };
    const cur = await read(col('clients').doc(c.id));
    if (cur.exists) return sameData(cur.data(), c) ? { status: 'identical' } : { status: 'conflict', problem: 'ya existe con datos distintos (no se sobrescribe)' };
    for (const k of identity.keysOf(c)) {
      const idx = await read(col('clientIdentifiers').doc(k));
      if (idx.exists && idx.data().clientId !== c.id) return { status: 'conflict', problem: `${k} ya pertenece al cliente ${idx.data().clientId}` };
    }
    return { status: 'new' };
  }
  async function classifyProspect(read, p, clientIdsInFile) {
    if (dupCode.has(p.id)) return { status: 'conflict' };
    const cur = await read(col('prospects').doc(p.id));
    if (cur.exists) return sameData(cur.data(), p) ? { status: 'identical' } : { status: 'conflict', problem: 'ya existe con datos distintos (no se sobrescribe)' };
    if (!clientIdsInFile.has(p.clientId)) {
      const cl = await read(col('clients').doc(p.clientId));
      if (!cl.exists) return { status: 'conflict', problem: `el cliente ${p.clientId} no existe ni viene en el archivo` };
    }
    if (p.codigo) {
      const q = await col('prospects').where('codigo', '==', p.codigo).limit(1).get();
      if (!q.empty && q.docs[0].id !== p.id) return { status: 'conflict', problem: `el código ${p.codigo} ya lo usa la oportunidad ${q.docs[0].id}` };
    }
    return { status: 'new' };
  }

  const direct = ref => ref.get();
  const clientIdsInFile = new Set(goodClients.map(c => c.id));
  const plan = { clients: [], prospects: [] };
  for (const c of goodClients) {
    const r = await classifyClient(direct, c);
    report.clients[r.status] += 1;
    if (r.problem) note('clients', c.id, r.problem);
    if (r.status === 'new') plan.clients.push(c);
  }
  // A prospect may reference a client that is only "new" (not yet in the database) in this same file.
  for (const p of goodProspects) {
    const r = await classifyProspect(direct, p, clientIdsInFile);
    // a client of the file that turned out to be in conflict cannot be referenced unless it exists in the database already
    if (r.status === 'new' && clientIdsInFile.has(p.clientId) && !plan.clients.some(c => c.id === p.clientId)) {
      const cl = await col('clients').doc(p.clientId).get();
      if (!cl.exists) { report.prospects.conflict += 1; note('prospects', p.id, `su cliente ${p.clientId} no se puede importar`); continue; }
    }
    report.prospects[r.status] += 1;
    if (r.problem) note('prospects', p.id, r.problem);
    if (r.status === 'new') plan.prospects.push(p);
  }
  if (settingsCheck.value) {
    const cur = await col('system').doc('settings').get();
    report.settings = { status: cur.exists ? 'exists (not overwritten)' : 'new', keys: Object.keys(settingsCheck.value) };
  } else if (payload.settings !== undefined && payload.settings !== null) {
    report.settings = { status: 'nothing-importable' };
  }

  if (!apply) return report;
  // Apply is refused when the file has invalid records: the owner fixes the file, the report is not a partial import.
  if (report.clients.invalid || report.prospects.invalid) {
    report.refused = 'El archivo tiene registros inválidos: corrígelo y vuelve a validar. No se escribió nada.';
    return report;
  }

  // ---- apply: create-only, each record in its own transaction re-checking its classification ----
  const applied = { clients: 0, prospects: 0, settings: false, lostRace: 0 };
  for (const c of plan.clients) {
    const keys = identity.keysOf(c);
    const outcome = await db.runTransaction(async tx => {
      const r = await classifyClient(ref => tx.get(ref), c);
      if (r.status !== 'new') return r.status;
      tx.create(col('clients').doc(c.id), c);
      for (const k of keys) tx.set(col('clientIdentifiers').doc(k), { key: k, kind: k.split('_')[0], clientId: c.id, createdBy: 'legacy-import', createdAt: FieldValue.serverTimestamp() });
      return 'new';
    });
    if (outcome === 'new') applied.clients += 1; else applied.lostRace += 1;
  }
  for (const p of plan.prospects) {
    const outcome = await db.runTransaction(async tx => {
      const cur = await tx.get(col('prospects').doc(p.id));
      if (cur.exists) return 'exists';
      tx.create(col('prospects').doc(p.id), p);
      return 'new';
    });
    if (outcome === 'new') applied.prospects += 1; else applied.lostRace += 1;
  }
  if (settingsCheck.value) {
    try { await col('system').doc('settings').create(settingsCheck.value); applied.settings = true; } catch (e) { /* exists: never overwritten */ }
  }
  await col('commercialAudit').doc().create({
    action: 'legacyImport', targetType: 'import', targetId: report.fileHash.slice(0, 16),
    detail: { fileHash: report.fileHash, clients: applied.clients, prospects: applied.prospects, settings: applied.settings, skippedUsers: report.users.skipped },
    actorUid: 'import-script', actorCid: String(operator).slice(0, 80), actorName: String(operator).slice(0, 80), actorRole: 'owner',
    at: FieldValue.serverTimestamp(), atIso: now().toISOString()
  });
  report.applied = true;
  report.created = applied;
  return report;
}

module.exports = { importLegacy, validateClient, validateProspect, validateSettings, MAX_RECORDS };
