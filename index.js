'use strict';

const express = require('express');
const crypto = require('crypto');
const morgan = require('morgan');

const app = express();

// ====== ENV ======
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN   || 'mi_verify_token_super_seguro';
const WABA_TOKEN     = process.env.WABA_TOKEN     || '';
const PHONE_NUMBER_ID= process.env.PHONE_NUMBER_ID|| '';
const APP_SECRET     = process.env.APP_SECRET     || ''; // opcional para validar firma
const PORT           = process.env.PORT || 3000;

const GRAPH_BASE = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`;

// ====== LOGS & body raw (para firma) ======
app.use(morgan('combined'));
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ====== Utils ======
function validateSignature(req) {
  if (!APP_SECRET) return true; // si no pones APP_SECRET, omitimos la validación
  const header = req.get('x-hub-signature-256');
  if (!header || !header.startsWith('sha256=')) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function sendText(to, body) {
  const url = `${GRAPH_BASE}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
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
  console.log('==> Respuesta de sendText:', res.status, JSON.stringify(data));
  if (!res.ok) throw new Error(`sendText failed: ${res.status}`);
  return data;
}

async function sendTemplate(to, name, lang = 'es_ES', components = []) {
  const url = `${GRAPH_BASE}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: lang },
      components
    }
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
  console.log('==> Respuesta de sendTemplate:', res.status, JSON.stringify(data));
  if (!res.ok) throw new Error(`sendTemplate failed: ${res.status}`);
  return data;
}

// ====== Health & root ======
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('Webhook up'));

// ====== WEBHOOK VERIFY (GET) ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('==> GET /webhook verificado');
    return res.status(200).send(challenge);
  }
  console.warn('==> GET /webhook verificación fallida');
  return res.sendStatus(403);
});

// ====== WEBHOOK RECEIVE (POST) ======
app.post('/webhook', async (req, res) => {
  if (!validateSignature(req)) {
    console.warn('==> Firma inválida');
    return res.sendStatus(401);
  }

  console.log('==> Webhook payload:');
  console.log(JSON.stringify(req.body, null, 2));

  // Estructura común del Webhook de WhatsApp
  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value  = change?.value;

  // Mensajes entrantes
  const messages = value?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const msg = messages[0];
    const from = msg.from; // número del usuario que escribió (E.164)
    const type = msg.type;

    console.log(`==> Mensaje recibido de ${from} (tipo: ${type})`);

    // Auto-reply (texto) a cualquier mensaje
    try {
      await sendText(from, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
    } catch (err) {
      console.error('Error al enviar auto-reply:', err?.message || err);
    }
  }

  // Responder siempre 200 para que Meta considere entregado
  return res.sendStatus(200);
});

// ====== (Opcional) endpoint para probar envíos manuales ======
app.get('/send-test', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Falta ?to=5233...' });
  try {
    const r = await sendText(to, 'Mensaje de prueba desde /send-test ✅');
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'send-test failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log('/////////////////////////////////////////////');
  console.log('==> Your service is live 🎉');
  console.log(`==> PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? '[ok]' : '[faltante]'}`);
  console.log('/////////////////////////////////////////////');
});