// netlify/functions/blog-posts.ts
// Autonomous Content Engine — blog draft CRUD (Feature 1). Org-scoped via requireTenant.
//
// GET  /.netlify/functions/blog-posts            → list the org's posts (summary rows)
// GET  /.netlify/functions/blog-posts?id=<n>     → one full post (org-scoped)
// POST /.netlify/functions/blog-posts            → create a draft { title }  → { post }
// DELETE /.netlify/functions/blog-posts?id=<n>   → ARCHIVE a draft (status='archived'; org-scoped;
//                                                  published posts blocked). The verb is kept for the
//                                                  existing callers; the row is never destroyed.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    // ---- Read ----
    if (event.httpMethod === 'GET') {
        const idParam = event.queryStringParameters?.id;
        const fromParam = event.queryStringParameters?.from;
        const toParam = event.queryStringParameters?.to;
        // Scope the list to one authoring assistant (assistant-detail Data Hub / Review Queue tabs).
        const assistantIdParam = event.queryStringParameters?.assistantId;
        const assistantIdFilter = assistantIdParam != null && assistantIdParam !== '' && Number.isFinite(Number(assistantIdParam))
            ? Number(assistantIdParam) : null;

        // Calendar feed (US 4.1 calendar view): scheduled/published posts whose date falls in range.
        if (fromParam && toParam) {
            const fromD = new Date(fromParam);
            const toD = new Date(toParam);
            if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Invalid from/to.' }) };
            }
            const rows = await db
                .select({
                    id: blogPosts.id,
                    title: blogPosts.title,
                    slug: blogPosts.slug,
                    status: blogPosts.status,
                    assistantId: blogPosts.assistantId,
                    publishDate: blogPosts.publishDate,
                    publishedAt: blogPosts.publishedAt,
                })
                .from(blogPosts)
                .where(and(
                    eq(blogPosts.organisationId, ctx.organisationId),
                    inArray(blogPosts.status, ['scheduled', 'published']),
                    or(
                        and(gte(blogPosts.publishDate, fromD), lte(blogPosts.publishDate, toD)),
                        and(gte(blogPosts.publishedAt, fromD), lte(blogPosts.publishedAt, toD)),
                    ),
                ))
                .orderBy(blogPosts.publishDate)
                .limit(500);
            return { statusCode: 200, body: JSON.stringify({ posts: rows }) };
        }

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
                assistantId: blogPosts.assistantId,
                publishDate: blogPosts.publishDate,
                publishedAt: blogPosts.publishedAt,
                updatedAt: blogPosts.updatedAt,
            })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.organisationId, ctx.organisationId),
                ...(assistantIdFilter != null ? [eq(blogPosts.assistantId, assistantIdFilter)] : []),
            ))
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

    // ---- Delete ----
    if (event.httpMethod === 'DELETE') {
        const idParam = event.queryStringParameters?.id;
        const id = Number(idParam);
        if (!idParam || !Number.isFinite(id)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'A valid post id is required.' }) };
        }
        // Org-scope the lookup so one tenant can never delete another's post.
        const [post] = await db
            .select({ id: blogPosts.id, status: blogPosts.status })
            .from(blogPosts)
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
            .limit(1);
        if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
        // A published post is live on the user's site — require unpublishing before deletion.
        if (post.status === 'published') {
            return { statusCode: 409, body: JSON.stringify({ error: 'This post is published. Unpublish it before deleting.' }) };
        }
        // ARCHIVE, not destroy. This used to be `db.delete(...)`, which took the row and cascaded
        // its blog_post_assets / blog_ab_stats away with it — one click, nothing recoverable, from a
        // button sitting next to an Archive tab that implied the opposite.
        //
        // 'archived' is the status set-draft-horizon.ts already writes when a horizon shrinks, so
        // this adds no new state and needs no DDL. Deliberately absent from the gap-fill coverage
        // list in blog-gap-fill.ts — archiving a draft frees its slot, so autopilot redrafts it,
        // which is what a user who discarded something almost always wants.
        await db.update(blogPosts)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)));
        return { statusCode: 200, body: JSON.stringify({ ok: true, id, status: 'archived' }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
