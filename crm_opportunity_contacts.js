// crm_opportunity_contacts.js
// Browser SDK for Opportunity Contacts & Roles (Phase 2, Block 2).
// Connects UI components with Cloud Functions callables for Opportunity Participants,
// Role Catalogue, Primary Contact synchronization, and Opportunity Account changes.
// Follows existing UMD/IIFE pattern from crm_contacts.js.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmOpportunityContacts = api;
        if (typeof window !== 'undefined') {
            window.CrmOpportunityContacts = api;
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

    // ---------- Role Catalogue ----------

    async function listOpportunityContactRoles(fb, { includeInactive = false, dbSuffix } = {}) {
        const r = await fb.functions().httpsCallable('listOpportunityContactRolesAdmin')({
            includeInactive,
            dbSuffix
        });
        return r.data;
    }

    async function manageOpportunityContactRole(fb, { roleId, name, activo, orden, action, dbSuffix } = {}) {
        const r = await fb.functions().httpsCallable('manageOpportunityContactRoleAdmin')({
            roleId,
            name,
            activo,
            orden,
            action,
            dbSuffix
        });
        return r.data;
    }

    // ---------- Opportunity Participants ----------

    function addOpportunityContact(fb, {
        opportunityId,
        accountContactId,
        roleId,
        notes,
        isPrimary,
        dbSuffix
    } = {}) {
        const key = ['addOppContact', dbSuffix, opportunityId, accountContactId, roleId].join('|');
        return callIdempotent(key, () =>
            fb.functions().httpsCallable('addOpportunityContactAdmin')({
                opportunityId,
                accountContactId,
                roleId,
                notes,
                isPrimary: isPrimary === true,
                dbSuffix
            })
        );
    }

    async function updateOpportunityContactRole(fb, {
        opportunityContactId,
        roleId,
        notes,
        dbSuffix
    } = {}) {
        const r = await fb.functions().httpsCallable('updateOpportunityContactRoleAdmin')({
            opportunityContactId,
            roleId,
            notes,
            dbSuffix
        });
        return r.data;
    }

    async function setOpportunityPrimaryContact(fb, {
        opportunityId,
        opportunityContactId,
        expectedVersion,
        dbSuffix
    } = {}) {
        const r = await fb.functions().httpsCallable('setOpportunityPrimaryContactAdmin')({
            opportunityId,
            opportunityContactId,
            expectedVersion,
            dbSuffix
        });
        return r.data;
    }

    async function removeOpportunityContact(fb, {
        opportunityContactId,
        motivo,
        dbSuffix
    } = {}) {
        const r = await fb.functions().httpsCallable('removeOpportunityContactAdmin')({
            opportunityContactId,
            motivo,
            dbSuffix
        });
        return r.data;
    }

    async function listOpportunityContacts(fb, {
        opportunityId,
        includeInactive = false,
        dbSuffix
    } = {}) {
        const r = await fb.functions().httpsCallable('listOpportunityContactsAdmin')({
            opportunityId,
            includeInactive,
            dbSuffix
        });
        return r.data;
    }

    // ---------- Account Change ----------

    async function changeOpportunityAccount(fb, {
        opportunityId,
        newAccountId,
        motivo,
        dbSuffix
    } = {}) {
        const r = await fb.functions().httpsCallable('changeOpportunityAccountAdmin')({
            opportunityId,
            newAccountId,
            motivo,
            dbSuffix
        });
        return r.data;
    }

    return {
        listOpportunityContactRoles,
        manageOpportunityContactRole,
        addOpportunityContact,
        updateOpportunityContactRole,
        setOpportunityPrimaryContact,
        removeOpportunityContact,
        listOpportunityContacts,
        changeOpportunityAccount
    };
});
