// functions/__tests__/storageSecurity.unit.test.js
// UNIT layer: tests for SEC-05 Storage Security
// Covers:
// 1. resolveStoragePath strict validation (allowed buckets, path traversal, environment prefixes, folder whitelists)
// 2. Backward compatibility with historical reference shapes (plain URL string, {name, url}, {name, storagePath})
// 3. Document preservation in clientsService (creating, updating, and preventing accidental deletions)
// 4. Document preservation in prospectWorkflowService (stage transitions, invoices, payments, change orders)

const fs = require('fs');
const path = require('path');
const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');

const between = (from, to) => {
  const a = appCore.indexOf(from);
  const b = appCore.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCore.slice(a, b);
};

const resolveStoragePathSrc = between('function resolveStoragePath(docRef, envConfig = null) {', 'async function viewSecureDocument');
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
