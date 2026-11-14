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
import { and, eq, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { excerpt } from './markdown-render';
import { currentDatePromptBlock } from './current-date-prompt';
import { parseModelJson } from './model-json';
import { adaptForModel, replyText } from '../config/model-options';
import { MAX_KEYWORDS, normalizeKeywords } from './blog-keywords';
import { derivedPillarNames, listPillars } from './content-pillars-store';

type Db = ReturnType<typeof getDb>;

const MODEL = 'claude-haiku-5-5';

/** Categories per post — the same cap as a keyword typed by hand (blog-keywords.ts). */
const MAX_CATEGORIES = MAX_KEYWORDS;

/** The categories this workspace's OTHER posts already use, most-used first. */
// Most RECENTLY used first, not most used, and never from archived or turned-down articles. Ordered
// by count, a blog that changed direction kept being handed its old subject's keywords — they had the
// most articles behind them — and every new article was told to reuse them (2026-11-14).
async function existingCategories(db: Db, organisationId: number, excludeId: number): Promise<string[]> {
    try {
        const r: any = await db.execute(sql`
            SELECT t.tag AS value
              FROM blog_posts p, jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.tags) = 'array' THEN p.tags ELSE '[]'::jsonb END) AS t(tag)
             WHERE p.organisation_id = ${organisationId} AND p.id <> ${excludeId} AND btrim(t.tag) <> ''
               AND p.status NOT IN ('archived', 'rejected')
             GROUP BY t.tag ORDER BY max(coalesce(p.published_at, p.updated_at)) DESC, count(*) DESC, t.tag LIMIT 15`);
        const rows: any[] = Array.isArray(r) ? r : r?.rows || [];
        return rows.map((x) => String(x.value));
    } catch {
        return [];   // a hint, not a requirement — SEO still runs without it
    }
}

// The blog's own Topics & themes (switched on), which say what the blog is about NOW. Null-safe: an
// article with no assistant, or a workspace without topic records, just goes without.
async function currentTopics(db: Db, organisationId: number, assistantId: number | null): Promise<string[]> {
    if (!assistantId) return [];
    try { return derivedPillarNames((await listPillars(db, organisationId, assistantId)) ?? []).slice(0, 12); }
    catch { return []; }
}

/**
 * The keyword instruction. Pure (tests/blog-keywords.test.ts). The keywords must describe THIS
 * article: the blog's current topics are offered first, keywords already in use second, and only as
 * a way to avoid near-duplicates — never as words to reuse because they exist.
 */
export function keywordRule(existing: string[], topics: string[]): string {
    const base = `tags (array of 1-${MAX_CATEGORIES} short, broad lowercase keywords a reader could browse by, describing THIS post — e.g. "marketing", not "five instagram tips for bakers")`;
    const parts = [base];
    if (topics.length) parts.push(`The blog's current topics are ${topics.map((t) => JSON.stringify(t)).join(', ')}; prefer a keyword that names the topic this post belongs to`);
    if (existing.length) parts.push(`keywords already used on recent posts are ${existing.map((t) => JSON.stringify(t)).join(', ')} — reuse one only if it truly describes this post (to avoid near-duplicates like "retirement" vs "retirement tips"), never just because it exists`);
    return parts.join('. ');
}

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
        .select({ id: blogPosts.id, title: blogPosts.title, bodyMarkdown: blogPosts.bodyMarkdown, status: blogPosts.status, assistantId: blogPosts.assistantId })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) throw new Error('Blog post not found.');

    // Tags are the blog's public CATEGORIES (the reader's filter on the widget and hosted page).
    // Each post used to invent 3–6 fresh ones with no idea what the blog already used, so a dozen
    // posts produced forty near-duplicate categories ("marketing", "digital marketing",
    // "marketing tips"). The model now sees the categories in use and reuses them, adding a new
    // one only when nothing fits.
    const existing = await existingCategories(db, organisationId, id);
    const topics = await currentTopics(db, organisationId, post.assistantId);
    const categoryRule = keywordRule(existing, topics);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create(adaptForModel({
        model: MODEL,
        max_tokens: 500,
        system:
            // metaTitle and urlSlug are where a stale year does lasting damage: the slug is kept
            // stable once published, so "best-crm-2025" is not something a later edit can undo.
            `${currentDatePromptBlock()}\n\n` +
            'You are an SEO assistant. Given a blog post, return ONLY a JSON object with keys: ' +
            'metaTitle (<= 60 chars), metaDescription (<= 155 chars), urlSlug (lowercase, hyphenated, ' +
            `no stop-word padding), ${categoryRule}. No markdown, no extra text.`,
        messages: [{
            role: 'user',
            content: `Title: ${post.title}\n\nBody:\n${await excerpt(post.bodyMarkdown, 1500)}`,
        }],
    }, MODEL, 'low') as Anthropic.MessageCreateParamsNonStreaming);

    const raw = replyText(response.content).trim();
    const parsed = parseModelJson<Record<string, any>>(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid SEO response.');

    const metaTitle = String(parsed.metaTitle || post.title).slice(0, 70);
    const metaDescription = String(parsed.metaDescription || '').slice(0, 160);
    const tags = normalizeKeywords(Array.isArray(parsed.tags) ? parsed.tags : []);

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

    await logAiUsage({
        userId, workspaceId: organisationId, model: MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const updates: Record<string, unknown> = { metaTitle, metaDescription, tags, updatedAt: new Date() };
    if (urlSlug) updates.slug = urlSlug;
    await db.update(blogPosts).set(updates)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)));

    return { metaTitle, metaDescription, urlSlug, tags };
}
