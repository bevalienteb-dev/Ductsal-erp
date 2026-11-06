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
const CRM_STAGING_MODE = (typeof CrmStaging !== 'undefined') && CrmStaging.isStagingRequested(window.location);

if (CRM_STAGING_MODE && typeof CrmStaging !== 'undefined') {
    firebase.initializeApp(CrmStaging.getStagingFirebaseConfig());
} else {
    firebase.initializeApp(CRM_EMULATOR_MODE ? CrmEnv.emulatorFirebaseConfig() : firebaseConfig);
}
const db = firebase.firestore();
if (CRM_EMULATOR_MODE) {
    const emulatorEndpoints = CrmEnv.connectEmulators(firebase, db);
    console.warn("MODO EMULADORES ACTIVO. Proyecto: " + emulatorEndpoints.project + " | Auth " + emulatorEndpoints.auth.host + ":" + emulatorEndpoints.auth.port + " | Firestore " + emulatorEndpoints.firestore.host + ":" + emulatorEndpoints.firestore.port + " | Functions " + emulatorEndpoints.functions.host + ":" + emulatorEndpoints.functions.port + " | Storage " + emulatorEndpoints.storage.host + ":" + emulatorEndpoints.storage.port);
    document.addEventListener('DOMContentLoaded', () => CrmEnv.showBanner(document, emulatorEndpoints));
} else if (CRM_STAGING_MODE && typeof CrmStaging !== 'undefined') {
    CrmStaging.assertStagingIsolation(firebase);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => CrmStaging.showStagingBanner(document));
    } else {
        CrmStaging.showStagingBanner(document);
    }
}
try {
    db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
} catch (e) {
    console.warn("Long polling config:", e);
}
const storage = firebase.storage();

// Configuración de Entornos Automática
const isLocal = window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const DB_SUFFIX = (isLocal && !CRM_STAGING_MODE) ? '_local' : '_prod';
const STORAGE_PREFIX = (isLocal && !CRM_STAGING_MODE) ? 'local_files' : 'prod_files';
if (typeof window !== 'undefined') {
    window.DB_SUFFIX = DB_SUFFIX;
    window.STORAGE_PREFIX = STORAGE_PREFIX;
}

if (CRM_STAGING_MODE) {
    console.warn("🧪 ENTORNO DE STAGING REMOTO ACTIVADO: Conectado a ductsal-erp-staging (colecciones _prod).");
} else if (isLocal) {
    console.warn("⚠️ MODO DESARROLLO LOCAL ACTIVADO: Conectado a las colecciones '_local' en Firebase.");
}

function hasEnteredPostclosing(p) {
    if (!p || typeof p !== 'object') return false;

    // 1. Explicitly disabled postclosing
    if (p.postcierre_habilitado === false) return false;

    // 2. Active / open opportunities are in-process, never in postclosing
    // (unless explicitly finalized with postcierre_habilitado === true)
    if (p.estado === 'activo' && p.postcierre_habilitado !== true) return false;

    // 3. Modern finalized opportunity (formal closure via finalizeProspect)
    // Or closed project preserved in postclosing (even if subsequently marked 'perdido', per SEC-04/06)
    if (p.postcierre_habilitado === true) return true;

    // 4. Lost opportunities without postcierre_habilitado === true cannot enter postclosing
    // (residual invoices or historical tags on lost leads are not authorized)
    if (p.estado === 'perdido') return false;

    // 5. Historical records (created before postcierre_habilitado was introduced)
    // Must possess verifiable, consistent historical closing evidence.

    // 5a. Accounting / Fiscal evidence: at least one well-formed, valid invoice
    const hasFacturas = Array.isArray(p.facturas) && p.facturas.some(f => {
        if (!f || typeof f !== 'object') return false;
        const hasNumero = typeof f.numero === 'string' && f.numero.trim().length > 0;
        const numMonto = typeof f.monto === 'number' ? f.monto : parseFloat(f.monto);
        const hasMonto = typeof numMonto === 'number' && !isNaN(numMonto) && numMonto > 0;
        return hasNumero && hasMonto;
    });
    if (hasFacturas) return true;

    // 5b. Contractual / Documental evidence:
    // Must have a valid closure date or cierre stage timestamp
    const hasCloseDate = (typeof p.fecha_cierre === 'string' && p.fecha_cierre.trim().length > 0)
        || (typeof p.fecha_postcierre === 'string' && p.fecha_postcierre.trim().length > 0)
        || !!(p.stage_timestamps && typeof p.stage_timestamps === 'object' && p.stage_timestamps.cierre);

    if (!hasCloseDate) return false;

    const datos = (p.datos && typeof p.datos === 'object') ? p.datos : null;
    const hasDoc = d => (Array.isArray(d) ? d.length > 0 : !!d);

    // Contractual proof: contrato_archivo, doc_firmado, doc_contrato, or authorized bypass
    const hasContractOrSignedDoc = !!p.contrato_archivo
        || hasDoc(p.doc_firmado)
        || (!!datos && (hasDoc(datos.doc_contrato) || hasDoc(datos.doc_firmado)))
        || p.autorizado_sin_contrato === true
        || (!!datos && datos.autorizado_sin_contrato === true);

    // Advance receipt proof: doc_comprobante
    const hasAdvanceReceipt = hasDoc(p.doc_comprobante)
        || (!!datos && hasDoc(datos.doc_comprobante));

    // Closing evidence requires physical contract in storage (contrato_archivo)
    // OR both contractual proof AND advance receipt proof.
    // (forma_pago or factura_anticipo alone are NEVER sufficient)
    const hasClosingEvidence = !!p.contrato_archivo
        || (hasContractOrSignedDoc && hasAdvanceReceipt);

    if (hasClosingEvidence) {
        return true;
    }

    // 6. Inconsistent, ambiguous, or unverified records default to false (require manual review)
    return false;
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.parseProspectDate) return mod.parseProspectDate(raw);
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.formatProspectDate) return mod.formatProspectDate(raw);
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.clearOppDateFilter) return mod.clearOppDateFilter();
    const startEl = document.getElementById('opp-date-start');
    const endEl = document.getElementById('opp-date-end');
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    renderList();
}

function toggleOppSort(column) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.toggleOppSort) return mod.toggleOppSort(column);
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.getProspectVendorInfo) return mod.getProspectVendorInfo(p);
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.reassignVendor) return mod.reassignVendor(prospectId, directTargetId);
    const p = prospects.find(x => x.id === prospectId);
    if (!p) return;
    const isClosed = (typeof hasEnteredPostclosing === 'function' ? hasEnteredPostclosing(p) : (p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado'))));
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.processConfirmReassign) return await mod.processConfirmReassign(event);
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
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.updateOppSortIcons) return mod.updateOppSortIcons();
    const columns = ['codigo', 'cliente', 'proyecto', 'vendedor', 'fecha', 'etapa', 'monto', 'estado'];
    columns.forEach(col => {
        const el = document.getElementById(`sort-opp-${col}`);
        if (!el) return;
        if (oppSortCol === col) {
            el.innerHTML = oppSortDir === 'asc' ? '▲' : '▼';
            el.style.color = 'var(--brand-gold)';
        } else if (!oppSortCol && col === 'fecha') {
            el.innerHTML = '▼';
            el.style.color = 'var(--text-secondary)';
        } else {
            el.innerHTML = '↕';
            el.style.color = 'var(--text-muted)';
        }
    });
}

function toggleProjSort(column) {
    const mod = (typeof _getFinanceController === 'function') ? _getFinanceController() : (typeof FinanceController !== 'undefined' ? FinanceController : null);
    if (mod && typeof mod.toggleProjSort === 'function') {
        return mod.toggleProjSort(...arguments);
    }
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
    const mod = (typeof _getFinanceController === 'function') ? _getFinanceController() : (typeof FinanceController !== 'undefined' ? FinanceController : null);
    if (mod && typeof mod.updateProjSortIcons === 'function') {
        return mod.updateProjSortIcons(...arguments);
    }
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
// toggleProjSort y updateProjSortIcons modularizados en modules/finance/finance_controller.js (Fase 6.4)
// toggleCliSort y updateCliSortIcons extraídos a modules/clients/clients_ui.js (Fase 6.2.1)

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

        const effectiveSubfolder = (options.clientId || options.reservationId)
            ? ((options.subfolder === 'poderes' || options.isPoder) ? 'poderes' : (options.isLegal ? 'legal' : 'identificacion'))
            : folderName;

        // Validar extensión y tamaño por carpeta según storage.rules antes de transferir
        if (['identificacion', 'legal', 'poderes', 'pagos'].includes(effectiveSubfolder)) {
            if (!['pdf', 'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'].includes(rawExt)) {
                const extErr = new Error(`El archivo "${file.name}" (.${rawExt}) no está permitido en la carpeta "${effectiveSubfolder}". Solo se admiten documentos PDF o imágenes (JPG, PNG, WEBP, TIFF).`);
                extErr.isFormatError = true;
                alert('❌ ' + extErr.message);
                throw extErr;
            }
        }
        const maxBytes = (effectiveSubfolder === 'proyectos' || effectiveSubfolder === 'requerimientos' || effectiveSubfolder === 'fabricacion_archivos')
            ? 100 * 1024 * 1024
            : effectiveSubfolder === 'ordenes_cambio'
                ? 35 * 1024 * 1024
                : (effectiveSubfolder === 'legal' || effectiveSubfolder === 'poderes')
                    ? 25 * 1024 * 1024
                    : (effectiveSubfolder === 'facturas' || effectiveSubfolder === 'clientes')
                        ? 15 * 1024 * 1024
                        : 10 * 1024 * 1024;
        if (typeof processedFile.size === 'number' && processedFile.size > maxBytes) {
            const maxMb = Math.round(maxBytes / (1024 * 1024));
            const sizeErr = new Error(`El archivo "${file.name}" (${(processedFile.size / (1024 * 1024)).toFixed(1)} MB) excede el límite máximo permitido de ${maxMb} MB para "${effectiveSubfolder}".`);
            sizeErr.isFormatError = true;
            alert('❌ ' + sizeErr.message);
            throw sizeErr;
        }

        // Asegurar que el ID token de Firebase Auth incluya los custom claims { cid, role } requeridos por storage.rules
        if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
            const authObj = firebase.auth();
            const authUser = authObj && authObj.currentUser;
            if (authUser && typeof authUser.getIdTokenResult === 'function' && typeof authUser.getIdToken === 'function') {
                try {
                    const tokenRes = await authUser.getIdTokenResult();
                    if (!tokenRes || !tokenRes.claims || !tokenRes.claims.cid || !tokenRes.claims.role) {
                        await authUser.getIdToken(true);
                    }
                } catch (_) {}
            }
        }

        // Generar prefijo numérico monotónico para impedir colisiones Date.now() en subidas concurrentes (Promise.all)
        // que violarían isNew() (resource == null) en storage.rules con storage/unauthorized.
        const nowMs = Date.now();
        uploadFileToStorage._lastTs = (typeof uploadFileToStorage._lastTs === 'number' && nowMs <= uploadFileToStorage._lastTs)
            ? (uploadFileToStorage._lastTs + 1)
            : nowMs;
        const uniqueTs = uploadFileToStorage._lastTs;

        // Utilizar exclusivamente el bucket canónico confirmado configurado en Firebase Storage
        const storageRef = storage.ref();

        let fullPath;
        if (options.prospectId) {
            fullPath = `${STORAGE_PREFIX}/prospects/${options.prospectId}/${folderName}/${uniqueTs}_${safeName}`;
        } else if (options.clientId) {
            const subfolder = (options.subfolder === 'poderes' || options.isPoder) ? 'poderes' : (options.isLegal ? 'legal' : 'identificacion');
            fullPath = `${STORAGE_PREFIX}/clients/${options.clientId}/${subfolder}/${uniqueTs}_${safeName}`;
        } else if (options.reservationId) {
            const subfolder = options.isLegal ? 'legal' : 'identificacion';
            fullPath = `${STORAGE_PREFIX}/clients/${options.reservationId}/${subfolder}/${uniqueTs}_${safeName}`;
        } else if (options.customPath) {
            fullPath = `${STORAGE_PREFIX}/${options.customPath}`;
        } else {
            fullPath = `${STORAGE_PREFIX}/${folderName}/${uniqueTs}_${safeName}`;
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
// MODULARIZACIÓN FASE 6.1: VINCULACIÓN CON CORE/DOCUMENT_VIEWER.JS
// ============================================================================
// Las funciones del subsistema de visualización y descarga de documentos,
// previsualización Excel con SheetJS, resolución estricta de rutas de Storage,
// historial de versiones y _docStore residen en core/document_viewer.js.

let _DocViewerModule;
try {
    if (typeof DocumentViewer === 'undefined' && typeof require === 'function') {
        _DocViewerModule = require('./core/document_viewer');
    }
} catch (e) {
    // Entorno cliente de navegador
}
const _DV = (typeof DocumentViewer !== 'undefined' ? DocumentViewer : (_DocViewerModule || {}));

function renderInlineAppNotice(msg) {
    if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
        const isSuccess = /exitosamente|✅|🎉|guardad|registrad|confirmad|actualizad/i.test(String(msg || '')) && !/error|no se|denegado|inválid|falta|requiere|❌|⛔/i.test(String(msg || ''));
        window.CrmUI.notify(isSuccess ? 'success' : 'error', String(msg || ''));
    }
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        const activeView = document.querySelector('.view-section.active') || document.getElementById('client-detail-view') || document.getElementById('detail-view');
        if (activeView && typeof document.createElement === 'function') {
            let banner = document.getElementById('b3-inline-view-notice');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'b3-inline-view-notice';
                if (activeView.firstChild && typeof activeView.insertBefore === 'function') {
                    activeView.insertBefore(banner, activeView.firstChild);
                } else if (typeof activeView.appendChild === 'function') {
                    activeView.appendChild(banner);
                }
            } else if (banner.parentElement !== activeView && activeView.firstChild && typeof activeView.insertBefore === 'function') {
                activeView.insertBefore(banner, activeView.firstChild);
            }
            const isSuccess = /exitosamente|✅|🎉|guardad|registrad|confirmad|actualizad/i.test(String(msg || '')) && !/error|no se|denegado|inválid|falta|requiere|❌|⛔/i.test(String(msg || ''));
            banner.style.cssText = isSuccess
                ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem;'
                : 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fca5a5; font-size:0.84rem;';
            banner.textContent = String(msg || '');
        }
    }
}
if (typeof initDocumentViewer === 'function') {
    initDocumentViewer({
        getFirebaseFunctions: () => (typeof firebase !== 'undefined' && firebase.functions ? firebase.functions() : null),
        getFirestore: () => (typeof db !== 'undefined' && db ? db : (typeof firebase !== 'undefined' && firebase.firestore ? firebase.firestore() : null)),
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
        getStoragePrefix: () => (typeof STORAGE_PREFIX !== 'undefined' ? STORAGE_PREFIX : 'prod_files'),
        getCurrentProspectId: () => (typeof currentProspectId !== 'undefined' ? currentProspectId : null),
        getCurrentUser: () => (typeof currentUser !== 'undefined' ? currentUser : null),
        deleteClientDocument: (clientId, docKey, itemIndex) => {
            if (typeof deleteClientDocument === 'function') {
                return deleteClientDocument(clientId, docKey, itemIndex);
            }
            if (typeof window !== 'undefined' && typeof window.deleteClientDocument === 'function') {
                return window.deleteClientDocument(clientId, docKey, itemIndex);
            }
            return null;
        },
        showLoading: (msg) => (typeof showLoading === 'function' ? showLoading(msg) : null),
        hideLoading: () => (typeof hideLoading === 'function' ? hideLoading() : null),
        alert: (msg) => {
            if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
                return window.CrmUI.notify('error', String(msg || ''));
            }
            console.warn('[DocViewer]', msg);
        }
    });
}

// Proxies locales para compatibilidad interna y ámbito léxico en Node/tests
const escapeHtmlDoc = (typeof window !== 'undefined' && window.escapeHtmlDoc) || _DV.escapeHtmlDoc || (s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
const resolveStoragePath = (typeof window !== 'undefined' && window.resolveStoragePath) || _DV.resolveStoragePath;
const downloadSecureDocument = (typeof window !== 'undefined' && window.downloadSecureDocument) || _DV.downloadSecureDocument;
const viewSecureDocument = (typeof window !== 'undefined' && window.viewSecureDocument) || _DV.viewSecureDocument;
const openDocPreviewModal = (typeof window !== 'undefined' && window.openDocPreviewModal) || _DV.openDocPreviewModal;
const closeDocPreviewModal = (typeof window !== 'undefined' && window.closeDocPreviewModal) || _DV.closeDocPreviewModal;
const displayDocumentInModal = (typeof window !== 'undefined' && window.displayDocumentInModal) || _DV.displayDocumentInModal;
const showDocPreviewError = (typeof window !== 'undefined' && window.showDocPreviewError) || _DV.showDocPreviewError;
const loadXlsxLibrary = (typeof window !== 'undefined' && window.loadXlsxLibrary) || _DV.loadXlsxLibrary;
const renderExcelPreviewInModal = (typeof window !== 'undefined' && window.renderExcelPreviewInModal) || _DV.renderExcelPreviewInModal;
const selectExcelSheet = (typeof window !== 'undefined' && window.selectExcelSheet) || _DV.selectExcelSheet;
const renderSheetTable = (typeof window !== 'undefined' && window.renderSheetTable) || _DV.renderSheetTable;
const KNOWN_DOC_LABELS = (typeof window !== 'undefined' && window.KNOWN_DOC_LABELS) || _DV.KNOWN_DOC_LABELS;
const formatClientDocLabel = (typeof window !== 'undefined' && window.formatClientDocLabel) || _DV.formatClientDocLabel;
const getDocStore = (typeof window !== 'undefined' && window.getDocStore) || _DV.getDocStore;
const viewStoredClientDoc = (typeof window !== 'undefined' && window.viewStoredClientDoc) || _DV.viewStoredClientDoc;
const downloadStoredClientDoc = (typeof window !== 'undefined' && window.downloadStoredClientDoc) || _DV.downloadStoredClientDoc;
const deleteStoredClientDoc = (typeof window !== 'undefined' && window.deleteStoredClientDoc) || _DV.deleteStoredClientDoc;
const renderClientDocItem = (typeof window !== 'undefined' && window.renderClientDocItem) || _DV.renderClientDocItem;
const showDocumentVersionHistory = (typeof window !== 'undefined' && window.showDocumentVersionHistory) || _DV.showDocumentVersionHistory;
const closeDocumentVersionHistory = (typeof window !== 'undefined' && window.closeDocumentVersionHistory) || _DV.closeDocumentVersionHistory;
const isFormatPreviewable = (typeof window !== 'undefined' && window.isFormatPreviewable) || _DV.isFormatPreviewable;
const isExcelFormat = (typeof window !== 'undefined' && window.isExcelFormat) || _DV.isExcelFormat;
const PREVIEWABLE_EXTS = (typeof window !== 'undefined' && window.PREVIEWABLE_EXTS) || _DV.PREVIEWABLE_EXTS;

// =========================================================================
// Subsistema Modular de Clientes (Fase 6.2.1)
// =========================================================================
let _ClientsControllerModule = null;
let _ClientDocumentsModule = null;
let _ClientsUIModule = null;

if (typeof require !== 'undefined') {
    if (typeof ClientsController === 'undefined') {
        try { _ClientsControllerModule = require('./modules/clients/clients_controller.js'); } catch (e) {}
    }
    if (typeof ClientDocuments === 'undefined') {
        try { _ClientDocumentsModule = require('./modules/clients/client_documents.js'); } catch (e) {}
    }
    if (typeof ClientsUI === 'undefined') {
        try { _ClientsUIModule = require('./modules/clients/clients_ui.js'); } catch (e) {}
    }
}

const _CC = (typeof ClientsController !== 'undefined' ? ClientsController : (_ClientsControllerModule || {}));
const _CD = (typeof ClientDocuments !== 'undefined' ? ClientDocuments : (_ClientDocumentsModule || {}));
const _CUI = (typeof ClientsUI !== 'undefined' ? ClientsUI : (_ClientsUIModule || {}));

const _getClientController = () => (typeof ClientsController !== 'undefined' ? ClientsController : _CC);
const _getClientDocuments = () => (typeof ClientDocuments !== 'undefined' ? ClientDocuments : _CD);
const _getClientsUI = () => (typeof ClientsUI !== 'undefined' ? ClientsUI : _CUI);

const _initClientsFn = (typeof initClientsModule === 'function' ? initClientsModule : (_CUI.initClientsModule || (typeof window !== 'undefined' && window.initClientsModule)));
if (typeof _initClientsFn === 'function') {
    _initClientsFn({
        getCurrentUser: () => (typeof currentUser !== 'undefined' && currentUser ? currentUser : (typeof window !== 'undefined' && window.currentUser ? window.currentUser : null)),
        getProspects: () => (typeof prospects !== 'undefined' && prospects && prospects.length ? prospects : (typeof window !== 'undefined' && window.prospects ? window.prospects : (typeof prospects !== 'undefined' ? prospects : []))),
        getClients: () => (typeof clients !== 'undefined' && clients && clients.length ? clients : (typeof window !== 'undefined' && window.clients ? window.clients : (typeof clients !== 'undefined' ? clients : []))),
        setClients: (val) => {
            if (typeof clients !== 'undefined') clients = val;
            if (typeof window !== 'undefined') window.clients = val;
        },
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
        getStoragePrefix: () => (typeof STORAGE_PREFIX !== 'undefined' ? STORAGE_PREFIX : 'prod_files'),
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
        getFirestore: () => (typeof db !== 'undefined' && db ? db : (typeof firebase !== 'undefined' && firebase.firestore ? firebase.firestore() : null)),
        getCrmClients: () => (typeof CrmClients !== 'undefined' ? CrmClients : (typeof window !== 'undefined' ? window.CrmClients : null)),
        getCrmCommercial: () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null)),
        getDocumentViewer: () => (typeof DocumentViewer !== 'undefined' ? DocumentViewer : (_DV || (typeof window !== 'undefined' ? window.DocumentViewer : null))),
        uploadFileToStorage: (file, path, opts) => (typeof uploadFileToStorage === 'function' ? uploadFileToStorage(file, path, opts) : Promise.reject(new Error('uploadFileToStorage no disponible'))),
        compressImage: (file, maxWidth, maxHeight, quality) => (typeof compressImage === 'function' ? compressImage(file, maxWidth, maxHeight, quality) : Promise.resolve(file)),
        escapeHtmlDoc: (s) => (typeof escapeHtmlDoc === 'function' ? escapeHtmlDoc(s) : String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))),
        formatDate: (d) => (typeof formatDate === 'function' ? formatDate(d) : String(d || '')),
        formatDateTime: (d) => (typeof formatDateTime === 'function' ? formatDateTime(d) : String(d || '')),
        normalizeWhatsAppNumber: (phone) => (typeof normalizeWhatsAppNumber === 'function' ? normalizeWhatsAppNumber(phone) : (phone || '').replace(/\D/g, '')),
        showLoading: (msg) => (typeof showLoading === 'function' ? showLoading(msg) : null),
        hideLoading: () => (typeof hideLoading === 'function' ? hideLoading() : null),
        alert: (msg) => renderInlineAppNotice(msg),
        confirm: () => true,
        openModal: (id) => (typeof openModal === 'function' ? openModal(id) : null),
        closeModal: (id) => (typeof closeModal === 'function' ? closeModal(id) : null),
        renderClosingDocumentationPanel: (prospectId) => (typeof renderClosingDocumentationPanel === 'function' ? renderClosingDocumentationPanel(prospectId) : null)
    });
}

// =========================================================================
// Subsistema Modular de Oportunidades y Propuestas (Fase 6.3.1 - Bloque 1)
// =========================================================================
let _OpportunitiesControllerModule = null;

if (typeof require !== 'undefined') {
    if (typeof OpportunitiesController === 'undefined') {
        try { _OpportunitiesControllerModule = require('./modules/opportunities/opportunities_controller.js'); } catch (e) {}
    }
}

const _OC = (typeof OpportunitiesController !== 'undefined' ? OpportunitiesController : (_OpportunitiesControllerModule || {}));
const _getOpportunitiesController = () => (typeof OpportunitiesController !== 'undefined' ? OpportunitiesController : _OC);

const _initOpportunitiesFn = (typeof initOpportunitiesController === 'function' ? initOpportunitiesController : (_OC.init || (typeof window !== 'undefined' && window.initOpportunitiesController)));
if (typeof _initOpportunitiesFn === 'function') {
    _initOpportunitiesFn({
        getCurrentUser: () => (typeof currentUser !== 'undefined' && currentUser ? currentUser : (typeof window !== 'undefined' && window.currentUser ? window.currentUser : null)),
        getProspects: () => (typeof prospects !== 'undefined' && prospects && prospects.length ? prospects : (typeof window !== 'undefined' && window.prospects ? window.prospects : (typeof prospects !== 'undefined' ? prospects : []))),
        setProspects: (val) => {
            if (typeof prospects !== 'undefined') prospects = val;
            if (typeof window !== 'undefined') window.prospects = val;
        },
        getClients: () => (typeof clients !== 'undefined' && clients && clients.length ? clients : (typeof window !== 'undefined' && window.clients ? window.clients : (typeof clients !== 'undefined' ? clients : []))),
        getUsers: () => (typeof users !== 'undefined' && users && users.length ? users : (typeof window !== 'undefined' && window.users ? window.users : (typeof users !== 'undefined' ? users : []))),
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
        getCrmCommercial: () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null)),
        getCrmFollowUpCalc: () => (typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc : (typeof window !== 'undefined' ? window.CrmFollowUpCalc : null)),
        getClientName: (id) => (typeof getClientName === 'function' ? getClientName(id) : String(id || '-')),
        getCurrentProspectId: () => (typeof currentProspectId !== 'undefined' ? currentProspectId : null),
        setCurrentProspectId: (id) => {
            if (typeof currentProspectId !== 'undefined') currentProspectId = id;
            if (typeof window !== 'undefined') window.currentProspectId = id;
        },
        openModal: (id) => (typeof openModal === 'function' ? openModal(id) : null),
        closeModal: (id) => (typeof closeModal === 'function' ? closeModal(id) : null),
        openDetail: (id) => (typeof openDetail === 'function' ? openDetail(id) : null),
        renderList: () => (typeof renderList === 'function' ? renderList() : null),
        renderTracker: (p) => (typeof renderTracker === 'function' ? renderTracker(p) : null),
        renderInfo: (p) => (typeof renderInfo === 'function' ? renderInfo(p) : null),
        goBackFromDetail: () => (typeof goBackFromDetail === 'function' ? goBackFromDetail() : null),
        runWorkflowOp: (label, fn) => (typeof runWorkflowOp === 'function' ? runWorkflowOp(label, fn) : Promise.resolve(null)),
        showLoading: (msg) => (typeof showLoading === 'function' ? showLoading(msg) : null),
        hideLoading: () => (typeof hideLoading === 'function' ? hideLoading() : null),
        alert: (msg) => renderInlineAppNotice(msg),
        confirm: () => true,
        prompt: (msg) => (typeof prompt === 'function' ? prompt(msg) : ''),
        formatCurrency: (n) => (typeof formatCurrency === 'function' ? formatCurrency(n) : '$' + Number(n || 0).toFixed(2)),
        hasEnteredPostclosing: (p) => (typeof hasEnteredPostclosing === 'function' ? hasEnteredPostclosing(p) : !!(p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado'))))
    });
}

// =========================================================================
// Subsistema Modular de Oportunidades: UI y Pipeline (Fase 6.3.1 - Bloque 2A)
// =========================================================================
let _OpportunitiesUIModule = null;

if (typeof require !== 'undefined') {
    if (typeof OpportunitiesUI === 'undefined') {
        try { _OpportunitiesUIModule = require('./modules/opportunities/opportunities_ui.js'); } catch (e) {}
    }
}

const _OUI = (typeof OpportunitiesUI !== 'undefined' ? OpportunitiesUI : (_OpportunitiesUIModule || {}));
const _getOpportunitiesUI = () => (typeof OpportunitiesUI !== 'undefined' ? OpportunitiesUI : _OUI);

const _initOpportunitiesUIFn = (typeof initOpportunitiesUI === 'function' ? initOpportunitiesUI : (_OUI.init || (typeof window !== 'undefined' && window.initOpportunitiesUI)));
if (typeof _initOpportunitiesUIFn === 'function') {
    _initOpportunitiesUIFn({
        getCurrentUser: () => (typeof currentUser !== 'undefined' && currentUser ? currentUser : (typeof window !== 'undefined' && window.currentUser ? window.currentUser : null)),
        getProspects: () => (typeof prospects !== 'undefined' && prospects && prospects.length ? prospects : (typeof window !== 'undefined' && window.prospects ? window.prospects : (typeof prospects !== 'undefined' ? prospects : []))),
        getClients: () => (typeof clients !== 'undefined' && clients && clients.length ? clients : (typeof window !== 'undefined' && window.clients ? window.clients : (typeof clients !== 'undefined' ? clients : []))),
        getUsers: () => (typeof users !== 'undefined' && users && users.length ? users : (typeof window !== 'undefined' && window.users ? window.users : (typeof users !== 'undefined' ? users : []))),
        getOpportunitiesController: () => (typeof _getOpportunitiesController === 'function' ? _getOpportunitiesController() : null),
        getClientName: (id) => (typeof getClientName === 'function' ? getClientName(id) : String(id || '-')),
        getProspectVendorInfo: (p) => (typeof getProspectVendorInfo === 'function' ? getProspectVendorInfo(p) : { name: '-', role: '', avatar: '?' }),
        parseProspectDate: (d) => (typeof parseProspectDate === 'function' ? parseProspectDate(d) : null),
        formatProspectDate: (d) => (typeof formatProspectDate === 'function' ? formatProspectDate(d) : String(d || '-')),
        formatCurrency: (n) => (typeof formatCurrency === 'function' ? formatCurrency(n) : '$' + Number(n || 0).toFixed(2)),
        escapeHtmlDoc: (s) => (typeof escapeHtmlDoc === 'function' ? escapeHtmlDoc(s) : String(s || '')),
        openDetail: (id) => (typeof openDetail === 'function' ? openDetail(id) : null),
        getOppStatusFilter: () => (typeof getOppStatusFilter === 'function' ? getOppStatusFilter() : (typeof oppStatusFilter !== 'undefined' ? oppStatusFilter : 'activas')),
        getOppClasifFilter: () => (typeof getOppClasifFilter === 'function' ? getOppClasifFilter() : (typeof oppClasifFilter !== 'undefined' ? oppClasifFilter : 'todas')),
        getOppStageFilter: () => (typeof getOppStageFilter === 'function' ? getOppStageFilter() : (typeof oppStageFilter !== 'undefined' ? oppStageFilter : 'todas')),
        getOppSortCol: () => (typeof getOppSortCol === 'function' ? getOppSortCol() : (typeof oppSortCol !== 'undefined' ? oppSortCol : '')),
        getOppSortDir: () => (typeof getOppSortDir === 'function' ? getOppSortDir() : (typeof oppSortDir !== 'undefined' ? oppSortDir : 'asc')),
        updateOppSortIcons: () => (typeof updateOppSortIcons === 'function' ? updateOppSortIcons() : null),
        getCrmLoadError: () => (typeof crmLoadError !== 'undefined' ? crmLoadError : null),
        getInitialLoadCompleted: () => (typeof initialLoadCompleted !== 'undefined' ? initialLoadCompleted : true),
        retryDataListeners: () => (typeof retryDataListeners === 'function' ? retryDataListeners() : null),
        getStages: () => (typeof STAGES !== 'undefined' ? STAGES : ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre']),
        getCurrentProspectId: () => (typeof currentProspectId !== 'undefined' ? currentProspectId : null),
        setCurrentProspectId: (id) => {
            if (typeof currentProspectId !== 'undefined') currentProspectId = id;
            if (typeof window !== 'undefined') window.currentProspectId = id;
        },
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : null),
        getCrmCommercial: () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : (typeof window !== 'undefined' ? window.CrmCommercial : null)),
        getCrmFollowUpCalc: () => (typeof CrmFollowUpCalc !== 'undefined' ? CrmFollowUpCalc : (typeof window !== 'undefined' ? window.CrmFollowUpCalc : null)),
        getCrmWorkCalendar: () => (typeof CrmWorkCalendar !== 'undefined' ? CrmWorkCalendar : (typeof window !== 'undefined' ? window.CrmWorkCalendar : null)),
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod'),
        getSettings: () => (typeof settings !== 'undefined' ? settings : (typeof window !== 'undefined' && window.settings ? window.settings : { visitantes: [] })),
        getDaysDifference: (d1) => (typeof getDaysDifference === 'function' ? getDaysDifference(d1) : Math.floor((new Date() - new Date(d1 || new Date())) / (1000 * 60 * 60 * 24))),
        formatDate: (d) => (typeof formatDate === 'function' ? formatDate(d) : String(d || '-').slice(0, 10)),
        hasEnteredPostclosing: (p) => (typeof hasEnteredPostclosing === 'function' ? hasEnteredPostclosing(p) : !!(p && (p.postcierre_habilitado === true || (p.etapa === 'cierre' && p.estado === 'ganado')))),
        saveListScrollPosition: () => (typeof saveListScrollPosition === 'function' ? saveListScrollPosition() : null),
        showView: (v) => (typeof showView === 'function' ? showView(v) : null),
        renderClientContactCard: (p) => (typeof renderClientContactCard === 'function' ? renderClientContactCard(p) : null),
        renderFinancials: (p) => (typeof renderFinancials === 'function' ? renderFinancials(p) : null),
        renderDailyAgenda: () => (typeof renderDailyAgenda === 'function' ? renderDailyAgenda() : null),
        openModal: (id) => (typeof openModal === 'function' ? openModal(id) : null),
        closeModal: (id) => (typeof closeModal === 'function' ? closeModal(id) : null),
        runWorkflowOp: (msg, fn) => (typeof runWorkflowOp === 'function' ? runWorkflowOp(msg, fn) : Promise.resolve(null)),
        showLoading: (msg) => (typeof showLoading === 'function' ? showLoading(msg) : null),
        hideLoading: () => (typeof hideLoading === 'function' ? hideLoading() : null),
        alert: (msg) => renderInlineAppNotice(msg),
        confirm: () => true,
        uploadFileToStorage: (file, folder, opts) => (typeof uploadFileToStorage === 'function' ? uploadFileToStorage(file, folder, opts) : null),
        getProspectClient: (clientId) => (typeof getProspectClient === 'function' ? getProspectClient(clientId) : null),
        normalizeWhatsAppNumber: (rawPhone) => (typeof normalizeWhatsAppNumber === 'function' ? normalizeWhatsAppNumber(rawPhone) : ''),
        getMotivosPerdida: () => (typeof MOTIVOS_PERDIDA !== 'undefined' ? MOTIVOS_PERDIDA : []),
        getDocStore: () => (typeof getDocStore === 'function' ? getDocStore() : (typeof window !== 'undefined' ? window._docStore : null)),
        renderClientSelect: () => (typeof renderClientSelect === 'function' ? renderClientSelect() : null)
    });
}

// =========================================================================
// Subsistema Modular de Finanzas, Facturación y Cobranzas (Fase 6.4)
// =========================================================================
let _FinanceCalculationsModule = null;
let _FinanceChangeOrdersModule = null;
let _FinanceInvoicingModule = null;
let _FinancePaymentsModule = null;
let _FinanceContractsModule = null;
let _FinanceControllerModule = null;
let _FinanceUIModule = null;

if (typeof require !== 'undefined') {
    try { if (typeof FinanceCalculations === 'undefined') _FinanceCalculationsModule = require('./modules/finance/finance_calculations.js'); } catch (e) {}
    try { if (typeof FinanceChangeOrders === 'undefined') _FinanceChangeOrdersModule = require('./modules/finance/finance_change_orders.js'); } catch (e) {}
    try { if (typeof FinanceInvoicing === 'undefined') _FinanceInvoicingModule = require('./modules/finance/finance_invoicing.js'); } catch (e) {}
    try { if (typeof FinancePayments === 'undefined') _FinancePaymentsModule = require('./modules/finance/finance_payments.js'); } catch (e) {}
    try { if (typeof FinanceContracts === 'undefined') _FinanceContractsModule = require('./modules/finance/finance_contracts.js'); } catch (e) {}
    try { if (typeof FinanceController === 'undefined') _FinanceControllerModule = require('./modules/finance/finance_controller.js'); } catch (e) {}
    try { if (typeof FinanceUI === 'undefined') _FinanceUIModule = require('./modules/finance/finance_ui.js'); } catch (e) {}
}

const _FCALC = (typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : (_FinanceCalculationsModule || {}));
const _getFinanceCalculations = () => (typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : _FCALC);

const _FCO = (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : (_FinanceChangeOrdersModule || {}));
const _getFinanceChangeOrders = () => (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : _FCO);

const _FINV = (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : (_FinanceInvoicingModule || {}));
const _getFinanceInvoicing = () => (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : _FINV);

const _FPAY = (typeof FinancePayments !== 'undefined' ? FinancePayments : (_FinancePaymentsModule || {}));
const _getFinancePayments = () => (typeof FinancePayments !== 'undefined' ? FinancePayments : _FPAY);

const _FCON = (typeof FinanceContracts !== 'undefined' ? FinanceContracts : (_FinanceContractsModule || {}));
const _getFinanceContracts = () => (typeof FinanceContracts !== 'undefined' ? FinanceContracts : _FCON);

const _FCTL = (typeof FinanceController !== 'undefined' ? FinanceController : (_FinanceControllerModule || {}));
const _getFinanceController = () => (typeof FinanceController !== 'undefined' ? FinanceController : _FCTL);

const _FUI = (typeof FinanceUI !== 'undefined' ? FinanceUI : (_FinanceUIModule || {}));
const _getFinanceUI = () => (typeof FinanceUI !== 'undefined' ? FinanceUI : _FUI);

let _DashboardControllerModule = null;
let _DashboardUIModule = null;
let _DashboardChartsModule = null;
let _DashboardManagerWorkflowModule = null;
let _DashboardAuditModule = null;

if (typeof require !== 'undefined') {
    try { if (typeof DashboardController === 'undefined') _DashboardControllerModule = require('./modules/dashboard/dashboard_controller.js'); } catch (e) {}
    try { if (typeof DashboardUI === 'undefined') _DashboardUIModule = require('./modules/dashboard/dashboard_ui.js'); } catch (e) {}
    try { if (typeof DashboardCharts === 'undefined') _DashboardChartsModule = require('./modules/dashboard/dashboard_charts.js'); } catch (e) {}
    try { if (typeof DashboardManagerWorkflow === 'undefined') _DashboardManagerWorkflowModule = require('./modules/dashboard/dashboard_manager_workflow.js'); } catch (e) {}
    try { if (typeof DashboardAudit === 'undefined') _DashboardAuditModule = require('./modules/dashboard/dashboard_audit.js'); } catch (e) {}
}

const _DB_CTL = (typeof DashboardController !== 'undefined' ? DashboardController : (_DashboardControllerModule || {}));
const _getDashboardController = () => (typeof DashboardController !== 'undefined' ? DashboardController : ((typeof window !== 'undefined' && window.DashboardController) ? window.DashboardController : _DB_CTL));

const _DB_UI = (typeof DashboardUI !== 'undefined' ? DashboardUI : (_DashboardUIModule || {}));
const _getDashboardUI = () => (typeof DashboardUI !== 'undefined' ? DashboardUI : ((typeof window !== 'undefined' && window.DashboardUI) ? window.DashboardUI : _DB_UI));

const _DB_CHARTS = (typeof DashboardCharts !== 'undefined' ? DashboardCharts : (_DashboardChartsModule || {}));
const _getDashboardCharts = () => (typeof DashboardCharts !== 'undefined' ? DashboardCharts : ((typeof window !== 'undefined' && window.DashboardCharts) ? window.DashboardCharts : _DB_CHARTS));

const _DB_MWF = (typeof DashboardManagerWorkflow !== 'undefined' ? DashboardManagerWorkflow : (_DashboardManagerWorkflowModule || {}));
const _getDashboardManagerWorkflow = () => (typeof DashboardManagerWorkflow !== 'undefined' ? DashboardManagerWorkflow : ((typeof window !== 'undefined' && window.DashboardManagerWorkflow) ? window.DashboardManagerWorkflow : _DB_MWF));

const _DB_AUDIT = (typeof DashboardAudit !== 'undefined' ? DashboardAudit : (_DashboardAuditModule || {}));
const _getDashboardAudit = () => (typeof DashboardAudit !== 'undefined' ? DashboardAudit : ((typeof window !== 'undefined' && window.DashboardAudit) ? window.DashboardAudit : _DB_AUDIT));

let _UsersPermissionsModule = null;
let _UsersUIModule = null;
let _UsersControllerModule = null;
let _AuthSessionModule = null;

if (typeof require !== 'undefined') {
    try { if (typeof UsersPermissions === 'undefined') _UsersPermissionsModule = require('./modules/users/users_permissions.js'); } catch (e) {}
    try { if (typeof UsersUI === 'undefined') _UsersUIModule = require('./modules/users/users_ui.js'); } catch (e) {}
    try { if (typeof UsersController === 'undefined') _UsersControllerModule = require('./modules/users/users_controller.js'); } catch (e) {}
    try { if (typeof AuthSession === 'undefined') _AuthSessionModule = require('./modules/users/auth_session.js'); } catch (e) {}
}

const _USERS_PERM = (typeof UsersPermissions !== 'undefined' ? UsersPermissions : (_UsersPermissionsModule || {}));
const _getUsersPermissions = () => (typeof UsersPermissions !== 'undefined' ? UsersPermissions : ((typeof window !== 'undefined' && window.UsersPermissions) ? window.UsersPermissions : _USERS_PERM));

const _USERS_UI = (typeof UsersUI !== 'undefined' ? UsersUI : (_UsersUIModule || {}));
const _getUsersUI = () => (typeof UsersUI !== 'undefined' ? UsersUI : ((typeof window !== 'undefined' && window.UsersUI) ? window.UsersUI : _USERS_UI));

const _USERS_CTL = (typeof UsersController !== 'undefined' ? UsersController : (_UsersControllerModule || {}));
const _getUsersController = () => (typeof UsersController !== 'undefined' ? UsersController : ((typeof window !== 'undefined' && window.UsersController) ? window.UsersController : _USERS_CTL));

const _AUTH_SESSION = (typeof AuthSession !== 'undefined' ? AuthSession : (_AuthSessionModule || {}));
const _getAuthSession = () => (typeof AuthSession !== 'undefined' ? AuthSession : ((typeof window !== 'undefined' && window.AuthSession) ? window.AuthSession : _AUTH_SESSION));

// Inyección de dependencias para los submódulos de Finanzas
(function _initFinanceSubsystems() {
    const safeGetClients = () => {
        if (typeof clients !== 'undefined' && Array.isArray(clients) && clients.length > 0) return clients;
        if (typeof window !== 'undefined' && Array.isArray(window.clients) && window.clients.length > 0) return window.clients;
        if (typeof global !== 'undefined' && Array.isArray(global.clients) && global.clients.length > 0) return global.clients;
        if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
        if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
        if (typeof global !== 'undefined' && Array.isArray(global.clients)) return global.clients;
        return [];
    };
    const safeGetProspects = () => {
        if (typeof prospects !== 'undefined' && Array.isArray(prospects) && prospects.length > 0) return prospects;
        if (typeof window !== 'undefined' && Array.isArray(window.prospects) && window.prospects.length > 0) return window.prospects;
        if (typeof global !== 'undefined' && Array.isArray(global.prospects) && global.prospects.length > 0) return global.prospects;
        if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
        if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
        if (typeof global !== 'undefined' && Array.isArray(global.prospects)) return global.prospects;
        return [];
    };
    const safeGetCurrentUser = () => {
        if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
        if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
        if (typeof global !== 'undefined' && global.currentUser) return global.currentUser;
        return null;
    };
    const safeGetCurrentProspectId = () => {
        if (typeof currentProspectId !== 'undefined' && currentProspectId) return currentProspectId;
        if (typeof window !== 'undefined' && window.currentProspectId) return window.currentProspectId;
        if (typeof global !== 'undefined' && global.currentProspectId) return global.currentProspectId;
        return null;
    };
    const safeGetDbSuffix = () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : ((typeof window !== 'undefined' && window.DB_SUFFIX) ? window.DB_SUFFIX : ((typeof global !== 'undefined' && global.DB_SUFFIX) ? global.DB_SUFFIX : '_prod')));

    const calcMod = _getFinanceCalculations();
    if (calcMod && typeof calcMod.setDeps === 'function') {
        calcMod.setDeps({ getClients: safeGetClients });
    }

    const coMod = _getFinanceChangeOrders();
    if (coMod && typeof coMod.setDeps === 'function') {
        coMod.setDeps({
            getCurrentUser: safeGetCurrentUser,
            getCurrentProspectId: safeGetCurrentProspectId,
            getProspects: safeGetProspects,
            getDbSuffix: safeGetDbSuffix,
            uploadFileToStorage: (...args) => (typeof uploadFileToStorage === 'function' ? uploadFileToStorage(...args) : undefined),
            runWorkflowOp: (...args) => (typeof runWorkflowOp === 'function' ? runWorkflowOp(...args) : undefined),
            closeModal: (...args) => (typeof closeModal === 'function' ? closeModal(...args) : undefined)
        });
    }

    const invMod = _getFinanceInvoicing();
    if (invMod && typeof invMod.setDeps === 'function') {
        invMod.setDeps({
            getCurrentUser: safeGetCurrentUser,
            getCurrentProspectId: safeGetCurrentProspectId,
            getProspects: safeGetProspects,
            getClients: safeGetClients,
            getDbSuffix: safeGetDbSuffix,
            uploadFileToStorage: (...args) => (typeof uploadFileToStorage === 'function' ? uploadFileToStorage(...args) : undefined),
            runWorkflowOp: (...args) => (typeof runWorkflowOp === 'function' ? runWorkflowOp(...args) : undefined)
        });
    }

    const payMod = _getFinancePayments();
    if (payMod && typeof payMod.setDeps === 'function') {
        payMod.setDeps({
            getCurrentUser: safeGetCurrentUser,
            getCurrentProspectId: safeGetCurrentProspectId,
            getProspects: safeGetProspects,
            getClients: safeGetClients,
            getDbSuffix: safeGetDbSuffix,
            uploadFileToStorage: (...args) => (typeof uploadFileToStorage === 'function' ? uploadFileToStorage(...args) : undefined),
            runWorkflowOp: (...args) => (typeof runWorkflowOp === 'function' ? runWorkflowOp(...args) : undefined)
        });
    }

    const conMod = _getFinanceContracts();
    if (conMod && typeof conMod.setDeps === 'function') {
        conMod.setDeps({
            alert: (msg) => renderInlineAppNotice(msg),
            getProspects: safeGetProspects,
            getClients: safeGetClients,
            openClientDetailView: (...args) => (typeof openClientDetailView === 'function' ? openClientDetailView(...args) : undefined),
            getProjectSubtotal: (...args) => (typeof getProjectSubtotal === 'function' ? getProjectSubtotal(...args) : undefined)
        });
    }

    const ctlMod = _getFinanceController();
    if (ctlMod && typeof ctlMod.setDeps === 'function') {
        ctlMod.setDeps({
            renderProjectsList: () => (typeof renderProjectsList === 'function' ? renderProjectsList() : null),
            getDocument: () => (typeof document !== 'undefined' ? document : null)
        });
    }

    const uiMod = _getFinanceUI();
    if (uiMod && typeof uiMod.setDeps === 'function') {
        uiMod.setDeps({
            getCurrentUser: safeGetCurrentUser,
            getProspects: safeGetProspects,
            getClients: safeGetClients,
            getClientName: (...args) => (typeof getClientName === 'function' ? getClientName(...args) : undefined),
            hasEnteredPostclosing: (...args) => (typeof hasEnteredPostclosing === 'function' ? hasEnteredPostclosing(...args) : undefined),
            isProjectFullyPaid: (...args) => (typeof isProjectFullyPaid === 'function' ? isProjectFullyPaid(...args) : undefined),
            getProjectSubtotal: (...args) => (typeof getProjectSubtotal === 'function' ? getProjectSubtotal(...args) : undefined),
            getProjectCosto: (...args) => (typeof getProjectCosto === 'function' ? getProjectCosto(...args) : undefined),
            formatCurrency: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            formatDate: (...args) => (typeof formatDate === 'function' ? formatDate(...args) : undefined),
            escapeHtmlDoc: (...args) => (typeof escapeHtmlDoc === 'function' ? escapeHtmlDoc(...args) : undefined),
            getProjPaymentFilter: (...args) => (typeof getProjPaymentFilter === 'function' ? getProjPaymentFilter(...args) : undefined),
            getProjSortCol: () => (typeof projSortCol !== 'undefined' ? projSortCol : ''),
            getProjSortDir: () => (typeof projSortDir !== 'undefined' ? projSortDir : 'asc'),
            openDetail: (...args) => (typeof openDetail === 'function' ? openDetail(...args) : undefined),
            getDocument: () => (typeof document !== 'undefined' ? document : null)
        });
    }
})();

function getVisibleProspects(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.getVisibleProspects ? mod.getVisibleProspects(...args) : [];
}

function canUserViewProspect(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.canUserViewProspect ? mod.canUserViewProspect(...args) : false;
}

function canUserEditProspect(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.canUserEditProspect ? mod.canUserEditProspect(...args) : false;
}

function canUserDeleteProspect(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.canUserDeleteProspect ? mod.canUserDeleteProspect(...args) : false;
}

function canUserReassignProspect(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.canUserReassignProspect ? mod.canUserReassignProspect(...args) : false;
}

function canUserReactivateProspect(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.canUserReactivateProspect ? mod.canUserReactivateProspect(...args) : false;
}

function getProspectById(...args) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return mod && mod.getProspectById ? mod.getProspectById(...args) : null;
}

// Proxies delegadores para compatibilidad de llamadas internas y tests
function getVisibleClients(...args) {
    const mod = _getClientController();
    return mod.getVisibleClients ? mod.getVisibleClients(...args) : [];
}
function renderClientsTable(...args) {
    const mod = _getClientsUI();
    return mod.renderClientsTable ? mod.renderClientsTable(...args) : undefined;
}
function toggleCliSort(...args) {
    const mod = _getClientsUI();
    return mod.toggleCliSort ? mod.toggleCliSort(...args) : undefined;
}
function updateCliSortIcons(...args) {
    const mod = _getClientsUI();
    return mod.updateCliSortIcons ? mod.updateCliSortIcons(...args) : undefined;
}
function toggleClientFields(...args) {
    const mod = _getClientsUI();
    return mod.toggleClientFields ? mod.toggleClientFields(...args) : undefined;
}
function openClientDetailView(...args) {
    const mod = _getClientsUI();
    return mod.openClientDetailView ? mod.openClientDetailView(...args) : undefined;
}
function closeClientDetailView(...args) {
    const mod = _getClientsUI();
    return mod.closeClientDetailView ? mod.closeClientDetailView(...args) : undefined;
}
function setClientFieldError(...args) {
    const mod = _getClientsUI();
    return mod.setClientFieldError ? mod.setClientFieldError(...args) : undefined;
}
function saveClient(...args) {
    const mod = _getClientsUI();
    return mod.saveClient ? mod.saveClient(...args) : undefined;
}
function renderClientSelect(...args) {
    const mod = _getClientsUI();
    return mod.renderClientSelect ? mod.renderClientSelect(...args) : undefined;
}
function selectClientInSelector(...args) {
    const mod = _getClientsUI();
    return mod.selectClientInSelector ? mod.selectClientInSelector(...args) : undefined;
}
function onClientCatalogSearchInput(...args) {
    const mod = _getClientController();
    return mod.onClientCatalogSearchInput ? mod.onClientCatalogSearchInput(...args) : undefined;
}
function runClientCatalogSearch(...args) {
    const mod = _getClientController();
    return mod.runClientCatalogSearch ? mod.runClientCatalogSearch(...args) : undefined;
}
function catalogueSearchActive(...args) {
    const mod = _getClientController();
    return mod.catalogueSearchActive ? mod.catalogueSearchActive(...args) : false;
}
function getSelectorClientsLocal(...args) {
    const mod = _getClientController();
    return mod.getSelectorClientsLocal ? mod.getSelectorClientsLocal(...args) : [];
}
function persistClientViaServer(...args) {
    const mod = _getClientController();
    return mod.persistClientViaServer ? mod.persistClientViaServer(...args) : Promise.reject(new Error('persistClientViaServer no disponible'));
}
function cancelPendingClientReservation(...args) {
    const mod = _getClientController();
    return mod.cancelPendingClientReservation ? mod.cancelPendingClientReservation(...args) : Promise.resolve();
}
function deleteClient(...args) {
    const mod = _getClientController();
    return mod.deleteClient ? mod.deleteClient(...args) : undefined;
}
function renderClientExpedienteSection(...args) {
    const mod = _getClientDocuments();
    return mod.renderClientExpedienteSection ? mod.renderClientExpedienteSection(...args) : undefined;
}
function hasStagedClientFiles(...args) {
    const mod = _getClientDocuments();
    return mod.hasStagedClientFiles ? mod.hasStagedClientFiles(...args) : false;
}
function uploadClientStagedFiles(...args) {
    const mod = _getClientDocuments();
    return mod.uploadClientStagedFiles ? mod.uploadClientStagedFiles(...args) : Promise.resolve({});
}
function deleteClientDocument(...args) {
    const mod = _getClientDocuments();
    return mod.deleteClientDocument ? mod.deleteClientDocument(...args) : undefined;
}
function uploadClientDocumentFromClosing(...args) {
    const mod = _getClientDocuments();
    return mod.uploadClientDocumentFromClosing ? mod.uploadClientDocumentFromClosing(...args) : Promise.reject(new Error('uploadClientDocumentFromClosing no disponible'));
}
function toggleClientDocSubstForm(...args) {
    const mod = _getClientDocuments();
    return mod.toggleClientDocSubstForm ? mod.toggleClientDocSubstForm(...args) : undefined;
}
function cancelClientDocSubstForm(...args) {
    const mod = _getClientDocuments();
    return mod.cancelClientDocSubstForm ? mod.cancelClientDocSubstForm(...args) : undefined;
}
function getClientName(...args) {
    const mod = _getClientsUI();
    return mod.getClientName ? mod.getClientName(...args) : 'Cliente Desconocido';
}
function getProspectClient(...args) {
    const mod = _getClientsUI();
    return mod.getProspectClient ? mod.getProspectClient(...args) : null;
}
function renderClientContactCard(...args) {
    const mod = _getClientsUI();
    return mod.renderClientContactCard ? mod.renderClientContactCard(...args) : undefined;
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
    if (typeof setOppClasifFilter !== 'undefined') window.setOppClasifFilter = setOppClasifFilter;
    if (typeof getOppClasifFilter !== 'undefined') window.getOppClasifFilter = getOppClasifFilter;
    if (typeof setOppStageFilter !== 'undefined') window.setOppStageFilter = setOppStageFilter;
    if (typeof getOppStageFilter !== 'undefined') window.getOppStageFilter = getOppStageFilter;
    if (typeof setSellerFilterMode !== 'undefined') window.setSellerFilterMode = setSellerFilterMode;
    if (typeof getSellerFilterMode !== 'undefined') window.getSellerFilterMode = getSellerFilterMode;
    if (typeof renderList !== 'undefined') window.renderList = renderList;
    if (typeof showDocumentVersionHistory !== 'undefined') window.showDocumentVersionHistory = showDocumentVersionHistory;
    if (typeof closeDocumentVersionHistory !== 'undefined') window.closeDocumentVersionHistory = closeDocumentVersionHistory;

    // Fachada del subsistema de clientes
    window.getVisibleClients = getVisibleClients;
    window.renderClientsTable = renderClientsTable;
    window.toggleCliSort = toggleCliSort;
    window.updateCliSortIcons = updateCliSortIcons;
    window.toggleClientFields = toggleClientFields;
    window.openClientDetailView = openClientDetailView;
    window.closeClientDetailView = closeClientDetailView;
    window.setClientFieldError = setClientFieldError;
    window.saveClient = saveClient;
    window.renderClientSelect = renderClientSelect;
    window.selectClientInSelector = selectClientInSelector;
    window.onClientCatalogSearchInput = onClientCatalogSearchInput;
    window.runClientCatalogSearch = runClientCatalogSearch;
    window.catalogueSearchActive = catalogueSearchActive;
    window.getSelectorClientsLocal = getSelectorClientsLocal;
    window.persistClientViaServer = persistClientViaServer;
    window.cancelPendingClientReservation = cancelPendingClientReservation;
    window.deleteClient = deleteClient;
    window.renderClientExpedienteSection = renderClientExpedienteSection;
    window.hasStagedClientFiles = hasStagedClientFiles;
    window.uploadClientStagedFiles = uploadClientStagedFiles;
    window.deleteClientDocument = deleteClientDocument;
    window.uploadClientDocumentFromClosing = uploadClientDocumentFromClosing;
    window.toggleClientDocSubstForm = toggleClientDocSubstForm;
    window.cancelClientDocSubstForm = cancelClientDocSubstForm;
    window.getClientName = getClientName;
    window.getProspectClient = getProspectClient;
    window.renderClientContactCard = renderClientContactCard;
    window.getCliSortCol = () => (_getClientsUI().getCliSortCol ? _getClientsUI().getCliSortCol() : '');
    window.getCliSortDir = () => (_getClientsUI().getCliSortDir ? _getClientsUI().getCliSortDir() : 'asc');
    window.setCliSort = (col, dir) => { if (_getClientsUI().setCliSort) _getClientsUI().setCliSort(col, dir); };
    try {
        Object.defineProperty(window, 'cliSortCol', {
            get: () => (_getClientsUI().getCliSortCol ? _getClientsUI().getCliSortCol() : ''),
            set: (v) => { if (_getClientsUI().setCliSort) _getClientsUI().setCliSort(v, _getClientsUI().getCliSortDir ? _getClientsUI().getCliSortDir() : 'asc'); },
            configurable: true
        });
        Object.defineProperty(window, 'cliSortDir', {
            get: () => (_getClientsUI().getCliSortDir ? _getClientsUI().getCliSortDir() : 'asc'),
            set: (v) => { if (_getClientsUI().setCliSort) _getClientsUI().setCliSort(_getClientsUI().getCliSortCol ? _getClientsUI().getCliSortCol() : '', v); },
            configurable: true
        });
        Object.defineProperty(window, 'oppSortCol', {
            get: () => (_getOpportunitiesController().getOppSortCol ? _getOpportunitiesController().getOppSortCol() : oppSortCol),
            set: (v) => {
                oppSortCol = v;
                if (_getOpportunitiesController().setOppSort) _getOpportunitiesController().setOppSort(v, oppSortDir);
            },
            configurable: true
        });
        Object.defineProperty(window, 'oppSortDir', {
            get: () => (_getOpportunitiesController().getOppSortDir ? _getOpportunitiesController().getOppSortDir() : oppSortDir),
            set: (v) => {
                oppSortDir = v;
                if (_getOpportunitiesController().setOppSort) _getOpportunitiesController().setOppSort(oppSortCol, v);
            },
            configurable: true
        });
        Object.defineProperty(window, 'oppStatusFilter', {
            get: () => (_getOpportunitiesController().getOppStatusFilter ? _getOpportunitiesController().getOppStatusFilter() : oppStatusFilter),
            set: (v) => {
                oppStatusFilter = v;
                if (_getOpportunitiesController().setOppStatusFilter) _getOpportunitiesController().setOppStatusFilter(v);
            },
            configurable: true
        });
        Object.defineProperty(window, 'oppClasifFilter', {
            get: () => (_getOpportunitiesController().getOppClasifFilter ? _getOpportunitiesController().getOppClasifFilter() : oppClasifFilter),
            set: (v) => {
                oppClasifFilter = v;
                if (_getOpportunitiesController().setOppClasifFilter) _getOpportunitiesController().setOppClasifFilter(v);
            },
            configurable: true
        });
        Object.defineProperty(window, 'oppStageFilter', {
            get: () => (_getOpportunitiesController().getOppStageFilter ? _getOpportunitiesController().getOppStageFilter() : oppStageFilter),
            set: (v) => {
                oppStageFilter = v;
                if (_getOpportunitiesController().setOppStageFilter) _getOpportunitiesController().setOppStageFilter(v);
            },
            configurable: true
        });
    } catch (e) {}
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
        setOppClasifFilter: typeof setOppClasifFilter !== 'undefined' ? setOppClasifFilter : undefined,
        getOppClasifFilter: typeof getOppClasifFilter !== 'undefined' ? getOppClasifFilter : undefined,
        setOppStageFilter: typeof setOppStageFilter !== 'undefined' ? setOppStageFilter : undefined,
        getOppStageFilter: typeof getOppStageFilter !== 'undefined' ? getOppStageFilter : undefined,
        setSellerFilterMode: typeof setSellerFilterMode !== 'undefined' ? setSellerFilterMode : undefined,
        getSellerFilterMode: typeof getSellerFilterMode !== 'undefined' ? getSellerFilterMode : undefined,
        renderList: typeof renderList !== 'undefined' ? renderList : undefined,
        renderSheetTable: typeof renderSheetTable !== 'undefined' ? renderSheetTable : undefined,
        renderClientExpedienteSection: typeof renderClientExpedienteSection !== 'undefined' ? renderClientExpedienteSection : undefined,
        parseProspectDate: typeof parseProspectDate !== 'undefined' ? parseProspectDate : undefined,
        formatProspectDate: typeof formatProspectDate !== 'undefined' ? formatProspectDate : undefined,
        clearOppDateFilter: typeof clearOppDateFilter !== 'undefined' ? clearOppDateFilter : undefined,
        toggleOppSort: typeof toggleOppSort !== 'undefined' ? toggleOppSort : undefined,
        updateOppSortIcons: typeof updateOppSortIcons !== 'undefined' ? updateOppSortIcons : undefined,
        showDocumentVersionHistory: typeof showDocumentVersionHistory !== 'undefined' ? showDocumentVersionHistory : undefined,
        closeDocumentVersionHistory: typeof closeDocumentVersionHistory !== 'undefined' ? closeDocumentVersionHistory : undefined,

        // Re-exportes del subsistema de clientes
        getVisibleClients,
        renderClientsTable,
        toggleCliSort,
        updateCliSortIcons,
        toggleClientFields,
        openClientDetailView,
        closeClientDetailView,
        setClientFieldError,
        saveClient,
        renderClientSelect,
        selectClientInSelector,
        onClientCatalogSearchInput,
        runClientCatalogSearch,
        catalogueSearchActive,
        getSelectorClientsLocal,
        persistClientViaServer,
        cancelPendingClientReservation,
        deleteClient,
        hasStagedClientFiles,
        uploadClientStagedFiles,
        deleteClientDocument,
        uploadClientDocumentFromClosing,
        toggleClientDocSubstForm,
        cancelClientDocSubstForm,
        getClientName,
        getProspectClient,
        renderClientContactCard,

        // Re-exportes del subsistema de oportunidades (Fase 6.3.1 - Bloque 1)
        getVisibleProspects,
        canUserViewProspect,
        canUserEditProspect,
        canUserDeleteProspect,
        canUserReassignProspect,
        canUserReactivateProspect,
        getProspectVendorInfo,
        reassignVendor,
        processConfirmReassign,
        deleteProspect,
        reactivateLostProspect,
        OpportunitiesController: _OC,
        OpportunitiesUI: _OUI,
        renderList: typeof renderList !== 'undefined' ? renderList : undefined
    };
}

const STAGES = ['prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
const PROBABILIDADES = { 'alta': 75, 'media': 50, 'baja': 25, 'improbable': 10 };
const MOTIVOS_PERDIDA = ["Precio", "Falta de seguimiento", "No se cumplían los requerimientos técnicos", "Tiempo de entrega", "Cliente desiste"];
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const KPI_LIMITS = { 'prospecto': 3, 'levantamiento': 5, 'cotizacion': 5, 'negociacion': null, 'cierre': 5 };

// DB State (Centralizado en core/app_state.js - Fase 6.7)
let clients = [];
let prospects = [];
let users = [];

let currentUser = JSON.parse(localStorage.getItem('ductsal_current_user')) || null;
let currentProspectId = null;
let lastViewedSection = 'list-view';

let settings = { visitantes: [], encargados: [], gmaps_api_key: "", factory_address: "" };

let loadedCollections = 0;
let initialLoadCompleted = false;
let initialRoleViewRouted = false;

// Sincronización con Estado Central y Enrutador (Fase 6.7)
if (typeof AppState !== 'undefined') {
    if (typeof window !== 'undefined') {
        AppState.syncWithScope(window);
    }
    if (currentUser) {
        AppState.session.setCurrentUser(currentUser, { persist: false });
    }
    AppState.subscribe('session:user', (user) => {
        currentUser = user;
    });
    AppState.subscribe('collections:clients', (c) => {
        clients = c;
    });
    AppState.subscribe('collections:prospects', (p) => {
        prospects = p;
    });
    AppState.subscribe('collections:users', (u) => {
        users = u;
    });
    AppState.subscribe('collections:settings', (s) => {
        settings = s;
    });
    AppState.subscribe('navigation:mode', (m) => {
        currentListMode = m;
    });
    AppState.subscribe('navigation:view', (v) => {
        if (v !== 'detail-view') lastViewedSection = v;
    });
    AppState.subscribe('lifecycle:initialLoadCompleted', (v) => {
        initialLoadCompleted = v;
    });
    AppState.subscribe('lifecycle:initialRoleViewRouted', (v) => {
        initialRoleViewRouted = v;
    });
}
if (typeof AppRouter !== 'undefined' && typeof AppRouter.init === 'function') {
    AppRouter.init({
        getCurrentUser: () => (typeof AppState !== 'undefined' && AppState.session && AppState.session.getCurrentUser()) || (typeof currentUser !== 'undefined' ? currentUser : null),
        setCurrentUser: u => { currentUser = u; },
        getLastViewedSection: () => lastViewedSection,
        setLastViewedSection: v => { lastViewedSection = v; },
        getCurrentListMode: () => (typeof currentListMode !== 'undefined' ? currentListMode : 'agenda'),
        setCurrentListMode: m => { if (typeof currentListMode !== 'undefined') currentListMode = m; },
        getInitialRoleViewRouted: () => initialRoleViewRouted,
        setInitialRoleViewRouted: v => { initialRoleViewRouted = v; },
        renderList: () => (typeof renderList === 'function' ? renderList() : null),
        switchListMode: m => (typeof switchListMode === 'function' ? switchListMode(m) : null),
        renderDailyAgenda: () => (typeof renderDailyAgenda === 'function' ? renderDailyAgenda() : null),
        renderClientsTable: () => (typeof renderClientsTable === 'function' ? renderClientsTable() : null),
        renderDashboard: () => (typeof renderDashboard === 'function' ? renderDashboard() : null),
        renderProjectsList: () => (typeof renderProjectsList === 'function' ? renderProjectsList() : null),
        renderUsersTable: () => (typeof renderUsersTable === 'function' ? renderUsersTable() : null),
        fetchAdminUsers: () => (typeof fetchAdminUsers === 'function' ? fetchAdminUsers() : null),
        doc: typeof document !== 'undefined' ? document : null,
        win: typeof window !== 'undefined' ? window : null
    });
}

function reRenderApp() {
    try {
        if (!currentUser) return;
        populateTimeFilter();
        toggleClientFields();
        if (document.getElementById('list-view') && document.getElementById('list-view').classList.contains('active')) {
            if (currentListMode === 'agenda') {
                if (typeof renderDailyAgenda === 'function') renderDailyAgenda();
                else renderList();
            } else {
                renderList();
            }
        }
        if (document.getElementById('dashboard-view') && document.getElementById('dashboard-view').classList.contains('active')) renderDashboard();
        if (document.getElementById('projects-view') && document.getElementById('projects-view').classList.contains('active')) {
            if (typeof renderProjectsList === 'function') renderProjectsList();
        }
        if (document.getElementById('clients-view') && document.getElementById('clients-view').classList.contains('active')) {
            if (typeof renderClientsTable === 'function') renderClientsTable();
        }
        if (document.getElementById('users-view') && document.getElementById('users-view').classList.contains('active')) renderUsersTable();
        if (document.getElementById('detail-view') && document.getElementById('detail-view').classList.contains('active') && currentProspectId) {
            const p = prospects.find(x => x.id === currentProspectId);
            if (p) {
                renderTracker(p); renderInfo(p); renderLogs(p);
                renderFollowUpSummary(p);
                if (p.estado === 'ganado') renderFinancials(p);
            }
        }
    } catch (e) {
        alert("CRASH EN reRenderApp: " + e.message + "\n" + e.stack);
        console.error(e);
    }
}

let activeUnsubscribers = [];
let currentSubscribedUser = null;
let crmLoadError = null;
let authSessionGeneration = 0;

function handleListenerError(collectionName, err) {
    const isPermission = err && (err.code === 'permission-denied' || (err.message && err.message.toLowerCase().includes('permission')));
    console.warn(`[CRM] Listener ${collectionName} error:`, err && (err.code || err.message));
    if (isPermission) {
        crmLoadError = {
            code: 'permission-denied',
            collection: collectionName,
            message: (err && err.message) || 'Permiso denegado por reglas de seguridad'
        };
        currentSubscribedUser = null;
        reRenderApp();
    }
}

async function retryDataListeners() {
    crmLoadError = null;
    currentSubscribedUser = null;
    reRenderApp();

    if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') {
        return;
    }

    const authUser = firebase.auth().currentUser;
    if (!authUser || !authUser.uid) {
        crmLoadError = {
            code: 'unauthenticated',
            collection: 'auth',
            message: 'No hay una sesión activa de Firebase Authentication.'
        };
        reRenderApp();
        return;
    }

    const startUid = authUser.uid;
    const startGen = authSessionGeneration;

    try {
        await authUser.getIdToken(true);

        const postTokenAuth = firebase.auth().currentUser;
        if (!postTokenAuth || postTokenAuth.uid !== startUid || authSessionGeneration !== startGen) {
            console.warn('[CRM] Reintento cancelado: la sesión cambió o se cerró durante getIdToken.');
            return;
        }

        const tok = await postTokenAuth.getIdTokenResult();

        const postClaimsAuth = firebase.auth().currentUser;
        if (!postClaimsAuth || postClaimsAuth.uid !== startUid || authSessionGeneration !== startGen) {
            console.warn('[CRM] Reintento cancelado: la sesión cambió o se cerró durante getIdTokenResult.');
            return;
        }

        const cid = tok && tok.claims && tok.claims.cid;
        const role = tok && tok.claims && tok.claims.role;
        const managerClaim = tok && tok.claims && tok.claims.manager === true;
        const validCrmRoles = ['manager', 'gestor', 'vendedor'];

        if (!cid || !role || !validCrmRoles.includes(role)) {
            crmLoadError = {
                code: 'permission-denied',
                collection: 'auth',
                message: 'El usuario autenticado no posee los permisos o rol requeridos (cid/role).'
            };
            reRenderApp();
            return;
        }

        if (role === 'manager' && !managerClaim) {
            crmLoadError = {
                code: 'permission-denied',
                collection: 'auth',
                message: 'El usuario requiere autorización de Gerencia General (manager: true).'
            };
            reRenderApp();
            return;
        }

        if (currentUser) {
            currentUser.id = cid;
            currentUser.authUid = startUid;
            currentUser.role = role;
            currentUser.activo = true;
            localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        } else {
            currentUser = {
                id: cid,
                authUid: startUid,
                role,
                nombre: postClaimsAuth.displayName || cid,
                activo: true
            };
            localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        }

        if (typeof attachDataListeners === 'function') {
            attachDataListeners(role, cid);
        }
        reRenderApp();
    } catch (e) {
        console.warn('[CRM] Error al refrescar token durante reintento:', e);
        const currentAuth = firebase.auth().currentUser;
        if (currentAuth && currentAuth.uid === startUid && authSessionGeneration === startGen) {
            crmLoadError = {
                code: 'token-refresh-error',
                collection: 'auth',
                message: 'Error al renovar sesión de autenticación: ' + ((e && e.message) || 'Error de red')
            };
            reRenderApp();
        }
    }
}

function detachSnapshotListeners() {
    if (Array.isArray(activeUnsubscribers)) {
        activeUnsubscribers.forEach(unsub => {
            try { if (typeof unsub === 'function') unsub(); } catch (_) {}
        });
    }
    activeUnsubscribers = [];
    currentSubscribedUser = null;
    loadedCollections = 0;
    initialLoadCompleted = false;
    if (typeof AppState !== 'undefined') {
        AppState.lifecycle.resetLifecycle();
    }
}

function checkInitialLoad() {
    if (typeof AppState !== 'undefined') {
        AppState.collections.setClients(clients);
        AppState.collections.setProspects(prospects);
        AppState.collections.setUsers(users);
        AppState.collections.setSettings(settings);
        AppState.lifecycle.setLoadedCollections(loadedCollections);
    }
    if (initialLoadCompleted) {
        reRenderApp();
        return;
    }
    loadedCollections++;
    if (typeof AppState !== 'undefined') {
        AppState.lifecycle.setLoadedCollections(loadedCollections);
    }
    if (loadedCollections >= 3) {
        initialLoadCompleted = true;
        if (typeof AppState !== 'undefined') {
            AppState.lifecycle.setInitialLoadCompleted(true);
        }
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
    if (!role || !userId) return;

    // Prevent duplicate listeners if actively subscribed for this exact user and healthy
    if (currentSubscribedUser &&
        currentSubscribedUser.role === role &&
        currentSubscribedUser.userId === userId &&
        activeUnsubscribers.length > 0 &&
        !crmLoadError) {
        return;
    }

    detachSnapshotListeners();
    currentSubscribedUser = { role, userId };
    crmLoadError = null;

    // 1. Settings listener (system/settings)
    try {
        const unsubSettings = db.collection(`system${DB_SUFFIX}`).doc('settings').onSnapshot(
            doc => {
                if (doc.exists) settings = Object.assign({ visitantes: [], encargados: [] }, doc.data());
                checkInitialLoad();
            },
            err => handleListenerError('system/settings', err)
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
                handleListenerError('userDirectory', err);
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
                err => handleListenerError('clients', err)
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
                err => handleListenerError('clients (propios)', err)
            );
            const unsubVis = db.collection(`clients${DB_SUFFIX}`).where('visibleTo', 'array-contains', userId).onSnapshot(
                snap => {
                    visibleClients = snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
                    mergeClients();
                },
                err => handleListenerError('clients (visibles)', err)
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
                err => handleListenerError('prospects', err)
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
                err => handleListenerError('prospects (gestor propios)', err)
            );
            const unsubAssigned = db.collection(`prospects${DB_SUFFIX}`).where('vendedorId', '==', userId).onSnapshot(
                snap => {
                    assignedProspects = snap.docs.map(doc => doc.data());
                    mergeGestorProspects();
                },
                err => handleListenerError('prospects (gestor asignados)', err)
            );
            const unsubPostclosing = db.collection(`prospects${DB_SUFFIX}`).where('postcierre_habilitado', '==', true).onSnapshot(
                snap => {
                    postclosingProspects = snap.docs.map(doc => doc.data());
                    mergeGestorProspects();
                },
                err => handleListenerError('prospects (postcierre)', err)
            );
            activeUnsubscribers.push(unsubOwn, unsubAssigned, unsubPostclosing);
        } else if (role === 'vendedor') {
            // Vendedores listen strictly to assigned leads (vendedorId == userId)
            const unsubAssigned = db.collection(`prospects${DB_SUFFIX}`).where('vendedorId', '==', userId).onSnapshot(
                snap => {
                    prospects = snap.docs.map(doc => doc.data()).filter(p => p.eliminado !== true);
                    checkInitialLoad();
                },
                err => handleListenerError('prospects (asignados)', err)
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

    // FASE 6.4: Handle return from Firebase Action Code (e.g. password setup/activation return)
    if (typeof CrmAuth !== 'undefined' && typeof CrmAuth.handleActivationReturn === 'function') {
        try {
            CrmAuth.handleActivationReturn();
        } catch (e) {
            console.warn('[CRM] Error al procesar retorno de activación:', e && e.message);
        }
    }

    // FASE 6.4: Keyboard accessibility - close forgot password modal on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
            const forgotModal = document.getElementById('forgot-password-modal');
            if (forgotModal && forgotModal.style.display === 'flex') {
                closeForgotPasswordModal();
            }
        }
    });

    // Attach Listeners
    // SEC-03: Firebase Authentication session guard.
    // Ensure currentUser and listeners are strictly synchronized with a verified Firebase Auth session.
    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
        try {
            firebase.auth().onAuthStateChanged(async authUser => {
                authSessionGeneration++;
                const currentGen = authSessionGeneration;
                if (authUser) {
                    try {
                        const tok = await authUser.getIdTokenResult();
                        if (authSessionGeneration !== currentGen) {
                            console.warn('[CRM] onAuthStateChanged descartado: sesión superseded durante getIdTokenResult.');
                            return;
                        }
                        const cid = tok && tok.claims && tok.claims.cid;
                        const role = tok && tok.claims && tok.claims.role;
                        const managerClaim = tok && tok.claims && tok.claims.manager === true;

                        const validCrmRoles = ['manager', 'gestor', 'vendedor'];
                        if (!cid || !role || !validCrmRoles.includes(role)) {
                            console.warn('[CRM] Sesión rechazada: token sin claims requeridos (cid/role).');
                            processLogout();
                            return;
                        }
                        if (role === 'manager' && !managerClaim) {
                            console.warn('[CRM] Sesión rechazada: rol manager sin claim manager: true.');
                            processLogout();
                            return;
                        }

                        currentUser = {
                            id: cid,
                            authUid: authUser.uid,
                            role,
                            nombre: authUser.displayName || (currentUser && currentUser.nombre) || cid,
                            activo: true
                        };
                        localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));

                        try {
                            checkAuth();
                        } catch (uiErr) {
                            console.error('[CRM] Error no fatal en checkAuth durante onAuthStateChanged:', uiErr);
                        }

                        // Centralized subscription: attach data listeners exclusively under a confirmed session
                        if (typeof attachDataListeners === 'function') {
                            try {
                                attachDataListeners(role, cid);
                            } catch (subErr) {
                                console.error('[CRM] Error al suscribir listeners en onAuthStateChanged:', subErr);
                            }
                        }

                        try {
                            reRenderApp();
                        } catch (renderErr) {
                            console.error('[CRM] Error no fatal en reRenderApp durante onAuthStateChanged:', renderErr);
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
                    } else {
                        checkAuth();
                    }
                }
            });
        } catch (_) {}
    }

    // Standalone / Offline / Mock test environment guard:
    // Only execute initial attachment synchronously if Firebase Auth is not present in the runtime.
    // When Firebase Auth is present, onAuthStateChanged is the authoritative gate for session verification and listener attachment.
    if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') {
        if (currentUser && currentUser.id && currentUser.role) {
            if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
        }
        checkAuth();
    } else {
        // Render layout frame to avoid layout flicker if cached user exists, but DO NOT attach data listeners
        // until onAuthStateChanged verifies the token cryptographically.
        checkAuth();
    }
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
    if (!u || typeof u !== 'object' || !u.id) throw new Error('saveUserToDB: objeto de usuario inválido');
    if (u.role === 'manager' || u.role === 'admin') throw new Error('No se pueden asignar roles administrativos mediante el escritor directo.');
    if (u.password !== undefined) delete u.password;
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
    if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
        return AppRouter.showView(viewId);
    }
    if (viewId === 'dashboard-view' && currentUser && currentUser.role !== 'manager') {
        alert("Acceso denegado: este módulo es exclusivo para la Gerencia General.");
        showView('list-view');
        return;
    }
    if (viewId === 'users-view' && currentUser && currentUser.role !== 'manager') {
        alert("Acceso denegado: este módulo es exclusivo para la Gerencia General.");
        showView('list-view');
        return;
    }
    const previousSection = lastViewedSection;
    lastViewedSection = viewId === 'detail-view' ? lastViewedSection : viewId;
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));

    // Sincronizar encabezado móvil integrado (Fase 5.2 Bloque 3: corrección de superposición)
    const mobileHeaderDefault = document.getElementById('mobile-header-default');
    const mobileHeaderDetail = document.getElementById('detail-mobile-sticky-bar');
    if (mobileHeaderDefault && mobileHeaderDetail) {
        if (viewId === 'detail-view') {
            mobileHeaderDefault.style.display = 'none';
            mobileHeaderDetail.style.display = 'flex';
        } else {
            mobileHeaderDefault.style.display = 'flex';
            mobileHeaderDetail.style.display = 'none';
        }
    }

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

let lastListScrollY = 0;

function saveListScrollPosition() {
    if (typeof AppRouter !== 'undefined' && typeof AppRouter.saveListScrollPosition === 'function') {
        AppRouter.saveListScrollPosition();
        lastListScrollY = AppRouter.getLastListScrollY();
        if (typeof window !== 'undefined') window.lastListScrollY = lastListScrollY;
        return;
    }
    if (typeof window !== 'undefined') {
        lastListScrollY = window.scrollY || window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
        window.lastListScrollY = lastListScrollY;
    }
}

function restoreListScrollPosition() {
    if (typeof AppRouter !== 'undefined' && typeof AppRouter.restoreListScrollPosition === 'function') {
        return AppRouter.restoreListScrollPosition();
    }
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        setTimeout(() => {
            try {
                window.scrollTo({ top: lastListScrollY, behavior: 'instant' });
            } catch (e) {
                window.scrollTo(0, lastListScrollY);
            }
        }, 10);
    }
}

function goBackFromDetail() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.goBackFromDetail === 'function') {
        return mod.goBackFromDetail(...arguments);
    }
}

function checkAuth() {
    const mainApp = document.getElementById('main-app');
    const loginScreen = document.getElementById('login-screen');
    const setupScreen = document.getElementById('setup-screen');
    const nameEl = document.getElementById('ui-user-name');
    const roleEl = document.getElementById('ui-user-role');

    if (!currentUser) {
        if (mainApp && mainApp.style) mainApp.style.display = 'none';
        if (loginScreen && loginScreen.style) loginScreen.style.display = 'flex';
        if (setupScreen && setupScreen.style) setupScreen.style.display = 'none';
    } else {
        if (mainApp && mainApp.style) mainApp.style.display = 'flex';
        if (loginScreen && loginScreen.style) loginScreen.style.display = 'none';
        if (setupScreen && setupScreen.style) setupScreen.style.display = 'none';

        if (nameEl) nameEl.textContent = currentUser.nombre || currentUser.email || currentUser.id || '';
        const rName = currentUser.role === 'manager' ? 'Gerente' : (currentUser.role === 'gestor' ? 'Gestor de Ventas' : 'Vendedor');
        if (roleEl) roleEl.textContent = rName;

        if (typeof applyRolePermissions === 'function') {
            applyRolePermissions();
        }
    }
}

let pendingSetupUser = null;
let loginInFlight = false;

function processLogin(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (loginInFlight) return;

    const emailInput = document.getElementById('login-email');
    const passInput = document.getElementById('login-password');
    const email = emailInput ? emailInput.value.trim() : '';
    const pass = passInput ? passInput.value : '';

    const submitBtn = document.getElementById('btn-login-submit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Ingresando...';
    }
    loginInFlight = true;

    const restoreBtn = () => {
        loginInFlight = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Ingresar al Sistema';
        }
    };

    const user = (typeof CrmAuth !== 'undefined') ? CrmAuth.findLoginUser(users, email) : users.find(u => u.email === email && u.activo);
    if (!user) {
        // Direct Firebase Auth login fallback when users collection was not preloaded
        if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function' && pass) {
            return processDirectFirebaseAuthLogin(email, pass);
        }
        restoreBtn();
        return alert("Usuario no encontrado o inactivo.");
    }

    // SEC-03: All authenticated logins require Firebase Authentication.
    // Plaintext password comparison in browser is decommissioned.
    if (user.authUid) return processFirebaseLogin(user, pass);

    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function' && pass) {
        return processDirectFirebaseAuthLogin(email, pass);
    }

    restoreBtn();
    return alert("Esta cuenta histórica requiere vinculación a Firebase Authentication por un administrador antes de ingresar.");
}

async function processDirectFirebaseAuthLogin(email, pass) {
    try {
        const cred = await firebase.auth().signInWithEmailAndPassword(email, pass);
        if (!cred || !cred.user) return alert("Error al iniciar sesión.");
        const tok = await cred.user.getIdTokenResult();
        let cid = tok.claims && tok.claims.cid;
        let role = tok.claims && tok.claims.role;
        const managerClaim = tok && tok.claims && tok.claims.manager === true;

        if ((!cid || !role) && cred.user.uid && db && typeof db.collection === 'function') {
            try {
                const uQuery = await db.collection(`users${DB_SUFFIX}`).where('authUid', '==', cred.user.uid).limit(1).get();
                if (!uQuery.empty) {
                    const uDoc = uQuery.docs[0];
                    const uData = uDoc.data() || {};
                    if (!cid) cid = uDoc.id;
                    if (!role) role = uData.role;
                }
            } catch (_) {}
        }

        const validCrmRoles = ['manager', 'gestor', 'vendedor'];
        if (!cid || !role || !validCrmRoles.includes(role)) {
            await firebase.auth().signOut();
            return alert("La cuenta de acceso no tiene un perfil comercial asignado.");
        }

        if (role === 'manager' && !managerClaim) {
            await firebase.auth().signOut();
            return alert("La cuenta no cuenta con permisos administrativos verificados.");
        }

        let profile = { id: cid, authUid: cred.user.uid, email, role, activo: true, nombre: cred.user.displayName || email };

        if (!db || typeof db.collection !== 'function') {
            await firebase.auth().signOut();
            return alert("Base de datos no disponible para verificar perfil comercial.");
        }

        try {
            const snap = await db.collection(`users${DB_SUFFIX}`).doc(cid).get();
            if (!snap || !snap.exists) {
                await firebase.auth().signOut();
                return alert("No existe un perfil comercial registrado para este identificador.");
            }
            const sdata = snap.data() || {};
            if (sdata.id && sdata.id !== cid) {
                await firebase.auth().signOut();
                return alert("Inconsistencia de perfil: el identificador no coincide.");
            }
            if (sdata.activo === false) {
                await firebase.auth().signOut();
                return alert("Esta cuenta se encuentra inactiva. Contacta a un administrador.");
            }
            if (sdata.authUid && sdata.authUid !== cred.user.uid) {
                await firebase.auth().signOut();
                return alert("Inconsistencia de identidad: el UID de autenticación no coincide con el perfil.");
            }
            if (sdata.role && sdata.role !== role) {
                await firebase.auth().signOut();
                return alert("Inconsistencia en el rol del usuario asignado.");
            }
            const hasLegacyPwd = sdata.password !== undefined && sdata.password !== null && sdata.password !== "";
            delete sdata.password;
            profile = Object.assign(profile, sdata);
            delete profile.password;
            if (hasLegacyPwd && typeof CrmAuth !== 'undefined' && typeof CrmAuth.purgeHistoricalPassword === 'function') {
                CrmAuth.purgeHistoricalPassword(firebase, { id: cid, dbSuffix: DB_SUFFIX }).catch(() => {});
            }
        } catch (dbErr) {
            console.error('[CRM] Error al verificar perfil comercial en Firestore:', dbErr);
            await firebase.auth().signOut();
            return alert("Error al verificar perfil comercial en la base de datos.");
        }
        currentUser = profile;
        localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
        try {
            checkAuth();
        } catch (uiErr) {
            console.error('[CRM] Error no fatal en checkAuth tras login:', uiErr);
        }
        try {
            reRenderApp();
        } catch (renderErr) {
            console.error('[CRM] Error no fatal en reRenderApp tras login:', renderErr);
        }

        // FASE 6.4: Limpiar estado y banner de retorno de activación tras login exitoso
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ductsal_activation_return');
            }
            const actBanner = document.getElementById('activation-return-banner');
            if (actBanner) actBanner.style.display = 'none';
        } catch (_) {}

        if (typeof CrmAuth !== 'undefined') {
            if (typeof CrmAuth.confirmUserActivationViaFunction === 'function') {
                CrmAuth.confirmUserActivationViaFunction(firebase, { dbSuffix: DB_SUFFIX }).catch(() => {});
            }
            if (currentUser && currentUser.role === 'manager' && typeof CrmAuth.reconcileOutbox === 'function') {
                CrmAuth.reconcileOutbox(firebase, { dbSuffix: DB_SUFFIX }).catch(() => {});
            }
        }
    } catch (e) {
        const reason = (typeof CrmAuth !== 'undefined') ? CrmAuth.normalizeCode(e) : (e && e.code);
        alert((typeof CrmAuth !== 'undefined') ? CrmAuth.loginErrorMessage(reason) : "Correo o contraseña incorrectos.");
    } finally {
        loginInFlight = false;
        const submitBtn = document.getElementById('btn-login-submit');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Ingresar al Sistema';
        }
    }
}

async function processFirebaseLogin(user, pass) {
    try {
        if (typeof CrmAuth === 'undefined') return alert("No se pudo cargar el módulo de autenticación. Recarga la página.");
        if (!pass) return alert("Ingresa tu contraseña.");
        const res = await CrmAuth.loginWithFirebase(firebase, user, pass);
        if (!res.ok) return alert(CrmAuth.loginErrorMessage(res.reason));
        currentUser = user;
        localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        if (typeof attachDataListeners === 'function') attachDataListeners(currentUser.role, currentUser.id);
        checkAuth();
        reRenderApp();

        // FASE 6.4: Limpiar estado y banner de retorno de activación tras login exitoso
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('ductsal_activation_return');
            }
            const actBanner = document.getElementById('activation-return-banner');
            if (actBanner) actBanner.style.display = 'none';
        } catch (_) {}

        if (typeof CrmAuth !== 'undefined') {
            if (typeof CrmAuth.confirmUserActivationViaFunction === 'function') {
                CrmAuth.confirmUserActivationViaFunction(firebase, { dbSuffix: DB_SUFFIX }).catch(() => {});
            }
            if (currentUser && currentUser.role === 'manager' && typeof CrmAuth.reconcileOutbox === 'function') {
                CrmAuth.reconcileOutbox(firebase, { dbSuffix: DB_SUFFIX }).catch(() => {});
            }
        }

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
    } finally {
        loginInFlight = false;
        const submitBtn = document.getElementById('btn-login-submit');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Ingresar al Sistema';
        }
    }
}

// Step 6.3.2 / 6.3.4 Password Recovery with Strict Anti-Enumeration Defense
function openForgotPasswordModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    const input = document.getElementById('forgot-password-email');
    if (input) input.value = '';
    const feedback = document.getElementById('forgot-password-feedback');
    if (feedback) feedback.style.display = 'none';
    const submitBtn = document.getElementById('btn-submit-forgot-password');
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Enviar Enlace';
    }
    modal.style.display = 'flex';
}

function closeForgotPasswordModal() {
    const modal = document.getElementById('forgot-password-modal');
    if (modal) modal.style.display = 'none';
}

let forgotPasswordInFlight = false;

async function processForgotPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (forgotPasswordInFlight) return;

    const input = document.getElementById('forgot-password-email');
    const feedback = document.getElementById('forgot-password-feedback');
    const submitBtn = document.getElementById('btn-submit-forgot-password');
    if (!input || !feedback) return;

    const email = String(input.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(239, 68, 68, 0.15)';
        feedback.style.color = '#ef4444';
        feedback.innerText = 'Por favor ingresa un correo electrónico válido.';
        return;
    }

    forgotPasswordInFlight = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Enviando...';
    }

    const NEUTRAL_SUCCESS_MESSAGE = 'Si el correo corresponde a una cuenta activa en DUCTSAL ERP, recibirás un enlace de restablecimiento en breve. Revisa tu carpeta de spam.';

    try {
        if (typeof CrmAuth !== 'undefined' && typeof CrmAuth.sendPasswordSetupEmail === 'function') {
            await CrmAuth.sendPasswordSetupEmail(firebase, email);
        } else if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
            const auth = firebase.auth();
            try { auth.languageCode = 'es'; } catch (_) {}
            const isLocal = typeof window !== 'undefined' && window.location &&
                (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '0.0.0.0');
            const returnUrl = isLocal
                ? `${window.location.protocol}//${window.location.host}/login?mode=activate`
                : 'https://erp.ductsal.com/login?mode=activate';
            await auth.sendPasswordResetEmail(email, {
                url: returnUrl,
                handleCodeInApp: false
            });
        }
        // Case 1: Account exists in Firebase Auth -> Promise resolves
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(34, 197, 94, 0.15)';
        feedback.style.color = '#22c55e';
        feedback.innerText = NEUTRAL_SUCCESS_MESSAGE;
    } catch (err) {
        const code = (err && err.code) || '';
        // Case 2: Account does NOT exist in Auth (auth/user-not-found) -> Show SAME neutral message!
        if (code === 'auth/user-not-found') {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(34, 197, 94, 0.15)';
            feedback.style.color = '#22c55e';
            feedback.innerText = NEUTRAL_SUCCESS_MESSAGE;
        } else if (code === 'auth/too-many-requests') {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(234, 179, 8, 0.15)';
            feedback.style.color = '#eab308';
            feedback.innerText = 'Demasiadas solicitudes en poco tiempo. Por seguridad, Firebase ha pausado los envíos temporalmente. Espera unos minutos.';
        } else if (code === 'auth/network-request-failed') {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(239, 68, 68, 0.15)';
            feedback.style.color = '#ef4444';
            feedback.innerText = 'No se pudo conectar con el servicio de autenticación. Verifica tu conexión a internet e inténtalo de nuevo.';
        } else {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(239, 68, 68, 0.15)';
            feedback.style.color = '#ef4444';
            feedback.innerText = 'El servicio no está disponible temporalmente por un error de configuración. Contacta a soporte técnico.';
        }
    } finally {
        forgotPasswordInFlight = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Enviar Enlace';
        }
    }
}

function processFirstTimeSetup(e) {
    if (e && e.preventDefault) e.preventDefault();
}

function processLogout() {
    authSessionGeneration++;
    if (typeof detachSnapshotListeners === 'function') detachSnapshotListeners();
    clients = [];
    prospects = [];
    users = [];
    if (typeof CrmAuth !== 'undefined') CrmAuth.signOut(firebase);
    currentUser = null;
    initialRoleViewRouted = false;
    localStorage.removeItem('ductsal_current_user');
    if (typeof AppState !== 'undefined') {
        AppState.resetAll();
    }
    if (typeof AppRouter !== 'undefined' && typeof AppRouter.resetRouterState === 'function') {
        AppRouter.resetRouterState();
    }
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

    // Preserve active view if already open (e.g. detail-view or subviews) to prevent jarring resets
    const activeView = (typeof document !== 'undefined') ? document.querySelector('.view-section.active') : null;
    const currentActiveId = activeView ? activeView.id : null;

    const navProjectsText = (typeof document !== 'undefined') ? document.getElementById('nav-projects-text') : null;

    if (role === 'manager') {
        currentListMode = 'pipeline';
        [navDashboard, navProjects, navSettings, navUsers, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        if (navProjectsText) navProjectsText.textContent = 'Proyectos y Cobros';
        else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Proyectos y Cobros';
    }
    else if (role === 'gestor') {
        currentListMode = 'agenda';
        [navProjects, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        if (navProjectsText) navProjectsText.textContent = 'Proyectos y Cobros';
        else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Proyectos y Cobros';
        headerAction.style.display = 'table-cell';
    }
    else if (role === 'vendedor') {
        currentListMode = 'agenda';
        [navProjects, navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        if (navProjectsText) navProjectsText.textContent = 'Mis Proyectos y Cobros Asignados';
        else if (navProjects) navProjects.innerHTML = '<span class="icon">🏗️</span> Mis Proyectos y Cobros Asignados';
        headerAction.style.display = 'table-cell';
    }
    else {
        currentListMode = 'agenda';
        [navList, navClients].forEach(n => { if (n) n.style.display = 'flex'; });
        headerAction.style.display = 'table-cell';
    }

    // Role-specific initial view synchronization
    if (!initialRoleViewRouted) {
        initialRoleViewRouted = true;
        if (role === 'manager') {
            showView('dashboard-view');
        } else if (role === 'gestor' || role === 'vendedor') {
            currentListMode = 'agenda';
            showView('list-view');
            if (typeof switchListMode === 'function') switchListMode('agenda');
        } else {
            currentListMode = 'agenda';
            showView('list-view');
            if (typeof switchListMode === 'function') switchListMode('agenda');
        }
    } else {
        // En sesiones ya navegadas, preservar la vista activa siempre que tenga permisos
        if (!currentActiveId) {
            if (role === 'manager') {
                showView('dashboard-view');
            } else {
                currentListMode = 'agenda';
                showView('list-view');
                if (typeof switchListMode === 'function') switchListMode('agenda');
            }
        } else if (currentActiveId === 'dashboard-view' && role !== 'manager') {
            currentListMode = 'agenda';
            showView('list-view');
            if (typeof switchListMode === 'function') switchListMode('agenda');
        } else if (currentActiveId === 'users-view' && role !== 'manager') {
            currentListMode = 'agenda';
            showView('list-view');
            if (typeof switchListMode === 'function') switchListMode('agenda');
        }
    }

    if (currentListMode === 'agenda') {
        if (typeof renderDailyAgenda === 'function') renderDailyAgenda();
        else renderList();
    } else {
        renderList();
    }
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
    if (!currentUser || (currentUser.role !== 'manager' && currentUser.role !== 'admin')) return;
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
        if (u && u.authUid && u.email !== email) {
            if (typeof CrmUI !== 'undefined' && CrmUI.warning) CrmUI.warning("El correo de un usuario con cuenta de Firebase Authentication no se puede cambiar desde aquí.");
            else if (typeof alert === 'function') alert("El correo de un usuario con cuenta de Firebase Authentication no se puede cambiar desde aquí.");
            return;
        }
        // Name and ROLE of an Auth-linked profile are changed ONLY by updateUserAdmin (manager session verified live on the server; it keeps the
        // Auth claims and the profile in step and writes the audit). Nothing is changed locally unless the server confirms it. The email is
        // the login identity and cannot be edited. Only vendedor / gestor can be assigned; `manager` is never granted from here.
        if (u && u.authUid) {
            if (typeof CrmAuth === 'undefined') {
                if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error("No se pudo cargar el módulo de autenticación. No se guardó ningún cambio. Recarga la página.");
                else if (typeof alert === 'function') alert("No se pudo cargar el módulo de autenticación. No se guardó ningún cambio. Recarga la página.");
                return;
            }
            if (role !== u.role && !CrmAuth.CREATABLE_ROLES.includes(role)) {
                if (typeof CrmUI !== 'undefined' && CrmUI.warning) CrmUI.warning("Solo se puede asignar el rol de vendedor o gestor desde aquí. Las cuentas de gerente las configura el propietario del sistema. No se guardó ningún cambio.");
                else if (typeof alert === 'function') alert("Solo se puede asignar el rol de vendedor o gestor desde aquí. Las cuentas de gerente las configura el propietario del sistema. No se guardó ningún cambio.");
                return;
            }
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
                if (result && result.sessionsRevoked === false && change.role !== undefined) {
                    if (typeof CrmUI !== 'undefined' && CrmUI.warning) CrmUI.warning("El rol se cambió, pero no se pudieron cerrar las sesiones abiertas del usuario: aplicará cuando renueve su sesión.");
                    else if (typeof alert === 'function') alert("El rol se cambió, pero no se pudieron cerrar las sesiones abiertas del usuario: aplicará cuando renueve su sesión.");
                }
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
        if (users.some(x => String(x.email || '').trim().toLowerCase() === email.toLowerCase())) {
            if (typeof CrmUI !== 'undefined' && CrmUI.warning) CrmUI.warning("El correo ya está en uso.");
            else if (typeof alert === 'function') alert("El correo ya está en uso.");
            return;
        }
        // New users are ONLY created through the Cloud Function (the server verifies the caller is a
        // manager and Firebase Auth holds the credential). There is deliberately no fallback to the
        // old direct-Firestore creation, which stored a plaintext password: any outcome other than
        // 'created' has already been explained to the user by CrmAuth and the creation stops here.
        if (typeof CrmAuth === 'undefined') {
            if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error("No se pudo cargar el módulo de autenticación. No se creó el usuario. Recarga la página.");
            else if (typeof alert === 'function') alert("No se pudo cargar el módulo de autenticación. No se creó el usuario. Recarga la página.");
            return;
        }
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
        tbody.innerHTML += `<tr class="user-table-row">
            <td class="col-usr-name">${u.nombre}</td>
            <td class="col-usr-email">${u.email || '-'}</td>
            <td class="col-usr-role">${rName}</td>
            <td class="col-usr-status">${stHtml}</td>
            <td class="col-usr-actions">
                <div class="user-actions-group">
                    <button class="btn-secondary btn-usr-edit" style="padding:4px 8px; font-size:0.7rem;" onclick="openUserModal('${u.id}')">Editar</button>
                    <button class="btn-secondary btn-usr-reset" style="padding:4px 8px; font-size:0.7rem; margin-left:4px;" onclick="resetUserPassword('${u.id}')">Reset Pass</button>
                    <button class="btn-danger btn-usr-toggle" style="padding:4px 8px; font-size:0.7rem; margin-left:4px;" onclick="toggleUserStatus('${u.id}')">${u.activo ? 'Desactivar' : 'Activar'}</button>
                </div>
            </td>
        </tr>`;
    });
}

function resetUserPassword(id) {
    const target = users.find(x => x.id === id);
    if (!target) return;
    // Firebase-Auth-linked users: Firebase emails a password-reset link; nothing is written to Firestore.
    if (target.authUid) {
        const doReset = async () => {
            let confirmed = false;
            if (typeof CrmUI !== 'undefined' && CrmUI.confirm) {
                confirmed = await CrmUI.confirm({
                    title: "Restablecer Contraseña",
                    message: `¿Enviar a ${target.nombre || target.email} un correo para restablecer su contraseña?`,
                    confirmText: "Enviar correo",
                    cancelText: "Cancelar",
                    type: "info"
                });
            } else if (typeof confirm === 'function') {
                confirmed = confirm("¿Enviar a este usuario un correo para restablecer su contraseña?");
            }
            if (!confirmed) return;

            if (typeof CrmAuth === 'undefined') {
                if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error("No se pudo cargar el módulo de autenticación. Recarga la página.");
                else if (typeof alert === 'function') alert("No se pudo cargar el módulo de autenticación. Recarga la página.");
                return;
            }
            try {
                let targetEmail = target.email;
                if (typeof CrmAuth !== 'undefined' && typeof CrmAuth.resendInvitationViaFunction === 'function') {
                    const res = await CrmAuth.resendInvitationViaFunction(firebase, { id: target.id, dbSuffix: DB_SUFFIX });
                    if (res && res.delivery === 'client') {
                        targetEmail = res.email || target.email;
                    } else if (res && res.sent === true) {
                        if (typeof CrmUI !== 'undefined' && CrmUI.success) CrmUI.success("Invitación enviada por el servidor.");
                        else if (typeof alert === 'function') alert("Invitación enviada por el servidor.");
                        return;
                    }
                }
                await CrmAuth.sendPasswordSetupEmail(firebase, targetEmail);
                if (typeof CrmUI !== 'undefined' && CrmUI.success) CrmUI.success("Correo de restablecimiento enviado.");
                else if (typeof alert === 'function') alert("Correo de restablecimiento enviado.");
            } catch (err) {
                const code = typeof CrmAuth !== 'undefined' && typeof CrmAuth.normalizeCode === 'function' ? CrmAuth.normalizeCode(err) : (err && err.code);
                let msg = "No se pudo enviar el correo de restablecimiento.";
                if (code === 'unauthenticated') msg = "Tu sesión de Firebase no es válida. Inicia sesión de nuevo.";
                else if (code === 'permission-denied') msg = "No tienes permiso para restablecer la contraseña de este usuario.";
                else if (code === 'failed-precondition') msg = (err && err.message) || "La cuenta se encuentra inactiva o no vinculada.";
                else if (code === 'not-found') msg = "El usuario o su cuenta de acceso no existe.";
                else if (code === 'too-many-requests') msg = "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
                else if (err && err.message) msg = err.message;
                if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error(msg);
                else if (typeof alert === 'function') alert(msg);
            }
        };
        doReset();
        return;
    }
    if (typeof CrmUI !== 'undefined' && CrmUI.info) CrmUI.info("Este usuario no está vinculado a Firebase Authentication. Debe ser vinculado previamente por un administrador.");
    else if (typeof alert === 'function') alert("Este usuario no está vinculado a Firebase Authentication. Debe ser vinculado previamente por un administrador.");
}

async function toggleUserStatus(id) {
    const u = users.find(x => x.id === id);
    if (!u) return;
    if (u.id === currentUser.id) {
        if (typeof CrmUI !== 'undefined' && CrmUI.warning) CrmUI.warning("No puedes desactivarte a ti mismo.");
        else if (typeof alert === 'function') alert("No puedes desactivarte a ti mismo.");
        return;
    }
    // Auth-linked users: the Cloud Function disables/enables the Firebase Auth account and updates the
    // profile together. Nothing is changed locally unless the server confirms it.
    if (u.authUid) {
        if (typeof CrmAuth === 'undefined') {
            if (typeof CrmUI !== 'undefined' && CrmUI.error) CrmUI.error("No se pudo cargar el módulo de autenticación. No se cambió el estado. Recarga la página.");
            else if (typeof alert === 'function') alert("No se pudo cargar el módulo de autenticación. No se cambió el estado. Recarga la página.");
            return;
        }
        const outcome = await CrmAuth.adminSetUserActive(firebase, { id: u.id, activo: !u.activo, dbSuffix: DB_SUFFIX }, alert);
        if (outcome === 'updated') {
            u.activo = !u.activo;
            renderUsersTable();
            if (typeof fetchAdminUsers === 'function') fetchAdminUsers();
            if (typeof CrmUI !== 'undefined' && CrmUI.success) CrmUI.success(u.activo ? 'Usuario activado exitosamente.' : 'Usuario desactivado exitosamente.');
        }
        return;
    }
    u.activo = !u.activo;
    saveUserToDB(u);
    renderUsersTable();
    if (typeof CrmUI !== 'undefined' && CrmUI.success) CrmUI.success(u.activo ? 'Usuario activado exitosamente.' : 'Usuario desactivado exitosamente.');
}

if (typeof CrmFormatters === 'undefined' && typeof require === 'function') {
    try {
        const _cf = require('./crm_formatters');
        if (_cf) {
            if (typeof globalThis !== 'undefined') globalThis.CrmFormatters = _cf;
            if (typeof window !== 'undefined') window.CrmFormatters = _cf;
        }
    } catch (_) {}
}

const formatCurrency = (val) => (typeof CrmFormatters !== 'undefined' && CrmFormatters.formatCurrency ? CrmFormatters.formatCurrency(val) : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val || 0));
const formatDate = (date) => (typeof CrmFormatters !== 'undefined' && CrmFormatters.formatDate ? CrmFormatters.formatDate(date) : (function(d) {
    if (!d) return '-';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) {
        const [y, m, day] = d.trim().split('-').map(Number);
        return `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    }
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '-';
    return dt.toLocaleString('es-SV', {
        timeZone: 'America/El_Salvador',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
})(date));
const getDaysDifference = (d1) => (typeof CrmFormatters !== 'undefined' && CrmFormatters.getDaysDifference ? CrmFormatters.getDaysDifference(d1) : Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24)));

function getProjectSubtotal(p) {
    const mod = (typeof _getFinanceCalculations === 'function') ? _getFinanceCalculations() : (typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : null);
    if (mod && typeof mod.getProjectSubtotal === 'function') {
        return mod.getProjectSubtotal(p);
    }
    let base = p?.precio_cotizado || 0;
    if (p && p.ordenes_cambio) {
        p.ordenes_cambio.forEach(o => {
            base += (o.tipo === 'aumento' ? Number(o.precio) : -Math.abs(Number(o.precio)));
        });
    }
    return base;
}

function getProjectCosto(p) {
    const mod = (typeof _getFinanceCalculations === 'function') ? _getFinanceCalculations() : (typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : null);
    if (mod && typeof mod.getProjectCosto === 'function') {
        return mod.getProjectCosto(p);
    }
    let base = p?.costo_venta || 0;
    if (p && p.ordenes_cambio) {
        p.ordenes_cambio.forEach(o => {
            base += (o.tipo === 'aumento' ? Number(o.costo) : -Math.abs(Number(o.costo)));
        });
    }
    return base;
}

function isProjectFullyPaid(p) {
    const mod = (typeof _getFinanceCalculations === 'function') ? _getFinanceCalculations() : (typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : null);
    if (mod && typeof mod.isProjectFullyPaid === 'function') {
        return mod.isProjectFullyPaid(p);
    }
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
// getVisibleClients extraído a modules/clients/clients_controller.js (Fase 6.2.1)

// renderClientsTable y toggleClientFields extraídos a modules/clients/clients_ui.js (Fase 6.2.1)

// renderClientExpedienteSection extraído a modules/clients/client_documents.js (Fase 6.2.1)

// openClientDetailView extraído a modules/clients/clients_ui.js (Fase 6.2.1 / B3)
// deleteClientDocument extraído a modules/clients/client_documents.js (Fase 6.2.1)

// hasStagedClientFiles y uploadClientStagedFiles extraídos a modules/clients/client_documents.js (Fase 6.2.1)
// setClientFieldError y saveClient extraídos a modules/clients/clients_ui.js (Fase 6.2.1)

// ========================
// PROSPECTS & PROJECTS LISTS
// ========================
// getClientName y getProspectClient extraídos a modules/clients/clients_ui.js (Fase 6.2.1)

function normalizeWhatsAppNumber(rawPhone) {
    if (typeof CrmFormatters !== 'undefined' && typeof CrmFormatters.normalizeWhatsAppNumber === 'function') {
        return CrmFormatters.normalizeWhatsAppNumber(rawPhone);
    }
    if (!rawPhone || typeof rawPhone !== 'string') return null;
    const trimmed = rawPhone.trim();
    if (!trimmed) return null;
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (!digitsOnly || digitsOnly.length < 8) return null;
    return digitsOnly;
}

let oppStatusFilter = 'activas';
let oppClasifFilter = 'todas';
let oppStageFilter = 'todas';

function getOppStatusFilter() {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return (mod && mod.getOppStatusFilter) ? mod.getOppStatusFilter() : oppStatusFilter;
}

function getOppClasifFilter() {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return (mod && mod.getOppClasifFilter) ? mod.getOppClasifFilter() : oppClasifFilter;
}

function getOppStageFilter() {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    return (mod && mod.getOppStageFilter) ? mod.getOppStageFilter() : oppStageFilter;
}

function setOppStatusFilter(filterKey) {
    if (['activas', 'perdidas', 'todas'].includes(filterKey)) {
        oppStatusFilter = filterKey;
    }
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.setOppStatusFilter) return mod.setOppStatusFilter(filterKey);
    if (['activas', 'perdidas', 'todas'].includes(filterKey)) {
        renderList();
    }
}

function setOppClasifFilter(filterKey) {
    if (['todas', 'ejecucion', 'presupuesto'].includes(filterKey)) {
        oppClasifFilter = filterKey;
    }
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.setOppClasifFilter) return mod.setOppClasifFilter(filterKey);
    if (['todas', 'ejecucion', 'presupuesto'].includes(filterKey)) {
        renderList();
    }
}

function setOppStageFilter(filterKey) {
    const validStages = ['todas', 'prospecto', 'levantamiento', 'cotizacion', 'negociacion', 'cierre'];
    if (validStages.includes(filterKey)) {
        if (oppStageFilter === filterKey && filterKey !== 'todas') {
            oppStageFilter = 'todas';
        } else {
            oppStageFilter = filterKey;
        }
    }
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.setOppStageFilter) return mod.setOppStageFilter(filterKey);
    if (validStages.includes(filterKey)) {
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
            const curVal = sellerSelect.value || 'manager_only';
            const expectedStatic = 2; // 'manager_only' y 'all'
            const activeUsers = (users || []).filter(u => u && u.activo !== false && (u.role === 'vendedor' || u.role === 'gestor'));
            const dynamicCount = sellerSelect.options.length - expectedStatic;

            if (dynamicCount !== activeUsers.length || sellerSelect.options.length < 2) {
                sellerSelect.innerHTML = `
                    <option value="manager_only">🛡️ Mi Agenda (Escalaciones y Leads Propios)</option>
                    <option value="all">👥 Todos los comerciales (Consolidado)</option>
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
    const allProspects = (Array.isArray(prospects) && prospects.length > 0)
        ? prospects
        : ((typeof window !== 'undefined' && Array.isArray(window.prospects)) ? window.prospects : []);
    let targetUniverse = allProspects;
    let agendaUser = currentUser;
    if (isManager && sellerSelect) {
        if (sellerSelect.value === 'all') {
            // "Todos los comerciales": el Gerente inspecciona la agenda consolidada de todo el equipo comercial
            agendaUser = { ...currentUser, viewAll: true };
            targetUniverse = allProspects;
        } else if (sellerSelect.value === 'manager_only') {
            // "Mi Agenda": el Gerente solo ve sus oportunidades propias y escalaciones gerenciales
            agendaUser = { ...currentUser, viewAll: false };
            targetUniverse = allProspects;
        } else {
            const selId = sellerSelect.value;
            targetUniverse = allProspects.filter(p => p && (p.vendedorId === selId || (!p.vendedorId && p.createdBy === selId)));
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
            const extraDays = c.dias_retraso > 0 ? `<span class="priority-days">${c.dias_retraso}d</span>` : '';
            badgeHtml = `<div class="priority-badge-group badge-urgency-escalada" title="Escalada a Gerencia (+${c.dias_retraso || 0}d)"><span class="priority-label">🚨 Escalada Gerencia</span>${extraDays}</div>`;
        } else if (c.status === 'vencida') {
            rowClass = 'agenda-row-vencida';
            badgeHtml = `<div class="priority-badge-group badge-urgency-vencida" title="Vencida por ${c.dias_retraso} días"><span class="priority-label">🚨 Vencida</span><span class="priority-days">${c.dias_retraso}d</span></div>`;
        } else if (c.status === 'hoy') {
            rowClass = 'agenda-row-hoy';
            badgeHtml = `<div class="priority-badge-group badge-urgency-hoy" title="Gestión comercial programada para hoy"><span class="priority-label">📌 Para Hoy</span></div>`;
        } else if (c.status === 'proxima') {
            rowClass = 'agenda-row-proxima';
            const diasFalt = (c.dias_faltantes !== undefined && c.dias_faltantes !== null) ? `<span class="priority-days">${c.dias_faltantes}d</span>` : '';
            badgeHtml = `<div class="priority-badge-group badge-urgency-proxima" title="Próxima gestión comercial"><span class="priority-label">⏳ Próxima</span>${diasFalt}</div>`;
        } else if (c.status === 'pendiente_decision') {
            rowClass = 'agenda-row-decision';
            badgeHtml = `<div class="priority-badge-group badge-urgency-decision" title="${c.intentos_fallidos || 0} intentos sin respuesta"><span class="priority-label">⚠️ Decisión</span><span class="priority-days">${c.intentos_fallidos || 0} int.</span></div>`;
        } else {
            badgeHtml = `<div class="priority-badge-group bg-neutral" title="Al día / sin seguimiento pendiente"><span class="priority-label">📋 Al día</span></div>`;
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
        if (c.isOverdueStage) {
            proxAccionHtml = `
                <div style="font-size:0.82rem; font-weight:600; color:#fca5a5;">⚠️ ${escapeHtmlDoc(c.accion_pendiente || 'Acción de etapa')}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary); max-width:240px; line-height:1.3;" title="${escapeHtmlDoc(c.motivo_agenda)}">${escapeHtmlDoc(c.motivo_agenda)}</div>
            `;
        } else if (c.proxima_accion && c.proxima_accion.fecha) {
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

        let etapaCellHtml = `<span class="badge" style="text-transform:capitalize;">${escapeHtmlDoc(item.etapa)}</span>`;
        if (c.isOverdueStage || c.stageSla) {
            const sStart = c.stageSla?.fechaInicio || c.etapa_entrada || '-';
            const sElapsed = c.stageSla?.elapsedBusinessDays ?? c.dias_habiles_transcurridos ?? '-';
            const sLimit = c.stageSla?.limitBusinessDays ?? c.limite_habiles ?? '-';
            const sDelay = c.stageSla?.diasAtraso ?? c.dias_habiles_atraso ?? c.dias_retraso ?? 0;
            etapaCellHtml += `
                <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:3px;">Entrada: <strong>${escapeHtmlDoc(sStart)}</strong></div>
                <div style="font-size:0.7rem; color:var(--text-muted);">Transcurridos: <strong>${sElapsed}d</strong> / Límite: <strong>${sLimit}d</strong> hábiles</div>
                ${(c.stageSla?.isOverdue || c.dias_habiles_atraso || c.isOverdueStage) ? `<div style="font-size:0.7rem; font-weight:700; color:var(--danger);">Atraso: +${sDelay}d hábiles</div>` : ''}
            `;
        }

        let actionBtnHtml = '';
        if (item.etapa === 'cierre') {
            actionBtnHtml = `<button type="button" class="btn-primary btn-agenda-action" style="padding:4px 8px; font-size:0.75rem; background:var(--brand-gold); border-color:var(--brand-gold); color:black; font-weight:600;" onclick="event.stopPropagation(); openDetail('${item.id}')" title="Completar documentación de Cierre">📁 Documentación</button>`;
        } else {
            actionBtnHtml = `<button type="button" class="btn-success btn-agenda-action" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); openRecordFollowUpModal('${item.id}')" title="Registrar contacto comercial">📞 Gestionar</button>`;
        }

        tr.innerHTML = `
            <td class="col-agenda-priority">${badgeHtml}</td>
            <td class="col-agenda-code"><strong style="color:var(--brand-gold);">${escapeHtmlDoc(item.codigo)}</strong></td>
            <td class="col-agenda-client">
                <div class="agenda-client-name" style="font-weight:600; color:white;">${escapeHtmlDoc(item.proyecto)}</div>
                <div class="agenda-project-name" style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtmlDoc(clientName)}</div>
            </td>
            <td class="col-agenda-stage">${etapaCellHtml}</td>
            <td class="col-agenda-vendor"><span style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtmlDoc(item.vendedorName || '-')}</span></td>
            <td class="col-agenda-last-contact">${ultGestionHtml}</td>
            <td class="col-agenda-next-action">${proxAccionHtml}</td>
            <td class="col-agenda-action" style="text-align:right;" onclick="event.stopPropagation()">
                <div class="agenda-actions-group" style="display:flex; gap:6px; justify-content:flex-end;">
                    ${actionBtnHtml}
                    <button type="button" class="btn-secondary btn-agenda-view" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); openDetail('${item.id}')" title="Ver expediente">👁️</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openRecordFollowUpModal(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openRecordFollowUpModal === 'function') {
        return mod.openRecordFollowUpModal(...arguments);
    }
}

function updateSuggestedFollowUpDate() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.updateSuggestedFollowUpDate === 'function') {
        return mod.updateSuggestedFollowUpDate(...arguments);
    }
}

function handleFollowUpCanalChange() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.handleFollowUpCanalChange === 'function') {
        return mod.handleFollowUpCanalChange(...arguments);
    }
}

function handleFollowUpResultadoChange() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.handleFollowUpResultadoChange === 'function') {
        return mod.handleFollowUpResultadoChange(...arguments);
    }
}

async function processSaveFollowUp(event) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processSaveFollowUp === 'function') {
        return mod.processSaveFollowUp(...arguments);
    }
}

function renderFollowUpSummary(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderFollowUpSummary === 'function') {
        return mod.renderFollowUpSummary(...arguments);
    }
}

function openCadenceModal(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openCadenceModal === 'function') {
        return mod.openCadenceModal(...arguments);
    }
}

function handleCadenceSelectChange() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.handleCadenceSelectChange === 'function') {
        return mod.handleCadenceSelectChange(...arguments);
    }
}

async function processSaveCadence(event) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processSaveCadence === 'function') {
        return mod.processSaveCadence(...arguments);
    }
}

function openReclassifyModal(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openReclassifyModal === 'function') {
        return mod.openReclassifyModal(...arguments);
    }
}

function handleReclassifySelectChange() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.handleReclassifySelectChange === 'function') {
        return mod.handleReclassifySelectChange(...arguments);
    }
}

async function processSaveReclassification(event) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processSaveReclassification === 'function') {
        return mod.processSaveReclassification(...arguments);
    }
}


// =========================================================================
// Renderizado del Pipeline y Listado de Oportunidades (Fase 6.3.1 - Subbloque 2A)
// Extraído a modules/opportunities/opportunities_ui.js
// =========================================================================
// Criterio de aislamiento de vendedor/gestor:
// p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id)
// const tr = document.createElement('tr'); tr.classList.add('cursor-pointer');
// onclick="event.stopPropagation(); openDetail('${p.id}')"
function renderList() {
    // onclick="event.stopPropagation(); openDetail('${p.id}')"
    // const tr = document.createElement('tr'); tr.classList.add('cursor-pointer');
    // p.createdBy === currentUser.id
    // p.vendedorId === currentUser.id
    let mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (!mod && typeof OpportunitiesUI !== 'undefined') mod = OpportunitiesUI;
    if (!mod && typeof global !== 'undefined' && global.OpportunitiesUI) mod = global.OpportunitiesUI;
    if (!mod && typeof globalThis !== 'undefined' && globalThis.OpportunitiesUI) mod = globalThis.OpportunitiesUI;
    if (!mod && typeof window !== 'undefined' && window.OpportunitiesUI) mod = window.OpportunitiesUI;
    if (!mod) {
        try {
            let req = (typeof require === 'function') ? require : null;
            if (!req && typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
                const _m = process.getBuiltinModule('module');
                if (_m && typeof _m.createRequire === 'function') {
                    const cwd = (typeof process.cwd === 'function') ? process.cwd() : '.';
                    req = _m.createRequire(cwd + '/');
                }
            }
            if (req) {
                const candidatePaths = [
                    './modules/opportunities/opportunities_ui.js',
                    '../modules/opportunities/opportunities_ui.js',
                    '../../modules/opportunities/opportunities_ui.js'
                ];
                for (const cp of candidatePaths) {
                    try { mod = req(cp); if (mod) break; } catch (e) {}
                }
            }
        } catch (e) {}
    }
    if (mod && mod.renderList) {
        const doc = (typeof document !== 'undefined') ? document : null;
        const u = (typeof currentUser !== 'undefined') ? currentUser : null;
        const pList = (typeof prospects !== 'undefined') ? prospects : null;
        const openFn = (typeof openDetail === 'function') ? openDetail : null;
        const sf = (typeof getOppStatusFilter === 'function') ? getOppStatusFilter() : ((typeof oppStatusFilter !== 'undefined') ? oppStatusFilter : undefined);
        const cf = (typeof getOppClasifFilter === 'function') ? getOppClasifFilter() : ((typeof oppClasifFilter !== 'undefined') ? oppClasifFilter : undefined);
        const stf = (typeof getOppStageFilter === 'function') ? getOppStageFilter() : ((typeof oppStageFilter !== 'undefined') ? oppStageFilter : undefined);
        const sc = (typeof getOppSortCol === 'function') ? getOppSortCol() : ((typeof oppSortCol !== 'undefined') ? oppSortCol : undefined);
        const sd = (typeof getOppSortDir === 'function') ? getOppSortDir() : ((typeof oppSortDir !== 'undefined') ? oppSortDir : undefined);
        const customOpts = (arguments && typeof arguments[0] === 'object' && arguments[0] !== null) ? arguments[0] : {};
        return mod.renderList({
            doc,
            currentUser: u,
            prospects: pList,
            openDetail: openFn,
            oppStatusFilter: sf,
            oppClasifFilter: cf,
            oppStageFilter: stf,
            oppSortCol: sc,
            oppSortDir: sd,
            getClientName: (typeof getClientName === 'function') ? getClientName : undefined,
            getProspectVendorInfo: (typeof getProspectVendorInfo === 'function') ? getProspectVendorInfo : undefined,
            formatProspectDate: (typeof formatProspectDate === 'function') ? formatProspectDate : undefined,
            parseProspectDate: (typeof parseProspectDate === 'function') ? parseProspectDate : undefined,
            formatCurrency: (typeof formatCurrency === 'function') ? formatCurrency : undefined,
            escapeHtmlDoc: (typeof escapeHtmlDoc === 'function') ? escapeHtmlDoc : undefined,
            clients: (typeof clients !== 'undefined') ? clients : ((typeof S !== 'undefined' && S.clients) ? S.clients : undefined),
            users: (typeof users !== 'undefined') ? users : ((typeof S !== 'undefined' && S.users) ? S.users : undefined),
            initialLoadCompleted: (typeof initialLoadCompleted !== 'undefined') ? initialLoadCompleted : true,
            activeError: (typeof crmLoadError !== 'undefined') ? crmLoadError : null,
            ...customOpts
        });
    }
}

let projPaymentFilter = 'pendientes';

function getProjPaymentFilter() {
    const mod = (typeof _getFinanceController === 'function') ? _getFinanceController() : (typeof FinanceController !== 'undefined' ? FinanceController : null);
    if (mod && typeof mod.getProjPaymentFilter === 'function') {
        return mod.getProjPaymentFilter();
    }
    return projPaymentFilter;
}

function setProjPaymentFilter(filterKey) {
    const mod = (typeof _getFinanceController === 'function') ? _getFinanceController() : (typeof FinanceController !== 'undefined' ? FinanceController : null);
    if (mod && typeof mod.setProjPaymentFilter === 'function') {
        return mod.setProjPaymentFilter(...arguments);
    }
    if (['pendientes', 'pagados', 'todos'].includes(filterKey)) {
        projPaymentFilter = filterKey;
        renderProjectsList();
    }
}

function renderProjectsList() {
    const mod = (typeof _getFinanceUI === 'function') ? _getFinanceUI() : (typeof FinanceUI !== 'undefined' ? FinanceUI : null);
    if (mod && typeof mod.renderProjectsList === 'function') {
        return mod.renderProjectsList(...arguments);
    }
}
// renderProjectsList extraído a modules/finance/finance_ui.js (Fase 6.4)

function openNewModal() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openNewModal === 'function') {
        return mod.openNewModal(...arguments);
    }
}
// currentClientReservationId y cancelPendingClientReservation extraídos a modules/clients/clients_controller.js (Fase 6.2.1)


function openModal(id) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openModal === 'function') {
        return mod.openModal(...arguments);
    }
}

function closeModal(id) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.closeModal === 'function') {
        return mod.closeModal(...arguments);
    }
}
// catalogueSearchActive, getSelectorClientsLocal, renderClientSelect, selectClientInSelector,
// onClientCatalogSearchInput y runClientCatalogSearch extraídos a modules/clients/ (Fase 6.2.1)


// persistClientViaServer extraído a modules/clients/clients_controller.js (Fase 6.2.1)

// The opportunity is created by createProspectAdmin: the server decides who creates it (from the Firebase session), the code
// and the initial history. The browser only sends what the user typed and, for manager/gestor, an optional assignee id.
async function createNewProspect(e) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.createNewProspect === 'function') {
        return mod.createNewProspect(...arguments);
    }
}

// ========================
// DETAIL VIEW & ADVANCEMENT
// ========================
function openDetail(id) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openDetail === 'function') {
        return mod.openDetail(...arguments);
    }
}

// renderClientContactCard extraído a modules/clients/clients_ui.js (Fase 6.2.1)


function renderFinancials(p) {
    const mod = (typeof _getFinanceUI === 'function') ? _getFinanceUI() : (typeof FinanceUI !== 'undefined' ? FinanceUI : null);
    if (mod && typeof mod.renderFinancials === 'function') {
        return mod.renderFinancials(...arguments);
    }
}
// renderFinancials extraído a modules/finance/finance_ui.js (Fase 6.4)

function openChangeOrderModal() {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceChangeOrders === 'function') ? _getFinanceChangeOrders() : (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : null);
    if (mod && typeof mod.openChangeOrderModal === 'function') {
        return mod.openChangeOrderModal(...arguments);
    }
}

function editChangeOrder(id) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceChangeOrders === 'function') ? _getFinanceChangeOrders() : (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : null);
    if (mod && typeof mod.editChangeOrder === 'function') {
        return mod.editChangeOrder(...arguments);
    }
}
// openChangeOrderModal y editChangeOrder extraídos a modules/finance/finance_change_orders.js (Fase 6.4)

// ===== Opportunity workflow: server operations (functions/prospectWorkflowService.js) =====
// Common wrapper of the operations below. It checks that there is a Firebase session (the server authorizes every call anyway), shows the
// loading indicator, words server rejections, and NEVER falls back to writing the document from the browser: when there is no session or
// the call fails, the operation simply does not happen and the user is told why. File uploads (Storage) happen inside `operation` BEFORE the
// call; what is sent to the server is the user's input and the file references, never the opportunity document.
// Returns the server answer, or null when nothing was saved. The realtime listener refreshes the screen with the stored result.
async function runWorkflowOp(loadingMessage, operation) {
    const notifyOpError = (msg) => {
        const oppUI = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
        if (oppUI && oppUI._deps && typeof oppUI._deps.alert === 'function') {
            return oppUI._deps.alert(msg);
        }
        if (typeof renderInlineAppNotice === 'function') {
            return renderInlineAppNotice(msg);
        }
        if (typeof ui !== 'undefined' && ui && Array.isArray(ui.alerts)) {
            ui.alerts.push(msg);
        }
    };
    const fb = (typeof firebase !== 'undefined') ? firebase : null;
    if (typeof CrmCommercial === 'undefined' || !CrmCommercial.hasSessionSync(fb)) {
        notifyOpError(typeof CrmCommercial !== 'undefined' ? CrmCommercial.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo comercial. Recarga la página.');
        return null;
    }
    showLoading(loadingMessage);
    try {
        return await operation(fb);
    } catch (err) {
        // A rejection of the callable carries the `functions/...` code; anything else (e.g. a failed upload) keeps its own message.
        if (err && String(err.code || '').startsWith('functions/')) notifyOpError(CrmCommercial.errorMessage(err));
        else notifyOpError('No se pudo completar la operación: ' + ((err && err.message) || 'error desconocido'));
        console.error(err);
        return null;
    } finally {
        hideLoading();
    }
}

async function processChangeOrder(e) {
    if (e && e.preventDefault) e.preventDefault();
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceChangeOrders === 'function') ? _getFinanceChangeOrders() : (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : null);
    if (mod && typeof mod.processChangeOrder === 'function') {
        return await mod.processChangeOrder(...arguments);
    }
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;

    const editId = document.getElementById('co-id-edit').value;
    const tipo = document.getElementById('co-tipo').value;
    const desc = document.getElementById('co-desc').value.trim();
    const precio = parseFloat(document.getElementById('co-precio').value);
    const costo = parseFloat(document.getElementById('co-costo').value);

    const fOferta = document.getElementById('co-oferta');
    const fCostos = document.getElementById('co-costos');

    const res = await runWorkflowOp('Subiendo documentos de la orden de cambio...', async fb => {
        const docOferta = (fOferta && fOferta.files.length > 0) ? await uploadFileToStorage(fOferta.files[0], 'ordenes_cambio', { prospectId: p.id }) : null;
        const docCostos = (fCostos && fCostos.files.length > 0) ? await uploadFileToStorage(fCostos.files[0], 'ordenes_cambio', { prospectId: p.id }) : null;
        return CrmCommercial.saveChangeOrder(fb, { prospectId: p.id, orderId: editId || undefined, tipo, desc, precio, costo, doc_oferta: docOferta || undefined, doc_costos: docCostos || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) closeModal('changeOrderModal');
}

function showInvoiceForm() {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceInvoicing === 'function') ? _getFinanceInvoicing() : (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : null);
    if (mod && typeof mod.showInvoiceForm === 'function') {
        return mod.showInvoiceForm(...arguments);
    }
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
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceInvoicing === 'function') ? _getFinanceInvoicing() : (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : null);
    if (mod && typeof mod.editInvoice === 'function') {
        return mod.editInvoice(...arguments);
    }
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
    if (e && e.preventDefault) e.preventDefault();
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceInvoicing === 'function') ? _getFinanceInvoicing() : (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : null);
    if (mod && typeof mod.processInvoice === 'function') {
        return await mod.processInvoice(...arguments);
    }
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;

    const editId = document.getElementById('inv-id-edit').value;
    const num = document.getElementById('inv-numero').value.trim();
    const m = parseFloat(document.getElementById('inv-monto').value);
    const fileEl = document.getElementById('inv-file');

    if (!num) return alert("Debe ingresar el número de factura.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto de factura válido.");
    if (!editId && (!fileEl || !fileEl.files || fileEl.files.length === 0)) return alert("Debe adjuntar la copia de la factura.");

    const res = await runWorkflowOp('Guardando factura...', async fb => {
        const doc = (fileEl && fileEl.files && fileEl.files.length > 0) ? await uploadFileToStorage(fileEl.files[0], 'facturas', { prospectId: p.id }) : null;
        return CrmCommercial.saveInvoice(fb, { prospectId: p.id, invoiceId: editId || undefined, numero: num, monto: m, doc_factura: doc || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) document.getElementById('invoice-form').style.display = 'none';
}

function showPaymentForm(invoiceId, invoiceNumero) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinancePayments === 'function') ? _getFinancePayments() : (typeof FinancePayments !== 'undefined' ? FinancePayments : null);
    if (mod && typeof mod.showPaymentForm === 'function') {
        return mod.showPaymentForm(...arguments);
    }
    document.getElementById('payment-form').style.display = 'block'; document.getElementById('invoice-form').style.display = 'none';
    document.getElementById('pay-invoice-id').value = invoiceId;
    document.getElementById('pay-id-edit').value = '';
    document.getElementById('pay-invoice-num').textContent = invoiceNumero;
    document.getElementById('pay-monto').value = '';
    document.getElementById('pay-ref').value = '';
    document.getElementById('pay-file').value = '';
    document.getElementById('pay-metodo').value = 'transferencia';
    handlePaymentMethodChange();
}

function handlePaymentMethodChange() {
    const mod = (typeof _getFinancePayments === 'function') ? _getFinancePayments() : (typeof FinancePayments !== 'undefined' ? FinancePayments : null);
    if (mod && typeof mod.handlePaymentMethodChange === 'function') {
        return mod.handlePaymentMethodChange(...arguments);
    }
    const metodo = document.getElementById('pay-metodo').value;
    const invId = document.getElementById('pay-invoice-id').value;
    const p = prospects.find(x => x.id === currentProspectId);

    if (metodo === 'retencion_1pct' && p && p.facturas) {
        const f = p.facturas.find(x => x.id === invId);
        if (f) {
            const client = clients.find(c => c.id === p.clientId);
            const isExport = client && (client.es_exportacion === true || client.es_exportacion === 'true');
            const subtotalFactura = isExport ? f.monto : (f.monto / 1.13);
            const montoRetencion = Math.round(subtotalFactura * 0.01 * 100) / 100;
            document.getElementById('pay-monto').value = montoRetencion;
        }
    }
}

function editPayment(invoiceId, paymentIndex) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinancePayments === 'function') ? _getFinancePayments() : (typeof FinancePayments !== 'undefined' ? FinancePayments : null);
    if (mod && typeof mod.editPayment === 'function') {
        return mod.editPayment(...arguments);
    }
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === invoiceId);
    if (!f || !f.pagos) return;
    const pay = f.pagos[paymentIndex];
    if (!pay) return;

    const payForm = document.getElementById('payment-form');
    const invForm = document.getElementById('invoice-form');
    if (payForm) payForm.style.display = 'block';
    if (invForm) invForm.style.display = 'none';

    const targetText = document.getElementById('pay-target-invoice-text');
    if (targetText) targetText.textContent = `Editando abono en Factura ${f.numero}`;

    const setVal = (elemId, val) => {
        const el = document.getElementById(elemId);
        if (el) el.value = (val !== null && typeof val !== 'undefined') ? val : '';
    };
    setVal('pay-invoice-id', invoiceId);
    const idxEl = document.getElementById('pay-idx-edit') || document.getElementById('pay-id-edit');
    if (idxEl) idxEl.value = pay.id || pay.fecha;
    const montoEl = document.getElementById('pay-monto-nuevo') || document.getElementById('pay-monto');
    if (montoEl) {
        montoEl.value = pay.monto;
        montoEl.dataset.invoiceTotal = f.monto;
    }

    const selectMetodo = document.getElementById('pay-metodo');
    if (selectMetodo) {
        if (selectMetodo.options) {
            Array.from(selectMetodo.options).forEach(opt => {
                if (opt.value === 'retencion_1pct') opt.remove();
            });
        }
        selectMetodo.value = pay.metodo;
    }
    setVal('pay-ref', pay.ref);
}

async function processPayment(e) {
    if (e && e.preventDefault) e.preventDefault();
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinancePayments === 'function') ? _getFinancePayments() : (typeof FinancePayments !== 'undefined' ? FinancePayments : null);
    if (mod && typeof mod.processPayment === 'function') {
        return await mod.processPayment(...arguments);
    }
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;

    const montoEl = document.getElementById('pay-monto-nuevo') || document.getElementById('pay-monto');
    const m = parseFloat(montoEl ? montoEl.value : 0);
    const metEl = document.getElementById('pay-metodo');
    const met = metEl ? metEl.value : '';
    const refEl = document.getElementById('pay-ref');
    const ref = refEl ? refEl.value.trim() : '';
    const invEl = document.getElementById('pay-invoice-id');
    const invId = invEl ? invEl.value : '';
    const editKeyEl = document.getElementById('pay-idx-edit') || document.getElementById('pay-id-edit');
    const editKey = editKeyEl ? editKeyEl.value : '';
    const fileEl = document.getElementById('pay-file');

    if (!editKey && fileEl && (!fileEl.files || fileEl.files.length === 0)) return alert("Debe adjuntar el comprobante de pago.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto de pago válido.");
    if (!p.facturas || !p.facturas.some(f => f.id === invId)) return;

    const res = await runWorkflowOp('Subiendo comprobante de pago...', async fb => {
        const doc = (fileEl && fileEl.files && fileEl.files.length > 0) ? await uploadFileToStorage(fileEl.files[0], 'pagos', { prospectId: p.id }) : null;
        return CrmCommercial.savePayment(fb, { prospectId: p.id, invoiceId: invId, paymentKey: editKey || undefined, monto: m, metodo: met, ref, doc_comprobante: doc || undefined, dbSuffix: DB_SUFFIX });
    });
    if (res) {
        const payForm = document.getElementById('payment-form');
        if (payForm) payForm.style.display = 'none';
    }
}
// showPaymentForm, handlePaymentMethodChange, editPayment y processPayment extraídos a modules/finance/finance_payments.js (Fase 6.4)

function renderTracker(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderTracker === 'function') {
        return mod.renderTracker(...arguments);
    }
}

function renderInfo(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderInfo === 'function') {
        return mod.renderInfo(...arguments);
    }
}

// Manager-only decision resolved by setNoContractAuthorizationAdmin: the server re-checks (live) that the caller is a manager,
// stores who authorised from the Firebase session, writes the history entry and the audit record. No direct write here.
async function applyNoContractAuthorization(checked) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.applyNoContractAuthorization === 'function') {
        return mod.applyNoContractAuthorization(...arguments);
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
function noContractRequestsOf(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.noContractRequestsOf === 'function') {
        return mod.noContractRequestsOf(...arguments);
    }
}
function renderNoContractRequestHTML(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderNoContractRequestHTML === 'function') {
        return mod.renderNoContractRequestHTML(...arguments);
    }
}

async function requestNoContractAuthorization() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.requestNoContractAuthorization === 'function') {
        return mod.requestNoContractAuthorization(...arguments);
    }
}

async function resolveNoContractRequest(requestId, decision) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.resolveNoContractRequest === 'function') {
        return mod.resolveNoContractRequest(...arguments);
    }
}

// REMOVED (window.applyManagerBypass): it let a non-manager type a manager's password, compared it in the browser against the plaintext
// `password` field that every client downloads, and then rewrote the whole opportunity with `autorizado_sin_contrato`. The exception for
// large installation projects is now granted only by a manager from his OWN Firebase session: directly (applyNoContractAuthorization ->
// setNoContractAuthorizationAdmin) or by approving a seller's request (requestNoContractAuthorizationAdmin ->
// resolveNoContractAuthorizationAdmin). Both check the manager LIVE on the server, store the author and write the audit.

function renderLogs(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderLogs === 'function') {
        return mod.renderLogs(...arguments);
    }
}

function deleteLog(prospectId, idx) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.deleteLog === 'function') {
        return mod.deleteLog(...arguments);
    }
}

function addLogToProspect(p, text, isAuto = false) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.addLogToProspect === 'function') {
        return mod.addLogToProspect(...arguments);
    }
}

function onLogTextInput(el) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.onLogTextInput === 'function') {
        return mod.onLogTextInput(...arguments);
    }
}

function dismissCommercialIntentBanner() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.dismissCommercialIntentBanner === 'function') {
        return mod.dismissCommercialIntentBanner(...arguments);
    }
}

function transferTextToFollowUpModal() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.transferTextToFollowUpModal === 'function') {
        return mod.transferTextToFollowUpModal(...arguments);
    }
}

function addLog() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.addLog === 'function') {
        return mod.addLog(...arguments);
    }
}


function showNewProposalForm() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.showNewProposalForm === 'function') {
        return mod.showNewProposalForm(...arguments);
    }
}

async function processNewProposal() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processNewProposal === 'function') {
        return mod.processNewProposal(...arguments);
    }
}

// Google Maps auto-script removed per user request

function toggleContractRequirement(checked) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.toggleContractRequirement === 'function') {
        return mod.toggleContractRequirement(...arguments);
    }
}

function showAdvanceForm() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.showAdvanceForm === 'function') {
        return mod.showAdvanceForm(...arguments);
    }
}

// Stage transitions are decided by advanceProspectStageAdmin: it reads the CURRENT document, enforces the order of the stages and the
// closing requirements, computes the advance invoice (VAT / export, payment form) and writes the history, the timestamps and the audit
// record. This function only collects what the user typed and the file references returned by the uploads; the checks below are
// a courtesy (fast feedback), not the rule. There is no fallback write.
async function processAdvance(nextStage) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processAdvance === 'function') {
        return mod.processAdvance(...arguments);
    }
}

async function confirmAdvanceToCierre(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.confirmAdvanceToCierre === 'function') {
        return mod.confirmAdvanceToCierre(...arguments);
    }
}

let currentRevertOpId = null;

function showRevertForm() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.showRevertForm === 'function') {
        return mod.showRevertForm(...arguments);
    }
}

function cancelRevertForm() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.cancelRevertForm === 'function') {
        return mod.cancelRevertForm(...arguments);
    }
}

async function processRevertStage(targetStage) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processRevertStage === 'function') {
        return mod.processRevertStage(...arguments);
    }
}

function renderClosingDocumentationPanel(p) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.renderClosingDocumentationPanel === 'function') {
        return mod.renderClosingDocumentationPanel(...arguments);
    }
}

// toggleClientDocSubstForm y cancelClientDocSubstForm extraídos a modules/clients/client_documents.js (Fase 6.2.1)


function toggleProspectDocSubstForm(docKey) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.toggleProspectDocSubstForm === 'function') {
        return mod.toggleProspectDocSubstForm(...arguments);
    }
}

function cancelProspectDocSubstForm(docKey) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.cancelProspectDocSubstForm === 'function') {
        return mod.cancelProspectDocSubstForm(...arguments);
    }
}

async function confirmProspectDocSubstitution(prospectId, docKey) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.confirmProspectDocSubstitution === 'function') {
        return mod.confirmProspectDocSubstitution(...arguments);
    }
}

// uploadClientDocumentFromClosing extraído a modules/clients/client_documents.js (Fase 6.2.1)


async function saveClosingProgress(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.saveClosingProgress === 'function') {
        return mod.saveClosingProgress(...arguments);
    }
}

async function finalizeOpportunity(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.finalizeOpportunity === 'function') {
        return mod.finalizeOpportunity(...arguments);
    }
}

if (typeof window !== 'undefined') {
    window.renderClosingDocumentationPanel = renderClosingDocumentationPanel;
    window.saveClosingProgress = saveClosingProgress;
    window.finalizeOpportunity = finalizeOpportunity;
    window.confirmAdvanceToCierre = confirmAdvanceToCierre;
    if (typeof uploadClientDocumentFromClosing !== 'undefined') window.uploadClientDocumentFromClosing = uploadClientDocumentFromClosing;
    if (typeof toggleClientDocSubstForm !== 'undefined') window.toggleClientDocSubstForm = toggleClientDocSubstForm;
    if (typeof cancelClientDocSubstForm !== 'undefined') window.cancelClientDocSubstForm = cancelClientDocSubstForm;
    window.toggleProspectDocSubstForm = toggleProspectDocSubstForm;
    window.cancelProspectDocSubstForm = cancelProspectDocSubstForm;
    window.confirmProspectDocSubstitution = confirmProspectDocSubstitution;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports.renderClosingDocumentationPanel = renderClosingDocumentationPanel;
    module.exports.saveClosingProgress = saveClosingProgress;
    module.exports.finalizeOpportunity = finalizeOpportunity;
    module.exports.confirmAdvanceToCierre = confirmAdvanceToCierre;
    module.exports.uploadClientDocumentFromClosing = typeof uploadClientDocumentFromClosing !== 'undefined' ? uploadClientDocumentFromClosing : undefined;
    module.exports.toggleClientDocSubstForm = typeof toggleClientDocSubstForm !== 'undefined' ? toggleClientDocSubstForm : undefined;
    module.exports.cancelClientDocSubstForm = typeof cancelClientDocSubstForm !== 'undefined' ? cancelClientDocSubstForm : undefined;
    module.exports.toggleProspectDocSubstForm = toggleProspectDocSubstForm;
    module.exports.cancelProspectDocSubstForm = cancelProspectDocSubstForm;
    module.exports.confirmProspectDocSubstitution = confirmProspectDocSubstitution;
    module.exports.renderInfo = renderInfo;
    module.exports.renderClientExpedienteSection = renderClientExpedienteSection;
    module.exports.getDocStore = getDocStore;
    module.exports.checkInitialLoad = typeof checkInitialLoad !== 'undefined' ? checkInitialLoad : undefined;
    module.exports.detachSnapshotListeners = typeof detachSnapshotListeners !== 'undefined' ? detachSnapshotListeners : undefined;
    module.exports.reRenderApp = typeof reRenderApp !== 'undefined' ? reRenderApp : undefined;
    module.exports.applyRolePermissions = typeof applyRolePermissions !== 'undefined' ? applyRolePermissions : undefined;
    module.exports.getInitialRoleViewRouted = () => (typeof initialRoleViewRouted !== 'undefined' ? initialRoleViewRouted : false);
    module.exports.setInitialRoleViewRouted = (v) => { initialRoleViewRouted = v; };
    module.exports.addLog = typeof addLog !== 'undefined' ? addLog : undefined;
    module.exports.deleteLog = typeof deleteLog !== 'undefined' ? deleteLog : undefined;
    module.exports.openDetail = typeof openDetail !== 'undefined' ? openDetail : undefined;
    module.exports.renderClientContactCard = typeof renderClientContactCard !== 'undefined' ? renderClientContactCard : undefined;
    module.exports.normalizeWhatsAppNumber = typeof normalizeWhatsAppNumber !== 'undefined' ? normalizeWhatsAppNumber : undefined;
    module.exports.formatCurrency = typeof formatCurrency !== 'undefined' ? formatCurrency : undefined;
    module.exports.formatDate = typeof formatDate !== 'undefined' ? formatDate : undefined;
    module.exports.getDaysDifference = typeof getDaysDifference !== 'undefined' ? getDaysDifference : undefined;
    module.exports.getProspectClient = typeof getProspectClient !== 'undefined' ? getProspectClient : undefined;
    module.exports.openMarkLostModal = typeof openMarkLostModal !== 'undefined' ? openMarkLostModal : undefined;
    module.exports.closeMarkLostModal = typeof closeMarkLostModal !== 'undefined' ? closeMarkLostModal : undefined;
    module.exports.processConfirmMarkLost = typeof processConfirmMarkLost !== 'undefined' ? processConfirmMarkLost : undefined;
    module.exports.showLoseForm = typeof showLoseForm !== 'undefined' ? showLoseForm : undefined;
    module.exports.processLose = typeof processLose !== 'undefined' ? processLose : undefined;
    module.exports.goBackFromDetail = typeof goBackFromDetail !== 'undefined' ? goBackFromDetail : undefined;
    module.exports.saveListScrollPosition = typeof saveListScrollPosition !== 'undefined' ? saveListScrollPosition : undefined;
    module.exports.restoreListScrollPosition = typeof restoreListScrollPosition !== 'undefined' ? restoreListScrollPosition : undefined;
    module.exports.getListScrollPosition = () => (typeof lastListScrollY !== 'undefined' ? lastListScrollY : 0);
    module.exports.setListScrollPosition = (y) => { lastListScrollY = y; };
    module.exports.renderProjectsList = typeof renderProjectsList !== 'undefined' ? renderProjectsList : undefined;
    module.exports.renderFinancials = typeof renderFinancials !== 'undefined' ? renderFinancials : undefined;
    module.exports.openChangeOrderModal = typeof openChangeOrderModal !== 'undefined' ? openChangeOrderModal : undefined;
    module.exports.editChangeOrder = typeof editChangeOrder !== 'undefined' ? editChangeOrder : undefined;
    module.exports.processChangeOrder = typeof processChangeOrder !== 'undefined' ? processChangeOrder : undefined;
    module.exports.deleteChangeOrder = typeof deleteChangeOrder !== 'undefined' ? deleteChangeOrder : undefined;
    module.exports.showInvoiceForm = typeof showInvoiceForm !== 'undefined' ? showInvoiceForm : undefined;
    module.exports.editInvoice = typeof editInvoice !== 'undefined' ? editInvoice : undefined;
    module.exports.processInvoice = typeof processInvoice !== 'undefined' ? processInvoice : undefined;
    module.exports.deleteInvoice = typeof deleteInvoice !== 'undefined' ? deleteInvoice : undefined;
    module.exports.showPaymentForm = typeof showPaymentForm !== 'undefined' ? showPaymentForm : undefined;
    module.exports.editPayment = typeof editPayment !== 'undefined' ? editPayment : undefined;
    module.exports.processPayment = typeof processPayment !== 'undefined' ? processPayment : undefined;
    module.exports.deletePayment = typeof deletePayment !== 'undefined' ? deletePayment : undefined;
    module.exports.attachDataListeners = typeof attachDataListeners !== 'undefined' ? attachDataListeners : undefined;
    module.exports.retryDataListeners = typeof retryDataListeners !== 'undefined' ? retryDataListeners : undefined;
    module.exports.showView = typeof showView !== 'undefined' ? showView : undefined;
    module.exports.switchListMode = typeof switchListMode !== 'undefined' ? switchListMode : undefined;
    module.exports.processLogout = typeof processLogout !== 'undefined' ? processLogout : undefined;
    module.exports.renderDailyAgenda = typeof renderDailyAgenda !== 'undefined' ? renderDailyAgenda : undefined;
    module.exports.renderClientsTable = typeof renderClientsTable !== 'undefined' ? renderClientsTable : undefined;
    module.exports.renderDashboard = typeof renderDashboard !== 'undefined' ? renderDashboard : undefined;
    module.exports.getCurrentUser = () => (typeof currentUser !== 'undefined' ? currentUser : null);
    module.exports.setCurrentUser = (u) => { currentUser = u; };
    module.exports.getProspects = () => (typeof prospects !== 'undefined' ? prospects : []);
    module.exports.setProspects = (p) => { prospects = p; };
    module.exports.getClients = () => (typeof clients !== 'undefined' ? clients : []);
    module.exports.setClients = (c) => { clients = c; };
    module.exports.getCurrentListMode = () => (typeof currentListMode !== 'undefined' ? currentListMode : 'agenda');
    module.exports.setCurrentListMode = (m) => { currentListMode = m; };
    module.exports.getCurrentSubscribedUser = () => (typeof currentSubscribedUser !== 'undefined' ? currentSubscribedUser : null);
    module.exports.getCrmLoadError = () => (typeof crmLoadError !== 'undefined' ? crmLoadError : null);
    module.exports.getActiveUnsubscribers = () => (typeof activeUnsubscribers !== 'undefined' ? activeUnsubscribers : []);
    module.exports.getAuthSessionGeneration = () => (typeof authSessionGeneration !== 'undefined' ? authSessionGeneration : 0);
    module.exports.generarContrato = typeof generarContrato !== 'undefined' ? generarContrato : undefined;
    module.exports.getProjectSubtotal = typeof getProjectSubtotal !== 'undefined' ? getProjectSubtotal : undefined;
    module.exports.getProjectCosto = typeof getProjectCosto !== 'undefined' ? getProjectCosto : undefined;
    module.exports.isProjectFullyPaid = typeof isProjectFullyPaid !== 'undefined' ? isProjectFullyPaid : undefined;
    module.exports.toggleProjSort = typeof toggleProjSort !== 'undefined' ? toggleProjSort : undefined;
    module.exports.updateProjSortIcons = typeof updateProjSortIcons !== 'undefined' ? updateProjSortIcons : undefined;
    module.exports.getProjPaymentFilter = typeof getProjPaymentFilter !== 'undefined' ? getProjPaymentFilter : undefined;
    module.exports.setProjPaymentFilter = typeof setProjPaymentFilter !== 'undefined' ? setProjPaymentFilter : undefined;
    module.exports.FinanceController = typeof FinanceController !== 'undefined' ? FinanceController : undefined;
    module.exports.FinanceCalculations = typeof FinanceCalculations !== 'undefined' ? FinanceCalculations : undefined;
    module.exports.FinanceChangeOrders = typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : undefined;
    module.exports.FinanceInvoicing = typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : undefined;
    module.exports.FinancePayments = typeof FinancePayments !== 'undefined' ? FinancePayments : undefined;
    module.exports.FinanceContracts = typeof FinanceContracts !== 'undefined' ? FinanceContracts : undefined;
    module.exports.FinanceUI = typeof FinanceUI !== 'undefined' ? FinanceUI : undefined;
    module.exports.DashboardController = typeof DashboardController !== 'undefined' ? DashboardController : _DB_CTL;
    module.exports.DashboardUI = typeof DashboardUI !== 'undefined' ? DashboardUI : _DB_UI;
    module.exports.DashboardCharts = typeof DashboardCharts !== 'undefined' ? DashboardCharts : _DB_CHARTS;
    module.exports.DashboardManagerWorkflow = typeof DashboardManagerWorkflow !== 'undefined' ? DashboardManagerWorkflow : _DB_MWF;
    module.exports.DashboardAudit = typeof DashboardAudit !== 'undefined' ? DashboardAudit : _DB_AUDIT;
    module.exports.populateTimeFilter = typeof populateTimeFilter !== 'undefined' ? populateTimeFilter : undefined;
    module.exports.getFilteredProspects = typeof getFilteredProspects !== 'undefined' ? getFilteredProspects : undefined;
    module.exports.setSellerFilterMode = typeof setSellerFilterMode !== 'undefined' ? setSellerFilterMode : undefined;
    module.exports.getSellerFilterMode = typeof getSellerFilterMode !== 'undefined' ? getSellerFilterMode : undefined;
    module.exports.updateSellerFilterButtons = typeof updateSellerFilterButtons !== 'undefined' ? updateSellerFilterButtons : undefined;
    module.exports.switchManagerDecisionTab = typeof switchManagerDecisionTab !== 'undefined' ? switchManagerDecisionTab : undefined;
    module.exports.openManagerDecisionModal = typeof openManagerDecisionModal !== 'undefined' ? openManagerDecisionModal : undefined;
    module.exports.submitManagerDecision = typeof submitManagerDecision !== 'undefined' ? submitManagerDecision : undefined;
    module.exports.renderCharts = typeof renderCharts !== 'undefined' ? renderCharts : undefined;
    module.exports.renderDashboardKpiTimes = typeof renderDashboardKpiTimes !== 'undefined' ? renderDashboardKpiTimes : undefined;
    module.exports.renderDashboardActiveTimes = typeof renderDashboardActiveTimes !== 'undefined' ? renderDashboardActiveTimes : undefined;
    module.exports.fetchAuditLogs = typeof fetchAuditLogs !== 'undefined' ? fetchAuditLogs : undefined;
    module.exports.UsersPermissions = typeof UsersPermissions !== 'undefined' ? UsersPermissions : _USERS_PERM;
    module.exports.UsersUI = typeof UsersUI !== 'undefined' ? UsersUI : _USERS_UI;
    module.exports.UsersController = typeof UsersController !== 'undefined' ? UsersController : _USERS_CTL;
    module.exports.AuthSession = typeof AuthSession !== 'undefined' ? AuthSession : _AUTH_SESSION;
    module.exports.openUserModal = typeof openUserModal !== 'undefined' ? openUserModal : undefined;
    module.exports.saveUser = typeof saveUser !== 'undefined' ? saveUser : undefined;
    module.exports.toggleUserStatus = typeof toggleUserStatus !== 'undefined' ? toggleUserStatus : undefined;
    module.exports.resetUserPassword = typeof resetUserPassword !== 'undefined' ? resetUserPassword : undefined;
    module.exports.fetchAdminUsers = typeof fetchAdminUsers !== 'undefined' ? fetchAdminUsers : undefined;
    module.exports.checkAuth = typeof checkAuth !== 'undefined' ? checkAuth : undefined;
    module.exports.processLogin = typeof processLogin !== 'undefined' ? processLogin : undefined;
    module.exports.processDirectFirebaseAuthLogin = typeof processDirectFirebaseAuthLogin !== 'undefined' ? processDirectFirebaseAuthLogin : undefined;
    module.exports.processFirebaseLogin = typeof processFirebaseLogin !== 'undefined' ? processFirebaseLogin : undefined;
    module.exports.openForgotPasswordModal = typeof openForgotPasswordModal !== 'undefined' ? openForgotPasswordModal : undefined;
    module.exports.closeForgotPasswordModal = typeof closeForgotPasswordModal !== 'undefined' ? closeForgotPasswordModal : undefined;
    module.exports.processForgotPassword = typeof processForgotPassword !== 'undefined' ? processForgotPassword : undefined;
    module.exports.renderUsersTable = typeof renderUsersTable !== 'undefined' ? renderUsersTable : undefined;
    module.exports.AppState = typeof AppState !== 'undefined' ? AppState : undefined;
    module.exports.AppRouter = typeof AppRouter !== 'undefined' ? AppRouter : undefined;
    module.exports.saveListScrollPosition = typeof saveListScrollPosition !== 'undefined' ? saveListScrollPosition : undefined;
    module.exports.restoreListScrollPosition = typeof restoreListScrollPosition !== 'undefined' ? restoreListScrollPosition : undefined;
}

if (typeof window !== 'undefined') {
    window.setCurrentUser = (u) => { currentUser = u; };
    window.getCurrentUser = () => currentUser;
    window.setProspects = (p) => { prospects = p; };
    window.setClients = (c) => { clients = c; };
    window.setUsers = (u) => { users = u; };
    window.getProjectSubtotal = typeof getProjectSubtotal !== 'undefined' ? getProjectSubtotal : undefined;
    window.getProjectCosto = typeof getProjectCosto !== 'undefined' ? getProjectCosto : undefined;
    window.isProjectFullyPaid = typeof isProjectFullyPaid !== 'undefined' ? isProjectFullyPaid : undefined;
    window.generarContrato = typeof generarContrato !== 'undefined' ? generarContrato : undefined;
    window.DashboardController = typeof DashboardController !== 'undefined' ? DashboardController : _DB_CTL;
    window.DashboardUI = typeof DashboardUI !== 'undefined' ? DashboardUI : _DB_UI;
    window.DashboardCharts = typeof DashboardCharts !== 'undefined' ? DashboardCharts : _DB_CHARTS;
    window.DashboardManagerWorkflow = typeof DashboardManagerWorkflow !== 'undefined' ? DashboardManagerWorkflow : _DB_MWF;
    window.DashboardAudit = typeof DashboardAudit !== 'undefined' ? DashboardAudit : _DB_AUDIT;
    window.populateTimeFilter = typeof populateTimeFilter !== 'undefined' ? populateTimeFilter : undefined;
    window.renderDashboard = typeof renderDashboard !== 'undefined' ? renderDashboard : undefined;
    window.getFilteredProspects = typeof getFilteredProspects !== 'undefined' ? getFilteredProspects : undefined;
    window.setSellerFilterMode = typeof setSellerFilterMode !== 'undefined' ? setSellerFilterMode : undefined;
    window.getSellerFilterMode = typeof getSellerFilterMode !== 'undefined' ? getSellerFilterMode : undefined;
    window.updateSellerFilterButtons = typeof updateSellerFilterButtons !== 'undefined' ? updateSellerFilterButtons : undefined;
    window.switchManagerDecisionTab = typeof switchManagerDecisionTab !== 'undefined' ? switchManagerDecisionTab : undefined;
    window.openManagerDecisionModal = typeof openManagerDecisionModal !== 'undefined' ? openManagerDecisionModal : undefined;
    window.submitManagerDecision = typeof submitManagerDecision !== 'undefined' ? submitManagerDecision : undefined;
    window.renderCharts = typeof renderCharts !== 'undefined' ? renderCharts : undefined;
    window.renderDashboardKpiTimes = typeof renderDashboardKpiTimes !== 'undefined' ? renderDashboardKpiTimes : undefined;
    window.renderDashboardActiveTimes = typeof renderDashboardActiveTimes !== 'undefined' ? renderDashboardActiveTimes : undefined;
    window.fetchAuditLogs = typeof fetchAuditLogs !== 'undefined' ? fetchAuditLogs : undefined;
    window.UsersPermissions = typeof UsersPermissions !== 'undefined' ? UsersPermissions : _USERS_PERM;
    window.UsersUI = typeof UsersUI !== 'undefined' ? UsersUI : _USERS_UI;
    window.UsersController = typeof UsersController !== 'undefined' ? UsersController : _USERS_CTL;
    window.AuthSession = typeof AuthSession !== 'undefined' ? AuthSession : _AUTH_SESSION;
    window.AppState = typeof AppState !== 'undefined' ? AppState : undefined;
    window.AppRouter = typeof AppRouter !== 'undefined' ? AppRouter : undefined;
    window.openUserModal = typeof openUserModal !== 'undefined' ? openUserModal : undefined;
    window.saveUser = typeof saveUser !== 'undefined' ? saveUser : undefined;
    window.toggleUserStatus = typeof toggleUserStatus !== 'undefined' ? toggleUserStatus : undefined;
    window.resetUserPassword = typeof resetUserPassword !== 'undefined' ? resetUserPassword : undefined;
    window.fetchAdminUsers = typeof fetchAdminUsers !== 'undefined' ? fetchAdminUsers : undefined;
    window.checkAuth = typeof checkAuth !== 'undefined' ? checkAuth : undefined;
    window.processLogin = typeof processLogin !== 'undefined' ? processLogin : undefined;
    window.processLogout = typeof processLogout !== 'undefined' ? processLogout : undefined;
    window.openForgotPasswordModal = typeof openForgotPasswordModal !== 'undefined' ? openForgotPasswordModal : undefined;
    window.closeForgotPasswordModal = typeof closeForgotPasswordModal !== 'undefined' ? closeForgotPasswordModal : undefined;
    window.processForgotPassword = typeof processForgotPassword !== 'undefined' ? processForgotPassword : undefined;
    window.applyRolePermissions = typeof applyRolePermissions !== 'undefined' ? applyRolePermissions : undefined;
    window.renderUsersTable = typeof renderUsersTable !== 'undefined' ? renderUsersTable : undefined;
    window.showView = typeof showView !== 'undefined' ? showView : undefined;
    window.saveListScrollPosition = typeof saveListScrollPosition !== 'undefined' ? saveListScrollPosition : undefined;
    window.restoreListScrollPosition = typeof restoreListScrollPosition !== 'undefined' ? restoreListScrollPosition : undefined;
}

function showLoseForm() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.showLoseForm === 'function') {
        return mod.showLoseForm(...arguments);
    }
}

function openMarkLostModal(prospectId) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openMarkLostModal === 'function') {
        return mod.openMarkLostModal(...arguments);
    }
}

function closeMarkLostModal() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.closeMarkLostModal === 'function') {
        return mod.closeMarkLostModal(...arguments);
    }
}

async function processConfirmMarkLost(event) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processConfirmMarkLost === 'function') {
        return mod.processConfirmMarkLost(...arguments);
    }
}

async function processLose() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processLose === 'function') {
        return mod.processLose(...arguments);
    }
}

// ========================
// ============================================================================
// DASHBOARD MODULE PROXIES (Fase 6.5)
// Extraído a:
// - modules/dashboard/dashboard_ui.js
// - modules/dashboard/dashboard_charts.js
// - modules/dashboard/dashboard_audit.js
// - modules/dashboard/dashboard_manager_workflow.js
// - modules/dashboard/dashboard_controller.js
// Generación semántica del embudo: 'dash-funnel-row', 'dash-funnel-label', 'dash-funnel-bar'
// Detección móvil en visualizaciones: isMobileScreen = window.innerWidth <= 640
// Universo canónico de CxC Global: const cxcUniverse = (prospects && Array.isArray(prospects)) ? prospects.filter(p => p && p.eliminado !== true) : [];
// ============================================================================

function _initDashboardSubsystems() {
    const safeGetClients = () => {
        if (typeof clients !== 'undefined' && Array.isArray(clients) && clients.length > 0) return clients;
        if (typeof window !== 'undefined' && Array.isArray(window.clients) && window.clients.length > 0) return window.clients;
        if (typeof global !== 'undefined' && Array.isArray(global.clients) && global.clients.length > 0) return global.clients;
        if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
        if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
        if (typeof global !== 'undefined' && Array.isArray(global.clients)) return global.clients;
        return [];
    };
    const safeGetProspects = () => {
        if (typeof prospects !== 'undefined' && Array.isArray(prospects) && prospects.length > 0) return prospects;
        if (typeof window !== 'undefined' && Array.isArray(window.prospects) && window.prospects.length > 0) return window.prospects;
        if (typeof global !== 'undefined' && Array.isArray(global.prospects) && global.prospects.length > 0) return global.prospects;
        if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
        if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
        if (typeof global !== 'undefined' && Array.isArray(global.prospects)) return global.prospects;
        return [];
    };
    const safeGetUsers = () => {
        if (typeof users !== 'undefined' && Array.isArray(users) && users.length > 0) return users;
        if (typeof window !== 'undefined' && Array.isArray(window.users) && window.users.length > 0) return window.users;
        if (typeof global !== 'undefined' && Array.isArray(global.users) && global.users.length > 0) return global.users;
        if (typeof users !== 'undefined' && Array.isArray(users)) return users;
        if (typeof window !== 'undefined' && Array.isArray(window.users)) return window.users;
        if (typeof global !== 'undefined' && Array.isArray(global.users)) return global.users;
        return [];
    };
    const safeGetCurrentUser = () => {
        if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
        if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
        if (typeof global !== 'undefined' && global.currentUser) return global.currentUser;
        return null;
    };
    const safeGetCalc = () => {
        if (typeof CrmDashboardCalc !== 'undefined' && CrmDashboardCalc) return CrmDashboardCalc;
        if (typeof window !== 'undefined' && window.CrmDashboardCalc) return window.CrmDashboardCalc;
        if (typeof global !== 'undefined' && global.CrmDashboardCalc) return global.CrmDashboardCalc;
        return null;
    };
    const safeGetDbSuffix = () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : ((typeof window !== 'undefined' && window.DB_SUFFIX) ? window.DB_SUFFIX : ((typeof global !== 'undefined' && global.DB_SUFFIX) ? global.DB_SUFFIX : '_prod')));
    const safeGetDb = () => (typeof db !== 'undefined' ? db : ((typeof window !== 'undefined' && window.db) ? window.db : ((typeof global !== 'undefined' && global.db) ? global.db : null)));
    const safeGetDoc = () => (typeof document !== 'undefined' ? document : ((typeof window !== 'undefined' && window.document) ? window.document : null));
    const safeGetWin = () => (typeof window !== 'undefined' ? window : null);
    const safeGetChart = () => (typeof Chart !== 'undefined' ? Chart : ((typeof window !== 'undefined' && window.Chart) ? window.Chart : null));
    const safeGetCommercial = () => (typeof CrmCommercial !== 'undefined' ? CrmCommercial : ((typeof window !== 'undefined' && window.CrmCommercial) ? window.CrmCommercial : null));

    const ctlMod = _getDashboardController();
    const uiMod = _getDashboardUI();
    const chartsMod = _getDashboardCharts();
    const mwfMod = _getDashboardManagerWorkflow();
    const auditMod = _getDashboardAudit();

    if (uiMod && typeof uiMod.setDeps === 'function') {
        uiMod.setDeps({
            getProspects: safeGetProspects,
            getUsers: safeGetUsers,
            getClients: safeGetClients,
            getCurrentUser: safeGetCurrentUser,
            getCrmDashboardCalc: safeGetCalc,
            getFilterSellerMode: () => (typeof getSellerFilterMode === 'function' ? getSellerFilterMode() : 'active_only'),
            formatCurrency: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            formatMoney: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            escapeHtml: (...args) => (typeof escapeHtml === 'function' ? escapeHtml(...args) : undefined),
            document: safeGetDoc()
        });
    }

    if (chartsMod && typeof chartsMod.setDeps === 'function') {
        chartsMod.setDeps({
            getProspects: safeGetProspects,
            getUsers: safeGetUsers,
            getCrmDashboardCalc: safeGetCalc,
            formatCurrency: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            formatMoney: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            escapeHtml: (...args) => (typeof escapeHtml === 'function' ? escapeHtml(...args) : undefined),
            getChartConstructor: safeGetChart,
            document: safeGetDoc(),
            window: safeGetWin()
        });
    }

    if (ctlMod && typeof ctlMod.setDeps === 'function') {
        ctlMod.setDeps({
            getProspects: safeGetProspects,
            getUsers: safeGetUsers,
            getCurrentUser: safeGetCurrentUser,
            getCrmDashboardCalc: safeGetCalc,
            getDashboardUI: () => _getDashboardUI(),
            getDashboardCharts: () => _getDashboardCharts(),
            getDashboardAudit: () => _getDashboardAudit(),
            getFilterTimeSelect: () => (safeGetDoc() ? safeGetDoc().getElementById('dash-time-filter') : null),
            getFilterSellerSelect: () => (safeGetDoc() ? safeGetDoc().getElementById('dash-seller-filter') : null),
            document: safeGetDoc(),
            formatCurrency: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            formatMoney: (...args) => (typeof formatCurrency === 'function' ? formatCurrency(...args) : undefined),
            escapeHtml: (...args) => (typeof escapeHtml === 'function' ? escapeHtml(...args) : undefined)
        });
    }

    if (mwfMod && typeof mwfMod.setDeps === 'function') {
        mwfMod.setDeps({
            getProspects: safeGetProspects,
            getCurrentUser: safeGetCurrentUser,
            getCrmCommercial: safeGetCommercial,
            getDbSuffix: safeGetDbSuffix,
            openModal: (...args) => (typeof openModal === 'function' ? openModal(...args) : undefined),
            closeModal: (...args) => (typeof closeModal === 'function' ? closeModal(...args) : undefined),
            reRenderApp: (...args) => (typeof reRenderApp === 'function' ? reRenderApp(...args) : undefined),
            escapeHtml: (...args) => (typeof escapeHtml === 'function' ? escapeHtml(...args) : undefined),
            document: safeGetDoc()
        });
    }

    if (auditMod && typeof auditMod.setDeps === 'function') {
        auditMod.setDeps({
            getDb: safeGetDb,
            getDbSuffix: safeGetDbSuffix,
            escapeHtml: (...args) => (typeof escapeHtml === 'function' ? escapeHtml(...args) : undefined),
            document: safeGetDoc()
        });
    }
}
_initDashboardSubsystems();

function populateTimeFilter() {
    _initDashboardSubsystems();
    const mod = _getDashboardController();
    if (mod && typeof mod.populateTimeFilter === 'function') {
        return mod.populateTimeFilter(...arguments);
    }
}

function getFilteredProspects() {
    const mod = _getDashboardController();
    if (mod && typeof mod.getFilteredProspects === 'function') {
        return mod.getFilteredProspects(...arguments);
    }
}

let currentSellerFilterMode = 'active_only';

function setSellerFilterMode(mode) {
    currentSellerFilterMode = mode;
    const mod = _getDashboardController();
    if (mod && typeof mod.setSellerFilterMode === 'function') {
        return mod.setSellerFilterMode(mode);
    }
}

function getSellerFilterMode() {
    const mod = _getDashboardController();
    if (mod && typeof mod.getSellerFilterMode === 'function') {
        return mod.getSellerFilterMode();
    }
    return currentSellerFilterMode;
}

function updateSellerFilterButtons() {
    const mod = _getDashboardController();
    if (mod && typeof mod.updateSellerFilterButtons === 'function') {
        return mod.updateSellerFilterButtons(...arguments);
    }
}

function renderDashboard() {
    _initDashboardSubsystems();
    const mod = _getDashboardController();
    if (mod && typeof mod.renderDashboard === 'function') {
        return mod.renderDashboard(...arguments);
    }
}

function fetchAuditLogs() {
    const mod = _getDashboardAudit();
    if (mod && typeof mod.fetchAuditLogs === 'function') {
        return mod.fetchAuditLogs(...arguments);
    }
}

function renderDashboardKpiTimes(filterRes) {
    const mod = _getDashboardUI();
    if (mod && typeof mod.renderDashboardKpiTimes === 'function') {
        return mod.renderDashboardKpiTimes(...arguments);
    }
}

function renderDashboardActiveTimes(activeList) {
    const mod = _getDashboardUI();
    if (mod && typeof mod.renderDashboardActiveTimes === 'function') {
        return mod.renderDashboardActiveTimes(...arguments);
    }
}

function switchManagerDecisionTab(tab) {
    const mod = _getDashboardManagerWorkflow();
    if (mod && typeof mod.switchManagerDecisionTab === 'function') {
        return mod.switchManagerDecisionTab(...arguments);
    }
}

function openManagerDecisionModal(prospectId) {
    const mod = _getDashboardManagerWorkflow();
    if (mod && typeof mod.openManagerDecisionModal === 'function') {
        return mod.openManagerDecisionModal(...arguments);
    }
}

async function submitManagerDecision(decisionType) {
    const mod = _getDashboardManagerWorkflow();
    if (mod && typeof mod.submitManagerDecision === 'function') {
        return await mod.submitManagerDecision(...arguments);
    }
}

function renderCharts(filterRes) {
    const mod = _getDashboardCharts();
    if (mod && typeof mod.renderCharts === 'function') {
        return mod.renderCharts(...arguments);
    }
}

function generarContrato(prospectId) {
    const mod = (typeof _getFinanceContracts === 'function') ? _getFinanceContracts() : (typeof FinanceContracts !== 'undefined' ? FinanceContracts : null);
    if (mod && typeof mod.generarContrato === 'function') {
        return mod.generarContrato(...arguments);
    }
}
// generarContrato extraído a modules/finance/finance_contracts.js (Fase 6.4)

// REMOVED: reportToManager wrote the manager's audit notice (audit_logs) from the browser, with the e-mail the browser claimed to be.
// The deletion callables (deleteChangeOrderAdmin / deleteInvoiceAdmin / deletePaymentAdmin / deleteProspectAdmin) write that notice on
// the server, in the same transaction as the change, with the authenticated identity.

// ========================
// EDIT & DELETE FINANCIALS
// ========================
function openEditBasePriceModal() {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.openEditBasePriceModal === 'function') {
        return mod.openEditBasePriceModal(...arguments);
    }
}

async function processEditBasePrice(e) {
    const mod = (typeof _getOpportunitiesUI === 'function') ? _getOpportunitiesUI() : null;
    if (mod && typeof mod.processEditBasePrice === 'function') {
        return mod.processEditBasePrice(...arguments);
    }
}

async function deleteChangeOrder(id) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceChangeOrders === 'function') ? _getFinanceChangeOrders() : (typeof FinanceChangeOrders !== 'undefined' ? FinanceChangeOrders : null);
    if (mod && typeof mod.deleteChangeOrder === 'function') {
        return await mod.deleteChangeOrder(...arguments);
    }
    if (!confirm("¿Estás seguro de eliminar esta orden de cambio?")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.ordenes_cambio || !p.ordenes_cambio.some(o => o.id === id)) return;
    await runWorkflowOp('Eliminando orden de cambio...', fb => CrmCommercial.deleteChangeOrder(fb, { prospectId: p.id, orderId: id, dbSuffix: DB_SUFFIX }));
}

async function deleteInvoice(id) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinanceInvoicing === 'function') ? _getFinanceInvoicing() : (typeof FinanceInvoicing !== 'undefined' ? FinanceInvoicing : null);
    if (mod && typeof mod.deleteInvoice === 'function') {
        return await mod.deleteInvoice(...arguments);
    }
    if (!confirm("¿Estás seguro de eliminar esta factura? Todo su historial de pagos se borrará también.")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const idx = p.facturas.findIndex(f => f.id === id);
    if (idx === -1) return;
    if (idx === 0) return alert("Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error.");
    await runWorkflowOp('Eliminando factura...', fb => CrmCommercial.deleteInvoice(fb, { prospectId: p.id, invoiceId: id, dbSuffix: DB_SUFFIX }));
}

async function deletePayment(invoiceId, paymentIndex) {
    const userRole = (currentUser && currentUser.role) || (typeof window !== 'undefined' && window.currentUser && window.currentUser.role);
    if (userRole === 'vendedor') {
        alert("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
        return;
    }
    const mod = (typeof _getFinancePayments === 'function') ? _getFinancePayments() : (typeof FinancePayments !== 'undefined' ? FinancePayments : null);
    if (mod && typeof mod.deletePayment === 'function') {
        return await mod.deletePayment(...arguments);
    }
    if (!confirm("¿Estás seguro de eliminar este abono?")) return;
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === invoiceId);
    if (!f || !f.pagos) return;
    const pay = f.pagos[paymentIndex];
    if (!pay) return;
    await runWorkflowOp('Eliminando abono...', fb => CrmCommercial.deletePayment(fb, { prospectId: p.id, invoiceId, paymentKey: pay.id || pay.fecha, dbSuffix: DB_SUFFIX }));
}

// deleteClient extraído a modules/clients/clients_controller.js (Fase 6.2.1)


// Logical deletion (deleteProspectAdmin): the opportunity is MARKED as deleted (who / when / why) and disappears from the listings;
// its data, the files and the manufacturing project stay untouched. The reason is mandatory and is validated by the server too.
async function deleteProspect() {
    const targetId = arguments[0];
    const motivoText = arguments[1];
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.deleteProspect) return await mod.deleteProspect(targetId, motivoText);
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
async function reactivateLostProspect(targetId, motivoText) {
    const mod = (typeof _getOpportunitiesController === 'function') ? _getOpportunitiesController() : null;
    if (mod && mod.reactivateLostProspect) return await mod.reactivateLostProspect(targetId, motivoText);
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
