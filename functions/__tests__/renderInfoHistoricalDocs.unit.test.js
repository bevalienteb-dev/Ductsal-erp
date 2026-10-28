// functions/__tests__/renderInfoHistoricalDocs.unit.test.js
// UNIT TEST SUITE: Compatibilidad de documentos históricos y renderizado seguro
// Previene regresiones del incidente crítico de Fase 4B (ReferenceError: docKey is not defined y aliases de clientes)

const fs = require('fs');
const path = require('path');

const alerts = [];
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

global.document = {
  getElementById: (id) => domElements[id] || getOrMakeEl(id),
  createElement: (tag) => ({
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    classList: { add: jest.fn(), remove: jest.fn() },
    innerHTML: '',
    textContent: '',
    appendChild: jest.fn()
  }),
  body: {
    appendChild: (node) => {
      if (node && node.id) domElements[node.id] = node;
    }
  },
  addEventListener: jest.fn(),
  activeElement: null
};

global.alert = (m) => alerts.push(m);
global.confirm = () => true;

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
        get: async () => ({ forEach: () => {} })
      })
    })
  })
};

global.db = mockFirestore;
global.firebase = {
  initializeApp: () => ({}),
  firestore: () => mockFirestore,
  storage: () => ({ ref: () => ({}) }),
  auth: () => ({ currentUser: { uid: 'test-user-123' } }),
  functions: () => ({
    httpsCallable: () => async () => ({
      data: {
        status: 'ok',
        downloadUrl: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/test.pdf?alt=media&token=123'
      }
    })
  })
};

// Cargar módulos
const CrmCommercial = require('../../crm_commercial');
const CrmClients = require('../../crm_clients');
global.CrmClients = CrmClients;
global.window.CrmClients = CrmClients;
global.CrmCommercial = CrmCommercial;
global.window.CrmCommercial = CrmCommercial;
const appCore = require('../../app_core');

describe('Compatibilidad de Documentos Históricos y Renderizado Seguro (Incidente Crítico Fase 4B)', () => {
  beforeEach(() => {
    alerts.length = 0;
    for (const k in domElements) delete domElements[k];
    if (global.window._docStore) global.window._docStore.clear();
  });

  describe('1. renderInfo(p) — Renderizado de documentos del prospecto sin ReferenceError', () => {
    test('Debe renderizar documentos con objeto estándar { name, url } sin arrojar ReferenceError: docKey', () => {
      const prospect = {
        id: 'P_TEST_OBJ',
        cliente: 'Cliente Prueba 1',
        etapa: 'propuesta',
        estado: 'activo',
        datos: {
          doc_oferta: {
            name: 'Propuesta_Tecnica_2026.pdf',
            url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2FP_TEST_OBJ%2FPropuesta_Tecnica_2026.pdf?alt=media&token=abc-123'
          }
        }
      };

      const docsList = getOrMakeEl('docs-list');
      const docsBadge = getOrMakeEl('docs-count-badge');

      expect(() => {
        appCore.renderInfo(prospect);
      }).not.toThrow();

      expect(docsBadge.textContent).toBe('1 doc');
      expect(docsList.innerHTML).toContain('Propuesta_Tecnica_2026.pdf');
      expect(docsList.innerHTML).toContain('📜 Historial');
    });

    test('Debe soportar documentos históricos que son solo strings (ej. "COTIZACION.pdf") sin fallar', () => {
      const prospectLegacy = {
        id: '1777072883747',
        cliente: 'Cliente Histórico Legacy',
        etapa: 'cerrado',
        estado: 'ganado',
        datos: {
          doc_oferta: 'GILDAN - INSTALACION DE DUCTO.pdf'
        }
      };

      const docsList = getOrMakeEl('docs-list');
      const docsBadge = getOrMakeEl('docs-count-badge');

      expect(() => {
        appCore.renderInfo(prospectLegacy);
      }).not.toThrow();

      expect(docsBadge.textContent).toBe('1 doc');
      expect(docsList.innerHTML).toContain('GILDAN - INSTALACION DE DUCTO.pdf');
      expect(docsList.innerHTML).toContain('Registro histórico');
      expect(docsList.innerHTML).toContain('📜 Historial');
      // No debe contener el botón de descarga directa rota para string sin storage url
      expect(docsList.innerHTML).not.toContain('downloadSecureDocument');
    });

    test('Debe renderizar múltiples documentos en objetos variados incluyendo doc_firmado y comprobante sin interrupciones', () => {
      const prospectMulti = {
        id: 'P_MULTI_DOCS',
        cliente: 'Cliente Complejo',
        etapa: 'cierre',
        estado: 'activo',
        datos: {
          doc_levantamiento: { name: 'Levantamiento.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Fplanos.pdf?alt=media' },
          doc_oferta: { name: 'Oferta_Final.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Foferta.pdf?alt=media' },
          doc_firmado: { name: 'Oferta_Firmada.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Ffirmada.pdf?alt=media' },
          doc_comprobante: { name: 'Comprobante_Pago.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Fcomp.pdf?alt=media' }
        },
        facturas: [
          { numero: 'FAC-001', doc_factura: { name: 'Factura_001.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2Fp1%2Ffac.pdf?alt=media' } }
        ]
      };

      const docsList = getOrMakeEl('docs-list');
      const docsBadge = getOrMakeEl('docs-count-badge');

      expect(() => {
        appCore.renderInfo(prospectMulti);
      }).not.toThrow();

      expect(docsBadge.textContent).toBe('5 docs');
      expect(docsList.innerHTML).toContain('Levantamiento.pdf');
      expect(docsList.innerHTML).toContain('Oferta_Final.pdf');
      expect(docsList.innerHTML).toContain('Oferta_Firmada.pdf');
      expect(docsList.innerHTML).toContain('Comprobante_Pago.pdf');
      expect(docsList.innerHTML).toContain('Factura_001.pdf');
    });
  });

  describe('2. renderClosingDocumentationPanel(p) — Mapeo de aliases de documentos de cliente', () => {
    test('Debe resolver aliases históricos de clientes (dui_rep, escritura_constitucion, etc.) como presentes', () => {
      const client = {
        id: 'CLI_JUR_HISTORICO',
        tipo: 'juridica',
        nombre_empresa: 'Constructora Ductos SA de CV',
        documentos: {
          dui_rep: { name: 'DUI_Representante.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_JUR_HISTORICO%2FDUI_Representante.pdf?alt=media' },
          escritura_constitucion: { name: 'Escritura_Constitucion.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_JUR_HISTORICO%2FEscritura_Constitucion.pdf?alt=media' },
          nrc_empresa: { name: 'NRC_Empresa.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_JUR_HISTORICO%2FNRC_Empresa.pdf?alt=media' }
        }
      };

      const prospect = {
        id: 'P_CLOSING_HIST',
        clientId: 'CLI_JUR_HISTORICO',
        etapa: 'cierre',
        estado: 'activo',
        tipo_proyecto: 'Fabricación e instalación',
        precio_cotizado: 15000,
        datos: {
          doc_firmado: { name: 'Contrato_Firmado.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2FP_CLOSING_HIST%2FContrato_Firmado.pdf?alt=media' },
          doc_comprobante: { name: 'Quedan_Anticipo.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2FP_CLOSING_HIST%2FQuedan_Anticipo.pdf?alt=media' }
        }
      };

      appCore.clients = [client];
      global.clients = [client];
      global.prospects = [prospect];

      const advanceContainer = getOrMakeEl('advance-form-container');

      expect(() => {
        appCore.renderClosingDocumentationPanel(prospect);
      }).not.toThrow();

      const panelHtml = advanceContainer.innerHTML;
      // Debe detectar que el DUI, la Escritura y el NRC están cargados (no marcar como "No adjunto")
      expect(panelHtml).toContain('DUI_Representante.pdf');
      expect(panelHtml).toContain('Escritura_Constitucion.pdf');
      expect(panelHtml).toContain('NRC_Empresa.pdf');
      
      // Debe contener llamadas a viewStoredClientDoc y downloadStoredClientDoc
      expect(panelHtml).toContain('viewStoredClientDoc');
      expect(panelHtml).toContain('downloadStoredClientDoc');

      // Los documentos del prospecto (doc_firmado y doc_comprobante) también deben usar el docStore seguro
      expect(panelHtml).toContain('Contrato_Firmado.pdf');
      expect(panelHtml).toContain('Quedan_Anticipo.pdf');
    });

    test('Invocar viewStoredClientDoc y downloadStoredClientDoc con storeId válido no debe arrojar alertas de documento no especificado', async () => {
      const dummyDoc = {
        name: 'DUI_Representante.pdf',
        url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_1%2FDUI_Representante.pdf?alt=media'
      };

      const storeId = 'test_store_123';
      appCore.getDocStore().set(storeId, {
        docRef: dummyDoc,
        fileName: dummyDoc.name,
        clientId: 'CLI_1'
      });

      expect(() => {
        appCore.viewStoredClientDoc(storeId);
      }).not.toThrow();
      expect(alerts).toHaveLength(0);

      expect(() => {
        appCore.downloadStoredClientDoc(storeId);
      }).not.toThrow();
      expect(alerts).toHaveLength(0);
    });
  });

  describe('3. renderClientExpedienteSection(c) — Renderizado seguro de expediente del cliente', () => {
    test('Debe renderizar todos los documentos del cliente natural y jurídico sin errores de undefined', () => {
      const naturalClient = {
        id: 'CLI_NAT_01',
        tipo: 'natural',
        nombres: 'Roberto',
        apellidos: 'Flores',
        documentos: {
          dui: { name: 'DUI_Roberto.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_NAT_01%2FDUI_Roberto.pdf?alt=media' },
          nit: { name: 'NIT_Roberto.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FCLI_NAT_01%2FNIT_Roberto.pdf?alt=media' }
        }
      };

      const sectionEl = getOrMakeEl('client-expediente-section');
      const listEl = getOrMakeEl('client-docs-list');
      const badgeEl = getOrMakeEl('client-docs-count-badge');

      expect(() => {
        appCore.renderClientExpedienteSection(naturalClient);
      }).not.toThrow();

      const html = listEl.innerHTML;
      expect(html).toContain('DUI_Roberto.pdf');
      expect(html).toContain('NIT_Roberto.pdf');
      expect(html).toContain('viewStoredClientDoc');
      expect(html).toContain('downloadStoredClientDoc');
      expect(badgeEl.textContent).toBe('2 documentos');
    });
  });
});
