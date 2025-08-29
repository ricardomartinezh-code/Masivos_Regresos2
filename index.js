/* Webhook WhatsApp – Masivos_Regresos2
   Reglas:
   - "No estoy interesado" => "Perfecto borramos su registro. Gracias"
   - "Gracias" | "si" | "sí" => sin respuesta
   - Cualquier otro => "Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias"
*/

const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();

// Guardamos el cuerpo crudo para validar la firma de Meta (si hay APP_SECRET)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// === TUS CLAVES (quedan como default y se pueden sobreescribir con env vars en Render) ===
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN      || 'mi_verify_token_super_seguro';
const WABA_TOKEN       = process.env.WABA_TOKEN        || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID   || '756528907544969';
const APP_SECRET       = process.env.APP_SECRET        || '89bb6d2367a4ab0ad3e94021e7cb2046';

// === Utils ===
const normalize = (s = '') =>
  s
    .toString()
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

function logLine(msg) {
  console.log(`==> ${msg}`);
}

function validarFirma(req) {
  if (!APP_SECRET) return true; // si no hay secreto, no validamos
  try {
    const header = req.get('x-hub-signature-256') || '';
    const [, firmaMeta = ''] = header.split('=');
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(req.rawBody || '', 'utf8');
    const nuestra = hmac.digest('hex');
    const ok = crypto.timingSafeEqual(Buffer.from(nuestra), Buffer.from(firmaMeta));
    if (!ok) logLine('⚠️ Firma inválida. Evento descartado.');
    return ok;
  } catch (e) {
    console.error('Error validando firma:', e);
    return false;
  }
}

async function enviarTexto(toNumber, bodyText) {
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    logLine('❌ Falta WABA_TOKEN o PHONE_NUMBER_ID, no se puede enviar.');
    return;
  }
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: toNumber,
    type: 'text',
    text: { body: bodyText },
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('❌ Error API al enviar:', data);
    } else {
      logLine(`✔️ Auto-reply enviado a ${toNumber}. id=${data?.messages?.[0]?.id || 'n/a'}`);
    }
  } catch (err) {
    console.error('❌ Error de red al enviar:', err);
  }
}

function extraerTextoDeMensaje(msg) {
  if (!msg) return '';
  // texto normal
  if (msg.type === 'text' && msg.text?.body) return msg.text.body;

  // botones / listas
  if (msg.type === 'interactive' && msg.interactive) {
    const it = msg.interactive;
    if (it.type === 'button_reply' && it.button_reply?.title) return it.button_reply.title;
    if (it.type === 'list_reply' && it.list_reply?.title) return it.list_reply.title;
  }
  return '';
}

// === Health/endpoints básicos ===
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));

// === Webhook Verify (GET) ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    logLine('🔐 Webhook verificado (GET).');
    return res.status(200).send(challenge);
  }
  logLine('❌ Verificación fallida (GET).');
  return res.sendStatus(403);
});

// === Webhook Receiver (POST) ===
app.post('/webhook', (req, res) => {
  // responder rápido para que Meta no corte
  res.sendStatus(200);

  if (!validarFirma(req)) return;

  const body = req.body;
  if (body?.object !== 'whatsapp_business_account') return;

  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};

      // Log de meta del número
      const md = value.metadata || {};
      if (md.display_phone_number || md.phone_number_id) {
        logLine(
          `WABA meta -> display_phone_number=${md.display_phone_number || 'n/a'} phone_number_id=${md.phone_number_id || 'n/a'}`
        );
      }

      // Logs de estados
      if (Array.isArray(value.statuses)) {
        for (const st of value.statuses) {
          logLine(`Status: to=${st.recipient_id} status=${st.status} msgId=${st.id} conv=${st.conversation?.id || 'n/a'}`);
        }
      }

      // Mensajes entrantes
      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          const from = msg.from;
          const texto = extraerTextoDeMensaje(msg);

          // Log del mensaje recibido
          logLine(`Mensaje de ${from} | texto="${texto || '(no-text)'}"`);

          // Normalizamos para evaluar reglas
          const t = normalize(texto).replace(/[^\p{L}\p{N}\s]/gu, '').trim();

          if (t.includes('no estoy interesado')) {
            enviarTexto(from, 'Perfecto borramos su registro. Gracias');
          } else if (t === 'gracias' || t === 'si' || t === 'si.' || t === 'si ' || t === 'sí' || t === 'sí.' || t === 'sí ') {
            logLine(`Sin respuesta a "${texto}" (regla de silencio).`);
          } else if (texto) {
            enviarTexto(from, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
          } else {
            // mensaje sin texto (sticker/imagen/etc.)
            enviarTexto(from, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
          }
        }
      }
    }
  }
});

// === Arranque ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logLine(`Servidor escuchando en puerto ${PORT}`);
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    logLine('⚠️ Revisa WABA_TOKEN/PHONE_NUMBER_ID; son obligatorios.');
  }
});
