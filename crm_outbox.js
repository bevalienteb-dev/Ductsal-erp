// crm_outbox.js
// Write-Ahead Local Outbox Queue for Firebase Authentication Invitations (Step 6.3.2 / 6.3.4).
// Principle: Persist authorization ticket in localStorage BEFORE calling network (fb.auth().sendPasswordResetEmail).
// Zero-Trust & Secrets Hygiene:
//  - Never stores passwords, credentials, session tokens, action links or oobCodes.
//  - Strictly scopes records to managerAuthUid (session isolation).
//  - Enforces 24-hour TTL automatic sweep.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmOutbox = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const STORAGE_KEY = 'ductsal_invitation_outbox_v1';
    const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    const ALLOWED_ERROR_CODES = Object.freeze([
        'TOO_MANY_REQUESTS',
        'NETWORK_ERROR',
        'UNAUTHORIZED_DOMAIN',
        'INVALID_RECIPIENT',
        'CLIENT_TIMEOUT',
        'NETWORK_DISCONNECTED_IN_FLIGHT',
        'UNKNOWN_CLIENT_ERROR'
    ]);

    const FORBIDDEN_SECRET_KEYS = Object.freeze([
        'password',
        'token',
        'secret',
        'link',
        'oobCode',
        'apiKey',
        'idToken',
        'refreshToken'
    ]);

    // Fallback memory storage when localStorage is unavailable (e.g. some Node test environments)
    const memoryStore = new Map();

    function getStorage() {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
            return localStorage;
        }
        return {
            getItem: (k) => memoryStore.get(k) || null,
            setItem: (k, v) => memoryStore.set(k, String(v)),
            removeItem: (k) => memoryStore.delete(k)
        };
    }

    function assertNoSecrets(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
            const lowerKey = k.toLowerCase();
            for (const forbidden of FORBIDDEN_SECRET_KEYS) {
                if (lowerKey.includes(forbidden.toLowerCase())) {
                    throw new Error(`Security Violation: Outbox cannot store sensitive field "${k}"`);
                }
            }
            if (typeof obj[k] === 'string') {
                const val = obj[k];
                if (val.includes('oobCode=') || val.includes('apiKey=')) {
                    throw new Error(`Security Violation: Outbox cannot store raw action URLs or OOB codes in "${k}"`);
                }
            }
        }
    }

    function readRaw() {
        try {
            const raw = getStorage().getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    function writeRaw(records) {
        getStorage().setItem(STORAGE_KEY, JSON.stringify(records));
    }

    function sanitizeErrorCode(err) {
        if (!err) return null;
        const code = String((err && err.code) || err || '').toLowerCase();
        const message = String((err && err.message) || '').toLowerCase();

        if (code.includes('too-many-requests') || message.includes('too many requests')) {
            return 'TOO_MANY_REQUESTS';
        }
        if (code.includes('disconnected') || message.includes('disconnected')) {
            return 'NETWORK_DISCONNECTED_IN_FLIGHT';
        }
        if (code.includes('network-request-failed') || code.includes('network_error') || message.includes('network')) {
            return 'NETWORK_ERROR';
        }
        if (code.includes('unauthorized-continue-uri') || code.includes('unauthorized-domain')) {
            return 'UNAUTHORIZED_DOMAIN';
        }
        if (code.includes('invalid-email') || code.includes('user-not-found')) {
            return 'INVALID_RECIPIENT';
        }
        if (code.includes('timeout') || message.includes('timeout') || code.includes('client_timeout')) {
            return 'CLIENT_TIMEOUT';
        }
        return 'UNKNOWN_CLIENT_ERROR';
    }

    /**
     * Enqueue a new invitation request BEFORE calling network (Write-Ahead).
     */
    function enqueue(record) {
        if (!record || typeof record !== 'object') {
            throw new Error('Record object is required');
        }
        const { requestId, userId, recipientEmail, operation, managerAuthUid } = record;
        if (!requestId || !userId || !recipientEmail || !operation || !managerAuthUid) {
            throw new Error('Missing required fields for Outbox entry');
        }

        assertNoSecrets(record);

        const now = Date.now();
        const entry = {
            requestId: String(requestId),
            userId: String(userId),
            recipientEmail: String(recipientEmail).trim().toLowerCase(),
            operation: operation === 'create_user' ? 'create_user' : 'resend_invitation',
            outcome: record.outcome || 'unknown',
            errorCode: record.errorCode ? sanitizeErrorCode(record.errorCode) : null,
            enqueuedAt: record.enqueuedAt || now,
            attemptCount: 0,
            lastAttemptAt: null,
            managerAuthUid: String(managerAuthUid)
        };

        const records = readRaw().filter(r => r.requestId !== entry.requestId);
        records.push(entry);
        writeRaw(records);
        return entry;
    }

    /**
     * Update an existing record in the outbox queue.
     */
    function update(requestId, updates) {
        if (!requestId) return null;
        assertNoSecrets(updates);

        const records = readRaw();
        const idx = records.findIndex(r => r.requestId === requestId);
        if (idx === -1) return null;

        const current = records[idx];
        if (updates.outcome && ['accepted', 'failed', 'unknown'].includes(updates.outcome)) {
            current.outcome = updates.outcome;
        }
        if (updates.errorCode !== undefined) {
            current.errorCode = updates.errorCode ? sanitizeErrorCode(updates.errorCode) : null;
        }
        if (typeof updates.attemptCount === 'number') {
            current.attemptCount = updates.attemptCount;
        }
        if (typeof updates.lastAttemptAt === 'number') {
            current.lastAttemptAt = updates.lastAttemptAt;
        }

        records[idx] = current;
        writeRaw(records);
        return current;
    }

    /**
     * Dequeue a record from the outbox after confirmed backend recording.
     */
    function dequeue(requestId) {
        if (!requestId) return false;
        const records = readRaw();
        const filtered = records.filter(r => r.requestId !== requestId);
        const changed = filtered.length !== records.length;
        if (changed) {
            writeRaw(filtered);
        }
        return changed;
    }

    /**
     * List all pending records for a specific manager session.
     * Automatically sweeps records older than 24 hours.
     */
    function listPending(managerAuthUid) {
        const now = Date.now();
        const raw = readRaw();
        const valid = [];
        let pruned = false;

        for (const r of raw) {
            const age = now - (r.enqueuedAt || 0);
            if (age <= TTL_MS) {
                valid.push(r);
            } else {
                pruned = true; // Swept expired record
            }
        }

        if (pruned) {
            writeRaw(valid);
        }

        if (!managerAuthUid) return [];
        // Session isolation: only return records belonging to the current manager
        return valid.filter(r => r.managerAuthUid === managerAuthUid);
    }

    /**
     * Clear all outbox entries (for testing or manager logout).
     */
    function clear(managerAuthUid) {
        if (!managerAuthUid) {
            writeRaw([]);
            return;
        }
        const remaining = readRaw().filter(r => r.managerAuthUid !== managerAuthUid);
        writeRaw(remaining);
    }

    return {
        STORAGE_KEY,
        TTL_MS,
        ALLOWED_ERROR_CODES,
        sanitizeErrorCode,
        enqueue,
        update,
        dequeue,
        listPending,
        clear,
        _assertNoSecrets: assertNoSecrets
    };
});
