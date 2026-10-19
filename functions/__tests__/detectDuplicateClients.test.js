// Historical-duplicate report: offline, read-only, masked output.
const fs = require('fs');
const path = require('path');
const { analyze, toMarkdown } = require('../scripts/detectDuplicateClients');

const juridica = (id, empresa, nit, o = {}) => ({ id, tipo: 'juridica', empresa, contacto: 'C', telefono: '7000-9999', correo: 'dato.privado@x.invalid', nit, createdBy: 'V1', fecha_creacion: '2025-03-01T00:00:00Z', ...o });
const natural = (id, nombres, apellidos, dui, o = {}) => ({ id, tipo: 'natural', nombres, apellidos, dui, createdBy: 'V2', ...o });

const DATA = [
  juridica('C1', 'Delta S.A. de C.V.', '0614-123456-123-4'),
  juridica('C2', 'Delta Industrial', '06141234561234'),                  // same NIT, other format and name
  natural('C3', 'Maria', 'Lopez', '01234567-8'),
  natural('C4', 'Maria Elena', 'Lopez', '012345678'),                     // same DUI
  juridica('C5', 'Omega Aceros', '06140000000001'),
  juridica('C6', 'Omega Aceros S.A.', '06140000000002'),                  // same name, different NIT -> review only
  juridica('C7', 'Sin Documento Uno', ''),
  juridica('C8', 'Cliente Malformado', '123'),
  juridica('C9', 'Empresa Con Rep', '06149999999999', { dui_rep: '012345678', nit_rep: '06141234561234' }), // rep documents are not keys
  { id: 'C10', tipo: 'juridica', empresa: 'Dos Docs', contacto: 'x', telefono: '1' }
];

describe('analyze', () => {
  const r = analyze(DATA);
  test('exact groups: same NIT (any format) and same DUI of a natural person', () => {
    expect(r.exactGroups).toHaveLength(2);
    const nit = r.exactGroups.find(g => g.kind === 'NIT');
    const dui = r.exactGroups.find(g => g.kind === 'DUI');
    expect(nit.clients.map(c => c.id).sort()).toEqual(['C1', 'C2']);
    expect(dui.clients.map(c => c.id).sort()).toEqual(['C3', 'C4']);
  });
  test('company representative documents never create an exact group', () => {
    expect(r.exactGroups.some(g => g.clients.some(c => c.id === 'C9'))).toBe(false);
  });
  test('same name with different documents is a review pair, not an exact group', () => {
    expect(r.reviewPairs.some(p => [p.a.id, p.b.id].sort().join() === 'C5,C6')).toBe(true);
    expect(r.exactGroups.some(g => g.clients.some(c => c.id === 'C5'))).toBe(false);
  });
  test('counts: documents absent / malformed are reported, not treated as duplicates', () => {
    expect(r.total).toBe(10);
    expect(r.withoutDocument).toBeGreaterThanOrEqual(3); // C7, C8 (malformed), C10
    expect(r.malformedDocument).toBeGreaterThanOrEqual(1);
  });
});

describe('report', () => {
  const md = toMarkdown(analyze(DATA));
  test('is masked: no full document, phone or e-mail appears', () => {
    expect(md).not.toMatch(/06141234561234|012345678|0614-123456|7000-9999|dato\.privado/);
    expect(md).toMatch(/NIT ····1234/);
  });
  test('states that it fixes nothing', () => {
    expect(md).toMatch(/no corrige nada/i);
  });
  test('the script contains no write operation', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'detectDuplicateClients.js'), 'utf8');
    // no Firestore write API (Map/Set .set/.add are fine); the only file written is the optional local --out report
    expect(src).not.toMatch(/\.doc\(|\.batch\(|runTransaction|\.update\(|\.delete\(|\.create\(|FieldValue/);
  });
});
