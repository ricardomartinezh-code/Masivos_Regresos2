// index.js  — WhatsApp Cloud API Webhook (CommonJS)

const express = require('express');
const crypto = require('crypto');

// ========= Credenciales (lee de ENV o usa tus valores) =========
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN     || 'mi_verify_token_super_seguro';
const WABA_TOKEN       = process.env.WABA_TOKEN       || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID  || '756528907544969';
const APP_SECRET       = process.env.APP_SECRET       || '89bb6d2367a4ab0ad3e94021e7cb2046';
const PORT             = process.env.PORT || 10000;

const app = express();

// ====== guarda raw body para validar firma X-Hub-Signature-256 ======
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ========= utils =========
const log = (...args) => console.log(...args);

function validateSignature(req) {
  try {
    if (!APP_SECRET) return true; // sin secreto, omite validación
    const sig = req.get('x-hub-signature-256'); // "sha256=..."
    if (!sig || !sig.startsWith('sha256=')) return false;
    const their = sig.split('=')[1];
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    const digest = hmac.update(req.rawBody || '').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(their));
  } catch {
    return false;
  }
}

function normalizeText(s) {
  return String(s || '')
    .trim()
    .toLocaleLowerCase('es-MX')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\s+/g, ' '); // colapsa espacios
}

async function sendText(to, body) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    log('❗Error al enviar mensaje:', r.status, JSON.stringify(data));
  }
  return { ok: r.ok, data };
}

// ========= Health =========
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ========= Verificación de webhook (GET) =========
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('✅ Webhook verificado (GET).');
    return res.status(200).send(challenge);
  }
  log('⛔ Verificación fallida (GET): token o modo inválidos.');
  return res.sendStatus(403);
});

// ========= Recepción de eventos (POST) =========
app.post('/webhook', async (req, res) => {
  // valida firma si hay APP_SECRET
  if (APP_SECRET && !validateSignature(req)) {
    log('⛔ Firma inválida en webhook.');
    return res.sendStatus(401);
  }

  const body = req.body;
  // responde rápido
  res.sendStatus(200);

  try {
    if (body?.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // ======= logs de estados (sent, delivered, read) =======
        if (Array.isArray(value.statuses)) {
          for (const st of value.statuses) {
            log(
              '🔔 Status:',
              `to=${st.recipient_id}`,
              `status=${st.status}`,
              `msgId=${st.id}`,
              `conv=${st.conversation?.id || 'n/a'}`
            );
          }
        }

        // ======= mensajes entrantes =======
        if (Array.isArray(value.messages)) {
          for (const msg of value.messages) {
            const waId   = msg.from; // número del usuario
            const name   = value.contacts?.[0]?.profile?.name || 'n/a';

            // Extrae texto sin importar si viene de texto, botón o lista
            let raw = '';
            if (msg.type === 'text') raw = msg.text?.body || '';

            if (msg.type === 'interactive') {
              const i = msg.interactive || {};
              // formatos posibles
              if (i.type === 'button') {
                raw = i.button?.text || i.button_reply?.title || i.button_reply?.id || '';
              } else if (i.type === 'list_reply') {
                raw = i.list_reply?.title || i.list_reply?.id || '';
              } else {
                // compat: estructuras antiguas
                raw = i.button_reply?.title || i.button_reply?.id || i.list_reply?.title || i.list_reply?.id || '';
              }
            }

            const norm = normalizeText(raw);

            log(`💬 Mensaje de ${waId} (${name}) | raw="${raw}" | norm="${norm}"`);

            // ===== reglas =====
            const NO_INTERES = new Set([
              'no', 'no gracias', 'no me interesa',
              'no estoy interesado', 'no estoy interesada',
              'no estoy interesadx', 'no estoy interesad@'
            ]);

            const SILENCIO = new Set(['si', 'gracias']);

            if (NO_INTERES.has(norm)) {
              const txt = 'Perfecto borramos su registro. Gracias';
              await sendText(waId, txt);
              log(`↪️ Acción: respuesta NO INTERESADO enviada a ${waId}`);
              continue;
            }

            if (SILENCIO.has(norm)) {
              log(`🤫 Acción: sin respuesta para "${norm}"`);
              continue;
            }

            const txt = 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias';
            await sendText(waId, txt);
            log(`↪️ Acción: auto-reply enviado a ${waId}`);
          }
        }

        // meta útil de número mostrado
        if (value.metadata?.display_phone_number && value.metadata?.phone_number_id) {
          log(
            '==> WABA meta ->',
            `display_phone_number=${value.metadata.display_phone_number}`,
            `phone_number_id=${value.metadata.phone_number_id}`
          );
        }
      }
    }
  } catch (e) {
    log('❗ Error procesando webhook:', e?.message || e);
  }
});

// ========= Start =========
app.listen(PORT, () => {
  log('///////////////////////////////////////////////////////////');
  log(`🚀 Servidor escuchando en puerto ${PORT}`);
  log('///////////////////////////////////////////////////////////');
  log('==> Your service is live 🎉');
});