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

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { scoreCaption, isAutoPublishEligible } from '../../src/utils/post-confidence';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

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

    // Only a clean green post drafted by the autonomous engine may skip review.
    const routeToReview = !isAutoPublishEligible(result) || !post.isAutonomous;
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
            // null when the model genuinely assessed the caption; 'timeout' | 'parse_error'
            // when the amber above is a fallback rather than a verdict.
            failureMode: result.failureMode,
            routedToReview: routeToReview,
        }),
    };
});
