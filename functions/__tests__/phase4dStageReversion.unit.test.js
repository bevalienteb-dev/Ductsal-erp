// functions/__tests__/phase4dStageReversion.unit.test.js
// UNIT test suite for Phase 4D: Stage Reversions, SLA, Follow-Up Cadence, Idempotency, and Audit

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { P, caller } = require('../test-helpers/commercialSuite');
const CrmDashboardCalc = require('../../crm_dashboard_calc');
const CrmFollowUpCalc = require('../crm_followup_calc');
const CrmCommercial = require('../../crm_commercial');

const CLOCK = new Date('2026-03-15T12:00:00.000Z');

function buildEnv() {
  const fdb = createFakeFirestore({ clock: () => CLOCK });
  const live = { ok: true, calls: [] };
  const commercial = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => CLOCK,
    verifyManager: async uid => { live.calls.push(uid); return live.ok; }
  });
  const wf = createProspectWorkflowService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    kit: commercial.kit
  });
  return {
    fdb,
    wf,
    live,
    commercial,
    seed: (path, data) => fdb.seed(path, data),
    read: async path => fdb.data(path),
    list: async c => fdb.list(c),
    clear: () => fdb.clear()
  };
}

let opSeq = 0;
const nextOpId = () => `op-4d-${Date.now()}-${++opSeq}-${Math.random().toString(36).slice(2, 8)}`;

describe('Fase 4D: Reversiones de Etapa, SLA, Cadencia, Idempotencia y Auditoría', () => {
  let env;
  let wf;

  const CLIENT_1 = {
    id: 'CLI-1',
    tipo: 'juridica',
    empresa: 'Constructora Alfa',
    contacto: 'Carlos Gomez',
    telefono: '7000-1111',
    createdBy: P.V1.id,
    closingVendors: [P.V1.id]
  };

  const PROSPECT_CIERRE = {
    id: 'P-CIERRE-1',
    codigo: '202601001',
    clientId: 'CLI-1',
    createdBy: P.V1.id,
    vendedorId: P.V1.id,
    vendedorName: P.V1.nombre,
    vendedorRole: 'vendedor',
    fecha_creacion: '2026-01-01T08:00:00.000Z',
    estado: 'activo',
    etapa: 'cierre',
    tipo_proyecto: 'Nuevo',
    precio_cotizado: 25000,
    costo_venta: 15000,
    datos: {
      nota: 'Proyecto prioritario',
      autorizado_sin_contrato: true,
      estado_propuesta: 'vigente'
    },
    aprobacion_sin_contrato: {
      estado: 'aprobada',
      aprobado_por_nombre: 'Gerente Alfa',
      fecha_aprobacion: '2026-03-01T10:00:00.000Z'
    },
    solicitudes_sin_contrato: [
      { id: 'req-1', estado: 'pendiente', fecha_solicitud: '2026-03-02T10:00:00.000Z' }
    ],
    stage_timestamps: {
      prospecto: '2026-01-01T08:00:00.000Z',
      levantamiento: '2026-01-10T08:00:00.000Z',
      cotizacion: '2026-02-01T08:00:00.000Z',
      negociacion: '2026-02-15T08:00:00.000Z',
      cierre: '2026-03-02T08:00:00.000Z'
    },
    tiempos_etapas_acumulados: {
      prospecto: 6,
      levantamiento: 15,
      cotizacion: 10,
      negociacion: 10
    },
    stage_transitions: [
      { from: 'prospecto', to: 'levantamiento', tipo: 'avance', duracion_dias: 6, fecha: '2026-01-10T08:00:00.000Z' },
      { from: 'levantamiento', to: 'cotizacion', tipo: 'avance', duracion_dias: 15, fecha: '2026-02-01T08:00:00.000Z' },
      { from: 'cotizacion', to: 'negociacion', tipo: 'avance', duracion_dias: 10, fecha: '2026-02-15T08:00:00.000Z' },
      { from: 'negociacion', to: 'cierre', tipo: 'avance', duracion_dias: 10, fecha: '2026-03-02T08:00:00.000Z' }
    ],
    fecha_inicio_cierre: '2026-03-02T08:00:00.000Z',
    fecha_limite_cierre: '2026-03-09',
    logs: []
  };

  beforeEach(async () => {
    env = buildEnv();
    wf = env.wf;
    for (const k of Object.keys(P)) {
      await env.seed(`users_prod/${P[k].id}`, { id: P[k].id, ...P[k] });
    }
    await env.seed('clients_prod/CLI-1', CLIENT_1);
    await env.seed('prospects_prod/P-CIERRE-1', PROSPECT_CIERRE);
  });

  // ===================================================================================================
  // TEST-4D-01: Reversiones contiguas entre etapas
  // ===================================================================================================
  test('TEST-4D-01: Reversiones contiguas paso a paso (cierre -> negociacion -> cotizacion -> levantamiento -> prospecto)', async () => {
    // 1. cierre -> negociacion
    const r1 = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Cliente solicita revisión de especificaciones y precio',
      opId: nextOpId()
    });
    expect(r1.status).toBe('reverted');
    expect(r1.etapa).toBe('negociacion');
    expect(r1.previousStage).toBe('cierre');

    let p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('negociacion');

    // 2. negociacion -> cotizacion
    const r2 = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'negociacion',
      targetStage: 'cotizacion',
      motivo: 'Se requiere recotizar con nuevos planos entregados por el cliente',
      opId: nextOpId()
    });
    expect(r2.status).toBe('reverted');
    expect(r2.etapa).toBe('cotizacion');

    p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('cotizacion');

    // 3. cotizacion -> levantamiento
    const r3 = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cotizacion',
      targetStage: 'levantamiento',
      motivo: 'Se necesita una nueva visita técnica a sitio para replanteo',
      opId: nextOpId()
    });
    expect(r3.status).toBe('reverted');
    expect(r3.etapa).toBe('levantamiento');

    p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('levantamiento');

    // 4. levantamiento -> prospecto
    const r4 = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'levantamiento',
      targetStage: 'prospecto',
      motivo: 'El cliente canceló la visita y se debe recalificar el contacto inicial',
      opId: nextOpId()
    });
    expect(r4.status).toBe('reverted');
    expect(r4.etapa).toBe('prospecto');

    p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('prospecto');
  });

  // ===================================================================================================
  // TEST-4D-02: Rechazo de saltos no contiguos
  // ===================================================================================================
  test('TEST-4D-02: Rechazo tajante de saltos no contiguos', async () => {
    // Intento de saltar de cierre a cotización
    let err1;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'cotizacion',
        motivo: 'Saltar de cierre directo a cotización',
        opId: nextOpId()
      });
    } catch (e) {
      err1 = e;
    }
    expect(err1).toBeDefined();
    expect(err1.code).toBe('failed-precondition');
    expect(err1.message).toContain('Solo se permite retroceder a la etapa inmediatamente anterior');

    // Intento de saltar de cierre a prospecto
    let err2;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'prospecto',
        motivo: 'Saltar de cierre directo a prospecto',
        opId: nextOpId()
      });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeDefined();
    expect(err2.code).toBe('failed-precondition');

    // Intento de retroceder desde prospecto
    await env.seed('prospects_prod/P-INIT', {
      ...PROSPECT_CIERRE,
      id: 'P-INIT',
      etapa: 'prospecto'
    });
    let err3;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-INIT',
        currentStage: 'prospecto',
        targetStage: 'ninguna',
        motivo: 'Retroceder desde prospecto inicial',
        opId: nextOpId()
      });
    } catch (e) {
      err3 = e;
    }
    expect(err3).toBeDefined();
    expect(err3.code).toBe('failed-precondition');
  });

  // ===================================================================================================
  // TEST-4D-03: Validación de motivo obligatorio (10 a 500 caracteres)
  // ===================================================================================================
  test('TEST-4D-03: Validación estricta de motivo obligatorio (10 - 500 caracteres)', async () => {
    // Menos de 10 caracteres
    let errShort;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: '123456789', // 9 caracteres
        opId: nextOpId()
      });
    } catch (e) {
      errShort = e;
    }
    expect(errShort).toBeDefined();
    expect(errShort.code).toBe('invalid-argument');
    expect(errShort.message).toContain('al menos 10 caracteres');

    // Más de 500 caracteres
    let errLong;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'a'.repeat(501),
        opId: nextOpId()
      });
    } catch (e) {
      errLong = e;
    }
    expect(errLong).toBeDefined();
    expect(errLong.code).toBe('invalid-argument');
    expect(errLong.message).toContain('500');

    // Exactamente 10 caracteres -> exitoso
    const res = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: '1234567890',
      opId: nextOpId()
    });
    expect(res.status).toBe('reverted');
  });

  // ===================================================================================================
  // TEST-4D-04: Permisos por rol y ámbito de acceso existente
  // ===================================================================================================
  test('TEST-4D-04: Control de acceso por rol: vendedor no asignado es rechazado, asignado/gestor/manager permitidos', async () => {
    // Vendedor no asignado (V2 no es creador ni vendedorId de P-CIERRE-1)
    let errV2;
    try {
      await wf.revertStage({
        caller: caller('V2'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Vendedor ajeno intenta revertir etapa',
        opId: nextOpId()
      });
    } catch (e) {
      errV2 = e;
    }
    expect(errV2).toBeDefined();
    expect(errV2.code).toBe('permission-denied');

    // Gestor (GES) está autorizado sobre prospectos que creó o tiene asignados
    await env.seed('prospects_prod/P-CIERRE-GES', {
      ...PROSPECT_CIERRE,
      id: 'P-CIERRE-GES',
      createdBy: P.GES.id,
      vendedorId: P.V2.id
    });
    const resGes = await wf.revertStage({
      caller: caller('GES'),
      prospectId: 'P-CIERRE-GES',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Gestora realiza retroceso en prospecto de su cartera',
      opId: nextOpId()
    });
    expect(resGes.status).toBe('reverted');

    // Manager (MGR) tiene acceso universal y está autorizado sobre cualquier prospecto
    const resMgr = await wf.revertStage({
      caller: caller('MGR'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Gerente aprueba retorno a negociación para recalcular costos',
      opId: nextOpId()
    });
    expect(resMgr.status).toBe('reverted');
  });

  // ===================================================================================================
  // TEST-4D-05: Estados inválidos (ganado / perdido no pueden revertir)
  // ===================================================================================================
  test('TEST-4D-05: Oportunidades no activas (ganado / perdido) no pueden revertir', async () => {
    await env.seed('prospects_prod/P-WON', {
      ...PROSPECT_CIERRE,
      id: 'P-WON',
      estado: 'ganado'
    });
    let errWon;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-WON',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Intentando revertir oportunidad ganada',
        opId: nextOpId()
      });
    } catch (e) {
      errWon = e;
    }
    expect(errWon).toBeDefined();
    expect(errWon.code).toBe('failed-precondition');
    expect(errWon.message).toContain('Solo las oportunidades activas pueden retroceder');

    await env.seed('prospects_prod/P-LOST', {
      ...PROSPECT_CIERRE,
      id: 'P-LOST',
      estado: 'perdido'
    });
    let errLost;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-LOST',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Intentando revertir oportunidad perdida',
        opId: nextOpId()
      });
    } catch (e) {
      errLost = e;
    }
    expect(errLost).toBeDefined();
    expect(errLost.code).toBe('failed-precondition');
  });

  // ===================================================================================================
  // TEST-4D-06: Idempotencia y no duplicación de transiciones/auditorías
  // ===================================================================================================
  test('TEST-4D-06: Reintentos idempotentes con el mismo opId retornan replay: true sin duplicar escrituras ni auditoría', async () => {
    const fixedOpId = nextOpId();
    const payload = {
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Solicitud de revisión técnica por el cliente',
      opId: fixedOpId
    };

    // Primera ejecución
    const r1 = await wf.revertStage(payload);
    expect(r1.status).toBe('reverted');
    expect(r1.replay).toBe(false);

    // Segundo intento con idéntico opId y payload
    const r2 = await wf.revertStage(payload);
    expect(r2.status).toBe('reverted');
    expect(r2.replay).toBe(true);
    expect(r2.prospectId).toBe('P-CIERRE-1');
    expect(r2.etapa).toBe('negociacion');

    // Verificar en base de datos: exactamente 1 auditoría registrada y 1 transición de tipo 'reversion'
    const audits = (await env.list('commercialAudit_prod')).filter(a => a.action === 'revertProspectStage');
    expect(audits.length).toBe(1);
    expect(audits[0].detail.opId).toBe(fixedOpId);

    const p = await env.read('prospects_prod/P-CIERRE-1');
    const revTransitions = (p.stage_transitions || []).filter(t => t.tipo === 'reversion');
    expect(revTransitions.length).toBe(1);
    expect(revTransitions[0].opId).toBe(fixedOpId);
  });

  // ===================================================================================================
  // TEST-4D-07: Detección de reutilización indebida de opId
  // ===================================================================================================
  test('TEST-4D-07: Detección de reutilización indebida de opId con otro usuario o datos distintos', async () => {
    const reusedOpId = nextOpId();
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Motivo original para la operación legítima',
      opId: reusedOpId
    });

    // 1. Mismo opId usado por otro usuario
    let errOtherUser;
    try {
      await wf.revertStage({
        caller: caller('GES'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Motivo original para la operación legítima',
        opId: reusedOpId
      });
    } catch (e) {
      errOtherUser = e;
    }
    expect(errOtherUser).toBeDefined();
    expect(errOtherUser.code).toBe('permission-denied');
    expect(errOtherUser.message).toContain('El opId pertenece a otro usuario');

    // 2. Mismo opId usado por el mismo usuario pero con payload distinto (motivo diferente)
    let errDiffPayload;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Motivo completamente diferente que altera el hash',
        opId: reusedOpId
      });
    } catch (e) {
      errDiffPayload = e;
    }
    expect(errDiffPayload).toBeDefined();
    expect(errDiffPayload.code).toBe('failed-precondition');
    expect(errDiffPayload.message).toContain('El opId ya fue utilizado con otros datos');
  });

  // ===================================================================================================
  // TEST-4D-08: Reintento idempotente tras avance posterior
  // ===================================================================================================
  test('TEST-4D-08: Reintento idempotente tras un avance posterior devuelve replay sin alterar la etapa posterior', async () => {
    const revOpId = nextOpId();
    // 1. Revertir de cierre a negociación
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso para ajuste de cotización',
      opId: revOpId
    });

    // 2. Avanzar de nuevo a cierre
    await wf.advanceStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      nextStage: 'cierre',
      data: {}
    });

    let p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('cierre');

    // 3. Re-enviar la solicitud de reversión anterior con su opId original
    const replayRes = await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso para ajuste de cotización',
      opId: revOpId
    });

    expect(replayRes.status).toBe('reverted');
    expect(replayRes.replay).toBe(true);

    // La etapa actual debe permanecer en 'cierre' (no ser sobreescrita por el replay)
    p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('cierre');
  });

  // ===================================================================================================
  // TEST-4D-08b: Idempotencia duradera tras archivado de stage_transitions
  // ===================================================================================================
  test('TEST-4D-08b: Idempotencia duradera en prospectOps_prod sobrevive si stage_transitions se vacía', async () => {
    const durableOpId = nextOpId();
    const payload = {
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso validando idempotencia duradera',
      opId: durableOpId
    };

    await wf.revertStage(payload);

    // Simular archivado o truncamiento del arreglo stage_transitions
    await env.seed('prospects_prod/P-CIERRE-1', {
      ...(await env.read('prospects_prod/P-CIERRE-1')),
      stage_transitions: []
    });

    // Replay debe funcionar leyendo de prospectOps_prod
    const replayRes = await wf.revertStage(payload);
    expect(replayRes.status).toBe('reverted');
    expect(replayRes.replay).toBe(true);
  });

  // ===================================================================================================
  // TEST-4D-09: Control de concurrencia optimista (OCC) ante desfase de etapa
  // ===================================================================================================
  test('TEST-4D-09: Conflicto de concurrencia: si la etapa en base de datos ya cambió, la reversión falla con mensaje claro', async () => {
    // El frontend creía que estaba en 'cierre', pero ya fue avanzada o cambiada a otra
    let errOCC;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'negociacion', // Envía negociacion pero en DB está en cierre
        targetStage: 'cotizacion',
        motivo: 'Intento con etapa desfasada en pantalla',
        opId: nextOpId()
      });
    } catch (e) {
      errOCC = e;
    }
    expect(errOCC).toBeDefined();
    expect(errOCC.code).toBe('failed-precondition');
    expect(errOCC.message).toContain('Conflicto de concurrencia: la oportunidad se encuentra en la etapa \'cierre\', no en \'negociacion\'');
  });

  // ===================================================================================================
  // TEST-4D-10: Atomicidad transaccional (todas las lecturas antes de escrituras)
  // ===================================================================================================
  test('TEST-4D-10: Transaccionalidad estricta de Firestore: todas las lecturas se ejecutan antes de cualquier escritura', async () => {
    // Si FakeFirestore detecta una lectura después de una escritura, arroja:
    // "Firestore transactions require all reads to be executed before all writes."
    const opId = nextOpId();
    await expect(wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Comprobación de orden estricto de transacciones',
      opId
    })).resolves.toMatchObject({ status: 'reverted' });

    // Verifica que en la misma transacción se escribieron: prospect, op, audit, client
    const p = await env.read('prospects_prod/P-CIERRE-1');
    const op = await env.read(`prospectOps_prod/${opId}`);
    const audits = (await env.list('commercialAudit_prod')).filter(a => a.action === 'revertProspectStage');

    expect(p.etapa).toBe('negociacion');
    expect(op.status).toBe('succeeded');
    expect(audits.length).toBe(1);
  });

  // ===================================================================================================
  // TEST-4D-11: Rollback total si falla una escritura
  // ===================================================================================================
  test('TEST-4D-11: Rollback total si falla la transacción: nada se aplica ni queda inconsistente', async () => {
    // Inyectamos un fallo antes del commit en fakeFirestore
    env.fdb.state.hooks.beforeCommit = (writes) => {
      if (writes.some(w => w.col === 'commercialAudit_prod')) {
        throw new Error('Simulated failure during audit log creation');
      }
    };

    const opId = nextOpId();
    let commitErr;
    try {
      await wf.revertStage({
        caller: caller('V1'),
        prospectId: 'P-CIERRE-1',
        currentStage: 'cierre',
        targetStage: 'negociacion',
        motivo: 'Comprobación de rollback atómico',
        opId
      });
    } catch (e) {
      commitErr = e;
    }
    expect(commitErr).toBeDefined();
    expect(commitErr.message).toContain('Simulated failure during audit log creation');

    // La oportunidad sigue intacta en 'cierre'
    const p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.etapa).toBe('cierre');

    // El opId NO fue creado
    const op = await env.read(`prospectOps_prod/${opId}`);
    expect(op).toBeUndefined();

    // Limpiar hook para no afectar otros tests
    env.fdb.state.hooks.beforeCommit = null;
  });

  // ===================================================================================================
  // TEST-4D-12 & TEST-4D-13: Invalidación de autorización sin contrato y limpieza de cierre
  // ===================================================================================================
  test('TEST-4D-12 & 13: Invalidación total de autorización sin contrato, anulación de solicitudes y borrado de fechas de cierre', async () => {
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Regreso a negociación para renegociar plazos contractuales',
      opId: nextOpId()
    });

    const p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.datos.autorizado_sin_contrato).toBe(false);
    expect(p.aprobacion_sin_contrato.estado).toBe('invalidada_por_reversion');
    expect(p.aprobacion_sin_contrato.invalidado_por_id).toBe(P.V1.id);
    expect(p.aprobacion_sin_contrato.motivo_invalidacion).toContain('renegociar plazos');

    // Solicitudes pendientes anuladas
    expect(p.solicitudes_sin_contrato[0].estado).toBe('anulada_por_reversion');
    expect(p.solicitudes_sin_contrato[0].anulado_por_id).toBe(P.V1.id);

    // Fechas de cierre eliminadas del documento
    expect(p.fecha_inicio_cierre).toBeUndefined();
    expect(p.fecha_limite_cierre).toBeUndefined();
  });

  // ===================================================================================================
  // TEST-4D-14: Actualización de closingVendors cuando no quedan otras oportunidades en cierre
  // ===================================================================================================
  test('TEST-4D-14: Vendedor se remueve de closingVendors al salir de cierre si no tiene otras oportunidades en cierre', async () => {
    // Cliente CLI-1 tiene closingVendors: [V1.id]. P-CIERRE-1 es la única en cierre.
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso sin otras oportunidades en cierre para este cliente',
      opId: nextOpId()
    });

    const cli = await env.read('clients_prod/CLI-1');
    expect(cli.closingVendors).toEqual([]);
  });

  // ===================================================================================================
  // TEST-4D-15: Preservación de closingVendors cuando tiene otra oportunidad en cierre
  // ===================================================================================================
  test('TEST-4D-15: Vendedor se CONSERVA en closingVendors si tiene OTRA oportunidad activa en cierre para el mismo cliente', async () => {
    // Sembrar una segunda oportunidad en cierre del mismo cliente asignada a V1
    await env.seed('prospects_prod/P-CIERRE-2', {
      ...PROSPECT_CIERRE,
      id: 'P-CIERRE-2',
      vendedorId: P.V1.id,
      estado: 'activo',
      etapa: 'cierre'
    });

    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso de P1 pero P2 sigue abierta en cierre',
      opId: nextOpId()
    });

    const cli = await env.read('clients_prod/CLI-1');
    expect(cli.closingVendors).toContain(P.V1.id);
  });

  // ===================================================================================================
  // TEST-4D-16: Limpieza de cadencia al retroceder de negociación a cotización
  // ===================================================================================================
  test('TEST-4D-16: Limpieza de cadencia, eliminación de proxima_accion y estado_propuesta = borrador al retroceder a Cotización', async () => {
    // Sembrar prospecto en negociación con cadencia activa
    await env.seed('prospects_prod/P-NEG', {
      ...PROSPECT_CIERRE,
      id: 'P-NEG',
      etapa: 'negociacion',
      fecha_entrega_oferta: '2026-03-01T10:00:00.000Z',
      datos: {
        ...PROSPECT_CIERRE.datos,
        estado_propuesta: 'vigente'
      },
      seguimiento: {
        cadencia: {
          tipo_cadencia: 'estandar',
          fecha_entrega_oferta: '2026-03-01T10:00:00.000Z'
        },
        proxima_accion: {
          fecha: '2026-03-05',
          tipo: 'llamada',
          descripcion: 'Primer seguimiento'
        }
      }
    });

    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-NEG',
      currentStage: 'negociacion',
      targetStage: 'cotizacion',
      motivo: 'Regreso a cotización para replantear propuesta',
      opId: nextOpId()
    });

    const p = await env.read('prospects_prod/P-NEG');
    expect(p.etapa).toBe('cotizacion');
    expect(p.datos.estado_propuesta).toBe('borrador');
    expect(p.fecha_entrega_oferta).toBeUndefined();
    expect(p.seguimiento.cadencia).toBeNull();
    expect(p.seguimiento.proxima_accion).toBeNull();
  });

  // ===================================================================================================
  // TEST-4D-17 & TEST-4D-18: Liquidación de tiempos en días hábiles y visitas de cero días
  // ===================================================================================================
  test('TEST-4D-17: Liquidación de tiempos acumulados en la etapa saliente y reinicio de SLA de la etapa destino', async () => {
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Verificación de liquidación acumulada de tiempos',
      opId: nextOpId()
    });

    const p = await env.read('prospects_prod/P-CIERRE-1');
    // Ingresó a cierre el 2026-03-02 y el CLOCK es 2026-03-15
    // En días hábiles salvadoreños excluyendo sábados y domingos:
    expect(typeof p.tiempos_etapas_acumulados.cierre).toBe('number');
    expect(p.tiempos_etapas_acumulados.cierre).toBeGreaterThan(0);

    // SLA de negociacion fue reiniciado a la fecha del retroceso (CLOCK)
    expect(p.stage_timestamps.negociacion).toBe(CLOCK.toISOString());

    // Transición registrada con duracion_dias
    const lastTrans = p.stage_transitions[p.stage_transitions.length - 1];
    expect(lastTrans.tipo).toBe('reversion');
    expect(lastTrans.from).toBe('cierre');
    expect(lastTrans.to).toBe('negociacion');
    expect(lastTrans.duracion_dias).toBe(p.tiempos_etapas_acumulados.cierre);
  });

  test('TEST-4D-18: Visita intra-día (mismo día hábil) se liquida como 0.0 días sin producir NaN ni null', async () => {
    // Oportunidad que ingresó a cierre hoy mismo
    await env.seed('prospects_prod/P-SAMEDAY', {
      ...PROSPECT_CIERRE,
      id: 'P-SAMEDAY',
      stage_timestamps: {
        ...PROSPECT_CIERRE.stage_timestamps,
        cierre: CLOCK.toISOString()
      },
      tiempos_etapas_acumulados: {
        ...PROSPECT_CIERRE.tiempos_etapas_acumulados,
        cierre: 0
      }
    });

    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-SAMEDAY',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Retroceso el mismo día hábil de entrada a cierre',
      opId: nextOpId()
    });

    const p = await env.read('prospects_prod/P-SAMEDAY');
    expect(p.tiempos_etapas_acumulados.cierre).toBe(0);
    const trans = p.stage_transitions[p.stage_transitions.length - 1];
    expect(trans.duracion_dias).toBe(0);
    expect(isNaN(trans.duracion_dias)).toBe(false);
  });

  // ===================================================================================================
  // TEST-4D-19, 20, 20b: Dashboard - Cálculo de tiempos de etapa a 3 niveles
  // ===================================================================================================
  describe('Dashboard: compatibilidad de cálculo a 3 niveles', () => {
    test('TEST-4D-19: Nivel 1 - Consume tiempos_etapas_acumulados canónicos oficiales', () => {
      const prospects = [
        {
          id: 'P1',
          estado: 'activo',
          etapa: 'cierre',
          tiempos_etapas_acumulados: { prospecto: 5, levantamiento: 8, cotizacion: 12, negociacion: 6 }
        },
        {
          id: 'P2',
          estado: 'ganado',
          etapa: 'cierre',
          tiempos_etapas_acumulados: { prospecto: 3, levantamiento: 4, cotizacion: 6, negociacion: 4, cierre: 5 }
        }
      ];

      const res = CrmDashboardCalc.calculateStageTransitionTimes(prospects);
      expect(res.prospecto.avgDays).toBe(4); // (5 + 3) / 2
      expect(res.levantamiento.avgDays).toBe(6); // (8 + 4) / 2
      expect(res.cotizacion.avgDays).toBe(9); // (12 + 6) / 2
      expect(res.negociacion.avgDays).toBe(5); // (6 + 4) / 2
      expect(res.cierre.avgDays).toBe(5); // P1 sigue activa en cierre (excluida), P2 completó con 5
      expect(res.prospecto.historial_parcial).toBe(false);
    });

    test('TEST-4D-20: Nivel 2 - Reconstruye a partir de stage_transitions con múltiples ciclos y reversiones', () => {
      const prospects = [
        {
          id: 'P_RECONSTRUCT',
          estado: 'ganado',
          etapa: 'cierre',
          // Sin tiempos_etapas_acumulados, pero con stage_transitions
          stage_transitions: [
            { from: 'prospecto', to: 'levantamiento', duracion_dias: 4 },
            { from: 'levantamiento', to: 'cotizacion', duracion_dias: 7 },
            { from: 'cotizacion', to: 'negociacion', duracion_dias: 5 },
            { from: 'negociacion', to: 'cotizacion', tipo: 'reversion', duracion_dias: 3 }, // Reversión
            { from: 'cotizacion', to: 'negociacion', duracion_dias: 4 }, // Segunda visita a cotización
            { from: 'negociacion', to: 'cierre', duracion_dias: 2 } // Segunda visita a negociación
          ]
        }
      ];

      const res = CrmDashboardCalc.calculateStageTransitionTimes(prospects);
      expect(res.prospecto.avgDays).toBe(4);
      expect(res.levantamiento.avgDays).toBe(7);
      // Cotización sumó dos salidas: 5 días + 4 días = 9 días
      expect(res.cotizacion.avgDays).toBe(9);
      // Negociación sumó dos salidas: 3 días (reversión) + 2 días (avance) = 5 días
      expect(res.negociacion.avgDays).toBe(5);
    });

    test('TEST-4D-20b: Nivel 3 - Historial legacy incompleto no inventa ceros y reporta historial_parcial: true', () => {
      const prospects = [
        {
          id: 'P_LEGACY_INCOMPLETE',
          estado: 'ganado',
          etapa: 'cierre',
          // No tiene fecha de inicio de levantamiento ni acumulados ni transiciones
          stage_timestamps: {
            prospecto: '2026-01-01T08:00:00.000Z',
            // Falta levantamiento
            cotizacion: '2026-01-20T08:00:00.000Z'
          }
        },
        {
          id: 'P_LEGACY_CORRUPT',
          estado: 'ganado',
          etapa: 'cierre',
          // Fechas inconsistentes (retroceso histórico sin modelo de reversión previa)
          stage_timestamps: {
            levantamiento: '2026-01-25T08:00:00.000Z',
            cotizacion: '2026-01-20T08:00:00.000Z' // anterior a levantamiento
          }
        }
      ];

      const res = CrmDashboardCalc.calculateStageTransitionTimes(prospects);
      // No debe inventar duraciones ni convertir en ceros
      expect(res.levantamiento.countExcludedIncomplete).toBeGreaterThan(0);
      expect(res.levantamiento.historial_parcial).toBe(true);
    });
  });

  // ===================================================================================================
  // TEST-4D-21 & TEST-4D-22: Alertas gerenciales (reversiones reiteradas y estancamiento de pipeline)
  // ===================================================================================================
  describe('Alertas gerenciales (CrmFollowUpCalc)', () => {
    test('TEST-4D-21: Alerta gerencial Criterio D por 2 o más reversiones en la misma oportunidad', () => {
      const prospectWith2Reversions = {
        id: 'P-MULTI-REV',
        codigo: '202602001',
        cliente: 'Cliente Reincidente',
        estado: 'activo',
        etapa: 'cotizacion',
        vendedorId: P.V1.id,
        vendedorNombre: P.V1.nombre,
        stage_transitions: [
          { from: 'cotizacion', to: 'negociacion', tipo: 'avance' },
          { from: 'negociacion', to: 'cotizacion', tipo: 'reversion', fecha: '2026-03-05T10:00:00.000Z' },
          { from: 'cotizacion', to: 'negociacion', tipo: 'avance' },
          { from: 'negociacion', to: 'cotizacion', tipo: 'reversion', fecha: '2026-03-10T10:00:00.000Z' }
        ]
      };

      const attentionResult = CrmFollowUpCalc.calculateManagerAttentionItems([prospectWith2Reversions], null, {
        now: CLOCK
      });

      expect(attentionResult.counts.reversiones_reiteradas).toBe(1);
      const item = attentionResult.items.find(i => i.id === 'P-MULTI-REV');
      expect(item).toBeDefined();
      const motivoRev = item.motivoObjects.find(m => m.tipo === 'reversion');
      expect(motivoRev).toBeDefined();
      expect(motivoRev.subtipo).toBe('reversiones_reiteradas');
      expect(motivoRev.reversionesCount).toBe(2);
    });

    test('TEST-4D-22: Alerta gerencial Criterio E por permanencia activa prolongada en pipeline (> 45 días hábiles)', () => {
      const staleProspect = {
        id: 'P-STALE',
        codigo: '202600100',
        cliente: 'Cliente Dormido',
        estado: 'activo',
        etapa: 'levantamiento',
        clasificacion: 'proyecto',
        // Creada hace 70 días hábiles
        fecha_creacion: '2025-11-01T08:00:00.000Z',
        vendedorId: P.V1.id,
        vendedorNombre: P.V1.nombre
      };

      const attentionResult = CrmFollowUpCalc.calculateManagerAttentionItems([staleProspect], null, {
        now: CLOCK
      });

      expect(attentionResult.counts.estancamiento_pipeline).toBe(1);
      const item = attentionResult.items.find(i => i.id === 'P-STALE');
      expect(item).toBeDefined();
      const motivoStale = item.motivoObjects.find(m => m.tipo === 'permanencia_pipeline');
      expect(motivoStale).toBeDefined();
      expect(motivoStale.subtipo).toBe('estancamiento_pipeline');
      expect(motivoStale.diasHabilesPipeline).toBeGreaterThan(45);
    });
  });

  // ===================================================================================================
  // TEST-4D-23: Identificación de borradores documentales
  // ===================================================================================================
  test('TEST-4D-23: Oferta y costos anteriores se rotulan explícitamente como borradores', async () => {
    // Al retroceder a cotización
    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'cierre',
      targetStage: 'negociacion',
      motivo: 'Regreso inicial a negociacion',
      opId: nextOpId()
    });

    await wf.revertStage({
      caller: caller('V1'),
      prospectId: 'P-CIERRE-1',
      currentStage: 'negociacion',
      targetStage: 'cotizacion',
      motivo: 'Regreso a cotización marcando propuestas como borrador',
      opId: nextOpId()
    });

    const p = await env.read('prospects_prod/P-CIERRE-1');
    expect(p.datos.estado_propuesta).toBe('borrador');
  });

  // ===================================================================================================
  // TEST-4D-24: Generación criptográfica de opId
  // ===================================================================================================
  test('TEST-4D-24: Generador criptográfico de opId produce identificadores únicos de alta entropía', () => {
    const op1 = CrmCommercial.newOpId();
    const op2 = CrmCommercial.generateCryptoOpId();

    expect(typeof op1).toBe('string');
    expect(typeof op2).toBe('string');
    expect(op1).not.toBe(op2);
    expect(op1.length).toBeGreaterThan(16);
    expect(op2.length).toBeGreaterThan(16);
  });
});
