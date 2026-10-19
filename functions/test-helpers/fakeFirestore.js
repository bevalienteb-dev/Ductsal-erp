// functions/test-helpers/fakeFirestore.js
// In-memory Firestore for UNIT tests of the services that receive `db` by injection (commercialService).
// It is a fake, not the emulator: it models only what those services use, and models it faithfully enough to
// make concurrency tests meaningful:
//   - collection/doc (auto ids), get / set(merge) / create / update / delete, where(==, >=, <, <=, >), limit, select;
//   - runTransaction with Firestore's contract: every read before the first write, optimistic concurrency
//     (a transaction whose reads changed before commit is retried), create() fails when the document exists,
//     update() fails when it does not, and a thrown error aborts the whole transaction without applying anything;
//   - every read yields to the event loop, so Promise.all() really interleaves concurrent requests.
// Behaviour that depends on the real backend (indexes, security rules, latency) is NOT covered here: that is what
// the isolated emulator suites are for (see functions/ISOLATED_TESTS.md).

const SERVER_TS = { __sentinel: 'serverTimestamp' };

function createFakeFirestore({ clock = () => new Date('2026-03-15T12:00:00.000Z') } = {}) {
  const docs = new Map();      // path -> { data, version }
  const colVersion = new Map(); // collection -> version (bumped by any write; coarse on purpose)
  const state = { commits: 0, retries: 0, aborted: 0, hooks: {} };
  let autoId = 0;
  let seq = 0; // global monotonic version: a delete + recreate can never reproduce a version already read

  const tick = () => new Promise(r => setImmediate(r));
  const materialize = v => {
    if (v === SERVER_TS) return clock().toISOString();
    if (Array.isArray(v)) return v.map(materialize);
    if (v && typeof v === 'object') return Object.keys(v).reduce((o, k) => { if (v[k] !== undefined) o[k] = materialize(v[k]); return o; }, {});
    return v;
  };
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const pathOf = (col, id) => `${col}/${id}`;
  const versionOf = p => (docs.has(p) ? docs.get(p).version : 0);
  const colVer = c => colVersion.get(c) || 0;
  const bump = (col, p) => {
    const d = docs.get(p);
    if (d) d.version = ++seq;
    colVersion.set(col, ++seq);
  };
  const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };

  function snapshotOf(col, id, projection) {
    const p = pathOf(col, id);
    const entry = docs.get(p);
    return {
      id, exists: !!entry, ref: refOf(col, id),
      data: () => {
        if (!entry) return undefined;
        const d = copy(entry.data);
        if (!projection || !projection.length) return d;
        return projection.reduce((o, k) => { if (d[k] !== undefined) o[k] = d[k]; return o; }, {});
      }
    };
  }

  function applyWrite(w) {
    const { op, col, id } = w;
    const p = pathOf(col, id);
    if (op === 'create') {
      if (docs.has(p)) throw fail(6, `ALREADY_EXISTS: ${p}`);
      docs.set(p, { data: materialize(w.data), version: 1 });
    } else if (op === 'set') {
      const next = materialize(w.data);
      if (w.merge && docs.has(p)) docs.get(p).data = { ...docs.get(p).data, ...next };
      else if (docs.has(p)) docs.get(p).data = next;
      else docs.set(p, { data: next, version: 0 });
    } else if (op === 'update') {
      if (!docs.has(p)) throw fail(5, `NOT_FOUND: ${p}`);
      const cur = docs.get(p).data;
      for (const k of Object.keys(w.data)) {
        const v = w.data[k];
        if (v && v.__sentinel === 'arrayUnion') {
          const arr = Array.isArray(cur[k]) ? cur[k] : [];
          cur[k] = Array.from(new Set([...arr, ...v.elements]));
        } else if (v && v.__sentinel === 'arrayRemove') {
          const arr = Array.isArray(cur[k]) ? cur[k] : [];
          cur[k] = arr.filter(x => !v.elements.includes(x));
        } else if (v === '__FIELD_DELETE__') {
          delete cur[k];
        } else {
          cur[k] = materialize(v);
        }
      }
    } else if (op === 'delete') {
      docs.delete(p);
    }
    if (op === 'delete') { colVersion.set(col, ++seq); return; }
    bump(col, p);
  }
  // All-or-nothing: validate every write against the state it will meet, then apply.
  function commit(writes) {
    const preview = new Map();
    const existsNow = p => (preview.has(p) ? preview.get(p) : docs.has(p));
    for (const w of writes) {
      const p = pathOf(w.col, w.id);
      if (w.op === 'create' && existsNow(p)) throw fail(6, `ALREADY_EXISTS: ${p}`);
      if (w.op === 'update' && !existsNow(p)) throw fail(5, `NOT_FOUND: ${p}`);
      preview.set(p, w.op !== 'delete');
    }
    if (state.hooks.beforeCommit) state.hooks.beforeCommit(writes);
    writes.forEach(applyWrite);
    state.commits += 1;
  }

  function refOf(col, id) {
    const realId = id === undefined ? `auto${String(++autoId).padStart(6, '0')}` : String(id);
    return {
      id: realId, path: pathOf(col, realId), col,
      async get() { await tick(); if (state.hooks.beforeGet) state.hooks.beforeGet(pathOf(col, realId)); return snapshotOf(col, realId); },
      async set(data, opts = {}) { await tick(); commit([{ op: 'set', col, id: realId, data, merge: !!opts.merge }]); },
      async create(data) { await tick(); commit([{ op: 'create', col, id: realId, data }]); },
      async update(data) { await tick(); commit([{ op: 'update', col, id: realId, data }]); },
      async delete() { await tick(); commit([{ op: 'delete', col, id: realId }]); }
    };
  }

  function queryOf(col, filters = [], max = null, projection = null) {
    const q = {
      __query: true, col,
      where(field, op, value) { return queryOf(col, filters.concat([{ field, op, value }]), max, projection); },
      limit(n) { return queryOf(col, filters, n, projection); },
      select(...fields) { return queryOf(col, filters, max, fields); },
      doc(id) { return refOf(col, id); },
      async get() { await tick(); return run(); }
    };
    const run = () => {
      const prefix = `${col}/`;
      let list = [...docs.keys()].filter(k => k.startsWith(prefix)).map(k => ({ id: k.slice(prefix.length), data: docs.get(k).data }));
      const test = (v, f) => {
        switch (f.op) {
          case '==': return JSON.stringify(v) === JSON.stringify(f.value);
          case '>=': return v !== undefined && v >= f.value;
          case '>': return v !== undefined && v > f.value;
          case '<=': return v !== undefined && v <= f.value;
          case '<': return v !== undefined && v < f.value;
          case 'array-contains': return Array.isArray(v) && v.includes(f.value);
          default: throw new Error(`fakeFirestore: unsupported operator ${f.op}`);
        }
      };
      list = list.filter(e => filters.every(f => test(e.data[f.field], f)));
      list.sort((a, b) => a.id.localeCompare(b.id));
      if (max !== null) list = list.slice(0, max);
      const snaps = list.map(e => snapshotOf(col, e.id, projection));
      return { docs: snaps, size: snaps.length, empty: snaps.length === 0, forEach: fn => snaps.forEach(fn) };
    };
    q.__run = run;
    return q;
  }

  const collection = name => queryOf(name);

  async function runTransaction(fn, { maxAttempts = 30 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const docReads = new Map(); // path -> version seen
      const colReads = new Map(); // collection -> version seen (query reads)
      const writes = [];
      let wrote = false;
      const tx = {
        async get(target) {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          await tick();
          if (target.__query) {
            colReads.set(target.col, colVer(target.col));
            return target.__run();
          }
          docReads.set(target.path, versionOf(target.path));
          return snapshotOf(target.col, target.id);
        },
        set(ref, data, opts = {}) { wrote = true; writes.push({ op: 'set', col: ref.col, id: ref.id, data, merge: !!opts.merge }); return tx; },
        create(ref, data) { wrote = true; writes.push({ op: 'create', col: ref.col, id: ref.id, data }); return tx; },
        update(ref, data) { wrote = true; writes.push({ op: 'update', col: ref.col, id: ref.id, data }); return tx; },
        delete(ref) { wrote = true; writes.push({ op: 'delete', col: ref.col, id: ref.id }); return tx; }
      };
      let result;
      try {
        result = await fn(tx);
      } catch (e) {
        state.aborted += 1;
        throw e; // a failed transaction applies nothing
      }
      // Commit is synchronous, hence atomic with respect to the validation below.
      const stale = [...docReads].some(([p, v]) => versionOf(p) !== v) || [...colReads].some(([c, v]) => colVer(c) !== v);
      if (stale) { state.retries += 1; continue; }
      commit(writes);
      return result;
    }
    throw fail(10, 'ABORTED: too much contention');
  }

  function batch() {
    const writes = [];
    return {
      set(ref, data, opts = {}) {
        writes.push({ op: 'set', col: ref.col, id: ref.id, data, merge: !!opts.merge });
        return this;
      },
      create(ref, data) {
        writes.push({ op: 'create', col: ref.col, id: ref.id, data });
        return this;
      },
      update(ref, data) {
        writes.push({ op: 'update', col: ref.col, id: ref.id, data });
        return this;
      },
      delete(ref) {
        writes.push({ op: 'delete', col: ref.col, id: ref.id });
        return this;
      },
      async commit() {
        await tick();
        commit(writes);
      }
    };
  }

  return {
    state,
    collection,
    batch,
    runTransaction,
    // ---- test helpers (not part of the Firestore API) ----
    clear() {
      docs.clear();
      colVersion.clear();
      state.commits = 0;
      state.retries = 0;
      state.aborted = 0;
      state.hooks = {};
      seq = 0;
      autoId = 0;
    },
    seed(path, data) { const [col, id] = path.split('/'); docs.set(path, { data: materialize(data), version: ++seq }); colVersion.set(col, ++seq); return id; },
    data(path) { return docs.has(path) ? copy(docs.get(path).data) : undefined; },
    list(col) { const prefix = `${col}/`; return [...docs.keys()].filter(k => k.startsWith(prefix)).map(k => ({ id: k.slice(prefix.length), ...copy(docs.get(k).data) })); },
    count(col) { const prefix = `${col}/`; return [...docs.keys()].filter(k => k.startsWith(prefix)).length; },
    FieldValue: {
      serverTimestamp: () => SERVER_TS,
      delete: () => '__FIELD_DELETE__',
      arrayUnion: (...elements) => ({ __sentinel: 'arrayUnion', elements }),
      arrayRemove: (...elements) => ({ __sentinel: 'arrayRemove', elements })
    }
  };
}

module.exports = { createFakeFirestore, SERVER_TS };
