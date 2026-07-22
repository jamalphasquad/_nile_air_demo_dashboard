import { icons } from './icons.js'
import { logout } from '../lib/session.js'

const NAV = [
  { section: 'Demo' },
  { path: '/', label: 'Voice Call', icon: 'phone' },
  { path: '/chat', label: 'Text Chat', icon: 'chat' },
  { path: '/booking', label: 'Flight Booking', icon: 'plane' },
  { section: 'Control' },
  { path: '/pod', label: 'Pod', icon: 'server' },
  { path: '/models', label: 'Models', icon: 'cpu' },
  { path: '/voices', label: 'Voices', icon: 'mic' },
  { section: 'Admin' },
  { path: '/prompt', label: 'System Prompt', icon: 'doc' },
  { path: '/kb', label: 'Knowledge Base', icon: 'book' },
  { path: '/schedules', label: 'Flight Schedule', icon: 'calendar' },
  { path: '/bookings', label: 'Bookings', icon: 'ticket' },
]

// `status` = { dot: 'green'|'red'|'yellow'|'gray', title, sub }
export function renderSidebar(activePath, status) {
  const items = NAV.map((n) => {
    if (n.section) return `<div class="nav-section">${n.section}</div>`
    const active = n.path === activePath ? ' active' : ''
    return `<a href="#${n.path}" class="nav-item${active}">${icons[n.icon]}<span>${n.label}</span></a>`
  }).join('')

  const s = status || { dot: 'gray', title: 'Pod — unknown', sub: 'checking…' }
  return `
    <aside class="sidebar">
      <div class="brand">nile<small>air</small></div>
      <div class="org">
        <div class="org-avatar">NA</div>
        <div>
          <div class="org-name">Nile Air</div>
          <div class="org-sub">Voice Agent · AR / EN</div>
        </div>
      </div>
      <nav class="nav">${items}</nav>
      <div class="sidebar-foot">
        <div class="status-card">
          <div class="status-title"><span class="dot ${s.dot}"></span>${s.title}</div>
          <div class="status-sub">${s.sub}</div>
        </div>
        <button class="nav-item" id="logout-btn" style="margin-top:10px">${icons.logout}<span>Sign out</span></button>
      </div>
    </aside>`
}

export function wireSidebar(root) {
  root.querySelector('#logout-btn')?.addEventListener('click', logout)
}
