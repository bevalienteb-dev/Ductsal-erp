// ============================================================================
// DUCTSAL ERP — DASHBOARD MODULE: AUDIT LISTENER (Fase 6.5.4)
// Archivo: modules/dashboard/dashboard_audit.js
// Responsabilidades:
// 1. Suscripción en tiempo real a bitácora de auditoría en Firestore (audit_logs).
// 2. Renderizado reactivo del panel de auditoría de eliminaciones para Gerencia.
// 3. Gestión idempotente del ciclo de vida del listener (window.auditUnsubscribe).
// 4. Formateo y sanitización segura de entradas de registro contra XSS.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.DashboardAudit = api;
        if (typeof window !== 'undefined') {
            window.DashboardAudit = api;
            window.fetchAuditLogs = api.fetchAuditLogs;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Estado local de suscripción a auditoría
    // -------------------------------------------------------------------------
    let _auditUnsubscribe = null;

    // -------------------------------------------------------------------------
    // 2. Dependencias inyectadas con fallbacks a globales
    // -------------------------------------------------------------------------
    const _deps = {
        getDb: () => {
            if (typeof db !== 'undefined') return db;
            if (typeof window !== 'undefined' && window.db) return window.db;
            return null;
        },
        getDbSuffix: () => {
            if (typeof DB_SUFFIX !== 'undefined') return DB_SUFFIX;
            if (typeof window !== 'undefined' && typeof window.DB_SUFFIX !== 'undefined') return window.DB_SUFFIX;
            return '';
        },
        getDocument: () => {
            if (typeof document !== 'undefined') return document;
            return null;
        },
        formatDate: (dateStr) => {
            if (typeof formatDate === 'function') return formatDate(dateStr);
            if (typeof window !== 'undefined' && typeof window.formatDate === 'function') return window.formatDate(dateStr);
            if (!dateStr) return '-';
            try {
                const d = new Date(dateStr);
                return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
            } catch (e) {
                return String(dateStr);
            }
        },
        escapeHtmlDoc: (str) => {
            if (typeof escapeHtmlDoc === 'function') return escapeHtmlDoc(str);
            if (typeof window !== 'undefined' && typeof window.escapeHtmlDoc === 'function') return window.escapeHtmlDoc(str);
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    };

    function setDeps(customDeps) {
        if (!customDeps || typeof customDeps !== 'object') return;
        Object.keys(customDeps).forEach(key => {
            if (typeof customDeps[key] === 'function') {
                _deps[key] = customDeps[key];
            } else {
                _deps[key] = () => customDeps[key];
            }
        });
    }

    // -------------------------------------------------------------------------
    // 3. Suscripción y Renderizado de Auditoría
    // -------------------------------------------------------------------------
    function fetchAuditLogs() {
        const doc = _deps.getDocument();
        if (!doc) return;

        const panel = doc.getElementById('audit-panel');
        if (panel) panel.style.display = 'block';

        const container = doc.getElementById('audit-logs-container');
        if (!container) return;

        // Comprobar si ya existe una suscripción activa (en variable interna o en window)
        const globalUnsub = (typeof window !== 'undefined' && window.auditUnsubscribe);
        if (_auditUnsubscribe || globalUnsub) return;

        const firestoreDb = _deps.getDb();
        if (!firestoreDb || typeof firestoreDb.collection !== 'function') {
            container.innerHTML = '<span style="color:var(--text-muted)">Base de datos no disponible para auditoría.</span>';
            return;
        }

        const dbSuffix = _deps.getDbSuffix();
        const formatDateFn = _deps.formatDate;
        const escapeHtml = _deps.escapeHtmlDoc;

        container.innerHTML = '<em>Cargando auditoría...</em>';

        try {
            const DB_SUFFIX = dbSuffix;
            const unsub = firestoreDb.collection(`audit_logs${DB_SUFFIX}`).orderBy('timestamp', 'desc').limit(20).onSnapshot(snap => {
                container.innerHTML = '';
                if (!snap || snap.empty) {
                    container.innerHTML = '<span style="color:var(--text-muted)">No hay alertas recientes de eliminación.</span>';
                    return;
                }
                let html = '';
                snap.forEach(docSnap => {
                    const data = docSnap.data() || {};
                    html += `
                        <div style="background: rgba(239, 68, 68, 0.1); border-left: 2px solid var(--danger); padding: 8px;">
                            <strong>${formatDateFn(data.fecha)}</strong> - <strong>${escapeHtml(data.usuario)}</strong> eliminó <strong>${escapeHtml(data.item)}</strong>
                            (${escapeHtml(data.detalle)}) en el proyecto <span style="color:var(--brand-gold)">${escapeHtml(data.proyectoNombre)}</span>.
                        </div>
                    `;
                });
                container.innerHTML = html;
            }, err => {
                console.warn('[CRM] Error en listener de auditoría:', err && err.message);
            });

            _auditUnsubscribe = unsub;
            if (typeof window !== 'undefined') {
                window.auditUnsubscribe = unsub;
            }
        } catch (e) {
            console.warn('[CRM] Excepción en fetchAuditLogs:', e && e.message);
        }
    }

    function unsubscribeAudit() {
        if (_auditUnsubscribe && typeof _auditUnsubscribe === 'function') {
            _auditUnsubscribe();
            _auditUnsubscribe = null;
        }
        if (typeof window !== 'undefined' && window.auditUnsubscribe) {
            if (typeof window.auditUnsubscribe === 'function') window.auditUnsubscribe();
            window.auditUnsubscribe = null;
        }
    }

    // -------------------------------------------------------------------------
    // 4. API Pública de Dashboard Audit
    // -------------------------------------------------------------------------
    return {
        setDeps,
        fetchAuditLogs,
        unsubscribeAudit,
        isSubscribed: () => !!(_auditUnsubscribe || (typeof window !== 'undefined' && window.auditUnsubscribe))
    };
});
