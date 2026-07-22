// Voice call over the raw-PCM WebSocket the bot serializer speaks.
//   up:   mic (browser rate, usually 48k) -> downsample to 16k -> PCM16 -> binary frame
//   down: binary frame = PCM16 @ 24k -> scheduled playback
//   control: JSON text frames both ways (transcript, bot speaking, error, interrupt)
//
// ScriptProcessorNode is used for capture: deprecated but universally available with no
// separate worklet file, which is the right trade for a single-call demo.
import { MIC_RATE, TTS_RATE } from './config.js'

function floatTo16k(input, inRate) {
  // Linear resample input (Float32 @ inRate) down to MIC_RATE, return Int16.
  const ratio = inRate / MIC_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

export class VoiceCall {
  constructor(wsUrl, handlers = {}) {
    this.wsUrl = wsUrl
    this.h = handlers
    this.ws = null
    this.ctx = null
    this.playCtx = null
    this.stream = null
    this.node = null
    this.src = null
    this.playHead = 0
    this.live = false
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.ctx = new AudioContext()
    this.playCtx = new AudioContext()
    this.playHead = this.playCtx.currentTime

    this.ws = new WebSocket(this.wsUrl)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onopen = () => { this.live = true; this.h.onState?.('connected') }
    this.ws.onclose = () => { this.live = false; this.h.onState?.('closed') }
    this.ws.onerror = () => this.h.onError?.('WebSocket error')
    this.ws.onmessage = (ev) => this._onMessage(ev)

    this.src = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => {
      if (!this.live || this.ws.readyState !== WebSocket.OPEN) return
      const pcm = floatTo16k(e.inputBuffer.getChannelData(0), this.ctx.sampleRate)
      this.ws.send(pcm.buffer)
    }
    this.src.connect(this.node)
    this.node.connect(this.ctx.destination)  // required for onaudioprocess to fire
  }

  _onMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'transcript') {
        // A user turn arrived -> barge-in: drop any TTS still queued.
        this._flushPlayback()
        this.h.onTranscript?.(msg)
      } else if (msg.type === 'bot_started_speaking') this.h.onBotSpeaking?.(true)
      else if (msg.type === 'bot_stopped_speaking') this.h.onBotSpeaking?.(false)
      else if (msg.type === 'tool_call') this.h.onToolCall?.(msg)
      else if (msg.type === 'error') this.h.onError?.(msg.error)
      return
    }
    // Binary: PCM16 @ 24k to play.
    this._play(new Int16Array(ev.data))
  }

  _play(int16) {
    const f32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000
    const buf = this.playCtx.createBuffer(1, f32.length, TTS_RATE)
    buf.copyToChannel(f32, 0)
    const node = this.playCtx.createBufferSource()
    node.buffer = buf
    node.connect(this.playCtx.destination)
    const now = this.playCtx.currentTime
    if (this.playHead < now) this.playHead = now
    node.start(this.playHead)
    this.playHead += buf.duration
    this._sources = this._sources || []
    this._sources.push(node)
    node.onended = () => { this._sources = this._sources.filter((s) => s !== node) }
  }

  _flushPlayback() {
    (this._sources || []).forEach((s) => { try { s.stop() } catch {} })
    this._sources = []
    this.playHead = this.playCtx ? this.playCtx.currentTime : 0
  }

  interrupt() {
    this._flushPlayback()
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  stop() {
    this.live = false
    try { this.node?.disconnect() } catch {}
    try { this.src?.disconnect() } catch {}
    this._flushPlayback()
    this.stream?.getTracks().forEach((t) => t.stop())
    try { this.ws?.close() } catch {}
    try { this.ctx?.close() } catch {}
    try { this.playCtx?.close() } catch {}
  }
}
