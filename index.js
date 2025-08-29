// index.js (CommonJS)
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===== Credenciales (con fallback a ENV) =====
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN     || 'mi_verify_token_super_seguro';
const WABA_TOKEN       = process.env.WABA_TOKEN       || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID  || '756528907544969';
const APP_SECRET       = process.env.APP_SECRET       || '89bb6d2367a4ab0ad3e94021e7cb2046'; // (no usado aquí)

// ===== Utilidades =====
const PORT = process.env.PORT || 10000;

const normalize = (s='') =>
  s.toString()
   .trim()
   .toLowerCase()
   .normalize('NFD')
   .replace(/\p{Diacritic}/gu, ''); // quita acentos

const getMessageText = (msg) => {
  if (!msg) return '';
  // texto directo
  if (msg.type === 'text' && msg.text?.body) return msg.text.body;

  // botones/interactive
  if (msg.type === 'interactive' && msg.interactive) {
    const i = msg.interactive;
    if (i.type === 'button_reply' && i.button_reply?.title) return i.button_reply.title;
    if (i.type === 'list_reply'   && i.list_reply?.title)   return i.list_reply.title;
  }

  // media u otros tipos: opcionalmente retorna el tipo
  return msg.type || '';
};

const sendText = async (to, text) => {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  // Logs de estado de entrega
  const mid = res.data?.messages?.[0]?.id || 'n/a';
  console.log(`↪︎ Enviado a ${to} | msgId=${mid}`);
};

// ===== Endpoints mínimos =====
app.get('/', (req, res) => res.send('ok'));
app.get('/healthz', (req, res) => res.send('ok'));

// Verificación de webhook (Meta)
app.get('/webhook', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const chall = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado (GET).');
    return res.status(200).send(chall);
  }
  return res.sendStatus(403);
});

// Recepción de eventos
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    // Meta/WABA envía esta forma
    if (body?.object && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const change = entry.changes?.[0];
        const value  = change?.value;

        // Mensajes entrantes
        const msg = value?.messages?.[0];
        if (msg) {
          const from  = msg.from; // número del usuario (E.164 sin +)
          const name  = value?.contacts?.[0]?.profile?.name || 'n/a';
          const text  = getMessageText(msg);
          console.log(`💬 Mensaje de ${from} (${name}) | texto="${text}"`);

          // Reglas
          const n = normalize(text);
          let reply = null;

          if (n === 'no estoy interesado') {
            reply = 'Perfecto borramos su registro. Gracias';
            console.log('↪︎ Acción: respuesta "no interesado"');
          } else if (n === 'gracias' || n === 'si' || n === 'sí') {
            reply = null;
            console.log('↪︎ Acción: sin respuesta (gracias/si)');
          } else if (text) {
            reply = 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias';
            console.log('↪︎ Acción: respuesta automática general');
          }

          // Enviar si corresponde
          if (reply) {
            try {
              await sendText(from, reply);
            } catch (err) {
              console.error('❌ Error al enviar respuesta:',
                err?.response?.status,
                JSON.stringify(err?.response?.data || err.message));
            }
          }
        }

        // Status (delivered/read/etc.)
        const statuses = value?.statuses;
        if (Array.isArray(statuses)) {
          for (const st of statuses) {
            console.log(
              `🔔 Status: to=${st.recipient_id} status=${st.status} msgId=${st.id || 'n/a'} conv=${st.conversation?.id || 'n/a'}`
            );
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Error en /webhook:', e?.message || e);
    res.sendStatus(200); // siempre 200 para no reintentos infinitos
  }
});

// Arranque
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log('////////////////////////////////////////////////////////');
  console.log(`==> Your service is live 🎉`);
  console.log('////////////////////////////////////////////////////////');
});