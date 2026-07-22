// Text chat: same model + tools, no audio. Shows the tool-call trace so tool calling is
// visible without a microphone — the fastest way to demo the agent on stage.
import { pod } from '../lib/api.js'
import { esc, isArabic, traceLine } from '../lib/fmt.js'

export function renderChat() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><div class="card-title">Text Chat</div>
        <div class="card-meta" id="model">—</div></div>
      <div class="transcript" id="log" style="max-height:460px"></div>
      <form class="row" id="form" style="margin-top:14px">
        <input class="inp" id="msg" placeholder="اكتب رسالتك… or type in English" autocomplete="off" />
        <button class="btn primary" id="send">Send</button>
      </form>
    </div>`

  const log = el.querySelector('#log')
  const form = el.querySelector('#form')
  const input = el.querySelector('#msg')
  const modelEl = el.querySelector('#model')

  // The running thread, sent back each turn so the agent can carry a booking flow across
  // messages (search -> choose -> book), exactly like the voice path.
  const history = []

  const add = (cls, who, text) => {
    const d = document.createElement('div')
    d.className = `turn ${cls}`
    const rtl = isArabic(text) ? ' dir="rtl"' : ''
    d.innerHTML = `<div class="who">${esc(who)}</div><div${rtl}>${esc(text)}</div>`
    log.appendChild(d); log.scrollTop = log.scrollHeight
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    add('user', 'you', text)
    input.value = ''
    const sendBtn = el.querySelector('#send')
    sendBtn.disabled = true
    try {
      const r = await pod.chat(text, history)
      modelEl.textContent = r.model || ''
      for (const tc of (r.tool_calls || [])) add('tool', 'tool call', traceLine(tc))
      if (r.text) add('bot', 'agent', r.text)
      // Record the plain turn pair for the next message's context.
      history.push({ role: 'user', content: text })
      if (r.text) history.push({ role: 'assistant', content: r.text })
    } catch (ex) {
      add('tool', 'error', ex.message)
    } finally {
      sendBtn.disabled = false
      input.focus()
    }
  })

  return { el }
}
