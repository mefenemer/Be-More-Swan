// src/utils/reviews.ts — Audience ▸ Reviews: what may be saved, the honest average, and
// what a website's reviews section needs. db/z-reviews.sql. tests/reviews.test.ts.
//
// A review is the customer's words, word for word: the checks here tidy spacing, never wording.
// The average counts every review the owner has recorded as published OR hidden — hiding a review
// stops it being quoted, never improves the score (DMCC Act 2024: reviews must not be presented in
// a misleading way). Pending / declined are customer-sent reviews not yet approved — never counted.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgReviews } from '../../db/schema';
import type { SiteDefinition } from './site-definition';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const REVIEW_SOURCES = ['google', 'facebook', 'trustpilot', 'tripadvisor', 'checkatrade', 'yell', 'direct', 'website', 'other'] as const;
export type ReviewSource = typeof REVIEW_SOURCES[number];
/** How the source reads on the site, after the stars: "Google review". */
export const SOURCE_LABEL: Record<ReviewSource, string> = {
    google: 'Google review', facebook: 'Facebook review', trustpilot: 'Trustpilot review', tripadvisor: 'Tripadvisor review',
    checkatrade: 'Checkatrade review', yell: 'Yell review', direct: 'Sent to us directly', website: 'Left on our website', other: 'Review',
};
export const REVIEW_LIMITS = { name: 80, detail: 80, body: 2000, url: 500, perWorkspace: 1000, batch: 50 } as const;
export const COUNTED_STATUSES = ['published', 'hidden'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const tidyLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Keeps the reviewer's words and line breaks; only trims blank lines and trailing spaces. */
const tidyBody = (v: unknown) => (typeof v === 'string'
    ? v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : '');

/** One review to save (partial = an edit: only the fields sent change). Returns the columns. */
export function cleanReview(raw: Record<string, unknown>, partial: boolean, today = new Date()): Result<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    if (!partial || has('authorName')) {
        const name = tidyLine(raw.authorName, REVIEW_LIMITS.name);
        if (!name) return { ok: false, error: 'Who left the review? A first name is fine — e.g. Sarah K.' };
        out.authorName = name;
    }
    if (has('authorDetail')) out.authorDetail = tidyLine(raw.authorDetail, REVIEW_LIMITS.detail) || null;
    if (!partial || has('body')) {
        const body = tidyBody(raw.body);
        if (!body) return { ok: false, error: 'Add what they said, word for word.' };
        if (body.length > REVIEW_LIMITS.body) return { ok: false, error: `A review can be up to ${REVIEW_LIMITS.body} characters.` };
        out.body = body;
    }
    if (!partial || has('rating')) {
        const r = raw.rating;
        if (r === null || r === undefined || r === '') out.rating = null;
        else {
            const n = Number(r);
            if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'Stars are 1 to 5 (or none, if they didn\'t give any).' };
            out.rating = n;
        }
    }
    if (!partial || has('source')) {
        const src = raw.source ?? 'direct';
        if (!(REVIEW_SOURCES as readonly unknown[]).includes(src)) return { ok: false, error: 'Choose where the review was left.' };
        out.source = src;
    }
    if (has('sourceUrl')) {
        const u = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : '';
        if (u && (!/^https:\/\/[^\s]+$/.test(u) || u.length > REVIEW_LIMITS.url)) return { ok: false, error: 'The link to the review must start with https://.' };
        out.sourceUrl = u || null;
    }
    if (!partial || has('reviewedOn')) {
        const d = typeof raw.reviewedOn === 'string' ? raw.reviewedOn.trim() : '';
        if (!d) out.reviewedOn = null;
        else {
            if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return { ok: false, error: 'The date must be a date.' };
            if (d > today.toISOString().slice(0, 10)) return { ok: false, error: 'The review date can\'t be in the future.' };
            out.reviewedOn = d;
        }
    }
    if (has('status')) {
        if (raw.status !== 'published' && raw.status !== 'hidden') return { ok: false, error: 'A review is either shown or hidden.' };
        out.status = raw.status;
    }
    return { ok: true, value: out };
}

export interface ReviewSummary { average: number; count: number; rated: number; }

/** Average of the rated reviews, to one decimal; count = every counted review. Null when none is rated. */
export function reviewSummary(rows: Array<{ rating: number | null; status: string }>): ReviewSummary | null {
    const counted = rows.filter((r) => (COUNTED_STATUSES as readonly string[]).includes(r.status));
    const rated = counted.filter((r) => typeof r.rating === 'number');
    if (!rated.length) return null;
    const avg = rated.reduce((a, r) => a + (r.rating as number), 0) / rated.length;
    return { average: Math.round(avg * 10) / 10, count: counted.length, rated: rated.length };
}

/** A review as a site draws it. */
export interface SiteRenderReview { id: number; authorName: string; authorDetail: string | null; rating: number | null; body: string; sourceLabel: string; sourceUrl: string | null; reviewedOn: string | null; }
export interface SiteRenderReviews { summary: ReviewSummary | null; byId: Record<number, SiteRenderReview>; latest: number[]; }

/** Every review a site may need: the summary, the published reviews by id, newest first. */
export async function loadSiteReviews(db: Db, orgId: number, def: SiteDefinition): Promise<SiteRenderReviews | null> {
    if (!def.pages.some((p) => p.sections.some((s) => s.type === 'reviews'))) return null;
    const rows = await db.select().from(orgReviews)
        .where(and(eq(orgReviews.organisationId, orgId), inArray(orgReviews.status, [...COUNTED_STATUSES])))
        .orderBy(desc(orgReviews.reviewedOn), desc(orgReviews.id));
    const published = rows.filter((r) => r.status === 'published');
    return {
        summary: reviewSummary(rows),
        byId: Object.fromEntries(published.map((r) => [r.id, {
            id: r.id, authorName: r.authorName, authorDetail: r.authorDetail, rating: r.rating, body: r.body,
            sourceLabel: SOURCE_LABEL[(REVIEW_SOURCES as readonly string[]).includes(r.source) ? r.source as ReviewSource : 'other'],
            sourceUrl: r.sourceUrl, reviewedOn: r.reviewedOn,
        }])),
        latest: published.map((r) => r.id),
    };
}

/** For the chat: what it may quote by id, and the honest score. */
export async function reviewsForPrompt(db: Db, orgId: number): Promise<string> {
    const rows = await db.select({ id: orgReviews.id, authorName: orgReviews.authorName, rating: orgReviews.rating, body: orgReviews.body, status: orgReviews.status, source: orgReviews.source })
        .from(orgReviews).where(and(eq(orgReviews.organisationId, orgId), inArray(orgReviews.status, [...COUNTED_STATUSES])))
        .orderBy(desc(orgReviews.reviewedOn), desc(orgReviews.id));
    const waiting = await db.select({ id: orgReviews.id, authorName: orgReviews.authorName, rating: orgReviews.rating, body: orgReviews.body })
        .from(orgReviews).where(and(eq(orgReviews.organisationId, orgId), eq(orgReviews.status, 'pending'))).orderBy(desc(orgReviews.createdAt)).limit(10);
    const pendingLine = waiting.length
        ? ` Waiting for their approval (sent in by customers; for a review_decisions card): ${waiting.map((r) => `reviewId ${r.id} — ${r.authorName}${r.rating ? `, ${r.rating}★` : ''}: "${r.body.replace(/\s+/g, ' ').slice(0, 160)}${r.body.length > 160 ? '…' : ''}"`).join('; ')}.`
        : '';
    if (!rows.length) return (pendingLine ? pendingLine.trim() + ' ' : '') + 'They have no reviews in Audience ▸ Reviews yet — a reviews section needs them (Audience ▸ Reviews, or they can paste reviews to you and you offer a reviews_add card).';
    const s = reviewSummary(rows);
    const shown = rows.filter((r) => r.status === 'published').slice(0, 30);
    return `Their reviews (Audience ▸ Reviews; for a reviews section's reviewIds)${s ? `, average ${s.average} from ${s.rated} rated` : ''}: ${shown.map((r) => `reviewId ${r.id} — ${r.authorName}${r.rating ? `, ${r.rating}★` : ''}, ${r.source}: "${r.body.replace(/\s+/g, ' ').slice(0, 80)}${r.body.length > 80 ? '…' : ''}"`).join('; ')}${rows.length > shown.length ? ` (and ${rows.length - shown.length} more, some hidden)` : ''}.${pendingLine}`;
}
