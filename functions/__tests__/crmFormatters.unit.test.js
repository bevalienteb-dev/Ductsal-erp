// functions/__tests__/crmFormatters.unit.test.js
// UNIT layer for crm_formatters.js and its integration with app_core.js and index.html.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const crmFormatters = require('../../crm_formatters.js');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Minimal global mocks needed by app_core.js top-level execution in Node.js
if (!global.window) {
  global.window = {
    location: { protocol: 'https:', hostname: 'erp.ductsal.com', href: 'https://erp.ductsal.com' },
    _docStore: new Map()
  };
}
if (!global.document) {
  global.document = {
    getElementById: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, innerHTML: '', textContent: '', value: '' }),
    addEventListener: () => {}
  };
}
if (!global.firebase) {
  global.firebase = {
    initializeApp: () => ({}),
    firestore: () => ({ settings: () => {}, collection: () => ({ doc: () => ({ set: () => {}, get: async () => ({ exists: false }) }) }) }),
    storage: () => ({ ref: () => ({}) }),
    auth: () => ({ currentUser: null, onAuthStateChanged: () => () => {} })
  };
}
if (!global.localStorage) {
  global.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
}

const appCore = require('../../app_core.js');

describe('Fase M1.1: crm_formatters.js Unit Tests', () => {

  describe('1. Module Interface and Exports', () => {
    test('crm_formatters.js exports all four target functions', () => {
      expect(typeof crmFormatters.formatCurrency).toBe('function');
      expect(typeof crmFormatters.formatDate).toBe('function');
      expect(typeof crmFormatters.normalizeWhatsAppNumber).toBe('function');
      expect(typeof crmFormatters.getDaysDifference).toBe('function');
    });

    test('browser UMD global binding works when window is defined', () => {
      const mockWindow = {};
      const factory = require('../../crm_formatters.js');
      // Execute the IIFE factory in an isolated context with mock window
      const code = fs.readFileSync(path.join(ROOT, 'crm_formatters.js'), 'utf8');
      const fn = new Function('window', 'module', 'exports', code);
      fn(mockWindow, undefined, undefined);
      expect(mockWindow.CrmFormatters).toBeDefined();
      expect(typeof mockWindow.CrmFormatters.formatCurrency).toBe('function');
      expect(mockWindow.formatCurrency).toBe(mockWindow.CrmFormatters.formatCurrency);
      expect(mockWindow.formatDate).toBe(mockWindow.CrmFormatters.formatDate);
      expect(mockWindow.normalizeWhatsAppNumber).toBe(mockWindow.CrmFormatters.normalizeWhatsAppNumber);
      expect(mockWindow.getDaysDifference).toBe(mockWindow.CrmFormatters.getDaysDifference);
    });
  });

  describe('2. formatCurrency (canonical & edge cases)', () => {
    test('formats positive amounts with currency symbol and thousands separator', () => {
      const formatted = crmFormatters.formatCurrency(15420.5);
      // Normalized match for MXN currency formatting ($15,420.50)
      expect(formatted).toMatch(/\$15,420\.50/);
    });

    test('formats zero as $0.00', () => {
      expect(crmFormatters.formatCurrency(0)).toMatch(/\$0\.00/);
    });

    test('handles null, undefined, and empty string safely as 0', () => {
      expect(crmFormatters.formatCurrency(null)).toMatch(/\$0\.00/);
      expect(crmFormatters.formatCurrency(undefined)).toMatch(/\$0\.00/);
      expect(crmFormatters.formatCurrency('')).toMatch(/\$0\.00/);
    });

    test('formats negative amounts correctly', () => {
      const neg = crmFormatters.formatCurrency(-500);
      expect(neg).toMatch(/-.*500\.00/);
    });

    test('formats large amounts with multiple commas', () => {
      const large = crmFormatters.formatCurrency(1000000);
      expect(large).toMatch(/\$1,000,000\.00/);
    });
  });

  describe('3. formatDate (canonical & edge cases)', () => {
    test('returns "-" for null, undefined, empty, or whitespace', () => {
      expect(crmFormatters.formatDate(null)).toBe('-');
      expect(crmFormatters.formatDate(undefined)).toBe('-');
      expect(crmFormatters.formatDate('')).toBe('-');
      expect(crmFormatters.formatDate('   ')).toBe('-');
    });

    test('formats YYYY-MM-DD strings directly as DD/MM/YYYY without timezone drift', () => {
      expect(crmFormatters.formatDate('2026-10-28')).toBe('28/10/2026');
      expect(crmFormatters.formatDate('2026-01-05')).toBe('05/01/2026');
      expect(crmFormatters.formatDate('2025-12-31')).toBe('31/12/2025');
    });

    test('formats ISO strings in America/El_Salvador timezone', () => {
      const formatted = crmFormatters.formatDate('2026-03-20T18:00:00.000Z');
      expect(formatted).toContain('20/03/2026');
      expect(formatted).toMatch(/\d{2}:\d{2}/);
    });

    test('returns "-" for invalid date inputs', () => {
      expect(crmFormatters.formatDate('fecha_invalida')).toBe('-');
      expect(crmFormatters.formatDate('not-a-date')).toBe('-');
    });
  });

  describe('4. normalizeWhatsAppNumber (canonical & edge cases)', () => {
    test('normalizes numbers with country code and formatting', () => {
      expect(crmFormatters.normalizeWhatsAppNumber('+503 7123-4567')).toBe('50371234567');
      expect(crmFormatters.normalizeWhatsAppNumber('+1 (555) 234-5678')).toBe('15552345678');
      expect(crmFormatters.normalizeWhatsAppNumber('7123-4567')).toBe('71234567');
      expect(crmFormatters.normalizeWhatsAppNumber('2250 0000')).toBe('22500000');
    });

    test('returns null for null, undefined, empty, non-string, or short numbers', () => {
      expect(crmFormatters.normalizeWhatsAppNumber(null)).toBeNull();
      expect(crmFormatters.normalizeWhatsAppNumber(undefined)).toBeNull();
      expect(crmFormatters.normalizeWhatsAppNumber('')).toBeNull();
      expect(crmFormatters.normalizeWhatsAppNumber('12345')).toBeNull(); // < 8 digits
      expect(crmFormatters.normalizeWhatsAppNumber('abc-def')).toBeNull(); // No digits
      expect(crmFormatters.normalizeWhatsAppNumber(50371234567)).toBeNull(); // non-string
    });
  });

  describe('5. getDaysDifference (canonical & edge cases)', () => {
    test('calculates days elapsed since a past date', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const diff = crmFormatters.getDaysDifference(fiveDaysAgo);
      expect(diff).toBe(5);
    });

    test('returns 0 for today', () => {
      const now = new Date();
      expect(crmFormatters.getDaysDifference(now)).toBe(0);
    });
  });

  describe('6. Script Loading Order in index.html (Static Guards)', () => {
    test('index.html loads crm_formatters.js before app_core.js', () => {
      const fmtIndex = indexHtml.indexOf('crm_formatters.js');
      const appCoreIndex = indexHtml.indexOf('app_core.js');
      expect(fmtIndex).toBeGreaterThan(-1);
      expect(appCoreIndex).toBeGreaterThan(-1);
      expect(fmtIndex).toBeLessThan(appCoreIndex);
    });

    test('index.html loads crm_formatters.js after crm_ui.js', () => {
      const fmtIndex = indexHtml.indexOf('crm_formatters.js');
      const uiIndex = indexHtml.indexOf('crm_ui.js');
      expect(uiIndex).toBeGreaterThan(-1);
      expect(fmtIndex).toBeGreaterThan(uiIndex);
    });
  });

  describe('7. Equivalence and Delegation in app_core.js', () => {
    test('app_core exports the target functions matching crm_formatters.js output', () => {
      expect(typeof appCore.formatCurrency).toBe('function');
      expect(typeof appCore.formatDate).toBe('function');
      expect(typeof appCore.normalizeWhatsAppNumber).toBe('function');
      expect(typeof appCore.getDaysDifference).toBe('function');

      // Test equivalence across inputs
      expect(appCore.formatCurrency(2500)).toBe(crmFormatters.formatCurrency(2500));
      expect(appCore.formatDate('2026-10-28')).toBe(crmFormatters.formatDate('2026-10-28'));
      expect(appCore.normalizeWhatsAppNumber('+503 7123-4567')).toBe(crmFormatters.normalizeWhatsAppNumber('+503 7123-4567'));
    });
  });

});
