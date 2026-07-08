// netlify/functions/classify-voice-feedback.ts
// US-SMM-2.5.1: Classify a voice-feedback transcript into post-specific changes,
// overarching rules, and ambiguous items using Claude.
//
// POST /.netlify/functions/classify-voice-feedback
//   Auth: aura_session
//   Body: {
//     transcript: string,   // transcribed text from the user's voice recording
//     postId: number,       // the post being reviewed
//     assistantId: number,  // the assistant that drafted the post
//   }
//
// Returns:
//   { items: ClassifiedItem[] }
//   where ClassifiedItem = {
//     text: string,
//     classification: 'post_specific' | 'overarching_rule' | 'ambiguous',
//     platform?: string | null,   // if classification is overarching_rule and user mentioned a platform
//     clarificationQuestion?: string,  // for ambiguous items only
//   }

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, aiAssistants } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default withLambda(async (event) => {
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

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { transcript, postId, assistantId } = body;
    if (!transcript?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'transcript is required.' }) };
    }
    if (!postId || !assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId and assistantId are required.' }) };
    }

    const db = getDb();

    // Verify the post belongs to this user/org
    const [post] = await db.select({ platform: scheduledPosts.platform })
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, Number(postId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    const systemPrompt = `You are an AI assistant helping a social media manager classify feedback they have given about a post draft.

The user has spoken their feedback. Your job is to split the feedback into individual items and classify each one as:
- "post_specific": feedback that only applies to this particular post (e.g. "change the opening line", "make this post shorter")
- "overarching_rule": feedback that should apply to ALL future posts by this assistant (e.g. "never start a post with a question", "always use a casual tone")
- "ambiguous": you cannot confidently determine whether the user means this post only or all future posts

For "overarching_rule" items, also extract the platform if the user mentioned one (instagram, twitter, linkedin, facebook, or null for all platforms).

For "ambiguous" items, write a short clarification question to ask the user.

Respond with ONLY valid JSON in this exact format:
{
  "items": [
    {
      "text": "rewritten feedback item as a clear instruction",
      "classification": "post_specific" | "overarching_rule" | "ambiguous",
      "platform": null | "instagram" | "twitter" | "linkedin" | "facebook",
      "clarificationQuestion": "question string (only for ambiguous items, omit for others)"
    }
  ]
}`;

    const userMessage = `The post being reviewed is on ${post.platform ?? 'social media'}.

User's voice feedback transcript:
"${transcript.trim()}"

Classify each piece of feedback.`;

    let items: any[] = [];
    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });

        const rawText = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            items = Array.isArray(parsed.items) ? parsed.items : [];
        }
    } catch (err) {
        console.error('[classify-voice-feedback] Claude error:', err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Failed to classify feedback.' }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
    };
});
