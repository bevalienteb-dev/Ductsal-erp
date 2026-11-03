// functions/__tests__/crmOutbox.unit.test.js
// Unit tests for Write-Ahead Local Outbox Queue (Step 6.3.2 / 6.3.4).
// Tests:
//  - Write-ahead enqueue with initial outcome 'unknown'
//  - Zero-Trust & secrets hygiene: blocks passwords, tokens, links, oobCodes
//  - Outcome updates and dequeue
//  - Session isolation by managerAuthUid
//  - Automatic 24-hour TTL expiration sweep
//  - Error code sanitization into whitelist

const CrmOutbox = require('../../crm_outbox');

describe('CrmOutbox — Write-Ahead Local Outbox Queue Unit Tests', () => {
  beforeEach(() => {
    CrmOutbox.clear();
  });

  describe('1. Enqueue & Write-Ahead Semantics', () => {
    test('enqueues a valid invitation request with default unknown outcome', () => {
      const entry = CrmOutbox.enqueue({
        requestId: 'req-001',
        userId: 'usr-100',
        recipientEmail: 'vendedor@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      expect(entry).toMatchObject({
        requestId: 'req-001',
        userId: 'usr-100',
        recipientEmail: 'vendedor@example.test',
        operation: 'create_user',
        outcome: 'unknown',
        errorCode: null,
        attemptCount: 0,
        lastAttemptAt: null,
        managerAuthUid: 'mgr-alpha'
      });
      expect(typeof entry.enqueuedAt).toBe('number');
    });

    test('throws if required fields are missing', () => {
      expect(() => CrmOutbox.enqueue({
        requestId: 'req-002',
        userId: 'usr-100'
      })).toThrow(/Missing required fields/);
    });
  });

  describe('2. Secrets Hygiene & Zero-Trust Assertions', () => {
    test('rejects enqueue containing sensitive password field', () => {
      expect(() => CrmOutbox.enqueue({
        requestId: 'req-bad-1',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha',
        password: 'PlainTextPassword123!'
      })).toThrow(/Security Violation/);
    });

    test('rejects enqueue containing sensitive token field', () => {
      expect(() => CrmOutbox.enqueue({
        requestId: 'req-bad-2',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha',
        idToken: 'eyJh...'
      })).toThrow(/Security Violation/);
    });

    test('rejects enqueue containing action link with oobCode', () => {
      expect(() => CrmOutbox.enqueue({
        requestId: 'req-bad-3',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha',
        customField: 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=secret123'
      })).toThrow(/Security Violation/);
    });

    test('rejects update containing sensitive token or link fields', () => {
      CrmOutbox.enqueue({
        requestId: 'req-good',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      expect(() => CrmOutbox.update('req-good', {
        password: 'stolen_pwd'
      })).toThrow(/Security Violation/);
    });
  });

  describe('3. Updates, Outcomes, and Dequeue', () => {
    test('updates outcome to accepted upon successful delivery', () => {
      CrmOutbox.enqueue({
        requestId: 'req-accepted',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      const updated = CrmOutbox.update('req-accepted', { outcome: 'accepted' });
      expect(updated.outcome).toBe('accepted');
      expect(updated.errorCode).toBeNull();
    });

    test('updates outcome to failed with sanitized error code upon SDK failure', () => {
      CrmOutbox.enqueue({
        requestId: 'req-failed',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      const updated = CrmOutbox.update('req-failed', {
        outcome: 'failed',
        errorCode: 'auth/too-many-requests'
      });
      expect(updated.outcome).toBe('failed');
      expect(updated.errorCode).toBe('TOO_MANY_REQUESTS');
    });

    test('dequeue cleanly removes record from queue', () => {
      CrmOutbox.enqueue({
        requestId: 'req-remove',
        userId: 'usr-100',
        recipientEmail: 'v@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      expect(CrmOutbox.listPending('mgr-alpha')).toHaveLength(1);
      const dequeued = CrmOutbox.dequeue('req-remove');
      expect(dequeued).toBe(true);
      expect(CrmOutbox.listPending('mgr-alpha')).toHaveLength(0);
    });
  });

  describe('4. Session Isolation by managerAuthUid (SEC-16)', () => {
    test('manager B cannot view or dispatch outbox items enqueued by manager A', () => {
      CrmOutbox.enqueue({
        requestId: 'req-mgr-a',
        userId: 'usr-100',
        recipientEmail: 'v1@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha'
      });

      CrmOutbox.enqueue({
        requestId: 'req-mgr-b',
        userId: 'usr-101',
        recipientEmail: 'v2@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-beta'
      });

      const alphaList = CrmOutbox.listPending('mgr-alpha');
      expect(alphaList).toHaveLength(1);
      expect(alphaList[0].requestId).toBe('req-mgr-a');

      const betaList = CrmOutbox.listPending('mgr-beta');
      expect(betaList).toHaveLength(1);
      expect(betaList[0].requestId).toBe('req-mgr-b');

      const gammaList = CrmOutbox.listPending('mgr-gamma');
      expect(gammaList).toHaveLength(0);
    });
  });

  describe('5. TTL Expiration & Auto-Sweep', () => {
    test('records older than 24 hours are pruned automatically', () => {
      const past25h = Date.now() - (25 * 60 * 60 * 1000);
      CrmOutbox.enqueue({
        requestId: 'req-old',
        userId: 'usr-old',
        recipientEmail: 'old@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha',
        enqueuedAt: past25h
      });

      CrmOutbox.enqueue({
        requestId: 'req-fresh',
        userId: 'usr-fresh',
        recipientEmail: 'fresh@example.test',
        operation: 'create_user',
        managerAuthUid: 'mgr-alpha',
        enqueuedAt: Date.now()
      });

      const pending = CrmOutbox.listPending('mgr-alpha');
      expect(pending).toHaveLength(1);
      expect(pending[0].requestId).toBe('req-fresh');
    });
  });

  describe('6. Error Code Sanitization Whitelist', () => {
    test('sanitizes various SDK and network error formats into allowed tokens', () => {
      expect(CrmOutbox.sanitizeErrorCode({ code: 'auth/too-many-requests' })).toBe('TOO_MANY_REQUESTS');
      expect(CrmOutbox.sanitizeErrorCode({ code: 'auth/network-request-failed' })).toBe('NETWORK_ERROR');
      expect(CrmOutbox.sanitizeErrorCode({ code: 'auth/unauthorized-continue-uri' })).toBe('UNAUTHORIZED_DOMAIN');
      expect(CrmOutbox.sanitizeErrorCode({ code: 'auth/invalid-email' })).toBe('INVALID_RECIPIENT');
      expect(CrmOutbox.sanitizeErrorCode({ message: 'Request timeout' })).toBe('CLIENT_TIMEOUT');
      expect(CrmOutbox.sanitizeErrorCode({ message: 'Network connection was disconnected' })).toBe('NETWORK_DISCONNECTED_IN_FLIGHT');
      expect(CrmOutbox.sanitizeErrorCode({ message: 'random unknown error' })).toBe('UNKNOWN_CLIENT_ERROR');
    });
  });
});
