// Voice Booking — the booking product for someone who would rather talk than read.
//
// The Flight Booking page is a search product with an assistant beside it: fill the panel,
// press Search, read the list underneath. This page is the opposite shape. There is no
// search panel at all. It is a REALTIME CALL — the same always-listening, barge-in socket
// the Voice Call page uses — and everything the agent finds appears as a card INSIDE the
// thread, right where the sentence that produced it is. That is the whole point: a caller
// who cannot work a date picker, or cannot read the small print, can say what they want and
// then either tell the agent to book it or tap one big button on the card.
//
// The cards can only exist here because both tiers now send the tool RESULT on the socket
// (`tool_result`, from bot/tools/airline.py `_reply` and control/realtime.py's
// `_handle_tool_call`). That frame carries exactly the JSON the text `/chat` loop already
// returns in `tool_calls[].result`, so one renderer draws both paths — see
// components/flightcard.js.
import { VoiceCall } from '../lib/audio.js'
import { pod, isCloud } from '../lib/api.js'
import { assertPodReady, explainAgentFailure } from '../lib/ready.js'
import { icons } from '../components/icons.js'
import { esc, isArabic, traceLine } from '../lib/fmt.js'
import {
  t, decorate, cheapestFare, flightCardHtml, bookFormHtml, pnrCardHtml, emptyHtml,
  resultsHeadHtml,
} from '../components/flightcard.js'

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4z"/></svg>'

export function renderVoiceBooking() {
  const el = document.createElement('div')
  el.className = 'vb'

  // ------------------------------------------------------------------- state
  let call = null                 // live VoiceCall, or null when idle
  let lang = 'en'                 // language of the last thing said — drives the chrome
  let cardSeq = 0                 // ids for cards, so a later book_flight can find one
  const cards = new Map()         // card id -> {flight, cabin}
  const history = []              // [{role, content}] for the typed path only
  // What the agent has been told about the passenger, harvested from its own tool args.
  // A caller who has already spelled their name to the agent should not have to type it.
  const passenger = { given: '', surname: '' }

  el.innerHTML = `
    <div class="vb-shell">
      <div class="vb-head">
        <button class="vb-call-btn" id="call" title="Start call">${icons.mic}</button>
        <div class="vb-head-text">
          <div class="vb-head-title" id="state">Tap to talk</div>
          <div class="vb-head-sub" id="hint">Arabic or English — say where you want to fly</div>
        </div>
        <div class="vb-provider" id="provider"></div>
      </div>
      <div class="vb-thread" id="thread"></div>
      <form class="vb-compose" id="compose">
        <input class="vb-compose-inp" id="msg" autocomplete="off"
               placeholder="…or type it here" />
        <button type="submit" class="vb-send" id="send" title="Send">${SEND_ICON}</button>
      </form>
    </div>`

  const $ = (id) => el.querySelector(`#${id}`)
  const thread = $('thread')
  const callBtn = $('call')
  const stateEl = $('state')
  const hintEl = $('hint')
  const input = $('msg')
  const sendBtn = $('send')

  $('provider').textContent = isCloud() ? 'cloud realtime' : 'self-hosted pod'

  // ------------------------------------------------------------------ thread

  const atBottom = () =>
    thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80

  /** Append a node and follow it, unless the user has scrolled up to re-read something. */
  function push(node) {
    const follow = atBottom()
    thread.appendChild(node)
    if (follow) node.scrollIntoView({ block: 'end', behavior: 'smooth' })
    return node
  }

  function bubble(cls, text) {
    const d = document.createElement('div')
    d.className = `vb-msg ${cls}`
    if (isArabic(text)) d.dir = 'rtl'
    d.textContent = text
    return push(d)
  }

  function trace(text, bad = false) {
    const d = document.createElement('div')
    d.className = `vb-trace${bad ? ' bad' : ''}`
    d.textContent = text
    return push(d)
  }

  function block(html) {
    const d = document.createElement('div')
    d.className = 'vb-block'
    d.innerHTML = html
    return push(d)
  }

  // The agent's reply streams in as several messages sharing one `turn`, the last flagged
  // final — same contract both tiers emit and demo.js reads. Keep the bubble in flight and
  // rewrite it rather than appending one per fragment. Keyed by `turn` so a barge-in the
  // server never observed cannot make the next reply overwrite the previous one.
  let botTurn = null
  function botStream(m) {
    const id = m.turn ?? 'single'
    if (!botTurn || botTurn.id !== id) {
      botTurn = { id, el: bubble('agent', m.text) }
    } else {
      botTurn.el.textContent = m.text
      botTurn.el.dir = isArabic(m.text) ? 'rtl' : 'ltr'
      if (atBottom()) botTurn.el.scrollIntoView({ block: 'end' })
    }
    botTurn.el.classList.toggle('streaming', !m.final)
    if (m.final) botTurn = null
  }

  function setState(title, sub, cls = '') {
    stateEl.textContent = title
    hintEl.textContent = sub
    el.querySelector('.vb-head').className = `vb-head ${cls}`
  }

  // ----------------------------------------------------------- tool results

  /** Draw a `search_flights` result as a group of cards in the thread.
   *
   *  `clickableAlts` is false during a call: the empty-state date chips work by sending the
   *  agent a sentence, and a live socket carries audio only — a chip that silently does
   *  nothing is worse than a chip that is plainly just a hint. */
  function renderSearch(result, args, { clickableAlts }) {
    const cabin = args?.cabin || 'economy'
    if (!result.flights?.length) {
      block(emptyHtml(result, lang, { clickable: clickableAlts }))
      return
    }
    const items = decorate(result.flights, lang)
    const html = items.map(({ f, tag }) => {
      const id = `c${++cardSeq}`
      cards.set(id, { flight: f, cabin })
      return flightCardHtml(f, { tag, cabin, lang, id })
    }).join('')
    block(resultsHeadHtml(result, lang) + html)
  }

  /** A booking the AGENT made. Show the same PNR card the tap path shows, and retire the
   *  card for that flight so the thread does not offer to book a seat that is now held. */
  function renderBooked(result) {
    block(pnrCardHtml(result, lang))
    const no = result.flight?.flight_no?.code
    const date = result.flight?.date?.iso
    for (const [id, { flight }] of cards) {
      if (flight.flight_no.code !== no || flight.date.iso !== date) continue
      const card = thread.querySelector(`[data-card="${id}"]`)
      if (card) {
        card.classList.add('booked')
        const btn = card.querySelector('[data-a=select]')
        if (btn) { btn.disabled = true; btn.textContent = t(lang).booked }
      }
    }
  }

  /** One tool result, from either path. Anything that is not a search or a booking stays a
   *  one-line trace: this page is a booking flow, not an inspector. */
  function onToolResult({ name, args, result }) {
    if (!result) return
    // Harvest whatever the agent has learned about the passenger, so tapping Book later is
    // one confirm rather than two spellings on a phone keyboard.
    if (args?.given_name) passenger.given = args.given_name
    if (args?.surname) passenger.surname = args.surname

    if (name === 'search_flights') renderSearch(result, args, { clickableAlts: !call })
    else if (name === 'book_flight' && result.ok !== false && result.pnr) renderBooked(result)
    else trace(traceLine({ name, args, result }), result.ok === false)
  }

  // --------------------------------------------------------------- the call

  const handlers = {
    onState: (s) => {
      if (s === 'connected') setState('Listening', 'Just talk — tap again to end', 'live')
      else if (s === 'closed' && call) endCall()
    },
    onTranscript: (m) => {
      if (m.language) lang = m.language.startsWith('ar') ? 'ar' : 'en'
      if (m.role === 'assistant') botStream(m)
      else bubble('you', m.text)
    },
    onToolCall: (m) => trace(`${m.name}(${JSON.stringify(m.args || {})})`),
    onToolResult: onToolResult,
    onBotSpeaking: (on) => {
      callBtn.classList.toggle('speaking', on)
      if (call) setState(on ? 'Speaking' : 'Listening',
        on ? 'Interrupt any time — just talk over it' : 'Just talk — tap again to end', 'live')
    },
    onError: (e) => trace(e, true),
  }

  async function startCall() {
    try {
      setState('Connecting…', 'resolving the agent', 'busy')
      const wsUrl = await pod.wsUrl()
      await assertPodReady()
      call = new VoiceCall(wsUrl, handlers)
      await call.start()
      callBtn.classList.add('live')
      input.disabled = sendBtn.disabled = true
      input.placeholder = 'Mic is live — just talk'
      setState('Connecting…', 'saying hello', 'busy')
    } catch (e) {
      // A readiness or pod-state message is already a complete sentence; only a genuine
      // mic/socket exception needs the extra context.
      const known = /pod (is )?not (ready|running)|audio port|failed to load|start it in Pod/i
      trace(known.test(e.message) ? e.message : `mic/ws failed: ${e.message}`, true)
      call = null
      setState('Tap to talk', 'Arabic or English — say where you want to fly')
    }
  }

  function endCall() {
    call?.stop()
    call = null
    botTurn = null
    callBtn.classList.remove('live', 'speaking')
    input.disabled = sendBtn.disabled = false
    input.placeholder = '…or type it here'
    setState('Tap to talk', 'Arabic or English — say where you want to fly')
  }

  // -------------------------------------------------------- the typed path

  // The socket accepts audio and {type:'interrupt'} only, on both tiers, so a typed turn
  // goes through /chat instead — a separate context from the call's. Hence the compose is
  // disabled while a call is live: two threads of memory, one visible thread, is a demo
  // that contradicts itself on stage. Idle, it is the whole page in miniature and needs no
  // microphone permission at all.
  let busy = false
  async function sendTyped(text) {
    if (busy || !text || call) return
    busy = true
    sendBtn.disabled = true
    bubble('you', text)
    input.value = ''
    setState('Thinking…', 'asking the agent', 'busy')
    try {
      const r = await pod.chat(text, history)
      for (const tc of (r.tool_calls || [])) onToolResult(tc)
      if (r.text) {
        if (isArabic(r.text)) lang = 'ar'
        bubble('agent', r.text)
      }
      history.push({ role: 'user', content: text })
      if (r.text) history.push({ role: 'assistant', content: r.text })
      setState('Tap to talk', 'Arabic or English — say where you want to fly')
    } catch (ex) {
      // A 500 here is almost always "vLLM is not listening yet", not a bug.
      trace(await explainAgentFailure(ex), true)
      setState('Tap to talk', 'something went wrong — see the thread')
    } finally {
      busy = false
      sendBtn.disabled = false
      input.focus()
    }
  }

  // ------------------------------------------------------- booking, by tap

  async function confirmBooking(card, entry) {
    const panel = card.querySelector('.vb-book')
    const given = panel.querySelector('[data-f=given]').value.trim()
    const surname = panel.querySelector('[data-f=surname]').value.trim()
    const err = panel.querySelector('[data-f=err]')
    const L = t(lang)
    err.textContent = ''
    if (!given || !surname) { err.textContent = L.namesRequired; return }

    const btn = panel.querySelector('[data-a=confirm]')
    btn.disabled = true
    try {
      const b = await pod.book({
        flight_no: entry.flight.flight_no.code,
        depart_date: entry.flight.date.iso,
        given_name: given,
        surname,
        cabin: entry.cabin,
      })
      passenger.given = given
      passenger.surname = surname
      panel.innerHTML = pnrCardHtml(b, lang)
      card.classList.add('booked')
      const sel = card.querySelector('[data-a=select]')
      if (sel) { sel.disabled = true; sel.textContent = L.booked }
      if (atBottom()) panel.scrollIntoView({ block: 'end', behavior: 'smooth' })
    } catch (ex) {
      // A domain refusal (sold out, cancelled flight) comes back as a 400 carrying the same
      // sentence the agent would say on the phone.
      err.textContent = ex.message
      btn.disabled = false
    }
  }

  // ------------------------------------------------------------------ wiring

  callBtn.addEventListener('click', () => (call ? endCall() : startCall()))

  $('compose').addEventListener('submit', (e) => {
    e.preventDefault()
    sendTyped(input.value.trim())
  })

  // Card actions and the empty-state date chips, delegated so they survive every append.
  thread.addEventListener('click', (e) => {
    const alt = e.target.closest('[data-alt]')
    if (alt) { sendTyped(`What about ${alt.dataset.alt}?`); return }

    const card = e.target.closest('.vb-card')
    if (!card) return
    const entry = cards.get(card.dataset.card)
    if (!entry) return
    const panel = card.querySelector('.vb-book')

    if (e.target.closest('[data-a=select]')) {
      panel.hidden = !panel.hidden
      if (!panel.hidden) {
        panel.innerHTML = bookFormHtml({
          lang, given: passenger.given, surname: passenger.surname,
          price: cheapestFare(entry.flight)?.price,
        })
        panel.querySelector('[data-f=given]').focus()
        if (atBottom()) panel.scrollIntoView({ block: 'end', behavior: 'smooth' })
      }
    } else if (e.target.closest('[data-a=cancel]')) {
      panel.hidden = true
    } else if (e.target.closest('[data-a=confirm]')) {
      confirmBooking(card, entry)
    }
  })

  // ------------------------------------------------------------------ mount

  bubble('agent', 'Hi! Tap the microphone and tell me where you want to fly — '
    + 'in English or Egyptian Arabic. أهلاً! دوس على المايك وقولي عايز تسافر فين.')

  return { el, cleanup: () => { try { call?.stop() } catch {} } }
}
