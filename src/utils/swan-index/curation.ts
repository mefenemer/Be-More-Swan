// src/utils/swan-index/curation.ts
// The Swan Index — editorial rules. What an editor may do to a submission, and what follows
// automatically when they do it.
//
// Separated from the admin endpoint so the rules are unit-testable without a request, and so a
// second caller (a bulk import, a scheduled front-page rotation) cannot implement them differently.
//
// ── The one rule worth reading ─────────────────────────────────────────────────────────────────
// `robots` is DERIVED from editorial status. It is not a field an editor sets.
//
// The publication's whole SEO posture — syndicated copies noindex by default, curation is what
// lifts a piece — only holds if lifting cannot be forgotten and dropping cannot be missed. As a
// checkbox beside the status control it would be both: a piece featured without the box ticked
// stays invisible, and a piece un-featured with the box still ticked keeps competing with the
// author's own copy on their own article. Deriving it makes "featured ⇔ indexable" a property of
// the transition rather than a step in a runbook.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { swanIndexPosts } from '../../../db/schema';

type Db = ReturnType<typeof getDb>;

export const CURATION_STATUSES = ['pending', 'live', 'featured', 'rejected', 'withdrawn'] as const;
export type CurationStatus = typeof CURATION_STATUSES[number];

export function isCurationStatus(v: unknown): v is CurationStatus {
    return typeof v === 'string' && (CURATION_STATUSES as readonly string[]).includes(v);
}

/**
 * The crawler directive implied by an editorial status.
 *
 * Only `featured` indexes. A `live` piece sits on its author's profile page for readers who come
 * looking, and points its canonical and its link equity at the author's own site — which is the
 * thing they are actually being sold. Indexing it as well would put our copy into competition with
 * theirs on the strength of a hint (rel=canonical) that search engines are free to ignore.
 */
export function robotsForStatus(status: CurationStatus): string {
    return status === 'featured' ? 'index,follow' : 'noindex,follow';
}

/**
 * Which transitions an EDITOR may make.
 *
 * `withdrawn` is absent from every target list on purpose: it is the author's word, not ours. It is
 * set by unpublishBlogPost when the source post leaves 'published', and an editor pulling a piece
 * back onto the site the author has just retracted would be overriding them on their own byline.
 * Nothing here can leave that state either — republishing does, through the adapter.
 */
const ALLOWED_TRANSITIONS: Record<CurationStatus, CurationStatus[]> = {
    pending:   ['live', 'featured', 'rejected'],
    live:      ['featured', 'rejected', 'pending'],
    featured:  ['live', 'rejected'],
    rejected:  ['pending', 'live'],   // reconsidering is allowed; the audit trail records both
    withdrawn: [],                    // the author's decision — see above
};

export interface TransitionCheck { ok: boolean; error?: string }

export function canTransition(from: CurationStatus, to: CurationStatus): TransitionCheck {
    if (from === to) return { ok: true };
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
        return {
            ok: false,
            error: from === 'withdrawn'
                ? 'This piece was withdrawn by its author. Only they can put it back, by republishing it.'
                : `A ${from} piece cannot be moved straight to ${to}.`,
        };
    }
    return { ok: true };
}

/**
 * Re-sequence featured ranks to a gapless 1..N, preserving current order.
 *
 * Run after EVERY mutation that touches the featured set. featured_rank carries no unique
 * constraint — deliberately, because a swap would violate it halfway through — so nothing at the
 * database level stops two pieces sharing rank 3, and `ORDER BY featured_rank` would then return
 * them in whatever order the planner felt like. The front page would reshuffle itself between two
 * page loads with no data having changed.
 *
 * Ordering is (rank, featuredAt, id): rank first for the intended order, then two deterministic
 * tie-breaks so that even a state that should not exist resolves the same way twice.
 */
export async function resequenceFeatured(db: Db): Promise<number> {
    const rows = await db
        .select({ id: swanIndexPosts.id })
        .from(swanIndexPosts)
        .where(eq(swanIndexPosts.status, 'featured'))
        .orderBy(asc(swanIndexPosts.featuredRank), asc(swanIndexPosts.featuredAt), asc(swanIndexPosts.id));

    for (let i = 0; i < rows.length; i++) {
        await db.update(swanIndexPosts)
            .set({ featuredRank: i + 1, updatedAt: new Date() })
            .where(eq(swanIndexPosts.id, rows[i].id));
    }
    return rows.length;
}

/**
 * The column values a status change implies. Pure, so the transition can be reasoned about — and
 * tested — without a database.
 *
 * `liveAt` is set once and never rewritten: an editor promoting a piece to featured six weeks after
 * it went live must not re-date it to today, or every chronological list on the site reorders
 * itself around an editorial decision that had nothing to do with when it was written.
 */
export function transitionPatch(
    to: CurationStatus,
    current: { liveAt: Date | null; featuredAt: Date | null },
    now = new Date(),
): Record<string, unknown> {
    const patch: Record<string, unknown> = {
        status: to,
        robots: robotsForStatus(to),
        updatedAt: now,
    };

    // Featured ⇔ ranked is a CHECK constraint. Append to the end of the order; resequenceFeatured
    // tidies the numbering immediately afterwards.
    patch.featuredRank = to === 'featured' ? sql`(SELECT COALESCE(MAX(featured_rank), 0) + 1 FROM swan_index_posts)` : null;

    if (to === 'featured' && !current.featuredAt) patch.featuredAt = now;
    if (to !== 'featured' && to !== 'live') patch.featuredAt = null;

    // First time on the site — set the publication date. Never overwritten after that.
    if ((to === 'live' || to === 'featured') && !current.liveAt) patch.liveAt = now;
    // Off the site entirely: the date is meaningless and would resurface if it were kept.
    if (to === 'pending' || to === 'rejected') patch.liveAt = null;

    return patch;
}

/**
 * Move a featured piece one place up or down the front page.
 *
 * Implemented as a swap of two ranks rather than a re-number of the whole list, so two editors
 * working the queue at once cannot silently reorder each other's work beyond the pair they touched.
 * Returns false when the piece is already at the end it is being moved towards.
 */
export async function moveFeatured(db: Db, id: number, direction: 'up' | 'down'): Promise<boolean> {
    await resequenceFeatured(db); // start from a known-good 1..N

    const [target] = await db
        .select({ id: swanIndexPosts.id, rank: swanIndexPosts.featuredRank })
        .from(swanIndexPosts)
        .where(and(eq(swanIndexPosts.id, id), eq(swanIndexPosts.status, 'featured')))
        .limit(1);
    if (!target || target.rank == null) return false;

    const neighbourRank = direction === 'up' ? target.rank - 1 : target.rank + 1;
    if (neighbourRank < 1) return false;

    const [neighbour] = await db
        .select({ id: swanIndexPosts.id })
        .from(swanIndexPosts)
        .where(and(eq(swanIndexPosts.status, 'featured'), eq(swanIndexPosts.featuredRank, neighbourRank)))
        .limit(1);
    if (!neighbour) return false; // already at the top or the bottom

    // Park the target on a rank nothing else can hold before writing the neighbour into its old
    // slot. There is no unique index to violate, but leaving two rows on the same rank between the
    // two updates is exactly the ambiguous state resequenceFeatured exists to clean up — and a
    // concurrent read landing in the gap would see the front page with a duplicate.
    await db.update(swanIndexPosts).set({ featuredRank: 0, updatedAt: new Date() }).where(eq(swanIndexPosts.id, target.id));
    await db.update(swanIndexPosts).set({ featuredRank: target.rank, updatedAt: new Date() }).where(eq(swanIndexPosts.id, neighbour.id));
    await db.update(swanIndexPosts).set({ featuredRank: neighbourRank, updatedAt: new Date() }).where(eq(swanIndexPosts.id, target.id));

    await resequenceFeatured(db);
    return true;
}

/** Editor score, or null. Anything outside 1–5 is rejected rather than clamped — a 9 is a typo. */
export function parseEditorScore(v: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
    if (v === null || v === undefined || v === '') return { ok: true, value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'Editor score must be a whole number from 1 to 5.' };
    return { ok: true, value: n };
}

/** Monthly cap, or null for uncapped. 0 is refused — it reads as "uncapped" and means the opposite. */
export function parseMonthlyCap(v: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
    if (v === null || v === '' || v === undefined) return { ok: true, value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { ok: false, error: 'Monthly cap must be a whole number from 1 to 500, or blank for uncapped.' };
    }
    return { ok: true, value: n };
}

/** Trim an editor note to something a column and a UI can both hold. */
export function normaliseNote(v: unknown, max = 2000): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
}

/**
 * Statuses that put a piece in front of readers. Shared with queries.ts's PUBLIC_STATUSES rather
 * than restated, so a fourth public status cannot be added to one and missed by the other.
 */
export async function countByStatus(db: Db): Promise<Record<string, number>> {
    const rows = await db
        .select({ status: swanIndexPosts.status, n: sql<number>`count(*)::int` })
        .from(swanIndexPosts)
        .groupBy(swanIndexPosts.status);
    const out: Record<string, number> = {};
    for (const s of CURATION_STATUSES) out[s] = 0;
    for (const r of rows) out[r.status] = r.n;
    return out;
}

/** Statuses an editor may see in the queue view. */
export const QUEUE_STATUSES: CurationStatus[] = ['pending', 'live', 'featured', 'rejected'];

export function queueFilter(status: string | null | undefined) {
    return status && isCurationStatus(status)
        ? eq(swanIndexPosts.status, status)
        : inArray(swanIndexPosts.status, QUEUE_STATUSES);
}
