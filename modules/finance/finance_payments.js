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
            window.openBankDepositModal = api.openBankDepositModal;
            window.closeBankDepositModal = api.closeBankDepositModal;
            window.handleBankDepositClientChange = api.handleBankDepositClientChange;
            window.recalculateBankDepositDistributionSummary = api.recalculateBankDepositDistributionSummary;
            window.processBankDepositForm = api.processBankDepositForm;
            window.toggleBankDepositsPanel = api.toggleBankDepositsPanel;
            window.refreshBankDepositsConsultation = api.refreshBankDepositsConsultation;
            window.setBankDepositsFilter = api.setBankDepositsFilter;
            window.renderBankDepositsTable = api.renderBankDepositsTable;
            window.promptVoidDepositApplication = api.promptVoidDepositApplication;
            window.applyDepositRowFullBalance = api.applyDepositRowFullBalance;
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

    // =========================================================================
    // B5.3 — Registro, Distribución y Consulta de Abonos Bancarios Multifactura
    // =========================================================================
    let _cachedBankDeposits = [];
    let _activeBankDepositsFilter = 'todos';
    let _activeDistributeDeposit = null;

    function _toCents(n) {
        const v = typeof n === 'number' ? n : parseFloat(n);
        return Number.isFinite(v) ? Math.round(v * 100) : 0;
    }

    function _fromCents(c) {
        return Math.round(Number(c) || 0) / 100;
    }

    function _fmtCurrency(val) {
        if (typeof formatCurrency === 'function') return formatCurrency(val);
        if (typeof window !== 'undefined' && typeof window.formatCurrency === 'function') return window.formatCurrency(val);
        const n = parseFloat(val) || 0;
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function _escapeHtml(str) {
        if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
        if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function _resolveCanonicalClientId(rawClientId) {
        if (!rawClientId) return '';
        const clientList = _deps.getClients();
        let cur = String(rawClientId).trim();
        const visited = new Set();
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            const c = clientList.find(item => item && item.id === cur);
            if (c && typeof c.fusionada_en === 'string' && c.fusionada_en.trim()) {
                cur = c.fusionada_en.trim();
            } else {
                break;
            }
        }
        return cur;
    }

    function _getClientDisplayName(c) {
        if (!c) return '-';
        if (c.tipo === 'natural') {
            return `${c.nombres || ''} ${c.apellidos || ''}`.trim() || c.nombre || c.id;
        }
        return c.empresa || c.nombre || c.contacto || c.id;
    }

    function _isActivePayment(pay) {
        if (!pay || typeof pay !== 'object') return false;
        if (pay.anulado === true || pay.anulada === true || pay.eliminado === true || pay.revertido === true) return false;
        const st = typeof pay.estado === 'string' ? pay.estado.trim().toLowerCase() : '';
        if (['anulado', 'anulada', 'revertido', 'eliminado'].includes(st)) return false;
        return true;
    }

    function _getPendingInvoicesForCanonicalClient(canonicalClientId) {
        if (!canonicalClientId) return [];
        const prospectList = _deps.getProspects();
        const rows = [];
        for (const p of prospectList) {
            if (!p || p.eliminado === true) continue;
            const pClientId = _resolveCanonicalClientId(p.clientId);
            if (pClientId !== canonicalClientId) continue;
            const facturas = Array.isArray(p.facturas) ? p.facturas : [];
            for (const f of facturas) {
                if (!f || f.anulada === true || f.eliminada === true) continue;
                const montoCents = _toCents(f.monto);
                if (montoCents <= 0 || !f.numero) continue;
                let cobradoMonCents = 0;
                let retencionCents = 0;
                for (const pay of (Array.isArray(f.pagos) ? f.pagos : [])) {
                    if (!_isActivePayment(pay)) continue;
                    const pc = _toCents(pay.monto);
                    if (pc <= 0) continue;
                    if (String(pay.metodo || '').trim().toLowerCase() === 'retencion_1pct') {
                        retencionCents += pc;
                    } else {
                        cobradoMonCents += pc;
                    }
                }
                const pendienteCents = Math.max(0, montoCents - (cobradoMonCents + retencionCents));
                if (pendienteCents <= 0) continue;
                rows.push({
                    prospectId: p.id,
                    codigoOportunidad: p.codigo || p.id,
                    proyecto: p.proyecto || '-',
                    invoiceId: f.id,
                    facturaNumero: f.numero,
                    esAnticipo: Boolean(f.es_anticipo === true || f.tipo_factura === 'anticipo'),
                    fecha: f.fecha || p.fecha_cierre || '',
                    montoOriginal: _fromCents(montoCents),
                    cobradoMonetario: _fromCents(cobradoMonCents),
                    retencionesAplicadas: _fromCents(retencionCents),
                    saldoPendiente: _fromCents(pendienteCents),
                    saldoPendienteCents: pendienteCents
                });
            }
        }
        return rows;
    }

    function openBankDepositModal(options = {}) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert('Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.');
            return;
        }
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('bank-deposit-modal');
        if (!modal) return;

        const isDistributeMode = Boolean(options && options.mode === 'distribute' && options.deposit);
        _activeDistributeDeposit = isDistributeMode ? options.deposit : null;

        const modeInput = document.getElementById('bdep-mode');
        const existingIdInput = document.getElementById('bdep-existing-id');
        const titleEl = document.getElementById('bdep-modal-title');
        const subtitleEl = document.getElementById('bdep-modal-subtitle');
        const clientSelect = document.getElementById('bdep-client-select');
        const refInput = document.getElementById('bdep-ref');
        const metodoSelect = document.getElementById('bdep-metodo');
        const fechaInput = document.getElementById('bdep-fecha-comprobante');
        const montoInput = document.getElementById('bdep-monto-recibido');
        const bancoInput = document.getElementById('bdep-banco');
        const fileInput = document.getElementById('bdep-file');
        const fileGroup = document.getElementById('bdep-file-group');
        const obsInput = document.getElementById('bdep-observaciones');
        const submitBtn = document.getElementById('bdep-submit-btn');

        if (modeInput) modeInput.value = isDistributeMode ? 'distribute' : 'register';
        if (existingIdInput) existingIdInput.value = isDistributeMode ? (options.deposit.id || options.deposit.abono_id || '') : '';

        // Populate clients dropdown (canonical active clients)
        if (clientSelect) {
            const clientList = _deps.getClients().filter(c => c && !c.eliminado && !(typeof c.fusionada_en === 'string' && c.fusionada_en.trim()));
            clientSelect.innerHTML = '<option value="">Seleccione un cliente...</option>';
            clientList.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = _getClientDisplayName(c);
                clientSelect.appendChild(opt);
            });
        }

        const preselectedClientId = isDistributeMode
            ? _resolveCanonicalClientId(options.deposit.clientId)
            : _resolveCanonicalClientId(options.clientId || '');

        if (clientSelect && preselectedClientId) {
            clientSelect.value = preselectedClientId;
        }

        if (isDistributeMode) {
            const dep = options.deposit;
            if (titleEl) titleEl.textContent = `🏦 Distribuir Saldo Disponible — Abono Ref. ${dep.ref || dep.id}`;
            if (subtitleEl) subtitleEl.textContent = `Aplique el saldo disponible (${_fmtCurrency(dep.saldo_disponible)}) a una o múltiples facturas pendientes del cliente.`;
            if (clientSelect) clientSelect.disabled = true;
            if (refInput) { refInput.value = dep.ref || ''; refInput.disabled = true; }
            if (metodoSelect) { metodoSelect.value = dep.metodo || 'transferencia'; metodoSelect.disabled = true; }
            if (fechaInput) {
                const rawDate = String(dep.fecha_comprobante_bancario || '').slice(0, 10);
                fechaInput.value = rawDate;
                fechaInput.disabled = true;
            }
            if (montoInput) { montoInput.value = Number(dep.importe_original_recibido || 0).toFixed(2); montoInput.disabled = true; }
            if (bancoInput) { bancoInput.value = dep.banco_origen || ''; bancoInput.disabled = true; }
            if (fileGroup) fileGroup.style.display = 'none';
            if (obsInput) obsInput.value = '';
            if (submitBtn) submitBtn.textContent = '💾 Aplicar Distribución de Saldo';
        } else {
            if (titleEl) titleEl.textContent = '🏦 Registrar Abono Bancario y Distribuir entre Facturas';
            if (subtitleEl) subtitleEl.textContent = 'Registre un único comprobante bancario (transferencia o cheque) y aplíquelo total o parcialmente a una o múltiples facturas del mismo cliente.';
            if (clientSelect) clientSelect.disabled = false;
            if (refInput) { refInput.value = ''; refInput.disabled = false; }
            if (metodoSelect) { metodoSelect.value = 'transferencia'; metodoSelect.disabled = false; }
            if (fechaInput) {
                fechaInput.value = new Date().toISOString().slice(0, 10);
                fechaInput.disabled = false;
            }
            if (montoInput) { montoInput.value = ''; montoInput.disabled = false; }
            if (bancoInput) { bancoInput.value = ''; bancoInput.disabled = false; }
            if (fileGroup) fileGroup.style.display = 'block';
            if (fileInput) fileInput.value = '';
            if (obsInput) obsInput.value = '';
            if (submitBtn) submitBtn.textContent = '💾 Guardar Abono y Distribución';
        }

        handleBankDepositClientChange();
        modal.style.display = 'flex';
    }

    function closeBankDepositModal() {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('bank-deposit-modal');
        if (modal) modal.style.display = 'none';
        _activeDistributeDeposit = null;
    }

    function handleBankDepositClientChange() {
        if (typeof document === 'undefined') return;
        const clientSelect = document.getElementById('bdep-client-select');
        const tbody = document.getElementById('bdep-invoices-tbody');
        if (!tbody) return;

        const canonicalClientId = clientSelect ? _resolveCanonicalClientId(clientSelect.value) : '';
        if (!canonicalClientId) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 1rem;">Seleccione un cliente para ver sus facturas con saldo pendiente.</td></tr>';
            recalculateBankDepositDistributionSummary();
            return;
        }

        const pendingInvoices = _getPendingInvoicesForCanonicalClient(canonicalClientId);
        if (pendingInvoices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 1rem;">Este cliente no tiene facturas activas con saldo pendiente. El abono quedará registrado con el 100% como saldo disponible para aplicar posteriormente.</td></tr>';
            recalculateBankDepositDistributionSummary();
            return;
        }

        tbody.innerHTML = pendingInvoices.map((inv, idx) => {
            const antBadge = inv.esAnticipo
                ? ' <span class="badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; font-size:0.65rem;">Anticipo</span>'
                : '';
            const fechaStr = inv.fecha ? String(inv.fecha).slice(0, 10) : '-';
            return `
                <tr data-prospect-id="${_escapeHtml(inv.prospectId)}" data-invoice-id="${_escapeHtml(inv.invoiceId)}" data-pending="${inv.saldoPendiente.toFixed(2)}">
                    <td style="text-align: center;">
                        <input type="checkbox" class="bdep-inv-check" data-row-idx="${idx}" onchange="applyDepositRowFullBalance(${idx}, this.checked)">
                    </td>
                    <td><strong>${_escapeHtml(inv.facturaNumero)}</strong>${antBadge}</td>
                    <td>
                        <div style="font-size:0.8rem; color:var(--brand-gold); font-family:monospace;">${_escapeHtml(inv.codigoOportunidad)}</div>
                        <div style="font-size:0.75rem; color:var(--text-secondary);">${_escapeHtml(inv.proyecto)}</div>
                    </td>
                    <td style="font-size:0.8rem;">${_escapeHtml(fechaStr)}</td>
                    <td style="text-align: right;" class="tabular-nums">${_fmtCurrency(inv.montoOriginal)}</td>
                    <td style="text-align: right; color:#34d399;" class="tabular-nums">${_fmtCurrency(inv.cobradoMonetario)}</td>
                    <td style="text-align: right; color:var(--brand-gold);" class="tabular-nums">${_fmtCurrency(inv.retencionesAplicadas)}</td>
                    <td style="text-align: right; font-weight:700; color:#fca5a5;" class="tabular-nums">${_fmtCurrency(inv.saldoPendiente)}</td>
                    <td style="text-align: right;">
                        <input type="number" class="form-control bdep-inv-amount" data-row-idx="${idx}" data-prospect-id="${_escapeHtml(inv.prospectId)}" data-invoice-id="${_escapeHtml(inv.invoiceId)}" data-max-pending="${inv.saldoPendiente.toFixed(2)}" step="0.01" min="0" max="${inv.saldoPendiente.toFixed(2)}" placeholder="0.00" style="width: 130px; text-align: right; padding: 0.35rem 0.5rem; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 4px; color: white;" oninput="recalculateBankDepositDistributionSummary()">
                    </td>
                </tr>
            `;
        }).join('');

        recalculateBankDepositDistributionSummary();
    }

    function applyDepositRowFullBalance(rowIdx, checked) {
        if (typeof document === 'undefined') return;
        const input = document.querySelector(`.bdep-inv-amount[data-row-idx="${rowIdx}"]`);
        if (!input) return;
        if (!checked) {
            input.value = '';
            recalculateBankDepositDistributionSummary();
            return;
        }
        const maxPendingCents = _toCents(input.dataset.maxPending);
        const summary = recalculateBankDepositDistributionSummary();
        const currentValCents = _toCents(input.value);
        const availableForThisRowCents = Math.max(0, summary.availableBeforeNowCents - (summary.nowApplyingCents - currentValCents));
        const toApplyCents = Math.min(maxPendingCents, availableForThisRowCents > 0 ? availableForThisRowCents : maxPendingCents);
        input.value = _fromCents(toApplyCents).toFixed(2);
        recalculateBankDepositDistributionSummary();
    }

    function recalculateBankDepositDistributionSummary() {
        if (typeof document === 'undefined') {
            return { originalCents: 0, prevAppliedCents: 0, availableBeforeNowCents: 0, nowApplyingCents: 0, remainingCents: 0, valid: true };
        }
        const modeEl = document.getElementById('bdep-mode');
        const isDistribute = Boolean(modeEl && modeEl.value === 'distribute' && _activeDistributeDeposit);
        const montoInput = document.getElementById('bdep-monto-recibido');

        const originalCents = isDistribute
            ? _toCents(_activeDistributeDeposit.importe_original_recibido)
            : _toCents(montoInput ? montoInput.value : 0);
        const prevAppliedCents = isDistribute
            ? _toCents(_activeDistributeDeposit.total_aplicado)
            : 0;
        const availableBeforeNowCents = Math.max(0, originalCents - prevAppliedCents);

        const inputs = Array.from(document.querySelectorAll('.bdep-inv-amount'));
        let nowApplyingCents = 0;
        let rowExceededMsg = '';

        inputs.forEach(inp => {
            const valCents = _toCents(inp.value);
            const maxCents = _toCents(inp.dataset.maxPending);
            const chk = document.querySelector(`.bdep-inv-check[data-row-idx="${inp.dataset.rowIdx}"]`);
            if (chk) chk.checked = valCents > 0;
            if (valCents > 0) {
                nowApplyingCents += valCents;
                if (valCents > maxCents) {
                    rowExceededMsg = `El monto ingresado (${_fmtCurrency(_fromCents(valCents))}) supera el saldo pendiente de la factura (${_fmtCurrency(_fromCents(maxCents))}).`;
                }
            }
        });

        const remainingCents = availableBeforeNowCents - nowApplyingCents;

        const elOrig = document.getElementById('bdep-live-original');
        const elPrev = document.getElementById('bdep-live-prev-applied');
        const elNow = document.getElementById('bdep-live-now-applying');
        const elRem = document.getElementById('bdep-live-remaining');
        const banner = document.getElementById('bdep-validation-banner');

        if (elOrig) elOrig.textContent = _fmtCurrency(_fromCents(originalCents));
        if (elPrev) elPrev.textContent = _fmtCurrency(_fromCents(prevAppliedCents));
        if (elNow) elNow.textContent = _fmtCurrency(_fromCents(nowApplyingCents));
        if (elRem) {
            elRem.textContent = _fmtCurrency(_fromCents(Math.max(0, remainingCents)));
            elRem.style.color = remainingCents < 0 ? 'var(--danger)' : 'var(--brand-gold)';
        }

        let errorMsg = rowExceededMsg;
        if (!errorMsg && originalCents > 0 && remainingCents < 0) {
            errorMsg = `La suma de las aplicaciones (${_fmtCurrency(_fromCents(nowApplyingCents))}) supera el saldo disponible del abono (${_fmtCurrency(_fromCents(availableBeforeNowCents))}).`;
        }

        if (banner) {
            if (errorMsg) {
                banner.style.display = 'block';
                banner.textContent = `⚠️ ${errorMsg}`;
            } else {
                banner.style.display = 'none';
                banner.textContent = '';
            }
        }

        return {
            originalCents,
            prevAppliedCents,
            availableBeforeNowCents,
            nowApplyingCents,
            remainingCents,
            valid: !errorMsg
        };
    }

    async function processBankDepositForm(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert('Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.');
            return;
        }
        if (typeof document === 'undefined') return;

        const summary = recalculateBankDepositDistributionSummary();
        if (!summary.valid) {
            return alert('Verifique los montos de distribución: existen importes que superan el saldo disponible o el saldo de la factura.');
        }

        const modeEl = document.getElementById('bdep-mode');
        const isDistribute = Boolean(modeEl && modeEl.value === 'distribute' && _activeDistributeDeposit);
        const clientSelect = document.getElementById('bdep-client-select');
        const refInput = document.getElementById('bdep-ref');
        const metodoSelect = document.getElementById('bdep-metodo');
        const fechaInput = document.getElementById('bdep-fecha-comprobante');
        const montoInput = document.getElementById('bdep-monto-recibido');
        const bancoInput = document.getElementById('bdep-banco');
        const fileInput = document.getElementById('bdep-file');
        const obsInput = document.getElementById('bdep-observaciones');

        const allocations = [];
        Array.from(document.querySelectorAll('.bdep-inv-amount')).forEach(inp => {
            const valCents = _toCents(inp.value);
            if (valCents > 0) {
                allocations.push({
                    prospectId: inp.dataset.prospectId,
                    invoiceId: inp.dataset.invoiceId,
                    monto: _fromCents(valCents)
                });
            }
        });

        const dbSuffix = _deps.getDbSuffix();
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);
        if (!commercialMod) return;

        if (isDistribute) {
            if (allocations.length === 0) {
                return alert('Debe ingresar un monto positivo en al menos una factura para distribuir el saldo disponible.');
            }
            const abonoId = _activeDistributeDeposit.id || _activeDistributeDeposit.abono_id;
            const res = await _deps.runWorkflowOp('Aplicando distribución de abono bancario...', fb =>
                commercialMod.distributeBankDeposit(fb, {
                    abonoId,
                    clientId: _activeDistributeDeposit.clientId,
                    allocations,
                    observaciones: obsInput ? obsInput.value.trim() : '',
                    dbSuffix
                })
            );
            if (res) {
                closeBankDepositModal();
                await refreshBankDepositsConsultation();
            }
            return;
        }

        const clientId = clientSelect ? clientSelect.value : '';
        const ref = refInput ? refInput.value.trim() : '';
        const metodo = metodoSelect ? metodoSelect.value : 'transferencia';
        const fechaComprobante = fechaInput ? fechaInput.value.trim() : '';
        const monto = parseFloat(montoInput ? montoInput.value : 0);
        const banco_origen = bancoInput ? bancoInput.value.trim() : '';
        const observaciones = obsInput ? obsInput.value.trim() : '';

        if (!clientId) return alert('Seleccione el cliente titular del abono.');
        if (!ref) return alert('Ingrese la referencia bancaria o número de cheque.');
        if (!fechaComprobante) return alert('Ingrese la fecha real del comprobante bancario.');
        if (isNaN(monto) || monto <= 0) return alert('Ingrese un importe recibido válido mayor a cero.');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            return alert('Debe adjuntar el comprobante bancario (PDF o imagen).');
        }

        const firstProspectId = allocations.length > 0 ? allocations[0].prospectId : undefined;
        const res = await _deps.runWorkflowOp('Registrando abono bancario y distribución...', async fb => {
            const doc = await _deps.uploadFileToStorage(fileInput.files[0], 'pagos', {
                prospectId: firstProspectId,
                clientId
            });
            return commercialMod.registerBankDeposit(fb, {
                clientId,
                ref,
                metodo,
                monto,
                fechaComprobante,
                banco_origen: banco_origen || undefined,
                doc_comprobante: doc,
                observaciones,
                allocations,
                dbSuffix
            });
        });

        if (res) {
            closeBankDepositModal();
            const panel = document.getElementById('bank-deposits-consultation-panel');
            if (panel && panel.style.display !== 'none') {
                await refreshBankDepositsConsultation();
            }
        }
    }

    async function toggleBankDepositsPanel(forceOpen) {
        if (typeof document === 'undefined') return;
        const panel = document.getElementById('bank-deposits-consultation-panel');
        if (!panel) return;
        const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : (panel.style.display === 'none');
        panel.style.display = shouldOpen ? 'block' : 'none';
        if (shouldOpen) {
            await refreshBankDepositsConsultation();
        }
    }

    async function refreshBankDepositsConsultation(clientId) {
        if (typeof document === 'undefined') return;
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);
        const fb = (typeof firebase !== 'undefined') ? firebase : (typeof window !== 'undefined' ? window.firebase : null);
        if (!commercialMod || !fb) return;

        const dbSuffix = _deps.getDbSuffix();
        try {
            const res = await commercialMod.listClientBankDeposits(fb, {
                clientId: clientId || undefined,
                includeHistoricalSinglePayments: true,
                dbSuffix
            });
            if (res && Array.isArray(res.deposits)) {
                _cachedBankDeposits = res.deposits;
                renderBankDepositsTable();
            }
        } catch (err) {
            console.error('Error al consultar abonos bancarios:', err);
        }
    }

    function setBankDepositsFilter(filterKey) {
        _activeBankDepositsFilter = filterKey || 'todos';
        if (typeof document !== 'undefined') {
            Array.from(document.querySelectorAll('#dep-status-filter-pills .filter-pill')).forEach(btn => {
                if (btn.dataset.depFilter === _activeBankDepositsFilter) btn.classList.add('active');
                else btn.classList.remove('active');
            });
        }
        renderBankDepositsTable();
    }

    function renderBankDepositsTable() {
        if (typeof document === 'undefined') return;
        const tbody = document.getElementById('bank-deposits-table-body');
        if (!tbody) return;

        const u = _deps.getCurrentUser();
        const isReadOnly = Boolean(u && u.role === 'vendedor');
        const searchInput = document.getElementById('dep-search-input');
        const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

        let list = _cachedBankDeposits.slice();
        if (_activeBankDepositsFilter === 'con_saldo') {
            list = list.filter(d => _toCents(d.saldo_disponible) > 0);
        } else if (_activeBankDepositsFilter !== 'todos') {
            list = list.filter(d => d.estado_abono === _activeBankDepositsFilter);
        }

        if (q) {
            list = list.filter(d => {
                if (
                    String(d.ref || '').toLowerCase().includes(q) ||
                    String(d.cliente_nombre || '').toLowerCase().includes(q) ||
                    String(d.metodo || '').toLowerCase().includes(q)
                ) return true;
                return (d.aplicaciones || []).some(a =>
                    String(a.factura_numero || '').toLowerCase().includes(q) ||
                    String(a.codigo_oportunidad || '').toLowerCase().includes(q) ||
                    String(a.proyecto || '').toLowerCase().includes(q)
                );
            });
        }

        let sumRecibidoCents = 0;
        let sumAplicadoCents = 0;
        let sumDisponibleCents = 0;
        list.forEach(d => {
            sumRecibidoCents += _toCents(d.importe_original_recibido);
            sumAplicadoCents += _toCents(d.total_aplicado);
            sumDisponibleCents += _toCents(d.saldo_disponible);
        });

        const elRec = document.getElementById('dep-sum-recibido');
        const elApl = document.getElementById('dep-sum-aplicado');
        const elDisp = document.getElementById('dep-sum-disponible');
        if (elRec) elRec.textContent = _fmtCurrency(_fromCents(sumRecibidoCents));
        if (elApl) elApl.textContent = _fmtCurrency(_fromCents(sumAplicadoCents));
        if (elDisp) elDisp.textContent = _fmtCurrency(_fromCents(sumDisponibleCents));

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 1.25rem;">No se encontraron abonos bancarios con los filtros actuales.</td></tr>';
            return;
        }

        tbody.innerHTML = list.map((d, idx) => {
            const fechaComp = d.fecha_comprobante_bancario ? String(d.fecha_comprobante_bancario).slice(0, 10) : '-';
            const estadoBadge = d.estado_abono === 'totalmente_aplicado'
                ? '<span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-size:0.7rem;">Totalmente aplicado</span>'
                : (d.estado_abono === 'parcialmente_aplicado'
                    ? '<span class="badge" style="background:rgba(245,158,11,0.2); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); font-size:0.7rem;">Parcialmente aplicado</span>'
                    : '<span class="badge" style="background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); font-size:0.7rem;">Recibido (Sin aplicar)</span>');

            const appsHtml = (d.aplicaciones || []).length > 0
                ? (d.aplicaciones || []).map(a => {
                    const isVoided = Boolean(a.anulada === true || a.anulado === true || a.estado === 'anulada');
                    const voidStyle = isVoided ? 'text-decoration:line-through; opacity:0.6;' : '';
                    const voidBtn = (!isReadOnly && !isVoided && d.es_abono_multifactura)
                        ? ` <button type="button" class="btn-subtle-delete" style="font-size:0.68rem; padding:1px 4px;" onclick="promptVoidDepositApplication('${_escapeHtml(d.id)}', '${_escapeHtml(a.aplicacion_id || '')}', '${_escapeHtml(a.prospectId || '')}', '${_escapeHtml(a.invoiceId || '')}', '${_escapeHtml(a.paymentKey || '')}')" title="Anular esta aplicación y restaurar saldo al abono">↩️ Anular</button>`
                        : (isVoided ? ' <span class="badge" style="background:rgba(239,68,68,0.2); color:#fca5a5; font-size:0.62rem;">ANULADA</span>' : '');
                    return `<div style="font-size:0.76rem; margin-bottom:3px; ${voidStyle}">
                        <strong>${_escapeHtml(a.factura_numero || a.invoiceId)}</strong>
                        <span style="color:var(--text-secondary);">(${_escapeHtml(a.codigo_oportunidad || a.prospectId)}):</span>
                        <strong style="color:#34d399;">${_fmtCurrency(a.monto_aplicado ?? a.monto)}</strong>${voidBtn}
                    </div>`;
                }).join('')
                : '<span style="color:var(--text-muted); font-size:0.75rem;">Sin aplicaciones activas</span>';

            const firstProspectId = (d.aplicaciones && d.aplicaciones[0] && d.aplicaciones[0].prospectId) || '';
            const docHtml = d.doc_comprobante
                ? `<a href="javascript:void(0)" onclick='viewSecureDocument(${JSON.stringify(d.doc_comprobante)}, "Comprobante ${_escapeHtml(d.ref)}", { prospectId: "${_escapeHtml(firstProspectId)}", clientId: "${_escapeHtml(d.clientId || '')}" })' style="color:var(--brand-gold); font-size:0.78rem; text-decoration:none;">📄 Ver</a>`
                : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';

            const canDistribute = !isReadOnly && _toCents(d.saldo_disponible) > 0;
            const actionBtn = canDistribute
                ? `<button type="button" class="btn-abono-primary" style="font-size:0.75rem; padding:4px 8px;" onclick="FinancePayments._openDistributeForCachedIndex(${idx})">💰 Distribuir Saldo</button>`
                : '<span style="color:var(--text-muted); font-size:0.75rem;">—</span>';

            return `
                <tr>
                    <td style="font-size:0.8rem; white-space:nowrap;">${_escapeHtml(fechaComp)}</td>
                    <td style="font-weight:600; color:white; font-size:0.82rem;">${_escapeHtml(d.cliente_nombre || d.clientId)}</td>
                    <td style="font-size:0.8rem;">
                        <strong>${_escapeHtml(d.ref)}</strong>
                        <div style="font-size:0.72rem; color:var(--text-secondary);">${_escapeHtml(d.metodo || 'transferencia')}${d.banco_origen ? ' • ' + _escapeHtml(d.banco_origen) : ''}</div>
                    </td>
                    <td style="text-align:right; font-weight:700; color:#38bdf8;" class="tabular-nums">${_fmtCurrency(d.importe_original_recibido)}</td>
                    <td style="text-align:right; color:#34d399;" class="tabular-nums">${_fmtCurrency(d.total_aplicado)}</td>
                    <td style="text-align:right; font-weight:700; color:${_toCents(d.saldo_disponible) > 0 ? 'var(--brand-gold)' : 'var(--text-muted)'};" class="tabular-nums">${_fmtCurrency(d.saldo_disponible)}</td>
                    <td>${estadoBadge}</td>
                    <td>${appsHtml}</td>
                    <td>${docHtml}</td>
                    <td style="text-align:right; white-space:nowrap;">${actionBtn}</td>
                </tr>
            `;
        }).join('');
    }

    function _openDistributeForCachedIndex(idx) {
        const dep = _cachedBankDeposits[idx];
        if (!dep) return;
        openBankDepositModal({ mode: 'distribute', deposit: dep });
    }

    async function promptVoidDepositApplication(abonoId, aplicacionId, prospectId, invoiceId, paymentKey) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert('Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.');
            return;
        }
        const motivo = typeof prompt === 'function'
            ? prompt('Ingrese el motivo de anulación de esta aplicación (el importe volverá al saldo disponible del abono bancario sin borrar el comprobante original):')
            : '';
        if (!motivo || !motivo.trim()) return;

        const dbSuffix = _deps.getDbSuffix();
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);
        if (!commercialMod) return;

        const res = await _deps.runWorkflowOp('Anulando aplicación de abono bancario...', fb =>
            commercialMod.voidBankDepositApplication(fb, {
                abonoId,
                aplicacionId: aplicacionId || undefined,
                prospectId: prospectId || undefined,
                invoiceId: invoiceId || undefined,
                paymentKey: paymentKey || undefined,
                motivo: motivo.trim(),
                dbSuffix
            })
        );
        if (res) {
            await refreshBankDepositsConsultation();
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
        deletePayment,
        openBankDepositModal,
        closeBankDepositModal,
        handleBankDepositClientChange,
        recalculateBankDepositDistributionSummary,
        processBankDepositForm,
        toggleBankDepositsPanel,
        refreshBankDepositsConsultation,
        setBankDepositsFilter,
        renderBankDepositsTable,
        promptVoidDepositApplication,
        applyDepositRowFullBalance,
        _openDistributeForCachedIndex
    };
});
