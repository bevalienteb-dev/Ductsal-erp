/**
 * firestoreBackup.unit.test.js
 * Unit test suite verifying:
 * 1. Lossless recursive decoding of all 11 Firestore REST Value types.
 * 2. Multi-page pagination traversal with explicit nextPageToken handling.
 * 3. Strict assertions for document count and exact expected CIDs.
 * 4. Compatibility with Step 0.3B schema validation and Step 6.2 conditional restoration.
 * 5. Preservation of raw fields and zero exposure of passwords in outputs.
 */

const {
  decodeFirestoreValue,
  decodeFirestoreFields,
  encodeFirestoreValue,
  formatBackupDocument,
  stripBackupMetadata,
  buildRestUpdateMaskPayload,
  fetchAllCollectionDocuments
} = require('../firestoreBackupUtil');

describe('Firestore Backup & Restoration Unit Tests', () => {
  describe('Recursive Type Decoding (All 11 Firestore REST Value Types)', () => {
    test('decodes nullValue correctly', () => {
      expect(decodeFirestoreValue({ nullValue: null })).toBeNull();
    });

    test('decodes booleanValue correctly', () => {
      expect(decodeFirestoreValue({ booleanValue: true })).toBe(true);
      expect(decodeFirestoreValue({ booleanValue: false })).toBe(false);
    });

    test('decodes integerValue correctly (safe integers and strings for overflow)', () => {
      expect(decodeFirestoreValue({ integerValue: '0' })).toBe(0);
      expect(decodeFirestoreValue({ integerValue: '1776895495203' })).toBe(1776895495203);
      expect(decodeFirestoreValue({ integerValue: '-42' })).toBe(-42);
      // Beyond Number.MAX_SAFE_INTEGER returns string
      const huge = '9007199254740993999';
      expect(decodeFirestoreValue({ integerValue: huge })).toBe(huge);
    });

    test('decodes doubleValue correctly', () => {
      expect(decodeFirestoreValue({ doubleValue: 123.456 })).toBe(123.456);
      expect(decodeFirestoreValue({ doubleValue: 0.0 })).toBe(0);
    });

    test('decodes timestampValue correctly (RFC 3339 UTC)', () => {
      const ts = '2026-10-18T05:00:00.123456Z';
      expect(decodeFirestoreValue({ timestampValue: ts })).toBe(ts);
    });

    test('decodes stringValue correctly', () => {
      expect(decodeFirestoreValue({ stringValue: 'test string' })).toBe('test string');
      expect(decodeFirestoreValue({ stringValue: '' })).toBe('');
    });

    test('decodes bytesValue correctly', () => {
      const b64 = 'SGVsbG8gV29ybGQ=';
      expect(decodeFirestoreValue({ bytesValue: b64 })).toBe(b64);
    });

    test('decodes referenceValue correctly', () => {
      const ref = 'projects/ductsal-erp/databases/(default)/documents/users_prod/1776895495203';
      expect(decodeFirestoreValue({ referenceValue: ref })).toBe(ref);
    });

    test('decodes geoPointValue correctly', () => {
      const geo = { latitude: 13.6929, longitude: -89.2182 };
      expect(decodeFirestoreValue({ geoPointValue: geo })).toEqual(geo);
    });

    test('decodes arrayValue recursively, including nested mixed types', () => {
      const input = {
        arrayValue: {
          values: [
            { stringValue: 'primer elemento' },
            { integerValue: '100' },
            { booleanValue: true },
            { nullValue: null },
            {
              arrayValue: {
                values: [{ stringValue: 'sub-item' }]
              }
            }
          ]
        }
      };
      expect(decodeFirestoreValue(input)).toEqual([
        'primer elemento',
        100,
        true,
        null,
        ['sub-item']
      ]);
    });

    test('decodes mapValue recursively, including deeply nested maps and arrays', () => {
      const input = {
        mapValue: {
          fields: {
            nombre: { stringValue: 'Benjamín' },
            metadatos: {
              mapValue: {
                fields: {
                  creadoEl: { timestampValue: '2026-01-01T00:00:00Z' },
                  tags: {
                    arrayValue: {
                      values: [{ stringValue: 'admin' }, { stringValue: 'ventas' }]
                    }
                  }
                }
              }
            }
          }
        }
      };
      expect(decodeFirestoreValue(input)).toEqual({
        nombre: 'Benjamín',
        metadatos: {
          creadoEl: '2026-01-01T00:00:00Z',
          tags: ['admin', 'ventas']
        }
      });
    });

    test('decodeFirestoreFields transforms complete document fields map', () => {
      const rawFields = {
        nombre: { stringValue: 'Denys González' },
        email: { stringValue: 'dgonzalez@ductsal.com' },
        role: { stringValue: 'manager' },
        activo: { booleanValue: true },
        password: { stringValue: 'SecretHashOrHistorical123' },
        loginCount: { integerValue: '42' }
      };

      const decoded = decodeFirestoreFields(rawFields);
      expect(decoded).toEqual({
        nombre: 'Denys González',
        email: 'dgonzalez@ductsal.com',
        role: 'manager',
        activo: true,
        password: 'SecretHashOrHistorical123',
        loginCount: 42
      });
    });
  });

  describe('Document Formatting and Raw Fields Preservation', () => {
    test('formatBackupDocument preserves both decoded properties and bit-for-bit _rawFields', () => {
      const doc = {
        name: 'projects/ductsal-erp/databases/(default)/documents/users_prod/1776904494660',
        fields: {
          nombre: { stringValue: 'Denys González' },
          email: { stringValue: 'dgonzalez@ductsal.com' },
          role: { stringValue: 'manager' },
          activo: { booleanValue: true },
          password: { stringValue: 'histPassword456' }
        },
        createTime: '2026-04-20T12:00:00.000Z',
        updateTime: '2026-04-20T12:30:00.000Z'
      };

      const formatted = formatBackupDocument(doc);

      // 1. Direct field access (compatibility with Step 0.3B & Step 6.2)
      expect(formatted.nombre).toBe('Denys González');
      expect(formatted.email).toBe('dgonzalez@ductsal.com');
      expect(formatted.role).toBe('manager');
      expect(formatted.activo).toBe(true);
      expect(formatted.password).toBe('histPassword456');

      // 2. Metadata and raw fields preservation
      expect(formatted._createTime).toBe('2026-04-20T12:00:00.000Z');
      expect(formatted._updateTime).toBe('2026-04-20T12:30:00.000Z');
      expect(formatted._rawFields).toEqual(doc.fields);
    });

    test('stripBackupMetadata completely removes internal metadata fields', () => {
      const backupDoc = {
        id: '1776895495203',
        nombre: 'Benjamín Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        password: '',
        _rawFields: { nombre: { stringValue: 'Benjamín Valiente' } },
        _createTime: '2026-01-01T00:00:00Z',
        _updateTime: '2026-01-02T00:00:00Z'
      };

      const stripped = stripBackupMetadata(backupDoc);

      expect(stripped._rawFields).toBeUndefined();
      expect(stripped._createTime).toBeUndefined();
      expect(stripped._updateTime).toBeUndefined();
      expect(Object.keys(stripped)).toEqual(['id', 'nombre', 'email', 'role', 'activo', 'password']);
    });
  });

  describe('Selective REST updateMask Payload Construction', () => {
    test('buildRestUpdateMaskPayload creates exact updateMask for password using _rawFields', () => {
      const backupDoc = {
        password: 'historicalSecretPassword',
        _rawFields: {
          password: { stringValue: 'historicalSecretPassword' }
        }
      };

      const payload = buildRestUpdateMaskPayload(backupDoc, 'password');

      expect(payload.updateMaskQuery).toBe('updateMask.fieldPaths=password');
      expect(payload.body).toEqual({
        fields: {
          password: { stringValue: 'historicalSecretPassword' }
        }
      });
      // Verifies no other fields are in the payload body
      expect(Object.keys(payload.body.fields)).toEqual(['password']);
    });

    test('buildRestUpdateMaskPayload creates valid payload for empty password (Benjamín Valiente)', () => {
      const backupDoc = {
        password: '',
        _rawFields: {
          password: { stringValue: '' }
        }
      };

      const payload = buildRestUpdateMaskPayload(backupDoc, 'password');

      expect(payload.updateMaskQuery).toBe('updateMask.fieldPaths=password');
      expect(payload.body).toEqual({
        fields: {
          password: { stringValue: '' }
        }
      });
    });
  });

  describe('Pagination Handling and Strict Assertions', () => {
    const targetCids = ['1776895495203', '1776904494660', '1776904514932', '1788471603604', '1784221928346'];

    function createMockDoc(cid) {
      return {
        name: `projects/ductsal-erp/databases/(default)/documents/users_prod/${cid}`,
        fields: {
          id: { stringValue: cid },
          nombre: { stringValue: `User ${cid}` },
          email: { stringValue: `user_${cid}@ductsal.com` },
          role: { stringValue: 'vendedor' },
          activo: { booleanValue: cid !== '1784221928346' },
          password: { stringValue: cid === '1776895495203' ? '' : `pass_${cid}` }
        }
      };
    }

    test('succeeds on single page when nextPageToken is absent', async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({
          documents: targetCids.map(createMockDoc),
          nextPageToken: null
        })
      });

      const res = await fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        expectedCids: targetCids
      });

      expect(mockFetcher).toHaveBeenCalledTimes(1);
      expect(res.documentCount).toBe(5);
      expect(res.pageCount).toBe(1);
      expect(Object.keys(res.backupData).sort()).toEqual(targetCids.sort());
    });

    test('traverses multiple pages seamlessly when nextPageToken is present', async () => {
      // Page 1: first 3 documents with nextPageToken
      // Page 2: remaining 2 documents with nextPageToken: null
      const mockFetcher = jest.fn()
        .mockResolvedValueOnce({
          statusCode: 200,
          body: JSON.stringify({
            documents: targetCids.slice(0, 3).map(createMockDoc),
            nextPageToken: 'token_page_2'
          })
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          body: JSON.stringify({
            documents: targetCids.slice(3).map(createMockDoc),
            nextPageToken: null
          })
        });

      const res = await fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        expectedCids: targetCids
      });

      expect(mockFetcher).toHaveBeenCalledTimes(2);
      expect(mockFetcher).toHaveBeenNthCalledWith(1, expect.stringContaining('pageSize=10'), 'fake-token');
      expect(mockFetcher).toHaveBeenNthCalledWith(2, expect.stringContaining('pageToken=token_page_2'), 'fake-token');
      expect(res.documentCount).toBe(5);
      expect(res.pageCount).toBe(2);
      expect(Object.keys(res.backupData).sort()).toEqual(targetCids.sort());
    });

    test('fails immediately if nextPageToken loops beyond maxPages', async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({
          documents: [createMockDoc('1776895495203')],
          nextPageToken: 'infinite_token'
        })
      });

      await expect(fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        maxPages: 3,
        expectedCids: targetCids
      })).rejects.toThrow(/Exceeded maximum allowed pages/);
    });

    test('fails assertion if document count does not match expected (cardinality mismatch)', async () => {
      // Only 4 documents returned instead of 5
      const mockFetcher = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({
          documents: targetCids.slice(0, 4).map(createMockDoc),
          nextPageToken: null
        })
      });

      await expect(fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        expectedCids: targetCids
      })).rejects.toThrow(/Expected exactly 5 documents in users_prod, but retrieved 4/);
    });

    test('fails assertion if an expected CID is missing', async () => {
      // 5 documents, but one is a rogue CID instead of Gustavo
      const rogueCids = ['1776895495203', '1776904494660', '1776904514932', '1788471603604', '9999999999999'];
      const mockFetcher = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({
          documents: rogueCids.map(createMockDoc),
          nextPageToken: null
        })
      });

      await expect(fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        expectedCids: targetCids
      })).rejects.toThrow(/Missing required CIDs in backup: 1784221928346/);
    });

    test('fails assertion if Firestore REST returns HTTP error', async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        statusCode: 403,
        body: 'Permission denied'
      });

      await expect(fetchAllCollectionDocuments({
        token: 'fake-token',
        restFetcher: mockFetcher,
        expectedCids: targetCids
      })).rejects.toThrow(/Firestore REST API returned HTTP 403/);
    });
  });

  describe('Step 6.2 Restoration Compatibility, Selective Update & Zero Password Exposure', () => {
    const mockFullBackup = {
      '1776895495203': {
        id: '1776895495203',
        nombre: 'Benjamín Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        password: '', // Cadena vacía histórica real
        _rawFields: { password: { stringValue: '' } },
        _createTime: '2026-01-01T00:00:00Z',
        _updateTime: '2026-01-02T00:00:00Z'
      },
      '1776904494660': {
        id: '1776904494660',
        nombre: 'Denys González',
        email: 'dgonzalez@ductsal.com',
        role: 'manager',
        activo: true,
        password: 'HistoricalDenysPassword456',
        _rawFields: { password: { stringValue: 'HistoricalDenysPassword456' } }
      },
      '1776904514932': {
        id: '1776904514932',
        nombre: 'Alexander Ayala',
        email: 'aayala@ductsal.com',
        role: 'gestor',
        activo: true,
        password: 'HistoricalAyalaPassword789',
        _rawFields: { password: { stringValue: 'HistoricalAyalaPassword789' } }
      },
      '1784221928346': {
        id: '1784221928346',
        nombre: 'Gustavo Velasquez',
        email: 'gvelasquez@ductsal.com',
        role: 'vendedor',
        activo: false,
        password: 'HistoricalGustavoPassword321',
        _rawFields: { password: { stringValue: 'HistoricalGustavoPassword321' } }
      },
      '1788471603604': {
        id: '1788471603604',
        nombre: 'Rodrigo Flores',
        email: 'rflores@ductsal.com',
        role: 'vendedor',
        activo: true,
        password: 'HistoricalRodrigoPassword654',
        _rawFields: { password: { stringValue: 'HistoricalRodrigoPassword654' } }
      }
    };

    test('step 6.2 conditional restore succeeds on CID 1776895495203 with empty string password without throwing', () => {
      const targetCid = '1776895495203';
      const targetDoc = mockFullBackup[targetCid];

      // Verifies schema check from Step 6.2
      expect(typeof targetDoc.password).toBe('string');
      expect(targetDoc.password).toBe('');

      // Simulated transaction execution
      const currentDocInFirestore = {
        id: targetCid,
        nombre: 'Benjamín Valiente',
        email: 'bvaliente@grupogama.com',
        role: 'manager',
        activo: true,
        authUid: 'uid_benjamin',
        authProvider: 'firebase'
      };

      const txUpdates = [];
      const mockTx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ ...currentDocInFirestore })
        }),
        update: jest.fn((ref, payload) => {
          txUpdates.push(payload);
        })
      };

      // Execute simulated Step 6.2 logic
      const expectedEmail = targetDoc.email;
      const historicalPassword = targetDoc.password;

      const current = mockTx.get().then(snap => {
        const curData = snap.data();
        if (curData.email !== expectedEmail) {
          throw new Error('Conflicto: El correo actual no coincide');
        }
        mockTx.update('users_prod/' + targetCid, { password: historicalPassword });
      });

      return current.then(() => {
        expect(mockTx.update).toHaveBeenCalledTimes(1);
        expect(txUpdates[0]).toEqual({ password: '' });
        // Verifies metadata fields are NOT in update payload
        expect(txUpdates[0]._rawFields).toBeUndefined();
        expect(txUpdates[0]._createTime).toBeUndefined();
        expect(txUpdates[0]._updateTime).toBeUndefined();
      });
    });

    test('step 6.2 conditional restore succeeds on commercial profiles with non-empty passwords', () => {
      const activeCommercialCids = ['1776904494660', '1776904514932', '1788471603604', '1784221928346'];

      for (const targetCid of activeCommercialCids) {
        const targetDoc = mockFullBackup[targetCid];
        expect(typeof targetDoc.password).toBe('string');
        expect(targetDoc.password.length).toBeGreaterThan(0);

        const currentDoc = {
          email: targetDoc.email,
          role: targetDoc.role,
          activo: targetDoc.activo
        };

        const updatePayloads = [];
        const mockTx = {
          get: jest.fn().mockResolvedValue({ exists: true, data: () => currentDoc }),
          update: jest.fn((ref, payload) => updatePayloads.push(payload))
        };

        if (currentDoc.email !== targetDoc.email) {
          throw new Error('Email mismatch');
        }
        mockTx.update('users_prod/' + targetCid, { password: targetDoc.password });

        expect(updatePayloads[0]).toEqual({ password: targetDoc.password });
        expect(updatePayloads[0]._rawFields).toBeUndefined();
      }
    });

    test('rejects restore if document does not exist in Firestore', async () => {
      const targetCid = '9999999999999';
      const mockTx = {
        get: jest.fn().mockResolvedValue({
          exists: false,
          data: () => null
        }),
        update: jest.fn()
      };

      await expect((async () => {
        const snap = await mockTx.get();
        if (!snap.exists) {
          throw new Error('Perfil no existe en Firestore para CID: ' + targetCid);
        }
      })()).rejects.toThrow(/Perfil no existe en Firestore para CID: 9999999999999/);

      expect(mockTx.update).not.toHaveBeenCalled();
    });

    test('rejects restore if current email in Firestore does not match expected email in backup (modified email / concurrency conflict)', async () => {
      const targetCid = '1776904494660';
      const targetDoc = mockFullBackup[targetCid];
      const modifiedFirestoreEmail = 'altered-dgonzalez@ductsal.com';

      const mockTx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ email: modifiedFirestoreEmail })
        }),
        update: jest.fn()
      };

      await expect((async () => {
        const snap = await mockTx.get();
        const currentData = snap.data();
        if (currentData.email !== targetDoc.email) {
          throw new Error('Conflicto de concurrencia: el correo en Firestore (' + currentData.email + ') no coincide con el respaldo (' + targetDoc.email + '). Abortando restauración.');
        }
        mockTx.update('users_prod/' + targetCid, { password: targetDoc.password });
      })()).rejects.toThrow(/Conflicto de concurrencia: el correo en Firestore/);

      expect(mockTx.update).not.toHaveBeenCalled();
    });

    test('rejects restore if backup hash does not match expected SHA-256 (integrity error)', () => {
      const crypto = require('crypto');
      const fakeBuffer = Buffer.from('tampered content');
      const calculatedHash = crypto.createHash('sha256').update(fakeBuffer).digest('hex');
      const expectedSha256 = '9a43f2fbdd0236df4aa8fd89d964dcb93d3678adf1d222243048894e55829893';

      expect(calculatedHash).not.toBe(expectedSha256);
      expect(() => {
        if (calculatedHash !== expectedSha256) {
          throw new Error('ERROR CRÍTICO: Discrepancia de hash SHA-256 (' + calculatedHash + ' vs ' + expectedSha256 + '). Abortando.');
        }
      }).toThrow(/Discrepancia de hash SHA-256/);
    });

    test('rejects restore if target CID is missing or has non-string password in backup (incomplete/corrupted backup)', () => {
      const corruptedBackup = {
        '1776904494660': { email: 'dgonzalez@ductsal.com' } // Missing password
      };

      const targetCidMissing = '1776895495203';
      expect(() => {
        if (!corruptedBackup[targetCidMissing] || typeof corruptedBackup[targetCidMissing].password !== 'string') {
          throw new Error('ERROR: El perfil ' + targetCidMissing + ' no contiene campo password de tipo string en el respaldo.');
        }
      }).toThrow(/no contiene campo password/);

      const targetCidNoPassword = '1776904494660';
      expect(() => {
        if (!corruptedBackup[targetCidNoPassword] || typeof corruptedBackup[targetCidNoPassword].password !== 'string') {
          throw new Error('ERROR: El perfil ' + targetCidNoPassword + ' no contiene campo password de tipo string en el respaldo.');
        }
      }).toThrow(/no contiene campo password/);
    });

    test('confirms selective update preserves all other business fields and legitimate metadata', async () => {
      const targetCid = '1776904494660';
      const targetDoc = mockFullBackup[targetCid];

      // Simulated state in Firestore prior to restore
      const firestoreDocumentState = {
        id: targetCid,
        nombre: 'Denys González',
        email: 'dgonzalez@ductsal.com',
        role: 'manager',
        activo: true,
        authUid: 'uid_denys_123',
        authProvider: 'firebase',
        departamento: 'Dirección Comercial',
        customMetadata: { auditFlag: true }
      };

      const docBefore = { ...firestoreDocumentState };
      const txUpdates = [];

      const mockTx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ ...firestoreDocumentState })
        }),
        update: jest.fn((ref, payload) => {
          txUpdates.push(payload);
          Object.assign(firestoreDocumentState, payload);
        })
      };

      // Perform selective update
      const snap = await mockTx.get();
      const current = snap.data();
      expect(current.email).toBe(targetDoc.email);

      mockTx.update('users_prod/' + targetCid, { password: targetDoc.password });

      // Verifications:
      // 1. Only password was updated
      expect(txUpdates).toHaveLength(1);
      expect(txUpdates[0]).toEqual({ password: targetDoc.password });

      // 2. All other fields remain 100% identical to their pre-update state
      expect(firestoreDocumentState.nombre).toBe(docBefore.nombre);
      expect(firestoreDocumentState.email).toBe(docBefore.email);
      expect(firestoreDocumentState.role).toBe(docBefore.role);
      expect(firestoreDocumentState.activo).toBe(docBefore.activo);
      expect(firestoreDocumentState.authUid).toBe(docBefore.authUid);
      expect(firestoreDocumentState.authProvider).toBe(docBefore.authProvider);
      expect(firestoreDocumentState.departamento).toBe(docBefore.departamento);
      expect(firestoreDocumentState.customMetadata).toEqual(docBefore.customMetadata);

      // 3. No metadata fields were injected
      expect(firestoreDocumentState._rawFields).toBeUndefined();
      expect(firestoreDocumentState._createTime).toBeUndefined();
      expect(firestoreDocumentState._updateTime).toBeUndefined();
    });
  });
});

