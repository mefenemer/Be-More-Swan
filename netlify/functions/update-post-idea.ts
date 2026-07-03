// netlify/functions/update-post-idea.ts
// Review Queue → Ideas tab: lets the user edit an idea's text/platform while it's still 'pending'.
// Once it's been woven into a draft (in_review/delivered/discarded) the idea text is frozen — editing
// it further wouldn't change the resulting draft, which lives independently in scheduled_posts and is
// edited via the normal post-review flow instead.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { postIdeaSuggestions } from '../../db/schema';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { requireTenant } from '../../src/utils/tenant';

const VALID_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'PATCH' && event.httpMethod !== 'DELETE') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: { id?: number; idea?: string; platforms?: string[]; platform?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const id = Number(body.id ?? event.queryStringParameters?.id);
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    if (event.httpMethod === 'DELETE') {
        const [existingIdea] = await db
            .select({ id: postIdeaSuggestions.id, status: postIdeaSuggestions.status })
            .from(postIdeaSuggestions)
            .where(and(eq(postIdeaSuggestions.id, id), eq(postIdeaSuggestions.organisationId, organisationId)))
            .limit(1);
        if (!existingIdea) return { statusCode: 404, body: JSON.stringify({ error: 'Idea not found.' }) };
        if (existingIdea.status !== 'pending') {
            return { statusCode: 409, body: JSON.stringify({ error: 'This idea has already been used and can no longer be deleted.' }) };
        }
        await db.update(postIdeaSuggestions)
            .set({ status: 'discarded' })
            .where(eq(postIdeaSuggestions.id, id));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    const idea = (body.idea || '').trim();
    if (!idea) return { statusCode: 400, body: JSON.stringify({ error: 'Please describe your post idea.' }) };
    if (idea.length > 500) return { statusCode: 400, body: JSON.stringify({ error: 'Your idea must be 500 characters or fewer.' }) };

    const requested = Array.isArray(body.platforms)
        ? body.platforms
        : (body.platform ? [body.platform] : []);
    const selected = [...new Set(requested.filter((p): p is string => VALID_PLATFORMS.includes(p)))];
    const platform = (selected.length === 0 || selected.length === VALID_PLATFORMS.length)
        ? null
        : selected.join(',');

    const [existing] = await db
        .select({ id: postIdeaSuggestions.id, status: postIdeaSuggestions.status })
        .from(postIdeaSuggestions)
        .where(and(eq(postIdeaSuggestions.id, id), eq(postIdeaSuggestions.organisationId, organisationId)))
        .limit(1);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Idea not found.' }) };
    if (existing.status !== 'pending') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This idea has already been used and can no longer be edited.' }) };
    }

    const modBlock = await enforcePromptModeration({ text: idea, userId, organisationId, source: 'update-post-idea' });
    if (modBlock) return modBlock;

    await db.update(postIdeaSuggestions)
        .set({ idea, platform })
        .where(eq(postIdeaSuggestions.id, id));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
    };
};
