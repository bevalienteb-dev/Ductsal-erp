// functions/opportunityContactsService.js
// Server-side logic for Opportunity Contacts & Roles (Phase 2, Block 2).
// Implements the relationship between opportunities (`prospects_prod`) and participants (`opportunity_contacts_prod`),
// along with the commercial role catalogue (`opportunity_contact_roles_prod`).
// Invariants enforced:
//   1. Account belonging: accountContact.accountId === prospect.clientId on every assignment.
//   2. Authoritative Single Source of Truth (SSOT) for Primary Contact in prospects_prod (primaryOpportunityContactId
//      and primaryContactSnapshot), with synchronized projection isPrimary in opportunity_contacts_prod.
//   3. Atomic transaction when changing/removing primary contact: never two primary contacts in an opportunity.
//   4. Historical immutability: contactSnapshot and roleName preserved across subsequent person or catalogue edits.
//   5. Change of account restricted strictly to stage 'prospecto' without active quotation, preserving historical
//      participants as inactive and clearing previous primary contact.
//   6. Logical deletion on prospect cascades to all subordinate participants (eliminado = true, estado_participacion = 'inactivo', isPrimary = false).

const crypto = require('crypto');

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

const INITIAL_ROLES = [
  { id: 'decisor', name: 'Decisor', activo: true, orden: 1 },
  { id: 'comprador_economico', name: 'Comprador Económico', activo: true, orden: 2 },
  { id: 'evaluador_tecnico', name: 'Evaluador Técnico', activo: true, orden: 3 },
  { id: 'influenciador', name: 'Influenciador', activo: true, orden: 4 },
  { id: 'usuario', name: 'Usuario', activo: true, orden: 5 },
  { id: 'patrocinador_ejecutivo', name: 'Patrocinador Ejecutivo', activo: true, orden: 6 },
  { id: 'compras', name: 'Compras', activo: true, orden: 7 },
  { id: 'otro', name: 'Otro', activo: true, orden: 8 }
];

function namesFor(suffix) {
  return {
    clients: `clients${suffix}`,
    prospects: `prospects${suffix}`,
    users: `users${suffix}`,
    contacts: `contacts${suffix}`,
    accountContacts: `account_contacts${suffix}`,
    periods: `periods${suffix}`,
    opportunityContacts: `opportunity_contacts${suffix}`,
    opportunityContactRoles: `opportunity_contact_roles${suffix}`,
    audit: `commercialAudit${suffix}`,
    ops: `opportunityContactOps${suffix}`
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

function optString(val, max = 500) {
  if (val === undefined || val === null) return '';
  const s = String(val).trim();
  return s.slice(0, max);
}

function createOpportunityContactsService({
  db,
  FieldValue,
  suffix,
  now = () => new Date(),
  verifyManager = async () => true
}) {
  if (suffix !== '_local' && suffix !== '_prod') throw new Error('Invalid suffix');
  const names = namesFor(suffix);
  const col = n => db.collection(names[n]);

  // ---------- caller resolution ----------
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

  // ---------- authorization helpers ----------
  function canAccessOpportunity(caller, p) {
    if (PRIVILEGED.includes(caller.role)) return true;
    if (caller.role === 'vendedor') {
      return p.vendedorId === caller.cid || (p.createdBy === caller.cid && (!p.vendedorId || p.vendedorId === caller.cid));
    }
    return false;
  }

  function requireOpportunityAccess(caller, p) {
    if (p && p.eliminado === true) throw new ServiceError('not-found', 'La oportunidad fue eliminada');
    if (!canAccessOpportunity(caller, p)) {
      throw new ServiceError('permission-denied', 'No tienes acceso a esta oportunidad');
    }
  }

  async function requireManager(caller, what) {
    if (caller.role !== 'manager') throw new ServiceError('permission-denied', `Solo un gerente puede ${what}`);
    const valid = await verifyManager(caller.uid);
    if (!valid) throw new ServiceError('permission-denied', `Solo un gerente puede ${what}`);
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
    return entry;
  }

  // =====================================================================================================
  // 1. Role Catalogue (`opportunity_contact_roles_${suffix}`)
  // =====================================================================================================

  async function seedOpportunityContactRoles({ caller, force = false }) {
    await requireManager(caller, 'inicializar el catálogo de roles');
    const at = now().toISOString();

    return db.runTransaction(async tx => {
      const snap = await tx.get(col('opportunityContactRoles').limit(1));
      if (!snap.empty && !force) {
        const existing = await tx.get(col('opportunityContactRoles'));
        return {
          status: 'already-seeded',
          message: 'El catálogo de roles ya contiene elementos',
          count: existing.size
        };
      }

      for (const r of INITIAL_ROLES) {
        tx.set(col('opportunityContactRoles').doc(r.id), {
          ...r,
          createdAt: at,
          updatedAt: at,
          createdBy: caller.cid
        }, { merge: true });
      }

      const auditEntry = addAudit(tx, caller, 'seedOpportunityContactRoles', names.opportunityContactRoles, {
        actor: {
          uid: caller.uid,
          cid: caller.cid,
          name: caller.name || '',
          role: caller.role
        },
        action: 'seedOpportunityContactRoles',
        entidad: names.opportunityContactRoles,
        fecha: at,
        entorno: suffix,
        rolesCount: INITIAL_ROLES.length,
        force: Boolean(force),
        resultado: 'seeded',
        roleIds: INITIAL_ROLES.map(r => r.id)
      });

      return {
        status: 'seeded',
        count: INITIAL_ROLES.length,
        auditId: auditEntry ? auditEntry.id : undefined
      };
    });
  }

  async function listOpportunityContactRoles({ caller, includeInactive = false }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');

    const snap = await col('opportunityContactRoles').get();
    let roles = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Non-managers cannot request inactive roles for assignments
    const canSeeInactive = PRIVILEGED.includes(caller.role) && includeInactive === true;
    if (!canSeeInactive) {
      roles = roles.filter(r => r.activo === true);
    }

    roles.sort((a, b) => (Number(a.orden) || 99) - (Number(b.orden) || 99));
    return { roles };
  }

  async function manageOpportunityContactRole({ caller, roleId, name, activo, orden, action = 'update' }) {
    await requireManager(caller, 'gestionar el catálogo de roles');
    await seedOpportunityContactRoles({ caller });

    const at = now().toISOString();

    if (action === 'create') {
      const roleName = reqString(name, 'El nombre del rol', 100);
      const generatedId = roleId ? reqDocId(roleId, 'roleId') : roleName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);
      const docRef = col('opportunityContactRoles').doc(generatedId);

      const existingSnap = await docRef.get();
      if (existingSnap.exists) throw new ServiceError('already-exists', 'El rol ya existe en el catálogo');

      const roleData = {
        id: generatedId,
        name: roleName,
        activo: activo !== false,
        orden: Number.isFinite(Number(orden)) ? Number(orden) : 99,
        createdAt: at,
        createdBy: caller.cid,
        updatedAt: at,
        updatedBy: caller.cid
      };

      await db.runTransaction(async tx => {
        tx.set(docRef, roleData);
        addAudit(tx, caller, 'createOpportunityContactRole', generatedId, { name: roleName, activo: roleData.activo });
      });

      return { status: 'created', role: roleData };
    }

    // Default: update
    const rId = reqDocId(roleId, 'roleId');
    const docRef = col('opportunityContactRoles').doc(rId);

    return db.runTransaction(async tx => {
      const snap = await tx.get(docRef);
      if (!snap.exists) throw new ServiceError('not-found', 'El rol especificado no existe en el catálogo');
      const current = snap.data() || {};

      const patch = {
        updatedAt: at,
        updatedBy: caller.cid
      };

      if (name !== undefined) patch.name = reqString(name, 'El nombre del rol', 100);
      if (activo !== undefined) patch.activo = Boolean(activo);
      if (orden !== undefined && Number.isFinite(Number(orden))) patch.orden = Number(orden);

      tx.update(docRef, patch);
      addAudit(tx, caller, 'updateOpportunityContactRole', rId, { previous: current, updated: patch });

      return { status: 'updated', role: { ...current, ...patch } };
    });
  }

  // =====================================================================================================
  // 2. Opportunity Participants (`opportunity_contacts_${suffix}`)
  // =====================================================================================================

  async function addOpportunityContact({
    caller,
    opportunityId,
    accountContactId,
    roleId,
    notes,
    isPrimary = false
  }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const oppId = reqDocId(opportunityId, 'opportunityId');
    const acId = reqDocId(accountContactId, 'accountContactId');
    const rId = reqDocId(roleId, 'roleId');
    const participantNotes = optString(notes, 500);

    const ocId = `OC_${oppId}_${acId}`;
    const ocRef = col('opportunityContacts').doc(ocId);
    const prospectRef = col('prospects').doc(oppId);
    const acRef = col('accountContacts').doc(acId);
    const roleRef = col('opportunityContactRoles').doc(rId);

    const at = now().toISOString();

    return db.runTransaction(async tx => {
      // 1. All reads must occur before any writes in Firestore transactions
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad especificada no existe');
      const p = prospectSnap.data() || {};
      requireOpportunityAccess(caller, p);

      if (p.eliminado === true) {
        throw new ServiceError('failed-precondition', 'No se pueden asignar participantes a una oportunidad eliminada');
      }

      const acSnap = await tx.get(acRef);
      if (!acSnap.exists) throw new ServiceError('not-found', 'La relación persona-cuenta especificada no existe');
      const accountContact = acSnap.data() || {};

      // Invariants:
      // a) Contact must belong to the opportunity's account
      if (accountContact.accountId !== p.clientId) {
        throw new ServiceError('failed-precondition', 'El contacto no pertenece a la cuenta de la oportunidad');
      }

      // b) Relation must be active in the account
      if (accountContact.activo !== true || accountContact.eliminado === true) {
        throw new ServiceError('failed-precondition', 'El contacto no posee una relación activa con la cuenta');
      }

      // c) Role must exist and be active
      const roleSnap = await tx.get(roleRef);
      if (!roleSnap.exists) throw new ServiceError('not-found', 'El rol especificado no existe');
      const role = roleSnap.data() || {};
      if (role.activo !== true) {
        throw new ServiceError('failed-precondition', 'El rol seleccionado no está activo para nuevas asignaciones');
      }

      // d) Check duplicate active participation in the opportunity
      const ocSnap = await tx.get(ocRef);
      if (ocSnap.exists) {
        const existing = ocSnap.data() || {};
        if (existing.eliminado !== true && existing.estado_participacion === 'activo') {
          throw new ServiceError('failed-precondition', 'El contacto ya participa activamente en esta oportunidad');
        }
      }

      // e) Read person details for snapshot
      const contactId = accountContact.contactId;
      const personSnap = await tx.get(col('contacts').doc(contactId));
      if (!personSnap.exists) throw new ServiceError('not-found', 'No se encontró la ficha de persona del contacto');
      const person = personSnap.data() || {};

      const contactSnapshot = {
        contactId,
        nombre: `${person.nombres || ''} ${person.apellidos || ''}`.trim(),
        cargo: accountContact.cargo || '',
        correo: accountContact.correo_corporativo || person.correo || null,
        telefono: accountContact.telefono_corporativo || person.telefono || null,
        extension: accountContact.extension || null
      };

      // f) If designated as primary, read existing primary participant if any
      let prevPrimaryRef = null;
      let prevPrimaryData = null;
      const willBePrimary = Boolean(isPrimary);
      if (willBePrimary && p.primaryOpportunityContactId && p.primaryOpportunityContactId !== ocId) {
        prevPrimaryRef = col('opportunityContacts').doc(p.primaryOpportunityContactId);
        const prevSnap = await tx.get(prevPrimaryRef);
        if (prevSnap.exists) prevPrimaryData = prevSnap.data() || {};
      }

      // 2. Writes
      if (willBePrimary && prevPrimaryRef && prevPrimaryData) {
        tx.update(prevPrimaryRef, {
          isPrimary: false,
          updatedAt: at,
          updatedBy: caller.cid,
          updatedByName: caller.name || ''
        });
      }

      const participantDoc = {
        id: ocId,
        opportunityId: oppId,
        accountId: p.clientId,
        accountContactId: acId,
        roleId: rId,
        roleName: role.name || rId,
        isPrimary: willBePrimary,
        estado_participacion: 'activo',
        contactSnapshot,
        notes: participantNotes,
        eliminado: false,
        createdBy: caller.cid,
        createdByName: caller.name || '',
        createdAt: at,
        updatedBy: caller.cid,
        updatedByName: caller.name || '',
        updatedAt: at
      };

      tx.set(ocRef, participantDoc, { merge: true });

      if (willBePrimary) {
        const nextVersion = (Number(p._version) || 0) + 1;
        tx.update(prospectRef, {
          primaryOpportunityContactId: ocId,
          primaryContactSnapshot: contactSnapshot,
          _version: nextVersion,
          updatedAt: at,
          updatedBy: caller.cid
        });
      }

      addAudit(tx, caller, 'addOpportunityContact', ocId, {
        opportunityId: oppId,
        accountId: p.clientId,
        accountContactId: acId,
        roleId: rId,
        roleName: role.name || rId,
        isPrimary: willBePrimary
      });

      return { status: 'created', participant: participantDoc };
    });
  }

  async function updateOpportunityContactRole({ caller, opportunityContactId, roleId, notes }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const ocId = reqDocId(opportunityContactId, 'opportunityContactId');
    const ocRef = col('opportunityContacts').doc(ocId);
    const at = now().toISOString();

    return db.runTransaction(async tx => {
      const ocSnap = await tx.get(ocRef);
      if (!ocSnap.exists) throw new ServiceError('not-found', 'El participante especificado no existe');
      const oc = ocSnap.data() || {};
      if (oc.eliminado === true || oc.estado_participacion !== 'activo') {
        throw new ServiceError('failed-precondition', 'El participante no está activo en la oportunidad');
      }

      const prospectRef = col('prospects').doc(oc.opportunityId);
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad asociada no existe');
      const p = prospectSnap.data() || {};
      requireOpportunityAccess(caller, p);

      if (p.eliminado === true) {
        throw new ServiceError('failed-precondition', 'La oportunidad asociada está eliminada');
      }

      const patch = {
        updatedAt: at,
        updatedBy: caller.cid,
        updatedByName: caller.name || ''
      };

      if (roleId !== undefined) {
        const rId = reqDocId(roleId, 'roleId');
        const roleSnap = await tx.get(col('opportunityContactRoles').doc(rId));
        if (!roleSnap.exists) throw new ServiceError('not-found', 'El rol especificado no existe');
        const role = roleSnap.data() || {};
        if (role.activo !== true) {
          throw new ServiceError('failed-precondition', 'El rol seleccionado no está activo');
        }
        patch.roleId = rId;
        patch.roleName = role.name || rId;
      }

      if (notes !== undefined) {
        patch.notes = optString(notes, 500);
      }

      tx.update(ocRef, patch);
      addAudit(tx, caller, 'updateOpportunityContactRole', ocId, { previous: oc, updated: patch });

      return { status: 'updated', participant: { ...oc, ...patch } };
    });
  }

  async function setOpportunityPrimaryContact({ caller, opportunityId, opportunityContactId, expectedVersion }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const oppId = reqDocId(opportunityId, 'opportunityId');
    const ocId = reqDocId(opportunityContactId, 'opportunityContactId');
    const prospectRef = col('prospects').doc(oppId);
    const targetOcRef = col('opportunityContacts').doc(ocId);
    const at = now().toISOString();

    return db.runTransaction(async tx => {
      // 1. Read prospect
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad especificada no existe');
      const p = prospectSnap.data() || {};
      requireOpportunityAccess(caller, p);

      if (p.eliminado === true) {
        throw new ServiceError('failed-precondition', 'No se puede designar contacto principal en una oportunidad eliminada');
      }

      // OCC validation if client supplied expectedVersion
      if (expectedVersion !== undefined && p._version !== undefined && Number(p._version) !== Number(expectedVersion)) {
        throw new ServiceError('failed-precondition', 'Conflicto de concurrencia al designar contacto principal');
      }

      // 2. Read target participant
      const targetSnap = await tx.get(targetOcRef);
      if (!targetSnap.exists) throw new ServiceError('not-found', 'El participante especificado no existe');
      const targetOc = targetSnap.data() || {};

      if (targetOc.opportunityId !== oppId) {
        throw new ServiceError('failed-precondition', 'El participante no pertenece a esta oportunidad');
      }
      if (targetOc.eliminado === true || targetOc.estado_participacion !== 'activo') {
        throw new ServiceError('failed-precondition', 'El participante no está activo en la oportunidad');
      }

      // Already primary
      if (p.primaryOpportunityContactId === ocId && targetOc.isPrimary === true) {
        return { status: 'unchanged', primaryOpportunityContactId: ocId };
      }

      // 3. Read any existing participants currently marked as primary (all reads before writes)
      const currentPrimariesSnap = await tx.get(
        col('opportunityContacts').where('opportunityId', '==', oppId).where('isPrimary', '==', true)
      );

      let prevPrimaryRef = null;
      let prevPrimaryData = null;
      if (p.primaryOpportunityContactId && p.primaryOpportunityContactId !== ocId) {
        prevPrimaryRef = col('opportunityContacts').doc(p.primaryOpportunityContactId);
        const prevSnap = await tx.get(prevPrimaryRef);
        if (prevSnap.exists) prevPrimaryData = prevSnap.data() || {};
      }

      // 4. Writes: ensure all other primaries are demoted and target is promoted
      const demotedIds = new Set();
      currentPrimariesSnap.docs.forEach(d => {
        if (d.id !== ocId) {
          demotedIds.add(d.id);
          tx.update(col('opportunityContacts').doc(d.id), {
            isPrimary: false,
            updatedAt: at,
            updatedBy: caller.cid,
            updatedByName: caller.name || ''
          });
        }
      });

      if (prevPrimaryRef && prevPrimaryData && prevPrimaryData.isPrimary === true && !demotedIds.has(p.primaryOpportunityContactId)) {
        tx.update(prevPrimaryRef, {
          isPrimary: false,
          updatedAt: at,
          updatedBy: caller.cid,
          updatedByName: caller.name || ''
        });
      }

      tx.update(targetOcRef, {
        isPrimary: true,
        updatedAt: at,
        updatedBy: caller.cid,
        updatedByName: caller.name || ''
      });

      const nextVersion = (Number(p._version) || 0) + 1;
      tx.update(prospectRef, {
        primaryOpportunityContactId: ocId,
        primaryContactSnapshot: targetOc.contactSnapshot || null,
        _version: nextVersion,
        updatedAt: at,
        updatedBy: caller.cid
      });

      addAudit(tx, caller, 'setOpportunityPrimaryContact', ocId, {
        opportunityId: oppId,
        previousPrimaryId: p.primaryOpportunityContactId || null,
        newPrimaryId: ocId
      });

      return { status: 'updated', primaryOpportunityContactId: ocId, version: nextVersion };
    });
  }

  async function removeOpportunityContact({ caller, opportunityContactId, motivo }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const ocId = reqDocId(opportunityContactId, 'opportunityContactId');
    const ocRef = col('opportunityContacts').doc(ocId);
    const at = now().toISOString();

    return db.runTransaction(async tx => {
      const ocSnap = await tx.get(ocRef);
      if (!ocSnap.exists) throw new ServiceError('not-found', 'El participante especificado no existe');
      const oc = ocSnap.data() || {};

      const prospectRef = col('prospects').doc(oc.opportunityId);
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad asociada no existe');
      const p = prospectSnap.data() || {};
      requireOpportunityAccess(caller, p);

      if (p.eliminado === true) {
        throw new ServiceError('failed-precondition', 'La oportunidad asociada está eliminada');
      }

      if (oc.estado_participacion === 'inactivo' && oc.isPrimary === false) {
        return { status: 'unchanged', opportunityContactId: ocId };
      }

      const isCurrentPrimary = (p.primaryOpportunityContactId === ocId);

      // Writes:
      tx.update(ocRef, {
        estado_participacion: 'inactivo',
        isPrimary: false,
        motivo_retiro: optString(motivo, 300) || null,
        updatedAt: at,
        updatedBy: caller.cid,
        updatedByName: caller.name || ''
      });

      if (isCurrentPrimary) {
        const nextVersion = (Number(p._version) || 0) + 1;
        tx.update(prospectRef, {
          primaryOpportunityContactId: null,
          primaryContactSnapshot: null,
          _version: nextVersion,
          updatedAt: at,
          updatedBy: caller.cid
        });
      }

      addAudit(tx, caller, 'removeOpportunityContact', ocId, {
        opportunityId: oc.opportunityId,
        wasPrimary: isCurrentPrimary,
        motivo: motivo || null
      });

      return { status: 'deactivated', opportunityContactId: ocId, clearedPrimary: isCurrentPrimary };
    });
  }

  async function listOpportunityContacts({ caller, opportunityId, includeInactive = false }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const oppId = reqDocId(opportunityId, 'opportunityId');

    const prospectSnap = await col('prospects').doc(oppId).get();
    if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad especificada no existe');
    const p = prospectSnap.data() || {};
    requireOpportunityAccess(caller, p);

    const snap = await col('opportunityContacts').where('opportunityId', '==', oppId).get();
    let contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Exclude logically eliminated records from active queries
    contacts = contacts.filter(c => c.eliminado !== true);

    if (includeInactive !== true) {
      contacts = contacts.filter(c => c.estado_participacion === 'activo');
    }

    // Sort: primary first, then by creation date
    contacts.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    return { contacts, primaryOpportunityContactId: p.primaryOpportunityContactId || null };
  }

  // =====================================================================================================
  // 3. Opportunity Account Change (`changeOpportunityAccountAdmin`)
  // =====================================================================================================

  async function changeOpportunityAccount({ caller, opportunityId, newAccountId, motivo }) {
    if (!CRM_ROLES.includes(caller.role)) throw new ServiceError('permission-denied', 'Permiso denegado');
    const oppId = reqDocId(opportunityId, 'opportunityId');
    const newAccId = reqDocId(newAccountId, 'newAccountId');
    const reason = reqString(motivo || 'Cambio de cuenta comercial', 'El motivo del cambio de cuenta', 300);

    const prospectRef = col('prospects').doc(oppId);
    const newAccountRef = col('clients').doc(newAccId);
    const at = now().toISOString();

    return db.runTransaction(async tx => {
      // 1. Read prospect
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) throw new ServiceError('not-found', 'La oportunidad especificada no existe');
      const p = prospectSnap.data() || {};
      requireOpportunityAccess(caller, p);

      // Invariants:
      // a) Allowed ONLY in initial stage 'prospecto' and active state
      if (p.eliminado === true || p.estado !== 'activo' || p.etapa !== 'prospecto') {
        throw new ServiceError('failed-precondition', 'El cambio de cuenta solo está permitido en la etapa inicial "prospecto" activa');
      }

      // b) Forbidden if active quotation exists across all ERP quotation sources
      const hasActiveQuote = (Array.isArray(p.cotizaciones) && p.cotizaciones.length > 0)
        || (p.datos && Array.isArray(p.datos.doc_oferta) && p.datos.doc_oferta.length > 0)
        || (Array.isArray(p.doc_oferta) && p.doc_oferta.length > 0)
        || (p.datos && Array.isArray(p.datos.doc_costos) && p.datos.doc_costos.length > 0)
        || (Array.isArray(p.doc_costos) && p.doc_costos.length > 0)
        || (p.precio_cotizado && Number(p.precio_cotizado) > 0)
        || (p.costo_venta && Number(p.costo_venta) > 0)
        || Boolean(p.activeQuoteId)
        || Boolean(p.cotizacion)
        || (p.datos && (Boolean(p.datos.cotizacion) || Boolean(p.datos.doc_cotizacion) || (Array.isArray(p.datos.cotizaciones) && p.datos.cotizaciones.length > 0)));

      if (hasActiveQuote) {
        throw new ServiceError('failed-precondition', 'No se puede cambiar la cuenta si existe una cotización activa');
      }

      // c) Read new account
      const newAccSnap = await tx.get(newAccountRef);
      if (!newAccSnap.exists) throw new ServiceError('not-found', 'La nueva cuenta especificada no existe');
      const newAccount = newAccSnap.data() || {};

      // Check seller access to new account
      if (!PRIVILEGED.includes(caller.role)) {
        const visibleTo = Array.isArray(newAccount.visibleTo) ? newAccount.visibleTo : [];
        const hasAccess = newAccount.createdBy === caller.cid || visibleTo.includes(caller.cid) || newAccount.vendedor_asignado === caller.cid;
        if (!hasAccess) {
          throw new ServiceError('permission-denied', 'No tiene permisos para transferir la oportunidad a esta cuenta');
        }
      }

      if (p.clientId === newAccId) {
        return { status: 'unchanged', opportunityId: oppId, clientId: newAccId };
      }

      // 2. Read existing participants of the previous account
      const participantsSnap = await tx.get(col('opportunityContacts').where('opportunityId', '==', oppId));

      // 3. Writes: Inactivate previous participants and clear primary contact
      participantsSnap.docs.forEach(d => {
        const oc = d.data() || {};
        if (oc.eliminado !== true && (oc.estado_participacion === 'activo' || oc.isPrimary === true)) {
          tx.update(col('opportunityContacts').doc(d.id), {
            estado_participacion: 'inactivo',
            isPrimary: false,
            motivo_desvinculacion: `Desvinculado por cambio de cuenta a ${newAccount.empresa || newAccId}`,
            updatedAt: at,
            updatedBy: caller.cid,
            updatedByName: caller.name || ''
          });
        }
      });

      const nextVersion = (Number(p._version) || 0) + 1;
      const logText = `(${caller.name || 'Sistema'}) Cuenta cambiada de "${p.clientId}" a "${newAccount.empresa || newAccId}". Participantes anteriores inactivados. Motivo: ${reason}`;
      const existingLogs = Array.isArray(p.logs) ? p.logs : [];
      const updatedLogs = existingLogs.concat([{ text: logText, date: at, by: caller.cid, byName: caller.name || '' }]);

      tx.update(prospectRef, {
        clientId: newAccId,
        primaryOpportunityContactId: null,
        primaryContactSnapshot: null,
        _version: nextVersion,
        logs: updatedLogs,
        updatedAt: at,
        updatedBy: caller.cid
      });

      // Synchronize visibility on new client for the vendor
      if (p.vendedorId && p.vendedorId !== 'sistema') {
        const currentVisible = Array.isArray(newAccount.visibleTo) ? newAccount.visibleTo : [];
        if (!currentVisible.includes(p.vendedorId)) {
          tx.update(newAccountRef, {
            visibleTo: FieldValue.arrayUnion(p.vendedorId)
          });
        }
      }

      addAudit(tx, caller, 'changeOpportunityAccount', oppId, {
        previousAccountId: p.clientId,
        newAccountId: newAccId,
        motivo: reason
      });

      return {
        status: 'updated',
        opportunityId: oppId,
        previousAccountId: p.clientId,
        newAccountId: newAccId,
        version: nextVersion
      };
    });
  }

  return {
    names,
    resolveCaller,
    seedOpportunityContactRoles,
    listOpportunityContactRoles,
    manageOpportunityContactRole,
    addOpportunityContact,
    updateOpportunityContactRole,
    setOpportunityPrimaryContact,
    removeOpportunityContact,
    listOpportunityContacts,
    changeOpportunityAccount
  };
}

module.exports = {
  createOpportunityContactsService,
  ServiceError,
  INITIAL_ROLES,
  CRM_ROLES,
  PRIVILEGED,
  namesFor
};
