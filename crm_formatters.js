// crm_formatters.js
// Funciones de formateo y utilidades puras para el ERP de DUCTSAL.
// Módulo independiente del DOM y de Firebase, compatible con navegador clásico y Node.js (CommonJS).

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.CrmFormatters = api;
        if (typeof root.formatCurrency === 'undefined') root.formatCurrency = api.formatCurrency;
        if (typeof root.formatDate === 'undefined') root.formatDate = api.formatDate;
        if (typeof root.normalizeWhatsAppNumber === 'undefined') root.normalizeWhatsAppNumber = api.normalizeWhatsAppNumber;
        if (typeof root.getDaysDifference === 'undefined') root.getDaysDifference = api.getDaysDifference;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    /**
     * Formatea un importe numérico como moneda estándar (MXN / es-MX).
     * Retorna "$0.00" si el valor es nulo, indefinido o vacío.
     */
    const formatCurrency = (val) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val || 0);

    /**
     * Formatea una fecha canónica a hora local de El Salvador o DD/MM/AAAA si es ISO YYYY-MM-DD.
     * Retorna '-' si el valor es nulo o inválido.
     */
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

    /**
     * Normaliza un número telefónico para enlaces de WhatsApp.
     * Elimina caracteres no numéricos y exige al menos 8 dígitos. Retorna null si no cumple.
     */
    function normalizeWhatsAppNumber(rawPhone) {
        if (!rawPhone || typeof rawPhone !== 'string') return null;
        const trimmed = rawPhone.trim();
        if (!trimmed) return null;
        const digitsOnly = trimmed.replace(/\D/g, '');
        if (!digitsOnly || digitsOnly.length < 8) return null;
        return digitsOnly;
    }

    /**
     * Calcula la diferencia en días enteros entre la fecha actual y la fecha proporcionada.
     */
    const getDaysDifference = (d1) => Math.floor((new Date() - new Date(d1)) / (1000 * 60 * 60 * 24));

    return {
        formatCurrency,
        formatDate,
        normalizeWhatsAppNumber,
        getDaysDifference
    };
});
