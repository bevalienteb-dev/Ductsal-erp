'use strict';

/**
 * functions/scripts/resolveBank078Prod.js
 *
 * Procedimiento idempotente y auditado para resolver la colisión histórica `payment_refs_prod/BANK_078`
 * (Caso B — Un único pago bancario Transfer365 Banco Agrícola Ref. `868355650` por US$16,983.51 del
 * 01/09/2026 aplicado al CCF #078 `DTE-03-M001P001-000000000000078` y distribuido en las dos
 * oportunidades del contrato CONDOMINIO HABITACIONAL VERTICAL DESIRÉ del cliente CONSTRU-SERVICES, S.A. DE C.V.).
 *
 * SEGURIDAD:
 * - Por defecto ejecuta exclusivamente en modo `--dry-run` (solo lectura).
 * - Para aplicar los cambios en Firestore requiere pasar explícitamente:
 *   `node functions/scripts/resolveBank078Prod.js --apply --confirm-bank078-resolution`
 */

const { createCommercialService } = require('../commercialService');
const { createProspectWorkflowService } = require('../prospectWorkflowService');

const BANK_078_RESOLUTION_SPEC = {
  lockId: 'BANK_078',
  resolutionMode: 'CASO_B_PAGO_UNICO_DISTRIBUIDO_MISMO_CLIENTE',
  baseBankRef: '868355650',
  totalVoucherAmount: 16983.51,
  clientId: 'CUST-1777081077121-95',
  clientName: 'CONSTRU-SERVICES, S.A. DE C.V.',
  dteControlNumber: 'DTE-03-M001P001-000000000000078',
  dteGenerationCode: '59140782-A419-4A58-A2AA-3FB64FFB3726',
  dteTotalAmount: 16983.52,
  dteRoundingVariance: 0.01,
  dteRoundingExplanation: 'En el DTE consolidado CCF #078 (US$16,983.52) cada línea del 50% neto fue redondeada a 2 decimales antes de calcular el IVA global del 13%: Línea 1 (Presurización): 16,214.50 * 0.50 = US$8,107.25; Línea 2 (Edificio Desiré / Chute): 13,844.81 * 0.50 = 6,922.405 -> US$6,922.41 (+US$0.005); Subtotal gravado DTE = US$15,029.66; IVA 13% = 15,029.66 * 0.13 = 1,953.8558 -> US$1,953.86 (+US$0.0042); Total DTE = US$16,983.52 (+US$0.01 acumulado). En cambio, cada proyecto individual en el CRM y la transferencia bancaria real Transfer365 #868355650 suman exactamente US$9,161.19 + US$7,822.32 = US$16,983.51, cubriendo el 100.00% de ambos anticipos exigibles con variación US$0.00.',
  bankOrigin: 'BANCO AGRICOLA (ABONO TRANSFER365 PAGOS RECIBIDO)',
  voucherDate: '2026-09-01T17:07:00',
  notes: 'Resolución documental auditada Caso B: Transferencia única Transfer365 Banco Agrícola Ref. 868355650 por US$16,983.51 (01/09/2026 17:07:00) aplicada al CCF DTE-03-M001P001-000000000000078 (50% anticipo del contrato CONDOMINIO HABITACIONAL VERTICAL DESIRÉ: US$9,161.19 Presurización [202605023] + US$7,822.32 Chute para basura [EDIFICIO DESIRE]).',
  tranches: [
    {
      prospectId: '1779123328318',
      codigo: '202605023',
      proyecto: 'PRESURIZACION',
      invoiceId: '1789408613812',
      paymentKey: '2026-09-14T19:13:28.456Z',
      fechaRegistroCrm: '2026-09-14T19:13:28.456Z',
      contractSubtotalSinIva: 16214.50,
      expectedFormaPago: '50/50',
      expectedAmount: 9161.19,
      applicationId: 'APP_868355650_1779123328318_1789408613812',
      tramoId: 'TRAMO_868355650_1'
    },
    {
      prospectId: 'OPP-1777081077278-7',
      codigo: 'OPP-1777081077278-7',
      proyecto: 'EDIFICIO DESIRE',
      invoiceId: '1789408531939',
      paymentKey: '2026-09-14T19:11:44.724Z',
      fechaRegistroCrm: '2026-09-14T19:11:44.724Z',
      contractSubtotalSinIva: 13844.81,
      expectedFormaPago: '50/50',
      expectedAmount: 7822.32,
      applicationId: 'APP_868355650_OPP-1777081077278-7_1789408531939',
      tramoId: 'TRAMO_868355650_2'
    }
  ]
};

async function runResolution({ db, FieldValue, apply = false, caller = null } = {}) {
  const effectiveCaller = caller || {
    uid: 'system-admin-bank078-resolver',
    cid: 'SYSTEM_ADMIN',
    name: 'Resolución Auditada BANK_078',
    role: 'manager',
    active: true
  };

  const canonicalLockId = `BANK_${BANK_078_RESOLUTION_SPEC.baseBankRef}`;
  const lockRef = db.collection('payment_refs_prod').doc(BANK_078_RESOLUTION_SPEC.lockId);
  const baseLockRef = db.collection('payment_refs_prod').doc(canonicalLockId);
  const rawUnprefixedRef = db.collection('payment_refs_prod').doc(BANK_078_RESOLUTION_SPEC.baseBankRef);
  const [lockSnap, baseLockSnap, rawUnprefixedSnap, p1Snap, p2Snap] = await Promise.all([
    lockRef.get(),
    baseLockRef.get(),
    rawUnprefixedRef.get(),
    db.collection('prospects_prod').doc(BANK_078_RESOLUTION_SPEC.tranches[0].prospectId).get(),
    db.collection('prospects_prod').doc(BANK_078_RESOLUTION_SPEC.tranches[1].prospectId).get()
  ]);

  const summarizeProspect = (snap, tranche) => {
    if (!snap || !snap.exists) return null;
    const d = snap.data() || {};
    const fac = Array.isArray(d.facturas) ? d.facturas.find(f => f && f.id === tranche.invoiceId) : null;
    const pay = fac && Array.isArray(fac.pagos)
      ? fac.pagos.find(pg => pg && (pg.id === tranche.paymentKey || pg.fecha === tranche.paymentKey))
      : null;
    return {
      prospectId: snap.id,
      codigo: d.codigo || null,
      proyecto: d.proyecto || null,
      precioCotizadoSinIva: d.precio_cotizado ?? null,
      formaPagoActual: d.forma_pago || null,
      formaPagoEsperada: tranche.expectedFormaPago || '50/50',
      facturaId: fac ? fac.id : null,
      facturaNumero: fac ? fac.numero : null,
      facturaMontoActual: fac ? fac.monto : null,
      pagoMontoActual: pay ? pay.monto : null,
      pagoRefActual: pay ? pay.ref : null,
      fechaRegistroCrm: pay ? (pay.fecha_registro_crm || pay.fecha || null) : null,
      fechaComprobanteBancario: BANK_078_RESOLUTION_SPEC.voucherDate
    };
  };

  const currentStatus = {
    mode: apply ? 'APPLY' : 'DRY_RUN_READ_ONLY',
    canonicalLockPath: `payment_refs_prod/${canonicalLockId}`,
    conflictLockPath: `payment_refs_prod/${BANK_078_RESOLUTION_SPEC.lockId}`,
    bank078Exists: lockSnap.exists,
    bank078Data: lockSnap.exists ? lockSnap.data() : null,
    bank868355650Exists: baseLockSnap.exists,
    bank868355650Data: baseLockSnap.exists ? baseLockSnap.data() : null,
    rawUnprefixed868355650Exists: rawUnprefixedSnap.exists,
    prospect1Exists: p1Snap.exists,
    prospect2Exists: p2Snap.exists,
    prospect1Summary: summarizeProspect(p1Snap, BANK_078_RESOLUTION_SPEC.tranches[0]),
    prospect2Summary: summarizeProspect(p2Snap, BANK_078_RESOLUTION_SPEC.tranches[1]),
    spec: BANK_078_RESOLUTION_SPEC
  };

  if (!apply) {
    return {
      status: 'dry_run_ready',
      ...currentStatus
    };
  }

  const commercial = createCommercialService({
    db,
    FieldValue,
    suffix: '_prod',
    verifyManager: async () => true
  });
  const wf = createProspectWorkflowService({
    db,
    FieldValue,
    kit: commercial.kit
  });

  const result = await wf.resolveHistoricalBankConflict({
    caller: effectiveCaller,
    lockId: BANK_078_RESOLUTION_SPEC.lockId,
    resolutionMode: BANK_078_RESOLUTION_SPEC.resolutionMode,
    baseBankRef: BANK_078_RESOLUTION_SPEC.baseBankRef,
    totalVoucherAmount: BANK_078_RESOLUTION_SPEC.totalVoucherAmount,
    tranches: BANK_078_RESOLUTION_SPEC.tranches,
    dteControlNumber: BANK_078_RESOLUTION_SPEC.dteControlNumber,
    dteGenerationCode: BANK_078_RESOLUTION_SPEC.dteGenerationCode,
    dteTotalAmount: BANK_078_RESOLUTION_SPEC.dteTotalAmount,
    dteRoundingExplanation: BANK_078_RESOLUTION_SPEC.dteRoundingExplanation,
    bankOrigin: BANK_078_RESOLUTION_SPEC.bankOrigin,
    voucherDate: BANK_078_RESOLUTION_SPEC.voucherDate,
    notes: BANK_078_RESOLUTION_SPEC.notes
  });

  return {
    ...result,
    mode: 'APPLIED'
  };
}

async function main() {
  const args = process.argv.slice(2);
  const applyRequested = args.includes('--apply');
  const confirmed = args.includes('--confirm-bank078-resolution');

  if (applyRequested && !confirmed) {
    console.error('ERROR: Para ejecutar en modo escritura debe incluir explícitamente --apply --confirm-bank078-resolution');
    process.exit(1);
  }

  const admin = require('firebase-admin');
  const { initializeImpersonatedAdminApp } = require('./googleAuthAdminAdapter');
  await initializeImpersonatedAdminApp(admin, { projectId: 'ductsal-erp' });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  const out = await runResolution({
    db,
    FieldValue,
    apply: applyRequested && confirmed
  });
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  BANK_078_RESOLUTION_SPEC,
  runResolution
};
