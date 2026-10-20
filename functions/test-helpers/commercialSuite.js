// functions/test-helpers/commercialSuite.js
// Behavioural suite of the commercial operations, written against an abstract environment so the SAME assertions run on
//   - the in-memory Firestore (functions/__tests__/commercialService.unit.test.js)  -> unit layer
//   - the real Firestore emulator (functions/isolated-tests/commercialService.iso.js) -> emulator layer
// An environment provides: { service, live, now, seed(path,data), read(path), list(col), clear(), failNextCommit?(), stats?() }.
// Not a test file itself (it lives outside __tests__): it only registers describe/test blocks when called.

const P = {
  MGR: { id: '1000000000001', authUid: 'uid-mgr', role: 'manager', nombre: 'Gerente Alfa', activo: true },
  GES: { id: '1000000000002', authUid: 'uid-ges', role: 'gestor', nombre: 'Gestora Gamma', activo: true },
  V1: { id: '1792037387205', authUid: 'uid-v1', role: 'vendedor', nombre: 'Vendedor Uno', activo: true },
  V2: { id: '1792038830686', authUid: 'uid-v2', role: 'vendedor', nombre: 'Vendedor Dos', activo: true },
  V3: { id: '1792039999999', authUid: 'uid-v3', role: 'vendedor', nombre: 'Vendedor Tres', activo: true },
  HIST: { id: '1700000000001', role: 'vendedor', nombre: 'Vendedor Historico', activo: true, password: 'legacy-placeholder' },
  INACT: { id: '1792000000000', authUid: 'uid-in', role: 'vendedor', nombre: 'Vendedor Inactivo', activo: false },
  PLANT: { id: 'OP1', authUid: 'uid-op', role: 'operario', nombre: 'Operario Uno', activo: true }
};
const caller = k => ({ uid: P[k].authUid || 'uid-none', cid: P[k].id, role: P[k].role, name: P[k].nombre });

const MANUAL_OLD = { text: '(Ana)  nota vieja sin autor técnico', date: '2026-01-01T00:00:00.000Z', auto: false };
const AUTO_OLD = { text: ' Prospecto creado por Ana. Vendedor asignado: Ana. Origen: Referido', date: '2026-01-01T00:00:00.000Z', auto: true };

let opN = 0;
const op = () => `op-${String(++opN).padStart(10, '0')}`;
const input = (o = {}) => ({ clientId: 'C1', proyecto: 'Torre Norte', origen: 'Referido', tipo_proyecto: 'Nuevo', tipo_producto: 'Ductos', ...o });

async function rejects(promise, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.code).toBe(code);
  return err;
}

function defineCommercialSuite({ label, makeEnv, makeServiceWithFixedProspectId, supportsFailureInjection = false }) {
  describe(`commercial operations: ${label}`, () => {
    let env; let svc;
    const audit = async (action) => (await env.list('commercialAudit_prod')).filter(a => !action || a.action === action);
    const prospect = id => env.read(`prospects_prod/${id}`);

    beforeAll(() => { env = makeEnv(); svc = env.service; });
    beforeEach(async () => {
      await env.clear();
      for (const k of Object.keys(P)) await env.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
      await env.seed('clients_prod/C1', { id: 'C1', tipo: 'juridica', empresa: 'Industrias Delta', contacto: 'Ana', telefono: '7000-0001', nit: '0614-123456-123-4', createdBy: P.V1.id, documentos: {} });
      await env.seed('clientIdentifiers_prod/NIT_06141234561234', { key: 'NIT_06141234561234', kind: 'NIT', clientId: 'C1' });
      await env.seed('clients_prod/C2', { id: 'C2', tipo: 'natural', nombres: 'Maria', apellidos: 'Lopez', dui: '01234567-8', telefono: '7000-0002', createdBy: P.V2.id });
      await env.seed('clientIdentifiers_prod/DUI_012345678', { key: 'DUI_012345678', kind: 'DUI', clientId: 'C2' });
      // P1: created by and assigned to V1. P2: created by the gestor, assigned to V2 (V1 and V3 are unrelated to it).
      await env.seed('prospects_prod/P1', { id: 'P1', codigo: '202601001', clientId: 'C1', createdBy: P.V1.id, vendedorId: P.V1.id, vendedorName: 'Vendedor Uno', vendedorRole: 'vendedor', fecha_creacion: '2026-01-01T00:00:00.000Z', estado: 'activo', datos: { nota: 'conservar' }, logs: [AUTO_OLD, MANUAL_OLD], facturas: [] });
      await env.seed('prospects_prod/P2', { id: 'P2', codigo: '202601002', clientId: 'C2', createdBy: P.GES.id, vendedorId: P.V2.id, vendedorName: 'Vendedor Dos', vendedorRole: 'vendedor', fecha_creacion: '2026-01-02T00:00:00.000Z', estado: 'activo', datos: {}, logs: [AUTO_OLD], facturas: [] });
    });

    // ------------------------------------------------------------------------------------------------
    describe('createProspect', () => {
      test('creates the opportunity with identity, code, stage and first log decided by the server', async () => {
        const r = await svc.createProspect({ caller: caller('V3'), data: input(), opId: op() });
        expect(r.status).toBe('created');
        const p = await prospect(r.prospect.id);
        expect(p).toMatchObject({
          id: r.prospect.id, clientId: 'C1', proyecto: 'Torre Norte', origen: 'Referido',
          createdBy: P.V3.id, createdByName: 'Vendedor Tres', createdByRole: 'vendedor',
          vendedorId: P.V3.id, vendedorName: 'Vendedor Tres', vendedorRole: 'vendedor',
          etapa: 'prospecto', estado: 'activo', datos: {}, facturas: []
        });
        expect(p.codigo).toMatch(/^202603\d{3}$/);
        expect(p.stage_timestamps).toEqual({ prospecto: env.now.toISOString() });
        expect(p.logs).toHaveLength(1);
        expect(p.logs[0]).toMatchObject({ auto: true });
        expect(p.logs[0].text).toBe(' Prospecto creado por Vendedor Tres. Vendedor asignado: Vendedor Tres. Origen: Referido');
        expect(p.logs[0].by).toBeUndefined();
      });

      test('identity, code, stage, logs and authorisation flags sent by the browser are ignored', async () => {
        const forged = input({
          id: 'HACK', codigo: '999999999', createdBy: P.MGR.id, createdByName: 'Gerente Alfa', createdByRole: 'manager',
          vendedorName: 'Otro', vendedorRole: 'manager', etapa: 'cierre', estado: 'ganado', fecha_creacion: '2020-01-01T00:00:00.000Z',
          logs: [{ text: 'forjado', date: 'x', auto: true }], facturas: [{ id: 'f', monto: 1e9 }],
          datos: { autorizado_sin_contrato: true, autorizado_por: 'Gerente Alfa' }, visibleTo: [P.MGR.id], authUid: 'uid-mgr'
        });
        const r = await svc.createProspect({ caller: caller('V1'), data: forged, opId: op() });
        const p = await prospect(r.prospect.id);
        expect(p.id).not.toBe('HACK');
        expect(await prospect('HACK')).toBeUndefined();
        expect(p).toMatchObject({ createdBy: P.V1.id, createdByName: 'Vendedor Uno', createdByRole: 'vendedor', vendedorId: P.V1.id, vendedorRole: 'vendedor', etapa: 'prospecto', estado: 'activo', facturas: [], datos: {} });
        expect(p.codigo).not.toBe('999999999');
        expect(p.fecha_creacion).toBe(env.now.toISOString());
        expect(p.logs).toHaveLength(1);
        expect(p.logs[0].text).not.toMatch(/forjado/);
        expect(p.visibleTo).toBeUndefined();
        expect(p.authUid).toBeUndefined();
      });

      test('a vendedor cannot create an opportunity assigned to someone else', async () => {
        await rejects(svc.createProspect({ caller: caller('V1'), data: input({ vendedorId: P.V2.id }), opId: op() }), 'permission-denied');
        expect((await env.list('prospects_prod')).length).toBe(2);
        expect(await env.list('prospectOps_prod')).toHaveLength(0);
      });

      test('manager and gestor may assign; the assignee name and role come from the assignee profile', async () => {
        for (const who of ['GES', 'MGR']) {
          const r = await svc.createProspect({ caller: caller(who), data: input({ vendedorId: P.V2.id, vendedorName: 'Falso' }), opId: op() });
          const p = await prospect(r.prospect.id);
          expect(p).toMatchObject({ createdBy: P[who].id, vendedorId: P.V2.id, vendedorName: 'Vendedor Dos', vendedorRole: 'vendedor' });
          expect(p.logs[0].text).toContain('Vendedor asignado: Vendedor Dos');
        }
      });

      test('a historical user (no Auth account) is a valid assignee; an inactive, unknown or plant user is not', async () => {
        const ok = await svc.createProspect({ caller: caller('GES'), data: input({ vendedorId: P.HIST.id }), opId: op() });
        expect((await prospect(ok.prospect.id)).vendedorId).toBe(P.HIST.id);
        for (const id of [P.INACT.id, P.PLANT.id, '1111111111111']) {
          await rejects(svc.createProspect({ caller: caller('GES'), data: input({ vendedorId: id }), opId: op() }), 'invalid-argument');
        }
        expect((await env.list('prospects_prod')).length).toBe(3);
      });

      test('the client must exist', async () => {
        await rejects(svc.createProspect({ caller: caller('V1'), data: input({ clientId: 'NOPE' }), opId: op() }), 'not-found');
      });

      test.each([
        ['missing project', { proyecto: undefined }],
        ['blank project', { proyecto: '   ' }],
        ['non-string project', { proyecto: 123 }],
        ['project too long', { proyecto: 'x'.repeat(201) }],
        ['missing origin', { origen: '' }],
        ['missing product type', { tipo_producto: undefined }],
        ['object as project', { proyecto: { $gt: '' } }],
        ['clientId with a path', { clientId: 'C1/../x' }],
        ['missing clientId', { clientId: undefined }],
        ['vendedorId with a path', { vendedorId: 'a/b' }]
      ])('invalid input is rejected: %s', async (_n, patch) => {
        await rejects(svc.createProspect({ caller: caller('GES'), data: input(patch), opId: op() }), 'invalid-argument');
        expect((await env.list('prospects_prod')).length).toBe(2);
      });

      test.each([[undefined], [''], ['short'], ['has space 12345'], ['a/b/c/d/e/f/g'], [12345678], ['x'.repeat(101)]])('invalid opId %p is rejected', async (bad) => {
        await rejects(svc.createProspect({ caller: caller('V1'), data: input(), opId: bad }), 'invalid-argument');
      });

      test('data must be an object', async () => {
        for (const d of [null, undefined, 'x', [], 5]) await rejects(svc.createProspect({ caller: caller('V1'), data: d, opId: op() }), 'invalid-argument');
      });

      test('codes are sequential per year and never collide with a code left behind by a deleted opportunity', async () => {
        // existing 2026 codes 001, 002 (P1, P2 seeded in the year) + 005: count is 3 but the highest suffix is 5
        await env.seed('prospects_prod/PX', { id: 'PX', codigo: '202601005', clientId: 'C1', createdBy: P.V1.id, vendedorId: P.V1.id, fecha_creacion: '2026-02-01T00:00:00.000Z', logs: [] });
        await env.seed('prospects_prod/PY', { id: 'PY', codigo: '202512099', clientId: 'C1', createdBy: P.V1.id, vendedorId: P.V1.id, fecha_creacion: '2025-12-30T00:00:00.000Z', logs: [] });
        const codes = [];
        for (let i = 0; i < 3; i++) codes.push((await prospect((await svc.createProspect({ caller: caller('V1'), data: input(), opId: op() })).prospect.id)).codigo);
        expect(codes).toEqual(['202603006', '202603007', '202603008']);
      });

      test('the same opId retried returns the same opportunity and creates nothing new', async () => {
        const id = op();
        const a = await svc.createProspect({ caller: caller('V1'), data: input(), opId: id });
        const before = (await env.list('prospects_prod')).length;
        const b = await svc.createProspect({ caller: caller('V1'), data: input(), opId: id });
        expect(b).toMatchObject({ status: 'created', replay: true });
        expect(b.prospect).toEqual({ id: a.prospect.id, codigo: a.prospect.codigo });
        expect((await env.list('prospects_prod')).length).toBe(before);
        expect((await env.read('prospectCounters_prod/2026')).last).toBe(3);
      });

      test('an opId reused with different data, or by another user, is refused', async () => {
        const id = op();
        await svc.createProspect({ caller: caller('V1'), data: input(), opId: id });
        await rejects(svc.createProspect({ caller: caller('V1'), data: input({ proyecto: 'Otro' }), opId: id }), 'failed-precondition');
        await rejects(svc.createProspect({ caller: caller('V2'), data: input(), opId: id }), 'permission-denied');
      });

      test('concurrent creations get distinct ids and distinct sequential codes', async () => {
        const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => svc.createProspect({ caller: caller(i % 2 ? 'V1' : 'V2'), data: input({ proyecto: `P${i}` }), opId: op() })));
        const all = await Promise.all(rs.map(r => prospect(r.prospect.id)));
        expect(new Set(all.map(p => p.id)).size).toBe(8);
        expect(all.map(p => p.codigo).sort()).toEqual(['202603003', '202603004', '202603005', '202603006', '202603007', '202603008', '202603009', '202603010']);
      });

      test('the same opId sent concurrently creates exactly one opportunity', async () => {
        const id = op();
        const rs = await Promise.all(Array.from({ length: 5 }, () => svc.createProspect({ caller: caller('V1'), data: input(), opId: id })));
        expect(new Set(rs.map(r => r.prospect.id)).size).toBe(1);
        expect(rs.filter(r => !r.replay)).toHaveLength(1);
        expect((await env.list('prospects_prod')).length).toBe(3);
      });

      if (supportsFailureInjection) {
        test('a failure at commit leaves nothing behind (no opportunity, no counter, no operation) and the retry succeeds', async () => {
          const id = op();
          env.failNextCommit();
          await expect(svc.createProspect({ caller: caller('V1'), data: input(), opId: id })).rejects.toThrow(/injected/);
          expect((await env.list('prospects_prod')).length).toBe(2);
          expect(await env.read('prospectCounters_prod/2026')).toBeUndefined();
          expect(await env.list('prospectOps_prod')).toHaveLength(0);
          const r = await svc.createProspect({ caller: caller('V1'), data: input(), opId: id });
          expect(r.replay).toBeUndefined();
          expect((await prospect(r.prospect.id)).codigo).toBe('202603003');
        });
      }

      if (makeServiceWithFixedProspectId) {
        test('an id collision is resolved by moving to the next id, never by overwriting', async () => {
          const alt = makeServiceWithFixedProspectId();
          for (const k of ['V1']) await alt.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
          await alt.seed('clients_prod/C1', { id: 'C1', tipo: 'juridica', empresa: 'X', contacto: 'Y', telefono: '1', createdBy: P.V1.id });
          const a = await alt.service.createProspect({ caller: caller('V1'), data: input(), opId: op() });
          const b = await alt.service.createProspect({ caller: caller('V1'), data: input({ proyecto: 'Segundo' }), opId: op() });
          expect(a.prospect.id).toBe('1800000000000');
          expect(b.prospect.id).toBe('1800000000001');
          expect((await alt.list('prospects_prod')).map(p => p.proyecto).sort()).toEqual(['Segundo', 'Torre Norte']);
        });
      }
    });

    // ------------------------------------------------------------------------------------------------
    describe('addLog', () => {
      test('the owner adds a note; authorship is taken from the profile, the entry is a manual one', async () => {
        const r = await svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: '  Llamé al cliente  ', opId: op() });
        expect(r.status).toBe('added');
        const p = await prospect('P1');
        expect(p.logs).toHaveLength(3);
        expect(p.logs[0]).toEqual(AUTO_OLD);       // history preserved, in order
        expect(p.logs[1]).toEqual(MANUAL_OLD);
        expect(p.logs[2]).toMatchObject({ text: '(Vendedor Uno)  Llamé al cliente', auto: false, by: P.V1.id, byName: 'Vendedor Uno', date: env.now.toISOString() });
      });

      test('the assigned vendedor and manager / gestor may add notes; an unrelated vendedor may not', async () => {
        await svc.addLog({ caller: caller('V2'), prospectId: 'P2', text: 'asignado', opId: op() });
        await svc.addLog({ caller: caller('GES'), prospectId: 'P2', text: 'gestora creadora', opId: op() });
        await svc.addLog({ caller: caller('MGR'), prospectId: 'P1', text: 'gerente', opId: op() });
        await rejects(svc.addLog({ caller: caller('GES'), prospectId: 'P1', text: 'gestora intrusa', opId: op() }), 'permission-denied');
        await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'P2', text: 'intruso', opId: op() }), 'permission-denied');
        await rejects(svc.addLog({ caller: caller('V3'), prospectId: 'P1', text: 'intruso', opId: op() }), 'permission-denied');
        expect((await prospect('P2')).logs).toHaveLength(3);
        expect((await prospect('P1')).logs).toHaveLength(3);
      });

      test('unknown opportunity, empty / oversized / non-string note and bad ids are rejected', async () => {
        await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'NOPE', text: 'x', opId: op() }), 'not-found');
        for (const t of ['', '   ', undefined, 42, { a: 1 }, 'x'.repeat(2001)]) await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: t, opId: op() }), 'invalid-argument');
        await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'P1/x', text: 'x', opId: op() }), 'invalid-argument');
        await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'x', opId: 'short' }), 'invalid-argument');
        expect((await prospect('P1')).logs).toHaveLength(2);
      });

      test('a retry with the same opId does not duplicate the note; a different text under the same opId is refused', async () => {
        const id = op();
        await svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'una vez', opId: id });
        const again = await svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'una vez', opId: id });
        expect(again).toMatchObject({ status: 'added', replay: true });
        expect((await prospect('P1')).logs).toHaveLength(3);
        await rejects(svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'otro texto', opId: id }), 'failed-precondition');
        await rejects(svc.addLog({ caller: caller('MGR'), prospectId: 'P1', text: 'una vez', opId: id }), 'failed-precondition');
        expect((await prospect('P1')).logs).toHaveLength(3);
      });

      test('concurrent notes from different users are all kept; concurrent duplicates of one request produce one entry', async () => {
        await Promise.all([
          svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'a', opId: op() }),
          svc.addLog({ caller: caller('MGR'), prospectId: 'P1', text: 'b', opId: op() }),
          svc.addLog({ caller: caller('MGR'), prospectId: 'P1', text: 'c', opId: op() })
        ]);
        expect((await prospect('P1')).logs).toHaveLength(5);
        const id = op();
        await Promise.all(Array.from({ length: 4 }, () => svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'dup', opId: id })));
        expect((await prospect('P1')).logs.filter(l => l.opId === id)).toHaveLength(1);
      });

      test('only the log array changes: the rest of the opportunity is untouched', async () => {
        const before = await prospect('P1');
        await svc.addLog({ caller: caller('V1'), prospectId: 'P1', text: 'nota', opId: op() });
        const after = await prospect('P1');
        const { logs: _a, ...restBefore } = before; const { logs: _b, ...restAfter } = after;
        expect(restAfter).toEqual(restBefore);
      });
    });

    // ------------------------------------------------------------------------------------------------
    describe('deleteLog', () => {
      const noteOf = async (who, text = 'mi nota') => (await svc.addLog({ caller: caller(who), prospectId: 'P1', text, opId: op() })).entry;

      test('an author removes their own note and the removal is audited with the server identity', async () => {
        const e = await noteOf('V1');
        const r = await svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: e.date, text: e.text });
        expect(r.status).toBe('deleted');
        expect((await prospect('P1')).logs.some(l => l.opId === e.opId)).toBe(false);
        const a = await audit('deleteProspectLog');
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ actorCid: P.V1.id, actorUid: 'uid-v1', actorName: 'Vendedor Uno', actorRole: 'vendedor', targetId: 'P1' });
      });

      test('a vendedor cannot remove somebody else\'s note nor a historical one without a recorded author', async () => {
        const other = await noteOf('MGR', 'del gerente');
        await rejects(svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: other.date, text: other.text }), 'permission-denied');
        await rejects(svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: MANUAL_OLD.date, text: MANUAL_OLD.text }), 'permission-denied');
        expect((await prospect('P1')).logs).toHaveLength(3);
      });

      test('manager and gestor can remove any manual note, including historical ones', async () => {
        const mine = await noteOf('V1');
        expect((await svc.deleteLog({ caller: caller('MGR'), prospectId: 'P1', date: mine.date, text: mine.text })).status).toBe('deleted');
        expect((await svc.deleteLog({ caller: caller('MGR'), prospectId: 'P1', date: MANUAL_OLD.date, text: MANUAL_OLD.text })).status).toBe('deleted');
        expect((await prospect('P1')).logs).toEqual([AUTO_OLD]);
        // Gestor removes manual note on P2 (which gestor created)
        const noteP2 = (await svc.addLog({ caller: caller('GES'), prospectId: 'P2', text: 'nota gestora', opId: op() })).entry;
        expect((await svc.deleteLog({ caller: caller('GES'), prospectId: 'P2', date: noteP2.date, text: noteP2.text })).status).toBe('deleted');
      });

      test('automatic entries are never removable, whoever asks', async () => {
        for (const who of ['V1', 'MGR']) await rejects(svc.deleteLog({ caller: caller(who), prospectId: 'P1', date: AUTO_OLD.date, text: AUTO_OLD.text }), 'permission-denied');
        expect((await prospect('P1')).logs).toHaveLength(2);
        expect(await audit('deleteProspectLog')).toHaveLength(0);
      });

      test('an unrelated vendedor has no access; a note that is already gone answers "absent" (safe retry) and writes no audit', async () => {
        const e = await noteOf('V1');
        await rejects(svc.deleteLog({ caller: caller('V3'), prospectId: 'P1', date: e.date, text: e.text }), 'permission-denied');
        await svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: e.date, text: e.text });
        const again = await svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: e.date, text: e.text });
        expect(again.status).toBe('absent');
        expect(await audit('deleteProspectLog')).toHaveLength(1);
        await rejects(svc.deleteLog({ caller: caller('V1'), prospectId: 'NOPE', date: e.date, text: e.text }), 'not-found');
      });

      test('removal is by content, so a note added meanwhile shifts nothing', async () => {
        const e = await noteOf('V1', 'primera');
        await svc.addLog({ caller: caller('MGR'), prospectId: 'P1', text: 'llegó después', opId: op() });
        await svc.deleteLog({ caller: caller('V1'), prospectId: 'P1', date: e.date, text: e.text });
        const texts = (await prospect('P1')).logs.map(l => l.text);
        expect(texts.some(t => t.includes('primera'))).toBe(false);
        expect(texts.some(t => t.includes('llegó después'))).toBe(true);
      });
    });

    // ------------------------------------------------------------------------------------------------
    describe('reassign', () => {
      test('gestor and vendedor cannot reassign, even their own opportunity', async () => {
        await rejects(svc.reassign({ caller: caller('V1'), prospectId: 'P1', vendedorId: P.V3.id }), 'permission-denied');
        await rejects(svc.reassign({ caller: caller('GES'), prospectId: 'P1', vendedorId: P.V3.id }), 'permission-denied');
        expect((await prospect('P1')).vendedorId).toBe(P.V1.id);
      });

      test('manager reassigns: name / role come from the target profile, the author of the log from the session, createdBy is untouched', async () => {
        const r = await svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: P.V3.id });
        expect(r).toMatchObject({ status: 'reassigned', vendedorId: P.V3.id });
        const p = await prospect('P1');
        expect(p).toMatchObject({ createdBy: P.V1.id, vendedorId: P.V3.id, vendedorName: 'Vendedor Tres', vendedorRole: 'vendedor' });
        expect(p.logs[p.logs.length - 1].text).toContain('Vendedor reasignado');
        const a = await audit('reassignProspect');
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ actorCid: P.MGR.id, actorName: 'Gerente Alfa', detail: { from: P.V1.id, to: P.V3.id } });
      });

      test('repeating the request changes nothing and writes no second log or audit entry', async () => {
        await svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: P.V3.id });
        const again = await svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: P.V3.id });
        expect(again.status).toBe('unchanged');
        expect((await prospect('P1')).logs).toHaveLength(3);
        expect(await audit('reassignProspect')).toHaveLength(1);
      });

      test('concurrent identical requests produce exactly one reassignment', async () => {
        await Promise.all(Array.from({ length: 4 }, () => svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: P.V2.id })));
        expect((await prospect('P1')).logs).toHaveLength(3);
        expect(await audit('reassignProspect')).toHaveLength(1);
      });

      test('the target must be an active commercial user; unknown opportunity and malformed ids fail cleanly', async () => {
        for (const id of [P.INACT.id, P.PLANT.id, '1111111111111']) await rejects(svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: id }), 'invalid-argument');
        await rejects(svc.reassign({ caller: caller('MGR'), prospectId: 'NOPE', vendedorId: P.V3.id }), 'not-found');
        await rejects(svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: 'a/b' }), 'invalid-argument');
        await rejects(svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: undefined }), 'invalid-argument');
        expect((await prospect('P1')).vendedorId).toBe(P.V1.id);
      });

      test('a historical (not Auth-linked) user can receive an opportunity', async () => {
        await svc.reassign({ caller: caller('MGR'), prospectId: 'P1', vendedorId: P.HIST.id });
        expect((await prospect('P1')).vendedorId).toBe(P.HIST.id);
      });

      test('reassignment of a closed or postclosing opportunity is strictly forbidden, even for manager', async () => {
        await env.seed('prospects_prod/P_CLOSED', {
          id: 'P_CLOSED', codigo: '202601099', clientId: 'C1',
          createdBy: P.V1.id, vendedorId: P.V1.id, vendedorName: 'Vendedor Uno', vendedorRole: 'vendedor',
          fecha_creacion: '2026-01-01T00:00:00.000Z', etapa: 'cierre', estado: 'ganado',
          postcierre_habilitado: true, fecha_cierre: '2026-01-05T00:00:00.000Z',
          datos: {}, logs: [AUTO_OLD], facturas: []
        });
        await rejects(svc.reassign({ caller: caller('MGR'), prospectId: 'P_CLOSED', vendedorId: P.V2.id }), 'failed-precondition');
        expect((await prospect('P_CLOSED')).vendedorId).toBe(P.V1.id);
      });
    });

    // ------------------------------------------------------------------------------------------------
    describe('setNoContractAuthorization', () => {
      test('only a manager: gestor and vendedor are refused without even reaching the live Auth check', async () => {
        for (const who of ['GES', 'V1', 'V2']) await rejects(svc.setNoContractAuthorization({ caller: caller(who), prospectId: 'P1', authorized: true }), 'permission-denied');
        expect(env.live.calls).toEqual([]);
        expect((await prospect('P1')).datos.autorizado_sin_contrato).toBeUndefined();
        expect(await audit()).toHaveLength(0);
      });

      test('a manager profile whose Auth account is no longer a manager (stale token) is refused', async () => {
        env.live.ok = false;
        await rejects(svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true }), 'permission-denied');
        expect(env.live.calls).toEqual(['uid-mgr']);
        expect((await prospect('P1')).datos.autorizado_sin_contrato).toBeUndefined();
      });

      test('grants: the authoriser name and id come from the manager profile, other data is preserved, log and audit are written', async () => {
        const r = await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true });
        expect(r).toMatchObject({ status: 'updated', authorized: true, autorizado_por: 'Gerente Alfa' });
        const p = await prospect('P1');
        expect(p.datos).toEqual({ nota: 'conservar', autorizado_sin_contrato: true, autorizado_por: 'Gerente Alfa', autorizado_por_id: P.MGR.id });
        expect(p.logs[p.logs.length - 1].text).toBe(' Autorización de venta sin contrato otorgada por gerente: Gerente Alfa');
        const a = await audit('grantNoContractAuthorization');
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ actorCid: P.MGR.id, actorUid: 'uid-mgr', actorRole: 'manager', targetId: 'P1' });
      });

      test('revokes: flags are cleared, history is kept', async () => {
        await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true });
        const r = await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: false });
        expect(r).toMatchObject({ status: 'updated', authorized: false });
        const p = await prospect('P1');
        expect(p.datos).toEqual({ nota: 'conservar', autorizado_sin_contrato: false });
        expect(p.logs.map(l => l.text).filter(t => t.includes('sin contrato'))).toHaveLength(2);
        expect(await audit('revokeNoContractAuthorization')).toHaveLength(1);
      });

      test('repeating a request, also concurrently, changes nothing more', async () => {
        await Promise.all(Array.from({ length: 4 }, () => svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true })));
        const p = await prospect('P1');
        expect(p.logs.filter(l => l.text.includes('otorgada'))).toHaveLength(1);
        expect(await audit('grantNoContractAuthorization')).toHaveLength(1);
        expect((await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true })).status).toBe('unchanged');
      });

      test('`authorized` must be a boolean; unknown opportunity is not-found', async () => {
        for (const v of ['true', 1, null, undefined, {}]) await rejects(svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: v }), 'invalid-argument');
        await rejects(svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'NOPE', authorized: true }), 'not-found');
      });
    });

    // ------------------------------------------------------------------------------------------------
    // Request / resolve flow. State is stored on the opportunity (`solicitudes_sin_contrato`); the browser sends only the
    // reason (request) or the decision (resolve): identity, dates and the authorisation flags come from the session.
    describe('no-contract authorization: request and resolve', () => {
      const ask = (who = 'V1', o = {}) => svc.requestNoContractAuthorization({ caller: caller(who), prospectId: 'P1', motivo: 'Cliente de confianza, contrato en trámite', opId: op(), ...o });
      const resolve = (who, requestId, decision, o = {}) => svc.resolveNoContractAuthorization({ caller: caller(who), prospectId: 'P1', requestId, decision, motivoDecision: 'ok', ...o });
      const requests = async (id = 'P1') => (await prospect(id)).solicitudes_sin_contrato || [];
      const flagged = async () => (await prospect('P1')).datos.autorizado_sin_contrato;

      test('a vendedor with access requests: identity, date and state come from the server; the authorization is NOT granted; history and audit are written', async () => {
        const r = await ask('V1');
        expect(r.status).toBe('requested');
        const list = await requests();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          estado: 'pendiente', solicitante_id: P.V1.id, solicitante_nombre: 'Vendedor Uno', solicitante_rol: 'vendedor',
          fecha_solicitud: env.now.toISOString(), motivo: 'Cliente de confianza, contrato en trámite',
          resuelto_por_id: null, resuelto_por: null, fecha_resolucion: null, motivo_decision: null
        });
        expect(r.request).toMatchObject({ id: list[0].id, estado: 'pendiente' });
        expect(r.request.opId).toBeUndefined();
        expect(await flagged()).toBeUndefined();
        const p = await prospect('P1');
        expect(p.logs[p.logs.length - 1].text).toContain('Solicitud de autorización de venta sin contrato');
        expect((await audit('requestNoContractAuthorization'))[0]).toMatchObject({ actorCid: P.V1.id, actorRole: 'vendedor', targetId: 'P1', detail: { requestId: list[0].id } });
        expect(env.live.calls).toEqual([]); // no manager check is involved in asking
      });

      test('who may ask: vendedor / gestor with access to the opportunity; a manager decides directly; a stranger and a plant role are refused', async () => {
        await rejects(ask('MGR'), 'permission-denied');
        await rejects(ask('V3'), 'permission-denied');   // not creator nor assignee of P1
        await rejects(ask('PLANT'), 'permission-denied');
        await rejects(ask('GES'), 'permission-denied');   // gestor has no access to P1
        expect(await requests()).toHaveLength(0);
        // Gestor CAN ask on P2 (which GES created)
        expect((await ask('GES', { prospectId: 'P2' })).status).toBe('requested');
        expect((await requests('P2'))[0]).toMatchObject({ solicitante_id: P.GES.id, solicitante_rol: 'gestor' });
      });

      test('the reason is required (max 500) and the opId must be a plain token: nothing is written otherwise', async () => {
        for (const motivo of [undefined, '', '   ', 7, 'x'.repeat(501)]) await rejects(ask('V1', { motivo }), 'invalid-argument');
        for (const opId of [undefined, '', 'short', 'a/b/c/d/e/f', 12345678]) await rejects(ask('V1', { opId }), 'invalid-argument');
        expect(await requests()).toHaveLength(0);
        expect(await audit()).toHaveLength(0);
      });

      test('no duplicates: the same person repeating the same request is unchanged; another reason or another person is refused while one is pending', async () => {
        const first = await ask('V1');
        expect((await ask('V1')).status).toBe('unchanged');
        await rejects(ask('V1', { motivo: 'Otro motivo distinto' }), 'failed-precondition');
        await rejects(ask('V1', { motivo: 'Otro' }), 'failed-precondition');
        expect(await requests()).toHaveLength(1);
        expect((await requests())[0].id).toBe(first.request.id);
        expect(await audit('requestNoContractAuthorization')).toHaveLength(1);
      });

      test('idempotent opId: a retry returns the same request; the key cannot be reused with other data or by someone else', async () => {
        const key = op();
        const a = await ask('V1', { opId: key });
        const b = await ask('V1', { opId: key });
        expect(b).toMatchObject({ status: 'requested', replay: true });
        expect(b.request.id).toBe(a.request.id);
        await rejects(ask('V1', { opId: key, motivo: 'Distinto' }), 'failed-precondition');
        await rejects(ask('V1', { opId: key, motivo: 'Otro' }), 'failed-precondition');
        expect(await requests()).toHaveLength(1);
      });

      test('simultaneous requests (different opIds) leave exactly one pending request, one audit entry and one history line', async () => {
        const rs = await Promise.all(Array.from({ length: 5 }, () => ask('V1')));
        expect(rs.filter(r => r.status === 'requested')).toHaveLength(1);
        expect(rs.filter(r => r.status === 'unchanged')).toHaveLength(4);
        expect(await requests()).toHaveLength(1);
        expect(await audit('requestNoContractAuthorization')).toHaveLength(1);
        expect((await prospect('P1')).logs.filter(l => /Solicitud de autorización/.test(l.text))).toHaveLength(1);
      });

      test('refused when the opportunity is not active or the exception is already stored', async () => {
        await env.seed('prospects_prod/P3', { id: 'P3', codigo: '202601003', clientId: 'C1', createdBy: P.V1.id, vendedorId: P.V1.id, estado: 'perdido', datos: {}, logs: [], facturas: [] });
        await rejects(svc.requestNoContractAuthorization({ caller: caller('V1'), prospectId: 'P3', motivo: 'x', opId: op() }), 'failed-precondition');
        await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true });
        await rejects(ask('V1'), 'failed-precondition');
        expect(await requests()).toHaveLength(0);
      });

      test('only a manager verified live resolves: gestor, the requester and a stale manager token are refused and nothing changes', async () => {
        const { request } = await ask('V1');
        for (const who of ['GES', 'V1', 'V2']) await rejects(resolve(who, request.id, 'approve'), 'permission-denied');
        expect(env.live.calls).toEqual([]);
        env.live.ok = false;
        await rejects(resolve('MGR', request.id, 'approve'), 'permission-denied');
        expect((await requests())[0].estado).toBe('pendiente');
        expect(await flagged()).toBeUndefined();
        expect(await audit('approveNoContractRequest')).toHaveLength(0);
      });

      test('the manager approves: request resolved with who / when / why, the stored authorization is written exactly as the direct decision does, audited', async () => {
        const { request } = await ask('V1');
        const r = await resolve('MGR', request.id, 'approve', { motivoDecision: 'Cliente conocido' });
        expect(r.status).toBe('approved');
        const p = await prospect('P1');
        expect(p.solicitudes_sin_contrato[0]).toMatchObject({ estado: 'aprobada', resuelto_por_id: P.MGR.id, resuelto_por: 'Gerente Alfa', fecha_resolucion: env.now.toISOString(), motivo_decision: 'Cliente conocido', solicitante_id: P.V1.id });
        expect(p.datos).toEqual({ nota: 'conservar', autorizado_sin_contrato: true, autorizado_por: 'Gerente Alfa', autorizado_por_id: P.MGR.id });
        expect(p.logs[p.logs.length - 1].text).toContain('APROBADA');
        expect((await audit('approveNoContractRequest'))[0]).toMatchObject({ actorCid: P.MGR.id, actorUid: 'uid-mgr', actorRole: 'manager', detail: { requestId: request.id, solicitanteId: P.V1.id, motivoDecision: 'Cliente conocido' } });
      });

      test('the manager rejects: the reason is required, the authorization is NOT written, and the seller may ask again afterwards', async () => {
        const { request } = await ask('V1');
        for (const motivoDecision of [undefined, '', '  ']) await rejects(resolve('MGR', request.id, 'reject', { motivoDecision }), 'invalid-argument');
        expect((await requests())[0].estado).toBe('pendiente');
        const r = await resolve('MGR', request.id, 'reject', { motivoDecision: 'Falta el contrato' });
        expect(r.status).toBe('rejected');
        expect((await requests())[0]).toMatchObject({ estado: 'rechazada', resuelto_por_id: P.MGR.id, motivo_decision: 'Falta el contrato' });
        expect(await flagged()).toBeUndefined();
        expect(await audit('rejectNoContractRequest')).toHaveLength(1);
        const again = await ask('V1', { motivo: 'Ahora con la oferta firmada' });
        expect(again.status).toBe('requested');
        expect(await requests()).toHaveLength(2);
      });

      test('nobody resolves their own request (even a legacy request created by a manager)', async () => {
        await env.seed('prospects_prod/P1', { ...(await prospect('P1')), solicitudes_sin_contrato: [{ id: 'R9', estado: 'pendiente', solicitante_id: P.MGR.id, solicitante_nombre: 'Gerente Alfa', fecha_solicitud: '2026-01-01T00:00:00.000Z', motivo: 'm', resuelto_por_id: null, resuelto_por: null, fecha_resolucion: null, motivo_decision: null }] });
        await rejects(resolve('MGR', 'R9', 'approve'), 'permission-denied');
        expect(await flagged()).toBeUndefined();
      });

      test('repeated or simultaneous approvals: one transition, one audit entry, one history line; a contradictory decision is refused', async () => {
        const { request } = await ask('V1');
        const rs = await Promise.all(Array.from({ length: 4 }, () => resolve('MGR', request.id, 'approve')));
        expect(rs.filter(r => r.status === 'approved')).toHaveLength(1);
        expect(rs.filter(r => r.status === 'unchanged')).toHaveLength(3);
        expect((await resolve('MGR', request.id, 'approve')).status).toBe('unchanged');
        await rejects(resolve('MGR', request.id, 'reject', { motivoDecision: 'tarde' }), 'failed-precondition');
        expect(await audit('approveNoContractRequest')).toHaveLength(1);
        expect(await audit('rejectNoContractRequest')).toHaveLength(0);
        expect((await prospect('P1')).logs.filter(l => /APROBADA/.test(l.text))).toHaveLength(1);
        expect((await requests())[0].estado).toBe('aprobada');
      });

      test('simultaneous approve and reject: exactly one wins and the stored authorization agrees with it', async () => {
        const { request } = await ask('V1');
        const rs = await Promise.allSettled([resolve('MGR', request.id, 'approve'), resolve('MGR', request.id, 'reject', { motivoDecision: 'no' })]);
        expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = rs.find(r => r.status === 'rejected');
        expect(rejected.reason.code).toBe('failed-precondition');
        const st = (await requests())[0].estado;
        expect(await flagged()).toBe(st === 'aprobada' ? true : undefined);
        expect(await audit()).toHaveLength(2); // the request + exactly one resolution
      });

      test('unknown request, malformed ids and unknown decision fail cleanly', async () => {
        await ask('V1');
        await rejects(resolve('MGR', 'NOPE', 'approve'), 'not-found');
        await rejects(resolve('MGR', 'a/b', 'approve'), 'invalid-argument');
        for (const d of ['APPROVE', 'yes', undefined, true]) await rejects(resolve('MGR', (await requests())[0].id, d), 'invalid-argument');
        await rejects(svc.resolveNoContractAuthorization({ caller: caller('MGR'), prospectId: 'NOPE', requestId: 'R1', decision: 'approve' }), 'not-found');
        expect((await requests())[0].estado).toBe('pendiente');
      });

      test('approving needs an active opportunity; a pending request on a lost one can still be rejected', async () => {
        const { request } = await ask('V1');
        await env.seed('prospects_prod/P1', { ...(await prospect('P1')), estado: 'perdido' });
        await rejects(resolve('MGR', request.id, 'approve'), 'failed-precondition');
        expect(await flagged()).toBeUndefined();
        expect((await resolve('MGR', request.id, 'reject', { motivoDecision: 'Perdida' })).status).toBe('rejected');
      });

      test('the direct decision of a manager settles the history: granting approves the pending request, revoking marks the approved one as revoked', async () => {
        const { request } = await ask('V1');
        await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: true });
        expect((await requests())[0]).toMatchObject({ id: request.id, estado: 'aprobada', resuelto_por_id: P.MGR.id, motivo_decision: 'Autorización directa del gerente' });
        await svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'P1', authorized: false });
        expect((await requests())[0]).toMatchObject({ estado: 'revocada', resuelto_por_id: P.MGR.id });
        expect(await flagged()).toBe(false);
        await rejects(resolve('MGR', request.id, 'approve'), 'failed-precondition'); // a revoked request is not resolvable again
      });

      test('a vendedor cannot write the authorization through any request field: extra arguments are ignored', async () => {
        await svc.requestNoContractAuthorization({ caller: caller('V1'), prospectId: 'P1', motivo: 'm', opId: op(), authorized: true, autorizado_sin_contrato: true, datos: { autorizado_sin_contrato: true }, estado: 'aprobada', solicitante_id: P.MGR.id, resuelto_por: 'Gerente Alfa' });
        expect(await flagged()).toBeUndefined();
        expect((await requests())[0]).toMatchObject({ estado: 'pendiente', solicitante_id: P.V1.id, resuelto_por: null });
      });
    });

    // ------------------------------------------------------------------------------------------------
    // A logically deleted opportunity (`eliminado: true`) is out of reach of every ordinary commercial operation.
    describe('logically deleted opportunity', () => {
      beforeEach(async () => {
        await env.seed('prospects_prod/PD', { id: 'PD', codigo: '202601099', clientId: 'C1', createdBy: P.V1.id, vendedorId: P.V1.id, estado: 'activo', datos: {}, logs: [MANUAL_OLD], facturas: [], eliminado: true, eliminado_por_id: P.MGR.id, eliminado_por: 'Gerente Alfa', fecha_eliminacion: '2026-02-01T00:00:00.000Z', motivo_eliminacion: 'Duplicado', solicitudes_sin_contrato: [{ id: 'R1', estado: 'pendiente', solicitante_id: P.V1.id, motivo: 'm' }] });
      });
      test('notes, reassignment, direct authorization, request and resolution are all refused as not-found and write nothing', async () => {
        const before = await prospect('PD');
        const runs = [
          () => svc.addLog({ caller: caller('V1'), prospectId: 'PD', text: 'nota', opId: op() }),
          () => svc.deleteLog({ caller: caller('V1'), prospectId: 'PD', date: MANUAL_OLD.date, text: MANUAL_OLD.text.trim() }),
          () => svc.reassign({ caller: caller('MGR'), prospectId: 'PD', vendedorId: P.V3.id }),
          () => svc.setNoContractAuthorization({ caller: caller('MGR'), prospectId: 'PD', authorized: true }),
          () => svc.requestNoContractAuthorization({ caller: caller('V1'), prospectId: 'PD', motivo: 'x', opId: op() }),
          () => svc.resolveNoContractAuthorization({ caller: caller('MGR'), prospectId: 'PD', requestId: 'R1', decision: 'approve' })
        ];
        for (const run of runs) await rejects(run(), 'not-found');
        expect(await prospect('PD')).toEqual(before);
        expect(await audit()).toHaveLength(0);
      });
    });

    // ------------------------------------------------------------------------------------------------
    describe('updateSettings', () => {
      const SHARED = { visitantes: ['Ana'], encargados: [], factory_address: '', colores_pintura: ['Rojo'], tipos_base: ['A'], maquinas: [{ name: 'M1' }], usbs: [{ name: 'U1', color: '#fff' }], meta_diaria_piezas: 144 };
      beforeEach(async () => { await env.seed('system_prod/settings', SHARED); });
      const doc = () => env.read('system_prod/settings');

      test('only a manager (confirmed live) may change settings', async () => {
        for (const who of ['GES', 'V1']) await rejects(svc.updateSettings({ caller: caller(who), action: 'addItem', list: 'visitantes', value: 'Beto' }), 'permission-denied');
        env.live.ok = false;
        await rejects(svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'visitantes', value: 'Beto' }), 'permission-denied');
        expect(await doc()).toEqual(SHARED);
        expect(await audit()).toHaveLength(0);
      });

      test('adds and removes by value; fields owned by fabricacion are never touched', async () => {
        await svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'visitantes', value: ' Beto ' });
        await svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'encargados', value: 'Carla' });
        let d = await doc();
        expect(d.visitantes).toEqual(['Ana', 'Beto']);
        expect(d.encargados).toEqual(['Carla']);
        await svc.updateSettings({ caller: caller('MGR'), action: 'removeItem', list: 'visitantes', value: 'Ana' });
        d = await doc();
        expect(d.visitantes).toEqual(['Beto']);
        const { visitantes: _v, encargados: _e, ...rest } = d; const { visitantes: _v2, encargados: _e2, ...restShared } = SHARED;
        expect(rest).toEqual(restShared);
        expect((await audit('updateSettings')).length).toBe(3);
      });

      test('duplicates and removals of absent items are no-ops without audit; the factory address is trimmed', async () => {
        expect((await svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'visitantes', value: 'Ana' })).status).toBe('unchanged');
        expect((await svc.updateSettings({ caller: caller('MGR'), action: 'removeItem', list: 'visitantes', value: 'Nadie' })).status).toBe('unchanged');
        expect(await audit()).toHaveLength(0);
        const r = await svc.updateSettings({ caller: caller('MGR'), action: 'setFactoryAddress', value: '  Calle Principal, San Salvador ' });
        expect(r.status).toBe('updated');
        expect((await doc()).factory_address).toBe('Calle Principal, San Salvador');
        expect((await svc.updateSettings({ caller: caller('MGR'), action: 'setFactoryAddress', value: 'Calle Principal, San Salvador' })).status).toBe('unchanged');
      });

      test('the returned view contains only CRM-owned fields', async () => {
        const r = await svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'visitantes', value: 'Beto' });
        expect(Object.keys(r.settings).sort()).toEqual(['encargados', 'factory_address', 'visitantes']);
      });

      test('fabricacion lists, unknown actions and malformed values are rejected', async () => {
        const bad = [
          { action: 'addItem', list: 'maquinas', value: 'X' }, { action: 'addItem', list: 'usbs', value: 'X' }, { action: 'addItem', list: '__proto__', value: 'X' },
          { action: 'addItem', list: 'visitantes', value: '' }, { action: 'addItem', list: 'visitantes', value: 5 }, { action: 'addItem', list: 'visitantes', value: 'x'.repeat(121) },
          { action: 'replaceAll', list: 'visitantes', value: 'x' }, { action: undefined }, { action: 'setFactoryAddress', value: 7 }, { action: 'setFactoryAddress', value: 'x'.repeat(301) }
        ];
        for (const b of bad) await rejects(svc.updateSettings({ caller: caller('MGR'), ...b }), 'invalid-argument');
        expect(await doc()).toEqual(SHARED);
      });

      test('concurrent additions are all kept (no lost update) and a missing document is created', async () => {
        await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(v => svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'visitantes', value: v })));
        expect((await doc()).visitantes.slice().sort()).toEqual(['Ana', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
        await env.clear();
        for (const k of Object.keys(P)) await env.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
        await svc.updateSettings({ caller: caller('MGR'), action: 'addItem', list: 'encargados', value: 'Primero' });
        expect(await doc()).toEqual({ encargados: ['Primero'] });
      });
    });

    // ------------------------------------------------------------------------------------------------
    describe('deleteClient', () => {
      test('only a manager (confirmed live)', async () => {
        for (const who of ['GES', 'V1']) await rejects(svc.deleteClient({ caller: caller(who), clientId: 'C2' }), 'permission-denied');
        env.live.ok = false;
        await rejects(svc.deleteClient({ caller: caller('MGR'), clientId: 'C2' }), 'permission-denied');
        expect(await env.read('clients_prod/C2')).toBeDefined();
      });

      test('refused while the client has opportunities; nothing is deleted', async () => {
        await rejects(svc.deleteClient({ caller: caller('MGR'), clientId: 'C1' }), 'failed-precondition');
        expect(await env.read('clients_prod/C1')).toBeDefined();
        expect(await env.read('clientIdentifiers_prod/NIT_06141234561234')).toBeDefined();
        expect(await env.list('audit_logs_prod')).toHaveLength(0);
      });

      test('deletes the client and the identifier entries it owns; audit entry carries the server identity', async () => {
        await env.seed('clients_prod/C3', { id: 'C3', tipo: 'juridica', empresa: 'Sin Proyectos SA', contacto: 'Z', telefono: '1', nit: '0614-999999-999-9', createdBy: P.V1.id });
        await env.seed('clientIdentifiers_prod/NIT_06149999999999', { key: 'NIT_06149999999999', kind: 'NIT', clientId: 'C3' });
        const r = await svc.deleteClient({ caller: caller('MGR'), clientId: 'C3' });
        expect(r).toEqual({ status: 'deleted', releasedIdentifiers: 1 });
        expect(await env.read('clients_prod/C3')).toBeUndefined();
        expect(await env.read('clientIdentifiers_prod/NIT_06149999999999')).toBeUndefined();
        expect(await env.read('clientIdentifiers_prod/NIT_06141234561234')).toBeDefined(); // another client's entry
        const a = await env.list('audit_logs_prod');
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ usuario: 'Gerente Alfa', usuarioId: P.MGR.id, usuarioUid: 'uid-mgr', item: 'Cliente', proyectoNombre: 'Sin Proyectos SA', source: 'callable' });
      });

      test('an index entry that belongs to another client is not released', async () => {
        await env.seed('clients_prod/C3', { id: 'C3', tipo: 'juridica', empresa: 'Sin Proyectos SA', contacto: 'Z', telefono: '1', nit: '0614-999999-999-9', createdBy: P.V1.id });
        await env.seed('clientIdentifiers_prod/NIT_06149999999999', { key: 'NIT_06149999999999', kind: 'NIT', clientId: 'C9' });
        const r = await svc.deleteClient({ caller: caller('MGR'), clientId: 'C3' });
        expect(r.releasedIdentifiers).toBe(0);
        expect(await env.read('clientIdentifiers_prod/NIT_06149999999999')).toBeDefined();
      });

      test('a repeated delete answers "absent" and writes no second audit entry; malformed id is rejected', async () => {
        await env.seed('clients_prod/C3', { id: 'C3', tipo: 'juridica', empresa: 'Sin Proyectos SA', contacto: 'Z', telefono: '1', createdBy: P.V1.id });
        await svc.deleteClient({ caller: caller('MGR'), clientId: 'C3' });
        expect((await svc.deleteClient({ caller: caller('MGR'), clientId: 'C3' })).status).toBe('absent');
        expect(await env.list('audit_logs_prod')).toHaveLength(1);
        await rejects(svc.deleteClient({ caller: caller('MGR'), clientId: 'a/b' }), 'invalid-argument');
      });

      test('racing a delete against the creation of an opportunity never leaves an opportunity pointing at a deleted client', async () => {
        for (let i = 0; i < 12; i++) {
          await env.clear();
          for (const k of Object.keys(P)) await env.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
          await env.seed('clients_prod/CR', { id: 'CR', tipo: 'juridica', empresa: 'Carrera SA', contacto: 'Z', telefono: '1', createdBy: P.V1.id });
          const del = () => svc.deleteClient({ caller: caller('MGR'), clientId: 'CR' }).then(r => ({ r }), e => ({ e }));
          const mk = () => svc.createProspect({ caller: caller('V1'), data: input({ clientId: 'CR' }), opId: op() }).then(r => ({ r }), e => ({ e }));
          const [a, b] = await Promise.all(i % 2 ? [del(), mk()] : [mk(), del()]);
          const client = await env.read('clients_prod/CR');
          const prospects = (await env.list('prospects_prod')).filter(p => p.clientId === 'CR');
          expect(!client && prospects.length > 0).toBe(false); // the invariant
          if (client) expect([a, b].some(x => x.e && x.e.code === 'failed-precondition')).toBe(true);
          else expect([a, b].some(x => x.e && x.e.code === 'not-found')).toBe(true);
        }
      });
    });
  });
}

module.exports = { defineCommercialSuite, P, caller };
