// src/utils/newsletter-link-clicks.ts
// "Which link worked" — recording a click against the link it was on, and reading it back.

import { createHash } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { newsletterLinkClicks } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Long enough for a real campaign url with tracking parameters; short enough to store per row. */
export const MAX_URL_CHARS = 2000;

/** The label shown instead of a raw unsubscribe url, which is per-recipient and not a destination. */
export const UNSUBSCRIBE_LABEL = 'Unsubscribe link';

export interface NormalisedClick {
    /** What to store and show. */
    url: string;
    /** What identifies the link. Hash, because a btree entry is capped near 2704 bytes. */
    hash: string;
    /** True when this is our own unsubscribe endpoint rather than one of the tenant's links. */
    isUnsubscribe: boolean;
}

/**
 * Reduce a clicked url to the thing a tenant means by "a link in my newsletter".
 *
 * ⚠️ THE UNSUBSCRIBE COLLAPSE IS THE POINT OF THIS FUNCTION. Every recipient's unsubscribe url
 * carries their own token, so a five-thousand-person issue would produce up to five thousand
 * DISTINCT one-click rows — burying the three links the tenant actually wrote under a wall of
 * noise, and making "which link worked" unreadable in exactly the report built to answer it. They
 * collapse to one row, kept rather than dropped: how many people went looking for the way out is
 * worth knowing, and hiding it would be a different kind of dishonest.
 *
 * Everything else is left ALONE — including utm parameters. Two urls that differ only by campaign
 * tag are two links the tenant chose to distinguish, and merging them would answer a question they
 * did not ask.
 */
export function normaliseClickUrl(raw: unknown): NormalisedClick | null {
    const input = String(raw ?? '').trim().slice(0, MAX_URL_CHARS);
    if (!input || !/^https?:\/\//i.test(input)) return null;

    let url = input;
    let isUnsubscribe = false;
    try {
        const parsed = new URL(input);
        // Our own endpoint, whatever host it is served from — path, not domain, because a tenant on
        // a custom domain still unsubscribes through this route.
        if (/\/(api\/newsletter\/unsubscribe|\.netlify\/functions\/newsletter-unsubscribe)\/?$/i.test(parsed.pathname)) {
            isUnsubscribe = true;
            url = `${parsed.origin}${parsed.pathname}`;
        }
    } catch {
        // An unparseable url is still a click. Recorded verbatim rather than dropped: losing the
        // event would understate a link's performance for a reason nobody could see.
    }

    return { url, hash: createHash('sha256').update(url).digest('hex'), isUnsubscribe };
}

/**
 * Record one click against one link.
 *
 * Idempotent per (recipient, link): the first click inserts the row, every repeat increments it.
 * ⚠️ Best effort by contract — a failure here must never turn a webhook into a 500, because the
 * provider would retry the whole event and the ledger writes beside it are the ones that matter.
 */
export async function recordLinkClick(
    db: Db,
    args: { organisationId: number; issueId: number; sendId: number; rawUrl: unknown; at?: Date },
): Promise<'new' | 'repeat' | 'skipped'> {
    const link = normaliseClickUrl(args.rawUrl);
    if (!link) return 'skipped';
    const at = args.at ?? new Date();

    try {
        const [inserted] = await db.insert(newsletterLinkClicks).values({
            organisationId: args.organisationId,
            issueId: args.issueId,
            sendId: args.sendId,
            url: link.url,
            urlHash: link.hash,
            clickCount: 1,
            firstClickedAt: at,
            lastClickedAt: at,
        }).onConflictDoNothing().returning({ id: newsletterLinkClicks.id });

        if (inserted) return 'new';

        await db.update(newsletterLinkClicks)
            .set({
                clickCount: sql`${newsletterLinkClicks.clickCount} + 1`,
                lastClickedAt: at,
            })
            .where(and(
                eq(newsletterLinkClicks.sendId, args.sendId),
                eq(newsletterLinkClicks.urlHash, link.hash),
            ));
        return 'repeat';
    } catch (err) {
        console.error('[newsletter-link-clicks] could not record a click', { issueId: args.issueId }, err);
        return 'skipped';
    }
}

export interface LinkReportRow {
    url: string;
    /** How many PEOPLE clicked it. */
    people: number;
    /** How many TIMES it was clicked. */
    clicks: number;
    isUnsubscribe: boolean;
}

/**
 * Every link clicked in one issue, most-clicked first.
 *
 * Aggregate by choice. The rows underneath name a recipient — they exist so that "unique" is exact
 * rather than estimated — but "who clicked what" is a different feature with different consent
 * questions, and nothing here builds a view of it.
 */
export async function linkReportForIssue(
    db: Db,
    organisationId: number,
    issueId: number,
): Promise<LinkReportRow[]> {
    try {
        const rows = await db
            .select({
                url: sql<string>`min(${newsletterLinkClicks.url})`,
                people: sql<number>`count(*)::int`,
                clicks: sql<number>`sum(${newsletterLinkClicks.clickCount})::int`,
            })
            .from(newsletterLinkClicks)
            .where(and(
                eq(newsletterLinkClicks.issueId, issueId),
                eq(newsletterLinkClicks.organisationId, organisationId),
            ))
            .groupBy(newsletterLinkClicks.urlHash)
            .orderBy(sql`count(*) DESC`)
            .limit(50);

        return rows.map((r) => ({
            url: r.url,
            people: Number(r.people) || 0,
            clicks: Number(r.clicks) || 0,
            isUnsubscribe: !!normaliseClickUrl(r.url)?.isUnsubscribe,
        }));
    } catch (err) {
        // A missing table means the migration has not been applied here. An issue's own numbers
        // must still open — a report that is not built yet is not a broken page.
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code !== '42P01') throw err;
        return [];
    }
}
