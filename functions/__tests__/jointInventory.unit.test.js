// functions/__tests__/jointInventory.unit.test.js
// UNIT layer (static analysis, no emulator, no network): what each module really touches in Firestore and Storage.
// It READS the sibling repository `../fabricacion-dev` (never writes). If it is not there the fabricacion half is skipped.
// Purpose: a drift guard for functions/JOINT_VALIDATION.md - when fabricacion (or the CRM) starts using another collection, a
// Storage folder or a new direct writer, this fails and the matrix/plan has to be revisited before hardening any rule.

const fs = require('fs');
const path = require('path');

const CRM = path.join(__dirname, '..', '..');
const FAB = path.join(CRM, '..', 'fabricacion-dev');
const haveFab = fs.existsSync(path.join(FAB, 'operador.js'));
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function collectionsIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/collection\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")\s*\)/g)) {
    out.add((m[2] || m[3] || m[4]).replace('${DB_SUFFIX}', '*'));
  }
  return [...out].sort();
}
const uploadFolders = src => [...new Set([...src.matchAll(/uploadFileToStorage\([^;]*?,\s*'([a-z_]+)'(?:\s*\)|\s*,)/g)].map(m => m[1]))].sort();

const CRM_CLIENT_FILES = ['app_core.js', 'crm_auth.js', 'crm_clients.js', 'crm_commercial.js', 'crm_env.js'];
const FAB_FILES = ['app.js', 'operador.js', 'bom.js', ...(haveFab ? fs.readdirSync(path.join(FAB, 'js')).map(f => `js/${f}`) : [])];

describe('CRM (sales-reporting-system): collections, writers and Storage paths', () => {
  const src = strip(CRM_CLIENT_FILES.map(f => read(CRM, f)).join('\n'));
  test('the browser reads exactly these collections (scoped onSnapshot listeners including userDirectory)', () => {
    expect(collectionsIn(src)).toEqual(['audit_logs*', 'clients*', 'prospects*', 'system*', 'userDirectory*', 'users*']);
  });
  test('the only direct Firestore writer left in the CRM is saveUserToDB, kept for historical users without an Auth account (refuses profiles with authUid)', () => {
    const writers = [...src.matchAll(/collection\([^)]*\)[^;\n]*\.(set|update|delete|add)\(/g)].map(m => m[0].slice(0, 90));
    expect(writers).toEqual(['collection(`users${DB_SUFFIX}`).doc(u.id).set(']);
    expect(src).toMatch(/function saveUserToDB\(u\) \{\s*if \(u && u\.authUid\) throw/);
  });
  test('uploads go to the flat folders; the candidate storage.rules expect prospects/{pid}/{folder}/{file} and clients/{cid}/{file}', () => {
    expect(uploadFolders(src)).toEqual(['clientes', 'facturas', 'ordenes_cambio', 'pagos', 'proyectos']);
    expect(src).toMatch(/\$\{STORAGE_PREFIX\}\/\$\{folderName\}\//);
  });
});

(haveFab ? describe : describe.skip)('fabricacion-dev: collections, direct writers and Storage paths (read-only inspection)', () => {
  const all = strip(FAB_FILES.map(f => read(FAB, f)).join('\n'));
  test('collections touched', () => {
    expect(collectionsIn(all)).toEqual([
      'alertas_maquinas', 'audit_logs*', 'bobinas_soldadura*', 'clients*', 'config', 'fabricacion*', 'fabricacion_tasks*',
      'prospects*', 'proyectos_fabricacion*', 'system*', 'users*'
    ]);
  });
  test('collections WITHOUT environment suffix (shared by local and prod browsers)', () => {
    expect(collectionsIn(all).filter(c => !c.endsWith('*'))).toEqual(['alertas_maquinas', 'config']);
  });
  test('the operator tablet app has Firebase Auth, Firestore and Functions SDK for server-side plantLogin', () => {
    const html = read(FAB, 'operador.html');
    expect(html).toMatch(/firebase-app-compat/);
    expect(html).toMatch(/firebase-firestore-compat/);
    expect(html).toMatch(/firebase-auth-compat/);
    expect(html).toMatch(/firebase-functions-compat/);
    expect(strip(read(FAB, 'operador.js'))).toMatch(/firebase\.auth\(\)\.signInWithCustomToken/);
  });
  test('the fabricacion index app loads Firebase Auth and Functions SDK', () => {
    const html = read(FAB, 'index.html');
    expect(html).toMatch(/firebase-auth-compat/);
    expect(html).toMatch(/firebase-functions-compat/);
    expect(html).toMatch(/firebase-storage-compat/);
  });
  test('operator login uses server-side plantLogin callable and signs in with custom token', () => {
    const op = strip(read(FAB, 'operador.js'));
    expect(op).toMatch(/httpsCallable\(['"]plantLogin['"]\)/);
    expect(op).toMatch(/signInWithCustomToken\(/);
    expect(op).not.toMatch(/u\.password === pass/);
  });
  test('Storage uploads of fabricacion use the same flat folders as the CRM, plus requerimientos and fabricacion_archivos', () => {
    expect(uploadFolders(all)).toEqual(['clientes', 'fabricacion_archivos', 'facturas', 'ordenes_cambio', 'pagos', 'proyectos', 'requerimientos']);
    expect(all).toMatch(/\$\{STORAGE_PREFIX\}\/\$\{folderName\}\//);
  });
  test('no Firestore transaction anywhere in fabricacion: read-then-write with last write wins', () => {
    expect(all).not.toMatch(/runTransaction/);
  });
  test('direct writers of the commercial collections that still exist in fabricacion', () => {
    const writers = [...all.matchAll(/collection\(`(clients|prospects|users)\$\{DB_SUFFIX\}`\)\.doc\([^)]*\)\.(set|delete)\(/g)].map(m => `${m[1]}.${m[2]}`).sort();
    expect(writers).toEqual(['clients.delete', 'clients.set', 'clients.set', 'prospects.delete', 'prospects.set', 'prospects.set', 'prospects.set', 'users.set', 'users.set']);
  });
  test('opportunity codes are generated in the browser from the local snapshot (count + 1); project ids are "FAB-PROJ-" + Date.now()', () => {
    const opp = strip(read(FAB, 'js/oportunidades.js'));
    expect(opp).toMatch(/prospectsThisYear\.length \+ 1/);
    expect(strip(read(FAB, 'js/fabricacion.js'))).toMatch(/"FAB-PROJ-" \+ Date\.now\(\)/);
  });
  test('fabricacion deletes an opportunity physically and cascades to proyectos_fabricacion (contradicts the logical-deletion decision)', () => {
    const opp = strip(read(FAB, 'js/oportunidades.js'));
    expect(opp).toMatch(/collection\(`prospects\$\{DB_SUFFIX\}`\)\.doc\(p\.id\)\.delete\(\)/);
    expect(opp).toMatch(/proyectos_fabricacion\$\{DB_SUFFIX\}`\)\.where\('prospecto_id', '==', p\.id\)/);
  });
  test('fabricacion does not know the logical-deletion flag', () => {
    // the flag itself (field access / key / string literal), not the Spanish word in alert texts and audit details
    expect(all).not.toMatch(/\.eliminado\b|['"]eliminado['"]|\beliminado\s*[:=]/);
  });
});
