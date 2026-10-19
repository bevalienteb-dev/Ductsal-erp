// functions/__tests__/clientIdentity.test.js
// Pure normalisation / matching rules for NIT and DUI duplicate prevention.
const ci = require('../clientIdentity');

const nat = (o = {}) => ({ tipo: 'natural', nombres: 'Ana', apellidos: 'Gómez', ...o });
const jur = (o = {}) => ({ tipo: 'juridica', empresa: 'Acme', contacto: 'Luis', ...o });

describe('normalizeDui', () => {
  test.each([
    ['01234567-8', '012345678', 'ok'],
    ['012345678', '012345678', 'ok'],
    [' 0123 4567 - 8 ', '012345678', 'ok'],
    ['01234567–8', '012345678', 'ok'],        // en dash typed by a phone keyboard
    ['1234567-8', '012345678', 'padded'],      // spreadsheet dropped the leading zero
  ])('%j -> %s (%s)', (raw, digits, status) => {
    const r = ci.normalizeDui(raw);
    expect(r.digits).toBe(digits);
    expect(r.status).toBe(status);
    expect(r.key).toBe('DUI_' + digits);
  });
  test.each([[''], [null], [undefined], ['   '], ['--']])('empty %j gives no key and is not an error', raw => {
    expect(ci.normalizeDui(raw)).toEqual({ status: 'empty', digits: '', key: null });
  });
  test.each([['12345'], ['1234567890'], ['abc']])('unrecognisable %j gives no key', raw => {
    const r = ci.normalizeDui(raw);
    expect(r.key).toBeNull();
    expect(['invalid', 'empty']).toContain(r.status);
  });
});

describe('normalizeNit', () => {
  test('same NIT in different formats gives the same key', () => {
    const k = ci.normalizeNit('0614-050505-101-3').key;
    expect(k).toBe('NIT_06140505051013');
    expect(ci.normalizeNit('06140505051013').key).toBe(k);
    expect(ci.normalizeNit(' 0614 050505 101 3 ').key).toBe(k);
    expect(ci.normalizeNit('0614.050505.101.3').key).toBe(k);
  });
  test('13 digits (lost leading zero) is padded; 9 digits (natural person NIT = DUI number) is accepted', () => {
    expect(ci.normalizeNit('614050505101-3')).toMatchObject({ status: 'padded', key: 'NIT_06140505051013' });
    expect(ci.normalizeNit('012345678')).toMatchObject({ status: 'ok', key: 'NIT_012345678' });
  });
  test('empty and invalid', () => {
    expect(ci.normalizeNit('').status).toBe('empty');
    expect(ci.normalizeNit('1234').key).toBeNull();
    expect(ci.normalizeNit('1234').status).toBe('invalid');
  });
});

describe('identity documents depend on the client type', () => {
  test('natural: DUI and NIT are both keys, in different namespaces', () => {
    expect(ci.keysOf(nat({ dui: '01234567-8', nit: '0614-050505-101-3' })).sort()).toEqual(['DUI_012345678', 'NIT_06140505051013']);
  });
  test('juridica: only the company NIT; the legal representative documents are NOT identity', () => {
    const k = ci.keysOf(jur({ nit: '0614-050505-101-3', dui_rep: '01234567-8', nit_rep: '0101-010101-101-1', dui: '99999999-9' }));
    expect(k).toEqual(['NIT_06140505051013']);
  });
  test('absent documents give no keys (they are optional)', () => {
    expect(ci.keysOf(nat())).toEqual([]);
    expect(ci.keysOf(jur({ nit: '' }))).toEqual([]);
  });
  test('malformed documents are reported as warnings, never as errors', () => {
    expect(ci.formatWarnings(nat({ dui: '123', nit: '55' }))).toHaveLength(2);
    expect(ci.formatWarnings(nat({ dui: '01234567-8' }))).toEqual([]);
  });
});

describe('names', () => {
  test('accents, case, punctuation and legal suffixes are ignored for companies', () => {
    const a = ci.nameTokens(jur({ empresa: 'Corporación Ñandú, S.A. de C.V.' }));
    const b = ci.nameTokens(jur({ empresa: 'CORPORACION NANDU SA DE CV' }));
    expect(ci.compareNames(a, b)).toBe('same');
  });
  test('same people with a middle/second surname are similar, not equal', () => {
    expect(ci.compareNames(ci.nameTokens(nat({ nombres: 'José', apellidos: 'Pérez' })), ci.nameTokens(nat({ nombres: 'Jose', apellidos: 'Perez López' })))).toBe('similar');
  });
  test('a shared surname alone is not a match', () => {
    expect(ci.compareNames(ci.nameTokens(nat({ nombres: 'Juan', apellidos: 'López' })), ci.nameTokens(nat({ nombres: 'Luis', apellidos: 'López' })))).toBeNull();
  });
  test('a single shared word between longer names is not a match', () => {
    expect(ci.compareNames(ci.nameTokens(jur({ empresa: 'Industrias Acme' })), ci.nameTokens(jur({ empresa: 'Acme Logistica Regional' })))).toBeNull();
  });
});

describe('matchClients', () => {
  test('NIT equal in a different format is an exact match', () => {
    const m = ci.matchClients(jur({ empresa: 'Otra', nit: '0614050505-101-3' }), jur({ nit: '0614-050505-101-3' }));
    expect(m).toEqual({ level: 'exact', reasons: ['nit'] });
  });
  test('DUI equal in a different format is an exact match (natural clients)', () => {
    const m = ci.matchClients(nat({ nombres: 'Pedro', apellidos: 'Cruz', dui: '012345678' }), nat({ dui: '01234567-8' }));
    expect(m.level).toBe('exact');
    expect(m.reasons).toContain('dui');
  });
  test('different documents with the same name only need review (never blocked)', () => {
    const m = ci.matchClients(nat({ dui: '11111111-1' }), nat({ dui: '22222222-2' }));
    expect(m.level).toBe('review');
    expect(m.reasons).toEqual(['nombre-igual']);
  });
  test('missing documents on both sides: only the name can match', () => {
    expect(ci.matchClients(nat(), nat()).level).toBe('review');
    expect(ci.matchClients(nat(), nat({ nombres: 'Zoe', apellidos: 'Ruiz' }))).toBeNull();
  });
  test('the same representative (dui_rep / nit_rep) in two companies is NOT a duplicate', () => {
    const a = jur({ empresa: 'Alfa', contacto: 'X', dui_rep: '01234567-8', nit_rep: '0101-010101-101-1' });
    const b = jur({ empresa: 'Beta', contacto: 'Y', dui_rep: '01234567-8', nit_rep: '0101-010101-101-1' });
    expect(ci.matchClients(a, b)).toBeNull();
  });
  test('NIT and DUI are not interchangeable: same digits across them is only a review hint', () => {
    const m = ci.matchClients(nat({ nombres: 'Rosa', apellidos: 'Mena', nit: '012345678' }), nat({ nombres: 'Carlos', apellidos: 'Díaz', dui: '01234567-8' }));
    expect(m.level).toBe('review');
    expect(m.reasons).toEqual(['nit-igual-a-dui-de-otro']);
  });
  test('a company never matches another client by DUI field', () => {
    expect(ci.matchClients(jur({ empresa: 'Solo', dui: '01234567-8' }), nat({ nombres: 'Marta', apellidos: 'Lara', dui: '01234567-8' }))).toBeNull();
  });
  test('phone / e-mail in common is only informative', () => {
    const m = ci.matchClients(nat({ nombres: 'Uno', apellidos: 'Dos', telefono: '+503 7000-1234' }), nat({ nombres: 'Tres', apellidos: 'Cuatro', telefono: '70001234' }));
    expect(m).toEqual({ level: 'info', reasons: ['telefono'] });
  });
  test('findMatches orders exact before review before info and ignores the edited client', () => {
    const cand = nat({ dui: '012345678', telefono: '70001234' });
    const list = [
      { id: 'A', ...nat({ nombres: 'X', apellidos: 'Y', telefono: '7000-1234' }) },
      { id: 'B', ...nat({ dui: '01234567-8' }) },
      { id: 'C', ...nat({ dui: '55555555-5' }) },
      { id: 'SELF', ...nat({ dui: '01234567-8' }) }
    ];
    const out = ci.findMatches(cand, list, 'SELF');
    expect(out.map(o => o.clientId)).toEqual(['B', 'C', 'A']);
    expect(out.map(o => o.level)).toEqual(['exact', 'review', 'info']);
  });
});

describe('masking', () => {
  test('hints never reveal a full document', () => {
    expect(ci.identifierHint(nat({ dui: '01234567-8' }))).toBe('DUI ····5678');
    expect(ci.identifierHint(jur({ nit: '0614-050505-101-3' }))).toBe('NIT ····1013');
    expect(ci.identifierHint(nat())).toBe('');
  });
});
