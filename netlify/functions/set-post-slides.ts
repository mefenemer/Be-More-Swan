// netlify/functions/set-post-slides.ts
// Set the ordered list of media attached to a post — the carousel's slides.
//
// POST { postId, assetIds: [12, 7, 30] } → { ok, slides: [{ assetId, url, kind }] }
//   Auth: aura_session (requireTenant). The post AND every asset must belong to the caller's org.
//
// ── One endpoint, not three ─────────────────────────────────────────────────────────────────────
// Adding a slide, removing one and reordering them are the same operation: "the slides are now this
// list, in this order". Modelling them as three endpoints would mean three chances for the junction
// table and the legacy contentAssetIds array to disagree about what is attached — and they are read
// by different code paths (scheduled_post_assets by newer queries, contentAssetIds by every
// publisher), so a disagreement publishes something the editor never showed.
//
// It replaces attach-draft-media for multi-slide work. attach-draft-media stays for the
// single-swap path it was built for (and for the approve-time overlay bake, which relies on its
// keepOverlays flag).

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolvePostMediaList } from '../../src/utils/social-publish';
import { postFormatSpec } from '../../src/config/post-formats';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Hard ceiling regardless of format — the largest any platform accepts is 20. */
const MAX_SLIDES = 20;

/** Statuses whose media may still be changed. A published post's media is a matter of record. */
const EDITABLE = ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; assetIds?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    if (!Array.isArray(body.assetIds)) return json(400, { error: 'assetIds must be an array.' });
    // De-duped, order preserved: the same picture twice in one carousel is almost always a
    // mis-click, and the platforms treat duplicate children inconsistently.
    const assetIds = [...new Set(body.assetIds.map(Number).filter(Number.isInteger))];
    if (assetIds.length > MAX_SLIDES) return json(422, { error: `A post can carry at most ${MAX_SLIDES} slides.` });

    const [post] = await db
        .select({ id: scheduledPosts.id, status: scheduledPosts.status, formatKey: scheduledPosts.formatKey })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });
    if (!EDITABLE.includes(post.status)) {
        return json(409, { error: 'This post has already gone out, so its media can’t be changed.' });
    }

    // Every asset must be this org's, and must be something a post can actually show. Without this
    // check a caller could attach another tenant's media by id — the publishers run with full
    // credentials and no tenant context, so they would fetch and publish it without question.
    if (assetIds.length) {
        const rows = await db
            .select({ id: contentAssets.id, assetType: contentAssets.assetType })
            .from(contentAssets)
            .where(and(inArray(contentAssets.id, assetIds), eq(contentAssets.organisationId, orgId)));
        const usable = new Set(
            rows.filter(r => ['image', 'video'].includes((r.assetType ?? '').toLowerCase())).map(r => r.id),
        );
        const bad = assetIds.filter(id => !usable.has(id));
        if (bad.length) return json(422, { error: 'One of those items isn’t an image or video on this workspace.' });
    }

    // Rewrite the junction rows to match the requested order exactly, then mirror into the legacy
    // array. Both, always: the publishers read the array and newer queries read the junction, so
    // writing one without the other means the post publishes something different from what it shows.
    await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, postId));
    if (assetIds.length) {
        await db.insert(scheduledPostAssets)
            .values(assetIds.map((contentAssetId, position) => ({ scheduledPostId: postId, contentAssetId, position })))
            .onConflictDoNothing();
    }
    await db.update(scheduledPosts)
        .set({
            contentAssetIds: assetIds,
            // Re-attaching media clears the "this post's media was deleted" flag, same as
            // attach-draft-media does.
            ...(assetIds.length ? { mediaMissing: false, mediaMissingNote: null } : {}),
            updatedAt: new Date(),
        })
        .where(eq(scheduledPosts.id, postId));

    const slides = await resolvePostMediaList(db, assetIds);

    // Report the format's own bounds so the editor can say "a carousel needs at least 2" without
    // duplicating the catalogue. Not enforced here: you are allowed to be mid-build.
    const spec = postFormatSpec(post.formatKey);
    return json(200, {
        ok: true,
        slides: slides.map(s => ({ assetId: s.assetId, url: s.url, kind: s.kind })),
        ...(spec ? { minItems: spec.minItems, maxItems: spec.maxItems } : {}),
    });
});
