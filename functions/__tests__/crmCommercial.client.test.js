// functions/__tests__/crmCommercial.client.test.js
// UNIT layer. Browser module of the commercial operations (crm_commercial.js) and static guards on how app_core.js /
// index.html use it. No Firebase, no network: the Firebase namespace is a stub. These tests do NOT exercise Firestore
// rules nor the emulators.

const fs = require('fs');
const path = require('path');
const CrmCommercial = require('../../crm_commercial.js');

const ROOT = path.join(__dirname, '..', '..');
const appCore = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const between = (from, to) => {
  const a = appCore.indexOf(from);
  if (a === -1) throw new Error(`marker not found: ${from}`);
  const b = appCore.indexOf(to, a + from.length);
  if (b === -1) throw new Error(`marker not found: ${to}`);
  return appCore.slice(a, b);
};

function fbWith(impl, { session = true } = {}) {
  const calls = [];
  const fb = {
    auth: () => ({ currentUser: session ? { uid: 'u' } : null }),
    functions: () => ({ httpsCallable: (name) => async (payload) => { calls.push({ name, payload }); return { data: await impl(name, payload, calls.length) }; } })
  };
  return { fb, calls };
}
const uncertain = (code = 'functions/unavailable') => { const e = new Error('net'); e.code = code; return e; };
const prospect = { clientId: 'C1', proyecto: 'Nave', origen: 'Referido', tipo_proyecto: 'Industrial', tipo_producto: 'Ducto' };

beforeEach(() => CrmCommercial._pendingOps.clear());

describe('session hint', () => {
  test('true only with a Firebase user; any malformed namespace is false', () => {
    expect(CrmCommercial.hasSessionSync(fbWith(() => ({}), { session: true }).fb)).toBe(true);
    expect(CrmCommercial.hasSessionSync(fbWith(() => ({}), { session: false }).fb)).toBe(false);
    expect(CrmCommercial.hasSessionSync(null)).toBe(false);
    expect(CrmCommercial.hasSessionSync({})).toBe(false);
    expect(CrmCommercial.hasSessionSync({ auth: () => { throw new Error('x'); } })).toBe(false);
  });
});

describe('createProspect retries', () => {
  test('an uncertain failure keeps the SAME opId for the retry (cannot create two prospects)', async () => {
    let n = 0;
    const { fb, calls } = fbWith(() => { if (++n === 1) throw uncertain(); return { status: 'created', prospect: { id: 'P1' } }; });
    await expect(CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' })).rejects.toBeTruthy();
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' });
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
    expect(calls[0].name).toBe('createProspectAdmin');
  });
  test.each(['functions/unavailable', 'deadline-exceeded', 'functions/internal', 'unknown', 'cancelled'])('%s is treated as uncertain', async (code) => {
    const { fb, calls } = fbWith(() => { throw uncertain(code); });
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
  });
  test('a definite answer clears the key: the next intentional attempt gets a new opId', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'created', prospect: { id: 'P' } }));
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' });
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' });
    expect(calls[0].payload.opId).not.toBe(calls[1].payload.opId);
  });
  test('a definite rejection (permission / validation) also clears the key', async () => {
    const { fb, calls } = fbWith(() => { throw uncertain('functions/permission-denied'); });
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    expect(calls[0].payload.opId).not.toBe(calls[1].payload.opId);
  });
  test('different data or a different environment suffix gets a different opId', async () => {
    const { fb, calls } = fbWith(() => { throw uncertain(); });
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.createProspect(fb, { prospect: { ...prospect, proyecto: 'Otro' }, dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_local' }).catch(() => {});
    expect(new Set(calls.map(c => c.payload.opId)).size).toBe(3);
  });
  test('the key does not depend on property order', async () => {
    const { fb, calls } = fbWith(() => { throw uncertain(); });
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.createProspect(fb, { prospect: Object.fromEntries(Object.entries(prospect).reverse()), dbSuffix: '_prod' }).catch(() => {});
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
  });
  test('the payload carries only what the form typed + opId + suffix (no createdBy / id / codigo / roles)', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'created', prospect: { id: 'P' } }));
    await CrmCommercial.createProspect(fb, { prospect, dbSuffix: '_local' });
    expect(Object.keys(calls[0].payload).sort()).toEqual(['dbSuffix', 'opId', 'prospect']);
    expect(Object.keys(calls[0].payload.prospect).sort()).toEqual(Object.keys(prospect).sort());
  });
});

describe('addLog retries', () => {
  test('same note after an uncertain failure reuses the opId; another text does not', async () => {
    const { fb, calls } = fbWith(() => { throw uncertain(); });
    await CrmCommercial.addLog(fb, { prospectId: 'P1', text: 'llamé', dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.addLog(fb, { prospectId: 'P1', text: 'llamé', dbSuffix: '_prod' }).catch(() => {});
    await CrmCommercial.addLog(fb, { prospectId: 'P1', text: 'otra', dbSuffix: '_prod' }).catch(() => {});
    expect(calls[0].payload.opId).toBe(calls[1].payload.opId);
    expect(calls[2].payload.opId).not.toBe(calls[0].payload.opId);
    expect(calls[0].name).toBe('addProspectLogAdmin');
  });
  test('the payload has no author: identity comes from the session on the server', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'added' }));
    await CrmCommercial.addLog(fb, { prospectId: 'P1', text: 'x', dbSuffix: '_prod' });
    expect(Object.keys(calls[0].payload).sort()).toEqual(['dbSuffix', 'opId', 'prospectId', 'text']);
  });
});

describe('other operations: callable names and payloads', () => {
  test('deleteLog / reassign / authorization / settings / deleteClient', async () => {
    const { fb, calls } = fbWith(() => ({ status: 'ok' }));
    await CrmCommercial.deleteLog(fb, { prospectId: 'P1', date: 'd', text: 't', dbSuffix: '_x' });
    await CrmCommercial.reassign(fb, { prospectId: 'P1', vendedorId: 'U2', dbSuffix: '_x' });
    await CrmCommercial.setNoContractAuthorization(fb, { prospectId: 'P1', authorized: 'yes', dbSuffix: '_x' });
    await CrmCommercial.updateSettings(fb, { action: 'addItem', list: 'visitantes', value: 'Ana', dbSuffix: '_x' });
    await CrmCommercial.deleteClient(fb, { clientId: 'C1', dbSuffix: '_x' });
    expect(calls.map(c => c.name)).toEqual([
      'deleteProspectLogAdmin', 'reassignProspectAdmin', 'setNoContractAuthorizationAdmin', 'updateSettingsAdmin', 'deleteClientAdmin'
    ]);
    // `authorized` is coerced to a strict boolean: a truthy string never becomes `true`.
    expect(calls[2].payload.authorized).toBe(false);
    expect(calls[4].payload).toEqual({ clientId: 'C1', dbSuffix: '_x' });
  });
  test('a server error propagates (there is no fallback)', async () => {
    const { fb } = fbWith(() => { throw uncertain('functions/permission-denied'); });
    await expect(CrmCommercial.deleteClient(fb, { clientId: 'C1', dbSuffix: '_x' })).rejects.toMatchObject({ code: 'functions/permission-denied' });
  });
});

describe('wording', () => {
  test('error messages by code', () => {
    expect(CrmCommercial.errorMessage({ code: 'functions/unauthenticated' })).toMatch(/sesión/);
    expect(CrmCommercial.errorMessage({ code: 'functions/permission-denied', message: 'Solo gerentes' })).toMatch(/Solo gerentes/);
    expect(CrmCommercial.errorMessage({ code: 'functions/invalid-argument', message: 'Falta texto' })).toMatch(/Falta texto/);
    expect(CrmCommercial.errorMessage({ code: 'functions/not-found' })).toMatch(/ya no existe/);
    expect(CrmCommercial.errorMessage({ code: 'functions/failed-precondition', message: 'Tiene proyectos' })).toMatch(/Tiene proyectos/);
    expect(CrmCommercial.errorMessage({ code: 'functions/unavailable' })).toMatch(/reintentar/);
  });
  test('a bare code used as message is not echoed to the user', () => {
    expect(CrmCommercial.errorMessage({ code: 'functions/permission-denied', message: 'permission-denied' })).toBe('No tienes permiso para esta operación.');
  });
  test('NO_SESSION_MESSAGE explains why nothing was saved', () => {
    expect(CrmCommercial.NO_SESSION_MESSAGE).toMatch(/No se guardó/);
  });
});

describe('static guards on the page: migrated operations (no direct write, no fallback)', () => {
  const direct = /saveProspectToDB|saveClientToDB|\.collection\(|\.set\(|\.update\(|\.delete\(|\.add\(/;
  const guard = (name, from, to, token) => test(`${name} goes through CrmCommercial.${token} and writes nothing directly`, () => {
    const body = between(from, to);
    expect(body).toContain(`CrmCommercial.${token}`);
    expect(body).not.toMatch(direct);
  });
  guard('createNewProspect', 'async function createNewProspect', '// DETAIL VIEW', 'createProspect');
  guard('deleteLog', 'function deleteLog(', 'function addLogToProspect', 'deleteLog');
  guard('addLog', 'function addLog()', 'function showNewProposalForm', 'addLog');
  guard('applyNoContractAuthorization', 'async function applyNoContractAuthorization', 'window.toggleManagerApproval =', 'setNoContractAuthorization');
  guard('deleteClient', 'function deleteClient(', 'async function deleteProspect()', 'deleteClient');
  guard('addSetting / removeSetting / saveMapsSettings (applySettingsChange)', 'async function applySettingsChange', 'function addSetting', 'updateSettings');

  test('the approval toggles use the shared server-backed helper', () => {
    const t = between('window.toggleManagerApproval =', 'window.applyManagerBypass');
    expect(t).toContain('applyNoContractAuthorization');
    expect(t).not.toMatch(direct);
  });
  test('createNewProspect does not send identity fields', () => {
    const body = between('async function createNewProspect', '// DETAIL VIEW');
    expect(body).not.toMatch(/createdBy|vendedorName|vendedorRole|codigo|currentUser\.id/);
  });
  test('the log author prefix is no longer computed in the browser for typed notes', () => {
    expect(between('function addLog()', 'function showNewProposalForm')).not.toContain('addLogToProspect');
  });
  test('reassignVendor uses the server', () => {
    const body = between('function reassignVendor', 'CrmCommercial.reassign');
    expect(body).not.toMatch(direct);
  });
  test('the deprecated direct settings writer has no remaining callers', () => {
    const uses = appCore.split('\n').filter(l => /\bsaveSettings\(/.test(l) && !l.includes('function saveSettings'));
    expect(uses).toHaveLength(0);
  });
  test('no feature flag re-enables direct writes', () => {
    expect(appCore).not.toMatch(/ALLOW_DIRECT|DIRECT_WRITES|legacyWrites|fallbackToDirect/i);
  });
});

describe('static guards on the page: workflow operations are migrated and the direct writers are disabled', () => {
  const direct = /saveProspectToDB|saveClientToDB|\.collection\(|\.set\(|\.update\(|\.delete\(|\.add\(/;
  const lines = (re) => appCore.split('\n').filter(l => re.test(l) && !/^\s*(\/\/|\*)/.test(l));
  test('nothing calls saveProspectToDB / saveClientToDB any more (the functions only throw)', () => {
    expect(lines(/saveProspectToDB\(|saveClientToDB\(/).filter(l => !/function save(Prospect|Client)ToDB/.test(l))).toHaveLength(0);
    expect(between('function saveProspectToDB', 'function ')).toContain('throw');
  });
  test('deleteProspect goes through the server and writes nothing directly', () => {
    const body = between('async function deleteProspect()', 'function ');
    expect(body).toContain('CrmCommercial.deleteProspect');
    expect(body).not.toMatch(direct);
  });
  test('the browser no longer validates a manager password nor builds audit entries', () => {
    expect(appCore).not.toContain('adv-auth-password');
    expect(lines(/function reportToManager|window\.applyManagerBypass\s*=/)).toHaveLength(0);
    // The only reference left is the READ-ONLY audit panel listener.
    const refs = lines(/audit_logs|commercialAudit/);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/onSnapshot/);
    expect(refs[0]).not.toMatch(/\.(set|add|update|delete)\(/);
  });
  test.each([
    ['processChangeOrder', 'saveChangeOrder'], ['processInvoice', 'saveInvoice'], ['processPayment', 'savePayment'],
    ['deleteChangeOrder', 'deleteChangeOrder'], ['deleteInvoice', 'deleteInvoice'], ['deletePayment', 'deletePayment'],
    ['processEditBasePrice', 'editBasePrice'], ['processNewProposal', 'registerProposal'],
    ['processAdvance', 'advanceStage'], ['processLose', 'markLost']
  ])('%s uses CrmCommercial.%s', (fn, token) => {
    expect(appCore).toMatch(new RegExp(`function ${fn}\\(`));
    expect(appCore).toContain(`CrmCommercial.${token}`);
  });
  test('the old localStorage migration no longer writes (detection only)', () => {
    const at = appCore.indexOf("document.addEventListener('DOMContentLoaded', async");
    const body = appCore.slice(at, appCore.indexOf('// Attach Listeners', at));
    expect(body).toContain('localStorage.getItem');
    const code = body.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/\.set\(|\.add\(|\.update\(|saveUserToDB|saveClientToDB|saveProspectToDB|saveSettings/);
  });
});

describe('static guards on index.html', () => {
  test('crm_commercial.js loads after crm_clients.js and before app_core.js', () => {
    const c = indexHtml.indexOf('crm_commercial.js');
    expect(c).toBeGreaterThan(indexHtml.indexOf('crm_clients.js'));
    expect(c).toBeLessThan(indexHtml.indexOf('app_core.js'));
  });
  test('firebase functions SDK loads before the commercial module', () => {
    expect(indexHtml.indexOf('firebase-functions-compat')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('firebase-functions-compat')).toBeLessThan(indexHtml.indexOf('crm_commercial.js'));
  });
});

describe('no-contract authorization and logical deletion: client wrappers', () => {
  const CrmCommercial = require('../../crm_commercial.js');
  const mk = (impl = async () => ({ data: { status: 'ok' } })) => {
    const calls = [];
    return { calls, fb: { functions: () => ({ httpsCallable: name => async payload => { calls.push({ name, payload }); return impl(name, payload); } }) } };
  };
  beforeEach(() => CrmCommercial._pendingOps.clear());

  test('request: calls requestNoContractAuthorizationAdmin with the reason and an opId; an uncertain failure reuses the opId', async () => {
    let n = 0;
    const { fb, calls } = mk(async () => { n += 1; if (n === 1) { const e = new Error('t'); e.code = 'functions/deadline-exceeded'; throw e; } return { data: { status: 'requested' } }; });
    await expect(CrmCommercial.requestNoContractAuthorization(fb, { prospectId: 'P1', motivo: 'Cliente grande', dbSuffix: '_local' })).rejects.toBeTruthy();
    await CrmCommercial.requestNoContractAuthorization(fb, { prospectId: 'P1', motivo: 'Cliente grande', dbSuffix: '_local' });
    expect(calls.map(c => c.name)).toEqual(['requestNoContractAuthorizationAdmin', 'requestNoContractAuthorizationAdmin']);
    expect(calls[1].payload.opId).toBe(calls[0].payload.opId);
    expect(Object.keys(calls[0].payload).sort()).toEqual(['dbSuffix', 'motivo', 'opId', 'prospectId']);
  });

  test('resolve: sends only the decision data, never authorization fields', async () => {
    const { fb, calls } = mk();
    await CrmCommercial.resolveNoContractAuthorization(fb, { prospectId: 'P1', requestId: 'R1', decision: 'approve', motivoDecision: 'ok', dbSuffix: '_local', autorizado_sin_contrato: true });
    expect(calls[0].name).toBe('resolveNoContractAuthorizationAdmin');
    expect(Object.keys(calls[0].payload).sort()).toEqual(['decision', 'dbSuffix', 'motivoDecision', 'prospectId', 'requestId'].sort());
  });

  test('deleteProspect sends the reason to deleteProspectAdmin', async () => {
    const { fb, calls } = mk();
    await CrmCommercial.deleteProspect(fb, { prospectId: 'P1', motivo: 'Duplicada', dbSuffix: '_local' });
    expect(calls[0]).toEqual({ name: 'deleteProspectAdmin', payload: { prospectId: 'P1', motivo: 'Duplicada', dbSuffix: '_local' } });
  });
});
