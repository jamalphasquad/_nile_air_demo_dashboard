// Flight schedule browser — the whole timetable the agent books against, so the operator
// can pick a flight number/date before driving a demo call. Read-only; filter by route/date.
import { pod } from '../lib/api.js'

const STATUS_BADGE = {
  scheduled: 'gray', boarding: 'blue', delayed: 'yellow',
  departed: 'gray', arrived: 'gray', cancelled: 'red',
}

const timeOf = (iso) => {
  // depart_local is 'YYYY-MM-DDTHH:MM:SS' local to the airport — show HH:MM as stored.
  const t = (iso || '').split('T')[1] || ''
  return t.slice(0, 5)
}

const money = (m) => (m ? `${m.amount.toLocaleString()} ${m.currency}` : '—')
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

export function renderSchedules() {
  const el = document.createElement('div')
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">Flight Schedule</div>
        <div class="card-meta" id="count">—</div>
      </div>
      <form class="row wrap" id="filters" style="gap:8px;margin-bottom:6px">
        <input class="inp" id="origin" placeholder="From (e.g. CAI)" style="max-width:150px" />
        <input class="inp" id="dest" placeholder="To (e.g. DXB)" style="max-width:150px" />
        <input class="inp" id="from" type="date" style="max-width:170px" />
        <input class="inp" id="to" type="date" style="max-width:170px" />
        <button class="btn primary" id="go">Filter</button>
        <button class="btn" id="clear" type="button">Clear</button>
      </form>
      <div class="login-err" id="err"></div>
      <div id="wrap" style="overflow-x:auto"></div>
    </div>`

  const err = el.querySelector('#err')
  const wrap = el.querySelector('#wrap')
  const count = el.querySelector('#count')

  async function load() {
    err.textContent = ''
    wrap.innerHTML = '<div class="card-meta" style="padding:16px">Loading…</div>'
    const params = {
      origin: el.querySelector('#origin').value.trim(),
      destination: el.querySelector('#dest').value.trim(),
      date_from: el.querySelector('#from').value,
      date_to: el.querySelector('#to').value,
    }
    try {
      const { flights } = await pod.listFlights(params)
      count.textContent = `${flights.length} flight${flights.length === 1 ? '' : 's'}`
      if (!flights.length) { wrap.innerHTML = '<div class="card-meta" style="padding:16px">No flights match.</div>'; return }
      const rows = flights.map((f) => {
        const badge = STATUS_BADGE[f.status] || 'gray'
        const seats = f.seats_available === 0
          ? '<span class="badge red">full</span>'
          : esc(f.seats_available)
        return `<tr>
          <td style="font-family:var(--mono)">${esc(f.flight_no)}</td>
          <td>${esc(f.origin)} → ${esc(f.destination)}</td>
          <td>${esc(f.depart_date)}</td>
          <td>${timeOf(f.depart_local)} → ${timeOf(f.arrive_local)}</td>
          <td><span class="badge ${badge}">${esc(f.status)}${f.delay_min ? ` +${f.delay_min}m` : ''}</span></td>
          <td>${seats}</td>
          <td>${esc(money(f.economy_from))}</td>
        </tr>`
      }).join('')
      wrap.innerHTML = `<table class="tbl">
        <thead><tr><th>Flight</th><th>Route</th><th>Date</th><th>Time</th>
          <th>Status</th><th>Seats</th><th>Econ from</th></tr></thead>
        <tbody>${rows}</tbody></table>`
    } catch (ex) {
      wrap.innerHTML = ''
      err.textContent = ex.message
    }
  }

  el.querySelector('#filters').addEventListener('submit', (e) => { e.preventDefault(); load() })
  el.querySelector('#clear').addEventListener('click', () => {
    el.querySelectorAll('.inp').forEach((i) => { i.value = '' }); load()
  })
  load()

  return { el }
}
