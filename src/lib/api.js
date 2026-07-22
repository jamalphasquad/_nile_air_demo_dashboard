// Fetch wrapper that attaches the session token and routes to the right tier.
// A 401 anywhere means the session expired or was rejected -> bounce to login.
import { EC2_URL } from './config.js'
import { getToken, logout } from './session.js'

async function req(base, path, { method = 'GET', body, raw } = {}) {
  const headers = { Authorization: `Bearer ${getToken() || ''}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401) { logout(); throw new Error('Session expired') }
  if (!r.ok) {
    let detail = `${r.status}`
    try { detail = (await r.json()).detail || detail } catch {}
    throw new Error(detail)
  }
  if (raw) return r
  if (r.status === 204) return null
  return r.json()
}

// Which stack the Control/Admin views act on. There are two independent demo stacks (the
// H100 pod and the cheaper Qwen 3.5-9B pod) and both can be running at once, so "which one
// am I talking to" has to be explicit rather than implied. Persisted so a page reload does
// not silently move you back to the expensive pod.
const STACK_KEY = 'nileair.stack'
export function currentStack() { return localStorage.getItem(STACK_KEY) || 'h100' }
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
}

// Tier 2 — pod control API. The pod's audio/control endpoint is a per-pod high port
// (RunPod renumbers it on every create), so a build-time POD_URL goes stale the moment the
// pod is recreated — which, with the 45-minute auto-stop, is often. Resolve it at RUNTIME
// from the EC2 tier's /pod/status (fqdn + audio_port), exactly as the voice call already
// resolves its WebSocket URL. Memoised; reset on start/stop and self-healed on a network
// error (the symptom of a stale port after an unattended restart).
let _podBase = null
export function resetPodBase() { _podBase = null }

async function podBase() {
  if (_podBase) return _podBase
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
  chat: (text, history) =>
    podReq('/chat', { method: 'POST', body: { text, history } }),
}
