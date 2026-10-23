// crm_work_calendar.js
// Centralized Labor Calendar for DUCTSAL ERP according to Salvadoran Labor Law and Company Schedule.
// Runs both in Browser (window.CrmWorkCalendar) and Node.js (module.exports).
//
// Fuentes oficiales salvadoreñas y reglas de negocio DUCTSAL verificadas:
// 1. Feriados legales nacionales (Código de Trabajo art. 190, D.L. 208, D.L. 339):
//    - 1 de enero (Año Nuevo)
//    - Jueves, Viernes y Sábado Santo (Semana Santa, fechas móviles gregorianas)
//    - 1 de mayo (Día del Trabajo)
//    - 10 de mayo (Día de la Madre, D.L. n.º 339)
//    - 17 de junio (Día del Padre, D.L. n.º 208)
//    - 6 de agosto (Celebración del Divino Salvador del Mundo / Fiesta Patronal Nacional)
//    - 15 de septiembre (Día de la Independencia Patria)
//    - 2 de noviembre (Día de los Fieles Difuntos)
//    - 25 de diciembre (Navidad)
// 2. Asuetos locales aplicables al municipio de San Salvador (Código de Trabajo art. 190 inc. 2):
//    - 3 y 5 de agosto (Fiestas Patronales de San Salvador)
// 3. Asuetos internos adicionales de DUCTSAL (Días no laborables de política empresarial):
//    - Miércoles Santo (móvil: día previo a Jueves Santo)
//    - 4 de agosto (complemento de Fiestas Agostinas en San Salvador)
//    - 24 de diciembre (Víspera de Navidad / Cierre empresarial)
//    - 31 de diciembre (Fin de año / Cierre empresarial)
//
// Jornada laboral ordinaria de DUCTSAL:
// - Lunes a viernes: 8:00 a. m. a 5:00 p. m. (Crédito laboral = 1.0 jornada ordinaria)
// - Sábado: 8:00 a. m. a 12:00 p. m. (Crédito laboral = 0.5 media jornada)
// - Domingo: No laborable (Crédito laboral = 0.0)
// - Días de asueto (legales o internos): Crédito laboral = 0.0
//
// Regla de contactos externos en sábado:
// - Tareas internas pueden programarse y realizarse en sábado (8:00 a 12:00).
// - Acciones comerciales de contacto dirigidas a clientes (llamadas, WhatsApp, correos)
//   calculadas para sábado se trasladan al siguiente día laborable disponible.
// - La jornada de sábado sigue computando exactamente 0.5 créditos laborales.

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.CrmWorkCalendar = factory();
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Zona horaria comercial canónica de El Salvador (UTC-6, sin horario de verano)
    const TIMEZONE_CANONICAL = 'America/El_Salvador';

    // 1. Asuetos nacionales fijos fijados por Ley (Código de Trabajo art. 190, D.L. 208, D.L. 339)
    const NATIONAL_FIXED_HOLIDAYS = Object.freeze({
        '01-01': { name: 'Año Nuevo', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
        '05-01': { name: 'Día del Trabajo', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
        '05-10': { name: 'Día de la Madre', legalBasis: 'Decreto Legislativo n.º 339', type: 'national' },
        '06-17': { name: 'Día del Padre', legalBasis: 'Decreto Legislativo n.º 208', type: 'national' },
        '08-06': { name: 'Celebración del Divino Salvador del Mundo / Fiesta Patronal Nacional', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
        '09-15': { name: 'Día de la Independencia Patria', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
        '11-02': { name: 'Día de los Fieles Difuntos', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
        '12-25': { name: 'Navidad', legalBasis: 'Código de Trabajo art. 190', type: 'national' }
    });

    // 2. Asuetos locales municipales de San Salvador (Código de Trabajo art. 190 inc. 2)
    const SAN_SALVADOR_MUNICIPAL_HOLIDAYS = Object.freeze({
        '08-03': { name: 'Fiestas Patronales de San Salvador', legalBasis: 'Código de Trabajo art. 190 inc. 2', type: 'municipal' },
        '08-05': { name: 'Fiestas Patronales de San Salvador', legalBasis: 'Código de Trabajo art. 190 inc. 2', type: 'municipal' }
    });

    // 3. Asuetos internos fijos de DUCTSAL (Días no laborables por política interna empresarial)
    const DUCTSAL_COMPANY_HOLIDAYS_FIXED = Object.freeze({
        '08-04': { name: 'Asueto Interno Ductsal (Fiestas Agostinas)', legalBasis: 'Política interna empresarial Ductsal', type: 'company' },
        '12-24': { name: 'Víspera de Navidad (Cierre Empresarial Ductsal)', legalBasis: 'Política interna empresarial Ductsal', type: 'company' },
        '12-31': { name: 'Fin de Año (Cierre Empresarial Ductsal)', legalBasis: 'Política interna empresarial Ductsal', type: 'company' }
    });

    /**
     * Algoritmo astronómico de Butcher (Meeus/Jones/Butcher) para el cálculo del Domingo de Pascua.
     * Válido para cualquier año del calendario gregoriano.
     * @param {number} year Año gregoriano (ej. 2026)
     * @returns {{ year: number, month: number, day: number }} Mes (1-12) y Día (1-31)
     */
    function getEasterSunday(year) {
        const y = parseInt(year, 10);
        const a = y % 19;
        const b = Math.floor(y / 100);
        const c = y % 100;
        const d = Math.floor(b / 4);
        const e = b % 4;
        const f = Math.floor((b + 8) / 25);
        const g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4);
        const k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return { year: y, month, day };
    }

    /**
     * Calcula los asuetos móviles de Semana Santa para un año dado:
     * - Miércoles Santo (Pascua - 4 días) -> Asueto interno DUCTSAL (type: 'company')
     * - Jueves Santo (Pascua - 3 días) -> Asueto nacional legal (type: 'national')
     * - Viernes Santo (Pascua - 2 días) -> Asueto nacional legal (type: 'national')
     * - Sábado Santo (Pascua - 1 día) -> Asueto nacional legal (type: 'national')
     *
     * @param {number} year
     * @returns {Record<string, { name: string, legalBasis: string, type: 'national'|'company' }>}
     */
    function getSemanaSantaHolidays(year) {
        const easter = getEasterSunday(year);
        // Usar UTC puro para aritmética de días sin desviaciones de huso horario
        const easterUtc = Date.UTC(easter.year, easter.month - 1, easter.day);
        const result = {};

        const offsetDays = [
            { offset: -4, name: 'Miércoles Santo', legalBasis: 'Política interna empresarial Ductsal', type: 'company' },
            { offset: -3, name: 'Jueves Santo', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
            { offset: -2, name: 'Viernes Santo', legalBasis: 'Código de Trabajo art. 190', type: 'national' },
            { offset: -1, name: 'Sábado Santo', legalBasis: 'Código de Trabajo art. 190', type: 'national' }
        ];

        offsetDays.forEach(item => {
            const d = new Date(easterUtc + item.offset * 86400000);
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            const key = `${year}-${mm}-${dd}`;
            result[key] = {
                name: item.name,
                legalBasis: item.legalBasis,
                type: item.type
            };
        });

        return result;
    }

    /**
     * Extrae de forma segura la fecha en formato YYYY-MM-DD interpretada en America/El_Salvador.
     * Si la entrada ya es YYYY-MM-DD, la devuelve directamente sin alterar.
     * @param {string|Date|number} input
     * @returns {string} Fecha YYYY-MM-DD o cadena vacía si es inválida.
     */
    function toCanonicalYMD(input) {
        if (!input) return '';
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        }
        const dt = (input instanceof Date && !isNaN(input.getTime())) ? input : new Date(input);
        if (isNaN(dt.getTime())) return '';
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE_CANONICAL,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(dt);
    }

    /**
     * Parsea cualquier entrada a un objeto Date a medianoche local canónica.
     * @param {string|Date|number} input
     * @returns {Date|null}
     */
    function parseDateCanonical(input) {
        const ymd = toCanonicalYMD(input);
        if (!ymd) return null;
        const [y, m, d] = ymd.split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0);
    }

    /**
     * Evalúa si una fecha dada corresponde a un asueto (nacional, municipal o interno de Ductsal).
     * @param {string|Date|number} dateInput Fecha a evaluar
     * @param {object} [options]
     * @param {boolean} [options.includeSanSalvadorMunicipal=true] Incluir asuetos de San Salvador (3 y 5 de agosto)
     * @param {boolean} [options.includeCompanyHolidays=true] Incluir asuetos internos de Ductsal (Miércoles Santo, 4 ago, 24 dic, 31 dic)
     * @param {string[]} [options.companyClosedDates=[]] Lista de fechas adicionales de cierre empresarial
     * @returns {{ isHoliday: boolean, name: string, type: 'national'|'municipal'|'company', legalBasis: string }|null}
     */
    function getHolidayInfo(dateInput, options = {}) {
        const ymd = toCanonicalYMD(dateInput);
        if (!ymd) return null;
        const [yearStr, monthStr, dayStr] = ymd.split('-');
        const year = parseInt(yearStr, 10);
        const mmdd = `${monthStr}-${dayStr}`;

        const includeSanSalvador = options.includeSanSalvadorMunicipal !== false;
        const includeCompany = options.includeCompanyHolidays !== false;
        const companyDates = Array.isArray(options.companyClosedDates) ? options.companyClosedDates : [];

        // 1. Asuetos nacionales fijos por Ley (Código de Trabajo art. 190, D.L. 208, D.L. 339)
        if (NATIONAL_FIXED_HOLIDAYS[mmdd]) {
            const h = NATIONAL_FIXED_HOLIDAYS[mmdd];
            return {
                isHoliday: true,
                name: h.name,
                type: h.type,
                legalBasis: h.legalBasis
            };
        }

        // 2. Asuetos móviles de Semana Santa (Miércoles Santo [company], Jueves/Viernes/Sábado Santo [national])
        const semanaSanta = getSemanaSantaHolidays(year);
        if (semanaSanta[ymd]) {
            const h = semanaSanta[ymd];
            if (h.type === 'company' && !includeCompany) {
                // omitido si la empresa desactiva asuetos internos
            } else {
                return {
                    isHoliday: true,
                    name: h.name,
                    type: h.type,
                    legalBasis: h.legalBasis
                };
            }
        }

        // 3. Asuetos locales municipales de San Salvador (art. 190 inc. 2 C.T.: 3 y 5 de agosto)
        if (includeSanSalvador && SAN_SALVADOR_MUNICIPAL_HOLIDAYS[mmdd]) {
            const h = SAN_SALVADOR_MUNICIPAL_HOLIDAYS[mmdd];
            return {
                isHoliday: true,
                name: h.name,
                type: h.type,
                legalBasis: h.legalBasis
            };
        }

        // 4. Asuetos internos fijos de DUCTSAL (4 de agosto, 24 de diciembre, 31 de diciembre)
        if (includeCompany && DUCTSAL_COMPANY_HOLIDAYS_FIXED[mmdd]) {
            const h = DUCTSAL_COMPANY_HOLIDAYS_FIXED[mmdd];
            return {
                isHoliday: true,
                name: h.name,
                type: h.type,
                legalBasis: h.legalBasis
            };
        }

        // 5. Cierres adicionales definidos voluntariamente por la empresa
        if (companyDates.length > 0) {
            if (companyDates.includes(ymd) || companyDates.includes(mmdd)) {
                return {
                    isHoliday: true,
                    name: 'Cierre Empresarial / Día Libre Concedido por la Empresa',
                    type: 'company',
                    legalBasis: 'Política interna empresarial de Ductsal'
                };
            }
        }

        return null;
    }

    /**
     * Retorna el crédito de jornada laboral que aporta un día determinado:
     * - Domingo: 0.0 (día de descanso semanal)
     * - Asueto legal o interno: 0.0
     * - Sábado: 0.5 (media jornada ordinaria: 8:00 a. m. a 12:00 p. m.)
     * - Lunes a viernes: 1.0 (jornada ordinaria completa: 8:00 a. m. a 5:00 p. m.)
     *
     * @param {string|Date|number} dateInput
     * @param {object} [options]
     * @returns {number} Crédito laboral del día (0.0, 0.5 o 1.0)
     */
    function getWorkDayCredit(dateInput, options = {}) {
        const ymd = toCanonicalYMD(dateInput);
        if (!ymd) return 0;

        const holiday = getHolidayInfo(ymd, options);
        if (holiday && holiday.isHoliday) {
            return 0.0;
        }

        const [y, m, d] = ymd.split('-').map(Number);
        const utcDate = new Date(Date.UTC(y, m - 1, d));
        const dayOfWeek = utcDate.getUTCDay();

        if (dayOfWeek === 0) {
            // Domingo
            return 0.0;
        }
        if (dayOfWeek === 6) {
            // Sábado (media jornada)
            return 0.5;
        }
        // Lunes a viernes (jornada ordinaria completa)
        return 1.0;
    }

    /**
     * Determina si una fecha es laborable (crédito laboral > 0).
     * El sábado es laborable a media jornada (0.5).
     * @param {string|Date|number} dateInput
     * @param {object} [options]
     * @returns {boolean}
     */
    function isWorkDay(dateInput, options = {}) {
        return getWorkDayCredit(dateInput, options) > 0;
    }

    /**
     * Determina si una fecha corresponde a media jornada (sábado laborable no festivo).
     * @param {string|Date|number} dateInput
     * @param {object} [options]
     * @returns {boolean}
     */
    function isHalfDay(dateInput, options = {}) {
        return getWorkDayCredit(dateInput, options) === 0.5;
    }

    /**
     * Obtiene el siguiente día laborable a partir de una fecha dada.
     * Si options.isExternalContact === true, omite también los sábados, buscando el
     * siguiente día hábil de jornada completa (lunes a viernes no festivo).
     *
     * @param {string|Date|number} dateInput
     * @param {object} [options]
     * @param {boolean} [options.isExternalContact=false] Si es verdadero, busca día hábil para contacto externo (evita sábados)
     * @returns {Date}
     */
    function getNextWorkDay(dateInput, options = {}) {
        const ymd = toCanonicalYMD(dateInput);
        if (!ymd) return new Date();
        const [y, m, d] = ymd.split('-').map(Number);
        let curUtc = Date.UTC(y, m - 1, d, 12, 0, 0);

        while (true) {
            curUtc += 86400000;
            const curDate = new Date(curUtc);
            const curYmd = `${curDate.getUTCFullYear()}-${String(curDate.getUTCMonth() + 1).padStart(2, '0')}-${String(curDate.getUTCDate()).padStart(2, '0')}`;
            const credit = getWorkDayCredit(curYmd, options);

            if (credit > 0) {
                if (options.isExternalContact === true && curDate.getUTCDay() === 6) {
                    // Si es contacto externo, el sábado no se prefiere; continúa buscando
                    continue;
                }
                return parseDateCanonical(curYmd);
            }
        }
    }

    /**
     * Ajusta una fecha si cae en sábado o día no laborable cuando se trata de un contacto externo.
     * Si la fecha es sábado o día no hábil y es contacto externo, traslada al siguiente día laborable.
     * Si es una tarea interna o la fecha ya es laborable, la mantiene intacta.
     *
     * @param {string|Date|number} dateInput
     * @param {object} [options]
     * @param {boolean} [options.isExternalContact=true]
     * @returns {Date}
     */
    function adjustDateForExternalContact(dateInput, options = {}) {
        const ymd = toCanonicalYMD(dateInput);
        if (!ymd) return new Date();
        const [y, m, d] = ymd.split('-').map(Number);

        const credit = getWorkDayCredit(ymd, options);
        const dayOfWeek = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();

        const isExternal = options.isExternalContact !== false;
        // Si no es laborable (domingo o festivo), o si es sábado y es contacto externo:
        if (credit === 0 || (dayOfWeek === 6 && isExternal)) {
            let curUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
            while (true) {
                curUtc += 86400000;
                const nextDate = new Date(curUtc);
                const nextYmd = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDate.getUTCDate()).padStart(2, '0')}`;
                const nextCredit = getWorkDayCredit(nextYmd, options);
                const nextDayOfWeek = nextDate.getUTCDay();

                if (nextCredit > 0) {
                    if (isExternal && nextDayOfWeek === 6) {
                        continue;
                    }
                    return parseDateCanonical(nextYmd);
                }
            }
        }

        return parseDateCanonical(ymd);
    }

    /**
     * Añade una cantidad determinada de tiempo laboral (en días de jornada) a una fecha inicial.
     * Mecánica del cálculo:
     * - El conteo inicia a partir del día siguiente al evento de inicio.
     * - Lunes a viernes aportan 1.0 día de crédito laboral.
     * - El sábado aporta exactamente 0.5 día de crédito laboral.
     * - Domingos y asuetos/cierres aportan 0.0.
     * - El ciclo concluye en cuanto el crédito acumulado alcanza o supera el crédito requerido.
     * - Si se alcanza en sábado y options.isExternalContact === true (o allowSaturdayDeadline === false):
     *   se traslada al siguiente día laborable disponible para atención a clientes.
     * - Si es una tarea interna (isExternalContact === false), conserva el sábado.
     *
     * @param {string|Date|number} startDate Fecha de inicio
     * @param {number} workDaysNeeded Crédito de días laborales requeridos (ej. 5 para oferta inicial, 2 para siguiente intento)
     * @param {object} [options]
     * @param {boolean} [options.isExternalContact=false] Trasladar a lunes/siguiente laborable si cae en sábado
     * @param {boolean} [options.allowSaturdayDeadline] Sobrescribe explícitamente la admisión de sábados
     * @param {boolean} [options.includeSanSalvadorMunicipal=true]
     * @param {boolean} [options.includeCompanyHolidays=true]
     * @param {string[]} [options.companyClosedDates=[]]
     * @returns {Date} Objeto Date a medianoche canónica con la fecha resultante
     */
    function addWorkDays(startDate, workDaysNeeded, options = {}) {
        const ymd = toCanonicalYMD(startDate || new Date());
        if (!ymd) return new Date();

        const needed = Math.max(0, parseFloat(workDaysNeeded) || 0);
        if (needed === 0) {
            return parseDateCanonical(ymd);
        }

        const [y, m, d] = ymd.split('-').map(Number);
        let curUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
        let accumulatedCredit = 0.0;

        // Iterar día por día acumulando crédito
        while (accumulatedCredit < needed) {
            curUtc += 86400000;
            const curDate = new Date(curUtc);
            const curYmd = `${curDate.getUTCFullYear()}-${String(curDate.getUTCMonth() + 1).padStart(2, '0')}-${String(curDate.getUTCDate()).padStart(2, '0')}`;
            const credit = getWorkDayCredit(curYmd, options);
            accumulatedCredit += credit;
        }

        // Determinar si los sábados deben trasladarse al siguiente día hábil
        const shouldRollSaturday = options.isExternalContact === true || options.allowSaturdayDeadline === false || options.rollSaturday === true;

        if (shouldRollSaturday) {
            const testDate = new Date(curUtc);
            if (testDate.getUTCDay() === 6) {
                // Sábado: buscar siguiente día hábil para contacto
                while (true) {
                    curUtc += 86400000;
                    const nextDate = new Date(curUtc);
                    const nextYmd = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDate.getUTCDate()).padStart(2, '0')}`;
                    if (getWorkDayCredit(nextYmd, options) > 0 && nextDate.getUTCDay() !== 6) {
                        break;
                    }
                }
            }
        }

        const res = new Date(curUtc);
        const resYmd = `${res.getUTCFullYear()}-${String(res.getUTCMonth() + 1).padStart(2, '0')}-${String(res.getUTCDate()).padStart(2, '0')}`;
        return parseDateCanonical(resYmd);
    }

    /**
     * Función explícita para añadir días laborales garantizando el traslado de sábados al siguiente día laborable.
     */
    function addWorkDaysForExternalContact(startDate, workDaysNeeded, options = {}) {
        return addWorkDays(startDate, workDaysNeeded, { ...options, isExternalContact: true });
    }

    /**
     * Retorna la fecha resultante de añadir días laborales en formato YYYY-MM-DD.
     */
    function addWorkDaysYMD(startDate, workDaysNeeded, options = {}) {
        const dt = addWorkDays(startDate, workDaysNeeded, options);
        return toCanonicalYMD(dt);
    }

    /**
     * Calcula el tiempo laboral acumulado (en créditos de jornada) entre dos fechas.
     * Excluye la fecha de inicio e incluye la fecha de fin (intervalo semi-abierto (inicio, fin]).
     * Si endDate <= startDate, retorna 0.
     *
     * @param {string|Date|number} startDate
     * @param {string|Date|number} endDate
     * @param {object} [options]
     * @returns {number} Créditos laborales acumulados (múltiplos de 0.5)
     */
    function getWorkTimeBetween(startDate, endDate, options = {}) {
        const ymdStart = toCanonicalYMD(startDate);
        const ymdEnd = toCanonicalYMD(endDate);
        if (!ymdStart || !ymdEnd) return 0;

        const [yS, mS, dS] = ymdStart.split('-').map(Number);
        const [yE, mE, dE] = ymdEnd.split('-').map(Number);

        let curUtc = Date.UTC(yS, mS - 1, dS);
        const endUtc = Date.UTC(yE, mE - 1, dE);

        if (endUtc <= curUtc) return 0;

        let totalCredit = 0.0;
        while (curUtc < endUtc) {
            curUtc += 86400000;
            const curDate = new Date(curUtc);
            const curYmd = `${curDate.getUTCFullYear()}-${String(curDate.getUTCMonth() + 1).padStart(2, '0')}-${String(curDate.getUTCDate()).padStart(2, '0')}`;
            totalCredit += getWorkDayCredit(curYmd, options);
        }

        return totalCredit;
    }

    return {
        TIMEZONE_CANONICAL,
        NATIONAL_FIXED_HOLIDAYS,
        SAN_SALVADOR_MUNICIPAL_HOLIDAYS,
        DUCTSAL_COMPANY_HOLIDAYS_FIXED,
        getEasterSunday,
        getSemanaSantaHolidays,
        toCanonicalYMD,
        parseDateCanonical,
        getHolidayInfo,
        getWorkDayCredit,
        isWorkDay,
        isHalfDay,
        getNextWorkDay,
        adjustDateForExternalContact,
        addWorkDays,
        addWorkDaysForExternalContact,
        addWorkDaysYMD,
        getWorkTimeBetween
    };
});
