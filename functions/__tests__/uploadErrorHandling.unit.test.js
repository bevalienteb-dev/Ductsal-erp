// functions/__tests__/uploadErrorHandling.unit.test.js
// Verifies that uploadFileToStorage in app_core.js:
// 1. Uses exclusively the canonical bucket (storage.ref()), without trying ductsal-erp.appspot.com
// 2. Distinguishes storage/unauthorized from transient timeouts
// 3. Immediately rejects authorization errors without delay or false CORS advice

const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('uploadFileToStorage Error & Bucket Handling', () => {
  let ctx;
  let alertMessages = [];
  let storageRefCalls = [];
  let uploadTasks = [];

  beforeEach(() => {
    alertMessages = [];
    storageRefCalls = [];
    uploadTasks = [];

    // Extract uploadFileToStorage and compressImage from app_core.js
    const appCoreSrc = fs.readFileSync(path.join(__dirname, '../../app_core.js'), 'utf8');

    // Create a sandbox simulating browser window and Firebase SDK
    ctx = {
      window: {},
      document: {
        getElementById: () => null
      },
      alert: msg => alertMessages.push(msg),
      console: {
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn()
      },
      STORAGE_PREFIX: 'prod_files',
      activeUploads: 0,
      uploadProgressMap: new Map(),
      updateGlobalProgress: jest.fn(),
      compressImage: async file => file,
      Date: {
        now: () => 1700000000000
      },
      Math: Object.assign(Object.create(Math), {
        random: () => 0.12345
      }),
      setTimeout: (...args) => global.setTimeout(...args),
      clearTimeout: (...args) => global.clearTimeout(...args)
    };

    // Mock storage.ref()
    const mockFileRef = (fullPath) => ({
      fullPath,
      put: (file, metadata) => {
        let stateChangedCallback = null;
        let errorCallback = null;
        let completeCallback = null;

        const task = {
          file,
          metadata,
          cancel: jest.fn(),
          on: (event, onProgress, onError, onComplete) => {
            stateChangedCallback = onProgress;
            errorCallback = onError;
            completeCallback = onComplete;
          },
          _triggerError: (err) => {
            if (errorCallback) errorCallback(err);
          },
          _triggerSuccess: () => {
            if (completeCallback) completeCallback();
          }
        };
        uploadTasks.push(task);
        return task;
      }
    });

    ctx.storage = {
      ref: jest.fn((path) => {
        storageRefCalls.push(path || '(root)');
        return {
          child: (subPath) => mockFileRef(subPath)
        };
      })
    };

    // Extract uploadFileToStorage function source
    const fnMatch = appCoreSrc.match(/async function uploadFileToStorage[\s\S]*?\n\}/);
    if (!fnMatch) throw new Error('Could not find uploadFileToStorage in app_core.js');

    vm.createContext(ctx);
    vm.runInContext(fnMatch[0], ctx);
  });

  test('uses exclusively canonical storage.ref() without trying ductsal-erp.appspot.com', async () => {
    const file = { name: 'cotizacion.pdf', size: 1024, type: 'application/pdf' };
    const uploadPromise = ctx.uploadFileToStorage(file, 'proyectos', { prospectId: 'P100' });
    await new Promise(r => setImmediate(r));

    expect(storageRefCalls.length).toBe(1);
    expect(storageRefCalls[0]).toBe('(root)');

    // Complete the upload
    uploadTasks[0]._triggerSuccess();
    const result = await uploadPromise;

    expect(result).toMatchObject({
      name: 'cotizacion.pdf',
      storagePath: 'prod_files/prospects/P100/proyectos/1700000000000_cotizacion.pdf',
      size: 1024,
      contentType: 'application/pdf'
    });
    expect(alertMessages.length).toBe(0);
  });

  test('surfaces storage/unauthorized immediately with authorization message and without CORS advice', async () => {
    const file = { name: 'costos.xlsx', size: 2048, type: 'application/vnd.ms-excel' };
    const uploadPromise = ctx.uploadFileToStorage(file, 'proyectos', { prospectId: 'P_DENIED' });
    await new Promise(r => setImmediate(r));

    // Storage Security Rules rejection
    const authError = new Error('Permission denied');
    authError.code = 'storage/unauthorized';
    authError.serverResponse = { status: 403 };

    uploadTasks[0]._triggerError(authError);

    await expect(uploadPromise).rejects.toThrow('Permission denied');

    expect(alertMessages.length).toBe(1);
    expect(alertMessages[0]).toContain('Acceso denegado');
    expect(alertMessages[0]).toContain('No tienes autorización para subir documentos');
    expect(alertMessages[0]).not.toContain('CORS');
    expect(alertMessages[0]).not.toContain('Timeout');
  });

  test('handles genuine watchdog network timeout and does not blame CORS or authorization', async () => {
    const file = { name: 'plano.dwg', size: 5000000, type: 'application/octet-stream' };

    jest.useFakeTimers();
    try {
      const uploadPromise = ctx.uploadFileToStorage(file, 'proyectos', { prospectId: 'P100' });
      const assertionPromise = expect(uploadPromise).rejects.toThrow(/Timeout de subida/);
      await jest.advanceTimersByTimeAsync(26000);
      await assertionPromise;

      expect(alertMessages.length).toBe(1);
      expect(alertMessages[0]).toContain('La subida se interrumpió por inactividad de la red');
      expect(alertMessages[0]).not.toContain('CORS');
      expect(alertMessages[0]).not.toContain('ductsal-erp.appspot.com');
    } finally {
      jest.useRealTimers();
    }
  });

  test('immediately rejects unapproved file extensions (.exe, .sh) before calling Storage', async () => {
    const exeFile = { name: 'malware.exe', size: 1024, type: 'application/x-msdownload' };
    await expect(ctx.uploadFileToStorage(exeFile, 'proyectos', { prospectId: 'P100' }))
      .rejects.toThrow(/no permitida/);

    expect(uploadTasks.length).toBe(0);
    expect(alertMessages.length).toBe(1);
    expect(alertMessages[0]).toContain('no permitida');
    expect(alertMessages[0]).toContain('.exe');

    const shFile = { name: 'script.sh', size: 512, type: 'application/x-sh' };
    await expect(ctx.uploadFileToStorage(shFile, 'proyectos', { prospectId: 'P100' }))
      .rejects.toThrow(/no permitida/);

    expect(uploadTasks.length).toBe(0);
    expect(alertMessages.length).toBe(2);
    expect(alertMessages[1]).toContain('.sh');
  });

  test('normalizes canonical MIME for CAD (.dwg, .dxf) and Revit (.rvt, .rfa) when browser provides generic or empty type', async () => {
    // 1. DWG with application/octet-stream -> image/vnd.dwg sent to Storage put()
    const dwgFile = { name: 'plano_ductos.dwg', size: 8000000, type: 'application/octet-stream' };
    const pDwg = ctx.uploadFileToStorage(dwgFile, 'proyectos', { prospectId: 'P100' });
    await new Promise(r => setImmediate(r));
    expect(uploadTasks[0].metadata).toEqual({ contentType: 'image/vnd.dwg' });
    uploadTasks[0]._triggerSuccess();
    const resDwg = await pDwg;
    expect(resDwg.name).toBe('plano_ductos.dwg');

    // 2. Revit .rvt with empty type -> application/vnd.autodesk.revit sent to Storage put()
    const rvtFile = { name: 'modelo_bim.rvt', size: 15000000, type: '' };
    const pRvt = ctx.uploadFileToStorage(rvtFile, 'proyectos', { prospectId: 'P100' });
    await new Promise(r => setImmediate(r));
    expect(uploadTasks[1].metadata).toEqual({ contentType: 'application/vnd.autodesk.revit' });
    uploadTasks[1]._triggerSuccess();
    const resRvt = await pRvt;
    expect(resRvt.name).toBe('modelo_bim.rvt');

    // 3. Excel .xlsx -> openxmlformats sent to Storage put()
    const xlsxFile = { name: 'costos_proyecto.xlsx', size: 45000, type: '' };
    const pXlsx = ctx.uploadFileToStorage(xlsxFile, 'proyectos', { prospectId: 'P100' });
    await new Promise(r => setImmediate(r));
    expect(uploadTasks[2].metadata).toEqual({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    uploadTasks[2]._triggerSuccess();
    const resXlsx = await pXlsx;
    expect(resXlsx.name).toBe('costos_proyecto.xlsx');
  });
});
