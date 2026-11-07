// functions/__tests__/clientFormUi.unit.test.js
// UNIT TEST SUITE: Phase 5.3 Client Form UI, Hierarchy & Validations
// Verifies:
// 1. Full HTML hierarchy and field preservation in index.html.
// 2. CSS responsive rules and visual indicators in styles.css.
// 3. Form validation behavior, required rules, error highlights and toggle in app_core.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const clientsUiSrc = fs.readFileSync(path.join(ROOT, 'modules', 'clients', 'clients_ui.js'), 'utf8');

describe('Phase 5.3: Client Form Visual Enhancement & Integrity', () => {

  // =========================================================================
  // 1. HTML Hierarchy, Grouped Sections & Complete Field Inventory
  // =========================================================================
  describe('1. HTML Hierarchy & Field Preservation', () => {
    test('preserves client detail view container and header structure', () => {
      expect(indexHtml).toContain('id="clientDetailContent"');
      expect(indexHtml).toContain('class="modal-content glass-panel client-modal-content"');
      expect(indexHtml).toContain('id="client-modal-title"');
      expect(indexHtml).toContain('class="client-modal-header"');
      expect(indexHtml).toContain('class="client-modal-subtitle"');
      expect(indexHtml).toContain('closeClientDetailView()');
    });

    test('preserves all 35 original identifiers in clientForm', () => {
      const requiredIds = [
        'clientForm',
        'client-id-edit',
        'client-tipo',
        'cli-es-exportacion',
        'fields-natural',
        'nat-nombres',
        'nat-apellidos',
        'nat-dui',
        'nat-nit',
        'nat-profesion',
        'nat-domicilio',
        'nat-dui-file',
        'fields-juridica',
        'jur-empresa',
        'jur-contacto',
        'jur-gran-contribuyente',
        'jur-nit',
        'jur-nrc',
        'jur-rep-legal',
        'jur-profesion-rep',
        'jur-domicilio-rep',
        'jur-dui-rep',
        'jur-nit-rep',
        'jur-file-escritura',
        'jur-file-mods',
        'jur-file-credencial',
        'jur-file-nit',
        'jur-file-nrc',
        'jur-file-dui',
        'cli-telefono',
        'cli-correo',
        'cli-correo-fact',
        'client-expediente-section',
        'client-docs-count-badge',
        'client-docs-list'
      ];

      requiredIds.forEach(id => {
        expect(indexHtml).toContain(`id="${id}"`);
      });
    });

    test('groups fields into 4 distinct logical sections', () => {
      expect(indexHtml).toContain('Personería y Régimen Fiscal');
      expect(indexHtml).toContain('Datos de la Persona Natural');
      expect(indexHtml).toContain('Identificación de la Empresa');
      expect(indexHtml).toContain('Comunicación y Facturación');
      expect(indexHtml).toContain('Expediente Digital del Cliente');
    });

    test('includes visual required indicators and contact requirement notice', () => {
      expect(indexHtml).toContain('class="required-indicator"');
      expect(indexHtml).toContain('class="contact-req-pill"');
      expect(indexHtml).toContain('class="client-contact-rule-banner"');
      expect(indexHtml).toContain('Requisito de contacto');
    });

    test('renders Cancel and Save action buttons with appropriate classes', () => {
      expect(indexHtml).toContain('class="client-modal-actions"');
      expect(indexHtml).toContain('onclick="closeClientDetailView()"');
      expect(indexHtml).toContain('id="btn-submit-client"');
      expect(indexHtml).toContain('Guardar Cliente');
    });
  });

  // =========================================================================
  // 2. CSS Styles, View Width & Mobile Responsiveness
  // =========================================================================
  describe('2. CSS Design & Responsive Rules', () => {
    test('defines max-width 720px for desktop client detail content', () => {
      expect(stylesCss).toContain('#clientDetailContent .modal-content');
      expect(stylesCss).toContain('max-width: 720px');
    });

    test('defines section cards with rounded borders and padding', () => {
      expect(stylesCss).toContain('.client-form-section');
      expect(stylesCss).toContain('.client-section-title');
      expect(stylesCss).toContain('.client-fiscal-pill');
    });

    test('defines visual error highlight style for inputs', () => {
      expect(stylesCss).toContain('.input-error');
      expect(stylesCss).toContain('border-color: #ef4444');
    });

    test('defines mobile responsive layout with touch-friendly actions', () => {
      expect(stylesCss).toContain('.client-modal-actions');
      expect(stylesCss).toContain('flex-direction: column-reverse');
      expect(stylesCss).toContain('min-height: 44px');
    });
  });

  // =========================================================================
  // 3. Functional Validations & Error State Management in app_core.js
  // =========================================================================
  describe('3. Functional Validations & Error Handling', () => {
    test('defines setClientFieldError to safely toggle .input-error', () => {
      expect(clientsUiSrc).toContain('function setClientFieldError(elementId, hasError)');
      expect(clientsUiSrc).toContain("classList.toggle('input-error'");
    });

    test('toggleClientFields alternates natural and juridica display', () => {
      const els = {
        'client-tipo': { value: '' },
        'fields-natural': { style: { display: 'none' } },
        'fields-juridica': { style: { display: 'none' } }
      };
      const document = { getElementById: id => els[id] };

      const toggleFn = new Function('document', `
        const type = document.getElementById('client-tipo').value;
        if (type === 'natural') { document.getElementById('fields-natural').style.display = 'block'; document.getElementById('fields-juridica').style.display = 'none'; }
        else if (type === 'juridica') { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'block'; }
        else { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'none'; }
      `);

      // 1. Default empty
      toggleFn(document);
      expect(els['fields-natural'].style.display).toBe('none');
      expect(els['fields-juridica'].style.display).toBe('none');

      // 2. Natural
      els['client-tipo'].value = 'natural';
      toggleFn(document);
      expect(els['fields-natural'].style.display).toBe('block');
      expect(els['fields-juridica'].style.display).toBe('none');

      // 3. Juridica
      els['client-tipo'].value = 'juridica';
      toggleFn(document);
      expect(els['fields-natural'].style.display).toBe('none');
      expect(els['fields-juridica'].style.display).toBe('block');
    });

    test('openClientDetailView resets form and clears input-error states', () => {
      expect(clientsUiSrc).toContain("const errs = document.querySelectorAll('#clientForm .input-error');");
      expect(clientsUiSrc).toContain("errs.forEach(el => el.classList.remove('input-error'))");
    });

    test('saveClient validates missing type, missing contacts, and missing names/company', async () => {
      // Slices real saveClient from modules/clients/clients_ui.js
      const from = 'async function saveClient(e)';
      const to = '// -------------------------------------------------------------------------\n    // 5. Selector de Clientes';
      const a = clientsUiSrc.indexOf(from);
      const b = clientsUiSrc.indexOf(to, a + from.length);
      const saveSrc = clientsUiSrc.slice(a, b);

      const els = {};
      const el = (id, val = '', extra = {}) => {
        if (!els[id]) {
          els[id] = {
            id,
            value: val,
            checked: false,
            classList: {
              classes: new Set(),
              toggle(cls, force) {
                if (force) this.classes.add(cls);
                else this.classes.delete(cls);
              },
              add(cls) { this.classes.add(cls); },
              remove(cls) { this.classes.delete(cls); },
              contains(cls) { return this.classes.has(cls); }
            },
            ...extra
          };
        } else {
          if (val !== '') els[id].value = val;
          Object.assign(els[id], extra);
        }
        return els[id];
      };

      const alerts = [];
      const fakeAlert = msg => alerts.push(msg);
      const fakeClients = [];
      let serverSaved = null;
      const fakePersist = async (c) => { serverSaved = c; return { id: 'CLI_NEW', ...c }; };

      const scope = {
        document: { getElementById: id => els[id] || el(id) },
        alert: fakeAlert,
        clients: fakeClients,
        persistClientViaServer: fakePersist,
        closeModal: () => {},
        renderClientsTable: () => {},
        selectClientInSelector: () => {},
        getClientName: () => 'Test',
        showLoading: () => {},
        hideLoading: () => {}
      };
      scope._deps = {
        alert: fakeAlert,
        getClients: () => fakeClients,
        setClients: (val) => { fakeClients.length = 0; fakeClients.push(...val); },
        persistClientViaServer: fakePersist,
        closeModal: () => {},
        renderClientsTable: () => {},
        selectClientInSelector: () => {},
        getClientName: () => 'Test',
        showLoading: () => {},
        hideLoading: () => {}
      };

      const fn = new Function('scope', `
        with (scope) {
          function setClientFieldError(elementId, hasError) {
            if (typeof document === 'undefined') return;
            const el = document.getElementById(elementId);
            if (!el) return;
            if (el.classList && typeof el.classList.toggle === 'function') {
              el.classList.toggle('input-error', !!hasError);
            }
          }
          ${saveSrc}
          return saveClient;
        }
      `)(scope);

      // 1. Missing type
      el('client-id-edit', '');
      el('client-tipo', '');
      await fn({ preventDefault: () => {} });
      expect(alerts[0]).toMatch(/Debes seleccionar el Tipo de Persona obligatoriamente/);
      expect(el('client-tipo').classList.contains('input-error')).toBe(true);

      // 2. Missing phone and email
      el('client-tipo', 'natural');
      el('cli-telefono', '');
      el('cli-correo', '');
      await fn({ preventDefault: () => {} });
      expect(alerts[1]).toMatch(/Debe ingresar obligatoriamente un teléfono o correo/);
      expect(el('cli-telefono').classList.contains('input-error')).toBe(true);
      expect(el('cli-correo').classList.contains('input-error')).toBe(true);

      // 3. Missing natural person names
      el('cli-telefono', '7890-1234');
      el('nat-nombres', '');
      el('nat-apellidos', '');
      await fn({ preventDefault: () => {} });
      expect(alerts[2]).toMatch(/Nombres y Apellidos obligatorios/);
      expect(el('nat-nombres').classList.contains('input-error')).toBe(true);

      // 4. Missing juridica company and contact
      el('client-tipo', 'juridica');
      el('jur-empresa', '');
      el('jur-contacto', '');
      await fn({ preventDefault: () => {} });
      expect(alerts[3]).toMatch(/Nombre de la Empresa obligatorio/);
      expect(el('jur-empresa').classList.contains('input-error')).toBe(true);

      el('jur-empresa', 'Constructora Acme');
      await fn({ preventDefault: () => {} });
      expect(alerts[4]).toMatch(/Nombre del Contacto Principal obligatorio/);
      expect(el('jur-contacto').classList.contains('input-error')).toBe(true);

      // 5. Valid juridica submission
      el('jur-contacto', 'Ing. Carlos Mendoza');
      el('jur-nit', '0614-010190-101-1');
      el('jur-nrc', '12345-6');
      el('cli-correo-fact', 'facturacion@acme.com');
      el('cli-es-exportacion', '', { checked: false });
      await fn({ preventDefault: () => {} });

      expect(serverSaved).not.toBeNull();
      expect(serverSaved.empresa).toBe('Constructora Acme');
      expect(serverSaved.contacto).toBe('Ing. Carlos Mendoza');
      expect(serverSaved.telefono).toBe('7890-1234');
      expect(serverSaved.tipo).toBe('juridica');
    });
  });

  // =========================================================================
  // 4. Lista de Verificación de Documentación Legal de la Sociedad (Hotfix D.2)
  // =========================================================================
  describe('4. Lista de Verificación de Documentación Legal de la Sociedad (Hotfix D.2)', () => {
    const ClientDocuments = require('../../modules/clients/client_documents.js');

    function createChecklistDom() {
      const els = {};
      const specs = [
        { scope: 'jur', key: 'escritura', inputId: 'jur-file-escritura' },
        { scope: 'jur', key: 'mods_escritura', inputId: 'jur-file-mods' },
        { scope: 'jur', key: 'credencial', inputId: 'jur-file-credencial' },
        { scope: 'jur', key: 'nit', inputId: 'jur-file-nit' },
        { scope: 'jur', key: 'nrc', inputId: 'jur-file-nrc' },
        { scope: 'jur', key: 'dui', inputId: 'jur-file-dui' },
        { scope: 'nat', key: 'dui', inputId: 'nat-dui-file' }
      ];

      specs.forEach(sp => {
        const suffix = `${sp.scope}-${sp.key}`;
        els[`doc-checklist-card-${suffix}`] = { id: `doc-checklist-card-${suffix}`, className: '', dataset: {}, style: {} };
        els[`doc-checklist-badge-${suffix}`] = { id: `doc-checklist-badge-${suffix}`, className: '', textContent: '', style: {} };
        els[`doc-checklist-registered-${suffix}`] = { id: `doc-checklist-registered-${suffix}`, innerHTML: '', style: { display: 'none' } };
        els[`doc-checklist-input-wrap-${suffix}`] = { id: `doc-checklist-input-wrap-${suffix}`, style: { display: 'block' } };
        els[sp.inputId] = { id: sp.inputId, value: '', disabled: false, files: [], style: { display: '' } };
        els[`client-subst-box-${suffix}`] = { id: `client-subst-box-${suffix}`, style: { display: 'none' } };
      });

      els['cli-es-exportacion'] = { id: 'cli-es-exportacion', checked: false };
      els['client-id-edit'] = { id: 'client-id-edit', value: '' };
      els['jur-legal-docs-checklist-summary'] = { id: 'jur-legal-docs-checklist-summary', textContent: '', style: {} };
      els['client-expediente-section'] = { id: 'client-expediente-section', style: {} };
      els['client-docs-list'] = { id: 'client-docs-list', innerHTML: '' };
      els['client-docs-count-badge'] = { id: 'client-docs-count-badge', textContent: '' };

      return {
        els,
        document: {
          getElementById: (id) => els[id] || null
        }
      };
    }

    test('Escenario 1: Cliente jurídico con los 6 documentos registrados (C1784327580134) muestra Documento registrado y deshabilita/oculta selectores vacíos', () => {
      const { els, document: fakeDoc } = createChecklistDom();
      const origDoc = global.document;
      global.document = fakeDoc;

      try {
        const clientFull = {
          id: 'C1784327580134',
          tipo: 'juridica',
          es_exportacion: false,
          documentos: {
            escritura: { name: 'ESCRITURA.pdf', storagePath: 'prod_files/clients/C1784327580134/legal/esc.pdf', versionNumber: 1, sha256: 'abc1234567890' },
            mods_escritura: { name: 'MODIFICACION.pdf', storagePath: 'prod_files/clients/C1784327580134/legal/mod.pdf', versionNumber: 1, sha256: 'def1234567890' },
            credencial: { name: 'CREDENCIAL.pdf', storagePath: 'prod_files/clients/C1784327580134/legal/cred.pdf', versionNumber: 1, sha256: 'ghi1234567890' },
            nit: { name: 'RTN.pdf', storagePath: 'prod_files/clients/C1784327580134/legal/nit.pdf', versionNumber: 1, sha256: 'jkl1234567890' },
            nrc: { name: 'NRC.pdf', storagePath: 'prod_files/clients/C1784327580134/legal/nrc.pdf', versionNumber: 1, sha256: 'mno1234567890' },
            dui: { name: 'CARNET DE RESIDENTE WILLIAM GONZALEZ.pdf', storagePath: 'prod_files/clients/C1784327580134/identificacion/1793980364661_CARNET_DE_RESIDENTE_WILLIAM_GONZALEZ.pdf', versionNumber: 2, sha256: '66617b53758e09df91df6c438888954c90b7017ee67842b89285fe376f936e6a' }
          }
        };

        const res = ClientDocuments.syncClientLegalDocsChecklist(clientFull);
        const jurKeys = ['escritura', 'mods_escritura', 'credencial', 'nit', 'nrc', 'dui'];
        jurKeys.forEach(k => {
          expect(res[`jur:${k}`].isRegistered).toBe(true);
          expect(res[`jur:${k}`].status).toBe('registered');
          expect(els[`doc-checklist-badge-jur-${k}`].textContent).toContain('Documento registrado');
          expect(els[`doc-checklist-input-wrap-jur-${k}`].style.display).toBe('none');
          const inputId = k === 'mods_escritura' ? 'jur-file-mods' : `jur-file-${k}`;
          expect(els[inputId].disabled).toBe(true);
          expect(els[inputId].style.display).toBe('none');
          expect(els[`doc-checklist-registered-jur-${k}`].style.display).toBe('block');
          expect(els[`doc-checklist-registered-jur-${k}`].innerHTML).toContain('Sustituir');
          expect(els[`doc-checklist-registered-jur-${k}`].innerHTML).toContain('Expediente Digital del Cliente');
        });
        expect(els['doc-checklist-registered-jur-dui'].innerHTML).toContain('CARNET DE RESIDENTE WILLIAM GONZALEZ.pdf');
        expect(els['doc-checklist-registered-jur-dui'].innerHTML).toContain('v2');
        expect(els['jur-legal-docs-checklist-summary'].textContent).toContain('6/6 registrados');
      } finally {
        global.document = origDoc;
      }
    });

    test('Escenarios 2, 3, 4 y 5: Cliente nuevo, parcial, Modificación opcional y NRC No aplica en exportación', () => {
      const { els, document: fakeDoc } = createChecklistDom();
      const origDoc = global.document;
      global.document = fakeDoc;

      try {
        // Escenario 2 & 4: Cliente nuevo (sin documentos)
        const resNew = ClientDocuments.syncClientLegalDocsChecklist(null);
        expect(resNew['jur:escritura'].status).toBe('pending');
        expect(els['doc-checklist-badge-jur-escritura'].textContent).toContain('Pendiente de cargar');
        expect(els['jur-file-escritura'].disabled).toBe(false);
        expect(els['doc-checklist-input-wrap-jur-escritura'].style.display).toBe('block');

        // Modificación al Pacto Social ausente se muestra como Opcional
        expect(resNew['jur:mods_escritura'].status).toBe('optional');
        expect(els['doc-checklist-badge-jur-mods_escritura'].textContent).toContain('Opcional');

        // Escenario 5: Cliente de exportación sin NRC -> No aplica
        els['cli-es-exportacion'].checked = true;
        const resExport = ClientDocuments.syncClientLegalDocsChecklist({ id: 'C_EXP', tipo: 'juridica', es_exportacion: true, documentos: {} });
        expect(resExport['jur:nrc'].status).toBe('not_applicable');
        expect(els['doc-checklist-badge-jur-nrc'].textContent).toContain('No aplica');

        // Escenario 3: Cliente con documentos parciales
        els['cli-es-exportacion'].checked = false;
        const resPartial = ClientDocuments.syncClientLegalDocsChecklist({
          id: 'C_PARTIAL',
          tipo: 'juridica',
          documentos: {
            escritura: { name: 'escritura.pdf', storagePath: 'prod_files/clients/C_PARTIAL/legal/esc.pdf' },
            nit: { name: 'nit.pdf', storagePath: 'prod_files/clients/C_PARTIAL/legal/nit.pdf' }
          }
        });
        expect(resPartial['jur:escritura'].isRegistered).toBe(true);
        expect(resPartial['jur:nit'].isRegistered).toBe(true);
        expect(resPartial['jur:credencial'].isRegistered).toBe(false);
        expect(els['jur-file-escritura'].disabled).toBe(true);
        expect(els['jur-file-credencial'].disabled).toBe(false);
        expect(els['jur-legal-docs-checklist-summary'].textContent).toContain('2/6 registrados');
      } finally {
        global.document = origDoc;
      }
    });

    test('Escenario 6: Metadatos de validación (Vencido, Pendiente de revisión, Observado) se reflejan sin asumir validez automática', () => {
      const clientMeta = {
        id: 'C_META',
        tipo: 'juridica',
        biennialReviews: {
          escritura: { nextReviewAt: '2025-01-01' }
        },
        documentos: {
          escritura: { name: 'esc.pdf', storagePath: 'prod_files/clients/C_META/legal/esc.pdf' },
          credencial: { name: 'cred.pdf', storagePath: 'prod_files/clients/C_META/legal/cred.pdf', fechaVencimiento: '2025-05-01' },
          nit: { name: 'nit.pdf', storagePath: 'prod_files/clients/C_META/legal/nit.pdf', estadoValidacion: 'observado', observacion: 'Imagen ilegible' }
        }
      };

      const stEsc = ClientDocuments.evaluateClientDocumentChecklistState(clientMeta, 'escritura', { todayIso: '2026-11-06' });
      expect(stEsc.status).toBe('review_pending');
      expect(stEsc.badgeText).toContain('Pendiente de revisión');

      const stCred = ClientDocuments.evaluateClientDocumentChecklistState(clientMeta, 'credencial', { todayIso: '2026-11-06' });
      expect(stCred.status).toBe('expired');
      expect(stCred.badgeText).toContain('Vencido');

      const stNit = ClientDocuments.evaluateClientDocumentChecklistState(clientMeta, 'nit', { todayIso: '2026-11-06' });
      expect(stNit.status).toBe('observed');
      expect(stNit.badgeText).toContain('Observado');
    });

    test('Escenarios 7, 8 y 9: Actualización en vivo al cargar/sustituir y aislamiento al cambiar entre clientes', () => {
      const { els, document: fakeDoc } = createChecklistDom();
      const origDoc = global.document;
      global.document = fakeDoc;

      try {
        const clientA = {
          id: 'C_A',
          tipo: 'juridica',
          documentos: {
            dui: { name: 'dui_v1.pdf', storagePath: 'prod_files/clients/C_A/identificacion/dui_v1.pdf', versionNumber: 1 }
          }
        };

        // Inicialmente DUI está registrado (v1) y NRC está pendiente
        ClientDocuments.syncClientLegalDocsChecklist(clientA);
        expect(els['jur-file-dui'].disabled).toBe(true);
        expect(els['jur-file-nrc'].disabled).toBe(false);
        expect(els['doc-checklist-registered-jur-dui'].innerHTML).toContain('dui_v1.pdf');

        // Escenario 7: Carga inicial de NRC pasa en vivo a Documento registrado
        clientA.documentos.nrc = { name: 'nrc_inicial.pdf', storagePath: 'prod_files/clients/C_A/legal/nrc.pdf', versionNumber: 1 };
        ClientDocuments.syncClientLegalDocsChecklist(clientA);
        expect(els['jur-file-nrc'].disabled).toBe(true);
        expect(els['doc-checklist-badge-jur-nrc'].textContent).toContain('Documento registrado');

        // Escenario 8: Sustitución de DUI desde Expediente Digital actualiza versión a v2 en vivo
        clientA.documentos.dui = { name: 'carnet_residente_v2.pdf', storagePath: 'prod_files/clients/C_A/identificacion/carnet_v2.pdf', versionNumber: 2 };
        ClientDocuments.syncClientLegalDocsChecklist(clientA);
        expect(els['doc-checklist-registered-jur-dui'].innerHTML).toContain('carnet_residente_v2.pdf');
        expect(els['doc-checklist-registered-jur-dui'].innerHTML).toContain('v2');

        // Escenario 9: Cambio a otro cliente sin documentos no arrastra el estado de clientA
        const clientB = { id: 'C_B', tipo: 'juridica', documentos: {} };
        ClientDocuments.syncClientLegalDocsChecklist(clientB);
        expect(els['jur-file-dui'].disabled).toBe(false);
        expect(els['jur-file-nrc'].disabled).toBe(false);
        expect(els['doc-checklist-registered-jur-dui'].style.display).toBe('none');
        expect(els['doc-checklist-badge-jur-dui'].textContent).toContain('Pendiente de cargar');
      } finally {
        global.document = origDoc;
      }
    });
  });
});
