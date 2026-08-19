// src/utils/blog-seo-generate.ts
// SEO metadata derivation for a blog post, shared by the interactive endpoint and the autopilot
// worker.
//
// WHY THIS FILE EXISTS
// --------------------
// The logic lived inline in netlify/functions/generate-seo.ts behind `requireTenant`, so it was
// reachable only from a browser session with a cookie — no cron could call it. Every autopilot draft
// therefore landed with empty metaTitle / metaDescription / tags and no slug, and stayed that way
// until a human opened Blog Studio and clicked "Generate SEO". A post that publishes without a
// search title or description is the one thing a Blog Writer exists to avoid.
//
// Same extraction as generate-blog.ts → blog-generate.ts and blog-publish.ts: core here, handler
// delegates. Callers supply the tenant explicitly rather than it being read from a session.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq, ne } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { excerpt } from './markdown-render';
import { currentDatePromptBlock } from './current-date-prompt';
import { parseModelJson } from './model-json';

type Db = ReturnType<typeof getDb>;

const MODEL = 'claude-haiku-4-5-20251001';

export interface BlogSeoResult {
    metaTitle: string;
    metaDescription: string;
    urlSlug: string;
    tags: string[];
}

export function slugify(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'post';
}

/**
 * Derive and persist SEO metadata for one blog post.
 *
 * Throws on a missing post, an unusable model reply, or a database failure — the interactive caller
 * turns that into a 500 the author can retry, and the worker swallows it so a draft is never lost to
 * a metadata problem.
 */
export async function generateBlogSeo(
    db: Db,
    opts: { blogPostId: number; organisationId: number; userId: number },
): Promise<BlogSeoResult> {
    const { blogPostId: id, organisationId, userId } = opts;

    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title, bodyMarkdown: blogPosts.bodyMarkdown, status: blogPosts.status })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) throw new Error('Blog post not found.');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system:
            // metaTitle and urlSlug are where a stale year does lasting damage: the slug is kept
            // stable once published, so "best-crm-2025" is not something a later edit can undo.
            `${currentDatePromptBlock()}\n\n` +
            'You are an SEO assistant. Given a blog post, return ONLY a JSON object with keys: ' +
            'metaTitle (<= 60 chars), metaDescription (<= 155 chars), urlSlug (lowercase, hyphenated, ' +
            'no stop-word padding), tags (array of 3-6 short lowercase strings). No markdown, no extra text.',
        messages: [{
            role: 'user',
            content: `Title: ${post.title}\n\nBody:\n${await excerpt(post.bodyMarkdown, 1500)}`,
        }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    const parsed = parseModelJson<Record<string, any>>(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid SEO response.');

    const metaTitle = String(parsed.metaTitle || post.title).slice(0, 70);
    const metaDescription = String(parsed.metaDescription || '').slice(0, 160);
    const tags = Array.isArray(parsed.tags)
        ? parsed.tags.slice(0, 6).map((t: any) => String(t).toLowerCase().slice(0, 40))
        : [];

    // Slug: use the model's suggestion, sanitised; keep an already-published slug stable, because
    // changing it after publication breaks every link anyone has already shared.
    let urlSlug = post.status === 'published' ? '' : slugify(parsed.urlSlug || metaTitle);
    if (urlSlug) {
        const [clash] = await db
            .select({ id: blogPosts.id })
            .from(blogPosts)
            .where(and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.slug, urlSlug), ne(blogPosts.id, id)))
            .limit(1);
        if (clash) urlSlug = `${urlSlug}-${id}`;
    }

    void logAiUsage({
        userId, workspaceId: organisationId, model: MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const updates: Record<string, unknown> = { metaTitle, metaDescription, tags, updatedAt: new Date() };
    if (urlSlug) updates.slug = urlSlug;
    await db.update(blogPosts).set(updates)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)));

    return { metaTitle, metaDescription, urlSlug, tags };
}
