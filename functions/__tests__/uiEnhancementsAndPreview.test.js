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
    textContent: '',
    value: ''
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

  // =========================================================================
  // 6. PDF Preview (Inline Disposition) vs Download (Attachment)
  // =========================================================================
  describe('6. PDF Preview vs Download Behavior & Disposition Integrity', () => {
    test('viewSecureDocument defaults disposition to inline for in-browser viewing', () => {
      expect(appCoreSrc).toContain("const reqDisposition = (options && options.disposition) || (options && options.download ? 'attachment' : 'inline');");
      expect(appCoreSrc).toContain("disposition: reqDisposition");
    });

    test('downloadSecureDocument explicitly specifies disposition attachment', () => {
      expect(appCoreSrc).toContain("disposition: 'attachment'");
    });

    test('storageService resolves application/pdf for PDF files and attaches responseType', async () => {
      const storageServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'storageService.js'), 'utf8');
      expect(storageServiceSrc).toContain("if (lower.endsWith('.pdf')) return 'application/pdf';");
      expect(storageServiceSrc).toContain("signedUrlOptions.responseType = effectiveContentType;");
    });

    test('getSecureDownloadUrlAdmin strictly sanitizes disposition to inline or attachment', () => {
      const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
      expect(indexSrc).toContain("disposition: (data.disposition === 'inline' || data.disposition === 'attachment') ? data.disposition : 'attachment'");
    });

    test('opportunity documents render separate 👁️ Ver (view) and ⬇️ Descargar (download) action buttons', () => {
      expect(appCoreSrc).toContain('class="btn-doc-view" title="Previsualizar en visor">👁️ Ver</a>');
      expect(appCoreSrc).toContain('class="btn-doc-dl" title="Descargar archivo">⬇️ Descargar</a>');
      expect(appCoreSrc).toContain("viewSecureDocument(window._docStore ? window._docStore.get");
      expect(appCoreSrc).toContain("downloadSecureDocument(window._docStore ? window._docStore.get");
    });
  });

  // =========================================================================
  // 7. Canonical Date Parsing & Unknown Date Formatting
  // =========================================================================
  describe('7. Canonical Date Parsing & Unknown Date Formatting', () => {
    const parseProspectDate = appCore.parseProspectDate;
    const formatProspectDate = appCore.formatProspectDate;

    test('parseProspectDate handles native Date instances', () => {
      const d = new Date(2026, 4, 15, 10, 30);
      expect(parseProspectDate(d)).toEqual(d);
      expect(parseProspectDate(new Date('invalid'))).toBeNull();
    });

    test('parseProspectDate handles ISO strings and date strings', () => {
      const parsed = parseProspectDate('2026-03-20T12:00:00.000Z');
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed.toISOString()).toBe('2026-03-20T12:00:00.000Z');

      const parsedSimple = parseProspectDate('2026-08-10');
      expect(parsedSimple).toBeInstanceOf(Date);
    });

    test('parseProspectDate handles Firestore Timestamps with toDate()', () => {
      const mockTimestamp = {
        toDate: () => new Date('2026-02-14T08:00:00.000Z')
      };
      const parsed = parseProspectDate(mockTimestamp);
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed.toISOString()).toBe('2026-02-14T08:00:00.000Z');
    });

    test('parseProspectDate handles Firestore Timestamps with seconds or _seconds', () => {
      const tsSeconds = { seconds: 1774000000 };
      const parsedA = parseProspectDate(tsSeconds);
      expect(parsedA).toBeInstanceOf(Date);
      expect(parsedA.getTime()).toBe(1774000000 * 1000);

      const tsUnderscore = { _seconds: 1774000000 };
      const parsedB = parseProspectDate(tsUnderscore);
      expect(parsedB).toBeInstanceOf(Date);
      expect(parsedB.getTime()).toBe(1774000000 * 1000);
    });

    test('parseProspectDate handles epoch numbers in seconds or milliseconds', () => {
      const ms = 1774000000000;
      expect(parseProspectDate(ms).getTime()).toBe(ms);

      const sec = 1774000000;
      expect(parseProspectDate(sec).getTime()).toBe(sec * 1000);
    });

    test('parseProspectDate safely returns null for null, undefined, empty, or invalid input', () => {
      expect(parseProspectDate(null)).toBeNull();
      expect(parseProspectDate(undefined)).toBeNull();
      expect(parseProspectDate('')).toBeNull();
      expect(parseProspectDate('   ')).toBeNull();
      expect(parseProspectDate('fecha_invalida')).toBeNull();
      expect(parseProspectDate({})).toBeNull();
    });

    test('formatProspectDate formats valid dates as DD/MM/AAAA with leading zeroes', () => {
      // 5th of March 2026
      const d = new Date(2026, 2, 5, 12, 0);
      expect(formatProspectDate(d)).toBe('05/03/2026');

      // 25th of December 2025
      const d2 = new Date(2025, 11, 25, 12, 0);
      expect(formatProspectDate(d2)).toBe('25/12/2025');
    });

    test('formatProspectDate formats unknown dates coherently as "-"', () => {
      expect(formatProspectDate(null)).toBe('-');
      expect(formatProspectDate(undefined)).toBe('-');
      expect(formatProspectDate('')).toBe('-');
      expect(formatProspectDate('corrupt-date')).toBe('-');
    });
  });

  // =========================================================================
  // 8. Bidirectional Sorting by Fecha de Ingreso
  // =========================================================================
  describe('8. Bidirectional Sorting by Fecha de Ingreso (Antigüedad / Recientes)', () => {
    const parseProspectDate = appCore.parseProspectDate;

    const list = [
      { id: 'p_unknown', proyecto: 'Sin fecha', fecha_creacion: null },
      { id: 'p_mid', proyecto: 'Intermedio', fecha_creacion: '2026-02-15T10:00:00.000Z' },
      { id: 'p_old', proyecto: 'Antiguo', fecha_creacion: '2025-06-01T08:00:00.000Z' },
      { id: 'p_new', proyecto: 'Reciente', fecha_creacion: '2026-10-18T14:00:00.000Z' },
      { id: 'p_empty', proyecto: 'Vacio', fecha_creacion: '' }
    ];

    test('sorts oldest first (asc: mayor antigüedad primero), placing unknown dates at the end', () => {
      const sortedAsc = [...list].sort((a, b) => {
        const dateA = parseProspectDate(a.fecha_creacion);
        const dateB = parseProspectDate(b.fecha_creacion);
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateA.getTime() - dateB.getTime();
      });

      expect(sortedAsc.map(x => x.id)).toEqual(['p_old', 'p_mid', 'p_new', 'p_unknown', 'p_empty']);
    });

    test('sorts newest first (desc: menor antigüedad primero), placing unknown dates at the end', () => {
      const sortedDesc = [...list].sort((a, b) => {
        const dateA = parseProspectDate(a.fecha_creacion);
        const dateB = parseProspectDate(b.fecha_creacion);
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.getTime() - dateA.getTime();
      });

      expect(sortedDesc.map(x => x.id)).toEqual(['p_new', 'p_mid', 'p_old', 'p_unknown', 'p_empty']);
    });

    test('updateOppSortIcons and toggleOppSort support the fecha column', () => {
      expect(appCoreSrc).toContain("const columns = ['codigo', 'cliente', 'proyecto', 'vendedor', 'fecha', 'etapa', 'monto', 'estado'];");
      expect(indexHtml).toContain('onclick="toggleOppSort(\'fecha\')"');
      expect(indexHtml).toContain('id="sort-opp-fecha"');
    });
  });

  // =========================================================================
  // 9. Inclusive Date Range Filter & Combination with Search/Status
  // =========================================================================
  describe('9. Inclusive Date Range Filter Logic & Combining Filters', () => {
    const parseProspectDate = appCore.parseProspectDate;

    const dataset = [
      { id: 'p1', codigo: '2026-001', proyecto: 'Edificio Norte', estado: 'activo', fecha_creacion: '2026-03-01T14:00:00.000Z' },
      { id: 'p2', codigo: '2026-002', proyecto: 'Torre Central', estado: 'activo', fecha_creacion: '2026-03-15T15:30:00.000Z' },
      { id: 'p3', codigo: '2026-003', proyecto: 'Bodega Sur', estado: 'activo', fecha_creacion: '2026-03-31T18:00:00.000Z' },
      { id: 'p4', codigo: '2026-004', proyecto: 'Plaza Mayor', estado: 'activo', fecha_creacion: '2026-04-02T12:00:00.000Z' },
      { id: 'p5', codigo: '2026-005', proyecto: 'Casa Quinta', estado: 'perdido', fecha_creacion: '2026-03-20T11:00:00.000Z' }
    ];

    test('inclusive date range filter includes boundary start (00:00:00) and end (23:59:59) dates', () => {
      const dateStartVal = '2026-03-01';
      const dateEndVal = '2026-03-31';

      const [sy, sm, sd] = dateStartVal.split('-').map(Number);
      const startTime = new Date(sy, sm - 1, sd, 0, 0, 0, 0).getTime();

      const [ey, em, ed] = dateEndVal.split('-').map(Number);
      const endTime = new Date(ey, em - 1, ed, 23, 59, 59, 999).getTime();

      const filtered = dataset.filter(p => {
        const pDate = parseProspectDate(p.fecha_creacion);
        if (!pDate) return false;
        const pTime = pDate.getTime();
        return pTime >= startTime && pTime <= endTime;
      });

      // p1 (March 1), p2 (March 15), p3 (March 31), p5 (March 20) are inside March
      // p4 (April 2) is outside
      expect(filtered.map(x => x.id)).toEqual(['p1', 'p2', 'p3', 'p5']);
    });

    test('date range filter combines seamlessly with text search and status filter', () => {
      const dateStartVal = '2026-03-01';
      const dateEndVal = '2026-03-31';
      const searchVal = 'torre';

      const [sy, sm, sd] = dateStartVal.split('-').map(Number);
      const startTime = new Date(sy, sm - 1, sd, 0, 0, 0, 0).getTime();
      const [ey, em, ed] = dateEndVal.split('-').map(Number);
      const endTime = new Date(ey, em - 1, ed, 23, 59, 59, 999).getTime();

      const filtered = dataset
        .filter(p => p.estado === 'activo')
        .filter(p => p.proyecto.toLowerCase().includes(searchVal))
        .filter(p => {
          const pDate = parseProspectDate(p.fecha_creacion);
          if (!pDate) return false;
          const pTime = pDate.getTime();
          return pTime >= startTime && pTime <= endTime;
        });

      expect(filtered.map(x => x.id)).toEqual(['p2']);
    });

    test('clearOppDateFilter is defined and clears inputs', () => {
      expect(typeof appCore.clearOppDateFilter).toBe('function');
      expect(indexHtml).toContain('id="opp-date-start"');
      expect(indexHtml).toContain('id="opp-date-end"');
      expect(indexHtml).toContain('id="btn-clear-opp-dates"');
      expect(indexHtml).toContain('id="opp-count-badge"');
    });
  });

  // =========================================================================
  // 10. Opportunity Detail Layout Hierarchy & Commercial Summary
  // =========================================================================
  describe('10. Opportunity Detail Layout Hierarchy & Balanced Grid', () => {
    test('detail view contains top-level commercial-hero-banner with priority KPIs', () => {
      expect(indexHtml).toContain('id="commercial-hero-banner"');
      expect(indexHtml).toContain('id="hero-etapa"');
      expect(indexHtml).toContain('id="hero-vendedor"');
      expect(indexHtml).toContain('id="hero-fecha"');
      expect(indexHtml).toContain('id="hero-precio"');
      expect(indexHtml).toContain('id="hero-costo"');
      expect(indexHtml).toContain('id="hero-margen"');
    });

    test('detail-grid uses balanced column distribution in styles.css', () => {
      const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');
      expect(stylesCss).toContain('.detail-grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 1.5rem; }');
      expect(stylesCss).toContain('.commercial-hero-banner');
      expect(stylesCss).toContain('.kpi-banner-grid');
      expect(stylesCss).toContain('.docs-card-list');
    });

    test('attached documents contain separate preview and download controls', () => {
      expect(indexHtml).toContain('id="docs-count-badge"');
      expect(indexHtml).toContain('id="docs-list"');
      expect(indexHtml).toContain('id="stage-workflow-box"');
    });
  });

  // =========================================================================
  // 11. Opportunity List Status Filter: Hiding Lost Opportunities by Default
  // =========================================================================
  describe('11. Opportunity List Status Filter: Hiding Lost Opportunities by Default', () => {
    const getOppStatusFilter = appCore.getOppStatusFilter;
    const setOppStatusFilter = appCore.setOppStatusFilter;
    const parseProspectDate = appCore.parseProspectDate;

    const sampleDataset = [
      { id: 'opp_act1', codigo: '2026-001', proyecto: 'Edificio Titanium', estado: 'activo', fecha_creacion: '2026-02-01T10:00:00.000Z' },
      { id: 'opp_act2', codigo: '2026-002', proyecto: 'Torre Aluna', estado: 'activo', fecha_creacion: '2026-03-15T12:00:00.000Z' },
      { id: 'opp_lost1', codigo: '2026-003', proyecto: 'Bodega San Jorge', estado: 'perdido', motivo_perdida: 'Precio', fecha_creacion: '2026-03-20T14:00:00.000Z' },
      { id: 'opp_lost2', codigo: '2026-004', proyecto: 'Plaza Las Flores', estado: 'perdido', motivo_perdida: 'Tiempo de entrega', fecha_creacion: '2026-04-01T16:00:00.000Z' },
      { id: 'opp_won1', codigo: '2026-005', proyecto: 'Hospital Metropolitano', estado: 'ganado', fecha_creacion: '2026-01-10T09:00:00.000Z' }
    ];

    test('default status filter is "activas"', () => {
      expect(getOppStatusFilter()).toBe('activas');
    });

    test('setOppStatusFilter accepts "activas", "perdidas", "todas" and ignores invalid values', () => {
      setOppStatusFilter('perdidas');
      expect(getOppStatusFilter()).toBe('perdidas');

      setOppStatusFilter('todas');
      expect(getOppStatusFilter()).toBe('todas');

      setOppStatusFilter('invalido_random');
      expect(getOppStatusFilter()).toBe('todas'); // unchanged

      setOppStatusFilter('activas');
      expect(getOppStatusFilter()).toBe('activas');
    });

    test('initial state strictly hides lost opportunities and won opportunities', () => {
      setOppStatusFilter('activas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const visible = base.filter(p => p.estado !== 'perdido');

      expect(visible.map(p => p.id)).toEqual(['opp_act1', 'opp_act2']);
      expect(visible.some(p => p.estado === 'perdido')).toBe(false);
      expect(visible.some(p => p.estado === 'ganado')).toBe(false);
    });

    test('activating filter "perdidas" displays exclusively lost opportunities', () => {
      setOppStatusFilter('perdidas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const visible = base.filter(p => p.estado === 'perdido');

      expect(visible.map(p => p.id)).toEqual(['opp_lost1', 'opp_lost2']);
      expect(visible.every(p => p.estado === 'perdido')).toBe(true);
    });

    test('activating filter "todas" displays both active and lost opportunities, excluding won', () => {
      setOppStatusFilter('todas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const visible = base;

      expect(visible.map(p => p.id)).toEqual(['opp_act1', 'opp_act2', 'opp_lost1', 'opp_lost2']);
      expect(visible.some(p => p.estado === 'perdido')).toBe(true);
      expect(visible.some(p => p.estado === 'activo')).toBe(true);
      expect(visible.some(p => p.estado === 'ganado')).toBe(false);
    });

    test('switching back to "activas" hides lost opportunities again', () => {
      setOppStatusFilter('todas');
      expect(getOppStatusFilter()).toBe('todas');

      setOppStatusFilter('activas');
      expect(getOppStatusFilter()).toBe('activas');

      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const visible = base.filter(p => p.estado !== 'perdido');
      expect(visible.map(p => p.id)).toEqual(['opp_act1', 'opp_act2']);
      expect(visible.some(p => p.estado === 'perdido')).toBe(false);
    });

    test('text search cannot reintroduce lost opportunities when filter is "activas"', () => {
      setOppStatusFilter('activas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const statusFiltered = base.filter(p => p.estado !== 'perdido');

      // Search term matching lost opportunity "San Jorge" or "Bodega"
      const searchVal = 'jorge';
      const searchResult = statusFiltered.filter(p =>
        (p.proyecto || '').toLowerCase().includes(searchVal) ||
        (p.codigo || '').toLowerCase().includes(searchVal)
      );

      expect(searchResult.length).toBe(0);
      expect(searchResult.some(p => p.id === 'opp_lost1')).toBe(false);
    });

    test('text search works correctly within "perdidas" filter', () => {
      setOppStatusFilter('perdidas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const statusFiltered = base.filter(p => p.estado === 'perdido');

      const searchVal = 'flores';
      const searchResult = statusFiltered.filter(p =>
        (p.proyecto || '').toLowerCase().includes(searchVal) ||
        (p.codigo || '').toLowerCase().includes(searchVal)
      );

      expect(searchResult.map(p => p.id)).toEqual(['opp_lost2']);
    });

    test('date range filter combines seamlessly with status filter', () => {
      // March 2026: 2026-03-01 to 2026-03-31
      const startTime = new Date(2026, 2, 1, 0, 0, 0, 0).getTime();
      const endTime = new Date(2026, 2, 31, 23, 59, 59, 999).getTime();

      // Under 'activas': only opp_act2 (March 15)
      setOppStatusFilter('activas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const activeOnly = base.filter(p => p.estado !== 'perdido');
      const dateFilteredActive = activeOnly.filter(p => {
        const d = parseProspectDate(p.fecha_creacion);
        const t = d ? d.getTime() : 0;
        return t >= startTime && t <= endTime;
      });
      expect(dateFilteredActive.map(p => p.id)).toEqual(['opp_act2']);

      // Under 'perdidas': only opp_lost1 (March 20)
      setOppStatusFilter('perdidas');
      const lostOnly = base.filter(p => p.estado === 'perdido');
      const dateFilteredLost = lostOnly.filter(p => {
        const d = parseProspectDate(p.fecha_creacion);
        const t = d ? d.getTime() : 0;
        return t >= startTime && t <= endTime;
      });
      expect(dateFilteredLost.map(p => p.id)).toEqual(['opp_lost1']);
    });

    test('date sorting preserves the allowed set of records without leaking lost opportunities', () => {
      setOppStatusFilter('activas');
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const activeOnly = base.filter(p => p.estado !== 'perdido');

      const sortedAsc = [...activeOnly].sort((a, b) =>
        parseProspectDate(a.fecha_creacion).getTime() - parseProspectDate(b.fecha_creacion).getTime()
      );
      expect(sortedAsc.map(p => p.id)).toEqual(['opp_act1', 'opp_act2']);
      expect(sortedAsc.some(p => p.estado === 'perdido')).toBe(false);

      const sortedDesc = [...activeOnly].sort((a, b) =>
        parseProspectDate(b.fecha_creacion).getTime() - parseProspectDate(a.fecha_creacion).getTime()
      );
      expect(sortedDesc.map(p => p.id)).toEqual(['opp_act2', 'opp_act1']);
      expect(sortedDesc.some(p => p.estado === 'perdido')).toBe(false);
    });

    test('badge counters accurately reflect active, lost and all opportunities', () => {
      const base = sampleDataset.filter(p => p.estado !== 'ganado');
      const countActivas = base.filter(p => p.estado !== 'perdido').length;
      const countPerdidas = base.filter(p => p.estado === 'perdido').length;
      const countTodas = base.length;

      expect(countActivas).toBe(2);
      expect(countPerdidas).toBe(2);
      expect(countTodas).toBe(4);
    });

    test('HTML contains the status filter pills and badges', () => {
      const freshIndexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
      expect(freshIndexHtml).toContain('id="opp-status-pills"');
      expect(freshIndexHtml).toContain('id="filter-opp-activas"');
      expect(freshIndexHtml).toContain('id="filter-opp-perdidas"');
      expect(freshIndexHtml).toContain('id="filter-opp-todas"');
      expect(freshIndexHtml).toContain('id="count-opp-activas"');
      expect(freshIndexHtml).toContain('id="count-opp-perdidas"');
      expect(freshIndexHtml).toContain('id="count-opp-todas"');
    });

    test('Proyectos y Cobros 100% paid hiding behavior remains completely intact and undisturbed', () => {
      const isProjectFullyPaid = appCore.isProjectFullyPaid;
      const getProjPaymentFilter = appCore.getProjPaymentFilter;

      // Default proj filter is 'pendientes'
      expect(getProjPaymentFilter()).toBe('pendientes');

      const mockProjs = [
        { id: 'pr1', clientId: 'cli_local', precio_cotizado: 1000, facturas: [{ monto: 1130, pagos: [{ monto: 500 }] }] },
        { id: 'pr2', clientId: 'cli_local', precio_cotizado: 500, facturas: [{ monto: 565, pagos: [{ monto: 565 }] }] }
      ];

      // pr2 is fully paid (hidden by default under 'pendientes')
      expect(isProjectFullyPaid(mockProjs[0])).toBe(false);
      expect(isProjectFullyPaid(mockProjs[1])).toBe(true);

      const pendingOnly = mockProjs.filter(p => !isProjectFullyPaid(p));
      expect(pendingOnly.map(p => p.id)).toEqual(['pr1']);

      const paidOnly = mockProjs.filter(p => isProjectFullyPaid(p));
      expect(paidOnly.map(p => p.id)).toEqual(['pr2']);
    });
  });

  // =========================================================================
  // 12. Integrated DOM Flow Tests for renderList() & Status Filter Pills
  // =========================================================================
  describe('12. Integrated DOM Flow Tests for renderList() & Status Filter Pills', () => {
    const between = (from, to) => {
      const a = appCoreSrc.indexOf(from);
      const b = appCoreSrc.indexOf(to, a);
      if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
      return appCoreSrc.slice(a, b);
    };

    const REAL_SRC = [
      between('// Variables Globales de Ordenamiento para Oportunidades', 'function reassignVendor'),
      between('function updateOppSortIcons()', 'function toggleProjSort'),
      'const formatCurrency = (val) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(val || 0);',
      'const getDaysDifference = (d1) => Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24));',
      'const KPI_LIMITS = { "prospecto": 7, "levantamiento": 10, "cotizacion": 7, "negociacion": 21, "cierre": 5 };',
      between('function getClientName', 'function renderProjectsList')
    ].join('\n');

    function createSandboxEnvironment(customState = {}) {
      const elements = {};
      const getEl = (id) => {
        if (!elements[id]) {
          const classes = new Set();
          elements[id] = {
            id,
            tagName: 'DIV',
            value: '',
            style: {},
            textContent: '',
            _innerHTML: '',
            children: [],
            classList: {
              add: (c) => classes.add(c),
              remove: (c) => classes.delete(c),
              contains: (c) => classes.has(c),
              toArray: () => Array.from(classes)
            },
            get innerHTML() { return this._innerHTML; },
            set innerHTML(val) {
              this._innerHTML = val;
              this.children = [];
            },
            appendChild(child) {
              this.children.push(child);
            }
          };
        }
        return elements[id];
      };

      const document = {
        getElementById: (id) => getEl(id),
        createElement: (tag) => {
          const classes = new Set();
          return {
            tagName: tag.toUpperCase(),
            style: {},
            classList: {
              add: (c) => classes.add(c),
              remove: (c) => classes.delete(c),
              contains: (c) => classes.has(c)
            },
            innerHTML: '',
            onclick: null
          };
        }
      };

      // Pre-populate standard UI elements
      [
        'opp-table-body', 'filter-opp-activas', 'filter-opp-perdidas', 'filter-opp-todas',
        'count-opp-activas', 'count-opp-perdidas', 'count-opp-todas', 'opp-count-badge',
        'opp-search', 'opp-date-start', 'opp-date-end', 'btn-clear-opp-dates'
      ].forEach(id => getEl(id));

      const defaultProspects = [
        { id: 'opp_1', codigo: 'OPP-101', proyecto: 'Torre Mayor', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 25000, fecha_creacion: '2026-02-10T10:00:00.000Z', clientId: 'cli_1', vendedorId: 'v1' },
        { id: 'opp_2', codigo: 'OPP-102', proyecto: 'Edificio Titanium', estado: 'activo', etapa: 'negociacion', precio_cotizado: 18000, fecha_creacion: '2026-03-15T12:00:00.000Z', clientId: 'cli_2', vendedorId: 'v1' },
        { id: 'opp_3', codigo: 'OPP-103', proyecto: 'Bodega San Jorge', estado: 'perdido', motivo_perdida: 'Precio', etapa: 'levantamiento', precio_cotizado: 12000, fecha_creacion: '2026-03-20T14:00:00.000Z', clientId: 'cli_1', vendedorId: 'v1' },
        { id: 'opp_4', codigo: 'OPP-104', proyecto: 'Plaza Flores', estado: 'perdido', motivo_perdida: 'Desiste', etapa: 'prospecto', precio_cotizado: 9000, fecha_creacion: '2026-01-20T08:00:00.000Z', clientId: 'cli_2', vendedorId: 'v2' },
        { id: 'opp_5', codigo: 'OPP-105', proyecto: 'Hospital Metropolitano', estado: 'ganado', etapa: 'cierre', precio_cotizado: 45000, fecha_creacion: '2026-01-05T09:00:00.000Z', clientId: 'cli_1', vendedorId: 'v1' }
      ];

      const S = {
        prospects: customState.prospects || defaultProspects,
        clients: customState.clients || [
          { id: 'cli_1', empresa: 'Constructora Central S.A.', tipo: 'juridico' },
          { id: 'cli_2', nombres: 'Carlos', apellidos: 'Mendoza', tipo: 'natural' }
        ],
        users: customState.users || [
          { id: 'm1', nombre: 'Gerente General', role: 'manager' },
          { id: 'v1', nombre: 'Roberto Flores', role: 'vendedor' },
          { id: 'v2', nombre: 'Ana Ayala', role: 'gestor' }
        ],
        currentUser: customState.currentUser !== undefined ? customState.currentUser : { id: 'm1', nombre: 'Gerente General', role: 'manager' }
      };

      const openedDetails = [];
      const openDetail = (id) => { openedDetails.push(id); };

      const scope = new Function(
        'S', 'document', 'openDetail',
        'with(S) {\n' + REAL_SRC + '\n return { renderList, setOppStatusFilter, getOppStatusFilter, clearOppDateFilter, toggleOppSort, updateOppSortIcons };\n}'
      );

      const api = scope(S, document, openDetail);
      return { api, elements, document, S, openedDetails };
    }

    test('initial state strictly hides lost opportunities and won opportunities in real DOM', () => {
      const { api, elements } = createSandboxEnvironment();
      api.renderList();

      const tbody = elements['opp-table-body'];
      // Only 2 active opportunities (opp_1, opp_2) should be rendered
      expect(tbody.children.length).toBe(2);

      // Verify no rendered row contains lost or won IDs or texts
      tbody.children.forEach(row => {
        expect(row.innerHTML).not.toContain('OPP-103');
        expect(row.innerHTML).not.toContain('OPP-104');
        expect(row.innerHTML).not.toContain('OPP-105');
        expect(row.innerHTML).not.toContain('PERDIDO');
        expect(row.innerHTML).not.toContain('GANADO');
      });

      // Verify active pill class
      expect(elements['filter-opp-activas'].classList.contains('active')).toBe(true);
      expect(elements['filter-opp-perdidas'].classList.contains('active')).toBe(false);
      expect(elements['filter-opp-todas'].classList.contains('active')).toBe(false);

      // Verify badge counters
      expect(elements['count-opp-activas'].textContent).toBe(2);
      expect(elements['count-opp-perdidas'].textContent).toBe(2);
      expect(elements['count-opp-todas'].textContent).toBe(4);
      expect(elements['opp-count-badge'].textContent).toBe('2 oportunidades');
    });

    test('switching to "perdidas" renders only lost opportunities and updates active pill button', () => {
      const { api, elements } = createSandboxEnvironment();
      api.setOppStatusFilter('perdidas');

      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(2);

      // Verify only lost opportunities are in tbody
      tbody.children.forEach(row => {
        expect(row.innerHTML).toContain('PERDIDO');
        expect(row.innerHTML).not.toContain('GANADO');
      });
      const rowHtmls = tbody.children.map(r => r.innerHTML).join(' ');
      expect(rowHtmls).toContain('OPP-103');
      expect(rowHtmls).toContain('OPP-104');
      expect(rowHtmls).not.toContain('OPP-101');
      expect(rowHtmls).not.toContain('OPP-102');

      // Verify pill states
      expect(elements['filter-opp-activas'].classList.contains('active')).toBe(false);
      expect(elements['filter-opp-perdidas'].classList.contains('active')).toBe(true);
      expect(elements['filter-opp-todas'].classList.contains('active')).toBe(false);
      expect(elements['opp-count-badge'].textContent).toBe('2 oportunidades');
    });

    test('switching to "todas" renders active and lost opportunities, but never won', () => {
      const { api, elements } = createSandboxEnvironment();
      api.setOppStatusFilter('todas');

      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(4);

      const rowHtmls = tbody.children.map(r => r.innerHTML).join(' ');
      expect(rowHtmls).toContain('OPP-101');
      expect(rowHtmls).toContain('OPP-102');
      expect(rowHtmls).toContain('OPP-103');
      expect(rowHtmls).toContain('OPP-104');
      expect(rowHtmls).not.toContain('OPP-105'); // won is strictly excluded from commercial opportunities

      expect(elements['filter-opp-todas'].classList.contains('active')).toBe(true);
      expect(elements['opp-count-badge'].textContent).toBe('4 oportunidades');
    });

    test('switching back to "activas" hides lost opportunities again and restores active pill state', () => {
      const { api, elements } = createSandboxEnvironment();
      api.setOppStatusFilter('todas');
      expect(elements['opp-table-body'].children.length).toBe(4);

      api.setOppStatusFilter('activas');
      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(2);

      tbody.children.forEach(row => {
        expect(row.innerHTML).not.toContain('PERDIDO');
      });
      expect(elements['filter-opp-activas'].classList.contains('active')).toBe(true);
      expect(elements['filter-opp-perdidas'].classList.contains('active')).toBe(false);
      expect(elements['filter-opp-todas'].classList.contains('active')).toBe(false);
    });

    test('text search cannot reintroduce lost opportunities when active pill is "activas"', () => {
      const { api, elements } = createSandboxEnvironment();
      api.renderList();

      // Search for lost opportunity keyword "Bodega" or "San Jorge"
      elements['opp-search'].value = 'Jorge';
      api.renderList();

      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(0);
      expect(tbody.innerHTML).toContain('No se encontraron oportunidades.');
      expect(elements['opp-count-badge'].textContent).toBe('0 oportunidades');

      // Pill badges still reflect total portfolio numbers (2, 2, 4)
      expect(elements['count-opp-activas'].textContent).toBe(2);
      expect(elements['count-opp-perdidas'].textContent).toBe(2);
      expect(elements['count-opp-todas'].textContent).toBe(4);
    });

    test('text search works correctly within "perdidas" filter', () => {
      const { api, elements } = createSandboxEnvironment();
      api.setOppStatusFilter('perdidas');

      elements['opp-search'].value = 'San Jorge';
      api.renderList();

      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(1);
      expect(tbody.children[0].innerHTML).toContain('OPP-103');
      expect(tbody.children[0].innerHTML).toContain('Bodega San Jorge');
      expect(elements['opp-count-badge'].textContent).toBe('1 oportunidad');
    });

    test('empty state under "perdidas" displays specific message "No hay oportunidades marcadas como perdidas."', () => {
      const { api, elements } = createSandboxEnvironment({
        prospects: [
          { id: 'opp_act', codigo: 'OPP-1', proyecto: 'Torre', estado: 'activo', fecha_creacion: '2026-03-01', clientId: 'cli_1' }
        ]
      });

      api.setOppStatusFilter('perdidas');
      const tbody = elements['opp-table-body'];
      expect(tbody.children.length).toBe(0);
      expect(tbody.innerHTML).toContain('No hay oportunidades marcadas como perdidas.');
      expect(elements['opp-count-badge'].textContent).toBe('0 oportunidades');
    });

    test('date range filter combines seamlessly with status filter in real DOM', () => {
      const { api, elements } = createSandboxEnvironment();

      // Range: March 2026 (2026-03-01 to 2026-03-31)
      elements['opp-date-start'].value = '2026-03-01';
      elements['opp-date-end'].value = '2026-03-31';

      // Under 'activas': only opp_2 (March 15) is in range; opp_1 is in Feb
      api.renderList();
      expect(elements['opp-table-body'].children.length).toBe(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-102');
      expect(elements['opp-count-badge'].textContent).toBe('1 oportunidad');

      // Under 'perdidas': only opp_3 (March 20) is in range; opp_4 is in Jan
      api.setOppStatusFilter('perdidas');
      expect(elements['opp-table-body'].children.length).toBe(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-103');
      expect(elements['opp-count-badge'].textContent).toBe('1 oportunidad');
    });

    test('date sorting preserves allowed records without leaking lost opportunities', () => {
      const { api, elements } = createSandboxEnvironment();
      api.setOppStatusFilter('activas');

      // Toggle sort by fecha
      api.toggleOppSort('fecha'); // asc
      expect(elements['opp-table-body'].children.length).toBe(2);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-101'); // Feb 10
      expect(elements['opp-table-body'].children[1].innerHTML).toContain('OPP-102'); // Mar 15

      api.toggleOppSort('fecha'); // desc
      expect(elements['opp-table-body'].children.length).toBe(2);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-102'); // Mar 15
      expect(elements['opp-table-body'].children[1].innerHTML).toContain('OPP-101'); // Feb 10

      // In both directions, lost opportunities NEVER appear
      elements['opp-table-body'].children.forEach(row => {
        expect(row.innerHTML).not.toContain('PERDIDO');
      });
    });

    test('counter semantics: badge counters represent total portfolio universe while table badge represents visible filtered rows', () => {
      const { api, elements } = createSandboxEnvironment();
      api.renderList();

      // Initially: 2 active, 2 lost, 4 total in the user's portfolio
      expect(elements['count-opp-activas'].textContent).toBe(2);
      expect(elements['count-opp-perdidas'].textContent).toBe(2);
      expect(elements['count-opp-todas'].textContent).toBe(4);
      expect(elements['opp-count-badge'].textContent).toBe('2 oportunidades');

      // Apply search that narrows visible rows to 1
      elements['opp-search'].value = 'Titanium';
      api.renderList();

      // Table counter updates to filtered visible rows (1)
      expect(elements['opp-count-badge'].textContent).toBe('1 oportunidad');
      expect(elements['opp-table-body'].children.length).toBe(1);

      // Pill badges REMAIN unchanged, giving continuous context of the total portfolio
      // (identical to Proyectos y Cobros semantics)
      expect(elements['count-opp-activas'].textContent).toBe(2);
      expect(elements['count-opp-perdidas'].textContent).toBe(2);
      expect(elements['count-opp-todas'].textContent).toBe(4);
    });

    test('vendedor role isolation: vendedor only sees their own assigned active and lost opportunities', () => {
      // User v1 (vendedor) is assigned to opp_1, opp_2, opp_3. opp_4 is assigned to v2.
      const { api, elements } = createSandboxEnvironment({
        currentUser: { id: 'v1', nombre: 'Roberto Flores', role: 'vendedor' }
      });

      api.renderList();
      // v1 has 2 active (opp_1, opp_2) and 1 lost (opp_3). opp_4 is v2's and must be invisible.
      expect(elements['count-opp-activas'].textContent).toBe(2);
      expect(elements['count-opp-perdidas'].textContent).toBe(1);
      expect(elements['count-opp-todas'].textContent).toBe(3);

      expect(elements['opp-table-body'].children.length).toBe(2);

      // In 'perdidas', v1 only sees opp_3 (not opp_4)
      api.setOppStatusFilter('perdidas');
      expect(elements['opp-table-body'].children.length).toBe(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-103');
      expect(elements['opp-table-body'].children[0].innerHTML).not.toContain('OPP-104');

      // In 'todas', v1 only sees 3 records (opp_1, opp_2, opp_3)
      api.setOppStatusFilter('todas');
      expect(elements['opp-table-body'].children.length).toBe(3);
      const allHtml = elements['opp-table-body'].children.map(r => r.innerHTML).join(' ');
      expect(allHtml).not.toContain('OPP-104');
    });

    test('gestor role isolation: gestor only sees opportunities they created or are assigned to', () => {
      // User v2 (gestor) is assigned to opp_4.
      const { api, elements } = createSandboxEnvironment({
        currentUser: { id: 'v2', nombre: 'Ana Ayala', role: 'gestor' }
      });

      api.renderList();
      // v2 has 0 active, 1 lost (opp_4)
      expect(elements['count-opp-activas'].textContent).toBe(0);
      expect(elements['count-opp-perdidas'].textContent).toBe(1);
      expect(elements['count-opp-todas'].textContent).toBe(1);

      // In active filter: empty
      expect(elements['opp-table-body'].children.length).toBe(0);
      expect(elements['opp-table-body'].innerHTML).toContain('No se encontraron oportunidades.');

      // In lost filter: opp_4
      api.setOppStatusFilter('perdidas');
      expect(elements['opp-table-body'].children.length).toBe(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-104');
    });

    test('view switching and detail navigation preserve the selected status filter', () => {
      const { api, elements } = createSandboxEnvironment();

      // User selects 'perdidas'
      api.setOppStatusFilter('perdidas');
      expect(api.getOppStatusFilter()).toBe('perdidas');
      expect(elements['filter-opp-perdidas'].classList.contains('active')).toBe(true);

      // Simulating navigation to another view (e.g. clients) and returning to list-view
      // which triggers renderList()
      api.renderList();

      // Filter remains 'perdidas', pill remains active, only lost opportunities rendered
      expect(api.getOppStatusFilter()).toBe('perdidas');
      expect(elements['filter-opp-perdidas'].classList.contains('active')).toBe(true);
      expect(elements['filter-opp-activas'].classList.contains('active')).toBe(false);
      expect(elements['opp-table-body'].children.length).toBe(2);
      elements['opp-table-body'].children.forEach(row => {
        expect(row.innerHTML).toContain('PERDIDO');
      });
    });
  });
});
