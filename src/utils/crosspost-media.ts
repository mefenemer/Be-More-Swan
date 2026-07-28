// src/utils/crosspost-media.ts
// Which posts a media change should be written to.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// A cross-post is one scheduled_posts row PER PLATFORM sharing a crosspost_group_id, and the review
// editor collapses those rows into a single card with a platform tab strip. To the person using it,
// that is ONE post that happens to go to four places — so "add this picture" means add it to the
// post, not to whichever tab happened to be in front at the time.
//
// Every media endpoint used to write only the row whose id the client sent, which is the id of the
// selected tab. The picture landed on Instagram and the other three platforms published without it,
// and nothing on screen said so: the tabs the user had not clicked still showed their old media.
//
// So media writes fan out across the group by DEFAULT, and a caller that genuinely means "this one
// platform only" opts out with applyToGroup:false.
//
// ── The two rules that bound the fan-out ────────────────────────────────────────────────────────
// 1. Same status. The editor's tab strip groups siblings by crosspost_group_id AND status (see
//    _rqGroupKey in workspace.html and the paging key in get-social-drafts.ts). A sibling in a
//    different status is a different card the user is not looking at, so writing to it would be an
//    edit they never asked for and cannot see.
// 2. Media-editable statuses only. A published sibling's media is a matter of record. isMediaEditable
//    is the single source of that rule.
//
// Both rules are enforced here rather than at each call site, because "which rows does this touch"
// is exactly the question four separate endpoints kept answering differently.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { isMediaEditable, MEDIA_EDITABLE_STATUSES } from '../config/post-status';

type Db = ReturnType<typeof getDb>;

/**
 * The post ids a media write should apply to, target first.
 *
 * Returns just [postId] when the post has no cross-post siblings, when the caller opted out, or when
 * the post's own status puts its media beyond editing — never an empty array, so a caller can always
 * write the row it was asked about and let its own status checks decide the rest.
 */
export async function mediaTargetPostIds(
    db: Db,
    args: { postId: number; orgId: number; applyToGroup?: boolean },
): Promise<number[]> {
    const { postId, orgId, applyToGroup = true } = args;
    if (!applyToGroup) return [postId];

    const [post] = await db
        .select({
            id: scheduledPosts.id,
            crosspostGroupId: scheduledPosts.crosspostGroupId,
            status: scheduledPosts.status,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);

    // No such post (the caller's own 404 will fire), no group, or a post whose media is settled.
    if (!post || !post.crosspostGroupId || !isMediaEditable(post.status)) return [postId];

    const siblings = await db
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.organisationId, orgId),
            eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId),
            eq(scheduledPosts.status, post.status),
            inArray(scheduledPosts.status, [...MEDIA_EDITABLE_STATUSES]),
        ));

    // Target first: callers presign a thumbnail from the row the user is actually looking at, and a
    // set() that reads back the "first" row must read back that one.
    const ids = siblings.map(r => r.id).filter(id => id !== postId);
    return [postId, ...ids];
}
