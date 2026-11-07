// functions/__tests__/storageSecurity.unit.test.js
// UNIT layer: tests for SEC-05 Storage Security
// Covers:
// 1. resolveStoragePath strict validation (allowed buckets, path traversal, environment prefixes, folder whitelists)
// 2. Backward compatibility with historical reference shapes (plain URL string, {name, url}, {name, storagePath})
// 3. Document preservation in clientsService (creating, updating, and preventing accidental deletions)
// 4. Document preservation in prospectWorkflowService (stage transitions, invoices, payments, change orders)

const fs = require('fs');
const path = require('path');
const docViewerPath = path.join(__dirname, '..', '..', 'core', 'document_viewer.js');
const docViewer = fs.readFileSync(docViewerPath, 'utf8');

const between = (from, to) => {
  const a = docViewer.indexOf(from);
  const b = docViewer.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return docViewer.slice(a, b);
};

const resolveStoragePathSrc = between('function resolveStoragePath(docRef, envConfig = null) {', 'async function downloadSecureDocument');
const resolveStoragePath = new Function('STORAGE_PREFIX', `
  ${resolveStoragePathSrc}
  return resolveStoragePath;
`)('prod_files');

const { createClientsService } = require('../clientsService');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

describe('SEC-05: resolveStoragePath unit tests', () => {
  const prodConfig = {
    storagePrefix: 'prod_files',
    allowedBuckets: ['ductsal-erp.firebasestorage.app', 'ductsal-erp.appspot.com']
  };

  const localConfig = {
    storagePrefix: 'local_files',
    allowedBuckets: ['demo-ductsal-isolated.appspot.com', 'demo-ductsal-local.appspot.com']
  };

  describe('Allowed buckets and hostnames', () => {
    test('accepts valid production bucket ductsal-erp.firebasestorage.app', () => {
      const url = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fprospects%2FP100%2Ffacturas%2Ffactura_01.pdf?alt=media&token=abc-123';
      const resolved = resolveStoragePath(url, prodConfig);
      expect(resolved).toBe('prod_files/prospects/P100/facturas/factura_01.pdf');
    });

    test('accepts fallback production bucket ductsal-erp.appspot.com', () => {
      const url = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2FC200%2Fidentificacion%2Fdui.pdf?alt=media&token=def-456';
      const resolved = resolveStoragePath(url, prodConfig);
      expect(resolved).toBe('prod_files/clients/C200/identificacion/dui.pdf');
    });

    test('accepts emulator bucket when configured for local environment', () => {
      const url = 'https://firebasestorage.googleapis.com/v0/b/demo-ductsal-isolated.appspot.com/o/local_files%2Fprospects%2FP1%2Fproyectos%2Foferta.pdf?alt=media';
      const resolved = resolveStoragePath(url, localConfig);
      expect(resolved).toBe('local_files/prospects/P1/proyectos/oferta.pdf');
    });

    test('rejects external/unauthorized bucket even if on firebasestorage.googleapis.com', () => {
      const url = 'https://firebasestorage.googleapis.com/v0/b/evil-foreign-bucket.appspot.com/o/prod_files%2Fprospects%2FP1%2Ffacturas%2Ffactura.pdf?alt=media';
      expect(resolveStoragePath(url, prodConfig)).toBeNull();
    });

    test('rejects foreign hosts (evil.com, drive.google.com, etc.)', () => {
      expect(resolveStoragePath('https://evil.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Ffactura.pdf', prodConfig)).toBeNull();
      expect(resolveStoragePath('https://drive.google.com/file/d/12345/view', prodConfig)).toBeNull();
    });

    test('rejects null, undefined, empty string, or non-string/non-object input', () => {
      expect(resolveStoragePath(null, prodConfig)).toBeNull();
      expect(resolveStoragePath(undefined, prodConfig)).toBeNull();
      expect(resolveStoragePath('', prodConfig)).toBeNull();
      expect(resolveStoragePath(12345, prodConfig)).toBeNull();
    });
  });

  describe('Path traversal and security boundaries', () => {
    test('rejects path traversal containing ..', () => {
      const attackObj = { storagePath: 'prod_files/prospects/P1/../../../etc/passwd' };
      expect(resolveStoragePath(attackObj, prodConfig)).toBeNull();
    });

    test('rejects path traversal inside URL encoded path', () => {
      const url = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fclients%2F..%2F..%2Fsecret.json?alt=media';
      expect(resolveStoragePath(url, prodConfig)).toBeNull();
    });

    test('rejects double slashes and backslashes', () => {
      expect(resolveStoragePath({ storagePath: 'prod_files//prospects/P1/proyectos/f.pdf' }, prodConfig)).toBeNull();
      expect(resolveStoragePath({ storagePath: 'prod_files\\prospects\\P1\\proyectos\\f.pdf' }, prodConfig)).toBeNull();
    });

    test('rejects path exceeding 500 characters', () => {
      const longPath = 'prod_files/prospects/P1/proyectos/' + 'a'.repeat(500) + '.pdf';
      expect(resolveStoragePath({ storagePath: longPath }, prodConfig)).toBeNull();
    });
  });

  describe('Environment prefix enforcement', () => {
    test('in production environment, rejects development local_files/ prefix', () => {
      const devPath = 'local_files/prospects/P1/facturas/fac.pdf';
      expect(resolveStoragePath({ storagePath: devPath }, prodConfig)).toBeNull();
    });

    test('in local environment, rejects production prod_files/ prefix', () => {
      const prodPath = 'prod_files/prospects/P1/facturas/fac.pdf';
      expect(resolveStoragePath({ storagePath: prodPath }, localConfig)).toBeNull();
    });
  });

  describe('Folder hierarchy whitelist', () => {
    test('accepts valid prospect hierarchical subfolders', () => {
      ['proyectos', 'facturas', 'pagos', 'ordenes_cambio'].forEach(folder => {
        const path = `prod_files/prospects/PROSP-123/${folder}/document_${Date.now()}.pdf`;
        expect(resolveStoragePath({ storagePath: path }, prodConfig)).toBe(path);
      });
    });

    test('accepts valid client hierarchical subfolders', () => {
      ['identificacion', 'legal'].forEach(sub => {
        const path = `prod_files/clients/CLI-456/${sub}/doc_${Date.now()}.pdf`;
        expect(resolveStoragePath({ storagePath: path }, prodConfig)).toBe(path);
      });
      const directClientPath = 'prod_files/clients/CLI-456/direct_file.pdf';
      expect(resolveStoragePath({ storagePath: directClientPath }, prodConfig)).toBe(directClientPath);
    });

    test('accepts legacy flat folders for backward compatibility', () => {
      ['clientes', 'proyectos', 'facturas', 'pagos', 'ordenes_cambio'].forEach(folder => {
        const path = `prod_files/${folder}/1710000000_legacy.pdf`;
        expect(resolveStoragePath({ storagePath: path }, prodConfig)).toBe(path);
      });
    });

    test('rejects unknown or forbidden folders (system, users, secret)', () => {
      expect(resolveStoragePath({ storagePath: 'prod_files/system/config.json' }, prodConfig)).toBeNull();
      expect(resolveStoragePath({ storagePath: 'prod_files/users/passwords.txt' }, prodConfig)).toBeNull();
      expect(resolveStoragePath({ storagePath: 'prod_files/audit/logs.json' }, prodConfig)).toBeNull();
    });
  });

  describe('Historical reference format compatibility', () => {
    test('resolves format 1: plain string URL with token', () => {
      const doc1 = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fproyectos%2Flegacy_01.pdf?alt=media&token=tok-1';
      expect(resolveStoragePath(doc1, prodConfig)).toBe('prod_files/proyectos/legacy_01.pdf');
    });

    test('resolves format 2: object with name and URL with token', () => {
      const doc2 = {
        name: 'cotizacion.pdf',
        url: 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2Fprospects%2FP1%2Fproyectos%2Fcotiz.pdf?alt=media&token=tok-2'
      };
      expect(resolveStoragePath(doc2, prodConfig)).toBe('prod_files/prospects/P1/proyectos/cotiz.pdf');
    });

    test('resolves format 3: canonical object with storagePath', () => {
      const doc3 = {
        name: 'factura_001.pdf',
        storagePath: 'prod_files/prospects/P1/facturas/factura_001.pdf'
      };
      expect(resolveStoragePath(doc3, prodConfig)).toBe('prod_files/prospects/P1/facturas/factura_001.pdf');
    });
  });
});

describe('SEC-05: Document preservation in clientsService', () => {
  const fdb = createFakeFirestore({ clock: () => new Date('2026-10-17T12:00:00.000Z') });
  const service = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });

  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const OWNER = who('vendedor', 'V1');
  const MGR = who('manager', 'M1');

  const baseClient = {
    tipo: 'juridica',
    empresa: 'Corporación Alpha',
    contacto: 'Carlos Vendedor',
    telefono: '7890-1234',
    correo: 'alpha@example.com'
  };

  beforeEach(() => {
    fdb.clear();
  });

  test('creates client with canonical storagePath references', async () => {
    const docDui = { name: 'dui_rep.pdf', storagePath: 'prod_files/clients/C10/identificacion/dui_rep.pdf' };
    const docNit = { name: 'nit_empresa.pdf', storagePath: 'prod_files/clients/C10/legal/nit_empresa.pdf' };

    const r = await service.create({
      caller: OWNER,
      opId: 'op-create-client-10',
      client: {
        ...baseClient,
        id: 'C10',
        documentos: { dui: docDui, nit: docNit }
      }
    });

    expect(r.status).toBe('created');
    const clientId = r.client.id;
    const saved = fdb.data('clients_prod/' + clientId);
    expect(saved.documentos.dui.storagePath).toBe('prod_files/clients/C10/identificacion/dui_rep.pdf');
    expect(saved.documentos.nit.storagePath).toBe('prod_files/clients/C10/legal/nit_empresa.pdf');
  });

  test('updating client details preserves existing canonical storagePath documents without deletion', async () => {
    const docDui = { name: 'dui_rep.pdf', storagePath: 'prod_files/clients/C10/identificacion/dui_rep.pdf' };
    fdb.seed('clients_prod/C10', {
      id: 'C10',
      ...baseClient,
      createdBy: 'V1',
      documentos: { dui: docDui }
    });

    // Update phone number, passing the existing document object
    const r = await service.update({
      caller: OWNER,
      id: 'C10',
      client: {
        ...baseClient,
        telefono: '7999-8888',
        documentos: { dui: docDui }
      }
    });

    expect(r.status).toBe('updated');
    const saved = fdb.data('clients_prod/C10');
    expect(saved.telefono).toBe('7999-8888');
    expect(saved.documentos.dui.storagePath).toBe('prod_files/clients/C10/identificacion/dui_rep.pdf');
  });

  test('a seller cannot remove a document that uses canonical storagePath (manager only)', async () => {
    const docDui = { name: 'dui_rep.pdf', storagePath: 'prod_files/clients/C10/identificacion/dui_rep.pdf' };
    fdb.seed('clients_prod/C10', {
      id: 'C10',
      ...baseClient,
      createdBy: 'V1',
      documentos: { dui: docDui }
    });

    // Seller tries to update client with empty documentos
    await expect(service.update({
      caller: OWNER,
      id: 'C10',
      client: {
        ...baseClient,
        documentos: {}
      }
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Document remains intact in database
    expect(fdb.data('clients_prod/C10').documentos.dui.storagePath).toBe('prod_files/clients/C10/identificacion/dui_rep.pdf');
  });

  test('a manager CAN remove a document that uses canonical storagePath', async () => {
    const docDui = { name: 'dui_rep.pdf', storagePath: 'prod_files/clients/C10/identificacion/dui_rep.pdf' };
    fdb.seed('clients_prod/C10', {
      id: 'C10',
      ...baseClient,
      createdBy: 'V1',
      documentos: { dui: docDui }
    });

    const r = await service.update({
      caller: MGR,
      id: 'C10',
      client: {
        ...baseClient,
        documentos: {}
      }
    });

    expect(r.status).toBe('updated');
    expect(fdb.data('clients_prod/C10').documentos).toEqual({});
  });
});

describe('SEC-05: Document preservation in prospectWorkflowService', () => {
  const fdb = createFakeFirestore({ clock: () => new Date('2026-10-17T12:00:00.000Z') });
  const commercial = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    verifyManager: async () => true
  });
  const workflow = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: commercial.kit });

  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const VEND = who('vendedor', 'V1');
  const GEST = who('gestor', 'GES1');

  beforeEach(() => {
    fdb.clear();
  });

  test('advanceProspectStage accepts canonical storagePath for survey documents', async () => {
    fdb.seed('prospects_prod/P1', {
      id: 'P1',
      createdBy: 'V1',
      vendedorId: 'V1',
      estado: 'activo',
      etapa: 'prospecto',
      codigo: '202601001',
      datos: {},
      logs: [],
      facturas: []
    });

    const docSurvey = {
      name: 'levantamiento_notas.pdf',
      storagePath: 'prod_files/prospects/P1/proyectos/1710000000_levantamiento.pdf'
    };

    const res = await workflow.advanceStage({
      caller: VEND,
      prospectId: 'P1',
      nextStage: 'levantamiento',
      data: {
        visitante: 'Vendedor V1',
        distancia: 12.5,
        fecha_levantamiento: '2026-10-18',
        doc_levantamiento: [docSurvey]
      }
    });

    expect(res.etapa).toBe('levantamiento');
    const p = fdb.data('prospects_prod/P1');
    expect(p.datos.doc_levantamiento[0].storagePath).toBe('prod_files/prospects/P1/proyectos/1710000000_levantamiento.pdf');
    expect(p.datos.doc_levantamiento[0].name).toBe('levantamiento_notas.pdf');
  });

  test('saveInvoice and savePayment accept canonical storagePath references', async () => {
    fdb.seed('prospects_prod/P2', {
      id: 'P2',
      createdBy: 'V1',
      vendedorId: 'V1',
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      codigo: '202601002',
      precio_cotizado: 10000,
      costo_venta: 6000,
      datos: {},
      logs: [],
      facturas: []
    });

    const docFac = {
      name: 'factura_001.pdf',
      storagePath: 'prod_files/prospects/P2/facturas/1710000001_factura_001.pdf'
    };

    const invRes = await workflow.saveInvoice({
      caller: GEST,
      opId: 'op-invoice-001',
      prospectId: 'P2',
      numero: 'FAC-001',
      monto: 5000,
      doc_factura: docFac
    });

    expect(invRes.invoice.numero).toBe('FAC-001');
    expect(invRes.invoice.doc_factura.storagePath).toBe('prod_files/prospects/P2/facturas/1710000001_factura_001.pdf');

    const docPay = {
      name: 'comprobante_banco.png',
      storagePath: 'prod_files/prospects/P2/pagos/1710000002_comprobante.png'
    };

    const payRes = await workflow.savePayment({
      caller: GEST,
      opId: 'op-payment-001',
      prospectId: 'P2',
      invoiceId: invRes.invoice.id,
      monto: 5000,
      metodo: 'transferencia',
      ref: 'TRANSF-12345',
      doc_comprobante: docPay
    });

    expect(payRes.payment.monto).toBe(5000);
    expect(payRes.payment.doc_comprobante.storagePath).toBe('prod_files/prospects/P2/pagos/1710000002_comprobante.png');
  });

  test('saveChangeOrder accepts canonical storagePath for offer and costs', async () => {
    fdb.seed('prospects_prod/P3', {
      id: 'P3',
      createdBy: 'V1',
      vendedorId: 'V1',
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      codigo: '202601003',
      precio_cotizado: 10000,
      costo_venta: 6000,
      datos: {},
      logs: [],
      facturas: [],
      ordenes_cambio: []
    });

    const docOferta = {
      name: 'oc_oferta.pdf',
      storagePath: 'prod_files/prospects/P3/ordenes_cambio/1710000003_oferta.pdf'
    };
    const docCostos = {
      name: 'oc_costos.xlsx',
      storagePath: 'prod_files/prospects/P3/ordenes_cambio/1710000004_costos.xlsx'
    };

    const ocRes = await workflow.saveChangeOrder({
      caller: GEST,
      opId: 'op-changeorder-001',
      prospectId: 'P3',
      tipo: 'aumento',
      desc: 'Ducto adicional',
      precio: 1500,
      costo: 800,
      doc_oferta: docOferta,
      doc_costos: docCostos
    });

    expect(ocRes.order.desc).toBe('Ducto adicional');
    expect(ocRes.order.doc_oferta.storagePath).toBe('prod_files/prospects/P3/ordenes_cambio/1710000003_oferta.pdf');
    expect(ocRes.order.doc_costos.storagePath).toBe('prod_files/prospects/P3/ordenes_cambio/1710000004_costos.xlsx');
  });
});

// =====================================================================================================
// Fase 2 B4: Integridad, Fusiones de Cuentas y Autorización Centralizada (20 Escenarios Obligatorios)
// =====================================================================================================
describe('Fase 2 B4: Integridad, Fusiones de Cuentas y Autorización Centralizada (20 Escenarios Obligatorios)', () => {
  const {
    resolveCanonicalAccount,
    authorizeClientAccess,
    MAX_MERGE_DEPTH
  } = require('../clientsService');
  const { createStorageService } = require('../storageService');
  const { createAccountDocumentsService } = require('../accountDocumentsService');

  let fdb;
  let mockFiles;
  let mockBucket;
  let storageService;
  let accountDocsService;

  const MGR = { uid: 'uid-mgr', cid: 'U_MGR', role: 'manager', name: 'Gerente General', activo: true, token: { manager: true } };
  const GES = { uid: 'uid-ges', cid: 'U_GES', role: 'gestor', name: 'Gestor Comercial', activo: true };
  const V_CREATED = { uid: 'uid-v-created', cid: 'V_CREATED', role: 'vendedor', name: 'Vendedor Creador', activo: true };
  const V_VISIBLE = { uid: 'uid-v-visible', cid: 'V_VISIBLE', role: 'vendedor', name: 'Vendedor Visible', activo: true };
  const V_CLOSING = { uid: 'uid-v-closing', cid: 'V_CLOSING', role: 'vendedor', name: 'Vendedor Cierre', activo: true };
  const V_ORIGIN_ONLY = { uid: 'uid-v-origin', cid: 'V_ORIGIN_ONLY', role: 'vendedor', name: 'Vendedor Antiguo C1', activo: true };
  const V_INTRUDER = { uid: 'uid-v-intruder', cid: 'V_INTRUDER', role: 'vendedor', name: 'Vendedor Ajeno', activo: true };

  beforeEach(() => {
    fdb = createFakeFirestore({ clock: () => new Date('2026-11-06T12:00:00.000Z') });
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
            const entry = mockFiles.get(storagePath) || { size: 4096, contentType: 'application/pdf' };
            return [{
              size: entry.size,
              contentType: entry.contentType,
              updated: '2026-11-06T12:00:00.000Z'
            }];
          },
          async getSignedUrl(options) {
            const expiresMs = options.expires || Date.now() + 900000;
            const disp = encodeURIComponent(options.responseDisposition || '');
            return [`https://storage.googleapis.com/${mockBucket.name}/${encodeURIComponent(storagePath)}?Expires=${Math.floor(expiresMs / 1000)}&Signature=b4sig&response-content-disposition=${disp}`];
          }
        };
      }
    };
    storageService = createStorageService({ db: fdb, bucket: mockBucket, suffix: '_prod' });
    accountDocsService = createAccountDocumentsService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      bucket: mockBucket,
      suffix: '_prod'
    });
  });

  // 1. Cuenta sin fusionar
  test('1. Cuenta sin fusionar: resolveCanonicalAccount retorna la misma cuenta como terminal activa', async () => {
    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'Cuenta Activa C1',
      createdBy: 'V_CREATED',
      visibleTo: ['V_CREATED'],
      closingVendors: []
    });

    const resolved = await resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' });
    expect(resolved.originId).toBe('C1');
    expect(resolved.canonicalId).toBe('C1');
    expect(resolved.chain).toEqual(['C1']);
    expect(resolved.depth).toBe(0);
    expect(resolved.isMerged).toBe(false);
    expect(resolved.canonicalData.empresa).toBe('Cuenta Activa C1');
  });

  // 2. Fusión simple C1 -> C2
  test('2. Fusión simple C1 -> C2: resuelve C2 como cuenta canónica terminal preservando cadena [C1, C2]', async () => {
    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'Cuenta Absorbida C1',
      createdBy: 'V_ORIGIN_ONLY',
      visibleTo: ['V_ORIGIN_ONLY'],
      fusionada_en: 'C2'
    });
    fdb.seed('clients_prod/C2', {
      id: 'C2',
      tipo: 'juridica',
      empresa: 'Cuenta Terminal C2',
      createdBy: 'V_CREATED',
      visibleTo: ['V_CREATED'],
      closingVendors: []
    });

    const resolved = await storageService.resolveCanonicalAccount('C1');
    expect(resolved.originId).toBe('C1');
    expect(resolved.canonicalId).toBe('C2');
    expect(resolved.chain).toEqual(['C1', 'C2']);
    expect(resolved.depth).toBe(1);
    expect(resolved.isMerged).toBe(true);
    expect(resolved.canonicalData.empresa).toBe('Cuenta Terminal C2');
  });

  // 3. Fusión encadenada C1 -> C2 -> C3
  test('3. Fusión encadenada C1 -> C2 -> C3: resuelve C3 como cuenta terminal activa con cadena [C1, C2, C3]', async () => {
    fdb.seed('clients_prod/C1', { id: 'C1', empresa: 'C1', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C2' });
    fdb.seed('clients_prod/C2', { id: 'C2', empresa: 'C2', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', {
      id: 'C3',
      empresa: 'C3 Terminal',
      createdBy: 'V_CREATED',
      visibleTo: ['V_VISIBLE'],
      closingVendors: ['V_CLOSING']
    });

    const resolved = await resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' });
    expect(resolved.originId).toBe('C1');
    expect(resolved.canonicalId).toBe('C3');
    expect(resolved.chain).toEqual(['C1', 'C2', 'C3']);
    expect(resolved.depth).toBe(2);
    expect(resolved.isMerged).toBe(true);
    expect(resolved.canonicalData.empresa).toBe('C3 Terminal');
  });

  // 4. Cadena válida en el límite de profundidad (5 niveles)
  test('4. Cadena válida en el límite de profundidad (5 niveles: C1 -> C2 -> C3 -> C4 -> C5 -> C6)', async () => {
    expect(MAX_MERGE_DEPTH).toBe(5);
    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C2' });
    fdb.seed('clients_prod/C2', { id: 'C2', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', { id: 'C3', fusionada_en: 'C4' });
    fdb.seed('clients_prod/C4', { id: 'C4', fusionada_en: 'C5' });
    fdb.seed('clients_prod/C5', { id: 'C5', fusionada_en: 'C6' });
    fdb.seed('clients_prod/C6', { id: 'C6', empresa: 'Terminal Nivel 5', createdBy: 'V_CREATED', visibleTo: ['V_CREATED'] });

    const resolved = await resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' });
    expect(resolved.canonicalId).toBe('C6');
    expect(resolved.depth).toBe(5);
    expect(resolved.chain).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  });

  // 5. Cadena que excede cinco niveles (rechazada)
  test('5. Cadena que excede cinco niveles (6 saltos: C1 -> ... -> C7) es rechazada con failed-precondition', async () => {
    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C2' });
    fdb.seed('clients_prod/C2', { id: 'C2', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', { id: 'C3', fusionada_en: 'C4' });
    fdb.seed('clients_prod/C4', { id: 'C4', fusionada_en: 'C5' });
    fdb.seed('clients_prod/C5', { id: 'C5', fusionada_en: 'C6' });
    fdb.seed('clients_prod/C6', { id: 'C6', fusionada_en: 'C7' });
    fdb.seed('clients_prod/C7', { id: 'C7', empresa: 'Inalcanzable' });

    await expect(resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' }))
      .rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/profundidad máxima permitida \(5 niveles\)/)
      });

    mockFiles.set('prod_files/clients/C1/legal/nit.pdf', { size: 1024 });
    await expect(storageService.getSecureDownloadUrl({
      caller: MGR,
      storagePath: 'prod_files/clients/C1/legal/nit.pdf'
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  // 6. Ciclo C1 -> C2 -> C1 (rechazado)
  test('6. Ciclo C1 -> C2 -> C1 (y autociclo C1 -> C1) es detectado y rechazado con failed-precondition', async () => {
    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C2' });
    fdb.seed('clients_prod/C2', { id: 'C2', fusionada_en: 'C1' });

    await expect(resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' }))
      .rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/Ciclo detectado.*C1 -> C2 -> C1/)
      });

    fdb.seed('clients_prod/C_SELF', { id: 'C_SELF', fusionada_en: 'C_SELF' });
    await expect(resolveCanonicalAccount(fdb, 'C_SELF', { suffix: '_prod' }))
      .rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringMatching(/Ciclo detectado.*C_SELF -> C_SELF/)
      });
  });

  // 7. Referencia a cuenta inexistente (rechazada)
  test('7. Referencia a cuenta inexistente (origen o destino de fusión) es rechazada con not-found', async () => {
    await expect(resolveCanonicalAccount(fdb, 'C_NO_EXISTE', { suffix: '_prod' }))
      .rejects.toMatchObject({ code: 'not-found' });

    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C_FANTASMA' });
    await expect(resolveCanonicalAccount(fdb, 'C1', { suffix: '_prod' }))
      .rejects.toMatchObject({
        code: 'not-found',
        message: expect.stringMatching(/Cuenta destino de fusión 'C_FANTASMA' no encontrada/)
      });
  });

  // 8. Manager autorizado
  test('8. Manager autorizado: authorizeClientAccess y descarga sobre cuenta activa o fusionada', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_CREATED', visibleTo: [], closingVendors: [] };
    expect(authorizeClientAccess(MGR, c3Data)).toBe(true);

    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C1/legal/escritura.pdf', { size: 2048 });

    const res = await storageService.getSecureDownloadUrl({
      caller: MGR,
      storagePath: 'prod_files/clients/C1/legal/escritura.pdf',
      clientId: 'C3'
    });
    expect(res.signedUrl).toContain('storage.googleapis.com');
  });

  // 9. Gestor autorizado
  test('9. Gestor autorizado: authorizeClientAccess y descarga sobre cuenta activa o fusionada', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_CREATED', visibleTo: [], closingVendors: [] };
    expect(authorizeClientAccess(GES, c3Data)).toBe(true);

    fdb.seed('clients_prod/C1', { id: 'C1', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C1/legal/nit.pdf', { size: 2048 });

    const res = await storageService.getSecureDownloadUrl({
      caller: GES,
      storagePath: 'prod_files/clients/C1/legal/nit.pdf',
      clientId: 'C1'
    });
    expect(res.signedUrl).toContain('storage.googleapis.com');
  });

  // 10. Vendedor autorizado mediante createdBy
  test('10. Vendedor autorizado mediante createdBy en la cuenta activa terminal', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_CREATED', visibleTo: [], closingVendors: [] };
    expect(authorizeClientAccess(V_CREATED, c3Data)).toBe(true);

    fdb.seed('clients_prod/C1', { id: 'C1', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C1/legal/credencial.pdf', { size: 2048 });

    const res = await storageService.getSecureDownloadUrl({
      caller: V_CREATED,
      storagePath: 'prod_files/clients/C1/legal/credencial.pdf',
      clientId: 'C3'
    });
    expect(res.signedUrl).toContain('storage.googleapis.com');
  });

  // 11. Vendedor autorizado mediante visibleTo
  test('11. Vendedor autorizado mediante visibleTo en la cuenta activa terminal', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_OTHER', visibleTo: ['V_VISIBLE'], closingVendors: [] };
    expect(authorizeClientAccess(V_VISIBLE, c3Data)).toBe(true);

    fdb.seed('clients_prod/C1', { id: 'C1', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C1/identificacion/dui.pdf', { size: 2048 });

    const res = await storageService.getSecureDownloadUrl({
      caller: V_VISIBLE,
      storagePath: 'prod_files/clients/C1/identificacion/dui.pdf',
      clientId: 'C3'
    });
    expect(res.signedUrl).toContain('storage.googleapis.com');
  });

  // 12. Vendedor autorizado mediante closingVendors
  test('12. Vendedor autorizado mediante closingVendors en la cuenta activa terminal', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_OTHER', visibleTo: [], closingVendors: ['V_CLOSING'] };
    expect(authorizeClientAccess(V_CLOSING, c3Data)).toBe(true);

    fdb.seed('clients_prod/C1', { id: 'C1', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C1/poderes/poder.pdf', { size: 2048 });

    const res = await storageService.getSecureDownloadUrl({
      caller: V_CLOSING,
      storagePath: 'prod_files/clients/C1/poderes/poder.pdf',
      clientId: 'C3'
    });
    expect(res.signedUrl).toContain('storage.googleapis.com');
  });

  // 13. Vendedor sin acceso a la cuenta terminal (rechazado)
  test('13. Vendedor sin acceso a la cuenta terminal es rechazado con permission-denied', async () => {
    const c3Data = { id: 'C3', createdBy: 'V_CREATED', visibleTo: ['V_VISIBLE'], closingVendors: ['V_CLOSING'] };
    expect(authorizeClientAccess(V_INTRUDER, c3Data)).toBe(false);

    fdb.seed('clients_prod/C3', c3Data);
    mockFiles.set('prod_files/clients/C3/legal/nit.pdf', { size: 2048 });

    await expect(storageService.getSecureDownloadUrl({
      caller: V_INTRUDER,
      storagePath: 'prod_files/clients/C3/legal/nit.pdf',
      clientId: 'C3'
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'No tienes permiso para acceder a los documentos de este cliente'
    });
  });

  // 14. Usuario no autenticado (rechazado)
  test('14. Usuario no autenticado es rechazado en authorizeClientAccess y en getSecureDownloadUrl', async () => {
    const c1Data = { id: 'C1', createdBy: 'V_CREATED', visibleTo: ['V_CREATED'], closingVendors: [] };
    expect(authorizeClientAccess(null, c1Data)).toBe(false);
    expect(authorizeClientAccess({}, c1Data)).toBe(false);
    expect(authorizeClientAccess({ uid: '', role: 'vendedor', cid: 'V_CREATED' }, c1Data)).toBe(false);

    fdb.seed('clients_prod/C1', c1Data);
    mockFiles.set('prod_files/clients/C1/legal/nit.pdf', { size: 1024 });

    await expect(storageService.getSecureDownloadUrl({
      caller: null,
      storagePath: 'prod_files/clients/C1/legal/nit.pdf'
    })).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Autenticación requerida'
    });
  });

  // 15. Usuario con permisos revocados (rechazado)
  test('15. Usuario con permisos revocados o perfil inactivo en CRM es rechazado con permission-denied', async () => {
    const c1Data = { id: 'C1', createdBy: 'V_CREATED', visibleTo: ['V_CREATED'], closingVendors: ['V_CREATED'] };
    expect(authorizeClientAccess({ ...V_CREATED, activo: false }, c1Data)).toBe(false);
    expect(authorizeClientAccess({ ...V_CREATED, revoked: true }, c1Data)).toBe(false);
    expect(authorizeClientAccess({ ...MGR, token: { manager: false } }, c1Data)).toBe(false);

    fdb.seed('clients_prod/C1', c1Data);
    mockFiles.set('prod_files/clients/C1/legal/nit.pdf', { size: 1024 });

    // Caso A: bandera de revocación en el objeto caller
    await expect(storageService.getSecureDownloadUrl({
      caller: { ...V_CREATED, revoked: true },
      storagePath: 'prod_files/clients/C1/legal/nit.pdf'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Caso B: usuario revocado/inactivado en la colección users_prod de Firestore
    fdb.seed('users_prod/V_CREATED', {
      id: 'V_CREATED',
      authUid: 'uid-v-created',
      role: 'vendedor',
      activo: false
    });
    await expect(storageService.getSecureDownloadUrl({
      caller: V_CREATED,
      storagePath: 'prod_files/clients/C1/legal/nit.pdf'
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  // 16. Contexto de cuenta manipulado (rechazado)
  test('16. Contexto de cuenta manipulado (context.clientId ajeno a la cadena resuelta) es rechazado con permission-denied', async () => {
    fdb.seed('clients_prod/C1', { id: 'C1', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C2' });
    fdb.seed('clients_prod/C2', { id: 'C2', createdBy: 'V_ORIGIN_ONLY', fusionada_en: 'C3' });
    fdb.seed('clients_prod/C3', { id: 'C3', createdBy: 'V_ORIGIN_ONLY', visibleTo: [] });
    // V_INTRUDER es dueño de su propia cuenta C_INTRUDER e intenta pasar clientId: 'C_INTRUDER' para descargar un archivo de C1
    fdb.seed('clients_prod/C_INTRUDER', {
      id: 'C_INTRUDER',
      createdBy: 'V_INTRUDER',
      visibleTo: ['V_INTRUDER'],
      closingVendors: ['V_INTRUDER']
    });
    mockFiles.set('prod_files/clients/C1/legal/escritura.pdf', { size: 2048 });

    await expect(storageService.getSecureDownloadUrl({
      caller: V_INTRUDER,
      storagePath: 'prod_files/clients/C1/legal/escritura.pdf',
      clientId: 'C_INTRUDER'
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Contexto de cliente contradictorio con la ruta solicitada'
    });

    // Incluso un usuario con permisos sobre C3 es rechazado si manipula context.clientId hacia una cuenta fuera de ['C1', 'C2', 'C3']
    await expect(storageService.getSecureDownloadUrl({
      caller: MGR,
      storagePath: 'prod_files/clients/C1/legal/escritura.pdf',
      clientId: 'C_INTRUDER'
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Contexto de cliente contradictorio con la ruta solicitada'
    });
  });

  // 17. Descarga autorizada de documento histórico de cuenta absorbida
  test('17. Descarga autorizada de documento histórico de cuenta absorbida (C1 -> C2 -> C3) por vendedor autorizado en C3', async () => {
    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'C1 Absorbida',
      createdBy: 'V_ORIGIN_ONLY',
      visibleTo: ['V_ORIGIN_ONLY'],
      fusionada_en: 'C2'
    });
    fdb.seed('clients_prod/C2', {
      id: 'C2',
      tipo: 'juridica',
      empresa: 'C2 Intermedia',
      createdBy: 'V_ORIGIN_ONLY',
      visibleTo: ['V_ORIGIN_ONLY'],
      fusionada_en: 'C3'
    });
    fdb.seed('clients_prod/C3', {
      id: 'C3',
      tipo: 'juridica',
      empresa: 'C3 Activa Terminal',
      createdBy: 'V_CREATED',
      visibleTo: ['V_VISIBLE'],
      closingVendors: ['V_CLOSING']
    });

    const historicalPath = 'prod_files/clients/C1/legal/escritura_historica_c1.pdf';
    mockFiles.set(historicalPath, { size: 8192, contentType: 'application/pdf' });

    // Tanto con context.clientId = 'C1' (origen), 'C2' (intermedia) como 'C3' (terminal), el vendedor de C3 descarga el documento histórico
    for (const ctxId of ['C1', 'C2', 'C3']) {
      const res = await storageService.getSecureDownloadUrl({
        caller: V_VISIBLE,
        storagePath: historicalPath,
        clientId: ctxId
      });
      expect(res.storagePath).toBe(historicalPath);
      expect(res.signedUrl).toContain(encodeURIComponent(historicalPath));
    }
  });

  // 18. Denegación de descarga aunque el usuario tuviera acceso anterior a la cuenta origen
  test('18. Denegación de descarga cuando el vendedor tuvo acceso en C1 (createdBy/visibleTo/closingVendors) pero NO está autorizado en la cuenta terminal C3', async () => {
    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'C1 Absorbida',
      createdBy: 'V_ORIGIN_ONLY',
      visibleTo: ['V_ORIGIN_ONLY'],
      closingVendors: ['V_ORIGIN_ONLY'],
      fusionada_en: 'C2'
    });
    fdb.seed('clients_prod/C2', {
      id: 'C2',
      tipo: 'juridica',
      empresa: 'C2 Intermedia',
      createdBy: 'V_ORIGIN_ONLY',
      visibleTo: ['V_ORIGIN_ONLY'],
      closingVendors: ['V_ORIGIN_ONLY'],
      fusionada_en: 'C3'
    });
    fdb.seed('clients_prod/C3', {
      id: 'C3',
      tipo: 'juridica',
      empresa: 'C3 Terminal',
      createdBy: 'V_CREATED',
      visibleTo: ['V_VISIBLE'],
      closingVendors: ['V_CLOSING']
    });

    const historicalPath = 'prod_files/clients/C1/legal/escritura_historica_c1.pdf';
    mockFiles.set(historicalPath, { size: 8192, contentType: 'application/pdf' });

    // V_ORIGIN_ONLY intenta descargar con clientId = 'C1', 'C2', 'C3' o sin clientId -> siempre rechazado con permission-denied
    for (const ctxId of ['C1', 'C2', 'C3', undefined]) {
      await expect(storageService.getSecureDownloadUrl({
        caller: V_ORIGIN_ONLY,
        storagePath: historicalPath,
        clientId: ctxId
      })).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'No tienes permiso para acceder a los documentos de este cliente'
      });
    }
  });

  // 19. Integridad de rutas y versiones Storage
  test('19. Integridad de rutas físicas y versiones Storage: no mueve ni renombra archivos de cuentas absorbidas y mantiene expiración máxima de 15 min (900s)', async () => {
    const historicalPath = 'prod_files/clients/C1/legal/pacto_social_1998.pdf';
    mockFiles.set(historicalPath, { size: 16384, contentType: 'application/pdf' });

    fdb.seed('clients_prod/C1', {
      id: 'C1',
      tipo: 'juridica',
      empresa: 'C1 Absorbida',
      createdBy: 'V_ORIGIN_ONLY',
      fusionada_en: 'C2',
      documentos: {
        escritura: {
          name: 'pacto_social_1998.pdf',
          storagePath: historicalPath,
          versionId: 'v_esc_c1_1',
          versionNumber: 1
        }
      }
    });
    fdb.seed('clients_prod/C2', {
      id: 'C2',
      tipo: 'juridica',
      empresa: 'C2 Terminal',
      createdBy: 'V_CREATED',
      visibleTo: ['V_CREATED'],
      documentos: {
        escritura: {
          name: 'pacto_social_1998.pdf',
          storagePath: historicalPath
        }
      }
    });

    const beforeTs = Date.now();
    const downloadRes = await storageService.getSecureDownloadUrl({
      caller: V_CREATED,
      storagePath: historicalPath,
      clientId: 'C2',
      expiresInSeconds: 999999 // Solicita más de 15 min; el servicio debe acotar a 900s (15 min)
    });
    const expiresAtMs = Date.parse(downloadRes.expiresAt);
    expect(expiresAtMs - beforeTs).toBeLessThanOrEqual(900 * 1000 + 2000);
    expect(downloadRes.storagePath).toBe(historicalPath);
    expect(mockFiles.has(historicalPath)).toBe(true);
    expect(mockFiles.has('prod_files/clients/C2/legal/pacto_social_1998.pdf')).toBe(false);

    // Materialización v_base en C2 preservando la ruta física histórica de C1 en document_versions
    const confRes = await accountDocsService.recordBiennialConfirmation({
      caller: V_CREATED,
      accountId: 'C2',
      docKey: 'escritura',
      documentVersionId: 'v_base',
      confirmationType: 'no_changes',
      confirmedNoChanges: true,
      notas: 'Revisión bienal sobre escritura histórica absorbida de C1',
      opId: 'op_b4_vbase_hist_1'
    });
    expect(confRes.success).toBe(true);
    expect(confRes.documentVersionId).toBe('v_escritura_base_1');
    const verDoc = fdb.data('clients_prod/C2/document_versions/v_escritura_base_1');
    expect(verDoc.storagePath).toBe(historicalPath);
  });

  // 20. Regresión de las funciones relevantes de B3
  test('20. Regresión de funciones relevantes de B3: elección de RL, otorgamiento/invalidación de poderes, sustitución SHA-256 y validación de cierre operan con autorización B4', async () => {
    fdb.seed('clients_prod/C_B3', {
      id: 'C_B3',
      tipo: 'juridica',
      empresa: 'Corporación B3-B4 SA de CV',
      createdBy: 'V_CREATED',
      visibleTo: ['V_VISIBLE'],
      closingVendors: ['V_CLOSING'],
      documentos: {
        escritura: { name: 'Escritura.pdf', storagePath: 'prod_files/clients/C_B3/legal/escritura.pdf', actualizadoEn: '2026-01-15' },
        nit: { name: 'NIT.pdf', storagePath: 'prod_files/clients/C_B3/legal/nit.pdf' },
        nrc: { name: 'NRC.pdf', storagePath: 'prod_files/clients/C_B3/legal/nrc.pdf' }
      }
    });
    fdb.seed('contacts_prod/CT_APOD', {
      id: 'CT_APOD',
      nombres: 'Roberto',
      apellidos: 'Salazar'
    });

    mockFiles.set('prod_files/clients/C_B3/legal/escritura.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/legal/nit.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/legal/nrc.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/legal/cred_1.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/identificacion/dui_1.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/poderes/poder_1.pdf', { size: 2048 });
    mockFiles.set('prod_files/clients/C_B3/legal/cred_2.pdf', { size: 2048 });

    // Vendedor sin acceso es bloqueado en B3
    await expect(accountDocsService.getAccountDossier({
      caller: V_INTRUDER,
      accountId: 'C_B3'
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // 1. Elección de RL por vendedor autorizado en closingVendors
    const rl1 = await accountDocsService.registerLegalRepresentativeTerm({
      caller: V_CLOSING,
      accountId: 'C_B3',
      nombre: 'María Elena Campos',
      fechaEleccion: '2026-01-10',
      fechaVencimiento: '2029-01-10',
      credencialDoc: { name: 'cred_1.pdf', storagePath: 'prod_files/clients/C_B3/legal/cred_1.pdf', sha256: 'a'.repeat(64) },
      duiDoc: { name: 'dui_1.pdf', storagePath: 'prod_files/clients/C_B3/identificacion/dui_1.pdf', sha256: 'b'.repeat(64), fechaVencimiento: '2030-05-01' },
      opId: 'op_b3_reg_rl1'
    });
    expect(rl1.success).toBe(true);

    // 2. Otorgamiento de poder
    const pw1 = await accountDocsService.grantContractPower({
      caller: V_CLOSING,
      accountId: 'C_B3',
      contactId: 'CT_APOD',
      documento: { name: 'poder_1.pdf', storagePath: 'prod_files/clients/C_B3/poderes/poder_1.pdf', sha256: 'c'.repeat(64) },
      notas: 'Poder especial licitaciones',
      opId: 'op_b3_reg_pw1'
    });
    expect(pw1.success).toBe(true);

    // 3. Validación de cierre con apoderado vigente -> válida
    const closeOk = await accountDocsService.validateAccountDocumentsForOpportunityClose({
      caller: V_CLOSING,
      accountId: 'C_B3',
      prospectId: 'P_CLOSE_1',
      requiereContrato: true,
      firmante: { tipo: 'apoderado', powerId: pw1.powerId },
      now: new Date('2026-06-01T12:00:00.000Z')
    });
    expect(closeOk.valid).toBe(true);

    // 4. Nueva elección de RL invalida automáticamente el poder anterior
    const rl2 = await accountDocsService.registerLegalRepresentativeTerm({
      caller: V_CLOSING,
      accountId: 'C_B3',
      nombre: 'María Elena Campos',
      fechaEleccion: '2026-06-01',
      fechaVencimiento: '2029-06-01',
      credencialDoc: { name: 'cred_2.pdf', storagePath: 'prod_files/clients/C_B3/legal/cred_2.pdf', sha256: 'd'.repeat(64) },
      duiDoc: { name: 'dui_1.pdf', storagePath: 'prod_files/clients/C_B3/identificacion/dui_1.pdf', sha256: 'b'.repeat(64), fechaVencimiento: '2030-05-01' },
      opId: 'op_b3_reg_rl2'
    });
    expect(rl2.invalidatedPowersCount).toBe(1);

    const closeBlocked = await accountDocsService.validateAccountDocumentsForOpportunityClose({
      caller: V_CLOSING,
      accountId: 'C_B3',
      prospectId: 'P_CLOSE_1',
      requiereContrato: true,
      firmante: { tipo: 'apoderado', powerId: pw1.powerId },
      now: new Date('2026-06-02T12:00:00.000Z')
    });
    expect(closeBlocked.valid).toBe(false);
  });
});

