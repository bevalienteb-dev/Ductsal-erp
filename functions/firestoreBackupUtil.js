/**
 * firestoreBackupUtil.js
 * Comprehensive utility for Firestore REST backup extraction, type-faithful serialization,
 * pagination handling, and restoration compatibility.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Decodes a Firestore REST API `Value` object recursively into a faithful JavaScript value.
 * Supports all 11 Firestore REST value representations:
 * - nullValue
 * - booleanValue
 * - integerValue
 * - doubleValue
 * - timestampValue
 * - stringValue
 * - bytesValue
 * - referenceValue
 * - geoPointValue
 * - arrayValue
 * - mapValue
 *
 * @param {Object} val Firestore REST Value object
 * @returns {any} Decoded JavaScript value
 */
function decodeFirestoreValue(val) {
  if (val === null || val === undefined) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) {
    const num = Number(val.integerValue);
    return Number.isSafeInteger(num) ? num : String(val.integerValue);
  }
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('stringValue' in val) return String(val.stringValue);
  if ('bytesValue' in val) return String(val.bytesValue);
  if ('referenceValue' in val) return String(val.referenceValue);
  if ('geoPointValue' in val) {
    return {
      latitude: Number(val.geoPointValue.latitude),
      longitude: Number(val.geoPointValue.longitude)
    };
  }
  if ('arrayValue' in val) {
    const values = val.arrayValue && Array.isArray(val.arrayValue.values) ? val.arrayValue.values : [];
    return values.map(decodeFirestoreValue);
  }
  if ('mapValue' in val) {
    const fields = val.mapValue && val.mapValue.fields ? val.mapValue.fields : {};
    const res = {};
    for (const [k, v] of Object.entries(fields)) {
      res[k] = decodeFirestoreValue(v);
    }
    return res;
  }
  return val;
}

/**
 * Decodes a Firestore REST `fields` map into a plain JavaScript object.
 *
 * @param {Object} fields Map of { [fieldName]: FirestoreValue }
 * @returns {Object} Decoded plain JavaScript object
 */
function decodeFirestoreFields(fields) {
  const result = {};
  for (const [k, v] of Object.entries(fields || {})) {
    result[k] = decodeFirestoreValue(v);
  }
  return result;
}

/**
 * Encodes a JavaScript value into a Firestore REST `Value` object.
 *
 * @param {any} val JavaScript value
 * @returns {Object} Firestore REST Value object
 */
function encodeFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(val)) {
      return { timestampValue: val };
    }
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeFirestoreValue) } };
  }
  if (typeof val === 'object') {
    if (typeof val.latitude === 'number' && typeof val.longitude === 'number') {
      return { geoPointValue: { latitude: val.latitude, longitude: val.longitude } };
    }
    if (val._type === 'bytes' && typeof val.value === 'string') {
      return { bytesValue: val.value };
    }
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === '_rawFields' || k === '_createTime' || k === '_updateTime') continue;
      fields[k] = encodeFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/**
 * Formats a Firestore REST document into our backup representation:
 * - Decoded fields accessible directly on the object (for Step 0.3B and Step 6.2 compatibility)
 * - `_rawFields` preserved for bit-for-bit type fidelity and REST restoration
 * - `_createTime` and `_updateTime` preserved for auditability
 */
function formatBackupDocument(doc) {
  const rawFields = doc.fields || {};
  const decoded = decodeFirestoreFields(rawFields);
  decoded._rawFields = rawFields;
  if (doc.createTime) decoded._createTime = doc.createTime;
  if (doc.updateTime) decoded._updateTime = doc.updateTime;
  return decoded;
}

/**
 * Strips all internal backup metadata fields (such as _rawFields, _createTime, _updateTime)
 * from a document object so that they are NEVER accidentally written or restored into Firestore
 * as business properties.
 *
 * @param {Object} doc Decoded document object
 * @returns {Object} Clean document containing only business properties
 */
function stripBackupMetadata(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const clean = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('_')) continue;
    clean[k] = v;
  }
  return clean;
}

/**
 * Builds a selective REST PATCH payload using updateMask to restore a single field
 * without touching or overwriting any other fields in the target Firestore document.
 * Uses _rawFields if available for 100% type fidelity, or encodes the value.
 *
 * @param {Object} doc Formatted backup document
 * @param {string} fieldPath Field path to restore (e.g. 'password')
 * @returns {Object} { updateMaskQuery: string, body: Object }
 */
function buildRestUpdateMaskPayload(doc, fieldPath) {
  if (!doc || typeof doc !== 'object') throw new Error('Invalid document');
  if (!fieldPath || typeof fieldPath !== 'string') throw new Error('Invalid fieldPath');

  let rawValue;
  if (doc._rawFields && doc._rawFields[fieldPath] !== undefined) {
    rawValue = doc._rawFields[fieldPath];
  } else if (doc[fieldPath] !== undefined) {
    rawValue = encodeFirestoreValue(doc[fieldPath]);
  } else {
    throw new Error(`Field '${fieldPath}' not present in backup document`);
  }

  return {
    updateMaskQuery: `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`,
    body: {
      fields: {
        [fieldPath]: rawValue
      }
    }
  };
}

/**
 * Low-level HTTPS GET against Firestore REST API
 */
function firestoreRestGet(pathAndQuery, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      port: 443,
      path: pathAndQuery,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', err => reject(err));
    req.end();
  });
}

/**
 * Exhaustive paginated document fetcher with strict assertions.
 * Traverses all pages until nextPageToken is null, enforcing:
 * 1. Complete consumption of all pages
 * 2. Exact expected count
 * 3. Exact target CIDs
 */
async function fetchAllCollectionDocuments({
  projectId = 'ductsal-erp',
  databaseId = '(default)',
  collectionId = 'users_prod',
  token,
  pageSize = 10,
  expectedCids = ['1776895495203', '1776904494660', '1776904514932', '1788471603604', '1784221928346'],
  maxPages = 5,
  restFetcher = firestoreRestGet
}) {
  if (!token) throw new Error('Missing authorization token for Firestore REST query');

  let allDocuments = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    pageCount++;
    if (pageCount > maxPages) {
      throw new Error(`CRITICAL: Exceeded maximum allowed pages (${maxPages}) for collection ${collectionId}. Possible pagination loop.`);
    }

    let url = `/v1/projects/${projectId}/databases/${databaseId}/documents/${collectionId}?pageSize=${pageSize}`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const res = await restFetcher(url, token);
    if (res.statusCode !== 200) {
      throw new Error(`Firestore REST API returned HTTP ${res.statusCode}: ${res.body}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (e) {
      throw new Error(`Failed to parse Firestore REST response as JSON: ${e.message}`);
    }

    const docs = parsed.documents || [];
    allDocuments = allDocuments.concat(docs);

    pageToken = parsed.nextPageToken || null;
  } while (pageToken);

  // Assertion 1: Exact count
  if (allDocuments.length !== expectedCids.length) {
    throw new Error(`PAGINATION_ASSERTION_FAILED: Expected exactly ${expectedCids.length} documents in ${collectionId}, but retrieved ${allDocuments.length}`);
  }

  // Assertion 2: All target CIDs present and no extras
  const retrievedCids = allDocuments.map(d => path.basename(d.name));
  const missingCids = expectedCids.filter(id => !retrievedCids.includes(id));
  if (missingCids.length > 0) {
    throw new Error(`PAGINATION_ASSERTION_FAILED: Missing required CIDs in backup: ${missingCids.join(', ')}`);
  }
  const unexpectedCids = retrievedCids.filter(id => !expectedCids.includes(id));
  if (unexpectedCids.length > 0) {
    throw new Error(`PAGINATION_ASSERTION_FAILED: Unexpected CIDs found in ${collectionId}: ${unexpectedCids.join(', ')}`);
  }

  // Transform to backup dictionary { [cid]: formattedDoc }
  const backupData = {};
  for (const doc of allDocuments) {
    const cid = path.basename(doc.name);
    backupData[cid] = formatBackupDocument(doc);
  }

  return {
    backupData,
    pageCount,
    documentCount: allDocuments.length
  };
}

module.exports = {
  decodeFirestoreValue,
  decodeFirestoreFields,
  encodeFirestoreValue,
  formatBackupDocument,
  stripBackupMetadata,
  buildRestUpdateMaskPayload,
  fetchAllCollectionDocuments,
  firestoreRestGet
};
