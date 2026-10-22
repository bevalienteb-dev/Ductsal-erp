// functions/__tests__/executeSec01Purge.unit.test.js
// Unit tests for the controlled SEC-01 purge script using fake in-memory Firestore & Auth.

const { executeSec01Purge } = require('../scripts/executeSec01Purge');

function buildFakeStore(initialDocs) {
  const store = {};
  for (const [id, data] of Object.entries(initialDocs)) {
    store[id] = { ...data };
  }
  const audits = [];

  const FieldValue = {
    delete: () => '__FIELD_VALUE_DELETE__',
    serverTimestamp: () => new Date().toISOString()
  };

  const db = {
    collection: (name) => {
      if (name === 'commercialAudit_prod') {
        return {
          doc: () => ({
            id: `audit_${audits.length + 1}`
          })
        };
      }
      return {
        doc: (id) => ({
          get: async () => {
            const exists = Object.prototype.hasOwnProperty.call(store, id);
            return {
              exists,
              id,
              data: () => (exists ? { ...store[id] } : undefined)
            };
          },
          update: async (patch) => {
            if (!store[id]) throw new Error(`Doc ${id} not found`);
            for (const [k, v] of Object.entries(patch)) {
              if (v === '__FIELD_VALUE_DELETE__' || (v && v.isDelete)) {
                delete store[id][k];
              } else {
                store[id][k] = v;
              }
            }
          }
        }),
        get: async () => {
          const keys = Object.keys(store);
          return {
            size: keys.length,
            docs: keys.map(k => ({
              id: k,
              data: () => ({ ...store[k] })
            }))
          };
        }
      };
    },
    runTransaction: async (updateFunction) => {
      const tx = {
        get: async (docRef) => docRef.get(),
        update: (docRef, patch) => docRef.update(patch),
        set: (docRef, data) => { audits.push(data); }
      };
      return await updateFunction(tx);
    },
    FieldValue: {
      delete: () => ({ isDelete: true }),
      serverTimestamp: () => new Date().toISOString()
    }
  };

  return { db, store, audits, FieldValue };
}

describe('executeSec01Purge Unit Tests', () => {
  let fakeDocs;
  let fakeAuthUsers;

  beforeEach(() => {
    fakeDocs = {
      '1776895495203': {
        id: '1776895495203',
        nombre: 'Benjamin Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: 'uid-benjamin',
        password: 'plain_benjamin_pass'
      },
      '1776904494660': {
        id: '1776904494660',
        nombre: 'Denys González',
        email: 'dgonzalez@ductsal.com',
        role: 'manager',
        activo: true,
        authUid: 'uid-denys',
        password: 'plain_denys_pass'
      },
      '1776904514932': {
        id: '1776904514932',
        nombre: 'Alejandra Ayala',
        email: 'aayala@ductsal.com',
        role: 'gestor',
        activo: true,
        authUid: 'uid-alejandra',
        password: 'plain_alejandra_pass'
      },
      '1788471603604': {
        id: '1788471603604',
        nombre: 'Roberto Flores',
        email: 'rflores@ductsal.com',
        role: 'vendedor',
        activo: true,
        authUid: 'uid-roberto',
        password: 'plain_roberto_pass'
      },
      '1784221928346': {
        id: '1784221928346',
        nombre: 'Gustavo Velásquez',
        email: 'gvelasquez@ductsal.com',
        role: 'vendedor',
        activo: false,
        password: 'plain_gustavo_pass'
      }
    };

    fakeAuthUsers = {
      'uid-benjamin': {
        uid: 'uid-benjamin',
        email: 'bvaliente@grupogama.com',
        disabled: false,
        customClaims: { role: 'manager', manager: true, cid: '1776895495203' },
        metadata: { lastSignInTime: '2026-10-21T10:00:00Z' }
      },
      'uid-denys': {
        uid: 'uid-denys',
        email: 'dgonzalez@ductsal.com',
        disabled: false,
        customClaims: { role: 'manager', manager: true, cid: '1776904494660' },
        metadata: { lastSignInTime: '2026-10-21T10:05:00Z' }
      },
      'uid-alejandra': {
        uid: 'uid-alejandra',
        email: 'aayala@ductsal.com',
        disabled: false,
        customClaims: { role: 'gestor', cid: '1776904514932' },
        metadata: { lastSignInTime: '2026-10-21T10:10:00Z' }
      },
      'uid-roberto': {
        uid: 'uid-roberto',
        email: 'rflores@ductsal.com',
        disabled: false,
        customClaims: { role: 'vendedor', cid: '1788471603604' },
        metadata: { lastSignInTime: '2026-10-21T10:15:00Z' }
      }
    };
  });

  test('successfully executes purge on all 5 authorized documents in sequence', async () => {
    const { db, store } = buildFakeStore(fakeDocs);

    const fakeAdmin = {
      firestore: () => db,
      auth: () => ({
        getUser: async (uid) => fakeAuthUsers[uid] || null,
        getUserByEmail: async (email) => Object.values(fakeAuthUsers).find(u => u.email === email) || null
      })
    };

    const res = await executeSec01Purge(fakeAdmin);

    expect(res.preflightPassed).toBe(true);
    expect(res.activeUsersPurged).toHaveLength(4);
    expect(res.inactiveUserPurged).toBeTruthy();
    expect(res.finalAudit.totalWithPassword).toBe(0);
    expect(res.finalAudit.totalWithoutPassword).toBe(5);
    expect(res.success).toBe(true);

    // Verify all 5 documents in store no longer have password
    for (const [id, doc] of Object.entries(store)) {
      expect(doc.password).toBeUndefined();
      expect(doc.id).toBe(id);
      expect(doc.email).toBeDefined();
    }

    // Verify inactive user remained inactive without Auth UID
    expect(store['1784221928346'].activo).toBe(false);
    expect(store['1784221928346'].authUid).toBeUndefined();

    // Verify active users kept authUid and activo: true
    expect(store['1776895495203'].authUid).toBe('uid-benjamin');
    expect(store['1776895495203'].activo).toBe(true);
  });

  test('aborts and refuses to purge if document count differs from 5', async () => {
    fakeDocs['unexpected_doc'] = { id: 'unexpected_doc', role: 'custom', activo: true };
    const { db } = buildFakeStore(fakeDocs);

    const fakeAdmin = {
      firestore: () => db,
      auth: () => ({
        getUser: async (uid) => fakeAuthUsers[uid] || null,
        getUserByEmail: async (email) => Object.values(fakeAuthUsers).find(u => u.email === email) || null
      })
    };

    await expect(executeSec01Purge(fakeAdmin)).rejects.toThrow('Se esperaban exactamente 5 documentos en users_prod');
  });

  test('aborts if an active user has no recorded login in Firebase Auth', async () => {
    fakeAuthUsers['uid-roberto'].metadata.lastSignInTime = null;
    const { db } = buildFakeStore(fakeDocs);

    const fakeAdmin = {
      firestore: () => db,
      auth: () => ({
        getUser: async (uid) => fakeAuthUsers[uid] || null,
        getUserByEmail: async (email) => Object.values(fakeAuthUsers).find(u => u.email === email) || null
      })
    };

    await expect(executeSec01Purge(fakeAdmin)).rejects.toThrow('falló la verificación de Auth');
  });
});
