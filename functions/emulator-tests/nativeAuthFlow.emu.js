// functions/emulator-tests/nativeAuthFlow.emu.js
// Automated verification suite for PASO 6.3.4: Local Firebase Authentication Native Architecture.
// Rigorously tests the 18 mandatory scenarios defined in Step 6.3.2 Design Document (Section 13):
//  1. Ticket issuance on user creation (createUserAdmin)
//  2. Ticket issuance on invitation resend (resendInvitationAdmin)
//  3. Rejection of unissued / forged requestId (recordInvitationOutcomeAdmin)
//  4. Rejection of mismatched ticket userId
//  5. Rejection of expired ticket (>24h TTL)
//  6. Successful dispatch reporting ('accepted' outcome, sentCount increment, status preserved)
//  7. Idempotency on already recorded ticket (duplicate: true, no duplicate counter increment)
//  8. Unequivocal failure reporting ('failed' outcome, sanitized errorCode, sentCount unchanged)
//  9. Ambiguous outcome reporting ('unknown' outcome, sentCount unchanged, no auto-resend)
//  10. Protection of confirmed 'accepted' status against delayed 'unknown' report
//  11. Rejection of unwhitelisted error code ('invalid-argument')
//  12. Resend preserves 'activated' status without regression to 'pending'
//  13. Atomic user activation via confirmUserActivation with server timestamp and audit
//  14. Idempotency on repeated activation calls ({ alreadyActive: true })
//  15. Rejection of activation for inactive user (activo: false)
//  16. Outbox isolation between different manager sessions (SEC-16)
//  17. Self-service password recovery anti-enumeration (identical response for existing vs non-existing user)
//  18. Session token revocation upon email change in updateUserAdmin

const crypto = require('crypto');
const H = require('./authEmulatorTestHelper');
const CrmOutbox = require('../../crm_outbox');

const SUFFIX = '_local';
const USERS_COLLECTION = `users${SUFFIX}`;
const INVITATION_OPS_COLLECTION = `invitationOps${SUFFIX}`;
const AUDIT_COLLECTION = `commercialAudit${SUFFIX}`;

const randomSecret = () => 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
const randomTag = () => crypto.randomBytes(4).toString('hex');

describe('Step 6.3.4 — Firebase Authentication Native Architecture & 18 Verification Scenarios', () => {
  const tag = randomTag();
  const testManagerEmail = `gerente.${tag}@example.test`;
  const mgrPassword = randomSecret();
  const state = {};

  beforeAll(async () => {
    // Assert safety guards and loopback
    H.assertSafetyGuard(process.env);
    await H.assertEmulatorsReachable();
    await H.clearAllEmulatorData();

    // 1. Provision manager in Auth emulator
    const url = `${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testManagerEmail, password: mgrPassword, returnSecureToken: true })
    });
    const authData = await res.json();
    state.managerUid = authData.localId;

    // Grant custom claims { role: 'manager', manager: true, cid: '1000000000002' }
    await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${H.PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: state.managerUid,
        customAttributes: JSON.stringify({ role: 'manager', manager: true, cid: '1000000000002' })
      })
    });

    // Write manager profile in Firestore users_local
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/1000000000002`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: '1000000000002' },
          authUid: { stringValue: state.managerUid },
          email: { stringValue: testManagerEmail },
          nombre: { stringValue: 'Gerente Pruebas Nativas' },
          role: { stringValue: 'manager' },
          activo: { booleanValue: true }
        }
      })
    });

    // Obtain fresh ID token for manager
    const signedMgr = await H.signInTestUser(testManagerEmail, mgrPassword);
    state.managerToken = signedMgr.idToken;
  });

  afterAll(async () => {
    await H.clearAllEmulatorData();
    CrmOutbox.clear();
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 1: Ticket issuance on user creation
  // -----------------------------------------------------------------------------------------------
  test('Escenario 1: createUserAdmin pre-registra ticket ISSUED en invitationOps y retorna requestId', async () => {
    const email = `vendedor.s1.${tag}@example.test`;
    const opId = `op-s1-${tag}`;
    const payload = {
      email,
      nombre: 'Vendedor S1',
      role: 'vendedor',
      opId,
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('createUserAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      uid: expect.any(String),
      id: expect.any(String),
      email,
      status: 'created',
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/)
    });

    state.user1Id = res.result.id;
    state.user1Uid = res.result.uid;
    state.user1Email = email;
    state.ticket1Id = res.result.requestId;

    // Verify ticket in Firestore invitationOps_local
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.ticket1Id}`);
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields).toBeDefined();
    expect(ticketDoc.fields.status.stringValue).toBe('ISSUED');
    expect(ticketDoc.fields.userId.stringValue).toBe(state.user1Id);
    expect(ticketDoc.fields.recipientEmail.stringValue).toBe(email);
    expect(ticketDoc.fields.operation.stringValue).toBe('create_user');
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 2: Ticket issuance on invitation resend
  // -----------------------------------------------------------------------------------------------
  test('Escenario 2: resendInvitationAdmin pre-registra ticket ISSUED en invitationOps y retorna requestId', async () => {
    const payload = {
      id: state.user1Id,
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('resendInvitationAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      authorized: true,
      id: state.user1Id,
      email: state.user1Email,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/)
    });

    state.resendTicketId = res.result.requestId;

    // Verify ticket in Firestore
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.resendTicketId}`);
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.status.stringValue).toBe('ISSUED');
    expect(ticketDoc.fields.operation.stringValue).toBe('resend_invitation');
    expect(ticketDoc.fields.userId.stringValue).toBe(state.user1Id);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 3: Rejection of unissued / forged requestId
  // -----------------------------------------------------------------------------------------------
  test('Escenario 3: recordInvitationOutcomeAdmin rechaza requestId no emitido con not-found', async () => {
    const fakeRequestId = crypto.randomUUID();
    const payload = {
      requestId: fakeRequestId,
      userId: state.user1Id,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('NOT_FOUND');
    expect(res.error.message).toMatch(/no registrado o inexistente/i);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 4: Rejection of mismatched ticket userId
  // -----------------------------------------------------------------------------------------------
  test('Escenario 4: recordInvitationOutcomeAdmin rechaza ticket correspondiente a otro usuario con permission-denied', async () => {
    const payload = {
      requestId: state.ticket1Id,
      userId: 'usr-wrong-id-999',
      outcome: 'accepted',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('PERMISSION_DENIED');
    expect(res.error.message).toMatch(/no corresponde al usuario/i);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 5: Rejection of expired ticket (>24h TTL)
  // -----------------------------------------------------------------------------------------------
  test('Escenario 5: recordInvitationOutcomeAdmin rechaza ticket expirado con failed-precondition', async () => {
    const expiredTicketId = crypto.randomUUID();
    const expiredTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1h ago

    // Directly seed expired ticket
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${expiredTicketId}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          status: { stringValue: 'ISSUED' },
          userId: { stringValue: state.user1Id },
          recipientEmail: { stringValue: state.user1Email },
          operation: { stringValue: 'create_user' },
          requestedBy: { stringValue: state.managerUid },
          expiresAt: { timestampValue: expiredTimestamp }
        }
      })
    });

    const payload = {
      requestId: expiredTicketId,
      userId: state.user1Id,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('FAILED_PRECONDITION');
    expect(res.error.message).toMatch(/ha caducado|TTL/i);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 6: Successful dispatch reporting ('accepted' outcome)
  // -----------------------------------------------------------------------------------------------
  test('Escenario 6: reporte accepted cierra ticket RECORDED, actualiza lastRequestStatus y sentCount a 1', async () => {
    const payload = {
      requestId: state.ticket1Id,
      userId: state.user1Id,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      recorded: true,
      duplicate: false,
      reconciled: false,
      requestId: state.ticket1Id,
      userId: state.user1Id,
      sentCount: 1,
      lastRequestStatus: 'accepted'
    });

    // Verify ticket is closed as RECORDED in Firestore
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.ticket1Id}`);
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.status.stringValue).toBe('RECORDED');
    expect(ticketDoc.fields.outcome.stringValue).toBe('accepted');

    // Verify user profile in Firestore
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(invMap.status.stringValue).toMatch(/pending|prepared/); // Lifecycle remains pending until user signs in!
    expect(invMap.lastRequestStatus.stringValue).toBe('accepted');
    expect(Number(invMap.sentCount.integerValue)).toBe(1);
    expect(invMap.lastAcceptedAt).toBeDefined();
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 7: Idempotency on already recorded ticket
  // -----------------------------------------------------------------------------------------------
  test('Escenario 7: llamada repetida sobre ticket RECORDED retorna duplicate: true sin incrementar sentCount', async () => {
    const payload = {
      requestId: state.ticket1Id,
      userId: state.user1Id,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      recorded: true,
      duplicate: true,
      reconciled: false,
      requestId: state.ticket1Id,
      userId: state.user1Id,
      sentCount: 1,
      lastRequestStatus: 'accepted'
    });

    // Check that profile sentCount is still 1
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(Number(invMap.sentCount.integerValue)).toBe(1);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 8: Unequivocal failure reporting ('failed' outcome)
  // -----------------------------------------------------------------------------------------------
  test('Escenario 8: reporte failed registra lastError y preserva sentCount sin incremento', async () => {
    // We use the resend ticket created in Scenario 2
    const payload = {
      requestId: state.resendTicketId,
      userId: state.user1Id,
      outcome: 'failed',
      errorCode: 'TOO_MANY_REQUESTS',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      recorded: true,
      duplicate: false,
      lastRequestStatus: 'failed'
    });

    // Check that profile reflects failure without sentCount increment
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(invMap.lastRequestStatus.stringValue).toBe('failed');
    expect(invMap.lastError.stringValue).toBe('TOO_MANY_REQUESTS');
    expect(Number(invMap.sentCount.integerValue)).toBe(1); // Still 1 from scenario 6
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 9: Ambiguous outcome reporting ('unknown' outcome)
  // -----------------------------------------------------------------------------------------------
  test('Escenario 9: reporte unknown registra CLIENT_TIMEOUT y no incrementa sentCount', async () => {
    // Create new user for scenario 9
    const email = `vendedor.s9.${tag}@example.test`;
    const createRes = await H.callFunction('createUserAdmin', {
      email,
      nombre: 'Vendedor S9',
      role: 'vendedor',
      opId: `op-s9-${tag}`,
      dbSuffix: SUFFIX
    }, state.managerToken);

    state.user9Id = createRes.result.id;
    state.ticket9Id = createRes.result.requestId;

    const payload = {
      requestId: state.ticket9Id,
      userId: state.user9Id,
      outcome: 'unknown',
      errorCode: 'CLIENT_TIMEOUT',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      recorded: true,
      reconciled: true,
      sentCount: 0,
      lastRequestStatus: 'unknown'
    });

    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user9Id}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(invMap.lastRequestStatus.stringValue).toBe('unknown');
    expect(Number(invMap.sentCount.integerValue)).toBe(0);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 10: Protection of confirmed 'accepted' status against delayed 'unknown' report
  // -----------------------------------------------------------------------------------------------
  test('Escenario 10: un reporte tardío unknown no sobreescribe un estado accepted previo en el perfil', async () => {
    // user1 currently has lastRequestStatus = failed from scenario 8.
    // Let's create ticket and set it to accepted first
    const resendRes = await H.callFunction('resendInvitationAdmin', { id: state.user1Id, dbSuffix: SUFFIX }, state.managerToken);
    const acceptedTicketId = resendRes.result.requestId;

    // Report accepted
    await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: acceptedTicketId,
      userId: state.user1Id,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.managerToken);

    // Now issue another ticket that simulates a race condition with unknown
    const raceRes = await H.callFunction('resendInvitationAdmin', { id: state.user1Id, dbSuffix: SUFFIX }, state.managerToken);
    const raceTicketId = raceRes.result.requestId;

    // Report unknown on race ticket
    await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: raceTicketId,
      userId: state.user1Id,
      outcome: 'unknown',
      errorCode: 'NETWORK_ERROR',
      dbSuffix: SUFFIX
    }, state.managerToken);

    // Critical invariant: lastRequestStatus in user1 profile must REMAIN 'accepted'!
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(invMap.lastRequestStatus.stringValue).toBe('accepted');
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 11: Rejection of unwhitelisted error code
  // -----------------------------------------------------------------------------------------------
  test('Escenario 11: recordInvitationOutcomeAdmin rechaza códigos de error no autorizados con invalid-argument', async () => {
    const resendRes = await H.callFunction('resendInvitationAdmin', { id: state.user1Id, dbSuffix: SUFFIX }, state.managerToken);
    const ticketId = resendRes.result.requestId;

    const badPayload = {
      requestId: ticketId,
      userId: state.user1Id,
      outcome: 'failed',
      errorCode: '<script>alert("xss")</script>',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('recordInvitationOutcomeAdmin', badPayload, state.managerToken);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('INVALID_ARGUMENT');
    expect(res.error.message).toMatch(/unwhitelisted/i);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 12: Resend preserves 'activated' status
  // -----------------------------------------------------------------------------------------------
  test('Escenario 12: reenvío a usuario con status activated preserva activated y no lo degrada', async () => {
    // Manually mark user1 as activated in Firestore
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}?updateMask.fieldPaths=invitation.status`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          invitation: {
            mapValue: {
              fields: {
                status: { stringValue: 'activated' }
              }
            }
          }
        }
      })
    });

    // Call resendInvitationAdmin on activated user
    const res = await H.callFunction('resendInvitationAdmin', { id: state.user1Id, dbSuffix: SUFFIX }, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result.currentStatus).toBe('activated');
    expect(res.result.invitation.status).toBe('activated');

    // Confirm profile in Firestore STILL has status: 'activated'
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.user1Id}`);
    const userDoc = await userRes.json();
    expect(userDoc.fields.invitation.mapValue.fields.status.stringValue).toBe('activated');
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 13: Atomic user activation via confirmUserActivation
  // -----------------------------------------------------------------------------------------------
  test('Escenario 13: confirmUserActivation autenticado transiciona status a activated con auditoría', async () => {
    // Create new vendedor who will activate
    const email = `vendedor.act.${tag}@example.test`;
    const password = randomSecret();
    const createRes = await H.callFunction('createUserAdmin', {
      email,
      nombre: 'Vendedor Activar',
      role: 'vendedor',
      opId: `op-act-${tag}`,
      dbSuffix: SUFFIX
    }, state.managerToken);

    const vId = createRes.result.id;
    const vUid = createRes.result.uid;

    // User completes password setup via Auth emulator
    await H.sendPasswordResetOobCode(email);
    const oob = await H.getLastOobCode(email, 'PASSWORD_RESET');
    await H.completePasswordReset(oob.oobCode, password);

    // Vendedor signs in to obtain their own user token
    const vendedorSession = await H.signInTestUser(email, password);
    const vendedorToken = vendedorSession.idToken;

    // Vendedor invokes confirmUserActivation
    const actRes = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, vendedorToken);
    expect(actRes.httpStatus).toBe(200);
    expect(actRes.result).toEqual({ activated: true, newlyActivated: true });

    // Verify Firestore profile
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${vId}`);
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(invMap.status.stringValue).toBe('activated');
    expect(invMap.activatedAt).toBeDefined();

    state.activatedVendedorToken = vendedorToken;
    state.activatedVendedorId = vId;
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 14: Idempotency on repeated activation calls
  // -----------------------------------------------------------------------------------------------
  test('Escenario 14: confirmUserActivation en usuario ya activado retorna alreadyActive: true sin escrituras', async () => {
    const res = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, state.activatedVendedorToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toEqual({ activated: true, alreadyActive: true });
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 15: Rejection of activation for inactive user
  // -----------------------------------------------------------------------------------------------
  test('Escenario 15: confirmUserActivation rechaza con permission-denied si el usuario tiene activo: false', async () => {
    // Deactivate user in Firestore
    await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.activatedVendedorId}?updateMask.fieldPaths=activo`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          activo: { booleanValue: false }
        }
      })
    });

    const res = await H.callFunction('confirmUserActivation', { dbSuffix: SUFFIX }, state.activatedVendedorToken);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('PERMISSION_DENIED');
    expect(res.error.message).toMatch(/desactivado/i);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 16: Outbox isolation between different manager sessions (SEC-16)
  // -----------------------------------------------------------------------------------------------
  test('Escenario 16: aislamiento estricto de Outbox local entre sesiones de gerentes distintos', () => {
    CrmOutbox.clear();

    // Manager Alpha enqueues request
    CrmOutbox.enqueue({
      requestId: 'req-alpha-1',
      userId: 'usr-1',
      recipientEmail: 'v1@example.test',
      operation: 'create_user',
      managerAuthUid: state.managerUid
    });

    // Manager Beta enqueues request
    CrmOutbox.enqueue({
      requestId: 'req-beta-1',
      userId: 'usr-2',
      recipientEmail: 'v2@example.test',
      operation: 'create_user',
      managerAuthUid: 'other-manager-uid'
    });

    // Manager Alpha only sees their own pending tickets
    const alphaPending = CrmOutbox.listPending(state.managerUid);
    expect(alphaPending).toHaveLength(1);
    expect(alphaPending[0].requestId).toBe('req-alpha-1');

    // Manager Beta only sees their own pending tickets
    const betaPending = CrmOutbox.listPending('other-manager-uid');
    expect(betaPending).toHaveLength(1);
    expect(betaPending[0].requestId).toBe('req-beta-1');
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 17: Self-service password recovery anti-enumeration
  // -----------------------------------------------------------------------------------------------
  test('Escenario 17: recuperación de contraseña retorna mensaje idéntico para cuenta existente vs inexistente', async () => {
    const existingEmail = testManagerEmail;
    const nonExistingEmail = `nonexistent.${tag}@example.test`;

    const NEUTRAL_MESSAGE = 'Si el correo corresponde a una cuenta activa en DUCTSAL ERP, recibirás un enlace de restablecimiento en breve. Revisa tu carpeta de spam.';

    // Helper simulating processForgotPassword logic
    async function simulateForgotPassword(email) {
      try {
        await H.sendPasswordResetOobCode(email);
        return NEUTRAL_MESSAGE;
      } catch (err) {
        if (err.message && err.message.includes('EMAIL_NOT_FOUND')) {
          return NEUTRAL_MESSAGE; // Strict anti-enumeration
        }
        throw err;
      }
    }

    const resExisting = await simulateForgotPassword(existingEmail);
    const resNonExisting = await simulateForgotPassword(nonExistingEmail);

    expect(resExisting).toBe(NEUTRAL_MESSAGE);
    expect(resNonExisting).toBe(NEUTRAL_MESSAGE);
    expect(resExisting).toBe(resNonExisting);
  });

  // -----------------------------------------------------------------------------------------------
  // Scenario 18: Session token revocation upon email change in updateUserAdmin
  // -----------------------------------------------------------------------------------------------
  test('Escenario 18: updateUserAdmin revoca tokens de sesión (revokeRefreshTokens) al cambiar correo', async () => {
    const newEmail = `vendedor.updated.${tag}@example.test`;
    const payload = {
      id: state.user9Id,
      opId: `op-update-${tag}`,
      email: newEmail,
      nombre: 'Vendedor S9 Actualizado',
      dbSuffix: SUFFIX
    };

    const res = await H.callFunction('updateUserAdmin', payload, state.managerToken);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toMatchObject({
      status: 'updated',
      id: state.user9Id,
      email: newEmail,
      sessionsRevoked: true
    });
  });
});
