'use strict';

/**
 * DUCTSAL ERP — FASE B6
 * Suite de regresión reutilizable de Paridad B5 vs B6:
 *  1. Congelamiento funcional y matemático del Dashboard B5 en B6 (CrmDashboardCalc + DashboardController).
 *  2. Visibilidad, navegación y restricciones RBAC por rol: Manager, Gestor y Vendedor (UsersPermissions + contactsService).
 *  3. Cuenta 360 Commercial First: 4 KPIs primarios comerciales + 3 indicadores financieros secundarios B5 intactos.
 *  4. Navegación cruzada Cuenta -> Contacto -> Oportunidad y protección de datos personales (personalDataRestricted).
 */

const CrmDashboardCalc = require('../../crm_dashboard_calc');
const CrmBiEngine = require('../../crm_bi_engine');
const UsersPermissions = require('../../modules/users/users_permissions');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createContactsService } = require('../contactsService');

describe('FASE B6 — Regresión Reutilizable de Paridad Dashboard B5, Cuenta 360 y Roles (Manager, Gestor, Vendedor)', () => {
  const sampleUsers = [
    { id: 'mgr-001', uid: 'mgr-001', name: 'Ing. Benjamín Valiente', nombre: 'Ing. Benjamín Valiente', role: 'manager', status: 'active', active: true, activo: true },
    { id: 'usr-mfg', uid: 'usr-mfg', name: 'María Fernanda Gómez', nombre: 'María Fernanda Gómez', role: 'vendedor', status: 'active', active: true, activo: true },
    { id: 'usr-jap', uid: 'usr-jap', name: 'Javier Alejandro Pineda', nombre: 'Javier Alejandro Pineda', role: 'vendedor', status: 'active', active: true, activo: true },
    { id: 'usr-dc', uid: 'usr-dc', name: 'Ing. Diego Castillo', nombre: 'Ing. Diego Castillo', role: 'gestor', status: 'active', active: true, activo: true },
    { id: 'usr-ex', uid: 'usr-ex', name: 'Ex Vendedor Histórico', nombre: 'Ex Vendedor Histórico', role: 'vendedor', status: 'disabled', active: false, activo: false }
  ];

  const sampleClients = [
    {
      id: 'CLI-001',
      tipo: 'juridica',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      nit: '0614-150892-101-4',
      nrc: '189402-5',
      is_gran_contribuyente: true,
      total_dinero_recibido: 129510.00,
      saldo_abonos_pendientes_aplicar: 4250.00
    }
  ];

  const sampleProspects = [
    {
      id: 'OPP-2026-101',
      codigo: '202610101',
      clientId: 'CLI-001',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      proyecto: 'CLIMATIZACIÓN Y DUCTERÍA TORRE CORPORATIVA SANTA ELENA',
      vendedor: 'María Fernanda Gómez',
      gestor: 'Ing. Diego Castillo',
      canal: 'Licitación Privada',
      tipo_producto: 'Ducto',
      tipo_proyecto: 'Fabricación e instalación',
      clasificacion: 'ejecucion',
      estado: 'activo',
      etapa: 'negociacion',
      probabilidad: 75,
      precio_cotizado: 68500.00,
      costo_venta: 45210.00,
      fecha: '2026-10-02',
      fecha_inicio: '2026-10-02',
      fecha_entrega_oferta: '2026-10-14',
      ofertas_historicas: [
        { version: 1, precio: 64000, fecha: '2026-10-08' },
        { version: 2, precio: 67000, fecha: '2026-10-11' },
        { version: 3, precio: 68500, fecha: '2026-10-14' }
      ]
    },
    {
      id: 'OPP-2026-102',
      codigo: '202610102',
      clientId: 'CLI-001',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      proyecto: 'EXTRACCIÓN Y VENTILACIÓN NAVE LOGÍSTICA FASE II',
      vendedor: 'María Fernanda Gómez',
      gestor: 'Ing. Diego Castillo',
      canal: 'Cliente Recurrente',
      tipo_producto: 'Ducto',
      tipo_proyecto: 'Fabricación',
      clasificacion: 'ejecucion',
      estado: 'activo',
      etapa: 'cotizacion',
      probabilidad: 50,
      precio_cotizado: 29400.00,
      costo_venta: 19100.00,
      fecha: '2026-10-20',
      fecha_inicio: '2026-10-20',
      ofertas_historicas: [
        { version: 1, precio: 29400, fecha: '2026-11-05' },
        { version: 2, precio: 29400, fecha: '2026-11-10' }
      ]
    },
    {
      id: 'OPP-2026-103',
      codigo: '202608103',
      clientId: 'CLI-001',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      proyecto: 'SISTEMA HVAC PLANTA FARMACÉUTICA SOYAPANGO',
      vendedor: 'Javier Alejandro Pineda',
      gestor: 'Ing. Diego Castillo',
      canal: 'Cliente Recurrente',
      tipo_producto: 'Ducto',
      tipo_proyecto: 'Fabricación e instalación',
      clasificacion: 'ejecucion',
      estado: 'ganado',
      etapa: 'cierre',
      probabilidad: 100,
      precio_cotizado: 142000.00,
      precio_pactado: 150000.00,
      precio_final: 160460.00,
      costo_venta: 92300.00,
      ordenes_cambio: [
        { id: 'OC-1', tipo: 'aumento', desc: 'Ramal cuarto limpio adicional', precio: 8000, costo: 4900 }
      ],
      fecha: '2026-08-05',
      fecha_inicio: '2026-08-05',
      fecha_cierre: '2026-09-18',
      fecha_entrega_oferta: '2026-08-22',
      facturas: [
        {
          id: 'FAC-103-A',
          numero: 'CCF-2041',
          numeroFactura: 'CCF-2041',
          fecha: '2026-09-20',
          fecha_vencimiento: '2026-10-20',
          monto: 80230.00,
          montoTotal: 80230.00,
          montoPagado: 80230.00,
          estado: 'pagada',
          pagos: [
            { id: 'PAG-1', fecha: '2026-09-25', monto: 79520.00, metodo: 'transferencia' },
            { id: 'PAG-2', fecha: '2026-09-25', monto: 710.00, metodo: 'retencion_1pct' }
          ]
        },
        {
          id: 'FAC-103-B',
          numero: 'CCF-2089',
          numeroFactura: 'CCF-2089',
          fecha: '2026-10-10',
          fecha_vencimiento: '2026-10-30',
          monto: 80230.00,
          montoTotal: 80230.00,
          montoPagado: 45030.00,
          estado: 'parcial',
          pagos: [
            { id: 'PAG-3', fecha: '2026-10-22', monto: 45030.00, metodo: 'transferencia' }
          ]
        }
      ]
    },
    {
      id: 'OPP-2026-105',
      codigo: '202607105',
      clientId: 'CLI-001',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      proyecto: 'SUMINISTRO REJILLAS Y DIFUSORES OFICINAS CENTRALES',
      vendedor: 'María Fernanda Gómez',
      gestor: 'Ing. Diego Castillo',
      canal: 'Cliente Recurrente',
      tipo_producto: 'Rejillas y Difusores',
      tipo_proyecto: 'Oficinas',
      clasificacion: 'presupuesto',
      estado: 'perdido',
      etapa: 'negociacion',
      motivo_perdida: 'Precio',
      probabilidad: 0,
      precio_cotizado: 14500.00,
      costo_venta: 10200.00,
      fecha: '2026-07-10',
      fecha_inicio: '2026-07-10',
      fecha_cierre: '2026-08-01',
      fecha_entrega_oferta: '2026-07-19'
    },
    {
      id: 'OPP-2026-106',
      codigo: '202611106',
      clientId: 'CLI-001',
      empresa: 'CORPORACIÓN INDUSTRIAL SALVADOREÑA S.A. DE C.V.',
      proyecto: 'LEVANTAMIENTO VENTILACIÓN SUBTERRÁNEO TORRE B',
      vendedor: 'María Fernanda Gómez',
      gestor: 'Ing. Diego Castillo',
      canal: 'Cliente Recurrente',
      tipo_producto: 'Ducto Rectangular TDC',
      tipo_proyecto: 'Estacionamiento',
      clasificacion: 'presupuesto',
      estado: 'activo',
      etapa: 'levantamiento',
      probabilidad: 25,
      precio_cotizado: 0,
      fecha: '2026-11-10',
      fecha_inicio: '2026-11-10'
    },
    {
      id: 'OPP-2026-107',
      codigo: '202610107',
      clientId: 'CLI-003',
      empresa: 'Carlos Eduardo Rivas Quintanilla',
      proyecto: 'DUCTERÍA RESIDENCIAL CUMBRES DE CUSCATLÁN',
      vendedor: 'Ex Vendedor Histórico',
      gestor: 'Ing. Diego Castillo',
      canal: 'Tráfico Directo / Web',
      tipo_producto: 'Chute',
      tipo_proyecto: 'Fabricación',
      clasificacion: 'ejecucion',
      estado: 'ganado',
      etapa: 'cierre',
      probabilidad: 100,
      precio_cotizado: 22000.00,
      precio_pactado: 24860.00,
      precio_final: 24860.00,
      fecha: '2026-10-01',
      fecha_inicio: '2026-10-01',
      fecha_cierre: '2026-10-26',
      facturas: [
        {
          id: 'FAC-107-A',
          numero: 'FCF-0512',
          numeroFactura: 'FCF-0512',
          fecha: '2026-10-27',
          fecha_vencimiento: '2026-11-27',
          monto: 24860.00,
          montoTotal: 24860.00,
          montoPagado: 12430.00,
          estado: 'parcial',
          pagos: [{ id: 'PAG-107-1', fecha: '2026-10-28', monto: 12430.00, metodo: 'transferencia' }]
        }
      ]
    }
  ];

  const sampleBankDeposits = [
    {
      id: 'BANK_DEP998877',
      normRef: 'DEP998877',
      ref: 'DEP-998877',
      referencia_bancaria_unica: 'DEP-998877',
      clientId: 'CLI-001',
      estado: 'parcialmente_aplicado',
      estadoAbono: 'parcialmente_aplicado',
      importeOriginal: 129510.00,
      montoTotalComprobante: 129510.00,
      totalAplicado: 125260.00,
      saldoDisponible: 4250.00,
      metodo: 'transferencia'
    }
  ];

  test('1. Congelamiento funcional del Dashboard B5 en B6: flujo, stock, CxC, embudo, vendedores activos vs todos y composiciones', () => {
    const filtered = CrmDashboardCalc.filterProspects(sampleProspects, 'all');
    expect(filtered.flujoGanadas).toHaveLength(2);
    expect(filtered.flujoPerdidas).toHaveLength(1);
    expect(filtered.stockActivo).toHaveLength(3);

    const wonMetrics = CrmDashboardCalc.calculateWonMetrics(filtered.flujoGanadas);
    const lostMetrics = CrmDashboardCalc.calculateLostMetrics(filtered.flujoPerdidas);
    expect(wonMetrics.countTotal).toBe(2);
    expect(lostMetrics.count).toBe(1);
    // OPP-103 subtotal = 150000; OPP-107 subtotal = 22000 -> totalPrecio = 172000
    expect(wonMetrics.totalPrecio).toBe(172000);
    // OPP-107 has no costo_venta -> countWithoutCost = 1; OPP-103 has subtotal 150000 and costo 97200 -> margen = 52800 (35.2%)
    expect(wonMetrics.countWithoutCost).toBe(1);
    expect(wonMetrics.margen).toBe(52800);
    expect(Number(wonMetrics.margenPct.toFixed(1))).toBe(35.2);

    const activeMetrics = CrmDashboardCalc.calculateActivePipelineMetrics(filtered.stockActivo);
    expect(activeMetrics.countTotal).toBe(3);
    expect(activeMetrics.totalNominal).toBe(97900);
    expect(activeMetrics.totalPonderado).toBe(66075);

    const cxcMetrics = CrmDashboardCalc.calculateCxCMetrics(sampleProspects, { clients: sampleClients, bankDeposits: sampleBankDeposits });
    expect(cxcMetrics.totalFacturado).toBe(185320);
    expect(cxcMetrics.totalCobrado).toBe(137690);
    expect(cxcMetrics.totalCxC).toBe(47630);
    expect(cxcMetrics.retencionesAplicadas).toBe(710);
    expect(cxcMetrics.abonosPendientesDeAplicar).toBe(4250);

    const sellersActiveOnly = CrmDashboardCalc.calculateSellerPerformance(filtered.flujoGanadas, filtered.flujoPerdidas, filtered.stockActivo, sampleUsers, 'active_only');
    const sellersAll = CrmDashboardCalc.calculateSellerPerformance(filtered.flujoGanadas, filtered.flujoPerdidas, filtered.stockActivo, sampleUsers, 'all');
    expect(sellersActiveOnly.excludedInactiveMetrics.countSellers).toBe(1);
    expect(sellersActiveOnly.sellers.map(s => s.nombre)).not.toContain('Ex Vendedor Histórico');
    expect(sellersAll.sellers.map(s => s.nombre)).toContain('Ex Vendedor Histórico');

    const funnel = CrmDashboardCalc.calculatePipelineStageDistribution(filtered.stockActivo);
    expect(funnel.stages).toHaveLength(5);
    expect(funnel.totalNominal).toBe(97900);
    expect(funnel.totalPonderado).toBe(66075);
  });

  test('2. Cuenta 360 Commercial First: 4 KPIs principales comerciales y 3 indicadores financieros secundarios intactos', () => {
    const metrics = CrmBiEngine.computeAccount360Metrics('CLI-001', sampleProspects, {
      clients: sampleClients,
      bankDeposits: sampleBankDeposits
    });
    expect(metrics.primaryCommercialKpis).toEqual({
      tasaExitoComercialPct: 50,
      pipelineAbiertoMonto: 97900,
      pipelineAbiertoCount: 3,
      negociosAdjudicadosCount: 1,
      negociosAdjudicadosMonto: 150000,
      propuestasPresentadasCount: 3,
      propuestasPresentadasMonto: 233000
    });
    // Secondary financial indicators remain intact with B5 formulas
    expect(metrics.facturacionTotal).toBe(160460);
    expect(metrics.totalCobrado).toBe(125260);
    expect(metrics.saldoPorCobrar).toBe(35200);
    expect(metrics.pulsoFinanciero).toEqual({
      facturadoVigente: 160460,
      cobradoTotal: 125260,
      cxcPendiente: 35200,
      abonosDisponibles: 4250
    });
  });

  test('3. Visibilidad y restricciones de navegación por rol: Manager, Gestor y Vendedor', () => {
    const manager = sampleUsers[0];
    const vendedor = sampleUsers[1];
    const gestor = sampleUsers[3];

    // Manager permissions
    expect(UsersPermissions.canAccessView(manager, 'dashboard-view')).toBe(true);
    expect(UsersPermissions.canAccessView(manager, 'users-view')).toBe(true);
    expect(UsersPermissions.canAccessView(manager, 'settings-view')).toBe(true);
    expect(UsersPermissions.canAccessView(manager, 'projects-view')).toBe(true);
    expect(UsersPermissions.canAccessView(manager, 'clients-view')).toBe(true);
    expect(UsersPermissions.canManageUsers(manager)).toBe(true);
    expect(UsersPermissions.canExecuteManagerActions(manager)).toBe(true);

    // Gestor permissions
    expect(UsersPermissions.canAccessView(gestor, 'dashboard-view')).toBe(false);
    expect(UsersPermissions.canAccessView(gestor, 'users-view')).toBe(false);
    expect(UsersPermissions.canAccessView(gestor, 'settings-view')).toBe(false);
    expect(UsersPermissions.canAccessView(gestor, 'projects-view')).toBe(true);
    expect(UsersPermissions.canAccessView(gestor, 'clients-view')).toBe(true);
    expect(UsersPermissions.canManageUsers(gestor)).toBe(false);
    expect(UsersPermissions.canExecuteManagerActions(gestor)).toBe(false);

    // Vendedor permissions
    expect(UsersPermissions.canAccessView(vendedor, 'dashboard-view')).toBe(false);
    expect(UsersPermissions.canAccessView(vendedor, 'users-view')).toBe(false);
    expect(UsersPermissions.canAccessView(vendedor, 'settings-view')).toBe(false);
    expect(UsersPermissions.canAccessView(vendedor, 'projects-view')).toBe(true);
    expect(UsersPermissions.canAccessView(vendedor, 'clients-view')).toBe(true);
    expect(UsersPermissions.canManageUsers(vendedor)).toBe(false);
    expect(UsersPermissions.canExecuteManagerActions(vendedor)).toBe(false);
  });

  test('4. Contacto 360, Directorio Global y RBAC personalDataRestricted entre Vendedores, Gestor y Manager', async () => {
    const fdb = createFakeFirestore();
    const svc = createContactsService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => new Date('2026-11-14T12:00:00Z'),
      verifyManager: async () => false
    });

    await fdb.collection('users_prod').doc('mgr-001').set({ nombre: 'Manager', role: 'manager', status: 'active' });
    await fdb.collection('users_prod').doc('ges-001').set({ nombre: 'Gestor', role: 'gestor', status: 'active' });
    await fdb.collection('users_prod').doc('ven-A').set({ nombre: 'Vendedor A', role: 'vendedor', status: 'active' });
    await fdb.collection('users_prod').doc('ven-B').set({ nombre: 'Vendedor B', role: 'vendedor', status: 'active' });

    await fdb.collection('clients_prod').doc('CLI-SHARED').set({ tipo: 'juridica', empresa: 'INDUSTRIAS COMPARTIDAS S.A.' });
    await fdb.collection('prospects_prod').doc('OPP-A').set({
      clientId: 'CLI-SHARED',
      proyecto: 'Proyecto Vendedor A',
      vendedorId: 'ven-A',
      estado: 'activo',
      etapa: 'cotizacion'
    });
    await fdb.collection('prospects_prod').doc('OPP-B').set({
      clientId: 'CLI-SHARED',
      proyecto: 'Proyecto Vendedor B',
      vendedorId: 'ven-B',
      estado: 'activo',
      etapa: 'negociacion'
    });

    const callerVenA = { uid: 'u-a', cid: 'ven-A', role: 'vendedor', nombre: 'Vendedor A' };
    const callerVenB = { uid: 'u-b', cid: 'ven-B', role: 'vendedor', nombre: 'Vendedor B' };
    const callerGestor = { uid: 'u-g', cid: 'ges-001', role: 'gestor', nombre: 'Gestor' };

    // Vendedor A creates a contact with personal email/phone and links to CLI-SHARED
    const created = await svc.createContact({
      caller: callerVenA,
      contact: {
        nombres: 'Roberto',
        apellidos: 'Salinas',
        correo: 'roberto.personal@privado.com',
        telefono: '7000-9999'
      }
    });
    await svc.linkContactToAccount({
      caller: callerVenA,
      accountId: 'CLI-SHARED',
      contactId: created.contact.id,
      cargo: 'Director de Ingeniería',
      correo_corporativo: 'rsalinas@compartidas.com',
      telefono_corporativo: '2200-1111'
    });

    // Vendedor B (who also has an opportunity in CLI-SHARED) queries Contact 360 with includeDossier=true:
    // Personal email/phone must be restricted (personalDataRestricted=true), while corporate channels remain visible!
    const viewByVenB = await svc.getContact({
      caller: callerVenB,
      contactId: created.contact.id,
      includeDossier: true
    });
    expect(viewByVenB.contact.personalDataRestricted).toBe(true);
    expect(viewByVenB.contact.correo).toBeNull();
    expect(viewByVenB.contact.telefono).toBeNull();
    expect(viewByVenB.contact.accountRelations).toHaveLength(1);
    expect(viewByVenB.contact.accountRelations[0].correo_corporativo).toBe('rsalinas@compartidas.com');

    // Gestor sees full personal and corporate data (personalDataRestricted=false)
    const viewByGestor = await svc.getContact({
      caller: callerGestor,
      contactId: created.contact.id,
      includeDossier: true
    });
    expect(viewByGestor.contact.personalDataRestricted).toBe(false);
    expect(viewByGestor.contact.correo).toBe('roberto.personal@privado.com');
    expect(viewByGestor.contact.telefono).toBe('7000-9999');
  });

  test('5. Panel de Seguimiento Comercial (Bloque A UX): estructura responsiva de Cadencia/Intentos, insignias sin recorte y contraste WCAG AA', () => {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.resolve(__dirname, '../..');
    const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(repoRoot, 'styles.css'), 'utf8');
    const oppsUiJs = fs.readFileSync(path.join(repoRoot, 'modules/opportunities/opportunities_ui.js'), 'utf8');

    expect(indexHtml).toContain('class="followup-control-box"');
    expect(indexHtml).toContain('class="btn-primary btn-followup-record"');
    expect(stylesCss).toContain('.followup-cadence-grid');
    expect(stylesCss).toContain('repeat(auto-fit, minmax(135px, 1fr))');
    expect(stylesCss).toContain('.followup-control-box .followup-badge');
    expect(stylesCss).toContain('white-space: normal !important');
    expect(oppsUiJs).toContain('followup-cadence-cell');
    expect(oppsUiJs).toContain('followup-attempts-cell');
    expect(oppsUiJs).toContain('followup-fin-card');
    expect(oppsUiJs).toContain('de 5 fallidos');
  });
});
