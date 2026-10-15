// src/utils/site-booking.ts — the booking steps on a hosted site, served at /_book by site-serve.ts.
// docs/booking-plan.md. tests/bookings.test.ts.
//
// Every step is a page of its own and every choice is a plain link or GET form, so booking works on
// any phone with no script: what (or how many) → who (only if the section offers a choice) → which
// day → which time → your details. Nothing is held until the last step POSTs; then bookings.ts makes
// the booking under a lock and re-checks the time, so a time taken in the meantime is refused and
// the remaining times are shown.
//
// Everything a step offers is read from the PUBLISHED site (the section) and Business Information
// (services, hours, rules) — the query string only says which of those were chosen, and each choice
// is checked again before it is used.

import type { getDb } from '../../db/client';
import type { BookingProps, Section, SiteDefinition } from './site-definition';
import { BOOK_PATH, esc, FORM_SENT_PATH, renderSiteShell, type RenderContext } from './site-render';
import { bookableDates } from './booking-availability';
import { formatDate, formatTime, DATE_RE, TIME_RE } from './booking-time';
import {
    announceCustomerChange, announceNewBooking, createBooking, customerCancel, customerCanChange, describeBooking, emailCustomer, emailKey,
    loadBooking, loadBookingSetup, resourcesForKind, slotsForDay, type BookingRow, type BookingSetup,
} from './bookings';
import { verifyBookingToken } from './booking-links';
import { checkRateLimit } from './rate-limit';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { cleanText } from './site-definition';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export const BOOK_LIMITS = { perIp: { maxAttempts: 10, windowSecs: 3600 }, perEmail: { maxAttempts: 5, windowSecs: 86_400 } };
export const BOOK_MIN_FILL_MS = 2500;
const DATES_SHOWN = 21;

/** `mv`/`mt`: moving an existing booking (its id and signed token — booking-links.ts). */
export interface BookChoice { s: string; svc: number | null; party: number; res: number | 'any' | null; date: string | null; time: string | null; mv?: number | null; mt?: string | null; }

export function readChoice(q: URLSearchParams): BookChoice {
    const n = (k: string) => { const v = Number(q.get(k)); return Number.isInteger(v) && v > 0 ? v : null; };
    const res = q.get('res');
    return {
        s: String(q.get('s') || '').slice(0, 24),
        svc: n('svc'),
        party: n('party') ?? 0,
        res: res === 'any' ? 'any' : n('res'),
        date: DATE_RE.test(String(q.get('date'))) ? String(q.get('date')) : null,
        time: TIME_RE.test(String(q.get('time'))) ? String(q.get('time')) : null,
        mv: n('mv'),
        mt: /^[0-9a-f]{20}$/.test(String(q.get('mt'))) ? String(q.get('mt')) : null,
    };
}

/** A /_book link carrying the choices so far (plus any overrides). */
export function bookLink(c: BookChoice, over: Partial<BookChoice> = {}): string {
    const m = { ...c, ...over };
    const q = new URLSearchParams();
    q.set('s', m.s);
    if (m.svc) q.set('svc', String(m.svc));
    if (m.party) q.set('party', String(m.party));
    if (m.res) q.set('res', String(m.res));
    if (m.date) q.set('date', m.date);
    if (m.time) q.set('time', m.time);
    if (m.mv && m.mt) { q.set('mv', String(m.mv)); q.set('mt', m.mt); }
    return `${BOOK_PATH}?${q.toString()}`;
}

function findBookingSection(def: SiteDefinition, id: string): { section: Extract<Section, { type: 'booking' }>; pagePath: string } | null {
    for (const p of def.pages) for (const s of p.sections) if (s.id === id && s.type === 'booking') return { section: s, pagePath: p.slug ? `/${p.slug}` : '/' };
    return null;
}

export type BookPage = { status: number; html: string } | { status: 303; location: string };

interface BookCtx { db: Db; site: SiteRow; def: SiteDefinition; ctx: RenderContext; now: Date; }

const page = (b: BookCtx, title: string, inner: string, status = 200): BookPage =>
    ({ status, html: renderSiteShell(b.def, b.ctx, title, `<section><div class="w n">${inner}</div></section>`) });

const NOTES_LABEL: Record<BookingProps['kind'], string> = {
    table: 'Anything we should know? (allergies, a special occasion)',
    appointment: 'Anything to tell us? (optional)',
    consultation: 'What would you like to talk about?',
};

/** Where the choices so far stand, in words, with a way back to change each. */
function summary(c: BookChoice, props: BookingProps, setup: BookingSetup): string {
    const svc = c.svc ? setup.services.find((x) => x.id === c.svc) : null;
    const res = typeof c.res === 'number' ? setup.resources.find((r) => r.id === c.res) : null;
    const bits = [
        props.kind === 'table' ? (c.party ? `Table for ${c.party}` : '') : (svc ? `${svc.name} · ${svc.durationMinutes} min${svc.price ? ` · ${svc.price}` : ''}` : ''),
        res ? `with ${res.name}` : c.res === 'any' && props.askStaff ? 'with anyone available' : '',
        c.date ? formatDate(c.date) : '',
        c.time ? formatTime(c.time) : '',
    ].filter(Boolean);
    return bits.length ? `<p class="fine"><strong>${esc(bits.join(' · '))}</strong> · <a href="${esc(bookLink({ ...c, svc: null, party: 0, res: null, date: null, time: null }))}">Start again</a></p>` : '';
}

/** The booking a manage link names — only if the signature is right and it belongs to this site's business. */
async function bookingFromLink(b: BookCtx, idRaw: unknown, token: unknown): Promise<BookingRow | null> {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0 || !verifyBookingToken(id, String(token || ''))) return null;
    const row = await loadBooking(b.db, id);
    return row && row.organisationId === b.site.organisationId ? row : null;
}

/** The first booking section on the site that takes this kind of booking — where a move starts. */
function sectionForKind(def: SiteDefinition, kind: string): string | null {
    for (const p of def.pages) for (const s of p.sections) if (s.type === 'booking' && s.props.kind === kind) return s.id;
    return null;
}

/** GET /_book?manage=<id>&t=<sig> — the customer's own booking: see it, cancel it, or choose a new time. */
async function managePage(b: BookCtx, q: URLSearchParams): Promise<BookPage> {
    const row = await bookingFromLink(b, q.get('manage'), q.get('t'));
    if (!row) return page(b, 'Booking not found', '<h1>We couldn\'t find that booking</h1><p>The link may be incomplete. Please get in touch with us.</p><p><a class="btn" href="/">Go to the home page</a></p>', 404);
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    const { when, what } = describeBooking(row, setup.settings.timezone);
    const status = { pending: 'Waiting to be confirmed', confirmed: 'Confirmed', declined: 'Not accepted', cancelled: 'Cancelled' }[row.status] ?? row.status;
    const head = `<h1>Your booking</h1><p><strong>${esc(what)}</strong><br>${esc(when)}<br>${esc(status)}</p>`;
    if (!customerCanChange(row, setup.settings.minNoticeMinutes, b.now)) {
        const why = row.status === 'cancelled' || row.status === 'declined' ? '' : '<p>It\'s too close to the time to change it here — please get in touch with us directly.</p>';
        return page(b, 'Your booking', `${head}${why}<p><a class="btn s" href="/">Go to the website</a></p>`);
    }
    const token = String(q.get('t'));
    if (q.get('do') === 'cancel') {
        return page(b, 'Cancel your booking?', `${head}<h2>Cancel this booking?</h2>
<form class="fm" method="post" action="${BOOK_PATH}"><input type="hidden" name="_action" value="cancel"><input type="hidden" name="manage" value="${row.id}"><input type="hidden" name="t" value="${esc(token)}">
<button class="btn" type="submit">Yes, cancel it</button></form><p><a href="${esc(`${BOOK_PATH}?manage=${row.id}&t=${token}`)}">No, keep it</a></p>`);
    }
    const s = sectionForKind(b.def, row.kind);
    const move = s ? `<a class="btn" href="${esc(bookLink({ s, svc: row.serviceId, party: row.kind === 'table' ? row.partySize : 0, res: row.resourceId ?? 'any', date: null, time: null, mv: row.id, mt: token }))}">Choose a new time</a> ` : '';
    const policy = setup.settings.cancellationPolicy ? `<p class="fine"><strong>Cancellation:</strong> ${esc(setup.settings.cancellationPolicy)}</p>` : '';
    return page(b, 'Your booking', `${head}<p>${move}<a class="btn s" href="${esc(`${BOOK_PATH}?manage=${row.id}&t=${token}&do=cancel`)}">Cancel it</a></p>${policy}`);
}

/** GET /_book — the next step for the choices made so far. */
export async function bookStep(b: BookCtx, q: URLSearchParams, message: string | null = null): Promise<BookPage> {
    if (q.get('manage')) return managePage(b, q);
    const c = readChoice(q);
    const found = findBookingSection(b.def, c.s);
    if (!found) return page(b, 'Booking isn\'t available', '<h1>Booking isn\'t available</h1><p>This page has changed since you opened it.</p><p><a class="btn" href="/">Go to the home page</a></p>', 404);
    const props = found.section.props;
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    const services = setup.services.filter((x) => !props.serviceIds.length || props.serviceIds.includes(x.id));
    const back = `<p><a href="${esc(found.pagePath)}">← Back to the website</a></p>`;
    const note = message ? `<p class="fine" role="alert" style="color:#b91c1c"><strong>${esc(message)}</strong></p>` : '';
    if (!Object.keys(setup.settings.weeklyHours).length || (props.kind !== 'table' && !services.length)) {
        return page(b, 'Booking isn\'t open', `<h1>Booking isn't open right now</h1><p>Please get in touch with us to book.</p>${back}`);
    }

    // 1. What — or how many.
    const svc = props.kind === 'table' ? null : services.find((x) => x.id === c.svc) ?? null;
    if (props.kind === 'table' ? !(c.party >= 1 && c.party <= setup.settings.maxPartySize) : !svc) {
        const choose = props.kind === 'table'
            ? `<label>How many people?<select name="party">${Array.from({ length: setup.settings.maxPartySize }, (_, i) => `<option value="${i + 1}"${i === 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>`
            : `<fieldset><legend>What would you like to book?</legend>${services.map((x, i) => `<label class="opt"><input type="radio" name="svc" value="${x.id}"${i === 0 ? ' checked' : ''}> <span><strong>${esc(x.name)}</strong> · ${x.durationMinutes} min${x.price ? ` · ${esc(x.price)}` : ''}</span></label>`).join('')}</fieldset>`;
        return page(b, 'Book', `<h1>Book</h1>${note}<form class="fm" method="get" action="${BOOK_PATH}"><input type="hidden" name="s" value="${esc(c.s)}">${choose}<button class="btn" type="submit">Next</button></form>${back}`);
    }

    // 2. Who — only when the section offers a choice and there is one to make.
    const kindResources = resourcesForKind(setup, props.kind).filter((r) => props.kind === 'table' || !svc || !r.serviceIds || r.serviceIds.includes(svc.id));
    if (props.askStaff && kindResources.length > 1 && c.res === null) {
        const links = [`<a class="btn s" href="${esc(bookLink(c, { res: 'any' }))}">Anyone available</a>`, ...kindResources.map((r) => `<a class="btn s" href="${esc(bookLink(c, { res: r.id }))}">${esc(r.name)}</a>`)];
        return page(b, 'Choose who', `<h1>Who would you like?</h1>${summary(c, props, setup)}<p>${links.join(' ')}</p>${back}`);
    }
    const resourceId = typeof c.res === 'number' && kindResources.some((r) => r.id === c.res) ? c.res : null;

    // 3. Which day.
    if (!c.date) {
        const dates = bookableDates(setup.settings, b.now, DATES_SHOWN);
        if (!dates.length) return page(b, 'No dates available', `<h1>No dates available</h1><p>There are no days open for booking at the moment. Please get in touch with us.</p>${back}`);
        return page(b, 'Choose a day', `<h1>Choose a day</h1>${summary(c, props, setup)}${note}<p>${dates.map((d) => `<a class="btn s" href="${esc(bookLink(c, { date: d }))}">${esc(formatDate(d))}</a>`).join(' ')}</p>${back}`);
    }

    // 4. Which time (computed now from the bookings as they are).
    const slots = await slotsForDay(b.db, b.site.organisationId, setup, {
        kind: props.kind, date: c.date, serviceId: svc?.id ?? null, resourceId, partySize: props.kind === 'table' ? c.party : 1, now: b.now,
    });
    if (!c.time || !slots.some((s) => s.time === c.time)) {
        const times = slots.length
            ? `<p>${slots.map((s) => `<a class="btn s" href="${esc(bookLink(c, { time: s.time }))}">${esc(formatTime(s.time))}</a>`).join(' ')}</p>`
            : `<p>There are no times left on ${esc(formatDate(c.date))}.</p>`;
        return page(b, 'Choose a time', `<h1>Choose a time</h1>${summary({ ...c, time: null }, props, setup)}${note}${times}<p><a href="${esc(bookLink(c, { date: null, time: null }))}">Choose another day</a></p>${back}`);
    }

    // 5a. Moving a booking: the details are the booking's own — confirm the new time.
    if (c.mv && c.mt) {
        const old = await bookingFromLink(b, c.mv, c.mt);
        if (!old || !customerCanChange(old, setup.settings.minNoticeMinutes, b.now)) return page(b, 'Booking can\'t be changed', '<h1>That booking can\'t be changed here</h1><p>Please get in touch with us directly.</p>');
        const was = describeBooking(old, setup.settings.timezone).when;
        return page(b, 'Move your booking', `<h1>Move your booking</h1>${summary(c, props, setup)}${note}<p>From <strong>${esc(was)}</strong> to <strong>${esc(formatDate(c.date))}, ${esc(formatTime(c.time))}</strong>.</p>
<form class="fm" method="post" action="${BOOK_PATH}">
${['s', 'svc', 'party', 'res', 'date', 'time', 'mv', 'mt'].map((k) => { const v = (c as unknown as Record<string, unknown>)[k]; return v ? `<input type="hidden" name="${k}" value="${esc(String(v))}">` : ''; }).join('')}
<button class="btn" type="submit">Move my booking</button>
<p class="fine">Your old time is released when the new one is booked.${setup.settings.mode === 'instant' ? '' : ' We\'ll confirm the new time by email.'}</p></form>${back}`);
    }

    // 5. Your details — the only step that changes anything.
    const policy = setup.settings.cancellationPolicy ? `<p class="fine"><strong>Cancellation:</strong> ${esc(setup.settings.cancellationPolicy)}</p>` : '';
    const how = setup.settings.mode === 'instant' ? 'Your booking is confirmed straight away, by email.' : 'We\'ll confirm your booking by email.';
    return page(b, 'Your details', `<h1>Your details</h1>${summary(c, props, setup)}${note}
<form class="fm" method="post" action="${BOOK_PATH}">
${['s', 'svc', 'party', 'res', 'date', 'time'].map((k) => { const v = (c as unknown as Record<string, unknown>)[k]; return v ? `<input type="hidden" name="${k}" value="${esc(String(v))}">` : ''; }).join('')}
<input type="hidden" name="_t" value="${b.now.getTime()}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>Your name<input name="name" required maxlength="120" autocomplete="name"></label>
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>
<label>Phone <span class="help">(optional)</span><input type="tel" name="phone" maxlength="30" autocomplete="tel"></label>
<label>${esc(NOTES_LABEL[props.kind])}<textarea name="notes" rows="3" maxlength="1000"></textarea></label>
<button class="btn" type="submit">${setup.settings.mode === 'instant' ? 'Confirm booking' : 'Request booking'}</button>
<p class="fine">${how} Your details are used only for this booking.</p>
</form>${policy}${back}`);
}

/** POST /_book — make, cancel or move a booking. */
export async function bookSubmit(b: BookCtx, body: URLSearchParams, ip: string): Promise<BookPage> {
    if (body.get('_action') === 'cancel') return cancelSubmit(b, body);
    if (body.get('mv')) return moveSubmit(b, body);
    const c = readChoice(body);
    const found = findBookingSection(b.def, c.s);
    if (!found || !c.date || !c.time) return bookStep(b, body, 'Something was missing — please choose again.');
    const props = found.section.props;
    // A bot: the hidden field, or faster than a person could fill the form in. Same "thank you", nothing held.
    const started = Number(body.get('_t'));
    if (String(body.get('website') || '').trim() || !Number.isFinite(started) || b.now.getTime() - started < BOOK_MIN_FILL_MS) {
        return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=pending&b=${encodeURIComponent(found.pagePath)}` };
    }
    const name = cleanText(body.get('name'), 120);
    const email = normaliseEmail(String(body.get('email') || '').slice(0, 254));
    const phone = cleanText(body.get('phone'), 30) || null;
    const notes = cleanText(body.get('notes'), 1000, true) || null;
    if (!name) return bookStep(b, body, 'Please add your name.');
    if (!looksLikeEmail(email)) return bookStep(b, body, 'Please check your email address — it doesn\'t look right.');
    if (phone && !/^[+()\d\s.-]{5,30}$/.test(phone)) return bookStep(b, body, 'Please check your phone number, or leave it empty.');
    try {
        const [byIp, byEmail] = await Promise.all([
            checkRateLimit(b.db, 'site_booking_ip', ip, BOOK_LIMITS.perIp),
            checkRateLimit(b.db, 'site_booking_email', emailKey(email), BOOK_LIMITS.perEmail),
        ]);
        if (!byIp.allowed || !byEmail.allowed) return bookStep(b, body, 'Lots of bookings have been made from here just now. Please try again later, or get in touch with us.');
    } catch (err) {
        console.error('[site-booking] rate limiter unavailable — allowing the booking', err);
    }
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    const made = await createBooking(b.db, b.site.organisationId, {
        siteId: b.site.id, kind: props.kind, date: c.date, time: c.time,
        serviceId: props.kind === 'table' ? null : c.svc, resourceId: typeof c.res === 'number' ? c.res : null,
        partySize: props.kind === 'table' ? c.party : 1, now: b.now,
        customerName: name, customerEmail: email, customerPhone: phone, notes,
    });
    if (!made.ok) {
        // The time went while they were typing: back to the times still free, with what happened.
        const q = new URLSearchParams(body);
        q.delete('time');
        return bookStep(b, q, made.message);
    }
    await announceNewBooking(b.db, made.booking, {
        business: b.def.settings.siteName, timezone: setup.settings.timezone, assistantId: b.site.aiAssistantId,
        cancellationPolicy: setup.settings.cancellationPolicy, siteOrigin: b.ctx.origin,
    }).catch((err) => console.error('[site-booking] notices failed', err));
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=${made.booking.status === 'confirmed' ? 'confirmed' : 'pending'}&b=${encodeURIComponent(found.pagePath)}` };
}

function noticeCtx(b: BookCtx, setup: BookingSetup) {
    return { business: b.def.settings.siteName, timezone: setup.settings.timezone, assistantId: b.site.aiAssistantId, cancellationPolicy: setup.settings.cancellationPolicy, siteOrigin: b.ctx.origin };
}

/** POST /_book _action=cancel — the customer cancels from their manage link. */
async function cancelSubmit(b: BookCtx, body: URLSearchParams): Promise<BookPage> {
    const row = await bookingFromLink(b, body.get('manage'), body.get('t'));
    if (!row) return page(b, 'Booking not found', '<h1>We couldn\'t find that booking</h1>', 404);
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    if (!customerCanChange(row, setup.settings.minNoticeMinutes, b.now)) return managePage(b, new URLSearchParams({ manage: String(row.id), t: String(body.get('t')) }));
    const done = await customerCancel(b.db, b.site.organisationId, row.id);
    if (done) {
        const ctx = noticeCtx(b, setup);
        await emailCustomer(done, 'cancelled_by_you', ctx, null);
        await announceCustomerChange(b.db, 'cancelled', done, ctx).catch((err) => console.error('[site-booking] cancel notice failed', err));
    }
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=cancelled&b=%2F` };
}

/** POST /_book with mv — move a booking: release the old time and book the new in one locked step. */
async function moveSubmit(b: BookCtx, body: URLSearchParams): Promise<BookPage> {
    const c = readChoice(body);
    const found = findBookingSection(b.def, c.s);
    const old = await bookingFromLink(b, c.mv, c.mt);
    if (!found || !old || !c.date || !c.time) return page(b, 'Booking can\'t be changed', '<h1>That booking can\'t be changed here</h1><p>Please get in touch with us directly.</p>', 404);
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    if (!customerCanChange(old, setup.settings.minNoticeMinutes, b.now)) return managePage(b, new URLSearchParams({ manage: String(old.id), t: String(c.mt) }));
    const props = found.section.props;
    const made = await createBooking(b.db, b.site.organisationId, {
        siteId: b.site.id, kind: props.kind, date: c.date, time: c.time,
        serviceId: props.kind === 'table' ? null : c.svc, resourceId: typeof c.res === 'number' ? c.res : null,
        partySize: props.kind === 'table' ? c.party : 1, now: b.now,
        customerName: old.customerName, customerEmail: old.customerEmail, customerPhone: old.customerPhone, notes: old.notes,
        replaceBookingId: old.id,
    });
    if (!made.ok) {
        const q = new URLSearchParams(body);
        q.delete('time');
        return bookStep(b, q, made.message);
    }
    const ctx = noticeCtx(b, setup);
    await emailCustomer(made.booking, made.booking.status === 'confirmed' ? 'confirmed' : 'received', ctx, null);
    await announceCustomerChange(b.db, 'moved', made.booking, ctx, old).catch((err) => console.error('[site-booking] move notice failed', err));
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=${made.booking.status === 'confirmed' ? 'moved' : 'pending'}&b=${encodeURIComponent(found.pagePath)}` };
}
