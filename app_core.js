// app.js

const firebaseConfig = {
    apiKey: "AIzaSyBSnGhwh043oV_zW1FlE5z7N8_ywh9FUEA",
    authDomain: "ductsal-erp.firebaseapp.com",
    projectId: "ductsal-erp",
    storageBucket: "ductsal-erp.firebasestorage.app",
    messagingSenderId: "948658286825",
    appId: "1:948658286825:web:e3008dc00f714e57aa0078",
    measurementId: "G-32JZ4MV4FR"
};
// Emulator mode is opt-in and explicit (see crm_env.js): only on localhost/127.0.0.1 with
// ?emulators=demo-ductsal-local. Any other use of the parameter blocks the page instead of falling
// back to production. Without the parameter nothing below differs from the normal behaviour.
if (typeof CrmEnv !== 'undefined' && CrmEnv.emulatorParamInvalid(window.location)) {
    CrmEnv.blockPage(document, "El parámetro 'emulators' no es válido (se requiere ?emulators=" + CrmEnv.EMULATOR_PROJECT + " en localhost o 127.0.0.1). No se inició Firebase.");
    throw new Error('Invalid emulator activation: Firebase was not initialised');
}
const CRM_EMULATOR_MODE = (typeof CrmEnv !== 'undefined') && CrmEnv.isEmulatorRequested(window.location);
firebase.initializeApp(CRM_EMULATOR_MODE ? CrmEnv.emulatorFirebaseConfig() : firebaseConfig);
const db = firebase.firestore();
if (CRM_EMULATOR_MODE) {
    const emulatorEndpoints = CrmEnv.connectEmulators(firebase, db);
    console.warn("MODO EMULADORES ACTIVO. Proyecto: " + emulatorEndpoints.project + " | Auth " + emulatorEndpoints.auth.host + ":" + emulatorEndpoints.auth.port + " | Firestore " + emulatorEndpoints.firestore.host + ":" + emulatorEndpoints.firestore.port + " | Functions " + emulatorEndpoints.functions.host + ":" + emulatorEndpoints.functions.port + " | Storage " + emulatorEndpoints.storage.host + ":" + emulatorEndpoints.storage.port);
    document.addEventListener('DOMContentLoaded', () => CrmEnv.showBanner(document, emulatorEndpoints));
}
try {
    db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
} catch (e) {
    console.warn("Long polling config:", e);
}
const storage = firebase.storage();

// Configuración de Entornos Automática
const isLocal = window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const DB_SUFFIX = isLocal ? '_local' : '_prod';
const STORAGE_PREFIX = isLocal ? 'local_files' : 'prod_files';

if (isLocal) {
    console.warn("⚠️ MODO DESARROLLO LOCAL ACTIVADO: Conectado a las colecciones '_local' en Firebase.");
}

// Variables Globales de Ordenamiento para Oportunidades, Proyectos y Clientes
let oppSortCol = ''; let oppSortDir = 'asc';
let projSortCol = ''; let projSortDir = 'asc';
let cliSortCol = ''; let cliSortDir = 'asc';

function toggleOppSort(column) {
    if (oppSortCol === column) {
        oppSortDir = oppSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        oppSortCol = column;
        oppSortDir = 'asc';
    }
    renderList();
    updateOppSortIcons();
}

function getProspectVendorInfo(p) {
    if (!p) return { id: '', name: 'Sistema', role: '' };

    let userId = p.vendedorId || p.createdBy;
    let name = p.vendedorName || p.createdByName || p.creado_por || p.vendedor;
    let role = p.vendedorRole || p.createdByRole || '';

    if (userId) {
        const u = users.find(x => x.id === userId);
        if (u) {
            name = u.nombre;
            role = u.role;
        }
    }

    if (!name) name = 'Sistema / Desconocido';

    let roleText = '';
    if (role === 'manager') roleText = 'Gerente';
    else if (role === 'gestor') roleText = 'Gestor de Ventas';
    else if (role === 'vendedor') roleText = 'Vendedor';

    return { id: userId, name, role: roleText };
}

function reassignVendor(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;
    if (!currentUser || (currentUser.role !== 'manager' && currentUser.role !== 'gestor')) {
        return alert("Solo los Gestores y Gerentes pueden reasignar vendedores.");
    }
    const currentVendor = getProspectVendorInfo(p);
    const activeUsers = users.filter(u => u.activo !== false);
    let optionsText = activeUsers.map((u, idx) => {
        const rName = u.role === 'manager' ? 'Gerente' : (u.role === 'gestor' ? 'Gestor' : 'Vendedor');
        return `${idx + 1}. ${u.nombre} (${rName})`;
    }).join('\n');

    let selStr = prompt(`Reasignar Oportunidad: "${p.proyecto}"\n\nVendedor Actual: ${currentVendor.name}\n\nIngresa el número del nuevo vendedor:\n${optionsText}`);
    if (!selStr) return;

    let targetUser = activeUsers.find(u => u.email.toLowerCase() === selStr.toLowerCase().trim() || u.nombre.toLowerCase().includes(selStr.toLowerCase().trim()));
    const num = parseInt(selStr, 10);
    if (!targetUser && !isNaN(num) && num > 0 && num <= activeUsers.length) {
        targetUser = activeUsers[num - 1];
    }

    if (!targetUser) return alert("Vendedor no encontrado.");

    // The server authorises (manager / gestor), validates the target and writes the log with the identity of the session.
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }
    showLoading('Reasignando vendedor...');
    return CrmCommercial.reassign(fb, { prospectId: p.id, vendedorId: targetUser.id, dbSuffix: DB_SUFFIX }).then(res => {
        if (res.status === 'reassigned') {
            p.vendedorId = res.vendedorId; p.vendedorName = res.vendedorName; p.vendedorRole = res.vendedorRole;
        }
        openDetail(p.id);
        renderList();
        alert(res.status === 'reassigned' ? `✔️ Vendedor reasignado exitosamente a ${targetUser.nombre}.` : 'La oportunidad ya estaba asignada a ese vendedor.');
    }).catch(err => alert(CrmCommercial.errorMessage(err))).finally(hideLoading);
}

function updateOppSortIcons() {
    const columns = ['codigo', 'cliente', 'proyecto', 'vendedor', 'etapa', 'monto', 'estado'];
    columns.forEach(col => {
        const el = document.getElementById(`sort-opp-${col}`);
        if (!el) return;
        if (oppSortCol === col) {
            el.innerHTML = oppSortDir === 'asc' ? '▲' : '▼';
            el.style.color = 'var(--brand-gold)';
        } else {
            el.innerHTML = '↕';
            el.style.color = 'var(--text-muted)';
        }
    });
}

function toggleProjSort(column) {
    if (projSortCol === column) {
        projSortDir = projSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        projSortCol = column;
        projSortDir = 'asc';
    }
    renderProjectsList();
    updateProjSortIcons();
}

function updateProjSortIcons() {
    const columns = ['codigo', 'cliente', 'proyecto', 'encargado', 'total', 'condicion', 'pctFacturado', 'pctCobrado'];
    columns.forEach(col => {
        const el = document.getElementById(`sort-proj-${col}`);
        if (!el) return;
        if (projSortCol === col) {
            el.innerHTML = projSortDir === 'asc' ? '▲' : '▼';
            el.style.color = 'var(--brand-gold)';
        } else {
            el.innerHTML = '↕';
            el.style.color = 'var(--text-muted)';
        }
    });
}

function toggleCliSort(column) {
    if (cliSortCol === column) {
        cliSortDir = cliSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        cliSortCol = column;
        cliSortDir = 'asc';
    }
    renderClientsTable();
    updateCliSortIcons();
}

function updateCliSortIcons() {
    const columns = ['tipo', 'nombre', 'contacto', 'telefono', 'correo'];
    columns.forEach(col => {
        const el = document.getElementById(`sort-cli-${col}`);
        if (!el) return;
        if (cliSortCol === col) {
            el.innerHTML = cliSortDir === 'asc' ? '▲' : '▼';
            el.style.color = 'var(--brand-gold)';
        } else {
            el.innerHTML = '↕';
            el.style.color = 'var(--text-muted)';
        }
    });
}

// Helper Functions para Carga
function showLoading(msg = 'Subiendo archivo a la nube...') {
    const el = document.getElementById('global-spinner');
    if (el) {
        document.getElementById('spinner-msg').textContent = msg;
        el.style.display = 'flex';
    }
}
function hideLoading() {
    const el = document.getElementById('global-spinner');
    if (el) el.style.display = 'none';
}

function updateSelectedFilesList(input) {
    const listId = input.id + '-list';
    const listDiv = document.getElementById(listId);
    if (!listDiv) {
        // Fallback or normal behavior for single-file inputs
        const nextDiv = input.nextElementSibling;
        if (nextDiv && nextDiv.tagName === 'DIV') {
            nextDiv.innerHTML = '';
            if (input.files && input.files.length > 0) {
                nextDiv.innerHTML = '<strong>Archivo seleccionado:</strong> ' + input.files[0].name;
            }
        }
        return;
    }

    if (!window.stagedFiles) window.stagedFiles = {};
    if (!window.stagedFiles[input.id]) window.stagedFiles[input.id] = [];

    if (input.files && input.files.length > 0) {
        const newFiles = Array.from(input.files);
        newFiles.forEach(file => {
            if (!window.stagedFiles[input.id].some(f => f.name === file.name && f.size === file.size)) {
                window.stagedFiles[input.id].push(file);
            }
        });
    }

    input.value = '';
    renderStagedFiles(input.id);
}

function renderStagedFiles(inputId) {
    const container = document.getElementById(inputId + '-list');
    if (!container) return;
    container.innerHTML = '';

    const files = window.stagedFiles && window.stagedFiles[inputId] ? window.stagedFiles[inputId] : [];
    if (files.length === 0) {
        container.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem; font-style:italic;">Ningún archivo seleccionado.</span>';
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '6px';
    wrapper.style.marginTop = '8px';

    files.forEach((file, index) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.background = 'rgba(255, 255, 255, 0.05)';
        item.style.padding = '8px 12px';
        item.style.borderRadius = '6px';
        item.style.border = '1px solid rgba(255, 255, 255, 0.08)';
        item.style.fontSize = '0.85rem';

        const nameText = document.createElement('span');
        nameText.textContent = file.name;
        nameText.style.color = 'var(--text-primary)';
        nameText.style.wordBreak = 'break-all';
        nameText.style.flex = '1';
        nameText.style.marginRight = '12px';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.innerHTML = '✕';
        removeBtn.style.background = 'none';
        removeBtn.style.border = 'none';
        removeBtn.style.color = 'var(--danger)';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.fontSize = '1rem';
        removeBtn.style.fontWeight = 'bold';
        removeBtn.style.padding = '0 4px';
        removeBtn.style.transition = 'opacity 0.2s';
        removeBtn.onmouseenter = () => removeBtn.style.opacity = '0.7';
        removeBtn.onmouseleave = () => removeBtn.style.opacity = '1';
        removeBtn.onclick = (e) => {
            e.preventDefault();
            removeStagedFile(inputId, index);
        };

        item.appendChild(nameText);
        item.appendChild(removeBtn);
        wrapper.appendChild(item);
    });

    container.appendChild(wrapper);
}

function removeStagedFile(inputId, index) {
    if (window.stagedFiles && window.stagedFiles[inputId]) {
        window.stagedFiles[inputId].splice(index, 1);
        renderStagedFiles(inputId);
    }
}

async function uploadFileToStorage(file, folderName, options = {}) {
    if (!file) return null;
    let taskId;

    // Probar primero el bucket ductsal-erp.firebasestorage.app y como respaldo ductsal-erp.appspot.com
    const bucketsToTry = ["ductsal-erp.firebasestorage.app", "ductsal-erp.appspot.com"];
    let lastError = null;

    for (let b = 0; b < bucketsToTry.length; b++) {
        const bucketName = bucketsToTry[b];
        try {
            const processedFile = await compressImage(file, 1280, 1280, 0.7);
            const ext = processedFile.name.split('.').pop();
            const safeName = processedFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            
            let storageRef;
            try {
                storageRef = firebase.app().storage(`gs://${bucketName}`).ref();
            } catch (e) {
                storageRef = storage.ref();
            }

            let fullPath;
            if (options.prospectId) {
                fullPath = `${STORAGE_PREFIX}/prospects/${options.prospectId}/${folderName}/${Date.now()}_${safeName}`;
            } else if (options.clientId) {
                const subfolder = options.isLegal ? 'legal' : 'identificacion';
                fullPath = `${STORAGE_PREFIX}/clients/${options.clientId}/${subfolder}/${Date.now()}_${safeName}`;
            } else if (options.reservationId) {
                const subfolder = options.isLegal ? 'legal' : 'identificacion';
                fullPath = `${STORAGE_PREFIX}/clients/${options.reservationId}/${subfolder}/${Date.now()}_${safeName}`;
            } else if (options.customPath) {
                fullPath = `${STORAGE_PREFIX}/${options.customPath}`;
            } else {
                fullPath = `${STORAGE_PREFIX}/${folderName}/${Date.now()}_${safeName}`;
            }

            const fileRef = storageRef.child(fullPath);

            taskId = Date.now().toString() + Math.random().toString();
            activeUploads++;
            uploadProgressMap.set(taskId, { transferred: 0, total: processedFile.size || 1000000 });
            updateGlobalProgress();

            await new Promise((resolve, reject) => {
                const uploadTask = fileRef.put(processedFile);
                let timeoutId = null;
                let lastTransferred = -1;

                // Watchdog de 12 segundos: si no transfiere datos, aborta para probar el siguiente bucket
                const checkProgress = () => {
                    const currentTransferred = uploadProgressMap.get(taskId)?.transferred || 0;
                    if (currentTransferred === lastTransferred && currentTransferred === 0) {
                        uploadTask.cancel();
                        reject(new Error(`Timeout de subida en bucket ${bucketName}`));
                    } else {
                        lastTransferred = currentTransferred;
                        timeoutId = setTimeout(checkProgress, 12000);
                    }
                };
                timeoutId = setTimeout(checkProgress, 12000);

                uploadTask.on('state_changed',
                    (snapshot) => {
                        uploadProgressMap.set(taskId, { transferred: snapshot.bytesTransferred, total: snapshot.totalBytes });
                        updateGlobalProgress();
                    },
                    (error) => {
                        if (timeoutId) clearTimeout(timeoutId);
                        console.warn(`Error en subida Firebase Storage (bucket: ${bucketName}):`, error);
                        reject(error);
                    },
                    () => {
                        if (timeoutId) clearTimeout(timeoutId);
                        resolve();
                    }
                );
            });

            activeUploads--;
            uploadProgressMap.delete(taskId);
            updateGlobalProgress();

            // SEC-05 H-04: No generar tokens públicos permanentes mediante getDownloadURL().
            // Se retorna únicamente la referencia canónica protegida { name, storagePath, size, contentType }.
            return {
                name: processedFile.name,
                storagePath: fileRef.fullPath,
                size: processedFile.size,
                contentType: processedFile.type || 'application/octet-stream'
            };

        } catch (e) {
            if (typeof taskId !== 'undefined') {
                activeUploads = Math.max(0, activeUploads - 1);
                uploadProgressMap.delete(taskId);
                updateGlobalProgress();
            }
            lastError = e;
            console.warn(`Intento con bucket ${bucketName} falló:`, e);
        }
    }

    let errorMsg = lastError ? (lastError.message || lastError.code || JSON.stringify(lastError)) : "Error de red desconocido";
    console.error("Error definitivo subiendo archivo a Firebase Storage:", lastError);
    alert("❌ Error al subir el archivo a Firebase Storage:\n" + errorMsg + "\n\n💡 Si estás navegando en https://erp.ductsal.com, debes activar los permisos CORS en tu bucket de Firebase para permitir subidas desde tu dominio.");
    throw lastError;
}

// ============================================================================
// SEC-05: VISOR SEGURO Y RESOLUCIÓN ESTRICTA DE RUTAS DE FIREBASE STORAGE
// ============================================================================

const escapeHtmlDoc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

if (typeof window !== 'undefined' && !window._docStore) {
    window._docStore = new Map();
}

/**
 * Resuelve y valida estrictamente una referencia de Storage para el entorno activo.
 * Retorna la ruta física canónica segura o null si no supera la validación.
 */
function resolveStoragePath(docRef, envConfig = null) {
    if (!docRef) return null;

    const prefix = (envConfig && envConfig.storagePrefix) || (typeof STORAGE_PREFIX !== 'undefined' ? STORAGE_PREFIX : 'prod_files');
    const allowedBuckets = (envConfig && envConfig.allowedBuckets) || [
        'ductsal-erp.firebasestorage.app',
        'ductsal-erp.appspot.com',
        'demo-ductsal-isolated.appspot.com',
        'demo-ductsal-local.appspot.com'
    ];

    let candidatePath = null;

    // Caso A: Objeto con propiedad storagePath o path explícita
    if (typeof docRef === 'object') {
        const p = docRef.storagePath || docRef.path;
        if (typeof p === 'string' && p.trim()) {
            candidatePath = p.trim();
        }
    }

    // Caso B: URL completa de Firebase Storage (string primitivo o docRef.url)
    if (!candidatePath) {
        const rawUrl = (typeof docRef === 'object') ? docRef.url : docRef;
        if (typeof rawUrl === 'string' && rawUrl.includes('firebasestorage.googleapis.com')) {
            try {
                const parsedUrl = new URL(rawUrl);
                // 1. Validar hostname exacto
                if (parsedUrl.hostname !== 'firebasestorage.googleapis.com') return null;

                // 2. Validar bucket en la ruta /v0/b/<bucket>/o/<path>
                const match = parsedUrl.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
                if (!match) return null;

                const bucketInUrl = decodeURIComponent(match[1]);
                if (!allowedBuckets.includes(bucketInUrl)) {
                    console.warn('[Storage Security] URL rechazada: bucket no autorizado:', bucketInUrl);
                    return null;
                }

                // 3. Decodificar la ruta del objeto
                candidatePath = decodeURIComponent(match[2]);
            } catch (e) {
                return null;
            }
        } else if (typeof rawUrl === 'string' && (rawUrl.startsWith('prod_files/') || rawUrl.startsWith('local_files/'))) {
            candidatePath = rawUrl.trim();
        }
    }

    if (!candidatePath) return null;

    // Normalización y anti-traversal
    candidatePath = candidatePath.replace(/^\/+/, '');
    if (candidatePath.includes('..') || candidatePath.includes('//') || candidatePath.includes('\\')) return null;
    if (candidatePath.length > 500) return null;

    // Control de prefijo de entorno
    if (!candidatePath.startsWith(`${prefix}/`)) {
        console.warn(`[Storage Security] Ruta rechazada: prefijo ${candidatePath.split('/')[0]} no coincide con entorno activo ${prefix}`);
        return null;
    }

    // Lista blanca estricta de jerarquías permitidas
    const allowedPathPattern = new RegExp(
        `^${prefix}/(` +
        `prospects/[a-zA-Z0-9_-]+/(proyectos|facturas|pagos|ordenes_cambio)/.+|` +
        `clients/[a-zA-Z0-9_-]+/(identificacion|legal)/.+|` +
        `clients/[a-zA-Z0-9_-]+/[^/]+|` +
        `(clientes|proyectos|facturas|pagos|ordenes_cambio)/.+` +
        `)$`
    );

    if (!allowedPathPattern.test(candidatePath)) {
        console.warn('[Storage Security] Ruta rechazada: estructura fuera de lista blanca:', candidatePath);
        return null;
    }

    return candidatePath;
}

const PREVIEWABLE_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt'];

function isFormatPreviewable(fileName, contentType) {
    if (contentType && (contentType.startsWith('image/') || contentType === 'application/pdf' || contentType.startsWith('text/'))) {
        return true;
    }
    const name = String(fileName || '').toLowerCase();
    return PREVIEWABLE_EXTS.some(ext => name.endsWith(ext));
}

/**
 * Descarga directamente un documento mediante URL firmada de corta duración de Cloud Functions.
 * No satura la memoria del navegador con getBlob(), permitiendo descargar archivos de cualquier tamaño (> 35 MB, ZIP, CAD).
 */
async function downloadSecureDocument(docRef, fallbackName = 'Documento', options = {}) {
    if (!docRef) {
        alert('No se especificó ningún documento para descargar.');
        return;
    }

    const storagePath = resolveStoragePath(docRef);
    const fileName = (typeof docRef === 'object' && docRef.name) ? docRef.name : fallbackName;

    if (!storagePath) {
        alert(`La referencia de archivo no es válida en este entorno: ${fileName}`);
        return;
    }

    if (typeof showLoading === 'function') showLoading(`Preparando descarga segura de ${fileName}...`);

    try {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        if (!fb || !fb.functions) {
            throw new Error('SDK de Firebase Functions no disponible en el cliente');
        }

        const fn = fb.functions().httpsCallable('getSecureDownloadUrlAdmin');
        const dbSuffix = typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod';
        const res = await fn({
            storagePath,
            fileName,
            dbSuffix,
            prospectId: options.prospectId || (typeof currentProspectId !== 'undefined' ? currentProspectId : null),
            clientId: options.clientId || null
        });

        const data = res && res.data;
        if (!data || !data.signedUrl) {
            throw new Error('No se recibió la URL de descarga segura del servidor.');
        }

        const safeDownloadName = data.fileName || fileName;

        // Disparo directo de descarga nativa en el navegador (sin target="_blank" para evitar pestañas residuales)
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = data.signedUrl;
        a.download = safeDownloadName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 2000);

    } catch (error) {
        console.error('[Storage Security] Error al descargar documento:', error);
        let userMessage = 'Error al descargar el archivo.';
        const errCode = error.code || '';
        const errMsg = error.message || '';

        if (errCode === 'functions/permission-denied' || errMsg.includes('permission-denied')) {
            userMessage = 'Acceso denegado: No tienes autorización para descargar este documento según las políticas comerciales.';
        } else if (errCode === 'functions/not-found' || errMsg.includes('not-found')) {
            userMessage = 'El archivo solicitado ya no existe en el almacenamiento de producción.';
        } else if (errCode === 'functions/unauthenticated' || errMsg.includes('unauthenticated')) {
            userMessage = 'Sesión expirada o no autenticada. Inicia sesión nuevamente.';
        } else if (errMsg.includes('network') || errCode === 'functions/unavailable') {
            userMessage = 'Error de conexión con el servidor. Verifica tu conexión a internet.';
        }

        alert(userMessage);
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
    }
}

/**
 * Visualiza o descarga un documento de forma segura usando el SDK de Firebase Storage.
 * Compatible con objetos canónicos { storagePath }, objetos legacy { url }, y URLs en string.
 */
async function viewSecureDocument(docRef, fallbackName = 'Documento', options = {}) {
    if (!docRef) {
        alert('No se especificó ningún documento.');
        return;
    }

    const storagePath = resolveStoragePath(docRef);
    const fileName = (typeof docRef === 'object' && docRef.name) ? docRef.name : fallbackName;

    if (!storagePath) {
        alert(`El archivo no se encuentra disponible o la referencia no es válida en este entorno: ${fileName}`);
        return;
    }

    // Si el formato no es compatible con el visor interactivo (e.g. ZIP, DWG, CAD, Excel), descargar directamente
    if (!isFormatPreviewable(fileName)) {
        return await downloadSecureDocument(docRef, fallbackName, options);
    }

    // Mitigación popup blocker: abrir ventana en blanco de manera síncrona
    let previewTab = null;
    if (!options || !options.download) {
        try {
            previewTab = window.open('about:blank', '_blank');
            if (previewTab) {
                previewTab.document.write(`
                    <!DOCTYPE html>
                    <html>
                    <head><title>Cargando ${escapeHtmlDoc(fileName)}...</title></head>
                    <body style="margin:0; display:flex; align-items:center; justify-content:center; height:100vh; font-family:system-ui, sans-serif; background:#1e293b; color:#f8fafc;">
                        <div style="text-align:center;">
                            <div style="font-size:2rem; margin-bottom:1rem;">📄</div>
                            <div style="font-size:1.1rem; font-weight:600;">Cargando documento seguro...</div>
                            <div style="font-size:0.85rem; color:#94a3b8; margin-top:0.5rem;">${escapeHtmlDoc(fileName)}</div>
                        </div>
                    </body>
                    </html>
                `);
            }
        } catch (e) {
            console.warn('[Storage Security] No se pudo abrir pestaña previa:', e);
        }
    }

    if (typeof showLoading === 'function') showLoading(`Descargando ${fileName}...`);

    try {
        const storageInstance = (typeof storage !== 'undefined' && storage) ? storage : firebase.storage();
        const fileRef = storageInstance.ref(storagePath);

        // Límite de seguridad: 35 MB por buffer en memoria
        const MAX_BLOB_SIZE = 35 * 1024 * 1024;
        const blob = await fileRef.getBlob(MAX_BLOB_SIZE);

        const blobUrl = URL.createObjectURL(blob);

        if (options && options.download) {
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = blobUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
        } else if (previewTab && !previewTab.closed) {
            previewTab.location.href = blobUrl;
            setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        } else {
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            a.click();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
        }
    } catch (error) {
        console.error('[Storage Security] Error al visualizar documento:', error);
        let userMessage = 'Error al cargar el archivo.';
        let isLargeFile = false;

        if (error.code === 'storage/unauthorized') {
            userMessage = 'Acceso denegado: No tienes permiso para visualizar este documento según las políticas de seguridad.';
        } else if (error.code === 'storage/object-not-found') {
            userMessage = 'El archivo solicitado ya no existe en el almacenamiento.';
        } else if (error.code === 'storage/canceled') {
            userMessage = 'Descarga cancelada por el usuario.';
        } else if (error.message && error.message.includes('CORS')) {
            userMessage = 'Error de conexión con el almacenamiento (CORS). Contacta al administrador.';
        } else if (error.message && (error.message.includes('size') || error.code === 'storage/cannot-slice-blob')) {
            userMessage = 'El archivo supera el límite de memoria del visor seguro (35 MB).';
            isLargeFile = true;
        }

        if (previewTab && !previewTab.closed) {
            if (isLargeFile) {
                previewTab.document.write(`
                    <div style="padding:2.5rem; font-family:system-ui, sans-serif; color:#f8fafc; background:#1e293b; height:100vh; text-align:center;">
                        <div style="font-size:3rem; margin-bottom:1rem;">📦</div>
                        <h3 style="color:#fbbf24; margin-bottom:0.5rem;">Archivo de Gran Tamaño</h3>
                        <p style="color:#94a3b8; max-width:500px; margin:0 auto 1.5rem auto;">
                            El archivo <strong>${escapeHtmlDoc(fileName)}</strong> supera el límite de memoria del visor interactivo (35 MB). Puedes descargarlo directamente en tu equipo.
                        </p>
                        <button id="dl-large-btn" style="background:#2563eb; color:#fff; border:none; padding:10px 20px; font-size:1rem; border-radius:6px; cursor:pointer; font-weight:600;">
                            ⬇️ Descargar Archivo Completo
                        </button>
                    </div>
                `);
                try {
                    const btn = previewTab.document.getElementById('dl-large-btn');
                    if (btn) {
                        btn.onclick = function() {
                            downloadSecureDocument(storagePath, fileName);
                        };
                    }
                } catch (e) {
                    console.warn('[Storage Security] No se pudo vincular botón de descarga en pestaña grande:', e);
                }
            } else {
                previewTab.document.write(`
                    <div style="padding:2rem; font-family:system-ui, sans-serif; color:#ef4444; background:#1e293b; height:100vh;">
                        <h3>⚠️ Error al abrir el documento</h3>
                        <p>${escapeHtmlDoc(userMessage)}</p>
                        <p style="font-size:0.8rem; color:#94a3b8;">Detalle técnico: ${escapeHtmlDoc(error.code || error.message || '')}</p>
                    </div>
                `);
            }
        } else {
            alert(userMessage);
        }
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
    }
}

const KNOWN_DOC_LABELS = {
    escritura: 'Escritura',
    escritura_constitucion: 'Escritura de Constitución',
    mods_escritura: 'Mods. Escritura',
    mods: 'Modificaciones',
    credencial: 'Credencial',
    credencial_rep: 'Credencial Rep. Legal',
    nit: 'NIT',
    nit_empresa: 'NIT Empresa',
    nrc: 'NRC',
    nrc_empresa: 'NRC Empresa',
    dui: 'DUI',
    dui_rep: 'DUI Rep. Legal',
    comprobante: 'Comprobante',
    balance: 'Balance'
};

function formatClientDocLabel(k) {
    if (KNOWN_DOC_LABELS[k]) return KNOWN_DOC_LABELS[k];
    const clean = String(k || '')
        .replace(/^[_\s-]+|[_\s-]+$/g, '')
        .replace(/[_-]+/g, ' ');
    if (!clean) return 'Documento';
    return clean.replace(/\b\w/g, ch => ch.toUpperCase());
}

function getDocStore() {
    if (typeof window !== 'undefined') {
        if (!window._docStore) window._docStore = new Map();
        return window._docStore;
    }
    if (typeof global !== 'undefined') {
        if (!global._docStore) global._docStore = new Map();
        return global._docStore;
    }
    return new Map();
}

function viewStoredClientDoc(storeId) {
    const store = getDocStore();
    const item = store ? store.get(storeId) : null;
    if (!item) return;
    return viewSecureDocument(item.docRef, item.fileName, { clientId: item.clientId });
}

function downloadStoredClientDoc(storeId) {
    const store = getDocStore();
    const item = store ? store.get(storeId) : null;
    if (!item) return;
    return downloadSecureDocument(item.docRef, item.fileName, { clientId: item.clientId });
}

function deleteStoredClientDoc(storeId) {
    const store = getDocStore();
    const item = store ? store.get(storeId) : null;
    if (!item) return;
    return deleteClientDocument(item.clientId, item.docKey, item.itemIndex);
}

function renderClientDocItem(docRef, label, clientId, docKey, itemIndex = null) {
    if (!docRef) return '';
    let fileName = 'Documento';
    if (typeof docRef === 'object' && docRef && docRef.name) {
        fileName = String(docRef.name);
    } else if (typeof docRef === 'string') {
        const parts = docRef.split('?')[0].split('/');
        const last = parts[parts.length - 1];
        fileName = decodeURIComponent(last) || label;
    } else {
        fileName = label;
    }

    const storeId = 'cdoc_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    const store = getDocStore();
    store.set(storeId, {
        docRef,
        fileName,
        label,
        clientId,
        docKey,
        itemIndex: (itemIndex !== null && itemIndex !== undefined) ? Number(itemIndex) : null
    });

    const safeName = escapeHtmlDoc(fileName);
    const safeLabel = escapeHtmlDoc(label);

    const previewable = isFormatPreviewable(fileName);
    const isManager = currentUser && currentUser.role === 'manager';
    const delBtn = isManager ? ` <button type="button" class="btn-danger" style="padding:1px 5px; font-size:0.65rem; margin-left:2px; margin-right:8px;" onclick="deleteStoredClientDoc('${storeId}')" title="Eliminar [${safeLabel}]">🗑️</button>` : '';
    const dlBtn = ` <button type="button" class="btn-secondary" style="padding:1px 5px; font-size:0.65rem; margin-left:2px; margin-right:4px; cursor:pointer;" onclick="downloadStoredClientDoc('${storeId}')" title="Descargar">⬇️</button>`;

    let viewHtml = '';
    if (previewable) {
        viewHtml = `<a href="javascript:void(0)" onclick="viewStoredClientDoc('${storeId}')" style="color:var(--brand-gold); text-decoration:underline; cursor:pointer;" title="Previsualizar ${safeName}">[${safeLabel}]</a>`;
    } else {
        viewHtml = `<span style="color:var(--text-primary); font-weight:500;" title="${safeName}">📁 [${safeLabel}]</span>`;
    }

    return `<span style="display:inline-block; margin-right:6px; margin-bottom:4px;">${viewHtml}${dlBtn}${delBtn}</span>`;
}

if (typeof window !== 'undefined') {
    window.resolveStoragePath = resolveStoragePath;
    window.viewSecureDocument = viewSecureDocument;
    window.downloadSecureDocument = downloadSecureDocument;
    window.viewStoredClientDoc = viewStoredClientDoc;
    window.downloadStoredClientDoc = downloadStoredClientDoc;
    window.deleteStoredClientDoc = deleteStoredClientDoc;
    window.isFormatPreviewable = isFormatPreviewable;
    window.escapeHtmlDoc = escapeHtmlDoc;
    window.formatClientDocLabel = formatClientDocLabel;
    window.renderClientDocItem = renderClientDocItem;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        resolveStoragePath,
        viewSecureDocument,
        downloadSecureDocument,
        viewStoredClientDoc,
        downloadStoredClientDoc,
        deleteStoredClientDoc,
        isFormatPreviewable,
        escapeHtmlDoc,
        formatClientDocLabel,
        renderClientDocItem
    };
}

const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
const PROBABILIDADES = { 'alta': 75, 'media': 50, 'baja': 25, 'improbable': 10 };
const MOTIVOS_PERDIDA = ["Precio", "Falta de seguimiento", "No se cumplían los requerimientos técnicos", "Tiempo de entrega", "Cliente desiste"];
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const KPI_LIMITS = { 'prospecto': 7, 'levantamiento': 10, 'cotizacion': 7, 'negociacion': 21, 'cierre': 5 };

// DB State
let clients = [];
let prospects = [];
let users = [];

let currentUser = JSON.parse(localStorage.getItem('ductsal_current_user')) || null;
let currentProspectId = null;
let lastViewedSection = 'list-view';

let settings = { visitantes: [], encargados: [], gmaps_api_key: "", factory_address: "" };

let chartFunnel = null; let chartProduct = null; let chartProject = null; let chartOrigin = null; let chartLoss = null; let chartOppProduct = null; let chartOppProject = null;

let loadedCollections = 0;

function reRenderApp() {
    try {
        if (!currentUser) return;
        populateTimeFilter();
        toggleClientFields();
        if (document.getElementById('list-view').classList.contains('active')) renderList();
        if (document.getElementById('dashboard-view').classList.contains('active')) renderDashboard();
        if (document.getElementById('users-view').classList.contains('active')) renderUsersTable();
        if (document.getElementById('detail-view').classList.contains('active') && currentProspectId) {
            const p = prospects.find(x => x.id === currentProspectId);
            if (p) {
                renderTracker(p); renderInfo(p); renderLogs(p);
                if (p.estado === 'ganado') renderFinancials(p);
            }
        }
    } catch (e) {
        alert("CRASH EN reRenderApp: " + e.message + "\\n" + e.stack);
        console.error(e);
    }
}

let activeUnsubscribers = [];

function detachSnapshotListeners() {
    if (Array.isArray(activeUnsubscribers)) {
        activeUnsubscribers.forEach(unsub => {
            try { if (typeof unsub === 'function') unsub(); } catch (_) {}
        });
    }
    activeUnsubscribers = [];
}

function checkInitialLoad() {
    loadedCollections++;
    if (loadedCollections >= 3) {
        if (users.length === 0) {
            console.warn('[CRM] No hay usuarios en Firestore. El primer administrador se crea a través del flujo de configuración inicial en functions/LEGACY_IMPORT.md.');
        }
        checkAuth();
        reRenderApp();
    } else {
        reRenderApp();
    }
}

// SEC-01: Scoped snapshot listeners adhering to Firestore rules.
// In Firestore, "rules are not filters". Queries must specify filters matching allowed subsets.
function attachDataListeners(role, userId) {
    detachSnapshotListeners();
    if (!role || !userId) return;

    // 1. Settings listener (system/settings)
    try {
        const unsubSettings = db.collection(`system${DB_SUFFIX}`).doc('settings').onSnapshot(
            doc => {
                if (doc.exists) settings = Object.assign({ visitantes: [], encargados: [] }, doc.data());
                checkInitialLoad();
            },
            err => console.warn('[CRM] Listener system/settings no disponible:', err && err.message)
        );
        activeUnsubscribers.push(unsubSettings);
    } catch (e) {
        console.warn('[CRM] Error al suscribir a settings:', e && e.message);
    }

    // 2. User directory listener (all roles subscribe to userDirectory_prod - SEC-03)
    // Eliminates any direct onSnapshot listener on users_prod across the wire.
    // userDirectory_prod contains strictly { id, nombre, role, activo } without password.
    try {
        const unsubDir = db.collection(`userDirectory${DB_SUFFIX}`).onSnapshot(
            snap => {
                const prevUsers = users;
                users = snap.docs.map(doc => {
                    const d = doc.data();
                    const prev = prevUsers.find(u => u.id === d.id);
                    if (prev) {
                        if (prev.email) d.email = prev.email;
                        if (prev.authUid) d.authUid = prev.authUid;
                    }
                    return d;
                });
                checkInitialLoad();
            },
            err => {
                console.warn('[CRM] Listener userDirectory no disponible:', err && err.message);
                if (currentUser && !users.some(u => u.id === currentUser.id)) {
                    users = [currentUser];
                }
                checkInitialLoad();
            }
        );
        activeUnsubscribers.push(unsubDir);
    } catch (e) {
        console.warn('[CRM] Error al suscribir a usuarios:', e && e.message);
    }

    // 3. Clients listener
    try {
        if (role === 'manager' || role === 'gestor') {
            // Privileged roles can list all clients
            const unsubClients = db.collection(`clients${DB_SUFFIX}`).onSnapshot(
                snap => {
                    clients = snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
                    checkInitialLoad();
                },
                err => console.warn('[CRM] Listener clients no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubClients);
        } else if (role === 'vendedor') {
            // Vendedores listen to: 1) createdBy == userId, 2) visibleTo array-contains userId
            let ownClients = [];
            let visibleClients = [];
            const mergeClients = () => {
                const dict = {};
                ownClients.forEach(c => { dict[c.id] = c; });
                visibleClients.forEach(c => { dict[c.id] = c; });
                clients = Object.values(dict);
                checkInitialLoad();
            };
            const unsubOwn = db.collection(`clients${DB_SUFFIX}`).where('createdBy', '==', userId).onSnapshot(
                snap => {
                    ownClients = snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
                    mergeClients();
                },
                err => console.warn('[CRM] Listener clients (propios) no disponible:', err && err.message)
            );
            const unsubVis = db.collection(`clients${DB_SUFFIX}`).where('visibleTo', 'array-contains', userId).onSnapshot(
                snap => {
                    visibleClients = snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
                    mergeClients();
                },
                err => console.warn('[CRM] Listener clients (visibles) no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubOwn, unsubVis);
        }
    } catch (e) {
        console.warn('[CRM] Error al suscribir a clientes:', e && e.message);
    }

    // 4. Prospects listener
    try {
        if (role === 'manager' || role === 'gestor') {
            // Privileged roles list all prospects
            const unsubProspects = db.collection(`prospects${DB_SUFFIX}`).onSnapshot(
                snap => {
                    prospects = snap.docs.map(doc => doc.data()).filter(p => p.eliminado !== true);
                    checkInitialLoad();
                },
                err => console.warn('[CRM] Listener prospects no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubProspects);
        } else if (role === 'vendedor') {
            // Vendedores listen to: 1) createdBy == userId, 2) vendedorId == userId
            let createdProspects = [];
            let assignedProspects = [];
            const mergeProspects = () => {
                const dict = {};
                createdProspects.forEach(p => { dict[p.id] = p; });
                assignedProspects.forEach(p => { dict[p.id] = p; });
                prospects = Object.values(dict).filter(p => p.eliminado !== true);
                checkInitialLoad();
            };
            const unsubCreated = db.collection(`prospects${DB_SUFFIX}`).where('createdBy', '==', userId).onSnapshot(
                snap => {
                    createdProspects = snap.docs.map(doc => doc.data());
                    mergeProspects();
                },
                err => console.warn('[CRM] Listener prospects (creados) no disponible:', err && err.message)
            );
            const unsubAssigned = db.collection(`prospects${DB_SUFFIX}`).where('vendedorId', '==', userId).onSnapshot(
                snap => {
                    assignedProspects = snap.docs.map(doc => doc.data());
                    mergeProspects();
                },
                err => console.warn('[CRM] Listener prospects (asignados) no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubCreated, unsubAssigned);
        }
    } catch (e) {
        console.warn('[CRM] Error al suscribir a prospectos:', e && e.message);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Emulator mode fails safe: if any required emulator does not answer, nothing is attached.
    if (CRM_EMULATOR_MODE) {
        const missing = await CrmEnv.probeEmulators();
        if (missing.length > 0) {
            CrmEnv.blockPage(document, 'Faltan emuladores en 127.0.0.1: ' + missing.join(', ') + '. No se conectó a ningún otro servicio.');
            return;
        }
    }
    // Detect legacy localStorage residue
    try {
        const legacyKeys = ['ductsal_clients', 'ductsal_prospects', 'hexasales_users', 'ductsal_settings'].filter(k => localStorage.getItem(k));
        if (legacyKeys.length > 0) {
            console.warn('[CRM] Este navegador conserva datos locales de la versión anterior (' + legacyKeys.join(', ') + '). No se importan automáticamente: ver functions/LEGACY_IMPORT.md para exportarlos e importarlos de forma controlada.');
        }
    } catch (e) { /* storage unavailable: nothing to detect */ }

    // Attach Listeners
    // SEC-03: Firebase Authentication session guard.
    // Ensure currentUser and listeners are strictly synchronized with a verified Firebase Auth session.
    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
        try {
            firebase.auth().onAuthStateChanged(async authUser => {
                if (authUser) {
                    try {
                        const tok = await authUser.getIdTokenResult();
                        const cid = tok.claims && tok.claims.cid;
                        const role = tok.claims && tok.claims.role;
                        if (!cid || !role) {
                            console.warn('[CRM] Sesión rechazada: token sin claims requeridos (cid/role).');
                            processLogout();
                            return;
                        }
                        if (!currentUser || currentUser.id !== cid || currentUser.authUid !== authUser.uid || currentUser.role !== role) {
                            currentUser = { id: cid, authUid: authUser.uid, role, nombre: authUser.displayName || cid, activo: true };
                            localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
                            checkAuth();
                            if (typeof attachDataListeners === 'function') attachDataListeners(role, cid);
                            reRenderApp();
                        } else if (activeUnsubscribers.length === 0) {
                            if (typeof attachDataListeners === 'function') attachDataListeners(role, cid);
                        }
                    } catch (e) {
                        console.warn('[CRM] Error al verificar token en onAuthStateChanged:', e);
                        processLogout();
                    }
                } else {
                    // No active Firebase Authentication session exists: invalidate any stale or forged localStorage
                    if (currentUser) {
                        console.warn('[CRM] Sesión cerrada o expirada en Firebase Auth.');
                        currentUser = null;
                        localStorage.removeItem('ductsal_current_user');
                        if (typeof detachSnapshotListeners === 'function') detachSnapshotListeners();
                        checkAuth();
                    }
                }
            });
        } catch (_) {}
    }
    if (currentUser && currentUser.id && currentUser.role) {
        if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
    }
    checkAuth();
});

// DISABLED: the opportunity and the client are written ONLY by the server operations (commercialService / prospectWorkflowService /
// clientsService through CrmCommercial and CrmClients). These two used to rewrite the whole document from the browser copy (stale data,
// any field, no audit); nothing calls them any more and they refuse to write so that no future code reintroduces the bypass.
function saveClientToDB() { throw new Error('saveClientToDB está deshabilitada: usa las operaciones de servidor (CrmClients).'); }
function saveProspectToDB() { throw new Error('saveProspectToDB está deshabilitada: usa las operaciones de servidor (CrmCommercial).'); }
// Direct write of a CRM profile: ONLY for historical users (no Auth account), whose legacy login flow (first password, reset, status) still
// needs it until their identity migration (pending, out of scope). A profile linked to Firebase Authentication (authUid) is never written
// from the browser: it is created / enabled / disabled by the administrative functions.
function saveUserToDB(u) {
    if (u && u.authUid) throw new Error('Los perfiles con cuenta de Firebase Authentication solo se modifican con las funciones administrativas.');
    db.collection(`users${DB_SUFFIX}`).doc(u.id).set(u);
}

// DEPRECATED, no callers: it rewrote the whole `system/settings` document (shared with fabricacion) from the browser copy.
// CRM settings are changed through CrmCommercial.updateSettings (updateSettingsAdmin). It now refuses to write.
function saveSettings() { throw new Error('saveSettings est\u00e1 deshabilitada: usa CrmCommercial.updateSettings.'); }

function saveState() { console.log('Deprecated saveState called.'); }
function saveUsers() { console.log('Deprecated saveUsers called.'); }

function openSettingsModal() {
    renderSettingsLists();
    document.getElementById('set-gmaps-factory').value = settings.factory_address || "";
    document.getElementById('settingsModal').style.display = 'block';
}

// Settings are manager-only and decided by the server; the local copy is refreshed from the answer (and by the snapshot).
async function applySettingsChange(change) {
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        return null;
    }
    try {
        const res = await CrmCommercial.updateSettings(fb, Object.assign({ dbSuffix: DB_SUFFIX }, change));
        if (res && res.settings) {
            settings.visitantes = res.settings.visitantes;
            settings.encargados = res.settings.encargados;
            settings.factory_address = res.settings.factory_address;
        }
        return res;
    } catch (err) {
        alert(CrmCommercial.errorMessage(err));
        return null;
    }
}

async function saveMapsSettings() {
    const res = await applySettingsChange({ action: 'setFactoryAddress', value: document.getElementById('set-gmaps-factory').value.trim() });
    if (res) alert("Ajustes de mapa guardados.");
}

function renderSettingsLists() {
    let listVis = document.getElementById('list-visitantes');
    listVis.innerHTML = '';
    settings.visitantes.forEach((v, i) => {
        listVis.innerHTML += `<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.1);padding:6px 0; font-size:0.9rem;"><span>👤 ${v}</span><button class="btn-danger" style="padding:2px 8px;font-size:0.75rem;" onclick="removeSetting('visitantes', ${i})">X</button></div>`;
    });

    let listEnc = document.getElementById('list-encargados');
    listEnc.innerHTML = '';
    settings.encargados.forEach((e, i) => {
        listEnc.innerHTML += `<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.1);padding:6px 0; font-size:0.9rem;"><span>👷 ${e}</span><button class="btn-danger" style="padding:2px 8px;font-size:0.75rem;" onclick="removeSetting('encargados', ${i})">X</button></div>`;
    });
}

async function addSetting(type) {
    let input = document.getElementById(`new-${type}-input`);
    let val = input.value.trim();
    if (val) {
        const res = await applySettingsChange({ action: 'addItem', list: type, value: val });
        if (!res) return;
        input.value = '';
        renderSettingsLists();
    }
}

async function removeSetting(type, index) {
    const val = settings[type] && settings[type][index];
    if (typeof val !== 'string') return;
    const res = await applySettingsChange({ action: 'removeItem', list: type, value: val });
    if (res) renderSettingsLists();
}

function showView(viewId) {
    lastViewedSection = viewId === 'detail-view' ? lastViewedSection : viewId;
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));

    if (viewId === 'list-view') { document.getElementById('nav-list').classList.add('active'); renderList(); }
    if (viewId === 'clients-view') { document.getElementById('nav-clients').classList.add('active'); renderClientsTable(); }
    if (viewId === 'dashboard-view') { document.getElementById('nav-dashboard').classList.add('active'); renderDashboard(); }
    if (viewId === 'projects-view') { document.getElementById('nav-projects').classList.add('active'); renderProjectsList(); }
    if (viewId === 'users-view') {
        const navU = document.getElementById('nav-users');
        if (navU) navU.classList.add('active');
        if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
        renderUsersTable();
    }

}
function goBackFromDetail() { showView(lastViewedSection); }

function checkAuth() {
    if (!currentUser) {
        document.getElementById('main-app').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('setup-screen').style.display = 'none';
    } else {
        document.getElementById('main-app').style.display = 'flex';
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('setup-screen').style.display = 'none';

        document.getElementById('ui-user-name').textContent = currentUser.nombre;
        const rName = currentUser.role === 'manager' ? 'Gerente' : (currentUser.role === 'gestor' ? 'Gestor de Ventas' : 'Vendedor');
        document.getElementById('ui-user-role').textContent = rName;

        applyRolePermissions();
    }
}

let pendingSetupUser = null;

function processLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-password').value;

    const user = (typeof CrmAuth !== 'undefined') ? CrmAuth.findLoginUser(users, email) : users.find(u => u.email === email && u.activo);
    if (!user) {
        // Direct Firebase Auth login fallback when users collection was not preloaded
        if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function' && pass) {
            return processDirectFirebaseAuthLogin(email, pass);
        }
        return alert("Usuario no encontrado o inactivo.");
    }

    // SEC-03: All authenticated logins require Firebase Authentication.
    // Plaintext password comparison in browser is decommissioned.
    if (user.authUid) return processFirebaseLogin(user, pass);

    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function' && pass) {
        return processDirectFirebaseAuthLogin(email, pass);
    }

    return alert("Esta cuenta histórica requiere vinculación a Firebase Authentication por un administrador antes de ingresar.");
}

async function processDirectFirebaseAuthLogin(email, pass) {
    try {
        const cred = await firebase.auth().signInWithEmailAndPassword(email, pass);
        if (!cred || !cred.user) return alert("Error al iniciar sesión.");
        const tok = await cred.user.getIdTokenResult();
        const cid = tok.claims && tok.claims.cid;
        const role = tok.claims && tok.claims.role;
        if (!cid || !role) {
            await firebase.auth().signOut();
            return alert("La cuenta de acceso no tiene un perfil comercial asignado.");
        }
        let profile = { id: cid, authUid: cred.user.uid, email, role, activo: true, nombre: cred.user.displayName || email };
        try {
            const snap = await db.collection(`users${DB_SUFFIX}`).doc(cid).get();
            if (snap.exists) {
                const sdata = snap.data() || {};
                if (sdata.activo === false) {
                    await firebase.auth().signOut();
                    return alert("Esta cuenta se encuentra inactiva. Contacta a un administrador.");
                }
                const hasLegacyPwd = sdata.password !== undefined && sdata.password !== null && sdata.password !== "";
                delete sdata.password;
                profile = Object.assign(profile, sdata);
                delete profile.password;
                if (hasLegacyPwd && typeof CrmAuth !== 'undefined' && typeof CrmAuth.purgeHistoricalPassword === 'function') {
                    CrmAuth.purgeHistoricalPassword(firebase, { id: cid, dbSuffix: DB_SUFFIX }).catch(() => {});
                }
            }
        } catch (_) {}
        currentUser = profile;
        localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
        checkAuth();
        reRenderApp();
    } catch (e) {
        const reason = (typeof CrmAuth !== 'undefined') ? CrmAuth.normalizeCode(e) : (e && e.code);
        alert((typeof CrmAuth !== 'undefined') ? CrmAuth.loginErrorMessage(reason) : "Correo o contraseña incorrectos.");
    }
}

async function processFirebaseLogin(user, pass) {
    if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. Recarga la página.");
    if (!pass) return alert("Ingresa tu contraseña.");
    const res = await CrmAuth.loginWithFirebase(firebase, user, pass);
    if (!res.ok) return alert(CrmAuth.loginErrorMessage(res.reason));
    currentUser = user;
    localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
    if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
    checkAuth();
    reRenderApp();

    // Requirement 6: purge plaintext password from Firestore profile once successful login is verified
    if (user.password !== undefined && user.password !== null && user.password !== "" && typeof CrmAuth.purgeHistoricalPassword === 'function') {
        CrmAuth.purgeHistoricalPassword(firebase, { id: user.id, dbSuffix: DB_SUFFIX })
            .then(() => {
                delete user.password;
                if (currentUser) delete currentUser.password;
                localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
            })
            .catch(err => {
                console.warn('[CRM] No se pudo purgar contraseña histórica tras login verificado:', err && err.message);
            });
    }
}

function processFirstTimeSetup(e) {
    e.preventDefault();
    const p1 = document.getElementById('setup-password').value;
    const p2 = document.getElementById('setup-password-confirm').value;
    if (p1 !== p2) return alert("Las contraseñas no coinciden.");
    if (p1.length < 4) return alert("La contraseña debe tener al menos 4 caracteres.");

    pendingSetupUser.password = p1;
    saveUserToDB(pendingSetupUser);

    currentUser = pendingSetupUser;
    localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
    if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
    checkAuth();
    reRenderApp();
}

function processLogout() {
    if (typeof detachSnapshotListeners === 'function') detachSnapshotListeners();
    clients = [];
    prospects = [];
    users = [];
    if (typeof CrmAuth !== 'undefined') CrmAuth.signOut(firebase);
    currentUser = null;
    localStorage.removeItem('ductsal_current_user');
    checkAuth();
}

function applyRolePermissions() {
    if (!currentUser) return;
    const role = currentUser.role;
    const navDashboard = document.getElementById('nav-dashboard'); const navProjects = document.getElementById('nav-projects'); const headerAction = document.getElementById('client-action-header');
    const navSettings = document.getElementById('nav-settings'); const navUsers = document.getElementById('nav-users');
    const navList = document.getElementById('nav-list'); const navClients = document.getElementById('nav-clients');

    // Hide all initially
    [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => { if (n) n.style.display = 'none'; });
    headerAction.style.display = 'none';

    if (role === 'manager') {
        [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        showView('dashboard-view');
    }
    else if (role === 'gestor') {
        [navProjects, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        headerAction.style.display = 'table-cell';
        showView('projects-view');
    }
    else {
        [navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        headerAction.style.display = 'table-cell';
        showView('list-view');
    }

    renderList();
    renderClientsTable();
    if (role === 'manager') {
        renderUsersTable();
        if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
    }
}

// ========================
// USERS MANAGEMENT
// ========================
let adminUsersLoading = false;
async function fetchAdminUsers() {
    if (!currentUser || currentUser.role !== 'manager') return;
    if (adminUsersLoading) return;
    adminUsersLoading = true;
    try {
        if (typeof CrmAuth !== 'undefined' && typeof CrmAuth.listUsersViaFunction === 'function' && typeof firebase !== 'undefined') {
            const list = await CrmAuth.listUsersViaFunction(firebase, { dbSuffix: DB_SUFFIX });
            if (Array.isArray(list)) {
                list.forEach(au => {
                    const idx = users.findIndex(u => u.id === au.id);
                    if (idx >= 0) {
                        users[idx] = Object.assign({}, users[idx], au);
                    } else {
                        users.push(au);
                    }
                });
                renderUsersTable();
            }
        }
    } catch (e) {
        console.warn('[CRM] Error al cargar usuarios administrativos:', e && e.message);
    } finally {
        adminUsersLoading = false;
    }
}

function openUserModal(id = null) {
    if (id) {
        const u = users.find(x => x.id === id);
        document.getElementById('user-id-edit').value = u.id;
        document.getElementById('usr-nombre').value = u.nombre;
        document.getElementById('usr-email').value = u.email;
        document.getElementById('usr-rol').value = u.role;
        document.getElementById('user-modal-title').textContent = 'Editar Usuario';
    } else {
        document.getElementById('user-id-edit').value = '';
        document.getElementById('usr-nombre').value = '';
        document.getElementById('usr-email').value = '';
        document.getElementById('usr-rol').value = 'vendedor';
        document.getElementById('user-modal-title').textContent = 'Registrar Usuario';
    }
    document.getElementById('userModal').style.display = 'block';
}

let userSaveInFlight = false;
async function saveUser(e) {
    e.preventDefault();
    const id = document.getElementById('user-id-edit').value;
    const nombre = document.getElementById('usr-nombre').value.trim();
    const email = document.getElementById('usr-email').value.trim();
    const role = document.getElementById('usr-rol').value;

    if (id) {
        const u = users.find(x => x.id === id);
        // The email of a Firebase-Auth-linked user is the login identity and cannot be edited here.
        if (u && u.authUid && u.email !== email) return alert("El correo de un usuario con cuenta de Firebase Authentication no se puede cambiar desde aquí.");
        // Name and ROLE of an Auth-linked profile are changed ONLY by updateUserAdmin (manager session verified live on the server; it keeps the
        // Auth claims and the profile in step and writes the audit). Nothing is changed locally unless the server confirms it. The email is
        // the login identity and cannot be edited. Only vendedor / gestor can be assigned; `manager` is never granted from here.
        if (u && u.authUid) {
            if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. No se guardó ningún cambio. Recarga la página.");
            if (role !== u.role && !CrmAuth.CREATABLE_ROLES.includes(role)) return alert("Solo se puede asignar el rol de vendedor o gestor desde aquí. Las cuentas de gerente las configura el propietario del sistema. No se guardó ningún cambio.");
            const change = { id: u.id, dbSuffix: DB_SUFFIX };
            if (nombre !== u.nombre) change.nombre = nombre;
            if (role !== u.role) change.role = role;
            if (change.nombre === undefined && change.role === undefined) { closeModal('userModal'); return; }
            if (userSaveInFlight) return;
            userSaveInFlight = true;
            try {
                const { outcome, result } = await CrmAuth.adminUpdateUser(firebase, change, alert);
                if (outcome !== 'updated') return;
                if (result && result.nombre !== undefined) u.nombre = result.nombre;
                if (result && result.role !== undefined) u.role = result.role;
                if (result && result.sessionsRevoked === false && change.role !== undefined) alert("El rol se cambió, pero no se pudieron cerrar las sesiones abiertas del usuario: aplicará cuando renueve su sesión.");
            } finally {
                userSaveInFlight = false;
            }
            closeModal('userModal');
            renderUsersTable();
            if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
            return;
        }
        // Historical users (no Auth account) keep the legacy edit until their identity migration (out of scope, pending).
        if (u) { u.nombre = nombre; u.email = email; u.role = role; saveUserToDB(u); }
    } else {
        if (users.some(x => String(x.email || '').trim().toLowerCase() === email.toLowerCase())) return alert("El correo ya está en uso.");
        // New users are ONLY created through the Cloud Function (the server verifies the caller is a
        // manager and Firebase Auth holds the credential). There is deliberately no fallback to the
        // old direct-Firestore creation, which stored a plaintext password: any outcome other than
        // 'created' has already been explained to the user by CrmAuth and the creation stops here.
        if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. No se creó el usuario. Recarga la página.");
        if (userSaveInFlight) return;
        userSaveInFlight = true;
        try {
            const outcome = await CrmAuth.adminCreateUser(firebase, { nombre, email, role, dbSuffix: DB_SUFFIX }, alert);
            if (outcome !== 'created') return;
        } finally {
            userSaveInFlight = false;
        }
    }
    closeModal('userModal');
    renderUsersTable();
    if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
}

function renderUsersTable() {
    const tbody = document.getElementById('users-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    users.forEach(u => {
        const roleMap = {
            'manager': 'Gerente', 'gestor': 'Gestor de Ventas', 'vendedor': 'Vendedor',
            'jefe_produccion': 'Jefe de Producción', 'recepcion': 'Recepción',
            'dibujante': 'Dibujante', 'operario': 'Operario', 'control_calidad': 'Control de Calidad', 'despacho': 'Despacho'
        };
        const rName = roleMap[u.role] || u.role;
        const stHtml = u.activo ? `<span style="color:var(--success);">Activo</span>` : `<span style="color:var(--danger);">Inactivo</span>`;
        tbody.innerHTML += `<tr>
            <td>${u.nombre}</td>
            <td>${u.email || '-'}</td>
            <td>${rName}</td>
            <td>${stHtml}</td>
            <td>
                <button class="btn-secondary" style="padding:4px 8px; font-size:0.7rem;" onclick="openUserModal('${u.id}')">Editar</button>
                <button class="btn-secondary" style="padding:4px 8px; font-size:0.7rem; margin-left:4px;" onclick="resetUserPassword('${u.id}')">Reset Pass</button>
                <button class="btn-danger" style="padding:4px 8px; font-size:0.7rem; margin-left:4px;" onclick="toggleUserStatus('${u.id}')">${u.activo ? 'Desactivar' : 'Activar'}</button>
            </td>
        </tr>`;
    });
}

function resetUserPassword(id) {
    const target = users.find(x => x.id === id);
    if (!target) return;
    // Firebase-Auth-linked users: Firebase emails a password-reset link; nothing is written to Firestore.
    if (target.authUid) {
        if (!confirm("¿Enviar a este usuario un correo para restablecer su contraseña?")) return;
        if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. Recarga la página.");
        CrmAuth.sendPasswordSetupEmail(firebase, target.email)
            .then(() => alert("Correo de restablecimiento enviado."))
            .catch(() => alert("No se pudo enviar el correo de restablecimiento."));
        return;
    }
    alert("Este usuario no está vinculado a Firebase Authentication. Debe ser vinculado previamente por un administrador.");
}

async function toggleUserStatus(id) {
    const u = users.find(x => x.id === id);
    if (u.id === currentUser.id) return alert("No puedes desactivarte a ti mismo.");
    // Auth-linked users: the Cloud Function disables/enables the Firebase Auth account and updates the
    // profile together. Nothing is changed locally unless the server confirms it.
    if (u.authUid) {
        if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. No se cambió el estado. Recarga la página.");
        const outcome = await CrmAuth.adminSetUserActive(firebase, { id: u.id, activo: !u.activo, dbSuffix: DB_SUFFIX }, alert);
        if (outcome === 'updated') {
            u.activo = !u.activo;
            renderUsersTable();
            if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
        }
        return;
    }
    u.activo = !u.activo;
    saveUserToDB(u);
    renderUsersTable();
}

const formatCurrency = (val) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val || 0);
const formatDate = (date) => {
    if (!date) return '-';
    let d = new Date(date);
    if (isNaN(d)) return '-';
    return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
};
const getDaysDifference = (d1) => Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24));

const getProjectSubtotal = (p) => {
    let base = p.precio_cotizado || 0;
    if (p.ordenes_cambio) {
        p.ordenes_cambio.forEach(o => {
            base += (o.tipo === 'aumento' ? Number(o.precio) : -Math.abs(Number(o.precio)));
        });
    }
    return base;
};

const getProjectCosto = (p) => {
    let base = p.costo_venta || 0;
    if (p.ordenes_cambio) {
        p.ordenes_cambio.forEach(o => {
            base += (o.tipo === 'aumento' ? Number(o.costo) : -Math.abs(Number(o.costo)));
        });
    }
    return base;
};

// ========================
// CODE GENERATOR
// ========================
function generateProspectCode() {
    const now = new Date(); const year = now.getFullYear().toString(); const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const prospectsThisYear = prospects.filter(p => p.fecha_creacion && new Date(p.fecha_creacion).getFullYear() === now.getFullYear());
    return `${year}${month}${(prospectsThisYear.length + 1).toString().padStart(3, '0')}`;
}

// ========================
// CLIENTS
// ========================
// Clients visible to the current user (list and selector). A vendedor sees the clients they created plus the
// clients referenced (clientId) by opportunities they created or that are assigned to them: the same criterion
// renderList uses for opportunities, so an assigned opportunity never points at a client the vendedor cannot see.
// Gerente, gestor and any other role keep seeing every client. Read-only: no stored data is modified.
function getVisibleClients() {
    if (!currentUser || currentUser.role !== 'vendedor') return clients;
    const related = new Set();
    prospects.forEach(p => {
        if (p.createdBy === currentUser.id || p.vendedorId === currentUser.id) related.add(p.clientId);
    });
    return clients.filter(c => c.createdBy === currentUser.id || related.has(c.id));
}

function renderClientsTable() {
    const tbody = document.getElementById('clients-table-body'); tbody.innerHTML = '';

    let filtered = getVisibleClients();

    // Apply Search Filter
    const searchVal = document.getElementById('cli-search') ? document.getElementById('cli-search').value.toLowerCase().trim() : '';
    if (searchVal) {
        filtered = filtered.filter(c => {
            const isNatural = c.tipo === 'natural';
            const mainName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.empresa || '-');
            const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.contacto || '-');

            return (c.tipo || '').toLowerCase().includes(searchVal) ||
                mainName.toLowerCase().includes(searchVal) ||
                contactName.toLowerCase().includes(searchVal) ||
                (c.telefono || '').toLowerCase().includes(searchVal) ||
                (c.correo || '').toLowerCase().includes(searchVal);
        });
    }

    // Apply Sorting
    if (cliSortCol) {
        filtered.sort((a, b) => {
            let valA = '';
            let valB = '';

            const isNaturalA = a.tipo === 'natural';
            const isNaturalB = b.tipo === 'natural';

            if (cliSortCol === 'tipo') {
                valA = a.tipo || '';
                valB = b.tipo || '';
            } else if (cliSortCol === 'nombre') {
                valA = isNaturalA ? `${a.nombres || ''} ${a.apellidos || ''}` : (a.empresa || '-');
                valB = isNaturalB ? `${b.nombres || ''} ${b.apellidos || ''}` : (b.empresa || '-');
            } else if (cliSortCol === 'contacto') {
                valA = isNaturalA ? `${a.nombres || ''} ${a.apellidos || ''}` : (a.contacto || '-');
                valB = isNaturalB ? `${b.nombres || ''} ${b.apellidos || ''}` : (b.contacto || '-');
            } else if (cliSortCol === 'telefono') {
                valA = a.telefono || '';
                valB = b.telefono || '';
            } else if (cliSortCol === 'correo') {
                valA = a.correo || '';
                valB = b.correo || '';
            }

            return cliSortDir === 'asc'
                ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
        });
    } else {
        filtered = [...filtered].reverse();
    }

    filtered.forEach(c => {
        const isNatural = c.tipo === 'natural'; const typeBadge = isNatural ? '<span class="badge bg-neutral">Natural</span>' : '<span class="badge bg-neutral" style="color:var(--brand-gold);">Jurídica</span>';
        const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.contacto || '-'); const mainName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.empresa || '-');
        const isExport = c.es_exportacion === true || c.es_exportacion === 'true';
        const exportBadge = isExport ? ' <span class="badge" style="background:rgba(33, 150, 243, 0.2); color:#64B5F6; border:1px solid #2196F3; font-size:0.7rem; margin-left:4px;">✈️ Exportación</span>' : '';

        let btnHTML = `<button class="btn-secondary" onclick="openClientModal('${c.id}')" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Editar</button>`;
        if (currentUser && currentUser.role === 'manager') {
            btnHTML += `<button class="btn-danger" onclick="deleteClient('${c.id}')" style="padding: 0.25rem 0.5rem; font-size:0.75rem; margin-left:5px;">Eliminar</button>`;
        }

        tbody.innerHTML += `<tr><td>${typeBadge}</td><td><strong>${mainName}</strong>${exportBadge}</td><td>${contactName}</td><td>${c.telefono || '-'}</td><td>${c.correo || '-'}</td><td>${btnHTML}</td></tr>`;
    });
}
function toggleClientFields() {
    const type = document.getElementById('client-tipo').value;
    if (type === 'natural') { document.getElementById('fields-natural').style.display = 'block'; document.getElementById('fields-juridica').style.display = 'none'; }
    else if (type === 'juridica') { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'block'; }
    else { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'none'; }
}

function openClientModal(clientId = null) {
    document.getElementById('clientForm').reset(); document.getElementById('client-id-edit').value = '';
    if (clientId) {
        document.getElementById('client-modal-title').textContent = 'Editar Cliente'; const c = clients.find(x => x.id === clientId);
        if (c) {
            window._activeClientBaseDocs = (c.documentos && typeof c.documentos === 'object') ? JSON.parse(JSON.stringify(c.documentos)) : null;
            document.getElementById('client-id-edit').value = c.id; document.getElementById('client-tipo').value = c.tipo; toggleClientFields();
            document.getElementById('cli-telefono').value = c.telefono || ''; document.getElementById('cli-correo').value = c.correo || ''; document.getElementById('cli-correo-fact').value = c.correo_fact || '';
            document.getElementById('cli-es-exportacion').checked = c.es_exportacion === true || c.es_exportacion === 'true';
            if (c.tipo === 'natural') {
                document.getElementById('nat-nombres').value = c.nombres || ''; document.getElementById('nat-apellidos').value = c.apellidos || '';
                document.getElementById('nat-dui').value = c.dui || ''; document.getElementById('nat-nit').value = c.nit || '';
                document.getElementById('nat-profesion').value = c.profesion || ''; document.getElementById('nat-domicilio').value = c.domicilio || '';
                const sts = document.getElementById('nat-dui-status');
                if (c.documentos && typeof c.documentos === 'object' && Object.keys(c.documentos).length > 0) {
                    const items = [];
                    const allKeys = Object.keys(c.documentos);
                    const sortedKeys = allKeys.includes('dui')
                        ? ['dui', ...allKeys.filter(k => k !== 'dui').sort()]
                        : allKeys.sort();
                    for (const k of sortedKeys) {
                        const val = c.documentos[k];
                        if (!val) continue;
                        const lbl = formatClientDocLabel(k);
                        if (Array.isArray(val)) {
                            val.forEach((subVal, idx) => {
                                if (subVal) items.push(renderClientDocItem(subVal, `${lbl} (${idx + 1})`, c.id, k, idx));
                            });
                        } else {
                            items.push(renderClientDocItem(val, lbl, c.id, k));
                        }
                    }
                    sts.innerHTML = items.length > 0 ? `<span style="color:var(--success);">✔️ Expediente: ${items.join(' ')}</span>` : '';
                } else { sts.innerHTML = ''; }
            }
            else {
                document.getElementById('jur-empresa').value = c.empresa || ''; document.getElementById('jur-contacto').value = c.contacto || ''; document.getElementById('jur-nit').value = c.nit || ''; document.getElementById('jur-nrc').value = c.nrc || '';
                document.getElementById('jur-rep-legal').value = c.rep_legal || ''; document.getElementById('jur-profesion-rep').value = c.profesion_rep || ''; document.getElementById('jur-domicilio-rep').value = c.domicilio_rep || '';
                document.getElementById('jur-dui-rep').value = c.dui_rep || ''; document.getElementById('jur-nit-rep').value = c.nit_rep || '';
                document.getElementById('jur-gran-contribuyente').checked = c.is_gran_contribuyente === true;
                const jSts = document.getElementById('jur-docs-status');
                if (c.documentos && typeof c.documentos === 'object' && Object.keys(c.documentos).length > 0) {
                    let links = [];
                    const PREFERRED_ORDER = [
                        'escritura', 'escritura_constitucion',
                        'mods_escritura', 'mods',
                        'credencial', 'credencial_rep',
                        'nit', 'nit_empresa',
                        'nrc', 'nrc_empresa',
                        'dui', 'dui_rep'
                    ];
                    const allKeys = Object.keys(c.documentos);
                    const sortedKeys = [
                        ...PREFERRED_ORDER.filter(k => allKeys.includes(k)),
                        ...allKeys.filter(k => !PREFERRED_ORDER.includes(k)).sort()
                    ];
                    for (const k of sortedKeys) {
                        const val = c.documentos[k];
                        if (!val) continue;
                        const lbl = formatClientDocLabel(k);
                        if (Array.isArray(val)) {
                            val.forEach((subVal, idx) => {
                                if (subVal) links.push(renderClientDocItem(subVal, `${lbl} (${idx + 1})`, c.id, k, idx));
                            });
                        } else {
                            links.push(renderClientDocItem(val, lbl, c.id, k));
                        }
                    }
                    jSts.innerHTML = links.length > 0 ? `<span style="color:var(--success);">Archivos en expediente: ${links.join(' ')}</span>` : '';
                } else { jSts.innerHTML = ''; }
            }
        }
    } else {
        window._activeClientBaseDocs = null;
        document.getElementById('client-modal-title').textContent = 'Registrar Cliente'; document.getElementById('client-tipo').value = ''; document.getElementById('jur-gran-contribuyente').checked = false; document.getElementById('cli-es-exportacion').checked = false; toggleClientFields();
    }
    document.getElementById('clientModal').style.display = 'block';
}

async function deleteClientDocument(clientId, docKey, itemIndex = null) {
    if (!currentUser || currentUser.role !== 'manager') {
        return alert("Permiso denegado. Solo el Gerente puede eliminar documentos.");
    }
    const client = clients.find(c => c.id === clientId);
    if (!client || !client.documentos || client.documentos[docKey] === undefined) {
        return alert("Documento no encontrado.");
    }

    const docName = formatClientDocLabel(docKey);
    const targetDesc = (itemIndex !== null && itemIndex !== undefined) ? `[${docName} (${itemIndex + 1})]` : `[${docName}]`;

    if (!confirm(`¿Estás seguro de que deseas eliminar el documento ${targetDesc} del expediente de este cliente?`)) {
        return;
    }

    // The server decides (manager only) and keeps the identifier index consistent: no direct write of the client.
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmClients === 'undefined' || !CrmClients.hasSessionSync(fb)) {
        return alert(typeof CrmClients !== 'undefined' ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
    }
    showLoading('Eliminando documento...');
    try {
        const next = JSON.parse(JSON.stringify(client));
        next.baseDocumentos = (client.documentos && typeof client.documentos === 'object')
            ? JSON.parse(JSON.stringify(client.documentos))
            : {};
        if (itemIndex !== null && itemIndex !== undefined && Array.isArray(next.documentos[docKey])) {
            next.documentos[docKey].splice(itemIndex, 1);
            if (next.documentos[docKey].length === 0) {
                delete next.documentos[docKey];
            }
        } else {
            delete next.documentos[docKey];
        }
        const res = await CrmClients.updateClient(fb, { id: clientId, client: next, dbSuffix: DB_SUFFIX, confirmReview: false });
        if (res.status !== 'updated') return alert('No se eliminó el documento: ' + (res.status || 'respuesta inesperada') + '.');
        
        if (res.client && res.client.documentos !== undefined) {
            client.documentos = res.client.documentos;
        } else {
            if (itemIndex !== null && itemIndex !== undefined && Array.isArray(client.documentos[docKey])) {
                client.documentos[docKey].splice(itemIndex, 1);
                if (client.documentos[docKey].length === 0) {
                    delete client.documentos[docKey];
                }
            } else {
                delete client.documentos[docKey];
            }
        }
        window._activeClientBaseDocs = (client.documentos && typeof client.documentos === 'object') ? JSON.parse(JSON.stringify(client.documentos)) : null;
        openClientModal(clientId);
        renderClientsTable();
    } catch (err) {
        alert(CrmClients.errorMessage(err));
    } finally {
        hideLoading();
    }
}

function hasStagedClientFiles(type) {
    if (typeof document === 'undefined') return false;
    if (type === 'natural') {
        const duiEl = document.getElementById('nat-dui-file');
        return !!(duiEl && duiEl.files && duiEl.files.length > 0);
    }
    const specs = [
        'jur-file-escritura',
        'jur-file-mods',
        'jur-file-credencial',
        'jur-file-nit',
        'jur-file-nrc',
        'jur-file-dui'
    ];
    return specs.some(id => {
        const el = document.getElementById(id);
        return !!(el && el.files && el.files.length > 0);
    });
}

async function uploadClientStagedFiles(targetId, type, existingDocs = {}) {
    const docs = Object.assign({}, existingDocs);
    const filesToUpload = [];
    if (type === 'natural') {
        const duiEl = document.getElementById('nat-dui-file');
        if (duiEl && duiEl.files.length > 0) {
            filesToUpload.push({ el: duiEl, key: 'dui', isLegal: false });
        }
    } else {
        const specs = [
            { id: 'jur-file-escritura', key: 'escritura', isLegal: true },
            { id: 'jur-file-mods', key: 'mods_escritura', isLegal: true },
            { id: 'jur-file-credencial', key: 'credencial', isLegal: true },
            { id: 'jur-file-nit', key: 'nit', isLegal: true },
            { id: 'jur-file-nrc', key: 'nrc', isLegal: true },
            { id: 'jur-file-dui', key: 'dui', isLegal: false }
        ];
        for (const s of specs) {
            const el = document.getElementById(s.id);
            if (el && el.files.length > 0) filesToUpload.push({ el, key: s.key, isLegal: s.isLegal });
        }
    }

    if (filesToUpload.length === 0) return docs;

    showLoading('Subiendo documentos del cliente a la nube...');
    await Promise.all(filesToUpload.map(async item => {
        const ref = await uploadFileToStorage(item.el.files[0], 'clientes', { clientId: targetId, isLegal: item.isLegal });
        docs[item.key] = ref;
    }));
    return docs;
}

async function saveClient(e) {
    e.preventDefault();
    try {
        const editId = document.getElementById('client-id-edit').value;
        const type = document.getElementById('client-tipo').value;
        if (!type) return alert("Debes seleccionar el Tipo de Persona obligatoriamente.");

        const tel = document.getElementById('cli-telefono').value.trim();
        const email = document.getElementById('cli-correo').value.trim();
        if (!tel && !email) return alert("Debe ingresar obligatoriamente un teléfono o correo.");

        let c = {};
        if (editId) {
            const existing = clients.find(x => x.id === editId);
            if (existing) c = JSON.parse(JSON.stringify(existing));
        }
        if (!c.documentos) c.documentos = {};

        if (type === 'natural') {
            c.nombres = document.getElementById('nat-nombres').value.trim();
            c.apellidos = document.getElementById('nat-apellidos').value.trim();
            if (!c.nombres || !c.apellidos) return alert("Nombres y Apellidos obligatorios.");
            c.dui = document.getElementById('nat-dui').value;
            c.nit = document.getElementById('nat-nit').value;
            c.profesion = document.getElementById('nat-profesion').value;
            c.domicilio = document.getElementById('nat-domicilio').value;
        } else {
            c.empresa = document.getElementById('jur-empresa').value.trim();
            if (!c.empresa) return alert("Nombre de la Empresa obligatorio.");
            c.contacto = document.getElementById('jur-contacto').value.trim();
            if (!c.contacto) return alert("Nombre del Contacto Principal obligatorio.");
            c.nit = document.getElementById('jur-nit').value;
            c.nrc = document.getElementById('jur-nrc').value;
            c.rep_legal = document.getElementById('jur-rep-legal').value.trim();
            c.profesion_rep = document.getElementById('jur-profesion-rep').value;
            c.domicilio_rep = document.getElementById('jur-domicilio-rep').value;
            c.dui_rep = document.getElementById('jur-dui-rep').value;
            c.nit_rep = document.getElementById('jur-nit-rep').value;
            c.is_gran_contribuyente = document.getElementById('jur-gran-contribuyente').checked;
        }
        c.tipo = type;
        c.telefono = tel;
        c.correo = email;
        c.correo_fact = document.getElementById('cli-correo-fact').value;
        c.es_exportacion = document.getElementById('cli-es-exportacion').checked;

        // The server decides (duplicates by NIT / DUI, ownership, id). A blocked / cancelled save returns null.
        const saved = await persistClientViaServer(c, editId);
        if (!saved) return;
        c = saved;
        const at = clients.findIndex(x => x.id === c.id);
        if (at > -1) clients[at] = c; else clients.push(c);
        closeModal('clientModal');
        if (document.getElementById('newProspectModal') && document.getElementById('newProspectModal').style.display === 'block') {
            selectClientInSelector(c.id, getClientName(c.id));
        } else {
            renderClientsTable();
        }
    } catch (err) {
        alert("Error al guardar cliente: " + err.message);
    } finally {
        hideLoading();
    }
}

// ========================
// PROSPECTS & PROJECTS LISTS
// ========================
function getClientName(clientId) {
    const client = clients.find(c => c.id === clientId) || { nombres: 'Desconocido', empresa: 'Desconocido' };
    return client.tipo === 'natural' ? `${client.nombres} ${client.apellidos}` : client.empresa;
}

function renderList() {
    let filtered = prospects;
    if (currentUser && currentUser.role === 'vendedor') {
        filtered = filtered.filter(p => p.createdBy === currentUser.id || p.vendedorId === currentUser.id);
    }
    const tbody = document.getElementById('opp-table-body'); tbody.innerHTML = '';
    let visibleProspects = filtered.filter(p => p.estado !== 'ganado');

    // Apply Search Filter
    const searchVal = document.getElementById('opp-search') ? document.getElementById('opp-search').value.toLowerCase().trim() : '';
    if (searchVal) {
        visibleProspects = visibleProspects.filter(p => {
            const codeMatch = (p.codigo || '').toLowerCase().includes(searchVal) || p.id.substring(p.id.length - 4).toLowerCase().includes(searchVal);
            const clientMatch = getClientName(p.clientId).toLowerCase().includes(searchVal);
            const projectMatch = (p.proyecto || '').toLowerCase().includes(searchVal);
            const vendorInfo = getProspectVendorInfo(p);
            const vendorMatch = vendorInfo.name.toLowerCase().includes(searchVal) || vendorInfo.role.toLowerCase().includes(searchVal);
            const stageMatch = (p.etapa || '').toLowerCase().includes(searchVal);
            const amountMatch = p.precio_cotizado ? formatCurrency(p.precio_cotizado).toLowerCase().includes(searchVal) || String(p.precio_cotizado).includes(searchVal) : false;
            const statusMatch = (p.estado || '').toLowerCase().includes(searchVal);
            return codeMatch || clientMatch || projectMatch || vendorMatch || stageMatch || amountMatch || statusMatch;
        });
    }

    // Apply Sorting
    if (oppSortCol) {
        visibleProspects.sort((a, b) => {
            let valA = '';
            let valB = '';

            if (oppSortCol === 'codigo') {
                valA = a.codigo || a.id.substring(a.id.length - 4);
                valB = b.codigo || b.id.substring(b.id.length - 4);
            } else if (oppSortCol === 'cliente') {
                valA = getClientName(a.clientId);
                valB = getClientName(b.clientId);
            } else if (oppSortCol === 'proyecto') {
                valA = a.proyecto || '';
                valB = b.proyecto || '';
            } else if (oppSortCol === 'vendedor') {
                valA = getProspectVendorInfo(a).name;
                valB = getProspectVendorInfo(b).name;
            } else if (oppSortCol === 'etapa') {
                valA = a.etapa || '';
                valB = b.etapa || '';
            } else if (oppSortCol === 'monto') {
                valA = parseFloat(a.precio_cotizado) || 0;
                valB = parseFloat(b.precio_cotizado) || 0;
            } else if (oppSortCol === 'estado') {
                valA = a.estado || '';
                valB = b.estado || '';
            }

            if (typeof valA === 'string') {
                return oppSortDir === 'asc'
                    ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                    : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
            } else {
                return oppSortDir === 'asc' ? valA - valB : valB - valA;
            }
        });
    } else {
        visibleProspects.reverse();
    }

    if (visibleProspects.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 2rem; color: var(--text-muted);">No se encontraron oportunidades.</td></tr>';
        return;
    }

    visibleProspects.forEach(p => {
        const tr = document.createElement('tr'); tr.classList.add('cursor-pointer'); tr.onclick = () => openDetail(p.id);
        let badgeClass = p.estado === 'activo' ? 'activo' : 'perdido';

        // Calculate days in stage
        const timestamp = p.stage_timestamps && p.stage_timestamps[p.etapa] ? p.stage_timestamps[p.etapa] : p.fecha_creacion;
        const daysInStage = getDaysDifference(timestamp);
        const limit = KPI_LIMITS[p.etapa] || 999;
        const isLate = p.estado === 'activo' && daysInStage > limit;

        if (isLate) {
            tr.style.backgroundColor = 'rgba(220, 20, 60, 0.15)'; // Red tint
            tr.style.color = '#ff6b6b';
        }

        const vendor = getProspectVendorInfo(p);
        const vendorBadge = vendor.role ? `<span style="font-size:0.75rem; color:var(--text-secondary); display:block;">(${vendor.role})</span>` : '';

        tr.innerHTML = `<td>${p.codigo || p.id.substring(p.id.length - 4)}</td><td><strong>${getClientName(p.clientId)}</strong></td><td>${p.proyecto}</td><td><strong>${vendor.name}</strong>${vendorBadge}</td><td style="text-transform: capitalize;">${p.etapa} ${isLate ? '<span style="font-size:0.7rem; color:var(--danger); font-weight:bold;">(Retrasado)</span>' : ''}</td><td>${p.precio_cotizado ? formatCurrency(p.precio_cotizado) : '-'}</td><td><span class="badge ${badgeClass}">${p.estado.toUpperCase()}</span></td><td><button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Ver</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderProjectsList() {
    const tbody = document.getElementById('proj-table-body'); tbody.innerHTML = '';
    const projects = prospects.filter(p => p.estado === 'ganado');
    if (projects.length === 0) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 2rem; color: var(--text-muted);">No hay proyectos cerrados / ganados todavía.</td></tr>'; return; }

    // Map projects to calculated objects for search and sort
    let mappedProjects = projects.map(p => {
        let subtotal = p.precio_cotizado || 0;
        const client = clients.find(c => c.id === p.clientId);
        const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
        let total = isExport ? subtotal : subtotal * 1.13;

        let totalFacturado = 0; let totalCobrado = 0;
        if (p.facturas) {
            p.facturas.forEach(f => {
                totalFacturado += f.monto;
                if (f.pagos) totalCobrado += f.pagos.reduce((a, b) => a + parseFloat(b.monto), 0);
            });
        }

        const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
        const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;

        return {
            original: p,
            codigo: p.codigo || p.id.substring(p.id.length - 4),
            cliente: getClientName(p.clientId),
            isExport: isExport,
            proyecto: p.proyecto || '',
            encargado: p.encargado || '-',
            total: total,
            condicion: p.forma_pago || 'N/A',
            pctFacturado: pctFacturado,
            pctCobrado: pctCobrado
        };
    });

    // Apply Search Filter
    const searchVal = document.getElementById('proj-search') ? document.getElementById('proj-search').value.toLowerCase().trim() : '';
    if (searchVal) {
        mappedProjects = mappedProjects.filter(mp => {
            return mp.codigo.toLowerCase().includes(searchVal) ||
                mp.cliente.toLowerCase().includes(searchVal) ||
                mp.proyecto.toLowerCase().includes(searchVal) ||
                mp.encargado.toLowerCase().includes(searchVal) ||
                mp.condicion.toLowerCase().includes(searchVal) ||
                formatCurrency(mp.total).toLowerCase().includes(searchVal) ||
                String(mp.total).includes(searchVal) ||
                mp.pctFacturado.toFixed(0).includes(searchVal) ||
                mp.pctCobrado.toFixed(0).includes(searchVal);
        });
    }

    // Apply Sorting
    if (projSortCol) {
        mappedProjects.sort((a, b) => {
            let valA = a[projSortCol];
            let valB = b[projSortCol];

            if (typeof valA === 'string') {
                return projSortDir === 'asc'
                    ? valA.localeCompare(valB, 'es', { sensitivity: 'base' })
                    : valB.localeCompare(valA, 'es', { sensitivity: 'base' });
            } else {
                return projSortDir === 'asc' ? valA - valB : valB - valA;
            }
        });
    } else {
        mappedProjects.reverse();
    }

    if (mappedProjects.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 2rem; color: var(--text-muted);">No se encontraron proyectos.</td></tr>';
        return;
    }

    mappedProjects.forEach(mp => {
        const p = mp.original;
        const tr = document.createElement('tr'); tr.classList.add('cursor-pointer'); tr.onclick = () => openDetail(p.id);
        tr.innerHTML = `
            <td><strong>${p.codigo || '-'}</strong></td>
            <td>${mp.cliente}${mp.isExport ? ' <span style="font-size:0.7rem; color:#64B5F6;">(✈️ Export)</span>' : ''}</td>
            <td>${mp.proyecto}</td>
            <td>${mp.encargado}</td>
            <td>${formatCurrency(mp.total)}</td>
            <td>${mp.condicion}</td>
            <td>${mp.pctFacturado.toFixed(0)}%</td>
            <td>
                <div style="background:rgba(255,255,255,0.1); height:8px; border-radius:4px; width:100px; margin-bottom:4px; overflow:hidden;">
                    <div style="background:var(--success); height:100%; width:${mp.pctCobrado}%"></div>
                </div>
                <small>${mp.pctCobrado.toFixed(0)}%</small>
            </td>
            <td><button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Gestionar</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function openNewModal() {
    renderClientSelect();
    const vendorGroup = document.getElementById('vendedor-assign-group');
    const vendorSelect = document.getElementById('new-vendedor-select');
    if (vendorGroup && vendorSelect) {
        if (currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
            vendorGroup.style.display = 'block';
            vendorSelect.innerHTML = `<option value="${currentUser.id}">Mismo Creador: ${currentUser.nombre} (${currentUser.role === 'manager' ? 'Gerente' : 'Gestor'})</option>`;
            users.filter(u => u.activo !== false && u.id !== currentUser.id).forEach(u => {
                const rText = u.role === 'manager' ? 'Gerente' : (u.role === 'gestor' ? 'Gestor' : 'Vendedor');
                vendorSelect.innerHTML += `<option value="${u.id}">${u.nombre} (${rText})</option>`;
            });
        } else {
            vendorGroup.style.display = 'none';
        }
    }
    document.getElementById('newProspectModal').style.display = 'block';
}
let currentClientReservationId = null;

async function cancelPendingClientReservation() {
    if (!currentClientReservationId) return;
    const resId = currentClientReservationId;
    currentClientReservationId = null;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (fb && typeof CrmClients !== 'undefined') {
        try {
            await CrmClients.cancelReservation(fb, { reservationId: resId, dbSuffix: DB_SUFFIX });
        } catch (e) {
            console.warn('No se pudo cancelar la reserva pendiente:', e);
        }
    }
}

function closeModal(id) {
    if (id === 'clientModal') {
        cancelPendingClientReservation();
    }
    document.getElementById(id).style.display = 'none';
}
// Selector of NEW opportunities. Deliberately NOT getVisibleClients(): that is the portfolio shown in the Clients
// section. A vendedor with a Firebase session searches the WHOLE catalogue on the server (searchClientsCatalog: id,
// name and a masked document hint only); picking a client never creates or modifies it. Gerente / gestor keep the
// complete local list. A vendedor on the historical login has no server session, so the portfolio is the best available.
function catalogueSearchActive() {
    return !!(currentUser && currentUser.role === 'vendedor' && typeof CrmClients !== 'undefined' && CrmClients.hasSessionSync(firebase));
}
function getSelectorClientsLocal() {
    return (currentUser && currentUser.role === 'vendedor') ? getVisibleClients() : clients;
}
function renderClientSelect() {
    const select = document.getElementById('new-cliente-select'); select.innerHTML = '<option value="">-- Selecciona Cliente --</option>';
    const search = document.getElementById('new-cliente-search');
    const hint = document.getElementById('new-cliente-search-hint');
    const active = catalogueSearchActive();
    if (search) { search.style.display = active ? 'block' : 'none'; search.value = ''; }
    if (hint) { hint.style.display = active ? 'block' : 'none'; hint.textContent = active ? 'Busca por nombre, NIT o DUI (mín. 2 letras o 4 dígitos). Verás todos los clientes del catálogo.' : ''; }
    if (active) return;
    getSelectorClientsLocal().forEach(c => { select.add(new Option(c.tipo === 'natural' ? `${c.nombres} ${c.apellidos}` : c.empresa, c.id)); });
}
// Makes sure `id` is an option of the selector and selects it (a catalogue client may not be in the results list).
function selectClientInSelector(id, label) {
    const select = document.getElementById('new-cliente-select');
    if (!select) return;
    if (![...select.options].some(o => o.value === id)) select.add(new Option(label || id, id));
    select.value = id;
}
let catalogueSearchTimer = null, catalogueSearchSeq = 0;
function onClientCatalogSearchInput() {
    clearTimeout(catalogueSearchTimer);
    catalogueSearchTimer = setTimeout(runClientCatalogSearch, 300);
}
async function runClientCatalogSearch() {
    const search = document.getElementById('new-cliente-search');
    const hint = document.getElementById('new-cliente-search-hint');
    const select = document.getElementById('new-cliente-select');
    if (!search || !hint || !select) return;
    const seq = ++catalogueSearchSeq;
    const q = search.value.trim();
    try {
        const res = await CrmClients.searchCatalog(firebase, { q, dbSuffix: DB_SUFFIX });
        if (seq !== catalogueSearchSeq) return; // a newer search is in flight
        const keep = select.value ? { id: select.value, label: select.options[select.selectedIndex].text } : null;
        select.innerHTML = '<option value="">-- Selecciona Cliente --</option>';
        if (keep) select.add(new Option(keep.label, keep.id));
        (res.results || []).forEach(r => { if (!keep || keep.id !== r.id) select.add(new Option(CrmClients.catalogOptionLabel(r), r.id)); });
        if (keep) select.value = keep.id;
        hint.textContent = res.tooShort ? 'Escribe al menos 2 letras o 4 dígitos para buscar.'
            : (res.results || []).length === 0 ? 'Sin resultados. Si el cliente no existe, usa "+ Nuevo".'
            : `${res.results.length} resultado(s)${res.truncated ? ' (hay más: afina la búsqueda)' : ''}. ★ = ya está en tu cartera.`;
    } catch (err) {
        if (seq === catalogueSearchSeq) hint.textContent = CrmClients.errorMessage(err);
    }
}

// Creates / edits a client through Cloud Functions with server reservation and hierarchical storage.
// Returns the saved client, or null when nothing was saved (duplicate, review declined, error, no session).
async function persistClientViaServer(c, editId) {
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmClients === 'undefined' || !CrmClients.hasSessionSync(fb)) {
        hideLoading();
        alert(typeof CrmClients !== 'undefined' ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
        return null;
    }
    let confirmReview = false;

    // A) EDIT EXISTING CLIENT
    if (editId) {
        const filesStaged = hasStagedClientFiles(c.tipo);
        if (filesStaged) {
            showLoading('Subiendo documentos del cliente...');
            try {
                c.baseDocumentos = (window._activeClientBaseDocs !== undefined && window._activeClientBaseDocs !== null)
                    ? JSON.parse(JSON.stringify(window._activeClientBaseDocs))
                    : (c.documentos ? JSON.parse(JSON.stringify(c.documentos)) : {});
                c.documentos = await uploadClientStagedFiles(editId, c.tipo, c.documentos);
            } catch (uploadErr) {
                hideLoading();
                alert("Error al subir documentos: " + uploadErr.message);
                return null;
            }
        } else {
            // General data update: do NOT send documentos so live Firestore documents remain untouched
            delete c.documentos;
            delete c.baseDocumentos;
        }

        showLoading('Guardando cambios en cliente...');
        for (let attempt = 0; attempt < 2; attempt++) {
            let res;
            try {
                res = await CrmClients.updateClient(fb, { id: editId, client: c, dbSuffix: DB_SUFFIX, confirmReview });
            } catch (err) {
                hideLoading();
                alert(CrmClients.errorMessage(err));
                return null;
            }
            if (res.status === 'duplicate') {
                hideLoading();
                alert(CrmClients.duplicateMessage(res));
                return null;
            }
            if (res.status === 'needs-review') {
                hideLoading();
                if (!confirm(CrmClients.reviewMessage(res))) return null;
                showLoading('Guardando cliente...');
                confirmReview = true;
                continue;
            }
            const mergedClient = Object.assign({}, c, res.client || {});
            window._activeClientBaseDocs = (mergedClient.documentos && typeof mergedClient.documentos === 'object')
                ? JSON.parse(JSON.stringify(mergedClient.documentos))
                : null;
            return mergedClient;
        }
        return null;
    }

    // B) CREATE NEW CLIENT (RESERVATION -> UPLOAD -> FINALIZE)
    let reservationId = null;
    showLoading('Validando y reservando registro de cliente...');

    for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
            res = await CrmClients.reserveCreation(fb, { client: c, dbSuffix: DB_SUFFIX, confirmReview });
        } catch (err) {
            hideLoading();
            alert(CrmClients.errorMessage(err));
            return null;
        }

        if (res.status === 'duplicate') {
            hideLoading();
            alert(CrmClients.duplicateMessage(res));
            const modalOpen = document.getElementById('newProspectModal') && document.getElementById('newProspectModal').style.display === 'block';
            if (modalOpen && res.matches && res.matches.length === 1) {
                closeModal('clientModal');
                selectClientInSelector(res.matches[0].clientId, res.matches[0].nombre);
            }
            return null;
        }

        if (res.status === 'needs-review') {
            hideLoading();
            if (!confirm(CrmClients.reviewMessage(res))) return null;
            showLoading('Confirmando revisión de cliente...');
            confirmReview = true;
            continue;
        }

        if (res.status === 'reserved' && res.reservationId) {
            reservationId = res.reservationId;
            currentClientReservationId = reservationId;
            break;
        }

        hideLoading();
        alert('Respuesta inesperada al reservar cliente: ' + (res.status || 'error'));
        return null;
    }

    if (!reservationId) return null;

    // STEP 2: Upload staged files with active server reservation
    try {
        c.documentos = await uploadClientStagedFiles(reservationId, c.tipo, c.documentos);
    } catch (uploadErr) {
        hideLoading();
        console.error('Error al subir documentos de la reserva:', uploadErr);
        if (confirm(`Error al subir documentos: ${uploadErr.message}. ¿Deseas cancelar la reserva para intentar de nuevo?`)) {
            await cancelPendingClientReservation();
        }
        return null;
    }

    // STEP 3: Finalize Client Creation
    showLoading('Formalizando creación del cliente...');
    let finRes;
    try {
        finRes = await CrmClients.finalizeCreation(fb, { reservationId, client: c, dbSuffix: DB_SUFFIX, confirmReview });
    } catch (finErr) {
        hideLoading();
        alert(CrmClients.errorMessage(finErr));
        return null;
    }

    if (finRes.status === 'duplicate') {
        hideLoading();
        alert(CrmClients.duplicateMessage(finRes));
        return null;
    }
    if (finRes.status !== 'created' && finRes.status !== 'ok') {
        hideLoading();
        alert('No se pudo formalizar el cliente: ' + (finRes.status || 'error desconocido'));
        return null;
    }

    currentClientReservationId = null; // Successfully finalized!
    return Object.assign({}, c, finRes.client || { id: reservationId });
}
// The opportunity is created by createProspectAdmin: the server decides who creates it (from the Firebase session), the code
// and the initial history. The browser only sends what the user typed and, for manager/gestor, an optional assignee id.
async function createNewProspect(e) {
    e.preventDefault(); const clientId = document.getElementById('new-cliente-select').value; if (!clientId) return alert("Debes seleccionar un cliente");
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const prospect = {
        clientId: clientId,
        proyecto: document.getElementById('new-proyecto').value,
        origen: document.getElementById('new-origen').value,
        tipo_proyecto: document.getElementById('new-tipo-proyecto').value,
        tipo_producto: document.getElementById('new-tipo-producto').value
    };
    const vendorSelect = document.getElementById('new-vendedor-select');
    if (vendorSelect && vendorSelect.value && currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
        prospect.vendedorId = vendorSelect.value; // only a hint: the server re-checks the role and that the user exists
    }

    showLoading('Creando prospecto...');
    try {
        const res = await CrmCommercial.createProspect(fb, { prospect, dbSuffix: DB_SUFFIX });
        if (res && res.prospect && res.prospect.id && !prospects.some(x => x.id === res.prospect.id)) prospects.push(res.prospect);
        closeModal('newProspectModal');
        document.getElementById('newProspectForm').reset();
        renderList();
    } catch (err) {
        alert(CrmCommercial.errorMessage(err));
    } finally {
        hideLoading();
    }
}

// ========================
// DETAIL VIEW & ADVANCEMENT
// ========================
function openDetail(id) {
    currentProspectId = id; const p = prospects.find(x => x.id === id); if (!p) return;
    showView('detail-view');
    document.getElementById('detail-cliente').textContent = getClientName(p.clientId);
    document.getElementById('detail-proyecto').innerHTML = `${p.proyecto} <span class="badge bg-neutral ml-2">${p.codigo || ''}</span>`;
    document.getElementById('advance-form-container').innerHTML = '';
    const textEl = document.getElementById('new-log-text');
    if (textEl) textEl.value = '';

    const payForm = document.getElementById('payment-form'); if (payForm) payForm.style.display = 'none';
    const invForm = document.getElementById('invoice-form'); if (invForm) invForm.style.display = 'none';

    // Show Delete Prospect button for managers
    const btnDeleteProspect = document.getElementById('btn-delete-prospect');
    if (btnDeleteProspect) {
        btnDeleteProspect.style.display = (currentUser && currentUser.role === 'manager') ? 'block' : 'none';
    }

    const actionContainer = document.getElementById('action-buttons-container');
    const finTracker = document.getElementById('financial-tracker-container');
    const stageTitleText = document.getElementById('stage-title-text');

    const trackerContainer = document.getElementById('stage-tracker');
    const btnSendFab = document.getElementById('btn-send-fab');
    if (btnSendFab) btnSendFab.style.display = 'none';

    if (p.estado === 'activo') {
        actionContainer.style.display = 'block'; finTracker.style.display = 'none'; stageTitleText.parentElement.style.display = 'block'; trackerContainer.style.display = 'flex'; stageTitleText.textContent = "Avance de Etapa"; document.getElementById('btn-advance').style.display = p.etapa === 'cierre' ? 'none' : 'inline-block';

        const existingBtn = document.getElementById('btn-new-proposal');
        if (existingBtn) existingBtn.remove();
        if (p.etapa === 'negociacion') {
            const btn = document.createElement('button');
            btn.id = 'btn-new-proposal';
            btn.className = 'btn-success ml-2';
            btn.textContent = 'Registrar Nueva Propuesta';
            btn.onclick = () => showNewProposalForm();
            actionContainer.appendChild(btn);
        }
    } else if (p.estado === 'ganado') {
        actionContainer.style.display = 'none'; finTracker.style.display = 'block'; stageTitleText.parentElement.style.display = 'none'; trackerContainer.style.display = 'none'; renderFinancials(p);
        if (btnSendFab && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
            btnSendFab.style.display = 'inline-block';
        }
    } else { actionContainer.style.display = 'none'; finTracker.style.display = 'none'; stageTitleText.parentElement.style.display = 'block'; trackerContainer.style.display = 'flex'; stageTitleText.textContent = "Línea de Tiempo"; }

    let timeInStage = 0;
    if (p.stage_timestamps && p.stage_timestamps[p.etapa]) {
        timeInStage = getDaysDifference(p.stage_timestamps[p.etapa]);
    } else {
        timeInStage = getDaysDifference(p.fecha_creacion);
    }
    document.getElementById('detail-time-in-stage').textContent = `Tiempo en etapa: ${timeInStage} días`;
    renderTracker(p); renderInfo(p); renderLogs(p);
}

function renderFinancials(p) {
    const client = clients.find(c => c.id === p.clientId);
    const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
    const subtotal = getProjectSubtotal(p);
    const iva = isExport ? 0 : subtotal * 0.13;
    const total = subtotal + iva;

    const costoTotal = getProjectCosto(p);
    const margen = subtotal - costoTotal;
    const margenPct = subtotal > 0 ? (margen / subtotal) * 100 : 0;

    document.getElementById('fin-precio-original').textContent = formatCurrency(p.precio_cotizado || 0);
    document.getElementById('fin-costo-original').textContent = formatCurrency(p.costo_venta || 0);

    const ordContainer = document.getElementById('fin-ordenes-container');
    const costContainer = document.getElementById('fin-costos-ordenes-container');

    if (ordContainer) ordContainer.innerHTML = '';
    if (costContainer) costContainer.innerHTML = '';

    // Advertencia de Retención 1% (Gran Contribuyente)
    const isGranContribuyente = client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true');
    const warningContainer = document.getElementById('fin-retencion-warning');
    if (isGranContribuyente) {
        if (!warningContainer) {
            const warnDiv = document.createElement('div');
            warnDiv.id = 'fin-retencion-warning';
            warnDiv.style.cssText = 'background-color: rgba(255, 193, 7, 0.15); border-left: 4px solid var(--brand-gold); padding: 10px; margin-bottom: 15px; border-radius: 4px; color: var(--brand-gold); font-size: 0.9rem;';
            warnDiv.innerHTML = `<strong>⚠️ Agente de Retención:</strong> Este cliente es Gran Contribuyente. Recuerda que el <strong>1% de cada factura</strong> quedará como saldo pendiente (CXC) hasta que se registre el <em>Comprobante de Retención</em> como pago.`;
            document.getElementById('invoices-list').parentNode.insertBefore(warnDiv, document.getElementById('invoices-list'));
        } else {
            warningContainer.style.display = 'block';
        }
    } else if (warningContainer) {
        warningContainer.style.display = 'none';
    }

    // Advertencia de Cliente de Exportación (Sin IVA)
    const exportContainer = document.getElementById('fin-export-warning');
    if (isExport) {
        if (!exportContainer) {
            const expDiv = document.createElement('div');
            expDiv.id = 'fin-export-warning';
            expDiv.style.cssText = 'background-color: rgba(33, 150, 243, 0.15); border-left: 4px solid #2196F3; padding: 10px; margin-bottom: 15px; border-radius: 4px; color: #64B5F6; font-size: 0.9rem;';
            expDiv.innerHTML = `<strong>✈️ Cliente de Exportación:</strong> Este cliente está exento de IVA (0% IVA). Los montos de facturación y cobro no incluyen impuesto.`;
            document.getElementById('invoices-list').parentNode.insertBefore(expDiv, document.getElementById('invoices-list'));
        } else {
            exportContainer.style.display = 'block';
        }
    } else if (exportContainer) {
        exportContainer.style.display = 'none';
    }

    if (p.ordenes_cambio && p.ordenes_cambio.length > 0) {
        p.ordenes_cambio.forEach(o => {
            let sign = o.tipo === 'aumento' ? '+' : '-';
            let color = o.tipo === 'aumento' ? 'var(--brand-gold)' : 'var(--danger)';

            if (ordContainer) {
                let ocDocLink = '';
                if (o.doc_oferta) {
                    ocDocLink = `<span style="margin-left:5px;"><a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.ordenes_cambio?.find(oc => oc.id === '${o.id}')?.doc_oferta, 'Oferta OC', { prospectId: '${p.id}' })" style="color:var(--brand-gold); text-decoration:none; cursor:pointer;" title="Previsualizar">📄 Doc</a> <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.ordenes_cambio?.find(oc => oc.id === '${o.id}')?.doc_oferta, 'Oferta OC', { prospectId: '${p.id}' })" style="color:var(--text-secondary); margin-left:3px; font-size:0.75rem; text-decoration:none; cursor:pointer;" title="Descargar documento">⬇️</a></span>`;
                }
                ordContainer.innerHTML += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; color:${color}; margin-top:2px;">
                    <span>↳ ${o.desc} ${ocDocLink}
                        <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--brand-gold);" onclick="editChangeOrder('${o.id}')">[Editar]</span>
                        <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--danger);" onclick="deleteChangeOrder('${o.id}')">[Eliminar]</span>
                    </span> <span>${sign}${formatCurrency(o.precio)}</span>
                </div>`;
            }
            if (costContainer) {
                costContainer.innerHTML += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; color:${color}; margin-top:2px;">
                    <span>↳ ${o.desc}</span> <span>${sign}${formatCurrency(o.costo)}</span>
                </div>`;
            }
        });
    }

    document.getElementById('fin-costo-total').textContent = formatCurrency(costoTotal);
    const margenEl = document.getElementById('fin-margen');
    if (margenEl) {
        margenEl.textContent = formatCurrency(margen);
        margenEl.style.color = margen >= 0 ? 'var(--success)' : 'var(--danger)';
        document.getElementById('fin-margen-pct').textContent = `(${margenPct.toFixed(1)}%)`;
        document.getElementById('fin-margen-pct').style.color = margen >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    let totalFacturado = 0; let totalCobrado = 0;

    const listDiv = document.getElementById('invoices-list');
    listDiv.innerHTML = '';

    if (!p.facturas) p.facturas = [];

    p.facturas.forEach((f, invoiceIndex) => {
        totalFacturado += f.monto;
        let pCobrado = 0;
        if (f.pagos) pCobrado = f.pagos.reduce((a, b) => a + parseFloat(b.monto), 0);
        totalCobrado += pCobrado;
        let pSaldo = f.monto - pCobrado;

        let isPaid = pSaldo <= 0;

        let pHistory = '';
        if (f.pagos && f.pagos.length > 0) {
            pHistory = `<div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.5rem; border-top:1px dashed var(--panel-border); padding-top:0.5rem;">
                <strong>Historial de Pagos de esta factura:</strong><br>` +
                f.pagos.map((pay, i) => {
                    let docLink = '';
                    if (pay.doc_comprobante) {
                        docLink = `<span style="margin-left:5px;"><a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.pagos?.[${i}]?.doc_comprobante, 'Comprobante', { prospectId: '${p.id}' })" style="color:var(--brand-gold); text-decoration:none; cursor:pointer;" title="Previsualizar">📄 Comprobante</a> <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.pagos?.[${i}]?.doc_comprobante, 'Comprobante', { prospectId: '${p.id}' })" style="color:var(--text-secondary); margin-left:3px; font-size:0.75rem; text-decoration:none; cursor:pointer;" title="Descargar documento">⬇️</a></span>`;
                    }
                    let lbl = pay.metodo === 'retencion_1pct' ? '<span style="color:var(--brand-gold);">[Retención 1%]</span>' : 'Abono:';
                    let met = pay.metodo === 'retencion_1pct' ? 'Comprobante' : (pay.metodo || 'N/A');
                    return `${formatDate(pay.fecha)} - ${lbl} ${formatCurrency(pay.monto)} [${met}] ${pay.ref ? `(Ref: ${pay.ref})` : ''} ${docLink} <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="editPayment('${f.id}', ${i})">[Editar]</span> <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--danger);" onclick="deletePayment('${f.id}', ${i})">[Eliminar]</span>`;
                }).join('<br>') + `</div>`;
        }

        listDiv.innerHTML += `
            <div style="background: rgba(0,0,0,0.15); border: 1px solid var(--panel-border); border-radius: 8px; padding: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="font-size:1.1rem; color:white;">${f.numero}</strong> <span class="badge ${isPaid ? 'ganado' : 'activo'} ml-2">${isPaid ? 'PAGADA' : 'PENDIENTE'}</span>
                        <span class="cursor-pointer" style="margin-left:10px; font-size:0.8rem; color:var(--brand-gold);" onclick="editInvoice('${f.id}')">[Editar Factura]</span>
                        ${invoiceIndex > 0 ? `<span class="cursor-pointer" style="margin-left:5px; font-size:0.8rem; color:var(--danger);" onclick="deleteInvoice('${f.id}')">[Eliminar Factura]</span>` : `<span style="margin-left:5px; font-size:0.8rem; color:var(--text-muted);" title="La factura de anticipo no puede ser eliminada">[Eliminar Factura]</span>`}
                        ${f.doc_factura ? `<span style="margin-left:10px; font-size:0.8rem;"><a href="javascript:void(0)" onclick="viewSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.doc_factura, 'Factura ${f.numero}', { prospectId: '${p.id}' })" style="color:var(--brand-gold); text-decoration:none; cursor:pointer;" title="Previsualizar">📄 ${typeof f.doc_factura === 'object' && f.doc_factura.name ? f.doc_factura.name : 'Factura'}</a> <a href="javascript:void(0)" onclick="downloadSecureDocument(prospects.find(x => x.id === '${p.id}')?.facturas?.find(fac => fac.id === '${f.id}')?.doc_factura, 'Factura ${f.numero}', { prospectId: '${p.id}' })" style="color:var(--text-secondary); margin-left:3px; text-decoration:none; cursor:pointer;" title="Descargar documento">⬇️</a></span>` : ''}
                        <div style="font-size:0.9rem; color:var(--text-secondary); margin-top:4px;">Facturado: ${formatCurrency(f.monto)} | Saldo Pendiente: <span style="color:var(--danger)">${formatCurrency(pSaldo)}</span></div>
                    </div>
                    ${!isPaid ? `<button class="btn-success" onclick="showPaymentForm('${f.id}', '${f.numero}')" style="padding:0.4rem 0.8rem; font-size:0.8rem;">+ Abonar a Factura</button>` : ''}
                </div>
                ${pHistory}
            </div>
        `;
    });

    if (p.facturas.length === 0) {
        listDiv.innerHTML = '<div style="text-align:center; padding: 1rem; color:var(--text-muted);">No hay facturas emitidas todavía.</div>';
    }

    const cxc = totalFacturado - totalCobrado; // Cuentas por Cobrar (Invoice amounts not yet paid)
    const porFacturar = total - totalFacturado;

    document.getElementById('fin-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('fin-iva').textContent = isExport ? "$0 (0% Exportación)" : formatCurrency(iva);
    document.getElementById('fin-total').textContent = formatCurrency(total);

    document.getElementById('fin-facturado').textContent = formatCurrency(totalFacturado);
    document.getElementById('fin-cobrado').textContent = formatCurrency(totalCobrado);
    document.getElementById('fin-saldo').textContent = formatCurrency(cxc);
    document.getElementById('fin-por-facturar').textContent = formatCurrency(porFacturar > 0 ? porFacturar : 0);

    if (totalFacturado >= (total - 0.1)) {
        document.getElementById('btn-add-invoice').style.display = 'none';
        document.getElementById('invoice-form').style.display = 'none';
    } else {
        document.getElementById('btn-add-invoice').style.display = 'inline-block';
    }
}

function openChangeOrderModal() {
    document.getElementById('changeOrderForm').reset();
    document.getElementById('co-id-edit').value = '';
    document.getElementById('changeOrderModal').style.display = 'block';
}

function editChangeOrder(id) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.ordenes_cambio) return;
    const o = p.ordenes_cambio.find(x => x.id === id);
    if (!o) return;

    document.getElementById('co-id-edit').value = o.id;
    document.getElementById('co-tipo').value = o.tipo;
    document.getElementById('co-desc').value = o.desc;
    document.getElementById('co-precio').value = o.precio;
    document.getElementById('co-costo').value = o.costo;
    document.getElementById('changeOrderModal').style.display = 'block';
}

// ===== Opportunity workflow: server operations (functions/prospectWorkflowService.js) =====
// Common wrapper of the operations below. It checks that there is a Firebase session (the server authorizes every call anyway), shows the
// loading indicator, words server rejections, and NEVER falls back to writing the document from the browser: when there is no session or
// the call fails, the operation simply does not happen and the user is told why. File uploads (Storage) happen inside `operation` BEFORE the
// call; what is sent to the server is the user's input and the file references, never the opportunity document.
// Returns the server answer, or null when nothing was saved. The realtime listener refreshes the screen with the stored result.
async function runWorkflowOp(loadingMessage, operation) {
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        return null;
    }
    showLoading(loadingMessage);
    try {
        return await operation(fb);
    } catch (err) {
        // A rejection of the callable carries the `functions/...` code; anything else (e.g. a failed upload) keeps its own message.
        if (err && String(err.code || '').startsWith('functions/')) alert(CrmCommercial.errorMessage(err));
        else alert('No se pudo completar la operación: ' + ((err && err.message) || 'error desconocido'));
        console.error(err);
        return null;
    } finally {
        hideLoading();
    }
}

async function processChangeOrder(e) {
    e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;

    const editId = document.getElementById('co-id-edit').value;
    const tipo = document.getElementById('co-tipo').value;
    const desc = document.getElementById('co-desc').value.trim();
    const precio = parseFloat(document.getElementById('co-precio').value);
    const costo = parseFloat(document.getElementById('co-costo').value);

    const fOferta = document.getElementById('co-oferta');
    const fCostos = document.getElementById('co-costos');

    // saveChangeOrderAdmin: type, amounts and files are validated on the server; the order is added / edited by id inside a transaction on the
    // stored document, so another user's changes made meanwhile are not overwritten. A retry reuses the same opId.
    const res = await runWorkflowOp('Subiendo documentos de la orden de cambio...', async fb => {
        const docOferta = (fOferta && fOferta.files.length > 0) ? await uploadFileToStorage(fOferta.files[0], 'ordenes_cambio', { prospectId: p.id }) : null;
        const docCostos = (fCostos && fCostos.files.length > 0) ? await uploadFileToStorage(fCostos.files[0], 'ordenes_cambio', { prospectId: p.id }) : null;
        return CrmCommercial.saveChangeOrder(fb, { prospectId: p.id, orderId: editId || undefined, tipo, desc, precio, costo, doc_oferta: docOferta || undefined, doc_costos: docCostos || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) closeModal('changeOrderModal');
}

function showInvoiceForm() {
    document.getElementById('invoice-form').style.display = 'block'; document.getElementById('payment-form').style.display = 'none';
    document.getElementById('btn-add-invoice').style.display = 'none';
    document.getElementById('inv-id-edit').value = '';
    document.getElementById('inv-numero').value = ''; document.getElementById('inv-monto').value = ''; document.getElementById('inv-file').value = '';

    const p = prospects.find(x => x.id === currentProspectId);
    const client = p ? clients.find(c => c.id === p.clientId) : null;
    const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
    const lbl = document.getElementById('inv-monto-label');
    if (lbl) lbl.textContent = isExport ? 'Monto a Facturar (Sin IVA - Exportación)' : 'Monto a Facturar (CON IVA)';
}

function editInvoice(id) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === id);
    if (!f) return;

    document.getElementById('invoice-form').style.display = 'block'; document.getElementById('payment-form').style.display = 'none';
    document.getElementById('btn-add-invoice').style.display = 'none';
    document.getElementById('inv-id-edit').value = f.id;
    document.getElementById('inv-numero').value = f.numero;
    document.getElementById('inv-monto').value = f.monto;

    const client = clients.find(c => c.id === p.clientId);
    const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
    const lbl = document.getElementById('inv-monto-label');
    if (lbl) lbl.textContent = isExport ? 'Monto a Facturar (Sin IVA - Exportación)' : 'Monto a Facturar (CON IVA)';
}

async function processInvoice(e) {
    if (e) e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const editId = document.getElementById('inv-id-edit').value;
    const n = document.getElementById('inv-numero').value.trim(); const m = parseFloat(document.getElementById('inv-monto').value);
    const fileEl = document.getElementById('inv-file');

    if (!n) return alert("Ingrese un número de factura.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto válido mayor a cero.");
    if (!editId && fileEl.files.length === 0) return alert("Debe adjuntar la copia de la factura.");

    // saveInvoiceAdmin: the balance ceiling (13% VAT / export, change orders) is checked on the server against the STORED invoices, in
    // the same transaction that writes the invoice; two people invoicing at once cannot jointly exceed it.
    const res = await runWorkflowOp('Subiendo factura a la nube...', async fb => {
        const doc = fileEl.files.length > 0 ? await uploadFileToStorage(fileEl.files[0], 'facturas', { prospectId: p.id }) : null;
        return CrmCommercial.saveInvoice(fb, { prospectId: p.id, invoiceId: editId || undefined, numero: n, monto: m, doc_factura: doc || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) document.getElementById('invoice-form').style.display = 'none';
}

function showPaymentForm(invoiceId, invoiceNumero) {
    document.getElementById('payment-form').style.display = 'block'; document.getElementById('invoice-form').style.display = 'none';
    document.getElementById('pay-target-invoice-text').textContent = `Abonando a documento: ${invoiceNumero}`;
    document.getElementById('pay-invoice-id').value = invoiceId;
    document.getElementById('pay-idx-edit').value = '';
    document.getElementById('pay-monto-nuevo').value = ''; document.getElementById('pay-ref').value = '';

    // Configurar método de pago dinámicamente según el cliente
    const p = prospects.find(x => x.id === currentProspectId);
    const selectMetodo = document.getElementById('pay-metodo');
    let isGranContribuyente = false;

    // Limpiar opciones de retención previas
    Array.from(selectMetodo.options).forEach(opt => {
        if (opt.value === 'retencion_1pct') opt.remove();
    });

    if (p && p.facturas) {
        const fac = p.facturas.find(f => f.id === invoiceId);
        if (fac) document.getElementById('pay-monto-nuevo').dataset.invoiceTotal = fac.monto;

        const client = clients.find(c => c.id === p.clientId);
        isGranContribuyente = client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true');

        const opt = document.createElement('option');
        opt.value = 'retencion_1pct';
        opt.textContent = isGranContribuyente ? 'Comprobante de Retención (1%)' : 'Retención 1% (Solo Grandes Contribuyentes)';
        opt.disabled = !isGranContribuyente;
        selectMetodo.appendChild(opt);
    }
}

function handlePaymentMethodChange() {
    const met = document.getElementById('pay-metodo').value;
    const inputMonto = document.getElementById('pay-monto-nuevo');
    if (met === 'retencion_1pct') {
        const totalFactura = parseFloat(inputMonto.dataset.invoiceTotal);
        if (!isNaN(totalFactura)) {
            // El usuario pidió que se calcule el 1% pero sea modificable
            inputMonto.value = (totalFactura * 0.01).toFixed(2);
        }
    } else {
        // Opcional: limpiar si cambian de opción, aunque si ya escribieron algo tal vez sea mejor dejarlo
    }
}

function editPayment(invoiceId, paymentIndex) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === invoiceId);
    if (!f || !f.pagos) return;
    const pay = f.pagos[paymentIndex];

    document.getElementById('payment-form').style.display = 'block'; document.getElementById('invoice-form').style.display = 'none';
    document.getElementById('pay-target-invoice-text').textContent = `Editando abono en Factura ${f.numero}`;
    document.getElementById('pay-invoice-id').value = invoiceId;
    document.getElementById('pay-idx-edit').value = pay.id || pay.fecha; // key of the payment, not its position
    document.getElementById('pay-monto-nuevo').value = pay.monto;
    document.getElementById('pay-monto-nuevo').dataset.invoiceTotal = f.monto;

    // Configurar método de pago dinámicamente según el cliente
    const selectMetodo = document.getElementById('pay-metodo');
    Array.from(selectMetodo.options).forEach(opt => {
        if (opt.value === 'retencion_1pct') opt.remove();
    });

    const client = clients.find(c => c.id === p.clientId);
    const isGranContribuyente = client && (client.is_gran_contribuyente === true || client.is_gran_contribuyente === 'true');

    const opt = document.createElement('option');
    opt.value = 'retencion_1pct';
    opt.textContent = isGranContribuyente ? 'Comprobante de Retención (1%)' : 'Retención 1% (Solo Grandes Contribuyentes)';
    opt.disabled = !isGranContribuyente;
    selectMetodo.appendChild(opt);

    document.getElementById('pay-metodo').value = pay.metodo;
    document.getElementById('pay-ref').value = pay.ref;
}

async function processPayment(e) {
    if (e) e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const m = parseFloat(document.getElementById('pay-monto-nuevo').value);
    const met = document.getElementById('pay-metodo').value;
    const ref = document.getElementById('pay-ref').value.trim();
    const invId = document.getElementById('pay-invoice-id').value;
    // For an edit this holds the key of the payment (its id, or its fecha for payments saved before they had an id), not a position.
    const editKey = document.getElementById('pay-idx-edit').value;
    const fileEl = document.getElementById('pay-file');

    if (!editKey && fileEl && fileEl.files.length === 0) return alert("Debe adjuntar el comprobante de pago.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto de pago válido.");
    if (!p.facturas || !p.facturas.some(f => f.id === invId)) return;

    // savePaymentAdmin: the balance ceiling, the 1% retention rule (large taxpayers only), the history entry and the audit are decided on the
    // server from the stored invoice. A retry after an uncertain failure reuses the same opId, so a payment cannot be recorded twice.
    const res = await runWorkflowOp('Subiendo comprobante de pago...', async fb => {
        const doc = (fileEl && fileEl.files.length > 0) ? await uploadFileToStorage(fileEl.files[0], 'pagos', { prospectId: p.id }) : null;
        return CrmCommercial.savePayment(fb, { prospectId: p.id, invoiceId: invId, paymentKey: editKey || undefined, monto: m, metodo: met, ref, doc_comprobante: doc || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) document.getElementById('payment-form').style.display = 'none';
}

function renderTracker(p) {
    const tracker = document.getElementById('stage-tracker'); tracker.innerHTML = ''; const currentIndex = STAGES.indexOf(p.etapa);
    STAGES.forEach((stage, index) => {
        let statusClass = '';
        if (p.estado === 'perdido' && index <= currentIndex) statusClass = 'completed';
        else if (p.estado !== 'perdido') { if (index < currentIndex) statusClass = 'completed'; if (index === currentIndex) statusClass = 'current'; if (p.estado === 'ganado' && stage === 'cierre') statusClass = 'completed'; }
        tracker.innerHTML += `<div class="stage-step ${statusClass}"><div class="stage-circle">${index + 1}</div><div class="stage-label">${stage}</div></div>`;
    });
    document.getElementById('detail-badges').innerHTML = `<span class="badge ${p.estado === 'activo' ? 'activo' : (p.estado === 'ganado' ? 'ganado' : 'perdido')}">${(p.estado || 'activo').toUpperCase()}</span>`;
}

function renderInfo(p) {
    const list = document.getElementById('info-list');

    // Evitar crasheo si p.fecha_creacion no existe (ej: importado de Excel)
    let fechaDate = new Date();
    if (p.fecha_creacion) {
        let parsed = new Date(p.fecha_creacion);
        if (!isNaN(parsed)) fechaDate = parsed;
    }

    const vendor = getProspectVendorInfo(p);
    let vendorLinkHTML = `<li><strong style="color:var(--brand-gold)">Vendedor / Asesor:</strong> <strong>${vendor.name}</strong> ${vendor.role ? `<span style="color:var(--text-secondary)">(${vendor.role})</span>` : ''}`;
    if (currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
        vendorLinkHTML += ` <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="reassignVendor('${p.id}')">[Reasignar]</span>`;
    }
    vendorLinkHTML += `</li>`;

    list.innerHTML = `<li><strong>Creación:</strong> ${fechaDate.toLocaleDateString('es-MX')}</li>${vendorLinkHTML}<li><strong>Origen:</strong> ${p.origen || '-'}</li><li><strong>Tipo Proy:</strong> ${p.tipo_proyecto || '-'}</li><li><strong>Producto:</strong> ${p.tipo_producto || '-'}</li>`;
    if (!p.datos) p.datos = {};
    if (p.datos.ubicacion) {
        list.innerHTML += `<li><span class="label">Ubicación:</span> ${p.datos.ubicacion}</li>`;
        if (p.datos.distancia) list.innerHTML += `<li><span class="label">Distancia a fábrica:</span> ${p.datos.distancia} km</li>`;
    }
    if (p.datos.visitante) list.innerHTML += `<li><strong>Visitó:</strong> ${p.datos.visitante} (${p.datos.fecha_visita})</li>`;
    if (p.datos.fecha_inicio) list.innerHTML += `<li><strong>Est. Inicio:</strong> ${p.datos.fecha_inicio}</li>`;
    // Base price / cost: corrected only by manager / gestor and only BEFORE the closing (editProspectBasePriceAdmin enforces both on the
    // server against the STORED role and state; hiding the link is just the courtesy, not the protection).
    const canEditBase = !!currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor') && p.estado === 'activo';
    const editBaseLink = canEditBase ? ` <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="openEditBasePriceModal()">[Editar Costo/Precio]</span>` : '';
    if (p.costo_venta) list.innerHTML += `<li><strong>Costo:</strong> ${formatCurrency(p.costo_venta)}${editBaseLink}</li>`;
    if (p.precio_cotizado) list.innerHTML += `<li><strong>Precio:</strong> ${formatCurrency(p.precio_cotizado)}${editBaseLink}</li>`;
    if (p.probabilidad) list.innerHTML += `<li><strong>Probabilidad:</strong> ${p.probabilidad}%</li>`;

    const isBigInstalacionInfo = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));
    if (isBigInstalacionInfo && p.estado === 'activo') {
        const isAuthorized = p.datos && p.datos.autorizado_sin_contrato === true;
        const isManager = currentUser && currentUser.role === 'manager';
        if (isManager) {
            list.innerHTML += `<li>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--brand-gold); font-weight: bold; margin-top: 4px; margin-bottom: 4px;">
                    <input type="checkbox" id="info-auth-no-contract" ${isAuthorized ? 'checked' : ''} onchange="toggleManagerApproval(this.checked)">
                    <span>Autorizar sin Contrato</span>
                </label>
            </li>`;
            if (!isAuthorized && noContractRequestsOf(p).some(r => r.estado === 'pendiente')) list.innerHTML += `<li>${renderNoContractRequestHTML(p)}</li>`;
        } else {
            if (isAuthorized) {
                list.innerHTML += `<li><strong style="color: var(--success)">✔️ Cierre Sin Contrato Autorizado</strong> (por ${p.datos.autorizado_por || 'Gerente'})</li>`;
            } else {
                list.innerHTML += `<li><strong style="color: var(--danger)">⚠️ Requiere Contrato (> $10k)</strong></li>`;
                list.innerHTML += `<li>${renderNoContractRequestHTML(p)}</li>`;
            }
        }
    }

    if (p.estado === 'ganado') {
        list.innerHTML += `<li><strong style="color:var(--brand-gold)">Forma de Pago:</strong> ${p.forma_pago}</li>`;
        if (p.encargado) list.innerHTML += `<li><strong style="color:var(--brand-gold)">Encargado Inst.:</strong> ${p.encargado}</li>`;
    }
    if (p.estado === 'perdido') list.innerHTML += `<li><strong style="color:var(--danger)">Motivo Pérdida:</strong> ${p.motivo_perdida}</li>`;

    // Render Docs
    const docsList = document.getElementById('docs-list');
    docsList.innerHTML = '';
    let hasDocs = false;

    function dlLink(doc) {
        if (!doc) return '';
        let name = typeof doc === 'object' ? (doc.name || 'Documento') : doc;
        let id = 'doc_' + Math.random().toString(36).substring(2, 9);
        if (typeof window !== 'undefined') {
            if (!window._docStore) window._docStore = new Map();
            window._docStore.set(id, doc);
        }
        const previewable = isFormatPreviewable(name);
        const pId = (p && p.id) ? p.id : '';
        if (previewable) {
            return `<span class="doc-link-item" style="display:inline-flex; align-items:center; gap:6px; margin:2px 0;">` +
                   `<a href="javascript:void(0)" onclick="viewSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" style="color:var(--brand-gold); cursor:pointer; text-decoration:underline;" title="Previsualizar">👁️ ${escapeHtmlDoc(name)}</a>` +
                   `<a href="javascript:void(0)" onclick="downloadSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" style="color:var(--text-secondary); text-decoration:none; font-size:0.75rem; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1); cursor:pointer;" title="Descargar archivo">⬇️ Descargar</a>` +
                   `</span>`;
        } else {
            return `<span class="doc-link-item" style="display:inline-flex; align-items:center; gap:6px; margin:2px 0;">` +
                   `<span style="color:var(--text-primary); font-weight:500;">📁 ${escapeHtmlDoc(name)}</span>` +
                   `<a href="javascript:void(0)" onclick="downloadSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" style="color:var(--brand-gold); text-decoration:none; font-size:0.75rem; background:rgba(217,119,6,0.15); padding:2px 8px; border-radius:4px; border:1px solid rgba(217,119,6,0.3); font-weight:600; cursor:pointer;" title="Descargar archivo">⬇️ Descargar</a>` +
                   `</span>`;
        }
    }

    function renderDocLinks(doc) {
        if (!doc) return '';
        if (Array.isArray(doc)) {
            return doc.map(d => dlLink(d)).join(', ');
        }
        return dlLink(doc);
    }

    if (p.datos.doc_levantamiento) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Planos/Notas:</span> <span style="word-break: break-all;">${renderDocLinks(p.datos.doc_levantamiento)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_oferta) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Oferta/Cotiz.:</span> <span style="word-break: break-all;">${renderDocLinks(p.datos.doc_oferta)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_costos) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Cuadro Costos:</span> <span style="word-break: break-all;">${renderDocLinks(p.datos.doc_costos)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_oferta_firmada) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Oferta Firmada:</span> <span style="word-break: break-all;">${renderDocLinks(p.datos.doc_oferta_firmada)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_contrato) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Contrato:</span> <span style="word-break: break-all;">${renderDocLinks(p.datos.doc_contrato)}</span></li>`; hasDocs = true; }

    if (p.facturas && p.facturas.length > 0) {
        p.facturas.forEach(f => {
            if (f.doc_factura) {
                docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Fac ${f.numero}:</span> <span style="word-break: break-all;">${renderDocLinks(f.doc_factura)}</span></li>`;
                hasDocs = true;
            }
        });
    }

    if (!hasDocs) {
        docsList.innerHTML = `<li style="color:var(--text-muted); font-size: 0.85rem;">No hay documentos adjuntos.</li>`;
    }
}

// Manager-only decision resolved by setNoContractAuthorizationAdmin: the server re-checks (live) that the caller is a manager,
// stores who authorised from the Firebase session, writes the history entry and the audit record. No direct write here.
async function applyNoContractAuthorization(checked) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return false;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        return false;
    }
    showLoading('Guardando autorización...');
    try {
        const res = await CrmCommercial.setNoContractAuthorization(fb, { prospectId: p.id, authorized: !!checked, dbSuffix: DB_SUFFIX });
        if (!p.datos) p.datos = {};
        p.datos.autorizado_sin_contrato = !!checked;
        if (checked) p.datos.autorizado_por = (res && res.autorizado_por) || p.datos.autorizado_por; else delete p.datos.autorizado_por;
        return true;
    } catch (e) {
        alert(CrmCommercial.errorMessage(e));
        return false;
    } finally {
        hideLoading();
    }
}

window.toggleManagerApproval = async function (checked) {
    if (await applyNoContractAuthorization(checked)) openDetail(currentProspectId);
    else { const p = prospects.find(x => x.id === currentProspectId); if (p) openDetail(p.id); }
};

window.toggleManagerApprovalInForm = async function (checked) {
    if (await applyNoContractAuthorization(checked)) { openDetail(currentProspectId); showAdvanceForm(); }
    else { const p = prospects.find(x => x.id === currentProspectId); if (p) { openDetail(p.id); showAdvanceForm(); } }
};

// Request / resolve flow for the exception (state kept on the opportunity: `solicitudes_sin_contrato`). Everything here is only the
// presentation and the call: who asks / resolves, the dates and the authorization fields are set by the server from the session, and
// the server refuses a manager's own request being resolved by him, a repeated approval and any non-manager resolution.
const escapeHtmlText = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function noContractRequestsOf(p) { return Array.isArray(p && p.solicitudes_sin_contrato) ? p.solicitudes_sin_contrato.filter(Boolean) : []; }
function renderNoContractRequestHTML(p) {
    const reqs = noContractRequestsOf(p);
    const pending = reqs.find(r => r.estado === 'pendiente');
    const last = reqs.length ? reqs[reqs.length - 1] : null;
    const isManager = !!currentUser && currentUser.role === 'manager';
    const canAsk = !!currentUser && (currentUser.role === 'vendedor' || currentUser.role === 'gestor');
    let html = '<div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px; font-size: 0.8rem; color: var(--text-secondary);">';
    if (pending) {
        html += `<div>\u23F3 <strong>Solicitud de autorización sin contrato pendiente</strong> de ${escapeHtmlText(pending.solicitante_nombre || pending.solicitante_id)} (${formatDate(pending.fecha_solicitud)}).<br>Motivo: ${escapeHtmlText(pending.motivo)}</div>`;
        if (isManager) {
            html += `<div style="margin-top:6px;"><button type="button" class="btn-primary" style="padding:4px 8px; font-size:0.75rem;" onclick="resolveNoContractRequest('${escapeHtmlText(pending.id)}','approve')">Aprobar</button> <button type="button" class="btn-danger" style="padding:4px 8px; font-size:0.75rem; margin-left:4px;" onclick="resolveNoContractRequest('${escapeHtmlText(pending.id)}','reject')">Rechazar</button></div>`;
        }
    } else {
        if (last && last.estado === 'rechazada') {
            html += `<div style="color: var(--danger);">\u274C Última solicitud rechazada por ${escapeHtmlText(last.resuelto_por || 'el gerente')} (${formatDate(last.fecha_resolucion)}). Motivo: ${escapeHtmlText(last.motivo_decision)}</div>`;
        }
        if (canAsk) {
            html += `<div style="margin-top:6px;">Esta autorización solo la concede un gerente desde su propia sesión. Puedes pedírsela con el motivo:<br><button type="button" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem; margin-top:4px;" onclick="requestNoContractAuthorization()">Solicitar autorización sin contrato</button></div>`;
        } else if (!isManager) {
            html += '<div>La autorización sin contrato solo puede otorgarla un gerente desde su propia sesión.</div>';
        }
    }
    return html + '</div>';
}

window.requestNoContractAuthorization = async function () {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const motivo = String(prompt('Indica el motivo por el que esta venta debe cerrarse sin contrato (se enviará al gerente):') || '').trim();
    if (!motivo) return alert('La solicitud requiere un motivo. No se envió nada.');
    const res = await runWorkflowOp('Enviando solicitud...', fb => CrmCommercial.requestNoContractAuthorization(fb, { prospectId: p.id, motivo, dbSuffix: DB_SUFFIX }));
    if (!res) return;
    alert(res.status === 'unchanged' ? 'La solicitud ya estaba registrada y sigue pendiente.' : 'Solicitud enviada al gerente.');
    openDetail(p.id);
};

window.resolveNoContractRequest = async function (requestId, decision) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || (decision !== 'approve' && decision !== 'reject')) return;
    let motivoDecision = '';
    if (decision === 'reject') {
        motivoDecision = String(prompt('Indica el motivo del rechazo (obligatorio):') || '').trim();
        if (!motivoDecision) return alert('El rechazo requiere un motivo. No se resolvió la solicitud.');
    } else {
        if (!confirm('¿Aprobar el cierre de esta venta sin contrato?')) return;
        motivoDecision = String(prompt('Comentario de la aprobación (opcional):') || '').trim();
    }
    const res = await runWorkflowOp('Resolviendo solicitud...', fb => CrmCommercial.resolveNoContractAuthorization(fb, { prospectId: p.id, requestId, decision, motivoDecision, dbSuffix: DB_SUFFIX }));
    if (!res) return;
    openDetail(p.id);
};

// REMOVED (window.applyManagerBypass): it let a non-manager type a manager's password, compared it in the browser against the plaintext
// `password` field that every client downloads, and then rewrote the whole opportunity with `autorizado_sin_contrato`. The exception for
// large installation projects is now granted only by a manager from his OWN Firebase session: directly (applyNoContractAuthorization ->
// setNoContractAuthorizationAdmin) or by approving a seller's request (requestNoContractAuthorizationAdmin ->
// resolveNoContractAuthorizationAdmin). Both check the manager LIVE on the server, store the author and write the audit.

function renderLogs(p) {
    const cont = document.getElementById('logs-container');
    if (!cont) return;
    cont.innerHTML = '';
    if (!p || !p.logs || !Array.isArray(p.logs)) return;

    // Clonamos el array para no mutarlo al hacer reverse
    const safeLogs = JSON.parse(JSON.stringify(p.logs));
    const origLen = p.logs.length;
    safeLogs.reverse().forEach((l, i) => {
        const realIdx = origLen - 1 - i;

        let deleteBtn = '';
        if (l.auto !== true && l.auto !== 'true') {
            deleteBtn = `<span class="cursor-pointer" style="margin-left:10px; font-size:0.75rem; color:var(--danger); font-weight:bold; text-decoration:underline;" onclick="deleteLog('${p.id}', ${realIdx})">[X Eliminar]</span>`;
        }

        cont.innerHTML += `<div class="log-item ${l.auto ? 'auto' : ''}">
            <span class="date">${formatDate(l.date)}</span>${l.text}
            ${deleteBtn}
        </div>`;
    });
}

function deleteLog(prospectId, idx) {
    if (!confirm('¿Estás seguro de eliminar esta nota?')) return;
    let pObj = prospects.find(x => x.id === prospectId);
    if (!pObj || !pObj.logs) return;
    const entry = pObj.logs[idx];
    if (!entry) return;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    // The server identifies the note by date + text (not by array position, which can be stale) and authorizes the author/role.
    CrmCommercial.deleteLog(fb, { prospectId, date: entry.date, text: entry.text, dbSuffix: DB_SUFFIX }).then(res => {
        if (res && (res.status === 'deleted' || res.status === 'absent')) {
            const at = pObj.logs.findIndex(l => l && l.date === entry.date && l.text === entry.text);
            if (at !== -1) pObj.logs.splice(at, 1);
        }
        renderLogs(pObj);
    }).catch(err => alert(CrmCommercial.errorMessage(err)));
}

function addLogToProspect(p, text, isAuto = false) {
    if (!p.logs || !Array.isArray(p.logs)) p.logs = [];
    const author = currentUser ? currentUser.nombre : 'Sistema';
    p.logs.push({ text: `${isAuto ? '' : '(' + author + ') '} ${text}`, date: new Date().toISOString(), auto: isAuto });
}

function addLog() {
    const textEl = document.getElementById('new-log-text'); const text = textEl.value.trim(); if (!text) return;
    const btnEl = textEl.nextElementSibling;

    let pObj = prospects.find(x => x.id === currentProspectId);
    if (!pObj) return;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }
    if (btnEl) btnEl.disabled = true;

    // The author comes from the Firebase session on the server; a retry after an uncertain failure reuses the same opId.
    CrmCommercial.addLog(fb, { prospectId: pObj.id, text, dbSuffix: DB_SUFFIX }).then(res => {
        if (res && res.entry) {
            if (!Array.isArray(pObj.logs)) pObj.logs = [];
            pObj.logs.push(res.entry);
        }
        textEl.value = '';
        renderLogs(pObj);
    }).catch(err => {
        alert(CrmCommercial.errorMessage(err));
        console.error(err);
    }).finally(() => { if (btnEl) btnEl.disabled = false; });
}


function showNewProposalForm() {
    const p = prospects.find(x => x.id === currentProspectId);
    const container = document.getElementById('advance-form-container');

    window.stagedFiles = { 'prop-file': [], 'prop-file2': [] };

    let formHTML = `<h4><span style="color:var(--success)">Registrar Nueva Propuesta</span></h4>
        <div class="form-grid mt-2">
            <div class="form-group"><label>Nuevo Costo (Subtotal)</label><input type="number" id="prop-costo" value="${p.costo_venta || ''}" required></div>
            <div class="form-group"><label>Nuevo Precio (Subtotal)</label><input type="number" id="prop-precio" value="${p.precio_cotizado || ''}" required></div>
            <div class="form-group full-width">
                <label>Nueva Oferta (PDF/Word)</label>
                <input type="file" id="prop-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="prop-file-list" style="margin-top: 8px;"></div>
            </div>
            <div class="form-group full-width">
                <label>Nuevo Cuadro de Costos (PDF/Excel)</label>
                <input type="file" id="prop-file2" multiple onchange="updateSelectedFilesList(this)">
                <div id="prop-file2-list" style="margin-top: 8px;"></div>
            </div>
        </div>
        <button class="btn-success mt-2" onclick="processNewProposal()">Guardar Propuesta</button>
        <button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
    `;
    container.innerHTML = formHTML;
    renderStagedFiles('prop-file');
    renderStagedFiles('prop-file2');
}

async function processNewProposal() {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const c = parseFloat(document.getElementById('prop-costo').value);
    const pr = parseFloat(document.getElementById('prop-precio').value);
    if (isNaN(c) || isNaN(pr)) return alert("Completa costos y precios.");

    const files1 = window.stagedFiles && window.stagedFiles['prop-file'] ? window.stagedFiles['prop-file'] : [];
    const files2 = window.stagedFiles && window.stagedFiles['prop-file2'] ? window.stagedFiles['prop-file2'] : [];
    if (files1.length === 0 || files2.length === 0) return alert("Debe subir la nueva oferta y el cuadro de costos.");

    // registerProposalAdmin: only in an active opportunity in negotiation; price, cost, documents, history and audit are written together.
    const res = await runWorkflowOp('Subiendo nueva propuesta...', async fb => {
        const [docOferta, docCostos] = await Promise.all([
            Promise.all(files1.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id }))),
            Promise.all(files2.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })))
        ]);
        return CrmCommercial.registerProposal(fb, { prospectId: p.id, costo_venta: c, precio_cotizado: pr, doc_oferta: docOferta, doc_costos: docCostos, dbSuffix: DB_SUFFIX });
    });
    if (res) openDetail(p.id);
}

// Google Maps auto-script removed per user request

function toggleContractRequirement(checked) {
    const contractSec = document.getElementById('contract-fields-container');
    const noContractSec = document.getElementById('no-contract-fields-container');
    const file1Contract = document.getElementById('adv-file1-contract');
    const file1NoContract = document.getElementById('adv-file1-nocontract');
    const companyDocsWarning = document.getElementById('company-docs-warning');
    const companyDocsSuccess = document.getElementById('company-docs-success');

    if (checked) {
        if (contractSec) contractSec.style.display = 'none';
        if (noContractSec) noContractSec.style.display = 'block';
        if (file1Contract) file1Contract.required = false;
        if (file1NoContract) file1NoContract.required = true;
        if (companyDocsWarning) companyDocsWarning.style.display = 'none';
        if (companyDocsSuccess) companyDocsSuccess.style.display = 'none';
    } else {
        if (contractSec) contractSec.style.display = 'block';
        if (noContractSec) noContractSec.style.display = 'none';
        if (file1Contract) file1Contract.required = true;
        if (file1NoContract) file1NoContract.required = false;
        if (companyDocsWarning) companyDocsWarning.style.display = 'block';
        if (companyDocsSuccess) companyDocsSuccess.style.display = 'block';
    }
}

function showAdvanceForm() {
    const p = prospects.find(x => x.id === currentProspectId); const container = document.getElementById('advance-form-container');
    const currentIndex = STAGES.indexOf(p.etapa); if (currentIndex >= STAGES.length - 1) return; const nextStage = STAGES[currentIndex + 1];

    if (nextStage === 'cierre') {
        const c = clients.find(x => x.id === p.clientId);
        let missing = [];
        if (c.tipo === 'natural') {
            if (!c.nombres) missing.push("Nombres");
            if (!c.apellidos) missing.push("Apellidos");
            if (!c.dui) missing.push("DUI");
            if (!c.nit) missing.push("NIT");
        } else {
            if (!c.empresa) missing.push("Nombre de la Empresa");
            if (!c.contacto) missing.push("Contacto Principal");
            if (!c.nit) missing.push("NIT");
            if (!c.nrc) missing.push("NRC");
        }
        if (!c.telefono) missing.push("Teléfono");
        if (!c.correo) missing.push("Correo Electrónico");
        if (!c.correo_fact) missing.push("Correo para Facturación");

        if (missing.length > 0) {
            container.innerHTML = `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); padding: 1.5rem; border-radius: 6px; margin-top: 1rem;">
                <h4 style="color:var(--danger)">⚠️ Información de Cliente Incompleta</h4>
                <p style="font-size: 0.9rem; margin-top: 0.5rem; color: var(--text-primary);">Para poder cerrar formalmente la oportunidad y generar el proyecto, el cliente debe tener su expediente completo (para propósitos de facturación y cobro). Faltan los siguientes campos:</p>
                <ul style="margin-left: 1.5rem; margin-top: 0.5rem; margin-bottom: 1rem; font-size: 0.85rem; color: var(--brand-gold);">
                    ${missing.map(m => `<li>${m}</li>`).join('')}
                </ul>
                <button class="btn-primary" onclick="openClientModal('${c.id}')">Completar Datos del Cliente</button>
                <button class="btn-secondary ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
            </div>`;
            return;
        }
    }

    let formHTML = `<h4>Avanzar a: <span style="text-transform:capitalize; color:var(--brand-gold)">${nextStage}</span></h4><div class="form-grid mt-2">`;

    if (nextStage === 'levantamiento') {
        let visOpts = settings.visitantes.map(v => `<option value="${v}">${v}</option>`).join('');
        if (!visOpts) visOpts = `<option value="">-- Sin configurar (Vaya a ajustes) --</option>`;

        if (p.tipo_proyecto === 'Fabricación') {
            formHTML += `<div class="form-group"><label>Vendedor que atendió</label><select id="adv-visitante" required><option value="">-- Seleccione --</option>${visOpts}</select></div>
            <div class="form-group"><label>Fecha est. inicio (Opcional)</label><input type="date" id="adv-inicio"></div>
            <div class="form-group full-width">
                <label>Documentos/Planos</label>
                <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file-list" style="margin-top: 8px;"></div>
            </div>`;
        } else {
            let mapLink = "https://maps.google.com";
            if (settings.factory_address) mapLink += `?q=${encodeURIComponent(settings.factory_address)}`;

            formHTML += `<div class="form-group full-width"><label>Ubicación del Proyecto (Opcional)</label><input type="text" id="adv-ubicacion" placeholder="Ej. Calle Principal #123"></div>
                <div class="form-group"><label>Distancia a Fábrica (km) <a href="${mapLink}" target="_blank" style="color:var(--brand-gold); font-size: 0.8rem; margin-left: 5px;">[Abrir Mapa]</a></label><input type="number" step="0.1" id="adv-distancia" required></div>
                <div class="form-group"><label>Quién visitó</label><select id="adv-visitante" required><option value="">-- Seleccione --</option>${visOpts}</select></div><div class="form-group"><label>Fecha de visita (Opcional)</label><input type="date" id="adv-fecha"></div><div class="form-group"><label>Fecha est. inicio (Opcional)</label><input type="date" id="adv-inicio"></div>
                <div class="form-group full-width">
                    <label>Notas/Planos</label>
                    <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                    <div id="adv-file-list" style="margin-top: 8px;"></div>
                </div>`;
        }
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        let isNeg = nextStage === 'negociacion';
        let selAlta = p.probabilidad === 75 ? 'selected' : ''; let selMedia = p.probabilidad === 50 ? 'selected' : ''; let selBaja = p.probabilidad === 25 ? 'selected' : ''; let selImprobable = p.probabilidad === 10 ? 'selected' : '';
        formHTML += `<div class="form-group"><label>Costo de Venta (Subtotal)</label><input type="number" id="adv-costo" value="${p.costo_venta || ''}" required></div>
            <div class="form-group"><label>Precio Cotizado (Subtotal)</label><input type="number" id="adv-precio" value="${p.precio_cotizado || ''}" required></div>
            <div class="form-group"><label>Probabilidad</label><select id="adv-prob" required>
                    <option value="alta" ${selAlta}>Alta (75%)</option><option value="media" ${selMedia}>Media (50%)</option><option value="baja" ${selBaja}>Baja (25%)</option><option value="improbable" ${selImprobable}>Improbable (10%)</option>
                </select></div>
            <div class="form-group full-width">
                <label>Oferta (PDF/Word)</label>
                <input type="file" id="adv-file" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file-list" style="margin-top: 8px;"></div>
            </div>
            <div class="form-group full-width">
                <label>Cuadro de Costos (PDF/Excel)</label>
                <input type="file" id="adv-file2" multiple onchange="updateSelectedFilesList(this)">
                <div id="adv-file2-list" style="margin-top: 8px;"></div>
            </div>`;
    } else if (nextStage === 'cierre') {
        const c = clients.find(x => x.id === p.clientId);
        if (!c.documentos) c.documentos = {};

        const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));

        let encOpts = settings.encargados.map(e => `<option value="${e}">${e}</option>`).join('');
        if (!encOpts) encOpts = `<option value="">-- Sin encargados (Configure en ajustes) --</option>`;

        formHTML += `<div class="form-group full-width" style="border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem; margin-bottom: 0.5rem;"><strong>Configuración de Proyecto</strong></div>`;
        formHTML += `<div class="form-group"><label>Forma de Pago Pactada</label>
                <select id="adv-forma-pago" required><option value="100% anticipado">100% Anticipado</option><option value="70/30">70% Anticipo / 30% Cierre</option><option value="50/50">50% Anticipo / 50% Cierre</option></select></div>`;
        formHTML += `<div class="form-group"><label>Número Factura de Anticipo</label><input type="text" id="adv-fac-anticipo" required placeholder="Ej. FCF-001"></div>`;
        if (p.tipo_proyecto === 'Fabricación e instalación') { formHTML += `<div class="form-group"><label>Encargado de Instalación</label><select id="adv-encargado" required><option value="">-- Seleccione --</option>${encOpts}</select></div>`; }

        formHTML += `<div class="form-group full-width" style="border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem; margin-top: 1rem; margin-bottom: 0.5rem; color:var(--brand-gold);"><strong>Documentación Requerida para Cierre</strong></div>`;

        // DUI (from legal representative or individual customer) is ALWAYS mandatory at closure
        if (!c.documentos.dui) {
            formHTML += `<div class="form-group full-width" style="color:var(--danger); font-size:0.9rem; font-weight:bold; border: 1px solid var(--danger); padding: 0.5rem; border-radius: 4px; background: rgba(239, 68, 68, 0.1);">❌ Obligatorio: Falta el DUI (del representante o cliente) en el Directorio de Clientes. Ve al Directorio, edita el cliente y sube el documento antes de poder cerrar este proyecto.</div>`;
        }

        if (isBigInstalacion) {
            const isAuthorized = p.datos && p.datos.autorizado_sin_contrato === true;
            if (isAuthorized) {
                formHTML += `<div class="form-group full-width" style="background: rgba(46, 204, 113, 0.1); border: 1px solid var(--success); padding: 0.75rem; border-radius: 6px; margin-bottom: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: bold; color: var(--success);">
                        <span>\u2714 Cierre Sin Contrato Autorizado</span>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; margin-bottom: 4px;">
                        Esta venta ha sido autorizada sin contrato por el gerente: <strong>${p.datos.autorizado_por || 'Gerencia'}</strong>.
                    </p>`;
                if (currentUser && currentUser.role === 'manager') {
                    formHTML += `<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--brand-gold); font-weight: bold; margin-top: 4px;">
                        <input type="checkbox" id="adv-auth-no-contract-checkbox" checked onchange="toggleManagerApprovalInForm(this.checked)">
                        <span>Revocar Autorización (Modo Gerente)</span>
                    </label>`;
                }
                formHTML += `<input type="checkbox" id="adv-auth-no-contract" checked style="display: none;">
                </div>`;
            } else {
                formHTML += `<div class="form-group full-width" style="background: rgba(212, 175, 55, 0.1); border: 1px solid var(--brand-gold); padding: 0.75rem; border-radius: 6px; margin-bottom: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: bold; color: var(--brand-gold);">
                        <span>\u26A0 Requiere Contrato</span>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; margin-bottom: 8px;">
                        Esta venta supera los $10k e instalación, por lo que requiere un contrato y documentos de la empresa. Si el Gerente aprueba exceptuar el contrato, puede autorizarlo marcándolo desde su propia sesión (en el panel lateral o en este formulario).
                    </p>`;

                if (currentUser && currentUser.role === 'manager') {
                    formHTML += `<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--brand-gold); font-weight: bold; margin-top: 4px;">
                        <input type="checkbox" id="adv-auth-no-contract-checkbox" onchange="toggleManagerApprovalInForm(this.checked)">
                        <span>Autorizar sin Contrato (Modo Gerente)</span>
                    </label>`;
                }
                // No password is typed or compared here: the exception is granted only by a manager from his own session, either directly
                // or by approving the seller's request (requestNoContractAuthorizationAdmin / resolveNoContractAuthorizationAdmin).
                formHTML += renderNoContractRequestHTML(p);
                formHTML += `<input type="checkbox" id="adv-auth-no-contract" style="display: none;">
                </div>`;
            }

            // Contract fields
            formHTML += `<div id="contract-fields-container" style="width: 100%; display: ${isAuthorized ? 'none' : 'contents'};">`;
            formHTML += `<div class="form-group full-width"><button type="button" class="btn-primary" onclick="generarContrato('${p.id}')">📄 Generar Contrato (Imprimible)</button><p style="font-size:0.75rem; color:var(--text-secondary); margin-top:4px;">Haz clic aquí para imprimir el contrato ya rellenado. Luego, escanéalo firmado y súbelo a continuación.</p></div>`;
            formHTML += `<div class="form-group full-width"><label>Contrato Firmado (Proyecto > $10k)</label><input type="file" id="adv-file1-contract" ${isAuthorized ? '' : 'required'}></div>`;
            formHTML += `</div>`; // end contract-fields-container

            // Validate company documents (excluding DUI since it is validated above)
            if (c.tipo === 'juridica') {
                const hasCompanyDocs = c.documentos.escritura && c.documentos.credencial && c.documentos.nit && c.documentos.nrc;
                formHTML += `<div id="company-docs-warning" class="form-group full-width" style="color:var(--danger); font-size:0.9rem; font-weight:bold; border: 1px solid var(--danger); padding: 0.5rem; border-radius: 4px; background: rgba(239, 68, 68, 0.1); display: ${(!hasCompanyDocs && !isAuthorized) ? 'block' : 'none'};">❌ Obligatorio: Faltan documentos corporativos de la Empresa en el Directorio de Clientes (Escritura, Credencial, NIT, NRC). Ve al Directorio, edita el cliente y súbelos antes de poder cerrar este proyecto.</div>`;
                formHTML += `<div id="company-docs-success" class="form-group full-width" style="color:var(--success); font-size:0.9rem; display: ${(hasCompanyDocs && !isAuthorized) ? 'block' : 'none'};">✔️ Documentación legal corporativa ya registrada en el directorio.</div>`;
            }

            // No contract fields
            formHTML += `<div id="no-contract-fields-container" style="width: 100%; display: ${isAuthorized ? 'block' : 'none'};">`;
            formHTML += `<div class="form-group full-width"><label>Oferta Firmada por Cliente</label><input type="file" id="adv-file1-nocontract" ${isAuthorized ? 'required' : ''}></div>`;
            formHTML += `</div>`; // end no-contract-fields-container
        } else {
            formHTML += `<div class="form-group full-width"><label>Oferta Firmada por Cliente</label><input type="file" id="adv-file1" required></div>`;
        }
        formHTML += `<div class="form-group full-width"><label>Copia de Factura / C.F. Emitida</label><input type="file" id="adv-file2" required></div>`;
    }
    formHTML += `</div><button type="button" class="btn-primary mt-2" onclick="processAdvance('${nextStage}')">Confirmar Avance</button><button type="button" class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>`;

    window.stagedFiles = { 'adv-file': [], 'adv-file2': [] };

    container.innerHTML = formHTML;

    if (document.getElementById('adv-file-list')) renderStagedFiles('adv-file');
    if (document.getElementById('adv-file2-list')) renderStagedFiles('adv-file2');
}

// Stage transitions are decided by advanceProspectStageAdmin: it reads the CURRENT document, enforces the order of the stages and the
// closing requirements, computes the advance invoice (VAT / export, payment form) and writes the history, the timestamps and the audit
// record. This function only collects what the user typed and the file references returned by the uploads; the checks below are
// a courtesy (fast feedback), not the rule. There is no fallback write.
async function processAdvance(nextStage) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const data = {};

    if (nextStage === 'levantamiento') {
        const dI = document.getElementById('adv-inicio').value;
        const v = document.getElementById('adv-visitante').value.trim();

        if (p.tipo_proyecto !== 'Fabricación') {
            const elF = document.getElementById('adv-fecha');
            const elU = document.getElementById('adv-ubicacion');
            const elDist = document.getElementById('adv-distancia');
            const dist = elDist ? elDist.value : "";
            if (!dist) return alert("Completa la distancia a la fábrica.");
            data.fecha_visita = elF ? elF.value : "";
            data.ubicacion = elU ? elU.value.trim() : "";
            data.distancia = parseFloat(dist);
        }

        if (!v) return alert("Completa el vendedor/visitante.");
        data.visitante = v; data.fecha_inicio = dI;

        const files = window.stagedFiles && window.stagedFiles['adv-file'] ? window.stagedFiles['adv-file'] : [];
        const ok = await runWorkflowOp('Subiendo documentos de levantamiento...', async fb => {
            if (files.length > 0) data.doc_levantamiento = await Promise.all(files.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: DB_SUFFIX });
        });
        if (!ok) return;
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        const c = parseFloat(document.getElementById('adv-costo').value); const pr = parseFloat(document.getElementById('adv-precio').value); const prob = document.getElementById('adv-prob').value;
        if (isNaN(c) || isNaN(pr) || !prob) return alert("Completa costos, precios y probabilidad.");

        const files1 = window.stagedFiles && window.stagedFiles['adv-file'] ? window.stagedFiles['adv-file'] : [];
        const files2 = window.stagedFiles && window.stagedFiles['adv-file2'] ? window.stagedFiles['adv-file2'] : [];
        const hasOferta = (files1.length > 0) || (p.datos && p.datos.doc_oferta);
        const hasCostos = (files2.length > 0) || (p.datos && p.datos.doc_costos);
        if (!hasOferta || !hasCostos) {
            return alert("Es obligatorio adjuntar tanto la Oferta como el Cuadro de Costos.");
        }

        data.costo_venta = c; data.precio_cotizado = pr; data.probabilidad = prob;
        const ok = await runWorkflowOp('Subiendo cotizaciones y costos...', async fb => {
            if (files1.length > 0) data.doc_oferta = await Promise.all(files1.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            if (files2.length > 0) data.doc_costos = await Promise.all(files2.map(file => uploadFileToStorage(file, 'proyectos', { prospectId: p.id })));
            return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: DB_SUFFIX });
        });
        if (!ok) return;
    } else if (nextStage === 'cierre') {
        const fp = document.getElementById('adv-forma-pago').value; if (!fp) return alert("Selecciona la forma de pago.");
        const facNum = document.getElementById('adv-fac-anticipo').value.trim(); if (!facNum) return alert("Ingresa el número de factura de anticipo.");
        data.forma_pago = fp; data.factura_anticipo = facNum;
        if (p.tipo_proyecto === 'Fabricación e instalación') { const enc = document.getElementById('adv-encargado').value.trim(); if (!enc) return alert("Debe asignar un Encargado de Instalación."); data.encargado = enc; }

        const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (Math.max(parseFloat(p.precio_cotizado) || 0, parseFloat(p.costo_venta) || 0) > 10000));
        // Only reflects the manager's STORED authorization (the checkbox is rendered from it); the server decides from the stored value too.
        const authNoContractEl = document.getElementById('adv-auth-no-contract');
        const bypassContract = authNoContractEl ? authNoContractEl.checked : false;

        const c = clients.find(x => x.id === p.clientId);
        if (!c) return alert("No se encontró el cliente de esta oportunidad.");
        if (!c.documentos) c.documentos = {};

        // DUI is always mandatory for all closing transactions
        if (!c.documentos.dui) {
            return alert("❌ OBLIGATORIO: Falta el DUI (del representante o cliente) en el Directorio de Clientes. Ve al Directorio, edita el cliente y sube el documento antes de poder cerrar este proyecto.");
        }

        if (isBigInstalacion && !bypassContract) {
            if (c.tipo === 'juridica') {
                if (!c.documentos.escritura || !c.documentos.credencial || !c.documentos.nit || !c.documentos.nrc) {
                    return alert("❌ OBLIGATORIO: Para cerrar este proyecto con contrato, primero debes ir al Directorio de Clientes y adjuntar todos los documentos legales de la Empresa (Escritura, Credencial, NIT, NRC).");
                }
            }
        }

        let f1;
        if (isBigInstalacion) {
            f1 = bypassContract ? document.getElementById('adv-file1-nocontract') : document.getElementById('adv-file1-contract');
        } else {
            f1 = document.getElementById('adv-file1');
        }

        if (!f1 || f1.files.length === 0) return alert("Es obligatorio subir el Contrato o la Oferta firmada.");

        const f2 = document.getElementById('adv-file2');
        if (!f2 || f2.files.length === 0) return alert("Es obligatorio subir la Factura o Comprobante de anticipo.");

        const ok = await runWorkflowOp('Generando cierre y subiendo documentos finales...', async fb => {
            const [docFirmado, docComprobante] = await Promise.all([
                uploadFileToStorage(f1.files[0], 'proyectos', { prospectId: p.id }),
                uploadFileToStorage(f2.files[0], 'facturas', { prospectId: p.id })
            ]);
            data.doc_firmado = docFirmado; data.doc_comprobante = docComprobante;
            return CrmCommercial.advanceStage(fb, { prospectId: p.id, nextStage, data, dbSuffix: DB_SUFFIX });
        });
        if (!ok) return;
    }

    document.getElementById('advance-form-container').innerHTML = ''; openDetail(p.id);
}

function showLoseForm() {
    let opts = MOTIVOS_PERDIDA.map(m => `<option value="${m}">${m}</option>`).join('');
    document.getElementById('advance-form-container').innerHTML = `<div class="form-group mt-4"><label style="color:var(--danger)">Motivo de pérdida</label><select id="lose-reason" required><option value="">-- Selecciona --</option>${opts}</select><button class="btn-danger mt-2" onclick="processLose()">Confirmar Pérdida</button><button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button></div>`;
}
async function processLose() {
    const reason = document.getElementById('lose-reason').value; if (!reason) return alert("Debes seleccionar un motivo.");
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    // markProspectLostAdmin validates the reason and that the opportunity is still active, and writes history and audit.
    const res = await runWorkflowOp('Registrando pérdida...', fb => CrmCommercial.markLost(fb, { prospectId: p.id, reason, dbSuffix: DB_SUFFIX }));
    if (!res) return;
    document.getElementById('advance-form-container').innerHTML = ''; openDetail(p.id);
}

// ========================
// DASHBOARD
// ========================

function populateTimeFilter() {
    const select = document.getElementById('dash-time-filter');
    const currentVal = select ? select.value : 'all';
    if (!select) return;

    select.innerHTML = '<option value="all">Histórico Completo</option>';

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    select.innerHTML += `<option value="year_${currentYear}">YTD (Año en curso)</option>`;

    for (let i = 0; i <= currentMonth; i++) {
        select.innerHTML += `<option value="${currentYear}-${i}">${MESES[i]} ${currentYear}</option>`;
    }

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
    } else {
        select.value = 'all';
    }
}
function getFilteredProspects() {
    const filter = document.getElementById('dash-time-filter').value || 'all';
    return prospects.filter(p => {
        if (filter === 'all') return true;
        let refDateStr = p.estado === 'ganado' ? (p.fecha_cierre || p.fecha_creacion) : (p.estado === 'perdido' ? (p.fecha_perdida || p.fecha_creacion) : p.fecha_creacion);
        if (!refDateStr) return false;
        let d = new Date(refDateStr); let y = d.getFullYear(); let m = d.getMonth();
        if (filter.startsWith('year_')) return y === parseInt(filter.split('_')[1]);
        if (filter.includes('-')) { const [fy, fm] = filter.split('-'); return y === parseInt(fy) && m === parseInt(fm); }
        return true;
    });
}
function renderDashboard() {
    const filtered = getFilteredProspects(); let ganadoPrecio = 0, ganadoCosto = 0, perdidoPrecio = 0, pipePrecio = 0, pipeCosto = 0;
    let globalFacturado = 0, globalCobrado = 0;

    filtered.forEach(p => {
        // Margins always based on Subtotal (precio_cotizado) to exclude IVA
        if (p.estado === 'ganado') {
            ganadoPrecio += (p.precio_cotizado || 0); ganadoCosto += (p.costo_venta || 0);
            if (p.facturas) {
                p.facturas.forEach(f => {
                    globalFacturado += f.monto;
                    if (f.pagos) globalCobrado += f.pagos.reduce((a, b) => a + parseFloat(b.monto), 0);
                });
            }
        }
        else if (p.estado === 'perdido') { perdidoPrecio += (p.precio_cotizado || 0); }
        else if (p.estado === 'activo' && p.precio_cotizado && p.probabilidad) {
            let prPct = p.probabilidad / 100; pipePrecio += (p.precio_cotizado * prPct);
            if (p.costo_venta) pipeCosto += (p.costo_venta * prPct);
        }
    });

    let margenGanado = ganadoPrecio - ganadoCosto; let margenGanadoPct = ganadoPrecio > 0 ? (margenGanado / ganadoPrecio) * 100 : 0;
    let margenPipe = pipePrecio - pipeCosto; let margenPipePct = pipePrecio > 0 ? (margenPipe / pipePrecio) * 100 : 0;

    document.getElementById('metric-ganadas').textContent = formatCurrency(ganadoPrecio);
    document.getElementById('metric-perdidas').textContent = formatCurrency(perdidoPrecio);
    document.getElementById('metric-margen').textContent = formatCurrency(margenGanado);
    document.getElementById('metric-margen-pct').textContent = margenGanadoPct.toFixed(1) + '%';
    document.getElementById('metric-pipeline-ponderado').textContent = formatCurrency(pipePrecio);
    document.getElementById('metric-pipeline-margen').textContent = formatCurrency(margenPipe);
    document.getElementById('metric-pipeline-margen-pct').textContent = margenPipePct.toFixed(1) + '%';

    document.getElementById('metric-total-facturado').textContent = formatCurrency(globalFacturado);
    document.getElementById('metric-total-cobrado').textContent = formatCurrency(globalCobrado);
    document.getElementById('metric-total-cxc').textContent = formatCurrency(globalFacturado - globalCobrado);

    let pctCobrado = globalFacturado > 0 ? (globalCobrado / globalFacturado) * 100 : 0;

    document.getElementById('cxc-bar-cobrado').style.width = pctCobrado + '%';

    renderCharts(filtered); renderDashboardKpiTimes(filtered); renderDashboardActiveTimes(filtered);

    if (currentUser && currentUser.role === 'manager') {
        fetchAuditLogs();
    }
}

function fetchAuditLogs() {
    document.getElementById('audit-panel').style.display = 'block';
    const container = document.getElementById('audit-logs-container');
    container.innerHTML = '<em>Cargando auditoría...</em>';

    if (window.auditUnsubscribe) window.auditUnsubscribe();

    window.auditUnsubscribe = db.collection(`audit_logs${DB_SUFFIX}`).orderBy('timestamp', 'desc').limit(20).onSnapshot(snap => {
        container.innerHTML = '';
        if (snap.empty) {
            container.innerHTML = '<span style="color:var(--text-muted)">No hay alertas recientes de eliminación.</span>';
            return;
        }
        snap.forEach(doc => {
            const data = doc.data();
            container.innerHTML += `
                <div style="background: rgba(239, 68, 68, 0.1); border-left: 2px solid var(--danger); padding: 8px;">
                    <strong>${formatDate(data.fecha)}</strong> - <strong>${data.usuario}</strong> eliminó <strong>${data.item}</strong> 
                    (${data.detalle}) en el proyecto <span style="color:var(--brand-gold)">${data.proyectoNombre}</span>.
                </div>
            `;
        });
    });
}

function renderDashboardKpiTimes(filtered) {
    const grid = document.getElementById('kpi-times-grid'); grid.innerHTML = '';

    STAGES.forEach((stage, idx) => {
        let totalDays = 0; let count = 0;
        const nextStage = STAGES[idx + 1];

        filtered.forEach(p => {
            const ts = p.stage_timestamps || {};
            if (ts[stage]) {
                let start = new Date(ts[stage]);
                let end = new Date();

                // If they moved past this stage, calculate the exact time spent in it
                if (nextStage && ts[nextStage]) {
                    end = new Date(ts[nextStage]);
                }
                // If they won/lost while in this stage
                else if (p.estado === 'ganado' && p.fecha_cierre) {
                    end = new Date(p.fecha_cierre);
                }
                else if (p.estado === 'perdido' && p.fecha_perdida) {
                    end = new Date(p.fecha_perdida);
                }

                let diff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
                if (diff < 0) diff = 0;

                totalDays += diff;
                count++;
            }
        });

        let avg = count > 0 ? (totalDays / count).toFixed(1) : 0;
        let limit = KPI_LIMITS[stage];
        let isOverLimit = avg > limit;

        grid.innerHTML += `
            <div style="background: rgba(255,255,255,0.03); border: 1px solid ${isOverLimit ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255,255,255,0.08)'}; padding: 0.5rem; border-radius: 6px; text-align: center;">
                <div style="text-transform: capitalize; font-size: 0.65rem; color: var(--text-secondary); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${stage}">${stage}</div>
                <div style="font-size: 1.1rem; font-weight: bold; color: ${isOverLimit ? 'var(--danger)' : 'var(--text-primary)'};">${avg} <span style="font-size:0.6rem; font-weight:normal; color:var(--text-secondary)">d</span></div>
            </div>
        `;
    });
}

function renderDashboardActiveTimes(filtered) {
    const tbody = document.getElementById('dash-active-times-body'); tbody.innerHTML = '';
    let active = filtered.filter(p => p.estado === 'activo');

    // Filter to ONLY those exceeding their limit
    active = active.filter(p => {
        const ts = p.stage_timestamps || {};
        const days = getDaysDifference(ts[p.etapa] || p.fecha_creacion);
        return days > KPI_LIMITS[p.etapa];
    });

    if (active.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 1rem; color: var(--text-muted);">No hay oportunidades excedidas de tiempo.</td></tr>'; return; }

    active.sort((a, b) => {
        const tsA = a.stage_timestamps || {};
        const tsB = b.stage_timestamps || {};
        return getDaysDifference(tsB[b.etapa] || b.fecha_creacion) - getDaysDifference(tsA[a.etapa] || a.fecha_creacion);
    });

    active.forEach(p => {
        const ts = p.stage_timestamps || {};
        const days = getDaysDifference(ts[p.etapa] || p.fecha_creacion);
        const limit = KPI_LIMITS[p.etapa];

        let daysColor = '';
        let alertIcon = '';

        if (days > limit) {
            daysColor = 'color: var(--danger); font-weight: bold; background: rgba(239, 68, 68, 0.1); padding: 0.2rem 0.5rem; border-radius: 4px;';
            alertIcon = '⚠️ ';
        } else if (days >= limit - 2) {
            daysColor = 'color: var(--brand-gold);';
        }

        tbody.innerHTML += `<tr><td>${p.codigo || p.id.substring(p.id.length - 4)}</td><td>${getClientName(p.clientId)}</td><td>${p.proyecto}</td><td style="text-transform: capitalize;">${p.etapa}</td><td><span style="${daysColor}">${alertIcon}${days} días</span> <small style="color:var(--text-muted); margin-left:4px;">(Max ${limit})</small></td></tr>`;
    });
}

function renderCharts(filtered) {
    Chart.defaults.color = '#a0aabf'; const gold = '#ffcc4d', blue = '#3b476e', success = '#10b981', danger = '#ef4444', accent1 = '#8b5cf6', accent2 = '#f97316';
    const active = filtered.filter(p => p.estado === 'activo');

    Chart.defaults.plugins.tooltip.callbacks.label = function (context) {
        let label = context.label || '';
        if (label) label += ': ';
        if (context.parsed !== null) {
            let total = context.dataset.data.reduce((a, b) => a + b, 0);
            let pct = total > 0 ? ((context.parsed * 100) / total).toFixed(1) + '%' : '0%';
            label += context.parsed + ' (' + pct + ')';
        }
        return label;
    };

    const funnelStages = STAGES;
    let funnelHTML = '';
    const colors = [blue, gold, success, '#f59e0b', danger];

    // Find the maximum count to make bars proportional
    let counts = funnelStages.map(s => active.filter(p => p.etapa === s).length);
    let maxCount = Math.max(...counts);
    if (maxCount === 0) maxCount = 1; // Prevent division by zero

    funnelStages.forEach((s, i) => {
        let count = counts[i];
        let amount = active.filter(p => p.etapa === s).reduce((acc, p) => acc + (p.precio_cotizado || 0), 0);

        let currentWidth = Math.max((count / maxCount) * 100, 15); // Minimum 15% width so it's always visible
        let c = colors[i % colors.length];

        funnelHTML += `
            <div style="display:flex; width: 100%; align-items:center; margin-bottom: 6px;">
                <div style="width:25%; text-align:right; padding-right:15px; font-size:0.8rem; font-weight:bold; color:var(--text-secondary); text-transform:uppercase; line-height:1.2;">
                    ${s}<br><span style="font-weight:normal; font-size:0.7rem;">${count} Op.</span>
                </div>
                <div style="width:75%; display:flex; justify-content:center;">
                    <div style="
                        width: ${currentWidth}%;
                        background-color: ${c};
                        padding: 10px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        font-size: 0.9rem;
                        font-weight: bold;
                        border-radius: 2px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                        transition: width 0.3s ease;
                    ">
                        ${amount > 0 ? formatCurrency(amount) : '-'}
                    </div>
                </div>
            </div>
        `;
    });

    const funnelContainer = document.getElementById('css-funnel-container');
    if (funnelContainer) {
        funnelContainer.innerHTML = `<div style="display:flex; flex-direction:column; align-items:center; width:100%; padding-top:20px;">${funnelHTML}</div>`;
    }
    const won = filtered.filter(p => p.estado === 'ganado');
    const sumMonto = (arr) => arr.reduce((acc, p) => acc + (parseFloat(p.precio_cotizado) || 0), 0);

    const prodW = [sumMonto(won.filter(p => p.tipo_producto === 'Chute')), sumMonto(won.filter(p => p.tipo_producto === 'Ducto'))];
    const prodWColors = [gold, blue];
    const prodWNo = sumMonto(won.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    if (prodWNo > 0) { prodW.push(prodWNo); prodWColors.push('#6b7280'); }
    if (chartProduct) chartProduct.destroy(); chartProduct = new Chart(document.getElementById('productChart').getContext('2d'), { type: 'pie', data: { labels: prodWNo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodW, backgroundColor: prodWColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });

    const projW = [sumMonto(won.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumMonto(won.filter(p => p.tipo_proyecto === 'Fabricación'))];
    const projWColors = [success, '#a0aabf'];
    const projWNo = sumMonto(won.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    if (projWNo > 0) { projW.push(projWNo); projWColors.push('#6b7280'); }
    if (chartProject) chartProject.destroy(); chartProject = new Chart(document.getElementById('projectChart').getContext('2d'), { type: 'pie', data: { labels: projWNo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projW, backgroundColor: projWColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });

    const prodA = [sumMonto(active.filter(p => p.tipo_producto === 'Chute')), sumMonto(active.filter(p => p.tipo_producto === 'Ducto'))];
    const prodANo = sumMonto(active.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    const prodAColors = [gold, blue];
    if (prodANo > 0) { prodA.push(prodANo); prodAColors.push('#6b7280'); }
    if (chartOppProduct) chartOppProduct.destroy(); chartOppProduct = new Chart(document.getElementById('oppProductChart').getContext('2d'), { type: 'pie', data: { labels: prodANo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodA, backgroundColor: prodAColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });

    const projA = [sumMonto(active.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumMonto(active.filter(p => p.tipo_proyecto === 'Fabricación'))];
    const projANo = sumMonto(active.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    const projAColors = [accent1, accent2];
    if (projANo > 0) { projA.push(projANo); projAColors.push('#6b7280'); }
    if (chartOppProject) chartOppProject.destroy(); chartOppProject = new Chart(document.getElementById('oppProjectChart').getContext('2d'), { type: 'pie', data: { labels: projANo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projA, backgroundColor: projAColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });

    // Efectividad por Canal (Stacked Volume Bar Chart)
    let originStats = {};
    filtered.forEach(p => {
        let repName = p.origen || 'Desconocido';
        if (!originStats[repName]) originStats[repName] = { ganado: 0, activo: 0, perdido: 0, total: 0 };
        originStats[repName][p.estado]++;
        originStats[repName].total++;
    });

    const repNames = Object.keys(originStats);
    const dataGanado = [];
    const dataActivo = [];
    const dataPerdido = [];

    repNames.forEach(name => {
        const stats = originStats[name];
        dataGanado.push(stats.ganado);
        dataActivo.push(stats.activo);
        dataPerdido.push(stats.perdido);
    });

    if (chartOrigin) chartOrigin.destroy();
    chartOrigin = new Chart(document.getElementById('conversionChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: repNames,
            datasets: [
                { label: 'Ganado', data: dataGanado, backgroundColor: success },
                { label: 'En Proceso', data: dataActivo, backgroundColor: gold },
                { label: 'Perdido', data: dataPerdido, backgroundColor: danger }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'x',
            scales: {
                x: { stacked: true, display: true, ticks: { font: { size: 10 } } },
                y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } }
            },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9 } } },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return context.dataset.label + ': ' + context.raw + ' Ops';
                        }
                    }
                }
            }
        }
    });

    const lost = filtered.filter(p => p.estado === 'perdido'); if (chartLoss) chartLoss.destroy(); chartLoss = new Chart(document.getElementById('lossChart').getContext('2d'), { type: 'pie', data: { labels: MOTIVOS_PERDIDA, datasets: [{ data: MOTIVOS_PERDIDA.map(m => lost.filter(p => p.motivo_perdida === m).length), backgroundColor: [danger, '#f59e0b', accent2, accent1, '#6b7280'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } } } });
}

function generarContrato(prospectId) {
    try {
        const p = prospects.find(x => x.id === prospectId);
        const c = clients.find(x => x.id === p.clientId);

        if (!p || !c) return alert("Error: Cliente o Proyecto no encontrado.");

        let missing = [];
        let clauseNosotros = "";
        let nombreContrato = "";

        if (c.tipo === 'juridica') {
            if (!c.empresa) missing.push("Nombre de Empresa");
            if (!c.rep_legal) missing.push("Nombre del Representante Legal");
            if (!c.profesion_rep) missing.push("Profesión del Representante");
            if (!c.domicilio_rep) missing.push("Domicilio del Representante");
            if (!c.dui_rep) missing.push("DUI del Representante");
            if (!c.nit_rep) missing.push("NIT del Representante");

            nombreContrato = c.empresa;
            clauseNosotros = `y por otra parte <span class="bold">${c.empresa}</span>, que para efectos de este instrumento se denominará EL CLIENTE, representada por <span class="bold">${c.rep_legal}</span>, mayor de edad, <span class="bold">${c.profesion_rep || ''}</span>, del domicilio de <span class="bold">${c.domicilio_rep || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui_rep || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit_rep || ''}</span>.`;
        } else {
            if (!c.nombres || !c.apellidos) missing.push("Nombres/Apellidos");
            if (!c.profesion) missing.push("Profesión");
            if (!c.domicilio) missing.push("Domicilio");
            if (!c.dui) missing.push("DUI");
            if (!c.nit) missing.push("NIT");

            nombreContrato = `${c.nombres || ''} ${c.apellidos || ''}`;
            clauseNosotros = `y por otra parte <span class="bold">${nombreContrato}</span>, que para efectos de este instrumento se denominará EL CLIENTE, mayor de edad, <span class="bold">${c.profesion || ''}</span>, del domicilio de <span class="bold">${c.domicilio || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit || ''}</span>.`;
        }

        if (missing.length > 0) {
            openClientModal(c.id);
            return alert("Faltan datos en el perfil del cliente para el contrato: " + missing.join(", ") + ". Complete el formulario que se acaba de abrir y vuelva a generar el contrato.");
        }

        let html = `
        <html><head><title>Contrato - ${nombreContrato}</title>
        <style>
            body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; text-align: justify; padding: 40px; max-width: 800px; margin: auto; }
            h1, h2, h3 { text-align: center; font-size: 13pt; }
            .bold { font-weight: bold; }
            @media print { body { padding: 0; } button { display: none; } }
        </style>
        </head><body>
            <h3 class="bold">CONTRATO MARCO DE PRESTACION DE SERVICIOS DE FABRICACIÓN E INSTALACIÓN DE DUCTOS</h3>
            <p><span class="bold">NOSOTROS:</span> Por una parte, DUCTSAL, Sociedad de Nacionalidad Salvadoreña, del domicilio de San Salvador, con número de identificación tributaria número 0614-270622-104-3 que para efectos de este contrato se denominará EL CONTRATISTA, representada por Denys Gustavo González Flores, mayor de edad, Ingeniero Industrial, del domicilio de San Salvador, portador de Documento Único de Identidad número 00016077-9 y Número de Identificación Tributaria 00016077-9 ${clauseNosotros}</p>
            <p>Ambas partes, actuando en el ejercicio de su capacidad legal, convienen celebrar el presente <span class="bold">CONTRATO MARCO DE PRESTACION DE SERVICIOS DE FABRICACIÓN E INSTALACIÓN DE DUCTOS</span>, el cual se regirá por las cláusulas pactos y condiciones siguientes:</p>
            
            <p><span class="bold">CLAUSULA PRIMERA DECLARACIONES:</span></p>
            <p><span class="bold">EL CONTRATISTA DECLARA:</span><br>
            a) Que es una sociedad legalmente constituida y dedicada a la fabricación e instalación de ductos metálicos de diferentes calibres y formas, incluyendo ductos rectangulares y circulares, fabricados en lámina galvanizada.<br>
            b) Que cuenta con personal técnico calificado, infraestructura y equipos necesarios para ejecutar los servicios objeto de este contrato.<br>
            c) Que sus procesos de fabricación cumplen con estándares industriales y las buenas prácticas del sector.<br>
            d) Que desea suscribir el presente contrato marco para regular la relación comercial y de servicio con EL CLIENTE.</p>
            
            <p><span class="bold">EL CLIENTE DECLARA:</span><br>
            a) Que en virtud de este contrato se obliga a contratar los servicios de fabricación e instalación de ductos metálicos para los proyectos que requiera.<br>
            b) Que cuenta con la capacidad legal, técnica y financiera necesaria para cumplir las obligaciones relativas a este contrato.<br>
            c) Que ha entregado, o entregará cuando corresponda, los planos y especificaciones necesarias en forma física o digital (archivo en AutoCAD o Revit) para la correcta fabricación e instalación de los ductos solicitados.<br>
            Ambas partes se reconocen capacidad legal suficiente para contratar y obligarse.</p>
            
            <p><span class="bold">CLAUSULA SEGUNDA OBJETO DEL CONTRATO:</span><br>
            El objeto del presente contrato es establecer las condiciones generales bajo las cuales EL CONTRATISTA se compromete a la fabricación e instalación de ductos metálicos elaborados en lámina galvanizada, así como accesorios derivados, y EL CLIENTE se obliga a recibir y pagar dichos servicios conforme a las condiciones aquí estipuladas.</p>
            <p>El alcance general de los servicios incluye:<br>
            a) La fabricación de ductos rectangulares o circulares. Fabricación con uniones tipo TDC (Transverse Duct Connector) o SyD (Slip and Drive) para ductos rectangulares.<br>
            b) Fabricación de chutes de basura, ductos de ventilación, ductos para aire acondicionado, ductos para extracción de cocinas u otros proyectos afines.<br>
            c) Instalación de la ductería fabricada, incluyendo montaje, fijación, soportes, sellado, remachado y pruebas básicas de funcionamiento.<br>
            Cada proyecto específico será formalizado mediante órdenes de trabajo u ofertas aceptadas, que formarán parte integral del presente contrato marco.</p>
            
            <p><span class="bold">CLAUSULA TERCERA ALCANCE DE LOS SERVICIOS</span><br>
            <span class="bold">A. Servicios de fabricación</span><br>
            EL CONTRATISTA fabricará ductos metálicos en lámina galvanizada conforme a los planos suministrados por EL CLIENTE y a los estándares propios del contratista. La fabricación podrá incluir elementos personalizados, transiciones, codos, bifurcaciones, tapones, rejillas y demás componentes requeridos para el funcionamiento integral del sistema.<br>
            <span class="bold">B. Servicios de instalación</span><br>
            a) EL CONTRATISTA realizará la instalación de la ductería fabricada, lo cual incluye:<br>
               a) Traslado de los ductos al sitio del proyecto, salvo que se pacte lo contrario en las órdenes de compra o anexos.<br>
            b) Montaje de ductos, soportes, colgantes y herrajes.<br>
            c) Sellado y fijación según normas técnicas aplicables.<br>
            d) Coordinación básica con otras disciplinas del proyecto cuando sea necesario.<br>
            <span class="bold">C. Exclusiones</span><br>
            A menos que se pacten expresamente, se excluyen:<br>
            a) Ingeniería, rediseño o creación de planos.<br>
            b) Trabajos de albañilería, electricidad, tabla roca u otras disciplinas ajenas al objeto del contrato.<br>
            c) Equipos mecánicos de extracción, ventiladores, motores o similares.<br>
            d) Mantenimientos posteriores, salvo contratación adicional.</p>

            <p><span class="bold">CLAUSULA CUARTA MATERIALES Y ESPECIFICACIONES TÉCNICAS</span><br>
            Los ductos serán fabricados con las siguientes características:<br>
            a) <span class="bold">Material:</span> Lámina galvanizada.<br>
            b) <span class="bold">Calibres:</span> Diferentes calibres según tamaño, flujo o requerimientos del proyecto.<br>
            c) <span class="bold">Formas:</span> Ductos rectangulares o circulares.<br>
            d) <span class="bold">Uniones para ductos rectangulares:</span><br>
            - TDC<br>
            - SyD<br>
            EL CONTRATISTA podrá proponer calibres, uniones o refuerzos distintos cuando el proyecto lo requiera técnicamente. Siempre y cuando se respete la normativa SMACNA, en caso el cliente requiera especificaciones diferentes estas deberan pactarse en documento separado.<br>
            Estas especificaciones formarán parte del Anexo Técnico del contrato o de cada orden de trabajo.</p>
            
            <p><span class="bold">CLAUSULA QUINTA OBLIGACIONES DE LAS PARTES</span><br>
            <span class="bold">Obligaciones de EL CONTRATISTA:</span> El contratista se obliga:<br>
            a) A fabricar los ductos conforme a los planos y especificaciones proporcionados por EL CLIENTE.<br>
            b) Instalar la ductería conforme a las buenas prácticas del sector.<br>
            c) Asignar personal calificado y supervisión técnica.<br>
            d) Avisar oportunamente de cualquier inconsistencia en los planos o condiciones del lugar.</p>

            <br><br><br><br>
            <table style="width:100%; text-align:center; margin-top:60px;">
                <tr>
                    <td style="width:50%;">___________________________________<br><span class="bold">DUCTSAL</span><br>EL CONTRATISTA</td>
                    <td style="width:50%;">___________________________________<br><span class="bold">${nombreContrato}</span><br>EL CLIENTE</td>
                </tr>
            </table>
        </body></html>`;

        let iframe = document.getElementById('print-iframe');
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.id = 'print-iframe';
            iframe.style.position = 'absolute';
            iframe.style.top = '-10000px';
            iframe.style.left = '-10000px';
            document.body.appendChild(iframe);
        }

        iframe.contentDocument.open();
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();

        setTimeout(() => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
        }, 500);

    } catch (e) {
        alert("Ocurrió un error al generar el contrato: " + e.message);
    }
}

// REMOVED: reportToManager wrote the manager's audit notice (audit_logs) from the browser, with the e-mail the browser claimed to be.
// The deletion callables (deleteChangeOrderAdmin / deleteInvoiceAdmin / deletePaymentAdmin / deleteProspectAdmin) write that notice on
// the server, in the same transaction as the change, with the authenticated identity.

// ========================
// EDIT & DELETE FINANCIALS
// ========================
function openEditBasePriceModal() {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    document.getElementById('eb-precio').value = p.precio_cotizado || 0;
    document.getElementById('eb-costo').value = p.costo_venta || 0;
    document.getElementById('eb-motivo').value = '';
    document.getElementById('editBasePriceModal').style.display = 'block';
}

async function processEditBasePrice(e) {
    e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const precio = parseFloat(document.getElementById('eb-precio').value);
    const costo = parseFloat(document.getElementById('eb-costo').value);
    const motivo = document.getElementById('eb-motivo').value.trim();
    if (isNaN(precio) || isNaN(costo)) return alert("Ingresa un precio y un costo válidos.");
    if (!motivo) return alert("Indica el motivo de la corrección.");

    // editProspectBasePriceAdmin: the previous values and the history entry come from the stored document, not from this copy.
    const res = await runWorkflowOp('Guardando corrección...', fb => CrmCommercial.editBasePrice(fb, { prospectId: p.id, precio, costo, motivo, dbSuffix: DB_SUFFIX }));
    if (res) closeModal('editBasePriceModal');
}

async function deleteChangeOrder(id) {
    if (!confirm("¿Estás seguro de eliminar esta orden de cambio?")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.ordenes_cambio || !p.ordenes_cambio.some(o => o.id === id)) return;
    // The server removes it by id, writes the history entry, the audit record and the manager's panel notice.
    await runWorkflowOp('Eliminando orden de cambio...', fb => CrmCommercial.deleteChangeOrder(fb, { prospectId: p.id, orderId: id, dbSuffix: DB_SUFFIX }));
}

async function deleteInvoice(id) {
    if (!confirm("¿Estás seguro de eliminar esta factura? Todo su historial de pagos se borrará también.")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const idx = p.facturas.findIndex(f => f.id === id);
    if (idx === -1) return;
    if (idx === 0) {
        alert("Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error.");
        return;
    }
    await runWorkflowOp('Eliminando factura...', fb => CrmCommercial.deleteInvoice(fb, { prospectId: p.id, invoiceId: id, dbSuffix: DB_SUFFIX }));
}

async function deletePayment(invoiceId, paymentIndex) {
    if (!confirm("¿Estás seguro de eliminar este abono?")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === invoiceId);
    if (!f || !f.pagos) return;
    const pay = f.pagos[paymentIndex];
    if (!pay) return;
    // The position is only used to find the payment the user clicked; the server addresses it by id (or fecha, for payments
    // saved before they had an id), so a stale position cannot delete a different payment.
    await runWorkflowOp('Eliminando abono...', fb => CrmCommercial.deletePayment(fb, { prospectId: p.id, invoiceId, paymentKey: pay.id || pay.fecha, dbSuffix: DB_SUFFIX }));
}

function deleteClient(id) {
    if (!currentUser || currentUser.role !== 'manager') return alert("Permiso denegado.");
    const c = clients.find(x => x.id === id);
    if (!c) return;

    const hasProjects = prospects.some(p => p.clientId === id);
    if (hasProjects) {
        return alert("⚠️ No puedes eliminar este cliente porque tiene proyectos asociados. Debes eliminar primero todos sus proyectos.");
    }

    if (!confirm(`¿Estás SEGURO de que deseas eliminar permanentemente el cliente "${c.nombres || c.empresa || id}"?\n\nEsta acción NO se puede deshacer.`)) return;
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    // deleteClientAdmin re-checks the manager role live, refuses clients with projects, frees the identifiers and writes the audit.
    CrmCommercial.deleteClient(fb, { clientId: id, dbSuffix: DB_SUFFIX })
        .then(() => alert("Cliente eliminado exitosamente."))
        .catch(err => alert(CrmCommercial.errorMessage(err)));
}

// Logical deletion (deleteProspectAdmin): the opportunity is MARKED as deleted (who / when / why) and disappears from the listings;
// its data, the files and the manufacturing project stay untouched. The reason is mandatory and is validated by the server too.
async function deleteProspect() {
    if (!currentProspectId) return;
    if (!currentUser || currentUser.role !== 'manager') return alert("Permiso denegado.");

    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;

    if (!confirm(`¿Eliminar el proyecto "${p.proyecto}"?\n\nSe marcará como eliminado y dejará de aparecer en los listados. No se borran sus datos, ni los archivos, ni el proyecto de fabricación asociado.`)) return;
    const motivo = String(prompt('Indica el motivo de la eliminación (obligatorio):') || '').trim();
    if (!motivo) return alert("La eliminación requiere un motivo. No se eliminó nada.");

    // deleteProspectAdmin re-checks the manager role live, marks the opportunity and writes the audit record and the panel
    // notice with the authenticated identity. The browser no longer deletes the document nor writes audit_logs.
    const res = await runWorkflowOp('Eliminando proyecto...', fb => CrmCommercial.deleteProspect(fb, { prospectId: p.id, motivo, dbSuffix: DB_SUFFIX }));
    if (!res) return;
    alert("Proyecto eliminado exitosamente.");
    goBackFromDetail();
}



// Compresión de imágenes en el lado del cliente (Frontend)
function compressImage(file, maxWidth, maxHeight, quality) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            resolve(file); // No es imagen, devolver el archivo original
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height *= maxWidth / width));
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width *= maxHeight / height));
                        height = maxHeight;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(blob => {
                    try {
                        if (!blob) return resolve(file);
                        const compressedFile = new File([blob], file.name, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(compressedFile);
                    } catch (err) {
                        // iOS Safari fallback: si el constructor File falla, devuelve el blob original o el archivo
                        if (blob) {
                            blob.name = file.name;
                            resolve(blob);
                        } else {
                            resolve(file);
                        }
                    }
                }, 'image/jpeg', quality);
            };
            img.onerror = () => resolve(file); // En caso de error de imagen, devolver original en vez de rechazar
        };
        reader.onerror = () => resolve(file); // En caso de error de lectura, devolver original en vez de rechazar
    });
}

// Lógica de progreso de carga global
let activeUploads = 0;
let uploadProgressMap = new Map();

function updateGlobalProgress() {
    if (activeUploads === 0) {
        document.getElementById('upload-progress-container').style.display = 'none';
        document.getElementById('upload-progress-text').style.display = 'none';
        return;
    }

    let totalBytes = 0;
    let transferredBytes = 0;

    for (let [taskId, data] of uploadProgressMap.entries()) {
        totalBytes += data.total;
        transferredBytes += data.transferred;
    }

    if (totalBytes > 0) {
        const percent = Math.min(100, Math.round((transferredBytes / totalBytes) * 100));
        document.getElementById('upload-progress-container').style.display = 'block';
        document.getElementById('upload-progress-text').style.display = 'block';
        document.getElementById('upload-progress-bar').style.width = percent + '%';
        document.getElementById('upload-progress-text').innerText = percent + '% (' + (transferredBytes / 1048576).toFixed(1) + ' MB / ' + (totalBytes / 1048576).toFixed(1) + ' MB)';
    }
}
