// functions/__tests__/closingDocumentationContextual.unit.test.js
// UNIT & ACCEPTANCE TEST SUITE — DUCTSAL ERP Fase 4B.4
// Carga contextual de documentos desde el panel de cierre

const fs = require('fs');
const path = require('path');

// Setup global mocks before requiring app_core
const alerts = [];
const prompts = [];
const uploads = [];
const calls = [];
const domElements = {};

function getOrMakeEl(id, initial = {}) {
  if (!domElements[id]) {
    domElements[id] = Object.assign({
      tagName: 'DIV',
      value: '',
      style: {},
      dataset: {},
      files: [],
      options: [],
      textContent: '',
      innerHTML: '',
      disabled: false,
      classList: { add: jest.fn(), remove: jest.fn() }
    }, initial);
  }
  return domElements[id];
}

global.window = {
  location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
  _docStore: new Map(),
  open: jest.fn()
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

Object.defineProperty(global.window, 'uploadFileToStorage', {
  get: () => global.uploadFileToStorage,
  set: (v) => { global.uploadFileToStorage = v; },
  configurable: true
});

global.document = {
  getElementById: (id) => domElements[id] || getOrMakeEl(id),
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      classList: { add: jest.fn(), remove: jest.fn() },
      innerHTML: '',
      textContent: '',
      appendChild: jest.fn()
    };
    return el;
  },
  body: {
    appendChild: (node) => {
      if (node && node.id) domElements[node.id] = node;
    }
  },
  addEventListener: jest.fn(),
  activeElement: null
};

global.alert = (m) => alerts.push(m);
global.prompt = (m) => { prompts.push(m); return global.promptAnswer || ''; };
global.confirm = () => true;

global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const mockSubcollections = {};
const mockFirestore = {
  collection: (colName) => ({
    doc: (docId) => ({
      collection: (subCol) => ({
        get: async () => {
          const key = `${colName}/${docId}/${subCol}`;
          const items = mockSubcollections[key] || [];
          return {
            forEach: (cb) => items.forEach(item => cb({ data: () => item }))
          };
        }
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

// Cargar app_core
const CrmCommercial = require('../../crm_commercial');
const CrmClients = require('../../crm_clients');
global.CrmClients = CrmClients;
global.window.CrmClients = CrmClients;
global.CrmCommercial = CrmCommercial;
global.window.CrmCommercial = CrmCommercial;
const appCore = require('../../app_core');

describe('Fase 4B.4: Carga contextual de documentos desde el panel de cierre', () => {

  beforeEach(() => {
    alerts.length = 0;
    prompts.length = 0;
    uploads.length = 0;
    calls.length = 0;
    global.promptAnswer = '';
    global.customCallableHandler = null;
    for (const k in domElements) delete domElements[k];
    for (const k in mockSubcollections) delete mockSubcollections[k];
  });

  describe('Criterios 1, 2 y 3: Documentación del cliente (primera carga y sustitución)', () => {
    test('1. Primera carga de documento del cliente: NO exige motivo de sustitución', async () => {
      const client = { id: 'C_NAT_1', tipo: 'natural', nombres: 'Juan Pérez', documentos: {} };
      const prospect = { id: 'P1', clientId: 'C_NAT_1', estado: 'activo', etapa: 'cierre', datos: {} };

      // Configurar estado en app_core
      appCore.clients = [client];
      global.clients = [client];
      global.prospects = [prospect];
      global.DB_SUFFIX = '_prod';

      let updatePayload = null;
      global.customCallableHandler = async (name, payload) => {
        if (name === 'updateClientAdmin') {
          updatePayload = payload;
          return { status: 'updated', client: payload.client };
        }
        return { status: 'updated' };
      };

      // Mock de uploadFileToStorage
      global.uploadFileToStorage = async (file, folder, opts) => {
        uploads.push({ file: file.name, folder, opts });
        return { name: file.name, storagePath: `prod_files/${folder}/${opts.clientId}/${file.name}` };
      };

      // Input de archivo para DUI (primera carga)
      const fileInput = getOrMakeEl('closing-client-file-dui');
      fileInput.files = [{ name: 'dui_juan.pdf', size: 1024 }];

      await appCore.uploadClientDocumentFromClosing('C_NAT_1', 'P1', 'dui', false);

      expect(alerts.length).toBe(1);
      expect(alerts[0]).toMatch(/guardado y versionado exitosamente/);
      expect(uploads.length).toBe(1);
      expect(uploads[0].folder).toBe('clientes');
      expect(uploads[0].opts.clientId).toBe('C_NAT_1');
      expect(updatePayload).not.toBeNull();
      expect(updatePayload.client.documentos.dui.motivoSustitucion).toBeUndefined();
    });

    test('2. Sustitución de documento del cliente sin motivo: bloqueada antes de subir a Storage o backend', async () => {
      const client = {
        id: 'C_NAT_2',
        tipo: 'natural',
        nombres: 'María Gómez',
        documentos: { dui: { name: 'dui_viejo.pdf', storagePath: 'prod_files/clientes/C_NAT_2/dui_viejo.pdf' } }
      };
      const prospect = { id: 'P2', clientId: 'C_NAT_2', estado: 'activo', etapa: 'cierre', datos: {} };

      global.clients = [client];
      global.prospects = [prospect];

      global.uploadFileToStorage = jest.fn();

      const fileInput = getOrMakeEl('closing-client-subst-file-dui');
      fileInput.files = [{ name: 'dui_nuevo.pdf', size: 1024 }];
      const motivoInput = getOrMakeEl('closing-client-motivo-dui');
      motivoInput.value = '   '; // vacío

      await appCore.uploadClientDocumentFromClosing('C_NAT_2', 'P2', 'dui', true);

      expect(alerts.some(a => a.includes('motivo no vacío'))).toBe(true);
      expect(global.uploadFileToStorage).not.toHaveBeenCalled();
      expect(calls.length).toBe(0);
    });

    test('3. Sustitución de documento del cliente con motivo: aceptada y registrada con trazabilidad', async () => {
      const client = {
        id: 'C_NAT_3',
        tipo: 'natural',
        nombres: 'Carlos Santos',
        documentos: { dui: { name: 'dui_prev.pdf', storagePath: 'prod_files/clientes/C_NAT_3/dui_prev.pdf' } }
      };
      const prospect = { id: 'P3', clientId: 'C_NAT_3', estado: 'activo', etapa: 'cierre', datos: {} };

      global.clients = [client];
      global.prospects = [prospect];

      let updatePayload = null;
      global.customCallableHandler = async (name, payload) => {
        if (name === 'updateClientAdmin') {
          updatePayload = payload;
          return { status: 'updated', client: payload.client };
        }
        return { status: 'updated' };
      };

      global.uploadFileToStorage = async (file, folder, opts) => {
        uploads.push({ file: file.name, folder, opts });
        return { name: file.name, storagePath: `prod_files/${folder}/${opts.clientId}/${file.name}` };
      };

      const fileInput = getOrMakeEl('closing-client-subst-file-dui');
      fileInput.files = [{ name: 'dui_renovado.pdf', size: 2048 }];
      const motivoInput = getOrMakeEl('closing-client-motivo-dui');
      motivoInput.value = 'DUI renovado por vencimiento';

      await appCore.uploadClientDocumentFromClosing('C_NAT_3', 'P3', 'dui', true);

      expect(alerts.some(a => a.includes('sustituido y versionado exitosamente'))).toBe(true);
      expect(uploads.length).toBe(1);
      expect(updatePayload).not.toBeNull();
      expect(updatePayload.client.documentos.dui.motivoSustitucion).toBe('DUI renovado por vencimiento');
      expect(updatePayload.client.motivosSustitucion.dui).toBe('DUI renovado por vencimiento');
    });
  });

  describe('Criterio 4: Consulta y apertura segura de la versión vigente', () => {
    test('Apertura segura de documento delega en getSecureDownloadUrlAdmin con opciones de entidad', async () => {
      const docRef = { name: 'dui.pdf', storagePath: 'prod_files/clientes/C10/dui.pdf' };
      let callableParams = null;

      global.customCallableHandler = async (name, payload) => {
        callableParams = { name, payload };
        return { signedUrl: 'https://storage.googleapis.com/download/signed_url_test' };
      };

      await appCore.viewSecureDocument(docRef, 'DUI', { clientId: 'C10' });

      expect(callableParams).not.toBeNull();
      expect(callableParams.name).toBe('getSecureDownloadUrlAdmin');
      expect(callableParams.payload.storagePath).toBe('prod_files/clientes/C10/dui.pdf');
      expect(callableParams.payload.clientId).toBe('C10');
    });
  });

  describe('Criterio 5: Consulta del historial documental', () => {
    test('showDocumentVersionHistory consulta la subcolección document_versions y renderiza tabla ordenada', async () => {
      mockSubcollections['clients_prod/C_HIST/document_versions'] = [
        {
          docKey: 'dui',
          versionNumber: 1,
          estado: 'historica',
          name: 'dui_v1.pdf',
          creadoEn: '2026-01-10T10:00:00.000Z',
          subidoPorNombre: 'Vendedor 1',
          motivoSustitucion: null
        },
        {
          docKey: 'dui',
          versionNumber: 2,
          estado: 'vigente',
          name: 'dui_v2.pdf',
          creadoEn: '2026-02-15T15:30:00.000Z',
          subidoPorNombre: 'Carlos Mendoza',
          motivoSustitucion: 'Actualización por vencimiento'
        }
      ];

      await appCore.showDocumentVersionHistory('client', 'C_HIST', 'dui', 'DUI');

      const modalBody = domElements['docVersionHistoryBody'];
      expect(modalBody).toBeDefined();
      expect(modalBody.innerHTML).toContain('v2');
      expect(modalBody.innerHTML).toContain('Vigente');
      expect(modalBody.innerHTML).toContain('Actualización por vencimiento');
      expect(modalBody.innerHTML).toContain('v1');
      expect(modalBody.innerHTML).toContain('Histórica');
    });

    test('showDocumentVersionHistory maneja sin error cuando no hay versiones previas', async () => {
      mockSubcollections['clients_prod/C_EMPTY/document_versions'] = [];

      await appCore.showDocumentVersionHistory('client', 'C_EMPTY', 'dui', 'DUI');

      const modalBody = domElements['docVersionHistoryBody'];
      expect(modalBody.innerHTML).toContain('No se registran versiones anteriores archivadas');
    });
  });

  describe('Criterio 7: Sustitución de oferta firmada con advertencia de reautorización', () => {
    test('Panel muestra advertencia visible cuando la oferta ya existe y la autorización sin contrato está activa', () => {
      const prospect = {
        id: 'P_AUT',
        clientId: 'C1',
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 15000,
        datos: {
          doc_firmado: { name: 'oferta_antigua.pdf' },
          autorizado_sin_contrato: true
        },
        aprobacion_sin_contrato: { estado: 'aprobada' }
      };

      global.prospects = [prospect];
      global.clients = [{ id: 'C1', tipo: 'natural', documentos: {} }];

      const container = getOrMakeEl('advance-form-container');
      appCore.renderClosingDocumentationPanel(prospect);

      expect(container.innerHTML).toContain('Sustituir este documento invalidará automáticamente la autorización para cerrar sin contrato');
    });

    test('Panel muestra alerta roja de autorización invalidada cuando el estado es invalidada_por_sustitucion', () => {
      const prospect = {
        id: 'P_INV',
        clientId: 'C1',
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 15000,
        datos: {
          doc_firmado: { name: 'oferta_nueva.pdf' },
          autorizado_sin_contrato: false
        },
        aprobacion_sin_contrato: { estado: 'invalidada_por_sustitucion', motivo_decision: 'Oferta sustituida' }
      };

      global.prospects = [prospect];
      global.clients = [{ id: 'C1', tipo: 'natural', documentos: {} }];

      const container = getOrMakeEl('advance-form-container');
      appCore.renderClosingDocumentationPanel(prospect);

      expect(container.innerHTML.toLowerCase()).toContain('autorización invalidada por sustitución');
      expect(container.innerHTML).toContain('reautorice la nueva oferta antes de poder finalizar el cierre');
    });

    test('finalizeOpportunity bloquea finalización si la autorización está invalidada por sustitución', async () => {
      const prospect = {
        id: 'P_BLOCKED',
        clientId: 'C1',
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 20000,
        datos: {
          doc_firmado: { name: 'oferta_nueva.pdf' },
          forma_pago: '50/50',
          encargado_instalacion: 'Juan Instalador'
        },
        aprobacion_sin_contrato: { estado: 'invalidada_por_sustitucion' }
      };

      global.prospects = [prospect];
      global.clients = [{ id: 'C1', tipo: 'natural', documentos: { dui: { name: 'dui.pdf' } } }];

      await appCore.finalizeOpportunity('P_BLOCKED');

      expect(alerts.some(a => a.includes('fue invalidada') && a.includes('sustitución'))).toBe(true);
      expect(calls.length).toBe(0);
    });
  });

  describe('Criterio 8: Sustitución de otro documento sin invalidación comercial falsa', () => {
    test('Sustitución de comprobante no muestra advertencia de invalidación de contrato', () => {
      const prospect = {
        id: 'P_COMP',
        clientId: 'C1',
        etapa: 'cierre',
        estado: 'activo',
        datos: {
          doc_firmado: { name: 'oferta.pdf' },
          doc_comprobante: { name: 'comprobante_anterior.pdf' },
          autorizado_sin_contrato: true
        },
        aprobacion_sin_contrato: { estado: 'aprobada' }
      };

      global.prospects = [prospect];
      global.clients = [{ id: 'C1', tipo: 'natural', documentos: {} }];

      const container = getOrMakeEl('advance-form-container');
      appCore.renderClosingDocumentationPanel(prospect);

      const comprobanteSection = container.innerHTML.slice(container.innerHTML.indexOf('Copia de Factura o Comprobante'));
      expect(comprobanteSection).not.toContain('invalidará automáticamente la autorización para cerrar sin contrato');
    });
  });

  describe('Criterio 9: Errores de permisos y validaciones visibles', () => {
    test('Si el backend rechaza la actualización de cliente, el mensaje de error es presentado al usuario', async () => {
      const client = { id: 'C_ERR', tipo: 'natural', documentos: {} };
      const prospect = { id: 'P_ERR', clientId: 'C_ERR', estado: 'activo', etapa: 'cierre', datos: {} };

      global.clients = [client];
      global.prospects = [prospect];

      global.uploadFileToStorage = async (file, folder, opts) => ({ name: file.name, storagePath: 'test_path' });

      global.customCallableHandler = async () => {
        const err = new Error('No tienes permisos suficientes para actualizar este cliente');
        err.code = 'functions/permission-denied';
        throw err;
      };

      const fileInput = getOrMakeEl('closing-client-file-dui');
      fileInput.files = [{ name: 'dui_test.pdf', size: 1024 }];

      await appCore.uploadClientDocumentFromClosing('C_ERR', 'P_ERR', 'dui', false);

      expect(alerts.some(a => a.includes('Error al registrar documento') && a.includes('permiso'))).toBe(true);
    });
  });

  describe('Criterio 10: Prevención de doble envío', () => {
    test('Botón activo se deshabilita mientras dura la subida y registro', async () => {
      const client = { id: 'C_DBL', tipo: 'natural', documentos: {} };
      const prospect = { id: 'P_DBL', clientId: 'C_DBL', estado: 'activo', etapa: 'cierre', datos: {} };

      global.clients = [client];
      global.prospects = [prospect];

      const triggerButton = {
        tagName: 'BUTTON',
        disabled: false,
        innerHTML: '💾 Subir'
      };
      global.document.activeElement = triggerButton;

      let buttonStateDuringCall = null;
      global.uploadFileToStorage = async (file, folder, opts) => {
        buttonStateDuringCall = {
          disabled: triggerButton.disabled,
          innerHTML: triggerButton.innerHTML
        };
        return { name: file.name, storagePath: 'test_path' };
      };
      global.customCallableHandler = async () => {
        return { status: 'updated' };
      };

      const fileInput = getOrMakeEl('closing-client-file-dui');
      fileInput.files = [{ name: 'dui_test.pdf', size: 1024 }];

      await appCore.uploadClientDocumentFromClosing('C_DBL', 'P_DBL', 'dui', false);

      expect(buttonStateDuringCall).not.toBeNull();
      expect(buttonStateDuringCall.disabled).toBe(true);
      expect(buttonStateDuringCall.innerHTML).toContain('Subiendo');
      expect(triggerButton.disabled).toBe(false);
    });
  });

  describe('Criterio 11: Oportunidad ganada con edición bloqueada', () => {
    test('renderClosingDocumentationPanel desactiva inputs y sustitución si estado es ganado', () => {
      const prospect = {
        id: 'P_WON',
        clientId: 'C_WON',
        etapa: 'cierre',
        estado: 'ganado',
        datos: {
          doc_firmado: { name: 'oferta_ganada.pdf' },
          doc_comprobante: { name: 'comprobante_ganado.pdf' }
        }
      };
      const client = {
        id: 'C_WON',
        tipo: 'natural',
        documentos: { dui: { name: 'dui_ganado.pdf' } }
      };

      global.prospects = [prospect];
      global.clients = [client];

      const container = getOrMakeEl('advance-form-container');
      appCore.renderClosingDocumentationPanel(prospect);

      expect(container.innerHTML).toContain('disabled');
      expect(container.innerHTML).not.toContain('toggleClientDocSubstForm');
      expect(container.innerHTML).not.toContain('toggleProspectDocSubstForm');
    });

    test('saveClosingProgress bloquea mutaciones si la oportunidad ya está ganada', async () => {
      const prospect = { id: 'P_WON', estado: 'ganado', datos: {} };
      global.prospects = [prospect];

      await appCore.saveClosingProgress('P_WON');

      expect(alerts.some(a => a.includes('ya ganada'))).toBe(true);
      expect(calls.length).toBe(0);
    });
  });

  describe('Criterio 12: Compatibilidad de tipos de cliente', () => {
    test('Cliente persona jurídica renderiza Escritura, Credencial, NIT, NRC y Mods en lugar de DUI personal', () => {
      const client = {
        id: 'C_JUR',
        tipo: 'juridica',
        empresa: 'Corporación Acero SA de CV',
        documentos: {
          escritura: { name: 'escritura.pdf' },
          nit: { name: 'nit.pdf' }
        }
      };
      const prospect = { id: 'P_JUR', clientId: 'C_JUR', etapa: 'cierre', estado: 'activo', datos: {} };

      global.clients = [client];
      global.prospects = [prospect];

      const container = getOrMakeEl('advance-form-container');
      appCore.renderClosingDocumentationPanel(prospect);

      expect(container.innerHTML).toContain('Escritura de Constitución');
      expect(container.innerHTML).toContain('Credencial Rep. Legal');
      expect(container.innerHTML).toContain('NIT Empresa');
      expect(container.innerHTML).toContain('NRC Empresa');
      expect(container.innerHTML).not.toContain('DUI Personal');
    });
  });
});
