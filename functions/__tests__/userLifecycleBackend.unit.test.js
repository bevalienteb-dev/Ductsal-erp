// functions/__tests__/userLifecycleBackend.unit.test.js
// Comprehensive test suite for Step 6.2: User Lifecycle, Authentication, Link Generation & Invitation Resending.
// Validates all 16 mandatory scenarios required by Section 8, plus the corrective requirements for delivery
// semantics, counter accuracy, and sensitive link protection.

'use strict';

jest.mock('firebase-functions', () => require('../test-helpers/fakeFirebase').buildFunctionsFake(), { virtual: true });
jest.mock('firebase-admin', () => require('../test-helpers/fakeFirebase').buildAdminFake(), { virtual: true });

const admin = require('firebase-admin');
const {
  createUserAdmin,
  updateUserAdmin,
  resendInvitationAdmin,
  toggleUserStatusAdmin
} = require('../index');
const {
  invitationDispatcher,
  INVITATION_STATUS,
  ACTION_CODE_SETTINGS,
  isControlledEnvironment
} = require('../invitationService');

const state = admin.__state;

const MGR_CTX = { auth: { uid: 'managerUid' } };
const OTHER_MGR_CTX = { auth: { uid: 'otherManagerUid' } };
const VENDEDOR_CTX = { auth: { uid: 'vendedorUid' } };
const UNAUTH_CTX = {};

let opCounter = 0;
const nextOpId = () => `op_lifecycle_${++opCounter}`;

beforeEach(() => {
  state.docs = {};
  state.authUsers = {};
  state.requesters = {};
  state.updateUserCalls = [];
  state.revokedUids = [];
  state.deletedUids = [];
  state.claimsCalls = [];
  state.passwordResetLinks = [];
  state.createUserCalls = 0;
  state.hooks = {};
  invitationDispatcher.resetDriver();

  // Setup standard managers
  state.docs['users_prod/mgr_1'] = { id: 'mgr_1', authUid: 'managerUid', nombre: 'Gerente Principal', role: 'manager', activo: true, email: 'manager@ductsal.com' };
  state.docs['users_prod/mgr_2'] = { id: 'mgr_2', authUid: 'otherManagerUid', nombre: 'Gerente Secundario', role: 'manager', activo: true, email: 'other.manager@ductsal.com' };
  state.requesters.managerUid = { customClaims: { manager: true } };
  state.requesters.otherManagerUid = { customClaims: { manager: true } };
});

describe('Step 6.2 — Suite de Pruebas Obligatorias del Backend de Usuarios e Invitaciones', () => {

  // -------------------------------------------------------------------------------------------------
  // 1. Creación exitosa de identidad y perfil con semántica de entrega corregida
  // -------------------------------------------------------------------------------------------------
  test('1. Creación exitosa: ticket pre-registrado, delivery: client_sdk, link: null y sentCount: 0 sin incremento prematuro', async () => {
    const email = 'nuevo.vendedor@ductsal.com';
    const nombre = 'Carlos Nuevo';
    const role = 'vendedor';
    const opId = nextOpId();

    const res = await createUserAdmin({ email, nombre, role, opId }, MGR_CTX);

    // Response contract
    expect(res).toMatchObject({
      uid: expect.any(String),
      id: expect.any(String),
      link: null,
      requestId: expect.any(String),
      invitation: {
        status: INVITATION_STATUS.PENDING,
        lastRequestStatus: 'pending',
        delivery: 'client_sdk',
        sent: false,
        preparedCount: 0,
        sentCount: 0,
        recipientEmail: email,
        error: null
      }
    });

    // Check Auth account
    const authUser = state.authUsers[email];
    expect(authUser).toBeDefined();
    expect(authUser.uid).toBe(res.uid);
    expect(authUser.claims).toEqual({ role: 'vendedor', cid: res.id });

    // Check Firestore profile: sentCount must NOT be incremented prematurely
    const profile = state.docs[`users_prod/${res.id}`];
    expect(profile).toBeDefined();
    expect(profile.id).toBe(res.id);
    expect(profile.authUid).toBe(res.uid);
    expect(profile.nombre).toBe(nombre);
    expect(profile.email).toBe(email);
    expect(profile.role).toBe(role);
    expect(profile.activo).toBe(true);
    expect(profile.invitation).toMatchObject({
      status: INVITATION_STATUS.PENDING,
      recipientEmail: email,
      preparedCount: 0,
      sentCount: 0,
      lastSentAt: null,
      lastError: null
    });
  });

  // -------------------------------------------------------------------------------------------------
  // 2. Vinculación correcta mediante UID
  // -------------------------------------------------------------------------------------------------
  test('2. Vinculación correcta entre Auth UID y Firestore authUid sin almacenar contraseñas', async () => {
    const email = 'gestora.verificada@ductsal.com';
    const opId = nextOpId();

    const res = await createUserAdmin({ email, nombre: 'Ana Gestora', role: 'gestor', opId }, MGR_CTX);

    const profile = state.docs[`users_prod/${res.id}`];
    const authUser = state.authUsers[email];

    expect(profile.authUid).toBe(authUser.uid);
    expect(profile.password).toBeUndefined();
    expect(profile.pass).toBeUndefined();
    expect(Object.keys(profile).some(k => /password|hash|pwd/i.test(k))).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------
  // 3. Correo duplicado
  // -------------------------------------------------------------------------------------------------
  test('3a. Rechazo por correo duplicado existente en Firebase Auth', async () => {
    const email = 'duplicado.auth@ductsal.com';
    state.authUsers[email] = { uid: 'auth_preexistente', email, claims: {} };

    await expect(createUserAdmin({ email, nombre: 'Duplicado', role: 'vendedor', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'already-exists' });

    // Profile must not be created
    const created = Object.values(state.docs).some(d => d.email === email && d.id !== 'mgr_1');
    expect(created).toBe(false);
  });

  test('3b. Rechazo por correo duplicado existente en Firestore', async () => {
    const email = 'duplicado.firestore@ductsal.com';
    state.docs['users_prod/existing_profile'] = { id: 'existing_profile', email, nombre: 'Ya Existente', role: 'vendedor', activo: true };

    await expect(createUserAdmin({ email, nombre: 'Nuevo Duplicado', role: 'gestor', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'already-exists' });

    // Auth account must not be created
    expect(state.authUsers[email]).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------------
  // 4. Identidad existente sin perfil
  // -------------------------------------------------------------------------------------------------
  test('4. Identidad existente en Auth sin perfil no se adopta automáticamente (conflicto seguro)', async () => {
    const email = 'huerfana.auth@ductsal.com';
    state.authUsers[email] = { uid: 'uid_huerfano', email };

    await expect(createUserAdmin({ email, nombre: 'Huerfano', role: 'vendedor', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'already-exists' });

    // Must not overwrite or touch the orphaned Auth account
    expect(state.authUsers[email].uid).toBe('uid_huerfano');
  });

  // -------------------------------------------------------------------------------------------------
  // 5. Perfil existente sin identidad
  // -------------------------------------------------------------------------------------------------
  test('5. Perfil existente sin identidad (histórico) rechaza createUser y exige vinculador dedicado', async () => {
    const email = 'historico@ductsal.com';
    state.docs['users_prod/historic_1'] = { id: 'historic_1', email, nombre: 'Histórico', role: 'vendedor', activo: true };

    await expect(createUserAdmin({ email, nombre: 'Recrear Historico', role: 'vendedor', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'already-exists' });

    expect(state.authUsers[email]).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------------
  // 6. Fallo al crear el perfil (Rollback automático)
  // -------------------------------------------------------------------------------------------------
  test('6. Fallo al persistir el perfil en Firestore ejecuta rollback eliminando la identidad de Auth creada', async () => {
    const email = 'rollback.test@ductsal.com';
    const opId = nextOpId();

    // Hook create to throw when writing users_prod
    state.hooks.beforeCreate = (path) => {
      if (path.startsWith('users_prod/')) {
        throw new Error('Disk full on firestore');
      }
    };

    await expect(createUserAdmin({ email, nombre: 'Rollback User', role: 'vendedor', opId }, MGR_CTX))
      .rejects.toMatchObject({ code: 'internal' });

    // The newly created user must have been rolled back
    expect(state.authUsers[email]).toBeUndefined();
    expect(state.deletedUids.length).toBeGreaterThan(0);

    // Operation must be marked as error
    const opData = state.docs[`userOps/${opId}`];
    expect(opData.status).toBe('error');
    expect(opData.rolledBack).toBe(true);
  });

  // -------------------------------------------------------------------------------------------------
  // 7. createUserAdmin en arquitectura nativa no invoca generatePasswordResetLink
  // -------------------------------------------------------------------------------------------------
  test('7. createUserAdmin en arquitectura nativa no invoca generatePasswordResetLink y retorna link: null con status pending', async () => {
    const email = 'link.fail@ductsal.com';
    const opId = nextOpId();

    const linkSpy = jest.fn(() => {
      throw new Error('Auth quota exceeded');
    });
    state.hooks.generatePasswordResetLink = linkSpy;

    const res = await createUserAdmin({ email, nombre: 'Link Fail User', role: 'vendedor', opId }, MGR_CTX);

    expect(linkSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      uid: expect.any(String),
      id: expect.any(String),
      link: null,
      invitation: {
        status: INVITATION_STATUS.PENDING,
        lastRequestStatus: 'pending',
        delivery: 'client_sdk',
        sent: false,
        preparedCount: 0,
        sentCount: 0
      }
    });

    // Profile and Auth account must remain healthy and active
    const profile = state.docs[`users_prod/${res.id}`];
    expect(profile.activo).toBe(true);
    expect(profile.invitation.status).toBe(INVITATION_STATUS.PENDING);
    expect(profile.invitation.sentCount).toBe(0);
    expect(state.authUsers[email]).toBeDefined();
  });

  // -------------------------------------------------------------------------------------------------
  // 8. Reintento de creación (Idempotencia y link strictly null)
  // -------------------------------------------------------------------------------------------------
  test('8. Reintento con el mismo opId retorna el resultado previo sin duplicar y con link strictly null', async () => {
    const email = 'idempotente@ductsal.com';
    const opId = nextOpId();
    const payload = { email, nombre: 'Idem User', role: 'vendedor', opId };

    const first = await createUserAdmin(payload, MGR_CTX);
    expect(first.link).toBeNull();

    const second = await createUserAdmin(payload, MGR_CTX);

    expect(second.uid).toBe(first.uid);
    expect(second.id).toBe(first.id);
    expect(second.message).toBe('operation already completed');
    // Security check: replay MUST NOT expose sensitive link
    expect(second.link).toBeNull();
    expect(state.createUserCalls).toBe(1);

    // Verify userOps does NOT store the raw link or action code
    const opData = state.docs[`userOps/${opId}`];
    expect(opData.invitation.link).toBeUndefined();
    expect(JSON.stringify(opData)).not.toMatch(/oobCode|mode=activate|fake_oob/);
  });

  // -------------------------------------------------------------------------------------------------
  // 9. Actualización de usuario (nombre y rol)
  // -------------------------------------------------------------------------------------------------
  test('9. Actualización exitosa de nombre y rol con sincronización de claims y auditoría', async () => {
    state.docs['users_prod/user_50'] = { id: 'user_50', authUid: 'target_50', nombre: 'Nombre Original', role: 'vendedor', activo: true, email: 'user50@ductsal.com' };
    state.requesters.target_50 = { customClaims: { role: 'vendedor', cid: 'user_50' } };

    const res = await updateUserAdmin({
      id: 'user_50',
      nombre: 'Nombre Modificado',
      role: 'gestor',
      opId: nextOpId()
    }, MGR_CTX);

    expect(res.status).toBe('updated');
    expect(res.nombre).toBe('Nombre Modificado');
    expect(res.role).toBe('gestor');

    // Firestore updated
    const profile = state.docs['users_prod/user_50'];
    expect(profile.nombre).toBe('Nombre Modificado');
    expect(profile.role).toBe('gestor');

    // Claims updated
    expect(state.requesters.target_50.customClaims).toMatchObject({ role: 'gestor', cid: 'user_50' });

    // Commercial audit generated
    const auditEntries = Object.entries(state.docs).filter(([k]) => k.startsWith('commercialAudit_prod/')).map(([, v]) => v);
    expect(auditEntries.length).toBeGreaterThan(0);
    const lastAudit = auditEntries[auditEntries.length - 1];
    expect(lastAudit.action).toBe('updateUser');
    expect(lastAudit.targetId).toBe('user_50');
  });

  // -------------------------------------------------------------------------------------------------
  // 10. Cambio de correo
  // -------------------------------------------------------------------------------------------------
  test('10. Cambio de correo sincroniza Auth y Firestore con verificación de unicidad', async () => {
    const oldEmail = 'viejo@ductsal.com';
    const newEmail = 'nuevo@ductsal.com';
    state.docs['users_prod/user_email_test'] = { id: 'user_email_test', authUid: 'uid_email_test', nombre: 'Email Tester', role: 'vendedor', activo: true, email: oldEmail };
    state.authUsers[oldEmail] = { uid: 'uid_email_test', email: oldEmail, claims: { role: 'vendedor', cid: 'user_email_test' } };
    state.requesters.uid_email_test = { customClaims: { role: 'vendedor', cid: 'user_email_test' }, email: oldEmail };

    const res = await updateUserAdmin({
      id: 'user_email_test',
      email: newEmail,
      opId: nextOpId()
    }, MGR_CTX);

    expect(res.status).toBe('updated');
    expect(res.email).toBe(newEmail);

    // Profile in Firestore
    const profile = state.docs['users_prod/user_email_test'];
    expect(profile.email).toBe(newEmail);

    // Auth account updated
    expect(state.authUsers[newEmail]).toBeDefined();
    expect(state.authUsers[oldEmail]).toBeUndefined();
    expect(state.updateUserCalls.some(c => c.attrs.email === newEmail)).toBe(true);
  });

  test('10b. Cambio de correo rechazado si el nuevo correo ya pertenece a otra cuenta', async () => {
    const existingOtherEmail = 'ocupado@ductsal.com';
    state.authUsers[existingOtherEmail] = { uid: 'other_uid', email: existingOtherEmail };

    state.docs['users_prod/user_change_fail'] = { id: 'user_change_fail', authUid: 'uid_change_fail', nombre: 'Change Fail', role: 'vendedor', activo: true, email: 'initial@ductsal.com' };
    state.authUsers['initial@ductsal.com'] = { uid: 'uid_change_fail', email: 'initial@ductsal.com' };

    await expect(updateUserAdmin({
      id: 'user_change_fail',
      email: existingOtherEmail,
      opId: nextOpId()
    }, MGR_CTX)).rejects.toMatchObject({ code: 'already-exists' });

    // Profile remains unchanged
    expect(state.docs['users_prod/user_change_fail'].email).toBe('initial@ductsal.com');
  });

  // -------------------------------------------------------------------------------------------------
  // 11. Protección de roles
  // -------------------------------------------------------------------------------------------------
  test('11a. Prohibido asignar rol manager en updateUserAdmin', async () => {
    state.docs['users_prod/u_role_prot'] = { id: 'u_role_prot', authUid: 'uid_prot', role: 'vendedor', activo: true, nombre: 'Prot' };
    state.requesters.uid_prot = { customClaims: { role: 'vendedor', cid: 'u_role_prot' } };

    await expect(updateUserAdmin({ id: 'u_role_prot', role: 'manager', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('11b. Prohibido auto-cambio de rol del propio gerente', async () => {
    await expect(updateUserAdmin({ id: 'mgr_1', role: 'vendedor', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('11c. Prohibido auto-cambio de correo del propio gerente mediante updateUserAdmin', async () => {
    await expect(updateUserAdmin({ id: 'mgr_1', email: 'new.mgr@ductsal.com', opId: nextOpId() }, MGR_CTX))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  // -------------------------------------------------------------------------------------------------
  // 12. Reenvío de invitación con arquitectura nativa (sent: false, delivery: 'client_sdk', link: null)
  // -------------------------------------------------------------------------------------------------
  test('12. Reenvío exitoso emite ticket para despacho nativo, sent: false, delivery: client_sdk y link: null', async () => {
    const email = 'resend.ok@ductsal.com';
    state.docs['users_prod/user_resend'] = {
      id: 'user_resend',
      authUid: 'uid_resend',
      email,
      nombre: 'Resend User',
      role: 'vendedor',
      activo: true,
      invitation: { status: INVITATION_STATUS.PENDING, preparedCount: 0, sentCount: 0 }
    };
    state.authUsers[email] = { uid: 'uid_resend', email };
    state.requesters.uid_resend = { disabled: false };

    const res = await resendInvitationAdmin({ id: 'user_resend' }, MGR_CTX);

    expect(res).toMatchObject({
      sent: false,
      delivery: 'client_sdk',
      status: INVITATION_STATUS.PENDING,
      email,
      link: null,
      requestId: expect.any(String),
      invitation: {
        status: INVITATION_STATUS.PENDING,
        delivery: 'client_sdk',
        sent: false,
        sentCount: 0,
        recipientEmail: email
      }
    });

    const profile = state.docs['users_prod/user_resend'];
    expect(profile.invitation.sentCount).toBe(0); // sentCount strictly 0!
    expect(profile.invitation.lastSentAt).toBeUndefined();
    expect(profile.invitation.status).toBe(INVITATION_STATUS.PENDING);
  });

  // -------------------------------------------------------------------------------------------------
  // 13. Reenvíos repetidos (emisión de tickets sin tocar sentCount)
  // -------------------------------------------------------------------------------------------------
  test('13. Reenvíos repetidos emiten tickets independientes sin incrementar sentCount ni duplicar cuentas', async () => {
    const email = 'repeated.resend@ductsal.com';
    state.docs['users_prod/user_rep'] = {
      id: 'user_rep',
      authUid: 'uid_rep',
      email,
      nombre: 'Rep User',
      role: 'gestor',
      activo: true,
      invitation: { status: INVITATION_STATUS.PENDING, preparedCount: 0, sentCount: 0 }
    };
    state.authUsers[email] = { uid: 'uid_rep', email };
    state.requesters.uid_rep = { disabled: false };

    const res1 = await resendInvitationAdmin({ id: 'user_rep' }, MGR_CTX);
    const res2 = await resendInvitationAdmin({ id: 'user_rep' }, MGR_CTX);
    const finalRes = await resendInvitationAdmin({ id: 'user_rep' }, MGR_CTX);

    expect(res1.requestId).not.toBe(res2.requestId);
    expect(res2.requestId).not.toBe(finalRes.requestId);
    expect(finalRes.invitation.sentCount).toBe(0); // remains 0
    expect(finalRes.sent).toBe(false);
    expect(finalRes.delivery).toBe('client_sdk');
    expect(finalRes.link).toBeNull();

    expect(Object.keys(state.authUsers).filter(e => e === email).length).toBe(1);
    expect(Object.values(state.docs).filter(d => d.email === email && d.id !== 'mgr_1').length).toBe(1);
  });

  // -------------------------------------------------------------------------------------------------
  // 14. Error de permisos
  // -------------------------------------------------------------------------------------------------
  test('14. Rechazo riguroso ante falta de permisos (no autenticado, rol no manager, cuenta deshabilitada)', async () => {
    state.docs['users_prod/target_user'] = { id: 'target_user', authUid: 'tu_uid', activo: true, email: 't@ductsal.com' };

    // Unauthenticated
    await expect(createUserAdmin({ email: 'x@x.com', nombre: 'X', role: 'vendedor', opId: nextOpId() }, UNAUTH_CTX))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(resendInvitationAdmin({ id: 'target_user' }, UNAUTH_CTX))
      .rejects.toMatchObject({ code: 'unauthenticated' });

    // Non-manager (vendedor)
    await expect(createUserAdmin({ email: 'x@x.com', nombre: 'X', role: 'vendedor', opId: nextOpId() }, VENDEDOR_CTX))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(resendInvitationAdmin({ id: 'target_user' }, VENDEDOR_CTX))
      .rejects.toMatchObject({ code: 'permission-denied' });

    // Disabled manager
    await expect(createUserAdmin({ email: 'x@x.com', nombre: 'X', role: 'vendedor', opId: nextOpId() }, { auth: { uid: 'disabledManagerUid' } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });

  // -------------------------------------------------------------------------------------------------
  // 15. Rechazo ante cuenta de Auth deshabilitada
  // -------------------------------------------------------------------------------------------------
  test('15. Reenvío a cuenta de Auth deshabilitada es rechazado con failed-precondition', async () => {
    const email = 'delivery.fail@ductsal.com';
    state.docs['users_prod/user_dfail'] = {
      id: 'user_dfail',
      authUid: 'uid_dfail',
      email,
      nombre: 'Fail User',
      role: 'vendedor',
      activo: true,
      invitation: { status: INVITATION_STATUS.PENDING, preparedCount: 0, sentCount: 0 }
    };
    state.authUsers[email] = { uid: 'uid_dfail', email, disabled: true };
    state.requesters.uid_dfail = { disabled: true };

    await expect(resendInvitationAdmin({ id: 'user_dfail' }, MGR_CTX))
      .rejects.toMatchObject({ code: 'failed-precondition' });

    const profile = state.docs['users_prod/user_dfail'];
    expect(profile.invitation.sentCount).toBe(0);
    expect(profile.activo).toBe(true);
  });

  // -------------------------------------------------------------------------------------------------
  // 16. Consistencia de estados de invitación a lo largo del ciclo de vida
  // -------------------------------------------------------------------------------------------------
  test('16. Consistencia de estados de invitación a lo largo del ciclo de vida', async () => {
    const email = 'ciclo.vida@ductsal.com';
    const opId = nextOpId();

    // 1. Initial creation
    const created = await createUserAdmin({ email, nombre: 'Ciclo Vida', role: 'vendedor', opId }, MGR_CTX);
    expect(created.invitation.status).toBe(INVITATION_STATUS.PENDING);
    expect(created.invitation.sent).toBe(false);
    expect(created.invitation.delivery).toBe('client_sdk');
    expect(created.link).toBeNull();

    let profile = state.docs[`users_prod/${created.id}`];
    expect(profile.invitation.status).toBe(INVITATION_STATUS.PENDING);
    expect(profile.invitation.preparedCount).toBe(0);
    expect(profile.invitation.sentCount).toBe(0);

    // 2. Successful Resend
    state.requesters[created.uid] = { disabled: false };
    const resent = await resendInvitationAdmin({ id: created.id }, MGR_CTX);
    expect(resent.invitation.status).toBe(INVITATION_STATUS.PENDING);
    expect(resent.invitation.sent).toBe(false);
    expect(resent.invitation.delivery).toBe('client_sdk');
    expect(resent.link).toBeNull();
    expect(resent.requestId).toBeDefined();

    profile = state.docs[`users_prod/${created.id}`];
    expect(profile.invitation.status).toBe(INVITATION_STATUS.PENDING);
    expect(profile.invitation.sentCount).toBe(0);

    // 3. User activation preserves activated status on subsequent resend
    state.docs[`users_prod/${created.id}`].invitation.status = INVITATION_STATUS.ACTIVATED;
    const resendActivated = await resendInvitationAdmin({ id: created.id }, MGR_CTX);
    expect(resendActivated.currentStatus).toBe(INVITATION_STATUS.ACTIVATED);
    expect(resendActivated.invitation.status).toBe(INVITATION_STATUS.ACTIVATED);

    profile = state.docs[`users_prod/${created.id}`];
    expect(profile.invitation.status).toBe(INVITATION_STATUS.ACTIVATED);
    expect(profile.invitation.sentCount).toBe(0);
  });

  // -------------------------------------------------------------------------------------------------
  // 17. Ausencia de enlaces completos en Firestore (users_prod y userOps)
  // -------------------------------------------------------------------------------------------------
  test('17. Ausencia de enlaces completos y códigos de acción en Firestore (users_prod y userOps)', async () => {
    const email = 'link.protection@ductsal.com';
    const opId = nextOpId();

    const created = await createUserAdmin({ email, nombre: 'No Leaks', role: 'vendedor', opId }, MGR_CTX);

    // Profile in users_prod
    const profile = state.docs[`users_prod/${created.id}`];
    const profileJson = JSON.stringify(profile);
    expect(profileJson).not.toMatch(/oobCode|mode=activate|fake_oob|apiKey/);
    expect(profile.invitation.link).toBeUndefined();

    // Record in userOps
    const opData = state.docs[`userOps/${opId}`];
    const opJson = JSON.stringify(opData);
    expect(opJson).not.toMatch(/oobCode|mode=activate|fake_oob|apiKey/);
    expect(opData.invitation.link).toBeUndefined();
    expect(opData.invitation.linkGenerated).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------
  // 18. Ausencia de enlaces en auditorías (commercialAudit_prod)
  // -------------------------------------------------------------------------------------------------
  test('18. Ausencia de enlaces en auditorías (commercialAudit_prod)', async () => {
    const email = 'audit.safe@ductsal.com';
    state.docs['users_prod/user_audit_safe'] = {
      id: 'user_audit_safe',
      authUid: 'uid_audit_safe',
      email,
      nombre: 'Audit Safe',
      role: 'vendedor',
      activo: true,
      invitation: { status: INVITATION_STATUS.PENDING, preparedCount: 0, sentCount: 0 }
    };
    state.authUsers[email] = { uid: 'uid_audit_safe', email };
    state.requesters.uid_audit_safe = { disabled: false };

    await resendInvitationAdmin({ id: 'user_audit_safe' }, MGR_CTX);

    // Scan commercialAudit_prod entries
    const auditEntries = Object.entries(state.docs)
      .filter(([k]) => k.startsWith('commercialAudit_prod/'))
      .map(([, v]) => v);

    const resendAudit = auditEntries.find(a => a.action === 'resendInvitation' && a.targetId === 'user_audit_safe');
    expect(resendAudit).toBeDefined();
    const auditJson = JSON.stringify(resendAudit);
    expect(auditJson).not.toMatch(/oobCode|mode=activate|fake_oob|apiKey/);
    expect(resendAudit.detail.link).toBeUndefined();
    expect(resendAudit.detail.linkGenerated).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------
  // 19. Reenvío emite tickets independientes (requestId unívocos) sin generar enlaces en el servidor
  // -------------------------------------------------------------------------------------------------
  test('19. Reenvío emite tickets independientes (requestId unívocos) sin generar enlaces en el servidor', async () => {
    const email = 'fresh.link@ductsal.com';
    state.docs['users_prod/user_fresh'] = {
      id: 'user_fresh',
      authUid: 'uid_fresh',
      email,
      nombre: 'Fresh Link User',
      role: 'vendedor',
      activo: true,
      invitation: { status: INVITATION_STATUS.PENDING, preparedCount: 0, sentCount: 0 }
    };
    state.authUsers[email] = { uid: 'uid_fresh', email };
    state.requesters.uid_fresh = { disabled: false };

    const res1 = await resendInvitationAdmin({ id: 'user_fresh' }, MGR_CTX);
    const res2 = await resendInvitationAdmin({ id: 'user_fresh' }, MGR_CTX);

    expect(res1.requestId).toBeDefined();
    expect(res2.requestId).toBeDefined();
    expect(res1.requestId).not.toBe(res2.requestId);
    expect(res1.link).toBeNull();
    expect(res2.link).toBeNull();
  });

});
