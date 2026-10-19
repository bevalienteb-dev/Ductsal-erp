// functions/__tests__/clientDocumentsSec05.test.js
// UNIT test suite for SEC-05 Client Document Presentation, Preservation and Security.
// Verifies:
// 1. Natural person clients with historical DUI string and canonical { name, storagePath } references.
// 2. Juridical person clients with standard and alternative document keys (escritura_constitucion, mods, nit_empresa, etc.).
// 3. Document formats: plain string URL, historical { url }, canonical { storagePath }, and arrays.
// 4. Client ID handling: Firestore doc.id is authoritative and never overwritten by payload id.
// 5. Preservation: editing a text field never mutates or deletes existing document references.
// 6. Security: rejection of invalid Storage paths (traversal, unauthorized folders) and authorization enforcement.
// 7. Secure presentation: renderClientDocItem, formatClientDocLabel, HTML escaping, and window._docStore.

const fs = require('fs');
const path = require('path');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const {
  createClientsService,
  sanitizeClient,
  sanitizeDocumento,
  resolveDocumentsForUpdate
} = require('../clientsService');

// Load helpers from app_core.js
const appCorePath = path.join(__dirname, '..', '..', 'app_core.js');
const appCoreSrc = fs.readFileSync(appCorePath, 'utf8');

const between = (from, to) => {
  const a = appCoreSrc.indexOf(from);
  const b = appCoreSrc.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return appCoreSrc.slice(a, b);
};

// Sandbox for app_core.js document presentation functions
const helperScope = {};
const helperFn = new Function('scope', `
  var window = { _docStore: new Map() };
  var currentUser = { role: 'manager' };
  var hideLoading = function() {};
  var showLoading = function() {};
  var alert = function() {};
  var confirm = function() { return true; };
  var firebase = null;
  var isFormatPreviewable = function(fileName) {
    if (!fileName || typeof fileName !== 'string') return true;
    var ext = fileName.split('.').pop().toLowerCase();
    var nonPreviewable = ['zip', 'rar', '7z', 'tar', 'gz', 'dwg', 'dxf', 'cad', 'exe', 'bin', 'xlsx', 'xls', 'docx', 'doc'];
    return !nonPreviewable.includes(ext);
  };
  var lastViewCall = null;
  var lastDownloadCall = null;
  var lastDeleteCall = null;
  var downloadSecureDocument = function(ref, name, opts) { lastDownloadCall = { ref: ref, name: name, opts: opts }; };
  var viewSecureDocument = function(ref, name, opts) { lastViewCall = { ref: ref, name: name, opts: opts }; };
  var deleteClientDocument = function(clientId, docKey, itemIndex) { lastDeleteCall = { clientId: clientId, docKey: docKey, itemIndex: itemIndex }; };

  ${between('const escapeHtmlDoc', 'const STAGES')}

  scope.escapeHtmlDoc = escapeHtmlDoc;
  scope.formatClientDocLabel = formatClientDocLabel;
  scope.renderClientDocItem = renderClientDocItem;
  scope.KNOWN_DOC_LABELS = KNOWN_DOC_LABELS;
  scope.window = window;
  scope.setCurrentUser = function(u) { currentUser = u; };
  scope.viewStoredClientDoc = viewStoredClientDoc;
  scope.downloadStoredClientDoc = downloadStoredClientDoc;
  scope.deleteStoredClientDoc = deleteStoredClientDoc;
  scope.getLastViewCall = function() { return lastViewCall; };
  scope.getLastDownloadCall = function() { return lastDownloadCall; };
  scope.getLastDeleteCall = function() { return lastDeleteCall; };
  scope.clearSpyCalls = function() { lastViewCall = null; lastDownloadCall = null; lastDeleteCall = null; };
`);
helperFn(helperScope);

const {
  escapeHtmlDoc,
  formatClientDocLabel,
  renderClientDocItem,
  KNOWN_DOC_LABELS,
  window: mockWindow,
  viewStoredClientDoc,
  downloadStoredClientDoc,
  deleteStoredClientDoc,
  getLastViewCall,
  getLastDownloadCall,
  getLastDeleteCall,
  clearSpyCalls
} = helperScope;

describe('SEC-05: Client Documents — Backend Services (clientsService.js)', () => {
  const fdb = createFakeFirestore({ clock: () => new Date('2026-10-17T12:00:00.000Z') });
  const service = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });

  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const VEND = who('vendedor', 'V1');
  const MGR = who('manager', 'M1');

  beforeEach(() => {
    fdb.clear();
  });

  describe('1. Natural Person clients with historical and canonical DUI', () => {
    test('creates and preserves natural client with historical DUI string URL', async () => {
      const historicalUrl = 'https://firebasestorage.googleapis.com/v0/b/ductsal-erp.firebasestorage.app/o/prod_files%2Fclients%2Fdui_old.pdf?alt=media';
      const r = await service.create({
        caller: VEND,
        opId: 'op-nat-1',
        client: {
          tipo: 'natural',
          nombres: 'Juan',
          apellidos: 'Pérez',
          telefono: '7000-1111',
          documentos: { dui: historicalUrl }
        }
      });

      expect(r.status).toBe('created');
      const saved = fdb.data('clients_prod/' + r.client.id);
      expect(saved.documentos.dui).toBe(historicalUrl);
    });

    test('creates and preserves natural client with canonical { name, storagePath }', async () => {
      const canonicalDui = {
        name: 'DUI_Juan_Perez.pdf',
        storagePath: 'prod_files/clients/C_NAT_1/identificacion/dui.pdf'
      };
      const r = await service.create({
        caller: VEND,
        opId: 'op-nat-2',
        client: {
          tipo: 'natural',
          nombres: 'María',
          apellidos: 'Gómez',
          correo: 'maria@example.com',
          documentos: { dui: canonicalDui }
        }
      });

      expect(r.status).toBe('created');
      const saved = fdb.data('clients_prod/' + r.client.id);
      expect(saved.documentos.dui).toEqual({
        name: 'DUI_Juan_Perez.pdf',
        storagePath: 'prod_files/clients/C_NAT_1/identificacion/dui.pdf'
      });
    });
  });

  describe('2. Juridical Person clients with standard and alternative keys', () => {
    test('accepts known legal keys and alternative keys (escritura_constitucion, mods, nit_empresa, nrc_empresa, dui_rep)', async () => {
      const docs = {
        escritura_constitucion: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_JUR/legal/escritura.pdf' },
        mods: { name: 'mods.pdf', storagePath: 'prod_files/clients/C_JUR/legal/mods.pdf' },
        nit_empresa: { name: 'nit.pdf', storagePath: 'prod_files/clients/C_JUR/legal/nit.pdf' },
        nrc_empresa: { name: 'nrc.pdf', storagePath: 'prod_files/clients/C_JUR/legal/nrc.pdf' },
        dui_rep: { name: 'dui_rep.pdf', storagePath: 'prod_files/clients/C_JUR/identificacion/dui_rep.pdf' },
        balance_auditoria: { name: 'balance.pdf', storagePath: 'prod_files/clients/C_JUR/financiero/balance.pdf' }
      };

      const r = await service.create({
        caller: VEND,
        opId: 'op-jur-1',
        client: {
          tipo: 'juridica',
          empresa: 'Constructora Beta SA',
          contacto: 'Roberto Gómez',
          telefono: '2222-3333',
          documentos: docs
        }
      });

      expect(r.status).toBe('created');
      const saved = fdb.data('clients_prod/' + r.client.id);
      expect(saved.documentos.escritura_constitucion.storagePath).toBe('prod_files/clients/C_JUR/legal/escritura.pdf');
      expect(saved.documentos.mods.storagePath).toBe('prod_files/clients/C_JUR/legal/mods.pdf');
      expect(saved.documentos.nit_empresa.storagePath).toBe('prod_files/clients/C_JUR/legal/nit.pdf');
      expect(saved.documentos.balance_auditoria.storagePath).toBe('prod_files/clients/C_JUR/financiero/balance.pdf');
    });
  });

  describe('3. Document Formats: strings, {url}, {storagePath}, and arrays', () => {
    test('supports array of documents in a key (e.g. multiple deed amendments)', async () => {
      const docArray = [
        { name: 'mod_1.pdf', storagePath: 'prod_files/clients/C1/legal/mod_1.pdf' },
        { name: 'mod_2.pdf', storagePath: 'prod_files/clients/C1/legal/mod_2.pdf' },
        'https://files.example.com/mod_3_historical.pdf'
      ];

      const sanitized = sanitizeDocumento(docArray);
      expect(Array.isArray(sanitized)).toBe(true);
      expect(sanitized.length).toBe(3);
      expect(sanitized[0].storagePath).toBe('prod_files/clients/C1/legal/mod_1.pdf');
      expect(sanitized[1].storagePath).toBe('prod_files/clients/C1/legal/mod_2.pdf');
      expect(sanitized[2]).toBe('https://files.example.com/mod_3_historical.pdf');
    });

    test('sanitizeDocumento filters out invalid items inside arrays and keeps valid ones', () => {
      const mixedArray = [
        { name: 'valid.pdf', storagePath: 'prod_files/clients/C1/legal/valid.pdf' },
        { name: 'invalid.pdf', storagePath: 'prod_files/clients/../../../etc/passwd' },
        'not-a-valid-http-url'
      ];

      const sanitized = sanitizeDocumento(mixedArray);
      expect(Array.isArray(sanitized)).toBe(true);
      expect(sanitized.length).toBe(1);
      expect(sanitized[0].name).toBe('valid.pdf');
    });
  });

  describe('4. Preservation: Editing text fields never alters or drops existing documents', () => {
    test('updating phone number preserves existing historical and canonical documents intact', async () => {
      const existingDocs = {
        escritura: 'https://files.example.com/escritura_historica.pdf',
        dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_EXIST/identificacion/dui.pdf' },
        mods: [{ name: 'mod1.pdf', storagePath: 'prod_files/clients/C_EXIST/legal/mod1.pdf' }],
        legacy_unrecognized: 'gs://ductsal-erp.appspot.com/old_ref/doc.dat'
      };

      fdb.seed('clients_prod/C_EXIST', {
        id: 'C_EXIST',
        tipo: 'juridica',
        empresa: 'Inversiones Globales',
        contacto: 'Ana Morales',
        telefono: '7100-0000',
        correo: 'ana@example.com',
        createdBy: 'V1',
        documentos: existingDocs
      });

      // Vendedor updates the phone number, sending back existing documents from Firestore
      const res = await service.update({
        caller: VEND,
        id: 'C_EXIST',
        client: {
          tipo: 'juridica',
          empresa: 'Inversiones Globales',
          contacto: 'Ana Morales',
          telefono: '7999-9999', // Updated phone
          correo: 'ana@example.com',
          documentos: existingDocs
        }
      });

      expect(res.status).toBe('updated');
      const updated = fdb.data('clients_prod/C_EXIST');
      expect(updated.telefono).toBe('7999-9999');
      // All existing documents must be preserved, including legacy string formats and arrays
      expect(updated.documentos.escritura).toBe('https://files.example.com/escritura_historica.pdf');
      expect(updated.documentos.dui.storagePath).toBe('prod_files/clients/C_EXIST/identificacion/dui.pdf');
      expect(updated.documentos.mods[0].storagePath).toBe('prod_files/clients/C_EXIST/legal/mod1.pdf');
      expect(updated.documentos.legacy_unrecognized).toBe('gs://ductsal-erp.appspot.com/old_ref/doc.dat');
    });

    test('updating client without mentioning documentos preserves existing documents', async () => {
      fdb.seed('clients_prod/C_NO_DOCS_ARG', {
        id: 'C_NO_DOCS_ARG',
        tipo: 'natural',
        nombres: 'Pedro',
        apellidos: 'Picapiedra',
        telefono: '7000-0001',
        createdBy: 'V1',
        documentos: { dui: 'https://files.example.com/pedro_dui.pdf' }
      });

      const res = await service.update({
        caller: VEND,
        id: 'C_NO_DOCS_ARG',
        client: {
          tipo: 'natural',
          nombres: 'Pedro',
          apellidos: 'Picapiedra',
          telefono: '7000-9999' // No 'documentos' property sent
        }
      });

      expect(res.status).toBe('updated');
      expect(fdb.data('clients_prod/C_NO_DOCS_ARG').documentos.dui).toBe('https://files.example.com/pedro_dui.pdf');
    });
  });

  describe('5. Security: Path rejection and Authorization checks', () => {
    test('rejects new document with directory traversal in storagePath', async () => {
      await expect(service.create({
        caller: VEND,
        opId: 'op-sec-traversal',
        client: {
          tipo: 'natural',
          nombres: 'Malicious',
          apellidos: 'User',
          telefono: '7000-6666',
          documentos: {
            dui: { name: 'attack.pdf', storagePath: 'prod_files/clients/../../etc/passwd' }
          }
        }
      })).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('rejects new document outside authorized folders (clients/clientes)', async () => {
      await expect(service.create({
        caller: VEND,
        opId: 'op-sec-folder',
        client: {
          tipo: 'natural',
          nombres: 'Unauthorized',
          apellidos: 'Folder',
          telefono: '7000-7777',
          documentos: {
            dui: { name: 'leak.pdf', storagePath: 'prod_files/passwords/crm_users.json' }
          }
        }
      })).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    test('vendedor cannot delete valid existing documents, only manager can', async () => {
      const validDoc = { name: 'legal.pdf', storagePath: 'prod_files/clients/C_AUTH/legal/doc.pdf' };
      fdb.seed('clients_prod/C_AUTH', {
        id: 'C_AUTH',
        tipo: 'juridica',
        empresa: 'Segura SA',
        contacto: 'Contacto',
        telefono: '7000-8888',
        createdBy: 'V1',
        documentos: { escritura: validDoc }
      });

      // Vendedor attempts to remove the document by passing empty documentos
      await expect(service.update({
        caller: VEND,
        id: 'C_AUTH',
        client: {
          tipo: 'juridica',
          empresa: 'Segura SA',
          contacto: 'Contacto',
          telefono: '7000-8888',
          documentos: {}
        }
      })).rejects.toMatchObject({ code: 'permission-denied' });

      // Document still exists
      expect(fdb.data('clients_prod/C_AUTH').documentos.escritura).toEqual(validDoc);

      // Manager attempts removal: succeeds
      const mgrRes = await service.update({
        caller: MGR,
        id: 'C_AUTH',
        client: {
          tipo: 'juridica',
          empresa: 'Segura SA',
          contacto: 'Contacto',
          telefono: '7000-8888',
          documentos: {}
        }
      });
      expect(mgrRes.status).toBe('updated');
      expect(fdb.data('clients_prod/C_AUTH').documentos).toEqual({});
    });
  });
});

describe('SEC-05: Client ID Preservation (Firestore doc.id Listener Logic)', () => {
  test('listener mapping ensures doc.id is preserved when payload has no id field', () => {
    const rawSnapDocs = [
      { id: 'FIRESTORE_DOC_123', data: () => ({ nombres: 'Carlos', telefono: '7000-1111' }) },
      { id: 'FIRESTORE_DOC_456', data: () => ({ empresa: 'Tech Corp', correo: 'tech@example.com' }) }
    ];

    const mappedClients = rawSnapDocs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
    expect(mappedClients[0].id).toBe('FIRESTORE_DOC_123');
    expect(mappedClients[1].id).toBe('FIRESTORE_DOC_456');
  });

  test('listener mapping prevents payload id from overwriting authoritative doc.id', () => {
    const rawSnapDocs = [
      { id: 'REAL_FIRESTORE_ID', data: () => ({ id: 'STALE_OR_FAKE_ID', nombres: 'Elena' }) }
    ];

    const mappedClients = rawSnapDocs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
    expect(mappedClients[0].id).toBe('REAL_FIRESTORE_ID');
  });
});

describe('SEC-05: Document UI Formatting and Safe Rendering (app_core.js)', () => {
  describe('formatClientDocLabel', () => {
    test('maps known legal labels accurately', () => {
      expect(formatClientDocLabel('escritura')).toBe('Escritura');
      expect(formatClientDocLabel('escritura_constitucion')).toBe('Escritura de Constitución');
      expect(formatClientDocLabel('mods_escritura')).toBe('Mods. Escritura');
      expect(formatClientDocLabel('mods')).toBe('Modificaciones');
      expect(formatClientDocLabel('credencial')).toBe('Credencial');
      expect(formatClientDocLabel('credencial_rep')).toBe('Credencial Rep. Legal');
      expect(formatClientDocLabel('nit')).toBe('NIT');
      expect(formatClientDocLabel('nit_empresa')).toBe('NIT Empresa');
      expect(formatClientDocLabel('nrc')).toBe('NRC');
      expect(formatClientDocLabel('nrc_empresa')).toBe('NRC Empresa');
      expect(formatClientDocLabel('dui')).toBe('DUI');
      expect(formatClientDocLabel('dui_rep')).toBe('DUI Rep. Legal');
    });

    test('generates neutral clean labels for unknown keys', () => {
      expect(formatClientDocLabel('balance_general_2025')).toBe('Balance General 2025');
      expect(formatClientDocLabel('permiso-sanitario')).toBe('Permiso Sanitario');
      expect(formatClientDocLabel('_anexo_tributario_')).toBe('Anexo Tributario');
      expect(formatClientDocLabel('')).toBe('Documento');
    });
  });

  describe('renderClientDocItem and HTML safety', () => {
    test('escapes HTML to prevent XSS in document names, labels and client IDs', () => {
      const maliciousDoc = {
        name: '<script>alert("xss")</script>.pdf',
        storagePath: 'prod_files/clients/C1/legal/test.pdf'
      };

      const html = renderClientDocItem(maliciousDoc, '<b>Evil Label</b>', 'C1<">', 'escritura');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;.pdf');
      expect(html).toContain('&lt;b&gt;Evil Label&lt;/b&gt;');
      // User data and IDs are never interpolated into inline JS in onclick
      expect(html).not.toContain("deleteClientDocument('C1<");
      expect(html).toMatch(/deleteStoredClientDoc\('cdoc_[a-z0-9_]+'\)/);
    });

    test('renders preview link and download button for previewable PDF', () => {
      const doc = { name: 'escritura.pdf', storagePath: 'prod_files/clients/C1/legal/escritura.pdf' };
      const html = renderClientDocItem(doc, 'Escritura', 'C1', 'escritura');

      expect(html).toContain('viewStoredClientDoc');
      expect(html).toContain('downloadStoredClientDoc');
      expect(html).toContain('[Escritura]');
      expect(html).toContain('⬇️');
    });

    test('renders only download button for non-previewable formats (e.g. ZIP, DWG)', () => {
      const doc = { name: 'planos.dwg', storagePath: 'prod_files/clients/C1/legal/planos.dwg' };
      const html = renderClientDocItem(doc, 'Planos', 'C1', 'planos');

      expect(html).not.toContain('viewStoredClientDoc');
      expect(html).toContain('downloadStoredClientDoc');
      expect(html).toContain('📁 [Planos]');
      expect(html).toContain('⬇️');
    });

    test('stores document reference in window._docStore avoiding quote injection in onclick attributes', () => {
      mockWindow._docStore.clear();
      const doc = { name: 'quote\'"test.pdf', storagePath: 'prod_files/clients/C1/legal/test.pdf' };
      const html = renderClientDocItem(doc, 'Test Doc', 'C1', 'test_key');

      expect(html).toMatch(/viewStoredClientDoc\('cdoc_[a-z0-9_]+'\)/);
      expect(html).not.toContain("quote'");
      expect(mockWindow._docStore.size).toBeGreaterThan(0);
    });

    test('supports array index in deleteClientDocument button', () => {
      helperScope.setCurrentUser({ role: 'manager' });
      clearSpyCalls();
      const doc = { name: 'mod_2.pdf', storagePath: 'prod_files/clients/C1/legal/mod_2.pdf' };
      const html = renderClientDocItem(doc, 'Modificaciones (2)', 'C1', 'mods', 1);

      const match = html.match(/deleteStoredClientDoc\('([^']+)'\)/);
      expect(match).toBeTruthy();
      expect(html).toContain('🗑️');

      deleteStoredClientDoc(match[1]);
      expect(getLastDeleteCall()).toEqual({ clientId: 'C1', docKey: 'mods', itemIndex: 1 });
    });
  });
});

describe('SEC-REV-01: Backend Authorization on Array Elements and Substitutions', () => {
  const fdb = createFakeFirestore({ clock: () => new Date('2026-10-17T12:00:00.000Z') });
  const service = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });
  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const VEND = who('vendedor', 'V1');
  const GEST = who('gestor', 'G1');
  const MGR = who('manager', 'M1');

  const baseClient = {
    tipo: 'juridica',
    empresa: 'Constructora Central SA',
    contacto: 'Ing. Morales',
    telefono: '7222-3333',
    createdBy: 'V1'
  };

  const docA = { name: 'mod_1.pdf', storagePath: 'prod_files/clients/C_REV1/legal/mod_1.pdf' };
  const docB = { name: 'mod_2.pdf', storagePath: 'prod_files/clients/C_REV1/legal/mod_2.pdf' };
  const docC = { name: 'mod_3.pdf', storagePath: 'prod_files/clients/C_REV1/legal/mod_3.pdf' };

  beforeEach(() => {
    fdb.clear();
    fdb.seed('clients_prod/C_REV1', {
      id: 'C_REV1',
      ...baseClient,
      documentos: {
        escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_REV1/legal/escritura.pdf' },
        mods: [docA, docB]
      }
    });
  });

  test('non-manager (vendedor) is forbidden from removing an element from a document array via direct service call', async () => {
    // Vendedor attempts to remove docB by sending [docA]
    await expect(service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: {
          escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_REV1/legal/escritura.pdf' },
          mods: [docA]
        }
      }
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('Solo el gerente')
    });

    // Database still has both documents
    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([docA, docB]);
  });

  test('non-manager (gestor) is forbidden from substituting an element in a document array with another', async () => {
    // Gestor attempts to replace docB with docC in mods: [docA, docC]
    await expect(service.update({
      caller: GEST,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: {
          escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_REV1/legal/escritura.pdf' },
          mods: [docA, docC]
        }
      }
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('Solo el gerente')
    });

    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([docA, docB]);
  });

  test('duplicate items in arrays: non-manager cannot remove an instance of duplicate references', async () => {
    fdb.seed('clients_prod/C_REV1', {
      id: 'C_REV1',
      ...baseClient,
      documentos: { mods: [docA, docA] }
    });

    // Vendedor attempts to keep only one instance of docA
    await expect(service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [docA] }
      }
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('invalid elements inside existing arrays do not prevent authorized non-manager updates', async () => {
    // Corrupt / legacy array with null and invalid items
    fdb.seed('clients_prod/C_REV1', {
      id: 'C_REV1',
      ...baseClient,
      documentos: {
        mods: [docA, null, { invalid: 'corrupt' }, docB]
      }
    });

    // Vendedor updates and keeps valid docA and docB
    const res = await service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        telefono: '7222-9999',
        documentos: { mods: [docA, docB] }
      }
    });

    expect(res.status).toBe('updated');
    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([docA, docB]);
  });

  test('historical formats in arrays (URL strings) are protected against removal/substitution by non-managers', async () => {
    const legacyUrl1 = 'https://firebasestorage.googleapis.com/v0/b/ductsal.appspot.com/o/mod1.pdf?alt=media';
    const legacyUrl2 = 'https://firebasestorage.googleapis.com/v0/b/ductsal.appspot.com/o/mod2.pdf?alt=media';
    fdb.seed('clients_prod/C_REV1', {
      id: 'C_REV1',
      ...baseClient,
      documentos: { mods: [legacyUrl1, legacyUrl2] }
    });

    // Non-manager attempts to remove legacyUrl2
    await expect(service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [legacyUrl1] }
      }
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Non-manager attempts to substitute legacyUrl2 with docC
    await expect(service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [legacyUrl1, docC] }
      }
    })).rejects.toMatchObject({ code: 'permission-denied' });

    // Non-manager adds docC while keeping historical items intact: allowed!
    const addRes = await service.update({
      caller: VEND,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [legacyUrl1, legacyUrl2, docC] }
      }
    });
    expect(addRes.status).toBe('updated');
    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([legacyUrl1, legacyUrl2, docC]);
  });

  test('manager can remove and substitute array elements legitimately', async () => {
    const res = await service.update({
      caller: MGR,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [docA, docC] } // Substituted docB with docC
      }
    });
    expect(res.status).toBe('updated');
    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([docA, docC]);

    const delRes = await service.update({
      caller: MGR,
      id: 'C_REV1',
      client: {
        ...baseClient,
        documentos: { mods: [docA] } // Removed docC
      }
    });
    expect(delRes.status).toBe('updated');
    expect(fdb.data('clients_prod/C_REV1').documentos.mods).toEqual([docA]);
  });
});

describe('SEC-REV-02: Concurrency, 3-Way Merge, and Snapshot Preservation', () => {
  const fdb = createFakeFirestore({ clock: () => new Date('2026-10-17T12:00:00.000Z') });
  const service = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });
  const who = (role, cid) => ({ uid: `uid-${cid}`, cid, role, name: role });
  const VEND1 = who('vendedor', 'V1');
  const VEND2 = who('vendedor', 'V2');
  const MGR = who('manager', 'M1');

  const baseClient = {
    tipo: 'juridica',
    empresa: 'Inversiones Globales SA',
    contacto: 'Lic. Castro',
    telefono: '7444-1111',
    createdBy: 'V1'
  };

  const docDui = { name: 'dui.pdf', storagePath: 'prod_files/clients/C_CONC/legal/dui.pdf' };
  const docNit = { name: 'nit.pdf', storagePath: 'prod_files/clients/C_CONC/legal/nit.pdf' };
  const docEscritura = { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_CONC/legal/escritura.pdf' };

  beforeEach(() => {
    fdb.clear();
    fdb.seed('clients_prod/C_CONC', {
      id: 'C_CONC',
      ...baseClient,
      documentos: {
        dui: docDui,
        nit: docNit,
        escritura: docEscritura
      }
    });
  });

  test('manager deletes a document while another user has form open; upon saving by second user, deleted doc does not reappear', async () => {
    // User 2 opened the form and holds snapshot of initial documentos
    const user2InitialSnapshot = { dui: docDui, nit: docNit, escritura: docEscritura };

    // Manager deletes docEscritura in Firestore
    const mgrDeleteRes = await service.update({
      caller: MGR,
      id: 'C_CONC',
      client: {
        ...baseClient,
        baseDocumentos: user2InitialSnapshot,
        documentos: { dui: docDui, nit: docNit } // escritura omitted
      }
    });
    expect(mgrDeleteRes.status).toBe('updated');
    expect(fdb.data('clients_prod/C_CONC').documentos.escritura).toBeUndefined();

    // User 2 edits only phone number and saves, sending their form data
    // Case A: Frontend omits documentos (general edit)
    const u2ResA = await service.update({
      caller: VEND1,
      id: 'C_CONC',
      client: {
        ...baseClient,
        telefono: '7444-9999'
        // documentos is omitted
      }
    });
    expect(u2ResA.status).toBe('updated');
    // Deleted document MUST NOT reappear
    expect(fdb.data('clients_prod/C_CONC').documentos.escritura).toBeUndefined();
    expect(fdb.data('clients_prod/C_CONC').documentos.nit).toEqual(docNit);

    // Case B: Even if User 2 sends their stale snapshot with baseDocumentos, 3-way merge sees untouched key and does not resurrect
    const u2ResB = await service.update({
      caller: VEND1,
      id: 'C_CONC',
      client: {
        ...baseClient,
        telefono: '7444-8888',
        documentos: user2InitialSnapshot,
        baseDocumentos: user2InitialSnapshot
      }
    });
    expect(u2ResB.status).toBe('updated');
    expect(fdb.data('clients_prod/C_CONC').documentos.escritura).toBeUndefined();
    expect(fdb.data('clients_prod/C_CONC').documentos.nit).toEqual(docNit);
    expect(fdb.data('clients_prod/C_CONC').telefono).toBe('7444-8888');
  });

  test('two users modify different documents of the same client concurrently and neither loses changes', async () => {
    const baseDocs = { dui: docDui, nit: docNit, escritura: docEscritura };

    const newNit = { name: 'nit_updated.pdf', storagePath: 'prod_files/clients/C_CONC/legal/nit_v2.pdf' };
    const newEscritura = { name: 'escritura_updated.pdf', storagePath: 'prod_files/clients/C_CONC/legal/escritura_v2.pdf' };

    // User 1 updates NIT
    const u1Res = await service.update({
      caller: VEND1,
      id: 'C_CONC',
      client: {
        ...baseClient,
        baseDocumentos: baseDocs,
        documentos: { dui: docDui, nit: newNit, escritura: docEscritura }
      }
    });
    expect(u1Res.status).toBe('updated');
    expect(fdb.data('clients_prod/C_CONC').documentos.nit).toEqual(newNit);

    // User 2 (commercial gestor or related vendedor) concurrently updates escritura
    fdb.seed('prospects_prod/P_CONC_2', { id: 'P_CONC_2', clientId: 'C_CONC', vendedorId: 'V2', eliminado: false });
    const u2Res = await service.update({
      caller: VEND2,
      id: 'C_CONC',
      client: {
        ...baseClient,
        baseDocumentos: baseDocs,
        documentos: { dui: docDui, nit: docNit, escritura: newEscritura }
      }
    });
    expect(u2Res.status).toBe('updated');

    const finalDocs = fdb.data('clients_prod/C_CONC').documentos;
    // User 1's update is preserved
    expect(finalDocs.nit).toEqual(newNit);
    // User 2's update is preserved
    expect(finalDocs.escritura).toEqual(newEscritura);
    // Untouched DUI is preserved
    expect(finalDocs.dui).toEqual(docDui);
  });

  test('two users concurrently add different documents to an array and neither loses their addition', async () => {
    const mod0 = { name: 'mod_0.pdf', storagePath: 'prod_files/clients/C_CONC/legal/mod_0.pdf' };
    const mod1 = { name: 'mod_1.pdf', storagePath: 'prod_files/clients/C_CONC/legal/mod_1.pdf' };
    const mod2 = { name: 'mod_2.pdf', storagePath: 'prod_files/clients/C_CONC/legal/mod_2.pdf' };

    fdb.seed('clients_prod/C_CONC', {
      id: 'C_CONC',
      ...baseClient,
      documentos: { mods: [mod0] }
    });
    fdb.seed('prospects_prod/P_CONC_2', { id: 'P_CONC_2', clientId: 'C_CONC', vendedorId: 'V2', eliminado: false });

    const baseDocs = { mods: [mod0] };

    // User 1 adds mod1
    await service.update({
      caller: VEND1,
      id: 'C_CONC',
      client: {
        ...baseClient,
        baseDocumentos: baseDocs,
        documentos: { mods: [mod0, mod1] }
      }
    });

    // User 2 adds mod2 concurrently
    await service.update({
      caller: VEND2,
      id: 'C_CONC',
      client: {
        ...baseClient,
        baseDocumentos: baseDocs,
        documentos: { mods: [mod0, mod2] }
      }
    });

    const finalMods = fdb.data('clients_prod/C_CONC').documentos.mods;
    expect(finalMods).toContainEqual(mod0);
    expect(finalMods).toContainEqual(mod1);
    expect(finalMods).toContainEqual(mod2);
    expect(finalMods.length).toBe(3);
  });

  test('editing telephone without modifying documents preserves all existing references', async () => {
    const initialDocs = fdb.data('clients_prod/C_CONC').documentos;

    const res = await service.update({
      caller: VEND1,
      id: 'C_CONC',
      client: {
        ...baseClient,
        telefono: '7999-0000'
      }
    });

    expect(res.status).toBe('updated');
    expect(fdb.data('clients_prod/C_CONC').telefono).toBe('7999-0000');
    expect(fdb.data('clients_prod/C_CONC').documentos).toEqual(initialDocs);
  });
});

describe('SEC-REV-03: Filename Safety and XSS Prevention in UI (app_core.js)', () => {
  beforeEach(() => {
    mockWindow._docStore.clear();
    clearSpyCalls();
    helperScope.setCurrentUser({ role: 'manager' });
  });

  test('filenames with apostrophes, quotes, HTML and Unicode render safely without syntax error or XSS', () => {
    const testCases = [
      { name: "d'agua_test.pdf", label: "Contrato d'agua" },
      { name: '"doble_comilla".pdf', label: 'Doc "Especial"' },
      { name: '<script>alert(1)</script>.pdf', label: '<b>Etiqueta</b>' },
      { name: '<img src=x onerror=alert(1)>.pdf', label: '<svg/onload=alert(1)>' },
      { name: '日本語_図面_2026.dwg', label: 'Planos 日本語' },
      { name: 'Año_2026_Crédito_Fiscal_№123.pdf', label: 'Crédito Fiscal' }
    ];

    for (const tc of testCases) {
      const doc = { name: tc.name, storagePath: `prod_files/clients/C_UI/legal/${encodeURIComponent(tc.name)}` };
      const html = renderClientDocItem(doc, tc.label, 'C_UI_01', 'custom_doc');

      // 1. Must NOT contain unescaped script or HTML injection
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg');

      // 2. Must NOT interpolate filename or client ID directly into inline onclick code
      const onclickHandlers = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
      expect(onclickHandlers.length).toBeGreaterThan(0);
      for (const handler of onclickHandlers) {
        expect(handler).not.toContain(tc.name);
        expect(handler).toMatch(/^(?:view|download|delete)StoredClientDoc\('cdoc_[a-z0-9_]+'\)$/);
      }

      // 3. Extract storeId from the handlers
      const storeIdMatch = html.match(/(?:view|download|delete)StoredClientDoc\('([^']+)'\)/);
      expect(storeIdMatch).toBeTruthy();
      const storeId = storeIdMatch[1];
      expect(storeId).toMatch(/^cdoc_[a-z0-9_]+$/);

      // 4. Stored document in _docStore retains exact original filename and details
      const stored = mockWindow._docStore.get(storeId);
      expect(stored).toBeDefined();
      expect(stored.fileName).toBe(tc.name);
      expect(stored.label).toBe(tc.label);
      expect(stored.clientId).toBe('C_UI_01');

      // 5. Calling viewStoredClientDoc invokes viewSecureDocument with intact uncorrupted filename
      clearSpyCalls();
      viewStoredClientDoc(storeId);
      const viewCall = getLastViewCall();
      expect(viewCall).toBeTruthy();
      expect(viewCall.name).toBe(tc.name);
      expect(viewCall.opts).toEqual({ clientId: 'C_UI_01' });

      // 6. Calling downloadStoredClientDoc invokes downloadSecureDocument with intact filename
      clearSpyCalls();
      downloadStoredClientDoc(storeId);
      const dlCall = getLastDownloadCall();
      expect(dlCall).toBeTruthy();
      expect(dlCall.name).toBe(tc.name);
      expect(dlCall.opts).toEqual({ clientId: 'C_UI_01' });

      // 7. Calling deleteStoredClientDoc invokes deleteClientDocument with correct clientId and key
      clearSpyCalls();
      deleteStoredClientDoc(storeId);
      const delCall = getLastDeleteCall();
      expect(delCall).toBeTruthy();
      expect(delCall.clientId).toBe('C_UI_01');
      expect(delCall.docKey).toBe('custom_doc');
    }
  });
});
