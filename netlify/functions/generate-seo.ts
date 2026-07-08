// netlify/functions/generate-seo.ts
// Autonomous Content Engine — US 1.3: auto-generate SEO metadata from the final draft.
//
// Analyses title + body and returns structured JSON { metaTitle, metaDescription, urlSlug, tags }.
// Persists it to blog_posts (slug disambiguated to stay unique per org). Org-scoped, credit-metered.
//
// POST { blogPostId }  →  { metaTitle, metaDescription, urlSlug, tags }

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { excerpt } from '../../src/utils/markdown-render';
import { withLambda } from '@netlify/aws-lambda-compat';

const MODEL = 'claude-haiku-4-5-20251001';

function slugify(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'post';
}

export default withLambda(async (event: HandlerEvent) => {
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
        .select({ id: blogPosts.id, title: blogPosts.title, bodyMarkdown: blogPosts.bodyMarkdown, status: blogPosts.status })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 500,
            system:
                'You are an SEO assistant. Given a blog post, return ONLY a JSON object with keys: ' +
                'metaTitle (<= 60 chars), metaDescription (<= 155 chars), urlSlug (lowercase, hyphenated, ' +
                'no stop-word padding), tags (array of 3-6 short lowercase strings). No markdown, no extra text.',
            messages: [{
                role: 'user',
                content: `Title: ${post.title}\n\nBody:\n${excerpt(post.bodyMarkdown, 1500)}`,
            }],
        });

        const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : null;
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid SEO response.');

        const metaTitle = String(parsed.metaTitle || post.title).slice(0, 70);
        const metaDescription = String(parsed.metaDescription || '').slice(0, 160);
        const tags = Array.isArray(parsed.tags)
            ? parsed.tags.slice(0, 6).map((t: any) => String(t).toLowerCase().slice(0, 40))
            : [];

        // Slug: use the model's suggestion, sanitised; keep an already-published slug stable.
        let urlSlug = post.status === 'published' ? '' : slugify(parsed.urlSlug || metaTitle);
        if (urlSlug) {
            const [clash] = await db
                .select({ id: blogPosts.id })
                .from(blogPosts)
                .where(and(eq(blogPosts.organisationId, ctx.organisationId), eq(blogPosts.slug, urlSlug), ne(blogPosts.id, id)))
                .limit(1);
            if (clash) urlSlug = `${urlSlug}-${id}`;
        }

        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });

        const updates: Record<string, unknown> = { metaTitle, metaDescription, tags, updatedAt: new Date() };
        if (urlSlug) updates.slug = urlSlug;
        await db.update(blogPosts).set(updates)
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)));

        return { statusCode: 200, body: JSON.stringify({ metaTitle, metaDescription, urlSlug, tags }) };
    } catch (error) {
        console.error('[generate-seo] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate SEO metadata. Please try again.' }) };
    }
});
