// functions/__tests__/salvadoranLaborCalendar.unit.test.js
// Automated test suite for Salvadoran Labor Calendar and Ductsal Schedule

const CrmWorkCalendar = require('../../crm_work_calendar');
const CrmFollowUpCalc = require('../../crm_followup_calc');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

const CLOCK = new Date('2026-10-23T12:00:00.000Z'); // Viernes 23 de octubre de 2026

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
    name: `Usuario ${cid}`,
    role
  });
  return { fdb, service, wf, caller, now: CLOCK };
}

describe('Calendario Laboral de DUCTSAL y Asuetos de El Salvador', () => {

  // =========================================================================
  // 1. Cada asueto fijo nacional y su base legal
  // =========================================================================
  test('1. Asuetos nacionales fijos: reconoce todas las fechas oficiales y su base legal', () => {
    // 1 de enero - Año Nuevo (Código de Trabajo art. 190)
    const d1 = CrmWorkCalendar.getHolidayInfo('2026-01-01');
    expect(d1.isHoliday).toBe(true);
    expect(d1.type).toBe('national');
    expect(d1.name).toBe('Año Nuevo');
    expect(d1.legalBasis).toContain('art. 190');

    // 1 de mayo - Día del Trabajo (Código de Trabajo art. 190)
    const d2 = CrmWorkCalendar.getHolidayInfo('2026-05-01');
    expect(d2.isHoliday).toBe(true);
    expect(d2.type).toBe('national');
    expect(d2.name).toBe('Día del Trabajo');

    // 10 de mayo - Día de la Madre (Decreto Legislativo 339)
    const d3 = CrmWorkCalendar.getHolidayInfo('2026-05-10');
    expect(d3.isHoliday).toBe(true);
    expect(d3.type).toBe('national');
    expect(d3.name).toBe('Día de la Madre');
    expect(d3.legalBasis).toContain('339');

    // 17 de junio - Día del Padre (Decreto Legislativo 208)
    const d4 = CrmWorkCalendar.getHolidayInfo('2026-06-17');
    expect(d4.isHoliday).toBe(true);
    expect(d4.type).toBe('national');
    expect(d4.name).toBe('Día del Padre');
    expect(d4.legalBasis).toContain('208');

    // 6 de agosto - Celebración del Divino Salvador del Mundo (Código de Trabajo art. 190)
    const d5 = CrmWorkCalendar.getHolidayInfo('2026-08-06');
    expect(d5.isHoliday).toBe(true);
    expect(d5.type).toBe('national');
    expect(d5.name).toContain('Divino Salvador del Mundo');

    // 15 de septiembre - Independencia Patria (Código de Trabajo art. 190)
    const d6 = CrmWorkCalendar.getHolidayInfo('2026-09-15');
    expect(d6.isHoliday).toBe(true);
    expect(d6.type).toBe('national');
    expect(d6.name).toBe('Día de la Independencia Patria');

    // 2 de noviembre - Día de los Fieles Difuntos (Código de Trabajo art. 190)
    const d7 = CrmWorkCalendar.getHolidayInfo('2026-11-02');
    expect(d7.isHoliday).toBe(true);
    expect(d7.type).toBe('national');
    expect(d7.name).toBe('Día de los Fieles Difuntos');

    // 25 de diciembre - Navidad (Código de Trabajo art. 190)
    const d8 = CrmWorkCalendar.getHolidayInfo('2026-12-25');
    expect(d8.isHoliday).toBe(true);
    expect(d8.type).toBe('national');
    expect(d8.name).toBe('Navidad');
  });

  // =========================================================================
  // 2. Cálculo de Semana Santa (Butcher) y Miércoles Santo como asueto interno
  // =========================================================================
  test('2. Cálculo de Semana Santa: computa Miércoles, Jueves, Viernes y Sábado Santo para múltiples años', () => {
    // 2024: Pascua 31 de marzo. Miércoles: 27 mar, Jueves: 28 mar, Viernes: 29 mar, Sábado: 30 mar
    const ss2024 = CrmWorkCalendar.getSemanaSantaHolidays(2024);
    expect(ss2024['2024-03-27'].name).toBe('Miércoles Santo');
    expect(ss2024['2024-03-27'].type).toBe('company');
    expect(ss2024['2024-03-28'].name).toBe('Jueves Santo');
    expect(ss2024['2024-03-28'].type).toBe('national');
    expect(ss2024['2024-03-29'].name).toBe('Viernes Santo');
    expect(ss2024['2024-03-30'].name).toBe('Sábado Santo');

    // 2025: Pascua 20 de abril. Miércoles: 16 abr, Jueves: 17 abr, Viernes: 18 abr, Sábado: 19 abr
    const ss2025 = CrmWorkCalendar.getSemanaSantaHolidays(2025);
    expect(ss2025['2025-04-16'].name).toBe('Miércoles Santo');
    expect(ss2025['2025-04-17'].name).toBe('Jueves Santo');
    expect(ss2025['2025-04-18'].name).toBe('Viernes Santo');
    expect(ss2025['2025-04-19'].name).toBe('Sábado Santo');

    // 2026: Pascua 5 de abril. Miércoles: 1 abr, Jueves: 2 abr, Viernes: 3 abr, Sábado: 4 abr
    const ss2026 = CrmWorkCalendar.getSemanaSantaHolidays(2026);
    expect(ss2026['2026-04-01'].name).toBe('Miércoles Santo');
    expect(ss2026['2026-04-02'].name).toBe('Jueves Santo');
    expect(ss2026['2026-04-03'].name).toBe('Viernes Santo');
    expect(ss2026['2026-04-04'].name).toBe('Sábado Santo');

    // 2027: Pascua 28 de marzo. Miércoles: 24 mar, Jueves: 25 mar, Viernes: 26 mar, Sábado: 27 mar
    const ss2027 = CrmWorkCalendar.getSemanaSantaHolidays(2027);
    expect(ss2027['2027-03-24'].name).toBe('Miércoles Santo');
    expect(ss2027['2027-03-25'].name).toBe('Jueves Santo');
    expect(ss2027['2027-03-26'].name).toBe('Viernes Santo');
    expect(ss2027['2027-03-27'].name).toBe('Sábado Santo');

    // Crédito laboral en Miércoles, Jueves, Viernes y Sábado Santo es 0.0
    expect(CrmWorkCalendar.getWorkDayCredit('2026-04-01')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-04-02')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-04-03')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-04-04')).toBe(0.0);
    expect(CrmWorkCalendar.isWorkDay('2026-04-01')).toBe(false);
    expect(CrmWorkCalendar.isWorkDay('2026-04-04')).toBe(false);
  });

  // =========================================================================
  // 3. Fiestas Agostinas de San Salvador (3, 4, 5 y 6 de agosto sin duplicados)
  // =========================================================================
  test('3. Fiestas Agostinas: 3 y 5 (municipales), 4 (interno Ductsal), 6 (nacional)', () => {
    // 3 de agosto: Municipal San Salvador (C.T. art. 190 inc. 2)
    const hAug3 = CrmWorkCalendar.getHolidayInfo('2026-08-03');
    expect(hAug3.isHoliday).toBe(true);
    expect(hAug3.type).toBe('municipal');
    expect(hAug3.name).toBe('Fiestas Patronales de San Salvador');

    // 4 de agosto: Asueto interno Ductsal
    const hAug4 = CrmWorkCalendar.getHolidayInfo('2026-08-04');
    expect(hAug4.isHoliday).toBe(true);
    expect(hAug4.type).toBe('company');
    expect(hAug4.name).toContain('Asueto Interno Ductsal');

    // 5 de agosto: Municipal San Salvador (C.T. art. 190 inc. 2)
    const hAug5 = CrmWorkCalendar.getHolidayInfo('2026-08-05');
    expect(hAug5.isHoliday).toBe(true);
    expect(hAug5.type).toBe('municipal');

    // 6 de agosto: Nacional
    const hAug6 = CrmWorkCalendar.getHolidayInfo('2026-08-06');
    expect(hAug6.isHoliday).toBe(true);
    expect(hAug6.type).toBe('national');

    // Los 4 días consecutivos aportan cero créditos laborales
    expect(CrmWorkCalendar.getWorkDayCredit('2026-08-03')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-08-04')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-08-05')).toBe(0.0);
    expect(CrmWorkCalendar.getWorkDayCredit('2026-08-06')).toBe(0.0);

    // 7 de agosto vuelve a ser laborable ordinario
    expect(CrmWorkCalendar.getWorkDayCredit('2026-08-07')).toBe(1.0);
  });

  // =========================================================================
  // 4. Asuetos internos de fin de año (24 y 31 de diciembre)
  // =========================================================================
  test('4. Asuetos de fin de año: 24 y 31 de diciembre son asuetos internos de Ductsal (0 créditos)', () => {
    // 24 de diciembre
    const hDec24 = CrmWorkCalendar.getHolidayInfo('2026-12-24');
    expect(hDec24.isHoliday).toBe(true);
    expect(hDec24.type).toBe('company');
    expect(CrmWorkCalendar.getWorkDayCredit('2026-12-24')).toBe(0.0);

    // 25 de diciembre: Navidad (nacional)
    const hDec25 = CrmWorkCalendar.getHolidayInfo('2026-12-25');
    expect(hDec25.type).toBe('national');
    expect(CrmWorkCalendar.getWorkDayCredit('2026-12-25')).toBe(0.0);

    // 31 de diciembre
    const hDec31 = CrmWorkCalendar.getHolidayInfo('2026-12-31');
    expect(hDec31.isHoliday).toBe(true);
    expect(hDec31.type).toBe('company');
    expect(CrmWorkCalendar.getWorkDayCredit('2026-12-31')).toBe(0.0);

    // 1 de enero: Año Nuevo (nacional)
    const hJan1 = CrmWorkCalendar.getHolidayInfo('2027-01-01');
    expect(hJan1.type).toBe('national');
    expect(CrmWorkCalendar.getWorkDayCredit('2027-01-01')).toBe(0.0);
  });

  // =========================================================================
  // 5. Créditos de jornada: L-V = 1.0, Sábado = 0.5, Domingo = 0.0
  // =========================================================================
  test('5. Créditos de jornada: L-V = 1.0, Sábado = 0.5, Domingo = 0.0', () => {
    // Semana del 19 al 25 de octubre 2026 (sin feriados)
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-19')).toBe(1.0); // Lunes
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-20')).toBe(1.0); // Martes
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-21')).toBe(1.0); // Miércoles
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-22')).toBe(1.0); // Jueves
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-23')).toBe(1.0); // Viernes
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-24')).toBe(0.5); // Sábado
    expect(CrmWorkCalendar.getWorkDayCredit('2026-10-25')).toBe(0.0); // Domingo

    expect(CrmWorkCalendar.isWorkDay('2026-10-24')).toBe(true);
    expect(CrmWorkCalendar.isHalfDay('2026-10-24')).toBe(true);
    expect(CrmWorkCalendar.isHalfDay('2026-10-23')).toBe(false);
    expect(CrmWorkCalendar.isWorkDay('2026-10-25')).toBe(false);
  });

  // =========================================================================
  // 6. Contactos comerciales externos en sábado vs tareas internas
  // =========================================================================
  test('6. Contactos en sábado: acción externa calculada para sábado se traslada a lunes; tarea interna permanece en sábado', () => {
    // Desde jueves 2026-10-22, sumar 1.5 créditos laborales:
    // Viernes 23: +1.0 (acum = 1.0)
    // Sábado 24: +0.5 (acum = 1.5 >= 1.5) -> El crédito laboral se completa el sábado 24

    // Tarea interna: puede permanecer en sábado (media jornada 8:00 a 12:00)
    const taskInterna = CrmWorkCalendar.addWorkDays('2026-10-22', 1.5, { isExternalContact: false });
    expect(CrmWorkCalendar.toCanonicalYMD(taskInterna)).toBe('2026-10-24');

    // Contacto externo con cliente (llamada, correo, whatsapp): se traslada al lunes 26
    const contactoExterno = CrmWorkCalendar.addWorkDays('2026-10-22', 1.5, { isExternalContact: true });
    expect(CrmWorkCalendar.toCanonicalYMD(contactoExterno)).toBe('2026-10-26');

    // Si el lunes es feriado (ej. 2 de noviembre 2026 es Día de los Difuntos):
    // Jueves 2026-10-29 + 1.5 créditos laborales:
    // Viernes 30: +1.0
    // Sábado 31: +0.5 (acum = 1.5)
    // Para contacto externo: domingo 1 nov (0.0), lunes 2 nov es asueto (0.0) -> traslada al martes 3 nov
    const contactoFeriadoLunes = CrmWorkCalendar.addWorkDays('2026-10-29', 1.5, { isExternalContact: true });
    expect(CrmWorkCalendar.toCanonicalYMD(contactoFeriadoLunes)).toBe('2026-11-03');
  });

  // =========================================================================
  // 7. Cadencia: 5 días hábiles desde entrega de oferta y 2 días para intentos posteriores
  // =========================================================================
  test('7. Cadencia comercial: cómputo exacto de 5 días hábiles y 2 días con respeto a feriados y sábados', () => {
    // Entrega de oferta un lunes normal (2026-10-19):
    // Martes (1), Mié (1), Jue (1), Vie (1), Sáb (0.5) -> acumulado 4.5
    // Lunes siguiente 2026-10-26 (1) -> acumulado 5.5 >= 5.0
    expect(CrmFollowUpCalc.formatDateYMD(CrmFollowUpCalc.addBusinessDays('2026-10-19', 5))).toBe('2026-10-26');

    // Siguiente intento sin respuesta (2 días hábiles desde el viernes 2026-10-23):
    // Sáb (0.5), Dom (0), Lun (1.0) -> 1.5 < 2.0
    // Mar 2026-10-27 (1.0) -> 2.5 >= 2.0
    expect(CrmFollowUpCalc.formatDateYMD(CrmFollowUpCalc.addBusinessDays('2026-10-23', 2))).toBe('2026-10-27');

    // Entrega de oferta justo antes de Semana Santa (martes 2026-03-31):
    // Mié 1 abr (0), Jue 2 abr (0), Vie 3 abr (0), Sáb 4 abr (0), Dom 5 abr (0)
    // Lun 6 abr (1), Mar 7 abr (1), Mié 8 abr (1), Jue 9 abr (1), Vie 10 abr (1) -> 5.0 créditos
    const dOfertaSS = CrmFollowUpCalc.addBusinessDays('2026-03-31', 5);
    expect(CrmFollowUpCalc.formatDateYMD(dOfertaSS)).toBe('2026-04-10');
  });

  // =========================================================================
  // 8. 15 días calendario cuando el cliente solicita tiempo
  // =========================================================================
  test('8. Cliente solicita tiempo: calcula 15 días calendario; si cae en sábado y es contacto externo lo traslada', () => {
    const fromDate = '2026-10-23'; // Viernes
    // 23 oct + 15 días calendario = 7 de noviembre (Sábado)

    // Función estándar con preservación de días calendario
    const rawCalendar = CrmFollowUpCalc.addCalendarDays(fromDate, 15);
    expect(CrmFollowUpCalc.formatDateYMD(rawCalendar)).toBe('2026-11-07');
    expect(CrmFollowUpCalc.diffDaysCalendar(fromDate, rawCalendar)).toBe(15);

    // Sugerencia explícita para contacto externo traslada sábado a lunes 9 de noviembre
    const extContact = CrmFollowUpCalc.suggestNextExternalContactDate(fromDate, 'solicito_tiempo');
    expect(CrmFollowUpCalc.formatDateYMD(extContact)).toBe('2026-11-09');

    // Tarea interna programada conserva el sábado 7 de noviembre
    const intTask = CrmFollowUpCalc.suggestNextInternalTaskDate(fromDate, 'solicito_tiempo');
    expect(CrmFollowUpCalc.formatDateYMD(intTask)).toBe('2026-11-07');
  });

  // =========================================================================
  // 9. Robustez horaria en America/El_Salvador
  // =========================================================================
  test('9. Robustez horaria: interpretación exacta en America/El_Salvador para timestamps cerca de medianoche UTC', () => {
    // 05:59 UTC del 24 de octubre = 23:59 del 23 de octubre en El Salvador (UTC-6)
    const lateNight = new Date('2026-10-24T05:59:00.000Z');
    expect(CrmWorkCalendar.toCanonicalYMD(lateNight)).toBe('2026-10-23');

    // 06:01 UTC del 24 de octubre = 00:01 del 24 de octubre en El Salvador
    const earlyMorning = new Date('2026-10-24T06:01:00.000Z');
    expect(CrmWorkCalendar.toCanonicalYMD(earlyMorning)).toBe('2026-10-24');

    // Cadena pura YYYY-MM-DD nunca sufre deslizamiento
    expect(CrmWorkCalendar.toCanonicalYMD('2026-10-24')).toBe('2026-10-24');
  });

  // =========================================================================
  // 10. Semántica de no_continua: limpia próxima acción pero PRESERVA activa
  // =========================================================================
  test('10. Semántica de no_continua: limpia próxima acción de la agenda, pero NO cierra la oportunidad como perdida', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-NO-CONT-1';
    fdb.seed(pRef, {
      id: 'P-NO-CONT-1',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1',
      seguimiento: {
        proxima_accion: { fecha: '2026-10-23', descripcion: 'Llamar para cierre' },
        cadencia: { intentos_fallidos: 2 }
      }
    });

    const res = await service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-NO-CONT-1',
      data: {
        canal: 'llamada',
        resultado: 'no_continua',
        detalle: 'Cliente indica que suspendieron la inversión para este año'
      },
      opId: 'op_nocont_001'
    });

    expect(res.status).toBe('recorded');
    const updated = await fdb.data(pRef);

    // La oportunidad sigue ACTIVA (no se marca como perdida automáticamente)
    expect(updated.estado).toBe('activo');

    // La próxima acción se limpió para sacarla de la agenda diaria
    expect(updated.seguimiento.proxima_accion).toBeNull();

    // El historial estructurado preserva la negativa del cliente íntegramente
    const hist = updated.seguimiento.historial_gestiones;
    expect(hist.length).toBe(1);
    expect(hist[0].resultado).toBe('no_continua');
    expect(hist[0].detalle).toContain('suspendieron la inversión');

    // En la agenda aparece como sin_seguimiento para decisión comercial
    const clasif = CrmFollowUpCalc.classifyFollowUp(updated, CLOCK);
    expect(clasif.inAgenda).toBe(true);
    expect(clasif.status).toBe('sin_seguimiento');
  });

  // =========================================================================
  // 11. Cierre formal como perdida: flujo explícito con permisos y motivo válido
  // =========================================================================
  test('11. Cierre formal como perdida: requiere invocar markLost con motivo reglamentario y permisos', async () => {
    const { fdb, wf, caller } = makeEnv();
    const pRef = 'prospects_prod/P-LOST-1';
    fdb.seed(pRef, {
      id: 'P-LOST-1',
      estado: 'activo',
      etapa: 'negociacion',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1'
    });

    // Rechaza motivo no reglamentario
    await expect(wf.markLost({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-LOST-1',
      reason: 'No me gustó el cliente'
    })).rejects.toThrow('Motivo de pérdida inválido');

    // Acepta motivo reglamentario 'Cliente desiste'
    const res = await wf.markLost({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-LOST-1',
      reason: 'Cliente desiste'
    });

    expect(res.estado).toBe('perdido');
    const updated = await fdb.data(pRef);
    expect(updated.estado).toBe('perdido');
    expect(updated.motivo_perdida).toBe('Cliente desiste');
    expect(updated.fecha_perdida).toBeDefined();

    // Una oportunidad perdida ya no aparece en la agenda
    const clasif = CrmFollowUpCalc.classifyFollowUp(updated, CLOCK);
    expect(clasif.inAgenda).toBe(false);
    expect(clasif.status).toBe('inactivo');
  });

  // =========================================================================
  // 12. Rechazo de nuevos seguimientos sobre oportunidades cerradas o inactivas
  // =========================================================================
  test('12. Rechazo de gestión: no permite registrar seguimientos en oportunidades perdidas, ganadas o eliminadas', async () => {
    const { fdb, service, caller } = makeEnv();

    // 1. Oportunidad perdida
    fdb.seed('prospects_prod/P-CLOSED-LOST', {
      id: 'P-CLOSED-LOST',
      estado: 'perdido',
      motivo_perdida: 'Precio',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1'
    });

    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-CLOSED-LOST',
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Llamé pero ya está perdida' },
      opId: 'op_lost_try'
    })).rejects.toThrow('Solo se pueden registrar seguimientos en oportunidades activas');

    // 2. Oportunidad ganada
    fdb.seed('prospects_prod/P-CLOSED-WON', {
      id: 'P-CLOSED-WON',
      estado: 'ganado',
      etapa: 'cierre',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1'
    });

    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-CLOSED-WON',
      data: { canal: 'llamada', resultado: 'respondio_evaluando', detalle: 'Contacto postcierre' },
      opId: 'op_won_try'
    })).rejects.toThrow('Solo se pueden registrar seguimientos en oportunidades activas');

    // 3. Oportunidad eliminada
    fdb.seed('prospects_prod/P-DELETED', {
      id: 'P-DELETED',
      estado: 'activo',
      eliminado: true,
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1'
    });

    await expect(service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-DELETED',
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Contacto' },
      opId: 'op_del_try'
    })).rejects.toThrow(/eliminada/i);
  });

  // =========================================================================
  // 13. Idempotencia del registro de seguimiento
  // =========================================================================
  test('13. Idempotencia: el reenvío de una gestión con el mismo opId no duplica historial ni altera contadores', async () => {
    const { fdb, service, caller } = makeEnv();
    const pRef = 'prospects_prod/P-IDEM-CAL';
    fdb.seed(pRef, {
      id: 'P-IDEM-CAL',
      estado: 'activo',
      etapa: 'cotizacion',
      vendedorId: 'USR-V1',
      createdBy: 'USR-V1'
    });

    const payload = {
      canal: 'llamada',
      resultado: 'sin_respuesta',
      detalle: 'Primer intento fallido sin respuesta',
      proxima_accion: { fecha: '2026-10-27', tipo: 'llamada', descripcion: 'Segundo intento' }
    };

    // Primera ejecución
    const r1 = await service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-IDEM-CAL',
      data: payload,
      opId: 'op_idem_unique_999'
    });
    expect(r1.status).toBe('recorded');
    expect(r1.replay).toBeUndefined();

    const d1 = await fdb.data(pRef);
    expect(d1.seguimiento.cadencia.intentos_fallidos).toBe(1);
    expect(d1.seguimiento.historial_gestiones.length).toBe(1);

    // Segunda ejecución (reintento de red con mismo opId)
    const r2 = await service.recordFollowUp({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-IDEM-CAL',
      data: payload,
      opId: 'op_idem_unique_999'
    });
    expect(r2.status).toBe('recorded');
    expect(r2.replay).toBe(true);

    const d2 = await fdb.data(pRef);
    // No aumentó a 2 ni duplicó el historial
    expect(d2.seguimiento.cadencia.intentos_fallidos).toBe(1);
    expect(d2.seguimiento.historial_gestiones.length).toBe(1);
  });

  // =========================================================================
  // 14. Transición de fin de año y asuetos consecutivos (24, 25, 31 dic y 1 ene)
  // =========================================================================
  test('14. Transición de fin de año: cruza asuetos del 24, 25, 31 de diciembre y 1 de enero', () => {
    // Miércoles 23 de diciembre 2026:
    // Jue 24 dic (0 - asueto interno)
    // Vie 25 dic (0 - Navidad)
    // Sáb 26 dic (+0.5 media jornada)
    // Dom 27 dic (0 - descanso)
    // Lun 28 dic (+1.0 jornada ordinaria) -> acumulado 1.5 créditos
    const d1_5 = CrmWorkCalendar.addWorkDays('2026-12-23', 1.5);
    expect(CrmWorkCalendar.toCanonicalYMD(d1_5)).toBe('2026-12-28');

    // 5 días laborales desde el miércoles 23 de diciembre 2026:
    // Sáb 26 dic (+0.5)
    // Lun 28 dic (+1.0, tot 1.5)
    // Mar 29 dic (+1.0, tot 2.5)
    // Mié 30 dic (+1.0, tot 3.5)
    // Jue 31 dic (0 - asueto interno)
    // Vie 1 ene 2027 (0 - Año Nuevo)
    // Sáb 2 ene 2027 (+0.5, tot 4.0)
    // Dom 3 ene 2027 (0)
    // Lun 4 ene 2027 (+1.0, tot 5.0 >= 5.0) -> Reclama el lunes 4 de enero de 2027
    const d5 = CrmWorkCalendar.addWorkDays('2026-12-23', 5);
    expect(CrmWorkCalendar.toCanonicalYMD(d5)).toBe('2027-01-04');
  });

});
