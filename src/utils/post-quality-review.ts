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

import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiBlueprints, scheduledPosts } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';

type Db = ReturnType<typeof getDb>;

export interface QualityReview {
    brandVoiceScore: number;
    /** Regulatory / brand / policy issues. Non-empty ⇒ approval requires an explicit acknowledgement. */
    complianceWarnings: string[];
    suggestions: string[];
    cachedAt: string;
    /** Hash of the caption the review was computed against — the cache key. */
    captionHash: string;
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

/** True when the post carries unresolved compliance warnings. */
export function hasComplianceWarnings(review: QualityReview | null): boolean {
    return !!review && Array.isArray(review.complianceWarnings) && review.complianceWarnings.length > 0;
}

export interface ReviewablePost {
    id: number;
    assistantId: number | null;
    caption: string | null;
    hashtags: string | null;
    platform: string | null;
}

/**
 * Run the quality review and persist it. Throws on gateway/parse failure so callers can decide —
 * the draft-time caller treats it as non-fatal (a draft with no review is fine; the gate simply
 * has nothing to block on), the HTTP caller surfaces it.
 */
export async function runQualityReview(db: Db, post: ReviewablePost): Promise<QualityReview> {
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
- complianceWarnings: array of short string warnings (regulatory, brand, policy issues). Empty array if none.
- suggestions: array of up to 3 actionable improvement suggestions as strings.

Only raise a complianceWarning for something a human must verify or correct before publishing —
an unsubstantiated claim, a pricing or performance statement that may mislead, a missing
disclosure, or a breach of the content rules below. Do NOT raise one for matters of style, tone,
length or hashtag choice; those belong in suggestions.

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
        maxTokens: 600,
    });

    let parsed: { brandVoiceScore?: number; complianceWarnings?: unknown; suggestions?: unknown };
    try {
        parsed = JSON.parse(gwResponse.text);
    } catch {
        throw new Error('Quality review parsing failed.');
    }

    const result: QualityReview = {
        brandVoiceScore: Math.max(0, Math.min(100, Math.round(Number(parsed.brandVoiceScore) || 0))),
        complianceWarnings: Array.isArray(parsed.complianceWarnings)
            ? parsed.complianceWarnings.map(String).slice(0, 5) : [],
        suggestions: Array.isArray(parsed.suggestions)
            ? parsed.suggestions.map(String).slice(0, 3) : [],
        cachedAt: new Date().toISOString(),
        captionHash: hashCaption(caption),
    };

    await persistReview(db, post.id, result);
    return result;
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

        const review = await runQualityReview(db, {
            id: post.id,
            assistantId: post.assistantId,
            caption: post.caption,
            hashtags: post.hashtags as string | null,
            platform: post.platform,
        });

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
