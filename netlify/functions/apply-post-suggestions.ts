// netlify/functions/apply-post-suggestions.ts
// Assisted rewrite: apply the quality reviewer's SUGGESTIONS to a draft's caption.
//
// POST { postId, apply?: boolean }
//   apply=false (default) → preview only: returns { before, after, suggestions } and writes nothing
//   apply=true            → persists the rewritten caption, re-runs the review, returns the new verdict
//
// Design notes, because the obvious version of this feature is a trap:
//
//  1. SUGGESTIONS ONLY — never compliance warnings. Suggestions are style ("trim 12 hashtags to
//     4-5", "soften an absolute claim"). Compliance warnings are things like "verify this price is
//     your current lowest tier" — questions about the world that no rewrite can settle. Letting the
//     model rewrite until its own warnings disappear builds a machine that talks itself into
//     publishing, because the same model then re-grades its own output.
//
//  2. TWO-STEP BY DEFAULT. The caller previews a diff and the human accepts it. Nothing is silently
//     rewritten under someone who already read the draft.
//
//  3. NO AUTO-APPROVAL. This never touches `status`. A rewritten post still goes through
//     approve-post, and if compliance warnings survive the rewrite the gate there still fires.
//     Re-running the review after applying is honest bookkeeping (the caption changed, so the
//     cached verdict is stale by construction) — it is not permission to publish.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, userOrganisations, auditLogs } from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { readCachedReview, runQualityReview } from '../../src/utils/post-quality-review';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';

/** Only drafts awaiting review may be rewritten — never something already scheduled or published. */
const REWRITABLE = ['draft', 'pending_approval', 'in_review'];

export default withLambda(async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
        if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

        const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
        if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
        let userId: number;
        try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
        catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

        let body: { postId?: number; apply?: boolean };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

        const { postId, apply = false } = body;
        if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

        const db = getDb();
        const [post] = await db
            .select({
                id: scheduledPosts.id,
                organisationId: scheduledPosts.organisationId,
                assistantId: scheduledPosts.assistantId,
                caption: scheduledPosts.caption,
                hashtags: scheduledPosts.hashtags,
                platform: scheduledPosts.platform,
                status: scheduledPosts.status,
                qualityReview: scheduledPosts.qualityReview,
            })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, postId))
            .limit(1);

        if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

        const [membership] = await db
            .select({ id: userOrganisations.id })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, post.organisationId!)))
            .limit(1);
        if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

        if (!REWRITABLE.includes(post.status)) {
            return { statusCode: 409, body: JSON.stringify({ error: `A post in '${post.status}' state cannot be rewritten.` }) };
        }

        if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
            return { statusCode: 403, body: JSON.stringify({ error: 'tier_required', feature: QUALITY_REVIEW_FEATURE }) };
        }

        // The suggestions must match the CURRENT caption. A stale verdict would have us applying
        // advice about text that no longer exists.
        const review = readCachedReview(post.qualityReview, post.caption);
        if (!review) {
            return {
                statusCode: 409,
                body: JSON.stringify({ error: 'No current quality review for this post. Run the review first.', code: 'REVIEW_STALE' }),
            };
        }
        if (!review.suggestions.length) {
            return { statusCode: 409, body: JSON.stringify({ error: 'This post has no outstanding suggestions.', code: 'NO_SUGGESTIONS' }) };
        }

        const before = post.caption || '';
        const platform = post.platform || 'instagram';

        const prompt = `Revise the social media caption below by applying the reviewer's suggestions.

Rules:
- Apply ONLY the suggestions listed. Change nothing else.
- Preserve the author's voice, meaning, and any factual claims exactly as written — do not soften,
  strengthen, add or remove a claim about price, performance, or results.
- Keep it suitable for ${platform}.
- Return ONLY the revised caption text. No preamble, no quotes, no markdown.

Suggestions to apply:
${review.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Caption:
"""
${before}
"""`;

        const gw = await gatewayGenerate({
            system: 'You are a careful copy editor. You apply the requested edits and nothing more. You never invent or alter factual claims.',
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 900,
        });

        const after = (gw.text || '').trim().replace(/^["']|["']$/g, '');
        if (!after) {
            return { statusCode: 502, body: JSON.stringify({ error: 'The rewrite came back empty. Please try again.' }) };
        }
        if (after === before) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applied: false, unchanged: true, before, after, suggestions: review.suggestions }),
            };
        }

        // Preview mode — show the human the diff and write nothing.
        if (!apply) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applied: false, before, after, suggestions: review.suggestions }),
            };
        }

        // Apply. Re-read status inside the update so a post approved in another tab between the
        // preview and the accept cannot be rewritten out from under the approval.
        const [updated] = await db
            .update(scheduledPosts)
            .set({ caption: after, updatedAt: new Date() })
            .where(and(
                eq(scheduledPosts.id, postId),
                eq(scheduledPosts.status, post.status),
            ))
            .returning({ id: scheduledPosts.id });

        if (!updated) {
            return { statusCode: 409, body: JSON.stringify({ error: 'This post changed while you were reviewing the rewrite. Reload and try again.', code: 'CONCURRENT_EDIT' }) };
        }

        await db.insert(auditLogs).values({
            userId,
            actionType: 'POST_SUGGESTIONS_APPLIED',
            resourceType: 'scheduled_posts',
            resourceId: String(postId),
            previousState: { caption: before },
            newState: { caption: after, appliedSuggestions: review.suggestions },
        }).catch(() => {});

        // The caption changed, so the cached verdict is stale by definition — recompute it. This is
        // bookkeeping, NOT clearance: any surviving compliance warning still blocks approve-post
        // until a human acknowledges it.
        let newReview = null;
        try {
            newReview = await runQualityReview(db, {
                id: post.id,
                assistantId: post.assistantId,
                caption: after,
                hashtags: post.hashtags as string | null,
                platform: post.platform,
            });
        } catch { /* non-fatal — the rewrite is saved either way */ }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applied: true, before, after, review: newReview }),
        };
    } catch (err: any) {
        console.error('[apply-post-suggestions]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not apply suggestions. Please try again.' }) };
    }
});
