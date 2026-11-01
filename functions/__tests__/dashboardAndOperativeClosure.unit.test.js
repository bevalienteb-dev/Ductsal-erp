// functions/__tests__/dashboardAndOperativeClosure.unit.test.js
// Validación exhaustiva del cierre de dashboards gerenciales y operativos del CRM Ductsal

const fs = require('fs');
const path = require('path');

const CrmDashboardCalc = require('../../crm_dashboard_calc');
const CrmFollowUpCalc = require('../crm_followup_calc');

const appCorePath = path.join(__dirname, '../../app_core.js');
const indexHtmlPath = path.join(__dirname, '../../index.html');
const appCoreContent = fs.readFileSync(appCorePath, 'utf8');
const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
const financeUiPath = path.join(__dirname, '../../modules/finance/finance_ui.js');
const financeUiContent = fs.existsSync(financeUiPath) ? fs.readFileSync(financeUiPath, 'utf8') : '';
const getProjectsListContent = () => (financeUiContent || appCoreContent);
const dashboardUiPath = path.join(__dirname, '../../modules/dashboard/dashboard_ui.js');
const dashboardUiContent = fs.existsSync(dashboardUiPath) ? fs.readFileSync(dashboardUiPath, 'utf8') : '';
const getDashboardContent = () => (dashboardUiContent || appCoreContent);

describe('Cierre de Dashboards Gerenciales y Operativos (DUCTSAL CRM)', () => {

  // =========================================================================
  // 1. Unificación de Límites SLA y Consistencia entre Capas
  // =========================================================================
  describe('1. Unificación de Límites SLA y Consistencia entre Capas', () => {
    test('1.1 CrmDashboardCalc y CrmFollowUpCalc definen límites consistentes según su base temporal', () => {
      // CrmDashboardCalc: Base días calendario para promedios de duración global
      expect(CrmDashboardCalc.DEFAULT_KPI_LIMITS).toBeDefined();
      expect(CrmDashboardCalc.DEFAULT_KPI_LIMITS.prospecto).toBe(5);
      expect(CrmDashboardCalc.DEFAULT_KPI_LIMITS.cotizacion).toBe(5);
      expect(CrmDashboardCalc.DEFAULT_KPI_LIMITS.cierre).toBe(5);

      // CrmFollowUpCalc: Base días hábiles salvadoreños para gestión y escalación
      expect(CrmFollowUpCalc.STAGE_LIMITS_BUSINESS_DAYS).toBeDefined();
      expect(CrmFollowUpCalc.STAGE_LIMITS_BUSINESS_DAYS.prospecto).toBe(3);
      expect(CrmFollowUpCalc.STAGE_LIMITS_BUSINESS_DAYS.cotizacion).toBe(5);
      expect(CrmFollowUpCalc.STAGE_LIMITS_BUSINESS_DAYS.negociacion).toBeNull();
      expect(CrmFollowUpCalc.STAGE_LIMITS_BUSINESS_DAYS.cierre).toBe(5);
    });

    test('1.2 KPI_LIMITS en app_core.js está unificado con la matriz de gobernanza comercial', () => {
      expect(appCoreContent).toContain("const KPI_LIMITS = { 'prospecto': 3, 'levantamiento': 5, 'cotizacion': 5, 'negociacion': null, 'cierre': 5 };");
    });

    test('1.3 Etapas sin límite fijo (negociación: null) no generan falsas alertas de vencimiento en tiempos de transición', () => {
      const opps = [
        {
          id: 'OPP-NEG-1',
          estado: 'ganado',
          fecha_creacion: '2026-01-01T10:00:00.000Z',
          fecha_cierre: '2026-03-01T10:00:00.000Z',
          stage_timestamps: {
            negociacion: '2026-01-10T10:00:00.000Z',
            cierre: '2026-02-28T10:00:00.000Z'
          }
        }
      ];

      const transitions = CrmDashboardCalc.calculateStageTransitionTimes(opps, CrmDashboardCalc.STAGES, { negociacion: null });
      expect(transitions.negociacion).toBeDefined();
      expect(transitions.negociacion.avgDays).toBe(49);
      expect(transitions.negociacion.limit).toBeNull();
      expect(transitions.negociacion.isOverLimit).toBe(false);
    });

    test('1.4 Etapas con límite superado marcan isOverLimit respetando el límite provisto', () => {
      const opps = [
        {
          id: 'OPP-PROS-1',
          estado: 'activo',
          fecha_creacion: '2026-01-01T10:00:00.000Z',
          stage_timestamps: {
            prospecto: '2026-01-01T10:00:00.000Z',
            cotizacion: '2026-01-05T10:00:00.000Z'
          }
        }
      ];

      const transitions = CrmDashboardCalc.calculateStageTransitionTimes(opps, CrmDashboardCalc.STAGES, { prospecto: 3 });
      expect(transitions.prospecto).toBeDefined();
      expect(transitions.prospecto.avgDays).toBe(4);
      expect(transitions.prospecto.limit).toBe(3);
      expect(transitions.prospecto.isOverLimit).toBe(true);
    });
  });

  // =========================================================================
  // 2. Dashboard Operativo: Proyectos y Control de Cobros
  // =========================================================================
  describe('2. Dashboard Operativo: Proyectos y Control de Cobros', () => {
    test('2.1 index.html contiene los IDs de botones de filtro esperados', () => {
      expect(indexHtmlContent).toContain('id="filter-proj-pendientes"');
      expect(indexHtmlContent).toContain('id="filter-proj-pagados"');
      expect(indexHtmlContent).toContain('id="filter-proj-todos"');
    });

    test('2.2 renderProjectsList en app_core.js actualiza la clase active soportando filter-proj-', () => {
      expect(getProjectsListContent()).toContain("document.getElementById(`filter-proj-${key}`) || document.getElementById(`pill-proj-${key}`)");
    });
  });

  // =========================================================================
  // 3. Consistencia de Inventario de Cuentas por Cobrar (Stock Vivo)
  // =========================================================================
  describe('3. Consistencia de Cuentas por Cobrar (Stock Vivo)', () => {
    test('3.1 app_core.js calcula CxC Global sobre el universo de proyectos no eliminados', () => {
      expect(getDashboardContent()).toContain("const cxcUniverse = (prospects && Array.isArray(prospects)) ? prospects.filter(p => p && p.eliminado !== true) : [];");
    });

    test('3.2 calculateCxCMetrics preserva facturas de años anteriores independientemente del filtro de flujo', () => {
      const opps = [
        {
          id: 'OPP-2025',
          estado: 'ganado',
          fecha_cierre: '2025-11-15T00:00:00.000Z',
          facturas: [
            { monto: 10000, pagos: [{ monto: 4000 }] } // 6,000 pendiente de cobro
          ]
        },
        {
          id: 'OPP-2026',
          estado: 'ganado',
          fecha_cierre: '2026-02-10T00:00:00.000Z',
          facturas: [
            { monto: 5000, pagos: [{ monto: 5000 }] } // 0 pendiente
          ]
        }
      ];

      const metrics = CrmDashboardCalc.calculateCxCMetrics(opps);
      expect(metrics.totalFacturado).toBe(15000);
      expect(metrics.totalCobrado).toBe(9000);
      expect(metrics.totalCxC).toBe(6000);
      expect(metrics.pctCobrado).toBe(60);
    });
  });

  // =========================================================================
  // 4. Seguridad y Protección de Navegación por Rol (Simulación y Contratos)
  // =========================================================================
  describe('4. Seguridad y Protección de Navegación por Rol', () => {
    test('4.1 showView y applyRolePermissions garantizan autoridad total al Gerente y bloquean acceso administrativo a roles no autorizados', () => {
      // El dashboard comercial queda reservado para la gerencia
      expect(appCoreContent).toContain("if (viewId === 'dashboard-view' && currentUser && currentUser.role !== 'manager')");
      // La vista de usuarios queda reservada exclusivamente para la gerencia
      expect(appCoreContent).toContain("if (viewId === 'users-view' && currentUser && currentUser.role !== 'manager')");
    });

    test('4.2 showView permite a vendedor acceder a projects-view (Fase 5.4)', () => {
      expect(appCoreContent).not.toContain("if (viewId === 'projects-view' && currentUser && currentUser.role === 'vendedor')");
    });

    // Simulación funcional de showView con DOM mockeado
    describe('4.3 Simulación funcional de showView para cada rol real', () => {
      function createDomMock() {
        const elements = {};
        const getEl = (id) => {
          if (!elements[id]) {
            elements[id] = {
              id,
              classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
              },
              style: {}
            };
          }
          return elements[id];
        };

        const viewSections = [
          getEl('list-view'),
          getEl('clients-view'),
          getEl('projects-view'),
          getEl('dashboard-view'),
          getEl('users-view'),
          getEl('detail-view')
        ];

        const navLinks = [
          getEl('nav-list'),
          getEl('nav-clients'),
          getEl('nav-projects'),
          getEl('nav-dashboard'),
          getEl('nav-users')
        ];

        return {
          elements,
          getElementById: (id) => getEl(id),
          querySelectorAll: (sel) => {
            if (sel === '.view-section') return viewSections;
            if (sel === '.nav-links li') return navLinks;
            return [];
          }
        };
      }

      function buildShowViewFn(docMock, alertLog) {
        // Implementación canónica idéntica a app_core.js y app_router.js
        let lastViewedSection = 'list-view';

        return function showView(viewId, currentUser) {
          if (viewId === 'dashboard-view' && currentUser && currentUser.role !== 'manager') {
            alertLog.push(`dashboard-view blocked for ${currentUser.role}`);
            return showView('list-view', currentUser);
          }
          if (viewId === 'users-view' && currentUser && currentUser.role !== 'manager') {
            alertLog.push(`users-view blocked for ${currentUser.role}`);
            return showView('list-view', currentUser);
          }

          docMock.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
          docMock.getElementById(viewId).classList.add('active');
          docMock.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));

          if (viewId === 'list-view') {
            docMock.getElementById('nav-list').classList.add('active');
          }
          if (viewId === 'dashboard-view') {
            docMock.getElementById('nav-dashboard').classList.add('active');
          }
          if (viewId === 'projects-view') {
            docMock.getElementById('nav-projects').classList.add('active');
          }
          if (viewId === 'users-view') {
            docMock.getElementById('nav-users').classList.add('active');
          }

          return viewId;
        };
      }

      test('4.3.1 Gerente General: acceso irrestricto y autoridad total sobre dashboard-view, users-view y projects-view', () => {
        const doc = createDomMock();
        const alerts = [];
        const showView = buildShowViewFn(doc, alerts);
        const managerUser = { id: 'U-MGR', role: 'manager' };

        expect(showView('dashboard-view', managerUser)).toBe('dashboard-view');
        expect(doc.getElementById('dashboard-view').classList.contains('active')).toBe(true);

        expect(showView('users-view', managerUser)).toBe('users-view');
        expect(doc.getElementById('users-view').classList.contains('active')).toBe(true);

        expect(showView('projects-view', managerUser)).toBe('projects-view');
        expect(doc.getElementById('projects-view').classList.contains('active')).toBe(true);

        expect(alerts).toHaveLength(0);
      });

      test('4.3.2 Gestor: acceso a projects-view, pero bloqueado de dashboard-view y users-view', () => {
        const doc = createDomMock();
        const alerts = [];
        const showView = buildShowViewFn(doc, alerts);
        const gestorUser = { id: 'U-GES', role: 'gestor' };

        expect(showView('projects-view', gestorUser)).toBe('projects-view');
        expect(doc.getElementById('projects-view').classList.contains('active')).toBe(true);

        // Intenta abrir dashboard-view
        const resDash = showView('dashboard-view', gestorUser);
        expect(alerts).toContain('dashboard-view blocked for gestor');
        expect(resDash).toBe('list-view');

        // Intenta abrir users-view
        const resUsers = showView('users-view', gestorUser);
        expect(alerts).toContain('users-view blocked for gestor');
        expect(resUsers).toBe('list-view');
      });

      test('4.3.4 Vendedor: acceso a projects-view (Mis Proyectos), estrictamente bloqueado de dashboard-view y users-view', () => {
        const doc = createDomMock();
        const alerts = [];
        const showView = buildShowViewFn(doc, alerts);
        const vendedorUser = { id: 'U-VEN', role: 'vendedor' };

        // Proyectos: permitido en Fase 5.4
        expect(showView('projects-view', vendedorUser)).toBe('projects-view');
        expect(doc.getElementById('projects-view').classList.contains('active')).toBe(true);

        // Dashboard: bloqueado
        expect(showView('dashboard-view', vendedorUser)).toBe('list-view');
        expect(alerts).toContain('dashboard-view blocked for vendedor');

        // Usuarios: bloqueado
        expect(showView('users-view', vendedorUser)).toBe('list-view');
        expect(alerts).toContain('users-view blocked for vendedor');
      });
    });
  });

  // =========================================================================
  // 5. Preservación de la Integración con Fabricación
  // =========================================================================
  describe('5. Integración con Fabricación', () => {
    test('5.1 No reintroduce botones de fabricación en el CRM comercial', () => {
      expect(indexHtmlContent).not.toContain('id="btn-send-fab"');
      expect(appCoreContent).not.toContain('showSendFabForm');
    });

    test('5.2 Eliminación lógica de oportunidades protege la integridad de proyectos de fabricación', () => {
      expect(appCoreContent).toContain('No se borran sus datos, ni los archivos, ni el proyecto de fabricación asociado');
    });
  });

  // =========================================================================
  // 6. Trazabilidad de Integración E2E Completa (Ciclo de Vida Empresarial)
  // Cliente -> Oportunidad -> Cotización -> Proyecto -> Contrato -> Facturación -> Pagos -> Dashboard
  // =========================================================================
  describe('6. Trazabilidad de Integración E2E Completa (Ciclo de Vida Empresarial)', () => {
    test('6.1 Flujo completo preserva identificadores, importes, retenciones, pagos y métricas en Dashboard', () => {
      const FinanceCalculations = require('../../modules/finance/finance_calculations');

      // 1. Cliente
      const client = {
        id: 'CLI_E2E_901',
        empresa: 'Corporación Inmobiliaria Las Cascadas',
        tipo: 'juridica',
        nit: '0614-250890-101-2',
        es_exportacion: false,
        createdBy: 'vnd_101',
        visibleTo: ['vnd_101', 'mgr_001']
      };

      // 2. Oportunidad
      const opportunity = {
        id: 'OPP_E2E_801',
        clientId: client.id,
        nombre: 'Suministro y Montaje de Ductos Torre B',
        createdBy: 'vnd_101',
        vendedorId: 'vnd_101',
        vendedorName: 'Carlos Mendoza',
        etapa: 'contacto',
        estado: 'activo',
        fecha_creacion: '2026-10-01T08:00:00.000Z'
      };
      expect(opportunity.clientId).toBe(client.id);

      // 3. Cotización y Propuesta
      opportunity.precio_cotizado = 20000;
      opportunity.costo_venta = 12000;
      opportunity.etapa = 'cotizacion';
      const initialSubtotal = FinanceCalculations.getProjectSubtotal(opportunity);
      const initialCosto = FinanceCalculations.getProjectCosto(opportunity);
      const initialMargin = initialSubtotal - initialCosto;
      expect(initialSubtotal).toBe(20000);
      expect(initialMargin).toBe(8000);

      // 4. Proyecto Ganado y Postcierre
      opportunity.etapa = 'cierre';
      opportunity.estado = 'ganado';
      opportunity.postcierre_habilitado = true;
      opportunity.fecha_cierre = '2026-10-15T15:30:00.000Z';
      opportunity.stage_timestamps = {
        cotizacion: '2026-10-05T10:00:00.000Z',
        cierre: '2026-10-15T15:30:00.000Z'
      };

      // 5. Contrato y Órdenes de Cambio
      opportunity.ordenes_cambio = [
        { id: 'OC_01', tipo: 'aumento', precio: 5000, costo: 3000, motivo: 'Extensión a Nivel 5' }
      ];
      const revisedSubtotal = FinanceCalculations.getProjectSubtotal(opportunity);
      const revisedCosto = FinanceCalculations.getProjectCosto(opportunity);
      expect(revisedSubtotal).toBe(25000);
      expect(revisedCosto).toBe(15000);

      // 6. Facturación (Anticipo de obra 30% con IVA)
      // Subtotal $25,000 * 13% IVA = $28,250 Total Contratado
      const anticipoSubtotal = 7500;
      const anticipoIva = anticipoSubtotal * 0.13; // $975
      const anticipoTotal = anticipoSubtotal + anticipoIva; // $8,475

      opportunity.facturas = [
        {
          id: 'FAC_001',
          numero: 'CCFE-00982',
          tipo: 'anticipo',
          monto: anticipoTotal,
          fecha: '2026-10-18T10:00:00.000Z',
          pagos: []
        }
      ];

      FinanceCalculations.setDeps({ getClients: () => [client] });
      const finBeforePayment = FinanceCalculations.calculateProjectFinancials(opportunity);
      expect(finBeforePayment.totalFacturado).toBe(8475);
      expect(finBeforePayment.totalCobrado).toBe(0);
      expect(finBeforePayment.saldoCxC).toBe(8475); // Facturado $8,475 - Cobrado $0
      expect(finBeforePayment.porFacturar).toBe(19775); // Total $28,250 - Facturado $8,475
      expect(finBeforePayment.isFullyPaid).toBe(false);

      // 7. Pagos y Cobranza Conciliada
      opportunity.facturas[0].pagos.push({
        id: 'PAG_001',
        monto: anticipoTotal,
        metodo: 'transferencia',
        banco: 'Banco Agrícola',
        referencia: 'TR-88129031',
        fecha: '2026-10-20T11:00:00.000Z'
      });

      const finAfterPayment = FinanceCalculations.calculateProjectFinancials(opportunity);
      expect(finAfterPayment.totalCobrado).toBe(8475);
      expect(finAfterPayment.saldoCxC).toBe(0); // $8,475 facturado - $8,475 cobrado = $0
      expect(finAfterPayment.porFacturar).toBe(19775);
      expect(finAfterPayment.pctCobrado).toBe(30);

      // 8. Reflejo Exacto en el Dashboard Gerencial
      const wonMetrics = CrmDashboardCalc.calculateWonMetrics([opportunity]);
      expect(wonMetrics.totalPrecio).toBe(25000); // Subtotal consolidado ($20,000 + $5,000 OC)
      expect(wonMetrics.totalCosto).toBe(15000);  // Costo consolidado ($12,000 + $3,000 OC)
      expect(wonMetrics.margen).toBe(10000);      // Margen bruto $10,000 USD
      expect(wonMetrics.countTotal).toBe(1);

      const sellerMetrics = CrmDashboardCalc.calculateSellerPerformance([opportunity], [], [], [
        { id: 'vnd_101', nombre: 'Carlos Mendoza', role: 'vendedor' }
      ]);
      const vendorRow = sellerMetrics.sellers.find(s => s.sellerId === 'vnd_101');
      expect(vendorRow).toBeDefined();
      expect(vendorRow.countGanadas).toBe(1);
      expect(vendorRow.ventasGanadas).toBe(25000);
    });
  });
});
