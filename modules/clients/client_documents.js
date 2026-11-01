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
        _deps
    };

    return ClientDocuments;
});
