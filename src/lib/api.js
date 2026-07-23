// Fetch wrapper that attaches the session token and routes to the right tier.
// A 401 anywhere means the session expired or was rejected -> bounce to login.
import { EC2_URL } from './config.js'
import { getToken, logout } from './session.js'

// `rawBody` is an ArrayBuffer sent as-is (the mic's PCM16); `body` is JSON-encoded.
async function req(base, path, { method = 'GET', body, rawBody, raw } = {}) {
  const headers = { Authorization: `Bearer ${getToken() || ''}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (rawBody !== undefined) headers['Content-Type'] = 'application/octet-stream'
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody
      : body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401) { logout(); throw new Error('Session expired') }
  if (!r.ok) {
    let detail = `${r.status}`
    try { detail = (await r.json()).detail || detail } catch {}
    // Carry the status: callers distinguish "this pod is too old to have that route" (404)
    // from "the model is still loading" (503), which read identically in `detail`.
    const err = new Error(detail)
    err.status = r.status
    throw err
  }
  if (raw) return r
  if (r.status === 204) return null
  return r.json()
}

// Which provider the Control/Admin views act on. There are three: two independent GPU
// stacks (the H100 pod and the cheaper Qwen 3.5-9B pod), either or both of which can be
// running, and one CLOUD provider that is never off. So "which one am I talking to" has to
// be explicit rather than implied. Persisted so a page reload does not silently move you
// back to the expensive pod.
const STACK_KEY = 'nileair.stack'

// The cloud realtime provider. Not a pod: it has no lifecycle, no GPU and no per-pod port —
// it is served by the EC2 tier at /realtime, which deliberately presents the SAME surface a
// pod's control API does (/api/control/*, /chat, /ws, /health). That is what lets every view
// below keep calling `pod.*` with no knowledge of which provider is selected.
export const CLOUD_STACK = 'cloud-realtime'
export const CLOUD_BASE = `${EC2_URL}/realtime`
export function isCloud() { return currentStack() === CLOUD_STACK }
// Mirrors deploy.settings.DEFAULT_STACK. Hardcoded rather than fetched because callers are
// synchronous and this is the value used before /stacks has answered; it is the CHEAP
// stack, so the cost of the two drifting apart is a wrong label, never a surprise $2.99/hr
// pod. A stack the operator has explicitly selected wins over it, from localStorage.
const DEFAULT_STACK = 'qwen9b'
export function currentStack() { return localStorage.getItem(STACK_KEY) || DEFAULT_STACK }
export function setCurrentStack(id) {
  if (id === currentStack()) return
  localStorage.setItem(STACK_KEY, id)
  resetPodBase()          // the other stack answers on a different host and port
}

// Tier 1 — EC2 pod lifecycle. Stable host (nileair-demo.watson.my), so build-time URL.
// start/stop reset the cached pod base, because a fresh pod comes up on a new high port.
// Every call takes a stack id, defaulting to the selected one.
export const ec2 = {
  stacks: () => req(EC2_URL, '/stacks'),
  status: (stack = currentStack()) => req(EC2_URL, `/pods/${stack}/status`),
  // Live GPU stock for that stack's datacenter and card, so the Pod page can show whether
  // a start is likely to land before you commit to a (retrying) launch.
  capacity: (stack = currentStack()) => req(EC2_URL, `/pods/${stack}/capacity`),
  start: async (stack = currentStack()) => {
    const r = await req(EC2_URL, `/pods/${stack}/start`, { method: 'POST' })
    if (stack === currentStack()) resetPodBase()
    return r
  },
  stop: async (stack = currentStack()) => {
    const r = await req(EC2_URL, `/pods/${stack}/stop`, { method: 'POST' })
    if (stack === currentStack()) resetPodBase()
    return r
  },
  // Reboot the SAME pod instead of replacing it. Start terminates and recreates by design,
  // so stop-then-start gives the pod back to the datacenter and has to win a GPU again —
  // which, at "Low" stock, it may not. Restart keeps the pod you already hold and still
  // deploys new code, since the pod re-clones the app on every boot. The port can still
  // change across the reboot, so the cached pod base is dropped either way.
  restart: async (stack = currentStack()) => {
    const r = await req(EC2_URL, `/pods/${stack}/restart`, { method: 'POST' })
    if (stack === currentStack()) resetPodBase()
    return r
  },
  // How long this pod may run before the cron dead-man's switch terminates it. Settable
  // while it is running, and the clock restarts at the moment you set it — so "2 hours"
  // always means two hours from the click, never two hours from pod start. /status already
  // carries the same block, so the card's countdown needs no extra poll; this pair is for
  // reading it on demand and changing it.
  keepalive: (stack = currentStack()) => req(EC2_URL, `/pods/${stack}/keepalive`),
  setKeepalive: (hours, stack = currentStack()) =>
    req(EC2_URL, `/pods/${stack}/keepalive`, { method: 'PUT', body: { hours } }),
}

// Tier 2 — pod control API. The pod's audio/control endpoint is a per-pod high port
// (RunPod renumbers it on every create), so a build-time POD_URL goes stale the moment the
// pod is recreated — which, with the keep-alive auto-stop (1h by default), is often. Resolve it at RUNTIME
// from the EC2 tier's /pod/status (fqdn + audio_port), exactly as the voice call already
// resolves its WebSocket URL. Memoised; reset on start/stop and self-healed on a network
// error (the symptom of a stale port after an unattended restart).
let _podBase = null
export function resetPodBase() { _podBase = null }

async function podBase() {
  if (_podBase) return _podBase
  // The cloud provider needs no resolution at all: it lives on the EC2 tier's stable
  // hostname at a fixed path, so there is no pod status to read and no high port to chase.
  // Everything below this line exists only because RunPod renumbers a pod's port on every
  // create.
  if (isCloud()) { _podBase = CLOUD_BASE; return _podBase }
  const s = await ec2.status()
  if (!s.exists || s.state !== 'RUNNING' || !s.fqdn || !s.audio_port) {
    throw new Error(
      `Pod "${currentStack()}" not running (${s.state || 'none'}) — start it in the Pod view.`)
  }
  _podBase = `https://${s.fqdn}:${s.audio_port}`
  return _podBase
}

async function podReq(path, opts) {
  try {
    return await req(await podBase(), path, opts)
  } catch (e) {
    // A stale base (pod recreated on a new port) surfaces as a TypeError from fetch;
    // drop the cached base and re-resolve once before giving up.
    if (e instanceof TypeError) { resetPodBase(); return req(await podBase(), path, opts) }
    throw e
  }
}

export const pod = {
  // The voice-call WebSocket for the SELECTED provider, resolved at runtime for the same
  // reason the HTTP base is. For a pod that means reading the current fqdn and RunPod-
  // renumbered audio port; for the cloud provider it is the EC2 tier's /realtime/ws, with
  // the session token as a query param because a browser WebSocket cannot set headers (the
  // same constraint EventSource has, solved the same way).
  wsUrl: async () => {
    if (isCloud()) {
      return `${CLOUD_BASE.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(getToken() || '')}`
    }
    const s = await ec2.status()
    if (!s.exists || s.state !== 'RUNNING' || !s.ip) {
      throw new Error(`pod not running (state: ${s.state || 'none'}) — start it in Pod view`)
    }
    if (!s.audio_port) throw new Error('pod has no audio port mapped yet')
    // wss to the pod FQDN (grey-cloud DNS -> pod IP) on the audio port, where Caddy fronts
    // the bot's /ws with TLS.
    return `wss://${s.fqdn}:${s.audio_port}/ws`
  },

  health: () => podReq('/api/control/health'),
  status: () => podReq('/api/control/status'),
  models: () => podReq('/api/control/models'),
  // max_model_len restarts vLLM (it is a launch flag); omit it for a plain model switch.
  swap: (model_key, parser, max_model_len) =>
    podReq('/api/control/swap', {
      method: 'POST', body: { model_key, parser, max_model_len },
    }),

  // Thinking level — per-request, so this takes effect on the next turn with no swap.
  getThinking: () => podReq('/api/control/thinking'),
  setThinking: (level) =>
    podReq('/api/control/thinking', { method: 'PUT', body: { level } }),
  // SSE endpoint URL for EventSource (token as query param, since EventSource cannot set
  // headers). Async because the pod base is resolved at runtime.
  eventsUrl: async () => `${await podBase()}/api/control/events`,

  // Voice — the reference clip each TTS engine clones. Two selections, never one: the
  // Arabic and English engines are separate models with separate references, so switching
  // one cannot change the other. Applies on the next utterance; no model reload.
  voices: () => podReq('/api/control/voices'),
  setVoice: (lang, voice_key) =>
    podReq('/api/control/voice', { method: 'PUT', body: { lang, voice_key } }),
  // The reference clip itself, as a blob. Fetched (not set as an <audio src>) because the
  // endpoint is auth-guarded and an <audio> element cannot send the bearer token.
  voiceSample: async (key) => {
    const r = await podReq(`/api/control/voices/${encodeURIComponent(key)}/sample.wav`,
      { raw: true })
    return URL.createObjectURL(await r.blob())
  },

  getPrompts: () => podReq('/api/control/prompt'),
  createPrompt: (label, body) =>
    podReq('/api/control/prompt', { method: 'POST', body: { label, body } }),
  activatePrompt: (id) =>
    podReq(`/api/control/prompt/${id}/activate`, { method: 'POST' }),

  listKb: () => podReq('/api/control/kb'),
  getKb: (slug) => podReq(`/api/control/kb/${encodeURIComponent(slug)}`),
  putKb: (slug, doc) =>
    podReq(`/api/control/kb/${encodeURIComponent(slug)}`, { method: 'PUT', body: doc }),
  deleteKb: (slug) =>
    podReq(`/api/control/kb/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  getBooking: (pnr, surname) =>
    podReq(`/api/control/bookings/${encodeURIComponent(pnr)}?surname=${encodeURIComponent(surname)}`),

  // One-shot transcription of a push-to-talk utterance. `pcm` is an Int16Array of mono
  // 16 kHz samples — the same format the call path streams — sent as raw bytes, because
  // the pod's STT host treats every byte as a sample and a WAV header would be decoded as
  // noise at the head of the utterance. Returns {text, language, ...}.
  transcribe: (pcm, language = 'auto') =>
    podReq(`/api/control/stt?language=${encodeURIComponent(language)}`, {
      method: 'POST', rawBody: pcm.buffer,
    }),

  // Book a seat directly (the Flight Booking page's inline Select form). Runs the same
  // domain mutation as the agent's book_flight tool, so both produce the same PNR.
  book: (booking) => podReq('/api/control/bookings', { method: 'POST', body: booking }),

  // Operator browse — the full schedule and all bookings, behind the dashboard's own auth.
  listFlights: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString()
    return podReq(`/api/control/flights${qs ? `?${qs}` : ''}`)
  },
  listBookings: () => podReq('/api/control/bookings'),

  // history is an optional [{role, content}] thread so text chat can carry a booking flow
  // across turns (search -> choose -> book), matching the voice path.
  // `language` ("en"/"ar") pins the reply language for the turn. Pass the tag STT returned
  // for a spoken turn — that is real evidence, where the server otherwise has to infer the
  // language from the script. Omit it for typed turns and let the server decide.
  chat: (text, history, language) =>
    podReq('/chat', { method: 'POST', body: { text, history, language } }),
}
