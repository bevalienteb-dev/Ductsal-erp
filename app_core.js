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

function hasEnteredPostclosing(p) {
    if (!p || typeof p !== 'object') return false;
    return p.postcierre_habilitado === true
        || (typeof p.fecha_cierre === 'string' && p.fecha_cierre.length > 0)
        || !!(p.stage_timestamps && p.stage_timestamps.cierre)
        || (Array.isArray(p.facturas) && p.facturas.length > 0);
}

// Variables Globales de Ordenamiento para Oportunidades, Proyectos y Clientes
let oppSortCol = ''; let oppSortDir = 'asc';
let projSortCol = ''; let projSortDir = 'asc';
let cliSortCol = ''; let cliSortDir = 'asc';

/**
 * Parsea con tolerancia cualquier representación de fecha de prospecto/oportunidad:
 * - Objeto Date nativo
 * - Timestamp de Firestore (con método .toDate() o propiedades .seconds / ._seconds)
 * - Timestamp numérico (milisegundos o segundos)
 * - String ISO o formato reconocible
 * Retorna un objeto Date válido o null si es inexistente / inválido.
 */
function parseProspectDate(raw) {
    if (!raw) return null;
    if (raw instanceof Date) {
        return isNaN(raw.getTime()) ? null : raw;
    }
    if (typeof raw === 'object') {
        if (typeof raw.toDate === 'function') {
            try {
                const d = raw.toDate();
                if (d instanceof Date && !isNaN(d.getTime())) return d;
            } catch (_) {}
        }
        if (typeof raw.seconds === 'number') {
            const d = new Date(raw.seconds * 1000);
            return isNaN(d.getTime()) ? null : d;
        }
        if (typeof raw._seconds === 'number') {
            const d = new Date(raw._seconds * 1000);
            return isNaN(d.getTime()) ? null : d;
        }
    }
    if (typeof raw === 'number') {
        const ms = raw < 1e11 ? raw * 1000 : raw;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/**
 * Formatea una fecha de ingreso canónica a DD/MM/AAAA.
 * Si el registro no tiene fecha válida, retorna '-' para representar fecha desconocida de forma coherente.
 */
function formatProspectDate(raw) {
    const d = parseProspectDate(raw);
    if (!d) return '-';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

/**
 * Limpia el filtro de rango de fechas de ingreso de oportunidades y re-renderiza la lista.
 */
function clearOppDateFilter() {
    const startEl = document.getElementById('opp-date-start');
    const endEl = document.getElementById('opp-date-end');
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    renderList();
}

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
    let name = (typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.resolveSellerName === 'function')
        ? CrmFollowUpCalc.resolveSellerName(p, users)
        : (p.vendedorName || p.createdByName || p.creado_por || p.vendedor);
    let role = p.vendedorRole || p.createdByRole || '';

    if (userId) {
        const u = Array.isArray(users) ? users.find(x => x && (x.id === userId || (x.authUid && x.authUid === userId))) : null;
        if (u) {
            if (!name || name === 'Sin Asignar') name = u.nombre;
            role = u.role || role;
        }
    }

    if (!name || name === 'Sin Asignar') {
        name = p.vendedorName || p.vendedor || 'Sin Asignar';
    }

    let roleText = '';
    if (role === 'manager') roleText = 'Gerente';
    else if (role === 'gestor') roleText = 'Gestor de Ventas';
    else if (role === 'vendedor') roleText = 'Vendedor';

    return { id: userId, name, role: roleText };
}

function reassignVendor(prospectId, directTargetId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;
    const isClosed = (typeof hasEnteredPostclosing === 'function' ? hasEnteredPostclosing(p) : (p && (p.postcierre_habilitado === true || p.etapa === 'cierre')));
    if (isClosed) {
        return alert("No se puede reasignar una oportunidad que ya completó el cierre comercial.");
    }
    if (!currentUser || currentUser.role !== 'manager') {
        return alert("Solo los Gerentes pueden reasignar oportunidades.");
    }

    const currentVendor = getProspectVendorInfo(p);
    const modalEl = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('reassignModal') : null;

    if (modalEl && !directTargetId) {
        const subTitle = document.getElementById('reassign-modal-subtitle');
        if (subTitle) subTitle.textContent = `Proyecto: ${p.proyecto || p.codigo || '-'}`;

        const currVendorEl = document.getElementById('reassign-current-vendor');
        if (currVendorEl) {
            const roleLabel = currentVendor.role ? ` (${currentVendor.role})` : '';
            currVendorEl.textContent = `${currentVendor.name}${roleLabel}`;
        }

        const pidInput = document.getElementById('reassign-prospect-id');
        if (pidInput) pidInput.value = p.id;

        const errBox = document.getElementById('reassign-error-box');
        if (errBox) {
            errBox.style.display = 'none';
            errBox.textContent = '';
        }

        const selectEl = document.getElementById('reassign-new-vendor-select');
        if (selectEl) {
            selectEl.innerHTML = '<option value="">-- Selecciona un vendedor o gestor --</option>';

            // Solo usuarios activos con rol 'vendedor' o 'gestor'
            // Se excluyen explícitamente gerentes, administradores e inactivos.
            const validUsers = (Array.isArray(users) ? users : []).filter(u => {
                if (!u || u.activo === false) return false;
                const r = String(u.role || '').toLowerCase();
                return r === 'vendedor' || r === 'gestor';
            });

            validUsers.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

            validUsers.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.id;
                const roleName = u.role === 'gestor' ? 'Gestor' : 'Vendedor';
                opt.textContent = `${u.nombre} (${roleName})`;
                if (u.id === currentVendor.id) {
                    opt.textContent += ' [Actual]';
                }
                selectEl.appendChild(opt);
            });
        }

        const btnSubmit = document.getElementById('btn-confirm-reassign');
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Confirmar Reasignación';
        }

        if (typeof openModal === 'function') {
            openModal('reassignModal');
        }
        return;
    }

    // Fallback para entornos de prueba sin modal DOM completo o invocación directa
    let targetUser = null;
    const activeVendors = (Array.isArray(users) ? users : []).filter(u => u && u.activo !== false && (u.role === 'vendedor' || u.role === 'gestor'));

    if (directTargetId) {
        targetUser = activeVendors.find(u => u.id === directTargetId || u.cid === directTargetId || (u.email && u.email.toLowerCase() === String(directTargetId).toLowerCase()));
    } else if (typeof prompt === 'function') {
        const selStr = prompt(`Reasignar Oportunidad: "${p.proyecto}"\nVendedor Actual: ${currentVendor.name}`);
        if (!selStr) return;
        targetUser = activeVendors.find(u => (u.email && u.email.toLowerCase() === selStr.toLowerCase().trim()) || (u.nombre && u.nombre.toLowerCase().includes(selStr.toLowerCase().trim())));
        const num = parseInt(selStr, 10);
        if (!targetUser && !isNaN(num) && num > 0 && num <= activeVendors.length) {
            targetUser = activeVendors[num - 1];
        }
    }

    if (!targetUser) return alert("Vendedor no encontrado.");

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }
    if (typeof showLoading === 'function') showLoading('Reasignando vendedor...');
    return CrmCommercial.reassign(fb, { prospectId: p.id, vendedorId: targetUser.id, dbSuffix: typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod' }).then(res => {
        if (res.status === 'reassigned') {
            p.vendedorId = res.vendedorId;
            p.vendedorName = res.vendedorName;
            p.vendedorRole = res.vendedorRole;
        }
        if (typeof openDetail === 'function') openDetail(p.id);
        if (typeof renderList === 'function') renderList();
        alert(res.status === 'reassigned' ? `✔️ Oportunidad reasignada exitosamente a ${targetUser.nombre}.` : 'La oportunidad ya estaba asignada a ese vendedor.');
    }).catch(err => alert(CrmCommercial.errorMessage(err))).finally(() => {
        if (typeof hideLoading === 'function') hideLoading();
    });
}

async function processConfirmReassign(event) {
    if (event) event.preventDefault();
    const pidInput = document.getElementById('reassign-prospect-id');
    const selectEl = document.getElementById('reassign-new-vendor-select');
    const errBox = document.getElementById('reassign-error-box');
    const btnSubmit = document.getElementById('btn-confirm-reassign');

    const prospectId = pidInput ? pidInput.value : null;
    const targetUserId = selectEl ? selectEl.value : null;

    if (!prospectId) return;

    if (!targetUserId) {
        if (errBox) {
            errBox.textContent = 'Por favor selecciona un nuevo responsable comercial.';
            errBox.style.display = 'block';
        }
        return;
    }

    const targetUser = (Array.isArray(users) ? users : []).find(u => u.id === targetUserId);
    if (!targetUser || (targetUser.role !== 'vendedor' && targetUser.role !== 'gestor')) {
        if (errBox) {
            errBox.textContent = 'El usuario seleccionado no es un Vendedor o Gestor válido.';
            errBox.style.display = 'block';
        }
        return;
    }

    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        if (errBox) {
            errBox.textContent = typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.';
            errBox.style.display = 'block';
        }
        return;
    }

    if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Reasignando...';
    }
    if (errBox) errBox.style.display = 'none';

    try {
        const res = await CrmCommercial.reassign(fb, { prospectId: p.id, vendedorId: targetUser.id, dbSuffix: DB_SUFFIX });
        if (res.status === 'reassigned') {
            p.vendedorId = res.vendedorId;
            p.vendedorName = res.vendedorName;
            p.vendedorRole = res.vendedorRole;
        }
        closeModal('reassignModal');
        openDetail(p.id);
        renderList();
        alert(res.status === 'reassigned' ? `✔️ Oportunidad reasignada exitosamente a ${targetUser.nombre}.` : 'La oportunidad ya estaba asignada a ese vendedor.');
    } catch (err) {
        if (errBox) {
            errBox.textContent = CrmCommercial.errorMessage(err);
            errBox.style.display = 'block';
        } else {
            alert(CrmCommercial.errorMessage(err));
        }
    } finally {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Confirmar Reasignación';
        }
    }
}

function updateOppSortIcons() {
    const columns = ['codigo', 'cliente', 'proyecto', 'vendedor', 'fecha', 'etapa', 'monto', 'estado'];
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

    const ALLOWED_UPLOAD_EXT_MAP = {
        'pdf': 'application/pdf',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls': 'application/vnd.ms-excel',
        'xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc': 'application/msword',
        'dwg': 'image/vnd.dwg',
        'dxf': 'image/vnd.dxf',
        'rvt': 'application/vnd.autodesk.revit',
        'rfa': 'application/vnd.autodesk.revit',
        'rte': 'application/vnd.autodesk.revit',
        'rft': 'application/vnd.autodesk.revit',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'webp': 'image/webp',
        'gif': 'image/gif',
        'tif': 'image/tiff',
        'tiff': 'image/tiff',
        'zip': 'application/zip'
    };

    try {
        const rawExt = (file.name.split('.').pop() || '').toLowerCase();
        if (!ALLOWED_UPLOAD_EXT_MAP[rawExt]) {
            const formatErr = new Error(`El archivo "${file.name}" tiene una extensión (.${rawExt}) no permitida en el ERP. Formatos admitidos: PDF, Excel (.xlsx, .xls), Word (.docx, .doc), CAD (.dwg, .dxf), Revit (.rvt, .rfa, .rte, .rft), Imágenes y ZIP.`);
            formatErr.isFormatError = true;
            alert('❌ ' + formatErr.message);
            throw formatErr;
        }

        const canonicalMime = ALLOWED_UPLOAD_EXT_MAP[rawExt] || file.type || 'application/octet-stream';
        const processedFile = await compressImage(file, 1280, 1280, 0.7);
        const safeName = processedFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

        // Utilizar exclusivamente el bucket canónico confirmado configurado en Firebase Storage
        const storageRef = storage.ref();

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
            const uploadTask = fileRef.put(processedFile, { contentType: canonicalMime });
            let timeoutId = null;
            let lastTransferred = 0;
            let settled = false;

            const cleanupWatchdog = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            // Watchdog de 25 segundos: solo aborta si tras 25s de inactividad de red no transfiere datos
            const checkProgress = () => {
                if (settled) return;
                const currentTransferred = uploadProgressMap.get(taskId)?.transferred || 0;
                if (currentTransferred === lastTransferred && currentTransferred === 0) {
                    settled = true;
                    cleanupWatchdog();
                    uploadTask.cancel();
                    const timeoutErr = new Error('Timeout de subida: La transferencia no avanzó tras 25 segundos. Comprueba tu conexión a internet.');
                    timeoutErr.code = 'storage/canceled';
                    timeoutErr.isTimeout = true;
                    reject(timeoutErr);
                } else {
                    lastTransferred = currentTransferred;
                    timeoutId = setTimeout(checkProgress, 25000);
                }
            };
            timeoutId = setTimeout(checkProgress, 25000);

            uploadTask.on('state_changed',
                (snapshot) => {
                    uploadProgressMap.set(taskId, { transferred: snapshot.bytesTransferred, total: snapshot.totalBytes });
                    updateGlobalProgress();
                },
                (error) => {
                    if (settled) return;
                    settled = true;
                    cleanupWatchdog();
                    console.warn('Error en subida Firebase Storage:', error);
                    reject(error);
                },
                () => {
                    if (settled) return;
                    settled = true;
                    cleanupWatchdog();
                    resolve();
                }
            );
        });

        activeUploads = Math.max(0, activeUploads - 1);
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

        const isAuthError = e && (
            e.code === 'storage/unauthorized'
            || e.code === 'storage/unauthenticated'
            || (e.serverResponse && (e.serverResponse.status === 403 || e.serverResponse.status === 401))
            || (typeof e.message === 'string' && e.message.toLowerCase().includes('unauthorized'))
        );

        console.error('Error definitivo subiendo archivo a Firebase Storage:', e);

        if (e && e.isFormatError) {
            // Ya fue notificado en la validación inicial
        } else if (isAuthError) {
            alert('❌ Acceso denegado: No tienes autorización para subir documentos a este expediente o el formato/tamaño ha sido rechazado por las políticas de seguridad del ERP.');
        } else if (e && e.isTimeout) {
            alert('⏱️ La subida se interrumpió por inactividad de la red. Por favor, verifica tu conexión a internet e inténtalo de nuevo.');
        } else {
            const errorMsg = e ? (e.message || e.code || JSON.stringify(e)) : 'Error de red desconocido';
            alert('❌ Error al subir el archivo a Firebase Storage:\n' + errorMsg);
        }
        throw e;
    }
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

const PREVIEWABLE_EXTS = [
    '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt',
    '.xlsx', '.xls'
];

function isExcelFormat(fileName, contentType) {
    if (contentType && (
        contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        contentType === 'application/vnd.ms-excel' ||
        contentType === 'application/msexcel' ||
        contentType === 'application/x-msexcel'
    )) {
        return true;
    }
    const name = String(fileName || '').toLowerCase();
    return name.endsWith('.xlsx') || name.endsWith('.xls');
}

function isFormatPreviewable(fileName, contentType) {
    if (contentType && (
        contentType.startsWith('image/') ||
        contentType === 'application/pdf' ||
        contentType.startsWith('text/') ||
        contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        contentType === 'application/vnd.ms-excel'
    )) {
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

        const reqProspectId = (options.prospectId !== undefined && options.prospectId !== null)
            ? options.prospectId
            : (options.clientId ? null : (typeof currentProspectId !== 'undefined' ? currentProspectId : null));
        const reqClientId = options.clientId || null;

        const res = await fn({
            storagePath,
            fileName,
            dbSuffix,
            prospectId: reqProspectId,
            clientId: reqClientId,
            disposition: 'attachment'
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

    // Si el formato no es compatible con el visor interactivo (e.g. ZIP, DWG, CAD), descargar directamente
    if (!isFormatPreviewable(fileName)) {
        return await downloadSecureDocument(docRef, fallbackName, options);
    }

    const hasPreviewModal = typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('docPreviewModal');
    let previewTab = null;

    if (hasPreviewModal && (!options || options.target !== '_blank')) {
        openDocPreviewModal(fileName, docRef, options);
    } else if (!options || !options.download) {
        // Mitigación popup blocker: abrir ventana en blanco de manera síncrona
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

    if (typeof showLoading === 'function') showLoading(`Preparando documento ${fileName}...`);

    try {
        const fb = (typeof firebase !== 'undefined') ? firebase : null;
        if (!fb || !fb.functions) {
            throw new Error('SDK de Firebase Functions no disponible en el cliente');
        }

        const fn = fb.functions().httpsCallable('getSecureDownloadUrlAdmin');
        const dbSuffix = typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod';

        const reqProspectId = (options.prospectId !== undefined && options.prospectId !== null)
            ? options.prospectId
            : (options.clientId ? null : (typeof currentProspectId !== 'undefined' ? currentProspectId : null));
        const reqClientId = options.clientId || null;

        const reqDisposition = (options && options.disposition) || (options && options.download ? 'attachment' : 'inline');
        const payload = {
            storagePath,
            fileName,
            dbSuffix,
            prospectId: reqProspectId,
            clientId: reqClientId,
            disposition: reqDisposition
        };

        const res = await fn(payload);

        const data = res && res.data;
        if (!data || !data.signedUrl) {
            throw new Error('No se recibió la URL de descarga segura del servidor.');
        }

        const safeDownloadName = data.fileName || fileName;

        if (options && options.download) {
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = data.signedUrl;
            a.download = safeDownloadName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                if (a.parentNode) a.parentNode.removeChild(a);
            }, 2000);
            return;
        }

        // Si tenemos modal de previsualización en el DOM
        if (hasPreviewModal && (!options || options.target !== '_blank')) {
            await displayDocumentInModal(data.signedUrl, safeDownloadName, data.contentType, docRef, options);
            return;
        }

        // Intento de visualización inline mediante Blob si el entorno lo permite (mismo origen o CORS)
        let openedInline = false;
        try {
            const resp = await fetch(data.signedUrl);
            if (resp.ok) {
                const blob = await resp.blob();
                const blobUrl = URL.createObjectURL(blob);
                if (previewTab && !previewTab.closed) {
                    previewTab.location.href = blobUrl;
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                    openedInline = true;
                } else if (!hasPreviewModal) {
                    window.open(blobUrl, '_blank');
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                    openedInline = true;
                }
            }
        } catch (fetchErr) {
            console.warn('[Storage Security] Fetch directo a Blob no disponible; navegando a URL firmada segura:', fetchErr);
        }

        // Si fetch a Blob no fue posible (ej. CORS o navegador estricto), navegar directamente a la URL firmada
        if (!openedInline) {
            if (previewTab && !previewTab.closed) {
                previewTab.location.href = data.signedUrl;
            } else if (!hasPreviewModal) {
                window.open(data.signedUrl, '_blank');
            }
        }
    } catch (error) {
        console.error('[Storage Security] Error al visualizar documento:', error);
        let userMessage = 'Error al cargar el archivo.';
        const errCode = error.code || '';
        const errMsg = error.message || '';

        if (errCode === 'functions/permission-denied' || errMsg.includes('permission-denied') || error.code === 'storage/unauthorized') {
            userMessage = 'Acceso denegado: No tienes autorización para visualizar este documento según las políticas comerciales.';
        } else if (errCode === 'functions/not-found' || errMsg.includes('not-found') || error.code === 'storage/object-not-found') {
            userMessage = 'El archivo solicitado ya no existe en el almacenamiento.';
        } else if (errCode === 'functions/unauthenticated' || errMsg.includes('unauthenticated') || error.code === 'storage/unauthenticated') {
            userMessage = 'Sesión expirada o no autenticada. Inicia sesión nuevamente.';
        } else if (errMsg.includes('network') || errCode === 'functions/unavailable') {
            userMessage = 'Error de conexión con el servidor. Verifica tu conexión a internet.';
        }

        if (hasPreviewModal && (!options || options.target !== '_blank')) {
            showDocPreviewError(userMessage, error, docRef, fileName, options);
        } else if (previewTab && !previewTab.closed) {
            previewTab.document.write(`
                <div style="padding:2rem; font-family:system-ui, sans-serif; color:#ef4444; background:#1e293b; height:100vh;">
                    <h3>⚠️ Error al abrir el documento</h3>
                    <p>${escapeHtmlDoc(userMessage)}</p>
                    <p style="font-size:0.8rem; color:#94a3b8;">Detalle técnico: ${escapeHtmlDoc(error.code || error.message || '')}</p>
                </div>
            `);
        } else {
            alert(userMessage);
        }
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
    }
}

function openDocPreviewModal(fileName, docRef, options) {
    const modal = document.getElementById('docPreviewModal');
    if (!modal) return;
    const titleEl = document.getElementById('doc-preview-title');
    const badgeEl = document.getElementById('doc-preview-badge');
    const iconEl = document.getElementById('doc-preview-icon');
    const contentEl = document.getElementById('doc-preview-content');
    const dlBtn = document.getElementById('btn-doc-preview-download');

    const ext = String(fileName || '').split('.').pop().toUpperCase() || 'DOC';
    if (titleEl) titleEl.textContent = fileName || 'Documento';
    if (badgeEl) badgeEl.textContent = ext;
    if (iconEl) {
        if (ext === 'XLSX' || ext === 'XLS') iconEl.textContent = '📊';
        else if (['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG', 'GIF'].includes(ext)) iconEl.textContent = '🖼️';
        else if (ext === 'PDF') iconEl.textContent = '📄';
        else iconEl.textContent = '📁';
    }

    if (dlBtn) {
        dlBtn.onclick = () => downloadSecureDocument(docRef, fileName, options);
    }

    if (contentEl) {
        contentEl.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:280px; color:var(--text-secondary);">
                <div style="font-size:2.5rem; margin-bottom:1rem;">⏳</div>
                <div style="font-size:1.1rem; font-weight:600; color:white;">Cargando documento seguro...</div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">${escapeHtmlDoc(fileName)}</div>
            </div>
        `;
    }

    window._activeDocRef = docRef;
    window._activeDocOptions = options;
    window._activeDocName = fileName;

    modal.style.display = 'block';
}

function closeDocPreviewModal() {
    const modal = document.getElementById('docPreviewModal');
    if (modal) modal.style.display = 'none';
    const contentEl = document.getElementById('doc-preview-content');
    if (contentEl) contentEl.innerHTML = '';
    window._activeWorkbook = null;
    window._activeWorkbookName = null;
    window._activeDocRef = null;
    window._activeDocOptions = null;
}

async function displayDocumentInModal(signedUrl, fileName, contentType, docRef, options) {
    const contentEl = document.getElementById('doc-preview-content');
    if (!contentEl) return;

    if (isExcelFormat(fileName, contentType)) {
        await renderExcelPreviewInModal(signedUrl, fileName);
        return;
    }

    const lower = String(fileName || '').toLowerCase();
    const isImage = (contentType && contentType.startsWith('image/')) ||
        ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].some(ext => lower.endsWith(ext));

    if (isImage) {
        contentEl.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:center; height:100%; padding:1.5rem; overflow:auto;">
                <img src="${signedUrl}" alt="${escapeHtmlDoc(fileName)}" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:6px; box-shadow:0 4px 20px rgba(0,0,0,0.5);">
            </div>
        `;
        return;
    }

    // PDF or text files
    contentEl.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; width:100%;">
            <iframe src="${signedUrl}" style="flex:1; width:100%; height:100%; border:none; background:#ffffff; border-radius:6px;" title="${escapeHtmlDoc(fileName)}"></iframe>
            <div style="padding:8px 12px; background:rgba(0,0,0,0.4); display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; border-top:1px solid var(--panel-border);">
                <span style="color:var(--text-muted);">Visualizando visor seguro integrado</span>
                <a href="${signedUrl}" target="_blank" style="color:var(--brand-gold); text-decoration:underline;">↗️ Abrir en pestaña separada</a>
            </div>
        </div>
    `;
}

function showDocPreviewError(userMessage, error, docRef, fileName, options) {
    const contentEl = document.getElementById('doc-preview-content');
    if (!contentEl) return;
    contentEl.innerHTML = `
        <div style="padding:3rem 1.5rem; text-align:center; color:var(--text-secondary); margin:auto;">
            <div style="font-size:3rem; margin-bottom:1rem;">⚠️</div>
            <h3 style="color:var(--danger); margin-bottom:0.75rem;">No se pudo previsualizar el documento</h3>
            <p style="max-width:480px; margin:0 auto 1.5rem auto; font-size:0.9rem; color:var(--text-secondary);">
                ${escapeHtmlDoc(userMessage)}
            </p>
            <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:1.5rem;">
                Detalle: ${escapeHtmlDoc((error && (error.code || error.message)) || 'Error desconocido')}
            </p>
            <button type="button" class="btn-primary" onclick="downloadSecureDocument(window._activeDocRef, window._activeDocName || '${escapeHtmlDoc(fileName)}', window._activeDocOptions)">
                ⬇️ Descargar Archivo Original
            </button>
        </div>
    `;
}

function loadXlsxLibrary() {
    return new Promise((resolve, reject) => {
        if (typeof XLSX !== 'undefined') return resolve(window.XLSX);
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.onload = () => resolve(window.XLSX);
        script.onerror = () => reject(new Error('No se pudo cargar la librería XLSX desde la red.'));
        document.head.appendChild(script);
    });
}

async function renderExcelPreviewInModal(signedUrl, fileName) {
    const container = document.getElementById('doc-preview-content');
    if (!container) return;

    container.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:280px; color:var(--text-secondary);">
            <div style="font-size:2.5rem; margin-bottom:1rem;">📊</div>
            <div style="font-size:1.1rem; font-weight:600; color:white;">Analizando libro de cálculo Excel...</div>
            <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">${escapeHtmlDoc(fileName)}</div>
        </div>
    `;

    try {
        if (typeof XLSX === 'undefined') {
            await loadXlsxLibrary();
        }

        const resp = await fetch(signedUrl);
        if (!resp.ok) {
            throw new Error(`Error de lectura en el servidor (HTTP ${resp.status}).`);
        }

        const buffer = await resp.arrayBuffer();
        if (!buffer || buffer.byteLength === 0) {
            throw new Error('El archivo Excel está completamente vacío (0 bytes).');
        }

        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('El archivo no contiene hojas de cálculo legibles o tiene un formato no compatible.');
        }

        window._activeWorkbook = workbook;
        window._activeWorkbookName = fileName;

        let tabsHtml = workbook.SheetNames.map((name, idx) => `
            <button type="button" class="excel-sheet-tab ${idx === 0 ? 'active' : ''}" onclick="selectExcelSheet(${idx})">
                📄 ${escapeHtmlDoc(name)}
            </button>
        `).join('');

        container.innerHTML = `
            <div style="display:flex; flex-direction:column; height:100%; width:100%;">
                <div class="excel-sheet-tabs" id="excel-sheet-tabs">${tabsHtml}</div>
                <div class="excel-table-container" id="excel-table-display"></div>
            </div>
        `;

        renderSheetTable(workbook.SheetNames[0]);
    } catch (err) {
        console.error('[Excel Preview] Error al procesar archivo:', err);
        container.innerHTML = `
            <div style="padding:3rem 1.5rem; text-align:center; color:var(--text-secondary); margin:auto;">
                <div style="font-size:3rem; margin-bottom:1rem;">📊</div>
                <h3 style="color:var(--brand-gold); margin-bottom:0.75rem;">Vista previa de Excel no disponible</h3>
                <p style="max-width:500px; margin:0 auto 1.5rem auto; font-size:0.9rem; color:var(--text-secondary);">
                    ${escapeHtmlDoc(err.message || 'No fue posible interpretar el contenido del libro Excel.')}
                </p>
                <button type="button" class="btn-primary" onclick="downloadSecureDocument(window._activeDocRef, window._activeDocName || '${escapeHtmlDoc(fileName)}', window._activeDocOptions)">
                    ⬇️ Descargar Archivo Excel Original
                </button>
            </div>
        `;
    }
}

function selectExcelSheet(idx) {
    if (!window._activeWorkbook || !window._activeWorkbook.SheetNames || !window._activeWorkbook.SheetNames[idx]) return;
    const tabs = document.querySelectorAll('.excel-sheet-tab');
    tabs.forEach((t, i) => {
        if (i === idx) t.classList.add('active');
        else t.classList.remove('active');
    });
    renderSheetTable(window._activeWorkbook.SheetNames[idx]);
}

function renderSheetTable(sheetNameOrRows, maxRows = 500) {
    let rows;
    if (Array.isArray(sheetNameOrRows)) {
        rows = sheetNameOrRows;
    } else {
        const tableDiv = document.getElementById('excel-table-display');
        const activeWb = (typeof window !== 'undefined' && window._activeWorkbook) ? window._activeWorkbook : null;
        if (!tableDiv || !activeWb) return '';
        const sheet = activeWb.Sheets[sheetNameOrRows];
        if (!sheet) {
            tableDiv.innerHTML = '<div style="padding:2rem; text-align:center; color:var(--text-muted);">Hoja no encontrada en el libro.</div>';
            return '<div style="padding:2rem; text-align:center; color:var(--text-muted);">Hoja no encontrada en el libro.</div>';
        }
        if (typeof XLSX === 'undefined') return '';
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    }

    if (!rows || rows.length === 0) {
        const emptyHtml = '<div style="padding:2rem; text-align:center; color:var(--text-muted);">Esta hoja de cálculo está vacía.</div>';
        const tableDiv = document.getElementById('excel-table-display');
        if (tableDiv && !Array.isArray(sheetNameOrRows)) tableDiv.innerHTML = emptyHtml;
        return emptyHtml;
    }

    const MAX_ROWS = maxRows || 500;
    const isTruncated = rows.length > MAX_ROWS;
    const displayRows = rows.slice(0, MAX_ROWS);

    let maxCols = 0;
    displayRows.forEach(r => { if (Array.isArray(r) && r.length > maxCols) maxCols = r.length; });
    if (maxCols === 0) {
        const noDataHtml = '<div style="padding:2rem; text-align:center; color:var(--text-muted);">La hoja no contiene celdas con datos.</div>';
        const tableDiv = document.getElementById('excel-table-display');
        if (tableDiv && !Array.isArray(sheetNameOrRows)) tableDiv.innerHTML = noDataHtml;
        return noDataHtml;
    }

    let colHeaders = '';
    for (let c = 0; c < maxCols; c++) {
        let colLabel = '';
        let num = c;
        while (num >= 0) {
            colLabel = String.fromCharCode(65 + (num % 26)) + colLabel;
            num = Math.floor(num / 26) - 1;
        }
        colHeaders += `<th>${colLabel}</th>`;
    }

    let rowsHtml = '';
    displayRows.forEach((row, rIdx) => {
        let cellsHtml = `<td style="width:40px; text-align:center; color:var(--text-muted); font-size:0.75rem;">${rIdx + 1}</td>`;
        for (let c = 0; c < maxCols; c++) {
            const val = (Array.isArray(row) && row[c] !== undefined && row[c] !== null) ? String(row[c]) : '';
            cellsHtml += `<td>${escapeHtmlDoc(val)}</td>`;
        }
        rowsHtml += `<tr>${cellsHtml}</tr>`;
    });

    const infoBar = isTruncated
        ? `<div style="padding:6px 12px; background:rgba(255,204,77,0.12); color:var(--brand-gold); font-size:0.75rem; border-bottom:1px solid var(--panel-border);">⚠️ Mostrando las primeras ${MAX_ROWS} filas de ${rows.length}. Descarga el archivo original para ver el libro completo.</div>`
        : `<div style="padding:6px 12px; color:var(--text-muted); font-size:0.75rem; border-bottom:1px solid var(--panel-border);">Total: ${rows.length} fila${rows.length === 1 ? '' : 's'}, ${maxCols} columna${maxCols === 1 ? '' : 's'}.</div>`;

    const finalHtml = `
        ${infoBar}
        <div style="overflow:auto; height:calc(100% - 32px);">
            <table class="excel-table">
                <thead>
                    <tr>
                        <th style="width:40px; text-align:center; z-index:3;">#</th>
                        ${colHeaders}
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;

    const tableDiv = document.getElementById('excel-table-display');
    if (tableDiv && !Array.isArray(sheetNameOrRows)) {
        tableDiv.innerHTML = finalHtml;
    }
    return finalHtml;
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
    window.isExcelFormat = isExcelFormat;
    window.escapeHtmlDoc = escapeHtmlDoc;
    window.formatClientDocLabel = formatClientDocLabel;
    window.renderClientDocItem = renderClientDocItem;
    if (typeof openDocPreviewModal !== 'undefined') window.openDocPreviewModal = openDocPreviewModal;
    if (typeof closeDocPreviewModal !== 'undefined') window.closeDocPreviewModal = closeDocPreviewModal;
    if (typeof isProjectFullyPaid !== 'undefined') window.isProjectFullyPaid = isProjectFullyPaid;
    if (typeof setProjPaymentFilter !== 'undefined') window.setProjPaymentFilter = setProjPaymentFilter;
    if (typeof getProjPaymentFilter !== 'undefined') window.getProjPaymentFilter = getProjPaymentFilter;
    if (typeof renderSheetTable !== 'undefined') window.renderSheetTable = renderSheetTable;
    if (typeof renderClientExpedienteSection !== 'undefined') window.renderClientExpedienteSection = renderClientExpedienteSection;
    if (typeof parseProspectDate !== 'undefined') window.parseProspectDate = parseProspectDate;
    if (typeof formatProspectDate !== 'undefined') window.formatProspectDate = formatProspectDate;
    if (typeof clearOppDateFilter !== 'undefined') window.clearOppDateFilter = clearOppDateFilter;
    if (typeof toggleOppSort !== 'undefined') window.toggleOppSort = toggleOppSort;
    if (typeof updateOppSortIcons !== 'undefined') window.updateOppSortIcons = updateOppSortIcons;
    if (typeof setOppStatusFilter !== 'undefined') window.setOppStatusFilter = setOppStatusFilter;
    if (typeof getOppStatusFilter !== 'undefined') window.getOppStatusFilter = getOppStatusFilter;
    if (typeof setSellerFilterMode !== 'undefined') window.setSellerFilterMode = setSellerFilterMode;
    if (typeof getSellerFilterMode !== 'undefined') window.getSellerFilterMode = getSellerFilterMode;
    if (typeof renderList !== 'undefined') window.renderList = renderList;
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
        isExcelFormat,
        escapeHtmlDoc,
        formatClientDocLabel,
        renderClientDocItem,
        openDocPreviewModal: typeof openDocPreviewModal !== 'undefined' ? openDocPreviewModal : undefined,
        closeDocPreviewModal: typeof closeDocPreviewModal !== 'undefined' ? closeDocPreviewModal : undefined,
        isProjectFullyPaid: typeof isProjectFullyPaid !== 'undefined' ? isProjectFullyPaid : undefined,
        setProjPaymentFilter: typeof setProjPaymentFilter !== 'undefined' ? setProjPaymentFilter : undefined,
        getProjPaymentFilter: typeof getProjPaymentFilter !== 'undefined' ? getProjPaymentFilter : undefined,
        setOppStatusFilter: typeof setOppStatusFilter !== 'undefined' ? setOppStatusFilter : undefined,
        getOppStatusFilter: typeof getOppStatusFilter !== 'undefined' ? getOppStatusFilter : undefined,
        setSellerFilterMode: typeof setSellerFilterMode !== 'undefined' ? setSellerFilterMode : undefined,
        getSellerFilterMode: typeof getSellerFilterMode !== 'undefined' ? getSellerFilterMode : undefined,
        renderList: typeof renderList !== 'undefined' ? renderList : undefined,
        renderSheetTable: typeof renderSheetTable !== 'undefined' ? renderSheetTable : undefined,
        renderClientExpedienteSection: typeof renderClientExpedienteSection !== 'undefined' ? renderClientExpedienteSection : undefined,
        parseProspectDate: typeof parseProspectDate !== 'undefined' ? parseProspectDate : undefined,
        formatProspectDate: typeof formatProspectDate !== 'undefined' ? formatProspectDate : undefined,
        clearOppDateFilter: typeof clearOppDateFilter !== 'undefined' ? clearOppDateFilter : undefined,
        toggleOppSort: typeof toggleOppSort !== 'undefined' ? toggleOppSort : undefined,
        updateOppSortIcons: typeof updateOppSortIcons !== 'undefined' ? updateOppSortIcons : undefined
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

let chartFunnel = null; let chartProduct = null; let chartProject = null; let chartOrigin = null; let chartLoss = null; let chartOppProduct = null; let chartOppProject = null; let chartMonthly = null; let chartSeller = null;

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
                renderFollowUpSummary(p);
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
        if (role === 'manager') {
            // Manager lists all prospects
            const unsubProspects = db.collection(`prospects${DB_SUFFIX}`).onSnapshot(
                snap => {
                    prospects = snap.docs.map(doc => doc.data()).filter(p => p.eliminado !== true);
                    checkInitialLoad();
                },
                err => console.warn('[CRM] Listener prospects no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubProspects);
        } else if (role === 'gestor') {
            // Gestor listens to: 1) createdBy == userId (own created leads), 2) vendedorId == userId (assigned leads), 3) postcierre_habilitado == true (postclosing projects)
            let ownProspects = [];
            let assignedProspects = [];
            let postclosingProspects = [];
            const mergeGestorProspects = () => {
                const dict = {};
                ownProspects.forEach(p => { dict[p.id] = p; });
                assignedProspects.forEach(p => { dict[p.id] = p; });
                postclosingProspects.forEach(p => { dict[p.id] = p; });
                prospects = Object.values(dict).filter(p => p.eliminado !== true);
                checkInitialLoad();
            };
            const unsubOwn = db.collection(`prospects${DB_SUFFIX}`).where('createdBy', '==', userId).onSnapshot(
                snap => {
                    ownProspects = snap.docs.map(doc => doc.data());
                    mergeGestorProspects();
                },
                err => console.warn('[CRM] Listener prospects (gestor propios) no disponible:', err && err.message)
            );
            const unsubAssigned = db.collection(`prospects${DB_SUFFIX}`).where('vendedorId', '==', userId).onSnapshot(
                snap => {
                    assignedProspects = snap.docs.map(doc => doc.data());
                    mergeGestorProspects();
                },
                err => console.warn('[CRM] Listener prospects (gestor asignados) no disponible:', err && err.message)
            );
            const unsubPostclosing = db.collection(`prospects${DB_SUFFIX}`).where('postcierre_habilitado', '==', true).onSnapshot(
                snap => {
                    postclosingProspects = snap.docs.map(doc => doc.data());
                    mergeGestorProspects();
                },
                err => console.warn('[CRM] Listener prospects (postcierre) no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubOwn, unsubAssigned, unsubPostclosing);
        } else if (role === 'vendedor') {
            // Vendedores listen strictly to assigned leads (vendedorId == userId)
            const unsubAssigned = db.collection(`prospects${DB_SUFFIX}`).where('vendedorId', '==', userId).onSnapshot(
                snap => {
                    prospects = snap.docs.map(doc => doc.data()).filter(p => p.eliminado !== true);
                    checkInitialLoad();
                },
                err => console.warn('[CRM] Listener prospects (asignados) no disponible:', err && err.message)
            );
            activeUnsubscribers.push(unsubAssigned);
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
    if (viewId === 'projects-view' && currentUser && currentUser.role === 'vendedor') {
        alert("Acceso denegado: el perfil de vendedor no tiene acceso al módulo de Proyectos y Cobros.");
        showView('list-view');
        return;
    }
    const previousSection = lastViewedSection;
    lastViewedSection = viewId === 'detail-view' ? lastViewedSection : viewId;
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));

    if (viewId === 'list-view') {
        document.getElementById('nav-list').classList.add('active');
        // Al entrar en Oportunidades de Venta como gerente, debe aparecer primero Cartera Completa / Pipeline.
        // La Agenda Diaria de Seguimiento sigue disponible como vista secundaria.
        // Los demás roles (vendedor/gestor) entran a su Agenda Diaria de Seguimiento.
        const isManager = currentUser && currentUser.role === 'manager';
        if (isManager && previousSection !== 'list-view' && previousSection !== 'detail-view') {
            currentListMode = 'pipeline';
        } else if (!currentListMode) {
            currentListMode = isManager ? 'pipeline' : 'agenda';
        }
        if (typeof switchListMode === 'function') {
            switchListMode(currentListMode);
        } else {
            renderList();
        }
    }
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
        currentListMode = 'pipeline';
        [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        showView('dashboard-view');
    }
    else if (role === 'gestor') {
        currentListMode = 'agenda';
        [navProjects, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        headerAction.style.display = 'table-cell';
        showView('projects-view');
    }
    else {
        currentListMode = 'agenda';
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
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
        const [y, m, d] = date.trim().split('-').map(Number);
        return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    }
    const d = new Date(date);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('es-SV', {
        timeZone: 'America/El_Salvador',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
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

function isProjectFullyPaid(p) {
    if (!p || typeof p !== 'object') return false;
    const subtotal = typeof getProjectSubtotal === 'function' ? getProjectSubtotal(p) : (parseFloat(p.precio_cotizado) || 0);
    if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal <= 0) return false;
    let isExport = false;
    const clientList = (typeof clients !== 'undefined' && Array.isArray(clients) && clients.length > 0)
        ? clients
        : ((typeof global !== 'undefined' && Array.isArray(global.clients)) ? global.clients : []);
    if (p.clientId && clientList.length > 0) {
        const client = clientList.find(c => c.id === p.clientId);
        if (client) isExport = client.es_exportacion === true || client.es_exportacion === 'true';
    }
    const total = isExport ? Math.round(subtotal * 100) / 100 : Math.round(subtotal * 1.13 * 100) / 100;
    if (total <= 0) return false;
    if (!Array.isArray(p.facturas) || p.facturas.length === 0) return false;
    let totalCobrado = 0;
    p.facturas.forEach(f => {
        if (Array.isArray(f.pagos)) {
            f.pagos.forEach(pay => {
                const m = parseFloat(pay.monto);
                if (!isNaN(m) && m > 0) totalCobrado += m;
            });
        }
    });
    if (totalCobrado <= 0) return false;
    return totalCobrado >= (total - 0.05);
}

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
        const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);
        if (isAssigned && p.eliminado !== true && p.clientId) {
            related.add(p.clientId);
        }
    });
    return clients.filter(c => 
        c.createdBy === currentUser.id || 
        related.has(c.id) || 
        (Array.isArray(c.visibleTo) && c.visibleTo.includes(currentUser.id))
    );
}

function renderClientsTable() {
    const tbody = document.getElementById('clients-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const esc = (typeof escapeHtmlDoc === 'function') ? escapeHtmlDoc : (s => String(s || ''));

    let filtered = getVisibleClients();

    const countBadge = document.getElementById('clients-count-badge');
    if (countBadge) {
        countBadge.textContent = `${filtered.length} cliente${filtered.length === 1 ? '' : 's'}`;
    }

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

    if (filtered.length === 0) {
        if (countBadge) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="table-empty-box">
                            <div style="font-size:2rem; margin-bottom:0.4rem;">👥</div>
                            <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">No se encontraron clientes</div>
                            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">
                                ${searchVal ? 'Prueba con otro término de búsqueda.' : 'Registra un nuevo cliente para comenzar.'}
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        } else {
            tbody.innerHTML = '';
        }
        return;
    }

    filtered.forEach(c => {
        const isNatural = c.tipo === 'natural';
        const typeBadge = isNatural
            ? '<span class="badge" style="background:rgba(255,255,255,0.06); color:#cbd5e1; border:1px solid rgba(255,255,255,0.12); font-weight:500;">Natural</span>'
            : '<span class="badge" style="background:rgba(217, 119, 6, 0.15); color:var(--brand-gold); border:1px solid rgba(217, 119, 6, 0.35); font-weight:600;">Jurídica</span>';

        const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.contacto || '-');
        const mainName = (isNatural ? `${c.nombres || ''} ${c.apellidos || ''}`.trim() : (c.empresa || '-')) || '-';
        const isExport = c.es_exportacion === true || c.es_exportacion === 'true';
        const exportBadge = isExport ? ' <span class="badge" style="background:rgba(33, 150, 243, 0.15); color:#60a5fa; border:1px solid rgba(33, 150, 243, 0.35); font-size:0.68rem; margin-left:4px; vertical-align:middle;">✈️ Exp</span>' : '';

        const phoneStr = c.telefono ? `<span style="font-family:monospace; font-size:0.85rem; color:var(--text-secondary);">${esc(c.telefono)}</span>` : '<span style="color:var(--text-muted);">-</span>';
        const emailStr = c.correo ? `<a href="mailto:${esc(c.correo)}" class="cell-ellipsis" style="display:inline-block; max-width:210px; color:var(--text-secondary); text-decoration:none;" title="${esc(c.correo)}">${esc(c.correo)}</a>` : '<span style="color:var(--text-muted);">-</span>';

        let actionsHtml = `<div class="table-btn-group">
            <button type="button" class="btn-table-action btn-table-edit" onclick="openClientModal('${c.id}')" title="Editar datos y ver expediente de ${esc(mainName)}">
                ✏️ Editar
            </button>`;
        if (currentUser && currentUser.role === 'manager') {
            actionsHtml += `<button type="button" class="btn-table-action btn-table-delete" onclick="deleteClient('${c.id}')" title="Eliminar cliente">
                🗑️
            </button>`;
        }
        actionsHtml += `</div>`;

        tbody.innerHTML += `
            <tr>
                <td style="white-space:nowrap;">${typeBadge}</td>
                <td>
                    <div class="cell-ellipsis" style="font-weight:600; color:white; max-width:240px;" title="${esc(mainName)}">
                        ${esc(mainName)}${exportBadge}
                    </div>
                </td>
                <td>
                    <div class="cell-ellipsis" style="max-width:200px; color:var(--text-primary);" title="${esc(contactName)}">
                        ${esc(contactName)}
                    </div>
                </td>
                <td style="white-space:nowrap;">${phoneStr}</td>
                <td>${emailStr}</td>
                <td style="text-align:right; white-space:nowrap;">${actionsHtml}</td>
            </tr>
        `;
    });
}
function toggleClientFields() {
    const type = document.getElementById('client-tipo').value;
    if (type === 'natural') { document.getElementById('fields-natural').style.display = 'block'; document.getElementById('fields-juridica').style.display = 'none'; }
    else if (type === 'juridica') { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'block'; }
    else { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'none'; }
}

function renderClientExpedienteSection(c) {
    const section = document.getElementById('client-expediente-section');
    const listEl = document.getElementById('client-docs-list');
    const badgeEl = document.getElementById('client-docs-count-badge');
    if (!section || !listEl) return;

    if (!c || !c.id || !c.documentos || typeof c.documentos !== 'object') {
        if (badgeEl) badgeEl.textContent = '0 documentos';
        listEl.innerHTML = '<div style="text-align:center; padding:0.75rem; color:var(--text-muted); font-size:0.8rem;">Sin documentos registrados en el expediente.</div>';
        section.style.display = c && c.id ? 'block' : 'none';
        return;
    }

    const docItems = [];
    const allKeys = Object.keys(c.documentos);
    const PREFERRED_ORDER = [
        'dui', 'dui_rep',
        'nit', 'nit_empresa', 'nit_rep',
        'nrc', 'nrc_empresa',
        'escritura', 'escritura_constitucion',
        'mods_escritura', 'mods',
        'credencial', 'credencial_rep'
    ];
    const sortedKeys = [
        ...PREFERRED_ORDER.filter(k => allKeys.includes(k)),
        ...allKeys.filter(k => !PREFERRED_ORDER.includes(k)).sort()
    ];

    sortedKeys.forEach(k => {
        const val = c.documentos[k];
        if (!val) return;
        const lbl = formatClientDocLabel(k);
        if (Array.isArray(val)) {
            val.forEach((subVal, idx) => {
                if (subVal) docItems.push({ docRef: subVal, label: `${lbl} (${idx + 1})`, key: k, index: idx });
            });
        } else {
            docItems.push({ docRef: val, label: lbl, key: k, index: null });
        }
    });

    if (badgeEl) badgeEl.textContent = `${docItems.length} documento${docItems.length === 1 ? '' : 's'}`;

    if (docItems.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:0.75rem; color:var(--text-muted); font-size:0.8rem;">Sin documentos registrados en el expediente.</div>';
        section.style.display = 'block';
        return;
    }

    const isManager = currentUser && currentUser.role === 'manager';
    listEl.innerHTML = docItems.map(item => {
        let fileName = 'Documento';
        if (typeof item.docRef === 'object' && item.docRef && item.docRef.name) {
            fileName = String(item.docRef.name);
        } else if (typeof item.docRef === 'string') {
            const parts = item.docRef.split('?')[0].split('/');
            const last = parts[parts.length - 1];
            fileName = decodeURIComponent(last) || item.label;
        } else {
            fileName = item.label;
        }

        const storeId = 'cdoc_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
        const store = getDocStore();
        store.set(storeId, {
            docRef: item.docRef,
            fileName: fileName,
            label: item.label,
            clientId: c.id,
            docKey: item.key,
            itemIndex: item.index
        });

        const ext = String(fileName).split('.').pop().toUpperCase() || 'DOC';
        let icon = '📁';
        if (ext === 'XLSX' || ext === 'XLS') icon = '📊';
        else if (['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].includes(ext)) icon = '🖼️';
        else if (ext === 'PDF') icon = '📄';

        const previewable = isFormatPreviewable(fileName);
        const safeName = escapeHtmlDoc(fileName);
        const safeLabel = escapeHtmlDoc(item.label);

        let viewBtn = '';
        if (previewable) {
            viewBtn = `<button type="button" class="btn-table-action btn-table-edit" onclick="viewStoredClientDoc('${storeId}')" title="Previsualizar documento">👁️ Ver</button>`;
        }
        const dlBtn = `<button type="button" class="btn-table-action" onclick="downloadStoredClientDoc('${storeId}')" title="Descargar original" style="background:rgba(255,255,255,0.06); color:var(--text-secondary); border:1px solid rgba(255,255,255,0.12);">⬇️ Descargar</button>`;
        const delBtn = isManager ? `<button type="button" class="btn-table-action btn-table-delete" onclick="deleteStoredClientDoc('${storeId}')" title="Eliminar documento del expediente">🗑️</button>` : '';

        return `
            <div class="client-doc-card">
                <div class="client-doc-info">
                    <span style="font-size:1.25rem;">${icon}</span>
                    <div style="min-width:0;">
                        <div class="client-doc-title">${safeLabel}</div>
                        <div class="client-doc-meta" title="${safeName}">${safeName}</div>
                    </div>
                </div>
                <div class="client-doc-actions">
                    <span class="badge" style="background:rgba(255,255,255,0.06); color:var(--text-muted); font-size:0.65rem; border:1px solid rgba(255,255,255,0.1);">${escapeHtmlDoc(ext)}</span>
                    ${viewBtn}
                    ${dlBtn}
                    ${delBtn}
                </div>
            </div>
        `;
    }).join('');

    section.style.display = 'block';
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
            }
            else {
                document.getElementById('jur-empresa').value = c.empresa || ''; document.getElementById('jur-contacto').value = c.contacto || ''; document.getElementById('jur-nit').value = c.nit || ''; document.getElementById('jur-nrc').value = c.nrc || '';
                document.getElementById('jur-rep-legal').value = c.rep_legal || ''; document.getElementById('jur-profesion-rep').value = c.profesion_rep || ''; document.getElementById('jur-domicilio-rep').value = c.domicilio_rep || '';
                document.getElementById('jur-dui-rep').value = c.dui_rep || ''; document.getElementById('jur-nit-rep').value = c.nit_rep || '';
                document.getElementById('jur-gran-contribuyente').checked = c.is_gran_contribuyente === true;
            }
            renderClientExpedienteSection(c);
        }
    } else {
        window._activeClientBaseDocs = null;
        document.getElementById('client-modal-title').textContent = 'Registrar Cliente'; document.getElementById('client-tipo').value = ''; document.getElementById('jur-gran-contribuyente').checked = false; document.getElementById('cli-es-exportacion').checked = false; toggleClientFields();
        renderClientExpedienteSection(null);
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

let oppStatusFilter = 'activas';
let oppClasifFilter = 'todas';

function getOppStatusFilter() {
    return oppStatusFilter;
}

function getOppClasifFilter() {
    return oppClasifFilter;
}

function setOppStatusFilter(filterKey) {
    if (['activas', 'perdidas', 'todas'].includes(filterKey)) {
        oppStatusFilter = filterKey;
        renderList();
    }
}

function setOppClasifFilter(filterKey) {
    if (['todas', 'ejecucion', 'presupuesto'].includes(filterKey)) {
        oppClasifFilter = filterKey;
        renderList();
    }
}

// ==========================================================================
// CONTROL DIARIO DE SEGUIMIENTO COMERCIAL Y AGENDA DEL VENDEDOR (FASE 1)
// ==========================================================================
let currentListMode = 'agenda'; // 'agenda' | 'pipeline'
let currentAgendaFilter = 'todas';

function switchListMode(mode) {
    if (mode === 'agenda' || mode === 'pipeline') {
        currentListMode = mode;
        const agendaContainer = document.getElementById('agenda-view-container');
        const pipelineContainer = document.getElementById('pipeline-view-container');
        const tabAgenda = document.getElementById('tab-agenda-mode');
        const tabPipeline = document.getElementById('tab-pipeline-mode');

        if (mode === 'agenda') {
            if (agendaContainer) agendaContainer.style.display = 'block';
            if (pipelineContainer) pipelineContainer.style.display = 'none';
            if (tabAgenda) tabAgenda.className = 'btn-primary';
            if (tabPipeline) tabPipeline.className = 'btn-secondary';
            renderDailyAgenda();
        } else {
            if (agendaContainer) agendaContainer.style.display = 'none';
            if (pipelineContainer) pipelineContainer.style.display = 'block';
            if (tabAgenda) tabAgenda.className = 'btn-secondary';
            if (tabPipeline) tabPipeline.className = 'btn-primary';
            renderList();
        }
    }
}

function setAgendaFilter(filterKey) {
    currentAgendaFilter = filterKey;
    renderDailyAgenda();
}

function renderDailyAgenda() {
    if (typeof CrmFollowUpCalc === 'undefined') return;

    const tbody = document.getElementById('agenda-table-body');
    const emptyState = document.getElementById('agenda-empty-state');
    const tableWrapper = document.getElementById('agenda-table-wrapper');
    const counterBadge = document.getElementById('agenda-badge-counter');
    const sellerWrap = document.getElementById('agenda-seller-filter-wrap');
    const sellerSelect = document.getElementById('agenda-seller-select');
    const escaladasPill = document.getElementById('filter-agenda-escaladas');

    const isManager = currentUser && currentUser.role === 'manager';

    // Manejar selector de comercial y botón de escaladas EXCLUSIVAMENTE para Manager
    if (sellerWrap) {
        sellerWrap.style.display = isManager ? 'flex' : 'none';
        if (isManager && sellerSelect) {
            const curVal = sellerSelect.value || 'all';
            const expectedStatic = 2; // 'all' y 'manager_only'
            const activeUsers = (users || []).filter(u => u && u.activo !== false && (u.role === 'vendedor' || u.role === 'gestor'));
            const dynamicCount = sellerSelect.options.length - expectedStatic;

            if (dynamicCount !== activeUsers.length || sellerSelect.options.length < 2) {
                sellerSelect.innerHTML = `
                    <option value="all">👥 Todos los comerciales</option>
                    <option value="manager_only">🛡️ Mi Agenda (Escalaciones y Leads Propios)</option>
                `;
                activeUsers.forEach(u => {
                    const opt = document.createElement('option');
                    opt.value = u.id;
                    opt.textContent = `👤 ${u.nombre || u.id} (${u.role === 'gestor' ? 'Gestor' : 'Vendedor'})`;
                    sellerSelect.appendChild(opt);
                });
                sellerSelect.value = curVal;
            }
        }
    }

    if (escaladasPill) {
        escaladasPill.style.display = isManager ? 'inline-flex' : 'none';
    }

    // Filtrar universo de oportunidades por comercial si el Manager seleccionó en el dropdown
    let targetUniverse = prospects;
    let agendaUser = currentUser;
    if (isManager && sellerSelect) {
        if (sellerSelect.value === 'all') {
            // "Todos los comerciales": el Gerente inspecciona la agenda consolidada de todo el equipo comercial
            agendaUser = { ...currentUser, viewAll: true };
            targetUniverse = prospects;
        } else if (sellerSelect.value === 'manager_only') {
            // "Mi Agenda": el Gerente solo ve sus oportunidades propias y escalaciones gerenciales
            agendaUser = { ...currentUser, viewAll: false };
            targetUniverse = prospects;
        } else {
            const selId = sellerSelect.value;
            targetUniverse = prospects.filter(p => p && (p.vendedorId === selId || (!p.vendedorId && p.createdBy === selId)));
            const matchedSeller = (Array.isArray(users) ? users.find(u => u && (u.id === selId || u.cid === selId)) : null) || { id: selId, cid: selId, role: 'vendedor' };
            agendaUser = matchedSeller;
        }
    }

    // Deduplicación preventiva de targetUniverse para garantizar ausencia de registros duplicados
    const uniqueMap = new Map();
    (targetUniverse || []).forEach(p => {
        if (p && p.id && !uniqueMap.has(p.id)) {
            uniqueMap.set(p.id, p);
        }
    });
    targetUniverse = Array.from(uniqueMap.values());

    const agendaData = CrmFollowUpCalc.generateAgenda(targetUniverse, agendaUser, currentAgendaFilter, new Date(), users);

    // Actualizar contadores en píldoras
    const counts = agendaData.counts;
    const elTodas = document.getElementById('count-agenda-todas');
    if (elTodas) elTodas.textContent = counts.total;
    const elVencidas = document.getElementById('count-agenda-vencidas');
    if (elVencidas) elVencidas.textContent = counts.vencidas;
    const elHoy = document.getElementById('count-agenda-hoy');
    if (elHoy) elHoy.textContent = counts.hoy;
    const elProximas = document.getElementById('count-agenda-proximas');
    if (elProximas) elProximas.textContent = counts.proximas;
    const elPendientes = document.getElementById('count-agenda-pendientes');
    if (elPendientes) elPendientes.textContent = counts.pendientes_decision;
    const elEscaladas = document.getElementById('count-agenda-escaladas');
    if (elEscaladas) elEscaladas.textContent = counts.escaladas_gerencia;

    // Badge superior (vencidas + hoy + pendientes)
    const urgentesCount = counts.vencidas + counts.hoy + counts.pendientes_decision;
    if (counterBadge) {
        counterBadge.textContent = urgentesCount;
        counterBadge.style.display = urgentesCount > 0 ? 'inline-block' : 'none';
    }

    // Actualizar clases activas en píldoras
    ['todas', 'vencidas', 'hoy', 'proximas', 'pendientes_decision', 'escaladas_gerencia'].forEach(key => {
        const pillId = key === 'pendientes_decision' ? 'filter-agenda-pendientes' : (key === 'escaladas_gerencia' ? 'filter-agenda-escaladas' : `filter-agenda-${key}`);
        const btn = document.getElementById(pillId);
        if (btn) {
            if (key === currentAgendaFilter) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    if (!tbody) return;
    tbody.innerHTML = '';

    if (agendaData.items.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableWrapper) tableWrapper.style.display = 'block';

    agendaData.items.forEach(item => {
        const p = item.prospect;
        const c = item.classification;
        const tr = document.createElement('tr');
        tr.classList.add('cursor-pointer');
        tr.onclick = () => openDetail(item.id);

        let rowClass = '';
        let badgeHtml = '';

        if (c.isEscaladoGerencia) {
            rowClass = 'agenda-row-vencida';
            badgeHtml = `<span class="badge badge-urgency-escalada">🚨 Escalada Gerencia</span>`;
        } else if (c.status === 'vencida') {
            rowClass = 'agenda-row-vencida';
            badgeHtml = `<span class="badge badge-urgency-vencida">🚨 Vencida (${c.dias_retraso}d)</span>`;
        } else if (c.status === 'hoy') {
            rowClass = 'agenda-row-hoy';
            badgeHtml = `<span class="badge badge-urgency-hoy">📌 Para Hoy</span>`;
        } else if (c.status === 'proxima') {
            rowClass = 'agenda-row-proxima';
            badgeHtml = `<span class="badge badge-urgency-proxima">⏳ Próxima</span>`;
        } else if (c.status === 'pendiente_decision') {
            rowClass = 'agenda-row-decision';
            badgeHtml = `<span class="badge badge-urgency-decision">⚠️ Decisión (${c.intentos_fallidos} int.)</span>`;
        } else {
            badgeHtml = `<span class="badge bg-neutral">📋 Sin Seguimiento</span>`;
        }

        if (rowClass) tr.classList.add(rowClass);

        // Última gestión
        let ultGestionHtml = '<span style="color:var(--text-muted); font-size:0.8rem;">Sin contactos previos</span>';
        if (c.ultimo_contacto && c.ultimo_contacto.fecha) {
            const dateStr = formatDate(c.ultimo_contacto.fecha);
            const canalLbl = CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[c.ultimo_contacto.canal] || c.ultimo_contacto.canal;
            const resLbl = CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[c.ultimo_contacto.resultado] || c.ultimo_contacto.resultado;
            ultGestionHtml = `
                <div style="font-size:0.82rem;"><strong>${escapeHtmlDoc(canalLbl)}</strong> (${dateStr})</div>
                <div style="font-size:0.75rem; color:var(--text-secondary); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtmlDoc(resLbl)}">${escapeHtmlDoc(resLbl)}</div>
            `;
        }

        // Próxima acción / motivo
        let proxAccionHtml = '';
        if (c.proxima_accion && c.proxima_accion.fecha) {
            let satBadge = '';
            const workCal = (typeof CrmWorkCalendar !== 'undefined' ? CrmWorkCalendar : (typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null));
            if (workCal && workCal.isHalfDay(c.proxima_accion.fecha)) {
                satBadge = ' <span style="font-size:0.7rem; color:var(--brand-gold); background:rgba(255,204,77,0.15); padding:1px 4px; border-radius:3px;" title="Sábado: Media jornada 8:00 a 12:00">Sáb 8-12h</span>';
            }
            proxAccionHtml = `
                <div style="font-size:0.82rem; font-weight:600; color:white;">📅 ${c.proxima_accion.fecha}${satBadge}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary); max-width:220px;" title="${escapeHtmlDoc(c.proxima_accion.descripcion || c.motivo_agenda)}">${escapeHtmlDoc(c.proxima_accion.descripcion || c.motivo_agenda)}</div>
            `;
        } else {
            proxAccionHtml = `<div style="font-size:0.78rem; color:var(--warning); line-height:1.3;">${escapeHtmlDoc(c.motivo_agenda)}</div>`;
        }

        const clientName = getClientName(item.clientId);

        tr.innerHTML = `
            <td>${badgeHtml}</td>
            <td><strong style="color:var(--brand-gold);">${escapeHtmlDoc(item.codigo)}</strong></td>
            <td>
                <div style="font-weight:600; color:white;">${escapeHtmlDoc(item.proyecto)}</div>
                <div style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtmlDoc(clientName)}</div>
            </td>
            <td><span class="badge" style="text-transform:capitalize;">${escapeHtmlDoc(item.etapa)}</span></td>
            <td><span style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtmlDoc(item.vendedorName)}</span></td>
            <td>${ultGestionHtml}</td>
            <td>${proxAccionHtml}</td>
            <td style="text-align:right;" onclick="event.stopPropagation()">
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                    <button class="btn-success" style="padding:4px 8px; font-size:0.75rem;" onclick="openRecordFollowUpModal('${item.id}')" title="Registrar contacto comercial">📞 Gestionar</button>
                    <button class="btn-secondary" style="padding:4px 8px; font-size:0.75rem;" onclick="openDetail('${item.id}')" title="Ver expediente">👁️</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openRecordFollowUpModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    currentProspectId = prospectId;
    const idInput = document.getElementById('followup-prospect-id');
    if (idInput) idInput.value = prospectId;

    const subEl = document.getElementById('followup-modal-subtitle');
    if (subEl) {
        subEl.textContent = `Proyecto: ${p.proyecto || '-'} (${p.codigo || p.id.slice(-4)}) | Cliente: ${getClientName(p.clientId)}`;
    }

    const clasif = typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc.classifyFollowUp(p, new Date()) : { intentos_fallidos: 0, llamada_obligatoria: false };
    const intentos = clasif.intentos_fallidos || 0;

    // Alerta contextual
    const alertBox = document.getElementById('followup-cadence-alert-box');
    if (alertBox) {
        if (intentos >= 5 || clasif.isEscaladoGerencia) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(239, 68, 68, 0.2)';
            alertBox.style.border = '1px solid var(--danger)';
            alertBox.style.color = '#fca5a5';
            alertBox.innerHTML = `<strong>🚨 Oportunidad Escalada a Gerencia:</strong> Esta oportunidad acumula ${intentos} intentos sin respuesta del cliente. La continuidad debe ser revisada por la gerencia.`;
        } else if (intentos >= 3 || clasif.isDecisionVendedor) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(245, 158, 11, 0.2)';
            alertBox.style.border = '1px solid var(--warning)';
            alertBox.style.color = '#fde68a';
            alertBox.innerHTML = `<strong>⚠️ Decisión Comercial Requerida:</strong> Acumula 3 intentos sin respuesta. Debes justificar la continuidad para programar un siguiente contacto.`;
        } else if (clasif.llamada_obligatoria) {
            alertBox.style.display = 'block';
            alertBox.style.background = 'rgba(59, 130, 246, 0.2)';
            alertBox.style.border = '1px solid #3b82f6';
            alertBox.style.color = '#bfdbfe';
            alertBox.innerHTML = `<strong>📞 Llamada Obligatoria:</strong> Al no haber respuesta en el primer intento, la cadencia comercial establece que el segundo contacto debe realizarse por llamada telefónica.`;
        } else {
            alertBox.style.display = 'none';
        }
    }

    // Canal y resultado iniciales
    const canalEl = document.getElementById('followup-canal');
    const resultadoEl = document.getElementById('followup-resultado');
    if (canalEl) {
        canalEl.value = clasif.llamada_obligatoria ? 'llamada' : 'llamada';
    }
    if (resultadoEl) {
        resultadoEl.value = 'respondio_evaluando';
    }

    // Detalle limpio
    const detalleEl = document.getElementById('followup-detalle');
    if (detalleEl) detalleEl.value = '';

    const cadencia = (p.seguimiento && p.seguimiento.cadencia) || {};

    // Sección de justificación tras 3 intentos
    const decisionBox = document.getElementById('followup-decision-box');
    const justifInput = document.getElementById('followup-justificacion');
    if (decisionBox) {
        decisionBox.style.display = intentos >= 3 ? 'block' : 'none';
        if (justifInput) justifInput.value = cadencia.justificacion_continuidad || '';
    }

    // Cuadro explicativo de cliente no continúa (oculto por defecto)
    const noContinuaBox = document.getElementById('followup-no-continua-box');
    if (noContinuaBox) noContinuaBox.style.display = 'none';
    const proxFechaGroup = document.getElementById('followup-prox-fecha-group');
    if (proxFechaGroup) proxFechaGroup.style.display = 'block';
    const proxTipoGroup = document.getElementById('followup-prox-tipo-group');
    if (proxTipoGroup) proxTipoGroup.style.display = 'block';
    const proxDescGroup = document.getElementById('followup-prox-desc-group');
    if (proxDescGroup) proxDescGroup.style.display = 'block';

    // Próxima acción sugerida
    updateSuggestedFollowUpDate();

    // Mostrar modal
    openModal('followUpModal');
}

function updateSuggestedFollowUpDate() {
    if (typeof CrmFollowUpCalc === 'undefined') return;
    const resultadoEl = document.getElementById('followup-resultado');
    const proxFechaEl = document.getElementById('followup-prox-fecha');
    const sugerenciaEl = document.getElementById('followup-prox-sugerencia');
    if (!resultadoEl || !proxFechaEl) return;

    const res = resultadoEl.value;
    const pid = (document.getElementById('followup-prospect-id') && document.getElementById('followup-prospect-id').value) || currentProspectId;
    const p = prospects.find(x => x.id === pid);
    const curCadence = (p && p.seguimiento && p.seguimiento.cadencia) || {};
    const intentos = (curCadence && curCadence.intentos_fallidos) || 0;
    const tipoCadencia = curCadence.tipo_cadencia || 'estandar';
    const cadConfig = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.getCadenceConfig)
        ? CrmFollowUpCalc.getCadenceConfig(tipoCadencia)
        : { dias_primer_contacto: 5, intervalo_sin_respuesta: 2, dias_solicito_tiempo: 15, nombre: 'Estándar Ductsal' };

    const canalEl = document.getElementById('followup-canal');
    const canal = canalEl ? canalEl.value : 'llamada';
    const isInternal = canal === 'interno';

    const suggested = CrmFollowUpCalc.suggestNextContactDate(new Date(), res, intentos, { channel: canal, isInternal, cadenceConfig: cadConfig });
    if (suggested) {
        const ymd = CrmFollowUpCalc.formatDateYMD(suggested);
        proxFechaEl.value = ymd;
    } else {
        if (res === 'no_continua') {
            proxFechaEl.value = '';
        }
    }

    if (sugerenciaEl) {
        const cadLbl = cadConfig.nombre || tipoCadencia;
        if (res === 'solicito_tiempo') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.dias_solicito_tiempo} días calendario acordados`;
        } else if (res === 'sin_respuesta') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.intervalo_sin_respuesta} días hábiles (salta fines de semana y asuetos)`;
        } else if (res === 'solicito_cambios') {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.dias_primer_contacto} días hábiles para cotizar cambios`;
        } else if (res === 'no_continua') {
            sugerenciaEl.textContent = '💡 Cliente no continúa: No se programa seguimiento automático (la oportunidad no se marca como perdida).';
        } else if (res === 'nota_interna') {
            sugerenciaEl.textContent = '💡 Nota interna: No altera la cadencia comercial con el cliente.';
        } else {
            sugerenciaEl.textContent = `💡 Sugerencia (${cadLbl}): +${cadConfig.intervalo_sin_respuesta} días hábiles`;
        }

        if (suggested) {
            const ymd = CrmFollowUpCalc.formatDateYMD(suggested);
            const workCal = (typeof CrmWorkCalendar !== 'undefined' ? CrmWorkCalendar : (typeof CrmFollowUpCalc.getWorkCalendar === 'function' ? CrmFollowUpCalc.getWorkCalendar() : null));
            if (isInternal && workCal && workCal.isHalfDay(ymd)) {
                sugerenciaEl.textContent += ' [Programado para sábado: Media jornada interna 8:00 - 12:00]';
            }
        }
    }
}

function handleFollowUpCanalChange() {
    const canalEl = document.getElementById('followup-canal');
    const resultadoEl = document.getElementById('followup-resultado');
    if (!canalEl || !resultadoEl) return;

    if (canalEl.value === 'interno') {
        let optInterna = Array.from(resultadoEl.options).find(o => o.value === 'nota_interna');
        if (optInterna) optInterna.style.display = 'block';
        resultadoEl.value = 'nota_interna';
    } else {
        if (resultadoEl.value === 'nota_interna') {
            resultadoEl.value = 'respondio_evaluando';
        }
    }
    updateSuggestedFollowUpDate();
}

function handleFollowUpResultadoChange() {
    const resultadoEl = document.getElementById('followup-resultado');
    const decisionBox = document.getElementById('followup-decision-box');
    const noContinuaBox = document.getElementById('followup-no-continua-box');
    const proxFechaGroup = document.getElementById('followup-prox-fecha-group');
    const proxTipoGroup = document.getElementById('followup-prox-tipo-group');
    const proxDescGroup = document.getElementById('followup-prox-desc-group');
    const pid = (document.getElementById('followup-prospect-id') && document.getElementById('followup-prospect-id').value) || currentProspectId;
    const p = prospects.find(x => x.id === pid);
    const intentos = (p && p.seguimiento && p.seguimiento.cadencia && p.seguimiento.cadencia.intentos_fallidos) || 0;

    const resVal = resultadoEl ? resultadoEl.value : '';
    const isNoContinua = resVal === 'no_continua';

    if (decisionBox) {
        decisionBox.style.display = (resVal === 'sin_respuesta' && intentos >= 3) ? 'block' : 'none';
    }
    if (noContinuaBox) {
        noContinuaBox.style.display = isNoContinua ? 'block' : 'none';
    }
    if (proxFechaGroup) proxFechaGroup.style.display = isNoContinua ? 'none' : 'block';
    if (proxTipoGroup) proxTipoGroup.style.display = isNoContinua ? 'none' : 'block';
    if (proxDescGroup) proxDescGroup.style.display = isNoContinua ? 'none' : 'block';

    updateSuggestedFollowUpDate();
}

async function processSaveFollowUp(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('followup-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const canal = document.getElementById('followup-canal').value;
    const resultado = document.getElementById('followup-resultado').value;
    const detalle = document.getElementById('followup-detalle').value.trim();

    if (!detalle) {
        return alert('Por favor describe el detalle de la gestión.');
    }

    const proxFecha = document.getElementById('followup-prox-fecha').value;
    const proxTipo = document.getElementById('followup-prox-tipo').value;
    const proxDesc = document.getElementById('followup-prox-desc').value.trim();

    const justifInput = document.getElementById('followup-justificacion');
    const justificacionContinuidad = justifInput ? justifInput.value.trim() : '';

    const payload = {
        canal,
        resultado,
        detalle,
        proxima_accion: proxFecha ? { fecha: proxFecha, tipo: proxTipo, descripcion: proxDesc } : undefined,
        justificacion_continuidad: justificacionContinuidad || undefined
    };

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const btn = document.getElementById('btn-save-followup');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.recordFollowUp(fb, { prospectId, followUp: payload, dbSuffix: DB_SUFFIX });
        if (res && res.seguimiento) {
            p.seguimiento = res.seguimiento;
            if (!Array.isArray(p.logs)) p.logs = [];
            const canalLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[canal]) || canal;
            const resLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[resultado]) || resultado;
            const logText = `[GESTIÓN COMERCIAL] ${canalLbl} -> ${resLbl}. Detalle: ${detalle}`;
            p.logs.push({ text: `(${currentUser ? currentUser.nombre : 'Comercial'}) ${logText}`, date: new Date().toISOString(), auto: false });
        }

        closeModal('followUpModal');
        renderDailyAgenda();
        renderList();

        if (currentProspectId === prospectId) {
            renderFollowUpSummary(p);
            renderLogs(p);
        }
    } catch (err) {
        alert(CrmCommercial.errorMessage(err));
        console.error(err);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function renderFollowUpSummary(p) {
    const badgeEl = document.getElementById('detail-followup-badge');
    const summaryEl = document.getElementById('detail-followup-summary');
    if (!summaryEl) return;

    if (!p) {
        summaryEl.innerHTML = '';
        return;
    }

    const clasif = typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc.classifyFollowUp(p, new Date()) : null;

    if (badgeEl) {
        if (!clasif || clasif.status === 'inactivo') {
            badgeEl.className = 'badge bg-neutral';
            badgeEl.textContent = (p.estado || 'Activo').toUpperCase();
        } else if (clasif.isEscaladoGerencia) {
            badgeEl.className = 'badge badge-urgency-escalada';
            badgeEl.textContent = '🚨 Escalada a Gerencia';
        } else if (clasif.status === 'vencida') {
            badgeEl.className = 'badge badge-urgency-vencida';
            badgeEl.textContent = `🚨 Vencida (${clasif.dias_retraso}d)`;
        } else if (clasif.status === 'hoy') {
            badgeEl.className = 'badge badge-urgency-hoy';
            badgeEl.textContent = '📌 Para Hoy';
        } else if (clasif.status === 'proxima') {
            badgeEl.className = 'badge badge-urgency-proxima';
            badgeEl.textContent = '⏳ Próxima';
        } else if (clasif.status === 'pendiente_decision') {
            badgeEl.className = 'badge badge-urgency-decision';
            badgeEl.textContent = '⚠️ Decisión';
        } else {
            badgeEl.className = 'badge bg-neutral';
            badgeEl.textContent = '📋 Al día';
        }
    }

    const seg = (p.seguimiento && typeof p.seguimiento === 'object') ? p.seguimiento : {};
    const cad = (seg.cadencia && typeof seg.cadencia === 'object') ? seg.cadencia : {};
    const ult = (seg.ultimo_contacto && typeof seg.ultimo_contacto === 'object') ? seg.ultimo_contacto : null;
    const prox = (seg.proxima_accion && typeof seg.proxima_accion === 'object') ? seg.proxima_accion : null;
    const hist = Array.isArray(seg.historial_gestiones) ? seg.historial_gestiones : [];

    const intentos = Number(cad.intentos_fallidos) || 0;

    let ultHtml = '<span style="color:var(--text-muted); font-style:italic;">Sin contactos previos registrados</span>';
    if (ult && ult.fecha) {
        const canalLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[ult.canal]) || ult.canal;
        const resLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[ult.resultado]) || ult.resultado;
        const resColor = (ult.resultado === 'contacto_positivo' || ult.resultado === 'reunion_agendada') ? 'var(--brand-gold)' : 'var(--text-secondary)';
        ultHtml = `<div><strong>${escapeHtmlDoc(canalLbl)}</strong> (${formatDate(ult.fecha)})</div><div style="color:${resColor}; font-size:0.8rem; margin-top:2px;">${escapeHtmlDoc(resLbl)}</div>`;
    }

    let proxHtml = '<span style="color:var(--text-muted); font-style:italic;">Sin próxima acción programada</span>';
    if (prox && prox.fecha) {
        proxHtml = `<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;"><strong style="color:white; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; font-size:0.82rem;">📅 ${prox.fecha}</strong> ${prox.descripcion ? `<span style="color:var(--text-secondary); font-size:0.82rem;">${escapeHtmlDoc(prox.descripcion)}</span>` : ''}</div>`;
    }

    // Historial de gestiones estructuradas
    let histHtml = '';
    if (hist.length > 0) {
        histHtml = `<div style="margin-top:10px; border-top:1px solid var(--panel-border); padding-top:8px;">
            <div style="font-size:0.78rem; font-weight:700; color:var(--text-secondary); margin-bottom:6px;">Historial de Gestiones (${hist.length}):</div>`;
        const reversed = hist.slice().reverse().slice(0, 5); // últimas 5
        reversed.forEach(g => {
            const cLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_CHANNEL_LABELS[g.canal]) || g.canal;
            const rLbl = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.FOLLOWUP_RESULT_LABELS[g.resultado]) || g.resultado;
            histHtml += `
                <div class="followup-history-item ${!g.es_contacto_valido ? 'no-contact' : ''}">
                    <div><strong>${formatDate(g.fecha)}</strong> — <strong>${escapeHtmlDoc(cLbl)}</strong> por ${escapeHtmlDoc(g.usuarioNombre || 'Comercial')}</div>
                    <div style="color:var(--brand-gold);">${escapeHtmlDoc(rLbl)}</div>
                    ${g.detalle ? `<div style="color:var(--text-secondary); margin-top:2px;">${escapeHtmlDoc(g.detalle)}</div>` : ''}
                </div>
            `;
        });
        histHtml += `</div>`;
    }

    const etapa = p.etapa || 'prospecto';
    const deliveryDate = p.fecha_entrega_oferta || cad.fecha_entrega_oferta || null;
    let deliveryHtml = '';
    if (deliveryDate) {
        const ymd = (typeof CrmFollowUpCalc !== 'undefined') ? CrmFollowUpCalc.getCommercialYMD(deliveryDate) : String(deliveryDate).slice(0, 10);
        const deliverer = cad.entregado_por_nombre ? ` <span style="color:var(--text-secondary); font-size:0.75rem;">(por ${escapeHtmlDoc(cad.entregado_por_nombre)})</span>` : '';
        deliveryHtml = `
            <div class="followup-card-row">
                <div class="followup-card-row-header"><span>📅 Fecha de Entrega de Oferta</span></div>
                <div class="followup-card-row-content">
                    <strong style="color:white;">${ymd}</strong>${deliverer}
                </div>
            </div>`;
    } else if (etapa === 'negociacion' || etapa === 'cierre') {
        deliveryHtml = `
            <div class="followup-card-row">
                <div class="followup-card-row-header"><span>📅 Fecha de Entrega de Oferta</span></div>
                <div class="followup-card-row-content">
                    <span class="badge" style="background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); font-size:0.75rem; white-space:normal; line-height:1.3;">⚠️ Sin fecha de entrega de oferta registrada (Histórica)</span>
                </div>
            </div>`;
    }

    const tipoCadencia = cad.tipo_cadencia || 'estandar';
    const cadConfig = (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.getCadenceConfig) ? CrmFollowUpCalc.getCadenceConfig(tipoCadencia) : { nombre: 'Estándar Ductsal' };
    const isAssigned = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const canChangeCadence = p.estado === 'activo' && !!currentUser && (currentUser.role === 'manager' || isAssigned);

    const cadenceChangeBtn = canChangeCadence
        ? `<button type="button" class="btn-secondary" onclick="openCadenceModal('${p.id}')" style="padding:2px 8px; font-size:0.7rem; border-radius:4px; cursor:pointer;" title="Configurar cadencia comercial">⚙️ Cambiar</button>`
        : '';

    let cadHistHtml = '';
    const cadHist = Array.isArray(cad.historial_cambios) ? cad.historial_cambios : [];
    if (cadHist.length > 0) {
        cadHistHtml = `<div style="margin-top:6px; border-top:1px dashed rgba(255,255,255,0.08); padding-top:6px; font-size:0.75rem; color:var(--text-secondary);">
            <div style="font-weight:700; color:var(--text-muted); margin-bottom:4px;">Historial de Cambios de Cadencia:</div>
            ${cadHist.map(h => {
                const fStr = (typeof formatDate === 'function') ? formatDate(h.fecha) : h.fecha;
                return `<div style="margin-bottom:2px;">• <strong>${fStr}</strong>: ${escapeHtmlDoc(h.cadenciaAnterior)} ➔ <strong>${escapeHtmlDoc(h.cadenciaNueva)}</strong> por ${escapeHtmlDoc(h.usuarioNombre || 'Comercial')}. <span style="color:var(--text-muted); font-style:italic;">"${escapeHtmlDoc(h.motivo || '')}"</span></div>`;
            }).join('')}
        </div>`;
    }

    summaryEl.innerHTML = `
        <div class="followup-panel-card">
            <div class="followup-card-row">
                <div class="followup-card-row-header">
                    <span>💬 Último Contacto</span>
                </div>
                <div class="followup-card-row-content">
                    ${ultHtml}
                </div>
            </div>

            <div class="followup-card-row">
                <div class="followup-card-row-header">
                    <span>🎯 Próxima Acción</span>
                </div>
                <div class="followup-card-row-content">
                    ${proxHtml}
                </div>
            </div>

            ${deliveryHtml}

            <div class="followup-cadence-grid">
                <div class="followup-card-row">
                    <div class="followup-card-row-header">
                        <span>⏱️ Cadencia</span>
                    </div>
                    <div class="followup-card-row-content" style="display:flex; align-items:center; justify-content:space-between; gap:4px; flex-wrap:wrap; margin-top:2px;">
                        <span class="badge bg-neutral" style="font-size:0.75rem; border:1px solid var(--border-color);" title="${cadConfig.descripcion || ''}">
                            ${escapeHtmlDoc(cadConfig.nombre || tipoCadencia)}
                        </span>
                        ${cadenceChangeBtn}
                    </div>
                </div>

                <div class="followup-card-row">
                    <div class="followup-card-row-header">
                        <span>📞 Intentos</span>
                    </div>
                    <div class="followup-card-row-content" style="margin-top:2px;">
                        <span class="badge ${intentos >= 5 ? 'badge-urgency-escalada' : (intentos >= 3 ? 'badge-urgency-decision' : 'bg-neutral')}" style="font-size:0.75rem;">
                            ${intentos} de 5 fallidos
                        </span>
                    </div>
                </div>
            </div>

            ${cad.alerta_gerencial ? `
                <div style="padding:6px 10px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); border-radius:6px; font-size:0.78rem; color:#fca5a5; display:flex; align-items:center; gap:6px;">
                    <span>🚨</span> <strong>Alerta Gerencial Activa</strong> (Límite de 5 intentos alcanzado)
                </div>
            ` : ''}

            ${cad.justificacion_continuidad ? `
                <div style="font-size:0.75rem; color:var(--text-secondary); padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                    <strong style="color:var(--brand-gold);">Justificación continuidad:</strong> ${escapeHtmlDoc(cad.justificacion_continuidad)}
                </div>
            ` : ''}

            ${cadHistHtml}
        </div>
        ${histHtml}
    `;
}

function openCadenceModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;
    const modal = document.getElementById('cadenceModal');
    if (!modal) return;

    document.getElementById('cadence-prospect-id').value = prospectId;
    document.getElementById('cadence-modal-title').textContent = `Proyecto: ${p.codigo || ''} ${p.proyecto || ''}`;

    const curCadence = (p.seguimiento && p.seguimiento.cadencia) || {};
    const curTipo = curCadence.tipo_cadencia || 'estandar';
    const selectEl = document.getElementById('cadence-select-tipo');
    if (selectEl) {
        selectEl.value = curTipo;
        handleCadenceSelectChange();
    }

    const motivoEl = document.getElementById('cadence-motivo');
    if (motivoEl) motivoEl.value = '';

    modal.style.display = 'flex';
}

function handleCadenceSelectChange() {
    const selectEl = document.getElementById('cadence-select-tipo');
    const descBox = document.getElementById('cadence-desc-box');
    if (!selectEl || !descBox) return;

    const val = selectEl.value;
    if (typeof CrmFollowUpCalc !== 'undefined' && CrmFollowUpCalc.CADENCIAS_VALIDAS && CrmFollowUpCalc.CADENCIAS_VALIDAS[val]) {
        const c = CrmFollowUpCalc.CADENCIAS_VALIDAS[val];
        descBox.innerHTML = `<strong>${c.nombre}:</strong> ${c.descripcion}`;
    }
}

async function processSaveCadence(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('cadence-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const selectEl = document.getElementById('cadence-select-tipo');
    const motivoEl = document.getElementById('cadence-motivo');
    const tipoCadencia = selectEl ? selectEl.value : 'estandar';
    const motivo = motivoEl ? motivoEl.value.trim() : '';

    if (!motivo || motivo.length < 5) {
        return alert('Por favor indica el motivo comercial del cambio de cadencia (mínimo 5 caracteres).');
    }

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        return alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
    }

    const btn = document.getElementById('btn-save-cadence');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.updateProspectCadence(fb, { prospectId, tipoCadencia, motivo, dbSuffix: DB_SUFFIX });
        if (res && res.cadencia) {
            if (!p.seguimiento) p.seguimiento = {};
            p.seguimiento.cadencia = res.cadencia;
            if (res.seguimiento) p.seguimiento = res.seguimiento;
            if (!Array.isArray(p.logs)) p.logs = [];
            p.logs.push({
                text: `(${currentUser ? currentUser.nombre : 'Comercial'}) [CADENCIA COMERCIAL] Cadencia cambiada a "${tipoCadencia}". Motivo: ${motivo}`,
                date: new Date().toISOString(),
                auto: true
            });
        }

        closeModal('cadenceModal');
        renderDailyAgenda();
        renderList();
        if (currentProspectId === prospectId) {
            renderFollowUpSummary(p);
        }
    } catch (err) {
        console.error('Error al actualizar cadencia:', err);
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.errorMessage(err) : (err.message || 'Error al actualizar cadencia comercial.'));
    } finally {
        if (btn) btn.disabled = false;
    }
}

function openReclassifyModal(prospectId) {
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const idInput = document.getElementById('reclassify-prospect-id');
    const titleEl = document.getElementById('reclassify-modal-title');
    const selectEl = document.getElementById('reclassify-select');
    const motivoEl = document.getElementById('reclassify-motivo');

    if (idInput) idInput.value = prospectId;
    if (titleEl) {
        titleEl.textContent = `Proyecto: ${p.proyecto} (${getClientName(p.clientId)}) · Clasificación actual: ${p.clasificacion === 'presupuesto' ? 'Cotización para Presupuesto' : 'Oferta para Ejecución'}`;
    }
    if (selectEl) {
        selectEl.value = (p.clasificacion === 'presupuesto') ? 'ejecucion' : 'presupuesto';
    }
    if (motivoEl) motivoEl.value = '';

    handleReclassifySelectChange();
    openModal('reclassifyModal');
}

function handleReclassifySelectChange() {
    const selectEl = document.getElementById('reclassify-select');
    const descBox = document.getElementById('reclassify-desc-box');
    if (!selectEl || !descBox) return;

    if (selectEl.value === 'ejecucion') {
        descBox.innerHTML = '<strong>🏗️ Oferta para Ejecución:</strong> Representa una oportunidad con intención de compra/ejecución confirmada. Se incluye en el pronóstico ponderado y permite avanzar a la etapa de Negociación con seguimiento activo.';
    } else {
        descBox.innerHTML = '<strong>📐 Cotización para Presupuesto:</strong> Estimación referencial o de planificación presupuestaria del cliente. No infla el forecast comercial y permanece en cotización hasta que el cliente confirme intención de ejecución.';
    }
}

async function processSaveReclassification(event) {
    if (event) event.preventDefault();
    const prospectId = document.getElementById('reclassify-prospect-id').value;
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;

    const selectEl = document.getElementById('reclassify-select');
    const motivoEl = document.getElementById('reclassify-motivo');
    const clasificacion = selectEl ? selectEl.value : 'ejecucion';
    const motivo = motivoEl ? motivoEl.value.trim() : '';

    if (!motivo || motivo.length < 5) {
        return alert('Por favor indica el motivo comercial del cambio de clasificación (mínimo 5 caracteres).');
    }

    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial !== 'undefined' && !CrmCommercial.hasSessionSync(fb)) {
        return alert(CrmCommercial.NO_SESSION_MESSAGE);
    }

    const btn = document.getElementById('btn-save-reclassify');
    if (btn) btn.disabled = true;

    try {
        const res = await CrmCommercial.reclassifyProspect(fb, { prospectId, clasificacion, motivo, dbSuffix: DB_SUFFIX });
        if (res && res.clasificacion) {
            p.clasificacion = res.clasificacion;
            if (res.historial_clasificacion) {
                p.historial_clasificacion = res.historial_clasificacion;
            }
            if (!Array.isArray(p.logs)) p.logs = [];
            p.logs.push({
                text: `(${currentUser ? currentUser.nombre : 'Comercial'}) [CLASIFICACIÓN COMERCIAL] Clasificación cambiada a "${clasificacion === 'ejecucion' ? 'Oferta para ejecución' : 'Cotización para presupuesto'}". Motivo: ${motivo}`,
                date: new Date().toISOString(),
                auto: true
            });
        }

        closeModal('reclassifyModal');
        renderList();
        if (currentProspectId === prospectId) {
            renderTracker(p);
            renderInfo(p);
            const advContainer = document.getElementById('advance-form-container');
            if (advContainer) advContainer.innerHTML = '';
        }
    } catch (err) {
        console.error('Error al reclasificar prospecto:', err);
        alert(typeof CrmCommercial !== 'undefined' ? CrmCommercial.errorMessage(err) : (err.message || 'Error al cambiar clasificación comercial.'));
    } finally {
        if (btn) btn.disabled = false;
    }
}


function renderList() {
    let filtered = prospects;
    if (currentUser && (currentUser.role === 'gestor' || currentUser.role === 'vendedor')) {
        filtered = filtered.filter(p => p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    }
    const tbody = document.getElementById('opp-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Won prospects belong to Proyectos y Cobros module
    const baseProspects = filtered.filter(p => p.estado !== 'ganado');

    // Update status filter badge counters
    const countActivas = baseProspects.filter(p => p.estado !== 'perdido').length;
    const countPerdidas = baseProspects.filter(p => p.estado === 'perdido').length;
    const countTodas = baseProspects.length;

    const elActivas = document.getElementById('count-opp-activas');
    if (elActivas) elActivas.textContent = countActivas;
    const elPerdidas = document.getElementById('count-opp-perdidas');
    if (elPerdidas) elPerdidas.textContent = countPerdidas;
    const elTodas = document.getElementById('count-opp-todas');
    if (elTodas) elTodas.textContent = countTodas;

    // Update active class on status pills
    ['activas', 'perdidas', 'todas'].forEach(key => {
        const btn = document.getElementById(`filter-opp-${key}`);
        if (btn) {
            if (key === oppStatusFilter) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    // Update classification filter badge counters
    const countEjecucion = baseProspects.filter(p => (p.clasificacion || 'ejecucion') === 'ejecucion').length;
    const countPresupuesto = baseProspects.filter(p => p.clasificacion === 'presupuesto').length;

    const elEjecucion = document.getElementById('count-opp-ejecucion');
    if (elEjecucion) elEjecucion.textContent = countEjecucion;
    const elPresupuesto = document.getElementById('count-opp-presupuesto');
    if (elPresupuesto) elPresupuesto.textContent = countPresupuesto;

    ['todas', 'ejecucion', 'presupuesto'].forEach(key => {
        const btn = document.getElementById(`filter-clasif-${key}`);
        if (btn) {
            if (key === oppClasifFilter) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    // Apply status filter: default 'activas' strictly excludes lost opportunities
    let visibleProspects = baseProspects;
    if (oppStatusFilter === 'activas') {
        visibleProspects = baseProspects.filter(p => p.estado !== 'perdido');
    } else if (oppStatusFilter === 'perdidas') {
        visibleProspects = baseProspects.filter(p => p.estado === 'perdido');
    } else if (oppStatusFilter === 'todas') {
        visibleProspects = baseProspects;
    }

    // Apply classification filter
    if (oppClasifFilter === 'ejecucion') {
        visibleProspects = visibleProspects.filter(p => (p.clasificacion || 'ejecucion') === 'ejecucion');
    } else if (oppClasifFilter === 'presupuesto') {
        visibleProspects = visibleProspects.filter(p => p.clasificacion === 'presupuesto');
    }

    // Apply Search Filter
    const searchEl = document.getElementById('opp-search');
    const searchVal = (searchEl && typeof searchEl.value === 'string') ? searchEl.value.toLowerCase().trim() : '';
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
            const dateStr = formatProspectDate(p.fecha_creacion);
            const dateMatch = dateStr !== '-' && dateStr.toLowerCase().includes(searchVal);
            return codeMatch || clientMatch || projectMatch || vendorMatch || stageMatch || amountMatch || statusMatch || dateMatch;
        });
    }

    // Apply Date Range Filter (Fecha de Ingreso)
    const dateStartEl = document.getElementById('opp-date-start');
    const dateEndEl = document.getElementById('opp-date-end');
    const dateStartVal = (dateStartEl && typeof dateStartEl.value === 'string') ? dateStartEl.value : '';
    const dateEndVal = (dateEndEl && typeof dateEndEl.value === 'string') ? dateEndEl.value : '';
    const btnClearDates = document.getElementById('btn-clear-opp-dates');
    if (btnClearDates) {
        btnClearDates.style.display = (dateStartVal || dateEndVal) ? 'inline-block' : 'none';
    }

    if (dateStartVal || dateEndVal) {
        let startTime = null;
        let endTime = null;
        if (dateStartVal) {
            const [y, m, d] = dateStartVal.split('-').map(Number);
            startTime = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        }
        if (dateEndVal) {
            const [y, m, d] = dateEndVal.split('-').map(Number);
            endTime = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        }

        visibleProspects = visibleProspects.filter(p => {
            const pDate = parseProspectDate(p.fecha_creacion);
            if (!pDate) return false;
            const pTime = pDate.getTime();
            if (startTime !== null && pTime < startTime) return false;
            if (endTime !== null && pTime > endTime) return false;
            return true;
        });
    }

    // Update Counter Badge
    const countBadge = document.getElementById('opp-count-badge');
    if (countBadge) {
        countBadge.textContent = `${visibleProspects.length} ${visibleProspects.length === 1 ? 'oportunidad' : 'oportunidades'}`;
    }

    // Apply Sorting
    if (oppSortCol) {
        visibleProspects.sort((a, b) => {
            if (oppSortCol === 'fecha') {
                const dateA = parseProspectDate(a.fecha_creacion);
                const dateB = parseProspectDate(b.fecha_creacion);
                if (!dateA && !dateB) return 0;
                if (!dateA) return 1;
                if (!dateB) return -1;
                return oppSortDir === 'asc'
                    ? dateA.getTime() - dateB.getTime()
                    : dateB.getTime() - dateA.getTime();
            }

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
        const emptyMsg = oppStatusFilter === 'perdidas'
            ? 'No hay oportunidades marcadas como perdidas.'
            : 'No se encontraron oportunidades.';
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 2rem; color: var(--text-muted);">${emptyMsg}</td></tr>`;
        return;
    }

    visibleProspects.forEach(p => {
        const tr = document.createElement('tr'); tr.classList.add('cursor-pointer'); tr.onclick = () => openDetail(p.id);
        let badgeClass = p.estado === 'activo' ? 'activo' : 'perdido';

        // Calculate days in stage
        const timestamp = p.stage_timestamps && p.stage_timestamps[p.etapa] ? p.stage_timestamps[p.etapa] : p.fecha_creacion;
        const daysInStage = getDaysDifference(timestamp);

        const vendor = getProspectVendorInfo(p);
        const vendorBadge = vendor.role ? `<span style="font-size:0.75rem; color:var(--text-secondary); display:block;">(${vendor.role})</span>` : '';

        const isPresupuesto = p.clasificacion === 'presupuesto';
        const clasifBadge = isPresupuesto
            ? `<span class="badge" style="background: rgba(147, 51, 234, 0.15); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.35); font-size: 0.72rem; margin-left: 6px; display: inline-flex; align-items: center; gap: 3px;" title="Cotización referencial para presupuesto">📐 Presupuesto</span>`
            : `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 0.72rem; margin-left: 6px; display: inline-flex; align-items: center; gap: 3px;" title="Oferta para ejecución comercial">🏗️ Ejecución</span>`;

        tr.innerHTML = `<td>${p.codigo || p.id.substring(p.id.length - 4)}</td><td><strong>${getClientName(p.clientId)}</strong></td><td>${p.proyecto}${clasifBadge}</td><td><strong>${vendor.name}</strong>${vendorBadge}</td><td>${formatProspectDate(p.fecha_creacion)}</td><td style="text-transform: capitalize;">${p.etapa}</td><td>${p.precio_cotizado ? formatCurrency(p.precio_cotizado) : '-'}</td><td><span class="badge ${badgeClass}">${p.estado.toUpperCase()}</span></td><td><button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Ver</button></td>`;
        tbody.appendChild(tr);
    });
}

let projPaymentFilter = 'pendientes';

function getProjPaymentFilter() {
    return projPaymentFilter;
}

function setProjPaymentFilter(filterKey) {
    if (['pendientes', 'pagados', 'todos'].includes(filterKey)) {
        projPaymentFilter = filterKey;
        renderProjectsList();
    }
}

function renderProjectsList() {
    if (currentUser && currentUser.role === 'vendedor') {
        const tbody = document.getElementById('proj-table-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 2rem; color: var(--text-muted);">Acceso no autorizado a este módulo.</td></tr>';
        return;
    }
    const tbody = document.getElementById('proj-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const allProjects = prospects.filter(p => hasEnteredPostclosing(p));

    const countPendientes = allProjects.filter(p => !isProjectFullyPaid(p)).length;
    const countPagados = allProjects.filter(p => isProjectFullyPaid(p)).length;
    const countTodos = allProjects.length;

    const elPendientes = document.getElementById('count-proj-pendientes');
    if (elPendientes) elPendientes.textContent = countPendientes;
    const elPagados = document.getElementById('count-proj-pagados');
    if (elPagados) elPagados.textContent = countPagados;
    const elTodos = document.getElementById('count-proj-todos');
    if (elTodos) elTodos.textContent = countTodos;

    ['pendientes', 'pagados', 'todos'].forEach(key => {
        const btn = document.getElementById(`pill-proj-${key}`);
        if (btn) {
            if (key === projPaymentFilter) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    if (allProjects.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9">
                    <div class="table-empty-box">
                        <div style="font-size:2rem; margin-bottom:0.4rem;">📊</div>
                        <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">No hay proyectos cerrados / ganados todavía</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">Las oportunidades ganadas ingresarán automáticamente a este módulo.</div>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    let activeProjects = allProjects;
    if (projPaymentFilter === 'pendientes') {
        activeProjects = allProjects.filter(p => !isProjectFullyPaid(p));
    } else if (projPaymentFilter === 'pagados') {
        activeProjects = allProjects.filter(p => isProjectFullyPaid(p));
    }

    // Map projects to calculated objects for search and sort
    let mappedProjects = activeProjects.map(p => {
        const subtotal = typeof getProjectSubtotal === 'function' ? getProjectSubtotal(p) : (parseFloat(p.precio_cotizado) || 0);
        const client = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients.find(c => c.id === p.clientId) : null;
        const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
        const total = isExport ? Math.round(subtotal * 100) / 100 : Math.round(subtotal * 1.13 * 100) / 100;
        const fullyPaid = isProjectFullyPaid(p);

        let totalFacturado = 0;
        let totalCobrado = 0;
        if (Array.isArray(p.facturas)) {
            p.facturas.forEach(f => {
                const fm = parseFloat(f.monto);
                if (!isNaN(fm) && fm > 0) totalFacturado += fm;
                if (Array.isArray(f.pagos)) {
                    f.pagos.forEach(pay => {
                        const m = parseFloat(pay.monto);
                        if (!isNaN(m) && m > 0) totalCobrado += m;
                    });
                }
            });
        }

        const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
        const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;

        return {
            original: p,
            codigo: p.codigo || (p.id ? p.id.substring(p.id.length - 4) : '-'),
            cliente: getClientName(p.clientId),
            isExport: isExport,
            proyecto: p.proyecto || '',
            encargado: p.encargado || '',
            total: total,
            condicion: p.forma_pago || 'N/A',
            pctFacturado: pctFacturado,
            pctCobrado: pctCobrado,
            isFullyPaid: fullyPaid
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
        const filterMsg = projPaymentFilter === 'pagados'
            ? 'No hay proyectos completamente pagados.'
            : (projPaymentFilter === 'pendientes' ? 'No hay proyectos pendientes de cobro.' : 'No se encontraron proyectos.');
        tbody.innerHTML = `
            <tr>
                <td colspan="9">
                    <div class="table-empty-box">
                        <div style="font-size:2rem; margin-bottom:0.4rem;">🔍</div>
                        <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">${filterMsg}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">
                            ${searchVal ? 'Prueba cambiando los términos de búsqueda o el filtro de cobro.' : 'Puedes alternar entre pendientes, pagados o todos con los filtros superiores.'}
                        </div>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    mappedProjects.forEach(mp => {
        const p = mp.original;
        const tr = document.createElement('tr');
        tr.classList.add('cursor-pointer');
        tr.onclick = () => openDetail(p.id);

        const exportBadge = mp.isExport ? ' <span class="badge" style="background:rgba(33, 150, 243, 0.15); color:#60a5fa; border:1px solid rgba(33, 150, 243, 0.35); font-size:0.68rem; margin-left:4px; vertical-align:middle;">✈️ Exp</span>' : '';
        const encargadoDisplay = mp.encargado
            ? `<div class="cell-ellipsis" style="max-width:140px; color:var(--text-primary);" title="${escapeHtmlDoc(mp.encargado)}">${escapeHtmlDoc(mp.encargado)}</div>`
            : '<span style="color:var(--text-muted); font-style:italic; font-size:0.8rem;">No asignado</span>';

        const cobradoColor = mp.isFullyPaid ? 'var(--success)' : (mp.pctCobrado > 0 ? '#60a5fa' : 'var(--text-muted)');
        const cobradoBadge = mp.isFullyPaid
            ? '<span class="badge" style="background:rgba(16, 185, 129, 0.2); color:#10b981; border:1px solid rgba(16, 185, 129, 0.4); font-size:0.65rem; padding:1px 5px; margin-left:4px;">100% Pagado</span>'
            : '';

        tr.innerHTML = `
            <td style="white-space:nowrap;"><strong style="font-family:monospace; color:var(--brand-gold);">${escapeHtmlDoc(mp.codigo)}</strong></td>
            <td>
                <div class="cell-ellipsis" style="max-width:200px; font-weight:600; color:white;" title="${escapeHtmlDoc(mp.cliente)}">
                    ${escapeHtmlDoc(mp.cliente)}${exportBadge}
                </div>
            </td>
            <td>
                <div class="cell-ellipsis" style="max-width:220px; color:var(--text-primary);" title="${escapeHtmlDoc(mp.proyecto)}">
                    ${escapeHtmlDoc(mp.proyecto || '-')}
                </div>
            </td>
            <td>${encargadoDisplay}</td>
            <td style="white-space:nowrap; font-weight:700; color:white;">${formatCurrency(mp.total)}</td>
            <td style="white-space:nowrap;"><span class="badge bg-neutral" style="font-size:0.75rem;">${escapeHtmlDoc(mp.condicion)}</span></td>
            <td style="min-width:110px;">
                <div class="table-progress-wrap">
                    <div style="display:flex; justify-content:space-between; margin-bottom:2px; font-size:0.75rem;">
                        <span style="font-weight:600; color:white;">${mp.pctFacturado.toFixed(0)}%</span>
                    </div>
                    <div class="table-progress-bar">
                        <div class="table-progress-fill-facturado" style="width:${Math.min(100, mp.pctFacturado)}%;"></div>
                    </div>
                </div>
            </td>
            <td style="min-width:130px;">
                <div class="table-progress-wrap">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px; font-size:0.75rem;">
                        <span style="font-weight:600; color:${cobradoColor};">${mp.pctCobrado.toFixed(0)}%</span>
                        ${cobradoBadge}
                    </div>
                    <div class="table-progress-bar">
                        <div class="table-progress-fill-cobrado" style="width:${Math.min(100, mp.pctCobrado)}%;"></div>
                    </div>
                </div>
            </td>
            <td style="text-align:right; white-space:nowrap;">
                <button type="button" class="btn-table-action btn-table-edit" style="width:100%; justify-content:center;">
                    Gestionar ➔
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openNewModal() {
    renderClientSelect();
    const vendorGroup = document.getElementById('vendedor-assign-group');
    const vendorSelect = document.getElementById('new-vendedor-select');
    if (vendorGroup && vendorSelect) {
        if (currentUser && currentUser.role === 'manager') {
            vendorGroup.style.display = 'block';
            vendorSelect.innerHTML = `<option value="${currentUser.id}">Mismo Creador: ${currentUser.nombre} (Gerente)</option>`;
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

function openModal(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = 'flex';
        if (typeof document !== 'undefined' && document.body && document.body.classList) {
            document.body.classList.add('modal-open');
        }
    }
}

function closeModal(id) {
    if (id === 'clientModal') {
        cancelPendingClientReservation();
    }
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';

    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const openModals = document.querySelectorAll('.modal');
        let anyOpen = false;
        for (let i = 0; i < openModals.length; i++) {
            if (openModals[i].style.display === 'flex' || openModals[i].style.display === 'block') {
                anyOpen = true;
                break;
            }
        }
        if (!anyOpen && document.body && document.body.classList) {
            document.body.classList.remove('modal-open');
        }
    } else if (typeof document !== 'undefined' && document.body && document.body.classList) {
        document.body.classList.remove('modal-open');
    }
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

    const clasifEl = document.getElementById('new-clasificacion');
    const prospect = {
        clientId: clientId,
        proyecto: document.getElementById('new-proyecto').value,
        origen: document.getElementById('new-origen').value,
        tipo_proyecto: document.getElementById('new-tipo-proyecto').value,
        tipo_producto: document.getElementById('new-tipo-producto').value
    };
    if (clasifEl && clasifEl.value) {
        prospect.clasificacion = clasifEl.value;
    }
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
    if (currentUser && (currentUser.role === 'vendedor' || currentUser.role === 'gestor')) {
        const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);
        if (!isAssigned) {
            alert('No tienes acceso a esta oportunidad');
            showView('list-view');
            return;
        }
    }
    showView('detail-view');
    document.getElementById('detail-cliente').textContent = getClientName(p.clientId);
    document.getElementById('detail-proyecto').innerHTML = `${p.proyecto} <span class="badge bg-neutral ml-2">${p.codigo || ''}</span>`;
    document.getElementById('advance-form-container').innerHTML = '';
    const textEl = document.getElementById('new-log-text');
    if (textEl) textEl.value = '';

    const payForm = document.getElementById('payment-form'); if (payForm) payForm.style.display = 'none';
    const invForm = document.getElementById('invoice-form'); if (invForm) invForm.style.display = 'none';

    // Show Delete / Reactivate Prospect buttons for managers
    const btnDeleteProspect = document.getElementById('btn-delete-prospect');
    if (btnDeleteProspect) {
        btnDeleteProspect.style.display = (currentUser && currentUser.role === 'manager') ? 'inline-block' : 'none';
    }
    const btnReactivateProspect = document.getElementById('btn-reactivate-prospect');
    if (btnReactivateProspect) {
        btnReactivateProspect.style.display = (currentUser && currentUser.role === 'manager' && p.estado === 'perdido') ? 'inline-block' : 'none';
    }

    const actionContainer = document.getElementById('action-buttons-container');
    const finTracker = document.getElementById('financial-tracker-container');
    const stageTitleText = document.getElementById('stage-title-text');
    const stageWorkflowBox = document.getElementById('stage-workflow-box');

    const trackerContainer = document.getElementById('stage-tracker');

    if (p.estado === 'activo') {
        actionContainer.style.display = 'flex';
        finTracker.style.display = 'none';
        stageTitleText.parentElement.style.display = 'block';
        trackerContainer.style.display = 'flex';
        stageTitleText.textContent = "Avance de Etapa";
        const btnAdv = document.getElementById('btn-advance');
        if (btnAdv) btnAdv.style.display = p.etapa === 'cierre' ? 'none' : 'inline-flex';
        const btnNewProp = document.getElementById('btn-new-proposal');
        if (btnNewProp) btnNewProp.style.display = p.etapa === 'negociacion' ? 'inline-flex' : 'none';
        const btnLose = document.getElementById('btn-lose');
        if (btnLose) btnLose.style.display = 'inline-flex';
        if (stageWorkflowBox) stageWorkflowBox.style.display = 'block';
    } else if (p.estado === 'ganado' || (hasEnteredPostclosing(p) && currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor'))) {
        actionContainer.style.display = 'none'; finTracker.style.display = 'block'; stageTitleText.parentElement.style.display = 'none'; trackerContainer.style.display = 'none'; if (stageWorkflowBox) stageWorkflowBox.style.display = 'none'; renderFinancials(p);
    } else {
        actionContainer.style.display = 'none'; finTracker.style.display = 'none'; stageTitleText.parentElement.style.display = 'block'; trackerContainer.style.display = 'flex'; stageTitleText.textContent = "Línea de Tiempo";
        if (stageWorkflowBox) stageWorkflowBox.style.display = 'block';
    }

    let timeInStage = 0;
    if (p.stage_timestamps && p.stage_timestamps[p.etapa]) {
        timeInStage = getDaysDifference(p.stage_timestamps[p.etapa]);
    } else {
        timeInStage = getDaysDifference(p.fecha_creacion);
    }
    document.getElementById('detail-time-in-stage').textContent = `Tiempo en etapa: ${timeInStage} días`;
    renderTracker(p); renderInfo(p); renderLogs(p);
    renderFollowUpSummary(p);
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
    const isPresupuesto = p.clasificacion === 'presupuesto';
    const clasifBadge = isPresupuesto
        ? `<span class="badge" style="background: rgba(147, 51, 234, 0.2); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.45); font-size: 0.75rem; margin-left: 8px;">📐 Cotización para Presupuesto</span>`
        : `<span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.45); font-size: 0.75rem; margin-left: 8px;">🏗️ Oferta para Ejecución</span>`;

    const isAssigned = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const canReclassify = p.estado === 'activo' && !!currentUser && (currentUser.role === 'manager' || isAssigned);
    const reclassBtn = canReclassify
        ? `<button type="button" class="btn-secondary" onclick="openReclassifyModal('${p.id}')" style="padding: 2px 8px; font-size: 0.72rem; margin-left: 8px;" title="Cambiar clasificación comercial">🔄 Clasificación</button>`
        : '';

    document.getElementById('detail-badges').innerHTML = `<span class="badge ${p.estado === 'activo' ? 'activo' : (p.estado === 'ganado' ? 'ganado' : 'perdido')}">${(p.estado || 'activo').toUpperCase()}</span>${clasifBadge}${reclassBtn}`;
}

function renderInfo(p) {
    if (!p) return;
    if (!p.datos) p.datos = {};

    const vendor = getProspectVendorInfo(p);
    const daysTotal = getDaysDifference(p.fecha_creacion);
    const dateFormatted = formatProspectDate(p.fecha_creacion);

    const isAssignedBase = currentUser && (p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id));
    const canEditBase = !!currentUser && (currentUser.role === 'manager' || isAssignedBase) && p.estado === 'activo';
    const editBaseLink = canEditBase ? ` <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold); text-decoration:underline;" onclick="openEditBasePriceModal()">[Editar Costo/Precio]</span>` : '';

    // 1. Resumen Comercial / KPI Hero (Prioridad 2)
    const heroEtapa = document.getElementById('hero-etapa');
    if (heroEtapa) heroEtapa.textContent = p.etapa || '-';

    const heroVendedor = document.getElementById('hero-vendedor');
    if (heroVendedor) {
        heroVendedor.innerHTML = `<span>${vendor.name}</span> ${vendor.role ? `<span style="font-size:0.75rem; color:var(--text-secondary); font-weight:normal;">(${vendor.role})</span>` : ''}`;
    }
    const heroVendedorAction = document.getElementById('hero-vendedor-action');
    if (heroVendedorAction) {
        if (currentUser && currentUser.role === 'manager' && !hasEnteredPostclosing(p) && p.etapa !== 'cierre') {
            heroVendedorAction.innerHTML = `<span class="cursor-pointer" style="color:var(--brand-gold); text-decoration:underline;" onclick="reassignVendor('${p.id}')">🔄 Reasignar vendedor</span>`;
        } else {
            heroVendedorAction.innerHTML = '';
        }
    }

    const heroFecha = document.getElementById('hero-fecha');
    if (heroFecha) heroFecha.textContent = dateFormatted;

    const heroAntiguedad = document.getElementById('hero-antiguedad');
    if (heroAntiguedad) {
        heroAntiguedad.textContent = `${daysTotal} ${daysTotal === 1 ? 'día' : 'días'} desde ingreso`;
    }

    const heroPrecio = document.getElementById('hero-precio');
    if (heroPrecio) heroPrecio.textContent = p.precio_cotizado ? formatCurrency(p.precio_cotizado) : '-';

    const heroPrecioAction = document.getElementById('hero-precio-action');
    if (heroPrecioAction) heroPrecioAction.innerHTML = editBaseLink;

    const heroCosto = document.getElementById('hero-costo');
    if (heroCosto) heroCosto.textContent = p.costo_venta ? formatCurrency(p.costo_venta) : '-';

    const heroMargen = document.getElementById('hero-margen');
    if (heroMargen) {
        const numPrecio = parseFloat(p.precio_cotizado) || 0;
        const numCosto = parseFloat(p.costo_venta) || 0;
        if (numPrecio > 0) {
            const margenVal = numPrecio - numCosto;
            const margenPct = Math.round((margenVal / numPrecio) * 100);
            const margenColor = margenVal >= 0 ? 'var(--success)' : 'var(--danger)';
            heroMargen.style.color = margenColor;
            heroMargen.textContent = `Margen: ${formatCurrency(margenVal)} (${margenPct}%)`;
        } else {
            heroMargen.textContent = 'Margen: -';
        }
    }

    // 2. Información Complementaria en lista (Prioridad 4)
    const list = document.getElementById('info-list');
    if (list) {
        let vendorLinkHTML = `<li><strong style="color:var(--brand-gold)">Vendedor / Asesor:</strong> <strong>${vendor.name}</strong> ${vendor.role ? `<span style="color:var(--text-secondary)">(${vendor.role})</span>` : ''}`;
        if (currentUser && currentUser.role === 'manager' && !hasEnteredPostclosing(p) && p.etapa !== 'cierre') {
            vendorLinkHTML += ` <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="reassignVendor('${p.id}')">[Reasignar]</span>`;
        }
        vendorLinkHTML += `</li>`;

        const isPresupuesto = p.clasificacion === 'presupuesto';
        const clasifDesc = isPresupuesto ? '📐 Cotización para presupuesto' : '🏗️ Oferta para ejecución';
        list.innerHTML = `<li><strong>Creación:</strong> ${dateFormatted}</li>${vendorLinkHTML}<li><strong>Clasificación:</strong> <span style="font-weight:600; color: ${isPresupuesto ? '#c084fc' : '#93c5fd'}">${clasifDesc}</span></li><li><strong>Origen:</strong> ${p.origen || '-'}</li><li><strong>Tipo Proy:</strong> ${p.tipo_proyecto || '-'}</li><li><strong>Producto:</strong> ${p.tipo_producto || '-'}</li>`;

        if (Array.isArray(p.historial_clasificacion) && p.historial_clasificacion.length > 0) {
            const lastChg = p.historial_clasificacion[p.historial_clasificacion.length - 1];
            list.innerHTML += `<li style="font-size:0.75rem; color:var(--text-secondary); background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px; margin-top:4px;">
                🔄 <strong>Último cambio de clasificación:</strong> ${lastChg.fecha ? lastChg.fecha.slice(0, 16).replace('T', ' ') : '-'} por ${lastChg.usuarioNombre || 'Usuario'} (Motivo: "${lastChg.motivo || '-'}")
            </li>`;
        }

        if (p.datos.ubicacion) {
            list.innerHTML += `<li><span class="label">Ubicación:</span> ${p.datos.ubicacion}</li>`;
            if (p.datos.distancia) list.innerHTML += `<li><span class="label">Distancia a fábrica:</span> ${p.datos.distancia} km</li>`;
        }
        if (p.datos.visitante) list.innerHTML += `<li><strong>Visitó:</strong> ${p.datos.visitante} (${p.datos.fecha_visita || 'Sin fecha'})</li>`;
        if (p.datos.fecha_inicio) list.innerHTML += `<li><strong>Est. Inicio:</strong> ${p.datos.fecha_inicio}</li>`;
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
            list.innerHTML += `<li><strong style="color:var(--brand-gold)">Forma de Pago:</strong> ${p.forma_pago || '-'}</li>`;
            if (p.encargado) list.innerHTML += `<li><strong style="color:var(--brand-gold)">Encargado Inst.:</strong> ${p.encargado}</li>`;
        }
        if (p.estado === 'perdido') list.innerHTML += `<li><strong style="color:var(--danger)">Motivo Pérdida:</strong> ${p.motivo_perdida || '-'}</li>`;
    }

    // 3. Documentos Adjuntos (Prioridad 5)
    const docsList = document.getElementById('docs-list');
    if (!docsList) return;
    docsList.innerHTML = '';
    let hasDocs = false;
    let docCount = 0;

    function dlCard(doc, category) {
        if (!doc) return '';
        let name = typeof doc === 'object' ? (doc.name || 'Documento') : doc;
        let id = 'doc_' + Math.random().toString(36).substring(2, 9);
        if (typeof window !== 'undefined') {
            if (!window._docStore) window._docStore = new Map();
            window._docStore.set(id, doc);
        }
        const previewable = isFormatPreviewable(name);
        const pId = (p && p.id) ? p.id : '';
        const ext = String(name || '').split('.').pop().toUpperCase() || 'DOC';
        let icon = '📁';
        if (ext === 'PDF') icon = '📄';
        else if (ext === 'XLSX' || ext === 'XLS') icon = '📊';
        else if (['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].includes(ext)) icon = '🖼️';

        if (previewable) {
            return `<li class="doc-card-row">` +
                   `<div class="doc-card-info">` +
                   `<span class="doc-card-category">${escapeHtmlDoc(category)}</span>` +
                   `<span class="doc-card-name" title="${escapeHtmlDoc(name)}">${icon} ${escapeHtmlDoc(name)}</span>` +
                   `</div>` +
                   `<div class="doc-card-actions">` +
                   `<a href="javascript:void(0)" onclick="viewSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" class="btn-doc-view" title="Previsualizar en visor">👁️ Ver</a>` +
                   `<a href="javascript:void(0)" onclick="downloadSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" class="btn-doc-dl" title="Descargar archivo">⬇️ Descargar</a>` +
                   `</div>` +
                   `</li>`;
        } else {
            return `<li class="doc-card-row">` +
                   `<div class="doc-card-info">` +
                   `<span class="doc-card-category">${escapeHtmlDoc(category)}</span>` +
                   `<span class="doc-card-name" title="${escapeHtmlDoc(name)}">${icon} ${escapeHtmlDoc(name)}</span>` +
                   `</div>` +
                   `<div class="doc-card-actions">` +
                   `<a href="javascript:void(0)" onclick="downloadSecureDocument(window._docStore ? window._docStore.get('${id}') : null, '${escapeHtmlDoc(name)}', { prospectId: '${pId}' })" class="btn-doc-dl" title="Descargar archivo">⬇️ Descargar</a>` +
                   `</div>` +
                   `</li>`;
        }
    }

    function addDoc(field, category) {
        if (!field) return;
        if (Array.isArray(field)) {
            field.forEach(d => {
                if (d) {
                    docsList.innerHTML += dlCard(d, category);
                    docCount++;
                    hasDocs = true;
                }
            });
        } else {
            docsList.innerHTML += dlCard(field, category);
            docCount++;
            hasDocs = true;
        }
    }

    addDoc(p.datos.doc_levantamiento, 'Planos / Notas');
    addDoc(p.datos.doc_oferta, 'Oferta / Cotización');
    addDoc(p.datos.doc_costos, 'Cuadro de Costos');
    addDoc(p.datos.doc_oferta_firmada, 'Oferta Firmada');
    addDoc(p.datos.doc_contrato, 'Contrato');

    if (p.facturas && p.facturas.length > 0) {
        p.facturas.forEach(f => {
            if (f.doc_factura) {
                addDoc(f.doc_factura, `Factura ${f.numero || ''}`);
            }
        });
    }

    const docsBadge = document.getElementById('docs-count-badge');
    if (docsBadge) {
        docsBadge.textContent = `${docCount} ${docCount === 1 ? 'doc' : 'docs'}`;
    }

    if (!hasDocs) {
        docsList.innerHTML = `<li style="color:var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">No hay documentos adjuntos.</li>`;
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

    if (nextStage === 'negociacion' && p.clasificacion === 'presupuesto') {
        container.innerHTML = `<div style="background: rgba(147, 51, 234, 0.1); border: 1px solid rgba(147, 51, 234, 0.5); padding: 1.5rem; border-radius: 6px; margin-top: 1rem;">
            <h4 style="color:#c084fc">📐 Cotización para Presupuesto (No Avanzable a Negociación)</h4>
            <p style="font-size: 0.9rem; margin-top: 0.5rem; color: var(--text-primary); line-height: 1.5;">
                Esta oportunidad está registrada como <strong>Cotización para Presupuesto</strong> (estimación referencial para el cliente). La etapa de <em>Negociación</em> está reservada exclusivamente para ofertas con intención comercial confirmada de ejecución.
            </p>
            <p style="font-size: 0.85rem; margin-top: 0.5rem; color: var(--text-secondary); line-height: 1.4;">
                Si el cliente confirmó que desea proceder con la compra o contratación del proyecto, debes <strong>reclasificarla formalmente</strong> a <em>Oferta para Ejecución</em> indicando la justificación comercial correspondiente.
            </p>
            <div style="margin-top: 1rem; display: flex; gap: 0.75rem;">
                <button type="button" class="btn-primary" onclick="openReclassifyModal('${p.id}')">🔄 Reclasificar a Oferta para Ejecución</button>
                <button type="button" class="btn-secondary" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
            </div>
        </div>`;
        return;
    }

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
// DASHBOARD (CrmDashboardCalc)
// ========================

function populateTimeFilter() {
    const select = document.getElementById('dash-time-filter');
    if (!select) return;
    const currentVal = select.value;

    select.innerHTML = '<option value="all">Histórico Completo</option>';

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Descubrir años disponibles en el dataset para consulta multianual
    const availableYears = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.getAvailableYears(prospects, currentYear)
        : [currentYear];

    availableYears.forEach(year => {
        const isCurrent = (year === currentYear);
        const ytdLabel = isCurrent ? `YTD ${year} (Año en curso)` : `Año ${year} Completo`;
        select.innerHTML += `<option value="year_${year}">${ytdLabel}</option>`;

        const maxMonth = isCurrent ? currentMonth : 11;
        for (let i = maxMonth; i >= 0; i--) {
            select.innerHTML += `<option value="${year}-${i}">${MESES[i]} ${year}</option>`;
        }
    });

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
    } else {
        const ytdOpt = Array.from(select.options).find(o => o.value === `year_${currentYear}`);
        select.value = ytdOpt ? `year_${currentYear}` : 'all';
    }
}

function getFilteredProspects() {
    const select = document.getElementById('dash-time-filter');
    const filter = (select && select.value) || 'all';

    if (typeof CrmDashboardCalc !== 'undefined') {
        return CrmDashboardCalc.filterProspects(prospects, filter);
    }

    const stockActivo = prospects.filter(p => p && p.estado === 'activo' && p.eliminado !== true);
    const flujoGanadas = prospects.filter(p => p && p.estado === 'ganado' && p.eliminado !== true);
    const flujoPerdidas = prospects.filter(p => p && p.estado === 'perdido' && p.eliminado !== true);
    return {
        filter,
        isHistorical: filter === 'all',
        flujoGanadas,
        flujoPerdidas,
        flujoAltas: prospects.filter(p => p && p.eliminado !== true),
        stockActivo,
        closedInPeriod: [...flujoGanadas, ...flujoPerdidas]
    };
}

let currentSellerFilterMode = 'active_only';

function setSellerFilterMode(mode) {
    if (mode === 'active_only' || mode === 'all') {
        currentSellerFilterMode = mode;
        updateSellerFilterButtons();
        if (typeof renderDashboard === 'function') {
            renderDashboard();
        }
    }
}

function getSellerFilterMode() {
    return currentSellerFilterMode;
}

function updateSellerFilterButtons() {
    if (typeof document === 'undefined') return;
    const btnActive = document.getElementById('btn-seller-filter-active');
    const btnAll = document.getElementById('btn-seller-filter-all');
    if (btnActive) {
        if (currentSellerFilterMode === 'active_only') {
            btnActive.classList.add('active');
        } else {
            btnActive.classList.remove('active');
        }
    }
    if (btnAll) {
        if (currentSellerFilterMode === 'all') {
            btnAll.classList.add('active');
        } else {
            btnAll.classList.remove('active');
        }
    }
}

function renderDashboard() {
    const filterRes = getFilteredProspects();
    const select = document.getElementById('dash-time-filter');
    const filterVal = (select && select.value) || 'all';

    // 0. ACTUALIZAR CABECERA: Período activo y timestamp de sincronización
    const periodBadge = document.getElementById('dash-active-period-badge');
    if (periodBadge && select) {
        const activeOption = select.options[select.selectedIndex];
        periodBadge.textContent = activeOption ? activeOption.text : 'Histórico Completo';
    }
    const lastUpdatedElem = document.getElementById('dash-last-updated');
    if (lastUpdatedElem) {
        lastUpdatedElem.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
    }

    // 1. VENTAS GANADAS Y MARGEN (Flujo del período seleccionado con órdenes de cambio)
    const wonMetrics = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateWonMetrics(filterRes.flujoGanadas)
        : { totalPrecio: 0, totalCosto: 0, margen: 0, margenPct: 0, countTotal: 0, countWithCost: 0, countWithoutCost: 0, isCostComplete: true };

    const metricGanadas = document.getElementById('metric-ganadas');
    if (metricGanadas) metricGanadas.textContent = formatCurrency(wonMetrics.totalPrecio);

    const subGanadas = document.getElementById('sub-metric-ganadas');
    if (subGanadas) {
        subGanadas.textContent = `${wonMetrics.countTotal} operaciones ganadas`;
    }

    const metricMargen = document.getElementById('metric-margen');
    if (metricMargen) metricMargen.textContent = formatCurrency(wonMetrics.margen);

    const subMargen = document.getElementById('sub-metric-margen');
    if (subMargen) {
        if (!wonMetrics.isCostComplete && wonMetrics.countWithoutCost > 0) {
            const cov = wonMetrics.coberturaPct !== undefined && wonMetrics.coberturaPct !== null
                ? wonMetrics.coberturaPct.toFixed(1)
                : ((wonMetrics.precioWithCost / (wonMetrics.totalPrecio || 1)) * 100).toFixed(1);
            subMargen.textContent = `Margen bruto conocido (${cov}% cob.)`;
            subMargen.title = `Margen calculado sobre ${formatCurrency(wonMetrics.precioWithCost)} en ventas con costo conocido de un total de ${formatCurrency(wonMetrics.totalPrecio)} (${cov}% de cobertura)`;
        } else {
            subMargen.textContent = 'Margen bruto conocido';
            subMargen.title = 'Margen comercial consolidado con 100% de costos registrados';
        }
    }

    const margenPctElem = document.getElementById('metric-margen-pct');
    if (margenPctElem) {
        if (wonMetrics.margenPct !== null) {
            margenPctElem.textContent = wonMetrics.margenPct.toFixed(1) + '%';
            margenPctElem.style.background = 'rgba(16, 185, 129, 0.2)';
            margenPctElem.style.color = 'var(--success)';
            margenPctElem.title = wonMetrics.isCostComplete
                ? 'Margen comercial consolidado con órdenes de cambio'
                : `Margen calculado sobre ${wonMetrics.countWithCost}/${wonMetrics.countTotal} operaciones con costo registrado (${wonMetrics.coberturaPct !== undefined ? wonMetrics.coberturaPct.toFixed(1) : ''}% cobertura)`;
        } else {
            margenPctElem.textContent = 'N/D';
            margenPctElem.style.background = 'rgba(160, 170, 191, 0.2)';
            margenPctElem.style.color = 'var(--text-secondary)';
            margenPctElem.title = 'Sin costos de venta registrados en las operaciones ganadas';
        }
    }

    const costWarning = document.getElementById('metric-cost-warning');
    if (costWarning) {
        if (!wonMetrics.isCostComplete && wonMetrics.countWithoutCost > 0) {
            costWarning.style.display = 'inline';
            costWarning.textContent = `⚠️ ${wonMetrics.countWithoutCost} sin costo`;
            costWarning.title = `${wonMetrics.countWithoutCost} proyecto(s) ganado(s) (${formatCurrency(wonMetrics.totalPrecio - wonMetrics.precioWithCost)}) no tienen costo registrado y quedan excluidos del margen comercial`;
        } else {
            costWarning.style.display = 'none';
        }
    }

    // 2. TASA DE CIERRE REAL (Ganadas / [Ganadas + Perdidas])
    const countGanadas = filterRes.flujoGanadas ? filterRes.flujoGanadas.length : 0;
    const countPerdidas = filterRes.flujoPerdidas ? filterRes.flujoPerdidas.length : 0;
    const countConcluidas = countGanadas + countPerdidas;
    const winRate = countConcluidas > 0 ? (countGanadas / countConcluidas) * 100 : null;

    const metricWinRate = document.getElementById('metric-win-rate');
    if (metricWinRate) {
        metricWinRate.textContent = winRate !== null ? `${winRate.toFixed(1)}%` : 'N/D';
    }

    const subWinRate = document.getElementById('sub-metric-win-rate');
    if (subWinRate) {
        subWinRate.textContent = countConcluidas > 0
            ? `${countGanadas} ganadas de ${countConcluidas} cerradas`
            : 'Sin operaciones cerradas en el período';
    }

    // 3. ALTAS DEL PERÍODO (Nuevas oportunidades)
    const altas = filterRes.flujoAltas || [];
    const totalAltasCotizado = altas.reduce((acc, p) => acc + (typeof CrmDashboardCalc !== 'undefined' ? CrmDashboardCalc.getProjectSubtotal(p) : (Number(p.precio_cotizado) || 0)), 0);

    const metricAltasCount = document.getElementById('metric-altas-count');
    if (metricAltasCount) metricAltasCount.textContent = altas.length;

    const subAltas = document.getElementById('sub-metric-altas');
    if (subAltas) subAltas.textContent = `Cotizado: ${formatCurrency(totalAltasCotizado)}`;

    // 4. VENTAS PERDIDAS (Flujo del período seleccionado)
    const lostMetrics = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateLostMetrics(filterRes.flujoPerdidas)
        : { totalPrecio: 0, count: 0 };

    const metricPerdidas = document.getElementById('metric-perdidas');
    if (metricPerdidas) metricPerdidas.textContent = formatCurrency(lostMetrics.totalPrecio);

    const subPerdidas = document.getElementById('sub-metric-perdidas');
    if (subPerdidas) {
        subPerdidas.textContent = filterVal === 'all'
            ? `${lostMetrics.count} operaciones perdidas en histórico total`
            : `${lostMetrics.count} operaciones perdidas en el período seleccionado`;
    }

    // 5. PIPELINE PONDERADO & NOMINAL (STOCK VIVO - Todas las oportunidades activas hoy)
    const activeMetrics = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateActivePipelineMetrics(filterRes.stockActivo)
        : { totalPonderado: 0, totalNominal: 0, montoSinProbabilidad: 0, countSinProbabilidad: 0, margenPonderado: 0, margenPonderadoPct: 0, countPonderadas: 0, countSinPonderar: 0 };

    const metricPipePond = document.getElementById('metric-pipeline-ponderado');
    if (metricPipePond) {
        metricPipePond.textContent = formatCurrency(activeMetrics.totalPonderado);
        metricPipePond.title = activeMetrics.countSinPonderar > 0
            ? `Nominal total: ${formatCurrency(activeMetrics.totalNominal)} | Ponderado: ${formatCurrency(activeMetrics.totalPonderado)} | Sin ponderar: ${formatCurrency(activeMetrics.montoSinPonderar || 0)} (${activeMetrics.countSinPonderar} ops sin precio o probabilidad)`
            : `Nominal total: ${formatCurrency(activeMetrics.totalNominal)} (100% ponderado)`;
    }

    const metricPipeNominal = document.getElementById('metric-pipeline-nominal');
    if (metricPipeNominal) metricPipeNominal.textContent = formatCurrency(activeMetrics.totalNominal);

    const metricPipeMargen = document.getElementById('metric-pipeline-margen');
    if (metricPipeMargen) metricPipeMargen.textContent = formatCurrency(activeMetrics.margenPonderado);

    const pipeMargenPctElem = document.getElementById('metric-pipeline-margen-pct');
    if (pipeMargenPctElem) {
        pipeMargenPctElem.textContent = activeMetrics.margenPonderadoPct.toFixed(1) + '%';
    }

    const unweightedBadge = document.getElementById('metric-pipeline-unweighted-badge');
    if (unweightedBadge) {
        if (activeMetrics.countSinProbabilidad > 0) {
            unweightedBadge.style.display = 'inline-block';
            unweightedBadge.textContent = `⚠️ ${activeMetrics.countSinProbabilidad} sin prob. (${formatCurrency(activeMetrics.montoSinProbabilidad)})`;
            unweightedBadge.title = `${activeMetrics.countSinProbabilidad} oportunidades activas no tienen probabilidad válida y no están sumadas al ponderado.`;
        } else {
            unweightedBadge.style.display = 'none';
        }
    }

    // 6. CXC GLOBAL (Proyectos facturados)
    const cxcUniverse = filterVal === 'all' ? prospects : filterRes.flujoGanadas;
    const cxcMetrics = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateCxCMetrics(cxcUniverse)
        : { totalFacturado: 0, totalCobrado: 0, totalCxC: 0, pctCobrado: 0 };

    const metricFacturado = document.getElementById('metric-total-facturado');
    if (metricFacturado) metricFacturado.textContent = formatCurrency(cxcMetrics.totalFacturado);

    const metricCobrado = document.getElementById('metric-total-cobrado');
    if (metricCobrado) metricCobrado.textContent = formatCurrency(cxcMetrics.totalCobrado);

    const metricTotalCxc = document.getElementById('metric-total-cxc');
    if (metricTotalCxc) {
        metricTotalCxc.textContent = formatCurrency(cxcMetrics.totalCxC);
        if (cxcMetrics.hasInvalidRecords) {
            metricTotalCxc.title = `Atención: ${cxcMetrics.invalidFacturasCount} facturas o ${cxcMetrics.invalidPagosCount} abonos con datos incompletos excluidos del cálculo.`;
        }
    }

    const cxcPctBadge = document.getElementById('cxc-pct-badge');
    if (cxcPctBadge) {
        cxcPctBadge.textContent = `${cxcMetrics.pctCobrado.toFixed(1)}% cobrado`;
    }

    const cxcBar = document.getElementById('cxc-bar-cobrado');
    if (cxcBar) cxcBar.style.width = cxcMetrics.pctCobrado + '%';

    // 7. ALERTAS Y RESUMEN OPERATIVO DEL STOCK
    // 7. ALERTAS Y RESUMEN OPERATIVO DEL STOCK: ATENCIÓN GERENCIAL (Fase 1.3)
    const managerAttention = typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.calculateManagerAttentionItems === 'function'
        ? CrmFollowUpCalc.calculateManagerAttentionItems(prospects, users)
        : { counts: { total: 0, pendientes: 0, autorizadas: 0, orden_cierre: 0 }, items: [], pendingUniqueCount: 0 };

    const metricAlertasCount = document.getElementById('metric-alertas-count');
    if (metricAlertasCount) metricAlertasCount.textContent = managerAttention.pendingUniqueCount;

    const metricActivasTotal = document.getElementById('metric-activas-total-count');
    if (metricActivasTotal) metricActivasTotal.textContent = filterRes.stockActivo ? filterRes.stockActivo.length : (prospects ? prospects.filter(p => p && p.estado === 'activo' && p.eliminado !== true).length : 0);

    const dashStagnantBadge = document.getElementById('dash-stagnant-counter-badge');
    if (dashStagnantBadge) {
        dashStagnantBadge.textContent = `${managerAttention.pendingUniqueCount} pendiente${managerAttention.pendingUniqueCount !== 1 ? 's' : ''}`;
        dashStagnantBadge.style.background = managerAttention.pendingUniqueCount > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)';
        dashStagnantBadge.style.color = managerAttention.pendingUniqueCount > 0 ? 'var(--danger)' : 'var(--success)';
        dashStagnantBadge.style.borderColor = managerAttention.pendingUniqueCount > 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)';
    }

    const subAlertasStatus = document.getElementById('sub-metric-alertas-status');
    if (subAlertasStatus) {
        subAlertasStatus.textContent = managerAttention.pendingUniqueCount > 0
            ? `${managerAttention.pendingUniqueCount} oportunidades requieren decisión gerencial`
            : 'Sin alertas gerenciales pendientes';
    }

    // 8. RENDERIZADO DE GRÁFICOS Y TABLAS (Flujo vs Stock)
    renderCharts(filterRes);
    renderDashboardKpiTimes(filterRes);
    renderDashboardActiveTimes();

    // 9. AUDITORÍA (Solo manager, suscripción controlada)
    if (currentUser && currentUser.role === 'manager') {
        fetchAuditLogs();
    }
}

function fetchAuditLogs() {
    const panel = document.getElementById('audit-panel');
    if (panel) panel.style.display = 'block';
    const container = document.getElementById('audit-logs-container');
    if (!container) return;

    // Si ya existe una suscripción activa a auditoría, no recrear el listener
    if (window.auditUnsubscribe) return;

    container.innerHTML = '<em>Cargando auditoría...</em>';

    try {
        window.auditUnsubscribe = db.collection(`audit_logs${DB_SUFFIX}`).orderBy('timestamp', 'desc').limit(20).onSnapshot(snap => {
            container.innerHTML = '';
            if (snap.empty) {
                container.innerHTML = '<span style="color:var(--text-muted)">No hay alertas recientes de eliminación.</span>';
                return;
            }
            let html = '';
            snap.forEach(doc => {
                const data = doc.data();
                html += `
                    <div style="background: rgba(239, 68, 68, 0.1); border-left: 2px solid var(--danger); padding: 8px;">
                        <strong>${formatDate(data.fecha)}</strong> - <strong>${escapeHtmlDoc(data.usuario)}</strong> eliminó <strong>${escapeHtmlDoc(data.item)}</strong>
                        (${escapeHtmlDoc(data.detalle)}) en el proyecto <span style="color:var(--brand-gold)">${escapeHtmlDoc(data.proyectoNombre)}</span>.
                    </div>
                `;
            });
            container.innerHTML = html;
        }, err => {
            console.warn('[CRM] Error en listener de auditoría:', err && err.message);
        });
    } catch (e) {
        console.warn('[CRM] Excepción en fetchAuditLogs:', e && e.message);
    }
}

function renderDashboardKpiTimes(filterRes) {
    const grid = document.getElementById('kpi-times-grid');
    if (!grid) return;

    const universe = (filterRes && filterRes.closedInPeriod && filterRes.closedInPeriod.length > 0)
        ? [...filterRes.closedInPeriod, ...(filterRes.stockActivo || [])]
        : prospects;

    const transitionStats = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateStageTransitionTimes(universe, STAGES, KPI_LIMITS)
        : {};

    const STAGE_LABELS = {
        prospecto: 'Prospecto',
        levantamiento: 'Levantamiento',
        cotizacion: 'Cotización',
        negociacion: 'Negociación',
        cierre: 'Cierre'
    };

    let html = '';

    STAGES.forEach(stage => {
        const stat = transitionStats[stage] || { avgDays: 0, countCompleted: 0, isOverLimit: false, hasData: false };
        const isOverLimit = stat.isOverLimit;
        const stageName = STAGE_LABELS[stage] || stage;
        const avgDisplay = stat.hasData
            ? `${stat.avgDays} <span style="font-size:0.75rem; font-weight:normal; color:var(--text-secondary)">d</span>`
            : '-';
        const countSubtitle = stat.hasData
            ? `${stat.countCompleted} transic.`
            : 'Sin datos';

        html += `
            <div class="dash-stage-card ${isOverLimit ? 'over-limit' : ''}">
                <div class="dash-stage-name" title="${stageName}">${stageName}</div>
                <div class="dash-stage-val ${isOverLimit ? 'val-danger' : ''}">${avgDisplay}</div>
                <div class="dash-stage-sub">${countSubtitle}</div>
            </div>
        `;
    });

    grid.innerHTML = html;
}

function renderDashboardActiveTimes(activeList) {
    const tableWrapper = document.getElementById('dash-stagnant-table-wrapper');
    const emptyBox = document.getElementById('dash-stagnant-empty-box');
    const tbody = document.getElementById('dash-active-times-body');
    const counterBadge = document.getElementById('dash-stagnant-counter-badge');

    // 1. Obtener filtros de atención gerencial
    const filterMotivo = document.getElementById('filter-mgr-motivo') ? document.getElementById('filter-mgr-motivo').value : 'all';
    const filterRespSelect = document.getElementById('filter-mgr-responsable');
    const filterResp = filterRespSelect ? filterRespSelect.value : 'all';
    const filterEstado = document.getElementById('filter-mgr-estado') ? document.getElementById('filter-mgr-estado').value : 'pendientes';

    // 2. Calcular universo de atención gerencial con reglas oficiales
    const attentionData = typeof CrmFollowUpCalc !== 'undefined' && typeof CrmFollowUpCalc.calculateManagerAttentionItems === 'function'
        ? CrmFollowUpCalc.calculateManagerAttentionItems(prospects, users, {
            filterMotivo,
            filterResponsable: filterResp,
            filterEstado
        })
        : { counts: { total: 0, pendientes: 0, autorizadas: 0, orden_cierre: 0 }, items: [], pendingUniqueCount: 0 };

    // 3. Poblar dropdown de responsables dinámicamente si no está poblado
    if (filterRespSelect && filterRespSelect.options.length <= 1) {
        const rawItems = CrmFollowUpCalc.calculateManagerAttentionItems(prospects, users, { filterMotivo: 'all', filterResponsable: 'all', filterEstado: 'todas' }).items;
        const respSet = new Set();
        rawItems.forEach(it => { if (it.responsable && it.responsable !== '-') respSet.add(it.responsable); });
        Array.from(respSet).sort().forEach(respName => {
            const opt = document.createElement('option');
            opt.value = respName;
            opt.textContent = respName;
            filterRespSelect.appendChild(opt);
        });
    }

    const pendingCount = attentionData.pendingUniqueCount;

    if (counterBadge) {
        if (pendingCount === 0) {
            counterBadge.textContent = '0 pendientes';
            counterBadge.style.color = '#10b981';
            counterBadge.style.background = 'rgba(16, 185, 129, 0.15)';
            counterBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        } else {
            counterBadge.textContent = `${pendingCount} pendiente${pendingCount > 1 ? 's' : ''}`;
            counterBadge.style.color = 'var(--danger)';
            counterBadge.style.background = 'rgba(239, 68, 68, 0.15)';
            counterBadge.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        }
    }

    const displayItems = attentionData.items;

    if (displayItems.length === 0) {
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (emptyBox) emptyBox.style.display = 'flex';
        if (tbody) tbody.innerHTML = '';
        return;
    }

    if (emptyBox) emptyBox.style.display = 'none';
    if (tableWrapper) tableWrapper.style.display = 'block';

    if (!tbody) return;

    const isManager = currentUser && currentUser.role === 'manager';

    let rowsHtml = '';
    displayItems.forEach(item => {
        const clientName = typeof getClientName === 'function' ? getClientName(item.clientId) : (item.clientId || '-');

        let statusBadge = '';
        if (item.alerta_estado === 'continuidad_autorizada') {
            statusBadge = '<span class="badge-mgr-alert badge-mgr-authorized">✅ Continuidad Autorizada</span>';
        } else if (item.alerta_estado === 'orden_cierre_pendiente') {
            statusBadge = '<span class="badge-mgr-alert badge-mgr-closing">🛑 Orden Cierre Pendiente</span>';
        } else if (item.alerta_estado === 'orden_cierre_ejecutada') {
            statusBadge = '<span class="badge-mgr-alert badge-mgr-resolved">🔒 Cierre Ejecutado</span>';
        } else {
            statusBadge = '<span class="badge-mgr-alert badge-mgr-pending">⏳ Decisión Pendiente</span>';
        }

        const motivosHtml = (item.motivoObjects && item.motivoObjects.length > 0)
            ? item.motivoObjects.map(m => {
                if (m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos' || m.subtipo === 'cinco_intentos') {
                    return `<span class="badge-mgr-reason badge-mgr-followup" style="display: block; font-size: 0.78rem; color: #f87171; font-weight: 600; line-height: 1.3; margin-bottom: 2px;">📞 <span style="background: rgba(239, 68, 68, 0.2); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem; margin-right: 3px; border: 1px solid rgba(239, 68, 68, 0.4);">Seguimiento</span> ${escapeHtmlDoc(m.descripcion)}</span>`;
                } else if (m.tipo === 'solicitud_sin_contrato') {
                    return `<span class="badge-mgr-reason badge-mgr-contract" style="display: block; font-size: 0.78rem; color: var(--brand-gold); font-weight: 600; line-height: 1.3; margin-bottom: 2px;">📄 <span style="background: rgba(245, 158, 11, 0.2); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem; margin-right: 3px; border: 1px solid rgba(245, 158, 11, 0.4);">Sin Contrato</span> ${escapeHtmlDoc(m.descripcion)}</span>`;
                }
                return `<span style="display: block; font-size: 0.78rem; color: var(--danger); font-weight: 600; line-height: 1.3; margin-bottom: 2px;">⚠️ ${escapeHtmlDoc(m.descripcion || m)}</span>`;
            }).join('')
            : (item.motivos || [item.motivoPrincipal]).map(m =>
                `<span style="display: block; font-size: 0.78rem; color: var(--danger); font-weight: 600; line-height: 1.3;">⚠️ ${escapeHtmlDoc(m)}</span>`
            ).join('');

        let historialSummary = '';
        if (item.intentosValidos > 0) {
            historialSummary += `<span style="font-size: 0.78rem; color: var(--text-secondary); display: block;">${item.intentosValidos} intentos sin respuesta</span>`;
        }
        if (item.justificacionVendedor) {
            historialSummary += `<span style="font-size: 0.75rem; color: var(--brand-gold); display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtmlDoc(item.justificacionVendedor)}">💬 Vendedor: ${escapeHtmlDoc(item.justificacionVendedor)}</span>`;
        }
        if (!historialSummary) {
            historialSummary = `<span style="font-size: 0.75rem; color: var(--text-muted);">-</span>`;
        }

        const canDecideFollowUp = isManager && item.isPending && (item.hasFollowUpEscalation || (item.motivoObjects && item.motivoObjects.some(m => m.tipo === 'seguimiento' || m.tipo === 'cinco_intentos')));
        const canResolveNoContract = isManager && item.isPending && (item.hasNoContractRequest || (item.motivoObjects && item.motivoObjects.some(m => m.tipo === 'solicitud_sin_contrato')));

        let actionButtonsHtml = '';
        if (canDecideFollowUp) {
            actionButtonsHtml += `<button class="btn-table-action" style="background: rgba(245, 158, 11, 0.2); color: var(--brand-gold); border: 1px solid var(--brand-gold); padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 700;" onclick="openManagerDecisionModal('${item.id}')" title="Tomar decisión de continuidad o cierre">⚖️ Decidir</button>`;
        }
        if (canResolveNoContract && !canDecideFollowUp) {
            actionButtonsHtml += `<button class="btn-table-action" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid #3b82f6; padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 700;" onclick="openDetail('${item.id}')" title="Revisar y resolver solicitud sin contrato">📄 Resolver</button>`;
        }
        actionButtonsHtml += `<button class="btn-table-action btn-table-edit" onclick="openDetail('${item.id}')" title="Ver detalle completo">👁️ Ver</button>`;

        rowsHtml += `
            <tr class="cursor-pointer" onclick="openDetail('${item.id}')">
                <td><strong style="color: var(--brand-gold);">${escapeHtmlDoc(item.codigo || item.id.slice(-4))}</strong></td>
                <td>
                    <strong style="color: white; display: block;">${escapeHtmlDoc(item.proyecto)}</strong>
                    <small style="color: var(--text-secondary);">${escapeHtmlDoc(clientName)}</small>
                </td>
                <td><strong style="color: white; font-size: 0.85rem;">${escapeHtmlDoc(item.responsable)}</strong></td>
                <td>${motivosHtml}</td>
                <td>${historialSummary}</td>
                <td style="text-align: center;">${statusBadge}</td>
                <td style="text-align: right;" onclick="event.stopPropagation()">
                    <div style="display: flex; gap: 0.35rem; justify-content: flex-end; flex-wrap: wrap;">
                        ${actionButtonsHtml}
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = rowsHtml;
}

// ==========================================================================
// Fase 1.3: Manager Decision Modal Handlers
// ==========================================================================
let currentDecisionProspectId = null;

function switchManagerDecisionTab(tab) {
    const tabAutorizar = document.getElementById('mgr-tab-autorizar');
    const tabCierre = document.getElementById('mgr-tab-cierre');
    const btnAutorizar = document.getElementById('tab-btn-autorizar');
    const btnCierre = document.getElementById('tab-btn-cierre');

    if (tab === 'autorizar') {
        if (tabAutorizar) tabAutorizar.style.display = 'block';
        if (tabCierre) tabCierre.style.display = 'none';
        if (btnAutorizar) {
            btnAutorizar.style.background = 'rgba(16, 185, 129, 0.2)';
            btnAutorizar.style.borderColor = 'rgba(16, 185, 129, 0.5)';
            btnAutorizar.style.color = '#34d399';
        }
        if (btnCierre) {
            btnCierre.style.background = 'transparent';
            btnCierre.style.borderColor = 'var(--panel-border)';
            btnCierre.style.color = 'var(--text-secondary)';
        }
    } else {
        if (tabAutorizar) tabAutorizar.style.display = 'none';
        if (tabCierre) tabCierre.style.display = 'block';
        if (btnCierre) {
            btnCierre.style.background = 'rgba(239, 68, 68, 0.2)';
            btnCierre.style.borderColor = 'rgba(239, 68, 68, 0.5)';
            btnCierre.style.color = '#f87171';
        }
        if (btnAutorizar) {
            btnAutorizar.style.background = 'transparent';
            btnAutorizar.style.borderColor = 'var(--panel-border)';
            btnAutorizar.style.color = 'var(--text-secondary)';
        }
    }
}

function openManagerDecisionModal(prospectId) {
    if (!currentUser || currentUser.role !== 'manager') {
        return alert("Solo los usuarios con rol Gerente pueden registrar decisiones gerenciales.");
    }

    const p = prospects.find(x => x.id === prospectId);
    if (!p) return alert("Oportunidad no encontrada");

    currentDecisionProspectId = prospectId;
    document.getElementById('mgr-decision-prospect-id').value = prospectId;

    const clientName = typeof getClientName === 'function' ? getClientName(p.clientId) : (p.clientId || '-');
    const vendorName = typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc.resolveSellerName(p, users) : (p.vendedorName || p.vendedor || '-');

    document.getElementById('mgr-decision-subtitle').textContent = `Proyecto: ${p.proyecto || '-'} | Cliente: ${clientName} | Responsable: ${vendorName}`;

    const seguimiento = p.seguimiento || {};
    const cadencia = seguimiento.cadencia || {};
    const intentos = cadencia.intentos_validos_sin_respuesta || 0;

    let motivoDesc = "Esta oportunidad ha alcanzado 5 intentos válidos de contacto sin respuesta por parte del cliente y requiere resolución gerencial para continuar o cerrar el caso.";
    if (cadencia.motivo_escalacion) {
        motivoDesc = cadencia.motivo_escalacion;
    }
    document.getElementById('mgr-decision-motivo-desc').textContent = motivoDesc;

    let histText = `Intentos registrados: ${intentos} intentos sin respuesta.`;
    if (cadencia.justificacion_continuidad) {
        histText += ` | Justificación anterior del vendedor: "${cadencia.justificacion_continuidad}"`;
    }
    document.getElementById('mgr-decision-historial-summary').textContent = histText;

    // Reset fields
    document.getElementById('mgr-autorizar-justificacion').value = '';
    document.getElementById('mgr-autorizar-prox-desc').value = '';
    document.getElementById('mgr-cierre-justificacion').value = '';
    document.getElementById('mgr-cierre-motivo').value = '';
    document.getElementById('mgr-cierre-ejecutar-inmediato').checked = true;

    // Default next follow-up date: 2 business days from now
    const nextDate = typeof CrmWorkCalendar !== 'undefined'
        ? CrmWorkCalendar.addBusinessDays(new Date(), 2)
        : new Date(Date.now() + 2 * 86400000);
    const dateStr = nextDate.toISOString().split('T')[0];
    document.getElementById('mgr-autorizar-prox-fecha').value = dateStr;

    switchManagerDecisionTab('autorizar');
    openModal('modal-manager-decision');
}

async function submitManagerDecision(decisionType) {
    const prospectId = currentDecisionProspectId || document.getElementById('mgr-decision-prospect-id').value;
    if (!prospectId) return;

    if (decisionType === 'autorizar_continuar') {
        const justificacion = document.getElementById('mgr-autorizar-justificacion').value.trim();
        if (!justificacion || justificacion.length < 5) {
            return alert("Por favor ingresa una justificación gerencial detallada (mínimo 5 caracteres).");
        }
        const fecha = document.getElementById('mgr-autorizar-prox-fecha').value;
        if (!fecha) {
            return alert("Debes seleccionar una fecha para la próxima acción de seguimiento.");
        }
        const tipo = document.getElementById('mgr-autorizar-prox-tipo').value;
        const descripcion = document.getElementById('mgr-autorizar-prox-desc').value.trim();

        const payload = {
            prospectId,
            decision: 'autorizar_continuar',
            justificacion,
            proximaAccion: { fecha, tipo, descripcion },
            dbSuffix: DB_SUFFIX
        };

        const res = await runWorkflowOp('Registrando autorización gerencial...', fb => CrmCommercial.resolveFollowUpEscalation(fb, payload));
        if (res) {
            closeModal('modal-manager-decision');
            renderDashboard();
            if (currentProspectId === prospectId) openDetail(prospectId);
        }
    } else if (decisionType === 'ordenar_cierre') {
        const motivo = document.getElementById('mgr-cierre-motivo').value;
        if (!motivo) {
            return alert("Debes seleccionar un motivo de pérdida comercial.");
        }
        const justificacion = document.getElementById('mgr-cierre-justificacion').value.trim();
        const ejecutarCierre = document.getElementById('mgr-cierre-ejecutar-inmediato').checked;

        const payload = {
            prospectId,
            decision: 'ordenar_cierre',
            motivo,
            justificacion,
            ejecutarCierre,
            dbSuffix: DB_SUFFIX
        };

        const res = await runWorkflowOp('Registrando orden de cierre...', fb => CrmCommercial.resolveFollowUpEscalation(fb, payload));
        if (res) {
            closeModal('modal-manager-decision');
            renderDashboard();
            if (currentProspectId === prospectId) openDetail(prospectId);
        }
    }
}

function renderCharts(filterRes) {
    Chart.defaults.color = '#a0aabf';
    const gold = '#ffcc4d', blue = '#3b476e', success = '#10b981', danger = '#ef4444', accent1 = '#8b5cf6', accent2 = '#f97316', cyan = '#38bdf8';

    // 0. GRÁFICA PRIORITARIA 1: EVOLUCIÓN MENSUAL DE VENTAS Y MARGEN BRUTO
    const wonForMonthly = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
    const monthlyStats = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateMonthlyEvolution(wonForMonthly, filterRes)
        : { months: [], totalVentas: 0, totalCostos: 0, totalMargen: 0, totalCountGanadas: 0 };

    const monthlyCanvasBox = document.getElementById('monthly-canvas-container');
    const monthlyEmptyBox = document.getElementById('monthly-evolution-empty');
    const monthlyCoverageBadge = document.getElementById('dash-monthly-coverage-badge');
    const monthlySummary = document.getElementById('dash-monthly-summary');

    if (chartMonthly) { chartMonthly.destroy(); chartMonthly = null; }
    const monthlyCanvas = document.getElementById('monthlyEvolutionChart');
    if (monthlyCanvas && typeof Chart.getChart === 'function') {
        const existingMonthly = Chart.getChart(monthlyCanvas);
        if (existingMonthly) existingMonthly.destroy();
    }

    const hasMonthlyData = monthlyStats.totalCountGanadas > 0;
    if (!hasMonthlyData) {
        if (monthlyCanvasBox) monthlyCanvasBox.style.display = 'none';
        if (monthlyEmptyBox) monthlyEmptyBox.style.display = 'flex';
        if (monthlyCoverageBadge) monthlyCoverageBadge.style.display = 'none';
        if (monthlySummary) monthlySummary.textContent = '';
    } else {
        if (monthlyEmptyBox) monthlyEmptyBox.style.display = 'none';
        if (monthlyCanvasBox) monthlyCanvasBox.style.display = 'block';

        const totalPrecioConCosto = monthlyStats.months.reduce((acc, m) => acc + (m.precioConCosto || 0), 0);
        const totalVentasAll = monthlyStats.totalVentas || 0;
        const globalCoveragePct = totalVentasAll > 0 ? parseFloat(((totalPrecioConCosto / totalVentasAll) * 100).toFixed(1)) : 100;
        const countSinCostoTotal = monthlyStats.months.reduce((acc, m) => acc + (m.countSinCosto || 0), 0);

        if (monthlyCoverageBadge) {
            if (countSinCostoTotal > 0 && globalCoveragePct < 100) {
                monthlyCoverageBadge.style.display = 'inline-block';
                monthlyCoverageBadge.textContent = `⚠️ Cobertura costos: ${globalCoveragePct}%`;
                monthlyCoverageBadge.title = `${countSinCostoTotal} operaciones cerradas sin costo de venta registrado en el período`;
            } else {
                monthlyCoverageBadge.style.display = 'none';
            }
        }

        if (monthlySummary) {
            monthlySummary.textContent = `Ventas: ${formatCurrency(monthlyStats.totalVentas)} | Margen: ${formatCurrency(monthlyStats.totalMargen)}`;
        }

        if (monthlyCanvas) {
            const labels = monthlyStats.months.map(m => m.label);
            const dataVentas = monthlyStats.months.map(m => m.ventas);
            const dataMargen = monthlyStats.months.map(m => m.margen);
            const dataMargenPct = monthlyStats.months.map(m => m.margenPct);

            chartMonthly = new Chart(monthlyCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            type: 'bar',
                            label: 'Ventas Ganadas ($)',
                            data: dataVentas,
                            backgroundColor: '#ffcc4d',
                            borderRadius: 3,
                            yAxisID: 'y'
                        },
                        {
                            type: 'bar',
                            label: 'Margen Bruto ($)',
                            data: dataMargen,
                            backgroundColor: '#10b981',
                            borderRadius: 3,
                            yAxisID: 'y'
                        },
                        {
                            type: 'line',
                            label: '% Margen',
                            data: dataMargenPct,
                            borderColor: '#38bdf8',
                            backgroundColor: '#38bdf8',
                            borderWidth: 2,
                            pointRadius: 3,
                            yAxisID: 'yPct',
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            display: true,
                            ticks: { font: { size: 10 }, color: '#a0aabf' },
                            grid: { display: false }
                        },
                        y: {
                            beginAtZero: true,
                            ticks: {
                                callback: v => formatCurrency(v),
                                font: { size: 10 },
                                color: '#a0aabf'
                            },
                            title: { display: true, text: 'Importe ($)', font: { size: 10 }, color: '#a0aabf' },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        yPct: {
                            position: 'right',
                            min: 0,
                            max: 100,
                            grid: { display: false },
                            ticks: {
                                callback: v => v + '%',
                                font: { size: 10 },
                                color: '#a0aabf'
                            },
                            title: { display: true, text: '% Margen', font: { size: 10 }, color: '#a0aabf' }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { boxWidth: 10, font: { size: 10 }, padding: 10, color: '#a0aabf' }
                        },
                        tooltip: {
                            callbacks: {
                                afterTitle: function(context) {
                                    const idx = context[0].dataIndex;
                                    const m = monthlyStats.months[idx];
                                    if (!m) return '';
                                    if (!m.hasData) return 'Sin operaciones en este mes';
                                    let sub = `${m.countGanadas} op. ganadas`;
                                    if (m.countSinCosto > 0) {
                                        sub += ` · Cobertura costos: ${m.coberturaPct}% (${m.countSinCosto} sin costo)`;
                                    }
                                    return sub;
                                },
                                label: function(ctx) {
                                    if (ctx.dataset.yAxisID === 'yPct') {
                                        return ctx.raw !== null ? `% Margen: ${ctx.raw}%` : '% Margen: Costo no disponible';
                                    }
                                    return `${ctx.dataset.label}: ${formatCurrency(ctx.raw || 0)}`;
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // STOCK VIVO PARA EMBUDO Y PIPELINE
    const active = filterRes && filterRes.stockActivo
        ? filterRes.stockActivo
        : (prospects ? prospects.filter(p => p && p.estado === 'activo' && p.eliminado !== true) : []);

    // 1. EMBUDO DE VENTAS ACTIVAS (Stock vivo por etapa)
    const funnelContainer = document.getElementById('css-funnel-container');
    if (funnelContainer) {
        if (active.length === 0) {
            funnelContainer.innerHTML = `
                <div class="dash-empty-state-box">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.85;">📦</div>
                    <div style="font-weight: 600; color: white; font-size: 0.95rem;">Pipeline sin Oportunidades Activas</div>
                    <div style="font-size: 0.78rem; color: var(--text-secondary); max-width: 260px;">No hay oportunidades abiertas en el inventario actual.</div>
                </div>
            `;
        } else {
            const stageDist = typeof CrmDashboardCalc !== 'undefined'
                ? CrmDashboardCalc.calculatePipelineStageDistribution(active, STAGES, KPI_LIMITS)
                : { stages: [], totalNominal: 0, totalPonderado: 0, totalOps: 0 };

            const maxCount = Math.max(...stageDist.stages.map(s => s.count), 1);
            const colors = [blue, gold, success, '#f59e0b', danger];

            let funnelHTML = '';
            stageDist.stages.forEach((st, i) => {
                const currentWidth = st.count > 0 ? Math.max((st.count / maxCount) * 100, 24) : 18;
                const c = colors[i % colors.length];
                const nominalStr = st.count > 0 ? formatCurrency(st.montoNominal) : '-';
                const ponderadoStr = st.count > 0 && st.montoPonderado > 0 ? `Pond: ${formatCurrency(st.montoPonderado)}` : '';
                const sinProbNotice = st.countSinProb > 0 ? ` <span title="${st.countSinProb} oportunidad(es) sin probabilidad asignada" style="color:var(--brand-gold); font-size:0.75rem;">(⚠️${st.countSinProb})</span>` : '';

                funnelHTML += `
                    <div class="dash-funnel-row">
                        <div class="dash-funnel-label">
                            ${st.stage}<span class="dash-funnel-label-sub">${st.count} Op.${sinProbNotice}</span>
                        </div>
                        <div class="dash-funnel-bar-container">
                            <div class="dash-funnel-bar" style="width: ${currentWidth}%; background-color: ${c};">
                                <span class="dash-funnel-val">${nominalStr}</span>
                                ${ponderadoStr ? `<span class="dash-funnel-subval">${ponderadoStr}</span>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            });

            funnelHTML += `
                <div class="dash-funnel-note">
                    * Stock actual por etapa. No representa conversión secuencial de cohortes. Tasa de Cierre Real: Ganadas / (Ganadas + Perdidas).
                </div>
            `;

            funnelContainer.innerHTML = `<div class="dash-funnel-wrapper">${funnelHTML}</div>`;
        }
    }

    // 2. EFECTIVIDAD Y VOLUMEN POR CANAL (Volumen apilado + Tasa de Cierre)
    const channelUniverse = (filterRes && filterRes.isHistorical)
        ? prospects
        : [...(filterRes.flujoGanadas || []), ...(filterRes.flujoPerdidas || []), ...(filterRes.stockActivo || [])];

    const channelStats = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateChannelConversion(channelUniverse)
        : { summary: [], channels: [] };

    const repNames = channelStats.channels;
    const dataGanado = [];
    const dataActivo = [];
    const dataPerdido = [];
    const dataWinRate = [];

    repNames.forEach(name => {
        const item = channelStats.summary.find(s => s.channel === name);
        if (item) {
            dataGanado.push(item.ganado);
            dataActivo.push(item.activo);
            dataPerdido.push(item.perdido);
            dataWinRate.push(item.winRate !== null ? parseFloat(item.winRate.toFixed(1)) : null);
        }
    });

    if (chartOrigin) { chartOrigin.destroy(); chartOrigin = null; }
    const convCanvas = document.getElementById('conversionChart');
    if (convCanvas) {
        if (typeof Chart.getChart === 'function') {
            const existing = Chart.getChart(convCanvas);
            if (existing) existing.destroy();
        }
        const isMobileScreen = typeof window !== 'undefined' && window.innerWidth <= 640;

        // Etiquetas limpias de canales en una sola línea con rotación uniforme para legibilidad total
        const chartLabels = repNames.map(name => (name ? String(name).trim() : ''));

        chartOrigin = new Chart(convCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: chartLabels,
                datasets: [
                    { type: 'bar', label: 'Ganado', data: dataGanado, backgroundColor: success, stack: 'ops', borderRadius: 2 },
                    { type: 'bar', label: 'En Proceso', data: dataActivo, backgroundColor: gold, stack: 'ops', borderRadius: 2 },
                    { type: 'bar', label: 'Perdido', data: dataPerdido, backgroundColor: danger, stack: 'ops', borderRadius: 2 },
                    {
                        type: 'line',
                        label: 'Tasa Cierre (%)',
                        data: dataWinRate,
                        borderColor: cyan,
                        backgroundColor: cyan,
                        borderWidth: 2,
                        pointRadius: isMobileScreen ? 3 : 4,
                        pointHoverRadius: 5,
                        yAxisID: 'yRate',
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: {
                    padding: {
                        left: isMobileScreen ? 2 : 6,
                        right: isMobileScreen ? 2 : 6,
                        top: 6,
                        bottom: isMobileScreen ? 8 : 10
                    }
                },
                scales: {
                    x: {
                        display: true,
                        ticks: {
                            font: { size: isMobileScreen ? 8.5 : 9.5, weight: '500' },
                            color: '#cbd5e1',
                            maxRotation: isMobileScreen ? 45 : 35,
                            minRotation: isMobileScreen ? 40 : 30,
                            autoSkip: false,
                            padding: 4
                        },
                        grid: { display: false }
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1,
                            font: { size: isMobileScreen ? 9 : 10 },
                            color: '#a0aabf',
                            padding: isMobileScreen ? 3 : 6
                        },
                        title: {
                            display: true,
                            text: isMobileScreen ? 'Ops' : 'Volumen Ops',
                            font: { size: isMobileScreen ? 9 : 10 },
                            color: '#a0aabf'
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    yRate: {
                        position: 'right',
                        min: 0,
                        max: 100,
                        grid: { display: false },
                        ticks: {
                            callback: v => v + '%',
                            font: { size: isMobileScreen ? 9 : 10 },
                            color: '#a0aabf',
                            padding: isMobileScreen ? 3 : 6
                        },
                        title: {
                            display: true,
                            text: isMobileScreen ? '% Cierre' : 'Tasa de Cierre',
                            font: { size: isMobileScreen ? 9 : 10 },
                            color: '#a0aabf'
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            boxWidth: isMobileScreen ? 8 : 10,
                            font: { size: isMobileScreen ? 8.5 : 9.5 },
                            padding: isMobileScreen ? 8 : 12,
                            color: '#a0aabf'
                        }
                    },
                    tooltip: {
                        callbacks: {
                            title: function (items) {
                                if (!items || !items.length) return '';
                                const idx = items[0].dataIndex;
                                return repNames[idx] || (Array.isArray(items[0].label) ? items[0].label.join(' ') : items[0].label);
                            },
                            label: function (context) {
                                if (context.dataset.yAxisID === 'yRate') {
                                    return context.raw !== null ? `Tasa de Cierre: ${context.raw}% (Ganadas/Concluidas)` : 'Tasa: Sin cierres concluidos';
                                }
                                return `${context.dataset.label}: ${context.raw} Ops`;
                            }
                        }
                    }
                }
            }
        });
    }

    // 3. RENDIMIENTO COMPARATIVO POR VENDEDOR (Horizontal bar chart)
    const wonSellers = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
    const lostSellers = filterRes && filterRes.flujoPerdidas ? filterRes.flujoPerdidas : [];
    const activeSellersList = filterRes && filterRes.stockActivo ? filterRes.stockActivo : [];

    updateSellerFilterButtons();

    const sellerStats = typeof CrmDashboardCalc !== 'undefined'
        ? CrmDashboardCalc.calculateSellerPerformance(wonSellers, lostSellers, activeSellersList, typeof users !== 'undefined' ? users : [], { filterMode: currentSellerFilterMode })
        : { sellers: [], totalSellers: 0, excludedInactiveMetrics: {} };

    const sellerCanvasBox = document.getElementById('seller-canvas-container');
    const sellerEmptyBox = document.getElementById('seller-empty-container');
    const sellerEmptyText = document.getElementById('seller-empty-text');
    const sellerCoverageBadge = document.getElementById('dash-seller-coverage-badge');
    const sellerInactiveNotice = document.getElementById('dash-seller-inactive-notice');
    const sellerInactiveNoticeText = document.getElementById('dash-seller-inactive-notice-text');

    // Manejo de la nota contextual sobre comerciales inactivos
    if (sellerInactiveNotice && sellerInactiveNoticeText) {
        const excl = sellerStats.excludedInactiveMetrics;
        if (currentSellerFilterMode === 'active_only' && excl && (excl.ventasGanadas > 0 || excl.pipelineNominal > 0 || excl.countPerdidas > 0)) {
            const parts = [];
            if (excl.ventasGanadas > 0) {
                parts.push(`${formatCurrency(excl.ventasGanadas)} en ventas ganadas`);
            }
            if (excl.pipelineNominal > 0) {
                parts.push(`${formatCurrency(excl.pipelineNominal)} en cartera activa`);
            }
            let noticeMsg = 'El consolidado corporativo incluye ';
            if (parts.length > 0) {
                noticeMsg += parts.join(' y ') + ' de colaboradores inactivos no listados en esta vista. Seleccione «Histórico Completo» para ver el desglose individual.';
            } else {
                noticeMsg += 'operaciones de colaboradores inactivos que no figuran en esta vista. Seleccione «Histórico Completo» para ver el desglose individual.';
            }
            sellerInactiveNoticeText.textContent = noticeMsg;
            sellerInactiveNotice.style.display = 'flex';
        } else {
            sellerInactiveNotice.style.display = 'none';
            sellerInactiveNoticeText.textContent = '';
        }
    }

    if (chartSeller) { chartSeller.destroy(); chartSeller = null; }
    const sellerCanvas = document.getElementById('sellerChart');
    if (sellerCanvas && typeof Chart.getChart === 'function') {
        const existingSeller = Chart.getChart(sellerCanvas);
        if (existingSeller) existingSeller.destroy();
    }

    const sellers = sellerStats.sellers || [];
    const hasSellerActivity = sellers.some(s => s.ventasGanadas > 0 || s.countPerdidas > 0 || s.pipelineNominal > 0 || s.countActivas > 0);

    if (!hasSellerActivity || sellers.length === 0) {
        if (sellerCanvasBox) sellerCanvasBox.style.display = 'none';
        if (sellerEmptyBox) sellerEmptyBox.style.display = 'flex';
        if (sellerCoverageBadge) sellerCoverageBadge.style.display = 'none';
        if (sellerEmptyText) {
            if (currentSellerFilterMode === 'active_only' && sellerStats.excludedInactiveMetrics && sellerStats.excludedInactiveMetrics.countSellers > 0) {
                sellerEmptyText.textContent = 'No se registran cierres ni carteras de colaboradores activos en el período seleccionado. Cambie a «Histórico Completo» para consultar registros de excolaboradores.';
            } else {
                sellerEmptyText.textContent = 'No se registran cierres ni carteras comerciales asignadas a vendedores en el período seleccionado.';
            }
        }
    } else {
        if (sellerEmptyBox) sellerEmptyBox.style.display = 'none';
        if (sellerCanvasBox) sellerCanvasBox.style.display = 'block';

        const sellersWithIncompleteCosts = sellers.filter(s => s.ventasGanadas > 0 && s.coberturaPct < 100);
        if (sellerCoverageBadge) {
            if (sellersWithIncompleteCosts.length > 0) {
                sellerCoverageBadge.style.display = 'inline-block';
                sellerCoverageBadge.textContent = '⚠️ Costos parciales en vendedores';
                sellerCoverageBadge.title = 'Algunos vendedores tienen ventas ganadas sin costo de venta registrado';
            } else {
                sellerCoverageBadge.style.display = 'none';
            }
        }

        if (sellerCanvas) {
            const requiredHeight = Math.max(260, sellers.length * 48);
            sellerCanvasBox.style.height = `${requiredHeight}px`;

            chartSeller = new Chart(sellerCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: sellers.map(s => s.nombreConRol || (s.role === 'gestor' ? `${s.nombre} (Gestor)` : `${s.nombre} (Vendedor)`)),
                    datasets: [
                        {
                            label: 'Ventas Ganadas ($)',
                            data: sellers.map(s => s.ventasGanadas),
                            backgroundColor: '#ffcc4d',
                            borderRadius: 3
                        },
                        {
                            label: 'Margen Bruto ($)',
                            data: sellers.map(s => s.margen),
                            backgroundColor: '#10b981',
                            borderRadius: 3
                        },
                        {
                            label: 'Cartera Activa ($)',
                            data: sellers.map(s => s.pipelineNominal),
                            backgroundColor: '#38bdf8',
                            borderRadius: 3
                        }
                    ]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            beginAtZero: true,
                            ticks: {
                                callback: v => formatCurrency(v),
                                font: { size: 10 },
                                color: '#a0aabf'
                            },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        y: {
                            ticks: {
                                font: { size: 11, weight: '500' },
                                color: '#ffffff'
                            },
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { boxWidth: 10, font: { size: 10 }, padding: 10, color: '#a0aabf' }
                        },
                        tooltip: {
                            callbacks: {
                                title: function(items) {
                                    if (!items || !items.length) return '';
                                    const idx = items[0].dataIndex;
                                    const s = sellers[idx];
                                    if (!s) return '';
                                    const roleBadge = s.isInactive
                                        ? (s.role === 'gestor' ? 'Gestor de Ventas - Inactivo' : (s.role === 'vendedor' ? 'Vendedor - Inactivo' : 'Sin Asignar'))
                                        : (s.role === 'gestor' ? 'Gestor de Ventas' : (s.role === 'vendedor' ? 'Vendedor' : 'Sin Asignar'));
                                    return `${s.nombre} [${roleBadge}]`;
                                },
                                afterTitle: function(context) {
                                    const idx = context[0].dataIndex;
                                    const s = sellers[idx];
                                    if (!s) return '';
                                    return `Tasa Cierre: ${s.winRateFormatted} | Cobertura Costo: ${s.coberturaPct}%`;
                                },
                                label: function(ctx) {
                                    const idx = ctx.dataIndex;
                                    const s = sellers[idx];
                                    const dsLabel = ctx.dataset.label;
                                    const val = formatCurrency(ctx.raw || 0);
                                    if (dsLabel.includes('Ventas')) {
                                        return `${dsLabel}: ${val} (${s.countGanadas} ganadas)`;
                                    }
                                    if (dsLabel.includes('Margen')) {
                                        const mPct = s.margenPct !== null ? `${s.margenPct}%` : 'Incompleto';
                                        return `${dsLabel}: ${val} (Margen: ${mPct})`;
                                    }
                                    if (dsLabel.includes('Cartera')) {
                                        const pond = formatCurrency(s.pipelinePonderado || 0);
                                        return `${dsLabel}: ${val} (Ponderado: ${pond}, ${s.countActivas} activas)`;
                                    }
                                    return `${dsLabel}: ${val}`;
                                }
                            }
                        }
                    }
                }
            });
        }
    }


    // 3. MOTIVOS DE PÉRDIDA (Flujo de pérdidas del período)
    const lostOps = filterRes && filterRes.flujoPerdidas ? filterRes.flujoPerdidas : [];
    const hasLostData = Array.isArray(lostOps) && lostOps.length > 0;
    const lossCanvasBox = document.getElementById('loss-canvas-container');
    const lossEmptyBox = document.getElementById('loss-empty-container');

    if (chartLoss) { chartLoss.destroy(); chartLoss = null; }
    const lossCanvas = document.getElementById('lossChart');
    if (lossCanvas && typeof Chart.getChart === 'function') {
        const existingLoss = Chart.getChart(lossCanvas);
        if (existingLoss) existingLoss.destroy();
    }

    if (!hasLostData) {
        if (lossCanvasBox) lossCanvasBox.style.display = 'none';
        if (lossEmptyBox) lossEmptyBox.style.display = 'flex';
    } else {
        if (lossEmptyBox) lossEmptyBox.style.display = 'none';
        if (lossCanvasBox) lossCanvasBox.style.display = 'block';
        if (lossCanvas) {
            chartLoss = new Chart(lossCanvas.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: MOTIVOS_PERDIDA,
                    datasets: [{
                        data: MOTIVOS_PERDIDA.map(m => lostOps.filter(p => p.motivo_perdida === m).length),
                        backgroundColor: [danger, '#f59e0b', accent2, accent1, '#6b7280'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { boxWidth: 10, font: { size: 10 }, padding: 8, color: '#a0aabf' }
                        },
                        tooltip: {
                            callbacks: {
                                label: function (ctx) {
                                    const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                    const pct = total > 0 ? Math.round((ctx.raw / total) * 100) : 0;
                                    return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
                                }
                            }
                        }
                    },
                    cutout: '55%'
                }
            });
        }
    }

    // 4. GRÁFICOS DE COMPOSICIÓN (Ventas y Pipeline)
    const won = filterRes && filterRes.flujoGanadas ? filterRes.flujoGanadas : [];
    const sumSubtotal = (arr) => arr.reduce((acc, p) => acc + (typeof CrmDashboardCalc !== 'undefined' ? CrmDashboardCalc.getProjectSubtotal(p) : (Number(p.precio_cotizado) || 0)), 0);

    const compositionOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                position: 'bottom',
                labels: { boxWidth: 10, font: { size: 10 }, padding: 6, color: '#a0aabf' }
            },
            tooltip: {
                callbacks: {
                    label: ctx => ' ' + formatCurrency(ctx.raw)
                }
            }
        },
        cutout: '58%'
    };

    // A. CIERRES - PRODUCTO
    const prodW = [sumSubtotal(won.filter(p => p.tipo_producto === 'Chute')), sumSubtotal(won.filter(p => p.tipo_producto === 'Ducto'))];
    const prodWColors = [gold, blue];
    const prodWNo = sumSubtotal(won.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    if (prodWNo > 0) { prodW.push(prodWNo); prodWColors.push('#6b7280'); }
    if (chartProduct) { chartProduct.destroy(); chartProduct = null; }
    const prodCanvas = document.getElementById('productChart');
    if (prodCanvas) {
        if (typeof Chart.getChart === 'function') {
            const existing = Chart.getChart(prodCanvas);
            if (existing) existing.destroy();
        }
        chartProduct = new Chart(prodCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: prodWNo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodW, backgroundColor: prodWColors, borderWidth: 0 }] },
            options: compositionOptions
        });
    }

    // B. CIERRES - PROYECTO
    const projW = [sumSubtotal(won.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumSubtotal(won.filter(p => p.tipo_proyecto === 'Fabricación'))];
    const projWColors = [success, '#a0aabf'];
    const projWNo = sumSubtotal(won.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    if (projWNo > 0) { projW.push(projWNo); projWColors.push('#6b7280'); }
    if (chartProject) { chartProject.destroy(); chartProject = null; }
    const projCanvas = document.getElementById('projectChart');
    if (projCanvas) {
        if (typeof Chart.getChart === 'function') {
            const existing = Chart.getChart(projCanvas);
            if (existing) existing.destroy();
        }
        chartProject = new Chart(projCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: projWNo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projW, backgroundColor: projWColors, borderWidth: 0 }] },
            options: compositionOptions
        });
    }

    // C. PIPELINE - PRODUCTO
    const prodA = [sumSubtotal(active.filter(p => p.tipo_producto === 'Chute')), sumSubtotal(active.filter(p => p.tipo_producto === 'Ducto'))];
    const prodANo = sumSubtotal(active.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    const prodAColors = [gold, blue];
    if (prodANo > 0) { prodA.push(prodANo); prodAColors.push('#6b7280'); }
    if (chartOppProduct) { chartOppProduct.destroy(); chartOppProduct = null; }
    const oppProdCanvas = document.getElementById('oppProductChart');
    if (oppProdCanvas) {
        if (typeof Chart.getChart === 'function') {
            const existing = Chart.getChart(oppProdCanvas);
            if (existing) existing.destroy();
        }
        chartOppProduct = new Chart(oppProdCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: prodANo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodA, backgroundColor: prodAColors, borderWidth: 0 }] },
            options: compositionOptions
        });
    }

    // D. PIPELINE - PROYECTO
    const projA = [sumSubtotal(active.filter(p => p.tipo_proyecto === 'Fabricación e instalación')), sumSubtotal(active.filter(p => p.tipo_proyecto === 'Fabricación'))];
    const projANo = sumSubtotal(active.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    const projAColors = [accent1, accent2];
    if (projANo > 0) { projA.push(projANo); projAColors.push('#6b7280'); }
    if (chartOppProject) { chartOppProject.destroy(); chartOppProject = null; }
    const oppProjCanvas = document.getElementById('oppProjectChart');
    if (oppProjCanvas) {
        if (typeof Chart.getChart === 'function') {
            const existing = Chart.getChart(oppProjCanvas);
            if (existing) existing.destroy();
        }
        chartOppProject = new Chart(oppProjCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: projANo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projA, backgroundColor: projAColors, borderWidth: 0 }] },
            options: compositionOptions
        });
    }
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

// Reactivation of lost opportunity (reactivateLostProspectAdmin): restores an opportunity marked as lost to active status,
// preserving its loss history and restoring commercial stage and visibility. Only managers can perform this.
async function reactivateLostProspect() {
    if (!currentProspectId) return;
    if (!currentUser || currentUser.role !== 'manager') return alert("Permiso denegado: solo un usuario con rol de gerencia puede reactivar proyectos.");

    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    if (p.estado !== 'perdido') return alert("Solo se pueden reactivar proyectos que se encuentren en estado 'perdido'.");
    if (p.eliminado === true) return alert("No se puede reactivar un proyecto eliminado lógicamente.");

    if (!confirm(`¿Deseas reactivar el proyecto "${p.proyecto}"?\n\nEl proyecto volverá a estar activo en su etapa comercial previa y se restaurará la visibilidad comercial para su equipo.`)) return;
    const motivo = String(prompt('Indica el motivo de la reactivación (obligatorio):') || '').trim();
    if (!motivo) return alert("La reactivación requiere un motivo obligatorio. Operación cancelada.");

    const res = await runWorkflowOp('Reactivando proyecto...', fb => CrmCommercial.reactivateProspect(fb, { prospectId: p.id, motivo, dbSuffix: DB_SUFFIX }));
    if (!res) return;
    const resData = (res && res.data) || {};
    alert(`Proyecto reactivado exitosamente. Etapa activa: ${resData.etapa || p.etapa || 'restaurada'}.`);
    p.estado = 'activo';
    if (resData.etapa) p.etapa = resData.etapa;
    delete p.motivo_perdida;
    delete p.fecha_perdida;
    openDetail(p.id);
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
