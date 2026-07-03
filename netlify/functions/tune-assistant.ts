// tune-assistant.ts
// Epic 3 (Feature 3.1) — Guided Tuning Session submit.
// Translates a user's correction about a specific output into ONE crisp, general directive
// and stores it as a toggleable Runbook rule (content_rules, origin='tuning'). The optional
// "Revise this post now" step is handled separately by reject-post.ts on the client.
//
// POST /.netlify/functions/tune-assistant
//   Auth: aura_session
//   Body: {
//     assistantId: number,   // required
//     correction:  string,   // required — what the user wants different
//     output?:     string,   // the output being corrected (post caption) — grounds the LLM
//     postId?:     number,   // the originating post, if any (links the directive to it)
//     platform?:   string,   // scope the directive to one platform (null = all)
//   }
//   Returns: { rule, directive }

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentRules, aiAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    let orgId: number | undefined;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        orgId = decoded.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }
    if (!orgId) return { statusCode: 401, body: JSON.stringify({ error: 'No active organisation.' }) };

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { assistantId, correction, output, postId, platform } = body;
    if (!assistantId || !correction?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId and correction are required.' }) };
    }

    const db = getDb();

    // Verify the assistant belongs to the caller's org.
    const [assistant] = await db.select({ orgId: aiAssistants.organisationId })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, Number(assistantId)))
        .limit(1);
    if (!assistant || assistant.orgId !== orgId) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    // ── Translate the correction into one crisp, general directive (Feature 3.2 AC1) ──
    // Guard the key + construct the client inside the handler (never at module load) so a
    // missing key can't crash the import (see the Resend construction footgun).
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'AI is not configured.' }) };

    const systemPrompt = `You turn a social media manager's correction about one post into a single, reusable directive for their AI assistant.

Rewrite the correction as ONE crisp, general instruction that will improve ALL future posts by this assistant — not just this one. Keep it under 300 characters, imperative, and specific enough to act on. Do not reference "this post" or the specific example.

Respond with ONLY valid JSON: { "directive": "the instruction" }`;

    const userMessage = `${output?.trim() ? `The output the user is correcting:\n"""${String(output).trim().slice(0, 2000)}"""\n\n` : ''}The user's correction:\n"""${String(correction).trim().slice(0, 1000)}"""\n\nWrite the directive.`;

    let directive = '';
    try {
        const anthropic = new Anthropic({ apiKey });
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });
        const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) directive = String(JSON.parse(jsonMatch[0]).directive || '').trim();
    } catch (err) {
        console.error('[tune-assistant] Claude error:', err);
        // Fall back to the raw correction so a tuning session is never a dead end.
        directive = '';
    }

    // Fallback + hard length cap (content_rules.rule_text is capped at 300 in content-rules.ts).
    if (!directive) directive = String(correction).trim();
    if (directive.length > 300) directive = directive.slice(0, 300);

    const [rule] = await db.insert(contentRules).values({
        assistantId:     Number(assistantId),
        workspaceId:     orgId,
        ruleText:        directive,
        platform:        platform || null,
        note:            String(correction).trim().slice(0, 1000) || null,  // the human "why"
        createdByUserId: userId,
        isActive:        true,
        origin:          'tuning',
        originPostId:    postId ? Number(postId) : null,
    }).returning();

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule, directive }),
    };
};
