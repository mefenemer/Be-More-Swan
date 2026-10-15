// src/utils/site-classes.ts — booking a class or an event on a hosted site (a booking section with
// kind 'class'), served at /_book by site-booking.ts. docs/booking-plan.md phase 5.
// tests/classes.test.ts.
//
// No script: the timetable is a page of links (upcoming sessions, places left); choosing one opens
// the details form; only that form POSTs, and class-sessions.ts re-counts the places under the lock
// before holding them. A full session offers its waitlist instead.

import type { BookingProps, Section, SiteDefinition } from './site-definition';
import { cleanText } from './site-definition';
import { BOOK_PATH, esc, FORM_SENT_PATH, placesText, renderSiteShell, sessionLink, timetableHtml, type RenderContext } from './site-render';
import { bookableSessions, bookSession, joinWaitlist, loadSession } from './class-sessions';
import { announceNewBooking, describeBooking, emailKey, loadBookingSetup } from './bookings';
import { depositToTake, releaseHold, startDepositCheckout } from './booking-deposits';
import { formatPounds } from './product-price';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { checkRateLimit } from './rate-limit';
import type { getDb } from '../../db/client';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export interface ClassCtx { db: Db; site: SiteRow; def: SiteDefinition; ctx: RenderContext; now: Date; }
export type ClassPage = { status: number; html: string } | { status: 303; location: string };
type Found = { section: Extract<Section, { type: 'booking' }>; pagePath: string };

export const CLASS_BOOK_LIMITS = { perIp: { maxAttempts: 10, windowSecs: 3600 }, perEmail: { maxAttempts: 8, windowSecs: 86_400 } };
export const CLASS_MIN_FILL_MS = 2500;

const page = (b: ClassCtx, title: string, inner: string, status = 200): ClassPage =>
    ({ status, html: renderSiteShell(b.def, b.ctx, title, `<section><div class="w n">${inner}</div></section>`) });

/** GET /_book for a class section: the timetable, or one session's form. */
export async function classStep(b: ClassCtx, found: Found, q: URLSearchParams, message: string | null = null, kept: Record<string, string> = {}): Promise<ClassPage> {
    const props = found.section.props as BookingProps;
    const back = `<p><a href="${esc(found.pagePath)}">← Back to the website</a></p>`;
    const note = message ? `<p class="fine" role="alert" style="color:#b91c1c"><strong>${esc(message)}</strong></p>` : '';
    const sessionId = Number(q.get('sess'));

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        const sessions = await bookableSessions(b.db, b.site.organisationId, b.now, props.serviceIds);
        if (!sessions.length) return page(b, 'Timetable', `<h1>${esc(props.heading || 'Timetable')}</h1><p>There's nothing to book just now — new dates are added regularly.</p>${back}`);
        return page(b, 'Timetable', `<h1>${esc(props.heading || 'Timetable')}</h1>${note}${timetableHtml(sessions, found.section.id)}${back}`);
    }

    const s = await loadSession(b.db, b.site.organisationId, sessionId);
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    const list = await bookableSessions(b.db, b.site.organisationId, b.now, props.serviceIds);
    const v = list.find((x) => x.id === sessionId) ?? null;
    const all = `<p><a href="${esc(`${BOOK_PATH}?s=${encodeURIComponent(found.section.id)}`)}">See all dates</a></p>`;
    if (!s || !v) return page(b, 'Not available', `<h1>That session isn't available</h1><p>It may have been cancelled, or it's too close to the start to book online.</p>${all}${back}`, 404);
    const head = `<h1>${esc(v.title)}</h1><p><strong>${esc(v.dateText)}, ${esc(v.timeText)}</strong>${v.resourceName ? ` · with ${esc(v.resourceName)}` : ''}${v.price ? ` · ${esc(v.price)}` : ''}<br>${esc(placesText(v.left))}</p>${s.notes ? `<p>${esc(s.notes)}</p>` : ''}`;
    const common = `<input type="hidden" name="s" value="${esc(found.section.id)}"><input type="hidden" name="sess" value="${v.id}"><input type="hidden" name="_t" value="${b.now.getTime()}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>Your name<input name="name" required maxlength="120" autocomplete="name" value="${esc(kept.name ?? '')}"></label>
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email" value="${esc(kept.email ?? '')}"></label>`;
    const maxPlaces = (left: number) => Math.max(1, Math.min(left, setup.settings.maxPartySize));
    const placesSelect = (max: number) => max > 1
        ? `<label>How many places?<select name="places">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}"${String(i + 1) === (kept.places ?? '1') ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>`
        : '<input type="hidden" name="places" value="1">';

    if (v.left <= 0) {
        return page(b, 'Join the waitlist', `${head}${note}<h2>It's full — join the waitlist?</h2><p>If a place opens up, we'll email you a link to book it. It isn't held, so the first to book gets it.</p>
<form class="fm" method="post" action="${BOOK_PATH}"><input type="hidden" name="_action" value="class_wait">${common}${placesSelect(setup.settings.maxPartySize)}
<button class="btn" type="submit">Join the waitlist</button><p class="fine">Your details are used only for this.</p></form>${all}${back}`);
    }
    const policy = setup.settings.cancellationPolicy ? `<p class="fine"><strong>Cancellation:</strong> ${esc(setup.settings.cancellationPolicy)}</p>` : '';
    // A deposit per place, mentioned only where it will actually be taken.
    const perPlace = await depositToTake(b.db, b.site.organisationId, s.serviceId, 1);
    const depositHtml = perPlace ? `<p class="fine"><strong>A ${esc(formatPounds(perPlace))} deposit per place is paid now, by card</strong> — refunded if you cancel online in time.</p>` : '';
    const how = setup.settings.mode === 'instant' ? 'Your place is confirmed straight away, by email.' : 'We\'ll confirm your place by email.';
    return page(b, `Book ${v.title}`, `${head}${note}
<form class="fm" method="post" action="${BOOK_PATH}"><input type="hidden" name="_action" value="class_book">${common}
<label>Phone <span class="help">(optional)</span><input type="tel" name="phone" maxlength="30" autocomplete="tel" value="${esc(kept.phone ?? '')}"></label>
${placesSelect(maxPlaces(v.left))}
<label>Anything we should know? <span class="help">(optional)</span><textarea name="notes" rows="3" maxlength="1000">${esc(kept.notes ?? '')}</textarea></label>
${depositHtml}<button class="btn" type="submit">${perPlace ? 'Continue to pay the deposit' : setup.settings.mode === 'instant' ? 'Book my place' : 'Request my place'}</button>
<p class="fine">${how} Your details are used only for this booking.</p></form>${policy}${all}${back}`);
}

/** POST /_book with _action=class_book | class_wait. */
export async function classSubmit(b: ClassCtx, found: Found, body: URLSearchParams, ip: string): Promise<ClassPage> {
    const sessionId = Number(body.get('sess'));
    const q = new URLSearchParams({ s: found.section.id, sess: String(sessionId) });
    const kept = { name: String(body.get('name') || '').slice(0, 120), email: String(body.get('email') || '').slice(0, 254), phone: String(body.get('phone') || '').slice(0, 30), notes: String(body.get('notes') || '').slice(0, 1000), places: String(body.get('places') || '1') };
    const started = Number(body.get('_t'));
    if (String(body.get('website') || '').trim() || !Number.isFinite(started) || b.now.getTime() - started < CLASS_MIN_FILL_MS) {
        return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=pending&b=${encodeURIComponent(found.pagePath)}` };
    }
    const name = cleanText(kept.name, 120);
    const email = normaliseEmail(kept.email);
    const phone = cleanText(kept.phone, 30) || null;
    const notes = cleanText(kept.notes, 1000, true) || null;
    const places = Number(kept.places);
    const retry = (m: string) => classStep(b, found, q, m, kept);
    if (!name) return retry('Please add your name.');
    if (!looksLikeEmail(email)) return retry('Please check your email address — it doesn\'t look right.');
    if (phone && !/^[+()\d\s.-]{5,30}$/.test(phone)) return retry('Please check your phone number, or leave it empty.');
    const setup = await loadBookingSetup(b.db, b.site.organisationId);
    if (!Number.isInteger(places) || places < 1 || places > setup.settings.maxPartySize) return retry('Please choose how many places.');
    try {
        const [byIp, byEmail] = await Promise.all([
            checkRateLimit(b.db, 'site_class_ip', ip, CLASS_BOOK_LIMITS.perIp),
            checkRateLimit(b.db, 'site_class_email', emailKey(email), CLASS_BOOK_LIMITS.perEmail),
        ]);
        if (!byIp.allowed || !byEmail.allowed) return retry('Lots of bookings have been made from here just now. Please try again later, or get in touch with us.');
    } catch (err) {
        console.error('[site-classes] rate limiter unavailable — allowing it', err);
    }
    // The session must be one this section offers.
    const props = found.section.props as BookingProps;
    const s = await loadSession(b.db, b.site.organisationId, sessionId);
    if (!s || (props.serviceIds.length && (!s.serviceId || !props.serviceIds.includes(s.serviceId)))) return retry('That session isn\'t available.');

    if (body.get('_action') === 'class_wait') {
        const r = await joinWaitlist(b.db, b.site.organisationId, s.id, { name, email, places });
        if (!r.ok) return retry(r.error);
        return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=waitlist&b=${encodeURIComponent(found.pagePath)}` };
    }
    const deposit = await depositToTake(b.db, b.site.organisationId, s.serviceId, places);
    const made = await bookSession(b.db, b.site.organisationId, { sessionId: s.id, places, siteId: b.site.id, customerName: name, customerEmail: email, customerPhone: phone, notes, now: b.now, deposit });
    if (!made.ok) return retry(made.message);
    if (made.booking.status === 'awaiting_payment' && deposit) {
        // Pay first; nobody is told until it's paid (the Connect webhook announces it).
        const { when, what } = describeBooking(made.booking, setup.settings.timezone);
        const pay = await startDepositCheckout(b.db, { origin: b.ctx.origin, booking: made.booking, pence: deposit, what, when, backPath: found.pagePath, now: b.now });
        if (pay.ok) return { status: 303, location: pay.url };
        await releaseHold(b.db, made.booking.id);
        return retry('Card payments aren\'t working just now, so nothing was booked or charged. Please try again in a few minutes, or get in touch with us.');
    }
    await announceNewBooking(b.db, made.booking, {
        business: b.def.settings.siteName, timezone: setup.settings.timezone, assistantId: b.site.aiAssistantId,
        cancellationPolicy: setup.settings.cancellationPolicy, siteOrigin: b.ctx.origin,
    }).catch((err) => console.error('[site-classes] notices failed', err));
    return { status: 303, location: `${FORM_SENT_PATH}?k=booking&st=${made.booking.status === 'confirmed' ? 'confirmed' : 'pending'}&b=${encodeURIComponent(found.pagePath)}` };
}

