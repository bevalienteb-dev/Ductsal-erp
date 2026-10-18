// crm_clients.js
// Browser side of the client catalogue. Everything that decides something lives on the server
// (functions/clientsService.js): this file only calls the callables, keeps the retry key stable and words the answers.
//  - Clients are created / edited ONLY through createClientAdmin / updateClientAdmin (duplicate check by NIT / DUI on
//    the server, atomic). There is no fallback that writes the client straight to Firestore.
//  - The selector of new opportunities searches the whole catalogue through searchClientsCatalog (id, name, masked
//    document hint). The list in the Clients section is a different thing (a portfolio, getVisibleClients in app_core.js).
// Every function receives the Firebase namespace (`fb`) explicitly so it can be unit-tested.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmClients = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    // Transport outcomes where the server may or may not have created the client: keep the same opId for the retry.
    const UNCERTAIN_CODES = ['unavailable', 'deadline-exceeded', 'internal', 'unknown', 'cancelled'];
    const pendingOps = new Map(); // payload key -> opId

    const NO_SESSION_MESSAGE =
        'No se guardó el cliente: el registro y la edición de clientes se validan en el servidor (evita duplicados por NIT / DUI) ' +
        'y requieren una sesión de Firebase. Este usuario aún usa el acceso histórico; pide a un gerente que lo migre.';

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

    function createClient(fb, { client, dbSuffix, confirmReview }) {
        const key = ['create', dbSuffix, confirmReview === true, stableStringify(client)].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('createClientAdmin')({ client, opId, dbSuffix, confirmReview: confirmReview === true }));
    }

    async function reserveCreation(fb, { client, dbSuffix, confirmReview }) {
        const r = await fb.functions().httpsCallable('reserveClientCreationAdmin')({ client, dbSuffix, confirmReview: confirmReview === true });
        return r.data;
    }

    function finalizeCreation(fb, { reservationId, client, dbSuffix, confirmReview }) {
        const key = ['finalize', reservationId, dbSuffix, confirmReview === true, stableStringify(client)].join('|');
        return callIdempotent(key, opId => fb.functions().httpsCallable('finalizeClientCreationAdmin')({ reservationId, client, opId, dbSuffix, confirmReview: confirmReview === true }));
    }

    async function cancelReservation(fb, { reservationId, dbSuffix }) {
        const r = await fb.functions().httpsCallable('cancelClientReservationAdmin')({ reservationId, dbSuffix });
        return r.data;
    }

    async function updateClient(fb, { id, client, dbSuffix, confirmReview }) {
        const r = await fb.functions().httpsCallable('updateClientAdmin')({ id, client, dbSuffix, confirmReview: confirmReview === true });
        return r.data;
    }

    async function searchCatalog(fb, { q, dbSuffix }) {
        const r = await fb.functions().httpsCallable('searchClientsCatalog')({ q, dbSuffix });
        return r.data;
    }

    // ---------- wording ----------
    const REASONS = {
        nit: 'mismo NIT', dui: 'mismo DUI', 'nombre-igual': 'mismo nombre', 'nombre-parecido': 'nombre parecido',
        'nit-igual-a-dui-de-otro': 'su DUI coincide con este NIT', 'dui-igual-a-nit-de-otro': 'su NIT coincide con este DUI',
        telefono: 'mismo teléfono', correo: 'mismo correo'
    };

    function describeMatches(matches) {
        return (matches || []).map(m => {
            const why = (m.reasons || []).map(r => REASONS[r] || r).join(', ');
            const hint = m.hint ? ` · ${m.hint}` : '';
            const mine = m.inPortfolio ? ' (ya está en tu cartera)' : '';
            return `• ${m.nombre || '(sin nombre)'}${hint}${why ? ' — ' + why : ''}${mine}`;
        }).join('\n');
    }

    function duplicateMessage(res) {
        return 'No se creó un cliente nuevo: ya existe un cliente con el mismo documento.\n\n' + describeMatches(res && res.matches) +
            '\n\nUsa el cliente existente (búscalo por nombre al crear la oportunidad). No se modificó ningún dato.';
    }

    function reviewMessage(res) {
        return 'Hay clientes con datos parecidos. Revísalos antes de continuar:\n\n' + describeMatches(res && res.matches) +
            '\n\n¿Es realmente un cliente distinto? Aceptar lo registra; Cancelar no guarda nada.';
    }

    function errorMessage(err) {
        const code = normalizeCode(err);
        const detail = err && err.message ? ` (${err.message})` : '';
        switch (code) {
            case 'unauthenticated': return 'Tu sesión de Firebase no es válida. Inicia sesión de nuevo.';
            case 'permission-denied': return 'No tienes permiso para esta operación con clientes.';
            case 'invalid-argument': return `Datos inválidos${detail}.`;
            case 'not-found': return 'El cliente o la reserva ya no existe.';
            case 'failed-precondition': return `Operación no válida: la reserva puede haber expirado o haber sido cancelada${detail}.`;
            case 'already-exists': return 'La reserva ya fue formalizada previamente.';
            default: return `No se pudo confirmar el guardado (${code || 'error'}). Puedes reintentar: se reutiliza la misma operación para no duplicar el cliente.`;
        }
    }

    function catalogOptionLabel(entry) {
        const hint = entry && entry.hint ? ` — ${entry.hint}` : '';
        return `${(entry && entry.nombre) || '(sin nombre)'}${hint}${entry && entry.inPortfolio ? ' ★' : ''}`;
    }

    return {
        NO_SESSION_MESSAGE,
        hasSessionSync,
        createClient,
        reserveCreation,
        finalizeCreation,
        cancelReservation,
        updateClient,
        searchCatalog,
        describeMatches,
        duplicateMessage,
        reviewMessage,
        errorMessage,
        catalogOptionLabel,
        _pendingOps: pendingOps
    };
});
