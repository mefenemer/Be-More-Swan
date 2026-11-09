// src/utils/site-stay-booking.ts — booking a holiday let or B&B room on a hosted site, at /_book?stay=<id>.
// docs/holiday-lets-plan.md §4. tests/site-stays.test.ts. Reached from site-booking.ts (bookStep /
// bookSubmit / the manage link) whenever the request is about a stay.
//
// No script, like every booking step: 1. dates, guests (and rooms) → 2. the price line by line, the
// payment plan, the rules, and your details → POST. Only the POST changes anything; then stays.ts
// createStay re-checks the rules, the rooms and the price under the bookings lock.
//
// Everything offered is read from Business Information ▸ Stays — the query string only says which
// stay and which dates, and each is checked again before it is used.

import type { BookCtx, BookPage } from './site-booking';
import { page, BOOK_LIMITS, BOOK_MIN_FILL_MS } from './site-booking';
import { BOOK_PATH, esc, FORM_SENT_PATH } from './site-render';
import { DATE_RE, formatDate, utcToZoned } from './booking-time';
import { businessTimezone, createStay, loadHolds, loadStays, pricingOf, type LoadedStay } from './stays';
import { describeCancellation, describePayment, quoteStay, type StayQuote } from './stay-quote';
import { assignUnits } from './stay-availability';
import { formatMoney } from './product-price';
import { connectAccountFor } from './site-shop';
import { releaseHold } from './booking-deposits';
import { balanceCharge, chargeNow, refundStayParts, startBalanceCheckout, startStayCheckout, stayRefundFor } from './stay-charges';
import { announceCustomerChange, announceNewBooking, customerCancel, describeBooking, emailKey, fromLine, loadBooking, type BookingRow } from './bookings';
import { stayPagePath } from './site-stays';
import { checkRateLimit } from './rate-limit';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { cleanText } from './site-definition';
import { sendEmail } from './email';
import { verifyBookingToken } from './booking-links';

export interface StayChoice { stay: number | null; in: string | null; out: string | null; guests: number; rooms: number; extras: number[]; }

export function readStayChoice(q: URLSearchParams): StayChoice {
    const n = (k: string, max: number) => { const v = Number(q.get(k)); return Number.isInteger(v) && v > 0 && v <= max ? v : null; };
    const date = (k: string) => (DATE_RE.test(String(q.get(k))) ? String(q.get(k)) : null);
    const extras = [...new Set(q.getAll('x').flatMap((v) => v.split(',')).map(Number).filter((v) => Number.isInteger(v) && v > 0))].slice(0, 20);
    return { stay: n('stay', 1e9), in: date('in'), out: date('out'), guests: n('guests', 500) ?? 0, rooms: n('rooms', 100) ?? 1, extras };
}

export function stayLink(c: StayChoice, over: Partial<StayChoice> = {}): string {
    const m = { ...c, ...over };
    const q = new URLSearchParams();
    if (m.stay) q.set('stay', String(m.stay));
    if (m.in) q.set('in', m.in);
    if (m.out) q.set('out', m.out);
    if (m.guests) q.set('guests', String(m.guests));
    if (m.rooms > 1) q.set('rooms', String(m.rooms));
    if (m.extras.length) q.set('x', m.extras.join(','));
    return `${BOOK_PATH}?${q.toString()}`;
}

const notFound = (b: BookCtx) => page(b, 'Not available', '<h1>This place isn\'t taking bookings</h1><p>It may have changed since you opened the page.</p><p><a class="btn" href="/">Go to the home page</a></p>', 404);

async function stayFor(b: BookCtx, id: number | null): Promise<LoadedStay | null> {
    if (!id) return null;
    const [s] = await loadStays(b.db, b.site.organisationId, { activeOnly: true, ids: [id] });
    return s ?? null;
}

/** The quote for these choices, with whether rooms are free — exactly what createStay will check. */
async function priced(b: BookCtx, s: LoadedStay, c: StayChoice): Promise<{ ok: true; quote: StayQuote } | { ok: false; message: string }> {
    const today = utcToZoned(b.now, await businessTimezone(b.db, b.site.organisationId)).date;
    const rooms = s.row.stayType === 'whole' ? 1 : c.rooms;
    const r = quoteStay(pricingOf(s), { checkIn: c.in!, checkOut: c.out!, guests: c.guests, rooms, extras: c.extras, today }, { minNoticeDays: s.row.minNoticeDays, maxAdvanceDays: s.row.maxAdvanceDays });
    if (!r.ok) return r;
    const holds = await loadHolds(b.db, b.site.organisationId, s.units.map((u) => u.id), c.in!, c.out!, s.row.gapNights + 1);
    if (!assignUnits(s.units, holds, c.in!, c.out!, rooms, s.row.gapNights)) {
        return { ok: false, message: rooms > 1 ? `There aren't ${rooms} rooms free for all of those nights. Try fewer rooms or other dates.` : 'Those dates aren\'t free. Please choose others — the calendar shows which nights are open.' };
    }
    return r;
}

function quoteTable(q: StayQuote): string {
    const m = (n: number) => esc(formatMoney(n, q.currency));
    return `<table class="qt">${q.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${m(l.amount)}</td></tr>`).join('')}<tr class="tot"><td>Total</td><td>${m(q.total)}</td></tr>${q.damageDeposit ? `<tr><td>Refundable damage deposit</td><td>${m(q.damageDeposit)}</td></tr>` : ''}</table>`;
}

/** Step 1: dates, guests, rooms and extras. Pre-filled from what they chose; shows why when something is wrong. */
function datesForm(b: BookCtx, s: LoadedStay, c: StayChoice, message: string | null): BookPage {
    const r = s.row;
    const maxRooms = r.stayType === 'room' ? Math.max(1, s.units.length) : 1;
    const guests = c.guests || Math.min(2, r.maxGuests);
    const extras = s.fees.filter((f) => f.optional);
    const opt = (n: number, sel: number) => `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`;
    return page(b, `Book ${r.name}`, `<h1>Book ${esc(r.name)}</h1>
${message ? `<p role="alert"><strong>${esc(message)}</strong></p>` : ''}
<form class="fm" method="get" action="${BOOK_PATH}">
<input type="hidden" name="stay" value="${r.id}">
<label>Arrive<input type="date" name="in" required value="${esc(c.in ?? '')}"></label>
<label>Leave<input type="date" name="out" required value="${esc(c.out ?? '')}"></label>
<label>Guests<select name="guests">${Array.from({ length: r.maxGuests * maxRooms }, (_, i) => opt(i + 1, guests)).join('')}</select></label>
${maxRooms > 1 ? `<label>Rooms<select name="rooms">${Array.from({ length: maxRooms }, (_, i) => opt(i + 1, c.rooms)).join('')}</select></label>` : ''}
${extras.length ? `<fieldset><legend>Extras</legend>${extras.map((f) => `<label class="opt"><input type="checkbox" name="x" value="${f.id}"${c.extras.includes(f.id) ? ' checked' : ''}> ${esc(f.label)} — ${esc(formatMoney(f.amount, r.currency))}${{ stay: '', night: ' a night', guest_night: ' per guest per night' }[f.per]}</label>`).join('')}</fieldset>` : ''}
<button class="btn" type="submit">Check price</button>
</form>
<p><a href="${esc(stayPagePath(r.slug))}#dates">See the calendar</a></p>`);
}

/** GET /_book?stay=… — the next step. */
export async function stayStep(b: BookCtx, q: URLSearchParams, message: string | null = null): Promise<BookPage> {
    const c = readStayChoice(q);
    const s = await stayFor(b, c.stay);
    if (!s) return notFound(b);
    // Arrived from a calendar day: suggest the minimum stay as the departure.
    if (c.in && !c.out) return datesForm(b, s, c, message);
    if (!c.in || !c.out || !c.guests) return datesForm(b, s, c, message);
    const r = await priced(b, s, c);
    if (!r.ok) return datesForm(b, s, c, message ?? r.message);
    const q2 = r.quote;
    const takes = !!(await connectAccountFor(b.db, b.site.organisationId))?.chargesEnabled;
    const row = s.row;
    const now = chargeNow(q2);
    const plan = takes ? describePayment(q2, formatDate) : [`Total ${formatMoney(q2.total, q2.currency)}. ${row.mode === 'instant' ? 'We\'ll' : 'Once we confirm, we\'ll'} be in touch about paying.`];
    const button = takes && now.total > 0 ? `Continue to pay ${formatMoney(now.total, q2.currency)}` : row.mode === 'instant' ? 'Book now' : 'Request to book';
    const rooms = row.stayType === 'whole' ? 1 : c.rooms;
    const summary = `${formatDate(c.in)} to ${formatDate(c.out)} · ${q2.nights} night${q2.nights === 1 ? '' : 's'} · ${c.guests} guest${c.guests === 1 ? '' : 's'}${rooms > 1 ? ` · ${rooms} rooms` : ''}`;
    const hidden = { stay: String(row.id), in: c.in, out: c.out, guests: String(c.guests), rooms: String(rooms), x: c.extras.join(',') };
    return page(b, 'Your details', `<h1>${esc(row.name)}</h1>
<p class="fine"><strong>${esc(summary)}</strong> · <a href="${esc(stayLink(c, { out: null }))}">Change</a></p>
${message ? `<p role="alert"><strong>${esc(message)}</strong></p>` : ''}
${quoteTable(q2)}
${plan.map((l) => `<p>${esc(l)}</p>`).join('')}
<p class="fine"><strong>Cancellation:</strong> ${esc(describeCancellation(pricingOf(s).cancellation))}</p>
<h2>Your details</h2>
<form class="fm" method="post" action="${BOOK_PATH}">
${Object.entries(hidden).map(([k, v]) => (v ? `<input type="hidden" name="${k}" value="${esc(v)}">` : '')).join('')}
<input type="hidden" name="_t" value="${b.now.getTime()}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>Your name<input name="name" required maxlength="120" autocomplete="name"></label>
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>
<label>Phone<input type="tel" name="phone" required maxlength="30" autocomplete="tel"></label>
<label>Anything we should know? <span class="help">(arrival time, a special occasion)</span><textarea name="notes" rows="3" maxlength="1000"></textarea></label>
${row.houseRules ? `<details><summary>House rules</summary><div>${esc(row.houseRules).replace(/\n/g, '<br>')}</div></details><label class="opt"><input type="checkbox" name="rules" value="1" required> I have read and agree to the house rules</label>` : ''}
<button class="btn" type="submit">${esc(button)}</button>
<p class="fine">${row.mode === 'instant' ? 'Your booking is confirmed straight away, by email.' : 'We\'ll confirm your booking by email.'} Your details are used only for this booking.</p>
</form>`);
}

/** POST /_book with stay=… — make the booking (and go to pay, when the business takes cards). */
export async function stayBookSubmit(b: BookCtx, body: URLSearchParams, ip: string): Promise<BookPage> {
    const c = readStayChoice(body);
    const s = await stayFor(b, c.stay);
    if (!s) return notFound(b);
    const back = stayPagePath(s.row.slug);
    const started = Number(body.get('_t'));
    if (String(body.get('website') || '').trim() || !Number.isFinite(started) || b.now.getTime() - started < BOOK_MIN_FILL_MS) {
        return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=pending&b=${encodeURIComponent('/')}` };
    }
    if (!c.in || !c.out || !c.guests) return stayStep(b, body, 'Something was missing — please choose your dates again.');
    const name = cleanText(body.get('name'), 120);
    const email = normaliseEmail(String(body.get('email') || '').slice(0, 254));
    const phone = cleanText(body.get('phone'), 30) || null;
    const notes = cleanText(body.get('notes'), 1000, true) || null;
    if (!name) return stayStep(b, body, 'Please add your name.');
    if (!looksLikeEmail(email)) return stayStep(b, body, 'Please check your email address — it doesn\'t look right.');
    if (!phone || !/^[+()\d\s.-]{5,30}$/.test(phone)) return stayStep(b, body, 'Please add a phone number we can reach you on.');
    if (s.row.houseRules && body.get('rules') !== '1') return stayStep(b, body, 'Please read and agree to the house rules.');
    try {
        const [byIp, byEmail] = await Promise.all([
            checkRateLimit(b.db, 'site_booking_ip', ip, BOOK_LIMITS.perIp),
            checkRateLimit(b.db, 'site_booking_email', emailKey(email), BOOK_LIMITS.perEmail),
        ]);
        if (!byIp.allowed || !byEmail.allowed) return stayStep(b, body, 'Lots of bookings have been made from here just now. Please try again later, or get in touch with us.');
    } catch (err) {
        console.error('[site-stay-booking] rate limiter unavailable — allowing the booking', err);
    }
    const takePayment = !!(await connectAccountFor(b.db, b.site.organisationId))?.chargesEnabled;
    const made = await createStay(b.db, b.site.organisationId, {
        stayTypeId: s.row.id, checkIn: c.in, checkOut: c.out, guests: c.guests, rooms: c.rooms, extras: c.extras,
        siteId: b.site.id, customerName: name, customerEmail: email, customerPhone: phone, notes, now: b.now, takePayment,
    });
    if (!made.ok) return stayStep(b, body, made.message);
    const tz = await businessTimezone(b.db, b.site.organisationId);
    if (made.booking.status === 'awaiting_payment') {
        const { what, when } = describeBooking(made.booking, tz);
        const pay = await startStayCheckout(b.db, { origin: b.ctx.origin, booking: made.booking, quote: made.quote, what, when, backPath: back, now: b.now });
        if (pay.ok) return { status: 303, location: pay.url };
        await releaseHold(b.db, made.booking.id);
        return stayStep(b, body, 'Card payments aren\'t working just now, so nothing was booked or charged. Please try again in a few minutes, or get in touch with us.');
    }
    await announceNewBooking(b.db, made.booking, noticeCtx(b, s, tz)).catch((err) => console.error('[site-stay-booking] notices failed', err));
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=${made.booking.status === 'confirmed' ? 'confirmed' : 'pending'}&b=${encodeURIComponent(back)}` };
}

function noticeCtx(b: BookCtx, s: LoadedStay | null, tz: string) {
    const policy = s ? describeCancellation(pricingOf(s).cancellation) : null;
    return { business: b.def.settings.siteName, timezone: tz, assistantId: b.site.aiAssistantId, cancellationPolicy: policy, siteOrigin: b.ctx.origin };
}

// ── The guest's own booking (the manage link in their emails) ──────────────────────────────

async function stayFromLink(b: BookCtx, idRaw: unknown, token: unknown): Promise<BookingRow | null> {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0 || !verifyBookingToken(id, String(token || ''))) return null;
    const row = await loadBooking(b.db, id);
    return row && row.organisationId === b.site.organisationId && row.kind === 'stay' ? row : null;
}

async function policyOf(b: BookCtx, row: BookingRow) {
    const [s] = row.stayTypeId ? await loadStays(b.db, b.site.organisationId, { ids: [row.stayTypeId] }) : [];
    return { stay: s ?? null, policy: s ? pricingOf(s).cancellation : [] };
}

/** GET /_book?manage=… for a stay: see it, and cancel it (with what comes back, before they confirm). */
export async function stayManagePage(b: BookCtx, row: BookingRow, token: string, confirmCancel: boolean): Promise<BookPage> {
    const tz = await businessTimezone(b.db, b.site.organisationId);
    const { what, when } = describeBooking(row, tz);
    const status = { pending: 'Waiting to be confirmed', confirmed: 'Confirmed', declined: 'Not accepted', cancelled: 'Cancelled', awaiting_payment: 'Waiting for payment' }[row.status] ?? row.status;
    const head = `<h1>Your stay</h1><p><strong>${esc(what)}</strong><br>${esc(when)}<br>${esc(status)}</p>`;
    const today = utcToZoned(b.now, tz).date;
    const open = (row.status === 'pending' || row.status === 'confirmed') && !!row.checkIn && row.checkIn > today;
    if (!open) return page(b, 'Your stay', `${head}${row.status === 'cancelled' || row.status === 'declined' ? '' : '<p>To change anything now, please get in touch with us directly.</p>'}<p><a class="btn s" href="/">Go to the website</a></p>`);
    const { policy } = await policyOf(b, row);
    const back = stayRefundFor(row, policy, today);
    const cur = row.currency ?? 'GBP';
    const refundWords = back.total > 0
        ? `You'll get ${formatMoney(back.total, cur)} back${back.damage ? ` (including the ${formatMoney(back.damage, cur)} damage deposit)` : ''}, to the card you paid with.`
        : row.paymentStatus === 'paid' ? 'Under the cancellation terms, nothing is refunded if you cancel now.' : 'Nothing has been charged.';
    if (confirmCancel) {
        return page(b, 'Cancel your stay?', `${head}<h2>Cancel this stay?</h2><p>${esc(refundWords)}</p>
<form class="fm" method="post" action="${BOOK_PATH}"><input type="hidden" name="_action" value="cancel"><input type="hidden" name="manage" value="${row.id}"><input type="hidden" name="t" value="${esc(token)}">
<button class="btn" type="submit">Yes, cancel it</button></form><p><a href="${esc(`${BOOK_PATH}?manage=${row.id}&t=${token}`)}">No, keep it</a></p>`);
    }
    return page(b, 'Your stay', `${head}<p><a class="btn s" href="${esc(`${BOOK_PATH}?manage=${row.id}&t=${token}&do=cancel`)}">Cancel it</a></p><p class="fine"><strong>Cancellation:</strong> ${esc(describeCancellation(policy))} To change your dates, please get in touch with us.</p>`);
}

/** POST /_book _action=cancel for a stay: cancel, refund what the policy gives, tell both sides. */
export async function stayCancelSubmit(b: BookCtx, row0: BookingRow, token: string): Promise<BookPage> {
    const row = await stayFromLink(b, row0.id, token);
    if (!row) return page(b, 'Booking not found', '<h1>We couldn\'t find that booking</h1>', 404);
    const tz = await businessTimezone(b.db, b.site.organisationId);
    const today = utcToZoned(b.now, tz).date;
    if (!row.checkIn || row.checkIn <= today) return stayManagePage(b, row, token, false);
    const { stay, policy } = await policyOf(b, row);
    const back = stayRefundFor(row, policy, today);
    const done = await customerCancel(b.db, b.site.organisationId, row.id);
    if (!done) return stayManagePage(b, row, token, false);
    // Back on the payments that took it: the stay's share by the policy, all of a held damage deposit.
    const result = back.total > 0 ? await refundStayParts(b.db, done, back.stay, back.damage, 'guest-cancel') : 'none';
    const cur = done.currency ?? 'GBP';
    const ctx = noticeCtx(b, stay, tz);
    const { what, when } = describeBooking(done, tz);
    const money = result === 'refunded' ? `<p>${esc(formatMoney(back.total, cur))} is on its way back to your card — it usually arrives within 5–10 days.</p>`
        : result === 'refund_failed' ? `<p>${esc(ctx.business)} will refund ${esc(formatMoney(back.total, cur))} to you.</p>`
        : done.paymentStatus === 'paid' ? '<p>Under the cancellation terms, nothing is refunded.</p>' : '';
    await sendEmail({
        to: done.customerEmail, from: fromLine(ctx.business),
        subject: `You've cancelled your stay — ${ctx.business}`,
        html: `<p>${esc(done.customerName)}, your stay at <strong>${esc(what)}</strong>, <strong>${esc(when)}</strong>, is cancelled. Thanks for letting ${esc(ctx.business)} know.</p>${money}`,
    }).catch((err: unknown) => console.error('[site-stay-booking] cancel email failed', err instanceof Error ? err.message : err));
    await announceCustomerChange(b.db, 'cancelled', done, ctx).catch((err) => console.error('[site-stay-booking] cancel notice failed', err));
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=cancelled&b=%2F` };
}

// ── Paying the balance (the link in the "your balance is due" email — stay-jobs.ts) ─────────────
// GET shows the amount and a Pay button; only the POST opens Stripe, so an email scanner that opens
// the link (Outlook's does) starts nothing.

/** GET /_book?pay=<id>&t=<sig> */
export async function stayPayPage(b: BookCtx, q: URLSearchParams): Promise<BookPage> {
    const row = await stayFromLink(b, q.get('pay'), q.get('t'));
    if (!row) return page(b, 'Booking not found', '<h1>We couldn\'t find that booking</h1><p>The link may be incomplete. Please get in touch with us.</p>', 404);
    const { what, when } = describeBooking(row, 'UTC');
    const head = `<h1>Your stay</h1><p><strong>${esc(what)}</strong><br>${esc(when)}</p>`;
    const cur = row.currency || 'GBP';
    if (row.balanceStatus === 'paid') return page(b, 'All paid', `${head}<p>Your balance is paid — thank you. Nothing more to do.</p>`);
    if (row.status !== 'confirmed' || (row.balanceStatus !== 'due' && row.balanceStatus !== 'failed')) {
        return page(b, 'Your stay', `${head}<p>There's nothing to pay here. If you think there should be, please get in touch with us.</p>`);
    }
    const c = balanceCharge(row);
    return page(b, 'Pay your balance', `${head}
<table class="qt"><tr><td>Remaining balance</td><td>${esc(formatMoney(c.balance, cur))}</td></tr>${c.damage ? `<tr><td>Refundable damage deposit</td><td>${esc(formatMoney(c.damage, cur))}</td></tr>` : ''}<tr class="tot"><td>To pay</td><td>${esc(formatMoney(c.total, cur))}</td></tr></table>
${row.balanceDueOn ? `<p class="fine">Due by ${esc(formatDate(row.balanceDueOn))}.</p>` : ''}
<form class="fm" method="post" action="${BOOK_PATH}"><input type="hidden" name="_action" value="pay_balance"><input type="hidden" name="pay" value="${row.id}"><input type="hidden" name="t" value="${esc(String(q.get('t')))}">
<button class="btn" type="submit">Pay ${esc(formatMoney(c.total, cur))}</button></form>`);
}

/** POST /_book _action=pay_balance — off to Stripe for the balance (and the damage deposit when it's due). */
export async function stayPaySubmit(b: BookCtx, body: URLSearchParams): Promise<BookPage> {
    const token = String(body.get('t') || '');
    const row = await stayFromLink(b, body.get('pay'), token);
    if (!row) return page(b, 'Booking not found', '<h1>We couldn\'t find that booking</h1>', 404);
    if (row.status !== 'confirmed' || (row.balanceStatus !== 'due' && row.balanceStatus !== 'failed')) return stayPayPage(b, new URLSearchParams({ pay: String(row.id), t: token }));
    const { what, when } = describeBooking(row, 'UTC');
    const back = `${BOOK_PATH}?pay=${row.id}&t=${token}`;
    const pay = await startBalanceCheckout(b.db, { origin: b.ctx.origin, booking: row, what, when, backPath: back, now: b.now });
    if (pay.ok) return { status: 303, location: pay.url };
    return page(b, 'Payments aren\'t working', '<h1>Card payments aren\'t working just now</h1><p>Nothing was charged. Please try again in a few minutes, or reply to the email we sent you.</p>', 503);
}
