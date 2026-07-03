// netlify/functions/reject-post.ts
// US-SMM-2.2.2: Structured post rejection with optional Content Rules Library entry.
//
// POST /.netlify/functions/reject-post
//   Body: {
//     postId: number,
//     feedbackText: string,           // required — what is wrong with this post
//     applyAsRule: boolean,           // save feedback as a rule for all future drafts
//     platform?: string               // scope the rule to one platform (null = all)
//   }
//   Auth: aura_session

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, contentRules, users, notifications, aiAssistants, workspaceAssets } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    let orgId: number | undefined;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        orgId = decoded.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: { postId?: number; feedbackText?: string; applyAsRule?: boolean; platform?: string; voiceFeedback?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { postId, feedbackText, applyAsRule = false, platform, voiceFeedback = false } = body;

    if (!postId || typeof postId !== 'number') {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }
    if (!feedbackText || feedbackText.trim().length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'feedbackText is required.' }) };
    }

    const db = getDb();

    // Load the post and verify ownership
    const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId));
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    if (post.organisationId !== orgId && post.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
    }
    if (post.status === 'rejected' || post.status === 'published' || post.status === 'cancelled') {
        return { statusCode: 409, body: JSON.stringify({ error: `Cannot reject a post with status '${post.status}'.` }) };
    }

    const now = new Date();

    // Mark the post as rejected
    await db.update(scheduledPosts)
        .set({ status: 'rejected', rejectionReason: feedbackText.trim(), rejectedAt: now, updatedAt: now })
        .where(eq(scheduledPosts.id, postId));

    // Optionally save feedback as a Content Rule
    let ruleId: number | undefined;
    const ruleText = feedbackText.trim();
    if (applyAsRule && post.assistantId && post.organisationId) {
        const [rule] = await db.insert(contentRules).values({
            assistantId: post.assistantId,
            workspaceId: post.organisationId,
            ruleText,
            platform: platform || null,
            createdByUserId: userId,
            isActive: true,
            origin: 'rejection_feedback',
            originPostId: postId,
        }).returning({ id: contentRules.id });
        ruleId = rule?.id;
    }

    // Create a revised draft (clone of original) for AI regeneration
    const [revised] = await db.insert(scheduledPosts).values({
        assistantId: post.assistantId,
        userId: post.userId,
        organisationId: post.organisationId,
        platform: post.platform,
        postFormat: post.postFormat,
        publishDate: post.publishDate,
        caption: post.caption,
        contentAssetIds: post.contentAssetIds as number[],
        linkUrl: post.linkUrl ?? undefined,
        ctaText: post.ctaText ?? undefined,
        hashtags: post.hashtags ?? undefined,
        mentions: post.mentions ?? undefined,
        utmParams: post.utmParams ?? undefined,
        status: 'draft',
        ownerId: post.ownerId,
        ownerLabel: post.ownerLabel ?? undefined,
        isAutonomous: post.isAutonomous,
        campaign: post.campaign ?? undefined,
        pillar: post.pillar ?? undefined,
        revisedFromPostId: postId,
        isRevised: true,
    }).returning({ id: scheduledPosts.id });

    // AC11 STOR-1.1.2: Soft-delete associated social_image assets (30-day grace via lifecycle cleanup)
    if (post.contentAssetIds && (post.contentAssetIds as number[]).length > 0) {
        void (async () => {
            try {
                const assetIds = post.contentAssetIds as number[];
                const now2 = new Date();
                await db.update(workspaceAssets)
                    .set({ status: 'deleted', deletedAt: now2, updatedAt: now2 })
                    .where(and(
                        inArray(workspaceAssets.id, assetIds),
                        eq(workspaceAssets.assetType, 'social_image'),
                    ));
            } catch { /* non-blocking */ }
        })();
    }

    // US-SMM-2.5.1: Notify user that revised post is ready when triggered by voice feedback
    if (voiceFeedback && revised?.id) {
        void (async () => {
            try {
                let assistantName = 'Your assistant';
                if (post.assistantId) {
                    const [asst] = await db.select({ name: aiAssistants.name })
                        .from(aiAssistants).where(eq(aiAssistants.id, post.assistantId)).limit(1);
                    if (asst?.name) assistantName = asst.name;
                }
                await db.insert(notifications).values({
                    userId,
                    type: 'post_revised',
                    title: `${assistantName}: Your revised post is ready to review`,
                    message: `Your voice feedback has been applied. The revised draft is ready for your review.`,
                    metadata: { revisedPostId: revised.id, originalPostId: postId, assistantId: post.assistantId },
                });
            } catch { /* non-blocking */ }
        })();
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            revisedPostId: revised?.id,
            ruleId,
            ruleText: ruleId ? ruleText : undefined,
        }),
    };
};
