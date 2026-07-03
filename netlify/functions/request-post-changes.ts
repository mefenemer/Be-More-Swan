// netlify/functions/request-post-changes.ts
// Review Queue → "Request changes": the reviewer sends free-text feedback and the assistant
// regenerates a revised draft. Reuses the content-generation pipeline (contentGenerationJobs +
// process-content-jobs cron) that backs Create Post → Work-with-AI. The current draft is cancelled
// so it leaves the queue; the regenerated draft re-appears as pending_approval automatically.
//
// POST /.netlify/functions/request-post-changes
//   Auth: aura_session cookie
//   Body: { postId: number, feedback: string }

import { Handler } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiBlueprints, auditLogs, contentGenerationJobs, notifications, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const MAX_FEEDBACK = 500;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: { postId?: number; feedback?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const postId = Number(body.postId);
    const feedback = (body.feedback || '').trim();
    if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    if (!feedback) return { statusCode: 400, body: JSON.stringify({ error: 'feedback is required.' }) };
    if (feedback.length > MAX_FEEDBACK) {
        return { statusCode: 400, body: JSON.stringify({ error: `feedback must be ${MAX_FEEDBACK} characters or fewer.` }) };
    }

    // Load the post and verify it belongs to the active org.
    const [post] = await db
        .select()
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    if (!post.assistantId) {
        return { statusCode: 422, body: JSON.stringify({ error: 'This post has no assistant to regenerate it.' }) };
    }
    if (!['draft', 'in_review', 'pending_approval'].includes(post.status)) {
        return { statusCode: 409, body: JSON.stringify({ error: `Cannot request changes for a post in '${post.status}' state.` }) };
    }

    // Resolve a blueprint: prefer the one this draft was built from, else the assistant's latest.
    let blueprintId = post.blueprintId ?? null;
    if (!blueprintId) {
        const [bp] = await db
            .select({ id: aiBlueprints.id })
            .from(aiBlueprints)
            .where(and(eq(aiBlueprints.assistantId, post.assistantId), eq(aiBlueprints.organisationId, organisationId)))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);
        blueprintId = bp?.id ?? null;
    }
    if (!blueprintId) {
        return { statusCode: 422, body: JSON.stringify({ error: 'No blueprint available to regenerate this post.' }) };
    }

    // Per-org concurrency guard (mirrors generate-post.ts).
    const [{ jobCount }] = await db.execute<{ jobCount: number }>(
        `SELECT COUNT(*)::int AS "jobCount" FROM content_generation_jobs WHERE organisation_id = ${organisationId} AND status IN ('queued','processing')`
    );
    if (jobCount >= 50) {
        return { statusCode: 429, body: JSON.stringify({ error: 'Too many pending generation jobs. Please wait for some to complete.' }) };
    }

    const now = new Date();
    const jobId = randomUUID();
    const contextPrompt =
        `Revise the previous ${post.platform} draft. Keep what worked, but apply this reviewer feedback: ${feedback}`.slice(0, MAX_FEEDBACK);

    // Enqueue the regeneration job targeting the same slot the original draft was aimed at.
    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId,
        assistantId: post.assistantId,
        organisationId,
        userId,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        contextPrompt,
        triggerType: 'on_demand',
        platform: post.platform,
        targetPublishDate: post.publishDate,
    });

    // Remove the superseded draft from the review queue.
    await db.update(scheduledPosts)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(scheduledPosts.id, postId));

    await db.insert(auditLogs).values({
        userId,
        actionType: 'POST_CHANGES_REQUESTED',
        resourceType: 'scheduled_posts',
        resourceId: String(postId),
        newState: { feedback, jobId, requestedAt: now.toISOString() },
    }).catch(() => {});

    await db.insert(notifications).values({
        userId,
        type: 'post_generation_queued',
        title: 'Revising your post…',
        message: 'Your feedback was sent to the assistant. The revised draft will be ready to review shortly.',
        metadata: { jobId, originalPostId: postId },
    }).catch(() => {});

    return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requested: true, jobId, status: 'queued', estimatedReadyIn: '30–60 seconds' }),
    };
};
