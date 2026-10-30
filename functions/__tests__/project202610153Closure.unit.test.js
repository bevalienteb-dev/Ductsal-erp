// functions/__tests__/project202610153Closure.unit.test.js
// Pruebas de regresión y validación para el cierre del Proyecto 202610153 (Alejandra Ayala - GRADO 0)
// Verifica requisitos obligatorios reales, mensajes al usuario y finalización exitosa con expediente completo.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

global.window = {
  location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
  _docStore: new Map()
};
const mockFirestore = {
  settings: () => {},
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      onSnapshot: jest.fn(() => jest.fn()),
      get: async () => ({ exists: false, data: () => ({}) })
    })),
    onSnapshot: jest.fn(() => jest.fn()),
    where: jest.fn(() => ({ onSnapshot: jest.fn(() => jest.fn()) }))
  }))
};
global.firebase = {
  initializeApp: () => ({}),
  firestore: () => mockFirestore,
  storage: () => ({ ref: () => ({}) }),
  auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged: jest.fn() }),
  functions: () => ({ httpsCallable: () => async () => ({ data: {} }) })
};
global.localStorage = {
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.Chart = jest.fn(() => ({ destroy: jest.fn(), update: jest.fn() }));
global.Chart.defaults = { color: '', font: {} };
global.db = mockFirestore;
global.DB_SUFFIX = '_prod';
const CrmFollowUpCalc = require('../crm_followup_calc');
global.CrmFollowUpCalc = CrmFollowUpCalc;
global.window.CrmFollowUpCalc = CrmFollowUpCalc;

let domElements = {};
function makeMockEl(id, initial = {}) {
  const el = Object.assign({
    id,
    tagName: 'DIV',
    value: '',
    style: {},
    dataset: {},
    files: [],
    options: [],
    children: [],
    textContent: '',
    innerHTML: '',
    disabled: false,
    classList: { add: jest.fn(), remove: jest.fn(), contains: jest.fn() }
  }, initial);
  domElements[id] = el;
  return el;
}

global.document = {
  getElementById: (id) => domElements[id] || makeMockEl(id),
  createElement: (tag) => makeMockEl(`dyn_${Math.random()}`, { tagName: tag.toUpperCase() }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: jest.fn()
};
global.alert = jest.fn();
global.confirm = jest.fn(() => false);

const appCore = require('../../app_core');

const CLOCK = new Date('2026-10-29T12:00:00.000Z');

function makeEnv(customClock = CLOCK) {
  const fdb = createFakeFirestore({ clock: () => customClock });
  const live = { ok: true, calls: [] };
  const service = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => customClock,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });
  const wf = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: service.kit });
  const caller = (role, cid = 'ALEJANDRA-AYALA') => ({
    uid: `uid_${cid}`,
    cid,
    name: 'Alejandra Ayala',
    role
  });
  return { fdb, service, wf, caller, live, now: customClock };
}

const fileObj = (name, folder = 'proyectos') => ({
  name,
  storagePath: `prod_files/${folder}/1792004940382/${name}`
});

describe('Proyecto 202610153 (GRADO 0 - $185.48) — Diagnóstico y Validación de Cierre', () => {

  const baseClient = {
    id: '1792004495514',
    tipo: 'juridica',
    empresa: 'GRADO 0 S.A. DE C.V.',
    contacto: 'Contacto GRADO 0',
    telefono: '2200-1122',
    correo: 'contacto@grado0.com',
    correo_fact: 'facturacion@grado0.com',
    nit: '0614-010120-101-9',
    nrc: '987654-3',
    documentos: {
      dui: '02345678-9' // El cliente SI cuenta con DUI en su ficha
    }
  };

  const baseProject202610153 = {
    id: '1792004940382',
    codigo: '202610153',
    proyecto: '4 METROS',
    clientId: '1792004495514',
    vendedorId: 'ALEJANDRA-AYALA',
    createdBy: 'ALEJANDRA-AYALA',
    encargado: 'Alejandra Ayala',
    etapa: 'cierre',
    estado: 'activo',
    precio_cotizado: 185.48, // Menor a $10,000
    costo_venta: 0,
    tipo_proyecto: 'Fabricación', // Fabricación (NO requiere contrato ni autorización especial de gerencia)
    clasificacion: 'ejecucion',
    fecha_creacion: '2026-10-15',
    fecha_inicio_cierre: '2026-10-15',
    datos: {} // Vacío en producción
  };

  describe('1. Verificación de requisitos obligatorios del servidor (prospectWorkflowService)', () => {

    test('1.1 Falla si falta doc_firmado (Oferta firmada)', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/1792004495514', baseClient);
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProject202610153,
        datos: {
          doc_comprobante: fileObj('comprobante_anticipo.pdf', 'facturas'),
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-099'
        }
      });

      await expect(wf.finalizeProspect({
        caller: caller('gestor'),
        prospectId: '1792004940382',
        data: {}
      })).rejects.toThrow(/Debe adjuntar la oferta firmada para finalizar/i);
    });

    test('1.2 Falla si falta doc_comprobante (Comprobante / CCF de anticipo)', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/1792004495514', baseClient);
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProject202610153,
        datos: {
          doc_firmado: fileObj('oferta_firmada_4m.pdf', 'proyectos'),
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-099'
        }
      });

      await expect(wf.finalizeProspect({
        caller: caller('gestor'),
        prospectId: '1792004940382',
        data: {}
      })).rejects.toThrow(/Debe adjuntar el comprobante o factura de anticipo para finalizar/i);
    });

    test('1.3 Falla si falta factura_anticipo', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/1792004495514', baseClient);
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProject202610153,
        datos: {
          doc_firmado: fileObj('oferta_firmada_4m.pdf', 'proyectos'),
          doc_comprobante: fileObj('comprobante_anticipo.pdf', 'facturas'),
          forma_pago: '100% anticipado'
          // factura_anticipo ausente
        }
      });

      await expect(wf.finalizeProspect({
        caller: caller('gestor'),
        prospectId: '1792004940382',
        data: {}
      })).rejects.toThrow(/El número de factura de anticipo es obligatorio/i);
    });

    test('1.4 Falla si falta forma_pago o es inválida', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/1792004495514', baseClient);
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProject202610153,
        datos: {
          doc_firmado: fileObj('oferta_firmada_4m.pdf', 'proyectos'),
          doc_comprobante: fileObj('comprobante_anticipo.pdf', 'facturas'),
          factura_anticipo: 'FCF-099'
          // forma_pago ausente
        }
      });

      await expect(wf.finalizeProspect({
        caller: caller('gestor'),
        prospectId: '1792004940382',
        data: {}
      })).rejects.toThrow(/Forma de pago inválida/i);
    });

    test('1.5 Proyecto 202610153 NO requiere autorización de gerencia ni contrato por ser Fabricación de $185.48', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/1792004495514', baseClient);
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProject202610153,
        // Sin autorización de gerencia (autorizado_sin_contrato: undefined o false)
      });

      // Se proporcionan los 4 recaudos legítimos
      const result = await wf.finalizeProspect({
        caller: caller('gestor'),
        prospectId: '1792004940382',
        data: {
          doc_firmado: fileObj('oferta_firmada_4m.pdf', 'proyectos'),
          doc_comprobante: fileObj('recibo_pago_anticipo.pdf', 'facturas'),
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-101'
        }
      });

      expect(result.status).toBe('finalized');
      expect(result.etapa).toBe('cierre');
      expect(result.estado).toBe('ganado');

      // Verificar persistencia en Firestore
      const snap = await fdb.collection('prospects_prod').doc('1792004940382').get();
      const updated = snap.data();
      expect(updated.estado).toBe('ganado');
      expect(updated.postcierre_habilitado).toBe(true);
      expect(updated.datos.factura_anticipo).toBe('FCF-101');
      expect(updated.forma_pago).toBe('100% anticipado');
      expect(updated.datos.doc_firmado.name).toBe('oferta_firmada_4m.pdf');
      expect(updated.datos.doc_comprobante.name).toBe('recibo_pago_anticipo.pdf');
    });
  });

  describe('2. Verificación de validación y mensajes de la UI cliente (app_core.js)', () => {

    beforeEach(() => {
      domElements = {};
      makeMockEl('closing-forma-pago', { value: '' });
      makeMockEl('closing-fac-anticipo', { value: '' });
      makeMockEl('closing-encargado', { value: '' });
      makeMockEl('closing-file-doc-firmado', { files: [] });
      makeMockEl('closing-file-doc-comprobante', { files: [] });
      makeMockEl('closing-motivo-doc-firmado', { value: '' });
      makeMockEl('closing-motivo-doc-comprobante', { value: '' });

      jest.clearAllMocks();
      global.confirm = jest.fn(() => false);
    });

    test('2.1 Si faltan los 4 requisitos, finalizeOpportunity() muestra el listado exacto de pendientes sin mencionar gerencia ni contrato', async () => {
      appCore.setCurrentUser({ id: 'ALEJANDRA', role: 'gestor', nombre: 'Alejandra Ayala' });
      appCore.setClients([baseClient]);
      appCore.setProspects([baseProject202610153]);

      await appCore.finalizeOpportunity('1792004940382');

      expect(global.alert).toHaveBeenCalled();
      const alertMsg = global.alert.mock.calls[0][0];

      // Debe listar los 4 campos faltantes
      expect(alertMsg).toContain('Forma de pago pactada');
      expect(alertMsg).toContain('Número de factura de anticipo');
      expect(alertMsg).toContain('Oferta firmada por cliente');
      expect(alertMsg).toContain('Copia de factura o comprobante de anticipo');

      // NO debe mencionar falsamente requerimientos de gerencia ni contrato
      expect(alertMsg).not.toContain('Contrato firmado escaneado');
      expect(alertMsg).not.toContain('Documentos legales corporativos');
      expect(alertMsg).not.toContain('autorización');
    });

    test('2.2 Si solo falta el número de factura de anticipo, el mensaje señala únicamente ese campo', async () => {
      appCore.setCurrentUser({ id: 'ALEJANDRA', role: 'gestor', nombre: 'Alejandra Ayala' });
      appCore.setClients([baseClient]);
      appCore.setProspects([{
        ...baseProject202610153,
        datos: {
          doc_firmado: { name: 'oferta.pdf' },
          doc_comprobante: { name: 'comprobante.pdf' },
          forma_pago: '100% anticipado'
          // factura_anticipo falta
        }
      }]);

      await appCore.finalizeOpportunity('1792004940382');

      expect(global.alert).toHaveBeenCalled();
      const alertMsg = global.alert.mock.calls[0][0];

      expect(alertMsg).toContain('Número de factura de anticipo');
      expect(alertMsg).not.toContain('Oferta firmada por cliente');
      expect(alertMsg).not.toContain('Copia de factura o comprobante de anticipo');
      expect(alertMsg).not.toContain('Forma de pago pactada');
    });
  });
});
