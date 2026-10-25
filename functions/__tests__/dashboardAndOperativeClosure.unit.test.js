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
      expect(appCoreContent).toContain("document.getElementById(`filter-proj-${key}`) || document.getElementById(`pill-proj-${key}`)");
    });
  });

  // =========================================================================
  // 3. Consistencia de Inventario de Cuentas por Cobrar (Stock Vivo)
  // =========================================================================
  describe('3. Consistencia de Cuentas por Cobrar (Stock Vivo)', () => {
    test('3.1 app_core.js calcula CxC Global sobre el universo de proyectos no eliminados', () => {
      expect(appCoreContent).toContain("const cxcUniverse = (prospects && Array.isArray(prospects)) ? prospects.filter(p => p && p.eliminado !== true) : [];");
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
    test('4.1 showView y applyRolePermissions respetan al Administrador legítimo', () => {
      // El admin tiene acceso a users-view
      expect(appCoreContent).toContain("if (viewId === 'users-view' && currentUser && currentUser.role !== 'manager' && currentUser.role !== 'admin')");
      // El dashboard comercial queda reservado para la gerencia
      expect(appCoreContent).toContain("if (viewId === 'dashboard-view' && currentUser && currentUser.role !== 'manager')");
      // applyRolePermissions da acceso a users y settings para el admin
      expect(appCoreContent).toContain("else if (role === 'admin')");
      expect(appCoreContent).toContain("[navUsers, navSettings, navList, navClients]");
    });

    test('4.2 showView mantiene bloqueo a proyectos-view para vendedores', () => {
      expect(appCoreContent).toContain("if (viewId === 'projects-view' && currentUser && currentUser.role === 'vendedor')");
      expect(appCoreContent).toContain('Acceso denegado: el perfil de vendedor no tiene acceso al módulo de Proyectos y Cobros.');
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
        // Implementación canónica idéntica a app_core.js
        let lastViewedSection = 'list-view';
        let currentListMode = 'agenda';

        return function showView(viewId, currentUser) {
          if (viewId === 'projects-view' && currentUser && currentUser.role === 'vendedor') {
            alertLog.push(`projects-view blocked for ${currentUser.role}`);
            return showView('list-view', currentUser);
          }
          if (viewId === 'dashboard-view' && currentUser && currentUser.role !== 'manager') {
            alertLog.push(`dashboard-view blocked for ${currentUser.role}`);
            return showView(currentUser.role === 'admin' ? 'users-view' : 'list-view', currentUser);
          }
          if (viewId === 'users-view' && currentUser && currentUser.role !== 'manager' && currentUser.role !== 'admin') {
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

      test('4.3.1 Administrador legítimo: accede a users-view pero es redirigido desde dashboard-view', () => {
        const doc = createDomMock();
        const alerts = [];
        const showView = buildShowViewFn(doc, alerts);
        const adminUser = { id: 'U-ADM', role: 'admin' };

        // Admin abre users-view: permitido
        const resUsers = showView('users-view', adminUser);
        expect(resUsers).toBe('users-view');
        expect(doc.getElementById('users-view').classList.contains('active')).toBe(true);
        expect(alerts).toHaveLength(0);

        // Admin intenta abrir dashboard-view: bloqueado y redirigido a users-view
        const resDash = showView('dashboard-view', adminUser);
        expect(alerts).toContain('dashboard-view blocked for admin');
        expect(resDash).toBe('users-view');
      });

      test('4.3.2 Gerente: acceso irrestricto a dashboard-view, users-view y projects-view', () => {
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

      test('4.3.3 Gestor: acceso a projects-view, pero bloqueado de dashboard-view y users-view', () => {
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

      test('4.3.4 Vendedor: estrictamente bloqueado de projects-view, dashboard-view y users-view', () => {
        const doc = createDomMock();
        const alerts = [];
        const showView = buildShowViewFn(doc, alerts);
        const vendedorUser = { id: 'U-VEN', role: 'vendedor' };

        // Proyectos
        expect(showView('projects-view', vendedorUser)).toBe('list-view');
        expect(alerts).toContain('projects-view blocked for vendedor');

        // Dashboard
        expect(showView('dashboard-view', vendedorUser)).toBe('list-view');
        expect(alerts).toContain('dashboard-view blocked for vendedor');

        // Usuarios
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

});
