// Bookings: an operator browse of every PNR (so you can pick one to reference in a call),
// plus the customer-style lookup that still enforces the PNR + surname auth gate the agent
// uses — the browse is behind the dashboard's own auth, the lookup demonstrates the gate.
import { pod } from '../lib/api.js'

const STATUS_BADGE = {
  confirmed: 'green', pending: 'yellow', cancelled: 'red', flown: 'gray',
}
const money = (m) => (m ? `${m.amount.toLocaleString()} ${m.currency}` : '—')
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function routeLine(segments) {
  if (!segments || !segments.length) return '—'
  return segments
    .map((s) => `${s.origin}→${s.destination} ${s.depart_date} (${s.flight_no})`)
    .join(' · ')
}

export function renderBookings() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">All Bookings</div>
        <div class="card-meta" id="count">—</div>
      </div>
      <div class="card-meta" style="margin:-4px 0 10px">
        Click a row to load it into the lookup below.
      </div>
      <div id="wrap" style="overflow-x:auto"></div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><div class="card-title">Booking Lookup</div>
        <div class="card-meta">PNR + surname required (auth gate)</div></div>
      <form class="row wrap" id="form">
        <input class="inp" id="pnr" placeholder="PNR (e.g. BV3Z6L)" style="max-width:200px" />
        <input class="inp" id="surname" placeholder="Surname" style="max-width:240px" />
        <button class="btn primary" id="go">Look up</button>
      </form>
      <div class="login-err" id="err" style="margin-top:12px"></div>
      <div id="result" style="margin-top:16px"></div>
    </div>`

  const wrap = el.querySelector('#wrap')
  const count = el.querySelector('#count')
  const err = el.querySelector('#err')
  const result = el.querySelector('#result')
  const pnrInput = el.querySelector('#pnr')
  const surnameInput = el.querySelector('#surname')

  async function loadList() {
    wrap.innerHTML = '<div class="card-meta" style="padding:16px">Loading…</div>'
    try {
      const { bookings } = await pod.listBookings()
      count.textContent = `${bookings.length} booking${bookings.length === 1 ? '' : 's'}`
      if (!bookings.length) { wrap.innerHTML = '<div class="card-meta" style="padding:16px">No bookings yet.</div>'; return }
      const rows = bookings.map((b) => {
        const badge = STATUS_BADGE[b.status] || 'gray'
        return `<tr class="bk-row" data-pnr="${esc(b.pnr)}" data-surname="${esc(b.surname)}" style="cursor:pointer">
          <td style="font-family:var(--mono)">${esc(b.pnr)}</td>
          <td>${esc(b.passenger)}</td>
          <td><span class="badge ${badge}">${esc(b.status)}</span></td>
          <td>${esc(money(b.total))}</td>
          <td style="font-size:12px;color:var(--ink-2)">${esc(routeLine(b.segments))}</td>
        </tr>`
      }).join('')
      wrap.innerHTML = `<table class="tbl">
        <thead><tr><th>PNR</th><th>Passenger</th><th>Status</th><th>Total</th><th>Itinerary</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      wrap.querySelectorAll('.bk-row').forEach((tr) => {
        tr.addEventListener('click', () => {
          pnrInput.value = tr.dataset.pnr
          surnameInput.value = tr.dataset.surname
          lookup()
        })
      })
    } catch (ex) {
      wrap.innerHTML = ''
      err.textContent = ex.message
    }
  }

  async function lookup() {
    err.textContent = ''; result.innerHTML = ''
    const pnr = pnrInput.value.trim()
    const surname = surnameInput.value.trim()
    if (!pnr || !surname) { err.textContent = 'Both fields required'; return }
    try {
      const b = await pod.getBooking(pnr, surname)
      result.innerHTML = `<pre class="log">${esc(JSON.stringify(b, null, 2))}</pre>`
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (ex) {
      // Wrong surname and missing PNR return the same message by design (no enumeration).
      err.textContent = ex.message
    }
  }

  el.querySelector('#form').addEventListener('submit', (e) => { e.preventDefault(); lookup() })
  loadList()

  return { el }
}
