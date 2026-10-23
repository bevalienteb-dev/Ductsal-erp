// crm_followup_calc.js
// Universal business logic for Daily Follow-up Agenda and Negotiation Cadence.
// Runs both in the browser (window.CrmFollowUpCalc) and in Node.js (Jest unit tests).

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        let workCalendar = null;
        try {
            workCalendar = require('./crm_work_calendar');
        } catch (e) {
            // fallback
        }
        module.exports = factory(workCalendar);
    } else {
        root.CrmFollowUpCalc = factory(root.CrmWorkCalendar);
    }
})(typeof window !== 'undefined' ? window : globalThis, function (injectedWorkCalendar) {
    'use strict';

    const getWorkCalendar = () => {
        if (injectedWorkCalendar) return injectedWorkCalendar;
        if (typeof window !== 'undefined' && window.CrmWorkCalendar) return window.CrmWorkCalendar;
        if (typeof globalThis !== 'undefined' && globalThis.CrmWorkCalendar) return globalThis.CrmWorkCalendar;
        if (typeof require === 'function') {
            try { return require('./crm_work_calendar'); } catch (e) { return null; }
        }
        return null;
    };

    // Cadence configuration according to Section 4 of specification:
    // 1. Primer seguimiento: 5 días hábiles tras entrega efectiva de cotización.
    // 2. Si no responde al 1er contacto: 2 días hábiles y DEBE ser mediante llamada.
    // 3. Siguientes intentos fallidos: intervalos de 2 días hábiles.
    // 4. Tras 3 intentos sin respuesta: requiere decisión (justificar continuidad o proponer cierre).
    // 5. Si continúa, requiere motivo y próxima acción.
    // 6. Tras 5 intentos sin respuesta: alerta gerencial para revisión de estancamiento.
    // 7. Si pide más tiempo: 15 días calendario de pauta inicial si no se acuerda otra fecha.
    const FOLLOWUP_CADENCE = Object.freeze({
        INITIAL_DAYS_AFTER_QUOTE_BUSINESS: 5,
        UNANSWERED_INTERVAL_BUSINESS: 2,
        DEFAULT_MORE_TIME_CALENDAR_DAYS: 15,
        MANDATORY_CALL_ATTEMPT: 2,
        DECISION_REQUIRED_ATTEMPTS: 3,
        MANAGER_ESCALATION_ATTEMPTS: 5,
        UPCOMING_THRESHOLD_DAYS: 7
    });

    const FOLLOWUP_CHANNELS = Object.freeze([
        'llamada',
        'correo',
        'whatsapp',
        'reunion',
        'interno'
    ]);

    const FOLLOWUP_CHANNEL_LABELS = Object.freeze({
        llamada: '📞 Llamada Telefónica',
        correo: '✉️ Correo Electrónico',
        whatsapp: '💬 WhatsApp Corporativo',
        reunion: '🤝 Reunión Presencial',
        interno: '📝 Nota Interna de Gestión'
    });

    const FOLLOWUP_RESULTS = Object.freeze([
        'respondio_evaluando',
        'solicito_tiempo',
        'solicito_cambios',
        'sin_respuesta',
        'no_continua',
        'nota_interna'
    ]);

    const FOLLOWUP_RESULT_LABELS = Object.freeze({
        respondio_evaluando: 'Cliente respondió y continúa evaluando',
        solicito_tiempo: 'Cliente solicitó más tiempo',
        solicito_cambios: 'Cliente solicitó cambios o nueva cotización',
        sin_respuesta: 'Se intentó contactar y no hubo respuesta',
        no_continua: 'Cliente confirmó que no desea continuar',
        nota_interna: 'Nota interna sin contacto con el cliente'
    });

    // Zona horaria comercial oficial de DUCTSAL (El Salvador: UTC-6, sin horario de verano)
    const TIMEZONE_COMMERCIAL = 'America/El_Salvador';

    /**
     * Extrae de forma segura la fecha en formato YYYY-MM-DD en la zona horaria comercial de El Salvador.
     * Si la entrada ya es una cadena YYYY-MM-DD, la devuelve tal cual.
     * Si es Date o timestamp ISO, la interpreta en America/El_Salvador.
     */
    function getCommercialYMD(input = new Date()) {
        if (!input) return '';
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        }
        const dt = (input instanceof Date && !isNaN(input.getTime())) ? input : new Date(input);
        if (isNaN(dt.getTime())) return '';
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE_COMMERCIAL,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(dt);
    }

    /**
     * Valida y parsea una fecha a objeto Date en la fecha comercial de El Salvador.
     */
    function parseDate(input) {
        if (!input) return null;
        if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
        const ymd = getCommercialYMD(input);
        if (!ymd) return null;
        const parts = ymd.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    }

    /**
     * Formatea fecha a YYYY-MM-DD en zona horaria comercial de El Salvador.
     */
    function formatDateYMD(d) {
        if (!d) return '';
        return getCommercialYMD(d);
    }

    /**
     * Añade días laborales según el calendario laboral de Ductsal y la legislación salvadoreña.
     * Si el módulo CrmWorkCalendar está presente, delega en él considerando:
     * - Jornada completa lunes a viernes (1.0)
     * - Media jornada sábados (0.5)
     * - Asuetos oficiales de El Salvador y cierres configurables
     * En caso de no estar disponible, ejecuta fallback de días hábiles.
     */
    function addBusinessDays(startDate, numDays, options) {
        const cal = getWorkCalendar();
        if (cal && typeof cal.addWorkDays === 'function') {
            return cal.addWorkDays(startDate, numDays, options);
        }
        const ymd = getCommercialYMD(startDate || new Date());
        if (!ymd) return new Date();
        const [y, m, d] = ymd.split('-').map(Number);
        let curUtc = Date.UTC(y, m - 1, d);
        const daysToAdd = Math.max(0, parseInt(numDays, 10) || 0);

        let added = 0;
        while (added < daysToAdd) {
            curUtc += 86400000;
            const curDate = new Date(curUtc);
            const dayOfWeek = curDate.getUTCDay(); // 0: Dom, 6: Sáb
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                added++;
            }
        }
        const res = new Date(curUtc);
        return new Date(res.getUTCFullYear(), res.getUTCMonth(), res.getUTCDate(), 0, 0, 0, 0);
    }

    /**
     * Añade días calendario.
     */
    function addCalendarDays(startDate, numDays) {
        const ymd = getCommercialYMD(startDate || new Date());
        if (!ymd) return new Date();
        const [y, m, d] = ymd.split('-').map(Number);
        const curUtc = Date.UTC(y, m - 1, d) + (parseInt(numDays, 10) || 0) * 86400000;
        const res = new Date(curUtc);
        return new Date(res.getUTCFullYear(), res.getUTCMonth(), res.getUTCDate(), 0, 0, 0, 0);
    }

    /**
     * Calcula la diferencia de días calendario enteros entre dos fechas (B - A).
     * Utiliza aritmética pura en UTC medianoche para eliminar cualquier efecto de cambio de hora (DST).
     */
    function diffDaysCalendar(dateA, dateB) {
        const ymdA = getCommercialYMD(dateA);
        const ymdB = getCommercialYMD(dateB);
        if (!ymdA || !ymdB) return 0;
        const [yA, mA, dA] = ymdA.split('-').map(Number);
        const [yB, mB, dB] = ymdB.split('-').map(Number);
        const utcA = Date.UTC(yA, mA - 1, dA);
        const utcB = Date.UTC(yB, mB - 1, dB);
        return Math.round((utcB - utcA) / 86400000);
    }

    /**
     * Añade días laborales garantizando el traslado de contactos externos fuera de sábados.
     */
    function addBusinessDaysForExternalContact(startDate, numDays, options = {}) {
        return addBusinessDays(startDate, numDays, { ...options, isExternalContact: true });
    }

    /**
     * Sugiere la próxima fecha de contacto según la cadencia comercial de la Sección 4.
     * Distingue explícitamente entre contactos externos y tareas internas:
     * - Para contactos externos (llamadas, WhatsApp, correos): si la fecha calculada cae en sábado,
     *   se traslada al siguiente día laborable disponible.
     * - Para tareas internas: pueden permanecer programadas en sábado (8:00 a 12:00).
     */
    function suggestNextContactDate(fromDate, resultado, prevUnanswered = 0, options = {}) {
        if (resultado === 'no_continua' || resultado === 'nota_interna') {
            return null;
        }
        const base = parseDate(fromDate) || new Date();
        const cal = getWorkCalendar();

        const isInternal = options.isInternal === true || options.channel === 'interno' || options.tipo === 'revision';
        const isExternal = options.isExternalContact === true || (options.isExternalContact === undefined && options.channel && options.channel !== 'interno') || options.rollSaturday === true;

        if (resultado === 'solicito_tiempo') {
            const rawDate = addCalendarDays(base, FOLLOWUP_CADENCE.DEFAULT_MORE_TIME_CALENDAR_DAYS);
            if (isExternal && cal && typeof cal.adjustDateForExternalContact === 'function') {
                return cal.adjustDateForExternalContact(rawDate, options);
            }
            return rawDate;
        }

        let daysToAdd = FOLLOWUP_CADENCE.UNANSWERED_INTERVAL_BUSINESS;
        if (resultado === 'solicito_cambios') {
            daysToAdd = FOLLOWUP_CADENCE.INITIAL_DAYS_AFTER_QUOTE_BUSINESS;
        }

        const workOptions = {
            ...options,
            isExternalContact: isExternal && !isInternal
        };

        return addBusinessDays(base, daysToAdd, workOptions);
    }

    /**
     * Sugiere fecha de seguimiento para un contacto externo (llamada, WhatsApp, correo).
     * Si cae en sábado, traslada automáticamente al siguiente día laborable disponible.
     */
    function suggestNextExternalContactDate(fromDate, resultado, prevUnanswered = 0, options = {}) {
        return suggestNextContactDate(fromDate, resultado, prevUnanswered, { ...options, isExternalContact: true });
    }

    /**
     * Sugiere fecha para tareas o revisiones internas que sí admiten sábados de 8:00 a 12:00.
     */
    function suggestNextInternalTaskDate(fromDate, resultado, prevUnanswered = 0, options = {}) {
        return suggestNextContactDate(fromDate, resultado, prevUnanswered, { ...options, isInternal: true });
    }

    /**
     * Clasifica el estado de seguimiento de una oportunidad para la Agenda Diaria.
     */
    function classifyFollowUp(prospect, now = new Date()) {
        if (!prospect || prospect.eliminado === true || prospect.estado !== 'activo') {
            return {
                inAgenda: false,
                status: 'inactivo',
                reason: 'Oportunidad inactiva, cerrada o eliminada'
            };
        }

        const todayYMD = getCommercialYMD(now);
        const seguimiento = (prospect.seguimiento && typeof prospect.seguimiento === 'object') ? prospect.seguimiento : {};
        const cadencia = (seguimiento.cadencia && typeof seguimiento.cadencia === 'object') ? seguimiento.cadencia : {};
        const proximaAccion = (seguimiento.proxima_accion && typeof seguimiento.proxima_accion === 'object') ? seguimiento.proxima_accion : null;
        const ultimoContacto = (seguimiento.ultimo_contacto && typeof seguimiento.ultimo_contacto === 'object') ? seguimiento.ultimo_contacto : null;

        const intentosFallidos = Number(cadencia.intentos_fallidos) || 0;
        const isEscalado = cadencia.alerta_gerencial === true || intentosFallidos >= FOLLOWUP_CADENCE.MANAGER_ESCALATION_ATTEMPTS;
        const isDecisionReq = intentosFallidos >= FOLLOWUP_CADENCE.DECISION_REQUIRED_ATTEMPTS && !isEscalado;
        const isCallMandatory = intentosFallidos === 1; // El intento 2 debe ser llamada

        // Verificar si existe fecha de próxima acción programada
        const targetYMD = (proximaAccion && proximaAccion.fecha) ? getCommercialYMD(proximaAccion.fecha) : '';

        // Si no tiene próxima acción registrada:
        if (!targetYMD) {
            const etapa = prospect.etapa || 'prospecto';

            if (isEscalado) {
                return {
                    inAgenda: true,
                    status: 'pendiente_decision',
                    isEscaladoGerencia: true,
                    dias_retraso: 0,
                    intentos_fallidos: intentosFallidos,
                    requiere_decision: true,
                    llamada_obligatoria: isCallMandatory,
                    proxima_accion: proximaAccion,
                    ultimo_contacto: ultimoContacto,
                    motivo_agenda: '🚨 Escalada a Gerencia: 5 o más intentos sin respuesta del cliente',
                    prioridad: 100
                };
            }

            if (isDecisionReq) {
                return {
                    inAgenda: true,
                    status: 'pendiente_decision',
                    isDecisionVendedor: true,
                    dias_retraso: 0,
                    intentos_fallidos: intentosFallidos,
                    requiere_decision: true,
                    llamada_obligatoria: isCallMandatory,
                    proxima_accion: proximaAccion,
                    ultimo_contacto: ultimoContacto,
                    motivo_agenda: '⚠️ 3 intentos sin respuesta: Vendedor debe decidir si justifica continuar o propone cierre',
                    prioridad: 90
                };
            }

            // Oportunidades sin seguimiento programado
            return {
                inAgenda: true,
                status: 'sin_seguimiento',
                dias_retraso: 0,
                intentos_fallidos: intentosFallidos,
                requiere_decision: true,
                llamada_obligatoria: isCallMandatory,
                proxima_accion: null,
                ultimo_contacto: ultimoContacto,
                motivo_agenda: (etapa === 'cotizacion' || etapa === 'negociacion')
                    ? '📋 Sin seguimiento programado: Registra la fecha de entrega de oferta o programa contacto'
                    : 'Sin próxima acción programada en pipeline activo',
                prioridad: 40
            };
        }

        // Evaluar fecha objetivo con respecto a hoy comercial en El Salvador
        // diffDays = (todayYMD - targetYMD)
        const diffDays = diffDaysCalendar(targetYMD, todayYMD);

        let status = 'al_dia';
        let motivo = '';
        let prioridad = 10;
        let diasRetraso = 0;

        if (isEscalado) {
            status = 'pendiente_decision';
            motivo = `🚨 Escalada a Gerencia (5+ intentos fallidos). Acción: ${(proximaAccion && proximaAccion.descripcion) || 'Revisión con Gerencia'}`;
            prioridad = 100;
            diasRetraso = Math.max(0, diffDays);
        } else if (isDecisionReq) {
            status = 'pendiente_decision';
            motivo = `⚠️ Requiere decisión (3 intentos fallidos). Acción: ${(proximaAccion && proximaAccion.descripcion) || 'Definir continuidad o cierre'}`;
            prioridad = 90;
            diasRetraso = Math.max(0, diffDays);
        } else if (diffDays > 0) {
            status = 'vencida';
            diasRetraso = diffDays;
            motivo = `Vencido hace ${diffDays} día${diffDays > 1 ? 's' : ''} (compromiso: ${targetYMD})`;
            prioridad = 80 + Math.min(10, diffDays); // Más días vencida = mayor prioridad
        } else if (diffDays === 0) {
            status = 'hoy';
            diasRetraso = 0;
            motivo = isCallMandatory
                ? '📞 Programado para HOY (Intento 2: Llamada obligatoria)'
                : 'Programado para HOY';
            prioridad = 70;
        } else if (diffDays >= -FOLLOWUP_CADENCE.UPCOMING_THRESHOLD_DAYS) {
            status = 'proxima';
            diasRetraso = 0;
            const diasFaltantes = Math.abs(diffDays);
            motivo = `Próximo a vencer en ${diasFaltantes} día${diasFaltantes > 1 ? 's' : ''} (${targetYMD})`;
            prioridad = 50 - diasFaltantes;
        } else {
            status = 'al_dia';
            diasRetraso = 0;
            motivo = `Programado para ${targetYMD}`;
            prioridad = 20;
        }

        return {
            inAgenda: status !== 'al_dia',
            status,
            dias_retraso: diasRetraso,
            intentos_fallidos: intentosFallidos,
            requiere_decision: isEscalado || isDecisionReq,
            isEscaladoGerencia: isEscalado,
            isDecisionVendedor: isDecisionReq,
            llamada_obligatoria: isCallMandatory,
            proxima_accion: proximaAccion,
            ultimo_contacto: ultimoContacto,
            motivo_agenda: motivo,
            prioridad
        };
    }

    /**
     * Construye la lista consolidada de la Agenda Diaria para el vendedor o gerente.
     */
    function generateAgenda(prospectsList, user, filterStatus = 'todas', now = new Date()) {
        const list = Array.isArray(prospectsList) ? prospectsList : [];
        const isManager = user && (user.role === 'manager' || user.role === 'gestor');

        const items = [];
        const counts = {
            vencidas: 0,
            hoy: 0,
            proximas: 0,
            pendientes_decision: 0,
            escaladas_gerencia: 0,
            total: 0
        };

        list.forEach(p => {
            if (!p || p.eliminado === true || p.estado !== 'activo') return;

            // Filtro de visibilidad por rol
            if (!isManager && user && user.cid) {
                if (p.vendedorId !== user.cid && p.createdBy !== user.cid) return;
            }

            const classification = classifyFollowUp(p, now);
            if (!classification.inAgenda && filterStatus !== 'todas_abiertas') return;

            // Conteo por categoría
            if (classification.status === 'vencida') counts.vencidas++;
            if (classification.status === 'hoy') counts.hoy++;
            if (classification.status === 'proxima') counts.proximas++;
            if (classification.status === 'pendiente_decision' || classification.status === 'sin_seguimiento') counts.pendientes_decision++;
            if (classification.isEscaladoGerencia) counts.escaladas_gerencia++;
            counts.total++;

            // Aplicar filtro si se especificó
            if (filterStatus && filterStatus !== 'todas') {
                if (filterStatus === 'vencidas' && classification.status !== 'vencida') return;
                if (filterStatus === 'hoy' && classification.status !== 'hoy') return;
                if (filterStatus === 'proximas' && classification.status !== 'proxima') return;
                if (filterStatus === 'pendientes_decision' && classification.status !== 'pendiente_decision' && classification.status !== 'sin_seguimiento') return;
                if (filterStatus === 'escaladas_gerencia' && !classification.isEscaladoGerencia) return;
            }

            items.push({
                prospect: p,
                id: p.id,
                codigo: p.codigo || (p.id ? String(p.id).slice(-4) : '-'),
                clientId: p.clientId,
                proyecto: p.proyecto || 'Sin Nombre',
                vendedorId: p.vendedorId,
                vendedorName: p.vendedorName || p.vendedor || 'Sin Asignar',
                etapa: p.etapa || 'prospecto',
                monto: Number(p.precio_cotizado) || 0,
                classification
            });
        });

        // Ordenamiento jerárquico por severidad y prioridad
        items.sort((a, b) => {
            if (b.classification.prioridad !== a.classification.prioridad) {
                return b.classification.prioridad - a.classification.prioridad;
            }
            if (b.classification.dias_retraso !== a.classification.dias_retraso) {
                return b.classification.dias_retraso - a.classification.dias_retraso;
            }
            return (a.codigo || '').localeCompare(b.codigo || '');
        });

        return {
            items,
            counts
        };
    }

    return {
        TIMEZONE_COMMERCIAL,
        FOLLOWUP_CADENCE,
        FOLLOWUP_CHANNELS,
        FOLLOWUP_CHANNEL_LABELS,
        FOLLOWUP_RESULTS,
        FOLLOWUP_RESULT_LABELS,
        getWorkCalendar,
        getCommercialYMD,
        parseDate,
        formatDateYMD,
        addBusinessDays,
        addBusinessDaysForExternalContact,
        addCalendarDays,
        diffDaysCalendar,
        suggestNextContactDate,
        suggestNextExternalContactDate,
        suggestNextInternalTaskDate,
        classifyFollowUp,
        generateAgenda
    };
});
