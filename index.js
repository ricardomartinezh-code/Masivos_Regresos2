// -----------------------------
// Dependencias
// -----------------------------
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

// -----------------------------
// App
// -----------------------------
const app = express();

// guarda el raw body por si luego quieres validar firma X-Hub-Signature
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// -----------------------------
// Config (usa variables de entorno en Render/Vercel)
// -----------------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_verify_token_super_seguro";
const WABA_TOKEN = process.env.WABA_TOKEN || ""; // <-- tu token permanente (System User Token)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // ej. 756528907544969
const PORT = process.env.PORT || 3000;

// -----------------------------
// Healthcheck
// -----------------------------
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// -----------------------------
// Verificación Webhook (GET /webhook)
// -----------------------------
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verificado correctamente.");
      return res.status(200).send(challenge);
    }
    console.warn("❌ Verificación fallida: token o modo inválidos.");
    return res.sendStatus(403);
  } catch (e) {
    console.error("❌ Error en verificación:", e);
    return res.sendStatus(500);
  }
});

// -----------------------------
// Recepción de eventos (POST /webhook)
// -----------------------------
app.post("/webhook", (req, res) => {
  try {
    const body = req.body;
    console.log("📦 Evento recibido:", JSON.stringify(body, null, 2));

    // ejemplo mínimo: detectar mensajes entrantes
    if (
      body.object