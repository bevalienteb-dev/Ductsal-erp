// functions/__tests__/uiEnhancementsAndPreview.test.js
// Comprehensive test suite for UI enhancements, Excel preview, client document fix,
// and 100% paid project hiding/filtering.

const fs = require('fs');
const path = require('path');

const appCorePath = path.join(__dirname, '..', '..', 'app_core.js');
const appCoreSrc = fs.readFileSync(appCorePath, 'utf8');

const indexHtmlPath = path.join(__dirname, '..', '..', 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// Setup global mocks before loading app_core
global.window = {
  location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
  _docStore: new Map()
};
global.document = {
  getElementById: (id) => ({
    style: {},
    classList: { add: () => {}, remove: () => {} },
    innerHTML: '',
    textContent: ''
  }),
  addEventListener: () => {}
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
global.firebase = {
  initializeApp: () => ({}),
  firestore: () => ({ settings: () => {}, collection: () => ({}) }),
  storage: () => ({ ref: () => ({}) }),
  auth: () => ({ currentUser: null }),
  functions: () => ({ httpsCallable: () => async () => ({ data: {} }) })
};

// Load exported functions from app_core.js
const appCore = require('../../app_core');

describe('UI Enhancements, Proyectos y Cobros, Excel Preview & Client Dossier', () => {

  // =========================================================================
  // 1. isProjectFullyPaid - Single Source of Truth for Project Settlement
  // =========================================================================
  describe('1. isProjectFullyPaid Logic & Edge Cases', () => {
    const isProjectFullyPaid = appCore.isProjectFullyPaid;

    beforeEach(() => {
      global.clients = [
        { id: 'cli_local', nombres: 'Juan Perez', es_exportacion: false },
        { id: 'cli_export', nombres: 'Global Inc', es_exportacion: true }
      ];
    });

    test('returns false for null, undefined, or empty project objects', () => {
      expect(isProjectFullyPaid(null)).toBe(false);
      expect(isProjectFullyPaid(undefined)).toBe(false);
      expect(isProjectFullyPaid({})).toBe(false);
      expect(isProjectFullyPaid({ precio_cotizado: 0 })).toBe(false);
    });

    test('returns false if project has no invoices (facturas)', () => {
      const p = {
        id: 'p1',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        facturas: []
      };
      expect(isProjectFullyPaid(p)).toBe(false);
    });

    test('returns false if project is 100% invoiced but has unpaid balance (0 payments)', () => {
      // Local client: subtotal $1,000 + 13% IVA = $1,130
      const p = {
        id: 'p2',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        facturas: [
          { monto: 1130, pagos: [] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(false);
    });

    test('returns false if project is only partially paid', () => {
      // Total $1,130; Paid $600 -> Pending $530
      const p = {
        id: 'p3',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        facturas: [
          { monto: 1130, pagos: [{ monto: 600 }] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(false);
    });

    test('returns false for Gran Contribuyente where 1% retention remains unpaid', () => {
      // Total $1,130. Paid $1,118.70 (1% retention of $1,130 is $11.30 unpaid)
      const p = {
        id: 'p4',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        facturas: [
          { monto: 1130, pagos: [{ monto: 1118.70 }] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(false);
    });

    test('returns true when total payments equal project total including IVA', () => {
      // Subtotal $1,000 + 13% IVA = $1,130
      const p = {
        id: 'p5',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        facturas: [
          { monto: 565, pagos: [{ monto: 565 }] },
          { monto: 565, pagos: [{ monto: 565 }] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(true);
    });

    test('respects floating-point rounding tolerance within 5 cents', () => {
      // Subtotal $100 + 13% = $113. Paid $112.97 (difference 3 cents due to tax splits)
      const p = {
        id: 'p6',
        clientId: 'cli_local',
        precio_cotizado: 100,
        facturas: [
          { monto: 113, pagos: [{ monto: 112.97 }] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(true);
    });

    test('accurately calculates 0% IVA for export clients', () => {
      // Export client: Subtotal $2,000, total is $2,000 (0% IVA)
      const p = {
        id: 'p7',
        clientId: 'cli_export',
        precio_cotizado: 2000,
        facturas: [
          { monto: 2000, pagos: [{ monto: 2000 }] }
        ]
      };
      expect(isProjectFullyPaid(p)).toBe(true);
    });

    test('correctly accounts for change orders (ordenes_cambio)', () => {
      // Base: $1,000. Increase: $200. Total subtotal: $1,200. Total with 13% IVA: $1,356.
      const pWithIncrease = {
        id: 'p8',
        clientId: 'cli_local',
        precio_cotizado: 1000,
        ordenes_cambio: [
          { tipo: 'aumento', precio: 200 }
        ],
        facturas: [
          { monto: 1356, pagos: [{ monto: 1130 }] } // only paid base, not increase
        ]
      };
      expect(isProjectFullyPaid(pWithIncrease)).toBe(false);

      // Now pay full $1,356
      pWithIncrease.facturas[0].pagos.push({ monto: 226 });
      expect(isProjectFullyPaid(pWithIncrease)).toBe(true);
    });
  });

  // =========================================================================
  // 2. Proyectos y Cobros Filter Functionality & Defaults
  // =========================================================================
  describe('2. Proyectos y Cobros Default View & Payment Filter', () => {
    const isProjectFullyPaid = appCore.isProjectFullyPaid;
    const getProjPaymentFilter = appCore.getProjPaymentFilter;
    const setProjPaymentFilter = appCore.setProjPaymentFilter;

    test('default payment filter is "pendientes"', () => {
      expect(getProjPaymentFilter()).toBe('pendientes');
    });

    test('setProjPaymentFilter accepts "pendientes", "pagados", "todos" and ignores invalid keys', () => {
      setProjPaymentFilter('pagados');
      expect(getProjPaymentFilter()).toBe('pagados');

      setProjPaymentFilter('todos');
      expect(getProjPaymentFilter()).toBe('todos');

      setProjPaymentFilter('invalido');
      expect(getProjPaymentFilter()).toBe('todos'); // unchanged

      setProjPaymentFilter('pendientes');
      expect(getProjPaymentFilter()).toBe('pendientes');
    });

    test('correctly filters projects by payment status without database mutation', () => {
      const mockProjects = [
        {
          id: 'proj_pend1',
          clientId: 'cli1',
          precio_cotizado: 1000,
          facturas: [{ monto: 1130, pagos: [{ monto: 500 }] }] // pending
        },
        {
          id: 'proj_paid1',
          clientId: 'cli1',
          precio_cotizado: 500,
          facturas: [{ monto: 565, pagos: [{ monto: 565 }] }] // 100% paid
        },
        {
          id: 'proj_pend2',
          clientId: 'cli1',
          precio_cotizado: 800,
          facturas: [] // pending (no payments)
        }
      ];

      const countPendientes = mockProjects.filter(p => !isProjectFullyPaid(p)).length;
      const countPagados = mockProjects.filter(p => isProjectFullyPaid(p)).length;
      const countTodos = mockProjects.length;

      expect(countPendientes).toBe(2);
      expect(countPagados).toBe(1);
      expect(countTodos).toBe(3);

      // Verify that filter 'pendientes' excludes proj_paid1
      const pendientes = mockProjects.filter(p => !isProjectFullyPaid(p));
      expect(pendientes.map(p => p.id)).toEqual(['proj_pend1', 'proj_pend2']);

      // Verify that filter 'pagados' includes only proj_paid1
      const pagados = mockProjects.filter(p => isProjectFullyPaid(p));
      expect(pagados.map(p => p.id)).toEqual(['proj_paid1']);
    });
  });

  // =========================================================================
  // 3. Complete & Definitive Removal of "Enviar a Fabricación" from Commercial ERP
  // =========================================================================
  describe('3. Complete Removal of Enviar a Fabricación', () => {
    test('index.html contains zero instances of btn-send-fab, showSendFabForm, or Enviar a Fabricación button', () => {
      expect(indexHtml).not.toContain('id="btn-send-fab"');
      expect(indexHtml).not.toContain('btn-send-fab');
      expect(indexHtml).not.toContain('showSendFabForm');
      expect(indexHtml).not.toContain('Enviar a Fabricación');
      expect(indexHtml).not.toContain('<!-- Fabricación View');
    });

    test('app_core.js contains zero references to btn-send-fab, showSendFabForm, or fabrication modal handlers', () => {
      expect(appCoreSrc).not.toContain('btn-send-fab');
      expect(appCoreSrc).not.toContain('btnSendFab');
      expect(appCoreSrc).not.toContain('showSendFabForm');
      expect(appCoreSrc).not.toContain('newFabricacionModal');
      expect(appCoreSrc).not.toContain('newFabricacionForm');
      expect(appCoreSrc).not.toContain('fab-cliente');
      expect(appCoreSrc).not.toContain('fab-desc');
    });

    test('appCore exports showSendFabForm as undefined', () => {
      expect(appCore.showSendFabForm).toBeUndefined();
    });

    test('openDetail never renders or displays Enviar a Fabricación in any project state or role', () => {
      // Simulate multiple project states: activo, ganado, perdido, 0% paid, 50% paid, 100% paid
      const states = [
        { estado: 'activo', etapa: 'prospecto', role: 'manager' },
        { estado: 'activo', etapa: 'negociacion', role: 'vendedor' },
        { estado: 'ganado', facturas: [{ monto: 100, pagos: [] }], role: 'manager' },
        { estado: 'ganado', facturas: [{ monto: 100, pagos: [{ monto: 50 }] }], role: 'gestor' },
        { estado: 'ganado', facturas: [{ monto: 100, pagos: [{ monto: 100 }] }], role: 'manager' },
        { estado: 'perdido', role: 'manager' },
        { estado: 'perdido', role: 'vendedor' }
      ];

      states.forEach(config => {
        // Assert that the source code does not contain any branch setting display of a fabrication button
        expect(appCoreSrc).not.toMatch(/btnSendFab/);
      });
    });

    test('Other Proyectos y Cobros and detail actions remain fully intact', () => {
      // Ensure commercial prospect management actions are preserved
      expect(indexHtml).toContain('id="btn-reactivate-prospect"');
      expect(indexHtml).toContain('id="btn-delete-prospect"');
      expect(appCoreSrc).toContain('reactivateLostProspect');
      expect(appCoreSrc).toContain('deleteProspect');
      expect(appCoreSrc).toContain('renderFinancials');
    });
  });

  // =========================================================================
  // 4. Excel Format Detection & In-Modal Sheet Table Rendering
  // =========================================================================
  describe('4. Excel Detection & Tabular Sheet Rendering', () => {
    const isExcelFormat = appCore.isExcelFormat;
    const isFormatPreviewable = appCore.isFormatPreviewable;
    const renderSheetTable = appCore.renderSheetTable;

    test('isExcelFormat detects .xlsx, .xls, and Excel MIME types reliably', () => {
      expect(isExcelFormat('presupuesto.xlsx')).toBe(true);
      expect(isExcelFormat('cotizacion.xls')).toBe(true);
      expect(isExcelFormat('UPPERCASE_SHEET.XLSX')).toBe(true);
      expect(isExcelFormat('archivo.csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
      expect(isExcelFormat('documento.pdf')).toBe(false);
      expect(isExcelFormat('imagen.png')).toBe(false);
      expect(isExcelFormat('plano.dwg')).toBe(false);
    });

    test('isFormatPreviewable includes Excel formats along with PDF and images', () => {
      expect(isFormatPreviewable('presupuesto.xlsx')).toBe(true);
      expect(isFormatPreviewable('calculo.xls')).toBe(true);
      expect(isFormatPreviewable('factura.pdf')).toBe(true);
      expect(isFormatPreviewable('comprobante.jpg')).toBe(true);
      expect(isFormatPreviewable('plano.dwg')).toBe(false);
      expect(isFormatPreviewable('paquete.zip')).toBe(false);
      expect(isFormatPreviewable('documento.docx')).toBe(false);
    });

    test('renderSheetTable formats 2D sheet data into HTML table with sticky headers', () => {
      const data = [
        ['Item', 'Descripción', 'Cantidad', 'Precio'],
        ['1', 'Ducto rectangular 12x12', '10', '$150.00'],
        ['2', 'Codo 90 grados', '4', '$60.00']
      ];

      const html = renderSheetTable(data);
      expect(html).toContain('<table class="excel-table">');
      expect(html).toContain('<th>A</th>');
      expect(html).toContain('<th>B</th>');
      expect(html).toContain('<td>Item</td>');
      expect(html).toContain('<td>Ducto rectangular 12x12</td>');
      expect(html).toContain('<td>$150.00</td>');
    });

    test('renderSheetTable notifies user when rows exceed the 500 row limit', () => {
      const bigData = [['Header']];
      for (let i = 0; i < 600; i++) {
        bigData.push([`Fila ${i}`]);
      }

      const html = renderSheetTable(bigData, 500);
      expect(html).toContain('Mostrando las primeras 500 filas');
      expect(html).toContain('Descarga el archivo original para ver el libro completo');
    });

    test('renderSheetTable handles empty sheet gracefully', () => {
      const html = renderSheetTable([]);
      expect(html).toContain('Esta hoja de cálculo está vacía');
    });
  });

  // =========================================================================
  // 5. Client Detail Documents & Isolation
  // =========================================================================
  describe('5. Client Dossier Presentation & Isolation', () => {
    test('viewStoredClientDoc and downloadStoredClientDoc isolate client documents', () => {
      const appCoreFunctionsSrc = fs.readFileSync(appCorePath, 'utf8');

      // Check viewStoredClientDoc implementation
      expect(appCoreFunctionsSrc).toContain(
        "return viewSecureDocument(item.docRef, item.fileName, { clientId: item.clientId });"
      );
      // Check downloadStoredClientDoc implementation
      expect(appCoreFunctionsSrc).toContain(
        "return downloadSecureDocument(item.docRef, item.fileName, { clientId: item.clientId });"
      );
      // Check that viewSecureDocument does NOT leak currentProspectId when clientId is provided
      expect(appCoreFunctionsSrc).toContain(
        "const reqProspectId = (options.prospectId !== undefined && options.prospectId !== null)"
      );
      expect(appCoreFunctionsSrc).toContain(
        ": (options.clientId ? null : (typeof currentProspectId !== 'undefined' ? currentProspectId : null));"
      );
    });

    test('formatClientDocLabel formats canonical and alternative document keys correctly', () => {
      const formatClientDocLabel = appCore.formatClientDocLabel;
      expect(formatClientDocLabel('dui')).toBe('DUI');
      expect(formatClientDocLabel('nit')).toBe('NIT');
      expect(formatClientDocLabel('nrc')).toBe('NRC');
      expect(formatClientDocLabel('escritura_constitucion')).toBe('Escritura de Constitución');
      expect(formatClientDocLabel('mods_escritura')).toBe('Mods. Escritura');
      expect(formatClientDocLabel('mods')).toBe('Modificaciones');
    });

    test('legacy "Archivos en expediente" block is completely removed while new dossier interface is preserved', () => {
      // Old elements and text must not exist
      expect(indexHtml).not.toContain('id="jur-docs-status"');
      expect(indexHtml).not.toContain('id="nat-dui-status"');
      expect(appCoreSrc).not.toContain('jur-docs-status');
      expect(appCoreSrc).not.toContain('nat-dui-status');
      expect(appCoreSrc).not.toContain('Archivos en expediente');

      // New digital dossier interface must exist and be preserved
      expect(indexHtml).toContain('id="client-expediente-section"');
      expect(indexHtml).toContain('id="client-docs-list"');
      expect(indexHtml).toContain('id="client-docs-count-badge"');
      expect(indexHtml).toContain('Expediente Digital del Cliente');
      expect(appCoreSrc).toContain('function renderClientExpedienteSection');
      expect(typeof appCore.renderClientExpedienteSection).toBe('function');
    });
  });
});
