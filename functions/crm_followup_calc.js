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

    // Alternativas de cadencia comercial predefinidas y autorizadas (Fase 2.1)
    const CADENCIAS_VALIDAS = Object.freeze({
        estandar: Object.freeze({
            id: 'estandar',
            nombre: 'Estándar Ductsal (5d inicial / 2d intervalo)',
            descripcion: 'Cadencia comercial por defecto: 1er contacto a 5 días hábiles; reintentos cada 2 días hábiles; pauta de tiempo 15 días.',
            dias_primer_contacto: 5,
            intervalo_sin_respuesta: 2,
            dias_solicito_tiempo: 15
        }),
        urgente: Object.freeze({
            id: 'urgente',
            nombre: 'Proyecto Urgente / Licitación Rápida (3d inicial / 2d intervalo)',
            descripcion: 'Para ofertas de corto plazo o requerimiento inmediato: 1er contacto a 3 días hábiles; reintentos cada 2 días hábiles; pauta de tiempo 7 días.',
            dias_primer_contacto: 3,
            intervalo_sin_respuesta: 2,
            dias_solicito_tiempo: 7
        }),
        corporativa: Object.freeze({
            id: 'corporativa',
            nombre: 'Gran Cuenta / Comité Corporativo (5d inicial / 3d intervalo)',
            descripcion: 'Para cuentas corporativas o procesos con junta/comité: 1er contacto a 5 días hábiles; reintentos cada 3 días hábiles; pauta de tiempo 15 días.',
            dias_primer_contacto: 5,
            intervalo_sin_respuesta: 3,
            dias_solicito_tiempo: 15
        })
    });

    // Límites comerciales obligatorios e inviolables (Invariants de negocio)
    const LIMITES_COMERCIALES_CADENCIA = Object.freeze({
        MIN_DIAS_PRIMER_CONTACTO: 1,
        MAX_DIAS_PRIMER_CONTACTO: 5,
        MIN_INTERVALO_SIN_RESPUESTA: 1,
        MAX_INTERVALO_SIN_RESPUESTA: 3,
        MAX_DIAS_SOLICITO_TIEMPO: 15,
        MANDATORY_CALL_ATTEMPT: 2,
        DECISION_REQUIRED_ATTEMPTS: 3,
        MANAGER_ESCALATION_ATTEMPTS: 5
    });

    function getCadenceConfig(tipoCadencia = 'estandar') {
        if (tipoCadencia && CADENCIAS_VALIDAS[tipoCadencia]) {
            return CADENCIAS_VALIDAS[tipoCadencia];
        }
        return CADENCIAS_VALIDAS.estandar;
    }

    function validateCadenceSelection(cadenceId) {
        if (!cadenceId || typeof cadenceId !== 'string') {
            return { valid: false, error: 'Identificador de cadencia inválido' };
        }
        const cleaned = cadenceId.trim().toLowerCase();
        if (!CADENCIAS_VALIDAS[cleaned]) {
            const validKeys = Object.keys(CADENCIAS_VALIDAS).join(', ');
            return { valid: false, error: `Alternativa de cadencia comercial no autorizada: "${cadenceId}". Opciones válidas: ${validKeys}` };
        }
        return { valid: true, cadence: CADENCIAS_VALIDAS[cleaned] };
    }

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

        const cadConfig = options.cadenceConfig || getCadenceConfig(options.tipoCadencia || (options.cadencia && options.cadencia.tipo_cadencia));

        const isInternal = options.isInternal === true || options.channel === 'interno' || options.tipo === 'revision';
        const isExternal = options.isExternalContact === true || (options.isExternalContact === undefined && options.channel && options.channel !== 'interno') || options.rollSaturday === true;

        if (resultado === 'solicito_tiempo') {
            const timeDays = (cadConfig && cadConfig.dias_solicito_tiempo) || FOLLOWUP_CADENCE.DEFAULT_MORE_TIME_CALENDAR_DAYS;
            const rawDate = addCalendarDays(base, timeDays);
            if (isExternal && cal && typeof cal.adjustDateForExternalContact === 'function') {
                return cal.adjustDateForExternalContact(rawDate, options);
            }
            return rawDate;
        }

        let daysToAdd = (cadConfig && cadConfig.intervalo_sin_respuesta) || FOLLOWUP_CADENCE.UNANSWERED_INTERVAL_BUSINESS;
        if (resultado === 'solicito_cambios' || resultado === 'primer_contacto') {
            daysToAdd = (cadConfig && cadConfig.dias_primer_contacto) || FOLLOWUP_CADENCE.INITIAL_DAYS_AFTER_QUOTE_BUSINESS;
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

        // Regla: Presupuestos referenciales quedan dormidos y no activan cadencia de seguimiento comercial
        if (prospect.clasificacion === 'presupuesto') {
            return {
                inAgenda: false,
                status: 'al_dia',
                isPresupuesto: true,
                sin_fecha_entrega_historica: false,
                dias_retraso: 0,
                intentos_fallidos: 0,
                requiere_decision: false,
                llamada_obligatoria: false,
                proxima_accion: proximaAccion,
                ultimo_contacto: ultimoContacto,
                motivo_agenda: '📐 Cotización para presupuesto referencial (dormido / sin seguimiento comercial activo)',
                prioridad: 0
            };
        }

        const intentosFallidos = Number(cadencia.intentos_fallidos !== undefined ? cadencia.intentos_fallidos : cadencia.intentos_validos_sin_respuesta) || 0;
        const isEscalado = cadencia.alerta_gerencial === true || cadencia.estado_cadencia === 'alerta_gerencial' || intentosFallidos >= FOLLOWUP_CADENCE.MANAGER_ESCALATION_ATTEMPTS;
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
            const isHistoricalNegotiationNoDelivery = (etapa === 'negociacion' && !cadencia.fecha_entrega_oferta && !prospect.fecha_entrega_oferta);
            return {
                inAgenda: true,
                status: 'sin_seguimiento',
                sin_fecha_entrega_historica: isHistoricalNegotiationNoDelivery,
                dias_retraso: 0,
                intentos_fallidos: intentosFallidos,
                requiere_decision: true,
                llamada_obligatoria: isCallMandatory,
                proxima_accion: null,
                ultimo_contacto: ultimoContacto,
                motivo_agenda: isHistoricalNegotiationNoDelivery
                    ? '⚠️ Sin seguimiento programado: Oportunidad histórica en Negociación sin fecha de entrega de oferta registrada (auditar entrega o programar contacto manual)'
                    : ((etapa === 'cotizacion' || etapa === 'negociacion')
                        ? '📋 Sin seguimiento programado: Programa la próxima acción comercial'
                        : 'Sin próxima acción programada en pipeline activo'),
                prioridad: isHistoricalNegotiationNoDelivery ? 45 : 40
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
     * Resuelve de forma determinista y estricta el responsable comercial de una oportunidad o gestión.
     * Atribuye inequívocamente a Alejandra Ayala ('1776904514932') y Roberto Flores ('1788471603604'),
     * resuelve contra el directorio de usuarios proporcionado, y conserva 'Sin Asignar' cuando no hay responsable.
     */
    function resolveSellerName(p, userDirectory = null) {
        if (!p || typeof p !== 'object') return 'Sin Asignar';

        let dir = userDirectory;
        if (!dir && typeof window !== 'undefined' && Array.isArray(window.users)) {
            dir = window.users;
        } else if (!dir && typeof globalThis !== 'undefined' && Array.isArray(globalThis.users)) {
            dir = globalThis.users;
        }

        const findUser = (idOrEmail) => {
            if (!dir || !idOrEmail) return null;
            if (Array.isArray(dir)) {
                return dir.find(u => u && (u.id === idOrEmail || u.cid === idOrEmail || (u.email && u.email.toLowerCase() === String(idOrEmail).toLowerCase())));
            }
            if (typeof dir === 'object') {
                return dir[idOrEmail] || null;
            }
            return null;
        };

        const targetId = (p.vendedorId && String(p.vendedorId).trim() !== '' && String(p.vendedorId) !== 'sistema' && String(p.vendedorId) !== 'Sin Asignar')
            ? String(p.vendedorId).trim()
            : (p.createdBy && String(p.createdBy).trim() !== '' && String(p.createdBy) !== 'sistema' ? String(p.createdBy).trim() : null);

        // 1. Búsqueda directa en el directorio canónico de usuarios por targetId (vendedorId o createdBy)
        if (targetId) {
            const u = findUser(targetId);
            if (u && u.nombre) return u.nombre;
        }

        // 2. Campo vendedorName explícito y válido en el documento
        if (p.vendedorName && typeof p.vendedorName === 'string' && p.vendedorName.trim() !== '' && p.vendedorName !== 'Sin Asignar' && p.vendedorName !== 'Sistema') {
            return p.vendedorName.trim();
        }

        // 3. Fallback a campos históricos de texto en el documento
        if (p.vendedor && typeof p.vendedor === 'string' && p.vendedor.trim() !== '' && p.vendedor !== 'Sin Asignar' && p.vendedor !== 'Sistema' && p.vendedor !== '-') {
            return p.vendedor.trim();
        }
        const creatorName = p.createdByName || p.creado_por;
        if (creatorName && typeof creatorName === 'string' && creatorName.trim() !== '' && creatorName !== 'Sin Asignar' && creatorName !== 'Sistema') {
            return creatorName.trim();
        }

        return 'Sin Asignar';
    }

    /**
     * Construye la lista consolidada de la Agenda Diaria para el vendedor, gestor o gerente.
     * Vendedor y Gestor consultan ÚNICAMENTE sus propias oportunidades asignadas (o creadas sin asignar).
     * Gestor NO recibe acceso global en la agenda. Gerente consulta el pipeline completo en su vista
     * y recibe en su agenda diaria las escalaciones gerenciales y sus propias oportunidades, no la agenda global de llamadas rutinarias.
     */
    function generateAgenda(prospectsList, user, filterStatus = 'todas', now = new Date(), userDirectory = null) {
        const list = Array.isArray(prospectsList) ? prospectsList : [];
        const isManager = user && user.role === 'manager';

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

            const classification = classifyFollowUp(p, now);

            // Filtro de visibilidad estricto por rol:
            // 1. Vendedor y Gestor: ven exclusivamente sus propias oportunidades asignadas (o creadas si no están reasignadas).
            // 2. Gerente/Manager: recibe en su agenda las escalaciones gerenciales y sus oportunidades propias.
            //    NO recibe la agenda diaria global de llamadas y tareas rutinarias de todos los vendedores.
            if (user) {
                const uid = user.cid || user.id;
                const isOwn = uid ? ((p.vendedorId === uid) || (!p.vendedorId && p.createdBy === uid)) : false;
                if (isManager) {
                    if (!classification.isEscaladoGerencia && !isOwn) {
                        return;
                    }
                } else {
                    if (!isOwn) {
                        return;
                    }
                }
            }

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
                vendedorName: resolveSellerName(p, userDirectory),
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

    /**
     * Calcula las oportunidades que requieren atención gerencial en el Dashboard.
     * Criterios aprobados:
     * 1. Cinco intentos válidos de contacto sin respuesta (alcanzado límite de escalamiento).
     * 2. Solicitudes de autorización de venta sin contrato pendientes de resolución.
     * Deduplica oportunidades para que cada una cuente exactamente una vez en el indicador global.
     * Excluye alertas ya resueltas (continuidad autorizada, orden de cierre ejecutada, solicitud resuelta).
     */
    function calculateManagerAttentionItems(prospectsList, userDirectory = null, options = {}) {
        const list = Array.isArray(prospectsList) ? prospectsList : [];
        const { filterStatus = 'todas', filterEstado = null, filterResponsable = 'todos', filterMotivo = 'todos' } = options || {};
        const statusFilter = filterEstado || filterStatus || 'todas';

        const items = [];
        const counts = {
            totalPending: 0,
            cinco_intentos: 0,
            solicitud_sin_contrato: 0,
            resueltas: 0
        };

        list.forEach(p => {
            if (!p || p.eliminado === true) return;

            const motivos = [];
            let isPending = false;
            let alertState = 'al_dia';
            let fechaDeteccion = null;
            let limiteIncumplido = null;
            let valorEsperado = null;
            let valorObservado = null;

            const cad = (p.seguimiento && typeof p.seguimiento === 'object' && p.seguimiento.cadencia) ? p.seguimiento.cadencia : null;
            const solicitudes = Array.isArray(p.solicitudes_sin_contrato) ? p.solicitudes_sin_contrato : [];
            const pendingReq = (p.solicitud_sin_contrato && p.solicitud_sin_contrato.estado === 'pendiente')
                ? p.solicitud_sin_contrato
                : solicitudes.find(r => r && r.estado === 'pendiente');

            // Criterio B: Cinco intentos válidos de contacto sin respuesta en una oportunidad destinada a ejecución
            if (cad && p.estado === 'activo' && p.clasificacion !== 'presupuesto') {
                const intentos = Number(cad.intentos_fallidos || cad.intentos_validos_sin_respuesta) || 0;
                const isEscalado = cad.alerta_gerencial === true ||
                    cad.estado_cadencia === 'escalado_gerencia' ||
                    cad.estado_cadencia === 'escalada_gerencia' ||
                    (intentos >= FOLLOWUP_CADENCE.MANAGER_ESCALATION_ATTEMPTS && cad.estado_cadencia !== 'continuidad_autorizada');

                if (isEscalado) {
                    motivos.push({
                        tipo: 'seguimiento',
                        subtipo: 'cinco_intentos',
                        descripcion: 'Cinco intentos válidos de contacto sin respuesta',
                        limite: 'Máximo 5 intentos sin respuesta',
                        esperado: '<= 4 intentos',
                        observado: `${intentos} intentos`,
                        fecha: cad.fecha_escalacion || (p.seguimiento.ultimo_contacto && p.seguimiento.ultimo_contacto.fecha) || null
                    });
                    isPending = true;
                    alertState = 'pendiente';
                    fechaDeteccion = cad.fecha_escalacion || fechaDeteccion;
                    limiteIncumplido = 'Máximo 5 intentos de contacto sin respuesta';
                    valorEsperado = '<= 4';
                    valorObservado = `${intentos}`;
                    counts.cinco_intentos++;
                    counts.seguimiento = (counts.seguimiento || 0) + 1;
                } else if (cad.estado_cadencia === 'continuidad_autorizada') {
                    alertState = 'continuidad_autorizada';
                } else if (cad.estado_cadencia === 'orden_cierre_pendiente') {
                    alertState = 'orden_cierre_pendiente';
                }
            }

            // Criterio A: Límite comercial de Venta sin contrato pendiente de autorización
            if (pendingReq && p.estado === 'activo') {
                motivos.push({
                    tipo: 'solicitud_sin_contrato',
                    subtipo: 'solicitud_sin_contrato',
                    descripcion: `Solicitud de venta sin contrato pendiente (${pendingReq.solicitante_nombre || 'Comercial'})`,
                    limite: 'Instalación > $10,000 requiere contrato',
                    esperado: 'Aprobación gerencial requerida',
                    observado: pendingReq.motivo || 'Pendiente de resolución',
                    fecha: pendingReq.fecha_solicitud || null,
                    requestId: pendingReq.id
                });
                isPending = true;
                if (alertState !== 'pendiente') alertState = 'pendiente';
                if (!fechaDeteccion) fechaDeteccion = pendingReq.fecha_solicitud;
                if (!limiteIncumplido) limiteIncumplido = 'Venta sin contrato pendiente de autorización';
                counts.solicitud_sin_contrato++;
            }

            // Alertas en historial / resueltas
            if (!isPending) {
                const hasResolvedEscalation = cad && (cad.estado_cadencia === 'continuidad_autorizada' || cad.estado_cadencia === 'orden_cierre_pendiente' || (Array.isArray(cad.historial_escalaciones) && cad.historial_escalaciones.length > 0));
                const hasResolvedReq = solicitudes.some(r => r && (r.estado === 'aprobada' || r.estado === 'rechazada'));
                if (hasResolvedEscalation || hasResolvedReq) {
                    if (alertState === 'al_dia') alertState = 'resuelta';
                    counts.resueltas++;
                }
            }

            // Si no tiene alertas activas ni historial de alertas resueltas, no pertenece a este panel
            if (motivos.length === 0 && alertState === 'al_dia') {
                return;
            }

            const responsableNombre = resolveSellerName(p, userDirectory);
            const responsableId = p.vendedorId || p.createdBy || '';

            // Cada oportunidad cuenta una sola vez en el total de pendientes
            if (isPending) {
                counts.totalPending++;
            }

            // Aplicación de filtros de consulta
            if (statusFilter && statusFilter !== 'todas') {
                if (statusFilter === 'pendientes' && !isPending) return;
                if ((statusFilter === 'continuidad_autorizada' || statusFilter === 'autorizadas') && alertState !== 'continuidad_autorizada') return;
                if (statusFilter === 'orden_cierre' && alertState !== 'orden_cierre_pendiente') return;
                if (statusFilter === 'resueltas' && (isPending || alertState === 'al_dia')) return;
            }

            if (filterResponsable && filterResponsable !== 'todos' && filterResponsable !== 'all') {
                if (responsableId !== filterResponsable && responsableNombre !== filterResponsable) return;
            }

            if (filterMotivo && filterMotivo !== 'todos' && filterMotivo !== 'all') {
                const matches = motivos.some(m => {
                    if (m.tipo === filterMotivo || m.subtipo === filterMotivo) return true;
                    if (filterMotivo === 'seguimiento' && (m.tipo === 'cinco_intentos' || m.tipo === 'seguimiento' || m.subtipo === 'cinco_intentos' || m.tipo === 'cadencia_5_intentos')) return true;
                    if ((filterMotivo === 'cadencia_5_intentos' || filterMotivo === 'cinco_intentos') && (m.tipo === 'cinco_intentos' || m.tipo === 'seguimiento' || m.subtipo === 'cinco_intentos')) return true;
                    if ((filterMotivo === 'solicitud_sin_contrato' || filterMotivo === 'sin_contrato') && m.tipo === 'solicitud_sin_contrato') return true;
                    return false;
                });
                if (!matches) return;
            }

            items.push({
                prospect: p,
                id: p.id,
                codigo: p.codigo || (p.id ? String(p.id).slice(-4) : '-'),
                proyecto: p.proyecto || 'Sin Nombre',
                clientId: p.clientId,
                responsableId,
                responsableNombre,
                responsable: responsableNombre,
                etapa: p.etapa || 'prospecto',
                monto: Number(p.precio_cotizado) || 0,
                estado: p.estado || 'activo',
                motivos: motivos.map(m => m.descripcion),
                motivoObjects: motivos,
                motivoPrincipal: motivos[0] ? motivos[0].descripcion : (alertState === 'continuidad_autorizada' ? 'Continuidad autorizada' : 'Alerta resuelta'),
                isPending,
                alertState,
                alerta_estado: alertState,
                fechaDeteccion: fechaDeteccion || (p.fecha_creacion ? String(p.fecha_creacion).slice(0, 10) : '-'),
                limiteIncumplido: limiteIncumplido || '-',
                valorEsperado: valorEsperado || '-',
                valorObservado: valorObservado || '-',
                intentosFallidos: cad ? (Number(cad.intentos_fallidos || cad.intentos_validos_sin_respuesta) || 0) : 0,
                intentosValidos: cad ? (Number(cad.intentos_fallidos || cad.intentos_validos_sin_respuesta) || 0) : 0,
                historialGestiones: (p.seguimiento && Array.isArray(p.seguimiento.historial_gestiones)) ? p.seguimiento.historial_gestiones : [],
                justificacionesAnteriores: cad ? (cad.justificacion_continuidad || null) : null,
                justificacionVendedor: cad ? (cad.justificacion_continuidad || null) : null,
                hasFollowUpEscalation: motivos.some(m => m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos'),
                hasNoContractRequest: !!pendingReq || motivos.some(m => m.tipo === 'solicitud_sin_contrato'),
                cadencia: cad,
                solicitudesSinContrato: solicitudes
            });
        });

        // Ordenamiento: primero pendientes con mayor número de intentos fallidos
        items.sort((a, b) => {
            if (a.isPending !== b.isPending) return a.isPending ? -1 : 1;
            return (b.intentosFallidos - a.intentosFallidos);
        });

        return {
            items,
            pendingItems: items.filter(x => x.isPending),
            totalPending: counts.totalPending,
            pendingUniqueCount: counts.totalPending,
            counts: {
                ...counts,
                pendientes: counts.totalPending,
                total: items.length
            }
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
        resolveSellerName,
        generateAgenda,
        calculateManagerAttentionItems,
        CADENCIAS_VALIDAS,
        LIMITES_COMERCIALES_CADENCIA,
        getCadenceConfig,
        validateCadenceSelection
    };
});
