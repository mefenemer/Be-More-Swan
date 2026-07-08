// netlify/functions/score-post-confidence.ts
// US-GOV-2.2.1: Confidence Scoring & Factual Claim Detection Layer
//
// POST /.netlify/functions/score-post-confidence
//   Auth: aura_session  (workspace user — the assistant deployer)
//   Body: { postId: number }
//
// Runs a secondary LLM call against the post caption to:
//   1. Rate overall confidence: 'green' | 'amber' | 'red'
//   2. Identify factual claims (statistics, named entities, product specs, pricing,
//      legal/medical/financial statements)
//
// Routing after scoring:
//   - Amber or Red  → status set to 'in_review' (HITL required)
//   - Green + zero factual claims + isAutonomous=true → status unchanged (can auto-publish)
//   - Green + claims → status set to 'in_review' (reviewer should verify claims)
//
// Times out at 5 seconds; defaults to amber on timeout (HITL-safe fallback).

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { logAiUsage } from '../../src/utils/ai-usage';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET;
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SCORE_MODEL  = 'claude-haiku-4-5-20251001';
const SCORE_TIMEOUT_MS = 5_000;

interface FactualClaim {
    claim: string;
    claimType: 'statistic' | 'named_entity' | 'product_spec' | 'pricing' | 'legal_medical_financial' | 'other';
    sourceAvailable: boolean;
}

interface ConfidenceResult {
    confidenceScore: 'green' | 'amber' | 'red';
    factualClaimsCount: number;
    factualClaims: FactualClaim[];
    assessmentDurationMs: number;
    timedOut: boolean;
}

async function scoreCaption(caption: string): Promise<ConfidenceResult> {
    const start = Date.now();
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

        let parsed: { confidenceScore: 'green' | 'amber' | 'red'; factualClaims: FactualClaim[] };
        try {
            parsed = JSON.parse(content);
        } catch {
            // Malformed JSON → safe fallback
            return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: durationMs, timedOut: false };
        }

        const claims = Array.isArray(parsed.factualClaims) ? parsed.factualClaims : [];
        return {
            confidenceScore: parsed.confidenceScore ?? 'amber',
            factualClaimsCount: claims.length,
            factualClaims: claims,
            assessmentDurationMs: durationMs,
            timedOut: false,
        };
    } catch (err: any) {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - start;
        // Timeout or network error → amber fallback (HITL-safe)
        return { confidenceScore: 'amber', factualClaimsCount: 0, factualClaims: [], assessmentDurationMs: durationMs, timedOut: true };
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { postId } = body;
    if (!postId || typeof postId !== 'number') {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }

    const db = getDb();
    const [post] = await db
        .select()
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, postId))
        .limit(1);

    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    if (post.userId !== userId) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    const caption = post.caption || '';
    if (!caption.trim()) {
        // Empty caption — cannot score; default amber
        await db.update(scheduledPosts)
            .set({
                confidenceScore: 'amber',
                factualClaimsCount: 0,
                factualClaims: [],
                confidenceAssessedAt: new Date(),
                confidenceAssessmentMs: 0,
                status: 'in_review',
                updatedAt: new Date(),
            })
            .where(eq(scheduledPosts.id, postId));
        return { statusCode: 200, body: JSON.stringify({ confidenceScore: 'amber', factualClaimsCount: 0, routedToReview: true }) };
    }

    const result = await scoreCaption(caption);

    // Routing logic per AC:
    // Green + 0 claims + isAutonomous → allow auto-publish (keep current status)
    // All other cases → route to in_review (HITL)
    const routeToReview = result.confidenceScore !== 'green' || result.factualClaimsCount > 0 || !post.isAutonomous;
    const newStatus = routeToReview ? 'in_review' : post.status;

    await db.update(scheduledPosts)
        .set({
            confidenceScore: result.confidenceScore,
            factualClaimsCount: result.factualClaimsCount,
            factualClaims: result.factualClaims as any,
            confidenceAssessedAt: new Date(),
            confidenceAssessmentMs: result.assessmentDurationMs,
            status: newStatus,
            updatedAt: new Date(),
        })
        .where(eq(scheduledPosts.id, postId));

    return {
        statusCode: 200,
        body: JSON.stringify({
            confidenceScore: result.confidenceScore,
            factualClaimsCount: result.factualClaimsCount,
            factualClaims: result.factualClaims,
            assessmentDurationMs: result.assessmentDurationMs,
            timedOut: result.timedOut,
            routedToReview: routeToReview,
        }),
    };
});
