// netlify/functions/schedule-blog.ts
// Autonomous Content Engine — US 4.1: schedule a blog post to auto-publish at a future time,
// or clear an existing schedule. The publish-blog-posts cron publishes due 'scheduled' posts.
// Org-scoped via requireTenant.
//
// POST { id, publishDate }          → status 'scheduled', publish_date set (must be a future time)
// POST { id, action:'unschedule' }  → status back to 'draft', publish_date cleared
//   →  { post: { id, status, publishDate } }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const id = Number(body.id);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const [post] = await db
        .select({ id: blogPosts.id, status: blogPosts.status, bodyMarkdown: blogPosts.bodyMarkdown })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    // Clear an existing schedule → return to draft.
    if (body.action === 'unschedule') {
        const [updated] = await db.update(blogPosts)
            .set({ status: 'draft', publishDate: null, updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
            .returning({ id: blogPosts.id, status: blogPosts.status, publishDate: blogPosts.publishDate });
        return { statusCode: 200, body: JSON.stringify({ post: updated }) };
    }

    // Schedule → validate a non-empty post and a future date.
    if (post.status === 'published') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This post is already published.' }) };
    }
    if (!post.bodyMarkdown || !post.bodyMarkdown.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot schedule an empty post.' }) };
    }
    const when = new Date(body.publishDate);
    if (Number.isNaN(when.getTime())) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid publishDate is required.' }) };
    }
    if (when.getTime() <= Date.now()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'publishDate must be in the future.' }) };
    }

    const [updated] = await db.update(blogPosts)
        .set({ status: 'scheduled', publishDate: when, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .returning({ id: blogPosts.id, status: blogPosts.status, publishDate: blogPosts.publishDate });

    return { statusCode: 200, body: JSON.stringify({ post: updated }) };
};
