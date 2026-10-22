#!/usr/bin/env node
// functions/scripts/cleanupSyntheticDashboardF3.js
// Idempotent teardown script for DUCTSAL ERP - Fase 3 Synthetic Data.
// Strictly isolated to the local Firebase Emulator (demo-ductsal-local on 127.0.0.1:8080).
// Removes ONLY documents matching the prefix TEST_DASHBOARD_F3_.
// Leaves all non-synthetic local data intact (e.g. users_local/1000000000001).

const H = require('../emulator-tests/helpers');
const { PREFIX, CLIENTS, SELLERS, PROSPECTS } = require('./seedSyntheticDashboardF3');

const USERS_COL = 'users_local';
const DIR_COL = 'userDirectory_local';
const CLIENTS_COL = 'clients_local';
const PROSPECTS_COL = 'prospects_local';

async function deleteDoc(collection, docId) {
  const url = `${H.FIRESTORE}/v1/projects/${H.PROJECT}/databases/(default)/documents/${collection}/${docId}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { ...H.OWNER }
  });
  if (r.status === 200 || r.status === 204 || r.status === 404) {
    return { id: docId, collection, status: r.status };
  }
  const text = await r.text();
  throw new Error(`Failed to delete ${collection}/${docId} (status ${r.status}): ${text}`);
}

async function cleanup() {
  console.log('--- DUCTSAL ERP: Limpieza de Datos Sintéticos Fase 3 ---');
  console.log(`Verificando emulador en ${H.FIRESTORE} (proyecto: ${H.PROJECT})...`);
  await H.assertEmulatorsUp();
  console.log('✅ Emulador activo y respondiendo exclusivamente en 127.0.0.1.');

  const removed = {
    prospects: [],
    clients: [],
    sellers: [],
    userDirectory: []
  };

  // 1. Eliminar oportunidades sintéticas
  console.log(`Eliminando oportunidades sintéticas con prefijo ${PREFIX} en ${PROSPECTS_COL}...`);
  for (const p of PROSPECTS) {
    await deleteDoc(PROSPECTS_COL, p.id);
    removed.prospects.push(p.id);
  }
  console.log(`  [OK] ${removed.prospects.length} oportunidades eliminadas.`);

  // 2. Eliminar clientes sintéticos
  console.log(`Eliminando clientes sintéticos con prefijo ${PREFIX} en ${CLIENTS_COL}...`);
  for (const c of CLIENTS) {
    await deleteDoc(CLIENTS_COL, c.id);
    removed.clients.push(c.id);
  }
  console.log(`  [OK] ${removed.clients.length} clientes eliminados.`);

  // 3. Eliminar vendedores sintéticos
  console.log(`Eliminando vendedores sintéticos en ${USERS_COL} y ${DIR_COL}...`);
  for (const s of SELLERS) {
    await deleteDoc(USERS_COL, s.id);
    await deleteDoc(DIR_COL, s.id);
    removed.sellers.push(s.id);
    removed.userDirectory.push(s.id);
  }
  console.log(`  [OK] ${removed.sellers.length} vendedores eliminados de ambas colecciones.`);

  console.log('\n--- RESUMEN DE LIMPIEZA SINTÉTICA ---');
  console.log(`Total documentos sintéticos retirados: ${removed.clients.length + removed.sellers.length * 2 + removed.prospects.length}`);
  console.log('Todos los datos previos y cuentas nativas locales permanecen intactos.');
  console.log('✅ Limpieza completada con éxito.');
  return removed;
}

if (require.main === module) {
  cleanup().catch(err => {
    console.error('❌ Error en cleanup:', err);
    process.exit(1);
  });
}

module.exports = { cleanup };
