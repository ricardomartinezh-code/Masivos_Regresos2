// index.js
// Webhook WhatsApp Cloud API — CommonJS (require)

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ====== ENV ======
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const APP_SECRET      = process.env.APP_SECRET || ''; // si lo dejas vacío, no valida firma
const PORT            = process.env.PORT || 10000;

// ====== Body parsers (guardamos raw para firma) ======
const rawBodySaver = (req, _res, buf) => { req.rawBody = buf };
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));

// ====== Health & Home ======
app.get('/', (_req, res) => res.send('Webhook OK'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ====== GET /webhook (verificación) ======
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Verificación fallida: token o modo inválido');
  return res.sendStatus(403);
});

// ====== Helper: validar firma X-Hub-Signature-256 ======
function validateSignature(req) {
  if (!APP_SECRET) return true; // validación desactivada
  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return true; // si no viene, no bloqueamos
  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  // Comparación constante (evitar timing attacks)
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ====== Helper: descripción legible del mensaje ======
function describeMessage(m) {
  switch (m.type) {
    case 'text':
      return `texto="${m.text?.body}"`;
    case 'image':
      return `imagen id=${m.image?.id} caption="${m.image?.caption || ''}"`;
    case 'video':
      return `video id=${m.video?.id} caption="${m.video?.caption || ''}"`;
    case 'audio':
      return `audio id=${m.audio?.id}`;
    case 'document':
      return `documento "${m.document?.filename || ''}" id=${m.document?.id}`;
    case 'sticker':
      return `sticker id=${m.sticker?.id}`;
    case 'location':
      return `ubicación ${m.location?.latitude},${m.location?.longitude} ` +
             `name="${m.location?.name || ''}" address="${m.location?.address || ''}"`;
    case 'contacts':
      return `contactos count=${m.contacts?.length || 0}`;
    case 'interactive':
      if (m.interactive?.type === 'button_reply') {
        return `button_reply title="${m.interactive.button_reply?.title}" id=${m.interactive.button_reply?.id}`;
      }
      if (m.interactive?.type === 'list_reply') {
        return `list_reply title="${m.interactive.list_reply?.title}" id=${m.interactive.list_reply?.id}`;
      }
      return 'interactive (otro)';
    case 'reaction':
      return `reaction emoji=${m.reaction?.emoji} a=${m.reaction?.message_id}`;
    default:
      return `tipo=${m.type} data=${JSON.stringify(m[m.type] || {})}`;
  }
}

// ====== POST /webhook (eventos entrantes) ======
app.post('/webhook', async (req, res) => {
  if (!validateSignature(req)) {
    console.warn('==> Firma inválida');
    return res.sendStatus(401);
  }

  const entry  = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value  = change?.value;

  // Mensajes
  const messages = value?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const msg   = messages[0];
    const from  = msg.from;
    const tipo  = msg.type;
    const human = describeMessage(msg);
    const profileName = value?.contacts?.[0]?.profile?.name;

    console.log(`==> Mensaje de ${from}${profileName ? ' ('+profileName+')' : ''} | ${human}`);

    // Auto-reply
    try {
      await sendText(from, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
    } catch (err) {
      console.error('Error al enviar auto-reply:', err?.response?.data || err?.message || err);
    }
  }

  // Estados de entrega/lectura
  const statuses = value?.statuses;
  if (Array.isArray(statuses) && statuses.length > 0) {
    const s = statuses[0];
    console.log(
      `==> Status: to=${s.recipient_id} id=${s.id} status=${s.status}` +
      (s.conversation ? ` conv=${s.conversation.id}/${s.conversation.origin?.type}` : '')
    );
  }

  return res.sendStatus(200);
});

// ====== Enviar texto ======
async function sendText(to, body) {
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('Faltan WABA_TOKEN o PHONE_NUMBER_ID');
  }
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body, preview_url: false }
    },
    {
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
}

// ====== Enviar template (por si lo necesitas) ======
async function sendTemplate(to, name, lang = 'es_ES', components = []) {
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('Faltan WABA_TOKEN o PHONE_NUMBER_ID');
  }
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: lang }, components }
    },
    {
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
}

// ====== Arranque ======
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log('==> Your service is live 🎉');
  console.log('//////////////////////////////////////////////////////////');
});