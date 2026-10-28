/**
 * Unit tests for Fase 4B.5 Acción 3: Formulario integrado de sustitución documental,
 * validación de motivo obligatorio, idempotencia y prevención de pérdida de versiones.
 */

const fs = require('fs');
const path = require('path');

const domElements = {};
const alerts = [];
const uploads = [];
const calls = [];

function getOrMakeEl(id) {
  if (!domElements[id]) {
    domElements[id] = {
      id,
      value: '',
      style: { display: '' },
      files: [],
      innerHTML: '',
      disabled: false,
      addEventListener: () => {}
    };
  }
  return domElements[id];
}

global.document = {
  getElementById: (id) => getOrMakeEl(id),
  addEventListener: () => {},
  createElement: (tag) => ({
    tagName: tag.toUpperCase(),
    style: {},
    appendChild: () => {},
    innerHTML: ''
  }),
  body: {
    appendChild: () => {}
  }
};

global.window = {
  location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
  _docStore: new Map(),
  alert: (msg) => alerts.push(msg),
  confirm: () => true,
  document: global.document,
  uploadFileToStorage: async (file, folder, opts) => {
    uploads.push({ file, folder, opts });
    return {
      name: file.name,
      storagePath: `prod_files/${folder}/${opts.prospectId || opts.clientId}/${file.name}`,
      url: `https://storage.mock/${file.name}`,
      subidoEn: new Date().toISOString()
    };
  }
};

Object.defineProperty(global.window, 'clients', {
  get: () => global.clients || [],
  set: (v) => { global.clients = v; },
  configurable: true
});

Object.defineProperty(global.window, 'prospects', {
  get: () => global.prospects || [],
  set: (v) => { global.prospects = v; },
  configurable: true
});

global.alert = (msg) => alerts.push(msg);
global.confirm = () => true;
global.uploadFileToStorage = global.window.uploadFileToStorage;

global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const mockFirestore = {
  settings: () => {},
  collection: () => ({
    doc: () => ({
      collection: () => ({
        get: async () => ({
          forEach: () => {}
        })
      })
    })
  })
};

global.db = mockFirestore;
global.firebase = {
  initializeApp: () => ({}),
  firestore: () => mockFirestore,
  storage: () => ({ ref: () => ({}) }),
  auth: () => ({ currentUser: { uid: 'vend_1' } }),
  functions: () => ({
    httpsCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      if (global.customCallableHandler) {
        return { data: await global.customCallableHandler(name, payload) };
      }
      return { data: { status: 'updated' } };
    }
  })
};

const CrmCommercial = require('../../crm_commercial');
const CrmClients = require('../../crm_clients');
global.CrmClients = CrmClients;
global.window.CrmClients = CrmClients;
global.CrmCommercial = CrmCommercial;
global.window.CrmCommercial = CrmCommercial;
const appCore = require('../../app_core');

describe('Fase 4B.5 Acción 3: Formulario integrado de sustitución documental y UX', () => {
  beforeEach(() => {
    alerts.length = 0;
    uploads.length = 0;
    calls.length = 0;
    global.customCallableHandler = null;
    for (const k in domElements) delete domElements[k];
  });

  test('cancelClientDocSubstForm limpia archivo, motivo, feedback y oculta el formulario sin afectar el documento', () => {
    const fileEl = getOrMakeEl('closing-client-subst-file-dui');
    const motivoEl = getOrMakeEl('closing-client-motivo-dui');
    const feedbackEl = getOrMakeEl('closing-client-subst-feedback-dui');
    const containerEl = getOrMakeEl('subst-container-client-dui');

    fileEl.value = 'dummy.pdf';
    motivoEl.value = 'Texto borrador';
    feedbackEl.style.display = 'block';
    feedbackEl.innerHTML = 'Mensaje';
    containerEl.style.display = 'block';

    appCore.cancelClientDocSubstForm('dui');

    expect(fileEl.value).toBe('');
    expect(motivoEl.value).toBe('');
    expect(feedbackEl.style.display).toBe('none');
    expect(feedbackEl.innerHTML).toBe('');
    expect(containerEl.style.display).toBe('none');
    // Ningún archivo fue subido
    expect(uploads.length).toBe(0);
  });

  test('cancelProspectDocSubstForm limpia archivo, motivo, feedback y oculta el formulario sin afectar la oportunidad', () => {
    const fileEl = getOrMakeEl('closing-file-doc_firmado');
    const motivoEl = getOrMakeEl('closing-motivo-doc_firmado');
    const feedbackEl = getOrMakeEl('closing-prospect-feedback-doc_firmado');
    const containerEl = getOrMakeEl('subst-container-prospect-doc_firmado');

    fileEl.value = 'oferta_nueva.pdf';
    motivoEl.value = 'Razón no enviada';
    feedbackEl.style.display = 'block';
    feedbackEl.innerHTML = 'Mensaje previo';
    containerEl.style.display = 'block';

    appCore.cancelProspectDocSubstForm('doc_firmado');

    expect(fileEl.value).toBe('');
    expect(motivoEl.value).toBe('');
    expect(feedbackEl.style.display).toBe('none');
    expect(feedbackEl.innerHTML).toBe('');
    expect(containerEl.style.display).toBe('none');
    expect(uploads.length).toBe(0);
  });

  test('confirmProspectDocSubstitution bloquea ejecución si falta archivo o motivo tiene menos de 3 caracteres', async () => {
    global.prospects = [
      { id: 'P_SUB_1', estado: 'cierre', datos: { doc_firmado: { name: 'antiguo.pdf' } } }
    ];

    const fileEl = getOrMakeEl('closing-file-doc_firmado');
    const motivoEl = getOrMakeEl('closing-motivo-doc_firmado');

    // 1. Sin archivo
    fileEl.files = [];
    motivoEl.value = 'Motivo valido';
    await appCore.confirmProspectDocSubstitution('P_SUB_1', 'doc_firmado');
    expect(alerts.some(a => a.includes('Debe seleccionar un archivo'))).toBe(true);
    expect(uploads.length).toBe(0);

    // 2. Con archivo pero motivo vacío o muy corto
    alerts.length = 0;
    fileEl.files = [{ name: 'nuevo.pdf' }];
    motivoEl.value = '  ';
    await appCore.confirmProspectDocSubstitution('P_SUB_1', 'doc_firmado');
    expect(alerts.some(a => a.includes('motivo obligatorio'))).toBe(true);
    expect(uploads.length).toBe(0);

    alerts.length = 0;
    motivoEl.value = 'ok'; // Menos de 3 caracteres
    await appCore.confirmProspectDocSubstitution('P_SUB_1', 'doc_firmado');
    expect(alerts.some(a => a.includes('motivo obligatorio'))).toBe(true);
    expect(uploads.length).toBe(0);
  });

  test('confirmProspectDocSubstitution sube a Storage, versiona y guarda en backend con motivo válido', async () => {
    let savedData = null;
    global.prospects = [
      { id: 'P_SUB_2', estado: 'cierre', datos: { doc_firmado: { name: 'antiguo.pdf' } } }
    ];

    global.customCallableHandler = async (name, payload) => {
      if (name === 'saveClosingDocumentsAdmin') {
        savedData = payload.data;
        return { status: 'updated' };
      }
      return { status: 'ok' };
    };

    const fileEl = getOrMakeEl('closing-file-doc_firmado');
    const motivoEl = getOrMakeEl('closing-motivo-doc_firmado');
    fileEl.files = [{ name: 'oferta_actualizada_v2.pdf' }];
    motivoEl.value = 'Ajuste de alcance comercial solicitado por cliente';

    await appCore.confirmProspectDocSubstitution('P_SUB_2', 'doc_firmado');

    expect(uploads.length).toBe(1);
    expect(uploads[0].folder).toBe('proyectos');
    expect(savedData).not.toBeNull();
    expect(savedData.motivo_doc_firmado).toBe('Ajuste de alcance comercial solicitado por cliente');
    expect(savedData.doc_firmado.motivoSustitucion).toBe('Ajuste de alcance comercial solicitado por cliente');
    expect(alerts.some(a => a.includes('sustituido y archivado exitosamente'))).toBe(true);
  });

  test('confirmProspectDocSubstitution preserva estado y no rompe si backend o Storage fallan', async () => {
    global.prospects = [
      { id: 'P_SUB_3', estado: 'cierre', datos: { doc_firmado: { name: 'antiguo.pdf' } } }
    ];

    global.customCallableHandler = async (name, payload) => {
      if (name === 'saveClosingDocumentsAdmin') {
        throw new Error('Error simulado en backend');
      }
      return { status: 'ok' };
    };

    const fileEl = getOrMakeEl('closing-file-doc_firmado');
    const motivoEl = getOrMakeEl('closing-motivo-doc_firmado');
    fileEl.files = [{ name: 'oferta_fallida.pdf' }];
    motivoEl.value = 'Motivo válido de prueba';

    await appCore.confirmProspectDocSubstitution('P_SUB_3', 'doc_firmado');

    // Debe mostrar alerta de error indicando que la versión anterior se conservó intacta
    expect(alerts.some(a => a.includes('La versión anterior se conservó intacta'))).toBe(true);
  });
});
