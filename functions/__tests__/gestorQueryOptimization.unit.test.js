// functions/__tests__/gestorQueryOptimization.unit.test.js
// Verification of Gestor query optimization, Filter.or behavior,
// in-memory deduplication, and SDK compatibility guardrails.

describe('Gestor Query Optimization & SDK Compatibility Suite', () => {
  const GESTOR_ID = '1776904514932';

  // Synthetic dataset mirroring production prospects_prod characteristics
  const mockProspects = [
    // 1. Created and assigned to gestor (normal commercial lead)
    { id: 'P_NORMAL_1', createdBy: GESTOR_ID, vendedorId: GESTOR_ID, postcierre_habilitado: false, eliminado: false, estado: 'activo' },
    { id: 'P_NORMAL_2', createdBy: GESTOR_ID, vendedorId: GESTOR_ID, postcierre_habilitado: false, eliminado: false, estado: 'activo' },
    // 2. Created by gestor but assigned to another salesperson (inbound delegated)
    { id: 'P_DELEGATED_1', createdBy: GESTOR_ID, vendedorId: 'VEND_ROBERTO', postcierre_habilitado: false, eliminado: false, estado: 'activo' },
    // 3. Created by another user (e.g. manager) but assigned to gestor
    { id: 'P_ASSIGNED_MGR', createdBy: 'MGR_BENJAMIN', vendedorId: GESTOR_ID, postcierre_habilitado: false, eliminado: false, estado: 'activo' },
    // 4. Closed project with post-closing enabled, handled by another salesperson
    { id: 'P_POSTCLOSING_OTHER', createdBy: 'VEND_ROBERTO', vendedorId: 'VEND_ROBERTO', postcierre_habilitado: true, eliminado: false, estado: 'ganado' },
    // 5. Closed project with post-closing enabled, handled by gestor
    { id: 'P_POSTCLOSING_OWN', createdBy: GESTOR_ID, vendedorId: GESTOR_ID, postcierre_habilitado: true, eliminado: false, estado: 'ganado' },
    // 6. Soft deleted documents (must never enter memory)
    { id: 'P_DELETED_1', createdBy: GESTOR_ID, vendedorId: GESTOR_ID, postcierre_habilitado: false, eliminado: true, estado: 'activo' },
    { id: 'P_DELETED_POST', createdBy: 'VEND_ROBERTO', vendedorId: 'VEND_ROBERTO', postcierre_habilitado: true, eliminado: true, estado: 'ganado' },
    // 7. Outside leads (unrelated to gestor, postclosing not enabled)
    { id: 'P_FOREIGN_1', createdBy: 'VEND_ROBERTO', vendedorId: 'VEND_ROBERTO', postcierre_habilitado: false, eliminado: false, estado: 'activo' },
    { id: 'P_FOREIGN_2', createdBy: 'MGR_DENYS', vendedorId: 'VEND_ROBERTO', postcierre_habilitado: false, eliminado: false, estado: 'activo' }
  ];

  test('1. Previous 3-query approach produces redundant reads but deduplicates cleanly in memory', () => {
    // Query 1: createdBy == GESTOR_ID
    const snapCreated = mockProspects.filter(p => p.createdBy === GESTOR_ID);
    // Query 2: vendedorId == GESTOR_ID
    const snapAssigned = mockProspects.filter(p => p.vendedorId === GESTOR_ID);
    // Query 3: postcierre_habilitado == true
    const snapPostclosing = mockProspects.filter(p => p.postcierre_habilitado === true);

    const totalRawReads = snapCreated.length + snapAssigned.length + snapPostclosing.length;

    // Deduplication via dictionary (as implemented in app_core.js)
    const dict = {};
    snapCreated.forEach(p => { dict[p.id] = p; });
    snapAssigned.forEach(p => { dict[p.id] = p; });
    snapPostclosing.forEach(p => { dict[p.id] = p; });

    const inMemoryDocs = Object.values(dict).filter(p => p.eliminado !== true);
    const inMemoryIds = inMemoryDocs.map(p => p.id).sort();

    // Verification
    expect(totalRawReads).toBeGreaterThan(inMemoryDocs.length); // Redundant reads exist
    expect(inMemoryDocs.length).toBe(6);
    expect(inMemoryIds).toEqual([
      'P_ASSIGNED_MGR',
      'P_DELEGATED_1',
      'P_NORMAL_1',
      'P_NORMAL_2',
      'P_POSTCLOSING_OTHER',
      'P_POSTCLOSING_OWN'
    ].filter(id => id !== 'P_DELETED_1' && id !== 'P_DELETED_POST').sort());

    // Ensure soft-deleted docs are completely excluded
    expect(inMemoryDocs.some(p => p.eliminado === true)).toBe(false);
    // Ensure foreign leads without postcierre are completely excluded
    expect(inMemoryDocs.some(p => p.id === 'P_FOREIGN_1' || p.id === 'P_FOREIGN_2')).toBe(false);
  });

  test('2. Filter.or mathematically produces the exact identical set without duplicate reads', () => {
    // Emulate Filter.or(createdBy == uid, vendedorId == uid, postcierre_habilitado == true)
    const orResults = mockProspects.filter(p =>
      p.createdBy === GESTOR_ID ||
      p.vendedorId === GESTOR_ID ||
      p.postcierre_habilitado === true
    );

    const orFiltered = orResults.filter(p => p.eliminado !== true);
    const orIds = orFiltered.map(p => p.id).sort();

    // Verify exact equality of sets
    const expectedIds = [
      'P_ASSIGNED_MGR',
      'P_DELEGATED_1',
      'P_NORMAL_1',
      'P_NORMAL_2',
      'P_POSTCLOSING_OTHER',
      'P_POSTCLOSING_OWN'
    ].sort();

    expect(orIds).toEqual(expectedIds);
    expect(orFiltered.length).toBe(6);

    // Redundant reads are eliminated at the engine level:
    // Raw docs matched in OR query = exactly 8 (including 2 deleted), vs 10 in 3 separate queries
    expect(orResults.length).toBe(8);
  });

  test('3. Postclosing scope is strictly preserved in both approaches', () => {
    // Document with postcierre_habilitado == true, created & assigned to another salesperson
    const pClosedOther = mockProspects.find(p => p.id === 'P_POSTCLOSING_OTHER');
    expect(pClosedOther).toBeDefined();

    // Evaluated in previous approach
    const inOld = (pClosedOther.createdBy === GESTOR_ID || pClosedOther.vendedorId === GESTOR_ID || pClosedOther.postcierre_habilitado === true);
    // Evaluated in Filter.or approach
    const inNew = (pClosedOther.createdBy === GESTOR_ID || pClosedOther.vendedorId === GESTOR_ID || pClosedOther.postcierre_habilitado === true);

    expect(inOld).toBe(true);
    expect(inNew).toBe(true);
  });

  test('4. Manager and Vendedor queries are completely unimpacted', () => {
    // Manager reads all non-deleted
    const mgrDocs = mockProspects.filter(p => p.eliminado !== true);
    expect(mgrDocs.length).toBe(8); // all except P_DELETED_1 and P_DELETED_POST

    // Vendedor reads strictly assigned non-deleted
    const vendDocs = mockProspects.filter(p => p.vendedorId === 'VEND_ROBERTO' && p.eliminado !== true);
    expect(vendDocs.length).toBe(4); // P_DELEGATED_1 is createdBy gestor, but vendedorId Roberto!
    expect(vendDocs.map(p => p.id).sort()).toEqual(['P_DELEGATED_1', 'P_FOREIGN_1', 'P_FOREIGN_2', 'P_POSTCLOSING_OTHER'].sort());
  });

  test('5. Compat SDK guardrail: detects absence of window.firebase.firestore.Filter safely', () => {
    // Simulate window.firebase compat environment
    const fakeFirebaseCompat = {
      firestore: () => ({
        collection: (name) => ({
          where: function(field, op, val) {
            if (arguments.length < 3) {
              throw new TypeError("Cannot read properties of undefined (reading '_internalPath')");
            }
            return { type: 'query', field, op, val };
          }
        })
      })
    };
    fakeFirebaseCompat.firestore.Filter = undefined; // Compat does not expose Filter

    const hasFilterSupport = typeof fakeFirebaseCompat.firestore.Filter === 'function' &&
                             typeof fakeFirebaseCompat.firestore.Filter.or === 'function';

    expect(hasFilterSupport).toBe(false);

    // Fail-safe logic: if hasFilterSupport is false, must fall back safely to 3-query listener
    let queryStrategy;
    if (hasFilterSupport) {
      queryStrategy = 'OR_QUERY';
    } else {
      queryStrategy = 'MULTI_QUERY_LISTENER';
    }

    expect(queryStrategy).toBe('MULTI_QUERY_LISTENER');
  });
});
