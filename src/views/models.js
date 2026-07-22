// Model A/B swap with live SSE progress: shard %, KV-cache size, VRAM, state machine.
import { pod } from '../lib/api.js'
import { getToken } from '../lib/session.js'

const stateBadge = (st) => {
  const map = {
    ready: 'green', loading: 'yellow', warming: 'yellow',
    verifying_free_vram: 'yellow', draining: 'yellow', stopping: 'yellow',
    rolling_back: 'red', failed: 'red', stopped: 'gray',
  }
  return `<span class="badge ${map[st] || 'gray'}">${(st || '').replace(/_/g, ' ')}</span>`
}

export function renderModels() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><div class="card-title">Swap Progress</div>
        <div id="state">${stateBadge('unknown')}</div></div>
      <div class="grid grid-2">
        <div><div class="stat-label">Shard load</div>
          <div class="meter" style="margin-top:8px"><span id="shard" style="width:0%"></span></div>
          <div class="stat-sub" id="shard-t" style="margin-top:6px">—</div></div>
        <div><div class="stat-label">Free VRAM</div>
          <div class="meter blue" style="margin-top:8px"><span id="vram" style="width:0%"></span></div>
          <div class="stat-sub" id="vram-t" style="margin-top:6px">—</div></div>
      </div>
      <div class="stat-sub" id="msg" style="margin-top:14px"></div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">Models</div>
        <div class="card-meta" id="stack-meta">A / B comparison · one resident at a time</div></div>
      <div id="list" class="muted">Loading…</div>
    </div>
    <div class="card" id="tuning-card" style="display:none">
      <div class="card-head"><div class="card-title">Generation</div>
        <div class="card-meta">thinking applies next turn · context restarts vLLM</div></div>

      <div class="stat-label">Thinking</div>
      <div class="row" id="thinking" style="gap:6px;margin:8px 0 4px"></div>
      <div class="stat-sub" id="think-note" style="margin-bottom:16px"></div>

      <div class="stat-label">Context size</div>
      <div class="row" style="gap:8px;margin-top:8px;align-items:center">
        <select id="ctx" class="btn"></select>
        <button class="btn" id="ctx-apply">Apply</button>
        <span class="stat-sub" id="ctx-note"></span>
      </div>
    </div>`

  const list = el.querySelector('#list')
  const tuning = el.querySelector('#tuning-card')
  const thinkRow = el.querySelector('#thinking')
  const thinkNote = el.querySelector('#think-note')
  const ctxSel = el.querySelector('#ctx')
  const ctxNote = el.querySelector('#ctx-note')
  let es = null
  let active = null          // the currently resident model's /models entry

  // Thinking is per-request: vLLM maps reasoning_effort onto the chat template's
  // enable_thinking and enforces thinking_token_budget with a logits processor, both per
  // completion. Context size is NOT — --max-model-len is a launch flag, so changing it is
  // a real vLLM restart. The two controls sit together but behave differently, and the
  // labels say so rather than leaving the operator to discover it.
  async function loadThinking() {
    try {
      const t = await pod.getThinking()
      thinkRow.innerHTML = t.levels.map((lv) => `
        <button class="btn ${lv === t.level ? 'primary' : ''}" data-level="${lv}">
          ${lv[0].toUpperCase()}${lv.slice(1)}</button>`).join('')
      thinkNote.innerHTML = t.warning
        ? `<span class="badge yellow">warning</span> ${t.warning}`
        : (t.thinking_token_budget
          ? `reasoning_effort=<b>${t.reasoning_effort}</b> · budget <b>${t.thinking_token_budget}</b> tokens`
          : 'Thinking off — lowest latency, and the safest setting for tool calls.')
      // A small window plus a big reasoning budget means the budget eats the context.
      const ctx = active?.max_model_len || active?.context_default
      if (t.thinking_token_budget && ctx && t.thinking_token_budget * 4 > ctx) {
        thinkNote.innerHTML += `<br><span class="badge yellow">note</span>
          a ${t.thinking_token_budget}-token budget is large relative to a ${ctx}-token
          window — reasoning will crowd out the conversation.`
      }
      thinkRow.querySelectorAll('[data-level]').forEach((b) =>
        b.addEventListener('click', async () => {
          try { await pod.setThinking(b.dataset.level); await loadThinking() }
          catch (e) { alert(e.message) }
        }))
    } catch (e) { thinkNote.textContent = e.message }
  }

  function loadContext() {
    const lengths = active?.context_lengths || []
    const cur = active?.max_model_len || active?.context_default
    ctxSel.innerHTML = lengths.map((n) =>
      `<option value="${n}" ${n === cur ? 'selected' : ''}>${n / 1024}k (${n})</option>`).join('')
    ctxNote.textContent = lengths.length
      ? 'Smaller windows free VRAM for KV cache.'
      : 'No context sizes configured for this model.'
  }

  el.querySelector('#ctx-apply').addEventListener('click', async (ev) => {
    const n = Number(ctxSel.value)
    if (!active || !n) return
    // An explicit confirm, because this one is NOT instant: it stops vLLM, waits out the
    // VRAM gate and reloads the weights. Progress shows in the Swap Progress card above.
    if (!confirm(`Reload ${active.label} with a ${n}-token context?\n\n`
      + 'This restarts vLLM (~2-4 min). Speech and the transport stay up, and a failed '
      + 'reload rolls back automatically.')) return
    ev.target.disabled = true
    try { await pod.swap(active.key, null, n) } catch (e) { alert(e.message) }
    finally { ev.target.disabled = false }
  })

  async function loadModels() {
    try {
      const { models, stack } = await pod.models()
      active = models.find((m) => m.active) || null
      el.querySelector('#stack-meta').textContent =
        `stack: ${stack || '—'} · one resident at a time`
      list.innerHTML = `<table class="tbl">
        <tr><th>Model</th><th>Parser</th><th>VRAM</th><th>Context</th><th></th></tr>
        ${models.map((m) => `
          <tr>
            <td><b>${m.label}</b>${m.default ? ' <span class="badge blue">default</span>' : ''}
              <div class="mono muted" style="font-size:11px">${m.repo}</div></td>
            <td class="mono">${m.parser || '—'}</td>
            <td class="mono">${m.vram_gb ? m.vram_gb + 'GB' : '—'}</td>
            <td class="mono">${m.max_model_len || m.context_default || '—'}</td>
            <td>${m.active
              ? '<span class="badge green">active</span>'
              : `<button class="btn" data-swap="${m.key}">Load</button>`}</td>
          </tr>`).join('')}
      </table>`
      list.querySelectorAll('[data-swap]').forEach((b) =>
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = 'Swapping…'
          try { await pod.swap(b.dataset.swap) } catch (e) { alert(e.message) }
        }))

      // The tuning card only makes sense for a reasoning model that is actually resident.
      tuning.style.display = active?.reasoning ? '' : 'none'
      if (active?.reasoning) { loadContext(); await loadThinking() }
    } catch (e) { list.innerHTML = `<div class="login-err">${e.message}</div>` }
  }

  async function connectSSE() {
    // EventSource cannot set headers, so pass the token as a query param; the pod accepts
    // it either way. Auto-reconnects on drop, which is what we want across a swap. The pod
    // base is resolved at runtime, so await it before building the URL.
    let base
    try { base = await pod.eventsUrl() } catch { return }
    const url = `${base}?token=${encodeURIComponent(getToken() || '')}`
    es = new EventSource(url)
    es.onmessage = (ev) => {
      let s; try { s = JSON.parse(ev.data) } catch { return }
      el.querySelector('#state').innerHTML = stateBadge(s.state)
      const shard = s.shard_pct ?? 0
      el.querySelector('#shard').style.width = `${shard}%`
      el.querySelector('#shard-t').textContent =
        s.shard_pct != null ? `${shard}%` : (s.kv_cache_tokens ? `KV ${s.kv_cache_tokens.toLocaleString()} tok` : '—')
      const free = s.free_vram_gb ?? 0
      el.querySelector('#vram').style.width = `${Math.min(100, (free / 80) * 100)}%`
      el.querySelector('#vram-t').textContent = free ? `${free} GB free` : '—'
      el.querySelector('#msg').textContent = s.message || ''
      if (s.state === 'ready') loadModels()
    }
    es.onerror = () => { /* EventSource retries automatically */ }
  }

  loadModels()
  connectSSE()
  return { el, cleanup: () => es?.close() }
}
