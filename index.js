/**
 * WhatsApp Cloud API Webhook para UNIDEP
 * - Verificación de webhook (GET /webhook)
 * - Recepción de mensajes (POST /webhook)
 * - Auto-respuestas según texto/botón
 * - Envío de correo cuando dicen "no estoy interesado" (SMTP Gmail)
 * - Logs claros a Render con número y texto recibido
 *
 * VARIABLES DE ENTORNO REQUERIDAS (en Render):
 *  VERIFY_TOKEN         -> p.ej. mi_verify_token_super_seguro
 *  WABA_TOKEN           -> token permanente de WhatsApp Cloud API
 *  PHONE_NUMBER_ID      -> ID del número de WhatsApp
 *  APP_SECRET           -> (opcional) para validar firma X-Hub-Signature-256
 *  SMTP_USER            -> tu Gmail (p.ej. ricardomartinez19b@gmail.com)
 *  SMTP_PASS            -> contraseña de aplicación de 16 letras (sin espacios)
 *  SMTP_TO              -> correo(s) destino, separados por coma
 *  SMTP_FROM            -> opcional, p.ej. "UNIDEP Bot <tu@gmail.com>"
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto'); // nativo de Node
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Capturar raw body para validar firma si hay APP_SECRET ======
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ====== Entorno ======
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';
const WABA_TOKEN       = process.env.WABA_TOKEN || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCip';
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID || '756528907544969';
const APP_SECRET       = process.env.APP_SECRET || '89bb6d2367a4ab0ad3e94021e7cb2046';

const SMTP_USER = process.env.SMTP_USER || 'ricardomartinez19b@gmail.com';
const SMTP_PASS = (process.env.SMTP_PASS || 'uwdlbouzhvkdshpt').replace(/\s+/g, ''); // sin espacios
const SMTP_TO   = process.env.SMTP_TO   || 'ricardomartinez19b@gmail.com';
const SMTP_FROM = process.env.SMTP_FROM || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';

const EMAIL_ENABLED = !!(SMTP_USER && SMTP_PASS && SMTP_TO);

// ====== SMTP (opcional) ======
let mailer = null;
if (EMAIL_ENABLED) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  mailer.verify()
    .then(() => console.log('📧 SMTP OK – autenticado con Gmail'))
    .catch(err => console.error('❌ SMTP verify error:', err?.message || err));
} else {
  console.log('📭 Email notifications: DISABLED (faltan SMTP vars)');
}

// ====== Helpers ======
const norm = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const NEGATIVOS = new Set([
  'no estoy interesado', 'no estoy interesada',
  'no gracias', 'no, gracias',
  'no', 'no quiero', 'no deseo', 'no me interesa',
  'no gracias!', 'no gracias.', 'no gracias,'
]);

const SILENCIO = new Set(['si', 'sí', 'gracias', 'ok', 'okay']);

// enviar texto por WhatsApp
async function sendText(toNumber, text) {
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ Faltan WABA_TOKEN o PHONE_NUMBER_ID; no se envió');
    return;
  }
  try {
    const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: text }
    };
    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('📤 Enviado a', toNumber, '| msgId =', data.messages?.[0]?.id || 'n/a');
  } catch (err) {
    console.error('❌ Error al enviar:', err?.response?.data || err?.message || err);
  }
}

async function sendEmailNoInteresado(fromNumber, originalText) {
  if (!EMAIL_ENABLED || !mailer) {
    console.log('✉️  (omitido) Email deshabilitado o sin configuración.');
    return;
  }
  try {
    const info = await mailer.sendMail({
      from: SMTP_FROM,
      to: SMTP_TO,
      subject: `No interesado | ${fromNumber}`,
      text:
`Número: ${fromNumber}
Mensaje: ${originalText}
Fecha: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`
    });
    console.log('📧 Email enviado ✓ messageId:', info?.messageId);
  } catch (err) {
    console.error('❌ Error enviando email:', err?.response || err?.message || err);
  }
}

// validar firma (si hay APP_SECRET)
function verifySignature(req) {
  if (!APP_SECRET) return true; // sin secreto -> no se valida
  const sigHeader = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || Buffer.from(''))
    .digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader || 'sha256='));
  if (!ok) {
    console.error('⚠️  Firma inválida. expected=', expected, 'got=', sigHeader);
  }
  return ok;
}

// ====== Endpoints auxiliares ======
app.get('/', (_req, res) => res.send('Webhook UNIDEP activo ✅'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ====== Webhook Verification (GET) ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔎 Verificación GET recibida');
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== Webhook Receiver (POST) ======
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);

  const body = req.body;
  if (body?.object !== 'whatsapp_business_account') {
    return res.sendStatus(200); // ignorar otros objetos
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Estatus
        if (value.statuses) {
          for (const st of value.statuses) {
            console.log('🔔 Status:',
              'to=', st.recipient_id,
              'status=', st.status,
              'msgId=', st.id,
              'conv=', st.conversation?.id || 'n/a'
            );
          }
        }

        // Mensajes
        if (value.messages) {
          for (const m of value.messages) {
            const from = m.from;
            let text = '';

            if (m.type === 'text') {
              text = m.text?.body || '';
            } else if (m.type === 'interactive') {
              const it = m.interactive || {};
              if (it.type === 'button') {
                // Título visible del botón o su id
                text = it.button_reply?.title || it.button_reply?.id || 'boton';
              } else if (it.type === 'list_reply') {
                text = it.list_reply?.title || it.list_reply?.id || 'lista';
              } else {
                text = 'interactivo';
              }
            } else {
              // Otros tipos: imagen/documento/nota/etc.
              text = m[m.type]?.caption || m[m.type]?.id || m.type;
            }

            console.log(`💬 Mensaje de ${from} | texto=${JSON.stringify(text)}`);

            const key = norm(text);

            if (NEGATIVOS.has(key)) {
              // 1) "No estoy interesado" y similares
              await sendText(from, 'Perfecto borramos su registro. Gracias');
              await sendEmailNoInteresado(from, text);
              console.log('↪️ Acción: marcado como "no interesado"');
            } else if (SILENCIO.has(key)) {
              // 2) "gracias"/"si": sin respuesta
              console.log('🤫 Acción: sin respuesta (gracias/si)');
            } else {
              // 3) Respuesta por defecto
              await sendText(
                from,
                'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias'
              );
              console.log('↪️ Acción: auto-reply por defecto');
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error procesando webhook:', err?.stack || err?.message || err);
    res.sendStatus(500);
  }
});

// ====== Arranque ======
app.listen(PORT, () => {
  console.log('//////////////////////////////////////////////////');
  console.log('=> Servidor escuchando en puerto', PORT);
  console.log('=> Your service is live 🎉');
  console.log('//////////////////////////////////////////////////');
});