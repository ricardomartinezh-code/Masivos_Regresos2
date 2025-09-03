// ====== Webhook WhatsApp UNIDEP (Icebreakers + Costos/Becas + Pagos + Emails) ======
import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ------ CONFIG ------
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'mi_verify_token_super_seguro';
const WABA_TOKEN      = process.env.WABA_TOKEN      || 'EAALJbUFKlZCIBPeSAqtTxH4Cqg4gq48iKvMOZBxTNsj4sJpabWDLGSYlhODZBk5p9p71W80VRoZBWKkjHVF5seEFQcbjq5kxdhDBv2ZC4eCYMEZBYtvgLZCtRPTFfUYp5HT6TTZBWLAYsJjoIickcBCaiClQpxdzSDtnuARHftuD7VKXwpwL6gmTnGVfEihv0ZA4B2BR0jgfq2scZD';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '759100873953981';
const APP_SECRET      = process.env.APP_SECRET      || '89bb6d2367a4ab0ad3e94021e7cb2046'; // opcional: '' para omitir firma

// Email (Gmail App Password)
const SMTP_USER   = process.env.SMTP_USER   || 'ricardomartinez19b@gmail.com';
const SMTP_PASS   = process.env.SMTP_PASS   || 'uwdlbouzhvkdshpt';
const SMTP_TO     = process.env.SMTP_TO     || 'ricardo.martinezh@unidep.edu.mx';
const SMTP_FROM   = process.env.SMTP_FROM   || 'UNIDEP Bot <ricardomartinez19b@gmail.com>';
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') === 'true';

// Costos/Becas (JSON exportado del Excel)
const COSTOS_JSON_PATH = process.env.COSTOS_JSON_PATH || path.join(__dirname, 'data', 'costos.json');
const PLANTEL_TIER_PATH = path.join(__dirname, 'data', 'plantel_tier.json');

// Imagen SPEI (link público de Drive → link directo)
const SPEI_IMAGE_URL = process.env.SPEI_IMAGE_URL
  || 'https://drive.google.com/uc?export=download&id=11J3Nha37yIUVHdZPwj38Ux-EUkdzlJfp';

// Texto SPEI
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

// Puerto
const PORT = process.env.PORT || 3000;

// ====== Horario Comercial (CDMX) ======
const BUSINESS_TZ         = 'America/Mexico_City';
const BUSINESS_START_HOUR = 15; // 15:00
const BUSINESS_END_HOUR   = 21; // 21:00

// ====== Fallback Control ======
const FALLBACK_COOLDOWN_MIN   = 240;  // 4h
const UNKNOWN_BEFORE_FALLBACK = 2;    // 2 intentos fallidos seguidos
const CONTEXT_TTL_MIN         = 1440; // 24h

// ====== Estado en memoria ======
const SESSION = new Map();
/*
SESSION.set(from, {
  lastIntentAt, lastFallbackAt, unknownCount,
  intent: null | 'costos' | 'beca' | 'pago' | 'pago_plantel' | 'inscrito' | 'regresar',
  slots: {
    nivel:null, modalidad:null, plantel:null, promedio:null, plan:null, // plan: 6/9/11/12/4
    paymentMethod:null,  // 'transferencia' | 'liga'
    citaDia:null, citaHorario:null
  }
})
*/

// ====== Prepa presencial: duración por plantel (2, 3 o '2|3') ======
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

// ====== Utilidades ======
const log = (...a) => console.log(...a);
function hourInTimeZone(tz = BUSINESS_TZ) {
  return Number(new Intl.DateTimeFormat('es-MX', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()));
}
function isBusinessHours() {
  const h = hourInTimeZone(BUSINESS_TZ);
  return h >= BUSINESS_START_HOUR && h < BUSINESS_END_HOUR;
}
function stripDiacritics(s=''){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
function normalizeText(s=''){return stripDiacritics(String(s)).toLowerCase().trim();}
function minutesDiff(a,b){return Math.abs((a.getTime()-b.getTime())/60000);}
function getSession(from){
  if(!SESSION.has(from)){
    SESSION.set(from, {
      lastIntentAt:null, lastFallbackAt:null, unknownCount:0,
      intent:null,
      slots:{ nivel:null, modalidad:null, plantel:null, promedio:null, plan:null, paymentMethod:null, citaDia:null, citaHorario:null }
    });
  }
  return SESSION.get(from);
}
function touchIntent(from){const s=getSession(from); s.lastIntentAt=new Date(); s.unknownCount=0;}
function markUnknown(from){const s=getSession(from); s.unknownCount+=1;}
function canSendFallback(from){
  const s=getSession(from); const now=new Date();
  if(s.lastIntentAt && minutesDiff(now,s.lastIntentAt)<=CONTEXT_TTL_MIN) return false;
  if(s.lastFallbackAt && minutesDiff(now,s.lastFallbackAt)<FALLBACK_COOLDOWN_MIN) return false;
  if(s.unknownCount < UNKNOWN_BEFORE_FALLBACK) return false;
  s.lastFallbackAt = now; s.unknownCount = 0; return true;
}
function isNoise(text=''){
  const t=normalizeText(text);
  if(!t) return true;
  if(t.length<=2) return true; // "?", "👍"
  const onlyPunct=/^[\p{P}\p{S}\s]+$/u;
  if(onlyPunct.test(text)) return true;
  const SALUDOS=['hola','buenas','buen dia','buenos dias','buenas tardes','buenas noches','hey','holi','que tal','saludos'];
  if(SALUDOS.includes(t)) return true;
  return false;
}
function optionsListText(){
  return [
    'Puedes elegir una opción:',
    '• Informes oferta Presencial',
    '• Quiero regresar a UNIDEP',
    '• Informes oferta Online',
    '• ¿Cómo pagar?',
    '• Ya estoy inscrito'
  ].join('\n');
}

// ====== Carga plantel → Tier (Lic y Salud) ======
function normalizeKey(s=''){
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]/g,'');
}

let PLANTEL_TIER = null;
try{
  if (fs.existsSync(PLANTEL_TIER_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PLANTEL_TIER_PATH,'utf8'));
    // Guardar como listas para luego convertir a Set normalizado
    PLANTEL_TIER = raw;
    log('📚 plantel_tier.json cargado');
  } else {
    log('⚠️ plantel_tier.json no encontrado en /data (usará null)');
  }
}catch(e){ log('⚠️ Error leyendo plantel_tier.json:', e.message); }

function tierFromPlantel(plantel){
  if(!plantel) return { licTier: null, saludTier: null };
  const k = normalizeKey(plantel);

  // construir sets normalizados cada llamada (barato y simple)
  const toSet = (arr)=> new Set((arr||[]).map(normalizeKey));

  let licTier = null, saludTier = null;
  if (PLANTEL_TIER) {
    const t1 = toSet(PLANTEL_TIER.T1), t2 = toSet(PLANTEL_TIER.T2), t3 = toSet(PLANTEL_TIER.T3);
    if (t1.has(k)) licTier = 'T1';
    else if (t2.has(k)) licTier = 'T2';
    else if (t3.has(k)) licTier = 'T3';

    const s1 = toSet(PLANTEL_TIER.SaludT1), s2 = toSet(PLANTEL_TIER.SaludT2), s3 = toSet(PLANTEL_TIER.SaludT3);
    if (s1.has(k)) saludTier = 'SaludT1';
    else if (s2.has(k)) saludTier = 'SaludT2';
    else if (s3.has(k)) saludTier = 'SaludT3';
  }
  return { licTier, saludTier };
}

// ====== WhatsApp Senders ======
async function sendWhatsAppText(to, body){
  const url=`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload={ messaging_product:'whatsapp', to, type:'text', text:{ body } };
  const res=await fetch(url,{ method:'POST', headers:{ Authorization:`Bearer ${WABA_TOKEN}`,'Content-Type':'application/json' }, body:JSON.stringify(payload) });
  const data=await res.json().catch(()=>({}));
  if(!res.ok) log('❌ Error enviando WA:', res.status, JSON.stringify(data));
  else log('📤 Enviado a',to,'| msgId=',data.messages?.[0]?.id||'n/a');
}
async function sendImageByLink(to, link, caption=''){
  const url=`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload={ messaging_product:'whatsapp', to, type:'image', image:{ link, caption } };
  const res=await fetch(url,{ method:'POST', headers:{ Authorization:`Bearer ${WABA_TOKEN}`,'Content-Type':'application/json' }, body:JSON.stringify(payload) });
  if(!res.ok){const t=await res.text().catch(()=> ''); log('❌ Error enviando imagen:', res.status, t);}
}

// ====== Media download (para adjuntar en correo) ======
async function getMediaUrl(mediaId){
  const url=`https://graph.facebook.com/v23.0/${mediaId}`;
  const res=await fetch(url,{ headers:{ Authorization:`Bearer ${WABA_TOKEN}` }});
  if(!res.ok){const t=await res.text().catch(()=> ''); throw new Error(`No pude obtener URL del media: ${res.status} ${t}`);}
  const json=await res.json(); return json.url;
}
async function downloadMedia(url){
  const res=await fetch(url,{ headers:{ Authorization:`Bearer ${WABA_TOKEN}` }});
  if(!res.ok){const t=await res.text().catch(()=> ''); throw new Error(`No pude descargar el media: ${res.status} ${t}`);}
  const buf=await res.arrayBuffer(); return Buffer.from(buf);
}

// ====== Email ======
const emailEnabled = SMTP_USER && SMTP_PASS && SMTP_TO && SMTP_FROM;
let transporter=null;
if(emailEnabled){
  transporter = nodemailer.createTransport({ host:SMTP_HOST, port:SMTP_PORT, secure:SMTP_SECURE, auth:{ user:SMTP_USER, pass:SMTP_PASS } });
  log('📧 Email: ENABLED');
}else{
  log('📪 Email: DISABLED (faltan SMTP_*)');
}
async function sendEmailComprobante({ fromWa, name, caption, filename, buffer, mimeType }){
  if(!emailEnabled) return;
  const subject=`Comprobante recibido - ${fromWa}${name?` (${name})`:''}`;
  const html=`
    <h2>Comprobante recibido</h2>
    <p><b>Número:</b> ${fromWa}</p>
    ${name ? `<p><b>Nombre:</b> ${name}</p>` : ''}
    ${caption ? `<p><b>Comentario:</b> ${caption}</p>` : ''}
    <p>Fecha: ${new Date().toLocaleString('es-MX',{ timeZone:'America/Mexico_City' })}</p>
  `;
  await transporter.sendMail({
    from:SMTP_FROM, to:SMTP_TO, subject, html,
    attachments:[{ filename:filename||'comprobante.jpg', content:buffer, contentType:mimeType||'image/jpeg' }]
  });
}
async function sendEmailCitaPlantel({ fromWa, name, plantel, dia, hora, raw }){
  if(!emailEnabled) return;
  const subject=`Cita para pago en plantel - ${fromWa}${name?` (${name})`:''}`;
  const html=`
    <h2>Cita solicitada para pago en plantel</h2>
    <p><b>Número:</b> ${fromWa}</p>
    ${name ? `<p><b>Nombre:</b> ${name}</p>` : ''}
    ${plantel ? `<p><b>Plantel:</b> ${plantel}</p>` : '<p><b>Plantel:</b> (no proporcionado)</p>'}
    ${dia ? `<p><b>Día:</b> ${dia}</p>` : '<p><b>Día:</b> (no proporcionado)</p>'}
    ${hora ? `<p><b>Hora:</b> ${hora}</p>` : '<p><b>Hora:</b> (no proporcionada)</p>'}
    <hr>
    <p><b>Texto del usuario:</b></p>
    <pre style="white-space:pre-wrap">${raw || '(sin texto)'}</pre>
    <p>Fecha registro: ${new Date().toLocaleString('es-MX',{ timeZone:'America/Mexico_City' })}</p>
  `;
  await transporter.sendMail({ from:SMTP_FROM, to:SMTP_TO, subject, html });
}

// ====== Extract incoming ======
function extractIncoming(body){
  try{
    const entry=body.entry?.[0];
    const change=entry?.changes?.[0];
    const value=change?.value;

    const status=value?.statuses?.[0];
    if(status) return { type:'status', status };

    const msg=value?.messages?.[0];
    if(!msg) return { type:'unknown' };

    const fromWa=msg.from;
    const name=value?.contacts?.[0]?.profile?.name || '';

    if(msg.type==='text'){
      return { type:'message', fromWa, name, text: msg.text?.body || '', meta:{} };
    }
    if(msg.type==='button'){
      const b=msg.button||{}; const text=b.text||b.payload||'';
      return { type:'message', fromWa, name, text, meta:{ kind:'button', payload:b.payload||null, text:b.text||null } };
    }
    if(msg.type==='interactive'){
      const br=msg.interactive?.button_reply; const lr=msg.interactive?.list_reply;
      if(br){ const text=br.title||br.id||''; return { type:'message', fromWa, name, text, meta:{ kind:'interactive_button', id:br.id||null, title:br.title||null } }; }
      if(lr){ const text=lr.title||lr.id||''; return { type:'message', fromWa, name, text, meta:{ kind:'interactive_list', id:lr.id||null, title:lr.title||null } }; }
    }
    if(msg.type==='image'){
      const image=msg.image||{}; return {
        type:'image', fromWa, name, caption:image.caption||'', mediaId:image.id, mimeType:image.mime_type||'image/jpeg'
      };
    }
    return { type:'unsupported', fromWa, name, raw:msg };
  }catch(e){
    log('❌ extractIncoming error:', e.message); return { type:'unknown' };
  }
}

// ====== Patrones ======
const EXACT_PRESENCIAL='Informes oferta Presencial';
const EXACT_REGRESAR  ='Quiero regresar a UNIDEP';
const EXACT_ONLINE    ='Informes oferta Online';

const RX_NEG=[ /\bno\s+estoy\s+interesad[oa]s?\b/i, /\bno\s+me\s+interesa(n)?\b/i, /\bno\b.*\binteresad[oa]s?\b/i,
  /\bgracias\b.*\b(no|ya no)\b/i, /\b(baja|alto|stop|cancelar|borrar|quitar|eliminar|desuscribir|unsubscribe|no gracias)\b/i,
  /\bno quiero\b/i, /\bno por ahora\b/i, /\botro dia\b/i, /\bmas adelante\b/i ];

const RX_POS=[ /\bsi\b/i, /\bsí\b/i, /\bclaro\b/i, /\bok(ey)?\b/i, /\bvale\b/i, /\bde acuerdo\b/i, /\bperfecto\b/i, /\bme parece\b/i,
  /\bestoy\s+interesad[oa]s?\b/i, /\bme\s+interesa(n)?\b/i, /\bquiero\b/i, /\bdeseo\b/i, /\badelante\b/i, /\bva\b/i ];

const RX_PRESENCIAL=[/informes?\s+oferta\s+presencial/i];
const RX_REGRESAR  =[/(quiero\s+)?regresar\s+a?\s*unidep/i];
const RX_ONLINE    =[/(informes?|oferta)\s+online/i];

const RX_COSTOS=[/\bcosto(s)?\b/i, /\bprecio(s)?\b/i, /\bcu(e|é)sta\b/i, /\binversi(ó|o)n\b/i];
const RX_BECA=[/\bbeca(s)?\b/i, /\bbecario\b/i];

const RX_PAGO_INTENT = [/\bc(o|ó)mo\s+pagar\b/i, /\bformas?\s+de\s+pago\b/i, /\bliga\s+de\s+pago\b/i, /\bpago\b/i];
const RX_PAGO_TRANSFERENCIA = [/transferencia(s)?\s*(bancaria)?/i, /\bSPEI\b/i];
const RX_PAGO_LIGA = [/\bliga\s+de\s+pago\b/i, /\blink\s+de\s+pago\b/i, /\bpagar?\s+con\s+tarjeta\b/i, /\bTPV\b/i];
const RX_PAGO_PLANTEL = [
  /\b(en|pagar?\s+en)\s+plantel(es)?\b/i,
  /\bpuedo\s+pagar?\s+en\s+plantel(es)?\b/i,
  /\bpago\s+en\s+plantel\b/i,
  /\bpagar?\s+en\s+caja\b/i,
  /\bcaja\b/i
];

function anyRx(list, text){ return list.some(rx=>rx.test(text)); }

// ====== Slots helpers ======
function inferSlotsFromText(slots, text){
  const t = normalizeText(text);
  if(/presencial/.test(t)) slots.modalidad='presencial';
  if(/online|en linea|en línea|virtual/.test(t)) slots.modalidad='online';

  if(/salud/.test(t)) slots.nivel='salud';
  if(/licenciatura|licenciatur(a|as)/.test(t)) slots.nivel='licenciatura';
  if(/maestri(a|ía)/.test(t)) slots.nivel='maestria';
  if(/prepa(ratoria)?|bachillerato/.test(t)) slots.nivel='preparatoria';

  // Psicología se trata como Salud (presencial), pero con plan comunicado 9
  if (/psicolog/i.test(t)) {
    slots.nivel = 'salud';
    slots.modalidad = slots.modalidad || 'presencial';
    if (!slots.plan) slots.plan = 9; // comunicado
  }

  if(/\b11\b.*cuatr/.test(t)) slots.plan=11;
  if(/\b9\b.*cuatr/.test(t))  slots.plan=9;
  if(/\b12\b.*cuatr/.test(t)) slots.plan=12;
  if(/\b6\b.*cuatr/.test(t))  slots.plan=6;

  if(/\b2\s*a(ño|nios|ños)\b/.test(t)) slots.plan=6;
  if(/\b3\s*a(ño|nios|ños)\b/.test(t)) slots.plan=9;

  const PLANTELES = new Set([
    ...Object.keys(PREPA_PRESENCIAL_DURACION),
    "Agua Prieta","Aguascalientes","Altamira","Cananea","Cd. del Carmen","Cd. Mante","Ca. Mante",
    "Cd. Obregón","Teocaltiche","Veracruz","Chihuahua","Culiacán","Ensenada","Los Cabos","Mexicali",
    "Nogales","Puerto Peñasco","Querétaro","Saltillo","Torreón","Zacatecas","Hermosillo","La Paz","Tijuana"
  ]);
  for(const p of PLANTELES){ if(t.includes(normalizeText(p))) { slots.plantel=p; break; } }

  const m=t.match(/\b(\d{1,2}(?:\.\d)?)\b/);
  if(m){ const val=Number(m[1]); if(val>=6 && val<=10) slots.promedio=val; }
}

function missingSlotsForCostFlow(slots){
  const out=[];
  if(!slots.nivel) out.push('nivel');
  if(!slots.modalidad) out.push('modalidad');

  if(slots.nivel==='preparatoria' && slots.modalidad==='presencial'){
    if(!slots.plantel) out.push('plantel');
    else {
      const d = PREPA_PRESENCIAL_DURACION[slots.plantel];
      if(d==='2') slots.plan = 6;
      else if(d==='3') slots.plan = 9;
      else if(d==='2|3' && !slots.plan) out.push('plan'); // 6 u 9
    }
  }

  if(slots.nivel==='licenciatura' && !slots.plan) out.push('plan');

  // Salud: si no es Psicología (que ya fijamos 9), por defecto 12
  if(slots.nivel==='salud'){
    slots.plan = slots.plan || 12;
  }

  if(slots.modalidad==='presencial' && slots.nivel!=='preparatoria' && !slots.plantel) out.push('plantel');
  if(!slots.promedio) out.push('promedio');
  return out;
}

// ====== Costos/Becas (JSON) ======
function loadCostosData(){
  try{
    const raw = fs.readFileSync(COSTOS_JSON_PATH,'utf8');
    const data = JSON.parse(raw);
    if(!Array.isArray(data)) throw new Error('costos.json debe ser un arreglo');
    return data;
  }catch(e){
    log('⚠️ No se pudo leer costos.json:', e.message);
    return null;
  }
}
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
      'Sube ./data/costos.json (exportado del Excel “Costos 2025”).',
      'Fila tipo: { nivel, modalidad, plan, tier?, rango:{min,max}, porcentaje, monto }',
      `Detecté → Nivel: ${nivel||'¿?'}, Modalidad: ${modalidad||'¿?'}, Plan: ${plan||'¿?'}, ` +
      `${modalidad==='presencial' ? `Plantel: ${plantel||'¿? '}` : ''}Promedio: ${promedio||'¿?'}`
    ].join('\n');
  }

  // Psicología = Salud: cotiza con plan 12, comunica 9
  const planForPricing = (nivel === 'salud' && Number(plan) === 9) ? 12 : Number(plan);

  // TIER por plantel
  let tier = null;
  if (modalidad === 'presencial') {
    const { licTier, saludTier } = tierFromPlantel(plantel);
    if (nivel === 'salud') tier = saludTier || 'Salud';
    else if (nivel === 'licenciatura') tier = licTier;
  }

  const base = data.filter(row =>
    normalizeText(row.nivel) === normalizeText(nivel) &&
    normalizeText(row.modalidad) === normalizeText(modalidad) &&
    Number(row.plan) === Number(planForPricing) &&
    (tier ? normalizeText(row.tier||'') === normalizeText(tier) : true)
  );

  if(base.length === 0){
    if (nivel==='salud' && Number(plan)===9) {
      return `No encontré tabla de Salud (plan 12) para cotizar Psicología. Revisa costos.json (Salud 12).`;
    }
    return `No encontré tabla para nivel=${nivel}, modalidad=${modalidad}, plan=${plan}${modalidad==='presencial' ? `, plantel=${plantel}`:''}.`;
  }

  let candidates = base.filter(r => rangoMatch(r.rango, promedio));
  if(candidates.length===0){
    const sorted = base.slice().sort((a,b)=>(a.rango?.min||0)-(b.rango?.min||0));
    if(sorted.length) candidates = [sorted[0]];
  }

  const chosen = candidates.sort((a,b)=> (Math.abs((a.rango?.min||0)-promedio)) - (Math.abs((b.rango?.min||0)-promedio)) )[0];
  if(!chosen) return 'No pude determinar la mensualidad. Revisa costos.json';

  const beca = typeof chosen.porcentaje==='number' ? chosen.porcentaje : null;
  const monto = typeof chosen.monto==='number' ? chosen.monto : null;

  const becaText = (typeof promedio==='number' && promedio >= 6 && promedio < 7) ? 'sin beca'
                   : (typeof beca==='number' ? `beca ${beca}%` : 'según promedio');

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
    const dur   = (Number(plan)===9) ? '9 cuatrimestres' : '12 cuatrimestres'; // comunicar 9 para Psicología
    return `Con tu promedio de ${promedio}, en ${where} (Salud) la colegiatura mensual queda en $${monto ?? '—'} (${becaText}, ${dur}).`;
  }
  const plano = plan ? `${plan} cuatrimestres` : 'plan';
  const where = modalidad==='online' ? 'Online' : `en ${plantel}`;
  return `Con tu promedio de ${promedio}, ${where} la colegiatura mensual queda en $${monto ?? '—'} (${becaText}, ${plano}).`;
}

// ====== VERIFY (GET) ======
app.get('/webhook', (req,res)=>{
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== WEBHOOK (POST) ======
app.post('/webhook', express.raw({ type:'application/json' }), async (req,res)=>{
  if(APP_SECRET){
    try{
      const signature = req.get('x-hub-signature-256') || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
      if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return res.sendStatus(401);
    }catch{ return res.sendStatus(401); }
  }

  let json; try{ json=JSON.parse(req.body.toString('utf8')); }catch{ return res.sendStatus(400); }
  const incoming=extractIncoming(json);

  if(incoming.type==='status') return res.sendStatus(200);

  // IMAGEN ENTRANTE → correo con adjunto (SIN responder en WA)
  if(incoming.type==='image'){
    const { fromWa, name, caption, mediaId, mimeType }=incoming;
    try{
      const mediaUrl=await getMediaUrl(mediaId);
      const buf=await downloadMedia(mediaUrl);
      await sendEmailComprobante({ fromWa, name, caption, filename:`comprobante_${fromWa}.jpg`, buffer:buf, mimeType });
    }catch(e){ log('❌ imagen/email error:', e.message); }
    return res.sendStatus(200);
  }

  if(incoming.type==='message'){
    if(!isBusinessHours()) return res.sendStatus(200);

    const { fromWa, name, text }=incoming;
    const ntext=normalizeText(text);
    const s=getSession(fromWa);
    inferSlotsFromText(s.slots, text);

    // 1) Icebreakers exactos o equivalentes
    if(ntext===normalizeText('Informes oferta Presencial') || /informes?\s+oferta\s+presencial/i.test(ntext)){
      await sendWhatsAppText(fromWa,"Excelente, ¿en qué plantel y qué programa estás interesado?");
      s.intent=null; touchIntent(fromWa); return res.sendStatus(200);
    }
    if(ntext===normalizeText('Quiero regresar a UNIDEP') || /(quiero\s+)?regresar\s+a?\s*unidep/i.test(ntext)){
      await sendWhatsAppText(fromWa,"Déjame verificar tu estado académico para ver si podemos otorgarte una beca y cómo quedarían los costos. ¿Me compartes tu nombre completo o matrícula?");
      s.intent='regresar'; touchIntent(fromWa); return res.sendStatus(200);
    }
    if(ntext===normalizeText('Informes oferta Online') || /(informes?|oferta)\s+online/i.test(ntext)){
      await sendWhatsAppText(fromWa,"Excelente, ¿en qué carrera estás interesado, o gustas que te comparta nuestra oferta Online?");
      s.intent=null; touchIntent(fromWa); return res.sendStatus(200);
    }

    // 2) Negativo / Positivo
    if(RX_NEG.some(rx=>rx.test(ntext))){
      await sendWhatsAppText(fromWa,"Perfecto, borramos tu registro. Gracias por tu tiempo");
      s.intent=null; touchIntent(fromWa); return res.sendStatus(200);
    }
    if(RX_POS.some(rx=>rx.test(ntext))){
      await sendWhatsAppText(fromWa,"Buen día. Perfecto, dame unos momentos más para apoyarte.");
      s.intent=null; touchIntent(fromWa); return res.sendStatus(200);
    }

    // 3) Pago (incluye en plantel / transferencia / liga)
    if(RX_PAGO_INTENT.some(rx=>rx.test(ntext)) || s.intent==='pago' || s.intent==='pago_plantel'){
      // En plantel
      if(RX_PAGO_PLANTEL.some(rx=>rx.test(ntext))){
        s.intent='pago_plantel'; touchIntent(fromWa);
        if(!s.slots.plantel){
          await sendWhatsAppText(fromWa,"¿En qué plantel te gustaría realizar el pago?");
          return res.sendStatus(200);
        }
        await sendWhatsAppText(fromWa,"Okay, ¿qué día y en qué horario podrías acudir para agendar tu cita?");
        return res.sendStatus(200);
      }

      // Si ya estamos en pago_plantel: capturar día/hora y mandar correo
      if(s.intent==='pago_plantel'){
        if(!s.slots.plantel){
          await sendWhatsAppText(fromWa,"¿En qué plantel te gustaría realizar el pago?");
          return res.sendStatus(200);
        }
        const { dia, hora } = parseDiaHora(text);
        s.slots.citaDia = s.slots.citaDia || dia;
        s.slots.citaHorario = s.slots.citaHorario || hora;

        try{
          await sendEmailCitaPlantel({
            fromWa, name, plantel: s.slots.plantel,
            dia: s.slots.citaDia, hora: s.slots.citaHorario, raw: text
          });
        }catch(e){ log('❌ email cita plantel error:', e.message); }

        await sendWhatsAppText(fromWa,"Listo, te agendo. Si necesito algo más te escribo por aquí.");
        s.intent=null; touchIntent(fromWa);
        return res.sendStatus(200);
      }

      // Flujo pago general (transferencia vs liga)
      s.intent='pago'; touchIntent(fromWa);
      if(!s.slots.paymentMethod){
        if(RX_PAGO_TRANSFERENCIA.some(rx=>rx.test(ntext))) s.slots.paymentMethod='transferencia';
        else if(RX_PAGO_LIGA.some(rx=>rx.test(ntext))) s.slots.paymentMethod='liga';
        else {
          await sendWhatsAppText(fromWa,"¿Quieres pagar por transferencia bancaria o por liga de pago?");
          return res.sendStatus(200);
        }
      }
      if(s.slots.paymentMethod==='transferencia'){
        await sendWhatsAppText(fromWa,"Vale, te comparto el cómo pagar vía transferencia.");
        await sendImageByLink(fromWa, SPEI_IMAGE_URL);
        await sendWhatsAppText(fromWa, SPEI_TEXT);
        s.intent=null; touchIntent(fromWa);
        return res.sendStatus(200);
      }
      if(s.slots.paymentMethod==='liga'){
        await sendWhatsAppText(fromWa,"Perfecto, dame un momento y te genero tu liga de pago");
        s.intent=null; touchIntent(fromWa);
        return res.sendStatus(200);
      }
    }

    // 4) Ya estoy inscrito
    if(/\bya\s+est(oy|a)\s+inscrit[oa]\b/i.test(ntext) || /\bestoy\s+inscrit[oa]\b/i.test(ntext)){
      s.intent='inscrito'; touchIntent(fromWa);
      await sendWhatsAppText(fromWa,"¿Cómo puedo ayudarte?");
      return res.sendStatus(200);
    }

    // 5) Costos/Beca → slot-filling
    if(RX_COSTOS.some(rx=>rx.test(ntext)) || RX_BECA.some(rx=>rx.test(ntext)) || s.intent==='costos' || s.intent==='beca'){
      if(s.intent!=='costos' && s.intent!=='beca'){
        s.intent = RX_BECA.some(rx=>rx.test(ntext)) ? 'beca' : 'costos';
      }
      touchIntent(fromWa);

      const missing = missingSlotsForCostFlow(s.slots);
      if(missing.length){
        if(missing.includes('nivel')){
          await sendWhatsAppText(fromWa,"¿Para qué nivel te interesa? (Salud / Licenciatura / Maestría / Preparatoria)");
          return res.sendStatus(200);
        }
        if(missing.includes('modalidad')){
          await sendWhatsAppText(fromWa,"¿La modalidad sería Presencial u Online?");
          return res.sendStatus(200);
        }
        if(missing.includes('plantel')){
          await sendWhatsAppText(fromWa,"¿En qué plantel te interesa cursar?");
          return res.sendStatus(200);
        }
        if(missing.includes('plan')){
          const hint = (s.slots.nivel==='preparatoria') ? '¿2 años (6 cuatrimestres) o 3 años (9 cuatrimestres)?'
                    : (s.slots.nivel==='licenciatura') ? '¿Plan de 9 o 11 cuatrimestres?'
                    : (s.slots.nivel==='salud' ? 'Para Salud, ¿Psicología (9 cuatris) u otra área (12 cuatris)?' : '¿Cuál es el plan?');
          await sendWhatsAppText(fromWa, hint);
          return res.sendStatus(200);
        }
        if(missing.includes('promedio')){
          const hint = s.slots.nivel==='maestria' ? 'promedio de licenciatura'
                     : s.slots.nivel==='preparatoria' ? 'promedio de secundaria'
                     : 'promedio de preparatoria';
          await sendWhatsAppText(fromWa,`¿Cuál es tu ${hint}? (ej. 8.5)`);
          return res.sendStatus(200);
        }
      } else {
        const quote = await quoteCosts(s.slots);
        await sendWhatsAppText(fromWa, quote);
        s.intent=null; touchIntent(fromWa);
        return res.sendStatus(200);
      }
    }

    // 6) Desconocido → ignora ruido; luego fallback
    if(isNoise(text)) return res.sendStatus(200);

    markUnknown(fromWa);
    if(canSendFallback(fromWa)){
      await sendWhatsAppText(fromWa, optionsListText());
    }
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

// ====== Parsers de día/hora (cita en plantel) ======
function parseDiaHora(text=''){
  const t = text;
  const m1 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/); // dd/mm o dd-mm
  const m2 = t.match(/\b(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\b/); // "dd de mes"
  const m3 = t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i); // día semana
  const h1 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/); // 24h
  const h2 = t.match(/\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b/i); // 12h

  const dia = m1 ? `${m1[1]}/${m1[2]}` : m2 ? `${m2[1]} de ${m2[2]}` : m3 ? m3[0] : null;
  const hora = h1 ? `${h1[1]}:${h1[2]}` : h2 ? `${h2[1]}:${h2[2]||'00'} ${h2[3].toUpperCase()}` : null;
  return { dia, hora };
}

// ------ Health & root ------
app.get('/healthz', (_req,res)=>res.status(200).json({ ok:true, uptime:process.uptime() }));
app.get('/', (_req,res)=>res.send('Webhook UNIDEP listo ✅'));

app.listen(PORT, ()=>{ log(`🚀 Webhook escuchando en :${PORT}`); if(!emailEnabled) log('📪 Email desactivado'); });