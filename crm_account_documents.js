// crm_account_documents.js
// Browser side of the Account Documents, Legal Representation & Contract Powers module (Phase 2, Block B3).
// Connects UI components with Cloud Functions callables for Legal Representatives, Powers of Attorney,
// Biennial Reviews, SHA-256 validation and Opportunity Close document checks.
// Follows existing UMD/IIFE pattern from crm_contacts.js and crm_clients.js.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmAccountDocuments = api;
        if (typeof window !== 'undefined') {
            window.CrmAccountDocuments = api;
        }
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const UNCERTAIN_CODES = ['unavailable', 'deadline-exceeded', 'internal', 'unknown', 'cancelled'];
    const pendingOps = new Map();

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
        return 'op_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
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

    // ---------- 1. Nombramiento de Representante Legal ----------

    function registerLegalRepresentativeTerm(fb, { accountId, contactId, nombre, fechaEleccion, fechaInicio, fechaVencimiento, credencialDoc, duiDoc, dbSuffix }) {
        const key = ['registerLegalRepresentativeTerm', dbSuffix, accountId, contactId || '', fechaEleccion].join('|');
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('registerLegalRepresentativeTermAdmin');
            return fn({
                accountId,
                contactId: contactId || null,
                nombre,
                fechaEleccion,
                fechaInicio: fechaInicio || null,
                fechaVencimiento: fechaVencimiento || null,
                credencialDoc,
                duiDoc,
                opId,
                dbSuffix
            });
        });
    }

    // ---------- 2. Poderes Notariales para Firma de Contratos ----------

    function grantContractPower(fb, { accountId, contactId, documentoDoc, documento, notas, dbSuffix }) {
        const effectiveDoc = documentoDoc || documento;
        const key = ['grantContractPower', dbSuffix, accountId, contactId, stableStringify(effectiveDoc)].join('|');
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('grantContractPowerAdmin');
            return fn({
                accountId,
                contactId,
                documentoDoc: effectiveDoc,
                documento: effectiveDoc,
                notas: notas || '',
                opId,
                dbSuffix
            });
        });
    }

    function revokeContractPower(fb, { accountId, powerId, motivo, dbSuffix }) {
        const key = ['revokeContractPower', dbSuffix, accountId, powerId].join('|');
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('revokeContractPowerAdmin');
            return fn({
                accountId,
                powerId,
                motivo,
                opId,
                dbSuffix
            });
        });
    }

    // ---------- 3. Revisión Bienal ----------

    function recordBiennialConfirmation(fb, { accountId, docKey, documentVersionId, confirmationType, confirmedNoChanges, notas, opportunityId, dbSuffix }) {
        const key = ['recordBiennialConfirmation', dbSuffix, accountId, docKey, documentVersionId, confirmationType].join('|');
        return callIdempotent(key, () => {
            const fn = fb.functions().httpsCallable('recordBiennialConfirmationAdmin');
            return fn({
                accountId,
                docKey,
                documentVersionId,
                confirmationType: confirmationType || 'biennial_no_changes',
                confirmedNoChanges: confirmedNoChanges === true,
                notas: notas || null,
                opportunityId: opportunityId || null,
                dbSuffix
            });
        });
    }

    // ---------- 4. Guardado y Sustitución de Documentos ----------

    function saveAccountDocument(fb, { accountId, docKey, doc, motivoSustitucion, fechaEmision, fechaVencimiento, dbSuffix }) {
        const key = ['saveAccountDocument', dbSuffix, accountId, docKey, stableStringify(doc)].join('|');
        return callIdempotent(key, opId => {
            const fn = fb.functions().httpsCallable('saveAccountDocumentAdmin');
            return fn({
                accountId,
                docKey,
                doc,
                motivoSustitucion: motivoSustitucion || null,
                fechaEmision: fechaEmision || null,
                fechaVencimiento: fechaVencimiento || null,
                opId,
                dbSuffix
            });
        });
    }

    // ---------- 5. Validación Centralizada al Cierre ----------

    function validateAccountDocumentsForOpportunityClose(fb, { accountId, prospectId, requiereContrato, firmante, dbSuffix }) {
        const fn = fb.functions().httpsCallable('validateAccountDocumentsForOpportunityCloseAdmin');
        return fn({
            accountId,
            prospectId,
            requiereContrato: requiereContrato === true,
            firmante: firmante || null,
            dbSuffix
        }).then(res => res.data);
    }

    // ---------- 6. Consulta de Expediente Completo ----------

    function getAccountDossier(fb, { accountId, dbSuffix }) {
        const fn = fb.functions().httpsCallable('getAccountDossierAdmin');
        return fn({
            accountId,
            dbSuffix
        }).then(res => res.data);
    }

    // ---------- Helper para cálculo de SHA-256 en navegador ----------

    async function computeFileSha256(file) {
        if (!file || typeof file.arrayBuffer !== 'function') return null;
        if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') return null;
        try {
            const buffer = await file.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('[CrmAccountDocuments] Error computing SHA-256:', e && e.message);
            return null;
        }
    }

    return {
        registerLegalRepresentativeTerm,
        grantContractPower,
        revokeContractPower,
        recordBiennialConfirmation,
        saveAccountDocument,
        validateAccountDocumentsForOpportunityClose,
        getAccountDossier,
        computeFileSha256
    };
});
