// netlify/functions/publish-blog.ts
// Autonomous Content Engine — interactive publish transition (US 3.1 + US 6.1).
//
// Thin wrapper: loads + org-scopes the post, then delegates to publishBlogPost (src/utils/blog-publish.ts),
// the shared core also used by the scheduled publish-blog-posts cron (US 4.1).
//
// POST { id }  →  { post }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { publishBlogPost } from '../../src/utils/blog-publish';
import { summariseSyndication } from '../../src/utils/blog-destinations/syndicate';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

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
    if (!post.bodyMarkdown || !post.bodyMarkdown.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot publish an empty post.' }) };
    }

    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    const updated = await publishBlogPost(db, post, ctx.organisationId, baseUrl);
    // Where it actually went, alongside the fact that it went. Blog Studio reads this to say whether
    // the post reached the connected platforms, failed on one, or went to the org's own site alone —
    // a distinction "Published ✓" could not draw, so a destination that was never connected (and is
    // therefore skipped without an error) was indistinguishable from a clean sweep.
    return { statusCode: 200, body: JSON.stringify({ post: updated, syndication: summariseSyndication(updated.destinations) }) };
});
