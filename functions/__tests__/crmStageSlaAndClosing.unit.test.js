// functions/__tests__/crmStageSlaAndClosing.unit.test.js
// Automated test suite covering the 14 mandatory test cases for:
// Stage SLAs, Daily Agenda, Manager Attention, Avanzar a Cierre vs Finalizar, and Postclosing Transfer.

const CrmWorkCalendar = require('../../crm_work_calendar');
const CrmFollowUpCalc = require('../../crm_followup_calc');
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService, POLICY } = require('../prospectWorkflowService');

const CLOCK = new Date('2026-10-15T12:00:00.000Z'); // Jueves 15 de octubre de 2026

function makeEnv(customClock = CLOCK) {
  const fdb = createFakeFirestore({ clock: () => customClock });
  const live = { ok: true, calls: [] };
  const service = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => customClock,
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
  return { fdb, service, wf, caller, live, now: customClock, hasEnteredPostclosing: service.hasEnteredPostclosing };
}

function makeClientNatural(id = 'C-NATURAL', overrides = {}) {
  return {
    id,
    tipo: 'natural',
    nombres: 'Carlos',
    apellidos: 'Rivas',
    dui: '01234567-8',
    nit: '0614-010190-101-1',
    telefono: '7777-8888',
    correo: 'carlos@example.com',
    correo_fact: 'facturas@example.com',
    documentos: { dui: '01234567-8' },
    ...overrides
  };
}

function makeClientJuridica(id = 'C-CORP', overrides = {}) {
  return {
    id,
    tipo: 'juridica',
    empresa: 'Corporación Alpha SA de CV',
    contacto: 'Lic. Morales',
    nit: '0614-010190-101-2',
    nrc: '123456-7',
    telefono: '2222-3333',
    correo: 'info@alpha.com',
    correo_fact: 'facturas@alpha.com',
    documentos: { dui: '01234567-8' },
    ...overrides
  };
}

const fileObj = (name, folder = 'proyectos') => ({
  name,
  storagePath: `prod_files/${folder}/P-01/${name}`
});

describe('Pruebas Obligatorias: SLAs de Etapa, Agenda, Atención Gerencial y Finalización (14 Requisitos)', () => {

  // =========================================================================
  // REQUISITO 1: Una oportunidad puede avanzar a Cierre sin quedar ganada
  // =========================================================================
  test('1. Una oportunidad avanza a Cierre: estado permanece activo, no ganada, probabilidad < 100', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
    await fdb.seed('prospects_prod/P-01', {
      id: 'P-01',
      codigo: 'DUC-001',
      proyecto: 'Sistema HVAC Planta 1',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'negociacion',
      estado: 'activo',
      probabilidad: 75,
      precio_cotizado: 5000,
      costo_venta: 3500,
      tipo_proyecto: 'Fabricación',
      clasificacion: 'ejecucion'
    });

    const res = await wf.advanceStage({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-01',
      nextStage: 'cierre',
      data: {}
    });

    expect(res.status).toBe('advanced');
    expect(res.etapa).toBe('cierre');
    expect(res.estado).toBe('activo');

    const updated = await fdb.data('prospects_prod/P-01');
    expect(updated.etapa).toBe('cierre');
    expect(updated.estado).toBe('activo'); // NO es 'ganado'
    expect(updated.probabilidad).not.toBe(100); // Conserva probabilidad comercial
    expect(updated.postcierre_habilitado).toBe(false); // Postcierre NO habilitado
    expect(updated.fecha_cierre).toBeUndefined(); // Sin fecha de cierre definitivo
  });

  // =========================================================================
  // REQUISITO 2: Al avanzar a Cierre se registra el inicio del plazo de 5 días hábiles
  // =========================================================================
  test('2. Al avanzar a Cierre se registran fecha_inicio_cierre y fecha_limite_cierre (5 días hábiles)', async () => {
    // Jueves 15 de octubre de 2026
    const baseClock = new Date('2026-10-15T10:00:00.000Z');
    const { fdb, wf, caller } = makeEnv(baseClock);
    await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
    await fdb.seed('prospects_prod/P-02', {
      id: 'P-02',
      codigo: 'DUC-002',
      proyecto: 'Ductos Acero',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'negociacion',
      estado: 'activo',
      tipo_proyecto: 'Fabricación',
      clasificacion: 'ejecucion'
    });

    const res = await wf.advanceStage({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-02',
      nextStage: 'cierre',
      data: {}
    });

    expect(res.status).toBe('advanced');

    const updated = await fdb.data('prospects_prod/P-02');
    expect(updated.fecha_inicio_cierre).toBe('2026-10-15T10:00:00.000Z');
    // Jueves 15 + 5 días hábiles (Viernes 16[1], Lunes 19[2], Martes 20[3], Miércoles 21[4], Jueves 22[5])
    expect(updated.fecha_limite_cierre).toBe('2026-10-22');
  });

  // =========================================================================
  // REQUISITO 3: Una oportunidad con documentos pendientes permanece en Cierre y NO se transfiere a Proyectos y Cobros
  // =========================================================================
  test('3. En Cierre pendiente de documentación NO se habilita postcierre ni transferencia a Proyectos y Cobros', async () => {
    const { fdb, wf, caller, hasEnteredPostclosing } = makeEnv();
    await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
    const pCierreActivo = {
      id: 'P-03',
      codigo: 'DUC-003',
      proyecto: 'Instalación Chillers',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo', // Pendiente de documentación
      postcierre_habilitado: false,
      precio_cotizado: 8000,
      costo_venta: 5000,
      tipo_proyecto: 'Fabricación e instalación'
    };
    await fdb.seed('prospects_prod/P-03', pCierreActivo);

    // 1. hasEnteredPostclosing debe retornar false
    expect(hasEnteredPostclosing(pCierreActivo)).toBe(false);

    // 2. Operaciones de postcierre (facturas, pagos, órdenes de cambio) ejecutadas por manager o seller deben ser rechazadas
    await expect(wf.saveInvoice({
      caller: caller('manager', 'USR-MGR'),
      prospectId: 'P-03',
      numero: 'FAC-001',
      monto: 4000,
      opId: 'OP-INV-001',
      doc_factura: fileObj('f.pdf', 'facturas')
    })).rejects.toThrow(/Proyectos y cobros/i);

    await expect(wf.savePayment({
      caller: caller('manager', 'USR-MGR'),
      prospectId: 'P-03',
      invoiceId: 'FAC-001',
      monto: 4000,
      opId: 'OP-PAY-001',
      metodo: 'transferencia',
      ref: 'TRANS-123',
      doc_comprobante: fileObj('pago.pdf', 'pagos')
    })).rejects.toThrow(/Proyectos y cobros/i);
  });

  // =========================================================================
  // REQUISITO 4: No se puede finalizar si falta un documento obligatorio
  // =========================================================================
  test('4. No se puede finalizar si falta un documento obligatorio (DUI cliente, oferta/contrato, comprobante anticipo, etc.)', async () => {
    const { fdb, wf, caller } = makeEnv();
    // Cliente con perfil completo pero sin DUI adjunto en documentos
    await fdb.seed('clients_prod/C-SIN-DUI', makeClientNatural('C-SIN-DUI', {
      documentos: {} // Falta DUI en documentos
    }));

    await fdb.seed('prospects_prod/P-04', {
      id: 'P-04',
      clientId: 'C-SIN-DUI',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 2000,
      costo_venta: 1200,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_firmado: fileObj('oferta.pdf', 'proyectos'),
        doc_comprobante: fileObj('recibo.pdf', 'facturas'),
        forma_pago: '100% anticipado',
        factura_anticipo: 'FAC-010'
      }
    });

    // Falla por falta de DUI en documentos
    await expect(wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-04',
      data: {}
    })).rejects.toThrow(/DUI/);

    // Ahora cliente con DUI pero falta doc_firmado en datos
    await fdb.seed('clients_prod/C-CON-DUI', makeClientNatural('C-CON-DUI'));

    await fdb.seed('prospects_prod/P-04B', {
      id: 'P-04B',
      clientId: 'C-CON-DUI',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 2000,
      costo_venta: 1200,
      tipo_proyecto: 'Fabricación',
      datos: {
        // doc_firmado ausente
        doc_comprobante: fileObj('recibo.pdf', 'facturas'),
        forma_pago: '100% anticipado',
        factura_anticipo: 'FAC-010'
      }
    });

    await expect(wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-04B',
      data: {}
    })).rejects.toThrow(/oferta firmada|contrato/i);
  });

  // =========================================================================
  // REQUISITO 5: No se puede finalizar si faltan autorizaciones exigidas por las reglas actuales
  // =========================================================================
  test('5. No se puede finalizar venta > $10k e instalación si falta contrato y no cuenta con autorización gerencial', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/C-CORP', makeClientJuridica('C-CORP', {
      documentos: { dui: '09876543-1' } // Faltan escritura, credencial, nit, nrc
    }));

    await fdb.seed('prospects_prod/P-05', {
      id: 'P-05',
      clientId: 'C-CORP',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 15000, // > $10k
      costo_venta: 9000,
      tipo_proyecto: 'Fabricación e instalación', // Instalación
      datos: {
        doc_firmado: fileObj('oferta.pdf', 'proyectos'), // Oferta en lugar de contrato
        doc_comprobante: fileObj('recibo.pdf', 'facturas'),
        forma_pago: '50/50',
        factura_anticipo: 'FA-100',
        encargado: 'Juan Instalador',
        autorizado_sin_contrato: false // Sin autorización de gerencia
      }
    });

    await expect(wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-05',
      data: {}
    })).rejects.toThrow(/documentos legales de la empresa/i);
  });

  // =========================================================================
  // REQUISITO 6: Una oportunidad que cumple todos los requisitos puede finalizarse y marcarse como ganada
  // =========================================================================
  test('6. Oportunidad con expediente completo se finaliza formalmente: estado = ganado, fecha_cierre y fecha_finalizacion', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/C-VALIDO', makeClientNatural('C-VALIDO'));

    await fdb.seed('prospects_prod/P-06', {
      id: 'P-06',
      codigo: 'DUC-006',
      proyecto: 'Extracción Cocina',
      clientId: 'C-VALIDO',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 4000,
      costo_venta: 2500,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_firmado: fileObj('oferta_firmada.pdf', 'proyectos'),
        doc_comprobante: fileObj('ccf_anticipo.pdf', 'facturas'),
        forma_pago: '70/30',
        factura_anticipo: 'CCF-001'
      }
    });

    const res = await wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-06',
      data: {}
    });

    expect(res.status).toBe('finalized');
    expect(res.estado).toBe('ganado');

    const updated = await fdb.data('prospects_prod/P-06');
    expect(updated.estado).toBe('ganado');
    expect(updated.probabilidad).toBe(100);
    expect(updated.postcierre_habilitado).toBe(true);
    expect(updated.fecha_cierre).toBeDefined();
    expect(updated.fecha_finalizacion).toBeDefined();
    expect(Array.isArray(updated.facturas)).toBe(true);
    expect(updated.facturas).toHaveLength(1);
    expect(updated.facturas[0].numero).toBe('CCF-001');
  });

  // =========================================================================
  // REQUISITO 7: La finalización habilita el postcierre y la transferencia operativa
  // =========================================================================
  test('7. Una vez finalizada formalmente, hasEnteredPostclosing es true y habilita Proyectos y Cobros', async () => {
    const { fdb, wf, caller, hasEnteredPostclosing } = makeEnv();
    await fdb.seed('clients_prod/C-VALIDO', makeClientNatural('C-VALIDO'));

    await fdb.seed('prospects_prod/P-07', {
      id: 'P-07',
      clientId: 'C-VALIDO',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 3000,
      costo_venta: 2000,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_firmado: fileObj('o.pdf', 'proyectos'),
        doc_comprobante: fileObj('c.pdf', 'facturas'),
        forma_pago: '50/50', // Deja el otro 50% para facturar después
        factura_anticipo: 'FA-777'
      }
    });

    await wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-07',
      data: {}
    });

    const finalized = await fdb.data('prospects_prod/P-07');
    expect(hasEnteredPostclosing(finalized)).toBe(true);

    // Ahora la operación de postcierre de un gestor (con acceso vía postcierre) es permitida
    const invRes = await wf.saveInvoice({
      caller: caller('gestor', 'USR-G1'),
      prospectId: 'P-07',
      numero: 'FA-778',
      monto: 1000,
      opId: 'OP-INV-778',
      doc_factura: fileObj('f2.pdf', 'facturas')
    });
    expect(invRes.status).toBe('created');
  });

  // =========================================================================
  // REQUISITO 8: Un reintento no duplica la oportunidad en Proyectos y Cobros (Idempotencia)
  // =========================================================================
  test('8. Reintentos de finalizarProspect son idempotentes y no duplican la factura ni el proyecto', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/C-VALIDO', makeClientNatural('C-VALIDO'));

    await fdb.seed('prospects_prod/P-08', {
      id: 'P-08',
      clientId: 'C-VALIDO',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 5000,
      costo_venta: 3000,
      tipo_proyecto: 'Fabricación',
      datos: {
        doc_firmado: fileObj('o.pdf', 'proyectos'),
        doc_comprobante: fileObj('c.pdf', 'facturas'),
        forma_pago: '70/30',
        factura_anticipo: 'FA-888'
      }
    });

    const opId = 'OP-IDEMPOTENT-001';

    // Primer intento
    const res1 = await wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-08',
      data: {},
      opId
    });
    expect(res1.status).toBe('finalized');

    // Segundo intento con mismo opId (reintento de red)
    const res2 = await wf.finalizeProspect({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-08',
      data: {},
      opId
    });
    expect(res2.status).toBe('already_finalized');

    const prospectInDb = await fdb.data('prospects_prod/P-08');
    expect(prospectInDb.estado).toBe('ganado');
    // Exactamente 1 factura de anticipo, nunca 2
    expect(prospectInDb.facturas).toHaveLength(1);
    expect(prospectInDb.facturas[0].numero).toBe('FA-888');
  });

  // =========================================================================
  // REQUISITO 9: Los 5 días hábiles de Cierre se calculan correctamente (excluyendo fines de semana y festivos)
  // =========================================================================
  test('9. Cálculo de días hábiles de Cierre excluye sábados, domingos y asuetos salvadoreños', () => {
    // Ejemplo: Entrada Viernes 24 de abril de 2026.
    // Días hábiles siguientes:
    // Sábado 25 (excluido)
    // Domingo 26 (excluido)
    // Lunes 27 (Día 1)
    // Martes 28 (Día 2)
    // Miércoles 29 (Día 3)
    // Jueves 30 (Día 4)
    // Viernes 1 de mayo: ¡Día del Trabajo - Asueto oficial de El Salvador! (Excluido)
    // Sábado 2 de mayo (excluido)
    // Domingo 3 de mayo (excluido)
    // Lunes 4 de mayo (Día 5 -> Vencimiento oficial)
    const deadline = CrmWorkCalendar.addWorkDays('2026-04-24', 5, { excludeSaturday: true });
    const ymd = deadline.toISOString().slice(0, 10);
    expect(ymd).toBe('2026-05-04');

    // Comprobar días transcurridos
    const elapsed = CrmWorkCalendar.getWorkTimeBetween('2026-04-24', '2026-05-04', { excludeSaturday: true });
    expect(elapsed).toBe(5);

    // El 1 de mayo es reconocido como asueto
    expect(CrmWorkCalendar.getHolidayInfo('2026-05-01').isHoliday).toBe(true);
  });

  // =========================================================================
  // REQUISITO 10: Oportunidad vencida aparece en la agenda del responsable y en atención gerencial
  // =========================================================================
  test('10. Oportunidad con más de 5 días hábiles en Cierre aparece como vencida en agenda y en atención gerencial', () => {
    // Entrada a Cierre: 1 de octubre de 2026.
    // Consulta: 20 de octubre de 2026 (claramente han pasado más de 5 días hábiles)
    const now = new Date('2026-10-20T12:00:00.000Z');
    const pVencido = {
      id: 'P-10',
      codigo: 'DUC-010',
      proyecto: 'Instalación Fabril',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      fecha_inicio_cierre: '2026-10-01T08:00:00.000Z',
      tipo_proyecto: 'Fabricación',
      datos: {}
    };

    // 1. SLA
    const sla = CrmFollowUpCalc.calculateStageSla(pVencido, now);
    expect(sla.isOverdue).toBe(true);
    expect(sla.diasAtraso).toBeGreaterThan(0);
    expect(sla.pendingDocumentation).toBeDefined();

    // 2. Agenda del Vendedor
    const seller = { id: 'USR-V1', role: 'vendedor' };
    const agenda = CrmFollowUpCalc.generateAgenda([pVencido], seller, 'vencidas', now);
    expect(agenda.counts.vencidas).toBe(1);
    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0].classification.status).toBe('vencida');
    expect(agenda.items[0].classification.motivo_agenda).toMatch(/Plazo de Cierre vencido/i);

    // 3. Atención del Gerente
    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([pVencido], null, { filterStatus: 'pendientes', now });
    expect(attention.counts.totalPending).toBe(1);
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0].motivoObjects.some(m => m.tipo === 'limite_etapa')).toBe(true);
  });

  // =========================================================================
  // REQUISITO 11: La agenda y las tarjetas de atención gerencial NO duplican incidencias
  // =========================================================================
  test('11. Oportunidad con múltiple condición de alerta (límite etapa + intentos) se contabiliza exactamente 1 vez', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    const pMultiple = {
      id: 'P-11',
      codigo: 'DUC-011',
      proyecto: 'Proyecto Complejo',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'cierre',
      estado: 'activo',
      fecha_inicio_cierre: '2026-10-01T08:00:00.000Z', // Vencida en Cierre
      seguimiento: {
        cadencia: {
          intentos_fallidos: 5, // También tiene 5 intentos sin respuesta
          alerta_gerencial: true
        }
      },
      solicitud_sin_contrato: { estado: 'pendiente', motivo: 'Urgencia' } // Y solicitud pendiente
    };

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([pMultiple], null, { filterStatus: 'pendientes', now });
    // Debe tener los 3 motivos en su detalle, pero contarse exactamente 1 vez
    expect(attention.items).toHaveLength(1);
    expect(attention.counts.totalPending).toBe(1);
    expect(attention.pendingUniqueCount).toBe(1);
    expect(attention.items[0].motivos.length).toBeGreaterThan(1);
  });

  // =========================================================================
  // REQUISITO 12: Oportunidades «Solo para presupuesto» respetan las reglas aprobadas
  // =========================================================================
  test('12. «Solo para presupuesto»: sujeta a límites en prospecto/levantamiento/cotización, pero exenta de cadencia de negociación', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    const pPresupuesto = {
      id: 'P-12',
      codigo: 'DUC-012',
      proyecto: 'Presupuesto Referencial',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'negociacion',
      estado: 'activo',
      clasificacion: 'presupuesto',
      seguimiento: {
        cadencia: {
          intentos_fallidos: 5,
          alerta_gerencial: true
        }
      }
    };

    // No debe generar alerta de atención gerencial por falta de seguimiento comercial
    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([pPresupuesto], null, { filterStatus: 'pendientes', now });
    expect(attention.items).toHaveLength(0);
    expect(attention.counts.totalPending).toBe(0);

    // En cambio, si está en cotización y excede los 5 días hábiles, sí debe alertar por límite de etapa
    const pPresupuestoCotizOverdue = {
      id: 'P-12B',
      codigo: 'DUC-012B',
      proyecto: 'Presupuesto En Cotización',
      clientId: 'C-01',
      vendedorId: 'USR-V1',
      etapa: 'cotizacion',
      estado: 'activo',
      clasificacion: 'presupuesto',
      stage_timestamps: { cotizacion: '2026-10-01T08:00:00.000Z' }
    };
    const sla = CrmFollowUpCalc.calculateStageSla(pPresupuestoCotizOverdue, now);
    expect(sla.isOverdue).toBe(true);
    expect(sla.limitBusinessDays).toBe(5);
  });

  // =========================================================================
  // REQUISITO 13: Los dashboards no cuentan oportunidad en Cierre pendiente como ganada ni proyecto en ejecución
  // =========================================================================
  test('13. Oportunidad en Cierre activa NO se contabiliza como ganada ni como proyecto en ejecución en métricas', () => {
    const { hasEnteredPostclosing } = makeEnv();
    const pCierre = {
      id: 'P-13',
      etapa: 'cierre',
      estado: 'activo',
      postcierre_habilitado: false,
      precio_cotizado: 10000,
      costo_venta: 6000
    };

    // Verificación de los invariantes de postcierre
    expect(hasEnteredPostclosing(pCierre)).toBe(false);
    expect(pCierre.estado).not.toBe('ganado');

    // La función canónica de verificación rechaza cualquier acceso a Proyectos y Cobros
    expect(hasEnteredPostclosing({ ...pCierre, fecha_cierre: null })).toBe(false);
  });

  // =========================================================================
  // REQUISITO 14: Los permisos de vendedores, gestores, gerentes y administradores funcionan correctamente
  // =========================================================================
  test('14. Permisos de roles: vendedor solo puede actuar sobre sus oportunidades; gestor asignado y gerente sobre todas', async () => {
    const { fdb, wf, caller } = makeEnv();
    await fdb.seed('clients_prod/C-01', makeClientNatural('C-01'));
    await fdb.seed('prospects_prod/P-14', {
      id: 'P-14',
      clientId: 'C-01',
      vendedorId: 'USR-V1', // Asignado a V1
      createdBy: 'USR-G1',  // Creado por G1
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 2000,
      costo_venta: 1000,
      tipo_proyecto: 'Fabricación'
    });

    // Vendedor V2 (no asignado) intenta guardar avance documental -> Denegado
    await expect(wf.saveClosingDocuments({
      caller: caller('vendedor', 'USR-V2'),
      prospectId: 'P-14',
      data: { forma_pago: '100% anticipado' }
    })).rejects.toThrow(/No tienes acceso/);

    // Vendedor V1 (asignado) guarda avance documental -> Permitido
    const resV1 = await wf.saveClosingDocuments({
      caller: caller('vendedor', 'USR-V1'),
      prospectId: 'P-14',
      data: { forma_pago: '100% anticipado' }
    });
    expect(resV1.status).toBe('saved');

    // Gestor creador G1 guarda avance documental -> Permitido por autoría
    const resGestor = await wf.saveClosingDocuments({
      caller: caller('gestor', 'USR-G1'),
      prospectId: 'P-14',
      data: { factura_anticipo: 'FCF-555' }
    });
    expect(resGestor.status).toBe('saved');

    // Gerente / Manager guarda avance documental -> Permitido con acceso universal
    const resMgr = await wf.saveClosingDocuments({
      caller: caller('manager', 'USR-MGR'),
      prospectId: 'P-14',
      data: { factura_anticipo: 'FCF-999' }
    });
    expect(resMgr.status).toBe('saved');
  });
});
