// src/utils/platform-reviews.ts
// Reviews OF Be More Swan, from the people using it — beta testers first (owner, 2026-10-29: "start
// recording reviews, even with the beta testers, so that we are searchable"). Tables in
// db/z-platform-reviews.sql. Not org_reviews (src/utils/reviews.ts): those are a customer's reviews of
// their own business.
//
// The rules this file holds, because UK law (DMCC Act 2024) and the review sites both enforce them:
//   • the reviewer's words are kept word for word;
//   • anyone who got something from us says so beside any public quote — beta testers had free access;
//   • a review is quoted only if its author said yes, and only once an admin publishes it;
//   • Trustpilot and G2 are offered to EVERY reviewer alike, whatever their stars (no review gating);
//   • nobody is asked while a payment is failing, under impersonation, or after "don't ask me again".
//
// When the app asks (owner chose Phase 2 on 2026-10-29; the trigger was left to us): an account at
// least 14 days old that has had 5 posts published, or any account 30 days old; at most 3 times, a
// week apart. An admin's emailed request (Customers → Beta testers) skips the waiting.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, platformReviewAsks, platformReviews, scheduledPosts, users } from '../../db/schema';
import { BETA_PLAN_TYPE } from './beta-testers';

type Db = ReturnType<typeof getDb>;

export const REVIEW_TEXT_MAX = 2000;
export const NAME_MAX = 80;
export const BETA_INCENTIVE_NOTE = 'Received free access during beta';

export const ASK_RULES = {
    minAccountDays: 14,
    minPublishedPosts: 5,
    anywayAfterDays: 30,
    maxAsks: 3,
    daysBetweenAsks: 7,
    laterDays: 14,
} as const;

export const DESTINATIONS = {
    trustpilot: { label: 'Trustpilot', hosts: ['trustpilot.com', 'uk.trustpilot.com', 'www.trustpilot.com'] },
    g2: { label: 'G2', hosts: ['g2.com', 'www.g2.com'] },
} as const;
export type DestinationKey = keyof typeof DESTINATIONS;
export const DESTINATION_KEYS = Object.keys(DESTINATIONS) as DestinationKey[];
export type Destinations = Partial<Record<DestinationKey, string>>;

export const REVIEW_STATUSES = ['pending', 'published', 'hidden'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];

const DAY = 86_400_000;
const tidyLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Keeps the reviewer's words and line breaks; only trims blank lines and spaces at the ends. */
const tidyBody = (v: unknown) => (typeof v === 'string'
    ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '');

export interface CleanReview {
    rating: number; body: string; displayName: string | null; displayDetail: string | null; consentToPublish: boolean;
}

export function cleanPlatformReview(raw: Record<string, unknown>): { ok: true; value: CleanReview } | { ok: false; error: string } {
    const rating = Number(raw.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Choose from 1 to 5 stars.' };
    const body = tidyBody(raw.body);
    if (!body) return { ok: false, error: 'Tell us a little about how it has gone.' };
    if (body.length > REVIEW_TEXT_MAX) return { ok: false, error: `Please keep it under ${REVIEW_TEXT_MAX} characters.` };
    const consentToPublish = raw.consentToPublish === true;
    const displayName = tidyLine(raw.displayName, NAME_MAX) || null;
    if (consentToPublish && !displayName) return { ok: false, error: 'Add the name we should show with your review, or untick the box.' };
    return { ok: true, value: { rating, body, displayName, displayDetail: tidyLine(raw.displayDetail, NAME_MAX) || null, consentToPublish } };
}

/** Only https links on the site's own domain — a stored link is shown to every reviewer. */
export function cleanDestinations(raw: unknown): { ok: true; value: Destinations } | { ok: false; error: string } {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: Destinations = {};
    for (const key of DESTINATION_KEYS) {
        const v = typeof src[key] === 'string' ? (src[key] as string).trim() : '';
        if (!v) continue;
        let u: URL;
        try { u = new URL(v); } catch { return { ok: false, error: `The ${DESTINATIONS[key].label} link is not a web address.` }; }
        if (u.protocol !== 'https:' || !(DESTINATIONS[key].hosts as readonly string[]).includes(u.hostname.toLowerCase())) {
            return { ok: false, error: `The ${DESTINATIONS[key].label} link must be an https link on ${DESTINATIONS[key].hosts[0]}.` };
        }
        out[key] = u.toString();
    }
    return { ok: true, value: out };
}

/** The links offered after a review — the same list for every reviewer, whatever they gave. */
export function destinationList(d: Destinations): Array<{ key: DestinationKey; label: string; url: string }> {
    return DESTINATION_KEYS.filter((k) => d[k]).map((k) => ({ key: k, label: DESTINATIONS[k].label, url: d[k] as string }));
}

export interface AskInput {
    now: Date;
    accountCreatedAt: Date | null;
    publishedPosts: number;
    hasReview: boolean;
    impersonating: boolean;
    paymentFailing: boolean;
    ask: { askCount: number; lastAskedAt: Date | null; snoozedUntil: Date | null; optedOutAt: Date | null; requestedAt: Date | null } | null;
}

/** Pure: should the app ask this person for a review right now? `why` is for tests and the admin page. */
export function shouldAsk(i: AskInput): { ask: boolean; why: string } {
    if (i.hasReview) return { ask: false, why: 'already reviewed' };
    if (i.impersonating) return { ask: false, why: 'impersonation' };
    if (i.paymentFailing) return { ask: false, why: 'payment failing' };
    const a = i.ask;
    if (a?.optedOutAt) return { ask: false, why: 'opted out' };
    const now = i.now.getTime();
    if (a?.snoozedUntil && a.snoozedUntil.getTime() > now) return { ask: false, why: 'maybe later' };
    // An admin's request is answered the next time they open the app, once, whatever their age.
    if (a?.requestedAt && (!a.lastAskedAt || a.lastAskedAt.getTime() < a.requestedAt.getTime())) return { ask: true, why: 'admin request' };
    if ((a?.askCount ?? 0) >= ASK_RULES.maxAsks) return { ask: false, why: 'asked enough' };
    if (a?.lastAskedAt && now - a.lastAskedAt.getTime() < ASK_RULES.daysBetweenAsks * DAY) return { ask: false, why: 'asked recently' };
    if (!i.accountCreatedAt) return { ask: false, why: 'no account date' };
    const days = (now - i.accountCreatedAt.getTime()) / DAY;
    if (days >= ASK_RULES.anywayAfterDays) return { ask: true, why: `${ASK_RULES.anywayAfterDays} days` };
    if (days >= ASK_RULES.minAccountDays && i.publishedPosts >= ASK_RULES.minPublishedPosts) return { ask: true, why: 'posts published' };
    return { ask: false, why: 'too early' };
}

/** Average over everything counted — published AND hidden; hiding a review never improves the score. */
export function reviewStats(rows: Array<{ rating: number; status: string; sharedTo: string[] }>) {
    const counted = rows.filter((r) => r.status === 'published' || r.status === 'hidden');
    const avg = counted.length ? Math.round((counted.reduce((s, r) => s + r.rating, 0) / counted.length) * 10) / 10 : null;
    const shared: Record<string, number> = {};
    for (const r of rows) for (const s of r.sharedTo || []) shared[s] = (shared[s] || 0) + 1;
    return {
        total: rows.length,
        pending: rows.filter((r) => r.status === 'pending').length,
        published: rows.filter((r) => r.status === 'published').length,
        average: avg,
        shared,
    };
}

/** Postgres "relation does not exist" — db/z-platform-reviews.sql has not been applied here. */
export function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

// ── DB ──────────────────────────────────────────────────────────────────────

export async function wasOnBeta(db: Db, organisationId: number): Promise<boolean> {
    const [row] = await db.select({ id: plans.id }).from(plans)
        .where(and(eq(plans.organisationId, organisationId), eq(plans.planType, BETA_PLAN_TYPE))).limit(1);
    return !!row;
}

/** Everything shouldAsk needs, read in one go. */
export async function askInputFor(db: Db, userId: number, organisationId: number, impersonating: boolean, now = new Date()): Promise<AskInput> {
    const [[user], [posts], [failing], [review], [ask]] = await Promise.all([
        db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
        db.select({ n: sql<number>`count(*)::int` }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.organisationId, organisationId), isNotNull(scheduledPosts.publishedAt))),
        db.select({ id: plans.id }).from(plans).where(and(eq(plans.organisationId, organisationId), eq(plans.status, 'past_due'))).limit(1),
        db.select({ id: platformReviews.id }).from(platformReviews).where(eq(platformReviews.userId, userId)).limit(1),
        db.select().from(platformReviewAsks).where(eq(platformReviewAsks.userId, userId)).limit(1),
    ]);
    return {
        now, accountCreatedAt: user?.createdAt ?? null, publishedPosts: Number(posts?.n ?? 0),
        hasReview: !!review, impersonating, paymentFailing: !!failing, ask: ask ?? null,
    };
}

/** 'shown' counts an ask; 'later' snoozes; 'never' stops asking for good. */
export async function recordAsk(db: Db, userId: number, what: 'shown' | 'later' | 'never', now = new Date()): Promise<void> {
    const set = what === 'shown'
        ? { askCount: sql`${platformReviewAsks.askCount} + 1`, lastAskedAt: now, updatedAt: now }
        : what === 'later'
            ? { snoozedUntil: new Date(now.getTime() + ASK_RULES.laterDays * DAY), updatedAt: now }
            : { optedOutAt: now, updatedAt: now };
    const insert = what === 'shown' ? { userId, askCount: 1, lastAskedAt: now, updatedAt: now }
        : what === 'later' ? { userId, snoozedUntil: new Date(now.getTime() + ASK_RULES.laterDays * DAY), updatedAt: now }
            : { userId, optedOutAt: now, updatedAt: now };
    await db.insert(platformReviewAsks).values(insert).onConflictDoUpdate({ target: platformReviewAsks.userId, set });
}

/** An admin asked this person by email: the app asks them once more next time, whatever their age. */
export async function recordRequest(db: Db, userId: number, adminId: number, now = new Date()): Promise<void> {
    await db.insert(platformReviewAsks).values({ userId, requestedAt: now, requestedBy: adminId, updatedAt: now })
        .onConflictDoUpdate({ target: platformReviewAsks.userId, set: { requestedAt: now, requestedBy: adminId, updatedAt: now } });
}
