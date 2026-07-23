// netlify/functions/retry-failed-post.ts
// Group D / Request 6: recover a post that failed to publish.
//
// POST { postId, publishDate? } → puts the post back in the publish queue.
//   no publishDate  → "Try again now": publish_date = now(), so the next publisher tick picks it up.
//   with publishDate → "Reschedule": publish_date = the chosen future time.
//
// Either way the failure state is cleared (attempt_count back to 0, failure_reason and retry_at
// dropped) so the post gets a full fresh set of attempts rather than immediately re-failing on the
// exhausted counter. Only a post the caller's org owns, and only one actually in 'failed', can be
// retried — a published post must never be re-queued by this path.

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, auditLogs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;
    if (!organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation.' }) };

    let postId: number; let publishDateRaw: string | null;
    try {
        const body = JSON.parse(event.body || '{}');
        postId = Number(body.postId);
        publishDateRaw = body.publishDate ? String(body.publishDate) : null;
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    if (!Number.isInteger(postId) || postId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A postId is required.' }) };
    }

    let publishDate = new Date();
    if (publishDateRaw) {
        const parsed = new Date(publishDateRaw);
        if (Number.isNaN(parsed.getTime())) {
            return { statusCode: 400, body: JSON.stringify({ error: 'That reschedule date could not be read.' }) };
        }
        publishDate = parsed;
    }

    // Scope by organisation as well as id, so a post id from another tenant is a 404, not a retry.
    const [post] = await db
        .select({ id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)))
        .limit(1);

    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'That post could not be found.' }) };
    if (post.status !== 'failed') {
        return { statusCode: 409, body: JSON.stringify({ error: `This post is ${post.status}, not failed — there is nothing to retry.` }) };
    }

    await db.update(scheduledPosts)
        .set({
            status: 'scheduled',
            publishDate,
            attemptCount: 0,
            retryAt: null,
            failureReason: null,
            updatedAt: new Date(),
        })
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)));

    await db.insert(auditLogs).values({
        actionType: publishDateRaw ? 'post_rescheduled_after_failure' : 'post_retried_after_failure',
        resourceType: 'scheduled_posts',
        resourceId: String(postId),
        userId: userId ?? null,
        newState: { platform: post.platform, publishDate: publishDate.toISOString() },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, postId, status: 'scheduled', publishDate: publishDate.toISOString() }),
    };
});
