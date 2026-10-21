// src/utils/review-requests.ts — asking customers for a review after a booking or a website order.
// db/z-review-requests.sql. Sent by send-review-requests.ts (hourly); answered on the business's own
// site (site-review.ts); approved in Audience ▸ Reviews (org-reviews.ts).
// tests/review-requests.test.ts.
//
// The rules, all enforced here:
//   • Off until the owner turns it on, and only for bookings / orders AFTER that moment.
//   • One email per booking or order (a unique row, claimed before sending), never a reminder.
//   • Not the same person twice within 30 days, and never someone who said "don't ask me again".
//   • Neutral wording, nothing to sell — a request for feedback, not marketing.
//   • The Google link (if set) goes to EVERY customer, whatever they might say: no review gating.
//   • A review sent in waits as 'pending' until the owner approves it; nothing is published unseen.

import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings, organisations, orgProducts, reviewOptOuts, reviewRequests, reviewSettings, siteOrders, sites, users, aiAssistants } from '../../db/schema';
import { emailKey, fromLine } from './bookings';
import { sendEmail } from './email';
import { esc, REVIEW_PATH } from './site-render';
import { siteOrigin } from './site-hosting';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const REVIEW_REQUEST_RULES = { notTwiceWithinDays: 30, lookbackDays: 30, batch: 200 } as const;

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

export interface ReviewRequestSettings { askAfterBookings: boolean; askAfterOrders: boolean; bookingDelayHours: number; orderDelayDays: number; googleReviewUrl: string | null; enabledAt: string | null; }
export const REVIEW_REQUEST_DEFAULTS: ReviewRequestSettings = { askAfterBookings: false, askAfterOrders: false, bookingDelayHours: 24, orderDelayDays: 7, googleReviewUrl: null, enabledAt: null };
export const BOOKING_DELAYS = [2, 24, 48, 72, 168] as const;

export function cleanReviewRequestSettings(raw: Record<string, unknown>): Result<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    for (const k of ['askAfterBookings', 'askAfterOrders'] as const) if (has(k)) out[k] = raw[k] === true;
    if (has('bookingDelayHours')) {
        const n = Number(raw.bookingDelayHours);
        if (!Number.isInteger(n) || n < 1 || n > 336) return { ok: false, error: 'Choose when to ask after a booking.' };
        out.bookingDelayHours = n;
    }
    if (has('orderDelayDays')) {
        const n = Number(raw.orderDelayDays);
        if (!Number.isInteger(n) || n < 1 || n > 30) return { ok: false, error: 'Ask between 1 and 30 days after an order.' };
        out.orderDelayDays = n;
    }
    if (has('googleReviewUrl')) {
        const u = typeof raw.googleReviewUrl === 'string' ? raw.googleReviewUrl.trim() : '';
        if (u && (!/^https:\/\/[^\s]+$/.test(u) || u.length > 500)) return { ok: false, error: 'Your Google review link must start with https://.' };
        out.googleReviewUrl = u || null;
    }
    return { ok: true, value: out };
}

export function reviewRequestSettingsFrom(row: Partial<typeof reviewSettings.$inferSelect> | null | undefined): ReviewRequestSettings {
    if (!row) return { ...REVIEW_REQUEST_DEFAULTS };
    return {
        askAfterBookings: row.askAfterBookings === true, askAfterOrders: row.askAfterOrders === true,
        bookingDelayHours: row.bookingDelayHours ?? 24, orderDelayDays: row.orderDelayDays ?? 7,
        googleReviewUrl: row.googleReviewUrl ?? null, enabledAt: row.enabledAt ? new Date(row.enabledAt).toISOString() : null,
    };
}

/** Save; the first time asking is switched on stamps enabled_at, so nothing before it is ever asked about. */
export async function saveReviewRequestSettings(db: Db, orgId: number, values: Record<string, unknown>): Promise<ReviewRequestSettings> {
    const [current] = await db.select().from(reviewSettings).where(eq(reviewSettings.organisationId, orgId)).limit(1);
    const turningOn = (values.askAfterBookings === true || values.askAfterOrders === true) && !(current?.askAfterBookings || current?.askAfterOrders);
    const set = { ...values, ...(turningOn ? { enabledAt: new Date() } : {}), updatedAt: new Date() };
    const [row] = await db.insert(reviewSettings).values({ organisationId: orgId, ...set })
        .onConflictDoUpdate({ target: reviewSettings.organisationId, set }).returning();
    return reviewRequestSettingsFrom(row);
}

// ── The link in the email ───────────────────────────────────────────────────────────────────────

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set — cannot sign review links.');
    return s;
}
/** 20 hex characters (80 bits): unguessable, so request ids cannot be walked; stable per request. */
export function signReviewRequest(id: number, key = secret()): string {
    return createHmac('sha256', key).update(`review-request:${id}`).digest('hex').slice(0, 20);
}
export function verifyReviewToken(id: number, token: string, key?: string): boolean {
    let expected: Buffer;
    try { expected = Buffer.from(signReviewRequest(id, key ?? secret())); } catch { return false; }
    const given = Buffer.from(String(token || ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}
export function reviewRequestUrl(origin: string, id: number, extra = ''): string {
    return `${origin.replace(/\/+$/, '')}${REVIEW_PATH}?r=${id}&t=${signReviewRequest(id)}${extra}`;
}

// ── The email ───────────────────────────────────────────────────────────────────────────────────

export function reviewRequestEmail(p: { business: string; firstName: string | null; about: string | null; link: string; stopLink: string; googleUrl: string | null }): { subject: string; html: string } {
    const hi = p.firstName ? `Hi ${esc(p.firstName)},` : 'Hello,';
    return {
        subject: `How did we do? — ${p.business}`,
        html: `<p>${hi}</p>
<p>Thank you for choosing ${esc(p.business)}${p.about ? ` for ${esc(p.about)}` : ''}. Would you tell us how it went? It takes a minute, and it helps us and other customers.</p>
<p><a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">Leave a review</a></p>
${p.googleUrl ? `<p>Or, if you prefer, <a href="${esc(p.googleUrl)}">review us on Google</a>.</p>` : ''}
<p style="color:#666;font-size:13px">This is the only email you'll get about it. <a href="${esc(p.stopLink)}" style="color:#666">Don't ask me for reviews again</a>.</p>`,
    };
}

const firstNameOf = (name: string | null) => (name ? name.trim().split(/\s+/)[0].slice(0, 40) : null);

// ── Who is due ──────────────────────────────────────────────────────────────────────────────────

interface Candidate { organisationId: number; siteId: number | null; bookingId: number | null; orderId: number | null; name: string | null; email: string; about: string | null; }

/** Confirmed bookings that ended at least the delay ago, after asking was switched on, not yet asked. */
async function dueBookings(db: Db, now: Date): Promise<Candidate[]> {
    const rows = await db.select({
        id: bookings.id, organisationId: bookings.organisationId, siteId: bookings.siteId, name: bookings.customerName, email: bookings.customerEmail,
        service: orgProducts.name, kind: bookings.kind,
    }).from(bookings)
        .innerJoin(reviewSettings, eq(reviewSettings.organisationId, bookings.organisationId))
        .leftJoin(orgProducts, eq(orgProducts.id, bookings.serviceId))
        .where(and(
            eq(reviewSettings.askAfterBookings, true), isNotNull(reviewSettings.enabledAt), eq(bookings.status, 'confirmed'),
            sql`${bookings.endsAt} <= ${now.toISOString()}::timestamptz - make_interval(hours => ${reviewSettings.bookingDelayHours})`,
            sql`${bookings.endsAt} >= ${reviewSettings.enabledAt}`,
            gt(bookings.endsAt, new Date(now.getTime() - REVIEW_REQUEST_RULES.lookbackDays * 86_400_000)),
            sql`NOT EXISTS (SELECT 1 FROM review_requests rr WHERE rr.booking_id = ${bookings.id})`,
        )).limit(REVIEW_REQUEST_RULES.batch);
    return rows.map((r) => ({ organisationId: r.organisationId, siteId: r.siteId, bookingId: r.id, orderId: null, name: r.name, email: r.email,
        about: r.service ? `your ${r.service.toLowerCase().startsWith('the ') ? r.service.slice(4) : r.service}` : r.kind === 'table' ? 'your table booking' : 'your booking' }));
}

/** Paid website orders the delay ago, after asking was switched on, not yet asked. */
async function dueOrders(db: Db, now: Date): Promise<Candidate[]> {
    const rows = await db.select({ id: siteOrders.id, organisationId: siteOrders.organisationId, siteId: siteOrders.siteId, name: siteOrders.customerName, email: siteOrders.customerEmail, item: siteOrders.itemName })
        .from(siteOrders)
        .innerJoin(reviewSettings, eq(reviewSettings.organisationId, siteOrders.organisationId))
        .where(and(
            eq(reviewSettings.askAfterOrders, true), isNotNull(reviewSettings.enabledAt), inArray(siteOrders.status, ['paid', 'done']), isNotNull(siteOrders.customerEmail),
            sql`${siteOrders.createdAt} <= ${now.toISOString()}::timestamp - make_interval(days => ${reviewSettings.orderDelayDays})`,
            gte(siteOrders.createdAt, sql`${reviewSettings.enabledAt}`),
            gt(siteOrders.createdAt, new Date(now.getTime() - (REVIEW_REQUEST_RULES.lookbackDays + 30) * 86_400_000)),
            sql`NOT EXISTS (SELECT 1 FROM review_requests rr WHERE rr.order_id = ${siteOrders.id})`,
        )).limit(REVIEW_REQUEST_RULES.batch);
    return rows.map((r) => ({ organisationId: r.organisationId, siteId: r.siteId, bookingId: null, orderId: r.id, name: r.name, email: r.email!, about: r.item ? `your ${r.item}` : 'your order' }));
}

/** Why this person should NOT be emailed now, or null. */
export async function skipReason(db: Db, orgId: number, email: string, now: Date): Promise<string | null> {
    const [out] = await db.select({ id: reviewOptOuts.id }).from(reviewOptOuts)
        .where(and(eq(reviewOptOuts.organisationId, orgId), eq(reviewOptOuts.emailKey, emailKey(email)))).limit(1);
    if (out) return 'opted_out';
    const since = new Date(now.getTime() - REVIEW_REQUEST_RULES.notTwiceWithinDays * 86_400_000);
    const [recent] = await db.select({ id: reviewRequests.id }).from(reviewRequests).where(and(
        eq(reviewRequests.organisationId, orgId), sql`lower(${reviewRequests.customerEmail}) = ${email.trim().toLowerCase()}`, gte(reviewRequests.sentAt, since),
    )).limit(1);
    return recent ? 'asked_recently' : null;
}

/** One hourly run: claim each due booking / order, then email (or record why not). Returns emails sent. */
export async function sendDueReviewRequests(db: Db, now: Date): Promise<number> {
    const due = [...await dueBookings(db, now), ...await dueOrders(db, now)];
    if (!due.length) return 0;
    const orgIds = [...new Set(due.map((d) => d.organisationId))];
    const siteIds = [...new Set(due.map((d) => d.siteId).filter((x): x is number => x !== null))];
    const [orgRows, siteRows, settingRows] = await Promise.all([
        db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, orgIds)),
        siteIds.length ? db.select({ id: sites.id, slug: sites.slug, status: sites.status, aiAssistantId: sites.aiAssistantId }).from(sites).where(inArray(sites.id, siteIds)) : Promise.resolve([]),
        db.select().from(reviewSettings).where(inArray(reviewSettings.organisationId, orgIds)),
    ]);
    let sent = 0;
    for (const d of due) {
        // Claim first: the unique index on booking_id / order_id means only one run gets the row.
        const [claim] = await db.insert(reviewRequests).values({
            organisationId: d.organisationId, siteId: d.siteId, bookingId: d.bookingId, orderId: d.orderId,
            customerName: d.name, customerEmail: d.email, about: d.about,
        }).onConflictDoNothing().returning({ id: reviewRequests.id });
        if (!claim) continue;
        const site = siteRows.find((s) => s.id === d.siteId);
        const why = !site || !site.slug || site.status !== 'published' ? 'site_not_live' : await skipReason(db, d.organisationId, d.email, now);
        if (why) { await db.update(reviewRequests).set({ skippedReason: why }).where(eq(reviewRequests.id, claim.id)); continue; }
        const business = orgRows.find((o) => o.id === d.organisationId)?.name || 'Our business';
        const settings = reviewRequestSettingsFrom(settingRows.find((r) => r.organisationId === d.organisationId));
        const origin = siteOrigin(site!.slug!);
        const [owner] = site!.aiAssistantId ? await db.select({ email: users.email }).from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId)).where(eq(aiAssistants.id, site!.aiAssistantId)).limit(1) : [];
        const { subject, html } = reviewRequestEmail({
            business, firstName: firstNameOf(d.name), about: d.about,
            link: reviewRequestUrl(origin, claim.id), stopLink: reviewRequestUrl(origin, claim.id, '&stop=1'), googleUrl: settings.googleReviewUrl,
        });
        try {
            await sendEmail({ to: d.email, from: fromLine(business), ...(owner?.email ? { replyTo: owner.email } : {}), subject, html });
            await db.update(reviewRequests).set({ sentAt: new Date() }).where(eq(reviewRequests.id, claim.id));
            sent++;
        } catch (err) {
            console.error('[review-requests] email failed', err instanceof Error ? err.message : err);
            await db.update(reviewRequests).set({ skippedReason: 'send_failed' }).where(eq(reviewRequests.id, claim.id));
        }
    }
    return sent;
}

/** A request as its page needs it, if the link is genuine. */
export async function loadReviewRequest(db: Db, orgId: number, id: number, token: string) {
    if (!Number.isInteger(id) || id <= 0 || !verifyReviewToken(id, token)) return null;
    const [row] = await db.select().from(reviewRequests).where(and(eq(reviewRequests.id, id), eq(reviewRequests.organisationId, orgId))).limit(1);
    return row ?? null;
}

/** "Don't ask me again" — remembered for this business only. */
export async function optOutOfReviewRequests(db: Db, orgId: number, email: string): Promise<void> {
    await db.insert(reviewOptOuts).values({ organisationId: orgId, emailKey: emailKey(email) }).onConflictDoNothing();
}

export async function reviewSettingsFor(db: Db, orgId: number): Promise<ReviewRequestSettings> {
    const [row] = await db.select().from(reviewSettings).where(eq(reviewSettings.organisationId, orgId)).limit(1);
    return reviewRequestSettingsFrom(row);
}

