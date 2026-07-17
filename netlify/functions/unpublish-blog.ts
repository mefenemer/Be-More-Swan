// netlify/functions/unpublish-blog.ts
// Autonomous Content Engine — retract a published post from the org's own site (the inverse of
// publish-blog.ts). Thin wrapper: loads + org-scopes the post, then delegates to unpublishBlogPost
// (src/utils/blog-publish.ts).
//
// Scope is the NATIVE copy only. Syndicated copies stay live — the blog connector adapters have no
// unpublish (see src/utils/blog-destinations/types.ts) — so the response reports which external
// targets are still up under `stillLive` for the UI to surface. Retracting those is a follow-up.
//
// POST { id }  →  { post, stillLive: [{ target, url }] }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { unpublishBlogPost } from '../../src/utils/blog-publish';
import { logAuditEvent } from '../../src/utils/audit';
import { withLambda } from '@netlify/aws-lambda-compat';

// External targets in `destinations` that still hold a live copy after the native retraction.
// 'widget' is the native copy itself, so it's never reported here.
export function stillLiveTargets(destinations: unknown): Array<{ target: string; url?: string }> {
    const map = (destinations as Record<string, unknown>) || {};
    return Object.entries(map)
        .filter(([target, value]) =>
            target !== 'widget'
            && !!value && typeof value === 'object'
            && (value as { status?: unknown }).status === 'published')
        .map(([target, value]) => {
            const url = (value as { url?: unknown }).url;
            return typeof url === 'string' ? { target, url } : { target };
        });
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }
    const id = Number(body.id);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const [post] = await db
        .select()
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
    if (post.status !== 'published') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This post is not published.' }) };
    }

    const stillLive = stillLiveTargets(post.destinations);
    const updated = await unpublishBlogPost(db, post, ctx.organisationId);

    logAuditEvent({
        userId: ctx.userId,
        actionType: 'UPDATE',
        resourceType: 'blog_post',
        resourceId: id,
        previousState: { status: post.status },
        newState: { status: updated.status, unpublishedFrom: 'widget' },
    });

    return { statusCode: 200, body: JSON.stringify({ post: updated, stillLive }) };
});
