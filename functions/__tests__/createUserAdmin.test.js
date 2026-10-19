// functions/__tests__/createUserAdmin.test.js
//
// General behaviour tests for createUserAdmin (validation, idempotency keys, rollback and
// state-machine outcomes). Rewritten from the legacy suite so that it is compatible with Jest 29
// and with the current implementation in ../index.js.
//
// Coverage map – legacy cases:
//   unauthenticated / non-manager / missing fields / invalid email / disallowed role .. kept
//   creates a new user successfully (+ custom claims) .............................. kept
//   idempotent: same opId + same payload returns existing uid ....................... already covered by
//       createUserAdmin.uidPersistence.test.js ("happy path ... repeated call"); not duplicated
//   idempotent: same opId + different payload ....................................... kept
//   conflict when email already exists in Auth ...................................... already covered by
//       createUserAdmin.uidPersistence.test.js ("never adopted"); not duplicated
//   rollback when custom claims fail ................................................ kept, adapted
//   Auth query error is internal .................................................... kept, adapted
//   "retries after auth created but operation incomplete (recovery path)" ........... adapted: the
//       implementation NEVER re-executes an existing opId, so the retry is rejected and a new opId is needed
//   rollback when profile write fails ............................................... kept, adapted
//   failure finalizing operation .................................................... adapted: manualReview
//   rollback delete failure ......................................................... adapted: manualReview
//   Firestore non-already-exists error on reservation ............................... kept, adapted
//   concurrent invocations with same opId (no barrier) .............................. kept (natural
//       interleaving; the deterministic barrier variant lives in createUserAdmin.concurrency.test.js)
// Added (uncovered branches of index.js): createUser response lost → manualReview,
//   createUser email-already-exists → conflict, opId used by another user.

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
  // One shared state object: every collection()/doc() call operates on it.
  const state = {
    docs: {},            // 'collection/id' -> data
    authUsers: {},       // email -> { uid, email, claims? }
    createUserCalls: 0,
    // Failure-injection hooks (all reset in beforeEach).
    hooks: {
      getUserByEmail: null,        // (email) => void, may throw
      createUser: null,            // ({email}) => void, may throw BEFORE the account is created
      createUserResponseLost: false, // account IS created, then the call throws
      setCustomUserClaims: null,   // (uid, claims) => void, may throw
      deleteUser: null,            // (uid) => void, may throw
      create: null,                // (path, data) => void, may throw (Firestore create)
      txSet: null,                 // (path, data) => boolean, true → transactional write throws
      directSet: null              // (path, data) => boolean, true → ref.set throws
    }
  };

  const applySet = (path, data, opts = {}) => {
    state.docs[path] = opts.merge ? { ...(state.docs[path] || {}), ...data } : { ...data };
  };

  const makeRef = (col, id) => {
    const path = `${col}/${id}`;
    return {
      path,
      async create(data) {
        if (state.hooks.create) state.hooks.create(path, data);
        if (state.docs[path]) {
          const err = new Error('ALREADY_EXISTS');
          err.code = 6;
          throw err;
        }
        state.docs[path] = { ...data };
      },
      async get() { return { exists: !!state.docs[path], data: () => state.docs[path] }; },
      async set(data, opts = {}) {
        if (state.hooks.directSet && state.hooks.directSet(path, data)) throw new Error('direct set failed');
        applySet(path, data, opts);
      },
      async update(data) {
        if (!state.docs[path]) throw new Error('NOT_FOUND');
        state.docs[path] = { ...state.docs[path], ...data };
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
          if (state.hooks.txSet && state.hooks.txSet(ref.path, data)) throw new Error('transaction set failed');
          applySet(ref.path, data, opts);
        },
        update: (ref, data) => { state.docs[ref.path] = { ...(state.docs[ref.path] || {}), ...data }; },
        delete: ref => { delete state.docs[ref.path]; }
      };
      return fn(t);
    }
  });
  firestore.FieldValue = { serverTimestamp: () => 'SERVER_TS' };
  firestore.Timestamp = { fromDate: d => ({ toDate: () => d }) };

  const managers = ['managerUid', 'otherManagerUid'];
  const auth = () => ({
    async getUser(uid) {
      return { uid, customClaims: managers.includes(uid) ? { manager: true } : {} };
    },
    async getUserByEmail(email) {
      if (state.hooks.getUserByEmail) state.hooks.getUserByEmail(email);
      if (state.authUsers[email]) return state.authUsers[email];
      const err = new Error('User not found');
      err.code = 'auth/user-not-found';
      throw err;
    },
    async createUser({ email }) {
      if (state.hooks.createUser) state.hooks.createUser({ email });
      state.createUserCalls += 1;
      const user = { uid: `uid_${state.createUserCalls}_${email}`, email };
      state.authUsers[email] = user;
      if (state.hooks.createUserResponseLost) {
        const err = new Error('network error: response lost');
        err.code = 'auth/network-request-failed';
        throw err;
      }
      return { uid: user.uid };
    },
    async setCustomUserClaims(uid, claims) {
      if (state.hooks.setCustomUserClaims) state.hooks.setCustomUserClaims(uid, claims);
      const user = Object.values(state.authUsers).find(u => u.uid === uid);
      if (!user) throw new Error('User not found');
      user.claims = claims;
    },
    async deleteUser(uid) {
      if (state.hooks.deleteUser) state.hooks.deleteUser(uid);
      Object.keys(state.authUsers).forEach(e => {
        if (state.authUsers[e].uid === uid) delete state.authUsers[e];
      });
    }
  });

  return { initializeApp: () => {}, firestore, auth, __state: state };
}, { virtual: true });

// Mocks are registered above, so ../index binds to the fakes.
const admin = require('firebase-admin');
const { createUserAdmin } = require('../index');
const state = admin.__state;

const ctx = { auth: { uid: 'managerUid' } };
const base = { nombre: 'Test', role: 'vendedor' };
const payloadFor = (email, opId, extra = {}) => ({ email, opId, ...base, ...extra });

beforeEach(() => {
  state.docs = {
    'users_prod/default_mgr': { id: 'default_mgr', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Manager' },
    'users_prod/default_other_mgr': { id: 'default_other_mgr', authUid: 'otherManagerUid', role: 'manager', activo: true, nombre: 'Other Manager' }
  };
  state.authUsers = {};
  state.createUserCalls = 0;
  state.hooks = {
    getUserByEmail: null,
    createUser: null,
    createUserResponseLost: false,
    setCustomUserClaims: null,
    deleteUser: null,
    create: null,
    txSet: null,
    directSet: null
  };
});

describe('createUserAdmin – authorization and validation', () => {
  test('rejects unauthenticated calls', async () => {
    await expect(createUserAdmin(payloadFor('test@example.com', 'op1'), {})).rejects.toMatchObject({
      code: 'unauthenticated'
    });
    expect(state.createUserCalls).toBe(0);
  });

  test('rejects non-manager callers', async () => {
    await expect(
      createUserAdmin(payloadFor('test@example.com', 'op2'), { auth: { uid: 'regularUid' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });

  test('validates required fields', async () => {
    await expect(
      createUserAdmin({ email: 'test@example.com', nombre: 'Test', role: 'vendedor' }, ctx)
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(state.createUserCalls).toBe(0);
  });

  test('rejects invalid email format', async () => {
    await expect(createUserAdmin(payloadFor('invalid-email', 'op3'), ctx)).rejects.toMatchObject({
      code: 'invalid-argument'
    });
    expect(state.createUserCalls).toBe(0);
  });

  test('rejects disallowed (privileged) role', async () => {
    await expect(
      createUserAdmin(payloadFor('test@example.com', 'op4', { role: 'admin' }), ctx)
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.createUserCalls).toBe(0);
  });
});

describe('createUserAdmin – success and idempotency keys', () => {
  test('creates a new user, assigns the role claim and writes the profile', async () => {
    const result = await createUserAdmin(payloadFor('new@example.com', 'op5', { nombre: 'New User' }), ctx);
    expect(result).toHaveProperty('uid', state.authUsers['new@example.com'].uid);
    expect(state.docs['userOps/op5']).toMatchObject({ status: 'succeeded', uid: result.uid });
    expect(state.authUsers['new@example.com'].claims).toEqual({ role: 'vendedor' });
    // CRM profile schema: keyed by the historical id; the Auth UID is kept separately; no password.
    expect(state.docs[`users_prod/${result.id}`]).toMatchObject({
      id: result.id, authUid: result.uid, email: 'new@example.com', nombre: 'New User', role: 'vendedor', activo: true
    });
    expect(state.docs['userOpsLocks/op5']).toBeUndefined();
  });

  test('same opId with a different payload is rejected with already-exists', async () => {
    await createUserAdmin(payloadFor('diff1@example.com', 'op7', { nombre: 'One' }), ctx);
    await expect(
      createUserAdmin(payloadFor('diff2@example.com', 'op7', { nombre: 'Two' }), ctx)
    ).rejects.toMatchObject({ code: 'already-exists', message: /different payload/ });
    expect(state.createUserCalls).toBe(1);
    expect(state.authUsers['diff2@example.com']).toBeUndefined();
  });

  test('opId used by another user is rejected with already-exists', async () => {
    const data = payloadFor('shared@example.com', 'opShared');
    await createUserAdmin(data, ctx);
    await expect(createUserAdmin(data, { auth: { uid: 'otherManagerUid' } })).rejects.toMatchObject({
      code: 'already-exists',
      message: /another user/
    });
    expect(state.createUserCalls).toBe(1);
  });

  test('concurrent invocations with the same opId create a single Auth user', async () => {
    const data = payloadFor('concurrent@example.com', 'op_conc');
    const results = await Promise.allSettled([createUserAdmin(data, ctx), createUserAdmin(data, ctx)]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'already-exists' });
    expect(state.createUserCalls).toBe(1);
    expect(Object.keys(state.authUsers)).toEqual(['concurrent@example.com']);
  });
});

describe('createUserAdmin – failures before any account is kept (status "error")', () => {
  test('real Auth lookup error is internal and no account is created', async () => {
    state.hooks.getUserByEmail = () => {
      const err = new Error('Database error');
      err.code = 'auth/internal-error';
      throw err;
    };
    await expect(createUserAdmin(payloadFor('error@example.com', 'op10'), ctx)).rejects.toMatchObject({
      code: 'internal'
    });
    expect(state.docs['userOps/op10'].status).toBe('error');
    expect(state.createUserCalls).toBe(0);
    expect(state.docs['userOpsLocks/op10']).toBeUndefined();
  });

  test('Firestore non-already-exists error on reservation is internal and nothing is created', async () => {
    state.hooks.create = path => {
      if (path === 'userOps/op_err') {
        const err = new Error('Permission denied');
        err.code = 7; // not ALREADY_EXISTS
        throw err;
      }
    };
    await expect(createUserAdmin(payloadFor('firestoreerror@example.com', 'op_err'), ctx)).rejects.toMatchObject({
      code: 'internal'
    });
    expect(state.createUserCalls).toBe(0);
    expect(state.docs['userOps/op_err']).toBeUndefined();
    expect(state.docs['userOpsLocks/op_err']).toBeUndefined(); // lock released in finally
  });

  test('createUser email-already-exists is a conflict (definitive), not manual review', async () => {
    state.hooks.createUser = () => {
      const err = new Error('email exists');
      err.code = 'auth/email-already-exists';
      throw err;
    };
    await expect(createUserAdmin(payloadFor('race@example.com', 'opRace'), ctx)).rejects.toMatchObject({
      code: 'already-exists'
    });
    expect(state.docs['userOps/opRace'].status).toBe('conflict');
    expect(state.createUserCalls).toBe(0);
  });
});

describe('createUserAdmin – rollback of an account created by this very operation', () => {
  test('custom claims failure rolls back the Auth user; same opId is not retried, a new opId is', async () => {
    state.hooks.setCustomUserClaims = () => { throw new Error('Claims error'); };
    const data = payloadFor('rollback@example.com', 'op9');

    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({ code: 'internal' });
    expect(state.authUsers['rollback@example.com']).toBeUndefined(); // deleted during rollback
    expect(state.docs['userOps/op9']).toMatchObject({ status: 'error', rolledBack: true });
    expect(state.createUserCalls).toBe(1);

    // Same opId: the stored result is read, createUser is NOT executed again.
    state.hooks.setCustomUserClaims = null;
    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: /new opId/
    });
    expect(state.createUserCalls).toBe(1);
    expect(state.authUsers['rollback@example.com']).toBeUndefined();

    // A fresh opId is a new operation and succeeds.
    const retry = await createUserAdmin({ ...data, opId: 'op9b' }, ctx);
    expect(retry.uid).toBe(state.authUsers['rollback@example.com'].uid);
    expect(state.docs['userOps/op9b'].status).toBe('succeeded');
    expect(state.createUserCalls).toBe(2);
  });

  test('profile write failure rolls back the Auth user', async () => {
    state.hooks.create = path => { if (path.startsWith('users_prod/')) throw new Error('profile create failed'); };
    await expect(createUserAdmin(payloadFor('profilefail@example.com', 'op12'), ctx)).rejects.toMatchObject({
      code: 'internal'
    });
    expect(state.authUsers['profilefail@example.com']).toBeUndefined();
    expect(state.docs['userOps/op12']).toMatchObject({ status: 'error', rolledBack: true });
    expect(state.createUserCalls).toBe(1);
  });
});

describe('createUserAdmin – uncertain outcomes require manual review', () => {
  test('rollback delete failure → manualReview with the UID, account retained', async () => {
    state.hooks.setCustomUserClaims = () => { throw new Error('Claims error'); };
    state.hooks.deleteUser = () => { throw new Error('Delete failed'); };
    const data = payloadFor('deleterollback@example.com', 'op14');

    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: /Manual review required/
    });
    const account = state.authUsers['deleterollback@example.com'];
    expect(account).toBeDefined(); // neither deleted nor adopted
    expect(state.docs['userOps/op14']).toMatchObject({ status: 'manualReview', uid: account.uid });

    // Retry never creates another account.
    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(1);
  });

  test('failure finalizing after profile saved → manualReview, account and profile retained', async () => {
    state.hooks.txSet = (path, data) => path === 'userOps/op13' && data.status === 'succeeded';
    const data = payloadFor('finalizefail@example.com', 'op13');

    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: /Manual review required/
    });
    const account = state.authUsers['finalizefail@example.com'];
    expect(account).toBeDefined();
    expect(state.docs[`users_prod/${state.docs['userOps/op13'].profileId}`]).toMatchObject({ authUid: account.uid });
    expect(state.docs['userOps/op13']).toMatchObject({ status: 'manualReview', uid: account.uid });

    state.hooks.txSet = null;
    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(1);
  });

  test('createUser response lost (account may exist) → manualReview, retry does not create another', async () => {
    state.hooks.createUserResponseLost = true;
    const data = payloadFor('lost@example.com', 'opLost');

    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: /Manual review required/
    });
    expect(state.createUserCalls).toBe(1);
    expect(state.docs['userOps/opLost'].status).toBe('manualReview');

    state.hooks.createUserResponseLost = false;
    await expect(createUserAdmin(data, ctx)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(state.createUserCalls).toBe(1);
    expect(Object.keys(state.authUsers)).toHaveLength(1);
  });
});
