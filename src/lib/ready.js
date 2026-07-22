// "Is the pod actually ready?" — shared by every view that drives the agent.
//
// A RUNNING pod is NOT a ready pod. Caddy and the control API answer within seconds of
// boot, but STT, TTS and vLLM take several minutes more, and both the WebSocket and /chat
// accept requests the whole time. Hitting them in that window produces a call that
// transcribes nothing, or a bare 500 from /chat when it dials a vLLM that is not listening
// yet. Neither says "wait two minutes", which is the only useful thing to say.
import { pod } from './api.js'

const LOADING_STATES = {
  stopped: 'speech models are still loading',
  loading: 'the model is loading',
  warming: 'the model is warming up',
  verifying_free_vram: 'waiting for VRAM to free',
  draining: 'a model swap is in progress',
  stopping: 'a model swap is in progress',
  rolling_back: 'a failed swap is rolling back',
}

/** A human explanation of why the pod cannot serve yet, or null when it can. */
export function describeNotReady(health) {
  if (!health || health.llm_state === 'ready') return null
  if (health.llm_state === 'failed') {
    return 'the model failed to load — check the Models view for the error'
  }
  return LOADING_STATES[health.llm_state] || `state: ${health.llm_state}`
}

/** Throw a sentence worth showing if the pod is not ready. Silent when health is
 *  unreachable: Caddy may still be getting its certificate, and letting the real request
 *  fail with a transport error is more honest than inventing a diagnosis. */
export async function assertPodReady() {
  let h
  try { h = await pod.health() } catch { return }
  const why = describeNotReady(h)
  if (why) {
    throw new Error(`pod is not ready yet — ${why}. First boot takes a few minutes; `
      + 'watch progress in the Models view.')
  }
}

/** Turn a failed agent call into something a person can act on.
 *
 * A 500 from /chat during boot is almost always "vLLM is not up yet" rather than a bug, so
 * ask the control tier what is actually happening before showing the raw error. */
export async function explainAgentFailure(err) {
  const status = err?.status
  const transport = err instanceof TypeError    // fetch could not reach the pod at all
  if (!transport && status !== 500 && status !== 502 && status !== 503) return err.message
  try {
    const why = describeNotReady(await pod.health())
    if (why) return `The pod is not ready yet — ${why}.`
  } catch {
    return 'The pod is not reachable — it may be restarting. Check the Pod view.'
  }
  return err.message
}
