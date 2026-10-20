// crm_commercial.js
// Browser side of the commercial operations that are decided on the server (functions/commercialService.js).
// This file only calls the callables, keeps the retry key stable and words the answers. Authorization, identity and
// validation are NOT here: the server resolves the caller from the Firebase session + CRM profile and decides.
//  - There is NO fallback that writes to Firestore when a call fails or when there is no Firebase session: the operation
//    simply does not happen and the user is told why (see NO_SESSION_MESSAGE).
// Every function receives the Firebase namespace (`fb`) explicitly so it can be unit-tested.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmCommercial = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    // Transport outcomes where the server may or may not have applied the call: keep the same opId for the retry.
    const UNCERTAIN_CODES = ['unavailable', 'deadline-exceeded', 'internal', 'unknown', 'cancelled'];
    const pendingOps = new Map(); // payload key -> opId

    const NO_SESSION_MESSAGE =
        'No se guardó el cambio: esta operación se valida en el servidor y requiere una sesión de Firebase. ' +
        'Este usuario aún usa el acceso histórico; pide a un gerente que lo migre.';

    function normalizeCode(err) {
        return String((err && err.code) || '').replace(/^functions\//, '');
    }

    function newOpId() {
        const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        if (c && typeof c.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            c.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('No secure random source available for opId');
    }

    // Synchronous hint (is there a Firebase Auth session at all?). The server still authorises every call.
    function hasSessionSync(fb) {
        try { return !!(fb && typeof fb.auth === 'function' && fb.auth().currentUser); } catch (e) { return false; }
    }

    function stableStringify(v) {
        if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
        return JSON.stringify(v === undefined ? null : v);
    }

    async function callIdempotent(key, invoke) {
        const opId = pendingOps.get(key) || newOpId();
        pendingOps.set(key, opId);
        try {
            const result = await invoke(opId);
            pendingOps.delete(key);
            return result.data;
        } catch (e) {
            if (!UNCERTAIN_CODES.includes(normalizeCode(e))) pendingOps.delete(key);
            throw e;
        }
    }

    async function call(fb, name, payload) {
        const r = await fb.functions().httpsCallable(name)(payload);
        return r.data;
    }

    // ---------- operations ----------
    // Opportunity: `prospect` = { clientId, proyecto, origen, tipo_proyecto, tipo_producto, vendedorId? }. Who creates it and the
    // code are decided by the server; a retry after an uncertain failure reuses the opId and cannot create two.
    function createProspect(fb, { prospect, dbSuffix }) {
        const key = ['createProspect', dbSuffix, stableStringify(prospect)].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('createProspectAdmin')({ prospect, opId, dbSuffix }));
    }

    function addLog(fb, { prospectId, text, dbSuffix }) {
        const key = ['addLog', dbSuffix, prospectId, text].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('addProspectLogAdmin')({ prospectId, text, opId, dbSuffix }));
    }

    function deleteLog(fb, { prospectId, date, text, dbSuffix }) {
        return call(fb, 'deleteProspectLogAdmin', { prospectId, date, text, dbSuffix });
    }

    function reassign(fb, { prospectId, vendedorId, dbSuffix }) {
        return call(fb, 'reassignProspectAdmin', { prospectId, vendedorId, dbSuffix });
    }

    function setNoContractAuthorization(fb, { prospectId, authorized, dbSuffix }) {
        return call(fb, 'setNoContractAuthorizationAdmin', { prospectId, authorized: authorized === true, dbSuffix });
    }

    // Request / resolve flow. The request carries ONLY the opportunity and the reason: who asks, when and every authorization
    // field are decided by the server. A retry after an uncertain failure reuses the opId and cannot create a second request.
    function requestNoContractAuthorization(fb, { prospectId, motivo, dbSuffix }) {
        const key = ['requestNoContract', dbSuffix, prospectId, motivo].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('requestNoContractAuthorizationAdmin')({ prospectId, motivo, opId, dbSuffix }));
    }

    // decision: 'approve' | 'reject'. Only a manager session is accepted by the server; the rejection needs a reason.
    function resolveNoContractAuthorization(fb, { prospectId, requestId, decision, motivoDecision, dbSuffix }) {
        return call(fb, 'resolveNoContractAuthorizationAdmin', { prospectId, requestId, decision, motivoDecision, dbSuffix });
    }

    // action: 'addItem' | 'removeItem' (list: 'visitantes' | 'encargados') | 'setFactoryAddress'
    function updateSettings(fb, { action, list, value, dbSuffix }) {
        return call(fb, 'updateSettingsAdmin', { action, list, value, dbSuffix });
    }

    function deleteClient(fb, { clientId, dbSuffix }) {
        return call(fb, 'deleteClientAdmin', { clientId, dbSuffix });
    }

    // ---------- opportunity workflow (functions/prospectWorkflowService.js) ----------
    // The browser sends the user's input and the references of files already uploaded to Storage; the server reads the STORED
    // opportunity, decides who may do it, which transitions are valid and every computed amount. Creations carry an opId and keep
    // it across an uncertain failure so that a retry cannot register the same invoice / payment / change order twice; the retry
    // key deliberately leaves the file URLs out (an upload retried after a failure produces a different URL). Edits and deletes
    // address a record by id, so they are naturally repeatable.
    function advanceStage(fb, { prospectId, nextStage, data, dbSuffix }) {
        return call(fb, 'advanceProspectStageAdmin', { prospectId, nextStage, data, dbSuffix });
    }

    function markLost(fb, { prospectId, reason, dbSuffix }) {
        return call(fb, 'markProspectLostAdmin', { prospectId, reason, dbSuffix });
    }

    function registerProposal(fb, { prospectId, costo_venta, precio_cotizado, doc_oferta, doc_costos, dbSuffix }) {
        return call(fb, 'registerProposalAdmin', { prospectId, costo_venta, precio_cotizado, doc_oferta, doc_costos, dbSuffix });
    }

    function editBasePrice(fb, { prospectId, precio, costo, motivo, dbSuffix }) {
        return call(fb, 'editProspectBasePriceAdmin', { prospectId, precio, costo, motivo, dbSuffix });
    }

    // Invoked with orderId to edit; without it, creates (idempotent).
    function saveChangeOrder(fb, { prospectId, orderId, tipo, desc, precio, costo, doc_oferta, doc_costos, dbSuffix }) {
        const payload = { prospectId, orderId, tipo, desc, precio, costo, doc_oferta, doc_costos, dbSuffix };
        if (orderId) return call(fb, 'saveChangeOrderAdmin', payload);
        const key = ['saveChangeOrder', dbSuffix, prospectId, tipo, desc, precio, costo].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('saveChangeOrderAdmin')(Object.assign({ opId }, payload)));
    }

    function deleteChangeOrder(fb, { prospectId, orderId, dbSuffix }) {
        return call(fb, 'deleteChangeOrderAdmin', { prospectId, orderId, dbSuffix });
    }

    function saveInvoice(fb, { prospectId, invoiceId, numero, monto, doc_factura, dbSuffix }) {
        const payload = { prospectId, invoiceId, numero, monto, doc_factura, dbSuffix };
        if (invoiceId) return call(fb, 'saveInvoiceAdmin', payload);
        const key = ['saveInvoice', dbSuffix, prospectId, numero, monto].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('saveInvoiceAdmin')(Object.assign({ opId }, payload)));
    }

    function deleteInvoice(fb, { prospectId, invoiceId, dbSuffix }) {
        return call(fb, 'deleteInvoiceAdmin', { prospectId, invoiceId, dbSuffix });
    }

    // paymentKey = the id of the payment (or its `fecha` for payments saved before they had an id); never a list position.
    function savePayment(fb, { prospectId, invoiceId, paymentKey, monto, metodo, ref, doc_comprobante, dbSuffix }) {
        const payload = { prospectId, invoiceId, paymentKey, monto, metodo, ref, doc_comprobante, dbSuffix };
        if (paymentKey) return call(fb, 'savePaymentAdmin', payload);
        const key = ['savePayment', dbSuffix, prospectId, invoiceId, monto, metodo, ref].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('savePaymentAdmin')(Object.assign({ opId }, payload)));
    }

    function deletePayment(fb, { prospectId, invoiceId, paymentKey, dbSuffix }) {
        return call(fb, 'deletePaymentAdmin', { prospectId, invoiceId, paymentKey, dbSuffix });
    }

    // Logical deletion: the opportunity is marked (who / when / why), not removed. The reason is required.
    function deleteProspect(fb, { prospectId, motivo, dbSuffix }) {
        return call(fb, 'deleteProspectAdmin', { prospectId, motivo, dbSuffix });
    }

    // Reactivation of lost opportunity (manager only). The reason is required.
    function reactivateProspect(fb, { prospectId, motivo, dbSuffix }) {
        return call(fb, 'reactivateLostProspectAdmin', { prospectId, motivo, dbSuffix });
    }

    // ---------- wording ----------
    function serverMessage(err) {
        const m = err && typeof err.message === 'string' ? err.message.trim() : '';
        return m && !/^(functions\/)?[a-z-]+$/.test(m) ? m : '';
    }

    function errorMessage(err) {
        const code = normalizeCode(err);
        const detail = serverMessage(err);
        switch (code) {
            case 'unauthenticated': return 'Tu sesión de Firebase no es válida. Inicia sesión de nuevo.';
            case 'permission-denied': return detail ? `No tienes permiso para esta operación: ${detail}.` : 'No tienes permiso para esta operación.';
            case 'invalid-argument': return detail ? `Datos inválidos: ${detail}.` : 'Datos inválidos.';
            case 'not-found': return detail ? `${detail}.` : 'El registro ya no existe.';
            case 'failed-precondition': return detail ? `${detail}.` : 'La operación no se puede realizar en el estado actual.';
            default: return `No se pudo confirmar la operación (${code || 'error'}). Puedes reintentar: se reutiliza la misma solicitud para no duplicar el registro.`;
        }
    }

    return {
        NO_SESSION_MESSAGE,
        hasSessionSync,
        createProspect,
        addLog,
        deleteLog,
        reassign,
        setNoContractAuthorization,
        requestNoContractAuthorization,
        resolveNoContractAuthorization,
        updateSettings,
        deleteClient,
        advanceStage,
        markLost,
        registerProposal,
        editBasePrice,
        saveChangeOrder,
        deleteChangeOrder,
        saveInvoice,
        deleteInvoice,
        savePayment,
        deletePayment,
        deleteProspect,
        reactivateProspect,
        errorMessage,
        _pendingOps: pendingOps
    };
});
