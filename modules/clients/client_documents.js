// ============================================================================
// DUCTSAL ERP — CLIENTS MODULE: DIGITAL DOSSIER & DOCUMENTS (Fase 6.2)
// Archivo: modules/clients/client_documents.js
// Responsabilidad:
// 1. Renderizado interactivo del expediente digital del cliente (renderClientExpedienteSection).
// 2. Detección de archivos pendientes de subida en el formulario (hasStagedClientFiles).
// 3. Subida autorizada a Firebase Storage jerárquico bajo carpeta clientes/ (uploadClientStagedFiles).
// 4. Eliminación de documentos del expediente exclusiva para Gerente (deleteClientDocument).
// 5. Carga y sustitución contextual versionada desde el panel de cierre de oportunidad (uploadClientDocumentFromClosing).
// 6. Formularios interactivos de justificación y cancelación de sustitución de documentos.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.ClientDocuments = api;
        // Compatibilidad global con window
        if (typeof window !== 'undefined') {
            window.ClientDocuments = api;
            window.renderClientExpedienteSection = api.renderClientExpedienteSection;
            window.hasStagedClientFiles = api.hasStagedClientFiles;
            window.uploadClientStagedFiles = api.uploadClientStagedFiles;
            window.deleteClientDocument = api.deleteClientDocument;
            window.uploadClientDocumentFromClosing = api.uploadClientDocumentFromClosing;
            window.toggleClientDocSubstForm = api.toggleClientDocSubstForm;
            window.cancelClientDocSubstForm = api.cancelClientDocSubstForm;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getCurrentUser: () => {
            if (typeof currentUser !== 'undefined') return currentUser;
            if (typeof window !== 'undefined' && window.currentUser) return window.currentUser;
            return null;
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
        },
        getDbSuffix: () => (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : (typeof window !== 'undefined' && window.DB_SUFFIX ? window.DB_SUFFIX : '_prod')),
        getStoragePrefix: () => (typeof STORAGE_PREFIX !== 'undefined' ? STORAGE_PREFIX : (typeof window !== 'undefined' && window.STORAGE_PREFIX ? window.STORAGE_PREFIX : 'prod_files')),
        getFirebase: () => (typeof firebase !== 'undefined' ? firebase : (typeof window !== 'undefined' && window.firebase ? window.firebase : null)),
        getCrmClients: () => (typeof CrmClients !== 'undefined' ? CrmClients : (typeof window !== 'undefined' && window.CrmClients ? window.CrmClients : null)),
        getDocumentViewer: () => (typeof DocumentViewer !== 'undefined' ? DocumentViewer : (typeof window !== 'undefined' && window.DocumentViewer ? window.DocumentViewer : null)),
        uploadFileToStorage: async (file, folder, options) => {
            if (typeof uploadFileToStorage === 'function') return uploadFileToStorage(file, folder, options);
            if (typeof window !== 'undefined' && typeof window.uploadFileToStorage === 'function') {
                return window.uploadFileToStorage(file, folder, options);
            }
            throw new Error('uploadFileToStorage no disponible en el entorno');
        },
        getDocStore: () => {
            if (typeof getDocStore === 'function') return getDocStore();
            if (typeof window !== 'undefined' && typeof window.getDocStore === 'function') return window.getDocStore();
            if (typeof window !== 'undefined' && window._docStore) return window._docStore;
            return new Map();
        },
        formatClientDocLabel: (docKey) => {
            if (typeof formatClientDocLabel === 'function') return formatClientDocLabel(docKey);
            if (typeof window !== 'undefined' && typeof window.formatClientDocLabel === 'function') return window.formatClientDocLabel(docKey);
            return String(docKey || 'Documento');
        },
        escapeHtmlDoc: (str) => {
            if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
            return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        },
        isFormatPreviewable: (fileName) => {
            if (typeof isFormatPreviewable === 'function') return isFormatPreviewable(fileName);
            if (typeof window !== 'undefined' && typeof window.isFormatPreviewable === 'function') return window.isFormatPreviewable(fileName);
            return true;
        },
        openClientModal: (clientId) => {
            if (typeof openClientModal === 'function') return openClientModal(clientId);
            if (typeof window !== 'undefined' && typeof window.openClientModal === 'function') return window.openClientModal(clientId);
        },
        renderClientsTable: () => {
            if (typeof renderClientsTable === 'function') return renderClientsTable();
            if (typeof window !== 'undefined' && typeof window.renderClientsTable === 'function') return window.renderClientsTable();
        },
        renderClosingDocumentationPanel: (p) => {
            if (typeof renderClosingDocumentationPanel === 'function') return renderClosingDocumentationPanel(p);
            if (typeof window !== 'undefined' && typeof window.renderClosingDocumentationPanel === 'function') return window.renderClosingDocumentationPanel(p);
        },
        showLoading: (msg) => {
            if (typeof showLoading === 'function') return showLoading(msg);
            if (typeof window !== 'undefined' && typeof window.showLoading === 'function') return window.showLoading(msg);
        },
        hideLoading: () => {
            if (typeof hideLoading === 'function') return hideLoading();
            if (typeof window !== 'undefined' && typeof window.hideLoading === 'function') return window.hideLoading();
        },
        alert: (msg) => {
            if (typeof alert === 'function') return alert(msg);
            if (typeof window !== 'undefined' && typeof window.alert === 'function') return window.alert(msg);
            console.warn('[ClientDocuments Alert]', msg);
        },
        confirm: (msg) => {
            if (typeof confirm === 'function') return confirm(msg);
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(msg);
            return true;
        }
    };

    /**
     * Inicializa o actualiza dependencias del módulo de documentos de clientes.
     */
    function initClientDocuments(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const k of Object.keys(customDeps)) {
                if (typeof customDeps[k] === 'function') {
                    _deps[k] = customDeps[k];
                } else {
                    _deps[k] = () => customDeps[k];
                }
            }
        }
        return ClientDocuments;
    }

    // -------------------------------------------------------------------------
    // 2. Expediente Digital del Cliente
    // -------------------------------------------------------------------------
    function renderClientExpedienteSection(c) {
        if (typeof document === 'undefined') return;
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
            const lbl = _deps.formatClientDocLabel(k);
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

        const currentUser = _deps.getCurrentUser();
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
            const store = _deps.getDocStore();
            if (store && typeof store.set === 'function') {
                store.set(storeId, {
                    docRef: item.docRef,
                    fileName: fileName,
                    label: item.label,
                    clientId: c.id,
                    docKey: item.key,
                    itemIndex: item.index
                });
            }

            const ext = String(fileName).split('.').pop().toUpperCase() || 'DOC';
            let icon = '📁';
            if (ext === 'XLSX' || ext === 'XLS') icon = '📊';
            else if (['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].includes(ext)) icon = '🖼️';
            else if (ext === 'PDF') icon = '📄';

            const previewable = _deps.isFormatPreviewable(fileName);
            const safeName = _deps.escapeHtmlDoc(fileName);
            const safeLabel = _deps.escapeHtmlDoc(item.label);

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
                        <span class="badge" style="background:rgba(255,255,255,0.06); color:var(--text-muted); font-size:0.65rem; border:1px solid rgba(255,255,255,0.1);">${_deps.escapeHtmlDoc(ext)}</span>
                        ${viewBtn}
                        ${dlBtn}
                        ${delBtn}
                    </div>
                </div>
            `;
        }).join('');

        if (c.tipo === 'juridica') {
            const rl = c.representanteLegalVigente || null;
            const powers = Array.isArray(c.apoderadosVigentes) ? c.apoderadosVigentes : [];
            const b3Html = `
                <div style="margin-top: 1rem; border-top: 1px solid var(--panel-border); padding-top: 0.75rem;">
                    <!-- Representante Legal -->
                    <div style="background:rgba(15,23,42,0.5); border:1px solid var(--panel-border); border-radius:6px; padding:10px; margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <div style="font-weight:700; font-size:0.82rem; color:white; display:flex; align-items:center; gap:6px;">
                                <span>⚖️</span> Representante Legal Vigente
                            </div>
                            <button type="button" class="btn-secondary" style="font-size:0.72rem; padding:2px 8px; border-color:#ef4444; color:#f87171;" onclick="ClientDocuments.openRLElectionModal('${c.id}')">
                                ➕ Nueva Elección
                            </button>
                        </div>
                        ${rl && rl.estado === 'vigente' ? `
                            <div style="font-size:0.78rem; color:#e2e8f0;">
                                👤 <strong>${_deps.escapeHtmlDoc(rl.nombre)}</strong>
                                <span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; font-size:0.65rem; margin-left:6px;">🟢 Vigente</span>
                                <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">
                                    Elección: ${_deps.escapeHtmlDoc(rl.fechaEleccion || '-')} | Vence: ${_deps.escapeHtmlDoc(rl.fechaVencimiento || 'Indefinido')}
                                </div>
                            </div>
                        ` : `
                            <div style="font-size:0.75rem; color:var(--text-muted);">
                                ⚠️ Sin nombramiento vigente registrado en el expediente societario.
                            </div>
                        `}
                    </div>

                    <!-- Apoderados para Contratos -->
                    <div style="background:rgba(15,23,42,0.5); border:1px solid var(--panel-border); border-radius:6px; padding:10px; margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <div style="font-weight:700; font-size:0.82rem; color:white; display:flex; align-items:center; gap:6px;">
                                <span>📜</span> Apoderados para Firma de Contratos (${powers.length})
                            </div>
                            <button type="button" class="btn-secondary" style="font-size:0.72rem; padding:2px 8px; border-color:#38bdf8; color:#38bdf8;" onclick="ClientDocuments.openGrantPowerModal('${c.id}')">
                                ➕ Otorgar Poder
                            </button>
                        </div>
                        ${powers.length > 0 ? `
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                ${powers.map(pw => `
                                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; padding:4px 6px; background:rgba(255,255,255,0.02); border-radius:4px;">
                                        <div>
                                            <span>🖋️ <strong>${_deps.escapeHtmlDoc(pw.nombreApoderado)}</strong></span>
                                            <span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; font-size:0.65rem; margin-left:4px;">Vigente</span>
                                        </div>
                                        <button type="button" class="btn-secondary" style="font-size:0.68rem; padding:1px 6px; color:#f87171;" onclick="ClientDocuments.revokeContractPower('${c.id}', '${pw.id || pw.powerId}', '${_deps.escapeHtmlDoc(pw.nombreApoderado)}')">Revocar</button>
                                    </div>
                                `).join('')}
                            </div>
                        ` : `
                            <div style="font-size:0.75rem; color:var(--text-muted);">
                                Sin apoderados con poder vigente. (El RL vigente puede firmar o puede otorgar poderes).
                            </div>
                        `}
                    </div>

                    <div style="display:flex; justify-content:flex-end;">
                        <button type="button" class="btn-secondary" style="font-size:0.75rem; padding:3px 10px;" onclick="ClientDocuments.openDossierHistoryModal('${c.id}')">
                            📜 Consultar Historial Completo B3
                        </button>
                    </div>
                </div>
            `;
            listEl.innerHTML += b3Html;
        }

        section.style.display = 'block';
    }

    // -------------------------------------------------------------------------
    // 3. Staged Files y Subida a Storage
    // -------------------------------------------------------------------------
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
            const duiEl = typeof document !== 'undefined' ? document.getElementById('nat-dui-file') : null;
            if (duiEl && duiEl.files && duiEl.files.length > 0) {
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
                const el = typeof document !== 'undefined' ? document.getElementById(s.id) : null;
                if (el && el.files && el.files.length > 0) filesToUpload.push({ el, key: s.key, isLegal: s.isLegal });
            }
        }

        if (filesToUpload.length === 0) return docs;

        _deps.showLoading('Subiendo documentos del cliente a la nube...');
        await Promise.all(filesToUpload.map(async item => {
            const ref = await _deps.uploadFileToStorage(item.el.files[0], 'clientes', { clientId: targetId, isLegal: item.isLegal });
            docs[item.key] = ref;
        }));
        return docs;
    }

    // -------------------------------------------------------------------------
    // 4. Eliminación de Documento de Cliente
    // -------------------------------------------------------------------------
    async function deleteClientDocument(clientId, docKey, itemIndex = null) {
        const currentUser = _deps.getCurrentUser();
        if (!currentUser || currentUser.role !== 'manager') {
            return _deps.alert("Permiso denegado. Solo el Gerente puede eliminar documentos.");
        }
        const clientsList = _deps.getClients();
        const client = clientsList.find(c => c.id === clientId);
        if (!client || !client.documentos || client.documentos[docKey] === undefined) {
            return _deps.alert("Documento no encontrado.");
        }

        const docName = _deps.formatClientDocLabel(docKey);
        const targetDesc = (itemIndex !== null && itemIndex !== undefined) ? `[${docName} (${itemIndex + 1})]` : `[${docName}]`;

        if (!_deps.confirm(`¿Estás seguro de que deseas eliminar el documento ${targetDesc} del expediente de este cliente?`)) {
            return;
        }

        // The server decides (manager only) and keeps the identifier index consistent: no direct write of the client.
        const fb = _deps.getFirebase();
        const CrmClients = _deps.getCrmClients();
        const crmClients = CrmClients;
        if (!CrmClients || typeof CrmClients.hasSessionSync !== 'function' || !CrmClients.hasSessionSync(fb)) {
            return _deps.alert(CrmClients && CrmClients.NO_SESSION_MESSAGE ? CrmClients.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
        }
        _deps.showLoading('Eliminando documento...');
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
            const res = await CrmClients.updateClient(fb, { id: clientId, client: next, dbSuffix: _deps.getDbSuffix(), confirmReview: false });
            if (res.status !== 'updated') return _deps.alert('No se eliminó el documento: ' + (res.status || 'respuesta inesperada') + '.');

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
            if (typeof window !== 'undefined') {
                window._activeClientBaseDocs = (client.documentos && typeof client.documentos === 'object') ? JSON.parse(JSON.stringify(client.documentos)) : null;
            }
            _deps.openClientModal(clientId);
            _deps.renderClientsTable();
        } catch (err) {
            _deps.alert(crmClients.errorMessage(err));
        } finally {
            _deps.hideLoading();
        }
    }

    // -------------------------------------------------------------------------
    // 5. Carga y Sustitución Contextual desde Panel de Cierre
    // -------------------------------------------------------------------------
    function toggleClientDocSubstForm(docKey) {
        if (typeof document === 'undefined') return;
        const el = document.getElementById(`subst-container-client-${docKey}`);
        if (el) {
            el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
        }
    }

    function cancelClientDocSubstForm(docKey) {
        if (typeof document === 'undefined') return;
        const fileEl = document.getElementById(`closing-client-subst-file-${docKey}`);
        if (fileEl) fileEl.value = '';
        const motivoEl = document.getElementById(`closing-client-motivo-${docKey}`);
        if (motivoEl) motivoEl.value = '';
        const feedbackEl = document.getElementById(`closing-client-subst-feedback-${docKey}`);
        if (feedbackEl) {
            feedbackEl.style.display = 'none';
            feedbackEl.innerHTML = '';
        }
        const container = document.getElementById(`subst-container-client-${docKey}`);
        if (container) container.style.display = 'none';
    }

    async function uploadClientDocumentFromClosing(clientId, prospectId, docKey, isSubstitution) {
        const prospectList = _deps.getProspects();
        const p = prospectList.find(x => x.id === prospectId) || null;
        if (!p) return _deps.alert('Oportunidad no encontrada');
        if (p.estado === 'ganado') return _deps.alert('No se pueden modificar documentos de una oportunidad ya ganada.');

        const clientList = _deps.getClients();
        const c = clientList.find(x => x.id === clientId) || null;
        if (!c) return _deps.alert('Cliente no encontrado en el sistema.');

        const fileInput = (typeof document !== 'undefined')
            ? (document.getElementById(isSubstitution ? `closing-client-subst-file-${docKey}` : `closing-client-file-${docKey}`)
                || document.getElementById(`closing-client-file-${docKey}`))
            : null;
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            return _deps.alert('Debe seleccionar un archivo para cargar.');
        }

        const file = fileInput.files[0];
        let motivo = '';
        if (isSubstitution) {
            const motivoInput = (typeof document !== 'undefined') ? document.getElementById(`closing-client-motivo-${docKey}`) : null;
            motivo = motivoInput ? motivoInput.value.trim() : '';
            if (!motivo) {
                return _deps.alert('Toda sustitución de un documento existente requiere un motivo no vacío.');
            }
        }

        const btn = (typeof document !== 'undefined') ? document.activeElement : null;
        const origText = (btn && btn.tagName === 'BUTTON') ? btn.innerHTML : '';
        if (btn && btn.tagName === 'BUTTON') {
            btn.disabled = true;
            btn.innerHTML = '⏳ Subiendo a Storage...';
        }

        try {
            const isLegal = ['escritura', 'credencial', 'nit', 'nrc', 'mods_escritura'].includes(docKey);

            let docRef;
            try {
                docRef = await _deps.uploadFileToStorage(file, 'clientes', { clientId: c.id, isLegal });
            } catch (uploadErr) {
                _deps.alert('Error al subir archivo a Storage: ' + (uploadErr.message || 'Error de red'));
                return;
            }

            if (btn && btn.tagName === 'BUTTON') {
                btn.innerHTML = '⏳ Registrando versión...';
            }

            const fb = _deps.getFirebase();
            const clientsModule = _deps.getCrmClients();
            if (!clientsModule || typeof clientsModule.hasSessionSync !== 'function' || !clientsModule.hasSessionSync(fb)) {
                _deps.alert(clientsModule && clientsModule.NO_SESSION_MESSAGE ? clientsModule.NO_SESSION_MESSAGE : 'No se pudo cargar el módulo de clientes. Recarga la página.');
                return;
            }

            const clientUpdate = JSON.parse(JSON.stringify(c));
            clientUpdate.baseDocumentos = (c.documentos && typeof c.documentos === 'object')
                ? JSON.parse(JSON.stringify(c.documentos))
                : {};
            if (!clientUpdate.documentos) clientUpdate.documentos = {};

            const stampedDoc = Object.assign({}, docRef);
            if (isSubstitution && motivo) {
                stampedDoc.motivoSustitucion = motivo;
                clientUpdate.motivosSustitucion = { [docKey]: motivo };
            }
            clientUpdate.documentos[docKey] = stampedDoc;

            const res = await clientsModule.updateClient(fb, {
                id: c.id,
                client: clientUpdate,
                dbSuffix: _deps.getDbSuffix(),
                confirmReview: false
            });

            if (res.status === 'updated') {
                if (res.client && res.client.documentos) {
                    c.documentos = res.client.documentos;
                } else {
                    c.documentos[docKey] = stampedDoc;
                }
                _deps.renderClosingDocumentationPanel(p);
                _deps.alert(`Documento [${_deps.formatClientDocLabel(docKey)}] ${isSubstitution ? 'sustituido' : 'guardado'} y versionado exitosamente.`);
            } else {
                _deps.alert('El servidor no confirmó la actualización: ' + (res.status || 'estado desconocido') + '. El archivo en Storage se conservó; puedes reintentar.');
            }
        } catch (err) {
            console.error('Error al actualizar documento del cliente desde panel de cierre:', err);
            const clientsModule = _deps.getCrmClients();
            const errMsg = clientsModule && typeof clientsModule.errorMessage === 'function' ? clientsModule.errorMessage(err) : (err.message || 'Error desconocido');
            _deps.alert('Error al registrar documento: ' + errMsg + '. El archivo en Storage se conservó; puedes reintentar.');
        } finally {
            if (btn && btn.tagName === 'BUTTON') {
                btn.disabled = false;
                btn.innerHTML = origText || 'Subir';
            }
        }
    }

    // -------------------------------------------------------------------------
    // 6. Funcionalidades Fase 2 Bloque B3: Representación Legal, Poderes y Revisiones
    // -------------------------------------------------------------------------

    function closeModalSafe(modalId) {
        if (typeof closeModal === 'function') return closeModal(modalId);
        if (typeof window !== 'undefined' && typeof window.closeModal === 'function') return window.closeModal(modalId);
        const el = (typeof document !== 'undefined') ? document.getElementById(modalId) : null;
        if (el) el.style.display = 'none';
    }

    async function loadAccountContactsOptions(accountId, selectEl) {
        if (!selectEl) return;
        selectEl.innerHTML = '<option value="">-- Cargando contactos de la cuenta... --</option>';
        try {
            const fb = _deps.getFirebase();
            let contacts = [];
            if (typeof CrmContacts !== 'undefined' && typeof CrmContacts.listAccountContacts === 'function' && fb) {
                const res = await CrmContacts.listAccountContacts(fb, { accountId, includeInactive: false, dbSuffix: _deps.getDbSuffix() });
                contacts = (res && res.contacts) || [];
            } else if (typeof window !== 'undefined' && Array.isArray(window.contacts)) {
                contacts = window.contacts.filter(ct => ct.accountId === accountId);
            }
            if (contacts.length === 0) {
                selectEl.innerHTML = '<option value="">-- Sin personas vinculadas (puede ingresar el nombre manual) --</option>';
            } else {
                selectEl.innerHTML = '<option value="">-- Seleccionar de los contactos de la cuenta --</option>' +
                    contacts.map(ct => {
                        const name = ct.persona ? `${ct.persona.nombres || ''} ${ct.persona.apellidos || ''}`.trim() : (ct.nombre || ct.nombres || 'Contacto');
                        const cargo = ct.cargo ? ` (${ct.cargo})` : '';
                        const contactId = ct.contactId || ct.id;
                        return `<option value="${_deps.escapeHtmlDoc(contactId)}" data-name="${_deps.escapeHtmlDoc(name)}">${_deps.escapeHtmlDoc(name)}${_deps.escapeHtmlDoc(cargo)}</option>`;
                    }).join('');
            }
        } catch (e) {
            console.warn('[ClientDocuments] Error loading account contacts:', e);
            selectEl.innerHTML = '<option value="">-- No se pudieron cargar contactos --</option>';
        }
    }

    async function openRLElectionModal(clientId) {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('b3RLElectionModal');
        if (!modal) return;
        const accIdEl = document.getElementById('b3-rl-account-id');
        if (accIdEl) accIdEl.value = clientId;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        const subtitleEl = document.getElementById('b3-rl-account-name-subtitle');
        if (subtitleEl) {
            subtitleEl.textContent = `Cuenta: ${client.empresa || client.nombres || clientId} (Persona Jurídica)`;
        }

        const nameEl = document.getElementById('b3-rl-nombre');
        if (nameEl) nameEl.value = '';
        const elecEl = document.getElementById('b3-rl-fecha-eleccion');
        if (elecEl) elecEl.value = new Date().toISOString().slice(0, 10);
        const vencEl = document.getElementById('b3-rl-fecha-vencimiento');
        if (vencEl) vencEl.value = '';
        const fCred = document.getElementById('b3-rl-file-credencial');
        if (fCred) fCred.value = '';
        const fDui = document.getElementById('b3-rl-file-dui');
        if (fDui) fDui.value = '';

        const selectEl = document.getElementById('b3-rl-contact-select');
        await loadAccountContactsOptions(clientId, selectEl);

        modal.style.display = 'flex';
    }

    function onRLContactSelected(contactId) {
        if (typeof document === 'undefined') return;
        const selectEl = document.getElementById('b3-rl-contact-select');
        const nameEl = document.getElementById('b3-rl-nombre');
        if (!selectEl || !nameEl) return;
        const opt = selectEl.options[selectEl.selectedIndex];
        if (opt && opt.dataset && opt.dataset.name) {
            nameEl.value = opt.dataset.name;
        }
    }

    async function submitLegalRepresentativeElection() {
        if (typeof document === 'undefined') return;
        const accountId = (document.getElementById('b3-rl-account-id') || {}).value;
        const contactSelect = document.getElementById('b3-rl-contact-select');
        const contactId = contactSelect ? contactSelect.value : null;
        const nombre = ((document.getElementById('b3-rl-nombre') || {}).value || '').trim();
        const fechaEleccion = ((document.getElementById('b3-rl-fecha-eleccion') || {}).value || '').trim();
        const fechaVencimiento = ((document.getElementById('b3-rl-fecha-vencimiento') || {}).value || '').trim();
        const fCred = (document.getElementById('b3-rl-file-credencial') || {}).files;
        const fDui = (document.getElementById('b3-rl-file-dui') || {}).files;

        if (!accountId) return _deps.alert('ID de cuenta faltante');
        if (!nombre) return _deps.alert('El nombre del Representante Legal es obligatorio.');
        if (!fechaEleccion) return _deps.alert('La fecha de elección es obligatoria.');
        if (!fCred || fCred.length === 0) return _deps.alert('Debe adjuntar la credencial del Representante Legal.');
        if (!fDui || fDui.length === 0) return _deps.alert('Debe adjuntar el DUI del Representante Legal.');

        const btn = document.getElementById('b3-btn-submit-rl');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '⏳ Subiendo credencial y DUI...';
        }

        try {
            _deps.showLoading('Subiendo credencial y DUI a Storage...');
            const [credRef, duiRef, credSha, duiSha] = await Promise.all([
                _deps.uploadFileToStorage(fCred[0], 'clientes', { clientId: accountId, isLegal: true }),
                _deps.uploadFileToStorage(fDui[0], 'clientes', { clientId: accountId, isLegal: false }),
                (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function')
                    ? CrmAccountDocuments.computeFileSha256(fCred[0]) : null,
                (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function')
                    ? CrmAccountDocuments.computeFileSha256(fDui[0]) : null
            ]);

            if (credSha && credRef) credRef.sha256 = credSha;
            if (duiSha && duiRef) duiRef.sha256 = duiSha;
            if (fechaVencimiento) {
                if (credRef) credRef.fechaVencimiento = fechaVencimiento;
                if (duiRef) duiRef.fechaVencimiento = fechaVencimiento;
            }

            if (btn) btn.innerHTML = '⏳ Registrando elección y anulando poderes...';

            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.registerLegalRepresentativeTerm !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            const res = await CrmAccountDocuments.registerLegalRepresentativeTerm(fb, {
                accountId,
                contactId: contactId || null,
                nombre,
                fechaEleccion,
                fechaInicio: fechaEleccion,
                fechaVencimiento: fechaVencimiento || null,
                credencialDoc: credRef,
                duiDoc: duiRef,
                dbSuffix: _deps.getDbSuffix()
            });

            closeModalSafe('b3RLElectionModal');

            const invalidatedCount = (res && res.invalidatedPowersCount) || 0;
            const notice = invalidatedCount > 0
                ? `\n\n⚠️ REGLA DE VIGENCIA: Se anularon automáticamente ${invalidatedCount} poder(es) de firma de contratos del nombramiento anterior.`
                : '\n\nNo existían poderes anteriores vinculados.';

            _deps.alert(`✅ Elección de Representante Legal (${nombre}) registrada exitosamente.${notice}`);

            // Actualizar cliente localmente
            const client = _deps.getClients().find(x => x.id === accountId);
            if (client) {
                if (!client.documentos) client.documentos = {};
                client.documentos.credencial = credRef;
                client.documentos.dui = duiRef;
                client.representanteLegalVigente = (res && res.term) || {
                    termId: res.termId,
                    nombre,
                    fechaEleccion,
                    fechaVencimiento,
                    estado: 'vigente'
                };
            }

            _deps.openClientModal(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error en elección de RL:', err);
            _deps.alert('Error al registrar nombramiento: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || 'Registrar Elección';
            }
        }
    }

    async function openGrantPowerModal(clientId) {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('b3PowerModal');
        if (!modal) return;
        const accIdEl = document.getElementById('b3-power-account-id');
        if (accIdEl) accIdEl.value = clientId;

        const fDoc = document.getElementById('b3-power-file-documento');
        if (fDoc) fDoc.value = '';
        const notasEl = document.getElementById('b3-power-notas');
        if (notasEl) notasEl.value = '';

        const selectEl = document.getElementById('b3-power-contact-select');
        await loadAccountContactsOptions(clientId, selectEl);

        modal.style.display = 'flex';
    }

    async function submitGrantContractPower() {
        if (typeof document === 'undefined') return;
        const accountId = (document.getElementById('b3-power-account-id') || {}).value;
        const contactSelect = document.getElementById('b3-power-contact-select');
        const contactId = contactSelect ? contactSelect.value : null;
        const fDoc = (document.getElementById('b3-power-file-documento') || {}).files;
        const notas = ((document.getElementById('b3-power-notas') || {}).value || '').trim();

        if (!accountId) return _deps.alert('ID de cuenta faltante');
        if (!contactId) return _deps.alert('Debe seleccionar una persona vinculada a la cuenta como apoderada.');
        if (!fDoc || fDoc.length === 0) return _deps.alert('Debe adjuntar el testimonio de poder notarial escaneado.');

        const btn = document.getElementById('b3-btn-submit-power');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '⏳ Subiendo poder notarial...';
        }

        try {
            _deps.showLoading('Subiendo testimonio de poder a Storage...');
            const docRef = await _deps.uploadFileToStorage(fDoc[0], 'clientes', { clientId: accountId, subfolder: 'poderes', isPoder: true });

            if (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function') {
                const sha = await CrmAccountDocuments.computeFileSha256(fDoc[0]);
                if (sha && docRef) docRef.sha256 = sha;
            }

            if (btn) btn.innerHTML = '⏳ Registrando poder en el expediente...';

            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.grantContractPower !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            const res = await CrmAccountDocuments.grantContractPower(fb, {
                accountId,
                contactId,
                documentoDoc: docRef,
                notas,
                dbSuffix: _deps.getDbSuffix()
            });

            closeModalSafe('b3PowerModal');
            _deps.alert(`✅ Poder notarial para firma de contratos otorgado exitosamente.`);

            _deps.openClientModal(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error otorgando poder:', err);
            _deps.alert('Error al otorgar poder: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || 'Otorgar Poder';
            }
        }
    }

    async function revokeContractPower(accountId, powerId, attorneyName) {
        const motivo = prompt(`¿Desea revocar el poder otorgado a ${attorneyName || 'este apoderado'}?\n\nIngrese el motivo de revocación (obligatorio):`);
        if (!motivo || !motivo.trim()) {
            if (motivo !== null) _deps.alert('Debe indicar un motivo para la revocación del poder.');
            return;
        }

        try {
            _deps.showLoading('Revocando poder notarial...');
            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.revokeContractPower !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            await CrmAccountDocuments.revokeContractPower(fb, {
                accountId,
                powerId,
                motivo: motivo.trim(),
                dbSuffix: _deps.getDbSuffix()
            });

            _deps.alert('✅ Poder notarial revocado exitosamente.');
            _deps.openClientModal(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error revocando poder:', err);
            _deps.alert('Error al revocar poder: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
        }
    }

    async function confirmBiennialReviewWithoutChanges(accountId, docKey) {
        const docLabel = _deps.formatClientDocLabel(docKey);
        const ok = _deps.confirm(`¿Confirmas formalmente que NO existen modificaciones a la [${docLabel}] de la sociedad?\n\nEsta acción registrará la confirmación bienal auditable y extenderá la validez documental por dos años adicionales.`);
        if (!ok) return;

        try {
            _deps.showLoading('Registrando confirmación bienal...');
            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.recordBiennialConfirmation !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            const client = _deps.getClients().find(x => x.id === accountId) || {};
            const doc = (client.documentos && client.documentos[docKey]) || {};
            const verId = doc.versionId || 'v_base';

            await CrmAccountDocuments.recordBiennialConfirmation(fb, {
                accountId,
                docKey,
                documentVersionId: verId,
                confirmationType: 'biennial_no_changes',
                confirmedNoChanges: true,
                dbSuffix: _deps.getDbSuffix()
            });

            _deps.alert(`✅ Revisión bienal confirmada exitosamente. Validez extendida por 2 años para [${docLabel}].`);
            _deps.openClientModal(accountId);
        } catch (err) {
            console.error('[ClientDocuments] Error en confirmación bienal:', err);
            _deps.alert('Error al confirmar revisión bienal: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
        }
    }

    async function openDossierHistoryModal(clientId) {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('b3DossierHistoryModal');
        const bodyEl = document.getElementById('b3-history-modal-body');
        const subTitle = document.getElementById('b3-history-account-subtitle');
        if (!modal || !bodyEl) return;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        if (subTitle) {
            subTitle.textContent = `Cuenta: ${client.empresa || client.nombres || clientId} — Trazabilidad histórica completa`;
        }
        bodyEl.innerHTML = '<div style="text-align:center; padding:2.5rem; color:var(--text-muted);"><span style="font-size:1.5rem;">⏳</span><br>Recuperando expediente digital...</div>';
        modal.style.display = 'flex';

        try {
            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.getAccountDossier !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            const dossier = await CrmAccountDocuments.getAccountDossier(fb, { accountId: clientId, dbSuffix: _deps.getDbSuffix() });
            const terms = (dossier && dossier.rlTermsHistory) || [];
            const powers = (dossier && (dossier.activePowers || []).concat(dossier.historicalPowers || [])) || [];
            const confirmations = (dossier && dossier.biennialConfirmations) || [];

            bodyEl.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:1.25rem;">
                    <!-- Nombramientos de Representante Legal -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1rem;">
                        <h4 style="margin:0 0 0.75rem 0; font-size:0.95rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                            <span>⚖️</span> Períodos de Nombramiento de Representante Legal (${terms.length})
                        </h4>
                        ${terms.length === 0 ? '<p style="font-size:0.8rem; color:var(--text-muted); margin:0;">Sin nombramientos registrados.</p>' : `
                            <table class="table-compact" style="width:100%; font-size:0.78rem; text-align:left;">
                                <thead>
                                    <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                        <th style="padding:6px;">Representante</th>
                                        <th style="padding:6px;">Fecha Elección</th>
                                        <th style="padding:6px;">Vencimiento</th>
                                        <th style="padding:6px;">Estado</th>
                                        <th style="padding:6px;">Documentos</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${terms.map(t => `
                                        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                                            <td style="padding:6px; font-weight:600; color:white;">${_deps.escapeHtmlDoc(t.nombre)}</td>
                                            <td style="padding:6px;">${_deps.escapeHtmlDoc(t.fechaEleccion || '-')}</td>
                                            <td style="padding:6px;">${_deps.escapeHtmlDoc(t.fechaVencimiento || 'Indefinido')}</td>
                                            <td style="padding:6px;">
                                                <span class="badge" style="background:${t.estado === 'vigente' ? 'rgba(16,185,129,0.2)' : 'rgba(148,163,184,0.15)'}; color:${t.estado === 'vigente' ? '#34d399' : '#94a3b8'};">
                                                    ${t.estado === 'vigente' ? '🟢 Vigente' : 'Cerrado/Histórico'}
                                                </span>
                                            </td>
                                            <td style="padding:6px;">
                                                ${t.credencialDoc ? '<span title="Credencial adjunta">📄 Credencial</span>' : ''}
                                                ${t.duiDoc ? ' <span title="DUI adjunto">🪪 DUI</span>' : ''}
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        `}
                    </div>

                    <!-- Poderes para Firma de Contratos -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1rem;">
                        <h4 style="margin:0 0 0.75rem 0; font-size:0.95rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                            <span>📜</span> Poderes Notariales para Firma de Contratos (${powers.length})
                        </h4>
                        ${powers.length === 0 ? '<p style="font-size:0.8rem; color:var(--text-muted); margin:0;">Sin poderes registrados.</p>' : `
                            <table class="table-compact" style="width:100%; font-size:0.78rem; text-align:left;">
                                <thead>
                                    <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                        <th style="padding:6px;">Apoderado</th>
                                        <th style="padding:6px;">Fecha Registro</th>
                                        <th style="padding:6px;">Estado de Vigencia</th>
                                        <th style="padding:6px;">Motivo / Observaciones</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${powers.map(pw => {
                                        let badgeColor = '#94a3b8';
                                        let badgeBg = 'rgba(148,163,184,0.15)';
                                        let label = pw.estado;
                                        if (pw.estado === 'vigente') {
                                            badgeColor = '#34d399';
                                            badgeBg = 'rgba(16,185,129,0.2)';
                                            label = '🟢 Vigente';
                                        } else if (pw.estado === 'anulado_por_nueva_eleccion') {
                                            badgeColor = '#f87171';
                                            badgeBg = 'rgba(239,68,68,0.2)';
                                            label = '🔴 Anulado por nueva elección';
                                        } else if (pw.estado === 'revocado') {
                                            badgeColor = '#fbbf24';
                                            badgeBg = 'rgba(245,158,11,0.2)';
                                            label = '🟠 Revocado';
                                        }
                                        return `
                                            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                                                <td style="padding:6px; font-weight:600; color:white;">${_deps.escapeHtmlDoc(pw.nombreApoderado)}</td>
                                                <td style="padding:6px;">${_deps.escapeHtmlDoc(pw.fechaRegistro || (pw.createdAt ? String(pw.createdAt).slice(0, 10) : '-'))}</td>
                                                <td style="padding:6px;">
                                                    <span class="badge" style="background:${badgeBg}; color:${badgeColor};">
                                                        ${label}
                                                    </span>
                                                </td>
                                                <td style="padding:6px; color:var(--text-muted); font-size:0.72rem;">
                                                    ${_deps.escapeHtmlDoc(pw.motivoRevocacion || pw.motivoAnulacion || pw.notas || '-')}
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `}
                    </div>

                    <!-- Confirmaciones Bienales -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1rem;">
                        <h4 style="margin:0 0 0.75rem 0; font-size:0.95rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                            <span>📆</span> Revisiones Bienales de Documentos Societarios (${confirmations.length})
                        </h4>
                        ${confirmations.length === 0 ? '<p style="font-size:0.8rem; color:var(--text-muted); margin:0;">Sin confirmaciones bienales registradas aún.</p>' : `
                            <table class="table-compact" style="width:100%; font-size:0.78rem; text-align:left;">
                                <thead>
                                    <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                        <th style="padding:6px;">Documento</th>
                                        <th style="padding:6px;">Fecha Confirmación</th>
                                        <th style="padding:6px;">Confirmado Por</th>
                                        <th style="padding:6px;">Próxima Revisión</th>
                                        <th style="padding:6px;">Resultado</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${confirmations.map(cf => `
                                        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                                            <td style="padding:6px; font-weight:600; color:white;">${_deps.escapeHtmlDoc(_deps.formatClientDocLabel(cf.docKey))}</td>
                                            <td style="padding:6px;">${_deps.escapeHtmlDoc(cf.confirmedAt ? cf.confirmedAt.slice(0, 10) : '-')}</td>
                                            <td style="padding:6px;">${_deps.escapeHtmlDoc(cf.confirmedByName || cf.confirmedBy)}</td>
                                            <td style="padding:6px; color:#34d399;">${_deps.escapeHtmlDoc(cf.nextReviewAt || '-')}</td>
                                            <td style="padding:6px;">
                                                <span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399;">
                                                    ${cf.confirmedNoChanges ? 'Sin Modificaciones' : 'Modificación Incorporada'}
                                                </span>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        `}
                    </div>
                </div>
            `;
        } catch (e) {
            console.error('[ClientDocuments] Error recuperando expediente:', e);
            bodyEl.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--danger);"><p>Error al cargar el expediente: ${_deps.escapeHtmlDoc(e.message || 'Error desconocido')}</p></div>`;
        }
    }

    const ClientDocuments = {
        init: initClientDocuments,
        initClientDocuments,
        renderClientExpedienteSection,
        hasStagedClientFiles,
        uploadClientStagedFiles,
        deleteClientDocument,
        toggleClientDocSubstForm,
        cancelClientDocSubstForm,
        uploadClientDocumentFromClosing,
        // Block B3 exports
        openRLElectionModal,
        onRLContactSelected,
        submitLegalRepresentativeElection,
        openGrantPowerModal,
        submitGrantContractPower,
        revokeContractPower,
        confirmBiennialReviewWithoutChanges,
        openDossierHistoryModal,
        _deps
    };

    if (typeof window !== 'undefined') {
        window.openRLElectionModal = openRLElectionModal;
        window.openGrantPowerModal = openGrantPowerModal;
        window.openDossierHistoryModal = openDossierHistoryModal;
        window.revokeContractPower = revokeContractPower;
        window.confirmBiennialReviewWithoutChanges = confirmBiennialReviewWithoutChanges;
        window.onRLContactSelected = onRLContactSelected;
        window.submitLegalRepresentativeElection = submitLegalRepresentativeElection;
        window.submitGrantContractPower = submitGrantContractPower;
    }

    return ClientDocuments;
});
