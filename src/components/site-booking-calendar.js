/**
 * src/components/site-booking-calendar.js — the Website Assistant's Calendar tab (owner, 2026-10-17).
 *
 * Availability and bookings on one month grid, so "am I full?" is a glance:
 *   each day   — the hours bookings are taken, then "n booked · n free" (or "Fully booked", "Closed")
 *   classes    — "10:00 Yoga 3 of 12", amber when full
 *   bookings   — "2:00pm Sam P · Cut", by status; open one to confirm, decline or cancel it
 * On a phone it is a list of days instead of a grid.
 *
 *   window.SiteBookingCalendar.mount(host, { assistantId })
 *
 * Data: sites.ts `calendar` (booking-calendar.ts). Decisions: sites.ts `booking_decide` — the same
 * path as the Bookings tab, so the customer is told in exactly the same way. Handlers are bound once,
 * to the document, and find their calendar by the host's data attribute.
 */
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const STATUS = {
    pending: ['to confirm', 'bg-amber-50 border-amber-300 text-amber-900'],
    confirmed: ['confirmed', 'bg-green-50 border-green-300 text-green-700'],
    awaiting_payment: ['deposit not paid yet', 'bg-gray-50 border-gray-300 text-gray-700'],
  };
  const cals = new Map();
  let nextId = 1;

  const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const monthTitle = (y, m) => new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const longDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  async function post(body) {
    const r = await fetch('/.netlify/functions/sites', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }

  /** The six weeks the month grid shows, Monday first. */
  function gridRange(y, m) {
    const first = new Date(Date.UTC(y, m, 1));
    const back = (first.getUTCDay() + 6) % 7;
    const from = addDays(iso(first), -back);
    return { from, to: addDays(from, 41) };
  }

  async function load(cal) {
    cal.loading = true; render(cal);
    const { from, to } = gridRange(cal.year, cal.month);
    try { cal.data = await post({ action: 'calendar', assistantId: cal.assistantId, from, to }); cal.error = null; }
    catch (err) { cal.error = err.message; }
    cal.loading = false; render(cal);
  }

  function availabilityHtml(day) {
    if (day.closedNote) return `<p class="text-[11px] text-gray-400">${esc(day.closedNote)}</p>`;
    if (!day.hours) return '<p class="text-[11px] text-gray-400">Not taking bookings</p>';
    const count = day.free == null
      ? (day.booked ? `<span class="font-bold">${day.booked} booked</span>` : '')
      : day.free === 0
        ? '<span class="font-bold text-red-700">Fully booked</span>'
        : `<span class="font-bold text-green-700">${day.booked} booked · ${day.free} free</span>`;
    return `<p class="text-[11px] text-gray-500">${esc(day.hours)}</p>${count ? `<p class="text-[11px]">${count}</p>` : ''}`;
  }
  function sessionChip(s) {
    const full = s.left === 0;
    return `<button type="button" data-sbc-session="${esc(s.id)}" class="w-full text-left text-[11px] leading-tight border rounded px-1.5 py-1 mt-1 ${full ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-indigo-50 border-indigo-200 text-indigo-900'} ${s.status === 'cancelled' ? 'line-through opacity-60' : ''}">
      <span class="font-bold">${esc(s.timeText.split('–')[0])}</span> ${esc(s.title)} · <span class="font-bold">${esc(s.taken)} of ${esc(s.capacity)}</span></button>`;
  }
  function bookingChip(b) {
    const [, cls] = STATUS[b.status] || ['', 'bg-white border-gray-200'];
    return `<button type="button" data-sbc-booking="${esc(b.id)}" class="w-full text-left text-[11px] leading-tight border rounded px-1.5 py-1 mt-1 ${cls}">
      <span class="font-bold">${esc(b.time)}</span> ${esc(b.customerName)} · ${esc(b.what)}</button>`;
  }

  function render(cal) {
    if (!cal.host || !document.body.contains(cal.host)) return;
    const d = cal.data;
    const head = `<div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2">
          <button type="button" data-sbc-nav="-1" class="btn-secondary border px-2.5 py-1 text-xs font-bold rounded-lg" aria-label="Previous month">‹</button>
          <p class="text-base font-black text-gray-900 text-center" style="min-width:9rem">${esc(monthTitle(cal.year, cal.month))}</p>
          <button type="button" data-sbc-nav="1" class="btn-secondary border px-2.5 py-1 text-xs font-bold rounded-lg" aria-label="Next month">›</button>
          <button type="button" data-sbc-nav="0" class="btn-utility px-2.5 py-1 text-xs font-bold rounded-lg">Today</button>
        </div>
        <p class="text-[11px] text-gray-500">${d && d.countedIn ? `Free = ${esc(d.countedIn)} still bookable. ` : ''}Open a booking to confirm, decline or cancel it.</p>
      </div>`;
    if (cal.error) { cal.host.innerHTML = `<div data-sbc="${cal.id}">${head}<p class="text-sm text-red-600">${esc(cal.error)}</p></div>`; return; }
    if (!d) { cal.host.innerHTML = `<div data-sbc="${cal.id}">${head}<p class="text-sm text-gray-400">Loading…</p></div>`; return; }
    const inMonth = (date) => Number(date.slice(5, 7)) - 1 === cal.month;
    const itemsOf = (date) => [
      ...d.sessions.filter((s) => s.date === date).map((s) => ({ at: s.startsAt, html: sessionChip(s) })),
      ...d.bookings.filter((b) => b.date === date).map((b) => ({ at: b.startsAt, html: bookingChip(b) })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1)).map((x) => x.html).join('');
    const narrow = cal.host.clientWidth && cal.host.clientWidth < 640;
    let body;
    if (narrow) {
      // A phone: the month's days that have hours or something on, as a list.
      // Past days only when something happened on them.
      const days = d.days.filter((day) => inMonth(day.date) && (itemsOf(day.date) || (day.date >= d.today && (day.hours || day.closedNote))));
      body = `<ul class="space-y-2">${days.map((day) => `<li class="bg-white border border-gray-200 rounded-xl p-3" ${day.date === d.today ? 'style="border-color:#D6006B"' : ''}>
          <p class="text-sm font-bold text-gray-900">${esc(longDate(day.date))}</p>${availabilityHtml(day)}${itemsOf(day.date)}</li>`).join('') || '<li class="text-sm text-gray-500">Nothing this month.</li>'}</ul>`;
    } else {
      body = `<div class="grid grid-cols-7 bg-gray-200 border border-gray-200 rounded-xl overflow-hidden" style="gap:1px">
        ${DAY_NAMES.map((n) => `<div class="bg-gray-50 text-[11px] font-bold text-gray-500 px-2 py-1">${n}</div>`).join('')}
        ${d.days.map((day) => `<div class="bg-white p-1.5 ${inMonth(day.date) ? '' : 'opacity-50'}" style="min-height:110px;min-width:0">
            <p class="text-xs font-bold ${day.date === d.today ? 'inline-flex items-center justify-center w-6 h-6 rounded-full bg-pink-600 text-white' : 'text-gray-700'}">${Number(day.date.slice(8))}</p>
            ${availabilityHtml(day)}${itemsOf(day.date)}</div>`).join('')}
      </div>`;
    }
    cal.host.innerHTML = `<div data-sbc="${cal.id}">${head}${cal.loading ? '<p class="text-xs text-gray-400 mb-2">Updating…</p>' : ''}${body}</div>`;
  }

  const calOf = (el) => { const h = el.closest('[data-sbc]'); return h ? cals.get(Number(h.dataset.sbc)) : null; };

  async function openBooking(cal, b) {
    const [label] = STATUS[b.status] || [b.status];
    const lines = [
      `<strong>${esc(b.what)}</strong>${b.with ? ` with ${esc(b.with)}` : ''}`,
      `${esc(longDate(b.date))}, ${esc(b.time)}–${esc(b.endTime)}${b.kind === 'table' ? ` · ${esc(b.partySize)} people` : ''}`,
      `${esc(b.customerName)} · <a href="mailto:${esc(b.customerEmail)}" style="text-decoration:underline">${esc(b.customerEmail)}</a>${b.customerPhone ? ` · ${esc(b.customerPhone)}` : ''}`,
      b.notes ? `“${esc(b.notes)}”` : '',
      b.deposit ? esc(b.deposit) : '',
      `Status: <strong>${esc(label)}</strong>`,
    ].filter(Boolean).join('<br>');
    const options = b.status === 'pending'
      ? [{ label: 'Confirm it', description: 'They get a confirmation email with a calendar invite.', value: 'confirm' }, { label: 'Decline it', description: 'They are told you can\'t do that time. Any deposit is refunded.', value: 'decline' }]
      : [{ label: 'Cancel it', description: 'They are told it is cancelled. Any deposit is refunded.', value: 'cancel' }];
    const decision = await window.choiceModal(lines, options, { title: 'Booking', cancelLabel: 'Close' });
    if (!decision) return;
    if (decision === 'cancel') {
      const sure = await window.confirmModal(`Cancel ${esc(b.customerName)}'s booking? They will be emailed.`, { title: 'Cancel this booking?', confirmLabel: 'Cancel booking', cancelLabel: 'Keep it' });
      if (!sure) return;
    }
    try {
      await post({ action: 'booking_decide', assistantId: cal.assistantId, id: b.id, decision });
      window.showToast?.(decision === 'confirm' ? 'Confirmed — they have been emailed.' : decision === 'decline' ? 'Declined — they have been told.' : 'Cancelled — they have been told.');
    } catch (err) { window.alertModal?.(esc(err.message)); }
    load(cal);
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('[data-sbc-nav], [data-sbc-booking], [data-sbc-session]');
    if (!t) return;
    const cal = calOf(t);
    if (!cal) return;
    if (t.dataset.sbcNav != null) {
      const step = Number(t.dataset.sbcNav);
      if (step === 0) { const n = new Date(); cal.year = n.getFullYear(); cal.month = n.getMonth(); }
      else { const m = cal.month + step; cal.year += Math.floor(m / 12); cal.month = ((m % 12) + 12) % 12; }
      load(cal);
      return;
    }
    if (t.dataset.sbcBooking) {
      const b = cal.data && cal.data.bookings.find((x) => String(x.id) === t.dataset.sbcBooking);
      if (b) openBooking(cal, b);
      return;
    }
    const s = cal.data && cal.data.sessions.find((x) => String(x.id) === t.dataset.sbcSession);
    if (!s) return;
    const go = await window.choiceModal(`<strong>${esc(s.title)}</strong>${s.resourceName ? ` with ${esc(s.resourceName)}` : ''}<br>${esc(s.dateText)}, ${esc(s.timeText)}<br><strong>${esc(s.taken)} of ${esc(s.capacity)}</strong> places booked${s.left ? ` · ${esc(s.left)} left` : ' · full'}`,
      [{ label: 'See who\'s booked', description: 'On the Bookings tab, under Availability — and cancel the date there if you need to.', value: 'open' }], { title: 'Class or event', cancelLabel: 'Close' });
    if (go === 'open') window._activateMainTab?.('sitebookings');
  });

  // Re-lay out between grid and list when the width changes across the phone breakpoint.
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => cals.forEach(render), 150); });

  function mount(host, opts) {
    if (!host) return null;
    const prev = Number(host.dataset.sbcHost);
    if (prev) cals.delete(prev);
    const now = new Date();
    const cal = { id: nextId++, host, assistantId: Number(opts.assistantId), year: now.getFullYear(), month: now.getMonth(), data: null, error: null, loading: false };
    host.dataset.sbcHost = String(cal.id);
    cals.set(cal.id, cal);
    load(cal);
    return { refresh: () => load(cal) };
  }

  window.SiteBookingCalendar = { mount };
})();
