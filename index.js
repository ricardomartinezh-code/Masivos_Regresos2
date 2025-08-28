import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import axios from "axios";

// ====== CONFIG (con tus valores y también soporta variables de entorno) ======
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || "mi_verify_token_super_seguro";
const WABA_TOKEN      = process.env.WABA_TOKEN      || "EAALJbUFKlZCIBPZAC4QZAYEAghngQDfWlEBRQxZCNAxZCUN0MlYWQkThiqFqQfI9BHB9S8B55dc2Ls9rnn3bFH4QHxfpATWYSHQZCipn831vPLH1ra1TSDSRJ7ThbmZBYKNEEpBMdZAuq0gUyVeD3nZCOsBD9jMEdkKNZBdgmaPtbNmyR9w2ujiz3PTm1tjJ51ZBfHIhAZDZD";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "756528907544969";
const APP_SECRET      = process.env.APP_SECRET      || "89bb6d2367a4ab0ad3e94021e7cb2046";
const PORT           = process.env.PORT || 3000;

// ====== APP ======
const app = express();

// Guardamos el raw body para validar la firma
app.use(bodyParser.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Valida firma X-Hub-Signature-256 de Meta (recomendado)
function verifySignature(req) {
  const header = req.get("x-hub-signature-256");
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Salud
app.get("/", (_req, res) => res.status(200).send("ok"));

// Verificación inicial de webhook (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✓ Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  console.warn("✗ Verificación fallida (mode/token incorrectos).");
  return res.sendStatus(403);
});

// Recepción de notificaciones (POST)
app.post("/webhook", (req, res) => {
  if (!verifySignature(req)) {
    console.warn("Firma X-Hub-Signature inválida.");
    // Si quisieras forzar reintentos: return res.sendStatus(403);
  }

  const body = req.body;
  if (body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msg   = body.entry[0].changes[0].value.messages[0];
    const from  = msg.from;
    const type  = msg.type;
    const text  = type === "text" ? (msg.text?.body || "") : "";
    console.log(`Mensaje recibido de ${from}: [${type}] ${text}`);
  } else {
    console.log("Evento:", JSON.stringify(body));
  }

  // WhatsApp exige 200 en <10s
  res.sendStatus(200);
});

// Endpoint de prueba para enviar tu template "masivos_ricardo" (es_ES)
app.post("/send-template", async (req, res) => {
  try {
    const to = req.query.to || "523349834406"; // cambia si quieres probar otro destino

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "masivos_ricardo",
        language: { code: "es_ES" }
      }
    };

    const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    res.status(200).json(r.data);
  } catch (err) {
    console.error("Error enviando template:", err?.response?.data || err.message);
    res.status(500).json(err?.response?.data || { error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});