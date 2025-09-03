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

// Horario comercial (local: América/México_City aprox). Ajusta a tu gusto:
const BUSINESS_START_HOUR = 15;   // 09:00
const BUSINESS_END_HOUR   = 21;  // 20:00

// Fallback control
const FALLBACK_COOLDOWN_MIN = 240;  // Evita repetir fallback por usuario durante 4 horas
const UNKNOWN_BEFORE_FALLBACK = 1;  // Cuántos mensajes “no entendidos” tolerar antes de mostrar el fallback
const CONTEXT_TTL_MIN = 1440;       // Considera “conversación activa” por 24h desde la última intención reconocida

// ====== APP ======
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// ====== ESTADO EN MEMORIA (puedes migrar a Redis/DB) ======
const SESSION = new Map();
/*
  SESSION.set(from, {
    lastIntentAt: Date,      // última vez que detectamos intención válida
    lastFallbackAt: Date,    // última vez que mandamos el fallback
    unknownCount: number,    // consecutivos “no entendidos”
  })
*/

// ====== UTILS ======
function nowMx() {
  // Servidor puede estar en UTC; ajusta si lo necesitas. Aquí usamos hora del sistema:
  return new Date();
}
function isBusinessHours(d = nowMx()) {
  const h = d.getHours();
  return h >= BUSINESS_START_HOUR && h < BUSINESS_END_HOUR;
}
function normalizeText(s = "") {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\.,/#!$%^&*;:{}=\-_`~()”“"’']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function minutesDiff(a, b) {
  return Math.abs((a.getTime() - b.getTime()) / 60000);
}
function getSession(from) {
  if (!SESSION.has(from)) {
    SESSION.set(from, { lastIntentAt: null, lastFallbackAt: null, unknownCount: 0 });
  }
  return SESSION.get(from);
}
function touchIntent(from) {
  const s = getSession(from);
  s.lastIntentAt = nowMx();
  s.unknownCount = 0;
}
function markUnknown(from) {
  const s = getSession(from);
  s.unknownCount += 1;
}
function canSendFallback(from) {
  const s = getSession(from);
  const now = nowMx();

  // Si hubo intención válida en la ventana de contexto, no spamear fallback
  if (s.lastIntentAt && minutesDiff(now, s.lastIntentAt) <= CONTEXT_TTL_MIN) {
    return false;
  }

  // Cooldown para no repetir el fallback
  if (s.lastFallbackAt && minutesDiff(now, s.lastFallbackAt) < FALLBACK_COOLDOWN_MIN) {
    return false;
  }

  // Solo mostrar fallback después de N desconocidos consecutivos
  if (s.unknownCount < UNKNOWN_BEFORE_FALLBACK) {
    return false;
  }

  s.lastFallbackAt = now;
  s.unknownCount = 0; // lo reiniciamos tras mostrarlo
  return true;
}

async function sendText(to, body) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.error("❌ Error enviando WA:", resp.status, t);
  }
}

// extrae texto de text o interactive
function extractIncomingText(message) {
  if (!message) return "";
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "interactive") {
    const it = message.interactive;
    if (it?.type === "button_reply") return it.button_reply?.title || it.button_reply?.id || "";
    if (it?.type === "list_reply")   return it.list_reply?.title   || it.list_reply?.id   || "";
  }
  return "";
}

// ====== PATRONES GENERALIZADOS ======
// Negativos (más amplio y robusto)
const RX_NEG = [
  /\bno\s+estoy\s+interesad[oa]s?\b/,
  /\bno\s+me\s+interesa(n)?\b/,
  /\bno\b.*\binteresad[oa]s?\b/,
  /\bgracias\b.*\b(no|ya no)\b/,
  /\b(ba(ja)?|alto|stop|cancelar|borrar|quitar|eliminar|desuscribir|unsubscribe|unsuscribe|no gracias)\b/,
  /\bno quiero\b|\bno por ahora\b|\botro dia\b|\bmas adelante\b/
];

// Positivos (afirmaciones y sinónimos comunes)
const RX_POS = [
  /\bsi\b|\bsí\b|\bclaro\b|\bok\b|\bokey\b|\bvale\b|\bde acuerdo\b|\bperfecto\b|\bme parece\b/,
  /\bestoy\s+interesad[oa]s?\b/,
  /\bme\s+interesa(n)?\b/,
  /\bquiero\b|\bdeseo\b|\badelante\b|\bva\b/
];

// Intenciones exactas pedidas
function isExact(a, b) { return normalizeText(a) === normalizeText(b); }

const RX_PRESENCIAL = [/^1$/, /informes?\s+oferta\s+presencial/];
const RX_REGRESAR   = [/^2$/, /quiero\s+regresar\s+a?\s*unidep/];
const RX_ONLINE     = [/^3$/, /informes?\s+oferta\s+online/];

function any(list, text) { return list.some(rx => rx.test(text)); }

// ====== WEBHOOK VERIFY (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== RECEPCIÓN (POST) ======
app.post("/webhook", async (req, res) => {
  try {
    // Firma
    const signature = req.get("x-hub-signature-256") || "";
    const expected  = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
    if (signature !== expected) return res.sendStatus(403);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    if (!messages || !messages.length) return res.sendStatus(200);

    const m = messages[0];
    const from = m.from;
    const raw = extractIncomingText(m);
    const text = normalizeText(raw);

    // Solo intervenimos con esta lógica DENTRO de horario comercial
    if (!isBusinessHours()) {
      return res.sendStatus(200);
    }

    // 1) Atajos numéricos / intenciones exactas
    if (any(RX_PRESENCIAL, text) || isExact(text, "informes oferta presencial")) {
      await sendText(from, "Excelente, ¿en que plantel y que programa estas interesado?");
      touchIntent(from);
      return res.sendStatus(200);
    }

    if (any(RX_REGRESAR, text) || isExact(text, "quiero regresar a unidep")) {
      await sendText(from, "Perfecto, me podrías apoyar con tu nombre completo o matricula, por favor 🙏");
      touchIntent(from);
      return res.sendStatus(200);
    }

    if (any(RX_ONLINE, text) || isExact(text, "informes oferta online")) {
      await sendText(from, "Excelente, ¿en que carrera estas interesado, o gustas que te comparta nuestra oferta Online?");
      touchIntent(from);
      return res.sendStatus(200);
    }

    // 2) Negativo (prioridad)
    if (any(RX_NEG, text) || isExact(text, "no estoy interesado")) {
      await sendText(from, "Perfecto, borramos tu registro. Gracias por tu tiempo");
      touchIntent(from); // lo marcamos para no volver a insistir
      return res.sendStatus(200);
    }

    // 3) Positivo (cuando no hubo negativo)
    if (any(RX_POS, text)) {
      await sendText(from, "Buen día. Perfecto, dame unos momentos más para apoyarte.");
      touchIntent(from);
      return res.sendStatus(200);
    }

    // 4) Desconocido → controlar fallback (sin spamear)
    markUnknown(from);
    if (canSendFallback(from)) {
      await sendText(
        from,
        "Para avanzar rápido, responde 1, 2 o 3:\n1) Informes Presencial\n2) Quiero regresar a UNIDEP\n3) Informes Online\n(Escribe NO para dejar de recibir info)"
      );
    }
    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ Webhook error:", e);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook listo en :${PORT}`));
