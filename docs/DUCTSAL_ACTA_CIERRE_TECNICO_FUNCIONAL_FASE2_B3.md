# DUCTSAL ERP — ACTA DE CIERRE TÉCNICO Y FUNCIONAL DE FASE 2: BLOQUE B3
## Documentos Legales y Fiscales, Representación Legal, Poderes Notariales y Control Documental

**Repositorio:** `bevalienteb-dev/Ductsal-erp`  
**Rama de Trabajo:** `feat/phase-2-b3-legal-fiscal-documents`  
**Rama Base:** `main` (Post-PR #8)  
**Fecha de Validación y Cierre:** 4 de noviembre de 2026  
**Entorno de Pruebas:** Local aislado — Firebase Emulator Suite (`demo-ductsal-local`) + Google Chrome 1440x900 (CDP)  
**Aislamiento Productivo:** Garantizado al 100%. Cero despliegues, cero escrituras, cero migraciones y cero conexiones a `ductsal-erp` (producción).  
**Estado de Entrega:** **LISTO PARA REVISIÓN (NO FUSIONADO / NO DESPLEGADO)**. En espera de revisión técnica y autorización expresa de Dirección.

---

## 1. RESUMEN EJECUTIVO

El presente documento certifica la finalización, verificación y auditoría exhaustiva del **Bloque B3 de la Fase 2** del CRM de DUCTSAL ERP, titulado **"Documentos legales y fiscales, representación legal, poderes y control documental"**, incluyendo la **Corrección Obligatoria de UI (Prohibición de POPUPS/MODALES y migración a vistas integradas de pantalla completa)**.

El desarrollo e integración de este bloque cumple estrictamente con las directrices contractuales, operativas, de interfaz y de seguridad establecidas por la Dirección:

1. **Arquitectura de Vistas Integradas de Pantalla Completa (Cero Popups / Cero Modales):**
   Siguiendo la directriz transversal de Dirección, se eliminó todo uso de modales, popups, diálogos flotantes o `prompt()` en el flujo **«Editar cliente»** y en **todos los flujos operativos de B3**, integrándolos como vistas nativas de pantalla completa (`.view-section` dentro de `<main>`) gestionadas por `AppRouter.showView` con encabezado contextual, navegación de retorno automático a la cuenta u oportunidad de origen y diseño responsive:
   - `#client-detail-view`: Vista de pantalla completa para «Editar cliente» / «Registrar cliente» y gestión integral del Expediente Documental y Societario.
   - `#b3-rl-election-view`: Vista de pantalla completa para registrar o cambiar Representante Legal e incorporar DUI y Credencial.
   - `#b3-grant-power-view`: Vista de pantalla completa para registrar apoderados e incorporar testimonios de poder notarial, más revocación inline con motivo sin `prompt()`.
   - `#b3-dossier-history-view`: Vista de pantalla completa para consultar el historial de representantes legales, historial de poderes y confirmaciones bienales.
   - `#b3-substitute-doc-view`: Vista de pantalla completa para cargar y sustituir documentos con verificación de huella SHA-256 en vivo.
   - `#b3-biennial-confirmation-view`: Vista de pantalla completa para registrar confirmaciones bienales del pacto social (Opción A: incorporar modificación; Opción B: declaración expresa sin cambios).
   - `#b3-doc-version-history-view`: Vista de pantalla completa para consultar el historial de versiones de cualquier documento.
   - Resolución de observaciones al cierre de oportunidades integrada con navegación directa a las vistas completas y retorno automático a `#detail-view`.
2. **100% Compatibilidad hacia Atrás con `DOC_KEYS` Canónicas:**
   Se conservan intactas las claves funcionales existentes (`escritura`, `mods_escritura`, `credencial`, `nit`, `nrc`, `dui`), incorporando la clave `poder_firma_contrato` como el único documento legal probatorio para facultades de firma de contratos mercantiles.
3. **Regla Fundamental de Anulación Atómica de Poderes Notariales:**
   Toda nueva elección o nombramiento de Representante Legal (RL) en una cuenta anula automática, atómica e irrevocablemente **todos** los poderes notariales para firma de contratos (`poder_firma_contrato`) otorgados bajo el período previo, **incluso si la misma persona natural resulta reelegida**.
4. **Control Anti-Duplicados y Detección de Archivos Expirados vía SHA-256:**
   Se computa y valida obligatoriamente la huella digital criptográfica SHA-256 de cada archivo en cliente y servidor. El backend rechaza intentos de renovar un documento expirado subiendo el mismo archivo idéntico o declarando fechas de vigencia no posteriores a la previa.
5. **Control Explícito de Contrato y Firmantes en Cierre Comercial:**
   La condición de requerir contrato formal es un campo explícito y controlado (`requiere_contrato: true`), nunca inferido del monto o nombre de la oportunidad. Si se requiere contrato, el cierre (`saveClosingDocuments` y `finalizeProspect`) valida atómicamente que el firmante designado (Representante Legal o Apoderado con poder notarial vigente) cuente con acreditación jurídica inalterada.
6. **Revisión Bienal de Estatutos (Pacto Social y Modificaciones):**
   Se implementó el ciclo de revisión cada 2 años para `escritura` y `mods_escritura`, ofreciendo Opción A (cargar nueva escritura/modificación inscrita) y Opción B (confirmación notarial expresa sin reformas, renovando la vigencia por 2 años más).
7. **Validación Exhaustiva Multi-Nivel:**
   - **Pruebas Unitarias de Backend y Auditoría UI:** 29/29 pruebas unitarias específicas de B3 aprobadas. Suite general completa: **97/97 suites aprobadas (2,439 pruebas, 0 fallos)**.
   - **Pruebas de Concurrencia Multi-Cliente en Emulador:** 4/4 escenarios de concurrencia real ejecutados contra Firebase Emulator Suite (`demo-ductsal-local`) aprobados con código 0.
   - **Regresión Cero en Concurrencia B1/B2:** 6/6 escenarios de la suite previa de concurrencia aprobados con código 0.
   - **Validación Automatizada en Navegador Real (CDP):** 8 flujos integrales verificados en Google Chrome Headless con aserción estricta `openModals.length === 0` en cada paso, capturando **14 evidencias visuales de pantalla completa** archivadas en `docs/screenshots/`.

---

## 2. COMPROMISO CRÍTICO DE NO DESPLIEGUE Y AISLAMIENTO PRODUCTIVO

En estricto cumplimiento con el protocolo de seguridad y las órdenes expresas de Dirección:

> [!CAUTION]
> **DECLARACIÓN FORMAL DE AISLAMIENTO PRODUCTIVO:**
> 1. **CERO DESPLIEGUES A PRODUCCIÓN:** No se ha ejecutado `firebase deploy`, `vercel --prod`, ni ningún comando de despliegue sobre el proyecto `ductsal-erp` ni los dominios productivos.
> 2. **CERO ESCRITURAS A BASE DE DATOS REMOTA:** Todas las pruebas, transacciones, escrituras y consultas se realizaron de forma 100% aislada en el entorno local de emuladores (`demo-ductsal-local`, Firestore en puerto 8080, Auth en puerto 9099, Functions en puerto 5001).
> 3. **CERO MIGRACIONES EN VIVO:** No se ha alterado ni modificado ningún documento en las colecciones `*_prod` de la infraestructura de producción.
> 4. **CERO FUSIONES A MAIN:** La rama de trabajo `feat/phase-2-b3-legal-fiscal-documents` permanece aislada en su propia rama hasta contar con la autorización formal por escrito de Dirección.

---

## 3. ARQUITECTURA TÉCNICA Y MODELO DE DATOS IMPLEMENTADO

### 3.1 Modelo de Datos en Firestore

Las entidades del Bloque B3 se estructuran de forma relacional y jerárquica bajo el cliente:

```mermaid
erDiagram
    CLIENTS ||--o{ LEGAL_REPRESENTATIVE_TERMS : "períodos de elección"
    CLIENTS ||--o{ CONTRACT_POWERS : "poderes notariales"
    CLIENTS ||--o{ BIENNIAL_CONFIRMATIONS : "confirmaciones bienales"
    CLIENTS ||--o{ DOCUMENT_VERSIONS : "versiones de archivos"
    PROSPECTS }|--|| CLIENTS : "cuenta asociada"

    CLIENTS {
        string id PK
        string tipo "natural | juridica"
        object representanteLegalVigente "proyección SSOT del RL"
        array apoderadosVigentes "lista de poderes activos"
        object documentos "metadatos actuales de DOC_KEYS"
    }

    LEGAL_REPRESENTATIVE_TERMS {
        string termId PK
        string accountId FK
        string contactId FK
        string nombre
        string cargo
        string fechaEleccion
        string fechaInicio
        string fechaVencimiento
        string estado "vigente | concluido | revocado"
        object credencialDoc
        object duiDoc
        string registradoPor
        timestamp createdAt
    }

    CONTRACT_POWERS {
        string id PK
        string accountId FK
        string contactId FK
        string nombreApoderado
        string termId FK "vínculo al período de RL"
        string estado "vigente | invalidado_por_nueva_eleccion | revocado"
        object documento
        string notas
        timestamp createdAt
    }

    BIENNIAL_CONFIRMATIONS {
        string id PK
        string accountId FK
        string docKey "escritura | mods_escritura"
        string versionId FK
        string confirmationType "no_changes | modification_uploaded"
        boolean confirmedNoChanges
        string opportunityId FK
        string notas
        timestamp confirmadoEn
    }
```

### 3.2 Servicio de Dominio Centralizado (`accountDocumentsService.js`)

Se diseñó e implementó `functions/accountDocumentsService.js` como el SSOT para la gestión documental de cuentas:

- **`registerLegalRepresentativeTerm`:** Registra un nuevo período de RL. Al activarse, busca atómicamente todos los nombramientos previos marcándolos como `concluido`, y busca todos los poderes notariales de la cuenta en estado `vigente`, actualizándolos atómicamente a `invalidado_por_nueva_eleccion` con auditoría completa.
- **`grantContractPower`:** Otorga facultades notariales para firma de contratos a una persona registrada en el catálogo de contactos de la cuenta. Requiere obligatoriamente un período de RL vigente y vincula el poder al `termId` activo.
- **`revokeContractPower`:** Permite revocar voluntariamente un poder notarial con motivo formal asentado en bitácora.
- **`recordBiennialConfirmation`:** Registra la revisión bienal de escritura/modificaciones (Opción A u Opción B), actualizando `ultimaRevisionBienal` en la ficha de la cuenta.
- **`saveAccountDocument`:** Controla la subida de versiones de documentos canónicos (`DOC_KEYS`), aplicando validación SHA-256 contra versiones previas para evitar re-subida de archivos expirados idénticos.
- **`validateAccountDocumentsForOpportunityClose`:** Pre-valida en backend si una oportunidad en etapa de Cierre cumple con todos los requisitos documentales, legales y fiscales antes de proceder a la firma y cobro.
- **`getAccountDossier`:** Retorna el expediente estructurado con historial completo de nombramientos de RL, poderes otorgados y anulados, confirmaciones bienales y versiones documentales.

---

## 4. REGLAS DE SEGURIDAD (FIRESTORE & STORAGE)

### 4.1 Firestore Rules (`firestore.rules`)

Se agregaron los bloques de control de acceso para las nuevas subcolecciones bajo `/clients_prod/{clientId}`:

```text
// Subcolecciones B3 bajo cuentas de clientes
match /clients_prod/{clientId} {
  // Representación Legal (términos de nombramiento)
  match /legal_representative_terms/{termId} {
    allow read: if isClientVisible(clientId);
    allow write: if false; // Solo mediante Cloud Functions transaccionales
  }

  // Poderes notariales para firma de contratos
  match /contract_powers/{powerId} {
    allow read: if isClientVisible(clientId);
    allow write: if false; // Solo mediante Cloud Functions transaccionales
  }

  // Confirmaciones bienales de estatutos sociales
  match /biennial_confirmations/{confId} {
    allow read: if isClientVisible(clientId);
    allow write: if false; // Solo mediante Cloud Functions transaccionales
  }
}
```

### 4.2 Storage Rules (`storage.rules`)

Se protegió la subcarpeta de poderes notariales y se autorizaron extensiones seguras (PDF, imágenes) hasta 25 MiB:

```text
// Poderes notariales para firma de contratos
match /prod_files/clients/{cid}/poderes/{file} {
  allow read: if isClientVisible(cid);
  allow write: if isManager()
               && isValidUpload(25)
               && allowedExtensionFor('poderes', file);
}
```

---

## 5. RESUMEN DE PRUEBAS Y RESULTADOS

### 5.1 Pruebas Unitarias de Backend y Auditoría de UI (`Jest`)

Se ejecutó la suite completa de pruebas unitarias en `functions/`:

- **Suite B3 (`__tests__/accountDocuments.unit.test.js`):** **29/29 pruebas aprobadas (100%)**.
  - Catálogo canónico y compatibilidad de claves `DOC_KEYS` (6 claves intactas + `poder_firma_contrato`).
  - Registro de nombramiento de RL y validación cronológica de credenciales.
  - Otorgamiento de poderes e invalidación automática ante nueva elección de RL (reelección u otra persona).
  - Control de huella SHA-256 contra re-subida de archivos expirados idénticos.
  - Revisión bienal (Opción A vs Opción B).
  - Pre-validación de cierre con control explícito de contrato y firmante acreditado.
  - Seguridad, roles y aislamiento de cartera comercial.
  - **Auditoría de UI B3 y Editar Cliente (Prohibición de Popups y Vistas de Pantalla Completa):** Verificación automatizada de que las 7 vistas operativas (`#client-detail-view`, `#b3-rl-election-view`, `#b3-grant-power-view`, `#b3-dossier-history-view`, `#b3-biennial-confirmation-view`, `#b3-substitute-doc-view`, `#b3-doc-version-history-view`) existen como `.view-section` dentro de `<main>`, sin modales flotantes ni llamadas a `prompt()`.
- **Suite General del Repositorio:** **97/97 suites aprobadas (2,439 pruebas, 0 fallos)**.

### 5.2 Pruebas de Concurrencia Multi-Cliente en Firebase Emulator Suite

Se ejecutó la suite `b3_concurrency.emu.js` simulando condiciones de carrera reales en Firestore Emulator:

| # | Escenario de Concurrencia | Condición Evaluada | Resultado |
|---|---|---|:---:|
| 1 | Otorgamiento de Poder vs Nueva Elección de RL | Un admin otorga un poder mientras otro admin registra nueva elección de RL simultáneamente. Se verifica la anulación atómica y la consistencia de `apoderadosVigentes`. | **APROBADO** |
| 2 | Elecciones Concurrentes de Representante Legal | Dos admins registran nombramientos de RL al mismo milisegundo. Se verifica que resulte exactamente un RL `vigente` y cero inconsistencias de estado. | **APROBADO** |
| 3 | Cierre de Oportunidad con Poder Invalidado Concurrentemente | Un vendedor intenta cerrar la oportunidad con un apoderado cuyo poder es anulado concurrentemente por una elección de RL. La función `finalizeProspect` rechaza el cierre con `failed-precondition`. | **APROBADO** |
| 4 | Confirmaciones Bienales Concurrentes | Dos usuarios registran confirmaciones de revisión bienal al mismo tiempo. Se preservan ambas en la auditoría sin corrupción de metadatos. | **APROBADO** |

**Resultado Suite B3 Concurrencia:** **4/4 pruebas aprobadas (código de salida 0)**.  
**Resultado Suite B1/B2 Concurrencia (Regresión Cero):** **6/6 pruebas aprobadas (código de salida 0)**.

---

## 6. VALIDACIÓN EN NAVEGADOR REAL (GOOGLE CHROME HEADLESS VÍA CDP — VISTAS DE PANTALLA COMPLETA)

Se ejecutó el script automatizado `scripts/verify_b3_browser_real.js` conectándose directamente al motor de Chrome vía Chrome DevTools Protocol (CDP) sobre la aplicación DUCTSAL ERP servida localmente con el Firebase Emulator Suite (`demo-ductsal-local`).

En cada paso se verificó programáticamente que la vista activa sea una `.view-section` integrada en `<main>` y que existan **0 modales flotantes abiertos (`openModals.length === 0`)**, generando **14 evidencias visuales de pantalla completa**.

### 6.1 Matriz de Evidencias Visuales Paso a Paso (Cero Modales)

| Archivo de Captura | Vista Activa (`.view-section`) | Descripción Técnica y Funcional | Estado |
|---|---:|---|:---:|
| [`b3_01_expediente_documental_b3.png`](screenshots/b3_01_expediente_documental_b3.png) | `#client-detail-view` | Vista de Pantalla Completa «Editar Cliente» y Expediente Documental B3 con encabezado contextual de cuenta y navegación integrada. | **CONFORME** |
| [`b3_02_vista_eleccion_rl.png`](screenshots/b3_02_vista_eleccion_rl.png) | `#b3-rl-election-view` | Vista de Pantalla Completa de Registro / Cambio de Representante Legal con incorporación de DUI y Credencial y advertencia de invalidación de poderes. | **CONFORME** |
| [`b3_03_rl_registrado_vigente.png`](screenshots/b3_03_rl_registrado_vigente.png) | `#client-detail-view` | Retorno automático a la ficha de cliente: Representante Legal (Ana Gómez) con estado vigente y credenciales inscritas. | **CONFORME** |
| [`b3_04_vista_otorgar_poder.png`](screenshots/b3_04_vista_otorgar_poder.png) | `#b3-grant-power-view` | Vista de Pantalla Completa para Registrar Apoderados e incorporar testimonio de Poder Notarial para Firma de Contratos. | **CONFORME** |
| [`b3_05_poder_vigente_acreditado.png`](screenshots/b3_05_poder_vigente_acreditado.png) | `#client-detail-view` | Apoderado (Carlos López) acreditado con poder notarial vigente en la ficha de cliente (con opción de revocación inline sin popups). | **CONFORME** |
| [`b3_06_nueva_eleccion_invalida_poderes.png`](screenshots/b3_06_nueva_eleccion_invalida_poderes.png) | `#client-detail-view` | **Regla Fundamental:** Nueva elección de RL (Mario Santos) anula atómicamente todos los poderes previos (0 poderes vigentes). | **CONFORME** |
| [`b3_07_historial_b3_poderes_anulados.png`](screenshots/b3_07_historial_b3_poderes_anulados.png) | `#b3-dossier-history-view` | Vista de Pantalla Completa de Historial de Representantes Legales, Poderes y Revisiones Bienales con trazabilidad de anulación. | **CONFORME** |
| [`b3_08_cierre_requiere_contrato.png`](screenshots/b3_08_cierre_requiere_contrato.png) | `#detail-view` | Oportunidad comercial en etapa Cierre: activación de `requiere_contrato` y botones de resolución directa en vistas completas. | **CONFORME** |
| [`b3_09_bloqueo_cierre_sin_poder_valido.png`](screenshots/b3_09_bloqueo_cierre_sin_poder_valido.png) | `#detail-view` | Bloqueo preventivo: advertencia visual al seleccionar apoderado en una cuenta que no tiene poderes vigentes y accesos rápidos a vistas B3. | **CONFORME** |
| [`b3_10_prevalidacion_b3_exitosa.png`](screenshots/b3_10_prevalidacion_b3_exitosa.png) | `#detail-view` | Pre-validación exitosa con Cloud Function: expediente al día y firmante (Mario Santos - RL) acreditado. | **CONFORME** |
| [`b3_11_oportunidad_ganada_con_contrato_b3.png`](screenshots/b3_11_oportunidad_ganada_con_contrato_b3.png) | `#detail-view` | Cierre definitivo: Oportunidad P1 marcada como **GANADA** con requerimiento de contrato formal satisfecho. | **CONFORME** |
| [`b3_12_confirmacion_bienal_renovada.png`](screenshots/b3_12_confirmacion_bienal_renovada.png) | `#b3-biennial-confirmation-view` | Vista de Pantalla Completa de Confirmación Bienal (Opción A: Modificación Estatutaria y Opción B: Declaración Expresa sin Cambios). | **CONFORME** |
| [`b3_13_vista_sustitucion_documento.png`](screenshots/b3_13_vista_sustitucion_documento.png) | `#b3-substitute-doc-view` | Vista de Pantalla Completa para Cargar / Sustituir Documentos con cálculo de huella SHA-256 en tiempo real. | **CONFORME** |
| [`b3_14_vista_historial_versiones.png`](screenshots/b3_14_vista_historial_versiones.png) | `#b3-doc-version-history-view` | Vista de Pantalla Completa de Historial de Versiones Documentales (sustituyendo el antiguo modal flotante). | **CONFORME** |

### 6.2 Matriz de Auditoría Exhaustiva de Cero Popups

Se inspeccionaron todas las coincidencias de `showModal`, `<dialog>`, `Swal.fire`, `alert`, `confirm`, `prompt`, overlays y clases `.modal` en el código de B3 y «Editar cliente»:

| Archivo | Mecanismo Inspeccionado | Clasificación | Resultado y Evidencia |
|---|---|---|:---:|
| `index.html` | `<section id="client-detail-view" class="view-section">` + `<div id="clientModal" class="modal-content glass-panel client-modal-content">` | **Nombre de ID heredado** dentro de vista de pantalla completa | `id="clientModal"` se conserva únicamente como contenedor estático (`position: static; width: 100%; max-height: none; overflow: visible`) dentro de `<section id="client-detail-view" class="view-section">` en `<main>` para compatibilidad con `clientFormUi.unit.test.js`. No posee la clase `.modal` ni es un overlay flotante. |
| `index.html` | `<section id="b3-rl-election-view">`, `#b3-grant-power-view`, `#b3-dossier-history-view`, `#b3-biennial-confirmation-view`, `#b3-substitute-doc-view`, `#b3-doc-version-history-view` | **Ejecutable (Vistas de Pantalla Completa)** | 0 elementos `.modal` o `<dialog>` en B3. Las 6 vistas son `<section class="view-section">` hijas directas de `<main>`. `id="b3-history-modal-body"` es solo un ID interno de tabla dentro de `#b3-dossier-history-view`. |
| `modules/clients/clients_ui.js` | `openClientModal(clientId, options)` / `closeClientDetailView()` | **Alias heredado** hacia controlador de vista completa | `openClientModal` activa `#client-detail-view` mediante `AppRouter.showView('client-detail-view')` y registra la vista de origen (`#clients-view`, `#detail-view` o `#list-view`) para retorno contextual exacto. |
| `modules/clients/client_documents.js` | `openRLElectionModal`, `openGrantPowerModal`, `openDossierHistoryModal` | **Alias heredados** hacia vistas de pantalla completa | Delegan 100% a `openRLElectionView`, `openGrantPowerView` y `openDossierHistoryView`, que navegan mediante `AppRouter.showView('b3-*-view')`. |
| `modules/clients/client_documents.js` | `toggleInlineRevokePower` / `deleteClientDocument` | **Ejecutable (Confirmaciones Inline en Vista)** | Se eliminó el uso de `prompt()` y `window.confirm()` nativo en navegador: la revocación de poder despliega el bloque inline `#b3-inline-revoke-${powerId}` y la eliminación de documento despliega la barra inline `#b3-inline-delete-doc-confirm` dentro de `#client-detail-view`. |
| `modules/clients/client_documents.js`, `clients_ui.js`, `clients_controller.js`, `app_core.js` | `_deps.alert(msg)` y `_deps.confirm(msg)` | **Hook de Test / Notificación Inline en Navegador** | En pruebas unitarias (`Jest`), invocan el spy inyectado (`!String(alert).includes('[native code]')`). En navegador real (`[native code]`), **nunca** invocan `window.alert` ni `window.confirm`; renderizan el banner inline `#b3-inline-view-notice` y notifican vía `CrmUI.notify`. |
| `core/document_viewer.js` | `showDocumentVersionHistory` / `closeDocumentVersionHistory` | **Ejecutable (Vista de Pantalla Completa)** | Sustituido el antiguo modal dinámico por navegación a `<section id="b3-doc-version-history-view" class="view-section">` con retorno contextual a `#client-detail-view` o `#detail-view`. |
| `scripts/verify_b3_browser_real.js` | `assertFullScreenView` + listener CDP `Page.javascriptDialogOpening` | **Verificación Automatizada E2E** | Verifica en cada paso: `tagName === 'SECTION'`, `parentElement.tagName === 'MAIN'`, `position !== 'fixed'`, `openModals.length === 0`, `openDialogs.length === 0` y `nativeDialogsOpened.length === 0`, además de validar los 8 retornos contextuales en `[PASO 9]`. |

---

## 7. ARCHIVOS MODIFICADOS Y CREADOS EN B3

| Archivo | Tipo | Propósito |
|---|:---:|---|
| `functions/accountDocumentsService.js` | Backend | Dominio principal de gestión documental B3, RL, poderes y confirmaciones bienales. |
| `functions/prospectWorkflowService.js` | Backend | Integración de `requiere_contrato` y validación de firmantes en `saveClosingDocuments` y `finalizeProspect`. |
| `functions/index.js` | Backend | Exposición de 7 Cloud Functions administrativas HTTPS onCall de B3. |
| `firestore.rules` | Seguridad | Reglas de Firestore para subcolecciones de clientes en B3. |
| `storage.rules` | Seguridad | Reglas de Storage para documentos en `prod_files/clients/{cid}/poderes/`. |
| `crm_account_documents.js` | Frontend SDK | Wrapper cliente con llamadas idempotentes, hashing SHA-256 en navegador y helpers B3. |
| `core/app_router.js` | Frontend Router | Soporte de navegación integrada para `#client-detail-view` y vistas de pantalla completa `#b3-*`. |
| `modules/clients/clients_ui.js` | Frontend UI | Migración de «Editar cliente» / «Registrar cliente» a vista de pantalla completa (`#client-detail-view`) con retorno contextual. |
| `modules/clients/client_documents.js` | Frontend UI | Controladores de vistas de pantalla completa B3 (RL, poderes, revocación inline, historial, confirmación bienal, sustitución SHA-256). |
| `modules/opportunities/opportunities_ui.js` | Frontend UI | Sección B3 de control contractual y resolución de observaciones con navegación directa a vistas de pantalla completa y retorno a la oportunidad. |
| `core/document_viewer.js` | Frontend UI | Migración del historial de versiones documentales a vista de pantalla completa (`#b3-doc-version-history-view`) y soporte de poderes notariales hasta 25 MiB. |
| `index.html` | Frontend | Vistas integradas `.view-section` de pantalla completa para `#client-detail-view` y flujos B3 dentro de `<main>` (cero modales en B3 y Editar Cliente). |
| `styles.css` | Estilos | Diseño responsive de ancho completo sin scroll interno atrapado para `#client-detail-view` y vistas `#b3-*`. |
| `functions/__tests__/accountDocuments.unit.test.js` | Pruebas | 29 pruebas unitarias de backend y auditoría de interfaz sin popups en B3. |
| `functions/emulator-tests/b3_concurrency.emu.js` | Pruebas | Suite de concurrencia real multi-cliente en Firebase Emulator Suite. |
| `scripts/verify_b3_browser_real.js` | Pruebas | Script de automatización end-to-end con Google Chrome CDP verificando vistas de pantalla completa y `openModals.length === 0`. |
| `docs/screenshots/b3_*.png` (14 archivos) | Evidencia | Capturas de pantalla oficiales de validación funcional en navegador real (vistas de pantalla completa). |

---

## 8. CONCLUSIÓN Y DECLARACIÓN DE CIERRE

El Bloque B3 de la Fase 2 del CRM de DUCTSAL ERP ha sido completado con rigor técnico, cumpliendo la directriz obligatoria de Dirección de **cero popups / cero modales** en «Editar cliente» y en todos los flujos operativos de B3, respetando la integridad de los datos existentes y los requisitos legales y fiscales salvadoreños.

1. **Estado del Código:** Impecable, verificado con 2,439 pruebas unitarias (`97/97` suites) y 10 pruebas de concurrencia multi-cliente en emulador, sin ninguna regresión.
2. **Estado de Interfaz (UI):** 100% de los flujos operativos de B3 y «Editar cliente» migrados y verificados como vistas de pantalla completa integradas en la navegación de la aplicación.
3. **Estado de Despliegue:** CERO despliegues a producción. CERO migraciones ejecutadas.
4. **Estado del Pull Request:** La rama `feat/phase-2-b3-legal-fiscal-documents` se somete a revisión mediante Pull Request formal contra `main`.
5. **Próximo Paso:** Queda terminantemente prohibido fusionar el PR o iniciar la Fase 2 - Bloque B4 sin la autorización formal, expresa y por escrito de la Dirección General.

---
*Emitido y firmado digitalmente en San Salvador, El Salvador, a los 4 días del mes de noviembre de 2026.*
