// src/utils/shop-checkout-reminder.ts — the abandoned-checkout reminder (online shop Phase 2, slice 5; feature
// request #35, docs/online-shop-review-plan.md §12, owner Q3/Q6 2026-11-26 + 2026-11-26 "ask on the basket page").
// tests/shop-checkout-reminder.test.ts, tests/shop-checkout-reminder-db.test.ts.
//
// WHO. Only a buyer who TICKED "Send me news" on the basket page (shop-buyer-audience.ts) and typed their email
// there. Stripe's expired-checkout event carries no email for a UK shop (Stripe collects marketing consent for US
// businesses only), so the address is asked for on OUR page, under the box, shown only once it is ticked. Unticked
// → no email box, no reminder, nothing kept. PECR: the tick is the consent; the reminder carries an unsubscribe link.
//
// WHEN. A Checkout started with the box ticked expires after 1 hour (Stripe's minimum is 30 minutes, default 24
// hours). Stripe then sends checkout.session.expired (stripe-connect-webhook.ts) and ONE reminder goes, for the
// basket's LATEST checkout only, never twice for one basket (reminded_at is claimed before sending). A late Stripe
// retry (over 6 hours after the expiry) sends nothing: a reminder a day later reads as spam.
//
// HOW. Fixed wording, no AI, so no task is spent (owner Q6: 0). Sent ONLY on Email Marketing's route — the owner's
// verified sending domain or their own connected Gmail/Outlook (resolveSendRoute) — never from a Be More Swan
// address (owner rule 2026-11-17). No route → not sent; the Shop tab says so. The shared consent check runs
// first: an address that unsubscribed, bounced, complained, opted out of outreach or paused is never reminded.
// "Not in the Audience yet" is fine — buyers join it only when they pay.
//
// ⚠️ Raw SQL on site_baskets' new columns (db/z-shop-checkout-reminder.sql). Before that SQL: no email is saved,
// nothing is reminded, the Shop tab shows no reminder line, and checkout works as before.

import type Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations, sites } from '../../db/schema';
import { checkAudienceConsentBulk } from './audience-consent';
import { setContactStatus, upsertContact } from './audience-store';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { resolveSendRoute } from './newsletter-send';
import { deliverStep } from './newsletter-sequence';
import { newsTicked } from './shop-buyer-audience';
export { EMAIL_FIELD, EMAIL_HINT } from './shop-buyer-audience';
import { siteOrigin } from './site-hosting';
import { BASKET_PATH, isBasketId } from './shop-basket';

type Db = ReturnType<typeof getDb>;

/** A ticked checkout lapses after this long, and the reminder follows the lapse. Stripe allows 30 min–24 h. */
export const REMINDER_CHECKOUT_MINUTES = 60;
/** A Stripe retry later than this after the expiry sends nothing. */
export const REMINDER_LATE_HOURS = 6;
/** Where the reminder's unsubscribe link goes. */
export const STOP_PATH = '/.netlify/functions/shop-reminder-stop';

export type NewsChoice = { ok: true; email: string | null } | { ok: false; error: string };

/** The basket page's box and email, checked. Ticked needs a real address; unticked never keeps one. Pure. */
export function checkoutNewsChoice(news: boolean, rawEmail: unknown): NewsChoice {
    if (!news) return { ok: true, email: null };
    const email = normaliseEmail(String(rawEmail ?? '').slice(0, 254));
    if (!email) return { ok: false, error: 'Add your email address so we can send you news, or untick the box.' };
    if (!looksLikeEmail(email)) return { ok: false, error: 'That email address doesn\'t look right. Check it, or untick the box.' };
    return { ok: true, email };
}


/** The Checkout Session fields a ticked basket adds: the email filled in on Stripe's page, and the 1-hour lapse. Pure. */
export function reminderCheckoutParams(email: string | null, now: Date): Pick<Stripe.Checkout.SessionCreateParams, 'customer_email' | 'expires_at'> {
    if (!email) return {};
    return { customer_email: email, expires_at: Math.floor(now.getTime() / 1000) + REMINDER_CHECKOUT_MINUTES * 60 };
}

export const stopUrl = (baseUrl: string, basketId: string) => `${baseUrl.replace(/\/$/, '')}${STOP_PATH}?b=${encodeURIComponent(basketId)}`;

/** The basket's address for the email: the session's own "back" address when it is that basket's page, else the site's. Pure. */
export function basketLinkFor(cancelUrl: string | null | undefined, basketId: string, slug: string | null): string | null {
    try {
        const u = new URL(String(cancelUrl || ''));
        if (u.protocol === 'https:' && u.pathname === BASKET_PATH && u.searchParams.get('b') === basketId) return u.toString();
    } catch { /* fall through */ }
    return slug ? `${siteOrigin(slug)}${BASKET_PATH}?b=${encodeURIComponent(basketId)}` : null;
}

const escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface ReminderLine { name: string; qty: number }

/** The reminder itself. Fixed wording; never a price (prices are read again at checkout). Pure. */
export function reminderEmail(o: { business: string; lines: ReminderLine[]; basketUrl: string; stopUrl: string; postalAddress?: string | null }): { subject: string; html: string; text: string } {
    const business = String(o.business || 'our shop').trim() || 'our shop';
    const lines = o.lines.filter((l) => l && l.name).slice(0, 20);
    const item = (l: ReminderLine) => `${l.name}${l.qty > 1 ? ` × ${l.qty}` : ''}`;
    const subject = `You left something in your basket — ${business}`.slice(0, 150);
    const address = String(o.postalAddress || '').trim();
    const html = `<p>Hello,</p>
<p>You started checking out at ${escHtml(business)} but didn't finish paying, so nothing was taken.${lines.length ? ' Your basket still has:' : ''}</p>
${lines.length ? `<ul>${lines.map((l) => `<li>${escHtml(item(l))}</li>`).join('')}</ul>` : ''}
<p><a href="${escHtml(o.basketUrl)}">Go back to your basket</a></p>
<p>Prices and stock are checked again when you check out. This is the only reminder we'll send about this basket.</p>
<hr>
<p style="font-size:12px;color:#666">You're getting this because you ticked "Send me news" on the ${escHtml(business)} basket page. <a href="${escHtml(o.stopUrl)}">Unsubscribe</a>${address ? `<br>${escHtml(address)}` : ''}</p>`;
    const text = [
        'Hello,', '',
        `You started checking out at ${business} but didn't finish paying, so nothing was taken.${lines.length ? ' Your basket still has:' : ''}`,
        ...lines.map((l) => `- ${item(l)}`), '',
        `Go back to your basket: ${o.basketUrl}`, '',
        'Prices and stock are checked again when you check out. This is the only reminder we\'ll send about this basket.', '',
        `You're getting this because you ticked "Send me news" on the ${business} basket page. Unsubscribe: ${o.stopUrl}`,
        ...(address ? [address] : []),
    ].join('\n');
    return { subject, html, text };
}

/** A column this file needs isn't there yet (db/z-shop-checkout-reminder.sql not applied). */
export function isMissingReminderColumn(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42703' || code === '42P01' || /column "?(reminder_email|reminded_at|reminder_result|checkout_expires_at)"? does not exist/i.test(String(e?.message ?? ''));
}
const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/**
 * At Checkout (after markBasketCheckout): the email the buyer gave beside the ticked box, and when this checkout
 * lapses. An unticked checkout CLEARS any earlier email — they changed their mind. Never throws.
 */
export async function saveReminderEmail(db: Db, o: { basketId: string; siteId: number; sessionId: string; email: string | null; expiresAt: Date | null }): Promise<void> {
    try {
        await db.execute(sql`
            UPDATE site_baskets SET reminder_email = ${o.email}, checkout_expires_at = ${o.expiresAt ? o.expiresAt.toISOString() : null}::timestamp
             WHERE id = ${o.basketId} AND site_id = ${o.siteId} AND checkout_session_id = ${o.sessionId}`);
    } catch (err) {
        if (!isMissingReminderColumn(err)) console.error('[shop-checkout-reminder] saving the email failed (no reminder for this basket)', err instanceof Error ? err.message : err);
    }
}

export type ReminderOutcome = 'not_ticked' | 'not_ours' | 'nothing' | 'too_late' | 'refused' | 'no_route' | 'sent';

async function setResult(db: Db, basketId: string, result: string): Promise<void> {
    await db.execute(sql`UPDATE site_baskets SET reminder_result = ${result} WHERE id = ${basketId}`);
}

/**
 * Stripe says a checkout lapsed (checkout.session.expired on a connected account). Sends the one reminder, or
 * records why not. Throws only when sending failed (the claim is released first) so Stripe retries.
 */
export async function sendCheckoutReminder(db: Db, accountId: string, session: Stripe.Checkout.Session, o: {
    baseUrl: string | null; now?: Date;
    connectAccountFor: (db: Db, orgId: number) => Promise<{ stripeAccountId: string } | null>;
    /** Tests only: the send route and the sender (default: Email Marketing's resolveSendRoute and deliverStep). */
    resolveRoute?: typeof resolveSendRoute; deliver?: typeof deliverStep;
}): Promise<ReminderOutcome> {
    if (!newsTicked(session.metadata as Record<string, string> | null)) return 'not_ticked';
    const basketId = session.metadata?.bms_basket;
    const siteId = Number(session.metadata?.bms_site_id);
    if (!isBasketId(basketId) || !Number.isInteger(siteId) || !o.baseUrl) return 'not_ours';
    const now = o.now ?? new Date();
    if (session.expires_at && now.getTime() - session.expires_at * 1000 > REMINDER_LATE_HOURS * 3600_000) return 'too_late';
    const [site] = await db.select({ id: sites.id, organisationId: sites.organisationId, slug: sites.slug }).from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return 'not_ours';
    // Metadata alone is never trusted: the event's account must be the one this workspace connected.
    const account = await o.connectAccountFor(db, site.organisationId);
    if (!account || account.stripeAccountId !== accountId) return 'not_ours';

    let claimed: { email: string; lines: unknown } | undefined;
    try {
        // The claim: this basket's LATEST checkout, not paid (items left), never reminded, with an email.
        [claimed] = asRows<{ email: string; lines: unknown }>(await db.execute(sql`
            UPDATE site_baskets SET reminded_at = now()
             WHERE id = ${basketId} AND organisation_id = ${site.organisationId} AND site_id = ${site.id}
               AND checkout_session_id = ${session.id} AND reminded_at IS NULL AND reminder_email IS NOT NULL
               AND jsonb_array_length(items) > 0
         RETURNING reminder_email AS email, checkout_lines -> ${session.id}::text AS lines`));
    } catch (err) {
        if (isMissingReminderColumn(err)) return 'nothing';
        throw err;
    }
    if (!claimed) return 'nothing';
    const email = normaliseEmail(claimed.email);

    const verdict = (await checkAudienceConsentBulk(db, site.organisationId, [email])).get(email);
    // Not in the Audience yet (they join when they pay), or unconfirmed elsewhere: the tick here is the consent.
    if (!verdict || (!verdict.sendable && verdict.reason !== 'not_in_audience' && verdict.reason !== 'unconfirmed')) {
        await setResult(db, basketId, 'refused');
        return 'refused';
    }
    const [org] = await db.select({ name: organisations.name, postalAddress: organisations.outreachPostalAddress }).from(organisations).where(eq(organisations.id, site.organisationId)).limit(1);
    const business = org?.name || 'Our shop';
    const routed = await (o.resolveRoute ?? resolveSendRoute)(db, site.organisationId, { recipientCount: 1, senderName: business });
    if ('error' in routed) {
        await setResult(db, basketId, 'no_route');
        return 'no_route';
    }
    const basketUrl = basketLinkFor(session.cancel_url, basketId, site.slug);
    if (!basketUrl) { await setResult(db, basketId, 'failed'); return 'nothing'; }
    const lines = (Array.isArray(claimed.lines) ? claimed.lines : []).map((l: { name?: unknown; qty?: unknown }) => ({ name: String(l?.name ?? '').slice(0, 160), qty: Math.max(1, Math.min(100, Number(l?.qty) || 1)) }));
    const stop = stopUrl(o.baseUrl, basketId);
    const msg = reminderEmail({ business, lines, basketUrl, stopUrl: stop, postalAddress: org?.postalAddress ?? null });
    try {
        await (o.deliver ?? deliverStep)(db, routed.route, site.organisationId, { to: email, subject: msg.subject, html: msg.html, text: msg.text, listUnsubscribe: `<${stop}>` });
    } catch (err) {
        // Let Stripe retry (within REMINDER_LATE_HOURS): release the claim, then fail the webhook.
        await db.execute(sql`UPDATE site_baskets SET reminded_at = NULL WHERE id = ${basketId} AND checkout_session_id = ${session.id}`).catch(() => {});
        throw err;
    }
    await setResult(db, basketId, 'sent');
    return 'sent';
}

export interface ReminderStats { sent: number; paid: number; noRoute: number }

/** The last 7 days of reminders: sent, of those how many came back and paid, and how many couldn't be sent. Never throws. */
export async function loadReminderStats(db: Db, orgId: number): Promise<ReminderStats | null> {
    try {
        const [r] = asRows<{ sent: number; paid: number; no_route: number }>(await db.execute(sql`
            SELECT count(*) FILTER (WHERE b.reminder_result = 'sent')::int AS sent,
                   count(*) FILTER (WHERE b.reminder_result = 'sent' AND EXISTS (
                       SELECT 1 FROM site_orders o WHERE o.organisation_id = b.organisation_id
                          AND o.checkout_session_id = b.checkout_session_id AND o.created_at > b.reminded_at))::int AS paid,
                   count(*) FILTER (WHERE b.reminder_result = 'no_route')::int AS no_route
              FROM site_baskets b
             WHERE b.organisation_id = ${orgId} AND b.reminded_at > now() - interval '7 days'`));
        return r ? { sent: Number(r.sent) || 0, paid: Number(r.paid) || 0, noRoute: Number(r.no_route) || 0 } : null;
    } catch (err) {
        if (!isMissingReminderColumn(err)) console.error('[shop-checkout-reminder] stats read failed', err instanceof Error ? err.message : err);
        return null;
    }
}

/** The Shop tab's line, or null when there is nothing to say. Pure. */
export function reminderStatsWords(s: ReminderStats | null): string | null {
    if (!s || (!s.sent && !s.noRoute)) return null;
    const parts: string[] = [];
    if (s.sent) parts.push(`${s.sent} checkout reminder${s.sent === 1 ? '' : 's'} sent this week, ${s.paid} came back and paid`);
    if (s.noRoute) parts.push(`${s.noRoute} couldn't be sent: verify a sending domain or connect your mailbox in Email Studio ▸ Sending`);
    return parts.join('. ') + '.';
}

/**
 * The reminder's unsubscribe link: the address this basket was reminded at stops getting email from this business.
 * The contact is written as unsubscribed (a row is made when there is none, so a later ticked order can't add them
 * back: refusals win in upsertContact), with the consent event as evidence. Returns the business name, or null
 * when the link is unknown.
 */
export async function stopRemindedAddress(db: Db, basketId: unknown): Promise<{ business: string } | null> {
    if (!isBasketId(basketId)) return null;
    let row: { organisation_id: number; email: string | null; name: string | null } | undefined;
    try {
        [row] = asRows<{ organisation_id: number; email: string | null; name: string | null }>(await db.execute(sql`
            SELECT b.organisation_id, b.reminder_email AS email, o.name FROM site_baskets b JOIN organisations o ON o.id = b.organisation_id
             WHERE b.id = ${basketId} AND b.reminded_at IS NOT NULL`));
    } catch (err) {
        if (isMissingReminderColumn(err)) return null;
        throw err;
    }
    if (!row) return null;
    const business = row.name || 'this business';
    const email = normaliseEmail(row.email || '');
    if (!looksLikeEmail(email)) return { business };   // already stopped
    const orgId = Number(row.organisation_id);
    await upsertContact(db, { organisationId: orgId, email, status: 'unsubscribed', source: 'web_form', sourceDetail: { shopReminderStop: true } });
    await setContactStatus(db, { organisationId: orgId, email, status: 'unsubscribed', event: 'unsubscribed', channel: 'site', evidence: 'Unsubscribed from the abandoned-checkout reminder\'s link.' });
    await db.execute(sql`UPDATE site_baskets SET reminder_email = NULL WHERE id = ${basketId}`);
    return { business };
}
