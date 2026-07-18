// netlify/functions/publish-blog-destinations.ts
// Authed manual re-push: push an already-published blog post out to every connected external blog
// (US 3.2), honouring each destination's stored publish mode. Idempotent — re-running updates the
// existing external post via the stored externalId instead of duplicating.
//
// Syndication normally runs automatically from publishBlogPost() the moment a post goes live; this
// endpoint exists as a manual "re-push" (e.g. after connecting a new destination, or a transient
// failure). There is no per-post target selection — connecting a destination opts it in.
//
// POST { postId }  → { results: { [target]: {...} } }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAuditEvent } from '../../src/utils/audit';
import { syndicatePublishedPost } from '../../src/utils/blog-destinations/syndicate';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: { postId?: number };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON.' });
    }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'A valid postId is required.' });

    const [post] = await db
        .select()
        .from(blogPosts)
        .where(and(eq(blogPosts.id, postId), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Blog post not found.' });
    if (post.status !== 'published') return json(409, { error: 'Publish the post to your site before syndicating it.' });
    if (!post.bodyMarkdown?.trim()) return json(422, { error: 'This post has no body to publish.' });

    const results = await syndicatePublishedPost(db, ctx.organisationId, post);

    logAuditEvent({
        userId: ctx.userId,
        actionType: 'UPDATE',
        resourceType: 'blog_post_syndication',
        resourceId: postId,
        newState: results,
    });

    return json(200, { results });
});
