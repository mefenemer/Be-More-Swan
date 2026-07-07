// netlify/functions/generate-hooks.ts
// Autonomous Content Engine — US 5.2 AC1: generate 3 H1/intro hook variants during drafting.
//
// Stores them on blog_posts.hook_variants and flips ab_state → 'testing' so the widget begins
// serving variants and the beacon/resolver loop can pick a winner. Org-scoped, credit-metered.
//
// POST { blogPostId }  →  { hookVariants: [{ id:'A', h1, intro }, ...] }

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { excerpt } from '../../src/utils/markdown-render';

const MODEL = 'claude-haiku-4-5-20251001';

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const id = Number(body.blogPostId);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title, bodyMarkdown: blogPosts.bodyMarkdown })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 700,
            system:
                'You write high-converting blog hooks. Given a post, produce exactly 3 distinct ' +
                'headline (h1) + one-sentence intro pairs that take different angles (e.g. curiosity, ' +
                'benefit, contrarian). Return ONLY a JSON array of 3 objects: ' +
                '[{"h1":"...","intro":"..."}]. No markdown, no extra text.',
            messages: [{
                role: 'user',
                content: `Title: ${post.title}\n\nPost excerpt:\n${excerpt(post.bodyMarkdown, 600)}`,
            }],
        });

        const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        const match = raw.match(/\[[\s\S]*\]/);
        const parsed = match ? JSON.parse(match[0]) : null;
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Invalid hook response.');

        const hookVariants = parsed.slice(0, 3).map((v: any, i: number) => ({
            id: String.fromCharCode(65 + i),           // 'A' | 'B' | 'C'
            h1: String(v.h1 || '').slice(0, 200),
            intro: String(v.intro || '').slice(0, 400),
        }));

        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });

        await db.update(blogPosts)
            .set({ hookVariants, abState: 'testing', updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)));

        return { statusCode: 200, body: JSON.stringify({ hookVariants }) };
    } catch (error) {
        console.error('[generate-hooks] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate hooks. Please try again.' }) };
    }
};
