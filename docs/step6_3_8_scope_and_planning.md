# FASE 6.3.8 — ANÁLISIS DE ALCANCE, TRAZABILIDAD Y PLANIFICACIÓN DE EJECUCIÓN

**Iniciativa:** 6.3 — Arquitectura de Autenticación Nativa de Firebase, Eliminación de Contraseñas Provisionales y Gestión de Identidad  
**Fecha:** 2 de Noviembre de 2026 (21:32 CST / 03:32 UTC del 3 de Noviembre)  
**Proyecto:** DUCTSAL ERP (`ductsal-erp`, Project Number: `948658286825`)  
**Documento:** Plan de Ejecución y Matriz de Trazabilidad de Cierre para la Fase 6.3.8  
**Estado:** **PLANIFICACIÓN TÉCNICA COMPLETADA — EN ESPERA DE AUTORIZACIÓN EXPRESA PARA EJECUCIÓN**  

---

## 1. Declaración de Antecedentes y Ausencia de Definición Previa de 6.3.8

En estricto apego al mandato de verificación documental:
1. **Búsqueda Exhaustiva:** Se revisó la totalidad del repositorio y los informes de las fases 6.3.1 a 6.3.7.9.
2. **Constatación Formal:** **NO existe una definición previa ni entregables formalmente especificados para una subfase "6.3.8"** en la documentación previa.
3. **Contexto de Origen:** El roadmap original de la Iniciativa 6.3 concluía con las pruebas reales de la Fase 6.3.7. Las subdivisiones 6.3.7.1 a 6.3.7.9 se abrieron para diagnosticar la ausencia de DMARC, la investigación de identidad de marca (`%APP_NAME%`), la publicación en Network Solutions y el consumo controlado de los 3 envíos reales.
4. **Propósito Natural de 6.3.8:** Constituye la **fase de consolidación, verificación de no-regresión y cierre formal definitivo de toda la Iniciativa 6.3**, sirviendo como puente de salida hacia el despliegue del release.

---

## 2. Estado de la Iniciativa 6.3: Requisitos Originales vs. Implementación Actual

A partir de los objetivos fundacionales fijados en [docs/step6_3_1_firebase_native_email_audit.md](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_1_firebase_native_email_audit.md) y [docs/step6_3_2_firebase_native_email_design.md](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_2_firebase_native_email_design.md), se contrasta el estado actual de la plataforma:

### 2.1 Matriz de Trazabilidad y Cumplimiento

| N° | Requisito Original de la Iniciativa 6.3 | Fase de Implementación | Estado Actual Comprobado | Evidencia Técnica |
| :---: | :--- | :---: | :---: | :--- |
| **R1** | **Eliminación de Contraseñas Provisionales en Base de Datos:** Cero almacenamiento de contraseñas en texto plano en `users_prod`. | 6.2 / 6.3.2 | **COMPLETADO AL 100%** | Auditoría estática: Cero campos de contraseña en Firestore. Perfiles nacen con `invitation.status = 'pending'`. |
| **R2** | **Eliminación de Enlaces de Servidor (Admin SDK):** Eliminar llamadas a `generatePasswordResetLink()` en Cloud Functions para evitar generación dual. | 6.3.4.4 | **COMPLETADO AL 100%** | En `functions/index.js`, las funciones `createUserAdmin` y `resendInvitationAdmin` tienen 0 llamadas a `generatePasswordResetLink()`. |
| **R3** | **Cola Write-Ahead Local (Outbox):** Persistencia previa en cliente de tickets de invitación antes de emitir solicitudes de red. | 6.3.2 / 6.3.4 | **COMPLETADO AL 100%** | Implementado en `crm_outbox.js` con aislamiento por `managerAuthUid`, validación `assertNoSecrets` y TTL de 24h. |
| **R4** | **Despacho Nativo en Cliente (Client SDK):** Desacoplar el envío de correos al Client SDK (`auth.sendPasswordResetEmail`). | 6.3.4 | **COMPLETADO AL 100%** | En `crm_auth.js`, despacho delegado a Firebase Client SDK con `ActionCodeSettings` inmutable y normalización de correo. |
| **R5** | **Protección Anti-Enumeración de Usuarios:** Modal de autoservicio de recuperación sin revelar existencia de cuentas. | 6.3.4 / 6.3.6 | **COMPLETADO AL 100%** | Modal `#forgot-password-modal` en `index.html` y `app_core.js` con respuesta idéntica; `enableImprovedEmailPrivacy: true` en Firebase Auth. |
| **R6** | **Guardas Anti-Doble Envío:** Prevención de envíos múltiples accidentales por clics sucesivos en botones de interfaz. | 6.3.4 | **COMPLETADO AL 100%** | Guardas `userSaveInFlight`, `resetPassInFlight`, `forgotPasswordInFlight` en frontend; claves `opId` en backend. |
| **R7** | **Configuración de Dominio y Remitente Personalizado:** Configurar `auth.ductsal.com` como remitente de producción. | 6.3.6 | **COMPLETADO AL 100%** | `auth.ductsal.com` verificado y activo en Google Identity Platform (`useCustomDomain: true`); remitente `"DUCTSAL ERP" <noreply@auth.ductsal.com>`. |
| **R8** | **Autenticación Criptográfica Completa (SPF, DKIM, DMARC):** Blindar el dominio contra suplantación y cumplir directrices de correo moderno. | 6.3.7.5 / 6.3.7.8 | **COMPLETADO AL 100%** | **SPF PASS, DKIM PASS, DMARC PASS y Compauth PASS (reason=100)** certificados mediante encabezados originales de Microsoft 365. |
| **R9** | **Pruebas Reales Controladas:** Verificar recepción y comportamiento de correo nativo en buzón real de Grupo Gama. | 6.3.7.8 / 6.3.7.9 | **COMPLETADO AL 100%** | 3 de 3 envíos consumidos (100% del presupuesto). Enlaces nativos, token OOB y redirección probados con éxito. |

---

### 2.2 Requisitos Pendientes (Fuera del entorno local)
1. **Despliegue a Producción (Release Deployment):**  
   Los 15 archivos modificados y los 2 archivos nuevos (`crm_outbox.js`, `functions/invitationService.js`) permanecen retenidos localmente en el workspace de desarrollo. No se han publicado en Vercel ni en Firebase Cloud Functions.
2. **Smoke Test de Navegador Post-Deploy:**  
   Verificación visual interactiva en navegador real tras la publicación autorizada en Vercel, requerida para cerrar la observación de la prueba suspendida de Chrome/CDP (documentada en 6.3.6.4).

---

### 2.3 Observaciones No Bloqueantes Formalmente Aceptadas
1. **Resolución de `%APP_NAME%` como `ductsal-erp`:**  
   * **Causa técnica comprobada (Fase 6.3.7.6):** En aplicaciones que solo utilizan `Email/Password`, Firebase Auth carece de un objeto OAuth Brand vinculado y recurre por diseño al sitio predeterminado de Hosting (`ductsal-erp.web.app` / `ductsal-erp`).
   * **Decisión:** Mantener la configuración actual. El remitente visible `"DUCTSAL ERP" <noreply@auth.ductsal.com>` y el Reply-To garantizan la identidad corporativa. El asunto con `ductsal-erp` es una limitación cosmética no bloqueante.
2. **Clasificación en Junk (SCL: 5) en Microsoft 365:**  
   * **Causa técnica comprobada (Fase 6.3.7.8):** Falta de reputación acumulada del nuevo subdominio `auth.ductsal.com` en los algoritmos bayesianos de Microsoft Defender / Exchange Online Protection (*domain warming*). No es un problema de autenticación criptográfica.
   * **Decisión:** Transferir este tema como un **pendiente operativo de IT** (procedimiento de Safe Senders / Tenant Allow List en Microsoft 365 de Grupo Gama).

---

### 2.4 Riesgos Residuales y Mitigaciones
* **Riesgo:** Correos de invitación inicial para colaboradores nuevos podrían caer en Junk antes de que IT aplique el Safe Sender o madure la reputación del dominio.  
  *Mitigación:* Notificación operativa a gerencia indicando a los nuevos usuarios revisar la carpeta de correo no deseado durante la fase inicial de adopción.
* **Riesgo:** Desincronización del workspace por cambios locales acumulados.  
  *Mitigación:* Agrupación atómica de todos los cambios de la Iniciativa 6.3 en un commit de release trazable.

---

## 3. Propuesta de Ejecución para la Fase 6.3.8

### 3.1 Naturaleza de la Fase 6.3.8
> [!IMPORTANT]
> **DECLARACIÓN EXPRESA:**  
> **La Fase 6.3.8 NO requiere cambios de código, NO requiere modificaciones de configuración en Firebase Console, NO requiere cambios en DNS y NO enviará ningún correo electrónico.**  
> Todo el desarrollo y configuración ya está concluido y validado. La Fase 6.3.8 es estrictamente de **consolidación, verificación de no-regresión y cierre formal documental de la Iniciativa 6.3**.

---

### 3.2 Objetivo de la Fase 6.3.8
Consolidar el cierre técnico formal de la **Iniciativa 6.3 ("Autenticación Nativa Firebase y Gestión de Usuarios")**, verificando la no-regresión total del código local (2,333 pruebas), auditando la limpieza de Git, formalizando la guía de traspaso operativo a IT para Microsoft 365, y emitiendo el **Dictamen Definitivo de Aprobación de la Iniciativa 6.3**.

---

### 3.3 Alcance Funcional y Técnico
1. **Auditoría de No-Regresión Local:**
   - Ejecución de la suite completa de 2,272 pruebas unitarias de Cloud Functions (`npm test`).
   - Ejecución de las 61 pruebas especializadas de emuladores (`test:auth-env`, `test:ownership`, `test:native-auth`, `createUserAdmin.e2e.emu.js`).
   - Verificación de formateo y sintaxis con `git diff --check`.
2. **Guía de Traspaso Operativo a IT (Microsoft 365 / EOP):**
   - Redacción formal de la instrucción para el administrador de Microsoft 365 de Grupo Gama (cómo añadir `auth.ductsal.com` o `noreply@auth.ductsal.com` al *Tenant Allow/Block List* o *Mail Flow Rule* para evitar la carpeta Junk).
3. **Consolidación del Inventario de Artefactos de la Iniciativa 6.3:**
   - Listado final y justificación de los 15 archivos modificados y 2 archivos nuevos listos para el ciclo de release.
4. **Certificación del Presupuesto Real de Correo:**
   - Registro definitivo del consumo de 3/3 envíos y ratificación del bloqueo de nuevos envíos.
5. **Emisión del Dictamen Final de Cierre:**
   - Declaración de la Iniciativa 6.3 como **OFICIALMENTE COMPLETADA Y APROBADA**.

---

### 3.4 Archivos, Módulos y Servicios Involucrados
* **Código de Producción:** **0 modificaciones** (Permanecen intactos los archivos existentes).
* **Documento a Generar:** [`docs/step6_3_8_initiative_closure_report.md`](file:///Users/Benjamin/Documents/DUCTSAL/sales-reporting-system-release/docs/step6_3_8_initiative_closure_report.md).
* **Servicios Externos:** **Cero llamadas de escritura** (Firebase, Network Solutions, Microsoft 365 quedan en solo lectura).

---

### 3.5 Pruebas Necesarias en 6.3.8
* `npm test` en `functions/` (2,272 pruebas unitarias Jest).
* `npm run test:auth-env` (16 pruebas).
* `npm run test:ownership` (8 pruebas).
* `npm run test:native-auth` (18 pruebas).
* `npm run test:createUserAdmin` (19 pruebas E2E en emulador).
* `git diff --check` (0 observaciones de formato).
* **Total de pruebas a re-certificar:** **2,333 pruebas aprobadas (100%)**.

---

### 3.6 Criterios de Aceptación Verificables
- [ ] Trazabilidad completa R1 a R9 documentada y aprobada.
- [ ] 2,333 pruebas automatizadas ejecutadas y superadas sin fallos.
- [ ] `git diff --check` limpio (cero errores de formato).
- [ ] Presupuesto de pruebas de correo cerrado definitivamente en 3/3 (prohibición de 4° envío ratificada).
- [ ] Guía de traspaso operativo a IT formalizada.
- [ ] Cero despliegues o commits no autorizados.
- [ ] Dictamen final de cierre de Iniciativa 6.3 emitido.

---

## 4. Estado de Espera y Siguiente Paso

En estricto apego a las restricciones obligatorias, **no se ha ejecutado ninguna acción de implementación ni modificación**.

**Quedamos a la espera de la autorización expresa del usuario** para proceder con la ejecución de la Fase 6.3.8 bajo los términos presentados en este plan.
