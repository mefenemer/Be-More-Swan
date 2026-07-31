// netlify/functions/verify-compliance-warning-background.ts
// Do the actual work of settling ONE compliance warning: search the web for a real source, or
// propose a rewrite that drops the claim.
//
// The `-background` suffix is load-bearing. Netlify answers the trigger with 202 immediately and
// gives this up to 15 minutes, so the verification is not bounded by the 26-second budget of the
// request the user's click made. That matters here more than anywhere: a measured run takes ~124
// SECONDS, so this work has never been able to complete inside a request — the previous inline
// version was killed by the platform every time, with a bodyless response the endpoint could not
// turn into an explanation.
//
// AUTH: the same shared secret as the other background workers, and it fails closed. This spends
// model credits AND paid web searches, so it is not something to leave open to the internet.
//
// It writes exactly one thing: the verification state for one warning on one post. It never records
// a disposition — the human accepts the proposal through resolve-compliance-warning.ts, so the
// audit trail always has a person behind it.

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import {
    readCachedReview,
    recordVerification,
    type WarningVerification,
} from '../../src/utils/post-quality-review';
import {
    describeVerificationFailure,
    runWarningVerification,
} from '../../src/utils/compliance-verification';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[verify-compliance-warning-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return json(503, { ok: false, error: 'Worker not configured.' });
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return json(401, { ok: false, error: 'Unauthorized.' });
    }

    let postId: number | undefined;
    let warning: string | undefined;
    try {
        const body = JSON.parse(event.body || '{}');
        postId = body.postId;
        warning = body.warning;
    } catch {
        return json(400, { ok: false, error: 'Invalid JSON.' });
    }
    if (!postId || !warning) return json(400, { ok: false, error: 'postId and warning are required.' });

    const db = getDb();
    const [post] = await db
        .select({
            id: scheduledPosts.id,
            caption: scheduledPosts.caption,
            platform: scheduledPosts.platform,
            qualityReview: scheduledPosts.qualityReview,
        })
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, postId))
        .limit(1);
    if (!post) return json(404, { ok: false, error: 'Post not found.' });

    // Re-check rather than trusting the trigger. Between the click and this call the caption can
    // have changed, which invalidates both the review and the question we are about to ask.
    const review = readCachedReview(post.qualityReview, post.caption);
    if (!review || !review.complianceWarnings.includes(warning)) {
        console.warn(`[verify-compliance-warning-background] post ${postId}: warning no longer current — abandoning.`);
        return json(200, { ok: true, skipped: 'stale' });
    }

    const caption = post.caption || '';
    let verification: WarningVerification;
    try {
        const result = await runWarningVerification({
            warning,
            caption,
            platform: post.platform || 'instagram',
        });
        const finishedAt = new Date().toISOString();
        verification = result.outcome === 'sourced'
            ? { status: 'sourced', sourceUrl: result.sourceUrl, note: result.note, searchCount: result.searchCount, finishedAt }
            : result.outcome === 'rewrite'
                ? { status: 'rewrite', before: result.before, after: result.after, reason: result.reason, searchCount: result.searchCount, finishedAt }
                : { status: 'inconclusive', reason: result.reason, searchCount: result.searchCount, finishedAt };
    } catch (err) {
        console.error(`[verify-compliance-warning-background] post ${postId} failed:`, err);
        verification = {
            status: 'failed',
            error: describeVerificationFailure(err),
            finishedAt: new Date().toISOString(),
        };
    }

    // Written against the caption the work was done on. If the caption moved while we were
    // searching, recordVerification drops the result rather than filing a proposal about text that
    // no longer exists — the panel's poll then sees the stale-review error and asks for a reload.
    const stored = await recordVerification(db, { postId: post.id, caption, warning, verification });
    if (!stored) {
        console.warn(`[verify-compliance-warning-background] post ${postId}: caption changed mid-run — result discarded.`);
        return json(200, { ok: true, skipped: 'caption_changed' });
    }

    return json(200, { ok: true, status: verification.status });
});
