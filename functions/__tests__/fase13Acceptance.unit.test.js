// functions/__tests__/fase13Acceptance.unit.test.js
// Automated test suite for Fase 1.3: Seguimiento comercial, permisos, alertas gerenciales y correcciones de interfaz

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const CrmFollowUpCalc = require('../../crm_followup_calc');

const CLOCK = new Date('2026-10-23T12:00:00.000Z');

function makeEnv() {
  const fdb = createFakeFirestore({ clock: () => CLOCK });
  const live = { ok: true, calls: [] };
  const service = createCommercialService({
    db: fdb,
    FieldValue: fdb.FieldValue,
    suffix: '_prod',
    now: () => CLOCK,
    verifyManager: async uid => {
      live.calls.push(uid);
      return live.ok;
    }
  });

  // Seed default clients
  fdb.collection('clients_prod').doc('C1').set({ id: 'C1', nombre: 'Cliente 1', empresa: 'Empresa 1', activo: true });
  fdb.collection('clients_prod').doc('C2').set({ id: 'C2', nombre: 'Cliente 2', empresa: 'Empresa 2', activo: true });

  const caller = (role, cid = 'USR-1', name = 'Usuario Test') => ({
    uid: `uid_${cid}`,
    cid,
    name,
    role
  });

  return { fdb, service, caller, now: CLOCK };
}

describe('Fase 1.3: Pruebas de Permisos, Alertas Gerenciales y Aceptación', () => {

  // -------------------------------------------------------------------------
  // 1 & 2: Aislamiento por Rol (Vendedor y Gestor Comercial)
  // -------------------------------------------------------------------------
  test('1 & 2. Vendedor y Gestor solo ven y gestionan sus propias oportunidades y agendas', async () => {
    const { service, caller } = makeEnv();

    const vendor1 = caller('vendedor', 'VEND-1', 'Vendedor Uno');
    const gestor1 = caller('gestor', 'GEST-1', 'Gestor Uno');
    const gestor2 = caller('gestor', 'GEST-2', 'Gestor Dos');

    // Create prospects
    const pVendor = await service.createProspect({
      caller: vendor1,
      data: { clientId: 'C1', proyecto: 'Proyecto V1', origen: 'Web', tipo_proyecto: 'obra', tipo_producto: 'ducto' },
      opId: 'op_v1_create'
    });
    const pGestor1 = await service.createProspect({
      caller: gestor1,
      data: { clientId: 'C2', proyecto: 'Proyecto G1', origen: 'Web', tipo_proyecto: 'obra', tipo_producto: 'ducto' },
      opId: 'op_g1_create'
    });

    // Gestor 2 tries to record follow-up on Gestor 1 prospect -> must be denied
    await expect(service.recordFollowUp({
      caller: gestor2,
      prospectId: pGestor1.prospect.id,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento de gestor ajeno' },
      opId: 'op_g2_unauth'
    })).rejects.toThrow();

    // Vendedor 1 tries to record follow-up on Gestor 1 prospect -> must be denied
    await expect(service.recordFollowUp({
      caller: vendor1,
      prospectId: pGestor1.prospect.id,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento de vendedor ajeno' },
      opId: 'op_v1_unauth'
    })).rejects.toThrow();

    // Gestor 1 CAN record follow-up on their own prospect
    const recG1 = await service.recordFollowUp({
      caller: gestor1,
      prospectId: pGestor1.prospect.id,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento propio de gestor 1' },
      opId: 'op_g1_auth'
    });
    expect(recG1.status).toBe('recorded');

    // Test CrmFollowUpCalc.generateAgenda isolation
    const universe = [
      { id: pVendor.prospect.id, vendedorId: 'VEND-1', estado: 'activo', seguimiento: { proxima_accion: { fecha: '2026-10-23' } } },
      { id: pGestor1.prospect.id, vendedorId: 'GEST-1', estado: 'activo', seguimiento: { proxima_accion: { fecha: '2026-10-23' } } }
    ];

    const agendaGestor1 = CrmFollowUpCalc.generateAgenda(universe, gestor1, 'todas');
    expect(agendaGestor1.items).toHaveLength(1);
    expect(agendaGestor1.items[0].id).toBe(pGestor1.prospect.id);

    const agendaGestor2 = CrmFollowUpCalc.generateAgenda(universe, gestor2, 'todas');
    expect(agendaGestor2.items).toHaveLength(0); // Gestor 2 has 0 access to Gestor 1 or Vendor 1

    const agendaVendor1 = CrmFollowUpCalc.generateAgenda(universe, vendor1, 'todas');
    expect(agendaVendor1.items).toHaveLength(1);
    expect(agendaVendor1.items[0].id).toBe(pVendor.prospect.id);
  });

  // -------------------------------------------------------------------------
  // 3 & 4: Gerente cartera completa, y Oportunidad Vencida NO genera alerta gerencial
  // -------------------------------------------------------------------------
  test('3 & 4. Gerente consulta cartera completa; vencimiento operativo ordinario NO genera alerta gerencial', () => {
    const manager = { uid: 'uid_MGR', cid: 'MGR-1', name: 'Gerente General', role: 'manager' };

    const universe = [
      {
        id: 'OPP-VENCIDA-1',
        codigo: 'VENC-01',
        proyecto: 'Vencida Ordinaria',
        estado: 'activo',
        vendedorId: 'VEND-1',
        vendedor: 'Roberto Flores',
        seguimiento: {
          proxima_accion: { fecha: '2026-10-20' }, // Vencida hace 3 días
          cadencia: {
            intentos_validos_sin_respuesta: 2, // Solo 2 intentos
            alerta_gerencial: false
          }
        }
      },
      {
        id: 'OPP-NORMAL-2',
        codigo: 'NORM-02',
        proyecto: 'Normal',
        estado: 'activo',
        vendedorId: 'GEST-1',
        vendedor: 'Gestor Uno',
        seguimiento: {
          proxima_accion: { fecha: '2026-10-23' },
          cadencia: { intentos_validos_sin_respuesta: 1 }
        }
      }
    ];

    // Gerente generateAgenda: NO recibe la agenda diaria global de llamadas ordinarias
    const agendaMgr = CrmFollowUpCalc.generateAgenda(universe, manager, 'todas');
    expect(agendaMgr.items).toHaveLength(0); // Ni vencidas ordinarias ni rutinarias aparecen en su agenda si no están escaladas

    // Si existe una oportunidad escalada a gerencia, el Gerente sí la recibe en su agenda
    const oppEscalada = {
      id: 'OPP-ESC-1',
      codigo: 'ESC-01',
      proyecto: 'Escalada Gerencial',
      estado: 'activo',
      vendedorId: 'VEND-1',
      seguimiento: {
        cadencia: {
          estado_cadencia: 'alerta_gerencial',
          intentos_validos_sin_respuesta: 5
        }
      }
    };
    const agendaWithEscalation = CrmFollowUpCalc.generateAgenda([...universe, oppEscalada], manager, 'todas');
    expect(agendaWithEscalation.items).toHaveLength(1);
    expect(agendaWithEscalation.items[0].id).toBe('OPP-ESC-1');

    // Manager Attention calculation: OPP-VENCIDA-1 must NOT trigger manager attention!
    const mgrAttention = CrmFollowUpCalc.calculateManagerAttentionItems(universe);
    expect(mgrAttention.pendingUniqueCount).toBe(0);
    expect(mgrAttention.counts.pendientes).toBe(0);
    expect(mgrAttention.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5 & 6 & 7: 5 intentos válidos generan alerta gerencial; notas internas / idempotencia no incrementan
  // -------------------------------------------------------------------------
  test('5, 6 & 7. 5 intentos válidos sin respuesta generan alerta gerencial; notas internas y reintentos no incrementan', async () => {
    const { service, caller } = makeEnv();
    const vendor = caller('vendedor', 'VEND-1', 'Roberto Flores');

    const created = await service.createProspect({
      caller: vendor,
      data: { clientId: 'C1', proyecto: 'Torre 5', origen: 'Web', tipo_proyecto: 'obra', tipo_producto: 'ducto' },
      opId: 'op_torre5_create'
    });
    const pid = created.prospect.id;

    // Set oferta entregada
    await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento 1', fechaEntregaOferta: '2026-10-01' },
      opId: 'op_t5_att1'
    });

    // Intento 2
    await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento 2' },
      opId: 'op_t5_att2'
    });

    // Intento 3
    await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento 3' },
      opId: 'op_t5_att3'
    });

    // Internal note -> must NOT increment failed attempts
    const rNote = await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'interno', resultado: 'nota_interna', detalle: 'Nota interna de revisión de planos' },
      opId: 'op_t5_note'
    });
    expect(rNote.seguimiento.cadencia.intentos_validos_sin_respuesta).toBe(3);

    // Idempotent retry of attempt 3 -> must NOT increment
    const rRetry = await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento 3' },
      opId: 'op_t5_att3'
    });
    expect(rRetry.replay).toBe(true);
    expect(rRetry.seguimiento.cadencia.intentos_validos_sin_respuesta).toBe(3);

    // Vendor justification required to continue after attempt 3
    await expect(service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: { canal: 'llamada', resultado: 'sin_respuesta', detalle: 'Intento 4' },
      opId: 'op_t5_att4_fail'
    })).rejects.toThrow();

    // Attempt 4 with vendor justification
    await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Intento 4',
        justificacionContinuidad: 'Cliente en licitación clave, vale la pena insistir'
      },
      opId: 'op_t5_att4_ok'
    });

    // Attempt 5 -> ESCALATES TO MANAGER
    const rAtt5 = await service.recordFollowUp({
      caller: vendor,
      prospectId: pid,
      data: {
        canal: 'llamada',
        resultado: 'sin_respuesta',
        detalle: 'Intento 5',
        justificacionContinuidad: 'Cliente en licitación clave, vale la pena insistir'
      },
      opId: 'op_t5_att5_ok'
    });

    expect(rAtt5.seguimiento.cadencia.intentos_validos_sin_respuesta).toBe(5);
    expect(rAtt5.seguimiento.cadencia.alerta_gerencial).toBe(true);
    expect(rAtt5.seguimiento.cadencia.estado_cadencia).toMatch(/^escalad[ao]_gerencia$/);

    // Check manager attention calculation
    const opEscalada = {
      id: pid,
      codigo: 'TORRE-05',
      proyecto: 'Torre 5',
      clientId: 'C1',
      vendedorId: 'VEND-1',
      vendedor: 'Roberto Flores',
      estado: 'activo',
      seguimiento: rAtt5.seguimiento
    };

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([opEscalada]);
    expect(attention.pendingUniqueCount).toBe(1);
    expect(attention.items[0].isPending).toBe(true);
    expect(attention.items[0].motivoPrincipal).toMatch(/Cinco intentos/);
    expect(attention.items[0].justificacionVendedor).toBe('Cliente en licitación clave, vale la pena insistir');
  });

  // -------------------------------------------------------------------------
  // 9, 10, 11 & 12: Decisiones Gerenciales (Opción 1 y Opción 2)
  // -------------------------------------------------------------------------
  test('9, 10, 11 & 12. Gerente puede autorizar continuidad u ordenar cierre; conserva historial y actualiza estado de alerta', async () => {
    const { service, caller, fdb } = makeEnv();
    const vendor = caller('vendedor', 'VEND-1', 'Roberto Flores');
    const manager = caller('manager', 'MGR-1', 'Gerente Ventas');

    // Case A: Autorizar Continuar
    const opA = await service.createProspect({
      caller: vendor,
      data: { clientId: 'C1', proyecto: 'Proyecto A', origen: 'Web', tipo_proyecto: 'obra', tipo_producto: 'ducto' },
      opId: 'op_a_create'
    });
    const pidA = opA.prospect.id;

    // Simulate 5 attempts on opA
    await fdb.collection('prospects_prod').doc(pidA).update({
      seguimiento: {
        cadencia: {
          intentos_validos_sin_respuesta: 5,
          intentos_fallidos: 5,
          alerta_gerencial: true,
          estado_cadencia: 'escalada_gerencia'
        }
      }
    });

    // Non-manager cannot resolve escalation
    await expect(service.resolveFollowUpEscalation({
      caller: vendor,
      prospectId: pidA,
      decision: 'autorizar_continuar',
      justificacion: 'Quiero seguir',
      proximaAccion: { fecha: '2026-10-30', tipo: 'llamada' },
      opId: 'op_esc_vend_fail'
    })).rejects.toThrow();

    // Manager requires justification >= 5 chars
    await expect(service.resolveFollowUpEscalation({
      caller: manager,
      prospectId: pidA,
      decision: 'autorizar_continuar',
      justificacion: 'ok',
      proximaAccion: { fecha: '2026-10-30', tipo: 'llamada' },
      opId: 'op_esc_short_fail'
    })).rejects.toThrow();

    // Manager authorizes continuation
    const resAuth = await service.resolveFollowUpEscalation({
      caller: manager,
      prospectId: pidA,
      decision: 'autorizar_continuar',
      justificacion: 'Autorizado porque el cliente está gestionando fondos bancarios',
      proximaAccion: { fecha: '2026-10-30', tipo: 'llamada', descripcion: 'Llamar a tesorería' },
      opId: 'op_esc_auth_ok'
    });

    expect(resAuth.status).toBe('resolved');
    expect(resAuth.seguimiento.cadencia.alerta_gerencial).toBe(false);
    expect(resAuth.seguimiento.cadencia.estado_cadencia).toBe('continuidad_autorizada');
    // History and attempts preserved (not reset to 0)
    expect(resAuth.seguimiento.cadencia.intentos_validos_sin_respuesta).toBe(5);
    expect(resAuth.seguimiento.proxima_accion.fecha).toBe('2026-10-30');

    // Manager Attention calculation: Authorized alert is NO LONGER counted as pending!
    const snapA = await fdb.collection('prospects_prod').doc(pidA).get();
    const dataA = snapA.data();
    const checkA = CrmFollowUpCalc.calculateManagerAttentionItems([dataA], [], { filterEstado: 'pendientes' });
    expect(checkA.pendingUniqueCount).toBe(0);
    expect(checkA.counts.pendientes).toBe(0);

    // But queryable with filterEstado: 'autorizadas' or 'todas'
    const checkHistA = CrmFollowUpCalc.calculateManagerAttentionItems([dataA], [], { filterEstado: 'autorizadas' });
    expect(checkHistA.items).toHaveLength(1);
    expect(checkHistA.items[0].alerta_estado).toBe('continuidad_autorizada');

    // Case B: Ordenar Cierre Inmediato (markLost)
    const opB = await service.createProspect({
      caller: vendor,
      data: { clientId: 'C2', proyecto: 'Proyecto B', origen: 'Web', tipo_proyecto: 'obra', tipo_producto: 'ducto' },
      opId: 'op_b_create'
    });
    const pidB = opB.prospect.id;

    await fdb.collection('prospects_prod').doc(pidB).update({
      seguimiento: {
        cadencia: {
          intentos_validos_sin_respuesta: 5,
          intentos_fallidos: 5,
          alerta_gerencial: true,
          estado_cadencia: 'escalada_gerencia'
        }
      }
    });

    // Invalid loss reason fails
    await expect(service.resolveFollowUpEscalation({
      caller: manager,
      prospectId: pidB,
      decision: 'ordenar_cierre',
      motivo: 'Motivo Inventado Inexistente',
      ejecutarCierre: true,
      opId: 'op_esc_bad_reason'
    })).rejects.toThrow();

    // Order closure immediate with valid reason
    const resClose = await service.resolveFollowUpEscalation({
      caller: manager,
      prospectId: pidB,
      decision: 'ordenar_cierre',
      motivo: 'Cliente desiste',
      justificacion: 'No hubo interés tras 5 llamadas y correo formal',
      ejecutarCierre: true,
      opId: 'op_esc_close_ok'
    });

    expect(resClose.status).toBe('resolved');
    expect(resClose.estado).toBe('perdido');

    const snapB = await fdb.collection('prospects_prod').doc(pidB).get();
    const dataB = snapB.data();
    expect(dataB.estado).toBe('perdido');
    expect(dataB.motivo_perdida).toBe('Cliente desiste');
    expect(dataB.seguimiento.cadencia.alerta_gerencial).toBe(false);

    // Idempotent replay with same opId returns replay: true
    const replayClose = await service.resolveFollowUpEscalation({
      caller: manager,
      prospectId: pidB,
      decision: 'ordenar_cierre',
      motivo: 'Cliente desiste',
      ejecutarCierre: true,
      opId: 'op_esc_close_ok'
    });
    expect(replayClose.replay).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 13 & 15: Deduplicación de Oportunidades y Conteo Exacto del Dashboard
  // -------------------------------------------------------------------------
  test('13 & 15. Una oportunidad con múltiples motivos de atención se cuenta una sola vez en el total', () => {
    const oppMultipleReasons = {
      id: 'OPP-MULTI-1',
      codigo: 'MULTI-01',
      proyecto: 'Obra Compleja',
      clientId: 'C1',
      vendedorId: 'VEND-1',
      estado: 'activo',
      solicitud_sin_contrato: {
        id: 'REQ-1',
        estado: 'pendiente',
        motivo: 'Cliente pide iniciar fabricación antes de firma de contrato'
      },
      seguimiento: {
        cadencia: {
          intentos_validos_sin_respuesta: 5,
          alerta_gerencial: true,
          estado_cadencia: 'escalada_gerencia'
        }
      }
    };

    const attention = CrmFollowUpCalc.calculateManagerAttentionItems([oppMultipleReasons]);
    // Count must be exactly 1 unique opportunity
    expect(attention.pendingUniqueCount).toBe(1);
    expect(attention.items).toHaveLength(1);
    // Both reasons must be visible in the item reasons array
    expect(attention.items[0].motivos[0]).toMatch(/Cinco intentos/);
    expect(attention.items[0].motivos[1]).toMatch(/sin contrato/);
  });

  // -------------------------------------------------------------------------
  // 14 & 16: Atribución Alejandra Ayala / Roberto Flores y Compatibilidad Histórica
  // -------------------------------------------------------------------------
  test('14 & 16. Alejandra Ayala y Roberto Flores se resuelven canónicamente; registros antiguos sin seguimiento funcionan', () => {
    const usersDirectory = [
      { id: '1776904514932', nombre: 'Alejandra Ayala', role: 'vendedor' },
      { id: '1788471603604', nombre: 'Roberto Flores', role: 'vendedor' }
    ];

    // Historical prospect created by Alejandra Ayala without vendedorName and without seguimiento
    const histAlejandra = {
      id: 'HIST-AA-1',
      codigo: 'HIST-01',
      proyecto: 'Colegio Maya',
      createdBy: '1776904514932',
      estado: 'activo'
    };

    // Historical prospect created by Roberto Flores
    const histRoberto = {
      id: 'HIST-RF-1',
      codigo: 'HIST-02',
      proyecto: 'Plaza Futura',
      createdBy: '1788471603604',
      estado: 'activo'
    };

    // Truly unassigned prospect
    const histUnassigned = {
      id: 'HIST-UNASSIGNED',
      codigo: 'HIST-03',
      proyecto: 'Huérfano',
      estado: 'activo'
    };

    expect(CrmFollowUpCalc.resolveSellerName(histAlejandra, usersDirectory)).toBe('Alejandra Ayala');
    expect(CrmFollowUpCalc.resolveSellerName(histRoberto, usersDirectory)).toBe('Roberto Flores');
    expect(CrmFollowUpCalc.resolveSellerName(histUnassigned, usersDirectory)).toBe('Sin Asignar');

    // When global directory is present, canonical directory resolution works without passing dir explicitly
    globalThis.users = usersDirectory;
    expect(CrmFollowUpCalc.resolveSellerName(histAlejandra)).toBe('Alejandra Ayala');
    expect(CrmFollowUpCalc.resolveSellerName(histRoberto)).toBe('Roberto Flores');
    expect(CrmFollowUpCalc.resolveSellerName(histUnassigned)).toBe('Sin Asignar');
    delete globalThis.users;

    // Historical prospect without seguimiento operates in classifyFollowUp without error
    const clasif = CrmFollowUpCalc.classifyFollowUp(histAlejandra, CLOCK);
    expect(clasif).not.toBeNull();
    expect(clasif.status).toBe('sin_seguimiento');

    // Historical prospect in generateAgenda doesn't crash
    const agenda = CrmFollowUpCalc.generateAgenda([histAlejandra, histRoberto, histUnassigned], { uid: 'uid_RF', cid: '1788471603604', role: 'vendedor' });
    expect(agenda.counts.total).toBe(1); // 1 assigned to Roberto
    expect(agenda.items[0].id).toBe('HIST-RF-1');
  });
});
