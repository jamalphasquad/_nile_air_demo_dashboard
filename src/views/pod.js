// Pod lifecycle: start / stop / status, cost display, the "no capacity" state made loud.
//
// One card PER PROVIDER, in the order /stacks returns them. Two are GPU pods — the H100 and
// the cheaper Qwen 3.5-9B — and either, both, or neither can be running. Each pod card owns
// its own status poll, capacity badge and start-retry loop, so a stalled probe on one cannot
// freeze the other. The radio on every card picks which provider the Models / Prompt / KB /
// Chat / Voice views talk to.
//
// The LAST card is the cloud realtime provider, and it is a genuinely different thing rather
// than a pod with the buttons greyed out: nothing to start, no GPU to win from a datacenter,
// no keep-alive clock, no hourly cost. Drawing it with the same controls disabled would
// imply it has a lifecycle it does not have, so `cloudCard` renders what is actually true
// about it — where it runs, what it costs, and whether the key is configured.
import { ec2, pod, currentStack, setCurrentStack } from '../lib/api.js'

const badge = (state) => {
  const map = { RUNNING: 'green', EXITED: 'gray', TERMINATED: 'red', none: 'gray' }
  return `<span class="badge ${map[state] || 'yellow'}">${state}</span>`
}

// Map RunPod's SECURE-cloud stock signal to a colour + plain-language recommendation.
// Crucially, "Low" means limited-but-AVAILABLE (a GPU is rentable right now) — not
// "unavailable" — which is why the RunPod console can show the card as available while
// the status reads Low. Any non-"none" status = you can start; only "none" = come back.
// Keep-alive choices. The server owns the real bounds (deploy/keepalive.py) and sends them
// with every status, so this list is filtered against them rather than being a second
// source of truth that drifts.
const KA_CHOICES = [
  [0.25, '15 min'], [0.5, '30 min'], [1, '1 hour'], [2, '2 hours'], [3, '3 hours'],
  [4, '4 hours'], [6, '6 hours'], [8, '8 hours'], [12, '12 hours'],
]
// What a pod that has never been set gets. Only used to pre-select the dropdown before any
// pod exists; every live number comes from the server.
const KA_DEFAULT = 1

const hhmm = (secs) => {
  const s = Math.max(0, Math.round(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`
}

const CAP = {
  High: ['green', 'plenty of stock — start away'],
  Medium: ['green', 'available — start away'],
  Low: ['blue', 'available (limited stock) — a start should work now; may occasionally need a quick auto-retry'],
  none: ['red', 'no GPU free right now — better to come back in a bit'],
  unknown: ['gray', 'could not read capacity'],
}

// One stack's card. Returns { el, cleanup } so the view can tear down its timers.
function podCard(stack, onSelect) {
  const el = document.createElement('div')
  el.className = 'card'
  el.innerHTML = `
    <div class="card-head">
      <div class="card-title">${stack.label}</div>
      <div class="card-meta" id="cost">—</div>
    </div>
    <div class="row" style="margin:2px 0 10px;gap:8px;align-items:center">
      <label class="row" style="gap:6px;align-items:center;cursor:pointer">
        <input type="radio" name="stack-select" id="sel" ${stack.id === currentStack() ? 'checked' : ''}>
        <span class="card-meta">Control this stack</span>
      </label>
      <div class="spacer"></div>
      <span class="card-meta mono">${stack.gpu}${stack.gpu_vram_gb ? ` · ${stack.gpu_vram_gb}GB` : ''} · ${stack.datacenter}</span>
    </div>
    <div id="cap" class="row" style="margin:2px 0 14px;gap:8px;align-items:center">
      <span class="card-meta">GPU capacity</span>
      <span id="cap-badge" class="badge gray">checking…</span>
      <span class="card-meta" id="cap-hint"></span>
    </div>
    <div id="body" class="muted">Loading…</div>
    <div id="ka" class="row" style="margin-top:14px;gap:8px;align-items:center">
      <span class="card-meta">Auto-stop in</span>
      <span id="ka-left" class="badge gray">—</span>
      <select id="ka-hours" class="btn"></select>
      <button class="btn" id="ka-set">Set</button>
      <span class="stat-sub" id="ka-note"></span>
    </div>
    <div class="row" style="margin-top:18px">
      <button class="btn primary" id="start">Start pod</button>
      <button class="btn" id="restart">Restart pod</button>
      <button class="btn danger" id="stop">Stop pod</button>
      <div class="spacer"></div>
      <button class="btn ghost" id="refresh">Refresh</button>
    </div>
    <div class="stat-sub" style="margin-top:8px">Restart reboots the same pod and picks up
      the latest code — use it after a push. Stop then Start replaces the pod, which means
      winning a GPU back from the datacenter.</div>
    <div class="login-err" id="err"></div>`

  const body = el.querySelector('#body')
  const cost = el.querySelector('#cost')
  const err = el.querySelector('#err')
  const capBadge = el.querySelector('#cap-badge')
  const capHint = el.querySelector('#cap-hint')
  const ka = el.querySelector('#ka')
  const kaLeft = el.querySelector('#ka-left')
  const kaHours = el.querySelector('#ka-hours')
  const kaNote = el.querySelector('#ka-note')
  let startAbort = false   // set true to cancel an in-progress start-retry loop

  // Deadline in the BROWSER's clock, derived from the server's remaining_s at each poll.
  // Deliberately not the server's absolute expires_at: the two clocks differ by however far
  // this laptop has drifted, and a countdown that reads "-4m" because of NTP is worse than
  // no countdown. remaining_s is a duration, which survives the translation.
  let kaDeadline = null
  let kaChosen = null     // what the operator has selected but not yet applied

  function renderKa() {
    if (kaDeadline === null) { kaLeft.className = 'badge gray'; kaLeft.textContent = '—'; return }
    const left = (kaDeadline - Date.now()) / 1000
    // The cron switch runs every 5 minutes, so "0" means "any moment now", not "already
    // gone" — say so instead of showing a countdown stuck at 0m 00s.
    kaLeft.textContent = left <= 0 ? 'due — stopping shortly' : hhmm(left)
    kaLeft.className = `badge ${left <= 300 ? 'red' : left <= 900 ? 'yellow' : 'green'}`
  }

  // Fill the dropdown once, filtered to the range the server actually accepts.
  function fillKaChoices(k) {
    if (kaHours.options.length) return
    const min = k.min_hours ?? 0.25
    const max = k.max_hours ?? 12
    for (const [h, label] of KA_CHOICES) {
      if (h < min || h > max) continue
      kaHours.add(new Option(label, String(h)))
    }
  }

  // The row is ALWAYS rendered — a control that vanishes reads as a missing feature, and
  // this one's absence on a stack with no pod is exactly what it looked like. It is instead
  // disabled with the reason, because the three states differ in what Set would even mean:
  //
  //   running  the dial is live; Set gives it that long from now.
  //   stopped  the budget is keyed to a pod that is not billing, and start/restart set it
  //            again anyway — so Set here would appear to work and then be overwritten.
  //   no pod   there is nothing to key a budget to; the next pod starts on the default.
  function updateKa(k, state) {
    const running = state === 'RUNNING'
    fillKaChoices(k || {})
    kaHours.disabled = !running
    kaSet.disabled = !running
    if (!k) {
      kaDeadline = null
      kaHours.value = String(KA_DEFAULT)
      kaNote.textContent = `no pod — a new one starts on the default ${KA_DEFAULT}h`
      renderKa()
      return
    }
    kaDeadline = !running || k.remaining_s === null || k.remaining_s === undefined
      ? null
      : Date.now() + k.remaining_s * 1000
    // Don't stomp a selection the operator is mid-way through making — the 8s status poll
    // would otherwise yank the dropdown back while they are reaching for Set.
    if (kaChosen === null) kaHours.value = String(k.hours)
    kaNote.textContent = !running
      ? `pod is ${(state || 'not running').toLowerCase()} — the clock starts when it does`
      : k.source === 'default'
        ? `default ${k.hours}h (never set for this pod)`
        : ''
    renderKa()
  }

  const kaSet = el.querySelector('#ka-set')
  kaSet.addEventListener('click', async (ev) => {
    const btn = ev.target
    btn.disabled = true
    err.textContent = ''
    try {
      const k = await ec2.setKeepalive(Number(kaHours.value), stack.id)
      kaChosen = null
      updateKa(k, 'RUNNING')   // the button is only enabled while it is
    } catch (e) { err.textContent = e.message }
    finally { btn.disabled = false }
  })
  kaHours.addEventListener('change', () => { kaChosen = kaHours.value })

  async function loadCapacity() {
    try {
      const c = await ec2.capacity(stack.id)
      const [colour, hint] = CAP[c.stock_status] || CAP.unknown
      const price = c.price_per_hr ? ` · $${c.price_per_hr}/hr` : ''
      capBadge.className = `badge ${colour}`
      capBadge.textContent = `${c.datacenter} · ${c.stock_status}${price}`
      capHint.textContent = hint
    } catch (e) {
      capBadge.className = 'badge gray'
      capBadge.textContent = 'unavailable'
      capHint.textContent = e.message
    }
  }

  async function refresh() {
    err.textContent = ''
    try {
      const s = await ec2.status(stack.id)
      if (!s.exists) {
        body.innerHTML = `<div class="muted">No pod. Click <b>Start pod</b> to provision
          the ${stack.gpu} (~$${stack.hourly_usd}/hr).</div>`
        cost.textContent = ''
        updateKa(null, 'none')   // shown but disabled, with the reason
        return
      }
      cost.textContent = s.cost_per_hr ? `$${s.cost_per_hr}/hr` : ''
      updateKa(s.keepalive, s.state)
      body.innerHTML = `
        <table class="tbl">
          <tr><th>State</th><td>${badge(s.state)}</td></tr>
          <tr><th>Pod ID</th><td class="mono">${s.id || '—'}</td></tr>
          <tr><th>IP</th><td class="mono">${s.ip || '—'}</td></tr>
          <tr><th>Audio port</th><td class="mono">${s.audio_port || '—'}</td></tr>
          <tr><th>Domain</th><td class="mono">${s.fqdn || '—'}</td></tr>
          <tr><th>Model</th><td class="mono">${stack.default_model}</td></tr>
        </table>`
    } catch (e) { err.textContent = e.message }
  }

  const startBtn = el.querySelector('#start')

  // GPU capacity in the (volume-locked) datacenter is intermittent, so a single Start often
  // 503s with "no instances currently available". Instead of failing, keep retrying
  // automatically until one frees — the same thing that otherwise has to be done by hand.
  // The button doubles as Cancel while retrying.
  async function startWithRetry() {
    startAbort = false
    err.textContent = ''
    let attempt = 0
    while (!startAbort) {
      attempt += 1
      startBtn.textContent = attempt === 1 ? 'Starting…' : `Retrying ${attempt} — click to cancel`
      try {
        await ec2.start(stack.id)
        await refresh()
        err.textContent = ''
        break
      } catch (e) {
        const capacity = /no instances|capacity|503/i.test(e.message)
        if (!capacity) { err.textContent = e.message; break }
        err.textContent = `No GPU capacity yet — retrying automatically (attempt ${attempt}). Click the button to stop.`
        for (let i = 0; i < 75 && !startAbort; i += 1) {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    startBtn.textContent = 'Start pod'
  }

  startBtn.addEventListener('click', () => {
    // A click while a retry loop is running cancels it; otherwise it starts one.
    if (startBtn.textContent !== 'Start pod') { startAbort = true; return }
    startWithRetry()
  })

  // Reboot in place. Slow (stop, wait for EXITED, start, wait for an IP — minutes), and it
  // drops any call in progress, so it confirms first and then holds the button in a
  // pending state rather than looking idle while the request is still open.
  el.querySelector('#restart').addEventListener('click', async (ev) => {
    if (!confirm(`Restart ${stack.label}?\n\n`
      + 'Reboots the same pod and re-deploys the latest code. Takes a few minutes, and '
      + 'any call in progress will drop.\n\n'
      + 'The pod itself is kept — unlike Stop then Start, which gives it up and has to '
      + 'find a free GPU again.')) return
    const btn = ev.target
    btn.disabled = true
    btn.textContent = 'Restarting…'
    err.textContent = ''
    try {
      const r = await ec2.restart(stack.id)
      // Say which path ran. A recreate means a new pod id, and silently showing one is how
      // "restart" gets blamed for losing a pod it was asked to keep.
      if (r.restarted === 'recreated') {
        err.textContent = `Pod had to be recreated (${r.reason}); it has a new id.`
      }
      await refresh()
    } catch (e) { err.textContent = e.message }
    finally { btn.disabled = false; btn.textContent = 'Restart pod' }
  })

  el.querySelector('#stop').addEventListener('click', async (ev) => {
    ev.target.disabled = true
    try { await ec2.stop(stack.id); await refresh() } catch (e) { err.textContent = e.message }
    finally { ev.target.disabled = false }
  })
  el.querySelector('#refresh').addEventListener('click', refresh)
  el.querySelector('#sel').addEventListener('change', () => {
    setCurrentStack(stack.id)
    onSelect?.(stack.id)
  })

  refresh()
  loadCapacity()
  const timer = setInterval(refresh, 8000)
  const capTimer = setInterval(loadCapacity, 20000)  // capacity fluctuates; refresh it too
  // The countdown ticks locally between status polls — an 8-second jump is the difference
  // between a clock and a stale number, and this one is the reason you know to press Set.
  const kaTimer = setInterval(renderKa, 1000)
  return {
    el,
    cleanup: () => {
      clearInterval(timer); clearInterval(capTimer); clearInterval(kaTimer)
      startAbort = true
    },
  }
}

// The cloud realtime provider's card. Deliberately NOT podCard with things hidden — see the
// note at the top of this file. It has one action worth having (prove the provider answers)
// and one fact worth showing beyond the static registry: which voice is currently selected,
// since unlike the pods there is exactly one and it speaks both languages.
function cloudCard(entry, onSelect) {
  const el = document.createElement('div')
  el.className = 'card'
  el.innerHTML = `
    <div class="card-head">
      <div class="card-title">${entry.label}</div>
      <div class="card-meta">${entry.cost_note || 'no GPU · pay per use'}</div>
    </div>
    <div class="row" style="margin:2px 0 10px;gap:8px;align-items:center">
      <label class="row" style="gap:6px;align-items:center;cursor:pointer">
        <input type="radio" name="stack-select" id="sel" ${entry.id === currentStack() ? 'checked' : ''}>
        <span class="card-meta">Control this stack</span>
      </label>
      <div class="spacer"></div>
      <span class="card-meta mono">${entry.vendor || 'cloud'} · ${entry.datacenter}</span>
    </div>
    <div id="cap" class="row" style="margin:2px 0 14px;gap:8px;align-items:center">
      <span class="card-meta">Provider</span>
      <span id="cap-badge" class="badge gray">checking…</span>
      <span class="card-meta" id="cap-hint"></span>
    </div>
    <table class="tbl">
      <tr><th>State</th><td><span class="badge green">ALWAYS ON</span></td></tr>
      <tr><th>Model</th><td class="mono">${entry.default_model}</td></tr>
      <tr><th>Transcription</th><td class="mono">${entry.transcribe_model || '—'}</td></tr>
      <tr><th>Voice</th><td class="mono" id="voice">—</td></tr>
      <tr><th>Endpoint</th><td class="mono">${entry.base_path || '/realtime'}</td></tr>
    </table>
    <div class="row" style="margin-top:18px">
      <button class="btn" id="check">Check connection</button>
    </div>
    <div class="stat-sub" style="margin-top:8px">Nothing to start and nothing to stop — this
      provider is a hosted model, so it bills per use rather than per hour and is live the
      moment you select it. One model does speech-to-speech in both languages, so there is a
      single voice rather than a separate Arabic and English one.</div>
    <div class="login-err" id="err"></div>`

  // Named capBadge, not badge: `badge` is the module-level state-pill helper above, and
  // shadowing it inside this function is exactly the kind of thing that reads fine until
  // someone adds a state pill here and gets a DOM node where they expected a function.
  const capBadge = el.querySelector('#cap-badge')
  const hint = el.querySelector('#cap-hint')
  const err = el.querySelector('#err')

  async function refresh() {
    err.textContent = ''
    // The registry already told us whether the key is present; say so without a round trip
    // rather than showing "checking…" forever against a provider that cannot answer.
    if (entry.configured === false) {
      capBadge.className = 'badge red'
      capBadge.textContent = 'not configured'
      hint.textContent = 'REALTIME_LLM_QWEN_API_KEY is not set on the control box'
      return
    }
    try {
      const h = await pod.health()
      capBadge.className = h.ok ? 'badge green' : 'badge red'
      capBadge.textContent = h.ok ? 'reachable' : 'unavailable'
      hint.textContent = h.detail || (h.ok ? 'ready — no warm-up, no model load' : '')
    } catch (e) {
      capBadge.className = 'badge gray'
      capBadge.textContent = 'unreachable'
      hint.textContent = e.message
    }
    try {
      const v = await pod.voices()
      const active = v.voices?.find((x) => x.key === v.active)
      el.querySelector('#voice').textContent = active
        ? `${active.label} · ${active.gender} · Arabic + English`
        : (v.active || '—')
    } catch { /* the health line above already says why */ }
  }

  // Only read this card's own data when it is the selected provider: `pod.health()` routes
  // through the shared pod base, so probing it while a GPU stack is selected would ask the
  // wrong tier and draw a red badge against a provider that is perfectly fine.
  function refreshIfSelected() {
    if (entry.id === currentStack()) { refresh(); return }
    capBadge.className = 'badge gray'
    capBadge.textContent = 'not selected'
    hint.textContent = 'select it to check the provider'
    el.querySelector('#voice').textContent = '—'
  }

  el.querySelector('#check').addEventListener('click', refreshIfSelected)
  el.querySelector('#sel').addEventListener('change', () => {
    setCurrentStack(entry.id)
    onSelect?.(entry.id)
  })

  refreshIfSelected()
  return { el, cleanup: () => {}, onSelectionChanged: refreshIfSelected }
}

export function renderPod() {
  const el = document.createElement('div')
  el.innerHTML = `<div id="cards"></div><div class="login-err" id="err"></div>`
  const cards = el.querySelector('#cards')
  const err = el.querySelector('#err')
  let children = []

  // The provider list comes from the control plane, not a hardcoded array here: settings.py
  // and deploy/realtime.yaml are the registry, and a second copy in the UI is a second thing
  // to keep in sync.
  ec2.stacks().then(({ stacks }) => {
    children = stacks.map((s) => (s.kind === 'cloud' ? cloudCard : podCard)(s, () => {
      // Re-render the radios so exactly one reads as selected, and let each card react to
      // no longer being the selected one — the cloud card's health reads through the shared
      // pod base, so it must stop claiming "reachable" once that base points elsewhere.
      children.forEach((c) => {
        const radio = c.el.querySelector('#sel')
        if (radio) radio.checked = c.el.dataset.stack === currentStack()
        c.onSelectionChanged?.()
      })
    }))
    children.forEach((c, i) => {
      c.el.dataset.stack = stacks[i].id
      cards.appendChild(c.el)
    })
  }).catch((e) => { err.textContent = `Could not load stacks: ${e.message}` })

  return { el, cleanup: () => children.forEach((c) => c.cleanup()) }
}
