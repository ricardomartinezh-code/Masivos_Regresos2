// ------------------------------
// UNIDEP Webhook WhatsApp Cloud
// ------------------------------
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;

// Claves de WhatsApp Cloud API (con los valores que me diste como fallback)
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN     || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN       || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID  || '756528907544969';
const APP_SECRET      = process.env.APP_SECRET       || '89bb6d2367a4ab0ad3e94021e7cb2046';
const WA_API_VERSION  = process.env.WA_API_VERSION   || 'v23.0';

// SMTP (si los pones se enviarán correos)
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER   = process.env.SMTP_USER   || 'ricardomartinez19b@gmail.com';   // ej. ricardomartinez19b@gmail.com
const SMTP_PASS   = process.env.SMTP_PASS   || 'uwdlbouzhvkdshpt';   // contraseña de aplicación (16 chars, sin espacios)
const SMTP_FROM   = process.env.SMTP_FROM   || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';
const SMTP_TO     = process.env.SMTP_TO     || 'ricardo.martinezh@unidep.edu.mx';   // destinatario(s) separados por coma

// ====== APP ======
const app = express();

// Guardar rawBody para validar firma si hay APP_SECRET
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ====== UTILIDADES ======
const TRIGGERS = {
  uninterested: [
    'no estoy interesado', 'no estoy interesada', 'no estoy interesadx',
    'no me interesa', 'no gracias', 'no, gracias', 'no'
  ],
  silent: [
    'si', 'sí', 'ok', 'gracias', 'va', 'de acuerdo', 'perfecto'
  ]
};

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
    .replace(/[^\p{L}\p{N}\s]/gu, '')                 // sin signos
    .replace(/\s+/g, ' ')
    .trim();
}

// Extrae texto de text/button/list
function extractIncomingText(msg) {
  try {
    if (!msg) return '';

    if (msg.type === 'text' && msg.text && msg.text.body) {
      return msg.text.body;
    }
    if (msg.type === 'interactive' && msg.interactive) {
      const it = msg.interactive;
      if (it.type === 'button_reply' && it.button_reply) {
        return it.button_reply.title || it.button_reply.id || 'boton';
      }
      if (it.type === 'list_reply' && it.list_reply) {
        return it.list_reply.title || it.list_reply.id || 'lista';
      }
    }
    if (msg.button && msg.button.text) return msg.button.text;
  } catch (_) {}
  return '';
}

function classifyIntent(rawText) {
  const t = norm(rawText);

  const isUninterested =
    t === 'no' ||
    t === 'no gracias' ||
    t.includes('no estoy interesa') ||
    t.includes('no me interesa') ||
    TRIGGERS.uninterested.some(x => t === norm(x));

  if (isUninterested) return 'uninterested';

  const isSilent =
    t === 'si' || t === 'sí' ||
    TRIGGERS.silent.some(x => t === norm(x));

  if (isSilent) return 'silent';

  return 'default';
}

function validateSignature(req) {
  if (!APP_SECRET) return true; // si no hay secreto, no validamos
  try {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET)
      .update(req.rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function sendText(to, text) {
  const url = `https://graph.facebook.com/${WA_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: text }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('❌ Error enviando mensaje:', res.status, JSON.stringify(data));
  }
  return data;
}

async function notifyByEmail({ fromPhone, body, kind }) {
  if (!SMTP_USER || !SMTP_PASS || !SMTP_TO) {
    console.log('✉️  (omitido) Email no configurado.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `[No interesado] ${fromPhone}`;
  const text =
    `Teléfono: ${fromPhone}\n` +
    `Mensaje: ${body}\n` +
    `Tipo: ${kind || 'NO_INTERESADO'}\n` +
    `Fecha: ${new Date().toISOString()}`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to: SMTP_TO,
    subject,
    text
  });
  console.log(`✉️  Email enviado -> ${SMTP_TO}`);
}

// ====== RUTAS ======
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.send('ok'));

// Verificación del webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado (GET).');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de eventos (POST)
app.post('/webhook', async (req, res) => {
  // Firma opcional
  if (!validateSignature(req)) {
    console.error('⚠️  Firma inválida (X-Hub-Signature-256).');
    return res.sendStatus(401);
  }

  const body = req.body;
  if (body && body.object === 'whatsapp_business_account') {
    try {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};

          // Logs de estados (sent/delivered/read)
          if (Array.isArray(v.statuses)) {
            for (const st of v.statuses) {
              console.log(
                `🔔 Status: to=${st.recipient_id} status=${st.status}` +
                (st.id ? ` msgId=${st.id}` : '') +
                (st.conversation && st.conversation.id ? ` conv=${st.conversation.id}` : '')
              );
            }
          }

          // Mensajes entrantes
          if (Array.isArray(v.messages)) {
            for (const msg of v.messages) {
              const from = msg.from; // teléfono del usuario
              const rawText = extractIncomingText(msg);
              console.log(`💬 Mensaje de ${from} | texto="${rawText}"`);

              const intent = classifyIntent(rawText);

              if (intent === 'uninterested') {
                await sendText(from, 'Perfecto, borramos su registro. Gracias');
                await notifyByEmail({
                  fromPhone: from,
                  body: rawText,
                  kind: 'NO_INTERESADO'
                });
                console.log('↪️  Acción: respuesta a "no interesado"');
              } else if (intent === 'silent') {
                // no responder
                console.log('🤫 Acción: silencio (sin respuesta)');
              } else {
                await sendText(from, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
                console.log('↪️  Acción: auto-reply genérico');
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('❌ Error en handler:', err);
    }
    return res.sendStatus(200);
  }

  // no es un evento WABA
  res.sendStatus(404);
});

// ====== START ======
app.listen(PORT, () => {
  console.log('/////////////////////////////////////////////////////////');
  if (!SMTP_USER || !SMTP_PASS || !SMTP_TO) {
    console.log('✉️  Email notifications: DISABLED (faltan variables SMTP*)');
  } else {
    console.log('✉️  Email notifications: ENABLED');
  }
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log('==> Your service is live 🎉');
  console.log('/////////////////////////////////////////////////////////');
});