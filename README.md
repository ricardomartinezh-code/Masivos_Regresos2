# UNIDEP WhatsApp Webhook

Bot de atención con pausa/reanudación, cálculo de beca, pagos e integración de correo para comprobantes.

## Variables de entorno
- `VERIFY_TOKEN` (Meta Webhooks)
- `WABA_TOKEN` (WhatsApp Cloud API token)
- `PHONE_NUMBER_ID` (ID de tu número en WABA)
- `APP_SECRET` (App secret; si vacío, no valida firma)
- **Email opcional**
  - `SMTP_USER`, `SMTP_PASS` (Gmail + App Password)
  - `SMTP_FROM`, `SMTP_TO`
- **Opcional**
  - `SPEI_IMAGE_URL` (si cambias la imagen)

## Despliegue (Render)
- Build: `npm install`
- Start: `npm start`
- Runtime Node 18+ (para `fetch` global)

## Webhook URL
- Configura en developers.facebook.com → WhatsApp → Webhooks
- Callback: `https://TU-RENDER/webhook`
- Verify token: el mismo `VERIFY_TOKEN`

## Flujos clave

### Pausa / Reanudar
- El bot se **pausa** automáticamente en:
  - “ok, pero… / es que… / y si… / pero yo… / y cómo…”
  - Regresos / Maestrías
  - Oferta académica (presencial con plantel u online con promedio)
  - Pagos (tras dar instrucciones)
  - Cierre de cotización (“¿qué te parece?”)
  - “Ya no quiero más información”
- Para **reanudar**:
  - Usuario escribe “**continuo en espera**”
  - Usuario escribe “**deseo conocer mi beca**” (reanuda y cotiza)
  - Usuario pregunta “**cuándo inician las clases**” → “15 de septiembre”

### Menú (fallback o a demanda)
- Se ofrece un menú fijo **1–6**:
  1) Hablar con un asesor  
  2) Calcular mi beca  
  3) Maestrías  
  4) Quiero pagar  
  5) Ya estoy inscrito  
  6) Ya no quiero más información

### Costos / Beca
- Slot-filling mínimo:
  - **Nivel** (Salud / Licenciatura / Maestría / Preparatoria)
  - **Modalidad** (Presencial / Online)
  - **Plantel** (si Presencial)
  - **Plan** (Lic 9/11; Prepa 6/9; Salud: cotiza 12; Psicología = Salud, comunicar 9)
  - **Promedio** (reglas de beca en `costos.json`)
- Cotiza desde `data/costos.json` con Tiers (`plantel_tier.json`).
- Al terminar: envía cotización + “¿Qué te parece?” y **pausa**.

### Pagos
- “¿transferencia o liga?”
  - **transferencia:** envía imagen + texto SPEI y **pausa**
  - **liga:** responde “genero tu liga” y **pausa**
  - **en plantel:** pide día/hora, **envía correo** con datos, confirma por WA y **pausa**
- **Comprobantes**: si usuario **manda imagen**, se envía por correo (sin responder en WA).

## Notas de datos
- `costos.json`: generado con `tools/convert_costos.py` desde tu Excel.
- `plantel_tier.json`: según mapeo que compartiste (T1/T2/T3 y SaludT1/T2/T3).
- Psicología se **cotiza** como Salud (12), pero **se comunica** 9 cuatrimestres.

## Pruebas rápidas
- Enviar: “calcular mi beca” → pide promedio, modalidad y (si presencial) plantel → cotiza → pausa.
- Enviar: “quiero pagar” → elige transferencia/liga/plantel → acciona y pausa.
- Enviar: “ok, pero…” → pausa inmediata.
- Enviar: “continuo en espera” → reanuda y muestra menú.
- Enviar una **imagen** → llega correo de comprobante.