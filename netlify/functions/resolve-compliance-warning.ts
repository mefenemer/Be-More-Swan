// netlify/functions/resolve-compliance-warning.ts
// Settle ONE compliance warning on ONE post, per warning, with a reason.
//
// POST { postId, warning, action: 'sourced'|'not_applicable'|'reopen', sourceUrl?, note? }
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────
// The compliance panel used to be a dead end. It listed warnings like "the statistic '8.2 software
// subscriptions' should be verified and sourced" and offered exactly nothing to do about it: no way
// to supply the source, no way to say it doesn't apply, no way to mark it handled. The only exit
// was the blanket "approve anyway" confirm, which recorded that a human clicked past ALL of them
// together and told you nothing about why.
//
// That is the worst possible shape for a compliance control. It trains people to click through,
// and the audit trail it leaves ("user accepted 2 warnings") is not evidence of anything.
//
// So: each warning gets its own disposition and its own reason.
//   • sourced        — the claim is real and here is the citation. The usual honest answer for a
//                      statistic; the URL is stored against that specific warning.
//   • not_applicable — judged not to apply, with a written reason.
//   • reopen         — undo, putting the warning back in front of the approver.
//
// A disposed warning stops blocking approval (see openWarnings) but is NOT deleted — it stays in
// complianceWarnings with its resolution attached, so the record shows what was raised, who
// answered it, when, and on what grounds.
//
// No model call. This is bookkeeping about a human decision, and asking a model to grade the
// human's justification would just recreate the loop this feature was built to escape.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, userOrganisations, auditLogs } from '../../db/schema';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import {
    openWarnings, readCachedReview, recordDisposition, type WarningDisposition,
} from '../../src/utils/post-quality-review';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';

/** Warnings can only be settled while the post is still awaiting a decision. */
const RESOLVABLE = ['draft', 'pending_approval', 'in_review'];

const MAX_NOTE_CHARS = 1000;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Accept only a well-formed http(s) URL — a citation field that takes anything cites nothing. */
function normaliseSourceUrl(raw: string): string | null {
    try {
        const u = new URL(raw.trim());
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
    } catch { return null; }
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

        let body: { postId?: number; warning?: string; action?: string; sourceUrl?: string; note?: string };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }

        const { postId, warning, action } = body;
        if (!postId) return json(400, { error: 'postId required.' });
        if (!warning) return json(400, { error: 'warning required.' });
        if (action !== 'sourced' && action !== 'not_applicable' && action !== 'reopen') {
            return json(400, { error: "action must be 'sourced', 'not_applicable' or 'reopen'." });
        }

        const note = (body.note ?? '').trim().slice(0, MAX_NOTE_CHARS);

        // A citation is the whole point of 'sourced' — without one it is just an unexplained
        // dismissal wearing a more reassuring label.
        let sourceUrl: string | null = null;
        if (action === 'sourced') {
            sourceUrl = normaliseSourceUrl(body.sourceUrl ?? '');
            if (!sourceUrl) return json(400, { error: 'A valid http(s) source URL is required to mark a claim as sourced.' });
        }
        // A dismissal needs a stated reason, for the same reason.
        if (action === 'not_applicable' && !note) {
            return json(400, { error: 'Please say briefly why this warning does not apply.' });
        }

        const db = getDb();
        const [post] = await db
            .select({
                id: scheduledPosts.id,
                organisationId: scheduledPosts.organisationId,
                caption: scheduledPosts.caption,
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

        if (!RESOLVABLE.includes(post.status)) {
            return json(409, { error: `A post in '${post.status}' state can no longer have its warnings changed.` });
        }

        if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
            return json(403, { error: 'tier_required', feature: QUALITY_REVIEW_FEATURE });
        }

        const current = readCachedReview(post.qualityReview, post.caption);
        if (!current) {
            return json(409, {
                error: 'This post has no current quality review — its caption changed. Reload to see the latest warnings.',
                code: 'REVIEW_STALE',
            });
        }
        if (!current.complianceWarnings.includes(warning)) {
            return json(409, { error: 'That warning is not on this post any more. Reload to see the latest.', code: 'UNKNOWN_WARNING' });
        }

        const disposition: WarningDisposition | null = action === 'reopen' ? null : {
            action,
            note: note || undefined,
            sourceUrl: sourceUrl || undefined,
            userId,
            at: new Date().toISOString(),
            captionHashAtDisposition: current.captionHash,
        };

        const updated = await recordDisposition(db, {
            postId,
            caption: post.caption,
            crosspostGroupId: post.crosspostGroupId,
            warning,
            disposition,
        });

        if (!updated) return json(409, { error: 'Could not record that — reload and try again.' });

        await db.insert(auditLogs).values({
            userId,
            actionType: action === 'reopen' ? 'COMPLIANCE_WARNING_REOPENED' : 'COMPLIANCE_WARNING_RESOLVED',
            resourceType: 'scheduled_posts',
            resourceId: String(postId),
            // The warning text itself is the record — a resourceId alone would not say what was
            // answered, and the reviewer's wording is what the approver actually saw.
            newState: { warning, action, sourceUrl, note: note || undefined },
        }).catch(() => {});

        const remaining = openWarnings(updated);
        return json(200, {
            ok: true,
            review: updated,
            openWarnings: remaining,
            allResolved: remaining.length === 0,
        });
    } catch (err: any) {
        console.error('[resolve-compliance-warning]', err);
        return json(500, { error: 'Could not update that warning. Please try again.' });
    }
});
