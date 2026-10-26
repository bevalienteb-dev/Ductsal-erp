// functions/__tests__/migrateHistoricalQuotes.unit.test.js
const { createFakeFirestore } = require('../test-helpers/fakeFirestore');
const { planHistoricalQuotesMigration } = require('../migrateHistoricalQuotes');

describe('Fase 4B.5 Acción 2: Migración y Trazabilidad Histórica de Cotizaciones', () => {
  let db;

  beforeEach(() => {
    db = createFakeFirestore();
  });

  test('1. dry-run analiza registros, cuenta categorías y NO realiza escrituras', async () => {
    // Seed test prospects
    await db.collection('prospects_prod').doc('P_WITH_QUOTE').set({
      id: 'P_WITH_QUOTE',
      precio_cotizado: 5000,
      costo_venta: 3000,
      vendedorId: 'V1',
      datos: {
        doc_oferta: [{ name: 'oferta_v1.pdf', storagePath: 'prod_files/prospects/P_WITH_QUOTE/proyectos/oferta.pdf' }],
        doc_costos: [{ name: 'costos_v1.xlsx', storagePath: 'prod_files/prospects/P_WITH_QUOTE/proyectos/costos.xlsx' }]
      }
    });

    await db.collection('prospects_prod').doc('P_AMBIGUOUS').set({
      id: 'P_AMBIGUOUS',
      datos: {
        doc_oferta: ['ruta_invalida_sin_storage_path_ni_url']
      }
    });

    await db.collection('prospects_prod').doc('P_NO_QUOTES').set({
      id: 'P_NO_QUOTES',
      datos: {}
    });

    const report = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.counts.totalProspects).toBe(3);
    expect(report.counts.prospectsWithQuotes).toBe(2);
    expect(report.counts.migrableQuotes).toBe(1);
    expect(report.counts.migrableCostSheets).toBe(1);
    expect(report.counts.ambiguous).toBe(1);
    expect(report.counts.executedWrites).toBe(0);

    // Verify that NO documents were written to document_versions
    const versionsSnap = await db.collection('prospects_prod/P_WITH_QUOTE/document_versions').get();
    expect(versionsSnap.size).toBe(0);
  });

  test('2. ejecución en entorno de prueba migra registros con trazabilidad y sin inventar datos', async () => {
    await db.collection('prospects_prod').doc('P_REAL').set({
      id: 'P_REAL',
      precio_cotizado: 12500,
      costo_venta: 8000,
      vendedorId: 'V_CARLOS',
      fecha_creacion: '2026-05-10T10:00:00Z',
      datos: {
        doc_oferta: [{ name: 'oferta_oficial.pdf', storagePath: 'prod_files/prospects/P_REAL/proyectos/oferta.pdf', size: 102400 }],
        doc_costos: [{ name: 'cuadro_costos.xlsx', storagePath: 'prod_files/prospects/P_REAL/proyectos/costos.xlsx', size: 51200 }]
      }
    });

    // Execute migration with dryRun = false
    const report = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });

    expect(report.counts.migrableQuotes).toBe(1);
    expect(report.counts.migrableCostSheets).toBe(1);
    expect(report.counts.executedWrites).toBe(2);

    // Verify subcollection records
    const versionsSnap = await db.collection('prospects_prod/P_REAL/document_versions').get();
    expect(versionsSnap.size).toBe(2);

    const docs = versionsSnap.docs.map(d => d.data());
    const ofertaDoc = docs.find(d => d.docKey === 'doc_oferta');
    const costosDoc = docs.find(d => d.docKey === 'doc_costos');

    expect(ofertaDoc).toMatchObject({
      entityType: 'prospect',
      entityId: 'P_REAL',
      docKey: 'doc_oferta',
      tipoArtefacto: 'oferta_comercial',
      esHeredado: true,
      estado: 'vigente',
      precioAsociado: 12500,
      costoAsociado: 8000,
      subidoPorId: 'V_CARLOS',
      motivoSustitucion: null, // No se inventa motivo
      hash: null // No se inventa hash sin bytes
    });

    expect(costosDoc).toMatchObject({
      entityType: 'prospect',
      entityId: 'P_REAL',
      docKey: 'doc_costos',
      tipoArtefacto: 'cuadro_costos_interno',
      esHeredado: true,
      estado: 'vigente'
    });
  });

  test('3. re-ejecución es idempotente y no duplica versiones ya migradas', async () => {
    await db.collection('prospects_prod').doc('P_IDEMPOTENT').set({
      id: 'P_IDEMPOTENT',
      datos: {
        doc_oferta: [{ name: 'oferta.pdf', storagePath: 'prod_files/prospects/P_IDEMPOTENT/oferta.pdf' }]
      }
    });

    // Run 1
    const run1 = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });
    expect(run1.counts.executedWrites).toBe(1);

    // Run 2
    const run2 = await planHistoricalQuotesMigration({ db, suffix: '_prod', dryRun: false });
    expect(run2.counts.executedWrites).toBe(0);
    expect(run2.counts.alreadyVersioned).toBe(1);

    const versionsSnap = await db.collection('prospects_prod/P_IDEMPOTENT/document_versions').get();
    expect(versionsSnap.size).toBe(1);
  });
});
