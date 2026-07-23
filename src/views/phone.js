// Phone Calls: the Twilio line's live calls, human takeover, and call history.
//
// Everything here talks to the EC2 telephony bridge (lib/api.js `phone`), which is where the
// call registry and history live — the pod is ephemeral, the phone line is not. Live calls
// stream over SSE (same pattern as views/models.js); takeover reuses VoiceCall (lib/audio.js)
// verbatim, pointed at the operator socket. The transcript/tool renderer is shared between
// the live feed and the history detail, so a call reads the same whether it is in flight or
// three days old.
import { phone } from '../lib/api.js'
import { VoiceCall } from '../lib/audio.js'

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const isAr = (t) => /[؀-ۿ]/.test(t || '')

const STATUS_BADGE = { in_progress: 'yellow', completed: 'green', failed: 'red' }

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function fmtDuration(s) {
  if (s == null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m ? `${m}m ${sec}s` : `${sec}s`
}

// A stored call_event -> the same frame shape the SSE feed emits, so one renderer serves the
// live feed and the history detail. Mirrors control/telephony.py::_event_to_frame.
function eventToFrame(e) {
  if (e.kind === 'transcript') return { type: 'transcript', role: e.role, text: e.text, turn: e.turn, final: true }
  if (e.kind === 'tool_call') return { type: 'tool_call', name: e.tool_name, args: e.tool_args || {} }
  if (e.kind === 'tool_result') return { type: 'tool_result', name: e.tool_name, args: e.tool_args || {}, result: e.tool_result }
  return { type: 'system', text: e.text }
}

// Shared transcript + tool-call renderer. Streaming assistant turns (several frames sharing
// one `turn`, last flagged final) rewrite one bubble, exactly as views/demo.js does.
function makeTranscript(container) {
  let botTurn = null
  const add = (cls, who, html) => {
    const d = document.createElement('div')
    d.className = `turn ${cls}`
    d.innerHTML = `<div class="who">${esc(who)}</div>${html}`
    container.appendChild(d)
    container.scrollTop = container.scrollHeight
    return d
  }
  const body = (text) => `<div${isAr(text) ? ' dir="rtl"' : ''}>${esc(text)}</div>`

  const addBot = (m) => {
    const id = m.turn ?? 'single'
    if (!botTurn || botTurn.id !== id) {
      botTurn = { id, el: add('bot', `agent · ${m.language || ''}`, body(m.text)) }
    } else {
      const b = botTurn.el.lastElementChild
      b.textContent = m.text
      if (isAr(m.text)) b.setAttribute('dir', 'rtl')
      container.scrollTop = container.scrollHeight
    }
    botTurn.el.classList.toggle('streaming', !m.final)
    if (m.final) botTurn = null
  }

  const addTool = (m, done) => {
    const args = esc(JSON.stringify(m.args || {}))
    if (!done) { add('tool', 'tool', `<div class="mono">${esc(m.name)}(${args})</div>`); return }
    // A result: show the call and let the operator expand the payload (flight cards, PNRs).
    const d = add('tool', 'tool · result', `
      <details><summary class="mono">${esc(m.name)}(${args})</summary>
        <pre class="log" style="margin-top:8px">${esc(JSON.stringify(m.result, null, 2))}</pre>
      </details>`)
    return d
  }

  return {
    push(m) {
      if (m.type === 'transcript') {
        if (m.role === 'assistant') addBot(m)
        else add('user', `caller · ${m.language || ''}`, body(m.text))
      } else if (m.type === 'tool_call') addTool(m, false)
      else if (m.type === 'tool_result') addTool(m, true)
      else if (m.type === 'system') add('tool', 'system', `<div class="muted">${esc(m.text)}</div>`)
      else if (m.type === 'error') add('tool', 'error', `<div class="muted">${esc(m.error || m.text)}</div>`)
    },
    clear() { container.innerHTML = ''; botTurn = null },
  }
}

export function renderPhoneCalls() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">Phone Line</div>
        <div class="card-meta" id="number">—</div>
      </div>
      <div class="stat-sub" id="number-note">Callers dial this number and reach the live voice agent.</div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row" id="tabs" style="gap:8px;margin-bottom:14px">
        <button class="btn primary" data-tab="live">Live Calls</button>
        <button class="btn" data-tab="history">Call History</button>
      </div>
      <div id="body"></div>
    </div>`

  const body = el.querySelector('#body')
  const tabs = el.querySelector('#tabs')

  // Teardown handles for whatever the current tab opened.
  let es = null           // live SSE
  let call = null         // operator VoiceCall
  let timer = null        // live-list poll

  function teardown() {
    if (es) { es.close(); es = null }
    if (call) { call.stop(); call = null }
    if (timer) { clearInterval(timer); timer = null }
  }

  phone.config().then((c) => {
    el.querySelector('#number').textContent = c.number || 'not configured'
    if (!c.configured) el.querySelector('#number-note').textContent =
      'No number provisioned yet — run deploy.twilio_provision and set the .env values.'
  }).catch(() => { el.querySelector('#number').textContent = 'unavailable' })

  // ------------------------------------------------------------------ live tab

  function renderLive() {
    teardown()
    body.innerHTML = `
      <div class="grid grid-2" style="gap:16px;align-items:start">
        <div>
          <div class="stat-label">Active calls</div>
          <div id="live-list" class="muted" style="margin-top:8px">Loading…</div>
        </div>
        <div id="live-detail" class="muted">Select a live call to watch it.</div>
      </div>`
    const listEl = body.querySelector('#live-list')

    async function poll() {
      try {
        const { calls } = await phone.live()
        if (!calls.length) { listEl.innerHTML = '<div class="stat-sub">No calls in progress.</div>'; return }
        listEl.innerHTML = calls.map((c) => `
          <button class="btn" data-sid="${esc(c.call_sid)}" style="display:block;width:100%;text-align:left;margin-bottom:8px">
            <b>${esc(c.from_number || 'unknown')}</b>
            <span class="badge ${c.mode === 'human' ? 'blue' : 'green'}">${c.mode === 'human' ? 'human' : 'AI'}</span>
            <div class="stat-sub">${esc(c.provider || '')}</div>
          </button>`).join('')
        listEl.querySelectorAll('[data-sid]').forEach((b) =>
          b.addEventListener('click', () => openLive(b.dataset.sid, calls.find((c) => c.call_sid === b.dataset.sid))))
      } catch (e) { listEl.innerHTML = `<div class="login-err">${esc(e.message)}</div>` }
    }
    poll()
    timer = setInterval(poll, 3000)
  }

  function openLive(sid, meta) {
    if (es) { es.close(); es = null }
    if (call) { call.stop(); call = null }
    const detail = body.querySelector('#live-detail')
    detail.classList.remove('muted')
    detail.innerHTML = `
      <div class="card-head" style="margin-bottom:8px">
        <div class="card-title" style="font-size:15px">${esc(meta?.from_number || sid)}</div>
        <div class="row" style="gap:8px">
          <button class="btn" id="takeover">Take over</button>
          <button class="btn ghost" id="hangup">Hang up</button>
        </div>
      </div>
      <div class="stat-sub" id="live-state" style="margin-bottom:8px">watching…</div>
      <div class="transcript" id="live-transcript" style="max-height:420px"></div>`

    const tr = makeTranscript(detail.querySelector('#live-transcript'))
    const stateEl = detail.querySelector('#live-state')

    es = new EventSource(phone.eventsUrl(sid))
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.type === 'call_ended') { stateEl.textContent = 'call ended'; es?.close(); es = null; return }
      if (m.type === 'system' && /took over/i.test(m.text || '')) stateEl.textContent = 'human agent connected'
      tr.push(m)
    }
    es.onerror = () => { /* EventSource retries automatically */ }

    detail.querySelector('#takeover').addEventListener('click', async (e) => {
      e.target.disabled = true
      e.target.textContent = 'connecting mic…'
      try {
        // Opening the operator socket IS the takeover: the bridge drops the AI and routes the
        // caller to/from this browser. VoiceCall handles mic capture (16k up) and playback
        // (24k down) unchanged — the operator socket speaks the same wire as the pod's /ws.
        call = new VoiceCall(phone.operatorWsUrl(sid), {
          onState: (s) => { stateEl.textContent = `you are on the call · ${s}` },
          onError: (err) => { stateEl.textContent = `mic error: ${err}` },
        })
        await call.start()
        e.target.textContent = 'you have the call'
      } catch (err) {
        e.target.disabled = false
        e.target.textContent = 'Take over'
        stateEl.textContent = `could not take over: ${err.message}`
      }
    })
    detail.querySelector('#hangup').addEventListener('click', async (e) => {
      e.target.disabled = true
      try { await phone.hangup(sid) } catch (err) { stateEl.textContent = err.message }
    })
  }

  // --------------------------------------------------------------- history tab

  function renderHistory() {
    teardown()
    body.innerHTML = `<div id="hist-wrap" style="overflow-x:auto" class="muted">Loading…</div>
                      <div id="hist-detail" style="margin-top:16px"></div>`
    const wrap = body.querySelector('#hist-wrap')
    const detail = body.querySelector('#hist-detail')

    phone.calls().then(({ calls }) => {
      if (!calls.length) { wrap.innerHTML = '<div class="stat-sub" style="padding:12px">No calls yet.</div>'; return }
      wrap.classList.remove('muted')
      wrap.innerHTML = `<table class="tbl">
        <thead><tr><th>Started</th><th>From</th><th>Provider</th><th>Duration</th><th>Handled by</th><th>Status</th></tr></thead>
        <tbody>${calls.map((c) => `
          <tr class="call-row" data-sid="${esc(c.call_sid)}" style="cursor:pointer">
            <td>${esc(fmtTime(c.started_at))}</td>
            <td>${esc(c.from_number || 'unknown')}</td>
            <td class="mono">${esc(c.provider || '—')}</td>
            <td>${esc(fmtDuration(c.duration_s))}</td>
            <td>${c.took_over ? '<span class="badge blue">human</span>' : '<span class="badge">AI</span>'}</td>
            <td><span class="badge ${STATUS_BADGE[c.status] || 'gray'}">${esc(c.status || '—')}</span></td>
          </tr>`).join('')}</tbody></table>`
      wrap.querySelectorAll('.call-row').forEach((tr) =>
        tr.addEventListener('click', () => openDetail(tr.dataset.sid, detail)))
    }).catch((e) => { wrap.innerHTML = `<div class="login-err">${esc(e.message)}</div>` })
  }

  async function openDetail(sid, detail) {
    detail.innerHTML = '<div class="muted" style="padding:12px">Loading transcript…</div>'
    try {
      const c = await phone.call(sid)
      detail.innerHTML = `
        <div class="card" style="background:var(--bg-2, #fafafa)">
          <div class="card-head">
            <div class="card-title" style="font-size:15px">${esc(c.from_number || sid)} → ${esc(c.to_number || '')}</div>
            <div class="card-meta">${esc(c.provider || '')} · ${esc(fmtDuration(c.duration_s))}
              ${c.took_over ? '· <span class="badge blue">human takeover</span>' : ''}</div>
          </div>
          <div class="transcript" id="detail-transcript" style="max-height:460px"></div>
        </div>`
      const tr = makeTranscript(detail.querySelector('#detail-transcript'))
      if (!c.events?.length) detail.querySelector('#detail-transcript').innerHTML =
        '<div class="stat-sub" style="padding:12px">No transcript captured.</div>'
      c.events?.forEach((e) => tr.push(eventToFrame(e)))
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (e) { detail.innerHTML = `<div class="login-err">${esc(e.message)}</div>` }
  }

  // ------------------------------------------------------------------- wiring

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]')
    if (!btn) return
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('primary', b === btn))
    if (btn.dataset.tab === 'live') renderLive()
    else renderHistory()
  })

  renderLive()
  return { el, cleanup: teardown }
}
