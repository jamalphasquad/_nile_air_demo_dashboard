// Voice picker. The LAYOUT ITSELF depends on the selected provider, because the two
// providers genuinely differ in how many voices they have — this is not a cosmetic branch.
//
// SELF-HOSTED POD: two lists, and that is not a layout choice. Arabic runs through Habibi
// and English through VoxCPM2/F5-EN — different models, each cloning a reference in its own
// language — so there is one active Arabic voice and one active English voice at all times.
// Picking Fatima cannot change what English sounds like, and a UI that implied otherwise
// would be lying about the pipeline.
//
// CLOUD REALTIME: one list. A single speech-to-speech model produces both languages in one
// voice, so there is exactly one selection and it applies to everything the agent says. The
// page says so outright, because "why is there only one list now" is the first thing anyone
// asks and the answer is the most interesting difference between the two architectures.
//
// Preview plays the pod's REFERENCE CLIP, not synthesised speech: the clip is exactly the
// timbre the cloner reproduces, it is instant, and it costs no GPU — which matters because
// the TTS host serialises generation behind one lock, so previewing through the engine would
// stall a live call. The cloud provider has no such clip (the voice is a name, not a file),
// so it reports `previewable: false` and the button is not drawn rather than drawn broken.
import { pod, isCloud } from '../lib/api.js'

const LANGS = [
  { id: 'ar', title: 'Egyptian Arabic', sub: 'Habibi (F5-TTS, Specialized/EGY)' },
  { id: 'en', title: 'English', sub: 'VoxCPM2, falling back to base F5-TTS' },
]

// One pseudo-language for the combined case. `id: 'ar'` is what gets sent as the `lang` of
// the PUT, which the cloud tier accepts and ignores — it has one voice, so there is nothing
// for the field to select. Keeping the request shape identical across providers is what lets
// `choose()` below stay one function.
const COMBINED = [
  { id: 'ar', title: 'Qwen3.5-Omni', sub: 'one model · one voice · Arabic and English' },
]

export function renderVoices() {
  const el = document.createElement('div')
  const cloud = isCloud()
  const sections = cloud ? COMBINED : LANGS
  el.innerHTML = sections.map((l) => `
    <div class="card">
      <div class="card-head">
        <div class="card-title">${l.title}</div>
        <div class="card-meta">${l.sub}</div>
      </div>
      <div id="list-${l.id}" class="muted">Loading…</div>
      ${cloud ? `<div class="stat-sub" style="margin-top:10px">This provider does
        speech-to-speech in a single model, so one voice speaks both languages — unlike the
        self-hosted pod, where Arabic and English are two different TTS engines and therefore
        two different speakers. Applies to the next call; a call in progress keeps the voice
        it started with.</div>` : ''}
    </div>`).join('') + `
    <div class="stat-sub" id="note" style="margin-top:4px"></div>`

  const audio = new Audio()
  let blobUrl = null          // revoked before each new preview and on cleanup
  let busy = false
  // Set from the server's own answer in load(), not from isCloud(): the tier that serves the
  // catalogue is the authority on whether it has one voice or two, and believing the client's
  // guess is how a provider added later would render wrong.
  let combined = cloud

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

  function renderList(lang, voices, activeKey, pinned, previewable) {
    // The combined provider labels every voice `ar+en`, so filtering by exact language would
    // empty the one list it has. `combined` means "these are all of them".
    const rows = combined ? voices : voices.filter((v) => v.lang === lang)
    if (!rows.length) return '<div class="muted">No voices in the catalogue.</div>'
    return `<table class="tbl">
      <tr><th>Voice</th><th>Gender</th><th>${combined ? 'Speaks' : 'Accent'}</th>
        ${previewable ? '<th></th>' : ''}<th></th></tr>
      ${rows.map((v) => {
        const active = v.key === activeKey
        return `<tr${active ? ' class="row-active"' : ''}>
          <td><b>${v.label}</b>${active ? ' <span class="badge green">active</span>' : ''}
            <div class="muted">${v.note || ''}</div></td>
          <td>${v.gender}</td>
          <td>${combined
            ? (v.supports_arabic ? 'Arabic + English' : 'English')
            : (v.accent || '—')}</td>
          ${previewable
            ? `<td><button class="btn ghost" data-preview="${v.key}">▶ Preview</button></td>`
            : ''}
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
      sections.forEach((l) => {
        el.querySelector(`#list-${l.id}`).innerHTML =
          `<div class="login-err">${e.message}</div>`
      })
      return
    }
    // The pod reports `active` as an {ar, en} pair (two engines, two selections); the cloud
    // provider reports it as a single string. Read whichever this tier sent rather than
    // assuming, so a mismatch shows as "no active voice" instead of a crash.
    combined = !!data.combined
    const previewable = data.previewable !== false
    for (const l of sections) {
      const pinned = !!data.pinned?.[l.id]
      const activeKey = combined ? data.active : data.active?.[l.id]
      el.querySelector(`#list-${l.id}`).innerHTML =
        renderList(l.id, data.voices, activeKey, pinned, previewable)
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
