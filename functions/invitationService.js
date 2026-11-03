// functions/invitationService.js
// Service for generating password setup / activation links and decoupled delivery of invitation emails.
// Prepared for integration with transactional email providers (Resend / SendGrid) in subsequent phases.

'use strict';

/**
 * Production ActionCodeSettings.
 * Reserved strictly for production deployment on https://erp.ductsal.com.
 * Preserves handleCodeInApp: false as standard web redirect.
 */
const PRODUCTION_ACTION_CODE_SETTINGS = Object.freeze({
  url: 'https://erp.ductsal.com/login?mode=activate',
  handleCodeInApp: false
});

/**
 * Local Development & Testing ActionCodeSettings.
 * Points strictly to the local development server (port 8123 by default, or ERP_LOCAL_PORT).
 * Completely eliminates any reliance on production URLs in local/emulator environments.
 */
const LOCAL_DEV_PORT = process.env.LOCAL_DEV_PORT || process.env.ERP_LOCAL_PORT || '8123';
const LOCAL_ACTION_CODE_SETTINGS = Object.freeze({
  url: `http://127.0.0.1:${LOCAL_DEV_PORT}/login?mode=activate`,
  handleCodeInApp: false
});

/**
 * Check whether execution is inside a controlled test/emulator environment.
 * In controlled environments, links can be returned to automated test callers for verification.
 * In production, links are never returned in callable responses.
 */
function isControlledEnvironment(env = process.env) {
  const e = env || {};
  return e.NODE_ENV === 'test' ||
         e.FUNCTIONS_EMULATOR === 'true' ||
         e.FIREBASE_AUTH_EMULATOR_HOST !== undefined;
}

/**
 * Determine the appropriate ActionCodeSettings based on the active environment.
 * In controlled test or emulator environments (process.env.NODE_ENV === 'test',
 * FUNCTIONS_EMULATOR, FIREBASE_AUTH_EMULATOR_HOST, or project demo-ductsal-local),
 * returns LOCAL_ACTION_CODE_SETTINGS (http://127.0.0.1:<port>/login?mode=activate).
 * In production, returns PRODUCTION_ACTION_CODE_SETTINGS (https://erp.ductsal.com/login?mode=activate).
 */
function getActionCodeSettings(env = process.env) {
  const e = env || {};
  const isLocal = isControlledEnvironment(e) ||
    e.GCLOUD_PROJECT === 'demo-ductsal-local' ||
    e.GOOGLE_CLOUD_PROJECT === 'demo-ductsal-local' ||
    e.FIREBASE_AUTH_EMULATOR_HOST !== undefined;
  return isLocal ? LOCAL_ACTION_CODE_SETTINGS : PRODUCTION_ACTION_CODE_SETTINGS;
}

// ACTION_CODE_SETTINGS evaluates dynamically according to the active environment
const ACTION_CODE_SETTINGS = Object.freeze({
  get url() {
    return getActionCodeSettings().url;
  },
  get handleCodeInApp() {
    return false;
  }
});

/**
 * Granular invitation lifecycle states:
 * - PENDING: Profile created in Firestore, link not yet generated.
 * - LINK_GENERATED: Link successfully generated in Auth, prior to delivery preparation.
 * - PREPARED: Message prepared by local/isolated driver; no external email sent.
 * - PROVIDER_ACCEPTED: Message accepted by external provider queue (Resend/SendGrid) for delivery.
 * - DELIVERED: Message confirmed delivered to recipient mailbox (via webhook/receipt).
 * - DELIVERY_FAILED: Message preparation or provider transmission failed.
 * - LINK_FAILED: Link generation failed in Firebase Auth.
 * - ACTIVATED: User redeemed link, set password and completed first sign-in.
 */
const INVITATION_STATUS = Object.freeze({
  PENDING: 'pending',
  LINK_GENERATED: 'link_generated',
  PREPARED: 'prepared',
  PROVIDER_ACCEPTED: 'provider_accepted',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  LINK_FAILED: 'link_failed',
  ACTIVATED: 'activated'
});

/**
 * Generate a secure password setup / invitation link using Firebase Admin Auth.
 * @param {object} auth - Firebase Admin Auth instance.
 * @param {string} email - Recipient email.
 * @param {object} settings - Optional ActionCodeSettings override.
 * @returns {Promise<string>} Action link.
 */
async function generateInvitationLink(auth, email, settings = null) {
  if (!auth) throw new Error('Auth instance is required');
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Valid email is required to generate invitation link');
  }
  if (typeof auth.generatePasswordResetLink !== 'function') {
    throw new Error('generatePasswordResetLink is not available on Auth instance');
  }
  const effectiveSettings = settings || getActionCodeSettings();
  return auth.generatePasswordResetLink(email.trim().toLowerCase(), effectiveSettings);
}

/**
 * Default isolated delivery driver.
 * Prepares the dispatch record without transmitting real emails to external networks.
 * Reflects sent: false and delivery: 'prepared'.
 */
async function defaultPreparedDriver({ to, subject, nombre, role, isResend, metadata }) {
  return {
    id: `prep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    to,
    subject,
    nombre,
    role,
    isResend: !!isResend,
    channel: 'prepared_driver',
    sent: false,
    delivery: 'prepared',
    status: INVITATION_STATUS.PREPARED,
    preparedAt: new Date().toISOString(),
    metadata: metadata || {}
  };
}

/**
 * Decoupled Invitation Dispatcher.
 * Acts as an isolated abstraction that validates, prepares, and dispatches
 * invitation messages through pluggable drivers without sending unauthorized external traffic.
 */
class InvitationDispatcher {
  constructor(customDriver = null) {
    this.driver = customDriver || defaultPreparedDriver;
    this.dispatchedLog = [];
  }

  /**
   * Set a custom delivery driver (e.g. for failure simulation or future provider drivers).
   * @param {Function} driverFn
   */
  setDriver(driverFn) {
    this.driver = driverFn || defaultPreparedDriver;
  }

  /**
   * Reset driver to default prepared driver.
   */
  resetDriver() {
    this.driver = defaultPreparedDriver;
    this.dispatchedLog = [];
  }

  /**
   * Dispatch an invitation email.
   * @param {object} params
   * @returns {Promise<object>} Dispatch record.
   */
  async dispatchInvitation({ email, nombre, role, link, isResend = false, metadata = {} }) {
    if (!email) throw new Error('Recipient email is required');
    if (!link) throw new Error('Invitation link is required');

    const subject = isResend
      ? 'DUCTSAL ERP — Reenvío de Invitación y Activación de Cuenta'
      : 'DUCTSAL ERP — Invitación y Activación de Cuenta';

    const payload = {
      to: email.trim().toLowerCase(),
      subject,
      link,
      nombre: nombre || 'Usuario',
      role: role || 'vendedor',
      isResend,
      metadata
    };

    const record = await this.driver(payload);

    // Sanitize in-memory log: never retain raw links or action codes in logs
    const sanitizedRecord = { ...record };
    if (sanitizedRecord.link) {
      delete sanitizedRecord.link;
    }
    this.dispatchedLog.push(sanitizedRecord);

    return record;
  }
}

// Global singleton dispatcher instance
const invitationDispatcher = new InvitationDispatcher();

/**
 * Whitelist of sanitized error codes permitted for reporting invitation outcomes.
 */
const ALLOWED_ERROR_CODES = Object.freeze([
  'TOO_MANY_REQUESTS',
  'NETWORK_ERROR',
  'UNAUTHORIZED_DOMAIN',
  'INVALID_RECIPIENT',
  'CLIENT_TIMEOUT',
  'NETWORK_DISCONNECTED_IN_FLIGHT',
  'UNKNOWN_CLIENT_ERROR'
]);

/**
 * Builds the initial invitation data structure for Firestore user profiles.
 * Initializes sentCount and preparedCount to 0, ensuring no premature increments.
 * Sets decoupled lifecycle status to pending and lastRequestStatus to pending.
 */
function buildInitialInvitation(email) {
  return {
    status: INVITATION_STATUS.PENDING,
    lastRequestStatus: 'pending',
    lastRequestAt: null,
    lastAcceptedAt: null,
    lastError: null,
    sentCount: 0,
    preparedCount: 0,
    lastPreparedAt: null,
    lastSentAt: null,
    recipientEmail: (email || '').trim().toLowerCase()
  };
}

module.exports = {
  ACTION_CODE_SETTINGS,
  PRODUCTION_ACTION_CODE_SETTINGS,
  LOCAL_ACTION_CODE_SETTINGS,
  getActionCodeSettings,
  INVITATION_STATUS,
  ALLOWED_ERROR_CODES,
  isControlledEnvironment,
  generateInvitationLink,
  InvitationDispatcher,
  invitationDispatcher,
  buildInitialInvitation
};
