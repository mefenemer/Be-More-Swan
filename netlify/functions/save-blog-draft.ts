// netlify/functions/save-blog-draft.ts
// Autonomous Content Engine — US 1.2: debounced autosave of a blog draft's editable fields.
// Org-scoped via requireTenant. Only writes fields the caller supplied; never publishes.
//
// POST { id, title?, bodyMarkdown?, tags? }  →  { ok: true, updatedAt }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
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

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.title === 'string') updates.title = body.title.slice(0, 500);
    if (typeof body.bodyMarkdown === 'string') updates.bodyMarkdown = body.bodyMarkdown;
    if (Array.isArray(body.tags)) updates.tags = body.tags.slice(0, 25);

    const [updated] = await db
        .update(blogPosts)
        .set(updates)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .returning({ id: blogPosts.id, updatedAt: blogPosts.updatedAt });

    if (!updated) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true, updatedAt: updated.updatedAt }) };
});
