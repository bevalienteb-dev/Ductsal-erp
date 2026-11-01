// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: CHANGE ORDERS (Fase 6.4)
// Archivo: modules/finance/finance_change_orders.js
// Responsabilidades:
// 1. Apertura, reseteo y carga del modal de órdenes de cambio (#changeOrderModal).
// 2. Procesamiento, subida de documentos a Storage y guardado vía CrmCommercial.saveChangeOrder.
// 3. Eliminación protegida vía CrmCommercial.deleteChangeOrder.
// 4. Aplicación de control de acceso por rol (vendedor en modo solo lectura).
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceChangeOrders = api;
        if (typeof window !== 'undefined') {
            window.FinanceChangeOrders = api;
            window.openChangeOrderModal = api.openChangeOrderModal;
            window.editChangeOrder = api.editChangeOrder;
            window.processChangeOrder = api.processChangeOrder;
            window.deleteChangeOrder = api.deleteChangeOrder;
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
        },
        closeModal: (id) => {
            if (typeof closeModal === 'function') return closeModal(id);
            if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(id);
            const m = typeof document !== 'undefined' ? document.getElementById(id) : null;
            if (m) m.style.display = 'none';
        }
    };

    /**
     * Abre el modal para crear una nueva orden de cambio.
     * Bloquea a los usuarios con rol vendedor.
     */
    function openChangeOrderModal() {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof document === 'undefined') return;
        const form = document.getElementById('changeOrderForm');
        if (form && typeof form.reset === 'function') form.reset();
        const editInput = document.getElementById('co-id-edit');
        if (editInput) editInput.value = '';
        const modal = document.getElementById('changeOrderModal');
        if (modal) modal.style.display = 'block';
    }

    /**
     * Carga una orden de cambio existente en el modal para su edición.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} id - Identificador de la orden de cambio
     */
    function editChangeOrder(id) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.ordenes_cambio)) return;
        const o = p.ordenes_cambio.find(x => x && x.id === id);
        if (!o) return;

        if (typeof document === 'undefined') return;
        const setVal = (elemId, val) => {
            const el = document.getElementById(elemId);
            if (el) el.value = (val !== null && typeof val !== 'undefined') ? val : '';
        };

        setVal('co-id-edit', o.id);
        setVal('co-tipo', o.tipo);
        setVal('co-desc', o.desc);
        setVal('co-precio', o.precio);
        setVal('co-costo', o.costo);

        const modal = document.getElementById('changeOrderModal');
        if (modal) modal.style.display = 'block';
    }

    /**
     * Procesa el formulario de orden de cambio, sube documentos a Storage
     * y ejecuta CrmCommercial.saveChangeOrder de forma atómica e idempotente.
     * @param {Event} [e] - Evento de submit del formulario
     */
    async function processChangeOrder(e) {
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
        const editId = document.getElementById('co-id-edit') ? document.getElementById('co-id-edit').value : '';
        const tipo = document.getElementById('co-tipo') ? document.getElementById('co-tipo').value : '';
        const desc = document.getElementById('co-desc') ? document.getElementById('co-desc').value.trim() : '';
        const precio = parseFloat(document.getElementById('co-precio') ? document.getElementById('co-precio').value : 0);
        const costo = parseFloat(document.getElementById('co-costo') ? document.getElementById('co-costo').value : 0);

        const fOferta = document.getElementById('co-oferta');
        const fCostos = document.getElementById('co-costos');

        const dbSuffix = _deps.getDbSuffix();
        const commercialMod = (typeof CrmCommercial !== 'undefined') ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null);

        const res = await _deps.runWorkflowOp('Subiendo documentos de la orden de cambio...', async fb => {
            const docOferta = (fOferta && fOferta.files && fOferta.files.length > 0)
                ? await _deps.uploadFileToStorage(fOferta.files[0], 'ordenes_cambio', { prospectId: p.id })
                : null;
            const docCostos = (fCostos && fCostos.files && fCostos.files.length > 0)
                ? await _deps.uploadFileToStorage(fCostos.files[0], 'ordenes_cambio', { prospectId: p.id })
                : null;
            return CrmCommercial.saveChangeOrder(fb, {
                prospectId: p.id,
                orderId: editId || undefined,
                tipo,
                desc,
                precio,
                costo,
                doc_oferta: docOferta || undefined,
                doc_costos: docCostos || undefined,
                dbSuffix
            });
        });

        if (res) _deps.closeModal('changeOrderModal');
    }

    /**
     * Elimina una orden de cambio tras confirmación con el usuario.
     * Bloquea a los usuarios con rol vendedor.
     * @param {string} id - Identificador de la orden a eliminar
     */
    async function deleteChangeOrder(id) {
        const u = _deps.getCurrentUser();
        const userRole = (u && u.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
        if (userRole === 'vendedor') {
            alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
            return;
        }
        if (typeof confirm === 'function' && !confirm("¿Estás seguro de eliminar esta orden de cambio?")) return;
        const pid = _deps.getCurrentProspectId();
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x && x.id === pid);
        if (!p || !Array.isArray(p.ordenes_cambio) || !p.ordenes_cambio.some(o => o && o.id === id)) return;

        const dbSuffix = _deps.getDbSuffix();

        await _deps.runWorkflowOp('Eliminando orden de cambio...', fb =>
            CrmCommercial.deleteChangeOrder(fb, { prospectId: p.id, orderId: id, dbSuffix })
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
        openChangeOrderModal,
        editChangeOrder,
        processChangeOrder,
        deleteChangeOrder
    };
});
