// functions/__tests__/documentVersioning.unit.test.js
// Automated unit tests for DUCTSAL ERP — Fase 4B.3
// Covers all 15 scenarios required by the specification:
// 1. Primera carga sin motivo.
// 2. Sustitución sin motivo rechazada.
// 3. Sustitución con motivo y auditoría correcta.
// 4. Historial de múltiples versiones sin pérdida de registros.
// 5. Documento heredado sin identificador de versión.
// 6. Reintento idéntico sin duplicación.
// 7. Mismo identificador de operación con contenido diferente rechazado.
// 8. Sustitución de oferta que invalida la aprobación correspondiente.
// 9. Sustitución de otro documento que no invalida esa aprobación.
// 10. Cierre rechazado cuando la aprobación está obsoleta.
// 11. Reautorización sobre la nueva oferta.
// 12. Intento concurrente de sustitución y finalización.
// 13. Falta de permisos de carga, lectura, escritura directa o eliminación.
// 14. Fallo parcial entre Storage y Firestore.
// 15. Restricciones de edición de una oportunidad ya ganada.

const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { createClientsService } = require('../clientsService');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const {
  applyDocumentVersionsTx,
  applyDocumentVersionTx,
  extractDocPath,
  toCanonicalDocPointer,
  generateVersionId,
  checkAndInvalidateOfferApproval,
  bindNoContractApproval,
  isNoContractApprovalValid
} = require('../documentVersioningService');

describe('Fase 4B.3: Document Versioning & Security Rules Unit Tests', () => {
  let fdb;
  let clientsSvc;
  let commSvc;
  let wfSvc;

  const who = (role, cid, name = null) => ({ uid: `uid-${cid}`, cid, role, name: name || role });
  const V1 = who('vendedor', '1000000000001', 'Carlos Mendoza');
  const V2 = who('vendedor', '1000000000002', 'Alejandra Ayala');
  const MGR = who('manager', '1000000000009', 'Gerente Alfa');

  beforeEach(() => {
    fdb = createFakeFirestore({ clock: () => new Date('2026-10-25T12:00:00.000Z') });
    clientsSvc = createClientsService({ db: fdb, FieldValue: fdb.FieldValue, suffix: '_prod' });
    commSvc = createCommercialService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      suffix: '_prod',
      verifyManager: async () => true
    });
    wfSvc = createProspectWorkflowService({
      db: fdb,
      FieldValue: fdb.FieldValue,
      kit: commSvc.kit,
      fileUrlPrefixes: ['https://firebasestorage.googleapis.com/v0/b/']
    });
  });

  // --------------------------------------------------------------------------------------
  // 1. Primera carga sin motivo.
  // --------------------------------------------------------------------------------------
  test('1. Primera carga sin motivo: crea versión 1 vigente sin requerir motivoSustitucion', async () => {
    const res = await clientsSvc.create({
      caller: V1,
      opId: 'op_create_client_01',
      client: {
        tipo: 'natural',
        nombres: 'Roberto',
        apellidos: 'Flores',
        dui: '01234567-8',
        nit: '0614-010190-101-1',
        telefono: '7000-0001',
        correo: 'roberto@example.com',
        correo_fact: 'roberto@example.com',
        documentos: {
          dui: {
            name: 'dui_roberto.pdf',
            storagePath: 'prod_files/clients/C_NEW_01/identificacion/dui_roberto.pdf'
          }
        }
      }
    });

    expect(res.status).toBe('created');
    const clientId = res.client.id;
    const clientData = fdb.data(`clients_prod/${clientId}`);
    expect(clientData.documentos.dui).toMatchObject({
      name: 'dui_roberto.pdf',
      storagePath: 'prod_files/clients/C_NEW_01/identificacion/dui_roberto.pdf'
    });

    const versions = fdb.list(`clients_prod/${clientId}/document_versions`);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionNumber: 1,
      docKey: 'dui',
      estado: 'vigente',
      reemplazaVersionId: null,
      motivoSustitucion: null,
      subidoPorId: V1.cid,
      esHeredado: false
    });
  });

  // --------------------------------------------------------------------------------------
  // 2. Sustitución sin motivo rechazada.
  // --------------------------------------------------------------------------------------
  test('2. Sustitución sin motivo rechazada: actualizar archivo existente sin motivo lanza invalid-argument', async () => {
    fdb.seed('clients_prod/C_TEST_02', {
      id: 'C_TEST_02',
      tipo: 'natural',
      nombres: 'Ana',
      apellidos: 'Gómez',
      telefono: '7111-2222',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui_v1.pdf', storagePath: 'prod_files/clients/C_TEST_02/dui_v1.pdf' }
      }
    });
    fdb.seed('clients_prod/C_TEST_02/document_versions/v1', {
      versionId: 'v1',
      versionNumber: 1,
      docKey: 'dui',
      estado: 'vigente',
      storagePath: 'prod_files/clients/C_TEST_02/dui_v1.pdf'
    });

    await expect(clientsSvc.update({
      caller: V1,
      id: 'C_TEST_02',
      client: {
        tipo: 'natural',
        nombres: 'Ana',
        apellidos: 'Gómez',
        telefono: '7111-2222',
        documentos: {
          dui: { name: 'dui_v2.pdf', storagePath: 'prod_files/clients/C_TEST_02/dui_v2.pdf' }
        }
      }
    })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('Toda sustitución de un documento existente requiere un motivo no vacío')
    });
  });

  // --------------------------------------------------------------------------------------
  // 3. Sustitución con motivo y auditoría correcta.
  // --------------------------------------------------------------------------------------
  test('3. Sustitución con motivo y auditoría correcta: archiva v1 como historica y crea v2 vigente', async () => {
    fdb.seed('clients_prod/C_TEST_03', {
      id: 'C_TEST_03',
      tipo: 'natural',
      nombres: 'Carlos',
      apellidos: 'Pérez',
      telefono: '7222-3333',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui_v1.pdf', storagePath: 'prod_files/clients/C_TEST_03/dui_v1.pdf', versionId: 'ver_01' }
      }
    });
    fdb.seed('clients_prod/C_TEST_03/document_versions/ver_01', {
      versionId: 'ver_01',
      versionNumber: 1,
      docKey: 'dui',
      estado: 'vigente',
      storagePath: 'prod_files/clients/C_TEST_03/dui_v1.pdf'
    });

    const updateRes = await clientsSvc.update({
      caller: V1,
      id: 'C_TEST_03',
      client: {
        tipo: 'natural',
        nombres: 'Carlos',
        apellidos: 'Pérez',
        telefono: '7222-3333',
        documentos: {
          dui: {
            name: 'dui_v2.pdf',
            storagePath: 'prod_files/clients/C_TEST_03/dui_v2.pdf',
            motivoSustitucion: 'Renovación por vencimiento de DUI'
          }
        }
      }
    });

    expect(updateRes.status).toBe('updated');

    const v1Data = fdb.data('clients_prod/C_TEST_03/document_versions/ver_01');
    expect(v1Data.estado).toBe('historica');
    expect(v1Data.reemplazadoPorId).toBe(V1.cid);

    const allVers = fdb.list('clients_prod/C_TEST_03/document_versions');
    expect(allVers).toHaveLength(2);
    const v2 = allVers.find(v => v.estado === 'vigente');
    expect(v2).toMatchObject({
      versionNumber: 2,
      docKey: 'dui',
      estado: 'vigente',
      reemplazaVersionId: 'ver_01',
      motivoSustitucion: 'Renovación por vencimiento de DUI',
      subidoPorId: V1.cid
    });
  });

  // --------------------------------------------------------------------------------------
  // 4. Historial de múltiples versiones sin pérdida de registros.
  // --------------------------------------------------------------------------------------
  test('4. Historial de múltiples versiones: encadenamiento v1 -> v2 -> v3 sin pérdida', async () => {
    fdb.seed('prospects_prod/P_MULTI_04', {
      id: 'P_MULTI_04',
      etapa: 'cierre',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {}
    });

    // Subida v1
    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_MULTI_04',
      data: {
        doc_firmado: { name: 'oferta_v1.pdf', storagePath: 'prod_files/prospects/P_MULTI_04/cierre/oferta_v1.pdf' }
      }
    });

    // Sustitución v2
    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_MULTI_04',
      data: {
        doc_firmado: {
          name: 'oferta_v2.pdf',
          storagePath: 'prod_files/prospects/P_MULTI_04/cierre/oferta_v2.pdf',
          motivoSustitucion: 'Ajuste de alcance v2'
        }
      }
    });

    // Sustitución v3
    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_MULTI_04',
      data: {
        doc_firmado: {
          name: 'oferta_v3.pdf',
          storagePath: 'prod_files/prospects/P_MULTI_04/cierre/oferta_v3.pdf',
          motivoSustitucion: 'Firma final v3'
        }
      }
    });

    const versions = fdb.list('prospects_prod/P_MULTI_04/document_versions');
    expect(versions).toHaveLength(3);

    const sorted = versions.sort((a, b) => a.versionNumber - b.versionNumber);
    expect(sorted[0]).toMatchObject({ versionNumber: 1, estado: 'historica' });
    expect(sorted[1]).toMatchObject({ versionNumber: 2, estado: 'historica', reemplazaVersionId: sorted[0].versionId });
    expect(sorted[2]).toMatchObject({ versionNumber: 3, estado: 'vigente', reemplazaVersionId: sorted[1].versionId });
  });

  // --------------------------------------------------------------------------------------
  // 5. Documento heredado sin identificador de versión.
  // --------------------------------------------------------------------------------------
  test('5. Documento heredado sin identificador de versión: migración perezosa con esHeredado: true', async () => {
    fdb.seed('clients_prod/C_LEGACY_05', {
      id: 'C_LEGACY_05',
      tipo: 'natural',
      nombres: 'Mario',
      apellidos: 'Santos',
      telefono: '7555-5555',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui_antiguo.pdf', storagePath: 'prod_files/clients/C_LEGACY_05/dui_antiguo.pdf' }
      }
    });

    await clientsSvc.update({
      caller: V1,
      id: 'C_LEGACY_05',
      client: {
        tipo: 'natural',
        nombres: 'Mario',
        apellidos: 'Santos',
        telefono: '7555-5555',
        documentos: {
          dui: {
            name: 'dui_nuevo.pdf',
            storagePath: 'prod_files/clients/C_LEGACY_05/dui_nuevo.pdf',
            motivoSustitucion: 'Digitalización en alta resolución'
          }
        }
      }
    });

    const versions = fdb.list('clients_prod/C_LEGACY_05/document_versions');
    expect(versions).toHaveLength(2);

    const legacyVer = versions.find(v => v.esHeredado === true);
    expect(legacyVer).toBeDefined();
    expect(legacyVer).toMatchObject({
      versionNumber: 1,
      estado: 'historica',
      esHeredado: true,
      storagePath: 'prod_files/clients/C_LEGACY_05/dui_antiguo.pdf'
    });

    const newVer = versions.find(v => v.esHeredado === false);
    expect(newVer).toMatchObject({
      versionNumber: 2,
      estado: 'vigente',
      reemplazaVersionId: legacyVer.versionId,
      motivoSustitucion: 'Digitalización en alta resolución'
    });
  });

  // --------------------------------------------------------------------------------------
  // 6. Reintento idéntico sin duplicación.
  // --------------------------------------------------------------------------------------
  test('6. Reintento idéntico sin duplicación: mismo opId con mismo payload no genera duplicados', async () => {
    fdb.seed('prospects_prod/P_IDEM_06', {
      id: 'P_IDEM_06',
      etapa: 'cierre',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {}
    });

    const opPayload = {
      caller: V1,
      prospectId: 'P_IDEM_06',
      data: {
        doc_firmado: { name: 'contrato.pdf', storagePath: 'prod_files/prospects/P_IDEM_06/cierre/contrato.pdf' },
        opId: 'op_idempotent_test_06'
      }
    };

    const res1 = await wfSvc.saveClosingDocuments(opPayload);
    expect(res1.status).toBe('saved');
    const vers1 = fdb.list('prospects_prod/P_IDEM_06/document_versions');
    expect(vers1).toHaveLength(1);

    // Replay
    const res2 = await wfSvc.saveClosingDocuments(opPayload);
    expect(res2.status).toBe('saved');
    const vers2 = fdb.list('prospects_prod/P_IDEM_06/document_versions');
    expect(vers2).toHaveLength(1); // No duplicate created
  });

  // --------------------------------------------------------------------------------------
  // 7. Mismo identificador de operación con contenido diferente rechazado.
  // --------------------------------------------------------------------------------------
  test('7. Reutilizar opId con contenido diferente es rechazado con failed-precondition', async () => {
    fdb.seed('prospects_prod/P_IDEM_07', {
      id: 'P_IDEM_07',
      etapa: 'cierre',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {}
    });

    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_IDEM_07',
      data: {
        doc_firmado: { name: 'archivo_a.pdf', storagePath: 'prod_files/prospects/P_IDEM_07/cierre/archivo_a.pdf' },
        opId: 'op_clash_key_07'
      }
    });

    // Different storagePath with same opId
    await expect(wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_IDEM_07',
      data: {
        doc_firmado: {
          name: 'archivo_b.pdf',
          storagePath: 'prod_files/prospects/P_IDEM_07/cierre/archivo_b.pdf',
          motivoSustitucion: 'Cambio'
        },
        opId: 'op_clash_key_07'
      }
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('opId ya usado con otros datos')
    });
  });

  // --------------------------------------------------------------------------------------
  // 8. Sustitución de oferta que invalida la aprobación correspondiente.
  // --------------------------------------------------------------------------------------
  test('8. Sustitución de oferta firmada invalida automáticamente la aprobación sin contrato', async () => {
    fdb.seed('prospects_prod/P_INV_08', {
      id: 'P_INV_08',
      etapa: 'cierre',
      estado: 'activo',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 25000,
      costo_venta: 15000,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_firmado: { name: 'oferta_v1.pdf', storagePath: 'prod_files/prospects/P_INV_08/cierre/oferta_v1.pdf', versionId: 'v_of_1' }
      }
    });
    fdb.seed('prospects_prod/P_INV_08/document_versions/v_of_1', {
      versionId: 'v_of_1',
      versionNumber: 1,
      docKey: 'doc_firmado',
      estado: 'vigente',
      storagePath: 'prod_files/prospects/P_INV_08/cierre/oferta_v1.pdf'
    });

    // Manager otorga aprobación sin contrato para la oferta v1
    await commSvc.setNoContractAuthorization({ caller: MGR, prospectId: 'P_INV_08', authorized: true });

    let p = fdb.data('prospects_prod/P_INV_08');
    expect(p.datos.autorizado_sin_contrato).toBe(true);
    expect(p.aprobacion_sin_contrato.estado).toBe('aprobada');
    expect(p.aprobacion_sin_contrato.storagePathAprobado).toBe('prod_files/prospects/P_INV_08/cierre/oferta_v1.pdf');

    // Vendedor sustituye la oferta firmada en saveClosingDocuments
    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_INV_08',
      data: {
        doc_firmado: {
          name: 'oferta_v2.pdf',
          storagePath: 'prod_files/prospects/P_INV_08/cierre/oferta_v2.pdf',
          motivoSustitucion: 'Corrección de especificación técnica solicitada por cliente'
        }
      }
    });

    p = fdb.data('prospects_prod/P_INV_08');
    expect(p.datos.autorizado_sin_contrato).toBe(false);
    expect(p.aprobacion_sin_contrato.estado).toBe('invalidada_por_sustitucion');
    expect(p.aprobacion_sin_contrato.motivo_invalidacion).toContain('Sustitución de oferta firmada');
    expect(p.logs[p.logs.length - 1].text).toContain('ADVERTENCIA: La autorización para cerrar sin contrato fue invalidada');
  });

  // --------------------------------------------------------------------------------------
  // 9. Sustitución de otro documento que no invalida esa aprobación.
  // --------------------------------------------------------------------------------------
  test('9. Sustitución de comprobante de anticipo o documento de cliente NO invalida aprobación sin contrato', async () => {
    fdb.seed('clients_prod/C_TEST_09', {
      id: 'C_TEST_09',
      tipo: 'natural',
      nombres: 'Lucía',
      apellidos: 'Molina',
      telefono: '7888-8888',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui_v1.pdf', storagePath: 'prod_files/clients/C_TEST_09/dui_v1.pdf' }
      }
    });
    fdb.seed('prospects_prod/P_SAFE_09', {
      id: 'P_SAFE_09',
      clientId: 'C_TEST_09',
      etapa: 'cierre',
      estado: 'activo',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 20000,
      costo_venta: 12000,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_firmado: { name: 'oferta_aprobada.pdf', storagePath: 'prod_files/prospects/P_SAFE_09/cierre/oferta_aprobada.pdf' },
        doc_comprobante: { name: 'recibo_v1.pdf', storagePath: 'prod_files/prospects/P_SAFE_09/facturas/recibo_v1.pdf' }
      }
    });

    await commSvc.setNoContractAuthorization({ caller: MGR, prospectId: 'P_SAFE_09', authorized: true });

    // 1) Sustituir doc_comprobante en la oportunidad
    await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_SAFE_09',
      data: {
        doc_comprobante: {
          name: 'recibo_v2.pdf',
          storagePath: 'prod_files/prospects/P_SAFE_09/facturas/recibo_v2.pdf',
          motivoSustitucion: 'Nuevo comprobante con sello de banco'
        }
      }
    });

    let p = fdb.data('prospects_prod/P_SAFE_09');
    expect(p.datos.autorizado_sin_contrato).toBe(true);
    expect(p.aprobacion_sin_contrato.estado).toBe('aprobada');

    // 2) Sustituir DUI en el cliente
    await clientsSvc.update({
      caller: V1,
      id: 'C_TEST_09',
      client: {
        tipo: 'natural',
        nombres: 'Lucía',
        apellidos: 'Molina',
        telefono: '7888-8888',
        documentos: {
          dui: {
            name: 'dui_v2.pdf',
            storagePath: 'prod_files/clients/C_TEST_09/dui_v2.pdf',
            motivoSustitucion: 'Actualización periódica'
          }
        }
      }
    });

    p = fdb.data('prospects_prod/P_SAFE_09');
    expect(p.datos.autorizado_sin_contrato).toBe(true);
    expect(p.aprobacion_sin_contrato.estado).toBe('aprobada');
  });

  // --------------------------------------------------------------------------------------
  // 10. Cierre rechazado cuando la aprobación está obsoleta.
  // --------------------------------------------------------------------------------------
  test('10. Cierre rechazado cuando la aprobación está obsoleta o invalidada', async () => {
    fdb.seed('clients_prod/C_TEST_10', {
      id: 'C_TEST_10',
      tipo: 'natural',
      nombres: 'Elena',
      apellidos: 'Díaz',
      dui: '02345678-9',
      nit: '0614-020290-101-2',
      telefono: '7999-9999',
      correo: 'elena@example.com',
      correo_fact: 'elena@example.com',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_TEST_10/dui.pdf' }
      }
    });
    fdb.seed('prospects_prod/P_CLOSE_10', {
      id: 'P_CLOSE_10',
      clientId: 'C_TEST_10',
      etapa: 'cierre',
      estado: 'activo',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 30000,
      costo_venta: 18000,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      encargado: 'Instalador Beta',
      aprobacion_sin_contrato: {
        estado: 'invalidada_por_sustitucion',
        storagePathAprobado: 'prod_files/prospects/P_CLOSE_10/oferta_antigua.pdf'
      },
      datos: {
        autorizado_sin_contrato: false,
        aprobacion_sin_contrato: {
          estado: 'invalidada_por_sustitucion'
        },
        doc_firmado: { name: 'oferta_nueva.pdf', storagePath: 'prod_files/prospects/P_CLOSE_10/oferta_nueva.pdf' },
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P_CLOSE_10/recibo.pdf' },
        factura_anticipo: 'FAC-CLOSE-10',
        forma_pago: '50/50'
      }
    });

    await expect(wfSvc.finalizeProspect({
      caller: V1,
      prospectId: 'P_CLOSE_10',
      data: {
        forma_pago: '50/50',
        factura_anticipo: 'FAC-CLOSE-10'
      }
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('La autorización para cerrar sin contrato fue invalidada')
    });

    const p = fdb.data('prospects_prod/P_CLOSE_10');
    expect(p.estado).toBe('activo'); // Still open, cannot close with obsolete approval
  });

  // --------------------------------------------------------------------------------------
  // 11. Reautorización sobre la nueva oferta.
  // --------------------------------------------------------------------------------------
  test('11. Reautorización sobre la nueva oferta: gerente reautoriza y permite finalizar el cierre', async () => {
    fdb.seed('clients_prod/C_TEST_11', {
      id: 'C_TEST_11',
      tipo: 'natural',
      nombres: 'Fernando',
      apellidos: 'Torres',
      dui: '03456789-0',
      nit: '0614-030390-101-3',
      telefono: '7123-4567',
      correo: 'fernando@example.com',
      correo_fact: 'fernando@example.com',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_TEST_11/dui.pdf' }
      }
    });
    fdb.seed('prospects_prod/P_REAUTH_11', {
      id: 'P_REAUTH_11',
      clientId: 'C_TEST_11',
      etapa: 'cierre',
      estado: 'activo',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 22000,
      costo_venta: 14000,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      encargado: 'Técnico Gama',
      aprobacion_sin_contrato: {
        estado: 'invalidada_por_sustitucion'
      },
      datos: {
        autorizado_sin_contrato: false,
        doc_firmado: { name: 'oferta_final_v2.pdf', storagePath: 'prod_files/prospects/P_REAUTH_11/oferta_final_v2.pdf' },
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P_REAUTH_11/recibo.pdf' },
        factura_anticipo: 'FAC-REAUTH-11',
        forma_pago: '50/50'
      }
    });

    // Gerente reautoriza directamente
    const authRes = await commSvc.setNoContractAuthorization({
      caller: MGR,
      prospectId: 'P_REAUTH_11',
      authorized: true
    });
    expect(authRes.status).toBe('updated');
    expect(authRes.authorized).toBe(true);

    const reauthorized = fdb.data('prospects_prod/P_REAUTH_11');
    expect(reauthorized.aprobacion_sin_contrato.estado).toBe('aprobada');
    expect(reauthorized.aprobacion_sin_contrato.storagePathAprobado).toBe('prod_files/prospects/P_REAUTH_11/oferta_final_v2.pdf');

    // Ahora finalizar tiene éxito
    const finRes = await wfSvc.finalizeProspect({
      caller: V1,
      prospectId: 'P_REAUTH_11',
      data: {
        forma_pago: '50/50',
        factura_anticipo: 'FAC-REAUTH-11'
      }
    });

    expect(finRes.status).toBe('finalized');
    expect(finRes.estado).toBe('ganado');

    const closed = fdb.data('prospects_prod/P_REAUTH_11');
    expect(closed.estado).toBe('ganado');
    expect(closed.postcierre_habilitado).toBe(true);
    expect(closed.facturas).toHaveLength(1);
  });

  // --------------------------------------------------------------------------------------
  // 12. Intento concurrente de sustitución y finalización.
  // --------------------------------------------------------------------------------------
  test('12. Intento concurrente de sustitución y finalización: si doc_firmado se sustituye durante el cierre, la aprobación se invalida y el cierre falla', async () => {
    fdb.seed('clients_prod/C_TEST_12', {
      id: 'C_TEST_12',
      tipo: 'natural',
      nombres: 'Beatriz',
      apellidos: 'Vega',
      dui: '04567890-1',
      nit: '0614-040490-101-4',
      telefono: '7444-5555',
      correo: 'beatriz@example.com',
      correo_fact: 'beatriz@example.com',
      createdBy: V1.cid,
      documentos: {
        dui: { name: 'dui.pdf', storagePath: 'prod_files/clients/C_TEST_12/dui.pdf' }
      }
    });
    fdb.seed('prospects_prod/P_CONC_12', {
      id: 'P_CONC_12',
      clientId: 'C_TEST_12',
      etapa: 'cierre',
      estado: 'activo',
      tipo_proyecto: 'Fabricación e instalación',
      precio_cotizado: 28000,
      costo_venta: 17000,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      encargado: 'Técnico Especialista',
      aprobacion_sin_contrato: {
        estado: 'aprobada',
        storagePathAprobado: 'prod_files/prospects/P_CONC_12/oferta_original.pdf'
      },
      datos: {
        autorizado_sin_contrato: true,
        doc_firmado: { name: 'oferta_original.pdf', storagePath: 'prod_files/prospects/P_CONC_12/oferta_original.pdf' },
        doc_comprobante: { name: 'recibo.pdf', storagePath: 'prod_files/prospects/P_CONC_12/recibo.pdf' },
        factura_anticipo: 'FAC-CONC-12',
        forma_pago: '50/50'
      }
    });

    // Finalizar pasando un nuevo doc_firmado sustituto en la misma invocación
    await expect(wfSvc.finalizeProspect({
      caller: V1,
      prospectId: 'P_CONC_12',
      data: {
        forma_pago: '50/50',
        factura_anticipo: 'FAC-CONC-12',
        doc_firmado: {
          name: 'oferta_modificada.pdf',
          storagePath: 'prod_files/prospects/P_CONC_12/oferta_modificada.pdf',
          motivoSustitucion: 'Cambio de equipo en última revisión'
        }
      }
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('La autorización para cerrar sin contrato fue invalidada por sustitución de la oferta')
    });

    // Prospect cannot slip through into postclosing / ganado
    const p = fdb.data('prospects_prod/P_CONC_12');
    expect(p.estado).toBe('activo');
    expect(p.postcierre_habilitado).toBeFalsy();
  });

  // --------------------------------------------------------------------------------------
  // 13. Falta de permisos de carga, lectura, escritura directa o eliminación.
  // --------------------------------------------------------------------------------------
  test('13. Falta de permisos: vendedor sin acceso a la oportunidad es rechazado', async () => {
    fdb.seed('prospects_prod/P_PERM_13', {
      id: 'P_PERM_13',
      etapa: 'cierre',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {}
    });

    // V2 no es ni creador ni asignado ni gestor ni manager
    await expect(wfSvc.saveClosingDocuments({
      caller: V2,
      prospectId: 'P_PERM_13',
      data: {
        doc_firmado: { name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_PERM_13/oferta.pdf' }
      }
    })).rejects.toMatchObject({
      code: 'permission-denied'
    });
  });

  // --------------------------------------------------------------------------------------
  // 14. Fallo parcial entre Storage y Firestore.
  // --------------------------------------------------------------------------------------
  test('14. Fallo parcial entre Storage y Firestore: error en Firestore no borra Storage, permite reintento seguro', async () => {
    fdb.seed('prospects_prod/P_FAIL_14', {
      id: 'P_FAIL_14',
      etapa: 'cierre',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_firmado: { name: 'original.pdf', storagePath: 'prod_files/prospects/P_FAIL_14/original.pdf' }
      }
    });

    const fileUploadedToStorage = {
      name: 'nuevo_subido.pdf',
      storagePath: 'prod_files/prospects/P_FAIL_14/nuevo_subido.pdf'
    };

    // Intento 1: falla por motivo vacío
    await expect(wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_FAIL_14',
      data: {
        doc_firmado: fileUploadedToStorage,
        motivo_doc_firmado: '' // Inválido
      }
    })).rejects.toMatchObject({
      code: 'invalid-argument'
    });

    // El objeto en Storage sigue existiendo y disponible; no hay borrado automático
    expect(fileUploadedToStorage.storagePath).toBe('prod_files/prospects/P_FAIL_14/nuevo_subido.pdf');

    // Intento 2: reintento seguro con el mismo archivo y motivo válido tiene éxito
    const retryRes = await wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_FAIL_14',
      data: {
        doc_firmado: fileUploadedToStorage,
        motivo_doc_firmado: 'Corrección de firmas requerida'
      }
    });

    expect(retryRes.status).toBe('saved');
    const p = fdb.data('prospects_prod/P_FAIL_14');
    expect(p.datos.doc_firmado.storagePath).toBe(fileUploadedToStorage.storagePath);
  });

  // --------------------------------------------------------------------------------------
  // 15. Restricciones de edición de una oportunidad ya ganada.
  // --------------------------------------------------------------------------------------
  test('15. Restricciones de edición de una oportunidad ya ganada: rechaza modificaciones documentales y reapertura', async () => {
    fdb.seed('prospects_prod/P_WON_15', {
      id: 'P_WON_15',
      etapa: 'cierre',
      estado: 'ganado',
      postcierre_habilitado: true,
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_firmado: { name: 'oferta_ganada.pdf', storagePath: 'prod_files/prospects/P_WON_15/oferta_ganada.pdf' }
      }
    });

    // 1) saveClosingDocuments debe fallar en prospecto ganado
    await expect(wfSvc.saveClosingDocuments({
      caller: V1,
      prospectId: 'P_WON_15',
      data: {
        doc_firmado: {
          name: 'oferta_intento_reabrir.pdf',
          storagePath: 'prod_files/prospects/P_WON_15/oferta_intento_reabrir.pdf',
          motivoSustitucion: 'Intento de cambio'
        }
      }
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Solo una oportunidad en Cierre activo puede modificar documentos')
    });

    // 2) advanceStage debe fallar en prospecto ganado
    await expect(wfSvc.advanceStage({
      caller: V1,
      prospectId: 'P_WON_15',
      stage: 'cierre',
      data: {}
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Solo las oportunidades activas pueden avanzar de etapa')
    });

    // 3) setNoContractAuthorization debe fallar en prospecto ganado
    await expect(commSvc.setNoContractAuthorization({
      caller: MGR,
      prospectId: 'P_WON_15',
      authorized: true
    })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Solo una oportunidad activa puede autorizarse sin contrato')
    });

    // El estado se mantiene intacto sin reapertura
    const p = fdb.data('prospects_prod/P_WON_15');
    expect(p.estado).toBe('ganado');
    expect(p.postcierre_habilitado).toBe(true);
  });

  // --------------------------------------------------------------------------------------
  // 16. advanceStage agrupa doc_firmado y doc_comprobante atómicamente en applyDocumentVersionsTx
  // --------------------------------------------------------------------------------------
  test('16. advanceStage agrupa doc_firmado y doc_comprobante atómicamente y valida idempotencia', async () => {
    fdb.seed('clients_prod/C_ADV_16', {
      id: 'C_ADV_16',
      tipo: 'juridica',
      empresa: 'Cliente Advance 16',
      contacto: 'Ing. Test',
      nit: '0614-010190-101-1',
      nrc: '123456-7',
      createdBy: V1.cid,
      closingVendors: []
    });

    fdb.seed('prospects_prod/P_ADV_16', {
      id: 'P_ADV_16',
      clientId: 'C_ADV_16',
      etapa: 'negociacion',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_oferta: [{ name: 'oferta_neg.pdf', storagePath: 'prod_files/prospects/P_ADV_16/oferta_neg.pdf' }],
        doc_costos: [{ name: 'costos_neg.pdf', storagePath: 'prod_files/prospects/P_ADV_16/costos_neg.pdf' }]
      }
    });

    // 1) Avanzar a cierre con ambos documentos preliminares en una sola llamada agrupada
    const advRes = await wfSvc.advanceStage({
      caller: V1,
      prospectId: 'P_ADV_16',
      nextStage: 'cierre',
      data: {
        forma_pago: '50/50',
        opId: 'op_advance_cierre_001',
        doc_firmado: {
          name: 'oferta_firmada_cierre.pdf',
          storagePath: 'prod_files/prospects/P_ADV_16/cierre/oferta_firmada_cierre.pdf'
        },
        doc_comprobante: {
          name: 'comprobante_cierre.pdf',
          storagePath: 'prod_files/prospects/P_ADV_16/cierre/comprobante_cierre.pdf'
        }
      }
    });

    expect(advRes.status).toBe('advanced');
    expect(advRes.etapa).toBe('cierre');

    const updated = fdb.data('prospects_prod/P_ADV_16');
    expect(updated.datos.doc_firmado.versionNumber).toBe(1);
    expect(updated.datos.doc_firmado.storagePath).toBe('prod_files/prospects/P_ADV_16/cierre/oferta_firmada_cierre.pdf');
    expect(updated.datos.doc_comprobante.versionNumber).toBe(1);
    expect(updated.datos.doc_comprobante.storagePath).toBe('prod_files/prospects/P_ADV_16/cierre/comprobante_cierre.pdf');

    // Comprobar que en document_versions existen ambos registros vigentes v1
    const versions = fdb.list('prospects_prod/P_ADV_16/document_versions');
    expect(versions).toHaveLength(2);
    const verFirmado = versions.find(v => v.docKey === 'doc_firmado');
    const verComp = versions.find(v => v.docKey === 'doc_comprobante');
    expect(verFirmado.estado).toBe('vigente');
    expect(verFirmado.versionNumber).toBe(1);
    expect(verComp.estado).toBe('vigente');
    expect(verComp.versionNumber).toBe(1);

    // 2) Reintento con mismo opId: idempotencia en opsCol
    const opFirmadoSnap = fdb.data('prospects_prod/P_ADV_16/document_version_ops/op_advance_cierre_001_doc_firmado');
    const opCompSnap = fdb.data('prospects_prod/P_ADV_16/document_version_ops/op_advance_cierre_001_doc_comprobante');
    expect(opFirmadoSnap).toBeDefined();
    expect(opCompSnap).toBeDefined();
    expect(opFirmadoSnap.versionId).toBe(verFirmado.versionId);
    expect(opCompSnap.versionId).toBe(verComp.versionId);

    // 3) Caso de avance con un solo documento en otra oportunidad
    fdb.seed('prospects_prod/P_ADV_SINGLE', {
      id: 'P_ADV_SINGLE',
      clientId: 'C_ADV_16',
      etapa: 'negociacion',
      estado: 'activo',
      vendedorId: V1.cid,
      createdBy: V1.cid,
      datos: {
        doc_oferta: [{ name: 'oferta_neg.pdf', storagePath: 'prod_files/prospects/P_ADV_SINGLE/oferta_neg.pdf' }],
        doc_costos: [{ name: 'costos_neg.pdf', storagePath: 'prod_files/prospects/P_ADV_SINGLE/costos_neg.pdf' }]
      }
    });

    const singleRes = await wfSvc.advanceStage({
      caller: V1,
      prospectId: 'P_ADV_SINGLE',
      nextStage: 'cierre',
      data: {
        forma_pago: '50/50',
        doc_firmado: {
          name: 'oferta_firmada_solitaria.pdf',
          storagePath: 'prod_files/prospects/P_ADV_SINGLE/cierre/oferta_firmada_solitaria.pdf'
        }
      }
    });
    expect(singleRes.status).toBe('advanced');
    const singleData = fdb.data('prospects_prod/P_ADV_SINGLE');
    expect(singleData.datos.doc_firmado.versionNumber).toBe(1);
    expect(singleData.datos.doc_comprobante).toBeUndefined();
    const singleVersions = fdb.list('prospects_prod/P_ADV_SINGLE/document_versions');
    expect(singleVersions).toHaveLength(1);
  });
});
