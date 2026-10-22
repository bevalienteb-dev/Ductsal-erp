// functions/__tests__/dashboardCalculations.unit.test.js
// Suite de pruebas unitarias automatizadas para los cálculos matemáticos y semánticos
// del Dashboard Comercial de Ductsal ERP (CrmDashboardCalc).
// Valida los 12 criterios de aceptación críticos con fixtures sintéticos.

const CrmDashboardCalc = require('../../crm_dashboard_calc.js');

describe('CrmDashboardCalc: Auditoría y Validación de Cálculos del Dashboard', () => {

  // ==========================================================================
  // 1. Ventas ganadas con órdenes de cambio positivas y negativas
  // ==========================================================================
  test('1. Ventas ganadas: incorpora correctamente órdenes de cambio (aumentos y disminuciones)', () => {
    const opp1 = {
      id: 'OPP-1',
      estado: 'ganado',
      precio_cotizado: 10000,
      costo_venta: 6000,
      ordenes_cambio: [
        { id: 'OC-1', tipo: 'aumento', precio: 2500, costo: 1500 },
        { id: 'OC-2', tipo: 'disminucion', precio: 500, costo: 300 }
      ]
    };

    const subtotal = CrmDashboardCalc.getProjectSubtotal(opp1);
    const costo = CrmDashboardCalc.getProjectCosto(opp1);

    // 10000 + 2500 - 500 = 12000
    expect(subtotal).toBe(12000);
    // 6000 + 1500 - 300 = 7200
    expect(costo).toBe(7200);

    const metrics = CrmDashboardCalc.calculateWonMetrics([opp1]);
    expect(metrics.totalPrecio).toBe(12000);
    expect(metrics.totalCosto).toBe(7200);
    expect(metrics.margen).toBe(4800); // 12000 - 7200
    expect(metrics.margenPct).toBe(40); // (4800 / 12000) * 100
    expect(metrics.isCostComplete).toBe(true);
  });

  // ==========================================================================
  // 2. Costos y márgenes con datos completos e incompletos
  // ==========================================================================
  test('2. Margen comercial: no asume 100% de margen cuando falta el costo de venta', () => {
    // Caso A: Oportunidad ganada SIN costo de venta registrado
    const oppSinCosto = {
      id: 'OPP-NO-COST',
      estado: 'ganado',
      precio_cotizado: 5000,
      costo_venta: null // Desconocido / ausente
    };

    const metricsSinCosto = CrmDashboardCalc.calculateWonMetrics([oppSinCosto]);
    expect(metricsSinCosto.totalPrecio).toBe(5000);
    expect(metricsSinCosto.precioWithCost).toBe(0);
    expect(metricsSinCosto.totalCosto).toBe(0);
    expect(metricsSinCosto.margen).toBe(0);
    expect(metricsSinCosto.coberturaPct).toBe(0);
    expect(metricsSinCosto.countWithoutCost).toBe(1);
    expect(metricsSinCosto.isCostComplete).toBe(false);
    // No debe atribuir 100% de margen engañoso
    expect(metricsSinCosto.margenPct).toBeNull();

    // Caso B: Mezcla de oportunidad con costo conocido y oportunidad sin costo
    const oppConCosto = {
      id: 'OPP-WITH-COST',
      estado: 'ganado',
      precio_cotizado: 5000,
      costo_venta: 3000
    };

    const metricsMixtas = CrmDashboardCalc.calculateWonMetrics([oppSinCosto, oppConCosto]);
    expect(metricsMixtas.totalPrecio).toBe(10000);
    expect(metricsMixtas.precioWithCost).toBe(5000);
    expect(metricsMixtas.totalCosto).toBe(3000);
    // El margen monetario conocido es exactamente (5000 - 3000) = 2000, no 7000
    expect(metricsMixtas.margen).toBe(2000);
    expect(metricsMixtas.coberturaPct).toBe(50);
    expect(metricsMixtas.countTotal).toBe(2);
    expect(metricsMixtas.countWithCost).toBe(1);
    expect(metricsMixtas.countWithoutCost).toBe(1);
    expect(metricsMixtas.isCostComplete).toBe(false);
    // El margen porcentual se calcula sobre la base con costo conocido (5000 - 3000) / 5000 = 40%
    expect(metricsMixtas.margenPct).toBe(40);
  });

  // ==========================================================================
  // 3. Diferencia entre transiciones completadas y pipeline abierto
  // ==========================================================================
  test('3. Tiempos por etapa: oportunidades activas NO contaminan promedios históricos con Date.now()', () => {
    const stage = 'cotizacion';
    const stages = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];

    // Oportunidad 1: Transición completada de cotización a negociación (duró exactamente 4 días)
    const oppCompletada = {
      id: 'OPP-DONE',
      estado: 'activo',
      etapa: 'negociacion',
      stage_timestamps: {
        cotizacion: '2026-05-01T10:00:00.000Z',
        negociacion: '2026-05-05T10:00:00.000Z'
      }
    };

    // Oportunidad 2: En curso en cotización desde hace 180 días (deal estancado)
    const oppEnCurso = {
      id: 'OPP-STUCK',
      estado: 'activo',
      etapa: 'cotizacion',
      stage_timestamps: {
        cotizacion: '2025-10-01T10:00:00.000Z'
      }
    };

    const tiempos = CrmDashboardCalc.calculateStageTransitionTimes([oppCompletada, oppEnCurso], stages);

    // El promedio de transición completada en 'cotizacion' debe ser exactamente 4 días
    expect(tiempos.cotizacion.countCompleted).toBe(1);
    expect(tiempos.cotizacion.avgDays).toBe(4);
    // La oportunidad en curso se excluye del promedio histórico de salida
    expect(tiempos.cotizacion.countExcludedActive).toBe(1);

    // Por separado, la antigüedad de WIP activo sí detecta los 180+ días
    const wip = CrmDashboardCalc.calculateActiveWipTimes([oppEnCurso], null, new Date('2026-04-01T10:00:00.000Z'));
    expect(wip.allItems[0].days).toBe(182);
    expect(wip.allItems[0].isOverLimit).toBe(true);
  });

  // ==========================================================================
  // 4. Oportunidades abiertas creadas en meses anteriores presentes en pipeline
  // ==========================================================================
  test('4. Stock vs Flujo: pipeline activo preserva oportunidades creadas en meses anteriores', () => {
    const oppAnteriorActiva = {
      id: 'OPP-OLD-ACTIVE',
      estado: 'activo',
      etapa: 'negociacion',
      fecha_creacion: '2025-11-10T10:00:00.000Z',
      precio_cotizado: 20000,
      probabilidad: 50
    };

    const oppNuevaActiva = {
      id: 'OPP-NEW-ACTIVE',
      estado: 'activo',
      etapa: 'cotizacion',
      fecha_creacion: '2026-10-05T10:00:00.000Z',
      precio_cotizado: 10000,
      probabilidad: 70
    };

    // Al filtrar por el mes de Octubre 2026 (2026-9)
    const resultadoFiltro = CrmDashboardCalc.filterProspects([oppAnteriorActiva, oppNuevaActiva], '2026-9');

    // El flujo de altas del mes solo incluye la creada en octubre
    expect(resultadoFiltro.flujoAltas.map(p => p.id)).toEqual(['OPP-NEW-ACTIVE']);

    // Pero el STOCK VIVO del pipeline mantiene ambas oportunidades abiertas
    expect(resultadoFiltro.stockActivo.length).toBe(2);
    expect(resultadoFiltro.stockActivo.map(p => p.id)).toContain('OPP-OLD-ACTIVE');
    expect(resultadoFiltro.stockActivo.map(p => p.id)).toContain('OPP-NEW-ACTIVE');

    // El cálculo del pipeline ponderado evalúa el stock completo
    const pipelineMetrics = CrmDashboardCalc.calculateActivePipelineMetrics(resultadoFiltro.stockActivo);
    // (20000 * 0.5) + (10000 * 0.7) = 10000 + 7000 = 17000
    expect(pipelineMetrics.totalPonderado).toBe(17000);
    expect(pipelineMetrics.countPonderadas).toBe(2);
  });

  // ==========================================================================
  // 5. Altas, cierres y pérdidas asignados al período correcto
  // ==========================================================================
  test('5. Atribución temporal: ganadas se filtran por fecha de cierre y perdidas por fecha de pérdida', () => {
    // Deal creado en Enero 2026 pero GANADO en Octubre 2026
    const dealGanadoOct = {
      id: 'DEAL-WON-OCT',
      estado: 'ganado',
      fecha_creacion: '2026-01-15T10:00:00.000Z',
      fecha_cierre: '2026-10-18T15:30:00.000Z',
      precio_cotizado: 30000
    };

    // Deal creado en Febrero 2026 pero PERDIDO en Octubre 2026
    const dealPerdidoOct = {
      id: 'DEAL-LOST-OCT',
      estado: 'perdido',
      fecha_creacion: '2026-02-10T10:00:00.000Z',
      fecha_perdida: '2026-10-12T09:00:00.000Z',
      precio_cotizado: 15000
    };

    // Deal cerrado en Septiembre 2026 (mes anterior)
    const dealGanadoSep = {
      id: 'DEAL-WON-SEP',
      estado: 'ganado',
      fecha_creacion: '2026-05-01T10:00:00.000Z',
      fecha_cierre: '2026-09-25T12:00:00.000Z',
      precio_cotizado: 10000
    };

    const todos = [dealGanadoOct, dealPerdidoOct, dealGanadoSep];

    // Filtrar por Octubre 2026 (mes 9 en 0-index)
    const resOct = CrmDashboardCalc.filterProspects(todos, '2026-9');
    expect(resOct.flujoGanadas.map(p => p.id)).toEqual(['DEAL-WON-OCT']);
    expect(resOct.flujoPerdidas.map(p => p.id)).toEqual(['DEAL-LOST-OCT']);

    // Filtrar por Septiembre 2026 (mes 8)
    const resSep = CrmDashboardCalc.filterProspects(todos, '2026-8');
    expect(resSep.flujoGanadas.map(p => p.id)).toEqual(['DEAL-WON-SEP']);
    expect(resSep.flujoPerdidas.length).toBe(0);
  });

  // ==========================================================================
  // 6. Registros perdidos sin fecha de pérdida fiable
  // ==========================================================================
  test('6. Pérdidas sin fecha: no se asignan a un mes arbitrario ni usan fecha de creación', () => {
    const perdidaSinFecha = {
      id: 'LOST-NO-DATE',
      estado: 'perdido',
      fecha_creacion: '2024-03-01T10:00:00.000Z',
      fecha_perdida: null, // Fecha de pérdida desconocida
      precio_cotizado: 8000
    };

    // En un mes específico no debe atribuirse por fecha de creación de 2024
    const resMes = CrmDashboardCalc.filterProspects([perdidaSinFecha], '2026-9');
    expect(resMes.flujoPerdidas.length).toBe(0);

    // En histórico completo sí debe contabilizarse
    const resAll = CrmDashboardCalc.filterProspects([perdidaSinFecha], 'all');
    expect(resAll.flujoPerdidas.length).toBe(1);

    // En cálculo de tiempos históricos se excluye
    const tiempos = CrmDashboardCalc.calculateStageTransitionTimes([perdidaSinFecha], ['prospecto']);
    expect(tiempos.prospecto.countCompleted).toBe(0);
    expect(tiempos.prospecto.countExcludedNoDate).toBe(0); // no tenía timestamp de etapa
  });

  // ==========================================================================
  // 7. Límites temporales, cambios de año y períodos históricos
  // ==========================================================================
  test('7. Multi-año: detecta años anteriores presentes en los datos', () => {
    const dataset = [
      { fecha_creacion: '2024-05-10T00:00:00.000Z' },
      { fecha_creacion: '2025-08-15T00:00:00.000Z' },
      { fecha_cierre: '2026-03-20T00:00:00.000Z' }
    ];

    const anos = CrmDashboardCalc.getAvailableYears(dataset, 2026);
    expect(anos).toContain(2026);
    expect(anos).toContain(2025);
    expect(anos).toContain(2024);
    expect(anos[0]).toBe(2026); // Orden descendente

    // Filtrar por año 2025 completo
    const res2025 = CrmDashboardCalc.filterProspects([
      { id: 'P-2025', estado: 'ganado', fecha_cierre: '2025-06-10T00:00:00.000Z' },
      { id: 'P-2026', estado: 'ganado', fecha_cierre: '2026-02-10T00:00:00.000Z' }
    ], 'year_2025');

    expect(res2025.flujoGanadas.map(p => p.id)).toEqual(['P-2025']);
  });

  // ==========================================================================
  // 8. Pagos nulos, importes no numéricos y prevención de NaN
  // ==========================================================================
  test('8. CxC: sanitiza abonos no numéricos o nulos sin producir NaN', () => {
    const oppConPagosSucios = {
      id: 'OPP-INVOICES',
      estado: 'ganado',
      facturas: [
        {
          numero: 'CCF-001',
          monto: 11300, // $10,000 + 13% IVA
          pagos: [
            { monto: 5000 },
            { monto: null }, // Nulo
            { monto: 'invalid-string' }, // String corrupto
            { monto: 3000 }
          ]
        },
        {
          numero: 'CCF-002',
          monto: 'not-a-number', // Factura corrupta
          pagos: []
        }
      ]
    };

    const cxc = CrmDashboardCalc.calculateCxCMetrics([oppConPagosSucios]);

    expect(isNaN(cxc.totalFacturado)).toBe(false);
    expect(isNaN(cxc.totalCobrado)).toBe(false);
    expect(isNaN(cxc.totalCxC)).toBe(false);
    expect(isNaN(cxc.pctCobrado)).toBe(false);

    expect(cxc.totalFacturado).toBe(11300);
    expect(cxc.totalCobrado).toBe(8000); // 5000 + 3000
    expect(cxc.totalCxC).toBe(3300); // 11300 - 8000
    expect(cxc.pctCobrado).toBeCloseTo(70.796, 2);
  });

  // ==========================================================================
  // 9. Estados desconocidos sin romper cálculos ni gráficos
  // ==========================================================================
  test('9. Estados no estándar: no rompen agregaciones ni se clasifican erróneamente', () => {
    const oppsConEstadosRaros = [
      { id: 'OPP-1', estado: 'en_espera', precio_cotizado: 4000, origen: 'Web' },
      { id: 'OPP-2', estado: null, precio_cotizado: 3000, origen: 'Referido' },
      { id: 'OPP-3', estado: 'ganado', precio_cotizado: 5000, origen: 'Web', fecha_cierre: '2026-10-01' }
    ];

    const conversion = CrmDashboardCalc.calculateChannelConversion(oppsConEstadosRaros);
    expect(conversion.statsByChannel['Web'].ganado).toBe(1);
    expect(conversion.statsByChannel['Web'].desconocido).toBe(1);
    expect(conversion.statsByChannel['Referido'].desconocido).toBe(1);

    // No debe lanzar excepciones ni generar NaN
    expect(conversion.summary.length).toBe(2);
    expect(conversion.summary.find(s => s.channel === 'Web').winRate).toBe(100);
  });

  // ==========================================================================
  // 10. Conversión por canal con denominador correcto (Ganadas / Finalizadas)
  // ==========================================================================
  test('10. Tasa de Cierre por canal: ganadas / (ganadas + perdidas), sin confundir activas con pérdidas', () => {
    const datasetCanal = [
      // Canal 'Licitaciones': 2 ganadas, 1 perdida, 10 activas en curso
      { id: 'L1', origen: 'Licitaciones', estado: 'ganado', precio_cotizado: 10000 },
      { id: 'L2', origen: 'Licitaciones', estado: 'ganado', precio_cotizado: 15000 },
      { id: 'L3', origen: 'Licitaciones', estado: 'perdido', precio_cotizado: 8000 },
      { id: 'L4', origen: 'Licitaciones', estado: 'activo', precio_cotizado: 50000 },
      { id: 'L5', origen: 'Licitaciones', estado: 'activo', precio_cotizado: 40000 },

      // Canal 'Recomendado': 1 ganada, 0 perdidas, 2 activas
      { id: 'R1', origen: 'Recomendado', estado: 'ganado', precio_cotizado: 7000 },
      { id: 'R2', origen: 'Recomendado', estado: 'activo', precio_cotizado: 3000 }
    ];

    const res = CrmDashboardCalc.calculateChannelConversion(datasetCanal);
    const licitaciones = res.summary.find(s => s.channel === 'Licitaciones');
    const recomendado = res.summary.find(s => s.channel === 'Recomendado');

    // Licitaciones: 2 ganadas / (2 ganadas + 1 perdida) = 2/3 = 66.7%
    // Las 2 activas NO deben actuar como pérdidas en el denominador de tasa de cierre
    expect(licitaciones.ganado).toBe(2);
    expect(licitaciones.perdido).toBe(1);
    expect(licitaciones.activo).toBe(2);
    expect(licitaciones.concluidas).toBe(3);
    expect(licitaciones.winRate).toBeCloseTo(66.666, 1);
    expect(licitaciones.winRateFormatted).toBe('66.7%');

    // Recomendado: 1 ganada / 1 concluida = 100%
    expect(recomendado.concluidas).toBe(1);
    expect(recomendado.winRate).toBe(100);
    expect(recomendado.winRateFormatted).toBe('100.0%');
  });

  // ==========================================================================
  // 11. Coherencia entre filtros, tarjetas y gráficos
  // ==========================================================================
  test('11. Coherencia de montos: ventas ganadas con OC coincide entre tarjetas y desglose', () => {
    const oppA = {
      id: 'A',
      estado: 'ganado',
      fecha_cierre: '2026-10-10',
      precio_cotizado: 10000,
      costo_venta: 7000,
      tipo_producto: 'Chute',
      tipo_proyecto: 'Fabricación e instalación',
      ordenes_cambio: [{ tipo: 'aumento', precio: 3000, costo: 1000 }]
    };

    const oppB = {
      id: 'B',
      estado: 'ganado',
      fecha_cierre: '2026-10-12',
      precio_cotizado: 5000,
      costo_venta: 3000,
      tipo_producto: 'Ducto',
      tipo_proyecto: 'Fabricación',
      ordenes_cambio: [{ tipo: 'disminucion', precio: 1000, costo: 500 }]
    };

    const filtradas = CrmDashboardCalc.filterProspects([oppA, oppB], '2026-9');
    const metricas = CrmDashboardCalc.calculateWonMetrics(filtradas.flujoGanadas);

    // Opp A: 10000 + 3000 = 13000
    // Opp B: 5000 - 1000 = 4000
    // Total Ganado = 17000
    expect(metricas.totalPrecio).toBe(17000);
    // Costo A: 7000 + 1000 = 8000
    // Costo B: 3000 - 500 = 2500
    // Total Costo = 10500
    expect(metricas.totalCosto).toBe(10500);
    expect(metricas.margen).toBe(6500);

    // El desglose por producto debe sumar exactamente el mismo total (13000 + 4000 = 17000)
    const montoChute = filtradas.flujoGanadas.filter(p => p.tipo_producto === 'Chute').reduce((acc, p) => acc + CrmDashboardCalc.getProjectSubtotal(p), 0);
    const montoDucto = filtradas.flujoGanadas.filter(p => p.tipo_producto === 'Ducto').reduce((acc, p) => acc + CrmDashboardCalc.getProjectSubtotal(p), 0);
    expect(montoChute + montoDucto).toBe(metricas.totalPrecio);
  });

  // ==========================================================================
  // 12. Alertas de estancamiento independientes del filtro temporal
  // ==========================================================================
  test('12. Alertas de estancamiento: evalúa todas las oportunidades activas abiertas hoy', () => {
    const limits = { prospecto: 5, levantamiento: 7, cotizacion: 5, negociacion: 10, cierre: 5 };
    const now = new Date('2026-10-21T12:00:00.000Z');

    const activas = [
      // Creada hace 40 días, ingresó a 'cotizacion' hace 25 días (Límite: 5 días -> Excedida)
      {
        id: 'OPP-STAGNANT',
        estado: 'activo',
        etapa: 'cotizacion',
        proyecto: 'Torre Central',
        fecha_creacion: '2026-09-11T12:00:00.000Z',
        stage_timestamps: { cotizacion: '2026-09-26T12:00:00.000Z' }
      },
      // Creada hace 2 días, ingresó a 'prospecto' hace 2 días (Límite: 5 días -> En tiempo)
      {
        id: 'OPP-FRESH',
        estado: 'activo',
        etapa: 'prospecto',
        proyecto: 'Bodega 4',
        fecha_creacion: '2026-10-19T12:00:00.000Z',
        stage_timestamps: { prospecto: '2026-10-19T12:00:00.000Z' }
      }
    ];

    const wip = CrmDashboardCalc.calculateActiveWipTimes(activas, limits, now);

    expect(wip.totalActive).toBe(2);
    expect(wip.totalOverLimit).toBe(1);
    expect(wip.overLimitItems[0].id).toBe('OPP-STAGNANT');
    expect(wip.overLimitItems[0].days).toBe(25);
    expect(wip.overLimitItems[0].limit).toBe(5);
    expect(wip.overLimitItems[0].isOverLimit).toBe(true);
  });

  // ==========================================================================
  // 13. Pipeline Ponderado: Prueba Numérica Obligatoria (Sección 2)
  // 100.000 al 50%, 50.000 al 20% y 30.000 sin probabilidad válida
  // Esperado: Nominal 180.000, Ponderado 60.000, Sin Probabilidad 30.000
  // ==========================================================================
  test('13. Pipeline ponderado: prueba numérica obligatoria y valores de probabilidad inválidos', () => {
    const opp100k = {
      id: 'OPP-100K',
      estado: 'activo',
      precio_cotizado: 100000,
      probabilidad: 50
    };
    const opp50k = {
      id: 'OPP-50K',
      estado: 'activo',
      precio_cotizado: 50000,
      probabilidad: 20
    };
    const opp30kSinProb = {
      id: 'OPP-30K-NOPROB',
      estado: 'activo',
      precio_cotizado: 30000,
      probabilidad: null // Sin probabilidad válida
    };
    // Casos de borde: probabilidad fuera de rango (>100 o <0) y valor no numérico
    const oppProbInvalida1 = {
      id: 'OPP-OUT-RANGE-HIGH',
      estado: 'activo',
      precio_cotizado: 10000,
      probabilidad: 150 // Inválida > 100
    };
    const oppProbInvalida2 = {
      id: 'OPP-OUT-RANGE-LOW',
      estado: 'activo',
      precio_cotizado: 5000,
      probabilidad: -10 // Inválida < 0
    };

    // A. Prueba obligatoria con las 3 oportunidades base
    const metricsBase = CrmDashboardCalc.calculateActivePipelineMetrics([opp100k, opp50k, opp30kSinProb]);
    // Nominal esperado: 100.000 + 50.000 + 30.000 = 180.000
    expect(metricsBase.totalNominal).toBe(180000);
    // Ponderado verificable de las 2 primeras: (100.000 * 0.5) + (50.000 * 0.2) = 50.000 + 10.000 = 60.000
    expect(metricsBase.totalPonderado).toBe(60000);
    // Los 30.000 sin probabilidad quedan identificados por separado, NO en el ponderado
    expect(metricsBase.montoSinProbabilidad).toBe(30000);
    expect(metricsBase.montoSinPonderar).toBe(30000);
    expect(metricsBase.countPonderadas).toBe(2);
    expect(metricsBase.countSinProbabilidad).toBe(1);
    expect(metricsBase.countSinPonderar).toBe(1);
    expect(metricsBase.countTotal).toBe(3);

    // B. Verificación de exclusión de probabilidades fuera de rango
    const metricsConBorde = CrmDashboardCalc.calculateActivePipelineMetrics([
      opp100k,
      opp50k,
      opp30kSinProb,
      oppProbInvalida1,
      oppProbInvalida2
    ]);
    expect(metricsConBorde.totalNominal).toBe(195000); // 180.000 + 10.000 + 5.000
    expect(metricsConBorde.totalPonderado).toBe(60000); // Ni 150% ni -10% contaminan el ponderado
    expect(metricsConBorde.countSinProbabilidad).toBe(3); // null, 150, -10
    expect(metricsConBorde.montoSinProbabilidad).toBe(45000); // 30.000 + 10.000 + 5.000
  });

  // ==========================================================================
  // 14. Verificación de Fechas y Períodos: Intervalos Semiabiertos [inicio, fin) (Sección 4)
  // ==========================================================================
  test('14. Fechas y períodos: límites exactos de mes normal, febrero bisiesto, cruce de año y semiabierto', () => {
    // 1. Mes normal (Abril 2026: 30 días, month index 3)
    const intAbril = CrmDashboardCalc.getPeriodInterval('2026-3');
    expect(intAbril.start.getFullYear()).toBe(2026);
    expect(intAbril.start.getMonth()).toBe(3);
    expect(intAbril.start.getDate()).toBe(1);
    expect(intAbril.end.getFullYear()).toBe(2026);
    expect(intAbril.end.getMonth()).toBe(4);
    expect(intAbril.end.getDate()).toBe(1);

    // 2. Febrero en año bisiesto (2024: 29 días, month index 1)
    const intFebBisiesto = CrmDashboardCalc.getPeriodInterval('2024-1');
    expect(intFebBisiesto.start.getMonth()).toBe(1);
    expect(intFebBisiesto.end.getMonth()).toBe(2); // Termina el 1 de Marzo
    // Días transcurridos entre inicio y fin: exactamente 29
    const diasFebBisiesto = Math.round((intFebBisiesto.end - intFebBisiesto.start) / (1000 * 60 * 60 * 24));
    expect(diasFebBisiesto).toBe(29);

    // 3. Febrero en año común (2025: 28 días, month index 1)
    const intFebComun = CrmDashboardCalc.getPeriodInterval('2025-1');
    const diasFebComun = Math.round((intFebComun.end - intFebComun.start) / (1000 * 60 * 60 * 24));
    expect(diasFebComun).toBe(28);

    // 4. Cruce de año: Diciembre (2026-11) y Enero siguiente (2027-0)
    const intDic = CrmDashboardCalc.getPeriodInterval('2026-11');
    expect(intDic.start.getFullYear()).toBe(2026);
    expect(intDic.start.getMonth()).toBe(11);
    expect(intDic.end.getFullYear()).toBe(2027);
    expect(intDic.end.getMonth()).toBe(0); // 1 de Enero de 2027

    const intEne = CrmDashboardCalc.getPeriodInterval('2027-0');
    expect(intEne.start.getFullYear()).toBe(2027);
    expect(intEne.start.getMonth()).toBe(0);
    expect(intEne.end.getFullYear()).toBe(2027);
    expect(intEne.end.getMonth()).toBe(1);

    // 5. YTD de año histórico vs corriente
    const intYtd2025 = CrmDashboardCalc.getPeriodInterval('year_2025');
    expect(intYtd2025.isYearOnly).toBe(true);
    expect(intYtd2025.start.getFullYear()).toBe(2025);
    expect(intYtd2025.end.getFullYear()).toBe(2026);

    // 6. Precisión en límites [inicio, fin): inclusión y exclusión exacta
    const inicioOct = new Date(2026, 9, 1, 0, 0, 0, 0);
    const finOct = new Date(2026, 10, 1, 0, 0, 0, 0);

    const msAntesInicio = new Date(inicioOct.getTime() - 1);
    const msEnInicio = new Date(inicioOct.getTime());
    const msUltimoDia = new Date(2026, 9, 31, 23, 59, 59, 999);
    const msEnFin = new Date(finOct.getTime());

    // Crear prospectos para probar filtro
    const sample = [
      { id: 'ANTES', estado: 'ganado', fecha_cierre: msAntesInicio },
      { id: 'EN_INICIO', estado: 'ganado', fecha_cierre: msEnInicio },
      { id: 'ULTIMO_MS', estado: 'ganado', fecha_cierre: msUltimoDia },
      { id: 'EN_FIN', estado: 'ganado', fecha_cierre: msEnFin }
    ];

    const filtrados = CrmDashboardCalc.filterProspects(sample, '2026-9');
    const ids = filtrados.flujoGanadas.map(p => p.id);
    expect(ids).toContain('EN_INICIO');
    expect(ids).toContain('ULTIMO_MS');
    expect(ids).not.toContain('ANTES');
    expect(ids).not.toContain('EN_FIN');
  });

  // ==========================================================================
  // 15. Atribución Temporal: Los 7 Casos Sintéticos (Sección 5)
  // ==========================================================================
  test('15. Atribución temporal: validación exhaustiva de los 7 casos sintéticos de negocio', () => {
    // Caso 1: Creada en julio, ganada en septiembre -> Ventas de septiembre, no julio
    const caso1 = {
      id: 'CASO-1',
      estado: 'ganado',
      fecha_creacion: '2026-07-10T10:00:00.000Z',
      fecha_cierre: '2026-09-15T15:00:00.000Z',
      precio_cotizado: 25000
    };

    // Caso 2: Creada en julio, perdida en septiembre con fecha fiable -> Pérdidas de septiembre
    const caso2 = {
      id: 'CASO-2',
      estado: 'perdido',
      fecha_creacion: '2026-07-12T10:00:00.000Z',
      fecha_perdida: '2026-09-20T11:00:00.000Z',
      precio_cotizado: 12000
    };

    // Caso 3: Oportunidad perdida sin fecha fiable -> Excluida de meses, presente en histórico
    const caso3 = {
      id: 'CASO-3',
      estado: 'perdido',
      fecha_creacion: '2026-07-05T09:00:00.000Z',
      fecha_perdida: null,
      precio_cotizado: 8000
    };

    // Caso 4: Creada meses atrás y todavía abierta -> En pipeline y alertas de hoy
    const caso4 = {
      id: 'CASO-4',
      estado: 'activo',
      etapa: 'cotizacion',
      fecha_creacion: '2026-05-01T08:00:00.000Z',
      precio_cotizado: 40000,
      probabilidad: 50,
      stage_timestamps: { cotizacion: '2026-05-15T08:00:00.000Z' }
    };

    // Caso 5: Oportunidad creada durante el mes de septiembre -> Alta de septiembre
    const caso5 = {
      id: 'CASO-5',
      estado: 'activo',
      etapa: 'prospecto',
      fecha_creacion: '2026-09-02T14:00:00.000Z',
      precio_cotizado: 15000,
      probabilidad: 10
    };

    // Caso 6: Transición completada durante el período con timestamp demostrable
    const caso6 = {
      id: 'CASO-6',
      estado: 'activo',
      etapa: 'negociacion',
      fecha_creacion: '2026-08-01T10:00:00.000Z',
      stage_timestamps: {
        cotizacion: '2026-09-01T10:00:00.000Z',
        negociacion: '2026-09-06T10:00:00.000Z' // Salida de cotización en 5 días
      }
    };

    // Caso 7: Transición sin timestamp fiable -> No recibe duración inventada
    const caso7 = {
      id: 'CASO-7',
      estado: 'ganado',
      fecha_creacion: '2026-06-01T10:00:00.000Z',
      fecha_cierre: '2026-09-30T10:00:00.000Z',
      stage_timestamps: {} // Sin timestamps de etapas intermedias
    };

    const universe = [caso1, caso2, caso3, caso4, caso5, caso6, caso7];

    // Consulta de Septiembre 2026 (mes index 8)
    const sep = CrmDashboardCalc.filterProspects(universe, '2026-8');

    // Verificación Caso 1: Ganada de septiembre, NO de julio
    expect(sep.flujoGanadas.map(p => p.id)).toContain('CASO-1');
    const jul = CrmDashboardCalc.filterProspects(universe, '2026-6');
    expect(jul.flujoGanadas.map(p => p.id)).not.toContain('CASO-1');

    // Verificación Caso 2: Pérdida de septiembre con fecha demostrada
    expect(sep.flujoPerdidas.map(p => p.id)).toContain('CASO-2');

    // Verificación Caso 3: Pérdida sin fecha no se atribuye a septiembre
    expect(sep.flujoPerdidas.map(p => p.id)).not.toContain('CASO-3');
    const all = CrmDashboardCalc.filterProspects(universe, 'all');
    expect(all.flujoPerdidas.map(p => p.id)).toContain('CASO-3');

    // Verificación Caso 4: Abierta vieja sigue en pipeline activo actual
    expect(sep.stockActivo.map(p => p.id)).toContain('CASO-4');
    expect(all.stockActivo.map(p => p.id)).toContain('CASO-4');

    // Verificación Caso 5: Alta de septiembre
    expect(sep.flujoAltas.map(p => p.id)).toContain('CASO-5');
    expect(jul.flujoAltas.map(p => p.id)).not.toContain('CASO-5');

    // Verificación Caso 6: Transición de cotización duró exactamente 5 días
    const tiempos = CrmDashboardCalc.calculateStageTransitionTimes([caso6], CrmDashboardCalc.STAGES);
    expect(tiempos.cotizacion.countCompleted).toBe(1);
    expect(tiempos.cotizacion.avgDays).toBe(5);

    // Verificación Caso 7: Sin timestamp fiable no genera duración inventada
    const tiemposSinTs = CrmDashboardCalc.calculateStageTransitionTimes([caso7], CrmDashboardCalc.STAGES);
    expect(tiemposSinTs.prospecto.countCompleted).toBe(0);
    expect(tiemposSinTs.cotizacion.countCompleted).toBe(0);
  });

  // ==========================================================================
  // 16. Tiempos por Etapa: Rechazo de Marcas de Tiempo Invertidas (Sección 6)
  // ==========================================================================
  test('16. Tiempos por etapa: rechaza fechas finales anteriores a iniciales sin convertirlas a cero días', () => {
    const oppFechaInvertida = {
      id: 'OPP-INVERTIDA',
      estado: 'activo',
      etapa: 'cotizacion',
      stage_timestamps: {
        // Inicio el 10 de Mayo pero candidato de salida marcado el 1 de Mayo (error humano o reloj)
        prospecto: '2026-05-10T10:00:00.000Z',
        levantamiento: '2026-05-01T10:00:00.000Z'
      }
    };

    const oppValida = {
      id: 'OPP-VALIDA',
      estado: 'activo',
      etapa: 'cotizacion',
      stage_timestamps: {
        prospecto: '2026-05-01T10:00:00.000Z',
        levantamiento: '2026-05-07T10:00:00.000Z' // 6 días
      }
    };

    const tiempos = CrmDashboardCalc.calculateStageTransitionTimes([oppFechaInvertida, oppValida], CrmDashboardCalc.STAGES);

    // La transición válida es 1 sola y tiene 6 días
    expect(tiempos.prospecto.countCompleted).toBe(1);
    expect(tiempos.prospecto.avgDays).toBe(6);
    // La transición con fechas invertidas NO se computó como 0 días (lo cual bajaría el promedio a 3 días)
    expect(tiempos.prospecto.countInvalidDates).toBe(1);
  });

  // ==========================================================================
  // 17. Cuentas por Cobrar (CxC): Consistencia, Saldo Cero e Inválidos (Sección 3)
  // ==========================================================================
  test('17. CxC: coincidencia entre facturación y saldo, facturas saldadas en cero y detección de inválidos', () => {
    const proyecto = {
      id: 'PROY-CXC-1',
      estado: 'ganado',
      facturas: [
        // Factura 1: $10.000 + 13% IVA = $11.300, con abono parcial de $6.000 -> saldo $5.300
        {
          id: 'FAC-1',
          numero: 'CCF-101',
          monto: 11300,
          pagos: [{ monto: 6000, metodo: 'transferencia' }]
        },
        // Factura 2: $5.650 totalmente saldada con dos abonos -> saldo $0 real
        {
          id: 'FAC-2',
          numero: 'CCF-102',
          monto: 5650,
          pagos: [
            { monto: 3000, metodo: 'transferencia' },
            { monto: 2650, metodo: 'cheque' }
          ]
        },
        // Factura 3: Registro con monto corrupto / ausente
        {
          id: 'FAC-CORRUPT',
          numero: 'CCF-ERR',
          monto: null,
          pagos: [{ monto: 'not-a-number' }]
        }
      ]
    };

    const cxc = CrmDashboardCalc.calculateCxCMetrics([proyecto]);

    // Facturado válido = 11.300 + 5.650 = 16.950
    expect(cxc.totalFacturado).toBe(16950);
    // Cobrado válido = 6.000 + 3.000 + 2.650 = 11.650
    expect(cxc.totalCobrado).toBe(11650);
    // Saldo pendiente total = 16.950 - 11.650 = 5.300
    expect(cxc.totalCxC).toBe(5300);
    // Coincidencia con desglose factura por factura:
    // Fac 1: 11.300 - 6.000 = 5.300
    // Fac 2: 5.650 - 5.650 = 0
    // Suma de saldos individuales = 5.300 + 0 = 5.300 === totalCxC
    expect(cxc.totalCxC).toBe((11300 - 6000) + (5650 - 5650));

    // Porcentaje cobrado sobre facturación
    expect(cxc.pctCobrado).toBeCloseTo((11650 / 16950) * 100, 2);

    // Registros inválidos identificados y no silenciosos
    expect(cxc.hasInvalidRecords).toBe(true);
    expect(cxc.invalidFacturasCount).toBe(1);
    expect(cxc.invalidPagosCount).toBe(1);

    // Ausencia estricta de NaN
    expect(isNaN(cxc.totalFacturado)).toBe(false);
    expect(isNaN(cxc.totalCobrado)).toBe(false);
    expect(isNaN(cxc.totalCxC)).toBe(false);
    expect(isNaN(cxc.pctCobrado)).toBe(false);
  });

  // ==========================================================================
  // 18. FASE 3: Evolución Mensual de Ventas y Margen (Reconciliación y Cobertura)
  // ==========================================================================
  test('18. Evolución mensual: agrupa cierres por mes, incorpora OC y reconcilia con calculateWonMetrics', () => {
    const oppEne = {
      id: 'OPP-ENE-1',
      estado: 'ganado',
      fecha_cierre: '2026-01-15T10:00:00Z',
      precio_cotizado: 10000,
      costo_venta: 6000,
      ordenes_cambio: [
        { id: 'OC-1', tipo: 'aumento', precio: 2000, costo: 1000 }
      ]
    };

    const oppEne2 = {
      id: 'OPP-ENE-2',
      estado: 'ganado',
      fecha_cierre: '2026-01-20T14:00:00Z',
      precio_cotizado: 5000,
      costo_venta: null // Sin costo
    };

    const oppFeb = {
      id: 'OPP-FEB-1',
      estado: 'ganado',
      fecha_cierre: '2026-02-10T11:00:00Z',
      precio_cotizado: 8000,
      costo_venta: 4800,
      ordenes_cambio: [
        { id: 'OC-2', tipo: 'disminucion', precio: 1000, costo: 600 }
      ]
    };

    const wonList = [oppEne, oppEne2, oppFeb];
    const filterRes = { targetYear: 2026, isYearOnly: true, isHistorical: false };

    const evo = CrmDashboardCalc.calculateMonthlyEvolution(wonList, filterRes);
    const wonMetrics = CrmDashboardCalc.calculateWonMetrics(wonList);

    // 12 meses para el año 2026
    expect(evo.months).toHaveLength(12);

    // Enero: subtotal oppEne (10000+2000 = 12000 con costo) + oppEne2 (5000 sin costo) = 17000
    const ene = evo.months.find(m => m.key === '2026-01');
    expect(ene).toBeDefined();
    expect(ene.ventas).toBe(17000);
    expect(ene.precioConCosto).toBe(12000);
    expect(ene.costos).toBe(7000); // 6000 + 1000
    expect(ene.margen).toBe(5000); // 12000 - 7000 (excluye oppEne2 sin costo)
    expect(ene.countGanadas).toBe(2);
    expect(ene.countSinCosto).toBe(1);
    expect(ene.coberturaPct).toBeCloseTo((12000 / 17000) * 100, 1); // 70.6%
    // Margen % calculado sobre proyectos con costo: (12000 - 7000) / 12000 = 41.7%
    expect(ene.margenPct).toBe(41.7);

    // Febrero: subtotal oppFeb (8000 - 1000 = 7000), costo (4800 - 600 = 4200)
    const feb = evo.months.find(m => m.key === '2026-02');
    expect(feb).toBeDefined();
    expect(feb.ventas).toBe(7000);
    expect(feb.costos).toBe(4200);
    expect(feb.margen).toBe(2800);
    expect(feb.margenPct).toBe(40);
    expect(feb.coberturaPct).toBe(100);

    // Mes sin datos: Marzo
    const mar = evo.months.find(m => m.key === '2026-03');
    expect(mar).toBeDefined();
    expect(mar.ventas).toBe(0);
    expect(mar.costos).toBe(0);
    expect(mar.margen).toBe(0);
    expect(mar.margenPct).toBe(0);
    expect(mar.hasData).toBe(false);

    // Reconciliación matemática exacta con los KPI de calculateWonMetrics
    expect(evo.totalVentas).toBe(wonMetrics.totalPrecio);
    expect(evo.totalCostos).toBe(wonMetrics.totalCosto);
    expect(evo.totalMargen).toBe(wonMetrics.margen);
    expect(evo.totalCountGanadas).toBe(wonMetrics.countTotal);
  });

  // ==========================================================================
  // 19. FASE 3: Evolución Mensual - Comportamiento de Filtros e Histórico
  // ==========================================================================
  test('19. Evolución mensual: coherencia entre filtro anual, mes e histórico sin duplicar cierres', () => {
    const opp2025 = {
      id: 'OPP-2025',
      estado: 'ganado',
      fecha_cierre: '2025-11-20T12:00:00Z',
      precio_cotizado: 15000,
      costo_venta: 9000
    };
    const opp2026 = {
      id: 'OPP-2026',
      estado: 'ganado',
      fecha_cierre: '2026-05-10T12:00:00Z',
      precio_cotizado: 25000,
      costo_venta: 15000
    };

    // Caso A: Histórico completo (all)
    const evoHist = CrmDashboardCalc.calculateMonthlyEvolution([opp2025, opp2026], { filter: 'all', isHistorical: true });
    // Debe abarcar desde 2025 hasta 2026 (24 meses)
    expect(evoHist.months.length).toBeGreaterThanOrEqual(24);
    expect(evoHist.totalVentas).toBe(40000);
    expect(evoHist.totalCostos).toBe(24000);
    expect(evoHist.totalMargen).toBe(16000);

    // Caso B: Filtro solo año 2026
    const evo2026 = CrmDashboardCalc.calculateMonthlyEvolution([opp2026], { filter: 'year_2026', targetYear: 2026, isYearOnly: true });
    expect(evo2026.months).toHaveLength(12);
    expect(evo2026.totalVentas).toBe(25000);
    expect(evo2026.totalCostos).toBe(15000);
  });

  // ==========================================================================
  // 20. FASE 3: Rendimiento Integral por Vendedor
  // ==========================================================================
  test('20. Rendimiento por vendedor: separa período de cartera viva, calcula win rate y cobertura', () => {
    const users = [
      { id: '101', nombre: 'Carlos Vendedor', role: 'vendedor', activo: true },
      { id: '102', nombre: 'Ana Gestora', role: 'gestor', activo: true }
    ];

    const wonList = [
      { id: 'W-1', estado: 'ganado', vendedorId: '101', precio_cotizado: 10000, costo_venta: 6000 },
      { id: 'W-2', estado: 'ganado', vendedorId: '101', precio_cotizado: 4000, costo_venta: null }, // Sin costo
      { id: 'W-3', estado: 'ganado', vendedorId: '102', precio_cotizado: 20000, costo_venta: 12000 }
    ];

    const lostList = [
      { id: 'L-1', estado: 'perdido', vendedorId: '101', precio_cotizado: 5000 },
      { id: 'L-2', estado: 'perdido', vendedorId: '102', precio_cotizado: 8000 }
    ];

    const activeList = [
      { id: 'A-1', estado: 'activo', vendedorId: '101', precio_cotizado: 15000, probabilidad: 50 },
      { id: 'A-2', estado: 'activo', vendedorId: '102', precio_cotizado: 30000, probabilidad: 20 },
      { id: 'A-3', estado: 'activo', vendedorId: '102', precio_cotizado: 10000, probabilidad: null } // Sin prob
    ];

    const perf = CrmDashboardCalc.calculateSellerPerformance(wonList, lostList, activeList, users);
    expect(perf.sellers).toHaveLength(2);

    // Vendedor Ana (Mayor facturación cerrada: 20000)
    const ana = perf.sellers.find(s => s.sellerId === '102');
    expect(ana).toBeDefined();
    expect(ana.ventasGanadas).toBe(20000);
    expect(ana.costoGanadas).toBe(12000);
    expect(ana.margen).toBe(8000);
    expect(ana.margenPct).toBe(40);
    expect(ana.coberturaPct).toBe(100);
    expect(ana.countGanadas).toBe(1);
    expect(ana.countPerdidas).toBe(1);
    expect(ana.concluidas).toBe(2);
    expect(ana.winRate).toBe(50); // 1 / 2 = 50%
    expect(ana.winRateFormatted).toBe('50.0% (1/2)');
    expect(ana.pipelineNominal).toBe(40000);
    expect(ana.pipelinePonderado).toBe(6000); // 30000 * 0.2 + 0

    // Vendedor Carlos (14000 ganadas, cobertura incompleta)
    const carlos = perf.sellers.find(s => s.sellerId === '101');
    expect(carlos).toBeDefined();
    expect(carlos.ventasGanadas).toBe(14000);
    expect(carlos.precioConCosto).toBe(10000);
    expect(carlos.costoGanadas).toBe(6000);
    expect(carlos.margen).toBe(4000); // 10000 - 6000 (excluye la venta de 4000 sin costo)
    // Cobertura: 10000 con costo / 14000 total = 71.4%
    expect(carlos.coberturaPct).toBe(71.4);
    // Margen sobre base con costo: (10000 - 6000) / 10000 = 40%
    expect(carlos.margenPct).toBe(40);
    expect(carlos.countGanadas).toBe(2);
    expect(carlos.countPerdidas).toBe(1);
    expect(carlos.concluidas).toBe(3);
    expect(carlos.winRate).toBe(66.7); // 2 / 3 = 66.7%
    expect(carlos.winRateFormatted).toBe('66.7% (2/3)');
    expect(carlos.pipelineNominal).toBe(15000);
    expect(carlos.pipelinePonderado).toBe(7500); // 15000 * 0.5
  });

  // ==========================================================================
  // 21. FASE 3: Distribución Actual del Pipeline por Etapa
  // ==========================================================================
  test('21. Distribución del pipeline: desglosa oportunidades activas por etapa con alertas y ponderación', () => {
    const activeList = [
      { id: 'A-P1', estado: 'activo', etapa: 'prospecto', precio_cotizado: 5000, probabilidad: 10 },
      { id: 'A-P2', estado: 'activo', etapa: 'prospecto', precio_cotizado: 3000, probabilidad: null },
      { id: 'A-C1', estado: 'activo', etapa: 'cotizacion', precio_cotizado: 20000, probabilidad: 50 },
      { id: 'A-N1', estado: 'activo', etapa: 'negociacion', precio_cotizado: 40000, probabilidad: 80 }
    ];

    const dist = CrmDashboardCalc.calculatePipelineStageDistribution(activeList);
    expect(dist.stages).toHaveLength(5); // 5 etapas del CRM

    // Etapa Prospecto: 2 ops, nominal 8000, ponderado 500 (5000*0.1), 1 sin prob (3000)
    const pStage = dist.stages.find(s => s.stage === 'prospecto');
    expect(pStage.count).toBe(2);
    expect(pStage.montoNominal).toBe(8000);
    expect(pStage.montoPonderado).toBe(500);
    expect(pStage.countSinProb).toBe(1);
    expect(pStage.montoSinProb).toBe(3000);

    // Etapa Cotización: 1 op, nominal 20000, ponderado 10000
    const cStage = dist.stages.find(s => s.stage === 'cotizacion');
    expect(cStage.count).toBe(1);
    expect(cStage.montoNominal).toBe(20000);
    expect(cStage.montoPonderado).toBe(10000);

    // Total consolidado
    expect(dist.totalOps).toBe(4);
    expect(dist.totalNominal).toBe(68000);
    expect(dist.totalPonderado).toBe(42500); // 500 + 10000 + 32000
  });

  // ==========================================================================
  // 22. FASE 3: Integridad de marcado HTML y elementos del Centro de Mando
  // ==========================================================================
  test('22. Integridad de marcado: index.html contiene todos los elementos y contenedores de Fase 3', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

    // Elementos de la Gráfica Prioritaria: Evolución Mensual
    expect(html).toContain('id="monthlyEvolutionChart"');
    expect(html).toContain('id="monthly-evolution-empty"');
    expect(html).toContain('id="dash-monthly-coverage-badge"');
    expect(html).toContain('id="dash-monthly-summary"');

    // Elementos de la Tercera Visualización: Rendimiento por Vendedor
    expect(html).toContain('id="sellerChart"');
    expect(html).toContain('id="seller-empty-container"');
    expect(html).toContain('id="dash-seller-coverage-badge"');

    // Elementos del Embudo y Canal
    expect(html).toContain('id="css-funnel-container"');
    expect(html).toContain('id="conversionChart"');

    // Elementos de Composición y Pérdidas
    expect(html).toContain('id="lossChart"');
    expect(html).toContain('id="loss-empty-container"');
    expect(html).toContain('id="productChart"');
    expect(html).toContain('id="projectChart"');
    expect(html).toContain('id="oppProductChart"');
    expect(html).toContain('id="oppProjectChart"');

    // Inclusión canónica del script de cálculo
    expect(html).toMatch(/<script src="crm_dashboard_calc\.js(\?v=\d+)?"><\/script>/);
  });

  // ==========================================================================
  // 23. FASE 3: Responsive móvil del dashboard y aislamiento de tabla de estancamiento
  // ==========================================================================
  test('23. Responsive móvil: estructura de tabla estancada y aislamiento de estado vacío en index.html y styles.css', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');

    // Estructura desacoplada en index.html
    expect(html).toContain('id="dash-stagnant-empty-box"');
    expect(html).toContain('id="dash-stagnant-table-wrapper"');
    expect(html).toContain('class="dash-mobile-scroll-hint"');
    expect(html).toContain('dash-stagnant-card');

    // Reglas responsive en styles.css
    expect(css).toContain('.dash-table-scroll-container');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('-webkit-overflow-scrolling: touch');
    expect(css).toContain('.dash-mobile-scroll-hint');
    expect(css).toContain('@media (max-width: 430px)');
    expect(css).toContain('@media (max-width: 640px)');
  });

  // ==========================================================================
  // 24. FASE 3: Conciliación matemática integral del Dataset Sintético
  // ==========================================================================
  test('24. Dataset sintético Fase 3: conciliación matemática exacta en flujo, stock, vendedores y CxC', () => {
    const { PROSPECTS: synProspects, SELLERS: synSellers } = require('../scripts/seedSyntheticDashboardF3');

    // 1. Filtrado temporal YTD 2026
    const filter2026 = CrmDashboardCalc.filterProspects(synProspects, 'year_2026');
    expect(filter2026.flujoGanadas.length).toBe(4);
    expect(filter2026.flujoPerdidas.length).toBe(1); // LOST_1 entra en 2026; LOST_2 (sin fecha) queda excluida de 2026
    expect(filter2026.stockActivo.length).toBe(5);

    // 2. Métricas de Ventas Ganadas YTD 2026
    const won2026 = CrmDashboardCalc.calculateWonMetrics(filter2026.flujoGanadas);
    expect(won2026.totalPrecio).toBe(80000); // 20k + 20k + 25k + 15k
    expect(won2026.precioWithCost).toBe(65000); // Ventas con costo conocido (excluye WON_4)
    expect(won2026.totalCosto).toBe(39000);  // 12k + 12k + 15k
    expect(won2026.margen).toBe(26000);     // Margen bruto conocido: 65000 - 39000 (NO 41000!)
    expect(won2026.countTotal).toBe(4);
    expect(won2026.countWithCost).toBe(3);
    expect(won2026.countWithoutCost).toBe(1); // WON_4 sin costo
    expect(won2026.isCostComplete).toBe(false);
    expect(won2026.margenPct).toBeCloseTo(40.0, 1); // Margen conocido sobre 65k de venta con costo
    expect(won2026.coberturaPct).toBeCloseTo(81.3, 1); // 65000 / 80000 = 81.25%

    // 3. Ventas Perdidas YTD 2026 y Tasa de Cierre
    const lost2026 = CrmDashboardCalc.calculateLostMetrics(filter2026.flujoPerdidas);
    expect(lost2026.totalPrecio).toBe(18000);
    expect(lost2026.count).toBe(1);

    const concluidas2026 = won2026.countTotal + lost2026.count;
    expect(concluidas2026).toBe(5);
    const winRate2026 = (won2026.countTotal / concluidas2026) * 100;
    expect(winRate2026).toBe(80.0); // 4 ganadas / 5 concluidas = 80%

    // 4. Filtrado temporal Histórico Completo ('all')
    const filterAll = CrmDashboardCalc.filterProspects(synProspects, 'all');
    expect(filterAll.flujoGanadas.length).toBe(5); // Incluye WON_5 (2025)
    expect(filterAll.flujoPerdidas.length).toBe(2); // Incluye LOST_1 y LOST_2
    const wonAll = CrmDashboardCalc.calculateWonMetrics(filterAll.flujoGanadas);
    expect(wonAll.totalPrecio).toBe(105000); // 80k + 25k
    expect(wonAll.precioWithCost).toBe(90000); // Excluye WON_4
    expect(wonAll.totalCosto).toBe(54000);   // 39k + 15k
    expect(wonAll.margen).toBe(36000);       // Margen bruto conocido: 90000 - 54000 (NO 51000!)
    expect(wonAll.countTotal).toBe(5);
    expect(wonAll.countWithCost).toBe(4);
    expect(wonAll.countWithoutCost).toBe(1);
    expect(wonAll.margenPct).toBeCloseTo(40.0, 1);
    expect(wonAll.coberturaPct).toBeCloseTo(85.7, 1);

    // 5. Stock Activo y Pipeline Ponderado
    const pipeline = CrmDashboardCalc.calculateActivePipelineMetrics(filter2026.stockActivo);
    expect(pipeline.totalNominal).toBe(100000); // 10k + 20k + 30k + 25k + 15k
    expect(pipeline.totalPonderado).toBe(47000); // 2k + 10k + 15k + 20k + 0
    expect(pipeline.costoPonderado).toBe(28200); // 1.2k + 6k + 9k + 12k
    expect(pipeline.margenPonderado).toBe(18800);
    expect(pipeline.margenPonderadoPct).toBeCloseTo(40.0, 1);
    expect(pipeline.countTotal).toBe(5);
    expect(pipeline.countPonderadas).toBe(4);
    expect(pipeline.countSinProbabilidad).toBe(1); // ACT_5 sin prob
    expect(pipeline.montoSinProbabilidad).toBe(15000);

    // 6. Alerta de Estancamiento
    const refDate = new Date('2026-10-22T12:00:00.000Z');
    const stagnant = CrmDashboardCalc.calculateActiveWipTimes(filter2026.stockActivo, null, refDate);
    expect(stagnant.totalActive).toBe(5);
    expect(stagnant.totalOverLimit).toBe(1);
    expect(stagnant.overLimitItems[0].id).toBe('TEST_DASHBOARD_F3_ACT_3');
    expect(stagnant.overLimitItems[0].isOverLimit).toBe(true);
    expect(stagnant.overLimitItems[0].days).toBe(17);

    // 7. Cuentas por Cobrar (CxC)
    const cxc = CrmDashboardCalc.calculateCxCMetrics(synProspects);
    expect(cxc.totalFacturado).toBe(62150); // 11300 + 22600 + 28250
    expect(cxc.totalCobrado).toBe(21300);   // 11300 + 10000
    expect(cxc.totalCxC).toBe(40850);
    expect(cxc.pctCobrado).toBeCloseTo(34.27, 1);
    expect(cxc.facturasCount).toBe(3);
    expect(cxc.pagosCount).toBe(2);

    // 8. Rendimiento por Vendedor (YTD 2026)
    const sellerPerf = CrmDashboardCalc.calculateSellerPerformance(
      filter2026.flujoGanadas,
      filter2026.flujoPerdidas,
      filter2026.stockActivo,
      synSellers
    );

    // Carlos Mendoza
    const cm = sellerPerf.sellers.find(s => s.sellerId === 'TEST_DASHBOARD_F3_VEN_1');
    expect(cm).toBeDefined();
    expect(cm.ventasGanadas).toBe(45000);
    expect(cm.precioConCosto).toBe(45000);
    expect(cm.costoGanadas).toBe(27000);
    expect(cm.margen).toBe(18000);
    expect(cm.margenPct).toBeCloseTo(40.0, 1);
    expect(cm.coberturaPct).toBe(100);
    expect(cm.winRate).toBe(100); // 2 ganadas / 2 concluidas
    expect(cm.pipelineNominal).toBe(40000); // ACT_1 (10k) + ACT_3 (30k)
    expect(cm.pipelinePonderado).toBe(17000); // 2k + 15k

    // Ana Morales
    const am = sellerPerf.sellers.find(s => s.sellerId === 'TEST_DASHBOARD_F3_VEN_2');
    expect(am).toBeDefined();
    expect(am.ventasGanadas).toBe(20000);
    expect(am.precioConCosto).toBe(20000);
    expect(am.costoGanadas).toBe(12000);
    expect(am.margen).toBe(8000);
    expect(am.margenPct).toBeCloseTo(40.0, 1);
    expect(am.coberturaPct).toBe(100);
    expect(am.winRate).toBe(50); // 1 ganada / 2 concluidas (1 ganada + 1 perdida)
    expect(am.pipelineNominal).toBe(35000); // ACT_2 (20k) + ACT_5 (15k)
    expect(am.pipelinePonderado).toBe(10000); // 10k + 0

    // Roberto Flores
    const rf = sellerPerf.sellers.find(s => s.sellerId === 'TEST_DASHBOARD_F3_VEN_3');
    expect(rf).toBeDefined();
    expect(rf.ventasGanadas).toBe(15000);
    expect(rf.precioConCosto).toBe(0);
    expect(rf.costoGanadas).toBe(0);
    expect(rf.margen).toBe(0); // Sin costo conocido -> margen bruto 0
    expect(rf.countSinCosto).toBe(1);
    expect(rf.coberturaPct).toBe(0);
    expect(rf.margenPct).toBeNull(); // Costo no registrado -> no atribuir 100%
    expect(rf.winRate).toBe(100); // 1 ganada / 1 concluida (LOST_2 sin fecha no entra en YTD)
    expect(rf.pipelineNominal).toBe(25000); // ACT_4 (25k)
    expect(rf.pipelinePonderado).toBe(20000); // 20k

    // Reconciliación entre suma de vendedores y KPI global
    const totalMargenVendedores = sellerPerf.sellers.reduce((acc, s) => acc + s.margen, 0);
    expect(totalMargenVendedores).toBe(won2026.margen); // 18000 + 8000 + 0 = 26000
  });

  // ==========================================================================
  // 25. Margen comercial: operaciones sin costo no incrementan el margen conocido
  // ==========================================================================
  test('25. Margen comercial: operaciones sin costo no incrementan el margen conocido en KPI, meses ni vendedores', () => {
    // Escenario con órdenes de cambio, costos ausentes, costos válidos y cobertura parcial
    const oppA = { id: 'A', estado: 'ganado', precio_cotizado: 10000, costo_venta: 6000, fecha_cierre: '2026-05-10T10:00:00Z', vendedorId: 'V1' };
    const oppB = {
      id: 'B',
      estado: 'ganado',
      precio_cotizado: 10000,
      costo_venta: 6000,
      fecha_cierre: '2026-05-15T10:00:00Z',
      vendedorId: 'V1',
      ordenes_cambio: [
        { tipo: 'aumento', precio: 2000, costo: 1000 },
        { tipo: 'disminucion', precio: 1000, costo: 500 }
      ]
    };
    const oppC = { id: 'C', estado: 'ganado', precio_cotizado: 20000, costo_venta: null, fecha_cierre: '2026-05-20T10:00:00Z', vendedorId: 'V2' };

    // 1. KPI Global
    const wonMetrics = CrmDashboardCalc.calculateWonMetrics([oppA, oppB, oppC]);
    expect(wonMetrics.totalPrecio).toBe(41000); // 10k + 11k + 20k
    expect(wonMetrics.precioWithCost).toBe(21000); // 10k + 11k (excluye oppC de 20k)
    expect(wonMetrics.totalCosto).toBe(12500); // 6k + 6.5k
    // El margen conocido debe ser exactamente 21000 - 12500 = 8500 (NO 41000 - 12500 = 28500!)
    expect(wonMetrics.margen).toBe(8500);
    expect(wonMetrics.margenPct).toBeCloseTo((8500 / 21000) * 100, 1); // 40.5%
    expect(wonMetrics.coberturaPct).toBeCloseTo((21000 / 41000) * 100, 1); // 51.2%
    expect(wonMetrics.countTotal).toBe(3);
    expect(wonMetrics.countWithCost).toBe(2);
    expect(wonMetrics.countWithoutCost).toBe(1);

    // 2. Evolución mensual para Mayo 2026
    const evo = CrmDashboardCalc.calculateMonthlyEvolution([oppA, oppB, oppC], { filter: 'year_2026', targetYear: 2026, isYearOnly: true });
    const may = evo.months.find(m => m.key === '2026-05');
    expect(may.ventas).toBe(41000);
    expect(may.precioConCosto).toBe(21000);
    expect(may.costos).toBe(12500);
    // Margen mensual conocido: 21000 - 12500 = 8500 (NO 41000 - 12500 = 28500)
    expect(may.margen).toBe(8500);
    expect(may.margenPct).toBeCloseTo(40.5, 1);
    expect(may.coberturaPct).toBeCloseTo(51.2, 1);
    expect(evo.totalMargen).toBe(8500);

    // 3. Rendimiento por Vendedor
    const perf = CrmDashboardCalc.calculateSellerPerformance([oppA, oppB, oppC], [], [], [
      { id: 'V1', nombre: 'Vendedor 1', role: 'vendedor' },
      { id: 'V2', nombre: 'Vendedor 2', role: 'vendedor' }
    ]);
    const v1 = perf.sellers.find(s => s.sellerId === 'V1');
    expect(v1.ventasGanadas).toBe(21000);
    expect(v1.precioConCosto).toBe(21000);
    expect(v1.margen).toBe(8500);
    expect(v1.coberturaPct).toBe(100);

    const v2 = perf.sellers.find(s => s.sellerId === 'V2');
    expect(v2.ventasGanadas).toBe(20000);
    expect(v2.precioConCosto).toBe(0);
    // V2 no tiene costo -> margen conocido 0, margenPct null, cobertura 0%
    expect(v2.margen).toBe(0);
    expect(v2.margenPct).toBeNull();
    expect(v2.coberturaPct).toBe(0);
  });

  // ==========================================================================
  // 26. FASE 3: Responsive móvil del Embudo de Ventas y Canal de Origen
  // ==========================================================================
  test('26. Responsive móvil: estructura y estilos del Embudo y Canal de Origen en index.html, styles.css y app_core.js', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../app_core.js'), 'utf8');

    // index.html: contenedores responsivos
    expect(html).toContain('id="conversion-chart-container"');
    expect(html).toContain('id="conversion-canvas-container"');
    expect(html).toContain('class="dash-funnel-channel-grid"');

    // styles.css: reglas y breakpoints para embudo y canal
    expect(css).toContain('.dash-funnel-channel-grid');
    expect(css).toContain('#conversion-canvas-container');
    expect(css).toContain('.dash-funnel-row');
    expect(css).toContain('.dash-funnel-label');
    expect(css).toContain('.dash-funnel-bar-container');
    expect(css).toContain('.dash-funnel-bar');
    expect(css).toContain('.dash-funnel-val');
    expect(css).toContain('.dash-funnel-subval');
    expect(css).toContain('.dash-funnel-note');
    expect(css).toContain('@media (max-width: 430px)');
    expect(css).toContain('@media (max-width: 360px)');

    // app_core.js: generación de clases semánticas y lógica móvil de Chart.js
    expect(js).toContain('dash-funnel-row');
    expect(js).toContain('dash-funnel-label');
    expect(js).toContain('dash-funnel-bar');
    expect(js).toContain('isMobileScreen');
  });

  // ==========================================================================
  // 27. RENDIMIENTO COMERCIAL POR VENDEDORES Y GESTORES (CARTERAS INDEPENDIENTES)
  // ==========================================================================
  test('27. Rendimiento comercial por vendedores y gestores: carteras independientes, aislamiento cruzado, costos parciales y conciliación exacta sin duplicados', () => {
    // 1. Directorio de usuarios: 2 vendedores, 2 gestores, 1 gerente administrativo
    const userDirectory = [
      { id: 'VEN_101', nombre: 'Carlos Vendedor', role: 'vendedor', email: 'carlos@ductsal.com', activo: true },
      { id: 'VEN_102', nombre: 'Alejandra Vendedora', role: 'vendedor', email: 'alejandra@ductsal.com', activo: true },
      { id: 'GES_201', nombre: 'Denys Gestor', role: 'gestor', email: 'denys@ductsal.com', activo: true },
      { id: 'GES_202', nombre: 'Laura Gestora', role: 'gestor', email: 'laura@ductsal.com', activo: true },
      { id: 'MGR_301', nombre: 'Benjamín Gerente', role: 'manager', email: 'benjamin@ductsal.com', activo: true }
    ];

    // 2. Operaciones Ganadas (con y sin costo, asignaciones directas, cruzadas y ambiguas)
    const wonList = [
      // Vendedor 1: 1 con costo ($20k / $12k), 1 sin costo ($10k / null)
      { id: 'W-V1-1', estado: 'ganado', vendedorId: 'VEN_101', precio_cotizado: 20000, costo_venta: 12000 },
      { id: 'W-V1-2', estado: 'ganado', vendedorId: 'VEN_101', precio_cotizado: 10000, costo_venta: null },

      // Vendedor 2: 1 con costo ($30k / $18k)
      { id: 'W-V2-1', estado: 'ganado', vendedorId: 'VEN_102', precio_cotizado: 30000, costo_venta: 18000 },

      // Gestor 1: 1 con costo ($40k / $24k)
      { id: 'W-G1-1', estado: 'ganado', vendedorId: 'GES_201', precio_cotizado: 40000, costo_venta: 24000 },

      // Gestor 2: 1 con costo ($25k / $15k), 1 sin costo ($5k / null)
      { id: 'W-G2-1', estado: 'ganado', vendedorId: 'GES_202', precio_cotizado: 25000, costo_venta: 15000 },
      { id: 'W-G2-2', estado: 'ganado', vendedorId: 'GES_202', precio_cotizado: 5000, costo_venta: null },

      // Operación Cruzada 1: Creada por Gestor 1 pero ASIGNADA a Vendedor 1 ($15k / $9k)
      // REGLA OBLIGATORIA: Debe pertenecer exclusivamente a Vendedor 1. Gestor 1 NO debe recibirla.
      { id: 'W-CROSS-1', estado: 'ganado', createdBy: 'GES_201', vendedorId: 'VEN_101', precio_cotizado: 15000, costo_venta: 9000 },

      // Operación Cruzada 2: Creada por Vendedor 1 pero ASIGNADA a Gestor 2 ($10k / $6k)
      // REGLA OBLIGATORIA: Debe pertenecer exclusivamente a Gestor 2. Vendedor 1 NO debe recibirla.
      { id: 'W-CROSS-2', estado: 'ganado', createdBy: 'VEN_101', vendedorId: 'GES_202', precio_cotizado: 10000, costo_venta: 6000 },

      // Operación sin vendedor asignado creada por Gerente Administrativo ($5k)
      // REGLA OBLIGATORIA: No inferir a vendedores ni gestores. Pertenece a Sin Asignar.
      { id: 'W-AMBIGUOUS', estado: 'ganado', createdBy: 'MGR_301', precio_cotizado: 5000, costo_venta: null }
    ];

    // 3. Operaciones Perdidas
    const lostList = [
      // Vendedor 1: 1 perdida ($5,000)
      { id: 'L-V1-1', estado: 'perdido', vendedorId: 'VEN_101', precio_cotizado: 5000 },

      // Vendedor 2: 1 perdida ($8,000)
      { id: 'L-V2-1', estado: 'perdido', vendedorId: 'VEN_102', precio_cotizado: 8000 },

      // Gestor 1: 1 perdida ($10,000)
      { id: 'L-G1-1', estado: 'perdido', vendedorId: 'GES_201', precio_cotizado: 10000 },

      // Gestor 2: 1 perdida referenciada por nombre sin vendedorId ($12,000)
      // REGLA OBLIGATORIA: Debe resolverse canónicamente a Gestor 2 sin duplicar
      { id: 'L-G2-1', estado: 'perdido', vendedor: 'Laura Gestora', precio_cotizado: 12000 }
    ];

    // 4. Operaciones Activas (Cartera Viva / Stock Actual)
    const activeList = [
      // Vendedor 1: 1 activa ($15,000 con prob 50% -> $7,500 ponderado)
      { id: 'A-V1-1', estado: 'activo', vendedorId: 'VEN_101', precio_cotizado: 15000, probabilidad: 50 },

      // Vendedor 2: 1 activa ($25,000 con prob 60% -> $15,000 ponderado)
      { id: 'A-V2-1', estado: 'activo', vendedorId: 'VEN_102', precio_cotizado: 25000, probabilidad: 60 },

      // Gestor 1: 1 activa creada por Gestor 1 sin vendedorId explícito ($35,000 con prob 40% -> $14,000)
      { id: 'A-G1-1', estado: 'activo', createdBy: 'GES_201', precio_cotizado: 35000, probabilidad: 40 },

      // Gestor 2: 1 activa ($20,000 con prob 70% -> $14,000 ponderado)
      { id: 'A-G2-1', estado: 'activo', vendedorId: 'GES_202', precio_cotizado: 20000, probabilidad: 70 }
    ];

    // Ejecutar cálculo canónico de rendimiento por vendedor y gestor
    const perf = CrmDashboardCalc.calculateSellerPerformance(wonList, lostList, activeList, userDirectory);

    // Deben existir los 4 comerciales activos más la entrada sin_asignar
    expect(perf.sellers.length).toBeGreaterThanOrEqual(4);

    const v1 = perf.sellers.find(s => s.sellerId === 'VEN_101');
    const v2 = perf.sellers.find(s => s.sellerId === 'VEN_102');
    const g1 = perf.sellers.find(s => s.sellerId === 'GES_201');
    const g2 = perf.sellers.find(s => s.sellerId === 'GES_202');
    const unassigned = perf.allSellersMap['sin_asignar'];

    // ------------------------------------------------------------------------
    // A. Comprobación de Perfiles y Distinción en Leyendas/Etiquetas
    // ------------------------------------------------------------------------
    expect(v1.role).toBe('vendedor');
    expect(v1.roleLabel).toBe('Vendedor');
    expect(v1.nombreConRol).toBe('Carlos Vendedor (Vendedor)');

    expect(v2.role).toBe('vendedor');
    expect(v2.roleLabel).toBe('Vendedor');
    expect(v2.nombreConRol).toBe('Alejandra Vendedora (Vendedor)');

    expect(g1.role).toBe('gestor');
    expect(g1.roleLabel).toBe('Gestor');
    expect(g1.nombreConRol).toBe('Denys Gestor (Gestor)');

    expect(g2.role).toBe('gestor');
    expect(g2.roleLabel).toBe('Gestor');
    expect(g2.nombreConRol).toBe('Laura Gestora (Gestor)');

    // ------------------------------------------------------------------------
    // B. Comprobación de Vendedor 1 (Carlos)
    // Ganadas: W-V1-1 (20k) + W-V1-2 (10k) + W-CROSS-1 (15k) = 45k
    // Con costo: 20k + 15k = 35k. Costo: 12k + 9k = 21k. Margen: 14k (40.0%)
    // Cobertura: (35k / 45k) * 100 = 77.8%
    // Concluidas: 3 ganadas + 1 perdida = 4. Win rate: 75.0%
    // ------------------------------------------------------------------------
    expect(v1.ventasGanadas).toBe(45000);
    expect(v1.precioConCosto).toBe(35000);
    expect(v1.costoGanadas).toBe(21000);
    expect(v1.margen).toBe(14000);
    expect(v1.margenPct).toBe(40.0);
    expect(v1.coberturaPct).toBe(77.8);
    expect(v1.countGanadas).toBe(3);
    expect(v1.countConCosto).toBe(2);
    expect(v1.countSinCosto).toBe(1);
    expect(v1.countPerdidas).toBe(1);
    expect(v1.montoPerdidas).toBe(5000);
    expect(v1.concluidas).toBe(4);
    expect(v1.winRate).toBe(75.0);
    expect(v1.winRateFormatted).toBe('75.0% (3/4)');
    expect(v1.pipelineNominal).toBe(15000);
    expect(v1.pipelinePonderado).toBe(7500);

    // ------------------------------------------------------------------------
    // C. Comprobación de Gestor 1 (Denys)
    // REGLA CRÍTICA: NO recibe W-CROSS-1 ($15,000) creada por él pero asignada a Vendedor 1
    // Ganadas: W-G1-1 (40k). Costo: 24k. Margen: 16k (40.0%). Cobertura: 100%
    // Concluidas: 1 ganada + 1 perdida = 2. Win rate: 50.0%
    // Cartera activa: A-G1-1 creada por él sin vendedor ($35k nominal, $14k pond)
    // ------------------------------------------------------------------------
    expect(g1.ventasGanadas).toBe(40000);
    expect(g1.precioConCosto).toBe(40000);
    expect(g1.costoGanadas).toBe(24000);
    expect(g1.margen).toBe(16000);
    expect(g1.margenPct).toBe(40.0);
    expect(g1.coberturaPct).toBe(100.0);
    expect(g1.countGanadas).toBe(1);
    expect(g1.countConCosto).toBe(1);
    expect(g1.countSinCosto).toBe(0);
    expect(g1.countPerdidas).toBe(1);
    expect(g1.montoPerdidas).toBe(10000);
    expect(g1.concluidas).toBe(2);
    expect(g1.winRate).toBe(50.0);
    expect(g1.winRateFormatted).toBe('50.0% (1/2)');
    expect(g1.pipelineNominal).toBe(35000);
    expect(g1.pipelinePonderado).toBe(14000);

    // ------------------------------------------------------------------------
    // D. Comprobación de Gestor 2 (Laura)
    // REGLA CRÍTICA: Recibe W-CROSS-2 ($10,000) asignada a ella por Vendedor 1
    // Resuelve L-G2-1 por nombre ('Laura Gestora') a su ID canónico GES_202
    // Ganadas: W-G2-1 (25k) + W-G2-2 (5k sin costo) + W-CROSS-2 (10k) = 40k
    // Con costo: 25k + 10k = 35k. Costo: 15k + 6k = 21k. Margen: 14k (40.0%)
    // Cobertura: (35k / 40k) * 100 = 87.5%
    // ------------------------------------------------------------------------
    expect(g2.ventasGanadas).toBe(40000);
    expect(g2.precioConCosto).toBe(35000);
    expect(g2.costoGanadas).toBe(21000);
    expect(g2.margen).toBe(14000);
    expect(g2.margenPct).toBe(40.0);
    expect(g2.coberturaPct).toBe(87.5);
    expect(g2.countGanadas).toBe(3);
    expect(g2.countPerdidas).toBe(1);
    expect(g2.montoPerdidas).toBe(12000);
    expect(g2.concluidas).toBe(4);
    expect(g2.winRate).toBe(75.0);
    expect(g2.pipelineNominal).toBe(20000);
    expect(g2.pipelinePonderado).toBe(14000);

    // ------------------------------------------------------------------------
    // E. Comprobación de No Inferencia sobre Perfiles Ambiguos / Gerente
    // La oportunidad W-AMBIGUOUS creada por Benjamín Gerente no fue asignada a nadie
    // Ningún vendedor ni gestor debe tenerla en sus números
    // ------------------------------------------------------------------------
    expect(unassigned).toBeDefined();
    expect(unassigned.ventasGanadas).toBe(5000);
    expect(unassigned.countGanadas).toBe(1);
    expect(unassigned.role).toBe('sin_asignar');

    // ------------------------------------------------------------------------
    // F. Conciliación Matemática Exacta del Consolidado (Sin Duplicados)
    // ------------------------------------------------------------------------
    const wonCompany = CrmDashboardCalc.calculateWonMetrics(wonList);
    const totalIndividualGanadas = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.ventasGanadas, 0);
    const totalIndividualPrecioConCosto = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.precioConCosto, 0);
    const totalIndividualCosto = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.costoGanadas, 0);
    const totalIndividualMargen = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.margen, 0);
    const totalIndividualGanadasCount = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.countGanadas, 0);

    expect(totalIndividualGanadas).toBe(wonCompany.totalPrecio); // $160,000 exactos
    expect(totalIndividualPrecioConCosto).toBe(wonCompany.precioWithCost); // $130,000 exactos
    expect(totalIndividualCosto).toBe(wonCompany.totalCosto); // $84,000 exactos
    expect(totalIndividualMargen).toBe(wonCompany.margen); // $46,000 exactos
    expect(totalIndividualGanadasCount).toBe(wonCompany.countTotal); // 8 operaciones

    const totalIndividualPerdidasCount = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.countPerdidas, 0);
    const totalIndividualPerdidasMonto = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.montoPerdidas, 0);
    expect(totalIndividualPerdidasCount).toBe(lostList.length); // 4 operaciones
    expect(totalIndividualPerdidasMonto).toBe(35000); // 5k + 8k + 10k + 12k

    const totalIndividualPipeline = Object.values(perf.allSellersMap).reduce((acc, s) => acc + s.pipelineNominal, 0);
    expect(totalIndividualPipeline).toBe(95000); // 15k + 25k + 35k + 20k
  });

  // ==========================================================================
  // 13. Filtro de Vendedores y Gestores: Solo Activos vs Histórico Completo
  // ==========================================================================
  describe('13. Filtro de Vendedores y Gestores: Solo Activos vs Histórico Completo', () => {
    const fs = require('fs');
    const path = require('path');

    // Fixture representativo del directorio de usuarios
    const userDirectory = [
      { id: '1776904494660', nombre: 'Denys González', email: 'dgonzalez@ductsal.com', role: 'vendedor', activo: true },
      { id: '1776904514932', nombre: 'Alejandra Ayala', email: 'aayala@ductsal.com', role: 'gestor', activo: true },
      { id: '1788471603604', nombre: 'Roberto Flores', email: 'rflores@ductsal.com', role: 'vendedor', activo: true },
      { id: '1784221928346', nombre: 'Gustavo Velásquez', email: 'gvelasquez@ductsal.com', role: 'vendedor', activo: false },
      { id: '1789999999999', nombre: 'Carlos Inactivo Gestor', email: 'cinactivo@ductsal.com', role: 'gestor', activo: false },
      { id: '1776895495203', nombre: 'Benjamín Valiente', email: 'bvaliente@grupogama.com', role: 'manager', activo: true },
      { id: '1790000000001', nombre: 'Vendedor Activo Sin Actividad', email: 'sinact@ductsal.com', role: 'vendedor', activo: true }
    ];

    test('1. Un vendedor activo con ventas aparece en ambas vistas', () => {
      const wonList = [
        { id: 'OPP-ACT-1', vendedorId: '1776904494660', estado: 'ganado', precio_cotizado: 25000, costo_venta: 15000 }
      ];
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      expect(perfActive.sellers.some(s => s.sellerId === '1776904494660')).toBe(true);
      expect(perfAll.sellers.some(s => s.sellerId === '1776904494660')).toBe(true);

      const sellerActive = perfActive.sellers.find(s => s.sellerId === '1776904494660');
      expect(sellerActive.nombre).toBe('Denys González');
      expect(sellerActive.isInactive).toBe(false);
      expect(sellerActive.ventasGanadas).toBe(25000);
      expect(sellerActive.nombreConRol).toBe('Denys González (Vendedor)');
    });

    test('2. Un vendedor inactivo con ventas históricas desaparece de «Solo activos» y aparece en «Histórico completo»', () => {
      const wonList = [
        { id: 'OPP-INACT-1', vendedorId: '1784221928346', estado: 'ganado', precio_cotizado: 45000, costo_venta: 27000 }
      ];
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      // En 'active_only' queda excluido de la lista de visualización
      expect(perfActive.sellers.some(s => s.sellerId === '1784221928346')).toBe(false);
      expect(perfActive.totalSellers).toBe(0);
      // Sus métricas quedan contabilizadas en excludedInactiveMetrics para aviso contextual
      expect(perfActive.excludedInactiveMetrics.countSellers).toBe(1);
      expect(perfActive.excludedInactiveMetrics.ventasGanadas).toBe(45000);
      expect(perfActive.excludedInactiveMetrics.costoGanadas).toBe(27000);
      expect(perfActive.excludedInactiveMetrics.margen).toBe(18000);

      // En 'all' aparece con etiqueta clara de Inactivo
      expect(perfAll.sellers.some(s => s.sellerId === '1784221928346')).toBe(true);
      const sellerInactive = perfAll.sellers.find(s => s.sellerId === '1784221928346');
      expect(sellerInactive.nombre).toBe('Gustavo Velásquez');
      expect(sellerInactive.isInactive).toBe(true);
      expect(sellerInactive.nombreConRol).toBe('Gustavo Velásquez (Vendedor - Inactivo)');
      expect(sellerInactive.ventasGanadas).toBe(45000);
    });

    test('3. El mismo comportamiento se cumple para los gestores activos e inactivos', () => {
      const wonList = [
        { id: 'OPP-GES-ACT', gestorId: '1776904514932', estado: 'ganado', precio_cotizado: 30000, costo_venta: 18000 },
        { id: 'OPP-GES-INACT', gestorId: '1789999999999', estado: 'ganado', precio_cotizado: 20000, costo_venta: 12000 }
      ];
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      // Gestora activa (Alejandra) aparece en ambas vistas
      expect(perfActive.sellers.some(s => s.sellerId === '1776904514932')).toBe(true);
      expect(perfAll.sellers.some(s => s.sellerId === '1776904514932')).toBe(true);
      const gestoraActiva = perfActive.sellers.find(s => s.sellerId === '1776904514932');
      expect(gestoraActiva.nombreConRol).toBe('Alejandra Ayala (Gestor)');
      expect(gestoraActiva.isInactive).toBe(false);

      // Gestor inactivo (Carlos) desaparece de 'active_only' y aparece en 'all'
      expect(perfActive.sellers.some(s => s.sellerId === '1789999999999')).toBe(false);
      expect(perfAll.sellers.some(s => s.sellerId === '1789999999999')).toBe(true);
      const gestorInactivo = perfAll.sellers.find(s => s.sellerId === '1789999999999');
      expect(gestorInactivo.nombre).toBe('Carlos Inactivo Gestor');
      expect(gestorInactivo.isInactive).toBe(true);
      expect(gestorInactivo.nombreConRol).toBe('Carlos Inactivo Gestor (Gestor - Inactivo)');
      expect(gestorInactivo.ventasGanadas).toBe(20000);
    });

    test('4. El estado actual se aplica igual al consultar Mes, YTD y períodos históricos sin inferencia temporal retroactiva', () => {
      // Oportunidad con fecha histórica (ej. 2024 cuando el colaborador trabajaba activamente)
      const historicalOpp = {
        id: 'OPP-HIST-2024',
        vendedorId: '1784221928346', // Gustavo (actualmente activo: false)
        estado: 'ganado',
        precio_cotizado: 60000,
        costo_venta: 36000,
        fecha_cierre: '2024-05-15'
      };

      // Oportunidad YTD / Mes actual para vendedor activo
      const currentOpp = {
        id: 'OPP-CURR-2026',
        vendedorId: '1776904494660', // Denys (activo: true)
        estado: 'ganado',
        precio_cotizado: 50000,
        costo_venta: 30000,
        fecha_cierre: '2026-10-10'
      };

      // Consulta en período histórico: el filtro evalúa el estado ACTUAL del usuario en userDirectory
      const perfHistoricalActive = CrmDashboardCalc.calculateSellerPerformance([historicalOpp], [], [], userDirectory, { filterMode: 'active_only' });
      const perfHistoricalAll = CrmDashboardCalc.calculateSellerPerformance([historicalOpp], [], [], userDirectory, { filterMode: 'all' });

      // En 'active_only' el usuario inactivo NO aparece, incluso en consulta de período 2024
      expect(perfHistoricalActive.sellers.some(s => s.sellerId === '1784221928346')).toBe(false);
      // En 'all' sí aparece con su atribución histórica completa
      expect(perfHistoricalAll.sellers.some(s => s.sellerId === '1784221928346')).toBe(true);

      // Consulta YTD con vendedor activo
      const perfYtdActive = CrmDashboardCalc.calculateSellerPerformance([currentOpp], [], [], userDirectory, { filterMode: 'active_only' });
      expect(perfYtdActive.sellers.some(s => s.sellerId === '1776904494660')).toBe(true);
    });

    test('5. Los nombres canónicos de usuarios inactivos se resuelven correctamente desde el directorio', () => {
      const wonList = [
        { id: 'OPP-RESOLVE-1', vendedorId: '1784221928346', estado: 'ganado', precio_cotizado: 15000, costo_venta: 9000 }
      ];
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });
      const gustavo = perfAll.sellers.find(s => s.sellerId === '1784221928346');

      expect(gustavo).toBeDefined();
      expect(gustavo.nombre).toBe('Gustavo Velásquez'); // Nombre canónico recuperado
      expect(gustavo.nombre).not.toContain('1784221928346'); // No cae en fallback crudo
      expect(gustavo.nombreConRol).toBe('Gustavo Velásquez (Vendedor - Inactivo)');
    });

    test('6. Una oportunidad abierta asignada a un comercial inactivo permanece en el pipeline consolidado y se muestra en histórico completo', () => {
      const activeList = [
        { id: 'OPP-OPEN-INACT', vendedorId: '1784221928346', estado: 'activo', precio_cotizado: 35000, probabilidad: 75 }
      ];

      // KPI corporativo del pipeline
      const stockConsolidated = CrmDashboardCalc.calculateActivePipelineMetrics(activeList);
      expect(stockConsolidated.totalNominal).toBe(35000);
      expect(stockConsolidated.totalPonderado).toBe(26250); // 75% de 35000

      // En 'active_only': no aparece en gráfica individual pero se captura en métricas excluidas
      const perfActive = CrmDashboardCalc.calculateSellerPerformance([], [], activeList, userDirectory, { filterMode: 'active_only' });
      expect(perfActive.sellers.length).toBe(0);
      expect(perfActive.excludedInactiveMetrics.pipelineNominal).toBe(35000);
      expect(perfActive.excludedInactiveMetrics.pipelinePonderado).toBe(26250);
      expect(perfActive.excludedInactiveMetrics.countActivas).toBe(1);

      // En 'all': aparece atribuida a Gustavo Velásquez con etiqueta Inactivo
      const perfAll = CrmDashboardCalc.calculateSellerPerformance([], [], activeList, userDirectory, { filterMode: 'all' });
      expect(perfAll.sellers.length).toBe(1);
      const gustavo = perfAll.sellers[0];
      expect(gustavo.nombre).toBe('Gustavo Velásquez');
      expect(gustavo.pipelineNominal).toBe(35000);
      expect(gustavo.pipelinePonderado).toBe(26250);
      expect(gustavo.countActivas).toBe(1);
    });

    test('7. Las oportunidades sin responsable identificable continúan atribuyéndose a «Sin Asignar»', () => {
      const wonList = [
        { id: 'OPP-UNASSIGNED-1', vendedorId: null, gestorId: undefined, estado: 'ganado', precio_cotizado: 18000, costo_venta: 10000 }
      ];
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      const unassignedActive = perfActive.sellers.find(s => s.sellerId === 'sin_asignar');
      const unassignedAll = perfAll.sellers.find(s => s.sellerId === 'sin_asignar');

      expect(unassignedActive).toBeDefined();
      expect(unassignedActive.nombre).toBe('Sin Asignar');
      expect(unassignedActive.role).toBe('sin_asignar');
      expect(unassignedActive.ventasGanadas).toBe(18000);

      expect(unassignedAll).toBeDefined();
      expect(unassignedAll.nombre).toBe('Sin Asignar');
      expect(unassignedAll.ventasGanadas).toBe(18000);
    });

    test('8. La atribución entre vendedores y gestores sigue siendo independiente (carteras separadas)', () => {
      const wonList = [
        // Oportunidad asignada a Vendedor (creada por gestora pero no usurpa)
        {
          id: 'OPP-VEN-1',
          vendedorId: '1776904494660', // Denys
          createdBy: '1776904514932',   // Alejandra
          estado: 'ganado',
          precio_cotizado: 30000,
          costo_venta: 18000
        },
        // Oportunidad asignada a Gestora (creada por vendedor pero no usurpa)
        {
          id: 'OPP-GES-1',
          gestorId: '1776904514932',    // Alejandra
          createdBy: '1776904494660',   // Denys
          estado: 'ganado',
          precio_cotizado: 20000,
          costo_venta: 12000
        },
        // Oportunidad creada por Gerente sin responsable asignado
        {
          id: 'OPP-MGR-1',
          createdBy: '1776895495203',   // Benjamín (gerente)
          estado: 'ganado',
          precio_cotizado: 10000,
          costo_venta: 6000
        }
      ];
      const perf = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });

      const denys = perf.sellers.find(s => s.sellerId === '1776904494660');
      const alejandra = perf.sellers.find(s => s.sellerId === '1776904514932');
      const benjamin = perf.sellers.find(s => s.sellerId === '1776895495203');
      const sinAsignar = perf.sellers.find(s => s.sellerId === 'sin_asignar');

      // Denys solo recibe OPP-VEN-1 ($30,000)
      expect(denys).toBeDefined();
      expect(denys.role).toBe('vendedor');
      expect(denys.ventasGanadas).toBe(30000);
      expect(denys.countGanadas).toBe(1);

      // Alejandra solo recibe OPP-GES-1 ($20,000)
      expect(alejandra).toBeDefined();
      expect(alejandra.role).toBe('gestor');
      expect(alejandra.ventasGanadas).toBe(20000);
      expect(alejandra.countGanadas).toBe(1);

      // Benjamín (createdBy) no recibe atribución comercial
      expect(benjamin).toBeUndefined();

      // OPP-MGR-1 se atribuye a Sin Asignar
      expect(sinAsignar).toBeDefined();
      expect(sinAsignar.ventasGanadas).toBe(10000);
    });

    test('9. Cambiar entre ambas vistas no altera ningún KPI consolidado de la empresa', () => {
      const wonList = [
        { id: 'W1', vendedorId: '1776904494660', estado: 'ganado', precio_cotizado: 40000, costo_venta: 25000 },
        { id: 'W2', vendedorId: '1784221928346', estado: 'ganado', precio_cotizado: 30000, costo_venta: 18000 }
      ];
      const lostList = [
        { id: 'L1', vendedorId: '1784221928346', estado: 'perdido', precio_cotizado: 10000 }
      ];
      const activeList = [
        { id: 'A1', vendedorId: '1788471603604', estado: 'activo', precio_cotizado: 20000, probabilidad: 50 }
      ];

      // KPIs consolidados corporativos
      const wonConsolidatedBefore = CrmDashboardCalc.calculateWonMetrics(wonList);
      const stockConsolidatedBefore = CrmDashboardCalc.calculateActivePipelineMetrics(activeList);
      const lossConsolidatedBefore = CrmDashboardCalc.calculateLostMetrics(lostList);

      // Ejecutar modo 'active_only'
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, lostList, activeList, userDirectory, { filterMode: 'active_only' });
      // Ejecutar modo 'all'
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, lostList, activeList, userDirectory, { filterMode: 'all' });

      // Recalcular KPIs corporativos
      const wonConsolidatedAfter = CrmDashboardCalc.calculateWonMetrics(wonList);
      const stockConsolidatedAfter = CrmDashboardCalc.calculateActivePipelineMetrics(activeList);
      const lossConsolidatedAfter = CrmDashboardCalc.calculateLostMetrics(lostList);

      expect(wonConsolidatedAfter).toEqual(wonConsolidatedBefore);
      expect(stockConsolidatedAfter).toEqual(stockConsolidatedBefore);
      expect(lossConsolidatedAfter).toEqual(lossConsolidatedBefore);

      expect(wonConsolidatedAfter.totalPrecio).toBe(70000);
      expect(wonConsolidatedAfter.margen).toBe(27000); // 70k - 43k
      expect(stockConsolidatedAfter.totalNominal).toBe(20000);
      expect(lossConsolidatedAfter.totalPrecio).toBe(10000);
      expect(lossConsolidatedAfter.count).toBe(1);
    });

    test('10. En «Histórico completo», la suma de las ventas ganadas individuales cuadra exactamente con el consolidado del mismo período, sin duplicaciones', () => {
      const wonList = [
        { id: 'W-V-ACT', vendedorId: '1776904494660', estado: 'ganado', precio_cotizado: 40000, costo_venta: 24000 },
        { id: 'W-V-INACT', vendedorId: '1784221928346', estado: 'ganado', precio_cotizado: 30000, costo_venta: 18000 },
        { id: 'W-UNASSIGNED', vendedorId: null, estado: 'ganado', precio_cotizado: 10000, costo_venta: 6000 }
      ];

      const wonCompany = CrmDashboardCalc.calculateWonMetrics(wonList);
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      const sumVentas = perfAll.sellers.reduce((acc, s) => acc + s.ventasGanadas, 0);
      const sumCostos = perfAll.sellers.reduce((acc, s) => acc + s.costoGanadas, 0);
      const sumMargen = perfAll.sellers.reduce((acc, s) => acc + s.margen, 0);
      const sumCount = perfAll.sellers.reduce((acc, s) => acc + s.countGanadas, 0);

      expect(sumVentas).toBe(wonCompany.totalPrecio); // 80,000
      expect(sumCostos).toBe(wonCompany.totalCosto); // 48,000
      expect(sumMargen).toBe(wonCompany.margen); // 32,000
      expect(sumCount).toBe(wonCompany.countTotal); // 3
      expect(wonCompany.totalPrecio).toBe(80000);
    });

    test('11. Los usuarios sin actividad comercial relevante no generan entradas innecesarias', () => {
      // Directorio incluye al usuario '1790000000001' (Vendedor Activo Sin Actividad)
      const wonList = [
        { id: 'W-1', vendedorId: '1776904494660', estado: 'ganado', precio_cotizado: 20000, costo_venta: 12000 }
      ];
      const perfActive = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'active_only' });
      const perfAll = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, { filterMode: 'all' });

      expect(perfActive.sellers.some(s => s.sellerId === '1790000000001')).toBe(false);
      expect(perfAll.sellers.some(s => s.sellerId === '1790000000001')).toBe(false);
    });

    test('12. La selección predeterminada es «Solo activos»', () => {
      const wonList = [
        { id: 'W-ACT', vendedorId: '1776904494660', estado: 'ganado', precio_cotizado: 20000, costo_venta: 12000 },
        { id: 'W-INACT', vendedorId: '1784221928346', estado: 'ganado', precio_cotizado: 15000, costo_venta: 9000 }
      ];

      // Llamada sin opciones: debe tomar por defecto 'active_only'
      const perfDefault = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory);
      expect(perfDefault.filterMode).toBe('active_only');
      expect(perfDefault.sellers.some(s => s.sellerId === '1784221928346')).toBe(false);
      expect(perfDefault.sellers.some(s => s.sellerId === '1776904494660')).toBe(true);

      // Llamada con objeto vacío: también 'active_only'
      const perfEmptyObj = CrmDashboardCalc.calculateSellerPerformance(wonList, [], [], userDirectory, {});
      expect(perfEmptyObj.filterMode).toBe('active_only');
    });

    test('13. Los botones y elementos UI reflejan la opción seleccionada y cuentan con soporte responsive', () => {
      const htmlPath = path.resolve(__dirname, '../../index.html');
      const cssPath = path.resolve(__dirname, '../../styles.css');
      const html = fs.readFileSync(htmlPath, 'utf8');
      const css = fs.readFileSync(cssPath, 'utf8');

      // Comprobar elementos requeridos en index.html
      expect(html).toContain('id="btn-seller-filter-active"');
      expect(html).toContain('id="btn-seller-filter-all"');
      expect(html).toContain('id="dash-seller-inactive-notice"');
      expect(html).toContain('id="dash-seller-inactive-notice-text"');
      expect(html).toContain('id="seller-empty-text"');

      // Comprobar estado inicial predeterminado: Solo Activos tiene clase 'active'
      expect(html).toMatch(/id="btn-seller-filter-active"[^>]*class="[^"]*active[^"]*"/);
      expect(html).not.toMatch(/id="btn-seller-filter-all"[^>]*class="[^"]*active[^"]*"/);

      // Comprobar handlers de alternancia
      expect(html).toContain("onclick=\"setSellerFilterMode('active_only')\"");
      expect(html).toContain("onclick=\"setSellerFilterMode('all')\"");

      // Comprobar reglas CSS para el selector y aviso
      expect(css).toContain('.dash-seller-switch');
      expect(css).toContain('.dash-seller-inactive-notice');
      expect(css).toContain('@media (max-width: 640px)');
    });
  });
});
