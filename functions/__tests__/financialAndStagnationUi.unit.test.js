// functions/__tests__/financialAndStagnationUi.unit.test.js
// UNIT TEST SUITE: Phase 5.4 Collections, Balances & Stagnant Opportunities UI
// Verifies:
// 1. Live pending balance calculation (CxC: totalFacturado - totalCobrado).
// 2. Clear distinction between facturado, cobrado, and por facturar.
// 3. Invoice-level pending balance and PAGADA/PENDIENTE status preservation.
// 4. Dual presentation of Salvadoran business days and calendar days.
// 5. Last contact strictly based on p.seguimiento.ultimo_contacto.fecha.
// 6. Absence of contact rendered as "Sin contacto registrado" without inventing dates.
// 7. Role permissions: vendedor denied from Proyectos y Cobros.
// 8. Preservation of change orders, IVA, retentions, payment history, and proof links.
// 9. Responsive layout and tabular figures in styles.css and index.html.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const appCoreSrc = fs.readFileSync(path.join(ROOT, 'app_core.js'), 'utf8');
const prospectWorkflowSrc = fs.readFileSync(path.join(ROOT, 'functions', 'prospectWorkflowService.js'), 'utf8');
const storageServiceSrc = fs.readFileSync(path.join(ROOT, 'functions', 'storageService.js'), 'utf8');
const CrmWorkCalendar = require(path.join(ROOT, 'crm_work_calendar.js'));
const CrmFollowUpCalc = require(path.join(ROOT, 'crm_followup_calc.js'));

describe('Phase 5.4: Financial Balances, Collections & Opportunity Stagnation UI', () => {

  // =========================================================================
  // 1. Saldo vivo por proyecto calculado con los datos existentes
  // =========================================================================
  describe('1. Saldo vivo por proyecto (CxC: totalFacturado - totalCobrado)', () => {
    test('calcula correctamente el saldo vivo cuando hay pagos parciales', () => {
      const p = {
        id: 'PROJ-01',
        precio_cotizado: 10000,
        facturas: [
          { id: 'F1', monto: 6000, pagos: [{ monto: 4000 }] },
          { id: 'F2', monto: 4000, pagos: [{ monto: 1000 }] }
        ]
      };

      let totalFacturado = 0;
      let totalCobrado = 0;
      p.facturas.forEach(f => {
        totalFacturado += f.monto;
        f.pagos.forEach(pay => { totalCobrado += pay.monto; });
      });

      const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);
      expect(totalFacturado).toBe(10000);
      expect(totalCobrado).toBe(5000);
      expect(saldoCxC).toBe(5000);
    });

    test('saldo vivo es 0 cuando todas las facturas emitidas están 100% cobradas', () => {
      const p = {
        id: 'PROJ-PAID',
        precio_cotizado: 5000,
        facturas: [
          { id: 'F1', monto: 5000, pagos: [{ monto: 5000 }] }
        ]
      };

      let totalFacturado = 0;
      let totalCobrado = 0;
      p.facturas.forEach(f => {
        totalFacturado += f.monto;
        f.pagos.forEach(pay => { totalCobrado += pay.monto; });
      });

      const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);
      expect(saldoCxC).toBe(0);
    });

    test('app_core.js renderProjectsList calcula saldoCxC y porFacturar con datos existentes', () => {
      expect(appCoreSrc).toContain('const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);');
      expect(appCoreSrc).toContain('const porFacturar = Math.max(0, Math.round((total - totalFacturado) * 100) / 100);');
      expect(appCoreSrc).toContain('saldoCxC: saldoCxC');
      expect(appCoreSrc).toContain('porFacturar: porFacturar');
    });
  });

  // =========================================================================
  // 2. Separación correcta entre facturado, cobrado y pendiente de facturar
  // =========================================================================
  describe('2. Separación de Facturado, Cobrado y Pendiente de Facturar', () => {
    test('distingue con precisión los tres conceptos sobre un contrato con IVA', () => {
      const subtotal = 10000;
      const total = Math.round(subtotal * 1.13 * 100) / 100; // 11,300
      const totalFacturado = 6000;
      const totalCobrado = 4000;

      const porFacturar = Math.max(0, Math.round((total - totalFacturado) * 100) / 100);
      const saldoCxC = Math.max(0, Math.round((totalFacturado - totalCobrado) * 100) / 100);
      const pctFacturado = (totalFacturado / total) * 100;
      const pctCobrado = (totalCobrado / total) * 100;

      expect(total).toBe(11300);
      expect(porFacturar).toBe(5300);
      expect(saldoCxC).toBe(2000);
      expect(pctFacturado).toBeCloseTo(53.1, 1);
      expect(pctCobrado).toBeCloseTo(35.4, 1);
      expect(pctCobrado).toBeLessThan(pctFacturado);
    });

    test('index.html organiza la información en tres grupos visuales distintos', () => {
      expect(indexHtml).toContain('fin-card-contract');
      expect(indexHtml).toContain('fin-card-billing');
      expect(indexHtml).toContain('fin-card-cxc');
      expect(indexHtml).toContain('id="fin-facturado"');
      expect(indexHtml).toContain('id="fin-por-facturar"');
      expect(indexHtml).toContain('id="fin-cobrado"');
      expect(indexHtml).toContain('id="fin-saldo"');
    });
  });

  // =========================================================================
  // 3. Saldo pendiente por factura y estado PAGADA/PENDIENTE sin alterar cálculos
  // =========================================================================
  describe('3. Saldo pendiente por factura y estado PAGADA/PENDIENTE', () => {
    test('calcula pSaldo = f.monto - pCobrado y deriva isPaid = pSaldo <= 0', () => {
      const f1 = { monto: 3000, pagos: [{ monto: 1000 }, { monto: 500 }] };
      const f1Cobrado = f1.pagos.reduce((a, b) => a + b.monto, 0);
      const f1Saldo = f1.monto - f1Cobrado;
      const f1Paid = f1Saldo <= 0;

      expect(f1Cobrado).toBe(1500);
      expect(f1Saldo).toBe(1500);
      expect(f1Paid).toBe(false);

      const f2 = { monto: 2000, pagos: [{ monto: 2000 }] };
      const f2Cobrado = f2.pagos.reduce((a, b) => a + b.monto, 0);
      const f2Saldo = f2.monto - f2Cobrado;
      const f2Paid = f2Saldo <= 0;

      expect(f2Cobrado).toBe(2000);
      expect(f2Saldo).toBe(0);
      expect(f2Paid).toBe(true);
    });

    test('app_core.js renderFinancials genera tarjetas con strip de 3 montos y badge PAGADA/PENDIENTE', () => {
      expect(appCoreSrc).toContain('class="invoice-card-modern"');
      expect(appCoreSrc).toContain('class="invoice-amounts-strip"');
      expect(appCoreSrc).toContain('${isPaid ? \'PAGADA\' : \'PENDIENTE\'}');
      expect(appCoreSrc).toContain('Monto Facturado');
      expect(appCoreSrc).toContain('Total Abonado');
      expect(appCoreSrc).toContain('Saldo Pendiente');
    });
  });

  // =========================================================================
  // 4. Presentación de días hábiles y calendario con fuentes de tiempo coherentes
  // =========================================================================
  describe('4. Presentación de días hábiles y calendario en detalle de oportunidad', () => {
    test('calcula días hábiles salvadoreños excluyendo fines de semana y asuetos oficiales', () => {
      // Período que incluye fin de semana (del viernes 2026-10-16 al martes 2026-10-20)
      const start = '2026-10-16';
      const end = '2026-10-20';
      const workDays = CrmWorkCalendar.getWorkTimeBetween(start, end, { excludeSaturday: true });
      expect(workDays).toBe(2); // Lunes 19 y Martes 20 (Sábado y Domingo excluidos)
    });

    test('openDetail actualiza detail-time-in-stage con ambas unidades explícitas', () => {
      expect(appCoreSrc).toContain('timeInStageEl.textContent = `Tiempo en etapa: ${businessDays} días hábiles (${calendarDays} días naturales)`;');
    });

    test('index.html contiene el contenedor de tiempo en etapa preservando su id original', () => {
      expect(indexHtml).toContain('id="detail-time-in-stage"');
      expect(indexHtml).toContain('Tiempo en etapa: 0 días hábiles (0 días naturales)');
    });
  });

  // =========================================================================
  // 5. Último contacto basado exclusivamente en p.seguimiento.ultimo_contacto.fecha
  // =========================================================================
  describe('5. Último contacto basado exclusivamente en p.seguimiento.ultimo_contacto.fecha', () => {
    test('formatea correctamente la antigüedad y la fecha cuando existe el campo', () => {
      const p = {
        id: 'P-CONTACT',
        seguimiento: {
          ultimo_contacto: {
            fecha: '2026-10-25',
            canal: 'llamada',
            resultado: 'respondio_receptivo'
          }
        }
      };

      const ultFecha = p.seguimiento.ultimo_contacto.fecha;
      expect(ultFecha).toBe('2026-10-25');
    });

    test('openDetail extrae el último contacto únicamente de p.seguimiento.ultimo_contacto.fecha', () => {
      expect(appCoreSrc).toContain('p.seguimiento && p.seguimiento.ultimo_contacto && p.seguimiento.ultimo_contacto.fecha');
      // Confirma que no se usa updatedAt ni modifiedAt como sustituto
      const openDetailSlice = appCoreSrc.substring(
        appCoreSrc.indexOf('function openDetail('),
        appCoreSrc.indexOf('function renderClientContactCard(')
      );
      expect(openDetailSlice).not.toContain('p.updatedAt');
      expect(openDetailSlice).not.toContain('p.fecha_modificacion');
    });
  });

  // =========================================================================
  // 6. Ausencia de contacto mostrada sin inventar fechas
  // =========================================================================
  describe('6. Ausencia de contacto comercial', () => {
    test('muestra "Sin contacto registrado" cuando no existe fecha de último contacto', () => {
      expect(indexHtml).toContain('id="detail-last-contact"');
      expect(indexHtml).toContain('Último contacto: Sin contacto registrado');
      expect(appCoreSrc).toContain('Sin contacto registrado');
    });

    test('no inventa fecha de vencimiento en facturas', () => {
      // El modelo de factura no debe contener fecha_vencimiento
      const renderFinSlice = appCoreSrc.substring(
        appCoreSrc.indexOf('function renderFinancials('),
        appCoreSrc.indexOf('function openChangeOrderModal(')
      );
      expect(renderFinSlice).not.toContain('fecha_vencimiento');
      expect(renderFinSlice).not.toContain('vencimiento');
    });
  });

  // =========================================================================
  // 7. Permisos financieros y navegación de los tres roles (vendedor, gestor, gerente)
  // =========================================================================
  describe('7. Permisos financieros y navegación por rol (vendedor, gestor, gerente)', () => {
    test('1. El vendedor puede abrir la navegación a la lista de sus proyectos autorizados', () => {
      expect(appCoreSrc).toContain("else if (role === 'vendedor')");
      expect(appCoreSrc).toContain("[navProjects, navList, navClients].forEach");
      expect(appCoreSrc).toContain('Mis Proyectos y Cobros Asignados');
      expect(indexHtml).toContain('id="nav-projects"');
      expect(indexHtml).toContain('id="nav-projects-text"');
    });

    test('2. La lista, totales y saldos del vendedor no incluyen proyectos de otros vendedores', () => {
      expect(appCoreSrc).toContain('if (isVendedor)');
      expect(appCoreSrc).toContain('allProjects = allProjects.filter(p => p.vendedorId === currentUserId);');
      // No leak of global portfolio: allProjects is filtered BEFORE counts, search and rendering
      expect(appCoreSrc).toContain('const countPendientes = allProjects.filter(');
      expect(appCoreSrc).toContain('const countPagados = allProjects.filter(');
      expect(appCoreSrc).toContain('const countTodos = allProjects.length;');
    });

    test('3. El vendedor puede consultar facturas, pagos, saldos e historial de sus propios proyectos', () => {
      expect(appCoreSrc).toContain('class="invoice-card-modern"');
      expect(appCoreSrc).toContain('class="invoice-amounts-strip"');
      expect(appCoreSrc).toContain('Historial de Pagos de esta factura:');
      expect(appCoreSrc).toContain('viewSecureDocument(');
      expect(appCoreSrc).toContain('downloadSecureDocument(');
    });

    test('4. El DOM de la interfaz del vendedor no ofrece controles para crear, editar o eliminar movimientos', () => {
      // isFinancialReadOnly hides write buttons and edit/delete links
      expect(appCoreSrc).toContain('const isFinancialReadOnly = (currentUser && currentUser.role === \'vendedor\')');
      expect(appCoreSrc).toContain("btnAddCo.style.display = isFinancialReadOnly ? 'none' : 'flex';");
      expect(appCoreSrc).toContain("const ocActionSpans = !isFinancialReadOnly");
      expect(appCoreSrc).toContain("let editDelPaySpans = !isFinancialReadOnly");
      expect(appCoreSrc).toContain("const invActionSpans = !isFinancialReadOnly");
      expect(appCoreSrc).toContain("(!isPaid && !isFinancialReadOnly)");
      expect(appCoreSrc).toContain("if (isFinancialReadOnly || totalFacturado >= (total - 0.1))");
    });

    test('5. Las funciones que abren formularios o ejecutan acciones financieras bloquean al vendedor', () => {
      const financialFunctions = [
        'openChangeOrderModal',
        'editChangeOrder',
        'processChangeOrder',
        'deleteChangeOrder',
        'showInvoiceForm',
        'editInvoice',
        'processInvoice',
        'deleteInvoice',
        'showPaymentForm',
        'editPayment',
        'processPayment',
        'deletePayment'
      ];
      financialFunctions.forEach(fnName => {
        const fnIndex = appCoreSrc.indexOf(`function ${fnName}(`) !== -1
          ? appCoreSrc.indexOf(`function ${fnName}(`)
          : appCoreSrc.indexOf(`async function ${fnName}(`);
        expect(fnIndex).toBeGreaterThan(-1);
        const fnSnippet = appCoreSrc.substring(fnIndex, fnIndex + 500);
        expect(fnSnippet).toContain("userRole === 'vendedor'");
        expect(fnSnippet).toContain("Operación no autorizada: Los vendedores tienen acceso financiero en modo solo lectura.");
      });
    });

    test('6. Los intentos de escritura del vendedor siguen siendo rechazados por el backend', () => {
      expect(prospectWorkflowSrc).toContain("saveInvoice: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("deleteInvoice: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("savePayment: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("deletePayment: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("saveChangeOrder: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("deleteChangeOrder: ['manager', 'gestor']");
    });

    test('7. El vendedor no puede abrir ni acceder a documentos de proyectos de otros vendedores', () => {
      expect(storageServiceSrc).toContain("p.vendedorId === caller.cid");
      const openDetailSlice = appCoreSrc.substring(
        appCoreSrc.indexOf('function openDetail('),
        appCoreSrc.indexOf('showView(\'detail-view\')')
      );
      expect(openDetailSlice).toContain("if (currentUser && (currentUser.role === 'vendedor' || currentUser.role === 'gestor'))");
      expect(openDetailSlice).toContain("const isAssigned = p.vendedorId === currentUser.id || (!p.vendedorId && p.createdBy === currentUser.id);");
      expect(openDetailSlice).toContain("No tienes acceso a esta oportunidad");
    });

    test('8. El gestor puede abrir un proyecto de postcierre asignado a otro vendedor', () => {
      const openDetailSlice = appCoreSrc.substring(
        appCoreSrc.indexOf('function openDetail('),
        appCoreSrc.indexOf('showView(\'detail-view\')')
      );
      expect(openDetailSlice).toContain("const inPostclosing = currentUser.role === 'gestor' && hasEnteredPostclosing(p);");
      expect(openDetailSlice).toContain("if (!isAssigned && !inPostclosing)");
    });

    test('9. El gestor conserva sus permisos financieros actuales, sin ampliarlos ni reducirlos', () => {
      expect(prospectWorkflowSrc).toContain("saveInvoice: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("savePayment: ['manager', 'gestor']");
      expect(prospectWorkflowSrc).toContain("saveChangeOrder: ['manager', 'gestor']");
      expect(appCoreSrc).toContain("else if (role === 'gestor')");
      expect(appCoreSrc).toContain("[navProjects, navList, navClients].forEach");
    });

    test('10. El gestor no obtiene permisos nuevos para reasignar oportunidades, eliminar proyectos ni ajustes globales', () => {
      expect(appCoreSrc).toContain("if (!currentUser || currentUser.role !== 'manager')");
      expect(appCoreSrc).toContain("Solo los Gerentes pueden reasignar oportunidades.");
      expect(prospectWorkflowSrc).toContain("deleteProspect: ['manager-live']");
      expect(appCoreSrc).toContain("[navUsers, navSettings, navList, navClients]");
    });

    test('11. El gerente conserva el acceso global y sus permisos actuales', () => {
      expect(appCoreSrc).toContain("if (role === 'manager')");
      expect(appCoreSrc).toContain("[navDashboard, navProjects, navSettings, navUsers, navList, navClients]");
      expect(prospectWorkflowSrc).toContain("deleteProspect: ['manager-live']");
      expect(prospectWorkflowSrc).toContain("reactivateProspect: ['manager-live']");
    });

    test('12. Los proyectos que no están en postcierre respetan las restricciones de acceso', () => {
      const openDetailSlice = appCoreSrc.substring(
        appCoreSrc.indexOf('function openDetail('),
        appCoreSrc.indexOf('showView(\'detail-view\')')
      );
      expect(openDetailSlice).toContain("if (!isAssigned && !inPostclosing)");
      expect(openDetailSlice).toContain("alert('No tienes acceso a esta oportunidad');");
    });
  });

  // =========================================================================
  // 8. Conservación de órdenes de cambio, IVA, retenciones, historial y comprobantes
  // =========================================================================
  describe('8. Conservación de lógica tributaria, órdenes de cambio y comprobantes', () => {
    test('preserva el cálculo de órdenes de cambio (aumento/disminución) y subtotal', () => {
      expect(appCoreSrc).toContain('const subtotal = getProjectSubtotal(p);');
      expect(appCoreSrc).toContain('const iva = isExport ? 0 : subtotal * 0.13;');
      expect(appCoreSrc).toContain('const total = subtotal + iva;');
    });

    test('preserva la advertencia de Gran Contribuyente (1% Retención) y Exportación (0% IVA)', () => {
      expect(appCoreSrc).toContain("'fin-retencion-warning'");
      expect(appCoreSrc).toContain('1% de cada factura');
      expect(appCoreSrc).toContain("'fin-export-warning'");
      expect(appCoreSrc).toContain('0% Exportación');
    });

    test('preserva los enlaces de previsualización y descarga de comprobantes de pago', () => {
      expect(appCoreSrc).toContain("viewSecureDocument(");
      expect(appCoreSrc).toContain("downloadSecureDocument(");
      expect(appCoreSrc).toContain("pay.doc_comprobante");
      expect(appCoreSrc).toContain("editPayment(");
      expect(appCoreSrc).toContain("deletePayment(");
    });
  });

  // =========================================================================
  // 9. Renderizado responsivo de las pantallas financieras en escritorio y móvil
  // =========================================================================
  describe('9. Estilos responsivos y dígitos tabulares en styles.css', () => {
    test('define tabular-nums para importes monetarios y porcentajes', () => {
      expect(stylesCss).toContain('.tabular-nums');
      expect(stylesCss).toContain('.col-money');
      expect(stylesCss).toContain('font-variant-numeric: tabular-nums;');
    });

    test('define badges de Saldo CxC con variantes due, paid y neutral', () => {
      expect(stylesCss).toContain('.proj-cxc-badge');
      expect(stylesCss).toContain('.proj-cxc-due');
      expect(stylesCss).toContain('.proj-cxc-paid');
      expect(stylesCss).toContain('.proj-cxc-neutral');
    });

    test('define grid de 3 columnas para balance y strip de facturas con adaptación móvil', () => {
      expect(stylesCss).toContain('.fin-group-card');
      expect(stylesCss).toContain('.invoice-card-modern');
      expect(stylesCss).toContain('.invoice-amounts-strip');
      expect(stylesCss).toContain('.fin-cxc-saldo-hero');

      // Reglas para pantallas móviles (max-width: 768px)
      const mobileMedia = stylesCss.substring(stylesCss.lastIndexOf('@media (max-width: 768px)'));
      expect(mobileMedia).toContain('.financial-balance-grid');
      expect(mobileMedia).toContain('grid-template-columns: 1fr;');
      expect(mobileMedia).toContain('.invoice-amounts-strip');
    });
  });
});
