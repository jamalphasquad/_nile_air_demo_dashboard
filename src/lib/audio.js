// Voice call over the raw-PCM WebSocket the bot serializer speaks.
//   up:   mic (browser rate, usually 48k) -> downsample to 16k -> PCM16 -> binary frame
//   down: binary frame = PCM16 @ 24k -> scheduled playback
//   control: JSON text frames both ways (transcript, bot speaking, error, interrupt)
//
// ScriptProcessorNode is used for capture: deprecated but universally available with no
// separate worklet file, which is the right trade for a single-call demo.
import { MIC_RATE, TTS_RATE } from './config.js'

export function floatTo16k(input, inRate) {
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
        // Barge-in: a USER turn means drop any TTS still queued.
        //
        // Only a user turn. This used to flush unconditionally, but the bot emits its OWN
        // transcript (role: 'assistant') the moment the LLM response completes — while the
        // TTS audio for that very sentence is still streaming and queued. Flushing there
        // cut the agent off mid-sentence, every single time it spoke.
        if (msg.role !== 'assistant') this._flushPlayback()
        this.h.onTranscript?.(msg)
      // Both spellings: ours uses underscores, Pipecat's RTVI protocol uses hyphens and
      // is what actually arrives on the wire in 1.5. Accepting both keeps the speaking
      // indicator working regardless of which layer emits the event.
      } else if (msg.type === 'bot_started_speaking' || msg.type === 'bot-started-speaking') {
        this.h.onBotSpeaking?.(true)
      } else if (msg.type === 'bot_stopped_speaking' || msg.type === 'bot-stopped-speaking') {
        this.h.onBotSpeaking?.(false)
      }
      else if (msg.type === 'tool_call') this.h.onToolCall?.(msg)
      // TWO error shapes arrive on this socket and they are not the same object.
      //   ours (bot/serializer.py):  {type: 'error', error: '...'}
      //   Pipecat's RTVI protocol:   {label: 'rtvi-ai', type: 'error', data: {error: '...'}}
      // Reading only `msg.error` rendered the RTVI one as the literal string "undefined",
      // which is how a perfectly clear "Cannot connect to host 127.0.0.1:8010" reached the
      // operator as no information at all. Take whichever field is actually present, and
      // fall back to the raw payload rather than ever showing "undefined" again.
      else if (msg.type === 'error') {
        this.h.onError?.(
          msg.error ?? msg.data?.error ?? msg.data?.message ?? JSON.stringify(msg))
      }
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

// Push-to-talk: capture one utterance, hand back the PCM, done. No socket and no playback
// — the Flight Booking page wants a transcript in a text box, not a conversation, so this
// records to memory and lets the caller POST it to the pod's STT route.
//
// Deliberately the SAME capture path as VoiceCall above (getUserMedia -> ScriptProcessor ->
// floatTo16k), because the pod's STT host is fixed at 16 kHz mono PCM16 and a second,
// subtly different encoder is how the two paths would drift.
export class PushToTalk {
  /** `onLevel(0..1)` fires per audio block with the loudness of that block, so the UI can
   *  show a meter that actually reacts to the caller's voice. A canned CSS loop animates
   *  identically whether the mic is picking anything up or not, which is the one thing the
   *  person needs to know. */
  constructor({ onLevel } = {}) {
    this.stream = null
    this.ctx = null
    this.src = null
    this.node = null
    this.chunks = []
    this.recording = false
    this.onLevel = onLevel
  }

  async start() {
    this.chunks = []
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.ctx = new AudioContext()
    this.src = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => {
      if (!this.recording) return
      const raw = e.inputBuffer.getChannelData(0)
      this.chunks.push(floatTo16k(raw, this.ctx.sampleRate))
      if (!this.onLevel) return
      // RMS, then a gentle curve: speech sits low in linear amplitude, so a raw RMS meter
      // looks almost flat while someone is plainly talking.
      let sum = 0
      for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i]
      const rms = Math.sqrt(sum / raw.length)
      this.onLevel(Math.min(1, (rms ** 0.5) * 3))
    }
    this.src.connect(this.node)
    this.node.connect(this.ctx.destination)  // required for onaudioprocess to fire
    this.recording = true
  }

  /** Stop capture and return the whole utterance as one Int16Array (empty if silent). */
  stop() {
    this.recording = false
    try { this.node?.disconnect() } catch {}
    try { this.src?.disconnect() } catch {}
    this.stream?.getTracks().forEach((t) => t.stop())
    try { this.ctx?.close() } catch {}
    this.ctx = this.src = this.node = this.stream = null

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Int16Array(total)
    let at = 0
    for (const c of this.chunks) { out.set(c, at); at += c.length }
    this.chunks = []
    return out
  }
}
