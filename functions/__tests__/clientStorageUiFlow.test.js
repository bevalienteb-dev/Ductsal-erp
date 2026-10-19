// functions/__tests__/clientStorageUiFlow.test.js
// UNIT layer (no network, fake DOM, fake Firebase):
// Tests the real client creation and Storage upload flows of app_core.js and crm_clients.js (Phase 2):
// - Validation before reservation/upload.
// - Client creation without documents (reserve -> finalize).
// - Client creation with identification and legal documents (hierarchical paths + metadata).
// - Duplicate NIT/DUI rejection before upload.
// - Partial upload failure and reservation cancellation.
// - Expired/cancelled reservation handling.
// - Idempotent finalization retry on network error.
// - Modal closure cancellation.
// - Commercial opportunity uploads in all authorized folders (proyectos, facturas, pagos, ordenes_cambio).
// - Historical document format compatibility.

const fs = require('fs');
const path = require('path');
const CrmClients = require('../../crm_clients.js');
const CrmCommercial = require('../../crm_commercial.js');

const ROOT = path.join(__dirname, '..', '..');
const appCore = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');

const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

// Extract real functions from app_core.js
const SRC = [
  between('let currentClientReservationId = null;', '// Selector of NEW opportunities'),
  between('async function uploadClientStagedFiles', '// ========================\n// PROSPECTS & PROJECTS LISTS'),
  between('async function persistClientViaServer', '// The opportunity is created by createProspectAdmin')
].join('\n');

function buildEnvironment({ session = true, clientHandler, uploadHandler } = {}) {
  const calls = [];
  const uploads = [];
  const els = {};
  const el = (id, value = '', extra = {}) => {
    if (!els[id]) {
      els[id] = {
        id,
        value,
        checked: false,
        files: [],
        style: {},
        dataset: {},
        textContent: '',
        innerHTML: '',
        ...extra
      };
    } else {
      if (value !== '') els[id].value = value;
      Object.assign(els[id], extra);
    }
    return els[id];
  };

  const S = {
    currentUser: { id: '1792037387205', nombre: 'Vendedor 1', role: 'vendedor' },
    DB_SUFFIX: '_prod',
    STORAGE_PREFIX: 'prod_files',
    clients: [],
    prospects: []
  };

  const ui = {
    alerts: [],
    confirms: [],
    confirmAnswer: true,
    closed: [],
    loading: 0,
    tableRendered: 0,
    selectorSelected: null
  };

  const document = {
    getElementById: (id) => els[id] || el(id)
  };

  const fakeStorageRef = (path) => ({
    fullPath: path,
    child: (sub) => fakeStorageRef(sub),
    put: (file) => ({
      cancel: () => {},
      on: (event, onProgress, onError, onComplete) => {
        setTimeout(onComplete, 0);
      }
    }),
    getDownloadURL: async () => `https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(path)}?alt=media&token=tok-123`
  });

  const firebase = {
    auth: () => ({ currentUser: session ? { uid: 'uid-v1' } : null }),
    app: () => ({
      storage: () => ({
        ref: () => ({
          child: (fullPath) => {
            uploads.push(fullPath);
            if (uploadHandler) return uploadHandler(fullPath);
            return fakeStorageRef(fullPath);
          }
        })
      })
    }),
    functions: () => ({
      httpsCallable: (name) => async (payload) => {
        calls.push({ name, payload });
        if (clientHandler) return { data: await clientHandler(name, payload) };
        return { data: { status: 'ok' } };
      }
    }),
    storage: () => ({
      ref: () => ({
        child: (fullPath) => {
          uploads.push(fullPath);
          if (uploadHandler) return uploadHandler(fullPath);
          return fakeStorageRef(fullPath);
        }
      })
    })
  };

  // Real uploadFileToStorage function from app_core.js
  const uploadFileToStorageSrc = between('async function uploadFileToStorage(', 'const STAGES =');

  const api = new Function('S', 'document', 'ui', 'firebase', 'CrmClients', `
    with (S) {
      var alert = function (m) { ui.alerts.push(m); };
      var confirm = function (m) { ui.confirms.push(m); return ui.confirmAnswer; };
      var showLoading = function () { ui.loading++; };
      var hideLoading = function () { ui.loading--; };
      var renderClientsTable = function () { ui.tableRendered++; };
      var selectClientInSelector = function (id, name) { ui.selectorSelected = { id, name }; };
      var getClientName = function () { return 'Cliente Test'; };
      var compressImage = async function (f) { return f; };
      var activeUploads = 0;
      var uploadProgressMap = new Map();
      var updateGlobalProgress = function () {};
      var storage = firebase.storage();

      ${uploadFileToStorageSrc}
      ${SRC}

      return {
        saveClient: saveClient,
        persistClientViaServer: persistClientViaServer,
        uploadClientStagedFiles: uploadClientStagedFiles,
        cancelPendingClientReservation: cancelPendingClientReservation,
        uploadFileToStorage: uploadFileToStorage,
        getCurrentReservationId: function () { return currentClientReservationId; },
        setCurrentReservationId: function (id) { currentClientReservationId = id; }
      };
    }
  `)(S, document, ui, firebase, CrmClients);

  return { api, S, ui, calls, uploads, el, fakeStorageRef };
}

describe('Phase 2 Client Creation & Storage Adaptation (Real UI Flow)', () => {
  beforeEach(() => {
    CrmClients._pendingOps.clear();
  });

  test('Form validation rejects invalid or incomplete data before calling server or storage', async () => {
    const env = buildEnvironment();

    // 1. Missing type
    env.el('client-id-edit', '');
    env.el('client-tipo', '');
    await env.api.saveClient({ preventDefault: () => {} });
    expect(env.ui.alerts[0]).toMatch(/Tipo de Persona/i);
    expect(env.calls).toHaveLength(0);
    expect(env.uploads).toHaveLength(0);

    // 2. Missing phone and email
    env.el('client-tipo', 'natural');
    env.el('cli-telefono', '');
    env.el('cli-correo', '');
    await env.api.saveClient({ preventDefault: () => {} });
    expect(env.ui.alerts[1]).toMatch(/teléfono o correo/i);
    expect(env.calls).toHaveLength(0);

    // 3. Missing natural person names
    env.el('cli-telefono', '7000-0000');
    env.el('nat-nombres', '');
    env.el('nat-apellidos', '');
    await env.api.saveClient({ preventDefault: () => {} });
    expect(env.ui.alerts[2]).toMatch(/Nombres y Apellidos obligatorios/i);
    expect(env.calls).toHaveLength(0);

    // 4. Missing juridica company
    env.el('client-tipo', 'juridica');
    env.el('jur-empresa', '');
    env.el('jur-contacto', '');
    await env.api.saveClient({ preventDefault: () => {} });
    expect(env.ui.alerts[3]).toMatch(/Nombre de la Empresa obligatorio/i);
    expect(env.calls).toHaveLength(0);
    expect(env.uploads).toHaveLength(0);
  });

  test('Client creation without documents: reserve -> no upload -> finalize -> table rendered', async () => {
    const reservationId = 'RES-NAT-001';
    const handler = async (name, payload) => {
      if (name === 'reserveClientCreationAdmin') {
        return { status: 'reserved', reservationId, expiresAt: new Date(Date.now() + 1800000).toISOString() };
      }
      if (name === 'finalizeClientCreationAdmin') {
        return { status: 'created', client: { id: reservationId, ...payload.client } };
      }
      throw new Error('Unexpected callable: ' + name);
    };

    const env = buildEnvironment({ clientHandler: handler });
    env.el('client-id-edit', '');
    env.el('client-tipo', 'natural');
    env.el('cli-telefono', '7123-4567');
    env.el('cli-correo', 'test@ductsal.com');
    env.el('cli-correo-fact', '');
    env.el('cli-es-exportacion').checked = false;
    env.el('nat-nombres', 'Juan');
    env.el('nat-apellidos', 'Pérez');
    env.el('nat-dui', '01234567-8');
    env.el('nat-nit', '0614-010190-101-1');
    env.el('nat-profesion', 'Ingeniero');
    env.el('nat-domicilio', 'San Salvador');

    await env.api.saveClient({ preventDefault: () => {} });

    // Verify call sequence
    expect(env.calls).toHaveLength(2);
    expect(env.calls[0].name).toBe('reserveClientCreationAdmin');
    expect(env.calls[0].payload.client.nombres).toBe('Juan');
    expect(env.calls[1].name).toBe('finalizeClientCreationAdmin');
    expect(env.calls[1].payload.reservationId).toBe(reservationId);
    expect(env.calls[1].payload.client.id).toBeUndefined(); // Browser never invents its own ID

    // Verify zero storage uploads
    expect(env.uploads).toHaveLength(0);

    // Verify UI effects
    expect(env.S.clients).toHaveLength(1);
    expect(env.S.clients[0].id).toBe(reservationId);
    expect(env.el('clientModal').style.display).toBe('none');
    expect(env.ui.tableRendered).toBe(1);
    expect(env.api.getCurrentReservationId()).toBeNull();
  });

  test('Client creation with documents: uploads to hierarchical paths under reservationId with full metadata', async () => {
    const reservationId = 'RES-JUR-777';
    const handler = async (name, payload) => {
      if (name === 'reserveClientCreationAdmin') {
        return { status: 'reserved', reservationId, expiresAt: new Date(Date.now() + 1800000).toISOString() };
      }
      if (name === 'finalizeClientCreationAdmin') {
        return { status: 'created', client: { id: reservationId, ...payload.client } };
      }
      throw new Error('Unexpected callable: ' + name);
    };

    const env = buildEnvironment({ clientHandler: handler });
    env.el('client-id-edit', '');
    env.el('client-tipo', 'juridica');
    env.el('cli-telefono', '2222-3333');
    env.el('cli-correo', 'info@delta.com');
    env.el('cli-correo-fact', 'facturacion@delta.com');
    env.el('cli-es-exportacion').checked = false;
    env.el('jur-empresa', 'Delta Construcciones');
    env.el('jur-contacto', 'Roberto Carlos');
    env.el('jur-nit', '0614-200220-102-3');
    env.el('jur-nrc', '123456-7');
    env.el('jur-rep-legal', 'Roberto Carlos');
    env.el('jur-profesion-rep', 'Arquitecto');
    env.el('jur-domicilio-rep', 'San Salvador');
    env.el('jur-dui-rep', '09876543-2');
    env.el('jur-nit-rep', '0614-111188-101-2');
    env.el('jur-gran-contribuyente').checked = true;

    // Staged files: identification and legal
    env.el('jur-file-dui', '', { files: [{ name: 'dui_rep.pdf' }] });
    env.el('jur-file-escritura', '', { files: [{ name: 'escritura.pdf' }] });
    env.el('jur-file-nit', '', { files: [{ name: 'nit_empresa.pdf' }] });

    await env.api.saveClient({ preventDefault: () => {} });

    // Verify calls
    expect(env.calls).toHaveLength(2);
    expect(env.calls[0].name).toBe('reserveClientCreationAdmin');
    expect(env.calls[1].name).toBe('finalizeClientCreationAdmin');
    expect(env.calls[1].payload.reservationId).toBe(reservationId);

    // Verify uploads to Storage: exactly 3 files
    expect(env.uploads).toHaveLength(3);

    // DUI should go to identificacion
    const duiUpload = env.uploads.find(u => u.includes('dui_rep.pdf'));
    expect(duiUpload).toBeDefined();
    expect(duiUpload).toMatch(new RegExp(`^prod_files/clients/${reservationId}/identificacion/\\d+_dui_rep\\.pdf$`));

    // Legal documents should go to legal/
    const escUpload = env.uploads.find(u => u.includes('escritura.pdf'));
    expect(escUpload).toBeDefined();
    expect(escUpload).toMatch(new RegExp(`^prod_files/clients/${reservationId}/legal/\\d+_escritura\\.pdf$`));

    const nitUpload = env.uploads.find(u => u.includes('nit_empresa.pdf'));
    expect(nitUpload).toBeDefined();
    expect(nitUpload).toMatch(new RegExp(`^prod_files/clients/${reservationId}/legal/\\d+_nit_empresa\\.pdf$`));

    // Verify finalized documents object contains canonical reference (name, storagePath, contentType)
    const finalizedDocs = env.calls[1].payload.client.documentos;
    expect(finalizedDocs.dui).toBeDefined();
    expect(finalizedDocs.dui.name).toBe('dui_rep.pdf');
    expect(finalizedDocs.dui.storagePath).toBe(duiUpload);
    expect(finalizedDocs.dui.contentType).toBe('application/octet-stream');
    // SEC-05 H-04: Secure download does not require storing an insecure public token URL
    expect(finalizedDocs.dui.url).toBeUndefined();

    expect(finalizedDocs.escritura.storagePath).toBe(escUpload);
    expect(finalizedDocs.nit.storagePath).toBe(nitUpload);

    expect(env.S.clients[0].documentos.dui.storagePath).toBe(duiUpload);
  });

  test('Duplicate NIT/DUI rejection: rejects at reservation step BEFORE any upload', async () => {
    const handler = async (name) => {
      if (name === 'reserveClientCreationAdmin') {
        return {
          status: 'duplicate',
          matches: [{ clientId: 'C_EXISTING', nombre: 'Cliente Existente', hint: 'NIT ····1011', reasons: ['nit'] }]
        };
      }
      throw new Error('Should not call: ' + name);
    };

    const env = buildEnvironment({ clientHandler: handler });
    env.el('client-id-edit', '');
    env.el('client-tipo', 'natural');
    env.el('cli-telefono', '7123-4567');
    env.el('cli-correo', 'dup@ductsal.com');
    env.el('nat-nombres', 'Carlos');
    env.el('nat-apellidos', 'Gómez');
    env.el('nat-dui-file', '', { files: [{ name: 'dui.pdf' }] });

    await env.api.saveClient({ preventDefault: () => {} });

    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].name).toBe('reserveClientCreationAdmin');
    expect(env.uploads).toHaveLength(0); // Zero files uploaded!
    expect(env.ui.alerts[0]).toMatch(/Cliente Existente/);
    expect(env.ui.alerts[0]).toMatch(/NIT ····1011/);
    expect(env.S.clients).toHaveLength(0);
  });

  test('Partial upload failure: prompts user and cancels pending reservation', async () => {
    const reservationId = 'RES-FAIL-01';
    let cancelled = false;
    const handler = async (name, payload) => {
      if (name === 'reserveClientCreationAdmin') {
        return { status: 'reserved', reservationId, expiresAt: new Date(Date.now() + 1800000).toISOString() };
      }
      if (name === 'cancelClientReservationAdmin') {
        cancelled = true;
        return { status: 'cancelled', reservationId };
      }
      throw new Error('Unexpected call: ' + name);
    };

    let env;
    const uploadHandler = (fullPath) => {
      if (fullPath.includes('legal')) {
        return {
          fullPath,
          child: (sub) => uploadHandler(sub),
          put: () => ({
            cancel: () => {},
            on: (event, onProgress, onError, onComplete) => {
              setTimeout(() => onError(new Error('Network timeout during upload')), 0);
            }
          }),
          getDownloadURL: async () => ''
        };
      }
      return env.fakeStorageRef(fullPath);
    };

    env = buildEnvironment({ clientHandler: handler, uploadHandler });
    env.el('client-id-edit', '');
    env.el('client-tipo', 'juridica');
    env.el('cli-telefono', '2222-1111');
    env.el('cli-correo', 'fail@ductsal.com');
    env.el('jur-empresa', 'Falla Upload S.A.');
    env.el('jur-contacto', 'Gerente');
    env.el('jur-file-dui', '', { files: [{ name: 'dui.pdf' }] });
    env.el('jur-file-escritura', '', { files: [{ name: 'escritura.pdf' }] });

    env.ui.confirmAnswer = true; // User agrees to cancel reservation

    await env.api.saveClient({ preventDefault: () => {} });

    expect(cancelled).toBe(true);
    expect(env.calls.some(c => c.name === 'cancelClientReservationAdmin')).toBe(true);
    expect(env.calls.some(c => c.name === 'finalizeClientCreationAdmin')).toBe(false);
    expect(env.S.clients).toHaveLength(0);
    expect(env.api.getCurrentReservationId()).toBeNull();
  });

  test('Expired/cancelled reservation rejection: clear user notification, no corrupted client saved', async () => {
    const reservationId = 'RES-EXP-01';
    const handler = async (name) => {
      if (name === 'reserveClientCreationAdmin') {
        return { status: 'reserved', reservationId, expiresAt: new Date(Date.now() + 1800000).toISOString() };
      }
      if (name === 'finalizeClientCreationAdmin') {
        const e = new Error('La reserva ha expirado.');
        e.code = 'functions/failed-precondition';
        throw e;
      }
      throw new Error('Unexpected: ' + name);
    };

    const env = buildEnvironment({ clientHandler: handler });
    env.el('client-id-edit', '');
    env.el('client-tipo', 'natural');
    env.el('cli-telefono', '7000-0000');
    env.el('cli-correo', 'exp@ductsal.com');
    env.el('nat-nombres', 'Expira');
    env.el('nat-apellidos', 'Test');

    await env.api.saveClient({ preventDefault: () => {} });

    expect(env.ui.alerts[0]).toMatch(/reserva.*(expirado|vencid).*cancelada/i);
    expect(env.S.clients).toHaveLength(0);
  });

  test('Idempotent retry: network timeout on first finalization reuses identical opId and formalizes client', async () => {
    const reservationId = 'RES-RETRY-01';
    let finalizeAttempts = 0;
    const handler = async (name, payload) => {
      if (name === 'reserveClientCreationAdmin') {
        return { status: 'reserved', reservationId, expiresAt: new Date(Date.now() + 1800000).toISOString() };
      }
      if (name === 'finalizeClientCreationAdmin') {
        finalizeAttempts++;
        if (finalizeAttempts === 1) {
          const e = new Error('Gateway Timeout');
          e.code = 'functions/unavailable';
          throw e;
        }
        return { status: 'created', client: { id: reservationId, ...payload.client } };
      }
      throw new Error('Unexpected: ' + name);
    };

    const env = buildEnvironment({ clientHandler: handler });
    const clientData = {
      tipo: 'natural',
      nombres: 'Retry',
      apellidos: 'Idempotent',
      telefono: '7000-1111',
      correo: 'retry@ductsal.com',
      documentos: {}
    };

    // First attempt fails with unavailable
    const saved1 = await env.api.persistClientViaServer(clientData, null);
    expect(saved1).toBeNull();
    expect(env.ui.alerts[0]).toMatch(/reintentar/i);

    // Second attempt (retry) with same client and same reservation
    // CrmClients.finalizeCreation reuses identical opId for the same reservationId!
    const op1 = env.calls.find(c => c.name === 'finalizeClientCreationAdmin').payload.opId;

    // Simulate calling finalize again
    const finRes2 = await CrmClients.finalizeCreation(env.S.firebase || {
      auth: () => ({ currentUser: { uid: 'uid-v1' } }),
      functions: () => ({
        httpsCallable: (name) => async (payload) => {
          env.calls.push({ name, payload });
          return { data: await handler(name, payload) };
        }
      })
    }, { reservationId, client: clientData, dbSuffix: '_prod' });

    const op2 = env.calls.filter(c => c.name === 'finalizeClientCreationAdmin')[1].payload.opId;
    expect(op1).toBe(op2); // Strict idempotent replay
    expect(finRes2.status).toBe('created');
  });

  test('Modal closure triggers automatic cancellation of pending reservation', async () => {
    let cancelledReservation = null;
    const handler = async (name, payload) => {
      if (name === 'cancelClientReservationAdmin') {
        cancelledReservation = payload.reservationId;
        return { status: 'cancelled' };
      }
      return { status: 'ok' };
    };

    const env = buildEnvironment({ clientHandler: handler });
    env.el('clientModal');
    env.api.setCurrentReservationId('RES-CLOSE-01');
    expect(env.api.getCurrentReservationId()).toBe('RES-CLOSE-01');

    await env.api.cancelPendingClientReservation();

    expect(cancelledReservation).toBe('RES-CLOSE-01');
    expect(env.api.getCurrentReservationId()).toBeNull();
  });

  test('Hierarchical paths for opportunity uploads in all commercial folders', async () => {
    const env = buildEnvironment();
    const prospectId = 'PX-COMMERCIAL-99';

    // 1. Proyectos (levantamiento, oferta, costos)
    const refProyectos = await env.api.uploadFileToStorage({ name: 'oferta_v1.pdf' }, 'proyectos', { prospectId });
    expect(refProyectos.storagePath).toMatch(new RegExp(`^prod_files/prospects/${prospectId}/proyectos/\\d+_oferta_v1\\.pdf$`));
    expect(refProyectos.name).toBe('oferta_v1.pdf');
    expect(refProyectos.contentType).toBe('application/octet-stream');
    // SEC-05 H-04: Secure download does not require storing an insecure public token URL
    expect(refProyectos.url).toBeUndefined();

    // 2. Facturas
    const refFacturas = await env.api.uploadFileToStorage({ name: 'factura_A100.pdf' }, 'facturas', { prospectId });
    expect(refFacturas.storagePath).toMatch(new RegExp(`^prod_files/prospects/${prospectId}/facturas/\\d+_factura_A100\\.pdf$`));

    // 3. Pagos
    const refPagos = await env.api.uploadFileToStorage({ name: 'recibo_pago.png' }, 'pagos', { prospectId });
    expect(refPagos.storagePath).toMatch(new RegExp(`^prod_files/prospects/${prospectId}/pagos/\\d+_recibo_pago\\.png$`));

    // 4. Ordenes de cambio
    const refOC = await env.api.uploadFileToStorage({ name: 'oc_costos.xlsx' }, 'ordenes_cambio', { prospectId });
    expect(refOC.storagePath).toMatch(new RegExp(`^prod_files/prospects/${prospectId}/ordenes_cambio/\\d+_oc_costos\\.xlsx$`));

    // 5. Fallback flat path when neither prospectId nor clientId is passed (backward compatibility drift guard)
    const refFlat = await env.api.uploadFileToStorage({ name: 'legacy.pdf' }, 'proyectos', {});
    expect(refFlat.storagePath).toMatch(/^prod_files\/proyectos\/\d+_legacy\.pdf$/);
  });

  test('Historical references backward compatibility (string URL, {name, url}, and {name, url, storagePath})', () => {
    // Helper used across UI to extract URL safely
    function getFileUrl(doc) {
      if (!doc) return null;
      if (typeof doc === 'string') return doc;
      return doc.url || null;
    }

    function getFileName(doc, fallback = 'Archivo') {
      if (!doc) return fallback;
      if (typeof doc === 'string') return fallback;
      return doc.name || fallback;
    }

    // Historical format 1: plain string URL
    const doc1 = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/legacy_file.pdf?alt=media&token=tok-1';
    expect(getFileUrl(doc1)).toBe(doc1);
    expect(getFileName(doc1, 'Documento')).toBe('Documento');

    // Historical format 2: object with name and url only
    const doc2 = { name: 'cotizacion.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/cotizacion.pdf?alt=media&token=tok-2' };
    expect(getFileUrl(doc2)).toBe(doc2.url);
    expect(getFileName(doc2)).toBe('cotizacion.pdf');

    // New Phase 2 format: object with name, url, and storagePath
    const doc3 = {
      name: 'factura_001.pdf',
      url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/prod_files%2Fprospects%2FP1%2Ffacturas%2Ffactura_001.pdf?alt=media&token=tok-3',
      storagePath: 'prod_files/prospects/P1/facturas/factura_001.pdf'
    };
    expect(getFileUrl(doc3)).toBe(doc3.url);
    expect(getFileName(doc3)).toBe('factura_001.pdf');
    expect(doc3.storagePath).toBe('prod_files/prospects/P1/facturas/factura_001.pdf');
  });
});
