// src/utils/compliance-verification.ts
// Ask the assistant to settle ONE compliance warning: find a real source, or rewrite the claim away.
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
//
// ── Why this lives here and not in the endpoint ───────────────────────────────────────────────
// It is run by verify-compliance-warning-background.ts, not by the request the user's click makes.
// Measured, a single verification takes ~124 SECONDS: four web searches, dynamic filtering, and the
// model's own reasoning. A Netlify synchronous function is killed at 26s, and the kill has no body —
// so the endpoint that tried to do this inline could not even report its own failure, and the
// browser fell back to a generic "Could not run the check." with the task credit already spent.
//
// The grounding rules above are the whole point of the feature, so they must not exist in two
// places. Both the worker and any future caller come through here.

import Anthropic from '@anthropic-ai/sdk';
import { gatewayGenerateGrounded } from '../lib/ai-gateway';
import { parseModelJson } from './model-json';

/**
 * Wall-clock budget for one verification. Generous on purpose: a real run measured ~124s, and this
 * runs in a `-background` function (15-minute ceiling), not in a request. It still needs a bound —
 * the gateway can make five model calls, and an unbounded one would hold the worker open.
 *
 * ⚠️ It must be passed. The shared Anthropic client carries a 24s default timeout, so a call made
 * with NO budget is not "unlimited", it is 24 seconds — which this work cannot finish in.
 */
export const VERIFY_DEADLINE_MS = 240_000;

export type VerificationOutcome =
    | { outcome: 'sourced'; sourceUrl: string; note: string; searchCount: number }
    | { outcome: 'rewrite'; before: string; after: string; reason: string; searchCount: number }
    | { outcome: 'inconclusive'; reason: string; searchCount: number };

/**
 * Resolve a model-proposed URL against the URLs the search tool actually returned. Returns the
 * matching SEARCHED url (never the model's version), or null if it wasn't found.
 *
 * Exported for tests: this is the single check standing between a real citation and a fabricated
 * one, so it needs coverage independent of the code around it.
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

function buildPrompt(warning: string, caption: string, platform: string): string {
    return `A compliance reviewer flagged this social post. Establish whether the flagged claim
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
}

/**
 * Run one grounded verification. Throws on gateway failure so the caller can record WHY it failed;
 * every value it returns is a real proposal the human can act on.
 */
export async function runWarningVerification(args: {
    warning: string;
    caption: string;
    platform: string;
    /** Override only for tests; production callers should take the default. */
    deadlineMs?: number;
}): Promise<VerificationOutcome> {
    const { warning, caption, platform } = args;

    const gw = await gatewayGenerateGrounded({
        system: 'You are a fact-checker for marketing copy. You search before you answer, you cite only pages you actually found, and you say plainly when something cannot be substantiated. Respond with valid JSON only.',
        messages: [{ role: 'user', content: buildPrompt(warning, caption, platform) }],
        maxTokens: 2000,
        deadlineMs: args.deadlineMs ?? VERIFY_DEADLINE_MS,
    });

    const parsed = parseModelJson<{
        outcome?: string; sourceUrl?: string; note?: string; rewrittenCaption?: string; reason?: string;
    }>(gw.text);
    if (!parsed) throw new Error('The assistant did not return a readable answer.');

    // ── The grounding check ──────────────────────────────────────────────────────────────
    // Everything above is the model's opinion. This is where it gets held to the evidence.
    if (parsed.outcome === 'sourced') {
        const matched = parsed.sourceUrl ? matchesSearchedUrl(parsed.sourceUrl, gw.searchedUrls) : null;
        if (gw.searchCount === 0 || !matched) {
            // It asserted a source it did not find. Downgrade rather than pass it on — and do
            // NOT fall through to its rewrite either, since the same answer is now suspect.
            console.warn('[compliance-verification] ungrounded citation discarded',
                { searchCount: gw.searchCount, claimed: parsed.sourceUrl });
            return {
                outcome: 'inconclusive',
                reason: 'The assistant could not point to a source it actually found, so nothing has been verified. Add a source yourself, or edit the claim out.',
                searchCount: gw.searchCount,
            };
        }
        return {
            outcome: 'sourced',
            sourceUrl: matched,
            note: (parsed.note || '').slice(0, 500),
            searchCount: gw.searchCount,
        };
    }

    if (parsed.outcome === 'rewrite') {
        const after = (parsed.rewrittenCaption || '').trim();
        // A "rewrite" that changes nothing has not removed the claim.
        if (!after || after === caption) {
            return {
                outcome: 'inconclusive',
                reason: parsed.reason || 'The assistant could not substantiate the claim or propose a safe rewrite.',
                searchCount: gw.searchCount,
            };
        }
        return {
            outcome: 'rewrite',
            before: caption,
            after,
            reason: (parsed.reason || 'No credible source found for this claim.').slice(0, 500),
            searchCount: gw.searchCount,
        };
    }

    return {
        outcome: 'inconclusive',
        reason: (parsed.reason || 'This needs a human judgement.').slice(0, 500),
        searchCount: gw.searchCount,
    };
}

/**
 * A short, honest sentence for the panel when the run failed outright. A timeout is not "something
 * went wrong" — it is a specific, recurring outcome, and it leaves the user with a warning they
 * still have to clear, so it points at the two things that always work.
 */
export function describeVerificationFailure(err: unknown): string {
    const anyErr = err as { message?: string } | null;
    const timedOut = err instanceof Anthropic.APIConnectionTimeoutError
        || /timed? ?out/i.test(String(anyErr?.message ?? ''));
    return timedOut
        ? 'The search took too long to come back. Add a source yourself, or edit the claim out of the caption.'
        : 'The check could not be completed. Add a source yourself, or edit the claim out of the caption.';
}
