// src/utils/release-post-media.ts
// Hands a departing post's media to the retention pipeline so its bytes are eventually reclaimed.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// archive-cleanup.ts and reject-post.ts each hand-rolled the same "release the media" step, and both
// got it wrong the same way: they soft-deleted `workspace_assets` using `content_assets` ids,
// filtered on `asset_type = 'social_image'`. Two different tables, two independent id sequences.
// Post media therefore never got reclaimed, and both call sites swallowed their own errors.
//
// ⚠️ That was not a harmless no-op. `workspace_assets.asset_type` DOES hold 'social_image' — it is a
// client-supplied kind written verbatim at storage-request-upload.ts:111 and allowed by its
// MIME_ALLOWLIST (the schema's "'file' | 'url' | 'text'" comment is stale). So the statement would
// soft-delete any genuine workspace social_image upload whose id number happened to collide with one
// of the post's content_asset ids — someone else's brand image, deleted because two unrelated
// sequences produced the same integer. It stayed invisible only because collisions are rare.
//
// The rule: an asset id is only meaningful against the table it came from. Never let ids from
// `content_assets` reach a `workspace_assets` query, and never "fix" such a query by adjusting its
// asset_type filter — the filter is not the bug, the table is. tests/post-media-retention.test.ts
// fails if any file mixes the two again.
//
// ── How media actually gets reclaimed ───────────────────────────────────────────────────────────
// content_assets has its own retention machinery, already built and already on a cron:
// content-assets.ts stamps `status='rejected'` + `retentionDeleteAfter`, and content-retention.ts
// (every 6h) deletes the R2 object and marks `purgedAt`. So releasing media is not a delete at all —
// it is setting that retention clock. This helper is the single place that does it for a post.
//
// ── The rule that keeps it safe ─────────────────────────────────────────────────────────────────
// An asset is released only when NO surviving post still references it. That matters most in
// reject-post, whose revised clone is created carrying the SAME contentAssetIds as the post being
// rejected — the clone is a surviving reference, so the media stays, and is released later when the
// clone itself ends. Cross-post siblings work the same way: rejecting one platform's row must not
// pull the picture out from under the other three.
//
// ── Why the collect and release halves are separately exported ───────────────────────────────────
// releasePostMedia() reads a post's assets and releases them in one call, which is right when the
// post is going away and nothing will take its place. set-post-platforms is the other shape: it
// deletes some sibling rows and CREATES others carrying the same media, so a release taken before
// the additions exist would see the shared assets as unreferenced and start a 7-day purge clock on
// media a live post is about to depend on — a worse bug than the leak it was fixing. That caller
// therefore collects the ids first, deletes, adds, and releases last, when the surviving-reference
// check can see the new rows. The ordering is the whole point: collect BEFORE the delete (the
// junction cascades away with the post), release AFTER the adds.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, scheduledPostAssets, scheduledPosts } from '../../db/schema';
import { MEDIA_PENDING_STATUSES } from '../config/post-status';

type Db = ReturnType<typeof getDb>;

/** Matches REJECTED_RETENTION_MS in content-assets.ts — a released asset gets the 7-day window. */
const REJECTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Matches POSTED_RETENTION_MS in content-assets.ts — a published post's media gets 30 days. */
const POSTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Binds each id as its own parameter. Avoids passing a JS array into a raw template. */
function idList(ids: number[]) {
    return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

/** The same, for the status lists — these are text, so they must be bound, never interpolated. */
function textList(values: readonly string[]) {
    return sql.join(values.map(v => sql`${v}`), sql`, `);
}

/**
 * `scheduled_posts.content_asset_ids` expanded to a set of ints, safely.
 *
 * The CASE has to live INSIDE the jsonb_array_elements_text() call, not in a WHERE clause. This is
 * a set-returning function in the FROM list: it runs before WHERE can filter anything, so a single
 * row holding a non-array value (an object, a bare scalar, a JSON `null`) aborts the WHOLE query
 * rather than being skipped. A `WHERE content_asset_ids <> '[]'` guard reads like protection and
 * provides none.
 */
const assetIdsLateral = sql`
    CROSS JOIN LATERAL (
        SELECT (jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(sp.content_asset_ids) = 'array'
                 THEN sp.content_asset_ids ELSE '[]'::jsonb END
        ))::int AS id
    ) x
`;

/**
 * Every content_assets id that `postIds` reference, from both the junction table and the deprecated
 * array column.
 *
 * MUST be called BEFORE the posts are deleted: `scheduled_post_assets` cascades on post delete, so
 * once the rows are gone there is no way left to discover which assets they held.
 */
export async function collectPostAssetIds(db: Db, postIds: number[]): Promise<number[]> {
    if (postIds.length === 0) return [];

    // ── Candidates: every asset these posts reference ───────────────────────────────────────────
    // Both sources are read. scheduled_post_assets is the source of truth, but the deprecated
    // scheduled_posts.content_asset_ids column is still written by attachAssetToPost and still holds
    // rows that predate the junction backfill, so ignoring it would leak exactly the oldest assets.
    const junction = await db
        .select({ assetId: scheduledPostAssets.contentAssetId })
        .from(scheduledPostAssets)
        .where(inArray(scheduledPostAssets.scheduledPostId, postIds));

    const legacy = await db
        .select({ ids: scheduledPosts.contentAssetIds })
        .from(scheduledPosts)
        .where(inArray(scheduledPosts.id, postIds));

    const candidates = new Set<number>(junction.map(r => r.assetId));
    for (const row of legacy) {
        if (Array.isArray(row.ids)) {
            for (const id of row.ids as unknown[]) {
                if (Number.isInteger(id)) candidates.add(id as number);
            }
        }
    }
    return [...candidates];
}

/**
 * Starts the retention clock on `assetIds`, skipping anything a post still references.
 *
 * @param excludePostIds posts whose references don't count as "still used" — the ones going away.
 *        Pass them when the release runs BEFORE the delete; leave empty when it runs after, since
 *        the rows (and their cascaded junction entries) are gone by then.
 * @returns how many content_assets rows had their retention clock started.
 */
export async function releaseAssets(db: Db, assetIds: number[], excludePostIds: number[] = []): Promise<number> {
    if (assetIds.length === 0) return 0;

    // ── Exclude anything a surviving post still references ──────────────────────────────────────
    const candidateIds = [...new Set(assetIds)];
    const stillUsed = new Set<number>();

    // An empty exclusion list must not become `NOT IN ()` — that is a syntax error, not a no-op.
    const notExcluded = excludePostIds.length
        ? sql`AND sp.id NOT IN (${idList(excludePostIds)})`
        : sql``;

    const otherJunction = await db
        .select({ assetId: scheduledPostAssets.contentAssetId })
        .from(scheduledPostAssets)
        .where(and(
            inArray(scheduledPostAssets.contentAssetId, candidateIds),
            excludePostIds.length
                ? sql`${scheduledPostAssets.scheduledPostId} NOT IN (${idList(excludePostIds)})`
                : undefined,
        ));
    for (const r of otherJunction) stillUsed.add(r.assetId);

    // Same check against the legacy column. Expanded in SQL and bounded by the candidate list so
    // this stays an indexed lookup rather than a scan of every post's JSONB.
    const otherLegacy = await db.execute<{ id: number }>(sql`
        SELECT DISTINCT x.id
        FROM scheduled_posts sp
        ${assetIdsLateral}
        WHERE TRUE
          ${notExcluded}
          AND x.id IN (${idList(candidateIds)})
    `);
    for (const r of otherLegacy) stillUsed.add(r.id);

    const releasable = candidateIds.filter(id => !stillUsed.has(id));
    if (releasable.length === 0) return 0;

    // ── Start the retention clock ───────────────────────────────────────────────────────────────
    // purgedAt IS NULL skips assets whose bytes are already gone. retentionDeleteAfter IS NULL keeps
    // an existing (possibly sooner) window intact rather than pushing it back by 7 more days.
    const now = new Date();
    const released = await db.update(contentAssets)
        .set({
            status: 'rejected',
            rejectedAt: now,
            retentionDeleteAfter: new Date(now.getTime() + REJECTED_RETENTION_MS),
            updatedAt: now,
        })
        .where(and(
            inArray(contentAssets.id, releasable),
            isNull(contentAssets.purgedAt),
            isNull(contentAssets.retentionDeleteAfter),
        ))
        .returning({ id: contentAssets.id });

    return released.length;
}

/**
 * Marks the media of `postIds` for retention, skipping anything another post still uses.
 *
 * MUST be called BEFORE the posts are deleted — see collectPostAssetIds. Callers that replace the
 * deleted posts with new rows carrying the same media must NOT use this; they collect first and call
 * releaseAssets once the replacements exist (see the header).
 *
 * @returns how many content_assets rows had their retention clock started.
 */
export async function releasePostMedia(db: Db, postIds: number[]): Promise<number> {
    const assetIds = await collectPostAssetIds(db, postIds);
    return releaseAssets(db, assetIds, postIds);
}

/**
 * Starts the 30-day POSTED retention clock on the media of posts that have just gone live.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────────────────────────
 * content-retention.ts selects purely on `retentionDeleteAfter <= now AND purgedAt IS NULL`. It has
 * no status filter, so its documented "purges POSTED assets on a 30-day window" half was never
 * gated by the status column — it simply had nothing to select, because NOTHING EVER SET
 * retentionDeleteAfter for a published post's media.
 *
 * The transition did exist on paper: scheduled-posts.ts calls propagateAssetStatuses(...,
 * 'scheduled', 'posted') when a PATCH moves a post to 'published'. It cannot fire for a real
 * publish, for three independent reasons:
 *
 *   1. Nothing publishes through that endpoint. Every actual publisher writes the row itself —
 *      publish-social-posts.ts, publish-instagram.ts and publish-facebook.ts with a raw
 *      `UPDATE scheduled_posts SET status = 'published'`, publish-youtube-background.ts with its
 *      own db.update. None of them goes near an asset.
 *   2. It reads only the deprecated `contentAssetIds` array, so media attached through the
 *      `scheduled_post_assets` junction — the source of truth — is invisible to it.
 *   3. It requires the asset to be sitting on exactly 'scheduled' (`eq(status, fromStatus)`), and
 *      the step that was supposed to put it there has the same two problems. edit-brand-card.ts
 *      inserts 'scheduled' directly; everything else stays 'pending' for ever.
 *
 * So the reclaimer only ever saw REJECTED assets, on their 7-day clock. Every image, video and
 * audio file that successfully published stayed in R2 for good.
 *
 * ── Why this deliberately ignores the asset's current status ────────────────────────────────────
 * No `fromStatus` gate. Reason 3 above is what a status-chain fix looks like when it rots: each
 * hop is a hand-maintained denormalisation, and one missed transition anywhere strands the asset
 * for ever. The truth is the posts, which is exactly why the READ side already derives the badge
 * from live rows instead of trusting the column (deriveAssetStatus in content-assets.ts). This is
 * that same rule on the write side, so the two agree by construction.
 *
 * ── The rule that keeps it safe ─────────────────────────────────────────────────────────────────
 * An asset's clock starts only when NO post still needs its bytes (mediaStillNeeded). Cross-post
 * siblings share one asset and publish minutes apart, so Instagram going out at 09:00 must not
 * start a purge timer on the picture LinkedIn publishes at 10:00. Same shape as releaseAssets, but
 * it cannot reuse that exclusion: this one has to consider posts by STATUS rather than by a
 * caller-supplied exclusion list, because the posts in question are all still very much alive.
 *
 * Callers pass the post that just published; the siblings are found from the assets, not the
 * caller. Idempotent — `retentionDeleteAfter IS NULL` means a second call is a no-op, and it never
 * overwrites a shorter window a rejection already set.
 *
 * @returns how many content_assets rows had their 30-day clock started.
 */
export async function markPostMediaPosted(db: Db, postIds: number[]): Promise<number> {
    if (postIds.length === 0) return 0;

    const candidateIds = await collectPostAssetIds(db, postIds);
    if (candidateIds.length === 0) return 0;

    const statuses = textList(MEDIA_PENDING_STATUSES);
    const stillNeeded = new Set<number>();

    // Junction table — the source of truth for which post holds which asset.
    const viaJunction = await db.execute<{ id: number }>(sql`
        SELECT DISTINCT spa.content_asset_id AS id
        FROM scheduled_post_assets spa
        JOIN scheduled_posts sp ON sp.id = spa.scheduled_post_id
        WHERE spa.content_asset_id IN (${idList(candidateIds)})
          AND sp.status IN (${statuses})
    `);
    for (const r of viaJunction) stillNeeded.add(r.id);

    // …and the deprecated array, which still carries the oldest rows and is what resolvePostImage
    // actually reads at publish time. Skipping it would purge media a publisher is about to want.
    const viaLegacy = await db.execute<{ id: number }>(sql`
        SELECT DISTINCT x.id
        FROM scheduled_posts sp
        ${assetIdsLateral}
        WHERE sp.status IN (${statuses})
          AND x.id IN (${idList(candidateIds)})
    `);
    for (const r of viaLegacy) stillNeeded.add(r.id);

    const reclaimable = candidateIds.filter(id => !stillNeeded.has(id));
    if (reclaimable.length === 0) return 0;

    const now = new Date();
    const marked = await db.update(contentAssets)
        .set({
            status: 'posted',
            postedAt: now,
            retentionDeleteAfter: new Date(now.getTime() + POSTED_RETENTION_MS),
            updatedAt: now,
        })
        .where(and(
            inArray(contentAssets.id, reclaimable),
            isNull(contentAssets.purgedAt),
            // Never push an existing window back. A rejection's 7-day clock is SHORTER and must
            // win; re-running this on an already-marked asset must not buy it another 30 days.
            isNull(contentAssets.retentionDeleteAfter),
        ))
        .returning({ id: contentAssets.id });

    return marked.length;
}
