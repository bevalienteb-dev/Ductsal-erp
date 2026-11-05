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
        openClientDetailView: (clientId, options) => {
            if (typeof openClientDetailView === 'function') return openClientDetailView(clientId, options);
            if (typeof window !== 'undefined' && typeof window.openClientDetailView === 'function') return window.openClientDetailView(clientId, options);
            if (typeof ClientsUI !== 'undefined' && typeof ClientsUI.openClientDetailView === 'function') return ClientsUI.openClientDetailView(clientId, options);
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
            return renderInlineViewNotice(msg);
        },
        confirm: () => {
            return true;
        }
    };

    function renderInlineViewNotice(msg) {
        const text = String(msg || '');
        const isSuccess = /exitosamente|✅|guardad|registrad|confirmad|actualizad|eliminado correctamente/i.test(text) && !/error|no se|denegado|inválid|falta|requiere/i.test(text);
        if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
            window.CrmUI.notify(isSuccess ? 'success' : 'error', text);
        }
        if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            const activeView = document.querySelector('.view-section.active') || document.getElementById('client-detail-view');
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
                banner.style.cssText = isSuccess
                    ? 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#a7f3d0; font-size:0.84rem;'
                    : 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fca5a5; font-size:0.84rem;';
                banner.textContent = text;
            }
        }
    }

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

        const currentUser = _deps.getCurrentUser();
        const isManager = currentUser && currentUser.role === 'manager';

        const catalogSpecs = c.tipo === 'natural'
            ? [{ key: 'dui', label: 'DUI (Persona Natural)' }]
            : [
                { key: 'escritura', label: 'Escritura de Constitución' },
                { key: 'mods_escritura', label: 'Modificación al Pacto Social' },
                { key: 'credencial', label: 'Credencial de Rep. Legal' },
                { key: 'dui', label: 'DUI del Representante Legal' },
                { key: 'nit', label: 'NIT de la Empresa' },
                { key: 'nrc', label: 'NRC / Tarjeta de IVA' }
            ];

        if (docItems.length === 0) {
            listEl.innerHTML = '<div style="text-align:center; padding:0.75rem; color:var(--text-muted); font-size:0.8rem;">Sin documentos registrados aún en el expediente. Utilice los botones inferiores para cargar documentos con control SHA-256.</div>';
        } else {
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
                const shaShort = (item.docRef && item.docRef.sha256) ? ` · SHA-256: ${String(item.docRef.sha256).slice(0, 10)}…` : '';
                const vencInfo = (item.docRef && item.docRef.fechaVencimiento) ? ` · Vence: ${_deps.escapeHtmlDoc(item.docRef.fechaVencimiento)}` : '';

                let viewBtn = '';
                if (previewable) {
                    viewBtn = `<button type="button" class="btn-table-action btn-table-edit" onclick="viewStoredClientDoc('${storeId}')" title="Previsualizar documento">👁️ Ver</button>`;
                }
                const dlBtn = `<button type="button" class="btn-table-action" onclick="downloadStoredClientDoc('${storeId}')" title="Descargar original" style="background:rgba(255,255,255,0.06); color:var(--text-secondary); border:1px solid rgba(255,255,255,0.12);">⬇️ Descargar</button>`;
                const substBtn = `<button type="button" class="btn-table-action" onclick="ClientDocuments.openSubstituteDocView('${c.id}', '${item.key}', '${safeLabel}')" title="Sustituir documento en vista de pantalla completa" style="background:rgba(56,189,248,0.12); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">🔄 Sustituir</button>`;
                const histBtn = `<button type="button" class="btn-table-action" onclick="showDocumentVersionHistory('client', '${c.id}', '${item.key}', '${safeLabel}')" title="Consultar historial de versiones en vista de pantalla completa" style="background:rgba(245,158,11,0.12); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);">📜 Versiones</button>`;
                const delBtn = isManager ? `<button type="button" class="btn-table-action btn-table-delete" onclick="deleteStoredClientDoc('${storeId}')" title="Eliminar documento del expediente">🗑️</button>` : '';

                return `
                    <div class="client-doc-card" style="flex-wrap:wrap; gap:8px;">
                        <div class="client-doc-info">
                            <span style="font-size:1.25rem;">${icon}</span>
                            <div style="min-width:0;">
                                <div class="client-doc-title">${safeLabel}</div>
                                <div class="client-doc-meta" title="${safeName}">${safeName}${shaShort}${vencInfo}</div>
                            </div>
                        </div>
                        <div class="client-doc-actions" style="flex-wrap:wrap; gap:6px;">
                            <span class="badge" style="background:rgba(255,255,255,0.06); color:var(--text-muted); font-size:0.65rem; border:1px solid rgba(255,255,255,0.1);">${_deps.escapeHtmlDoc(ext)}</span>
                            ${viewBtn}
                            ${dlBtn}
                            ${substBtn}
                            ${histBtn}
                            ${delBtn}
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Botones de acceso directo a vista de pantalla completa para Cargar o Sustituir cualquier documento del catálogo
        const quickUploadHtml = `
            <div style="margin-top: 0.85rem; padding: 0.85rem; background: rgba(15, 23, 42, 0.45); border: 1px dashed rgba(56, 189, 248, 0.35); border-radius: 8px;">
                <div style="font-size: 0.78rem; font-weight: 600; color: #38bdf8; margin-bottom: 0.5rem;">
                    📤 Cargar o Sustituir Documentos en Vista de Pantalla Completa (Control SHA-256 y Versionado):
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                    ${catalogSpecs.map(sp => {
                        const exists = !!(c.documentos && c.documentos[sp.key]);
                        return `<button type="button" class="btn-secondary" style="font-size: 0.74rem; padding: 4px 10px;" onclick="ClientDocuments.openSubstituteDocView('${c.id}', '${sp.key}', '${_deps.escapeHtmlDoc(sp.label)}')">
                            ${exists ? '🔄 Sustituir' : '➕ Cargar'} ${_deps.escapeHtmlDoc(sp.label)}
                        </button>`;
                    }).join('')}
                </div>
            </div>
        `;
        listEl.innerHTML += quickUploadHtml;

        if (c.tipo === 'juridica') {
            const rl = c.representanteLegalVigente || null;
            const powers = Array.isArray(c.apoderadosVigentes) ? c.apoderadosVigentes : [];
            const b3Html = `
                <div style="margin-top: 1.15rem; border-top: 1px solid var(--panel-border); padding-top: 1rem;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:0.75rem;">
                        <h4 style="margin:0; font-size:0.92rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                            <span>🏛️</span> Gobierno Societario y Facultades Contractuales (Bloque B3)
                        </h4>
                        <div style="display:flex; flex-wrap:wrap; gap:6px;">
                            <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px; border-color:rgba(16,185,129,0.4); color:#34d399;" onclick="ClientDocuments.openBiennialConfirmationView('${c.id}')">
                                🗓️ Confirmación Bienal (Pacto Social)
                            </button>
                            <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px; border-color:rgba(251,191,36,0.4); color:#fbbf24;" onclick="ClientDocuments.openDossierHistoryView('${c.id}')">
                                🗂️ Historial de Representantes y Poderes
                            </button>
                        </div>
                    </div>

                    <!-- Representante Legal -->
                    <div style="background:rgba(15,23,42,0.55); border:1px solid var(--panel-border); border-radius:8px; padding:12px; margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
                            <div style="font-weight:700; font-size:0.85rem; color:white; display:flex; align-items:center; gap:6px;">
                                <span>⚖️</span> Representante Legal Vigente
                            </div>
                            <button type="button" class="btn-secondary" style="font-size:0.75rem; padding:4px 10px; border-color:#ef4444; color:#f87171;" onclick="ClientDocuments.openRLElectionView('${c.id}')">
                                ➕ Registrar / Cambiar Representante Legal
                            </button>
                        </div>
                        ${rl && rl.estado === 'vigente' ? `
                            <div style="font-size:0.82rem; color:#e2e8f0;">
                                👤 <strong>${_deps.escapeHtmlDoc(rl.nombre)}</strong>
                                <span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; font-size:0.68rem; margin-left:6px;">🟢 Vigente</span>
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:3px;">
                                    Elección: ${_deps.escapeHtmlDoc(rl.fechaEleccion || '-')} | Vencimiento de Credencial: ${_deps.escapeHtmlDoc(rl.fechaVencimiento || 'Indefinido')}
                                </div>
                            </div>
                        ` : `
                            <div style="font-size:0.78rem; color:var(--text-muted);">
                                ⚠️ Sin nombramiento vigente registrado en el expediente societario. Utilice el botón superior para registrar al Representante Legal e incorporar su DUI y Credencial.
                            </div>
                        `}
                    </div>

                    <!-- Apoderados para Contratos -->
                    <div style="background:rgba(15,23,42,0.55); border:1px solid var(--panel-border); border-radius:8px; padding:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
                            <div style="font-weight:700; font-size:0.85rem; color:white; display:flex; align-items:center; gap:6px;">
                                <span>📜</span> Apoderados para Firma de Contratos (${powers.length})
                            </div>
                            <button type="button" class="btn-secondary" style="font-size:0.75rem; padding:4px 10px; border-color:#38bdf8; color:#38bdf8;" onclick="ClientDocuments.openGrantPowerView('${c.id}')">
                                ➕ Registrar Apoderado y Poder
                            </button>
                        </div>
                        ${powers.length > 0 ? `
                            <div style="display:flex; flex-direction:column; gap:6px;">
                                ${powers.map(pw => {
                                    const pwId = pw.id || pw.powerId;
                                    return `
                                    <div style="font-size:0.78rem; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:6px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                                            <div>
                                                <span>🖋️ <strong>${_deps.escapeHtmlDoc(pw.nombreApoderado)}</strong></span>
                                                <span class="badge" style="background:rgba(16,185,129,0.2); color:#34d399; font-size:0.65rem; margin-left:4px;">🟢 Poder Vigente</span>
                                            </div>
                                            <button type="button" class="btn-secondary" style="font-size:0.72rem; padding:2px 8px; color:#f87171; border-color:rgba(239,68,68,0.35);" onclick="ClientDocuments.toggleInlineRevokePower('${pwId}')">
                                                Revocar Poder
                                            </button>
                                        </div>
                                        <div id="b3-inline-revoke-${pwId}" style="display:none; margin-top:8px; padding-top:8px; border-top:1px dashed rgba(239,68,68,0.35);">
                                            <label style="display:block; font-size:0.74rem; color:#fca5a5; margin-bottom:4px;">Motivo de revocación del poder (obligatorio):</label>
                                            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                                <input type="text" id="b3-revoke-reason-${pwId}" placeholder="Ej. Sustitución de apoderado / Revocatoria por junta directiva" style="flex:1; min-width:200px; padding:4px 8px; font-size:0.76rem; background:rgba(0,0,0,0.35); border:1px solid #ef4444; border-radius:4px; color:white;">
                                                <button type="button" class="btn-primary" style="font-size:0.74rem; padding:4px 10px; background:#ef4444; border-color:#dc2626;" onclick="ClientDocuments.submitInlineRevokePower('${c.id}', '${pwId}')">Confirmar Revocación</button>
                                                <button type="button" class="btn-secondary" style="font-size:0.74rem; padding:4px 10px;" onclick="ClientDocuments.toggleInlineRevokePower('${pwId}')">Cancelar</button>
                                            </div>
                                        </div>
                                    </div>
                                `;}).join('')}
                            </div>
                        ` : `
                            <div style="font-size:0.78rem; color:var(--text-muted);">
                                Sin apoderados con poder vigente. (El Representante Legal vigente puede suscribir contratos o puede acreditar apoderados).
                            </div>
                        `}
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
    async function deleteClientDocument(clientId, docKey, itemIndex = null, skipInlineConfirm = false) {
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

        const container = (typeof document !== 'undefined') ? document.getElementById('client-expediente-documentos-container') : null;
        if (!skipInlineConfirm && container && typeof container.insertBefore === 'function' && typeof document.createElement === 'function') {
            let confirmBox = document.getElementById('b3-inline-delete-doc-confirm');
            if (!confirmBox) {
                confirmBox = document.createElement('div');
                confirmBox.id = 'b3-inline-delete-doc-confirm';
                if (container.firstChild) {
                    container.insertBefore(confirmBox, container.firstChild);
                } else if (typeof container.appendChild === 'function') {
                    container.appendChild(confirmBox);
                }
            }
            const safeClientId = _deps.escapeHtmlDoc(clientId);
            const safeDocKey = _deps.escapeHtmlDoc(docKey);
            const idxArg = (itemIndex !== null && itemIndex !== undefined) ? Number(itemIndex) : 'null';
            confirmBox.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; font-size:0.85rem;';
            confirmBox.innerHTML = `
                <span>⚠️ ¿Confirmar eliminación del documento <strong>${_deps.escapeHtmlDoc(targetDesc)}</strong> del expediente?</span>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="btn-danger" style="padding:4px 10px; font-size:0.78rem;" onclick="deleteClientDocument('${safeClientId}', '${safeDocKey}', ${idxArg}, true)">Confirmar eliminación</button>
                    <button type="button" class="btn-secondary" style="padding:4px 10px; font-size:0.78rem;" onclick="const el=document.getElementById('b3-inline-delete-doc-confirm'); if(el) el.remove();">Cancelar</button>
                </div>
            `;
            return;
        }

        if (!skipInlineConfirm && !_deps.confirm(`¿Estás seguro de que deseas eliminar el documento ${targetDesc} del expediente de este cliente?`)) {
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
            _deps.openClientDetailView(clientId);
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
    // 6. Funcionalidades Fase 2 Bloque B3: Vistas de Pantalla Completa
    // -------------------------------------------------------------------------

    let _b3CurrentAccountId = null;
    let _b3OriginContext = { view: 'client-detail-view', prospectId: null };

    function _navigateB3View(viewId) {
        if (typeof showView === 'function') {
            showView(viewId);
        } else if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
            AppRouter.showView(viewId);
        }
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            try { window.scrollTo(0, 0); } catch (_) {}
        }
    }

    function _captureB3Origin(clientId, options = {}) {
        _b3CurrentAccountId = clientId || _b3CurrentAccountId;
        if (options && options.originView) {
            _b3OriginContext = {
                view: options.originView,
                prospectId: options.prospectId || null
            };
            return;
        }
        if (typeof document !== 'undefined') {
            const detailEl = document.getElementById('detail-view');
            if (detailEl && detailEl.classList && typeof detailEl.classList.contains === 'function' && detailEl.classList.contains('active')) {
                const pid = (typeof window !== 'undefined' && (window.currentProspectId || window.currentDetailId))
                    ? (window.currentProspectId || window.currentDetailId)
                    : (typeof currentProspectId !== 'undefined' ? currentProspectId : null);
                _b3OriginContext = { view: 'detail-view', prospectId: pid };
                return;
            }
        }
        _b3OriginContext = { view: 'client-detail-view', prospectId: null };
    }

    function getCurrentAccountId() {
        if (_b3CurrentAccountId) return _b3CurrentAccountId;
        if (typeof document !== 'undefined') {
            const editEl = document.getElementById('client-id-edit');
            if (editEl && editEl.value) return editEl.value;
        }
        return null;
    }

    function returnToClientOrOrigin(overrideAccountId = null) {
        const accountId = overrideAccountId || getCurrentAccountId();
        if (_b3OriginContext && _b3OriginContext.view === 'detail-view' && _b3OriginContext.prospectId) {
            _navigateB3View('detail-view');
            if (typeof window !== 'undefined' && typeof window.openDetail === 'function') {
                window.openDetail(_b3OriginContext.prospectId);
            } else {
                const p = _deps.getProspects().find(x => x.id === _b3OriginContext.prospectId);
                if (p) _deps.renderClosingDocumentationPanel(p);
            }
            return;
        }
        if (accountId) {
            _deps.openClientDetailView(accountId);
        } else {
            _navigateB3View('clients-view');
            _deps.renderClientsTable();
        }
    }

    async function previewFileHash(inputEl, targetId) {
        if (typeof document === 'undefined') return;
        const target = document.getElementById(targetId);
        if (!target) return;
        if (!inputEl || !inputEl.files || inputEl.files.length === 0) {
            target.textContent = '';
            return;
        }
        const file = inputEl.files[0];
        if (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function') {
            target.textContent = '⏳ Calculando huella criptográfica SHA-256...';
            try {
                const sha = await CrmAccountDocuments.computeFileSha256(file);
                if (sha) {
                    target.textContent = `🔒 Huella SHA-256 verificada: ${sha}`;
                } else {
                    target.textContent = '';
                }
            } catch (_) {
                target.textContent = '';
            }
        }
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

    async function openRLElectionView(clientId, options = {}) {
        if (typeof document === 'undefined') return;
        _captureB3Origin(clientId, options);
        const accIdEl = document.getElementById('b3-rl-account-id');
        if (accIdEl) accIdEl.value = clientId;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        const subtitleEl = document.getElementById('b3-rl-account-name-subtitle');
        if (subtitleEl) {
            subtitleEl.textContent = `Cuenta Comercial: ${client.empresa || client.nombres || clientId} (Persona Jurídica)`;
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
        const credHash = document.getElementById('b3-rl-credencial-hash-preview');
        if (credHash) credHash.textContent = '';
        const duiHash = document.getElementById('b3-rl-dui-hash-preview');
        if (duiHash) duiHash.textContent = '';

        _navigateB3View('b3-rl-election-view');

        const selectEl = document.getElementById('b3-rl-contact-select');
        await loadAccountContactsOptions(clientId, selectEl);
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

            const invalidatedCount = (res && res.invalidatedPowersCount) || 0;
            const notice = invalidatedCount > 0
                ? `\n\n⚠️ REGLA DE VIGENCIA: Se anularon automáticamente ${invalidatedCount} poder(es) de firma de contratos del nombramiento anterior.`
                : '\n\nNo existían poderes anteriores vinculados.';

            // Actualizar cliente localmente
            const client = _deps.getClients().find(x => x.id === accountId);
            if (client) {
                if (!client.documentos) client.documentos = {};
                client.documentos.credencial = credRef;
                client.documentos.dui = duiRef;
                client.rep_legal = nombre;
                client.representanteLegalVigente = (res && res.term) || {
                    termId: res.termId,
                    nombre,
                    fechaEleccion,
                    fechaVencimiento,
                    estado: 'vigente'
                };
                client.apoderadosVigentes = [];
            }

            _deps.alert(`✅ Elección de Representante Legal (${nombre}) registrada exitosamente.${notice}`);
            returnToClientOrOrigin(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error en elección de RL:', err);
            _deps.alert('Error al registrar nombramiento: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || '⚖️ Registrar Elección e Invalidar Poderes Anteriores';
            }
        }
    }

    async function openGrantPowerView(clientId, options = {}) {
        if (typeof document === 'undefined') return;
        _captureB3Origin(clientId, options);
        const accIdEl = document.getElementById('b3-power-account-id');
        if (accIdEl) accIdEl.value = clientId;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        const subEl = document.getElementById('b3-power-account-subtitle');
        if (subEl) {
            subEl.textContent = `Cuenta Comercial: ${client.empresa || client.nombres || clientId}`;
        }
        const rlLabelEl = document.getElementById('b3-power-current-rl-label');
        if (rlLabelEl) {
            const rlName = (client.representanteLegalVigente && client.representanteLegalVigente.nombre) || client.rep_legal || 'Representante Legal Vigente';
            rlLabelEl.textContent = rlName;
        }

        const fDoc = document.getElementById('b3-power-file-documento');
        if (fDoc) fDoc.value = '';
        const notasEl = document.getElementById('b3-power-notas');
        if (notasEl) notasEl.value = '';
        const hashEl = document.getElementById('b3-power-doc-hash-preview');
        if (hashEl) hashEl.textContent = '';

        _navigateB3View('b3-grant-power-view');

        const selectEl = document.getElementById('b3-power-contact-select');
        await loadAccountContactsOptions(clientId, selectEl);
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

            const client = _deps.getClients().find(x => x.id === accountId);
            if (client && res) {
                if (!Array.isArray(client.apoderadosVigentes)) client.apoderadosVigentes = [];
                const powerEntry = res.power || {
                    id: res.powerId,
                    powerId: res.powerId,
                    accountId,
                    contactId,
                    nombreApoderado: res.nombreApoderado || 'Apoderado',
                    termId: res.termId || null,
                    notas: res.notas !== undefined ? res.notas : (notas || null),
                    documento: docRef,
                    estado: 'vigente'
                };
                if (notas && !powerEntry.notas) powerEntry.notas = notas;
                client.apoderadosVigentes.push(powerEntry);
            }

            _deps.alert(`✅ Poder notarial para firma de contratos otorgado exitosamente.`);
            returnToClientOrOrigin(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error otorgando poder:', err);
            _deps.alert('Error al otorgar poder: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || '📜 Otorgar y Acreditar Poder para Contratos';
            }
        }
    }

    function toggleInlineRevokePower(powerId) {
        if (typeof document === 'undefined') return;
        const box = document.getElementById(`b3-inline-revoke-${powerId}`) || document.getElementById(`b3-history-revoke-${powerId}`);
        if (box) {
            box.style.display = (box.style.display === 'none' || !box.style.display) ? 'block' : 'none';
        }
    }

    async function submitInlineRevokePower(accountId, powerId, inputIdOverride = null) {
        if (typeof document === 'undefined') return;
        const inputEl = document.getElementById(inputIdOverride || `b3-revoke-reason-${powerId}`);
        const motivo = inputEl ? inputEl.value.trim() : '';
        if (!motivo) {
            return _deps.alert('Debe indicar un motivo obligatorio para la revocación del poder.');
        }
        await revokeContractPower(accountId, powerId, '', motivo);
    }

    async function revokeContractPower(accountId, powerId, attorneyName, providedMotivo = null) {
        let motivo = providedMotivo;
        if (!motivo || !String(motivo).trim()) {
            // Si no se proporcionó motivo, desplegar el formulario inline dentro de la vista integrada
            toggleInlineRevokePower(powerId);
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
                motivo: String(motivo).trim(),
                dbSuffix: _deps.getDbSuffix()
            });

            const client = _deps.getClients().find(x => x.id === accountId);
            if (client && Array.isArray(client.apoderadosVigentes)) {
                client.apoderadosVigentes = client.apoderadosVigentes.filter(p => (p.id || p.powerId) !== powerId);
            }

            _deps.alert('✅ Poder notarial revocado exitosamente.');
            // Si estamos en la vista de historial B3, recargarla; de lo contrario volver al cliente/origen
            const histView = (typeof document !== 'undefined') ? document.getElementById('b3-dossier-history-view') : null;
            if (histView && histView.classList && histView.classList.contains('active')) {
                await openDossierHistoryView(accountId, { originView: _b3OriginContext.view, prospectId: _b3OriginContext.prospectId });
            } else {
                returnToClientOrOrigin(accountId);
            }
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error revocando poder:', err);
            _deps.alert('Error al revocar poder: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
        }
    }

    function openBiennialConfirmationView(clientId, options = {}) {
        if (typeof document === 'undefined') return;
        _captureB3Origin(clientId, options);
        const accEl = document.getElementById('b3-biennial-account-id');
        if (accEl) accEl.value = clientId;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        const subEl = document.getElementById('b3-biennial-account-subtitle');
        if (subEl) {
            subEl.textContent = `Cuenta Comercial: ${client.empresa || client.nombres || clientId}`;
        }

        const docKeySelect = document.getElementById('b3-biennial-doc-key');
        if (docKeySelect) {
            docKeySelect.value = (options && options.docKey) ? options.docKey : 'escritura';
        }

        const fileEl = document.getElementById('b3-biennial-file');
        if (fileEl) fileEl.value = '';
        const upNotesEl = document.getElementById('b3-biennial-upload-notes');
        if (upNotesEl) upNotesEl.value = '';
        const confNotesEl = document.getElementById('b3-biennial-confirm-notes');
        if (confNotesEl) confNotesEl.value = '';
        const checkEl = document.getElementById('b3-biennial-confirm-check');
        if (checkEl) checkEl.checked = false;
        const hashEl = document.getElementById('b3-biennial-hash-preview');
        if (hashEl) hashEl.textContent = '';

        const summaryEl = document.getElementById('b3-biennial-status-summary');
        if (summaryEl) {
            const docs = client.documentos || {};
            const escDoc = docs.escritura || null;
            const modsDoc = docs.mods_escritura || null;
            const escVer = escDoc ? `v${escDoc.versionNumber || 1} (${escDoc.versionId || 'v_base'})` : 'No cargada';
            const modsVer = modsDoc ? `v${modsDoc.versionNumber || 1} (${modsDoc.versionId || 'v_base'})` : 'Sin modificaciones registradas';
            summaryEl.innerHTML = `
                <div style="background:rgba(15,23,42,0.55); border:1px solid var(--panel-border); border-radius:8px; padding:1rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div>
                        <div style="font-size:0.88rem; font-weight:700; color:white;">Estado actual de Documentos Societarios Sujetos a Revisión Bienal</div>
                        <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">
                            Escritura de Constitución: <strong>${escDoc ? `🟢 Incorporada — ${escVer}` : '🔴 Pendiente'}</strong> ·
                            Modificaciones al Pacto Social: <strong>${modsDoc ? `🟢 Incorporadas — ${modsVer}` : '⚪ ' + modsVer}</strong>
                        </div>
                    </div>
                    <span class="badge bg-info" style="font-size:0.75rem;">Ciclo de revisión: 24 meses</span>
                </div>
            `;
        }

        _navigateB3View('b3-biennial-confirmation-view');
    }

    async function submitBiennialUpload() {
        if (typeof document === 'undefined') return;
        const accountId = (document.getElementById('b3-biennial-account-id') || {}).value;
        const docKeySelect = document.getElementById('b3-biennial-doc-key');
        const targetDocKey = (docKeySelect && docKeySelect.value) ? docKeySelect.value : 'mods_escritura';
        const fileInput = document.getElementById('b3-biennial-file');
        const notes = ((document.getElementById('b3-biennial-upload-notes') || {}).value || '').trim();
        if (!accountId) return _deps.alert('ID de cuenta faltante');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            return _deps.alert('Caso A (Con actualizaciones): Debe adjuntar el archivo actualizado del documento societario.');
        }
        if (!notes) {
            return _deps.alert('Debe ingresar el detalle de la actualización societaria.');
        }

        const btn = document.getElementById('b3-btn-biennial-upload');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '⏳ Subiendo nueva versión...';
        }

        try {
            _deps.showLoading('Subiendo nueva versión documental y renovando revisión bienal...');
            const file = fileInput.files[0];
            const [docRef, sha] = await Promise.all([
                _deps.uploadFileToStorage(file, 'clientes', { clientId: accountId, isLegal: true }),
                (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function')
                    ? CrmAccountDocuments.computeFileSha256(file) : null
            ]);
            if (sha && docRef) docRef.sha256 = sha;

            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.saveAccountDocument !== 'function') {
                throw new Error('Módulo CrmAccountDocuments.saveAccountDocument no disponible.');
            }
            const saveRes = await CrmAccountDocuments.saveAccountDocument(fb, {
                accountId,
                docKey: targetDocKey,
                doc: docRef,
                motivoSustitucion: notes,
                dbSuffix: _deps.getDbSuffix()
            });
            if (saveRes && saveRes.versionId && docRef) {
                docRef.versionId = saveRes.versionId;
                docRef.versionNumber = saveRes.versionNumber;
            }

            const client = _deps.getClients().find(x => x.id === accountId);
            if (client) {
                if (!client.documentos) client.documentos = {};
                client.documentos[targetDocKey] = docRef;
                if (!client.biennialReviews) client.biennialReviews = {};
                const nowIso = new Date().toISOString();
                const nextIso = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                client.biennialReviews[targetDocKey] = {
                    lastConfirmedAt: nowIso,
                    nextReviewAt: nextIso,
                    documentVersionId: (saveRes && saveRes.versionId) || (docRef && docRef.versionId) || null,
                    versionNumber: (saveRes && saveRes.versionNumber) || (docRef && docRef.versionNumber) || 1,
                    tipo: 'nueva_modificacion'
                };
            }

            _deps.alert('✅ Nueva versión documental registrada y revisión bienal renovada por 2 años.');
            returnToClientOrOrigin(accountId);
        } catch (err) {
            console.error('[ClientDocuments] Error en carga bienal:', err);
            _deps.alert('Error al incorporar actualización documental: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || '📤 Cargar Nueva Versión y Renovar Revisión Bienal';
            }
        }
    }

    async function submitBiennialExpress() {
        if (typeof document === 'undefined') return;
        const accountId = (document.getElementById('b3-biennial-account-id') || {}).value;
        const docKeySelect = document.getElementById('b3-biennial-doc-key');
        const targetDocKey = (docKeySelect && docKeySelect.value) ? docKeySelect.value : 'escritura';
        const notes = ((document.getElementById('b3-biennial-confirm-notes') || {}).value || '').trim();
        const checked = !!(document.getElementById('b3-biennial-confirm-check') || {}).checked;
        if (!accountId) return _deps.alert('ID de cuenta faltante');
        if (!checked) return _deps.alert('Debe marcar la confirmación expresa de haber consultado al cliente.');

        await confirmBiennialReviewWithoutChanges(accountId, targetDocKey, notes || 'Confirmación expresa del vendedor tras consulta al cliente: sin modificaciones.');
    }

    async function confirmBiennialReviewWithoutChanges(accountId, docKey = 'escritura', providedNotes = null) {
        if (providedNotes === null || providedNotes === undefined) {
            // Abrir vista de pantalla completa en lugar de usar confirm() emergente
            openBiennialConfirmationView(accountId, { docKey });
            return;
        }

        const docLabel = _deps.formatClientDocLabel(docKey);
        try {
            _deps.showLoading('Registrando confirmación de revisión bienal...');
            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.recordBiennialConfirmation !== 'function') {
                throw new Error('Módulo CrmAccountDocuments no disponible.');
            }

            const client = _deps.getClients().find(x => x.id === accountId) || {};
            const doc = (client.documentos && client.documentos[docKey]) || {};
            const verId = doc.versionId || 'v_base';

            const confRes = await CrmAccountDocuments.recordBiennialConfirmation(fb, {
                accountId,
                docKey,
                documentVersionId: verId,
                confirmationType: 'no_changes',
                confirmedNoChanges: true,
                notas: String(providedNotes).trim(),
                dbSuffix: _deps.getDbSuffix()
            });

            if (confRes && client.documentos && client.documentos[docKey] && typeof client.documentos[docKey] === 'object') {
                if (confRes.documentVersionId) client.documentos[docKey].versionId = confRes.documentVersionId;
                if (confRes.versionNumber) client.documentos[docKey].versionNumber = confRes.versionNumber;
            }
            if (confRes && client) {
                if (!client.biennialReviews) client.biennialReviews = {};
                client.biennialReviews[docKey] = {
                    confirmationId: confRes.confirmationId,
                    lastConfirmedAt: confRes.confirmedAt || new Date().toISOString(),
                    nextReviewAt: confRes.nextReviewAt || null,
                    confirmedBy: confRes.confirmedBy || null,
                    confirmedByName: confRes.confirmedByName || null,
                    documentVersionId: confRes.documentVersionId || verId,
                    versionNumber: confRes.versionNumber || 1,
                    confirmationType: 'no_changes'
                };
            }

            _deps.alert(`✅ Confirmación de revisión bienal registrada (sin modificaciones) para [${docLabel}]. Período renovado por 2 años.`);
            returnToClientOrOrigin(accountId);
        } catch (err) {
            console.error('[ClientDocuments] Error en confirmación bienal:', err);
            _deps.alert('Error al confirmar revisión bienal: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
        }
    }

    function openSubstituteDocView(clientId, docKey, docLabel = '', options = {}) {
        if (typeof document === 'undefined') return;
        _captureB3Origin(clientId, options);

        const label = docLabel || _deps.formatClientDocLabel(docKey);
        const client = _deps.getClients().find(x => x.id === clientId) || {};
        const existingDoc = (client.documentos && client.documentos[docKey]) || null;

        const accEl = document.getElementById('b3-subst-account-id');
        if (accEl) accEl.value = clientId;
        const keyEl = document.getElementById('b3-subst-doc-key');
        if (keyEl) keyEl.value = docKey;
        const lblEl = document.getElementById('b3-subst-doc-label');
        if (lblEl) lblEl.value = label;

        const titleEl = document.getElementById('b3-subst-view-title');
        if (titleEl) {
            titleEl.textContent = existingDoc
                ? `Sustituir Documento: ${label}`
                : `Cargar Documento al Expediente: ${label}`;
        }
        const subEl = document.getElementById('b3-subst-view-subtitle');
        if (subEl) {
            subEl.textContent = `Cuenta Comercial: ${client.empresa || `${client.nombres || ''} ${client.apellidos || ''}`.trim() || clientId}`;
        }

        const fileEl = document.getElementById('b3-subst-file');
        if (fileEl) fileEl.value = '';
        const vencEl = document.getElementById('b3-subst-fecha-vencimiento');
        if (vencEl) vencEl.value = (existingDoc && existingDoc.fechaVencimiento) || '';
        const motivoEl = document.getElementById('b3-subst-motivo');
        if (motivoEl) motivoEl.value = existingDoc ? '' : 'Incorporación inicial al expediente';
        const feedbackEl = document.getElementById('b3-subst-hash-feedback');
        if (feedbackEl) feedbackEl.innerHTML = '';

        const currentCard = document.getElementById('b3-subst-current-doc-card');
        if (currentCard) {
            if (existingDoc) {
                const currName = existingDoc.name || label;
                const currSha = existingDoc.sha256 ? `<code style="color:#38bdf8;">${_deps.escapeHtmlDoc(existingDoc.sha256)}</code>` : '<em>Sin hash previo</em>';
                currentCard.innerHTML = `
                    <div style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); border-radius:8px; padding:1rem;">
                        <div style="font-size:0.85rem; font-weight:700; color:#fbbf24; margin-bottom:4px;">📄 Versión Vigente Actual (Pasará a Historial de Versiones)</div>
                        <div style="font-size:0.8rem; color:white;">Archivo: <strong>${_deps.escapeHtmlDoc(currName)}</strong></div>
                        <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">Huella SHA-256 actual: ${currSha}</div>
                    </div>
                `;
            } else {
                currentCard.innerHTML = `
                    <div style="background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.3); border-radius:8px; padding:1rem;">
                        <div style="font-size:0.85rem; font-weight:700; color:#38bdf8;">➕ Primera Incorporación de [${_deps.escapeHtmlDoc(label)}]</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px;">Este documento se registrará como Versión 1 vigente en el expediente de la cuenta.</div>
                    </div>
                `;
            }
        }

        _navigateB3View('b3-substitute-doc-view');
    }

    async function onSubstFileChanged(inputEl) {
        if (typeof document === 'undefined') return;
        const feedbackEl = document.getElementById('b3-subst-hash-feedback');
        if (!feedbackEl) return;
        if (!inputEl || !inputEl.files || inputEl.files.length === 0) {
            feedbackEl.innerHTML = '';
            return;
        }
        const file = inputEl.files[0];
        const accountId = (document.getElementById('b3-subst-account-id') || {}).value;
        const docKey = (document.getElementById('b3-subst-doc-key') || {}).value;
        const client = _deps.getClients().find(x => x.id === accountId) || {};
        const existingDoc = (client.documentos && client.documentos[docKey]) || null;

        if (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function') {
            feedbackEl.innerHTML = '<span style="color:#94a3b8;">⏳ Calculando huella SHA-256...</span>';
            try {
                const sha = await CrmAccountDocuments.computeFileSha256(file);
                if (existingDoc && existingDoc.sha256 && sha && existingDoc.sha256 === sha) {
                    feedbackEl.innerHTML = `<div style="padding:8px 12px; background:rgba(239,68,68,0.15); border:1px solid #ef4444; border-radius:6px; color:#fca5a5;">
                        ⛔ <strong>Archivo idéntico detectado (Duplicado SHA-256):</strong> La huella <code>${sha.slice(0, 16)}…</code> coincide exactamente con la versión vigente actual. Seleccione un archivo actualizado.
                    </div>`;
                } else if (sha) {
                    feedbackEl.innerHTML = `<div style="padding:8px 12px; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); border-radius:6px; color:#6ee7b7;">
                        ✅ <strong>Huella SHA-256 única verificada:</strong> <code style="font-size:0.76rem;">${sha}</code>
                    </div>`;
                }
            } catch (_) {
                feedbackEl.innerHTML = '';
            }
        }
    }

    async function submitDocumentSubstitution() {
        if (typeof document === 'undefined') return;
        const accountId = (document.getElementById('b3-subst-account-id') || {}).value;
        const docKey = (document.getElementById('b3-subst-doc-key') || {}).value;
        const docLabel = (document.getElementById('b3-subst-doc-label') || {}).value || docKey;
        const fileEl = document.getElementById('b3-subst-file');
        const fechaVencimiento = ((document.getElementById('b3-subst-fecha-vencimiento') || {}).value || '').trim();
        const motivo = ((document.getElementById('b3-subst-motivo') || {}).value || '').trim();

        if (!accountId || !docKey) return _deps.alert('Datos de cuenta o tipo de documento incompletos.');
        if (!fileEl || !fileEl.files || fileEl.files.length === 0) return _deps.alert('Debe seleccionar un archivo.');
        if (!motivo) return _deps.alert('Debe especificar el motivo de carga o sustitución.');

        const file = fileEl.files[0];
        const client = _deps.getClients().find(x => x.id === accountId);
        if (!client) return _deps.alert('Cliente no encontrado.');

        const existingDoc = (client.documentos && client.documentos[docKey]) || null;
        const btn = document.getElementById('b3-btn-submit-subst');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '⏳ Verificando SHA-256 y subiendo...';
        }

        try {
            let sha = null;
            if (typeof CrmAccountDocuments !== 'undefined' && typeof CrmAccountDocuments.computeFileSha256 === 'function') {
                sha = await CrmAccountDocuments.computeFileSha256(file);
            }
            if (existingDoc && existingDoc.sha256 && sha && existingDoc.sha256 === sha) {
                return _deps.alert('⛔ Archivo duplicado rechazado: el documento seleccionado tiene exactamente el mismo hash SHA-256 que la versión vigente.');
            }

            _deps.showLoading('Subiendo nueva versión documental a Storage...');
            const isLegal = ['escritura', 'credencial', 'nit', 'nrc', 'mods_escritura'].includes(docKey);
            const docRef = await _deps.uploadFileToStorage(file, 'clientes', { clientId: accountId, isLegal });
            if (sha && docRef) docRef.sha256 = sha;
            if (fechaVencimiento && docRef) docRef.fechaVencimiento = fechaVencimiento;
            if (motivo && docRef) docRef.motivoSustitucion = motivo;

            const fb = _deps.getFirebase();
            if (typeof CrmAccountDocuments === 'undefined' || typeof CrmAccountDocuments.saveAccountDocument !== 'function') {
                throw new Error('Módulo CrmAccountDocuments.saveAccountDocument no disponible.');
            }
            const saveRes = await CrmAccountDocuments.saveAccountDocument(fb, {
                accountId,
                docKey,
                doc: docRef,
                motivoSustitucion: motivo,
                fechaVencimiento: fechaVencimiento || null,
                dbSuffix: _deps.getDbSuffix()
            });
            if (saveRes && docRef) {
                if (saveRes.versionId) docRef.versionId = saveRes.versionId;
                if (saveRes.versionNumber !== undefined) docRef.versionNumber = saveRes.versionNumber;
            }

            if (!client.documentos) client.documentos = {};
            client.documentos[docKey] = docRef;
            if (['escritura', 'mods_escritura'].includes(docKey)) {
                if (!client.biennialReviews) client.biennialReviews = {};
                client.biennialReviews[docKey] = {
                    lastConfirmedAt: new Date().toISOString(),
                    nextReviewAt: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
                    documentVersionId: (saveRes && saveRes.versionId) || (docRef && docRef.versionId) || null,
                    versionNumber: (saveRes && saveRes.versionNumber) || (docRef && docRef.versionNumber) || 1,
                    tipo: 'nueva_modificacion'
                };
            }

            _deps.alert(`✅ Documento [${docLabel}] actualizado y versionado exitosamente.`);
            returnToClientOrOrigin(accountId);
            _deps.renderClientsTable();
        } catch (err) {
            console.error('[ClientDocuments] Error en sustitución documental:', err);
            _deps.alert('Error al guardar documento: ' + (err.message || 'Error desconocido'));
        } finally {
            _deps.hideLoading();
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText || '📤 Guardar Nueva Versión Vigente';
            }
        }
    }

    async function openDossierHistoryView(clientId, options = {}) {
        if (typeof document === 'undefined') return;
        _captureB3Origin(clientId, options);
        const bodyEl = document.getElementById('b3-history-content');
        const subTitle = document.getElementById('b3-history-account-subtitle');
        if (!bodyEl) return;

        const client = _deps.getClients().find(x => x.id === clientId) || {};
        if (subTitle) {
            subTitle.textContent = `Cuenta Comercial: ${client.empresa || client.nombres || clientId} — Trazabilidad histórica completa`;
        }
        bodyEl.innerHTML = '<div style="text-align:center; padding:2.5rem; color:var(--text-muted);"><span style="font-size:1.5rem;">⏳</span><br>Recuperando expediente digital...</div>';

        _navigateB3View('b3-dossier-history-view');

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
                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                    <!-- Nombramientos de Representante Legal -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1.25rem;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:0.85rem;">
                            <h4 style="margin:0; font-size:1rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                                <span>⚖️</span> Historial de Representantes Legales (${terms.length})
                            </h4>
                            <button type="button" class="btn-secondary" style="font-size:0.76rem; padding:4px 10px;" onclick="ClientDocuments.openRLElectionView('${clientId}', { originView: '${_b3OriginContext.view}', prospectId: ${_b3OriginContext.prospectId ? `'${_b3OriginContext.prospectId}'` : 'null'} })">
                                + Registrar Nueva Elección RL
                            </button>
                        </div>
                        ${terms.length === 0 ? '<p style="font-size:0.84rem; color:var(--text-muted); margin:0;">Sin nombramientos registrados.</p>' : `
                            <div style="overflow-x:auto;">
                                <table class="table-compact" style="width:100%; font-size:0.82rem; text-align:left;">
                                    <thead>
                                        <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                            <th style="padding:8px;">Representante Legal</th>
                                            <th style="padding:8px;">Fecha Elección</th>
                                            <th style="padding:8px;">Vencimiento Credencial</th>
                                            <th style="padding:8px;">Estado</th>
                                            <th style="padding:8px;">Respaldo Documental</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${terms.map(t => `
                                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                                <td style="padding:8px; font-weight:600; color:white;">${_deps.escapeHtmlDoc(t.nombre)}</td>
                                                <td style="padding:8px;">${_deps.escapeHtmlDoc(t.fechaEleccion || '-')}</td>
                                                <td style="padding:8px;">${_deps.escapeHtmlDoc(t.fechaVencimiento || 'Indefinido')}</td>
                                                <td style="padding:8px;">
                                                    <span class="badge" style="background:${t.estado === 'vigente' ? 'rgba(16,185,129,0.2)' : 'rgba(148,163,184,0.15)'}; color:${t.estado === 'vigente' ? '#34d399' : '#94a3b8'};">
                                                        ${t.estado === 'vigente' ? '🟢 Vigente' : '⚪ Histórico / Cerrado'}
                                                    </span>
                                                </td>
                                                <td style="padding:8px;">
                                                    ${t.credencialDoc ? '<span class="badge bg-neutral" style="font-size:0.7rem;">📄 Credencial</span>' : ''}
                                                    ${t.duiDoc ? ' <span class="badge bg-neutral" style="font-size:0.7rem;">🪪 DUI</span>' : ''}
                                                </td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>

                    <!-- Poderes para Firma de Contratos -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1.25rem;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:0.85rem;">
                            <h4 style="margin:0; font-size:1rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                                <span>📜</span> Historial de Poderes para Firma de Contratos (${powers.length})
                            </h4>
                            <button type="button" class="btn-secondary" style="font-size:0.76rem; padding:4px 10px;" onclick="ClientDocuments.openGrantPowerView('${clientId}', { originView: '${_b3OriginContext.view}', prospectId: ${_b3OriginContext.prospectId ? `'${_b3OriginContext.prospectId}'` : 'null'} })">
                                + Registrar Apoderado
                            </button>
                        </div>
                        ${powers.length === 0 ? '<p style="font-size:0.84rem; color:var(--text-muted); margin:0;">Sin poderes registrados.</p>' : `
                            <div style="overflow-x:auto;">
                                <table class="table-compact" style="width:100%; font-size:0.82rem; text-align:left;">
                                    <thead>
                                        <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                            <th style="padding:8px;">Apoderado</th>
                                            <th style="padding:8px;">Fecha Registro</th>
                                            <th style="padding:8px;">Estado de Vigencia</th>
                                            <th style="padding:8px;">Trazabilidad / Motivo</th>
                                            <th style="padding:8px; text-align:right;">Acción</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${powers.map(pw => {
                                            const pwId = pw.id || pw.powerId;
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
                                                label = '🔴 Anulado por nueva elección de RL';
                                            } else if (pw.estado === 'revocado') {
                                                badgeColor = '#fbbf24';
                                                badgeBg = 'rgba(245,158,11,0.2)';
                                                label = '🟠 Revocado';
                                            }
                                            const pwDate = pw.fechaRegistro || (pw.documento && pw.documento.fechaOtorgamiento) || (pw.createdAt && typeof pw.createdAt === 'object' && (pw.createdAt._seconds || pw.createdAt.seconds) ? new Date((pw.createdAt._seconds || pw.createdAt.seconds) * 1000).toISOString().slice(0, 10) : (typeof pw.createdAt === 'string' ? pw.createdAt.slice(0, 10) : '-'));
                                            return `
                                                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                                    <td style="padding:8px; font-weight:600; color:white;">${_deps.escapeHtmlDoc(pw.nombreApoderado)}</td>
                                                    <td style="padding:8px;">${_deps.escapeHtmlDoc(pwDate)}</td>
                                                    <td style="padding:8px;">
                                                        <span class="badge" style="background:${badgeBg}; color:${badgeColor};">
                                                            ${label}
                                                        </span>
                                                    </td>
                                                    <td style="padding:8px; color:var(--text-muted); font-size:0.76rem;">
                                                        ${_deps.escapeHtmlDoc(pw.motivoRevocacion || pw.motivoAnulacion || pw.notas || '-')}
                                                    </td>
                                                    <td style="padding:8px; text-align:right;">
                                                        ${pw.estado === 'vigente' ? `
                                                            <button type="button" class="btn-secondary" style="font-size:0.72rem; padding:2px 8px; color:#f87171;" onclick="ClientDocuments.toggleInlineRevokePower('${pwId}')">Revocar</button>
                                                            <div id="b3-history-revoke-${pwId}" style="display:none; margin-top:6px; text-align:left;">
                                                                <input type="text" id="b3-hist-revoke-reason-${pwId}" placeholder="Motivo de revocación..." style="padding:4px 8px; font-size:0.74rem; background:rgba(0,0,0,0.4); border:1px solid #ef4444; border-radius:4px; color:white; width:180px;">
                                                                <button type="button" class="btn-primary" style="font-size:0.72rem; padding:3px 8px; background:#ef4444;" onclick="ClientDocuments.submitInlineRevokePower('${clientId}', '${pwId}', 'b3-hist-revoke-reason-${pwId}')">Confirmar</button>
                                                            </div>
                                                        ` : '-'}
                                                    </td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>

                    <!-- Confirmaciones Bienales -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:8px; padding:1.25rem;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:0.85rem;">
                            <h4 style="margin:0; font-size:1rem; color:var(--brand-gold); display:flex; align-items:center; gap:6px;">
                                <span>📆</span> Historial de Revisiones Bienales del Pacto Social (${confirmations.length})
                            </h4>
                            <button type="button" class="btn-secondary" style="font-size:0.76rem; padding:4px 10px;" onclick="ClientDocuments.openBiennialConfirmationView('${clientId}', { originView: '${_b3OriginContext.view}', prospectId: ${_b3OriginContext.prospectId ? `'${_b3OriginContext.prospectId}'` : 'null'} })">
                                + Registrar Confirmación Bienal
                            </button>
                        </div>
                        ${confirmations.length === 0 ? '<p style="font-size:0.84rem; color:var(--text-muted); margin:0;">Sin confirmaciones bienales registradas aún.</p>' : `
                            <div style="overflow-x:auto;">
                                <table class="table-compact" style="width:100%; font-size:0.82rem; text-align:left;">
                                    <thead>
                                        <tr style="border-bottom:1px solid var(--panel-border); color:var(--text-secondary);">
                                            <th style="padding:8px;">Tipo de Registro</th>
                                            <th style="padding:8px;">Documento y Versión Revisada</th>
                                            <th style="padding:8px;">Fecha Confirmación</th>
                                            <th style="padding:8px;">Usuario Responsable</th>
                                            <th style="padding:8px;">Próxima Revisión</th>
                                            <th style="padding:8px;">Detalle / Trazabilidad</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${confirmations.map(cf => `
                                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                                <td style="padding:8px;">
                                                    <span class="badge" style="background:${cf.confirmedNoChanges ? 'rgba(16,185,129,0.2)' : 'rgba(56,189,248,0.2)'}; color:${cf.confirmedNoChanges ? '#34d399' : '#38bdf8'};">
                                                        ${cf.confirmedNoChanges ? '📋 Confirmación Sin Cambios (Evento — Sin Archivo)' : '📄 Nueva Versión Documental Cargada'}
                                                    </span>
                                                </td>
                                                <td style="padding:8px; font-weight:600; color:white;">
                                                    ${_deps.escapeHtmlDoc(_deps.formatClientDocLabel(cf.docKey))}
                                                    <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">(v${_deps.escapeHtmlDoc(cf.versionNumber || 1)} · ${_deps.escapeHtmlDoc(cf.documentVersionId || '-')})</span>
                                                </td>
                                                <td style="padding:8px;">${_deps.escapeHtmlDoc(cf.confirmedAt ? cf.confirmedAt.slice(0, 10) : '-')}</td>
                                                <td style="padding:8px;">${_deps.escapeHtmlDoc(cf.confirmedByName || cf.confirmedBy)}</td>
                                                <td style="padding:8px; color:#34d399;">${_deps.escapeHtmlDoc(cf.nextReviewAt || '-')}</td>
                                                <td style="padding:8px; color:var(--text-secondary); font-size:0.76rem;">${_deps.escapeHtmlDoc(cf.notas || (cf.confirmedNoChanges ? 'Confirmado con cliente sin modificaciones' : 'Actualización documental incorporada'))}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
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
        // Block B3 Full-Screen Views & Actions
        getCurrentAccountId,
        returnToClientOrOrigin,
        closeRLElectionView: returnToClientOrOrigin,
        closeGrantPowerView: returnToClientOrOrigin,
        closeDossierHistoryView: returnToClientOrOrigin,
        closeBiennialConfirmationView: returnToClientOrOrigin,
        closeSubstituteDocView: returnToClientOrOrigin,
        previewFileHash,
        openRLElectionView,
        onRLContactSelected,
        submitLegalRepresentativeElection,
        openGrantPowerView,
        submitGrantContractPower,
        toggleInlineRevokePower,
        submitInlineRevokePower,
        revokeContractPower,
        openBiennialConfirmationView,
        submitBiennialUpload,
        submitBiennialExpress,
        confirmBiennialReviewWithoutChanges,
        openSubstituteDocView,
        onSubstFileChanged,
        submitDocumentSubstitution,
        openDossierHistoryView,
        _deps
    };

    if (typeof window !== 'undefined') {
        window.openRLElectionView = openRLElectionView;
        window.openGrantPowerView = openGrantPowerView;
        window.openDossierHistoryView = openDossierHistoryView;
        window.openBiennialConfirmationView = openBiennialConfirmationView;
        window.openSubstituteDocView = openSubstituteDocView;
        window.revokeContractPower = revokeContractPower;
        window.confirmBiennialReviewWithoutChanges = confirmBiennialReviewWithoutChanges;
        window.onRLContactSelected = onRLContactSelected;
        window.submitLegalRepresentativeElection = submitLegalRepresentativeElection;
        window.submitGrantContractPower = submitGrantContractPower;
    }

    return ClientDocuments;
});
