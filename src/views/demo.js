// Voice call view: mic button, live transcript with tool-call trace, barge-in.
import { VoiceCall } from '../lib/audio.js'
import { ec2 } from '../lib/api.js'
import { icons } from '../components/icons.js'

// The pod's audio endpoint is on a RunPod-renumbered high TCP port, known only at
// runtime — so the WS URL is resolved from the live pod status, not a build-time constant.
async function resolveWsUrl() {
  const s = await ec2.status()
  if (!s.exists || s.state !== 'RUNNING' || !s.ip) {
    throw new Error(`pod not running (state: ${s.state || 'none'}) — start it in Pod view`)
  }
  if (!s.audio_port) throw new Error('pod has no audio port mapped yet')
  // wss to the pod FQDN (grey-cloud DNS -> pod IP) on the audio port, where Caddy fronts
  // the bot's /ws with TLS.
  return `wss://${s.fqdn}:${s.audio_port}/ws`
}

export function renderDemo() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">Voice Call</div>
        <div class="card-meta" id="call-state">idle</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:14px 0 22px">
        <button class="mic" id="mic" title="Start call">${icons.mic}</button>
        <div class="muted" id="hint">Click to start · speak Egyptian Arabic or English</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">Transcript</div>
        <button class="btn ghost" id="clear">Clear</button></div>
      <div class="transcript" id="transcript"></div>
    </div>`

  const micBtn = el.querySelector('#mic')
  const stateEl = el.querySelector('#call-state')
  const hint = el.querySelector('#hint')
  const transcript = el.querySelector('#transcript')
  let call = null

  const add = (cls, who, text) => {
    const d = document.createElement('div')
    d.className = `turn ${cls}`
    const isAr = /[؀-ۿ]/.test(text)
    d.innerHTML = `<div class="who">${who}</div><div${isAr ? ' dir="rtl"' : ''}>${text}</div>`
    transcript.appendChild(d)
    transcript.scrollTop = transcript.scrollHeight
  }

  const handlers = {
    onState: (s) => { stateEl.textContent = s },
    onTranscript: (m) => (m.role === 'assistant'
      ? add('bot', `agent · ${m.language || ''}`, m.text)
      : add('user', `you · ${m.language || '?'}`, m.text)),
    onToolCall: (m) => add('tool', 'tool', `${m.name}(${JSON.stringify(m.args || {})})`),
    onBotSpeaking: (on) => { micBtn.classList.toggle('speaking', on) },
    onError: (e) => add('tool', 'error', e),
  }

  async function startCall() {
    try {
      stateEl.textContent = 'resolving pod…'
      const wsUrl = await resolveWsUrl()
      call = new VoiceCall(wsUrl, handlers)
      await call.start()
      micBtn.classList.add('live')
      hint.textContent = 'Listening… click to end'
      stateEl.textContent = 'connecting'
    } catch (e) {
      add('tool', 'error', `mic/ws failed: ${e.message}`)
      stateEl.textContent = 'idle'
      call = null
    }
  }
  function endCall() {
    call?.stop(); call = null
    micBtn.classList.remove('live')
    hint.textContent = 'Click to start · speak Egyptian Arabic or English'
    stateEl.textContent = 'idle'
  }

  micBtn.addEventListener('click', () => (call ? endCall() : startCall()))
  el.querySelector('#clear').addEventListener('click', () => (transcript.innerHTML = ''))

  return { el, cleanup: () => call?.stop() }
}
