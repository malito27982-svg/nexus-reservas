// ============================================================
//  Robo de Reserva do Botequim — recebedor de webhook da Evolution API
//  v1: recebe a mensagem, responde uma saudacao de reservas (com delay humano),
//      le grupos SEM responder. A logica completa (checar disponibilidade,
//      agendar, passar pra humano) entra na v2.
// ============================================================

import express from 'express'

const app = express()
app.use(express.json({ limit: '5mb' }))

// --- config (vem das variaveis de ambiente na Railway) ---
const EVOLUTION_URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '') // ex: https://evolution-api-production-f285.up.railway.app
const APIKEY        = process.env.EVOLUTION_APIKEY || ''                    // token da instancia (ou global)
const INSTANCE      = process.env.INSTANCE || 'botequim-reservas'
const PORT          = process.env.PORT || 3000

const DELAY_MIN = 3000, DELAY_MAX = 8000
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a

const SAUDACAO =
  'Ola! 👋 Aqui e o atendimento de *reservas do Botequim Sao Paulo*.\n' +
  'Posso te ajudar a reservar uma mesa. Me diga, por favor: seu *nome*, para *quantas pessoas*, o *dia* e o *horario*.\n' +
  '(Se preferir falar com um atendente, e so pedir.)'

function extrairTexto(m = {}) {
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  )
}

async function enviarTexto(numero, texto, delay) {
  const r = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: APIKEY },
    body: JSON.stringify({ number: numero, text: texto, delay }),
  })
  const body = await r.text()
  if (!r.ok) console.error('  ⚠️ erro ao enviar:', r.status, body)
  return r.ok
}

app.get('/', (_req, res) => res.json({ ok: true, robo: 'botequim-reservas', instancia: INSTANCE }))

app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // responde rapido pra Evolution nao repetir o envio
  try {
    const body = req.body || {}
    const event = String(body.event || '').toLowerCase().replace(/_/g, '.')
    if (event !== 'messages.upsert') return

    const data = body.data || {}
    const key = data.key || {}
    const jid = key.remoteJid || ''

    if (key.fromMe) return                          // ignora o que o proprio numero envia
    if (jid === 'status@broadcast') return          // ignora status
    if (jid.endsWith('@g.us')) {                    // GRUPO: so le, nao responde
      console.log(`👥 grupo ${data.pushName || jid}: ${extrairTexto(data.message) || '[midia]'}`)
      return
    }

    const numero = jid.split('@')[0]
    const texto = extrairTexto(data.message)
    console.log(`💬 ${data.pushName || numero}: ${texto || '[midia]'}`)

    const delay = rand(DELAY_MIN, DELAY_MAX)
    await enviarTexto(numero, SAUDACAO, delay)       // delay = mostra "digitando..." nesse tempo
    console.log(`  ✅ respondido (delay ${Math.round(delay / 1000)}s)`)
  } catch (e) {
    console.error('erro no webhook:', e.message)
  }
})

app.listen(PORT, () => {
  console.log(`Robo de reserva ouvindo na porta ${PORT} | instancia ${INSTANCE} | evolution ${EVOLUTION_URL || '(sem URL!)'}`)
})
