// functions/__tests__/createUserAdmin.uidPersistence.test.js
// Auth creates the account but persisting its UID fails: a retry must NOT create a second account.
// firebase-admin / firebase-functions are replaced by in-memory fakes so no emulator is needed.

jest.mock('firebase-functions', () => {
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const makeHttps = (opts = {}) => ({
    HttpsError,
    onCall: handler => {
      handler.__runWithOptions = opts;
      return handler;
    }
  });
  return {
    https: makeHttps(),
    runWith: options => ({ https: makeHttps(options) })
  };
}, { virtual: true });

jest.mock('firebase-admin', () => {
  const state = {
    docs: {},          // 'collection/id' -> data
    authUsers: {},     // email -> { uid, email }
    createUserCalls: 0,
    // Failure injection hooks.
    failTxSet: null,   // (path, data) => boolean – make a transactional write throw
    failDirectSet: null // (path, data) => boolean – make ref.set throw
  };

  const makeRef = (col, id) => {
    const path = `${col}/${id}`;
    return {
      path,
      async create(data) {
        if (state.docs[path]) {
          const err = new Error('ALREADY_EXISTS');
          err.code = 6;
          throw err;
        }
        state.docs[path] = { ...data };
      },
      async get() { return { exists: !!state.docs[path], data: () => state.docs[path] }; },
      async set(data, opts = {}) {
        if (state.failDirectSet && state.failDirectSet(path, data)) throw new Error('direct set failed');
        state.docs[path] = opts.merge ? { ...(state.docs[path] || {}), ...data } : { ...data };
      },
      async delete() { delete state.docs[path]; }
    };
  };

  const firestore = () => ({
    collection: col => ({
      doc: id => makeRef(col, id),
      // Collection read used by createUserAdmin to detect an existing profile with the same email.
      async get() {
        const prefix = `${col}/`;
        return {
          docs: Object.keys(state.docs)
            .filter(k => k.startsWith(prefix))
            .map(k => ({ id: k.slice(prefix.length), data: () => state.docs[k] }))
        };
      }
    }),
    async runTransaction(fn) {
      const t = {
        get: ref => ref.get(),
        set: (ref, data, opts = {}) => {
          if (state.failTxSet && state.failTxSet(ref.path, data)) throw new Error('transaction set failed');
          state.docs[ref.path] = opts.merge ? { ...(state.docs[ref.path] || {}), ...data } : { ...data };
        }
      };
      return fn(t);
    }
  });
  firestore.FieldValue = { serverTimestamp: () => 'SERVER_TS' };
  firestore.Timestamp = { fromDate: d => ({ toDate: () => d }) };

  const auth = () => ({
    async getUser(uid) { return { uid, customClaims: { manager: true } }; },
    async getUserByEmail(email) {
      if (state.authUsers[email]) return state.authUsers[email];
      const err = new Error('auth/user-not-found');
      err.code = 'auth/user-not-found';
      throw err;
    },
    async createUser({ email }) {
      state.createUserCalls += 1;
      const user = { uid: `uid_${state.createUserCalls}_${email}`, email };
      state.authUsers[email] = user;
      return user;
    },
    async deleteUser(uid) {
      Object.keys(state.authUsers).forEach(e => { if (state.authUsers[e].uid === uid) delete state.authUsers[e]; });
    },
    async setCustomUserClaims() {}
  });

  return { initializeApp: () => {}, firestore, auth, __state: state };
}, { virtual: true });

const admin = require('firebase-admin');
const { createUserAdmin } = require('../index');
const state = admin.__state;

const ctx = { auth: { uid: 'managerUid' } };
const payload = { email: 'new.user@test.com', nombre: 'New User', role: 'vendedor', opId: 'opUidPersist' };
const failAuthCreatedWrite = (path, data) => path === 'userOps/opUidPersist' && data.status === 'authCreated';

beforeEach(() => {
  state.docs = {
    'users_prod/default_mgr': { id: 'default_mgr', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Manager' }
  };
  state.authUsers = {};
  state.createUserCalls = 0;
  state.failTxSet = null;
  state.failDirectSet = null;
});

test('Auth creates account but UID persistence fails → manualReview, retry does not create a second account', async () => {
  state.failTxSet = failAuthCreatedWrite;

  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({
    code: 'failed-precondition',
    message: /Manual review required/
  });
  expect(state.createUserCalls).toBe(1);
  // The orphan account is flagged with its UID for the reviewer; it is neither deleted nor adopted.
  expect(state.docs['userOps/opUidPersist']).toMatchObject({
    status: 'manualReview',
    uid: state.authUsers[payload.email].uid
  });
  expect(state.docs['users_prod/' + state.authUsers[payload.email].uid]).toBeUndefined();
  expect(state.docs['userOpsLocks/opUidPersist']).toBeUndefined();

  // Retry with the same opId (failure injection removed, as if Firestore recovered).
  state.failTxSet = null;
  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(state.createUserCalls).toBe(1);
  expect(Object.keys(state.authUsers)).toHaveLength(1);
});

test('UID persistence AND manualReview write both fail → authCreating marker still blocks retry', async () => {
  state.failTxSet = failAuthCreatedWrite;
  state.failDirectSet = (path, data) => path === 'userOps/opUidPersist' && data.status === 'manualReview';

  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(state.createUserCalls).toBe(1);
  expect(state.docs['userOps/opUidPersist'].status).toBe('authCreating');

  state.failTxSet = null;
  state.failDirectSet = null;
  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(state.createUserCalls).toBe(1);
  // The retry escalates the uncertain operation to manual review.
  expect(state.docs['userOps/opUidPersist'].status).toBe('manualReview');
});

test('expired lock + uncertain previous attempt → no createUser, escalates to manualReview', async () => {
  state.docs['userOps/opUidPersist'] = {
    status: 'authCreating',
    requesterUid: ctx.auth.uid,
    fingerprint: require('crypto').createHash('sha256')
      .update(JSON.stringify({ email: payload.email, nombre: payload.nombre, role: payload.role })).digest('hex')
  };
  state.docs['userOpsLocks/opUidPersist'] = {
    token: 'dead-owner',
    expiresAt: { toDate: () => new Date(Date.now() - 1000) }
  };

  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(state.createUserCalls).toBe(0);
  expect(state.docs['userOps/opUidPersist'].status).toBe('manualReview');
});

test('existing Auth account for the email is never adopted (conflict, no createUser)', async () => {
  state.authUsers[payload.email] = { uid: 'foreignUid', email: payload.email };

  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({ code: 'already-exists' });
  expect(state.createUserCalls).toBe(0);
  expect(state.docs['userOps/opUidPersist'].status).toBe('conflict');
  expect(state.authUsers[payload.email].uid).toBe('foreignUid');
});

test('happy path still succeeds and a repeated call returns the stored result', async () => {
  const first = await createUserAdmin(payload, ctx);
  expect(first).toHaveProperty('uid');
  expect(state.docs['userOps/opUidPersist']).toMatchObject({ status: 'succeeded', uid: first.uid });
  expect(state.docs['userOpsLocks/opUidPersist']).toBeUndefined();

  const second = await createUserAdmin(payload, ctx);
  expect(second.uid).toBe(first.uid);
  expect(state.createUserCalls).toBe(1);
  expect(state.docs['userOpsLocks/opUidPersist']).toBeUndefined();
});
