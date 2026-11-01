// functions/__tests__/stagingIsolation.unit.test.js
// Unit tests for Staging Environment Isolation and Preflight Guard.

const { assertSafeTargetProject, ALLOWED_TEST_PROJECTS, FORBIDDEN_PRODUCTION_PROJECTS } = require('../scripts/assertTargetProject');
const CrmStaging = require('../../crm_staging_config');
const { STAGING_USERS, STAGING_CLIENTS, STAGING_PROSPECTS } = require('../scripts/seedStagingEnvironment');

describe('Frente B: Aislamiento y Configuración de Staging (ductsal-erp-staging)', () => {

  describe('1. assertTargetProject Guard', () => {
    test('rechaza terminantemente el proyecto de producción (ductsal-erp)', () => {
      expect(() => assertSafeTargetProject('ductsal-erp')).toThrow();
    });

    test('rechaza dominios o variantes de producción', () => {
      expect(() => assertSafeTargetProject('ductsal-erp.firebaseapp.com')).toThrow();
      expect(() => assertSafeTargetProject('ductsal-erp.firebasestorage.app')).toThrow();
    });

    test('permite el proyecto oficial de staging ductsal-erp-staging', () => {
      expect(assertSafeTargetProject('ductsal-erp-staging')).toBe('ductsal-erp-staging');
    });

    test('permite proyectos demo de emuladores locales', () => {
      expect(assertSafeTargetProject('demo-ductsal-local')).toBe('demo-ductsal-local');
      expect(assertSafeTargetProject('demo-ductsal-isolated')).toBe('demo-ductsal-isolated');
    });

    test('rechaza proyectos desconocidos o arbitrarios', () => {
      expect(() => assertSafeTargetProject('otro-proyecto-desconocido')).toThrow();
    });
  });

  describe('2. crm_staging_config.js Frontend Guard', () => {
    test('detecta entorno staging por subdominio o parámetro', () => {
      expect(CrmStaging.isStagingRequested({ hostname: 'staging.ductsal.com' })).toBe(true);
      expect(CrmStaging.isStagingRequested({ hostname: 'ductsal-erp-staging.vercel.app' })).toBe(true);
      expect(CrmStaging.isStagingRequested({ hostname: 'localhost', search: '?env=staging' })).toBe(true);
      expect(CrmStaging.isStagingRequested({ hostname: 'erp.ductsal.com', search: '' })).toBe(false);
    });

    test('assertStagingIsolation aborta si la instancia Firebase apunta a producción', () => {
      const fakeProdApp = {
        app: () => ({ options: { projectId: 'ductsal-erp' } })
      };
      expect(() => CrmStaging.assertStagingIsolation(fakeProdApp)).toThrow(/CRITICAL MISCONFIGURATION/);
    });

    test('assertStagingIsolation acepta configuración de staging', () => {
      const fakeStagingApp = {
        app: () => ({ options: { projectId: 'ductsal-erp-staging' } })
      };
      expect(() => CrmStaging.assertStagingIsolation(fakeStagingApp)).not.toThrow();
    });
  });

  describe('3. Integridad del Dataset Sintético de Staging', () => {
    test('todos los usuarios sintéticos pertenecen al dominio de staging y tienen roles definidos', () => {
      expect(STAGING_USERS.length).toBeGreaterThanOrEqual(4);
      for (const u of STAGING_USERS) {
        expect(u.email).toMatch(/@ductsal\.com$/);
        expect(['manager', 'gestor', 'vendedor']).toContain(u.role);
        expect(u.id).toMatch(/^100000000000\d$/);
      }
    });

    test('los clientes sintéticos cuentan con expedientes jurídicos y naturales estructurados', () => {
      expect(STAGING_CLIENTS.length).toBe(2);
      const jur = STAGING_CLIENTS.find(c => c.tipo === 'juridica');
      const nat = STAGING_CLIENTS.find(c => c.tipo === 'natural');
      expect(jur).toBeDefined();
      expect(jur.documentos.escritura).toBeDefined();
      expect(nat).toBeDefined();
      expect(nat.documentos.dui).toBeDefined();
    });

    test('las oportunidades sintéticas cubren todas las etapas y escenarios críticos', () => {
      const etapas = STAGING_PROSPECTS.map(p => p.etapa);
      expect(etapas).toContain('levantamiento');
      expect(etapas).toContain('cotizacion');
      expect(etapas).toContain('negociacion');
      expect(etapas).toContain('cierre');

      // Oportunidad 4 tiene dispensa sin contrato activa para probar reversión
      const opCierre = STAGING_PROSPECTS.find(p => p.id === 'OP_STAGING_004');
      expect(opCierre.datos.autorizado_sin_contrato).toBe(true);
      expect(opCierre.aprobacion_sin_contrato.estado).toBe('aprobada');

      // Oportunidad 5 está ganada para probar bloqueo de reversión y métricas
      const opGanada = STAGING_PROSPECTS.find(p => p.id === 'OP_STAGING_005');
      expect(opGanada.estado).toBe('ganado');
      expect(opGanada.facturas.length).toBeGreaterThan(0);
    });
  });

});
