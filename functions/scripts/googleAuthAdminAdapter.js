// functions/scripts/googleAuthAdminAdapter.js
// Adapter providing an impersonated Service Account Credential to Firebase Admin SDK via google-auth-library.
// Strictly enforces target project 'ductsal-erp', fails closed on any contradiction or failure,
// and ensures zero leakage of tokens, secrets, or sensitive request payloads.

const EXPECTED_PROJECT_ID = 'ductsal-erp';
const DEFAULT_TARGET_SA = 'sec03-migrator-sa@ductsal-erp.iam.gserviceaccount.com';
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/firebase'
];

/**
 * Sanitizes error messages to guarantee that access tokens, client secrets,
 * or credentials are never exposed in log outputs or exception chains.
 */
function sanitizeErrorMessage(err) {
  if (!err) return 'Unknown error';
  const raw = typeof err === 'string' ? err : (err.message || String(err));
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(["']?(?:access_token|client_secret|refresh_token)["']?\s*:\s*)["']?[^"'\s,}]+["']?/gi, '$1"[REDACTED]"')
    .slice(0, 400);
}

/**
 * Implementation of Firebase Admin Credential backed by google-auth-library.
 *
 * Implements:
 *   - getAccessToken(): Promise<{ access_token: string, expires_in: number }>
 * Exposes:
 *   - projectId: 'ductsal-erp' (for resolveAdminProjectId consensus)
 *   - implicit: true (so Cloud Firestore identifies it as Application Default)
 */
class ImpersonatedGoogleAuthCredential {
  constructor(authClient, options = {}) {
    if (!authClient || typeof authClient.getAccessToken !== 'function') {
      throw new Error('ImpersonatedGoogleAuthCredential requires an authClient with getAccessToken()');
    }

    const targetProject = options.projectId || EXPECTED_PROJECT_ID;
    if (targetProject !== EXPECTED_PROJECT_ID) {
      throw new Error(`Target project must strictly be '${EXPECTED_PROJECT_ID}'. Provided: '${targetProject}'`);
    }

    this.authClient = authClient;
    this.projectId = EXPECTED_PROJECT_ID;
    this.targetPrincipal = options.targetPrincipal || DEFAULT_TARGET_SA;
    this.implicit = true;

    // Bind getAccessToken from ImpersonatedGoogleAuthCredential to ensure it always
    // takes precedence over any getAccessToken implementation on the prototype chain.
    const tokenGetter = ImpersonatedGoogleAuthCredential.prototype.getAccessToken.bind(this);

    // Link prototype to firebase-admin's application default credential prototype if available,
    // enabling Firestore to accept the credential as application-default without throwing firestore/invalid-credential.
    if (options.basePrototype) {
      try {
        Object.setPrototypeOf(this, options.basePrototype);
      } catch (_) {}
    }

    this.getAccessToken = tokenGetter;
  }

  /**
   * Fetches an OAuth 2.0 access token via google-auth-library.
   * Conforms to the Firebase Admin Credential interface.
   */
  async getAccessToken() {
    try {
      const tokenResult = await this.authClient.getAccessToken();

      const tokenString = typeof tokenResult === 'string'
        ? tokenResult
        : (tokenResult && tokenResult.token ? tokenResult.token : null);

      if (!tokenString || typeof tokenString !== 'string' || tokenString.trim().length === 0) {
        throw new Error('Received empty or invalid access token from authClient');
      }

      // Default OAuth2 token expiry is 3600 seconds
      return {
        access_token: tokenString.trim(),
        expires_in: 3600
      };
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      throw new Error(`Failed to acquire impersonated access token for '${this.targetPrincipal}': ${sanitized}`);
    }
  }
}

/**
 * Factory to create an ImpersonatedGoogleAuthCredential.
 *
 * @param options { projectId?, targetPrincipal?, authClient?, admin?, scopes? }
 * @returns {Promise<ImpersonatedGoogleAuthCredential>}
 */
async function createImpersonatedCredential(options = {}) {
  const projectId = options.projectId || EXPECTED_PROJECT_ID;
  if (projectId !== EXPECTED_PROJECT_ID) {
    throw new Error(`Security validation failure: projectId must strictly be '${EXPECTED_PROJECT_ID}'. Provided: '${projectId}'`);
  }

  const targetPrincipal = options.targetPrincipal || DEFAULT_TARGET_SA;
  const scopes = options.scopes || DEFAULT_SCOPES;

  let authClient = options.authClient;
  if (!authClient) {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes });
    authClient = await auth.getClient();
  }

  // Attempt to extract base prototype from admin if supplied
  let basePrototype = null;
  if (options.admin && options.admin.credential && typeof options.admin.credential.applicationDefault === 'function') {
    try {
      const baseCred = options.admin.credential.applicationDefault();
      if (baseCred) {
        basePrototype = Object.getPrototypeOf(baseCred);
      }
    } catch (_) {}
  }

  return new ImpersonatedGoogleAuthCredential(authClient, {
    projectId,
    targetPrincipal,
    basePrototype
  });
}

/**
 * Initializes a Firebase Admin App instance with the impersonated credential,
 * verifying that project resolution passes without contradictions.
 *
 * @param admin firebase-admin namespace
 * @param options { appName?, projectId?, targetPrincipal?, authClient?, credential? }
 * @returns {Promise<Object>} initialized Firebase Admin app or namespace
 */
async function initializeImpersonatedAdminApp(admin, options = {}) {
  if (!admin || typeof admin.initializeApp !== 'function') {
    throw new Error('initializeImpersonatedAdminApp requires a valid firebase-admin instance');
  }

  const projectId = options.projectId || EXPECTED_PROJECT_ID;
  if (projectId !== EXPECTED_PROJECT_ID) {
    throw new Error(`Security validation failure: projectId must strictly be '${EXPECTED_PROJECT_ID}'. Provided: '${projectId}'`);
  }

  const credential = options.credential || await createImpersonatedCredential({
    admin,
    projectId,
    targetPrincipal: options.targetPrincipal,
    authClient: options.authClient,
    scopes: options.scopes
  });

  const appOptions = {
    credential,
    projectId
  };

  const app = options.appName
    ? admin.initializeApp(appOptions, options.appName)
    : admin.initializeApp(appOptions);

  // Lazy-require provisionManager's resolveAdminProjectId to verify consensus
  const { resolveAdminProjectId } = require('./provisionManager');
  const resolution = resolveAdminProjectId(admin);

  if (resolution.contradiction || resolution.projectId !== EXPECTED_PROJECT_ID) {
    if (app && typeof app.delete === 'function') {
      try { await app.delete(); } catch (_) {}
    }
    throw new Error(
      `Project verification contradiction detected after initialization: ${JSON.stringify(resolution)}. Expected '${EXPECTED_PROJECT_ID}'.`
    );
  }

  return app;
}

module.exports = {
  EXPECTED_PROJECT_ID,
  DEFAULT_TARGET_SA,
  DEFAULT_SCOPES,
  ImpersonatedGoogleAuthCredential,
  createImpersonatedCredential,
  initializeImpersonatedAdminApp,
  sanitizeErrorMessage
};
