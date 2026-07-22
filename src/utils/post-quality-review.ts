// src/utils/post-quality-review.ts
// US-CAL-5.1: AI Content Quality Review — shared core.
//
// Extracted from netlify/functions/review-post-quality.ts so ONE implementation serves all four
// callers, which previously did not exist or disagreed:
//   • process-content-jobs.ts  — runs the review at DRAFT time, so the Review Queue can show it
//                                (it used to run only when someone opened the calendar panel)
//   • review-post-quality.ts   — the on-demand HTTP endpoint (calendar + review modal)
//   • approve-post.ts          — reads the persisted verdict to ENFORCE the gate server-side
//                                (the "Approval blocked" banner was previously a disabled button
//                                in calendar.js and nothing else — approving from the Review
//                                Queue bypassed it entirely)
//   • apply-post-suggestions.ts — re-reviews after an assisted rewrite
//
// Persistence note: the original wrote the cache with db.execute({ sql, args }), a libsql/Turso
// idiom that drizzle's postgres-js driver rejects — and the throw was swallowed by a bare catch.
// The result: 0 of 50 production posts had a persisted review, SC8's cache branch was dead code,
// and every calendar open paid for a fresh LLM call. persistReview() uses the sql`` template form
// the rest of the codebase uses, and reports failures instead of hiding them.
//
// ── Compliance converges; suggestions diverge ────────────────────────────────────────────────
// The central rule this module now enforces, learned the hard way. Asked for "up to 3 suggestions",
// a model returns 3 for ANY text, forever — there is no caption at which it says "this is fine".
// So the original design (rewrite → re-review → 3 fresh suggestions → rewrite …) was an infinite
// treadmill by construction, and each lap cost three model calls.
//
// Compliance warnings are different in kind: they are claims ABOUT specific assertions in the text
// ("this statistic needs a source"). Fix or substantiate the assertion and the warning genuinely
// goes away. They terminate.
//
// Therefore:
//   • Compliance is re-checked automatically on every caption change — it MUST be, or the gate is
//     enforcing a verdict about text that no longer exists. runQualityReview({ withSuggestions:
//     false }) is the cheap, narrow prompt for this and is the DEFAULT.
//   • Suggestions are generated ONLY when a human explicitly asks, at most MAX_SUGGESTION_ROUNDS
//     times per caption, and are never regenerated as a side effect of anything else.
//
// Getting this backwards is what made the feature user-hostile, so keep the default safe: any new
// caller that forgets to pass withSuggestions gets the terminating behaviour.

import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiBlueprints, scheduledPosts } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';

type Db = ReturnType<typeof getDb>;

/** How many times a human may ask for a fresh set of suggestions on one caption. */
export const MAX_SUGGESTION_ROUNDS = 3;

/** How a human settled one compliance warning. Recorded per warning, never in bulk. */
export interface WarningDisposition {
    /**
     * 'sourced'         — evidence supplied (a citation for the claim)
     * 'not_applicable'  — judged not to apply, with a reason
     */
    action: 'sourced' | 'not_applicable';
    /** Free-text reason, or the note accompanying a source. */
    note?: string;
    /** Citation URL for action='sourced'. */
    sourceUrl?: string;
    userId: number;
    at: string;
    /**
     * The caption hash current when this was recorded. Dispositions carry forward across edits (see
     * carryDispositions) — this preserves what the text actually looked like at the moment the
     * human made the call, which is the part that matters in an audit.
     */
    captionHashAtDisposition: string;
}

export interface QualityReview {
    brandVoiceScore: number;
    /** Regulatory / brand / policy issues. Undisposed ones block approval. */
    complianceWarnings: string[];
    suggestions: string[];
    cachedAt: string;
    /** Hash of the caption the review was computed against — the cache key. */
    captionHash: string;
    /** Per-warning human dispositions, keyed by the exact warning text. */
    dispositions?: Record<string, WarningDisposition>;
    /** Explicit suggestion rounds spent on this caption. Reset when the caption changes. */
    suggestionRounds?: number;
}

/** Stable, cheap caption hash. Kept identical to the original so existing rows stay valid. */
export function hashCaption(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(36);
}

/**
 * The stored review IF it still matches the current caption. Returns null when absent or stale —
 * a caption edit must invalidate the verdict, otherwise a user could clear warnings by editing
 * the text and approve against the old, clean review.
 */
export function readCachedReview(
    qualityReview: unknown,
    caption: string | null,
): QualityReview | null {
    const cached = qualityReview as QualityReview | null;
    if (!cached || typeof cached !== 'object') return null;
    if (cached.captionHash !== hashCaption(caption || '')) return null;
    return cached;
}

/**
 * Warnings the human has NOT yet settled. This — not the raw list — is what gates approval, so a
 * warning answered with a citation stops nagging while the citation stays attached to it.
 */
export function openWarnings(review: QualityReview | null): string[] {
    if (!review || !Array.isArray(review.complianceWarnings)) return [];
    const disposed = review.dispositions || {};
    return review.complianceWarnings.filter(w => !disposed[w]);
}

/** True when the post carries compliance warnings nobody has resolved yet. */
export function hasComplianceWarnings(review: QualityReview | null): boolean {
    return openWarnings(review).length > 0;
}

/**
 * Carry human dispositions across a re-review.
 *
 * Kept by WARNING TEXT, not by caption hash. If the reviewer raises the same warning again, the
 * claim it refers to survived the edit, so the citation or the "not applicable" judgement still
 * answers it — re-asking would train people to click through. Warnings that no longer appear are
 * dropped: they are moot, and keeping them would let a stale disposition silently pre-clear a
 * warning that came back later for a different reason.
 */
function carryDispositions(
    previous: QualityReview | null,
    nextWarnings: string[],
): Record<string, WarningDisposition> | undefined {
    const prior = previous?.dispositions;
    if (!prior) return undefined;
    const carried: Record<string, WarningDisposition> = {};
    for (const w of nextWarnings) if (prior[w]) carried[w] = prior[w];
    return Object.keys(carried).length ? carried : undefined;
}

export interface ReviewablePost {
    id: number;
    assistantId: number | null;
    caption: string | null;
    hashtags: string | null;
    platform: string | null;
}

export interface RunReviewOptions {
    /**
     * Generate a fresh set of style suggestions. DEFAULTS TO FALSE — see the header. Pass true only
     * where a human explicitly asked for them; anywhere else it starts the treadmill again.
     */
    withSuggestions?: boolean;
    /**
     * The review being replaced, so human dispositions and the suggestion-round count survive.
     * Callers that hold the previous review should pass it; persistReview re-reads otherwise.
     */
    previous?: QualityReview | null;
}

/**
 * Run the quality review and persist it. Throws on gateway/parse failure so callers can decide —
 * the draft-time caller treats it as non-fatal (a draft with no review is fine; the gate simply
 * has nothing to block on), the HTTP caller surfaces it.
 *
 * With `withSuggestions: false` (the default) this is the cheap compliance-only pass: a shorter
 * prompt, a smaller response, and — crucially — no new style nits to tempt another rewrite.
 */
export async function runQualityReview(
    db: Db,
    post: ReviewablePost,
    opts: RunReviewOptions = {},
): Promise<QualityReview> {
    const withSuggestions = opts.withSuggestions === true;
    // Brand-voice + content-rule context from the assistant's latest blueprint.
    let brandVoice = 'professional';
    let contentRulesText = '';
    if (post.assistantId) {
        const [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.assistantId, post.assistantId))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);
        if (bp) {
            const sections = bp.sections as Record<string, { content: Record<string, unknown> }>;
            brandVoice = (sections['5-org-context']?.content?.brandVoice as string) ?? brandVoice;
            const rules = sections['4-content-rules']?.content;
            if (rules) contentRulesText = JSON.stringify(rules);
        }
    }

    const caption = post.caption || '';
    const hashtags = post.hashtags || '';
    const platform = post.platform || 'instagram';

    const prompt = `You are a social media quality reviewer. Analyse the following ${platform} post and return a JSON object with these exact fields:
- brandVoiceScore: integer 0-100 measuring how well the post matches the brand voice "${brandVoice}"
- complianceWarnings: array of short string warnings (regulatory, brand, policy issues). Empty array if none.${
    withSuggestions ? '\n- suggestions: array of up to 3 actionable improvement suggestions as strings.' : ''}

Only raise a complianceWarning for something a human must verify or correct before publishing —
an unsubstantiated claim, a pricing or performance statement that may mislead, a missing
disclosure, or a breach of the content rules below. Do NOT raise one for matters of style, tone,
length or hashtag choice.${withSuggestions ? ' Those belong in suggestions.' : ''}

Raise a warning ONLY where there is a specific, nameable problem a person can act on. A caption
with nothing to verify must return an empty array — do not invent a warning to seem thorough.${
    withSuggestions ? '' : `

Do NOT return a suggestions field. Style feedback is not being requested here.`}

Caption:
"""
${caption}
"""
Hashtags: ${hashtags}
${contentRulesText ? `Content rules:\n${contentRulesText}` : ''}

Return ONLY valid JSON, no markdown, no explanation.`;

    const gwResponse = await gatewayGenerate({
        system: 'You are a social media content quality reviewer. Always respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: withSuggestions ? 600 : 400,
    });

    let parsed: { brandVoiceScore?: number; complianceWarnings?: unknown; suggestions?: unknown };
    try {
        parsed = JSON.parse(gwResponse.text);
    } catch {
        throw new Error('Quality review parsing failed.');
    }

    const complianceWarnings = Array.isArray(parsed.complianceWarnings)
        ? parsed.complianceWarnings.map(String).slice(0, 5) : [];

    // The previous verdict, for the human decisions that must outlive it. Re-read when the caller
    // didn't supply it, so a disposition is never lost just because a caller forgot to pass it.
    const previous = opts.previous !== undefined ? opts.previous : await readStoredReview(db, post.id);

    const result: QualityReview = {
        brandVoiceScore: Math.max(0, Math.min(100, Math.round(Number(parsed.brandVoiceScore) || 0))),
        complianceWarnings,
        // Ignore any suggestions the model volunteered when we didn't ask. Persisting them would
        // repopulate the panel behind the user's back and restart the loop.
        suggestions: withSuggestions && Array.isArray(parsed.suggestions)
            ? parsed.suggestions.map(String).slice(0, 3) : [],
        cachedAt: new Date().toISOString(),
        captionHash: hashCaption(caption),
        dispositions: carryDispositions(previous, complianceWarnings),
        // Rounds are per-caption: a genuinely new caption earns a fresh allowance, but merely
        // re-running the compliance check on unchanged text does not.
        suggestionRounds: previous?.captionHash === hashCaption(caption)
            ? (previous?.suggestionRounds ?? 0) + (withSuggestions ? 1 : 0)
            : (withSuggestions ? 1 : 0),
    };

    await persistReview(db, post.id, result);
    return result;
}

/** The raw stored review for a post, regardless of whether it still matches the caption. */
export async function readStoredReview(db: Db, postId: number): Promise<QualityReview | null> {
    try {
        const [row] = await db
            .select({ qualityReview: scheduledPosts.qualityReview })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, postId))
            .limit(1);
        const r = row?.qualityReview as QualityReview | null;
        return r && typeof r === 'object' ? r : null;
    } catch {
        return null;
    }
}

/**
 * Draft-time review for a freshly generated post and its cross-post siblings.
 *
 * Runs ONE LLM call per slot, not per platform: a cross-post's siblings are clones of the primary's
 * caption, so the verdict is identical and is copied onto them. Without this the Review Queue shows
 * a post with no review at all — which is how the "Approval blocked" banner ended up appearing only
 * in the calendar, the one surface that happened to trigger it lazily.
 *
 * Fully best-effort: a review failure must never fail the generation job (the draft is already
 * safely written), and a draft with no review simply has nothing for the gate to block on.
 *
 * ⚠️ Timing: this adds an LLM round-trip to the job. process-content-jobs is chunked to stay under
 * the 26s function cap — if that budget gets tight, this is the first thing to move to a follow-up
 * worker, since nothing downstream blocks on it being ready immediately.
 */
export async function reviewDraftGroup(
    db: Db,
    args: { postId: number; organisationId: number; hasQualityReviewFeature: boolean },
): Promise<QualityReview | null> {
    // Plan-gated: don't spend a model call producing a verdict the org's plan cannot display.
    if (!args.hasQualityReviewFeature) return null;
    try {
        const [post] = await db
            .select({
                id: scheduledPosts.id,
                assistantId: scheduledPosts.assistantId,
                caption: scheduledPosts.caption,
                hashtags: scheduledPosts.hashtags,
                platform: scheduledPosts.platform,
                crosspostGroupId: scheduledPosts.crosspostGroupId,
            })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, args.postId))
            .limit(1);
        if (!post || !post.caption) return null;

        // Draft time is the ONE place suggestions are generated without a human asking, and it is
        // the free round: the post is brand new, nobody has read it yet, and the advice arrives
        // with the draft rather than as a response to the user's own edit. Every later set costs
        // an explicit click.
        const review = await runQualityReview(db, {
            id: post.id,
            assistantId: post.assistantId,
            caption: post.caption,
            hashtags: post.hashtags as string | null,
            platform: post.platform,
        }, { withSuggestions: true, previous: null });

        // Copy onto the siblings — same caption, same verdict. Guarded on the caption still matching
        // so a sibling that diverged (per-platform edit) keeps its own review rather than inheriting.
        if (post.crosspostGroupId) {
            await db
                .update(scheduledPosts)
                .set({ qualityReview: review as unknown as Record<string, unknown> })
                .where(and(
                    eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId),
                    eq(scheduledPosts.caption, post.caption),
                ));
        }
        return review;
    } catch (err) {
        console.warn(`[post-quality-review] draft-time review failed for post ${args.postId}:`,
            err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Record (or clear) one human disposition against one warning, and mirror it onto the cross-post
 * siblings that share the caption — the warning is about the text, and the siblings carry the same
 * text, so answering it once must answer it everywhere. Otherwise approving a 3-platform post
 * means citing the same statistic three times.
 *
 * Returns the updated review, or null if the post has no current review to attach it to.
 */
export async function recordDisposition(
    db: Db,
    args: {
        postId: number;
        caption: string | null;
        crosspostGroupId: string | null;
        warning: string;
        /** null clears the disposition, re-opening the warning. */
        disposition: WarningDisposition | null;
    },
): Promise<QualityReview | null> {
    const review = readCachedReview(await readStoredReview(db, args.postId), args.caption);
    if (!review) return null;
    // Only ever dispose of a warning the reviewer actually raised for this caption. Guards against
    // a stale client posting a warning string from a previous verdict and pre-clearing the gate.
    if (!review.complianceWarnings.includes(args.warning)) return review;

    const dispositions = { ...(review.dispositions || {}) };
    if (args.disposition) dispositions[args.warning] = args.disposition;
    else delete dispositions[args.warning];

    const updated: QualityReview = {
        ...review,
        dispositions: Object.keys(dispositions).length ? dispositions : undefined,
    };

    await persistReview(db, args.postId, updated);
    if (args.crosspostGroupId && args.caption) {
        await db
            .update(scheduledPosts)
            .set({ qualityReview: updated as unknown as Record<string, unknown> })
            .where(and(
                eq(scheduledPosts.crosspostGroupId, args.crosspostGroupId),
                eq(scheduledPosts.caption, args.caption),
            ))
            .catch(() => {});
    }
    return updated;
}

/** Write the review to scheduled_posts.quality_review. Non-fatal, but LOUD when it fails. */
export async function persistReview(db: Db, postId: number, review: QualityReview): Promise<void> {
    try {
        await db
            .update(scheduledPosts)
            .set({ qualityReview: review as unknown as Record<string, unknown> })
            .where(eq(scheduledPosts.id, postId));
    } catch (err) {
        // Previously swallowed silently, which is why the cache never worked. Warn so a driver or
        // schema regression shows up in logs instead of quietly re-billing every read.
        console.warn(`[post-quality-review] persist failed for post ${postId}:`,
            err instanceof Error ? err.message : err);
    }
}
