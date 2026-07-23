// The compact, bilingual flight card — the one the Voice Booking page drops INSIDE the chat
// thread when the agent runs `search_flights` on a live call.
//
// It is deliberately a separate module from the cards on the Flight Booking page. That page
// renders a desktop results LIST: a wide three-column card, a sort bar above it, a search
// panel above that. This one has to survive being a message in a thread on a phone — half
// the height, one column below 520px, and a tap target big enough for a thumb. Sharing one
// renderer between the two would mean a card with two layouts and a flag, which is how both
// end up mediocre.
//
// Everything here is a pure string builder over the SAME tool JSON both paths already carry
// (`tool_calls[].result` from /chat, the `tool_result` socket frame on a call), so the
// caller only has to decide where to put the HTML.
import { esc, hhmm, hm, money, dayLabel } from '../lib/fmt.js'

// The chrome, in both languages. The point of this page is a caller who would rather talk
// than read — and who, if they do read, may only read Arabic. The agent already answers in
// the caller's language; a card that says "Book" underneath an Arabic sentence undoes that.
// Values, not sentences: flight numbers, times and money stay Latin in both.
export const T = {
  en: {
    book: 'Book', cancel: 'Cancel', confirm: 'Confirm', booked: 'Booked',
    nonstop: 'Nonstop', given: 'Given name', surname: 'Surname',
    cheapest: 'Cheapest', fastest: 'Fastest',
    flightsFound: (n) => `${n} flight${n === 1 ? '' : 's'} found`,
    showing: (n, total) => `showing ${n} of ${total}`,
    pnrLabel: 'Booking reference', refundable: 'refundable',
    nonRefundable: 'non-refundable', seatsLeft: (n) => `${n} seat${n === 1 ? '' : 's'} left`,
    bags: (kg) => `${kg} kg bags`, namesRequired: 'Both names are required',
    pnrSub: 'Keep this reference — look the booking up with it and the surname.',
    noFlights: 'No flights on that date.', nearest: 'Nearest departures:',
  },
  ar: {
    book: 'احجز', cancel: 'إلغاء', confirm: 'تأكيد', booked: 'تم الحجز',
    nonstop: 'بدون توقف', given: 'الاسم الأول', surname: 'اسم العائلة',
    cheapest: 'الأرخص', fastest: 'الأسرع',
    flightsFound: (n) => `${n} رحلة متاحة`,
    showing: (n, total) => `${n} من ${total}`,
    pnrLabel: 'رقم الحجز', refundable: 'قابل للاسترداد',
    nonRefundable: 'غير قابل للاسترداد', seatsLeft: (n) => `باقي ${n} مقعد`,
    bags: (kg) => `${kg} كجم أمتعة`, namesRequired: 'لازم الاسمين',
    pnrSub: 'احتفظ برقم الحجز — تقدر تراجع الحجز بيه وباسم العائلة.',
    noFlights: 'مفيش رحلات في اليوم ده.', nearest: 'أقرب رحلات:',
  },
}

export const t = (lang) => T[lang === 'ar' ? 'ar' : 'en']

/** Cheapest fare in the cabin that was searched. `search_flights` already sorts fares by
 *  price, so this is fares[0] — but do not assume it, an empty cabin returns no fares. */
export const cheapestFare = (f) =>
  (f.fares || []).reduce((best, x) => (!best || x.price.amount < best.price.amount ? x : best), null)

/** Tag each flight Cheapest / Fastest. Computed, never invented: cheapest is the lowest fare
 *  in the cabin searched, fastest the shortest block time. Every Nile Air flight in the
 *  schedule is nonstop, so there is no stop count to fake. */
export function decorate(flights, lang = 'en') {
  const L = t(lang)
  const priced = flights.map((f) => cheapestFare(f)?.price.amount ?? Infinity)
  const mins = flights.map((f) => f.duration?.minutes ?? Infinity)
  const cheapIdx = priced.indexOf(Math.min(...priced))
  const fastIdx = mins.indexOf(Math.min(...mins))
  return flights.map((f, i) => {
    const tags = []
    if (i === cheapIdx) tags.push(L.cheapest)
    if (i === fastIdx) tags.push(L.fastest)
    return { f, tag: tags.join(' · ') }
  })
}

/** One flight, as a card in the thread.
 *
 *  `id` is how the page finds this card again later — when the caller says "book that one"
 *  and the agent's own `book_flight` result has to turn THIS card into a PNR. */
export function flightCardHtml(f, { tag = '', pax = 1, cabin = 'economy', lang = 'en', id }) {
  const L = t(lang)
  const fare = cheapestFare(f)
  const total = fare ? { amount: fare.price.amount * pax, currency: fare.price.currency } : null
  const seats = f.seats_available
  const badges = [
    seats <= 5 ? `<span class="badge ${seats === 0 ? 'red' : 'yellow'}">${esc(L.seatsLeft(seats))}</span>` : '',
    f.status && f.status !== 'scheduled' ? `<span class="badge yellow">${esc(f.status)}</span>` : '',
    fare?.baggage ? `<span class="badge gray">${esc(L.bags(fare.baggage.kg))}</span>` : '',
    `<span class="badge ${fare?.refundable ? 'green' : 'gray'}">${esc(fare?.refundable ? L.refundable : L.nonRefundable)}</span>`,
  ].filter(Boolean).join('')

  return `
    <div class="vb-card" data-card="${esc(id)}" data-flight="${esc(f.flight_no.code)}"
         data-date="${esc(f.date.iso)}">
      ${tag ? `<div class="vb-tag">${esc(tag)}</div>` : ''}
      <div class="vb-card-top">
        <div class="vb-airline">
          <span class="vb-logo">NA</span>
          <span class="vb-flightno">${esc(f.flight_no.code)}</span>
        </div>
        <div class="vb-price">
          <div class="vb-amount">${esc(money(total))}</div>
          <div class="vb-per">${pax > 1 ? `${esc(money(fare?.price))} × ${pax}` : esc(fare?.fare_class || cabin)}</div>
        </div>
      </div>
      <div class="vb-route">
        <div class="vb-point">
          <div class="vb-clock">${esc(hhmm(f.departs.iso))}</div>
          <div class="vb-iata">${esc(f.origin.iata)}</div>
        </div>
        <div class="vb-leg">
          <div class="vb-dur">${esc(hm(f.duration?.minutes))}</div>
          <div class="vb-line"><i></i><b></b><i></i></div>
          <div class="vb-stops">${esc(L.nonstop)}</div>
        </div>
        <div class="vb-point">
          <div class="vb-clock">${esc(hhmm(f.arrives.iso))}</div>
          <div class="vb-iata">${esc(f.destination.iata)}</div>
        </div>
      </div>
      <div class="vb-card-foot">
        <div class="vb-meta">${esc(dayLabel(f.date.iso))} · ${badges}</div>
        <button type="button" class="vb-book-btn" data-a="select">${esc(L.book)}</button>
      </div>
      <div class="vb-book" hidden></div>
    </div>`
}

/** The two-field form behind the Book button. Names are prefilled from whatever the agent
 *  has already been told on this call, so the common path is one tap and a confirm. */
export function bookFormHtml({ lang = 'en', given = '', surname = '', price } = {}) {
  const L = t(lang)
  return `
    <div class="vb-book-row">
      <input class="inp" data-f="given" placeholder="${esc(L.given)}" value="${esc(given)}" />
      <input class="inp" data-f="surname" placeholder="${esc(L.surname)}" value="${esc(surname)}" />
    </div>
    <div class="vb-book-row">
      <button type="button" class="btn primary vb-grow" data-a="confirm">
        ${esc(L.confirm)}${price ? ` · ${esc(money(price))}` : ''}
      </button>
      <button type="button" class="btn ghost" data-a="cancel">${esc(L.cancel)}</button>
    </div>
    <div class="login-err" data-f="err"></div>`
}

/** A completed booking. Identical whether the caller tapped Book or the agent called
 *  `book_flight` — same mutation, same PNR, so the same card. */
export function pnrCardHtml(b, lang = 'en') {
  const L = t(lang)
  const fl = b.flight || {}
  const route = [fl.origin, fl.destination].filter(Boolean).join(' → ')
  return `
    <div class="vb-pnr">
      <div class="vb-pnr-label">${esc(L.pnrLabel)}</div>
      <div class="vb-pnr-code">${esc(b.pnr?.code || '')}</div>
      <div class="vb-pnr-sub">
        ${esc(b.passenger_name || '')} · ${esc(fl.flight_no?.code || '')}${route ? ` · ${esc(route)}` : ''}
        · ${esc(dayLabel(fl.date?.iso))} · ${esc(money(b.total_charged))}
      </div>
      <div class="vb-pnr-note">${esc(L.pnrSub)}</div>
    </div>`
}

/** No flights on that date — with the alternatives the agent itself found. The chips are
 *  clickable only when the page can act on them (see voicebooking.js: on a live call there
 *  is no text channel to the model, so they render as plain hints). */
export function emptyHtml(result, lang = 'en', { clickable = true } = {}) {
  const L = t(lang)
  const alts = (result.alternative_dates || [])
    .map((d) => (clickable
      ? `<button type="button" class="vb-chip" data-alt="${esc(d.iso)}">${esc(dayLabel(d.iso))}</button>`
      : `<span class="vb-chip static">${esc(dayLabel(d.iso))}</span>`))
    .join('')
  const msg = lang === 'ar' ? (result.message_ar || L.noFlights) : (result.message_en || L.noFlights)
  return `
    <div class="vb-empty">
      <div class="vb-empty-msg">${esc(msg)}</div>
      ${alts ? `<div class="vb-empty-sub">${esc(L.nearest)}</div>
                <div class="vb-chips">${alts}</div>` : ''}
    </div>`
}

/** The line above a group of cards: how many, on what route, and whether the tool capped
 *  what it returned. It caps at 3 for a day and 8 for a range because the same result is
 *  read aloud on a call — say so rather than implying the schedule is that thin. */
export function resultsHeadHtml(result, lang = 'en') {
  const L = t(lang)
  const n = result.flights?.length || 0
  const total = result.total_found ?? n
  const f0 = result.flights?.[0]
  const city = (a) => (lang === 'ar' ? a.city_ar || a.city_en : a.city_en)
  const route = f0 ? ` · ${esc(city(f0.origin))} → ${esc(city(f0.destination))}` : ''
  const capped = total > n ? ` · ${esc(L.showing(n, total))}` : ''
  return `<div class="vb-results-head"${lang === 'ar' ? ' dir="rtl"' : ''}>`
    + `<b>${esc(L.flightsFound(n))}</b><span>${route}${capped}</span></div>`
}
