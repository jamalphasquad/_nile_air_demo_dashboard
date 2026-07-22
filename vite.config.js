import { defineConfig } from 'vite'

// The dashboard talks to two backends, both configurable so the same build runs against
// localhost during development and the real hosts in the demo:
//   VITE_EC2_URL  — Tier-1 lifecycle + auth (the always-on EC2 box)
//   VITE_POD_URL  — Tier-2 control + the audio WebSocket (the RunPod pod, via Caddy TLS)
// Audio goes browser -> pod directly; never through EC2 (a continent away).
export default defineConfig({
  server: { port: 5173, host: true },
  build: { outDir: 'dist', sourcemap: false },
})
