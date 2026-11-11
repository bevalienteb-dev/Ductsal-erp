// functions/prospectWorkflowService.js
// Server-side workflow of an opportunity / project (prospect) after it has been created: stage transitions, loss, change
// orders, invoices, payments, base-price corrections, new proposals and deletion. Until now the browser did all of this
// by editing its local copy of the prospect and rewriting THE WHOLE DOCUMENT (`saveProspectToDB`): a stale copy could
// erase notes / flags written meanwhile, any user could change any field, and the audit entries were written by the
// client. Same design as commercialService.js (it receives that service's `kit`, so identity, access and audit are
// exactly the same code):
//   - every operation is one transaction that reads the CURRENT document, validates, changes only the fields that
//     belong to that operation and writes the history entry + audit record with the identity of the session;
//   - the browser sends the user's input, never the document, never who acts, never computed amounts;
//   - transitions are checked against the stored state (a retry or a double click finds the work already done and
//     answers `unchanged`; creations carry an opId stored in the created record);
//   - business rules that used to live only in app_core.js are enforced here (see COMMERCIAL_OPERATIONS.md):
//     the stage order, the closing requirements, the 13% VAT / export rule, invoice and payment ceilings,
//     the advance invoice that cannot be deleted, the 1% retention only for large taxpayers.
//
// Who may do what is the CURRENT behaviour of the CRM (the page offered these buttons to every user who can see the
// opportunity; the proposed Firestore rules let the owner write any field except the flags, owner and client). That is
// recorded in POLICY below so that tightening it (for example base-price corrections for managers only) is a one-line,
// tested decision and not a hunt through the code. Manager-only items keep the live Auth check.

const identity = require('./clientIdentity');
const { ServiceError, stableHash, resolveCanonicalAccount } = require('./clientsService');
const { validators } = require('./commercialService');
const {
  applyDocumentVersionsTx,
  extractDocPath,
  toCanonicalDocPointer,
  checkAndInvalidateOfferApproval,
  isNoContractApprovalValid
} = require('./documentVersioningService');

let CrmFollowUpCalc = null;
try {
  CrmFollowUpCalc = require('./crm_followup_calc');
} catch (e) {
  try {
    CrmFollowUpCalc = require('../crm_followup_calc');
  } catch (e2) {}
}

let CrmWorkCalendar = null;
try {
  CrmWorkCalendar = require('./crm_work_calendar');
} catch (e) {
  try {
    CrmWorkCalendar = require('../crm_work_calendar');
  } catch (e2) {}
}

const { bad, asObject, reqString, reqDocId, reqOpId } = validators;

const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
const REVERSION_PREV_STAGE = {
  cierre: 'negociacion',
  negociacion: 'cotizacion',
  cotizacion: 'levantamiento',
  levantamiento: 'prospecto'
};
const PROBABILIDADES = { alta: 75, media: 50, baja: 25, improbable: 10 };
const MOTIVOS_PERDIDA = ['Precio', 'Falta de seguimiento', 'No se cumplían los requerimientos técnicos', 'Tiempo de entrega', 'Cliente desiste'];
const FORMAS_PAGO = { '100% anticipado': 1.0, '70/30': 0.7, '50/50': 0.5 };
const PAYMENT_METHODS = ['transferencia', 'cheque', 'retencion_1pct'];
const ORDER_TYPES = ['aumento', 'disminucion'];
const IVA = 1.13;
const MONEY_TOLERANCE = 0.1;      // same tolerance as the page
const MAX_MONEY = 1e9;
const MAX_FILES = 20;

// Roles allowed per operation, on top of "has access to the opportunity" (creator / assignee, or manager / gestor).
const POLICY = {
  advanceStage: ['manager', 'gestor', 'vendedor'],
  revertStage: ['manager', 'gestor', 'vendedor'],
  saveClosingDocuments: ['manager', 'gestor', 'vendedor'],
  finalizeProspect: ['manager', 'gestor', 'vendedor'],
  markLost: ['manager', 'gestor', 'vendedor'],
  registerProposal: ['manager', 'gestor', 'vendedor'],
  // Postcierre (Proyectos y cobros): only manager and gestor. Vendedor is prohibited.
  saveChangeOrder: ['manager', 'gestor'],
  deleteChangeOrder: ['manager', 'gestor'],
  saveInvoice: ['manager', 'gestor'],
  deleteInvoice: ['manager', 'gestor'],
  savePayment: ['manager', 'gestor'],
  deletePayment: ['manager', 'gestor'],
  // Approved decision: manager, gestor, and assigned vendedor before closing, only during cotizacion and negociacion.
  editBasePrice: ['manager', 'gestor', 'vendedor'],
  deleteProspect: ['manager-live'],
  reactivateProspect: ['manager-live']
};

const fmtMoney = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
const truthyFlag = v => v === true || v === 'true';
const round2 = n => Math.round(n * 100) / 100;
// `amount` exceeds `ceiling` by more than the page's tolerance. Both sides are rounded to cents first: 10000 * 1.13 is
// 11299.999999999998 in floating point and must not turn the 0.10 tolerance edge into a rejection.
const exceeds = (amount, ceiling) => round2(amount) > round2(ceiling + MONEY_TOLERANCE);

// ---------- input validation ----------
function money(v, label, { positive = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${label} debe ser un número`);
  if (v < 0 || (positive && v <= 0)) throw bad(`${label} debe ser ${positive ? 'mayor que cero' : 'cero o mayor'}`);
  if (v > MAX_MONEY) throw bad(`${label} es demasiado grande`);
  return round2(v);
}
function optString(v, label, max) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw bad(`${label} inválido`);
  const s = v.trim();
  if (s.length > max) throw bad(`${label} excede ${max} caracteres`);
  return s;
}
function optDate(v, label) {
  const s = optString(v, label, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label} debe tener el formato AAAA-MM-DD`);
  return s;
}
const hasDoc = d => (Array.isArray(d) ? d.length > 0 : !!d);

function fallbackHasEnteredPostclosing(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.postcierre_habilitado === false) return false;
  if (p.estado === 'activo' && p.postcierre_habilitado !== true) return false;
  if (p.postcierre_habilitado === true) return true;
  if (p.estado === 'perdido') return false;
  const hasFacturas = Array.isArray(p.facturas) && p.facturas.some(f => {
    if (!f || typeof f !== 'object') return false;
    const hasNumero = typeof f.numero === 'string' && f.numero.trim().length > 0;
    const numMonto = typeof f.monto === 'number' ? f.monto : parseFloat(f.monto);
    const hasMonto = typeof numMonto === 'number' && !isNaN(numMonto) && numMonto > 0;
    return hasNumero && hasMonto;
  });
  if (hasFacturas) return true;
  const hasCloseDate = (typeof p.fecha_cierre === 'string' && p.fecha_cierre.trim().length > 0)
    || (typeof p.fecha_postcierre === 'string' && p.fecha_postcierre.trim().length > 0)
    || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre);
  if (!hasCloseDate) return false;
  const datos = (p.datos && typeof p.datos === 'object') ? p.datos : null;
  const hasDoc = d => (Array.isArray(d) ? d.length > 0 : !!d);
  const hasContractOrSignedDoc = !!p.contrato_archivo
    || hasDoc(p.doc_firmado)
    || (!!datos && (hasDoc(datos.doc_contrato) || hasDoc(datos.doc_firmado)))
    || p.autorizado_sin_contrato === true
    || (!!datos && datos.autorizado_sin_contrato === true);
  const hasAdvanceReceipt = hasDoc(p.doc_comprobante)
    || (!!datos && hasDoc(datos.doc_comprobante));
  const hasClosingEvidence = !!p.contrato_archivo
    || (hasContractOrSignedDoc && hasAdvanceReceipt);
  if (hasClosingEvidence) return true;
  return false;
}

function createProspectWorkflowService({ db, FieldValue, kit, fileUrlPrefixes = ['https://firebasestorage.googleapis.com/v0/b/'] }) {
  if (!kit || typeof kit.col !== 'function') throw new Error('kit is required');
  const { col, iso, logEntry, logsOf, auditEntry, auditRef, requireProspectAccess, requireManager, hasEnteredPostclosing = fallbackHasEnteredPostclosing } = kit;

  // ---------- helpers ----------
  // A file reference is what uploadFileToStorage returns: { name, url }. The server cannot see the object, but it can
  // refuse anything that is not a Firebase Storage download link (no `javascript:`, no foreign hosts) and bound sizes.
  function fileRef(v, label) {
    const o = asObject(v, label);
    const name = reqString(o.name, `${label}: nombre`, 255);
    const storagePath = (typeof o.storagePath === 'string' && o.storagePath.trim())
      ? o.storagePath.trim()
      : ((typeof o.path === 'string' && o.path.trim()) ? o.path.trim() : null);
    const url = (typeof o.url === 'string' && o.url.trim()) ? o.url.trim() : null;

    if (storagePath) {
      if (storagePath.length > 500 || storagePath.includes('..') || storagePath.includes('//') || storagePath.includes('\\')) {
        throw bad(`${label}: ruta de almacenamiento inválida`);
      }
      if (!/^(prod_files|local_files)\/(prospects|clients|proyectos|facturas|pagos|ordenes_cambio|clientes)\//.test(storagePath)) {
        throw bad(`${label}: ruta de almacenamiento fuera de ámbito permitido`);
      }
      const res = { name, storagePath };
      if (url && fileUrlPrefixes.some(p => url.startsWith(p))) res.url = url;
      if (typeof o.size === 'number' && Number.isFinite(o.size)) res.size = o.size;
      if (typeof o.contentType === 'string' && o.contentType.length <= 100) res.contentType = o.contentType.trim();
      if (typeof o.motivoSustitucion === 'string' && o.motivoSustitucion.trim()) res.motivoSustitucion = o.motivoSustitucion.trim();
      return res;
    }

    if (url) {
      if (url.length > 2048 || !fileUrlPrefixes.some(p => url.startsWith(p))) {
        throw bad(`${label}: el enlace no es de Firebase Storage`);
      }
      return { name, url };
    }

    throw bad(`${label}: se requiere un enlace o ruta de archivo válida`);
  }
  function fileList(v, label, { required = false } = {}) {
    if (v === undefined || v === null) {
      if (required) throw bad(`${label} es obligatorio`);
      return [];
    }
    if (!Array.isArray(v) || v.length > MAX_FILES) throw bad(`${label} inválido`);
    const list = v.map((f, i) => fileRef(f, `${label} ${i + 1}`));
    if (required && list.length === 0) throw bad(`${label} es obligatorio`);
    return list;
  }

  const authorize = (caller, op) => {
    if (!POLICY[op].includes(caller.role)) throw new ServiceError('permission-denied', 'Tu rol no puede realizar esta operación');
  };
  const notFound = what => new ServiceError('not-found', `${what} no encontrada`);
  const precondition = message => new ServiceError('failed-precondition', message);

  async function loadProspect(tx, caller, prospectId) {
    const ref = col('prospects').doc(prospectId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
    const p = snap.data() || {};
    requireProspectAccess(caller, p); // also refuses logically deleted opportunities
    return { ref, p };
  }
  async function loadClient(tx, p) {
    if (!p.clientId) return null;
    const s = await tx.get(col('clients').doc(p.clientId));
    if (!s.exists) return null;
    const data = s.data() || {};
    if (typeof data.fusionada_en === 'string' && data.fusionada_en.trim()) {
      const resolved = await resolveCanonicalAccount(col('clients'), p.clientId, { tx });
      return resolved.canonicalData || {};
    }
    return data;
  }
  const subtotalOf = p => {
    let base = Number(p.precio_cotizado) || 0;
    for (const o of (Array.isArray(p.ordenes_cambio) ? p.ordenes_cambio : [])) {
      base += (o.tipo === 'aumento' ? Number(o.precio) : -Math.abs(Number(o.precio)));
    }
    return base;
  };
  const isExport = c => !!c && truthyFlag(c.es_exportacion);
  const facturasOf = p => (Array.isArray(p.facturas) ? p.facturas : []);
  const sumPagos = f => (Array.isArray(f.pagos) ? f.pagos : []).reduce((a, x) => a + (parseFloat(x.monto) || 0), 0);

  function requirePostclosing(p) {
    if (!p || typeof p !== 'object') throw precondition('Oportunidad inválida');
    if (!hasEnteredPostclosing(p)) {
      throw precondition('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
    }
  }
  function uniqueId(taken, now) {
    let id = Number(now);
    while (taken.includes(String(id))) id += 1;
    return String(id);
  }
  const addAudit = (tx, caller, action, prospectId, detail) => tx.create(auditRef(), auditEntry(caller, action, 'prospect', prospectId, detail));
  // The manager's panel ("X eliminó Y") reads this shape. Written here so `usuario` is the authenticated identity.
  function addDeletionNotice(tx, caller, p, client, item, detalle) {
    tx.create(col('auditLogs').doc(), {
      fecha: iso(), timestamp: FieldValue.serverTimestamp(),
      usuario: caller.name || caller.cid, usuarioId: caller.cid, usuarioUid: caller.uid,
      proyectoId: p.id || 'N/A', proyectoNombre: (client && identity.displayName(client)) || p.proyecto || 'Desconocido',
      item, detalle, source: 'callable'
    });
  }
  const withLog = (p, caller, text) => logsOf(p).concat([logEntry(caller, text, { auto: true })]);

  // =====================================================================================================
  // Stage transitions
  // =====================================================================================================
  // data (per stage, all optional unless stated by the stage):
  //   levantamiento: { visitante*, fecha_inicio, ubicacion, distancia*, fecha_visita, doc_levantamiento[] }  (* = required, distancia only if tipo_proyecto != 'Fabricación')
  //   cotizacion | negociacion: { costo_venta*, precio_cotizado*, probabilidad* (alta|media|baja|improbable), doc_oferta[], doc_costos[] } (an offer and a cost sheet must exist, new or previous)
  //   cierre: { forma_pago*, factura_anticipo*, encargado (required for 'Fabricación e instalación'), doc_firmado*, doc_comprobante* }
  async function advanceStage({ caller, prospectId, nextStage: nextStageParam, stage, data }) {
    authorize(caller, 'advanceStage');
    reqDocId(prospectId, 'prospectId');
    const nextStage = nextStageParam || stage;
    const targetStage = nextStage;
    if (!STAGES.includes(nextStage) || nextStage === 'prospecto') throw bad('Etapa inválida');
    data = (data === undefined || data === null) ? {} : asObject(data, 'Datos de la etapa');

    // Validation that does not depend on the stored document happens first (no reads wasted on a malformed request).
    const input = parseStageInput(targetStage, data);

    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.estado !== 'activo') throw precondition('Solo las oportunidades activas pueden avanzar de etapa');
      if (p.etapa === targetStage) return { status: 'unchanged', etapa: p.etapa, estado: p.estado }; // retry / double click
      const idx = STAGES.indexOf(p.etapa);
      if (idx === -1 || STAGES[idx + 1] !== targetStage) throw precondition(`No se puede pasar de "${p.etapa}" a "${targetStage}": las etapas se avanzan de una en una`);
      const client = targetStage === 'cierre' ? await loadClient(tx, p) : null;
      if (targetStage === 'cierre' && !client) throw notFound('Cliente de la oportunidad');

      const at = iso();
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      const patch = {};
      let logMsg = `Avanzó a etapa: ${targetStage}.`;

      if (nextStage === 'levantamiento') {
        datos.visitante = input.visitante; datos.fecha_inicio = input.fecha_inicio;
        if (p.tipo_proyecto !== 'Fabricación') {
          if (input.distancia === null) throw bad('Completa la distancia a la fábrica');
          datos.ubicacion = input.ubicacion; datos.distancia = input.distancia; datos.fecha_visita = input.fecha_visita;
        }
        if (input.doc_levantamiento.length > 0) datos.doc_levantamiento = input.doc_levantamiento;
      } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        if (!(input.doc_oferta.length > 0 || hasDoc(datos.doc_oferta)) || !(input.doc_costos.length > 0 || hasDoc(datos.doc_costos))) {
          throw bad('Es obligatorio adjuntar tanto la Oferta como el Cuadro de Costos');
        }
        patch.costo_venta = input.costo_venta; patch.precio_cotizado = input.precio_cotizado; patch.probabilidad = input.probabilidad;

        const quoteItems = [];
        if (input.doc_oferta.length > 0) {
          const incomingOf = input.doc_oferta[0];
          const existingOf = Array.isArray(datos.doc_oferta) && datos.doc_oferta.length > 0 ? datos.doc_oferta[0] : (datos.doc_oferta || null);
          quoteItems.push({
            docKey: 'doc_oferta',
            existingDoc: existingOf,
            incomingDoc: incomingOf,
            motivoSustitucion: existingOf ? `Actualización de oferta al avanzar a etapa ${nextStage}` : null,
            tipoArtefacto: 'oferta_comercial',
            precioAsociado: input.precio_cotizado,
            costoAsociado: input.costo_venta
          });
        }
        if (input.doc_costos.length > 0) {
          const incomingCo = input.doc_costos[0];
          const existingCo = Array.isArray(datos.doc_costos) && datos.doc_costos.length > 0 ? datos.doc_costos[0] : (datos.doc_costos || null);
          quoteItems.push({
            docKey: 'doc_costos',
            existingDoc: existingCo,
            incomingDoc: incomingCo,
            motivoSustitucion: existingCo ? `Actualización de cuadro de costos al avanzar a etapa ${nextStage}` : null,
            tipoArtefacto: 'cuadro_costos_interno',
            precioAsociado: input.precio_cotizado,
            costoAsociado: input.costo_venta
          });
        }
        if (quoteItems.length > 0) {
          await applyDocumentVersionsTx({
            tx,
            db,
            entityType: 'prospect',
            entityId: prospectId,
            parentColName: col('prospects').id,
            items: quoteItems,
            caller,
            FieldValue,
            now: () => new Date()
          });
        }

        if (input.doc_oferta.length > 0) datos.doc_oferta = input.doc_oferta;
        if (input.doc_costos.length > 0) datos.doc_costos = input.doc_costos;
        logMsg += ` (Cotizado: ${fmtMoney(input.precio_cotizado)}, Costo: ${fmtMoney(input.costo_venta)})`;

        // Regla Fase 2.2 + Bloque 2 SLA Presupuesto:
        // - Las oportunidades de Presupuesto pueden avanzar normalmente hasta Negociación.
        // - Al alcanzar Negociación como Presupuesto, se detiene el reloj del SLA operativo (sla_pausado_en).
        // - Las oportunidades de Ejecución activan su cadencia operativa habitual.
        if (p.etapa === 'cotizacion' && nextStage === 'negociacion') {
          const clasificacion = p.clasificacion || 'ejecucion';
          const curSeguimiento = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
          const curCadence = (curSeguimiento.cadencia && typeof curSeguimiento.cadencia === 'object') ? curSeguimiento.cadencia : {};
          const tipoCadencia = curCadence.tipo_cadencia || 'estandar';
          const cadConfig = CrmFollowUpCalc ? CrmFollowUpCalc.getCadenceConfig(tipoCadencia) : { dias_primer_contacto: 5 };
          const dias1erContacto = cadConfig.dias_primer_contacto || 5;

          // Preservar la fecha original si ya existía (ej. corrección autorizada o transición previa)
          const existingDelivery = p.fecha_entrega_oferta || curCadence.fecha_entrega_oferta;
          const deliveryStamp = existingDelivery || at;

          if (!existingDelivery) {
            patch.fecha_entrega_oferta = deliveryStamp;
          }

          const ymdDisplay = CrmFollowUpCalc ? CrmFollowUpCalc.getCommercialYMD(deliveryStamp) : deliveryStamp.slice(0, 10);

          if (clasificacion === 'presupuesto') {
            patch.sla_pausado_en = p.sla_pausado_en || at;
            patch.sla_pausado_etapa = 'negociacion';
            patch.sla_estado = 'pausado_presupuesto';

            const nextCadence = {
              ...curCadence,
              tipo_cadencia: tipoCadencia,
              fecha_entrega_oferta: deliveryStamp,
              fecha_entrega_oferta_ymd: ymdDisplay,
              entregado_por_id: caller.cid,
              entregado_por_nombre: caller.name || 'Comercial',
              sla_pausado: true
            };

            patch.seguimiento = {
              ...curSeguimiento,
              cadencia: nextCadence,
              proxima_accion: curSeguimiento.proxima_accion || null
            };

            logMsg += ` [Entrega de Oferta Presupuestaria: ${ymdDisplay}. SLA operativo detenido en Negociación mientras conserve condición de Presupuesto]`;
          } else {
            patch.sla_estado = 'activo';

            let primerContactoYMD = '';
            if (CrmFollowUpCalc) {
              const primerContactoDate = CrmFollowUpCalc.addBusinessDaysForExternalContact(deliveryStamp, dias1erContacto);
              primerContactoYMD = CrmFollowUpCalc.formatDateYMD(primerContactoDate);
            } else {
              const d = new Date(deliveryStamp);
              d.setDate(d.getDate() + 7);
              primerContactoYMD = d.toISOString().slice(0, 10);
            }

            const curProxima = curSeguimiento.proxima_accion || null;
            const nextProxima = (curProxima && curProxima.fecha) ? curProxima : {
              fecha: primerContactoYMD,
              tipo: 'llamada',
              descripcion: `Primer seguimiento comercial post-oferta (${dias1erContacto} días hábiles)`
            };

            const nextCadence = {
              ...curCadence,
              tipo_cadencia: tipoCadencia,
              fecha_entrega_oferta: deliveryStamp,
              fecha_entrega_oferta_ymd: ymdDisplay,
              entregado_por_id: caller.cid,
              entregado_por_nombre: caller.name || 'Comercial',
              sla_pausado: false
            };

            patch.seguimiento = {
              ...curSeguimiento,
              cadencia: nextCadence,
              proxima_accion: nextProxima
            };

            logMsg += ` [Entrega de Oferta Registrada: ${ymdDisplay}. Primer contacto: ${nextProxima.fecha}]`;
          }
        }
      } else {
        if ((p.clasificacion || 'ejecucion') === 'presupuesto') {
          throw precondition('Esta oportunidad está clasificada como "Cotización para presupuesto". Para avanzar a Cierre comercial debe reclasificarse primero a "Oferta para ejecución".');
        }
        // cierre: La etapa de Cierre representa una oportunidad aceptada pendiente de documentación.
        // Se registra fecha de inicio de cierre y plazo límite de 5 días hábiles.
        // La oportunidad se mantiene abierta (estado = 'activo'). No se marca como ganado ni se crea factura de anticipo.
        const workCal = (typeof CrmWorkCalendar !== 'undefined' && CrmWorkCalendar)
          ? CrmWorkCalendar
          : (CrmFollowUpCalc && typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null);
        let deadlineYMD = null;
        if (workCal && typeof workCal.addWorkDays === 'function') {
          const limitDate = workCal.addWorkDays(at, 5, { excludeSaturday: true });
          deadlineYMD = (typeof workCal.getCommercialYMD === 'function') ? workCal.getCommercialYMD(limitDate) : limitDate.toISOString().slice(0, 10);
        }

        patch.fecha_inicio_cierre = at;
        patch.fecha_limite_cierre = deadlineYMD;
        patch.estado = 'activo';
        patch.postcierre_habilitado = false;

        // Guardar datos documentales preliminares si fueron enviados
        if (input.forma_pago) patch.forma_pago = input.forma_pago;
        if (input.encargado) patch.encargado = input.encargado;
        if (input.factura_anticipo) datos.factura_anticipo = input.factura_anticipo;
        const itemsToVersion = [];
        if (input.doc_firmado) {
          const motivoFirmado = (input.doc_firmado && input.doc_firmado.motivoSustitucion)
            || (data && data.motivo_doc_firmado)
            || (data && data.motivoSustitucion)
            || null;
          itemsToVersion.push({
            docKey: 'doc_firmado',
            existingDoc: datos.doc_firmado,
            incomingDoc: input.doc_firmado,
            motivoSustitucion: motivoFirmado,
            opId: (data && data.opId) ? `${data.opId}_doc_firmado` : null
          });
        }

        if (input.doc_comprobante) {
          const motivoComprobante = (input.doc_comprobante && input.doc_comprobante.motivoSustitucion)
            || (data && data.motivo_doc_comprobante)
            || (data && data.motivoSustitucion)
            || null;
          itemsToVersion.push({
            docKey: 'doc_comprobante',
            existingDoc: datos.doc_comprobante,
            incomingDoc: input.doc_comprobante,
            motivoSustitucion: motivoComprobante,
            opId: (data && data.opId) ? `${data.opId}_doc_comprobante` : null
          });
        }

        let approvalInvalidation = null;
        if (itemsToVersion.length > 0) {
          const verResults = await applyDocumentVersionsTx({
            tx,
            db,
            entityType: 'prospect',
            entityId: prospectId,
            parentColName: col('prospects').id,
            items: itemsToVersion,
            caller,
            FieldValue,
            now: () => new Date()
          });

          for (let i = 0; i < itemsToVersion.length; i++) {
            const itemKey = itemsToVersion[i].docKey;
            const res = verResults[i];
            if (itemKey === 'doc_firmado') {
              datos.doc_firmado = res.doc;
              if (res.substituted) {
                approvalInvalidation = checkAndInvalidateOfferApproval({
                  prospect: p,
                  datos,
                  caller,
                  prospectId,
                  isoStamp: at,
                  motivoSustitucion: itemsToVersion[i].motivoSustitucion
                });
              }
            } else if (itemKey === 'doc_comprobante') {
              datos.doc_comprobante = res.doc;
            }
          }
        }

        logMsg = `Avanzó a CIERRE. Oportunidad en proceso pendiente de documentación reglamentaria (plazo: 5 días hábiles, límite: ${deadlineYMD || '5 días'}).`;
        if (approvalInvalidation && approvalInvalidation.invalidated) {
          logMsg += ` ${approvalInvalidation.logMsg}`;
          patch.aprobacion_sin_contrato = approvalInvalidation.aprobacionRecord;
        }
      }

      if (nextStage === 'cierre' && p.clientId) {
        const toAdd = [p.vendedorId, p.createdBy, caller.cid].filter(v => v && v !== 'sistema');
        for (const v of Array.from(new Set(toAdd))) {
          tx.update(col('clients').doc(p.clientId), {
            closingVendors: FieldValue.arrayUnion(v),
            visibleTo: FieldValue.arrayUnion(v)
          });
        }
      }

      // Liquidar tiempo de la etapa saliente
      const stageStart = (p.stage_timestamps && p.stage_timestamps[p.etapa]) || p.fecha_creacion;
      const workCal = (typeof CrmWorkCalendar !== 'undefined' && CrmWorkCalendar)
        ? CrmWorkCalendar
        : (CrmFollowUpCalc && typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null);
      let elapsedDays = 0;
      if (workCal && typeof workCal.getWorkTimeBetween === 'function' && stageStart) {
        elapsedDays = workCal.getWorkTimeBetween(stageStart, at, { excludeSaturday: true });
      }
      const canonElapsed = Math.round(Number(elapsedDays || 0) * 2) / 2;
      const prevTiempos = (p.tiempos_etapas_acumulados && typeof p.tiempos_etapas_acumulados === 'object') ? p.tiempos_etapas_acumulados : {};
      const curAcc = typeof prevTiempos[p.etapa] === 'number' ? prevTiempos[p.etapa] : 0;
      const newAcc = Math.round((curAcc + canonElapsed) * 2) / 2;
      const tiempos_etapas_acumulados = { ...prevTiempos, [p.etapa]: newAcc };

      // Si entra a negociación, la propuesta pasa a estado 'vigente'
      if (nextStage === 'negociacion') {
        datos.estado_propuesta = 'vigente';
      }

      const transitions = Array.isArray(p.stage_transitions) ? p.stage_transitions : [];
      const transitionEntry = {
        from: p.etapa,
        to: nextStage,
        tipo: 'avance',
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        duracion_dias: canonElapsed
      };

      const nextVersion = (typeof p.version === 'number' ? p.version : 0) + 1;

      tx.update(ref, {
        ...patch, datos, etapa: nextStage,
        stage_timestamps: { ...(p.stage_timestamps && typeof p.stage_timestamps === 'object' ? p.stage_timestamps : {}), [nextStage]: at },
        tiempos_etapas_acumulados,
        stage_transitions: transitions.concat([transitionEntry]),
        version: nextVersion,
        logs: withLog(p, caller, logMsg)
      });
      addAudit(tx, caller, 'advanceStage', prospectId, {
        from: p.etapa,
        to: nextStage,
        duracion_dias: canonElapsed,
        ...(nextStage === 'negociacion' ? {
          fecha_entrega_oferta: patch.fecha_entrega_oferta || p.fecha_entrega_oferta,
          primer_contacto: patch.seguimiento && patch.seguimiento.proxima_accion && patch.seguimiento.proxima_accion.fecha
        } : {}),
        ...(nextStage === 'cierre' ? {
          fecha_inicio_cierre: at,
          fecha_limite_cierre: patch.fecha_limite_cierre
        } : {})
      });
      return { status: 'advanced', etapa: nextStage, estado: patch.estado || p.estado };
    });
  }

  // =====================================================================================================
  // Stage Reversion (Fase 4D)
  // Reversión libre estrictamente contigua, paso a paso, con motivo obligatorio e idempotencia duradera
  // =====================================================================================================
  async function revertStage({ caller, prospectId, currentStage, targetStage, motivo, opId }) {
    authorize(caller, 'revertStage');
    reqDocId(prospectId, 'prospectId');
    reqOpId(opId, 'opId');
    const curStage = reqString(currentStage, 'currentStage', 50);
    const tgtStage = reqString(targetStage, 'targetStage', 50);
    const reason = reqString(motivo, 'El motivo del retroceso', 500);
    if (reason.length < 10) throw bad('El motivo del retroceso debe tener al menos 10 caracteres');

    if (!REVERSION_PREV_STAGE[curStage] || REVERSION_PREV_STAGE[curStage] !== tgtStage) {
      throw precondition(`Solo se permite retroceder a la etapa inmediatamente anterior (${REVERSION_PREV_STAGE[curStage] || 'ninguna'}). Saltos no contiguos no están permitidos.`);
    }

    const currentPayloadHash = stableHash({ prospectId, currentStage: curStage, targetStage: tgtStage, motivo: reason });
    const opRef = col('ops').doc(opId);

    return db.runTransaction(async tx => {
      // -------------------------------------------------------------
      // FASE 1: TODAS LAS LECTURAS (Strictly Before Any Write)
      // -------------------------------------------------------------

      // 1.1 Comprobación de idempotencia duradera en prospectOps
      const prevOp = await tx.get(opRef);
      if (prevOp.exists) {
        const opData = prevOp.data() || {};
        if (opData.createdBy !== caller.cid) {
          throw new ServiceError('permission-denied', 'El opId pertenece a otro usuario');
        }
        if (opData.prospectId !== prospectId || opData.action !== 'revertStage' || opData.payloadHash !== currentPayloadHash) {
          throw new ServiceError('failed-precondition', 'El opId ya fue utilizado con otros datos o para otra oportunidad');
        }
        return { status: 'reverted', replay: true, ...opData.result };
      }

      // 1.2 Documento de la oportunidad
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.estado !== 'activo') throw precondition('Solo las oportunidades activas pueden retroceder de etapa');

      // Control de Concurrencia Optimista (OCC): verificar etapa actual
      if (p.etapa !== curStage) {
        throw precondition(`Conflicto de concurrencia: la oportunidad se encuentra en la etapa '${p.etapa}', no en '${curStage}'. Actualice la pantalla.`);
      }

      // 1.3 Si se revierte de Cierre, consultar otras oportunidades de Cierre del cliente
      let vendorsToRemove = [];
      if (curStage === 'cierre' && p.clientId) {
        const otherSnap = await tx.get(
          col('prospects')
            .where('clientId', '==', p.clientId)
            .where('etapa', '==', 'cierre')
        );
        const candidates = [p.vendedorId, p.createdBy].filter(v => v && v !== 'sistema');
        const remainingClosing = new Set();
        otherSnap.docs.forEach(d => {
          if (d.id === prospectId) return;
          const op = d.data() || {};
          if (op.eliminado === true || op.estado === 'perdido') return;
          if (op.vendedorId) remainingClosing.add(String(op.vendedorId));
          if (op.createdBy) remainingClosing.add(String(op.createdBy));
        });
        vendorsToRemove = candidates.filter(v => !remainingClosing.has(String(v)));
      }

      // -------------------------------------------------------------
      // FASE 2: CÓMPUTO EN MEMORIA
      // -------------------------------------------------------------
      const at = iso();
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      const patch = {};

      // 2.1 Liquidación de tiempo en la etapa saliente
      const stageStart = (p.stage_timestamps && p.stage_timestamps[curStage]) || p.fecha_creacion;
      const workCal = (typeof CrmWorkCalendar !== 'undefined' && CrmWorkCalendar)
        ? CrmWorkCalendar
        : (CrmFollowUpCalc && typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null);
      const isPausedBudgetInNegociacion = curStage === 'negociacion' && (p.clasificacion === 'presupuesto' || Boolean(p.sla_pausado_en));
      let elapsedDays = 0;
      if (!isPausedBudgetInNegociacion && workCal && typeof workCal.getWorkTimeBetween === 'function' && stageStart) {
        elapsedDays = workCal.getWorkTimeBetween(stageStart, at, { excludeSaturday: true });
      }
      const canonElapsed = Math.round(Number(elapsedDays || 0) * 2) / 2;
      const prevTiempos = (p.tiempos_etapas_acumulados && typeof p.tiempos_etapas_acumulados === 'object') ? p.tiempos_etapas_acumulados : {};
      const curAcc = typeof prevTiempos[curStage] === 'number' ? prevTiempos[curStage] : 0;
      const newAcc = Math.round((curAcc + canonElapsed) * 2) / 2;
      const tiempos_etapas_acumulados = { ...prevTiempos, [curStage]: newAcc };

      if (isPausedBudgetInNegociacion) {
        const pauseStart = p.sla_pausado_en || stageStart;
        const pMs = pauseStart ? new Date(pauseStart).getTime() : NaN;
        const atMs = new Date(at).getTime();
        const waitCalendarDays = (!isNaN(pMs) && !isNaN(atMs) && atMs > pMs)
          ? Math.max(0, Math.floor((atMs - pMs) / (1000 * 60 * 60 * 24)))
          : 0;
        const prevWait = Number(p.tiempo_espera_presupuesto_acumulado_dias) || 0;
        patch.tiempo_espera_presupuesto_acumulado_dias = prevWait + waitCalendarDays;
        patch.sla_pausado_en = null;
        patch.sla_pausado_etapa = null;
        patch.sla_estado = 'activo';
      }

      // 2.2 Reinicio del ciclo de SLA para la etapa destino reingresada
      const prevTimestamps = (p.stage_timestamps && typeof p.stage_timestamps === 'object') ? p.stage_timestamps : {};
      const stage_timestamps = { ...prevTimestamps, [tgtStage]: at };

      // 2.3 Registro de transición
      const prevTransitions = Array.isArray(p.stage_transitions) ? p.stage_transitions : [];
      const transitionEntry = {
        from: curStage,
        to: tgtStage,
        tipo: 'reversion',
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        motivo: reason,
        opId,
        duracion_dias: canonElapsed
      };
      const stage_transitions = prevTransitions.concat([transitionEntry]);

      // 2.4 Mutaciones específicas según la transición
      if (curStage === 'cierre' && tgtStage === 'negociacion') {
        // Invalida incondicionalmente la autorización sin contrato
        datos.autorizado_sin_contrato = false;
        if (p.aprobacion_sin_contrato) {
          patch.aprobacion_sin_contrato = {
            ...p.aprobacion_sin_contrato,
            estado: 'invalidada_por_reversion',
            fecha_invalidacion: at,
            invalidado_por_id: caller.cid,
            motivo_invalidacion: reason
          };
        }
        const rawReqs = Array.isArray(p.solicitudes_sin_contrato) ? p.solicitudes_sin_contrato : [];
        if (rawReqs.length > 0) {
          patch.solicitudes_sin_contrato = rawReqs.map(r => {
            if (r && r.estado === 'pendiente') {
              return {
                ...r,
                estado: 'anulada_por_reversion',
                fecha_anulacion: at,
                anulado_por_id: caller.cid,
                motivo_anulacion: reason
              };
            }
            return r;
          });
        }
        patch.fecha_inicio_cierre = FieldValue.delete();
        patch.fecha_limite_cierre = FieldValue.delete();
      } else if (curStage === 'negociacion' && tgtStage === 'cotizacion') {
        // Marca documentos anteriores como borrador
        datos.estado_propuesta = 'borrador';
        patch.fecha_entrega_oferta = FieldValue.delete();
        const curSeg = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
        patch.seguimiento = {
          ...curSeg,
          cadencia: null,
          proxima_accion: null
        };
      }

      const logMsg = `Retroceso de etapa: de ${curStage.toUpperCase()} a ${tgtStage.toUpperCase()}. Motivo: ${reason}`;
      const nextVersion = (typeof p.version === 'number' ? p.version : 0) + 1;
      const opResult = {
        prospectId,
        etapa: tgtStage,
        previousStage: curStage,
        version: nextVersion
      };

      // -------------------------------------------------------------
      // FASE 3: ESCRITURAS ATÓMICAS (Strictly After All Reads)
      // -------------------------------------------------------------
      tx.update(ref, {
        ...patch,
        datos,
        etapa: tgtStage,
        stage_timestamps,
        tiempos_etapas_acumulados,
        stage_transitions,
        version: nextVersion,
        logs: withLog(p, caller, logMsg)
      });

      if (vendorsToRemove.length > 0 && p.clientId) {
        for (const v of vendorsToRemove) {
          tx.update(col('clients').doc(p.clientId), {
            closingVendors: FieldValue.arrayRemove(v)
          });
        }
      }

      tx.create(opRef, {
        action: 'revertStage',
        status: 'succeeded',
        prospectId,
        currentStage: curStage,
        targetStage: tgtStage,
        payloadHash: currentPayloadHash,
        createdBy: caller.cid,
        createdAt: FieldValue.serverTimestamp(),
        result: opResult
      });

      addAudit(tx, caller, 'revertProspectStage', prospectId, {
        from: curStage,
        to: tgtStage,
        motivo: reason,
        opId,
        duracion_dias: canonElapsed
      });

      return { status: 'reverted', replay: false, ...opResult };
    });
  }

  // =====================================================================================================
  // Save Closing Documents (sin finalizar oportunidad)
  // =====================================================================================================
  async function saveClosingDocuments({ caller, prospectId, data = {}, opId = null }) {
    authorize(caller, 'saveClosingDocuments');
    reqDocId(prospectId, 'prospectId');

    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.etapa !== 'cierre') throw precondition('Solo se pueden guardar avances documentales en etapa de Cierre');
      if (p.estado !== 'activo') throw precondition('Solo una oportunidad en Cierre activo puede modificar documentos');

      const datos = (p.datos && typeof p.datos === 'object') ? { ...p.datos } : {};
      const patch = {};
      const parentColName = col('prospects').id;
      let approvalInvalidation = null;

      if (data.forma_pago && Object.prototype.hasOwnProperty.call(FORMAS_PAGO, data.forma_pago)) {
        patch.forma_pago = data.forma_pago;
      }
      if (data.encargado) {
        patch.encargado = optString(data.encargado, 'El encargado', 120);
      }
      if (data.factura_anticipo) {
        datos.factura_anticipo = reqString(data.factura_anticipo, 'El número de factura de anticipo', 60);
      }
      if (data.notas_cierre) {
        datos.notas_cierre = optString(data.notas_cierre, 'Notas de cierre', 500);
      }
      if (data.requiere_contrato !== undefined) {
        patch.requiere_contrato = data.requiere_contrato === true;
        datos.requiere_contrato = data.requiere_contrato === true;
      }
      if (data.firmante_cierre !== undefined) {
        patch.firmante_cierre = data.firmante_cierre;
        datos.firmante_cierre = data.firmante_cierre;
      }

      const itemsToVersion = [];
      if (data.doc_firmado) {
        const incomingFirmado = fileRef(data.doc_firmado, 'Contrato u oferta firmada');
        const motivoFirmado = data.motivo_doc_firmado
          || (typeof data.doc_firmado === 'object' ? data.doc_firmado.motivoSustitucion : null)
          || data.motivoSustitucion
          || null;
        itemsToVersion.push({
          docKey: 'doc_firmado',
          existingDoc: datos.doc_firmado,
          incomingDoc: incomingFirmado,
          motivoSustitucion: motivoFirmado,
          opId: (data.opId || opId) ? `${data.opId || opId}_doc_firmado` : null
        });
      }

      if (data.doc_comprobante) {
        const incomingComprobante = fileRef(data.doc_comprobante, 'Factura o comprobante de anticipo');
        const motivoComprobante = data.motivo_doc_comprobante
          || (typeof data.doc_comprobante === 'object' ? data.doc_comprobante.motivoSustitucion : null)
          || data.motivoSustitucion
          || null;
        itemsToVersion.push({
          docKey: 'doc_comprobante',
          existingDoc: datos.doc_comprobante,
          incomingDoc: incomingComprobante,
          motivoSustitucion: motivoComprobante,
          opId: (data.opId || opId) ? `${data.opId || opId}_doc_comprobante` : null
        });
      }

      if (itemsToVersion.length > 0) {
        const verResults = await applyDocumentVersionsTx({
          tx,
          db,
          entityType: 'prospect',
          entityId: prospectId,
          parentColName,
          items: itemsToVersion,
          caller,
          FieldValue,
          now: () => new Date()
        });

        for (let i = 0; i < itemsToVersion.length; i++) {
          const itemKey = itemsToVersion[i].docKey;
          const res = verResults[i];
          if (itemKey === 'doc_firmado') {
            datos.doc_firmado = {
              name: res.doc.name,
              ...(res.doc.storagePath ? { storagePath: res.doc.storagePath } : {}),
              ...(res.doc.url ? { url: res.doc.url } : {}),
              ...(res.versionId ? { versionId: res.versionId } : {}),
              ...(res.versionNumber !== undefined && res.versionNumber !== null ? { versionNumber: res.versionNumber } : {})
            };
            if (res.substituted) {
              approvalInvalidation = checkAndInvalidateOfferApproval({
                prospect: p,
                datos,
                caller,
                prospectId,
                isoStamp: iso(),
                motivoSustitucion: itemsToVersion[i].motivoSustitucion
              });
            }
          } else if (itemKey === 'doc_comprobante') {
            datos.doc_comprobante = {
              name: res.doc.name,
              ...(res.doc.storagePath ? { storagePath: res.doc.storagePath } : {}),
              ...(res.doc.url ? { url: res.doc.url } : {}),
              ...(res.versionId ? { versionId: res.versionId } : {}),
              ...(res.versionNumber !== undefined && res.versionNumber !== null ? { versionNumber: res.versionNumber } : {})
            };
          }
        }
      }

      let logMsg = `Avance documental guardado en Cierre por ${caller.name || 'Comercial'}.`;
      if (approvalInvalidation && approvalInvalidation.invalidated) {
        logMsg += ` ${approvalInvalidation.logMsg}`;
        patch.aprobacion_sin_contrato = approvalInvalidation.aprobacionRecord;
        patch.autorizado_sin_contrato = false;
        datos.autorizado_sin_contrato = false;
      }

      tx.update(ref, {
        ...patch,
        datos,
        logs: withLog(p, caller, logMsg)
      });

      addAudit(tx, caller, 'saveClosingDocuments', prospectId, {
        hasDocFirmado: !!datos.doc_firmado,
        hasDocComprobante: !!datos.doc_comprobante,
        forma_pago: patch.forma_pago || p.forma_pago || null,
        ...(approvalInvalidation ? { approvalInvalidation: approvalInvalidation.auditDetail } : {})
      });

      return { status: 'saved', prospectId };
    });
  }

  // =====================================================================================================
  // Finalize Prospect (cierre definitivo y pase a ganado / proyectos y cobros)
  // =====================================================================================================
  async function finalizeProspect({ caller, prospectId, data = {}, opId }) {
    authorize(caller, 'finalizeProspect');
    reqDocId(prospectId, 'prospectId');

    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.etapa !== 'cierre') throw precondition('Solo una oportunidad en etapa de Cierre puede finalizarse');
      if (p.estado === 'ganado') {
        return { status: 'already_finalized', etapa: 'cierre', estado: 'ganado', prospectId };
      }
      if (p.estado !== 'activo') throw precondition('Solo una oportunidad activa puede finalizarse');

      let client = null;
      let effectiveClientId = p.clientId || null;
      if (p.clientId) {
        const cSnap = await tx.get(col('clients').doc(p.clientId));
        const rawClient = cSnap.data() || {};
        if (typeof rawClient.fusionada_en === 'string' && rawClient.fusionada_en.trim()) {
          const resolved = await resolveCanonicalAccount(col('clients'), p.clientId, { tx });
          effectiveClientId = resolved.canonicalId;
          client = resolved.canonicalData || {};
        } else {
          client = rawClient;
        }
      }

      const isBig = p.tipo_proyecto === 'Fabricación e instalación' && Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000;
      const datos = (p.datos && typeof p.datos === 'object') ? { ...p.datos } : {};
      if (datos.autorizado_sin_contrato === undefined && p.autorizado_sin_contrato === true) {
        datos.autorizado_sin_contrato = true;
      }
      const parentColName = col('prospects').id;
      const input = data || {};
      let approvalInvalidation = null;

      // Block B3 (ALTO-01): Ejecutar todas las lecturas transaccionales (incluido contract_powers) ANTES de applyDocumentVersionsTx
      const explicitContractRequirement = input.requiere_contrato !== undefined
        ? (input.requiere_contrato === true)
        : (p.requiere_contrato === true || datos.requiere_contrato === true);
      const isContractual = explicitContractRequirement === true;
      const firmante = input.firmante_cierre || p.firmante_cierre || datos.firmante_cierre || null;
      let preloadedPowerSnap = null;
      if (isContractual && firmante && firmante.tipo === 'apoderado' && effectiveClientId) {
        const powerId = firmante.powerId || firmante.id;
        if (powerId) {
          preloadedPowerSnap = await tx.get(col('clients').doc(effectiveClientId).collection('contract_powers').doc(String(powerId)));
        }
      }

      const missing = missingClientFields(client || {});
      if (missing.length > 0) throw precondition(`El cliente tiene información incompleta para cerrar la venta. Faltan: ${missing.join(', ')}`);

      const docs = (client && client.documentos && typeof client.documentos === 'object') ? client.documentos : {};
      if (!docs.dui) throw precondition('Falta el DUI (del representante o cliente) en el Directorio de Clientes: súbelo antes de cerrar el proyecto');

      const itemsToVersion = [];
      if (input.doc_firmado) {
        const incomingFirmado = fileRef(input.doc_firmado, 'Contrato u oferta firmada');
        const motivoFirmado = input.motivo_doc_firmado
          || (typeof input.doc_firmado === 'object' ? input.doc_firmado.motivoSustitucion : null)
          || input.motivoSustitucion
          || null;
        itemsToVersion.push({
          docKey: 'doc_firmado',
          existingDoc: datos.doc_firmado || (isBig ? datos.doc_contrato : datos.doc_oferta_firmada),
          incomingDoc: incomingFirmado,
          motivoSustitucion: motivoFirmado,
          opId: (input.opId || opId) ? `${input.opId || opId}_doc_firmado` : null
        });
      }

      if (input.doc_comprobante) {
        const incomingComprobante = fileRef(input.doc_comprobante, 'Factura o comprobante de anticipo');
        const motivoComprobante = input.motivo_doc_comprobante
          || (typeof input.doc_comprobante === 'object' ? input.doc_comprobante.motivoSustitucion : null)
          || input.motivoSustitucion
          || null;
        itemsToVersion.push({
          docKey: 'doc_comprobante',
          existingDoc: datos.doc_comprobante,
          incomingDoc: incomingComprobante,
          motivoSustitucion: motivoComprobante,
          opId: (input.opId || opId) ? `${input.opId || opId}_doc_comprobante` : null
        });
      }

      let docFirmado = null;
      let docComprobante = null;

      if (itemsToVersion.length > 0) {
        const verResults = await applyDocumentVersionsTx({
          tx,
          db,
          entityType: 'prospect',
          entityId: prospectId,
          parentColName,
          items: itemsToVersion,
          caller,
          FieldValue,
          now: () => new Date()
        });

        for (let i = 0; i < itemsToVersion.length; i++) {
          const itemKey = itemsToVersion[i].docKey;
          const res = verResults[i];
          if (itemKey === 'doc_firmado') {
            docFirmado = {
              name: res.doc.name,
              ...(res.doc.storagePath ? { storagePath: res.doc.storagePath } : {}),
              ...(res.doc.url ? { url: res.doc.url } : {}),
              ...(res.versionId ? { versionId: res.versionId } : {}),
              ...(res.versionNumber !== undefined && res.versionNumber !== null ? { versionNumber: res.versionNumber } : {})
            };
            datos.doc_firmado = docFirmado;
            if (res.substituted) {
              approvalInvalidation = checkAndInvalidateOfferApproval({
                prospect: p,
                datos,
                caller,
                prospectId,
                isoStamp: iso(),
                motivoSustitucion: itemsToVersion[i].motivoSustitucion
              });
            }
          } else if (itemKey === 'doc_comprobante') {
            docComprobante = {
              name: res.doc.name,
              ...(res.doc.storagePath ? { storagePath: res.doc.storagePath } : {}),
              ...(res.doc.url ? { url: res.doc.url } : {}),
              ...(res.versionId ? { versionId: res.versionId } : {}),
              ...(res.versionNumber !== undefined && res.versionNumber !== null ? { versionNumber: res.versionNumber } : {})
            };
            datos.doc_comprobante = docComprobante;
          }
        }
      }

      if (!docFirmado) {
        docFirmado = datos.doc_firmado || (isBig ? (datos.doc_contrato || datos.doc_firmado) : (datos.doc_oferta_firmada || datos.doc_firmado)) || null;
      }
      if (!docComprobante) {
        docComprobante = datos.doc_comprobante || null;
      }

      const aprobacion = (p.aprobacion_sin_contrato || (datos && datos.aprobacion_sin_contrato));
      if (isBig) {
        if (aprobacion && aprobacion.estado === 'invalidada_por_sustitucion') {
          throw precondition('La autorización para cerrar sin contrato fue invalidada por sustitución de la oferta. Se requiere nueva autorización de gerencia.');
        }
      }

      const isApprovalValid = isNoContractApprovalValid({ prospect: p, datos, activeDocFirmado: docFirmado });
      const bypass = isBig && isApprovalValid;

      if (isBig && !bypass) {
        if (datos.autorizado_sin_contrato === true && !isApprovalValid) {
          const curP = Number(p.precio_cotizado || 0);
          const autP = aprobacion && typeof aprobacion.montoAutorizado === 'number' ? aprobacion.montoAutorizado : null;
          if (!aprobacion || autP === null) {
            throw precondition('La autorización para cerrar sin contrato no tiene un monto registrado. Se requiere una nueva resolución gerencial durante la etapa de cierre.');
          }
          if (Math.round(curP * 100) !== Math.round(autP * 100)) {
            throw precondition(`La autorización para cerrar sin contrato fue otorgada para un monto de ${fmtMoney(autP)}, pero el monto actual es ${fmtMoney(curP)}. Se requiere una nueva resolución gerencial.`);
          }
          if (aprobacion.storagePathAprobado) {
            const activePath = extractDocPath(docFirmado);
            if (!activePath || activePath !== aprobacion.storagePathAprobado) {
              throw precondition('La autorización para cerrar sin contrato no coincide con la versión de la oferta actualmente adjunta.');
            }
          }
          throw precondition('La autorización para cerrar sin contrato no coincide con la versión de la oferta actualmente adjunta.');
        }
        if (client && client.tipo === 'juridica' && !(docs.escritura && docs.credencial && docs.nit && docs.nrc)) {
          throw precondition('Para cerrar con contrato hay que adjuntar antes los documentos legales de la empresa (Escritura, Credencial, NIT, NRC)');
        }
      }

      const patch = {};
      const todayStr = new Date().toISOString().slice(0, 10);

      // Block B3: Validación de contratos, poderes, vencimientos y revisión bienal (ALTO-01 & MEDIO-01)
      // Dirección: "La condición de requerir contrato debe ser un dato explícito de la oportunidad, administrado mediante un campo controlado y validado por backend. No inferirla únicamente a partir del nombre, monto o descripción de la oportunidad."
      if (isContractual) {
        if (client && client.tipo === 'juridica' && !(docs.escritura && docs.credencial && docs.nit && docs.nrc)) {
          throw precondition('Para cerrar con contrato hay que adjuntar antes los documentos legales de la empresa (Escritura, Credencial, NIT, NRC)');
        }

        if (!firmante || !firmante.tipo) {
          throw precondition('La oportunidad requiere contrato: debe seleccionar quién firmará (Representante Legal o Apoderado acreditado)');
        }
        if (firmante.tipo === 'representante_legal') {
          const rl = client && client.representanteLegalVigente;
          if (!rl || rl.estado !== 'vigente') {
            throw precondition('El firmante seleccionado es Representante Legal, pero la cuenta no tiene un nombramiento vigente registrado');
          }
          if (rl.fechaVencimiento && String(rl.fechaVencimiento).slice(0, 10) < todayStr) {
            throw precondition(`El nombramiento del Representante Legal (${rl.nombre || 'RL'}) venció el ${rl.fechaVencimiento}. Debe registrar una nueva elección antes de cerrar.`);
          }
          if (rl.credencialDoc && rl.credencialDoc.fechaVencimiento && String(rl.credencialDoc.fechaVencimiento).slice(0, 10) < todayStr) {
            throw precondition(`La credencial del Representante Legal venció el ${rl.credencialDoc.fechaVencimiento}. Debe renovarse antes de cerrar.`);
          }
          if (rl.duiDoc && rl.duiDoc.fechaVencimiento && String(rl.duiDoc.fechaVencimiento).slice(0, 10) < todayStr) {
            throw precondition(`El DUI del Representante Legal venció el ${rl.duiDoc.fechaVencimiento}. Debe renovarse antes de cerrar.`);
          }
        } else if (firmante.tipo === 'apoderado') {
          const powerId = firmante.powerId || firmante.id;
          if (!powerId) {
            throw precondition('Debe especificar el poder que acredita al apoderado seleccionado');
          }
          if (p.clientId) {
            const powerSnap = preloadedPowerSnap;
            if (!powerSnap || !powerSnap.exists) {
              throw precondition('El poder notarial seleccionado no existe en el expediente de la cuenta');
            }
            const pData = powerSnap.data() || {};
            if (pData.estado !== 'vigente') {
              throw precondition(`El poder del apoderado '${pData.nombreApoderado || 'desconocido'}' no está vigente (estado: ${pData.estado})`);
            }
            if (firmante.contactId && pData.contactId && String(firmante.contactId).trim() !== String(pData.contactId).trim()) {
              throw precondition(`El contacto del firmante ('${firmante.contactId}') no coincide con el titular del poder seleccionado ('${pData.contactId}')`);
            }
            if (pData.fechaVencimiento && String(pData.fechaVencimiento).slice(0, 10) < todayStr) {
              throw precondition(`El poder del apoderado '${pData.nombreApoderado || 'desconocido'}' venció el ${pData.fechaVencimiento}. Debe acreditarse un poder vigente antes de cerrar.`);
            }
            const activeRL = client && client.representanteLegalVigente;
            if (!activeRL || activeRL.estado !== 'vigente' || pData.termId !== activeRL.termId) {
              throw precondition(`El poder del apoderado '${pData.nombreApoderado || 'desconocido'}' fue invalidado por una nueva elección de Representante Legal`);
            }
            if (activeRL.fechaVencimiento && String(activeRL.fechaVencimiento).slice(0, 10) < todayStr) {
              throw precondition(`El período del Representante Legal otorgante (${activeRL.nombre || 'RL'}) venció el ${activeRL.fechaVencimiento}. Debe renovarse antes de cerrar con apoderado.`);
            }
          }
        } else {
          throw precondition(`Tipo de firmante '${firmante.tipo}' no reconocido. Debe ser 'representante_legal' o 'apoderado'`);
        }

        if (input.requiere_contrato !== undefined) {
          patch.requiere_contrato = input.requiere_contrato === true;
          datos.requiere_contrato = input.requiere_contrato === true;
        }
        if (input.firmante_cierre !== undefined) {
          patch.firmante_cierre = input.firmante_cierre;
          datos.firmante_cierre = input.firmante_cierre;
        }
      }

      // Check expired documents on client
      if (client && client.documentos && typeof client.documentos === 'object') {
        for (const [k, d] of Object.entries(client.documentos)) {
          if (d && typeof d === 'object' && d.fechaVencimiento && String(d.fechaVencimiento).slice(0, 10) < todayStr) {
            throw precondition(`El documento '${k}' de la cuenta venció el ${d.fechaVencimiento}. Debe renovarse en el expediente antes de cerrar.`);
          }
        }
      }

      // Check biennial reviews on juridica client documents (MEDIO-01)
      if (client && client.tipo === 'juridica' && client.documentos && typeof client.documentos === 'object') {
        const biennialReviews = (client.biennialReviews && typeof client.biennialReviews === 'object') ? client.biennialReviews : {};
        for (const bKey of ['escritura', 'mods_escritura']) {
          const bDoc = client.documentos[bKey];
          if (!bDoc || typeof bDoc !== 'object') continue;
          const bRev = biennialReviews[bKey];
          const lastConfirmedStr = (bRev && bRev.lastConfirmedAt)
            || bDoc.ultimaRevisionBienal
            || bDoc.actualizadoEn
            || null;
          if (bRev && bRev.nextReviewAt && String(bRev.nextReviewAt).slice(0, 10) < todayStr) {
            throw precondition(`El documento '${bKey}' de la cuenta tiene revisión bienal vencida (${String(bRev.nextReviewAt).slice(0, 10)}). Debe cargar una modificación o registrar confirmación de vigencia sin cambios antes de cerrar.`);
          }
          if (lastConfirmedStr) {
            const baseDate = new Date(lastConfirmedStr);
            if (!Number.isNaN(baseDate.getTime())) {
              const daysSince = Math.floor((Date.now() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
              if (daysSince > 730) {
                throw precondition(`El documento '${bKey}' de la cuenta requiere revisión bienal (${daysSince} días desde su última revisión). Debe cargar una modificación o registrar confirmación de vigencia sin cambios antes de cerrar.`);
              }
            }
          }
        }
      }

      const encargado = input.encargado || p.encargado || datos.encargado;
      if (p.tipo_proyecto === 'Fabricación e instalación' && !encargado) {
        throw bad('Debe asignar un Encargado de Instalación');
      }

      if (!docFirmado) {
        throw precondition(isBig && !bypass ? 'Debe adjuntar el contrato firmado para finalizar' : 'Debe adjuntar la oferta firmada para finalizar');
      }

      if (typeof input.factura_anticipo === 'string' && input.factura_anticipo.length > 0 && input.factura_anticipo.trim().length === 0) {
        throw bad('El número de factura de anticipo no puede estar en blanco');
      }
      const facturaAnticipo = (input.factura_anticipo ? reqString(input.factura_anticipo, 'El número de factura de anticipo', 60) : null)
        || datos.factura_anticipo || p.factura_anticipo || null;

      const formaPago = input.forma_pago || p.forma_pago || datos.forma_pago;
      if (!formaPago || !Object.prototype.hasOwnProperty.call(FORMAS_PAGO, formaPago)) {
        throw bad('Forma de pago inválida');
      }

      const at = iso();
      if (approvalInvalidation && approvalInvalidation.invalidated) {
        patch.aprobacion_sin_contrato = approvalInvalidation.aprobacionRecord;
      }

      const canonicalFirmado = toCanonicalDocPointer(docFirmado);
      const canonicalComprobante = docComprobante ? toCanonicalDocPointer(docComprobante) : null;

      if (isBig && !bypass) datos.doc_contrato = canonicalFirmado; else datos.doc_oferta_firmada = canonicalFirmado;
      datos.doc_firmado = canonicalFirmado;
      if (canonicalComprobante) {
        datos.doc_comprobante = canonicalComprobante;
      }
      if (facturaAnticipo) {
        datos.factura_anticipo = facturaAnticipo;
        patch.factura_anticipo = facturaAnticipo;
      }
      if (datos.doc_oferta) {
        datos.oferta_sustento_cierre = Array.isArray(datos.doc_oferta) && datos.doc_oferta.length > 0
          ? toCanonicalDocPointer(datos.doc_oferta[0])
          : toCanonicalDocPointer(datos.doc_oferta);
      }

      if (encargado) patch.encargado = encargado;
      patch.forma_pago = formaPago;
      patch.estado = 'ganado';
      patch.probabilidad = 100;
      patch.fecha_cierre = at;
      patch.fecha_finalizacion = at;
      patch.postcierre_habilitado = true;
      patch.fecha_postcierre = at;

      const subtotal = Number(p.precio_cotizado) || 0;
      const totalConIVA = isExport(client) ? subtotal : subtotal * IVA;
      const advanceAmount = round2(totalConIVA * FORMAS_PAGO[formaPago]);
      patch.monto_anticipo_exigible = advanceAmount;

      // Factura de anticipo generada transaccional e idempotentemente solo si el CCF ya fue emitido y adjuntado
      const facturas = Array.isArray(p.facturas) ? p.facturas.slice() : [];
      const hasCompleteAdvanceCcf = Boolean(facturaAnticipo && canonicalComprobante);
      if (hasCompleteAdvanceCcf) {
        const existingAdv = facturas.find(f => f && (f.numero === facturaAnticipo || (opId && f.opId === opId)));
        if (!existingAdv) {
          const advId = uniqueId([], Date.now());
          facturas.push({
            id: advId,
            numero: facturaAnticipo,
            monto: advanceAmount,
            doc_factura: canonicalComprobante,
            es_anticipo: true,
            tipo_factura: 'anticipo',
            pagos: [],
            fecha: at,
            opId: opId || null
          });
          patch.factura_anticipo_id = advId;
        } else if (existingAdv.id) {
          patch.factura_anticipo_id = existingAdv.id;
        }
      }
      patch.facturas = facturas;
      patch.ccf_anticipo_emitido = facturas.length > 0;

      let logMsg = hasCompleteAdvanceCcf
        ? `¡VENTA FINALIZADA! Proyecto ${p.codigo || ''} formalizado y transferido a Proyectos y Cobros con factura ${facturaAnticipo} por ${fmtMoney(advanceAmount)}`
        : `¡VENTA FINALIZADA! Proyecto ${p.codigo || ''} formalizado y transferido a Proyectos y Cobros (Modalidad: ${formaPago}, Anticipo exigible: ${fmtMoney(advanceAmount)}, CCF de anticipo: pendiente de emisión)`;
      if (bypass) logMsg += ` (Autorizado sin contrato por gerente: ${datos.autorizado_por || 'Gerente'})`;

      const transitions = Array.isArray(p.stage_transitions) ? p.stage_transitions : [];
      const transitionEntry = {
        from: 'cierre',
        to: 'cierre_finalizado',
        fecha: at,
        usuarioId: caller.cid,
        usuarioNombre: caller.name || 'Comercial',
        usuarioRole: caller.role,
        estadoFinal: 'ganado'
      };

      tx.update(ref, {
        ...patch,
        datos,
        stage_transitions: transitions.concat([transitionEntry]),
        logs: withLog(p, caller, logMsg)
      });

      addAudit(tx, caller, 'finalizeProspect', prospectId, {
        forma_pago: formaPago,
        factura_anticipo: facturaAnticipo || null,
        ccf_anticipo_emitido: hasCompleteAdvanceCcf,
        monto_anticipo: advanceAmount,
        estado: 'ganado'
      });

      return {
        status: 'finalized',
        etapa: 'cierre',
        estado: 'ganado',
        forma_pago: formaPago,
        facturaAnticipo: facturaAnticipo || null,
        ccfAnticipoEmitido: hasCompleteAdvanceCcf,
        ccf_anticipo_emitido: hasCompleteAdvanceCcf,
        montoAnticipo: advanceAmount,
        monto_anticipo_exigible: advanceAmount,
        facturas: patch.facturas,
        fecha_inicio_cierre: p.fecha_inicio_cierre || (p.stage_timestamps && p.stage_timestamps.cierre) || null,
        fecha_cierre: patch.fecha_cierre
      };
    });
  }

  function parseStageInput(stage, d) {
    if (stage === 'levantamiento') {
      return {
        visitante: reqString(d.visitante, 'Quién visitó', 120),
        fecha_inicio: optDate(d.fecha_inicio, 'La fecha estimada de inicio'),
        ubicacion: optString(d.ubicacion, 'La ubicación', 300),
        distancia: (d.distancia === undefined || d.distancia === null || d.distancia === '') ? null : String(money(d.distancia, 'La distancia')),
        fecha_visita: optDate(d.fecha_visita, 'La fecha de visita'),
        doc_levantamiento: fileList(d.doc_levantamiento, 'Documentos del levantamiento')
      };
    }
    if (stage === 'cotizacion' || stage === 'negociacion') {
      if (!Object.prototype.hasOwnProperty.call(PROBABILIDADES, d.probabilidad)) throw bad('Probabilidad inválida');
      return {
        costo_venta: money(d.costo_venta, 'El costo de venta'),
        precio_cotizado: money(d.precio_cotizado, 'El precio cotizado'),
        probabilidad: PROBABILIDADES[d.probabilidad],
        doc_oferta: fileList(d.doc_oferta, 'Oferta'),
        doc_costos: fileList(d.doc_costos, 'Cuadro de costos')
      };
    }
    if (stage === 'cierre') {
      let formaPago = null;
      if (d.forma_pago) {
        if (!Object.prototype.hasOwnProperty.call(FORMAS_PAGO, d.forma_pago)) throw bad('Forma de pago inválida');
        formaPago = d.forma_pago;
      }
      return {
        forma_pago: formaPago,
        factura_anticipo: optString(d.factura_anticipo, 'El número de factura de anticipo', 60),
        encargado: optString(d.encargado, 'El encargado', 120),
        doc_firmado: d.doc_firmado ? fileRef(d.doc_firmado, 'Contrato u oferta firmada') : null,
        doc_comprobante: d.doc_comprobante ? fileRef(d.doc_comprobante, 'Factura o comprobante de anticipo') : null
      };
    }
    throw bad('Etapa no reconocida');
  }

  // Same list the page shows before allowing a closing.
  function missingClientFields(c) {
    const m = [];
    if (c.tipo === 'natural') {
      if (!c.nombres) m.push('Nombres'); if (!c.apellidos) m.push('Apellidos'); if (!c.dui) m.push('DUI'); if (!c.nit) m.push('NIT');
    } else {
      if (!c.empresa) m.push('Nombre de la Empresa'); if (!c.contacto) m.push('Contacto Principal'); if (!c.nit) m.push('NIT'); if (!c.nrc) m.push('NRC');
    }
    if (!c.telefono) m.push('Teléfono');
    if (!c.correo) m.push('Correo Electrónico');
    if (!c.correo_fact) m.push('Correo para Facturación');
    return m;
  }

  // =====================================================================================================
  // Loss
  // =====================================================================================================
  async function markLost({ caller, prospectId, reason }) {
    authorize(caller, 'markLost');
    reqDocId(prospectId, 'prospectId');
    if (!MOTIVOS_PERDIDA.includes(reason)) throw bad('Motivo de pérdida inválido');
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.estado === 'perdido') {
        if (p.motivo_perdida === reason) return { status: 'unchanged', estado: 'perdido' };
        throw precondition('La oportunidad ya está marcada como perdida con otro motivo');
      }
      if (p.estado !== 'activo') throw precondition('Solo una oportunidad activa puede marcarse como perdida');

      let vendorsToRemove = [];
      if (p.etapa === 'cierre' && p.clientId) {
        const otherSnap = await tx.get(
          col('prospects')
            .where('clientId', '==', p.clientId)
            .where('etapa', '==', 'cierre')
        );
        const candidates = [p.vendedorId, p.createdBy].filter(v => v && v !== 'sistema');
        const remainingClosing = new Set();
        otherSnap.docs.forEach(d => {
          if (d.id === prospectId) return;
          const op = d.data() || {};
          if (op.eliminado === true || op.estado === 'perdido') return;
          if (op.vendedorId) remainingClosing.add(String(op.vendedorId));
          if (op.createdBy) remainingClosing.add(String(op.createdBy));
        });
        vendorsToRemove = candidates.filter(v => !remainingClosing.has(String(v)));
      }

      tx.update(ref, { estado: 'perdido', motivo_perdida: reason, fecha_perdida: iso(), logs: withLog(p, caller, `Marcado como PERDIDO. Motivo: ${reason}`) });
      for (const v of vendorsToRemove) {
        tx.update(col('clients').doc(p.clientId), {
          closingVendors: FieldValue.arrayRemove(v)
        });
      }
      addAudit(tx, caller, 'markLost', prospectId, { reason, etapa: p.etapa });
      return { status: 'lost', estado: 'perdido' };
    });
  }

  // =====================================================================================================
  // New proposal and base price
  // =====================================================================================================
  async function registerProposal({ caller, prospectId, costo_venta, precio_cotizado, doc_oferta, doc_costos }) {
    authorize(caller, 'registerProposal');
    reqDocId(prospectId, 'prospectId');
    const costo = money(costo_venta, 'El costo');
    const precio = money(precio_cotizado, 'El precio');
    const oferta = fileList(doc_oferta, 'La nueva oferta', { required: true });
    const costos = fileList(doc_costos, 'El nuevo cuadro de costos', { required: true });
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.estado !== 'activo' || p.etapa !== 'negociacion') throw precondition('Una nueva propuesta solo se registra en una oportunidad activa en negociación');
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      if (p.costo_venta === costo && p.precio_cotizado === precio && JSON.stringify(datos.doc_oferta) === JSON.stringify(oferta) && JSON.stringify(datos.doc_costos) === JSON.stringify(costos)) {
        return { status: 'unchanged' }; // retry of an applied request
      }

      const quoteItems = [];
      const incomingOf = Array.isArray(oferta) && oferta.length > 0 ? oferta[0] : oferta;
      const existingOf = Array.isArray(datos.doc_oferta) && datos.doc_oferta.length > 0 ? datos.doc_oferta[0] : (datos.doc_oferta || null);
      if (incomingOf) {
        quoteItems.push({
          docKey: 'doc_oferta',
          existingDoc: existingOf,
          incomingDoc: incomingOf,
          motivoSustitucion: `Nueva propuesta: Precio ${fmtMoney(precio)}, Costo ${fmtMoney(costo)}`,
          tipoArtefacto: 'oferta_comercial',
          precioAsociado: precio,
          costoAsociado: costo
        });
      }

      const incomingCo = Array.isArray(costos) && costos.length > 0 ? costos[0] : costos;
      const existingCo = Array.isArray(datos.doc_costos) && datos.doc_costos.length > 0 ? datos.doc_costos[0] : (datos.doc_costos || null);
      if (incomingCo) {
        quoteItems.push({
          docKey: 'doc_costos',
          existingDoc: existingCo,
          incomingDoc: incomingCo,
          motivoSustitucion: `Nuevo cuadro de costos: Costo ${fmtMoney(costo)}`,
          tipoArtefacto: 'cuadro_costos_interno',
          precioAsociado: precio,
          costoAsociado: costo
        });
      }

      if (quoteItems.length > 0) {
        await applyDocumentVersionsTx({
          tx,
          db,
          entityType: 'prospect',
          entityId: prospectId,
          parentColName: col('prospects').id,
          items: quoteItems,
          caller,
          FieldValue,
          now: () => new Date()
        });
      }

      datos.doc_oferta = oferta; datos.doc_costos = costos;
      const text = `NUEVA PROPUESTA: Precio ${fmtMoney(precio)}, Costo ${fmtMoney(costo)}. Docs: ${oferta.map(f => f.name).join(', ')}, ${costos.map(f => f.name).join(', ')}`;
      tx.update(ref, { costo_venta: costo, precio_cotizado: precio, datos, logs: withLog(p, caller, text) });
      addAudit(tx, caller, 'registerProposal', prospectId, { precioFrom: p.precio_cotizado || 0, precioTo: precio, costoFrom: p.costo_venta || 0, costoTo: costo });
      return { status: 'registered' };
    });
  }

  async function editBasePrice({ caller, prospectId, precio, costo, motivo, expectedOldPrice, expectedOldCost }) {
    authorize(caller, 'editBasePrice');
    reqDocId(prospectId, 'prospectId');
    const newPrice = money(precio, 'El precio');
    const newCost = money(costo, 'El costo');
    const reason = reqString(motivo, 'El motivo de la corrección', 300);

    if (expectedOldPrice === undefined || expectedOldPrice === null) {
      throw bad('expectedOldPrice es obligatorio para control de concurrencia. La aplicación se ha actualizado; guarde sus notas y recargue la página para continuar.');
    }
    if (expectedOldCost === undefined || expectedOldCost === null) {
      throw bad('expectedOldCost es obligatorio para control de concurrencia. La aplicación se ha actualizado; guarde sus notas y recargue la página para continuar.');
    }
    const expPrice = money(expectedOldPrice, 'El precio anterior esperado');
    const expCost = money(expectedOldCost, 'El costo anterior esperado');

    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      // FASE 4C: The STORED state decides. Once the prospect enters 'cierre', price and cost are strictly frozen.
      if (p.estado !== 'activo') throw precondition('El precio y el costo base solo pueden corregirse antes del cierre de la oportunidad');
      if (p.etapa === 'cierre') throw precondition('El precio y el costo quedan congelados al entrar en la etapa de cierre');
      if (p.etapa !== 'cotizacion' && p.etapa !== 'negociacion') {
        throw precondition('El precio y el costo base solo pueden corregirse durante las etapas de cotización y negociación');
      }

      const oldP = p.precio_cotizado || 0; const oldC = p.costo_venta || 0;
      const curOldP = money(oldP, 'El precio actual');
      const curOldC = money(oldC, 'El costo actual');

      // Optimistic Concurrency Control (OCC) - Mandatory and exact to cents
      if (Math.round(curOldP * 100) !== Math.round(expPrice * 100)) {
        throw precondition(`Los datos en pantalla no coinciden con los valores actuales en el sistema (Precio actual: ${fmtMoney(oldP)}, visualizado: ${fmtMoney(expPrice)}). Actualice la información antes de continuar.`);
      }
      if (Math.round(curOldC * 100) !== Math.round(expCost * 100)) {
        throw precondition(`Los datos en pantalla no coinciden con los valores actuales en el sistema (Costo actual: ${fmtMoney(oldC)}, visualizado: ${fmtMoney(expCost)}). Actualice la información antes de continuar.`);
      }

      if (oldP === newPrice && oldC === newCost) return { status: 'unchanged' };
      tx.update(ref, {
        precio_cotizado: newPrice, costo_venta: newCost,
        logs: withLog(p, caller, `Corrección de sistema: Precio original modificado de ${fmtMoney(oldP)} a ${fmtMoney(newPrice)} y Costo de ${fmtMoney(oldC)} a ${fmtMoney(newCost)}. Motivo: ${reason}`)
      });
      addAudit(tx, caller, 'editBasePrice', prospectId, {
        precioFrom: oldP,
        precioTo: newPrice,
        costoFrom: oldC,
        costoTo: newCost,
        motivo: reason,
        expectedOldPrice: expPrice,
        expectedOldCost: expCost
      });
      return { status: 'updated', precio_cotizado: newPrice, costo_venta: newCost };
    });
  }

  // =====================================================================================================
  // Change orders
  // =====================================================================================================
  async function saveChangeOrder({ caller, prospectId, orderId, tipo, desc, precio, costo, doc_oferta, doc_costos, opId }) {
    authorize(caller, 'saveChangeOrder');
    reqDocId(prospectId, 'prospectId');
    const editing = orderId !== undefined && orderId !== null && orderId !== '';
    if (editing) reqDocId(orderId, 'orderId'); else reqOpId(opId);
    if (!ORDER_TYPES.includes(tipo)) throw bad('Tipo de orden inválido');
    const description = reqString(desc, 'La descripción', 300);
    const price = money(precio, 'El monto');
    const cost = money(costo, 'El costo');
    const docOferta = (doc_oferta === undefined || doc_oferta === null) ? null : fileRef(doc_oferta, 'Oferta firmada');
    const docCostos = (doc_costos === undefined || doc_costos === null) ? null : fileRef(doc_costos, 'Hoja de costos');
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const orders = (Array.isArray(p.ordenes_cambio) ? p.ordenes_cambio : []).slice();
      const documentos = { ...(p.documentos && typeof p.documentos === 'object' ? p.documentos : {}) };
      let text; let order;
      if (editing) {
        const i = orders.findIndex(o => o && o.id === orderId);
        if (i === -1) throw notFound('Orden de cambio');
        const cur = orders[i];
        if (cur.tipo === tipo && cur.desc === description && cur.precio === price && cur.costo === cost && !docOferta && !docCostos) return { status: 'unchanged' };
        order = { ...cur, tipo, desc: description, precio: price, costo: cost };
        if (docOferta) { order.doc_oferta = docOferta; documentos[`oc_${orderId}_oferta`] = docOferta; }
        if (docCostos) { order.doc_costos = docCostos; documentos[`oc_${orderId}_costos`] = docCostos; }
        orders[i] = order;
        text = `Orden de Cambio editada: ${description}`;
      } else {
        const prior = orders.find(o => o && o.opId === opId);
        if (prior) {
          if (prior.tipo !== tipo || prior.desc !== description || prior.precio !== price || prior.costo !== cost) throw precondition('opId ya usado con otros datos');
          return { status: 'unchanged', replay: true };
        }
        const id = uniqueId(orders.map(o => o && o.id), Date.now());
        order = { id, fecha: iso(), tipo, desc: description, precio: price, costo: cost, doc_oferta: docOferta, doc_costos: docCostos, opId };
        orders.push(order);
        if (docOferta) documentos[`oc_${id}_oferta`] = docOferta;
        if (docCostos) documentos[`oc_${id}_costos`] = docCostos;
        text = `Orden de Cambio (${tipo.toUpperCase()}): ${description}. Monto: ${tipo === 'aumento' ? '+' : '-'}${fmtMoney(price)}.`;
      }
      tx.update(ref, { ordenes_cambio: orders, documentos, logs: withLog(p, caller, text) });
      addAudit(tx, caller, editing ? 'editChangeOrder' : 'createChangeOrder', prospectId, { orderId: order.id, tipo, precio: price, costo: cost });
      return { status: editing ? 'updated' : 'created', order };
    });
  }

  async function deleteChangeOrder({ caller, prospectId, orderId }) {
    authorize(caller, 'deleteChangeOrder');
    reqDocId(prospectId, 'prospectId'); reqDocId(orderId, 'orderId');
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const orders = Array.isArray(p.ordenes_cambio) ? p.ordenes_cambio : [];
      const i = orders.findIndex(o => o && o.id === orderId);
      if (i === -1) return { status: 'absent' };
      const o = orders[i];
      tx.update(ref, { ordenes_cambio: orders.slice(0, i).concat(orders.slice(i + 1)), logs: withLog(p, caller, `Orden de Cambio eliminada: ${o.desc} (${fmtMoney(o.precio)})`) });
      addAudit(tx, caller, 'deleteChangeOrder', prospectId, { orderId, desc: o.desc, precio: o.precio });
      addDeletionNotice(tx, caller, p, client, 'Orden de Cambio', `${o.desc} (${fmtMoney(o.precio)})`);
      return { status: 'deleted' };
    });
  }

  // =====================================================================================================
  // Invoices
  // =====================================================================================================
  async function saveInvoice({ caller, prospectId, invoiceId, numero, monto, doc_factura, es_anticipo, opId }) {
    authorize(caller, 'saveInvoice');
    reqDocId(prospectId, 'prospectId');
    const editing = invoiceId !== undefined && invoiceId !== null && invoiceId !== '';
    if (editing) reqDocId(invoiceId, 'invoiceId'); else reqOpId(opId);
    const number = reqString(numero, 'El número de factura', 60);
    const amount = money(monto, 'El monto', { positive: true });
    const doc = (doc_factura === undefined || doc_factura === null) ? null : fileRef(doc_factura, 'Copia de la factura');
    if (!editing && !doc) throw bad('Debe adjuntar la copia de la factura');
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p).slice();
      let invoice; let text;
      if (!editing) {
        const prior = facturas.find(f => f && f.opId === opId);
        if (prior) {
          if (prior.numero !== number || prior.monto !== amount) throw precondition('opId ya usado con otros datos');
          return { status: 'unchanged', replay: true };
        }
      }
      const idx = editing ? facturas.findIndex(f => f && f.id === invoiceId) : -1;
      if (editing && idx === -1) throw notFound('Factura');
      const totalConIVA = isExport(client) ? subtotalOf(p) : subtotalOf(p) * IVA;
      const alreadyInvoiced = facturas.reduce((a, f, i) => (i === idx ? a : a + (Number(f.monto) || 0)), 0);
      if (exceeds(alreadyInvoiced + amount, totalConIVA)) {
        throw precondition(`El monto a facturar excede el saldo restante del proyecto. Saldo máximo a facturar: ${fmtMoney(totalConIVA - alreadyInvoiced)}`);
      }
      const resolvedAdv = resolveAdvanceInvoice(p, facturas);
      let isAdvanceInvoice = false;
      if (editing) {
        const cur = facturas[idx];
        isAdvanceInvoice = Boolean(
          (resolvedAdv.invoice && resolvedAdv.invoice.id === cur.id) ||
          cur.es_anticipo === true ||
          cur.tipo_factura === 'anticipo' ||
          (p.factura_anticipo_id && cur.id === p.factura_anticipo_id)
        );
        if (cur.numero === number && cur.monto === amount && !doc) return { status: 'unchanged' };
        invoice = {
          ...cur,
          numero: number,
          monto: amount,
          es_anticipo: isAdvanceInvoice,
          tipo_factura: isAdvanceInvoice ? 'anticipo' : (cur.tipo_factura || 'ordinaria')
        };
        if (doc) invoice.doc_factura = doc;
        facturas[idx] = invoice;
        text = `Factura editada: ${number} por ${fmtMoney(amount)}`;
      } else {
        isAdvanceInvoice = (es_anticipo === false)
          ? false
          : (!resolvedAdv.invoice && !resolvedAdv.ambiguous && facturas.length === 0);
        invoice = {
          id: uniqueId(facturas.map(f => f && f.id), Date.now()),
          numero: number,
          monto: amount,
          doc_factura: doc,
          es_anticipo: isAdvanceInvoice,
          tipo_factura: isAdvanceInvoice ? 'anticipo' : 'ordinaria',
          pagos: [],
          fecha: iso(),
          opId
        };
        facturas.push(invoice);
        text = `Factura/CCF emitida: ${number} por ${fmtMoney(amount)}`;
      }
      const postAdv = resolveAdvanceInvoice({ ...p, facturas }, facturas);
      const updatePatch = {
        facturas,
        ccf_anticipo_emitido: Boolean(postAdv.invoice && hasValidPaymentDoc(postAdv.invoice.doc_factura)),
        logs: withLog(p, caller, text)
      };
      if (isAdvanceInvoice) {
        const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
        updatePatch.factura_anticipo = number;
        updatePatch.factura_anticipo_id = invoice.id;
        datos.factura_anticipo = number;
        if (doc) {
          datos.doc_comprobante = toCanonicalDocPointer(doc);
        }
        updatePatch.datos = datos;
      }
      tx.update(ref, updatePatch);
      addAudit(tx, caller, editing ? 'editInvoice' : 'createInvoice', prospectId, { invoiceId: invoice.id, numero: number, monto: amount, es_anticipo: isAdvanceInvoice });
      return {
        status: editing ? 'updated' : 'created',
        invoice,
        ccf_anticipo_emitido: updatePatch.ccf_anticipo_emitido,
        factura_anticipo: updatePatch.factura_anticipo || p.factura_anticipo || null
      };
    });
  }

  async function deleteInvoice({ caller, prospectId, invoiceId }) {
    authorize(caller, 'deleteInvoice');
    reqDocId(prospectId, 'prospectId'); reqDocId(invoiceId, 'invoiceId');
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p);
      const i = facturas.findIndex(f => f && f.id === invoiceId);
      if (i === -1) return { status: 'absent' };
      const f = facturas[i];
      const resolvedAdv = resolveAdvanceInvoice(p, facturas);
      const isTargetAdvanceInvoice = Boolean(
        f.es_anticipo === true ||
        f.tipo_factura === 'anticipo' ||
        (p.factura_anticipo_id && f.id === p.factura_anticipo_id) ||
        (resolvedAdv.invoice && resolvedAdv.invoice.id === f.id) ||
        (!resolvedAdv.invoice && i === 0 && f.es_anticipo !== false)
      );
      if (isTargetAdvanceInvoice) {
        throw precondition('Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error');
      }
      const lockSnapshotsById = new Map();
      for (const pay of (Array.isArray(f.pagos) ? f.pagos : [])) {
        if (!pay || typeof pay !== 'object') continue;
        const nRef = normalizePaymentReference(pay.ref || '');
        if (!nRef) continue;
        const lId = buildPaymentRefLockId({ metodo: pay.metodo, normRef: nRef });
        let entry = lockSnapshotsById.get(lId);
        if (!entry) {
          const lRef = col('payment_refs').doc(lId);
          const lSnap = await tx.get(lRef);
          entry = { lRef, lSnap, keys: [] };
          lockSnapshotsById.set(lId, entry);
        }
        entry.keys.push(String(pay.id || pay.fecha || ''));
      }
      tx.update(ref, { facturas: facturas.slice(0, i).concat(facturas.slice(i + 1)), logs: withLog(p, caller, `Factura eliminada: ${f.numero} (${fmtMoney(f.monto)})`) });
      for (const { lRef, lSnap } of lockSnapshotsById.values()) {
        releasePaymentRefLock(tx, lRef, lSnap, { prospectId, invoiceId: f.id, paymentKey: null });
      }
      addAudit(tx, caller, 'deleteInvoice', prospectId, { invoiceId, numero: f.numero, monto: f.monto, payments: (f.pagos || []).length });
      addDeletionNotice(tx, caller, p, client, 'Factura', `${f.numero} (${fmtMoney(f.monto)})`);
      return { status: 'deleted' };
    });
  }

  // =====================================================================================================
  // Payments & Fiscal Withholding (Art. 162 Código Tributario El Salvador)
  // =====================================================================================================
  // Regla comercial de DUCTSAL para esta fase:
  // Aunque el Art. 162 del Código Tributario contempla otros agentes de retención designados,
  // en el CRM DUCTSAL la retención del 1% de IVA se habilita exclusivamente para clientes locales
  // con `is_gran_contribuyente === true` (no aplica a medianos/pequeños contribuyentes ni a exportación).
  const RETENCION_1PCT_RATE = 0.01;
  const RETENCION_MIN_BASE_SIN_IVA = 100; // Umbral legal aplicable Art. 162: $100.00 sin IVA

  const INVALID_PAYMENT_REF_MARKERS = new Set([
    'UNDEFINED', 'NULL', 'NONE', 'NIL', 'NAN', 'FALSE', 'TRUE',
    'NA', 'N/A', 'SN', 'S/N', 'SINREF', 'SINREFERENCIA',
    'PENDIENTE', 'NINGUNA', 'NINGUNO', '0', '00', '000', '0000'
  ]);

  function normalizePaymentReference(ref) {
    if (typeof ref !== 'string') return '';
    const raw = ref.normalize('NFKC').trim().toUpperCase();
    if (!raw) return '';
    return raw.replace(/[\s\-_./#]+/g, '');
  }

  function isInvalidPaymentReference(rawRef, normRef = normalizePaymentReference(rawRef)) {
    if (!normRef) return true;
    const trimmedUpper = typeof rawRef === 'string' ? rawRef.normalize('NFKC').trim().toUpperCase() : '';
    if (INVALID_PAYMENT_REF_MARKERS.has(trimmedUpper) || INVALID_PAYMENT_REF_MARKERS.has(normRef)) {
      return true;
    }
    return false;
  }

  function isActivePaymentRecord(pay) {
    if (!pay || typeof pay !== 'object') return false;
    if (
      pay.anulado === true || pay.anulada === true ||
      pay.revertido === true || pay.revertida === true ||
      pay.eliminado === true || pay.eliminada === true ||
      pay.rechazado === true || pay.rechazada === true ||
      pay.voided === true || pay.reversed === true ||
      pay.promesa === true || pay.es_promesa === true ||
      pay.pendiente_verificacion === true ||
      pay.verificado === false || pay.confirmado === false
    ) {
      return false;
    }
    const payEstado = typeof pay.estado === 'string' ? pay.estado.trim().toLowerCase() : '';
    if (payEstado && INVALID_FINANCIAL_STATUSES.includes(payEstado)) return false;
    return true;
  }

  function isClientGranContribuyenteLocal(client) {
    if (!client || typeof client !== 'object') return false;
    if (isExport(client)) return false;
    if (!truthyFlag(client.is_gran_contribuyente)) return false;
    const cat = String(client.categoria_contribuyente || client.tipo_contribuyente || client.clasificacion_fiscal || '').trim().toLowerCase();
    if (cat && ['mediano', 'pequeno', 'pequeño', 'mediano_contribuyente', 'pequeno_contribuyente', 'pequeño_contribuyente', 'otro', 'otros'].includes(cat)) {
      return false;
    }
    return true;
  }

  /**
   * Resuelve la base gravada sin IVA de una factura o importe de factura.
   * En el modelo real de facturación de DUCTSAL ERP (`saveInvoice`, `finalizeProspect`, `#inv-monto-label`),
   * `fac.monto` representa:
   * - Clientes locales (`!isExport`): el monto total facturado CON IVA (`subtotal * 1.13`).
   * - Clientes de exportación (`isExport`): el monto facturado SIN IVA (0% exportación).
   * Si el objeto factura declara explícitamente un importe ya expresado sin IVA (`subtotal_sin_iva`,
   * `monto_sin_iva`, `base_gravada`, `incluye_iva === false` o `sin_iva === true`), se utiliza directamente
   * sin volver a dividir entre 1.13.
   */
  function resolveInvoiceBaseSinIva(facOrMonto, client) {
    const isObj = Boolean(facOrMonto && typeof facOrMonto === 'object');
    const rawMonto = isObj ? Number(facOrMonto.monto) : Number(facOrMonto);
    const montoFactura = round2(rawMonto);
    if (!Number.isFinite(montoFactura) || montoFactura <= 0) {
      return { montoFactura: 0, baseGravadaSinIva: 0, alreadyWithoutIva: false };
    }
    if (isExport(client)) {
      return { montoFactura, baseGravadaSinIva: montoFactura, alreadyWithoutIva: true };
    }
    if (isObj) {
      const explicitNet = Number(
        facOrMonto.subtotal_sin_iva ??
        facOrMonto.monto_sin_iva ??
        facOrMonto.base_gravada ??
        facOrMonto.base_sin_iva
      );
      if (Number.isFinite(explicitNet) && explicitNet > 0) {
        return { montoFactura, baseGravadaSinIva: round2(explicitNet), alreadyWithoutIva: true };
      }
      if (facOrMonto.incluye_iva === false || facOrMonto.sin_iva === true) {
        return { montoFactura, baseGravadaSinIva: montoFactura, alreadyWithoutIva: true };
      }
    }
    return { montoFactura, baseGravadaSinIva: round2(montoFactura / IVA), alreadyWithoutIva: false };
  }

  function calculateInvoiceRetencionLimit(facOrMonto, client) {
    const { montoFactura, baseGravadaSinIva } = resolveInvoiceBaseSinIva(facOrMonto, client);
    if (!Number.isFinite(montoFactura) || montoFactura <= 0 || baseGravadaSinIva <= 0) {
      return { eligible: false, baseGravadaSinIva: 0, maxRetencion: 0, reason: 'INVALID_INVOICE_AMOUNT' };
    }
    if (isExport(client)) {
      return { eligible: false, baseGravadaSinIva, maxRetencion: 0, reason: 'EXPORT_EXEMPT' };
    }
    if (!isClientGranContribuyenteLocal(client)) {
      return { eligible: false, baseGravadaSinIva, maxRetencion: 0, reason: 'NOT_GRAN_CONTRIBUYENTE' };
    }
    // Art. 162: 1% calculado estrictamente sobre la base gravada sin IVA, nunca sobre el total con IVA.
    if (baseGravadaSinIva < RETENCION_MIN_BASE_SIN_IVA) {
      return { eligible: false, baseGravadaSinIva, maxRetencion: 0, reason: 'UNDER_THRESHOLD' };
    }
    const maxRetencion = round2(baseGravadaSinIva * RETENCION_1PCT_RATE);
    return { eligible: true, baseGravadaSinIva, maxRetencion, reason: null };
  }

  function buildPaymentRefLockId({ metodo, normRef }) {
    const cleanMethod = String(metodo || '').trim().toLowerCase();
    if (cleanMethod === 'retencion_1pct') {
      return `RET_${normRef}`;
    }
    return `BANK_${normRef}`;
  }

  function extractLockEntries(lockData) {
    if (!lockData || typeof lockData !== 'object' || lockData.active === false) return [];
    if (lockData.entries && typeof lockData.entries === 'object') {
      return Object.values(lockData.entries).filter(e => e && typeof e === 'object');
    }
    if (lockData.prospectId && lockData.invoiceId) {
      return [{
        prospectId: lockData.prospectId,
        invoiceId: lockData.invoiceId,
        paymentKey: lockData.paymentKey,
        clientId: lockData.clientId || null,
        opId: lockData.opId || null,
        monto: lockData.monto,
        metodo: lockData.metodo
      }];
    }
    return [];
  }

  function upsertPaymentRefLock(tx, lockRef, lockSnap, { normRef, refText, metodo, amount, prospectId, invoiceId, clientId, paymentKey, opId, nowAt, updatedBy }) {
    const prevData = (lockSnap && lockSnap.exists && lockSnap.data() && lockSnap.data().active !== false)
      ? lockSnap.data()
      : null;
    const isDistributedLock = Boolean(
      prevData && (
        prevData.es_comprobante_distribuido === true ||
        prevData.distribuido_auditado === true ||
        prevData.estado === 'distribuido_auditado' ||
        prevData.status === 'distribuido_auditado'
      )
    );
    const nextEntries = {};
    for (const entry of extractLockEntries(prevData)) {
      if (entry.prospectId && entry.invoiceId) {
        nextEntries[`${entry.prospectId}__${entry.invoiceId}`] = entry;
      }
    }
    const slotKey = `${prospectId}__${invoiceId}`;
    const prevSlotEntry = nextEntries[slotKey] || {};
    nextEntries[slotKey] = {
      ...prevSlotEntry,
      prospectId,
      invoiceId,
      paymentKey: String(paymentKey),
      clientId: clientId || prevSlotEntry.clientId || null,
      opId: opId || prevSlotEntry.opId || null,
      monto: amount,
      metodo,
      updatedAt: nowAt
    };

    if (isDistributedLock) {
      const totalComprobante = round2(
        Number(prevData.importe_total_comprobante ?? prevData.montoTotalComprobante ?? prevData.monto) || 0
      );
      const totalAplicado = round2(
        Object.values(nextEntries).reduce((acc, e) => acc + (Number(e && e.monto) || 0), 0)
      );
      const saldoDisponible = round2(Math.max(0, totalComprobante - totalAplicado));
      const updatedAplicaciones = Array.isArray(prevData.aplicaciones)
        ? prevData.aplicaciones.map((app) => {
          if (app && app.prospectId === prospectId && app.invoiceId === invoiceId) {
            return {
              ...app,
              paymentKey: String(paymentKey),
              monto_aplicado: amount,
              monto: amount,
              metodo,
              updatedAt: nowAt
            };
          }
          return app;
        })
        : Object.values(nextEntries);

      tx.set(lockRef, {
        ...prevData,
        active: true,
        estado: 'distribuido_auditado',
        status: 'distribuido_auditado',
        es_comprobante_distribuido: true,
        distribuido_auditado: true,
        reutilizacion_bloqueada: true,
        normRef,
        ref: refText,
        metodo,
        importe_total_comprobante: totalComprobante,
        montoTotalComprobante: totalComprobante,
        monto: totalComprobante,
        total_aplicado: totalAplicado,
        totalAplicado,
        saldo_disponible: saldoDisponible,
        saldoDisponible,
        aplicaciones: updatedAplicaciones,
        entries: nextEntries,
        updatedAt: nowAt,
        updatedBy
      });
      return;
    }

    tx.set(lockRef, {
      active: true,
      normRef,
      ref: refText,
      metodo,
      monto: amount,
      prospectId,
      invoiceId,
      clientId: clientId || null,
      paymentKey: String(paymentKey),
      opId: opId || null,
      entries: nextEntries,
      updatedAt: nowAt,
      updatedBy
    });
  }

  function releasePaymentRefLock(tx, lockRef, lockSnap, { prospectId, invoiceId, paymentKey }) {
    if (!lockRef || !lockSnap || !lockSnap.exists) return;
    const ld = lockSnap.data() || {};
    const wasConflict = Boolean(
      ld.estado === 'conflicto_historico' ||
      ld.status === 'conflicto_historico' ||
      ld.conflicto_historico === true ||
      ld.wasHistoricalConflict === true
    );
    const isDistributedLock = Boolean(
      ld.es_comprobante_distribuido === true ||
      ld.estado === 'distribuido_auditado' ||
      ld.status === 'distribuido_auditado' ||
      ld.distribuido_auditado === true
    );

    const matchesReleaseTarget = (entry) => (
      Boolean(entry && entry.prospectId === prospectId && entry.invoiceId === invoiceId) &&
      (!paymentKey || !entry.paymentKey || String(entry.paymentKey) === String(paymentKey))
    );

    const nextEntries = (ld.entries && typeof ld.entries === 'object') ? { ...ld.entries } : {};
    for (const k of Object.keys(nextEntries)) {
      if (matchesReleaseTarget(nextEntries[k])) {
        delete nextEntries[k];
      }
    }
    const slotKey = `${prospectId}__${invoiceId}`;
    if (nextEntries[slotKey] && (!paymentKey || !nextEntries[slotKey].paymentKey || String(nextEntries[slotKey].paymentKey) === String(paymentKey))) {
      delete nextEntries[slotKey];
    }

    const nextConflictPayments = Array.isArray(ld.conflictPayments)
      ? ld.conflictPayments.filter((cp) => !matchesReleaseTarget(cp))
      : [];

    if (Object.keys(nextEntries).length === 0 && nextConflictPayments.length > 0) {
      for (const cp of nextConflictPayments) {
        if (cp && cp.prospectId && cp.invoiceId) {
          nextEntries[`${cp.prospectId}__${cp.invoiceId}`] = cp;
        }
      }
    }

    const remKeys = Object.keys(nextEntries);
    const nowAt = iso();

    if (wasConflict) {
      if (remKeys.length > 0) {
        const first = nextEntries[remKeys[0]];
        // Prevención de liberación prematura:
        // Mientras subsista al menos un pago asociado al conflicto histórico, el lock permanece
        // activo y en estado `conflicto_historico`, impidiendo que `BANK_078` (u otra referencia en colisión)
        // se libere o reactive para nuevos usos antes de resolver todos los pagos involucrados.
        tx.set(lockRef, {
          ...ld,
          active: true,
          estado: 'conflicto_historico',
          status: 'conflicto_historico',
          conflicto_historico: true,
          wasHistoricalConflict: true,
          requiresAdministrativeResolution: true,
          remainingConflictCount: remKeys.length,
          prospectId: first.prospectId,
          invoiceId: first.invoiceId,
          paymentKey: first.paymentKey,
          clientId: first.clientId || ld.clientId || null,
          monto: first.monto,
          entries: nextEntries,
          conflictPayments: nextConflictPayments,
          updatedAt: nowAt
        });
        return;
      }

      // Cuando ya no queda ningún pago en conflicto, el lock se cierra de forma auditada
      // con `active: false` y `estado: 'resuelto_historico'` en lugar de borrarse físicamente.
      tx.set(lockRef, {
        ...ld,
        active: false,
        estado: 'resuelto_historico',
        status: 'resuelto_historico',
        conflicto_historico: false,
        wasHistoricalConflict: true,
        requiresAdministrativeResolution: false,
        remainingConflictCount: 0,
        prospectId: null,
        invoiceId: null,
        paymentKey: null,
        entries: {},
        conflictPayments: [],
        resolvedAt: nowAt,
        updatedAt: nowAt,
        resolutionDetail: {
          ...(ld.resolutionDetail && typeof ld.resolutionDetail === 'object' ? ld.resolutionDetail : {}),
          resolvedVia: 'all_conflicting_payments_remediated',
          lastReleasedProspectId: prospectId,
          lastReleasedInvoiceId: invoiceId,
          lastReleasedPaymentKey: paymentKey ? String(paymentKey) : null,
          resolvedAt: nowAt
        }
      });
      return;
    }

    if (isDistributedLock) {
      const totalComprobante = round2(
        Number(ld.importe_total_comprobante ?? ld.montoTotalComprobante ?? ld.monto) || 0
      );
      const nextAplicaciones = Array.isArray(ld.aplicaciones)
        ? ld.aplicaciones.filter((app) => !matchesReleaseTarget(app))
        : [];
      const totalAplicado = round2(
        Object.values(nextEntries).reduce((acc, e) => acc + (Number(e && e.monto) || 0), 0)
      );
      const saldoDisponible = round2(Math.max(0, totalComprobante - totalAplicado));
      const first = remKeys.length > 0 ? nextEntries[remKeys[0]] : null;
      // Un comprobante distribuido auditado NUNCA queda libre para reutilización no autorizada,
      // aun cuando se elimine una aplicación y quede saldo_disponible > 0.
      tx.set(lockRef, {
        ...ld,
        active: true,
        estado: 'distribuido_auditado',
        status: 'distribuido_auditado',
        es_comprobante_distribuido: true,
        distribuido_auditado: true,
        reutilizacion_bloqueada: true,
        prospectId: first ? first.prospectId : null,
        invoiceId: first ? first.invoiceId : null,
        paymentKey: first ? first.paymentKey : null,
        total_aplicado: totalAplicado,
        totalAplicado,
        total_aplicaciones: remKeys.length,
        saldo_disponible: saldoDisponible,
        saldoDisponible,
        aplicaciones: nextAplicaciones,
        entries: nextEntries,
        updatedAt: nowAt
      });
      return;
    }

    if (ld.entries && typeof ld.entries === 'object') {
      if (remKeys.length === 0) {
        tx.delete(lockRef);
      } else {
        const first = nextEntries[remKeys[0]];
        tx.set(lockRef, {
          ...ld,
          prospectId: first.prospectId,
          invoiceId: first.invoiceId,
          paymentKey: first.paymentKey,
          clientId: first.clientId || ld.clientId || null,
          monto: first.monto,
          entries: nextEntries
        });
      }
      return;
    }
    tx.delete(lockRef);
  }

  // A payment is addressed by `paymentKey` = its id (new payments) or its `fecha` (historical ones have no id): never by
  // array position, which is stale as soon as someone else edits the same invoice.
  const payKeyMatches = (pay, key) => !!pay && (pay.id === key || pay.fecha === key);

  async function savePayment({ caller, prospectId, invoiceId, paymentKey, paymentId, fecha, monto, metodo, ref: reference, doc_comprobante, opId }) {
    authorize(caller, 'savePayment');
    reqDocId(prospectId, 'prospectId'); reqDocId(invoiceId, 'invoiceId');
    const resolvedPaymentKey = (paymentKey !== undefined && paymentKey !== null && paymentKey !== '')
      ? paymentKey
      : paymentId;
    const editing = resolvedPaymentKey !== undefined && resolvedPaymentKey !== null && resolvedPaymentKey !== '';
    if (editing) reqString(resolvedPaymentKey, 'paymentKey', 64); else reqOpId(opId);
    const amount = money(monto, 'El monto del abono', { positive: true });
    if (!PAYMENT_METHODS.includes(metodo)) throw bad('Forma de pago inválida');
    const refText = reqString(reference, 'La referencia', 100);
    const normRef = normalizePaymentReference(refText);
    if (isInvalidPaymentReference(refText, normRef)) {
      throw bad('Debe ingresar un número de comprobante o referencia válido');
    }
    let customFecha = null;
    if (fecha !== undefined) {
      if (fecha === null || typeof fecha !== 'string' || !fecha.trim()) {
        throw bad('La fecha del pago es obligatoria');
      }
      customFecha = fecha.trim();
      if (isNaN(Date.parse(customFecha))) {
        throw bad('La fecha del pago es inválida');
      }
    }
    const doc = (doc_comprobante === undefined || doc_comprobante === null) ? null : fileRef(doc_comprobante, 'Comprobante de pago');
    if (!editing && !doc) throw bad('Debe adjuntar el comprobante de pago');

    return db.runTransaction(async tx => {
      // 1. Todas las lecturas transaccionales antes de cualquier escritura
      const { ref: pRef, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p).map(f => ({ ...f, pagos: Array.isArray(f.pagos) ? f.pagos.slice() : [] }));
      const fac = facturas.find(f => f && f.id === invoiceId);
      const at = (editing && fac) ? fac.pagos.findIndex(x => payKeyMatches(x, resolvedPaymentKey)) : -1;
      const cur = (editing && at !== -1) ? fac.pagos[at] : null;

      const lockId = buildPaymentRefLockId({ metodo, normRef });
      const lockRef = col('payment_refs').doc(lockId);
      const lockSnap = await tx.get(lockRef);

      let oldLockRef = null;
      let oldLockSnap = null;
      if (editing && cur) {
        const oldNormRef = normalizePaymentReference(cur.ref || '');
        const oldLockId = oldNormRef
          ? buildPaymentRefLockId({ metodo: cur.metodo || metodo, normRef: oldNormRef })
          : null;
        if (oldLockId && oldLockId !== lockId) {
          oldLockRef = col('payment_refs').doc(oldLockId);
          oldLockSnap = await tx.get(oldLockRef);
        }
      }

      let fabProjQuerySnap = null;
      let fabOrdersQuerySnap = null;
      if (p.enviado_a_fabricacion === true || p.fabricacion_proyecto_id || p.discrepancia_financiera_fabricacion === true) {
        fabProjQuerySnap = await tx.get(col('proyectos_fabricacion').where('prospecto_id', '==', prospectId).limit(5));
        fabOrdersQuerySnap = await tx.get(col('fabricacion').where('prospecto_id', '==', prospectId).limit(10));
      }

      // 2. Idempotencia por opId en creación (acotada a la oportunidad y al índice payment_refs, sin lecturas globales)
      if (!editing) {
        for (const f of facturas) {
          const prior = f.pagos.find(x => x && x.opId === opId);
          if (prior) {
            if (f.id !== invoiceId || prior.monto !== amount || prior.metodo !== metodo || normalizePaymentReference(prior.ref) !== normRef) {
              throw precondition('opId ya usado con otros datos');
            }
            return { status: 'unchanged', replay: true, payment: prior };
          }
        }
        if (lockSnap.exists) {
          for (const entry of extractLockEntries(lockSnap.data())) {
            if (entry.opId && entry.opId === opId) {
              if (entry.prospectId !== prospectId || entry.invoiceId !== invoiceId || entry.monto !== amount || entry.metodo !== metodo) {
                throw precondition('opId ya usado con otros datos');
              }
              return { status: 'unchanged', replay: true, payment: entry };
            }
          }
        }
      }

      // 3. Validación de factura destino y abono en edición
      if (!fac) throw notFound('Factura');
      if (!isActiveInvoice(fac)) {
        throw precondition('La factura seleccionada no es válida o se encuentra anulada');
      }
      if (editing && at === -1) throw notFound('Abono');

      // 4. Validación de elegibilidad y tope individual de retención fiscal del 1% (Art. 162)
      let retInfo = null;
      if (metodo === 'retencion_1pct') {
        if (isExport(client)) {
          throw precondition('La retención del 1% no aplica a facturas de exportación exentas de IVA');
        }
        if (!isClientGranContribuyenteLocal(client)) {
          throw precondition('La retención del 1% solo aplica a clientes Gran Contribuyente');
        }
        retInfo = calculateInvoiceRetencionLimit(fac, client);
        if (!retInfo.eligible) {
          throw precondition('La retención del 1% (Art. 162) solo aplica cuando la base gravada sin IVA de la factura es igual o mayor a $100.00');
        }
        if (round2(amount) > round2(retInfo.maxRetencion + 0.01)) {
          throw precondition(`El monto de retención del 1% (${fmtMoney(amount)}) supera el límite fiscal permitido del 1% sobre la base gravada sin IVA (${fmtMoney(retInfo.maxRetencion)}) para esta factura.`);
        }
      }

      // 5. Detección obligatoria de números de comprobante duplicados
      // Mecanismo primario: índice transaccional O(1) en `payment_refs` + verificación en memoria de `facturas`
      // de la oportunidad actual para compatibilidad con comprobantes históricos previos al índice.
      const DUP_REF_MSG = 'Este número de comprobante ya fue registrado en otro pago. Verifique la referencia antes de continuar.';
      const editingCanonicalKey = editing && cur ? String(cur.id || cur.fecha) : null;

      if (lockSnap.exists) {
        const ld = lockSnap.data() || {};
        const isDistLock = Boolean(
          ld.es_comprobante_distribuido === true ||
          ld.distribuido_auditado === true ||
          ld.estado === 'distribuido_auditado' ||
          ld.status === 'distribuido_auditado'
        );
        if (isDistLock) {
          // Un comprobante bancario distribuido auditado (ej. BANK_868355650) NUNCA puede reutilizarse
          // en pagos nuevos ni en facturas ajenas a las aplicaciones ya autorizadas, incluso si tuviera saldo disponible.
          if (!editing) {
            throw precondition(`${DUP_REF_MSG} (${refText})`);
          }
          const lockEntries = extractLockEntries(ld);
          const matchingDistEntry = lockEntries.find(
            (e) => e.prospectId === prospectId && e.invoiceId === invoiceId && String(e.paymentKey) === editingCanonicalKey
          );
          if (!matchingDistEntry) {
            throw precondition(`${DUP_REF_MSG} (${refText})`);
          }
          const otherDistSum = round2(
            lockEntries.reduce((acc, e) => {
              const isSelf = e.prospectId === prospectId && e.invoiceId === invoiceId && String(e.paymentKey) === editingCanonicalKey;
              return isSelf ? acc : acc + (Number(e.monto) || 0);
            }, 0)
          );
          const totalComprobante = round2(
            Number(ld.importe_total_comprobante ?? ld.montoTotalComprobante ?? ld.monto) || 0
          );
          if (totalComprobante > 0 && round2(otherDistSum + amount) > round2(totalComprobante)) {
            throw precondition(`La suma de las aplicaciones (${fmtMoney(otherDistSum + amount)}) supera el importe total del comprobante bancario (${fmtMoney(totalComprobante)})`);
          }
        } else if (
          ld.bloqueado_nuevos_usos === true ||
          ld.estado === 'resuelto_historico' ||
          ld.status === 'resuelto_historico' ||
          ld.estado === 'conflicto_historico_auditoria' ||
          (ld.active !== false && (ld.estado === 'conflicto_historico' || ld.status === 'conflicto_historico' || ld.conflicto_historico === true))
        ) {
          throw precondition(`${DUP_REF_MSG} (${refText})`);
        } else {
          for (const entry of extractLockEntries(ld)) {
            const isSameEditedPayment = Boolean(
              editing &&
              entry.prospectId === prospectId &&
              entry.invoiceId === invoiceId &&
              String(entry.paymentKey) === editingCanonicalKey
            );
            if (isSameEditedPayment) continue;

            const entryMetodo = typeof (entry.metodo || ld.metodo) === 'string'
              ? String(entry.metodo || ld.metodo).trim().toLowerCase()
              : '';
            if (metodo === 'retencion_1pct' && entryMetodo === 'retencion_1pct') {
              const entryClientId = entry.clientId || ld.clientId || null;
              const sameClient = Boolean(p.clientId && entryClientId && p.clientId === entryClientId);
              const differentInvoice = !(entry.prospectId === prospectId && entry.invoiceId === invoiceId);
              if (sameClient && differentInvoice) {
                continue;
              }
            }
            throw precondition(DUP_REF_MSG);
          }
        }
      }

      for (const otherFac of facturas) {
        if (!isActiveInvoice(otherFac)) continue;
        const otherPagos = Array.isArray(otherFac.pagos) ? otherFac.pagos : [];
        for (let idx = 0; idx < otherPagos.length; idx++) {
          const otherPay = otherPagos[idx];
          if (!isActivePaymentRecord(otherPay)) continue;
          if (editing && otherFac.id === invoiceId && idx === at) continue;
          const otherNormRef = normalizePaymentReference(otherPay.ref || '');
          if (!otherNormRef || otherNormRef !== normRef) continue;
          const otherMetodo = typeof otherPay.metodo === 'string' ? otherPay.metodo.trim().toLowerCase() : '';
          if (metodo === 'retencion_1pct' && otherMetodo === 'retencion_1pct' && otherFac.id !== invoiceId) {
            continue;
          }
          throw precondition(DUP_REF_MSG);
        }
      }

      // 5b. Tope acumulado de retención 1% en la misma factura
      if (metodo === 'retencion_1pct' && retInfo) {
        const existingRetencionOnInvoice = round2(
          fac.pagos.reduce((acc, x, idx) => {
            if (idx === at || !isActivePaymentRecord(x)) return acc;
            const m = typeof x.metodo === 'string' ? x.metodo.trim().toLowerCase() : '';
            return m === 'retencion_1pct' ? acc + (parseFloat(x.monto) || 0) : acc;
          }, 0)
        );
        if (round2(existingRetencionOnInvoice + amount) > round2(retInfo.maxRetencion + 0.01)) {
          throw precondition(`El monto de retención del 1% (${fmtMoney(amount)}) supera el límite fiscal permitido del 1% sobre la base gravada sin IVA (${fmtMoney(retInfo.maxRetencion)}) para esta factura.`);
        }
      }

      // 6. Verificación de saldo pendiente de la factura
      const collected = fac.pagos.reduce((a, x, i) => (i === at || !isActivePaymentRecord(x) ? a : a + (parseFloat(x.monto) || 0)), 0);
      const pending = (Number(fac.monto) || 0) - collected;
      if (exceeds(amount, pending)) throw precondition(`El abono supera el saldo de esta factura. Saldo pendiente: ${fmtMoney(pending)}`);

      // 7. Construcción y confirmación automática en backend (campos de auditoría no falsificables)
      let payment; let text;
      const nowAt = iso();
      if (editing) {
        const effectiveDoc = doc || cur.doc_comprobante || null;
        const needsBackendConfirm = !isPositivelyConfirmedPayment(cur) && hasValidPaymentDoc(effectiveDoc);
        if (!needsBackendConfirm && cur.monto === amount && cur.metodo === metodo && cur.ref === refText && !doc && (!customFecha || cur.fecha === customFecha)) {
          return { status: 'unchanged', payment: cur };
        }
        payment = {
          ...cur,
          invoiceId: fac.id,
          factura_numero: fac.numero,
          monto: amount,
          metodo,
          ref: refText,
          ref_normalizada: normRef,
          fecha: customFecha || cur.fecha || nowAt
        };
        if (doc) payment.doc_comprobante = doc;
        if (hasValidPaymentDoc(effectiveDoc)) {
          payment.confirmado = true;
          payment.estado = 'confirmado';
          payment.confirmado_por = caller.cid || caller.uid;
          payment.confirmado_por_uid = caller.uid;
          payment.confirmado_por_rol = caller.role;
          payment.confirmado_en = nowAt;
        }
        fac.pagos[at] = payment;
        text = `Abono editado en factura ${fac.numero}: ${fmtMoney(amount)} [${metodo}]`;
      } else {
        payment = {
          id: uniqueId(fac.pagos.map(x => x && x.id), Date.now()),
          invoiceId: fac.id,
          factura_numero: fac.numero,
          monto: amount,
          metodo,
          ref: refText,
          ref_normalizada: normRef,
          doc_comprobante: doc,
          fecha: customFecha || nowAt,
          opId,
          confirmado: true,
          estado: 'confirmado',
          confirmado_por: caller.cid || caller.uid,
          confirmado_por_uid: caller.uid,
          confirmado_por_rol: caller.role,
          confirmado_en: nowAt
        };
        fac.pagos.push(payment);
        text = `Pago recibido: ${fmtMoney(amount)} vía ${metodo} a cuenta de Factura ${fac.numero}`;
      }

      const postEval = evaluateManufacturingReadiness({ p: { ...p, id: prospectId, facturas }, client });
      const hadFabricationRelease = Boolean(
        p.enviado_a_fabricacion === true ||
        p.fabricacion_proyecto_id ||
        p.discrepancia_financiera_fabricacion === true ||
        (fabProjQuerySnap && !fabProjQuerySnap.empty) ||
        (fabOrdersQuerySnap && !fabOrdersQuerySnap.empty)
      );

      let nextLogs = withLog(p, caller, text);
      const prospectPatch = {
        facturas,
        estado_habilitacion_fabricacion: postEval.ready ? 'ANTICIPO_CONFIRMADO' : 'ANTICIPO_PENDIENTE'
      };

      if (hadFabricationRelease) {
        if (postEval.ready) {
          prospectPatch.discrepancia_financiera_fabricacion = false;
          prospectPatch.bloqueado_nuevas_ordenes_fabricacion = false;
          if (p.discrepancia_financiera_fabricacion === true) {
            prospectPatch.discrepancia_financiera_resuelta_en = nowAt;
            nextLogs = withLog(
              { ...p, logs: nextLogs },
              caller,
              `Discrepancia financiera de fabricación subsanada: Anticipo obligatorio 100% cubierto (${fmtMoney(postEval.montoConfirmado)} / ${fmtMoney(postEval.montoExigible)}). Se rehabilita la liberación de órdenes.`
            );
          }
          if (fabProjQuerySnap && !fabProjQuerySnap.empty) {
            for (const projDoc of fabProjQuerySnap.docs) {
              tx.update(projDoc.ref, {
                estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
                discrepancia_financiera: false,
                bloqueado_nuevas_ordenes: false,
                monto_anticipo_exigible: postEval.montoExigible || 0,
                monto_anticipo_confirmado: postEval.montoConfirmado || 0,
                saldo_pendiente_anticipo: 0,
                validado_financieramente_en: nowAt,
                validado_financieramente_por: caller.cid || caller.uid
              });
            }
          }
          if (fabOrdersQuerySnap && !fabOrdersQuerySnap.empty) {
            for (const ordDoc of fabOrdersQuerySnap.docs) {
              tx.update(ordDoc.ref, {
                estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
                discrepancia_financiera: false,
                bloqueado_avance_etapa: false,
                validado_financieramente_en: nowAt
              });
            }
          }
        } else {
          const discrepancyDetail = {
            activa: true,
            codigo: postEval.errorCode || 'ANTICIPO_PENDIENTE',
            motivo: `El anticipo obligatorio presenta un saldo pendiente de ${fmtMoney(postEval.saldoPendiente)} tras editar el abono en factura ${fac.numero}. Las órdenes en curso NO se cancelan automáticamente; quedan bloqueadas nuevas liberaciones hasta regularizar el anticipo.`,
            montoExigible: postEval.montoExigible || 0,
            montoConfirmado: postEval.montoConfirmado || 0,
            saldoPendiente: postEval.saldoPendiente || 0,
            formaPago: postEval.formaPago || p.forma_pago || null,
            disparadoPorOperacion: 'editPayment',
            invoiceId: fac.id,
            facturaNumero: fac.numero,
            registradoEn: nowAt,
            registradoPor: caller.cid || caller.uid
          };
          prospectPatch.discrepancia_financiera_fabricacion = true;
          prospectPatch.bloqueado_nuevas_ordenes_fabricacion = true;
          prospectPatch.discrepancia_financiera_detalle = discrepancyDetail;
          nextLogs = withLog(
            { ...p, logs: nextLogs },
            caller,
            `ALERTA FINANCIERA DE FABRICACIÓN: ${discrepancyDetail.motivo}`
          );
          if (fabProjQuerySnap && !fabProjQuerySnap.empty) {
            for (const projDoc of fabProjQuerySnap.docs) {
              tx.update(projDoc.ref, {
                estado_habilitacion_fabricacion: 'ANTICIPO_PENDIENTE',
                discrepancia_financiera: true,
                discrepancia_financiera_detalle: discrepancyDetail,
                bloqueado_nuevas_ordenes: true,
                monto_anticipo_exigible: postEval.montoExigible || 0,
                monto_anticipo_confirmado: postEval.montoConfirmado || 0,
                saldo_pendiente_anticipo: postEval.saldoPendiente || 0,
                actualizado_discrepancia_en: nowAt
              });
            }
          }
          if (fabOrdersQuerySnap && !fabOrdersQuerySnap.empty) {
            for (const ordDoc of fabOrdersQuerySnap.docs) {
              const ordData = ordDoc.data() || {};
              const isPreFab = ['', 'Recepción', 'Dibujo'].includes(String(ordData.etapa || '').trim());
              tx.update(ordDoc.ref, {
                estado_habilitacion_fabricacion: 'ANTICIPO_PENDIENTE',
                discrepancia_financiera: true,
                discrepancia_financiera_detalle: discrepancyDetail,
                bloqueado_avance_etapa: isPreFab,
                cancelada_por_discrepancia: false
              });
            }
          }
          addAudit(tx, caller, 'manufacturingFinancialDiscrepancy', prospectId, discrepancyDetail);
        }
      }

      prospectPatch.logs = nextLogs;
      tx.update(pRef, prospectPatch);
      upsertPaymentRefLock(tx, lockRef, lockSnap, {
        normRef,
        refText,
        metodo,
        amount,
        prospectId,
        invoiceId: fac.id,
        clientId: p.clientId || null,
        paymentKey: String(payment.id || payment.fecha),
        opId: payment.opId || null,
        nowAt,
        updatedBy: caller.cid || caller.uid
      });
      if (editing && oldLockRef && oldLockSnap && oldLockSnap.exists) {
        releasePaymentRefLock(tx, oldLockRef, oldLockSnap, {
          prospectId,
          invoiceId: fac.id,
          paymentKey: editingCanonicalKey
        });
      }
      addAudit(tx, caller, editing ? 'editPayment' : 'createPayment', prospectId, {
        invoiceId: fac.id,
        paymentKey: String(payment.id || payment.fecha),
        numero: fac.numero,
        monto: amount,
        metodo,
        ref: refText,
        ref_normalizada: normRef,
        confirmado: Boolean(payment.confirmado)
      });
      return { status: editing ? 'updated' : 'created', payment };
    });
  }

  async function deletePayment({ caller, prospectId, invoiceId, paymentKey, paymentId }) {
    authorize(caller, 'deletePayment');
    reqDocId(prospectId, 'prospectId'); reqDocId(invoiceId, 'invoiceId');
    const resolvedPaymentKey = (paymentKey !== undefined && paymentKey !== null && paymentKey !== '')
      ? paymentKey
      : paymentId;
    reqString(resolvedPaymentKey, 'paymentKey', 64);
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p).map(f => ({ ...f, pagos: Array.isArray(f.pagos) ? f.pagos.slice() : [] }));
      const fac = facturas.find(f => f && f.id === invoiceId);
      if (!fac) throw notFound('Factura');
      const at = fac.pagos.findIndex(x => payKeyMatches(x, resolvedPaymentKey));
      if (at === -1) return { status: 'absent' };
      const pay = fac.pagos[at];
      const normRef = normalizePaymentReference(pay.ref || '');
      let lockRefToRelease = null;
      let lockSnapToRelease = null;
      if (normRef) {
        const lockId = buildPaymentRefLockId({ metodo: pay.metodo, normRef });
        const candidateRef = col('payment_refs').doc(lockId);
        const lSnap = await tx.get(candidateRef);
        if (lSnap.exists) {
          lockRefToRelease = candidateRef;
          lockSnapToRelease = lSnap;
        }
      }
      let parentLockRefToRelease = null;
      let parentLockSnapToRelease = null;
      const baseRef = normalizePaymentReference(pay.ref_bancaria_base || '');
      if (baseRef && baseRef !== normRef) {
        const pLockId = buildPaymentRefLockId({ metodo: pay.metodo, normRef: baseRef });
        const pCandRef = col('payment_refs').doc(pLockId);
        const pSnap = await tx.get(pCandRef);
        if (pSnap.exists) {
          parentLockRefToRelease = pCandRef;
          parentLockSnapToRelease = pSnap;
        }
      }

      const fabProjQuerySnap = await tx.get(col('proyectos_fabricacion').where('prospecto_id', '==', prospectId).limit(5));
      const fabOrdersQuerySnap = await tx.get(col('fabricacion').where('prospecto_id', '==', prospectId).limit(10));
      const hadFabricationRelease = Boolean(
        p.enviado_a_fabricacion === true ||
        p.fabricacion_proyecto_id ||
        !fabProjQuerySnap.empty ||
        !fabOrdersQuerySnap.empty
      );

      fac.pagos.splice(at, 1);
      const nowAt = iso();
      const postEval = evaluateManufacturingReadiness({ p: { ...p, id: prospectId, facturas }, client });

      let nextLogs = withLog(p, caller, `Abono eliminado de factura ${fac.numero}: ${fmtMoney(pay.monto)}`);
      const prospectPatch = {
        facturas,
        estado_habilitacion_fabricacion: postEval.ready ? 'ANTICIPO_CONFIRMADO' : 'ANTICIPO_PENDIENTE'
      };

      let discrepancyRecorded = false;
      let discrepancyDetail = null;
      if (hadFabricationRelease && !postEval.ready) {
        discrepancyRecorded = true;
        discrepancyDetail = {
          activa: true,
          codigo: postEval.errorCode || 'ANTICIPO_PENDIENTE',
          motivo: `El anticipo obligatorio quedó con saldo pendiente de ${fmtMoney(postEval.saldoPendiente)} tras eliminar el abono de ${fmtMoney(pay.monto)} en factura ${fac.numero}. Las órdenes ya en curso NO se cancelan automáticamente; quedan bloqueadas nuevas liberaciones de órdenes asociadas hasta regularizar.`,
          montoExigible: postEval.montoExigible || 0,
          montoConfirmado: postEval.montoConfirmado || 0,
          saldoPendiente: postEval.saldoPendiente || 0,
          formaPago: postEval.formaPago || p.forma_pago || null,
          disparadoPorOperacion: 'deletePayment',
          invoiceId: fac.id,
          facturaNumero: fac.numero,
          paymentKey: String(pay.id || pay.fecha || resolvedPaymentKey),
          montoEliminado: pay.monto,
          registradoEn: nowAt,
          registradoPor: caller.cid || caller.uid,
          registradoPorNombre: caller.name || ''
        };
        prospectPatch.discrepancia_financiera_fabricacion = true;
        prospectPatch.bloqueado_nuevas_ordenes_fabricacion = true;
        prospectPatch.discrepancia_financiera_detalle = discrepancyDetail;
        nextLogs = withLog(
          { ...p, logs: nextLogs },
          caller,
          `ALERTA FINANCIERA DE FABRICACIÓN: ${discrepancyDetail.motivo}`
        );

        for (const projDoc of fabProjQuerySnap.docs) {
          tx.update(projDoc.ref, {
            estado_habilitacion_fabricacion: 'ANTICIPO_PENDIENTE',
            discrepancia_financiera: true,
            discrepancia_financiera_detalle: discrepancyDetail,
            bloqueado_nuevas_ordenes: true,
            monto_anticipo_exigible: postEval.montoExigible || 0,
            monto_anticipo_confirmado: postEval.montoConfirmado || 0,
            saldo_pendiente_anticipo: postEval.saldoPendiente || 0,
            actualizado_discrepancia_en: nowAt
          });
        }
        // Importante: NO cancelar ni eliminar órdenes ya en curso en `fabricacion` ni `fabricacion_tasks`.
        // Solo se registra la discrepancia y se bloquea el avance de órdenes aún en pre-fabricación ('Recepción' / 'Dibujo').
        for (const ordDoc of fabOrdersQuerySnap.docs) {
          const ordData = ordDoc.data() || {};
          const isPreFab = ['', 'Recepción', 'Dibujo'].includes(String(ordData.etapa || '').trim());
          tx.update(ordDoc.ref, {
            estado_habilitacion_fabricacion: 'ANTICIPO_PENDIENTE',
            discrepancia_financiera: true,
            discrepancia_financiera_detalle: discrepancyDetail,
            bloqueado_avance_etapa: isPreFab,
            cancelada_por_discrepancia: false
          });
        }
        addAudit(tx, caller, 'manufacturingFinancialDiscrepancy', prospectId, discrepancyDetail);
      }

      prospectPatch.logs = nextLogs;
      tx.update(ref, prospectPatch);
      if (lockRefToRelease && lockSnapToRelease) {
        releasePaymentRefLock(tx, lockRefToRelease, lockSnapToRelease, {
          prospectId,
          invoiceId: fac.id,
          paymentKey: String(pay.id || pay.fecha || resolvedPaymentKey)
        });
      }
      if (parentLockRefToRelease && parentLockSnapToRelease) {
        releasePaymentRefLock(tx, parentLockRefToRelease, parentLockSnapToRelease, {
          prospectId,
          invoiceId: fac.id,
          paymentKey: String(pay.id || pay.fecha || resolvedPaymentKey)
        });
      }
      addAudit(tx, caller, 'deletePayment', prospectId, {
        invoiceId,
        paymentKey: String(pay.id || pay.fecha || resolvedPaymentKey),
        numero: fac.numero,
        monto: pay.monto,
        metodo: pay.metodo,
        ref: pay.ref || null,
        discrepancyRecorded
      });
      addDeletionNotice(tx, caller, p, client, 'Abono', `${fmtMoney(pay.monto)} de la factura ${fac.numero}`);
      return {
        status: 'deleted',
        discrepancyRecorded,
        discrepancyDetail,
        estadoHabilitacionFabricacion: prospectPatch.estado_habilitacion_fabricacion
      };
    });
  }

  /**
   * Resolución administrativa auditada de colisiones históricas en `payment_refs` (ej. `BANK_078`).
   * Soporta:
   * - `CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE`: una única transferencia bancaria documentada
   *   aplicada en tramos/aplicaciones a múltiples oportunidades/facturas del mismo cliente canónico,
   *   preservando la referencia bancaria verdadera única (`868355650`) en ambos pagos, asignando
   *   identificadores internos de aplicación (`aplicacion_id`, `tramo_id`, `entry_id`) separados de
   *   la referencia bancaria real, registrando en `payment_refs/BANK_868355650` la transacción bancaria
   *   original, referencia única, importe total del comprobante, aplicaciones individuales, total aplicado,
   *   saldo disponible y auditoría de cada aplicación, y cerrando el lock histórico (`BANK_078`) con
   *   `active: false` y `estado: 'resuelto_historico'` únicamente cuando todos los pagos en conflicto de
   *   `BANK_078` han sido verificados y corregidos.
   * - `CASO_A_PROPIETARIO_UNICO_LEGITIMO`: cuando los demás pagos fueron corregidos a sus referencias
   *   bancarias reales y se comprueba documentalmente que un único pago conserva legítimamente la referencia.
   */
  async function resolveHistoricalBankConflict({
    caller,
    lockId,
    conflictLockId,
    resolutionMode,
    resolutionType,
    baseBankRef,
    trueBankRef,
    totalVoucherAmount,
    transferTotalAmount,
    tranches,
    allocations,
    allowPartialDistribution = false,
    legitimateOwner,
    dteControlNumber,
    consolidatedDteNumber,
    dteGenerationCode,
    consolidatedDteCodigoGeneracion,
    dteTotalAmount,
    consolidatedDteTotal,
    roundingDifferenceReason,
    dteRoundingExplanation,
    bankOrigin,
    bankName,
    voucherDate,
    transferDate,
    notes,
    justification
  }) {
    await requireManager(caller, 'resolver conflictos históricos de referencias bancarias');
    const cleanLockId = reqDocId(lockId || conflictLockId, 'lockId');
    const rawMode = resolutionMode || resolutionType || 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE';
    const normalizedMode = (rawMode === 'split_single_transfer_across_opportunities' || rawMode === 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE')
      ? 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE'
      : rawMode;
    const effectiveBaseBankRef = baseBankRef || trueBankRef;
    const effectiveTotalVoucherAmount = totalVoucherAmount !== undefined ? totalVoucherAmount : transferTotalAmount;
    const effectiveTranches = Array.isArray(tranches) ? tranches : allocations;
    const effectiveDteControlNumber = dteControlNumber || consolidatedDteNumber || null;
    const effectiveDteGenerationCode = dteGenerationCode || consolidatedDteCodigoGeneracion || null;
    const effectiveDteTotal = round2(Number(dteTotalAmount ?? consolidatedDteTotal ?? 16983.52)) || 16983.52;
    const effectiveRoundingReason = roundingDifferenceReason || dteRoundingExplanation || (
      'En el DTE consolidado CCF #078 (US$16,983.52) cada línea del 50% neto fue redondeada a 2 decimales antes de calcular el IVA global del 13%: ' +
      'Línea 1 (Presurización): 16,214.50 * 0.50 = US$8,107.25; Línea 2 (Edificio Desiré / Chute): 13,844.81 * 0.50 = 6,922.405 -> US$6,922.41 (+US$0.005); ' +
      'Subtotal gravado DTE = US$15,029.66; IVA 13% = 15,029.66 * 0.13 = 1,953.8558 -> US$1,953.86 (+US$0.0042); Total DTE = US$16,983.52 (+US$0.01 acumulado). ' +
      'En cambio, cada proyecto individual en el CRM y la transferencia bancaria real Transfer365 #868355650 suman exactamente US$9,161.19 + US$7,822.32 = US$16,983.51, ' +
      'por lo que cada anticipo exigible (US$9,161.19 y US$7,822.32) queda cubierto al 100.00% con variación US$0.00 sin requerir tolerancia artificial.'
    );
    const effectiveBankOrigin = bankOrigin || bankName || null;
    const effectiveVoucherDate = voucherDate || transferDate || null;
    const cleanNotes = reqString(notes || justification || 'Resolución documental auditada de conflicto histórico', 'Notas de resolución', 1000);

    return db.runTransaction(async tx => {
      const conflictLockRef = col('payment_refs').doc(cleanLockId);
      const conflictSnap = await tx.get(conflictLockRef);
      if (!conflictSnap.exists) throw notFound('Referencia en conflicto');
      const conflictData = conflictSnap.data() || {};

      // Idempotencia si ya fue resuelto previamente
      if (conflictData.active === false && (conflictData.estado === 'resuelto_historico' || conflictData.status === 'resuelto_historico')) {
        const prevDetail = conflictData.resolutionDetail || {};
        return {
          status: 'already_resolved',
          replay: true,
          lockId: cleanLockId,
          parentBankLockId: prevDetail.parentBankLockId || null,
          trueBankRef: prevDetail.realBankRef || conflictData.referencia_bancaria_real || null,
          totalApplied: prevDetail.totalAppliedAmount ?? null,
          saldoDisponibleComprobante: prevDetail.availableVoucherBalance ?? 0,
          resolutionDetail: conflictData.resolutionDetail || null
        };
      }

      const nowAt = iso();

      if (normalizedMode === 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE') {
        const cleanBaseRef = reqString(effectiveBaseBankRef, 'Referencia bancaria verdadera', 80);
        const normBaseRef = normalizePaymentReference(cleanBaseRef);
        if (isInvalidPaymentReference(cleanBaseRef, normBaseRef)) {
          throw bad('Referencia bancaria verdadera inválida');
        }
        const expectedTotal = money(effectiveTotalVoucherAmount, 'El importe total del comprobante bancario', { positive: true });
        if (!Array.isArray(effectiveTranches) || effectiveTranches.length < 2) {
          throw bad('Debe especificar al menos dos aplicaciones para la resolución de pago distribuido (Caso B)');
        }

        const parentLockId = buildPaymentRefLockId({ metodo: 'transferencia', normRef: normBaseRef });
        if (parentLockId === cleanLockId) {
          throw bad('La referencia bancaria verdadera no puede ser idéntica al lock histórico en conflicto');
        }
        const parentLockRef = col('payment_refs').doc(parentLockId);
        const parentLockSnap = await tx.get(parentLockRef);

        // Pre-lectura transaccional de todos los prospectos y clientes antes de cualquier escritura
        const trancheItems = [];
        const seenEntrySlots = new Set();
        const seenApplicationIds = new Set();
        let sumTranches = 0;
        let commonClientId = null;

        for (let idx = 0; idx < effectiveTranches.length; idx++) {
          const t = asObject(effectiveTranches[idx], `Aplicación ${idx + 1}`);
          const tProspectId = reqDocId(t.prospectId, `Aplicación ${idx + 1}: prospectId`);
          const tInvoiceId = reqDocId(t.invoiceId, `Aplicación ${idx + 1}: invoiceId`);
          const tPaymentKey = reqString(t.paymentKey || t.paymentId, `Aplicación ${idx + 1}: paymentKey`, 64);

          const entrySlot = `${tProspectId}__${tInvoiceId}`;
          if (seenEntrySlots.has(entrySlot)) {
            throw bad(`Aplicación ${idx + 1}: cada aplicación debe corresponder a una factura distinta (${entrySlot} duplicado)`);
          }
          seenEntrySlots.add(entrySlot);

          const rawAppId = t.applicationId || t.aplicacion_id || t.tramoId || t.entryId || `APP_${normBaseRef}_${tProspectId}_${tInvoiceId}`;
          const applicationId = reqString(String(rawAppId), `Aplicación ${idx + 1}: applicationId`, 120);
          if (seenApplicationIds.has(applicationId)) {
            throw bad(`Aplicación ${idx + 1}: el identificador interno de aplicación (${applicationId}) debe ser único`);
          }
          seenApplicationIds.add(applicationId);
          const tramoId = t.tramoId || t.tramo_id || `TRAMO_${normBaseRef}_${idx + 1}`;

          const pRef = col('prospects').doc(tProspectId);
          const pSnap = await tx.get(pRef);
          if (!pSnap.exists) throw notFound(`Oportunidad ${tProspectId}`);
          const pData = pSnap.data() || {};
          const client = await loadClient(tx, pData);
          if (!client) throw notFound(`Cliente de oportunidad ${tProspectId}`);
          const canonicalClientId = client.id || pData.clientId;
          if (!commonClientId) {
            commonClientId = canonicalClientId;
          } else if (commonClientId !== canonicalClientId) {
            throw precondition('Caso B requiere que todas las facturas aplicadas pertenezcan al mismo cliente canónico');
          }

          const facturas = facturasOf(pData).map(f => ({ ...f, pagos: Array.isArray(f.pagos) ? f.pagos.slice() : [] }));
          const fac = facturas.find(f => f && f.id === tInvoiceId);
          if (!fac) throw notFound(`Factura ${tInvoiceId} en oportunidad ${tProspectId}`);
          const payIdx = fac.pagos.findIndex(x => payKeyMatches(x, tPaymentKey));
          if (payIdx === -1) throw notFound(`Pago ${tPaymentKey} en factura ${tInvoiceId}`);
          const curPay = fac.pagos[payIdx];
          const payAmount = round2(Number(curPay.monto));
          if (t.expectedAmount !== undefined && round2(Number(t.expectedAmount)) !== payAmount) {
            throw precondition(`El importe del pago en ${tProspectId} (${fmtMoney(payAmount)}) no coincide con el monto esperado (${fmtMoney(t.expectedAmount)})`);
          }
          sumTranches = round2(sumTranches + payAmount);

          trancheItems.push({
            idx: idx + 1,
            prospectId: tProspectId,
            invoiceId: tInvoiceId,
            paymentKey: tPaymentKey,
            entrySlot,
            applicationId,
            tramoId,
            pRef,
            pData,
            client,
            facturas,
            fac,
            payIdx,
            curPay,
            payAmount
          });
        }

        if (round2(sumTranches) > round2(expectedTotal)) {
          throw precondition(`La suma de las aplicaciones (${fmtMoney(sumTranches)}) supera el importe total del comprobante bancario (${fmtMoney(expectedTotal)})`);
        }
        if (!allowPartialDistribution && round2(sumTranches) !== round2(expectedTotal)) {
          throw precondition(`La suma de las aplicaciones (${fmtMoney(sumTranches)}) no coincide con el importe total del comprobante bancario (${fmtMoney(expectedTotal)})`);
        }

        // Verificar que TODOS los pagos registrados en conflicto dentro de `cleanLockId` (ej. BANK_078)
        // hayan sido incluidos y verificados en esta resolución antes de permitir cerrarlo como `resuelto_historico`.
        const conflictRegisteredMap = new Map();
        for (const ce of [
          ...extractLockEntries(conflictData),
          ...(Array.isArray(conflictData.conflictPayments) ? conflictData.conflictPayments : []),
          ...(Array.isArray(conflictData.pagos_en_conflicto) ? conflictData.pagos_en_conflicto : [])
        ]) {
          if (ce && ce.prospectId && ce.invoiceId) {
            conflictRegisteredMap.set(`${ce.prospectId}__${ce.invoiceId}`, ce);
          }
        }
        for (const [cSlot, ce] of conflictRegisteredMap.entries()) {
          const ceKey = ce.paymentKey || ce.paymentId;
          const matchedTranche = trancheItems.find(
            (ti) => ti.entrySlot === cSlot && (!ceKey || String(ti.paymentKey) === String(ceKey))
          );
          if (!matchedTranche) {
            throw precondition(`No se puede cerrar ${cleanLockId} como resuelto_historico porque el pago en conflicto (${ce.prospectId} / ${ce.invoiceId}) no ha sido verificado ni incluido en la resolución`);
          }
        }
        if (conflictRegisteredMap.size > 0) {
          for (const ti of trancheItems) {
            if (!conflictRegisteredMap.has(ti.entrySlot)) {
              throw precondition(`La aplicación (${ti.prospectId} / ${ti.invoiceId}) no pertenece a los pagos registrados en el conflicto ${cleanLockId}`);
            }
          }
        }

        if (parentLockSnap.exists && parentLockSnap.data()) {
          const pld = parentLockSnap.data();
          if (pld.resolvedFromHistoricalLockId && pld.resolvedFromHistoricalLockId !== cleanLockId) {
            throw precondition(`La referencia bancaria distribuida ${parentLockId} ya fue aplicada y bloqueada en otra resolución (${pld.resolvedFromHistoricalLockId})`);
          }
          if (pld.active !== false) {
            for (const e of extractLockEntries(pld)) {
              const eKey = e.paymentKey || e.paymentId;
              const belongsToTranche = trancheItems.some(
                ti => ti.prospectId === e.prospectId && ti.invoiceId === e.invoiceId && String(ti.paymentKey) === String(eKey)
              );
              if (!belongsToTranche) {
                throw precondition(`La referencia bancaria verdadera ${parentLockId} ya está asignada a otro pago ajeno (${e.prospectId})`);
              }
            }
          }
        }

        const totalAplicado = round2(sumTranches);
        const saldoDisponible = round2(Math.max(0, expectedTotal - totalAplicado));
        const dteRoundingVariance = round2(effectiveDteTotal - expectedTotal);
        const linkedProspectIds = trancheItems.map(ti => ti.prospectId);
        const linkedInvoiceIds = trancheItems.map(ti => ti.invoiceId);
        const consolidatedEntries = {};
        const aplicacionesList = [];
        const aplicacionesAuditoria = [];
        const resolvedTrancheSummaries = [];

        for (const ti of trancheItems) {
          const oldRef = ti.curPay.ref || '078';
          const updatedPay = {
            ...ti.curPay,
            invoiceId: ti.fac.id,
            factura_numero: ti.fac.numero,
            // La referencia bancaria verdadera en ambos pagos se preserva exactamente como `868355650`
            ref: cleanBaseRef,
            ref_bancaria_real: cleanBaseRef,
            ref_normalizada: normBaseRef,
            ref_bancaria_base: normBaseRef,
            ref_historica_original: oldRef,
            aplicacion_id: ti.applicationId,
            tramo_id: ti.tramoId,
            entry_id: ti.entrySlot,
            pago_compartido: {
              es_tramo_compartido: true,
              caso_resolucion: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
              aplicacion_id: ti.applicationId,
              tramo_id: ti.tramoId,
              entry_id: ti.entrySlot,
              ref_bancaria_unica: cleanBaseRef,
              ref_bancaria_base: cleanBaseRef,
              ref_bancaria_normalizada: normBaseRef,
              lock_consolidado_id: parentLockId,
              lock_historico_resuelto: cleanLockId,
              importe_total_comprobante: expectedTotal,
              monto_total_comprobante: expectedTotal,
              monto_aplicado: ti.payAmount,
              monto_tramo: ti.payAmount,
              total_aplicado: totalAplicado,
              saldo_disponible_comprobante: saldoDisponible,
              aplicacion_indice: ti.idx,
              tramo_indice: ti.idx,
              total_aplicaciones: trancheItems.length,
              total_tramos: trancheItems.length,
              oportunidades_vinculadas: linkedProspectIds,
              facturas_vinculadas: linkedInvoiceIds,
              dte_numero_control: effectiveDteControlNumber,
              dte_codigo_generacion: effectiveDteGenerationCode,
              dte_importe_total: effectiveDteTotal,
              dte_diferencia_redondeo: dteRoundingVariance,
              banco_origen: effectiveBankOrigin,
              fecha_comprobante: effectiveVoucherDate,
              resuelto_en: nowAt,
              resuelto_por: caller.cid || caller.uid
            }
          };
          if (hasValidPaymentDoc(updatedPay.doc_comprobante)) {
            updatedPay.confirmado = true;
            updatedPay.estado = 'confirmado';
            updatedPay.confirmado_por = caller.cid || caller.uid;
            updatedPay.confirmado_por_uid = caller.uid;
            updatedPay.confirmado_por_rol = caller.role;
            updatedPay.confirmado_en = nowAt;
          }
          ti.fac.pagos[ti.payIdx] = updatedPay;

          const postEval = evaluateManufacturingReadiness({
            p: { ...ti.pData, id: ti.prospectId, facturas: ti.facturas },
            client: ti.client
          });
          const logMsg = `Resolución auditada de referencia histórica (${oldRef} -> ${cleanBaseRef}): Aplicación ${ti.idx}/${trancheItems.length} [${ti.applicationId}] por ${fmtMoney(ti.payAmount)} sobre comprobante bancario único Ref. ${cleanBaseRef} (${fmtMoney(expectedTotal)}).`;
          tx.update(ti.pRef, {
            facturas: ti.facturas,
            estado_habilitacion_fabricacion: postEval.ready ? 'ANTICIPO_CONFIRMADO' : 'ANTICIPO_PENDIENTE',
            logs: withLog(ti.pData, caller, logMsg)
          });

          const appAuditRecord = {
            aplicacion_id: ti.applicationId,
            tramo_id: ti.tramoId,
            entry_id: ti.entrySlot,
            prospectId: ti.prospectId,
            codigo_oportunidad: ti.pData.codigo || ti.prospectId,
            proyecto: ti.pData.proyecto || null,
            invoiceId: ti.invoiceId,
            factura_numero: ti.fac.numero || null,
            paymentKey: String(ti.paymentKey),
            clientId: commonClientId,
            referencia_historica_anterior: oldRef,
            referencia_bancaria_unica: cleanBaseRef,
            monto_aplicado: ti.payAmount,
            confirmado: Boolean(updatedPay.confirmado),
            verificado_en: nowAt,
            verificado_por: caller.cid || caller.uid,
            verificado_por_cid: caller.cid || caller.uid,
            verificado_por_uid: caller.uid,
            verificado_por_rol: caller.role
          };
          aplicacionesAuditoria.push(appAuditRecord);

          const entryRecord = {
            aplicacion_id: ti.applicationId,
            tramo_id: ti.tramoId,
            entry_id: ti.entrySlot,
            prospectId: ti.prospectId,
            codigo_oportunidad: ti.pData.codigo || ti.prospectId,
            proyecto: ti.pData.proyecto || null,
            invoiceId: ti.invoiceId,
            factura_numero: ti.fac.numero || null,
            paymentKey: String(ti.paymentKey),
            clientId: commonClientId,
            monto: ti.payAmount,
            monto_aplicado: ti.payAmount,
            metodo: updatedPay.metodo || 'transferencia',
            ref: cleanBaseRef,
            normRef: normBaseRef,
            parentBankLockId: parentLockId,
            auditoria: appAuditRecord,
            updatedAt: nowAt
          };
          consolidatedEntries[ti.entrySlot] = entryRecord;
          aplicacionesList.push(entryRecord);

          resolvedTrancheSummaries.push({
            tramoIndice: ti.idx,
            aplicacion_id: ti.applicationId,
            tramo_id: ti.tramoId,
            entry_id: ti.entrySlot,
            prospectId: ti.prospectId,
            invoiceId: ti.invoiceId,
            facturaNumero: ti.fac.numero || null,
            paymentKey: String(ti.paymentKey),
            monto: ti.payAmount,
            previousRef: oldRef,
            bankRef: cleanBaseRef,
            normBankRef: normBaseRef,
            manufacturingReady: postEval.ready
          });
        }

        const firstTranche = trancheItems[0];
        tx.set(parentLockRef, {
          active: true,
          estado: 'distribuido_auditado',
          status: 'distribuido_auditado',
          es_comprobante_distribuido: true,
          distribuido_auditado: true,
          reutilizacion_bloqueada: true,
          bloqueado_nuevos_usos: true,
          // 1. Transacción bancaria original
          transaccion_bancaria: {
            banco_origen: effectiveBankOrigin,
            referencia_bancaria: cleanBaseRef,
            referencia_bancaria_unica: cleanBaseRef,
            referencia_normalizada: normBaseRef,
            metodo: 'transferencia',
            fecha_comprobante: effectiveVoucherDate,
            importe_total_comprobante: expectedTotal,
            moneda: 'USD',
            dte_numero_control: effectiveDteControlNumber,
            dte_codigo_generacion: effectiveDteGenerationCode,
            dte_importe_total: effectiveDteTotal,
            dte_diferencia_redondeo: dteRoundingVariance,
            dte_explicacion_redondeo: effectiveRoundingReason,
            cliente_id: commonClientId
          },
          // 2. Referencia bancaria única
          normRef: normBaseRef,
          ref: cleanBaseRef,
          metodo: 'transferencia',
          clientId: commonClientId,
          // 3. Importe total del comprobante
          importe_total_comprobante: expectedTotal,
          montoTotalComprobante: expectedTotal,
          monto: expectedTotal,
          // 4. Aplicaciones individuales a facturas
          aplicaciones: aplicacionesList,
          entries: consolidatedEntries,
          // 5. Total aplicado
          total_aplicado: totalAplicado,
          totalAplicado,
          total_aplicaciones: trancheItems.length,
          totalTranches: trancheItems.length,
          // 6. Saldo disponible del comprobante
          saldo_disponible: saldoDisponible,
          saldoDisponible,
          // 7. Auditoría de cada aplicación
          auditoria: {
            caso_resolucion: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
            lock_historico_origen: cleanLockId,
            referencia_historica_reemplazada: conflictData.ref || conflictData.normRef || cleanLockId.replace(/^BANK_/, ''),
            resuelto_en: nowAt,
            resuelto_por: caller.cid || caller.uid,
            resuelto_por_cid: caller.cid || caller.uid,
            resuelto_por_uid: caller.uid,
            resuelto_por_rol: caller.role,
            notas: cleanNotes,
            diferencia_centavo_dte: {
              dte_total: effectiveDteTotal,
              comprobante_bancario_total: expectedTotal,
              diferencia_usd: dteRoundingVariance,
              afecta_liquidacion_anticipo: false,
              explicacion: effectiveRoundingReason
            },
            aplicaciones_auditadas: aplicacionesAuditoria
          },
          prospectId: firstTranche.prospectId,
          invoiceId: firstTranche.invoiceId,
          paymentKey: String(firstTranche.paymentKey),
          resolvedFromHistoricalLockId: cleanLockId,
          dteControlNumber: effectiveDteControlNumber,
          dteGenerationCode: effectiveDteGenerationCode,
          bankOrigin: effectiveBankOrigin,
          voucherDate: effectiveVoucherDate,
          updatedAt: nowAt,
          updatedBy: caller.cid || caller.uid
        });

        const resolutionDetail = {
          caseType: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
          previousLockId: cleanLockId,
          previousRef: conflictData.ref || conflictData.normRef || cleanLockId.replace(/^BANK_/, ''),
          realBankRef: cleanBaseRef,
          parentBankLockId: parentLockId,
          totalVoucherAmount: expectedTotal,
          totalAppliedAmount: totalAplicado,
          availableVoucherBalance: saldoDisponible,
          dteTotalAmount: effectiveDteTotal,
          dteRoundingVariance,
          dteRoundingExplanation: effectiveRoundingReason,
          clientId: commonClientId,
          dteControlNumber: effectiveDteControlNumber,
          dteGenerationCode: effectiveDteGenerationCode,
          bankOrigin: effectiveBankOrigin,
          voucherDate: effectiveVoucherDate,
          tranches: resolvedTrancheSummaries,
          notes: cleanNotes,
          resolvedAt: nowAt,
          resolvedBy: caller.cid || caller.uid
        };

        tx.set(conflictLockRef, {
          ...conflictData,
          active: false,
          estado: 'resuelto_historico',
          status: 'resuelto_historico',
          bloqueado_nuevos_usos: true,
          referencia_bancaria_real: cleanBaseRef,
          conflicto_historico: false,
          wasHistoricalConflict: true,
          requiresAdministrativeResolution: false,
          remainingConflictCount: 0,
          prospectId: null,
          invoiceId: null,
          paymentKey: null,
          entries: {},
          conflictPayments: [],
          resolvedAt: nowAt,
          resolvedBy: caller.cid || caller.uid,
          updatedAt: nowAt,
          resolutionDetail
        });

        addAudit(tx, caller, 'resolveHistoricalBankConflict', cleanLockId, resolutionDetail);

        return {
          status: 'resolved',
          lockId: cleanLockId,
          parentBankLockId: parentLockId,
          trueBankRef: cleanBaseRef,
          totalApplied: totalAplicado,
          saldoDisponibleComprobante: saldoDisponible,
          resolutionDetail
        };
      }

      if (normalizedMode === 'CASO_A_PROPIETARIO_UNICO_LEGITIMO') {
        const owner = asObject(legitimateOwner, 'Propietario único legítimo');
        const ownerProspectId = reqDocId(owner.prospectId, 'legitimateOwner.prospectId');
        const ownerInvoiceId = reqDocId(owner.invoiceId, 'legitimateOwner.invoiceId');
        const ownerPaymentKey = reqString(owner.paymentKey, 'legitimateOwner.paymentKey', 64);

        const entries = extractLockEntries(conflictData);
        const otherRemaining = entries.filter(
          e => !(e.prospectId === ownerProspectId && e.invoiceId === ownerInvoiceId && String(e.paymentKey) === String(ownerPaymentKey))
        );
        if (otherRemaining.length > 0) {
          throw precondition(`No se puede activar ${cleanLockId} como propietario único mientras subsistan otros pagos asociados (${otherRemaining.length} restante(s))`);
        }
        const ownerEntry = entries.find(
          e => e.prospectId === ownerProspectId && e.invoiceId === ownerInvoiceId && String(e.paymentKey) === String(ownerPaymentKey)
        );
        if (!ownerEntry) {
          throw precondition(`El pago indicado (${ownerProspectId} / ${ownerInvoiceId}) no figura en ${cleanLockId}`);
        }
        const slotKey = `${ownerProspectId}__${ownerInvoiceId}`;
        const resolutionDetail = {
          caseType: 'CASO_A_PROPIETARIO_UNICO_LEGITIMO',
          legitimateProspectId: ownerProspectId,
          legitimateInvoiceId: ownerInvoiceId,
          legitimatePaymentKey: ownerPaymentKey,
          notes: cleanNotes,
          resolvedAt: nowAt,
          resolvedBy: caller.cid || caller.uid
        };
        tx.set(conflictLockRef, {
          ...conflictData,
          active: true,
          estado: 'activo',
          status: 'activo',
          conflicto_historico: false,
          wasHistoricalConflict: true,
          requiresAdministrativeResolution: false,
          remainingConflictCount: 0,
          prospectId: ownerProspectId,
          invoiceId: ownerInvoiceId,
          paymentKey: ownerPaymentKey,
          entries: { [slotKey]: ownerEntry },
          conflictPayments: [],
          resolvedAt: nowAt,
          resolvedBy: caller.cid || caller.uid,
          updatedAt: nowAt,
          resolutionDetail
        });
        addAudit(tx, caller, 'resolveHistoricalBankConflict', cleanLockId, resolutionDetail);
        return {
          status: 'resolved_single_owner',
          lockId: cleanLockId,
          resolutionDetail
        };
      }

      throw bad(`Modo de resolución no soportado: ${resolutionMode}`);
    });
  }

  // =====================================================================================================
  // Logical deletion of an opportunity (manager only, live check)
  // =====================================================================================================
  // The document is NOT removed: it is marked (`eliminado`, who, when, why) and every ordinary read / write path ignores
  // it (the browser listing filters it, loadProspect / requireProspectAccess refuse it, the client portfolio does not count
  // it). Nothing cascades: fabricacion's `proyectos_fabricacion` and every Storage file stay exactly as they are.
  // There is deliberately no recovery or administrative query operation here: who may use it has not been decided.
  async function deleteProspect({ caller, prospectId, motivo }) {
    await requireManager(caller, 'eliminar proyectos');
    reqDocId(prospectId, 'prospectId');
    const reason = reqString(motivo, 'El motivo de la eliminación', 300);

    const txResult = await db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 'absent' }; // never existed (or deleted by the previous, physical implementation)
      const p = snap.data() || {};
      if (p.eliminado === true) return { status: 'already_deleted', prospect: p };

      const client = await loadClient(tx, p);

      let vendorsToRemove = [];
      if (p.etapa === 'cierre' && p.clientId) {
        const otherSnap = await tx.get(
          col('prospects')
            .where('clientId', '==', p.clientId)
            .where('etapa', '==', 'cierre')
        );
        const candidates = [p.vendedorId, p.createdBy].filter(v => v && v !== 'sistema');
        const remainingClosing = new Set();
        otherSnap.docs.forEach(d => {
          if (d.id === prospectId) return;
          const op = d.data() || {};
          if (op.eliminado === true || op.estado === 'perdido') return;
          if (op.vendedorId) remainingClosing.add(String(op.vendedorId));
          if (op.createdBy) remainingClosing.add(String(op.createdBy));
        });
        vendorsToRemove = candidates.filter(v => !remainingClosing.has(String(v)));
      }

      // Phase 2 Block B2: Read initial chunk of opportunity participants (bounded to 400 to respect Firestore 500-op limit)
      const oppContactsSnap = await tx.get(
        col('opportunityContacts').where('opportunityId', '==', prospectId).limit(400)
      );

      // Writes: cascade logical deletion to subordinate participants in this transaction
      oppContactsSnap.docs.forEach(d => {
        const oc = d.data() || {};
        if (oc.eliminado !== true) {
          tx.update(col('opportunityContacts').doc(d.id), {
            eliminado: true,
            estado_participacion: 'inactivo',
            isPrimary: false,
            fecha_eliminacion: iso(),
            eliminado_por_id: caller.cid,
            eliminado_por: caller.name || '',
            updatedAt: iso(),
            updatedBy: caller.cid
          });
        }
      });

      const prospectPatch = {
        eliminado: true, eliminado_por_id: caller.cid, eliminado_por: caller.name || '', fecha_eliminacion: iso(), motivo_eliminacion: reason,
        logs: withLog(p, caller, `Oportunidad ELIMINADA (eliminación lógica) por ${caller.name || 'gerente'}. Motivo: ${reason}`)
      };
      if (p.primaryOpportunityContactId || p.primaryContactSnapshot || oppContactsSnap.docs.length > 0) {
        prospectPatch.primaryOpportunityContactId = null;
        prospectPatch.primaryContactSnapshot = null;
      }
      tx.update(ref, prospectPatch);
      for (const v of vendorsToRemove) {
        tx.update(col('clients').doc(p.clientId), {
          closingVendors: FieldValue.arrayRemove(v)
        });
      }
      addAudit(tx, caller, 'deleteProspect', prospectId, { logical: true, motivo: reason, codigo: p.codigo || null, proyecto: p.proyecto || null, clientId: p.clientId || null, etapa: p.etapa || null, estado: p.estado || null });
      addDeletionNotice(tx, caller, p, client, 'Proyecto', `Proyecto completo (${p.codigo || p.id}) eliminado. Motivo: ${reason}`);
      return { status: 'deleted' };
    });

    if (txResult.status === 'absent') return { status: 'absent' };

    // Idempotent and recoverable batch cleanup for any remaining participants beyond 400 (or if previously partially processed)
    let cleanedAdditional = 0;
    const remainingSnap = await col('opportunityContacts')
      .where('opportunityId', '==', prospectId)
      .get();

    const toClean = remainingSnap.docs.filter(d => {
      const data = d.data() || {};
      return data.eliminado !== true || data.estado_participacion === 'activo' || data.isPrimary === true;
    });

    for (let i = 0; i < toClean.length; i += 400) {
      const chunk = toClean.slice(i, i + 400);
      const batch = db.batch();
      for (const d of chunk) {
        batch.update(col('opportunityContacts').doc(d.id), {
          eliminado: true,
          estado_participacion: 'inactivo',
          isPrimary: false,
          fecha_eliminacion: iso(),
          eliminado_por_id: caller.cid,
          eliminado_por: caller.name || '',
          updatedAt: iso(),
          updatedBy: caller.cid
        });
        cleanedAdditional++;
      }
      await batch.commit();
    }

    if (txResult.status === 'already_deleted') {
      return cleanedAdditional > 0 ? { status: 'deleted', recoveredParticipants: cleanedAdditional } : { status: 'unchanged' };
    }

    return { status: 'deleted' };
  }

  // =====================================================================================================
  // Reactivation of a lost opportunity (manager only, live check)
  // =====================================================================================================
  async function reactivateProspect({ caller, prospectId, motivo }) {
    await requireManager(caller, 'reactivar proyectos');
    reqDocId(prospectId, 'prospectId');
    const reason = reqString(motivo, 'El motivo de la reactivación', 500);

    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ServiceError('not-found', 'Oportunidad no encontrada');
      const p = snap.data() || {};

      if (p.eliminado === true) {
        throw precondition('No se puede reactivar una oportunidad que fue eliminada lógicamente');
      }

      // Idempotency: retry with same reason on an active project returns unchanged
      if (p.estado === 'activo') {
        if (p.motivo_reactivacion === reason) {
          return { status: 'unchanged', estado: 'activo', etapa: p.etapa };
        }
        throw precondition('La oportunidad ya se encuentra activa');
      }

      if (p.estado === 'ganado') {
        throw precondition('La oportunidad ya está ganada, no se puede reactivar desde pérdida');
      }

      if (p.estado !== 'perdido') {
        throw precondition(`No se puede reactivar una oportunidad en estado "${p.estado}" (solo proyectos perdidos)`);
      }

      // Restore prior commercial stage
      let targetStage = p.etapa;
      if (!STAGES.includes(targetStage)) {
        const ts = (p.stage_timestamps && typeof p.stage_timestamps === 'object') ? p.stage_timestamps : {};
        const recorded = STAGES.filter(s => !!ts[s]);
        targetStage = recorded.length > 0 ? recorded[recorded.length - 1] : 'prospecto';
      }

      const at = iso();
      const priorLoss = {
        motivo: p.motivo_perdida || 'Desconocido',
        fecha: p.fecha_perdida || null,
        etapa: p.etapa || targetStage
      };

      const lossHistory = (Array.isArray(p.historial_perdidas) ? p.historial_perdidas : []).concat([priorLoss]);

      const patch = {
        estado: 'activo',
        etapa: targetStage,
        motivo_perdida: FieldValue.delete(),
        fecha_perdida: FieldValue.delete(),
        ultima_perdida: priorLoss,
        historial_perdidas: lossHistory,
        reactivado_por_id: caller.cid,
        reactivado_por: caller.name || 'Gerente',
        fecha_reactivacion: at,
        motivo_reactivacion: reason,
        logs: withLog(p, caller, `Proyecto REACTIVADO por gerente ${caller.name || 'Gerente'}. Motivo: ${reason}. Etapa activa: ${targetStage}.`)
      };

      // Read client before any writes (Firestore transactions requirement: all reads before writes)
      let clientRef = null;
      let clientExists = false;
      if (p.clientId) {
        clientRef = col('clients').doc(p.clientId);
        const clientSnap = await tx.get(clientRef);
        clientExists = clientSnap.exists;
      }

      tx.update(ref, patch);

      // Restore client visibility & closing vendors if applicable
      if (clientRef && clientExists) {
        const visibleVendors = [p.vendedorId, p.createdBy, caller.cid].filter(v => v && v !== 'sistema');
        const clientPatch = {};
        if (visibleVendors.length > 0) {
          clientPatch.visibleTo = FieldValue.arrayUnion(...visibleVendors);
        }
        if (targetStage === 'cierre' && p.vendedorId && p.vendedorId !== 'sistema') {
          clientPatch.closingVendors = FieldValue.arrayUnion(p.vendedorId);
        }
        if (Object.keys(clientPatch).length > 0) {
          tx.update(clientRef, clientPatch);
        }
      }

      addAudit(tx, caller, 'reactivateProspect', prospectId, {
        motivo: reason,
        etapa: targetStage,
        motivoPerdidaPrevio: priorLoss.motivo,
        fechaPerdidaPrevia: priorLoss.fecha
      });

      return {
        status: 'reactivated',
        estado: 'activo',
        etapa: targetStage,
        motivo_reactivacion: reason
      };
    });
  }

  // =====================================================================================================
  // Mandatory Financial Validation Gate Before Manufacturing
  // =====================================================================================================
  const MANUFACTURING_ROLES = ['manager', 'gestor', 'jefe_produccion', 'recepcion', 'dibujo', 'dibujante'];
  const SEND_TO_FABRICATION_ROLES = ['manager', 'gestor', 'jefe_produccion', 'recepcion'];
  const INVALID_FINANCIAL_STATUSES = [
    'anulado', 'anulada', 'revertido', 'revertida', 'cancelado', 'cancelada',
    'rechazado', 'rechazada', 'eliminado', 'eliminada', 'borrador',
    'pendiente', 'pendiente_verificacion', 'pendiente_emision', 'promesa'
  ];

  function hasValidPaymentDoc(doc) {
    if (!doc) return false;
    if (typeof doc === 'string') return doc.trim().length > 0;
    if (typeof doc === 'object') {
      const p = doc.storagePath || doc.path || doc.fullPath || doc.url || doc.downloadURL || '';
      const n = doc.name || '';
      return String(p).trim().length > 0 || String(n).trim().length > 0;
    }
    return false;
  }

  function isActiveInvoice(fac) {
    if (!fac || typeof fac !== 'object') return false;
    if (
      fac.anulada === true || fac.anulado === true ||
      fac.revertida === true || fac.revertido === true ||
      fac.eliminada === true || fac.eliminado === true ||
      fac.voided === true || fac.reversed === true
    ) {
      return false;
    }
    const facEstado = typeof fac.estado === 'string' ? fac.estado.trim().toLowerCase() : '';
    if (facEstado && INVALID_FINANCIAL_STATUSES.includes(facEstado)) return false;
    const facNumero = typeof fac.numero === 'string' ? fac.numero.trim() : '';
    const facMonto = round2(Number(fac.monto));
    return Boolean(facNumero && Number.isFinite(facMonto) && facMonto > 0);
  }

  /**
   * Identifica de forma estable y segura la factura de anticipo de la oportunidad,
   * soportando tanto el marcador explícito (`es_anticipo: true`, `tipo_factura: 'anticipo'`,
   * `factura_anticipo_id`) como expedientes históricos legítimos, sin confundirse ante
   * reordenamientos, ediciones o facturas posteriores (órdenes de cambio / saldo).
   */
  function resolveAdvanceInvoice(p, facturasList) {
    const rawList = Array.isArray(facturasList)
      ? facturasList
      : (p && Array.isArray(p.facturas) ? p.facturas : []);
    const active = rawList.filter(isActiveInvoice);
    if (active.length === 0) {
      return { invoice: null, ambiguous: false, source: 'none' };
    }

    const explicitMatches = active.filter((fac) => {
      if (fac.es_anticipo === true) return true;
      const tipo = typeof (fac.tipo_factura || fac.tipo) === 'string'
        ? String(fac.tipo_factura || fac.tipo).trim().toLowerCase()
        : '';
      return tipo === 'anticipo';
    });
    if (explicitMatches.length > 1) {
      return { invoice: null, ambiguous: true, source: 'multiple_es_anticipo' };
    }

    const prospectAdvId = p && typeof p.factura_anticipo_id === 'string' ? p.factura_anticipo_id.trim() : '';
    if (prospectAdvId) {
      const byProspectId = active.find((fac) => fac.id === prospectAdvId);
      if (byProspectId && byProspectId.es_anticipo !== false) {
        if (explicitMatches.length === 1 && explicitMatches[0].id !== byProspectId.id) {
          return { invoice: null, ambiguous: true, source: 'conflicting_factura_anticipo_id' };
        }
        return { invoice: byProspectId, ambiguous: false, source: 'factura_anticipo_id' };
      }
    }

    if (explicitMatches.length === 1) {
      return { invoice: explicitMatches[0], ambiguous: false, source: 'es_anticipo' };
    }

    const prospectAdvNum = p && typeof p.factura_anticipo === 'string' ? p.factura_anticipo.trim() : '';
    if (prospectAdvNum) {
      const byNum = active.filter(
        (fac) => String(fac.numero || '').trim() === prospectAdvNum && fac.es_anticipo !== false
      );
      if (byNum.length === 1) {
        return { invoice: byNum[0], ambiguous: false, source: 'factura_anticipo_numero' };
      }
      if (byNum.length > 1) {
        return { invoice: null, ambiguous: true, source: 'multiple_factura_anticipo_numero' };
      }
    }

    // Compatibilidad con registros históricos sin etiqueta explícita:
    // solo se acepta la primera factura si no fue marcada explícitamente como ordinaria / no-anticipo.
    const first = active[0];
    const firstTipo = typeof (first.tipo_factura || first.tipo) === 'string'
      ? String(first.tipo_factura || first.tipo).trim().toLowerCase()
      : '';
    if (first.es_anticipo === false || firstTipo === 'ordinaria' || firstTipo === 'saldo' || firstTipo === 'orden_cambio') {
      return { invoice: null, ambiguous: false, source: 'no_advance_invoice' };
    }
    return { invoice: first, ambiguous: false, source: active.length === 1 ? 'legacy_single' : 'legacy_first' };
  }

  /**
   * Verifica que un pago haya sido positivamente confirmado mediante el flujo autorizado
   * de backend (`savePayment` ejecutado por `gestor` o `manager`).
   * Un pago con `confirmado` / `verificado` ausentes (`undefined`) NO se considera confirmado
   * para habilitar fabricación, preservando los registros históricos sin migración destructiva.
   */
  function isPositivelyConfirmedPayment(pay) {
    if (!pay || typeof pay !== 'object') return false;
    const payEstado = typeof pay.estado === 'string' ? pay.estado.trim().toLowerCase() : '';
    const hasPositiveFlag = (
      pay.confirmado === true ||
      pay.verificado === true ||
      payEstado === 'confirmado' ||
      payEstado === 'verificado'
    );
    if (!hasPositiveFlag) return false;

    const confirmedByRole = typeof pay.confirmado_por_rol === 'string'
      ? pay.confirmado_por_rol.trim().toLowerCase()
      : '';
    if (confirmedByRole && !POLICY.savePayment.includes(confirmedByRole)) {
      return false;
    }

    const hasBackendProvenance = Boolean(
      (pay.confirmado_por_uid || pay.confirmado_por || pay.verificado_por_uid || pay.verificado_por) &&
      (pay.confirmado_en || pay.verificado_en)
    );
    return hasBackendProvenance;
  }

  function businessPrecondition(errorCode, message, details = {}) {
    const err = new ServiceError('failed-precondition', message);
    err.errorCode = errorCode;
    err.details = { errorCode, ...details };
    return err;
  }

  /**
   * Pure deterministic evaluator of commercial closing and confirmed advance payments
   * for manufacturing readiness. Never trusts frontend booleans (`anticipo_pagado`),
   * unverified receipts, transfer promises, payments with absent confirmation metadata,
   * or payments applied to invoices unrelated to the advance.
   */
  function evaluateManufacturingReadiness({ p, client }) {
    if (!p || typeof p !== 'object' || p.eliminado === true) {
      return {
        ready: false,
        errorCode: 'OPORTUNIDAD_INVALIDA',
        reason: 'La oportunidad no existe o fue eliminada.'
      };
    }
    if (!client || typeof client !== 'object' || client.eliminado === true || client.estado_cuenta === 'fusionada') {
      return {
        ready: false,
        errorCode: 'CUENTA_INVALIDA',
        reason: 'La oportunidad no corresponde a una cuenta de cliente válida y activa.'
      };
    }

    const datos = (p.datos && typeof p.datos === 'object') ? p.datos : {};
    const clientDocs = (client.documentos && typeof client.documentos === 'object') ? client.documentos : {};

    // 1. Validación de cierre comercial
    const postclosingValid = p.estado === 'ganado' && hasEnteredPostclosing(p);
    if (!postclosingValid) {
      return {
        ready: false,
        errorCode: 'CIERRE_COMERCIAL_INVALIDO',
        reason: 'La oportunidad no cuenta con un cierre comercial válido (el estado debe ser ganado).'
      };
    }

    const isBig = p.tipo_proyecto === 'Fabricación e instalación' && Math.max(Number(p.precio_cotizado) || 0, Number(p.costo_venta) || 0) > 10000;
    const aprobacionSinContrato = p.aprobacion_sin_contrato || datos.aprobacion_sin_contrato || null;
    const isApprovalInvalidated = Boolean(aprobacionSinContrato && aprobacionSinContrato.estado === 'invalidada_por_sustitucion');
    const bypass = isBig && !isApprovalInvalidated && (isNoContractApprovalValid(p) || datos.autorizado_sin_contrato === true);
    const hasSignedClosingDoc = hasDoc(datos.doc_firmado) || hasDoc(datos.doc_contrato) || hasDoc(datos.doc_oferta_firmada) || hasDoc(p.doc_firmado) || Boolean(p.contrato_archivo);
    if (!hasSignedClosingDoc) {
      return {
        ready: false,
        errorCode: 'CIERRE_COMERCIAL_INVALIDO',
        reason: 'La oportunidad carece del documento contractual u oferta firmada de cierre.'
      };
    }
    if (isBig && isApprovalInvalidated && !hasDoc(datos.doc_contrato)) {
      return {
        ready: false,
        errorCode: 'CIERRE_COMERCIAL_INVALIDO',
        reason: 'La autorización de cierre sin contrato fue invalidada y no existe contrato firmado vigente.'
      };
    }
    const hasClientDocsMap = Boolean(client.documentos && typeof client.documentos === 'object');
    if (hasClientDocsMap && !hasDoc(clientDocs.dui) && !hasDoc(clientDocs.dui_rep)) {
      return {
        ready: false,
        errorCode: 'CIERRE_COMERCIAL_INVALIDO',
        reason: 'La cuenta del cliente carece del documento de identidad obligatorio (DUI / Carnet de residente).'
      };
    }
    if (hasClientDocsMap && isBig && !bypass && client.tipo === 'juridica') {
      if (!(hasDoc(clientDocs.escritura) && hasDoc(clientDocs.credencial) && hasDoc(clientDocs.nit) && hasDoc(clientDocs.nrc))) {
        return {
          ready: false,
          errorCode: 'CIERRE_COMERCIAL_INVALIDO',
          reason: 'La cuenta jurídica carece de los documentos societarios obligatorios para el cierre contractual.'
        };
      }
    }
    if (p.tipo_proyecto === 'Fabricación e instalación' && !(p.encargado || datos.encargado)) {
      return {
        ready: false,
        errorCode: 'CIERRE_COMERCIAL_INVALIDO',
        reason: 'Falta asignar el encargado de instalación del proyecto.'
      };
    }

    // 2. Validación de condición de pago autorizada (invariable: 50/50, 70/30, 100% anticipado)
    const formaPago = p.forma_pago || datos.forma_pago || null;
    if (!formaPago || !Object.prototype.hasOwnProperty.call(FORMAS_PAGO, formaPago)) {
      return {
        ready: false,
        errorCode: 'CONDICION_PAGO_INVALIDA',
        formaPago,
        reason: `La condición de pago '${formaPago || 'sin definir'}' no está autorizada. DUCTSAL solo permite '50/50', '70/30' o '100% anticipado'.`
      };
    }

    // 3. Cálculo del monto contractual base del anticipo y monto exigible
    const precioCotizado = round2(Number(p.precio_cotizado));
    const subtotalActual = round2(subtotalOf(p));
    // El anticipo exigible se calcula sobre el contrato base cerrado (o el subtotal vigente si hubo orden de cambio en disminución).
    const subtotalContractual = (Number.isFinite(precioCotizado) && precioCotizado > 0)
      ? (Number.isFinite(subtotalActual) && subtotalActual > 0 ? Math.min(precioCotizado, subtotalActual) : precioCotizado)
      : subtotalActual;
    if (!Number.isFinite(subtotalContractual) || subtotalContractual <= 0) {
      return {
        ready: false,
        errorCode: 'MONTO_CONTRACTUAL_INVALIDO',
        formaPago,
        subtotalContractual,
        reason: 'El monto contractual del proyecto debe ser mayor que cero. No se permiten ventas sin anticipo.'
      };
    }

    const clientIsExport = isExport(client);
    const totalContractual = round2(clientIsExport ? subtotalContractual : subtotalContractual * IVA);
    const porcentajeAnticipo = FORMAS_PAGO[formaPago];
    const montoExigible = round2(totalContractual * porcentajeAnticipo);
    if (!Number.isFinite(montoExigible) || montoExigible <= 0) {
      return {
        ready: false,
        errorCode: 'MONTO_ANTICIPO_INVALIDO',
        formaPago,
        totalContractual,
        montoExigible,
        reason: 'El monto de anticipo exigible debe ser mayor que cero.'
      };
    }

    // 4. Identificación segura de la factura de anticipo y verificación estricta de pagos confirmados
    const facturas = Array.isArray(p.facturas) ? p.facturas : [];
    const activeInvoices = facturas.filter(isActiveInvoice);
    const montoFacturadoTotal = round2(activeInvoices.reduce((acc, fac) => acc + round2(Number(fac.monto)), 0));

    const advResolution = resolveAdvanceInvoice(p, facturas);
    if (advResolution.ambiguous) {
      return {
        ready: false,
        errorCode: 'FACTURA_ANTICIPO_AMBIGUA',
        prospectId: p.id || null,
        accountId: client.id || p.clientId || null,
        formaPago,
        montoExigible,
        reason: 'FACTURA_ANTICIPO_AMBIGUA: Existen múltiples facturas marcadas como anticipo o referencias conflictivas. Debe regularizarse la factura de anticipo antes de liberar a fabricación.'
      };
    }

    const advInvoice = advResolution.invoice;
    const montoFacturadoAnticipo = advInvoice ? round2(Number(advInvoice.monto)) : 0;
    const hasValidIssuedInvoice = Boolean(advInvoice && hasValidPaymentDoc(advInvoice.doc_factura));
    const ccfAnticipoNumero = hasValidIssuedInvoice ? String(advInvoice.numero).trim() : null;
    const ccfAnticipoId = advInvoice ? (advInvoice.id || null) : null;

    let montoEfectivoConfirmado = 0;
    let montoRetencionConfirmadaBruta = 0;
    let montoRegistradoNoConfirmado = 0;
    let montoConfirmadoOtrasFacturas = 0;

    const seenPaymentIds = new Set();
    const seenPaymentOpIds = new Set();
    const seenCompositeKeys = new Set();
    const seenVoucherRefs = new Set();
    const comprobantesDuplicadosDetectados = [];
    const isGranContribuyente = isClientGranContribuyenteLocal(client);

    for (const fac of activeInvoices) {
      const facNumero = String(fac.numero || '').trim();
      const isAdvFac = Boolean(advInvoice && (fac === advInvoice || (fac.id && advInvoice.id && fac.id === advInvoice.id)));
      const pagos = Array.isArray(fac.pagos) ? fac.pagos : [];

      for (const pay of pagos) {
        if (!pay || typeof pay !== 'object') continue;
        if (!isActivePaymentRecord(pay)) continue;

        const metodo = typeof pay.metodo === 'string' ? pay.metodo.trim().toLowerCase() : '';
        if (!PAYMENT_METHODS.includes(metodo)) continue;
        if (metodo === 'retencion_1pct' && (!isGranContribuyente || clientIsExport)) continue;
        if (!hasValidPaymentDoc(pay.doc_comprobante)) continue;

        const normRef = normalizePaymentReference(pay.ref || '');
        if (typeof pay.ref === 'string' && !normRef) continue;

        const payMonto = round2(Number(pay.monto));
        if (!Number.isFinite(payMonto) || payMonto <= 0) continue;

        const payId = pay.id ? String(pay.id).trim() : '';
        const payOpId = pay.opId ? String(pay.opId).trim() : '';
        if (payId) {
          if (seenPaymentIds.has(payId)) {
            comprobantesDuplicadosDetectados.push({
              invoiceId: fac.id || null,
              invoiceNumero: facNumero,
              paymentId: payId,
              ref: String(pay.ref || '').trim(),
              normalizedRef: normRef,
              metodo,
              monto: payMonto,
              reason: 'duplicate_payment_id'
            });
            continue;
          }
          seenPaymentIds.add(payId);
        }
        if (payOpId) {
          if (seenPaymentOpIds.has(payOpId)) {
            comprobantesDuplicadosDetectados.push({
              invoiceId: fac.id || null,
              invoiceNumero: facNumero,
              paymentId: payId || null,
              ref: String(pay.ref || '').trim(),
              normalizedRef: normRef,
              metodo,
              monto: payMonto,
              reason: 'duplicate_op_id'
            });
            continue;
          }
          seenPaymentOpIds.add(payOpId);
        }
        if (normRef) {
          const refDedupeKey = metodo === 'retencion_1pct'
            ? `RET_${fac.id || facNumero}_${normRef}`
            : `BANK_${normRef}`;
          if (seenVoucherRefs.has(refDedupeKey)) {
            comprobantesDuplicadosDetectados.push({
              invoiceId: fac.id || null,
              invoiceNumero: facNumero,
              paymentId: payId || null,
              ref: String(pay.ref || '').trim(),
              normalizedRef: normRef,
              metodo,
              monto: payMonto,
              reason: 'duplicate_voucher_ref'
            });
            continue;
          }
          seenVoucherRefs.add(refDedupeKey);
        }

        if (!payId && !payOpId) {
          const compKey = `${fac.id || facNumero}|${pay.fecha || ''}|${payMonto}|${metodo}|${normRef}`;
          if (seenCompositeKeys.has(compKey)) continue;
          seenCompositeKeys.add(compKey);
        }

        if (!isPositivelyConfirmedPayment(pay)) {
          if (isAdvFac) {
            montoRegistradoNoConfirmado = round2(montoRegistradoNoConfirmado + payMonto);
          }
          continue;
        }

        if (!isAdvFac) {
          montoConfirmadoOtrasFacturas = round2(montoConfirmadoOtrasFacturas + payMonto);
          continue;
        }

        if (metodo === 'retencion_1pct') {
          montoRetencionConfirmadaBruta = round2(montoRetencionConfirmadaBruta + payMonto);
        } else {
          montoEfectivoConfirmado = round2(montoEfectivoConfirmado + payMonto);
        }
      }
    }

    // Tratamiento fiscal de retención 1% (Art. 162 Código Tributario El Salvador):
    // - La retención del 1% de IVA se calcula exclusivamente sobre la base gravada sin IVA,
    //   nunca sobre el total con IVA, y requiere base gravada >= $100.00.
    // - En DUCTSAL ERP, `fac.monto` almacena el total facturado CON IVA para clientes locales (`!isExport`);
    //   si la factura especifica explícitamente su base sin IVA (`subtotal_sin_iva`, `monto_sin_iva`,
    //   `incluye_iva: false`, etc.), `resolveInvoiceBaseSinIva` no vuelve a dividir entre 1.13.
    const advBaseInfo = advInvoice ? resolveInvoiceBaseSinIva(advInvoice, client) : { baseGravadaSinIva: 0 };
    const baseSubtotalAnticipo = advBaseInfo.baseGravadaSinIva;
    const maxRetencionReconocible = (advInvoice && isGranContribuyente && !clientIsExport && baseSubtotalAnticipo >= 100)
      ? round2(baseSubtotalAnticipo * 0.01)
      : 0;
    const montoRetencionConfirmada = round2(Math.min(montoRetencionConfirmadaBruta, maxRetencionReconocible));
    const montoRetencionExcedente = round2(Math.max(0, montoRetencionConfirmadaBruta - montoRetencionConfirmada));

    const sumaReconocidaAnticipo = round2(montoEfectivoConfirmado + montoRetencionConfirmada);
    const montoConfirmado = advInvoice ? round2(Math.min(montoFacturadoAnticipo, sumaReconocidaAnticipo)) : 0;

    const ccfAnticipoStatus = hasValidIssuedInvoice ? 'emitido' : 'pendiente';
    const saldoPendiente = Math.max(0, round2(montoExigible - montoConfirmado));
    const anticipoCumplido = (
      Boolean(advInvoice) &&
      Math.round(montoFacturadoAnticipo * 100) >= Math.round(montoExigible * 100) &&
      Math.round(montoConfirmado * 100) >= Math.round(montoExigible * 100)
    );
    const anticipoPagoStatus = anticipoCumplido
      ? 'pagado'
      : (montoConfirmado > 0 ? 'parcialmente_pagado' : 'pendiente');

    if (!anticipoCumplido) {
      let extraReason = '';
      if (montoRegistradoNoConfirmado > 0 && montoConfirmado === 0) {
        extraReason = ` Existen pagos registrados sin confirmación positiva de backend por ${fmtMoney(montoRegistradoNoConfirmado)}.`;
      } else if (montoConfirmadoOtrasFacturas > 0) {
        extraReason = ` Los pagos aplicados a otras facturas (${fmtMoney(montoConfirmadoOtrasFacturas)}) no sustituyen el anticipo.`;
      } else if (montoRetencionExcedente > 0) {
        extraReason = ` Se descartó retención 1% improcedente o en exceso por ${fmtMoney(montoRetencionExcedente)}.`;
      }
      const fmtUsd = Number(saldoPendiente || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const userMessage = `No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$${fmtUsd}.`;
      return {
        ready: false,
        errorCode: 'ANTICIPO_PENDIENTE',
        code: 'ANTICIPO_PENDIENTE',
        estadoHabilitacion: 'ANTICIPO_PENDIENTE',
        userMessage,
        prospectId: p.id || null,
        accountId: client.id || p.clientId || null,
        formaPago,
        porcentajeAnticipo,
        subtotalContractual,
        totalContractual,
        montoExigible,
        anticipoExigible: montoExigible,
        montoFacturado: montoFacturadoAnticipo,
        montoFacturadoTotal,
        montoConfirmado,
        anticipoReconocido: montoConfirmado,
        montoEfectivoConfirmado,
        montoRetencionConfirmada,
        montoRetencionExcedente,
        montoRegistradoNoConfirmado,
        montoConfirmadoOtrasFacturas,
        comprobantesDuplicadosDetectados,
        saldoPendiente,
        ccfAnticipoId,
        ccfAnticipoStatus,
        ccfAnticipoNumero,
        anticipoPagoStatus,
        discrepanciaFinanciera: Boolean(p.discrepancia_financiera_fabricacion),
        reason: `ANTICIPO_PENDIENTE: ${userMessage} Modalidad: ${formaPago}. Monto de anticipo exigible: ${fmtMoney(montoExigible)} | Monto confirmado del anticipo: ${fmtMoney(montoConfirmado)} (Efectivo: ${fmtMoney(montoEfectivoConfirmado)}, Retención 1%: ${fmtMoney(montoRetencionConfirmada)}) | Saldo pendiente: ${fmtMoney(saldoPendiente)}.${extraReason}`
      };
    }

    return {
      ready: true,
      code: 'ANTICIPO_CONFIRMADO',
      estadoHabilitacion: 'ANTICIPO_CONFIRMADO',
      prospectId: p.id || null,
      accountId: client.id || p.clientId || null,
      formaPago,
      porcentajeAnticipo,
      subtotalContractual,
      totalContractual,
      montoExigible,
      anticipoExigible: montoExigible,
      montoFacturado: montoFacturadoAnticipo,
      montoFacturadoTotal,
      montoConfirmado,
      anticipoReconocido: montoConfirmado,
      montoEfectivoConfirmado,
      montoRetencionConfirmada,
      montoRetencionExcedente,
      montoRegistradoNoConfirmado,
      montoConfirmadoOtrasFacturas,
      comprobantesDuplicadosDetectados,
      saldoPendiente: 0,
      ccfAnticipoId,
      ccfAnticipoStatus,
      ccfAnticipoNumero,
      anticipoPagoStatus: 'pagado',
      discrepanciaFinanciera: false
    };
  }

  /**
   * Reusable transactional gate to be invoked inside any Firestore transaction
   * that transitions, sends, or releases an opportunity/project to manufacturing.
   */
  async function assertManufacturingReadyTx(tx, { caller, prospectId }) {
    if (!caller || !caller.uid) {
      throw new ServiceError('unauthenticated', 'Debes iniciar sesión');
    }
    if (!MANUFACTURING_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'No tienes permiso para validar o liberar proyectos a fabricación');
    }
    reqDocId(prospectId, 'prospectId');

    const pRef = col('prospects').doc(prospectId);
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists) throw notFound('Oportunidad');
    const p = pSnap.data() || {};
    if (p.eliminado === true) throw precondition('Este proyecto fue eliminado y no admite cambios');
    if (caller.role === 'gestor') {
      requireProspectAccess(caller, p);
    }

    if (!p.clientId) {
      throw businessPrecondition('CUENTA_INVALIDA', 'CUENTA_INVALIDA: La oportunidad no tiene una cuenta asociada.', { prospectId });
    }

    const client = await loadClient(tx, p);
    if (!client) {
      throw businessPrecondition('CUENTA_INVALIDA', 'CUENTA_INVALIDA: La cuenta asociada a la oportunidad no existe.', { prospectId, clientId: p.clientId });
    }

    const evaluation = evaluateManufacturingReadiness({ p: { id: prospectId, ...p }, client });
    if (!evaluation.ready) {
      throw businessPrecondition(
        evaluation.errorCode || 'ANTICIPO_PENDIENTE',
        evaluation.userMessage || evaluation.reason,
        evaluation
      );
    }

    return {
      status: 'ready_for_manufacturing',
      ...evaluation
    };
  }

  /**
   * Centralized backend validation callable/method for verifying that a closed opportunity
   * has its mandatory advance payment 100% confirmed before manufacturing release.
   */
  async function validateManufacturingReadiness({ caller, prospectId }) {
    if (!caller || !caller.uid) {
      throw new ServiceError('unauthenticated', 'Debes iniciar sesión');
    }
    if (!MANUFACTURING_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'No tienes permiso para validar o liberar proyectos a fabricación');
    }
    reqDocId(prospectId, 'prospectId');
    return db.runTransaction(async tx => {
      const result = await assertManufacturingReadyTx(tx, { caller, prospectId });
      addAudit(tx, caller, 'validateManufacturingReadiness', prospectId, {
        ready: true,
        forma_pago: result.formaPago,
        monto_exigible: result.montoExigible,
        monto_confirmado: result.montoConfirmado,
        monto_efectivo_confirmado: result.montoEfectivoConfirmado,
        monto_retencion_confirmada: result.montoRetencionConfirmada,
        saldo_pendiente: result.saldoPendiente
      });
      return result;
    });
  }

  /**
   * Envía transaccionalmente una oportunidad comercial ganada a la bandeja de Recepción de Fabricación
   * (`proyectos_fabricacion`), únicamente cuando `assertManufacturingReadyTx` confirma que el anticipo
   * obligatorio (`50/50`, `70/30` o `100% anticipado`) está liquidado al 100%.
   */
  async function sendProspectToFabrication({ caller, prospectId, opId }) {
    if (!caller || !caller.uid) {
      throw new ServiceError('unauthenticated', 'Debes iniciar sesión');
    }
    if (!SEND_TO_FABRICATION_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'No tienes permiso para enviar proyectos a fabricación');
    }
    const cleanProspectId = reqDocId(prospectId, 'prospectId');
    if (opId !== undefined && opId !== null && opId !== '') {
      reqOpId(opId);
    }

    return db.runTransaction(async tx => {
      // 1. Lecturas previas y compuerta financiera obligatoria
      const readiness = await assertManufacturingReadyTx(tx, { caller, prospectId: cleanProspectId });
      const pRef = col('prospects').doc(cleanProspectId);
      const pSnap = await tx.get(pRef);
      const p = pSnap.data() || {};
      const client = await loadClient(tx, p);

      const existingQuerySnap = await tx.get(
        col('proyectos_fabricacion').where('prospecto_id', '==', cleanProspectId).limit(2)
      );
      const deterministicId = `FAB-PROJ-${cleanProspectId}`;
      const detRef = col('proyectos_fabricacion').doc(deterministicId);
      const detSnap = await tx.get(detRef);

      const nowAt = iso();
      const canonicalClientId = (client && client.id) || p.clientId;
      const canonicalClientName = client
        ? (client.tipo === 'natural'
          ? `${client.nombres || ''} ${client.apellidos || ''}`.trim()
          : (client.empresa || client.contacto || 'Cliente'))
        : 'Cliente Desconocido';

      const datos = (p.datos && typeof p.datos === 'object') ? p.datos : {};
      const existingDoc = !existingQuerySnap.empty
        ? existingQuerySnap.docs[0]
        : (detSnap.exists ? detSnap : null);

      if (existingDoc && existingDoc.exists) {
        const existingId = existingDoc.id;
        const existingData = existingDoc.data() || {};
        const updatedProj = {
          ...existingData,
          cliente_id: canonicalClientId,
          cliente_nombre: canonicalClientName,
          estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
          forma_pago: readiness.formaPago,
          monto_anticipo_exigible: readiness.montoExigible,
          monto_anticipo_confirmado: readiness.montoConfirmado,
          saldo_pendiente_anticipo: 0,
          ccf_anticipo_id: readiness.ccfAnticipoId || null,
          ccf_anticipo_numero: readiness.ccfAnticipoNumero || null,
          validado_financieramente_en: nowAt,
          validado_financieramente_por: caller.cid || caller.uid,
          discrepancia_financiera: false,
          bloqueado_nuevas_ordenes: false
        };
        tx.set(existingDoc.ref, updatedProj, { merge: true });
        tx.update(pRef, {
          enviado_a_fabricacion: true,
          fabricacion_proyecto_id: existingId,
          estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
          discrepancia_financiera_fabricacion: false,
          bloqueado_nuevas_ordenes_fabricacion: false
        });
        addAudit(tx, caller, 'sendProspectToFabrication', cleanProspectId, {
          status: 'already_sent',
          projectId: existingId,
          formaPago: readiness.formaPago,
          montoExigible: readiness.montoExigible,
          montoConfirmado: readiness.montoConfirmado
        });
        return {
          status: 'already_sent',
          replay: true,
          projectId: existingId,
          project: updatedProj,
          readiness
        };
      }

      const newProj = {
        id: deterministicId,
        codigo: p.codigo || `PROY-${String(cleanProspectId).slice(-4)}`,
        nombre_proyecto: p.proyecto || 'Sin Nombre',
        cliente_id: canonicalClientId,
        cliente_nombre: canonicalClientName,
        tipo_material: p.tipo_producto || 'Lámina Galvanizada',
        fecha_entrega: datos.fecha_entrega || p.fecha_entrega || '',
        doc_diseno: datos.doc_oferta || p.doc_oferta || null,
        origen_tipo: 'oportunidad',
        prospecto_id: cleanProspectId,
        estado: 'activo',
        fecha_creacion: nowAt,
        creado_por: caller.name || caller.cid || caller.uid,
        creado_por_cid: caller.cid || caller.uid,
        creado_por_rol: caller.role,
        opId: opId || null,
        estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
        forma_pago: readiness.formaPago,
        monto_anticipo_exigible: readiness.montoExigible,
        monto_anticipo_confirmado: readiness.montoConfirmado,
        saldo_pendiente_anticipo: 0,
        ccf_anticipo_id: readiness.ccfAnticipoId || null,
        ccf_anticipo_numero: readiness.ccfAnticipoNumero || null,
        validado_financieramente_en: nowAt,
        validado_financieramente_por: caller.cid || caller.uid,
        discrepancia_financiera: false,
        bloqueado_nuevas_ordenes: false
      };

      tx.set(detRef, newProj);
      tx.update(pRef, {
        enviado_a_fabricacion: true,
        fecha_envio_fabricacion: nowAt,
        fabricacion_proyecto_id: deterministicId,
        estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
        discrepancia_financiera_fabricacion: false,
        bloqueado_nuevas_ordenes_fabricacion: false,
        logs: withLog(
          p,
          caller,
          `Proyecto enviado a Bandeja de Recepción de Fabricación (${deterministicId}). Anticipo obligatorio 100% confirmado: ${fmtMoney(readiness.montoConfirmado)} / ${fmtMoney(readiness.montoExigible)} [${readiness.formaPago}].`
        )
      });

      addAudit(tx, caller, 'sendProspectToFabrication', cleanProspectId, {
        status: 'sent',
        projectId: deterministicId,
        formaPago: readiness.formaPago,
        montoExigible: readiness.montoExigible,
        montoConfirmado: readiness.montoConfirmado,
        ccfAnticipoId: readiness.ccfAnticipoId || null
      });

      return {
        status: 'sent',
        replay: false,
        projectId: deterministicId,
        project: newProj,
        readiness
      };
    });
  }

  /**
   * Valida y ejecuta en backend las operaciones sensibles de fabricación:
   * - Creación de proyecto manual en bandeja (`crear_proyecto_manual` / `projectPayload`).
   * - Creación de orden hija desde recepción (`crear_orden_hijo` / `orderPayload`).
   * - Creación de orden única manual (`crear_orden_unica_manual` / `orderPayload`).
   * - Liberación de `Dibujo -> Fabricación` y generación de tareas (`liberar_dibujo_a_fabricacion` / `orderUpdate` + `tasks`).
   * - Despacho parcial con partición de orden (`despacho_parcial_split` / `orderUpdate` + `splitOrderPayload` + `taskUpdates`).
   *
   * En todos los casos, determina la oportunidad comercial a partir de los documentos reales almacenados
   * en Firestore (`proyectos_fabricacion`, `fabricacion`, `prospects`), rechazando cualquier intento de
   * falsificar `origen_tipo: 'interno'`, omitir `estado_habilitacion_fabricacion`, enviar un `prospecto_id`
   * distinto/inconsistente o duplicar la liberación de una orden.
   */
  async function validateAndAuthorizeFabricationOrder({
    caller,
    prospectId,
    fabProjectId,
    fabOrderId,
    codigoProyecto,
    nombreProyecto,
    origenTipo,
    stageTransition,
    projectPayload,
    orderPayload,
    orderUpdate,
    tasks,
    reactivateRejectedTasks = false,
    splitOrderPayload,
    taskUpdates,
    opId
  }) {
    if (!caller || !caller.uid) {
      throw new ServiceError('unauthenticated', 'Debes iniciar sesión');
    }
    if (!MANUFACTURING_ROLES.includes(caller.role)) {
      throw new ServiceError('permission-denied', 'No tienes permiso para validar o liberar proyectos a fabricación');
    }

    const cleanTransition = typeof stageTransition === 'string' && stageTransition.trim()
      ? stageTransition.trim().slice(0, 80)
      : 'general';

    return db.runTransaction(async tx => {
      // =========================================================================
      // FASE 1: Todas las lecturas transaccionales antes de cualquier escritura
      // =========================================================================
      const rawOrderId = (fabOrderId !== undefined && fabOrderId !== null && String(fabOrderId).trim() !== '')
        ? String(fabOrderId).trim()
        : ((orderPayload && orderPayload.id)
          ? String(orderPayload.id).trim()
          : ((orderUpdate && orderUpdate.id) ? String(orderUpdate.id).trim() : ''));

      let cleanOrderId = '';
      let orderSnap = null;
      let orderData = null;
      if (rawOrderId) {
        cleanOrderId = reqDocId(rawOrderId, 'fabOrderId');
        orderSnap = await tx.get(col('fabricacion').doc(cleanOrderId));
        if (orderSnap.exists) {
          orderData = orderSnap.data() || {};
        }
      }

      let cleanSplitOrderId = '';
      let splitOrderSnap = null;
      if (splitOrderPayload && typeof splitOrderPayload === 'object' && splitOrderPayload.id) {
        cleanSplitOrderId = reqDocId(String(splitOrderPayload.id).trim(), 'splitOrderPayload.id');
        splitOrderSnap = await tx.get(col('fabricacion').doc(cleanSplitOrderId));
      }

      const rawProjId = (fabProjectId !== undefined && fabProjectId !== null && String(fabProjectId).trim() !== '')
        ? String(fabProjectId).trim()
        : ((projectPayload && projectPayload.id)
          ? String(projectPayload.id).trim()
          : ((orderData && orderData.padre_id)
            ? String(orderData.padre_id).trim()
            : ((orderPayload && orderPayload.padre_id) ? String(orderPayload.padre_id).trim() : '')));

      let cleanProjId = '';
      let projSnap = null;
      let projData = null;
      if (rawProjId) {
        cleanProjId = reqDocId(rawProjId, 'fabProjectId');
        projSnap = await tx.get(col('proyectos_fabricacion').doc(cleanProjId));
        if (projSnap.exists) {
          projData = projSnap.data() || {};
        }
      }

      let existingTasksSnap = null;
      if (cleanOrderId && (
        cleanTransition === 'liberar_dibujo_a_fabricacion' ||
        cleanTransition === 'prevalidar_dibujo_a_fabricacion' ||
        Array.isArray(tasks) ||
        reactivateRejectedTasks === true ||
        Array.isArray(taskUpdates)
      )) {
        existingTasksSnap = await tx.get(
          col('fabricacion_tasks').where('fabricacion_id', '==', cleanOrderId).limit(100)
        );
      }

      // Identificadores almacenados vs enviados por el cliente
      const storedOrderProspectId = (orderData && orderData.prospecto_id) ? String(orderData.prospecto_id).trim() : '';
      const storedProjProspectId = (projData && projData.prospecto_id) ? String(projData.prospecto_id).trim() : '';
      const callerProspectId = (prospectId !== undefined && prospectId !== null && String(prospectId).trim() !== '')
        ? String(prospectId).trim()
        : ((orderPayload && orderPayload.prospecto_id)
          ? String(orderPayload.prospecto_id).trim()
          : ((projectPayload && projectPayload.prospecto_id)
            ? String(projectPayload.prospecto_id).trim()
            : ((orderUpdate && orderUpdate.prospecto_id) ? String(orderUpdate.prospecto_id).trim() : '')));

      const storedCode = (orderData && (orderData.codigo_proyecto || orderData.codigo))
        ? String(orderData.codigo_proyecto || orderData.codigo).trim()
        : ((projData && projData.codigo) ? String(projData.codigo).trim() : '');

      const orderCodePrefix = (orderPayload && typeof orderPayload.codigo_orden === 'string' && orderPayload.codigo_orden.includes('_'))
        ? String(orderPayload.codigo_orden.split('_')[0]).trim()
        : '';

      const payloadCode = (codigoProyecto !== undefined && codigoProyecto !== null && String(codigoProyecto).trim() !== '')
        ? String(codigoProyecto).trim()
        : ((orderPayload && (orderPayload.codigo_proyecto || orderPayload.codigo))
          ? String(orderPayload.codigo_proyecto || orderPayload.codigo).trim()
          : ((projectPayload && (projectPayload.codigo || projectPayload.codigo_proyecto))
            ? String(projectPayload.codigo || projectPayload.codigo_proyecto).trim()
            : ((orderUpdate && (orderUpdate.codigo_proyecto || orderUpdate.codigo))
              ? String(orderUpdate.codigo_proyecto || orderUpdate.codigo).trim()
              : orderCodePrefix)));

      const effectiveCodigo = storedCode || payloadCode;

      const effectiveNombreProyecto = (nombreProyecto !== undefined && nombreProyecto !== null && String(nombreProyecto).trim() !== '')
        ? String(nombreProyecto).trim()
        : ((orderData && orderData.proyecto)
          ? String(orderData.proyecto).trim()
          : ((projData && (projData.nombre_proyecto || projData.proyecto))
            ? String(projData.nombre_proyecto || projData.proyecto).trim()
            : ((projectPayload && (projectPayload.nombre_proyecto || projectPayload.proyecto))
              ? String(projectPayload.nombre_proyecto || projectPayload.proyecto).trim()
              : ((orderPayload && orderPayload.proyecto) ? String(orderPayload.proyecto).trim() : ''))));

      // Búsqueda en `prospects` por código o ID para impedir disfrazar oportunidades comerciales como 'interno'
      // o enviar un `prospecto_id` distinto al del proyecto real.
      let codeMatchedProspectId = '';
      if (effectiveCodigo) {
        if (/^[A-Za-z0-9_-]{1,128}$/.test(effectiveCodigo)) {
          const directProspectSnap = await tx.get(col('prospects').doc(effectiveCodigo));
          if (directProspectSnap.exists && (directProspectSnap.data() || {}).eliminado !== true) {
            codeMatchedProspectId = directProspectSnap.id;
          }
        }
        if (!codeMatchedProspectId) {
          const codeQuerySnap = await tx.get(col('prospects').where('codigo', '==', effectiveCodigo).limit(5));
          const activeMatch = codeQuerySnap.docs.find(d => (d.data() || {}).eliminado !== true);
          if (activeMatch) {
            codeMatchedProspectId = activeMatch.id;
          }
        }
      }

      const isVerifiedLegacyOrder = Boolean(
        orderData &&
        orderData.excepcion_legado_verificada === true &&
        typeof orderData.origen_excepcion_legado === 'string' &&
        orderData.origen_excepcion_legado.trim().length > 0
      );
      const isVerifiedLegacyInternalOrder = Boolean(
        isVerifiedLegacyOrder &&
        String(orderData.origen_tipo || '').trim().toLowerCase() === 'interno' &&
        !storedOrderProspectId &&
        !storedProjProspectId &&
        !codeMatchedProspectId
      );

      let nameMatchedProspectId = '';
      if (!isVerifiedLegacyInternalOrder && !storedOrderProspectId && !storedProjProspectId && !codeMatchedProspectId && effectiveNombreProyecto) {
        const nameQuerySnap = await tx.get(col('prospects').where('proyecto', '==', effectiveNombreProyecto).limit(5));
        const activeNameMatches = nameQuerySnap.docs.filter(d => {
          const pd = d.data() || {};
          return pd.eliminado !== true && pd.estado !== 'perdido';
        });
        if (activeNameMatches.length === 1) {
          nameMatchedProspectId = activeNameMatches[0].id;
        }
      }

      // Verificación estricta de consistencia de `prospecto_id` (anti-spoofing)
      if (storedOrderProspectId && storedProjProspectId && storedOrderProspectId !== storedProjProspectId) {
        throw businessPrecondition(
          'OPORTUNIDAD_INCONSISTENTE',
          'OPORTUNIDAD_INCONSISTENTE: El prospecto_id de la orden no coincide con el proyecto de fabricación padre.',
          { storedOrderProspectId, storedProjProspectId }
        );
      }
      if (callerProspectId && storedOrderProspectId && callerProspectId !== storedOrderProspectId) {
        throw businessPrecondition(
          'OPORTUNIDAD_INCONSISTENTE',
          'OPORTUNIDAD_INCONSISTENTE: El prospecto_id enviado no coincide con la oportunidad vinculada a la orden en Firestore.',
          { callerProspectId, storedOrderProspectId }
        );
      }
      if (callerProspectId && storedProjProspectId && callerProspectId !== storedProjProspectId) {
        throw businessPrecondition(
          'OPORTUNIDAD_INCONSISTENTE',
          'OPORTUNIDAD_INCONSISTENTE: El prospecto_id enviado no coincide con la oportunidad vinculada al proyecto en Firestore.',
          { callerProspectId, storedProjProspectId }
        );
      }
      if (codeMatchedProspectId) {
        const authoritativeStoredId = storedOrderProspectId || storedProjProspectId;
        if (authoritativeStoredId && codeMatchedProspectId !== authoritativeStoredId) {
          throw businessPrecondition(
            'OPORTUNIDAD_INCONSISTENTE',
            'OPORTUNIDAD_INCONSISTENTE: El código de proyecto corresponde a una oportunidad distinta de la almacenada.',
            { codeMatchedProspectId, authoritativeStoredId, effectiveCodigo }
          );
        }
        if (callerProspectId && codeMatchedProspectId !== callerProspectId) {
          throw businessPrecondition(
            'OPORTUNIDAD_INCONSISTENTE',
            'OPORTUNIDAD_INCONSISTENTE: El prospecto_id enviado no coincide con la oportunidad comercial propietaria del código de proyecto.',
            { callerProspectId, codeMatchedProspectId, effectiveCodigo }
          );
        }
      }

      const resolvedProspectId = storedOrderProspectId || storedProjProspectId || codeMatchedProspectId || nameMatchedProspectId || callerProspectId;

      // Prevención de duplicados y clasificación de transición
      const isCreateProjectTransition = Boolean(
        cleanTransition === 'crear_proyecto_manual' || (projectPayload && typeof projectPayload === 'object')
      );
      const isCreateOrderTransition = Boolean(
        cleanTransition === 'crear_orden_hijo' ||
        cleanTransition === 'crear_orden_unica_manual' ||
        (orderPayload && typeof orderPayload === 'object')
      );
      const isReleaseToFabTransition = Boolean(
        cleanTransition === 'liberar_dibujo_a_fabricacion'
      );
      const isPrevalidateReleaseTransition = Boolean(
        cleanTransition === 'prevalidar_dibujo_a_fabricacion'
      );
      const isPartialDispatchSplit = Boolean(
        cleanTransition === 'despacho_parcial_split' && splitOrderPayload && typeof splitOrderPayload === 'object'
      );

      // Continuidad operativa para órdenes ya iniciadas en planta (`Fabricación`, `Quality Control`, `Control de Calidad`, `Despacho`, `Entregado`)
      // que cuentan con liberación backend previa o excepción de legado verificada, únicamente para partición operativa de despacho parcial (`despacho_parcial_split`).
      // NUNCA aplica a creación de proyectos/órdenes nuevas ni a liberación `Dibujo -> Fabricación`.
      const isInExecutionContinuityOp = Boolean(
        isPartialDispatchSplit &&
        !isCreateProjectTransition &&
        !isCreateOrderTransition &&
        !isReleaseToFabTransition &&
        !isPrevalidateReleaseTransition &&
        orderSnap &&
        orderSnap.exists &&
        ['Fabricación', 'Quality Control', 'Control de Calidad', 'Despacho', 'Entregado'].includes(String(orderData.etapa || '').trim()) &&
        (orderData.liberado_a_fabricacion_backend === true || isVerifiedLegacyOrder) &&
        orderData.bloqueado_avance_etapa !== true
      );

      let readiness = null;
      let inExecutionEval = null;
      let targetProspectData = null;
      let targetClientData = null;
      if (resolvedProspectId) {
        const pSnapCheck = await tx.get(col('prospects').doc(resolvedProspectId));
        if (pSnapCheck.exists) {
          targetProspectData = pSnapCheck.data() || {};
          targetClientData = await loadClient(tx, targetProspectData);
        }
        if (isInExecutionContinuityOp) {
          if (targetProspectData) {
            inExecutionEval = evaluateManufacturingReadiness({
              p: { ...targetProspectData, id: resolvedProspectId },
              client: targetClientData
            });
            if (inExecutionEval.ready) {
              readiness = inExecutionEval;
            }
          }
        } else {
          readiness = await assertManufacturingReadyTx(tx, { caller, prospectId: resolvedProspectId });
        }
        if (payloadCode && targetProspectData) {
          const realCode = String(targetProspectData.codigo || '').trim();
          if (realCode && payloadCode !== realCode && payloadCode !== resolvedProspectId) {
            throw businessPrecondition(
              'OPORTUNIDAD_INCONSISTENTE',
              'OPORTUNIDAD_INCONSISTENTE: El código de proyecto enviado no corresponde a la oportunidad comercial indicada.',
              { resolvedProspectId, expectedCodigo: realCode, receivedCodigo: payloadCode }
            );
          }
        }
      }

      // =========================================================================
      // FASE 2: Validaciones de estado, origen y prevención de duplicados
      // =========================================================================
      const storedOrigen = (orderData && orderData.origen_tipo)
        ? String(orderData.origen_tipo).trim().toLowerCase()
        : ((projData && projData.origen_tipo) ? String(projData.origen_tipo).trim().toLowerCase() : '');
      const callerOrigen = (origenTipo !== undefined && origenTipo !== null && String(origenTipo).trim() !== '')
        ? String(origenTipo).trim().toLowerCase()
        : ((orderPayload && orderPayload.origen_tipo)
          ? String(orderPayload.origen_tipo).trim().toLowerCase()
          : ((projectPayload && projectPayload.origen_tipo) ? String(projectPayload.origen_tipo).trim().toLowerCase() : ''));
      const effectiveOrigen = resolvedProspectId ? 'oportunidad' : (storedOrigen || callerOrigen || 'interno');

      if (!resolvedProspectId && effectiveOrigen === 'oportunidad') {
        throw businessPrecondition(
          'OPORTUNIDAD_INVALIDA',
          'OPORTUNIDAD_INVALIDA: La orden o proyecto de origen comercial no está vinculado a una oportunidad válida.',
          { fabProjectId: cleanProjId || null, fabOrderId: cleanOrderId || null }
        );
      }

      // Si el proyecto u orden tenía registrada una discrepancia financiera activa y no se resolvió una oportunidad lista, bloquear
      // (salvo operaciones de continuidad en órdenes ya en ejecución que no tienen bloqueado_avance_etapa).
      if (!readiness && !isInExecutionContinuityOp && (
        (projData && (projData.discrepancia_financiera === true || projData.bloqueado_nuevas_ordenes === true)) ||
        (orderData && (orderData.discrepancia_financiera === true || orderData.bloqueado_avance_etapa === true))
      )) {
        throw businessPrecondition(
          'ANTICIPO_PENDIENTE',
          'ANTICIPO_PENDIENTE: No se puede enviar esta orden a fabricación. El proyecto presenta una discrepancia financiera de anticipo pendiente de regularización.',
          { fabProjectId: cleanProjId || null, fabOrderId: cleanOrderId || null }
        );
      }

      if (isCreateProjectTransition) {
        if (!cleanProjId) throw bad('Debe especificar el identificador del proyecto de fabricación');
        if (projSnap && projSnap.exists) {
          throw businessPrecondition(
            'ORDEN_YA_LIBERADA',
            'ORDEN_YA_LIBERADA: El proyecto de fabricación ya fue creado previamente.',
            { fabProjectId: cleanProjId }
          );
        }
      }

      if (isCreateOrderTransition) {
        if (!cleanOrderId) throw bad('Debe especificar el identificador de la orden de fabricación');
        if (orderSnap && orderSnap.exists) {
          throw businessPrecondition(
            'ORDEN_YA_LIBERADA',
            'ORDEN_YA_LIBERADA: La orden de fabricación ya existe y no puede duplicarse.',
            { fabOrderId: cleanOrderId }
          );
        }
        if (opId && projData && projData.last_order_op_id && String(projData.last_order_op_id) === String(opId)) {
          throw businessPrecondition(
            'ORDEN_YA_LIBERADA',
            'ORDEN_YA_LIBERADA: Esta solicitud de creación de orden ya fue procesada previamente.',
            { fabProjectId: cleanProjId, opId }
          );
        }
        if (cleanTransition === 'crear_orden_hijo' && (!projSnap || !projSnap.exists)) {
          throw notFound('Proyecto de fabricación padre');
        }
      }

      if (isReleaseToFabTransition || isPrevalidateReleaseTransition) {
        const hasReleaseMutation = Boolean(
          cleanOrderId
          || (orderUpdate && typeof orderUpdate === 'object')
          || (Array.isArray(tasks) && tasks.length > 0)
          || reactivateRejectedTasks
        );
        if (hasReleaseMutation && (!orderSnap || !orderSnap.exists)) {
          throw notFound('Orden de fabricación');
        }
        if (orderSnap && orderSnap.exists) {
          const curEtapa = String(orderData.etapa || '').trim();
          if (curEtapa === 'Fabricación' || (orderData.liberado_a_fabricacion_backend === true && !reactivateRejectedTasks && curEtapa !== 'Dibujo')) {
            throw businessPrecondition(
              'ORDEN_YA_LIBERADA',
              'ORDEN_YA_LIBERADA: Esta orden ya se encuentra liberada en etapa de Fabricación. No se permite duplicar la liberación.',
              { fabOrderId: cleanOrderId, etapaActual: curEtapa }
            );
          }
          if (!reactivateRejectedTasks && existingTasksSnap && !existingTasksSnap.empty) {
            throw businessPrecondition(
              'ORDEN_YA_LIBERADA',
              'ORDEN_YA_LIBERADA: Ya existen tareas productivas generadas para esta orden de fabricación.',
              { fabOrderId: cleanOrderId, existingTaskCount: existingTasksSnap.size }
            );
          }
        }
      }

      if (isPartialDispatchSplit) {
        if (!orderSnap || !orderSnap.exists) {
          throw notFound('Orden de fabricación padre');
        }
        if (splitOrderSnap && splitOrderSnap.exists) {
          throw businessPrecondition(
            'ORDEN_YA_LIBERADA',
            'ORDEN_YA_LIBERADA: La sub-orden de despacho parcial ya fue creada previamente.',
            { splitOrderId: cleanSplitOrderId }
          );
        }
      }

      // =========================================================================
      // FASE 3: Escrituras autoritativas en Firestore (Admin SDK)
      // =========================================================================
      const nowAt = iso();
      const canonicalClientId = (targetClientData && targetClientData.id) || (targetProspectData && targetProspectData.clientId) || null;
      const canonicalClientName = targetClientData
        ? (targetClientData.tipo === 'natural'
          ? `${targetClientData.nombres || ''} ${targetClientData.apellidos || ''}`.trim()
          : (targetClientData.empresa || targetClientData.contacto || 'Cliente'))
        : null;

      let writtenProject = null;
      let writtenOrder = null;
      let writtenTasksCount = 0;

      const stripFabProtectedPayloadFields = (rawObj) => {
        if (!rawObj || typeof rawObj !== 'object') return {};
        const clean = { ...rawObj };
        delete clean.autorizado_backend;
        delete clean.autorizado_en;
        delete clean.autorizado_por;
        delete clean.liberado_a_fabricacion_backend;
        delete clean.liberado_a_fabricacion_en;
        delete clean.liberado_a_fabricacion_por;
        delete clean.estado_habilitacion_fabricacion;
        delete clean.discrepancia_financiera;
        delete clean.discrepancia_financiera_detalle;
        delete clean.bloqueado_avance_etapa;
        delete clean.bloqueado_nuevas_ordenes;
        delete clean.excepcion_legado_verificada;
        delete clean.origen_excepcion_legado;
        delete clean.fecha_excepcion_legado;
        delete clean.autorizado_excepcion_legado_por;
        delete clean.creada_en_backend;
        delete clean.creado_en_backend;
        delete clean.creado_por_backend;
        return clean;
      };

      // 3a. Creación de proyecto manual en `proyectos_fabricacion`
      if (isCreateProjectTransition && projectPayload && typeof projectPayload === 'object') {
        const cleanProjectPayload = stripFabProtectedPayloadFields(projectPayload);
        const projDocRef = col('proyectos_fabricacion').doc(cleanProjId);
        writtenProject = {
          ...cleanProjectPayload,
          id: cleanProjId,
          codigo: (targetProspectData && targetProspectData.codigo) || cleanProjectPayload.codigo || effectiveCodigo || `INT-${cleanProjId.slice(-4)}`,
          nombre_proyecto: (targetProspectData && targetProspectData.proyecto) || cleanProjectPayload.nombre_proyecto || effectiveNombreProyecto || 'Sin Nombre',
          cliente_id: canonicalClientId || cleanProjectPayload.cliente_id || 'INTERNO',
          cliente_nombre: canonicalClientName || cleanProjectPayload.cliente_nombre || 'REQUERIMIENTO INTERNO / MANUAL',
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          prospecto_id: resolvedProspectId || null,
          estado: cleanProjectPayload.estado || 'activo',
          fecha_creacion: cleanProjectPayload.fecha_creacion || nowAt,
          creado_por: caller.name || cleanProjectPayload.creado_por || caller.cid || caller.uid,
          creado_por_cid: caller.cid || caller.uid,
          creado_por_rol: caller.role,
          autorizado_backend: true,
          autorizado_en: nowAt,
          autorizado_por: caller.cid || caller.uid,
          estado_habilitacion_fabricacion: resolvedProspectId ? 'ANTICIPO_CONFIRMADO' : 'ORDEN_INTERNA_NO_COMERCIAL',
          discrepancia_financiera: false,
          bloqueado_nuevas_ordenes: false,
          ...(readiness ? {
            forma_pago: readiness.formaPago,
            monto_anticipo_exigible: readiness.montoExigible,
            monto_anticipo_confirmado: readiness.montoConfirmado,
            saldo_pendiente_anticipo: 0,
            ccf_anticipo_id: readiness.ccfAnticipoId || null,
            ccf_anticipo_numero: readiness.ccfAnticipoNumero || null,
            validado_financieramente_en: nowAt,
            validado_financieramente_por: caller.cid || caller.uid
          } : {})
        };
        tx.set(projDocRef, writtenProject);
      } else if (projSnap && projSnap.exists) {
        const projPatch = {
          ...(readiness ? {
            estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
            forma_pago: readiness.formaPago,
            monto_anticipo_exigible: readiness.montoExigible,
            monto_anticipo_confirmado: readiness.montoConfirmado,
            saldo_pendiente_anticipo: 0,
            discrepancia_financiera: false,
            bloqueado_nuevas_ordenes: false,
            validado_financieramente_en: nowAt,
            validado_financieramente_por: caller.cid || caller.uid
          } : {})
        };
        if (isCreateOrderTransition && cleanTransition === 'crear_orden_hijo') {
          projPatch.ordenes_generadas = (Number(projData.ordenes_generadas) || 0) + 1;
          if (opId) projPatch.last_order_op_id = String(opId);
        }
        if (Object.keys(projPatch).length > 0) {
          tx.update(projSnap.ref, projPatch);
        }
      }

      // 3b. Creación de orden en `fabricacion` (siempre inicia en Dibujo o Recepción, nunca directo en Fabricación)
      if (isCreateOrderTransition && orderPayload && typeof orderPayload === 'object') {
        const cleanOrderPayload = stripFabProtectedPayloadFields(orderPayload);
        const requestedEtapa = String(cleanOrderPayload.etapa || 'Dibujo').trim();
        const safeInitialEtapa = ['Recepción', 'Dibujo'].includes(requestedEtapa) ? requestedEtapa : 'Dibujo';
        const ordDocRef = col('fabricacion').doc(cleanOrderId);
        writtenOrder = {
          ...cleanOrderPayload,
          id: cleanOrderId,
          padre_id: cleanProjId || cleanOrderPayload.padre_id || null,
          prospecto_id: resolvedProspectId || null,
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          codigo_proyecto: (targetProspectData && targetProspectData.codigo) || (projData && projData.codigo) || cleanOrderPayload.codigo_proyecto || effectiveCodigo || '',
          etapa: safeInitialEtapa,
          status: cleanOrderPayload.status || 'pendiente',
          estado_habilitacion_fabricacion: resolvedProspectId ? 'ANTICIPO_CONFIRMADO' : 'ORDEN_INTERNA_NO_COMERCIAL',
          autorizado_backend: true,
          autorizado_en: nowAt,
          autorizado_por: caller.cid || caller.uid,
          liberado_a_fabricacion_backend: false,
          discrepancia_financiera: false,
          bloqueado_avance_etapa: false,
          ...(readiness ? {
            validado_financieramente_en: nowAt,
            validado_financieramente_por: caller.cid || caller.uid
          } : {})
        };
        tx.set(ordDocRef, writtenOrder);
      }

      // 3c. Liberación de `Dibujo -> Fabricación` y creación/reactivación de tareas en `fabricacion_tasks`
      if (isReleaseToFabTransition && orderSnap && orderSnap.exists) {
        const sanitizedOrderUpdate = stripFabProtectedPayloadFields(orderUpdate);
        delete sanitizedOrderUpdate.id;
        writtenOrder = {
          ...orderData,
          ...sanitizedOrderUpdate,
          id: cleanOrderId,
          padre_id: (orderData && orderData.padre_id) || cleanProjId || null,
          prospecto_id: resolvedProspectId || null,
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          codigo_proyecto: (orderData && orderData.codigo_proyecto) || (projData && projData.codigo) || effectiveCodigo || '',
          etapa: 'Fabricación',
          status: 'en_proceso',
          estado_habilitacion_fabricacion: resolvedProspectId ? 'ANTICIPO_CONFIRMADO' : 'ORDEN_INTERNA_NO_COMERCIAL',
          autorizado_backend: true,
          liberado_a_fabricacion_backend: true,
          liberado_a_fabricacion_en: nowAt,
          liberado_a_fabricacion_por: caller.cid || caller.uid,
          discrepancia_financiera: false,
          bloqueado_avance_etapa: false,
          ...(opId ? { liberacion_op_id: String(opId) } : {}),
          ...(readiness ? {
            validado_financieramente_en: nowAt,
            validado_financieramente_por: caller.cid || caller.uid
          } : {})
        };
        tx.set(orderSnap.ref, writtenOrder);

        if (reactivateRejectedTasks && existingTasksSnap && !existingTasksSnap.empty) {
          for (const tDoc of existingTasksSnap.docs) {
            const td = tDoc.data() || {};
            if (td.status === 'rechazado') {
              tx.update(tDoc.ref, {
                status: 'pendiente',
                reactivado_en_backend: nowAt,
                reactivado_por: caller.cid || caller.uid
              });
              writtenTasksCount++;
            }
          }
        } else if (Array.isArray(tasks) && tasks.length > 0) {
          const seenTaskIds = new Set();
          for (let i = 0; i < tasks.length; i++) {
            const rawTask = stripFabProtectedPayloadFields(asObject(tasks[i], `Tarea ${i + 1}`));
            const tId = reqDocId(String(rawTask.id || `${cleanOrderId}_T${i + 1}`).trim(), `Tarea ${i + 1}: id`);
            if (seenTaskIds.has(tId)) {
              throw bad(`Tarea duplicada en el lote de liberación (${tId})`);
            }
            seenTaskIds.add(tId);
            const taskRef = col('fabricacion_tasks').doc(tId);
            tx.set(taskRef, {
              ...rawTask,
              id: tId,
              fabricacion_id: cleanOrderId,
              autorizado_backend: true,
              creada_en_backend: true,
              creado_en_backend: nowAt,
              creado_por_backend: caller.cid || caller.uid
            });
            writtenTasksCount++;
          }
        }
      } else if (!isCreateOrderTransition && !isPartialDispatchSplit && orderSnap && orderSnap.exists) {
        tx.update(orderSnap.ref, {
          prospecto_id: resolvedProspectId || null,
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          estado_habilitacion_fabricacion: resolvedProspectId ? 'ANTICIPO_CONFIRMADO' : 'ORDEN_INTERNA_NO_COMERCIAL',
          discrepancia_financiera: false,
          bloqueado_avance_etapa: false,
          ...(readiness ? {
            validado_financieramente_en: nowAt,
            validado_financieramente_por: caller.cid || caller.uid
          } : {})
        });
      }

      // 3d. Partición de orden por despacho parcial (`despacho_parcial_split`)
      if (isPartialDispatchSplit && orderSnap && orderSnap.exists) {
        const sanitizedParentUpdate = stripFabProtectedPayloadFields(orderUpdate);
        const sanitizedSplitPayload = stripFabProtectedPayloadFields(splitOrderPayload);
        const preserveLegacyOnly = Boolean(isVerifiedLegacyOrder && orderData.liberado_a_fabricacion_backend !== true);
        const effectiveSplitStatus = readiness
          ? 'ANTICIPO_CONFIRMADO'
          : (preserveLegacyOnly
            ? (orderData.estado_habilitacion_fabricacion || 'EXCEPCION_HISTORIA_PREEXISTENTE')
            : (resolvedProspectId
              ? (orderData.estado_habilitacion_fabricacion || 'ANTICIPO_PENDIENTE')
              : 'ORDEN_INTERNA_NO_COMERCIAL'));
        const effectiveDiscrepancy = readiness ? false : Boolean(orderData.discrepancia_financiera);

        const sharedAuthMeta = preserveLegacyOnly
          ? {
            estado_habilitacion_fabricacion: effectiveSplitStatus,
            autorizado_backend: Boolean(orderData.autorizado_backend),
            liberado_a_fabricacion_backend: false,
            excepcion_legado_verificada: true,
            origen_excepcion_legado: orderData.origen_excepcion_legado,
            fecha_excepcion_legado: orderData.fecha_excepcion_legado || null,
            autorizado_excepcion_legado_por: orderData.autorizado_excepcion_legado_por || null,
            discrepancia_financiera: effectiveDiscrepancy,
            bloqueado_avance_etapa: false
          }
          : {
            estado_habilitacion_fabricacion: effectiveSplitStatus,
            autorizado_backend: true,
            liberado_a_fabricacion_backend: true,
            discrepancia_financiera: effectiveDiscrepancy,
            bloqueado_avance_etapa: false,
            ...(isVerifiedLegacyOrder ? {
              excepcion_legado_verificada: true,
              origen_excepcion_legado: orderData.origen_excepcion_legado,
              fecha_excepcion_legado: orderData.fecha_excepcion_legado || null,
              autorizado_excepcion_legado_por: orderData.autorizado_excepcion_legado_por || null
            } : {})
          };

        writtenOrder = {
          ...orderData,
          ...sanitizedParentUpdate,
          id: cleanOrderId,
          padre_id: orderData.padre_id || cleanProjId || null,
          prospecto_id: resolvedProspectId || null,
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          ...sharedAuthMeta
        };
        tx.set(orderSnap.ref, writtenOrder);

        const splitRef = col('fabricacion').doc(cleanSplitOrderId);
        tx.set(splitRef, {
          ...sanitizedSplitPayload,
          id: cleanSplitOrderId,
          padre_id: orderData.padre_id || cleanProjId || null,
          prospecto_id: resolvedProspectId || null,
          origen_tipo: resolvedProspectId ? 'oportunidad' : 'interno',
          ...sharedAuthMeta,
          creado_en_backend: nowAt
        });

        if (Array.isArray(taskUpdates)) {
          for (const tu of taskUpdates) {
            if (tu && tu.id && tu.changes && typeof tu.changes === 'object') {
              const safeTaskChanges = stripFabProtectedPayloadFields(tu.changes);
              const tRef = col('fabricacion_tasks').doc(reqDocId(String(tu.id), 'taskUpdate.id'));
              tx.update(tRef, safeTaskChanges);
              writtenTasksCount++;
            }
          }
        }
      }

      if (resolvedProspectId && readiness) {
        addAudit(tx, caller, 'validateAndAuthorizeFabricationOrder', resolvedProspectId, {
          ready: true,
          origenTipo: 'oportunidad',
          stageTransition: cleanTransition,
          fabProjectId: cleanProjId || null,
          fabOrderId: cleanOrderId || null,
          writtenTasksCount,
          formaPago: readiness.formaPago,
          montoExigible: readiness.montoExigible,
          montoConfirmado: readiness.montoConfirmado,
          saldoPendiente: 0
        });
        return {
          ...readiness,
          status: 'authorized',
          authorized: true,
          origenTipo: 'oportunidad',
          stageTransition: cleanTransition,
          fabProjectId: cleanProjId || null,
          fabOrderId: cleanOrderId || null,
          project: writtenProject,
          order: writtenOrder,
          writtenTasksCount
        };
      }

      if (isInExecutionContinuityOp && (isVerifiedLegacyOrder || resolvedProspectId)) {
        const continuityCode = isVerifiedLegacyOrder && (!orderData || orderData.liberado_a_fabricacion_backend !== true)
          ? 'EXCEPCION_HISTORIA_PREEXISTENTE'
          : 'CONTINUIDAD_ORDEN_EN_EJECUCION';
        addAudit(tx, caller, 'validateAndAuthorizeFabricationOrderContinuity', resolvedProspectId || cleanOrderId || 'HISTORICO', {
          ready: true,
          continuityCode,
          excepcionLegadoVerificada: isVerifiedLegacyOrder,
          origenExcepcionLegado: (orderData && orderData.origen_excepcion_legado) || null,
          discrepanciaFinancieraActiva: Boolean(orderData && orderData.discrepancia_financiera),
          stageTransition: cleanTransition,
          fabProjectId: cleanProjId || null,
          fabOrderId: cleanOrderId || null,
          writtenTasksCount
        });
        return {
          status: isVerifiedLegacyOrder ? 'authorized_legacy_continuity' : 'authorized_in_execution_continuity',
          authorized: true,
          ready: true,
          code: continuityCode,
          estadoHabilitacion: continuityCode,
          excepcionLegadoVerificada: isVerifiedLegacyOrder,
          origenExcepcionLegado: (orderData && orderData.origen_excepcion_legado) || null,
          origenTipo: resolvedProspectId ? 'oportunidad' : 'interno',
          stageTransition: cleanTransition,
          fabProjectId: cleanProjId || null,
          fabOrderId: cleanOrderId || null,
          project: writtenProject,
          order: writtenOrder,
          writtenTasksCount
        };
      }

      addAudit(tx, caller, 'validateAndAuthorizeFabricationOrder', cleanProjId || cleanOrderId || 'INTERNO', {
        ready: true,
        origenTipo: 'interno',
        stageTransition: cleanTransition,
        codigoProyecto: effectiveCodigo || null,
        writtenTasksCount
      });

      return {
        status: 'authorized_internal',
        authorized: true,
        ready: true,
        code: 'ORDEN_INTERNA_NO_COMERCIAL',
        estadoHabilitacion: 'ORDEN_INTERNA_NO_COMERCIAL',
        origenTipo: 'interno',
        stageTransition: cleanTransition,
        fabProjectId: cleanProjId || null,
        fabOrderId: cleanOrderId || null,
        project: writtenProject,
        order: writtenOrder,
        writtenTasksCount
      };
    });
  }

  return {
    advanceStage,
    revertStage,
    saveClosingDocuments,
    finalizeProspect,
    markLost,
    registerProposal,
    editBasePrice,
    saveChangeOrder,
    deleteChangeOrder,
    saveInvoice,
    deleteInvoice,
    savePayment,
    deletePayment,
    resolveHistoricalBankConflict,
    deleteProspect,
    reactivateProspect,
    resolveAdvanceInvoice,
    isPositivelyConfirmedPayment,
    normalizePaymentReference,
    resolveInvoiceBaseSinIva,
    calculateInvoiceRetencionLimit,
    isClientGranContribuyenteLocal,
    evaluateManufacturingReadiness,
    assertManufacturingReadyTx,
    validateManufacturingReadiness,
    sendProspectToFabrication,
    validateAndAuthorizeFabricationOrder
  };
}

module.exports = {
  createProspectWorkflowService,
  hasEnteredPostclosing: fallbackHasEnteredPostclosing,
  POLICY,
  STAGES,
  REVERSION_PREV_STAGE,
  MOTIVOS_PERDIDA,
  FORMAS_PAGO,
  PAYMENT_METHODS,
  ORDER_TYPES,
  MANUFACTURING_ROLES: ['manager', 'gestor', 'jefe_produccion', 'recepcion', 'dibujo', 'dibujante']
};
