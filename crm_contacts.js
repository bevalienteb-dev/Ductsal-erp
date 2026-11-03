// crm_contacts.js
// Browser side of the Contacts & Account Relations module (Phase 2, Block 1).
// Connects UI components with Cloud Functions callables for Person identity, Account-Contact relations,
// and historical periods.
// Follows existing UMD/IIFE pattern from crm_clients.js.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmContacts = api;
        if (typeof window !== 'undefined') {
            window.CrmContacts = api;
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

    // ---------- Person Identity ----------

    function createContact(fb, { contact, dbSuffix }) {
        const key = ['createContact', dbSuffix, stableStringify(contact)].join('|');
        return callIdempotent(key, opId =>
            fb.functions().httpsCallable('createContactAdmin')({ contact, opId, dbSuffix })
        );
    }

    async function updateContact(fb, { contactId, contact, dbSuffix }) {
        const r = await fb.functions().httpsCallable('updateContactAdmin')({ contactId, contact, dbSuffix });
        return r.data;
    }

    async function getContact(fb, { contactId, dbSuffix }) {
        const r = await fb.functions().httpsCallable('getContactAdmin')({ contactId, dbSuffix });
        return r.data;
    }

    async function searchContacts(fb, { q, limit, dbSuffix }) {
        const r = await fb.functions().httpsCallable('searchContactsAdmin')({ q, limit, dbSuffix });
        return r.data;
    }

    // ---------- Account-Contact Relations & Periods ----------

    function linkContactToAccount(fb, {
        accountId,
        contactId,
        cargo,
        telefono_corporativo,
        extension,
        correo_corporativo,
        dbSuffix
    }) {
        const key = ['linkContact', dbSuffix, accountId, contactId, cargo].join('|');
        return callIdempotent(key, opId =>
            fb.functions().httpsCallable('linkContactToAccountAdmin')({
                accountId,
                contactId,
                cargo,
                telefono_corporativo,
                extension,
                correo_corporativo,
                opId,
                dbSuffix
            })
        );
    }

    async function updateAccountContact(fb, {
        accountContactId,
        cargo,
        telefono_corporativo,
        extension,
        correo_corporativo,
        dbSuffix
    }) {
        const r = await fb.functions().httpsCallable('updateAccountContactAdmin')({
            accountContactId,
            cargo,
            telefono_corporativo,
            extension,
            correo_corporativo,
            dbSuffix
        });
        return r.data;
    }

    async function deactivateAccountContact(fb, { accountContactId, motivo_salida, dbSuffix }) {
        const r = await fb.functions().httpsCallable('deactivateAccountContactAdmin')({
            accountContactId,
            motivo_salida,
            dbSuffix
        });
        return r.data;
    }

    async function reactivateAccountContact(fb, {
        accountContactId,
        cargo,
        motivo_reingreso,
        telefono_corporativo,
        extension,
        correo_corporativo,
        dbSuffix
    }) {
        const r = await fb.functions().httpsCallable('reactivateAccountContactAdmin')({
            accountContactId,
            cargo,
            motivo_reingreso,
            telefono_corporativo,
            extension,
            correo_corporativo,
            dbSuffix
        });
        return r.data;
    }

    async function listAccountContacts(fb, { accountId, includeInactive = true, dbSuffix }) {
        const r = await fb.functions().httpsCallable('listAccountContactsAdmin')({
            accountId,
            includeInactive,
            dbSuffix
        });
        return r.data;
    }

    async function listContactPeriods(fb, { accountContactId, dbSuffix }) {
        const r = await fb.functions().httpsCallable('listContactPeriodsAdmin')({
            accountContactId,
            dbSuffix
        });
        return r.data;
    }

    return {
        createContact,
        updateContact,
        getContact,
        searchContacts,
        linkContactToAccount,
        updateAccountContact,
        deactivateAccountContact,
        reactivateAccountContact,
        listAccountContacts,
        listContactPeriods
    };
});
