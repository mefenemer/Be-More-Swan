// netlify/functions/blog-posts.ts
// Autonomous Content Engine — blog draft CRUD (Feature 1). Org-scoped via requireTenant.
//
// GET  /.netlify/functions/blog-posts            → list the org's posts (summary rows)
// GET  /.netlify/functions/blog-posts?id=<n>     → one full post (org-scoped)
// POST /.netlify/functions/blog-posts            → create a draft { title }  → { post }

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler = async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    // ---- Read ----
    if (event.httpMethod === 'GET') {
        const idParam = event.queryStringParameters?.id;

        if (idParam) {
            const [post] = await db
                .select()
                .from(blogPosts)
                .where(and(eq(blogPosts.id, Number(idParam)), eq(blogPosts.organisationId, ctx.organisationId)))
                .limit(1);
            if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
            return { statusCode: 200, body: JSON.stringify({ post }) };
        }

        const posts = await db
            .select({
                id: blogPosts.id,
                title: blogPosts.title,
                status: blogPosts.status,
                slug: blogPosts.slug,
                publishDate: blogPosts.publishDate,
                publishedAt: blogPosts.publishedAt,
                updatedAt: blogPosts.updatedAt,
            })
            .from(blogPosts)
            .where(eq(blogPosts.organisationId, ctx.organisationId))
            .orderBy(desc(blogPosts.updatedAt))
            .limit(200);
        return { statusCode: 200, body: JSON.stringify({ posts }) };
    }

    // ---- Create ----
    if (event.httpMethod === 'POST') {
        let body: any;
        try {
            body = JSON.parse(event.body || '{}');
        } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
        }
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled draft';

        // Optional authoring assistant — the post inherits its voice (blog-tone.ts). Validate org ownership.
        let assistantId: number | null = null;
        if (body.assistantId != null && body.assistantId !== '') {
            const parsed = Number(body.assistantId);
            if (!Number.isFinite(parsed)) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid assistantId.' }) };
            const [assistant] = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, parsed), eq(aiAssistants.organisationId, ctx.organisationId)))
                .limit(1);
            if (!assistant) return { statusCode: 400, body: JSON.stringify({ error: 'Assistant not found.' }) };
            assistantId = assistant.id;
        }

        const [post] = await db
            .insert(blogPosts)
            .values({
                organisationId: ctx.organisationId,
                userId: ctx.userId,
                ownerId: ctx.userId,
                assistantId,
                title,
            })
            .returning();
        return { statusCode: 201, body: JSON.stringify({ post }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
