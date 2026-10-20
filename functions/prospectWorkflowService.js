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
const { ServiceError } = require('./clientsService');
const { validators } = require('./commercialService');

const { bad, asObject, reqString, reqDocId, reqOpId } = validators;

const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
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
  markLost: ['manager', 'gestor', 'vendedor'],
  registerProposal: ['manager', 'gestor', 'vendedor'],
  // Postcierre (Proyectos y cobros): only manager and gestor. Vendedor is prohibited.
  saveChangeOrder: ['manager', 'gestor'],
  deleteChangeOrder: ['manager', 'gestor'],
  saveInvoice: ['manager', 'gestor'],
  deleteInvoice: ['manager', 'gestor'],
  savePayment: ['manager', 'gestor'],
  deletePayment: ['manager', 'gestor'],
  // Approved decision: only manager / gestor, and only BEFORE the opportunity is closed (checked against the stored state).
  editBasePrice: ['manager', 'gestor'],
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

function createProspectWorkflowService({ db, FieldValue, kit, fileUrlPrefixes = ['https://firebasestorage.googleapis.com/v0/b/'] }) {
  if (!kit || typeof kit.col !== 'function') throw new Error('kit is required');
  const { col, iso, logEntry, logsOf, auditEntry, auditRef, requireProspectAccess, requireManager, hasEnteredPostclosing = (p => p && (p.postcierre_habilitado === true || !!p.fecha_cierre || (p.stage_timestamps && !!p.stage_timestamps.cierre) || (Array.isArray(p.facturas) && p.facturas.length > 0))) } = kit;

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
    return s.exists ? (s.data() || {}) : null;
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
    if (!hasEnteredPostclosing(p)) throw precondition('Esta operación solo está disponible en proyectos que hayan ingresado válidamente a Proyectos y cobros');
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
  async function advanceStage({ caller, prospectId, nextStage, data }) {
    authorize(caller, 'advanceStage');
    reqDocId(prospectId, 'prospectId');
    if (!STAGES.includes(nextStage) || nextStage === 'prospecto') throw bad('Etapa inválida');
    data = (data === undefined || data === null) ? {} : asObject(data, 'Datos de la etapa');

    // Validation that does not depend on the stored document happens first (no reads wasted on a malformed request).
    const input = parseStageInput(nextStage, data);

    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      if (p.etapa === nextStage) return { status: 'unchanged', etapa: p.etapa, estado: p.estado }; // retry / double click
      if (p.estado !== 'activo') throw precondition('Solo las oportunidades activas pueden avanzar de etapa');
      const idx = STAGES.indexOf(p.etapa);
      if (idx === -1 || STAGES[idx + 1] !== nextStage) throw precondition(`No se puede pasar de "${p.etapa}" a "${nextStage}": las etapas se avanzan de una en una`);
      const client = nextStage === 'cierre' ? await loadClient(tx, p) : null;
      if (nextStage === 'cierre' && !client) throw notFound('Cliente de la oportunidad');

      const at = iso();
      const datos = { ...(p.datos && typeof p.datos === 'object' ? p.datos : {}) };
      const patch = {};
      let logMsg = `Avanzó a etapa: ${nextStage}.`;

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
        if (input.doc_oferta.length > 0) datos.doc_oferta = input.doc_oferta;
        if (input.doc_costos.length > 0) datos.doc_costos = input.doc_costos;
        logMsg += ` (Cotizado: ${fmtMoney(input.precio_cotizado)}, Costo: ${fmtMoney(input.costo_venta)})`;
      } else {
        // cierre: the client record must be complete, the DUI document must exist and the contract rules apply.
        const missing = missingClientFields(client);
        if (missing.length > 0) throw precondition(`El cliente tiene información incompleta para cerrar la venta. Faltan: ${missing.join(', ')}`);
        const docs = client.documentos && typeof client.documentos === 'object' ? client.documentos : {};
        if (!docs.dui) throw precondition('Falta el DUI (del representante o cliente) en el Directorio de Clientes: súbelo antes de cerrar el proyecto');
        const isBig = p.tipo_proyecto === 'Fabricación e instalación' && Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000;
        // The exception is the manager's decision STORED on the opportunity (setNoContractAuthorizationAdmin): the request
        // cannot claim it.
        const bypass = isBig && datos.autorizado_sin_contrato === true;
        if (isBig && !bypass && client.tipo === 'juridica' && !(docs.escritura && docs.credencial && docs.nit && docs.nrc)) {
          throw precondition('Para cerrar con contrato hay que adjuntar antes los documentos legales de la empresa (Escritura, Credencial, NIT, NRC)');
        }
        if (p.tipo_proyecto === 'Fabricación e instalación') {
          if (!input.encargado) throw bad('Debe asignar un Encargado de Instalación');
          patch.encargado = input.encargado; logMsg += ` (Encargado: ${input.encargado})`;
        }
        if (bypass) logMsg += ` (Autorizado sin contrato por gerente: ${datos.autorizado_por || 'Gerente'})`;
        if (isBig && !bypass) datos.doc_contrato = input.doc_firmado; else datos.doc_oferta_firmada = input.doc_firmado;
        datos.doc_comprobante = input.doc_comprobante;

        const subtotal = Number(p.precio_cotizado) || 0;
        const totalConIVA = isExport(client) ? subtotal : subtotal * IVA;
        const advanceAmount = round2(totalConIVA * FORMAS_PAGO[input.forma_pago]); // cents: the page stored e.g. 7909.999999999998
        patch.forma_pago = input.forma_pago;
        patch.estado = 'ganado'; patch.probabilidad = 100; patch.fecha_cierre = at;
        patch.postcierre_habilitado = true; patch.fecha_postcierre = at;
        patch.facturas = [{ id: uniqueId([], Date.now()), numero: input.factura_anticipo, monto: advanceAmount, doc_factura: input.doc_comprobante, pagos: [], fecha: at }];
        logMsg = `¡VENTA CERRADA! Proyecto ${p.codigo || ''} generado con factura PENDIENTE ${input.factura_anticipo} por ${fmtMoney(advanceAmount)}`;
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

      tx.update(ref, {
        ...patch, datos, etapa: nextStage,
        stage_timestamps: { ...(p.stage_timestamps && typeof p.stage_timestamps === 'object' ? p.stage_timestamps : {}), [nextStage]: at },
        logs: withLog(p, caller, logMsg)
      });
      addAudit(tx, caller, nextStage === 'cierre' ? 'closeSale' : 'advanceStage', prospectId, { from: p.etapa, to: nextStage });
      return { status: 'advanced', etapa: nextStage, estado: patch.estado || p.estado };
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
    if (!Object.prototype.hasOwnProperty.call(FORMAS_PAGO, d.forma_pago)) throw bad('Forma de pago inválida');
    return {
      forma_pago: d.forma_pago,
      factura_anticipo: reqString(d.factura_anticipo, 'El número de factura de anticipo', 60),
      encargado: optString(d.encargado, 'El encargado', 120),
      doc_firmado: fileRef(d.doc_firmado, 'Contrato u oferta firmada'),
      doc_comprobante: fileRef(d.doc_comprobante, 'Factura o comprobante de anticipo')
    };
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
      datos.doc_oferta = oferta; datos.doc_costos = costos;
      const text = `NUEVA PROPUESTA: Precio ${fmtMoney(precio)}, Costo ${fmtMoney(costo)}. Docs: ${oferta.map(f => f.name).join(', ')}, ${costos.map(f => f.name).join(', ')}`;
      tx.update(ref, { costo_venta: costo, precio_cotizado: precio, datos, logs: withLog(p, caller, text) });
      addAudit(tx, caller, 'registerProposal', prospectId, { precioFrom: p.precio_cotizado || 0, precioTo: precio, costoFrom: p.costo_venta || 0, costoTo: costo });
      return { status: 'registered' };
    });
  }

  async function editBasePrice({ caller, prospectId, precio, costo, motivo }) {
    authorize(caller, 'editBasePrice');
    reqDocId(prospectId, 'prospectId');
    const newPrice = money(precio, 'El precio');
    const newCost = money(costo, 'El costo');
    const reason = reqString(motivo, 'El motivo de la corrección', 300);
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      // The STORED state decides, never what the page believes: after the closing (ganado / perdido) the price is frozen,
      // because the advance invoice was computed from it at closing and the invoices / payments / change orders hang from it.
      if (p.estado !== 'activo') throw precondition('El precio y el costo base solo pueden corregirse antes del cierre de la oportunidad');
      const oldP = p.precio_cotizado || 0; const oldC = p.costo_venta || 0;
      if (oldP === newPrice && oldC === newCost) return { status: 'unchanged' };
      tx.update(ref, {
        precio_cotizado: newPrice, costo_venta: newCost,
        logs: withLog(p, caller, `Corrección de sistema: Precio original modificado de ${fmtMoney(oldP)} a ${fmtMoney(newPrice)} y Costo de ${fmtMoney(oldC)} a ${fmtMoney(newCost)}. Motivo: ${reason}`)
      });
      addAudit(tx, caller, 'editBasePrice', prospectId, { precioFrom: oldP, precioTo: newPrice, costoFrom: oldC, costoTo: newCost, motivo: reason });
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
  async function saveInvoice({ caller, prospectId, invoiceId, numero, monto, doc_factura, opId }) {
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
      if (editing) {
        const cur = facturas[idx];
        if (cur.numero === number && cur.monto === amount && !doc) return { status: 'unchanged' };
        invoice = { ...cur, numero: number, monto: amount };
        if (doc) invoice.doc_factura = doc;
        facturas[idx] = invoice;
        text = `Factura editada: ${number} por ${fmtMoney(amount)}`;
      } else {
        invoice = { id: uniqueId(facturas.map(f => f && f.id), Date.now()), numero: number, monto: amount, doc_factura: doc, pagos: [], fecha: iso(), opId };
        facturas.push(invoice);
        text = `Factura/CCF emitida: ${number} por ${fmtMoney(amount)}`;
      }
      tx.update(ref, { facturas, logs: withLog(p, caller, text) });
      addAudit(tx, caller, editing ? 'editInvoice' : 'createInvoice', prospectId, { invoiceId: invoice.id, numero: number, monto: amount });
      return { status: editing ? 'updated' : 'created', invoice };
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
      if (i === 0) throw precondition('Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error');
      const f = facturas[i];
      tx.update(ref, { facturas: facturas.slice(0, i).concat(facturas.slice(i + 1)), logs: withLog(p, caller, `Factura eliminada: ${f.numero} (${fmtMoney(f.monto)})`) });
      addAudit(tx, caller, 'deleteInvoice', prospectId, { invoiceId, numero: f.numero, monto: f.monto, payments: (f.pagos || []).length });
      addDeletionNotice(tx, caller, p, client, 'Factura', `${f.numero} (${fmtMoney(f.monto)})`);
      return { status: 'deleted' };
    });
  }

  // =====================================================================================================
  // Payments
  // =====================================================================================================
  // A payment is addressed by `paymentKey` = its id (new payments) or its `fecha` (historical ones have no id): never by
  // array position, which is stale as soon as someone else edits the same invoice.
  const payKeyMatches = (pay, key) => !!pay && (pay.id === key || pay.fecha === key);

  async function savePayment({ caller, prospectId, invoiceId, paymentKey, monto, metodo, ref: reference, doc_comprobante, opId }) {
    authorize(caller, 'savePayment');
    reqDocId(prospectId, 'prospectId'); reqDocId(invoiceId, 'invoiceId');
    const editing = paymentKey !== undefined && paymentKey !== null && paymentKey !== '';
    if (editing) reqString(paymentKey, 'paymentKey', 64); else reqOpId(opId);
    const amount = money(monto, 'El monto del abono', { positive: true });
    if (!PAYMENT_METHODS.includes(metodo)) throw bad('Forma de pago inválida');
    const refText = reqString(reference, 'La referencia', 100);
    const doc = (doc_comprobante === undefined || doc_comprobante === null) ? null : fileRef(doc_comprobante, 'Comprobante de pago');
    if (!editing && !doc) throw bad('Debe adjuntar el comprobante de pago');
    return db.runTransaction(async tx => {
      const { ref: pRef, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p).map(f => ({ ...f, pagos: Array.isArray(f.pagos) ? f.pagos.slice() : [] }));
      if (!editing) {
        for (const f of facturas) {
          const prior = f.pagos.find(x => x && x.opId === opId);
          if (prior) {
            if (f.id !== invoiceId || prior.monto !== amount || prior.metodo !== metodo || prior.ref !== refText) throw precondition('opId ya usado con otros datos');
            return { status: 'unchanged', replay: true };
          }
        }
      }
      const fac = facturas.find(f => f && f.id === invoiceId);
      if (!fac) throw notFound('Factura');
      if (metodo === 'retencion_1pct' && !(client && truthyFlag(client.is_gran_contribuyente))) {
        throw precondition('La retención del 1% solo aplica a clientes Gran Contribuyente');
      }
      const at = editing ? fac.pagos.findIndex(x => payKeyMatches(x, paymentKey)) : -1;
      if (editing && at === -1) throw notFound('Abono');
      const collected = fac.pagos.reduce((a, x, i) => (i === at ? a : a + (parseFloat(x.monto) || 0)), 0);
      const pending = (Number(fac.monto) || 0) - collected;
      if (exceeds(amount, pending)) throw precondition(`El abono supera el saldo de esta factura. Saldo pendiente: ${fmtMoney(pending)}`);

      let payment; let text;
      if (editing) {
        const cur = fac.pagos[at];
        if (cur.monto === amount && cur.metodo === metodo && cur.ref === refText && !doc) return { status: 'unchanged' };
        payment = { ...cur, monto: amount, metodo, ref: refText };
        if (doc) payment.doc_comprobante = doc;
        fac.pagos[at] = payment;
        text = `Abono editado en factura ${fac.numero}: ${fmtMoney(amount)} [${metodo}]`;
      } else {
        payment = { id: uniqueId(fac.pagos.map(x => x && x.id), Date.now()), monto: amount, metodo, ref: refText, doc_comprobante: doc, fecha: iso(), opId };
        fac.pagos.push(payment);
        text = `Pago recibido: ${fmtMoney(amount)} vía ${metodo} a cuenta de Factura ${fac.numero}`;
      }
      tx.update(pRef, { facturas, logs: withLog(p, caller, text) });
      addAudit(tx, caller, editing ? 'editPayment' : 'createPayment', prospectId, { invoiceId, numero: fac.numero, monto: amount, metodo });
      return { status: editing ? 'updated' : 'created', payment };
    });
  }

  async function deletePayment({ caller, prospectId, invoiceId, paymentKey }) {
    authorize(caller, 'deletePayment');
    reqDocId(prospectId, 'prospectId'); reqDocId(invoiceId, 'invoiceId');
    reqString(paymentKey, 'paymentKey', 64);
    return db.runTransaction(async tx => {
      const { ref, p } = await loadProspect(tx, caller, prospectId);
      requirePostclosing(p);
      const client = await loadClient(tx, p);
      const facturas = facturasOf(p).map(f => ({ ...f, pagos: Array.isArray(f.pagos) ? f.pagos.slice() : [] }));
      const fac = facturas.find(f => f && f.id === invoiceId);
      if (!fac) throw notFound('Factura');
      const at = fac.pagos.findIndex(x => payKeyMatches(x, paymentKey));
      if (at === -1) return { status: 'absent' };
      const pay = fac.pagos[at];
      fac.pagos.splice(at, 1);
      tx.update(ref, { facturas, logs: withLog(p, caller, `Abono eliminado de factura ${fac.numero}: ${fmtMoney(pay.monto)}`) });
      addAudit(tx, caller, 'deletePayment', prospectId, { invoiceId, numero: fac.numero, monto: pay.monto, metodo: pay.metodo });
      addDeletionNotice(tx, caller, p, client, 'Abono', `${fmtMoney(pay.monto)} de la factura ${fac.numero}`);
      return { status: 'deleted' };
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
    return db.runTransaction(async tx => {
      const ref = col('prospects').doc(prospectId);
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 'absent' }; // never existed (or deleted by the previous, physical implementation)
      const p = snap.data() || {};
      if (p.eliminado === true) return { status: 'unchanged' }; // retry / double click: the first reason and author stay
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

      tx.update(ref, {
        eliminado: true, eliminado_por_id: caller.cid, eliminado_por: caller.name || '', fecha_eliminacion: iso(), motivo_eliminacion: reason,
        logs: withLog(p, caller, `Oportunidad ELIMINADA (eliminación lógica) por ${caller.name || 'gerente'}. Motivo: ${reason}`)
      });
      for (const v of vendorsToRemove) {
        tx.update(col('clients').doc(p.clientId), {
          closingVendors: FieldValue.arrayRemove(v)
        });
      }
      addAudit(tx, caller, 'deleteProspect', prospectId, { logical: true, motivo: reason, codigo: p.codigo || null, proyecto: p.proyecto || null, clientId: p.clientId || null, etapa: p.etapa || null, estado: p.estado || null });
      addDeletionNotice(tx, caller, p, client, 'Proyecto', `Proyecto completo (${p.codigo || p.id}) eliminado. Motivo: ${reason}`);
      return { status: 'deleted' };
    });
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

  return { advanceStage, markLost, registerProposal, editBasePrice, saveChangeOrder, deleteChangeOrder, saveInvoice, deleteInvoice, savePayment, deletePayment, deleteProspect, reactivateProspect };
}

module.exports = { createProspectWorkflowService, POLICY, STAGES, MOTIVOS_PERDIDA, FORMAS_PAGO, PAYMENT_METHODS, ORDER_TYPES };
