// functions/__tests__/storageReview.unit.test.js
// SEC-05 Fase 1.3: Pruebas automatizadas de las correcciones de seguridad
// Verifica la resolución de H-01, H-02, H-04, H-06 y H-07

const fs = require('fs');
const path = require('path');
const {
  createStorageService,
  normalizeExpirationSeconds,
  sanitizeFileName,
  buildContentDisposition,
  objectReferencesStoragePath
} = require('../storageService');
const { createClientsService } = require('../clientsService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

describe('SEC-05 Fase 1.3: Verificación de Correcciones de Seguridad', () => {
  let db;
  let mockFiles;
  let mockBucket;
  let storageService;
  let clientsService;

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
              contentType: entry.contentType || 'application/octet-stream'
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
    clientsService = createClientsService({ db, suffix: '_prod' });
  });

  // --------------------------------------------------------------------------
  // H-01: Autorización del archivo concreto en rutas planas
  // --------------------------------------------------------------------------
  describe('H-01: Autorización del archivo concreto en rutas planas', () => {
    test('1. Vendedor A NO puede descargar archivo de Vendedor B usando ID de una oportunidad propia', async () => {
      const secretBPath = 'prod_files/proyectos/1780000000_cotizacion_confidencial_B.pdf';
      mockFiles.set(secretBPath, { size: 15000, contentType: 'application/pdf' });

      // Oportunidad legítima de Vendedor A (sin referencia al archivo de B)
      await db.collection('prospects_prod').doc('P_A').set({
        id: 'P_A',
        createdBy: 'VENDEDOR_A',
        vendedorId: 'VENDEDOR_A',
        proyecto: 'Proyecto A',
        datos: {
          doc_oferta: { name: 'oferta_A.pdf', storagePath: 'prod_files/prospects/P_A/proyectos/oferta_A.pdf' }
        }
      });

      const callerA = { uid: 'uid-a', role: 'vendedor', cid: 'VENDEDOR_A' };

      // Se rechaza porque el archivo no está en el expediente P_A
      await expect(storageService.getSecureDownloadUrl({
        caller: callerA,
        storagePath: secretBPath,
        prospectId: 'P_A'
      })).rejects.toThrow('El archivo no está vinculado a la oportunidad indicada');
    });

    test('2. Vendedor autorizado SÍ puede descargar archivo realmente referenciado en su expediente', async () => {
      const flatPath = 'prod_files/proyectos/1715000000_oferta_legitima.pdf';
      mockFiles.set(flatPath, { size: 20000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P_AUTORIZADO').set({
        id: 'P_AUTORIZADO',
        createdBy: 'V_ANA',
        vendedorId: 'V_ANA',
        proyecto: 'Torre Vista',
        datos: {
          doc_oferta: { name: 'Oferta Oficial.pdf', storagePath: flatPath }
        }
      });

      const callerAna = { uid: 'uid-ana', role: 'vendedor', cid: 'V_ANA' };

      const res = await storageService.getSecureDownloadUrl({
        caller: callerAna,
        storagePath: flatPath,
        prospectId: 'P_AUTORIZADO'
      });

      expect(res.storagePath).toBe(flatPath);
      expect(res.signedUrl).toBeDefined();
    });

    test('3. Una ruta plana sin relación verificable (sin prospectId ni clientId) se rechaza', async () => {
      const flatPath = 'prod_files/facturas/1719999999_factura_huerfana.pdf';
      mockFiles.set(flatPath, { size: 8000, contentType: 'application/pdf' });

      const caller = { uid: 'uid-carlos', role: 'vendedor', cid: 'V_CARLOS' };

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: flatPath
      })).rejects.toThrow('No se pudo verificar la autorización para acceder al archivo solicitado');
    });

    test('4. Referencias históricas con URL pública en Firestore son validadas sin usar el token como autorización', async () => {
      const legacyPath = 'prod_files/facturas/1710000000_fac_antigua.pdf';
      mockFiles.set(legacyPath, { size: 12000, contentType: 'application/pdf' });

      const legacyUrlWithToken = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Ffacturas%2F1710000000_fac_antigua.pdf?alt=media&token=antiguo-token-secreto-123';

      await db.collection('prospects_prod').doc('P_HISTORICO').set({
        id: 'P_HISTORICO',
        createdBy: 'V_JUAN',
        vendedorId: 'V_JUAN',
        facturas: [
          {
            numero: 'FAC-001',
            monto: 1500,
            doc_factura: legacyUrlWithToken // Referencia antigua como string URL
          }
        ]
      });

      const callerJuan = { uid: 'uid-juan', role: 'vendedor', cid: 'V_JUAN' };

      const res = await storageService.getSecureDownloadUrl({
        caller: callerJuan,
        storagePath: legacyPath,
        prospectId: 'P_HISTORICO'
      });

      expect(res.storagePath).toBe(legacyPath);
      expect(res.signedUrl).toBeDefined();

      // Otro vendedor intentando acceder al mismo archivo con su propio prospecto debe ser denegado
      const callerOtro = { uid: 'uid-otro', role: 'vendedor', cid: 'V_OTRO' };
      await db.collection('prospects_prod').doc('P_OTRO').set({
        id: 'P_OTRO',
        createdBy: 'V_OTRO',
        vendedorId: 'V_OTRO'
      });

      await expect(storageService.getSecureDownloadUrl({
        caller: callerOtro,
        storagePath: legacyPath,
        prospectId: 'P_OTRO'
      })).rejects.toThrow('El archivo no está vinculado a la oportunidad indicada');
    });

    test('5. Gerente (manager) conserva acceso universal para auditoría', async () => {
      const flatPath = 'prod_files/proyectos/1787933147076_OneDrive_2026-08-19.zip';
      mockFiles.set(flatPath, { size: 48.56 * 1024 * 1024, contentType: 'application/zip' });

      const callerManager = { uid: 'uid-mgr', role: 'manager', cid: 'M1' };
      const res = await storageService.getSecureDownloadUrl({
        caller: callerManager,
        storagePath: flatPath
      });
      expect(res.storagePath).toBe(flatPath);
    });

    test('6. Prevención de colisiones por subcadena o prefijo (exact canonical matching)', async () => {
      const storedPath = 'prod_files/proyectos/1715000000_plano_1.pdf_revision2.pdf';
      const storedUrl = `https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fproyectos%2F1715000000_plano_1.pdf_revision2.pdf?alt=media&token=token-123`;
      mockFiles.set(storedPath, { size: 10000, contentType: 'application/pdf' });

      const subPath = 'prod_files/proyectos/1715000000_plano_1.pdf';
      mockFiles.set(subPath, { size: 5000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P_SUBSTRING').set({
        id: 'P_SUBSTRING',
        createdBy: 'V_CARLOS',
        vendedorId: 'V_CARLOS',
        datos: {
          doc_oferta: storedUrl
        }
      });

      const caller = { uid: 'uid-carlos', role: 'vendedor', cid: 'V_CARLOS' };

      // Con coincidencia exacta, solicitar el subPath debe ser rechazado porque solo existe la versión larga
      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: subPath,
        prospectId: 'P_SUBSTRING'
      })).rejects.toThrow('El archivo no está vinculado a la oportunidad indicada');

      // En cambio, solicitar la ruta exacta almacenada debe tener éxito
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: storedPath,
        prospectId: 'P_SUBSTRING'
      });
      expect(res.storagePath).toBe(storedPath);
    });

    test('7. Documento legítimo de cliente cuando se suministran prospectId y clientId simultáneamente', async () => {
      const clientDocPath = 'prod_files/clientes/1715000000_escritura_constitucion.pdf';
      mockFiles.set(clientDocPath, { size: 50000, contentType: 'application/pdf' });

      await db.collection('clients_prod').doc('C_DUAL').set({
        id: 'C_DUAL',
        empresa: 'Corporación Dual S.A.',
        createdBy: 'V_MARIA',
        visibleTo: ['V_MARIA'],
        documentos: {
          escritura: {
            name: 'Escritura.pdf',
            storagePath: clientDocPath
          }
        }
      });

      // El prospecto no contiene el documento de cliente en su propio cuerpo
      await db.collection('prospects_prod').doc('P_DUAL').set({
        id: 'P_DUAL',
        clientId: 'C_DUAL',
        createdBy: 'V_MARIA',
        vendedorId: 'V_MARIA',
        proyecto: 'Proyecto Envolvente'
      });

      const caller = { uid: 'uid-maria', role: 'vendedor', cid: 'V_MARIA' };

      // Se envían ambos IDs, simulando el comportamiento del frontend cuando hay un prospecto seleccionado
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: clientDocPath,
        prospectId: 'P_DUAL',
        clientId: 'C_DUAL'
      });

      expect(res.storagePath).toBe(clientDocPath);
      expect(res.signedUrl).toBeDefined();
    });

    test('8. Comprobante de pago anidado profundamente en facturas[i].pagos[j].doc_comprobante', async () => {
      const paymentPath = 'prod_files/pagos/1715000000_comprobante_abono_3.pdf';
      mockFiles.set(paymentPath, { size: 18000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P_DEEP').set({
        id: 'P_DEEP',
        createdBy: 'V_ELENA',
        vendedorId: 'V_ELENA',
        facturas: [
          {
            id: 'fac_1',
            numero: 'F-001',
            monto: 10000,
            pagos: [
              {
                id: 'pay_1',
                monto: 3000,
                doc_comprobante: {
                  name: 'Abono_3.pdf',
                  storagePath: paymentPath
                }
              }
            ]
          }
        ]
      });

      const caller = { uid: 'uid-elena', role: 'vendedor', cid: 'V_ELENA' };

      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: paymentPath,
        prospectId: 'P_DEEP'
      });

      expect(res.storagePath).toBe(paymentPath);
      expect(res.signedUrl).toBeDefined();
    });

    test('9. Vendedor no puede acceder a documento de cliente ajeno pasando clientId ajeno', async () => {
      const flatClientPath = 'prod_files/clientes/1715000000_dui_confidencial.pdf';
      mockFiles.set(flatClientPath, { size: 12000, contentType: 'application/pdf' });

      await db.collection('clients_prod').doc('C_AJENO').set({
        id: 'C_AJENO',
        nombres: 'Cliente Ajeno',
        createdBy: 'V_DUENO',
        visibleTo: ['V_DUENO'],
        closingVendors: [],
        documentos: {
          dui: {
            name: 'DUI.pdf',
            storagePath: flatClientPath
          }
        }
      });

      const callerIntruso = { uid: 'uid-intruso', role: 'vendedor', cid: 'V_INTRUSO' };

      await expect(storageService.getSecureDownloadUrl({
        caller: callerIntruso,
        storagePath: flatClientPath,
        clientId: 'C_AJENO'
      })).rejects.toThrow('No tienes permiso para acceder a los documentos de este cliente');
    });

    test('10. Vendedor no puede acceder a documento pasando prospectId ajeno', async () => {
      const prospectDocPath = 'prod_files/proyectos/1715000000_oferta_secreta.pdf';
      mockFiles.set(prospectDocPath, { size: 25000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P_AJENO').set({
        id: 'P_AJENO',
        createdBy: 'V_DUENO',
        vendedorId: 'V_DUENO',
        datos: {
          doc_oferta: { name: 'Oferta.pdf', storagePath: prospectDocPath }
        }
      });

      const callerIntruso = { uid: 'uid-intruso', role: 'vendedor', cid: 'V_INTRUSO' };

      await expect(storageService.getSecureDownloadUrl({
        caller: callerIntruso,
        storagePath: prospectDocPath,
        prospectId: 'P_AJENO'
      })).rejects.toThrow('No tienes acceso a los documentos de esta oportunidad');
    });

    test('11. Rutas manipuladas con secuencias prohibidas o incompletas son denegadas', async () => {
      const caller = { uid: 'uid-ana', role: 'vendedor', cid: 'V_ANA' };

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files/../etc/passwd'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files//proyectos/archivo.pdf'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files\\proyectos\\archivo.pdf'
      })).rejects.toThrow('Ruta de almacenamiento contiene secuencias prohibidas');

      await expect(storageService.getSecureDownloadUrl({
        caller,
        storagePath: 'prod_files'
      })).rejects.toThrow('Ruta de almacenamiento incompleta');
    });
  });

  // --------------------------------------------------------------------------
  // H-02: Limitar la expiración en el servidor
  // --------------------------------------------------------------------------
  describe('H-02: Limitar la expiración en el servidor', () => {
    test('solicitud de 7 días (604800s) se acota forzosamente a 900s máximo', async () => {
      const path = 'prod_files/prospects/P1/facturas/fac.pdf';
      mockFiles.set(path, { size: 5000, contentType: 'application/pdf' });

      await db.collection('prospects_prod').doc('P1').set({
        id: 'P1',
        createdBy: 'V_CARLOS',
        vendedorId: 'V_CARLOS'
      });

      const caller = { uid: 'uid-carlos', role: 'vendedor', cid: 'V_CARLOS' };
      const res = await storageService.getSecureDownloadUrl({
        caller,
        storagePath: path,
        expiresInSeconds: 7 * 24 * 60 * 60 // 7 días
      });

      const expiresParam = parseInt(new URL(res.signedUrl).searchParams.get('Expires'), 10);
      const expectedMax = Math.floor(Date.now() / 1000) + 900;
      expect(Math.abs(expiresParam - expectedMax)).toBeLessThanOrEqual(5);

      const diffMs = new Date(res.expiresAt).getTime() - Date.now();
      expect(diffMs).toBeLessThanOrEqual(900 * 1000 + 1000);
    });

    test('solicitudes con valores negativos, 0 o cadenas malformadas usan el valor seguro por defecto (900s)', () => {
      expect(normalizeExpirationSeconds(-100)).toBe(900);
      expect(normalizeExpirationSeconds(0)).toBe(900);
      expect(normalizeExpirationSeconds('malicious')).toBe(900);
      expect(normalizeExpirationSeconds(null)).toBe(900);
      expect(normalizeExpirationSeconds(undefined)).toBe(900);
      expect(normalizeExpirationSeconds('')).toBe(900);
    });

    test('solicitudes legítimas menores a 900s son respetadas respetando mínimo de 60s', () => {
      expect(normalizeExpirationSeconds(300)).toBe(300);
      expect(normalizeExpirationSeconds(10)).toBe(60); // Clamped al mínimo
    });
  });

  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // H-04: Eliminación de tokens permanentes en nuevas subidas
  // --------------------------------------------------------------------------
  describe('H-04: Eliminación de tokens permanentes en nuevas subidas', () => {
    test('uploadFileToStorage no genera tokens públicos y retorna referencia canónica', () => {
      const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
      const uploadSrc = appCore.slice(appCore.indexOf('async function uploadFileToStorage('), appCore.indexOf('// ============================================================================', appCore.indexOf('async function uploadFileToStorage(')));

      // No debe ejecutar la llamada a getDownloadURL
      expect(uploadSrc).not.toContain('fileRef.getDownloadURL()');
      expect(uploadSrc).toContain('storagePath: fileRef.fullPath');
      expect(uploadSrc).toContain('size: processedFile.size');
      expect(uploadSrc).toContain('contentType: processedFile.type');
    });
  });

  // --------------------------------------------------------------------------
  // H-06: Descarga sin pestañas residuales
  // --------------------------------------------------------------------------
  describe('H-06: Descarga sin pestañas residuales', () => {
    test('downloadSecureDocument no utiliza target="_blank" en el ancla nativa de descarga', () => {
      const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
      const downloadSrc = appCore.slice(appCore.indexOf('async function downloadSecureDocument('), appCore.indexOf('async function viewSecureDocument('));

      expect(downloadSrc).not.toContain('a.target = \'_blank\'');
      expect(downloadSrc).toContain('a.download = safeDownloadName');
      expect(downloadSrc).toContain('document.body.appendChild(a)');
      expect(downloadSrc).toContain('a.click()');
      expect(downloadSrc).toContain('a.parentNode.removeChild(a)');
    });
  });

  // --------------------------------------------------------------------------
  // H-07: Nombre original y Content-Disposition (RFC 6266)
  // --------------------------------------------------------------------------
  describe('H-07: Nombre original y Content-Disposition según RFC 6266', () => {
    test('Factura 123.pdf conserva espacios en filename ASCII y en filename* UTF-8', () => {
      const header = buildContentDisposition('Factura 123.pdf');
      expect(header).toBe("attachment; filename=\"Factura 123.pdf\"; filename*=UTF-8''Factura%20123.pdf");
      expect(header).not.toContain('Factura%20123.pdf"'); // filename="..." no tiene %20
    });

    test('Cotización áéíóú.pdf codifica correctamente caracteres acentuados en filename*', () => {
      const header = buildContentDisposition('Cotización áéíóú.pdf');
      expect(header).toContain("filename*=UTF-8''Cotizaci%C3%B3n%20%C3%A1%C3%A9%C3%AD%C3%B3%C3%BA.pdf");
      // Fallback ASCII reemplaza acentos por '_' en filename="..."
      expect(header).toContain('filename="Cotizaci_n _____.pdf"');
    });

    test('Plano Ñandutí.dwg codifica correctamente caracteres con Ñ', () => {
      const header = buildContentDisposition('Plano Ñandutí.dwg');
      expect(header).toContain("filename*=UTF-8''Plano%20%C3%91andut%C3%AD.dwg");
    });

    test('Sanitización neutraliza CRLF, comillas, dos puntos y secuencias de path traversal', () => {
      const malicious = '..\\../etc/passwd\r\nSet-Cookie: session=evil\n"inyeccion".pdf';
      const clean = sanitizeFileName(malicious);

      expect(clean).not.toContain('\r');
      expect(clean).not.toContain('\n');
      expect(clean).not.toContain('"');
      expect(clean).not.toContain('..');
      expect(clean).not.toContain('/');
      expect(clean).not.toContain('\\');
    });
  });
});
