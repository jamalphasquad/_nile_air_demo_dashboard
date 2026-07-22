// Voice picker: which reference clip each TTS engine clones.
//
// TWO LISTS, NOT ONE, and that is not a layout choice. Arabic runs through Habibi and
// English through VoxCPM2/F5-EN — different models, each cloning a reference in its own
// language — so there is one active Arabic voice and one active English voice at all times.
// Picking Fatima cannot change what English sounds like, and a UI that implied otherwise
// would be lying about the pipeline.
//
// Preview plays the REFERENCE CLIP, not synthesised speech: the clip is exactly the timbre
// the cloner reproduces, it is instant, and it costs no GPU — which matters because the TTS
// host serialises generation behind one lock, so previewing through the engine would stall
// a live call.
import { pod } from '../lib/api.js'

const LANGS = [
  { id: 'ar', title: 'Egyptian Arabic', sub: 'Habibi (F5-TTS, Specialized/EGY)' },
  { id: 'en', title: 'English', sub: 'VoxCPM2, falling back to base F5-TTS' },
]

export function renderVoices() {
  const el = document.createElement('div')
  el.innerHTML = LANGS.map((l) => `
    <div class="card">
      <div class="card-head">
        <div class="card-title">${l.title}</div>
        <div class="card-meta">${l.sub}</div>
      </div>
      <div id="list-${l.id}" class="muted">Loading…</div>
    </div>`).join('') + `
    <div class="stat-sub" id="note" style="margin-top:4px"></div>`

  const audio = new Audio()
  let blobUrl = null          // revoked before each new preview and on cleanup
  let busy = false

  function play(url) {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = url
    audio.src = url
    audio.play().catch(() => {})
  }

  async function preview(key, btn) {
    btn.disabled = true
    try { play(await pod.voiceSample(key)) }
    catch (e) { el.querySelector('#note').textContent = e.message }
    finally { btn.disabled = false }
  }

  async function choose(lang, key) {
    if (busy) return
    busy = true
    el.querySelector('#note').textContent = 'Switching…'
    try {
      const r = await pod.setVoice(lang, key)
      // Next utterance, not this one: a call in flight keeps the voice it started with.
      el.querySelector('#note').textContent =
        `Now speaking as ${r.applied} — takes effect on the next reply.`
      await load()
    } catch (e) {
      el.querySelector('#note').textContent = e.message
    } finally { busy = false }
  }

  function renderList(lang, voices, activeKey, pinned) {
    const rows = voices.filter((v) => v.lang === lang)
    if (!rows.length) return '<div class="muted">No voices in the catalogue.</div>'
    return `<table class="tbl">
      <tr><th>Voice</th><th>Gender</th><th>Accent</th><th></th><th></th></tr>
      ${rows.map((v) => {
        const active = v.key === activeKey
        return `<tr${active ? ' class="row-active"' : ''}>
          <td><b>${v.label}</b>${active ? ' <span class="badge green">active</span>' : ''}
            <div class="muted">${v.note || ''}</div></td>
          <td>${v.gender}</td>
          <td>${v.accent || '—'}</td>
          <td><button class="btn ghost" data-preview="${v.key}">▶ Preview</button></td>
          <td>${active || pinned
            ? ''
            : `<button class="btn" data-use="${lang}|${v.key}">Use</button>`}</td>
        </tr>`
      }).join('')}
    </table>`
  }

  async function load() {
    let data
    try {
      data = await pod.voices()
    } catch (e) {
      LANGS.forEach((l) => {
        el.querySelector(`#list-${l.id}`).innerHTML =
          `<div class="login-err">${e.message}</div>`
      })
      return
    }
    for (const l of LANGS) {
      const pinned = !!data.pinned?.[l.id]
      el.querySelector(`#list-${l.id}`).innerHTML =
        renderList(l.id, data.voices, data.active?.[l.id], pinned)
        // A pinned language is set by an env var on the pod, so the dashboard genuinely
        // cannot change it. Say so instead of showing buttons that would 409.
        + (pinned
          ? `<div class="stat-sub" style="margin-top:8px">Pinned on the pod by
             TTS_${l.id === 'en' ? 'EN_' : ''}REF_AUDIO — unset it there to select from
             here.</div>`
          : '')
    }
    el.querySelectorAll('[data-preview]').forEach((b) =>
      b.addEventListener('click', () => preview(b.dataset.preview, b)))
    el.querySelectorAll('[data-use]').forEach((b) =>
      b.addEventListener('click', () => {
        const [lang, key] = b.dataset.use.split('|')
        choose(lang, key)
      }))
  }

  load()
  return {
    el,
    cleanup() {
      audio.pause()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    },
  }
}
