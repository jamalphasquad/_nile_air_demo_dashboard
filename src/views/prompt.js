// System prompt editor with version history (create + activate). Live hot-reload on the
// pod: the next call's context picks up the active prompt.
import { pod } from '../lib/api.js'

export function renderPrompt() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><div class="card-title">System Prompt</div>
        <div class="card-meta">edits apply to the next call, no restart</div></div>
      <div class="field"><label>Label for this version</label>
        <input class="inp" id="label" placeholder="e.g. terse-egyptian-v3" /></div>
      <div class="field"><label>Prompt body</label>
        <textarea class="inp" id="body" dir="auto"></textarea></div>
      <div class="row"><button class="btn primary" id="save">Save & activate</button>
        <div class="login-err" id="err"></div></div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">Versions</div></div>
      <div id="versions" class="muted">Loading…</div>
    </div>`

  const err = el.querySelector('#err')
  async function refresh() {
    try {
      const { active_body, versions } = await pod.getPrompts()
      el.querySelector('#body').value = active_body || ''
      el.querySelector('#versions').innerHTML = `<table class="tbl">
        <tr><th>Label</th><th>Created</th><th>Preview</th><th></th></tr>
        ${versions.map((v) => `<tr>
          <td><b>${v.label}</b></td>
          <td class="mono muted">${v.created_at}</td>
          <td class="muted" dir="auto">${(v.preview || '').slice(0, 50)}…</td>
          <td>${v.active ? '<span class="badge green">active</span>'
            : `<button class="btn" data-act="${v.id}">Activate</button>`}</td>
        </tr>`).join('')}</table>`
      el.querySelectorAll('[data-act]').forEach((b) =>
        b.addEventListener('click', async () => {
          try { await pod.activatePrompt(+b.dataset.act); refresh() } catch (e) { err.textContent = e.message }
        }))
    } catch (e) { el.querySelector('#versions').innerHTML = `<div class="login-err">${e.message}</div>` }
  }

  el.querySelector('#save').addEventListener('click', async () => {
    err.textContent = ''
    const label = el.querySelector('#label').value.trim()
    const body = el.querySelector('#body').value.trim()
    if (!label || !body) { err.textContent = 'Label and body are required'; return }
    try { await pod.createPrompt(label, body); el.querySelector('#label').value = ''; refresh() }
    catch (e) { err.textContent = e.message }
  })

  refresh()
  return { el }
}
