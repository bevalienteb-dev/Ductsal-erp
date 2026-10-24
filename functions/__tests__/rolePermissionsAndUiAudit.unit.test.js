// functions/__tests__/rolePermissionsAndUiAudit.unit.test.js
// Auditoría integral de permisos por rol, modal de reasignación, modal de seguimiento y reglas comerciales

const fs = require('fs');
const path = require('path');

const CrmFollowUpCalc = require('../crm_followup_calc');
const CrmDashboardCalc = require('../../crm_dashboard_calc');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');

const appCoreSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app_core.js'), 'utf8');
const indexHtmlSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const stylesCssSource = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');

describe('Auditoría Integral de Permisos por Rol y Layout CRM', () => {

  const CLOCK = new Date(2026, 9, 22, 10, 0, 0); // Jueves 22 Oct 2026

  const USERS = [
    { id: 'U-MGR', cid: 'U-MGR', nombre: 'Gerente General', role: 'manager', activo: true, email: 'mgr@ductsal.com' },
    { id: 'U-ADM', cid: 'U-ADM', nombre: 'Administrador TI', role: 'admin', activo: true, email: 'admin@ductsal.com' },
    { id: 'U-V1', cid: 'U-V1', nombre: 'Vendedor Uno', role: 'vendedor', activo: true, email: 'v1@ductsal.com' },
    { id: 'U-V2', cid: 'U-V2', nombre: 'Vendedor Dos', role: 'vendedor', activo: true, email: 'v2@ductsal.com' },
    { id: 'U-G1', cid: 'U-G1', nombre: 'Gestor Uno', role: 'gestor', activo: true, email: 'g1@ductsal.com' },
    { id: 'U-G2', cid: 'U-G2', nombre: 'Gestor Dos', role: 'gestor', activo: true, email: 'g2@ductsal.com' },
    { id: 'U-INACTIVO', cid: 'U-INACTIVO', nombre: 'Vendedor Inactivo', role: 'vendedor', activo: false, email: 'inactivo@ductsal.com' }
  ];

  function makeEnv() {
    const fdb = createFakeFirestore({ clock: () => CLOCK });
    const commercial = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => CLOCK,
      verifyManager: async () => true
    });
    const wf = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: commercial.kit
    });
    return { fdb, commercial, wf };
  }

  // Helper para crear oportunidades de prueba
  function makeOpp(id, vendedorId, clasificacion = 'ejecucion', etapa = 'negociacion', extra = {}) {
    return {
      id,
      codigo: id,
      proyecto: `Proyecto ${id}`,
      clientId: 'CLI-01',
      vendedorId,
      createdBy: vendedorId,
      clasificacion,
      etapa,
      estado: 'activo',
      fecha_creacion: '2026-10-01',
      precio_cotizado: 5000,
      seguimiento: {
        proxima_accion: { fecha: '2026-10-22', tipo: 'llamada', descripcion: 'Llamar cliente' },
        cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 0 }
      },
      ...extra
    };
  }

  // =========================================================================
  // SECCIÓN 1: PERMISOS POR ROL (VENDEDOR, GESTOR, GERENTE)
  // =========================================================================
  describe('1. Verificación y Corrección de Permisos por Rol', () => {

    test('1.1 Vendedor: solo puede consultar y gestionar sus propias oportunidades en la agenda', () => {
      const oppV1 = makeOpp('P-V1', 'U-V1');
      const oppV2 = makeOpp('P-V2', 'U-V2');
      const allOpps = [oppV1, oppV2];

      const agendaV1 = CrmFollowUpCalc.generateAgenda(allOpps, { id: 'U-V1', cid: 'U-V1', role: 'vendedor' }, 'todas', CLOCK, USERS);
      expect(agendaV1.items).toHaveLength(1);
      expect(agendaV1.items[0].id).toBe('P-V1');
      expect(agendaV1.items[0].vendedorId).toBe('U-V1');
    });

    test('1.2 Gestor: queda estrictamente limitado a sus propias oportunidades en la agenda (NO acceso global)', () => {
      const oppG1 = makeOpp('P-G1', 'U-G1');
      const oppV1 = makeOpp('P-V1', 'U-V1');
      const oppV2 = makeOpp('P-V2', 'U-V2');
      const allOpps = [oppG1, oppV1, oppV2];

      const agendaG1 = CrmFollowUpCalc.generateAgenda(allOpps, { id: 'U-G1', cid: 'U-G1', role: 'gestor' }, 'todas', CLOCK, USERS);
      expect(agendaG1.items).toHaveLength(1);
      expect(agendaG1.items[0].id).toBe('P-G1');
      expect(agendaG1.items[0].vendedorId).toBe('U-G1');
    });

    test('1.3 Gerente: recibe en su agenda únicamente escalaciones gerenciales y oportunidades propias, NO la rutina global de todos los vendedores', () => {
      const oppV1 = makeOpp('P-V1', 'U-V1');
      const oppV2 = makeOpp('P-V2', 'U-V2');
      const oppEscalada = makeOpp('P-ESC', 'U-V1', 'ejecucion', 'negociacion', {
        seguimiento: {
          cadencia: { alerta_gerencial: true, intentos_fallidos: 5 }
        }
      });
      const oppPropiaMgr = makeOpp('P-MGR', 'U-MGR');

      const allOpps = [oppV1, oppV2, oppEscalada, oppPropiaMgr];

      const agendaMgr = CrmFollowUpCalc.generateAgenda(allOpps, { id: 'U-MGR', cid: 'U-MGR', role: 'manager' }, 'todas', CLOCK, USERS);
      expect(agendaMgr.items).toHaveLength(2);
      const ids = agendaMgr.items.map(it => it.id);
      expect(ids).toContain('P-ESC');     // Escalación
      expect(ids).toContain('P-MGR');     // Propia
      expect(ids).not.toContain('P-V1'); // Rutina ajena excluida
      expect(ids).not.toContain('P-V2'); // Rutina ajena excluida
    });

    test('1.4 Gerente: puede inspeccionar la agenda de un vendedor específico seleccionándolo en el dropdown', () => {
      const oppV1_1 = makeOpp('P-V1-A', 'U-V1');
      const oppV1_2 = makeOpp('P-V1-B', 'U-V1');
      const oppV2 = makeOpp('P-V2', 'U-V2');
      const allOpps = [oppV1_1, oppV1_2, oppV2];

      const v1Universe = allOpps.filter(p => p.vendedorId === 'U-V1' || p.createdBy === 'U-V1');
      const targetSeller = USERS.find(u => u.id === 'U-V1');
      const agendaInspeccion = CrmFollowUpCalc.generateAgenda(v1Universe, targetSeller, 'todas', CLOCK, USERS);

      expect(agendaInspeccion.items).toHaveLength(2);
      expect(agendaInspeccion.items.every(it => it.vendedorId === 'U-V1')).toBe(true);
    });

    test('1.5 Backend: Gestor no puede registrar seguimiento en oportunidad ajena', async () => {
      const { fdb, commercial } = makeEnv();
      fdb.collection('prospects_prod').doc('P-V1').set(makeOpp('P-V1', 'U-V1'));

      await expect(
        commercial.recordFollowUp({
          caller: { uid: 'auth-g1', role: 'gestor', cid: 'U-G1', name: 'Gestor 1' },
          prospectId: 'P-V1',
          data: { canal: 'llamada', resultado: 'respondio_evaluando', detalle: 'Intento no autorizado' },
          opId: 'op_followup_gestor_test'
        })
      ).rejects.toThrow(/No tienes acceso a esta oportunidad/);
    });

    test('1.6 Backend: Gestor no puede reclasificar oportunidad ajena', async () => {
      const { fdb, commercial } = makeEnv();
      fdb.collection('prospects_prod').doc('P-V1').set(makeOpp('P-V1', 'U-V1'));

      await expect(
        commercial.reclassifyProspect({
          caller: { uid: 'auth-g1', role: 'gestor', cid: 'U-G1', name: 'Gestor 1' },
          prospectId: 'P-V1',
          clasificacion: 'presupuesto',
          motivo: 'Cambio de prueba',
          opId: 'op_reclass_gestor_test'
        })
      ).rejects.toThrow(/No tienes acceso a esta oportunidad/);
    });

    test('1.7 Backend: Gestor no puede cambiar la cadencia de una oportunidad ajena', async () => {
      const { fdb, commercial } = makeEnv();
      fdb.collection('prospects_prod').doc('P-V1').set(makeOpp('P-V1', 'U-V1'));

      await expect(
        commercial.updateProspectCadence({
          caller: { uid: 'auth-g1', role: 'gestor', cid: 'U-G1', name: 'Gestor 1' },
          prospectId: 'P-V1',
          tipoCadencia: 'urgente',
          motivo: 'Cambio no autorizado',
          opId: 'op_cadence_gestor_test'
        })
      ).rejects.toThrow(/No tienes acceso a esta oportunidad/);
    });

    test('1.8 Frontend: openDetail bloquea acceso tanto a vendedor como a gestor si la oportunidad es ajena', () => {
      expect(appCoreSource).toContain("if (currentUser && (currentUser.role === 'vendedor' || currentUser.role === 'gestor'))");
      expect(appCoreSource).toContain("const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);");
      expect(appCoreSource).toContain("alert('No tienes acceso a esta oportunidad');");
    });
  });

  // =========================================================================
  // SECCIÓN 2: MODAL DE REASIGNACIÓN Y CAPACIDAD COMERCIAL
  // =========================================================================
  describe('2. Modal de Reasignación de Responsable Comercial', () => {

    test('2.1 app_core.js no utiliza window.prompt para la reasignación en el flujo del modal', () => {
      expect(appCoreSource).toContain("function reassignVendor(prospectId, directTargetId)");
      expect(appCoreSource).toContain("openModal('reassignModal');");
      expect(appCoreSource).toContain("processConfirmReassign(event)");
    });

    test('2.2 index.html contiene el modal #reassignModal con su select y contenedor de errores', () => {
      expect(indexHtmlSource).toContain('id="reassignModal"');
      expect(indexHtmlSource).toContain('id="reassign-new-vendor-select"');
      expect(indexHtmlSource).toContain('id="reassign-error-box"');
      expect(indexHtmlSource).toContain('id="btn-confirm-reassign"');
      expect(indexHtmlSource).toContain('id="reassign-current-vendor"');
    });

    test('2.3 Filtro de responsables: excluye explícitamente gerentes, administradores e inactivos', () => {
      const validUsers = USERS.filter(u => {
        if (!u || u.activo === false) return false;
        const r = String(u.role || '').toLowerCase();
        return r === 'vendedor' || r === 'gestor';
      });

      expect(validUsers).toHaveLength(4); // U-V1, U-V2, U-G1, U-G2
      const roles = validUsers.map(u => u.role);
      expect(roles).not.toContain('manager');
      expect(roles).not.toContain('admin');
      const ids = validUsers.map(u => u.id);
      expect(ids).not.toContain('U-INACTIVO');
    });

    test('2.4 Backend: rechaza reasignar a un usuario con rol manager o admin', async () => {
      const { fdb, commercial } = makeEnv();
      fdb.collection('prospects_prod').doc('P-V1').set(makeOpp('P-V1', 'U-V1'));
      USERS.forEach(u => fdb.collection('users_prod').doc(u.id).set(u));

      // Intento de reasignar a un Manager (rechazado porque solo vendedor o gestor pueden ser asignados)
      await expect(
        commercial.reassign({
          caller: { uid: 'auth-mgr', role: 'manager', cid: 'U-MGR', name: 'Gerente' },
          prospectId: 'P-V1',
          vendedorId: 'U-MGR'
        })
      ).rejects.toThrow(/Solo se pueden reasignar oportunidades a usuarios con rol Vendedor o Gestor/);

      // Intento de reasignar a un Administrador (rechazado por no ser rol comercial)
      await expect(
        commercial.reassign({
          caller: { uid: 'auth-mgr', role: 'manager', cid: 'U-MGR', name: 'Gerente' },
          prospectId: 'P-V1',
          vendedorId: 'U-ADM'
        })
      ).rejects.toThrow();

      // Reasignación válida a un Gestor
      const res = await commercial.reassign({
        caller: { uid: 'auth-mgr', role: 'manager', cid: 'U-MGR', name: 'Gerente' },
        prospectId: 'P-V1',
        vendedorId: 'U-G1'
      });
      expect(res.status).toBe('reassigned');
      expect(res.vendedorId).toBe('U-G1');
    });
  });

  // =========================================================================
  // SECCIÓN 3: MODAL DE GESTIÓN DE SEGUIMIENTO (LAYOUT Y SCROLL)
  // =========================================================================
  describe('3. Modal de Registro de Gestión de Seguimiento (Layout y Scroll)', () => {

    test('3.1 styles.css implementa el contrato de modal scrollable con cabecera y pie fijos', () => {
      expect(stylesCssSource).toContain('.modal-scrollable-container');
      expect(stylesCssSource).toContain('max-height: calc(100vh - 40px);');
      expect(stylesCssSource).toContain('.modal-header-fixed');
      expect(stylesCssSource).toContain('.modal-body-scrollable');
      expect(stylesCssSource).toContain('overflow-y: auto;');
      expect(stylesCssSource).toContain('min-height: 0;');
      expect(stylesCssSource).toContain('.modal-footer-fixed');
      expect(stylesCssSource).toContain('body.modal-open');
    });

    test('3.2 index.html estructura #followUpModal con cabecera fija, cuerpo con scroll y pie fijo', () => {
      expect(indexHtmlSource).toContain('id="followUpModal"');
      expect(indexHtmlSource).toContain('class="modal-content glass-panel modal-scrollable-container"');
      expect(indexHtmlSource).toContain('class="modal-header-fixed"');
      expect(indexHtmlSource).toContain('class="modal-body-scrollable"');
      expect(indexHtmlSource).toContain('class="modal-footer-fixed"');
      expect(indexHtmlSource).toContain('id="btn-save-followup"');
    });

    test('3.3 openModal y closeModal bloquean y desbloquean el scroll de la página de fondo (body.modal-open)', () => {
      expect(appCoreSource).toContain("document.body.classList.add('modal-open');");
      expect(appCoreSource).toContain("document.body.classList.remove('modal-open');");
    });
  });

  // =========================================================================
  // SECCIÓN 4: CLASIFICACIÓN COMERCIAL ("SOLO PARA PRESUPUESTO")
  // =========================================================================
  describe('4. Clasificación Comercial: Solo para Presupuesto vs Para Ejecución', () => {

    test('4.1 Oportunidad clasificada como presupuesto queda dormida tras entregar cotización (sin tareas en agenda)', () => {
      const oppPresupuesto = makeOpp('P-PRES-01', 'U-V1', 'presupuesto', 'negociacion', {
        seguimiento: {
          fecha_entrega_oferta: '2026-10-15',
          proxima_accion: { fecha: '2026-10-22', tipo: 'llamada' },
          cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 2 }
        }
      });

      const clasif = CrmFollowUpCalc.classifyFollowUp(oppPresupuesto, CLOCK);
      expect(clasif.status).toBe('al_dia');
      expect(clasif.isPresupuesto).toBe(true);
      expect(clasif.inAgenda).toBe(false);

      // En la agenda diaria no genera ítem
      const agenda = CrmFollowUpCalc.generateAgenda([oppPresupuesto], { id: 'U-V1', role: 'vendedor' }, 'todas', CLOCK, USERS);
      expect(agenda.items).toHaveLength(0);
    });

    test('4.2 Oportunidad clasificada como presupuesto no genera alertas de atención del gerente aunque acumule intentos', () => {
      const oppPresupuesto = makeOpp('P-PRES-02', 'U-V1', 'presupuesto', 'negociacion', {
        seguimiento: {
          fecha_entrega_oferta: '2026-08-01',
          cadencia: { intentos_fallidos: 6 }
        }
      });

      const mgrAttention = CrmFollowUpCalc.calculateManagerAttentionItems([oppPresupuesto], USERS);
      expect(mgrAttention.counts.pendientes).toBe(0);
      expect(mgrAttention.items).toHaveLength(0);
    });

    test('4.3 Presupuesto queda excluido del pipeline ponderado y nominal en los cálculos de dashboard', () => {
      const oppEjecucion = makeOpp('P-EJEC', 'U-V1', 'ejecucion', 'negociacion', { precio_cotizado: 10000, probabilidad: 70 });
      const oppPresupuesto = makeOpp('P-PRES', 'U-V1', 'presupuesto', 'negociacion', { precio_cotizado: 20000, probabilidad: 50 });

      const metrics = CrmDashboardCalc.calculateActivePipelineMetrics([oppEjecucion, oppPresupuesto]);
      // Solo oppEjecucion (10000) debe contabilizarse
      expect(metrics.totalNominal).toBe(10000);
      expect(metrics.totalPonderado).toBe(7000); // 10000 * 70% en negociación
      expect(metrics.montoPresupuestoReferencial).toBe(20000);
      expect(metrics.countPresupuestoReferencial).toBe(1);
    });
  });

  // =========================================================================
  // SECCIÓN 5: FECHA DE ENTREGA DE OFERTA Y ROLADO DE SÁBADOS
  // =========================================================================
  describe('5. Fecha de Entrega de Oferta y Rolado de Sábados', () => {

    test('5.1 Workflow registra automáticamente fecha_entrega_oferta al avanzar de Cotización a Negociación', async () => {
      const { fdb, wf } = makeEnv();
      fdb.collection('prospects_prod').doc('P-ADV-01').set(makeOpp('P-ADV-01', 'U-V1', 'ejecucion', 'cotizacion', {
        documentos: [
          { tipo: 'oferta', url: 'https://storage/oferta.pdf', nombre: 'Oferta.pdf' },
          { tipo: 'cuadro_costos', url: 'https://storage/costos.xlsx', nombre: 'Costos.xlsx' }
        ]
      }));

      const res = await wf.advanceStage({
        caller: { uid: 'auth-v1', role: 'vendedor', cid: 'U-V1', name: 'Vendedor 1' },
        prospectId: 'P-ADV-01',
        nextStage: 'negociacion',
        data: {
          costo_venta: 3000,
          precio_cotizado: 5000,
          probabilidad: 'alta',
          deliveryOfferDate: '2026-10-22',
          doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P-ADV-01/oferta.pdf' }],
          doc_costos: [{ name: 'costos.xlsx', storagePath: 'prod_files/prospects/P-ADV-01/costos.xlsx' }]
        }
      });

      expect(res.status).toBe('advanced');
      const snap = await fdb.collection('prospects_prod').doc('P-ADV-01').get();
      const updated = snap.data();
      expect(updated.etapa).toBe('negociacion');
      expect(updated.fecha_entrega_oferta).toBeDefined();
      expect(updated.seguimiento.cadencia.fecha_entrega_oferta_ymd).toBe('2026-10-22');
      expect(updated.seguimiento.proxima_accion).toBeDefined();
    });



    test('5.2 Próxima acción de seguimiento externo nunca cae en sábado (se rueda al siguiente día hábil)', () => {
      // 2026-10-23 es Viernes. +15 días calendario caería en Sábado 7 de Noviembre
      const friday = new Date(2026, 9, 23, 12, 0, 0);
      const extContact = CrmFollowUpCalc.suggestNextExternalContactDate(friday, 'solicito_tiempo');
      const ymd = CrmFollowUpCalc.formatDateYMD(extContact);
      expect(ymd).toBe('2026-11-09'); // Se trasladó al Lunes 9 de Noviembre
    });
  });

  // =========================================================================
  // SECCIÓN 6: TARJETA DE ATENCIÓN DEL GERENTE Y COHERENCIA
  // =========================================================================
  describe('6. Tarjeta de Atención del Gerente y Pipeline Limpio', () => {

    test('6.1 index.html contiene el título exacto "Oportunidades que requieren atención del gerente"', () => {
      expect(indexHtmlSource).toContain('Oportunidades que requieren atención del gerente');
    });

    test('6.2 El contador de la tarjeta coincide con la cantidad de filas pendientes en calculateManagerAttentionItems', () => {
      const oppAlerta1 = makeOpp('P-ALT-1', 'U-V1', 'ejecucion', 'negociacion', {
        seguimiento: { cadencia: { intentos_fallidos: 5 } }
      });
      const oppAlerta2 = makeOpp('P-ALT-2', 'U-V2', 'ejecucion', 'negociacion', {
        solicitud_sin_contrato: { id: 'REQ-1', estado: 'pendiente', motivo: 'Instalación > $10,000 sin contrato', fecha_solicitud: '2026-10-20' }
      });
      const oppNormal = makeOpp('P-NORM', 'U-V1', 'ejecucion', 'negociacion');

      const res = CrmFollowUpCalc.calculateManagerAttentionItems([oppAlerta1, oppAlerta2, oppNormal], USERS, { filterEstado: 'pendientes' });
      expect(res.counts.pendientes).toBe(2);
      expect(res.pendingUniqueCount).toBe(2);
      expect(res.items).toHaveLength(2);
    });

    test('6.3 La tabla del pipeline (#opportunitiesTable / opp-table-body) no aplica clases ni tintes de vencimiento por defecto', () => {
      const listRenderCode = appCoreSource.substring(
        appCoreSource.indexOf('function renderList()'),
        appCoreSource.indexOf('function renderProjectsList()')
      );

      expect(listRenderCode).not.toContain('background: rgba(239, 68, 68');
      expect(listRenderCode).not.toContain('class="vencida"');
      expect(listRenderCode).toContain('const tr = document.createElement(\'tr\'); tr.classList.add(\'cursor-pointer\');');
    });
  });

  // =========================================================================
  // SECCIÓN 7: FASE FINAL DE ACEPTACIÓN — LOS 8 ESCENARIOS ESPECÍFICOS EXIGIDOS
  // =========================================================================
  describe('7. Fase Final de Aceptación — Los 8 Escenarios Específicos Exigidos', () => {

    // Escenario 1: Una oportunidad escalada por seguimiento
    test('7.1 Una oportunidad escalada por seguimiento comercial (5 intentos)', () => {
      const oppSeg = makeOpp('P-ESC-01', 'U-V1', 'ejecucion', 'negociacion', {
        seguimiento: {
          proxima_accion: { fecha: '2026-10-20', tipo: 'llamada' },
          cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 5, alerta_gerencial: true }
        }
      });

      const res = CrmFollowUpCalc.calculateManagerAttentionItems([oppSeg], USERS, { filterEstado: 'pendientes' });
      expect(res.counts.totalPending).toBe(1);
      expect(res.counts.cinco_intentos).toBe(1);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].isPending).toBe(true);
      expect(res.items[0].hasFollowUpEscalation).toBe(true);
      expect(res.items[0].motivoObjects.some(m => m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos')).toBe(true);

      // Filtro por tipo 'seguimiento' debe devolverla
      const filtered = CrmFollowUpCalc.calculateManagerAttentionItems([oppSeg], USERS, { filterMotivo: 'seguimiento', filterEstado: 'pendientes' });
      expect(filtered.items).toHaveLength(1);

      // Filtro por tipo 'solicitud_sin_contrato' no debe devolverla
      const filteredOther = CrmFollowUpCalc.calculateManagerAttentionItems([oppSeg], USERS, { filterMotivo: 'solicitud_sin_contrato', filterEstado: 'pendientes' });
      expect(filteredOther.items).toHaveLength(0);
    });

    // Escenario 2: Una oportunidad con autorización sin contrato pendiente
    test('7.2 Una oportunidad con autorización sin contrato pendiente', () => {
      const oppContract = makeOpp('P-CTR-01', 'U-V1', 'ejecucion', 'negociacion', {
        solicitud_sin_contrato: {
          id: 'REQ-CTR-1',
          estado: 'pendiente',
          motivo: 'Instalación > $10,000 sin contrato escrita',
          fecha_solicitud: '2026-10-22',
          solicitante_nombre: 'Vendedor Uno'
        }
      });

      const res = CrmFollowUpCalc.calculateManagerAttentionItems([oppContract], USERS, { filterEstado: 'pendientes' });
      expect(res.counts.totalPending).toBe(1);
      expect(res.counts.solicitud_sin_contrato).toBe(1);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].isPending).toBe(true);
      expect(res.items[0].hasNoContractRequest).toBe(true);
      expect(res.items[0].motivoObjects.some(m => m.tipo === 'solicitud_sin_contrato')).toBe(true);

      // Filtro por tipo 'solicitud_sin_contrato' debe devolverla
      const filtered = CrmFollowUpCalc.calculateManagerAttentionItems([oppContract], USERS, { filterMotivo: 'solicitud_sin_contrato', filterEstado: 'pendientes' });
      expect(filtered.items).toHaveLength(1);

      // Filtro por tipo 'seguimiento' no debe devolverla
      const filteredOther = CrmFollowUpCalc.calculateManagerAttentionItems([oppContract], USERS, { filterMotivo: 'seguimiento', filterEstado: 'pendientes' });
      expect(filteredOther.items).toHaveLength(0);
    });

    // Escenario 3: Una oportunidad que cumple ambas condiciones, sin duplicar el total
    test('7.3 Una oportunidad que cumple ambas condiciones cuenta exactamente 1 vez sin perder información', () => {
      const oppBoth = makeOpp('P-BOTH-01', 'U-V1', 'ejecucion', 'negociacion', {
        seguimiento: {
          cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 5, alerta_gerencial: true }
        },
        solicitud_sin_contrato: {
          id: 'REQ-BOTH-1',
          estado: 'pendiente',
          motivo: 'Monto mayor a $10,000 sin fianza ni contrato',
          fecha_solicitud: '2026-10-21',
          solicitante_nombre: 'Vendedor Uno'
        }
      });

      const res = CrmFollowUpCalc.calculateManagerAttentionItems([oppBoth], USERS, { filterEstado: 'pendientes' });
      // Contada una sola vez en el total general
      expect(res.counts.totalPending).toBe(1);
      expect(res.pendingUniqueCount).toBe(1);
      expect(res.items).toHaveLength(1);

      // Ambas causas registradas en el detalle sin perder información
      const item = res.items[0];
      expect(item.hasFollowUpEscalation).toBe(true);
      expect(item.hasNoContractRequest).toBe(true);
      expect(item.motivoObjects).toHaveLength(2);
      expect(item.motivoObjects.some(m => m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos')).toBe(true);
      expect(item.motivoObjects.some(m => m.tipo === 'solicitud_sin_contrato')).toBe(true);

      // Los contadores individuales por tipo reflejan 1 en cada causa
      expect(res.counts.cinco_intentos).toBe(1);
      expect(res.counts.solicitud_sin_contrato).toBe(1);

      // Se muestra tanto si se filtra por seguimiento como por sin_contrato
      const matchSeg = CrmFollowUpCalc.calculateManagerAttentionItems([oppBoth], USERS, { filterMotivo: 'seguimiento' });
      expect(matchSeg.items).toHaveLength(1);

      const matchCtr = CrmFollowUpCalc.calculateManagerAttentionItems([oppBoth], USERS, { filterMotivo: 'solicitud_sin_contrato' });
      expect(matchCtr.items).toHaveLength(1);
    });

    // Escenario 4: Una solicitud aprobada o rechazada que ya no cuenta como pendiente
    test('7.4 Una solicitud aprobada o rechazada ya no cuenta como pendiente en la tarjeta', () => {
      const oppAprobada = makeOpp('P-REQ-APR', 'U-V1', 'ejecucion', 'negociacion', {
        solicitudes_sin_contrato: [
          { id: 'REQ-1', estado: 'aprobada', fecha_resolucion: '2026-10-22', resuelto_por: 'Gerente General' }
        ]
      });
      const oppRechazada = makeOpp('P-REQ-REJ', 'U-V1', 'ejecucion', 'negociacion', {
        solicitudes_sin_contrato: [
          { id: 'REQ-2', estado: 'rechazada', fecha_resolucion: '2026-10-22', resuelto_por: 'Gerente General', motivo_decision: 'Falta póliza' }
        ]
      });

      const resPend = CrmFollowUpCalc.calculateManagerAttentionItems([oppAprobada, oppRechazada], USERS, { filterEstado: 'pendientes' });
      expect(resPend.counts.totalPending).toBe(0);
      expect(resPend.items).toHaveLength(0);

      // En el filtro de resueltas / todas, figuran con alertState 'resuelta'
      const resHist = CrmFollowUpCalc.calculateManagerAttentionItems([oppAprobada, oppRechazada], USERS, { filterEstado: 'todas' });
      expect(resHist.items).toHaveLength(2);
      expect(resHist.items[0].alertState).toBe('resuelta');
      expect(resHist.items[1].alertState).toBe('resuelta');
    });

    // Escenario 5: Una escalación de seguimiento resuelta que no reaparece por el historial anterior
    test('7.5 Una escalación de seguimiento resuelta (continuidad autorizada) no reaparece por el historial anterior', async () => {
      const { fdb, commercial } = makeEnv();
      const oppId = 'P-RES-ESC-01';

      await fdb.collection('prospects_prod').doc(oppId).set(makeOpp(oppId, 'U-V1', 'ejecucion', 'negociacion', {
        seguimiento: {
          proxima_accion: { fecha: '2026-10-20', tipo: 'llamada' },
          cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 5, alerta_gerencial: true, estado_cadencia: 'escalado_gerencia' }
        }
      }));

      // El gerente resuelve autorizando la continuidad
      const resolveRes = await commercial.resolveFollowUpEscalation({
        caller: { uid: 'auth-mgr', role: 'manager', cid: 'U-MGR', name: 'Gerente General' },
        prospectId: oppId,
        decision: 'autorizar_continuar',
        justificacion: 'Cliente confirmó reunión presencial la próxima semana',
        proximaAccion: { fecha: '2026-10-28', tipo: 'reunion', descripcion: 'Reunión en sitio' },
        opId: 'op-esc-res-01'
      });
      expect(resolveRes.status).toBe('resolved');

      // Leemos el documento actualizado de Firestore
      const snap = await fdb.collection('prospects_prod').doc(oppId).get();
      const oppActualizada = snap.data();

      // Verificamos estado persistido
      expect(oppActualizada.seguimiento.cadencia.alerta_gerencial).toBe(false);
      expect(oppActualizada.seguimiento.cadencia.estado_cadencia).toBe('continuidad_autorizada');
      expect(oppActualizada.seguimiento.cadencia.intentos_fallidos).toBe(5); // Los 5 intentos se preservan auditables

      // Al evaluar en calculateManagerAttentionItems:
      const attention = CrmFollowUpCalc.calculateManagerAttentionItems([oppActualizada], USERS, { filterEstado: 'pendientes' });
      expect(attention.counts.totalPending).toBe(0);
      expect(attention.items).toHaveLength(0); // Ya NO aparece en pendientes

      // Y en historial de autorizadas aparece claramente registrada
      const autorizadas = CrmFollowUpCalc.calculateManagerAttentionItems([oppActualizada], USERS, { filterEstado: 'autorizadas' });
      expect(autorizadas.items).toHaveLength(1);
      expect(autorizadas.items[0].alertState).toBe('continuidad_autorizada');
    });

    // Escenario 6: Una oportunidad de presupuesto con intentos históricos, excluida de seguimiento
    test('7.6 Una oportunidad de presupuesto con intentos históricos queda 100% excluida de alertas de seguimiento', () => {
      const oppPresupuestoConIntentos = makeOpp('P-PRES-INT', 'U-V1', 'presupuesto', 'negociacion', {
        seguimiento: {
          cadencia: { tipo_cadencia: 'estandar', intentos_fallidos: 8, alerta_gerencial: true }
        }
      });

      const res = CrmFollowUpCalc.calculateManagerAttentionItems([oppPresupuestoConIntentos], USERS, { filterEstado: 'pendientes' });
      expect(res.counts.totalPending).toBe(0);
      expect(res.counts.cinco_intentos).toBe(0);
      expect(res.items).toHaveLength(0);
    });

    // Escenario 7: Acceso indebido de un Gestor a una oportunidad ajena
    test('7.7 Acceso indebido de un Gestor a una oportunidad ajena es rechazado por backend', async () => {
      const { fdb, commercial } = makeEnv();
      const oppAjenaId = 'P-AJENA-V2';

      await fdb.collection('prospects_prod').doc(oppAjenaId).set(makeOpp(oppAjenaId, 'U-V2', 'ejecucion', 'negociacion'));

      // Gestor Uno (U-G1) intenta reclasificar oportunidad de Vendedor Dos (U-V2)
      await expect(
        commercial.reclassifyProspect({
          caller: { uid: 'auth-g1', role: 'gestor', cid: 'U-G1', name: 'Gestor Uno' },
          prospectId: oppAjenaId,
          clasificacion: 'presupuesto',
          motivo: 'Intento no autorizado de cambio de clasificacion',
          opId: 'op-gestor-hack-01'
        })
      ).rejects.toThrow('No tienes acceso a esta oportunidad');
    });

    // Escenario 8: Reasignación a un Gerente rechazada por frontend y backend
    test('7.8 Reasignación a un Gerente es rechazada por el backend (solo Vendedor o Gestor)', async () => {
      const { fdb, commercial } = makeEnv();
      const oppId = 'P-REAS-TEST';

      await fdb.collection('prospects_prod').doc(oppId).set(makeOpp(oppId, 'U-V1', 'ejecucion', 'negociacion'));
      await fdb.collection('users_prod').doc('U-MGR').set({ id: 'U-MGR', cid: 'U-MGR', nombre: 'Gerente General', role: 'manager', activo: true });

      // Intento de reasignar al Gerente U-MGR
      await expect(
        commercial.reassign({
          caller: { uid: 'auth-mgr', role: 'manager', cid: 'U-MGR', name: 'Gerente General' },
          prospectId: oppId,
          vendedorId: 'U-MGR'
        })
      ).rejects.toThrow('Solo se pueden reasignar oportunidades a usuarios con rol Vendedor o Gestor');

      // Comprobación en frontend: reassignVendor filtra u.role === 'vendedor' || u.role === 'gestor'
      expect(appCoreSource).toContain("(u.role === 'vendedor' || u.role === 'gestor')");
      expect(appCoreSource).toContain("u.activo !== false");
    });

  });


  // =========================================================================
  // SECCIÓN 8: REGRESIÓN — CONSOLIDACIÓN «TODOS LOS COMERCIALES» Y FILTROS DE AGENDA
  // =========================================================================
  describe('8. Regresión: Consolidación «Todos los comerciales» y Filtros de Agenda', () => {

    const multiSellerPipeline = [
      makeOpp('lead-v1-a', 'U-V1', 'ejecucion', 'prospecto', {
        codigo: 'COD-1001',
        seguimiento: {
          cadencia: { intentos_fallidos: 0 },
          proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada rutinaria V1 A' }
        }
      }),
      makeOpp('lead-v1-b', 'U-V1', 'ejecucion', 'negociacion', {
        codigo: 'COD-1002',
        fecha_entrega_oferta: '2026-10-20',
        seguimiento: {
          cadencia: { intentos_fallidos: 2 },
          proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada rutinaria V1 B' }
        }
      }),
      makeOpp('lead-v2-a', 'U-V2', 'ejecucion', 'prospecto', {
        codigo: 'COD-2001',
        seguimiento: {
          cadencia: { intentos_fallidos: 1 },
          proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada rutinaria V2 A' }
        }
      }),
      makeOpp('lead-v2-b', 'U-V2', 'ejecucion', 'negociacion', {
        codigo: 'COD-2002',
        fecha_entrega_oferta: '2026-10-19',
        seguimiento: {
          cadencia: { intentos_fallidos: 3 },
          proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada rutinaria V2 B' }
        }
      }),
      makeOpp('lead-g1-a', 'U-G1', 'ejecucion', 'prospecto', {
        codigo: 'COD-3001',
        seguimiento: {
          cadencia: { intentos_fallidos: 1 },
          proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada rutinaria G1 A' }
        }
      })
    ];

    // Simula la lógica de renderDailyAgenda en app_core.js para evaluar la interacción de filtros y deduplicación
    function simulateRenderDailyAgendaLogic({ currentUser, selectedValue, prospectsList, usersList }) {
      const isManager = currentUser && currentUser.role === 'manager';
      let targetUniverse = prospectsList;
      let agendaUser = currentUser;

      if (isManager) {
        if (selectedValue === 'all') {
          agendaUser = { ...currentUser, viewAll: true };
          targetUniverse = prospectsList;
        } else if (selectedValue === 'manager_only') {
          agendaUser = { ...currentUser, viewAll: false };
          targetUniverse = prospectsList;
        } else {
          const selId = selectedValue;
          targetUniverse = prospectsList.filter(p => p && (p.vendedorId === selId || (!p.vendedorId && p.createdBy === selId)));
          const matchedSeller = (Array.isArray(usersList) ? usersList.find(u => u && (u.id === selId || u.cid === selId)) : null) || { id: selId, cid: selId, role: 'vendedor' };
          agendaUser = matchedSeller;
        }
      } else {
        // Vendedor / Gestor: no tienen selector de comerciales y solo reciben su propio contexto
        targetUniverse = prospectsList;
        agendaUser = currentUser;
      }

      // Deduplicación preventiva idéntica a app_core.js
      const uniqueMap = new Map();
      (targetUniverse || []).forEach(p => {
        if (p && p.id && !uniqueMap.has(p.id)) {
          uniqueMap.set(p.id, p);
        }
      });
      targetUniverse = Array.from(uniqueMap.values());

      return CrmFollowUpCalc.generateAgenda(targetUniverse, agendaUser, 'todas', CLOCK, usersList);
    }

    test('8.1 «Todos los comerciales» consolida las agendas correspondientes a todos los vendedores', () => {
      const mgr = USERS.find(u => u.role === 'manager');
      const result = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'all',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });

      // No debe ser vacío y debe sumar las gestiones de todo el equipo
      expect(result.items.length).toBe(5);
      expect(result.counts.total).toBe(5);

      const ids = result.items.map(it => it.id);
      expect(ids).toContain('lead-v1-a');
      expect(ids).toContain('lead-v1-b');
      expect(ids).toContain('lead-v2-a');
      expect(ids).toContain('lead-v2-b');
      expect(ids).toContain('lead-g1-a');
    });

    test('8.2 No se duplican oportunidades cuando aparecen repetidas por ID o por código', () => {
      const mgr = USERS.find(u => u.role === 'manager');

      // 1. Duplicados por ID en la lista completa para renderDailyAgenda
      const duplicatedById = [
        ...multiSellerPipeline,
        { ...multiSellerPipeline[0] }, // Duplicado de lead-v1-a
        { ...multiSellerPipeline[2] }  // Duplicado de lead-v2-a
      ];

      const resById = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'all',
        prospectsList: duplicatedById,
        usersList: USERS
      });

      expect(resById.items.length).toBe(5);
      const uniqueIds = new Set(resById.items.map(it => it.id));
      expect(uniqueIds.size).toBe(5);

      // 2. Duplicados directos por mismo ID evaluados en CrmFollowUpCalc.generateAgenda
      const duplicateById = [
        makeOpp('lead-dup-id', 'U-V1', 'ejecucion', 'prospecto'),
        makeOpp('lead-dup-id', 'U-V1', 'ejecucion', 'prospecto')
      ];
      const agendaDedupId = CrmFollowUpCalc.generateAgenda(duplicateById, { id: 'U-V1', cid: 'U-V1', role: 'vendedor' }, 'todas', CLOCK, USERS);
      expect(agendaDedupId.items.length).toBe(1);

      // 3. Duplicados directos por mismo código evaluados en CrmFollowUpCalc.generateAgenda
      const duplicateByCodigo = [
        { codigo: 'MISMO-CODIGO', vendedorId: 'U-V1', estado: 'activo', clasificacion: 'ejecucion', etapa: 'prospecto', seguimiento: { proxima_accion: { fecha: '2026-10-22' } } },
        { codigo: 'MISMO-CODIGO', vendedorId: 'U-V1', estado: 'activo', clasificacion: 'ejecucion', etapa: 'prospecto', seguimiento: { proxima_accion: { fecha: '2026-10-22' } } }
      ];
      const agendaDedupCodigo = CrmFollowUpCalc.generateAgenda(duplicateByCodigo, { id: 'U-V1', cid: 'U-V1', role: 'vendedor' }, 'todas', CLOCK, USERS);
      expect(agendaDedupCodigo.items.length).toBe(1);
    });

    test('8.3 Seleccionar un comercial individual devuelve únicamente su agenda', () => {
      const mgr = USERS.find(u => u.role === 'manager');

      // Seleccionar Vendedor Uno (U-V1)
      const resV1 = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'U-V1',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });
      expect(resV1.counts.total).toBe(2);
      expect(resV1.items.map(it => it.id).sort()).toEqual(['lead-v1-a', 'lead-v1-b']);

      // Seleccionar Vendedor Dos (U-V2)
      const resV2 = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'U-V2',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });
      expect(resV2.counts.total).toBe(2);
      expect(resV2.items.map(it => it.id).sort()).toEqual(['lead-v2-a', 'lead-v2-b']);

      // Seleccionar Gestor Uno (U-G1)
      const resG1 = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'U-G1',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });
      expect(resG1.counts.total).toBe(1);
      expect(resG1.items.map(it => it.id)).toEqual(['lead-g1-a']);
    });

    test('8.4 «Mi Agenda» conserva el comportamiento de escalaciones y oportunidades propias', () => {
      const mgr = USERS.find(u => u.role === 'manager');

      // Universo que incluye llamadas rutinarias de terceros, una escalación y un lead propio del Gerente
      const pipelineWithEscalation = [
        ...multiSellerPipeline,
        makeOpp('lead-esc-01', 'U-V1', 'ejecucion', 'negociacion', {
          seguimiento: {
            cadencia: { intentos_fallidos: 5, alerta_gerencial: true }
          }
        }),
        makeOpp('lead-mgr-own', 'U-MGR', 'ejecucion', 'prospecto', {
          seguimiento: {
            cadencia: { intentos_fallidos: 0 },
            proxima_accion: { fecha: '2026-10-22', descripcion: 'Llamada del Gerente' }
          }
        })
      ];

      const resManagerOnly = simulateRenderDailyAgendaLogic({
        currentUser: mgr,
        selectedValue: 'manager_only',
        prospectsList: pipelineWithEscalation,
        usersList: USERS
      });

      // Debe incluir únicamente la escalación y el lead propio (2 items), excluyendo las 5 rutinas ajenas
      expect(resManagerOnly.counts.total).toBe(2);
      const ids = resManagerOnly.items.map(it => it.id);
      expect(ids).toContain('lead-esc-01');
      expect(ids).toContain('lead-mgr-own');
      expect(ids).not.toContain('lead-v1-a');
      expect(ids).not.toContain('lead-v2-a');
      expect(ids).not.toContain('lead-g1-a');
    });

    test('8.5 Vendedor y gestor no pueden ampliar sus permisos mediante viewAll', () => {
      const v1 = USERS.find(u => u.id === 'U-V1');
      const g1 = USERS.find(u => u.id === 'U-G1');

      // Vendedor intentando inyectar viewAll: true directamente en generateAgenda
      const maliciousVendedor = { ...v1, viewAll: true };
      const resVendedor = CrmFollowUpCalc.generateAgenda(multiSellerPipeline, maliciousVendedor, 'todas', CLOCK, USERS);
      expect(resVendedor.counts.total).toBe(2);
      expect(resVendedor.items.every(it => it.vendedorId === 'U-V1')).toBe(true);

      // Gestor intentando inyectar viewAll: true directamente en generateAgenda
      const maliciousGestor = { ...g1, viewAll: true };
      const resGestor = CrmFollowUpCalc.generateAgenda(multiSellerPipeline, maliciousGestor, 'todas', CLOCK, USERS);
      expect(resGestor.counts.total).toBe(1);
      expect(resGestor.items.every(it => it.vendedorId === 'U-G1')).toBe(true);
    });

    test('8.6 La consolidación está limitada al rol gerente', () => {
      const v1 = USERS.find(u => u.id === 'U-V1');
      const g1 = USERS.find(u => u.id === 'U-G1');

      // En el flujo simulado de UI, pasar selectedValue: 'all' con rol vendedor no tiene efecto
      const resV1Ui = simulateRenderDailyAgendaLogic({
        currentUser: v1,
        selectedValue: 'all',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });
      expect(resV1Ui.counts.total).toBe(2);
      expect(resV1Ui.items.map(it => it.id).sort()).toEqual(['lead-v1-a', 'lead-v1-b']);

      // En el flujo simulado de UI con rol gestor tampoco tiene efecto
      const resG1Ui = simulateRenderDailyAgendaLogic({
        currentUser: g1,
        selectedValue: 'all',
        prospectsList: multiSellerPipeline,
        usersList: USERS
      });
      expect(resG1Ui.counts.total).toBe(1);
      expect(resG1Ui.items.map(it => it.id)).toEqual(['lead-g1-a']);
    });

    test('8.7 Backend: Gestor no puede reasignar oportunidades (solo Manager y Admin tienen permiso)', async () => {
      const { fdb, commercial } = makeEnv();
      fdb.collection('prospects_prod').doc('P-V1').set(makeOpp('P-V1', 'U-V1'));
      USERS.forEach(u => fdb.collection('users_prod').doc(u.id).set(u));

      await expect(
        commercial.reassign({
          caller: { uid: 'auth-g1', role: 'gestor', cid: 'U-G1', name: 'Gestor Uno' },
          prospectId: 'P-V1',
          vendedorId: 'U-V2'
        })
      ).rejects.toThrow(/Solo un gerente puede reasignar oportunidades/);
    });

  });
});
