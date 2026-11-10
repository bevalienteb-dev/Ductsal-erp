// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: PAYMENTS & COLLECTIONS (Fase 6.4)
// Archivo: modules/finance/finance_payments.js
// Responsabilidades:
// 1. Apertura y preparación del formulario de abonos / pagos (#payment-form).
// 2. Cálculo dinámico de Retención 1% para Grandes Contribuyentes salvadoreños.
// 3. Procesamiento, subida de comprobante a Storage y guardado vía CrmCommercial.savePayment.
// 4. Edición y eliminación de abonos direccionados por paymentKey (id o fecha canónica).
// 5. Aplicación de control de acceso por rol (vendedor en modo solo lectura).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinancePayments = api;
        if (typeof window !== 'undefined') {
            window.FinancePayments = api;
            window.showPaymentForm = api.showPaymentForm;
            window.handlePaymentMethodChange = api.handlePaymentMethodChange;
            window.editPayment = api.editPayment;
            window.processPayment = api.processPayment;
            window.deletePayment = api.deletePayment;
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
     * Prepara y muestra el formulario para registrar un abono a una factura.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} invoiceId - Identificador de la factura destino
     * @param {string} invoiceNumero - Número visible de la factura
     */
    function showPaymentForm(invoiceId, invoiceNumero) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof document === 'undefined') return;

        const payForm = document.getElementById('payment-form');
        const invForm = document.getElementById('invoice-form');
        if (payForm) payForm.style.display = 'block';
        if (invForm) invForm.style.display = 'none';

        const targetText = document.getElementById('pay-target-invoice-text');
        if (targetText) targetText.textContent = `Abonando a documento: ${invoiceNumero}`;

        const setVal = (elemId, val) => {
            const el = document.getElementById(elemId);
            if (el) el.value = val;
        };
        setVal('pay-invoice-id', invoiceId);
        setVal('pay-idx-edit', '');
        setVal('pay-monto-nuevo', '');
        setVal('pay-ref', '');

        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const clientList = _deps.getClients();
        const p = prospectList.find(x => x && x.id === pid);
        const selectMetodo = document.getElementById('pay-metodo');
        let isGranContribuyente = false;

        if (selectMetodo) {
            Array.from(selectMetodo.options).forEach(opt => {
                if (opt.value === 'retencion_1pct') opt.remove();
            });
        }

        if (p && Array.isArray(p.facturas)) {
            const fac = p.facturas.find(f => f && f.id === invoiceId);
            const inputMonto = document.getElementById('pay-monto-nuevo');
            if (fac && inputMonto) {
                inputMonto.dataset.invoiceTotal = fac.monto;
                const explicitNet = fac.subtotal_sin_iva ?? fac.monto_sin_iva ?? fac.base_gravada ?? fac.base_sin_iva;
                inputMonto.dataset.invoiceBaseSinIva = (explicitNet !== undefined && explicitNet !== null) ? String(explicitNet) : '';
                inputMonto.dataset.incluyeIva = (fac.incluye_iva === false || fac.sin_iva === true) ? 'false' : 'true';
            }

            const client = clientList.find(c => c && c.id === p.clientId);
            const isExport = !!(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
            const cat = typeof (client && (client.categoria_contribuyente || client.tipo_contribuyente || client.clasificacion_contribuyente)) === 'string'
                ? String(client.categoria_contribuyente || client.tipo_contribuyente || client.clasificacion_contribuyente).trim().toLowerCase()
                : '';
            const isOtherContribuyente = Boolean(cat && (cat.includes('mediano') || cat.includes('pequeno') || cat.includes('pequeño') || cat === 'otro' || cat === 'otros'));
            isGranContribuyente = !!(client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true')) && !isExport && !isOtherContribuyente;
            if (inputMonto) inputMonto.dataset.isExport = isExport ? 'true' : 'false';

            if (selectMetodo) {
                const opt = document.createElement('option');
                opt.value = 'retencion_1pct';
                opt.textContent = isGranContribuyente ? 'Comprobante de Retención (1%)' : 'Retención 1% (Solo Grandes Contribuyentes)';
                opt.disabled = !isGranContribuyente;
                selectMetodo.appendChild(opt);
            }
        }
    }

    /**
     * Calcula automáticamente el 1% sobre la base gravada sin IVA de la factura
     * (Art. 162 Código Tributario El Salvador: monto / 1.13 cuando la factura está CON IVA,
     * o directamente sobre la base si el importe ya está expresado sin IVA; base mínima $100.00)
     * cuando se selecciona el método 'retencion_1pct' para un Gran Contribuyente local.
     */
    function handlePaymentMethodChange() {
        if (typeof document === 'undefined') return;
        const selectMetodo = document.getElementById('pay-metodo');
        const inputMonto = document.getElementById('pay-monto-nuevo');
        if (!selectMetodo || !inputMonto) return;

        if (selectMetodo.value === 'retencion_1pct') {
            const totalFactura = parseFloat(inputMonto.dataset.invoiceTotal);
            const isExport = inputMonto.dataset.isExport === 'true';
            if (!isNaN(totalFactura) && totalFactura > 0) {
                if (isExport) {
                    inputMonto.value = '0.00';
                    return;
                }
                const explicitBase = parseFloat(inputMonto.dataset.invoiceBaseSinIva);
                const alreadySinIva = inputMonto.dataset.incluyeIva === 'false';
                const baseSinIva = (!isNaN(explicitBase) && explicitBase > 0)
                    ? (Math.round(explicitBase * 100) / 100)
                    : (alreadySinIva ? (Math.round(totalFactura * 100) / 100) : (Math.round((totalFactura / 1.13) * 100) / 100));
                const retencion = baseSinIva >= 100 ? (Math.round(baseSinIva * 0.01 * 100) / 100) : 0;
                inputMonto.value = retencion.toFixed(2);
            }
        }
    }

    /**
     * Carga los datos de un abono existente en el formulario para edición.
     * Utiliza la clave canónica del abono (id o fecha histórica) para evitar desincronizaciones.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} invoiceId - Identificador de la factura
     * @param {number} paymentIndex - Índice en el array de pagos
     */
    function editPayment(invoiceId, paymentIndex) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const clientList = _deps.getClients();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.facturas)) return;
        const f = p.facturas.find(x => x && x.id === invoiceId);
        if (!f || !Array.isArray(f.pagos)) return;
        const pay = f.pagos[paymentIndex];
        if (!pay) return;

        if (typeof document === 'undefined') return;
        const payForm = document.getElementById('payment-form');
        const invForm = document.getElementById('invoice-form');
        if (payForm) payForm.style.display = 'block';
        if (invForm) invForm.style.display = 'none';

        const targetText = document.getElementById('pay-target-invoice-text');
        if (targetText) targetText.textContent = `Editando abono en Factura ${f.numero}`;

        const setVal = (elemId, val) => {
            const el = document.getElementById(elemId);
            if (el) el.value = (val !== null && typeof val !== 'undefined') ? val : '';
        };
        setVal('pay-invoice-id', invoiceId);
        setVal('pay-idx-edit', pay.id || pay.fecha); // Clave canónica del abono
        setVal('pay-monto-nuevo', pay.monto);

        const inputMonto = document.getElementById('pay-monto-nuevo');
        if (inputMonto) inputMonto.dataset.invoiceTotal = f.monto;

        const selectMetodo = document.getElementById('pay-metodo');
        if (selectMetodo) {
            Array.from(selectMetodo.options).forEach(opt => {
                if (opt.value === 'retencion_1pct') opt.remove();
            });

            const client = clientList.find(c => c && c.id === p.clientId);
            const isExport = !!(client && (client.es_exportacion === true || client.es_exportacion === 'true'));
            const cat = typeof (client && (client.categoria_contribuyente || client.tipo_contribuyente || client.clasificacion_contribuyente)) === 'string'
                ? String(client.categoria_contribuyente || client.tipo_contribuyente || client.clasificacion_contribuyente).trim().toLowerCase()
                : '';
            const isOtherContribuyente = Boolean(cat && (cat.includes('mediano') || cat.includes('pequeno') || cat.includes('pequeño') || cat === 'otro' || cat === 'otros'));
            const isGranContribuyente = !!(client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true')) && !isExport && !isOtherContribuyente;
            if (inputMonto) inputMonto.dataset.isExport = isExport ? 'true' : 'false';

            const opt = document.createElement('option');
            opt.value = 'retencion_1pct';
            opt.textContent = isGranContribuyente ? 'Comprobante de Retención (1%)' : 'Retención 1% (Solo Grandes Contribuyentes)';
            opt.disabled = !isGranContribuyente;
            selectMetodo.appendChild(opt);

            selectMetodo.value = pay.metodo;
        }

        setVal('pay-ref', pay.ref);
    }

    /**
     * Procesa el formulario de abono, sube el comprobante a Storage y ejecuta
     * CrmCommercial.savePayment con tope de saldo de la factura específica.
     * @param {Event} [e] - Evento submit
     */
    async function processPayment(e) {
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
        const m = parseFloat(document.getElementById('pay-monto-nuevo') ? document.getElementById('pay-monto-nuevo').value : 0);
        const met = document.getElementById('pay-metodo') ? document.getElementById('pay-metodo').value : '';
        const ref = document.getElementById('pay-ref') ? document.getElementById('pay-ref').value.trim() : '';
        const invId = document.getElementById('pay-invoice-id') ? document.getElementById('pay-invoice-id').value : '';
        const editKey = document.getElementById('pay-idx-edit') ? document.getElementById('pay-idx-edit').value : '';
        const fileEl = document.getElementById('pay-file');

        if (!editKey && fileEl && (!fileEl.files || fileEl.files.length === 0)) {
            return alert("Debe adjuntar el comprobante de pago.");
        }
        if (isNaN(m) || m <= 0) return alert("Ingrese un monto de pago válido.");
        if (!ref || !ref.replace(/[\s\-_./\\#,;:]+/g, '')) {
            return alert("Debe ingresar el número de comprobante o referencia.");
        }
        if (!Array.isArray(p.facturas) || !p.facturas.some(f => f && f.id === invId)) return;

        const dbSuffix = _deps.getDbSuffix();
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);

        const res = await _deps.runWorkflowOp('Subiendo comprobante de pago...', async fb => {
            const doc = (fileEl && fileEl.files && fileEl.files.length > 0)
                ? await _deps.uploadFileToStorage(fileEl.files[0], 'pagos', { prospectId: p.id })
                : null;
            return CrmCommercial.savePayment(fb, {
                prospectId: p.id,
                invoiceId: invId,
                paymentKey: editKey || undefined,
                monto: m,
                metodo: met,
                ref,
                doc_comprobante: doc || undefined,
                dbSuffix
            });
        });

        if (res) {
            const payForm = document.getElementById('payment-form');
            if (payForm) payForm.style.display = 'none';
        }
    }

    /**
     * Elimina un abono tras confirmación. Resuelve la clave canónica del abono
     * (id o fecha) para que eliminaciones concurrentes no afecten al pago incorrecto.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} invoiceId - Identificador de la factura
     * @param {number} paymentIndex - Índice en el array de pagos
     */
    async function deletePayment(invoiceId, paymentIndex) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof confirm === 'function' && !confirm("¿Estás seguro de eliminar este abono?")) return;
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.facturas)) return;
        const f = p.facturas.find(x => x && x.id === invoiceId);
        if (!f || !Array.isArray(f.pagos)) return;
        const pay = f.pagos[paymentIndex];
        if (!pay) return;

        const dbSuffix = _deps.getDbSuffix();

        await _deps.runWorkflowOp('Eliminando abono...', fb =>
            CrmCommercial.deletePayment(fb, {
                prospectId: p.id,
                invoiceId,
                paymentKey: pay.id || pay.fecha,
                dbSuffix
            })
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
        showPaymentForm,
        handlePaymentMethodChange,
        editPayment,
        processPayment,
        deletePayment
    };
});
