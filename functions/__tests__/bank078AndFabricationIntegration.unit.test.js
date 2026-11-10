'use strict';

/**
 * DUCTSAL ERP — Pruebas unitarias e integración backend:
 * Tarea A: Resolución auditada de referencia histórica BANK_078 y prevención de liberación prematura.
 * Tarea B: Integración efectiva del bloqueo financiero de anticipo con el sistema real de Fabricación.
 */

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const {
  BANK_078_RESOLUTION_SPEC,
  runResolution
} = require('../scripts/resolveBank078Prod');

describe('Tarea A y Tarea B — Resolución BANK_078 e Integración Real con Fabricación', () => {
  const fileObj = (name, folder = 'pagos') => ({
    name,
    type: 'application/pdf',
    size: 4096,
    data: `https://firebasestorage.googleapis.com/v0/b/ductsal-erp.appspot.com/o/prod_files%2F${folder}%2F${encodeURIComponent(name)}?alt=media`,
    storagePath: `prod_files/${folder}/${name}`,
    uploadedAt: '2026-11-09T12:00:00.000Z'
  });

  const makeEnv = () => {
    let clock = 1794200000000;
    const fdb = createFakeFirestore({
      clock: () => {
        clock += 1000;
        return new Date(clock);
      }
    });
    const service = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
      verifyManager: async () => true
    });
    const wf = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: service.kit
    });
    const caller = (role, cid = `USR-${role.toUpperCase()}`, name = `Usuario ${role}`) => ({
      uid: `uid-${cid}`,
      cid,
      id: cid,
      name,
      nombre: name,
      role,
      active: true
    });
    return { fdb, service, wf, caller };
  };

  const seedBank078Scenario = async (fdb) => {
    await fdb.seed('clients_prod/CUST-1777081077121-95', {
      id: 'CUST-1777081077121-95',
      tipo: 'juridica',
      empresa: 'CONSTRU-SERVICES, S.A. DE C.V.',
      nit: '0614-290115-102-8',
      nrc: '239919-0',
      es_exportacion: false,
      is_gran_contribuyente: false,
      documentos: {
        dui: fileObj('dui.pdf', 'clientes'),
        nit: fileObj('nit.pdf', 'clientes'),
        nrc: fileObj('nrc.pdf', 'clientes'),
        escritura: fileObj('escritura.pdf', 'clientes'),
        credencial: fileObj('credencial.pdf', 'clientes')
      }
    });

    await fdb.seed('prospects_prod/1779123328318', {
      id: '1779123328318',
      codigo: '202605023',
      clientId: 'CUST-1777081077121-95',
      proyecto: 'PRESURIZACION',
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      precio_cotizado: 16214.5, // + IVA = 18322.39 -> 50% = 9161.19
      forma_pago: '50/50',
      datos: {
        forma_pago: '50/50',
        doc_firmado: fileObj('CONTRATO_FIRMADO_DESIRE.pdf', 'proyectos')
      },
      facturas: [
        {
          id: '1789408613812',
          numero: '078',
          monto: 9161.19,
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileObj('CCF 50% ANTICIPO.pdf', 'facturas'),
          pagos: [
            {
              fecha: '2026-09-14T19:13:28.456Z',
              monto: 9161.19,
              metodo: 'transferencia',
              ref: '078',
              doc_comprobante: fileObj('PAGO 50%.jpg', 'pagos')
            }
          ]
        }
      ]
    });

    await fdb.seed('prospects_prod/OPP-1777081077278-7', {
      id: 'OPP-1777081077278-7',
      codigo: null,
      clientId: 'CUST-1777081077121-95',
      proyecto: 'EDIFICIO DESIRE',
      estado: 'ganado',
      etapa: 'cierre',
      postcierre_habilitado: true,
      precio_cotizado: 13844.81, // + IVA = 15644.64 -> 50% = 7822.32
      forma_pago: '50/50',
      datos: {
        forma_pago: '50/50',
        doc_firmado: fileObj('CONTRATO_FIRMADO_DESIRE.pdf', 'proyectos')
      },
      facturas: [
        {
          id: '1789408531939',
          numero: '078',
          monto: 7822.32,
          es_anticipo: true,
          tipo_factura: 'anticipo',
          doc_factura: fileObj('CCF 50% ANTICIPO.pdf', 'facturas'),
          pagos: [
            {
              fecha: '2026-09-14T19:11:44.724Z',
              monto: 7822.32,
              metodo: 'transferencia',
              ref: '078',
              doc_comprobante: fileObj('PAGO 50%.jpg', 'pagos')
            }
          ]
        }
      ]
    });

    await fdb.seed('payment_refs_prod/BANK_078', {
      lockId: 'BANK_078',
      kind: 'bank',
      normRef: '078',
      rawRef: '078',
      active: true,
      estado: 'conflicto_historico',
      conflicto_historico: true,
      prospectId: null,
      invoiceId: null,
      paymentId: null,
      paymentKey: null,
      conflictCount: 2,
      conflictPayments: [
        {
          prospectId: '1779123328318',
          codigo: '202605023',
          clientId: 'CUST-1777081077121-95',
          invoiceId: '1789408613812',
          invoiceNumero: '078',
          paymentId: null,
          paymentKey: '2026-09-14T19:13:28.456Z',
          monto: 9161.19,
          metodo: 'transferencia',
          rawRef: '078',
          fecha: '2026-09-14T19:13:28.456Z'
        },
        {
          prospectId: 'OPP-1777081077278-7',
          codigo: null,
          clientId: 'CUST-1777081077121-95',
          invoiceId: '1789408531939',
          invoiceNumero: '078',
          paymentId: null,
          paymentKey: '2026-09-14T19:11:44.724Z',
          monto: 7822.32,
          metodo: 'transferencia',
          rawRef: '078',
          fecha: '2026-09-14T19:11:44.724Z'
        }
      ]
    });
  };

  describe('Tarea A — Referencia histórica BANK_078 y prevención de liberación prematura', () => {
    test('A1. Bloquea reutilización de 078 mientras persista colisión y NO libera prematuramente BANK_078 al editar uno solo de los pagos', async () => {
      const { fdb, wf, caller } = makeEnv();
      await seedBank078Scenario(fdb);
      const gestor = caller('gestor', 'GESTOR-01', 'Gestor Financiero');

      // 1. Intentar usar '078' en un nuevo pago se rechaza
      await expect(wf.savePayment({
        caller: gestor,
        prospectId: '1779123328318',
        invoiceId: '1789408613812',
        opId: 'OP-NEW-078',
        monto: 100,
        metodo: 'transferencia',
        ref: '078',
        doc_comprobante: fileObj('new078.pdf')
      })).rejects.toThrow('Este número de comprobante ya fue registrado en otro pago. Verifique la referencia antes de continuar.');

      // 2. Editar Pago 1 cambiando su referencia a '910440001':
      // BANK_078 NO debe quedar libre (`active: false`) porque aún queda Pago 2 con ref '078'
      const editPay1 = await wf.savePayment({
        caller: gestor,
        prospectId: '1779123328318',
        invoiceId: '1789408613812',
        paymentKey: '2026-09-14T19:13:28.456Z',
        monto: 9161.19,
        metodo: 'transferencia',
        ref: '910440001'
      });
      expect(editPay1.status).toBe('updated');

      const bank078AfterFirstEdit = (await fdb.collection('payment_refs_prod').doc('BANK_078').get()).data();
      expect(bank078AfterFirstEdit.active).toBe(true);
      expect(bank078AfterFirstEdit.estado).toBe('conflicto_historico');
      expect(bank078AfterFirstEdit.conflicto_historico).toBe(true);
      expect(bank078AfterFirstEdit.remainingConflictCount).toBe(1);
      expect(bank078AfterFirstEdit.conflictPayments).toHaveLength(1);
      expect(bank078AfterFirstEdit.conflictPayments[0].prospectId).toBe('OPP-1777081077278-7');

      // 3. Intentar reutilizar '078' en un tercer pago sigue bloqueado porque BANK_078 sigue activo en conflicto_historico
      await expect(wf.savePayment({
        caller: gestor,
        prospectId: '1779123328318',
        invoiceId: '1789408613812',
        opId: 'OP-TRY-078-AFTER-ONE-EDIT',
        monto: 50,
        metodo: 'transferencia',
        ref: '078',
        doc_comprobante: fileObj('try078.pdf')
      })).rejects.toThrow('Este número de comprobante ya fue registrado en otro pago. Verifique la referencia antes de continuar.');

      // 4. Editar también Pago 2 cambiando su referencia a '910440002':
      // Cuando ya no quedan pagos en colisión (0 restantes), BANK_078 pasa a 'resuelto_historico' con trazabilidad completa
      const editPay2 = await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-1777081077278-7',
        invoiceId: '1789408531939',
        paymentKey: '2026-09-14T19:11:44.724Z',
        monto: 7822.32,
        metodo: 'transferencia',
        ref: '910440002'
      });
      expect(editPay2.status).toBe('updated');

      const bank078AfterFullResolution = (await fdb.collection('payment_refs_prod').doc('BANK_078').get()).data();
      expect(bank078AfterFullResolution.active).toBe(false);
      expect(bank078AfterFullResolution.estado).toBe('resuelto_historico');
      expect(bank078AfterFullResolution.conflicto_historico).toBe(false);
      expect(bank078AfterFullResolution.remainingConflictCount).toBe(0);
      expect(bank078AfterFullResolution.conflictPayments).toEqual([]);
      expect(bank078AfterFullResolution.resolutionDetail).toEqual(expect.objectContaining({
        resolvedVia: 'all_conflicting_payments_remediated',
        lastReleasedProspectId: 'OPP-1777081077278-7',
        lastReleasedInvoiceId: '1789408531939'
      }));
    });

    test('A2. Resolución auditada Caso B (Transferencia única distribuida US$16,983.51 / ref bancaria única 868355650) conserva ref 868355650 en ambos pagos, separa aplicacion_id e indexa las 7 secciones en BANK_868355650', async () => {
      const { fdb, wf, caller } = makeEnv();
      await seedBank078Scenario(fdb);
      const gestor = caller('gestor', 'GESTOR-01', 'Gestor Financiero');
      const manager = caller('manager', 'GER-01', 'Gerente');

      // 1. Inspección dry-run
      const dryRunRes = await runResolution({ db: fdb, FieldValue: fdb.FieldValue, apply: false });
      expect(dryRunRes.status).toBe('dry_run_ready');
      expect(dryRunRes.mode).toBe('DRY_RUN_READ_ONLY');
      expect(dryRunRes.bank078Exists).toBe(true);
      expect(dryRunRes.bank868355650Exists).toBe(false);
      expect(dryRunRes.spec.totalVoucherAmount).toBe(16983.51);

      // 1b. Rechazo si la suma de aplicaciones supera el importe total del comprobante (ej. comprobante declarado menor a US$16,983.51)
      await expect(wf.resolveHistoricalBankConflict({
        caller: manager,
        lockId: 'BANK_078',
        resolutionMode: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
        baseBankRef: '868355650',
        totalVoucherAmount: 16000.00,
        tranches: BANK_078_RESOLUTION_SPEC.tranches,
        notes: 'Intento con suma de aplicaciones mayor al comprobante'
      })).rejects.toThrow(/supera el importe total del comprobante bancario/);

      // 1c. Rechazo si no se incluyen TODOS los pagos en conflicto de BANK_078 antes de intentar cerrarlo
      await expect(wf.resolveHistoricalBankConflict({
        caller: manager,
        lockId: 'BANK_078',
        resolutionMode: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
        baseBankRef: '868355650',
        totalVoucherAmount: 9161.19,
        allowPartialDistribution: true,
        tranches: [
          BANK_078_RESOLUTION_SPEC.tranches[0],
          {
            prospectId: '1779123328318',
            invoiceId: '1789408613812',
            paymentKey: '2026-09-14T19:13:28.456Z',
            applicationId: 'APP_DUP'
          }
        ],
        notes: 'Intento omitiendo el segundo pago en conflicto'
      })).rejects.toThrow();

      // 2. Ejecutar resolución Caso B mediante script idempotente
      const res = await runResolution({
        db: fdb,
        FieldValue: fdb.FieldValue,
        apply: true
      });
      expect(res.status).toBe('resolved');
      expect(res.parentBankLockId).toBe('BANK_868355650');
      expect(res.resolutionDetail.caseType).toBe('CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE');
      expect(res.resolutionDetail.totalVoucherAmount).toBe(16983.51);
      expect(res.resolutionDetail.totalAppliedAmount).toBe(16983.51);
      expect(res.resolutionDetail.availableVoucherBalance).toBe(0);

      // 3. Re-ejecución es idempotente
      const replay = await runResolution({
        db: fdb,
        FieldValue: fdb.FieldValue,
        apply: true
      });
      expect(replay.status).toBe('already_resolved');
      expect(replay.replay).toBe(true);

      // 4. Verificar que ambos pagos existen, conservan intactos sus montos (9161.19 y 7822.32),
      // tienen la referencia bancaria verdadera única '868355650' (NO sub-referencias ficticias) y aplicacion_id separado
      const opp1 = (await fdb.collection('prospects_prod').doc('1779123328318').get()).data();
      const opp2 = (await fdb.collection('prospects_prod').doc('OPP-1777081077278-7').get()).data();
      const p1 = opp1.facturas[0].pagos[0];
      const p2 = opp2.facturas[0].pagos[0];

      expect(p1.monto).toBe(9161.19);
      expect(p1.ref).toBe('868355650');
      expect(p1.ref_normalizada).toBe('868355650');
      expect(p1.ref_historica_original).toBe('078');
      expect(p1.aplicacion_id).toBe('APP_868355650_1779123328318_1789408613812');
      expect(p1.tramo_id).toBe('TRAMO_868355650_1');
      expect(p1.entry_id).toBe('1779123328318__1789408613812');
      expect(p1.pago_compartido).toEqual(expect.objectContaining({
        es_tramo_compartido: true,
        aplicacion_id: 'APP_868355650_1779123328318_1789408613812',
        ref_bancaria_unica: '868355650',
        importe_total_comprobante: 16983.51,
        monto_aplicado: 9161.19,
        total_aplicado: 16983.51,
        saldo_disponible_comprobante: 0
      }));

      expect(p2.monto).toBe(7822.32);
      expect(p2.ref).toBe('868355650');
      expect(p2.ref_normalizada).toBe('868355650');
      expect(p2.ref_historica_original).toBe('078');
      expect(p2.aplicacion_id).toBe('APP_868355650_OPP-1777081077278-7_1789408531939');
      expect(p2.tramo_id).toBe('TRAMO_868355650_2');
      expect(p2.entry_id).toBe('OPP-1777081077278-7__1789408531939');
      expect(p2.pago_compartido).toEqual(expect.objectContaining({
        es_tramo_compartido: true,
        aplicacion_id: 'APP_868355650_OPP-1777081077278-7_1789408531939',
        ref_bancaria_unica: '868355650',
        importe_total_comprobante: 16983.51,
        monto_aplicado: 7822.32,
        total_aplicado: 16983.51,
        saldo_disponible_comprobante: 0
      }));

      // 5. Verificar que ambas oportunidades siguen con 100% de su anticipo confirmado y habilitadas para fabricación
      const ready1 = await wf.validateManufacturingReadiness({ caller: gestor, prospectId: '1779123328318' });
      const ready2 = await wf.validateManufacturingReadiness({ caller: gestor, prospectId: 'OPP-1777081077278-7' });
      expect(ready1.ready).toBe(true);
      expect(ready1.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');
      expect(ready2.ready).toBe(true);
      expect(ready2.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');

      // 6. Verificar estado de BANK_078 y las 7 secciones de BANK_868355650 en payment_refs_prod (sin sub-locks ficticios)
      const bank078 = (await fdb.collection('payment_refs_prod').doc('BANK_078').get()).data();
      expect(bank078.active).toBe(false);
      expect(bank078.estado).toBe('resuelto_historico');
      expect(bank078.conflicto_historico).toBe(false);

      const fakeSub1 = await fdb.collection('payment_refs_prod').doc('BANK_868355650202605023').get();
      const fakeSub2 = await fdb.collection('payment_refs_prod').doc('BANK_868355650DESIRE').get();
      expect(fakeSub1.exists).toBe(false);
      expect(fakeSub2.exists).toBe(false);

      const bankMother = (await fdb.collection('payment_refs_prod').doc('BANK_868355650').get()).data();
      expect(bankMother.active).toBe(true);
      expect(bankMother.estado).toBe('distribuido_auditado');
      expect(bankMother.es_comprobante_distribuido).toBe(true);
      expect(bankMother.reutilizacion_bloqueada).toBe(true);
      // Sección 1: Transacción bancaria original
      expect(bankMother.transaccion_bancaria).toEqual(expect.objectContaining({
        referencia_bancaria: '868355650',
        importe_total_comprobante: 16983.51,
        cliente_id: 'CUST-1777081077121-95'
      }));
      // Sección 2: Referencia bancaria única
      expect(bankMother.ref).toBe('868355650');
      expect(bankMother.normRef).toBe('868355650');
      // Sección 3: Importe total del comprobante
      expect(bankMother.importe_total_comprobante).toBe(16983.51);
      // Sección 4: Aplicaciones individuales a facturas
      expect(bankMother.aplicaciones).toHaveLength(2);
      expect(bankMother.aplicaciones.map(a => a.monto_aplicado)).toEqual([9161.19, 7822.32]);
      expect(bankMother.aplicaciones.map(a => a.ref)).toEqual(['868355650', '868355650']);
      // Sección 5: Total aplicado
      expect(bankMother.total_aplicado).toBe(16983.51);
      // Sección 6: Saldo disponible del comprobante
      expect(bankMother.saldo_disponible).toBe(0);
      // Sección 7: Auditoría de cada aplicación
      expect(bankMother.auditoria.aplicaciones_auditadas).toHaveLength(2);

      // 7. Intentar reutilizar la referencia bancaria única '868355650' en un tercer pago nuevo es rechazado
      await expect(wf.savePayment({
        caller: gestor,
        prospectId: '1779123328318',
        invoiceId: '1789408613812',
        opId: 'OP-BLOCK-868355650',
        monto: 100,
        metodo: 'transferencia',
        ref: '868355650',
        doc_comprobante: fileObj('dup.pdf')
      })).rejects.toThrow('Este número de comprobante ya fue registrado en otro pago. Verifique la referencia antes de continuar.');
    });

    test('A3. Soporta Caso A (propietario único legítimo) cuando los demás pagos fueron re-referenciados y un único pago mantiene la referencia original', async () => {
      const { fdb, wf, caller } = makeEnv();
      await seedBank078Scenario(fdb);
      const gestor = caller('gestor', 'GESTOR-01', 'Gestor Financiero');
      const manager = caller('manager', 'GER-01', 'Gerente');

      // Primero corregir el pago 2 a su referencia independiente
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-1777081077278-7',
        invoiceId: '1789408531939',
        paymentKey: '2026-09-14T19:11:44.724Z',
        monto: 7822.32,
        metodo: 'transferencia',
        ref: 'TRX-CORREGIDA-999'
      });

      // Ahora en BANK_078 solo queda el pago 1 como propietario legítimo
      const res = await wf.resolveHistoricalBankConflict({
        caller: manager,
        lockId: 'BANK_078',
        resolutionMode: 'CASO_A_PROPIETARIO_UNICO_LEGITIMO',
        legitimateOwner: {
          prospectId: '1779123328318',
          invoiceId: '1789408613812',
          paymentKey: '2026-09-14T19:13:28.456Z'
        },
        notes: 'Pago 1 mantiene 078 y Pago 2 corrigió su referencia a TRX-CORREGIDA-999'
      });

      expect(res.status).toBe('resolved_single_owner');
      const bank078 = (await fdb.collection('payment_refs_prod').doc('BANK_078').get()).data();
      expect(bank078.active).toBe(true);
      expect(bank078.estado).toBe('activo');
      expect(bank078.conflicto_historico).toBe(false);
      expect(bank078.prospectId).toBe('1779123328318');

      const newLock = (await fdb.collection('payment_refs_prod').doc('BANK_TRXCORREGIDA999').get()).data();
      expect(newLock.active).toBe(true);
      expect(newLock.prospectId).toBe('OPP-1777081077278-7');
    });
  });

  describe('Tarea B — Integración efectiva del control de anticipo con Fabricación', () => {
    const baseClient = {
      id: 'CLI-FAB-01',
      tipo: 'juridica',
      empresa: 'CONSTRUCTORA DEL PACIFICO S.A. DE C.V.',
      nit: '0614-010110-101-1',
      nrc: '112233-4',
      es_exportacion: false,
      is_gran_contribuyente: false,
      documentos: {
        dui: fileObj('dui.pdf', 'clientes'),
        nit: fileObj('nit.pdf', 'clientes'),
        nrc: fileObj('nrc.pdf', 'clientes'),
        escritura: fileObj('escritura.pdf', 'clientes'),
        credencial: fileObj('credencial.pdf', 'clientes')
      }
    };

    const seedClosedOpportunity = async (fdb, {
      id = 'OPP-FAB-50',
      codigo = '202611500',
      clientId = 'CLI-FAB-01',
      formaPago = '50/50',
      precioCotizado = 10000, // +13% IVA = 11300
      pagos = []
    } = {}) => {
      const totalContrato = Number((precioCotizado * 1.13).toFixed(2));
      const pct = formaPago === '100% anticipado' ? 1 : formaPago === '70/30' ? 0.7 : 0.5;
      const montoAnticipo = Number((totalContrato * pct).toFixed(2));

      await fdb.seed(`prospects_prod/${id}`, {
        id,
        codigo,
        clientId,
        empresa: 'CONSTRUCTORA DEL PACIFICO S.A. DE C.V.',
        proyecto: `Proyecto ${codigo}`,
        tipo_proyecto: 'Fabricación',
        etapa: 'cierre',
        estado: 'ganado',
        postcierre_habilitado: true,
        vendedorId: 'ALEJANDRA-AYALA',
        vendedorName: 'Alejandra Ayala',
        precio_cotizado: precioCotizado,
        forma_pago: formaPago,
        datos: {
          forma_pago: formaPago,
          doc_firmado: fileObj('contrato.pdf', 'proyectos')
        },
        factura_anticipo_id: `INV-${id}`,
        facturas: [
          {
            id: `INV-${id}`,
            numero: `CCF-${codigo}`,
            monto: montoAnticipo,
            es_anticipo: true,
            tipo_factura: 'anticipo',
            doc_factura: fileObj('ccf.pdf', 'facturas'),
            pagos
          }
        ]
      });
    };

    test('B1. Oportunidad 50/50 sin anticipo -> bloqueada para enviar a fabricación y para crear/liberar órdenes con mensaje exacto', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-50-UNPAID', codigo: '202611501', formaPago: '50/50', pagos: [] });

      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      await expect(wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-50-UNPAID'
      })).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$5,650.00.'),
        details: expect.objectContaining({
          errorCode: 'ANTICIPO_PENDIENTE',
          estadoHabilitacion: 'ANTICIPO_PENDIENTE',
          userMessage: 'No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$5,650.00.',
          montoExigible: 5650,
          montoConfirmado: 0,
          saldoPendiente: 5650
        })
      });

      const fabProjSnap = await fdb.collection('proyectos_fabricacion_prod').doc('FAB-PROJ-OPP-50-UNPAID').get();
      expect(fabProjSnap.exists).toBe(false);
    });

    test('B2. Oportunidad 50/50 con pago parcial -> bloqueada; con anticipo completo confirmado -> habilitada para enviar a fabricación y liberar órdenes', async () => {
      const { fdb, wf, caller } = makeEnv();
      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-50-FLOW', codigo: '202611502', formaPago: '50/50', pagos: [] });

      const gestor = caller('gestor', 'GESTOR-1', 'Gestor Financiero');
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      // 1. Pago parcial de $2,000 sobre $5,650 exigibles -> saldo pendiente $3,650 -> bloqueado
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-50-FLOW',
        invoiceId: 'INV-OPP-50-FLOW',
        opId: 'OP-50-PARTIAL',
        monto: 2000,
        metodo: 'transferencia',
        ref: 'TRX-50-PARTIAL',
        doc_comprobante: fileObj('v_part.pdf')
      });

      await expect(wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-50-FLOW'
      })).rejects.toThrow(/No se puede enviar esta orden a fabricación\. El anticipo obligatorio aún tiene un saldo pendiente de US\$3,650\.00\./);

      // 2. Completar el saldo pendiente de $3,650 -> habilitado
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-50-FLOW',
        invoiceId: 'INV-OPP-50-FLOW',
        opId: 'OP-50-REST',
        monto: 3650,
        metodo: 'transferencia',
        ref: 'TRX-50-REST',
        doc_comprobante: fileObj('v_rest.pdf')
      });

      const sendRes = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-50-FLOW'
      });

      expect(sendRes.status).toBe('sent');
      expect(sendRes.projectId).toBe('FAB-PROJ-OPP-50-FLOW');
      expect(sendRes.readiness.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');
      expect(sendRes.readiness.montoExigible).toBe(5650);
      expect(sendRes.readiness.montoConfirmado).toBe(5650);
      expect(sendRes.readiness.saldoPendiente).toBe(0);

      // Verificar proyecto creado en proyectos_fabricacion_prod con metadatos de validación
      const fabProj = (await fdb.collection('proyectos_fabricacion_prod').doc('FAB-PROJ-OPP-50-FLOW').get()).data();
      expect(fabProj.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
      expect(fabProj.monto_anticipo_exigible).toBe(5650);
      expect(fabProj.monto_anticipo_confirmado).toBe(5650);
      expect(fabProj.saldo_pendiente_anticipo).toBe(0);

      // 3. Autorizar generación de orden hija y liberación desde Dibujo a Fabricación
      const createChildOrder = await wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-50-FLOW',
        fabProjectId: 'FAB-PROJ-OPP-50-FLOW',
        fabOrderId: 'FAB-ORD-50-FLOW-1',
        codigoProyecto: '202611502',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        orderPayload: {
          id: 'FAB-ORD-50-FLOW-1',
          padre_id: 'FAB-PROJ-OPP-50-FLOW',
          etapa: 'Dibujo',
          status: 'pendiente'
        }
      });
      expect(createChildOrder.status).toBe('authorized');

      const authOrder = await wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-50-FLOW',
        fabProjectId: 'FAB-PROJ-OPP-50-FLOW',
        fabOrderId: 'FAB-ORD-50-FLOW-1',
        codigoProyecto: '202611502',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        orderUpdate: { etapa: 'Fabricación', status: 'en_proceso' },
        tasks: [{ id: 'TSK-50-FLOW-1', fabricacion_id: 'FAB-ORD-50-FLOW-1', area: 'Plasma', status: 'pendiente' }]
      });
      expect(authOrder.status).toBe('authorized');
      expect(authOrder.ready).toBe(true);
      expect(authOrder.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');
      expect(authOrder.writtenTasksCount).toBe(1);
    });

    test('B3. Oportunidad 70/30 con anticipo completo y 70/30 con Gran Contribuyente local + retención 1% válida (69% + 1%) -> habilitadas', async () => {
      const { fdb, wf, caller } = makeEnv();
      const gestor = caller('gestor', 'GESTOR-1', 'Gestor Financiero');
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      // Caso 1: 70/30 cliente normal ($11,300 * 70% = $7,910.00)
      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-70-STD', codigo: '202611701', formaPago: '70/30', pagos: [] });

      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-70-STD',
        invoiceId: 'INV-OPP-70-STD',
        opId: 'OP-70-FULL',
        monto: 7910,
        metodo: 'transferencia',
        ref: 'TRX-70-FULL',
        doc_comprobante: fileObj('v70.pdf')
      });

      const res70 = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-70-STD'
      });
      expect(res70.status).toBe('sent');
      expect(res70.readiness.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');

      // Caso 2: 70/30 Gran Contribuyente local + retención 1% válida
      // Base sin IVA del CCF de anticipo ($7,910 / 1.13 = $7,000.00) -> Retención 1% = $70.00 + Transferencia = $7,840.00 = $7,910.00
      await fdb.seed('clients_prod/CLI-GRAN-70', {
        ...baseClient,
        id: 'CLI-GRAN-70',
        is_gran_contribuyente: true,
        categoria_contribuyente: 'gran_contribuyente',
        es_exportacion: false
      });
      await seedClosedOpportunity(fdb, {
        id: 'OPP-70-GRAN',
        codigo: '202611702',
        clientId: 'CLI-GRAN-70',
        formaPago: '70/30',
        pagos: []
      });

      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-70-GRAN',
        invoiceId: 'INV-OPP-70-GRAN',
        opId: 'OP-70-GRAN-CASH',
        monto: 7840,
        metodo: 'transferencia',
        ref: 'TRX-70-GRAN-CASH',
        doc_comprobante: fileObj('v70_cash.pdf')
      });
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-70-GRAN',
        invoiceId: 'INV-OPP-70-GRAN',
        opId: 'OP-70-GRAN-RET',
        monto: 70,
        metodo: 'retencion_1pct',
        ref: 'CR-70-GRAN-01',
        doc_comprobante: fileObj('cr70.pdf')
      });

      const res70Gran = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-70-GRAN'
      });
      expect(res70Gran.status).toBe('sent');
      expect(res70Gran.readiness.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');
      expect(res70Gran.readiness.montoEfectivoConfirmado).toBe(7840);
      expect(res70Gran.readiness.montoRetencionConfirmada).toBe(70);
      expect(res70Gran.readiness.montoConfirmado).toBe(7910);
    });

    test('B4. Oportunidad 100% anticipado con 99% -> bloqueada; con 100% -> habilitada', async () => {
      const { fdb, wf, caller } = makeEnv();
      const gestor = caller('gestor', 'GESTOR-1', 'Gestor Financiero');
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-100-FLOW', codigo: '202611100', formaPago: '100% anticipado', pagos: [] });

      // 99% de $11,300 = $11,187.00 (pendiente $113.00) -> bloqueado
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-100-FLOW',
        invoiceId: 'INV-OPP-100-FLOW',
        opId: 'OP-100-99PCT',
        monto: 11187,
        metodo: 'transferencia',
        ref: 'TRX-100-99PCT',
        doc_comprobante: fileObj('v99.pdf')
      });

      await expect(wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-100-FLOW'
      })).rejects.toThrow(/No se puede enviar esta orden a fabricación\. El anticipo obligatorio aún tiene un saldo pendiente de US\$113\.00\./);

      // Completar el 1% restante ($113.00) -> 100% confirmado ($11,300.00) -> habilitado
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-100-FLOW',
        invoiceId: 'INV-OPP-100-FLOW',
        opId: 'OP-100-1PCT',
        monto: 113,
        metodo: 'transferencia',
        ref: 'TRX-100-1PCT',
        doc_comprobante: fileObj('v1.pdf')
      });

      const res100 = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-100-FLOW'
      });
      expect(res100.status).toBe('sent');
      expect(res100.readiness.estadoHabilitacion).toBe('ANTICIPO_CONFIRMADO');
    });

    test('B5. Orden interna legítima no comercial -> permitida; Orden manual que apunta a oportunidad comercial con ANTICIPO_PENDIENTE -> bloqueada', async () => {
      const { fdb, wf, caller } = makeEnv();
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-MANUAL-BYPASS', codigo: '202611999', formaPago: '50/50', pagos: [] });

      // 1. Orden interna genuina (sin vínculo comercial y con código interno propio) -> permitida
      const internalRes = await wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        origenTipo: 'interno',
        codigoProyecto: 'MANT-PLANTA-01',
        stageTransition: 'crear_requerimiento_interno'
      });
      expect(internalRes.status).toBe('authorized_internal');
      expect(internalRes.ready).toBe(true);
      expect(internalRes.origenTipo).toBe('interno');

      // 2. Intento de eludir el bloqueo creando requerimiento/orden manual con el codigo_proyecto de una oportunidad comercial con anticipo pendiente -> bloqueado
      await expect(wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        origenTipo: 'interno',
        codigoProyecto: '202611999',
        stageTransition: 'crear_requerimiento_interno'
      })).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('No se puede enviar esta orden a fabricación. El anticipo obligatorio aún tiene un saldo pendiente de US$5,650.00.'),
        details: expect.objectContaining({
          errorCode: 'ANTICIPO_PENDIENTE'
        })
      });
    });

    test('B6. Eliminación de pago después de enviar a fabricación -> registra discrepancia auditada, bloquea nuevas órdenes sin cancelar las que están en proceso, y se restablece al cubrir el anticipo', async () => {
      const { fdb, wf, caller } = makeEnv();
      const gestor = caller('gestor', 'GESTOR-1', 'Gestor Financiero');
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-POST-REV', codigo: '202611888', formaPago: '50/50', pagos: [] });

      // 1. Pagar anticipo completo ($5,650) y enviar a fabricación
      const pay = await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-POST-REV',
        invoiceId: 'INV-OPP-POST-REV',
        opId: 'OP-REV-INIT',
        monto: 5650,
        metodo: 'transferencia',
        ref: 'TRX-REV-INIT',
        doc_comprobante: fileObj('v_init.pdf')
      });

      const sendRes = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-POST-REV'
      });
      const fabProjId = sendRes.projectId;

      // Sembrar una orden de fabricación ya en proceso ("Fabricación") asociada al proyecto
      await fdb.seed('fabricacion_prod/FAB-IN-PROGRESS-1', {
        id: 'FAB-IN-PROGRESS-1',
        padre_id: fabProjId,
        prospecto_id: 'OPP-POST-REV',
        codigo_orden: '202611888_1101',
        etapa: 'Fabricación'
      });

      // 2. Eliminar el pago después de haber enviado a fabricación
      const delRes = await wf.deletePayment({
        caller: gestor,
        prospectId: 'OPP-POST-REV',
        invoiceId: 'INV-OPP-POST-REV',
        paymentId: pay.payment.id
      });
      expect(delRes.status).toBe('deleted');
      expect(delRes.discrepancyRecorded).toBe(true);

      // 3. Verificar que la oportunidad y el proyecto de fabricación registran discrepancia financiera y bloqueo de nuevas órdenes
      const oppAfterDel = (await fdb.collection('prospects_prod').doc('OPP-POST-REV').get()).data();
      expect(oppAfterDel.discrepancia_financiera_fabricacion).toBe(true);
      expect(oppAfterDel.estado_habilitacion_fabricacion).toBe('ANTICIPO_PENDIENTE');
      expect(oppAfterDel.discrepancia_financiera_detalle).toEqual(expect.objectContaining({
        saldoPendiente: 5650,
        montoExigible: 5650,
        montoConfirmado: 0
      }));

      const fabProjAfterDel = (await fdb.collection('proyectos_fabricacion_prod').doc(fabProjId).get()).data();
      expect(fabProjAfterDel.discrepancia_financiera).toBe(true);
      expect(fabProjAfterDel.bloqueado_nuevas_ordenes).toBe(true);
      expect(fabProjAfterDel.estado_habilitacion_fabricacion).toBe('ANTICIPO_PENDIENTE');

      // 4. Verificar que la orden que ya estaba en proceso NO fue cancelada automáticamente
      const inProgressOrder = (await fdb.collection('fabricacion_prod').doc('FAB-IN-PROGRESS-1').get()).data();
      expect(inProgressOrder.etapa).toBe('Fabricación');

      // 5. Intentar generar una nueva orden para el proyecto es bloqueado por backend
      await expect(wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-POST-REV',
        fabProjectId: fabProjId,
        stageTransition: 'generar_orden_desde_proyecto'
      })).rejects.toThrow(/No se puede enviar esta orden a fabricación\. El anticipo obligatorio aún tiene un saldo pendiente de US\$5,650\.00\./);

      // 6. Registrar nuevo pago confirmado por $5,650 limpia la discrepancia y desbloquea nuevas órdenes
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-POST-REV',
        invoiceId: 'INV-OPP-POST-REV',
        opId: 'OP-REV-RESTORE',
        monto: 5650,
        metodo: 'transferencia',
        ref: 'TRX-REV-RESTORE',
        doc_comprobante: fileObj('v_restore.pdf')
      });

      const fabProjRestored = (await fdb.collection('proyectos_fabricacion_prod').doc(fabProjId).get()).data();
      expect(fabProjRestored.discrepancia_financiera).toBe(false);
      expect(fabProjRestored.bloqueado_nuevas_ordenes).toBe(false);
      expect(fabProjRestored.estado_habilitacion_fabricacion).toBe('ANTICIPO_CONFIRMADO');
    });

    test('B7. Cierre de rutas alternativas: escritura en backend de orden/tareas, bloqueo de prospecto_id distinto (OPORTUNIDAD_INCONSISTENTE) y prevención de liberación duplicada (ORDEN_YA_LIBERADA)', async () => {
      const { fdb, wf, caller } = makeEnv();
      const gestor = caller('gestor', 'GESTOR-1', 'Gestor Financiero');
      const jefeProd = caller('jefe_produccion', 'JEFE-PROD-1', 'Jefe Planta');

      await fdb.seed('clients_prod/CLI-FAB-01', baseClient);
      await seedClosedOpportunity(fdb, { id: 'OPP-PAID-OK', codigo: '202611901', formaPago: '50/50', pagos: [] });
      await seedClosedOpportunity(fdb, { id: 'OPP-UNPAID-EVADE', codigo: '202611902', formaPago: '50/50', pagos: [] });

      // Pagar el anticipo completo de OPP-PAID-OK y enviarla a fabricación
      await wf.savePayment({
        caller: gestor,
        prospectId: 'OPP-PAID-OK',
        invoiceId: 'INV-OPP-PAID-OK',
        opId: 'OP-PAID-OK-1',
        monto: 5650,
        metodo: 'transferencia',
        ref: 'TRX-PAID-OK-1',
        doc_comprobante: fileObj('v_ok.pdf')
      });
      const sendRes = await wf.sendProspectToFabrication({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK'
      });
      const paidProjId = sendRes.projectId;

      // 1. Intento de enviar el prospectId de la oportunidad pagada ('OPP-PAID-OK') pero con el código de proyecto de la oportunidad sin pagar ('202611902') -> rechazado con OPORTUNIDAD_INCONSISTENTE
      await expect(wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK',
        codigoProyecto: '202611902',
        fabOrderId: 'FAB-SPOOF-1',
        stageTransition: 'crear_orden_unica_manual',
        orderPayload: {
          id: 'FAB-SPOOF-1',
          codigo_proyecto: '202611902',
          proyecto: 'Proyecto 202611902',
          etapa: 'Dibujo'
        }
      })).rejects.toMatchObject({
        code: 'failed-precondition',
        details: expect.objectContaining({
          errorCode: 'OPORTUNIDAD_INCONSISTENTE'
        })
      });

      // 2. Creación legítima de orden hija en backend (crear_orden_hijo)
      const createChildRes = await wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK',
        fabProjectId: paidProjId,
        fabOrderId: 'FAB-ORD-LEGIT-1',
        codigoProyecto: '202611901',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        orderPayload: {
          id: 'FAB-ORD-LEGIT-1',
          padre_id: paidProjId,
          codigo_orden: '202611901_1101',
          codigo_proyecto: '202611901',
          proyecto: 'Proyecto 202611901',
          sistema: 'Extracción',
          etapa: 'Dibujo'
        }
      });
      expect(createChildRes.status).toBe('authorized');
      const storedOrder = (await fdb.collection('fabricacion_prod').doc('FAB-ORD-LEGIT-1').get()).data();
      expect(storedOrder).toEqual(expect.objectContaining({
        id: 'FAB-ORD-LEGIT-1',
        etapa: 'Dibujo',
        prospecto_id: 'OPP-PAID-OK',
        origen_tipo: 'oportunidad',
        estado_habilitacion_fabricacion: 'ANTICIPO_CONFIRMADO',
        autorizado_backend: true,
        liberado_a_fabricacion_backend: false
      }));

      // 3. Prevención de orden duplicada al repetir creación de la misma orden -> ORDEN_YA_LIBERADA
      await expect(wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK',
        fabProjectId: paidProjId,
        fabOrderId: 'FAB-ORD-LEGIT-1',
        codigoProyecto: '202611901',
        origenTipo: 'oportunidad',
        stageTransition: 'crear_orden_hijo',
        orderPayload: {
          id: 'FAB-ORD-LEGIT-1',
          padre_id: paidProjId,
          codigo_orden: '202611901_1101'
        }
      })).rejects.toMatchObject({
        code: 'failed-precondition',
        details: expect.objectContaining({
          errorCode: 'ORDEN_YA_LIBERADA'
        })
      });

      // 4. Liberación de Dibujo -> Fabricación y creación de tareas en backend
      const releaseRes = await wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK',
        fabProjectId: paidProjId,
        fabOrderId: 'FAB-ORD-LEGIT-1',
        codigoProyecto: '202611901',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        orderUpdate: {
          piezas_rectas: 4,
          fittings: 2,
          total_piezas: 6
        },
        tasks: [
          { id: 'TASK-FAB-ORD-LEGIT-1-1-ADLPiezasRectas', station: 'ADL (Piezas Rectas)', status: 'pendiente' },
          { id: 'TASK-FAB-ORD-LEGIT-1-2-CNCLamina', station: 'CNC (Lamina)', status: 'pendiente' }
        ]
      });
      expect(releaseRes.status).toBe('authorized');
      expect(releaseRes.writtenTasksCount).toBe(2);

      const releasedOrder = (await fdb.collection('fabricacion_prod').doc('FAB-ORD-LEGIT-1').get()).data();
      expect(releasedOrder.etapa).toBe('Fabricación');
      expect(releasedOrder.liberado_a_fabricacion_backend).toBe(true);
      const task1 = (await fdb.collection('fabricacion_tasks_prod').doc('TASK-FAB-ORD-LEGIT-1-1-ADLPiezasRectas').get()).data();
      expect(task1.fabricacion_id).toBe('FAB-ORD-LEGIT-1');
      expect(task1.autorizado_backend).toBe(true);

      // 5. Prevención de doble liberación al repetir la acción de liberar de Dibujo a Fabricación -> ORDEN_YA_LIBERADA
      await expect(wf.validateAndAuthorizeFabricationOrder({
        caller: jefeProd,
        prospectId: 'OPP-PAID-OK',
        fabProjectId: paidProjId,
        fabOrderId: 'FAB-ORD-LEGIT-1',
        codigoProyecto: '202611901',
        origenTipo: 'oportunidad',
        stageTransition: 'liberar_dibujo_a_fabricacion',
        orderUpdate: { piezas_rectas: 4 },
        tasks: [
          { id: 'TASK-FAB-ORD-LEGIT-1-1-ADLPiezasRectas', station: 'ADL (Piezas Rectas)', status: 'pendiente' }
        ]
      })).rejects.toMatchObject({
        code: 'failed-precondition',
        details: expect.objectContaining({
          errorCode: 'ORDEN_YA_LIBERADA'
        })
      });
    });
  });
});
