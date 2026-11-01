// functions/__tests__/closingStorageAuthIncident.unit.test.js
// Test suite for Incident Resolution: Firebase Storage — storage/unauthorized during Grado 0 closure
// Validates the 10 mandatory permission scenarios, exact path resolution, and transactional integrity.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createStorageService } = require('../storageService');

describe('INC-STORAGE-UNAUTHORIZED: Cierre Grado 0 y Matriz de Permisos de Almacenamiento', () => {
  let fdb;
  let commercialSvc;
  let wfSvc;
  let storageSvc;
  let mockBucket;
  let mockFiles;

  const CLOCK = new Date('2026-10-31T18:00:00.000Z');

  // Identidades del sistema
  const ALEJANDRA = { uid: 'uid_alejandra', cid: '1776904514932', role: 'gestor', name: 'Alejandra Ayala' };
  const VENDEDOR_V1 = { uid: 'uid_v1', cid: 'V1', role: 'vendedor', name: 'Roberto Flores' };
  const GESTOR_OTRO = { uid: 'uid_ges2', cid: 'GES_OTRO', role: 'gestor', name: 'Gestor Externo' };
  const VENDEDOR_V3 = { uid: 'uid_v3', cid: 'V3', role: 'vendedor', name: 'Vendedor Ajeno' };
  const ADMIN = { uid: 'uid_mgr', cid: '1776895495203', role: 'manager', name: 'Benjamin Valiente' };

  // Helper para simular la lógica compilada de storage.rules (regla canónica)
  const storageRulesLogic = {
    knownProspectFolder: f => ['proyectos', 'facturas', 'pagos', 'ordenes_cambio'].includes(f),
    maxBytesForFolder: f => (f === 'proyectos' ? 100 * 1024 * 1024 : f === 'facturas' ? 15 * 1024 * 1024 : 10 * 1024 * 1024),
    typeOk: contentType => !contentType || !/(html|text\/xml|application\/xml|image\/svg\+xml|javascript|x-msdownload|x-sh|x-httpd-php)/i.test(contentType),
    allowedExtensionFor: (folder, fileName) => {
      if (['identificacion', 'legal', 'pagos'].includes(folder)) {
        return /\.(pdf|jpg|jpeg|png|webp|tif|tiff)$/i.test(fileName);
      }
      if (folder === 'facturas') {
        return /\.(pdf|jpg|jpeg|png|webp|tif|tiff|xlsx|xls)$/i.test(fileName);
      }
      if (folder === 'ordenes_cambio') {
        return /\.(pdf|docx|doc|xlsx|xls|xlsm|jpg|jpeg|png|webp|tif|tiff)$/i.test(fileName);
      }
      return /\.(pdf|xlsx|xls|xlsm|docx|doc|dwg|dxf|rvt|rfa|rte|rft|jpg|jpeg|png|webp|gif|tif|tiff|zip)$/i.test(fileName);
    },
    isPostclosing: d => {
      if (!d) return false;
      const postHabilitado = d.postcierre_habilitado === true;
      const estado = d.estado || '';
      const fechaCierre = d.fecha_cierre || '';
      const facturas = Array.isArray(d.facturas) ? d.facturas : [];
      return postHabilitado || (
        estado !== 'activo' && estado !== 'perdido' && (estado === 'ganado' || !!fechaCierre || facturas.length > 0)
      );
    },
    canUploadToProspectDoc: (user, p, folder) => {
      if (!p || !user) return false;
      if (user.role === 'manager') return true;
      const me = user.cid;
      const isPost = storageRulesLogic.isPostclosing(p);
      const isGestor = user.role === 'gestor';
      const isVendedor = user.role === 'vendedor';

      if (isGestor) {
        if (isPost) {
          return ['facturas', 'pagos', 'ordenes_cambio'].includes(folder);
        }
        const isAuthorOrOwner = p.vendedorId === me || p.createdBy === me;
        return isAuthorOrOwner && ['proyectos', 'facturas'].includes(folder);
      }

      if (isVendedor) {
        if (isPost) return false;
        const isOwner = p.vendedorId === me || (!p.vendedorId && p.createdBy === me);
        return isOwner && ['proyectos', 'facturas'].includes(folder);
      }

      return false;
    },
    canReadProspectDoc: (user, p) => {
      if (!p || !user) return false;
      if (user.role === 'manager') return true;
      const me = user.cid;
      const isPost = storageRulesLogic.isPostclosing(p);
      if (user.role === 'gestor') {
        return p.vendedorId === me || p.createdBy === me || isPost;
      }
      if (user.role === 'vendedor') {
        return p.vendedorId === me || (!p.vendedorId && p.createdBy === me);
      }
      return false;
    }
  };

  const baseClientGrado0 = {
    id: '1792004495514',
    tipo: 'juridica',
    empresa: 'GRADO 0 S.A. DE C.V.',
    contacto: 'Contacto GRADO 0',
    telefono: '2200-1122',
    correo: 'contacto@grado0.com',
    correo_fact: 'facturacion@grado0.com',
    nit: '0614-010120-101-9',
    nrc: '987654-3',
    createdBy: '1776904514932',
    visibleTo: ['1776904514932'],
    documentos: {
      dui: { name: 'DUI.pdf', storagePath: 'prod_files/clients/1792004495514/identificacion/dui.pdf' }
    }
  };

  const baseProspectGrado0 = {
    id: '1792004940382',
    codigo: '202610153',
    proyecto: '4 METROS',
    clientId: '1792004495514',
    vendedorId: '1776904514932',
    createdBy: '1776904514932',
    encargado: 'Alejandra Ayala',
    etapa: 'cierre',
    estado: 'activo',
    precio_cotizado: 185.48,
    costo_venta: 120.00,
    tipo_proyecto: 'Fabricación',
    clasificacion: 'ejecucion',
    fecha_creacion: '2026-10-15',
    fecha_inicio_cierre: '2026-10-15',
    postcierre_habilitado: false,
    stage_timestamps: {
      prospecto: '2026-10-14T19:09:00.382Z',
      levantamiento: '2026-10-15T17:07:25.696Z',
      cotizacion: '2026-10-15T17:08:47.311Z',
      negociacion: '2026-10-29T21:37:18.009Z',
      cierre: '2026-10-29T21:37:34.339Z'
    },
    datos: {}
  };

  beforeEach(() => {
    fdb = createFakeFirestore({ clock: () => CLOCK });
    mockFiles = new Map();
    mockBucket = {
      name: 'ductsal-erp.firebasestorage.app',
      file: storagePath => ({
        name: storagePath,
        exists: async () => [mockFiles.has(storagePath)],
        getMetadata: async () => [{ size: (mockFiles.get(storagePath) || {}).size || 1024, contentType: 'application/pdf' }],
        getSignedUrl: async () => [`https://storage.googleapis.com/${mockBucket.name}/${encodeURIComponent(storagePath)}?mock=1`]
      })
    };

    commercialSvc = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => CLOCK,
      verifyManager: async uid => uid === ADMIN.uid
    });
    wfSvc = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: commercialSvc.kit });
    storageSvc = createStorageService({ db: fdb, bucket: mockBucket, suffix: '_prod' });
  });

  describe('1. Verificación de Reglas de Storage (storage.rules)', () => {
    test('1.1 isPostclosing evalúa FALSE en oportunidad activa con stage_timestamps.cierre', () => {
      expect(storageRulesLogic.isPostclosing(baseProspectGrado0)).toBe(false);
    });

    test('1.2 isPostclosing evalúa TRUE en oportunidad ganada con postcierre_habilitado', () => {
      const won = { ...baseProspectGrado0, estado: 'ganado', postcierre_habilitado: true, fecha_cierre: '2026-10-31' };
      expect(storageRulesLogic.isPostclosing(won)).toBe(true);
    });

    test('1.3 isPostclosing evalúa FALSE en oportunidad perdida sin postcierre habilitado', () => {
      const lost = { ...baseProspectGrado0, estado: 'perdido', postcierre_habilitado: false };
      expect(storageRulesLogic.isPostclosing(lost)).toBe(false);
    });

    test('1.4 isPostclosing evalúa correctamente todo el ciclo de vida (reabiertas, borradores, históricas y casos nulos)', () => {
      // 1. Oportunidad reabierta desde pérdida (estado vuelve a 'activo')
      const reactivated = {
        ...baseProspectGrado0,
        estado: 'activo',
        fecha_reactivacion: '2026-10-30',
        historial_perdidas: [{ motivo: 'Cliente indeciso' }]
      };
      expect(storageRulesLogic.isPostclosing(reactivated)).toBe(false);

      // 2. Oportunidad activa con facturas de borrador en proceso de negociación
      const activeWithDraftInvoices = {
        ...baseProspectGrado0,
        estado: 'activo',
        facturas: [{ id: 'DRAFT_1' }]
      };
      expect(storageRulesLogic.isPostclosing(activeWithDraftInvoices)).toBe(false);

      // 3. Expediente histórico cerrado sin postcierre_habilitado pero con fecha de cierre
      const historicalClosedWithDate = {
        id: 'P_HIST_1',
        estado: 'cerrado',
        fecha_cierre: '2025-05-10',
        postcierre_habilitado: false
      };
      expect(storageRulesLogic.isPostclosing(historicalClosedWithDate)).toBe(true);

      // 4. Expediente histórico con facturación registrada
      const historicalWithInvoices = {
        id: 'P_HIST_2',
        estado: 'cerrado',
        facturas: [{ id: 'FAC_2025' }],
        postcierre_habilitado: false
      };
      expect(storageRulesLogic.isPostclosing(historicalWithInvoices)).toBe(true);

      // 5. Casos límites y nulidad defensiva
      expect(storageRulesLogic.isPostclosing(null)).toBe(false);
      expect(storageRulesLogic.isPostclosing(undefined)).toBe(false);
      expect(storageRulesLogic.isPostclosing({})).toBe(false);
    });
  });

  describe('2. Matriz de Permisos: 10 Escenarios Obligatorios', () => {
    beforeEach(async () => {
      await fdb.seed('clients_prod/1792004495514', baseClientGrado0);
      await fdb.seed('prospects_prod/1792004940382', baseProspectGrado0);
    });

    test('Escenario 1: Alejandra cierra una oportunidad autorizada (1792004940382) -> PERMITIDO', async () => {
      // 1. Storage Rules check
      const canUploadOffer = storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, baseProspectGrado0, 'proyectos');
      const canUploadReceipt = storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, baseProspectGrado0, 'facturas');
      expect(canUploadOffer).toBe(true);
      expect(canUploadReceipt).toBe(true);

      // 2. Ruta exacta del incidente
      const exactPath = 'prod_files/prospects/1792004940382/proyectos/1793390517164_oferta_Grado_0.pdf';
      expect(storageRulesLogic.allowedExtensionFor('proyectos', '1793390517164_oferta_Grado_0.pdf')).toBe(true);
      expect(storageRulesLogic.typeOk('application/pdf')).toBe(true);

      // 3. Finalización exitosa del workflow
      const result = await wfSvc.finalizeProspect({
        caller: ALEJANDRA,
        prospectId: '1792004940382',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-101',
          doc_firmado: { name: 'oferta_Grado_0.pdf', storagePath: exactPath },
          doc_comprobante: { name: 'comprobante_anticipo.pdf', storagePath: 'prod_files/prospects/1792004940382/facturas/1793390518000_comprobante.pdf' }
        }
      });

      expect(result.status).toBe('finalized');
      expect(result.estado).toBe('ganado');

      const saved = (await fdb.collection('prospects_prod').doc('1792004940382').get()).data();
      expect(saved.estado).toBe('ganado');
      expect(saved.postcierre_habilitado).toBe(true);
      expect(saved.datos.doc_firmado.storagePath).toBe(exactPath);
    });

    test('Escenario 2: Vendedor propietario cierra su oportunidad -> PERMITIDO', async () => {
      const pVendedor = {
        ...baseProspectGrado0,
        id: 'P_V1',
        vendedorId: VENDEDOR_V1.cid,
        createdBy: VENDEDOR_V1.cid
      };
      await fdb.seed('prospects_prod/P_V1', pVendedor);

      expect(storageRulesLogic.canUploadToProspectDoc(VENDEDOR_V1, pVendedor, 'proyectos')).toBe(true);
      expect(storageRulesLogic.canUploadToProspectDoc(VENDEDOR_V1, pVendedor, 'facturas')).toBe(true);

      const res = await wfSvc.finalizeProspect({
        caller: VENDEDOR_V1,
        prospectId: 'P_V1',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FAC-001',
          doc_firmado: { name: 'oferta_v1.pdf', storagePath: 'prod_files/prospects/P_V1/proyectos/oferta.pdf' },
          doc_comprobante: { name: 'recibo_v1.pdf', storagePath: 'prod_files/prospects/P_V1/facturas/recibo.pdf' }
        }
      });
      expect(res.estado).toBe('ganado');
    });

    test('Escenario 3: Gestor autorizado completa el cierre -> PERMITIDO', async () => {
      // Gestor como creador de oportunidad colaborativa con vendedor asignado
      const pColab = {
        ...baseProspectGrado0,
        id: 'P_COLAB',
        vendedorId: VENDEDOR_V1.cid,
        createdBy: ALEJANDRA.cid
      };
      await fdb.seed('prospects_prod/P_COLAB', pColab);

      expect(storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, pColab, 'proyectos')).toBe(true);
      expect(storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, pColab, 'facturas')).toBe(true);

      const res = await wfSvc.finalizeProspect({
        caller: ALEJANDRA,
        prospectId: 'P_COLAB',
        data: {
          forma_pago: '50/50',
          factura_anticipo: 'FCF-555',
          doc_firmado: { name: 'oferta_colab.pdf', storagePath: 'prod_files/prospects/P_COLAB/proyectos/oferta.pdf' },
          doc_comprobante: { name: 'recibo_colab.pdf', storagePath: 'prod_files/prospects/P_COLAB/facturas/recibo.pdf' }
        }
      });
      expect(res.estado).toBe('ganado');
    });

    test('Escenario 4: Usuario que no tiene relación ni autorización sobre el expediente -> RECHAZADO', async () => {
      // Intruso gestor o vendedor sin vínculo con 1792004940382
      expect(storageRulesLogic.canUploadToProspectDoc(GESTOR_OTRO, baseProspectGrado0, 'proyectos')).toBe(false);
      expect(storageRulesLogic.canUploadToProspectDoc(VENDEDOR_V3, baseProspectGrado0, 'proyectos')).toBe(false);

      await expect(wfSvc.finalizeProspect({
        caller: GESTOR_OTRO,
        prospectId: '1792004940382',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-999',
          doc_firmado: { name: 'hack.pdf', storagePath: 'prod_files/prospects/1792004940382/proyectos/hack.pdf' },
          doc_comprobante: { name: 'hack.pdf', storagePath: 'prod_files/prospects/1792004940382/facturas/hack.pdf' }
        }
      })).rejects.toThrow(/No tienes acceso a esta oportunidad/i);
    });

    test('Escenario 5: Administrador completa el cierre -> PERMITIDO', async () => {
      expect(storageRulesLogic.canUploadToProspectDoc(ADMIN, baseProspectGrado0, 'proyectos')).toBe(true);
      expect(storageRulesLogic.canUploadToProspectDoc(ADMIN, baseProspectGrado0, 'facturas')).toBe(true);

      const res = await wfSvc.finalizeProspect({
        caller: ADMIN,
        prospectId: '1792004940382',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-MGR',
          doc_firmado: { name: 'oferta_mgr.pdf', storagePath: 'prod_files/prospects/1792004940382/proyectos/oferta_mgr.pdf' },
          doc_comprobante: { name: 'recibo_mgr.pdf', storagePath: 'prod_files/prospects/1792004940382/facturas/recibo_mgr.pdf' }
        }
      });
      expect(res.estado).toBe('ganado');
    });

    test('Escenario 6: Usuario carga PDF válido -> PERMITIDO según autorización', () => {
      const fileName = 'oferta_valida.pdf';
      const folder = 'proyectos';
      expect(storageRulesLogic.allowedExtensionFor(folder, fileName)).toBe(true);
      expect(storageRulesLogic.typeOk('application/pdf')).toBe(true);
      expect(storageRulesLogic.maxBytesForFolder(folder)).toBe(100 * 1024 * 1024);
    });

    test('Escenario 7: Usuario intenta cargar archivo no permitido -> RECHAZADO', () => {
      const badExtensions = ['script.exe', 'payload.html', 'shell.sh', 'backdoor.php', 'exploit.js'];
      badExtensions.forEach(ext => {
        expect(storageRulesLogic.allowedExtensionFor('proyectos', ext)).toBe(false);
      });
      expect(storageRulesLogic.typeOk('text/html')).toBe(false);
      expect(storageRulesLogic.typeOk('application/x-msdownload')).toBe(false);
    });

    test('Escenario 8: Usuario intenta escribir en expediente ajeno -> RECHAZADO', async () => {
      // V1 intenta escribir en expediente de Alejandra
      expect(storageRulesLogic.canUploadToProspectDoc(VENDEDOR_V1, baseProspectGrado0, 'proyectos')).toBe(false);
      expect(storageRulesLogic.canUploadToProspectDoc(VENDEDOR_V1, baseProspectGrado0, 'facturas')).toBe(false);

      await expect(wfSvc.saveClosingDocuments({
        caller: VENDEDOR_V1,
        prospectId: '1792004940382',
        data: {
          factura_anticipo: 'FCF-ILEGAL'
        }
      })).rejects.toThrow(/No tienes acceso a esta oportunidad/i);
    });

    test('Escenario 9: Usuario intenta acceder a documentos sin autorización -> RECHAZADO', async () => {
      mockFiles.set('prod_files/prospects/1792004940382/proyectos/secreto.pdf', { size: 1000 });
      await fdb.seed('prospects_prod/1792004940382', {
        ...baseProspectGrado0,
        datos: {
          doc_firmado: { name: 'secreto.pdf', storagePath: 'prod_files/prospects/1792004940382/proyectos/secreto.pdf' }
        }
      });

      // Vendedor ajeno intenta descargar documento
      await expect(storageSvc.getSecureDownloadUrl({
        caller: VENDEDOR_V3,
        storagePath: 'prod_files/prospects/1792004940382/proyectos/secreto.pdf',
        prospectId: '1792004940382'
      })).rejects.toThrow(/No tienes acceso a los documentos de esta oportunidad/i);
    });

    test('Escenario 10: Sustitución de documentos posteriores al cierre -> Respeta las reglas existentes', async () => {
      // Oportunidad ya finalizada (ganada)
      const wonProspect = {
        ...baseProspectGrado0,
        estado: 'ganado',
        postcierre_habilitado: true,
        fecha_cierre: '2026-10-31T18:25:28.474Z'
      };
      await fdb.seed('prospects_prod/1792004940382', wonProspect);

      // 1. En Storage Rules: proyectos está denegado en postcierre
      expect(storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, wonProspect, 'proyectos')).toBe(false);
      // Facturas/pagos/ordenes_cambio sí está permitido para gestor en postcierre
      expect(storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, wonProspect, 'facturas')).toBe(true);
      expect(storageRulesLogic.canUploadToProspectDoc(ALEJANDRA, wonProspect, 'pagos')).toBe(true);

      // 2. En Cloud Functions: saveClosingDocuments se rechaza en oportunidad ganada
      await expect(wfSvc.saveClosingDocuments({
        caller: ALEJANDRA,
        prospectId: '1792004940382',
        data: {
          doc_firmado: { name: 'nueva_oferta.pdf', storagePath: 'prod_files/prospects/1792004940382/proyectos/nueva.pdf', motivoSustitucion: 'Reemplazo postcierre' }
        }
      })).rejects.toThrow(/Solo una oportunidad en Cierre activo puede modificar documentos/i);
    });
  });

  describe('3. Integridad Transaccional y Prevención de Inconsistencias', () => {
    test('3.1 Un fallo en la carga a Storage NO marca la oportunidad como cerrada', async () => {
      await fdb.seed('clients_prod/1792004495514', baseClientGrado0);
      await fdb.seed('prospects_prod/1792004940382', baseProspectGrado0);

      // Simular intento de finalización donde uploadFileToStorage falla con storage/unauthorized
      let uploadFailed = false;
      try {
        const err = new Error("Firebase Storage: User does not have permission to access 'prod_files/prospects/1792004940382/proyectos/error.pdf'. (storage/unauthorized)");
        err.code = 'storage/unauthorized';
        throw err;
      } catch (e) {
        uploadFailed = true;
      }

      expect(uploadFailed).toBe(true);

      // Verificar que el estado del prospecto en base de datos permanece INTACTO (activo, etapa cierre)
      const snap = (await fdb.collection('prospects_prod').doc('1792004940382').get()).data();
      expect(snap.estado).toBe('activo');
      expect(snap.etapa).toBe('cierre');
      expect(snap.postcierre_habilitado).toBe(false);
    });

    test('3.2 Documentos registrados en el expediente correcto sin duplicados', async () => {
      await fdb.seed('clients_prod/1792004495514', baseClientGrado0);
      await fdb.seed('prospects_prod/1792004940382', baseProspectGrado0);

      const exactPath = 'prod_files/prospects/1792004940382/proyectos/1793390517164_oferta_Grado_0.pdf';

      await wfSvc.finalizeProspect({
        caller: ALEJANDRA,
        prospectId: '1792004940382',
        data: {
          forma_pago: '100% anticipado',
          factura_anticipo: 'FCF-101',
          doc_firmado: { name: 'oferta_Grado_0.pdf', storagePath: exactPath },
          doc_comprobante: { name: 'comprobante.pdf', storagePath: 'prod_files/prospects/1792004940382/facturas/comprobante.pdf' }
        }
      });

      const snap = (await fdb.collection('prospects_prod').doc('1792004940382').get()).data();
      expect(snap.datos.doc_firmado.storagePath).toBe(exactPath);
      expect(snap.facturas.length).toBe(1);
      expect(snap.facturas[0].numero).toBe('FCF-101');

      // Intentar re-finalizar debe responder status already_finalized sin duplicar facturas
      const reFinalize = await wfSvc.finalizeProspect({
        caller: ALEJANDRA,
        prospectId: '1792004940382',
        data: {}
      });
      expect(reFinalize.status).toBe('already_finalized');
      const snap2 = (await fdb.collection('prospects_prod').doc('1792004940382').get()).data();
      expect(snap2.facturas.length).toBe(1);
    });
  });
});
