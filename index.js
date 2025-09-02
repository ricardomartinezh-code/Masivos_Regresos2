// ====== Webhook WhatsApp + Respuestas + Email (Gmail App Password) ======
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
// ⚠️ NO usar app.use(express.json()) antes del webhook: necesitamos el body crudo para la firma
// Si luego agregas otras rutas que sí necesiten JSON, ponlas después del /webhook

// ------ Config ------
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN || 'naAJ0gxqI0Gd9ZCKGZA1OkWZAA9OzcTW443QCxZCf0Lb5ZBm1Bxktd1twFi0eZBcs7cUHe80f7MSfXURfLka5rCi5P4RXPgvojZBZASLSMPxIcZAKvdMnuV3ZAOImKDWfKUGzdFheW8Drl8Xv0KjGcY9XZAu9V1ZAxmNoZAsEbgxGVPRBskPlgP6NxupeEYWvUZD';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '759100873953981';
const APP_SECRET      = process.env.APP_SECRET || '89bb6d2367a4ab0ad3e94021e7cb2046'; // opcional para validar firma

// Email (Gmail con contraseña de aplicación)
const SMTP_USER   = process.env.SMTP_USER   || 'ricardomartinez19b@gmail.com';
const SMTP_PASS   = process.env.SMTP_PASS   || 'uwdlbouzhvkdshpt'; // SIN espacios
const SMTP_TO     = process.env.SMTP_TO     || 'ricardo.martinezh@unidep.edu.mx';
const SMTP_FROM   = process.env.SMTP_FROM   || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') === 'true'; // true para 465

// Enlace para interesados
const INTEREST_LINK = process.env.INTEREST_LINK
  || 'https://wa.me/523349834926?text=Hola%20me%20interesa%20saber%20m%C3%A1s';

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

function validateSignature(rawBody, signature) {
  if (!APP_SECRET) return true; // si no hay secreto, no validamos firma
  try {
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(rawBody);
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
      from: SMTP_FROM,
      to: SMTP_TO,
      subject,
      html
    });
    log('📨 Email enviado a', SMTP_TO);
  } catch (e) {
    log('❌ Error enviando email:', e.message);
  }
}

// ------ Extraer texto y remitente del webhook ------
function extractIncoming(body) {
  try {
    const entry  = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Notificaciones de estado (delivered, read, etc.)
    const status = value?.statuses?.[0];
    if (status) return { type: 'status', status };

    // Mensaje entrante
    const msg    = value?.messages?.[0];
    if (!msg) return { type: 'unknown' };

    const fromWa = msg.from;
    const name   = value?.contacts?.[0]?.profile?.name || '';

    let text = '';
    let meta = {};

    // 1) Texto normal
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    }

    // 2) Respuesta de botón de template (type: "button")
    if (msg.type === 'button') {
      const b = msg.button || {};
      text = b.text || b.payload || '';
      meta = { kind: 'button', payload: b.payload || null, text: b.text || null };
    }

    // 3) Interactivos (quick reply o listas)
    if (msg.type === 'interactive') {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      if (br) {
        text = br.title || br.id || '';
        meta = { kind: 'interactive_button', id: br.id || null, title: br.title || null };
      }
      if (lr) {
        text = lr.title || lr.id || '';
        meta = { kind: 'interactive_list', id: lr.id || null, title: lr.title || null };
      }
    }

    // 4) Último recurso: si sigue vacío, loguea RAW para depurar
    if (!text) {
      console.log('⚠️ No pude extraer texto. Raw message:\n', JSON.stringify(msg, null, 2));
    }

    return { type: 'message', fromWa, name, text, raw: msg, meta };
  } catch (e) {
    console.log('❌ extractIncoming error:', e.message);
    return { type: 'unknown' };
  }
}

// ------ Ruteo de respuestas ------
function normalizeText(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function matchesAny(text, patterns = []) {
  const t = normalizeText(text);
  return patterns.some(p => {
    const n = normalizeText(p);
    return t === n || t.includes(n);
  });
}

async function handleAutoReply({ fromWa, name, text, meta }) {
  const ntext = normalizeText(text);

  // Palabras/variantes
  const noInteres = [
    'Ya pague','Ya termine mis estudios','No estoy interesado', 'No estoy interesada',
    'No me interesa', 'No gracias', 'No', 'No quiero'
  ];

  // También detecta por botón aunque el texto venga vacío,
  // usando meta.kind o payload/id del botón
  const payloadStr = [
    meta?.payload, meta?.id, meta?.title, meta?.text
  ].filter(Boolean).join(' ').toLowerCase();

  const esNoInteres =
    matchesAny(ntext, noInteres) ||
    (meta?.kind && /button|interactive/.test(meta.kind) &&
      (matchesAny(payloadStr, noInteres)));

  if (esNoInteres) {
    console.log('↪︎ Acción: respuesta "no interesado"');
    await sendWhatsAppText(fromWa, 'Perfecto, borramos su registro. Gracias');
    await sendEmailNoInteresado({ fromWa, name, text: text || payloadStr || '(botón)' });
    return;
  }

  // “gracias” → no responder
  const noResponder = ['Gracias','gracias', 'Ok', 'Va', 'Vale', 'Entendido'];
  if (matchesAny(ntext, noResponder)) {
    console.log('↪︎ Acción: no responder (agradecimiento/confirmación)');
    return;
  }

  // Interesado → link
  const interesados = [
    'Estoy interesado','Estoy interesada','Quiero informes','Informes',
    'Me interesa','Mas info','Más info','Si','Sí','Chi','Shi','Quiero informacion','Quiero información'
  ];
  if (matchesAny(ntext, interesados)) {
    const msg = `¡Excelente! Aquí tienes más información: ${INTEREST_LINK}`;
    console.log('↪︎ Acción: interesado → enviar enlace');
    await sendWhatsAppText(fromWa, msg);
    return;
  }

  // Por defecto
  console.log('↪︎ Acción: respuesta por defecto');
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
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }), // importante para firma
  async (req, res) => {
    // Validación de firma (opcional)
    const sig = getHeaderSignature(req);
    if (!validateSignature(req.body, sig)) {
      log('❌ Firma X-Hub-Signature inválida.');
      return res.sendStatus(401);
    }

    // req.body es Buffer; parseamos a JSON
    let json;
    try {
      json = JSON.parse(req.body.toString('utf8'));
    } catch {
      log('❌ Body inválido');
      return res.sendStatus(400);
    }

    const incoming = extractIncoming(json);

    if (incoming.type === 'status') {
      const st = incoming.status;
      log(
        `🔔 Status: to=${st.recipient_id} status=${st.status} msgId=${st.id || st.message_id || 'n/a'} conv=${st.conversation?.id || 'n/a'}`
      );
      return res.sendStatus(200);
    }

if (incoming.type === 'message') {
  const { fromWa, name, text, meta } = incoming;
  console.log(`💬 Mensaje de ${fromWa}${name ? ` (${name})` : ''} | texto="${text}"`);
  try {
    await handleAutoReply({ fromWa, name, text, meta });
  } catch (e) {
    console.log('❌ Error en auto-reply:', e.message);
  }
  return res.sendStatus(200);
}

    // desconocido
    log('ℹ️ Evento no reconocido');
    return res.sendStatus(200);
  }
);

// ------ Health & root ------
app.get('/healthz', (req, res) =>
  res.status(200).json({ ok: true, uptime: process.uptime() })
);
app.get('/', (req, res) => res.send('Webhook UNIDEP listo ✅'));

app.listen(PORT, () => {
  log('//////////////////////////////////////////////////////////');
  if (!emailEnabled) log('📪 Email notifications: DISABLED (faltan variables SMTP*)');
  log(`🚀 Servidor escuchando en puerto ${PORT}`);
  log('//////////////////////////////////////////////////////////');
});
