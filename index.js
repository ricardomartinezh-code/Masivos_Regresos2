// index.js (CommonJS)
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// ===== Credenciales WABA (con fallback a ENV) =====
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN     || 'mi_verify_token_super_seguro';
const WABA_TOKEN       = process.env.WABA_TOKEN       || 'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID  || '756528907544969';
const APP_SECRET       = process.env.APP_SECRET       || '89bb6d2367a4ab0ad3e94021e7cb2046'; // (no usado aquí)

// ===== Config de correo (definida vía ENV en Render) =====
// Para Gmail con App Password: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_SECURE=true
const SMTP_HOST   = process.env.SMTP_HOST   || '';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const SMTP_USER   = process.env.SMTP_USER   || '';
const SMTP_PASS   = process.env.SMTP_PASS   || '';
const SMTP_SECURE = (process.env.SMTP_SECURE || 'true') === 'true';
const MAIL_FROM   = process.env.MAIL_FROM   || ''; // ej. "UNIDEP Bot <notificaciones@unidep.edu.mx>"
const MAIL_TO     = process.env.MAIL_TO     || ''; // ej. "ricardo.martinezh@unidep.edu.mx"

const emailEnabled = SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM && MAIL_TO;
let transporter = null;

if (emailEnabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('✉️  Email notifications: ENABLED');
} else {
  console.log('✉️  Email notifications: DISABLED (faltan variables SMTP*)');
}

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

  const mid = res.data?.messages?.[0]?.id || 'n/a';
  console.log(`↪︎ Enviado a ${to} | msgId=${mid}`);
};

// Enviar email cuando digan "No estoy interesado"
const sendNoInteresadoEmail = async ({ fromNumber, name, text }) => {
  if (!emailEnabled) {
    console.log('✉️  (omitido) Email no configurado.');
    return;
  }
  const subject = `No interesado: ${fromNumber} (${name || 'sin nombre'})`;
  const html = `
    <h3>Nuevo "No estoy interesado"</h3>
    <ul>
      <li><b>Número:</b> ${fromNumber}</li>
      <li><b>Nombre:</b> ${name || 'n/a'}</li>
      <li><b>Mensaje:</b> ${text || 'n/a'}</li>
      <li><b>Fecha:</b> ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</li>
    </ul>
  `;
  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    html
  });
  console.log(`✉️  Email enviado: ${info.messageId || 'ok'}`);
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
    if (body?.object && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const change = entry.changes?.[0];
        const value  = change?.value;

        // Mensajes entrantes
        const msg = value?.messages?.[0];
        if (msg) {
          const from  = msg.from; // número E.164 sin '+'
          const name  = value?.contacts?.[0]?.profile?.name || 'n/a';
          const text  = getMessageText(msg);
          console.log(`💬 Mensaje de ${from} (${name}) | texto="${text}"`);

          const n = normalize(text);
          let reply = null;

          if (n === 'no estoy interesado') {
            reply = 'Perfecto borramos su registro. Gracias';
            console.log('↪︎ Acción: respuesta "no interesado"');
            // Notificar por correo
            try {
              await sendNoInteresadoEmail({ fromNumber: from, name, text });
            } catch (err) {
              console.error('❌ Error al enviar email:', err?.message || err);
            }
          } else if (n === 'gracias' || n === 'si' || n === 'sí') {
            reply = null;
            console.log('↪︎ Acción: sin respuesta (gracias/si)');
          } else if (text) {
            reply = 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias';
            console.log('↪︎ Acción: respuesta automática general');
          }

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

        // Status de entrega/lectura
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
    res.sendStatus(200);
  }
});

// Arranque
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log('////////////////////////////////////////////////////////');
  console.log(`==> Your service is live 🎉`);
  console.log('////////////////////////////////////////////////////////');
});