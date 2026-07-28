// netlify/functions/toggle-post-disclosure.ts
// Per-post opt-out for the AI disclosure footer (EU AI Act Art. 50).
//
// The footer is appended deterministically to the caption at generation (src/utils/disclosure-footer
// .ts), so its exact text is known and can be removed/restored for a single post here — without
// touching the workspace-wide default.
//
// POST { postId, disabled } → { ok, disabled, caption }
//   disabled=true  → strip the footer from this post's caption
//   disabled=false → re-append it
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { appendFooter, stripFooter } from '../../src/utils/disclosure-footer';
import { resolvePostFooter } from '../../src/utils/post-disclosure';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; disabled?: boolean };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };
    if (typeof body.disabled !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'disabled (boolean) required.' }) };
    const disabled = body.disabled;

    // Ownership + current caption / assistant.
    const [post] = await db
        .select({ id: scheduledPosts.id, caption: scheduledPosts.caption, assistantId: scheduledPosts.assistantId })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Resolve the footer for THIS post exactly as generation did: org setting wins when enabled, else
    // the per-assistant disclosure; {assistant} → this post's assistant name. Shared with the caption
    // write path (scheduled-posts PATCH), which has to put the footer back when an edit replaces the
    // caption wholesale — two copies of this precedence would eventually disagree, and the way that
    // shows up is a post published with no disclosure on it.
    const footer = await resolvePostFooter(db, orgId, post.assistantId);

    const caption = disabled ? stripFooter(post.caption, footer) : appendFooter(post.caption, footer);

    await db.update(scheduledPosts)
        .set({ caption, disclosureFooterDisabled: disabled, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, disabled, caption }),
    };
});
