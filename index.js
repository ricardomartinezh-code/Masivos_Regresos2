// index.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const app = express();

/* ====== Variables de entorno (Render) ======
   VERIFY_TOKEN, WABA_TOKEN, PHONE_NUMBER_ID, APP_SECRET
   (No pongas secretos en el repo)
*/
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const APP_SECRET      = process.env.APP_SECRET || '';

/* Guardamos el cuerpo crudo para validar la firma si hay APP_SECRET */
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

/* ====== Firma X-Hub-Signature-256 (opcional si APP_SECRET está vacío) ====== */
function verifyMetaSignature(req) {
  if (!APP_SECRET) return true; // si no hay secreto, no validamos
  try {
    const signature = req.get('x-hub-signature-256');
    if (!signature || !signature.startsWith('sha256=')) return false;
    const received = signature.split('=')[1];
    const expected = crypto
      .createHmac('sha256', APP_SECRET)
      .update(req.rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

/* ====== Enviar texto por Cloud API ====== */
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error('❌ Error enviando mensaje:', data);
  } else {
    console.log('✅ Mensaje enviado:', data);
  }
}

/* ====== Verificación del webhook (GET) ====== */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ====== Recepción de eventos (POST) ====== */
app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);

  const body = req.body;
  if (body?.object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Solo eventos de mensajes entrantes
        if (change.field === 'messages') {
          const msgs = change.value?.messages ?? [];
          for (const msg of msgs) {
            const from = msg?.from; // número del usuario que escribió
            if (from) {
              // Respuesta automática a cualquier tipo de mensaje
              await sendText(
                from,
                'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias'
              );
            }
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('⚠️ Error procesando webhook:', err);
    return res.sendStatus(500);
  }
});

/* ====== Endpoints de salud ====== */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('alive'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));