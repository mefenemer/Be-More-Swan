// src/utils/post-confidence.ts
// Shared confidence-scoring layer for social-post captions (US-GOV-2.2.1).
//
// Extracted from netlify/functions/score-post-confidence.ts so it can be called
// directly (server-to-server, no HTTP/cookie round-trip) by the autonomous
// drafter's per-platform Autopilot gate — see src/utils/publish-policy.ts.
//
// scoreCaption() runs a secondary Haiku LLM call to:
//   1. Rate overall confidence: 'green' | 'amber' | 'red'
//   2. Detect factual claims (statistics, named entities, product specs,
//      pricing, legal/medical/financial statements)
//
// Auto-publish eligibility (isAutoPublishEligible) mirrors the endpoint's rule:
//   green AND zero factual claims → eligible; anything else → needs a human.
// Times out at 5s and defaults to amber (HITL-safe) on timeout/error.

import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from './ai-usage';

const anthropic       = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SCORE_MODEL      = 'claude-haiku-4-5-20251001';
const SCORE_TIMEOUT_MS = 5_000;

export type ConfidenceScore = 'green' | 'amber' | 'red';

export interface FactualClaim {
    claim: string;
    claimType: 'statistic' | 'named_entity' | 'product_spec' | 'pricing' | 'legal_medical_financial' | 'other';
    sourceAvailable: boolean;
}

/**
 * Why a score is untrustworthy, or null when the scorer genuinely ran and returned a verdict.
 * Every non-null value yields a HITL-safe 'amber', but callers must be able to tell "the model
 * looked and was unsure" (failureMode: null) apart from "the model never answered" — otherwise a
 * permanently broken scorer is indistinguishable from a cautious one.
 */
export type ScoreFailureMode = 'timeout' | 'parse_error' | 'empty_caption';

export interface ConfidenceResult {
    confidenceScore: ConfidenceScore;
    factualClaimsCount: number;
    factualClaims: FactualClaim[];
    assessmentDurationMs: number;
    failureMode: ScoreFailureMode | null;
    /** Back-compat alias for `failureMode === 'timeout'`; prefer failureMode. */
    timedOut: boolean;
}

/** True when the verdict reflects a real assessment rather than a fallback. */
export function isScoreTrustworthy(result: Pick<ConfidenceResult, 'failureMode'>): boolean {
    return result.failureMode === null;
}

/**
 * The single auto-publish predicate reused by both the endpoint and the
 * Autopilot gate: only a clean, claim-free green post may skip human review.
 */
export function isAutoPublishEligible(result: Pick<ConfidenceResult, 'confidenceScore' | 'factualClaimsCount'>): boolean {
    return result.confidenceScore === 'green' && result.factualClaimsCount === 0;
}

export async function scoreCaption(caption: string): Promise<ConfidenceResult> {
    const start = Date.now();

    // Empty caption cannot be scored — treat as amber (HITL-safe), no LLM call.
    if (!caption.trim()) {
        return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: 0, failureMode: 'empty_caption', timedOut: false };
    }

    const prompt = `You are a factual accuracy and confidence reviewer for AI-generated social media posts.

Analyse the following post caption and respond with a single JSON object (no markdown fences, no extra text):

{
  "confidenceScore": "green" | "amber" | "red",
  "factualClaims": [
    { "claim": "<exact text of the claim>", "claimType": "statistic" | "named_entity" | "product_spec" | "pricing" | "legal_medical_financial" | "other", "sourceAvailable": true | false }
  ]
}

Rules:
- "green": no factual claims that could mislead if wrong; confident in all statements.
- "amber": contains factual claims that are plausible but unverified, or mildly ambiguous language.
- "red": contains claims that are likely incorrect, highly controversial, or that could cause legal/reputational harm if published without verification.
- sourceAvailable: true only if the claim cites a source or is a well-known, verifiable fact; false otherwise.

Caption to analyse:
"""
${caption}
"""`;

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS);

    try {
        const response = await anthropic.messages.create({
            model: SCORE_MODEL,
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
        }, { signal: controller.signal as any });

        clearTimeout(timeoutId);
        const durationMs = Date.now() - start;
        const content = response.content[0].type === 'text' ? response.content[0].text : '';

        void logAiUsage({
            model: SCORE_MODEL,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            dataCategories: ['business_context'],
        });

        let parsed: { confidenceScore: ConfidenceScore; factualClaims: FactualClaim[] };
        try {
            parsed = JSON.parse(content);
        } catch {
            // The model answered, but not with JSON we can read — that's a scorer failure, not a
            // verdict on the caption. Flag it so callers don't blame the content.
            return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: durationMs, failureMode: 'parse_error', timedOut: false };
        }

        // A valid JSON body with a nonsense confidenceScore is equally unusable.
        const score = parsed.confidenceScore;
        if (score !== 'green' && score !== 'amber' && score !== 'red') {
            return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: durationMs, failureMode: 'parse_error', timedOut: false };
        }

        const claims = Array.isArray(parsed.factualClaims) ? parsed.factualClaims : [];
        return {
            confidenceScore: score,
            factualClaimsCount: claims.length,
            factualClaims: claims,
            assessmentDurationMs: durationMs,
            failureMode: null,
            timedOut: false,
        };
    } catch {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - start;
        // Timeout or network error → amber fallback (HITL-safe)
        return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: durationMs, failureMode: 'timeout', timedOut: true };
    }
}
