// ====== Webhook WhatsApp UNIDEP — Final con pausa de emergencia ======
// • Sin duplicidades, ruteo en un solo orden
// • Horario comercial (America/Mexico_City) via BIZ_START_HOUR / BIZ_END_HOUR
// • “El bot no se mete” si el humano ya llevaba la charla (initiated=false)
// • Reanudación por frases clave o menú 1–6
// • Costos/Beca desde ./data/costos.json + ./data/plantel_tier.json
// • Psicología se cotiza como Salud (12) aunque se comunique 9
// • Pagos: transferencia (imagen+texto) / liga / en plantel (correo)
// • Correo automático SOLO cuando llega IMAGEN (comprobante) — no responde por WA
// • Pausa de emergencia: EMERGENCY_PAUSE=true o admin #pausa / #reanudar

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Node 18+ trae fetch global. Si usas Node <=16: const fetch = require('node-fetch');

const app = express();

// ====== CONFIG (usa las mismas ENVs que ya tienes en Render) ======
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN      || 'EAALJbUFKlZCIBPeSAqtTxH4Cqg4gq48iKvMOZBxTNsj4sJpabWDLGSYlhODZBk5p9p71W80VRoZBWKkjHVF5seEFQcbjq5kxdhDBv2ZC4eCYMEZBYtvgLZCtRPTFfUYp5HT6TTZBWLAYsJjoIickcBCaiClQpxdzSDtnuARHftuD7VKXwpwL6gmTnGVfEihv0ZA4B2BR0jgfq2scZD';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '759100873953981';
const APP_SECRET      = process.env.APP_SECRET      || '89bb6d2367a4ab0ad3e94021e7cb2046';
const PORT = process.env.PORT || 3000;

// Horario comercial
const BIZ_START_HOUR = Number(process.env.BIZ_START_HOUR || 12);   // 12:00
const BIZ_END_HOUR   = Number(process.env.BIZ_END_HOUR   || 21);  // 21:00 (exclusivo)
const TIMEZONE       = 'America/Mexico_City';

// Pausa de emergencia global
let EMERGENCY_PAUSE_RUNTIME = String(process.env.EMERGENCY_PAUSE || 'false') === 'true';
// Admins (números internacionales, ej: "5213312345678,5215511122233")
const ADMIN_WA_IDS = (process.env.ADMIN_WA_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Imagen SPEI (Drive público → link directo)
const SPEI_IMAGE_URL = process.env.SPEI_IMAGE_URL
  || 'https://drive.google.com/uc?export=download&id=11J3Nha37yIUVHdZPwj38Ux-EUkdzlJfp';

const SPEI_TEXT = `Pasos para realizar una transferencia:
1. Selecciona la opción de transferencia a otros bancos
2. Captura la CLABE interbancaria:
072180012188037802
3. En caso de que te pida Nombre del beneficiario deberás colocar lo siguiente:
Servicios Educativos Onitrof S.A de C.V.
4. En el campo de referencia coloca el número de convenio: 0005546
5. En concepto o motivo de pago deberás escribir la matrícula a 9 dígitos (sin el guión)
6. Enviar captura de pantalla o foto del comprobante de pago.

Solo no se aceptan transferencias de Bancoppel, ya que no tenemos convenio con ellos. Y en caso de que sea desde Banorte su transferencia sin problemas puede decirme ya que es otro procedimiento 😊`;

// ====== EMAIL (opcional) ======
const SMTP_USER   = process.env.SMTP_USER   || 'ricardomartinez19b@gmail.com';
const SMTP_PASS   = process.env.SMTP_PASS   || 'uwdlbouzhvkdshpt';
const SMTP_TO     = process.env.SMTP_TO     || 'ricardo.martinezh@unidep.edu.mx';
const SMTP_FROM   = process.env.SMTP_FROM   || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') === 'true';

const emailEnabled = SMTP_USER && SMTP_PASS && SMTP_TO && SMTP_FROM;
let transporter = null;
if (emailEnabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('📧 Email: ENABLED');
} else {
  console.log('📪 Email: DISABLED (faltan SMTP_*)');
}

// ====== DATA FILES ======
const COSTOS_JSON_PATH  = path.join(__dirname, 'data', 'costos.json');
const PLANTEL_TIER_PATH = path.join(__dirname, 'data', 'plantel_tier.json');

// Prepa presencial: duración por plantel (2/3 años) — si “2|3”, pedimos cuál
const PREPA_PRESENCIAL_DURACION = {
  "Cd. Mante": "2",
  "Chihuahua": "3",
  "Culiacán": "3",
  "Hermosillo": "3",
  "Nogales": "3",
  "Querétaro": "2|3",
  "Tijuana": "2",
  "Torreón": "2",
  "Zacatecas": "2"
};

// ====== SESIONES EN MEMORIA ======
const SESSION = new Map();
/*
  SESSION.set(from, {
    initiated: false,     // si ya arrancó el bot en este chat
    handoff: false,       // en manos de humano
    intent: null,         // 'costos' | 'pago' | 'pago_plantel' | 'inscrito' | 'maestria' | ...
    slots: { nivel, modalidad, plantel, promedio, plan, paymentMethod, citaDia, citaHorario },
    lastIntentAt: Date,
  })
*/
function getSession(from){
  if(!SESSION.has(from)){
    SESSION.set(from, {
      initiated:false,
      handoff:false,
      intent:null,
      slots:{ nivel:null, modalidad:null, plantel:null, promedio:null, plan:null, paymentMethod:null, citaDia:null, citaHorario:null },
      lastIntentAt:null
    });
  }
  return SESSION.get(from);
}
function touchIntent(from){
  const s = getSession(from);
  s.lastIntentAt = new Date();
}
const stripDiacritics = (s='') => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const normalizeText = (s='') => stripDiacritics(String(s)).toLowerCase().trim();

function hourInTZ(tz){
  const fmt = new Intl.DateTimeFormat('es-MX', { hour:'2-digit', hour12:false, timeZone: tz });
  return Number(fmt.format(new Date()));
}
function isBusinessHours(){
  const h = hourInTZ(TIMEZONE);
  return h >= BIZ_START_HOUR && h < BIZ_END_HOUR;
}

function isNoise(text=''){
  const t=normalizeText(text);
  if(!t) return true;
  if(t.length<=2) return true;
  if(/^[\p{P}\p{S}\s]+$/u.test(text)) return true; // solo signos/emoji
  const saludos = new Set(['hola','buenas','buen dia','buenos dias','buenas tardes','buenas noches','hey','holi','que tal','saludos','ok','va','vale','gracias']);
  return saludos.has(t);
}

// ====== SENDER WA ======
async function sendWhatsAppText(to, body){
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product:'whatsapp', to, type:'text', text:{ body } };
  const res = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${WABA_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
  if(!res.ok) console.error('❌ WA text:', await res.text().catch(()=>'')); 
}
async function sendImageByLink(to, link, caption=''){
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product:'whatsapp', to, type:'image', image:{ link, caption } };
  const res = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${WABA_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
  if(!res.ok) console.error('❌ WA image:', await res.text().catch(()=>'')); 
}

// ====== MEDIA / EMAIL ======
async function getMediaUrl(mediaId){
  const r = await fetch(`https://graph.facebook.com/v23.0/${mediaId}`, { headers:{ Authorization:`Bearer ${WABA_TOKEN}` } });
  if(!r.ok) throw new Error(`Media meta ${r.status}`);
  const j = await r.json();
  return j.url;
}
async function downloadMedia(url){
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${WABA_TOKEN}` } });
  if(!r.ok) throw new Error(`Media download ${r.status}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}
async function sendEmailComprobante({ fromWa, name, caption, filename, buffer, mimeType }){
  if(!emailEnabled) return;
  const subject = `Comprobante recibido - ${fromWa}${name?` (${name})`:''}`;
  const html = `
    <h2>Comprobante recibido</h2>
    <p><b>Número:</b> ${fromWa}</p>
    ${name ? `<p><b>Nombre:</b> ${name}</p>` : ''}
    ${caption ? `<p><b>Comentario:</b> ${caption}</p>` : ''}
    <p>Fecha: ${new Date().toLocaleString('es-MX',{ timeZone:'America/Mexico_City' })}</p>
  `;
  await transporter.sendMail({
    from: SMTP_FROM,
    to: SMTP_TO,
    subject,
    html,
    attachments: [{ filename: filename||'comprobante.jpg', content: buffer, contentType: mimeType||'image/jpeg' }]
  });
}
async function sendEmailCitaPlantel({ fromWa, name, plantel, dia, hora, raw }){
  if(!emailEnabled) return;
  const subject = `Cita para pago en plantel - ${fromWa}${name?` (${name})`:''}`;
  const html = `
    <h2>Cita solicitada para pago en plantel</h2>
    <p><b>Número:</b> ${fromWa}</p>
    ${name ? `<p><b>Nombre:</b> ${name}</p>` : ''}
    ${plantel ? `<p><b>Plantel:</b> ${plantel}</p>` : '<p><b>Plantel:</b> (no proporcionado)</p>'}
    ${dia ? `<p><b>Día:</b> ${dia}</p>` : '<p><b>Día:</b> (no proporcionado)</p>'}
    ${hora ? `<p><b>Hora:</b> ${hora}</p>` : '<p><b>Hora:</b> (no proporcionada)</p>'}
    <hr />
    <p><b>Texto del usuario:</b></p>
    <pre style="white-space:pre-wrap">${raw || '(sin texto)'}
    </pre>
    <p>Fecha registro: ${new Date().toLocaleString('es-MX',{ timeZone:'America/Mexico_City' })}</p>
  `;
  await transporter.sendMail({ from: SMTP_FROM, to: SMTP_TO, subject, html });
}

// ====== DATA LOADERS ======
function loadCostosData(){
  try{
    const raw = fs.readFileSync(COSTOS_JSON_PATH,'utf8');
    const data = JSON.parse(raw);
    if(!Array.isArray(data)) throw new Error('costos.json debe ser un arreglo');
    return data;
  }catch(e){
    console.log('⚠️ costos.json:', e.message);
    return null;
  }
}
let PLANTEL_TIER = null;
try{
  if(fs.existsSync(PLANTEL_TIER_PATH)){
    PLANTEL_TIER = JSON.parse(fs.readFileSync(PLANTEL_TIER_PATH,'utf8'));
    console.log('📚 plantel_tier.json cargado');
  } else {
    console.log('⚠️ plantel_tier.json no encontrado');
  }
}catch(e){ console.log('⚠️ plantel_tier.json error:', e.message); }

const normalizeKey = (s='') => stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g,'');

function tierFromPlantel(plantel){
  if(!plantel) return { licTier:null, saludTier:null };
  const k = normalizeKey(plantel);
  const toSet = (arr)=> new Set((arr||[]).map(normalizeKey));
  let licTier=null, saludTier=null;
  if(PLANTEL_TIER){
    const t1=toSet(PLANTEL_TIER.T1), t2=toSet(PLANTEL_TIER.T2), t3=toSet(PLANTEL_TIER.T3);
    if(t1.has(k)) licTier='T1'; else if(t2.has(k)) licTier='T2'; else if(t3.has(k)) licTier='T3';
    const s1=toSet(PLANTEL_TIER.SaludT1), s2=toSet(PLANTEL_TIER.SaludT2), s3=toSet(PLANTEL_TIER.SaludT3);
    if(s1.has(k)) saludTier='SaludT1'; else if(s2.has(k)) saludTier='SaludT2'; else if(s3.has(k)) saludTier='SaludT3';
  }
  return { licTier, saludTier };
}

// ====== COSTOS / BECA ======
function rangoMatch(rango, promedio){
  if(!rango || typeof promedio!=='number') return false;
  const min = typeof rango.min==='number' ? rango.min : 0;
  const max = typeof rango.max==='number' ? rango.max : 10;
  return promedio >= min && promedio <= max;
}

async function quoteCosts(slots){
  let { nivel, modalidad, plantel, plan, promedio } = slots;
  const data = loadCostosData();
  if(!data){
    return [
      'Puedo cotizarte mensualidad con tu promedio y modalidad.',
      'Falta ./data/costos.json (exportado del Excel).',
      `Detecté → Nivel: ${nivel||'¿?'}, Modalidad: ${modalidad||'¿?'}, Plan: ${plan||'¿?'}${modalidad==='presencial'?`, Plantel: ${plantel||'¿?'}`:''}, Promedio: ${promedio||'¿?'}`
    ].join('\n');
  }

  // Psicología = Salud: cotiza como 12 (pero se comunica 9 en conversación)
  const planForPricing = (nivel==='salud' && Number(plan)===9) ? 12 : Number(plan);

  // TIER
  let tier = null;
  if(modalidad==='presencial'){
    const { licTier, saludTier } = tierFromPlantel(plantel);
    if(nivel==='salud') tier = saludTier || 'Salud';
    else if(nivel==='licenciatura') tier = licTier;
  }

  const base = data.filter(row =>
    normalizeText(row.nivel) === normalizeText(nivel) &&
    normalizeText(row.modalidad) === normalizeText(modalidad) &&
    Number(row.plan) === Number(planForPricing) &&
    (tier ? normalizeText(row.tier||'') === normalizeText(tier) : true)
  );
  if(base.length===0){
    if(nivel==='salud' && Number(plan)===9) return 'No encontré tabla de Salud (plan 12) para cotizar Psicología. Revisa costos.json (Salud 12).';
    return `No encontré tabla para nivel=${nivel}, modalidad=${modalidad}, plan=${plan}${modalidad==='presencial'?`, plantel=${plantel}`:''}.`;
  }

  let candidates = base.filter(r=> rangoMatch(r.rango, promedio));
  if(candidates.length===0){
    const sorted = base.slice().sort((a,b)=>(a.rango?.min||0)-(b.rango?.min||0));
    if(sorted.length) candidates = [sorted[0]];
  }
  const chosen = candidates.sort((a,b)=> Math.abs((a.rango?.min||0)-promedio) - Math.abs((b.rango?.min||0)-promedio))[0];
  if(!chosen) return 'No pude determinar la mensualidad. Revisa costos.json';

  const beca = (typeof promedio==='number' && promedio >=6 && promedio <7) ? 0 : (typeof chosen.porcentaje==='number' ? chosen.porcentaje : null);
  const monto = typeof chosen.monto==='number' ? chosen.monto : null;
  const becaText = (typeof promedio==='number' && promedio < 7) ? 'sin beca' : (typeof beca==='number' ? `beca ${beca}%` : 'según promedio');

  if(nivel==='preparatoria'){
    const where = modalidad==='online' ? 'en Prepa Online' : `en ${plantel}`;
    const dur  = plan===6 ? '2 años' : plan===9 ? '3 años' : `${plan} cuatris`;
    return `Con tu promedio de ${promedio}, ${where} la colegiatura mensual queda en $${monto ?? '—'} (${becaText}, ${dur}).`;
  }
  if(nivel==='maestria'){
    return `Con tu promedio de ${promedio}, la colegiatura mensual de Maestría Online queda en $${monto ?? '—'} (${becaText}, 4 cuatrimestres).`;
  }
  if(nivel==='salud'){
    const where = modalidad==='online' ? 'Online' : `en ${plantel}`;
    const dur   = (Number(plan)===9) ? '9 cuatrimestres' : '12 cuatrimestres';
    return `Con tu promedio de ${promedio}, ${where} (Salud) la colegiatura mensual queda en $${monto ?? '—'} (${becaText}, ${dur}).`;
  }
  const where = modalidad==='online' ? 'Online' : `en ${plantel}`;
  const plano = plan ? `${plan} cuatrimestres` : 'plan';
  return `Con tu promedio de ${promedio}, ${where} la colegiatura mensual queda en $${monto ?? '—'} (${becaText}, ${plano}).`;
}

// ====== PARSERS ======
function inferSlotsFromText(slots, text){
  const t = normalizeText(text);
  if(/presencial/.test(t)) slots.modalidad='presencial';
  if(/online|en linea|en línea|virtual/.test(t)) slots.modalidad='online';

  if(/salud/.test(t)) slots.nivel='salud';
  if(/licenciatura|licenciatur(a|as)/.test(t)) slots.nivel='licenciatura';
  if(/maestri(a|ía)/.test(t)) slots.nivel='maestria';
  if(/prepa(ratoria)?|bachillerato/.test(t)) slots.nivel='preparatoria';

  // Psicología → tratar como Salud (presencial), comunicar 9, pero cotizar 12
  if(/psicolog/.test(t)){
    slots.nivel='salud';
    slots.modalidad = slots.modalidad || 'presencial';
    if(!slots.plan) slots.plan = 9;
  }

  if(/\b11\b.*cuatr/.test(t)) slots.plan=11;
  if(/\b9\b.*cuatr/.test(t))  slots.plan=9;
  if(/\b12\b.*cuatr/.test(t)) slots.plan=12;
  if(/\b6\b.*cuatr/.test(t))  slots.plan=6;

  if(/\b2\s*a(ño|nios|ños)\b/.test(t)) slots.plan=6;
  if(/\b3\s*a(ño|nios|ños)\b/.test(t)) slots.plan=9;

  const PLANTELES = new Set([
    ...Object.keys(PREPA_PRESENCIAL_DURACION),
    'Agua Prieta','Aguascalientes','Altamira','Cananea','Cd. del Carmen','Ca. Mante','Cd. Obregón','Teocaltiche','Veracruz',
    'Chihuahua','Culiacán','Ensenada','Los Cabos','Mexicali','Nogales','Puerto Peñasco','Querétaro','Saltillo','Torreón','Zacatecas',
    'Hermosillo','La Paz','Tijuana'
  ]);
  for(const p of PLANTELES){ if(t.includes(normalizeText(p))) { slots.plantel=p; break; } }

  const m=t.match(/\b(\d{1,2}(?:\.\d)?)\b/); // promedio 6..10
  if(m){ const val=Number(m[1]); if(val>=6 && val<=10) slots.promedio=val; }
}
function parseDiaHora(text=''){
  const m1 = text.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);             // dd/mm
  const m2 = text.match(/\b(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\b/);
  const m3 = text.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i);
  const h1 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);           // 24h
  const h2 = text.match(/\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b/i);
  const dia = m1 ? `${m1[1]}/${m1[2]}` : m2 ? `${m2[1]} de ${m2[2]}` : m3 ? m3[0] : null;
  const hora = h1 ? `${h1[1]}:${h1[2]}` : h2 ? `${h2[1]}:${h2[2]||'00'} ${h2[3].toUpperCase()}` : null;
  return { dia, hora };
}

// ====== REGLAS REGEX ======
const RX_POS = [ /\bsi\b/i, /\bs[ií]\b/i, /estoy\s+interesad/i, /me\s+interesa/i, /claro/i, /perfecto/i ];
const RX_NEG = [ /no\s+estoy\s+interesad/i, /no\s+me\s+interesa/i, /ya\s+no\b/i, /no\s+gracias/i ];

const RX_RESUME = [ /^continuo\s+en\s+espera$/i, /^continuar$/i, /^retomar\s+bot$/i, /^sigo\s+en\s+espera\s+de\s+informes$/i ];
const RX_PAUSE_PHRASES = [ /(^|\s)ok(ay)?\s*,?\s*pero\b/i, /\bes\s+que\b/i, /\by\s+si\b/i, /\bpero\s+yo\b/i, /\by\s+c[oó]mo\b/i ];

const RX_PAGO_INTENT = [ /\bc(o|ó)mo\s+pagar\b/i, /\bformas?\s+de\s+pago\b/i, /\bliga\s+de\s+pago\b/i, /\bpago\b/i ];
const RX_PAGO_TRANSFERENCIA = [ /transferencia(s)?\s*(bancaria)?/i, /\bSPEI\b/i ];
const RX_PAGO_LIGA = [ /\bliga\s+de\s+pago\b/i, /\blink\s+de\s+pago\b/i, /\bpagar?\s+con\s+tarjeta\b/i, /\bTPV\b/i ];
const RX_PAGO_PLANTEL = [ /\b(en|pagar?\s+en)\s+plantel(es)?\b/i, /\bpuedo\s+pagar?\s+en\s+plantel(es)?\b/i, /\bpago\s+en\s+plantel\b/i, /\bpagar?\s+en\s+caja\b/i, /\bcaja\b/i ];

function menuListText(){
  return [
    'Lo siento, no logro entenderte bien. ¿Me ayudas eligiendo una opción?',
    '1) Hablar con un asesor',
    '2) Calcular mi beca',
    '3) Maestrías',
    '4) Quiero pagar',
    '5) Ya estoy inscrito',
    '6) Ya no quiero más información'
  ].join("\n");
}
const RX_NUM = {
  '1': /^(?:1|hablar\s+con\s+(?:un\s+)?asesor)$/i,
  '2': /^(?:2|calcular\s+mi\s+beca|deseo\s+conocer\s+mi\s+beca)$/i,
  '3': /^(?:3|maestr[ií]as?)$/i,
  '4': /^(?:4|quiero\s+pagar|c[oó]mo\s+pagar|pago)$/i,
  '5': /^(?:5|ya\s+estoy\s+inscrit[oa])$/i,
  '6': /^(?:6|ya\s+no\s+quiero\s+m[aá]s\s+informaci[oó]n|no\s+estoy\s+interesad[oa])$/i
};
// Disparadores de arranque explícitos (además de RX_RESUME)
const RX_START_TRIGGERS = [
  ...Object.values(RX_NUM),
  /\b(informes|informaci[oó]n|beca|precio|costos|c[oó]mo\s+pagar|maestr[ií]a|maestr[ií]as|inscrito)\b/i
];

// ====== HELPERS DE PAUSA / MENÚ ======
async function pauseAndNotify(to, msg="Te contacto con un asesor para continuar. Si deseas que retome el asistente, escribe: “continuo en espera”."){
  const s = getSession(to); s.handoff = true; await sendWhatsAppText(to, msg);
}
async function handleMenuSelection(key, fromWa){
  const s = getSession(fromWa);
  switch(key){
    case '1': // asesor
      await pauseAndNotify(fromWa, '¡Perfecto! Te contacto con un asesor humano 👩‍💼👨‍💼');
      return true;
    case '2': // beca
      s.intent='costos'; s.initiated=true; s.handoff=false; touchIntent(fromWa);
      await sendWhatsAppText(fromWa, 'Vale, para calcular tu beca necesito tu promedio y modalidad (Presencial u Online). Si es Presencial, ¿en qué plantel te interesa?');
      return true;
    case '3': // maestrías
      s.intent='maestria'; s.initiated=true; s.handoff=false; touchIntent(fromWa);
      await pauseAndNotify(fromWa, 'Te pasamos con un asesor para compartirte la oferta de Maestrías 📚');
      return true;
    case '4': // pagar
      s.intent='pago'; s.slots.paymentMethod=null; s.initiated=true; s.handoff=false; touchIntent(fromWa);
      await sendWhatsAppText(fromWa, '¿Quieres pagar por transferencia bancaria o por liga de pago? (Si deseas pagar en plantel, indícalo)');
      return true;
    case '5': // inscrito
      s.intent='inscrito'; s.initiated=true; s.handoff=false; touchIntent(fromWa);
      await sendWhatsAppText(fromWa, '¿Cómo puedo ayudarte?');
      return true;
    case '6': // no info
      s.intent=null; s.initiated=true; s.handoff=false; touchIntent(fromWa);
      await pauseAndNotify(fromWa, 'Perfecto, borramos tu registro. Gracias por tu tiempo.');
      return true;
    default: return false;
  }
}

// ====== WEBHOOK VERIFY (GET) ======
app.get('/webhook', (req,res)=>{
  const mode=req.query['hub.mode']; const token=req.query['hub.verify_token']; const challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== WEBHOOK POST ======
app.use(express.raw({ type:'application/json' }));

app.post('/webhook', async (req,res)=>{
  // Firma (opcional)
  if(APP_SECRET){
    try{
      const signature = req.get('x-hub-signature-256') || '';
      const expected  = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
      if(!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(401);
    }catch{ return res.sendStatus(401); }
  }

  let json; try{ json=JSON.parse(req.body.toString('utf8')); }catch{ return res.sendStatus(400); }
  const entry  = json.entry?.[0];
  const change = entry?.changes?.[0];
  const value  = change?.value;

  // Status (entregas/lecturas)
  if(value?.statuses?.[0]) return res.sendStatus(200);

  const msg = value?.messages?.[0];
  if(!msg) return res.sendStatus(200);

  const fromWa = msg.from;
  const name   = value?.contacts?.[0]?.profile?.name || '';
  const s = getSession(fromWa);

  // ===== Pausa de EMERGENCIA =====
  // Admin commands: #pausa / #reanudar
  if(msg.type==='text' && ADMIN_WA_IDS.includes(fromWa)){
    const t = normalizeText(msg.text?.body || '');
    if(t.includes('#pausa'))  { EMERGENCY_PAUSE_RUNTIME = true;  await sendWhatsAppText(fromWa, '⏸️ Bot pausado globalmente.'); return res.sendStatus(200); }
    if(t.includes('#reanudar')){ EMERGENCY_PAUSE_RUNTIME = false; await sendWhatsAppText(fromWa, '▶️ Bot reanudado globalmente.'); return res.sendStatus(200); }
  }
  // Si está en pausa de emergencia, no respondemos (pero sí procesamos imagen→correo)
  if(EMERGENCY_PAUSE_RUNTIME && msg.type!=='image') return res.sendStatus(200);

  // ===== IMAGEN → correo (sin responder por WA), incluso fuera de horario y en emergencia =====
  if(msg.type==='image'){
    try{
      const caption = msg.image?.caption || '';
      const mediaId = msg.image?.id;
      const mime    = msg.image?.mime_type || 'image/jpeg';
      const url     = await getMediaUrl(mediaId);
      const buf     = await downloadMedia(url);
      await sendEmailComprobante({ fromWa, name, caption, filename:`comprobante_${fromWa}.jpg`, buffer:buf, mimeType:mime });
    }catch(e){ console.error('❌ imagen/email:', e.message); }
    return res.sendStatus(200);
  }

  // ===== Corte por horario (texto) =====
  if(!isBusinessHours()) return res.sendStatus(200);

  // ===== Extraer texto =====
  let text = '';
  if(msg.type==='text') text = msg.text?.body || '';
  if(msg.type==='button') text = msg.button?.text || msg.button?.payload || text;
  if(msg.type==='interactive'){
    const br=msg.interactive?.button_reply; const lr=msg.interactive?.list_reply;
    if(br) text = br.title || br.id || text;
    if(lr) text = lr.title || lr.id || text;
  }
  const ntext = normalizeText(text);

  // ===== Reanudación si está en handoff =====
  if(s.handoff){
    if(RX_RESUME.some(rx=>rx.test(ntext))){
      s.handoff=false; s.initiated=true;
      await sendWhatsAppText(fromWa, 'Una disculpa, dime cómo puedo ayudarte.\n\n'+menuListText());
    }
    return res.sendStatus(200);
  }

  // ===== Si el bot NO ha iniciado en este chat: sólo arranca con reanudación o disparadores claros =====
  if(!s.initiated){
    // reanudación
    if(RX_RESUME.some(rx=>rx.test(ntext))){
      s.initiated=true; touchIntent(fromWa);
      await sendWhatsAppText(fromWa, '¡Listo! ¿Cómo puedo ayudarte?\n\n'+menuListText());
      return res.sendStatus(200);
    }
    // menú/intent explícito
    const anyStart = RX_START_TRIGGERS.some(rx => rx.test(text));
    if(anyStart){
      s.initiated=true;
      // sigue el flujo abajo (no return) para que procese la intención
    } else {
      // humano llevaba la charla → bot no se mete
      return res.sendStatus(200);
    }
  }

  // ===== Inferencia de slots básica (si aplica) =====
  inferSlotsFromText(s.slots, text);

  // ===== Frases que piden pausa suave =====
  if(RX_PAUSE_PHRASES.some(rx=>rx.test(ntext))){
    await pauseAndNotify(fromWa);
    touchIntent(fromWa);
    return res.sendStatus(200);
  }

  // ===== Menú numérico 1–6 =====
  for(const [key,rx] of Object.entries(RX_NUM)){
    if(rx.test(text)){
      const handled = await handleMenuSelection(key, fromWa);
      if(handled) return res.sendStatus(200);
    }
  }

  // ===== Negativo → pausar =====
  if(RX_NEG.some(rx=>rx.test(ntext))){
    await pauseAndNotify(fromWa, 'Perfecto, borramos tu registro. Gracias por tu tiempo.');
    touchIntent(fromWa);
    return res.sendStatus(200);
  }

  // ===== Positivo → acuse (sin spamear) =====
  if(RX_POS.some(rx=>rx.test(ntext))){
    await sendWhatsAppText(fromWa, 'Buen día. Perfecto, dame unos momentos más para apoyarte.');
    touchIntent(fromWa);
    // continúa por si el texto hablaba de pagar/costos
  }

  // ===== Pago (transferencia / liga / plantel) =====
  if(RX_PAGO_INTENT.some(rx=>rx.test(ntext)) || s.intent==='pago' || s.intent==='pago_plantel'){
    // Pagar en plantel
    if(RX_PAGO_PLANTEL.some(rx=>rx.test(ntext))){
      s.intent='pago_plantel'; touchIntent(fromWa);
      if(!s.slots.plantel){ await sendWhatsAppText(fromWa,'¿En qué plantel te gustaría realizar el pago?'); return res.sendStatus(200); }
      await sendWhatsAppText(fromWa,'Okay, ¿qué día y en qué horario podrías acudir para agendar tu cita?');
      return res.sendStatus(200);
    }
    // Agenda cita en plantel (capturar y mandar correo)
    if(s.intent==='pago_plantel'){
      if(!s.slots.plantel){ await sendWhatsAppText(fromWa,'¿En qué plantel te gustaría realizar el pago?'); return res.sendStatus(200); }
      const { dia, hora } = parseDiaHora(text);
      s.slots.citaDia = s.slots.citaDia || dia;
      s.slots.citaHorario = s.slots.citaHorario || hora;
      try{ await sendEmailCitaPlantel({ fromWa, name, plantel:s.slots.plantel, dia:s.slots.citaDia, hora:s.slots.citaHorario, raw:text }); }catch(e){ console.error('❌ email cita plantel:', e.message); }
      await sendWhatsAppText(fromWa,'Listo, te agendo. Si necesito algo más te escribo por aquí.');
      await pauseAndNotify(fromWa, '¡Gracias! Quedo pendiente.');
      touchIntent(fromWa);
      return res.sendStatus(200);
    }

    // Ruta general pago
    s.intent='pago'; touchIntent(fromWa);
    if(!s.slots.paymentMethod){
      if(RX_PAGO_TRANSFERENCIA.some(rx=>rx.test(ntext))) s.slots.paymentMethod='transferencia';
      else if(RX_PAGO_LIGA.some(rx=>rx.test(ntext)))    s.slots.paymentMethod='liga';
      else { await sendWhatsAppText(fromWa,'¿Quieres pagar por transferencia bancaria o por liga de pago? (Si deseas pagar en plantel, indícalo)'); return res.sendStatus(200); }
    }
    if(s.slots.paymentMethod==='transferencia'){
      await sendWhatsAppText(fromWa,'Vale, te comparto el cómo pagar vía transferencia.');
      await sendImageByLink(fromWa, SPEI_IMAGE_URL);
      await sendWhatsAppText(fromWa, SPEI_TEXT);
      await pauseAndNotify(fromWa, 'En cuanto confirmes tu pago, seguimos. ¡Gracias!');
      touchIntent(fromWa); return res.sendStatus(200);
    }
    if(s.slots.paymentMethod==='liga'){
      await sendWhatsAppText(fromWa,'Perfecto, dame un momento y te genero tu liga de pago');
      await pauseAndNotify(fromWa, 'Quedo atento a tu confirmación.');
      touchIntent(fromWa); return res.sendStatus(200);
    }
  }

  // ===== Ya estoy inscrito =====
  if(/\bya\s+est(oy|a)\s+inscrit[oa]\b/i.test(ntext) || /\bestoy\s+inscrit[oa]\b/i.test(ntext) || s.intent==='inscrito'){
    s.intent='inscrito'; touchIntent(fromWa);
    await sendWhatsAppText(fromWa,'¿Cómo puedo ayudarte?');
    return res.sendStatus(200);
  }

  // ===== Clases =====
  if(/cuando\s+inicia[sn]?\s+las?\s+clases/i.test(ntext) || /cuando\s+comienzan?\s+las?\s+clases/i.test(ntext)){
    await sendWhatsAppText(fromWa,'Las clases comienzan este 15 de septiembre.');
    touchIntent(fromWa); return res.sendStatus(200);
  }

  // ===== Costos / Beca (slot-filling → cotiza → pausa) =====
  if(s.intent==='costos' || /costo(s)?|precio(s)?|cu(e|é)sta|inversi(ó|o)n|beca(s)?/i.test(ntext) || /deseo\s+conocer\s+mi\s+beca|calcular\s+mi\s+beca/i.test(ntext)){
    if(s.intent!=='costos') s.intent='costos';
    touchIntent(fromWa);

    // Completar slots mínimos
    const missing = [];
    if(!s.slots.nivel)      missing.push('nivel');
    if(!s.slots.modalidad)  missing.push('modalidad');

    if(s.slots.nivel==='preparatoria' && s.slots.modalidad==='presencial'){
      if(!s.slots.plantel) missing.push('plantel');
      else {
        const d = PREPA_PRESENCIAL_DURACION[s.slots.plantel];
        if(d==='2') s.slots.plan=6; else if(d==='3') s.slots.plan=9; else if(d==='2|3' && !s.slots.plan) missing.push('plan');
      }
    }
    if(s.slots.nivel==='licenciatura' && !s.slots.plan) missing.push('plan');
    if(s.slots.nivel==='salud'){ s.slots.plan = s.slots.plan || 12; } // psicología cotiza 12

    if(s.slots.modalidad==='presencial' && s.slots.nivel!=='preparatoria' && !s.slots.plantel) missing.push('plantel');
    if(!s.slots.promedio) missing.push('promedio');

    if(missing.length){
      if(missing.includes('nivel'))      { await sendWhatsAppText(fromWa,'¿Para qué nivel te interesa? (Salud / Licenciatura / Maestría / Preparatoria)'); return res.sendStatus(200); }
      if(missing.includes('modalidad'))  { await sendWhatsAppText(fromWa,'¿La modalidad sería Presencial u Online?'); return res.sendStatus(200); }
      if(missing.includes('plantel'))    { await sendWhatsAppText(fromWa,'¿En qué plantel te interesa cursar?'); return res.sendStatus(200); }
      if(missing.includes('plan')) {
        const hint = (s.slots.nivel==='preparatoria') ? '¿2 años (6 cuatrimestres) o 3 años (9 cuatrimestres)?'
                   : (s.slots.nivel==='licenciatura') ? '¿Plan de 9 o 11 cuatrimestres?'
                   : '¿Cuál es el plan?';
        await sendWhatsAppText(fromWa, hint); return res.sendStatus(200);
      }
      if(missing.includes('promedio')) {
        const hint = s.slots.nivel==='maestria' ? 'promedio de licenciatura'
                   : s.slots.nivel==='preparatoria' ? 'promedio de secundaria'
                   : 'promedio de preparatoria';
        await sendWhatsAppText(fromWa, `¿Cuál es tu ${hint}? (ej. 8.5)`); return res.sendStatus(200);
      }
    } else {
      const quote = await quoteCosts(s.slots);
      await sendWhatsAppText(fromWa, quote + '\n\n¿Qué te parece?');
      await pauseAndNotify(fromWa, 'Si deseas que el asistente continúe, escribe: “continuo en espera”.');
      touchIntent(fromWa); return res.sendStatus(200);
    }
  }

  // ===== Oferta académica → pausar según modalidad =====
  const hasPresencialConPlantel = (s.slots.modalidad==='presencial' && !!s.slots.plantel);
  if(hasPresencialConPlantel && /oferta|programa|carrera/i.test(ntext)){
    await sendWhatsAppText(fromWa, 'Te comparto la oferta académica…');
    await pauseAndNotify(fromWa, 'Un asesor te la comparte a detalle.');
    touchIntent(fromWa); return res.sendStatus(200);
  }
  if(s.slots.modalidad==='online' && /oferta|programa|carrera/i.test(ntext)){
    if(!s.slots.promedio){ await sendWhatsAppText(fromWa,'¿Cuál es tu promedio de preparatoria? (ej. 8.5)'); touchIntent(fromWa); return res.sendStatus(200); }
    await sendWhatsAppText(fromWa, 'Te comparto la oferta académica Online…');
    await pauseAndNotify(fromWa, 'Un asesor te la comparte a detalle.');
    touchIntent(fromWa); return res.sendStatus(200);
  }

  // ===== Fallback con menú (evitar ruido) =====
  if(!isNoise(text)){
    await sendWhatsAppText(fromWa, menuListText());
  }
  return res.sendStatus(200);
});

// ====== ROOT / HEALTH ======
app.get('/healthz', (_req,res)=> res.status(200).json({ ok:true, uptime:process.uptime() }));
app.get('/', (_req,res)=> res.send('Webhook UNIDEP listo ✅'));

app.listen(PORT, ()=> console.log(`🚀 Webhook escuchando en :${PORT}`));