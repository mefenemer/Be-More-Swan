// netlify/functions/verify-compliance-warning.ts
// Ask the assistant to settle ONE compliance warning: find a real source, or rewrite the claim away.
//
// POST { postId, warning } → one of
//   { outcome: 'sourced',  sourceUrl, note, searchCount }   — a citation the SEARCH TOOL returned
//   { outcome: 'rewrite',  before, after, reason }          — nothing credible found; drop the claim
//   { outcome: 'inconclusive', reason }                     — neither; the human decides
//
// ── The fabrication problem this is built around ──────────────────────────────────────────────
// The obvious version of "let the assistant verify it" is the dangerous one. A model asked to
// verify "the average small business runs 8.2 software subscriptions" with no ability to look
// anything up will produce a confident, plausible, correctly-formatted citation to a study that
// does not exist. In a compliance control that is strictly worse than the dead end it replaces: it
// launders an unverified claim into a filed one, and the audit trail now contains a fake source
// with a real human's name against it.
//
// So verification here is grounded in the actual web_search server tool, and the model's own prose
// is never trusted for the URL:
//
//   1. The URL must appear in `searchedUrls` — the list collected from the search tool's own result
//      blocks (see ai-gateway.ts). A URL the model wrote but did not find is discarded outright.
//   2. If no search ran at all, the result cannot be 'sourced' regardless of what the model says.
//   3. The human still confirms. This proposes a disposition; it never records one. Recording
//      happens through resolve-compliance-warning.ts with the user's own click behind it.
//
// And when verification honestly fails, the answer is not to try harder — it is to stop making the
// claim. That is the 'rewrite' outcome: the caption is amended to remove or soften the unsupported
// assertion, previewed for the human like any other rewrite.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, userOrganisations } from '../../db/schema';
import { gatewayGenerateGrounded } from '../../src/lib/ai-gateway';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import { readCachedReview } from '../../src/utils/post-quality-review';
import { parseModelJson } from '../../src/utils/model-json';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET;
const QUALITY_REVIEW_FEATURE = 'quality_reviewer';
const VERIFIABLE = ['draft', 'pending_approval', 'in_review'];

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/**
 * Resolve a model-proposed URL against the URLs the search tool actually returned. Returns the
 * matching SEARCHED url (never the model's version), or null if it wasn't found.
 *
 * Exported for tests: this is the single check standing between a real citation and a fabricated
 * one, so it needs coverage independent of the endpoint around it.
 */
export function matchesSearchedUrl(candidate: string, searched: string[]): string | null {
    let cand: URL;
    try { cand = new URL(candidate); } catch { return null; }
    if (cand.protocol !== 'http:' && cand.protocol !== 'https:') return null;
    // Exact match first, then same host + same path — enough to tolerate a stripped query string
    // without accepting "some other page on a domain that happened to appear in the results".
    for (const s of searched) {
        if (s === candidate) return s;
        try {
            const u = new URL(s);
            if (u.host === cand.host && u.pathname.replace(/\/$/, '') === cand.pathname.replace(/\/$/, '')) return s;
        } catch { /* skip unparseable */ }
    }
    return null;
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

        let body: { postId?: number; warning?: string };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }

        const { postId, warning } = body;
        if (!postId) return json(400, { error: 'postId required.' });
        if (!warning) return json(400, { error: 'warning required.' });

        const db = getDb();
        const [post] = await db
            .select({
                id: scheduledPosts.id,
                organisationId: scheduledPosts.organisationId,
                caption: scheduledPosts.caption,
                platform: scheduledPosts.platform,
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

        if (!VERIFIABLE.includes(post.status)) {
            return json(409, { error: `A post in '${post.status}' state can no longer be amended.` });
        }
        if (!await hasFeatureByOrg(db, post.organisationId!, QUALITY_REVIEW_FEATURE)) {
            return json(403, { error: 'tier_required', feature: QUALITY_REVIEW_FEATURE });
        }

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

        // Web search is real spend on top of the model call, and this is a user-initiated action.
        const credit = await consumeTaskCredit(db, post.organisationId!);
        if (!credit.allowed) return json(429, { error: credit.limitMessage, code: 'TASK_LIMIT' });

        const caption = post.caption || '';
        const platform = post.platform || 'instagram';

        const prompt = `A compliance reviewer flagged this social post. Establish whether the flagged claim
can be substantiated, using web search.

The warning:
"""
${warning}
"""

The caption:
"""
${caption}
"""

Search for a credible, primary source for the specific factual claim the warning is about.
Prefer original research, official statistics, regulatory guidance, or the company's own published
figures. A blog post restating someone else's number is not a source; find what it cites.

Then return ONLY a JSON object, no markdown:
{
  "outcome": "sourced" | "rewrite" | "inconclusive",
  "sourceUrl": "<the exact URL of the supporting page, from your search results>",
  "note": "<one sentence: what the source says and how it supports the claim>",
  "rewrittenCaption": "<the full caption with the unsupportable claim removed or softened>",
  "reason": "<one sentence explaining the outcome>"
}

Rules:
- "sourced" ONLY if a search result genuinely supports the claim as written. sourceUrl must be a
  URL you actually found in your search results — never one you recall or reconstruct.
- If you cannot find real support, use "rewrite" and supply rewrittenCaption: the same caption with
  the unsupported claim removed, or softened to something defensible ("many small businesses juggle
  a stack of subscriptions" rather than a fabricated statistic). Preserve the author's voice, the
  structure, and everything the warning did not concern. Keep it suitable for ${platform}.
- Use "inconclusive" only when the warning is not about a checkable external fact at all (for
  example a required disclosure, or an internal pricing decision only this business can confirm).
- Never claim you verified something you did not.`;

        // This runs inside a request, and Netlify kills a synchronous function at 26s with a
        // BODYLESS response — the browser then shows its own generic fallback and the user is told
        // nothing about what happened, having already been charged the task credit above. The
        // grounded call is capable of five model calls (primary, failover, three pause_turn
        // resumes), so it gets an explicit budget that leaves room to serialise a reply.
        const gw = await gatewayGenerateGrounded({
            system: 'You are a fact-checker for marketing copy. You search before you answer, you cite only pages you actually found, and you say plainly when something cannot be substantiated. Respond with valid JSON only.',
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 2000,
            deadlineMs: 20_000,
        });

        const parsed = parseModelJson<{
            outcome?: string; sourceUrl?: string; note?: string; rewrittenCaption?: string; reason?: string;
        }>(gw.text);
        if (!parsed) return json(502, { error: 'The assistant could not complete the check. Please try again.' });

        // ── The grounding check ──────────────────────────────────────────────────────────────
        // Everything above is the model's opinion. This is where it gets held to the evidence.
        if (parsed.outcome === 'sourced') {
            const matched = parsed.sourceUrl ? matchesSearchedUrl(parsed.sourceUrl, gw.searchedUrls) : null;
            if (gw.searchCount === 0 || !matched) {
                // It asserted a source it did not find. Downgrade rather than pass it on — and do
                // NOT fall through to its rewrite either, since the same answer is now suspect.
                console.warn(`[verify-compliance-warning] post ${postId}: ungrounded citation discarded`,
                    { searchCount: gw.searchCount, claimed: parsed.sourceUrl });
                return json(200, {
                    outcome: 'inconclusive',
                    reason: 'The assistant could not point to a source it actually found, so nothing has been verified. Add a source yourself, or edit the claim out.',
                    searchCount: gw.searchCount,
                });
            }
            return json(200, {
                outcome: 'sourced',
                sourceUrl: matched,
                note: (parsed.note || '').slice(0, 500),
                searchCount: gw.searchCount,
            });
        }

        if (parsed.outcome === 'rewrite') {
            const after = (parsed.rewrittenCaption || '').trim();
            // A "rewrite" that changes nothing has not removed the claim.
            if (!after || after === caption) {
                return json(200, {
                    outcome: 'inconclusive',
                    reason: parsed.reason || 'The assistant could not substantiate the claim or propose a safe rewrite.',
                    searchCount: gw.searchCount,
                });
            }
            return json(200, {
                outcome: 'rewrite',
                before: caption,
                after,
                reason: (parsed.reason || 'No credible source found for this claim.').slice(0, 500),
                searchCount: gw.searchCount,
            });
        }

        return json(200, {
            outcome: 'inconclusive',
            reason: (parsed.reason || 'This needs a human judgement.').slice(0, 500),
            searchCount: gw.searchCount,
        });
    } catch (err: any) {
        console.error('[verify-compliance-warning]', err);
        // A timeout is not "something went wrong" — it is a specific, recurring outcome (four web
        // searches is simply slow sometimes) and it leaves the user with a warning they still have
        // to clear. Say which it was, and point at the two things that always work.
        const timedOut = err?.name === 'APIConnectionTimeoutError'
            || /timed? ?out/i.test(String(err?.message ?? ''));
        return timedOut
            ? json(504, {
                error: 'The search took too long to come back. Add a source yourself, or edit the claim out of the caption.',
                code: 'VERIFY_TIMEOUT',
            })
            : json(500, { error: 'Could not run the check. Please try again.' });
    }
});
