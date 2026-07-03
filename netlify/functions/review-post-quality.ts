// netlify/functions/review-post-quality.ts
// US-CAL-5.1: AI Content Quality Review
//
// POST { postId }
// → { brandVoiceScore, complianceWarnings, suggestions, cachedAt }
//
// SC7: requires tierKey 'saver' or 'employee'
// SC8: result cached in scheduled_posts.qualityReview jsonb; re-run only on caption change

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, userOrganisations, scheduledPosts, aiAssistants, aiBlueprints,
} from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';

const JWT_SECRET = process.env.JWT_SECRET;

// Tier keys are 'buster' | 'saver' | 'employee' (see db/schema.ts, seed/data/master_plans.json).
// Quality review is a premium feature — available on Saver and above.
const GATED_TIERS = new Set(['saver', 'employee']);

export const handler: Handler = async (event) => {
    try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    let body: { postId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const { postId } = body;
    if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const db = getDb();

    const [post] = await db
        .select({
            id: scheduledPosts.id,
            organisationId: scheduledPosts.organisationId,
            assistantId: scheduledPosts.assistantId,
            caption: scheduledPosts.caption,
            hashtags: scheduledPosts.hashtags,
            platform: scheduledPosts.platform,
            qualityReview: (scheduledPosts as any).qualityReview,
        })
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, postId))
        .limit(1);

    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Org membership guard
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, post.organisationId!)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // SC7: tier gate — saver/employee only
    const tierKey = await getActiveTierKeyByOrg(db, post.organisationId!);
    if (!tierKey || !GATED_TIERS.has(tierKey)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'tier_required', requiredTier: 'saver' }) };
    }

    // SC8: return cached result if caption unchanged
    const cached = post.qualityReview as Record<string, unknown> | null;
    if (cached && cached.captionHash === _hash(post.caption || '')) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cached, fromCache: true }) };
    }

    // Load blueprint for brand voice context
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

    let parsed: { brandVoiceScore: number; complianceWarnings: string[]; suggestions: string[] };
    try {
        parsed = JSON.parse(gwResponse.text);
    } catch {
        return { statusCode: 502, body: JSON.stringify({ error: 'Quality review parsing failed.' }) };
    }

    const result = {
        brandVoiceScore: Math.max(0, Math.min(100, Math.round(parsed.brandVoiceScore ?? 0))),
        complianceWarnings: Array.isArray(parsed.complianceWarnings) ? parsed.complianceWarnings.slice(0, 5) : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [],
        cachedAt: new Date().toISOString(),
        captionHash: _hash(caption),
    };

    // SC8: persist to DB
    try {
        await db.execute({
            sql: `UPDATE scheduled_posts SET quality_review = $1::jsonb WHERE id = $2`,
            args: [JSON.stringify(result), postId],
        } as any);
    } catch { /* non-fatal — still return result */ }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
    };
    } catch (err: any) {
        console.error('[review-post-quality] Unhandled error:', err);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Quality review failed. Please try again.' }) };
    }
};

function _hash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(36);
}
