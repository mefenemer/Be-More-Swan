// src/utils/post-slides.ts
// Write a post's slides — the ordered media list — in the one way every caller must: the junction
// table (scheduled_post_assets, read by newer queries) AND the legacy contentAssetIds array (read by
// every publisher), together. Writing one without the other publishes something different from what
// the editor shows.
//
// Used by set-post-slides.ts (the editor's add / remove / reorder) and make-carousel.ts (a list post
// turned into brand-card slides). Callers check ownership, status and asset validity first.

import { inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * Make `assetIds`, in this order, the slides of every post in `postIds`. `extra` is merged into the
 * same scheduled_posts update (make-carousel sets the carousel format here, so slides and format
 * never disagree even for a moment).
 */
export async function writePostSlides(
    db: Db,
    postIds: readonly number[],
    assetIds: readonly number[],
    extra: Partial<typeof scheduledPosts.$inferInsert> = {},
): Promise<void> {
    if (!postIds.length) return;
    const ids = [...postIds];
    await db.delete(scheduledPostAssets).where(inArray(scheduledPostAssets.scheduledPostId, ids));
    if (assetIds.length) {
        await db.insert(scheduledPostAssets)
            .values(ids.flatMap(id => assetIds.map((contentAssetId, position) => ({ scheduledPostId: id, contentAssetId, position }))))
            .onConflictDoNothing();
    }
    await db.update(scheduledPosts)
        .set({
            ...extra,
            contentAssetIds: [...assetIds],
            // Re-attaching media clears the "this post's media was deleted" flag, same as
            // attach-draft-media does.
            ...(assetIds.length ? { mediaMissing: false, mediaMissingNote: null } : {}),
            updatedAt: new Date(),
        })
        .where(inArray(scheduledPosts.id, ids));
}
