// index.js
import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';

const app = express();

// Guardamos el raw body para validar firma (si hay APP_SECRET)
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ======= Credenciales ======= */
const VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';

const WABA_TOKEN =
  process.env.WABA_TOKEN ||
  // Fallback que me diste
  'EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD';

const PHONE_NUMBER_ID =
  process.env.PHONE_NUMBER_ID || '756528907544969';

const APP_SECRET =
  process.env.APP_SECRET ||
  '89bb6d2367a4ab0ad3e94021e7cb2046';

// SMTP (solo desde env; si no hay pass, no se envía correo)
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || ''; // <- contraseña de app
const EMAIL_FROM =
  process.env.EMAIL_FROM || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';
const EMAIL_TO = process.env.EMAIL_TO || ''; // a quién reenviar “no interesado”

const canEmail = SMTP_USER && SMTP_PASS && EMAIL_TO;

const mailer = canEmail
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

/* ======= Utils ======= */
function validateSignature(req) {
  if (!APP_SECRET) return true; // sin secreto, no validamos
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    const hmac = crypto
      .createHmac('sha256', APP_SECRET)
      .update(req.rawBody)
      .digest('hex');
    return signature === `sha256=${hmac}`;
  } catch {
    return false;
  }
}

function normalize(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')
    .trim();
}

// Extrae el texto real del mensaje (texto, botón interactivo, lista, etc.)
function getIncomingText(msg) {
  if (!msg) return { text: '', source: 'unknown' };

  const t = msg.type;

  if (t === 'text' && msg.text?.body) {
    return { text: msg.text.body, source: 'text' };
  }

  // Formato moderno de interactivos
  if (t === 'interactive' && msg.interactive) {
    const it = msg.interactive;
    if (it.type === 'button_reply' && it.button_reply) {
      const title = it.button_reply.title || '';
      const id = it.button_reply.id || '';
      return { text: title || id || 'boton', source: 'button_reply', id };
    }
    if (it.type === 'list_reply' && it.list_reply) {
      const title = it.list_reply.title || '';
      const id = it.list_reply.id || '';
      return { text: title || id, source: 'list_reply', id };
    }
  }

  // Formato antiguo de botones
  if (t === 'button' && msg.button) {
    const title = msg.button.text || msg.button.title || '';
    const id = msg.button.payload || '';
    return { text: title || id || 'boton', source: 'button', id };
  }

  return { text: '', source: t || 'unknown' };
}

function isNoInteresado(text, btnId = '') {
  const n = normalize(text);
  const id = normalize(btnId || '');
  const patterns = [
    /^no$/,
    /^no gracias$/,
    /no estoy interesad[oa]/,
    /no\s*interesad[oa]/,
  ];
  if (patterns.some((re) => re.test(n))) return true;

  const idMatches = ['no', 'no_gracias', 'nointeresado', 'no_interesado'];
  if (id && idMatches.includes(id)) return true;

  return false;
}

function isSilence(text) {
  const n = normalize(text);
  return n === 'gracias' || n === 'si' || n === 'sí';
}

async function sendWAText(to, body) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

async function sendNoInteresadoEmail({ from, name, text }) {
  if (!canEmail) {
    console.log('📧 (omitido) Email no configurado.');
    return;
  }
  const subject = `NO INTERESADO - ${from}`;
  const html = `
    <h3>Contacto marcó "No interesado"</h3>
    <p><b>Número:</b> ${from}</p>
    <p><b>Nombre:</b> ${name || 'N/D'}</p>
    <p><b>Texto/ botón:</b> ${text || 'N/D'}</p>
    <p>Fecha: ${new Date().toLocaleString('es-MX')}</p>
  `;
  await mailer.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html,
  });
  console.log('📧 Email enviado ✅');
}

/* ======= Rutas ======= */

// Health checks
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

// Verificación (GET)
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
  if (!validateSignature(req)) {
    console.log('❌ Firma inválida (X-Hub-Signature-256).');
    return res.sendStatus(403);
  }

  const body = req.body;

  // Confirmamos recepción rápido
  res.sendStatus(200);

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const val = change?.value;

    // Status de mensajes (enviados, entregados, leídos)
    const statuses = val?.statuses;
    if (Array.isArray(statuses)) {
      for (const st of statuses) {
        const to = st.recipient_id || 'n/a';
        console.log(
          `🔔 Status: to=${to} status=${st.status} msgId=${st.id} conv=${st.conversation?.id || 'n/a'}`
        );
      }
    }

    // Mensajes entrantes
    const messages = val?.messages;
    if (Array.isArray(messages)) {
      const msg = messages[0];
      const from = msg.from;
      const contact = val?.contacts?.[0];
      const name = contact?.profile?.name || contact?.wa_id || 'N/D';

      const { text, source, id } = getIncomingText(msg);

      console.log(
        `💬 Mensaje de ${from} (${name}) | texto="${text}" (tipo:${source})`
      );

      // Reglas
      if (isNoInteresado(text, id)) {
        console.log('↪️ Acción: responde "no interesado"');
        await sendWAText(from, 'Perfecto borramos su registro. Gracias');
        await sendNoInteresadoEmail({ from, name, text });
        return;
      }

      if (isSilence(text)) {
        console.log('🤐 Regla: no responder (si/gracias).');
        return;
      }

      // Respuesta por defecto
      await sendWAText(
        from,
        'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias'
      );
      console.log('➡️ Auto-reply enviado.');
    }
  } catch (e) {
    console.error('❌ Error procesando webhook:', e?.response?.data || e);
  }
});

/* ======= Inicio ======= */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});