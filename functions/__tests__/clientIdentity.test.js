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
    expect(ci.identifierHint(jur({ nrc: '123456-7' }))).toBe('NRC ····4567');
    expect(ci.identifierHint(nat())).toBe('');
  });
});

// ============================================================================
// FASE 2 — BLOQUE B4.2: PREVENCIÓN DE CUENTAS DUPLICADAS (18 ESCENARIOS OBLIGATORIOS)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClientsService } = require('../clientsService');
const { createFakeFirestore, SERVER_TS } = require('../test-helpers/fakeFirestore');
const CrmClients = require('../../crm_clients.js');
const ClientsController = require('../../modules/clients/clients_controller.js');
const ClientsUI = require('../../modules/clients/clients_ui.js');

function buildB42Harness() {
  const db = createFakeFirestore();
  let idSeq = 0;
  let opSeq = 0;
  const rawSvc = createClientsService({
    db,
    FieldValue: { serverTimestamp: () => SERVER_TS },
    suffix: '_prod',
    now: () => new Date('2026-03-15T12:00:00.000Z'),
    newId: () => `C_B42_${++idSeq}`
  });
  const nextOpId = () => `op_b42_${String(++opSeq).padStart(6, '0')}`;
  const svc = {
    create: (caller, opts = {}) => rawSvc.create({ caller, opId: opts.opId || nextOpId(), ...opts }),
    reserveCreation: (caller, opts = {}) => rawSvc.reserveCreation({ caller, ...opts }),
    finalizeCreation: (caller, opts = {}) => rawSvc.finalizeCreation({ caller, opId: opts.opId || nextOpId(), ...opts }),
    cancelReservation: (caller, opts = {}) => rawSvc.cancelReservation({ caller, ...opts }),
    update: (caller, opts = {}) => rawSvc.update({ caller, ...opts }),
    search: (caller, opts = {}) => rawSvc.search({ caller, ...opts })
  };
  const seller1 = { uid: 'uid-v1', cid: 'vendedor_1', id: 'vendedor_1', name: 'Vendedor Uno', role: 'vendedor' };
  const seller2 = { uid: 'uid-v2', cid: 'vendedor_2', id: 'vendedor_2', name: 'Vendedor Dos', role: 'vendedor' };
  const manager = { uid: 'uid-mgr', cid: 'manager_1', id: 'manager_1', name: 'Gerente General', role: 'manager' };
  return { db, svc, rawSvc, seller1, seller2, manager };
}

describe('Fase 2 B4.2 — Prevención de cuentas duplicadas (18 escenarios obligatorios)', () => {
  test('Escenario 1: Creación bloqueada por NIT idéntico', async () => {
    const { svc, seller1 } = buildB42Harness();
    const first = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Constructora Uno S.A. de C.V.', contacto: 'Carlos', telefono: '2200-1111', nit: '0614-010190-101-1' },
      dbSuffix: '_prod'
    });
    expect(first.status).toBe('created');

    const dup = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Inversiones Distintas S.A.', contacto: 'Mario', telefono: '2200-2222', nit: '0614-010190-101-1' },
      dbSuffix: '_prod'
    });
    expect(dup.status).toBe('duplicate');
    expect(dup.matches).toHaveLength(1);
    expect(dup.matches[0].clientId).toBe(first.client.id);
    expect(dup.matches[0].reasons).toContain('nit');
  });

  test('Escenario 2: Creación bloqueada por NIT con distinto formato (guiones, espacios, sin separadores)', async () => {
    const { svc, seller1 } = buildB42Harness();
    const first = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Alfa Ingenieros S.A.', contacto: 'Ana', telefono: '2211-0000', nit: '0614-010190-101-1' },
      dbSuffix: '_prod'
    });
    expect(first.status).toBe('created');

    const dupNoHyphens = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Beta Comercial S.A.', contacto: 'Luis', telefono: '2211-9999', nit: '  06140101901011  ' },
      dbSuffix: '_prod'
    });
    expect(dupNoHyphens.status).toBe('duplicate');
    expect(dupNoHyphens.matches[0].clientId).toBe(first.client.id);
    expect(dupNoHyphens.matches[0].reasons).toContain('nit');
  });

  test('Escenario 3: Creación bloqueada por NRC idéntico', async () => {
    const { svc, seller1 } = buildB42Harness();
    const first = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Distribuidora Cuscatlán S.A.', contacto: 'Pedro', telefono: '2233-4444', nrc: '123456-7' },
      dbSuffix: '_prod'
    });
    expect(first.status).toBe('created');

    const dup = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Importadora Salvadoreña S.A.', contacto: 'Elena', telefono: '2233-5555', nrc: '123456-7' },
      dbSuffix: '_prod'
    });
    expect(dup.status).toBe('duplicate');
    expect(dup.matches).toHaveLength(1);
    expect(dup.matches[0].clientId).toBe(first.client.id);
    expect(dup.matches[0].reasons).toContain('nrc');
  });

  test('Escenario 4: Creación bloqueada por NRC con distinto formato y preservación de ceros significativos', async () => {
    const { svc, seller1 } = buildB42Harness();
    const first = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Servicios Industriales S.A.', contacto: 'Raúl', telefono: '2244-1111', nrc: '001234-5' },
      dbSuffix: '_prod'
    });
    expect(first.status).toBe('created');

    // Same NRC without hyphen or with spaces -> blocked
    const dupFormat = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Otra Sociedad S.A.', contacto: 'Sofía', telefono: '2244-2222', nrc: ' 0012345 ' },
      dbSuffix: '_prod'
    });
    expect(dupFormat.status).toBe('duplicate');
    expect(dupFormat.matches[0].clientId).toBe(first.client.id);
    expect(dupFormat.matches[0].reasons).toContain('nrc');

    // NRC with different leading zeros ('1234-5' vs '001234-5') preserves significant zeros
    expect(ci.normalizeNrc('001234-5').key).toBe('NRC_0012345');
    expect(ci.normalizeNrc('1234-5').key).toBe('NRC_12345');
    expect(ci.normalizeNrc('001234-5').key).not.toBe(ci.normalizeNrc('1234-5').key);
  });

  test('Escenario 5: Creación simultánea (concurrencia) de dos cuentas con el mismo NIT: solo una se crea', async () => {
    const { db, svc, seller1, seller2 } = buildB42Harness();
    const [res1, res2] = await Promise.all([
      svc.create(seller1, {
        client: { tipo: 'juridica', empresa: 'Concurrente NIT Uno S.A.', contacto: 'A', telefono: '7000-0001', nit: '0614-150515-102-9' },
        dbSuffix: '_prod'
      }),
      svc.create(seller2, {
        client: { tipo: 'juridica', empresa: 'Concurrente NIT Dos S.A.', contacto: 'B', telefono: '7000-0002', nit: '06141505151029' },
        dbSuffix: '_prod'
      })
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['created', 'duplicate']);
    const allClients = db.list('clients_prod');
    expect(allClients).toHaveLength(1);
    const idDoc = db.data('clientIdentifiers_prod/NIT_06141505151029');
    expect(idDoc.clientId).toBe(allClients[0].id);
  });

  test('Escenario 6: Creación simultánea (concurrencia) de dos cuentas con el mismo NRC: solo una se crea', async () => {
    const { db, svc, seller1, seller2 } = buildB42Harness();
    const [res1, res2] = await Promise.all([
      svc.create(seller1, {
        client: { tipo: 'juridica', empresa: 'Concurrente NRC Uno S.A.', contacto: 'A', telefono: '7000-0003', nrc: '987654-3' },
        dbSuffix: '_prod'
      }),
      svc.create(seller2, {
        client: { tipo: 'juridica', empresa: 'Concurrente NRC Dos S.A.', contacto: 'B', telefono: '7000-0004', nrc: '9876543' },
        dbSuffix: '_prod'
      })
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['created', 'duplicate']);
    const allClients = db.list('clients_prod');
    expect(allClients).toHaveLength(1);
    const idDoc = db.data('clientIdentifiers_prod/NRC_9876543');
    expect(idDoc.clientId).toBe(allClients[0].id);
  });

  test('Escenario 7: Coincidencia de NIT o NRC con cuenta absorbida (fusionada_en) se resuelve hacia la cuenta activa canónica y bloquea creación', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    // Seed absorbed account C_ABSORBED -> C_CANONICAL
    db.seed('clients_prod/C_ABSORBED', {
      tipo: 'juridica',
      empresa: 'Ferretería Antiguo Nombre S.A.',
      contacto: 'Histórico',
      telefono: '2200-0000',
      nit: '0614-200200-105-8',
      nrc: '554433-2',
      createdBy: seller1.id,
      visibleTo: [seller1.id],
      fusionada_en: 'C_CANONICAL'
    });
    db.seed('clients_prod/C_CANONICAL', {
      tipo: 'juridica',
      empresa: 'Grupo Ferretero Canónico S.A. de C.V.',
      contacto: 'Vigente',
      telefono: '2200-9999',
      nit: '0614-999999-101-0',
      nrc: '998877-6',
      createdBy: seller1.id,
      visibleTo: [seller1.id]
    });

    const attemptByAbsorbedNit = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Nueva Razón Social S.A.', contacto: 'Juan', telefono: '7111-2222', nit: '0614-200200-105-8' },
      dbSuffix: '_prod'
    });
    expect(attemptByAbsorbedNit.status).toBe('duplicate');
    expect(attemptByAbsorbedNit.matches).toHaveLength(1);
    expect(attemptByAbsorbedNit.matches[0].clientId).toBe('C_CANONICAL');
    expect(attemptByAbsorbedNit.matches[0].absorbedFrom).toBe('C_ABSORBED');
    expect(attemptByAbsorbedNit.matches[0].nombre).toBe('Grupo Ferretero Canónico S.A. de C.V.');
    expect(attemptByAbsorbedNit.matches[0].reasons).toContain('nit');

    const attemptByAbsorbedNrc = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Otra Razón Social S.A.', contacto: 'Juan', telefono: '7111-3333', nrc: '5544332' },
      dbSuffix: '_prod'
    });
    expect(attemptByAbsorbedNrc.status).toBe('duplicate');
    expect(attemptByAbsorbedNrc.matches[0].clientId).toBe('C_CANONICAL');
    expect(attemptByAbsorbedNrc.matches[0].absorbedFrom).toBe('C_ABSORBED');
    expect(attemptByAbsorbedNrc.matches[0].reasons).toContain('nrc');
  });

  test('Escenario 8: Edición de cuenta sin cambiar su propio NIT o NRC no se bloquea a sí misma (ni por sus cuentas absorbidas)', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    const created = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Acero Estructural S.A.', contacto: 'Ing. Ruiz', telefono: '2255-1000', nit: '0614-101010-101-5', nrc: '112233-4' },
      dbSuffix: '_prod'
    });
    expect(created.status).toBe('created');

    // Also seed an absorbed account that had the same NIT/NRC pointing to created.client.id
    db.seed('clients_prod/C_OLD_MERGED', {
      tipo: 'juridica',
      empresa: 'Acero Estructural Histórico',
      contacto: 'Ing. Ruiz',
      telefono: '2255-0999',
      nit: '0614-101010-101-5',
      nrc: '112233-4',
      createdBy: seller1.id,
      visibleTo: [seller1.id],
      fusionada_en: created.client.id
    });

    const updated = await svc.update(seller1, {
      id: created.client.id,
      client: {
        tipo: 'juridica',
        empresa: 'Acero Estructural S.A.',
        contacto: 'Ing. Roberto Ruiz (Actualizado)',
        telefono: '2255-2000',
        nit: '0614-101010-101-5',
        nrc: '112233-4'
      },
      dbSuffix: '_prod'
    });
    expect(updated.status).toBe('updated');
    expect(updated.client.contacto).toBe('Ing. Roberto Ruiz (Actualizado)');
  });

  test('Escenario 9: Edición de cuenta intentando usar NIT o NRC de otra cuenta queda bloqueada', async () => {
    const { svc, seller1 } = buildB42Harness();
    const c1 = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Cuenta Alfa S.A.', contacto: 'Uno', telefono: '2200-0001', nit: '0614-111111-101-1', nrc: '100001-1' },
      dbSuffix: '_prod'
    });
    const c2 = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Cuenta Beta S.A.', contacto: 'Dos', telefono: '2200-0002', nit: '0614-222222-102-2', nrc: '200002-2' },
      dbSuffix: '_prod'
    });

    // Try changing c2's NIT to c1's NIT
    const dupNit = await svc.update(seller1, {
      id: c2.client.id,
      client: { tipo: 'juridica', empresa: 'Cuenta Beta S.A.', contacto: 'Dos', telefono: '2200-0002', nit: '06141111111011', nrc: '200002-2' },
      dbSuffix: '_prod'
    });
    expect(dupNit.status).toBe('duplicate');
    expect(dupNit.matches[0].clientId).toBe(c1.client.id);
    expect(dupNit.matches[0].reasons).toContain('nit');

    // Try changing c2's NRC to c1's NRC
    const dupNrc = await svc.update(seller1, {
      id: c2.client.id,
      client: { tipo: 'juridica', empresa: 'Cuenta Beta S.A.', contacto: 'Dos', telefono: '2200-0002', nit: '0614-222222-102-2', nrc: '1000011' },
      dbSuffix: '_prod'
    });
    expect(dupNrc.status).toBe('duplicate');
    expect(dupNrc.matches[0].clientId).toBe(c1.client.id);
    expect(dupNrc.matches[0].reasons).toContain('nrc');
  });

  test('Escenario 10: Creación con nombre idéntico muestra advertencia (needs-review con nombre-igual)', async () => {
    const { svc, seller1 } = buildB42Harness();
    await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Montajes Electromecánicos del Pacífico', contacto: 'Ana', telefono: '2266-1111', nit: '0614-010180-101-1' },
      dbSuffix: '_prod'
    });

    const res = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Montajes Electromecánicos del Pacífico', contacto: 'Luis', telefono: '2266-2222', nit: '0614-020290-102-2' },
      dbSuffix: '_prod'
    });
    expect(res.status).toBe('needs-review');
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].reasons).toContain('nombre-igual');
  });

  test('Escenario 11: Creación con nombre equivalente sin sufijo societario ("Constructora Alfa, S.A. de C.V." vs "CONSTRUCTORA ALFA") muestra advertencia', async () => {
    const { svc, seller1 } = buildB42Harness();
    await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Constructora Alfa, S.A. de C.V.', contacto: 'Carlos', telefono: '2277-1111', nit: '0614-030385-101-3' },
      dbSuffix: '_prod'
    });

    const res = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: '  CONSTRUCTORA   ALFA ', contacto: 'Pedro', telefono: '2277-2222', nit: '0614-040495-102-4' },
      dbSuffix: '_prod'
    });
    expect(res.status).toBe('needs-review');
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].reasons).toContain('nombre-igual');
  });

  test('Escenario 12: Creación con nombre similar ("Constructora Alfa" vs "Constructoras Alfa" o tildes/puntuación) muestra advertencia', async () => {
    const { svc, seller1 } = buildB42Harness();
    await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Constructora Alfa, S.A. de C.V.', contacto: 'Carlos', telefono: '2277-1111', nit: '0614-030385-101-3' },
      dbSuffix: '_prod'
    });

    const resPlural = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Constructoras Alfa S.A.', contacto: 'Pedro', telefono: '2277-3333', nit: '0614-050595-103-5' },
      dbSuffix: '_prod'
    });
    expect(resPlural.status).toBe('needs-review');
    expect(resPlural.matches).toHaveLength(1);
    expect(['nombre-igual', 'nombre-parecido']).toContain(resPlural.matches[0].reasons[0]);
  });

  test('Escenario 13: Si el vendedor cancela o decide usar la cuenta existente, no se crea nueva cuenta ni quedan reservas huérfanas', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    const existing = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Desarrollos Metálicos S.A. de C.V.', contacto: 'Marta', telefono: '2288-1111', nit: '0614-070780-101-7' },
      dbSuffix: '_prod'
    });

    // Reserve creation triggers needs-review without creating reservation or client
    const attempt = await svc.reserveCreation(seller1, {
      client: { tipo: 'juridica', empresa: 'Desarrollos Metalicos', contacto: 'Jorge', telefono: '2288-2222', nit: '0614-080890-102-8' },
      dbSuffix: '_prod',
      confirmReview: false
    });
    expect(attempt.status).toBe('needs-review');
    expect(attempt.matches[0].clientId).toBe(existing.client.id);

    // Seller declines / uses existing account -> no second client and no reservation created
    expect(db.list('clients_prod')).toHaveLength(1);
    expect(db.list('clientReservations_prod')).toHaveLength(0);
    expect(db.data('clientIdentifiers_prod/NIT_06140808901028')).toBeUndefined();
  });

  test('Escenario 14: Si el vendedor confirma continuar por similitud y no hay duplicado fiscal, la cuenta se crea y registra auditoría en commercialAudit', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    const existing = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Grupo Industrial Maya S.A. de C.V.', contacto: 'Ana', telefono: '2299-1111', nit: '0614-090980-101-9' },
      dbSuffix: '_prod'
    });

    const justification = 'Filial independiente con razón social, NIT y giro propio verificados.';
    const confirmed = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Grupo Industrial Maya División Sur', contacto: 'Mario', telefono: '2299-2222', nit: '0614-101090-102-0' },
      dbSuffix: '_prod',
      confirmReview: true,
      reviewJustification: justification
    });

    expect(confirmed.status).toBe('created');
    expect(confirmed.client.id).toBeDefined();
    expect(db.list('clients_prod')).toHaveLength(2);

    // Check commercialAudit_prod entry
    const audits = db.list('commercialAudit_prod').filter(a => a.action === 'clientSimilarityConfirmed');
    expect(audits).toHaveLength(1);
    const entry = audits[0];
    expect(entry.actorUid).toBe(seller1.uid);
    expect(entry.actorCid).toBe(seller1.cid);
    expect(entry.actorRole).toBe('vendedor');
    expect(entry.targetId).toBe(confirmed.client.id);
    expect(entry.detail.createdClientId).toBe(confirmed.client.id);
    expect(entry.detail.justification).toBe(justification);
    expect(entry.at).toBeDefined();
    expect(entry.detail.matches).toEqual([
      expect.objectContaining({
        clientId: existing.client.id,
        inPortfolio: true
      })
    ]);
  });

  test('Escenario 15: Intento de forzar creación pese a NIT o NRC duplicado sigue bloqueado con confirmReview=true y registra rechazo en commercialAudit', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    const existing = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Cemento Nacional S.A.', contacto: 'Roberto', telefono: '2210-1000', nit: '0614-121280-101-4', nrc: '776655-4' },
      dbSuffix: '_prod'
    });

    const forcedNit = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Nombre Totalmente Diferente S.A.', contacto: 'Otro', telefono: '2210-2000', nit: '0614-121280-101-4' },
      dbSuffix: '_prod',
      confirmReview: true,
      reviewJustification: 'Intento forzar aunque tenga el mismo NIT'
    });
    expect(forcedNit.status).toBe('duplicate');

    const forcedNrc = await svc.reserveCreation(seller1, {
      client: { tipo: 'juridica', empresa: 'Otra Empresa Diferente S.A.', contacto: 'Otro', telefono: '2210-3000', nrc: '7766554' },
      dbSuffix: '_prod',
      confirmReview: true,
      reviewJustification: 'Intento forzar aunque tenga el mismo NRC'
    });
    expect(forcedNrc.status).toBe('duplicate');
    expect(db.list('clients_prod')).toHaveLength(1);

    // Verify rejection audit entries without exposing full NIT/NRC
    const rejectedAudits = db.list('commercialAudit_prod').filter(a => a.action === 'clientDuplicateRejected');
    expect(rejectedAudits.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(rejectedAudits);
    expect(serialized).not.toContain('06141212801014');
    expect(serialized).not.toContain('0614-121280-101-4');
    expect(serialized).not.toContain('7766554');
    expect(rejectedAudits[0].detail.matches[0].clientId).toBe(existing.client.id);
  });

  test('Escenario 16 y 17: Autorización de visibilidad en coincidencias (inPortfolio=true muestra datos y permite abrir; inPortfolio=false oculta datos sensibles e indica consultar al gerente)', async () => {
    const { svc, seller1, seller2 } = buildB42Harness();
    // Seller 1 creates an account in Seller 1's portfolio
    const s1Account = await svc.create(seller1, {
      client: {
        tipo: 'juridica',
        empresa: 'Corporación Confidencial del Norte S.A. de C.V.',
        contacto: 'Director Privado',
        telefono: '2290-9999',
        correo: 'privado@confidencial.com',
        nit: '0614-300390-103-7',
        nrc: '334455-6'
      },
      dbSuffix: '_prod'
    });
    expect(s1Account.status).toBe('created');

    // Scenario 16: Seller 1 (authorized) hits duplicate -> sees nombre, hint, clientId, inPortfolio=true
    const ownMatch = await svc.create(seller1, {
      client: { tipo: 'juridica', empresa: 'Otra', contacto: 'X', telefono: '7000-1111', nit: '0614-300390-103-7' },
      dbSuffix: '_prod'
    });
    expect(ownMatch.status).toBe('duplicate');
    expect(ownMatch.matches[0]).toEqual(expect.objectContaining({
      clientId: s1Account.client.id,
      inPortfolio: true,
      nombre: 'Corporación Confidencial del Norte S.A. de C.V.',
      hint: 'NIT ····1037'
    }));

    // Scenario 17: Seller 2 (unauthorized) hits duplicate by NIT or similarity by name -> no sensitive data exposed!
    const foreignNitMatch = await svc.create(seller2, {
      client: { tipo: 'juridica', empresa: 'Intento Vendedor 2', contacto: 'Y', telefono: '7000-2222', nit: '0614-300390-103-7' },
      dbSuffix: '_prod'
    });
    expect(foreignNitMatch.status).toBe('duplicate');
    expect(foreignNitMatch.matches[0].inPortfolio).toBe(false);
    expect(foreignNitMatch.matches[0].restricted).toBe(true);
    expect(foreignNitMatch.matches[0].nombre).toBeNull();
    expect(foreignNitMatch.matches[0].hint).toBeNull();
    expect(foreignNitMatch.matches[0].tipo).toBe('');
    expect(JSON.stringify(foreignNitMatch)).not.toContain('Corporación Confidencial');
    expect(JSON.stringify(foreignNitMatch)).not.toContain('1037');
    expect(JSON.stringify(foreignNitMatch)).not.toContain('privado@confidencial.com');

    // Check CrmClients.duplicateMessage and contextual UI rendering for unauthorized vs authorized match
    const restrictedMsg = CrmClients.duplicateMessage(foreignNitMatch);
    expect(restrictedMsg).toContain('fuera de tu cartera comercial');
    expect(restrictedMsg).toContain('consulta al gerente');
    expect(restrictedMsg).not.toContain('Corporación Confidencial');

    // Verify contextual DOM panel rendering via ClientsUI.renderClientDuplicateFeedback
    const fakePanel = { style: {}, innerHTML: '', dataset: { b42Contextual: 'true' } };
    const prevDoc = global.document;
    global.document = {
      getElementById: (id) => (id === 'client-duplicate-feedback-panel' ? fakePanel : null)
    };
    try {
      ClientsUI.renderClientDuplicateFeedback('duplicate', ownMatch, { tipo: 'juridica' });
      expect(fakePanel.innerHTML).toContain('Corporación Confidencial del Norte S.A. de C.V.');
      expect(fakePanel.innerHTML).toContain('Ver / Usar cuenta existente');
      expect(fakePanel.innerHTML).toContain(s1Account.client.id);

      ClientsUI.renderClientDuplicateFeedback('duplicate', foreignNitMatch, { tipo: 'juridica' });
      expect(fakePanel.innerHTML).toContain('fuera de tu cartera comercial');
      expect(fakePanel.innerHTML).toContain('Consulta al gerente comercial');
      expect(fakePanel.innerHTML).not.toContain('Corporación Confidencial');
      expect(fakePanel.innerHTML).not.toContain('Ver / Usar cuenta existente');
    } finally {
      global.document = prevDoc;
    }
  });

  test('Escenario 18: Valores fiscales vacíos, de relleno o compuestos solo de ceros no generan falsos positivos de duplicidad', async () => {
    const { db, svc, seller1 } = buildB42Harness();
    const placeholders = [
      { empresa: 'Empresa Alfa Uno', nit: '', nrc: '' },
      { empresa: 'Empresa Beta Dos', nit: '0000-000000-000-0', nrc: '000000-0' },
      { empresa: 'Empresa Gamma Tres', nit: '00000000000000', nrc: '0000000' },
      { empresa: 'Empresa Delta Cuatro', nit: 'N/A', nrc: 'S/N' },
      { empresa: 'Empresa Épsilon Cinco', nit: 'PENDIENTE', nrc: '--' },
      { empresa: 'Empresa Zeta Seis', nit: 'SIN NIT', nrc: 'NO TIENE' }
    ];

    for (let i = 0; i < placeholders.length; i++) {
      const p = placeholders[i];
      const res = await svc.create(seller1, {
        client: {
          tipo: 'juridica',
          empresa: p.empresa,
          contacto: `Contacto ${i + 1}`,
          telefono: `2200-000${i + 1}`,
          nit: p.nit,
          nrc: p.nrc
        },
        dbSuffix: '_prod'
      });
      expect(res.status).toBe('created');
    }

    expect(db.list('clients_prod')).toHaveLength(placeholders.length);
    // None of the placeholder values should have claimed an identifier lock in clientIdentifiers_prod
    expect(db.list('clientIdentifiers_prod')).toHaveLength(0);
  });

  test('Reserva transaccional (reserveCreation -> finalizeCreation / cancelReservation) reclama y libera identificadores fiscales atómicamente', async () => {
    const { db, svc, seller1, seller2 } = buildB42Harness();
    const res1 = await svc.reserveCreation(seller1, {
      client: { tipo: 'juridica', empresa: 'Reservada Uno S.A.', contacto: 'Carlos', telefono: '2200-1234', nit: '0614-251285-101-7', nrc: '654321-0' },
      dbSuffix: '_prod'
    });
    expect(res1.status).toBe('reserved');
    expect(res1.reservationId).toBeDefined();

    // While reservation is active, another seller trying to reserve or create with the same NIT or NRC is blocked
    const concurrentByNrc = await svc.reserveCreation(seller2, {
      client: { tipo: 'juridica', empresa: 'Intento Concurrente S.A.', contacto: 'Luis', telefono: '2200-5678', nrc: '6543210' },
      dbSuffix: '_prod'
    });
    expect(concurrentByNrc.status).toBe('duplicate');
    expect(concurrentByNrc.matches[0].inPortfolio).toBe(false);

    // Cancel reservation -> releases NIT and NRC locks atomically
    const cancelled = await svc.cancelReservation(seller1, {
      reservationId: res1.reservationId,
      dbSuffix: '_prod'
    });
    expect(cancelled.status).toBe('cancelled');
    expect(db.data('clientIdentifiers_prod/NIT_06142512851017')).toBeUndefined();
    expect(db.data('clientIdentifiers_prod/NRC_6543210')).toBeUndefined();

    // Now seller2 can reserve and finalize cleanly
    const res2 = await svc.reserveCreation(seller2, {
      client: { tipo: 'juridica', empresa: 'Reservada Dos S.A.', contacto: 'Luis', telefono: '2200-5678', nit: '0614-251285-101-7', nrc: '654321-0' },
      dbSuffix: '_prod'
    });
    expect(res2.status).toBe('reserved');

    const finalized = await svc.finalizeCreation(seller2, {
      reservationId: res2.reservationId,
      client: { tipo: 'juridica', empresa: 'Reservada Dos S.A.', contacto: 'Luis', telefono: '2200-5678', nit: '0614-251285-101-7', nrc: '654321-0' },
      dbSuffix: '_prod'
    });
    expect(finalized.status).toBe('created');
    expect(db.data('clientIdentifiers_prod/NRC_6543210').clientId).toBe(res2.reservationId);
  });

  test('Flujo contextual de UI (B4.2-D): advertencia por similitud requiere justificación antes de guardar y permite usar cuenta existente', async () => {
    const els = {};
    const getEl = (id) => {
      if (!els[id]) {
        els[id] = {
          id,
          value: '',
          checked: false,
          style: { display: 'none' },
          dataset: id === 'client-duplicate-feedback-panel' ? { b42Contextual: 'true' } : {},
          innerHTML: '',
          classList: {
            set: new Set(),
            toggle(c, force) { if (force) this.set.add(c); else this.set.delete(c); },
            contains(c) { return this.set.has(c); },
            remove(c) { this.set.delete(c); }
          }
        };
      }
      return els[id];
    };

    const prevDoc = global.document;
    global.document = {
      getElementById: (id) => getEl(id),
      querySelectorAll: () => []
    };

    try {
      const existingClient = {
        id: 'C_EXIST_99',
        tipo: 'juridica',
        empresa: 'Constructora Cuscatlán S.A. de C.V.',
        contacto: 'Ing. Morales',
        telefono: '2211-3344',
        nit: '0614-010190-101-1',
        nrc: '123456-7'
      };
      const calls = [];
      const alerts = [];
      let clientsState = [existingClient];

      const sharedDeps = {
        getCurrentUser: () => ({ id: 'vendedor_1', role: 'vendedor' }),
        getClients: () => clientsState,
        setClients: (next) => { clientsState = next; },
        getProspects: () => [],
        getDbSuffix: () => '_prod',
        alert: (msg) => alerts.push(msg),
        showLoading: () => {},
        hideLoading: () => {},
        closeModal: () => {},
        renderClientExpedienteSection: () => {},
        hasStagedClientFiles: () => false,
        uploadClientStagedFiles: async (id, t, d) => d,
        renderDuplicateFeedback: (kind, resObj, c, editId) => ClientsUI.renderClientDuplicateFeedback(kind, resObj, c, editId),
        persistClientViaServer: (c, editId, opts) => ClientsController.persistClientViaServer(c, editId, opts),
        getCrmClients: () => CrmClients,
        getFirebase: () => ({
          auth: () => ({ currentUser: { uid: 'uid-v1' } }),
          functions: () => ({
            httpsCallable: (name) => async (payload) => {
              calls.push({ name, payload });
              if (name === 'reserveClientCreationAdmin') {
                if (!payload.confirmReview) {
                  return {
                    data: {
                      status: 'needs-review',
                      matches: [{
                        clientId: 'C_EXIST_99',
                        nombre: 'Constructora Cuscatlán S.A. de C.V.',
                        tipo: 'juridica',
                        hint: 'NIT ····1011',
                        reasons: ['nombre-parecido'],
                        inPortfolio: true
                      }]
                    }
                  };
                }
                return { data: { status: 'reserved', reservationId: 'C_NEW_100' } };
              }
              if (name === 'finalizeClientCreationAdmin') {
                return { data: { status: 'created', client: { id: 'C_NEW_100', ...payload.client } } };
              }
              return { data: { status: 'ok' } };
            }
          })
        })
      };
      ClientsController.init(sharedDeps);
      ClientsUI.init(sharedDeps);

      getEl('client-id-edit').value = '';
      getEl('client-tipo').value = 'juridica';
      getEl('jur-empresa').value = 'Constructoras Cuscatlan';
      getEl('jur-contacto').value = 'Arq. Gómez';
      getEl('jur-nit').value = '0614-090999-109-9';
      getEl('jur-nrc').value = '999888-7';
      getEl('cli-telefono').value = '7890-0000';

      // Step 1: Initial save pauses on similarity warning and renders contextual panel
      await ClientsUI.saveClient({ preventDefault: () => {} });
      expect(calls).toHaveLength(1);
      expect(calls[0].payload.confirmReview).toBe(false);
      expect(getEl('client-duplicate-feedback-panel').innerHTML).toContain('Posible cuenta duplicada por similitud de nombre');
      expect(getEl('client-duplicate-feedback-panel').innerHTML).toContain('Constructora Cuscatlán S.A. de C.V.');
      expect(getEl('client-duplicate-feedback-panel').innerHTML).toContain('Revisar / Usar cuenta existente');

      // Step 2: Trying to confirm without justification is blocked in UI
      getEl('b42-review-justification-input').value = '  ';
      await ClientsUI.confirmSimilarityAndSave();
      expect(calls).toHaveLength(1); // No new server call made
      expect(getEl('b42-review-justification-input').classList.contains('input-error')).toBe(true);

      // Step 3: Entering valid justification and confirming saves with confirmReview=true and reviewJustification
      getEl('b42-review-justification-input').value = 'Es una empresa distinta verificada con NIT y escritura propia.';
      await ClientsUI.confirmSimilarityAndSave();
      expect(calls).toHaveLength(3); // reserve (with confirmReview=true) + finalize
      expect(calls[1].name).toBe('reserveClientCreationAdmin');
      expect(calls[1].payload.confirmReview).toBe(true);
      expect(calls[1].payload.reviewJustification).toBe('Es una empresa distinta verificada con NIT y escritura propia.');
      expect(calls[2].name).toBe('finalizeClientCreationAdmin');
      expect(calls[2].payload.confirmReview).toBe(true);
      expect(calls[2].payload.reviewJustification).toBe('Es una empresa distinta verificada con NIT y escritura propia.');

      // Step 4: Using existing account opens existing client in detail view
      ClientsUI.useExistingAccount('C_EXIST_99', 'Constructora Cuscatlán S.A. de C.V.');
      expect(getEl('client-id-edit').value).toBe('C_EXIST_99');
      expect(getEl('jur-empresa').value).toBe('Constructora Cuscatlán S.A. de C.V.');
    } finally {
      global.document = prevDoc;
    }
  });
});

// ============================================================================
// FASE 2 — BLOQUE B4.3: FUSIÓN ADMINISTRATIVA EXCEPCIONAL DE CUENTAS DUPLICADAS
// (26 ESCENARIOS OBLIGATORIOS + FLUJO GERENCIAL DE UI)
// ============================================================================
const { createStorageService } = require('../storageService');
const { createAccountDocumentsService } = require('../accountDocumentsService');

function buildB43Harness(opts = {}) {
  const db = createFakeFirestore();
  let idSeq = 0;
  let opSeq = 0;
  let liveManagerAllowed = opts.liveManagerAllowed !== undefined ? opts.liveManagerAllowed : true;

  const rawSvc = createClientsService({
    db,
    FieldValue: { serverTimestamp: () => SERVER_TS },
    suffix: '_prod',
    verifyManager: async () => liveManagerAllowed,
    now: () => new Date('2026-04-10T15:00:00.000Z'),
    newId: () => `C_B43_${++idSeq}`
  });

  const svc = {
    ...rawSvc,
    create: (caller, args = {}) => rawSvc.create({
      caller,
      client: args.client,
      confirmReview: args.confirmReview,
      reviewJustification: args.reviewJustification,
      opId: args.opId || `op_b43_create_${++opSeq}`
    }),
    update: (caller, args = {}) => rawSvc.update({
      caller,
      id: args.id,
      client: args.client,
      confirmReview: args.confirmReview,
      reviewJustification: args.reviewJustification,
      opId: args.opId || `op_b43_upd_${++opSeq}`
    }),
    search: (caller, args = {}) => rawSvc.search({ caller, q: args.q }),
    previewMerge: (caller, args = {}) => rawSvc.previewMerge({
      caller,
      sourceId: args.sourceId,
      destinationId: args.destinationId
    }),
    mergeAccounts: (caller, args = {}) => rawSvc.mergeAccounts({
      caller,
      sourceId: args.sourceId,
      destinationId: args.destinationId,
      justification: args.justification,
      legalIdentityVerified: args.legalIdentityVerified,
      verificationEvidence: args.verificationEvidence,
      expectedStateHash: args.expectedStateHash,
      sameCorporateGroupOnly: args.sameCorporateGroupOnly,
      opId: args.opId || `op_b43_merge_${++opSeq}`
    }),
    getCanonicalAccountCluster: (caller, args = {}) => rawSvc.getCanonicalAccountCluster({
      caller,
      accountId: args.accountId
    })
  };

  const manager = { uid: 'uid-mgr-1', cid: 'mgr_1', id: 'mgr_1', nombre: 'Gerente General', email: 'gerente@ductsal.test', role: 'manager', activo: true };
  const gestor = { uid: 'uid-gest-1', cid: 'gest_1', id: 'gest_1', nombre: 'Gestor Operativo', email: 'gestor@ductsal.test', role: 'gestor', activo: true };
  const seller1 = { uid: 'uid-v1', cid: 'vendedor_1', id: 'vendedor_1', nombre: 'Vendedor Uno', email: 'v1@ductsal.test', role: 'vendedor', activo: true };
  const seller2 = { uid: 'uid-v2', cid: 'vendedor_2', id: 'vendedor_2', nombre: 'Vendedor Dos', email: 'v2@ductsal.test', role: 'vendedor', activo: true };
  const revokedManager = { uid: 'uid-mgr-rev', cid: 'mgr_rev', id: 'mgr_rev', nombre: 'Gerente Revocado', email: 'rev@ductsal.test', role: 'manager', activo: false, revoked: true };

  db.seed('users_prod/mgr_1', { id: 'mgr_1', authUid: 'uid-mgr-1', nombre: 'Gerente General', role: 'manager', activo: true });
  db.seed('users_prod/gest_1', { id: 'gest_1', authUid: 'uid-gest-1', nombre: 'Gestor Operativo', role: 'gestor', activo: true });
  db.seed('users_prod/vendedor_1', { id: 'vendedor_1', authUid: 'uid-v1', nombre: 'Vendedor Uno', role: 'vendedor', activo: true });
  db.seed('users_prod/vendedor_2', { id: 'vendedor_2', authUid: 'uid-v2', nombre: 'Vendedor Dos', role: 'vendedor', activo: true });
  db.seed('users_prod/mgr_rev', { id: 'mgr_rev', authUid: 'uid-mgr-rev', nombre: 'Gerente Revocado', role: 'manager', activo: false, revoked: true });

  return {
    db,
    svc,
    rawSvc,
    manager,
    gestor,
    seller1,
    seller2,
    revokedManager,
    setLiveManagerAllowed: (v) => { liveManagerAllowed = v; }
  };
}

describe('Fase 2 B4.3 — Fusión administrativa excepcional de cuentas duplicadas (26 escenarios obligatorios)', () => {
  test('Escenario 1: Fusión válida entre cuentas jurídicamente idénticas', async () => {
    const { db, svc, manager, seller1, seller2 } = buildB43Harness();
    db.seed('clients_prod/C_SRC_1', {
      id: 'C_SRC_1',
      tipo: 'juridica',
      empresa: 'Industrias Metálicas del Sur, S.A. de C.V.',
      contacto: 'Ing. Morales',
      telefono: '2211-0001',
      nit: '0614-101090-101-2',
      nrc: '',
      createdBy: seller1.id,
      visibleTo: [seller1.id]
    });
    db.seed('clientIdentifiers_prod/NIT_06141010901012', { clientId: 'C_SRC_1', field: 'nit' });

    db.seed('clients_prod/C_DST_1', {
      id: 'C_DST_1',
      tipo: 'juridica',
      empresa: 'INDUSTRIAS METALICAS DEL SUR SA DE CV',
      contacto: 'Lic. Rivera',
      telefono: '2211-0002',
      nit: '06141010901012',
      nrc: '123456-7',
      createdBy: seller2.id,
      visibleTo: [seller2.id]
    });
    db.seed('clientIdentifiers_prod/NRC_1234567', { clientId: 'C_DST_1', field: 'nrc' });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_SRC_1', destinationId: 'C_DST_1' });
    expect(preview.canMerge).toBe(true);
    expect(preview.identityValidation.sameNit).toBe(true);
    expect(preview.stateHash).toBeDefined();

    const merged = await svc.mergeAccounts(manager, {
      sourceId: 'C_SRC_1',
      destinationId: 'C_DST_1',
      justification: 'Ambas cuentas corresponden a la misma sociedad con idéntico NIT.',
      expectedStateHash: preview.stateHash
    });
    expect(merged.status).toBe('merged');
    expect(merged.canonicalAccountId).toBe('C_DST_1');
    expect(merged.absorbedAccountId).toBe('C_SRC_1');

    const srcAfter = db.data('clients_prod/C_SRC_1');
    expect(srcAfter.fusionada_en).toBe('C_DST_1');
    expect(srcAfter.fusionada_por).toBe('mgr_1');
    expect(srcAfter.fusionada_motivo).toBe('Ambas cuentas corresponden a la misma sociedad con idéntico NIT.');
    expect(srcAfter.estado_cuenta).toBe('fusionada');
  });

  test('Escenario 2: Bloqueo de NIT contradictorios', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_SRC_NIT', {
      id: 'C_SRC_NIT',
      tipo: 'juridica',
      empresa: 'Constructora Salvadoreña S.A. de C.V.',
      nit: '0614-111111-101-1',
      nrc: '555444-3'
    });
    db.seed('clients_prod/C_DST_NIT', {
      id: 'C_DST_NIT',
      tipo: 'juridica',
      empresa: 'Constructora Salvadoreña S.A. de C.V.',
      nit: '0614-222222-102-2',
      nrc: '555444-3'
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_SRC_NIT', destinationId: 'C_DST_NIT' });
    expect(preview.canMerge).toBe(false);
    expect(preview.blockingReasons.join(' ')).toMatch(/contradictoria.*NIT/i);

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_SRC_NIT',
      destinationId: 'C_DST_NIT',
      justification: 'Intento de fusión con NIT contradictorio'
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(db.data('clients_prod/C_SRC_NIT').fusionada_en).toBeUndefined();
  });

  test('Escenario 3: Bloqueo de NRC contradictorios', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_SRC_NRC', {
      id: 'C_SRC_NRC',
      tipo: 'juridica',
      empresa: 'Servicios Técnicos S.A. de C.V.',
      nit: '0614-101090-101-2',
      nrc: '111111-1'
    });
    db.seed('clients_prod/C_DST_NRC', {
      id: 'C_DST_NRC',
      tipo: 'juridica',
      empresa: 'Servicios Técnicos S.A. de C.V.',
      nit: '0614-101090-101-2',
      nrc: '222222-2'
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_SRC_NRC', destinationId: 'C_DST_NRC' });
    expect(preview.canMerge).toBe(false);
    expect(preview.blockingReasons.join(' ')).toMatch(/contradictoria.*NRC/i);

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_SRC_NRC',
      destinationId: 'C_DST_NRC',
      justification: 'Intento de fusión con NRC contradictorio'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('Escenario 4: Cuenta sin identificadores completos, con verificación gerencial documentada', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_INCOMP_SRC', {
      id: 'C_INCOMP_SRC',
      tipo: 'juridica',
      empresa: 'Desarrollos Urbanos El Roble S.A. de C.V.',
      contacto: 'Arq. Castro',
      telefono: '2255-1000',
      nit: '',
      nrc: ''
    });
    db.seed('clients_prod/C_INCOMP_DST', {
      id: 'C_INCOMP_DST',
      tipo: 'juridica',
      empresa: 'DESARROLLOS URBANOS EL ROBLE, S.A. DE C.V.',
      contacto: 'Arq. Castro',
      telefono: '2255-1000',
      nit: '0614-200595-104-5',
      nrc: '777888-9'
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_INCOMP_SRC', destinationId: 'C_INCOMP_DST' });
    expect(preview.canMerge).toBe(true);
    expect(preview.identityValidation.requiresDocumentedVerification).toBe(true);

    // Without legalIdentityVerified + verificationEvidence, execution is rejected
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_INCOMP_SRC',
      destinationId: 'C_INCOMP_DST',
      justification: 'Cuenta creada en etapa temprana sin NIT capturado.',
      legalIdentityVerified: false,
      verificationEvidence: ''
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // With explicit manager verification and documented evidence, merge succeeds
    const res = await svc.mergeAccounts(manager, {
      sourceId: 'C_INCOMP_SRC',
      destinationId: 'C_INCOMP_DST',
      justification: 'Cuenta creada en etapa temprana sin NIT capturado; corresponde a la misma sociedad.',
      legalIdentityVerified: true,
      verificationEvidence: 'Verificado contra Escritura de Constitución #45 y tarjeta NIT 0614-200595-104-5.',
      expectedStateHash: preview.stateHash
    });
    expect(res.status).toBe('merged');
    expect(db.data('clients_prod/C_INCOMP_SRC').fusionada_en).toBe('C_INCOMP_DST');
  });

  test('Escenario 5: Rechazo de identidad no demostrada (nombres distintos sin identidad fiscal o mismo grupo empresarial)', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_UNREL_1', {
      id: 'C_UNREL_1',
      tipo: 'juridica',
      empresa: 'Inversiones Pacífico S.A. de C.V.',
      nit: '',
      nrc: ''
    });
    db.seed('clients_prod/C_UNREL_2', {
      id: 'C_UNREL_2',
      tipo: 'juridica',
      empresa: 'Transportes del Norte S.A. de C.V.',
      nit: '',
      nrc: ''
    });

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_UNREL_1',
      destinationId: 'C_UNREL_2',
      justification: 'Intento sin relación fiscal ni nominal',
      legalIdentityVerified: true,
      verificationEvidence: 'Supuesta relación comercial'
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // Same corporate group rule: two companies of the same corporate group cannot be merged
    db.seed('clients_prod/C_GRP_1', {
      id: 'C_GRP_1',
      tipo: 'juridica',
      empresa: 'Grupo Corporativo Alfa Logística S.A. de C.V.',
      nit: ''
    });
    db.seed('clients_prod/C_GRP_2', {
      id: 'C_GRP_2',
      tipo: 'juridica',
      empresa: 'Grupo Corporativo Alfa Comercial S.A. de C.V.',
      nit: ''
    });

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_GRP_1',
      destinationId: 'C_GRP_2',
      justification: 'Son dos sociedades distintas pero pertenecen al mismo grupo empresarial.',
      legalIdentityVerified: true,
      verificationEvidence: 'Ambas son filiales del mismo grupo empresarial.'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('Escenario 6: Bloqueo de cuentas de tipos jurídicos incompatibles (natural vs juridica)', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_NAT_T', {
      id: 'C_NAT_T',
      tipo: 'natural',
      nombres: 'Roberto',
      apellidos: 'Mendoza',
      nit: '0614-101090-101-2'
    });
    db.seed('clients_prod/C_JUR_T', {
      id: 'C_JUR_T',
      tipo: 'juridica',
      empresa: 'Roberto Mendoza S.A. de C.V.',
      nit: '0614-101090-101-2'
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_NAT_T', destinationId: 'C_JUR_T' });
    expect(preview.canMerge).toBe(false);
    expect(preview.blockingReasons.join(' ')).toMatch(/tipos jurídicos son incompatibles/i);

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_NAT_T',
      destinationId: 'C_JUR_T',
      justification: 'Intento de fusionar persona natural con sociedad anónima'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('Escenario 7: Prohibición de fusionar una cuenta consigo misma', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_SELF', {
      id: 'C_SELF',
      tipo: 'juridica',
      empresa: 'Empresa Única S.A. de C.V.',
      nit: '0614-101090-101-2'
    });

    await expect(svc.previewMerge(manager, {
      sourceId: 'C_SELF',
      destinationId: 'C_SELF'
    })).rejects.toMatchObject({ code: 'invalid-argument' });

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_SELF',
      destinationId: 'C_SELF',
      justification: 'Intento de autofusión'
    })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('Escenario 8: Rechazo de ciclos y cadenas excesivas (> 5 niveles)', async () => {
    const { db, svc, manager } = buildB43Harness();
    // Create chain C_CH_1 -> C_CH_2 -> C_CH_3 -> C_CH_4 -> C_CH_5 -> C_CH_6 (depth 5 reaching C_CH_6)
    for (let i = 1; i <= 7; i++) {
      db.seed(`clients_prod/C_CH_${i}`, {
        id: `C_CH_${i}`,
        tipo: 'juridica',
        empresa: 'Cadena Corporativa S.A. de C.V.',
        nit: '0614-101090-101-2',
        ...(i < 6 ? { fusionada_en: `C_CH_${i + 1}` } : {})
      });
    }

    // Merging C_CH_6 into C_CH_7 would make C_CH_1 -> ... -> C_CH_7 have depth 6 (> MAX_MERGE_DEPTH = 5)
    const previewDepth = await svc.previewMerge(manager, { sourceId: 'C_CH_6', destinationId: 'C_CH_7' });
    expect(previewDepth.canMerge).toBe(false);
    expect(previewDepth.blockingReasons.join(' ')).toMatch(/excediendo el límite máximo permitido/i);

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_CH_6',
      destinationId: 'C_CH_7',
      justification: 'Intento de exceder profundidad 5'
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // Attempting to merge into an already absorbed account (or creating a cycle C_CH_6 -> C_CH_1) is blocked
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_CH_6',
      destinationId: 'C_CH_1',
      justification: 'Intento de crear ciclo'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('Escenario 9: Rechazo de cuentas inexistentes', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_REAL', {
      id: 'C_REAL',
      tipo: 'juridica',
      empresa: 'Cuenta Existente S.A. de C.V.',
      nit: '0614-101090-101-2'
    });

    await expect(svc.previewMerge(manager, {
      sourceId: 'C_GHOST',
      destinationId: 'C_REAL'
    })).rejects.toMatchObject({ code: 'not-found' });

    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_REAL',
      destinationId: 'C_GHOST',
      justification: 'Cuenta destino inexistente'
    })).rejects.toMatchObject({ code: 'not-found' });
  });

  test('Escenarios 10, 11, 12 y 13: Autorización estricta (Gerente autorizado; Gestor, Vendedor y Usuario revocado rechazados)', async () => {
    const { db, svc, manager, gestor, seller1, revokedManager, setLiveManagerAllowed } = buildB43Harness();
    db.seed('clients_prod/C_AUTH_SRC', {
      id: 'C_AUTH_SRC',
      tipo: 'juridica',
      empresa: 'Seguridad Industrial S.A. de C.V.',
      nit: '0614-303090-103-4'
    });
    db.seed('clients_prod/C_AUTH_DST', {
      id: 'C_AUTH_DST',
      tipo: 'juridica',
      empresa: 'Seguridad Industrial S.A. de C.V.',
      nit: '0614-303090-103-4'
    });

    // Escenario 11: Gestor no autorizado
    await expect(svc.previewMerge(gestor, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    await expect(svc.mergeAccounts(gestor, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST',
      justification: 'Intento por gestor'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Escenario 12: Vendedor no autorizado
    await expect(svc.previewMerge(seller1, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    await expect(svc.mergeAccounts(seller1, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST',
      justification: 'Intento por vendedor'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Escenario 13: Usuario revocado no autorizado (tanto por perfil inactivo como por verifyManager=false)
    await expect(svc.mergeAccounts(revokedManager, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST',
      justification: 'Intento por gerente revocado'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    setLiveManagerAllowed(false);
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST',
      justification: 'Intento con claim revocado en vivo'
    })).rejects.toMatchObject({ code: 'permission-denied' });
    setLiveManagerAllowed(true);

    // Escenario 10: Gerente activo y verificado autorizado
    const res = await svc.mergeAccounts(manager, {
      sourceId: 'C_AUTH_SRC',
      destinationId: 'C_AUTH_DST',
      justification: 'Fusión ejecutada por gerente activo autorizado.'
    });
    expect(res.status).toBe('merged');
  });

  test('Escenarios 14, 15 y 16: Concurrencia, reintento idempotente (opId) y cambio concurrente de estado (expectedStateHash)', async () => {
    const { db, svc, manager } = buildB43Harness();
    db.seed('clients_prod/C_CONC_SRC', {
      id: 'C_CONC_SRC',
      tipo: 'juridica',
      empresa: 'ElectroDuctos S.A. de C.V.',
      nit: '0614-404090-104-5',
      nrc: '404090-1'
    });
    db.seed('clients_prod/C_CONC_DST', {
      id: 'C_CONC_DST',
      tipo: 'juridica',
      empresa: 'ElectroDuctos S.A. de C.V.',
      nit: '0614-404090-104-5',
      nrc: '404090-1'
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_CONC_SRC', destinationId: 'C_CONC_DST' });

    // Escenario 16: Cambio concurrente de identidad o estado antes de confirmar invalida expectedStateHash
    db.seed('clients_prod/C_CONC_SRC', {
      ...db.data('clients_prod/C_CONC_SRC'),
      nit: '0614-999999-109-9'
    });
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_CONC_SRC',
      destinationId: 'C_CONC_DST',
      justification: 'Confirmación con hash desactualizado tras cambio concurrente',
      expectedStateHash: preview.stateHash,
      opId: 'op_stale_hash_1'
    })).rejects.toMatchObject({ code: 'failed-precondition' });

    // Restore NIT to match preview
    db.seed('clients_prod/C_CONC_SRC', {
      ...db.data('clients_prod/C_CONC_SRC'),
      nit: '0614-404090-104-5'
    });

    // Escenario 15: Ejecución y reintento idempotente con el mismo opId
    const first = await svc.mergeAccounts(manager, {
      sourceId: 'C_CONC_SRC',
      destinationId: 'C_CONC_DST',
      justification: 'Fusión atómica con opId fijo.',
      expectedStateHash: preview.stateHash,
      opId: 'op_idempotent_merge_1'
    });
    expect(first.status).toBe('merged');

    const retrySameOp = await svc.mergeAccounts(manager, {
      sourceId: 'C_CONC_SRC',
      destinationId: 'C_CONC_DST',
      justification: 'Fusión atómica con opId fijo.',
      expectedStateHash: preview.stateHash,
      opId: 'op_idempotent_merge_1'
    });
    expect(retrySameOp.status).toBe('merged');
    expect(retrySameOp.canonicalAccountId).toBe('C_CONC_DST');

    // Escenario 14: Otra solicitud concurrente con distinto opId para la misma pareja devuelve already-merged; hacia otra cuenta falla con failed-precondition
    const secondDifferentOpSamePair = await svc.mergeAccounts(manager, {
      sourceId: 'C_CONC_SRC',
      destinationId: 'C_CONC_DST',
      justification: 'Segunda solicitud para la misma pareja ya fusionada.',
      opId: 'op_concurrent_same_pair_2'
    });
    expect(secondDifferentOpSamePair.status).toBe('already-merged');

    db.seed('clients_prod/C_OTHER_DST', {
      id: 'C_OTHER_DST',
      tipo: 'juridica',
      empresa: 'ElectroDuctos S.A. de C.V.',
      nit: '0614-404090-104-5'
    });
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_CONC_SRC',
      destinationId: 'C_OTHER_DST',
      justification: 'Intento de refusionar hacia un destino diferente',
      opId: 'op_concurrent_diff_dest_3'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('Escenarios 17, 18, 19 y 20: Preservación íntegra de oportunidades históricas, contactos/períodos, documentos en Storage y facturas/pagos sin duplicación', async () => {
    const { db, svc, manager, seller1, seller2 } = buildB43Harness();
    const srcDocs = {
      nit: { path: 'prod_files/clients/C_HIST_SRC/nit/nit_src.pdf', name: 'nit_src.pdf', uploadedAt: '2025-05-01T00:00:00Z' },
      escritura: { path: 'prod_files/clients/C_HIST_SRC/escritura/esc_src.pdf', name: 'esc_src.pdf', uploadedAt: '2025-05-01T00:00:00Z' }
    };
    const dstDocs = {
      nit: { path: 'prod_files/clients/C_HIST_DST/nit/nit_dst.pdf', name: 'nit_dst.pdf', uploadedAt: '2026-01-10T00:00:00Z' }
    };

    db.seed('clients_prod/C_HIST_SRC', {
      id: 'C_HIST_SRC',
      tipo: 'juridica',
      empresa: 'Climatización Integral S.A. de C.V.',
      nit: '0614-505090-105-6',
      nrc: '505090-2',
      createdBy: seller1.id,
      visibleTo: [seller1.id],
      closingVendors: [seller1.id],
      documentos: srcDocs
    });
    db.seed('clients_prod/C_HIST_DST', {
      id: 'C_HIST_DST',
      tipo: 'juridica',
      empresa: 'Climatización Integral S.A. de C.V.',
      nit: '0614-505090-105-6',
      nrc: '505090-2',
      createdBy: seller2.id,
      visibleTo: [seller2.id],
      closingVendors: [],
      documentos: dstDocs
    });

    // Historical opportunity with invoices and payments on C_HIST_SRC
    db.seed('prospects_prod/OPP_HIST_1', {
      id: 'OPP_HIST_1',
      clientId: 'C_HIST_SRC',
      proyecto: 'Planta Industrial Fase I',
      vendedorId: seller1.id,
      etapa: 'ganado',
      estado: 'cerrado',
      facturas: [{ numero: 'CCF-001', monto: 15000 }, { numero: 'CCF-002', monto: 20000 }],
      pagos: [{ referencia: 'PAG-001', monto: 15000 }]
    });

    // Contacts & employment periods on C_HIST_SRC
    db.seed('contacts_prod/PER_HIST_1', {
      id: 'PER_HIST_1',
      clientId: 'C_HIST_SRC',
      nombres: 'Claudia',
      apellidos: 'Navarro'
    });
    db.seed('account_contacts_prod/REL_HIST_1', {
      id: 'REL_HIST_1',
      accountId: 'C_HIST_SRC',
      contactId: 'PER_HIST_1',
      cargo: 'Gerente de Compras',
      activo: true,
      periodos: [{ inicio: '2024-01-01', fin: null, cargo: 'Gerente de Compras' }]
    });

    const preview = await svc.previewMerge(manager, { sourceId: 'C_HIST_SRC', destinationId: 'C_HIST_DST' });
    expect(preview.source.opportunitiesCount).toBe(1);
    expect(preview.source.contactsCount).toBe(1);
    expect(preview.source.documentsCount).toBe(2);
    expect(preview.source.billingSummary).toEqual({
      hasBillingHistory: true,
      hasInvoices: true,
      hasPayments: true,
      invoicesCount: 2,
      paymentsCount: 1
    });

    const merged = await svc.mergeAccounts(manager, {
      sourceId: 'C_HIST_SRC',
      destinationId: 'C_HIST_DST',
      justification: 'Unificación gerencial conservando todo el historial.',
      expectedStateHash: preview.stateHash
    });
    expect(merged.status).toBe('merged');

    // Escenario 17: Oportunidad histórica intacta
    const oppAfter = db.data('prospects_prod/OPP_HIST_1');
    expect(oppAfter.clientId).toBe('C_HIST_SRC');
    expect(oppAfter.proyecto).toBe('Planta Industrial Fase I');

    // Escenario 18: Contactos y períodos intactos
    expect(db.data('contacts_prod/PER_HIST_1').nombres).toBe('Claudia');
    expect(db.data('account_contacts_prod/REL_HIST_1').periodos).toHaveLength(1);

    // Escenario 19: Documentos en Storage intactos en ambas cuentas
    expect(db.data('clients_prod/C_HIST_SRC').documentos).toEqual(srcDocs);
    expect(db.data('clients_prod/C_HIST_DST').documentos).toEqual(dstDocs);

    // Escenario 20: Facturas y pagos intactos y sin duplicación
    expect(oppAfter.facturas).toHaveLength(2);
    expect(oppAfter.pagos).toHaveLength(1);
    expect(db.list('prospects_prod')).toHaveLength(1);

    // Cartera de la cuenta destino no fue alterada automáticamente (sin unión automática de carteras)
    expect(db.data('clients_prod/C_HIST_DST').visibleTo).toEqual([seller2.id]);
    expect(db.data('clients_prod/C_HIST_DST').createdBy).toBe(seller2.id);

    // Account 360 cluster helper consolida ambas cuentas sin duplicar registros
    const cluster = await svc.getCanonicalAccountCluster(manager, { accountId: 'C_HIST_SRC' });
    expect(cluster.canonicalId).toBe('C_HIST_DST');
    expect(cluster.absorbedAccountIds).toEqual(['C_HIST_SRC']);
    expect(cluster.allAccountIds).toEqual(['C_HIST_DST', 'C_HIST_SRC']);
  });

  test('Escenarios 21 y 22: Coherencia de clientIdentifiers_prod y prevención de duplicados después de fusionar', async () => {
    const { db, svc, manager, seller1 } = buildB43Harness();
    // Source has NRC only; Destination has NIT only. After merge, both NIT and NRC in clientIdentifiers_prod must point to Destination!
    db.seed('clients_prod/C_ID_SRC', {
      id: 'C_ID_SRC',
      tipo: 'juridica',
      empresa: ' Corporación Solar S.A. de C.V. ',
      nit: '',
      nrc: '888777-6',
      createdBy: seller1.id,
      visibleTo: [seller1.id]
    });
    db.seed('clientIdentifiers_prod/NRC_8887776', { clientId: 'C_ID_SRC', field: 'nrc' });

    db.seed('clients_prod/C_ID_DST', {
      id: 'C_ID_DST',
      tipo: 'juridica',
      empresa: 'CORPORACION SOLAR, S.A. DE C.V.',
      nit: '0614-606090-106-7',
      nrc: '',
      createdBy: seller1.id,
      visibleTo: [seller1.id]
    });
    db.seed('clientIdentifiers_prod/NIT_06146060901067', { clientId: 'C_ID_DST', field: 'nit' });

    const res = await svc.mergeAccounts(manager, {
      sourceId: 'C_ID_SRC',
      destinationId: 'C_ID_DST',
      justification: 'Unificación de cuenta con NRC y cuenta con NIT de la misma sociedad.',
      legalIdentityVerified: true,
      verificationEvidence: 'Escritura pública y tarjeta de IVA 888777-6 de Corporación Solar.'
    });
    expect(res.status).toBe('merged');

    // Escenario 21: Ambos identificadores apuntan a la cuenta canónica C_ID_DST
    const nitLock = db.data('clientIdentifiers_prod/NIT_06146060901067');
    const nrcLock = db.data('clientIdentifiers_prod/NRC_8887776');
    expect(nitLock.clientId).toBe('C_ID_DST');
    expect(nrcLock.clientId).toBe('C_ID_DST');
    expect(nrcLock.absorbedClientId).toBe('C_ID_SRC');

    // Escenario 22: Intentar crear una nueva cuenta con el NRC de la cuenta absorbida o con el NIT de la canónica se bloquea y resuelve hacia C_ID_DST
    const dupByAbsorbedNrc = await svc.create(seller1, {
      client: {
        tipo: 'juridica',
        empresa: 'Nueva Intento Solar S.A.',
        contacto: 'Pedro',
        telefono: '2200-9999',
        nrc: '8887776'
      }
    });
    expect(dupByAbsorbedNrc.status).toBe('duplicate');
    expect(dupByAbsorbedNrc.matches[0].clientId).toBe('C_ID_DST');

    // Incluso si se edita la cuenta destino sin llenar aún su campo NRC, el lock NRC_8887776 con absorbedClientId NO queda huérfano
    const updDst = await svc.update(seller1, {
      id: 'C_ID_DST',
      client: {
        tipo: 'juridica',
        empresa: 'CORPORACION SOLAR, S.A. DE C.V.',
        contacto: 'Ing. Solar',
        telefono: '2299-8888',
        nit: '0614-606090-106-7',
        nrc: ''
      }
    });
    expect(updDst.status).toBe('updated');
    expect(db.data('clientIdentifiers_prod/NRC_8887776').clientId).toBe('C_ID_DST');
  });

  test('Escenarios 23 y 24: Acceso seguro a documentos históricos usando B4.1 y auditoría íntegra (clientAccountMerged y clientAccountMergeRejected)', async () => {
    const { db, svc, manager, seller1, seller2 } = buildB43Harness();
    // seller1 created C_DOC_SRC (absorbed), seller2 owns C_DOC_DST (canonical survivor)
    db.seed('clients_prod/C_DOC_SRC', {
      id: 'C_DOC_SRC',
      tipo: 'juridica',
      empresa: 'Ingeniería Térmica S.A. de C.V.',
      nit: '0614-707090-107-8',
      createdBy: seller1.id,
      visibleTo: [seller1.id],
      documentos: {
        nit: { path: 'prod_files/clients/C_DOC_SRC/nit/nit.pdf', name: 'nit.pdf' }
      }
    });
    db.seed('clients_prod/C_DOC_DST', {
      id: 'C_DOC_DST',
      tipo: 'juridica',
      empresa: 'Ingeniería Térmica S.A. de C.V.',
      nit: '0614-707090-107-8',
      createdBy: seller2.id,
      visibleTo: [seller2.id]
    });

    await svc.mergeAccounts(manager, {
      sourceId: 'C_DOC_SRC',
      destinationId: 'C_DOC_DST',
      justification: 'Fusión auditada para prueba de acceso B4.1 a documentos históricos.'
    });

    const storageSvc = createStorageService({
      db,
      FieldValue: { serverTimestamp: () => SERVER_TS },
      suffix: '_prod',
      bucket: {
        file: (p) => ({
          exists: async () => [true],
          getMetadata: async () => [{ size: 1024, contentType: 'application/pdf' }],
          getSignedUrl: async () => [`https://signed.example.test/${encodeURIComponent(p)}`]
        })
      }
    });

    // Escenario 23: seller2 (autorizado en la cuenta canónica C_DOC_DST) PUEDE leer el documento histórico alojado bajo C_DOC_SRC
    const signedForSeller2 = await storageSvc.getSecureDownloadUrl({
      caller: seller2,
      storagePath: 'prod_files/clients/C_DOC_SRC/nit/nit.pdf',
      context: { clientId: 'C_DOC_SRC' }
    });
    expect(signedForSeller2.signedUrl).toContain('C_DOC_SRC');

    // seller1 (que tenía la cuenta absorbida pero NO está autorizado en la cuenta canónica C_DOC_DST) es RECHAZADO conforme a B4.1
    await expect(storageSvc.getSecureDownloadUrl({
      caller: seller1,
      storagePath: 'prod_files/clients/C_DOC_SRC/nit/nit.pdf',
      context: { clientId: 'C_DOC_SRC' }
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Escenario 24: Verificar registro de auditoría clientAccountMerged y clientAccountMergeRejected
    const audits = db.list('commercialAudit_prod');
    const mergedAudit = audits.find(a => a.action === 'clientAccountMerged');
    expect(mergedAudit).toBeDefined();
    expect(mergedAudit.actorUid).toBe(manager.uid);
    expect(mergedAudit.targetClientId).toBe('C_DOC_DST');
    expect(mergedAudit.detail).toMatchObject({
      sourceAccountId: 'C_DOC_SRC',
      destinationAccountId: 'C_DOC_DST',
      justification: 'Fusión auditada para prueba de acceso B4.1 a documentos históricos.'
    });

    // Trigger a rejected merge and verify clientAccountMergeRejected is audited
    await expect(svc.mergeAccounts(manager, {
      sourceId: 'C_DOC_SRC',
      destinationId: 'C_DOC_DST',
      justification: 'No' // < 5 chars -> invalid-argument rejection audit
    })).rejects.toMatchObject({ code: 'invalid-argument' });

    const auditsAfterReject = db.list('commercialAudit_prod');
    const rejectedAudit = auditsAfterReject.find(a => a.action === 'clientAccountMergeRejected');
    expect(rejectedAudit).toBeDefined();
    expect(rejectedAudit.detail.sourceId).toBe('C_DOC_SRC');
  });

  test('Escenarios 25 y 26: Exclusión de selectores comerciales ordinarios, navegación a cuenta canónica en UI y no regresión de B4.1, B4.2 y B3', async () => {
    const { db, svc, manager, seller1, seller2 } = buildB43Harness();
    db.seed('clients_prod/C_UI_SRC', {
      id: 'C_UI_SRC',
      tipo: 'juridica',
      empresa: 'Ventilación Industrial S.A. de C.V.',
      contacto: 'Ing. Fuentes',
      telefono: '2233-4455',
      nit: '0614-808090-108-9',
      nrc: '808090-3',
      createdBy: seller1.id,
      visibleTo: [seller1.id]
    });
    db.seed('clients_prod/C_UI_DST', {
      id: 'C_UI_DST',
      tipo: 'juridica',
      empresa: 'Ventilación Industrial S.A. de C.V.',
      contacto: 'Ing. Fuentes',
      telefono: '2233-4455',
      nit: '0614-808090-108-9',
      nrc: '808090-3',
      createdBy: seller2.id,
      visibleTo: [seller2.id]
    });

    // Server search before merge returns both active accounts
    const searchBefore = await svc.search(seller2, { q: 'Ventilación' });
    expect(searchBefore.results.map(r => r.id).sort()).toEqual(['C_UI_DST', 'C_UI_SRC']);

    // Set up fake DOM for full managerial UI merge flow + post-merge canonical navigation
    const els = {};
    const getEl = (id) => {
      if (!els[id]) {
        els[id] = {
          id,
          value: '',
          checked: false,
          options: [],
          selectedIndex: 0,
          style: { display: 'none', cssText: '' },
          dataset: {},
          innerHTML: '',
          textContent: '',
          add(opt) {
            this.options.push(opt);
            this.innerHTML += `<option value="${opt.value}">${opt.text}</option>`;
          },
          classList: {
            set: new Set(),
            toggle(c, force) { if (force) this.set.add(c); else this.set.delete(c); },
            contains(c) { return this.set.has(c); },
            remove(c) { this.set.delete(c); }
          }
        };
      }
      return els[id];
    };

    const prevDoc = global.document;
    const prevOption = global.Option;
    global.Option = function (text, value) { this.text = text; this.value = value; };
    global.document = {
      getElementById: (id) => getEl(id),
      querySelectorAll: () => [],
      querySelector: () => null
    };

    try {
      let currentUserState = { id: 'mgr_1', role: 'manager' };
      let clientsState = [
        db.data('clients_prod/C_UI_SRC'),
        db.data('clients_prod/C_UI_DST')
      ];
      const alerts = [];

      const sharedDeps = {
        getCurrentUser: () => currentUserState,
        getClients: () => clientsState,
        setClients: (next) => { clientsState = next; },
        getProspects: () => [],
        getDbSuffix: () => '_prod',
        alert: (msg) => alerts.push(msg),
        showLoading: () => {},
        hideLoading: () => {},
        closeModal: () => {},
        renderClientExpedienteSection: () => {},
        escapeHtmlDoc: (s) => String(s || ''),
        getVisibleClients: () => ClientsController.getVisibleClients(),
        getSelectorClientsLocal: () => ClientsController.getSelectorClientsLocal(),
        catalogueSearchActive: () => false,
        previewAccountMerge: (s, d) => ClientsController.previewAccountMerge(s, d),
        executeAccountMerge: (p) => ClientsController.executeAccountMerge(p),
        getCrmClients: () => CrmClients,
        getFirebase: () => ({
          auth: () => ({ currentUser: { uid: 'uid-mgr-1' } }),
          functions: () => ({
            httpsCallable: (name) => async (payload) => {
              if (name === 'previewMergeAccountsAdmin') {
                return { data: await svc.previewMerge(manager, payload) };
              }
              if (name === 'mergeAccountsAdmin') {
                return { data: await svc.mergeAccounts(manager, payload) };
              }
              throw new Error('Unexpected callable: ' + name);
            }
          })
        })
      };

      ClientsController.init(sharedDeps);
      ClientsUI.init(sharedDeps);

      // Non-manager does NOT see merge buttons when opening detail view
      currentUserState = { id: 'vendedor_2', role: 'vendedor' };
      ClientsUI.openClientDetailView('C_UI_SRC');
      expect(getEl('btn-client-header-merge').style.display).toBe('none');
      expect(getEl('btn-client-modal-merge').style.display).toBe('none');

      // Manager sees merge buttons and can open the merge panel, preview, and execute the merge
      currentUserState = { id: 'mgr_1', role: 'manager' };
      ClientsUI.openClientDetailView('C_UI_SRC');
      expect(getEl('btn-client-header-merge').style.display).toBe('inline-block');

      ClientsUI.openAccountMergePanel('C_UI_SRC');
      expect(getEl('client-merge-admin-panel').style.display).toBe('block');
      getEl('b43-merge-dest-select').value = 'C_UI_DST';

      const prevRes = await ClientsUI.loadAccountMergePreview();
      expect(prevRes.canProceed).toBe(true);
      expect(getEl('b43-merge-preview-container').innerHTML).toContain('Advertencia de Gobernanza B4.1');
      expect(getEl('b43-merge-confirm-section').style.display).toBe('block');

      getEl('b43-merge-justification').value = 'Fusión administrativa verificada desde panel gerencial.';
      getEl('b43-merge-explicit-confirm').checked = true;

      const execRes = await ClientsUI.confirmAndExecuteAccountMerge();
      expect(execRes.status).toBe('merged');

      // After merge, UI automatically navigates to canonical account C_UI_DST
      expect(getEl('client-id-edit').value).toBe('C_UI_DST');

      // Ordinary selector (getSelectorClientsLocal + renderClientSelect) and server catalog search exclude C_UI_SRC
      expect(ClientsController.getSelectorClientsLocal().map(c => c.id)).toEqual(['C_UI_DST']);
      getEl('new-cliente-select').options = [];
      getEl('new-cliente-select').innerHTML = '';
      ClientsUI.renderClientSelect();
      expect(getEl('new-cliente-select').innerHTML).toContain('C_UI_DST');
      expect(getEl('new-cliente-select').innerHTML).not.toContain('C_UI_SRC');

      const searchAfter = await svc.search(seller2, { q: 'Ventilación' });
      expect(searchAfter.results.map(r => r.id)).toEqual(['C_UI_DST']);

      // Opening absorbed account C_UI_SRC displays the absorbed status banner and navigates to C_UI_DST
      ClientsUI.openClientDetailView('C_UI_SRC');
      expect(getEl('client-absorbed-status-banner').style.display).toBe('block');
      expect(getEl('client-absorbed-status-banner').innerHTML).toContain('Cuenta histórica absorbida');
      expect(getEl('btn-submit-client').style.display).toBe('none');

      ClientsUI.navigateToCanonicalAccount('C_UI_DST');
      expect(getEl('client-id-edit').value).toBe('C_UI_DST');
      expect(getEl('client-absorbed-status-banner').style.display).toBe('none');
      expect(getEl('btn-submit-client').style.display).toBe('inline-block');

      // Escenario 26: No regresión B3 + B4.1 (accountDocumentsService resuelve cuenta absorbida hacia la canónica)
      db.seed('prospects_prod/OPP_UI_1', {
        id: 'OPP_UI_1',
        clientId: 'C_UI_SRC',
        vendedorId: seller2.id,
        etapa: 'negociacion',
        estado: 'activo'
      });
      const accDocsSvc = createAccountDocumentsService({
        db,
        FieldValue: { serverTimestamp: () => SERVER_TS },
        suffix: '_prod',
        storageBucket: {
          file: () => ({
            exists: async () => [true],
            getMetadata: async () => [{ size: 2048, contentType: 'application/pdf' }]
          })
        }
      });
      const closeValForSeller2 = await accDocsSvc.validateAccountDocumentsForOpportunityClose({
        caller: seller2,
        prospectId: 'OPP_UI_1',
        accountId: 'C_UI_SRC'
      });
      expect(closeValForSeller2.validationId).toBeDefined();
      await expect(accDocsSvc.validateAccountDocumentsForOpportunityClose({
        caller: seller1,
        prospectId: 'OPP_UI_1',
        accountId: 'C_UI_SRC'
      })).rejects.toMatchObject({ code: 'permission-denied' });
    } finally {
      global.document = prevDoc;
      global.Option = prevOption;
    }
  });
});
