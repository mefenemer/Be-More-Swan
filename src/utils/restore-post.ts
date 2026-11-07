// src/utils/restore-post.ts
// "Bring back": a post that was removed (cancelled) or rejected goes back to "Review".
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Removing and rejecting both move a post to the Archived column, and nothing in the product could
// move it out again: the post editor showed an archived post read-only, the chat refused, and a
// user who pressed Remove by mistake had lost the post (reported 2026-11-07: "I can't uncancel a
// cancelled post").
//
// ── What it does ─────────────────────────────────────────────────────────────────────────────────
// The post — and every sibling row of its cross-post that was also removed or rejected — goes to
// 'pending_approval', the Review column. Never straight back to Scheduled: the user approves it
// again, and approve-post re-checks everything (connections, compliance warnings, a time that has
// passed) exactly as for any draft. A sibling that was published, or is still live, is left alone.
//
// Rejecting also started the 7-day deletion clock on the post's media (releasePostMedia, called by
// reject-post). That clock is stopped here for every asset whose bytes still exist. If the bytes are
// already gone, the post comes back flagged media_missing, which approve-post and the editor already
// explain ("needs a replacement before it can go out").
//
// Not undone: a Content Rule the user chose to keep when rejecting, and the replacement draft that
// rejecting wrote. Both are separate things the user can see and remove themselves.
//
// The post editor's "Bring back" (restore-post.ts) and the chat's `restore` card call this.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, contentAssets, scheduledPosts } from '../../db/schema';
import { collectPostAssetIds } from './release-post-media';

type Db = ReturnType<typeof getDb>;

/** The statuses "Bring back" applies to: the two that put a post in the Archived column. */
export const RESTORABLE_STATUSES = ['rejected', 'cancelled'] as const;
const RESTORABLE = new Set<string>(RESTORABLE_STATUSES);

/** Where a restored post goes: the Review column, to be approved again. */
export const RESTORED_STATUS = 'pending_approval';

export type RestoreResult =
    | { ok: true; restoredIds: number[]; mediaGone: boolean }
    | { ok: false; status: number; error: string };

export async function restorePosts(
    db: Db,
    opts: { postId: number; organisationId: number | null | undefined; userId: number },
): Promise<RestoreResult> {
    const [post] = await db.select({
        id: scheduledPosts.id, status: scheduledPosts.status, organisationId: scheduledPosts.organisationId,
        userId: scheduledPosts.userId, assistantId: scheduledPosts.assistantId, crosspostGroupId: scheduledPosts.crosspostGroupId,
    }).from(scheduledPosts).where(eq(scheduledPosts.id, opts.postId)).limit(1);

    // Same ownership rule as reject-post: this workspace's post, or this user's own.
    const mine = post && ((opts.organisationId != null && post.organisationId === opts.organisationId) || post.userId === opts.userId);
    if (!post || !mine) return { ok: false, status: 404, error: 'Post not found.' };
    if (!RESTORABLE.has(post.status)) {
        return { ok: false, status: 409, error: 'Only a post that was removed or rejected can be brought back.' };
    }

    // An archived assistant's drafts are listed nowhere (archived-assistant-drafts.ts), so a post
    // brought back for one would vanish again. Say so instead.
    if (post.assistantId != null) {
        const [a] = await db.select({ lifecycleStatus: aiAssistants.lifecycleStatus })
            .from(aiAssistants).where(eq(aiAssistants.id, post.assistantId)).limit(1);
        if (a?.lifecycleStatus === 'archived') {
            return { ok: false, status: 409, error: 'The assistant that wrote this post is archived. Bring the assistant back first, then the post.' };
        }
    }

    // The whole cross-post, as reject-post and Remove act on it — but only its archived rows.
    const siblings = post.crosspostGroupId && post.organisationId != null
        ? await db.select({ id: scheduledPosts.id, status: scheduledPosts.status })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId), eq(scheduledPosts.organisationId, post.organisationId)))
        : [{ id: post.id, status: post.status }];
    const ids = siblings.filter((s) => RESTORABLE.has(s.status)).map((s) => s.id);
    if (!ids.includes(post.id)) ids.push(post.id);

    const now = new Date();
    const restored = await db.update(scheduledPosts)
        .set({ status: RESTORED_STATUS, rejectedAt: null, rejectionReason: null, cancelledAt: null, updatedAt: now })
        // Re-checked in the write, so a row that changed since the read above is not touched.
        .where(and(inArray(scheduledPosts.id, ids), inArray(scheduledPosts.status, [...RESTORABLE_STATUSES])))
        .returning({ id: scheduledPosts.id });
    const restoredIds = restored.map((r) => r.id);
    if (!restoredIds.length) return { ok: false, status: 409, error: 'This post has changed since you opened it. Reload and try again.' };

    // ── Stop the media deletion clock that rejecting started ─────────────────────────────────────
    // Only assets releaseAssets released: status 'rejected' with a retention date and no
    // rejection_reason (a moderation reject carries one, and must stay rejected).
    let mediaGone = false;
    const assetIds = await collectPostAssetIds(db, restoredIds);
    if (assetIds.length) {
        await db.update(contentAssets)
            .set({ status: 'pending', rejectedAt: null, retentionDeleteAfter: null, updatedAt: now })
            .where(and(
                inArray(contentAssets.id, assetIds),
                eq(contentAssets.status, 'rejected'),
                isNull(contentAssets.rejectionReason),
                isNull(contentAssets.purgedAt),
            ));
        const purged = await db.select({ id: contentAssets.id }).from(contentAssets)
            .where(and(inArray(contentAssets.id, assetIds), isNotNull(contentAssets.purgedAt)));
        if (purged.length) {
            mediaGone = true;
            await db.update(scheduledPosts)
                .set({ mediaMissing: true, mediaMissingNote: 'It was deleted while the post was archived.' })
                .where(inArray(scheduledPosts.id, restoredIds));
        }
    }

    return { ok: true, restoredIds, mediaGone };
}
