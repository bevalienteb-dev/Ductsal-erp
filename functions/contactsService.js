// functions/contactsService.js
// Server-side logic for the Person & Account Contacts module (Phase 2, Block 1).
// Implements the Hub & Spoke architecture:
//   - Account (`clients_prod` / `clients_local`): central Hub entity.
//   - Person (`contacts_prod` / `contacts_local`): individual identity decoupled from accounts.
//   - Relation (`account_contacts_prod` / `account_contacts_local`): stable link between person and account.
//   - Subcollection (`periods_prod` / `periods_local`): decoupled, unbounded history of employment periods.
// Follows existing patterns: dependency injection (db, FieldValue, suffix), ServiceError, resolveCaller,
// portfolio visibility verification, and atomic Firestore transactions.

const crypto = require('crypto');
const {
  authorizeClientAccess,
  resolveCanonicalAccount
} = require('./clientsService');

class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const CRM_ROLES = ['manager', 'gestor', 'vendedor'];
const PRIVILEGED = ['manager', 'gestor'];
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function namesFor(suffix) {
  return {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    users: `users${suffix}`,
    contacts: `contacts${suffix}`,
    accountContacts: `account_contacts${suffix}`,
    periods: `periods${suffix}`,
    opportunityContacts: `opportunity_contacts${suffix}`,
    audit: `commercialAudit${suffix}`,
    ops: `contactOps${suffix}`
  };
}

function reqString(val, name, max = 200) {
  if (val === undefined || val === null) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  const s = String(val).trim();
  if (!s) throw new ServiceError('invalid-argument', `${name} es obligatorio`);
  if (s.length > max) throw new ServiceError('invalid-argument', `${name} no puede superar los ${max} caracteres`);
  return s;
}

function reqDocId(val, name) {
  const s = reqString(val, name, 128);
  if (!DOC_ID_RE.test(s)) throw new ServiceError('invalid-argument', `${name} contiene caracteres inválidos`);
  return s;
}

function sanitizeStr(val, max = 500) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function sanitizeEmail(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim().toLowerCase();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 100) {
    throw new ServiceError('invalid-argument', 'El correo electrónico no tiene un formato válido');
  }
  return s;
}

function sanitizePhone(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (s.length > 50) {
    throw new ServiceError('invalid-argument', 'El teléfono no puede superar los 50 caracteres');
  }
  return s;
}

function createContactsService({
  db,
  FieldValue,
  suffix,
  now = () => new Date(),
  newContactId = () => 'CT_' + db.collection(namesFor(suffix).contacts).doc().id
}) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  const names = namesFor(suffix);
  const col = n => db.collection(names[n]);

  // ---------- caller ----------
  async function resolveCaller(context) {
    if (!context || !context.auth || !context.auth.uid) throw new ServiceError('unauthenticated', 'Authentication required');
    const uid = context.auth.uid;
    const token = context.auth.token || {};
    let profile = null;
    if (token.cid) {
      const snap = await col('users').doc(String(token.cid)).get();
      if (snap.exists) profile = { ...snap.data(), docId: snap.id || (snap.data() && snap.data().id) };
    } else {
      const q = await col('users').where('authUid', '==', uid).limit(2).get();
      if (q.size === 1) profile = { ...q.docs[0].data(), docId: q.docs[0].id };
    }
    const deny = () => new ServiceError('permission-denied', 'Se requiere un usuario activo del CRM vinculado a esta sesión');
    if (!profile || profile.authUid !== uid || profile.activo !== true || !CRM_ROLES.includes(profile.role)) throw deny();
    if (profile.role === 'manager' && token.manager !== true) throw deny();
    return { uid, cid: profile.docId, role: profile.role, name: profile.nombre || '' };
  }

  // ---------- portfolio authorization ----------
  async function assertAccountVisible(caller, accountId, tx = null) {
    reqDocId(accountId, 'accountId');
    const resolved = await resolveCanonicalAccount(col('clients'), accountId, {
      suffix,
      tx,
      notFoundMessage: 'La cuenta especificada no existe'
    });
    const accountRef = col('clients').doc(resolved.canonicalId);
    const account = resolved.canonicalData;

    if (authorizeClientAccess(caller, account)) {
      return { ref: accountRef, account, resolved };
    }

    // Fallback when account is unmerged and visibleTo has not yet been recomputed from opportunities
    if (!resolved.isMerged && caller && caller.role === 'vendedor' && caller.cid) {
      const oppsQuery = col('prospects')
        .where('clientId', '==', resolved.canonicalId)
        .where('vendedorId', '==', caller.cid);
      const oppsSnap = await oppsQuery.get();
      const hasOpp = oppsSnap.docs.some(d => d.data() && d.data().eliminado !== true);
      if (hasOpp) return { ref: accountRef, account, resolved };
    }

    throw new ServiceError('permission-denied', 'No tiene permisos para acceder a esta cuenta');
  }

  function addAudit(tx, caller, action, targetId, details) {
    const ref = col('audit').doc();
    const entry = {
      id: ref.id,
      action,
      targetId,
      details: details || {},
      userId: caller.cid,
      userName: caller.name,
      userRole: caller.role,
      userUid: caller.uid,
      timestamp: now().toISOString()
    };
    tx.set(ref, entry);
  }

  // =====================================================================================================
  // 1. Person Identity (`contacts_${suffix}`)
  // =====================================================================================================

  async function createContact({ caller, contact = {}, opId }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const nombres = reqString(contact.nombres, 'Los nombres', 100);
    const apellidos = reqString(contact.apellidos, 'Los apellidos', 100);
    const telefono = sanitizePhone(contact.telefono);
    const correo = sanitizeEmail(contact.correo);

    const id = newContactId();
    const at = now().toISOString();
    const docData = {
      id,
      nombres,
      apellidos,
      telefono: telefono || null,
      correo: correo || null,
      fecha_creacion: at,
      createdBy: caller.cid,
      createdByName: caller.name,
      fecha_actualizacion: at,
      updatedBy: caller.cid,
      updatedByName: caller.name
    };

    const docRef = col('contacts').doc(id);
    await db.runTransaction(async tx => {
      tx.create(docRef, docData);
      addAudit(tx, caller, 'createContact', id, { nombres, apellidos, correo });
    });

    return { status: 'created', contact: docData };
  }

  async function updateContact({ caller, contactId, contact = {} }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const cId = reqDocId(contactId, 'contactId');
    const docRef = col('contacts').doc(cId);
    const authFilter = await getAuthorizedContactIds(caller);

    return db.runTransaction(async tx => {
      const snap = await tx.get(docRef);
      if (!snap.exists) throw new ServiceError('not-found', 'La persona especificada no existe');
      const cur = snap.data() || {};

      if (authFilter !== null && !authFilter.isAuthorized(cur)) {
        throw new ServiceError('permission-denied', 'No tiene permisos para modificar los datos de esta persona');
      }

      const at = now().toISOString();
      const patch = {
        fecha_actualizacion: at,
        updatedBy: caller.cid,
        updatedByName: caller.name
      };

      if (contact.nombres !== undefined) patch.nombres = reqString(contact.nombres, 'Los nombres', 100);
      if (contact.apellidos !== undefined) patch.apellidos = reqString(contact.apellidos, 'Los apellidos', 100);
      if (contact.telefono !== undefined) patch.telefono = sanitizePhone(contact.telefono) || null;
      if (contact.correo !== undefined) patch.correo = sanitizeEmail(contact.correo) || null;

      tx.update(docRef, patch);
      addAudit(tx, caller, 'updateContact', cId, { previous: cur, updated: patch });

      return { status: 'updated', contact: { ...cur, ...patch } };
    });
  }

  // ---------- portfolio ids for contacts ----------
  async function getAuthorizedContactIds(caller) {
    if (PRIVILEGED.includes(caller.role)) return null;

    const authorizedAccountIds = new Set();
    const [createdClients, visibleClients, assignedClients] = await Promise.all([
      col('clients').where('createdBy', '==', caller.cid).get(),
      col('clients').where('visibleTo', 'array-contains', caller.cid).get(),
      col('clients').where('vendedor_asignado', '==', caller.cid).get()
    ]);

    createdClients.docs.forEach(d => authorizedAccountIds.add(d.id));
    visibleClients.docs.forEach(d => authorizedAccountIds.add(d.id));
    assignedClients.docs.forEach(d => authorizedAccountIds.add(d.id));

    const oppsSnap = await col('prospects').where('vendedorId', '==', caller.cid).get();
    oppsSnap.docs.forEach(d => {
      const data = d.data() || {};
      if (data.eliminado !== true && data.clientId) {
        authorizedAccountIds.add(data.clientId);
      }
    });

    const authorizedContactIds = new Set();
    const accountIds = Array.from(authorizedAccountIds);
    await Promise.all(accountIds.map(async aId => {
      const relsSnap = await col('accountContacts').where('accountId', '==', aId).get();
      relsSnap.docs.forEach(d => {
        const data = d.data() || {};
        if (data.contactId) authorizedContactIds.add(data.contactId);
      });
    }));

    // Privileged creators (managers, gestores, sistema) whose contacts belong to corporate directory
    const privilegedUserIds = new Set(['sistema']);
    const [managersSnap, gestoresSnap] = await Promise.all([
      col('users').where('role', '==', 'manager').get(),
      col('users').where('role', '==', 'gestor').get()
    ]);
    managersSnap.docs.forEach(d => privilegedUserIds.add(d.id));
    gestoresSnap.docs.forEach(d => privilegedUserIds.add(d.id));

    return {
      authorizedAccountIds,
      authorizedContactIds,
      privilegedUserIds,
      isAuthorized: (contact) => {
        if (!contact) return false;
        if (contact.createdBy === caller.cid) return true;
        if (authorizedContactIds.has(contact.id)) return true;
        if (contact.createdBy && privilegedUserIds.has(contact.createdBy)) return true;
        return false;
      }
    };
  }

  async function getContact({ caller, contactId, includeDossier = false }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const cId = reqDocId(contactId, 'contactId');
    const snap = await col('contacts').doc(cId).get();
    if (!snap.exists) throw new ServiceError('not-found', 'La persona especificada no existe');
    const contact = { id: snap.id, ...snap.data() };

    const authFilter = await getAuthorizedContactIds(caller);
    if (authFilter !== null && !authFilter.isAuthorized(contact)) {
      throw new ServiceError('permission-denied', 'No tiene permisos para consultar los datos de esta persona');
    }

    if (!includeDossier) {
      return {
        contact: {
          id: contact.id,
          nombres: contact.nombres || '',
          apellidos: contact.apellidos || '',
          nombre_completo: `${contact.nombres || ''} ${contact.apellidos || ''}`.trim(),
          correo: contact.correo || null,
          telefono: contact.telefono || null
        }
      };
    }

    const personalDataRestricted = Boolean(
      authFilter !== null &&
      contact.createdBy &&
      contact.createdBy !== caller.cid &&
      !authFilter.privilegedUserIds.has(contact.createdBy)
    );

    // 1. Authorized Account Relations & Periods
    const relsSnap = await col('accountContacts').where('contactId', '==', cId).get();
    const rawRels = relsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r && r.eliminado !== true && (authFilter === null || authFilter.authorizedAccountIds.has(r.accountId)));

    const accountMap = new Map();
    await Promise.all(Array.from(new Set(rawRels.map(r => r.accountId).filter(Boolean))).map(async aId => {
      const aSnap = await col('clients').doc(aId).get();
      if (aSnap.exists) accountMap.set(aId, { id: aSnap.id, ...aSnap.data() });
    }));

    const allPeriods = [];
    const accountRelations = await Promise.all(rawRels.map(async r => {
      const acc = accountMap.get(r.accountId) || {};
      const accountName = acc.tipo === 'natural'
        ? `${acc.nombres || ''} ${acc.apellidos || ''}`.trim()
        : (acc.empresa || r.accountId);
      const pSnap = await col('accountContacts').doc(r.id).collection(names.periods).get();
      const relPeriods = pSnap.docs.map(pd => ({
        id: pd.id,
        ...pd.data(),
        accountId: r.accountId,
        accountName
      }));
      relPeriods.sort((a, b) => String(b.fecha_inicio || '').localeCompare(String(a.fecha_inicio || '')));
      allPeriods.push(...relPeriods);
      return {
        ...r,
        accountName,
        accountType: acc.tipo || 'juridica',
        periodsCount: relPeriods.length
      };
    }));

    accountRelations.sort((a, b) => {
      if (a.activo !== b.activo) return a.activo ? -1 : 1;
      return String(b.fecha_ultimo_cambio || '').localeCompare(String(a.fecha_ultimo_cambio || ''));
    });
    allPeriods.sort((a, b) => String(b.fecha_inicio || '').localeCompare(String(a.fecha_inicio || '')));

    // 2. Authorized Opportunity Participations
    let opportunityParticipations = [];
    try {
      const oppLinksSnap = await col('opportunityContacts').where('contactId', '==', cId).get();
      const rawLinks = oppLinksSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(l => l && l.eliminado !== true && l.activo !== false);
      const oppIds = Array.from(new Set(rawLinks.map(l => l.opportunityId).filter(Boolean)));
      const oppMap = new Map();
      await Promise.all(oppIds.map(async oId => {
        const oSnap = await col('prospects').doc(oId).get();
        if (oSnap.exists) oppMap.set(oId, { id: oSnap.id, ...oSnap.data() });
      }));
      opportunityParticipations = rawLinks
        .filter(l => {
          const opp = oppMap.get(l.opportunityId);
          if (opp && opp.eliminado === true) return false;
          const accId = (opp && opp.clientId) || l.accountId || null;
          if (!opp && !accId) return false;
          if (authFilter === null) return true;
          return (opp && opp.vendedorId === caller.cid) || (accId && authFilter.authorizedAccountIds.has(accId));
        })
        .map(l => {
          const opp = oppMap.get(l.opportunityId) || {};
          return {
            id: l.id,
            opportunityId: l.opportunityId,
            accountId: l.accountId || opp.clientId || null,
            roleId: l.roleId || l.roleCode || null,
            roleCode: l.roleCode || l.roleId || null,
            roleLabel: l.roleLabel || l.roleName || l.rol || 'Participante',
            roleName: l.roleName || l.roleLabel || l.rol || 'Participante',
            isPrimary: Boolean(l.isPrimary || l.es_principal),
            proyecto: opp.proyecto || l.opportunityId,
            codigo: opp.codigo || opp.id || l.opportunityId,
            etapa: opp.etapa || 'prospecto',
            estado: opp.estado || 'activo',
            precio_cotizado: Number(opp.precio_cotizado || 0)
          };
        });
    } catch (_) {
      opportunityParticipations = [];
    }

    return {
      contact: {
        id: contact.id,
        nombres: contact.nombres || '',
        apellidos: contact.apellidos || '',
        nombre_completo: `${contact.nombres || ''} ${contact.apellidos || ''}`.trim(),
        correo: personalDataRestricted ? null : (contact.correo || null),
        telefono: personalDataRestricted ? null : (contact.telefono || null),
        dui: contact.dui || null,
        profesion: contact.profesion || null,
        domicilio: contact.domicilio || null,
        personalDataRestricted,
        accountRelations,
        periods: allPeriods,
        opportunityParticipations
      },
      dossier: {
        accountRelations,
        periods: allPeriods,
        opportunityParticipations,
        personalDataRestricted
      }
    };
  }

  async function searchContacts({ caller, q = '', limit = 20, excludeAccountId = null, includeRelations = false }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const authFilter = await getAuthorizedContactIds(caller);

    const term = String(q || '').trim().toLowerCase();
    const snap = await col('contacts').get();
    let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Apply portfolio filter before matching or returning
    if (authFilter !== null) {
      all = all.filter(c => authFilter.isAuthorized(c));
    }

    if (excludeAccountId) {
      const existingRels = await col('accountContacts')
        .where('accountId', '==', String(excludeAccountId))
        .where('activo', '==', true)
        .get();
      const excludedContactIds = new Set();
      existingRels.docs.forEach(d => {
        const data = d.data() || {};
        if (data.contactId && data.eliminado !== true) excludedContactIds.add(data.contactId);
      });
      all = all.filter(c => !excludedContactIds.has(c.id));
    }

    if (term) {
      all = all.filter(c => {
        const full = `${c.nombres || ''} ${c.apellidos || ''}`.toLowerCase();
        const email = (c.correo || '').toLowerCase();
        const phone = (c.telefono || '').replace(/\D/g, '');
        const cleanTerm = term.replace(/\D/g, '');
        return full.includes(term) || email.includes(term) || (cleanTerm && phone.includes(cleanTerm));
      });
    }

    if (!includeRelations) {
      const max = Math.min(Math.max(1, parseInt(limit, 10) || 20), 50);
      const sliced = all.slice(0, max).map(c => ({
        id: c.id,
        nombres: c.nombres || '',
        apellidos: c.apellidos || '',
        nombre_completo: `${c.nombres || ''} ${c.apellidos || ''}`.trim(),
        correo: c.correo || null,
        telefono: c.telefono || null
      }));
      return { results: sliced, contacts: sliced };
    }

    const max = Math.min(Math.max(1, parseInt(limit, 10) || 100), 200);
    const slicedRaw = all.slice(0, max);

    const [relsSnap, clientsSnap, oppLinksSnap, oppsSnap] = await Promise.all([
      col('accountContacts').get(),
      col('clients').get(),
      col('opportunityContacts').get().catch(() => ({ docs: [] })),
      col('prospects').get().catch(() => ({ docs: [] }))
    ]);

    const clientMap = new Map();
    clientsSnap.docs.forEach(d => clientMap.set(d.id, { id: d.id, ...d.data() }));

    const oppMap = new Map();
    oppsSnap.docs.forEach(d => oppMap.set(d.id, { id: d.id, ...d.data() }));

    const relsByContact = new Map();
    relsSnap.docs.forEach(d => {
      const r = { id: d.id, ...d.data() };
      if (!r.contactId || r.eliminado === true) return;
      if (authFilter !== null && !authFilter.authorizedAccountIds.has(r.accountId)) return;
      const acc = clientMap.get(r.accountId) || {};
      const accountName = acc.tipo === 'natural'
        ? `${acc.nombres || ''} ${acc.apellidos || ''}`.trim()
        : (acc.empresa || r.accountId);
      const list = relsByContact.get(r.contactId) || [];
      list.push({
        id: r.id,
        accountId: r.accountId,
        accountName,
        cargo: r.cargo || 'Contacto Comercial',
        activo: r.activo === true,
        telefono_corporativo: r.telefono_corporativo || null,
        correo_corporativo: r.correo_corporativo || null
      });
      relsByContact.set(r.contactId, list);
    });

    const oppsCountByContact = new Map();
    oppLinksSnap.docs.forEach(d => {
      const l = d.data() || {};
      if (!l.contactId || l.eliminado === true || l.activo === false) return;
      const opp = oppMap.get(l.opportunityId);
      if (opp && opp.eliminado === true) return;
      const accId = (opp && opp.clientId) || l.accountId || null;
      if (!opp && !accId) return;
      if (authFilter !== null && (!opp || opp.vendedorId !== caller.cid) && (!accId || !authFilter.authorizedAccountIds.has(accId))) return;
      oppsCountByContact.set(l.contactId, (oppsCountByContact.get(l.contactId) || 0) + 1);
    });

    const enriched = slicedRaw.map(c => {
      const personalDataRestricted = Boolean(
        authFilter !== null &&
        c.createdBy &&
        c.createdBy !== caller.cid &&
        !authFilter.privilegedUserIds.has(c.createdBy)
      );
      const accountRelations = relsByContact.get(c.id) || [];
      const activeCnt = accountRelations.filter(r => r.activo).length;
      const oppCnt = oppsCountByContact.get(c.id) || 0;
      return {
        id: c.id,
        nombres: c.nombres || '',
        apellidos: c.apellidos || '',
        nombre_completo: `${c.nombres || ''} ${c.apellidos || ''}`.trim(),
        correo: personalDataRestricted ? null : (c.correo || null),
        telefono: personalDataRestricted ? null : (c.telefono || null),
        dui: c.dui || null,
        personalDataRestricted,
        accountRelations,
        activeAccountCount: activeCnt,
        activeAccountsCount: activeCnt,
        totalAccountCount: accountRelations.length,
        opportunityCount: oppCnt,
        opportunitiesCount: oppCnt
      };
    });

    return { results: enriched, contacts: enriched };
  }

  // =====================================================================================================
  // 2. Relation Person-Account (`account_contacts_${suffix}`) & Periods (`periods_${suffix}`)
  // =====================================================================================================

  async function linkContactToAccount({
    caller,
    accountId,
    contactId,
    cargo,
    telefono_corporativo,
    extension,
    correo_corporativo
  }) {
    const aId = reqDocId(accountId, 'accountId');
    const cId = reqDocId(contactId, 'contactId');
    const sanitizedCargo = reqString(cargo, 'El cargo', 150);
    const telCorp = sanitizePhone(telefono_corporativo);
    const ext = sanitizeStr(extension, 20);
    const emailCorp = sanitizeEmail(correo_corporativo);

    const authFilter = await getAuthorizedContactIds(caller);

    const relationId = `AC_${aId}_${cId}`;
    const relationRef = col('accountContacts').doc(relationId);
    // Pre-generate document reference with auto ID for the new period
    const newPeriodRef = relationRef.collection(names.periods).doc();

    return db.runTransaction(async tx => {
      // 1. All reads must occur before any writes in Firestore transactions
      const { account } = await assertAccountVisible(caller, aId, tx);
      const personSnap = await tx.get(col('contacts').doc(cId));
      if (!personSnap.exists) throw new ServiceError('not-found', 'La persona especificada no existe');
      const person = personSnap.data() || {};

      if (authFilter !== null && !authFilter.isAuthorized(person)) {
        throw new ServiceError('permission-denied', 'No tiene permisos para vincular esta persona');
      }

      const relSnap = await tx.get(relationRef);
      const isExisting = relSnap.exists;
      const existing = isExisting ? (relSnap.data() || {}) : null;

      if (existing && existing.activo === true) {
        throw new ServiceError('failed-precondition', 'La persona ya posee una relación activa con esta cuenta');
      }

      // If existing and had an active period (should not happen if activo===false, but check defensively)
      let oldPeriodSnap = null;
      if (existing && existing.periodo_actual_id) {
        const oldPeriodRef = relationRef.collection(names.periods).doc(existing.periodo_actual_id);
        oldPeriodSnap = await tx.get(oldPeriodRef);
      }

      // 2. Writes
      const at = now().toISOString();

      if (oldPeriodSnap && oldPeriodSnap.exists && oldPeriodSnap.data().fecha_fin === null) {
        const oldPeriodRef = relationRef.collection(names.periods).doc(existing.periodo_actual_id);
        tx.update(oldPeriodRef, { fecha_fin: at, motivo_salida: 'Cierre automático previo a nuevo período' });
      }

      const periodData = {
        id: newPeriodRef.id,
        accountContactId: relationId,
        accountId: aId,
        contactId: cId,
        cargo: sanitizedCargo,
        fecha_inicio: at,
        fecha_fin: null,
        motivo_salida: null,
        motivo_reingreso: isExisting ? 'Reingreso' : null,
        createdBy: caller.cid,
        createdByName: caller.name,
        createdAt: at
      };

      const nextTotalPeriods = isExisting ? ((existing.total_periodos || 0) + 1) : 1;
      const relationData = {
        id: relationId,
        accountId: aId,
        contactId: cId,
        cargo: sanitizedCargo,
        telefono_corporativo: telCorp || null,
        extension: ext || null,
        correo_corporativo: emailCorp || null,
        activo: true,
        periodo_actual_id: newPeriodRef.id,
        total_periodos: nextTotalPeriods,
        fecha_vinculacion_inicial: isExisting ? (existing.fecha_vinculacion_inicial || at) : at,
        fecha_ultimo_cambio: at,
        createdBy: isExisting ? existing.createdBy : caller.cid,
        createdByName: isExisting ? existing.createdByName : caller.name,
        createdAt: isExisting ? existing.createdAt : at,
        updatedBy: caller.cid,
        updatedByName: caller.name,
        updatedAt: at
      };

      tx.set(newPeriodRef, periodData);
      tx.set(relationRef, relationData, { merge: true });

      addAudit(tx, caller, isExisting ? 'reactivateAccountContact' : 'linkContactToAccount', relationId, {
        accountId: aId,
        contactId: cId,
        periodId: newPeriodRef.id,
        cargo: sanitizedCargo
      });

      return {
        status: isExisting ? 'reactivated' : 'linked',
        accountContact: relationData,
        period: periodData,
        persona: {
          id: cId,
          nombres: person.nombres,
          apellidos: person.apellidos,
          nombre_completo: `${person.nombres} ${person.apellidos}`.trim()
        }
      };
    });
  }

  async function updateAccountContact({
    caller,
    accountContactId,
    cargo,
    telefono_corporativo,
    extension,
    correo_corporativo
  }) {
    const relId = reqDocId(accountContactId, 'accountContactId');
    const relationRef = col('accountContacts').doc(relId);
    const newCargo = cargo !== undefined ? reqString(cargo, 'El cargo', 150) : undefined;
    const telCorp = telefono_corporativo !== undefined ? sanitizePhone(telefono_corporativo) : undefined;
    const ext = extension !== undefined ? sanitizeStr(extension, 20) : undefined;
    const emailCorp = correo_corporativo !== undefined ? sanitizeEmail(correo_corporativo) : undefined;

    return db.runTransaction(async tx => {
      // 1. Reads
      const relSnap = await tx.get(relationRef);
      if (!relSnap.exists) throw new ServiceError('not-found', 'La relación especificada no existe');
      const relData = relSnap.data() || {};
      await assertAccountVisible(caller, relData.accountId, tx);

      if (relData.activo !== true) {
        throw new ServiceError('failed-precondition', 'No se puede editar una relación inactiva. Reactívela primero');
      }

      let activePeriodRef = null;
      let activePeriodSnap = null;
      if (newCargo && newCargo !== relData.cargo && relData.periodo_actual_id) {
        activePeriodRef = relationRef.collection(names.periods).doc(relData.periodo_actual_id);
        activePeriodSnap = await tx.get(activePeriodRef);
      }

      // 2. Writes
      const at = now().toISOString();
      const patch = {
        updatedBy: caller.cid,
        updatedByName: caller.name,
        updatedAt: at
      };
      if (newCargo !== undefined) {
        patch.cargo = newCargo;
        patch.fecha_ultimo_cambio = at;
      }
      if (telCorp !== undefined) patch.telefono_corporativo = telCorp || null;
      if (ext !== undefined) patch.extension = ext || null;
      if (emailCorp !== undefined) patch.correo_corporativo = emailCorp || null;

      if (activePeriodRef && activePeriodSnap && activePeriodSnap.exists) {
        tx.update(activePeriodRef, { cargo: newCargo, updatedAt: at });
      }
      tx.update(relationRef, patch);

      addAudit(tx, caller, 'updateAccountContact', relId, {
        accountId: relData.accountId,
        contactId: relData.contactId,
        changes: patch
      });

      return {
        status: 'updated',
        accountContact: { ...relData, ...patch }
      };
    });
  }

  async function deactivateAccountContact({ caller, accountContactId, motivo_salida }) {
    const relId = reqDocId(accountContactId, 'accountContactId');
    const relationRef = col('accountContacts').doc(relId);
    const reason = sanitizeStr(motivo_salida, 300) || 'Baja laboral';

    return db.runTransaction(async tx => {
      // 1. Reads
      const relSnap = await tx.get(relationRef);
      if (!relSnap.exists) throw new ServiceError('not-found', 'La relación especificada no existe');
      const relData = relSnap.data() || {};
      await assertAccountVisible(caller, relData.accountId, tx);

      if (relData.activo === false) {
        return { status: 'unchanged', accountContact: relData };
      }

      let activePeriodRef = null;
      let activePeriodSnap = null;
      if (relData.periodo_actual_id) {
        activePeriodRef = relationRef.collection(names.periods).doc(relData.periodo_actual_id);
        activePeriodSnap = await tx.get(activePeriodRef);
      }

      // 2. Writes
      const at = now().toISOString();
      if (activePeriodRef && activePeriodSnap && activePeriodSnap.exists) {
        tx.update(activePeriodRef, {
          fecha_fin: at,
          motivo_salida: reason,
          updatedAt: at,
          updatedBy: caller.cid
        });
      }

      const patch = {
        activo: false,
        periodo_actual_id: null,
        fecha_ultimo_cambio: at,
        updatedBy: caller.cid,
        updatedByName: caller.name,
        updatedAt: at
      };
      tx.update(relationRef, patch);

      addAudit(tx, caller, 'deactivateAccountContact', relId, {
        accountId: relData.accountId,
        contactId: relData.contactId,
        periodId: relData.periodo_actual_id,
        motivo_salida: reason
      });

      return {
        status: 'deactivated',
        accountContact: { ...relData, ...patch }
      };
    });
  }

  async function reactivateAccountContact({
    caller,
    accountContactId,
    cargo,
    motivo_reingreso,
    telefono_corporativo,
    extension,
    correo_corporativo
  }) {
    const relId = reqDocId(accountContactId, 'accountContactId');
    const relationRef = col('accountContacts').doc(relId);
    const newCargo = reqString(cargo, 'El cargo', 150);
    const reason = sanitizeStr(motivo_reingreso, 300) || 'Reingreso';
    const telCorp = sanitizePhone(telefono_corporativo);
    const ext = sanitizeStr(extension, 20);
    const emailCorp = sanitizeEmail(correo_corporativo);

    const newPeriodRef = relationRef.collection(names.periods).doc();

    return db.runTransaction(async tx => {
      // 1. Reads
      const relSnap = await tx.get(relationRef);
      if (!relSnap.exists) throw new ServiceError('not-found', 'La relación especificada no existe');
      const relData = relSnap.data() || {};
      await assertAccountVisible(caller, relData.accountId, tx);

      if (relData.activo === true) {
        throw new ServiceError('failed-precondition', 'La relación ya se encuentra activa');
      }

      const [accSnap, contSnap] = await Promise.all([
        tx.get(col('clients').doc(relData.accountId)),
        tx.get(col('contacts').doc(relData.contactId))
      ]);
      if (!accSnap.exists) throw new ServiceError('not-found', 'La cuenta asociada ya no existe');
      if (!contSnap.exists) throw new ServiceError('not-found', 'La persona asociada ya no existe');

      // 2. Writes
      const at = now().toISOString();
      const periodData = {
        id: newPeriodRef.id,
        accountContactId: relId,
        accountId: relData.accountId,
        contactId: relData.contactId,
        cargo: newCargo,
        fecha_inicio: at,
        fecha_fin: null,
        motivo_salida: null,
        motivo_reingreso: reason,
        createdBy: caller.cid,
        createdByName: caller.name,
        createdAt: at
      };

      const nextTotalPeriods = (relData.total_periodos || 0) + 1;
      const patch = {
        activo: true,
        cargo: newCargo,
        periodo_actual_id: newPeriodRef.id,
        total_periodos: nextTotalPeriods,
        fecha_ultimo_cambio: at,
        updatedBy: caller.cid,
        updatedByName: caller.name,
        updatedAt: at
      };
      if (telCorp !== undefined) patch.telefono_corporativo = telCorp || null;
      if (ext !== undefined) patch.extension = ext || null;
      if (emailCorp !== undefined) patch.correo_corporativo = emailCorp || null;

      tx.set(newPeriodRef, periodData);
      tx.update(relationRef, patch);

      addAudit(tx, caller, 'reactivateAccountContact', relId, {
        accountId: relData.accountId,
        contactId: relData.contactId,
        periodId: newPeriodRef.id,
        cargo: newCargo,
        motivo_reingreso: reason
      });

      return {
        status: 'reactivated',
        accountContact: { ...relData, ...patch },
        period: periodData
      };
    });
  }

  async function listAccountContacts({ caller, accountId, includeInactive = true }) {
    const aId = reqDocId(accountId, 'accountId');
    await assertAccountVisible(caller, aId);

    const q = col('accountContacts').where('accountId', '==', aId);
    const snap = await q.get();
    let relations = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!includeInactive) {
      relations = relations.filter(r => r.activo === true);
    }

    // Fetch person identity for each contact
    const personIds = Array.from(new Set(relations.map(r => r.contactId).filter(Boolean)));
    const personMap = new Map();
    await Promise.all(personIds.map(async pid => {
      const pSnap = await col('contacts').doc(pid).get();
      if (pSnap.exists) personMap.set(pid, pSnap.data());
    }));

    const contacts = relations.map(r => {
      const p = personMap.get(r.contactId) || {};
      const personData = {
        id: r.contactId,
        nombres: p.nombres || '',
        apellidos: p.apellidos || '',
        nombre_completo: `${p.nombres || ''} ${p.apellidos || ''}`.trim(),
        telefono: p.telefono || null,
        correo: p.correo || null,
        telefono_personal: p.telefono || null,
        correo_personal: p.correo || null
      };
      return {
        ...r,
        person: personData,
        persona: personData
      };
    });

    // Sort active first, then by fecha_ultimo_cambio descending
    contacts.sort((a, b) => {
      if (a.activo !== b.activo) return a.activo ? -1 : 1;
      return String(b.fecha_ultimo_cambio || '').localeCompare(String(a.fecha_ultimo_cambio || ''));
    });

    return { contacts };
  }

  async function listContactPeriods({ caller, accountContactId }) {
    const relId = reqDocId(accountContactId, 'accountContactId');
    const relationRef = col('accountContacts').doc(relId);
    const relSnap = await relationRef.get();
    if (!relSnap.exists) throw new ServiceError('not-found', 'La relación especificada no existe');
    const relData = relSnap.data() || {};
    await assertAccountVisible(caller, relData.accountId);

    const periodsSnap = await relationRef.collection(names.periods).get();
    const periods = periodsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Sort by fecha_inicio descending (most recent first)
    periods.sort((a, b) => String(b.fecha_inicio || '').localeCompare(String(a.fecha_inicio || '')));

    return {
      accountContactId: relId,
      accountId: relData.accountId,
      contactId: relData.contactId,
      periods
    };
  }

  return {
    names,
    resolveCaller,
    createContact,
    updateContact,
    getContact,
    searchContacts,
    linkContactToAccount,
    updateAccountContact,
    deactivateAccountContact,
    reactivateAccountContact,
    listAccountContacts,
    listContactPeriods
  };
}

module.exports = {
  createContactsService,
  ServiceError,
  namesFor,
  CRM_ROLES,
  PRIVILEGED
};
