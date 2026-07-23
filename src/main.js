import './styles/main.css'
import { isAuthed } from './lib/session.js'
import { renderSidebar, wireSidebar } from './components/sidebar.js'
import { ec2, currentStack, isCloud } from './lib/api.js'
import { renderLogin } from './views/login.js'
import { renderDemo } from './views/demo.js'
import { renderChat } from './views/chat.js'
import { renderBooking } from './views/booking.js'
import { renderVoiceBooking } from './views/voicebooking.js'
import { renderPhoneCalls } from './views/phone.js'
import { renderPod } from './views/pod.js'
import { renderModels } from './views/models.js'
import { renderVoices } from './views/voices.js'
import { renderPrompt } from './views/prompt.js'
import { renderKb } from './views/kb.js'
import { renderBookings } from './views/bookings.js'
import { renderSchedules } from './views/schedules.js'

const app = document.getElementById('app')

const ROUTES = {
  '/': { title: 'Voice Call', view: renderDemo },
  '/chat': { title: 'Text Chat', view: renderChat },
  '/booking': { title: 'Book a Flight', view: renderBooking },
  '/voice-booking': { title: 'Book by Voice', view: renderVoiceBooking },
  '/phone-calls': { title: 'Phone Calls', view: renderPhoneCalls },
  '/pod': { title: 'Pod', view: renderPod },
  '/models': { title: 'Models', view: renderModels },
  '/voices': { title: 'Voices', view: renderVoices },
  '/prompt': { title: 'System Prompt', view: renderPrompt },
  '/kb': { title: 'Knowledge Base', view: renderKb },
  '/schedules': { title: 'Flight Schedule', view: renderSchedules },
  '/bookings': { title: 'Bookings', view: renderBookings },
}

let currentView = null
let renderGen = 0        // bumped each render, so stale async status updates are ignored

function path() { return location.hash.replace(/^#/, '') || '/' }

async function podStatus() {
  // Sidebar status card: reflects the EC2 view of the SELECTED provider, refreshed on each
  // render. Naming the provider matters now that three exist and two pods can be running at
  // once — otherwise "Pod — running" is ambiguous about which one you are driving.
  const stack = currentStack()
  // The cloud provider has no pod to ask about: /pods/cloud-realtime/status is a 404 by
  // design, since the EC2 tier refuses to guess at an unknown stack id rather than falling
  // back to a billable one. Answer from what is already known instead of probing.
  if (isCloud()) {
    return { dot: 'green', title: 'cloud realtime', sub: 'no GPU · pay per use' }
  }
  try {
    const s = await ec2.status(stack)
    if (!s.exists) return { dot: 'gray', title: `${stack} — none`, sub: 'not started' }
    const dot = s.state === 'RUNNING' ? 'green' : s.state === 'EXITED' ? 'gray' : 'yellow'
    return { dot, title: `${stack} — ${s.state.toLowerCase()}`, sub: s.cost_per_hr ? `$${s.cost_per_hr}/hr` : s.id || '' }
  } catch { return { dot: 'red', title: `${stack} — unreachable`, sub: 'check EC2 control' } }
}

function renderShell() {
  const p = path()
  const route = ROUTES[p] || ROUTES['/']
  const now = new Date()
  const meta = `<span class="live">●</span> LIVE · ${now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}`

  app.innerHTML = `
    <div class="app">
      <div id="side"></div>
      <div class="main">
        <div class="topbar">
          <div class="page-title">${route.title}</div>
          <div class="topbar-meta">${meta}</div>
        </div>
        <div class="content" id="content"></div>
      </div>
    </div>`

  // Draw the sidebar synchronously with a placeholder status, so the view is mounted
  // exactly once and there is no await between building #content and appending into it.
  // (An await here let two concurrent renders both append, showing the view twice.)
  const side = app.querySelector('#side')
  side.innerHTML = renderSidebar(p, { dot: 'gray', title: 'Pod — …', sub: 'checking' })
  wireSidebar(side)

  currentView?.cleanup?.()
  currentView = route.view()
  app.querySelector('#content').appendChild(currentView.el)

  // Fill in the real pod status after the fact, updating only the sidebar. Guard with a
  // token so a stale status call cannot overwrite a newer render's sidebar.
  const gen = ++renderGen
  podStatus().then((status) => {
    if (gen !== renderGen) return
    const s = app.querySelector('#side')
    if (s) { s.innerHTML = renderSidebar(p, status); wireSidebar(s) }
  })
}

function route() {
  if (!isAuthed()) {
    currentView?.cleanup?.()
    currentView = null
    renderGen++          // invalidate any in-flight status update
    app.innerHTML = ''
    app.appendChild(renderLogin(afterLogin))
    return
  }
  renderShell()
}

function afterLogin() {
  // Trigger exactly one render: either the hashchange handler (if the hash actually
  // changes) or a direct call (if we are already on '#/'). Never both.
  if (location.hash !== '#/') location.hash = '#/'
  else route()
}

window.addEventListener('hashchange', route)
route()
