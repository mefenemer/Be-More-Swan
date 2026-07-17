// netlify/functions/publish-blog-destinations.ts
// Authed: push an already-published blog post out to the selected external connectors (US 3.2).
// Idempotent — re-running updates the existing external post (via the stored externalId) instead of
// duplicating. Per-target outcome is written back into blog_posts.destinations jsonb.
//
// POST { postId, targets: ['devto','hashnode'] }  → { results: { [target]: {...} } }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAuditEvent } from '../../src/utils/audit';
import { getBlogAdapter, isBlogDestinationId } from '../../src/utils/blog-destinations';
import type { BlogDestinationId, BlogDestinationPost } from '../../src/utils/blog-destinations';
import { resolveDestinationCreds } from '../../src/utils/blog-destinations/store';
import { stripMediaForSyndication } from '../../src/utils/blog-publish';
import { renderMarkdown } from '../../src/utils/markdown-render';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

interface TargetResult {
    status: 'published' | 'draft' | 'not_connected' | 'error';
    externalId?: string;
    url?: string;
    error?: string;
    at?: string;
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: { postId?: number; targets?: unknown };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON.' });
    }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'A valid postId is required.' });

    const targets = Array.isArray(body.targets) ? body.targets.filter(isBlogDestinationId) : [];
    if (!targets.length) return json(400, { error: 'No valid targets supplied.' });

    const [post] = await db
        .select()
        .from(blogPosts)
        .where(and(eq(blogPosts.id, postId), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Blog post not found.' });
    if (post.status !== 'published') return json(409, { error: 'Publish the post to your site before syndicating it.' });
    if (!post.bodyMarkdown?.trim()) return json(422, { error: 'This post has no body to publish.' });

    // Syndicated copies are TEXT ONLY (docs/blog-media-composition-plan.md §3.5, decided): no hero,
    // no inline images, no video/audio, columns unwrapped to stacked prose. Our media URLs are
    // presigned/expiring and Pexels is hotlink-only under its ToS, so we hand external platforms no
    // media rather than links that 404 or breach a licence — the same reasoning that already keeps
    // `coverImageUrl` null below.
    //
    // Both fields are derived from ONE stripped source. bodyHtml can't just be nulled: the
    // WordPress / WordPress.com / Ghost adapters send `bodyHtml || bodyMarkdown` into an HTML
    // field, so dropping it would post raw Markdown to those three. And the published_payload
    // snapshot is unusable here by construction — its media is deliberately src-less.
    const syndicatedMarkdown = stripMediaForSyndication(post.bodyMarkdown);
    if (!syndicatedMarkdown.trim()) {
        return json(422, { error: 'This post is media-only. Add some text before syndicating it — external platforms receive text only.' });
    }

    const projected: BlogDestinationPost = {
        title: post.title,
        bodyMarkdown: syndicatedMarkdown,
        bodyHtml: renderMarkdown(syndicatedMarkdown) || null,
        canonicalUrl: post.canonicalUrl ?? null,
        tags: Array.isArray(post.tags) ? (post.tags as unknown[]).map(String) : [],
        // Private-R2 heroes are presigned/expiring, so we never hand an external platform a URL that
        // will 404 later. Cross-posting cover images is a deferred follow-up (Tier-1 note in the plan).
        coverImageUrl: null,
        metaDescription: post.metaDescription ?? null,
    };

    const existing = (post.destinations as Record<string, unknown>) || {};
    const results: Record<string, TargetResult> = {};

    for (const target of targets as BlogDestinationId[]) {
        const adapter = getBlogAdapter(target);
        try {
            const creds = await resolveDestinationCreds(db, ctx.organisationId, target);
            if (!creds) {
                results[target] = { status: 'not_connected' };
                continue;
            }
            const prior = existing[target];
            const priorExternalId =
                prior && typeof prior === 'object' && 'externalId' in prior
                    ? String((prior as { externalId?: unknown }).externalId ?? '') || undefined
                    : undefined;

            const out = await adapter.publish(projected, creds as never, priorExternalId);
            results[target] = { status: out.status, externalId: out.externalId, url: out.url, at: new Date().toISOString() };
        } catch (err) {
            results[target] = { status: 'error', error: err instanceof Error ? err.message : 'Publish failed.' };
        }
    }

    // Merge outcomes back into destinations jsonb (preserves widget status + untouched targets).
    const destinations = { ...existing, ...results };
    await db
        .update(blogPosts)
        .set({ destinations, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, postId), eq(blogPosts.organisationId, ctx.organisationId)));

    logAuditEvent({
        userId: ctx.userId,
        actionType: 'UPDATE',
        resourceType: 'blog_post_syndication',
        resourceId: postId,
        newState: results,
    });

    return json(200, { results });
});
