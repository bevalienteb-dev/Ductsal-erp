// scripts/execute_controlled_real_email.js
// Fase 6.3.7: Despacho controlado de correo real mediante Firebase Identity Platform
// Destinatario autorizado exclusivamente: bvaliente@grupogama.com
// Límite estricto: 1 correo por invocación, máximo 3 en total.

const https = require('https');

const API_KEY = 'AIzaSyBSnGhwh043oV_zW1FlE5z7N8_ywh9FUEA';
const TARGET_EMAIL = 'bvaliente@grupogama.com';
const CONTINUE_URL = 'https://erp.ductsal.com/login?mode=activate';

async function dispatchPasswordReset(email) {
  if (email !== TARGET_EMAIL) {
    throw new Error(`DESTINATARIO NO AUTORIZADO: ${email}. Solo se autoriza ${TARGET_EMAIL}`);
  }

  const payload = JSON.stringify({
    requestType: 'PASSWORD_RESET',
    email: email,
    continueUrl: CONTINUE_URL
  });

  const options = {
    hostname: 'identitytoolkit.googleapis.com',
    port: 443,
    path: `/v1/accounts:sendOobCode?key=${API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // HIGIENE DE SECRETOS: No registrar oobCode ni parámetros sensibles
          const sanitized = {
            httpStatus: res.statusCode,
            email: parsed.email || email,
            success: res.statusCode === 200,
            hasOobCode: !!parsed.oobCode,
            error: parsed.error ? parsed.error.message : null
          };
          resolve(sanitized);
        } catch (e) {
          resolve({ httpStatus: res.statusCode, raw: data, error: e.message });
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log(`[FASE 6.3.7] Iniciando despacho controlado hacia: ${TARGET_EMAIL}`);
  console.log(`[FASE 6.3.7] URL de Retorno configurada: ${CONTINUE_URL}`);
  console.log(`[FASE 6.3.7] Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await dispatchPasswordReset(TARGET_EMAIL);
    console.log(`[FASE 6.3.7] Resultado de Identity Platform:`, JSON.stringify(result, null, 2));
    if (result.success) {
      console.log(`[FASE 6.3.7] Correo aceptado exitosamente por Firebase Authentication para entrega.`);
    } else {
      console.error(`[FASE 6.3.7] Error en despacho: ${result.error || result.httpStatus}`);
    }
  } catch (err) {
    console.error(`[FASE 6.3.7] Fallo de red o ejecución:`, err.message);
  }
})();
