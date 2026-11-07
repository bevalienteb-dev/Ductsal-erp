// ============================================================================
// DUCTSAL ERP — CORE: DOCUMENT & EXCEL VIEWER (Fase 6.1)
// Archivo: core/document_viewer.js
// Responsabilidad:
// 1. Resolución y validación estricta de rutas de Firebase Storage (SEC-05/SEC-10).
// 2. Previsualización modal de PDF, imágenes y texto plano.
// 3. Previsualización interactiva de libros de cálculo Excel (.xlsx, .xls) con SheetJS.
// 4. Descarga segura autorizada mediante Cloud Function getSecureDownloadUrlAdmin.
// 5. Historial de versiones documentales e inspección de auditoría.
// 6. Almacén de referencias en memoria (_docStore) y formateo de etiquetas legales.
// ============================================================================

(function (root) {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado y dependencias inyectables
    // -------------------------------------------------------------------------
    const _deps = {
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
            console.warn('[DocumentViewer] deleteClientDocument no disponible en el entorno');
            return null;
        },
        showLoading: (msg) => (typeof showLoading === 'function' ? showLoading(msg) : null),
        hideLoading: () => (typeof hideLoading === 'function' ? hideLoading() : null),
        alert: (msg) => {
            if (typeof window !== 'undefined' && window.CrmUI && typeof window.CrmUI.notify === 'function') {
                return window.CrmUI.notify('error', String(msg || ''));
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
                    }
                    banner.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; margin-bottom:12px; border-radius:6px; background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); color:#fca5a5; font-size:0.84rem;';
                    banner.textContent = String(msg || '');
                }
            }
        }
    };

    let _initialized = false;

    /**
     * Inicializa o reconfigura las dependencias externas del visor de documentos.
     * @param {Object} customDeps - Sobrescrituras opcionales de dependencias.
     */
    function initDocumentViewer(customDeps) {
        if (customDeps && typeof customDeps === 'object') {
            for (const key of Object.keys(customDeps)) {
                if (typeof customDeps[key] === 'function') {
                    _deps[key] = customDeps[key];
                } else {
                    _deps[key] = () => customDeps[key];
                }
            }
        }
        _initialized = true;
        return DocumentViewer;
    }

    // -------------------------------------------------------------------------
    // 2. Helpers y almacenamiento en memoria
    // -------------------------------------------------------------------------
    const escapeHtmlDoc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));

    if (typeof root !== 'undefined' && !root._docStore) {
        root._docStore = new Map();
    }

    /**
     * Resuelve y valida estrictamente una referencia de Storage para el entorno activo.
     * Retorna la ruta física canónica segura o null si no supera la validación.
     */
    function resolveStoragePath(docRef, envConfig = null) {
        if (!docRef) return null;

        const defaultPrefix = (typeof STORAGE_PREFIX !== 'undefined') ? STORAGE_PREFIX : 'prod_files';
        const prefix = (envConfig && envConfig.storagePrefix) ||
            ((typeof _deps !== 'undefined' && _deps.getStoragePrefix) ? _deps.getStoragePrefix() : defaultPrefix);

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
            `clients/[a-zA-Z0-9_-]+/(identificacion|legal|poderes)/.+|` +
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

    // -------------------------------------------------------------------------
    // 3. Descarga Segura Directa
    // -------------------------------------------------------------------------
    async function downloadSecureDocument(docRef, fallbackName = 'Documento', options = {}) {
        const safeAlert = (msg) => {
            if (typeof _deps !== 'undefined' && _deps.alert) return _deps.alert(msg);
            if (typeof alert === 'function') return alert(msg);
            console.warn('[Alert]', msg);
        };
        const safeShowLoading = (msg) => {
            if (typeof _deps !== 'undefined' && _deps.showLoading) return _deps.showLoading(msg);
            if (typeof showLoading === 'function') return showLoading(msg);
        };
        const safeHideLoading = () => {
            if (typeof _deps !== 'undefined' && _deps.hideLoading) return _deps.hideLoading();
            if (typeof hideLoading === 'function') return hideLoading();
        };

        if (!docRef) {
            safeAlert('No se especificó ningún documento para descargar.');
            return;
        }

        const storagePath = resolveStoragePath(docRef);
        const fileName = (typeof docRef === 'object' && docRef.name) ? docRef.name : fallbackName;

        if (!storagePath) {
            safeAlert(`La referencia de archivo no es válida en este entorno: ${fileName}`);
            return;
        }

        safeShowLoading(`Preparando descarga segura de ${fileName}...`);

        try {
            const fb = (typeof _deps !== 'undefined' && _deps.getFirebaseFunctions)
                ? _deps.getFirebaseFunctions()
                : ((typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null);

            if (!fb || typeof fb.httpsCallable !== 'function') {
                throw new Error('SDK de Firebase Functions no disponible en el cliente');
            }

            const fn = fb.httpsCallable('getSecureDownloadUrlAdmin');
            const dbSuffix = (typeof _deps !== 'undefined' && _deps.getDbSuffix)
                ? _deps.getDbSuffix()
                : (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod');

            const globalProspectId = (typeof _deps !== 'undefined' && _deps.getCurrentProspectId)
                ? _deps.getCurrentProspectId()
                : (typeof currentProspectId !== 'undefined' ? currentProspectId : null);

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
            if (typeof document !== 'undefined' && document.createElement) {
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = data.signedUrl;
                a.download = safeDownloadName;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    if (a.parentNode) a.parentNode.removeChild(a);
                }, 2000);
            }

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

            safeAlert(userMessage);
        } finally {
            safeHideLoading();
        }
    }

    // -------------------------------------------------------------------------
    // 4. Visualizador Principal y Control Modal
    // -------------------------------------------------------------------------
    async function viewSecureDocument(docRef, fallbackName = 'Documento', options = {}) {
        const safeAlert = (msg) => {
            if (typeof _deps !== 'undefined' && _deps.alert) return _deps.alert(msg);
            if (typeof alert === 'function') return alert(msg);
            console.warn('[Alert]', msg);
        };
        const safeShowLoading = (msg) => {
            if (typeof _deps !== 'undefined' && _deps.showLoading) return _deps.showLoading(msg);
            if (typeof showLoading === 'function') return showLoading(msg);
        };
        const safeHideLoading = () => {
            if (typeof _deps !== 'undefined' && _deps.hideLoading) return _deps.hideLoading();
            if (typeof hideLoading === 'function') return hideLoading();
        };

        if (!docRef) {
            safeAlert('No se especificó ningún documento.');
            return;
        }

        const storagePath = resolveStoragePath(docRef);
        const fileName = (typeof docRef === 'object' && docRef.name) ? docRef.name : fallbackName;

        if (!storagePath) {
            safeAlert(`El archivo no se encuentra disponible o la referencia no es válida en este entorno: ${fileName}`);
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
                if (typeof window !== 'undefined' && typeof window.open === 'function') {
                    previewTab = window.open('about:blank', '_blank');
                    if (previewTab && previewTab.document) {
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
                }
            } catch (e) {
                console.warn('[Storage Security] No se pudo abrir pestaña previa:', e);
            }
        }

        safeShowLoading(`Preparando documento ${fileName}...`);

        try {
            const fb = (typeof _deps !== 'undefined' && _deps.getFirebaseFunctions)
                ? _deps.getFirebaseFunctions()
                : ((typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null);

            if (!fb || typeof fb.httpsCallable !== 'function') {
                throw new Error('SDK de Firebase Functions no disponible en el cliente');
            }

            const fn = fb.httpsCallable('getSecureDownloadUrlAdmin');
            const dbSuffix = (typeof _deps !== 'undefined' && _deps.getDbSuffix)
                ? _deps.getDbSuffix()
                : (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod');

            const globalProspectId = (typeof _deps !== 'undefined' && _deps.getCurrentProspectId)
                ? _deps.getCurrentProspectId()
                : (typeof currentProspectId !== 'undefined' ? currentProspectId : null);

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
                if (typeof document !== 'undefined' && document.createElement) {
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = data.signedUrl;
                    a.download = safeDownloadName;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        if (a.parentNode) a.parentNode.removeChild(a);
                    }, 2000);
                }
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
                if (typeof fetch === 'function') {
                    const resp = await fetch(data.signedUrl);
                    if (resp.ok) {
                        const blob = await resp.blob();
                        const blobUrl = URL.createObjectURL(blob);
                        if (previewTab && !previewTab.closed) {
                            previewTab.location.href = blobUrl;
                            setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                            openedInline = true;
                        } else if (!hasPreviewModal && typeof window !== 'undefined' && typeof window.open === 'function') {
                            window.open(blobUrl, '_blank');
                            setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                            openedInline = true;
                        }
                    }
                }
            } catch (fetchErr) {
                console.warn('[Storage Security] Fetch directo a Blob no disponible; navegando a URL firmada segura:', fetchErr);
            }

            // Si fetch a Blob no fue posible (ej. CORS o navegador estricto), navegar directamente a la URL firmada
            if (!openedInline) {
                if (previewTab && !previewTab.closed) {
                    previewTab.location.href = data.signedUrl;
                } else if (!hasPreviewModal && typeof window !== 'undefined' && typeof window.open === 'function') {
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
            } else if (previewTab && !previewTab.closed && previewTab.document) {
                previewTab.document.write(`
                    <div style="padding:2rem; font-family:system-ui, sans-serif; color:#ef4444; background:#1e293b; height:100vh;">
                        <h3>⚠️ Error al abrir el documento</h3>
                        <p>${escapeHtmlDoc(userMessage)}</p>
                        <p style="font-size:0.8rem; color:#94a3b8;">Detalle técnico: ${escapeHtmlDoc(error.code || error.message || '')}</p>
                    </div>
                `);
            } else {
                safeAlert(userMessage);
            }
        } finally {
            safeHideLoading();
        }
    }

    function openDocPreviewModal(fileName, docRef, options) {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('docPreviewModal');
        if (!modal) return;
        const titleEl = document.getElementById('doc-preview-title');
        const badgeEl = document.getElementById('doc-preview-badge');
        const iconEl = document.getElementById('doc-preview-icon');
        const contentEl = document.getElementById('doc-preview-content');
        const dlBtn = document.getElementById('btn-doc-preview-download');

        if (typeof root !== 'undefined' && !root._docPreviewPreviousFocus) {
            const activeEl = document.activeElement;
            if (activeEl && activeEl !== document.body && activeEl !== modal) {
                root._docPreviewPreviousFocus = activeEl;
            }
        }

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

        if (typeof root !== 'undefined') {
            root._activeDocRef = docRef;
            root._activeDocOptions = options;
            root._activeDocName = fileName;

            if (document.body && document.body.style && root._docPreviewPrevBodyOverflow === undefined) {
                root._docPreviewPrevBodyOverflow = document.body.style.overflow || '';
                document.body.style.overflow = 'hidden';
            }

            if (typeof document.addEventListener === 'function') {
                if (root._docPreviewEscHandler && typeof document.removeEventListener === 'function') {
                    document.removeEventListener('keydown', root._docPreviewEscHandler);
                }
                root._docPreviewEscHandler = function (ev) {
                    if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) {
                        closeDocPreviewModal();
                    }
                };
                document.addEventListener('keydown', root._docPreviewEscHandler);
            }
        }

        modal.onclick = function (ev) {
            if (ev && ev.target === modal) {
                closeDocPreviewModal();
            }
        };

        if (modal.style) modal.style.display = 'block';
        if (modal.classList) {
            modal.classList.remove('closing');
            modal.classList.add('active');
        }
        if (typeof modal.setAttribute === 'function') {
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeDocPreviewModal() {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById('docPreviewModal');
        const contentEl = document.getElementById('doc-preview-content');
        const titleEl = document.getElementById('doc-preview-title');
        const badgeEl = document.getElementById('doc-preview-badge');
        const iconEl = document.getElementById('doc-preview-icon');
        const dlBtn = document.getElementById('btn-doc-preview-download');

        if (contentEl) {
            if (typeof contentEl.querySelectorAll === 'function') {
                const iframes = contentEl.querySelectorAll('iframe');
                if (iframes && iframes.forEach) {
                    iframes.forEach(frame => {
                        try {
                            const src = frame.getAttribute('src') || frame.src || '';
                            if (src && src.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                                URL.revokeObjectURL(src);
                            }
                            frame.src = 'about:blank';
                        } catch (_) {}
                    });
                }
                const mediaEls = contentEl.querySelectorAll('img, embed, object');
                if (mediaEls && mediaEls.forEach) {
                    mediaEls.forEach(el => {
                        try {
                            const src = el.getAttribute('src') || el.getAttribute('data') || el.src || '';
                            if (src && src.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                                URL.revokeObjectURL(src);
                            }
                        } catch (_) {}
                    });
                }
            }
            contentEl.innerHTML = '';
        }

        if (titleEl) titleEl.textContent = 'Documento';
        if (badgeEl) badgeEl.textContent = 'ARCHIVO';
        if (iconEl) iconEl.textContent = '📄';
        if (dlBtn) dlBtn.onclick = null;

        if (modal) {
            if (modal.style) modal.style.display = 'none';
            if (modal.classList) {
                modal.classList.remove('active', 'open');
            }
            if (typeof modal.setAttribute === 'function') {
                modal.setAttribute('aria-hidden', 'true');
            }
            modal.onclick = null;
        }

        if (typeof root !== 'undefined') {
            if (root._activePreviewBlobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                try { URL.revokeObjectURL(root._activePreviewBlobUrl); } catch (_) {}
                root._activePreviewBlobUrl = null;
            }
            if (root._docPreviewEscHandler && typeof document.removeEventListener === 'function') {
                document.removeEventListener('keydown', root._docPreviewEscHandler);
                root._docPreviewEscHandler = null;
            }
            if (document.body && document.body.style && root._docPreviewPrevBodyOverflow !== undefined) {
                document.body.style.overflow = root._docPreviewPrevBodyOverflow;
                delete root._docPreviewPrevBodyOverflow;
            }
            if (document.body && document.body.classList && typeof document.body.classList.remove === 'function') {
                document.body.classList.remove('modal-open');
            }
            root._activeWorkbook = null;
            root._activeWorkbookName = null;
            root._activeDocRef = null;
            root._activeDocOptions = null;
            root._activeDocName = null;

            const prevFocus = root._docPreviewPreviousFocus;
            root._docPreviewPreviousFocus = null;
            if (prevFocus && typeof prevFocus.focus === 'function') {
                try { prevFocus.focus(); } catch (_) {}
            }
        }
    }

    async function displayDocumentInModal(signedUrl, fileName, contentType, docRef, options) {
        if (typeof document === 'undefined') return;
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
        if (typeof document === 'undefined') return;
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

    // -------------------------------------------------------------------------
    // 5. Previsualización de Excel y SheetJS
    // -------------------------------------------------------------------------
    function loadXlsxLibrary() {
        return new Promise((resolve, reject) => {
            if (typeof XLSX !== 'undefined') return resolve(root.XLSX);
            if (typeof document === 'undefined') return reject(new Error('DOM no disponible para inyectar XLSX'));
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            script.onload = () => resolve(root.XLSX);
            script.onerror = () => reject(new Error('No se pudo cargar la librería XLSX desde la red.'));
            document.head.appendChild(script);
        });
    }

    async function renderExcelPreviewInModal(signedUrl, fileName) {
        if (typeof document === 'undefined') return;
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

            if (typeof root !== 'undefined') {
                root._activeWorkbook = workbook;
                root._activeWorkbookName = fileName;
            }

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
        if (typeof root === 'undefined' || !root._activeWorkbook || !root._activeWorkbook.SheetNames || !root._activeWorkbook.SheetNames[idx]) return;
        if (typeof document === 'undefined') return;
        const tabs = document.querySelectorAll('.excel-sheet-tab');
        tabs.forEach((t, i) => {
            if (i === idx) t.classList.add('active');
            else t.classList.remove('active');
        });
        renderSheetTable(root._activeWorkbook.SheetNames[idx]);
    }

    function renderSheetTable(sheetNameOrRows, maxRows = 500) {
        let rows;
        if (Array.isArray(sheetNameOrRows)) {
            rows = sheetNameOrRows;
        } else {
            const tableDiv = typeof document !== 'undefined' ? document.getElementById('excel-table-display') : null;
            const activeWb = (typeof root !== 'undefined' && root._activeWorkbook) ? root._activeWorkbook : null;
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
            const tableDiv = typeof document !== 'undefined' ? document.getElementById('excel-table-display') : null;
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
            const tableDiv = typeof document !== 'undefined' ? document.getElementById('excel-table-display') : null;
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

        const tableDiv = typeof document !== 'undefined' ? document.getElementById('excel-table-display') : null;
        if (tableDiv && !Array.isArray(sheetNameOrRows)) {
            tableDiv.innerHTML = finalHtml;
        }
        return finalHtml;
    }

    // -------------------------------------------------------------------------
    // 6. Formateo y Almacén de Documentos
    // -------------------------------------------------------------------------
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
        if (typeof root !== 'undefined') {
            if (!root._docStore) root._docStore = new Map();
            return root._docStore;
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
        const options = {};
        if (item.clientId) options.clientId = item.clientId;
        if (item.prospectId) options.prospectId = item.prospectId;
        if (item.entityType) options.entityType = item.entityType;
        if (item.entityId) options.entityId = item.entityId;
        return viewSecureDocument(item.docRef, item.fileName, options);
    }

    function downloadStoredClientDoc(storeId) {
        const store = getDocStore();
        const item = store ? store.get(storeId) : null;
        if (!item) return;
        const options = {};
        if (item.clientId) options.clientId = item.clientId;
        if (item.prospectId) options.prospectId = item.prospectId;
        if (item.entityType) options.entityType = item.entityType;
        if (item.entityId) options.entityId = item.entityId;
        return downloadSecureDocument(item.docRef, item.fileName, options);
    }

    function deleteStoredClientDoc(storeId) {
        const store = getDocStore();
        const item = store ? store.get(storeId) : null;
        if (!item) return;

        if (typeof _deps !== 'undefined' && typeof _deps.deleteClientDocument === 'function') {
            return _deps.deleteClientDocument(item.clientId, item.docKey, item.itemIndex);
        }
        if (typeof deleteClientDocument === 'function') {
            return deleteClientDocument(item.clientId, item.docKey, item.itemIndex);
        }
        if (typeof window !== 'undefined' && typeof window.deleteClientDocument === 'function') {
            return window.deleteClientDocument(item.clientId, item.docKey, item.itemIndex);
        }
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
        const user = (typeof _deps !== 'undefined' && _deps.getCurrentUser)
            ? _deps.getCurrentUser()
            : ((typeof currentUser !== 'undefined') ? currentUser : null);
        const isManager = user && user.role === 'manager';
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

    // -------------------------------------------------------------------------
    // 7. Historial de Versiones Documentales (Vista de Pantalla Completa)
    // -------------------------------------------------------------------------
    let _versionHistoryReturnOrigin = { view: 'client-detail-view', entityType: null, entityId: null };

    async function showDocumentVersionHistory(entityType, entityId, docKey, label) {
        if (typeof document === 'undefined') return;

        // Registrar vista de origen para el botón "← Volver"
        const detailViewEl = document.getElementById('detail-view');
        if (detailViewEl && detailViewEl.classList && typeof detailViewEl.classList.contains === 'function' && detailViewEl.classList.contains('active')) {
            _versionHistoryReturnOrigin = { view: 'detail-view', entityType, entityId };
        } else {
            _versionHistoryReturnOrigin = { view: 'client-detail-view', entityType, entityId };
        }

        let viewSection = document.getElementById('b3-doc-version-history-view');
        if (!viewSection && document.body && typeof document.createElement === 'function') {
            viewSection = document.createElement('section');
            viewSection.id = 'b3-doc-version-history-view';
            viewSection.className = 'view-section';
            viewSection.innerHTML = `
                <div class="card glass-panel" style="padding: 1.5rem;">
                    <h2 id="docVersionHistoryTitle">📜 Historial de Versiones</h2>
                    <div id="docVersionHistoryBody"></div>
                </div>
            `;
            document.body.appendChild(viewSection);
        }

        const titleEl = document.getElementById('docVersionHistoryTitle');
        const bodyEl = document.getElementById('docVersionHistoryBody');
        if (titleEl) titleEl.textContent = `📜 Historial de Versiones: ${label}`;
        if (bodyEl) bodyEl.innerHTML = `<div style="text-align:center; padding: 2rem; color: var(--text-secondary, #94a3b8);">⏳ Consultando historial de versiones...</div>`;

        if (typeof showView === 'function') {
            showView('b3-doc-version-history-view');
        } else if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
            AppRouter.showView('b3-doc-version-history-view');
        } else if (viewSection && viewSection.style) {
            viewSection.style.display = 'block';
        }

        try {
            const firestoreInstance = (typeof _deps !== 'undefined' && _deps.getFirestore)
                ? _deps.getFirestore()
                : ((typeof db !== 'undefined' && db) ? db : (typeof firebase !== 'undefined' && firebase.firestore ? firebase.firestore() : null));

            if (!firestoreInstance) throw new Error('Instancia de Firestore no disponible');

            const dbSuffix = (typeof _deps !== 'undefined' && _deps.getDbSuffix)
                ? _deps.getDbSuffix()
                : (typeof DB_SUFFIX !== 'undefined' ? DB_SUFFIX : '_prod');

            const entityCollection = entityType === 'client' ? `clients${dbSuffix}` : `prospects${dbSuffix}`;
            const subCollectionKey = 'document_versions';
            const snap = await firestoreInstance.collection(entityCollection).doc(entityId).collection(subCollectionKey).get();
            const allVersions = [];
            if (snap && typeof snap.forEach === 'function') {
                snap.forEach(docSnap => {
                    const data = docSnap.data();
                    if (!docKey || data.docKey === docKey) {
                        allVersions.push(data);
                    }
                });
            }

            const biennialConfirmations = [];
            if (entityType === 'client' && (!docKey || ['escritura', 'mods_escritura'].includes(docKey))) {
                try {
                    const confSnap = await firestoreInstance.collection(entityCollection).doc(entityId).collection('biennial_confirmations').get();
                    if (confSnap && typeof confSnap.forEach === 'function') {
                        confSnap.forEach(docSnap => {
                            const cData = docSnap.data();
                            if (!docKey || cData.docKey === docKey) {
                                biennialConfirmations.push(cData);
                            }
                        });
                    }
                    biennialConfirmations.sort((a, b) => String(b.confirmedAt || b.confirmadoEn || '').localeCompare(String(a.confirmedAt || a.confirmadoEn || '')));
                } catch (_confErr) {
                    // Subcolección opcional en entornos mock sin biennial_confirmations
                }
            }

            allVersions.sort((a, b) => {
                const vA = Number(a.versionNumber) || 0;
                const vB = Number(b.versionNumber) || 0;
                if (vB !== vA) return vB - vA;
                const tA = a.creadoEn || '';
                const tB = b.creadoEn || '';
                return tB.localeCompare(tA);
            });

            if (allVersions.length === 0 && biennialConfirmations.length === 0) {
                bodyEl.innerHTML = `
                    <div style="text-align: center; padding: 2rem; color: var(--text-secondary); background: rgba(255, 255, 255, 0.02); border-radius: 6px; border: 1px dashed var(--panel-border);">
                        <p style="margin: 0; font-size: 0.9rem;">ℹ️ No se registran versiones anteriores archivadas para este documento.</p>
                        <small style="color: var(--text-muted); display: block; margin-top: 4px;">El documento actual corresponde a la versión inicial o a un registro previo a la activación del versionado.</small>
                    </div>
                `;
                return;
            }

            let tableHtml = `
                <div style="margin-bottom: 0.5rem; font-size: 0.84rem; font-weight: 700; color: var(--brand-gold, #d4af37);">
                    📄 Versiones Documentales Cargadas (Archivos Adjuntos)
                </div>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 0.8rem; text-align: left;">
                        <thead>
                            <tr style="border-bottom: 2px solid var(--panel-border, #334155); color: var(--text-secondary, #94a3b8);">
                                <th style="padding: 8px;">Versión</th>
                                <th style="padding: 8px;">Estado</th>
                                <th style="padding: 8px;">Archivo</th>
                                <th style="padding: 8px;">Fecha</th>
                                <th style="padding: 8px;">Responsable</th>
                                <th style="padding: 8px;">Motivo de Sustitución</th>
                                <th style="padding: 8px; text-align: center;">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            for (const v of allVersions) {
                const isVigente = v.estado === 'vigente';
                const statusBadge = isVigente
                    ? `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--success, #10b981); border: 1px solid var(--success, #10b981); padding: 2px 6px; border-radius: 4px;">Vigente</span>`
                    : `<span class="badge" style="background: rgba(100, 116, 139, 0.2); color: #94a3b8; border: 1px solid #64748b; padding: 2px 6px; border-radius: 4px;">Histórica</span>`;

                const fileName = escapeHtmlDoc(v.name || 'Documento');
                const shaBadge = v.sha256 ? `<div style="font-size:0.68rem; color:#38bdf8; font-family:monospace;">SHA-256: ${escapeHtmlDoc(String(v.sha256).slice(0, 16))}…</div>` : '';
                const dateStr = v.creadoEn ? v.creadoEn.replace('T', ' ').slice(0, 16) : '-';
                const userStr = escapeHtmlDoc(v.subidoPorNombre || v.actualizadoPor || (v.esHeredado ? 'Registro anterior' : 'Comercial'));
                const motivoStr = escapeHtmlDoc(v.motivoSustitucion || (v.esHeredado ? 'Documento heredado de versiones anteriores' : 'Carga inicial'));

                const storeId = 'vdoc_' + Math.random().toString(36).substring(2, 9);
                getDocStore().set(storeId, {
                    docRef: v,
                    fileName: v.name || 'Documento',
                    clientId: entityType === 'client' ? entityId : (v.clientId || undefined),
                    prospectId: entityType === 'prospect' ? entityId : (v.prospectId || undefined),
                    entityType: entityType,
                    entityId: entityId
                });

                tableHtml += `
                    <tr style="border-bottom: 1px solid var(--panel-border, #334155); background: ${isVigente ? 'rgba(16, 185, 129, 0.04)' : 'transparent'};">
                        <td style="padding: 8px; font-weight: bold; color: ${isVigente ? 'var(--brand-gold, #d4af37)' : 'var(--text-secondary, #94a3b8)'};">v${v.versionNumber || 1}</td>
                        <td style="padding: 8px;">${statusBadge}</td>
                        <td style="padding: 8px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${fileName}">${fileName}${shaBadge}</td>
                        <td style="padding: 8px; white-space: nowrap; color: var(--text-muted, #64748b);">${dateStr}</td>
                        <td style="padding: 8px; color: var(--text-secondary, #94a3b8);">${userStr}</td>
                        <td style="padding: 8px; font-style: ${v.motivoSustitucion ? 'normal' : 'italic'}; color: ${v.motivoSustitucion ? 'var(--text-primary, white)' : 'var(--text-muted, #64748b)'};">${motivoStr}</td>
                        <td style="padding: 8px; text-align: center; white-space: nowrap;">
                            <button type="button" class="btn-secondary" style="padding: 2px 6px; font-size: 0.75rem; margin-right: 4px; cursor: pointer;" onclick="viewStoredClientDoc('${storeId}')" title="Ver archivo">👁️</button>
                            <button type="button" class="btn-secondary" style="padding: 2px 6px; font-size: 0.75rem; cursor: pointer;" onclick="downloadStoredClientDoc('${storeId}')" title="Descargar archivo">⬇️</button>
                        </td>
                    </tr>
                `;
            }

            tableHtml += `
                        </tbody>
                    </table>
                </div>
            `;

            if (biennialConfirmations.length > 0) {
                tableHtml += `
                    <div style="margin-top: 1.35rem; margin-bottom: 0.5rem; font-size: 0.84rem; font-weight: 700; color: #34d399;">
                        📋 Eventos de Confirmación de Revisión Bienal (Registro de Datos — Diferenciado de Versiones de Archivo)
                    </div>
                    <div style="overflow-x: auto;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 0.78rem; text-align: left;">
                            <thead>
                                <tr style="border-bottom: 2px solid var(--panel-border, #334155); color: var(--text-secondary, #94a3b8);">
                                    <th style="padding: 8px;">Tipo de Evento</th>
                                    <th style="padding: 8px;">Versión Revisada</th>
                                    <th style="padding: 8px;">Fecha Confirmación</th>
                                    <th style="padding: 8px;">Próxima Revisión</th>
                                    <th style="padding: 8px;">Usuario Responsable</th>
                                    <th style="padding: 8px;">Observación Registrada</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${biennialConfirmations.map(bc => {
                                    const isNoChanges = bc.confirmationType === 'no_changes' || bc.confirmationType === 'biennial_no_changes';
                                    const typeBadge = isNoChanges
                                        ? '<span class="badge" style="background:rgba(16,185,129,0.16); color:#34d399; border:1px solid rgba(16,185,129,0.4); padding:2px 6px; border-radius:4px;">📋 Confirmación Sin Cambios (Sin Archivo)</span>'
                                        : '<span class="badge" style="background:rgba(56,189,248,0.16); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); padding:2px 6px; border-radius:4px;">📄 Con Nueva Versión Adjunta</span>';
                                    return `
                                        <tr style="border-bottom: 1px solid var(--panel-border, #334155);">
                                            <td style="padding: 8px;">${typeBadge}</td>
                                            <td style="padding: 8px; font-weight: 600; color: #e2e8f0;">v${escapeHtmlDoc(String(bc.versionNumber || 1))} (${escapeHtmlDoc(bc.documentVersionId || '-')})</td>
                                            <td style="padding: 8px; color: var(--text-muted, #64748b);">${escapeHtmlDoc((bc.confirmedAt || bc.confirmadoEn || '').slice(0, 10) || '-')}</td>
                                            <td style="padding: 8px; color: #34d399; font-weight: 600;">${escapeHtmlDoc(bc.nextReviewAt || bc.proximaRevisionBienal || '-')}</td>
                                            <td style="padding: 8px; color: var(--text-secondary, #94a3b8);">${escapeHtmlDoc(bc.confirmedByName || bc.confirmadoPorNombre || bc.confirmedBy || bc.confirmadoPor || '-')}</td>
                                            <td style="padding: 8px; color: var(--text-muted, #64748b);">${escapeHtmlDoc(bc.notas || (isNoChanges ? 'Confirmación comercial de consulta al cliente: sin modificaciones al documento.' : 'Actualización documental incorporada.'))}</td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            }

            bodyEl.innerHTML = tableHtml;

        } catch (err) {
            console.error('Error al cargar historial de versiones:', err);
            bodyEl.innerHTML = `
                <div style="color: var(--danger, #ef4444); padding: 1.5rem; text-align: center;">
                    ❌ No se pudo cargar el historial de versiones: ${escapeHtmlDoc(err.message || 'Error de permisos o conexión')}.
                </div>
            `;
        }
    }

    function closeDocumentVersionHistory() {
        if (typeof document === 'undefined') return;
        const viewSection = document.getElementById('b3-doc-version-history-view');
        const targetView = (_versionHistoryReturnOrigin && _versionHistoryReturnOrigin.view) || 'client-detail-view';
        if (typeof showView === 'function') {
            showView(targetView);
        } else if (typeof AppRouter !== 'undefined' && typeof AppRouter.showView === 'function') {
            AppRouter.showView(targetView);
        } else if (viewSection && viewSection.style) {
            viewSection.style.display = 'none';
        }
    }

    // -------------------------------------------------------------------------
    // 8. API Pública y Fachada de Compatibilidad
    // -------------------------------------------------------------------------
    const DocumentViewer = {
        init: initDocumentViewer,
        escapeHtmlDoc,
        getDocStore,
        resolveStoragePath,
        PREVIEWABLE_EXTS,
        isExcelFormat,
        isFormatPreviewable,
        downloadSecureDocument,
        viewSecureDocument,
        openDocPreviewModal,
        closeDocPreviewModal,
        displayDocumentInModal,
        showDocPreviewError,
        loadXlsxLibrary,
        renderExcelPreviewInModal,
        selectExcelSheet,
        renderSheetTable,
        KNOWN_DOC_LABELS,
        formatClientDocLabel,
        viewStoredClientDoc,
        downloadStoredClientDoc,
        deleteStoredClientDoc,
        renderClientDocItem,
        showDocumentVersionHistory,
        closeDocumentVersionHistory
    };

    // Exposición en entorno global para retrocompatibilidad con handlers inline
    if (typeof root !== 'undefined') {
        root.DocumentViewer = DocumentViewer;
        root.initDocumentViewer = initDocumentViewer;
        root.escapeHtmlDoc = escapeHtmlDoc;
        root.resolveStoragePath = resolveStoragePath;
        root.downloadSecureDocument = downloadSecureDocument;
        root.viewSecureDocument = viewSecureDocument;
        root.openDocPreviewModal = openDocPreviewModal;
        root.closeDocPreviewModal = closeDocPreviewModal;
        root.displayDocumentInModal = displayDocumentInModal;
        root.showDocPreviewError = showDocPreviewError;
        root.loadXlsxLibrary = loadXlsxLibrary;
        root.renderExcelPreviewInModal = renderExcelPreviewInModal;
        root.selectExcelSheet = selectExcelSheet;
        root.renderSheetTable = renderSheetTable;
        root.KNOWN_DOC_LABELS = KNOWN_DOC_LABELS;
        root.formatClientDocLabel = formatClientDocLabel;
        root.getDocStore = getDocStore;
        root.viewStoredClientDoc = viewStoredClientDoc;
        root.downloadStoredClientDoc = downloadStoredClientDoc;
        root.deleteStoredClientDoc = deleteStoredClientDoc;
        root.renderClientDocItem = renderClientDocItem;
        root.showDocumentVersionHistory = showDocumentVersionHistory;
        root.closeDocumentVersionHistory = closeDocumentVersionHistory;
        root.isFormatPreviewable = isFormatPreviewable;
        root.isExcelFormat = isExcelFormat;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DocumentViewer;
    }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
