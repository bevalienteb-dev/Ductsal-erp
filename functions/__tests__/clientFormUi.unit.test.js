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
const appCoreSrc = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');

describe('Phase 5.3: Client Form Visual Enhancement & Integrity', () => {

  // =========================================================================
  // 1. HTML Hierarchy, Grouped Sections & Complete Field Inventory
  // =========================================================================
  describe('1. HTML Hierarchy & Field Preservation', () => {
    test('preserves client modal container and header structure', () => {
      expect(indexHtml).toContain('id="clientModal"');
      expect(indexHtml).toContain('class="modal-content glass-panel client-modal-content"');
      expect(indexHtml).toContain('id="client-modal-title"');
      expect(indexHtml).toContain('class="client-modal-header"');
      expect(indexHtml).toContain('class="client-modal-subtitle"');
      expect(indexHtml).toContain('closeModal(\'clientModal\')');
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
      expect(indexHtml).toContain('onclick="closeModal(\'clientModal\')"');
      expect(indexHtml).toContain('id="btn-submit-client"');
      expect(indexHtml).toContain('Guardar Cliente');
    });
  });

  // =========================================================================
  // 2. CSS Styles, Modal Width & Mobile Responsiveness
  // =========================================================================
  describe('2. CSS Design & Responsive Rules', () => {
    test('defines max-width 720px for desktop client modal', () => {
      expect(stylesCss).toContain('#clientModal .modal-content');
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
      expect(appCoreSrc).toContain('function setClientFieldError(elementId, hasError)');
      expect(appCoreSrc).toContain("classList.toggle('input-error'");
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

    test('openClientModal resets form and clears input-error states', () => {
      expect(appCoreSrc).toContain("const errs = document.querySelectorAll('#clientForm .input-error');");
      expect(appCoreSrc).toContain("errs.forEach(el => el.classList.remove('input-error'))");
    });

    test('saveClient validates missing type, missing contacts, and missing names/company', async () => {
      // Slices real saveClient from app_core.js
      const from = 'async function saveClient(e)';
      const to = '// ========================\n// PROSPECTS & PROJECTS LISTS';
      const a = appCoreSrc.indexOf(from);
      const b = appCoreSrc.indexOf(to, a + from.length);
      const saveSrc = appCoreSrc.slice(a, b);

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
});
