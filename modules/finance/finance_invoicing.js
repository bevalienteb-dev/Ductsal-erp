// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: INVOICING (Fase 6.4)
// Archivo: modules/finance/finance_invoicing.js
// Responsabilidades:
// 1. Apertura y preparación del formulario de emisión y edición de facturas (#invoice-form).
// 2. Procesamiento, subida de factura PDF a Storage y guardado vía CrmCommercial.saveInvoice.
// 3. Regla crítica de anticipo: la primera factura (anticipo) no puede eliminarse.
// 4. Eliminación de facturas y su historial en cascada vía CrmCommercial.deleteInvoice.
// 5. Adaptación visual de etiquetas según exención de exportación (0% IVA).
// 6. Aplicación de control de acceso por rol (vendedor en modo solo lectura).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceInvoicing = api;
        if (typeof window !== 'undefined') {
            window.FinanceInvoicing = api;
            window.showInvoiceForm = api.showInvoiceForm;
            window.editInvoice = api.editInvoice;
            window.processInvoice = api.processInvoice;
            window.deleteInvoice = api.deleteInvoice;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined') return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getCurrentProspectId: () => {
            if (typeof currentProspectId !== 'undefined') return currentProspectId;
            if (typeof window !== 'undefined' && window.currentProspectId) return window.currentProspectId;
            return null;
        },
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        uploadFileToStorage: async (...args) => {
            if (typeof uploadFileToStorage === 'function') return await uploadFileToStorage(...args);
            if (typeof window !== 'undefined' && typeof window.uploadFileToStorage === 'function') return await window.uploadFileToStorage(...args);
            throw new Error('uploadFileToStorage no disponible');
        },
        runWorkflowOp: async (...args) => {
            if (typeof runWorkflowOp === 'function') return await runWorkflowOp(...args);
            if (typeof window !== 'undefined' && typeof window.runWorkflowOp === 'function') return await window.runWorkflowOp(...args);
            throw new Error('runWorkflowOp no disponible');
        }
    };

    /**
     * Muestra el formulario para emitir una nueva factura.
     * Bloquea a los usuarios con rol vendedor.
     */
    function showInvoiceForm() {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof document === 'undefined') return;

        const invForm = document.getElementById('invoice-form');
        const payForm = document.getElementById('payment-form');
        const btnAdd = document.getElementById('btn-add-invoice');
        if (invForm) invForm.style.display = 'block';
        if (payForm) payForm.style.display = 'none';
        if (btnAdd) btnAdd.style.display = 'none';

        const setVal = (elemId, val) => {
            const el = document.getElementById(elemId);
            if (el) el.value = val;
        };
        setVal('inv-id-edit', '');
        setVal('inv-numero', '');
        setVal('inv-monto', '');
        setVal('inv-file', '');

        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const clientList = _deps.getClients();
        const p = prospectList.find(x => x && x.id === pid);
        const client = p ? clientList.find(c => c && c.id === p.clientId) : null;
        const isExport = !!(client && (client.es_exportacion === true || client.es_exportacion === 'true'));

        const lbl = document.getElementById('inv-monto-label');
        if (lbl) {
            lbl.textContent = isExport ? 'Monto a Facturar (Sin IVA - Exportación)' : 'Monto a Facturar (CON IVA)';
        }
    }

    /**
     * Carga los datos de una factura existente en el formulario para edición.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} id - Identificador de la factura
     */
    function editInvoice(id) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.facturas)) return;
        const f = p.facturas.find(x => x && x.id === id);
        if (!f) return;

        if (typeof document === 'undefined') return;
        const invForm = document.getElementById('invoice-form');
        const payForm = document.getElementById('payment-form');
        const btnAdd = document.getElementById('btn-add-invoice');
        if (invForm) invForm.style.display = 'block';
        if (payForm) payForm.style.display = 'none';
        if (btnAdd) btnAdd.style.display = 'none';

        const setVal = (elemId, val) => {
            const el = document.getElementById(elemId);
            if (el) el.value = (val !== null && typeof val !== 'undefined') ? val : '';
        };
        setVal('inv-id-edit', f.id);
        setVal('inv-numero', f.numero);
        setVal('inv-monto', f.monto);

        const clientList = _deps.getClients();
        const client = clientList.find(c => c && c.id === p.clientId);
        const isExport = !!(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
        const lbl = document.getElementById('inv-monto-label');
        if (lbl) {
            lbl.textContent = isExport ? 'Monto a Facturar (Sin IVA - Exportación)' : 'Monto a Facturar (CON IVA)';
        }
    }

    /**
     * Procesa el formulario de factura, sube el PDF a Storage y ejecuta
     * CrmCommercial.saveInvoice con tope transaccional contra el saldo del contrato.
     * @param {Event} [e] - Evento submit
     */
    async function processInvoice(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p) return;

        if (typeof document === 'undefined') return;
        const editId = document.getElementById('inv-id-edit') ? document.getElementById('inv-id-edit').value : '';
        const n = document.getElementById('inv-numero') ? document.getElementById('inv-numero').value.trim() : '';
        const m = parseFloat(document.getElementById('inv-monto') ? document.getElementById('inv-monto').value : 0);
        const fileEl = document.getElementById('inv-file');

        if (!n) return alert("Ingrese un número de factura.");
        if (isNaN(m) || m <= 0) return alert("Ingrese un monto válido mayor a cero.");
        if (!editId && (!fileEl || !fileEl.files || fileEl.files.length === 0)) {
            return alert("Debe adjuntar la copia de la factura.");
        }

        const dbSuffix = _deps.getDbSuffix();
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);

        const res = await _deps.runWorkflowOp('Subiendo factura a la nube...', async fb => {
            const doc = (fileEl && fileEl.files && fileEl.files.length > 0)
                ? await _deps.uploadFileToStorage(fileEl.files[0], 'facturas', { prospectId: p.id })
                : null;
            return CrmCommercial.saveInvoice(fb, {
                prospectId: p.id,
                invoiceId: editId || undefined,
                numero: n,
                monto: m,
                doc_factura: doc || undefined,
                dbSuffix
            });
        });

        if (res) {
            const invForm = document.getElementById('invoice-form');
            if (invForm) invForm.style.display = 'none';
        }
    }

    /**
     * Elimina una factura tras confirmación.
     * Enforza la regla crítica de negocio: la factura de anticipo (la primera) no puede eliminarse.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} id - Identificador de la factura a eliminar
     */
    async function deleteInvoice(id) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof confirm === 'function' && !confirm("¿Estás seguro de eliminar esta factura? Todo su historial de pagos se borrará también.")) return;
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.facturas)) return;
        const idx = p.facturas.findIndex(f => f && f.id === id);
        if (idx === -1) return;
        if (idx === 0) {
            alert("Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error.");
            return;
        }

        const dbSuffix = _deps.getDbSuffix();

        await _deps.runWorkflowOp('Eliminando factura...', fb =>
            CrmCommercial.deleteInvoice(fb, { prospectId: p.id, invoiceId: id, dbSuffix })
        );
    }

    function setDeps(deps) {
        if (deps && typeof deps === 'object') {
            Object.assign(_deps, deps);
        }
    }

    // -------------------------------------------------------------------------
    // API Pública
    // -------------------------------------------------------------------------
    return {
        _deps,
        setDeps,
        showInvoiceForm,
        editInvoice,
        processInvoice,
        deleteInvoice
    };
});
