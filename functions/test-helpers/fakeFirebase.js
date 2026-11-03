// functions/test-helpers/fakeFirebase.js
// In-memory fakes of firebase-admin and firebase-functions for unit tests. Not a test file:
// it lives outside __tests__ so Jest does not try to run it. Used via jest.mock factories.

function buildFunctionsFake() {
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  // onCall returns the handler itself so tests invoke it as handler(data, context).
  const makeHttps = (opts = {}) => ({
    HttpsError,
    onCall: handler => {
      handler.__runWithOptions = opts;
      handler.__endpoint = { serviceAccountEmail: opts.serviceAccount };
      return handler;
    }
  });
  return {
    https: makeHttps(),
    runWith: options => ({ https: makeHttps(options) })
  };
}

function buildAdminFake() {
  // One shared state: every collection()/doc() call operates on it.
  const state = {
    docs: {},              // 'collection/id' -> data
    authUsers: {},         // email -> { uid, email, claims? }
    createUserCalls: 0,
    createUserArgs: [],    // exact arguments received by Auth createUser
    requesters: {},        // uid -> record returned by getUser (overrides the defaults)
    updateUserCalls: [],   // { uid, attrs } received by Auth updateUser
    revokedUids: [],       // uids passed to revokeRefreshTokens
    deletedUids: [],       // uids passed to Auth deleteUser
    // Optional failure injection (each receives the document path and may throw):
    //   beforeCreate / afterCreate (afterCreate throws AFTER the write was applied), beforeGet, beforeUpdate
    hooks: {},
    claimsCalls: [],       // { uid, claims } received by Auth setCustomUserClaims
    seedDefaultManager: (col = 'users_prod', uid = 'managerUid', data = {}) => {
      const docId = data.id || '__default_mgr__';
      const docPath = `${col}/${docId}`;
      state.docs[docPath] = {
        id: docId,
        authUid: uid,
        role: 'manager',
        activo: true,
        nombre: 'Default Manager',
        email: 'manager@ductsal-test.invalid',
        ...data
      };
      return docPath;
    }
  };
  let autoId = 0;

  const defaultRequesters = {
    managerUid: { customClaims: { manager: true } },
    otherManagerUid: { customClaims: { manager: true } },
    disabledManagerUid: { customClaims: { manager: true }, disabled: true },
    roleOnlyManagerUid: { customClaims: { role: 'manager' } }, // CRM-style "manager" without the claim
    vendedorUid: { customClaims: { role: 'vendedor' } },
    regularUid: { customClaims: {} },
    unlinkedManagerUid: { customClaims: { manager: true }, disabled: false }
  };

  const applySet = (path, data, opts = {}) => {
    if (state.hooks.beforeSet) state.hooks.beforeSet(path, data, opts);
    state.docs[path] = opts.merge ? { ...(state.docs[path] || {}), ...data } : { ...data };
  };

  const applyUpdate = (target, data) => {
    for (const k in data) {
      const v = data[k];
      let cur = target;
      let finalKey = k;
      if (k.includes('.')) {
        const parts = k.split('.');
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
          cur = cur[p];
        }
        finalKey = parts[parts.length - 1];
      }
      if (v === '__FIELD_DELETE__') {
        delete cur[finalKey];
      } else if (v && v.__op === 'arrayUnion') {
        const arr = Array.isArray(cur[finalKey]) ? cur[finalKey] : [];
        cur[finalKey] = Array.from(new Set([...arr, ...v.elements]));
      } else if (v && v.__op === 'arrayRemove') {
        const arr = Array.isArray(cur[finalKey]) ? cur[finalKey] : [];
        cur[finalKey] = arr.filter(x => !v.elements.includes(x));
      } else {
        cur[finalKey] = v;
      }
    }
  };

  const cloneDoc = doc => {
    if (doc === null || typeof doc !== 'object') return doc;
    if (typeof doc.toDate === 'function') {
      const d = doc.toDate();
      return { toDate: () => new Date(d.getTime()) };
    }
    if (Array.isArray(doc)) {
      return doc.map(cloneDoc);
    }
    const copy = {};
    for (const key of Object.keys(doc)) {
      copy[key] = cloneDoc(doc[key]);
    }
    return copy;
  };

  const makeRef = (col, id) => {
    const path = `${col}/${id}`;
    return {
      path,
      async create(data) {
        if (state.hooks.beforeCreate) state.hooks.beforeCreate(path);
        if (state.docs[path]) {
          const err = new Error('ALREADY_EXISTS');
          err.code = 6;
          throw err;
        }
        state.docs[path] = { ...data };
        if (state.hooks.afterCreate) state.hooks.afterCreate(path);
      },
      async get() {
        if (state.hooks.beforeGet) state.hooks.beforeGet(path);
        if (state.docs[path]) return { exists: true, data: () => cloneDoc(state.docs[path]) };
        if (path.endsWith('/__default_mgr__') && state.allowVirtualManager === true && !state.unlinkedManager) {
          return { exists: true, data: () => ({ id: '__default_mgr__', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Default Manager', email: 'manager@ductsal-test.invalid' }) };
        }
        return { exists: false, data: () => undefined };
      },
      async set(data, opts = {}) { applySet(path, data, opts); },
      async update(data) {
        if (state.hooks.beforeUpdate) state.hooks.beforeUpdate(path);
        if (!state.docs[path]) throw new Error('NOT_FOUND');
        const cur = cloneDoc(state.docs[path]);
        applyUpdate(cur, data);
        state.docs[path] = cur;
      },
      async delete() { delete state.docs[path]; }
    };
  };

  const firestore = () => ({
    collection: col => {
      const defaultMgr = { id: '__default_mgr__', authUid: 'managerUid', role: 'manager', activo: true, nombre: 'Default Manager', email: 'manager@ductsal-test.invalid' };
      const hasMgr = () => {
        const prefix = `${col}/`;
        return Object.keys(state.docs).some(k => k.startsWith(prefix) && (state.docs[k] || {}).authUid === 'managerUid');
      };

      const queryApi = (filters = []) => ({
        where: (field, op, val) => queryApi([...filters, { field, op, val }]),
        async get() {
          const prefix = `${col}/`;
          let matches = Object.keys(state.docs).filter(k => k.startsWith(prefix));
          for (const f of filters) {
            matches = matches.filter(k => state.docs[k] && state.docs[k][f.field] === f.val);
          }
          const docs = matches.map(k => ({ id: k.slice(prefix.length), data: () => cloneDoc(state.docs[k]) }));
          if (col.startsWith('users') && state.allowVirtualManager === true && !state.unlinkedManager && !hasMgr()) {
            const match = filters.every(f => defaultMgr[f.field] === f.val);
            if (match) {
              docs.push({ id: '__default_mgr__', data: () => defaultMgr });
            }
          }
          return {
            empty: docs.length === 0,
            docs
          };
        }
      });
      return {
        doc: id => makeRef(col, id === undefined ? `auto_${++autoId}` : id),
        where: (field, op, val) => queryApi([{ field, op, val }]),
        async get() {
          const prefix = `${col}/`;
          const docs = Object.keys(state.docs)
            .filter(k => k.startsWith(prefix))
            .map(k => ({ id: k.slice(prefix.length), data: () => cloneDoc(state.docs[k]) }));
          if (col.startsWith('users') && state.allowVirtualManager === true && !state.unlinkedManager && !hasMgr()) {
            docs.push({ id: '__default_mgr__', data: () => defaultMgr });
          }
          return { empty: docs.length === 0, docs };
        },
        async add(data) {
          const autoKey = `auto_${++autoId}`;
          const path = `${col}/${autoKey}`;
          if (state.hooks.beforeCreate) state.hooks.beforeCreate(path);
          state.docs[path] = { ...data };
          return makeRef(col, autoKey);
        }
      };
    },
    // Writes are buffered and committed together when the callback returns, like the real SDK: the failure hooks run
    // for ALL writes first, so a failing write leaves nothing applied (atomic).
    async runTransaction(fn) {
      const writes = [];
      const t = {
        get: ref => ref.get(),
        set: (ref, data, opts = {}) => { writes.push({ kind: 'set', ref, data, opts }); },
        create: (ref, data) => { writes.push({ kind: 'create', ref, data }); },
        update: (ref, data) => { writes.push({ kind: 'update', ref, data }); },
        delete: ref => { writes.push({ kind: 'delete', ref }); }
      };
      if (state.hooks.beforeTransaction) state.hooks.beforeTransaction();
      const result = await fn(t);
      for (const w of writes) {
        if (w.kind === 'create') {
          if (state.hooks.beforeCreate) state.hooks.beforeCreate(w.ref.path);
          if (state.docs[w.ref.path]) { const err = new Error('ALREADY_EXISTS'); err.code = 6; throw err; }
        } else if (w.kind === 'update') {
          if (state.hooks.beforeUpdate) state.hooks.beforeUpdate(w.ref.path);
          if (!state.docs[w.ref.path]) throw new Error('NOT_FOUND');
        }
      }
      for (const w of writes) {
        if (w.kind === 'set') applySet(w.ref.path, w.data, w.opts);
        else if (w.kind === 'create') state.docs[w.ref.path] = { ...w.data };
        else if (w.kind === 'update') {
          const cur = cloneDoc(state.docs[w.ref.path] || {});
          applyUpdate(cur, w.data);
          state.docs[w.ref.path] = cur;
        }
        else delete state.docs[w.ref.path];
      }
      return result;
    }
  });
  firestore.FieldValue = {
    serverTimestamp: () => 'SERVER_TS',
    delete: () => '__FIELD_DELETE__',
    arrayUnion: (...elements) => ({ __op: 'arrayUnion', elements }),
    arrayRemove: (...elements) => ({ __op: 'arrayRemove', elements })
  };
  firestore.Timestamp = { fromDate: d => ({ toDate: () => d }) };

  const auth = () => ({
    async getUser(uid) {
      const user = Object.values(state.authUsers).find(u => u.uid === uid);
      const rec = state.requesters[uid] || (user ? { email: user.email, customClaims: user.claims || {} } : defaultRequesters[uid]) || { customClaims: {} };
      const defaultMetadata = user ? (user.metadata || { creationTime: '2026-10-18T00:00:00Z', lastSignInTime: null }) : { lastSignInTime: '2026-10-16T12:00:00Z' };
      return { uid, metadata: defaultMetadata, ...rec };
    },
    async getUserByEmail(email) {
      if (state.authUsers[email]) {
        const u = state.authUsers[email];
        return {
          ...u,
          metadata: u.metadata || { creationTime: '2026-10-18T00:00:00Z', lastSignInTime: null },
          customClaims: u.customClaims || u.claims || {}
        };
      }
      const err = new Error('auth/user-not-found');
      err.code = 'auth/user-not-found';
      throw err;
    },
    async createUser(args) {
      state.createUserArgs.push(args);
      state.createUserCalls += 1;
      const user = {
        uid: args.uid || `authuid_${state.createUserCalls}`,
        email: args.email,
        customClaims: {},
        metadata: { creationTime: '2026-10-18T00:00:00Z', lastSignInTime: null }
      };
      state.authUsers[args.email] = user;
      return { uid: user.uid, email: user.email, metadata: user.metadata };
    },
    async setCustomUserClaims(uid, claims) {
      state.claimsCalls.push({ uid, claims });
      if (state.hooks.beforeSetClaims) state.hooks.beforeSetClaims(uid, claims, state.claimsCalls.length);
      const user = Object.values(state.authUsers).find(u => u.uid === uid);
      if (user) {
        user.claims = claims;
        user.customClaims = claims;
        return;
      }
      // Accounts known only through `requesters` / the defaults (pre-existing in the fake Auth).
      const base = state.requesters[uid] || defaultRequesters[uid];
      if (!base) throw new Error('User not found');
      state.requesters[uid] = { ...base, customClaims: claims };
    },
    async deleteUser(uid) {
      state.deletedUids.push(uid);
      Object.keys(state.authUsers).forEach(e => { if (state.authUsers[e].uid === uid) delete state.authUsers[e]; });
    },
    async updateUser(uid, attrs) {
      state.updateUserCalls.push({ uid, attrs });
      const base = state.requesters[uid] || defaultRequesters[uid] || { customClaims: {} };
      state.requesters[uid] = { ...base, ...attrs };
      const user = Object.values(state.authUsers).find(u => u.uid === uid);
      if (user) {
        if (attrs.email && attrs.email !== user.email) {
          delete state.authUsers[user.email];
          user.email = attrs.email;
          state.authUsers[attrs.email] = user;
        }
        Object.assign(user, attrs);
      }
    },
    async generatePasswordResetLink(email, actionCodeSettings) {
      state.passwordResetLinks = state.passwordResetLinks || [];
      state.passwordResetLinks.push({ email, actionCodeSettings });
      if (state.hooks && state.hooks.generatePasswordResetLink) {
        return state.hooks.generatePasswordResetLink(email, actionCodeSettings);
      }
      return `https://ductsal-erp.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=fake_oob_${Date.now()}&email=${encodeURIComponent(email)}`;
    },
    async revokeRefreshTokens(uid) {
      if (state.hooks.beforeRevokeTokens) state.hooks.beforeRevokeTokens(uid);
      state.revokedUids.push(uid);
    }
  });

  const defaultApp = {
    name: '[DEFAULT]',
    options: { projectId: 'ductsal-erp' }
  };

  return {
    initializeApp: (opts = {}) => {
      if (opts && opts.projectId) {
        defaultApp.options.projectId = opts.projectId;
      }
      return defaultApp;
    },
    app: () => defaultApp,
    options: defaultApp.options,
    apps: [defaultApp],
    firestore,
    auth,
    __state: state
  };
}

module.exports = { buildFunctionsFake, buildAdminFake };
