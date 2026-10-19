// functions/__tests__/viewSecureDocumentFlow.test.js
// Verification of viewSecureDocument and downloadSecureDocument flow.
// Validates that fileRef.getBlob is removed, getSecureDownloadUrlAdmin is called,
// server authorization is preserved, and download/preview flows operate cleanly.

const fs = require('fs');
const path = require('path');
const { createStorageService } = require('../storageService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

describe('SEC-03: Storage Document Preview & Download Flow', () => {
  const releaseAppCorePath = path.join(__dirname, '..', '..', '..', 'sales-reporting-system-release', 'app_core.js');
  const mainAppCorePath = path.join(__dirname, '..', '..', 'app_core.js');

  const appCoreSrc = fs.existsSync(releaseAppCorePath)
    ? fs.readFileSync(releaseAppCorePath, 'utf8')
    : fs.readFileSync(mainAppCorePath, 'utf8');

  const extractFn = (fnName, nextFn) => {
    const start = appCoreSrc.indexOf(`async function ${fnName}(`);
    const end = appCoreSrc.indexOf(nextFn, start);
    if (start < 0 || end < 0) throw new Error(`Could not find boundary for ${fnName}`);
    return appCoreSrc.slice(start, end);
  };

  const viewDocSrc = extractFn('viewSecureDocument', 'const KNOWN_DOC_LABELS');
  const downloadDocSrc = extractFn('downloadSecureDocument', 'async function viewSecureDocument');

  // ---------------------------------------------------------------------------
  // 1. Diagnóstico de Causa Raíz: Ausencia de getBlob
  // ---------------------------------------------------------------------------
  describe('1. Causa Raíz: Ausencia de getBlob en app_core.js', () => {
    test('viewSecureDocument no contiene llamadas a fileRef.getBlob ni .getBlob(', () => {
      expect(viewDocSrc).not.toContain('fileRef.getBlob');
      expect(viewDocSrc).not.toContain('.getBlob(');
      expect(viewDocSrc).not.toContain('MAX_BLOB_SIZE');
    });

    test('downloadSecureDocument no contiene llamadas a getBlob', () => {
      expect(downloadDocSrc).not.toContain('.getBlob');
    });

    test('ambas funciones utilizan getSecureDownloadUrlAdmin como fuente autorizada', () => {
      expect(viewDocSrc).toContain("httpsCallable('getSecureDownloadUrlAdmin')");
      expect(downloadDocSrc).toContain("httpsCallable('getSecureDownloadUrlAdmin')");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Ejecución simulada de viewSecureDocument en el cliente
  // ---------------------------------------------------------------------------
  describe('2. Flujo de visualización y descarga en el cliente', () => {
    let mockAlerts = [];
    let mockConsoleWarns = [];
    let mockCallablePayload = null;
    let mockCallableResult = null;
    let mockCallableError = null;
    let mockBlobUrlCreated = null;
    let mockTab = null;
    let mockElements = [];
    let fetchCalledWith = null;

    beforeEach(() => {
      mockAlerts = [];
      mockConsoleWarns = [];
      mockCallablePayload = null;
      mockCallableResult = {
        data: {
          signedUrl: 'https://storage.googleapis.com/ductsal-erp.firebasestorage.app/prod_files/prospects/P1/facturas/fac1.pdf?X-Goog-Signature=test_sig',
          fileName: 'factura_001.pdf'
        }
      };
      mockCallableError = null;
      mockBlobUrlCreated = null;
      fetchCalledWith = null;
      mockTab = {
        closed: false,
        location: { href: 'about:blank' },
        document: {
          write: jest.fn()
        }
      };
      mockElements = [];
    });

    // Sandbox execution of viewSecureDocument
    const executeViewSecureDocument = async (docRef, fallbackName, options, mockFetch = null) => {
      const scope = {
        alert: (msg) => mockAlerts.push(msg),
        console: {
          error: jest.fn(),
          warn: (msg, err) => mockConsoleWarns.push({ msg, err })
        },
        window: {
          open: (url, target) => mockTab
        },
        document: {
          createElement: (tag) => {
            const el = { tag, style: {}, href: '', download: '', click: jest.fn(), parentNode: null };
            mockElements.push(el);
            return el;
          },
          body: {
            appendChild: (el) => { el.parentNode = 'body'; },
            removeChild: (el) => { el.parentNode = null; }
          }
        },
        URL: {
          createObjectURL: (blob) => {
            mockBlobUrlCreated = 'blob:https://erp.ductsal.com/mock-blob-uuid';
            return mockBlobUrlCreated;
          },
          revokeObjectURL: jest.fn()
        },
        setTimeout: (fn) => fn(),
        firebase: {
          functions: () => ({
            httpsCallable: (name) => {
              expect(name).toBe('getSecureDownloadUrlAdmin');
              return async (payload) => {
                mockCallablePayload = payload;
                if (mockCallableError) throw mockCallableError;
                return mockCallableResult;
              };
            }
          })
        },
        DB_SUFFIX: '_prod',
        currentProspectId: 'P1',
        escapeHtmlDoc: (s) => String(s || ''),
        showLoading: jest.fn(),
        hideLoading: jest.fn(),
        resolveStoragePath: (ref) => {
          if (!ref) return null;
          if (typeof ref === 'string') return ref;
          return ref.storagePath || ref.path || null;
        },
        isFormatPreviewable: (name) => {
          const lower = String(name || '').toLowerCase();
          return lower.endsWith('.pdf') || lower.endsWith('.png') || lower.endsWith('.jpg');
        },
        downloadSecureDocument: jest.fn(),
        fetch: mockFetch || (async (url) => {
          fetchCalledWith = url;
          return {
            ok: true,
            blob: async () => ({ type: 'application/pdf', size: 1024 })
          };
        })
      };

      const fn = new Function(
        'options', 'fallbackName', 'docRef',
        'alert', 'console', 'window', 'document', 'URL', 'setTimeout', 'firebase',
        'DB_SUFFIX', 'currentProspectId', 'escapeHtmlDoc', 'showLoading', 'hideLoading',
        'resolveStoragePath', 'isFormatPreviewable', 'downloadSecureDocument', 'fetch',
        `
        ${viewDocSrc}
        return viewSecureDocument(docRef, fallbackName, options);
        `
      );

      return await fn(
        options, fallbackName, docRef,
        scope.alert, scope.console, scope.window, scope.document, scope.URL, scope.setTimeout, scope.firebase,
        scope.DB_SUFFIX, scope.currentProspectId, scope.escapeHtmlDoc, scope.showLoading, scope.hideLoading,
        scope.resolveStoragePath, scope.isFormatPreviewable, scope.downloadSecureDocument, scope.fetch
      );
    };

    test('visualiza PDF llamando a getSecureDownloadUrlAdmin y cargando Blob inline en pestaña', async () => {
      const doc = { storagePath: 'prod_files/prospects/P1/facturas/fac1.pdf', name: 'factura_001.pdf' };
      await executeViewSecureDocument(doc, 'Factura', { prospectId: 'P1' });

      // Verificamos payload enviado a getSecureDownloadUrlAdmin
      expect(mockCallablePayload).toEqual({
        storagePath: 'prod_files/prospects/P1/facturas/fac1.pdf',
        fileName: 'factura_001.pdf',
        dbSuffix: '_prod',
        prospectId: 'P1',
        clientId: null
      });

      // Se intentó fetch
      expect(fetchCalledWith).toBe(mockCallableResult.data.signedUrl);

      // Pestaña navegó al blob inline
      expect(mockTab.location.href).toBe('blob:https://erp.ductsal.com/mock-blob-uuid');
    });

    test('si fetch() a Blob falla (ej. restricción CORS de bucket), navega directamente a la URL firmada V4', async () => {
      const doc = { storagePath: 'prod_files/prospects/P1/facturas/fac1.pdf', name: 'factura_001.pdf' };
      const failingFetch = async () => {
        throw new TypeError('Failed to fetch (CORS header missing)');
      };

      await executeViewSecureDocument(doc, 'Factura', { prospectId: 'P1' }, failingFetch);

      // Confirmamos que hizo fallback limpio a la URL firmada sin mostrar error
      expect(mockTab.location.href).toBe(mockCallableResult.data.signedUrl);
      expect(mockAlerts).toHaveLength(0);
      expect(mockConsoleWarns).toHaveLength(1);
      expect(mockConsoleWarns[0].msg).toContain('Fetch directo a Blob no disponible');
    });

    test('si options.download es true, viewSecureDocument descarga el archivo con <a>', async () => {
      const doc = { storagePath: 'prod_files/prospects/P1/facturas/fac1.pdf', name: 'factura_001.pdf' };
      await executeViewSecureDocument(doc, 'Factura', { download: true, prospectId: 'P1' });

      expect(mockElements).toHaveLength(1);
      const a = mockElements[0];
      expect(a.tag).toBe('a');
      expect(a.href).toBe(mockCallableResult.data.signedUrl);
      expect(a.download).toBe('factura_001.pdf');
      expect(a.click).toHaveBeenCalled();
    });

    test('captura permission-denied del servidor y muestra mensaje amigable sin crash', async () => {
      const doc = { storagePath: 'prod_files/prospects/P1/facturas/fac1.pdf', name: 'factura_001.pdf' };
      mockCallableError = {
        code: 'functions/permission-denied',
        message: 'No tienes autorización para acceder a este documento'
      };

      await executeViewSecureDocument(doc, 'Factura', { prospectId: 'P1' });

      expect(mockTab.document.write).toHaveBeenCalled();
      const htmlWritten = mockTab.document.write.mock.calls[mockTab.document.write.mock.calls.length - 1][0];
      expect(htmlWritten).toContain('Acceso denegado');
      expect(htmlWritten).toContain('functions/permission-denied');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Verificación de Autorización del Servidor (storageService.js)
  // ---------------------------------------------------------------------------
  describe('3. Conservación de la autorización del servidor en storageService', () => {
    let storageService;
    let mockFiles;
    let fakeDb;

    beforeEach(() => {
      mockFiles = new Map();
      fakeDb = createFakeFirestore();

      const fakeBucket = {
        name: 'ductsal-erp.firebasestorage.app',
        file: (filePath) => ({
          exists: async () => [mockFiles.has(filePath)],
          getMetadata: async () => {
            const f = mockFiles.get(filePath);
            return f ? [{ size: f.size || 1024, contentType: f.contentType || 'application/pdf' }] : [{}];
          },
          getSignedUrl: async (cfg) => {
            return [`https://storage.googleapis.com/ductsal-erp.firebasestorage.app/${filePath}?signature=mock_v4_sig`];
          }
        })
      };

      storageService = createStorageService({
        bucket: fakeBucket,
        db: fakeDb,
        names: {
          clients: 'clients_prod',
          prospects: 'prospects_prod',
          reservations: 'client_reservations_prod'
        }
      });
    });

    test('manager puede obtener URL de descarga para documento de prospecto existente', async () => {
      const path = 'prod_files/prospects/P100/facturas/factura.pdf';
      mockFiles.set(path, { size: 5000, contentType: 'application/pdf' });

      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'MGR1' };
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: path,
        fileName: 'factura.pdf'
      });

      expect(res.signedUrl).toContain('storage.googleapis.com');
      expect(res.storagePath).toBe(path);
      expect(res.fileName).toBe('factura.pdf');
    });

    test('vendedor no asignado a prospecto es rechazado con permission-denied', async () => {
      const path = 'prod_files/prospects/P100/facturas/factura.pdf';
      mockFiles.set(path, { size: 5000, contentType: 'application/pdf' });

      // Seed prospect owned by V_OTHER
      await fakeDb.collection('prospects_prod').doc('P100').set({
        id: 'P100',
        createdBy: 'V_OTHER',
        vendedorId: 'V_OTHER'
      });

      const caller = { uid: 'uid-vendedor', role: 'vendedor', cid: 'V_ATTACKER' };
      await expect(
        storageService.getSecureDownloadUrl({
          caller,
          storagePath: path,
          fileName: 'factura.pdf',
          prospectId: 'P100'
        })
      ).rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });
  });
});
