// netlify/functions/save-blog-draft.ts
// Autonomous Content Engine — US 1.2: debounced autosave of a blog draft's editable fields.
// Org-scoped via requireTenant. Only writes fields the caller supplied; never publishes.
//
// POST { id, title?, bodyMarkdown?, tags?, metaTitle?, metaDescription?, robots?, distribution? }
//   →  { ok, updatedAt }
//
// `distribution` is the author's per-post choice of which connected external blogs the post
// syndicates to on publish. It is stored under the reserved `selected` key inside the existing
// destinations jsonb (never a destination id, so it cannot collide with a per-target status) —
// deliberately no new column, which would need a manual migration before any read could run.
//
// metaTitle/metaDescription/robots are the crawler-facing SEO fields (US 1.3). generate-seo can
// AUTHOR them, but until now nothing let a human OVERRIDE what the model wrote — this closes that gap.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isBlogDestinationId } from '../../src/utils/blog-destinations';
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

    const ROBOTS = ['index,follow', 'index,nofollow', 'noindex,follow', 'noindex,nofollow'];

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.title === 'string') updates.title = body.title.slice(0, 500);
    if (typeof body.bodyMarkdown === 'string') updates.bodyMarkdown = body.bodyMarkdown;
    if (Array.isArray(body.tags)) updates.tags = body.tags.slice(0, 25);
    // SEO overrides. Clamp to the same limits generate-seo targets (≤60 title, ≤155 description);
    // '' clears an override back to the post's own title/excerpt at render time.
    if (typeof body.metaTitle === 'string') updates.metaTitle = body.metaTitle.slice(0, 120) || null;
    if (typeof body.metaDescription === 'string') updates.metaDescription = body.metaDescription.slice(0, 320) || null;
    // robots is CHECK-constrained in the DB; reject a bad value here so a typo can't 500 the autosave.
    if (typeof body.robots === 'string' && ROBOTS.includes(body.robots)) updates.robots = body.robots;

    // Syndication targets. Merged into the EXISTING destinations blob rather than written over it:
    // that blob also carries every target's publish status (and the widget's), so a plain assign
    // would erase the record of where the post already went.
    if (Array.isArray(body.distribution)) {
        const selected = [...new Set(body.distribution.map(String))].filter(isBlogDestinationId);
        const [current] = await db
            .select({ destinations: blogPosts.destinations })
            .from(blogPosts)
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
            .limit(1);
        if (!current) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
        updates.destinations = { ...((current.destinations as Record<string, unknown>) || {}), selected };
    }

    const [updated] = await db
        .update(blogPosts)
        .set(updates)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .returning({ id: blogPosts.id, updatedAt: blogPosts.updatedAt });

    if (!updated) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true, updatedAt: updated.updatedAt }) };
});
