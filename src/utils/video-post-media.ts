// src/utils/video-post-media.ts
//
// A finished Video Producer video that was made FOR a post goes back to it
// (docs/video-producer-studio-plan.md Phase 5, owner decision D-S4). Two ways a video is made for a post:
//
//   • "Make a video version" on a post (video_projects.source_post_id) → attachVideoToSourcePost
//   • a Campaign Assistant order (video_projects.campaign_id)         → placeVideoOnCampaignPost
//
// Rules, as for an approved Brand Designer picture (brief-post-media.ts), plus what only a video needs:
//   • the post must still be a draft or awaiting approval (isMediaEditable) — never a scheduled or
//     published post;
//   • its platform must take video in a LIVE format; the post's format moves to that video format
//     (the one that accepts the video's shape, else any live video format);
//   • a post with text placed on its picture (image_overlays) is never given the video: that text was
//     designed for the picture, and approval would burn it onto the video.
// "Make a video version" where the post itself can't take it → a NEW draft beside it, same assistant,
// caption and platform (or Instagram when the platform takes no video), so nothing the owner made is
// replaced. Never throws: the video is safe in My Content whatever happens here.

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { scheduledPostAssets, scheduledPosts } from '../../db/schema';
import { MEDIA_EDITABLE_STATUSES, isMediaEditable } from '../config/post-status';
import { formatsForPlatform, type PostFormatSpec } from '../config/post-formats';
import { mediaTargetPostIds } from './crosspost-media';

type Db = ReturnType<typeof getDb>;

/** The live video format a platform takes for this shape, else any live video format, else null. Pure. */
export function videoFormatFor(platform: string, shape: string): PostFormatSpec | null {
    const live = formatsForPlatform(platform).filter((f) => f.availability === 'live' && (f.media === 'video' || f.media === 'mixed'));
    const fits = (f: PostFormatSpec) => !f.aspectRatios.length || f.aspectRatios.includes(shape);
    return live.find((f) => f.media === 'video' && fits(f)) ?? live.find(fits) ?? live.find((f) => f.media === 'video') ?? null;
}

const hasOverlays = (raw: unknown) => Array.isArray(raw) && raw.some((o) => o && typeof o === 'object' && String((o as { text?: unknown }).text ?? '').trim());

/** Put the video on one post row: media, the deprecated array, and the video format. */
async function putVideoOn(db: Db, orgId: number, postId: number, assetId: number, formatKey: string, extra: Partial<typeof scheduledPosts.$inferInsert> = {}) {
    await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, postId));
    await db.insert(scheduledPostAssets).values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 }).onConflictDoNothing();
    await db.update(scheduledPosts).set({
        contentAssetIds: [assetId], formatKey, postFormat: 'video', mediaMissing: false, mediaMissingNote: null, updatedAt: new Date(), ...extra,
    } as Partial<typeof scheduledPosts.$inferInsert>).where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)));
}

export type SourcePostOutcome = 'attached' | 'new_draft' | 'post_gone' | 'failed';

/**
 * One sentence per outcome, for the Videos tab (the project's note) and the chat. Kept short and
 * about the video only (owner, 2026-11-10): what happens to the post is the Social Media Assistant's
 * to describe, in its own Review Queue and help article.
 */
export const SOURCE_POST_NOTES: Record<SourcePostOutcome, string> = {
    attached: 'Sent back to the post that asked for it. It’s also in My Content.',
    new_draft: 'Sent back to the post that asked for it, as a new draft beside it. It’s also in My Content.',
    post_gone: 'The post that asked for it no longer exists, so it’s only in My Content.',
    failed: 'It couldn’t be sent back to the post that asked for it, so it’s only in My Content.',
};

export async function attachVideoToSourcePost(db: Db, args: { orgId: number; userId: number; postId: number; assetId: number; shape: string }): Promise<SourcePostOutcome> {
    try {
        const [post] = await db.select({
            id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform, assistantId: scheduledPosts.assistantId,
            caption: scheduledPosts.caption, hashtags: scheduledPosts.hashtags, imageOverlays: scheduledPosts.imageOverlays,
        }).from(scheduledPosts).where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
        if (!post) return 'post_gone';

        const fmt = videoFormatFor(post.platform, args.shape);
        if (isMediaEditable(post.status) && fmt && !hasOverlays(post.imageOverlays)) {
            // The whole cross-post group, sibling by sibling, each in its own platform's video format.
            const targets = await mediaTargetPostIds(db, { postId: post.id, orgId: args.orgId });
            let attached = 0;
            for (const id of targets) {
                const [t] = await db.select({ status: scheduledPosts.status, platform: scheduledPosts.platform, imageOverlays: scheduledPosts.imageOverlays })
                    .from(scheduledPosts).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
                const tf = t ? videoFormatFor(t.platform, args.shape) : null;
                if (!t || !tf || !isMediaEditable(t.status) || hasOverlays(t.imageOverlays)) continue;
                await putVideoOn(db, args.orgId, id, args.assetId, tf.key);
                attached++;
            }
            if (attached) return 'attached';
        }

        // A new draft beside it: same assistant and words; its platform if that takes video, else Instagram.
        const platform = fmt ? post.platform : 'instagram';
        const f = fmt ?? videoFormatFor('instagram', args.shape);
        if (!f) return 'failed';
        const [draft] = await db.insert(scheduledPosts).values({
            userId: args.userId, organisationId: args.orgId, assistantId: post.assistantId,
            platform, postFormat: 'video', formatKey: f.key,
            publishDate: new Date(Date.now() + 24 * 3600 * 1000),
            caption: post.caption ?? '', hashtags: post.hashtags, contentAssetIds: [args.assetId],
            status: 'pending_approval', triggerType: 'manual', isAutonomous: false,
            ownerId: args.userId, ownerLabel: 'Video Producer', generatedAt: new Date(),
        } as typeof scheduledPosts.$inferInsert).returning({ id: scheduledPosts.id });
        await db.insert(scheduledPostAssets).values({ scheduledPostId: draft.id, contentAssetId: args.assetId, position: 0 }).onConflictDoNothing();
        return 'new_draft';
    } catch (err) {
        console.error('[video-post-media] could not put the video on its post — it stays in My Content:', args, err instanceof Error ? err.message : err);
        return 'failed';
    }
}

/**
 * A campaign's video → one of the campaign's social drafts still awaiting review, exactly as a
 * campaign picture is placed (brief-post-media.ts placeOnCampaignPost): only a post that still
 * carries only the picture its drafter found (auto_media_asset_id), on a platform that takes video,
 * with no text placed on that picture. Oldest publish date first. Returns whether a post took it.
 */
export async function placeVideoOnCampaignPost(db: Db, args: { orgId: number; campaignId: number; assetId: number; shape: string }): Promise<boolean> {
    try {
        const candidates = await db.select({ id: scheduledPosts.id, platform: scheduledPosts.platform, auto: scheduledPosts.autoMediaAssetId, imageOverlays: scheduledPosts.imageOverlays })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, args.orgId),
                inArray(scheduledPosts.status, [...MEDIA_EDITABLE_STATUSES]),
                isNotNull(scheduledPosts.autoMediaAssetId),
                sql`EXISTS (SELECT 1 FROM content_generation_jobs j JOIN campaign_orders o ON o.id = j.campaign_order_id
                             WHERE j.job_id = ${scheduledPosts.jobId} AND o.campaign_id = ${args.campaignId}
                               AND o.action IN ('draft_social_posts', 'ab_test_posts'))`,
            ))
            .orderBy(asc(scheduledPosts.publishDate), asc(scheduledPosts.id))
            .limit(50);
        for (const c of candidates) {
            const fmt = videoFormatFor(c.platform, args.shape);
            if (!fmt || hasOverlays(c.imageOverlays) || !(await carriesOnlyItsOwnPick(db, c.id, c.auto))) continue;
            const targets = await mediaTargetPostIds(db, { postId: c.id, orgId: args.orgId });
            let placed = 0;
            for (const id of targets) {
                const [t] = await db.select({ status: scheduledPosts.status, platform: scheduledPosts.platform, auto: scheduledPosts.autoMediaAssetId, imageOverlays: scheduledPosts.imageOverlays })
                    .from(scheduledPosts).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, args.orgId))).limit(1);
                const tf = t ? videoFormatFor(t.platform, args.shape) : null;
                if (!t || !tf || !isMediaEditable(t.status) || hasOverlays(t.imageOverlays) || !(await carriesOnlyItsOwnPick(db, id, t.auto))) continue;
                // The marker moves with the video: still not one the USER chose.
                await putVideoOn(db, args.orgId, id, args.assetId, tf.key, { autoMediaAssetId: args.assetId });
                placed++;
            }
            if (placed) return true;
        }
        return false;
    } catch (err) {
        console.error('[video-post-media] campaign placement failed — the video stays in My Content:', args, err instanceof Error ? err.message : err);
        return false;
    }
}

async function carriesOnlyItsOwnPick(db: Db, postId: number, auto: number | null): Promise<boolean> {
    if (!auto) return false;
    const rows = await db.select({ id: scheduledPostAssets.contentAssetId }).from(scheduledPostAssets)
        .where(eq(scheduledPostAssets.scheduledPostId, postId));
    return rows.length === 1 && rows[0].id === auto;
}
