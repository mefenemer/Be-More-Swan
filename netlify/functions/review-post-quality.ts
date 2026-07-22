// netlify/functions/review-post-quality.ts
// US-CAL-5.1: AI Content Quality Review
//
// POST { postId }
// → { brandVoiceScore, complianceWarnings, suggestions, cachedAt }
//
// SC7: requires tierKey 'saver' or 'employee'
// SC8: result cached in scheduled_posts.qualityReview jsonb; re-run only on caption change

import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userOrganisations, scheduledPosts } from '../../db/schema';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import {
    MAX_SUGGESTION_ROUNDS, openWarnings, readCachedReview, runQualityReview,
} from '../../src/utils/post-quality-review';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;

// Gated on the plan's `quality_reviewer` feature flag, NOT on a hardcoded tier-key list. The old
// list read `['saver','employee']`, which dated from when 'saver' was the middle tier — after the
// plans were re-ordered ('saver' is now the entry plan, 'buster' the mid one) it silently granted
// quality review to the cheapest plan and 403'd the plan that actually sells it. master_plans.features
// is the published source of truth (it matches the pricing comparison table), so read that instead
// and the gate can never invert again.
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';

export default withLambda(async (event) => {
    try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    let body: { postId?: number; includeSuggestions?: boolean };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const { postId, includeSuggestions = false } = body;
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
            qualityReview: (scheduledPosts as any).qualityReview,
        })
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, postId))
        .limit(1);

    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Org membership guard
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, post.organisationId!)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // SC7: plan gate — the plan must include The Quality Reviewer.
    if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'tier_required', feature: QUALITY_REVIEW_FEATURE }) };
    }

    // SC8: return the cached verdict when the caption has not changed since it was computed.
    // A caption edit MUST invalidate it — otherwise a user could edit away the text a warning was
    // raised about, keep the clean review, and approve against a verdict for different content.
    const cached = readCachedReview(post.qualityReview, post.caption);
    if (cached && !includeSuggestions) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...cached, openWarnings: openWarnings(cached), fromCache: true }),
        };
    }

    // A cache miss means the caption changed since the last verdict, and simply opening a post is
    // not a request for fresh style feedback — so this recomputes COMPLIANCE ONLY by default.
    // Generating suggestions here is what made the panel refill itself after every rewrite and
    // turned the feature into a treadmill; suggestions now require includeSuggestions, which only
    // an explicit user action sets.
    if (includeSuggestions && (cached?.suggestionRounds ?? 0) >= MAX_SUGGESTION_ROUNDS) {
        return {
            statusCode: 429,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: `You've used all ${MAX_SUGGESTION_ROUNDS} suggestion rounds for this caption.`,
                code: 'ROUNDS_EXHAUSTED',
            }),
        };
    }

    // Fresh suggestions are discretionary work a human asked for, so they cost a task credit. The
    // automatic compliance re-check does not — the system requires that for its own correctness.
    if (includeSuggestions) {
        const credit = await consumeTaskCredit(db, post.organisationId!);
        if (!credit.allowed) {
            return {
                statusCode: 429,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: credit.limitMessage, code: 'TASK_LIMIT' }),
            };
        }
    }

    try {
        const result = await runQualityReview(db, {
            id: post.id,
            assistantId: post.assistantId,
            caption: post.caption,
            hashtags: post.hashtags as string | null,
            platform: post.platform,
        }, { withSuggestions: includeSuggestions, previous: cached });
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result, openWarnings: openWarnings(result) }),
        };
    } catch (e: any) {
        return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e?.message || 'Quality review failed.' }) };
    }
    } catch (err: any) {
        console.error('[review-post-quality] Unhandled error:', err);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Quality review failed. Please try again.' }) };
    }
});

