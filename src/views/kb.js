// Knowledge-base editor: list docs, edit bilingual title + body, save (FTS reindexes
// server-side), delete.
import { pod } from '../lib/api.js'

export function renderKb() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div class="card-title">Documents</div>
          <button class="btn ghost" id="new">+ New</button></div>
        <div id="list" class="muted">Loading…</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title" id="editing">Editor</div></div>
        <div class="field"><label>Slug</label><input class="inp" id="slug" placeholder="baggage-allowance" /></div>
        <div class="field"><label>Title (EN)</label><input class="inp" id="ten" /></div>
        <div class="field"><label>Title (AR)</label><input class="inp" id="tar" dir="rtl" /></div>
        <div class="field"><label>Body (markdown, bilingual)</label>
          <textarea class="inp" id="body" dir="auto"></textarea></div>
        <div class="row"><button class="btn primary" id="save">Save</button>
          <button class="btn danger" id="del">Delete</button>
          <div class="login-err" id="err"></div></div>
      </div>
    </div>`

  const q = (s) => el.querySelector(s)
  const err = q('#err')

  async function refresh() {
    try {
      const { docs } = await pod.listKb()
      q('#list').innerHTML = `<table class="tbl">
        <tr><th>Slug</th><th>Title</th></tr>
        ${docs.map((d) => `<tr style="cursor:pointer" data-slug="${d.slug}">
          <td class="mono">${d.slug}</td>
          <td>${d.title_en}<div class="muted" dir="rtl">${d.title_ar}</div></td>
        </tr>`).join('')}</table>`
      q('#list').querySelectorAll('[data-slug]').forEach((r) =>
        r.addEventListener('click', () => loadDoc(r.dataset.slug)))
    } catch (e) { q('#list').innerHTML = `<div class="login-err">${e.message}</div>` }
  }

  async function loadDoc(slug) {
    try {
      const d = await pod.getKb(slug)
      q('#editing').textContent = `Editing: ${slug}`
      q('#slug').value = d.slug; q('#ten').value = d.title_en
      q('#tar').value = d.title_ar; q('#body').value = d.body
    } catch (e) { err.textContent = e.message }
  }

  q('#new').addEventListener('click', () => {
    q('#editing').textContent = 'New document'
    ;['#slug', '#ten', '#tar', '#body'].forEach((s) => (q(s).value = ''))
  })
  q('#save').addEventListener('click', async () => {
    err.textContent = ''
    const slug = q('#slug').value.trim()
    if (!slug) { err.textContent = 'Slug required'; return }
    try {
      await pod.putKb(slug, { title_en: q('#ten').value, title_ar: q('#tar').value, body: q('#body').value })
      refresh()
    } catch (e) { err.textContent = e.message }
  })
  q('#del').addEventListener('click', async () => {
    const slug = q('#slug').value.trim()
    if (!slug || !confirm(`Delete ${slug}?`)) return
    try { await pod.deleteKb(slug); ['#slug','#ten','#tar','#body'].forEach((s)=>(q(s).value='')); refresh() }
    catch (e) { err.textContent = e.message }
  })

  refresh()
  return { el }
}
