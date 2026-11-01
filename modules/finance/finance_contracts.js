// ============================================================================
// DUCTSAL ERP — FINANCE MODULE: CONTRACTS (Fase 6.4)
// Archivo: modules/finance/finance_contracts.js
// Responsabilidades:
// 1. Verificación de completitud legal del perfil de cliente para formalización.
// 2. Generación del Contrato Marco de Fabricación e Instalación de Ductería.
// 3. Renderizado en iframe de impresión (#print-iframe) y disparo de diálogo print.
// ============================================================================

(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        const api = factory();
        root.FinanceContracts = api;
        if (typeof window !== 'undefined') {
            window.FinanceContracts = api;
            window.generarContrato = api.generarContrato;
        }
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Dependencias inyectadas con fallbacks seguros
    // -------------------------------------------------------------------------
    const _deps = {
        getProspects: () => {
            if (typeof prospects !== 'undefined' && Array.isArray(prospects)) return prospects;
            if (typeof window !== 'undefined' && Array.isArray(window.prospects)) return window.prospects;
            return [];
        },
        getClients: () => {
            if (typeof clients !== 'undefined' && Array.isArray(clients)) return clients;
            if (typeof window !== 'undefined' && Array.isArray(window.clients)) return window.clients;
            return [];
        },
        openClientModal: (clientId) => {
            if (typeof openClientModal === 'function') return openClientModal(clientId);
            if (typeof window !== 'undefined' && typeof window.openClientModal === 'function') return window.openClientModal(clientId);
            const clientsMod = (typeof ClientsUI !== 'undefined') ? ClientsUI : (typeof window !== 'undefined' ? window.ClientsUI : null);
            if (clientsMod && typeof clientsMod.openClientModal === 'function') return clientsMod.openClientModal(clientId);
        }
    };

    /**
     * Genera el contrato marco de prestación de servicios para el proyecto y cliente.
     * Comprueba completitud de datos legales; si faltan, abre el modal del cliente.
     * @param {string} prospectId - Identificador de la oportunidad
     */
    function generarContrato(prospectId) {
        try {
            const prospectList = _deps.getProspects();
            const clientList = _deps.getClients();
            const p = prospectList.find(x => x && x.id === prospectId);
            if (!p) return alert("Error: Proyecto no encontrado.");
            const c = clientList.find(x => x && x.id === p.clientId);
            if (!c) return alert("Error: Cliente no encontrado.");

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

                nombreContrato = c.empresa || 'EL CLIENTE';
                clauseNosotros = `y por otra parte <span class="bold">${c.empresa || ''}</span>, que para efectos de este instrumento se denominará EL CLIENTE, representada por <span class="bold">${c.rep_legal || ''}</span>, mayor de edad, <span class="bold">${c.profesion_rep || ''}</span>, del domicilio de <span class="bold">${c.domicilio_rep || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui_rep || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit_rep || ''}</span>.`;
            } else {
                if (!c.nombres || !c.apellidos) missing.push("Nombres/Apellidos");
                if (!c.profesion) missing.push("Profesión");
                if (!c.domicilio) missing.push("Domicilio");
                if (!c.dui) missing.push("DUI");
                if (!c.nit) missing.push("NIT");

                nombreContrato = `${c.nombres || ''} ${c.apellidos || ''}`.trim() || 'EL CLIENTE';
                clauseNosotros = `y por otra parte <span class="bold">${nombreContrato}</span>, que para efectos de este instrumento se denominará EL CLIENTE, mayor de edad, <span class="bold">${c.profesion || ''}</span>, del domicilio de <span class="bold">${c.domicilio || ''}</span>, portador de Documento Único de Identidad número <span class="bold">${c.dui || ''}</span> y Número de Identificación Tributaria <span class="bold">${c.nit || ''}</span>.`;
            }

            if (missing.length > 0) {
                _deps.openClientModal(c.id);
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

            if (typeof document === 'undefined') return;
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
            alert("Ocurrió un error al generar el contrato: " + (e && e.message ? e.message : e));
        }
    }

    function setDeps(deps) {
        if (deps && typeof deps === 'object') {
            Object.assign(_deps, deps);
        }
    }

    // -------------------------------------------------------------------------
    // API Pública
    // -------------------------------------------------------------------------
    return {
        _deps,
        setDeps,
        generarContrato
    };
});
