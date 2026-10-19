// functions/__tests__/createUserAdmin.concurrency.test.js
// Concurrency test for createUserAdmin using an explicit, controllable barrier (no setTimeout).
// firebase-admin / firebase-functions are replaced by in-memory fakes BEFORE ../index is loaded.

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
  // Single shared state: every collection()/doc() call operates on this same object.
  const state = {
    docs: {},              // 'collection/id' -> data
    authUsers: {},         // email -> { uid, email }
    createUserCalls: 0,    // number of Auth createUser invocations
    userOpsWrites: [],     // log of every write that touches the userOps collection
    afterCreate: null      // async (path) => void – hook run right after a document is created
  };

  const logIfUserOps = (path, kind, data) => {
    if (path.startsWith('userOps/')) state.userOpsWrites.push({ kind, path, data });
  };

  const applySet = (path, data, opts = {}) => {
    state.docs[path] = opts.merge ? { ...(state.docs[path] || {}), ...data } : { ...data };
  };

  const makeRef = (col, id) => {
    const path = `${col}/${id}`;
    return {
      path,
      async create(data) {
        if (state.docs[path]) {
          const err = new Error('ALREADY_EXISTS');
          err.code = 6; // Firestore already-exists
          throw err;
        }
        logIfUserOps(path, 'create', data);
        state.docs[path] = { ...data };
        if (state.afterCreate) await state.afterCreate(path);
      },
      async get() {
        return { exists: !!state.docs[path], data: () => state.docs[path] };
      },
      async set(data, opts = {}) {
        logIfUserOps(path, 'set', data);
        applySet(path, data, opts);
      },
      async update(data) {
        if (!state.docs[path]) throw new Error('NOT_FOUND');
        logIfUserOps(path, 'update', data);
        state.docs[path] = { ...state.docs[path], ...data };
      },
      async delete() {
        logIfUserOps(path, 'delete');
        delete state.docs[path];
      }
    };
  };

  const firestore = () => ({
    collection: col => ({
      doc: id => makeRef(col, id),
      // Collection read used by createUserAdmin to detect an existing profile with the same email.
      async get() {
        const prefix = `${col}/`;
        const docs = Object.keys(state.docs)
          .filter(k => k.startsWith(prefix))
          .map(k => ({ id: k.slice(prefix.length), data: () => state.docs[k] }));
        if (col.startsWith('users') && !docs.some(d => (d.data() || {}).authUid === 'managerUid') && !state.unlinkedManager) {
          docs.push({ id: 'default_mgr', data: () => ({ id: 'default_mgr', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Manager' }) });
        }
        return { docs };
      }
    }),
    async runTransaction(fn) {
      const t = {
        get: ref => ref.get(),
        set: (ref, data, opts = {}) => {
          logIfUserOps(ref.path, 'tx.set', data);
          applySet(ref.path, data, opts);
        },
        update: (ref, data) => {
          logIfUserOps(ref.path, 'tx.update', data);
          state.docs[ref.path] = { ...(state.docs[ref.path] || {}), ...data };
        },
        delete: ref => {
          logIfUserOps(ref.path, 'tx.delete');
          delete state.docs[ref.path];
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
      Object.keys(state.authUsers).forEach(e => {
        if (state.authUsers[e].uid === uid) delete state.authUsers[e];
      });
    },
    async setCustomUserClaims() {}
  });

  return { initializeApp: () => {}, firestore, auth, __state: state };
}, { virtual: true });

// Mocks are registered above, so loading the function now binds it to the fakes.
const admin = require('firebase-admin');
const { createUserAdmin } = require('../index');
const state = admin.__state;

const ctx = { auth: { uid: 'managerUid' } };
const payload = { email: 'concurrent@test.com', nombre: 'Concurrent', role: 'vendedor', opId: 'opConcurrency' };
const LOCK = 'userOpsLocks/opConcurrency';
const OP = 'userOps/opConcurrency';

// Manually resolvable promise.
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

let acquired;       // resolves when the FIRST request has created the lock
let release;        // the test resolves it to let the first request continue
let releaseCalled;

beforeEach(() => {
  // Reset all shared state so tests do not depend on each other.
  state.docs = {};
  state.authUsers = {};
  state.createUserCalls = 0;
  state.userOpsWrites = [];
  state.afterCreate = null;
  acquired = deferred();
  release = deferred();
  releaseCalled = false;
});

afterEach(() => {
  // Never leave a request blocked on the barrier if an assertion failed mid-test.
  if (!releaseCalled) release.resolve();
  state.afterCreate = null;
});

test('concurrency: first request holds the lock, second fails with already-exists, first then completes', async () => {
  // Barrier: pause the first request right after its lock document is created.
  // Only the first lock creation can reach this hook; a second create throws ALREADY_EXISTS before it.
  state.afterCreate = async path => {
    if (path === LOCK) {
      state.afterCreate = null;
      acquired.resolve();
      await release.promise;
    }
  };

  // First request: starts and blocks while holding the lock.
  let firstSettled = false;
  const firstPromise = createUserAdmin(payload, ctx).finally(() => { firstSettled = true; });
  await acquired.promise; // proves the first request really holds the lock

  const lockWhileHeld = { ...state.docs[LOCK] };
  expect(lockWhileHeld.token).toEqual(expect.any(String));
  expect(firstSettled).toBe(false);

  // Second request, same opId, while the lock is held.
  await expect(createUserAdmin(payload, ctx)).rejects.toMatchObject({
    code: 'already-exists',
    message: /Operation already in progress/
  });

  // While the lock is held, the first request is still paused and nothing has been created or written.
  expect(firstSettled).toBe(false);
  expect(state.createUserCalls).toBe(0);
  expect(Object.keys(state.authUsers)).toHaveLength(0);
  expect(state.docs[OP]).toBeUndefined();
  expect(state.userOpsWrites).toHaveLength(0);
  // The second request neither replaced nor released the first request's lock.
  expect(state.docs[LOCK]).toEqual(lockWhileHeld);

  // Release the barrier: the first request continues and finishes.
  releaseCalled = true;
  release.resolve();
  const result = await firstPromise;

  expect(firstSettled).toBe(true);
  expect(result).toHaveProperty('uid');
  expect(state.createUserCalls).toBe(1);
  expect(Object.keys(state.authUsers)).toEqual([payload.email]);
  expect(state.authUsers[payload.email].uid).toBe(result.uid);
  expect(state.docs[OP]).toMatchObject({ status: 'succeeded', uid: result.uid });
  expect(state.docs[`users_prod/${result.id}`]).toMatchObject({ id: result.id, authUid: result.uid, email: payload.email });
  expect(state.docs[LOCK]).toBeUndefined(); // lock released by the owner
});

test('state is reset between tests: nothing from the previous test leaks', () => {
  expect(state.docs).toEqual({});
  expect(state.authUsers).toEqual({});
  expect(state.createUserCalls).toBe(0);
  expect(state.userOpsWrites).toHaveLength(0);
  expect(state.afterCreate).toBeNull();
});
