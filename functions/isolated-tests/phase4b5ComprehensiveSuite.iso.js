// functions/isolated-tests/phase4b5ComprehensiveSuite.iso.js
// Comprehensive Integration and Concurrency Suite for Fase 4B.5
// Runs on the real Firebase Emulator Suite (Auth 9399, Firestore 8190, Storage 9290, Functions 5101).
// Validates:
// - Suite B: Mandatory End-to-End Flows 1 to 6
// - Suite C: Concurrency C1 to C6 with synchronization barriers
// - Suite D: Historical Quotes Migration (dryRun, categories, idempotency)
// - Suite E: Security Rules for document_versions and horizontal isolation

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8190';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9399';
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9290';
process.env.GCLOUD_PROJECT = 'demo-ductsal-isolated';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_CONFIG;

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { clearIsolatedFirestore, clearIsolatedStorage, loadFirestoreRules, assertIsolatedUp, PROJECT, fsApi, T, ID, seedUsers } = require('./iso');
const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');
const { createClientsService } = require('../clientsService');
const { createStorageService } = require('../storageService');
const { planHistoricalQuotesMigration } = require('../migrateHistoricalQuotes');

if (!getApps().length) initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();

const S = {};
let seq = 0;
const opId = (prefix = 'op') => `${prefix}-${Date.now()}-${++seq}`;

function createBarrier(count) {
  let resolveAll;
  const promise = new Promise(resolve => { resolveAll = resolve; });
  let arrived = 0;
  return async function enter() {
    arrived++;
    if (arrived === count) {
      resolveAll();
    }
    await promise;
  };
}

let commercialSvc;
let wfSvc;
let clientsSvc;
let storageSvc;

beforeAll(async () => {
  await assertIsolatedUp();
  await clearIsolatedFirestore();
  await clearIsolatedStorage();
  await loadFirestoreRules();
  await seedUsers();

  S.MGR = { uid: 'uid-mgr', cid: ID.MGR, role: 'manager', name: 'Gerente Test' };
  S.GES = { uid: 'uid-ges', cid: ID.GES, role: 'gestor', name: 'Gestor Test' };
  S.V1 = { uid: 'uid-v1', cid: ID.V1, role: 'vendedor', name: 'Vendedor 1' };
  S.V2 = { uid: 'uid-v2', cid: ID.V2, role: 'vendedor', name: 'Vendedor 2' };
  S.V3 = { uid: 'uid-v3', cid: ID.V3, role: 'vendedor', name: 'Vendedor 3' };

  commercialSvc = createCommercialService({
    db, FieldValue, suffix: '_prod',
    verifyManager: async uid => uid === 'uid-mgr'
  });

  wfSvc = createProspectWorkflowService({
    db, FieldValue, kit: commercialSvc.kit
  });

  clientsSvc = createClientsService({
    db, FieldValue, suffix: '_prod',
    verifyManager: async uid => uid === 'uid-mgr'
  });

  const mockBucket = {
    name: `${PROJECT}.appspot.com`,
    file: (name) => ({
      getSignedUrl: async () => [`http://127.0.0.1:9290/v0/b/${PROJECT}.appspot.com/o/${encodeURIComponent(name)}?alt=media`],
      exists: async () => [true]
    })
  };

  storageSvc = createStorageService({
    db, bucket: mockBucket, suffix: '_prod'
  });
});

describe('DUCTSAL ERP — Fase 4B.5: Suite B — Flujos Integrales Obligatorios', () => {

  test('Flujo 1 — Cliente: Creación, consulta de historial, sustitución de documento y disponibilidad de versión previa', async () => {
    const clientId = 'C_F1';
    await db.collection('clients_prod').doc(clientId).set({
      id: clientId,
      nombre: 'Industrias F1 S.A.',
      empresa: 'Industrias F1 S.A.',
      contacto: 'Carlos Dueñas',
      tipo: 'juridica',
      nit: '0614-010190-101-1',
      nrc: '123456-7',
      telefono: '2222-3333',
      correo: 'carlos@f1.com',
      correo_fact: 'facturas@f1.com',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      visibleTo: [S.V1.cid],
      documentos: {
        dui: { name: 'dui.pdf', storagePath: `prod_files/clients/${clientId}/dui.pdf` },
        dui_rep: { name: 'dui_rep_v1.pdf', storagePath: `prod_files/clients/${clientId}/dui_v1.pdf`, size: 2048 }
      },
      fecha_creacion: new Date().toISOString()
    });

    const vSnapInit = await db.collection(`clients_prod/${clientId}/document_versions`).get();
    expect(vSnapInit.size).toBe(0);

    const updateRes = await clientsSvc.update({
      caller: S.V1,
      id: clientId,
      client: {
        tipo: 'juridica',
        empresa: 'Industrias F1 S.A.',
        contacto: 'Carlos Dueñas',
        nit: '0614-010190-101-1',
        nrc: '123456-7',
        telefono: '2222-3333',
        correo: 'carlos@f1.com',
        correo_fact: 'facturas@f1.com',
        documentos: {
          dui: { name: 'dui.pdf', storagePath: `prod_files/clients/${clientId}/dui.pdf` },
          dui_rep: {
            name: 'dui_rep_v2.pdf',
            storagePath: `prod_files/clients/${clientId}/dui_v2.pdf`,
            size: 4096
          }
        }
      },
      motivosSustitucion: {
        dui_rep: 'Actualización por vencimiento de documento legal'
      }
    });

    expect(updateRes.status).toBe('updated');

    const vSnapAfter = await db.collection(`clients_prod/${clientId}/document_versions`).get();
    expect(vSnapAfter.size).toBeGreaterThanOrEqual(1);
    const archivedV1 = vSnapAfter.docs.map(d => d.data()).find(d => d.docKey === 'dui_rep' && d.estado === 'historica');
    expect(archivedV1).toBeDefined();
    expect(archivedV1.storagePath).toBe(`prod_files/clients/${clientId}/dui_v1.pdf`);

    const clientDoc = (await db.collection('clients_prod').doc(clientId).get()).data();
    expect(clientDoc.documentos.dui_rep.name).toBe('dui_rep_v2.pdf');
    expect(clientDoc.documentos.dui_rep.storagePath).toBe(`prod_files/clients/${clientId}/dui_v2.pdf`);

    const dlActive = await storageSvc.getSecureDownloadUrl({
      caller: S.V1,
      clientId,
      storagePath: `prod_files/clients/${clientId}/dui_v2.pdf`
    });
    expect(dlActive.signedUrl).toBeTruthy();

    const dlArchived = await storageSvc.getSecureDownloadUrl({
      caller: S.V1,
      clientId,
      storagePath: `prod_files/clients/${clientId}/dui_v1.pdf`
    });
    expect(dlArchived.signedUrl).toBeTruthy();
  });

  test('Flujo 2 — Oportunidad Comercial: Registro de oferta, cuadro de costos, sustitución y vinculación de versiones', async () => {
    const prospectId = 'P_F2';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Proyecto Flujo 2',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'negociacion',
      estado: 'activo',
      precio_cotizado: 10000,
      costo_venta: 6000,
      datos: {},
      fecha_creacion: new Date().toISOString()
    });

    await wfSvc.registerProposal({
      caller: S.V1,
      prospectId,
      precio_cotizado: 10000,
      costo_venta: 6000,
      doc_oferta: [{ name: 'oferta_v1.pdf', storagePath: `prod_files/prospects/${prospectId}/oferta_v1.pdf` }],
      doc_costos: [{ name: 'costos_v1.xlsx', storagePath: `prod_files/prospects/${prospectId}/costos_v1.xlsx` }]
    });

    await wfSvc.registerProposal({
      caller: S.V1,
      prospectId,
      precio_cotizado: 9200,
      costo_venta: 5800,
      doc_oferta: [{ name: 'oferta_v2.pdf', storagePath: `prod_files/prospects/${prospectId}/oferta_v2.pdf` }],
      doc_costos: [{ name: 'costos_v2.xlsx', storagePath: `prod_files/prospects/${prospectId}/costos_v2.xlsx` }]
    });

    const verSnap = await db.collection(`prospects_prod/${prospectId}/document_versions`).get();
    expect(verSnap.size).toBeGreaterThanOrEqual(2);
    const versions = verSnap.docs.map(d => d.data());

    const ofV1 = versions.find(v => v.docKey === 'doc_oferta' && v.versionNumber === 1);
    expect(ofV1).toMatchObject({
      entityType: 'prospect',
      entityId: prospectId,
      docKey: 'doc_oferta',
      tipoArtefacto: 'oferta_comercial',
      precioAsociado: 10000,
      costoAsociado: 6000
    });

    const coV1 = versions.find(v => v.docKey === 'doc_costos' && v.versionNumber === 1);
    expect(coV1).toMatchObject({
      entityType: 'prospect',
      entityId: prospectId,
      docKey: 'doc_costos',
      tipoArtefacto: 'cuadro_costos_interno',
      precioAsociado: 10000,
      costoAsociado: 6000
    });

    const pDoc = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    expect(pDoc.precio_cotizado).toBe(9200);
    expect(pDoc.costo_venta).toBe(5800);
    expect(pDoc.datos.doc_oferta[0].name).toBe('oferta_v2.pdf');
  });

  test('Flujo 3 — Cierre: Oferta de sustento, autorización sin contrato, doc_firmado y finalización', async () => {
    const prospectId = 'P_F3';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Proyecto Cierre F3',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'negociacion',
      estado: 'activo',
      precio_cotizado: 8000,
      costo_venta: 5000,
      datos: {
        doc_oferta: [{ name: 'oferta_final.pdf', storagePath: `prod_files/prospects/${prospectId}/oferta_final.pdf` }]
      },
      fecha_creacion: new Date().toISOString()
    });

    await wfSvc.advanceStage({
      caller: S.V1,
      prospectId,
      nextStage: 'cierre',
      data: {}
    });

    const reqRes = await commercialSvc.requestNoContractAuthorization({
      caller: S.V1,
      prospectId,
      motivo: 'Cliente pagará 100% anticipado contra orden de compra',
      opId: opId('auth-req')
    });
    expect(reqRes.status).toBe('requested');

    const authRes = await commercialSvc.resolveNoContractAuthorization({
      caller: S.MGR,
      prospectId,
      requestId: reqRes.request.id,
      decision: 'approve',
      motivoDecision: 'Autorizado por ser cliente corporativo con anticipo total'
    });
    expect(authRes.status).toBe('approved');

    const finRes = await wfSvc.finalizeProspect({
      caller: S.V1,
      prospectId,
      data: {
        forma_pago: '100% anticipado',
        factura_anticipo: 'FAC-F3-01',
        doc_firmado: { name: 'orden_compra.pdf', storagePath: `prod_files/prospects/${prospectId}/oc.pdf` },
        doc_comprobante: { name: 'transferencia.pdf', storagePath: `prod_files/prospects/${prospectId}/transf.pdf` }
      }
    });

    expect(finRes.status).toBe('finalized');

    const pDoc = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    expect(pDoc.estado).toBe('ganado');
    expect(pDoc.datos.oferta_sustento_cierre).toBeTruthy();
    expect(pDoc.datos.oferta_sustento_cierre.name).toBe('oferta_final.pdf');
    expect(pDoc.facturas).toHaveLength(1);
    expect(pDoc.facturas[0].numero).toBe('FAC-F3-01');
  });

  test('Flujo 4 — Sustitución de oferta aprobada: Invalida autorización dependiente y bloquea cierre', async () => {
    const prospectId = 'P_F4';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Proyecto Invalidation F4',
      tipo_proyecto: 'Fabricación e instalación',
      encargado: 'Instalador Carlos',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      precio_cotizado: 15000,
      costo_venta: 9000,
      autorizado_sin_contrato: true,
      aprobacion_sin_contrato: {
        estado: 'aprobada',
        autorizado_por_id: S.MGR.cid,
        fecha: new Date().toISOString()
      },
      datos: {
        doc_oferta: [{ name: 'oferta_aprobada.pdf', storagePath: `prod_files/prospects/${prospectId}/of_aprobada.pdf` }],
        doc_firmado: { name: 'orden_aprobada.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_aprobada.pdf` },
        doc_comprobante: { name: 'comp.pdf', storagePath: `prod_files/prospects/${prospectId}/comp.pdf` }
      },
      fecha_creacion: new Date().toISOString()
    });

    await wfSvc.saveClosingDocuments({
      caller: S.V1,
      prospectId,
      data: {
        doc_firmado: {
          name: 'orden_modificada.pdf',
          storagePath: `prod_files/prospects/${prospectId}/oc_modificada.pdf`,
          motivoSustitucion: 'Cambio en condiciones comerciales de la orden'
        }
      }
    });

    const pAfter = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    expect(pAfter.autorizado_sin_contrato).toBe(false);
    expect(pAfter.aprobacion_sin_contrato.estado).toBe('invalidada_por_sustitucion');

    await expect(wfSvc.finalizeProspect({
      caller: S.V1,
      prospectId,
      data: {
        forma_pago: '70/30',
        factura_anticipo: 'FAC-FAIL',
        doc_firmado: { name: 'orden_modificada.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_modificada.pdf` },
        doc_comprobante: { name: 'comp.pdf', storagePath: `prod_files/prospects/${prospectId}/comp.pdf` }
      }
    })).rejects.toThrow(/invalidada por sustitución/);
  });

  test('Flujo 5 — Documentos no relacionados: Modificación de doc_comprobante NO invalida autorización sin contrato', async () => {
    const prospectId = 'P_F5';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Proyecto No Invalidation F5',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      precio_cotizado: 5000,
      costo_venta: 3000,
      autorizado_sin_contrato: true,
      aprobacion_sin_contrato: {
        estado: 'aprobada',
        autorizado_por_id: S.MGR.cid,
        fecha: new Date().toISOString()
      },
      datos: {
        doc_firmado: { name: 'oferta_firmada.pdf', storagePath: `prod_files/prospects/${prospectId}/of_f.pdf` },
        doc_comprobante: { name: 'comp_viejo.pdf', storagePath: `prod_files/prospects/${prospectId}/comp_viejo.pdf` }
      },
      fecha_creacion: new Date().toISOString()
    });

    await wfSvc.saveClosingDocuments({
      caller: S.V1,
      prospectId,
      data: {
        doc_comprobante: {
          name: 'comp_nuevo.pdf',
          storagePath: `prod_files/prospects/${prospectId}/comp_nuevo.pdf`,
          motivoSustitucion: 'Nuevo comprobante con sello de banco'
        }
      }
    });

    const pAfter = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    expect(pAfter.autorizado_sin_contrato).toBe(true);
    expect(pAfter.aprobacion_sin_contrato.estado).toBe('aprobada');
  });

  test('Flujo 6 — Historial y permisos: Acceso cruzado entre entidades no autorizadas es rechazado', async () => {
    // V3 attempts to get secure URL for client C_F1 which belongs to V1
    await expect(storageSvc.getSecureDownloadUrl({
      caller: S.V3,
      clientId: 'C_F1',
      storagePath: 'prod_files/clients/C_F1/dui_v2.pdf'
    })).rejects.toThrow(/No tienes permiso|acceso/i);

    // V3 attempts to access prospect P_F2 which belongs to V1
    await expect(storageSvc.getSecureDownloadUrl({
      caller: S.V3,
      prospectId: 'P_F2',
      storagePath: 'prod_files/prospects/P_F2/oferta_v2.pdf'
    })).rejects.toThrow(/No tienes acceso|permiso/i);

    // Contradictory context: storagePath of client C_F1 passed with mismatching clientId
    await expect(storageSvc.getSecureDownloadUrl({
      caller: S.V1,
      clientId: 'C_WRONG_ID',
      storagePath: 'prod_files/clients/C_F1/dui_v2.pdf'
    })).rejects.toThrow(/contradictorio|inconsistente/i);
  });
});

describe('DUCTSAL ERP — Fase 4B.5: Suite C — Pruebas de Concurrencia con Barreras de Sincronización', () => {

  test('C1. Dos reemplazos simultáneos del mismo documento no pierden versiones ni generan estados inconsistentes', async () => {
    const prospectId = 'P_C1_CONC';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Concurrencia C1',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      precio_cotizado: 10000,
      costo_venta: 6000,
      datos: {
        doc_firmado: { name: 'firmado_inicial.pdf', storagePath: `prod_files/prospects/${prospectId}/firmado_v1.pdf` }
      },
      fecha_creacion: new Date().toISOString()
    });

    const barrier = createBarrier(2);

    const task1 = async () => {
      await barrier();
      return wfSvc.saveClosingDocuments({
        caller: S.V1,
        prospectId,
        data: {
          doc_firmado: { name: 'firmado_t1.pdf', storagePath: `prod_files/prospects/${prospectId}/firmado_t1.pdf`, motivoSustitucion: 'Reemplazo T1' }
        }
      });
    };

    const task2 = async () => {
      await barrier();
      return wfSvc.saveClosingDocuments({
        caller: S.V1,
        prospectId,
        data: {
          doc_firmado: { name: 'firmado_t2.pdf', storagePath: `prod_files/prospects/${prospectId}/firmado_t2.pdf`, motivoSustitucion: 'Reemplazo T2' }
        }
      });
    };

    const results = await Promise.all([task1(), task2()]);
    expect(results).toHaveLength(2);

    const vSnap = await db.collection(`prospects_prod/${prospectId}/document_versions`).get();
    expect(vSnap.size).toBeGreaterThanOrEqual(1);

    const pDoc = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    expect(['firmado_t1.pdf', 'firmado_t2.pdf']).toContain(pDoc.datos.doc_firmado.name);
  });

  test('C2. Reintentos e idempotencia: misma operación simultánea con mismo opId no duplica registros', async () => {
    const prospectId = 'P_C2_RETRY';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Concurrencia C2',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      precio_cotizado: 5000,
      costo_venta: 3000,
      datos: {
        doc_firmado: { name: 'init.pdf', storagePath: `prod_files/prospects/${prospectId}/init.pdf` }
      },
      fecha_creacion: new Date().toISOString()
    });

    const sharedOpId = opId('c2-idempotency');
    const barrier = createBarrier(2);

    const task = async () => {
      await barrier();
      return wfSvc.saveClosingDocuments({
        caller: S.V1,
        prospectId,
        data: {
          opId: sharedOpId,
          doc_firmado: {
            name: 'retry_file.pdf',
            storagePath: `prod_files/prospects/${prospectId}/retry_file.pdf`,
            motivoSustitucion: 'Reintento idempotente'
          }
        }
      });
    };

    const results = await Promise.all([task(), task()]);
    expect(results).toHaveLength(2);

    // 1 version for archived init.pdf + 1 version for retry_file.pdf = 2 versions (retry does not add 3rd version)
    const vSnap = await db.collection(`prospects_prod/${prospectId}/document_versions`).get();
    expect(vSnap.size).toBe(2);
  });

  test('C3. Reemplazo de oferta durante la aprobación: no puede quedar aprobada una versión diferente', async () => {
    const prospectId = 'P_C3_RACE';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Concurrencia C3',
      tipo_proyecto: 'Fabricación e instalación',
      encargado: 'Instalador Carlos',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      precio_cotizado: 20000,
      costo_venta: 12000,
      datos: {
        doc_firmado: { name: 'firmado_v1.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_v1.pdf` },
        doc_comprobante: { name: 'comp.pdf', storagePath: `prod_files/prospects/${prospectId}/comp.pdf` }
      },
      solicitudes_sin_contrato: [
        { id: 'REQ_C3', estado: 'pendiente', motivo: 'Autorización inicial', solicitante_id: S.V1.cid, fecha: new Date().toISOString() }
      ],
      fecha_creacion: new Date().toISOString()
    });

    const barrier = createBarrier(2);

    const taskApprove = async () => {
      await barrier();
      return commercialSvc.resolveNoContractAuthorization({
        caller: S.MGR,
        prospectId,
        requestId: 'REQ_C3',
        decision: 'approve',
        motivoDecision: 'Aprobado versión activa'
      });
    };

    const taskReplace = async () => {
      await barrier();
      return wfSvc.saveClosingDocuments({
        caller: S.V1,
        prospectId,
        data: {
          doc_firmado: { name: 'firmado_v2.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_v2.pdf`, motivoSustitucion: 'Ajuste de última hora' }
        }
      });
    };

    await Promise.all([taskApprove(), taskReplace()]);

    const pDoc = (await db.collection('prospects_prod').doc(prospectId).get()).data();
    const activePath = pDoc.datos && pDoc.datos.doc_firmado ? (pDoc.datos.doc_firmado.storagePath || pDoc.datos.doc_firmado.url) : null;
    const approvedPath = pDoc.aprobacion_sin_contrato ? pDoc.aprobacion_sin_contrato.storagePathAprobado : null;

    // Condición de aceptación: no puede quedar aprobada una versión distinta de la que sustenta el cierre
    if (pDoc.aprobacion_sin_contrato && pDoc.aprobacion_sin_contrato.estado === 'aprobada') {
      expect(approvedPath).toBe(activePath);
    } else {
      expect(pDoc.aprobacion_sin_contrato.estado).toBe('invalidada_por_sustitucion');
    }

    // Reemplazo inmediatamente antes de finalizeProspect: el backend debe rechazar la finalización
    await wfSvc.saveClosingDocuments({
      caller: S.V1,
      prospectId,
      data: {
        doc_firmado: { name: 'firmado_v3.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_v3.pdf`, motivoSustitucion: 'Reemplazo justo antes de cierre' }
      }
    });

    await expect(wfSvc.finalizeProspect({
      caller: S.V1,
      prospectId,
      data: {
        forma_pago: '70/30',
        factura_anticipo: 'FAC-C3-FAIL',
        doc_firmado: { name: 'firmado_v3.pdf', storagePath: `prod_files/prospects/${prospectId}/oc_v3.pdf` },
        doc_comprobante: { name: 'comp.pdf', storagePath: `prod_files/prospects/${prospectId}/comp.pdf` }
      }
    })).rejects.toThrow(/invalidada por sustitución|no coincide/);
  });

  test('C4. Dos finalizaciones concurrentes de la misma oportunidad generan exactamente un cierre e invoice', async () => {
    const prospectId = 'P_C4_FIN';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Concurrencia C4',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      precio_cotizado: 4500,
      costo_venta: 2500,
      forma_pago: '100% anticipado',
      datos: {
        doc_oferta: [{ name: 'of.pdf', storagePath: `prod_files/prospects/${prospectId}/of.pdf` }]
      },
      fecha_creacion: new Date().toISOString()
    });

    const barrier = createBarrier(2);

    const taskFinalize = async (facturaNum) => {
      await barrier();
      try {
        return await wfSvc.finalizeProspect({
          caller: S.V1,
          prospectId,
          data: {
            forma_pago: '100% anticipado',
            factura_anticipo: facturaNum,
            doc_firmado: { name: 'firmado.pdf', storagePath: `prod_files/prospects/${prospectId}/firmado.pdf` },
            doc_comprobante: { name: 'comp.pdf', storagePath: `prod_files/prospects/${prospectId}/comp.pdf` }
          }
        });
      } catch (err) {
        return { error: err.message };
      }
    };

    await Promise.all([taskFinalize('FAC-C4-1'), taskFinalize('FAC-C4-2')]);
    const pDoc = (await db.collection('prospects_prod').doc(prospectId).get()).data();

    expect(pDoc.estado).toBe('ganado');
    expect(pDoc.facturas).toHaveLength(1);
  });

  test('C5. Migración histórica concurrente: dos procesos en paralelo son idempotentes sin duplicar versiones', async () => {
    const pId = 'P_C5_MIG';
    await db.collection('prospects_prod').doc(pId).set({
      id: pId,
      precio_cotizado: 15000,
      costo_venta: 9000,
      vendedorId: S.V1.cid,
      datos: {
        doc_oferta: [{ name: 'oferta_hist.pdf', storagePath: `prod_files/prospects/${pId}/oferta.pdf` }],
        doc_costos: [{ name: 'costos_hist.xlsx', storagePath: `prod_files/prospects/${pId}/costos.xlsx` }]
      }
    });

    const barrier = createBarrier(2);
    const runMigration = async () => {
      await barrier();
      return planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });
    };

    const [mig1, mig2] = await Promise.all([runMigration(), runMigration()]);
    expect(mig1).toBeDefined();
    expect(mig2).toBeDefined();

    const verSnap = await db.collection(`prospects_prod/${pId}/document_versions`).get();
    expect(verSnap.size).toBe(2);
  });

  test('C6. Acceso cruzado simultáneo: intento de acceso no autorizado durante sustitución es denegado', async () => {
    const prospectId = 'P_C6_CROSS';
    await db.collection('prospects_prod').doc(prospectId).set({
      id: prospectId,
      proyecto: 'Concurrencia C6',
      clientId: 'C_F1',
      createdBy: S.V1.cid,
      vendedorId: S.V1.cid,
      etapa: 'cierre',
      estado: 'activo',
      forma_pago: '70/30',
      datos: {
        doc_firmado: { name: 'f1.pdf', storagePath: `prod_files/prospects/${prospectId}/f1.pdf` }
      }
    });

    const barrier = createBarrier(2);

    const taskReplace = async () => {
      await barrier();
      return wfSvc.saveClosingDocuments({
        caller: S.V1,
        prospectId,
        data: {
          doc_firmado: { name: 'f2.pdf', storagePath: `prod_files/prospects/${prospectId}/f2.pdf`, motivoSustitucion: 'Cambio simultaneo' }
        }
      });
    };

    const taskIntrude = async () => {
      await barrier();
      try {
        await storageSvc.getSecureDownloadUrl({
          caller: S.V3,
          prospectId,
          storagePath: `prod_files/prospects/${prospectId}/f1.pdf`
        });
        return { status: 'allowed' };
      } catch (e) {
        return { status: 'rejected', error: e.message };
      }
    };

    const [repRes, intRes] = await Promise.all([taskReplace(), taskIntrude()]);
    expect(repRes.status).toBe('saved');
    expect(intRes.status).toBe('rejected');
  });
});

describe('DUCTSAL ERP — Fase 4B.5: Suite D — Migración Histórica en Modo Simulación y Auditoría', () => {

  test('Simulación dry-run categoriza casos y no realiza escrituras; segunda pasada real es idempotente', async () => {
    const pMigrable = 'P_MIG_AUDIT';
    const pAmbiguous = 'P_AMB_AUDIT';
    const pDuplicate = 'P_DUP_AUDIT';

    await db.collection('prospects_prod').doc(pMigrable).set({
      id: pMigrable,
      precio_cotizado: 11000,
      costo_venta: 7000,
      vendedorId: S.V1.cid,
      datos: {
        doc_oferta: [{ name: 'of.pdf', storagePath: `prod_files/prospects/${pMigrable}/of.pdf` }]
      }
    });

    await db.collection('prospects_prod').doc(pAmbiguous).set({
      id: pAmbiguous,
      datos: {
        doc_oferta: ['ftp://unsupported-host/file.pdf']
      }
    });

    await db.collection('prospects_prod').doc(pDuplicate).set({
      id: pDuplicate,
      datos: {
        doc_oferta: [
          { name: 'dup1.pdf', storagePath: `prod_files/prospects/${pDuplicate}/dup.pdf` },
          { name: 'dup2.pdf', storagePath: `prod_files/prospects/${pDuplicate}/dup.pdf` }
        ]
      }
    });

    const dryRun = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.counts.executedWrites).toBe(0);
    expect(dryRun.counts.ambiguous).toBeGreaterThanOrEqual(1);
    expect(dryRun.counts.duplicates).toBeGreaterThanOrEqual(1);

    const realRun1 = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });
    expect(realRun1.counts.executedWrites).toBeGreaterThanOrEqual(1);

    const realRun2 = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });
    expect(realRun2.counts.executedWrites).toBe(0);
    expect(realRun2.counts.alreadyVersioned).toBeGreaterThanOrEqual(1);
  });
});

describe('DUCTSAL ERP — Fase 4B.5: Suite E — Reglas de Seguridad en Emulador', () => {

  test('Cliente no puede escribir directamente a subcolección document_versions vía REST', async () => {
    const rSet = await fsApi.set('prospects_prod/P_F2/document_versions', 'HACK_V1', { versionId: 'HACK_V1', estado: 'vigente' }, T.v1);
    expect(rSet.status).toBe(403);

    const rDel = await fsApi.del('prospects_prod/P_F2/document_versions', 'HACK_V1', T.v1);
    expect(rDel.status).toBe(403);

    const rMgr = await fsApi.set('prospects_prod/P_F2/document_versions', 'HACK_MGR', { versionId: 'HACK_MGR', estado: 'vigente' }, T.mgr);
    expect(rMgr.status).toBe(403);
  });

  test('Lectura de document_versions está permitida a usuarios autorizados y denegada a usuarios no relacionados', async () => {
    await fsApi.seed('prospects_prod', 'P_RULES', {
      id: 'P_RULES',
      createdBy: ID.V1,
      vendedorId: ID.V1,
      clientId: 'C_F1',
      estado: 'activo'
    });

    await fsApi.seed('prospects_prod/P_RULES/document_versions', 'v1_doc', {
      versionId: 'v1_doc',
      docKey: 'doc_oferta',
      estado: 'vigente'
    });

    const rReadV1 = await fsApi.get('prospects_prod/P_RULES/document_versions', 'v1_doc', T.v1);
    expect(rReadV1.status).toBe(200);

    const rReadV3 = await fsApi.get('prospects_prod/P_RULES/document_versions', 'v1_doc', T.v3);
    expect(rReadV3.status).toBe(403);
  });
});
