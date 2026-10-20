// functions/test-helpers/workflowSuite.js
// Behavioural suite of the opportunity workflow (functions/prospectWorkflowService.js), written against an abstract
// environment so the SAME assertions run on the in-memory Firestore (unit layer) and on the real isolated Firestore
// emulator (isolated-tests/prospectWorkflow.iso.js). Environment: { wf, live, now, seed, read, list, clear }.
// Not a test file itself (lives outside __tests__): it only registers describe/test blocks when called.

const { P, caller } = require('./commercialSuite');

const URLP = 'https://firebasestorage.googleapis.com/v0/b/demo/o/';
const file = n => ({ name: n, url: `${URLP}${n}?alt=media` });
const MANUAL_OLD = { text: '(Ana)  nota vieja', date: '2026-01-01T00:00:00.000Z', auto: false };
const AUTO_OLD = { text: ' Prospecto creado por Ana', date: '2026-01-01T00:00:00.000Z', auto: true };

async function rejects(promise, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.code).toBe(code);
  return err;
}

let opN = 0;
const op = () => `wop-${String(++opN).padStart(10, '0')}`;

function defineWorkflowSuite({ label, makeEnv }) {
  describe(`opportunity workflow: ${label}`, () => {
    let env; let wf;
    const prospect = id => env.read(`prospects_prod/${id}`);
    const audit = async action => (await env.list('commercialAudit_prod')).filter(a => !action || a.action === action);
    const notices = () => env.list('audit_logs_prod');

    const CLIENT_OK = { id: 'CW', tipo: 'juridica', empresa: 'Industrias Delta', contacto: 'Ana', nit: '0614-1', nrc: '1-2', telefono: '7000', correo: 'a@b.c', correo_fact: 'f@b.c', documentos: { dui: file('dui.pdf'), escritura: file('e.pdf'), credencial: file('c.pdf'), nit: file('n.pdf'), nrc: file('r.pdf') } };
    // Opportunity at a given stage. `etapa` / `estado` / extra fields overridable.
    const opp = (o = {}) => ({
      id: 'W1', codigo: '202601010', clientId: 'CW', createdBy: P.V1.id, vendedorId: P.V1.id, estado: 'activo', etapa: 'prospecto', tipo_proyecto: 'Nuevo',
      precio_cotizado: 10000, costo_venta: 6000, datos: { nota: 'conservar' }, logs: [AUTO_OLD, MANUAL_OLD], facturas: [], ordenes_cambio: [], documentos: {},
      stage_timestamps: { prospecto: '2026-01-01T00:00:00.000Z' }, ...o
    });
    // A won project: advance invoice F1 for 70% of 10000 + 13% VAT = 7910. Remaining to invoice: 3390.
    const won = (o = {}) => opp({
      etapa: 'cierre', estado: 'ganado',
      facturas: [{ id: 'F1', numero: 'A-1', monto: 7910, pagos: [], fecha: '2026-02-01T00:00:00.000Z' }], ...o
    });
    const put = async (o) => env.seed(`prospects_prod/${o.id}`, o);

    beforeAll(() => { env = makeEnv(); wf = env.wf; });
    beforeEach(async () => {
      await env.clear();
      for (const k of Object.keys(P)) await env.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
      await env.seed('clients_prod/CW', CLIENT_OK);
      await env.seed('clients_prod/CX', { ...CLIENT_OK, id: 'CX', es_exportacion: true });
      await env.seed('clients_prod/CG', { ...CLIENT_OK, id: 'CG', is_gran_contribuyente: true });
    });

    // ----------------------------------------------------------------------------------------------
    describe('access and authorization (all operations)', () => {
      const OPS = {
        advanceStage: () => wf.advanceStage({ caller: caller('V2'), prospectId: 'W1', nextStage: 'levantamiento', data: { visitante: 'x', distancia: 1 } }),
        markLost: () => wf.markLost({ caller: caller('V2'), prospectId: 'W1', reason: 'Precio' }),
        editBasePrice: () => wf.editBasePrice({ caller: caller('V2'), prospectId: 'W1', precio: 1, costo: 1, motivo: 'x' }),
        saveInvoice: () => wf.saveInvoice({ caller: caller('V2'), prospectId: 'W1', numero: 'B', monto: 1, doc_factura: file('f.pdf'), opId: op() }),
        savePayment: () => wf.savePayment({ caller: caller('V2'), prospectId: 'W1', invoiceId: 'F1', monto: 1, metodo: 'cheque', ref: 'r', doc_comprobante: file('c.pdf'), opId: op() }),
        saveChangeOrder: () => wf.saveChangeOrder({ caller: caller('V2'), prospectId: 'W1', tipo: 'aumento', desc: 'd', precio: 1, costo: 1, opId: op() }),
        deleteInvoice: () => wf.deleteInvoice({ caller: caller('V2'), prospectId: 'W1', invoiceId: 'F1' }),
        deletePayment: () => wf.deletePayment({ caller: caller('V2'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'k' }),
        deleteChangeOrder: () => wf.deleteChangeOrder({ caller: caller('V2'), prospectId: 'W1', orderId: 'O1' })
      };
      test('a vendedor who neither created nor owns the opportunity is refused on every operation, and nothing is written', async () => {
        await put(won());
        const before = await prospect('W1');
        for (const [name, run] of Object.entries(OPS)) await rejects(run(), 'permission-denied');
        expect(await prospect('W1')).toEqual(before);
        expect(await audit()).toHaveLength(0);
      });
      test('even the creator/owner vendedor is refused on postclosing operations (saveInvoice, savePayment, saveChangeOrder, deleteInvoice, deletePayment, deleteChangeOrder)', async () => {
        await put(won());
        const POST_OPS = {
          saveInvoice: () => wf.saveInvoice({ caller: caller('V1'), prospectId: 'W1', numero: 'B', monto: 1, doc_factura: file('f.pdf'), opId: op() }),
          savePayment: () => wf.savePayment({ caller: caller('V1'), prospectId: 'W1', invoiceId: 'F1', monto: 1, metodo: 'cheque', ref: 'r', doc_comprobante: file('c.pdf'), opId: op() }),
          saveChangeOrder: () => wf.saveChangeOrder({ caller: caller('V1'), prospectId: 'W1', tipo: 'aumento', desc: 'd', precio: 1, costo: 1, opId: op() }),
          deleteInvoice: () => wf.deleteInvoice({ caller: caller('V1'), prospectId: 'W1', invoiceId: 'F1' }),
          deletePayment: () => wf.deletePayment({ caller: caller('V1'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'k' }),
          deleteChangeOrder: () => wf.deleteChangeOrder({ caller: caller('V1'), prospectId: 'W1', orderId: 'O1' })
        };
        for (const [name, run] of Object.entries(POST_OPS)) await rejects(run(), 'permission-denied');
      });
      test('a plant role (operario) cannot use the commercial workflow, even if it is the creator', async () => {
        await put(won({ createdBy: P.PLANT.id }));
        await rejects(wf.editBasePrice({ caller: caller('PLANT'), prospectId: 'W1', precio: 1, costo: 1, motivo: 'x' }), 'permission-denied');
        await rejects(wf.markLost({ caller: caller('PLANT'), prospectId: 'W1', reason: 'Precio' }), 'permission-denied');
      });
      test('creator, assignee, gestor and manager are accepted where the policy allows them (the base price is NOT one of them for a vendedor)', async () => {
        await put(opp({ createdBy: P.GES.id, vendedorId: P.V2.id }));
        for (const who of ['GES', 'MGR']) {
          const r = await wf.editBasePrice({ caller: caller(who), prospectId: 'W1', precio: 10000 + audit.length, costo: 6000 + (who === 'GES' ? 2 : 3), motivo: 'ok' });
          expect(['updated', 'unchanged']).toContain(r.status);
        }
        await rejects(wf.editBasePrice({ caller: caller('V2'), prospectId: 'W1', precio: 1, costo: 1, motivo: 'x' }), 'permission-denied');
        // The assignee keeps the rest of the workflow.
        const adv = await wf.advanceStage({ caller: caller('V2'), prospectId: 'W1', nextStage: 'levantamiento', data: { visitante: 'x', distancia: 1 } });
        expect(adv.status).toBe('advanced');
        expect((await prospect('W1')).logs.length).toBeGreaterThan(2);
      });
      test('an unknown opportunity is not-found', async () => {
        await rejects(wf.markLost({ caller: caller('MGR'), prospectId: 'NOPE', reason: 'Precio' }), 'not-found');
      });
      test('malformed identifiers are rejected before reading anything', async () => {
        await rejects(wf.markLost({ caller: caller('MGR'), prospectId: '../x', reason: 'Precio' }), 'invalid-argument');
        await rejects(wf.markLost({ caller: caller('MGR'), prospectId: undefined, reason: 'Precio' }), 'invalid-argument');
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('advanceStage', () => {
      const LEV = { visitante: 'Luis', fecha_inicio: '2026-04-01', ubicacion: 'San Salvador', distancia: 12, fecha_visita: '2026-03-20', doc_levantamiento: [file('lev.pdf')] };
      const COT = { costo_venta: 6500, precio_cotizado: 11000, probabilidad: 'alta', doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')] };
      const CIE = { forma_pago: '70/30', factura_anticipo: 'FAC-1', encargado: 'Pedro', doc_firmado: file('firmado.pdf'), doc_comprobante: file('comp.pdf') };

      test('prospecto -> levantamiento stores the survey data, a timestamp and an automatic log; notes written meanwhile survive', async () => {
        await put(opp());
        const r = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: LEV });
        expect(r).toMatchObject({ status: 'advanced', etapa: 'levantamiento', estado: 'activo' });
        const p = await prospect('W1');
        expect(p.etapa).toBe('levantamiento');
        expect(p.datos).toMatchObject({ nota: 'conservar', visitante: 'Luis', fecha_inicio: '2026-04-01', ubicacion: 'San Salvador', distancia: '12', fecha_visita: '2026-03-20', doc_levantamiento: [file('lev.pdf')] });
        expect(p.stage_timestamps.levantamiento).toBe(env.now.toISOString());
        expect(p.stage_timestamps.prospecto).toBe('2026-01-01T00:00:00.000Z');
        expect(p.logs).toHaveLength(3);
        expect(p.logs[0]).toEqual(AUTO_OLD);
        expect(p.logs[1]).toEqual(MANUAL_OLD);
        expect(p.logs[2]).toMatchObject({ auto: true });
        expect(p.logs[2].text).toContain('Avanzó a etapa: levantamiento');
        const a = await audit('advanceStage');
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ actorCid: P.V1.id, actorUid: 'uid-v1', actorRole: 'vendedor', targetId: 'W1', detail: { from: 'prospecto', to: 'levantamiento' } });
      });

      test('levantamiento needs who visited; distance is required unless the project is manufacturing-only', async () => {
        await put(opp());
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { ...LEV, visitante: '  ' } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { ...LEV, distancia: undefined } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { ...LEV, distancia: -3 } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { ...LEV, fecha_inicio: 'mañana' } }), 'invalid-argument');
        expect((await prospect('W1')).etapa).toBe('prospecto');
        await put(opp({ tipo_proyecto: 'Fabricación' }));
        const r = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { visitante: 'Luis' } });
        expect(r.status).toBe('advanced');
      });

      test('stages advance one at a time: skipping, going back and jumping to cierre are refused', async () => {
        await put(opp());
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: COT }), 'failed-precondition');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE }), 'failed-precondition');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'prospecto', data: {} }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'inventada', data: {} }), 'invalid-argument');
        await put(opp({ etapa: 'cotizacion' }));
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: LEV }), 'failed-precondition');
        expect((await prospect('W1')).etapa).toBe('cotizacion');
      });

      test('a retry / double click on a stage already reached answers unchanged and adds no log', async () => {
        await put(opp());
        await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: LEV });
        const r = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: LEV });
        expect(r.status).toBe('unchanged');
        expect((await prospect('W1')).logs).toHaveLength(3);
        expect(await audit('advanceStage')).toHaveLength(1);
      });

      test('only active opportunities advance (lost and won are refused)', async () => {
        await put(opp({ estado: 'perdido', etapa: 'levantamiento' }));
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: COT }), 'failed-precondition');
      });

      test('cotizacion requires offer AND cost sheet (new or previous), a probability and non-negative money', async () => {
        await put(opp({ etapa: 'levantamiento' }));
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: { ...COT, doc_costos: [] } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: { ...COT, probabilidad: 'segura' } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: { ...COT, precio_cotizado: '11000' } }), 'invalid-argument');
        await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: { ...COT, costo_venta: -1 } }), 'invalid-argument');
        const r = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: COT });
        expect(r.status).toBe('advanced');
        const p = await prospect('W1');
        expect(p).toMatchObject({ etapa: 'cotizacion', costo_venta: 6500, precio_cotizado: 11000, probabilidad: 75 });
        expect(p.logs[p.logs.length - 1].text).toContain('Cotizado');
        // negociacion may reuse the documents already stored.
        const r2 = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'negociacion', data: { costo_venta: 6500, precio_cotizado: 10500, probabilidad: 'media' } });
        expect(r2.status).toBe('advanced');
        expect(await prospect('W1')).toMatchObject({ etapa: 'negociacion', precio_cotizado: 10500, probabilidad: 50 });
      });

      test('a document that is not a Firebase Storage link is refused', async () => {
        await put(opp({ etapa: 'levantamiento' }));
        for (const bad of [{ name: 'x', url: 'javascript:alert(1)' }, { name: 'x', url: 'https://evil.example/x.pdf' }, { name: '', url: `${URLP}x` }, 'texto']) {
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cotizacion', data: { ...COT, doc_oferta: [bad] } }), 'invalid-argument');
        }
      });

      test('fields that are not part of the stage (estado, flags, owner, invoices, logs) are ignored', async () => {
        await put(opp());
        await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'levantamiento', data: { ...LEV, estado: 'ganado', createdBy: P.MGR.id, vendedorId: P.MGR.id, facturas: [{ id: 'x', monto: 1e9 }], logs: [], autorizado_sin_contrato: true, datos: { autorizado_sin_contrato: true } } });
        const p = await prospect('W1');
        expect(p).toMatchObject({ estado: 'activo', createdBy: P.V1.id, vendedorId: P.V1.id, facturas: [] });
        expect(p.datos.autorizado_sin_contrato).toBeUndefined();
        expect(p.logs).toHaveLength(3);
      });

      describe('cierre', () => {
        const negociacion = (o = {}) => opp({ etapa: 'negociacion', tipo_proyecto: 'Fabricación e instalación', datos: { doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')] }, ...o });

        test('closes the sale: won, 100%, advance invoice with 13% VAT times the payment form, contract document, no client-supplied amounts', async () => {
          await put(negociacion({ precio_cotizado: 10000, costo_venta: 6000 }));
          const r = await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, monto: 1, estado: 'activo' } });
          expect(r).toMatchObject({ status: 'advanced', etapa: 'cierre', estado: 'ganado' });
          const p = await prospect('W1');
          expect(p).toMatchObject({ estado: 'ganado', etapa: 'cierre', probabilidad: 100, forma_pago: '70/30', encargado: 'Pedro', fecha_cierre: env.now.toISOString() });
          expect(p.facturas).toHaveLength(1);
          expect(p.facturas[0]).toMatchObject({ numero: 'FAC-1', monto: 7910, pagos: [], doc_factura: file('comp.pdf') });
          expect(p.datos.doc_oferta_firmada).toEqual(file('firmado.pdf')); // exactly 10,000 is not "large" (rule is > 10,000)
          expect(p.datos.doc_contrato).toBeUndefined();
          expect(p.datos.doc_comprobante).toEqual(file('comp.pdf'));
          expect(p.logs[p.logs.length - 1].text).toContain('VENTA CERRADA');
          expect((await audit('closeSale'))).toHaveLength(1);
        });

        test('payment forms: 100% anticipado and 50/50; unknown form refused', async () => {
          await put(negociacion());
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, forma_pago: '10/90' } }), 'invalid-argument');
          await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, forma_pago: '100% anticipado' } });
          expect((await prospect('W1')).facturas[0].monto).toBe(11300);
          await put(negociacion());
          await env.seed('prospects_prod/W1', negociacion());
          await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, forma_pago: '50/50' } });
          expect((await prospect('W1')).facturas[0].monto).toBe(5650);
        });

        test('an export client pays no VAT', async () => {
          await put(negociacion({ clientId: 'CX' }));
          await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, forma_pago: '100% anticipado' } });
          expect((await prospect('W1')).facturas[0].monto).toBe(10000);
        });

        test('refused when the client record is incomplete or the DUI document is missing', async () => {
          await put(negociacion());
          await env.seed('clients_prod/CW', { ...CLIENT_OK, correo_fact: '', nrc: '' });
          const e = await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE }), 'failed-precondition');
          expect(e.message).toMatch(/Correo para Facturación/);
          expect(e.message).toMatch(/NRC/);
          const { dui: _dui, ...docsWithoutDui } = CLIENT_OK.documentos;
          await env.seed('clients_prod/CW', { ...CLIENT_OK, documentos: docsWithoutDui }); // the real Admin SDK rejects `undefined` values
          const e2 = await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE }), 'failed-precondition');
          expect(e2.message).toMatch(/DUI/);
          expect((await prospect('W1')).estado).toBe('activo');
        });

        test('a large manufacturing + installation project needs the legal documents unless a manager authorization is STORED; the request cannot claim it', async () => {
          await put(negociacion({ precio_cotizado: 20000 }));
          await env.seed('clients_prod/CW', { ...CLIENT_OK, documentos: { dui: file('dui.pdf') } });
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, autorizado_sin_contrato: true, datos: { autorizado_sin_contrato: true } } }), 'failed-precondition');
          // The authorization is a stored fact written by setNoContractAuthorization.
          await put(negociacion({ precio_cotizado: 20000, datos: { doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')], autorizado_sin_contrato: true, autorizado_por: 'Gerente Alfa' } }));
          await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE });
          const p = await prospect('W1');
          expect(p.estado).toBe('ganado');
          expect(p.datos.doc_oferta_firmada).toEqual(file('firmado.pdf'));
          expect(p.datos.doc_contrato).toBeUndefined();
          expect(p.datos.autorizado_por).toBe('Gerente Alfa');
          expect(p.logs[p.logs.length - 1].text).toContain('VENTA CERRADA');
        });

        test('a small project, or one that is not manufacturing + installation, does not need the legal documents; the installer is required only for installations', async () => {
          await env.seed('clients_prod/CW', { ...CLIENT_OK, documentos: { dui: file('dui.pdf') } });
          await put(negociacion({ tipo_proyecto: 'Nuevo', precio_cotizado: 50000 }));
          await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, encargado: undefined } });
          expect((await prospect('W1')).estado).toBe('ganado');
          await put(negociacion({ precio_cotizado: 500 }));
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, encargado: '' } }), 'invalid-argument');
        });

        test('closing needs the signed document and the advance proof', async () => {
          await put(negociacion());
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, doc_firmado: undefined } }), 'invalid-argument');
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, doc_comprobante: undefined } }), 'invalid-argument');
          await rejects(wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: { ...CIE, factura_anticipo: ' ' } }), 'invalid-argument');
        });

        test('closing twice produces exactly one invoice and one closing log', async () => {
          await put(negociacion());
          const [a, b] = await Promise.all([
            wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE }),
            wf.advanceStage({ caller: caller('MGR'), prospectId: 'W1', nextStage: 'cierre', data: CIE })
          ]);
          expect([a.status, b.status].sort()).toEqual(['advanced', 'unchanged']);
          const p = await prospect('W1');
          expect(p.facturas).toHaveLength(1);
          expect(p.logs.filter(l => /VENTA CERRADA/.test(l.text))).toHaveLength(1);
          expect(await audit('closeSale')).toHaveLength(1);
        });
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('markLost', () => {
      test('marks an active opportunity as lost with a valid reason; logs and audit come from the server', async () => {
        await put(opp({ etapa: 'negociacion' }));
        const r = await wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Precio' });
        expect(r.status).toBe('lost');
        const p = await prospect('W1');
        expect(p).toMatchObject({ estado: 'perdido', motivo_perdida: 'Precio', fecha_perdida: env.now.toISOString(), etapa: 'negociacion' });
        expect(p.logs).toHaveLength(3);
        expect(p.logs[2].text).toContain('PERDIDO');
        expect((await audit('markLost'))[0]).toMatchObject({ actorCid: P.V1.id, detail: { reason: 'Precio', etapa: 'negociacion' } });
      });
      test('an unknown reason is refused; the reasons of the page are the only accepted ones', async () => {
        await put(opp());
        await rejects(wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Porque sí' }), 'invalid-argument');
        await rejects(wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: undefined }), 'invalid-argument');
        for (const m of ['Falta de seguimiento', 'No se cumplían los requerimientos técnicos', 'Tiempo de entrega', 'Cliente desiste']) {
          await put(opp());
          expect((await wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: m })).status).toBe('lost');
        }
      });
      test('retry with the same reason is unchanged; a different reason after losing is refused; a won project cannot be lost', async () => {
        await put(opp());
        await wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Precio' });
        expect((await wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Precio' })).status).toBe('unchanged');
        await rejects(wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Cliente desiste' }), 'failed-precondition');
        expect((await prospect('W1')).logs).toHaveLength(3);
        await put(won());
        await rejects(wf.markLost({ caller: caller('V1'), prospectId: 'W1', reason: 'Precio' }), 'failed-precondition');
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('registerProposal and editBasePrice', () => {
      test('a new proposal replaces price, cost and documents of an active opportunity in negociacion and logs it', async () => {
        await put(opp({ etapa: 'negociacion', datos: { nota: 'conservar', doc_oferta: [file('old.pdf')], doc_costos: [file('oldc.pdf')] } }));
        const r = await wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', costo_venta: 7000, precio_cotizado: 12000, doc_oferta: [file('new.pdf')], doc_costos: [file('newc.pdf')] });
        expect(r.status).toBe('registered');
        const p = await prospect('W1');
        expect(p).toMatchObject({ precio_cotizado: 12000, costo_venta: 7000, datos: { nota: 'conservar', doc_oferta: [file('new.pdf')], doc_costos: [file('newc.pdf')] } });
        expect(p.logs[p.logs.length - 1].text).toContain('NUEVA PROPUESTA');
        expect((await audit('registerProposal'))[0].detail).toMatchObject({ precioFrom: 10000, precioTo: 12000, costoFrom: 6000, costoTo: 7000 });
        expect((await wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', costo_venta: 7000, precio_cotizado: 12000, doc_oferta: [file('new.pdf')], doc_costos: [file('newc.pdf')] })).status).toBe('unchanged');
        expect((await prospect('W1')).logs).toHaveLength(p.logs.length);
      });
      test('refused outside negociacion/activo or without both documents or with invalid money', async () => {
        const ok = { costo_venta: 1, precio_cotizado: 2, doc_oferta: [file('a.pdf')], doc_costos: [file('b.pdf')] };
        await put(opp({ etapa: 'cotizacion' }));
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok }), 'failed-precondition');
        await put(opp({ etapa: 'negociacion', estado: 'perdido' }));
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok }), 'failed-precondition');
        await put(opp({ etapa: 'negociacion' }));
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok, doc_costos: [] }), 'invalid-argument');
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok, doc_oferta: undefined }), 'invalid-argument');
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok, precio_cotizado: NaN }), 'invalid-argument');
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok, costo_venta: -5 }), 'invalid-argument');
        await rejects(wf.registerProposal({ caller: caller('V1'), prospectId: 'W1', ...ok, precio_cotizado: 2e9 }), 'invalid-argument');
      });
      // ---- Base price / cost: approved decision (manager and gestor only, only before the closing) ----
      const editBase = (who, o = {}) => wf.editBasePrice({ caller: caller(who), prospectId: 'W1', precio: 9000, costo: 5000, motivo: 'Error de captura', ...o });
      const CIE_BASE = { forma_pago: '70/30', factura_anticipo: 'FAC-1', encargado: 'Pedro', doc_firmado: file('firmado.pdf'), doc_comprobante: file('comp.pdf') };
      const toClose = (o = {}) => opp({ etapa: 'negociacion', tipo_proyecto: 'Fabricación e instalación', datos: { doc_oferta: [file('of.pdf')], doc_costos: [file('co.pdf')] }, ...o });

      test('editBasePrice by gestor / manager needs a reason, records old and new values and who, and a repeat is unchanged', async () => {
        await put(opp({ etapa: 'negociacion', createdBy: P.GES.id }));
        await rejects(editBase('GES', { motivo: '' }), 'invalid-argument');
        await rejects(editBase('GES', { precio: -1, motivo: 'x' }), 'invalid-argument');
        const r = await editBase('GES');
        expect(r.status).toBe('updated');
        const p = await prospect('W1');
        expect(p).toMatchObject({ precio_cotizado: 9000, costo_venta: 5000 });
        expect(p.logs[p.logs.length - 1].text).toContain('Error de captura');
        expect((await audit('editBasePrice')).find(a => a.actorRole === 'gestor')).toMatchObject({ actorCid: P.GES.id, actorRole: 'gestor', detail: { precioFrom: 10000, precioTo: 9000, costoFrom: 6000, costoTo: 5000, motivo: 'Error de captura' } });
        expect((await editBase('GES')).status).toBe('unchanged');
        expect((await editBase('MGR', { precio: 9500, costo: 5200 })).status).toBe('updated');
        expect((await audit('editBasePrice')).find(a => a.actorRole === 'manager')).toMatchObject({ actorCid: P.MGR.id, actorRole: 'manager' });
      });

      test('a vendedor cannot edit the base price, not even on an opportunity they created and own; nothing is written', async () => {
        await put(opp());
        const before = await prospect('W1');
        await rejects(editBase('V1'), 'permission-denied');
        await rejects(editBase('PLANT'), 'permission-denied');
        expect(await prospect('W1')).toEqual(before);
        expect(await audit()).toHaveLength(0);
      });

      test('refused after the closing or the loss: the STORED state decides, whatever the interface believed or sent', async () => {
        for (const stored of [won({ createdBy: P.GES.id }), opp({ etapa: 'negociacion', estado: 'perdido', motivo_perdida: 'Precio', createdBy: P.GES.id })]) {
          await put(stored);
          const before = await prospect('W1');
          for (const who of ['MGR', 'GES']) {
            const e = await rejects(editBase(who, { estado: 'activo', etapa: 'negociacion' }), 'failed-precondition'); // extra fields from the page are ignored
            expect(e.message).toMatch(/antes del cierre/);
          }
          expect(await prospect('W1')).toEqual(before);
        }
        expect(await audit()).toHaveLength(0);
      });

      test('effect on quotes and advances: before the closing the corrected price is the one the advance invoice is computed from; after it the edit is refused, so existing invoices are never recomputed', async () => {
        await put(toClose({ precio_cotizado: 10000, costo_venta: 6000, createdBy: P.GES.id, vendedorId: P.V1.id }));
        await editBase('GES', { precio: 8000, costo: 5000 });
        await wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE_BASE });
        const closed = await prospect('W1');
        expect(closed.estado).toBe('ganado');
        expect(closed.facturas[0].monto).toBe(6328); // 8000 x 1.13 x 70 %, NOT the original 10000 (7910)
        await rejects(editBase('MGR', { precio: 20000 }), 'failed-precondition');
        const after = await prospect('W1');
        expect(after.precio_cotizado).toBe(8000);
        expect(after.facturas).toEqual(closed.facturas);
      });

      test('an edit racing with the closing: the advance invoice always matches the stored price (either the edit came first, or it was refused)', async () => {
        await put(toClose({ precio_cotizado: 10000, costo_venta: 6000 }));
        const [e, c] = await Promise.allSettled([
          editBase('MGR', { precio: 8000, costo: 5000 }),
          wf.advanceStage({ caller: caller('V1'), prospectId: 'W1', nextStage: 'cierre', data: CIE_BASE })
        ]);
        expect(c.status).toBe('fulfilled');
        const p = await prospect('W1');
        expect(p.estado).toBe('ganado');
        expect(p.facturas).toHaveLength(1);
        expect(p.facturas[0].monto).toBe(Math.round(p.precio_cotizado * 1.13 * 0.7 * 100) / 100);
        if (e.status === 'rejected') expect(e.reason.code).toBe('failed-precondition');
        else expect(p.precio_cotizado).toBe(8000);
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('change orders', () => {
      const CO = { tipo: 'aumento', desc: 'Ducto adicional', precio: 1000, costo: 600 };
      test('requires a won project; creates with generated id, documents indexed under the project documents', async () => {
        await put(opp({ etapa: 'negociacion', createdBy: P.GES.id }));
        await rejects(wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, opId: op() }), 'failed-precondition');
        await put(won());
        const r = await wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, doc_oferta: file('o.pdf'), doc_costos: file('c.pdf'), opId: op() });
        expect(r.status).toBe('created');
        const p = await prospect('W1');
        expect(p.ordenes_cambio).toHaveLength(1);
        const o = p.ordenes_cambio[0];
        expect(o).toMatchObject({ tipo: 'aumento', desc: 'Ducto adicional', precio: 1000, costo: 600, doc_oferta: file('o.pdf') });
        expect(p.documentos[`oc_${o.id}_oferta`]).toEqual(file('o.pdf'));
        expect(p.documentos[`oc_${o.id}_costos`]).toEqual(file('c.pdf'));
        expect(p.logs[p.logs.length - 1].text).toContain('Orden de Cambio (AUMENTO)');
        expect(await audit('createChangeOrder')).toHaveLength(1);
      });
      test('retrying a creation with the same opId does not duplicate; the same opId with other data is refused', async () => {
        await put(won());
        const id = op();
        await wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, opId: id });
        expect((await wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, opId: id })).replay).toBe(true);
        await rejects(wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, precio: 5, opId: id }), 'failed-precondition');
        expect((await prospect('W1')).ordenes_cambio).toHaveLength(1);
      });
      test('validates type, description, money and attachments', async () => {
        await put(won());
        const run = o => wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', ...CO, opId: op(), ...o });
        await rejects(run({ tipo: 'regalo' }), 'invalid-argument');
        await rejects(run({ desc: '' }), 'invalid-argument');
        await rejects(run({ precio: -1 }), 'invalid-argument');
        await rejects(run({ costo: 'x' }), 'invalid-argument');
        await rejects(run({ doc_oferta: { name: 'x', url: 'https://evil.example/x' } }), 'invalid-argument');
        await rejects(run({ opId: 'x' }), 'invalid-argument');
      });
      test('edits by id (not by position), keeps untouched fields and documents; an unknown id is not-found; identical edit is unchanged', async () => {
        await put(won({ ordenes_cambio: [{ id: 'O1', tipo: 'aumento', desc: 'a', precio: 100, costo: 50, doc_oferta: file('o1.pdf') }, { id: 'O2', tipo: 'disminucion', desc: 'b', precio: 10, costo: 5 }] }));
        const r = await wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', orderId: 'O2', tipo: 'disminucion', desc: 'b2', precio: 20, costo: 5 });
        expect(r.status).toBe('updated');
        const p = await prospect('W1');
        expect(p.ordenes_cambio[0]).toMatchObject({ id: 'O1', desc: 'a', doc_oferta: file('o1.pdf') });
        expect(p.ordenes_cambio[1]).toMatchObject({ id: 'O2', desc: 'b2', precio: 20 });
        await rejects(wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', orderId: 'ZZ', tipo: 'aumento', desc: 'x', precio: 1, costo: 1 }), 'not-found');
        expect((await wf.saveChangeOrder({ caller: caller('GES'), prospectId: 'W1', orderId: 'O2', tipo: 'disminucion', desc: 'b2', precio: 20, costo: 5 })).status).toBe('unchanged');
        expect(await audit('editChangeOrder')).toHaveLength(1);
      });
      test('deleting removes only that order, writes the audit and the panel notice with the real identity; repeating is absent', async () => {
        await put(won({ ordenes_cambio: [{ id: 'O1', tipo: 'aumento', desc: 'a', precio: 100, costo: 50 }, { id: 'O2', tipo: 'aumento', desc: 'b', precio: 10, costo: 5 }] }));
        const r = await wf.deleteChangeOrder({ caller: caller('GES'), prospectId: 'W1', orderId: 'O1' });
        expect(r.status).toBe('deleted');
        expect((await prospect('W1')).ordenes_cambio.map(o => o.id)).toEqual(['O2']);
        expect((await audit('deleteChangeOrder'))[0]).toMatchObject({ actorCid: P.GES.id, detail: { orderId: 'O1' } });
        const n = await notices();
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ usuario: 'Gestora Gamma', usuarioId: P.GES.id, usuarioUid: 'uid-ges', proyectoId: 'W1', proyectoNombre: 'Industrias Delta', item: 'Orden de Cambio', source: 'callable' });
        expect((await wf.deleteChangeOrder({ caller: caller('GES'), prospectId: 'W1', orderId: 'O1' })).status).toBe('absent');
        expect(await notices()).toHaveLength(1);
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('invoices', () => {
      const INV = n => ({ numero: n, monto: 1000, doc_factura: file(`${n}.pdf`) });
      test('creates an invoice within the remaining balance (13% VAT, change orders counted); the document is required', async () => {
        await put(won());
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'B', monto: 1000, opId: op() }), 'invalid-argument');
        const r = await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-1'), opId: op() });
        expect(r.status).toBe('created');
        const p = await prospect('W1');
        expect(p.facturas).toHaveLength(2);
        expect(p.facturas[1]).toMatchObject({ numero: 'B-1', monto: 1000, pagos: [], doc_factura: file('B-1.pdf') });
        expect(p.logs[p.logs.length - 1].text).toContain('Factura/CCF emitida');
        expect(await audit('createInvoice')).toHaveLength(1);
      });
      test('refuses what exceeds the balance (tolerance 0.10); an increase order raises the ceiling; an export client has no VAT', async () => {
        await put(won());
        const e = await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'X', monto: 3390.2, doc_factura: file('x.pdf'), opId: op() }), 'failed-precondition');
        expect(e.message).toMatch(/excede el saldo/);
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'X', monto: 3390.1, doc_factura: file('x.pdf'), opId: op() })).status).toBe('created');
        await put(won({ ordenes_cambio: [{ id: 'O1', tipo: 'aumento', desc: 'a', precio: 1000, costo: 1 }] }));
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'Y', monto: 4520, doc_factura: file('y.pdf'), opId: op() })).status).toBe('created');
        await put(won({ clientId: 'CX', facturas: [{ id: 'F1', numero: 'A-1', monto: 7000, pagos: [] }] }));
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'Z', monto: 3000.5, doc_factura: file('z.pdf'), opId: op() }), 'failed-precondition');
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'Z', monto: 3000, doc_factura: file('z.pdf'), opId: op() })).status).toBe('created');
      });
      test('a decrease order lowers the ceiling', async () => {
        await put(won({ ordenes_cambio: [{ id: 'O1', tipo: 'disminucion', desc: 'a', precio: 1000, costo: 1 }] }));
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'X', monto: 2300, doc_factura: file('x.pdf'), opId: op() }), 'failed-precondition');
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'X', monto: 2260, doc_factura: file('x.pdf'), opId: op() })).status).toBe('created');
      });
      test('same opId does not duplicate; money must be positive; requires won', async () => {
        await put(won());
        const id = op();
        await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-1'), opId: id });
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-1'), opId: id })).replay).toBe(true);
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-1'), monto: 5, opId: id }), 'failed-precondition');
        expect((await prospect('W1')).facturas).toHaveLength(2);
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-2'), monto: 0, opId: op() }), 'invalid-argument');
        await put(opp({ createdBy: P.GES.id }));
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', ...INV('B-3'), opId: op() }), 'failed-precondition');
      });
      test('two simultaneous invoices that fit alone but not together: exactly one is accepted', async () => {
        await put(won());
        const res = await Promise.allSettled([
          wf.saveInvoice({ caller: caller('MGR'), prospectId: 'W1', numero: 'P1', monto: 2000, doc_factura: file('p1.pdf'), opId: op() }),
          wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', numero: 'P2', monto: 2000, doc_factura: file('p2.pdf'), opId: op() })
        ]);
        expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(res.filter(r => r.status === 'rejected')[0].reason.code).toBe('failed-precondition');
        expect((await prospect('W1')).facturas).toHaveLength(2);
      });
      test('edits an invoice by id keeping its payments; the advance invoice stays editable; unknown id is not-found', async () => {
        await put(won({ facturas: [{ id: 'F1', numero: 'A-1', monto: 7910, pagos: [{ id: 'PA', monto: 100, metodo: 'cheque', ref: 'r', fecha: 'd' }], fecha: 'x' }] }));
        const r = await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', numero: 'A-1b', monto: 8000 });
        expect(r.status).toBe('updated');
        expect((await prospect('W1')).facturas[0]).toMatchObject({ id: 'F1', numero: 'A-1b', monto: 8000, pagos: [{ id: 'PA', monto: 100 }] });
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'NOPE', numero: 'a', monto: 1 }), 'not-found');
        await rejects(wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', numero: 'a', monto: 12000 }), 'failed-precondition');
        expect((await wf.saveInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', numero: 'A-1b', monto: 8000 })).status).toBe('unchanged');
      });
      test('the first (advance) invoice cannot be deleted; others can, with audit and panel notice; repeating is absent', async () => {
        await put(won({ facturas: [{ id: 'F1', numero: 'A-1', monto: 7910, pagos: [] }, { id: 'F2', numero: 'A-2', monto: 100, pagos: [{ id: 'q', monto: 10 }] }] }));
        await rejects(wf.deleteInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1' }), 'failed-precondition');
        expect((await wf.deleteInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F2' })).status).toBe('deleted');
        expect((await prospect('W1')).facturas.map(f => f.id)).toEqual(['F1']);
        expect((await audit('deleteInvoice'))[0].detail).toMatchObject({ invoiceId: 'F2', payments: 1 });
        expect((await notices())[0]).toMatchObject({ item: 'Factura', usuarioId: P.GES.id });
        expect((await wf.deleteInvoice({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F2' })).status).toBe('absent');
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('payments', () => {
      const PAY = { monto: 1000, metodo: 'transferencia', ref: 'REF-1', doc_comprobante: file('pago.pdf') };
      test('registers a payment on an invoice with generated id; proof is required', async () => {
        await put(won());
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, doc_comprobante: undefined, opId: op() }), 'invalid-argument');
        const r = await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, opId: op() });
        expect(r.status).toBe('created');
        const p = await prospect('W1');
        expect(p.facturas[0].pagos).toHaveLength(1);
        expect(p.facturas[0].pagos[0]).toMatchObject({ monto: 1000, metodo: 'transferencia', ref: 'REF-1', doc_comprobante: file('pago.pdf') });
        expect(p.logs[p.logs.length - 1].text).toContain('Pago recibido');
        expect(await audit('createPayment')).toHaveLength(1);
      });
      test('refuses a payment above the pending balance of the invoice (tolerance 0.10) and an unknown invoice / method', async () => {
        await put(won());
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 7910.2, opId: op() }), 'failed-precondition');
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'NOPE', ...PAY, opId: op() }), 'not-found');
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, metodo: 'efectivo', opId: op() }), 'invalid-argument');
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 0, opId: op() }), 'invalid-argument');
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, ref: '', opId: op() }), 'invalid-argument');
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 7910.1, opId: op() })).status).toBe('created');
      });
      test('the 1% retention exists only for large-taxpayer clients', async () => {
        await put(won());
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, metodo: 'retencion_1pct', opId: op() }), 'failed-precondition');
        await put(won({ clientId: 'CG' }));
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, metodo: 'retencion_1pct', opId: op() })).status).toBe('created');
      });
      test('same opId does not duplicate the payment; other data with that opId is refused', async () => {
        await put(won());
        const id = op();
        await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, opId: id });
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, opId: id })).replay).toBe(true);
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 5, opId: id }), 'failed-precondition');
        expect((await prospect('W1')).facturas[0].pagos).toHaveLength(1);
      });
      test('two simultaneous payments that exceed the balance together: exactly one is accepted', async () => {
        await put(won());
        const res = await Promise.allSettled([
          wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 5000, opId: op() }),
          wf.savePayment({ caller: caller('MGR'), prospectId: 'W1', invoiceId: 'F1', ...PAY, monto: 5000, opId: op() })
        ]);
        expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect((await prospect('W1')).facturas[0].pagos).toHaveLength(1);
      });
      test('edits and deletes by key (id, or fecha for historical payments), never by position', async () => {
        await put(won({ facturas: [{ id: 'F1', numero: 'A-1', monto: 7910, pagos: [{ monto: 100, metodo: 'cheque', ref: 'old', fecha: '2026-02-02T00:00:00.000Z' }, { id: 'P2', monto: 200, metodo: 'cheque', ref: 'new', fecha: '2026-02-03T00:00:00.000Z' }] }] }));
        // Edit the historical payment by its fecha.
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: '2026-02-02T00:00:00.000Z', monto: 150, metodo: 'cheque', ref: 'old2' })).status).toBe('updated');
        let p = await prospect('W1');
        expect(p.facturas[0].pagos.map(x => x.monto)).toEqual([150, 200]);
        expect(p.facturas[0].pagos[0].ref).toBe('old2');
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'NOPE', monto: 1, metodo: 'cheque', ref: 'r' }), 'not-found');
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'P2', monto: 200, metodo: 'cheque', ref: 'new' })).status).toBe('unchanged');
        // A stale client that thinks the payment is at position 0 cannot delete the wrong one: only the key counts.
        expect((await wf.deletePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'P2' })).status).toBe('deleted');
        p = await prospect('W1');
        expect(p.facturas[0].pagos).toHaveLength(1);
        expect(p.facturas[0].pagos[0].ref).toBe('old2');
        expect((await wf.deletePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'P2' })).status).toBe('absent');
        expect((await audit('deletePayment'))[0]).toMatchObject({ actorCid: P.GES.id, detail: { invoiceId: 'F1', monto: 200 } });
        expect((await notices()).filter(n => n.item === 'Abono')).toHaveLength(1);
        await rejects(wf.deletePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'NOPE', paymentKey: 'P2' }), 'not-found');
      });
      test('an edit that would exceed the balance is refused; it does not count the payment being edited twice', async () => {
        await put(won({ facturas: [{ id: 'F1', numero: 'A-1', monto: 1000, pagos: [{ id: 'P1', monto: 600, metodo: 'cheque', ref: 'a', fecha: 'd1' }, { id: 'P2', monto: 400, metodo: 'cheque', ref: 'b', fecha: 'd2' }] }] }));
        await rejects(wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'P1', monto: 700, metodo: 'cheque', ref: 'a' }), 'failed-precondition');
        expect((await wf.savePayment({ caller: caller('GES'), prospectId: 'W1', invoiceId: 'F1', paymentKey: 'P1', monto: 600.05, metodo: 'cheque', ref: 'a2' })).status).toBe('updated');
      });
    });

    // ----------------------------------------------------------------------------------------------
    describe('deleteProspect (logical deletion)', () => {
      const del = (who, o = {}) => wf.deleteProspect({ caller: caller(who), prospectId: 'W1', motivo: 'Duplicado', ...o });
      test('only a manager verified live; gestor, vendedor and a manager whose Auth account no longer qualifies are refused', async () => {
        await put(opp());
        await rejects(del('GES'), 'permission-denied');
        await rejects(del('V1'), 'permission-denied');
        env.live.ok = false;
        await rejects(del('MGR'), 'permission-denied');
        const p = await prospect('W1');
        expect(p.eliminado).toBeUndefined();
        expect(await audit()).toHaveLength(0);
        expect(await notices()).toHaveLength(0);
      });
      test('marks the opportunity (who, when, why), keeps every other field, writes the audit and the manager panel notice with the authenticated identity', async () => {
        await put(won({ ordenes_cambio: [{ id: 'O1', tipo: 'aumento', precio: 5 }] }));
        const before = await prospect('W1');
        const r = await del('MGR', { motivo: 'Proyecto duplicado' });
        expect(r.status).toBe('deleted');
        const p = await prospect('W1');
        expect(p).toBeDefined(); // NOT removed
        expect(p).toMatchObject({ eliminado: true, eliminado_por_id: P.MGR.id, eliminado_por: 'Gerente Alfa', fecha_eliminacion: env.now.toISOString(), motivo_eliminacion: 'Proyecto duplicado' });
        const { logs: _l, eliminado: _e, eliminado_por_id: _i, eliminado_por: _n, fecha_eliminacion: _f, motivo_eliminacion: _m, ...rest } = p;
        const { logs: _bl, ...beforeRest } = before;
        expect(rest).toEqual(beforeRest); // invoices, change orders, data, owner, client: untouched
        expect(p.logs[p.logs.length - 1].text).toContain('Proyecto duplicado');
        expect((await audit('deleteProspect'))[0]).toMatchObject({ actorCid: P.MGR.id, actorUid: 'uid-mgr', targetId: 'W1', detail: { logical: true, motivo: 'Proyecto duplicado', codigo: '202601010', clientId: 'CW' } });
        const n = await notices();
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ usuario: 'Gerente Alfa', usuarioId: P.MGR.id, item: 'Proyecto', proyectoNombre: 'Industrias Delta', source: 'callable' });
        expect(n[0].detalle).toContain('Proyecto duplicado');
      });
      test('the reason is required and nothing is written without it', async () => {
        await put(opp());
        for (const motivo of [undefined, '', '   ', 5, 'x'.repeat(301)]) await rejects(del('MGR', { motivo }), 'invalid-argument');
        expect((await prospect('W1')).eliminado).toBeUndefined();
        expect(await audit()).toHaveLength(0);
      });
      test('repeating or racing is idempotent: one mark, one audit, one notice; the first author and reason stay', async () => {
        await put(opp());
        const rs = await Promise.all([del('MGR', { motivo: 'Primero' }), del('MGR', { motivo: 'Segundo' }), del('MGR', { motivo: 'Tercero' })]);
        expect(rs.map(r => r.status).sort()).toEqual(['deleted', 'unchanged', 'unchanged']);
        expect((await del('MGR', { motivo: 'Cuarto' })).status).toBe('unchanged');
        expect(await audit('deleteProspect')).toHaveLength(1);
        expect(await notices()).toHaveLength(1);
        const p = await prospect('W1');
        expect(p.logs.filter(l => /ELIMINADA/.test(l.text))).toHaveLength(1);
        expect(p.motivo_eliminacion).toBe((await audit('deleteProspect'))[0].detail.motivo);
      });
      test('an opportunity that does not exist answers absent and writes nothing', async () => {
        expect((await wf.deleteProspect({ caller: caller('MGR'), prospectId: 'NOPE', motivo: 'x' })).status).toBe('absent');
        expect(await audit()).toHaveLength(0);
      });
      test('once deleted, NO ordinary operation can modify it (even for the manager): not-found, document and audit unchanged', async () => {
        await put(won());
        await del('MGR');
        const before = await prospect('W1');
        const auditBefore = (await audit()).length;
        const base = { prospectId: 'W1' };
        const m = caller('MGR');
        const runs = {
          advanceStage: () => wf.advanceStage({ caller: m, ...base, nextStage: 'levantamiento', data: { visitante: 'x', distancia: 1 } }),
          markLost: () => wf.markLost({ caller: m, ...base, reason: 'Precio' }),
          registerProposal: () => wf.registerProposal({ caller: m, ...base, costo_venta: 1, precio_cotizado: 2, doc_oferta: [file('a.pdf')], doc_costos: [file('b.pdf')] }),
          editBasePrice: () => wf.editBasePrice({ caller: m, ...base, precio: 1, costo: 1, motivo: 'x' }),
          saveChangeOrder: () => wf.saveChangeOrder({ caller: m, ...base, tipo: 'aumento', desc: 'd', precio: 1, costo: 1, opId: op() }),
          deleteChangeOrder: () => wf.deleteChangeOrder({ caller: m, ...base, orderId: 'O1' }),
          saveInvoice: () => wf.saveInvoice({ caller: m, ...base, numero: 'B', monto: 1, doc_factura: file('f.pdf'), opId: op() }),
          deleteInvoice: () => wf.deleteInvoice({ caller: m, ...base, invoiceId: 'F1' }),
          savePayment: () => wf.savePayment({ caller: m, ...base, invoiceId: 'F1', monto: 1, metodo: 'cheque', ref: 'r', doc_comprobante: file('c.pdf'), opId: op() }),
          deletePayment: () => wf.deletePayment({ caller: m, ...base, invoiceId: 'F1', paymentKey: 'k' })
        };
        for (const [name, run] of Object.entries(runs)) {
          const e = await rejects(run(), 'not-found');
          expect(e.message).toMatch(/eliminada/);
          expect(name).toBeTruthy();
        }
        expect(await prospect('W1')).toEqual(before);
        expect(await audit()).toHaveLength(auditBefore);
      });
      test('does not touch the client, the invoices nor the manufacturing project collection (no cascade)', async () => {
        await put(won());
        await env.seed('proyectos_fabricacion/W1', { id: 'W1', fab: true });
        await del('MGR');
        expect(await env.read('clients_prod/CW')).toBeDefined();
        expect((await prospect('W1')).facturas).toHaveLength(1);
        expect(await env.read('proyectos_fabricacion/W1')).toEqual({ id: 'W1', fab: true });
      });
    });
  });
}

module.exports = { defineWorkflowSuite };
