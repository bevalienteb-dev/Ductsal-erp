// functions/__tests__/plantAuthService.unit.test.js
// UNIT layer: tablet login logic against an in-memory Firestore and a stub Auth (no emulator, no network).
// What this layer cannot show (real Auth custom-token exchange, security rules, Functions runtime) is covered by
// isolated-tests/plantAuth.iso.js.
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createPlantAuthService, TABLET_ROLES, POLICY } = require('../plantAuthService');
const { ServiceError } = require('../clientsService');

const U = {
  op: { id: '1700000000001', nombre: 'Luis Operario', role: 'operario', activo: true, pin: '4821', password: '123456', stations: ['CNC (Lamina)', 'Soldadura'] },
  inactive: { id: '1700000000002', nombre: 'Inactivo', role: 'operario', activo: false, pin: '1111', password: '222222', stations: [] },
  qa: { id: '1700000000003', nombre: 'Rosa QA', role: 'control_calidad', activo: true, pin: '5555', password: '654321', also_does_dispatch: true },
  jefe: { id: '1700000000004', nombre: 'Jefe Prod', role: 'jefe_produccion', activo: true, email: 'Jefe@Ductsal.test', password: '999000' },
  mgr: { id: '1700000000005', nombre: 'Gerente', role: 'manager', activo: true, pin: '7777', password: '777777', authUid: 'uid-mgr' },
  vend: { id: '1700000000006', nombre: 'Vendedor', role: 'vendedor', activo: true, pin: '8888', password: '888888', authUid: 'uid-v' },
  dup1: { id: '1700000000007', nombre: 'Gemelo', role: 'operario', activo: true, pin: '3030', password: '121212' },
  dup2: { id: '1700000000008', nombre: 'Gemelo 2', role: 'despacho', activo: true, pin: '3030', password: '121212' },
  noActivo: { id: '1700000000009', nombre: 'Sin campo activo', role: 'operario', pin: '4040', password: '343434' }
};

let db; let auth; let clock; let svc;
const T0 = new Date('2026-03-15T12:00:00.000Z').getTime();
const make = (extra = {}) => createPlantAuthService({ db, auth, FieldValue: db.FieldValue, suffix: '_prod', now: () => new Date(clock), ...extra });
const errOf = async p => { try { await p; } catch (e) { return e; } return null; };

beforeEach(() => {
  db = createFakeFirestore();
  clock = T0;
  auth = { minted: [], async createCustomToken(uid, claims) { this.minted.push({ uid, claims }); return `custom-token-for-${uid}`; } };
  Object.values(U).forEach(u => db.seed(`users_prod/${u.id}`, u));
  svc = make();
});

describe('valid login', () => {
  test('PIN + numeric password: returns a custom token and a profile WITHOUT credentials', async () => {
    const r = await svc.login({ identifier: '4821', password: '123456' });
    expect(r.token).toBe('custom-token-for-plant_1700000000001');
    expect(r.profile).toEqual({ id: U.op.id, nombre: 'Luis Operario', role: 'operario', stations: ['CNC (Lamina)', 'Soldadura'], also_does_dispatch: false });
    const wire = JSON.stringify(r);
    expect(wire).not.toContain('4821'); expect(wire).not.toContain('123456'); expect(wire).not.toMatch(/password|pin/i);
  });
  test('claims are minimal, plant-only and never commercial: no manager claim, no stations, uid never an Auth uid of a CRM profile', async () => {
    await svc.login({ identifier: '4821', password: '123456' });
    expect(auth.minted).toEqual([{ uid: 'plant_1700000000001', claims: { plant: true, role: 'operario', cid: '1700000000001' } }]);
    expect(Object.keys(auth.minted[0].claims)).not.toContain('manager');
  });
  test('the identifiers operador.js accepts today still work: exact name, and e-mail case-insensitively', async () => {
    expect((await svc.login({ identifier: 'Rosa QA', password: '654321' })).profile.role).toBe('control_calidad');
    expect((await svc.login({ identifier: 'jefe@ductsal.test', password: '999000' })).profile.role).toBe('jefe_produccion');
  });
  test('every plant role of the tablet can sign in; also_does_dispatch is passed through', async () => {
    expect(TABLET_ROLES).toEqual(['operario', 'encargado_armado', 'jefe_produccion', 'control_calidad', 'despacho']);
    expect((await svc.login({ identifier: '5555', password: '654321' })).profile.also_does_dispatch).toBe(true);
  });
  test('whitespace around the typed values is ignored (operador.js trims both)', async () => {
    expect((await svc.login({ identifier: '  4821 ', password: ' 123456 ' })).profile.id).toBe(U.op.id);
  });
  test('the profile document is not modified by a login (no migration, no authUid, no password hash)', async () => {
    const before = db.data(`users_prod/${U.op.id}`);
    await svc.login({ identifier: '4821', password: '123456' });
    expect(db.data(`users_prod/${U.op.id}`)).toEqual(before);
  });
});

describe('invalid login', () => {
  test('wrong password, unknown PIN and a right password with a wrong PIN all give the SAME generic denial', async () => {
    const es = [];
    for (const [i, p] of [['4821', '000000'], ['9999', '123456'], ['4821', '654321']]) es.push(await errOf(svc.login({ identifier: i, password: p })));
    es.forEach(e => { expect(e).toBeInstanceOf(ServiceError); expect(e.code).toBe('permission-denied'); });
    expect(new Set(es.map(e => e.message)).size).toBe(1);
    expect(auth.minted).toHaveLength(0);
  });
  test('malformed input is refused before any lookup: non-numeric password, empty or oversized identifier, non-strings', async () => {
    for (const [i, p] of [['4821', 'abc123'], ['4821', ''], ['', '123456'], ['x'.repeat(81), '123456'], [4821, '123456'], ['4821', 123456], [undefined, undefined]]) {
      expect((await errOf(svc.login({ identifier: i, password: p }))).code).toBe('invalid-argument');
    }
    expect(db.count('plantLoginAttempts_prod')).toBe(0);
  });
  test('an inactive operator (right credentials) is refused with its own message and gets no token', async () => {
    const e = await errOf(svc.login({ identifier: '1111', password: '222222' }));
    expect(e.code).toBe('permission-denied'); expect(e.message).toMatch(/inactivo/i);
    expect(auth.minted).toHaveLength(0);
  });
  test('a profile without the `activo` field is NOT treated as active (strict)', async () => {
    expect((await errOf(svc.login({ identifier: '4040', password: '343434' }))).message).toMatch(/inactivo/i);
  });
  test('commercial profiles (manager, vendedor) cannot use the tablet login even with their right PIN and password', async () => {
    for (const [i, p] of [['7777', '777777'], ['8888', '888888']]) {
      expect((await errOf(svc.login({ identifier: i, password: p }))).code).toBe('permission-denied');
    }
    expect(auth.minted).toHaveLength(0);
  });
  test('two plant profiles sharing identifier AND password are ambiguous: refused, never guessed', async () => {
    expect((await errOf(svc.login({ identifier: '3030', password: '121212' }))).code).toBe('permission-denied');
    expect(auth.minted).toHaveLength(0);
  });
  test('an unsafe profile id (not usable in a uid) is refused instead of minting a strange uid', async () => {
    db.seed('users_prod/bad id/../x', { id: 'bad', nombre: 'Raro', role: 'operario', activo: true, pin: '6060', password: '565656' });
    const e = await errOf(svc.login({ identifier: '6060', password: '565656' }));
    expect(e.code).toBe('failed-precondition');
  });
});

describe('attempt limit', () => {
  const fail = (i = '4821') => errOf(svc.login({ identifier: i, password: '000000' }));
  test('5 wrong attempts are answered normally; the 6th is locked, and even the CORRECT password is then refused', async () => {
    for (let n = 0; n < POLICY.maxAttemptsPerIdentifier; n++) expect((await fail()).code).toBe('permission-denied');
    const sixth = await fail();
    expect(sixth.code).toBe('resource-exhausted'); expect(sixth.message).toMatch(/minuto/);
    expect((await errOf(svc.login({ identifier: '4821', password: '123456' }))).code).toBe('resource-exhausted');
    expect(auth.minted).toHaveLength(0);
  });
  test('the lock expires after lockMs and the operator can sign in again; the counter starts over', async () => {
    for (let n = 0; n <= POLICY.maxAttemptsPerIdentifier; n++) await fail();
    clock += POLICY.lockMs - 1000;
    expect((await fail()).code).toBe('resource-exhausted');
    clock += 2000;
    expect((await svc.login({ identifier: '4821', password: '123456' })).profile.id).toBe(U.op.id);
    expect((await fail()).code).toBe('permission-denied'); // fresh budget
  });
  test('a successful login clears the identifier counter (4 failures + success + 4 failures never locks)', async () => {
    for (let n = 0; n < 4; n++) await fail();
    await svc.login({ identifier: '4821', password: '123456' });
    for (let n = 0; n < 4; n++) expect((await fail()).code).toBe('permission-denied');
  });
  test('failures older than the window do not accumulate', async () => {
    for (let n = 0; n < 4; n++) await fail();
    clock += POLICY.windowMs + 1;
    for (let n = 0; n < 5; n++) expect((await fail()).code).toBe('permission-denied');
  });
  test('the limit also protects identifiers that do not exist (no enumeration through the lock)', async () => {
    for (let n = 0; n < POLICY.maxAttemptsPerIdentifier; n++) await fail('0000');
    expect((await fail('0000')).code).toBe('resource-exhausted');
  });
  test('locking one identifier does not lock another one', async () => {
    for (let n = 0; n <= POLICY.maxAttemptsPerIdentifier; n++) await fail('4821');
    expect((await svc.login({ identifier: '5555', password: '654321' })).profile.role).toBe('control_calidad');
  });
  test('PARALLEL guesses cannot exceed the budget: 20 simultaneous wrong attempts -> exactly 5 reach the credential check', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => fail()));
    expect(rs.filter(e => e.code === 'permission-denied')).toHaveLength(POLICY.maxAttemptsPerIdentifier);
    expect(rs.filter(e => e.code === 'resource-exhausted')).toHaveLength(15);
  });
  test('per-address limit: many different identifiers from one address are throttled; other addresses are not', async () => {
    const small = make({ policy: { ...POLICY, maxAttemptsPerIp: 6 } });
    for (let n = 0; n < 6; n++) expect((await errOf(small.login({ identifier: `90${n}0`, password: '000000', ip: '10.0.0.9' }))).code).toBe('permission-denied');
    expect((await errOf(small.login({ identifier: '9999', password: '000000', ip: '10.0.0.9' }))).code).toBe('resource-exhausted');
    expect((await small.login({ identifier: '4821', password: '123456', ip: '10.0.0.10' })).profile.id).toBe(U.op.id);
  });
  test('good logins from one address give the address budget back (a shift start with many tablets is not throttled)', async () => {
    const small = make({ policy: { ...POLICY, maxAttemptsPerIp: 3 } });
    for (let n = 0; n < 10; n++) await small.login({ identifier: '4821', password: '123456', ip: '10.0.0.5' });
  });
  test('attempt records hold only hashes: neither the typed identifier nor the address appears in them', async () => {
    await errOf(svc.login({ identifier: '4821', password: '918273', ip: '192.168.7.7' }));
    const dump = JSON.stringify(db.list('plantLoginAttempts_prod'));
    expect(dump).not.toContain('4821'); expect(dump).not.toContain('192.168.7.7'); expect(dump).not.toContain('918273');
  });
});

describe('no secrets in logs or errors', () => {
  test('no console output at all during success, failure, inactive and lock', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(k => jest.spyOn(console, k).mockImplementation(() => {}));
    await svc.login({ identifier: '4821', password: '123456' });
    for (let n = 0; n < 7; n++) await errOf(svc.login({ identifier: '4821', password: '000000' }));
    await errOf(svc.login({ identifier: '1111', password: '222222' }));
    spies.forEach(s => { expect(s).not.toHaveBeenCalled(); s.mockRestore(); });
  });
  test('the source never logs: no console / logger call in plantAuthService.js', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'plantAuthService.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/console\.|logger\./);
  });
  test('error messages never echo the typed PIN or password', async () => {
    for (const [i, p] of [['4821', '000000'], ['1111', '222222'], ['3030', '121212']]) {
      const e = await errOf(svc.login({ identifier: i, password: p }));
      expect(e.message).not.toContain(i); expect(e.message).not.toContain(p);
    }
  });
});

describe('isolation', () => {
  test('the service only reads users_* and reads/writes plantLoginAttempts_*', async () => {
    await svc.login({ identifier: '4821', password: '123456' });
    expect(db.count('users_prod')).toBe(Object.keys(U).length);
    expect(db.count('plantLoginAttempts_prod')).toBeGreaterThan(0);
  });
  test('only the two known environment suffixes are accepted', () => {
    expect(() => createPlantAuthService({ db, auth, FieldValue: db.FieldValue, suffix: '_x' })).toThrow('Invalid suffix');
  });
  test('the _local environment uses its own users and attempt collections', async () => {
    db.seed('users_local/9', { id: '9', nombre: 'Local', role: 'operario', activo: true, pin: '4821', password: '000111' });
    const local = createPlantAuthService({ db, auth, FieldValue: db.FieldValue, suffix: '_local', now: () => new Date(clock) });
    expect((await local.login({ identifier: '4821', password: '000111' })).profile.id).toBe('9');
    expect((await errOf(local.login({ identifier: '4821', password: '123456' }))).code).toBe('permission-denied'); // prod's password is unknown there
    expect(db.count('plantLoginAttempts_local')).toBeGreaterThan(0);
  });
});
