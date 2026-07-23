// ============================================================
//  Robo do Botequim — Evolution API (QR) + Claude + Supabase
//  Porte COMPLETO do wpp/index.ts (Meta -> Evolution):
//  reservas + delivery + flyer (Gemini) + menu (texto) + handoff.
// ============================================================

import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { AsyncLocalStorage } from 'node:async_hooks'

const app = express()
app.use(express.json({ limit: '15mb' }))

// --- env ---
const EVOLUTION_URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '')
const APIKEY   = process.env.EVOLUTION_APIKEY || ''
const MASTER_KEY = process.env.EVOLUTION_MASTER_KEY || APIKEY // chave global da Evolution (criar/listar instâncias)
const INSTANCE = process.env.INSTANCE || 'botequim-reservas'
const PORT     = process.env.PORT || 3000
const SB_URL   = process.env.SUPABASE_URL || ''
const SB_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''
const GEMINI_KEY = process.env.GEMINI_FLYER_KEY || process.env.GEMINI_API_KEY || ''
const CASA_SLUG = process.env.CASA_SLUG || ''
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const ROBOT_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://evolution-robot-production.up.railway.app'
// base dos links públicos (confirmar.html, bar-fundo.jpg) — trocar p/ https://reservas.plionai.com.br quando o DNS estiver no ar
const LINK_BASE = (process.env.LINK_BASE || 'https://reservas.plionai.com.br').replace(/\/$/, '')

// contexto da instância da mensagem atual (1 WhatsApp por unidade)
const als = new AsyncLocalStorage()
const curInst = () => als.getStore()?.inst || INSTANCE

const DELAY_MIN = 3000, DELAY_MAX = 6000
const PRE_MIN = 4000, PRE_MAX = 11000
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

// ===================== ENVIO (Evolution) =====================
async function evoPost(path, payload) {
  try {
    const r = await fetch(`${EVOLUTION_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: MASTER_KEY },
      body: JSON.stringify(payload),
    })
    if (!r.ok) console.error(`  ⚠️ ${path} ${r.status}`, (await r.text()).slice(0, 200))
    return r.ok ? await r.json().catch(() => ({})) : null
  } catch (e) { console.error(`  ⚠️ ${path} exc`, e.message); return null }
}
async function sendText(numero, texto) {
  return evoPost(`/message/sendText/${curInst()}`, { number: numero, text: texto, delay: rand(1500, 3500) })
}
async function enviarImagemLink(numero, url, caption) {
  return evoPost(`/message/sendMedia/${curInst()}`, { number: numero, mediatype: 'image', media: url, caption: caption || '' })
}
async function enviarImagemB64(numero, b64, caption) {
  return evoPost(`/message/sendMedia/${curInst()}`, { number: numero, mediatype: 'image', mimetype: 'image/png', media: b64, caption: caption || '', fileName: 'flyer.png' })
}
async function enviarDocumento(numero, url, filename, caption) {
  return evoPost(`/message/sendMedia/${curInst()}`, { number: numero, mediatype: 'document', media: url, fileName: filename, caption: caption || '' })
}
// baixa base64 de uma midia recebida (selfie do flyer)
async function baixarMidiaB64(dataMsg) {
  try {
    const r = await evoPost(`/chat/getBase64FromMediaMessage/${curInst()}`, { message: { key: dataMsg.key, message: dataMsg.message }, convertToMp4: false })
    if (r?.base64) return { b64: r.base64, mime: r.mimetype || 'image/jpeg' }
  } catch (e) { console.error('baixarMidia', e.message) }
  return null
}

// ===================== CASA / CONVERSA =====================
const CASA_COLS = 'id,nome,slug,nome_curto,aviso_reserva'
// 1 WhatsApp por unidade (spec Lucas 20/07): CASA_MAP = {"nome-da-instancia":"slug-da-casa"}
// A instância que chega no webhook decide a casa; CASA_SLUG segue como fallback.
const CASA_MAP = (() => { try { return JSON.parse(process.env.CASA_MAP || '{}') } catch { return {} } })()
// mapa inverso: slug da casa -> nome da instância; casa sem mapeamento usa o próprio slug como instância
const INST_BY_SLUG = Object.fromEntries(Object.entries(CASA_MAP).map(([i, s]) => [s, i]))
const instDaCasa = (slug) => INST_BY_SLUG[slug] || slug
const _casas = {}
async function getCasa(slug) {
  const efetivo = slug || CASA_SLUG
  const k = efetivo || '_default'
  if (_casas[k]) return _casas[k]
  let q = sb.from('casas').select(CASA_COLS)
  q = efetivo ? q.eq('slug', efetivo) : q.eq('ativo', true)
  _casas[k] = (await q.limit(1).maybeSingle()).data
  return _casas[k]
}
async function getConversa(casa_id, telefone) {
  const ex = (await sb.from('conversas').select('*').eq('casa_id', casa_id).eq('telefone', telefone).maybeSingle()).data
  if (ex) return ex
  return (await sb.from('conversas').insert({ casa_id, telefone }).select('*').single()).data ?? { historico: [], handoff: false }
}
async function upConversa(casa_id, telefone, patch) {
  await sb.from('conversas').update({ ...patch, updated_at: new Date().toISOString() }).eq('casa_id', casa_id).eq('telefone', telefone)
}
async function gravaNome(casa_id, telefone, nome) {
  if (nome && nome.trim()) await sb.from('conversas').update({ nome }).eq('casa_id', casa_id).eq('telefone', telefone).is('nome', null)
}
async function avisarGerente(casa, from, motivo) {
  const c = (await sb.from('casas').select('gerente_whatsapp,nome,nome_curto').eq('id', casa.id).maybeSingle()).data
  if (!c?.gerente_whatsapp) return
  const cli = (await sb.from('conversas').select('nome').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
  await sendText(c.gerente_whatsapp, `🔔 *${c.nome_curto ?? c.nome}* — ${cli?.nome ? cli.nome + ' (' + from + ')' : from} ${motivo}.\nAbra o painel em *Conversas* e clique em *Assumir atendimento*.`)
}

// ===================== MENU (texto) =====================
// Delivery DESATIVADO no menu em 19/07/2026 (go-live começa só com reservas; religar = voltar a opção + o intent)
const MENU_TXT = (nome) => `Olá! 👋 Seja bem-vindo(a) ao *${nome}*. Como posso te ajudar? Responda com o *número*:\n\n1️⃣ Reservas\n2️⃣ Cardápio\n3️⃣ Dúvidas (horários, endereço, eventos...)\n4️⃣ Reclamações\n5️⃣ Minhas reservas\n6️⃣ Falar com atendente`
function intentDoTexto(t) {
  const s = t.trim().toLowerCase()
  if (/^1\b|reserva/.test(s)) return 'reservas'
  if (/^2\b|card[aá]pio|menu do bar/.test(s)) return 'cardapio'
  if (/deliver/.test(s)) return 'delivery_off'
  if (/^3\b|d[uú]vida/.test(s)) return 'duvidas'
  if (/^4\b|reclama/.test(s)) return 'reclamacoes'
  if (/^5\b|minhas reserva/.test(s)) return 'minhas'
  if (/^6\b|atendente|humano|gerente/.test(s)) return 'atendente'
  return null
}

// ===================== TOOLS RESERVA =====================
function toMin(t) { const [h, m] = (t || '00:00').slice(0, 5).split(':').map(Number); return h * 60 + m }
function gerarHorarios(giros) {
  const out = []
  for (const g of giros) {
    const ini = toMin(g.horario_min), fim = toMin(g.fechamento_antecipado ?? g.horario_max), step = g.intervalo_min || 30
    for (let m = ini; m <= fim; m += step) out.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'))
  }
  return out
}
async function consultarDisponibilidade(casa, input) {
  const { data, pessoas } = input
  const dow = new Date(data + 'T12:00:00Z').getUTCDay()
  const dia = (await sb.from('dias_reserva').select('status').eq('casa_id', casa.id).eq('data', data).maybeSingle()).data
  if (dia && dia.status !== 'aberto') return { aberto: false, motivo: `Dia ${dia.status}.` }
  const ambientes = (await sb.from('ambientes').select('id,nome,limite_pessoas,capacidade_min_reserva,capacidade_max_reserva,dias_semana').eq('casa_id', casa.id).eq('ativo', true).eq('reserva_online', true).order('ordem')).data ?? []
  const reservasDia = (await sb.from('reservas').select('ambiente_id,qtd_pessoas').eq('casa_id', casa.id).eq('data', data).in('status', ['pendente', 'confirmada', 'checkin', 'concluido'])).data ?? []
  const setores = ambientes
    .filter((a) => !a.dias_semana || a.dias_semana.length === 0 || a.dias_semana.includes(dow))
    .filter((a) => pessoas >= a.capacidade_min_reserva && pessoas <= (a.capacidade_max_reserva ?? a.limite_pessoas))
    .map((a) => { const ocup = reservasDia.filter((r) => r.ambiente_id === a.id).reduce((s, r) => s + (r.qtd_pessoas || 0), 0); return { setor: a.nome, vagas: Math.max(0, a.limite_pessoas - ocup) } })
    .filter((s) => s.vagas >= pessoas)
  const girosAll = (await sb.from('giros').select('horario_min,horario_max,intervalo_min,fechamento_antecipado,dias_semana,somente_ambiente').eq('casa_id', casa.id).eq('ativo', true)).data ?? []
  const giros = girosAll.filter((g) => !g.dias_semana || g.dias_semana.includes(dow))
  const girosLivres = giros.filter((g) => !g.somente_ambiente)
  const girosRestritos = giros.filter((g) => g.somente_ambiente)
  const expsAll = (await sb.from('experiencias').select('titulo,descricao,regras,data,dias_semana,hora_min,hora_max,altera_dia,menu_especial,menu_preco,divulgar,formato,preco_ingresso').eq('casa_id', casa.id).eq('ativo', true)).data ?? []
  const exp = expsAll.find((e) => (e.data && e.data === data) || (!e.data && Array.isArray(e.dias_semana) && e.dias_semana.includes(dow)))
  if (!giros.length && !(exp && exp.altera_dia)) return { aberto: false, motivo: 'Não há reservas neste dia da semana.' }
  let horarios = gerarHorarios(girosLivres)
  if (exp && exp.altera_dia && exp.hora_min) horarios = gerarHorarios([{ horario_min: exp.hora_min, horario_max: exp.hora_max ?? exp.hora_min, intervalo_min: 30 }])
  // giros restritos a um setor (ex.: SA sáb 16-17h só Praça Central; WL sáb 18-19h só Frente do bar)
  const horarios_por_setor = girosRestritos.length ? girosRestritos.map((g) => ({ setor: g.somente_ambiente, horarios: gerarHorarios([g]) })) : undefined
  const evento = (exp && exp.divulgar) ? { titulo: exp.titulo, descricao: exp.descricao, regras: exp.regras, menu_especial: exp.menu_especial, menu_preco: exp.menu_preco, formato: exp.formato, preco_ingresso: exp.preco_ingresso } : undefined
  // aviso configurável por casa (ex.: SA seg-sex almoço à la carte + buffet kg)
  const av = casa.aviso_reserva
  const aviso = (av && Array.isArray(av.dias) && av.dias.includes(dow)) ? { janela: `${av.de || ''}-${av.ate || ''}`, texto: av.texto } : undefined
  return { aberto: true, setores_disponiveis: setores, horarios, horarios_por_setor, evento, aviso }
}
async function criarReserva(casa, from, input) {
  const { nome, data, hora, pessoas, setor, cpf, email, nascimento } = input
  if (pessoas > 49) {
    await upConversa(casa.id, from, { handoff: true, handoff_aguardando: true })
    await sendText(from, `Que ótimo, um grupo grande! 🎉 Como é bastante gente, fazemos um *atendimento personalizado*. O responsável do *${casa.nome}* já vai falar com você por aqui. 🙌`)
    await avisarGerente(casa, from, `quer reservar para ${pessoas} pessoas (GRUPO GRANDE +49)`)
    return { ok: false, grupo_grande: true, mensagem: 'Handoff grupo grande. NÃO confirme.' }
  }
  // setor pode ter 2 linhas (capacidade por dia, ex. "Salao Central" semana/fds) — escolhe a linha do dia da reserva
  const dowR = new Date(data + 'T12:00:00Z').getUTCDay()
  let cands = (await sb.from('ambientes').select('id,nome,dias_semana').eq('casa_id', casa.id).eq('ativo', true).ilike('nome', setor)).data ?? []
  if (!cands.length) cands = (await sb.from('ambientes').select('id,nome,dias_semana').eq('casa_id', casa.id).eq('ativo', true).ilike('nome', `%${setor}%`)).data ?? []
  const amb = cands.find((a) => Array.isArray(a.dias_semana) && a.dias_semana.includes(dowR)) ?? cands.find((a) => !a.dias_semana || !a.dias_semana.length)
  if (!amb) return { ok: false, erro: `Setor "${setor}" não encontrado${cands.length ? ' para esse dia da semana' : ''}.` }
  const cpfLimpo = cpf ? String(cpf).replace(/\D/g, '') : null
  const up = await sb.from('clientes').upsert({ casa_id: casa.id, nome, telefone: from, cpf: cpfLimpo, email: email ?? null, data_nascimento: nascimento ?? null }, { onConflict: 'casa_id,telefone' }).select('id').single()
  const ins = await sb.from('reservas').insert({ casa_id: casa.id, cliente_id: up.data?.id ?? null, nome, telefone: from, cpf: cpfLimpo, email: email ?? null, data_nascimento: nascimento ?? null, data, hora: hora ?? null, ambiente_id: amb.id, qtd_pessoas: pessoas, confirmacoes_necessarias: pessoas, origem: 'whatsapp', status: 'confirmada', confirmada_em: new Date().toISOString() }).select('token').single()
  if (ins.error) return { ok: false, erro: ins.error.message }
  const token = ins.data?.token
  await upConversa(casa.id, from, { flyer_etapa: 'ocasiao', flyer_feedback: false, flyer_count: 0, flyer_ocasiao: null, flyer_ctx: { nome, data, hora: hora ?? '', setor: amb.nome, casa: casa.nome, token } })
  const followups = [
    `📋 *Link pra seus convidados confirmarem a presença:*\n${LINK_BASE}/confirmar.html?t=${token}\n\n⚠️ Os ${pessoas} precisam confirmar — se faltar gente, a reserva pode perder os lugares. (Menores de 16 confirmam só com o nome.)`,
    `🎨 E posso te montar um *flyer* dessa reserva! Qual a ocasião? (aniversário, happy hour, encontro...) — ou responda "não quero".`,
  ]
  return { ok: true, mensagem: `Reserva GRAVADA: ${nome}, ${pessoas} pessoas, ${data}${hora ? ' às ' + hora : ''}, no ${amb.nome}. Confirme ao cliente de forma simpática e BREVE em UMA mensagem. NÃO mande link nem fale de flyer — o sistema envia em seguida.`, reserva_token: token, _followups: followups }
}

// ===================== AGENTE RESERVA =====================
async function runAgent(casa, from, history) {
  const ambientes = (await sb.from('ambientes').select('nome,limite_pessoas,capacidade_min_reserva,capacidade_max_reserva').eq('casa_id', casa.id).eq('ativo', true).order('ordem')).data ?? []
  // cliente recorrente: não pedir os dados de novo (spec Giovanna 22/07)
  const cli = (await sb.from('clientes').select('nome,data_nascimento').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
    ?? (await sb.from('clientes').select('nome,data_nascimento').eq('telefone', from).limit(1).maybeSingle()).data
  const infos = (await sb.from('casa_infos').select('categoria,titulo,texto').eq('casa_id', casa.id).eq('status', 'aprovado')).data ?? []
  const infosTxt = infos.map((i) => `- ${i.titulo}${i.categoria && i.categoria !== 'Geral' ? ` (${i.categoria})` : ''}: ${i.texto}`).join('\n')
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' })
  const hojeISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const system = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`Você é o atendente de reservas do ${casa.nome}, no WhatsApp. Fale em português do Brasil CORDIAL, EDUCADO e PROFISSIONAL. EVITE gírias. Poucos emojis. Vá direto ajudando. Peça: nome, quantas pessoas, data e horário.
Hoje é ${hoje} (ISO: ${hojeISO}). Resolva datas relativas a partir de hoje. Escreva datas dd/mm ao cliente, nunca AAAA-MM-DD. Não repita perguntas já respondidas.
SETORES (min a max por reserva):
${ambientes.map((a) => `- ${a.nome}: ${a.capacidade_min_reserva} a ${a.capacidade_max_reserva ?? a.limite_pessoas}`).join('\n')}
HORÁRIOS variam por dia — NUNCA invente, use consultar_disponibilidade.
HORÁRIO FORA DA LISTA: se o cliente pedir um horário depois do último da lista, NÃO diga que "não está disponível" — explique que naquele dia pegamos reservas só até o ÚLTIMO horário da lista (diga qual é) e ofereça esse último horário.
Se vier "horarios_por_setor", esses horários extras valem SÓ para o setor indicado — deixe isso claro ao oferecer.
Se vier "aviso", transmita o texto ao cliente UMA vez quando a reserva/consulta cair na janela indicada.
EVENTOS: se vier "evento", avise com entusiasmo (título, descrição, menu/preço).
${infosTxt ? `\nINFORMAÇÕES DA CASA (responda dúvidas SÓ com isto, não invente):\n${infosTxt}\n` : ''}
${cli ? `CLIENTE JÁ CADASTRADO neste número: nome "${cli.nome}"${cli.data_nascimento ? `, nascimento ${cli.data_nascimento}` : ''}. NÃO peça esses dados de novo — pergunte só "A reserva é para ${cli.nome}?" e use-os no criar_reserva (peça apenas o que faltar).\n` : ''}REGRAS: precisa de nome, data, horário, pessoas, setor + DATA DE NASCIMENTO (obrigatória; dd/mm/aaaa, converta p/ AAAA-MM-DD ao criar). NÃO peça CPF nem e-mail (o telefone já vem do WhatsApp). Avise LGPD 1x. SEMPRE consultar_disponibilidade antes. A reserva SÓ existe após criar_reserva retornar ok:true — proibido dizer "confirmada" sem isso. +49 pessoas o sistema aciona o responsável. Se pedir atendente, o sistema transfere. Seja breve. Antes de criar, repita os dados começando com "Vou confirmar sua reserva:" (NUNCA diga "confirmar seu resumo") e, após o OK do cliente, chame criar_reserva.` }]
  const tools = [
    { name: 'consultar_disponibilidade', description: 'Verifica data aberta e setores que comportam as pessoas.', input_schema: { type: 'object', properties: { data: { type: 'string' }, pessoas: { type: 'integer' } }, required: ['data', 'pessoas'] } },
    { name: 'criar_reserva', description: 'Cria a reserva. Só quando o cliente confirmar.', input_schema: { type: 'object', properties: { nome: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, pessoas: { type: 'integer' }, setor: { type: 'string' }, nascimento: { type: 'string', description: 'data de nascimento AAAA-MM-DD (obrigatória)' } }, required: ['nome', 'data', 'pessoas', 'setor', 'nascimento'] } },
  ]
  return claudeLoop(system, tools, history, async (name, inp) => {
    if (name === 'consultar_disponibilidade') return consultarDisponibilidade(casa, inp)
    if (name === 'criar_reserva') return criarReserva(casa, from, inp)
    return { erro: 'desconhecida' }
  })
}

// ===================== AGENTE DELIVERY =====================
async function runDeliveryAgent(casa, from, history) {
  const cats = (await sb.from('delivery_produtos').select('categoria,nome,preco').eq('casa_id', casa.id).eq('ativo', true).order('ordem')).data ?? []
  const lista = cats.map((p) => `- ${p.nome} (R$ ${Number(p.preco).toFixed(2)})${p.categoria ? ' [' + p.categoria + ']' : ''}`).join('\n')
  const system = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`Você é o atendente de DELIVERY do ${casa.nome}, no WhatsApp. Cordial, breve, poucos emojis. Monte o pedido inteiro pela conversa.
FLUXO: 1) Peça o CEP; quando mandar, chame buscar_cep, confirme rua/bairro/cidade e peça número+complemento. 2) chame calcular_entrega com o endereço completo; informe a TAXA e o tempo. Se atende=false, peça desculpas. 3) Convide a escolher pelo cardápio (PDF) e avise que pode pedir FOTO de qualquer prato (foto_prato). 4) adicionar_item/remover_item; a cada mudança confirme com ver_carrinho (subtotal, desconto, total). 5) ao confirmar, pergunte pagamento (na entrega ou online) e nome, e chame finalizar_pedido.
CARDÁPIO (use exatamente estes nomes/preços):
${lista}
REGRAS: nunca invente itens/preços. Não confirme sem finalizar_pedido com ok:true.` }]
  const tools = [
    { name: 'buscar_cep', input_schema: { type: 'object', properties: { cep: { type: 'string' } }, required: ['cep'] }, description: 'Endereço pelo CEP.' },
    { name: 'calcular_entrega', input_schema: { type: 'object', properties: { endereco: { type: 'string' } }, required: ['endereco'] }, description: 'Taxa de entrega pelo endereço completo.' },
    { name: 'foto_prato', input_schema: { type: 'object', properties: { nome: { type: 'string' } }, required: ['nome'] }, description: 'Envia foto de um prato.' },
    { name: 'adicionar_item', input_schema: { type: 'object', properties: { nome: { type: 'string' }, qtd: { type: 'integer' } }, required: ['nome'] }, description: 'Adiciona item.' },
    { name: 'remover_item', input_schema: { type: 'object', properties: { nome: { type: 'string' } }, required: ['nome'] }, description: 'Remove item.' },
    { name: 'ver_carrinho', input_schema: { type: 'object', properties: {}, required: [] }, description: 'Mostra carrinho.' },
    { name: 'finalizar_pedido', input_schema: { type: 'object', properties: { nome: { type: 'string' }, pagamento: { type: 'string' } }, required: ['nome', 'pagamento'] }, description: 'Fecha o pedido.' },
  ]
  return claudeLoop(system, tools, history, async (name, inp) => {
    if (name === 'buscar_cep') return buscarCep(inp.cep)
    if (name === 'calcular_entrega') return calcularEntrega(casa, from, inp.endereco)
    if (name === 'foto_prato') return fotoPrato(casa, from, inp)
    if (name === 'adicionar_item') return adicionarItem(casa, from, inp)
    if (name === 'remover_item') return removerItem(casa, from, inp)
    if (name === 'ver_carrinho') return verCarrinho(casa, from)
    if (name === 'finalizar_pedido') return finalizarPedido(casa, from, inp)
    return { erro: 'desconhecida' }
  }, 6)
}

// loop generico Claude (retorna {text, followups})
async function claudeLoop(system, tools, history, exec, maxIter = 5) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }))
  const followups = []
  for (let i = 0; i < maxIter; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools, messages }),
    })
    const data = await res.json()
    if (data.type === 'error') { console.error('anthropic', JSON.stringify(data).slice(0, 300)); return { text: 'Tive um problema aqui, pode repetir? 🙏', followups } }
    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content })
      const results = []
      for (const b of data.content) {
        if (b.type !== 'tool_use') continue
        const out = await exec(b.name, b.input)
        if (out && Array.isArray(out._followups)) { followups.push(...out._followups); delete out._followups }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) })
      }
      messages.push({ role: 'user', content: results })
      continue
    }
    const txt = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    return { text: txt || 'Pode me dar mais detalhes? 🙂', followups }
  }
  return { text: 'Vamos continuar? Me diga os detalhes. 🙂', followups }
}

// ===================== DELIVERY: ferramentas =====================
async function geocode(endereco) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(endereco)}`, { headers: { 'User-Agent': 'NexusReservas/1.0' } })
    const j = await r.json(); if (Array.isArray(j) && j[0]) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) }
  } catch (_) {}
  return null
}
function distKm(a, b) { const R = 6371, toR = (x) => x * Math.PI / 180; const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) }
async function buscarCep(cep) {
  const c = String(cep || '').replace(/\D/g, ''); if (c.length !== 8) return { ok: false, erro: 'CEP precisa ter 8 dígitos.' }
  try { const d = await (await fetch(`https://viacep.com.br/ws/${c}/json/`)).json(); if (d?.erro) return { ok: false, erro: 'CEP não encontrado.' }; return { ok: true, cep: c, logradouro: d.logradouro, bairro: d.bairro, cidade: d.localidade, uf: d.uf } } catch (_) { return { ok: false, erro: 'Não consegui consultar o CEP.' } }
}
async function enviarPdfCardapio(casa, from) {
  const cc = (await sb.from('casas').select('cardapio_url').eq('id', casa.id).maybeSingle()).data
  if (cc?.cardapio_url) await enviarDocumento(from, cc.cardapio_url, 'Cardapio-Botequim.pdf', '📜 Nosso cardápio completo! Me diz o que vai querer 😋\n\n📸 Quer ver algum prato? Peça "foto do [prato]".')
}
async function calcularEntrega(casa, from, endereco) {
  const cfg = (await sb.from('delivery_config').select('*').eq('casa_id', casa.id).maybeSingle()).data
  if (!cfg) return { atende: false, motivo: 'Delivery não configurado.' }
  const prev = (await sb.from('conversas').select('deliv_taxa').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
  const primeira = prev?.deliv_taxa == null
  let loja = (cfg.lat != null && cfg.lng != null) ? { lat: Number(cfg.lat), lng: Number(cfg.lng) } : await geocode(cfg.endereco || '')
  if (cfg.lat == null && loja) await sb.from('delivery_config').update({ lat: loja.lat, lng: loja.lng }).eq('casa_id', casa.id)
  const cli = await geocode(endereco); const taxaPadrao = Number(cfg.taxa_entrega || 0)
  if (!loja || !cli) { await upConversa(casa.id, from, { deliv_endereco: endereco, deliv_taxa: taxaPadrao }); if (primeira) await enviarPdfCardapio(casa, from); return { atende: true, km: null, taxa: taxaPadrao, tempo_estimado: '30 a 50 min' } }
  const km = Math.round(distKm(loja, cli) * 10) / 10
  const tiers = (Array.isArray(cfg.taxa_tiers) && cfg.taxa_tiers.length) ? cfg.taxa_tiers : [{ ate_km: 3, taxa: 6 }, { ate_km: 6, taxa: 9 }, { ate_km: 10, taxa: 14 }]
  const raio = Number(cfg.raio_max_km || tiers[tiers.length - 1].ate_km)
  if (km > raio) return { atende: false, km, motivo: `Endereço a ${km} km — fora da área (até ${raio} km).` }
  const tier = tiers.find((t) => km <= t.ate_km) || tiers[tiers.length - 1]; const taxa = Number(tier.taxa)
  await upConversa(casa.id, from, { deliv_endereco: endereco, deliv_taxa: taxa, deliv_km: km })
  if (primeira) await enviarPdfCardapio(casa, from)
  return { atende: true, km, taxa, tempo_estimado: '30 a 50 min' }
}
async function fotoPrato(casa, from, input) {
  const p = (await sb.from('delivery_produtos').select('nome,foto_url,descricao,preco').eq('casa_id', casa.id).eq('ativo', true).ilike('nome', `%${input.nome}%`).limit(1).maybeSingle()).data
  if (!p) return { ok: false, erro: `Não encontrei "${input.nome}".` }
  if (p.foto_url) { await enviarImagemLink(from, p.foto_url, `${p.nome} — R$ ${Number(p.preco).toFixed(2)}`); return { ok: true, enviou_foto: true } }
  return { ok: false, mensagem: `Ainda não temos foto do ${p.nome} 🙈, mas é uma delícia!${p.descricao ? ' ' + p.descricao : ''}` }
}
async function getCart(casa, from) { const c = (await sb.from('conversas').select('deliv_carrinho').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data; return Array.isArray(c?.deliv_carrinho) ? c.deliv_carrinho : [] }
async function adicionarItem(casa, from, input) {
  const p = (await sb.from('delivery_produtos').select('id,nome,preco').eq('casa_id', casa.id).eq('ativo', true).ilike('nome', `%${input.nome}%`).limit(1).maybeSingle()).data
  if (!p) return { ok: false, erro: `Não encontrei "${input.nome}".` }
  const cart = await getCart(casa, from); const ex = cart.find((i) => i.produto_id === p.id)
  if (ex) ex.qtd += (input.qtd || 1); else cart.push({ produto_id: p.id, nome: p.nome, preco: Number(p.preco), qtd: input.qtd || 1 })
  await upConversa(casa.id, from, { deliv_carrinho: cart }); return { ok: true, adicionado: `${input.qtd || 1}x ${p.nome}` }
}
async function removerItem(casa, from, input) { let cart = await getCart(casa, from); cart = cart.filter((i) => !String(i.nome).toLowerCase().includes(String(input.nome).toLowerCase())); await upConversa(casa.id, from, { deliv_carrinho: cart }); return { ok: true } }
async function descontoPct(casa_id) { const c = (await sb.from('delivery_config').select('desconto_pct').eq('casa_id', casa_id).maybeSingle()).data; return Number(c?.desconto_pct || 0) }
async function promoDelivery(casa_id) { const pct = await descontoPct(casa_id); return pct > 0 ? `🎉 *Promoção de hoje: ${pct}% de desconto!* (já entra no total)\n\n` : '' }
async function verCarrinho(casa, from) {
  const cart = await getCart(casa, from); const conv = (await sb.from('conversas').select('deliv_taxa').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
  const subtotal = cart.reduce((s, i) => s + i.preco * i.qtd, 0); const pct = await descontoPct(casa.id); const desconto = Math.round(subtotal * pct) / 100; const taxa = Number(conv?.deliv_taxa || 0)
  return { itens: cart, subtotal, desconto_pct: pct, desconto, taxa, total: subtotal - desconto + taxa }
}
async function finalizarPedido(casa, from, input) {
  const cart = await getCart(casa, from); if (!cart.length) return { ok: false, erro: 'Carrinho vazio.' }
  const conv = (await sb.from('conversas').select('deliv_endereco,deliv_taxa').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
  const subtotal = cart.reduce((s, i) => s + i.preco * i.qtd, 0); const pct = await descontoPct(casa.id); const desconto = Math.round(subtotal * pct) / 100
  const taxa = Number(conv?.deliv_taxa || 0), total = subtotal - desconto + taxa; const online = input.pagamento === 'online'
  const ins = await sb.from('delivery_pedidos').insert({ casa_id: casa.id, cliente_nome: input.nome ?? null, cliente_telefone: from, endereco: conv?.deliv_endereco ?? null, itens: cart, subtotal, desconto, taxa, total, pagamento: online ? 'online' : 'na_entrega', status: online ? 'aguardando_pagamento' : 'novo' }).select('id').single()
  if (ins.error) return { ok: false, erro: ins.error.message }
  await upConversa(casa.id, from, { modo: null, deliv_carrinho: [], deliv_endereco: null, deliv_taxa: null, deliv_km: null })
  if (online) {
    let link = ''
    try { const d = await (await fetch(`${SB_URL}/functions/v1/pagbank`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'criar', pedido_id: ins.data.id }) })).json(); link = d?.link || '' } catch (_) {}
    if (link) await sendText(from, `💳 *Pague aqui pra confirmar* (Pix ou cartão):\n${link}\n\nAssim que cair, a cozinha começa! 🍻`)
  }
  return { ok: true, total, taxa, desconto, mensagem: `Pedido GRAVADO. Subtotal R$ ${subtotal.toFixed(2)}${desconto > 0 ? `, -R$ ${desconto.toFixed(2)} (${pct}%)` : ''}, entrega R$ ${taxa.toFixed(2)} → *TOTAL R$ ${total.toFixed(2)}*.${online ? ' O LINK JÁ FOI ENVIADO — NÃO repita link, só confirme simpático e breve.' : ' Paga na entrega.'} A cozinha já vai preparar.` }
}

// ===================== FLYER (Gemini) =====================
// fetch com timeout: sem isso, uma chamada travada pendura o flyer pra sempre (bug visto 22/07)
async function fetchTimeout(url, opts = {}, ms = 60000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) } finally { clearTimeout(t) }
}
async function imagemApropriada(b64, mime) {
  try {
    const data = await (await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: 'Esta imagem tem nudez, conteúdo sexual, violência explícita ou algo impróprio para um flyer público de bar? Responda SOMENTE SIM ou NAO.' }] }] }) }, 30000)).json()
    const txt = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text || '').join(' ').toUpperCase(); return !txt.includes('SIM')
  } catch (_) { return true }
}
async function gerarFlyerGemini(selfie, ctx, ocasiao, extra) {
  const hora = ctx?.hora ? String(ctx.hora).slice(0, 5) : ''
  let fundo = null
  try { const rf = await fetchTimeout(LINK_BASE + '/bar-fundo.jpg', {}, 15000); if (rf.ok) { const b = Buffer.from(await rf.arrayBuffer()); fundo = { inline_data: { mime_type: 'image/jpeg', data: b.toString('base64') } } } } catch (e) { console.error('flyer: fundo falhou', e.message) }
  console.log(`flyer: gerando (fundo=${!!fundo}, selfie=${!!selfie})`)
  const prompt = `Crie um FLYER VERTICAL 9:16 de RESERVA CONFIRMADA do "${ctx?.casa || 'Botequim São Paulo'}".${fundo ? ' Use a ' + (selfie ? 'PRIMEIRA ' : '') + 'imagem (ambiente REAL do bar) como CENÁRIO/FUNDO.' : ''}${selfie ? ' A PESSOA da ' + (fundo ? 'SEGUNDA ' : '') + 'foto é o ELEMENTO PRINCIPAL: mostre o ROSTO GRANDE, em DESTAQUE e FIEL (rosto real dela).' : ''}${ocasiao ? ' CONTEXTO: ' + ocasiao + '.' : ''} Estilo moderno, cores quentes, boteco premium noturno. Tipografia legível com: "RESERVA CONFIRMADA", nome "${ctx?.nome || ''}", data "${ctx?.data || ''}${hora ? ' às ' + hora : ''}" e setor "${ctx?.setor || ''}".${extra ? ' AJUSTE: ' + extra + '.' : ''}`
  const parts = []
  if (fundo) parts.push(fundo)
  if (selfie) parts.push({ inline_data: { mime_type: selfie.mime, data: selfie.b64 } })
  parts.push({ text: prompt })
  if (!GEMINI_KEY) { console.error('flyer: GEMINI_KEY/GEMINI_FLYER_KEY não setada no ambiente'); return null }
  const t0 = Date.now()
  try {
    const data = await (await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { imageConfig: { aspectRatio: '9:16' } } }) }, 90000)).json()
    for (const p of (data?.candidates?.[0]?.content?.parts ?? [])) { const d = p.inlineData?.data ?? p.inline_data?.data; if (d) { console.log(`flyer: imagem OK em ${Date.now() - t0}ms`); return { b64: d } } }
    console.error(`flyer: Gemini respondeu sem imagem (${Date.now() - t0}ms):`, JSON.stringify(data).slice(0, 400))
  } catch (e) { console.error(`flyer: exceção Gemini (${Date.now() - t0}ms):`, e.message) }
  return null
}
async function gerarEnviarFlyer(casa, from, selfie, ctx, ocasiao, extra) {
  if (selfie && !(await imagemApropriada(selfie.b64, selfie.mime))) { await sendText(from, 'Essa foto não pode ser usada 🙅 Envie outra selfie apropriada que eu monto 🙂'); return }
  const flyer = await gerarFlyerGemini(selfie, ctx || {}, ocasiao, extra)
  if (!flyer) { await sendText(from, 'Não consegui gerar o flyer agora 😕 Mas sua reserva está garantida!'); return }
  const link = ctx?.token ? `\n\n📋 Confirmem presença: ${LINK_BASE}/confirmar.html?t=${ctx.token}` : ''
  await enviarImagemB64(from, flyer.b64, `Seu flyer do Botequim! 🎉 Manda pros convidados.${link}`)
  const c = (await sb.from('conversas').select('flyer_count').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
  const novo = (c?.flyer_count ?? 0) + 1
  await upConversa(casa.id, from, { flyer_count: novo, flyer_feedback: true, flyer_etapa: null })
  if (novo >= 3) await sendText(from, 'Pronto! 🎉 (último ajuste). Pode enviar aos convidados — te esperamos! 🍻')
  else await sendText(from, 'Ficou bom? 😊 Quer alterar algo (ex: "mais escuro")? É só dizer. Se estiver ótimo, avise! 🙌')
}

// ===================== PAINEL (login Supabase + WhatsApp por unidade) =====================
// CORS aberto: a trava real é o JWT do login (Bearer), não a origem.
app.use('/painel', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
const _authCache = new Map()
async function userDoToken(tok) {
  if (!tok) return null
  const hit = _authCache.get(tok)
  if (hit && hit.exp > Date.now()) return hit.user
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${tok}` } })
    if (!r.ok) return null
    const u = await r.json()
    _authCache.set(tok, { user: u, exp: Date.now() + 60000 })
    return u
  } catch { return null }
}
async function exigeLogin(req, res) {
  const u = await userDoToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
  if (!u) { res.status(401).json({ ok: false, erro: 'Faça login no painel.' }); return null }
  return u
}
// acesso por casa: 'all' = admin; senão lista de casa_ids do usuário.
// Enquanto as tabelas de permissão não existirem no banco, libera tudo (comportamento antigo).
async function casasPermitidas(user) {
  const adm = await sb.from('painel_usuarios').select('admin').eq('user_id', user.id).maybeSingle()
  if (adm.error) return 'all'
  if (adm.data?.admin) return 'all'
  const rows = await sb.from('user_casas').select('casa_id').eq('user_id', user.id)
  if (rows.error) return 'all'
  return (rows.data ?? []).map((r) => r.casa_id)
}
const podeCasa = (perm, casa_id) => perm === 'all' || perm.includes(casa_id)
async function evoAdmin(method, path) {
  try {
    const r = await fetch(`${EVOLUTION_URL}${path}`, { method, headers: { apikey: MASTER_KEY } })
    if (!r.ok) return { _erro: `${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}` }
    return await r.json().catch(() => ({}))
  } catch (e) { return { _erro: e.message } }
}
async function listaInstancias() {
  const r = await evoAdmin('GET', '/instance/fetchInstances')
  return Array.isArray(r) ? r : (r && r.name ? [r] : [])
}

// status do WhatsApp de cada unidade (pro ⚙️ do tablet)
app.get('/painel/instances', async (req, res) => {
  const u = await exigeLogin(req, res); if (!u) return
  const perm = await casasPermitidas(u)
  let casas = (await sb.from('casas').select('id,nome,nome_curto,slug').eq('ativo', true).order('nome')).data ?? []
  casas = casas.filter((c) => podeCasa(perm, c.id))
  const lista = await listaInstancias()
  res.json({ ok: true, unidades: casas.map((c) => {
    const inst = instDaCasa(c.slug)
    const i = lista.find((x) => x.name === inst)
    const status = i?.connectionStatus || 'inexistente'
    return { casa_id: c.id, casa: c.nome, slug: c.slug, instancia: inst, existe: !!i, status, conectado: status === 'open',
      numero: i?.ownerJid ? '+' + i.ownerJid.split('@')[0] : null, perfil: i?.profileName || null }
  }) })
})

// gera QR pra conectar o WhatsApp da unidade (cria a instância se não existir)
app.post('/painel/qr', async (req, res) => {
  const u = await exigeLogin(req, res); if (!u) return
  const { casa_id, force, refresh } = req.body || {}
  if (!podeCasa(await casasPermitidas(u), casa_id)) return res.status(403).json({ ok: false, erro: 'Sem acesso a esta unidade.' })
  const c = (await sb.from('casas').select('id,nome,slug').eq('id', casa_id).maybeSingle()).data
  if (!c) return res.status(404).json({ ok: false, erro: 'Casa não encontrada.' })
  const inst = instDaCasa(c.slug)
  const existe = (await listaInstancias()).find((x) => x.name === inst)
  if (!existe) {
    try {
      const cr = await fetch(`${EVOLUTION_URL}/instance/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: MASTER_KEY },
        body: JSON.stringify({ instanceName: inst, integration: 'WHATSAPP-BAILEYS', qrcode: false,
          webhook: { url: `${ROBOT_URL}/webhook`, byEvents: false, base64: false, headers: { 'x-webhook-secret': WEBHOOK_SECRET }, events: ['MESSAGES_UPSERT'] } }) })
      if (!cr.ok) return res.json({ ok: false, erro: `Criar instância falhou: ${cr.status} ${(await cr.text()).slice(0, 200)}` })
    } catch (e) { return res.json({ ok: false, erro: 'Criar instância: ' + e.message }) }
  } else if (existe.connectionStatus === 'open' && !force) {
    return res.json({ ok: true, conectado: true, numero: existe.ownerJid ? '+' + existe.ownerJid.split('@')[0] : null })
  } else if (!refresh) {
    await evoAdmin('DELETE', `/instance/logout/${inst}`) // sessão velha trava o pareamento novo
  }
  const conn = await evoAdmin('GET', `/instance/connect/${inst}`)
  const b64 = conn?.base64 || conn?.qrcode?.base64
  if (!b64) return res.json({ ok: false, erro: 'Evolution não devolveu QR: ' + JSON.stringify(conn).slice(0, 200) })
  res.json({ ok: true, conectado: false, qr: b64, pairingCode: conn?.pairingCode || null })
})

// resposta humana do painel (aba Conversas / envio de pesquisa)
app.post('/painel/send', async (req, res) => {
  const u = await exigeLogin(req, res); if (!u) return
  const { casa_id, telefone, texto } = req.body || {}
  if (!casa_id || !telefone || !texto) return res.status(400).json({ ok: false, erro: 'casa_id, telefone e texto são obrigatórios.' })
  if (!podeCasa(await casasPermitidas(u), casa_id)) return res.status(403).json({ ok: false, erro: 'Sem acesso a esta unidade.' })
  const c = (await sb.from('casas').select('id,slug').eq('id', casa_id).maybeSingle()).data
  if (!c) return res.status(404).json({ ok: false, erro: 'Casa não encontrada.' })
  const r = await als.run({ inst: instDaCasa(c.slug) }, () => sendText(telefone, texto))
  const conv = (await sb.from('conversas').select('historico').eq('casa_id', casa_id).eq('telefone', telefone).maybeSingle()).data
  const h = Array.isArray(conv?.historico) ? conv.historico : []
  h.push({ role: 'assistant', content: texto })
  await sb.from('conversas').update({ historico: h, updated_at: new Date().toISOString() }).eq('casa_id', casa_id).eq('telefone', telefone)
  res.json({ ok: !!r })
})

// diagnóstico do flyer sem WhatsApp (curl com x-webhook-secret) — testa a geração isolada no servidor
app.get('/debug/flyer', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) return res.sendStatus(401)
  const t0 = Date.now()
  const flyer = await gerarFlyerGemini(null, { nome: 'Teste', data: '25/07', hora: '19:00', setor: 'Varanda', casa: 'Botequim Santo André' }, 'teste interno de diagnóstico')
  let envio = null
  if (flyer && req.query.send) envio = await enviarImagemB64(String(req.query.send), flyer.b64, '🧪 Teste interno do flyer (ignorar)')
  res.json({ ok: !!flyer, ms: Date.now() - t0, bytes: flyer ? flyer.b64.length : 0, envio: req.query.send ? !!envio : undefined })
})

// ===================== WEBHOOK =====================
function extrairTexto(m = {}) { return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '' }

app.get('/', (_req, res) => res.json({ ok: true, robo: 'botequim', multi: Object.keys(CASA_MAP).length || 0 }))

app.post('/webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) return res.sendStatus(401)
  res.sendStatus(200)
  const body = req.body || {}
  if (String(body.event || '').toLowerCase().replace(/_/g, '.') !== 'messages.upsert') return
  als.run({ inst: body.instance || INSTANCE }, () => processarMensagem(body).catch((e) => console.error('erro webhook:', e.message)))
})

async function processarMensagem(body) {
  {
    const d = body.data || {}; const key = d.key || {}; const jid = key.remoteJid || ''
    if (key.fromMe || jid === 'status@broadcast') return
    if (jid.endsWith('@g.us')) return
    const from = jid.split('@')[0]
    const isImage = !!d.message?.imageMessage
    const texto = extrairTexto(d.message)
    console.log(`💬 ${d.pushName || from}: ${isImage ? '[imagem] ' : ''}${texto || ''}`)

    // instância mapeada no CASA_MAP OU instância com nome = slug da casa; fallback = CASA_SLUG
    let casa = await getCasa(CASA_MAP[body.instance] || body.instance)
    if (!casa) casa = await getCasa()
    if (!casa) { console.error('!! casa não encontrada p/ instância', body.instance); return }
    const conv = await getConversa(casa.id, from)
    await gravaNome(casa.id, from, d.pushName || null)

    // humano assumiu
    if (conv.handoff) {
      if (texto.trim()) { const h = Array.isArray(conv.historico) ? conv.historico : []; h.push({ role: 'user', content: texto }); await upConversa(casa.id, from, { historico: h }) }
      return
    }

    await sleep(rand(PRE_MIN, PRE_MAX)) // espera humana (nao digitar na hora)

    // ---- FLYER: imagem (selfie) ----
    if (isImage && (conv.flyer_etapa === 'selfie' || conv.flyer_etapa === 'foto')) {
      await sendText(from, 'Perfeito! Montando o seu flyer... 🎨')
      const foto = await baixarMidiaB64(d)
      if (!foto) { await sendText(from, 'Não consegui baixar a foto, manda de novo? 🙏'); return }
      await gerarEnviarFlyer(casa, from, foto, conv.flyer_ctx, conv.flyer_ocasiao); return
    }
    if (isImage) { await sendText(from, 'Recebi sua foto 🙂 Me conta por texto: pra quantas pessoas, que dia e horário?'); return }
    if (!texto.trim()) { await sendText(from, 'Por enquanto eu entendo texto e fotos 🙂'); return }

    // saudação isolada SEMPRE reseta pro menu — roda ANTES de qualquer fluxo pendente (flyer/delivery/velho histórico)
    if (/^(menu|voltar|in[ií]cio|inicio|come[çc]ar|recome[çc]ar|oi+|ol[aá]|bom dia|boa tarde|boa noite|opa|eae|e a[ií])\s*[!.?]*$/i.test(texto.trim())) {
      await upConversa(casa.id, from, { modo: null, aguardando: 'menu', historico: [], saudou: true, flyer_etapa: null, flyer_feedback: false, flyer_count: 0, flyer_ocasiao: null })
      await sendText(from, MENU_TXT(casa.nome)); return
    }

    // ---- fluxo do flyer (texto) ----
    if (conv.flyer_etapa === 'ocasiao') {
      if (/n[ãa]o quero|n[ãa]o precisa|sem flyer|depois|deixa pra l[áa]|n[ãa]o,? obrig/i.test(texto)) { await upConversa(casa.id, from, { flyer_etapa: null }); await sendText(from, 'Sem problemas! Qualquer coisa é só chamar. Te esperamos no Botequim! 🍻'); return }
      await upConversa(casa.id, from, { flyer_etapa: 'tema', flyer_ocasiao: texto }); await sendText(from, 'Ótimo! 🎉 Qual o *tema/estilo* do flyer? (elegante, retrô, neon, festa colorida...)'); return
    }
    if (conv.flyer_etapa === 'tema') { await upConversa(casa.id, from, { flyer_etapa: 'foto', flyer_ocasiao: (conv.flyer_ocasiao || '') + '. Tema: ' + texto }); await sendText(from, 'Perfeito! 🎨 Prefere COM a sua foto (envie uma selfie) ou só a ARTE do bar? Responda "minha foto" (e envie a selfie) ou "só o bar".'); return }
    if (conv.flyer_etapa === 'foto') {
      if (/sem foto|s[óo] o bar|s[óo] a arte|^arte|do bar|sem a foto|sem selfie/i.test(texto)) { await sendText(from, 'Perfeito! Montando com a arte do bar... 🎨'); await gerarEnviarFlyer(casa, from, null, conv.flyer_ctx || {}, conv.flyer_ocasiao); return }
      if (/com foto|minha foto|com a minha|selfie|^sim|quero/i.test(texto)) { await upConversa(casa.id, from, { flyer_etapa: 'selfie' }); await sendText(from, 'Perfeito! Pode enviar sua selfie agora 🤳\n_(usada só para o flyer 🙂)_'); return }
      await sendText(from, 'Responda "minha foto" (e envie a selfie) ou "só o bar" 🙂'); return
    }
    if (conv.flyer_feedback) {
      if (/([óo]tim|bom|boa|gostei|perfeit|obrigad|valeu|adorei|maravilh|top|show|amei|lind|fic(ou|o) bom)/i.test(texto)) { await upConversa(casa.id, from, { flyer_feedback: false }); await sendText(from, 'Que ótimo! 🎉 Pode enviar aos convidados. Te esperamos no Botequim! 🍻'); return }
      if ((conv.flyer_count ?? 0) >= 3) { await upConversa(casa.id, from, { flyer_feedback: false }); await sendText(from, 'Esse foi o limite de ajustes 🙂 O último ficou pronto e sua reserva está garantida!'); return }
      await sendText(from, 'Certo! Ajustando o flyer... 🎨'); await gerarEnviarFlyer(casa, from, null, conv.flyer_ctx || {}, conv.flyer_ocasiao, texto); return
    }

    // ---- pediu FLYER por texto, fora do pós-reserva (spec Giovanna 22/07) ----
    if (/\bfl[iy]er\b|arte da reserva/i.test(texto) && !conv.flyer_etapa) {
      const hojeD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
      const r = (await sb.from('reservas').select('nome,data,hora,token,ambiente_id').eq('casa_id', casa.id).eq('telefone', from).gte('data', hojeD).in('status', ['pendente', 'confirmada']).order('data').limit(1).maybeSingle()).data
      if (!r) { await sendText(from, 'O flyer é montado junto com a sua reserva 🙂 Quer reservar? Me diga seu *nome*, *quantas pessoas*, a *data* e o *horário* — e depois eu crio seu flyer! 🎨'); return }
      const amb = r.ambiente_id ? (await sb.from('ambientes').select('nome').eq('id', r.ambiente_id).maybeSingle()).data : null
      const ctx = { nome: r.nome, data: String(r.data).split('-').reverse().join('/'), hora: r.hora ?? '', setor: amb?.nome ?? '', casa: casa.nome, token: r.token }
      const ocas = texto.replace(/.*fl[iy]er( d[eao])?/i, '').replace(/[!.?]+$/, '').trim()
      if (ocas.length > 2) { await upConversa(casa.id, from, { flyer_etapa: 'tema', flyer_ocasiao: ocas, flyer_ctx: ctx, flyer_count: 0, flyer_feedback: false }); await sendText(from, 'Bora! 🎉 Qual o *tema/estilo* do flyer? (elegante, retrô, neon, festa colorida...)'); return }
      await upConversa(casa.id, from, { flyer_etapa: 'ocasiao', flyer_ctx: ctx, flyer_count: 0, flyer_feedback: false })
      await sendText(from, '🎨 Bora montar o flyer da sua reserva! Qual a *ocasião*? (aniversário, happy hour, encontro...)'); return
    }

    // ---- reclamação ----
    if (conv.aguardando === 'reclamacao') {
      const cliente = (await sb.from('clientes').select('nome').eq('casa_id', casa.id).eq('telefone', from).maybeSingle()).data
      await sb.from('reclamacoes').insert({ casa_id: casa.id, telefone: from, nome: cliente?.nome ?? null, texto })
      await upConversa(casa.id, from, { aguardando: null })
      const c = (await sb.from('casas').select('gerente_whatsapp,nome,nome_curto').eq('id', casa.id).maybeSingle()).data
      if (c?.gerente_whatsapp) await sendText(c.gerente_whatsapp, `🚨 *Reclamação — ${c.nome_curto ?? c.nome}*\nDe: ${from}${cliente?.nome ? ' (' + cliente.nome + ')' : ''}\n\n"${texto}"`)
      await sendText(from, 'Obrigado por nos avisar 🙏 Encaminhei ao gerente da unidade. Para outra coisa, responda *menu*.'); return
    }

    // ---- delivery em andamento ----
    if (conv.modo === 'delivery') {
      const hist = Array.isArray(conv.historico) ? conv.historico : []; hist.push({ role: 'user', content: texto })
      const reply = await runDeliveryAgent(casa, from, hist)
      if (reply.text) { hist.push({ role: 'assistant', content: reply.text }); await sendText(from, reply.text) }
      await upConversa(casa.id, from, { historico: hist }); return
    }

    // ---- pediu atendente ----
    if (/atendente|humano|especialista|pessoa de verdade|falar com (algu[eé]m|uma pessoa|um humano|a gente|gerente)/i.test(texto) || intentDoTexto(texto) === 'atendente') {
      await upConversa(casa.id, from, { handoff: true, handoff_aguardando: true })
      await sendText(from, `Claro! 🙂 Só um instante — um atendente do *${casa.nome}* vai continuar por aqui. Pode escrever sua mensagem.`)
      await avisarGerente(casa, from, 'pediu para falar com um atendente'); return
    }

    // ---- menu / recomeço ----
    // (reset por saudação movido pra ANTES dos fluxos de flyer/delivery — ver acima)

    const history = Array.isArray(conv.historico) ? conv.historico : []
    const menuMode = conv.aguardando === 'menu' || (!conv.saudou && history.length === 0)

    // 1a mensagem sem pedido claro -> mostra o menu e espera a escolha
    if (!conv.saudou && history.length === 0 && !intentDoTexto(texto) && !/reserv|mesa|\d+\s*pessoa|delivery|pedid|d[uú]vida/i.test(texto)) {
      await upConversa(casa.id, from, { saudou: true, aguardando: 'menu' })
      await sendText(from, MENU_TXT(casa.nome)); return
    }

    // escolha do menu (por número 1-7 ou palavra), só quando estamos esperando a escolha
    const intent = menuMode ? intentDoTexto(texto) : null
    if (intent === 'cardapio') { await upConversa(casa.id, from, { saudou: true, aguardando: null }); await enviarPdfCardapio(casa, from); return }
    // Delivery desativado 19/07/2026 — quem pedir recebe aviso simpático (religar: restaurar o handler antigo do intent 'delivery')
    if (intent === 'delivery_off') { await upConversa(casa.id, from, { saudou: true, aguardando: 'menu' }); await sendText(from, `Por enquanto estamos atendendo *reservas e dúvidas* por aqui 🙂 Delivery em breve!\n\n${MENU_TXT(casa.nome)}`); return }
    if (intent === 'reclamacoes') { await upConversa(casa.id, from, { saudou: true, aguardando: 'reclamacao' }); await sendText(from, 'Sentimos muito 😔 Descreva em uma mensagem o que aconteceu que eu encaminho ao gerente.'); return }
    if (intent === 'minhas') {
      await upConversa(casa.id, from, { saudou: true, aguardando: null })
      const hojeD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
      const rs = (await sb.from('reservas').select('data,hora,qtd_pessoas,status,ambiente_id').eq('casa_id', casa.id).eq('telefone', from).gte('data', hojeD).order('data').limit(10)).data ?? []
      if (!rs.length) { await sendText(from, 'Não encontrei reservas futuras neste número. Quer fazer uma? Responda *reservas* 🙂'); return }
      const ambs = (await sb.from('ambientes').select('id,nome').eq('casa_id', casa.id)).data ?? []
      const linhas = rs.map((r) => `• ${String(r.data).split('-').reverse().join('/')}${r.hora ? ' às ' + String(r.hora).slice(0, 5) : ''} — ${r.qtd_pessoas}p — ${ambs.find((a) => a.id === r.ambiente_id)?.nome ?? ''} _(${r.status})_`).join('\n')
      await sendText(from, `📋 Suas reservas:\n\n${linhas}\n\nPara alterar/cancelar, responda *atendente*.`); return
    }
    if (intent === 'reservas' || intent === 'duvidas') {
      await upConversa(casa.id, from, { saudou: true, aguardando: null })
      await sendText(from, `Perfeito! 🍻 Me informe: seu *nome*, *quantas pessoas*, a *data* e o *horário* desejados. (Também respondo dúvidas sobre horários, endereço e eventos.)`); return
    }

    // ---- default: agente de RESERVA (também responde dúvidas) ----
    if (conv.aguardando === 'menu') await upConversa(casa.id, from, { aguardando: null })
    if (!conv.saudou && history.length === 0) {
      await sendText(from, `Olá! 👋 Você está no *canal de reservas do ${casa.nome}*. Será um prazer garantir sua mesa. 🍻\nPara começar: seu *nome*, *quantas pessoas*, a *data* e o *horário*.`)
      await upConversa(casa.id, from, { saudou: true })
    }
    history.push({ role: 'user', content: texto })
    const reply = await runAgent(casa, from, history)
    if (reply.text) { history.push({ role: 'assistant', content: reply.text }); await sendText(from, reply.text) }
    for (const fu of reply.followups ?? []) { await sendText(from, fu); history.push({ role: 'assistant', content: fu }) }
    await upConversa(casa.id, from, { historico: history })
  }
}

app.listen(PORT, () => console.log(`Robo Botequim ouvindo na porta ${PORT} | multi-instância | fallback ${INSTANCE}`))
