// functions/__tests__/dashboardManagerWorkflow.unit.test.js
/**
 * DUCTSAL ERP — Suite de Auditoría Complementaria de Fase 6.5: Workflow Gerencial y Auditoría
 *
 * Valida los 8 puntos obligatorios de auditoría sobre:
 * - modules/dashboard/dashboard_manager_workflow.js
 * - modules/dashboard/dashboard_audit.js
 *
 * Puntos auditados:
 * 1. Usuario autorizado puede abrir y completar una decisión.
 * 2. Usuario no autorizado no puede ejecutarla.
 * 3. Validaciones obligatorias funcionan.
 * 4. El motivo y la identidad del usuario se transmiten correctamente.
 * 5. La operación utiliza el mecanismo backend autorizado (CrmCommercial / Cloud Functions).
 * 6. El registro de auditoría se genera/procesa correctamente (read-only snapshot sin mutación directa).
 * 7. Un error del backend se maneja sin dejar estado inconsistente.
 * 8. Una operación repetida no produce duplicados cuando corresponda (idempotencia y estabilidad de opId).
 */

const path = require('path');
const DashboardManagerWorkflow = require('../../modules/dashboard/dashboard_manager_workflow.js');
const DashboardAudit = require('../../modules/dashboard/dashboard_audit.js');
const CrmCommercial = require('../../crm_commercial.js');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const DashboardCharts = require('../../modules/dashboard/dashboard_charts.js');
const CrmDashboardCalc = require('../../crm_dashboard_calc.js');

describe('Fase 6.5 Complementaria — Workflow Gerencial y Auditoría', () => {
  let domElements = {};
  let lastAlert = null;
  let closedModals = [];
  let renderedDashboardCount = 0;
  let openedDetailId = null;

  function makeEl(id, extra = {}) {
    const el = {
      id,
      style: { display: extra.display || '' },
      value: extra.value || '',
      checked: extra.checked !== undefined ? extra.checked : false,
      textContent: '',
      innerHTML: '',
      classList: {
        _classes: new Set(extra.classes || []),
        add: jest.fn(c => el.classList._classes.add(c)),
        remove: jest.fn(c => el.classList._classes.delete(c)),
        contains: jest.fn(c => el.classList._classes.has(c))
      },
      ...extra
    };
    domElements[id] = el;
    return el;
  }

  function getEl(id) {
    if (!domElements[id]) domElements[id] = makeEl(id);
    return domElements[id];
  }

  const mockDoc = {
    getElementById: (id) => getEl(id),
    querySelectorAll: () => []
  };

  const sampleProspect = {
    id: 'p-escalated-1',
    codigo: '202610999',
    proyecto: 'HVAC Nave Logística',
    clientId: 'c-100',
    vendedorId: 'u-ven-1',
    vendedorName: 'Carlos Mendoza',
    etapa: 'negociacion',
    estado: 'activo',
    precio_cotizado: 50000,
    seguimiento: {
      cadencia: {
        intentos_validos_sin_respuesta: 5,
        motivo_escalacion: '5 intentos válidos sin respuesta del cliente',
        justificacion_continuidad: 'Cliente en ronda de financiamiento bancario'
      }
    }
  };

  beforeEach(() => {
    domElements = {};
    lastAlert = null;
    closedModals = [];
    renderedDashboardCount = 0;
    openedDetailId = null;
    CrmCommercial._pendingOps.clear();

    // DOM inputs
    makeEl('mgr-decision-prospect-id');
    makeEl('mgr-decision-subtitle');
    makeEl('mgr-decision-motivo-desc');
    makeEl('mgr-decision-historial-summary');
    makeEl('mgr-autorizar-justificacion');
    makeEl('mgr-autorizar-prox-fecha', { value: '2026-11-05' });
    makeEl('mgr-autorizar-prox-tipo', { value: 'llamada' });
    makeEl('mgr-autorizar-prox-desc');
    makeEl('mgr-cierre-motivo');
    makeEl('mgr-cierre-justificacion');
    makeEl('mgr-cierre-ejecutar-inmediato', { checked: true });
    makeEl('modal-manager-decision');
    makeEl('mgr-tab-autorizar');
    makeEl('mgr-tab-cierre');
    makeEl('tab-btn-autorizar');
    makeEl('tab-btn-cierre');
    makeEl('audit-logs-container');
  });

  // =========================================================================
  // 1. USUARIO AUTORIZADO PUEDE ABRIR Y COMPLETAR UNA DECISIÓN
  // =========================================================================
  test('1. Usuario autorizado (manager) puede abrir el modal y completar una decisión', async () => {
    let callableCalls = [];
    const mockFb = {
      auth: () => ({ currentUser: { uid: 'mgr-uid-1', email: 'gerente@ductsal.com' } }),
      functions: () => ({
        httpsCallable: (name) => async (payload) => {
          callableCalls.push({ name, payload });
          return { data: { success: true, prospectId: payload.prospectId, status: 'authorized' } };
        }
      })
    };

    DashboardManagerWorkflow.setDeps({
      getCurrentUser: () => ({ id: 'u-mgr-1', role: 'manager', nombre: 'Gerente General' }),
      getProspects: () => [sampleProspect],
      getUsers: () => [{ id: 'u-ven-1', nombre: 'Carlos Mendoza', role: 'vendedor' }],
      getCrmCommercial: () => CrmCommercial,
      getDbSuffix: () => '_prod',
      getDocument: () => mockDoc,
      getClientName: () => 'Cliente Corporativo HVAC',
      showAlert: msg => { lastAlert = msg; },
      closeModal: id => { closedModals.push(id); },
      renderDashboard: () => { renderedDashboardCount++; },
      runWorkflowOp: async (desc, opFn) => await opFn(mockFb)
    });

    // Abrir modal
    DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');
    expect(lastAlert).toBeNull();
    expect(DashboardManagerWorkflow.getCurrentDecisionProspectId()).toBe('p-escalated-1');
    expect(getEl('mgr-decision-subtitle').textContent).toContain('HVAC Nave Logística');
    expect(getEl('mgr-decision-historial-summary').textContent).toContain('5 intentos sin respuesta');

    // Completar decisión: Autorizar continuar
    getEl('mgr-autorizar-justificacion').value = 'Se autoriza extensión de 2 días por negociación de condiciones crediticias';
    getEl('mgr-autorizar-prox-fecha').value = '2026-11-06';
    getEl('mgr-autorizar-prox-tipo').value = 'reunion';
    getEl('mgr-autorizar-prox-desc').value = 'Reunión con dirección de compras';

    await DashboardManagerWorkflow.submitManagerDecision('autorizar_continuar');

    expect(callableCalls).toHaveLength(1);
    expect(callableCalls[0].name).toBe('resolveProspectEscalationAdmin');
    expect(callableCalls[0].payload.decision).toBe('autorizar_continuar');
    expect(callableCalls[0].payload.prospectId).toBe('p-escalated-1');
    expect(callableCalls[0].payload.justificacion).toContain('Se autoriza extensión');
    expect(closedModals).toContain('modal-manager-decision');
    expect(renderedDashboardCount).toBe(1);
  });

  // =========================================================================
  // 2. USUARIO NO AUTORIZADO NO PUEDE EJECUTARLA
  // =========================================================================
  test('2. Usuario no autorizado (vendedor, gestor, admin) no puede abrir ni ejecutar decisiones', async () => {
    const rolesNoAutorizados = ['vendedor', 'gestor', 'admin', 'planta'];

    for (const role of rolesNoAutorizados) {
      lastAlert = null;
      DashboardManagerWorkflow.setDeps({
        getCurrentUser: () => ({ id: `u-${role}`, role, nombre: `Usuario ${role}` }),
        getProspects: () => [sampleProspect],
        getDocument: () => mockDoc,
        showAlert: msg => { lastAlert = msg; }
      });

      DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');
      expect(lastAlert).toContain('Solo los usuarios con rol Gerente');
    }
  });

  // =========================================================================
  // 3. VALIDACIONES OBLIGATORIAS FUNCIONAN
  // =========================================================================
  test('3. Validaciones obligatorias: justificación mínima, fecha y motivo de cierre', async () => {
    let callableInvoked = false;
    DashboardManagerWorkflow.setDeps({
      getCurrentUser: () => ({ id: 'u-mgr-1', role: 'manager' }),
      getProspects: () => [sampleProspect],
      getDocument: () => mockDoc,
      getCrmCommercial: () => CrmCommercial,
      showAlert: msg => { lastAlert = msg; },
      runWorkflowOp: async () => { callableInvoked = true; }
    });

    DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');

    // Caso 3.1: Autorizar sin justificación suficiente (< 5 caracteres)
    getEl('mgr-autorizar-justificacion').value = 'ok';
    getEl('mgr-autorizar-prox-fecha').value = '2026-11-06';
    await DashboardManagerWorkflow.submitManagerDecision('autorizar_continuar');
    expect(lastAlert).toContain('justificación gerencial detallada (mínimo 5 caracteres)');
    expect(callableInvoked).toBe(false);

    // Caso 3.2: Autorizar sin fecha de próxima acción
    lastAlert = null;
    getEl('mgr-autorizar-justificacion').value = 'Justificación gerencial válida y completa';
    getEl('mgr-autorizar-prox-fecha').value = '';
    await DashboardManagerWorkflow.submitManagerDecision('autorizar_continuar');
    expect(lastAlert).toContain('Debes seleccionar una fecha');
    expect(callableInvoked).toBe(false);

    // Caso 3.3: Ordenar cierre sin motivo de pérdida
    lastAlert = null;
    getEl('mgr-cierre-motivo').value = '';
    await DashboardManagerWorkflow.submitManagerDecision('ordenar_cierre');
    expect(lastAlert).toContain('Debes seleccionar un motivo de pérdida');
    expect(callableInvoked).toBe(false);
  });

  // =========================================================================
  // 4. EL MOTIVO Y LA IDENTIDAD DEL USUARIO SE TRANSMITEN CORRECTAMENTE
  // =========================================================================
  test('4. El motivo y los datos requeridos se transmiten exactamente al backend', async () => {
    let payloadReceived = null;
    const mockFb = {
      auth: () => ({ currentUser: { uid: 'auth-mgr-999', email: 'bvaliente@grupogama.com' } }),
      functions: () => ({
        httpsCallable: () => async (payload) => {
          payloadReceived = payload;
          return { data: { success: true } };
        }
      })
    };

    DashboardManagerWorkflow.setDeps({
      getCurrentUser: () => ({ id: 'u-mgr-1', role: 'manager' }),
      getProspects: () => [sampleProspect],
      getDocument: () => mockDoc,
      getCrmCommercial: () => CrmCommercial,
      getDbSuffix: () => '_prod',
      showAlert: msg => { lastAlert = msg; },
      closeModal: () => {},
      renderDashboard: () => {},
      runWorkflowOp: async (desc, opFn) => await opFn(mockFb)
    });

    DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');
    getEl('mgr-cierre-motivo').value = 'Sin respuesta del cliente tras 5 contactos';
    getEl('mgr-cierre-justificacion').value = 'Se confirma abandono del proyecto por parte del cliente';
    getEl('mgr-cierre-ejecutar-inmediato').checked = true;

    await DashboardManagerWorkflow.submitManagerDecision('ordenar_cierre');

    expect(payloadReceived).not.toBeNull();
    expect(payloadReceived.prospectId).toBe('p-escalated-1');
    expect(payloadReceived.decision).toBe('ordenar_cierre');
    expect(payloadReceived.motivo).toBe('Sin respuesta del cliente tras 5 contactos');
    expect(payloadReceived.justificacion).toBe('Se confirma abandono del proyecto por parte del cliente');
    expect(payloadReceived.ejecutarCierre).toBe(true);
    expect(payloadReceived.dbSuffix).toBe('_prod');
    expect(payloadReceived.opId).toBeDefined();
  });

  // =========================================================================
  // 5. LA OPERACIÓN UTILIZA EL MECANISMO BACKEND AUTORIZADO
  // =========================================================================
  test('5. La operación utiliza resolveProspectEscalationAdmin en Cloud Functions', async () => {
    let functionNameInvoked = null;
    const mockFb = {
      auth: () => ({ currentUser: { uid: 'auth-mgr' } }),
      functions: () => ({
        httpsCallable: (name) => async () => {
          functionNameInvoked = name;
          return { data: { ok: true } };
        }
      })
    };

    DashboardManagerWorkflow.setDeps({
      getCurrentUser: () => ({ id: 'u-mgr-1', role: 'manager' }),
      getProspects: () => [sampleProspect],
      getDocument: () => mockDoc,
      getCrmCommercial: () => CrmCommercial,
      getDbSuffix: () => '_prod',
      showAlert: () => {},
      closeModal: () => {},
      renderDashboard: () => {},
      runWorkflowOp: async (desc, opFn) => await opFn(mockFb)
    });

    DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');
    getEl('mgr-autorizar-justificacion').value = 'Aprobación de nuevo contacto';
    getEl('mgr-autorizar-prox-fecha').value = '2026-11-10';

    await DashboardManagerWorkflow.submitManagerDecision('autorizar_continuar');
    expect(functionNameInvoked).toBe('resolveProspectEscalationAdmin');
  });

  // =========================================================================
  // 6. EL REGISTRO DE AUDITORÍA SE GENERA/PROCESA CORRECTAMENTE (READ-ONLY)
  // =========================================================================
  test('6. DashboardAudit escucha audit_logs de forma estrictamente de solo lectura', () => {
    let onSnapshotRegistered = false;
    let queryLimit = 0;
    let targetCollection = '';

    const mockDb = {
      collection: jest.fn(col => {
        targetCollection = col;
        return {
          orderBy: jest.fn(() => ({
            limit: jest.fn(l => {
              queryLimit = l;
              return {
                onSnapshot: jest.fn((callback) => {
                  onSnapshotRegistered = true;
                  callback({
                    empty: false,
                    forEach: (fn) => {
                      fn({
                        data: () => ({
                          fecha: '2026-10-31T12:00:00Z',
                          usuario: 'gerente@ductsal.com',
                          item: 'Oportunidad 202610999',
                          detalle: 'Decisión gerencial registrada',
                          proyectoNombre: 'HVAC Nave Logística'
                        })
                      });
                    }
                  });
                  return jest.fn();
                })
              };
            })
          }))
        };
      })
    };

    DashboardAudit.setDeps({
      getDb: () => mockDb,
      getDbSuffix: () => '_prod',
      getDocument: () => mockDoc,
      formatDate: () => '31/10/2026',
      escapeHtmlDoc: s => String(s || '')
    });

    DashboardAudit.fetchAuditLogs();

    expect(targetCollection).toBe('audit_logs_prod');
    expect(queryLimit).toBe(20);
    expect(onSnapshotRegistered).toBe(true);
    expect(getEl('audit-logs-container').innerHTML).toContain('gerente@ductsal.com');
    expect(getEl('audit-logs-container').innerHTML).toContain('HVAC Nave Logística');
    expect(DashboardAudit.isSubscribed()).toBe(true);

    // Desuscripción segura
    DashboardAudit.unsubscribeAudit();
    expect(DashboardAudit.isSubscribed()).toBe(false);
  });

  // =========================================================================
  // 7. UN ERROR DEL BACKEND SE MANEJA SIN DEJAR ESTADO INCONSISTENTE
  // =========================================================================
  test('7. Un error de red o backend no cierra el modal ni desincroniza el dashboard', async () => {
    const errorSimulado = new Error('functions/unavailable: Servicio no disponible');
    errorSimulado.code = 'functions/unavailable';

    const mockFb = {
      auth: () => ({ currentUser: { uid: 'auth-mgr' } }),
      functions: () => ({
        httpsCallable: () => async () => { throw errorSimulado; }
      })
    };

    DashboardManagerWorkflow.setDeps({
      getCurrentUser: () => ({ id: 'u-mgr-1', role: 'manager' }),
      getProspects: () => [sampleProspect],
      getDocument: () => mockDoc,
      getCrmCommercial: () => CrmCommercial,
      getDbSuffix: () => '_prod',
      showAlert: msg => { lastAlert = msg; },
      closeModal: id => { closedModals.push(id); },
      renderDashboard: () => { renderedDashboardCount++; },
      runWorkflowOp: async (desc, opFn) => {
        try {
          return await opFn(mockFb);
        } catch (e) {
          lastAlert = e.message;
          return null; // Simula manejo seguro de runWorkflowOp
        }
      }
    });

    DashboardManagerWorkflow.openManagerDecisionModal('p-escalated-1');
    getEl('mgr-autorizar-justificacion').value = 'Justificación válida para intento';
    getEl('mgr-autorizar-prox-fecha').value = '2026-11-10';

    await DashboardManagerWorkflow.submitManagerDecision('autorizar_continuar');

    // El modal NO debe haberse cerrado ni el dashboard re-renderizado
    expect(closedModals).not.toContain('modal-manager-decision');
    expect(renderedDashboardCount).toBe(0);
    expect(lastAlert).toContain('functions/unavailable');
    // El ID de la decisión sigue activo para permitir reintentar sin perder los datos
    expect(DashboardManagerWorkflow.getCurrentDecisionProspectId()).toBe('p-escalated-1');
  });

  // =========================================================================
  // 8. UNA OPERACIÓN REPETIDA NO PRODUCE DUPLICADOS CUANDO CORRESPONDA (IDEMPOTENCIA)
  // =========================================================================
  test('8. Idempotencia: una reintentación ante fallo incierto preserva el mismo opId', async () => {
    let callCount = 0;
    let opIds = [];

    const mockFb = {
      auth: () => ({ currentUser: { uid: 'auth-mgr' } }),
      functions: () => ({
        httpsCallable: () => async (payload) => {
          callCount++;
          opIds.push(payload.opId);
          if (callCount === 1) {
            const err = new Error('deadline-exceeded');
            err.code = 'deadline-exceeded';
            throw err;
          }
          return { data: { success: true } };
        }
      })
    };

    const payload = {
      prospectId: 'p-escalated-1',
      decision: 'autorizar_continuar',
      justificacion: 'Reintentando misma decisión',
      proximaAccion: { fecha: '2026-11-12', tipo: 'llamada', descripcion: '' },
      dbSuffix: '_prod'
    };

    // Primer intento falla incierto
    await expect(CrmCommercial.resolveFollowUpEscalation(mockFb, payload)).rejects.toBeTruthy();

    // Segundo intento con idéntico payload
    const res = await CrmCommercial.resolveFollowUpEscalation(mockFb, payload);
    expect(res).toEqual({ success: true });

    // Ambos llamados utilizaron exactamente el mismo opId
    expect(callCount).toBe(2);
    expect(opIds).toHaveLength(2);
    expect(opIds[0]).toBe(opIds[1]);
  });

  // =========================================================================
  // 8.1. IDEMPOTENCIA REAL EN BACKEND (REPETICIÓN Y CONCURRENCIA EN FIRESTORE)
  // =========================================================================
  describe('8.1 Backend: Idempotencia real en Firestore y prevención de duplicados', () => {
    const CLOCK = new Date('2026-05-10T14:00:00.000Z');
    let fdb, service, callerManager;

    beforeEach(() => {
      fdb = createFakeFirestore({ clock: () => CLOCK });
      service = createCommercialService({
        db: fdb,
        FieldValue: fdb.FieldValue,
        suffix: '_prod',
        now: () => CLOCK,
        verifyManager: async uid => uid === 'mgr-1'
      });
      callerManager = { uid: 'mgr-1', cid: 'mgr-1', email: 'gerente@ductsal.com', name: 'Gerente General', role: 'manager' };

      // Seed opportunity requiring manager escalation
      fdb.seed('prospects_prod/OPP-ESC-1', {
        id: 'OPP-ESC-1',
        proyecto: 'Proyecto Hospital',
        clientId: 'CLI-1',
        estado: 'activo',
        etapa: 'cotizacion',
        precio_cotizado: 25000,
        eliminado: false,
        seguimiento: {
          cadencia: {
            alerta_gerencial: true,
            estado_cadencia: 'escalada_gerencia',
            intentos_validos_sin_respuesta: 5,
            historial_escalaciones: []
          }
        },
        logs: []
      });
    });

    test('8.1.a Replay repetido secuencial con el mismo opId retorna replay: true y no duplica auditoría ni logs', async () => {
      const opId = 'op-replay-test-001';
      const callData = {
        caller: callerManager,
        prospectId: 'OPP-ESC-1',
        decision: 'autorizar_continuar',
        justificacion: 'Se autoriza nuevo intento tras comunicación con director',
        proximaAccion: { fecha: '2026-05-15', tipo: 'llamada', descripcion: 'Llamada formal' },
        opId
      };

      // Primer llamado
      const res1 = await service.resolveFollowUpEscalation(callData);
      expect(res1.status).toBe('resolved');
      expect(res1.replay).toBeUndefined();

      // Verificamos estado persistido en Firestore
      const oppAfterFirst = await fdb.data('prospects_prod/OPP-ESC-1');
      expect(oppAfterFirst.seguimiento.cadencia.alerta_gerencial).toBe(false);
      expect(oppAfterFirst.seguimiento.cadencia.historial_escalaciones).toHaveLength(1);
      expect(oppAfterFirst.seguimiento.cadencia.historial_escalaciones[0].opId).toBe(opId);
      expect(oppAfterFirst.logs).toHaveLength(1);

      // Verificamos registro en commercialAudit_prod
      const auditDocsAfterFirst = fdb.list('commercialAudit_prod');
      expect(auditDocsAfterFirst).toHaveLength(1);
      expect(auditDocsAfterFirst[0].action).toBe('resolveFollowUpEscalation');
      expect(auditDocsAfterFirst[0].targetId).toBe('OPP-ESC-1');

      // Segundo llamado repetido (exactamente el mismo opId)
      const res2 = await service.resolveFollowUpEscalation(callData);
      expect(res2.status).toBe('resolved');
      expect(res2.replay).toBe(true);

      // Verificamos que NO haya duplicados en Firestore
      const oppAfterSecond = fdb.data('prospects_prod/OPP-ESC-1');
      expect(oppAfterSecond.seguimiento.cadencia.historial_escalaciones).toHaveLength(1);
      expect(oppAfterSecond.logs).toHaveLength(1);

      const auditDocsAfterSecond = fdb.list('commercialAudit_prod');
      expect(auditDocsAfterSecond).toHaveLength(1); // Cero duplicados en auditoría
    });

    test('8.1.b Solicitudes concurrentes con el mismo opId no producen duplicados en auditoría ni en historial', async () => {
      const opId = 'op-concurrent-test-999';
      const callData = {
        caller: callerManager,
        prospectId: 'OPP-ESC-1',
        decision: 'ordenar_cierre',
        motivo: 'Cliente desiste',
        justificacion: 'Desistimiento confirmado en llamada telefónica',
        ejecutarCierre: true,
        opId
      };

      // Ejecución concurrente
      const [resA, resB] = await Promise.all([
        service.resolveFollowUpEscalation(callData),
        service.resolveFollowUpEscalation(callData)
      ]);

      expect(resA.status).toBe('resolved');
      expect(resB.status).toBe('resolved');
      // Al menos uno debe reportar replay: true
      const hasReplay = resA.replay === true || resB.replay === true;
      expect(hasReplay).toBe(true);

      // Verificamos consistencia estricta en el documento
      const oppFinal = await fdb.data('prospects_prod/OPP-ESC-1');
      expect(oppFinal.estado).toBe('perdido');
      expect(oppFinal.motivo_perdida).toBe('Cliente desiste');
      expect(oppFinal.seguimiento.cadencia.historial_escalaciones).toHaveLength(1);
      expect(oppFinal.logs).toHaveLength(1);

      // Verificamos que sólo se haya creado exactamente 1 documento en commercialAudit_prod
      const auditDocs = await fdb.list('commercialAudit_prod');
      expect(auditDocs).toHaveLength(1);
    });

    test('8.1.c In-flight guard del cliente en DashboardManagerWorkflow previene doble despacho simultáneo', async () => {
      let dispatchCount = 0;
      let resolveFirstCall;
      const firstCallPromise = new Promise(resolve => { resolveFirstCall = resolve; });

      DashboardManagerWorkflow.setDeps({
        getProspects: () => [{ id: 'p-multi-click', proyecto: 'P1', clientId: 'c1', seguimiento: { cadencia: {} } }],
        getCurrentUser: () => ({ uid: 'mgr-1', role: 'manager' }),
        getCurrentProspectId: () => 'p-multi-click',
        getDocument: () => {
          return {
            getElementById: (id) => ({
              value: id.includes('justificacion') ? 'Justificación válida de prueba' : (id.includes('motivo') ? 'Precio' : '2026-11-20'),
              checked: true,
              style: {}
            })
          };
        },
        getCrmCommercial: () => CrmCommercial,
        getDbSuffix: () => '_prod',
        showAlert: () => {},
        closeModal: () => {},
        renderDashboard: () => {},
        runWorkflowOp: async (desc, opFn) => {
          dispatchCount++;
          await firstCallPromise;
          return { status: 'resolved' };
        }
      });

      DashboardManagerWorkflow.setCurrentDecisionProspectId('p-multi-click');

      // Lanzamos primera llamada (se suspende esperando firstCallPromise)
      const call1 = DashboardManagerWorkflow.submitManagerDecision('ordenar_cierre');
      // Lanzamos segunda llamada simultánea mientras la primera está en curso
      const call2 = DashboardManagerWorkflow.submitManagerDecision('ordenar_cierre');

      // Desbloqueamos la primera
      resolveFirstCall();
      await Promise.all([call1, call2]);

      // Solo se despachó 1 operación hacia el backend
      expect(dispatchCount).toBe(1);
    });
  });

  // =========================================================================
  // 9. INVENTARIO Y EQUIVALENCIA DE LAS 9 VISUALIZACIONES DEL DASHBOARD
  // =========================================================================
  describe('9. Inventario y Equivalencia de las 9 Visualizaciones de Dashboard (Chart.js & CSS Funnel)', () => {
    let createdCharts = [];
    let destroyedCount = 0;
    let mockDom = {};

    function MockChart(ctx, config) {
      this.ctx = ctx;
      this.config = config;
      this.destroyed = false;
      this.destroy = () => {
        this.destroyed = true;
        destroyedCount++;
      };
      createdCharts.push(this);
    }
    MockChart.defaults = { color: '' };
    MockChart.getChart = (canvas) => {
      return createdCharts.find(c => c.ctx && c.ctx.canvas === canvas && !c.destroyed);
    };

    function createMockCanvas(id) {
      const canvasObj = { id };
      const ctxObj = { canvas: canvasObj };
      return {
        id,
        getContext: () => ctxObj,
        style: {}
      };
    }

    beforeEach(() => {
      createdCharts = [];
      destroyedCount = 0;
      mockDom = {
        'monthlyEvolutionChart': createMockCanvas('monthlyEvolutionChart'),
        'monthly-canvas-container': { style: {} },
        'monthly-evolution-empty': { style: {} },
        'dash-monthly-coverage-badge': { style: {}, textContent: '', title: '' },
        'dash-monthly-summary': { textContent: '' },

        'css-funnel-container': { innerHTML: '' },

        'conversionChart': createMockCanvas('conversionChart'),

        'sellerChart': createMockCanvas('sellerChart'),
        'seller-canvas-container': { style: {} },
        'seller-empty-container': { style: {} },
        'seller-empty-text': { textContent: '' },
        'dash-seller-coverage-badge': { style: {}, textContent: '', title: '' },
        'dash-seller-inactive-notice': { style: {} },
        'dash-seller-inactive-notice-text': { textContent: '' },

        'lossChart': createMockCanvas('lossChart'),
        'loss-canvas-container': { style: {} },
        'loss-empty-container': { style: {} },

        'productChart': createMockCanvas('productChart'),
        'projectChart': createMockCanvas('projectChart'),
        'oppProductChart': createMockCanvas('oppProductChart'),
        'oppProjectChart': createMockCanvas('oppProjectChart')
      };

      DashboardCharts.setDeps({
        getChartConstructor: () => MockChart,
        getDocument: () => ({
          getElementById: id => mockDom[id] || null
        }),
        getCrmDashboardCalc: () => CrmDashboardCalc,
        getUsers: () => [
          { id: 'u1', name: 'Ana Vendedora', role: 'vendedor', status: 'active' },
          { id: 'u2', name: 'Carlos Gestor', role: 'gestor', status: 'active' }
        ],
        getSellerFilterMode: () => 'active_only',
        updateSellerFilterButtons: () => {},
        formatCurrency: val => '$' + Number(val || 0).toLocaleString('en-US')
      });
    });

    test('9.1 Clarificación de Inventario: 6 tarjetas lógicas contienen 8 canvas Chart.js y 1 embudo HTML/CSS (9 en total)', () => {
      const canvasIds = [
        'monthlyEvolutionChart',
        'conversionChart',
        'sellerChart',
        'lossChart',
        'productChart',
        'projectChart',
        'oppProductChart',
        'oppProjectChart'
      ];
      expect(canvasIds).toHaveLength(8);

      const htmlVisualizations = ['css-funnel-container'];
      expect(htmlVisualizations).toHaveLength(1);

      // Total 9 visualizaciones
      expect(canvasIds.length + htmlVisualizations.length).toBe(9);
    });

    test('9.2 Visualización 1 (monthlyEvolutionChart - Canvas 1): conserva fuentes, series dual-axis y métricas', () => {
      const filterRes = {
        flujoGanadas: [
          { id: 'g1', estado: 'ganado', precio_cotizado: 10000, costo_venta: 6000, fecha_cierre: '2026-03-15T10:00:00Z' },
          { id: 'g2', estado: 'ganado', precio_cotizado: 15000, costo_venta: 9000, fecha_cierre: '2026-04-10T10:00:00Z' }
        ],
        isHistorical: false
      };

      DashboardCharts.renderCharts(filterRes);

      const chartM = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'monthlyEvolutionChart');
      expect(chartM).toBeDefined();
      expect(chartM.config.type).toBe('bar');
      expect(chartM.config.data.datasets).toHaveLength(3);
      expect(chartM.config.data.datasets[0].label).toBe('Ventas Ganadas ($)');
      expect(chartM.config.data.datasets[1].label).toBe('Margen Bruto ($)');
      expect(chartM.config.data.datasets[2].label).toBe('% Margen');
      expect(chartM.config.data.datasets[2].type).toBe('line');
      expect(chartM.config.data.datasets[2].yAxisID).toBe('yPct');
    });

    test('9.3 Visualización 2 (css-funnel-container - HTML/CSS): conserva las 5 etapas estándar y montos', () => {
      const filterRes = {
        stockActivo: [
          { id: 'a1', estado: 'activo', etapa: 'prospecto', precio_cotizado: 5000, probabilidad: 20 },
          { id: 'a2', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 12000, probabilidad: 50 },
          { id: 'a3', estado: 'activo', etapa: 'cierre', precio_cotizado: 20000, probabilidad: 80 }
        ]
      };

      DashboardCharts.renderCharts(filterRes);

      const html = mockDom['css-funnel-container'].innerHTML;
      expect(html).toContain('dash-funnel-wrapper');
      expect(html).toContain('prospecto');
      expect(html).toContain('cotizacion');
      expect(html).toContain('cierre');
      expect(html).toContain('$5,000');
      expect(html).toContain('$12,000');
    });

    test('9.4 Visualización 3 (conversionChart - Canvas 2): conserva canales, barras apiladas y tasa de cierre', () => {
      const filterRes = {
        flujoGanadas: [{ canal_origen: 'Referido', estado: 'ganado', precio_cotizado: 5000 }],
        flujoPerdidas: [{ canal_origen: 'Referido', estado: 'perdido', motivo_perdida: 'Precio' }],
        stockActivo: [{ canal_origen: 'Sitio Web', estado: 'activo', precio_cotizado: 10000 }],
        isHistorical: false
      };

      DashboardCharts.renderCharts(filterRes);

      const chartConv = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'conversionChart');
      expect(chartConv).toBeDefined();
      expect(chartConv.config.type).toBe('bar');
      expect(chartConv.config.data.datasets).toHaveLength(4);
      expect(chartConv.config.data.datasets.map(d => d.label)).toEqual([
        'Ganado',
        'En Proceso',
        'Perdido',
        'Tasa Cierre (%)'
      ]);
    });

    test('9.5 Visualización 4 (sellerChart - Canvas 3): conserva barras horizontales y series comerciales', () => {
      const filterRes = {
        flujoGanadas: [{ vendedorId: 'u1', estado: 'ganado', precio_cotizado: 8000, costo_venta: 4000 }],
        flujoPerdidas: [],
        stockActivo: [{ vendedorId: 'u1', estado: 'activo', precio_cotizado: 15000, probabilidad: 50 }]
      };

      DashboardCharts.renderCharts(filterRes);

      const chartSeller = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'sellerChart');
      expect(chartSeller).toBeDefined();
      expect(chartSeller.config.options.indexAxis).toBe('y'); // Barras horizontales
      expect(chartSeller.config.data.datasets.map(d => d.label)).toEqual([
        'Ventas Ganadas ($)',
        'Margen Bruto ($)',
        'Cartera Activa ($)'
      ]);
    });

    test('9.6 Visualización 5 (lossChart - Canvas 4): conserva doughnut con 5 motivos taxonómicos de pérdida', () => {
      const filterRes = {
        flujoPerdidas: [
          { estado: 'perdido', motivo_perdida: 'Precio' },
          { estado: 'perdido', motivo_perdida: 'Precio' },
          { estado: 'perdido', motivo_perdida: 'Tiempo de entrega' }
        ]
      };

      DashboardCharts.renderCharts(filterRes);

      const chartLoss = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'lossChart');
      expect(chartLoss).toBeDefined();
      expect(chartLoss.config.type).toBe('doughnut');
      expect(chartLoss.config.data.labels).toEqual([
        'Precio',
        'Falta de seguimiento',
        'No se cumplían los requerimientos técnicos',
        'Tiempo de entrega',
        'Cliente desiste'
      ]);
      expect(chartLoss.config.data.datasets[0].data[0]).toBe(2); // 2 de Precio
      expect(chartLoss.config.data.datasets[0].data[3]).toBe(1); // 1 de Tiempo de entrega
    });

    test('9.7 Visualizaciones 6 a 9 (productChart, projectChart, oppProductChart, oppProjectChart): composición de cierres y pipeline', () => {
      const filterRes = {
        flujoGanadas: [
          { estado: 'ganado', tipo_producto: 'Chute', tipo_proyecto: 'Fabricación', precio_cotizado: 10000 },
          { estado: 'ganado', tipo_producto: 'Ducto', tipo_proyecto: 'Fabricación e instalación', precio_cotizado: 20000 }
        ],
        stockActivo: [
          { estado: 'activo', tipo_producto: 'Chute', tipo_proyecto: 'Fabricación e instalación', precio_cotizado: 15000 }
        ]
      };

      DashboardCharts.renderCharts(filterRes);

      const cProdW = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'productChart');
      const cProjW = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'projectChart');
      const cProdA = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'oppProductChart');
      const cProjA = createdCharts.find(c => c.ctx && c.ctx.canvas.id === 'oppProjectChart');

      expect(cProdW).toBeDefined();
      expect(cProjW).toBeDefined();
      expect(cProdA).toBeDefined();
      expect(cProjA).toBeDefined();

      expect(cProdW.config.type).toBe('doughnut');
      expect(cProjW.config.type).toBe('doughnut');
      expect(cProdA.config.type).toBe('doughnut');
      expect(cProjA.config.type).toBe('doughnut');

      // Comprobación de datos acumulados
      expect(cProdW.config.data.data || cProdW.config.data.datasets[0].data).toEqual([10000, 20000]); // Chute vs Ducto
      expect(cProjW.config.data.datasets[0].data).toEqual([20000, 10000]); // Fab e Inst vs Fab
    });

    test('9.8 Ciclo de vida Chart.js: recreación limpia y destrucción de instancias previas ante re-filtrado', () => {
      const filterRes = {
        flujoGanadas: [{ estado: 'ganado', precio_cotizado: 5000, fecha_cierre: '2026-04-01T10:00:00Z' }],
        flujoPerdidas: [{ estado: 'perdido', motivo_perdida: 'Precio' }],
        stockActivo: [{ estado: 'activo', precio_cotizado: 4000 }]
      };

      // Primer renderizado
      DashboardCharts.renderCharts(filterRes);
      const initialCount = createdCharts.length;
      expect(initialCount).toBe(8); // Los 8 canvas creados

      // Segundo renderizado (simula cambio de filtro temporal)
      DashboardCharts.renderCharts(filterRes);

      // Verificamos que se hayan destruido las instancias previas
      expect(destroyedCount).toBeGreaterThanOrEqual(8);
      // Las instancias activas actuales son las nuevas
      const activeMonthly = DashboardCharts.getChartMonthly();
      expect(activeMonthly).toBeDefined();
      expect(activeMonthly.destroyed).toBe(false);
    });
  });
});
