// src/utils/swan-index/withdraw.ts
// Take one piece off The Swan Index when its source post stops being published.
//
// Its own module purely to keep the import out of blog-publish.ts's static graph — that file is
// already the hub the publish path routes through, and swan-index/* reaches back into it via the
// adapter. A lazy import of a leaf module is the cheapest way to keep the cycle from forming.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { swanIndexPosts } from '../../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * Mark this post's magazine copy withdrawn. Returns true when a row actually changed.
 *
 * `featuredRank` is cleared alongside the status because the two are bound by a CHECK constraint —
 * a featured row with no rank, or a ranked row that is not featured, is rejected by the database.
 * Clearing it also frees the front-page slot rather than leaving a hole where the article was.
 */
export async function withdrawFromSwanIndex(db: Db, organisationId: number, blogPostId: number): Promise<boolean> {
    const rows = await db
        .update(swanIndexPosts)
        .set({ status: 'withdrawn', featuredRank: null, updatedAt: new Date() })
        .where(and(
            eq(swanIndexPosts.blogPostId, blogPostId),
            eq(swanIndexPosts.organisationId, organisationId),
            inArray(swanIndexPosts.status, ['pending', 'live', 'featured']),
        ))
        .returning({ id: swanIndexPosts.id });
    return rows.length > 0;
}
