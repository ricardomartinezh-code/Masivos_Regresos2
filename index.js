// ====== Webhook WhatsApp + Respuestas + Email (Gmail APP Password) ======
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------ Config ------
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const APP_SECRET      = process.env.APP_SECRET || ''; // opcional para validar firma

// Email (Gmail con contraseña de aplicación)
const SMTP_USER = ricardomartinez19b@gmail.com
const SMTP_PASS = process.env.SMTP_PASS || 'uwdlbouzhvkdshpt';
const SMTP_TO   = ricardo.martinezh@unidep.edu.mx
const SMTP_FROM = UNIDEP Bot <ricardomartinez19b@gmail.com>
const SMTP_PASS = uwdlbouzhvkdshpt
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';

// Enlace para interesados
const INTEREST_LINK = process.env.INTEREST_LINK || 'https://wa.me/523349834926?text=Hola%20me%20interesa%20saber%20m%C3%A1s';

// Puerto
const PORT = process.env.PORT || 3000;

// ------ Utils ------
const log = (...args) => console.log(...args);

function normalizeText(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase().trim();
}

function matchesAny(text, patterns = []) {
  const t = normalizeText(text);
  return patterns.some(p => {
    const n = normalizeText(p);
    return t === n || t.includes(n);
  });
}

function getHeaderSignature(req) {
  return req.get('x-hub-signature-256') || '';
}

function validateSignature(reqBody, signature) {
  if (!APP_SECRET) return true; // si no hay secreto, no validamos firma
  try {
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(reqBody);
    const expected = 'sha256=' + hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ------ Envío de WhatsApp ------
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WABA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log('❌ Error enviando WA:', res.status, JSON.stringify(data));
  } else {
    log('📤 Enviado a', to, '| msgId=', data.messages?.[0]?.id || 'n/a');
  }
  return { ok: res.ok, data };
}

// ------ Email ------
const emailEnabled = SMTP_USER && SMTP_PASS && SMTP_TO && SMTP_FROM;
let transporter = null;

if (emailEnabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  log('📧 Email notifications: ENABLED');
} else {
  log('📪 Email notifications: DISABLED (faltan variables SMTP*)');
}

async function sendEmailNoInteresado({ fromWa, name, text }) {
  if (!emailEnabled) return;

  const subject = `Baja / No interesado - ${fromWa}${name ? ` (${name})` : ''}`;
  const html = `
    <h2>Solicitud de BAJA / NO INTERESADO</h2>
    <p><b>Número:</b> ${fromWa}</p>
    ${name ? `<p><b>Nombre:</b> ${name}</p>` : ''}
    <p><b>Mensaje:</b> ${text || '(omito texto)'}</p>
    <p>Fecha: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</p>
  `;

  try {
    await transporter.sendMail({
      from: `"UNIDEP Bot" <${SMTP_USER}>`,
      to: DEST_EMAIL,
      subject,
      html
    });
    log('📨 Email enviado a', DEST_EMAIL);
  } catch (e) {
    log('❌ Error enviando email:', e.message);
  }
}

// ------ Extraer texto y remitente del webhook ------
function extractIncoming(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // statuses (entregas, lecturas, etc.)
    const status = value?.statuses?.[0];
    if (status) {
      return { type: 'status', status };
    }

    // mensajes
    const msg = value?.messages?.[0];
    if (!msg) return { type: 'unknown' };

    const fromWa = msg.from; // número del usuario
    const name = value?.contacts?.[0]?.profile?.name || '';
    let text = '';

    // text
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    }

    // quick reply (botón)
    if (msg.type === 'button') {
      text = msg.button?.text || msg.button?.payload || 'boton';
    }

    // interactive (button_reply o list_reply)
    if (msg.type === 'interactive') {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      if (br) text = br.title || br.id || 'boton';
      if (lr) text = lr.title || lr.id || 'lista';
    }

    return {
      type: 'message',
      fromWa,
      name,
      text,
      raw: msg
    };
  } catch {
    return { type: 'unknown' };
  }
}

// ------ Ruteo de respuestas ------
async function handleAutoReply({ fromWa, name, text }) {
  const ntext = normalizeText(text);

  // 1) No interesado (incluye botones y variantes)
  const noInteres = [
    'no estoy interesado', 'no gracias', 'no', 'no me interesa',
    'no quiero', 'no estoy interesada', 'no estoy interesadx'
  ];
  const esNoInteres = matchesAny(ntext, [...noInteres, 'boton no estoy interesado', 'boton no gracias', 'boton no']);

  if (esNoInteres) {
    log('↪︎ Acción: respuesta "no interesado"');
    await sendWhatsAppText(fromWa, 'Perfecto, borramos su registro. Gracias');
    await sendEmailNoInteresado({ fromWa, name, text });
    return;
  }

  // 2) Gracias / Sí  => sin respuesta
  const noResponder = ['gracias', 'si', 'sí', 'ok', 'va', 'vale', 'entendido'];
  if (matchesAny(ntext, noResponder)) {
    log('↪︎ Acción: no responder (agradecimiento/confirmación)');
    return;
  }

  // 3) Interesado / informes => mandar enlace
  const interesados = [
    'estoy interesado', 'estoy interesada', 'quiero informes', 'informes',
    'me interesa', 'mas info', 'más info', 'quiero informacion', 'quiero información'
  ];
  if (matchesAny(ntext, interesados)) {
    const msg = `¡Excelente! Aquí tienes más información: ${INTEREST_LINK}`;
    log('↪︎ Acción: interesado → enviar enlace');
    await sendWhatsAppText(fromWa, msg);
    return;
  }

  // 4) Por defecto => mensaje de espera
  log('↪︎ Acción: respuesta por defecto');
  await sendWhatsAppText(fromWa, 'Hola, nos pondremos en contacto contigo tan pronto nos sea posible. Gracias');
}

// ------ Webhook GET (verificación) ------
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('✅ Webhook verificado (GET).');
    return res.status(200).send(challenge);
  }
  log('⛔ Webhook NO verificado (GET).');
  return res.sendStatus(403);
});

// ------ Webhook POST (eventos) ------
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Validación de firma (opcional)
  const sig = getHeaderSignature(req);
  if (!validateSignature(req.body, sig)) {
    log('❌ Firma X-Hub-Signature inválida.');
    return res.sendStatus(401);
  }
  // Express.raw nos deja el body como Buffer, parseamos y seguimos con el resto
  try {
    const json = JSON.parse(req.body.toString('utf8'));
    // Pasamos JSON al siguiente handler
    req.parsedBody = json;
    next();
  } catch {
    log('❌ Body inválido');
    return res.sendStatus(400);
  }
}, async (req, res) => {
  const body = req.parsedBody;

  const incoming = extractIncoming(body);
  if (incoming.type === 'status') {
    const st = incoming.status;
    log(`🔔 Status: to=${st.recipient_id} status=${st.status} msgId=${st.id || st.message_id || 'n/a'} conv=${st.conversation?.id || 'n/a'}`);
    return res.sendStatus(200);
  }

  if (incoming.type === 'message') {
    const { fromWa, name, text } = incoming;
    log(`💬 Mensaje de ${fromWa}${name ? ` (${name})` : ''} | texto="${text}"`);
    try {
      await handleAutoReply({ fromWa, name, text });
    } catch (e) {
      log('❌ Error en auto-reply:', e.message);
    }
    return res.sendStatus(200);
  }

  // desconocido
  log('ℹ️ Evento no reconocido');
  return res.sendStatus(200);
});

// ------ Health & root ------
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.get('/', (req, res) => res.send('Webhook UNIDEP listo ✅'));

app.listen(PORT, () => {
  log('//////////////////////////////////////////////////////////');
  if (!emailEnabled) log('📪 Email notifications: DISABLED (faltan variables SMTP*)');
  log(`🚀 Servidor escuchando en puerto ${PORT}`);
  log('//////////////////////////////////////////////////////////');
});