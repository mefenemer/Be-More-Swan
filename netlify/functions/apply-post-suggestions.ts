// netlify/functions/apply-post-suggestions.ts
// Assisted rewrite: propose an improvement to a draft's caption, then save what the human accepted.
//
// POST { postId, mode: 'suggest' }          → one rewrite proposal. Costs a task credit. Writes nothing.
// POST { postId, mode: 'accept', caption }  → saves the caption the human accepted (possibly
//                                             hand-edited), then re-checks COMPLIANCE ONLY.
//
// ── Why this shape ───────────────────────────────────────────────────────────────────────────
// The first version had three faults, all variations on "let the model decide when it's finished":
//
//  1. It regenerated the rewrite on apply. `gatewayGenerate` ran BEFORE the `if (!apply)` branch,
//     so the preview produced text A and accepting it sampled an independent text B — and B is what
//     got saved. Users approved a diff they never received. `mode:'accept'` now persists the exact
//     string the client holds; there is no generation on the write path at all.
//
//  2. It re-ran the FULL review after applying, which returned three fresh suggestions, which
//     offered another rewrite, forever. Nothing in that loop could ever report "good enough",
//     because a model asked for suggestions always has some. Accepting now runs the compliance-only
//     pass (see post-quality-review.ts) and leaves suggestions empty until a human asks again.
//
//  3. It was free. One button, one model call per click, unbounded clicks, nothing metered.
//     'suggest' now consumes a task credit and is capped at MAX_SUGGESTION_ROUNDS per caption.
//
// 'accept' is deliberately NOT charged: its model call is the compliance re-check, which the system
// requires for its own correctness rather than because the user asked for it, and billing someone
// for a safety check on their own edit is indefensible. Note the round cap resets when the caption
// changes, so accepting an edit does refresh the allowance — that is intended, because a materially
// different caption deserves fresh advice, and the task credit on 'suggest' remains the binding
// meter either way.
//
// Unchanged and still deliberate: this applies SUGGESTIONS only, never compliance warnings.
// Suggestions are style ("trim 12 hashtags to 4-5"). Compliance warnings are questions about the
// world ("verify this price is your current lowest tier") that no rewrite can settle — letting the
// model rewrite until its own warnings disappear builds a machine that talks itself into
// publishing, since it then re-grades its own output. And this never touches `status`: a rewritten
// post still goes through approve-post, where the compliance gate still applies.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, userOrganisations, auditLogs } from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import {
    MAX_SUGGESTION_ROUNDS, openWarnings, readCachedReview, runQualityReview,
} from '../../src/utils/post-quality-review';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';

/** Only drafts awaiting review may be rewritten — never something already scheduled or published. */
const REWRITABLE = ['draft', 'pending_approval', 'in_review'];

/** Generous, but a caption past this is a client bug rather than a user intent. */
const MAX_CAPTION_CHARS = 8000;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
        if (!JWT_SECRET) return json(500, { error: 'Server misconfigured.' });

        const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
        if (!cookie) return json(401, { error: 'Unauthorized.' });
        let userId: number;
        try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
        catch { return json(401, { error: 'Invalid session.' }); }

        let body: { postId?: number; mode?: string; caption?: string };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }

        const { postId, mode = 'suggest' } = body;
        if (!postId) return json(400, { error: 'postId required.' });
        if (mode !== 'suggest' && mode !== 'accept') {
            return json(400, { error: "mode must be 'suggest' or 'accept'." });
        }

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
                crosspostGroupId: scheduledPosts.crosspostGroupId,
            })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, postId))
            .limit(1);

        if (!post) return json(404, { error: 'Post not found.' });

        const [membership] = await db
            .select({ id: userOrganisations.id })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, post.organisationId!)))
            .limit(1);
        if (!membership) return json(403, { error: 'Forbidden.' });

        if (!REWRITABLE.includes(post.status)) {
            return json(409, { error: `A post in '${post.status}' state cannot be rewritten.` });
        }

        if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
            return json(403, { error: 'tier_required', feature: QUALITY_REVIEW_FEATURE });
        }

        const before = post.caption || '';
        const platform = post.platform || 'instagram';
        const review = readCachedReview(post.qualityReview, post.caption);

        // ── accept: persist exactly what the human approved ──────────────────────────────────
        if (mode === 'accept') {
            const accepted = (body.caption ?? '').trim();
            if (!accepted) return json(400, { error: 'caption required to accept a rewrite.' });
            if (accepted.length > MAX_CAPTION_CHARS) return json(400, { error: 'Caption is too long.' });
            if (accepted === before) return json(200, { applied: false, unchanged: true, caption: before });

            // Re-assert status inside the UPDATE so a post approved in another tab between the
            // proposal and the accept cannot be rewritten out from under the approval.
            const [updated] = await db
                .update(scheduledPosts)
                .set({ caption: accepted, updatedAt: new Date() })
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.status, post.status)))
                .returning({ id: scheduledPosts.id });

            if (!updated) {
                return json(409, {
                    error: 'This post changed while you were reviewing the rewrite. Reload and try again.',
                    code: 'CONCURRENT_EDIT',
                });
            }

            await db.insert(auditLogs).values({
                userId,
                actionType: 'POST_SUGGESTIONS_APPLIED',
                resourceType: 'scheduled_posts',
                resourceId: String(postId),
                previousState: { caption: before },
                newState: { caption: accepted, appliedSuggestions: review?.suggestions ?? [] },
            }).catch(() => {});

            // The caption changed, so the old verdict is stale by definition. Re-check COMPLIANCE
            // only: that must reflect the text as it now stands or the approval gate is guarding
            // something that no longer exists. No new suggestions — the human asked for a rewrite,
            // not for a fresh list of things still imperfect about it.
            let newReview = null;
            try {
                newReview = await runQualityReview(db, {
                    id: post.id,
                    assistantId: post.assistantId,
                    caption: accepted,
                    hashtags: post.hashtags as string | null,
                    platform: post.platform,
                }, { withSuggestions: false, previous: review });
            } catch { /* non-fatal — the rewrite is saved either way */ }

            // Keep cross-post siblings on the same caption and verdict. Matched on the OLD caption,
            // so a sibling someone had edited per-platform keeps its own text.
            if (post.crosspostGroupId) {
                await db
                    .update(scheduledPosts)
                    .set({
                        caption: accepted,
                        ...(newReview ? { qualityReview: newReview as unknown as Record<string, unknown> } : {}),
                        updatedAt: new Date(),
                    })
                    .where(and(
                        eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId),
                        eq(scheduledPosts.caption, before),
                    ))
                    .catch(() => {});
            }

            return json(200, {
                applied: true,
                caption: accepted,
                review: newReview,
                openWarnings: openWarnings(newReview),
            });
        }

        // ── suggest: propose a rewrite, write nothing ────────────────────────────────────────
        if (!review) {
            return json(409, {
                error: 'No current quality review for this post. Run the review first.',
                code: 'REVIEW_STALE',
            });
        }
        if (!review.suggestions.length) {
            return json(409, { error: 'This post has no outstanding suggestions.', code: 'NO_SUGGESTIONS' });
        }
        // The hard stop on the treadmill. Without it a user can sit on this button indefinitely and
        // every press is a model call somebody pays for.
        if ((review.suggestionRounds ?? 0) >= MAX_SUGGESTION_ROUNDS) {
            return json(429, {
                error: `You've used all ${MAX_SUGGESTION_ROUNDS} assisted rewrites for this caption. Edit it yourself, or approve it as it stands.`,
                code: 'ROUNDS_EXHAUSTED',
            });
        }

        const credit = await consumeTaskCredit(db, post.organisationId!);
        if (!credit.allowed) return json(429, { error: credit.limitMessage, code: 'TASK_LIMIT' });

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
        if (!after) return json(502, { error: 'The rewrite came back empty. Please try again.' });

        return json(200, {
            applied: false,
            before,
            after,
            suggestions: review.suggestions,
            unchanged: after === before,
        });
    } catch (err: any) {
        console.error('[apply-post-suggestions]', err);
        return json(500, { error: 'Could not apply suggestions. Please try again.' });
    }
});
