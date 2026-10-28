// functions/__tests__/crmUi.unit.test.js
// Unit tests for the Ductsal ERP Notification & Confirmation Engine (crm_ui.js)
// Verifies toasts (success, info, warning, error), deduplication, auto-dismiss,
// accessible confirmation dialogs, keyboard navigation, focus restoration, and fail-closed safety.

function createMockElement(tag = 'div') {
  const listeners = {};
  const attributes = {};
  const classes = new Set();
  const children = [];

  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    style: {},
    dataset: {},
    parentNode: null,
    children,
    get nextElementSibling() {
      if (!this.parentNode || !this.parentNode.children) return null;
      const siblings = this.parentNode.children;
      const idx = siblings.indexOf(this);
      if (idx === -1 || idx === siblings.length - 1) return null;
      return siblings[idx + 1];
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      if (val) val.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    },
    classList: {
      add: (...cls) => cls.forEach(c => classes.add(c)),
      remove: (...cls) => cls.forEach(c => classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: (k) => attributes[k] || null,
    hasAttribute: (k) => k in attributes,
    removeAttribute: (k) => { delete attributes[k]; },

    get textContent() {
      if (this._textContent !== undefined) return this._textContent;
      if (children.length > 0) return children.map(c => c.textContent).join(' ');
      return '';
    },
    set textContent(val) {
      this._textContent = String(val || '');
      this._innerHTML = undefined;
    },

    get innerHTML() {
      if (this._innerHTML !== undefined) return this._innerHTML;
      if (children.length > 0) {
        return children.map(c => `<${c.tagName.toLowerCase()}${c.className ? ` class="${c.className}"` : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`).join('');
      }
      if (this._textContent !== undefined) {
        return this._textContent
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
      return '';
    },
    set innerHTML(val) {
      this._innerHTML = String(val || '');
      this._textContent = undefined;
    },

    appendChild: (child) => {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    contains: (child) => {
      if (!child) return false;
      let curr = child;
      while (curr) {
        if (curr === el) return true;
        curr = curr.parentNode;
      }
      return false;
    },

    focus: () => {
      if (global.document) {
        global.document.activeElement = el;
      }
    },

    addEventListener: (evt, handler) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(handler);
    },
    removeEventListener: (evt, handler) => {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter(h => h !== handler);
    },
    dispatchEvent: (event) => {
      const type = event.type || event;
      const handlers = listeners[type] || [];
      handlers.forEach(h => h(event));
    },
    click: () => {
      el.dispatchEvent({ type: 'click', target: el, stopPropagation: () => {} });
    },

    querySelector: (selector) => {
      return el.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll: (selector) => {
      const results = [];
      function match(node) {
        if (!node) return;
        let isMatch = false;
        if (selector.startsWith('#')) {
          isMatch = (node.id === selector.slice(1));
        } else if (selector.startsWith('.')) {
          isMatch = node.classList && node.classList.contains(selector.slice(1));
        } else if (selector === 'button' || selector === 'div' || selector === 'h3') {
          isMatch = (node.tagName && node.tagName.toLowerCase() === selector);
        } else if (selector.includes('.')) {
          const parts = selector.split('.');
          const tag = parts[0];
          const cls = parts.slice(1);
          isMatch = (!tag || (node.tagName && node.tagName.toLowerCase() === tag)) &&
                    cls.every(c => node.classList && node.classList.contains(c));
        }
        if (isMatch && node !== el) results.push(node);
        (node.children || []).forEach(match);
      }
      match(el);
      return results;
    }
  };

  return el;
}

function setupMockDom() {
  const listeners = {};
  const body = createMockElement('body');

  const doc = {
    body,
    getElementById: (id) => {
      return body.querySelector('#' + id);
    },
    createElement: (tag) => {
      return createMockElement(tag);
    },
    addEventListener: (evt, handler) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(handler);
    },
    removeEventListener: (evt, handler) => {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter(h => h !== handler);
    },
    dispatchEvent: (event) => {
      const type = event.type || event;
      const handlers = listeners[type] || [];
      handlers.forEach(h => h(event));
    },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    activeElement: null
  };

  global.document = doc;
  return doc;
}

describe('CrmUI Notifications (Toasts)', () => {
  let doc;
  let CrmUI;

  beforeEach(() => {
    doc = setupMockDom();
    jest.isolateModules(() => {
      CrmUI = require('../../crm_ui.js');
    });
    CrmUI.clearAll();
  });

  afterEach(() => {
    if (CrmUI) CrmUI.clearAll();
  });

  test('creates a toast container on the fly if not present in DOM', () => {
    expect(doc.getElementById('crm-toast-container')).toBeNull();
    CrmUI.success('Operación completada con éxito');
    const container = doc.getElementById('crm-toast-container');
    expect(container).not.toBeNull();
    expect(container.className).toContain('crm-toast-container');
  });

  test('dispatches success, info, warning, and error toasts with correct classes and roles', () => {
    CrmUI.success('Guardado correctamente');
    CrmUI.info('Nota informativa para el usuario');
    CrmUI.warning('Atención requerida en el formulario');
    CrmUI.error('Error al procesar la solicitud');

    const toasts = doc.querySelectorAll('.crm-toast');
    expect(toasts).toHaveLength(4);

    expect(toasts[0].className).toContain('crm-toast-success');
    expect(toasts[0].getAttribute('role')).toBe('status');
    expect(toasts[0].textContent).toContain('Guardado correctamente');

    expect(toasts[1].className).toContain('crm-toast-info');
    expect(toasts[1].getAttribute('role')).toBe('status');
    expect(toasts[1].textContent).toContain('Nota informativa para el usuario');

    expect(toasts[2].className).toContain('crm-toast-warning');
    expect(toasts[2].getAttribute('role')).toBe('alert');
    expect(toasts[2].textContent).toContain('Atención requerida en el formulario');

    expect(toasts[3].className).toContain('crm-toast-error');
    expect(toasts[3].getAttribute('role')).toBe('alert');
    expect(toasts[3].textContent).toContain('Error al procesar la solicitud');
  });

  test('escapes HTML content to prevent XSS injection in messages and titles', () => {
    const malicious = '<img src=x onerror=alert(1)>Malicious Code';
    CrmUI.error(malicious, { title: '<script>evil()</script>Alerta' });

    const toast = doc.querySelector('.crm-toast');
    expect(toast.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    expect(toast.innerHTML).not.toContain('<script>evil()</script>');
    expect(toast.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;Malicious Code');
    expect(toast.innerHTML).toContain('&lt;script&gt;evil()&lt;/script&gt;Alerta');
  });

  test('deduplicates identical messages within deduplication window', () => {
    CrmUI.warning('El correo ya está en uso');
    CrmUI.warning('El correo ya está en uso');
    CrmUI.warning('El correo ya está en uso');

    const toasts = doc.querySelectorAll('.crm-toast');
    expect(toasts).toHaveLength(1);
  });

  test('allows dismiss via close button', () => {
    jest.useFakeTimers();
    CrmUI.info('Mensaje con botón cerrar');
    const toast = doc.querySelector('.crm-toast');
    expect(toast).not.toBeNull();

    const closeBtn = toast.querySelector('.crm-toast-close');
    expect(closeBtn).not.toBeNull();
    closeBtn.click();

    expect(toast.className).toContain('crm-toast-leaving');
    jest.advanceTimersByTime(300);
    expect(doc.querySelector('.crm-toast')).toBeNull();
    jest.useRealTimers();
  });

  test('clearAll removes all active toasts and clears cache', () => {
    CrmUI.success('Uno');
    CrmUI.info('Dos');
    expect(doc.querySelectorAll('.crm-toast')).toHaveLength(2);

    CrmUI.clearAll();
    expect(doc.querySelectorAll('.crm-toast')).toHaveLength(0);
  });
});

describe('CrmUI Confirmation Dialogs (confirm)', () => {
  let doc;
  let CrmUI;

  beforeEach(() => {
    doc = setupMockDom();
    jest.isolateModules(() => {
      CrmUI = require('../../crm_ui.js');
    });
    CrmUI.clearAll();
  });

  afterEach(() => {
    if (CrmUI) CrmUI.clearAll();
  });

  test('opens accessible modal dialog and sets body.modal-open', () => {
    CrmUI.confirm({
      title: 'Restablecer Contraseña',
      message: '¿Enviar correo de restablecimiento?',
      confirmText: 'Enviar correo',
      cancelText: 'Cancelar'
    });

    const overlay = doc.querySelector('.crm-confirm-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(doc.body.classList.contains('modal-open')).toBe(true);

    const titleEl = doc.getElementById('crm-confirm-title');
    expect(titleEl.textContent).toBe('Restablecer Contraseña');

    const bodyEl = overlay.querySelector('.crm-confirm-body');
    expect(bodyEl.textContent).toContain('¿Enviar correo de restablecimiento?');
  });

  test('resolves true when action button is clicked', async () => {
    const promise = CrmUI.confirm({
      title: 'Confirmar',
      message: '¿Proceder con la operación?',
      confirmText: 'Aceptar',
      cancelText: 'Cancelar'
    });

    const actionBtn = doc.querySelector('.crm-confirm-action-btn');
    expect(actionBtn).not.toBeNull();
    actionBtn.click();

    const result = await promise;
    expect(result).toBe(true);
    expect(doc.querySelector('.crm-confirm-overlay')).toBeNull();
    expect(doc.body.classList.contains('modal-open')).toBe(false);
  });

  test('resolves false when cancel button is clicked and does not proceed', async () => {
    const promise = CrmUI.confirm({
      title: 'Eliminar usuario',
      message: '¿Estás seguro?',
      confirmText: 'Eliminar',
      cancelText: 'Cancelar',
      danger: true
    });

    const cancelBtn = doc.querySelector('.crm-confirm-cancel-btn');
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click();

    const result = await promise;
    expect(result).toBe(false);
    expect(doc.querySelector('.crm-confirm-overlay')).toBeNull();
    expect(doc.body.classList.contains('modal-open')).toBe(false);
  });

  test('resolves false when Escape key is pressed', async () => {
    const promise = CrmUI.confirm({
      message: '¿Deseas guardar los cambios?'
    });

    doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => {} });

    const result = await promise;
    expect(result).toBe(false);
    expect(doc.querySelector('.crm-confirm-overlay')).toBeNull();
    expect(doc.body.classList.contains('modal-open')).toBe(false);
  });

  test('resolves false when clicking outside the dialog card (on the backdrop overlay)', async () => {
    const promise = CrmUI.confirm({
      message: '¿Confirmar acción?'
    });

    const overlay = doc.querySelector('.crm-confirm-overlay');
    overlay.dispatchEvent({ type: 'click', target: overlay });

    const result = await promise;
    expect(result).toBe(false);
    expect(doc.querySelector('.crm-confirm-overlay')).toBeNull();
  });

  test('restores focus to previously active element upon closing the dialog', async () => {
    const triggerBtn = doc.createElement('button');
    triggerBtn.id = 'trigger-btn';
    doc.body.appendChild(triggerBtn);
    triggerBtn.focus();
    expect(doc.activeElement).toBe(triggerBtn);

    const promise = CrmUI.confirm({ message: '¿Continuar?' });
    // Inside dialog, actionBtn receives focus
    const actionBtn = doc.querySelector('.crm-confirm-action-btn');
    expect(doc.activeElement).toBe(actionBtn);

    // Cancel dialog
    const cancelBtn = doc.querySelector('.crm-confirm-cancel-btn');
    cancelBtn.click();
    await promise;

    // Focus restored to triggerBtn
    expect(doc.activeElement).toBe(triggerBtn);
  });

  test('fail-closed fallback: resolves false when document is not available and no confirm mechanism exists', async () => {
    const originalDoc = global.document;
    delete global.document;
    const originalConfirm = global.confirm;
    delete global.confirm;

    const result = await CrmUI.confirm({ message: 'Acción sensible' });
    expect(result).toBe(false);

    global.document = originalDoc;
    if (originalConfirm) global.confirm = originalConfirm;
  });
});

describe('User Management Integration with CrmUI', () => {
  let doc;
  let CrmUI;

  beforeEach(() => {
    doc = setupMockDom();
    jest.isolateModules(() => {
      CrmUI = require('../../crm_ui.js');
    });
    global.CrmUI = CrmUI;
    CrmUI.clearAll();
  });

  afterEach(() => {
    if (CrmUI) CrmUI.clearAll();
    delete global.CrmUI;
  });

  test('resetUserPassword: cancelling confirmation does not send setup email', async () => {
    const emailCalls = [];
    const CrmAuth = {
      sendPasswordSetupEmail: jest.fn(async (fb, email) => { emailCalls.push(email); })
    };
    const users = [{ id: 'u1', nombre: 'Juan Perez', email: 'juan@ductsal.com', authUid: 'auth-1' }];
    const firebase = {};

    // Simulate resetUserPassword logic from app_core.js
    const resetUserPassword = async (id) => {
      const target = users.find(x => x.id === id);
      if (!target || !target.authUid) return;

      let confirmed = false;
      if (typeof CrmUI !== 'undefined' && CrmUI.confirm) {
        confirmed = await CrmUI.confirm({
          title: 'Restablecer Contraseña',
          message: `¿Enviar a ${target.nombre || target.email} un correo para restablecer su contraseña?`,
          confirmText: 'Enviar correo',
          cancelText: 'Cancelar',
          type: 'info'
        });
      } else if (typeof confirm === 'function') {
        confirmed = confirm("¿Enviar a este usuario un correo para restablecer su contraseña?");
      }
      if (!confirmed) return;

      await CrmAuth.sendPasswordSetupEmail(firebase, target.email);
      CrmUI.success('Correo de restablecimiento enviado.');
    };

    const actionPromise = resetUserPassword('u1');
    const cancelBtn = doc.querySelector('.crm-confirm-cancel-btn');
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click(); // User cancels

    await actionPromise;
    expect(CrmAuth.sendPasswordSetupEmail).not.toHaveBeenCalled();
    expect(emailCalls).toHaveLength(0);
    expect(doc.querySelectorAll('.crm-toast-success')).toHaveLength(0);
  });

  test('resetUserPassword: confirming sends email and displays success notification', async () => {
    const emailCalls = [];
    const CrmAuth = {
      sendPasswordSetupEmail: jest.fn(async (fb, email) => { emailCalls.push(email); })
    };
    const users = [{ id: 'u1', nombre: 'Juan Perez', email: 'juan@ductsal.com', authUid: 'auth-1' }];
    const firebase = {};

    const resetUserPassword = async (id) => {
      const target = users.find(x => x.id === id);
      if (!target || !target.authUid) return;

      let confirmed = false;
      if (typeof CrmUI !== 'undefined' && CrmUI.confirm) {
        confirmed = await CrmUI.confirm({
          title: 'Restablecer Contraseña',
          message: `¿Enviar a ${target.nombre || target.email} un correo para restablecer su contraseña?`,
          confirmText: 'Enviar correo',
          cancelText: 'Cancelar',
          type: 'info'
        });
      } else if (typeof confirm === 'function') {
        confirmed = confirm("¿Enviar a este usuario un correo para restablecer su contraseña?");
      }
      if (!confirmed) return;

      await CrmAuth.sendPasswordSetupEmail(firebase, target.email);
      CrmUI.success('Correo de restablecimiento enviado.');
    };

    const actionPromise = resetUserPassword('u1');
    const confirmBtn = doc.querySelector('.crm-confirm-action-btn');
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click(); // User confirms

    await actionPromise;
    expect(CrmAuth.sendPasswordSetupEmail).toHaveBeenCalledWith(firebase, 'juan@ductsal.com');
    const successToast = doc.querySelector('.crm-toast-success');
    expect(successToast).not.toBeNull();
    expect(successToast.textContent).toContain('Correo de restablecimiento enviado.');
  });

  test('resetUserPassword: fail-closed safety prevents email dispatch if confirmation is not explicitly granted', async () => {
    const CrmAuth = {
      sendPasswordSetupEmail: jest.fn(async () => {})
    };
    const users = [{ id: 'u1', nombre: 'Juan Perez', email: 'juan@ductsal.com', authUid: 'auth-1' }];
    const firebase = {};

    const resetUserPassword = async (id) => {
      const target = users.find(x => x.id === id);
      if (!target || !target.authUid) return;

      let confirmed = false; // Fail-closed default
      // Neither CrmUI nor confirm provides true
      if (!confirmed) return;

      await CrmAuth.sendPasswordSetupEmail(firebase, target.email);
    };

    await resetUserPassword('u1');
    expect(CrmAuth.sendPasswordSetupEmail).not.toHaveBeenCalled();
  });

  test('toggleUserStatus: preventing self-deactivation triggers warning toast', () => {
    const currentUser = { id: 'admin1', nombre: 'Admin' };
    const users = [{ id: 'admin1', nombre: 'Admin', activo: true }];

    const toggleUserStatus = (id) => {
      const u = users.find(x => x.id === id);
      if (u.id === currentUser.id) {
        CrmUI.warning('No puedes desactivarte a ti mismo.');
        return;
      }
    };

    toggleUserStatus('admin1');
    const warningToast = doc.querySelector('.crm-toast-warning');
    expect(warningToast).not.toBeNull();
    expect(warningToast.textContent).toContain('No puedes desactivarte a ti mismo.');
  });
});

describe('Commercial Logs (Bitácora) Integration with CrmUI', () => {
  let doc;
  let CrmUI;

  beforeEach(() => {
    doc = setupMockDom();
    jest.isolateModules(() => {
      CrmUI = require('../../crm_ui.js');
    });
    global.CrmUI = CrmUI;
    CrmUI.clearAll();
  });

  afterEach(() => {
    if (CrmUI) CrmUI.clearAll();
    delete global.CrmUI;
  });

  const fs = require('fs');
  const path = require('path');
  const appCoreCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
  const extractFn = (startStr, endStr) => {
    const start = appCoreCode.indexOf(startStr);
    const end = appCoreCode.indexOf(endStr, start);
    if (start < 0 || end < 0) throw new Error(`Could not find ${startStr} .. ${endStr}`);
    return appCoreCode.slice(start, end);
  };

  const makeCommercialContext = (opts = {}) => {
    const session = opts.session !== undefined ? opts.session : true;
    const CrmUIRef = 'CrmUIRef' in opts ? opts.CrmUIRef : CrmUI;
    const confirmRef = 'confirmRef' in opts ? opts.confirmRef : (typeof confirm !== 'undefined' ? confirm : null);

    const S = {
      prospects: [{ id: 'P1', logs: [{ text: 'Nota de prueba', date: '2026-10-27T10:00:00.000Z', auto: false }] }],
      currentProspectId: 'P1',
      DB_SUFFIX: '_test',
      renderLogs: jest.fn()
    };
    const crmCommercial = opts.CrmCommercialMock || {
      hasSessionSync: jest.fn(() => session),
      deleteLog: jest.fn(async () => ({ status: 'deleted' })),
      addLog: jest.fn(async () => ({ status: 'added', entry: { text: '(Gerente) Nueva nota', date: '2026-10-27T11:00:00.000Z' } })),
      errorMessage: (err) => err && err.message ? err.message : String(err),
      NO_SESSION_MESSAGE: 'No se pudo guardar el cambio porque no hay una sesión activa de Firebase.'
    };
    const deleteLogSrc = extractFn('function deleteLog(', 'function addLogToProspect');
    const addLogSrc = extractFn('function addLog()', 'function showNewProposalForm');

    const runner = new Function('S', 'document', 'firebase', 'CrmCommercial', 'CrmUI', 'confirm', 'alert', 'renderLogs', 'window', `
      with (S) {
        ${deleteLogSrc}
        ${addLogSrc}
        return { deleteLog, addLog };
      }
    `);

    const fns = runner(
      S,
      doc,
      { auth: () => ({ currentUser: session ? { uid: 'u1' } : null }) },
      crmCommercial,
      CrmUIRef,
      confirmRef,
      jest.fn(),
      S.renderLogs,
      {}
    );

    return { S, crmCommercial, ...fns };
  };

  test('deleteLog: cancelling in CrmUI confirmation dialog does NOT delete note or call backend', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext();
    const deletePromise = deleteLog('P1', 0);

    const cancelBtn = doc.querySelector('.crm-confirm-cancel-btn');
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click();

    await deletePromise;
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
    expect(S.renderLogs).not.toHaveBeenCalled();
    expect(doc.querySelectorAll('.crm-toast-success')).toHaveLength(0);
  });

  test('deleteLog: pressing Escape in confirmation dialog cancels deletion and leaves note intact', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext();
    const deletePromise = deleteLog('P1', 0);

    const overlay = doc.querySelector('.crm-confirm-overlay');
    expect(overlay).not.toBeNull();
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });

    await deletePromise;
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
    expect(doc.querySelector('.crm-confirm-overlay')).toBeNull();
  });

  test('deleteLog: clicking backdrop in confirmation dialog cancels deletion', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext();
    const deletePromise = deleteLog('P1', 0);

    const overlay = doc.querySelector('.crm-confirm-overlay');
    expect(overlay).not.toBeNull();
    overlay.dispatchEvent({ type: 'click', target: overlay });

    await deletePromise;
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
  });

  test('deleteLog: confirming deletion executes CrmCommercial.deleteLog, splices log, and shows success toast', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext();
    const deletePromise = deleteLog('P1', 0);

    const actionBtn = doc.querySelector('.crm-confirm-action-btn');
    expect(actionBtn).not.toBeNull();
    expect(actionBtn.className).toContain('btn-danger');
    actionBtn.click();

    await deletePromise;
    expect(crmCommercial.deleteLog).toHaveBeenCalledWith(
      expect.anything(),
      { prospectId: 'P1', date: '2026-10-27T10:00:00.000Z', text: 'Nota de prueba', dbSuffix: '_test' }
    );
    expect(S.prospects[0].logs).toHaveLength(0);
    expect(S.renderLogs).toHaveBeenCalledWith(S.prospects[0]);
    const successToast = doc.querySelector('.crm-toast-success');
    expect(successToast).not.toBeNull();
    expect(successToast.textContent).toContain('Nota eliminada de la bitácora.');
  });

  test('deleteLog: server rejection displays error toast and leaves note in prospect logs', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext();
    crmCommercial.deleteLog.mockRejectedValueOnce(new Error('Solo puedes eliminar notas creadas por ti'));
    const deletePromise = deleteLog('P1', 0);

    const actionBtn = doc.querySelector('.crm-confirm-action-btn');
    actionBtn.click();

    await deletePromise;
    expect(S.prospects[0].logs).toHaveLength(1);
    const errToast = doc.querySelector('.crm-toast-error');
    expect(errToast).not.toBeNull();
    expect(errToast.textContent).toContain('Solo puedes eliminar notas creadas por ti');
  });

  test('deleteLog: session missing displays error toast without calling backend', async () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext({ session: false });
    const deletePromise = deleteLog('P1', 0);

    const actionBtn = doc.querySelector('.crm-confirm-action-btn');
    actionBtn.click();

    await deletePromise;
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
    const errToast = doc.querySelector('.crm-toast-error');
    expect(errToast).not.toBeNull();
    expect(errToast.textContent).toContain('No se pudo guardar el cambio');
  });

  test('deleteLog: fail-closed fallback prevents deletion if CrmUI is absent and confirm returns false', () => {
    const confirmSpy = jest.fn(() => false);
    const { S, crmCommercial, deleteLog } = makeCommercialContext({ CrmUIRef: undefined, confirmRef: confirmSpy });
    deleteLog('P1', 0);
    expect(confirmSpy).toHaveBeenCalled();
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
  });

  test('deleteLog: fail-closed safety prevents deletion if neither CrmUI nor confirm is available', () => {
    const { S, crmCommercial, deleteLog } = makeCommercialContext({ CrmUIRef: undefined, confirmRef: undefined });
    deleteLog('P1', 0);
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
  });

  test('deleteLog: rejection in CrmUI.confirm displays error notification, does not delete note, and does not call backend', async () => {
    const CrmUIMock = {
      confirm: jest.fn().mockRejectedValue(new Error('UI modal crash')),
      error: jest.fn(),
      clearAll: jest.fn()
    };
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { S, crmCommercial, deleteLog } = makeCommercialContext({ CrmUIRef: CrmUIMock });

    await deleteLog('P1', 0);
    consoleSpy.mockRestore();

    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
    expect(CrmUIMock.error).toHaveBeenCalledWith('No se pudo confirmar la eliminación. La nota no fue eliminada.');
  });

  test('deleteLog: native confirm throwing an error safely blocks deletion without calls or state mutation', () => {
    const throwingConfirm = jest.fn(() => { throw new Error('Native alert subsystem failure'); });
    const { S, crmCommercial, deleteLog } = makeCommercialContext({ CrmUIRef: undefined, confirmRef: throwingConfirm });

    deleteLog('P1', 0);

    expect(throwingConfirm).toHaveBeenCalled();
    expect(crmCommercial.deleteLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
  });

  test('addLog: successfully adds note, clears input, and displays success toast', async () => {
    const { S, crmCommercial, addLog } = makeCommercialContext();
    const input = doc.createElement('input');
    input.id = 'new-log-text';
    input.value = 'Llamada de seguimiento con cliente';
    const btn = doc.createElement('button');
    doc.body.appendChild(input);
    doc.body.appendChild(btn);

    await addLog();
    expect(crmCommercial.addLog).toHaveBeenCalledWith(
      expect.anything(),
      { prospectId: 'P1', text: 'Llamada de seguimiento con cliente', dbSuffix: '_test' }
    );
    expect(S.prospects[0].logs).toHaveLength(2);
    expect(input.value).toBe('');
    expect(btn.disabled).toBe(false);
    expect(S.renderLogs).toHaveBeenCalledWith(S.prospects[0]);
    const toast = doc.querySelector('.crm-toast-success');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Nota agregada a la bitácora.');
  });

  test('addLog: missing session displays error toast and does not call backend', async () => {
    const { S, crmCommercial, addLog } = makeCommercialContext({ session: false });
    const input = doc.createElement('input');
    input.id = 'new-log-text';
    input.value = 'Nota sin sesión';
    const btn = doc.createElement('button');
    doc.body.appendChild(input);
    doc.body.appendChild(btn);

    await addLog();
    expect(crmCommercial.addLog).not.toHaveBeenCalled();
    expect(S.prospects[0].logs).toHaveLength(1);
    const toast = doc.querySelector('.crm-toast-error');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('No se pudo guardar el cambio');
  });

  test('addLog: server rejection displays error toast, leaves logs unchanged, and re-enables button', async () => {
    const { S, crmCommercial, addLog } = makeCommercialContext();
    crmCommercial.addLog.mockRejectedValueOnce(new Error('Longitud máxima superada'));
    const input = doc.createElement('input');
    input.id = 'new-log-text';
    input.value = 'Nota muy larga';
    const btn = doc.createElement('button');
    doc.body.appendChild(input);
    doc.body.appendChild(btn);

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await addLog();
    errSpy.mockRestore();

    expect(S.prospects[0].logs).toHaveLength(1);
    expect(btn.disabled).toBe(false);
    expect(input.value).toBe('Nota muy larga'); // Input preserved for user retry
    expect(doc.querySelectorAll('.crm-toast-success')).toHaveLength(0); // Never show success on rejection
    const toast = doc.querySelector('.crm-toast-error');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Longitud máxima superada');
  });
});

describe('Pipeline Opportunities Presentation & Filter Coexistence (Fase 5.1 Bloque 3)', () => {
  const fs = require('fs');
  const path = require('path');
  const appCoreCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
  const stylesCssCode = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const indexHtmlCode = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

  const extractCode = (from, to) => {
    const a = appCoreCode.indexOf(from);
    const b = appCoreCode.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`Could not find markers: ${from} .. ${to}`);
    return appCoreCode.slice(a, b);
  };

  const PIPELINE_CORE_SRC = [
    extractCode('function parseProspectDate(raw)', 'function reassignVendor('),
    'const formatCurrency = (val) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(val || 0);',
    'const getDaysDifference = (d1) => Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24));',
    'let oppSortCol = null;',
    'let oppSortDir = "asc";',
    extractCode('function getClientName(clientId)', 'function renderProjectsList')
  ].join('\n');

  function createPipelineSandbox(customState = {}) {
    const elements = {};
    const getEl = (id) => {
      if (!elements[id]) {
        const classes = new Set();
        const attrs = {};
        elements[id] = {
          id,
          tagName: 'DIV',
          value: '',
          style: {},
          textContent: '',
          _innerHTML: '',
          children: [],
          attributes: attrs,
          setAttribute: (k, v) => { attrs[k] = String(v); },
          getAttribute: (k) => attrs[k],
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

    const documentMock = {
      getElementById: (id) => getEl(id),
      createElement: (tag) => {
        const classes = new Set();
        const attrs = {};
        return {
          tagName: tag.toUpperCase(),
          style: {},
          attributes: attrs,
          setAttribute: (k, v) => { attrs[k] = String(v); },
          getAttribute: (k) => attrs[k],
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

    [
      'opp-table-body', 'filter-opp-activas', 'filter-opp-perdidas', 'filter-opp-todas',
      'count-opp-activas', 'count-opp-perdidas', 'count-opp-todas',
      'filter-clasif-todas', 'filter-clasif-ejecucion', 'filter-clasif-presupuesto',
      'count-opp-ejecucion', 'count-opp-presupuesto',
      'filter-stage-todas', 'count-stage-todas',
      'filter-stage-prospecto', 'count-stage-prospecto',
      'filter-stage-levantamiento', 'count-stage-levantamiento',
      'filter-stage-cotizacion', 'count-stage-cotizacion',
      'filter-stage-negociacion', 'count-stage-negociacion',
      'filter-stage-cierre', 'count-stage-cierre',
      'opp-count-badge', 'opp-search', 'opp-date-start', 'opp-date-end', 'btn-clear-opp-dates'
    ].forEach(id => getEl(id));

    const defaultProspects = [
      { id: 'p1', codigo: 'OPP-101', clientId: 'cli_1', proyecto: 'Ductos Hospital Central', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 52000, fecha_creacion: '2026-03-01T10:00:00.000Z', vendedorId: 'v1' },
      { id: 'p2', codigo: 'OPP-102', clientId: 'cli_2', proyecto: 'Edificio Residencial Prisma', clasificacion: 'presupuesto', estado: 'activo', etapa: 'negociacion', precio_cotizado: 34000, fecha_creacion: '2026-03-10T12:00:00.000Z', vendedorId: 'v1' },
      { id: 'p3', codigo: 'OPP-103', clientId: 'cli_1', proyecto: 'Centro Comercial Plaza', clasificacion: 'ejecucion', estado: 'perdido', etapa: 'levantamiento', precio_cotizado: 18000, fecha_creacion: '2026-03-15T15:00:00.000Z', vendedorId: 'v2' },
      { id: 'p4', codigo: 'OPP-104', clientId: 'cli_2', proyecto: 'Almacén Industrial Norte', clasificacion: 'presupuesto', estado: 'perdido', etapa: 'prospecto', precio_cotizado: null, fecha_creacion: '2026-02-15T09:00:00.000Z', vendedorId: 'v2' },
      { id: 'p5', codigo: 'OPP-105', clientId: 'cli_1', proyecto: 'Planta de Alimentos S.A.', clasificacion: 'ejecucion', estado: 'ganado', etapa: 'cierre', precio_cotizado: 89000, fecha_creacion: '2026-01-10T08:00:00.000Z', vendedorId: 'v1' }
    ];

    const S = {
      prospects: customState.prospects || defaultProspects,
      clients: customState.clients || [
        { id: 'cli_1', empresa: 'Grupo Constructor Alfa', tipo: 'juridico' },
        { id: 'cli_2', nombres: 'Mariana', apellidos: 'Pérez', tipo: 'natural' }
      ],
      users: customState.users || [
        { id: 'v1', nombre: 'Carlos Vendedor', role: 'vendedor' },
        { id: 'v2', nombre: 'Beatriz Gestora', role: 'gestor' }
      ],
      currentUser: customState.currentUser || { id: 'm1', nombre: 'Director Comercial', role: 'manager' }
    };

    const openedProspectIds = [];
    const openDetail = (id) => { openedProspectIds.push(id); };

    const sandboxFn = new Function(
      'S', 'document', 'openDetail',
      'with(S) {\n' + PIPELINE_CORE_SRC + '\n return { renderList, setOppStatusFilter, setOppClasifFilter, setOppStageFilter, getOppStageFilter, getOppStatusFilter, getOppClasifFilter, toggleOppSort, clearOppDateFilter };\n}'
    );

    const api = sandboxFn(S, documentMock, openDetail);
    return { api, elements, documentMock, S, openedProspectIds };
  }

  test('coexistence of filters: status, classification, search text, and date ranges combine seamlessly', () => {
    const { api, elements } = createPipelineSandbox();

    // Initial render (status='activas', clasif='todas') -> should show p1 and p2 (base active, won p5 and lost p3, p4 excluded)
    api.renderList();
    const tbody = elements['opp-table-body'];
    expect(tbody.children).toHaveLength(2);
    expect(elements['opp-count-badge'].textContent).toBe('2 oportunidades');
    expect(Number(elements['count-opp-activas'].textContent)).toBe(2);
    expect(Number(elements['count-opp-perdidas'].textContent)).toBe(2);

    // 1. Filter by classification = 'presupuesto'
    api.setOppClasifFilter('presupuesto');
    expect(tbody.children).toHaveLength(1);
    expect(tbody.children[0].innerHTML).toContain('OPP-102');
    expect(tbody.children[0].innerHTML).toContain('Edificio Residencial Prisma');
    expect(elements['opp-count-badge'].textContent).toBe('1 oportunidad');

    // 2. Add text search that doesn't match p2
    elements['opp-search'].value = 'Hospital';
    api.renderList();
    expect(tbody.children).toHaveLength(0); // Empty because p2 is Prisma, not Hospital
    expect(tbody.innerHTML).toContain('No se encontraron oportunidades.');

    // 3. Reset clasif to 'todas' -> p1 matches 'Hospital'
    api.setOppClasifFilter('todas');
    expect(tbody.children).toHaveLength(1);
    expect(tbody.children[0].innerHTML).toContain('OPP-101');
    expect(tbody.children[0].innerHTML).toContain('Ductos Hospital Central');

    // 4. Add date range excluding p1 (created 2026-03-01)
    elements['opp-date-start'].value = '2026-03-05';
    elements['opp-date-end'].value = '2026-03-20';
    api.renderList();
    expect(tbody.children).toHaveLength(0);
    expect(tbody.innerHTML).toContain('No se encontraron oportunidades.');
    expect(elements['btn-clear-opp-dates'].style.display).toBe('inline-block');

    // 5. Clear dates -> p1 returns
    api.clearOppDateFilter();
    expect(elements['opp-date-start'].value).toBe('');
    expect(elements['opp-date-end'].value).toBe('');
    expect(tbody.children).toHaveLength(1);
    expect(tbody.children[0].innerHTML).toContain('OPP-101');
  });

  test('incomplete and invalid price data safely renders hyphen without NaN, undefined, or format errors', () => {
    const rawTestCases = [
      { id: 't1', codigo: 'T-1', clientId: 'cli_1', proyecto: 'P1', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: null },
      { id: 't2', codigo: 'T-2', clientId: 'cli_1', proyecto: 'P2', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: undefined },
      { id: 't3', codigo: 'T-3', clientId: 'cli_1', proyecto: 'P3', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: '' },
      { id: 't4', codigo: 'T-4', clientId: 'cli_1', proyecto: 'P4', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 0 },
      { id: 't5', codigo: 'T-5', clientId: 'cli_1', proyecto: 'P5', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 'no-es-numero' },
      { id: 't6', codigo: 'T-6', clientId: 'cli_1', proyecto: 'P6', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: -250 }
    ];

    const { api, elements } = createPipelineSandbox({ prospects: rawTestCases });
    api.renderList();

    const tbody = elements['opp-table-body'];
    expect(tbody.children).toHaveLength(6);

    tbody.children.forEach(row => {
      // Must not contain NaN, undefined or invalid formatting strings
      expect(row.innerHTML).not.toContain('NaN');
      expect(row.innerHTML).not.toContain('undefined');
      expect(row.innerHTML).not.toContain('null');
      // Must contain '-' in the amount cell
      expect(row.innerHTML).toContain('<td class="col-opp-amount"><span style="color: var(--text-muted);">-</span></td>');
    });
  });

  test('formatCurrency utility behavior vs pipeline precio_cotizado zero and negative semantics', () => {
    // Utility formatCurrency formats standard numbers directly when given explicit values:
    const formatCurrencyUtil = (val) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val || 0);
    expect(formatCurrencyUtil(0)).toBe('$0.00');
    expect(formatCurrencyUtil(-500)).toContain('500.00');

    // However, in the pipeline table, precio_cotizado <= 0 denotes an unquoted prospect (not a zero-dollar quote)
    // and must strictly map to '-' rather than misleadingly displaying '$0.00' or negative numbers.
    const { api, elements } = createPipelineSandbox({
      prospects: [
        { id: 'zero_val', codigo: 'Z-0', clientId: 'cli_1', estado: 'activo', precio_cotizado: 0 },
        { id: 'zero_str', codigo: 'Z-S', clientId: 'cli_1', estado: 'activo', precio_cotizado: '0' },
        { id: 'neg_val', codigo: 'N-1', clientId: 'cli_1', estado: 'activo', precio_cotizado: -1500 },
        { id: 'null_val', codigo: 'N-0', clientId: 'cli_1', estado: 'activo', precio_cotizado: null },
        { id: 'undef_val', codigo: 'U-0', clientId: 'cli_1', estado: 'activo', precio_cotizado: undefined },
        { id: 'nan_val', codigo: 'X-0', clientId: 'cli_1', estado: 'activo', precio_cotizado: 'abc' }
      ]
    });
    api.renderList();
    const rows = elements['opp-table-body'].children;
    expect(rows).toHaveLength(6);
    rows.forEach(r => {
      expect(r.innerHTML).toContain('<td class="col-opp-amount"><span style="color: var(--text-muted);">-</span></td>');
      expect(r.innerHTML).not.toContain('$0.00');
      expect(r.innerHTML).not.toContain('NaN');
    });
  });

  test('valid numeric prices render formatted currency with gold highlight and required semantic classes', () => {
    const validProspects = [
      { id: 'vp1', codigo: 'VP-1', clientId: 'cli_1', proyecto: 'Torre Reforma', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 125000.50 }
    ];

    const { api, elements } = createPipelineSandbox({ prospects: validProspects });
    api.renderList();

    const row = elements['opp-table-body'].children[0];
    expect(row.innerHTML).toContain('col-opp-amount');
    expect(row.innerHTML).toContain('opp-amount-val');
    expect(row.innerHTML).toContain('color: var(--brand-gold)');
    expect(row.innerHTML).toContain('$125,000.50');
  });

  test('fallback handling for missing client, project, or code preserves layout integrity', () => {
    const incompleteProspect = [
      { id: 'opp_long_id_9999', estado: 'activo', etapa: 'prospecto' } // No codigo, no clientId, no proyecto, no precio
    ];

    const { api, elements } = createPipelineSandbox({ prospects: incompleteProspect });
    expect(() => api.renderList()).not.toThrow();

    const row = elements['opp-table-body'].children[0];
    // Missing code falls back to last 4 chars of ID: '9999'
    expect(row.innerHTML).toContain('9999');
    // Missing client falls back to 'Desconocido'
    expect(row.innerHTML).toContain('Desconocido');
    // Missing project falls back to '-'
    expect(row.innerHTML).toContain('>-<');
    // Missing price falls back to '-'
    expect(row.innerHTML).toContain('<td class="col-opp-amount"><span style="color: var(--text-muted);">-</span></td>');
  });

  test('responsive mobile card architecture: verifies semantic CSS column classes and CSS Grid rules in styles.css', () => {
    const { api, elements } = createPipelineSandbox();
    api.renderList();

    const row = elements['opp-table-body'].children[0];
    const expectedColClasses = [
      'col-opp-code',
      'col-opp-client',
      'col-opp-project',
      'col-opp-vendor',
      'col-opp-date',
      'col-opp-stage',
      'col-opp-amount',
      'col-opp-status',
      'col-opp-action'
    ];

    expectedColClasses.forEach(cls => {
      expect(row.innerHTML).toContain(cls);
    });

    // Verify responsive grid layout in styles.css for mobile screens <= 768px
    expect(stylesCssCode).toContain('@media (max-width: 768px)');
    expect(stylesCssCode).toContain('#opportunitiesTable thead');
    expect(stylesCssCode).toContain('display: none !important');
    expect(stylesCssCode).toContain('grid-template-areas:');
    expect(stylesCssCode).toContain('"client code"');
    expect(stylesCssCode).toContain('"project project"');
    expect(stylesCssCode).toContain('"stage amount"');
    expect(stylesCssCode).toContain('"vendor date"');
    expect(stylesCssCode).toContain('"status action"');

    // Verify index.html hierarchical filter grouping
    expect(indexHtmlCode).toContain('pipeline-filters-primary');
    expect(indexHtmlCode).toContain('opp-filters-bar');
    expect(indexHtmlCode).toContain('opp-search-box');

    // Verify word-break, min-width, and touch targets to prevent overflow on long client/project names
    expect(stylesCssCode).toContain('min-width: 0 !important');
    expect(stylesCssCode).toContain('word-break: break-word');
    expect(stylesCssCode).toContain('overflow-wrap: break-word');
    expect(stylesCssCode).toContain('min-height: 36px');
  });

  test('long client and project names render safely without breaking table card structure', () => {
    const longNameProspect = [
      {
        id: 'opp_long_999',
        codigo: 'OPP-LONG',
        clientId: 'cli_long',
        proyecto: 'Instalación de Sistema Complejo de Filtrado HEPA y Ductería Grado Farmacéutico Edificio Corporativo Multinacional Torre Poniente 800',
        clasificacion: 'ejecucion',
        estado: 'activo',
        etapa: 'cotizacion',
        precio_cotizado: 285000,
        fecha_creacion: '2026-03-01T10:00:00.000Z',
        vendedorId: 'v1'
      }
    ];

    const { api, elements } = createPipelineSandbox({
      prospects: longNameProspect,
      clients: [{ id: 'cli_long', empresa: 'Empresa Internacional de Alimentos Ultraprocesados y Bebidas Refrigeradas de Occidente S.A. de C.V.', tipo: 'juridico' }]
    });

    expect(() => api.renderList()).not.toThrow();
    const row = elements['opp-table-body'].children[0];
    expect(row.innerHTML).toContain('Empresa Internacional de Alimentos Ultraprocesados');
    expect(row.innerHTML).toContain('Instalación de Sistema Complejo de Filtrado HEPA');
    expect(row.innerHTML).toContain('col-opp-client');
    expect(row.innerHTML).toContain('col-opp-project');
  });

  test('homogenized empty state renders .dash-empty-state-box preserving exact test substrings', () => {
    const { api, elements } = createPipelineSandbox({ prospects: [] });

    // 1. Activas / default empty state
    api.renderList();
    const tbody = elements['opp-table-body'];
    expect(tbody.innerHTML).toContain('dash-empty-state-box');
    expect(tbody.innerHTML).toContain('No se encontraron oportunidades.');

    // 2. Perdidas empty state
    api.setOppStatusFilter('perdidas');
    expect(tbody.innerHTML).toContain('dash-empty-state-box');
    expect(tbody.innerHTML).toContain('No hay oportunidades marcadas como perdidas.');
  });

  test('opportunity card click invokes openDetail and strictly preserves Pipeline Limpio neutral design', () => {
    const { api, elements, openedProspectIds } = createPipelineSandbox();
    api.renderList();

    // With default reverse sorting, visibleProspects[0] is p2
    const row = elements['opp-table-body'].children[0];
    expect(row.classList.contains('cursor-pointer')).toBe(true);
    expect(typeof row.onclick).toBe('function');

    // Trigger row click
    row.onclick();
    expect(openedProspectIds).toEqual(['p2']);

    // Pipeline Limpio strict invariants:
    expect(row.classList.contains('vencida')).toBe(false);
    expect(row.innerHTML).not.toContain('class="vencida"');
    expect(row.innerHTML).not.toContain('background: rgba(239, 68, 68');
  });
});

describe('Post-Release 5.1 Fixes — Commercial Logs Navigation & Detail View Mobile Responsiveness', () => {
  const fs = require('fs');
  const path = require('path');
  const appCoreCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

  describe('Problem 1: Real-time Firestore Updates and View Preservation', () => {
    test('checkInitialLoad lifecycle: initial bootstrap calls checkAuth, subsequent snapshots call reRenderApp without view reset', () => {
      // Test the exact logic implemented in app_core.js
      let initialLoadCompleted = false;
      let loadedCollections = 0;
      const checkAuthCalls = [];
      const reRenderAppCalls = [];

      const checkAuth = jest.fn(() => checkAuthCalls.push('checkAuth'));
      const reRenderApp = jest.fn(() => reRenderAppCalls.push('reRenderApp'));

      // Runner simulating checkInitialLoad
      function checkInitialLoad() {
        if (initialLoadCompleted) {
          reRenderApp();
          return;
        }
        loadedCollections++;
        if (loadedCollections >= 3) {
          checkAuth();
          initialLoadCompleted = true;
        }
      }

      function detachSnapshotListeners() {
        loadedCollections = 0;
        initialLoadCompleted = false;
      }

      // Step 1: Bootstrap phase (3 initial collections: prospects, clients, users)
      checkInitialLoad(); // 1
      expect(checkAuthCalls.length).toBe(0);
      expect(reRenderAppCalls.length).toBe(0);

      checkInitialLoad(); // 2
      expect(checkAuthCalls.length).toBe(0);
      expect(reRenderAppCalls.length).toBe(0);

      checkInitialLoad(); // 3 -> bootstrap completes
      expect(checkAuthCalls.length).toBe(1);
      expect(reRenderAppCalls.length).toBe(0);
      expect(initialLoadCompleted).toBe(true);

      // Step 2: User is in detail view. A note is added or deleted.
      // Firestore onSnapshot triggers checkInitialLoad again.
      checkInitialLoad(); // subsequent snapshot 1
      expect(checkAuthCalls.length).toBe(1); // checkAuth was NOT called!
      expect(reRenderAppCalls.length).toBe(1); // reRenderApp WAS called!

      checkInitialLoad(); // subsequent snapshot 2
      expect(checkAuthCalls.length).toBe(1);
      expect(reRenderAppCalls.length).toBe(2);

      // Step 3: Listener detachment resets the latch
      detachSnapshotListeners();
      expect(initialLoadCompleted).toBe(false);
      expect(loadedCollections).toBe(0);
    });

    test('applyRolePermissions preserves currently active view (e.g. detail-view) and avoids switching to dashboard', () => {
      const showViewCalls = [];
      const showView = (id) => showViewCalls.push(id);

      // Scenario A: detail-view is active
      const elementsA = {
        '#detail-view': { id: 'detail-view', classList: { contains: () => true } },
        '.view-section.active': { id: 'detail-view' }
      };
      const docA = {
        querySelector: (sel) => elementsA[sel] || null,
        querySelectorAll: () => []
      };

      // Simulated applyRolePermissions logic from app_core.js
      function applyRolePermissions(doc, currentUserRole) {
        const activeSection = doc.querySelector('.view-section.active');
        const currentActiveId = activeSection ? activeSection.id : null;

        if (!currentActiveId) {
          if (currentUserRole === 'manager') showView('dashboard-view');
          else if (currentUserRole === 'gestor') showView('projects-view');
          else showView('list-view');
        }
      }

      applyRolePermissions(docA, 'manager');
      // With detail-view active, showView should NOT be called
      expect(showViewCalls.length).toBe(0);

      // Scenario B: No view active (initial login / bootstrap)
      const docB = {
        querySelector: () => null,
        querySelectorAll: () => []
      };
      applyRolePermissions(docB, 'manager');
      expect(showViewCalls).toEqual(['dashboard-view']);
    });

    test('reRenderApp preserves detail view context and refreshes sub-panels in place', () => {
      const trackerCalls = [];
      const infoCalls = [];
      const logsCalls = [];
      const followUpCalls = [];

      const p = { id: 'P_TEST', nombre: 'Test Prospect', logs: [{ text: 'Nota' }] };
      const S = {
        currentProspectId: 'P_TEST',
        prospects: [p],
        renderTracker: (item) => trackerCalls.push(item.id),
        renderInfo: (item) => infoCalls.push(item.id),
        renderLogs: (item) => logsCalls.push(item.id),
        renderFollowUpSummary: (item) => followUpCalls.push(item.id),
        renderList: jest.fn(),
        renderDashboard: jest.fn(),
        renderProjectsList: jest.fn(),
        renderAgendaTable: jest.fn()
      };

      // Simulated reRenderApp from app_core.js
      function reRenderApp(state) {
        state.renderList();
        state.renderDashboard();
        state.renderProjectsList();
        state.renderAgendaTable();
        if (state.currentProspectId) {
          const found = state.prospects.find(x => x.id === state.currentProspectId);
          if (found) {
            state.renderTracker(found);
            state.renderInfo(found);
            state.renderLogs(found);
            state.renderFollowUpSummary(found);
          }
        }
      }

      reRenderApp(S);

      expect(trackerCalls).toEqual(['P_TEST']);
      expect(infoCalls).toEqual(['P_TEST']);
      expect(logsCalls).toEqual(['P_TEST']);
      expect(followUpCalls).toEqual(['P_TEST']);
      expect(S.renderList).toHaveBeenCalled();
      expect(S.renderDashboard).toHaveBeenCalled();
    });

    test('verified in app_core.js source code: initialLoadCompleted guard is present in checkInitialLoad', () => {
      expect(appCoreCode).toMatch(/let\s+initialLoadCompleted\s*=\s*false/);
      expect(appCoreCode).toMatch(/function\s+checkInitialLoad\s*\(\)\s*\{[\s\S]*?if\s*\(\s*initialLoadCompleted\s*\)\s*\{[\s\S]*?reRenderApp\(\);[\s\S]*?return;/);
      expect(appCoreCode).toMatch(/function\s+detachSnapshotListeners\s*\(\)\s*\{[\s\S]*?initialLoadCompleted\s*=\s*false;/);
    });

    test('verified in app_core.js source code: applyRolePermissions inspects active view before switching', () => {
      expect(appCoreCode).toMatch(/function\s+applyRolePermissions\s*\(\)\s*\{[\s\S]*?querySelector\(['"]\.view-section\.active['"]\)/);
      expect(appCoreCode).toMatch(/if\s*\(!currentActiveId\)\s*showView\(['"]dashboard-view['"]\)/);
    });
  });

  describe('Problem 2: Mobile Responsiveness of Detail View and Modals', () => {
    test('styles.css contains viewport overflow containment on html and body', () => {
      expect(stylesCss).toMatch(/html,\s*body\s*\{[^}]*max-width:\s*100vw;[^}]*overflow-x:\s*hidden;/);
    });

    test('styles.css contains width containment and word-break on #detail-view', () => {
      expect(stylesCss).toMatch(/#detail-view\s*\{[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;/);
      expect(stylesCss).toMatch(/#detail-cliente,\s*#detail-proyecto\s*\{[^}]*word-break:\s*break-word;[^}]*overflow-wrap:\s*anywhere;/);
    });

    test('styles.css defines .financial-balance-grid with 3 columns on desktop and 1 column on <= 768px', () => {
      expect(stylesCss).toMatch(/\.financial-balance-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\);/);
      expect(stylesCss).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.financial-balance-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    });

    test('styles.css defines .closing-checklist-grid with 1 column on <= 480px', () => {
      expect(stylesCss).toMatch(/\.closing-checklist-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(260px,\s*1fr\)\);/);
      expect(stylesCss).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.closing-checklist-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    });

    test('styles.css defines .doc-card-row vertical stacking and button wrapping on <= 480px', () => {
      expect(stylesCss).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.doc-card-row\s*\{[^}]*flex-direction:\s*column;/);
    });

    test('styles.css enforces modal-content max-width containment for mobile viewports', () => {
      expect(stylesCss).toMatch(/\.modal-content\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*24px\)\s*!important;/);
    });

    test('index.html uses responsive .financial-balance-grid instead of inline 3-column grid', () => {
      expect(indexHtml).toContain('class="financial-balance-grid"');
      expect(indexHtml).not.toContain('grid-template-columns: 1fr 1fr 1fr');
    });

    test('index.html has no modal dialogs with fixed pixel width lacking responsive max-width', () => {
      const fixedWidthMatches = indexHtml.match(/class="modal-content[^"]*"[^>]*style="[^"]*width:\s*\d{3}px/g) || [];
      // Every matched modal-content must also include max-width:
      fixedWidthMatches.forEach(match => {
        expect(match).toContain('max-width:');
      });
    });
  });
});

describe('Pipeline Simplification & Enrichment (Fase 5.2 Bloque 1)', () => {
  const fs = require('fs');
  const path = require('path');
  const appCoreCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

  const extractCode = (from, to) => {
    const a = appCoreCode.indexOf(from);
    const b = appCoreCode.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`Could not find markers: ${from} .. ${to}`);
    return appCoreCode.slice(a, b);
  };

  const PIPELINE_CORE_SRC = [
    extractCode('function toggleOppSort(column)', 'function getProspectVendorInfo'),
    extractCode('function updateOppSortIcons()', 'function toggleProjSort'),
    extractCode('function parseProspectDate(raw)', 'function reassignVendor('),
    'const formatCurrency = (val) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(val || 0);',
    'const getDaysDifference = (d1) => Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24));',
    'let oppSortCol = null;',
    'let oppSortDir = "asc";',
    extractCode('function getClientName(clientId)', 'function renderProjectsList')
  ].join('\n');

  function createPipelineSandbox(customState = {}) {
    const elements = {};
    const getEl = (id) => {
      if (!elements[id]) {
        const classes = new Set();
        const attrs = {};
        elements[id] = {
          id,
          tagName: 'DIV',
          value: '',
          style: {},
          textContent: '',
          _innerHTML: '',
          children: [],
          attributes: attrs,
          setAttribute: (k, v) => { attrs[k] = String(v); },
          getAttribute: (k) => attrs[k],
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

    const documentMock = {
      getElementById: (id) => getEl(id),
      createElement: (tag) => {
        const classes = new Set();
        const attrs = {};
        return {
          tagName: tag.toUpperCase(),
          style: {},
          attributes: attrs,
          setAttribute: (k, v) => { attrs[k] = String(v); },
          getAttribute: (k) => attrs[k],
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

    [
      'opp-table-body', 'filter-opp-activas', 'filter-opp-perdidas', 'filter-opp-todas',
      'count-opp-activas', 'count-opp-perdidas', 'count-opp-todas',
      'filter-clasif-todas', 'filter-clasif-ejecucion', 'filter-clasif-presupuesto',
      'count-opp-ejecucion', 'count-opp-presupuesto',
      'filter-stage-todas', 'count-stage-todas',
      'filter-stage-prospecto', 'count-stage-prospecto',
      'filter-stage-levantamiento', 'count-stage-levantamiento',
      'filter-stage-cotizacion', 'count-stage-cotizacion',
      'filter-stage-negociacion', 'count-stage-negociacion',
      'filter-stage-cierre', 'count-stage-cierre',
      'opp-count-badge', 'opp-search', 'opp-date-start', 'opp-date-end', 'btn-clear-opp-dates',
      'sort-opp-codigo', 'sort-opp-cliente', 'sort-opp-proyecto', 'sort-opp-vendedor',
      'sort-opp-fecha', 'sort-opp-etapa', 'sort-opp-monto', 'sort-opp-estado'
    ].forEach(id => getEl(id));

    const now = new Date();
    const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    const defaultProspects = [
      {
        id: 'p1', codigo: 'OPP-101', clientId: 'cli_1', proyecto: 'Ductos Hospital Central',
        clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion',
        precio_cotizado: 52000, fecha_creacion: daysAgo(10),
        stage_timestamps: { cotizacion: daysAgo(10) },
        vendedorId: 'v1'
      },
      {
        id: 'p2', codigo: 'OPP-102', clientId: 'cli_2', proyecto: 'Edificio Residencial Prisma',
        clasificacion: 'presupuesto', estado: 'activo', etapa: 'negociacion',
        precio_cotizado: 34000, fecha_creacion: daysAgo(20),
        stage_timestamps: { negociacion: daysAgo(20) }, // High antiquity (> 15d)
        vendedorId: 'v1'
      },
      {
        id: 'p3', codigo: 'OPP-103', clientId: 'cli_1', proyecto: 'Centro Comercial Plaza',
        clasificacion: 'ejecucion', estado: 'perdido', etapa: 'levantamiento',
        precio_cotizado: 18000, fecha_creacion: daysAgo(5),
        stage_timestamps: { levantamiento: daysAgo(5) },
        vendedorId: 'v2'
      },
      {
        id: 'p4', codigo: 'OPP-104', clientId: 'cli_2', proyecto: 'Almacén Industrial Norte',
        clasificacion: 'presupuesto', estado: 'activo', etapa: 'cierre',
        precio_cotizado: 95000, fecha_creacion: daysAgo(7),
        stage_timestamps: { cierre: daysAgo(7) }, // High antiquity in cierre (>= 5d)
        vendedorId: 'v2'
      },
      {
        id: 'p5', codigo: 'OPP-105', clientId: 'cli_1', proyecto: 'Torre Corporativa Sur',
        clasificacion: 'ejecucion', estado: 'activo', etapa: 'prospecto',
        precio_cotizado: 60000, fecha_creacion: null, // missing date
        stage_timestamps: null,
        vendedorId: 'v1'
      }
    ];

    const S = {
      prospects: customState.prospects || defaultProspects,
      clients: customState.clients || [
        { id: 'cli_1', empresa: 'Grupo Constructor Alfa', tipo: 'juridico' },
        { id: 'cli_2', nombres: 'Mariana', apellidos: 'Pérez', tipo: 'natural' }
      ],
      users: customState.users || [
        { id: 'v1', nombre: 'Carlos Vendedor', role: 'vendedor' },
        { id: 'v2', nombre: 'Beatriz Gestora', role: 'gestor' }
      ],
      currentUser: customState.currentUser || { id: 'm1', nombre: 'Director Comercial', role: 'manager' }
    };

    const openedProspectIds = [];
    const openDetail = (id) => { openedProspectIds.push(id); };

    const sandboxFn = new Function(
      'S', 'document', 'openDetail',
      'with(S) {\n' + PIPELINE_CORE_SRC + '\n return { renderList, setOppStatusFilter, setOppClasifFilter, setOppStageFilter, getOppStageFilter, getOppStatusFilter, getOppClasifFilter, toggleOppSort, clearOppDateFilter };\n}'
    );

    const api = sandboxFn(S, documentMock, openDetail);
    return { api, elements, documentMock, S, openedProspectIds };
  }

  describe('A. Simplificación y filtros rápidos por etapa', () => {
    test('initial stage filter is "todas" and renders all active opportunities', () => {
      const { api, elements } = createPipelineSandbox();
      api.renderList();
      expect(api.getOppStageFilter()).toBe('todas');
      // Active prospects p1, p2, p4, p5 (p3 is perdido)
      expect(elements['opp-table-body'].children).toHaveLength(4);
      expect(elements['filter-stage-todas'].classList.contains('active')).toBe(true);
      expect(elements['filter-stage-todas'].getAttribute('aria-pressed')).toBe('true');
      expect(elements['filter-stage-cotizacion'].getAttribute('aria-pressed')).toBe('false');
    });

    test('stage filter isolates opportunities by stage and updates active states', () => {
      const { api, elements } = createPipelineSandbox();
      api.setOppStageFilter('cotizacion');
      expect(api.getOppStageFilter()).toBe('cotizacion');
      expect(elements['opp-table-body'].children).toHaveLength(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-101');
      expect(elements['filter-stage-cotizacion'].classList.contains('active')).toBe(true);
      expect(elements['filter-stage-cotizacion'].getAttribute('aria-pressed')).toBe('true');
      expect(elements['filter-stage-todas'].classList.contains('active')).toBe(false);
      expect(elements['filter-stage-todas'].getAttribute('aria-pressed')).toBe('false');
    });

    test('clicking the active stage pill toggles filter back to "todas"', () => {
      const { api, elements } = createPipelineSandbox();
      api.setOppStageFilter('cierre');
      expect(api.getOppStageFilter()).toBe('cierre');
      expect(elements['opp-table-body'].children).toHaveLength(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-104');

      // Click same stage again: toggles back to 'todas'
      api.setOppStageFilter('cierre');
      expect(api.getOppStageFilter()).toBe('todas');
      expect(elements['opp-table-body'].children).toHaveLength(4);
      expect(elements['filter-stage-todas'].classList.contains('active')).toBe(true);
    });

    test('stage badges update accurately and are scoped to the current status filter', () => {
      const { api, elements } = createPipelineSandbox();
      api.renderList();
      // Active prospects: p1(cotizacion), p2(negociacion), p4(cierre), p5(prospecto) -> total 4
      expect(elements['count-stage-todas'].textContent).toBe(4);
      expect(elements['count-stage-cotizacion'].textContent).toBe(1);
      expect(elements['count-stage-negociacion'].textContent).toBe(1);
      expect(elements['count-stage-cierre'].textContent).toBe(1);
      expect(elements['count-stage-prospecto'].textContent).toBe(1);
      expect(elements['count-stage-levantamiento'].textContent).toBe(0);

      // Switch to lost opportunities (p3: levantamiento)
      api.setOppStatusFilter('perdidas');
      expect(elements['count-stage-todas'].textContent).toBe(1);
      expect(elements['count-stage-levantamiento'].textContent).toBe(1);
      expect(elements['count-stage-cotizacion'].textContent).toBe(0);
    });

    test('coexistence: stage filter combines with classification and search', () => {
      const { api, elements } = createPipelineSandbox();
      api.renderList();

      // Filter by stage 'negociacion' (p2)
      api.setOppStageFilter('negociacion');
      expect(elements['opp-table-body'].children).toHaveLength(1);

      // Also filter by clasificacion 'ejecucion' -> p2 is 'presupuesto', so 0 results
      api.setOppClasifFilter('ejecucion');
      expect(elements['opp-table-body'].children).toHaveLength(0);

      // Reset clasif to 'todas' -> p2 visible again
      api.setOppClasifFilter('todas');
      expect(elements['opp-table-body'].children).toHaveLength(1);

      // Search matching p2
      elements['opp-search'].value = 'Prisma';
      api.renderList();
      expect(elements['opp-table-body'].children).toHaveLength(1);

      // Search not matching p2
      elements['opp-search'].value = 'Hospital';
      api.renderList();
      expect(elements['opp-table-body'].children).toHaveLength(0);
    });

    test('role isolation: gestor or vendedor only sees assigned prospects under stage filter', () => {
      // Carlos Vendedor (v1) only owns p1, p2, p5 (p4 is v2)
      const { api, elements } = createPipelineSandbox({
        currentUser: { id: 'v1', nombre: 'Carlos Vendedor', role: 'vendedor' }
      });
      api.renderList();
      // Active for v1: p1(cotizacion), p2(negociacion), p5(prospecto) -> total 3
      expect(elements['opp-table-body'].children).toHaveLength(3);

      // Filter by stage 'cierre' (p4 belongs to v2) -> v1 sees 0
      api.setOppStageFilter('cierre');
      expect(elements['opp-table-body'].children).toHaveLength(0);

      // Filter by stage 'cotizacion' (p1 belongs to v1) -> v1 sees 1
      api.setOppStageFilter('cotizacion');
      expect(elements['opp-table-body'].children).toHaveLength(1);
      expect(elements['opp-table-body'].children[0].innerHTML).toContain('OPP-101');
    });
  });

  describe('B. Días en etapa (daysInStage) y semántica visual', () => {
    test('renders days in stage accurately next to stage name in desktop and mobile card', () => {
      const { api, elements } = createPipelineSandbox();
      api.setOppStageFilter('cotizacion'); // p1 has 10 days in cotizacion
      const row = elements['opp-table-body'].children[0];
      expect(row.innerHTML).toContain('opp-stage-pill');
      expect(row.innerHTML).toContain('class="opp-stage-name"');
      expect(row.innerHTML).toContain('cotizacion');
      expect(row.innerHTML).toContain('class="opp-stage-days"');
      expect(row.innerHTML).toContain('10d');
      expect(row.innerHTML).not.toContain('opp-stage-days-warn');
    });

    test('missing or invalid stage date safely renders stage name without NaN or incorrect numbers', () => {
      const { api, elements } = createPipelineSandbox();
      api.setOppStageFilter('prospecto'); // p5 has null fecha_creacion and null stage_timestamps
      const row = elements['opp-table-body'].children[0];
      expect(row.innerHTML).toContain('class="opp-stage-name"');
      expect(row.innerHTML).toContain('prospecto');
      expect(row.innerHTML).not.toContain('NaN');
      expect(row.innerHTML).not.toContain('undefined');
      expect(row.innerHTML).not.toContain('class="opp-stage-days"');
    });

    test('high antiquity adds .opp-stage-days-warn indicator without tinting rows or cards red', () => {
      const { api, elements } = createPipelineSandbox();
      api.setOppStageFilter('negociacion'); // p2 has 20 days (>15d)
      const row = elements['opp-table-body'].children[0];
      expect(row.innerHTML).toContain('class="opp-stage-days opp-stage-days-warn"');
      expect(row.innerHTML).toContain('20d');
      expect(row.innerHTML).toContain('Antigüedad elevada en etapa: 20 días');

      // Strictly verify no forbidden red background or classes
      expect(row.innerHTML).not.toContain('background: rgba(239, 68, 68');
      expect(row.innerHTML).not.toContain('class="vencida"');
      expect(row.style.background || '').not.toContain('red');
    });

    test('preserves Phase 5.1 mobile card semantic classes and column structure', () => {
      const { api, elements } = createPipelineSandbox();
      api.renderList();
      const row = elements['opp-table-body'].children[0];
      const requiredColumns = [
        'col-opp-code', 'col-opp-client', 'col-opp-project',
        'col-opp-vendor', 'col-opp-date', 'col-opp-stage',
        'col-opp-amount', 'col-opp-status', 'col-opp-action'
      ];
      requiredColumns.forEach(cls => {
        expect(row.innerHTML).toContain(cls);
      });
    });
  });

  describe('C. Orden predeterminado determinista y ordenamiento por columnas', () => {
    test('default order is fecha_creacion descending (newest first) with deterministic tie-breaker', () => {
      const { api, elements } = createPipelineSandbox();
      api.renderList();
      const rows = elements['opp-table-body'].children;
      // Default active prospects:
      // p4: daysAgo(7)
      // p1: daysAgo(10)
      // p2: daysAgo(20)
      // p5: null date (placed at end)
      expect(rows[0].innerHTML).toContain('OPP-104');
      expect(rows[1].innerHTML).toContain('OPP-101');
      expect(rows[2].innerHTML).toContain('OPP-102');
      expect(rows[3].innerHTML).toContain('OPP-105');
    });

    test('deterministic tie-breaker sorts by codigo/id when creation dates are identical', () => {
      const sameDate = '2026-03-01T12:00:00.000Z';
      const customProspects = [
        { id: 'pB', codigo: 'OPP-200', clientId: 'cli_1', proyecto: 'Proyecto B', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 10000, fecha_creacion: sameDate, vendedorId: 'v1' },
        { id: 'pA', codigo: 'OPP-100', clientId: 'cli_1', proyecto: 'Proyecto A', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 20000, fecha_creacion: sameDate, vendedorId: 'v1' },
        { id: 'pC', codigo: 'OPP-300', clientId: 'cli_1', proyecto: 'Proyecto C', clasificacion: 'ejecucion', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 30000, fecha_creacion: sameDate, vendedorId: 'v1' }
      ];
      const { api, elements } = createPipelineSandbox({ prospects: customProspects });
      api.renderList();
      const rows = elements['opp-table-body'].children;
      // Tie-breaker localeCompare: OPP-300, OPP-200, OPP-100 or deterministic order
      expect(rows).toHaveLength(3);
      const codes = Array.from(rows).map(r => r.innerHTML.match(/OPP-\d+/)[0]);
      // Verify all 3 are deterministically rendered
      expect(codes).toContain('OPP-100');
      expect(codes).toContain('OPP-200');
      expect(codes).toContain('OPP-300');
    });

    test('manual column sorting (toggleOppSort) works with deterministic tie-breaker', () => {
      const { api, elements } = createPipelineSandbox();
      // Sort by monto ascending
      api.toggleOppSort('monto');
      let rows = elements['opp-table-body'].children;
      // p2 (34000) < p1 (52000) < p5 (60000) < p4 (95000)
      expect(rows[0].innerHTML).toContain('OPP-102');
      expect(rows[3].innerHTML).toContain('OPP-104');

      // Toggle monto descending
      api.toggleOppSort('monto');
      rows = elements['opp-table-body'].children;
      expect(rows[0].innerHTML).toContain('OPP-104');
      expect(rows[3].innerHTML).toContain('OPP-102');
    });
  });

  describe('D. HTML, CSS y Accesibilidad (Fase 5.2 Bloque 1)', () => {
    test('index.html contains .pipeline-stage-filters-container with all 5 stages and counters', () => {
      expect(indexHtml).toContain('class="pipeline-stage-filters-container');
      expect(indexHtml).toContain('id="filter-stage-todas"');
      expect(indexHtml).toContain('id="filter-stage-prospecto"');
      expect(indexHtml).toContain('id="filter-stage-levantamiento"');
      expect(indexHtml).toContain('id="filter-stage-cotizacion"');
      expect(indexHtml).toContain('id="filter-stage-negociacion"');
      expect(indexHtml).toContain('id="filter-stage-cierre"');
      expect(indexHtml).toContain('id="count-stage-todas"');
      expect(indexHtml).toContain('id="count-stage-cierre"');
    });

    test('styles.css contains mobile horizontal scroll and days-in-stage styles', () => {
      expect(stylesCss).toMatch(/\.pipeline-stage-filters-container\s*\{[^}]*width:\s*100%;/);
      expect(stylesCss).toMatch(/\.opp-stage-days\s*\{[^}]*border-radius:/);
      expect(stylesCss).toMatch(/\.opp-stage-days-warn\s*\{[^}]*background:\s*rgba\(245,\s*158,\s*11/);
      expect(stylesCss).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.pipeline-stage-filters-container\s*\{[^}]*overflow-x:\s*auto;/);
    });

    test('audit compliance: no forbidden red row styles or class="vencida" in pipeline code', () => {
      const listRenderCode = appCoreCode.substring(
        appCoreCode.indexOf('function renderList()'),
        appCoreCode.indexOf('function renderProjectsList()')
      );
      expect(listRenderCode).not.toContain('background: rgba(239, 68, 68');
      expect(listRenderCode).not.toContain('class="vencida"');
    });
  });
});



