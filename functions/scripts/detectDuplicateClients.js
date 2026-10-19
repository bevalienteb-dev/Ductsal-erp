#!/usr/bin/env node
// functions/scripts/detectDuplicateClients.js
// READ-ONLY report of historical duplicate clients. It NEVER writes, merges or deletes anything.
//
// Input (one of):
//   --input clients.json   a JSON array of client documents exported BY A HUMAN (offline analysis of real data:
//                          nothing is connected to production by this script).
//   --emulator             reads `clients_local` from a Firestore EMULATOR (FIRESTORE_EMULATOR_HOST must be loopback).
// Output: Markdown report on stdout (or --out file). Documents are masked ("NIT ····1234"); no phone, e-mail,
// address or full document number is printed. See CLIENT_CATALOG_AND_DEDUPE.md for the resolution plan.
//
// Same normalisation and rules as the server (clientIdentity.js): a NIT is a key for any client, a DUI only for a
// persona natural; dui_rep / nit_rep / nrc are never keys.

const fs = require('fs');
const id = require('../clientIdentity');
const { isLoopbackHost } = require('../emulatorGuard');

function analyze(clients) {
  const list = (clients || []).filter(c => c && c.id);
  const byKey = new Map();
  for (const c of list) for (const k of id.keysOf(c)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
  const exactGroups = [...byKey.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({ key: maskKey(key), kind: key.split('_')[0], clients: v.map(brief) }));

  // doubtful: same / similar name WITHOUT a shared exact key (exact groups are reported above)
  const exactPairs = new Set();
  for (const [, v] of byKey) if (v.length > 1) for (const a of v) for (const b of v) if (a.id < b.id) exactPairs.add(a.id + '|' + b.id);
  const reviewPairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = list[i].id < list[j].id ? [list[i], list[j]] : [list[j], list[i]];
      if (exactPairs.has(a.id + '|' + b.id)) continue;
      const m = id.matchClients(a, b);
      if (m && m.level === 'review') reviewPairs.push({ a: brief(a), b: brief(b), reasons: m.reasons });
    }
  }
  const noKey = list.filter(c => id.keysOf(c).length === 0).length;
  const malformed = list.filter(c => id.formatWarnings(c).length > 0).length;
  return { total: list.length, withoutDocument: noKey, malformedDocument: malformed, exactGroups, reviewPairs };
}

function maskKey(key) { const [k, d] = key.split('_'); return `${k} ····${d.slice(-4)}`; }
function brief(c) {
  return { id: c.id, nombre: id.displayName(c), tipo: c.tipo || '', hint: id.identifierHint(c), createdBy: c.createdBy || '', fecha: (c.fecha_creacion || '').slice(0, 10) };
}

function toMarkdown(r) {
  const out = [];
  out.push('# Reporte de clientes duplicados (solo lectura)', '');
  out.push(`- Clientes analizados: **${r.total}**`);
  out.push(`- Sin NIT/DUI utilizable (no indexables): ${r.withoutDocument}`);
  out.push(`- Con documento mal formado (advertencia, no clave): ${r.malformedDocument}`);
  out.push(`- Grupos con documento IGUAL (duplicados exactos): **${r.exactGroups.length}**`);
  out.push(`- Parejas dudosas por nombre (revisión humana): **${r.reviewPairs.length}**`, '');
  out.push('## 1. Duplicados exactos (mismo NIT o mismo DUI de persona natural)', '');
  if (!r.exactGroups.length) out.push('Ninguno.', '');
  r.exactGroups.forEach((g, i) => {
    out.push(`### Grupo ${i + 1} - ${g.key} (${g.clients.length} clientes)`);
    g.clients.forEach(c => out.push(`- \`${c.id}\` ${c.nombre} (${c.tipo || 's/tipo'}) creado por \`${c.createdBy || '?'}\` ${c.fecha}`));
    out.push('');
  });
  out.push('## 2. Parejas dudosas (mismo nombre / nombre parecido, documentos distintos o ausentes)', '');
  if (!r.reviewPairs.length) out.push('Ninguna.', '');
  r.reviewPairs.forEach(p => out.push(`- \`${p.a.id}\` ${p.a.nombre} ${p.a.hint} ↔ \`${p.b.id}\` ${p.b.nombre} ${p.b.hint} — ${p.reasons.join(', ')}`));
  out.push('', '> Este reporte no corrige nada. Plan de resolución: CLIENT_CATALOG_AND_DEDUPE.md, sección "Duplicados históricos".');
  return out.join('\n');
}

async function loadFromEmulator() {
  if (!isLoopbackHost(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('--emulator needs FIRESTORE_EMULATOR_HOST set to a loopback address');
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-ductsal-local';
  if (!/^demo-/.test(process.env.GCLOUD_PROJECT)) throw new Error('GCLOUD_PROJECT must be a demo- project');
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const snap = await getFirestore().collection('clients_local').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function main(argv) {
  const arg = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
  let clients;
  if (arg('--input')) clients = JSON.parse(fs.readFileSync(arg('--input'), 'utf8'));
  else if (argv.includes('--emulator')) clients = await loadFromEmulator();
  else { console.error('Usage: detectDuplicateClients.js --input clients.json | --emulator [--out report.md]'); process.exit(2); }
  const md = toMarkdown(analyze(clients));
  if (arg('--out')) fs.writeFileSync(arg('--out'), md + '\n'); else console.log(md);
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });

module.exports = { analyze, toMarkdown };
