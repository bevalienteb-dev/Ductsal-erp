// scripts/update_email_templates_app_name.js
// Actualización oficial de plantillas nativas en Firebase Identity Platform
// Reemplazo literal de %APP_NAME% por "DUCTSAL ERP"

const fs = require('fs');
const https = require('https');
const os = require('os');

const configPath = os.homedir() + '/.config/configstore/firebase-tools.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = config.tokens.access_token;
const PROJECT_ID = 'ductsal-erp';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('1. Leyendo configuración actual de Identity Platform...');
  const current = await request('GET', `/admin/v2/projects/${PROJECT_ID}/config`);
  if (current.status !== 200 || !current.data.notification || !current.data.notification.sendEmail) {
    console.error('Error al leer configuración:', current);
    process.exit(1);
  }

  const sendEmail = current.data.notification.sendEmail;

  // Actualización de las 4 plantillas reemplazando %APP_NAME% por "DUCTSAL ERP"
  const updatedSendEmail = {
    method: sendEmail.method || 'DEFAULT',
    callbackUri: sendEmail.callbackUri,
    dnsInfo: sendEmail.dnsInfo,
    resetPasswordTemplate: {
      ...sendEmail.resetPasswordTemplate,
      senderLocalPart: 'noreply',
      senderDisplayName: 'DUCTSAL ERP',
      replyTo: 'informatica@grupogama.com',
      bodyFormat: 'HTML',
      subject: 'Cambia la contraseña de DUCTSAL ERP',
      body: '<p>Hola:</p>\n<p>Haz clic en este enlace para cambiar la contraseña de DUCTSAL ERP de tu cuenta %EMAIL%.</p>\n<p><a href=\'%LINK%\'>%LINK%</a></p>\n<p>Si no has solicitado este cambio, ignora este correo electrónico.</p>\n<p>Gracias,</p>\n<p>El equipo de DUCTSAL ERP</p>'
    },
    verifyEmailTemplate: {
      ...sendEmail.verifyEmailTemplate,
      senderLocalPart: 'noreply',
      senderDisplayName: 'DUCTSAL ERP',
      replyTo: 'informatica@grupogama.com',
      bodyFormat: 'HTML',
      subject: 'Verifica tu dirección de correo electrónico de DUCTSAL ERP',
      body: '<p>Hola, %DISPLAY_NAME%:</p>\n<p>Haz clic en este enlace para verificar tu dirección de correo electrónico.</p>\n<p><a href=\'%LINK%\'>%LINK%</a></p>\n<p>Si no has emitido esta solicitud, ignora este mensaje.</p>\n<p>Gracias,</p>\n<p>El equipo de DUCTSAL ERP</p>'
    },
    changeEmailTemplate: {
      ...sendEmail.changeEmailTemplate,
      senderLocalPart: 'noreply',
      senderDisplayName: 'DUCTSAL ERP',
      replyTo: 'informatica@grupogama.com',
      bodyFormat: 'HTML',
      subject: 'Se ha cambiado tu correo electrónico de inicio de sesión de DUCTSAL ERP',
      body: '<p>Hola, %DISPLAY_NAME%:</p>\n<p>Se ha cambiado el correo electrónico de inicio de sesión de DUCTSAL ERP a %NEW_EMAIL%.</p>\n<p>Si no has solicitado dicho cambio, haz clic en este enlace para recuperar la dirección anterior.</p>\n<p><a href=\'%LINK%\'>%LINK%</a></p>\n<p>Gracias,</p>\n<p>El equipo de DUCTSAL ERP</p>'
    },
    revertSecondFactorAdditionTemplate: {
      ...sendEmail.revertSecondFactorAdditionTemplate,
      senderLocalPart: 'noreply',
      senderDisplayName: 'DUCTSAL ERP',
      replyTo: 'informatica@grupogama.com',
      bodyFormat: 'HTML',
      subject: 'Has añadido la verificación en dos pasos a tu cuenta de DUCTSAL ERP.',
      body: '<p>Hola, %DISPLAY_NAME%:</p>\n<p>Se ha actualizado tu cuenta de DUCTSAL ERP con %SECOND_FACTOR% para la verificación en dos pasos.</p>\n<p>Si no has añadido esta verificación en dos pasos, haz clic en el enlace que aparece más abajo para quitarla.</p>\n<p><a href=\'%LINK%\'>%LINK%</a></p>\n<p>Gracias,</p>\n<p>El equipo de DUCTSAL ERP</p>'
    }
  };

  console.log('2. Aplicando actualización de plantillas vía PATCH con updateMask=notification.sendEmail...');
  const patchRes = await request(
    'PATCH',
    `/admin/v2/projects/${PROJECT_ID}/config?updateMask=notification.sendEmail`,
    {
      notification: {
        sendEmail: updatedSendEmail
      }
    }
  );

  console.log('Respuesta PATCH HTTP:', patchRes.status);
  if (patchRes.status !== 200) {
    console.error('Error aplicando PATCH:', patchRes);
    process.exit(1);
  }

  console.log('3. Verificando lectura posterior inmutable...');
  const verifyRes = await request('GET', `/admin/v2/projects/${PROJECT_ID}/config`);
  const finalTemplates = verifyRes.data.notification.sendEmail;

  console.log('--- RESULTADO DE LECTURA POSTERIOR ---');
  console.log('resetPasswordTemplate:');
  console.log('  Subject:', finalTemplates.resetPasswordTemplate.subject);
  console.log('  Sender:', `${finalTemplates.resetPasswordTemplate.senderDisplayName} <${finalTemplates.resetPasswordTemplate.senderLocalPart}@auth.ductsal.com>`);
  console.log('  Reply-To:', finalTemplates.resetPasswordTemplate.replyTo);
  console.log('  Body contains DUCTSAL ERP:', finalTemplates.resetPasswordTemplate.body.includes('DUCTSAL ERP'));
  console.log('  Body contains %APP_NAME%:', finalTemplates.resetPasswordTemplate.body.includes('%APP_NAME%'));

  console.log('\nverifyEmailTemplate:');
  console.log('  Subject:', finalTemplates.verifyEmailTemplate.subject);
  console.log('  Body contains DUCTSAL ERP:', finalTemplates.verifyEmailTemplate.body.includes('DUCTSAL ERP'));

  console.log('\nchangeEmailTemplate:');
  console.log('  Subject:', finalTemplates.changeEmailTemplate.subject);
  console.log('  Body contains DUCTSAL ERP:', finalTemplates.changeEmailTemplate.body.includes('DUCTSAL ERP'));

  console.log('\nrevertSecondFactorAdditionTemplate:');
  console.log('  Subject:', finalTemplates.revertSecondFactorAdditionTemplate.subject);
  console.log('  Body contains DUCTSAL ERP:', finalTemplates.revertSecondFactorAdditionTemplate.body.includes('DUCTSAL ERP'));

  console.log('\nDNS Info preservado:', JSON.stringify(finalTemplates.dnsInfo, null, 2));
})();
