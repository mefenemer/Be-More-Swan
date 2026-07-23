// netlify/functions/save-post-overlays.ts
// Persist the user-authored text-overlay design for a review-queue post so it survives across
// sessions and can be reopened/re-edited. The overlays are FLATTENED into the image at approval
// time in the browser (see gpBakeOverlaysIfAny in workspace.html); this endpoint only stores the
// editable design + the clean pre-bake base asset, never composites anything itself.
//
// POST { postId, overlays, baseAssetId? } → { ok, count }
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
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
}

function sanitise(raw: unknown): Overlay[] | null {
    if (!Array.isArray(raw)) return null;
    if (raw.length > MAX_OVERLAYS) return null;
    const out: Overlay[] = [];
    for (const o of raw) {
        if (!o || typeof o !== 'object') return null;
        const ov = o as Record<string, unknown>;
        const text = typeof ov.text === 'string' ? ov.text.slice(0, MAX_TEXT_LEN) : '';
        const clamp01 = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));
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

    let body: { postId?: number; overlays?: unknown; baseAssetId?: number | null };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const overlays = sanitise(body.overlays);
    if (overlays === null) return { statusCode: 422, body: JSON.stringify({ error: 'Invalid overlays payload.' }) };

    // Ownership: the post must belong to this org.
    const [post] = await db
        .select({ id: scheduledPosts.id, overlayBaseAssetId: scheduledPosts.overlayBaseAssetId })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Resolve the base asset: the caller may pin the clean pre-bake image the first time overlays are
    // added. Once set it is sticky (a later save without one keeps the original), so re-edits always
    // composite onto the true original rather than an already-flattened image.
    let baseAssetId: number | null = post.overlayBaseAssetId ?? null;
    if (baseAssetId == null && body.baseAssetId != null) {
        const candidate = Number(body.baseAssetId);
        if (Number.isInteger(candidate)) {
            const [asset] = await db
                .select({ id: contentAssets.id })
                .from(contentAssets)
                .where(and(eq(contentAssets.id, candidate), eq(contentAssets.organisationId, orgId)))
                .limit(1);
            if (asset) baseAssetId = asset.id;
        }
    }
    // Clearing all overlays also releases the base pin, so the next overlay session re-pins fresh.
    const nextBase = overlays.length ? baseAssetId : null;

    await db.update(scheduledPosts)
        .set({ imageOverlays: overlays, overlayBaseAssetId: nextBase, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, count: overlays.length }),
    };
});
