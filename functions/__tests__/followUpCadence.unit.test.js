// functions/__tests__/followUpCadence.unit.test.js
// Automated test suite for Section 8: Follow-up Cadence & Daily Agenda

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const CrmFollowUpCalc = require('../../crm_followup_calc');

const CLOCK = new Date('2026-10-23T12:00:00.000Z'); // Friday, Oct 23, 2026

function makeEnv() {
  const fdb = createFakeFirestore({ clock: () => CLOCK });
  const live = { ok: true, calls: [] };
  const service = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => CLOCK,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });
  const wf = createProspectWorkflowService({ db: fdb, FieldValue: fdb.FieldValue, kit: service.kit });

  const caller = (role, cid = 'USR-V1') => ({
    uid: `uid_${cid}`,
    cid,
    name: `User ${cid}`,
    role
  });

  return { fdb, service, wf, caller, now: CLOCK };
}

describe('Pruebas Obligatorias de Cadencia Comercial y Agenda Diaria', () => {

  // =========================================================================
  // 1. Seguimiento que vence hoy, mañana y que ya está vencido
  // =========================================================================
  test('1. Clasificación temporal: identifica vencidas, para hoy y próximas', () => {
    const todayStr = '2026-10-23';
    const yesterdayStr = '2026-10-22';
    const tomorrowStr = '2026-10-24';
    const farFutureStr = '2026-11-15';

    // Vencida ayer
    const oppVencida = {
      id: 'OPP-1',
      estado: 'activo',
      seguimiento: {
        proxima_accion: { fecha: yesterdayStr, descripcion: 'Llamar al cliente' }
      }
    };
    const c1 = CrmFollowUpCalc.classifyFollowUp(oppVencida, CLOCK);
    expect(c1.status).toBe('vencida');
    expect(c1.dias_retraso).toBe(1);
    expect(c1.inAgenda).toBe(true);

    // Para hoy
    const oppHoy = {
      id: 'OPP-2',
      estado: 'activo',
      seguimiento: {
        proxima_accion: { fecha: todayStr, descripcion: 'Reunión acordada' }
      }
    };
    const c2 = CrmFollowUpCalc.classifyFollowUp(oppHoy, CLOCK);
    expect(c2.status).toBe('hoy');
    expect(c2.dias_retraso).toBe(0);
    expect(c2.inAgenda).toBe(true);

    // Próxima (mañana)
    const oppProxima = {
      id: 'OPP-3',
      estado: 'activo',
      seguimiento: {
        proxima_accion: { fecha: tomorrowStr, descripcion: 'Enviar correo' }
      }
    };
    const c3 = CrmFollowUpCalc.classifyFollowUp(oppProxima, CLOCK);
    expect(c3.status).toBe('proxima');
    expect(c3.dias_retraso).toBe(0);
    expect(c3.inAgenda).toBe(true);

    // Al día (futuro lejano)
    const oppAlDia = {
      id: 'OPP-4',
      estado: 'activo',
      seguimiento: {
        proxima_accion: { fecha: farFutureStr, descripcion: 'Seguimiento mensual' }
      }
    };
    const c4 = CrmFollowUpCalc.classifyFollowUp(oppAlDia, CLOCK);
    expect(c4.status).toBe('al_dia');
    expect(c4.inAgenda).toBe(false);
  });

  // =========================================================================
  // 2. Cálculo de días hábiles en fines de semana
  // =========================================================================
  test('2. Días hábiles: salta correctamente sábados y domingos', () => {
    // 2026-10-23 es Viernes
    const friday = new Date(2026, 9, 23); // Oct 23, 2026

    // +1 día hábil desde viernes = Lunes 26
    const plus1 = CrmFollowUpCalc.addBusinessDays(friday, 1);
    expect(plus1.getDay()).toBe(1); // Lunes
    expect(plus1.getDate()).toBe(26);

    // +2 días hábiles desde viernes = Martes 27
    const plus2 = CrmFollowUpCalc.addBusinessDays(friday, 2);
    expect(plus2.getDay()).toBe(2); // Martes
    expect(plus2.getDate()).toBe(27);

    // +5 días hábiles desde jueves 22 = Jueves 29
    const thursday = new Date(2026, 9, 22);
    const plus5 = CrmFollowUpCalc.addBusinessDays(thursday, 5);
    expect(plus5.getDay()).toBe(4); // Jueves
    expect(plus5.getDate()).toBe(29);

    // Desde sábado o domingo: salta a lunes hábil
    const saturday = new Date(2026, 9, 24);
    const fromSat = CrmFollowUpCalc.addBusinessDays(saturday, 1);
    expect(fromSat.getDay()).toBe(1); // Lunes 26
    expect(fromSat.getDate()).toBe(26);
  });

  // =========================================================================
  // 3. Primer intento sin respuesta y llamada obligatoria en el siguiente intento
  // =========================================================================
  test('3. Intento 1 sin respuesta exige llamada telefónica obligatoria en intento 2', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-CAD-1';
    fdb.seed(pRef, {
      id: 'P-CAD-1',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 0 }
      }
    });

    // Intento 1: se contacta por correo y no hay respuesta -> OK
    const res1 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-CAD-1',
      data: {
        canal: 'correo',
        resultado: 'sin_respuesta',
        detalle: 'Envío de correo sin confirmación',
        proxima_accion: { fecha: '2026-10-27', tipo: 'llamada', descripcion: 'Llamar al cliente' }
      },
      opId: 'op_attempt_1'
    });

    expect(res1.status).toBe('recorded');
    expect(res1.seguimiento.cadencia.intentos_fallidos).toBe(1);

    // Intento 2 con WhatsApp (no es llamada) -> DEBE RECHAZARSE
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-CAD-1',
      data: {
        canal: 'whatsapp',
        resultado: 'sin_respuesta',
        detalle: 'Intento por WhatsApp'
      },
      opId: 'op_attempt_2_invalid'
    })).rejects.toThrow(/llamada telefónica obligatoria/i);

    // Intento 2 con Llamada -> DEBE ACEPTARSE
    const res2 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-CAD-1',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Llamada no atendida'
      },
      opId: 'op_attempt_2_valid'
    });

    expect(res2.status).toBe('recorded');
    expect(res2.seguimiento.cadencia.intentos_fallidos).toBe(2);
  });

  // =========================================================================
  // 4. Tres intentos fallidos y decisión del vendedor
  // =========================================================================
  test('4. Tras 3 intentos sin respuesta activa estado de decisión sin cerrar automáticamente', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-DEC-3';
    fdb.seed(pRef, {
      id: 'P-DEC-3',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 2 }
      }
    });

    // Intento 3 sin respuesta
    const res3 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-DEC-3',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Tercer intento sin respuesta'
      },
      opId: 'op_attempt_3'
    });

    expect(res3.status).toBe('recorded');
    expect(res3.seguimiento.cadencia.intentos_fallidos).toBe(3);
    expect(res3.seguimiento.cadencia.estado_cadencia).toBe('requiere_decision_vendedor');

    // La oportunidad NO se cierra automáticamente: sigue activa
    const updated = await fdb.data(pRef);
    expect(updated.estado).toBe('activo');

    // En la agenda se clasifica como pendiente de decisión
    const clasif = CrmFollowUpCalc.classifyFollowUp(updated, CLOCK);
    expect(clasif.status).toBe('pendiente_decision');
    expect(clasif.requiere_decision).toBe(true);
  });

  // =========================================================================
  // 5. Continuación justificada después del tercer intento
  // =========================================================================
  test('5. Continuación tras 3 intentos requiere justificación obligatoria y preserva historial', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-JUST-4';
    fdb.seed(pRef, {
      id: 'P-JUST-4',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 3, estado_cadencia: 'requiere_decision_vendedor' },
        historial_gestiones: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }]
      }
    });

    // Intento 4 sin justificación -> DEBE RECHAZARSE
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-JUST-4',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Cuarto intento'
      },
      opId: 'op_attempt_4_no_just'
    })).rejects.toThrow(/justificación de continuidad/i);

    // Intento 4 con justificación comercial válida -> ACEPTADO
    const res4 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-JUST-4',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Cuarto intento con asistente',
        justificacion_continuidad: 'Asistente confirmó que el director está de viaje y regresa el lunes',
        proxima_accion: { fecha: '2026-10-28', tipo: 'llamada', descripcion: 'Llamar cuando regrese de viaje' }
      },
      opId: 'op_attempt_4_with_just'
    });

    expect(res4.status).toBe('recorded');
    expect(res4.seguimiento.cadencia.intentos_fallidos).toBe(4);
    expect(res4.seguimiento.cadencia.justificacion_continuidad).toContain('director está de viaje');
    // Conserva las 3 gestiones previas + la nueva = 4 gestiones
    expect(res4.seguimiento.historial_gestiones).toHaveLength(4);
  });

  // =========================================================================
  // 6. Escalamiento gerencial después del quinto intento
  // =========================================================================
  test('6. Tras 5 intentos fallidos genera alerta gerencial para revisión sin cerrar automáticamente', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-ESC-5';
    fdb.seed(pRef, {
      id: 'P-ESC-5',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 4, estado_cadencia: 'requiere_decision_vendedor' }
      }
    });

    // Intento 5 fallido
    const res5 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-ESC-5',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Quinto intento sin respuesta',
        justificacion_continuidad: 'Proyecto institucional grande, se insiste por canal directivo'
      },
      opId: 'op_attempt_5'
    });

    expect(res5.status).toBe('recorded');
    expect(res5.seguimiento.cadencia.intentos_fallidos).toBe(5);
    expect(res5.seguimiento.cadencia.alerta_gerencial).toBe(true);
    expect(res5.seguimiento.cadencia.estado_cadencia).toBe('escalado_gerencia');
    expect(res5.seguimiento.cadencia.fecha_escalacion).toBeDefined();

    // Sigue activa (no se cierra unilateralmente, requiere revisión gerencial)
    const doc = await fdb.data(pRef);
    expect(doc.estado).toBe('activo');

    // La agenda del gerente detecta la oportunidad escalada
    const agenda = CrmFollowUpCalc.generateAgenda([doc], { role: 'manager', cid: 'MGR' });
    expect(agenda.counts.escaladas_gerencia).toBe(1);
    expect(agenda.items[0].classification.isEscaladoGerencia).toBe(true);
  });

  // =========================================================================
  // 7. Cliente que responde y solicita más tiempo
  // =========================================================================
  test('7. Cliente solicita más tiempo: resetea intentos fallidos y agenda 15 días calendario de pauta', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-TIEMPO';
    fdb.seed(pRef, {
      id: 'P-TIEMPO',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 3, estado_cadencia: 'requiere_decision_vendedor' }
      }
    });

    // Cliente responde y pide tiempo
    const res = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-TIEMPO',
      data: {
        canal: 'llamada',
        resultado: 'solicito_tiempo',
        detalle: 'Cliente pide tiempo hasta la junta directiva de noviembre'
      },
      opId: 'op_solicito_tiempo'
    });

    expect(res.status).toBe('recorded');
    // Resetea contador de intentos fallidos
    expect(res.seguimiento.cadencia.intentos_fallidos).toBe(0);
    expect(res.seguimiento.cadencia.alerta_gerencial).toBe(false);
    expect(res.seguimiento.cadencia.estado_cadencia).toBe('normal');

    // Pauta de 15 días sugerida
    const suggested = CrmFollowUpCalc.suggestNextContactDate(CLOCK, 'solicito_tiempo');
    const diff = CrmFollowUpCalc.diffDaysCalendar(CLOCK, suggested);
    expect(diff).toBe(15);
  });

  // =========================================================================
  // 8. Nota interna que no reinicia el contador ni pospone plazos
  // =========================================================================
  test('8. Nota interna sin contacto con cliente no altera el contador de intentos fallidos ni reinicia cadencia', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-INTERNO';
    fdb.seed(pRef, {
      id: 'P-INTERNO',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 3, estado_cadencia: 'requiere_decision_vendedor' }
      }
    });

    // Se registra una nota interna (ej: revisión en taller)
    const res = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-INTERNO',
      data: {
        canal: 'interno',
        resultado: 'nota_interna',
        detalle: 'Se revisó disponibilidad de lámina con producción en planta'
      },
      opId: 'op_nota_interna'
    });

    expect(res.status).toBe('recorded');
    // Los intentos fallidos siguen siendo exactamente 3
    expect(res.seguimiento.cadencia.intentos_fallidos).toBe(3);
    expect(res.seguimiento.cadencia.estado_cadencia).toBe('requiere_decision_vendedor');
    expect(res.seguimiento.historial_gestiones[0].es_contacto_valido).toBe(false);
  });

  // =========================================================================
  // 9. Edición o eliminación de una nota sin alterar la fecha original ni el historial
  // =========================================================================
  test('9. Eliminar o editar una nota no altera el historial estructurado de gestiones ni su fecha', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-LOG-DELETE';
    fdb.seed(pRef, {
      id: 'P-LOG-DELETE',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1'
    });

    // Registramos una gestión
    await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-LOG-DELETE',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Llamada no atendida inicial'
      },
      opId: 'op_test_delete'
    });

    const docBefore = await fdb.data(pRef);
    expect(docBefore.seguimiento.historial_gestiones).toHaveLength(1);
    const dateOriginal = docBefore.seguimiento.historial_gestiones[0].fecha;

    // Eliminamos la nota del log clásico mediante deleteLog
    const noteEntry = docBefore.logs[0];
    await service.deleteLog({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-LOG-DELETE',
      date: noteEntry.date,
      text: noteEntry.text
    });

    // El array de logs perdió la entrada
    const docAfter = await fdb.data(pRef);
    expect(docAfter.logs).toHaveLength(0);

    // Pero el historial estructurado de gestiones y cadencia permanece intacto
    expect(docAfter.seguimiento.historial_gestiones).toHaveLength(1);
    expect(docAfter.seguimiento.historial_gestiones[0].fecha).toBe(dateOriginal);
    expect(docAfter.seguimiento.cadencia.intentos_fallidos).toBe(1);
  });

  // =========================================================================
  // 10. Ausencia de fecha de entrega de oferta
  // =========================================================================
  test('10. Oportunidad en negociación sin fecha de entrega no inventa plazos desde fecha de creación', () => {
    const oppSinFecha = {
      id: 'OPP-SIN-OFERTA',
      estado: 'activo',
      etapa: 'negociacion',
      fecha_creacion: '2025-01-01T10:00:00.000Z', // Creada hace 18 meses
      seguimiento: {} // Sin seguimiento ni fecha de entrega registrada
    };

    const clasif = CrmFollowUpCalc.classifyFollowUp(oppSinFecha, CLOCK);

    // No debe calcular que está vencida hace 500 días a partir de fecha_creacion
    expect(clasif.status).toBe('sin_seguimiento');
    expect(clasif.dias_retraso).toBe(0);
    expect(clasif.motivo_agenda).toContain('Sin seguimiento programado');
  });

  // =========================================================================
  // 11. Permisos de vendedor y gerente
  // =========================================================================
  test('11. Aislamiento de permisos: vendedor solo gestiona sus oportunidades, gerente gestiona todas', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-PERM';
    fdb.seed(pRef, {
      id: 'P-PERM',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1'
    });

    // Vendedor 2 intenta registrar seguimiento en oportunidad de Vendedor 1 -> RECHAZADO
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V2'),
      prospectId: 'P-PERM',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Intrusión de V2'
      },
      opId: 'op_v2_fail'
    })).rejects.toThrow(/No tienes acceso a esta oportunidad/i);

    // Vendedor 1 asignado -> ACEPTADO
    const resV1 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-PERM',
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Gestión válida de V1'
      },
      opId: 'op_v1_ok'
    });
    expect(resV1.status).toBe('recorded');

    // Gerente -> ACEPTADO
    const resMgr = await service.recordFollowUp({
      caller: caller('manager', 'MGR'),
      prospectId: 'P-PERM',
      data: {
        canal: 'llamada',
        resultado: 'respondio_evaluando',
        detalle: 'Intervención de Gerencia con el cliente'
      },
      opId: 'op_mgr_ok'
    });
    expect(resMgr.status).toBe('recorded');
    expect(resMgr.seguimiento.cadencia.intentos_fallidos).toBe(0);
  });

  // =========================================================================
  // 12. Oportunidades perdidas, ganadas o eliminadas
  // =========================================================================
  test('12. Oportunidades cerradas (ganadas, perdidas) o eliminadas no permiten registrar seguimientos ni aparecen en agenda', async () => {
    const { fdb, service, caller } = makeEnv();

    fdb.seed('prospects_prod/P-GANADO', { id: 'P-GANADO', estado: 'ganado', vendedorId: 'V1' });
    fdb.seed('prospects_prod/P-PERDIDO', { id: 'P-PERDIDO', estado: 'perdido', vendedorId: 'V1' });
    fdb.seed('prospects_prod/P-ELIMINADO', { id: 'P-ELIMINADO', estado: 'activo', eliminado: true, vendedorId: 'V1' });

    // Intento en ganada -> RECHAZADO
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-GANADO',
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'x' },
      opId: 'op_gan_closed'
    })).rejects.toThrow(/Solo se pueden registrar seguimientos en oportunidades activas/i);

    // Intento en perdida -> RECHAZADO
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-PERDIDO',
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'x' },
      opId: 'op_per_closed'
    })).rejects.toThrow(/Solo se pueden registrar seguimientos en oportunidades activas/i);

    // Intento en eliminada -> RECHAZADO (not found)
    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-ELIMINADO',
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'x' },
      opId: 'op_elim_closed'
    })).rejects.toThrow(/La oportunidad fue eliminada/i);

    // Ninguna de ellas aparece en la agenda
    const cGan = CrmFollowUpCalc.classifyFollowUp({ id: 'P-GANADO', estado: 'ganado' }, CLOCK);
    expect(cGan.inAgenda).toBe(false);

    const cPer = CrmFollowUpCalc.classifyFollowUp({ id: 'P-PERDIDO', estado: 'perdido' }, CLOCK);
    expect(cPer.inAgenda).toBe(false);

    const cElim = CrmFollowUpCalc.classifyFollowUp({ id: 'P-ELIMINADO', estado: 'activo', eliminado: true }, CLOCK);
    expect(cElim.inAgenda).toBe(false);
  });

  // =========================================================================
  // 13. Compatibilidad con registros históricos que no tienen los nuevos campos
  // =========================================================================
  test('13. Registros históricos heredados sin objeto seguimiento operan sin errores ni caídas', () => {
    const oppLegacy = {
      id: 'OPP-LEGACY',
      codigo: '20240101',
      proyecto: 'Obra Antigua',
      clientId: 'CLI-01',
      vendedorId: 'V1',
      vendedorName: 'Carlos Mendoza',
      estado: 'activo',
      etapa: 'cotizacion',
      fecha_creacion: '2024-03-01T10:00:00.000Z',
      stage_timestamps: { cotizacion: '2024-03-05T10:00:00.000Z' },
      logs: [{ text: 'Nota clásica de texto', date: '2024-03-05T10:00:00.000Z', auto: false }]
      // Sin propiedad 'seguimiento'
    };

    // No debe lanzar excepción
    expect(() => CrmFollowUpCalc.classifyFollowUp(oppLegacy, CLOCK)).not.toThrow();

    const clasif = CrmFollowUpCalc.classifyFollowUp(oppLegacy, CLOCK);
    expect(clasif.inAgenda).toBe(true);
    expect(clasif.status).toBe('sin_seguimiento');
    expect(clasif.dias_retraso).toBe(0);
    expect(clasif.intentos_fallidos).toBe(0);

    // Al generar agenda completa con registros mixtos (legacy + nuevos)
    const agenda = CrmFollowUpCalc.generateAgenda([oppLegacy], { role: 'vendedor', cid: 'V1' });
    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0].codigo).toBe('20240101');
    expect(agenda.counts.total).toBe(1);
  });

  // =========================================================================
  // 14. Idempotencia en reintentos de red (mismo opId)
  // =========================================================================
  test('14. Una gestión guardada dos veces por reintentos de red no duplica registros ni contadores', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-IDEMP';
    fdb.seed(pRef, {
      id: 'P-IDEMP',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: { intentos_fallidos: 0 }
      }
    });

    const opId = 'op_network_retry_123';
    const payload = {
      canal: 'llamada',
      resultado: 'sin_respuesta',
      detalle: 'Primer intento telefónico'
    };

    // Primera invocación (red exitosa)
    const res1 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-IDEMP',
      data: payload,
      opId
    });
    expect(res1.status).toBe('recorded');
    expect(res1.seguimiento.cadencia.intentos_fallidos).toBe(1);
    expect(res1.seguimiento.historial_gestiones).toHaveLength(1);

    // Segunda invocación (reintento con mismo opId tras timeout o reconexión)
    const res2 = await service.recordFollowUp({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-IDEMP',
      data: payload,
      opId
    });
    expect(res2.status).toBe('recorded');
    expect(res2.replay).toBe(true);

    // El contador NO debe haberse incrementado a 2, y el historial NO debe tener 2 elementos
    const doc = await fdb.data(pRef);
    expect(doc.seguimiento.cadencia.intentos_fallidos).toBe(1);
    expect(doc.seguimiento.historial_gestiones).toHaveLength(1);
    expect(doc.logs).toHaveLength(1);
  });

  // =========================================================================
  // 15. Último contacto válido con próxima acción ya vencida
  // =========================================================================
  test('15. Oportunidad con último contacto válido pero cuya próxima acción ya venció', () => {
    const opp = {
      id: 'P-OVERDUE-VALID',
      estado: 'activo',
      etapa: 'negociacion',
      seguimiento: {
        ultimo_contacto: {
          fecha: '2026-10-20T15:00:00.000Z',
          canal: 'llamada',
          resultado: 'respondio_evaluando',
          detalle: 'Cliente pidió que lo llame el 21'
        },
        proxima_accion: {
          fecha: '2026-10-21',
          tipo: 'llamada',
          descripcion: 'Llamar para respuesta'
        }
      }
    };

    // Evaluada el viernes 23 de octubre
    const clasif = CrmFollowUpCalc.classifyFollowUp(opp, CLOCK);
    expect(clasif.status).toBe('vencida');
    // Del 21 al 23 son 2 días de retraso
    expect(clasif.dias_retraso).toBe(2);
    expect(clasif.inAgenda).toBe(true);
    expect(clasif.ultimo_contacto).toBeDefined();
    expect(clasif.ultimo_contacto.resultado).toBe('respondio_evaluando');
    expect(clasif.motivo_agenda).toContain('Vencido hace 2 días');
  });

  // =========================================================================
  // 16. Oportunidad escalada a gerencia que recibe respuesta real del cliente
  // =========================================================================
  test('16. Oportunidad escalada (5 intentos) que recibe respuesta efectiva resetea cadencia pero preserva historial completo', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-ESC-RESCUE';
    fdb.seed(pRef, {
      id: 'P-ESC-RESCUE',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        cadencia: {
          intentos_fallidos: 5,
          alerta_gerencial: true,
          estado_cadencia: 'escalado_gerencia'
        },
        historial_gestiones: [
          { id: 'g1', intento_numero: 1, resultado: 'sin_respuesta' },
          { id: 'g2', intento_numero: 2, resultado: 'sin_respuesta' },
          { id: 'g3', intento_numero: 3, resultado: 'sin_respuesta' },
          { id: 'g4', intento_numero: 4, resultado: 'sin_respuesta' },
          { id: 'g5', intento_numero: 5, resultado: 'sin_respuesta' }
        ]
      }
    });

    // Gerente o vendedor logra contacto efectivo: cliente responde y evalúa
    const res = await service.recordFollowUp({
      caller: caller('manager', 'MGR'),
      prospectId: 'P-ESC-RESCUE',
      data: {
        canal: 'llamada',
        resultado: 'respondio_evaluando',
        detalle: 'Gerencia contactó al Director de Compras y reactivó el proceso',
        proxima_accion: { fecha: '2026-10-27', tipo: 'reunion', descripcion: 'Presentación ejecutiva' }
      },
      opId: 'op_rescue_escalated'
    });

    expect(res.status).toBe('recorded');
    // Alerta gerencial se desactiva y contador se resetea a 0
    expect(res.seguimiento.cadencia.intentos_fallidos).toBe(0);
    expect(res.seguimiento.cadencia.alerta_gerencial).toBe(false);
    expect(res.seguimiento.cadencia.estado_cadencia).toBe('normal');

    // Historial conserva los 5 intentos previos + la nueva gestión = 6 registros
    expect(res.seguimiento.historial_gestiones).toHaveLength(6);
    expect(res.seguimiento.historial_gestiones[5].resultado).toBe('respondio_evaluando');
  });

  // =========================================================================
  // 17. Consulta gerencial filtrando por vendedor
  // =========================================================================
  test('17. Un gerente puede consultar la agenda de un vendedor específico', () => {
    const opps = [
      {
        id: 'P-V1-HOY',
        estado: 'activo',
        vendedorId: 'V1',
        vendedorName: 'Alejandra Ayala',
        seguimiento: { proxima_accion: { fecha: '2026-10-23' } }
      },
      {
        id: 'P-V2-VENCIDA',
        estado: 'activo',
        vendedorId: 'V2',
        vendedorName: 'Roberto Flores',
        seguimiento: { proxima_accion: { fecha: '2026-10-21' } }
      }
    ];

    // Gerente por defecto recibe sus oportunidades propias y escalaciones gerenciales,
    // NO la agenda global de llamadas ordinarias de todos los vendedores
    const agendaGlobal = CrmFollowUpCalc.generateAgenda(opps, { role: 'manager', cid: 'MGR' }, 'todas', CLOCK);
    expect(agendaGlobal.items).toHaveLength(0);

    // Oportunidad con escalación a gerencia
    const oppEscalada = {
      id: 'P-MGR-ESC',
      estado: 'activo',
      vendedorId: 'V1',
      seguimiento: {
        cadencia: { alerta_gerencial: true, intentos_fallidos: 5 }
      }
    };
    const agendaConEscalacion = CrmFollowUpCalc.generateAgenda([...opps, oppEscalada], { role: 'manager', cid: 'MGR' }, 'todas', CLOCK);
    expect(agendaConEscalacion.items).toHaveLength(1);
    expect(agendaConEscalacion.items[0].id).toBe('P-MGR-ESC');

    // Gerente consultando la agenda de un vendedor específico (V1)
    const v1Universe = opps.filter(p => p.vendedorId === 'V1');
    const agendaV1 = CrmFollowUpCalc.generateAgenda(v1Universe, { role: 'vendedor', cid: 'V1' }, 'todas', CLOCK);
    expect(agendaV1.items).toHaveLength(1);
    expect(agendaV1.items[0].vendedorId).toBe('V1');
    expect(agendaV1.counts.hoy).toBe(1);
    expect(agendaV1.counts.vencidas).toBe(0);
  });

  // =========================================================================
  // 18. Preservación de próxima acción y cadencia tras avance de etapa
  // =========================================================================
  test('18. El cambio de etapa comercial preserva la próxima acción y su clasificación en la agenda', async () => {
    const { fdb, wf, caller } = makeEnv();
    const pRef = 'prospects_prod/P-STAGE-MOVE';
    fdb.seed(pRef, {
      id: 'P-STAGE-MOVE',
      estado: 'activo',
      etapa: 'cotizacion',
      vendedorId: 'V1',
      createdBy: 'V1',
      seguimiento: {
        proxima_accion: { fecha: '2026-10-23', descripcion: 'Revisión técnica' },
        cadencia: { intentos_fallidos: 1 }
      }
    });

    const URLP = 'https://firebasestorage.googleapis.com/v0/b/demo/o/';
    const file = n => ({ name: n, url: `${URLP}${n}?alt=media` });

    // Se avanza la etapa mediante el servicio existente
    await wf.advanceStage({
      caller: caller('vendedor', 'V1'),
      prospectId: 'P-STAGE-MOVE',
      nextStage: 'negociacion',
      data: {
        precio_cotizado: 10000,
        costo_venta: 6000,
        probabilidad: 'media',
        doc_oferta: [file('oferta.pdf')],
        doc_costos: [file('costos.xlsx')]
      }
    });

    const doc = await fdb.data(pRef);
    expect(doc.etapa).toBe('negociacion');
    // El objeto seguimiento permanece intacto
    expect(doc.seguimiento).toBeDefined();
    expect(doc.seguimiento.proxima_accion.fecha).toBe('2026-10-23');
    expect(doc.seguimiento.cadencia.intentos_fallidos).toBe(1);

    // En la agenda sigue clasificada como "hoy"
    const clasif = CrmFollowUpCalc.classifyFollowUp(doc, CLOCK);
    expect(clasif.status).toBe('hoy');
  });

  // =========================================================================
  // 19. Zona horaria comercial America/El_Salvador y formato YYYY-MM-DD
  // =========================================================================
  test('19. Zona horaria America/El_Salvador: fechas YYYY-MM-DD y timestamps no sufren saltos de día por UTC', () => {
    expect(CrmFollowUpCalc.TIMEZONE_COMMERCIAL).toBe('America/El_Salvador');

    // Cadena YYYY-MM-DD exacta no cambia
    expect(CrmFollowUpCalc.getCommercialYMD('2026-10-23')).toBe('2026-10-23');
    expect(CrmFollowUpCalc.formatDateYMD('2026-10-23')).toBe('2026-10-23');

    // Timestamp UTC 01:30 AM del 23 de octubre corresponde a las 19:30 del 22 de octubre en El Salvador
    const lateNightUTC = new Date('2026-10-23T01:30:00.000Z');
    expect(CrmFollowUpCalc.getCommercialYMD(lateNightUTC)).toBe('2026-10-22');

    // Timestamp UTC 18:00 del 23 de octubre corresponde a las 12:00 del 23 de octubre en El Salvador
    const afternoonUTC = new Date('2026-10-23T18:00:00.000Z');
    expect(CrmFollowUpCalc.getCommercialYMD(afternoonUTC)).toBe('2026-10-23');

    // Diferencia de días entre fechas no sufre por horas intermedias
    expect(CrmFollowUpCalc.diffDaysCalendar('2026-10-20', '2026-10-25')).toBe(5);
    expect(CrmFollowUpCalc.diffDaysCalendar('2026-10-25', '2026-10-20')).toBe(-5);
  });

  // =========================================================================
  // 20. Confirmación de semana hábil de 5 días y salto de fin de semana
  // =========================================================================
  test('20. Cadencia de 5 días hábiles desde entrega de oferta y 2 días entre intentos sin respuesta', () => {
    // 5 días hábiles desde el lunes 2026-10-19 = lunes 2026-10-26
    const d5 = CrmFollowUpCalc.addBusinessDays('2026-10-19', 5);
    expect(CrmFollowUpCalc.formatDateYMD(d5)).toBe('2026-10-26');

    // 2 días hábiles desde el viernes 2026-10-23 = martes 2026-10-27
    const d2 = CrmFollowUpCalc.addBusinessDays('2026-10-23', 2);
    expect(CrmFollowUpCalc.formatDateYMD(d2)).toBe('2026-10-27');

    // Sugerencia para cliente que pide tiempo = exactamente 15 días calendario
    const sTiempo = CrmFollowUpCalc.suggestNextContactDate('2026-10-23', 'solicito_tiempo');
    expect(CrmFollowUpCalc.diffDaysCalendar('2026-10-23', sTiempo)).toBe(15);
  });

});
