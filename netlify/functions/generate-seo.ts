// netlify/functions/generate-seo.ts
// Autonomous Content Engine — US 1.3: auto-generate SEO metadata from the final draft.
//
// Analyses title + body and returns structured JSON { metaTitle, metaDescription, urlSlug, tags }.
// Persists it to blog_posts (slug disambiguated to stay unique per org). Org-scoped, credit-metered.
//
// POST { blogPostId }  →  { metaTitle, metaDescription, urlSlug, tags }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { generateBlogSeo } from '../../src/utils/blog-seo-generate';
import { withLambda } from '@netlify/aws-lambda-compat';

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
        // Core lives in src/utils/blog-seo-generate.ts so the autopilot worker can call it too —
        // this handler was the ONLY way to reach it, which is why unattended drafts had no metadata.
        const { metaTitle, metaDescription, urlSlug, tags } = await generateBlogSeo(db, {
            blogPostId: id,
            organisationId: ctx.organisationId,
            userId: ctx.userId,
        });

        return { statusCode: 200, body: JSON.stringify({ metaTitle, metaDescription, urlSlug, tags }) };
    } catch (error) {
        console.error('[generate-seo] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate SEO metadata. Please try again.' }) };
    }
});
