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

type Db = ReturnType<typeof getDb>;

/** Matches REJECTED_RETENTION_MS in content-assets.ts — a released asset gets the 7-day window. */
const REJECTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Binds each id as its own parameter. Avoids passing a JS array into a raw template. */
function idList(ids: number[]) {
    return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

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
        CROSS JOIN LATERAL (
            SELECT (jsonb_array_elements_text(sp.content_asset_ids))::int AS id
        ) x
        WHERE sp.content_asset_ids IS NOT NULL
          AND sp.content_asset_ids <> '[]'::jsonb
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
