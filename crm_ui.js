// crm_ui.js
// Ductsal ERP UI feedback engine: notifications (toasts) and accessible confirmation dialogs.
// Replaces native alert() and confirm() with themed, accessible, responsive components.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof root !== 'undefined') {
        root.CrmUI = api;
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    const DEDUPE_WINDOW_MS = 2000;
    const DEFAULT_DURATIONS = {
        success: 4500,
        info: 5000,
        warning: 6500,
        error: 7000
    };

    // Tracks recently dispatched toasts to avoid repetitive duplicates
    const recentMessages = new Map(); // key -> timestamp
    const activeToasts = new Set();

    let toastContainer = null;
    let activeConfirmDialog = null;

    function getDoc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function ensureToastContainer() {
        const doc = getDoc();
        if (!doc) return null;
        if (!toastContainer || !doc.body.contains(toastContainer)) {
            toastContainer = doc.getElementById('crm-toast-container');
            if (!toastContainer) {
                toastContainer = doc.createElement('div');
                toastContainer.id = 'crm-toast-container';
                toastContainer.className = 'crm-toast-container';
                toastContainer.setAttribute('aria-live', 'polite');
                toastContainer.setAttribute('aria-atomic', 'false');
                doc.body.appendChild(toastContainer);
            }
        }
        return toastContainer;
    }

    function isDuplicate(type, message) {
        const now = Date.now();
        const key = `${type}:${String(message).trim()}`;
        const lastTime = recentMessages.get(key);
        if (lastTime && (now - lastTime) < DEDUPE_WINDOW_MS) {
            return true;
        }
        recentMessages.set(key, now);
        // Clean up old entries
        if (recentMessages.size > 50) {
            for (const [k, time] of recentMessages.entries()) {
                if (now - time > 10000) recentMessages.delete(k);
            }
        }
        return false;
    }

    function notify(type, message, options = {}) {
        if (!message) return null;
        const msgText = String(message).trim();
        if (!msgText) return null;

        if (!options.allowDuplicate && isDuplicate(type, msgText)) {
            return null;
        }

        const doc = getDoc();
        if (!doc) {
            const logFn = type === 'error' ? console.error : (type === 'warning' ? console.warn : console.log);
            logFn(`[CrmUI ${type.toUpperCase()}]`, msgText);
            return null;
        }

        const container = ensureToastContainer();
        if (!container) return null;

        const toastId = 'crm-toast-' + Math.random().toString(36).substr(2, 9);
        const duration = options.duration !== undefined ? options.duration : (DEFAULT_DURATIONS[type] || 5000);

        const toast = doc.createElement('div');
        toast.id = toastId;
        toast.className = `crm-toast crm-toast-${type}`;
        toast.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');

        const icons = {
            success: '✓',
            info: 'ℹ',
            warning: '⚠',
            error: '✕'
        };
        const iconChar = icons[type] || '•';

        const iconEl = doc.createElement('div');
        iconEl.className = 'crm-toast-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = iconChar;

        const bodyEl = doc.createElement('div');
        bodyEl.className = 'crm-toast-body';

        if (options.title) {
            const titleEl = doc.createElement('div');
            titleEl.className = 'crm-toast-title';
            titleEl.textContent = String(options.title);
            bodyEl.appendChild(titleEl);
        }

        const messageEl = doc.createElement('div');
        messageEl.className = 'crm-toast-message';
        messageEl.textContent = msgText;
        bodyEl.appendChild(messageEl);

        const closeBtn = doc.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'crm-toast-close';
        closeBtn.setAttribute('aria-label', 'Cerrar notificación');
        closeBtn.textContent = '×';

        toast.appendChild(iconEl);
        toast.appendChild(bodyEl);
        toast.appendChild(closeBtn);

        let timer = null;
        let remaining = duration;
        let startTime = Date.now();

        const toastRecord = {
            id: toastId,
            cancelTimer: () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            },
            dismiss
        };

        function dismiss() {
            toastRecord.cancelTimer();
            activeToasts.delete(toastRecord);
            toast.classList.add('crm-toast-leaving');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 250);
        }

        function startTimer() {
            if (duration > 0) {
                startTime = Date.now();
                timer = setTimeout(dismiss, remaining);
            }
        }

        function pauseTimer() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                remaining -= (Date.now() - startTime);
                if (remaining < 1000) remaining = 1000;
            }
        }

        toast.addEventListener('mouseenter', pauseTimer);
        toast.addEventListener('mouseleave', startTimer);

        closeBtn.addEventListener('click', (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            dismiss();
        });

        container.appendChild(toast);
        activeToasts.add(toastRecord);
        startTimer();

        return toastRecord;
    }

    function confirm(options) {
        return new Promise((resolve) => {
            const doc = getDoc();
            if (!doc) {
                const globalRoot = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
                if (globalRoot && typeof globalRoot.confirm === 'function') {
                    const msg = typeof options === 'string' ? options : (options && options.message);
                    return resolve(globalRoot.confirm(msg));
                }
                return resolve(false);
            }

            // Capture previously focused element to restore upon dialog close (WAI-ARIA modal guideline)
            const previouslyFocused = (doc && typeof doc.activeElement !== 'undefined') ? doc.activeElement : null;

            // Close any existing confirm dialog before opening a new one
            if (activeConfirmDialog && typeof activeConfirmDialog.dismiss === 'function') {
                activeConfirmDialog.dismiss(false);
            }

            const opts = typeof options === 'string' ? { message: options } : (options || {});
            const title = opts.title || 'Confirmación';
            const message = opts.message || '¿Deseas continuar?';
            const confirmText = opts.confirmText || 'Aceptar';
            const cancelText = opts.cancelText || 'Cancelar';
            const isDanger = opts.danger === true || opts.type === 'danger';
            const type = opts.type || (isDanger ? 'warning' : 'info');

            const overlay = doc.createElement('div');
            overlay.className = 'crm-confirm-overlay modal active';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'crm-confirm-title');

            const icons = {
                success: '✓',
                info: 'ℹ',
                warning: '⚠',
                danger: '⚠',
                error: '✕'
            };
            const iconChar = icons[type] || 'ℹ';
            const confirmBtnClass = isDanger ? 'btn-danger' : 'btn-primary';

            const card = doc.createElement('div');
            card.className = 'crm-confirm-card modal-content';
            card.setAttribute('role', 'document');

            const header = doc.createElement('div');
            header.className = 'crm-confirm-header';

            const iconBadge = doc.createElement('div');
            iconBadge.className = `crm-confirm-icon-badge crm-confirm-icon-${type}`;
            iconBadge.setAttribute('aria-hidden', 'true');
            iconBadge.textContent = iconChar;

            const titleEl = doc.createElement('h3');
            titleEl.id = 'crm-confirm-title';
            titleEl.textContent = title;

            header.appendChild(iconBadge);
            header.appendChild(titleEl);

            const bodyEl = doc.createElement('div');
            bodyEl.className = 'crm-confirm-body';
            bodyEl.textContent = message;

            const footer = doc.createElement('div');
            footer.className = 'crm-confirm-footer';

            const cancelBtn = doc.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary crm-confirm-cancel-btn';
            cancelBtn.textContent = cancelText;

            const actionBtn = doc.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = `btn ${confirmBtnClass} crm-confirm-action-btn`;
            actionBtn.textContent = confirmText;

            footer.appendChild(cancelBtn);
            footer.appendChild(actionBtn);

            card.appendChild(header);
            card.appendChild(bodyEl);
            card.appendChild(footer);
            overlay.appendChild(card);

            let resolved = false;
            function finish(result) {
                if (resolved) return;
                resolved = true;
                doc.body.classList.remove('modal-open');
                doc.removeEventListener('keydown', handleKeyDown, true);
                if (overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                activeConfirmDialog = null;
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                    try {
                        previouslyFocused.focus();
                    } catch (_e) {
                        // Element may have been unmounted
                    }
                }
                resolve(result);
            }

            function handleKeyDown(e) {
                if (e.key === 'Escape') {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    finish(false);
                } else if (e.key === 'Tab') {
                    const focusables = [cancelBtn, actionBtn];
                    const first = focusables[0];
                    const last = focusables[focusables.length - 1];
                    if (e.shiftKey && doc.activeElement === first) {
                        if (typeof e.preventDefault === 'function') e.preventDefault();
                        if (typeof last.focus === 'function') last.focus();
                    } else if (!e.shiftKey && doc.activeElement === last) {
                        if (typeof e.preventDefault === 'function') e.preventDefault();
                        if (typeof first.focus === 'function') first.focus();
                    }
                }
            }

            cancelBtn.addEventListener('click', () => finish(false));
            actionBtn.addEventListener('click', () => finish(true));

            overlay.addEventListener('click', (e) => {
                if (e && e.target === overlay) {
                    finish(false);
                }
            });

            doc.body.classList.add('modal-open');
            doc.addEventListener('keydown', handleKeyDown, true);
            doc.body.appendChild(overlay);

            if (isDanger) {
                if (typeof cancelBtn.focus === 'function') cancelBtn.focus();
            } else {
                if (typeof actionBtn.focus === 'function') actionBtn.focus();
            }

            activeConfirmDialog = { dismiss: finish };
        });
    }

    function clearAll() {
        for (const t of activeToasts) {
            t.cancelTimer();
        }
        activeToasts.clear();

        const doc = getDoc();
        if (doc && toastContainer) {
            toastContainer.textContent = '';
            while (toastContainer.children && toastContainer.children.length > 0) {
                toastContainer.removeChild(toastContainer.children[0]);
            }
        }
        recentMessages.clear();

        if (activeConfirmDialog && typeof activeConfirmDialog.dismiss === 'function') {
            activeConfirmDialog.dismiss(false);
        }
    }

    return {
        notify,
        success: (msg, opts) => notify('success', msg, opts),
        info: (msg, opts) => notify('info', msg, opts),
        warning: (msg, opts) => notify('warning', msg, opts),
        error: (msg, opts) => notify('error', msg, opts),
        confirm,
        clearAll,
        _recentMessages: recentMessages
    };
});
