// netlify/functions/retry-failed-post.ts
// Group D / Request 6: recover a post that failed to publish.
//
// POST { postId, publishDate?, mode? } → gets the post out of 'failed'.
//   mode omitted / 'retry', no publishDate  → "Try again now": status 'scheduled', publish_date =
//                                             now(), so the next publisher tick picks it up.
//   mode omitted / 'retry', with publishDate → "Reschedule": status 'scheduled' at the chosen time.
//   mode 'edit'                              → "Fix it first": status back to 'pending_approval'.
//
// ── Why 'edit' exists ──────────────────────────────────────────────────────────────────────────
// Most publish failures are NOT transient. The picture is the wrong aspect ratio, the caption
// tripped a content policy, the media is gone from storage — re-queueing the identical post just
// fails it again, one attempt-budget later. Those need the post CHANGED before it goes back out,
// and 'failed' is not an editable status: it is absent from MEDIA_EDITABLE_STATUSES
// (src/config/post-status.ts) and from _pceIsEditablePost in workspace.html, so every editing
// control in the review modal is switched off while a post sits in it.
//
// Returning it to 'pending_approval' puts it back exactly where an assistant's fresh draft lives:
// the Review column, fully editable, with the normal approve flow — which is what re-schedules it.
// No new lifecycle state, no second approval path. It deliberately does NOT go to 'draft', which
// no Review Queue column reads (see the note in src/config/post-status.ts).
//
// Every mode clears the failure state (attempt_count back to 0, failure_reason and retry_at
// dropped) so the post gets a full fresh set of attempts rather than immediately re-failing on the
// exhausted counter. Only a post the caller's org owns, and only one actually in 'failed', can be
// recovered — a published post must never be re-queued by this path.

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

    let postId: number; let publishDateRaw: string | null; let mode: string;
    try {
        const body = JSON.parse(event.body || '{}');
        postId = Number(body.postId);
        publishDateRaw = body.publishDate ? String(body.publishDate) : null;
        mode = body.mode ? String(body.mode) : 'retry';
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    if (!Number.isInteger(postId) || postId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A postId is required.' }) };
    }
    if (mode !== 'retry' && mode !== 'edit') {
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown mode '${mode}'.` }) };
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

    // 'edit' keeps the post's existing publish_date: it is a PROPOSAL again from here, and moving it
    // to now() would put a post the user is about to rewrite into an already-past slot.
    const nextStatus = mode === 'edit' ? 'pending_approval' : 'scheduled';

    await db.update(scheduledPosts)
        .set({
            status: nextStatus,
            ...(mode === 'edit' ? {} : { publishDate }),
            attemptCount: 0,
            retryAt: null,
            failureReason: null,
            updatedAt: new Date(),
        })
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)));

    await db.insert(auditLogs).values({
        actionType: mode === 'edit' ? 'post_reopened_after_failure'
            : publishDateRaw ? 'post_rescheduled_after_failure'
            : 'post_retried_after_failure',
        resourceType: 'scheduled_posts',
        resourceId: String(postId),
        userId: userId ?? null,
        newState: { platform: post.platform, status: nextStatus, ...(mode === 'edit' ? {} : { publishDate: publishDate.toISOString() }) },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ok: true,
            postId,
            status: nextStatus,
            ...(mode === 'edit' ? {} : { publishDate: publishDate.toISOString() }),
        }),
    };
});
