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
import { scheduledPosts, organisations, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveDisclosureFooter, appendFooter, stripFooter } from '../../src/utils/disclosure-footer';
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
    // the per-assistant disclosure; {assistant} → this post's assistant name.
    const [org] = await db
        .select({ enabled: organisations.aiDisclosureFooterEnabled, text: organisations.aiDisclosureFooterText })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    let assistantName: string | null = null;
    let perAssistantText: string | null = null;
    if (post.assistantId) {
        const [asst] = await db
            .select({ name: aiAssistants.name, disclosureText: aiAssistants.disclosureText })
            .from(aiAssistants).where(eq(aiAssistants.id, post.assistantId)).limit(1);
        assistantName = asst?.name ?? null;
        perAssistantText = asst?.disclosureText ?? null;
    }
    const footer = resolveDisclosureFooter({
        orgEnabled: org?.enabled ?? false,
        orgText: org?.text ?? null,
        perAssistantText,
        assistantName,
    });

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
