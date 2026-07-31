// netlify/functions/verify-compliance-warning.ts
// Start — or read the progress of — an assistant-led verification of ONE compliance warning.
//
// POST { postId, warning }          → 202 { status: 'running' }        (starts the work)
// POST { postId, warning, poll: 1 } → 200 { status: ... }              (reads it back, no charge)
//
// Terminal states returned by either call:
//   { status: 'sourced',      sourceUrl, note, searchCount }   — a citation the SEARCH TOOL returned
//   { status: 'rewrite',      before, after, reason, searchCount } — drop the claim instead
//   { status: 'inconclusive', reason, searchCount }            — the human decides
//   { status: 'failed',       error }                          — the run itself did not complete
//
// ── Why this does not do the work ─────────────────────────────────────────────────────────────
// It used to. A measured verification takes ~124 SECONDS — four web searches, dynamic filtering,
// and the model's own reasoning — against a 26-second cap on a synchronous Netlify function. The
// platform's kill produces a response with NO BODY, so the handler could not report what happened
// however careful its own try/catch was; the browser fell back to its generic string and the user
// was told nothing, having already been charged the task credit.
//
// (Two earlier attempts to bound the call inside the request are worth not repeating. A `deadlineMs`
// alone does not bound anything: the SDK's `timeout` is PER ATTEMPT and it retries a connection
// timeout twice, so a 20s budget measured 61s of wall clock. And even bounded perfectly, a budget
// that fits in 26s cannot finish work that needs 124s — it only converts a mysterious failure into
// a reliable one.)
//
// So the work runs in verify-compliance-warning-background.ts, which has a 15-minute ceiling, and
// this endpoint owns the parts that genuinely belong in the request: authorisation, the plan gate,
// the task credit, and the state the panel polls.
//
// What this endpoint still refuses to do is RECORD a disposition. Verification proposes; the human
// accepts through resolve-compliance-warning.ts with their own click behind it.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, userOrganisations } from '../../db/schema';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import {
    isVerificationInFlight,
    readCachedReview,
    recordVerification,
    type WarningVerification,
} from '../../src/utils/post-quality-review';
import { triggerWarningVerification } from '../../src/utils/trigger-verification';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';
const VERIFIABLE = ['draft', 'pending_approval', 'in_review'];

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** The stored verification, shaped for the panel. `idle` means nothing has been started. */
function stateFor(
    review: { verifications?: Record<string, WarningVerification> } | null,
    warning: string,
): WarningVerification | { status: 'idle' } {
    return review?.verifications?.[warning] ?? { status: 'idle' };
}

export default withLambda(async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
        if (!JWT_SECRET) return json(500, { error: 'Server misconfigured.' });

        const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
        if (!cookie) return json(401, { error: 'Unauthorized.' });
        let userId: number;
        try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
        catch { return json(401, { error: 'Invalid session.' }); }

        let body: { postId?: number; warning?: string; poll?: unknown };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }

        const { postId, warning } = body;
        const isPoll = Boolean(body.poll);
        if (!postId) return json(400, { error: 'postId required.' });
        if (!warning) return json(400, { error: 'warning required.' });

        const db = getDb();
        const [post] = await db
            .select({
                id: scheduledPosts.id,
                organisationId: scheduledPosts.organisationId,
                caption: scheduledPosts.caption,
                status: scheduledPosts.status,
                qualityReview: scheduledPosts.qualityReview,
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

        const review = readCachedReview(post.qualityReview, post.caption);
        if (!review) {
            return json(409, {
                error: 'This post has no current quality review — its caption changed. Reload to see the latest warnings.',
                code: 'REVIEW_STALE',
            });
        }
        if (!review.complianceWarnings.includes(warning)) {
            return json(409, { error: 'That warning is not on this post any more. Reload to see the latest.', code: 'UNKNOWN_WARNING' });
        }

        // ── Polling: cheap, unmetered, and gated by nothing beyond ownership ──────────────────
        // Deliberately ahead of the plan gate and the credit. A poll is a read of work already paid
        // for, and a user whose plan lapsed mid-run should still be told how their run ended.
        if (isPoll) {
            const stored = stateFor(review, warning);
            // A 'running' marker older than the staleness window belongs to a worker that died.
            // Report it as failed rather than spinning forever — the user needs to be able to retry.
            if (stored.status === 'running' && !isVerificationInFlight(stored)) {
                return json(200, {
                    status: 'failed',
                    error: 'The check stopped before it finished. Try again, or add a source yourself.',
                });
            }
            return json(200, stored);
        }

        if (!VERIFIABLE.includes(post.status)) {
            return json(409, { error: `A post in '${post.status}' state can no longer be amended.` });
        }
        if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
            return json(403, { error: 'tier_required', feature: QUALITY_REVIEW_FEATURE });
        }

        // Already working on this exact warning: join the run in progress rather than starting a
        // second one. Two workers would double-charge, race each other's writes, and produce two
        // answers for one question.
        if (isVerificationInFlight(review.verifications?.[warning])) {
            return json(202, { status: 'running' });
        }

        // Web search is real spend on top of the model call, and this is a user-initiated action.
        const credit = await consumeTaskCredit(db, post.organisationId!);
        if (!credit.allowed) return json(429, { error: credit.limitMessage, code: 'TASK_LIMIT' });

        // Claim the slot BEFORE dispatching. If the trigger fails we overwrite this with a failure
        // below; if it succeeds, a second click between here and the worker's first write is caught
        // by the in-flight check above.
        const claimed = await recordVerification(db, {
            postId: post.id,
            caption: post.caption,
            warning,
            verification: { status: 'running', startedAt: new Date().toISOString(), userId },
        });
        if (!claimed) {
            return json(409, {
                error: 'This post has no current quality review — its caption changed. Reload to see the latest warnings.',
                code: 'REVIEW_STALE',
            });
        }

        const dispatched = await triggerWarningVerification(event.headers as never, post.id, warning);
        if (!dispatched.ok) {
            // Nothing is going to run, so do not leave a spinner behind. The credit is already spent
            // and there is no refund path — say so plainly rather than hiding it.
            await recordVerification(db, {
                postId: post.id,
                caption: post.caption,
                warning,
                verification: { status: 'failed', error: dispatched.reason, finishedAt: new Date().toISOString() },
            });
            return json(503, { error: dispatched.reason, code: 'VERIFY_NOT_DISPATCHED' });
        }

        return json(202, { status: 'running' });
    } catch (err: any) {
        console.error('[verify-compliance-warning]', err);
        return json(500, { error: 'Could not start the check. Please try again.' });
    }
});

/**
 * Re-exported so the existing import path keeps working. The implementation moved to
 * src/utils/compliance-verification.ts when the work moved to the background worker — it is the one
 * check standing between a real citation and a fabricated one, and it must not exist twice.
 */
export { matchesSearchedUrl } from '../../src/utils/compliance-verification';
