// src/utils/brief-post-media.ts
// A social draft that found no picture, and the Brand Designer brief raised for it. Brand Designer
// plan, Phase 5 (docs/brand-designer-plan.md §6 step 5).
//
// When the user approves an option on that brief, the picture goes onto the post — but only if the
// post still NEEDS one:
//   • its media must still be editable (a draft or pending approval — isMediaEditable), and
//   • it must still have no media. If the user added a picture in the meantime, theirs wins and the
//     approved one simply stays in the library. Replacing a picture someone chose is never right.
// Cross-post siblings get it too (mediaTargetPostIds), each only if it has no media of its own.
//
// ⚠️ Imports nothing from visual-briefs.ts, which imports THIS module.

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { scheduledPostAssets, scheduledPosts } from '../../db/schema';
import { MEDIA_EDITABLE_STATUSES, isMediaEditable } from '../config/post-status';
import { mediaTargetPostIds } from './crosspost-media';

type Db = ReturnType<typeof getDb>;

export type PostAttachOutcome = 'attached' | 'post_has_media' | 'not_editable' | 'post_gone';

/** One sentence for each outcome, for the tab and the chat card. */
export const POST_ATTACH_NOTES: Record<PostAttachOutcome, string> = {
    attached: 'It is now on the post it was for — still waiting for your approval there.',
    post_has_media: 'The post already has a picture, so that one was kept — this one is in your library.',
    not_editable: 'The post it was for is already scheduled or published, so it was left alone — this one is in your library.',
    post_gone: 'The post it was for no longer exists — this picture is in your library.',
};

async function hasMedia(db: Db, postId: number): Promise<boolean> {
    const [j] = await db.select({ n: sql<number>`count(*)::int` }).from(scheduledPostAssets)
        .where(eq(scheduledPostAssets.scheduledPostId, postId));
    if (Number(j?.n ?? 0) > 0) return true;
    const [p] = await db.select({ ids: scheduledPosts.contentAssetIds }).from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    return Array.isArray(p?.ids) && (p!.ids as unknown[]).length > 0;
}

/**
 * Put an approved picture onto the post its brief was raised for, and its cross-post siblings —
 * each only while it has no media and its media can still change. Never throws: the approval is
 * already saved, and a failed attach leaves the picture in the library, which is honest.
 */
export async function attachApprovedToPost(db: Db, args: { orgId: number; postId: number; assetId: number }): Promise<PostAttachOutcome> {
    try {
        const [post] = await db.select({ id: scheduledPosts.id, status: scheduledPosts.status }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
        if (!post) return 'post_gone';
        if (!isMediaEditable(post.status)) return 'not_editable';
        if (await hasMedia(db, post.id)) return 'post_has_media';

        const targets = await mediaTargetPostIds(db, { postId: post.id, orgId: args.orgId });
        let attached = 0;
        for (const id of targets) {
            if (id !== post.id && await hasMedia(db, id)) continue;   // a sibling's own picture wins too
            await db.insert(scheduledPostAssets).values({ scheduledPostId: id, contentAssetId: args.assetId, position: 0 }).onConflictDoNothing();
            // The deprecated array is still read (resolvePostImage) — kept in step, as attachAssetToPost does.
            await db.update(scheduledPosts).set({ contentAssetIds: [args.assetId], updatedAt: new Date() })
                .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, args.orgId)));
            attached++;
        }
        return attached ? 'attached' : 'post_has_media';
    } catch (err) {
        console.error('[brief-post-media] attach failed — the picture stays in the library:', args, err instanceof Error ? err.message : err);
        return 'post_has_media';
    }
}

/**
 * A campaign's chosen picture → one of the campaign's posts still awaiting review (owner,
 * 2026-10-14: a brief for 10 posts gives 10 pictures, and each goes on one of the posts).
 *
 * Only a post that still carries EXACTLY the picture its drafter found (auto_media_asset_id) is
 * eligible, so a picture the user chose — or changed, or added beside it — is never replaced; and
 * only one that has no campaign picture yet, so two chosen pictures never land on the same post.
 * Oldest publish date first. The whole cross-post group takes it, sibling by sibling, under the
 * same rule. Returns whether a post took it; never throws (the approval is already saved, and an
 * unplaced picture still waits in the campaign's pictures for the next post drafted).
 */
export async function placeOnCampaignPost(db: Db, args: { orgId: number; campaignId: number; assetId: number }): Promise<boolean> {
    try {
        const candidates = await db.select({ id: scheduledPosts.id, status: scheduledPosts.status, auto: scheduledPosts.autoMediaAssetId })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, args.orgId),
                inArray(scheduledPosts.status, [...MEDIA_EDITABLE_STATUSES]),
                isNotNull(scheduledPosts.autoMediaAssetId),
                sql`EXISTS (SELECT 1 FROM content_generation_jobs j JOIN campaign_orders o ON o.id = j.campaign_order_id
                             WHERE j.job_id = ${scheduledPosts.jobId} AND o.campaign_id = ${args.campaignId}
                               AND o.action IN ('draft_social_posts', 'ab_test_posts'))`,
                sql`NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa JOIN campaign_assets ca ON ca.content_asset_id = spa.content_asset_id
                                 WHERE spa.scheduled_post_id = ${scheduledPosts.id} AND ca.campaign_id = ${args.campaignId}
                                   AND spa.content_asset_id <> ${args.assetId})`,
            ))
            .orderBy(asc(scheduledPosts.publishDate), asc(scheduledPosts.id))
            .limit(50);
        for (const c of candidates) {
            if (!(await carriesOnlyItsOwnPick(db, c.id, c.auto))) continue;
            const targets = await mediaTargetPostIds(db, { postId: c.id, orgId: args.orgId });
            let placed = 0;
            for (const id of targets) {
                const [t] = await db.select({ status: scheduledPosts.status, auto: scheduledPosts.autoMediaAssetId })
                    .from(scheduledPosts).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
                if (!t || !isMediaEditable(t.status) || !(await carriesOnlyItsOwnPick(db, id, t.auto))) continue;
                await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, id));
                await db.insert(scheduledPostAssets).values({ scheduledPostId: id, contentAssetId: args.assetId, position: 0 }).onConflictDoNothing();
                // The deprecated array is still read (resolvePostImage) — kept in step. The marker moves
                // with the picture: it is still not one the USER chose, and a later campaign pick must
                // not land here again (the campaign-picture check above keeps it out).
                await db.update(scheduledPosts).set({ contentAssetIds: [args.assetId], autoMediaAssetId: args.assetId, updatedAt: new Date() })
                    .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, args.orgId)));
                placed++;
            }
            if (placed) return true;
        }
        return false;
    } catch (err) {
        console.error('[brief-post-media] campaign placement failed — the picture stays with the campaign:', args, err instanceof Error ? err.message : err);
        return false;
    }
}

/** True when the post's media is exactly the one picture its drafter attached — nothing the user did. */
async function carriesOnlyItsOwnPick(db: Db, postId: number, auto: number | null): Promise<boolean> {
    if (!auto) return false;
    const rows = await db.select({ id: scheduledPostAssets.contentAssetId }).from(scheduledPostAssets)
        .where(eq(scheduledPostAssets.scheduledPostId, postId));
    return rows.length === 1 && rows[0].id === auto;
}
