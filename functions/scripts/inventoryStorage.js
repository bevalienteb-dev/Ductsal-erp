// functions/scripts/inventoryStorage.js
// SEC-05 Phase 2: Read-Only Storage Inventory Script
// Inspects Firebase Storage / Google Cloud Storage objects for:
// - Routes, prefixes, and path families
// - Sizes and content types (flagging files > 35 MB)
// - Presence of download tokens (WITHOUT printing secret tokens or PII)
// - Metadata formats consumed by the CRM
//
// Usage:
//   Local/Isolated Emulator:
//     STORAGE_EMULATOR_HOST="http://127.0.0.1:9290" node scripts/inventoryStorage.js --project demo-ductsal-isolated --bucket demo-ductsal-isolated.appspot.com
//
//   Production (Read-Only, Requires Authorization & Credentials):
//     GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/inventoryStorage.js --project ductsal-erp --bucket ductsal-erp.firebasestorage.app

const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const { Storage } = require('@google-cloud/storage');

const SIZE_THRESHOLD_35MB = 35 * 1024 * 1024; // 36,700,160 bytes

function parseArgs(argv) {
  const options = {
    project: process.env.GCLOUD_PROJECT || 'demo-ductsal-isolated',
    bucket: process.env.STORAGE_BUCKET || 'demo-ductsal-isolated.appspot.com',
    prefix: '',
    maxResults: 10000,
    outputJson: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) options.project = argv[++i];
    else if (arg === '--bucket' && argv[i + 1]) options.bucket = argv[++i];
    else if (arg === '--prefix' && argv[i + 1]) options.prefix = argv[++i];
    else if (arg === '--json') options.outputJson = true;
  }
  return options;
}

function classifyPath(name) {
  const parts = name.split('/');
  const envPrefix = parts[0] || 'root';
  const folder = parts[1] || 'root';

  let family = 'otros';
  if (['clients', 'clientes'].includes(folder)) family = 'clients';
  else if (['prospects', 'oportunidades'].includes(folder)) family = 'prospects';
  else if (['proyectos'].includes(folder)) family = 'proyectos';
  else if (['facturas'].includes(folder)) family = 'facturas';
  else if (['pagos'].includes(folder)) family = 'pagos';
  else if (['ordenes_cambio'].includes(folder)) family = 'ordenes_cambio';
  else if (['requerimientos'].includes(folder)) family = 'requerimientos';
  else if (['fabricacion_archivos'].includes(folder)) family = 'fabricacion_archivos';

  return { envPrefix, folder, family };
}

function maskToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const tokens = tokenStr.split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(t => `${t.slice(0, 4)}...${t.slice(-4)} (${t.length} chars)`);
}

async function runInventory(options) {
  const isEmulator = !!process.env.STORAGE_EMULATOR_HOST;
  let accessToken = process.env.CLOUD_ACCESS_TOKEN || null;

  if (!accessToken && !isEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const fs = require('fs');
      const cfgPath = (process.env.HOME || '') + '/.config/configstore/firebase-tools.json';
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg.tokens && cfg.tokens.access_token) {
          accessToken = cfg.tokens.access_token;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  let bucket;

  if (isEmulator) {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        projectId: options.project,
        storageBucket: options.bucket
      });
    }
    bucket = admin.storage().bucket(options.bucket);
  } else if (accessToken) {
    // 1. Verify Identity via Google OAuth2 tokeninfo
    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!tokenInfoRes.ok) {
      throw new Error(`Token de acceso temporal inválido o expirado (HTTP ${tokenInfoRes.status}).`);
    }
    const tokenInfo = await tokenInfoRes.json();
    console.log(`[IAM Pre-Flight] Identidad verificada: ${tokenInfo.email || 'token válido'} (expira en ${tokenInfo.expires_in}s)`);

    // 2. Test IAM permissions strictly on bucket
    const iamRes = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${options.bucket}/iam/testPermissions?permissions=storage.objects.get&permissions=storage.objects.list&permissions=storage.objects.create&permissions=storage.objects.delete`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!iamRes.ok) {
      throw new Error(`Error al verificar permisos IAM en bucket ${options.bucket}: HTTP ${iamRes.status}`);
    }
    const iamData = await iamRes.json();
    const permissions = iamData.permissions || [];
    console.log(`[IAM Pre-Flight] Permisos efectivos detectados en ${options.bucket}:`, permissions);

    const hasRead = permissions.includes('storage.objects.get') && permissions.includes('storage.objects.list');
    const hasWrite = permissions.includes('storage.objects.create') || permissions.includes('storage.objects.delete');

    if (!hasRead) {
      throw new Error(`La identidad ${tokenInfo.email} carece de permisos de lectura (storage.objects.get, storage.objects.list) en ${options.bucket}.`);
    }
    if (hasWrite) {
      console.log(`[IAM Pre-Flight] Nota de auditoría: La identidad ${tokenInfo.email} conserva rol administrativo en el proyecto. El script operará estrictamente en modo de solo lectura.`);
    } else {
      console.log(`[IAM Pre-Flight] Cumplimiento verificado: La identidad posee acceso ESTRICTO de solo lectura en ${options.bucket}.`);
    }

    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    const storage = new Storage({ authClient: auth, projectId: options.project });
    bucket = storage.bucket(options.bucket);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        projectId: options.project,
        storageBucket: options.bucket
      });
    }
    bucket = admin.storage().bucket(options.bucket);
  } else {
    throw new Error(
      'No se encontró una identidad de autenticación autorizada para producción.\n' +
      'Inicia sesión con "npx firebase-tools login" o configura la variable CLOUD_ACCESS_TOKEN.'
    );
  }

  const [files] = await bucket.getFiles({
    prefix: options.prefix,
    maxResults: options.maxResults
  });

  const report = {
    scanTimestamp: new Date().toISOString(),
    targetBucket: options.bucket,
    targetProject: options.project,
    isEmulator,
    totalFiles: files.length,
    totalBytes: 0,
    byPrefix: {},
    byFamily: {},
    byContentType: {},
    tokenStatistics: {
      withTokens: 0,
      withoutTokens: 0,
      multiTokenCount: 0
    },
    filesExceeding35MB: [],
    customMetadataKeysEncountered: new Set(),
    items: []
  };

  for (const file of files) {
    let metadata = file.metadata || {};
    if (!metadata.size && !metadata.contentType) {
      try {
        const [meta] = await file.getMetadata();
        metadata = meta;
      } catch (e) {
        metadata = { size: 0, contentType: 'unknown' };
      }
    }

    const size = parseInt(metadata.size || 0, 10);
    const contentType = metadata.contentType || 'unknown';
    const { envPrefix, folder, family } = classifyPath(file.name);

    report.totalBytes += size;
    report.byPrefix[envPrefix] = (report.byPrefix[envPrefix] || 0) + 1;
    report.byFamily[family] = (report.byFamily[family] || 0) + 1;
    report.byContentType[contentType] = (report.byContentType[contentType] || 0) + 1;

    // Check for tokens in custom metadata or top-level downloadTokens
    const rawTokens = (metadata.metadata && metadata.metadata.firebaseStorageDownloadTokens) ||
                      metadata.downloadTokens ||
                      null;
    const masked = maskToken(rawTokens);

    if (masked && masked.length > 0) {
      report.tokenStatistics.withTokens++;
      if (masked.length > 1) report.tokenStatistics.multiTokenCount++;
    } else {
      report.tokenStatistics.withoutTokens++;
    }

    // Check custom metadata keys
    if (metadata.metadata && typeof metadata.metadata === 'object') {
      for (const k of Object.keys(metadata.metadata)) {
        report.customMetadataKeysEncountered.add(k);
      }
    }

    // Check > 35 MB
    const isOver35MB = size > SIZE_THRESHOLD_35MB;
    if (isOver35MB) {
      report.filesExceeding35MB.push({
        path: file.name,
        sizeBytes: size,
        sizeMB: (size / (1024 * 1024)).toFixed(2),
        contentType
      });
    }

    report.items.push({
      path: file.name,
      envPrefix,
      family,
      sizeBytes: size,
      contentType,
      isOver35MB,
      hasTokens: !!(masked && masked.length > 0),
      tokenCount: masked ? masked.length : 0,
      tokenMasked: masked
    });
  }

  report.customMetadataKeysEncountered = Array.from(report.customMetadataKeysEncountered);
  return report;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runInventory(options)
    .then(report => {
      if (options.outputJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('===============================================================');
        console.log('   INVENTARIO DE FIREBASE STORAGE (SEC-05 Fase 2)');
        console.log('===============================================================');
        console.log(`Fecha de escaneo:       ${report.scanTimestamp}`);
        console.log(`Proyecto objetivo:      ${report.targetProject}`);
        console.log(`Bucket objetivo:        ${report.targetBucket} (${report.isEmulator ? 'Emulador Local' : 'Remoto / Producción'})`);
        console.log(`Total archivos:         ${report.totalFiles}`);
        console.log(`Total tamaño acumulado: ${(report.totalBytes / (1024 * 1024)).toFixed(2)} MB (${report.totalBytes} bytes)`);
        console.log('---------------------------------------------------------------');
        console.log('Distribución por Prefijo de Entorno:');
        for (const [k, v] of Object.entries(report.byPrefix)) {
          console.log(`  - ${k.padEnd(20)}: ${v} archivos`);
        }
        console.log('---------------------------------------------------------------');
        console.log('Distribución por Familia de Rutas:');
        for (const [k, v] of Object.entries(report.byFamily)) {
          console.log(`  - ${k.padEnd(20)}: ${v} archivos`);
        }
        console.log('---------------------------------------------------------------');
        console.log('Distribución por Tipo de Contenido:');
        for (const [k, v] of Object.entries(report.byContentType)) {
          console.log(`  - ${k.padEnd(25)}: ${v} archivos`);
        }
        console.log('---------------------------------------------------------------');
        console.log('Presencia de Tokens de Descarga:');
        console.log(`  - Con token activo:     ${report.tokenStatistics.withTokens}`);
        console.log(`  - Sin token de descarga: ${report.tokenStatistics.withoutTokens}`);
        console.log(`  - Múltiples tokens:      ${report.tokenStatistics.multiTokenCount}`);
        console.log('---------------------------------------------------------------');
        console.log(`Archivos mayores a 35 MB: ${report.filesExceeding35MB.length}`);
        if (report.filesExceeding35MB.length > 0) {
          for (const big of report.filesExceeding35MB) {
            console.log(`  ⚠️ ${big.path} (${big.sizeMB} MB, ${big.contentType})`);
          }
        } else {
          console.log('  (Ningún archivo excede el umbral de 35 MB)');
        }
        console.log('---------------------------------------------------------------');
        console.log('Claves de metadatos personalizados encontradas:');
        console.log(`  ${report.customMetadataKeysEncountered.length ? report.customMetadataKeysEncountered.join(', ') : '(Ninguna)'}`);
        console.log('===============================================================');
      }
    })
    .catch(err => {
      console.error('Error en inventario:', err.message);
      process.exit(1);
    });
}

module.exports = { runInventory, classifyPath, maskToken };
