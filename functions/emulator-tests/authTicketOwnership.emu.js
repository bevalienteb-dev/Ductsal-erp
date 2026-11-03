// functions/emulator-tests/authTicketOwnership.emu.js
// Integration test suite for Ticket Ownership & Zero-Trust Non-Repudiation (Step 6.3.4.1).
// Verifies:
//  - Backend strictly enforces `context.auth.uid === ticket.requestedBy`.
//  - Two authenticated admins: Admin A creates a ticket, Admin B cannot report its outcome.
//  - Forged payload parameters (requestedBy, managerAuthUid, userId) are ignored.
//  - Rejection with PERMISSION_DENIED causes zero mutations in Firestore (ticket, profile, audit).
//  - Ownership enforcement holds on retries, duplicates, and already-closed tickets.
//  - Admin A can report outcome successfully.
//  - Repeated calls by Admin A maintain strict idempotency.
//  - Ownership validation applies equally to user creation and resend tickets.

const crypto = require('crypto');
const H = require('./authEmulatorTestHelper');

const SUFFIX = '_local';
const USERS_COLLECTION = `users${SUFFIX}`;
const INVITATION_OPS_COLLECTION = `invitationOps${SUFFIX}`;
const AUDIT_COLLECTION = `commercialAudit${SUFFIX}`;

const randomSecret = () => 'Pw-' + crypto.randomBytes(12).toString('hex') + '!';
const randomTag = () => crypto.randomBytes(4).toString('hex');

describe('Step 6.3.4.1 — Multi-Admin Ticket Ownership & Zero-Trust Non-Repudiation', () => {
  const tag = randomTag();
  const state = {
    adminA: { email: `admin.a.${tag}@example.test`, password: randomSecret(), cid: '3000000000001' },
    adminB: { email: `admin.b.${tag}@example.test`, password: randomSecret(), cid: '3000000000002' }
  };

  beforeAll(async () => {
    H.assertSafetyGuard(process.env);
    await H.assertEmulatorsReachable();

    // Helper to provision an admin manager
    async function provisionAdmin(adminObj, nombre) {
      // 1. Create in Auth emulator
      const signUpUrl = `${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
      const sRes = await fetch(signUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminObj.email, password: adminObj.password, returnSecureToken: true })
      });
      const sData = await sRes.json();
      adminObj.uid = sData.localId;

      // 2. Set custom claims { role: 'manager', manager: true, cid: adminObj.cid }
      await fetch(`${H.AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${H.PROJECT}/accounts:update`, {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localId: adminObj.uid,
          customAttributes: JSON.stringify({ role: 'manager', manager: true, cid: adminObj.cid })
        })
      });

      // 3. Create profile in Firestore users_local
      await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${adminObj.cid}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: adminObj.cid },
            authUid: { stringValue: adminObj.uid },
            email: { stringValue: adminObj.email },
            nombre: { stringValue: nombre },
            role: { stringValue: 'manager' },
            activo: { booleanValue: true }
          }
        })
      });

      // 4. Sign in to obtain ID token
      const session = await H.signInTestUser(adminObj.email, adminObj.password);
      adminObj.token = session.idToken;
    }

    await provisionAdmin(state.adminA, 'Administrador Alfa');
    await provisionAdmin(state.adminB, 'Administrador Beta');
  });

  afterAll(async () => {
    await H.clearAllEmulatorData();
  });

  // -----------------------------------------------------------------------------------------------
  // Test 1: Admin A creates ticket; verify requestedBy matches Admin A's UID in Firestore
  // -----------------------------------------------------------------------------------------------
  test('Paso 1: Administrador A crea un usuario y su ticket registra requestedBy = Admin A', async () => {
    const employeeEmail = `vendedor.ownership.${tag}@example.test`;
    const res = await H.callFunction('createUserAdmin', {
      email: employeeEmail,
      nombre: 'Empleado Para Auditoría',
      role: 'vendedor',
      opId: `op-ownership-${tag}`,
      dbSuffix: SUFFIX
    }, state.adminA.token);

    expect(res.httpStatus).toBe(200);
    expect(res.result).toBeDefined();
    state.createdUserId = res.result.id;
    state.requestId = res.result.requestId;

    expect(typeof state.requestId).toBe('string');
    expect(state.requestId.length).toBeGreaterThan(10);

    // Verify ticket in Firestore invitationOps_local
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.requestId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    expect(ticketRes.status).toBe(200);
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.status.stringValue).toBe('ISSUED');
    expect(ticketDoc.fields.requestedBy.stringValue).toBe(state.adminA.uid);
    expect(ticketDoc.fields.userId.stringValue).toBe(state.createdUserId);
  });

  // -----------------------------------------------------------------------------------------------
  // Test 2: Admin B attempts to record outcome of Admin A's ticket -> Rejected PERMISSION_DENIED
  // -----------------------------------------------------------------------------------------------
  test('Paso 2: Administrador B intenta registrar el ticket de Admin A -> Backend rechaza con PERMISSION_DENIED', async () => {
    const res = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: state.requestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminB.token);

    // Must be rejected with HTTP 403 / permission-denied
    expect(res.httpStatus).toBe(403);
    expect(res.error).toBeDefined();
    expect(res.error.status).toBe('PERMISSION_DENIED');
    expect(res.error.message).toMatch(/propiedad exclusiva del emisor|No tienes autorización/);
  });

  // -----------------------------------------------------------------------------------------------
  // Test 3: Verify zero mutations occurred on Admin B's rejected attempt
  // -----------------------------------------------------------------------------------------------
  test('Paso 3: Verificación de CERO mutaciones tras el rechazo de Admin B', async () => {
    // 1. Ticket status must remain strictly ISSUED
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.requestId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.status.stringValue).toBe('ISSUED');
    expect(ticketDoc.fields.outcome).toBeUndefined();

    // 2. User profile invitation status must remain untouched (sentCount = 0)
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.createdUserId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation && userDoc.fields.invitation.mapValue.fields;
    expect(invMap).toBeDefined();
    expect(invMap.status.stringValue).toBe('pending');
    expect(Number(invMap.sentCount.integerValue || 0)).toBe(0);
    expect(invMap.lastRequestStatus.stringValue).toBe('pending');

    // 3. No audit entry registered for Admin B
    const auditRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${AUDIT_COLLECTION}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    if (auditRes.status === 200) {
      const auditJson = await auditRes.json();
      const docs = auditJson.documents || [];
      const adminBAudits = docs.filter(d => JSON.stringify(d).includes(state.adminB.uid));
      expect(adminBAudits.length).toBe(0);
    }
  });

  // -----------------------------------------------------------------------------------------------
  // Test 4: Forged payload parameters (spoofing requestedBy/managerAuthUid) are ignored
  // -----------------------------------------------------------------------------------------------
  test('Paso 4: Parámetros falseados en el cuerpo (requestedBy: Admin A) son ignorados por el backend', async () => {
    const res = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: state.requestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      requestedBy: state.adminA.uid,        // Spoofed in payload
      managerAuthUid: state.adminA.uid,     // Spoofed in payload
      dbSuffix: SUFFIX
    }, state.adminB.token);

    expect(res.httpStatus).toBe(403);
    expect(res.error.status).toBe('PERMISSION_DENIED');
  });

  // -----------------------------------------------------------------------------------------------
  // Test 5: Admin A successfully records outcome of their own ticket
  // -----------------------------------------------------------------------------------------------
  test('Paso 5: Administrador A registra exitosamente el resultado de su propio ticket', async () => {
    const res = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: state.requestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminA.token);

    expect(res.httpStatus).toBe(200);
    expect(res.result).toBeDefined();
    expect(res.result.recorded).toBe(true);
    expect(res.result.duplicate).toBe(false);
    expect(res.result.lastRequestStatus).toBe('accepted');
    expect(res.result.sentCount).toBe(1);

    // Verify ticket mutated to RECORDED
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${state.requestId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.status.stringValue).toBe('RECORDED');
    expect(ticketDoc.fields.outcome.stringValue).toBe('accepted');
  });

  // -----------------------------------------------------------------------------------------------
  // Test 6: Admin B attempts to record outcome on the RECORDED ticket -> Still rejected PERMISSION_DENIED
  // -----------------------------------------------------------------------------------------------
  test('Paso 6: Admin B no puede registrar ni sondear el ticket de Admin A incluso estando ya RECORDED', async () => {
    const res = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: state.requestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminB.token);

    expect(res.httpStatus).toBe(403);
    expect(res.error.status).toBe('PERMISSION_DENIED');
  });

  // -----------------------------------------------------------------------------------------------
  // Test 7: Admin A repeating the call maintains strict idempotency (duplicate: true)
  // -----------------------------------------------------------------------------------------------
  test('Paso 7: Administrador A repite la llamada y el backend mantiene idempotencia estricta', async () => {
    const res = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: state.requestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminA.token);

    expect(res.httpStatus).toBe(200);
    expect(res.result).toBeDefined();
    expect(res.result.recorded).toBe(true);
    expect(res.result.duplicate).toBe(true);
    expect(res.result.sentCount).toBe(1); // sentCount is NOT incremented twice

    // Verify user profile sentCount is still 1
    const userRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${USERS_COLLECTION}/${state.createdUserId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const userDoc = await userRes.json();
    const invMap = userDoc.fields.invitation.mapValue.fields;
    expect(Number(invMap.sentCount.integerValue)).toBe(1);
  });

  // -----------------------------------------------------------------------------------------------
  // Test 8: Ticket ownership is enforced on resendInvitationAdmin tickets
  // -----------------------------------------------------------------------------------------------
  test('Paso 8: Validación de propiedad de ticket en flujo de reenvío (resendInvitationAdmin)', async () => {
    // Admin A triggers resend
    const resendRes = await H.callFunction('resendInvitationAdmin', {
      id: state.createdUserId,
      dbSuffix: SUFFIX
    }, state.adminA.token);

    expect(resendRes.httpStatus).toBe(200);
    const resendRequestId = resendRes.result.requestId;
    expect(resendRequestId).toBeDefined();

    // Verify ticket pre-registered with requestedBy = Admin A
    const ticketRes = await fetch(`${H.FIRESTORE_URL}/v1/projects/${H.PROJECT}/databases/(default)/documents/${INVITATION_OPS_COLLECTION}/${resendRequestId}`, {
      headers: { Authorization: 'Bearer owner' }
    });
    const ticketDoc = await ticketRes.json();
    expect(ticketDoc.fields.requestedBy.stringValue).toBe(state.adminA.uid);

    // Admin B attempts to record outcome of Admin A's resend ticket -> REJECTED
    const rejectRes = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: resendRequestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminB.token);

    expect(rejectRes.httpStatus).toBe(403);
    expect(rejectRes.error.status).toBe('PERMISSION_DENIED');

    // Admin A records outcome of resend ticket -> SUCCEEDS
    const acceptRes = await H.callFunction('recordInvitationOutcomeAdmin', {
      requestId: resendRequestId,
      userId: state.createdUserId,
      outcome: 'accepted',
      dbSuffix: SUFFIX
    }, state.adminA.token);

    expect(acceptRes.httpStatus).toBe(200);
    expect(acceptRes.result.recorded).toBe(true);
    expect(acceptRes.result.sentCount).toBe(2);
  });
});
