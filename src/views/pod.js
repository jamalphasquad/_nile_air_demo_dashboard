// Pod lifecycle: start / stop / status, cost display, the "no capacity" state made loud.
//
// One card PER STACK. There are two independent demo stacks — the H100 pod and the cheaper
// Qwen 3.5-9B pod — and either, both, or neither can be running. Each card owns its own
// status poll, capacity badge and start-retry loop, so a stalled probe on one stack cannot
// freeze the other. The radio on each card picks which stack the Models / Prompt / KB /
// Chat / Voice views talk to.
import { ec2, currentStack, setCurrentStack } from '../lib/api.js'

const badge = (state) => {
  const map = { RUNNING: 'green', EXITED: 'gray', TERMINATED: 'red', none: 'gray' }
  return `<span class="badge ${map[state] || 'yellow'}">${state}</span>`
}

// Map RunPod's SECURE-cloud stock signal to a colour + plain-language recommendation.
// Crucially, "Low" means limited-but-AVAILABLE (a GPU is rentable right now) — not
// "unavailable" — which is why the RunPod console can show the card as available while
// the status reads Low. Any non-"none" status = you can start; only "none" = come back.
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
  let startAbort = false   // set true to cancel an in-progress start-retry loop

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
        return
      }
      cost.textContent = s.cost_per_hr ? `$${s.cost_per_hr}/hr` : ''
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
  return {
    el,
    cleanup: () => { clearInterval(timer); clearInterval(capTimer); startAbort = true },
  }
}

export function renderPod() {
  const el = document.createElement('div')
  el.innerHTML = `<div id="cards"></div><div class="login-err" id="err"></div>`
  const cards = el.querySelector('#cards')
  const err = el.querySelector('#err')
  let children = []

  // The stack list comes from the control plane, not a hardcoded array here: settings.py
  // is the registry, and a second copy in the UI is a second thing to keep in sync.
  ec2.stacks().then(({ stacks }) => {
    children = stacks.map((s) => podCard(s, () => {
      // Re-render the radios so exactly one reads as selected.
      children.forEach((c) => {
        const radio = c.el.querySelector('#sel')
        if (radio) radio.checked = c.el.dataset.stack === currentStack()
      })
    }))
    children.forEach((c, i) => {
      c.el.dataset.stack = stacks[i].id
      cards.appendChild(c.el)
    })
  }).catch((e) => { err.textContent = `Could not load stacks: ${e.message}` })

  return { el, cleanup: () => children.forEach((c) => c.cleanup()) }
}
