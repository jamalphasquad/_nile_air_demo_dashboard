// Backend endpoints, from Vite env. Two backends by design (see vite.config.js):
// EC2 = auth + pod lifecycle; POD = model control + audio.
export const EC2_URL = (import.meta.env.VITE_EC2_URL || 'http://localhost:9100').replace(/\/$/, '')
export const POD_URL = (import.meta.env.VITE_POD_URL || 'http://localhost:9000').replace(/\/$/, '')

// Audio WebSocket. If not set, derive from POD_URL by swapping http->ws and pointing at
// the bot's /ws. In the demo Caddy terminates TLS so this becomes wss://pod-fqdn/ws.
export const WS_URL = (import.meta.env.VITE_WS_URL
  || POD_URL.replace(/^http/, 'ws')) + '/ws'

// Audio contract, fixed by the pipeline: 16k mic up, 24k TTS down, PCM16 mono.
export const MIC_RATE = 16000
export const TTS_RATE = 24000
