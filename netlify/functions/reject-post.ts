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
import { scheduledPosts, contentRules, users, aiAssistants } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { releasePostMedia } from '../../src/utils/release-post-media';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
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
        const assistantId = post.assistantId;
        const [rule] = await db.insert(contentRules).values({
            assistantId,
            workspaceId: post.organisationId,
            ruleText,
            platform: platform || null,
            createdByUserId: userId,
            isActive: true,
            origin: 'rejection_feedback',
            originPostId: postId,
        }).returning({ id: contentRules.id });
        ruleId = rule?.id;

        // Recompile the blueprint so the rule actually reaches generation. process-content-jobs reads
        // the COMPILED blueprint snapshot, not live content_rules — without this, rejection feedback
        // sits dormant until some unrelated recompile happens. Best-effort (data-assembly, no LLM); a
        // failure must never fail the rejection.
        try {
            await assembleBlueprint(assistantId, `user-${userId}`, 'rejection_feedback_rule');
        } catch (e) {
            console.warn('[reject-post] blueprint recompile after rule save failed (rule still saved):', e instanceof Error ? e.message : e);
        }
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
        // Carry the parent's origin. Without it the clone lands with trigger_type NULL and the
        // Review Queue can no longer say where the post came from — isRevised tells the reviewer
        // it was re-drafted, but not whether the original was autopilot, on-demand or hand-written.
        triggerType: post.triggerType ?? undefined,
        isAutonomous: post.isAutonomous,
        campaign: post.campaign ?? undefined,
        pillar: post.pillar ?? undefined,
        revisedFromPostId: postId,
        isRevised: true,
    }).returning({ id: scheduledPosts.id });

    // AC11 STOR-1.1.2: release this post's media to the content-retention pipeline.
    //
    // Usually a no-op, and correctly so: the revised clone created just above carries the SAME
    // contentAssetIds, so the picture is still in use and releasePostMedia leaves it alone. It only
    // releases when nothing survives that needs it (clone creation failed, or the media was dropped),
    // and the clone's own media is released later when the clone itself ends.
    //
    // This previously soft-deleted `workspace_assets` using `content_assets` ids filtered on
    // asset_type='social_image' — a different table with its own id sequence, so it reclaimed nothing
    // and could soft-delete an unrelated upload on an id collision. See
    // src/utils/release-post-media.ts before touching this.
    void (async () => {
        try {
            await releasePostMedia(db, [postId]);
        } catch (err) {
            console.error('[reject-post] media release failed (rejection still stands):', err);
        }
    })();

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
                await createNotification(db, 'post_revised', {
                    userId,
                    context: { assistant: { name: assistantName } },
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
});
