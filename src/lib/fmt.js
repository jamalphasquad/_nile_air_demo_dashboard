// Small display helpers shared by the views that render agent output.

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

/** True if the text contains Arabic script, so the bubble needs dir="rtl". */
export const isArabic = (s) => /[؀-ۿ]/.test(String(s ?? ''))

// Compact one-liner for a tool call + whether its result came back ok. Shared by Text Chat
// and Flight Booking so the trace reads identically wherever the agent is driven from.
export function traceLine(tc) {
  const args = tc.args ? JSON.stringify(tc.args) : ''
  const r = tc.result || {}
  let outcome = ''
  if (r.ok === false) outcome = ` ✗ ${r.message_en || r.error || 'failed'}`
  else if (Array.isArray(r.flights)) outcome = ` → ${r.flights.length} flight(s)`
  else if (r.action) outcome = ` → ${r.action}${r.pnr?.code ? ` ${r.pnr.code}` : ''}`
  else if (r.ok) outcome = ' ✓'
  return `${tc.name}(${args})${outcome}`
}

/** 'YYYY-MM-DDTHH:MM(:SS)' -> 'HH:MM'. The domain layer hands back an `iso` field beside
 *  every spoken string precisely so the UI never has to parse the spoken one. */
export const hhmm = (iso) => ((iso || '').split('T')[1] || '').slice(0, 5)

export const money = (m) => (m ? `${m.amount.toLocaleString()} ${m.currency}` : '—')

/** 195 -> '3h 15m' */
export function hm(minutes) {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** 'YYYY-MM-DD' -> 'Fri, 1 Aug'. Parsed as UTC so the label cannot slide a day. */
export function dayLabel(isoDate) {
  if (!isoDate) return '—'
  const d = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return isoDate
  return d.toLocaleDateString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
