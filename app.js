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
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const storage = firebase.storage();

// Configuración de Entornos Automática
const isLocal = window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const DB_SUFFIX = isLocal ? '_local' : '_prod';
const STORAGE_PREFIX = isLocal ? 'local_files' : 'prod_files';

if (isLocal) {
    console.warn("⚠️ MODO DESARROLLO LOCAL ACTIVADO: Conectado a las colecciones '_local' en Firebase.");
}

// Helper Functions para Carga
function showLoading(msg = 'Subiendo archivo a la nube...') {
    const el = document.getElementById('global-spinner');
    if(el) {
        document.getElementById('spinner-msg').textContent = msg;
        el.style.display = 'flex';
    }
}
function hideLoading() {
    const el = document.getElementById('global-spinner');
    if(el) el.style.display = 'none';
}

async function uploadFileToStorage(file, folderName) {
    if(!file) return null;
    try {
        const ext = file.name.split('.').pop();
        const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const storageRef = storage.ref();
        const fileRef = storageRef.child(`${STORAGE_PREFIX}/${folderName}/${Date.now()}_${safeName}`);
        await fileRef.put(file);
        const url = await fileRef.getDownloadURL();
        return { name: file.name, url: url };
    } catch (e) {
        console.error("Error uploading file to Storage", e);
        throw e;
    }
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
let currentUser = JSON.parse(localStorage.getItem('hexasales_current_user')) || null;
let currentProspectId = null;
let lastViewedSection = 'list-view';

let settings = { visitantes: [], encargados: [], gmaps_api_key: "", factory_address: "" };

let chartFunnel = null; let chartProduct = null; let chartProject = null; let chartOrigin = null; let chartLoss = null; let chartOppProduct = null; let chartOppProject = null;

let loadedCollections = 0;

function reRenderApp() {
    if (!currentUser) return;
    populateTimeFilter(); 
    toggleClientFields(); 
    if (document.getElementById('list-view').style.display !== 'none') renderList();
    if (document.getElementById('dashboard-view').style.display !== 'none') renderDashboard();
    if (document.getElementById('users-view').style.display !== 'none') renderUsers();
    if (document.getElementById('detail-view').style.display !== 'none' && currentProspectId) openDetail(currentProspectId);
}

function checkInitialLoad() {
    loadedCollections++;
    if (loadedCollections === 4) {
        if (users.length === 0) {
            let admin = { id: Date.now().toString(), nombre: 'Administrador Maestro', email: 'bvaliente@grupogama.com', password: '', role: 'manager', activo: true };
            saveUserToDB(admin);
        }
        checkAuth();
        reRenderApp();
    } else if (loadedCollections > 4) {
        reRenderApp();
    }
}

document.addEventListener('DOMContentLoaded', async () => { 
    // Migrate local to firebase on first run
    const localClients = JSON.parse(localStorage.getItem('ductsal_clients'));
    if (localClients && !localStorage.getItem('migrated_to_firebase')) {
        console.log("Migrando datos a la nube...");
        const localProspects = JSON.parse(localStorage.getItem('ductsal_prospects')) || [];
        const localUsers = JSON.parse(localStorage.getItem('hexasales_users')) || [];
        const localSettings = JSON.parse(localStorage.getItem('ductsal_settings')) || { visitantes: [], encargados: [] };
        
        for(let c of localClients) await db.collection(`clients${DB_SUFFIX}`).doc(c.id).set(c);
        for(let p of localProspects) await db.collection(`prospects${DB_SUFFIX}`).doc(p.id).set(p);
        for(let u of localUsers) await db.collection(`users${DB_SUFFIX}`).doc(u.id).set(u);
        await db.collection(`system${DB_SUFFIX}`).doc('settings').set(localSettings);
        
        localStorage.setItem('migrated_to_firebase', 'true');
        console.log("Migración completada.");
    }

    // Attach Listeners
    db.collection(`clients${DB_SUFFIX}`).onSnapshot(snap => { clients = snap.docs.map(doc => doc.data()); checkInitialLoad(); });
    db.collection(`prospects${DB_SUFFIX}`).onSnapshot(snap => { prospects = snap.docs.map(doc => doc.data()); checkInitialLoad(); });
    db.collection(`users${DB_SUFFIX}`).onSnapshot(snap => { users = snap.docs.map(doc => doc.data()); checkInitialLoad(); });
    db.collection(`system${DB_SUFFIX}`).doc('settings').onSnapshot(doc => { if(doc.exists) settings = doc.data(); checkInitialLoad(); });
});

function saveClientToDB(c) { db.collection(`clients${DB_SUFFIX}`).doc(c.id).set(c); }
function saveProspectToDB(p) { db.collection(`prospects${DB_SUFFIX}`).doc(p.id).set(p); }
function saveUserToDB(u) { db.collection(`users${DB_SUFFIX}`).doc(u.id).set(u); }
function saveSettings() { db.collection(`system${DB_SUFFIX}`).doc('settings').set(settings); }

function saveState() { console.log('Deprecated saveState called.'); }
function saveUsers() { console.log('Deprecated saveUsers called.'); }

function openSettingsModal() {
    renderSettingsLists();
    document.getElementById('set-gmaps-factory').value = settings.factory_address || "";
    document.getElementById('settingsModal').style.display = 'block';
}

function saveMapsSettings() {
    settings.factory_address = document.getElementById('set-gmaps-factory').value.trim();
    saveSettings();
    alert("Ajustes de mapa guardados.");
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

function addSetting(type) {
    let input = document.getElementById(`new-${type}-input`);
    let val = input.value.trim();
    if(val) {
        settings[type].push(val);
        input.value = '';
        saveSettings();
        renderSettingsLists();
    }
}

function removeSetting(type, index) {
    settings[type].splice(index, 1);
    saveSettings();
    renderSettingsLists();
}

function showView(viewId) {
    lastViewedSection = viewId === 'detail-view' ? lastViewedSection : viewId;
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));
    
    if(viewId === 'list-view') { document.getElementById('nav-list').classList.add('active'); renderList(); }
    if(viewId === 'clients-view') { document.getElementById('nav-clients').classList.add('active'); renderClientsTable(); }
    if(viewId === 'dashboard-view') { document.getElementById('nav-dashboard').classList.add('active'); renderDashboard(); }
    if(viewId === 'projects-view') { document.getElementById('nav-projects').classList.add('active'); renderProjectsList(); }
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
    
    const user = users.find(u => u.email === email && u.activo);
    if (!user) return alert("Usuario no encontrado o inactivo.");
    
    if (user.password === "") {
        if (pass !== "") {
            return alert("Este usuario es nuevo. Deja la contraseña en blanco y dale a Iniciar Sesión para configurarla por primera vez.");
        }
        pendingSetupUser = user;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('setup-screen').style.display = 'flex';
    } else {
        if (user.password !== pass) return alert("Contraseña incorrecta.");
        currentUser = user;
        localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
        checkAuth();
    }
}

function processFirstTimeSetup(e) {
    e.preventDefault();
    const p1 = document.getElementById('setup-password').value;
    const p2 = document.getElementById('setup-password-confirm').value;
    if(p1 !== p2) return alert("Las contraseñas no coinciden.");
    if(p1.length < 4) return alert("La contraseña debe tener al menos 4 caracteres.");
    
    pendingSetupUser.password = p1;
    saveUserToDB(pendingSetupUser);
    
    currentUser = pendingSetupUser;
    localStorage.setItem('ductsal_current_user', JSON.stringify(currentUser));
    checkAuth();
}

function processLogout() {
    currentUser = null;
    localStorage.removeItem('ductsal_current_user');
    checkAuth();
}

function applyRolePermissions() {
    if(!currentUser) return;
    const role = currentUser.role;
    const navDashboard = document.getElementById('nav-dashboard'); const navProjects = document.getElementById('nav-projects'); const headerAction = document.getElementById('client-action-header');
    const navSettings = document.getElementById('nav-settings'); const navUsers = document.getElementById('nav-users');
    
    if (role === 'manager') { navDashboard.style.display = 'flex'; navProjects.style.display = 'flex'; navSettings.style.display = 'flex'; navUsers.style.display = 'flex'; headerAction.style.display = 'none'; showView('dashboard-view'); } 
    else if (role === 'gestor') { navDashboard.style.display = 'flex'; navProjects.style.display = 'flex'; navSettings.style.display = 'none'; navUsers.style.display = 'none'; headerAction.style.display = 'table-cell'; showView('projects-view'); }
    else { navDashboard.style.display = 'none'; navProjects.style.display = 'none'; navSettings.style.display = 'none'; navUsers.style.display = 'none'; headerAction.style.display = 'table-cell'; showView('list-view'); }
    
    renderList();
    renderClientsTable();
    if (role === 'manager') renderUsersTable();
}

// ========================
// USERS MANAGEMENT
// ========================
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

function saveUser(e) {
    e.preventDefault();
    const id = document.getElementById('user-id-edit').value;
    const nombre = document.getElementById('usr-nombre').value.trim();
    const email = document.getElementById('usr-email').value.trim();
    const role = document.getElementById('usr-rol').value;

    if (id) {
        const u = users.find(x => x.id === id);
        if (u) { u.nombre = nombre; u.email = email; u.role = role; saveUserToDB(u); }
    } else {
        if(users.some(x => x.email === email)) return alert("El correo ya está en uso.");
        let nu = { id: Date.now().toString(), nombre, email, password: '', role, activo: true };
        saveUserToDB(nu);
    }
    closeModal('userModal');
    renderUsersTable();
}

function renderUsersTable() {
    const tbody = document.getElementById('users-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    users.forEach(u => {
        const rName = u.role === 'manager' ? 'Gerente' : (u.role === 'gestor' ? 'Gestor de Ventas' : 'Vendedor');
        const stHtml = u.activo ? `<span style="color:var(--success);">Activo</span>` : `<span style="color:var(--danger);">Inactivo</span>`;
        tbody.innerHTML += `<tr>
            <td>${u.nombre}</td>
            <td>${u.email}</td>
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
    if(confirm("¿Estás seguro de restablecer la contraseña? El usuario deberá configurarla nuevamente al iniciar sesión.")) {
        const u = users.find(x => x.id === id);
        u.password = "";
        saveUserToDB(u);
        alert("Contraseña restablecida.");
    }
}

function toggleUserStatus(id) {
    const u = users.find(x => x.id === id);
    if(u.id === currentUser.id) return alert("No puedes desactivarte a ti mismo.");
    u.activo = !u.activo;
    saveUserToDB(u);
    renderUsersTable();
}

const formatCurrency = (val) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val || 0);
const formatDate = (date) => new Date(date).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
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
function renderClientsTable() {
    const tbody = document.getElementById('clients-table-body'); tbody.innerHTML = '';
    
    let filtered = clients;
    if (currentUser && currentUser.role === 'vendedor') {
        filtered = filtered.filter(c => c.createdBy === currentUser.id);
    }

    [...filtered].reverse().forEach(c => {
        const isNatural = c.tipo === 'natural'; const typeBadge = isNatural ? '<span class="badge bg-neutral">Natural</span>' : '<span class="badge bg-neutral" style="color:var(--brand-gold);">Jurídica</span>';
        const contactName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.contacto || '-'); const mainName = isNatural ? `${c.nombres || ''} ${c.apellidos || ''}` : (c.empresa || '-');
        
        let btnHTML = `<button class="btn-secondary" onclick="openClientModal('${c.id}')" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Editar</button>`;
        if (currentUser && currentUser.role === 'manager') {
            btnHTML += `<button class="btn-danger" onclick="deleteClient('${c.id}')" style="padding: 0.25rem 0.5rem; font-size:0.75rem; margin-left:5px;">Eliminar</button>`;
        }
        
        tbody.innerHTML += `<tr><td>${typeBadge}</td><td><strong>${mainName}</strong></td><td>${contactName}</td><td>${c.telefono || '-'}</td><td>${c.correo || '-'}</td><td>${btnHTML}</td></tr>`;
    });
}
function toggleClientFields() {
    const type = document.getElementById('client-tipo').value;
    if (type === 'natural') { document.getElementById('fields-natural').style.display = 'block'; document.getElementById('fields-juridica').style.display = 'none'; } 
    else { document.getElementById('fields-natural').style.display = 'none'; document.getElementById('fields-juridica').style.display = 'block'; }
}
function openClientModal(clientId = null) {
    document.getElementById('clientForm').reset(); document.getElementById('client-id-edit').value = '';
    if (clientId) {
        document.getElementById('client-modal-title').textContent = 'Editar Cliente'; const c = clients.find(x => x.id === clientId);
        if (c) {
            document.getElementById('client-id-edit').value = c.id; document.getElementById('client-tipo').value = c.tipo; toggleClientFields();
            document.getElementById('cli-telefono').value = c.telefono || ''; document.getElementById('cli-correo').value = c.correo || ''; document.getElementById('cli-correo-fact').value = c.correo_fact || '';
            if (c.tipo === 'natural') { 
                document.getElementById('nat-nombres').value = c.nombres || ''; document.getElementById('nat-apellidos').value = c.apellidos || ''; 
                document.getElementById('nat-dui').value = c.dui || ''; document.getElementById('nat-nit').value = c.nit || ''; 
                document.getElementById('nat-profesion').value = c.profesion || ''; document.getElementById('nat-domicilio').value = c.domicilio || '';
                const sts = document.getElementById('nat-dui-status');
                if(c.documentos && c.documentos.dui) sts.innerHTML = `<span style="color:var(--success);">✔️ DUI en expediente: ${c.documentos.dui}</span>`; else sts.innerHTML = '';
            }
            else { 
                document.getElementById('jur-empresa').value = c.empresa || ''; document.getElementById('jur-contacto').value = c.contacto || ''; document.getElementById('jur-nit').value = c.nit || ''; document.getElementById('jur-nrc').value = c.nrc || '';
                document.getElementById('jur-rep-legal').value = c.rep_legal || ''; document.getElementById('jur-profesion-rep').value = c.profesion_rep || ''; document.getElementById('jur-domicilio-rep').value = c.domicilio_rep || '';
                document.getElementById('jur-dui-rep').value = c.dui_rep || ''; document.getElementById('jur-nit-rep').value = c.nit_rep || '';
                const jSts = document.getElementById('jur-docs-status');
                if (c.documentos && Object.keys(c.documentos).length > 0) {
                    let text = "Archivos en expediente: ";
                    if(c.documentos.escritura) text += "[Escritura] "; if(c.documentos.credencial) text += "[Credencial] "; if(c.documentos.nit) text += "[NIT] "; if(c.documentos.nrc) text += "[NRC] "; if(c.documentos.dui) text += "[DUI Rep.] ";
                    jSts.innerHTML = `<span style="color:var(--success);">${text}</span>`;
                } else { jSts.innerHTML = ''; }
            }
        }
    } else { document.getElementById('client-modal-title').textContent = 'Registrar Cliente'; document.getElementById('client-tipo').value = 'natural'; toggleClientFields(); }
    document.getElementById('clientModal').style.display = 'block';
}

async function saveClient(e) {
    e.preventDefault(); const type = document.getElementById('client-tipo').value; const editId = document.getElementById('client-id-edit').value;
    const tel = document.getElementById('cli-telefono').value.trim(); const email = document.getElementById('cli-correo').value.trim();
    if (!tel && !email) return alert("Debe ingresar obligatoriamente un teléfono o correo.");
    
    showLoading('Subiendo documentos del cliente...');
    try {
        let c = {};
        if (type === 'natural') {
            c.nombres = document.getElementById('nat-nombres').value.trim(); c.apellidos = document.getElementById('nat-apellidos').value.trim();
            if (!c.nombres || !c.apellidos) { hideLoading(); return alert("Nombres y Apellidos obligatorios."); }
            c.dui = document.getElementById('nat-dui').value; c.nit = document.getElementById('nat-nit').value;
            c.profesion = document.getElementById('nat-profesion').value; c.domicilio = document.getElementById('nat-domicilio').value;
            const duiFile = document.getElementById('nat-dui-file');
            if (duiFile && duiFile.files.length > 0) {
                if(!c.documentos) c.documentos = {};
                c.documentos.dui = await uploadFileToStorage(duiFile.files[0], 'clientes');
            }
        } else {
            c.empresa = document.getElementById('jur-empresa').value.trim(); if (!c.empresa) { hideLoading(); return alert("Nombre de la Empresa obligatorio."); }
            c.contacto = document.getElementById('jur-contacto').value; c.nit = document.getElementById('jur-nit').value; c.nrc = document.getElementById('jur-nrc').value;
            c.rep_legal = document.getElementById('jur-rep-legal').value.trim(); if (!c.rep_legal) { hideLoading(); return alert("Nombre del Representante Legal obligatorio."); }
            c.profesion_rep = document.getElementById('jur-profesion-rep').value; c.domicilio_rep = document.getElementById('jur-domicilio_rep').value;
            c.dui_rep = document.getElementById('jur-dui-rep').value; c.nit_rep = document.getElementById('jur-nit_rep').value;
            
            if(!c.documentos) c.documentos = {};
            const uploadDoc = async (id, key) => { const el = document.getElementById(id); if(el && el.files.length > 0) c.documentos[key] = await uploadFileToStorage(el.files[0], 'clientes'); };
            await uploadDoc('jur-file-escritura', 'escritura'); await uploadDoc('jur-file-mods', 'mods_escritura'); await uploadDoc('jur-file-credencial', 'credencial'); 
            await uploadDoc('jur-file-nit', 'nit'); await uploadDoc('jur-file-nrc', 'nrc'); await uploadDoc('jur-file-dui', 'dui');
        }
        c.tipo = type; c.telefono = tel; c.correo = email; c.correo_fact = document.getElementById('cli-correo-fact').value;
        if (editId) { c.id = editId; const index = clients.findIndex(x => x.id === editId); if (index > -1) clients[index] = c; } 
        else { 
            c.id = 'C' + Date.now().toString(); 
            c.createdBy = currentUser ? currentUser.id : 'sistema';
            c.fecha_creacion = new Date().toISOString(); 
            clients.push(c); 
        }
        saveClientToDB(c);
        closeModal('clientModal');
        if(document.getElementById('newProspectModal').style.display === 'block') { 
            renderClientSelect(); 
            document.getElementById('new-cliente-select').value = c.id; 
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
        filtered = filtered.filter(p => p.createdBy === currentUser.id);
    }
    const tbody = document.getElementById('opp-table-body'); tbody.innerHTML = '';
    const visibleProspects = filtered.filter(p => p.estado !== 'ganado');
    [...visibleProspects].reverse().forEach(p => {
        const tr = document.createElement('tr'); tr.classList.add('cursor-pointer'); tr.onclick = () => openDetail(p.id);
        let badgeClass = p.estado === 'activo' ? 'activo' : 'perdido';
        tr.innerHTML = `<td>${p.codigo || p.id.substring(p.id.length-4)}</td><td><strong>${getClientName(p.clientId)}</strong></td><td>${p.proyecto}</td><td style="text-transform: capitalize;">${p.etapa}</td><td>${p.precio_cotizado ? formatCurrency(p.precio_cotizado) : '-'}</td><td><span class="badge ${badgeClass}">${p.estado.toUpperCase()}</span></td><td><button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Ver</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderProjectsList() {
    const tbody = document.getElementById('proj-table-body'); tbody.innerHTML = '';
    const projects = prospects.filter(p => p.estado === 'ganado');
    if (projects.length === 0) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 2rem; color: var(--text-muted);">No hay proyectos cerrados / ganados todavía.</td></tr>'; return; }

    [...projects].reverse().forEach(p => {
        let subtotal = p.precio_cotizado || 0;
        let total = subtotal * 1.13;

        let totalFacturado = 0; let totalCobrado = 0;
        if(p.facturas) {
            p.facturas.forEach(f => {
                totalFacturado += f.monto;
                if(f.pagos) totalCobrado += f.pagos.reduce((a,b) => a + parseFloat(b.monto), 0);
            });
        }
        
        const pctFacturado = total > 0 ? Math.min(100, (totalFacturado / total) * 100) : 0;
        const pctCobrado = total > 0 ? Math.min(100, (totalCobrado / total) * 100) : 0;
        
        const tr = document.createElement('tr'); tr.classList.add('cursor-pointer'); tr.onclick = () => openDetail(p.id);
        const encargado = p.encargado || '-';
        tr.innerHTML = `
            <td><strong>${p.codigo || '-'}</strong></td>
            <td>${getClientName(p.clientId)}</td>
            <td>${p.proyecto}</td>
            <td>${encargado}</td>
            <td>${formatCurrency(total)}</td>
            <td>${p.forma_pago || 'N/A'}</td>
            <td>${pctFacturado.toFixed(0)}%</td>
            <td>
                <div style="background:rgba(255,255,255,0.1); height:8px; border-radius:4px; width:100px; margin-bottom:4px; overflow:hidden;">
                    <div style="background:var(--success); height:100%; width:${pctCobrado}%"></div>
                </div>
                <small>${pctCobrado.toFixed(0)}%</small>
            </td>
            <td><button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size:0.75rem">Gestionar</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function openNewModal() { renderClientSelect(); document.getElementById('newProspectModal').style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function renderClientSelect() {
    const select = document.getElementById('new-cliente-select'); select.innerHTML = '<option value="">-- Selecciona Cliente --</option>';
    let filtered = clients;
    if (currentUser && currentUser.role === 'vendedor') {
        filtered = filtered.filter(c => c.createdBy === currentUser.id);
    }
    filtered.forEach(c => { select.innerHTML += `<option value="${c.id}">${c.tipo === 'natural' ? `${c.nombres} ${c.apellidos}` : c.empresa}</option>`; });
}
function createNewProspect(e) {
    e.preventDefault(); const clientId = document.getElementById('new-cliente-select').value; if(!clientId) return alert("Debes seleccionar un cliente");
    const p = {
        id: Date.now().toString(), 
        codigo: generateProspectCode(), 
        clientId: clientId, 
        createdBy: currentUser ? currentUser.id : 'sistema',
        proyecto: document.getElementById('new-proyecto').value, 
        origen: document.getElementById('new-origen').value,
        tipo_proyecto: document.getElementById('new-tipo-proyecto').value, 
        tipo_producto: document.getElementById('new-tipo-producto').value, 
        fecha_creacion: new Date().toISOString(),
        etapa: 'prospecto', 
        estado: 'activo', 
        stage_timestamps: { 'prospecto': new Date().toISOString() }, 
        logs: [], 
        datos: {}, 
        facturas: []
    };
    addLogToProspect(p, 'Prospecto creado. Origen: ' + p.origen, true); saveProspectToDB(p); closeModal('newProspectModal'); document.getElementById('newProspectForm').reset(); renderList();
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
    
    // Show Delete Prospect button for managers
    const btnDeleteProspect = document.getElementById('btn-delete-prospect');
    if (btnDeleteProspect) {
        btnDeleteProspect.style.display = (currentUser && currentUser.role === 'manager') ? 'block' : 'none';
    }
    
    const actionContainer = document.getElementById('action-buttons-container');
    const finTracker = document.getElementById('financial-tracker-container');
    const stageTitleText = document.getElementById('stage-title-text');

    const trackerContainer = document.getElementById('stage-tracker');
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
    } else { actionContainer.style.display = 'none'; finTracker.style.display = 'none'; stageTitleText.parentElement.style.display = 'block'; trackerContainer.style.display = 'flex'; stageTitleText.textContent = "Línea de Tiempo"; }

    document.getElementById('detail-time-in-stage').textContent = `Tiempo en etapa: ${getDaysDifference(p.stage_timestamps[p.etapa] || p.fecha_creacion)} días`;
    renderTracker(p); renderInfo(p); renderLogs(p);
}

function renderFinancials(p) {
    const subtotal = getProjectSubtotal(p);
    const iva = subtotal * 0.13;
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
    
    if(p.ordenes_cambio && p.ordenes_cambio.length > 0) {
        p.ordenes_cambio.forEach(o => {
            let sign = o.tipo === 'aumento' ? '+' : '-';
            let color = o.tipo === 'aumento' ? 'var(--brand-gold)' : 'var(--danger)';
            
            if (ordContainer) {
                ordContainer.innerHTML += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; color:${color}; margin-top:2px;">
                    <span>↳ ${o.desc} 
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
        if(f.pagos) pCobrado = f.pagos.reduce((a,b) => a + parseFloat(b.monto), 0);
        totalCobrado += pCobrado;
        let pSaldo = f.monto - pCobrado;
        
        let isPaid = pSaldo <= 0;
        
        let pHistory = '';
        if(f.pagos && f.pagos.length > 0) {
            pHistory = `<div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.5rem; border-top:1px dashed var(--panel-border); padding-top:0.5rem;">
                <strong>Historial de Pagos de esta factura:</strong><br>` + 
                f.pagos.map((pay, i) => `${formatDate(pay.fecha)} - Abono: ${formatCurrency(pay.monto)} [${pay.metodo || 'N/A'}] ${pay.ref ? `(Ref: ${pay.ref})` : ''} <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="editPayment('${f.id}', ${i})">[Editar]</span> <span class="cursor-pointer" style="margin-left:5px; font-size:0.75rem; color:var(--danger);" onclick="deletePayment('${f.id}', ${i})">[Eliminar]</span>`).join('<br>') + `</div>`;
        }

        listDiv.innerHTML += `
            <div style="background: rgba(0,0,0,0.15); border: 1px solid var(--panel-border); border-radius: 8px; padding: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="font-size:1.1rem; color:white;">${f.numero}</strong> <span class="badge ${isPaid ? 'ganado' : 'activo'} ml-2">${isPaid ? 'PAGADA' : 'PENDIENTE'}</span>
                        <span class="cursor-pointer" style="margin-left:10px; font-size:0.8rem; color:var(--brand-gold);" onclick="editInvoice('${f.id}')">[Editar Factura]</span>
                        ${invoiceIndex > 0 ? `<span class="cursor-pointer" style="margin-left:5px; font-size:0.8rem; color:var(--danger);" onclick="deleteInvoice('${f.id}')">[Eliminar Factura]</span>` : `<span style="margin-left:5px; font-size:0.8rem; color:var(--text-muted);" title="La factura de anticipo no puede ser eliminada">[Eliminar Factura]</span>`}
                        ${f.doc_factura ? `<span style="font-size:0.8rem; color:var(--brand-gold); margin-left:10px;">📄 ${f.doc_factura}</span>` : ''}
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
    document.getElementById('fin-iva').textContent = formatCurrency(iva);
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
    if(!o) return;
    
    document.getElementById('co-id-edit').value = o.id;
    document.getElementById('co-tipo').value = o.tipo;
    document.getElementById('co-desc').value = o.desc;
    document.getElementById('co-precio').value = o.precio;
    document.getElementById('co-costo').value = o.costo;
    document.getElementById('changeOrderModal').style.display = 'block';
}

async function processChangeOrder(e) {
    e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    
    if(!p.ordenes_cambio) p.ordenes_cambio = [];
    
    const editId = document.getElementById('co-id-edit').value;
    const tipo = document.getElementById('co-tipo').value;
    const desc = document.getElementById('co-desc').value.trim();
    const precio = parseFloat(document.getElementById('co-precio').value);
    const costo = parseFloat(document.getElementById('co-costo').value);
    
    const fOferta = document.getElementById('co-oferta');
    const fCostos = document.getElementById('co-costos');
    
    showLoading('Subiendo documentos de la orden de cambio...');
    try {
        let docOferta = null;
        let docCostos = null;
        
        if (fOferta && fOferta.files.length > 0) docOferta = await uploadFileToStorage(fOferta.files[0], 'ordenes_cambio');
        if (fCostos && fCostos.files.length > 0) docCostos = await uploadFileToStorage(fCostos.files[0], 'ordenes_cambio');
        
        if (editId) {
            const idx = p.ordenes_cambio.findIndex(x => x.id === editId);
            if (idx !== -1) {
                p.ordenes_cambio[idx].tipo = tipo;
                p.ordenes_cambio[idx].desc = desc;
                p.ordenes_cambio[idx].precio = precio;
                p.ordenes_cambio[idx].costo = costo;
                if (docOferta) p.ordenes_cambio[idx].doc_oferta = docOferta;
                if (docCostos) p.ordenes_cambio[idx].doc_costos = docCostos;
                
                if (!p.documentos) p.documentos = {};
                if (docOferta) p.documentos['oc_' + editId + '_oferta'] = docOferta;
                if (docCostos) p.documentos['oc_' + editId + '_costos'] = docCostos;
                
                addLogToProspect(p, `Orden de Cambio editada: ${desc}`, true);
            }
        } else {
            const orden = {
                id: Date.now().toString(),
                fecha: new Date().toISOString(),
                tipo: tipo,
                desc: desc,
                precio: precio,
                costo: costo,
                doc_oferta: docOferta,
                doc_costos: docCostos
            };
            p.ordenes_cambio.push(orden);
            let sign = tipo === 'aumento' ? '+' : '-';
            addLogToProspect(p, `Orden de Cambio (${tipo.toUpperCase()}): ${desc}. Monto: ${sign}${formatCurrency(precio)}.`, true);
            
            if (!p.documentos) p.documentos = {};
            if (docOferta) p.documentos['oc_' + orden.id + '_oferta'] = docOferta;
            if (docCostos) p.documentos['oc_' + orden.id + '_costos'] = docCostos;
        }
        
        saveProspectToDB(p);
        closeModal('changeOrderModal');
        renderFinancials(p);
        renderInfo(p);
    } catch(err) {
        alert("Error al guardar la orden de cambio: " + err.message);
    } finally {
        hideLoading();
    }
}

function showInvoiceForm() {
    document.getElementById('invoice-form').style.display = 'block'; document.getElementById('payment-form').style.display = 'none';
    document.getElementById('btn-add-invoice').style.display = 'none';
    document.getElementById('inv-id-edit').value = '';
    document.getElementById('inv-numero').value = ''; document.getElementById('inv-monto').value = ''; document.getElementById('inv-file').value = '';
}

function editInvoice(id) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === id);
    if(!f) return;
    
    document.getElementById('invoice-form').style.display = 'block'; document.getElementById('payment-form').style.display = 'none';
    document.getElementById('btn-add-invoice').style.display = 'none';
    document.getElementById('inv-id-edit').value = f.id;
    document.getElementById('inv-numero').value = f.numero;
    document.getElementById('inv-monto').value = f.monto;
}

async function processInvoice(e) {
    if(e) e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId); 
    const editId = document.getElementById('inv-id-edit').value;
    const n = document.getElementById('inv-numero').value.trim(); const m = parseFloat(document.getElementById('inv-monto').value);
    const fileEl = document.getElementById('inv-file');
    
    if (!n) return alert("Ingrese un número de factura.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto válido mayor a cero.");
    if (!editId && fileEl.files.length === 0) return alert("Debe adjuntar la copia de la factura.");

    if (!p.facturas) p.facturas = [];
    
    const subtotal = getProjectSubtotal(p);
    const totalConIVA = subtotal * 1.13;
    let totalFacturado = p.facturas.reduce((acc, f) => f.id !== editId ? acc + f.monto : acc, 0);
    
    if ((totalFacturado + m) > (totalConIVA + 0.1)) {
        return alert(`Error: El monto a facturar excede el saldo restante del proyecto. Saldo máximo a facturar: ${formatCurrency(totalConIVA - totalFacturado)}`);
    }

    showLoading('Subiendo factura a la nube...');
    try {
        let docName = null;
        if (fileEl.files.length > 0) {
            docName = await uploadFileToStorage(fileEl.files[0], 'facturas');
        }

        if (editId) {
            const idx = p.facturas.findIndex(f => f.id === editId);
            if (idx !== -1) {
                p.facturas[idx].numero = n;
                p.facturas[idx].monto = m;
                if (docName) p.facturas[idx].doc_factura = docName;
                addLogToProspect(p, `Factura editada: ${n} por ${formatCurrency(m)}`, true);
            }
        } else {
            p.facturas.push({ id: Date.now().toString(), numero: n, monto: m, doc_factura: docName, pagos: [], fecha: new Date().toISOString() });
            addLogToProspect(p, `Factura/CCF emitida: ${n} por ${formatCurrency(m)}`, true);
        }
        
        saveProspectToDB(p); document.getElementById('invoice-form').style.display = 'none'; renderFinancials(p); renderLogs(p);
    } catch(err) {
        alert("Error al subir factura: " + err.message);
    } finally {
        hideLoading();
    }
}

function showPaymentForm(invoiceId, invoiceNumero) {
    document.getElementById('payment-form').style.display = 'block'; document.getElementById('invoice-form').style.display = 'none';
    document.getElementById('pay-target-invoice-text').textContent = `Abonando a documento: ${invoiceNumero}`;
    document.getElementById('pay-invoice-id').value = invoiceId;
    document.getElementById('pay-idx-edit').value = '';
    document.getElementById('pay-monto-nuevo').value = ''; document.getElementById('pay-ref').value = '';
}

function editPayment(invoiceId, paymentIndex) {
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p || !p.facturas) return;
    const f = p.facturas.find(x => x.id === invoiceId);
    if(!f || !f.pagos) return;
    const pay = f.pagos[paymentIndex];
    
    document.getElementById('payment-form').style.display = 'block'; document.getElementById('invoice-form').style.display = 'none';
    document.getElementById('pay-target-invoice-text').textContent = `Editando abono en Factura ${f.numero}`;
    document.getElementById('pay-invoice-id').value = invoiceId;
    document.getElementById('pay-idx-edit').value = paymentIndex;
    document.getElementById('pay-monto-nuevo').value = pay.monto;
    document.getElementById('pay-metodo').value = pay.metodo;
    document.getElementById('pay-ref').value = pay.ref;
}

async function processPayment(e) {
    if(e) e.preventDefault();
    const p = prospects.find(x => x.id === currentProspectId); 
    const m = parseFloat(document.getElementById('pay-monto-nuevo').value); 
    const met = document.getElementById('pay-metodo').value;
    const ref = document.getElementById('pay-ref').value.trim();
    const invId = document.getElementById('pay-invoice-id').value;
    const editIdx = document.getElementById('pay-idx-edit').value;
    const fileEl = document.getElementById('pay-file');
    
    if (!editIdx && fileEl && fileEl.files.length === 0) return alert("Debe adjuntar el comprobante de pago.");
    if (isNaN(m) || m <= 0) return alert("Ingrese un monto de pago válido.");

    const fac = p.facturas.find(f => f.id === invId);
    if (!fac) return;

    let yaCobrado = (fac.pagos || []).reduce((acc, pay, i) => i.toString() !== editIdx ? acc + parseFloat(pay.monto) : acc, 0);
    let saldoPendiente = fac.monto - yaCobrado;

    if (m > (saldoPendiente + 0.1)) {
        return alert(`El abono supera el saldo de esta factura. Saldo pendiente: ${formatCurrency(saldoPendiente)}`);
    }

    if(!fac.pagos) fac.pagos = [];
    
    showLoading('Subiendo comprobante de pago...');
    try {
        let docName = null;
        if (fileEl && fileEl.files.length > 0) {
            docName = await uploadFileToStorage(fileEl.files[0], 'pagos');
        }

        if (editIdx !== '') {
            const i = parseInt(editIdx);
            fac.pagos[i].monto = m;
            fac.pagos[i].metodo = met;
            fac.pagos[i].ref = ref;
            if (docName) fac.pagos[i].doc_comprobante = docName;
            addLogToProspect(p, `Abono editado en factura ${fac.numero}: ${formatCurrency(m)} [${met}]`, true);
        } else {
            fac.pagos.push({ monto: m, metodo: met, ref: ref, doc_comprobante: docName, fecha: new Date().toISOString() });
            addLogToProspect(p, `Pago recibido: ${formatCurrency(m)} vía ${met} a cuenta de Factura ${fac.numero}`, true);
        }
        
        saveProspectToDB(p); document.getElementById('payment-form').style.display = 'none'; renderFinancials(p); renderLogs(p);
    } catch(err) {
        alert("Error al subir comprobante de pago: " + err.message);
    } finally {
        hideLoading();
    }
}

function renderTracker(p) {
    const tracker = document.getElementById('stage-tracker'); tracker.innerHTML = ''; const currentIndex = STAGES.indexOf(p.etapa);
    STAGES.forEach((stage, index) => {
        let statusClass = '';
        if (p.estado === 'perdido' && index <= currentIndex) statusClass = 'completed';
        else if (p.estado !== 'perdido') { if (index < currentIndex) statusClass = 'completed'; if (index === currentIndex) statusClass = 'current'; if (p.estado === 'ganado' && stage === 'cierre') statusClass = 'completed'; }
        tracker.innerHTML += `<div class="stage-step ${statusClass}"><div class="stage-circle">${index + 1}</div><div class="stage-label">${stage}</div></div>`;
    });
    document.getElementById('detail-badges').innerHTML = `<span class="badge ${p.estado === 'activo' ? 'activo' : (p.estado === 'ganado' ? 'ganado' : 'perdido')}">${p.estado.toUpperCase()}</span>`;
}

function renderInfo(p) {
    const list = document.getElementById('info-list');
    list.innerHTML = `<li><strong>Creación:</strong> ${new Date(p.fecha_creacion).toLocaleDateString('es-MX')}</li><li><strong>Origen:</strong> ${p.origen}</li><li><strong>Tipo Proy:</strong> ${p.tipo_proyecto}</li><li><strong>Producto:</strong> ${p.tipo_producto}</li>`;
    if (p.datos.ubicacion) {
        list.innerHTML += `<li><span class="label">Ubicación:</span> ${p.datos.ubicacion}</li>`;
        if (p.datos.distancia) list.innerHTML += `<li><span class="label">Distancia a fábrica:</span> ${p.datos.distancia} km</li>`;
    }
    if (p.datos.visitante) list.innerHTML += `<li><strong>Visitó:</strong> ${p.datos.visitante} (${p.datos.fecha_visita})</li>`;
    if (p.datos.fecha_inicio) list.innerHTML += `<li><strong>Est. Inicio:</strong> ${p.datos.fecha_inicio}</li>`;
    if (p.costo_venta) list.innerHTML += `<li><strong>Costo:</strong> ${formatCurrency(p.costo_venta)} <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="openEditBasePriceModal()">[Editar Costo/Precio]</span></li>`;
    if (p.precio_cotizado) list.innerHTML += `<li><strong>Precio:</strong> ${formatCurrency(p.precio_cotizado)} <span class="cursor-pointer" style="margin-left:8px; font-size:0.75rem; color:var(--brand-gold);" onclick="openEditBasePriceModal()">[Editar Costo/Precio]</span></li>`;
    if (p.probabilidad) list.innerHTML += `<li><strong>Probabilidad:</strong> ${p.probabilidad}%</li>`;
    
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
        let name = typeof doc === 'object' ? doc.name : doc;
        let url = typeof doc === 'object' && doc.url ? doc.url : '#';
        
        if (url === '#') {
            return `<a href="#" onclick="alert('El archivo no está en la nube: ${name}'); return false;" style="color:var(--brand-gold)">${name}</a>`;
        } else {
            return `<a href="${url}" target="_blank" style="color:var(--brand-gold)">${name}</a>`;
        }
    }
    
    if (p.datos.doc_levantamiento) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Planos/Notas:</span> <span style="word-break: break-all;">${dlLink(p.datos.doc_levantamiento)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_oferta) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Oferta/Cotiz.:</span> <span style="word-break: break-all;">${dlLink(p.datos.doc_oferta)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_costos) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Cuadro Costos:</span> <span style="word-break: break-all;">${dlLink(p.datos.doc_costos)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_oferta_firmada) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Oferta Firmada:</span> <span style="word-break: break-all;">${dlLink(p.datos.doc_oferta_firmada)}</span></li>`; hasDocs = true; }
    if (p.datos.doc_contrato) { docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Contrato:</span> <span style="word-break: break-all;">${dlLink(p.datos.doc_contrato)}</span></li>`; hasDocs = true; }
    
    if (p.facturas && p.facturas.length > 0) {
        p.facturas.forEach(f => {
            if (f.doc_factura) {
                docsList.innerHTML += `<li><span style="color:var(--text-secondary)">Fac ${f.numero}:</span> <span style="word-break: break-all;">${dlLink(f.doc_factura)}</span></li>`;
                hasDocs = true;
            }
        });
    }
    
    if (!hasDocs) {
        docsList.innerHTML = `<li style="color:var(--text-muted); font-size: 0.85rem;">No hay documentos adjuntos.</li>`;
    }
}

function addLogToProspect(p, text, isAuto = false) { 
    if (!p.logs) p.logs = [];
    const author = currentUser ? currentUser.nombre : 'Sistema';
    p.logs.push({ text: `${isAuto ? '' : '(' + author + ') '} ${text}`, date: new Date().toISOString(), auto: isAuto }); 
}
function addLog() {
    const textEl = document.getElementById('new-log-text'); const text = textEl.value.trim(); if (!text) return;
    let pObj = prospects.find(x => x.id === currentProspectId);
    addLogToProspect(pObj, text, false); saveProspectToDB(pObj); textEl.value = ''; renderLogs(pObj);
}
function renderLogs(p) {
    const cont = document.getElementById('logs-container'); cont.innerHTML = '';
    [...p.logs].reverse().forEach(l => { cont.innerHTML += `<div class="log-item ${l.auto ? 'auto' : ''}"><span class="date">${formatDate(l.date)}</span>${l.text}</div>`; });
}

function showNewProposalForm() {
    const p = prospects.find(x => x.id === currentProspectId); 
    const container = document.getElementById('advance-form-container');
    
    let formHTML = `<h4><span style="color:var(--success)">Registrar Nueva Propuesta</span></h4>
        <div class="form-grid mt-2">
            <div class="form-group"><label>Nuevo Costo (Subtotal)</label><input type="number" id="prop-costo" value="${p.costo_venta||''}" required></div>
            <div class="form-group"><label>Nuevo Precio (Subtotal)</label><input type="number" id="prop-precio" value="${p.precio_cotizado||''}" required></div>
            <div class="form-group full-width"><label>Nueva Oferta (PDF/Word)</label><input type="file" id="prop-file" required></div>
            <div class="form-group full-width"><label>Nuevo Cuadro de Costos (PDF/Excel)</label><input type="file" id="prop-file2" required></div>
        </div>
        <button class="btn-success mt-2" onclick="processNewProposal()">Guardar Propuesta</button>
        <button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>
    `;
    container.innerHTML = formHTML;
}

function processNewProposal() {
    const p = prospects.find(x => x.id === currentProspectId); 
    const c = parseFloat(document.getElementById('prop-costo').value); 
    const pr = parseFloat(document.getElementById('prop-precio').value); 
    if(isNaN(c) || isNaN(pr)) return alert("Completa costos y precios.");
    
    const f1 = document.getElementById('prop-file');
    const f2 = document.getElementById('prop-file2');
    if(!f1 || f1.files.length === 0 || !f2 || f2.files.length === 0) return alert("Debe subir la nueva oferta y el cuadro de costos.");
    
    p.costo_venta = c; p.precio_cotizado = pr;
    p.datos.doc_oferta = f1.files[0].name;
    p.datos.doc_costos = f2.files[0].name;
    
    addLogToProspect(p, `NUEVA PROPUESTA: Precio ${formatCurrency(pr)}, Costo ${formatCurrency(c)}. Docs: ${p.datos.doc_oferta}, ${p.datos.doc_costos}`, true);
    saveProspectToDB(p);
    openDetail(p.id);
}

// Google Maps auto-script removed per user request

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
        if(!visOpts) visOpts = `<option value="">-- Sin visitantes (Configure en ajustes) --</option>`;
        
        let mapLink = "https://maps.google.com";
        if (settings.factory_address) mapLink += `?q=${encodeURIComponent(settings.factory_address)}`;

        formHTML += `<div class="form-group full-width"><label>Ubicación del Proyecto</label><input type="text" id="adv-ubicacion" required placeholder="Ej. Calle Principal #123"></div>
            <div class="form-group"><label>Distancia a Fábrica (km) <a href="${mapLink}" target="_blank" style="color:var(--brand-gold); font-size: 0.8rem; margin-left: 5px;">[Abrir Mapa]</a></label><input type="number" step="0.1" id="adv-distancia" required></div>
            <div class="form-group"><label>Quién visitó</label><select id="adv-visitante" required><option value="">-- Seleccione --</option>${visOpts}</select></div><div class="form-group"><label>Fecha de visita</label><input type="date" id="adv-fecha" required></div><div class="form-group"><label>Fecha est. inicio</label><input type="date" id="adv-inicio" required></div><div class="form-group"><label>Notas/Planos</label><input type="file" id="adv-file"></div>`;
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        let isNeg = nextStage === 'negociacion';
        let selAlta = p.probabilidad === 75 ? 'selected' : ''; let selMedia = p.probabilidad === 50 ? 'selected' : ''; let selBaja = p.probabilidad === 25 ? 'selected' : ''; let selImprobable = p.probabilidad === 10 ? 'selected' : '';
        formHTML += `<div class="form-group"><label>Costo de Venta (Subtotal)</label><input type="number" id="adv-costo" value="${p.costo_venta||''}" required></div>
            <div class="form-group"><label>Precio Cotizado (Subtotal)</label><input type="number" id="adv-precio" value="${p.precio_cotizado||''}" required></div>
            <div class="form-group"><label>Probabilidad</label><select id="adv-prob" required>
                    <option value="alta" ${selAlta}>Alta (75%)</option><option value="media" ${selMedia}>Media (50%)</option><option value="baja" ${selBaja}>Baja (25%)</option><option value="improbable" ${selImprobable}>Improbable (10%)</option>
                </select></div>
            <div class="form-group full-width"><label>Oferta (PDF/Word)</label><input type="file" id="adv-file" ${isNeg?'':'required'}></div>
            <div class="form-group full-width"><label>Cuadro de Costos (PDF/Excel)</label><input type="file" id="adv-file2" ${isNeg?'':'required'}></div>`;
    } else if (nextStage === 'cierre') {
        const c = clients.find(x => x.id === p.clientId);
        if(!c.documentos) c.documentos = {};

        const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (p.precio_cotizado || 0) > 10000);
        
        let encOpts = settings.encargados.map(e => `<option value="${e}">${e}</option>`).join('');
        if(!encOpts) encOpts = `<option value="">-- Sin encargados (Configure en ajustes) --</option>`;
        
        formHTML += `<div class="form-group full-width" style="border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem; margin-bottom: 0.5rem;"><strong>Configuración de Proyecto</strong></div>`;
        formHTML += `<div class="form-group"><label>Forma de Pago Pactada</label>
                <select id="adv-forma-pago" required><option value="100% anticipado">100% Anticipado</option><option value="70/30">70% Anticipo / 30% Cierre</option><option value="50/50">50% Anticipo / 50% Cierre</option></select></div>`;
        formHTML += `<div class="form-group"><label>Número Factura de Anticipo</label><input type="text" id="adv-fac-anticipo" required placeholder="Ej. FCF-001"></div>`;
        if (p.tipo_proyecto === 'Fabricación e instalación') { formHTML += `<div class="form-group"><label>Encargado de Instalación</label><select id="adv-encargado" required><option value="">-- Seleccione --</option>${encOpts}</select></div>`; }
        
        formHTML += `<div class="form-group full-width" style="border-bottom: 1px solid var(--panel-border); padding-bottom: 0.5rem; margin-top: 1rem; margin-bottom: 0.5rem; color:var(--brand-gold);"><strong>Documentación Requerida para Cierre</strong></div>`;
        
        if (isBigInstalacion) {
            formHTML += `<div class="form-group full-width"><button type="button" class="btn-primary" onclick="generarContrato('${p.id}')">📄 Generar Contrato (Imprimible)</button><p style="font-size:0.75rem; color:var(--text-secondary); margin-top:4px;">Haz clic aquí para imprimir el contrato ya rellenado. Luego, escanéalo firmado y súbelo a continuación.</p></div>`;
            formHTML += `<div class="form-group full-width"><label>Contrato Firmado (Proyecto > $10k)</label><input type="file" id="adv-file1" required></div>`;
            
            // Validate Client Docs in Directory
            if (c.tipo === 'juridica') {
                if(!c.documentos.escritura || !c.documentos.credencial || !c.documentos.nit || !c.documentos.nrc || !c.documentos.dui) {
                    formHTML += `<div class="form-group full-width" style="color:var(--danger); font-size:0.9rem;">⚠️ Advertencia: Faltan documentos legales de la Empresa en el Directorio de Clientes.</div>`;
                } else {
                    formHTML += `<div class="form-group full-width" style="color:var(--success); font-size:0.9rem;">✔️ Documentación legal de la empresa ya registrada en el directorio.</div>`;
                }
            } else {
                if(!c.documentos.dui) {
                    formHTML += `<div class="form-group full-width" style="color:var(--danger); font-size:0.9rem;">⚠️ Advertencia: No has anexado el DUI de este cliente en el Directorio.</div>`;
                }
            }
        } else {
            formHTML += `<div class="form-group full-width"><label>Oferta Firmada por Cliente</label><input type="file" id="adv-file1" required></div>`;
        }
        formHTML += `<div class="form-group full-width"><label>Copia de Factura / C.F. Emitida</label><input type="file" id="adv-file2" required></div>`;
    }
    formHTML += `</div><button type="button" class="btn-primary mt-2" onclick="processAdvance('${nextStage}')">Confirmar Avance</button><button type="button" class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button>`;
    container.innerHTML = formHTML;
}

async function processAdvance(nextStage) {
    const p = prospects.find(x => x.id === currentProspectId); 
    const author = currentUser ? currentUser.nombre : 'Sistema';
    let logMsg = `Avanzó a etapa: ${nextStage}.`;

    if (nextStage === 'levantamiento') {
        const dF = document.getElementById('adv-fecha').value; const dI = document.getElementById('adv-inicio').value;
        const u = document.getElementById('adv-ubicacion').value.trim(); const v = document.getElementById('adv-visitante').value.trim();
        const dist = document.getElementById('adv-distancia').value;
        if(!dF || !dI || !u || !v || !dist) return alert("Completa los campos.");
        showLoading('Subiendo documentos de levantamiento...');
        try {
            p.datos.ubicacion = u; p.datos.distancia = dist; p.datos.visitante = v; p.datos.fecha_visita = dF; p.datos.fecha_inicio = dI;
            const f = document.getElementById('adv-file'); 
            if(f && f.files.length > 0) p.datos.doc_levantamiento = await uploadFileToStorage(f.files[0], 'proyectos');
        } catch(e) {
            hideLoading();
            return alert("Error al subir archivo: " + e.message);
        }
        hideLoading();
    } else if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
        const c = parseFloat(document.getElementById('adv-costo').value); const pr = parseFloat(document.getElementById('adv-precio').value); const prob = document.getElementById('adv-prob').value;
        if(isNaN(c) || isNaN(pr) || !prob) return alert("Completa costos, precios y probabilidad.");
        
        const f = document.getElementById('adv-file'); 
        const f2 = document.getElementById('adv-file2'); 
        
        if (nextStage === 'cotizacion' || nextStage === 'negociacion') {
            const hasOferta = (f && f.files.length > 0) || (p.datos && p.datos.doc_oferta);
            const hasCostos = (f2 && f2.files.length > 0) || (p.datos && p.datos.doc_costos);
            if (!hasOferta || !hasCostos) {
                return alert("Es obligatorio adjuntar tanto la Oferta como el Cuadro de Costos.");
            }
        }
        
        showLoading('Subiendo cotizaciones y costos...');
        try {
            p.costo_venta = c; p.precio_cotizado = pr;
            p.probabilidad = prob==='alta'?75:prob==='media'?50:prob==='baja'?25:10;
            if(f && f.files.length > 0) p.datos.doc_oferta = await uploadFileToStorage(f.files[0], 'proyectos');
            if(f2 && f2.files.length > 0) p.datos.doc_costos = await uploadFileToStorage(f2.files[0], 'proyectos');
            logMsg += ` (Cotizado: ${formatCurrency(pr)}, Costo: ${formatCurrency(c)})`;
        } catch(e) {
            hideLoading();
            return alert("Error al subir archivo: " + e.message);
        }
        hideLoading();
    } else if (nextStage === 'cierre') {
        const fp = document.getElementById('adv-forma-pago').value; if(!fp) return alert("Selecciona la forma de pago."); p.forma_pago = fp;
        const facNum = document.getElementById('adv-fac-anticipo').value.trim(); if(!facNum) return alert("Ingresa el número de factura de anticipo.");
        if (p.tipo_proyecto === 'Fabricación e instalación') { const enc = document.getElementById('adv-encargado').value.trim(); if(!enc) return alert("Debe asignar un Encargado de Instalación."); p.encargado = enc; logMsg += ` (Encargado: ${enc})`; }
        
        const isBigInstalacion = (p.tipo_proyecto === 'Fabricación e instalación' && (p.precio_cotizado || 0) > 10000);
        const c = clients.find(x => x.id === p.clientId);
        if(!c.documentos) c.documentos = {};

        const f1 = document.getElementById('adv-file1'); 
        if(!f1 || f1.files.length === 0) return alert("Es obligatorio subir el Contrato o la Oferta firmada.");
        
        const f2 = document.getElementById('adv-file2'); 
        if(!f2 || f2.files.length === 0) return alert("Es obligatorio subir la Factura o Comprobante de anticipo.");
        
        showLoading('Generando cierre y subiendo documentos finales...');
        try {
            if (isBigInstalacion) p.datos.doc_contrato = await uploadFileToStorage(f1.files[0], 'proyectos');
            else p.datos.doc_oferta_firmada = await uploadFileToStorage(f1.files[0], 'proyectos');
            
            p.datos.doc_comprobante = await uploadFileToStorage(f2.files[0], 'facturas');
            
            p.estado = 'ganado'; p.probabilidad = 100; p.fecha_cierre = new Date().toISOString(); 
        } catch(e) {
            hideLoading();
            return alert("Error al subir archivo de cierre: " + e.message);
        }
        hideLoading();
        
        p.facturas = [];
        const subtotal = p.precio_cotizado || 0;
        const totalConIVA = subtotal * 1.13;
        let expectedPercentage = 0;
        if (fp === '70/30') expectedPercentage = 0.70;
        else if (fp === '50/50') expectedPercentage = 0.50;
        else if (fp === '100% anticipado') expectedPercentage = 1.0;
        const advanceAmount = totalConIVA * expectedPercentage;
        
        p.facturas.push({ 
            id: Date.now().toString(), 
            numero: facNum, 
            monto: advanceAmount, 
            doc_factura: p.datos.doc_comprobante || '',
            pagos: [], 
            fecha: new Date().toISOString() 
        });

        logMsg = `¡VENTA CERRADA! Proyecto ${p.codigo || ''} generado con factura PENDIENTE ${facNum} por ${formatCurrency(advanceAmount)}`;
    }

    p.etapa = nextStage; p.stage_timestamps[nextStage] = new Date().toISOString();
    addLogToProspect(p, logMsg, true); saveProspectToDB(p); document.getElementById('advance-form-container').innerHTML = ''; openDetail(p.id); 
}

function showLoseForm() {
    let opts = MOTIVOS_PERDIDA.map(m => `<option value="${m}">${m}</option>`).join('');
    document.getElementById('advance-form-container').innerHTML = `<div class="form-group mt-4"><label style="color:var(--danger)">Motivo de pérdida</label><select id="lose-reason" required><option value="">-- Selecciona --</option>${opts}</select><button class="btn-danger mt-2" onclick="processLose()">Confirmar Pérdida</button><button class="btn-secondary mt-2 ml-2" onclick="document.getElementById('advance-form-container').innerHTML=''">Cancelar</button></div>`;
}
function processLose() {
    const reason = document.getElementById('lose-reason').value; if(!reason) return alert("Debes seleccionar un motivo.");
    const p = prospects.find(x => x.id === currentProspectId); p.estado = 'perdido'; p.motivo_perdida = reason; p.fecha_perdida = new Date().toISOString();
    addLogToProspect(p, `Marcado como PERDIDO. Motivo: ${reason}`, true); saveProspectToDB(p); document.getElementById('advance-form-container').innerHTML = ''; openDetail(p.id);
}

// ========================
// DASHBOARD
// ========================

function populateTimeFilter() {
    const select = document.getElementById('dash-time-filter'); select.innerHTML = '<option value="all">Histórico Completo</option>';
    const now = new Date(); const currentYear = now.getFullYear(); const currentMonth = now.getMonth();
    select.innerHTML += `<option value="year_${currentYear}">Acumulado Año ${currentYear}</option>`;
    for(let i = 0; i <= currentMonth; i++) { select.innerHTML += `<option value="${currentYear}-${i}">${MESES[i]} ${currentYear}</option>`; }
}
function getFilteredProspects() {
    const filter = document.getElementById('dash-time-filter').value;
    return prospects.filter(p => {
        let refDateStr = p.estado === 'ganado' ? p.fecha_cierre : (p.estado === 'perdido' ? p.fecha_perdida : p.fecha_creacion);
        if(!refDateStr) return false;
        let d = new Date(refDateStr); let y = d.getFullYear(); let m = d.getMonth();
        if (filter === 'all') return true;
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
    
    db.collection(`audit_logs${DB_SUFFIX}`).orderBy('timestamp', 'desc').limit(20).onSnapshot(snap => {
        container.innerHTML = '';
        if(snap.empty) {
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

        tbody.innerHTML += `<tr><td>${p.codigo || p.id.substring(p.id.length-4)}</td><td>${getClientName(p.clientId)}</td><td>${p.proyecto}</td><td style="text-transform: capitalize;">${p.etapa}</td><td><span style="${daysColor}">${alertIcon}${days} días</span> <small style="color:var(--text-muted); margin-left:4px;">(Max ${limit})</small></td></tr>`;
    });
}

function renderCharts(filtered) {
    Chart.defaults.color = '#a0aabf'; const gold = '#ffcc4d', blue = '#3b476e', success = '#10b981', danger = '#ef4444', accent1 = '#8b5cf6', accent2 = '#f97316';
    const active = filtered.filter(p => p.estado === 'activo');
    
    Chart.defaults.plugins.tooltip.callbacks.label = function(context) {
        let label = context.label || '';
        if (label) label += ': ';
        if (context.parsed !== null) {
            let total = context.dataset.data.reduce((a,b)=>a+b,0);
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
    const sumMonto = (arr) => arr.reduce((acc, p) => acc + (p.precio_cotizado || 0), 0);
    
    const prodW = [sumMonto(won.filter(p => p.tipo_producto==='Chute')), sumMonto(won.filter(p => p.tipo_producto==='Ducto'))];
    const prodWColors = [gold, blue];
    const prodWNo = sumMonto(won.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    if(prodWNo > 0) { prodW.push(prodWNo); prodWColors.push('#6b7280'); }
    if(chartProduct) chartProduct.destroy(); chartProduct = new Chart(document.getElementById('productChart').getContext('2d'), { type: 'pie', data: { labels: prodWNo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodW, backgroundColor: prodWColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });
    
    const projW = [sumMonto(won.filter(p => p.tipo_proyecto==='Fabricación e instalación')), sumMonto(won.filter(p => p.tipo_proyecto==='Fabricación'))];
    const projWColors = [success, '#a0aabf'];
    const projWNo = sumMonto(won.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    if(projWNo > 0) { projW.push(projWNo); projWColors.push('#6b7280'); }
    if(chartProject) chartProject.destroy(); chartProject = new Chart(document.getElementById('projectChart').getContext('2d'), { type: 'pie', data: { labels: projWNo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projW, backgroundColor: projWColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });
    
    const prodA = [sumMonto(active.filter(p => p.tipo_producto==='Chute')), sumMonto(active.filter(p => p.tipo_producto==='Ducto'))];
    const prodANo = sumMonto(active.filter(p => p.tipo_producto !== 'Chute' && p.tipo_producto !== 'Ducto'));
    const prodAColors = [gold, blue];
    if(prodANo > 0) { prodA.push(prodANo); prodAColors.push('#6b7280'); }
    if(chartOppProduct) chartOppProduct.destroy(); chartOppProduct = new Chart(document.getElementById('oppProductChart').getContext('2d'), { type: 'pie', data: { labels: prodANo > 0 ? ['Chute', 'Ducto', 'Sin Asignar'] : ['Chute', 'Ducto'], datasets: [{ data: prodA, backgroundColor: prodAColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });
    
    const projA = [sumMonto(active.filter(p => p.tipo_proyecto==='Fabricación e instalación')), sumMonto(active.filter(p => p.tipo_proyecto==='Fabricación'))];
    const projANo = sumMonto(active.filter(p => p.tipo_proyecto !== 'Fabricación e instalación' && p.tipo_proyecto !== 'Fabricación'));
    const projAColors = [accent1, accent2];
    if(projANo > 0) { projA.push(projANo); projAColors.push('#6b7280'); }
    if(chartOppProject) chartOppProject.destroy(); chartOppProject = new Chart(document.getElementById('oppProjectChart').getContext('2d'), { type: 'pie', data: { labels: projANo > 0 ? ['Fab e Inst.', 'Fab.', 'Sin Asignar'] : ['Fab e Inst.', 'Fab.'], datasets: [{ data: projA, backgroundColor: projAColors, borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.raw); } } } } } });
    
    const origins = ["Prospección del vendedor", "Llamada telefónica", "WhatsApp", "Página web", "Correo", "Redes Sociales", "Ya es cliente"]; if(chartOrigin) chartOrigin.destroy(); chartOrigin = new Chart(document.getElementById('originChart').getContext('2d'), { type: 'pie', data: { labels: origins, datasets: [{ data: origins.map(o => filtered.filter(p => p.origen === o).length), backgroundColor: [blue, gold, success, danger, accent1, accent2, '#14b8a6'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels:{boxWidth:12, font:{size:10}} } } } });
    const lost = filtered.filter(p => p.estado === 'perdido'); if(chartLoss) chartLoss.destroy(); chartLoss = new Chart(document.getElementById('lossChart').getContext('2d'), { type: 'pie', data: { labels: MOTIVOS_PERDIDA, datasets: [{ data: MOTIVOS_PERDIDA.map(m => lost.filter(p => p.motivo_perdida === m).length), backgroundColor: [danger, '#f59e0b', accent2, accent1, '#6b7280'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels:{boxWidth:12, font:{size:10}} } } } });
}

function generarContrato(prospectId) {
    try {
        const p = prospects.find(x => x.id === prospectId);
        const c = clients.find(x => x.id === p.clientId);
        
        if (!p || !c) return alert("Error: Cliente o Proyecto no encontrado.");

        let missing = [];
        let clauseNosotros = "";
        let nombreContrato = "";

        if(c.tipo === 'juridica') {
            if(!c.empresa) missing.push("Nombre de Empresa");
            if(!c.rep_legal) missing.push("Nombre del Representante Legal");
            if(!c.profesion_rep) missing.push("Profesión del Representante");
            if(!c.domicilio_rep) missing.push("Domicilio del Representante");
            if(!c.dui_rep) missing.push("DUI del Representante");
            if(!c.nit_rep) missing.push("NIT del Representante");
            
            nombreContrato = c.empresa;
            clauseNosotros = `y por otra parte <span class="bold">${c.empresa}</span>, que para efectos de este instrumento se denominará EL CLIENTE, representada por <span class="bold">${c.rep_legal}</span>, mayor de edad, <span class="bold">${c.profesion_rep || ''}</span>, del domicilio de <span class="bold">${c.domicilio_rep || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui_rep || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit_rep || ''}</span>.`;
        } else {
            if(!c.nombres || !c.apellidos) missing.push("Nombres/Apellidos");
            if(!c.profesion) missing.push("Profesión");
            if(!c.domicilio) missing.push("Domicilio");
            if(!c.dui) missing.push("DUI");
            if(!c.nit) missing.push("NIT");
            
            nombreContrato = `${c.nombres || ''} ${c.apellidos || ''}`;
            clauseNosotros = `y por otra parte <span class="bold">${nombreContrato}</span>, que para efectos de este instrumento se denominará EL CLIENTE, mayor de edad, <span class="bold">${c.profesion || ''}</span>, del domicilio de <span class="bold">${c.domicilio || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit || ''}</span>.`;
        }

        if(missing.length > 0) {
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
        
    } catch(e) {
        alert("Ocurrió un error al generar el contrato: " + e.message);
    }
}

function reportToManager(p, itemType, itemDetail) {
    if (!currentUser) return;
    
    try {
        db.collection(`audit_logs${DB_SUFFIX}`).add({
            fecha: new Date().toISOString(),
            usuario: currentUser.email || 'desconocido',
            proyectoId: p.id || 'N/A',
            proyectoNombre: getClientName(p.clientId) || 'Desconocido',
            item: itemType || 'Desconocido',
            detalle: itemDetail || '',
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(e => console.error("Error auditing", e));
    } catch (e) {
        console.error("Error in reportToManager:", e);
    }
}

// ========================
// EDIT & DELETE FINANCIALS
// ========================
function openEditBasePriceModal() {
    const p = prospects.find(x => x.id === currentProspectId);
    if(!p) return;
    document.getElementById('eb-precio').value = p.precio_cotizado || 0;
    document.getElementById('eb-costo').value = p.costo_venta || 0;
    document.getElementById('eb-motivo').value = '';
    document.getElementById('editBasePriceModal').style.display = 'block';
}

function processEditBasePrice(e) {
    e.preventDefault();
    try {
        const p = prospects.find(x => x.id === currentProspectId);
        if(!p) return;
        const oldP = p.precio_cotizado || 0;
        const oldC = p.costo_venta || 0;
        
        p.precio_cotizado = parseFloat(document.getElementById('eb-precio').value);
        p.costo_venta = parseFloat(document.getElementById('eb-costo').value);
        const motivo = document.getElementById('eb-motivo').value;
        
        addLogToProspect(p, `Corrección de sistema: Precio original modificado de ${formatCurrency(oldP)} a ${formatCurrency(p.precio_cotizado)} y Costo de ${formatCurrency(oldC)} a ${formatCurrency(p.costo_venta)}. Motivo: ${motivo}`, true);
        saveProspectToDB(p);
        closeModal('editBasePriceModal');
        renderFinancials(p);
        renderInfo(p);
    } catch(err) {
        alert("Ocurrió un error al guardar los cambios: " + err.message);
    }
}

function deleteChangeOrder(id) {
    if(!confirm("¿Estás seguro de eliminar esta orden de cambio?")) return;
    try {
        const p = prospects.find(x => x.id === currentProspectId);
        if(!p || !p.ordenes_cambio) return;
        const idx = p.ordenes_cambio.findIndex(o => o.id === id);
        if(idx === -1) return;
        const o = p.ordenes_cambio[idx];
        
        p.ordenes_cambio.splice(idx, 1);
        addLogToProspect(p, `Orden de Cambio eliminada: ${o.desc} (${formatCurrency(o.precio)})`, true);
        reportToManager(p, 'Orden de Cambio', `${o.desc} (${formatCurrency(o.precio)})`);
        saveProspectToDB(p);
        renderFinancials(p);
        renderInfo(p);
    } catch(err) {
        alert("Ocurrió un error al eliminar: " + err.message);
    }
}

function deleteInvoice(id) {
    if(!confirm("¿Estás seguro de eliminar esta factura? Todo su historial de pagos se borrará también.")) return;
    try {
        const p = prospects.find(x => x.id === currentProspectId);
        if(!p || !p.facturas) return;
        const idx = p.facturas.findIndex(f => f.id === id);
        if(idx === -1) return;
        if(idx === 0) {
            alert("Por políticas del sistema, la factura de anticipo (la primera) no puede ser eliminada. Puedes editarla si existe algún error.");
            return;
        }
        const f = p.facturas[idx];
        
        p.facturas.splice(idx, 1);
        addLogToProspect(p, `Factura eliminada: ${f.numero} (${formatCurrency(f.monto)})`, true);
        reportToManager(p, 'Factura', `${f.numero} (${formatCurrency(f.monto)})`);
        saveProspectToDB(p);
        renderFinancials(p);
        renderInfo(p);
    } catch(err) {
        alert("Ocurrió un error al eliminar: " + err.message);
    }
}

function deletePayment(invoiceId, paymentIndex) {
    if(!confirm("¿Estás seguro de eliminar este abono?")) return;
    try {
        const p = prospects.find(x => x.id === currentProspectId);
        if(!p || !p.facturas) return;
        const f = p.facturas.find(x => x.id === invoiceId);
        if(!f || !f.pagos) return;
        
        const pay = f.pagos[paymentIndex];
        f.pagos.splice(paymentIndex, 1);
        addLogToProspect(p, `Abono eliminado de factura ${f.numero}: ${formatCurrency(pay.monto)}`, true);
        reportToManager(p, 'Abono', `${formatCurrency(pay.monto)} de la factura ${f.numero}`);
        saveProspectToDB(p);
        renderFinancials(p);
        renderInfo(p);
    } catch(err) {
        alert("Ocurrió un error al eliminar: " + err.message);
    }
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

    try {
        db.collection(`clients${DB_SUFFIX}`).doc(id).delete();
        db.collection(`audit_logs${DB_SUFFIX}`).add({
            timestamp: new Date().toISOString(),
            usuario: currentUser.nombre,
            tipo_item: 'Cliente',
            cliente_nombre: c.nombres || c.empresa || id,
            proyecto_desc: 'N/A',
            detalle_eliminado: `Cliente eliminado por completo`
        });
        alert("Cliente eliminado exitosamente.");
    } catch (e) {
        alert("Error al eliminar cliente: " + e.message);
    }
}

function deleteProspect() {
    if (!currentProspectId) return;
    if (!currentUser || currentUser.role !== 'manager') return alert("Permiso denegado.");
    
    const p = prospects.find(x => x.id === currentProspectId);
    if (!p) return;
    const c = clients.find(x => x.id === p.clientId);

    if (!confirm(`¿Estás EXTREMADAMENTE SEGURO de que deseas eliminar por completo el proyecto "${p.proyecto}"?\n\nSE BORRARÁ TODO (Historial, Facturas, Abonos, Archivos referenciados).\nEsta acción NO se puede deshacer.`)) return;

    try {
        db.collection(`prospects${DB_SUFFIX}`).doc(p.id).delete();
        db.collection(`audit_logs${DB_SUFFIX}`).add({
            timestamp: new Date().toISOString(),
            usuario: currentUser.nombre,
            tipo_item: 'Proyecto',
            cliente_nombre: c ? (c.nombres || c.empresa || c.id) : 'Desconocido',
            proyecto_desc: p.proyecto,
            detalle_eliminado: `Proyecto completo (${p.codigo || p.id}) eliminado`
        });
        alert("Proyecto eliminado exitosamente.");
        goBackFromDetail();
    } catch (e) {
        alert("Error al eliminar proyecto: " + e.message);
    }
}
