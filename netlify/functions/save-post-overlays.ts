// netlify/functions/save-post-overlays.ts
// Persist the user-authored text-overlay design for a review-queue post so it survives across
// sessions and can be reopened/re-edited. The overlays are FLATTENED into the image at approval
// time in the browser (see gpBakeOverlaysIfAny in workspace.html); this endpoint only stores the
// editable design + the clean pre-bake base asset, never composites anything itself.
//
// POST { postId, overlays, baseAssetId? } → { ok, count }
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { mediaTargetPostIds } from '../../src/utils/crosspost-media';
import { withLambda } from '@netlify/aws-lambda-compat';

// Keep server-side validation permissive but bounded — the editor is the source of truth for shape,
// this is just a guard against unbounded / malformed payloads reaching the DB.
const MAX_OVERLAYS = 30;
const MAX_TEXT_LEN = 500;

interface Overlay {
    id?: string;
    text?: string;
    x?: number; y?: number;
    fontFamily?: string;
    fontSizePct?: number;
    color?: string;
    boxStroke?: string | null;
    boxFill?: string | null;
    boxOpacity?: number;
    // Video only: seconds the box appears / disappears. Absent = the whole clip (how an image
    // treats every overlay). The frontend clamps endS to the clip duration; here we only enforce
    // that they are non-negative and that endS is after startS.
    startS?: number;
    endS?: number;
    /** How the box arrives and leaves. Video only; an unknown value degrades to 'none'. */
    anim?: string;
}

// Kept in step with OverlayAnim in src/lib/overlay-geometry.ts. An unrecognised value is not an
// error — it is an older or newer client — so it degrades to the motionless default rather than
// rejecting a save that is otherwise perfectly good.
const ANIMS = new Set(['none', 'fade', 'rise', 'pop']);

function sanitise(raw: unknown): Overlay[] | null {
    if (!Array.isArray(raw)) return null;
    if (raw.length > MAX_OVERLAYS) return null;
    const out: Overlay[] = [];
    for (const o of raw) {
        if (!o || typeof o !== 'object') return null;
        const ov = o as Record<string, unknown>;
        const text = typeof ov.text === 'string' ? ov.text.slice(0, MAX_TEXT_LEN) : '';
        const clamp01 = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));
        // A non-negative finite time, or undefined. endS is dropped when it isn't strictly after
        // startS, so a zero-length or inverted range degrades to "always visible" rather than a box
        // that never shows.
        const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
        const startS = time(ov.startS);
        let endS = time(ov.endS);
        if (startS != null && endS != null && endS <= startS) endS = undefined;
        out.push({
            id: typeof ov.id === 'string' ? ov.id.slice(0, 64) : undefined,
            text,
            x: clamp01(ov.x),
            y: clamp01(ov.y),
            fontFamily: typeof ov.fontFamily === 'string' ? ov.fontFamily.slice(0, 120) : undefined,
            fontSizePct: Math.min(0.5, Math.max(0.005, Number(ov.fontSizePct) || 0.05)),
            color: typeof ov.color === 'string' ? ov.color.slice(0, 32) : undefined,
            boxStroke: typeof ov.boxStroke === 'string' ? ov.boxStroke.slice(0, 32) : null,
            boxFill: typeof ov.boxFill === 'string' ? ov.boxFill.slice(0, 32) : null,
            boxOpacity: Math.min(1, Math.max(0, Number(ov.boxOpacity ?? 1))),
            ...(startS != null ? { startS } : {}),
            ...(endS != null ? { endS } : {}),
            ...(typeof ov.anim === 'string' && ANIMS.has(ov.anim) && ov.anim !== 'none' ? { anim: ov.anim } : {}),
        });
    }
    return out;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; overlays?: unknown; baseAssetId?: number | null; applyToGroup?: boolean };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const overlays = sanitise(body.overlays);
    if (overlays === null) return { statusCode: 422, body: JSON.stringify({ error: 'Invalid overlays payload.' }) };

    // ── Which platforms this design lands on ────────────────────────────────────────────────────
    // A cross-post is one row per platform but ONE post to the reviewer, so "put this text on the
    // picture" normally means all of them — the same rule, and the same helper, as every other media
    // write (src/utils/crosspost-media.ts). applyToGroup:false is how the reviewer says "just this
    // platform", which is what the "Apply to all platforms" tick-box in the Text layer sends.
    //
    // Deliberately NOT defaulted to true here: the client states the scope on every call, and a
    // caller that says nothing gets the old single-post behaviour rather than a silent fan-out.
    const targetIds = await mediaTargetPostIds(db, {
        postId,
        orgId,
        applyToGroup: body.applyToGroup === true,
    });

    // Ownership: the posts must belong to this org. mediaTargetPostIds already filters by org, but
    // the requested post itself has not been checked yet — that is what turns a foreign id into a
    // 404 rather than a write.
    const rows = await db
        .select({
            id: scheduledPosts.id,
            overlayBaseAssetId: scheduledPosts.overlayBaseAssetId,
            // Needed to tell a baked post from an un-baked one when the overlays are cleared.
            contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(inArray(scheduledPosts.id, targetIds), eq(scheduledPosts.organisationId, orgId)));
    // Target first, in the order mediaTargetPostIds gave — the client repaints the tab the reviewer
    // is looking at from the head of postIds.
    const posts = targetIds.map(id => rows.find(r => r.id === id)).filter((r): r is typeof rows[number] => !!r);
    if (!posts.some(p => p.id === postId)) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // The caller may pin the clean pre-bake image the first time overlays are added, and it names
    // the asset THE EDITOR was showing — which is the post the user had open, not its siblings. So
    // it is only ever accepted for that post; every other platform pins its own picture below.
    let offeredBaseAssetId: number | null = null;
    if (body.baseAssetId != null) {
        const candidate = Number(body.baseAssetId);
        if (Number.isInteger(candidate)) {
            const [asset] = await db
                .select({ id: contentAssets.id })
                .from(contentAssets)
                .where(and(eq(contentAssets.id, candidate), eq(contentAssets.organisationId, orgId)))
                .limit(1);
            if (asset) offeredBaseAssetId = asset.id;
        }
    }

    /** The asset a post currently has attached — junction table first, legacy array as fallback. */
    const attachedAssetId = async (p: { id: number; contentAssetIds: unknown }): Promise<number | null> => {
        const [attached] = await db
            .select({ id: scheduledPostAssets.contentAssetId })
            .from(scheduledPostAssets)
            .where(eq(scheduledPostAssets.scheduledPostId, p.id))
            .orderBy(scheduledPostAssets.position)
            .limit(1);
        return attached?.id ?? (p.contentAssetIds as number[] | null)?.[0] ?? null;
    };

    for (const target of posts) {
        // Resolve this post's base asset: its existing pin wins (sticky, so re-edits always composite
        // onto the true original rather than an already-flattened image), then the pin the editor
        // offered for the post it was open on, then whatever this platform currently has attached —
        // which is what lets a sibling with its OWN picture take the design without inheriting the
        // anchor's photo.
        let baseAssetId: number | null = target.overlayBaseAssetId ?? null;
        if (baseAssetId == null) {
            baseAssetId = target.id === postId
                ? (offeredBaseAssetId ?? await attachedAssetId(target))
                : await attachedAssetId(target);
        }
        // Clearing all overlays also releases the base pin, so the next overlay session re-pins fresh.
        const nextBase = overlays.length ? baseAssetId : null;

        // ── Removing the text has to remove it from the PICTURE too ─────────────────────────────
        // Once a design has been baked, the post's attached asset IS the flattened image — the words
        // are pixels in it, not a layer over it. Clearing the overlay list therefore emptied the
        // editable design while leaving the burnt-in copy attached, and the post published the very
        // text the user had just deleted. Nothing downstream caught it: approve-post's bake guard is
        // skipped when there are no overlays, and the base pin — the only record of which asset was
        // the clean original — was being nulled in the same write.
        //
        // So restore the original FIRST, then release the pin. Order matters: once the pin is gone
        // the clean image is unfindable.
        if (!overlays.length && baseAssetId != null) {
            const current = await attachedAssetId(target);
            // Equal means nothing was ever baked — the post still carries its original, so there is
            // nothing to undo and re-attaching would be a pointless write.
            if (current !== baseAssetId) {
                await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, target.id));
                await db.insert(scheduledPostAssets)
                    .values({ scheduledPostId: target.id, contentAssetId: baseAssetId, position: 0 })
                    .onConflictDoNothing();
                // publish-social-posts.ts still reads media from the deprecated array, so a post
                // restored in the junction table alone would publish the flattened image regardless.
                await db.update(scheduledPosts)
                    .set({ contentAssetIds: [baseAssetId], updatedAt: new Date() })
                    .where(eq(scheduledPosts.id, target.id));
            }
        }

        await db.update(scheduledPosts)
            .set({ imageOverlays: overlays, overlayBaseAssetId: nextBase, updatedAt: new Date() })
            .where(eq(scheduledPosts.id, target.id));
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        // postIds is every row this design landed on, so the editor can repaint the sibling tabs
        // and bake each of them — a correct server fan-out still LOOKS broken without it.
        body: JSON.stringify({ ok: true, count: overlays.length, postIds: posts.map(p => p.id) }),
    };
});
