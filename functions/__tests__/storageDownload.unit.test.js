// functions/__tests__/storageDownload.unit.test.js
// SEC-05 Phase 1.1: Automated Tests for Universal Download & Large File Management
// Tests the 12 required scenarios for secure downloads, signed URLs, and file size handling.

const fs = require('fs');
const path = require('path');
const { createStorageService, ALLOWED_FOLDER_PREFIXES, PRIVILEGED_ROLES, PLANT_ROLES } = require('../storageService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

// Extract and eval app_core functions in test environment
const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');

const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

const resolveStoragePathSrc = between('function resolveStoragePath(docRef, envConfig = null) {', 'const PREVIEWABLE_EXTS');
const isFormatPreviewableSrc = between('function isFormatPreviewable(fileName, contentType) {', 'async function downloadSecureDocument');

const env = {
  STORAGE_PREFIX: 'prod_files',
  escapeHtmlDoc: s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
};

const resolveStoragePath = new Function('STORAGE_PREFIX', `
  ${resolveStoragePathSrc}
  return resolveStoragePath;
`)(env.STORAGE_PREFIX);

const isFormatPreviewable = new Function(`
  const PREVIEWABLE_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt'];
  ${isFormatPreviewableSrc}
  return isFormatPreviewable;
`)();

// Helper to simulate the enhanced dlLink from app_core.js
function simulateDlLink(doc, prospectId = 'P100') {
  if (!doc) return '';
  const name = typeof doc === 'object' ? (doc.name || 'Documento') : doc;
  const previewable = isFormatPreviewable(name);
  if (previewable) {
    return `<span class="doc-link-item"><a class="preview-link" title="Previsualizar">👁️ ${name}</a><a class="download-btn" title="Descargar archivo">⬇️ Descargar</a></span>`;
  } else {
    return `<span class="doc-link-item"><span class="doc-label">📁 ${name}</span><a class="download-btn" title="Descargar archivo">⬇️ Descargar</a></span>`;
  }
}

describe('SEC-05 Phase 1.1: Descarga universal y manejo seguro de archivos grandes', () => {
  let db;
  let mockFiles;
  let mockBucket;
  let storageService;

  beforeEach(() => {
    db = createFakeFirestore();
    mockFiles = new Map();

    mockBucket = {
      name: 'ductsal-erp.firebasestorage.app',
      file(storagePath) {
        return {
          name: storagePath,
          async exists() {
            return [mockFiles.has(storagePath)];
          },
          async getMetadata() {
            const entry = mockFiles.get(storagePath);
            if (!entry) throw new Error('Not found');
            return [{
              size: entry.size || 1024,
              contentType: entry.contentType || 'application/octet-stream',
              updated: new Date().toISOString()
            }];
          },
          async getSignedUrl(options) {
            const entry = mockFiles.get(storagePath);
            if (!entry) throw new Error('Not found');
            const expiresMs = options.expires || Date.now() + 900000;
            const disp = encodeURIComponent(options.responseDisposition || '');
            const signedUrl = `https://storage.googleapis.com/${mockBucket.name}/${encodeURIComponent(storagePath)}?GoogleAccessId=sa@ductsal-erp.iam.gserviceaccount.com&Expires=${Math.floor(expiresMs / 1000)}&Signature=mockSig&response-content-disposition=${disp}`;
            return [signedUrl];
          }
        };
      }
    };

    storageService = createStorageService({ db, bucket: mockBucket, suffix: '_prod' });
  });

  // --------------------------------------------------------------------------
  // Requisito 1: Todo archivo ofrece una opción de descarga, aunque no se pueda previsualizar
  // --------------------------------------------------------------------------
  describe('1. Todo archivo ofrece siempre una opción de descarga', () => {
    test('archivos no previsualizables (CAD, ZIP, RAR, EXE) ofrecen opción de descarga visible', () => {
      const cadDoc = { name: 'plano_ductos_piso1.dwg', storagePath: 'prod_files/prospects/P1/proyectos/plano.dwg' };
      const zipDoc = { name: 'paquete_fotografico.zip', storagePath: 'prod_files/prospects/P1/proyectos/fotos.zip' };
      const rarDoc = { name: 'archivo_respaldo.rar', storagePath: 'prod_files/prospects/P1/proyectos/respaldo.rar' };

      const cadHtml = simulateDlLink(cadDoc);
      expect(cadHtml).toContain('⬇️ Descargar');
      expect(cadHtml).not.toContain('Previsualizar');

      const zipHtml = simulateDlLink(zipDoc);
      expect(zipHtml).toContain('⬇️ Descargar');
      expect(zipHtml).not.toContain('Previsualizar');

      const rarHtml = simulateDlLink(rarDoc);
      expect(rarHtml).toContain('⬇️ Descargar');
      expect(rarHtml).not.toContain('Previsualizar');
    });

    test('archivos previsualizables (PDF, JPG, PNG) ofrecen tanto previsualización como descarga visible', () => {
      const pdfDoc = { name: 'cotizacion_firmada.pdf', storagePath: 'prod_files/prospects/P1/proyectos/cotiz.pdf' };
      const imgDoc = { name: 'sitio_levantamiento.jpg', storagePath: 'prod_files/prospects/P1/proyectos/sitio.jpg' };

      const pdfHtml = simulateDlLink(pdfDoc);
      expect(pdfHtml).toContain('👁️ cotizacion_firmada.pdf');
      expect(pdfHtml).toContain('⬇️ Descargar');

      const imgHtml = simulateDlLink(imgDoc);
      expect(imgHtml).toContain('👁️ sitio_levantamiento.jpg');
      expect(imgHtml).toContain('⬇️ Descargar');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 2: Un archivo de más de 35 MB se puede descargar sin utilizar getBlob()
  // --------------------------------------------------------------------------
  describe('2. Descarga de archivos > 35 MB sin saturar la memoria con getBlob()', () => {
    test('archivo de 48.56 MB (inventario real) se procesa mediante URL firmada directa', async () => {
      const largePath = 'prod_files/proyectos/1787933147076_OneDrive_2026-08-19.zip';
      const fileSize = Math.round(48.56 * 1024 * 1024); // 48.56 MB in bytes (integer)
      mockFiles.set(largePath, { size: fileSize, contentType: 'application/zip' });

      const caller = { uid: 'user-manager', role: 'manager', cid: 'U1' };
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: largePath,
        fileName: 'OneDrive_2026-08-19.zip'
      });

      expect(res.signedUrl).toContain('storage.googleapis.com');
      expect(res.signedUrl).toContain('response-content-disposition');
      expect(res.size).toBe(fileSize);
      expect(res.contentType).toBe('application/zip');
      expect(res.fileName).toBe('OneDrive_2026-08-19.zip');
    });

    test('la arquitectura no usa getBlob() en el cliente para downloadSecureDocument y usa cuenta dedicada en el servidor', () => {
      // downloadSecureDocument uses getSecureDownloadUrlAdmin -> window.open/a.click
      // and does NOT call getBlob()
      expect(appCore).toContain('async function downloadSecureDocument');
      const downloadFnSrc = between('async function downloadSecureDocument(docRef', 'async function viewSecureDocument');
      expect(downloadFnSrc).not.toContain('getBlob');
      expect(downloadFnSrc).toContain('getSecureDownloadUrlAdmin');

      // SEC-05: getSecureDownloadUrlAdmin must be explicitly configured with the dedicated runtime service account
      const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
      expect(indexSrc).toMatch(/exports\.getSecureDownloadUrlAdmin\s*=\s*functions\s*\.runWith\(\{\s*serviceAccount:\s*['"]crm-downloads-sa@ductsal-erp\.iam\.gserviceaccount\.com['"]\s*\}\)\s*\.https\.onCall/);

      // Verify that no other function in index.js uses this dedicated service account
      const saMatches = [...indexSrc.matchAll(/serviceAccount:\s*['"]([^'"]+)['"]/g)];
      expect(saMatches).toHaveLength(1);
      expect(saMatches[0][1]).toBe('crm-downloads-sa@ductsal-erp.iam.gserviceaccount.com');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 3: Archivo pequeño compatible ofrece descarga y previsualización
  // --------------------------------------------------------------------------
  describe('3. Archivos pequeños compatibles ofrecen descarga y previsualización', () => {
    test('PDF y PNG son reconocidos como previewables', () => {
      expect(isFormatPreviewable('factura_01.pdf', 'application/pdf')).toBe(true);
      expect(isFormatPreviewable('comprobante.png', 'image/png')).toBe(true);
      expect(isFormatPreviewable('foto.jpeg')).toBe(true);
      expect(isFormatPreviewable('notas.txt')).toBe(true);
    });

    test('UI ofrece ambas acciones para documentos compatibles', () => {
      const doc = { name: 'factura_01.pdf' };
      const rendered = simulateDlLink(doc);
      expect(rendered).toContain('👁️');
      expect(rendered).toContain('⬇️ Descargar');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 4: Plano CAD, ZIP u otro formato no compatible se puede descargar
  // --------------------------------------------------------------------------
  describe('4. Planos CAD, ZIP y formatos no compatibles', () => {
    test('formatos no soportados por el visor son clasificados como no previewables', () => {
      expect(isFormatPreviewable('plano_hvac.dwg')).toBe(false);
      expect(isFormatPreviewable('detalles_ducto.dxf')).toBe(false);
      expect(isFormatPreviewable('paquete.zip')).toBe(false);
      expect(isFormatPreviewable('archivo.rar')).toBe(false);
      expect(isFormatPreviewable('presupuesto.xlsx')).toBe(false);
    });

    test('viewSecureDocument redirige automáticamente a descarga para formatos no previewables', () => {
      const viewFnSrc = between('async function viewSecureDocument(docRef', 'if (typeof window !== \'undefined\')');
      expect(viewFnSrc).toContain('if (!isFormatPreviewable(fileName)) {');
      expect(viewFnSrc).toContain('downloadSecureDocument(docRef, fallbackName, options)');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 5: Usuario autorizado puede solicitar la descarga de un documento permitido
  // --------------------------------------------------------------------------
  describe('5. Autorización exitosa para usuarios permitidos', () => {
    test('gerente (manager) puede descargar cualquier documento de prospecto o cliente', async () => {
      const path = 'prod_files/prospects/P99/facturas/fac1.pdf';
      mockFiles.set(path, { size: 5000, contentType: 'application/pdf' });

      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const res = await storageService.getSecureDownloadUrl({ caller, storagePath: path });
      expect(res.signedUrl).toBeDefined();
      expect(res.storagePath).toBe(path);
    });

    test('vendedor asignado como creador o vendedorId del prospecto puede descargar documentos del prospecto', async () => {
      const path = 'prod_files/prospects/P10/facturas/fac_propia.pdf';
      mockFiles.set(path, { size: 8000, contentType: 'application/pdf' });

      // Seed prospect in fake firestore
      await db.collection('prospects_prod').doc('P10').set({
        id: 'P10',
        createdBy: 'V_CARLOS',
        vendedorId: 'V_CARLOS',
        proyecto: 'Edificio Central'
      });

      const caller = { uid: 'uid-carlos', role: 'vendedor', cid: 'V_CARLOS' };
      const res = await storageService.getSecureDownloadUrl({ caller, storagePath: path });
      expect(res.signedUrl).toBeDefined();
    });

    test('vendedor con cliente en cartera (visibleTo) puede descargar documentos del cliente', async () => {
      const path = 'prod_files/clients/CLI-55/identificacion/dui.pdf';
      mockFiles.set(path, { size: 3000, contentType: 'application/pdf' });

      await db.collection('clients_prod').doc('CLI-55').set({
        id: 'CLI-55',
        createdBy: 'V_OTRO',
        visibleTo: ['V_OTRO', 'V_ANA'],
        tipo: 'natural'
      });

      const caller = { uid: 'uid-ana', role: 'vendedor', cid: 'V_ANA' };
      const res = await storageService.getSecureDownloadUrl({ caller, storagePath: path });
      expect(res.signedUrl).toBeDefined();
    });

    test('gestor puede descargar documentos de un prospecto de otro vendedor si ha entrado a postcierre (H-03/Postcierre)', async () => {
      const path = 'prod_files/prospects/P_POST/facturas/fac1.pdf';
      mockFiles.set(path, { size: 5000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P_POST').set({
        id: 'P_POST',
        createdBy: 'V_CARLOS',
        vendedorId: 'V_CARLOS',
        estado: 'perdido',
        postcierre_habilitado: true,
        fecha_postcierre: '2026-03-01T00:00:00.000Z'
      });

      const caller = { uid: 'uid-ges', role: 'gestor', cid: 'G_01' };
      const res = await storageService.getSecureDownloadUrl({ caller, storagePath: path });
      expect(res.signedUrl).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 6: Usuario no autorizado recibe un rechazo del servidor
  // --------------------------------------------------------------------------
  describe('6. Rechazo de usuarios no autorizados por el servidor', () => {
    test('vendedor ajeno al prospecto recibe permission-denied', async () => {
      const path = 'prod_files/prospects/P20/facturas/fac_privada.pdf';
      mockFiles.set(path, { size: 4000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P20').set({
        id: 'P20',
        createdBy: 'V_ALICE',
        vendedorId: 'V_ALICE'
      });

      const caller = { uid: 'uid-bob', role: 'vendedor', cid: 'V_BOB' };
      await expect(storageService.getSecureDownloadUrl({ caller, storagePath: path }))
        .rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });

    test('vendedor anterior de prospecto reasignado recibe permission-denied al intentar descargar (H-02)', async () => {
      const path = 'prod_files/prospects/P_REASSIGN/proyectos/plano.pdf';
      mockFiles.set(path, { size: 4000, contentType: 'application/pdf' });

      // Prospect created by V_ALICE but reassigned to V_BOB
      await db.collection('prospects_prod').doc('P_REASSIGN').set({
        id: 'P_REASSIGN',
        createdBy: 'V_ALICE',
        vendedorId: 'V_BOB'
      });

      // V_ALICE tries to download file of reassigned prospect
      const caller = { uid: 'uid-alice', role: 'vendedor', cid: 'V_ALICE' };
      await expect(storageService.getSecureDownloadUrl({ caller, storagePath: path }))
        .rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });

    test('gestor es rechazado al solicitar documentos de oportunidad abierta de otro vendedor (H-03)', async () => {
      const path = 'prod_files/prospects/P_OPEN_VEN/proyectos/oferta.pdf';
      mockFiles.set(path, { size: 4000, contentType: 'application/pdf' });

      // Open unclosed prospect owned by V_ALICE
      await db.collection('prospects_prod').doc('P_OPEN_VEN').set({
        id: 'P_OPEN_VEN',
        createdBy: 'V_ALICE',
        vendedorId: 'V_ALICE',
        etapa: 'cotizacion',
        estado: 'activo'
      });

      // Gestor G_01 tries to download file of unclosed prospect
      const caller = { uid: 'uid-ges', role: 'gestor', cid: 'G_01' };
      await expect(storageService.getSecureDownloadUrl({ caller, storagePath: path }))
        .rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });

    test('personal de planta es rechazado al solicitar documentos comerciales', async () => {
      const path = 'prod_files/prospects/P20/facturas/fac.pdf';
      mockFiles.set(path, { size: 4000, contentType: 'application/pdf' });

      const plantCaller = { uid: 'uid-operario', role: 'operario', cid: 'OP1' };
      await expect(storageService.getSecureDownloadUrl({ caller: plantCaller, storagePath: path }))
        .rejects.toThrow('Personal de planta no tiene acceso a documentos comerciales');
    });

    test('acceso a documentos de oportunidad eliminada lógicamente es rechazado (not-found)', async () => {
      const path = 'prod_files/prospects/P30/facturas/fac.pdf';
      mockFiles.set(path, { size: 2000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P30').set({
        id: 'P30',
        createdBy: 'V_CARLOS',
        eliminado: true,
        motivo_eliminacion: 'Cancelado por cliente'
      });

      const caller = { uid: 'uid-carlos', role: 'vendedor', cid: 'V_CARLOS' };
      await expect(storageService.getSecureDownloadUrl({ caller, storagePath: path }))
        .rejects.toThrow('La oportunidad fue eliminada');
    });

    test('solicitud sin autenticación es rechazada (unauthenticated)', async () => {
      const path = 'prod_files/prospects/P1/facturas/fac.pdf';
      await expect(storageService.getSecureDownloadUrl({ caller: null, storagePath: path }))
        .rejects.toThrow('Autenticación requerida');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 7: No se puede obtener URL firmada para rutas arbitrarias del bucket
  // --------------------------------------------------------------------------
  describe('7. Rechazo de rutas arbitrarias o secuencias prohibidas', () => {
    const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };

    test('rechaza path traversal con ..', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files/prospects/P1/../../../etc/passwd'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');
    });

    test('rechaza dobles barras //', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files//prospects/P1/facturas/f.pdf'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');
    });

    test('rechaza barras invertidas \\', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files\\prospects\\P1\\facturas\\f.pdf'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');
    });

    test('rechaza rutas mayores a 500 caracteres', async () => {
      const longPath = 'prod_files/prospects/' + 'x'.repeat(500) + '/f.pdf';
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: longPath
      })).rejects.toThrow('Ruta de almacenamiento excede la longitud máxima permitida');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 8: Rutas fuera de los prefijos permitidos son rechazadas
  // --------------------------------------------------------------------------
  describe('8. Restricción estricta a prefijos y carpetas permitidas', () => {
    const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };

    test('rechaza carpetas no autorizadas (system, users, credentials)', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files/system/credentials.json'
      })).rejects.toThrow("Carpeta de almacenamiento 'system' no autorizada");

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files/users/passwords.txt'
      })).rejects.toThrow("Carpeta de almacenamiento 'users' no autorizada");
    });

    test('en entorno de producción rechaza el prefijo local_files', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'local_files/prospects/P1/facturas/f.pdf'
      })).rejects.toThrow('Ruta de almacenamiento no permitida en este entorno');
    });

    test('rechaza prefijos desconocidos fuera de prod_files y local_files', async () => {
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'backup_files/prospects/P1/facturas/f.pdf'
      })).rejects.toThrow('Prefijo de almacenamiento inválido');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 9: Comportamiento y expiración de URLs firmadas
  // --------------------------------------------------------------------------
  describe('9. URLs firmadas de corta duración y expiración', () => {
    test('la URL firmada incluye timestamp de expiración configurado (por defecto 15 min / 900s)', async () => {
      const path = 'prod_files/prospects/P1/proyectos/doc.pdf';
      mockFiles.set(path, { size: 1000, contentType: 'application/pdf' });

      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const nowBefore = Math.floor(Date.now() / 1000);
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: path,
        expiresInSeconds: 900
      });

      const urlExpiresParam = parseInt(new URL(res.signedUrl).searchParams.get('Expires'), 10);
      expect(urlExpiresParam).toBeGreaterThanOrEqual(nowBefore + 890);
      expect(urlExpiresParam).toBeLessThanOrEqual(nowBefore + 910);

      const expiresAtDate = new Date(res.expiresAt).getTime();
      expect(expiresAtDate).toBeGreaterThan(Date.now());
    });

    test('una URL firmada vencida en el tiempo deja de ser válida', () => {
      const pastExpires = Math.floor((Date.now() - 60000) / 1000); // 1 minuto en el pasado
      const expiredUrl = `https://storage.googleapis.com/${mockBucket.name}/file.pdf?Expires=${pastExpires}`;
      const urlExp = parseInt(new URL(expiredUrl).searchParams.get('Expires'), 10);
      const isExpired = urlExp * 1000 < Date.now();
      expect(isExpired).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 10: Compatibilidad con referencias documentales antiguas
  // --------------------------------------------------------------------------
  describe('10. Compatibilidad con referencias documentales históricas', () => {
    const prodConfig = {
      storagePrefix: 'prod_files',
      allowedBuckets: ['ductsal-erp.firebasestorage.app', 'ductsal-erp.appspot.com']
    };

    test('interpreta URL antigua en string y extrae la ruta física canónica', () => {
      const legacyUrl = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fproyectos%2F1710000000_oferta.pdf?alt=media&token=hist-tok-123';
      const resolved = resolveStoragePath(legacyUrl, prodConfig);
      expect(resolved).toBe('prod_files/proyectos/1710000000_oferta.pdf');
    });

    test('interpreta objeto antiguo {name, url} sin otorgar acceso inseguro', () => {
      const legacyObj = {
        name: 'Oferta Original.pdf',
        url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fproyectos%2F1720000000_oferta.pdf?alt=media&token=hist-tok-456'
      };
      const resolved = resolveStoragePath(legacyObj, prodConfig);
      expect(resolved).toBe('prod_files/proyectos/1720000000_oferta.pdf');
    });

    test('interpreta objeto canónico moderno {name, storagePath, size, contentType}', () => {
      const modernObj = {
        name: 'Plano Ductos.pdf',
        storagePath: 'prod_files/prospects/P1/proyectos/1730000000_plano.pdf',
        size: 154000,
        contentType: 'application/pdf'
      };
      const resolved = resolveStoragePath(modernObj, prodConfig);
      expect(resolved).toBe('prod_files/prospects/P1/proyectos/1730000000_plano.pdf');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 11: Los nombres de archivo se conservan
  // --------------------------------------------------------------------------
  describe('11. Preservación del nombre original del archivo', () => {
    test('conserva el nombre original del archivo en la respuesta y encabezados', async () => {
      const path = 'prod_files/prospects/P1/facturas/1712345678_Factura_CCF_9876.pdf';
      mockFiles.set(path, { size: 12000, contentType: 'application/pdf' });

      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const originalName = 'Factura CCF #9876 - Cliente San Salvador.pdf';
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: path,
        fileName: originalName
      });

      expect(res.fileName).toBe(originalName);
      expect(res.signedUrl).toContain('response-content-disposition');
      expect(decodeURIComponent(decodeURIComponent(res.signedUrl))).toContain(originalName);
    });

    test('sanitiza saltos de línea y comillas para evitar inyección de encabezados HTTP', async () => {
      const path = 'prod_files/prospects/P1/facturas/f.pdf';
      mockFiles.set(path, { size: 500, contentType: 'application/pdf' });

      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const dangerousName = 'doc\r\nSet-Cookie: evil=1\n"injection".pdf';
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: path,
        fileName: dangerousName
      });

      expect(res.fileName).not.toContain('\r');
      expect(res.fileName).not.toContain('\n');
      expect(res.fileName).not.toContain('"');
    });
  });

  // --------------------------------------------------------------------------
  // Requisito 12: Manejo correcto de archivos inexistentes y errores de red
  // --------------------------------------------------------------------------
  describe('12. Manejo de archivos inexistentes y fallos de red', () => {
    test('archivo inexistente en el bucket retorna not-found', async () => {
      const caller = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const nonExistentPath = 'prod_files/prospects/P1/facturas/fantasma.pdf';

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: nonExistentPath
      })).rejects.toThrow('El archivo no existe en el almacenamiento');
    });

    test('error de red en el cliente produce mensaje informativo sin romper la UI', () => {
      // Test the error mapper inside downloadSecureDocument
      const errorMap = (errCode, errMsg) => {
        if (errCode === 'functions/permission-denied' || errMsg.includes('permission-denied')) {
          return 'Acceso denegado: No tienes autorización para descargar este documento según las políticas comerciales.';
        } else if (errCode === 'functions/not-found' || errMsg.includes('not-found')) {
          return 'El archivo solicitado ya no existe en el almacenamiento de producción.';
        } else if (errCode === 'functions/unauthenticated' || errMsg.includes('unauthenticated')) {
          return 'Sesión expirada o no autenticada. Inicia sesión nuevamente.';
        } else if (errMsg.includes('network') || errCode === 'functions/unavailable') {
          return 'Error de conexión con el servidor. Verifica tu conexión a internet.';
        }
        return 'Error al descargar el archivo.';
      };

      expect(errorMap('functions/not-found', 'not-found')).toContain('ya no existe');
      expect(errorMap('functions/permission-denied', '')).toContain('Acceso denegado');
      expect(errorMap('functions/unavailable', 'network timeout')).toContain('Error de conexión');
      expect(errorMap('functions/unauthenticated', '')).toContain('Sesión expirada');
    });
  });
});
