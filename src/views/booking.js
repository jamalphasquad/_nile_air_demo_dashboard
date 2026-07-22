// Flight Booking — the agent demo with a product around it.
//
// Everything on this page is driven by ONE engine: the pod's /chat tool loop. The search
// panel does not query a flight endpoint; it composes a sentence and sends it through the
// same agent the voice call uses, and the cards below are rendered from the `search_flights`
// entries in that turn's tool trace. So what you see is literally what the agent found —
// there is no second search implementation to drift from the one on the phone.
//
// Voice input is push-to-talk into the pod's own STT host (via /api/control/stt), not the
// browser's speech API: dialect Arabic is the whole point of this demo and Egyptian Arabic
// is exactly what the browser is worst at.
import { pod } from '../lib/api.js'
import { PushToTalk } from '../lib/audio.js'
import { icons } from '../components/icons.js'
import { esc, isArabic, traceLine, hhmm, hm, money, dayLabel } from '../lib/fmt.js'
import { explainAgentFailure } from '../lib/ready.js'

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4z"/></svg>'
const SWAP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4M21 7H7M7 21l-4-4 4-4M3 17h14"/></svg>'
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>'

const today = () => new Date().toISOString().slice(0, 10)

// Cheapest fare in the cabin that was searched. queries.search_flights already sorts fares
// by price, so this is fares[0] — but do not assume it, an empty cabin returns no fares.
const cheapestFare = (f) =>
  (f.fares || []).reduce((best, x) => (!best || x.price.amount < best.price.amount ? x : best), null)

export function renderBooking() {
  const el = document.createElement('div')

  // ------------------------------------------------------------------- state
  const history = []                       // [{role, content}] — the thread, as in chat.js
  const criteria = {
    trip: 'round',
    origin: 'CAI',
    destination: 'DXB',
    departDate: today(),
    departTo: '',                          // set for a range search ("sometime next week")
    returnDate: '',
    passengers: 1,
    cabin: 'economy',
  }
  // Each leg holds the raw `search_flights` result plus the args that produced it.
  const legs = { out: null, in: null }
  let sort = 'best'
  let busy = false
  let ptt = null                           // live PushToTalk, when recording

  el.innerHTML = `
    <div class="card fb-assistant">
      <div class="fb-assistant-head">
        <div class="fb-avatar">${icons.mic}</div>
        <div>
          <div class="fb-assistant-name">Nile Air Assistant</div>
          <div class="fb-assistant-sub" id="assist-state">
            <span class="fb-dot"></span>Ready · voice &amp; text
          </div>
        </div>
        <div class="card-meta" id="model"></div>
      </div>
      <div class="fb-thread" id="thread"></div>
      <form class="fb-compose" id="compose">
        <input class="fb-compose-inp" id="msg" autocomplete="off"
               placeholder="Ask to change dates, find the cheapest, or search a whole week…" />
        <div class="fb-wave" id="wave" hidden aria-hidden="true"></div>
        <button type="button" class="fb-icon-btn" id="mic" title="Click to record">${icons.mic}</button>
        <button type="submit" class="fb-icon-btn primary" id="send" title="Send">${SEND_ICON}</button>
      </form>
    </div>

    <div class="card">
      <div class="fb-tabs" id="trip">
        <button type="button" class="fb-tab active" data-trip="round">Round trip</button>
        <button type="button" class="fb-tab" data-trip="oneway">One way</button>
      </div>

      <div class="fb-grid-2">
        <div class="fb-tile">
          <div class="fb-tile-label">From</div>
          <input class="fb-tile-inp" id="origin" value="CAI" />
          <div class="fb-tile-sub">City name or IATA</div>
        </div>
        <div class="fb-tile">
          <div class="fb-tile-label">To</div>
          <input class="fb-tile-inp" id="destination" value="DXB" />
          <div class="fb-tile-sub">City name or IATA</div>
        </div>
        <button type="button" class="fb-swap" id="swap" title="Swap">${SWAP_ICON}</button>
      </div>

      <div class="fb-grid-4">
        <div class="fb-tile">
          <div class="fb-tile-label">Depart</div>
          <input class="fb-tile-inp" id="departDate" type="date" />
          <div class="fb-tile-sub">
            <button type="button" class="fb-link" id="range-toggle">+ search a date range</button>
          </div>
          <div class="fb-range" id="range" hidden>
            <span class="fb-tile-label">through</span>
            <input class="fb-tile-inp" id="departTo" type="date" />
          </div>
        </div>
        <div class="fb-tile" id="return-tile">
          <div class="fb-tile-label">Return</div>
          <input class="fb-tile-inp" id="returnDate" type="date" />
          <div class="fb-tile-sub">Second search, same agent</div>
        </div>
        <div class="fb-tile">
          <div class="fb-tile-label">Passengers</div>
          <input class="fb-tile-inp" id="passengers" type="number" min="1" max="9" value="1" />
          <div class="fb-tile-sub">Prices shown for all</div>
        </div>
        <div class="fb-tile">
          <div class="fb-tile-label">Cabin</div>
          <select class="fb-tile-inp" id="cabin">
            <option value="economy">Economy</option>
            <option value="business">Business</option>
          </select>
          <div class="fb-tile-sub">Fares differ per cabin</div>
        </div>
      </div>

      <button class="fb-search-btn" id="search">${SEARCH_ICON}Search flights</button>
    </div>

    <div class="fb-results-head">
      <div class="fb-results-title" id="results-title">No search yet</div>
      <div class="fb-chips" id="chips">
        <button type="button" class="fb-chip active" data-sort="best">Best value</button>
        <button type="button" class="fb-chip" data-sort="cheapest">Cheapest</button>
        <button type="button" class="fb-chip" data-sort="fastest">Fastest</button>
      </div>
    </div>
    <div id="out-list"></div>
    <div id="in-wrap" hidden>
      <div class="fb-results-head"><div class="fb-results-title" id="in-title">Return</div></div>
      <div id="in-list"></div>
    </div>`

  const $ = (id) => el.querySelector(`#${id}`)
  const thread = $('thread')
  const input = $('msg')
  const micBtn = $('mic')
  const sendBtn = $('send')
  const stateEl = $('assist-state')
  const modelEl = $('model')

  // ------------------------------------------------------------------ thread

  function bubble(cls, who, text) {
    const d = document.createElement('div')
    d.className = `turn ${cls}`
    const rtl = isArabic(text) ? ' dir="rtl"' : ''
    d.innerHTML = `<div class="who">${esc(who)}</div><div${rtl}>${esc(text)}</div>`
    thread.appendChild(d)
    thread.scrollTop = thread.scrollHeight
    return d
  }

  const setState = (dot, text) => {
    stateEl.innerHTML = `<span class="fb-dot ${dot}"></span>${esc(text)}`
  }

  // ----------------------------------------------------------------- results

  /** Tags and the highlight are computed, never invented: cheapest is the lowest fare in
   *  the cabin searched, fastest the shortest block time. Every Nile Air flight in the
   *  schedule is nonstop, so there is no stop count to fake. */
  function decorate(flights) {
    const priced = flights.map((f) => cheapestFare(f)?.price.amount ?? Infinity)
    const mins = flights.map((f) => f.duration?.minutes ?? Infinity)
    const cheapIdx = priced.indexOf(Math.min(...priced))
    const fastIdx = mins.indexOf(Math.min(...mins))
    return flights.map((f, i) => {
      const tags = []
      if (i === cheapIdx) tags.push('Cheapest')
      if (i === fastIdx) tags.push('Fastest')
      return { f, tag: tags.join(' · ') }
    })
  }

  function sorted(items) {
    const copy = items.slice()
    if (sort === 'cheapest') {
      copy.sort((a, b) => (cheapestFare(a.f)?.price.amount ?? Infinity)
        - (cheapestFare(b.f)?.price.amount ?? Infinity))
    } else if (sort === 'fastest') {
      copy.sort((a, b) => (a.f.duration?.minutes ?? Infinity) - (b.f.duration?.minutes ?? Infinity))
    }
    // 'best' keeps the order the tool returned, which is departure time.
    return copy
  }

  function cardHtml({ f, tag }, leg, idx, first) {
    const fare = cheapestFare(f)
    const pax = criteria.passengers
    const total = fare ? { amount: fare.price.amount * pax, currency: fare.price.currency } : null
    const seats = f.seats_available
    const badges = [
      seats <= 5 ? `<span class="badge ${seats === 0 ? 'red' : 'yellow'}">${seats} seat${seats === 1 ? '' : 's'} left</span>` : '',
      f.status && f.status !== 'scheduled' ? `<span class="badge yellow">${esc(f.status)}</span>` : '',
      fare?.baggage ? `<span class="badge gray">${esc(fare.baggage.kg)} kg bags</span>` : '',
      fare?.refundable ? '<span class="badge green">refundable</span>' : '<span class="badge gray">non-refundable</span>',
    ].filter(Boolean).join('')

    return `
      <div class="fb-card${first ? ' top' : ''}" data-leg="${leg}" data-idx="${idx}">
        ${tag ? `<div class="fb-tag">${esc(tag)}</div>` : ''}
        <div class="fb-airline">
          <div class="fb-logo">NA</div>
          <div>
            <div class="fb-airline-name">Nile Air</div>
            <div class="fb-airline-no">${esc(f.flight_no.code)}</div>
          </div>
        </div>
        <div class="fb-route">
          <div class="fb-point">
            <div class="fb-clock">${esc(hhmm(f.departs.iso))}</div>
            <div class="fb-iata">${esc(f.origin.iata)}</div>
          </div>
          <div class="fb-leg">
            <div class="fb-dur">${esc(hm(f.duration?.minutes))}</div>
            <div class="fb-line"><i></i>${icons.plane}<i></i></div>
            <div class="fb-stops">Nonstop</div>
          </div>
          <div class="fb-point">
            <div class="fb-clock">${esc(hhmm(f.arrives.iso))}</div>
            <div class="fb-iata">${esc(f.destination.iata)}</div>
          </div>
        </div>
        <div class="fb-price">
          <div class="fb-amount">${esc(money(total))}</div>
          <div class="fb-per">${pax > 1 ? `${esc(money(fare?.price))} × ${pax} · ` : ''}${esc(fare?.fare_class || criteria.cabin)}</div>
          <button type="button" class="btn primary fb-select">Select</button>
        </div>
        <div class="fb-meta">${esc(f.date.iso)} · ${badges}</div>
        <div class="fb-book" hidden></div>
      </div>`
  }

  function emptyHtml(result) {
    const alts = (result.alternative_dates || [])
      .map((d) => `<button type="button" class="fb-chip alt" data-date="${esc(d.iso)}">${esc(dayLabel(d.iso))}</button>`)
      .join('')
    return `
      <div class="card fb-empty">
        <div class="fb-empty-msg">${esc(result.message_en || 'No flights on that date.')}</div>
        ${alts ? `<div class="fb-empty-sub">Nearest departures the agent found:</div>
                  <div class="fb-chips">${alts}</div>` : ''}
      </div>`
  }

  function renderLeg(leg) {
    const wrap = leg === 'out' ? $('out-list') : $('in-list')
    const state = legs[leg]
    if (!state) { wrap.innerHTML = ''; return }
    const { result } = state
    if (!result.flights?.length) { wrap.innerHTML = emptyHtml(result); return }

    const items = sorted(decorate(result.flights))
    wrap.innerHTML = items.map((it, i) => cardHtml(it, leg, result.flights.indexOf(it.f), i === 0)).join('')
  }

  function renderResults() {
    const out = legs.out
    const title = $('results-title')
    if (!out) {
      title.textContent = 'No search yet'
    } else if (!out.result.flights?.length) {
      title.textContent = 'No flights on that date'
    } else {
      const n = out.result.flights.length
      const total = out.result.total_found ?? n
      const f0 = out.result.flights[0]
      // The tool caps what it returns (3 for a day, 8 for a range) because the same result
      // is read aloud on a call. Say so rather than implying the schedule is that thin.
      const capped = total > n ? ` · showing ${n} of ${total}` : ''
      title.innerHTML = `${n} flight${n === 1 ? '' : 's'} found `
        + `<span class="fb-results-sub">· ${esc(f0.origin.city_en)} → ${esc(f0.destination.city_en)}${capped}</span>`
    }
    renderLeg('out')

    const inWrap = $('in-wrap')
    inWrap.hidden = !legs.in
    if (legs.in) {
      const f0 = legs.in.result.flights?.[0]
      $('in-title').innerHTML = 'Return '
        + (f0 ? `<span class="fb-results-sub">· ${esc(f0.origin.city_en)} → ${esc(f0.destination.city_en)}</span>` : '')
      renderLeg('in')
    }
  }

  // ------------------------------------------------------- criteria <-> form

  function readForm() {
    criteria.origin = $('origin').value.trim() || 'CAI'
    criteria.destination = $('destination').value.trim() || 'DXB'
    criteria.departDate = $('departDate').value || today()
    criteria.departTo = $('range').hidden ? '' : $('departTo').value
    criteria.returnDate = $('returnDate').value
    criteria.passengers = Math.min(9, Math.max(1, Number($('passengers').value) || 1))
    criteria.cabin = $('cabin').value
  }

  function writeForm() {
    $('origin').value = criteria.origin
    $('destination').value = criteria.destination
    $('departDate').value = criteria.departDate
    $('departTo').value = criteria.departTo
    $('range').hidden = !criteria.departTo
    $('returnDate').value = criteria.returnDate
    $('passengers').value = criteria.passengers
    $('cabin').value = criteria.cabin
    const oneway = criteria.trip !== 'round'
    $('return-tile').hidden = oneway
    el.querySelector('.fb-grid-4').classList.toggle('oneway', oneway)
    el.querySelectorAll('.fb-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.trip === criteria.trip))
  }

  /** Turn the panel into the sentence a caller would say. The agent resolves the airports
   *  ("Cairo", "القاهرة", "CAI" all work) and picks the tool — we do not pre-resolve. */
  function composeSearch() {
    const { origin, destination, departDate, departTo, returnDate, passengers, cabin } = criteria
    const when = departTo
      ? `sometime between ${departDate} and ${departTo}`
      : `on ${departDate}`
    const who = passengers > 1 ? ` for ${passengers} passengers` : ''
    let msg = `Find flights from ${origin} to ${destination} ${when} in ${cabin}${who}.`
    if (criteria.trip === 'round' && returnDate) {
      msg += ` Also find the return from ${destination} to ${origin} on ${returnDate} in ${cabin}.`
    }
    return msg
  }

  /** Pull `search_flights` out of the tool trace and file each result under a leg.
   *  Returns true if the results area changed. */
  function applyToolCalls(toolCalls) {
    const searches = (toolCalls || []).filter((t) => t.name === 'search_flights' && t.result)
    if (!searches.length) return false

    const pairOf = (s) => {
      const f = s.result.flights?.[0]
      if (f) return `${f.origin.iata}>${f.destination.iata}`
      const a = s.args || {}
      return `${String(a.origin || '').toUpperCase()}>${String(a.destination || '').toUpperCase()}`
    }
    const reverse = (p) => p.split('>').reverse().join('>')

    if (searches.length >= 2) {
      // A round-trip turn: the agent searches the outbound first, then the return.
      legs.out = { result: searches[0].result, args: searches[0].args || {} }
      legs.in = { result: searches[1].result, args: searches[1].args || {} }
    } else {
      const s = searches[0]
      const isReturnLeg = legs.out && pairOf(s) === reverse(pairOf(legs.out))
      if (isReturnLeg) legs.in = { result: s.result, args: s.args || {} }
      else {
        legs.out = { result: s.result, args: s.args || {} }
        // A new outbound route invalidates the return we were showing.
        if (legs.in && pairOf({ result: legs.in.result, args: legs.in.args })
            !== reverse(pairOf(legs.out))) legs.in = null
      }
    }

    // Reflect what the agent actually asked for back into the panel, so "make it the 20th
    // instead" visibly moves the date field rather than leaving a stale form on screen.
    const a = legs.out.args || {}
    if (a.origin) criteria.origin = a.origin
    if (a.destination) criteria.destination = a.destination
    if (a.depart_date) criteria.departDate = a.depart_date
    criteria.departTo = a.depart_date_to || ''
    if (a.cabin) criteria.cabin = a.cabin
    if (legs.in?.args?.depart_date) {
      criteria.returnDate = legs.in.args.depart_date
      criteria.trip = 'round'
    }
    writeForm()
    return true
  }

  // -------------------------------------------------------------- agent turn

  // `language` is the tag STT returned for a spoken turn; it pins the reply language so an
  // English caller is not answered in Arabic. Typed turns pass nothing and the server
  // infers it from the script.
  async function send(text, { voice = false, language } = {}) {
    if (busy || !text) return
    busy = true
    sendBtn.disabled = micBtn.disabled = true
    bubble('user', voice ? 'you · voice' : 'you', text)
    input.value = ''
    setState('busy', 'Thinking…')
    try {
      const r = await pod.chat(text, history, language)
      modelEl.textContent = r.model || ''
      for (const tc of (r.tool_calls || [])) bubble('tool', 'tool call', traceLine(tc))
      if (r.text) bubble('bot', 'agent', r.text)
      history.push({ role: 'user', content: text })
      if (r.text) history.push({ role: 'assistant', content: r.text })
      if (applyToolCalls(r.tool_calls)) renderResults()
      setState('', 'Ready · voice & text')
    } catch (ex) {
      // A 500 here is almost always "vLLM is not listening yet", not a bug — ask the
      // control tier what is happening rather than showing the caller a bare status code.
      bubble('tool', 'error', await explainAgentFailure(ex))
      setState('err', 'Error — see the thread')
    } finally {
      busy = false
      sendBtn.disabled = micBtn.disabled = false
      input.focus()
    }
  }

  // -------------------------------------------------------------- push to talk

  // The recording meter. Bars scroll right-to-left as levels arrive, so it reads as a
  // waveform being drawn rather than a decorative loop — and it goes flat when the mic
  // hears nothing, which is exactly when someone needs to be told.
  const WAVE_BARS = 44
  const waveEl = $('wave')
  waveEl.innerHTML = Array.from({ length: WAVE_BARS }, () => '<i></i>').join('')
  const bars = [...waveEl.querySelectorAll('i')]
  const levels = new Array(WAVE_BARS).fill(0)

  function pushLevel(v) {
    levels.push(v)
    levels.shift()
    for (let i = 0; i < WAVE_BARS; i++) {
      // Fade the oldest samples out at the left edge so the trail recedes.
      const age = i / WAVE_BARS
      bars[i].style.transform = `scaleY(${Math.max(0.16, levels[i])})`
      bars[i].style.opacity = String(0.35 + age * 0.65)
    }
  }

  function showWave(on) {
    waveEl.hidden = !on
    input.hidden = on
    micBtn.classList.toggle('rec', on)
    if (!on) {
      levels.fill(0)
      bars.forEach((b) => { b.style.transform = 'scaleY(0.16)'; b.style.opacity = '0.4' })
    }
  }

  async function toggleMic() {
    if (ptt) {
      const rec = ptt
      ptt = null
      showWave(false)
      const pcm = rec.stop()
      if (!pcm.length) { setState('', 'Ready · voice & text'); return }
      setState('busy', 'Transcribing…')
      micBtn.disabled = true
      try {
        const { text, language } = await pod.transcribe(pcm)
        if (!text?.trim()) { setState('', 'Nothing heard — try again'); return }
        input.value = text
        await send(text, { voice: true, language })
      } catch (ex) {
        if (ex.status === 404) {
          // The pod predates /api/control/stt; it re-clones the app on boot, so a restart
          // is the fix. Say that instead of leaving a button that always fails.
          micBtn.disabled = true
          micBtn.title = 'This pod has no STT route yet — restart it in the Pod view'
          bubble('tool', 'error', 'Voice input needs a pod restart (STT route not deployed).')
        } else {
          bubble('tool', 'error', `transcription failed: ${ex.message}`)
        }
        setState('err', 'Voice unavailable')
      } finally {
        if (!micBtn.title.includes('restart')) micBtn.disabled = false
      }
      return
    }
    try {
      ptt = new PushToTalk({ onLevel: pushLevel })
      await ptt.start()
      showWave(true)
      setState('rec', 'Listening — click the mic again to stop')
    } catch (ex) {
      ptt = null
      showWave(false)
      bubble('tool', 'error', `microphone failed: ${ex.message}`)
    }
  }

  // ------------------------------------------------------------ inline booking

  function bookPanelHtml(f) {
    const fare = cheapestFare(f)
    return `
      <div class="fb-book-row">
        <input class="inp" data-f="given" placeholder="Given name" />
        <input class="inp" data-f="surname" placeholder="Surname" />
        <button type="button" class="btn primary" data-a="confirm">
          Confirm · ${esc(money(fare?.price))} ${esc(criteria.cabin)}
        </button>
        <button type="button" class="btn ghost" data-a="cancel">Cancel</button>
      </div>
      <div class="login-err" data-f="err"></div>`
  }

  async function confirmBooking(card, f) {
    const panel = card.querySelector('.fb-book')
    const given = panel.querySelector('[data-f=given]').value.trim()
    const surname = panel.querySelector('[data-f=surname]').value.trim()
    const err = panel.querySelector('[data-f=err]')
    err.textContent = ''
    if (!given || !surname) { err.textContent = 'Both names are required'; return }

    const btn = panel.querySelector('[data-a=confirm]')
    btn.disabled = true
    try {
      const b = await pod.book({
        flight_no: f.flight_no.code,
        depart_date: f.date.iso,
        given_name: given,
        surname,
        cabin: criteria.cabin,
      })
      panel.innerHTML = `
        <div class="fb-pnr">
          <div class="fb-pnr-label">Booking reference</div>
          <div class="fb-pnr-code">${esc(b.pnr.code)}</div>
          <div class="fb-pnr-sub">${esc(b.passenger_name)} · ${esc(b.flight.flight_no.code)}
            · ${esc(money(b.total_charged))} · look it up with this PNR + surname
            in Bookings, or ask the agent above.</div>
        </div>`
      card.classList.add('booked')
    } catch (ex) {
      // A domain refusal (sold out, cancelled flight) comes back as a 400 with the same
      // sentence the agent would say on the phone.
      err.textContent = ex.message
      btn.disabled = false
    }
  }

  // ------------------------------------------------------------------- wiring

  el.querySelector('#compose').addEventListener('submit', (e) => {
    e.preventDefault()
    send(input.value.trim())
  })
  micBtn.addEventListener('click', toggleMic)

  $('trip').addEventListener('click', (e) => {
    const t = e.target.closest('.fb-tab')
    if (!t) return
    criteria.trip = t.dataset.trip
    if (criteria.trip === 'oneway') { criteria.returnDate = ''; legs.in = null; renderResults() }
    writeForm()
  })

  $('swap').addEventListener('click', () => {
    readForm()
    const o = criteria.origin
    criteria.origin = criteria.destination
    criteria.destination = o
    writeForm()
  })

  $('range-toggle').addEventListener('click', () => {
    const r = $('range')
    r.hidden = !r.hidden
    if (r.hidden) $('departTo').value = ''
  })

  $('search').addEventListener('click', () => {
    readForm()
    send(composeSearch())
  })

  $('chips').addEventListener('click', (e) => {
    const c = e.target.closest('.fb-chip')
    if (!c) return
    sort = c.dataset.sort
    el.querySelectorAll('#chips .fb-chip').forEach((x) =>
      x.classList.toggle('active', x.dataset.sort === sort))
    renderResults()
  })

  // Passenger count only changes the arithmetic on the cards — no new search needed.
  $('passengers').addEventListener('change', () => { readForm(); renderResults() })

  // Card actions (Select / Confirm / Cancel) and the empty-state date chips, delegated so
  // they survive every re-render.
  el.addEventListener('click', (e) => {
    const alt = e.target.closest('.fb-chip.alt')
    if (alt) {
      criteria.departDate = alt.dataset.date
      writeForm()
      send(`What about ${alt.dataset.date}?`)
      return
    }
    const card = e.target.closest('.fb-card')
    if (!card) return
    const leg = legs[card.dataset.leg]
    const f = leg?.result.flights?.[Number(card.dataset.idx)]
    if (!f) return
    const panel = card.querySelector('.fb-book')

    if (e.target.closest('.fb-select')) {
      panel.hidden = !panel.hidden
      if (!panel.hidden && !panel.innerHTML.trim()) panel.innerHTML = bookPanelHtml(f)
    } else if (e.target.closest('[data-a=cancel]')) {
      panel.hidden = true
    } else if (e.target.closest('[data-a=confirm]')) {
      confirmBooking(card, f)
    }
  })

  // ------------------------------------------------------------------- mount

  writeForm()
  bubble('bot', 'agent', 'Hi! Where would you like to fly, and when? '
    + 'You can type, or use the mic and speak Egyptian Arabic or English.')

  // Seed the depart date from the live schedule so the first Search lands on a day that
  // actually has service. Read-only and cosmetic — the results themselves still come
  // exclusively from the agent's tool calls. If the pod is down, today's date stands and
  // the empty-state path (with the agent's own alternative dates) takes over.
  pod.listFlights({ origin: criteria.origin, destination: criteria.destination })
    .then(({ flights }) => {
      const next = flights.find((f) => f.depart_date >= today()) || flights[0]
      if (next && !history.length) {
        criteria.departDate = next.depart_date
        writeForm()
      }
    })
    .catch(() => {})

  return { el, cleanup: () => { try { ptt?.stop() } catch {} } }
}
