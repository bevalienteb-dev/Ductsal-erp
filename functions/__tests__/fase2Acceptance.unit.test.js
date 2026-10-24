// functions/__tests__/fase2Acceptance.unit.test.js
// Automated test suite for Fase 2.1 & 2.2:
// - 2.1: Cadencia de seguimiento configurable y controlada por límites
// - 2.2: Registro automático de la fecha de entrega de la oferta en la transición Cotización -> Negociación

const fs = require('fs');
const path = require('path');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const CrmFollowUpCalc = require('../../crm_followup_calc');

// Fixed clock: Friday Oct 23, 2026, 10:00:00 AM El Salvador (16:00:00 UTC)
const CLOCK = new Date('2026-10-23T16:00:00.000Z');

function makeEnv() {
  const fdb = createFakeFirestore({ clock: () => CLOCK });
  const live = { ok: true, calls: [] };

  const commercial = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => CLOCK,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });

  const wf = createProspectWorkflowService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    kit: commercial.kit
  });

  // Seed default clients
  fdb.collection('clients_prod').doc('C1').set({ id: 'C1', nombre: 'Cliente Industrial Alfa', empresa: 'Grupo Alfa S.A. de C.V.', activo: true });

  const caller = (role, cid = 'USR-1', name = 'Vendedor Principal') => ({
    uid: `uid_${cid}`,
    cid,
    name,
    role
  });

  return { fdb, commercial, wf, caller, now: CLOCK };
}

describe('Fase 2.1 & 2.2: Cadencia Configurable y Registro Automático de Oferta', () => {

  // =========================================================================
  // FASE 2.2: REGISTRO AUTOMÁTICO DE FECHA DE ENTREGA DE OFERTA
  // =========================================================================

  test('2.2.1: Transición de Cotización a Negociación registra automáticamente fecha/hora del servidor', async () => {
    const { fdb, wf, caller } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-OFERTA-1', {
      id: 'P-OFERTA-1',
      estado: 'activo',
      etapa: 'cotizacion',
      clientId: 'C1',
      proyecto: 'Suministro de Ductos HVAC',
      tipo_proyecto: 'Fabricación',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      costo_venta: 5000,
      precio_cotizado: 8000,
      probabilidad: 'alta',
      datos: {
        doc_oferta: [{ name: 'oferta_rev1.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/oferta.pdf' }],
        doc_costos: [{ name: 'costos_rev1.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/costos.xlsx' }]
      },
      stage_timestamps: { cotizacion: '2026-10-20T10:00:00.000Z' }
    });

    const res = await wf.advanceStage({
      caller: vendor,
      prospectId: 'P-OFERTA-1',
      nextStage: 'negociacion',
      data: {
        costo_venta: 5000,
        precio_cotizado: 8000,
        probabilidad: 'alta'
      }
    });

    expect(res.status).toBe('advanced');
    expect(res.etapa).toBe('negociacion');

    const snap = await fdb.collection('prospects_prod').doc('P-OFERTA-1').get();
    const p = snap.data();

    // Fecha de entrega registrada con el timestamp del servidor
    expect(p.fecha_entrega_oferta).toBe(CLOCK.toISOString());
    expect(p.seguimiento).toBeDefined();
    expect(p.seguimiento.cadencia).toBeDefined();
    expect(p.seguimiento.cadencia.fecha_entrega_oferta).toBe(CLOCK.toISOString());
    expect(p.seguimiento.cadencia.fecha_entrega_oferta_ymd).toBe('2026-10-23');
    expect(p.seguimiento.cadencia.entregado_por_id).toBe('V-101');
    expect(p.seguimiento.cadencia.entregado_por_nombre).toBe('Alejandra Ayala');

    // Primera acción calculada automáticamente: 5 días hábiles después del 23 de octubre
    // Oct 23 es Viernes -> Sáb(medio/no externo), Dom(no) -> Lun 26(1), Mar 27(2), Mié 28(3), Jue 29(4), Vie 30(5)
    expect(p.seguimiento.proxima_accion).toBeDefined();
    expect(p.seguimiento.proxima_accion.fecha).toBe('2026-10-30');
    expect(p.seguimiento.proxima_accion.tipo).toBe('llamada');

    // Trazabilidad en logs y stage_transitions
    expect(Array.isArray(p.stage_transitions)).toBe(true);
    const trans = p.stage_transitions.find(t => t.from === 'cotizacion' && t.to === 'negociacion');
    expect(trans).toBeDefined();
    expect(trans.usuarioId).toBe('V-101');
    expect(trans.fecha).toBe(CLOCK.toISOString());

    const logEntry = p.logs.find(l => l.text.includes('Entrega de Oferta Registrada'));
    expect(logEntry).toBeDefined();
  });

  test('2.2.2: Pasar a Cotización (levantamiento -> cotizacion) NO registra fecha de entrega de oferta', async () => {
    const { fdb, wf, caller } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-COT-ONLY', {
      id: 'P-COT-ONLY',
      estado: 'activo',
      etapa: 'levantamiento',
      clientId: 'C1',
      proyecto: 'Instalación nueva',
      tipo_proyecto: 'Fabricación',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      stage_timestamps: { levantamiento: '2026-10-15T10:00:00.000Z' }
    });

    const res = await wf.advanceStage({
      caller: vendor,
      prospectId: 'P-COT-ONLY',
      nextStage: 'cotizacion',
      data: {
        costo_venta: 4000,
        precio_cotizado: 7000,
        probabilidad: 'media',
        doc_oferta: [{ name: 'oferta.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/oferta.pdf' }],
        doc_costos: [{ name: 'costos.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/costos.xlsx' }]
      }
    });

    expect(res.status).toBe('advanced');
    expect(res.etapa).toBe('cotizacion');

    const snap = await fdb.collection('prospects_prod').doc('P-COT-ONLY').get();
    const p = snap.data();
    expect(p.fecha_entrega_oferta).toBeUndefined();
    expect(p.seguimiento && p.seguimiento.cadencia && p.seguimiento.cadencia.fecha_entrega_oferta).toBeUndefined();
  });

  test('2.2.3: Idempotencia: una solicitud duplicada o reintento técnico no sobrescribe fecha original ni reinicia cadencia', async () => {
    const { fdb, wf, caller } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');
    const originalDelivery = '2026-10-15T14:30:00.000Z';

    fdb.seed('prospects_prod/P-IDEMP', {
      id: 'P-IDEMP',
      estado: 'activo',
      etapa: 'negociacion',
      clientId: 'C1',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      costo_venta: 5000,
      precio_cotizado: 8000,
      probabilidad: 'alta',
      fecha_entrega_oferta: originalDelivery,
      seguimiento: {
        cadencia: {
          fecha_entrega_oferta: originalDelivery,
          fecha_entrega_oferta_ymd: '2026-10-15',
          intentos_fallidos: 2
        },
        proxima_accion: { fecha: '2026-10-28', tipo: 'llamada', descripcion: 'Segundo contacto' }
      }
    });

    // Re-avanzar a negociacion (retry/double-click)
    const res = await wf.advanceStage({
      caller: vendor,
      prospectId: 'P-IDEMP',
      nextStage: 'negociacion',
      data: { costo_venta: 5000, precio_cotizado: 8000, probabilidad: 'alta' }
    });

    expect(res.status).toBe('unchanged');
    expect(res.etapa).toBe('negociacion');

    const snap = await fdb.collection('prospects_prod').doc('P-IDEMP').get();
    const p = snap.data();
    // La fecha original se mantiene intacta
    expect(p.fecha_entrega_oferta).toBe(originalDelivery);
    expect(p.seguimiento.cadencia.fecha_entrega_oferta).toBe(originalDelivery);
    expect(p.seguimiento.cadencia.intentos_fallidos).toBe(2);
  });

  test('2.2.4: Oportunidades históricas en Negociación sin fecha de entrega no inventan datos', () => {
    const oppHistorica = {
      id: 'OPP-HIST-1',
      estado: 'activo',
      etapa: 'negociacion',
      fecha_creacion: '2025-06-10T08:00:00.000Z',
      seguimiento: {} // sin fecha de entrega ni proxima accion
    };

    const clasif = CrmFollowUpCalc.classifyFollowUp(oppHistorica, CLOCK);

    expect(clasif.status).toBe('sin_seguimiento');
    expect(clasif.dias_retraso).toBe(0);
    expect(clasif.sin_fecha_entrega_historica).toBe(true);
    expect(clasif.motivo_agenda).toContain('Oportunidad histórica en Negociación sin fecha de entrega');
  });

  // =========================================================================
  // FASE 2.1: CADENCIA CONFIGURABLE Y CONTROLADA POR LÍMITES
  // =========================================================================

  test('2.1.1: Opciones de cadencia válidas y límites comerciales autorizados', () => {
    expect(CrmFollowUpCalc.CADENCIAS_VALIDAS).toBeDefined();
    expect(Object.keys(CrmFollowUpCalc.CADENCIAS_VALIDAS)).toEqual(['estandar', 'urgente', 'corporativa']);

    const { estandar, urgente, corporativa } = CrmFollowUpCalc.CADENCIAS_VALIDAS;

    // Estándar Ductsal
    expect(estandar.dias_primer_contacto).toBe(5);
    expect(estandar.intervalo_sin_respuesta).toBe(2);
    expect(estandar.dias_solicito_tiempo).toBe(15);

    // Proyecto Urgente / Licitación Rápida
    expect(urgente.dias_primer_contacto).toBe(3);
    expect(urgente.intervalo_sin_respuesta).toBe(2);
    expect(urgente.dias_solicito_tiempo).toBe(7);

    // Gran Cuenta / Comité Corporativo
    expect(corporativa.dias_primer_contacto).toBe(5);
    expect(corporativa.intervalo_sin_respuesta).toBe(3);
    expect(corporativa.dias_solicito_tiempo).toBe(15);

    // Límites comerciales obligatorios
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.MAX_DIAS_PRIMER_CONTACTO).toBe(5);
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.MAX_INTERVALO_SIN_RESPUESTA).toBe(3);
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.MAX_DIAS_SOLICITO_TIEMPO).toBe(15);
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.MANDATORY_CALL_ATTEMPT).toBe(2);
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.DECISION_REQUIRED_ATTEMPTS).toBe(3);
    expect(CrmFollowUpCalc.LIMITES_COMERCIALES_CADENCIA.MANAGER_ESCALATION_ATTEMPTS).toBe(5);
  });

  test('2.1.2: Validación de selección de cadencia en backend: rechaza opciones no aprobadas', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-CAD-VAL', {
      id: 'P-CAD-VAL',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101'
    });

    await expect(commercial.updateProspectCadence({
      caller: vendor,
      prospectId: 'P-CAD-VAL',
      tipoCadencia: 'cadencia_infinita_30d',
      motivo: 'Queremos espaciarlo más',
      opId: 'op_cad_val_1'
    })).rejects.toThrow('Alternativa de cadencia comercial no autorizada');
  });

  test('2.1.3: Exige motivo comercial obligatorio (mínimo 5 caracteres) para cambiar de cadencia', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-CAD-VAL-2', {
      id: 'P-CAD-VAL-2',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101'
    });

    await expect(commercial.updateProspectCadence({
      caller: vendor,
      prospectId: 'P-CAD-VAL-2',
      tipoCadencia: 'urgente',
      motivo: 'ok',
      opId: 'op_cad_val_2'
    })).rejects.toThrow('mínimo 5 caracteres');
  });

  test('2.1.4: Cambio exitoso de cadencia registra historial con trazabilidad completa (quién, cuándo, anterior, nueva, motivo)', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-CAD-OK', {
      id: 'P-CAD-OK',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      seguimiento: {
        cadencia: {
          tipo_cadencia: 'estandar',
          intentos_fallidos: 2
        }
      }
    });

    const res = await commercial.updateProspectCadence({
      caller: vendor,
      prospectId: 'P-CAD-OK',
      tipoCadencia: 'urgente',
      motivo: 'Licitación urgente con fecha de adjudicación próxima semana',
      opId: 'op_cad_change_1'
    });

    expect(res.status).toBe('updated');
    expect(res.tipoCadencia).toBe('urgente');
    expect(res.cadencia.intentos_fallidos).toBe(2); // Invariante: no se reinicia el contador

    const snap = await fdb.collection('prospects_prod').doc('P-CAD-OK').get();
    const p = snap.data();

    expect(p.seguimiento.cadencia.tipo_cadencia).toBe('urgente');
    expect(Array.isArray(p.seguimiento.cadencia.historial_cambios)).toBe(true);
    expect(p.seguimiento.cadencia.historial_cambios.length).toBe(1);

    const chg = p.seguimiento.cadencia.historial_cambios[0];
    expect(chg.cadenciaAnterior).toBe('estandar');
    expect(chg.cadenciaNueva).toBe('urgente');
    expect(chg.usuarioId).toBe('V-101');
    expect(chg.usuarioNombre).toBe('Alejandra Ayala');
    expect(chg.motivo).toBe('Licitación urgente con fecha de adjudicación próxima semana');
    expect(chg.fecha).toBe(CLOCK.toISOString());

    // Registro en bitácora de logs
    const logEntry = p.logs.find(l => l.text.includes('[CADENCIA COMERCIAL]'));
    expect(logEntry).toBeDefined();
    expect(logEntry.text).toContain('estandar');
    expect(logEntry.text).toContain('urgente');
  });

  test('2.1.5: Invariante estricto: Ninguna cadencia permite eludir llamada obligatoria (intento 2)', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    // Oportunidad con cadencia corporativa (ciclo extendido) en intento 1 fallido
    fdb.seed('prospects_prod/P-INV-CALL', {
      id: 'P-INV-CALL',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      seguimiento: {
        cadencia: {
          tipo_cadencia: 'corporativa',
          intentos_fallidos: 1
        }
      }
    });

    // Intentar registrar intento 2 por correo (no llamada) debe ser rechazado
    await expect(commercial.recordFollowUp({
      caller: vendor,
      prospectId: 'P-INV-CALL',
      data: {
        canal: 'correo',
        resultado: 'sin_respuesta',
        detalle: 'Segundo correo enviado'
      },
      opId: 'op_inv_call_1'
    })).rejects.toThrow('segundo intento de contacto debe realizarse mediante llamada telefónica obligatoria');
  });

  test('2.1.6: Invariante estricto: Ninguna cadencia permite evitar la justificación comercial al 3er intento', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    // Oportunidad con cadencia urgente en 3 intentos fallidos
    fdb.seed('prospects_prod/P-INV-JUST', {
      id: 'P-INV-JUST',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      seguimiento: {
        cadencia: {
          tipo_cadencia: 'urgente',
          intentos_fallidos: 3,
          estado_cadencia: 'requiere_decision_vendedor'
        }
      }
    });

    // Registrar 4to intento sin justificación debe ser rechazado
    await expect(commercial.recordFollowUp({
      caller: vendor,
      prospectId: 'P-INV-JUST',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Cliente no atendió la llamada',
        justificacion_continuidad: ''
      },
      opId: 'op_inv_just_1'
    })).rejects.toThrow('obligatorio registrar la justificación de continuidad comercial');
  });

  test('2.1.7: Invariante estricto: Al 5to intento fallido escala obligatoriamente a Gerencia bajo cualquier cadencia', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    // Oportunidad con 4 intentos fallidos bajo cadencia corporativa
    fdb.seed('prospects_prod/P-INV-ESC', {
      id: 'P-INV-ESC',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      seguimiento: {
        cadencia: {
          tipo_cadencia: 'corporativa',
          intentos_fallidos: 4,
          justificacion_continuidad: 'Esperando sesión de junta directiva'
        }
      }
    });

    const res = await commercial.recordFollowUp({
      caller: vendor,
      prospectId: 'P-INV-ESC',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: '5to intento sin respuesta en gerencia del cliente',
        justificacion_continuidad: 'Esperando sesión de junta directiva'
      },
      opId: 'op_inv_esc_1'
    });

    expect(res.seguimiento.cadencia.intentos_fallidos).toBe(5);
    expect(res.seguimiento.cadencia.alerta_gerencial).toBe(true);
    expect(res.seguimiento.cadencia.estado_cadencia).toBe('escalado_gerencia');
    expect(res.seguimiento.cadencia.fecha_escalacion).toBeDefined();
  });

  // =========================================================================
  // FASE 2.3: CLASIFICACIÓN COMERCIAL (PRESUPUESTO VS EJECUCIÓN)
  // =========================================================================

  test('2.3.1: Oportunidad con clasificación "presupuesto" no puede avanzar a Negociación', async () => {
    const { fdb, wf, caller } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-PRESUP-1', {
      id: 'P-PRESUP-1',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      clientId: 'C1',
      proyecto: 'Cotización referencial para licitación futura',
      tipo_proyecto: 'Fabricación',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      costo_venta: 3000,
      precio_cotizado: 5000,
      probabilidad: 'baja',
      datos: {
        doc_oferta: [{ name: 'oferta_est.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/oferta.pdf' }],
        doc_costos: [{ name: 'costos_est.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/costos.xlsx' }]
      }
    });

    await expect(wf.advanceStage({
      caller: vendor,
      prospectId: 'P-PRESUP-1',
      nextStage: 'negociacion',
      data: { costo_venta: 3000, precio_cotizado: 5000, probabilidad: 'baja' }
    })).rejects.toThrow('Esta oportunidad está clasificada como "Cotización para presupuesto"');
  });

  test('2.3.2: Reclasificación comercial exige motivo de al menos 5 caracteres', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-RECLASS-VAL', {
      id: 'P-RECLASS-VAL',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      vendedorId: 'V-101',
      createdBy: 'V-101'
    });

    await expect(commercial.reclassifyProspect({
      caller: vendor,
      prospectId: 'P-RECLASS-VAL',
      clasificacion: 'ejecucion',
      motivo: 'ok',
      opId: 'op_reclass_short'
    })).rejects.toThrow('El motivo del cambio de clasificación debe tener al menos 5 caracteres');
  });

  test('2.3.3: Reclasificación exitosa a "ejecucion" registra historial_clasificacion, logs y auditoría', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-RECLASS-OK', {
      id: 'P-RECLASS-OK',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      proyecto: 'Sistema HVAC Plaza San Benito'
    });

    const res = await commercial.reclassifyProspect({
      caller: vendor,
      prospectId: 'P-RECLASS-OK',
      clasificacion: 'ejecucion',
      motivo: 'Cliente aprobó partida presupuestaria e invitó a negociar cierre de contrato',
      opId: 'op_reclass_success_1'
    });

    expect(res.status).toBe('reclassified');
    expect(res.clasificacion).toBe('ejecucion');
    expect(res.historial_clasificacion).toHaveLength(1);
    expect(res.historial_clasificacion[0]).toMatchObject({
      clasificacionAnterior: 'presupuesto',
      clasificacionNueva: 'ejecucion',
      usuarioId: 'V-101',
      motivo: 'Cliente aprobó partida presupuestaria e invitó a negociar cierre de contrato'
    });

    const snap = await fdb.collection('prospects_prod').doc('P-RECLASS-OK').get();
    const p = snap.data();
    expect(p.clasificacion).toBe('ejecucion');
    expect(p.logs.some(l => l.text.includes('[CLASIFICACIÓN COMERCIAL]'))).toBe(true);
  });

  test('2.3.4: Reclasificación es idempotente ante reintentos con el mismo opId', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-RECLASS-IDEM', {
      id: 'P-RECLASS-IDEM',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      vendedorId: 'V-101',
      createdBy: 'V-101'
    });

    const res1 = await commercial.reclassifyProspect({
      caller: vendor,
      prospectId: 'P-RECLASS-IDEM',
      clasificacion: 'ejecucion',
      motivo: 'Confirmación comercial del cliente para ejecutar este trimestre',
      opId: 'op_reclass_idem_1'
    });
    expect(res1.status).toBe('reclassified');

    // Mismo opId (reintento por latencia de red)
    const res2 = await commercial.reclassifyProspect({
      caller: vendor,
      prospectId: 'P-RECLASS-IDEM',
      clasificacion: 'ejecucion',
      motivo: 'Confirmación comercial del cliente para ejecutar este trimestre',
      opId: 'op_reclass_idem_1'
    });
    expect(res2.replay).toBe(true);
    expect(res2.clasificacion).toBe('ejecucion');

    const snap = await fdb.collection('prospects_prod').doc('P-RECLASS-IDEM').get();
    expect(snap.data().historial_clasificacion).toHaveLength(1); // No duplicado
  });

  test('2.3.5: Tras ser reclasificada a "ejecucion", la oportunidad puede avanzar a Negociación', async () => {
    const { fdb, wf, commercial, caller } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    fdb.seed('prospects_prod/P-RECLASS-THEN-ADV', {
      id: 'P-RECLASS-THEN-ADV',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      clientId: 'C1',
      proyecto: 'Reconversión de Planta San Andrés',
      tipo_proyecto: 'Fabricación',
      vendedorId: 'V-101',
      createdBy: 'V-101',
      costo_venta: 12000,
      precio_cotizado: 18000,
      probabilidad: 'media',
      datos: {
        doc_oferta: [{ name: 'oferta_rev0.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/oferta.pdf' }],
        doc_costos: [{ name: 'costos_rev0.xlsx', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/costos.xlsx' }]
      }
    });

    // 1. Reclasificar a ejecución
    await commercial.reclassifyProspect({
      caller: vendor,
      prospectId: 'P-RECLASS-THEN-ADV',
      clasificacion: 'ejecucion',
      motivo: 'El cliente confirmó que el proyecto entra a ejecución y solicita ajustar propuesta final',
      opId: 'op_then_adv_1'
    });

    // 2. Ahora avanzar a negociación debe ser exitoso
    const advRes = await wf.advanceStage({
      caller: vendor,
      prospectId: 'P-RECLASS-THEN-ADV',
      nextStage: 'negociacion',
      data: { costo_venta: 12000, precio_cotizado: 18000, probabilidad: 'media' }
    });

    expect(advRes.status).toBe('advanced');
    expect(advRes.etapa).toBe('negociacion');

    const snap = await fdb.collection('prospects_prod').doc('P-RECLASS-THEN-ADV').get();
    expect(snap.data().fecha_entrega_oferta).toBe(CLOCK.toISOString());
  });

  test('2.3.6: Presupuestos referenciales no aparecen en agenda de llamadas y no distorsionan pipeline', () => {
    const pPresupuesto = {
      id: 'P-PRE-AGENDA',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      precio_cotizado: 50000,
      probabilidad: 50
    };

    const classified = CrmFollowUpCalc.classifyFollowUp(pPresupuesto, CLOCK);
    expect(classified.inAgenda).toBe(false);
    expect(classified.isPresupuesto).toBe(true);
  });

  test('2.3.7: Clasificación se persiste y recupera desde creación con createProspect', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'V-101', 'Alejandra Ayala');

    const res = await commercial.createProspect({
      caller: vendor,
      data: {
        clientId: 'C1',
        proyecto: 'Estudio de Pre-factibilidad Hospital',
        origen: 'Llamada telefónica',
        tipo_proyecto: 'Fabricación',
        tipo_producto: 'Ducto',
        clasificacion: 'presupuesto'
      },
      opId: 'op_create_presupuesto_1'
    });

    expect(res.status).toBe('created');
    expect(res.prospect).toBeDefined();

    const snap = await fdb.collection('prospects_prod').doc(res.prospect.id).get();
    const p = snap.data();
    expect(p.clasificacion).toBe('presupuesto');
    expect(p.estado).toBe('activo');
    expect(p.etapa).toBe('prospecto');
  });

  test('2.3.8: Oportunidades presupuestarias dormidas no inflan las alertas gerenciales', () => {
    const dormido = {
      id: 'P-DORMIDO-1',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      proyecto: 'Estimación Referencial Edificio Corporativo',
      vendedorId: 'V-101',
      costo_venta: 20000,
      precio_cotizado: 30000,
      fecha_creacion: '2026-08-01T10:00:00.000Z',
      stage_timestamps: { cotizacion: '2026-08-05T10:00:00.000Z' }
    };

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([dormido], null, { filterEstado: 'pendientes' });
    expect(attention.pendingUniqueCount).toBe(0);
    expect(attention.items).toHaveLength(0);
  });

  test('2.3.9: Permisos por rol: vendedor solo puede reclasificar sus propias oportunidades', async () => {
    const { commercial, caller, fdb } = makeEnv();
    const vendor1 = caller('vendedor', 'V-101', 'Alejandra Ayala');
    const vendor2 = caller('vendedor', 'V-102', 'Roberto Flores');
    const manager = caller('manager', 'M-001', 'Gerencia General');

    fdb.seed('prospects_prod/P-ROL-CHECK', {
      id: 'P-ROL-CHECK',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      vendedorId: 'V-101',
      createdBy: 'V-101'
    });

    // Vendedor 2 no puede modificar oportunidad asignada a Vendedor 1
    await expect(commercial.reclassifyProspect({
      caller: vendor2,
      prospectId: 'P-ROL-CHECK',
      clasificacion: 'ejecucion',
      motivo: 'Intento de cambio no autorizado',
      opId: 'op_rol_fail'
    })).rejects.toThrow('No tienes acceso a esta oportunidad');

    // Manager sí puede reclasificar cualquier oportunidad
    const resMgr = await commercial.reclassifyProspect({
      caller: manager,
      prospectId: 'P-ROL-CHECK',
      clasificacion: 'ejecucion',
      motivo: 'Aprobación gerencial para proceder a ejecución',
      opId: 'op_rol_mgr_ok'
    });
    expect(resMgr.status).toBe('reclassified');
  });

  test('2.3.10: Oportunidad presupuestaria conserva su información, cotización y responsable sin marcarse como perdida ni cerrada', async () => {
    const { fdb } = makeEnv();
    const pData = {
      id: 'P-PRE-CONSERVA',
      estado: 'activo',
      etapa: 'cotizacion',
      clasificacion: 'presupuesto',
      clientId: 'C1',
      proyecto: 'Diseño Preliminar Torre 4',
      tipo_proyecto: 'Fabricación e instalación',
      tipo_producto: 'Chute',
      vendedorId: 'V-101',
      costo_venta: 15000,
      precio_cotizado: 22000,
      probabilidad: 'media',
      datos: {
        doc_oferta: [{ name: 'presupuesto_v1.pdf', url: 'https://firebasestorage.googleapis.com/v0/b/bucket/presupuesto_v1.pdf' }]
      }
    };
    fdb.seed('prospects_prod/P-PRE-CONSERVA', pData);

    const classified = CrmFollowUpCalc.classifyFollowUp(pData, CLOCK);
    expect(classified.inAgenda).toBe(false);
    expect(classified.status).toBe('al_dia');

    // Comprobar que en Firestore el documento permanece activo y con todos sus datos
    const snap = await fdb.collection('prospects_prod').doc('P-PRE-CONSERVA').get();
    const p = snap.data();
    expect(p.estado).toBe('activo');
    expect(p.precio_cotizado).toBe(22000);
    expect(p.costo_venta).toBe(15000);
    expect(p.vendedorId).toBe('V-101');
    expect(p.datos.doc_oferta).toHaveLength(1);
  });

  test('UI Verification: index.html elimina campos manuales y contiene modales de Cadencia y Reclasificación', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Debe haberse eliminado el input y box de fecha de entrega manual
    expect(htmlContent).not.toContain('id="followup-fecha-entrega-box"');
    expect(htmlContent).not.toContain('id="followup-fecha-entrega-oferta"');

    // Debe existir el modal de configuración de cadencia
    expect(htmlContent).toContain('id="cadenceModal"');
    expect(htmlContent).toContain('id="cadence-select-tipo"');
    expect(htmlContent).toContain('id="cadence-motivo"');
    expect(htmlContent).toContain('value="estandar"');
    expect(htmlContent).toContain('value="urgente"');
    expect(htmlContent).toContain('value="corporativa"');

    // Debe existir el modal de reclasificación comercial
    expect(htmlContent).toContain('id="reclassifyModal"');
    expect(htmlContent).toContain('id="reclassify-select"');
    expect(htmlContent).toContain('id="reclassify-motivo"');
    expect(htmlContent).toContain('id="reclassify-desc-box"');
  });

});
