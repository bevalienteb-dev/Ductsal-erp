// functions/clientIdentity.js
// Pure helpers (no Firebase): normalisation of NIT / DUI, name similarity and duplicate matching for CRM clients.
// Server-side source of truth for the duplicate prevention. The browser keeps a light copy only for UX hints.
//
// Schema facts (inspected in app_core.js saveClient / openClientModal):
//   tipo 'natural'  : nombres, apellidos, dui, nit (personal NIT), telefono, correo
//   tipo 'juridica' : empresa, contacto, nit (company NIT), nrc, rep_legal, dui_rep, nit_rep, telefono, correo
// Identity rules derived from that:
//   - DUI identifies a NATURAL client only. `dui_rep` / `nit_rep` belong to a representative who can legitimately
//     represent several companies, so they are NEVER identity keys.
//   - NIT identifies any client (a natural person's personal NIT or a company's NIT): one NIT = one taxpayer.
//   - NIT and DUI are different namespaces. The same digits found in the other field are only a review hint.
//   - Both documents are optional while saving (the CRM only demands them at later stages): an empty value never
//     blocks anything and never creates a key.

const DUI_DIGITS = 9;
const NIT_DIGITS = [9, 14];   // 14 = current NIT; 9 = historical NIT of a natural person (equals the DUI number)
const NRC_MIN_DIGITS = 5;
const NRC_MAX_DIGITS = 8;

const FILLER_RE = /^(?:n\/?a|s\/?n|sin(?:\s+(?:nit|nrc|dui|dato|datos|registro|documento))?|pendiente|por\s+definir|ninguno|no\s+tiene|no\s+aplica|null|undefined|none|[-._/\s0–—]+)$/i;

function onlyDigits(raw) {
  return String(raw === undefined || raw === null ? '' : raw).replace(/\D+/g, '');
}

function isFillerValue(raw) {
  if (raw === undefined || raw === null) return true;
  const s = String(raw).trim();
  if (!s) return true;
  if (FILLER_RE.test(s)) return true;
  const d = onlyDigits(s);
  if (d && /^0+$/.test(d)) return true;
  return false;
}

function hasUnexpectedAlpha(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  return /[a-zA-Z]/.test(s);
}

// Returns { status: 'empty' | 'ok' | 'padded' | 'invalid', digits, key }.
// 'padded': spreadsheets drop leading zeros, so 8 digits (DUI) / 13 digits (NIT) are restored with ONE zero.
// 'invalid': present but not a recognisable document -> no key (cannot be compared reliably); the caller warns.
function normalizeDui(raw) {
  if (isFillerValue(raw)) return { status: 'empty', digits: '', key: null };
  if (hasUnexpectedAlpha(raw)) return { status: 'invalid', digits: '', key: null };
  const d = onlyDigits(raw);
  if (!d) return { status: 'empty', digits: '', key: null };
  if (d.length === DUI_DIGITS) return { status: 'ok', digits: d, key: 'DUI_' + d };
  if (d.length === DUI_DIGITS - 1) return { status: 'padded', digits: '0' + d, key: 'DUI_0' + d };
  return { status: 'invalid', digits: d, key: null };
}

function normalizeNit(raw) {
  if (isFillerValue(raw)) return { status: 'empty', digits: '', key: null };
  if (hasUnexpectedAlpha(raw)) return { status: 'invalid', digits: '', key: null };
  const d = onlyDigits(raw);
  if (!d) return { status: 'empty', digits: '', key: null };
  if (NIT_DIGITS.includes(d.length)) return { status: 'ok', digits: d, key: 'NIT_' + d };
  if (d.length === 13) return { status: 'padded', digits: '0' + d, key: 'NIT_0' + d };
  if (d.length === 8) return { status: 'padded', digits: '0' + d, key: 'NIT_0' + d };
  return { status: 'invalid', digits: d, key: null };
}

function normalizeNrc(raw) {
  if (isFillerValue(raw)) return { status: 'empty', digits: '', key: null };
  if (hasUnexpectedAlpha(raw)) return { status: 'invalid', digits: '', key: null };
  const d = onlyDigits(raw);
  if (!d) return { status: 'empty', digits: '', key: null };
  if (d.length >= NRC_MIN_DIGITS && d.length <= NRC_MAX_DIGITS) {
    return { status: 'ok', digits: d, key: 'NRC_' + d };
  }
  return { status: 'invalid', digits: d, key: null };
}

// Identity documents of a client according to its type (see header).
function identifiersOf(client) {
  const c = client || {};
  const nit = normalizeNit(c.nit);
  const nrc = normalizeNrc(c.nrc);
  const dui = c.tipo === 'natural' ? normalizeDui(c.dui) : { status: 'empty', digits: '', key: null };
  return { nit, nrc, dui };
}

// Keys (index document ids) a client holds.
function keysOf(client) {
  const { nit, nrc, dui } = identifiersOf(client);
  return [nit.key, nrc.key, dui.key].filter(Boolean);
}

function formatWarnings(client) {
  const { nit, nrc, dui } = identifiersOf(client);
  const w = [];
  if (nit.status === 'invalid') w.push('El NIT no tiene un formato reconocible (se esperan 14 dígitos, o 9 en personas naturales); no se pudo comprobar duplicados por NIT.');
  if (nrc.status === 'invalid') w.push('El NRC no tiene un formato reconocible (se esperan entre 5 y 8 dígitos); no se pudo comprobar duplicados por NRC.');
  if (dui.status === 'invalid') w.push('El DUI no tiene un formato reconocible (se esperan 9 dígitos); no se pudo comprobar duplicados por DUI.');
  return w;
}

// ---------- names ----------
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e']);
const COMPANY_NOISE = new Set(['sa', 's', 'a', 'c', 'v', 'cv', 'rl', 'sociedad', 'anonima', 'capital', 'variable', 'ltda', 'limitada', 'responsabilidad', 'sas', 'srl', 'inc', 'corp', 'co', 'sapi', 'cia', 'compania']);

function foldText(s) {
  return String(s === undefined || s === null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function displayName(client) {
  const c = client || {};
  const name = c.tipo === 'natural'
    ? [c.nombres, c.apellidos].filter(Boolean).join(' ')
    : (c.empresa || c.razonSocial || c.nombreComercial || '');
  return String(name).trim();
}

function nameTokens(client) {
  const c = client || {};
  const text = foldText(displayName(c));
  const juridica = c.tipo !== 'natural';
  return Array.from(new Set(text.split(' ').filter(t => t && !PARTICLES.has(t) && !(juridica && COMPANY_NOISE.has(t)))));
}

function editDistanceLeq1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diffs = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++; j++;
    } else {
      diffs++;
      if (diffs > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else { i++; j++; }
    }
  }
  if (i < la || j < lb) diffs++;
  return diffs <= 1;
}

function tokensApproxMatch(t1, t2) {
  if (t1 === t2) return true;
  if (t1.length >= 5 && t2.length >= 5) {
    if (t1 + 's' === t2 || t2 + 's' === t1 || t1 + 'es' === t2 || t2 + 'es' === t1) return true;
    if (editDistanceLeq1(t1, t2)) return true;
  }
  return false;
}

// 'same' | 'similar' | null
function compareNames(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return null;
  const a = new Set(aTokens), b = new Set(bTokens);
  const inter = aTokens.filter(t => b.has(t)).length;
  if (inter === a.size && inter === b.size) return 'same';
  const small = a.size <= b.size ? a : b, big = a.size <= b.size ? b : a;
  const subset = Array.from(small).every(t => big.has(t));
  if (subset && small.size >= 2) return 'similar';
  if (subset && small.size === 1 && big.size === 2 && Array.from(small)[0].length >= 5) return 'similar';
  const union = a.size + b.size - inter;
  if (inter >= 2 && inter / union >= 0.75) return 'similar';
  // Approximate match for multi-word names with minor inflection/typo on one token
  if (a.size >= 2 && b.size >= 2) {
    const smallArr = Array.from(small);
    const bigArr = Array.from(big);
    const approxHits = smallArr.filter(st => bigArr.some(bt => tokensApproxMatch(st, bt))).length;
    if (approxHits === smallArr.length && (inter >= 1 || smallArr.length >= 2) && Math.abs(a.size - b.size) <= 1) {
      if (inter >= 1) return 'similar';
    }
  }
  return null;
}

// ---------- contact data ----------
function phoneKey(raw) {
  const d = onlyDigits(raw);
  return d.length >= 8 ? d.slice(-8) : '';
}
function emailKey(raw) {
  const e = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(e) ? e : '';
}

// ---------- matching ----------
// Compares a candidate (the client being created / edited) with ONE existing client.
// Returns null or { level: 'exact' | 'review' | 'info', reasons: [...] }.
//   exact  : same NIT, same NRC, or same DUI (natural clients) -> creation is refused
//   review : same / similar name, or an identity document found in the other field -> warn, user confirms
//   info   : only phone / e-mail in common -> shown, never required to confirm
function matchClients(candidate, existing) {
  const a = identifiersOf(candidate), b = identifiersOf(existing);
  const reasons = [];
  let level = null;
  const raise = l => { const order = { info: 1, review: 2, exact: 3 }; if (!level || order[l] > order[level]) level = l; };

  if (a.nit.key && a.nit.key === b.nit.key) { reasons.push('nit'); raise('exact'); }
  if (a.nrc.key && a.nrc.key === b.nrc.key) { reasons.push('nrc'); raise('exact'); }
  if (a.dui.key && a.dui.key === b.dui.key) { reasons.push('dui'); raise('exact'); }

  // Same digits, different namespace: NIT <-> DUI. A review hint, never an automatic block.
  if (a.nit.digits && b.dui.digits && a.nit.digits === b.dui.digits) { reasons.push('nit-igual-a-dui-de-otro'); raise('review'); }
  if (a.dui.digits && b.nit.digits && a.dui.digits === b.nit.digits) { reasons.push('dui-igual-a-nit-de-otro'); raise('review'); }

  const nameRel = compareNames(nameTokens(candidate), nameTokens(existing));
  if (nameRel === 'same') { reasons.push('nombre-igual'); raise('review'); }
  else if (nameRel === 'similar') { reasons.push('nombre-parecido'); raise('review'); }

  const pa = phoneKey(candidate && candidate.telefono), pb = phoneKey(existing && existing.telefono);
  if (pa && pa === pb) { reasons.push('telefono'); raise('info'); }
  const ea = emailKey(candidate && candidate.correo), eb = emailKey(existing && existing.correo);
  if (ea && ea === eb) { reasons.push('correo'); raise('info'); }

  return level ? { level, reasons } : null;
}

// Finds the matches of `candidate` among `clients` (ignoring `ignoreId`), strongest first.
function findMatches(candidate, clients, ignoreId) {
  const isIgnored = ignoreId instanceof Set
    ? (id => ignoreId.has(id))
    : (id => Boolean(ignoreId && id === ignoreId));
  const out = [];
  for (const c of clients || []) {
    if (!c || isIgnored(c.id)) continue;
    const m = matchClients(candidate, c);
    if (m) out.push({ clientId: c.id, ...m });
  }
  const order = { exact: 0, review: 1, info: 2 };
  return out.sort((x, y) => order[x.level] - order[y.level]);
}

// Masks an identifier so lists never reveal a full document: "NIT ····1234".
function maskDigits(digits, label) {
  return digits ? `${label} ····${digits.slice(-4)}` : '';
}
function identifierHint(client) {
  const { nit, nrc, dui } = identifiersOf(client);
  return maskDigits(dui.digits, 'DUI') || maskDigits(nit.digits, 'NIT') || maskDigits(nrc.digits, 'NRC');
}

module.exports = {
  onlyDigits, isFillerValue, normalizeDui, normalizeNit, normalizeNrc, identifiersOf, keysOf, formatWarnings,
  foldText, displayName, nameTokens, compareNames, phoneKey, emailKey,
  matchClients, findMatches, maskDigits, identifierHint
};
