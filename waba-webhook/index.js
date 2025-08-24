import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();

// Guardamos el raw body para validar la firma
app.use(bodyParser.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ---------- CONFIG ----------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_verify_token_super_seguro";
const APP_SECRET   = process.env.APP_SECRET   || ""; // ponlo en Render
const PORT         = process.env.PORT || 3000;
// ----------------------------

// GET /webhook -> Verificación inicial de Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  console.warn("Verificación fallida: token o modo inválidos.");
  return res.sendStatus(403);
});

// POST /webhook -> Recepción de eventos
app.post("/webhook", (req, res) => {
  // (Recomendado) Validar firma de Meta
  if (APP_SECRET && !isValidSignature(req, APP_SECRET)) {
    console.error("Firma inválida - rechazando request.");
    return res.sendStatus(403);
  }

  const body = req.body || {};
  if (body.object === "whatsapp_business_account") {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const val = change.value || {};

        // Mensajes entrantes
        if (val.messages) {
          val.messages.forEach(m => {
            const from = m.from; // número del usuario
            const txt  = m.text?.body ?? JSON.stringify(m);
            console.log("MSG IN >", from, ":", txt);
          });
        }

        // Estados de mensajes enviados (delivered, read, failed, etc.)
        if (val.statuses) {
          val.statuses.forEach(s => {
            console.log("STATUS >", s.id, s.status, s.timestamp);
          });
        }

        // Metadatos útiles
        if (val.metadata) {
          console.log("META >", val.metadata);
        }
      });
    });

    // Responder rápido
    return res.sendStatus(200);
  }

  // Si no es evento de WABA, responde 404 para que Meta no reintente
  return res.sendStatus(404);
});

// Salud
app.get("/", (_req, res) => res.status(200).send("OK"));

// Utilidad: validación de la firma X-Hub-Signature-256
function isValidSignature(req, appSecret) {
  const signature = req.get("x-hub-signature-256"); // "sha256=..."
  if (!signature || !signature.startsWith("sha256=") || !req.rawBody) return false;

  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");

  // timing-safe compare
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.listen(PORT, () => console.log(`Webhook escuchando en puerto ${PORT}`));
