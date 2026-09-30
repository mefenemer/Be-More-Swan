// netlify/functions/reject-blog-post.ts
// Reject a blog draft with a reason, so the Blog Writer learns from it — the blog counterpart of
// reject-post.ts (social).
//
// Before this, a blog draft could only be approved, scheduled or ARCHIVED. Archiving frees the slot
// and says nothing about why, so the next draft made the same mistake: the "try again, but not like
// that" gesture social posts have had since reject-post.ts did not exist for long-form at all.
//
// It does three things; only (a) is required, and (b) and (c) never fail the rejection:
//   (a) marks the draft 'rejected' — a status blog_posts already allows. It is absent from the
//       gap-fill coverage list (blog-gap-fill.ts), so the slot is free again, and the Review page
//       lists it under Archive;
//   (b) saves the reason as a Content Rule (origin 'rejection_feedback') and recompiles the
//       blueprint — blog drafting reads rules from the compiled blueprint's §4
//       (buildBlueprintGuardrailsBlock), and topic ideation now reads them too;
//   (c) queues a replacement draft for the same slot, carrying the reason as the job's direction —
//       only when the slot is still ahead of us. A past-dated slot is history; the daily horizon
//       fill takes care of the future ones.
//
// POST /.netlify/functions/reject-blog-post
//   Body: { id: number, feedbackText: string, applyAsRule?: boolean (default true),
//           redraft?: boolean (default true) }
//   Returns: { success, id, ruleId?, redraftQueued, redraftSkippedReason? }
//   Auth: aura_session (requireTenant); org-scoped.

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, auditLogs, blogPosts, contentGenerationJobs, contentRules } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { withLambda } from '@netlify/aws-lambda-compat';

/** States a human can still reject. Anything live, publishing or already closed is not a draft. */
const REJECTABLE = ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'];
const MAX_FEEDBACK = 1000;
/** Mirrors reject-post.ts: the reason pasted into the redraft's direction is capped. */
const MAX_CONTEXT = 500;
/** A slot this close is not worth a redraft that might land after it. */
const MIN_LEAD_MS = 60 * 60 * 1000;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { id?: unknown; feedbackText?: unknown; applyAsRule?: unknown; redraft?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const id = Number(body.id);
    const feedback = typeof body.feedbackText === 'string' ? body.feedbackText.trim().slice(0, MAX_FEEDBACK) : '';
    const applyAsRule = body.applyAsRule !== false;
    const redraft = body.redraft !== false;
    if (!Number.isInteger(id)) return json(400, { error: 'A valid post id is required.' });
    if (!feedback) return json(400, { error: 'Say what is wrong with this draft, so your assistant can learn from it.' });

    const [post] = await db
        .select({
            id: blogPosts.id, title: blogPosts.title, status: blogPosts.status,
            assistantId: blogPosts.assistantId, publishDate: blogPosts.publishDate,
        })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Blog post not found.' });
    if (!REJECTABLE.includes(post.status)) {
        return json(409, { error: post.status === 'published'
            ? 'This post is live. Unpublish it first if you want to reject it.'
            : `A post that is ${post.status} can't be rejected.` });
    }

    const now = new Date();
    // (a) — conditional on the status still being rejectable, so a publish that raced this request wins.
    const rejected = await db.update(blogPosts)
        .set({ status: 'rejected', updatedAt: now })
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, orgId), eq(blogPosts.status, post.status)))
        .returning({ id: blogPosts.id });
    if (!rejected.length) return json(409, { error: 'This post changed while you were reviewing it. Reopen it and try again.' });

    // (b) — teach. Unscoped by platform: a blog rule belongs to the Blog Writer, and rules are
    // per assistant already. origin_post_id is a SOCIAL post id elsewhere, so the blog id goes in
    // the note instead of pretending to be one.
    let ruleId: number | undefined;
    if (applyAsRule && post.assistantId) {
        try {
            const [rule] = await db.insert(contentRules).values({
                assistantId: post.assistantId,
                workspaceId: orgId,
                ruleText: feedback,
                platform: null,
                createdByUserId: userId,
                isActive: true,
                origin: 'rejection_feedback',
                note: `From rejecting blog post #${post.id}: "${post.title.slice(0, 120)}"`,
            }).returning({ id: contentRules.id });
            ruleId = rule?.id;
            await assembleBlueprint(post.assistantId, `user-${userId}`, 'rejection_feedback_rule');
        } catch (e) {
            console.warn('[reject-blog-post] rule save / recompile failed (rejection stands):', e instanceof Error ? e.message : e);
        }
    }

    // (c) — redraft the slot, while it is still ahead of us.
    let redraftQueued = false;
    let redraftSkippedReason: string | undefined;
    if (!redraft) redraftSkippedReason = 'not_requested';
    else if (!post.assistantId) redraftSkippedReason = 'no_assistant';
    else if (!post.publishDate || new Date(post.publishDate).getTime() < now.getTime() + MIN_LEAD_MS) redraftSkippedReason = 'no_future_slot';
    else {
        try {
            const [asst] = await db.select({ userId: aiAssistants.userId })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);
            if (!asst) redraftSkippedReason = 'no_assistant';
            else {
                await db.insert(contentGenerationJobs).values({
                    jobId: randomUUID(),
                    assistantId: post.assistantId,
                    organisationId: orgId,
                    userId: asst.userId,
                    status: 'queued',
                    attempt: 0,
                    maxAttempts: 3,
                    triggerType: 'scheduled',
                    contentType: 'blog',
                    targetPublishDate: post.publishDate,
                    contextPrompt: `A reviewer rejected an earlier draft for this slot, titled "${post.title.slice(0, 120)}". `
                        + `Their reason: ${feedback.slice(0, MAX_CONTEXT)}. Write a different post that avoids this problem.`,
                });
                redraftQueued = true;
            }
        } catch (e) {
            console.warn('[reject-blog-post] redraft enqueue failed (rejection stands):', e instanceof Error ? e.message : e);
            redraftSkippedReason = 'enqueue_failed';
        }
    }

    await db.insert(auditLogs).values({
        userId,
        actionType: 'REJECT',
        resourceType: 'blog_posts',
        resourceId: String(post.id),
        previousState: { status: post.status },
        newState: { status: 'rejected', feedback, ruleId: ruleId ?? null, redraftQueued },
    }).catch(() => {});

    return json(200, { success: true, id: post.id, ruleId, redraftQueued, redraftSkippedReason });
});
