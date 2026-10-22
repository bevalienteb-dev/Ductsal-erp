// functions/isolated-tests/storageTokenRevocation.iso.js
// SEC-08 (historically SEC-05 Phase 2): Isolated Token Revocation and Rollback Verification Suite
// Tests token revocation, false-revocation via null, metadata preservation, and reliable rollback
// on a disposable object in the isolated Storage emulator (port 9290, demo-ductsal-isolated).

const { assertIsolatedUp, BUCKET, ST_HOST } = require('./iso');

describe('SEC-08: Storage Download Token Revocation & Rollback (Isolated)', () => {
  const enc = encodeURIComponent;
  const uniqueId = Date.now();
  const testObjectPath = `local_files/test_disposable/sec05_probe_${uniqueId}.pdf`;
  const initialToken = `sec05-token-alpha-${uniqueId}`;
  const customMetadata = {
    retention: 'permanent_audit',
    uploader_uid: 'vendedor-test-123',
    original_filename: 'cotizacion_sec05_disposable.pdf'
  };
  const testPayload = `%PDF-1.4\n%Disposable probe content for SEC-05 token lifecycle test (${uniqueId})\n%%EOF`;

  beforeAll(async () => {
    await assertIsolatedUp();
  });

  afterAll(async () => {
    // Cleanup disposable test object
    try {
      await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner' }
      });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  test('Step 1: Setup disposable object with initial token and custom metadata', async () => {
    // Upload object
    const uploadRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o?name=${enc(testObjectPath)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        Authorization: 'Bearer owner'
      },
      body: Buffer.from(testPayload)
    });
    expect(uploadRes.status).toBe(200);

    // Set download token and custom metadata
    const patchRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner'
      },
      body: JSON.stringify({
        metadata: {
          ...customMetadata,
          firebaseStorageDownloadTokens: initialToken
        }
      })
    });
    expect(patchRes.status).toBe(200);

    const meta = await patchRes.json();
    expect(meta.downloadTokens).toContain(initialToken);
    expect(meta.metadata.retention).toBe(customMetadata.retention);
    expect(meta.metadata.uploader_uid).toBe(customMetadata.uploader_uid);
  });

  test('Step 2: Access with valid initial token succeeds (HTTP 200), unauthorized tokens fail (HTTP 403)', async () => {
    // Access with valid token
    const resWithToken = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(resWithToken.status).toBe(200);
    const body = await resWithToken.text();
    expect(body).toBe(testPayload);

    // Access without token fails
    const resNoToken = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media`);
    expect(resNoToken.status).toBe(403);

    // Access with invalid token fails
    const resWrongToken = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=invalid-foreign-token`
    );
    expect(resWrongToken.status).toBe(403);
  });

  test('Step 3: Demonstrating that assigning null to firebaseStorageDownloadTokens DOES NOT revoke the token', async () => {
    // Attempting to revoke by setting metadata.firebaseStorageDownloadTokens = null
    const patchNullRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner'
      },
      body: JSON.stringify({
        metadata: {
          firebaseStorageDownloadTokens: null
        }
      })
    });
    expect(patchNullRes.status).toBe(200);

    // Verify token is STILL active and serves the file
    const resAfterNull = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    // Crucial finding: in Firebase Storage, null does not invalidate active download tokens
    expect(resAfterNull.status).toBe(200);
  });

  test('Step 4: Executing reliable token revocation via Firebase delete_token endpoint and verifying preservation of metadata', async () => {
    // Backup current metadata first
    const getMetaRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const preBackup = await getMetaRes.json();
    expect(preBackup.metadata.retention).toBe(customMetadata.retention);

    // Execute true revocation via delete_token endpoint
    const revokeRes = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?delete_token=${initialToken}`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner' }
      }
    );
    expect(revokeRes.status).toBe(200);
    const postMeta = await revokeRes.json();

    // Verify initialToken is removed from downloadTokens
    const tokensAfterRevoke = (postMeta.downloadTokens || '').split(',');
    expect(tokensAfterRevoke).not.toContain(initialToken);

    // Verify remaining custom metadata is 100% PRESERVED
    expect(postMeta.metadata.retention).toBe(customMetadata.retention);
    expect(postMeta.metadata.uploader_uid).toBe(customMetadata.uploader_uid);
    expect(postMeta.metadata.original_filename).toBe(customMetadata.original_filename);

    // Verify access with the revoked token is now FORBIDDEN (HTTP 403)
    const accessWithRevokedToken = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(accessWithRevokedToken.status).toBe(403);
  });

  test('Step 5: Executing rollback (restoring original token) and verifying immediate access restoration with original URL', async () => {
    // Restore initialToken via metadata PATCH
    const restoreRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner'
      },
      body: JSON.stringify({
        metadata: {
          firebaseStorageDownloadTokens: initialToken
        }
      })
    });
    expect(restoreRes.status).toBe(200);
    const restoredMeta = await restoreRes.json();

    // Verify initialToken is back in downloadTokens
    const restoredTokens = (restoredMeta.downloadTokens || '').split(',');
    expect(restoredTokens).toContain(initialToken);

    // Verify access with original URL and initialToken is restored (HTTP 200)
    const accessRestored = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(accessRestored.status).toBe(200);

    const bodyRestored = await accessRestored.text();
    expect(bodyRestored).toBe(testPayload);

    // Verify custom metadata remains preserved after rollback
    expect(restoredMeta.metadata.retention).toBe(customMetadata.retention);
    expect(restoredMeta.metadata.uploader_uid).toBe(customMetadata.uploader_uid);
  });

  test('Step 6: Demonstrating that PATCHing a new UUID APPENDS to downloadTokens instead of revoking existing ones', async () => {
    const crypto = require('crypto');
    const newUuid = crypto.randomUUID();

    // Updating firebaseStorageDownloadTokens via standard PATCH
    const patchRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner'
      },
      body: JSON.stringify({
        metadata: {
          firebaseStorageDownloadTokens: newUuid
        }
      })
    });
    expect(patchRes.status).toBe(200);
    const patchedMeta = await patchRes.json();

    // Critical empirical finding: Firebase Storage appends rather than replaces
    const tokens = (patchedMeta.downloadTokens || '').split(',');
    expect(tokens).toContain(newUuid);
    expect(tokens).toContain(initialToken); // initialToken was NOT revoked!

    // The old token still works because it was appended, not deleted
    const accessWithOldToken = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(accessWithOldToken.status).toBe(200);
  });

  test('Step 7: Proving that delete_token is the ONLY reliable method to eliminate all active tokens', async () => {
    // Read current tokens
    const getRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const currentMeta = await getRes.json();
    const activeTokens = (currentMeta.downloadTokens || '').split(',').map(t => t.trim()).filter(Boolean);
    expect(activeTokens.length).toBeGreaterThan(0);

    // Delete each active token via delete_token endpoint
    for (const tok of activeTokens) {
      const delRes = await fetch(
        `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?delete_token=${tok}`,
        { method: 'POST', headers: { Authorization: 'Bearer owner' } }
      );
      expect(delRes.status).toBe(200);
    }

    // Verify all targeted tokens are removed from downloadTokens
    const postDelRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const postDelMeta = await postDelRes.json();
    const remainingTokens = (postDelMeta.downloadTokens || '').split(',').map(t => t.trim()).filter(Boolean);
    expect(remainingTokens).not.toContain(initialToken);

    // Unauthenticated access with initialToken must now fail (HTTP 403)
    const accessWithOldToken = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(accessWithOldToken.status).toBe(403);

    // Custom metadata remains 100% preserved
    expect(postDelMeta.metadata.retention).toBe(customMetadata.retention);
    expect(postDelMeta.metadata.uploader_uid).toBe(customMetadata.uploader_uid);
  });

  test('Step 8: Proving authenticated server-side download (SEC-07/10 pipeline) functions 100% even with zero download tokens', async () => {
    // Authenticated server-side download (using service account / owner credentials, exactly as getSecureDownloadUrlAdmin operates)
    const serverSideRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media`, {
      headers: { Authorization: 'Bearer owner' }
    });
    expect(serverSideRes.status).toBe(200);
    const content = await serverSideRes.text();
    expect(content).toBe(testPayload);
  });

  test('Step 9: Final rollback verifying restoration of initial token re-enables original URL', async () => {
    // Restore initialToken via metadata PATCH
    const rollbackRes = await fetch(`http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner'
      },
      body: JSON.stringify({
        metadata: {
          firebaseStorageDownloadTokens: initialToken
        }
      })
    });
    expect(rollbackRes.status).toBe(200);

    // Verify initialToken is active again (HTTP 200)
    const accessRestored = await fetch(
      `http://${ST_HOST}/v0/b/${BUCKET}/o/${enc(testObjectPath)}?alt=media&token=${initialToken}`
    );
    expect(accessRestored.status).toBe(200);
    const bodyRestored = await accessRestored.text();
    expect(bodyRestored).toBe(testPayload);
  });
});
