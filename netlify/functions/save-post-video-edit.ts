// netlify/functions/save-post-video-edit.ts
// Persist the edit list for a post — the clips, their order, and where each one is cut.
//
// POST { postId, edit, applyToGroup? } → { ok, clips, postIds }
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.
//
// This endpoint only STORES the design. Nothing is re-encoded here: the trim is applied by the
// Remotion render that approve-post queues (trigger-post-render → render-post-video-background),
// which is also what gates publishing until the cut actually exists as a file.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { mediaTargetPostIds } from '../../src/utils/crosspost-media';
import { sanitiseVideoEdit } from '../../src/lib/video-edit';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; edit?: unknown; applyToGroup?: boolean };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const edit = sanitiseVideoEdit(body.edit);
    if (edit === null) return { statusCode: 422, body: JSON.stringify({ error: 'Invalid edit payload.' }) };

    // ── Every clip must be this org's own asset ─────────────────────────────────────────────────
    // The renderer presigns whatever asset id it is given, so an unchecked id here is a read of
    // another tenant's media that ends up published on this tenant's account. The sanitiser cannot
    // do this — it is pure and has no database — so ownership is enforced at the only layer that
    // knows who is asking. Unknown ids are dropped rather than 403'd: the honest reading of a stale
    // id is a deleted asset, and refusing the whole save would strand the rest of the cut.
    if (edit.clips.length) {
        const ids = [...new Set(edit.clips.map(c => c.assetId))];
        const owned = await db
            .select({ id: contentAssets.id })
            .from(contentAssets)
            .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
        const ownedIds = new Set(owned.map(a => a.id));
        edit.clips = edit.clips.filter(c => ownedIds.has(c.assetId));
    }

    // ── The cut is shared; the framing is not ───────────────────────────────────────────────────
    // Cross-posting is one row per platform but ONE post to the reviewer, and nobody should trim the
    // same four clips once per platform. So this DEFAULTS to the whole group — the opposite of
    // save-post-overlays, where a text design legitimately differs per platform and the client
    // states the scope on every call.
    //
    // Per-platform framing still works, and needs no second write: `frames` is keyed BY platform
    // inside the one object, so every sibling can hold the identical edit and read only its own key.
    const targetIds = await mediaTargetPostIds(db, {
        postId,
        orgId,
        applyToGroup: body.applyToGroup !== false,
    });

    // mediaTargetPostIds filters by org, but the requested post itself has not been checked yet —
    // this is what turns a foreign id into a 404 rather than a write.
    const rows = await db
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .where(and(inArray(scheduledPosts.id, targetIds), eq(scheduledPosts.organisationId, orgId)));
    const posts = targetIds.filter(id => rows.some(r => r.id === id));
    if (!posts.includes(postId)) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // An edit with no clips left is stored as null rather than an empty object, so "never edited"
    // and "edited back to nothing" read the same downstream — both mean render the clip whole.
    const value = edit.clips.length ? edit : null;

    await db.update(scheduledPosts)
        .set({ videoEdit: value, updatedAt: new Date() })
        .where(and(inArray(scheduledPosts.id, posts), eq(scheduledPosts.organisationId, orgId)));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        // postIds is every row the edit landed on, so the editor can repaint the sibling tabs — a
        // correct server fan-out still LOOKS broken without it.
        body: JSON.stringify({ ok: true, clips: edit.clips.length, postIds: posts }),
    };
});
